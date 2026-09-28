#!/usr/bin/env node
'use strict';

// ==============================================================
//  deploy_check.js — проверка живого кластера.
//
//  Говорит с серверами ровно так, как говорит клиент: по WSS, с
//  зашитым сертификатом, с correlation-полем rid. Поэтому проверка
//  ловит не только «сервер жив», но и «клиент к нему подключится»:
//  если сертификат выпущен не для того адреса или забыт в res://certs/,
//  проверка упадёт здесь, а не у игрока.
//
//  Что проверяется — ровно то, ради чего кластер и делался:
//    1. оба сервера отвечают и держат самоподписанный сертификат;
//    2. каждый видит ДРУГОГО в реестре (gossip за <= минуту);
//    3. аккаунт, заведённый на одном, входит на втором (репликация);
//    4. токен сессии, выданный на одном, принимается вторым;
//    5. комната живёт только на своём сервере (партии не реплицируются),
//       и список комнат с обоих собирается запросом к обоим.
//
//  Запуск:
//      node server/tools/deploy_check.js
//      node server/tools/deploy_check.js --server srv-ru=85.209.2.116:6767 \
//                                        --server srv-lv=31.56.196.114:6767
//      node server/tools/deploy_check.js --wait 90
//
//  Адреса берутся из .env в корне репозитория, сертификаты — из
//  res://certs/<ip-дефисами>.pem. Код возврата 0 — всё хорошо.
// ==============================================================

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..', '..');
const CERTS_DIR = path.join(ROOT, 'certs');
const OPEN_TIMEOUT = 15000;
const RPC_TIMEOUT = 12000;

// ------------------------------------------------------------------ ввод

function parseArgs(argv) {
  const out = { servers: [], wait: 75, certsDir: CERTS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--server' && argv[i + 1]) {
      const [id, rest] = argv[i + 1].split('=');
      const [host, port] = (rest || '').split(':');
      out.servers.push({ id, host, port: Number(port) || 6767 });
      i += 1;
    } else if (a === '--wait' && argv[i + 1]) {
      out.wait = Number(argv[i + 1]) || out.wait;
      i += 1;
    } else if (a === '--certs-dir' && argv[i + 1]) {
      out.certsDir = path.resolve(argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`не понял аргумент: ${a}`);
    }
  }
  return out;
}

function serversFromEnv() {
  const env = {};
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#') || !s.includes('=')) continue;
      const eq = s.indexOf('=');
      env[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
    }
  }
  const out = [];
  for (const key of ['RU', 'LV']) {
    if (!env[`DG_${key}_SERVER_ID`] || !env[`DG_${key}_PUBLIC_HOST`]) continue;
    out.push({
      id: env[`DG_${key}_SERVER_ID`],
      name: env[`DG_${key}_SERVER_NAME`],
      host: env[`DG_${key}_PUBLIC_HOST`],
      port: Number(env.DG_PORT) || 6767,
    });
  }
  return out;
}

// ------------------------------------------------------------ сертификат

// Каталог с сертификатами. По умолчанию res://certs/ — то, что
// зашивается в клиент; --certs-dir позволяет проверить стенд, не
// подменяя боевые файлы.
let certsDir = CERTS_DIR;

// Расширения в том же порядке, что и в Certs.EXTS. .crt — родной для
// Godot (попадает в PCK через импорт), .pem оставлен на случай старых
// файлов в репозитории.
const CERT_EXTS = ['.crt', '.pem'];

function certFor(host) {
  // Имя файла ровно такое, как ищет Certs._load в клиенте: адрес
  // с дефисами вместо точек. Нет файла — связи не будет: клиент
  // зашивает сертификат побайтово и не доверяет ничему постороннему.
  const base = path.join(certsDir, host.replace(/\./g, '-'));
  for (const ext of CERT_EXTS) {
    const file = base + ext;
    if (fs.existsSync(file)) return fs.readFileSync(file);
  }
  throw new Error(
    `нет ${base}{${CERT_EXTS.join('|')}} — клиент не сможет подключиться к ${host}.\n`
    + '        Сначала python server/deploy/deploy.py --certs-only');
}

// ------------------------------------------------------------- соединение

/** Одно соединение с сервером: rpc(t, payload) -> ответ с тем же rid. */
class Conn {
  constructor(entry) {
    this.entry = entry;
    this.ws = null;
    this.rid = 0;
    this.waiters = new Map();
    this.user = null;
    this.token = '';
    // Приветствие сервера приходит сразу после рукопожатия и несёт
    // каталог фишек и время терпения к разрыву. Запоминаем его, чтобы
    // проверка могла сказать, что сервер не просто отвечает, а отвечает
    // тем, на что рассчитывает клиент.
    this.hello = null;
  }

  get label() {
    return `${this.entry.id}(${this.entry.host}:${this.entry.port})`;
  }

  /**
   * Второе соединение к тому же серверу — ровно то, что делает клиент,
   * собирая список комнат с обоих серверов. Отдельный экземпляр Conn,
   * а не отправка по основному: проверка должна убедиться, что чтение
   * списка не трогает основное соединение игрока.
   */
  async spawn() {
    return new Conn(this.entry).open();
  }

  open() {
    return new Promise((resolve, reject) => {
      let ca;
      try {
        ca = certFor(this.entry.host);
      } catch (e) {
        reject(e);
        return;
      }
      const url = `wss://${this.entry.host}:${this.entry.port}/`;
      // servername НЕ задаём: адрес — голый IP, а SNI с IP-адресом
      // запрещён (RFC 6066), и node предупредит, а в следующей версии
      // откажется подключаться. Имя проверяется по сертификату.
      const ws = new WebSocket(url, { ca });
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch (_) { /* уже мёртв */ }
        reject(new Error(`${this.label}: не открылся за ${OPEN_TIMEOUT} мс`));
      }, OPEN_TIMEOUT);

      let opened = false;
      ws.on('open', () => {
        opened = true;
        clearTimeout(timer);
        resolve(this);
      });
      ws.on('error', (e) => {
        clearTimeout(timer);
        // Ошибка до open — это провал рукопожатия, и о нём стоит
        // сказать прямо: обычно она означает не тот сертификат.
        if (!opened) reject(new Error(`${this.label}: ${e.message}`));
      });
      ws.on('close', () => { this._failAll('связь оборвалась'); });
      ws.on('message', (data) => this._onMessage(data));
    });
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch (_) {
      return;
    }
    if (msg && msg.t === 'hello') this.hello = msg;
    if (msg && msg.rid && this.waiters.has(msg.rid)) {
      const w = this.waiters.get(msg.rid);
      this.waiters.delete(msg.rid);
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  }

  _failAll(reason) {
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.resolve({ t: 'closed', reason });
    }
    this.waiters.clear();
  }

  send(t, payload) {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve({ t: 'offline', reason: 'нет связи' });
        return;
      }
      this.rid += 1;
      const rid = `c${this.rid}`;
      const timer = setTimeout(() => {
        this.waiters.delete(rid);
        // Сервер может просто не ответить (завис, перегружен). Тишина
        // здесь хуже явного отказа: иначе проверка пройдёт, а игрок
        // later увидит «ничего не происходит».
        resolve({ t: 'timeout', reason: `${t}: сервер не ответил за ${RPC_TIMEOUT} мс` });
      }, RPC_TIMEOUT);
      this.waiters.set(rid, { resolve, timer });
      this.ws.send(JSON.stringify(Object.assign({ t, rid }, payload || {})));
    });
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) { /* уже закрыт */ }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- отчёт

let failed = 0;
function check(ok, what, detail) {
  if (ok) {
    console.log(`  ok    ${what}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}
const step = (t) => console.log(`\n== ${t}`);

// ------------------------------------------------------------------ сценарий

async function main() {
  const args = parseArgs(process.argv.slice(2));
  certsDir = args.certsDir;
  const servers = args.servers.length ? args.servers : serversFromEnv();
  if (servers.length < 2) {
    console.error('Нужно минимум два сервера: --server id=host:port (дважды) или .env');
    process.exit(2);
  }
  console.log(`Проверяю кластер из ${servers.length} серверов: `
    + servers.map((s) => `${s.id}@${s.host}:${s.port}`).join(', '));

  // --- 1. связь и сертификаты -------------------------------------
  step('связь и сертификаты');
  const conns = [];
  for (const entry of servers) {
    const c = new Conn(entry);
    try {
      await c.open();
      const pong = await c.send('ping', {});
      check(pong.t === 'pong',
        `${entry.id} отвечает по TLS с зашитым сертификатом`,
        pong.t === 'pong' ? '' : pong.reason);
      conns.push(c);
    } catch (e) {
      check(false, `${entry.id} отвечает по TLS с зашитым сертификатом`, e.message);
    }
  }
  if (conns.length < 2) {
    console.log('\nДальше проверять нечего: нужен живой доступ к обоим серверам.');
    return 1;
  }
  const [a, b] = conns;

  // Приветствие — то, на что клиент опирается с первой секунды: каталог
  // фишек (без него не рисуется ни одна) и время терпения к разрыву.
  for (const c of conns) {
    const h = c.hello;
    if (!check(!!h, `${c.label} прислал приветствие`)) continue;
    check(h.server && h.server.id === c.entry.id,
      `${c.label} назвался своим id в приветствии`,
      h.server ? `прислал ${h.server.id}` : 'поля server нет');
    const catalog = Array.isArray(h.catalog) ? h.catalog : [];
    check(catalog.length > 0,
      `${c.label} прислал каталог фишек`,
      `${catalog.length} шт.`);
    // Каталог должен совпадать у обоих: клиент рисует фишки по нему
    // без сверки с сервером, и расхождение даст «несуществующие» числа.
    if (a.hello && b.hello) {
      const ida = (a.hello.catalog || []).map((t) => t.id).join(',');
      const idb = (b.hello.catalog || []).map((t) => t.id).join(',');
      check(ida === idb && ida !== '', 'каталог фишек одинаков у обоих серверов');
    }
    check(typeof h.graceMs === 'number' && h.graceMs >= 1000,
      `${c.label} объявил время удержания места при разрыве`,
      h.graceMs ? `${Math.round(h.graceMs / 1000)} с` : 'не объявлено');
  }

  // --- 2. реестр серверов (gossip) --------------------------------
  // Сервер только что поднят, а gossip ходит раз в минуту: даём время.
  step('реестр серверов: каждый знает про обоих');
  const deadline = Date.now() + args.wait * 1000;
  let seen = [[], []];
  for (;;) {
    seen = await Promise.all(conns.map((c) => c.send('servers.list', {})));
    const ids = seen.map((m) => (m.servers || []).map((s) => s.id));
    const allOk = ids.every((list) => servers.every((s) => list.includes(s.id)));
    if (allOk || Date.now() > deadline) {
      conns.forEach((c, i) => check(ids[i].includes(a.entry.id) && ids[i].includes(b.entry.id),
        `${c.label} видит в реестре ${servers.map((s) => s.id).join(' и ')}`,
        allOk ? '' : `видит только ${ids[i].join(', ') || '—'}`));
      break;
    }
    process.stdout.write(`  … ждём gossip (${ids.map((l) => l.length).join('/')} серверов)\r`);
    await sleep(5000);
  }
  console.log('');

  // --- 3. репликация аккаунтов ------------------------------------
  step('репликация аккаунтов между серверами');
  const login = `check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = 'check-pass-4711';
  const reg = await a.send('auth.register', { login, password, nick: 'Проверка' });
  if (!check(reg.t === 'auth.ok', `аккаунт ${login} заведён на ${a.label}`,
    reg.t === 'auth.ok' ? '' : reg.reason)) {
    return 1;
  }
  const token = reg.token;
  check(typeof token === 'string' && token.length > 0, 'сервер выдал токен сессии');

  // Репликация добровольная: сразу после заведения запись уходит
  // соседям, но если сосед только что проснулся, он ещё не знает.
  const dl = Date.now() + args.wait * 1000;
  let last = {};
  for (;;) {
    last = await b.send('auth.login', { login, password });
    if (last.t === 'auth.ok' || Date.now() > dl) break;
    process.stdout.write(`  … ждём репликацию на ${b.label}\r`);
    await sleep(5000);
  }
  console.log('');
  check(last.t === 'auth.ok',
    `вход на ${b.label} тем же логином`,
    last.t === 'auth.ok' ? `ник ${(last.user || {}).nick}` : last.reason);

  // --- 4. сессия общая для кластера --------------------------------
  // Это то, на чём держится «войти на одном сервере, видеть комнаты
  // обоих»: токен подписан общим секретом, поэтому второй сервер
  // принимает выданный первым без похода в базу.
  const resumed = await b.send('auth.resume', { token });
  check(resumed.t === 'auth.ok', `токен с ${a.label} принят на ${b.label}`, resumed.reason || '');

  // --- 5. комнаты: свои и общий список ------------------------------
  step('комнаты');
  const codeA = await createRoom(a, 'Проверка-A');
  const codeB = await createRoom(b, 'Проверка-B');
  const listA = await a.send('rooms.list', {});
  const listB = await b.send('rooms.list', {});
  const roomsA = (listA.rooms || []).map((r) => r.code);
  const roomsB = (listB.rooms || []).map((r) => r.code);

  check(roomsA.includes(codeA), `комната ${codeA} видна в списке ${a.label}`);
  check(!roomsA.includes(codeB),
    `комната ${codeB} НЕ видна на ${a.label} — партии не реплицируются, каждая на своём сервере`);
  check(roomsB.includes(codeB), `комната ${codeB} видна в списке ${b.label}`);
  check(!roomsB.includes(codeA), `комната ${codeA} НЕ видна на ${b.label}`);

  // Так клиент и собирает список: спрашивает оба и показывает вместе.
  const merged = [...roomsA, ...roomsB];
  check(merged.includes(codeA) && merged.includes(codeB),
    'список с обоих серверов собирается в один (клиент спрашивает оба)');

  // --- 6. наблюдатель: чтение чужого списка не должно стоить комнаты ---
  // Клиент спрашивает список комнат с КАЖДОГО сервера отдельной короткой
  // связью. Такой связи нужен вход, но обычный вход отбирает сокет игрока,
  // и её закрытие выбивало его из комнаты, а лобби с одним игроком сервер
  // удалял. Проверяем на живых серверах, что наблюдательский вход есть и
  // что комната после чтения на месте: задетая версия hub.js об этом
  // знает только тесты в исходниках, а не развёрнутый код.
  step('наблюдательский доступ к списку комнат');
  const observers = await Promise.all(conns.map((c) => c.spawn()));
  for (const o of observers) {
    const r = await o.send('lobby.open', { token });
    check(r.t === 'auth.ok', `${o.label} пустил наблюдателя (lobby.open)`, r.reason || '');
    const l = await o.send('rooms.list', {});
    check(l.t === 'rooms.list', `${o.label} отдал список комнат наблюдателю`, l.reason || '');
    const denied = await o.send('room.create', { seats: 2, require30: false, name: 'Не проходит' });
    check(denied.t === 'game.error', `${o.label} не дал наблюдателю создать комнату`,
      denied.t === 'game.error' ? '' : `ответ ${denied.t}`);
    o.close();
  }
  // Связи наблюдателей закрылись — комнаты обязаны были уцелеть.
  await sleep(500);
  const afterA = await a.send('rooms.list', {});
  const codesAfter = (afterA.rooms || []).map((r) => r.code);
  check(codesAfter.includes(codeA),
    `комната ${codeA} уцелела после чтения списка наблюдателями`,
    `в списке: ${codesAfter.join(', ') || 'ничего'}`);

  // Комнаты оставляем висеть? Нет: это рабочие машины, и через минуту
  // там может сидеть настоящий игрок. Убираем за собой.
  await a.send('room.leave', {});
  await b.send('room.leave', {});

  conns.forEach((c) => c.close());
  console.log('');
  if (failed === 0) {
    console.log('КЛАСТЕР РАБОТАЕТ: серверы видят друг друга, аккаунты и сессии '
      + 'общие, комнаты живут на своих серверах, чтение чужого списка безвредно.');
    return 0;
  }
  console.log(`НЕ ПРОШЛО проверок: ${failed}`);
  return 1;
}

async function createRoom(conn, name) {
  const res = await conn.send('room.create', { seats: 2, require30: false, name, password: '' });
  if (res.t !== 'room.state') {
    throw new Error(`${conn.label}: комнату создать не вышло — ${res.reason || res.t}`);
  }
  return res.room.code;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`\nОШИБКА: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
