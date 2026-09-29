'use strict';

// Интеграционная проверка кластера: поднимает ДВА настоящих процесса
// сервера, скормивает их друг другу и смотрит, что получилось.
//
// Проверяем ровно то, что нельзя увидеть в модульных тестах:
//   - серверы находят друг друга и попадают в реестр;
//   - аккаунт, заведённый на одном, входит на другом;
//   - токен, выданный одним, принимается другим;
//   - смена пароля расходится и гасит старые токены на обоих серверах;
//   - партии НЕ реплицируются (сервер авторитетен только для своих);
//   - руки соперников не утекают;
//   - gossip без верной подписи отвергается;
//   - убитый сервер исчезает из реестра, выживший продолжает играть.
//
// Запуск: node tools/test_cluster.js

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const rules = require('../src/engine/rules');

const ROOT = path.join(__dirname, '..');
const SECRET = 'integration-cluster-secret';

// Порты поднимаем выше 20000, чтобы не столкнуться с рабочим 6767.
const PORT_A = 21677;
const PORT_B = 21678;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-cluster-'));
const procs = [];
const open = [];
let passed = 0;
const failures = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Тест с поддержкой await внутри: успех считается только после прогона. */
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (e) {
    failures.push({ name, error: e });
    process.stdout.write(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n== ${title} ==\n`);
}

// ---------------------------------------------------------------- запуск

function startServer(id, name, port, peerPort) {
  const env = {
    ...process.env,
    DG_SERVER_ID: id,
    DG_SERVER_NAME: name,
    DG_REGION: id === 'srv-a' ? 'ru' : 'lv',
    DG_PUBLIC_HOST: '127.0.0.1',
    DG_PUBLIC_PORT: String(port),
    DG_LISTEN_HOST: '127.0.0.1',
    DG_LISTEN_PORT: String(port),
    DG_DATA_DIR: path.join(TMP, id),
    DG_DB_FILE: path.join(TMP, id, 'test.sqlite3'),
    DG_CLUSTER_SECRET: SECRET,
    DG_PEER_URLS: `http://127.0.0.1:${peerPort}`,
    // Ускоряем репликацию, чтобы тест не ждал минуту.
    DG_GOSSIP_INTERVAL_MS: '500',
    DG_SERVER_TTL_MS: '2500',
    DG_LOG_LEVEL: 'error',
  };
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => {
    const s = d.toString();
    if (process.env.DG_VERBOSE) process.stderr.write(`[${id}] ${s}`);
    else if (/Error|error/.test(s)) process.stderr.write(`[${id}] ${s}`);
  });
  procs.push(p);
  return p;
}

// ---------------------------------------------------------------- HTTP

function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve({ code: res.statusCode, body: JSON.parse(body) }); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function postGossip(port, body, signMode) {
  const raw = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    // Заголовки HTTP — latin1, поэтому подпись-подделку тоже latin1.
    if (signMode === 'good') {
      headers['x-dg-sign'] = crypto.createHmac('sha256', SECRET).update(raw).digest('base64url');
    } else if (signMode === 'bad') {
      headers['x-dg-sign'] = Buffer.from('forged-signature', 'utf8').toString('latin1');
    } // 'none' — заголовка не будет вовсе
    const req = http.request(
      { host: '127.0.0.1', port, path: '/cluster/gossip', method: 'POST', headers },
      (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => {
          try { resolve({ code: res.statusCode, body: JSON.parse(out) }); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
    req.end(raw);
  });
}

async function waitHealthy(port, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await httpGet(port, '/health');
      if (r.code === 200 && r.body.ok) return r.body;
    } catch (_) { /* ещё не поднялся */ }
    await sleep(200);
  }
  throw new Error(`сервер на ${port} не поднялся`);
}

/** Повторяет проверку, пока она не станет истинной (репликация не мгновенна). */
async function until(fn, ms = 15000, step = 250) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await fn(); // eslint-disable-line no-await-in-loop
    if (last) return last;
    await sleep(step); // eslint-disable-line no-await-in-loop
  }
  return last;
}

// ---------------------------------------------------------------- клиент

/**
 * Тонкий клиент. Два важных обстоятельства:
 *
 *  1) Ответ ищем по типу И по rid. Игрок, сидящий в комнате, получает
 *     push-рассылки (room.state, game.state) без rid — и не должен принять
 *     чужой ход за результат своего.
 *  2) Слушатель вешаем ДО ожидания open: сервер шлёт hello сразу же, и await
 *     между open и on('message') — это окно, в котором сообщение потерялось бы.
 */
class Client {
  constructor(port, label) {
    this.port = port;
    this.label = label || `c${port}`;
    this.ws = null;
    this.queue = [];
    this.waiters = [];
    this.hello = null;
    this.seq = 0;
  }

  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.t === 'hello') this.hello = msg;
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i !== -1) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.queue.push(msg);
    });
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    open.push(this);
    return this;
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  next(match, ms = 6000) {
    const i = this.queue.findIndex(match);
    if (i !== -1) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const k = this.waiters.indexOf(w);
        if (k !== -1) {
          this.waiters.splice(k, 1);
          const got = this.queue.map((m) => m.t).join(',') || 'пусто';
          reject(new Error(`[${this.label}] не дождались ответа (в очереди: ${got})`));
        }
      }, ms);
    });
  }

  /** Ждёт hello. Он приходит сразу, но не синхронно с open. */
  async waitHello() {
    if (this.hello) return this.hello;
    return this.next((m) => m.t === 'hello', 4000);
  }

  /**
   * Отправляет команду и ждёт ИМЕННО ЕЁ ответа — по rid.
   * types — список допустимых типов ответа (в дополнение к rid).
   */
  async rpc(obj, types) {
    this.seq += 1;
    // Префикс с именем сокета: два клиента считают rid с единицы, и без
    // префикса они бы подменяли ответы друг друга.
    const rid = `${this.label}#${this.seq}`;
    this.send({ ...obj, rid });
    const hit = types
      ? (m) => m.rid === rid && (Array.isArray(types) ? types : [types]).includes(m.t)
      : (m) => m.rid === rid;
    return this.next(hit);
  }

  close() { if (this.ws) try { this.ws.close(); } catch (_) { /* уже закрыт */ } }
}

async function signedIn(port, login, password, nick, label) {
  const c = await new Client(port, label).connect();
  const r = await c.rpc({ t: 'auth.register', login, password, nick }, 'auth.ok');
  c.token = r.token;
  c.login = login;
  c.password = password;
  return c;
}

/** Один разовый вход: подключиться, войти, закрыть. */
async function loginOnce(port, login, password, label) {
  const c = await new Client(port, label).connect();
  const r = await c.rpc({ t: 'auth.login', login, password }, ['auth.ok', 'auth.err']);
  c.close();
  open.pop();
  return r;
}

function gossipBody(id, port) {
  return {
    from: {
      server_id: id,
      name: id,
      region: 'test',
      host: '127.0.0.1',
      port,
      version: '1',
    },
    since: 0,
  };
}

// --------------------------------------------------------- сборка хода

/**
 * Ищет в руке набор, который заведомо валиден по правилам: серию одного
 * цвета из трёх подряд либо набор из трёх-четырёх разных цветов одного
 * значения. Ровно то, что сделал бы настоящий игрок.
 *
 * Фишек каждого вида в колоде две, поэтому искать надо по ОБЕИМ копиям:
 * в руке может лежать вторая, а не первая.
 *
 * Возвращает {ids, kind} либо null. kind нужен потому, что «переставить
 * ряд» для набора и для серии — разные жесты: набор можно развернуть
 * как угодно, а серия — кольцо, и её можно лишь сдвинуть (10,11,12 →
 * 11,12,10), но не перевернуть. Развернутая серия с джокером вообще
 * может не иметь годного порядка: {10,11,джокер} даёт только 10,11,12.
 */
function planRowFromView(state, catalog) {
  const copies = new Map();
  for (const t of catalog) {
    if (t.is_joker) continue;
    const key = `${t.color}:${t.value}`;
    if (!copies.has(key)) copies.set(key, []);
    copies.get(key).push(t.id);
  }
  const hand = new Set(state.hand);
  const pick = (color, value) => (copies.get(`${color}:${value}`) || []).find((id) => hand.has(id));

  for (let color = 0; color < 4; color += 1) {
    for (let start = 1; start <= 11; start += 1) {
      const ids = [];
      for (let v = start; v < start + 3; v += 1) {
        const id = pick(color, v);
        if (id === undefined) break;
        ids.push(id);
      }
      if (ids.length === 3) return { ids, kind: 'run' };
    }
  }
  for (let value = 1; value <= 13; value += 1) {
    const ids = [];
    for (let color = 0; color < 4; color += 1) {
      const id = pick(color, value);
      if (id !== undefined) ids.push(id);
    }
    if (ids.length >= 3) return { ids: ids.slice(0, 4), kind: 'set' };
  }
  return null;
}

// ---------------------------------------------------------------- сценарий

(async function main() {
  section('Поднимаем два сервера');
  startServer('srv-a', 'Сервер А', PORT_A, PORT_B);
  startServer('srv-b', 'Сервер Б', PORT_B, PORT_A);

  const healthA = await waitHealthy(PORT_A);
  const healthB = await waitHealthy(PORT_B);
  process.stdout.write(`  srv-a :${PORT_A}   srv-b :${PORT_B}\n`);

  // ------------------------------------------------------- реестр серверов
  section('Здоровье и реестр');

  await test('/health отвечает и называет себя', () => {
    assert.strictEqual(healthA.id, 'srv-a');
    assert.strictEqual(healthA.region, 'ru');
    assert.strictEqual(healthA.port, PORT_A);
    assert.strictEqual(healthB.id, 'srv-b');
    assert.strictEqual(healthB.region, 'lv');
  });

  const bothKnown = await until(async () => {
    const a = await httpGet(PORT_A, '/cluster/servers');
    const b = await httpGet(PORT_B, '/cluster/servers');
    const okA = a.body.servers.some((s) => s.id === 'srv-b');
    const okB = b.body.servers.some((s) => s.id === 'srv-a');
    return okA && okB ? { a: a.body.servers, b: b.body.servers } : null;
  });

  await test('серверы находят друг друга в реестре', () => {
    assert.ok(bothKnown, 'серверы не увидели друг друга за 15 секунд');
    const peerOnA = bothKnown.a.find((s) => s.id === 'srv-b');
    assert.strictEqual(peerOnA.host, '127.0.0.1');
    assert.strictEqual(peerOnA.port, PORT_B);
    assert.strictEqual(peerOnA.region, 'lv');
  });

  await test('в реестре видно, какой сервер — «это я»', () => {
    const meA = bothKnown.a.find((s) => s.id === 'srv-a');
    assert.ok(meA && meA.self === true);
  });

  await test('наружу из реестра не уходят внутренние метки', () => {
    for (const s of bothKnown.a) {
      assert.ok(!('first_seen_ms' in s), 'first_seen_ms — внутреннее поле');
      assert.ok(!('last_seen_ms' in s), 'last_seen_ms — внутреннее поле');
    }
  });

  // ---------------------------------------------------------------- вход
  section('Аккаунты');

  const alice = await signedIn(PORT_A, 'alice', 'secret123', 'Алиса', 'alice@A');
  const herHello = await alice.waitHello();

  await test('hello приходит сразу и содержит каталог из 108 фишек', () => {
    assert.ok(herHello, 'hello не пришёл');
    assert.strictEqual(herHello.catalog.length, 108);
    assert.strictEqual(herHello.server.id, 'srv-a');
    assert.ok(herHello.graceMs > 0, 'клиенту нужно знать срок ожидания переподключения');
  });

  const bob = await new Client(PORT_B, 'anon@B').connect();
  const bobHello = await bob.waitHello();

  await test('каталог фишек на обоих серверах совпадает до id', () => {
    assert.deepStrictEqual(
      bobHello.catalog.map((t) => t.id),
      herHello.catalog.map((t) => t.id),
      'порядок id обязан совпадать, иначе один и тот же ход трактуется по-разному',
    );
  });

  await test('в hello сервер называет себя и для второго сервера', () => {
    assert.strictEqual(bobHello.server.id, 'srv-b');
    assert.strictEqual(bobHello.server.port, PORT_B);
  });

  const replicated = await until(async () => {
    const r = await loginOnce(PORT_B, 'alice', 'secret123', 'probe');
    return r.t === 'auth.ok' ? r : null;
  });

  await test('аккаунт доехал до второго сервера: вход с тем же паролем проходит', () => {
    assert.ok(replicated, 'аккаунт не реплицировался за 15 секунд');
  });

  await test('токен, выданный первым сервером, принимает второй', async () => {
    const r = await bob.rpc({ t: 'auth.resume', token: alice.token }, ['auth.ok', 'auth.err']);
    assert.strictEqual(r.t, 'auth.ok', JSON.stringify(r));
    assert.strictEqual(r.user.login, 'alice', 'сервер отдаёт публичное представление аккаунта');
  });

  await test('в auth.ok наружу не уходит хеш пароля', async () => {
    const r = await bob.rpc({ t: 'auth.resume', token: alice.token }, ['auth.ok', 'auth.err']);
    const blob = JSON.stringify(r.user);
    assert.ok(!blob.includes('pwd_hash'), blob);
    assert.ok(!blob.includes('origin'), blob);
  });

  await test('регистр логина нечувствителен: ALICE уже занят', async () => {
    const r = await bob.rpc({ t: 'auth.register', login: 'ALICE', password: 'other999', nick: 'Взлом' }, ['auth.ok', 'auth.err']);
    assert.strictEqual(r.t, 'auth.err', JSON.stringify(r));
  });

  await test('чужой пароль не подходит нигде', async () => {
    const r = await bob.rpc({ t: 'auth.login', login: 'alice', password: 'other999' }, ['auth.ok', 'auth.err']);
    assert.strictEqual(r.t, 'auth.err', JSON.stringify(r));
  });

  await test('настоящий пароль работает на втором сервере', async () => {
    const r = await bob.rpc({ t: 'auth.login', login: 'alice', password: 'secret123' }, ['auth.ok', 'auth.err']);
    assert.strictEqual(r.t, 'auth.ok', JSON.stringify(r));
  });

  await test('смена пароля на втором сервере проходит', async () => {
    const r = await bob.rpc({ t: 'auth.password', old: 'secret123', new: 'newsecret1' }, ['auth.ok', 'auth.err']);
    assert.strictEqual(r.t, 'auth.ok', JSON.stringify(r));
  });

  await test('старый пароль сразу перестаёт работать на втором сервере', async () => {
    const r = await bob.rpc({ t: 'auth.login', login: 'alice', password: 'secret123' }, ['auth.ok', 'auth.err']);
    assert.strictEqual(r.t, 'auth.err', JSON.stringify(r));
  });

  const spread = await until(async () => {
    const r = await loginOnce(PORT_A, 'alice', 'newsecret1', 'probe');
    return r.t === 'auth.ok' ? r : null;
  });

  await test('новый пароль доехал до первого сервера', () => {
    assert.ok(spread, 'смена пароля не разошлась за 15 секунд');
  });

  await test('старый пароль не воскрес на первом сервере', async () => {
    const r = await loginOnce(PORT_A, 'alice', 'secret123', 'probe');
    assert.strictEqual(r.t, 'auth.err', JSON.stringify(r));
  });

  await test('токен, выданный до смены пароля, умирает и на чужом сервере', async () => {
    // Локальную сессию никто не удалил: пароль меняли на PORT_B. Убить токен
    // должна проверка updated_ms, дошедшая с репликой аккаунта.
    const dead = await until(async () => {
      const c = await new Client(PORT_A, 'probe').connect();
      const res = await c.rpc({ t: 'auth.resume', token: alice.token }, ['auth.ok', 'auth.err']);
      return res.t === 'auth.err' ? res : null;
    });
    assert.ok(dead, 'токен, переживший смену пароля на соседе, всё ещё работает');
  });

  // ------------------------------------------------- партии не реплицируются
  section('Партии не реплицируются');

  const carol = await signedIn(PORT_A, 'carol', 'secret123', 'Кэрол', 'carol@A');
  const dave = await signedIn(PORT_B, 'dave', 'secret123', 'Дэйв', 'dave@B');

  let foreignRoomCode = null;
  await test('комната создаётся на своём сервере', async () => {
    const r = await carol.rpc({ t: 'room.create', seats: 2, require30: false, name: 'Изолированная' }, 'room.state');
    assert.ok(r.room && typeof r.room.code === 'string');
    assert.strictEqual(r.room.seats, 2);
    assert.strictEqual(r.room.players[0].nick, 'Кэрол');
    assert.strictEqual(r.room.players[1].empty, true, 'пустое место честно помечено');
    assert.strictEqual(r.room.you, 0);
    assert.strictEqual(r.room.isHost, true);
    foreignRoomCode = r.room.code;
  });

  await test('в списке комнат пароля нет, только признак его наличия', async () => {
    const r = await carol.rpc({ t: 'rooms.list' }, 'rooms.list');
    const mine = r.rooms.find((x) => x.code === foreignRoomCode);
    assert.ok(mine, 'своя комната должна быть в списке');
    assert.strictEqual(typeof mine.hasPassword, 'boolean');
    assert.ok(!('password' in mine) && !('passwordHash' in mine));
  });

  await test('комната первого сервера НЕ видна на втором', async () => {
    const r = await dave.rpc({ t: 'rooms.list' }, 'rooms.list');
    const codes = r.rooms.map((x) => x.code);
    assert.ok(!codes.includes(foreignRoomCode), `комната ${foreignRoomCode} протекла на другой сервер`);
  });

  // --- наблюдатель: чтение чужого списка не должно стоить комнаты ------
  // Клиент читает список комнат с КАЖДОГО сервера отдельной короткой
  // связью: у него одно основное соединение на свой сервер. Раньше эта
  // связь входила обычным auth.resume, а обычный вход перехватывает сокет
  // игрока. При закрытии короткой связи сервер выбивал игрока из комнаты,
  // а комнату с одним игроком — удалял. Игрок терял комнату из-за того,
  // что посмотрел список комнат.

  await test('наблюдатель читает список комнат чужого сервера', async () => {
    const obs = await new Client(PORT_B, 'obs').connect();
    open.pop();
    const r = await obs.rpc({ t: 'lobby.open', token: carol.token }, ['auth.ok', 'auth.err']);
    assert.strictEqual(r.t, 'auth.ok', `lobby.open отказал: ${JSON.stringify(r)}`);
    const l = await obs.rpc({ t: 'rooms.list' }, 'rooms.list');
    assert.ok(Array.isArray(l.rooms), 'список комнат пришёл');
    obs.close();
  });

  await test('наблюдатель не может ничего менять', async () => {
    const obs = await new Client(PORT_B, 'obs2').connect();
    open.pop();
    await obs.rpc({ t: 'lobby.open', token: carol.token }, ['auth.ok', 'auth.err']);
    for (const [cmd, payload] of [
      ['room.create', { seats: 2, require30: false, name: 'Взлом' }],
      ['room.join', { code: foreignRoomCode }],
      ['room.leave', {}],
      ['room.start', {}],
      ['quick.join', { seats: 2, require30: false }],
      ['game.draw', {}],
      ['auth.logout', {}],
    ]) {
      const r = await obs.rpc({ t: cmd, ...payload }, ['room.state', 'room.left', 'quick.state', 'game.state', 'game.error', 'auth.err']);
      assert.strictEqual(r.t, 'game.error', `наблюдатель смог ${cmd}: ${JSON.stringify(r)}`);
      assert.match(r.reason, /только для чтения/);
    }
    obs.close();
  });

  await test('чтение списка наблюдателем НЕ выбивает игрока из комнаты', async () => {
    // Связь открывается и закрывается — как это делает клиент, собирая
    // общий список. После этого комната обязана остаться на месте.
    for (let i = 0; i < 3; i += 1) {
      const obs = await new Client(PORT_B, `obs3-${i}`).connect();
      open.pop();
      await obs.rpc({ t: 'lobby.open', token: carol.token }, ['auth.ok', 'auth.err']);
      await obs.rpc({ t: 'rooms.list' }, 'rooms.list');
      obs.close();
    }
    await sleep(400);
    // Комната жива, и игрок на своём месте.
    const r = await carol.rpc({ t: 'rooms.list' }, 'rooms.list');
    assert.ok(r.rooms.some((x) => x.code === foreignRoomCode),
      `комната ${foreignRoomCode} пропала после чтения списка наблюдателем`);
    // И это не просто остаток в списке: игрок всё ещё в комнате.
    const st = await carol.rpc({ t: 'room.join', code: foreignRoomCode }, ['room.state', 'game.error']);
    assert.strictEqual(st.t, 'room.state', 'игрок выбит из комнаты наблюдателем');
  });

  await test('вход не вытесняет игрока из лобби и не возвращает его сам', async () => {
    // Вход в аккаунт больше НЕ перехватывает сокет и не тащит игрока в
    // комнату: он лишь называет в auth.ok.room комнату, в которой игрок
    // числится. Возврат — явный шаг игрока (room.join / game.rejoin), и
    // именно возврат перепривязывает место и вытесняет старый сокет.
    const back = await new Client(PORT_A, 'carol-back').connect();
    const r = await back.rpc({ t: 'auth.login', login: 'carol', password: 'secret123' },
      ['auth.ok', 'auth.err']);
    assert.strictEqual(r.t, 'auth.ok', 'вход после обрыва не прошёл');
    assert.ok(r.room && r.room.code === foreignRoomCode,
      `auth.ok не сообщил о комнате игрока: ${JSON.stringify(r)}`);
    // Прежний сокет жив и владеет местом: вход его не вытеснил.
    const st = await back.rpc({ t: 'rooms.list' }, 'rooms.list');
    assert.ok(st.rooms.some((x) => x.code === foreignRoomCode),
      `комната ${foreignRoomCode} пропала при входе`);
    // Явный возврат привязывает место к новому сокету и вытесняет старый.
    const joined = await back.rpc({ t: 'room.join', code: foreignRoomCode },
      ['room.state', 'game.error']);
    assert.strictEqual(joined.t, 'room.state', 'явный возврат в комнату не прошёл');
    // Прежний сокет после этого закрыт — с ним больше не работают.
    carol.close();
    open.splice(open.indexOf(carol), 1);
    await sleep(300);
    const after = await back.rpc({ t: 'room.join', code: foreignRoomCode },
      ['room.state', 'game.error']);
    assert.strictEqual(after.t, 'room.state', 'после возврата игрок не в своей комнате');
    // Дальше по сценарию работаем уже с новым соединением.
    carol.ws = back.ws;
    carol.label = 'carol';
    carol.next = back.next.bind(back);
    carol.send = back.send.bind(back);
  });

  await test('войти в чужую комнату с другого сервера нельзя', async () => {
    const r = await dave.rpc({ t: 'room.join', code: foreignRoomCode }, ['room.state', 'game.error']);
    assert.strictEqual(r.t, 'game.error', `сервер отдал чужую комнату: ${JSON.stringify(r)}`);
  });

  await test('список серверов клиенту тоже доступен до входа', async () => {
    const c = await new Client(PORT_A, 'probe').connect();
    open.pop();
    const r = await c.rpc({ t: 'servers.list' }, 'servers.list');
    assert.strictEqual(r.t, 'servers.list');
    assert.ok(r.servers.length >= 2, 'клиент должен видеть оба сервера');
    assert.ok(r.servers.every((s) => typeof s.host === 'string' && typeof s.port === 'number'));
    c.close();
  });

  // ------------------------------------------------------------- партия
  section('Партия: ход и отсутствие утечек');

  const erin = await signedIn(PORT_A, 'erin', 'secret123', 'Эрин', 'erin@A');
  let gameRoom = null;

  await test('без второй игроки место пустует', async () => {
    const r = await carol.rpc({ t: 'room.create', seats: 2, require30: false, name: 'Партия' }, 'room.state');
    gameRoom = r.room.code;
    assert.strictEqual(r.room.filled ?? 1, 1);
  });

  await test('второй игрок входит — партия стартует сама', async () => {
    const r = await erin.rpc({ t: 'room.join', code: gameRoom }, ['room.state', 'game.state', 'game.error']);
    assert.strictEqual(r.t, 'game.state', `заполненная комната должна стартовать сама: ${JSON.stringify(r)}`);
    assert.strictEqual(r.state.you, 1, 'второй игрок видит своё место');
    assert.strictEqual(r.state.players[1].nick, 'Эрин');
    assert.strictEqual(r.state.hand.length, 14);
  });

  await test('не хост и не кнопка — партия уже идёт', async () => {
    const r = await erin.rpc({ t: 'room.start' }, ['game.state', 'game.error']);
    assert.strictEqual(r.t, 'game.error', JSON.stringify(r));
  });

  await test('хосту пришла игра со своей рукой и местом', async () => {
    const r = await carol.rpc({ t: 'game.rejoin' }, 'game.state');
    assert.strictEqual(r.state.you, 0);
    assert.strictEqual(r.state.hand.length, 14, 'хосту пришла его рука');
    assert.strictEqual(r.state.players.length, 2);
  });

  await test('второй игрок получает игру с собственной рукой', async () => {
    const r = await erin.rpc({ t: 'game.rejoin' }, 'game.state');
    assert.strictEqual(r.state.you, 1);
    assert.strictEqual(r.state.hand.length, 14);
  });

  await test('в виде соперника его руки нет — только число фишек', async () => {
    const cView = await carol.rpc({ t: 'game.rejoin' }, 'game.state');
    const eView = await erin.rpc({ t: 'game.rejoin' }, 'game.state');
    for (const v of [cView, eView]) {
      assert.strictEqual(v.state.hand.length, 14, 'своя рука есть');
      for (const p of v.state.players) {
        assert.strictEqual(typeof p.handCount, 'number', 'у каждого видно число фишек');
        assert.ok(!Array.isArray(p.hand), 'чужие руки массивами не отдаём');
      }
    }
    assert.strictEqual(cView.state.players[1].handCount, 14);
    assert.strictEqual(eView.state.players[0].handCount, 14);
  });

  await test('руки соперников не пересекаются', async () => {
    const cView = await carol.rpc({ t: 'game.rejoin' }, 'game.state');
    const eView = await erin.rpc({ t: 'game.rejoin' }, 'game.state');
    const overlap = cView.state.hand.filter((id) => eView.state.hand.includes(id));
    assert.deepStrictEqual(overlap, [], 'руки пересекаются — раздача сломана');
  });

  await test('в виде вообще нет чужих фишек вне стола', async () => {
    const cView = await carol.rpc({ t: 'game.rejoin' }, 'game.state');
    const eView = await erin.rpc({ t: 'game.rejoin' }, 'game.state');
    // Всё, что Кэрол видит, — это его рука, стол и служебные числа.
    const eHand = new Set(eView.state.hand);
    for (const id of cView.state.hand) {
      assert.ok(!eHand.has(id), `фишка ${id} есть в руках обоих сразу`);
    }
    const blob = JSON.stringify(cView.state);
    for (const id of eView.state.hand) {
      // Фишка соперника в нашем виде может встретиться только если она
      // выложена на стол — тогда это публичная информация.
      const onTable = cView.state.table.some((row) => row.tileIds.includes(id));
      if (!onTable) {
        assert.ok(!blob.includes(`"${id}"`), `чужая фишка ${id} засветилась в нашем виде`);
      }
    }
  });

  await test('в игре виден номер места и чей сейчас ход', async () => {
    const cView = await carol.rpc({ t: 'game.rejoin' }, 'game.state');
    assert.strictEqual(cView.state.you, 0);
    assert.strictEqual(cView.state.current, 0, 'первым ходит место 0');
    assert.ok(Array.isArray(cView.state.table));
    assert.ok(typeof cView.state.deckCount === 'number', 'клиенту нужно знать, сколько осталось в колоде');
  });

  await test('не в свой ход брать нельзя', async () => {
    const cView = await carol.rpc({ t: 'game.rejoin' }, 'game.state');
    // Сервер сам говорит, чей это ход, — клиенту не нужно это вычислять.
    const idle = cView.state.myTurn ? erin : carol;
    const r = await idle.rpc({ t: 'game.draw' }, ['game.state', 'game.error']);
    assert.strictEqual(r.t, 'game.error', `чужой ход прошёл: ${JSON.stringify(r)}`);
  });

  await test('взятие из колоды в свой ход работает', async () => {
    const cView = await carol.rpc({ t: 'game.rejoin' }, 'game.state');
    const who = cView.state.myTurn ? carol : erin;
    const before = (await who.rpc({ t: 'game.rejoin' }, 'game.state')).state.hand.length;
    const r = await who.rpc({ t: 'game.draw' }, ['game.state', 'game.error']);
    assert.strictEqual(r.t, 'game.state', JSON.stringify(r));
    assert.strictEqual(r.state.hand.length, before + 1, 'взятая фишка пришла в руку');
  });

  await test('после взятия ход ушёл сопернику', async () => {
    const cView = await carol.rpc({ t: 'game.rejoin' }, 'game.state');
    assert.notStrictEqual(cView.state.current, cView.state.you, 'ход должен уйти сопернику');
  });

  // Число фишек у Эрин дальше по тестам сверяется: ход set_table уменьшает
  // руку, поэтому «ожидаемое» значение считаем, а не зашиваем.
  let erinHandExpected = 15;
  let playedRow = null;

  await test('валидный ряд уходит на сервер одним куском (set_table)', async () => {
    const eView = await erin.rpc({ t: 'game.rejoin' }, 'game.state');
    const plan = planRowFromView(eView.state, erin.hello.catalog);
    if (plan === null) {
      // Набора не нашлось — просто берём фишку, чтобы ход ушёл дальше.
      const r = await erin.rpc({ t: 'game.draw' }, ['game.state', 'game.error']);
      assert.strictEqual(r.t, 'game.state', JSON.stringify(r));
      erinHandExpected = r.state.hand.length;
      assert.ok(true, 'в руке не нашлось валидного набора — тест пропущен');
      return;
    }
    const mine = plan.ids;
    const rows = eView.state.table.map((row) => ({ id: row.id, tiles: row.tileIds.slice() }));
    rows.push({ id: 0, tiles: mine });
    const before = eView.state.hand.length;
    const r = await erin.rpc({ t: 'game.commit', ops: [{ op: 'set_table', rows }] },
      ['game.state', 'game.error']);
    assert.strictEqual(r.t, 'game.state', JSON.stringify(r));
    assert.strictEqual(r.state.hand.length, before - mine.length, 'фишки ушли из руки на стол');
    const onMyTable = r.state.table.some((row) => mine.every((id) => row.tileIds.includes(id)));
    assert.ok(onMyTable, 'выложенный ряд виден и мне');
    erinHandExpected = r.state.hand.length;

    const cView = await carol.rpc({ t: 'game.rejoin' }, 'game.state');
    assert.ok(cView.state.table.some((row) => mine.every((id) => row.tileIds.includes(id))),
      'соперник видит тот же ряд — состояние общее');
    assert.strictEqual(cView.state.players[1].handCount, before - mine.length,
      'соперник видит у нас уменьшившуюся руку, но не её состав');
    const cBlob = JSON.stringify(cView.state);
    for (const id of r.state.hand) {
      if (!cView.state.table.some((row) => row.tileIds.includes(id))) {
        assert.ok(!cBlob.includes(`"${id}"`), `фишка ${id} из нашей руки засветилась у соперника`);
      }
    }
    playedRow = plan;
  });

  await test('выложенный ряд можно переставить', async () => {
    if (playedRow === null) {
      assert.ok(true, 'предыдущий тест пропущен');
      return;
    }
    const ids = playedRow.ids;
    const cView = await carol.rpc({ t: 'game.rejoin' }, 'game.state');
    const row = cView.state.table.find((x) => ids.every((id) => x.tileIds.includes(id)));
    if (row === undefined) {
      assert.ok(true, 'ряд не найден — тест пропущен');
      return;
    }
    // «Переставить» для набора и для серии — разные жесты, и путать их
    // нельзя: набор разворачивается как угодно, а серия это кольцо,
    // её можно только сдвинуть. Развёрнутая серия с джокером вообще
    // может не иметь ни одного годного порядка, и тогда отказ сервера
    // был бы правильным, а тест — нет.
    const moved = playedRow.kind === 'run'
      ? row.tileIds.slice(1).concat(row.tileIds.slice(0, 1))
      : row.tileIds.slice().reverse();
    const rows = cView.state.table.map((x) => (x === row
      ? { id: x.id, tiles: moved }
      : { id: x.id, tiles: x.tileIds.slice() }));
    // Кто бы ни ходил, он обязан что-то добавить: set_table без новых
    // фишек ходом не считается.
    const who = cView.state.myTurn ? carol : erin;
    const plan = planRowFromView(cView.state, who.hello.catalog);
    if (plan === null) {
      assert.ok(true, 'в руке не нашлось валидного набора — тест пропущен');
      return;
    }
    const r = await who.rpc({ t: 'game.commit', ops: [{ op: 'set_table', rows: rows.concat([{ id: 0, tiles: plan.ids }]) }] },
      ['game.state', 'game.error']);
    assert.strictEqual(r.t, 'game.state', JSON.stringify(r));
    const nowThere = r.state.table.find((x) => x.id === row.id);
    // Сервер хранит канонический порядок, поэтому проверить надо не на
    // присланный, а на смысл: те же фишки и годный по правилам ряд.
    // Раньше здесь стояло сравнение с присланным порядком, и тест
    // требовал от сервера ровно того, что ему запрещало делать.
    assert.deepStrictEqual(nowThere.tileIds.slice().sort((a, b) => a - b),
      row.tileIds.slice().sort((a, b) => a - b),
      'перестановка не должна ни выкинуть, ни выдумать фишку');
    const stored = nowThere.tileIds.map((id) => who.hello.catalog.find((t) => t.id === id));
    assert.ok(rules.validateRow(stored).ok,
      `ряд остался валидным, а хранится как ${JSON.stringify(nowThere.tileIds)}`);
    if (r.state.you === 1) erinHandExpected = r.state.hand.length;
  });

  await test('список комнат в партии не показывает чужие пароли и коды лишнего', async () => {
    const r = await carol.rpc({ t: 'rooms.list' }, 'rooms.list');
    const codes = r.rooms.map((x) => x.code);
    // Идущая партия в список не попадает: в неё уже нельзя встать.
    assert.ok(!codes.includes(gameRoom), `партия ${gameRoom} попала в список набора`);
    // А лобби, где ещё можно сесть, — попадает, и без пароля внутри.
    assert.ok(codes.includes(foreignRoomCode), 'лобби должно быть видно');
    for (const x of r.rooms) {
      assert.ok(!('password' in x) && !('passwordHash' in x), 'наружу уехал пароль комнаты');
      assert.strictEqual(typeof x.hasPassword, 'boolean');
    }
  });

  await test('кто-то ходит: взятие проходит у того, кому принадлежит ход', async () => {
    // Кто именно ходит, зависит от веток выше, поэтому спрашиваем у сервера,
    // а не угадываем. Взятие обязано пройти ровно у одного.
    const cView = await carol.rpc({ t: 'game.rejoin' }, 'game.state');
    const who = cView.state.myTurn ? carol : erin;
    const before = who === carol
      ? (await carol.rpc({ t: 'game.rejoin' }, 'game.state')).state.hand.length
      : (await erin.rpc({ t: 'game.rejoin' }, 'game.state')).state.hand.length;
    const r = await who.rpc({ t: 'game.draw' }, ['game.state', 'game.error']);
    assert.strictEqual(r.t, 'game.state', JSON.stringify(r));
    assert.strictEqual(r.state.hand.length, before + 1, 'взятая фишка пришла в руку');
    if (r.state.you === 1) erinHandExpected = r.state.hand.length;
  });

  // ------------------------------------------------- выход из партии и возврат
  section('Выход из партии и возврат');

  // Отдельная комната под этот сценарий: мягкий выход ставит партию на
  // паузу, и трогать рабочую пару carol/erin из предыдущих тестов нельзя.
  const frank = await signedIn(PORT_A, 'frank', 'secret123', 'Франк', 'frank@A');
  const gina = await signedIn(PORT_A, 'gina', 'secret123', 'Гина', 'gina@A');
  let exitRoom = null;

  await test('мягкий выход из идущей партии оставляет место за игроком', async () => {
    const room = await frank.rpc({ t: 'room.create', seats: 2, require30: false, name: 'Выход' }, 'room.state');
    exitRoom = room.room.code;
    const join = await gina.rpc({ t: 'room.join', code: exitRoom }, ['game.state', 'game.error']);
    assert.strictEqual(join.t, 'game.state', `заполнение комнаты должно запустить партию: ${JSON.stringify(join)}`);
    // Хост партию тоже видит — она началась сама, без кнопки.
    const start = await frank.rpc({ t: 'game.rejoin' }, 'game.state');
    assert.strictEqual(start.t, 'game.state', JSON.stringify(start));
    // Мягкий выход: место остаётся, а ответ называет комнату, в которой
    // игрока ждут (из неё клиент строит баннер «вы всё ещё в комнате»).
    const leave = await gina.rpc({ t: 'room.leave' }, ['room.left', 'game.error']);
    assert.strictEqual(leave.t, 'room.left', JSON.stringify(leave));
    assert.ok(leave.room && leave.room.code === exitRoom && leave.room.state === 'playing',
      `мягкий выход не сообщил, где игрока ждут: ${JSON.stringify(leave)}`);
    assert.strictEqual(leave.soft, true, 'сервер должен отметить мягкий выход');
  });

  await test('вход в аккаунт не возвращает игрока в партию принудительно', async () => {
    const back = await new Client(PORT_A, 'gina-back').connect();
    const r = await back.rpc({ t: 'auth.login', login: 'gina', password: 'secret123' },
      ['auth.ok', 'auth.err']);
    assert.strictEqual(r.t, 'auth.ok', `вход после выхода не прошёл: ${JSON.stringify(r)}`);
    // Комната названа в auth.ok — но только названа.
    assert.ok(r.room && r.room.code === exitRoom && r.room.state === 'playing',
      `вход не сообщил об идущей партии: ${JSON.stringify(r)}`);
    // И никакой рассылки game.state прямо после входа: вернуть игрока в
    // партию теперь можно только его явным решением.
    await sleep(700);
    const stray = back.queue.find((m) => m.t === 'game.state');
    assert.strictEqual(stray, undefined,
      `вход принудительно вернул игрока в партию: ${JSON.stringify(stray)}`);
    // Явный возврат (game.rejoin) забирает место на себя и возвращает на поле.
    const rejoin = await back.rpc({ t: 'game.rejoin' }, ['game.state', 'game.error']);
    assert.strictEqual(rejoin.t, 'game.state', `ре-джойн не прошёл: ${JSON.stringify(rejoin)}`);
    assert.strictEqual(rejoin.state.you, 1, 'гина вернулась на своё место');
    // Дальше работаем с новым соединением (старое вытеснено и закрыто).
    gina.ws = back.ws;
    gina.label = 'gina';
    gina.next = back.next.bind(back);
    gina.send = back.send.bind(back);
  });

  await test('room.drop освобождает место с концами, партия закрывается', async () => {
    // Полный выход: ответ без поля room (нечего вспоминать), место свободно.
    const drop = await gina.rpc({ t: 'room.drop' }, ['room.left', 'game.error']);
    assert.strictEqual(drop.t, 'room.left', JSON.stringify(drop));
    assert.ok(!('room' in drop), 'полный выход не должен оставлять комнату ждущей');
    // Партия из двух игроков без одного — закрывается, вернуться нельзя.
    const rejoin = await frank.rpc({ t: 'game.rejoin' }, ['game.state', 'game.error']);
    assert.strictEqual(rejoin.t, 'game.error', 'партию с одним игроком закрыли не сразу');
  });

  // ------------------------------------------------------------ секрет
  section('Секрет кластера');

  await test('gossip без подписи отвергается', async () => {
    const r = await postGossip(PORT_A, gossipBody('srv-nosign', 1), 'none');
    assert.strictEqual(r.code, 403);
  });

  await test('gossip с чужой подписью отвергается', async () => {
    const r = await postGossip(PORT_A, gossipBody('srv-forged', 1), 'bad');
    assert.strictEqual(r.code, 403);
  });

  await test('сервер, приславший gossip с плохой подписью, в реестр не попадает', async () => {
    const list = await httpGet(PORT_A, '/cluster/servers');
    assert.ok(!list.body.servers.some((s) => s.id === 'srv-forged'));
    assert.ok(!list.body.servers.some((s) => s.id === 'srv-nosign'));
  });

  await test('gossip с верной подписью принимается', async () => {
    const r = await postGossip(PORT_A, gossipBody('srv-real', 1), 'good');
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ok, true);
    assert.ok(Array.isArray(r.body.accounts));
    assert.ok(typeof r.body.sent_up_to === 'number');
  });

  await test('открытые пароли в реплике не едут', async () => {
    const r = await postGossip(PORT_A, gossipBody('srv-real', 1), 'good');
    const blob = JSON.stringify(r.body);
    assert.ok(!blob.includes('secret123'), 'открытый пароль попал в реплику');
    assert.ok(!blob.includes('newsecret1'), 'новый пароль попал в реплику');
  });

  await test('сервер с верной подписью попадает в реестр', async () => {
    const list = await httpGet(PORT_A, '/cluster/servers');
    assert.ok(list.body.servers.some((s) => s.id === 'srv-real'));
  });

  await test('gossip без поля from отвергается', async () => {
    const r = await postGossip(PORT_A, { nonsense: true }, 'good');
    assert.strictEqual(r.code, 400);
  });

  await test('неизвестный путь отдаёт 404', async () => {
    const r = await httpGet(PORT_A, '/no-such-thing');
    assert.strictEqual(r.code, 404);
  });

  // ------------------------------------------------------------ смерть
  section('Смерть соседа');

  procs[1].kill('SIGKILL');
  await sleep(300);

  const forgot = await until(async () => {
    const a = await httpGet(PORT_A, '/cluster/servers');
    return a.body.servers.every((s) => s.id !== 'srv-b') ? a.body : null;
  });

  await test('убитый сервер исчезает из реестра', () => {
    assert.ok(forgot, 'мёртвый сервер остался в реестре дольше TTL');
    assert.ok(forgot.servers.some((s) => s.id === 'srv-a'), 'свой сервер остаётся в реестре');
  });

  await test('выживший сервер продолжает работать', async () => {
    const r = await httpGet(PORT_A, '/health');
    assert.strictEqual(r.code, 200);
    assert.ok(r.body.ok);
  });

  await test('выживший сервер продолжает обслуживать комнаты', async () => {
    const r = await carol.rpc({ t: 'rooms.list' }, 'rooms.list');
    assert.ok(r.rooms.some((x) => x.code === foreignRoomCode), 'своё лобби на месте');
  });

  await test('партия на выжившем сервере продолжается', async () => {
    const r = await erin.rpc({ t: 'game.rejoin' }, 'game.state');
    assert.strictEqual(r.state.you, 1);
    assert.strictEqual(r.state.hand.length, erinHandExpected, 'партия продолжается, рука на месте');
    assert.strictEqual(r.state.code, gameRoom, 'это та же самая партия');
  });

  await test('вход на выжившем сервере работает', async () => {
    const r = await loginOnce(PORT_A, 'erin', 'secret123', 'probe');
    assert.strictEqual(r.t, 'auth.ok', JSON.stringify(r));
  });

  // ---------------------------------------------------------------- итог
  process.stdout.write('\n');
  if (failures.length === 0) {
    process.stdout.write(`ALL ${passed} CLUSTER TESTS PASSED\n`);
    cleanup();
    process.exit(0);
  } else {
    process.stdout.write(`FAILED: ${failures.length} из ${passed + failures.length}\n`);
    for (const f of failures) {
      process.stdout.write(`\n--- ${f.name}\n`);
      process.stdout.write(`${String(f.error && f.error.message).split('\n').slice(0, 8).join('\n')}\n`);
    }
    cleanup();
    process.exit(1);
  }
})().catch((e) => {
  process.stdout.write(`\nСЦЕНАРИЙ УПАЛ: ${e.stack || e.message}\n`);
  cleanup();
  process.exit(1);
});

function cleanup() {
  for (const c of open) c.close();
  for (const p of procs) {
    try { p.kill('SIGKILL'); } catch (_) { /* уже мёртв */ }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* не смогли */ }
}
