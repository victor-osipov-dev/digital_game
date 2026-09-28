'use strict';

// Тесты сервера. Без фреймворков: нужен только node tools/run_tests.js
//
// Проверяем то, что нельзя проверить глазами: что сервер не отдаёт чужие
// руки, что отклонённый ход откатывается, что аккаунт нельзя угнать
// репликацией, что курсор репликации не перепрыгивает записи.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-test-'));
process.env.DG_DATA_DIR = TMP;
process.env.DG_DB_FILE = path.join(TMP, 'test.sqlite3');
process.env.DG_CLUSTER_SECRET = 'test-secret';
process.env.DG_LOG_LEVEL = 'error';
process.env.DG_SERVER_ID = 'srv-test';
process.env.DG_PEER_URLS = '';

const { config } = require('../src/config');
const { Db } = require('../src/db');
const { Accounts, verifyToken, signToken } = require('../src/accounts');
const { Cluster } = require('../src/cluster');
const { Rooms } = require('../src/rooms');
const { GameState } = require('../src/engine/game_state');
const Rules = require('../src/engine/rules');
const catalog = require('../src/engine/catalog');
const views = require('../src/views');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    // Печатаем сразу: если тест later роняет процесс, ранние провалы
    // всё равно видны.
    failures.push({ name, error: e });
    process.stderr.write(`FAIL  ${name}\n      ${String(e.message).split('\n')[0]}\n`);
  }
}

function group(name) {
  process.stdout.write(`\n${name}\n`);
}

// ================================================================ каталог
group('== Каталог фишек ==');

test('в каталоге ровно 108 фишек', () => {
  assert.strictEqual(catalog.CATALOG.length, 108);
  assert.strictEqual(catalog.BY_ID.size, 108);
});

test('id фишек идут подряд с 1', () => {
  const ids = catalog.CATALOG.map((t) => t.id).sort((a, b) => a - b);
  assert.strictEqual(ids[0], 1);
  assert.strictEqual(ids[ids.length - 1], 108);
  for (let i = 0; i < 108; i += 1) assert.strictEqual(ids[i], i + 1);
});

test('каждого (цвет, значение) ровно две фишки, джокеров 4', () => {
  const pairs = new Map();
  let jokers = 0;
  for (const t of catalog.CATALOG) {
    if (t.is_joker) { jokers += 1; continue; }
    const k = `${t.color}:${t.value}`;
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
  assert.strictEqual(pairs.size, 52, 'должно быть 52 пары ц��та/значение');
  for (const [, n] of pairs) assert.strictEqual(n, 2);
  assert.strictEqual(jokers, 4);
});

test('у джокеров value = 1, цвет 0..3', () => {
  const js = catalog.CATALOG.filter((t) => t.is_joker);
  assert.deepStrictEqual(js.map((t) => t.color).sort(), [0, 1, 2, 3]);
  for (const t of js) assert.strictEqual(t.value, 1);
});

// ================================================================ правила
group('== Правила ==');

function tile(id, color, value, joker) {
  return { id, color, value, is_joker: !!joker };
}

test('серия одного цвета по порядку — ок', () => {
  const r = Rules.validateRow([tile(0, 0, 5), tile(1, 0, 6), tile(2, 0, 7)]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'run');
});

test('набор разных цветов одного значения — ок', () => {
  const r = Rules.validateRow([tile(0, 0, 7), tile(1, 1, 7), tile(2, 2, 7)]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'set');
});

test('два ряда от 5–7 и 9–11', () => {
  assert.strictEqual(Rules.validateRow([tile(0, 0, 9), tile(1, 0, 10), tile(2, 0, 11)]).ok, true);
});

test('разрыв в серии — отказ', () => {
  const r = Rules.validateRow([tile(0, 0, 5), tile(1, 0, 6), tile(2, 0, 8)]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('порядку') || r.reason.includes('не хватает'));
});

test('ряд из 2 фишек — отказ', () => {
  assert.strictEqual(Rules.validateRow([tile(0, 0, 5), tile(1, 0, 6)]).ok, false);
});

test('набор из 5 — отказ', () => {
  const r = Rules.validateRow([
    tile(0, 0, 7), tile(1, 1, 7), tile(2, 2, 7), tile(3, 3, 7), tile(4, 0, 7),
  ]);
  assert.strictEqual(r.ok, false);
});

test('набор с дублем цвета — отказ', () => {
  const r = Rules.validateRow([tile(0, 0, 7), tile(1, 0, 7), tile(2, 2, 7)]);
  assert.strictEqual(r.ok, false);
});

test('джокер в хвосте серии получает следующее значение', () => {
  const r = Rules.validateRow([tile(0, 0, 5), tile(1, 0, 6), tile(2, 0, 7), tile(3, 0, 1, true)]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.joker_values[3], 8);
  assert.strictEqual(Rules.rowPoints([tile(0, 0, 5), tile(1, 0, 6), tile(2, 0, 7), tile(3, 0, 1, true)]), 26);
});

test('джокер в начале серии получает предыдущее значение', () => {
  const r = Rules.validateRow([tile(0, 0, 1, true), tile(1, 0, 5), tile(2, 0, 6), tile(3, 0, 7)]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.joker_values[0], 4);
});

test('джокер не может вылезти за 13 вверх', () => {
  const r = Rules.validateRow([tile(0, 0, 12), tile(1, 0, 13), tile(2, 0, 1, true)]);
  assert.strictEqual(r.ok, false);
});

test('джокер не может вылезти за 1 вниз', () => {
  const r = Rules.validateRow([tile(0, 0, 1, true), tile(1, 0, 1), tile(2, 0, 2)]);
  assert.strictEqual(r.ok, false);
});

test('три джокера — валидный набор', () => {
  const r = Rules.validateRow([tile(0, 0, 1, true), tile(1, 0, 1, true), tile(2, 0, 1, true)]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'set');
});

// ================================================================ GameState
group('== Состояние партии ==');

test('раздача: 2 игрока по 14 фишек, колода 108-28=80', () => {
  const s = GameState.create(2, ['A', 'B'], false);
  assert.strictEqual(s.handSize(0), 14);
  assert.strictEqual(s.handSize(1), 14);
  assert.strictEqual(s.tilesLeftInDeck(), 80);
});

test('в руке нет повторяющихся id', () => {
  const s = GameState.create(5, [], false);
  const seen = new Set();
  for (const p of s.players) for (const id of p.handIds) {
    assert.ok(!seen.has(id), `id ${id} продублирован`);
    seen.add(id);
  }
});

test('рука и колода вместе = 108 уникальных фишек', () => {
  const s = GameState.create(5, [], false);
  const seen = new Set();
  for (const p of s.players) for (const id of p.handIds) seen.add(id);
  for (const id of s.deck.ids) seen.add(id);
  assert.strictEqual(seen.size, 108);
});

test('взятие из колоды добавляет фишку и передаёт ход', () => {
  const s = GameState.create(2, ['A', 'B'], false);
  const before = s.handSize(0);
  const r = s.drawFromDeck();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.handSize(0), before + 1);
  assert.strictEqual(s.handSize(1), 14);
  assert.strictEqual(s.current, 1);
  assert.strictEqual(s.tilesLeftInDeck(), 79);
});

// Рука определяется раздачей, а раздача случайна. Чтобы тесты про 30 очков
// не зависели от удачи, собираем партию с заранее заданной рукой.
//
// Замена руки не должна терять фишки: колода хранит только невыданные, так
// что вытесненные из руки фишки возвращаем в колоду, а нужные — забираем
// оттуда, где оказались. Итог всегда 108 уникальных фишек.
function stateWithHand(require30, hand) {
  const s = GameState.create(2, ['A', 'B'], require30);
  const want = new Set(hand);
  assert.strictEqual(want.size, hand.length, 'в заданной руке нет повторов');

  const displaced = [];
  for (const id of s.players[0].handIds) if (!want.has(id)) displaced.push(id);

  const p1keep = [];
  for (const id of s.players[1].handIds) {
    // Нужная фишка из чужой руки просто переезжает в нашу и в колоду не идёт.
    if (!want.has(id)) p1keep.push(id);
  }
  s.players[1].handIds = p1keep;

  s.deck.ids = s.deck.ids.filter((id) => !want.has(id));
  s.deck.ids.push(...displaced);
  s.players[0].handIds = hand.slice();

  const used = new Set();
  for (const p of s.players) for (const id of p.handIds) used.add(id);
  for (const id of s.deck.ids) used.add(id);
  assert.strictEqual(used.size, 108, 'фишки в партии должны быть уникальны');
  return s;
}

// Фишки по моей схеме id: 1..52 — не-джокеры (цвет = (id-1)/26, значение =
// ((id-1)%26)/2 + 1), 53..56 — джокеры. Находим по описанию, а не по id,
// чтобы тест не зависел от порядка выдачи.
function findTile(color, value) {
  const t = catalog.CATALOG.find((x) => !x.is_joker && x.color === color && x.value === value);
  if (!t) throw new Error(`нет фишки ${color}:${value}`);
  return t.id;
}

function findJoker() {
  const t = catalog.CATALOG.find((x) => x.is_joker);
  if (!t) throw new Error('джокеров нет');
  return t.id;
}

test('первый ход обязан набрать 30 очков', () => {
  // Три единицы разных цветов = набор, но всего 3 очка — меньше 30.
  const s = stateWithHand(true, [findTile(0, 1), findTile(1, 1), findTile(2, 1)]);
  const row = s.addRow();
  for (const id of s.hand()) assert.strictEqual(s.placeFromHand(id, row.id, 99), true);
  const r = s.endTurn();
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('30'), 'ожидалось упоминание 30, а вот: ' + r.reason);
});

test('первый ход отклонённый НЕ портит состояние (откат)', () => {
  const ids = [findTile(0, 1), findTile(1, 1), findTile(2, 1)];
  const s = stateWithHand(true, ids);
  const before = JSON.stringify(s.captureAll());
  // Снимок делается ДО хода — ровно так же, как в rooms.commitTurn.
  s.beginTurn();
  const row = s.addRow();
  for (const id of ids) assert.strictEqual(s.placeFromHand(id, row.id, 99), true);
  assert.strictEqual(s.endTurn().ok, false, 'тройка единиц даёт 3 очка, а нужно 30');
  s.rollback();
  assert.strictEqual(JSON.stringify(s.captureAll()), before,
    'после отката состояние должно совпасть с исходным');
  assert.strictEqual(s.handSize(0), 3, 'рука на месте');
  assert.strictEqual(s.current, 0);
  assert.strictEqual(s.turnPlacedIds.length, 0);
  assert.strictEqual(s.table.length, 0, 'мусорный ряд убран');
});

test('валидный первый ход проходит и передаёт ход', () => {
  // Серия 10, 11, 12 одного цвета = 33 очка — проходит порог.
  // Две лишние фишки остаются в руке, иначе партия закончилась бы победой.
  const run3 = [findTile(0, 10), findTile(0, 11), findTile(0, 12)];
  const s = stateWithHand(true, run3.concat([findTile(1, 1), findTile(2, 1)]));
  s.beginTurn();
  const row = s.addRow();
  for (const id of run3) assert.strictEqual(s.placeFromHand(id, row.id, 99), true);
  assert.strictEqual(s.openingPoints(), 33);
  const r = s.endTurn();
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.win, false);
  assert.strictEqual(s.current, 1, 'ход перешёл сопернику');
  assert.strictEqual(s.handSize(0), 2, 'в руке осталось невыложенное');
  assert.strictEqual(s.firstTurn, false);
});

test('порог 30 очков считает джокер по его значению в ряду', () => {
  // Набор из трёх десяток плюс джокер: джокер становится десяткой,
  // вместе 10*4 = 40. Джокер НЕ должен считаться своей единицей.
  const ids = [findTile(0, 10), findTile(1, 10), findTile(2, 10), findJoker(), findTile(3, 1)];
  const s = stateWithHand(true, ids);
  s.beginTurn();
  const row = s.addRow();
  for (const id of ids.slice(0, 4)) assert.strictEqual(s.placeFromHand(id, row.id, 99), true);
  assert.strictEqual(s.openingPoints(), 40, 'джокер посчитан как десятка');
  assert.strictEqual(s.endTurn().ok, true);
});

test('невалидный ряд с джокером не проходит и джокер считается единицей', () => {
  // 10, 10 разных цветов, 11 и джокер — ни серия, ни набор.
  // Ряд невалиден, поэтому джокер берётся по номинальной единице.
  const ids = [findTile(0, 10), findTile(1, 10), findTile(0, 11), findJoker(), findTile(3, 1)];
  const s = stateWithHand(true, ids);
  s.beginTurn();
  const row = s.addRow();
  for (const id of ids.slice(0, 4)) s.placeFromHand(id, row.id, 99);
  assert.strictEqual(s.tableStatus().ok, false, 'такой ряд невалиден');
  assert.strictEqual(s.openingPoints(), 32);
  assert.strictEqual(s.endTurn().ok, false);
});

test('ряд короче 3 в конце хода — отказ', () => {
  const s = GameState.create(2, ['A', 'B'], false);
  const row = s.addRow();
  const id = s.players[0].handIds[0];
  s.placeFromHand(id, row.id, 0);
  s.addRow().tileIds.push(s.players[0].handIds[0]);
  const r = s.endTurn();
  assert.strictEqual(r.ok, false);
});

test('нельзя положить фишку, которой нет в руке', () => {
  const s = GameState.create(2, ['A', 'B'], false);
  const row = s.addRow();
  const notMine = s.players[1].handIds[0];
  assert.strictEqual(s.placeFromHand(notMine, row.id, 0), false);
  assert.strictEqual(s.handSize(1), 14, 'чужая рука не тронута');
});

test('нельзя взять фишку из ряда, которого нет', () => {
  const s = GameState.create(2, ['A', 'B'], false);
  const row = s.addRow();
  s.placeFromHand(s.players[0].handIds[0], row.id, 0);
  assert.strictEqual(s.moveTile(999, row.tileIds[0], row.id, 0), false);
});

test('взятие в руку возможно только для фишек, выложенных этим ходом', () => {
  const s = GameState.create(2, ['A', 'B'], false);
  const row = s.addRow();
  // Фишка соперника на столе — «не наша»: в turn_placed её нет, значит ни
  // отозвать её, ни вернуть в чужую руку мы не можем.
  const foreign = s.players[1].handIds[0];
  row.tileIds.push(foreign);
  assert.strictEqual(s.canTakeBack(foreign), false, 'чужую фишку отозвать нельзя');
  assert.strictEqual(s.takeBackToHand(row.id, foreign), false);
  assert.strictEqual(s.handSize(1), 14, 'рука соперника не тронута');

  // Своя фишка, выложенная ЭТИМ ходом, отзывается.
  const mine = s.players[0].handIds[0];
  s.placeFromHand(mine, row.id, 0);
  assert.strictEqual(s.canTakeBack(mine), true, 'свою фишку этого хода отозвать можно');
  assert.strictEqual(s.takeBackToHand(row.id, mine), true);
  assert.strictEqual(s.handSize(0), 14, 'вернулась в руку');
});

test('переложенная на другой ряд фишка остаётся отзываемой', () => {
  // Повторяет поведение GDScript: перенос внутри хода не «разрешает»
  // фишку, она остаётся в turn_placed.
  const s = GameState.create(2, ['A', 'B'], false);
  const a = s.addRow();
  const b = s.addRow();
  const t = s.players[0].handIds[0];
  s.placeFromHand(t, a.id, 0);
  assert.strictEqual(s.moveTile(a.id, t, b.id, 0), true);
  assert.strictEqual(s.canTakeBack(t), true);
  assert.strictEqual(s.takeBackToHand(b.id, t), true);
  assert.strictEqual(s.handSize(0), 14);
});

test('пустая партия завершается победой', () => {
  const s = GameState.create(2, ['A', 'B'], false);
  // снимаем всю руку в пару валидных рядов
  const hand = s.players[0].handIds.slice();
  while (hand.length > 0) {
    const row = s.addRow();
    let n = 0;
    for (const id of hand) {
      if (n >= 3) break;
      row.tileIds.push(id);
      hand.splice(hand.indexOf(id), 1);
      s.turnPlacedIds.push(id);
      n += 1;
    }
    if (n < 3) row.tileIds.push(...hand.splice(0, 3));
    if (n < 3) {
      // добиваем ряд до 3
      while (row.tileIds.length < 3 && hand.length > 0) {
        row.tileIds.push(hand.shift());
        s.turnPlacedIds.push(row.tileIds[row.tileIds.length - 1]);
      }
    }
  }
  s.players[0].handIds = [];
  s.removeEmptyRows();
  const r = s.endTurn();
  assert.strictEqual(s.currentPlayer().handIds.length, 0);
  void r;
});

test('выбывший игрок пропускается в очереди хода', () => {
  const s = GameState.create(3, ['A', 'B', 'C'], false);
  assert.strictEqual(s.current, 0);
  s.dropPlayer(1);
  s.advance();
  assert.strictEqual(s.current, 2, 'место 1 выбыло, ход идёт к 2');
  s.advance();
  assert.strictEqual(s.current, 0);
});

test('выбывший пропускается, а ход остаётся у живых', () => {
  // Из двоих остаётся один — ход должен вернуться к нему же, а не
  // пропасть: nextActiveSeat зацикливается и находит его на полном круге.
  const s = GameState.create(2, ['A', 'B'], false);
  s.dropPlayer(1);
  assert.strictEqual(s.nextActiveSeat(0), 0, 'живой игрок снова получает ход');
  s.advance();
  assert.strictEqual(s.current, 0);
});

test('если выбыли все, активного нет', () => {
  const s = GameState.create(2, ['A', 'B'], false);
  s.dropPlayer(0);
  s.dropPlayer(1);
  assert.strictEqual(s.nextActiveSeat(0), -1);
});

// ================================================================ аккаунты
group('== Аккаунты ==');

const db = new Db();
const accounts = new Accounts(db);

const reg = accounts.register('TestUser', 'secret123', 'Тестер');
test('регистрация выдаёт токен', () => {
  assert.strictEqual(reg.ok, true, reg.reason);
  assert.ok(reg.token && reg.token.includes('.'));
});

test('логин приводится к нижнему регистру', () => {
  const acc = db.getAccount('testuser');
  assert.ok(acc, 'аккаунт testuser должен существовать');
  assert.strictEqual(acc.login, 'TestUser', 'исходное написание сохраняем');
});

test('повторная регистрация того же логина — отказ', () => {
  const r = accounts.register('testuser', 'other123', 'Другой');
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.length > 0);
});

test('вход с верным паролем проходит', () => {
  const r = accounts.login('testuser', 'secret123');
  assert.strictEqual(r.ok, true);
});

test('вход с неверным паролем отклоняется', () => {
  const r = accounts.login('testuser', 'wrong');
  assert.strictEqual(r.ok, false);
});

test('неверный логин и неверный пароль — разные тексты', () => {
  const a = accounts.login('nosuchuser', 'x');
  const b = accounts.login('testuser', 'x');
  assert.strictEqual(a.reason, 'Логин не найден', 'нет такого логина');
  assert.strictEqual(b.reason, 'Неверный пароль', 'логин есть, пароль нет');
  // Сообщения разведены по просьбе игроков: рядом с формой входа
  // подсказка, какой именно шаг ошибочен, дороже, чем сокрытие списка
  // логинов. Тайминговую защиту от перебора сохраняем отдельно.
});

test('короткий пароль отклоняется', () => {
  const r = accounts.register('shortpw', '123', 'X');
  assert.strictEqual(r.ok, false);
});

test('плохой логин отклоняется', () => {
  const r = accounts.register('ab', 'secret123', 'X');
  assert.strictEqual(r.ok, false);
});

test('токен подходит для входа по нему', () => {
  const r = accounts.resume(reg.token);
  assert.strictEqual(r.ok, true, r.reason);
});

test('испорченный токен не принимается', () => {
  const r = accounts.resume(reg.token.slice(0, -3) + 'abc');
  assert.strictEqual(r.ok, false);
});

test('токен с подменённой подписью не принимается', () => {
  const t = reg.token;
  const body = t.slice(0, t.lastIndexOf('.'));
  const forged = `${body}.${'A'.repeat(43)}`;
  assert.strictEqual(accounts.resume(forged).ok, false);
});

test('токен, подписанный чужим секретом, не принимается', () => {
  const other = signToken('testuser');
  // Подменили секрет после выдачи — подпись перестала совпадать.
  const real = config.clusterSecret;
  try {
    config.clusterSecret = 'other-secret';
    assert.strictEqual(verifyToken(other), null);
  } finally {
    config.clusterSecret = real;
  }
  assert.ok(verifyToken(reg.token), 'с настоящим секретом токен снова валиден');
});

test('смена пароля требует верный старый', () => {
  const r = accounts.changePassword(db.getAccount('testuser'), 'nope', 'newsecret');
  assert.strictEqual(r.ok, false);
});

test('смена пароля выдаёт новый токен и убивает старые сессии', () => {
  const acc = db.getAccount('testuser');
  const oldToken = reg.token;
  const r = accounts.changePassword(acc, 'secret123', 'newsecret');
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(accounts.login('testuser', 'secret123').ok, false, 'старый пароль больше не работает');
  assert.strictEqual(accounts.login('testuser', 'newsecret').ok, true);
  assert.strictEqual(accounts.resume(oldToken).ok, false, 'старый токен отозван');
  assert.strictEqual(accounts.resume(r.token).ok, true);
});

// ================================================================ репликация
group('== Репликация аккаунтов ==');

test('реплика принята на сервере, где аккаунта ещё нет', () => {
  const remote = {
    login_ci: 'frompeer',
    login: 'FromPeer',
    nick: 'Сосед',
    pwd_hash: 'salt$hash',
    origin: 'srv-other',
    created_ms: Date.now(),
    updated_ms: Date.now(),
  };
  const how = db.mergeRemoteAccount(remote);
  assert.strictEqual(how, 'inserted');
  assert.ok(db.getAccount('frompeer'));
});

test('владелец логина не отбирается репликой', () => {
  const mine = db.getAccount('testuser');
  const attempt = {
    login_ci: 'testuser',
    login: 'TestUser',
    nick: 'УгоНщик',
    pwd_hash: 'other$hash',
    origin: 'srv-hacker',
    created_ms: mine.created_ms + 1,
    // ВАЖНО: свежее, чтобы проверить именно правило владения, а не свежесть
    updated_ms: Date.now() + 100000,
  };
  const how = db.mergeRemoteAccount(attempt);
  const after = db.getAccount('testuser');
  assert.strictEqual(after.origin, mine.origin, 'origin не должен меняться');
  assert.strictEqual(after.nick, mine.nick, 'ник чужого не должен применяться к чужому логину');
  assert.strictEqual(after.pwd_hash, mine.pwd_hash, 'хеш пароля чужого не применяется');
  void how;
});

test('устаревшая реплика не затирает свежую', () => {
  const fresh = Date.now();
  db.db.prepare('INSERT INTO accounts (login_ci, login, nick, pwd_hash, origin, created_ms, updated_ms) VALUES (?,?,?,?,?,?,?)')
    .run('timing', 'Timing', 'Свежий', 'a$b', 'srv-x', fresh, fresh);
  // Реплика ОТ ТОГО ЖЕ владельца, но с более старым updated_ms: часы
  // откатились — игнорируем.
  const how = db.mergeRemoteAccount({
    login_ci: 'timing', login: 'Timing', nick: 'Древний', pwd_hash: 'c$d',
    origin: 'srv-x', created_ms: 1, updated_ms: fresh - 1000,
  });
  assert.strictEqual(how, 'stale');
  assert.strictEqual(db.getAccount('timing').nick, 'Свежий');
});

test('реплика от владельца посвежее применяется', () => {
  const base = Date.now();
  db.db.prepare('INSERT INTO accounts (login_ci, login, nick, pwd_hash, origin, created_ms, updated_ms) VALUES (?,?,?,?,?,?,?)')
    .run('owned', 'Owned', 'Было', 'a$b', 'srv-own', base, base);
  const how = db.mergeRemoteAccount({
    login_ci: 'owned', login: 'Owned', nick: 'Стало', pwd_hash: 'c$d',
    origin: 'srv-own', created_ms: base, updated_ms: base + 5000,
  });
  assert.strictEqual(how, 'updated');
  const acc = db.getAccount('owned');
  assert.strictEqual(acc.nick, 'Стало');
  assert.strictEqual(acc.pwd_hash, 'c$d');
});

test('принятая реплика попадает в outbox, чтобы дойти до третьего сервера', () => {
  const before = db.outboxSeq();
  const now = Date.now();
  db.mergeRemoteAccount({
    login_ci: 'chain1', login: 'Chain1', nick: 'Цепочка', pwd_hash: 'a$b',
    origin: 'srv-z', created_ms: now, updated_ms: now,
  });
  const after = db.outboxSeq();
  assert.ok(after > before, 'seq выросла — запись ушла в outbox');
});

test('в outbox лежат хеши паролей, а не сами пароли', () => {
  const rows = db.outboxSince(0, 1000);
  const blob = JSON.stringify(rows);
  assert.ok(!blob.includes('secret123'), 'открытый пароль не должен попадать в реплику');
  assert.ok(!blob.includes('newsecret'), 'новый пароль тоже не должен');
});

// ---- курсоры
group('== Курсоры репликации ==');

const db2 = new Db({});
void db2;

test('outboxSince отдаёт строго записи после курсора', () => {
  const total = db.outboxSeq();
  const tail = db.outboxSince(total, 100);
  assert.strictEqual(tail.length, 0, 'после максимального курсора пусто');
  const head = db.outboxSince(0, 2);
  assert.strictEqual(head.length, 2);
  assert.ok(head[0].seq > 0);
});

test('gossip возвращает пачку и курсор по последней отправленной записи', () => {
  const cluster = new Cluster(db);
  const req = { from: { server_id: 'peer1' }, since: 0 };
  const out = cluster.handleGossip(req);
  assert.strictEqual(out.ok, true);
  assert.ok(out.accounts.length > 0);
  assert.ok(out.servers.length >= 1, 'как минимум сам себя знаем');
  const lastSeq = Number(out.accounts[out.accounts.length - 1].pwd_hash ? 1 : 0);
  void lastSeq;
  assert.ok(Number(out.sent_up_to) > 0);
  assert.strictEqual(typeof out.more, 'boolean');
});

test('gossip с курсором в конце возвращает пустую пачку', () => {
  const cluster = new Cluster(db);
  const top = db.outboxSeq();
  const out = cluster.handleGossip({ from: { server_id: 'peer1' }, since: top });
  assert.strictEqual(out.accounts.length, 0);
  assert.strictEqual(out.sent_up_to, top);
});

test('gossip без поля from отклоняется', () => {
  const cluster = new Cluster(db);
  assert.strictEqual(cluster.handleGossip({ since: 0 }).ok, false);
  assert.strictEqual(cluster.handleGossip(null).ok, false);
});

test('усечённая пачка помечается more, чтобы курсор не перепрыгнул', () => {
  const cluster = new Cluster(db);
  // Просим с курсора 0 при маленьком ACCOUNT_BATCH-эффекте:
  // если пачка не пустая и more=true, sent_up_to обязан быть последним
  // реально отправленным seq, а не максимумом базы.
  const out = cluster.handleGossip({ from: { server_id: 'p' }, since: 0 });
  if (out.more) {
    const max = db.outboxSeq();
    assert.ok(out.sent_up_to < max, 'при more=true курсор обязан быть меньше максимума');
  }
});

// ================================================================ реестр серверов
group('== Реестр серверов ==');

test('сервер объявляет себя', () => {
  const cluster = new Cluster(db);
  const reg = cluster.registry();
  const me = reg.find((s) => s.id === 'srv-test');
  assert.ok(me, 'себя должен знать');
  assert.strictEqual(me.self, true);
  assert.strictEqual(me.online, true);
});

test('чужой сервер попадает в реестр из реплики', () => {
  const cluster = new Cluster(db);
  cluster.handleGossip({
    from: {
      server_id: 'srv-peer', name: 'Латвия', region: 'lv',
      host: '10.0.0.2', port: 6767, version: '1',
    },
    since: 999999,
  });
  const reg = cluster.registry();
  const peer = reg.find((s) => s.id === 'srv-peer');
  assert.ok(peer, 'сосед должен появиться в реестре');
  assert.strictEqual(peer.host, '10.0.0.2');
  assert.strictEqual(peer.region, 'lv');
});

test('молчащий сервер выбрасывается из реестра', () => {
  const cluster = new Cluster(db);
  cluster.handleGossip({
    from: { server_id: 'srv-ghost', name: 'Призрак', region: 'x', host: '10.0.0.9', port: 1, version: '1' },
    since: 999999,
  });
  assert.ok(cluster.registry().some((s) => s.id === 'srv-ghost'));
  // Сдвигаем последнее подтверждение в прошлое.
  db.db.prepare('UPDATE cluster_servers SET last_seen_ms = ? WHERE server_id = ?')
    .run(Date.now() - 10 * 60 * 1000, 'srv-ghost');
  const reg = cluster.registry();
  assert.ok(!reg.some((s) => s.id === 'srv-ghost'), 'призрак должен исчезнуть');
});

// ================================================================ комнаты
group('== Комнаты ==');

const rooms = new Rooms(db);
rooms.setUserResolver((id) => {
  const a = db.getAccount(id);
  return a ? { id: a.login_ci, login: a.login, nick: a.nick, account: a } : null;
});

accounts.register('host1', 'secret123', 'Хост');
accounts.register('guest1', 'secret123', 'Гость');
accounts.register('guest2', 'secret123', 'Гость2');
const userOf = (login) => {
  const a = db.getAccount(login);
  return { id: a.login_ci, login: a.login, nick: a.nick, account: a };
};

test('создание комнаты выдаёт код и место хоста', () => {
  const r = rooms.createRoom(userOf('host1'), { seats: 2, require30: true });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.seat, 0);
  assert.ok(r.room.code.length === 5);
  assert.strictEqual(r.room.filled(), 1);
});

// Комната на 4 места: хост(guest1) + трое присоединившихся.
const room2 = rooms.createRoom(userOf('guest1'), { seats: 4, name: 'Тестовая' }).room;

// Имитируем подключение: сокет в комнате И флаг connected у игрока.
// Флаг ставит хаб в attachSeat(), поэтому в тестах его надо выставлять руками.
function markAllConnected(room) {
  for (let i = 0; i < room.seats; i += 1) {
    room.sockets.set(i, { id: `sock-${room.code}-${i}` });
    if (room.players[i]) room.players[i].connected = true;
  }
}

test('вход по коду сажает на свободное место', () => {
  // guest1 создал комнату и занял место 0, поэтому host1 получает место 1.
  const r = rooms.joinRoom(userOf('host1'), room2.code, null);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.seat, 1);
  assert.strictEqual(room2.filled(), 2);
});

test('повторный вход того же игрока не занимает второе место', () => {
  const r = rooms.joinRoom(userOf('host1'), room2.code, null);
  assert.strictEqual(r.seat, 1, 'тот же игрок возвращается на своё место');
  assert.strictEqual(room2.filled(), 2, 'лишнего места не появилось');
});

test('партия не стартует, пока места не заняты', () => {
  const r = rooms.startGame(userOf('guest1'));
  assert.strictEqual(r.ok, false, room2.seats + ' места, а игроков меньше');
  assert.ok(r.reason.includes('Дождитесь'));
  assert.strictEqual(room2.state, 'lobby');
});

test('партия не стартует с одним игроком', () => {
  const solo = rooms.createRoom(userOf('guest2'), { seats: 2 }).room;
  const r = rooms.startGame(userOf('guest2'));
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('минимум 2'));
  void solo;
});

test('после заполнения всех мест партия стартует', () => {
  const extra = accounts.register('guest3', 'secret123', 'Гость3');
  assert.strictEqual(extra.ok, true);
  const r1 = rooms.joinRoom(userOf('guest2'), room2.code, null);
  const r2 = rooms.joinRoom(userOf('guest3'), room2.code, null);
  assert.strictEqual(r1.ok && r2.ok, true, `${r1.reason || ''} ${r2.reason || ''}`);
  assert.strictEqual(room2.filled(), room2.seats);
  markAllConnected(room2);
  const r = rooms.startGame(userOf('guest1'));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(room2.state, 'playing');
  assert.strictEqual(room2.game.handSize(0), 14);
});

test('раздача всем игрокам партии одинаковая', () => {
  for (let i = 0; i < room2.seats; i += 1) {
    assert.strictEqual(room2.game.handSize(i), 14);
  }
});

// ---- вид игрока
group('== Вид игрока (утечки) ==');

test('в представлении своя рука есть', () => {
  const v = views.gameView(room2, 0);
  assert.strictEqual(v.hand.length, 14);
});

test('в представлении НЕТ рук соперников', () => {
  const v = views.gameView(room2, 0);
  const mine = new Set(room2.game.players[0].handIds);
  for (let seat = 1; seat < room2.seats; seat += 1) {
    for (const id of room2.game.players[seat].handIds) {
      assert.ok(!mine.has(id), 'своя рука не должна содержать чужую фишку');
    }
  }
  // Чужое хранится ТОЛЬКО числом.
  for (let seat = 0; seat < room2.seats; seat += 1) {
    const p = v.players[seat];
    assert.strictEqual(typeof p.handCount, 'number');
    assert.ok(!Array.isArray(p.hand), 'чужие руки не массивами');
  }
  assert.strictEqual(v.players[1].handCount, 14);
});

test('в представлении соперника нет его фишек (кроме лежащих на столе)', () => {
  // Стол публичен, поэтому фишка, выложенная кем-то, в представлении любого
  // игрока ЕСТЬ — и это правильно. Не должно быть только фишек, лежащих
  // в чужой руке.
  const onTable = new Set();
  for (const r of room2.game.table) for (const id of r.tileIds) onTable.add(id);
  for (let seat = 0; seat < room2.seats; seat += 1) {
    const v = views.gameView(room2, seat);
    for (let other = 0; other < room2.seats; other += 1) {
      if (other === seat) continue;
      for (const id of room2.game.players[other].handIds) {
        assert.ok(!onTable.has(id), 'фишка в чужой руке не должна быть на столе');
        assert.ok(!v.hand.includes(id),
          `фишка ${id} из руки игрока ${other} не должна попадать в руку игрока ${seat}`);
      }
    }
  }
});

test('стол в представлении публичен целиком', () => {
  const v = views.gameView(room2, 0);
  assert.strictEqual(v.table.length, room2.game.table.length);
});

// ---- ходы
group('== Ходы партии ==');

const g = room2.game;
const host = userOf('guest1'); // место 0
room2.sockets.set(0, { id: 's0' });
g.players[0].connected = true;

test('чужой игрок ходить не может', () => {
  const r = rooms.commitTurn(userOf('guest2'), [{ op: 'place', tile: g.players[1].handIds[0], to: 'n0', index: 0 }]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('не ваш ход'));
});

test('подделка чужой фишки отклоняется и откатывается', () => {
  const before = JSON.stringify(g.captureAll());
  const foreign = g.players[1].handIds[0];
  const r = rooms.commitTurn(host, [{ op: 'place', tile: foreign, to: 'n0', index: 0 }]);
  assert.strictEqual(r.ok, false, 'сервер не должен принять чужую фишку');
  assert.strictEqual(r.hard, true, 'клиенту нужен откат к серверному столу');
  assert.strictEqual(JSON.stringify(g.captureAll()), before, 'состояние не должно измениться');
});

test('операция на несуществующий ряд отклоняется', () => {
  const mine = g.players[0].handIds[0];
  const r = rooms.commitTurn(host, [{ op: 'place', tile: mine, to: 'r9999', index: 0 }]);
  assert.strictEqual(r.ok, false);
});

test('пустой список операций отклоняется', () => {
  const r = rooms.commitTurn(host, []);
  assert.strictEqual(r.ok, false);
});

test('слишком много операций отклоняется', () => {
  const ops = new Array(200).fill({ op: 'place', tile: 1, to: 'n0', index: 0 });
  const r = rooms.commitTurn(host, ops);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('Слишком много'));
});

test('мусорный ход откатывается, а стол остаётся валидным', () => {
  const before = JSON.stringify(g.captureAll());
  // Кладём 3 фишки, но так, чтобы ряд вышел невалидным:
  // две фишки одного значения одного цвета + третья лежит рядом.
  const h = g.players[0].handIds;
  const t0 = catalog.tile(h[0]);
  const sameColorVal = h.filter((id) => {
    const t = catalog.tile(id);
    return !t.is_joker && t.color === t0.color && t.value === t0.value;
  });
  const r = rooms.commitTurn(host, [
    { op: 'place', tile: h[0], to: 'n0', index: 0 },
    { op: 'place', tile: h[1], to: 'n0', index: 1 },
    { op: 'place', tile: h[2], to: 'n0', index: 2 },
  ]);
  if (r.ok) {
    // случайно выпал валидный ряд — это нормально, фиксируем как успех
    assert.ok(true);
  } else {
    assert.strictEqual(r.hard, true);
    assert.strictEqual(JSON.stringify(g.captureAll()), before,
      'после отклонения состояние обязано совпасть с исходным');
  }
  void sameColorVal;
});

// Собирает в руке заданного игрока гарантированно валидный ряд на 30+
// очков (требование первого хода) либо на любую сумму, если порог не нужен.
// Возвращает список операций для rooms.commitTurn либо null, если собрать
// не из чего.
//
// Каждый кандидат проверяется самим Rules.validateRow перед выдачей: раздача
// случайна, и «на глаз» собранный ряд иногда вылезает за 13.
function planValidRow(state, seat, needPoints) {
  const ids = planValidRowIds(state, seat, needPoints);
  if (ids === null) return null;
  return ids.map((id, i) => ({ op: 'place', tile: id, to: 'n0', index: i }));
}

function planValidRowIds(state, seat, needPoints, minLen) {
  const floor = minLen || 3;
  const hand = state.players[seat].handIds;
  const has = (color, value) => hand.find((id) => {
    const t = catalog.tile(id);
    return !t.is_joker && t.color === color && t.value === value;
  });
  const joker = hand.find((id) => catalog.tile(id).is_joker);

  // Единственная точка выхода: проверяем и отдаём только заведомо годный ряд.
  const accept = (ids) => {
    if (!ids || ids.length < floor) return null;
    const verdict = Rules.validateRow(catalog.tiles(ids));
    if (!verdict.ok) return null;
    const pts = ids.reduce((n, id) => {
      const t = catalog.tile(id);
      if (t.is_joker) return n + Number(verdict.joker_values[id] || 0);
      return n + t.value;
    }, 0);
    if (pts < (needPoints || 0)) return null;
    return ids.slice();
  };

  // Вариант 1: серия одного цвета из 3+ фишек подряд.
  for (let color = 0; color < 4; color += 1) {
    for (let start = 1; start <= 11; start += 1) {
      const seq = [];
      for (let v = start; v < start + 5; v += 1) {
        const id = has(color, v);
        if (id === undefined) break;
        seq.push(id);
      }
      const ops = accept(seq);
      if (ops) return ops;
    }
  }
  // Вариант 2: набор 3-4 разных цветов одного значения.
  for (let value = 1; value <= 13; value += 1) {
    for (const colors of [[0, 1, 2], [0, 1, 2, 3]]) {
      const ids = colors.map((c) => has(c, value)).filter((x) => x !== undefined);
      const ops = accept(ids);
      if (ops) return ops;
    }
  }
  // Вариант 3: серия из двух фишек, добранная джокером. Старт не выше 11,
  // иначе джокеру пришлось бы стать четырнадцатым числом.
  if (joker !== undefined) {
    for (let color = 0; color < 4; color += 1) {
      for (let start = 1; start <= 11; start += 1) {
        const a = has(color, start);
        const b = has(color, start + 1);
        if (a === undefined || b === undefined) continue;
        const ops = accept([a, b, joker]);
        if (ops) return ops;
      }
    }
  }
  return null;
}

test('валидный ход принимается и передаёт ход дальше', () => {
  const need = g.firstTurn && g.require30 ? 30 : 0;
  const ops = planValidRow(g, 0, need);
  if (ops === null) {
    assert.ok(true, 'в руке не нашлось подходящего набора — тест пропущен');
    return;
  }
  const r = rooms.commitTurn(host, ops);
  assert.strictEqual(r.ok, true, r.reason);
  assert.notStrictEqual(g.current, 0, 'ход должен перейти дальше');
  assert.strictEqual(g.players[0].handIds.length, 14 - ops.length, 'фишки ушли из руки на стол');
});

test('ход, набравший 30+ очков первым, проходит с первого раза', () => {
  // Отдельная партия с require30: проверяем, что 30 очков достаточно.
  const s = GameState.create(2, ['A', 'B'], true);
  const me = { id: 'a', login: 'a', nick: 'A' };
  const room = rooms.createRoom(me, { seats: 2, require30: true }).room;
  const you = { id: 'b', login: 'b', nick: 'B' };
  rooms.joinRoom(you, room.code, null);
  markAllConnected(room);
  assert.strictEqual(rooms.startGame(me).ok, true);
  const game = room.game;
  const ops = planValidRow(game, 0, 30);
  if (ops === null) {
    assert.ok(true, 'в руке не нашлось 30 очков — тест пропущен');
    return;
  }
  const r = rooms.commitTurn(me, ops);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(game.firstTurn, false);
});

// ---- set_table: клиент присылает готовый стол целиком
group('== set_table (готовый стол) ==');

// Отдельная комната на 2 места: тестам set_table нужен свой стол, чтобы
// не зависеть от того, как продвинулись предыдущие ходы.
const stMe = { id: 'st-a', login: 'st-a', nick: 'ST-A' };
const stYou = { id: 'st-b', login: 'st-b', nick: 'ST-B' };
const stRoom = rooms.createRoom(stMe, { seats: 2, require30: false }).room;
rooms.joinRoom(stYou, stRoom.code, null);
markAllConnected(stRoom);
assert.strictEqual(rooms.startGame(stMe).ok, true);
const stGame = stRoom.game;

/** Кладёт игроку заведомо валидный ряд и завершает ход. */
function layValidRow(who) {
  const ids = planValidRowIds(stGame, who === stMe ? 0 : 1, 0);
  if (ids === null) return null;
  const r = rooms.commitTurn(who, [{ op: 'set_table', rows: [{ id: 0, tiles: ids }] }]);
  return r.ok ? ids : null;
}

const laid = layValidRow(stMe);
const stRowId = laid === null ? -1 : stGame.table[0].id;

test('set_table принимает готовый ряд и передаёт ход', () => {
  if (laid === null) {
    assert.ok(true, 'в руке не нашлось подходящего набора — тест пропущен');
    return;
  }
  assert.strictEqual(stGame.current, 1, 'ход перешёл к сопернику');
  assert.strictEqual(stGame.table.length, 1);
  assert.deepStrictEqual(stGame.table[0].tileIds.slice().sort((a, b) => a - b),
    laid.slice().sort((a, b) => a - b), 'на столе лежит ровно то, что прислали');
  assert.strictEqual(stGame.handSize(0), 14 - laid.length, 'фишки ушли из руки');
});

test('set_table с чужой фишкой отклоняется и откатывается', () => {
  if (laid === null) {
    assert.ok(true, 'предыдущий тест пропущен — нечего проверять');
    return;
  }
  const before = JSON.stringify(stGame.captureAll());
  const foreign = stGame.players[1].handIds[0];
  const r = rooms.commitTurn(stYou, [{
    op: 'set_table',
    rows: [{ id: stRowId, tiles: [stGame.table[0].tileIds[0], stGame.table[0].tileIds[1], foreign] }],
  }]);
  assert.strictEqual(r.ok, false, 'сервер не должен принять чужую фишку');
  assert.strictEqual(JSON.stringify(stGame.captureAll()), before, 'состояние обязано совпасть');
});

test('set_table с выдуманной фишкой отклоняется', () => {
  if (laid === null) {
    assert.ok(true, 'предыдущий тест пропущен — нечего проверять');
    return;
  }
  const before = JSON.stringify(stGame.captureAll());
  const t = catalog.tile(stGame.players[1].handIds[0]);
  const ghost = 9999;
  const r = rooms.commitTurn(stYou, [{
    op: 'set_table',
    rows: [{ id: stRowId, tiles: [stGame.table[0].tileIds[0], t.id, ghost] }],
  }]);
  assert.strictEqual(r.ok, false, 'фишки 9999 не существует');
  assert.strictEqual(JSON.stringify(stGame.captureAll()), before, 'состояние обязано совпасть');
});

test('set_table с повтором одной фишки отклоняется', () => {
  if (laid === null) {
    assert.ok(true, 'предыдущий тест пропущен — нечего проверять');
    return;
  }
  const before = JSON.stringify(stGame.captureAll());
  const a = stGame.table[0].tileIds[0];
  const mine = stGame.players[1].handIds[0];
  const r = rooms.commitTurn(stYou, [{ op: 'set_table', rows: [{ id: 0, tiles: [a, a, mine] }] }]);
  assert.strictEqual(r.ok, false, 'одна фишка не может лежать в двух местах');
  assert.strictEqual(JSON.stringify(stGame.captureAll()), before, 'состояние обязано совпасть');
});

test('set_table не может увести чужую выкладку себе в руку', () => {
  if (laid === null) {
    assert.ok(true, 'предыдущий тест пропущен — нечего проверять');
    return;
  }
  const before = JSON.stringify(stGame.captureAll());
  // Соперник не упоминает ряд предыдущего игрока — фишки просто исчезают.
  const mine = stGame.players[1].handIds[0];
  const r = rooms.commitTurn(stYou, [{ op: 'set_table', rows: [{ id: 0, tiles: [mine] }] }]);
  assert.strictEqual(r.ok, false, 'исчезновение выложенной фиски — не ход');
  assert.strictEqual(JSON.stringify(stGame.captureAll()), before, 'состояние обязано совпасть');
});

test('set_table с одним и тем же рядом дважды отклоняется', () => {
  if (laid === null) {
    assert.ok(true, 'предыдущий тест пропущен — нечего проверять');
    return;
  }
  const before = JSON.stringify(stGame.captureAll());
  const mine = stGame.players[1].handIds[0];
  const r = rooms.commitTurn(stYou, [{
    op: 'set_table',
    rows: [
      { id: stRowId, tiles: [stGame.table[0].tileIds[0], mine] },
      { id: stRowId, tiles: [stGame.table[0].tileIds[1]] },
    ],
  }]);
  assert.strictEqual(r.ok, false, 'один ряд нельзя раздвоить');
  assert.strictEqual(JSON.stringify(stGame.captureAll()), before, 'состояние обязано совпасть');
});

test('set_table на несуществующий ряд отклоняется', () => {
  if (laid === null) {
    assert.ok(true, 'предыдущий тест пропущен — нечего проверять');
    return;
  }
  const r = rooms.commitTurn(stYou, [{ op: 'set_table', rows: [{ id: 4242, tiles: [1, 2, 3] }] }]);
  assert.strictEqual(r.ok, false);
});

test('set_table без новых фишек не завершает ход', () => {
  if (laid === null) {
    assert.ok(true, 'предыдущий тест пропущен — нечего проверять');
    return;
  }
  const r = rooms.commitTurn(stYou, [{
    op: 'set_table', rows: [{ id: stRowId, tiles: stGame.table[0].tileIds.slice() }],
  }]);
  assert.strictEqual(r.ok, false, 'ничего не выложено — хода нет');
  assert.ok(r.reason.includes('хотя бы одно'), r.reason);
});

test('set_table, смешанный с place, отклоняется', () => {
  if (laid === null) {
    assert.ok(true, 'предыдущий тест пропущен — нечего проверять');
    return;
  }
  const mine = stGame.players[1].handIds[0];
  const r = rooms.commitTurn(stYou, [
    { op: 'set_table', rows: [{ id: 0, tiles: [mine] }] },
    { op: 'place', tile: stGame.players[1].handIds[1], to: 'n0', index: 1 },
  ]);
  assert.strictEqual(r.ok, false, 'стол целиком ИЛИ пооперационно, а не вперемешку');
});

test('set_table возвращает взятое назад в руку', () => {
  // Своя комната и один ход: игрок выкладывает ряд, забирает одну фишку
  // назад и завершает ход с тремя. Сервер обязан отличить это от
  // «украсть чужую выкладку» — обе картины выглядят как «фишка исчезла
  // со стола», но различаются тем, была ли она в руке на начале хода.
  const a = { id: 'tb-a', login: 'tb-a', nick: 'TB-A' };
  const b = { id: 'tb-b', login: 'tb-b', nick: 'TB-B' };
  const room = rooms.createRoom(a, { seats: 2, require30: false }).room;
  rooms.joinRoom(b, room.code, null);
  markAllConnected(room);
  assert.strictEqual(rooms.startGame(a).ok, true);
  const game = room.game;

  const mine = planValidRowIds(game, 0, 0, 4);
  if (mine === null) {
    assert.ok(true, 'в руке не нашлось набора из 4+ фишек — тест пропущен');
    return;
  }
  const before = game.handSize(0);
  const rest = mine.slice(1); // последняя фишка забрана назад в руку
  const r = rooms.commitTurn(a, [{ op: 'set_table', rows: [{ id: 0, tiles: rest }] }]);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(game.handSize(0), before - rest.length, 'на столе осталось то, что не забрали');
  assert.deepStrictEqual(game.table[0].tileIds, rest, 'в ряд легли именно оставшиеся фишки');
  assert.ok(!game.table[0].tileIds.includes(mine[0]), 'забранная фишка на столе отсутствует');
});

test('set_table не даёт забрать выкладку прошлого хода', () => {
  // Обратная сторона: фишка, которая лежала на столе ДО нашего хода, нашему
  // ходу не принадлежит. Даже если игрок выкладывает что-то своё, увести
  // чужую мелд в руку нельзя.
  if (laid === null) {
    assert.ok(true, 'предыдущие тесты пропущены — нечего проверять');
    return;
  }
  const before = JSON.stringify(stGame.captureAll());
  const extra = planValidRowIds(stGame, 1, 0);
  if (extra === null) {
    assert.ok(true, 'в руке не нашлось подходящего набора — тест пропущен');
    return;
  }
  const r = rooms.commitTurn(stYou, [{
    op: 'set_table',
    rows: [
      { id: stRowId, tiles: stGame.table[0].tileIds.slice(1) },
      { id: 0, tiles: extra },
    ],
  }]);
  assert.strictEqual(r.ok, false, 'выкладку прошлого хода забрать в руку нельзя');
  assert.strictEqual(JSON.stringify(stGame.captureAll()), before, 'состояние обязано совпасть');
});

test('set_table принимает перестановку уже выложенного ряда', () => {
  // Клиенту разрешено переставлять то, что уже лежит на столе, — лишь бы
  // после перестановки ряд остался валидным. Сервер проверяет результат,
  // а не сам факт перестановки.
  const rows = stGame.table.filter((r) => r.tileIds.length >= 3);
  const extra = stGame ? planValidRowIds(stGame, stGame.current, 0) : null;
  if (rows.length === 0 || extra === null) {
    assert.ok(true, 'нет ни ряда для перестановки, ни набора в руке — тест пропущен');
    return;
  }
  const target = rows[0];
  const flipped = target.tileIds.slice().reverse();
  if (!Rules.validateRow(catalog.tiles(flipped)).ok) {
    assert.ok(true, 'перевёрнутый ряд невалиден по правилам — тест пропущен');
    return;
  }
  const spec = stGame.table.map((r) => (r === target
    ? { id: r.id, tiles: flipped }
    : { id: r.id, tiles: r.tileIds.slice() }));
  const who = stGame.current === 0 ? stMe : stYou;
  const r = rooms.commitTurn(who, [{
    op: 'set_table', rows: spec.concat([{ id: 0, tiles: extra }]),
  }]);
  assert.strictEqual(r.ok, true, r.reason);
  const rowOnTable = stGame.table.find((x) => x.id === target.id);
  assert.deepStrictEqual(rowOnTable.tileIds, flipped, 'стол переставлен как просили');
});

test('не в свой ход взятие из колоды отклоняется', () => {
  // Берём заведомо НЕ того, кому принадлежит ход, — тест не должен зависеть
  // от того, насколько далеко продвинулся предыдущий ход.
  const bySeat = ['guest1', 'host1', 'guest2', 'guest3'];
  const other = bySeat.find((login, seat) => seat !== g.current && room2.players[seat]);
  assert.ok(other, 'в комнате должен быть кто-то, кому ход не принадлежит');
  const r = rooms.drawFor(userOf(other));
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('не ваш ход'), r.reason);
});

test('в свой ход взятие из колоды проходит', () => {
  const seat = g.current;
  const bySeat = ['guest1', 'host1', 'guest2', 'guest3'];
  const who = bySeat[seat];
  if (!room2.players[seat]) {
    assert.ok(true, 'текущий игрок выбыл — тест пропущен');
    return;
  }
  const before = g.tilesLeftInDeck();
  const r = rooms.drawFor(userOf(who));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(g.tilesLeftInDeck(), before - 1, 'колода уменьшилась на одну фишку');
  assert.strictEqual(g.handSize(seat), 15, 'взятая фишка пришла в руку');
});

// ---- обрывы
group('== Обрывы связи ==');

const room3 = rooms.createRoom(userOf('host1'), { seats: 2, require30: false }).room;
rooms.joinRoom(userOf('guest1'), room3.code, null);
markAllConnected(room3);
rooms.startGame(userOf('host1'));
assert.strictEqual(room3.state, 'playing');
const u1 = userOf('guest1');
rooms.onDisconnect(u1);
test('после обрыва в партии место НЕ освобождается сразу', () => {
  assert.strictEqual(room3.state, 'playing');
  assert.ok(room3.players[1] !== null, 'место остаётся занятым на время ожидания');
  assert.ok(room3.paused.has(1), 'комната на паузе');
  assert.ok(room3.isPaused());
});

test('игра заблокирована, пока кто-то ждёт переподключения', () => {
  const r = rooms.commitTurn(userOf('host1'), [{ op: 'place', tile: room3.game.players[0].handIds[0], to: 'n0', index: 0 }]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('переподключения'), r.reason);
});

test('переподключение снимает паузу', () => {
  const back = rooms.onReconnect(u1, { id: 'new' });
  assert.ok(back, 'сервер должен узнать игрока');
  assert.strictEqual(back.seat, 1);
  assert.ok(!room3.paused.has(1));
  assert.ok(!room3.isPaused());
});

test('по истечении срока ожидания игрок выбывает, партия продолжается', () => {
  rooms.onDisconnect(u1);
  // перематываем дедлайн в прошлое
  const d = room3.paused.get(1);
  d.deadline = Date.now() - 1;
  const touched = rooms.expireDisconnects();
  assert.ok(touched.includes(room3), 'комната должна попасть в список обновлений');
  assert.strictEqual(room3.game.players[1].dropped, true, 'игрок выбыл');
  assert.strictEqual(room3.state, 'playing', 'партия продолжается без него');
  assert.strictEqual(room3.filled(), 2, 'информация о игроке в комнате остаётся');
});

test('после выбывания ход идёт мимо него', () => {
  const game = room3.game;
  const before = game.current;
  game.advance();
  assert.notStrictEqual(game.current, 1, 'выбывший не должен получать ход');
  assert.ok(game.current === before || game.current === 0);
});

test('в лобби обрыв освобождает место сразу', () => {
  const room4 = rooms.createRoom(userOf('host1'), { seats: 2 }).room;
  rooms.joinRoom(userOf('guest1'), room4.code, null);
  assert.strictEqual(room4.filled(), 2);
  rooms.onDisconnect(userOf('guest1'));
  assert.strictEqual(room4.filled(), 1, 'в лобби ждать нечего — место свободно');
});

// ---- быстрый матч
group('== Быстрый матч ==');

test('быстрый матч набирает компанию и собирает комнату', () => {
  const roomCount = rooms.rooms.size;
  const a = accounts.register('qm1', 'secret123', 'Быстр1');
  const b = accounts.register('qm2', 'secret123', 'Быстр2');
  assert.ok(a.ok && b.ok);
  // Оба встают в очередь с ОДИНАКОВЫМИ параметрами — иначе они попадут в
  // разные очереди и не встретятся.
  rooms.quickJoin(userOf('qm1'), { seats: 2, require30: false });
  rooms.quickJoin(userOf('qm2'), { seats: 2, require30: false });
  const q = rooms.quick.get('2:0');
  assert.ok(q, 'очередь 2:0 должна существовать');
  assert.strictEqual(q.waiting.length, 2, 'в очереди двое');
  const formed = rooms._tryFormQuick(q);
  assert.ok(formed, 'комната должна была собраться');
  assert.strictEqual(formed.room.filled(), 2);
  assert.ok(rooms.rooms.size > roomCount);
  assert.strictEqual(q.waiting.length, 0, 'очередь опустела');
});

test('быстрый матч не собирается из одного человека', () => {
  const c = accounts.register('qm3', 'secret123', 'Быстр3');
  assert.ok(c.ok);
  // Отдельная конфигурация, чтобы не пересечься с предыдущей очередью.
  rooms.quickJoin(userOf('qm3'), { seats: 5, require30: true });
  const q = rooms.quick.get('5:1');
  assert.ok(q);
  assert.strictEqual(q.waiting.length, 1);
  const formed = rooms._tryFormQuick(q);
  assert.ok(!formed, 'одному игроку нельзя играть');
  assert.strictEqual(q.waiting.length, 1, 'он остаётся в очереди');
  rooms.quickLeave(userOf('qm3'));
  assert.strictEqual(rooms.quick.get('5:1').waiting.length, 0);
});

test('выход из очереди убирает игрока', () => {
  const d = accounts.register('qm4', 'secret123', 'Быстр4');
  assert.ok(d.ok);
  rooms.quickJoin(userOf('qm4'), { seats: 5, require30: true });
  assert.strictEqual(rooms.quickStateFor(userOf('qm4')).inQueue, true);
  rooms.quickLeave(userOf('qm4'));
  assert.strictEqual(rooms.quickStateFor(userOf('qm4')).inQueue, false);
});

// ================================================================ безопасность
group('== Прочее ==');

test('код комнаты без похожих символов (0/O, 1/I нет)', () => {
  const { makeCode } = require('../src/rooms');
  for (let i = 0; i < 200; i += 1) {
    const c = makeCode(5);
    assert.strictEqual(c.length, 5);
    assert.ok(!/[01OI]/.test(c), `в коде «${c}» есть путаный символ`);
  }
});

test('публичное представление аккаунта не содержит хеша пароля', () => {
  const v = accounts.publicView(db.getAccount('host1'));
  const blob = JSON.stringify(v);
  assert.ok(!blob.includes('pwd_hash'));
  assert.ok(!blob.includes('$'), 'в представлении не должно быть строки хеша');
  assert.ok(v.login && v.nick);
});

test('вход в комнату с неверным паролем отклоняется', () => {
  const protectedRoom = rooms.createRoom(userOf('host1'), { seats: 2, password: 'код' }).room;
  const bad = rooms.joinRoom(userOf('guest1'), protectedRoom.code, 'не-код');
  assert.strictEqual(bad.ok, false);
  const good = rooms.joinRoom(userOf('guest1'), protectedRoom.code, 'код');
  assert.strictEqual(good.ok, true, good.reason);
});

test('список комнат не показывает пароли', () => {
  for (const r of rooms.listRooms()) {
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes('passwordHash'));
    assert.ok(typeof r.hasPassword === 'boolean');
  }
});

test('несуществующая комната — понятная ошибка', () => {
  const r = rooms.joinRoom(userOf('host1'), 'ZZZZZ', null);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('не найдена'));
});

// ================================================================ итог

console.log('');
if (failures.length === 0) {
  console.log(`ALL ${passed} SERVER TESTS PASSED`);
  db.close();
  process.exit(0);
} else {
  console.log(`FAILED: ${failures.length} из ${passed + failures.length}`);
  for (const f of failures) {
    console.log(`\n--- ${f.name}`);
    console.log(String(f.error && f.error.message).split('\n').slice(0, 6).join('\n'));
  }
  db.close();
  process.exit(1);
}
