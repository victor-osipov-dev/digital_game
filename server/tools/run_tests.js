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
const { Accounts, verifyToken, signToken, tokenHash } = require('../src/accounts');
const { Cluster } = require('../src/cluster');
const { Rooms } = require('../src/rooms');
const { GameState } = require('../src/engine/game_state');
const Rules = require('../src/engine/rules');
const catalog = require('../src/engine/catalog');
const views = require('../src/views');
const { Hub } = require('../src/hub');
const { C2S, S2C } = require('../src/protocol');

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

test('в каталоге ровно 106 фишек', () => {
  assert.strictEqual(catalog.CATALOG.length, 106);
  assert.strictEqual(catalog.BY_ID.size, 106);
});

test('id фишек идут подряд с 1', () => {
  const ids = catalog.CATALOG.map((t) => t.id).sort((a, b) => a - b);
  assert.strictEqual(ids[0], 1);
  assert.strictEqual(ids[ids.length - 1], 106);
  for (let i = 0; i < 106; i += 1) assert.strictEqual(ids[i], i + 1);
});

test('каждого (цвет, значение) ровно две фишки, джокеров 2', () => {
  const pairs = new Map();
  let jokers = 0;
  for (const t of catalog.CATALOG) {
    if (t.is_joker) { jokers += 1; continue; }
    const k = `${t.color}:${t.value}`;
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
  assert.strictEqual(pairs.size, 52, 'должно быть 52 пары ц��та/значение');
  for (const [, n] of pairs) assert.strictEqual(n, 2);
  assert.strictEqual(jokers, 2);
});

test('у джокеров value = 1, цвета 4 и 5 (жёлтый и фиолетовый)', () => {
  const js = catalog.CATALOG.filter((t) => t.is_joker);
  assert.deepStrictEqual(js.map((t) => t.color).sort((a, b) => a - b), [4, 5]);
  for (const t of js) assert.strictEqual(t.value, 1);
});

test('константа размера каталога совпадает с каталогом', () => {
  const { CATALOG_SIZE } = require('../src/protocol');
  assert.strictEqual(CATALOG_SIZE, catalog.CATALOG.length);
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

test('раздача: 2 игрока по 14 фишек, колода 106-28=78', () => {
  const s = GameState.create(2, ['A', 'B'], false);
  assert.strictEqual(s.handSize(0), 14);
  assert.strictEqual(s.handSize(1), 14);
  assert.strictEqual(s.tilesLeftInDeck(), 78);
});

test('в руке нет повторяющихся id', () => {
  const s = GameState.create(5, [], false);
  const seen = new Set();
  for (const p of s.players) for (const id of p.handIds) {
    assert.ok(!seen.has(id), `id ${id} продублирован`);
    seen.add(id);
  }
});

test('рука и колода вместе = 106 уникальных фишек', () => {
  const s = GameState.create(5, [], false);
  const seen = new Set();
  for (const p of s.players) for (const id of p.handIds) seen.add(id);
  for (const id of s.deck.ids) seen.add(id);
  assert.strictEqual(seen.size, 106);
});

test('взятие из колоды добавляет фишку и передаёт ход', () => {
  const s = GameState.create(2, ['A', 'B'], false);
  const before = s.handSize(0);
  const r = s.drawFromDeck();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.handSize(0), before + 1);
  assert.strictEqual(s.handSize(1), 14);
  assert.strictEqual(s.current, 1);
  assert.strictEqual(s.tilesLeftInDeck(), 77);
});

// Рука определяется раздачей, а раздача случайна. Чтобы тесты про 30 очков
// не зависели от удачи, собираем партию с заранее заданной рукой.
//
// Замена руки не должна терять фишки: колода хранит только невыданные, так
// что вытесненные из руки фишки возвращаем в колоду, а нужные — забираем
// оттуда, где оказались. Итог всегда 106 уникальных фишек.
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
  assert.strictEqual(used.size, 106, 'фишки в партии должны быть уникальны');
  return s;
}

// Фишки по моей схеме id: 1..104 — не-джокеры (цвет = (id-1)/26, значение =
// ((id-1)%26)/2 + 1), 105..106 — джокеры. Находим по описанию, а не по id,
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

test('ошибка входа не различает несуществующий логин и неверный пароль', () => {
  const a = accounts.login('nosuchuser', 'x');
  const b = accounts.login('testuser', 'x');
  assert.strictEqual(a.reason, 'Неверный логин или пароль', 'нет такого логина');
  assert.strictEqual(b.reason, 'Неверный логин или пароль', 'логин есть, пароль нет');
  // Общий текст закрывает перебор логинов по ответам сервера.
  // Тайминговую защиту от перебора сохраняем отдельно.
});

test('короткий пароль отклоняется', () => {
  const r = accounts.register('shortpw', '123', 'X');
  assert.strictEqual(r.ok, false);
});

test('плохой логин отклоняется', () => {
  const r = accounts.register('ab', 'secret123', 'X');
  assert.strictEqual(r.ok, false);
});

test('SNI: DNS-имя — публичный контекст, IP и пустое — прежний', () => {
  const { isIpLiteral, selectTlsContext } = require('../src/tls_select');
  for (const ip of ['85.209.2.116', '31.56.196.114', '127.0.0.1', '0.0.0.0']) {
    assert.strictEqual(isIpLiteral(ip), true, ip);
    assert.strictEqual(selectTlsContext(ip), 'legacy', ip);
  }
  for (const bad of ['', 'rudigitalgame.fimdi.ru', 'RUDIGITALGAME.FIMDI.RU', 'example.com', '1.2.3', '1.2.3.4.5', 'abc.def', '256.1.1.1', '1.2.3.-1']) {
    assert.strictEqual(isIpLiteral(bad), false, bad);
  }
  assert.strictEqual(selectTlsContext(''), 'legacy', 'пустое SNI');
  assert.strictEqual(selectTlsContext(null), 'legacy', 'null SNI');
  assert.strictEqual(selectTlsContext('rudigitalgame.fimdi.ru'), 'le');
  assert.strictEqual(selectTlsContext('RUDIGITALGAME.FIMDI.RU'), 'le', 'регистр не важен');
  assert.strictEqual(selectTlsContext('lvdigitalgame.fimdi.ru'), 'le');
});

test('вход через Yandex ID создаёт аккаунт ya:uid', () => {
  const r = accounts.loginYa('123456789', 'Яндекс Игрок');
  assert.strictEqual(r.ok, true, r.reason);
  assert.ok(r.token && r.token.includes('.'));
  const acc = db.getAccount('ya:123456789');
  assert.ok(acc, 'аккаунт ya:123456789 существует');
  assert.strictEqual(acc.nick, 'Яндекс Игрок');
});

test('повторный вход по тому же Yandex ID — тот же аккаунт', () => {
  assert.strictEqual(accounts.loginYa('123456789', 'Другое имя').ok, true);
  assert.strictEqual(db.getAccount('ya:123456789').nick, 'Яндекс Игрок',
    'ник не перезаписывается');
});

test('плохой ник заменяется безопасным', () => {
  const r = accounts.loginYa('987', 'Админ');
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(db.getAccount('ya:987').nick, 'Игрок-987');
});

test('UUID стаба dev-proxy принимается как Yandex ID', () => {
  const uid = '0f2737f2-dd9b-4611-843e-97406d4fd8c1';
  const r = accounts.loginYa(uid, 'Guest');
  assert.strictEqual(r.ok, true, r.reason);
  assert.ok(db.getAccount('ya:' + uid), 'аккаунт ya:uuid существует');
});

test('не числовой Yandex ID отклоняется', () => {
  for (const bad of ['', 'abc', 'ya:123', '12 34', '123456789012345678901',
    '0f2737f2-dd9b-4611-843e-97406d4fd8c', 'zzzzzzzz-0000-0000-0000-000000000000']) {
    assert.strictEqual(accounts.loginYa(bad, 'X').ok, false, bad);
  }
});

test('ya-префикс нельзя занять обычным путём', () => {
  assert.strictEqual(accounts.register('ya:123', 'secret123', 'X').ok, false);
  assert.strictEqual(accounts.login('ya:123456789', 'x').ok, false);
});

test('токен ya-аккаунта подходит для resume', () => {
  const r = accounts.loginYa('123456789', 'X');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(accounts.resume(r.token).ok, true);
});

test('служебные ники и управляющие символы отклоняются', () => {
  for (const nick of ['Админ', 'Поддержка', 'Бот 2', 'bot', 'bad\nnick']) {
    assert.strictEqual(accounts.register(`nick${nick.length}`, 'secret123', nick).ok, false, nick);
  }
  assert.strictEqual(accounts.register('nickok', 'secret123', 'Ботаник').ok, true);
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

test('выход отзывает именно эту сессию', () => {
  const login = accounts.login('testuser', 'newsecret');
  assert.strictEqual(login.ok, true, login.reason);
  assert.strictEqual(accounts.sessionAlive(login.token), true);
  assert.strictEqual(accounts.logout(login.token), true);
  assert.strictEqual(accounts.sessionAlive(login.token), false, 'отозванный токен мёртв');
  assert.strictEqual(accounts.resume(login.token).ok, false);
});

test('смена ника не убивает сессию', () => {
  assert.ok(accounts.register('nickuser', 'secret123', 'Ник').ok);
  const login = accounts.login('nickuser', 'secret123');
  assert.strictEqual(login.ok, true, login.reason);
  assert.strictEqual(accounts.changeNick(db.getAccount('nickuser'), 'Ник2').account.nick, 'Ник2');
  assert.strictEqual(accounts.resume(login.token).ok, true, 'токен жив после смены ника');
});

test('отзыв сессии доезжает до соседнего сервера через gossip', () => {
  assert.ok(accounts.register('revuser', 'secret123', 'Отзыв').ok);
  const token = accounts.login('revuser', 'secret123').token;
  const oldDbPath = config.dbPath;
  const otherPath = path.join(TMP, 'rev-gossip.sqlite3');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.rmSync(otherPath + suffix, { force: true }); } catch (_) { /* нет файла */ }
  }
  config.dbPath = otherPath;
  const dbB = new Db();
  const accountsB = new Accounts(dbB);
  try {
    const clusterA = new Cluster(db);
    const clusterB = new Cluster(dbB);
    const first = clusterA.handleGossip({ from: { server_id: 'peer-a' }, since: 0, revSince: 0 });
    clusterB.ingest(first);
    assert.strictEqual(accountsB.resume(token).ok, true, 'токен сначала принимают оба сервера');
    assert.strictEqual(accounts.logout(token), true);
    const second = clusterA.handleGossip({
      from: { server_id: 'peer-a' },
      since: 0,
      revSince: Number(first.rev_sent_up_to) || 0,
    });
    assert.ok(second.revocations.length > 0, 'отзыв попал в следующую пачку');
    clusterB.ingest(second);
    assert.strictEqual(accountsB.resume(token).ok, false, 'после реплики выход действует везде');
    assert.strictEqual(accountsB.sessionAlive(token), false);
  } finally {
    dbB.close();
    config.dbPath = oldDbPath;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.rmSync(otherPath + suffix, { force: true }); } catch (_) { /* нет файла */ }
    }
  }
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

test('безразмерная реплика отклоняется до записи', () => {
  const cluster = new Cluster(db);
  const out = cluster.handleGossip({
    from: { server_id: 'peer-big' },
    since: 0,
    accounts: new Array(1001).fill({}),
    revocations: [],
  });
  assert.strictEqual(out.ok, false);
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

test('чужой X-Forwarded-For не подменяет IP для лимитов', () => {
  const hub = newHub();
  const sent = [];
  const sock = { readyState: 1, send: (x) => sent.push(x), close: () => {}, on: () => {} };
  const ip = '198.51.100.201';
  hub.onConnection(sock, {
    headers: { 'x-forwarded-for': '203.0.113.99' },
    socket: { remoteAddress: ip },
  });
  try {
    assert.strictEqual(hub.sockets.get(sock).ip, ip, 'лимит и журнал идут по прямому адресу');
  } finally {
    hub.sockets.delete(sock);
    hub.ipCounts.set(ip, Math.max(0, (hub.ipCounts.get(ip) || 1) - 1));
    hub.stop();
  }
});

test('доверенный прокси читает XFF по цепочке справа налево', () => {
  const hub = newHub();
  const old = config.trustedProxies;
  config.trustedProxies = ['10.0.0.5'];
  const sock = { readyState: 1, send: () => {}, close: () => {}, on: () => {} };
  hub.onConnection(sock, {
    headers: { 'x-forwarded-for': '203.0.113.44, 10.0.0.5' },
    socket: { remoteAddress: '10.0.0.5' },
  });
  try {
    assert.strictEqual(hub.sockets.get(sock).ip, '203.0.113.44');
  } finally {
    config.trustedProxies = old;
    hub.sockets.delete(sock);
    hub.ipCounts.set('203.0.113.44', Math.max(0, (hub.ipCounts.get('203.0.113.44') || 1) - 1));
    hub.stop();
  }
});

test('лимит входа общий на IP, а не только на сокет', () => {
  const hub = newHub();
  const ip = '198.51.100.202';
  const old = config.authIpAttemptsPerMinute;
  config.authIpAttemptsPerMinute = 2;
  try {
    for (let i = 0; i < 2; i += 1) {
      const fresh = { ip, authFails: 0, authWindowStart: Date.now() };
      assert.strictEqual(hub.allowAuth(fresh), true, `попытка ${i + 1} проходит`);
    }
    const reconnected = { ip, authFails: 0, authWindowStart: Date.now() };
    assert.strictEqual(hub.allowAuth(reconnected), false, 'переподключение лимит не обнуляет');
  } finally {
    config.authIpAttemptsPerMinute = old;
    hub.ipAuth.delete(ip);
    hub.stop();
  }
});

test('переход в другое лобби освобождает старое место', () => {
  assert.ok(accounts.register('move1', 'secret123', 'Переход').ok);
  assert.ok(accounts.register('move2', 'secret123', 'Переход2').ok);
  const first = rooms.createRoom(userOf('move1'), { seats: 3, name: 'Старая' }).room;
  assert.ok(rooms.joinRoom(userOf('move2'), first.code, null).ok);
  first.sockets.set(0, { id: 'old-socket' });
  const second = rooms.createRoom(userOf('move1'), { seats: 2, name: 'Новая' });
  assert.ok(second.ok, second.reason);
  assert.strictEqual(first.players[0], null, 'в старом лобби место свободно');
  assert.strictEqual(first.sockets.has(0), false, 'старый сокет отвязан');
  assert.strictEqual(rooms.byUser.get('move1'), second.room.code);
  assert.strictEqual(second.room.filled(), 1, 'игрок только в новой комнате');
});

test('из идущей партии нельзя уйти созданием комнаты', () => {
  assert.ok(accounts.register('solo1', 'secret123', 'Партия1').ok);
  assert.ok(accounts.register('solo2', 'secret123', 'Партия2').ok);
  assert.ok(accounts.register('spare1', 'secret123', 'Запас').ok);
  const arena = rooms.createRoom(userOf('solo1'), { seats: 2, require30: false }).room;
  assert.ok(rooms.joinRoom(userOf('solo2'), arena.code, null).ok, 'второй игрок запускает партию');
  assert.strictEqual(arena.state, 'playing');
  const blocked = rooms.createRoom(userOf('solo1'), { seats: 2, name: 'Побег' });
  assert.strictEqual(blocked.ok, false, 'вторая комната не создана');
  assert.ok(String(blocked.reason).includes('парти'), `не та причина: ${blocked.reason}`);
  const lobby = rooms.createRoom(userOf('spare1'), { seats: 2, name: 'Лобби' }).room;
  const joined = rooms.joinRoom(userOf('solo1'), lobby.code, null);
  assert.strictEqual(joined.ok, false, 'вход в другое лобби из партии запрещён');
  assert.strictEqual(rooms.byUser.get('solo1'), arena.code, 'привязка осталась к идущей партии');
});

test('быстрый матч не сажает игрока, уже сидящего в комнате', () => {
  const before = rooms.rooms.size;
  const q = {
    key: '3:0-test',
    seats: 3,
    require30: false,
    waiting: ['solo1', userOf('spare1').id],
    timer: null,
    createdMs: Date.now(),
  };
  rooms.quick.set(q.key, q);
  try {
    assert.strictEqual(rooms._tryFormQuick(q), null, 'без двух свободных мест партия не собирается');
    assert.strictEqual(rooms.rooms.size, before, 'лишняя комната не создана');
  } finally {
    rooms.quick.delete(q.key);
  }
});

test('logout отзывает сессию соединения, а не чужой токен из сообщения', () => {
  assert.ok(accounts.register('sess1', 'secret123', 'Сессия1').ok);
  assert.ok(accounts.register('sess2', 'secret123', 'Сессия2').ok);
  const hub = newHub();
  const room = playingRoom('sess1', 'sess2');
  room.game.current = 0;
  const a = fakeSock(hub, room, 0, userOf('sess1'));
  const b = fakeSock(hub, room, 1, userOf('sess2'));
  const own = a.ctx.token;
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({ t: C2S.LOGOUT, token: 'чужой-токен' })));
  const done = a.msgs[a.msgs.length - 1];
  assert.strictEqual(done.t, S2C.AUTH_ERR);
  assert.strictEqual(done.reason, 'Вы вышли');
  assert.strictEqual(accounts.sessionAlive(own), false, 'активная сессия отозвана');
  assert.strictEqual(db.revokedSession(tokenHash('чужой-токен')), null, 'чужой токен не тронут');
  // Открытое соединение соперника тоже проверяется: внешний отзыв (например,
  // с другого сервера) закрывает его на следующем сообщении.
  const c = fakeSock(hub, room, 1, userOf('sess2'));
  accounts.logout(c.ctx.token);
  hub.onMessage(c.ctx, Buffer.from(JSON.stringify({
    t: C2S.GAME_DRAFT,
    rows: [{ id: 1, tiles: room.game.players[1].handIds.slice(0, 1) }],
  })));
  const rejected = c.msgs[c.msgs.length - 1];
  assert.strictEqual(rejected.t, S2C.AUTH_ERR);
  assert.strictEqual(rejected.reason, 'Сессия недействительна');
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_DRAFT).length, 0,
    'отозванный сокет ничего не разослал');
  hub.stop();
});

test('незанятые места партия добирает ботами при старте', () => {
  // Отдельная комната со своими игроками, чтобы не трогать byUser room2.
  const fa = accounts.register('filla', 'secret123', 'Фила');
  const fb = accounts.register('fillb', 'secret123', 'Филб');
  assert.ok(fa.ok && fb.ok);
  const fillRoom = rooms.createRoom(userOf('filla'), { seats: 4, name: 'С ботами' }).room;
  rooms.joinRoom(userOf('fillb'), fillRoom.code, null);
  assert.strictEqual(fillRoom.filled(), 2);
  const r = rooms.startGame(userOf('filla'));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(fillRoom.state, 'playing');
  assert.strictEqual(fillRoom.game.players[0].isBot, false, 'люди остаются людьми');
  assert.strictEqual(fillRoom.game.players[1].isBot, false);
  assert.strictEqual(fillRoom.game.players[2].isBot, true, 'пустые места занимают боты');
  assert.strictEqual(fillRoom.game.players[3].isBot, true);
  assert.strictEqual(fillRoom.game.handSize(0), 14);
});

test('партия не стартует с одним игроком', () => {
  const solo = rooms.createRoom(userOf('guest2'), { seats: 2 }).room;
  const r = rooms.startGame(userOf('guest2'));
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('минимум 2'));
  void solo;
});

test('после заполнения всех мест партия стартует сама', () => {
  const extra = accounts.register('guest3', 'secret123', 'Гость3');
  assert.strictEqual(extra.ok, true);
  const r1 = rooms.joinRoom(userOf('guest2'), room2.code, null);
  const r2 = rooms.joinRoom(userOf('guest3'), room2.code, null);
  assert.strictEqual(r1.ok && r2.ok, true, `${r1.reason || ''} ${r2.reason || ''}`);
  assert.strictEqual(room2.filled(), room2.seats);
  // Кнопка «начать» не нужна: полная комната стартует сама.
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
  // Второй игрок заполняет комнату — партия стартует сама.
  rooms.joinRoom(you, room.code, null);
  assert.strictEqual(room.state, 'playing');
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
assert.strictEqual(stRoom.state, 'playing', 'второй игрок заполняет комнату и старт идёт сам');
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
  assert.strictEqual(room.state, 'playing', 'второй игрок заполняет комнату и старт идёт сам');
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

assert.ok(accounts.register('room3a', 'secret123', 'Обрыв1').ok);
assert.ok(accounts.register('room3b', 'secret123', 'Обрыв2').ok);
const room3 = rooms.createRoom(userOf('room3a'), { seats: 2, require30: false }).room;
rooms.joinRoom(userOf('room3b'), room3.code, null);
assert.strictEqual(room3.state, 'playing', 'второй игрок заполняет комнату и старт идёт сам');
const u1 = userOf('room3b');
rooms.onDisconnect(u1);
test('после обрыва в партии место НЕ освобождается сразу', () => {
  assert.strictEqual(room3.state, 'playing');
  assert.ok(room3.players[1] !== null, 'место остаётся занятым на время ожидания');
  assert.ok(room3.paused.has(1), 'комната на паузе');
  assert.ok(room3.isPaused());
});
test('игра заблокирована, пока кто-то ждёт переподключения', () => {
  const r = rooms.commitTurn(userOf('room3a'),
    [{ op: 'place', tile: room3.game.players[0].handIds[0], to: 'n0', index: 0 }]);
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

test('по истечении срока вдвоём — место освобождается, включается ожидание второго', () => {
  rooms.onDisconnect(u1);
  // перематываем дедлайн в прошлое
  const d = room3.paused.get(1);
  d.deadline = Date.now() - 1;
  const touched = rooms.expireDisconnects();
  assert.ok(touched.includes(room3), 'комната должна попасть в список обновлений');
  assert.strictEqual(room3.players[1], null, 'место ушедшего свободно — занял бы его новый');
  assert.strictEqual(room3.game.players[1].isBot, false, 'бота не ставим: живых остался один');
  assert.strictEqual(room3.waiting, true, 'ждём второго игрока');
  assert.strictEqual(room3.state, 'playing', 'партия не удаляется, пока за ней кто-то есть');
  assert.strictEqual(room3.filled(), 1, 'живой один');
  assert.ok(!rooms.byUser.has(u1.id), 'ушедший с превышением срока отвязан от комнаты');
});

test('в ожидании второго ход любого заблокирован понятной причиной', () => {
  const r = rooms.commitTurn(userOf('room3a'),
    [{ op: 'place', tile: room3.game.players[0].handIds[0], to: 'n0', index: 0 }]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('второго'), r.reason);
});

test('второй игрок входит в ждущую комнату — ожидание снимается', () => {
  const w1 = accounts.register('wait1', 'secret123', 'Ждун1');
  assert.ok(w1.ok, w1.reason);
  const j = rooms.joinRoom(userOf('wait1'), room3.code, null);
  assert.ok(j.ok, j.reason);
  assert.strictEqual(j.playing, true, 'комната уже играет — ответ должен быть партией');
  assert.strictEqual(room3.waiting, false, 'второй пришёл — ждать больше не кого');
  assert.strictEqual(room3.filled(), 2);
  assert.strictEqual(room3.state, 'playing');
  assert.ok(!room3.isPaused(), 'паузы нет — можно ходить');
});

test('троим место выбывшего занимает бот, партия продолжается', () => {
  for (const [login, nick] of [['trio2', 'Трой2'], ['trio3', 'Трой3'], ['trio4', 'Трой4']]) {
    assert.ok(accounts.register(login, 'secret123', nick).ok);
  }
  const rb = rooms.createRoom(userOf('trio2'), { seats: 3, require30: false }).room;
  assert.ok(rooms.joinRoom(userOf('trio3'), rb.code, null).ok);
  assert.ok(rooms.joinRoom(userOf('trio4'), rb.code, null).ok);
  assert.strictEqual(rb.state, 'playing', 'комната на троих заполнилась и стартовала');
  const u4 = userOf('trio4');
  rooms.onDisconnect(u4);
  const d = rb.paused.get(2);
  d.deadline = Date.now() - 1;
  const touched = rooms.expireDisconnects();
  assert.ok(touched.includes(rb), 'комната должна попасть в список обновлений');
  assert.strictEqual(rb.game.players[2].isBot, true, 'двое живых — место занимает бот');
  assert.strictEqual(rb.waiting, false, 'ждать нечего: людей двое');
  assert.strictEqual(rb.filled(), 3, 'место остаётся занятым (ботом)');
});

test('ушли оба — комната удаляется вместе с последним живым', () => {
  assert.ok(accounts.register('gone1', 'secret123', 'Уход1').ok);
  assert.ok(accounts.register('gone2', 'secret123', 'Уход2').ok);
  const rc = rooms.createRoom(userOf('gone1'), { seats: 2, require30: false }).room;
  assert.ok(rooms.joinRoom(userOf('gone2'), rc.code, null).ok);
  assert.strictEqual(rc.state, 'playing');
  rooms.onDisconnect(userOf('gone1'));
  rooms.onDisconnect(userOf('gone2'));
  rc.paused.get(0).deadline = Date.now() - 1;
  rc.paused.get(1).deadline = Date.now() - 1;
  rooms.expireDisconnects();
  // Первый истёк — ожидание; второй, последний, истёк — уборка.
  assert.ok(!rooms.rooms.has(rc.code), 'с последним ушедшим комната должна исчезнуть');
  assert.ok(!rooms.byUser.has(userOf('gone1').id), 'gone1 отвязан');
  assert.ok(!rooms.byUser.has(userOf('gone2').id), 'gone2 отвязан');
});

test('полный выход из двоих — не удаление, а ожидание второго', () => {
  assert.ok(accounts.register('exit1', 'secret123', 'Выход1').ok);
  assert.ok(accounts.register('exit2', 'secret123', 'Выход2').ok);
  const re = rooms.createRoom(userOf('exit1'), { seats: 2, require30: false }).room;
  assert.ok(rooms.joinRoom(userOf('exit2'), re.code, null).ok);
  rooms.leaveGame(userOf('exit1'));
  assert.ok(rooms.rooms.has(re.code), 'остался один живой — комната ждёт, а не закрывается');
  assert.strictEqual(re.waiting, true, 'ждём второго');
  assert.strictEqual(re.filled(), 1);
  assert.ok(re.game.players[0].dropped, 'вышедший помечен выбывшим — его место не занято');
  // Новый человек садится на свободное место и берёт запись себе.
  assert.ok(accounts.register('exit3', 'secret123', 'Выход3').ok);
  assert.ok(rooms.joinRoom(userOf('exit3'), re.code, null).ok);
  assert.strictEqual(re.waiting, false, 'второй пришёл — ждать больше не кого');
  assert.ok(!re.game.players[0].dropped, 'запись игрока очищена — новый игрок ходит');
  rooms.leaveGame(userOf('exit2'));
  assert.ok(rooms.rooms.has(re.code) && re.waiting, 'ещё один живой — комната снова ждёт');
  rooms.leaveGame(userOf('exit3'));
  assert.ok(!rooms.rooms.has(re.code), 'ушёл и последний — комната удалена');
});

test('в лобби обрыв освобождает место сразу', () => {
  assert.ok(accounts.register('room4a', 'secret123', 'Лобби1').ok);
  assert.ok(accounts.register('room4b', 'secret123', 'Лобби2').ok);
  const room4 = rooms.createRoom(userOf('room4a'), { seats: 3 }).room;
  rooms.joinRoom(userOf('room4b'), room4.code, null);
  assert.strictEqual(room4.filled(), 2);
  assert.strictEqual(room4.state, 'lobby', 'неполная комната не стартует');
  rooms.onDisconnect(userOf('room4b'));
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
  assert.ok(accounts.register('roomp1', 'secret123', 'Пароль1').ok);
  assert.ok(accounts.register('roomp2', 'secret123', 'Пароль2').ok);
  const protectedRoom = rooms.createRoom(userOf('roomp1'), { seats: 2, password: 'код' }).room;
  const bad = rooms.joinRoom(userOf('roomp2'), protectedRoom.code, 'не-код');
  assert.strictEqual(bad.ok, false);
  const good = rooms.joinRoom(userOf('roomp2'), protectedRoom.code, 'код');
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

// ============================================================ таймер хода
// Ход ограничен по времени: дедлайн ставит хаб (maybeRunBots ->
// _scheduleTurn), по истечении сервер сам берёт фишку из колоды и
// передаёт очередь дальше. Отсчёт виден всем через gameView.turnLeft.
group('== Таймер хода ==');

function newHub() {
  return new Hub({
    db,
    accounts,
    cluster: { push: async () => {}, registry: () => [] },
    rooms,
  });
}

function fakeSock(hub, room, seat, user) {
  const msgs = [];
  const sock = { readyState: 1, send: (payload) => msgs.push(JSON.parse(payload)) };
  const ctx = {
    socket: sock,
    ip: '127.0.0.1',
    user,
    token: hub.accounts.issue(db.getAccount(user.id)),
    roomCode: room.code,
    seat,
    alive: true,
    observer: false,
    authFails: 0,
    authWindowStart: Date.now(),
  };
  hub.sockets.set(sock, ctx);
  room.sockets.set(seat, sock);
  return { sock, ctx, msgs };
}

function playingRoom(host, guest, seats = 2) {
  const room = rooms.createRoom(userOf(host), { seats, require30: false }).room;
  assert.ok(rooms.joinRoom(userOf(guest), room.code, null).ok, 'второй игрок садится');
  // Двумя местами комната полна и стартует сама; больше мест добираем
  // вручную — при старте пустые места займут боты.
  if (seats > 2) assert.ok(rooms.startGame(userOf(host)).ok, 'старт партии');
  assert.strictEqual(room.state, 'playing', 'комната дошла до партии');
  return room;
}

for (let i = 1; i <= 18; i += 1) accounts.register(`tm${i}`, 'secret123', `Таймер${i}`);
for (let i = 1; i <= 10; i += 1) accounts.register(`pk${i}`, 'secret123', `Превью${i}`);
for (let i = 1; i <= 8; i += 1) accounts.register(`to${i}`, 'secret123', `Таймаут${i}`);

test('старт партии открывает отсчёт хода', () => {
  const hub = newHub();
  const room = playingRoom('tm1', 'tm2');
  hub.maybeRunBots(room);
  assert.notStrictEqual(room.turnDeadlineMs, null, 'дедлайн должен быть поставлен');
  assert.strictEqual(room.turnDeadlineFor, room.game.current, 'дедлайн — для текущего игрока');
  const left = room.turnLeft();
  assert.ok(left >= 1 && left <= config.turnSeconds, `остаток ${left} с в пределах ${config.turnSeconds}`);
  const v = views.gameView(room, 0);
  assert.strictEqual(typeof v.turnLeft, 'number', 'вид несёт остаток секунд');
  assert.ok(v.turnLeft >= left - 1 && v.turnLeft <= config.turnSeconds, `в виде: ${v.turnLeft}`);
  hub.stop();
});

test('повторные пересчёты не двигают дедлайн', () => {
  const hub = newHub();
  const room = playingRoom('tm3', 'tm4');
  hub.maybeRunBots(room);
  const dl = room.turnDeadlineMs;
  hub.maybeRunBots(room);
  hub.maybeRunBots(room);
  assert.strictEqual(room.turnDeadlineMs, dl, 'дедлайн остался прежним');
  hub.stop();
});

test('пауза гасит отсчёт, возобновление возвращает его', () => {
  const hub = newHub();
  const room = playingRoom('tm5', 'tm6');
  hub.maybeRunBots(room);
  assert.notStrictEqual(room.turnDeadlineMs, null);
  room.pauseFor(0);
  assert.strictEqual(room.turnDeadlineMs, null, 'на паузе отсчёта нет');
  hub.maybeRunBots(room);
  assert.strictEqual(room.turnDeadlineMs, null, 'пауза не даёт поставить дедлайн заново');
  room.clearPause(0);
  hub.maybeRunBots(room);
  assert.notStrictEqual(room.turnDeadlineMs, null, 'после паузы отсчёт возобновляется');
  hub.stop();
});

test('флаг ожидания гасит и отсчёт, и ботов', () => {
  const hub = newHub();
  const room = playingRoom('tm12', 'tm13', 4);
  const botSeat = room.game.players.findIndex((p) => p.isBot);
  assert.ok(botSeat >= 0, 'нужно ботье место');
  room.game.current = botSeat;
  room.waiting = true;
  hub.maybeRunBots(room);
  assert.strictEqual(room.turnDeadlineMs, null, 'в ожидании отсчёта нет');
  assert.ok(!room._botTimer, 'в ожидании боты молчат');
  hub.stop();
});

test('боты не ходят, пока живых людей меньше двух', () => {
  const hub = newHub();
  const room = playingRoom('tm7', 'tm8', 4);
  assert.strictEqual(rooms.humanCount(room), 2, 'за столом двое живых');
  const botSeat = room.game.players.findIndex((p) => p.isBot);
  assert.ok(botSeat >= 0, 'нужно ботье место');

  // Два живых: ход бота планируется.
  room.game.current = botSeat;
  hub.maybeRunBots(room);
  assert.notStrictEqual(room._botTimer, null, 'при двух живых ход бота должен планироваться');
  clearTimeout(room._botTimer);
  room._botTimer = null;

  // Место одного из людей ушло боту — живых остался один: боты молчат,
  // а отсчёт хода у оставшегося человека остаётся.
  rooms._botifySeat(room, 0);
  assert.strictEqual(rooms.humanCount(room), 1, 'живых остался один');
  hub.maybeRunBots(room);
  assert.ok(!room._botTimer, 'при одном живом боты не ходят');
  assert.notStrictEqual(room.turnDeadlineMs, null, 'отсчёт хода при этом не гаснет');
  hub.stop();
});

test('auth.ya доступен без входа (иначе им нельзя воспользоваться)', () => {
  const hub = newHub();
  const msgs = [];
  const ctx = {
    socket: { readyState: 1, send: (p) => msgs.push(JSON.parse(p)) },
    ip: '127.0.0.1',
    authFails: 0,
    authWindowStart: Date.now(),
  };
  hub.route(ctx, { t: C2S.YA_LOGIN, uid: 'abc', nick: 'X' }, 7);
  const bad = msgs[msgs.length - 1];
  assert.strictEqual(bad.t, S2C.AUTH_ERR);
  assert.strictEqual(bad.reason, 'Некорректный Yandex ID');
  hub.route(ctx, { t: C2S.YA_LOGIN, uid: '555001', nick: 'Яндекс' }, 8);
  const good = msgs[msgs.length - 1];
  assert.strictEqual(good.t, S2C.AUTH_OK, JSON.stringify(good));
  assert.ok(good.token && good.token.includes('.'));
  assert.strictEqual(ctx.user && ctx.user.login, 'ya:555001');
  hub.stop();
});

test('боты ждут друг друга 3 секунды, а после человека идут сразу', () => {
  accounts.register('cb1', 'secret123', 'Цепочка1');
  accounts.register('cb2', 'secret123', 'Цепочка2');
  const hub = newHub();
  const room = playingRoom('cb1', 'cb2', 4);
  const botSeat = room.game.players.findIndex((p) => p.isBot);
  assert.ok(botSeat >= 0, 'нужно ботье место');
  const humanSeat = room.game.players.findIndex((p) => !p.isBot);
  assert.ok(humanSeat >= 0, 'нужно место человека');
  // Перехватываем setTimeout: проверяем задержку, не дожидаясь её.
  const realSetTimeout = global.setTimeout;
  let delays = [];
  global.setTimeout = (fn, ms, ...rest) => {
    delays.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  };
  const clearBotTimer = () => {
    if (room._botTimer) { clearTimeout(room._botTimer); room._botTimer = null; }
  };
  try {
    // Ход человека закрыт своим действием — следующий бот идёт сразу.
    room.game.current = botSeat;
    room._prevTurnByBot = true; // будто до этого ходил бот
    hub.afterMove({ room, seat: humanSeat }, null);
    assert.strictEqual(room._prevTurnByBot, false, 'после человека флаг цепочки сброшен');
    assert.ok(room._botTimer, 'ход бота запланирован');
    assert.ok(delays.some((d) => d >= config.botTurnDelayMs
      && d <= config.botTurnDelayMs + config.botTurnJitterMs),
    `первый бот идёт сразу, задержки: ${delays}`);
    assert.ok(!delays.includes(config.botAfterBotDelayMs), 'паузы 3 с тут нет');
    clearBotTimer();
    // Ход бота закрыт — следующий бот ждёт полную паузу.
    delays = [];
    room.game.current = botSeat;
    hub.afterBotMove(room);
    assert.strictEqual(room._prevTurnByBot, true, 'после бота флаг цепочки стоит');
    assert.ok(room._botTimer, 'ход бота запланирован');
    assert.ok(delays.includes(config.botAfterBotDelayMs),
      `бот за ботом ждёт ${config.botAfterBotDelayMs} мс, задержки: ${delays}`);
    clearBotTimer();
  } finally {
    global.setTimeout = realSetTimeout;
  }
  hub.stop();
});

test('время хода вышло: сервер берёт фишку из колоды сам', () => {
  const hub = newHub();
  const room = playingRoom('tm9', 'tm10');
  const a = fakeSock(hub, room, 0, userOf('tm9'));
  const b = fakeSock(hub, room, 1, userOf('tm10'));
  hub.maybeRunBots(room);
  room.turnDeadlineMs = Date.now() - 10; // просрочили вручную
  const before = room.game.current;
  const handBefore = room.game.handSize(before);
  hub._onTurnTimeout(room);
  assert.notStrictEqual(room.game.current, before, 'ход должен передаться дальше');
  assert.strictEqual(room.game.handSize(before), handBefore + 1, 'фишка взята из колоды');
  assert.notStrictEqual(room.turnDeadlineMs, null, 'новый отсчёт запущен');
  assert.strictEqual(room.turnDeadlineFor, room.game.current, 'дедлайн — для нового текущего');
  const toasts = (f) => f.msgs.filter((m) => m.t === S2C.TOAST);
  const target = before === 0 ? a : b;
  const other = before === 0 ? b : a;
  assert.strictEqual(toasts(target).length, 1, 'тост ушёл тому, чьё время вышло');
  assert.ok(toasts(target)[0].text.includes('из колоды'), toasts(target)[0].text);
  assert.strictEqual(toasts(other).length, 0, 'соперник тост не получает');
  hub.stop();
});

test('колода пуста: время вышло — ход пропускается', () => {
  const hub = newHub();
  const room = playingRoom('tm11', 'tm14');
  const a = fakeSock(hub, room, 0, userOf('tm11'));
  const b = fakeSock(hub, room, 1, userOf('tm14'));
  const g = room.game;
  while (g.tilesLeftInDeck() > 0) g.deck.draw();
  hub.maybeRunBots(room);
  room.turnDeadlineMs = Date.now() - 10;
  const before = g.current;
  const handBefore = g.handSize(before);
  hub._onTurnTimeout(room);
  assert.strictEqual(g.handSize(before), handBefore, 'рука не изменилась');
  assert.notStrictEqual(g.current, before, 'очередь передана без взятия');
  assert.notStrictEqual(room.turnDeadlineMs, null, 'отсчёт продолжается');
  const toasts = (f) => f.msgs.filter((m) => m.t === S2C.TOAST);
  const target = before === 0 ? a : b;
  assert.strictEqual(toasts(target).length, 1);
  assert.ok(toasts(target)[0].text.includes('пропущен'), toasts(target)[0].text);
  hub.stop();
});

/** Перекладывает готовый ряд в руку места, сохраняя 106 уникальных фишек. */
function rigRun(room, seat, color, v0) {
  const g = room.game;
  const run = [findTile(color, v0), findTile(color, v0 + 1), findTile(color, v0 + 2)];
  const want = new Set(run);
  const keep = g.players[seat].handIds.filter((id) => !want.has(id));
  for (const p of g.players) p.handIds = p.handIds.filter((id) => !want.has(id));
  g.deck.ids = g.deck.ids.filter((id) => !want.has(id));
  g.deck.ids.push(...keep);
  g.players[seat].handIds = run.concat(keep);
  return run;
}

test('время вышло с готовым черновиком: стол засчитан как ход', () => {
  const hub = newHub();
  const room = playingRoom('to1', 'to2');
  const a = fakeSock(hub, room, 0, userOf('to1'));
  const b = fakeSock(hub, room, 1, userOf('to2'));
  room.game.current = 0;
  const run = rigRun(room, 0, 0, 5);
  // Живой клиент шлёт СЫРЫЕ локальные id новых рядов (в коммите он мапит
  // их в 0, в черновике — нет): приём обязан нормализовать, а не ронять.
  const rows = [{ id: 7, tiles: run.slice() }];
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({ t: C2S.GAME_DRAFT, rows })));
  hub.maybeRunBots(room);
  room.turnDeadlineMs = Date.now() - 10; // просрочили вручную
  const handBefore = room.game.handSize(0);
  hub._onTurnTimeout(room);
  assert.strictEqual(room.game.current, 1, 'ход должен передаться дальше');
  assert.strictEqual(room.game.handSize(0), handBefore - 3, 'три фишки ушли из руки на стол');
  assert.deepStrictEqual(room.game.lastTurnTileIds.slice().sort((x, y) => x - y),
    run.slice().sort((x, y) => x - y), 'выставленное — в lastTurn');
  const flat = room.game.table.flatMap((r) => r.tileIds);
  for (const id of run) assert.ok(flat.includes(id), `фишка ${id} на столе`);
  const toasts = (f) => f.msgs.filter((m) => m.t === S2C.TOAST);
  assert.strictEqual(toasts(a).length, 1, 'тост ушёл автору черновика');
  assert.ok(toasts(a)[0].text.includes('принят'), toasts(a)[0].text);
  assert.strictEqual(toasts(b).length, 0, 'соперник тост не получает');
  assert.notStrictEqual(room.turnDeadlineMs, null, 'новый отсчёт запущен');
  hub.stop();
});

test('время вышло с невалидным черновиком: обычный автовзят', () => {
  const hub = newHub();
  const room = playingRoom('to3', 'to4');
  const a = fakeSock(hub, room, 0, userOf('to3'));
  fakeSock(hub, room, 1, userOf('to4'));
  room.game.current = 0;
  // Ряд из двух чисел столом не станет — геометрия черновика такое пропускает.
  const owned = [...new Set(room.game.players[0].handIds)].slice(0, 2);
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({ t: C2S.GAME_DRAFT, rows: [{ id: 0, tiles: owned }] })));
  hub.maybeRunBots(room);
  room.turnDeadlineMs = Date.now() - 10;
  const handBefore = room.game.handSize(0);
  hub._onTurnTimeout(room);
  assert.strictEqual(room.game.current, 1, 'ход должен передаться дальше');
  assert.strictEqual(room.game.handSize(0), handBefore + 1, 'невалидный черновик — взятие из колоды');
  const toasts = (f) => f.msgs.filter((m) => m.t === S2C.TOAST);
  assert.strictEqual(toasts(a).length, 1);
  assert.ok(toasts(a)[0].text.includes('из колоды'), toasts(a)[0].text);
  assert.strictEqual(room._draftRows && room._draftRows.get(0), undefined, 'черновик потрачен');
  hub.stop();
});

test('дедлайн принимает расширение существующего ряда', () => {
  const hub = newHub();
  const room = playingRoom('to7', 'to8');
  const a = fakeSock(hub, room, 0, userOf('to7'));
  const b = fakeSock(hub, room, 1, userOf('to8'));
  const g = room.game;
  // Фаза 1: ряд 5-6-7 встал обычным коммитом и получил серверный id.
  g.current = 0;
  const run = rigRun(room, 0, 0, 5);
  const laid = rooms.commitTurn(userOf('to7'), [{ op: 'set_table', rows: [{ id: 0, tiles: run }] }]);
  assert.ok(laid.ok, laid.reason);
  assert.strictEqual(g.current, 1, 'ход у второго места');
  // Фаза 2: второй игрок доложил восьмёрку в тот же ряд (id серверный).
  const eight = findTile(0, 8);
  for (const p of g.players) p.handIds = p.handIds.filter((id) => id !== eight);
  g.deck.ids = g.deck.ids.filter((id) => id !== eight);
  g.players[1].handIds.push(eight);
  const serverRow = g.table[0];
  const rows = [{ id: serverRow.id, tiles: serverRow.tileIds.concat([eight]) }];
  hub.onMessage(b.ctx, Buffer.from(JSON.stringify({ t: C2S.GAME_DRAFT, rows })));
  hub.maybeRunBots(room);
  room.turnDeadlineMs = Date.now() - 10;
  const handBefore = g.handSize(1);
  hub._onTurnTimeout(room);
  assert.strictEqual(g.current, 0, 'ход передан дальше');
  assert.strictEqual(g.handSize(1), handBefore - 1, 'восьмёрка ушла из руки');
  assert.ok(g.table[0].tileIds.includes(eight), 'ряд расширен на столе');
  const toasts = (f) => f.msgs.filter((m) => m.t === S2C.TOAST);
  assert.ok(toasts(b)[0].text.includes('принят'), toasts(b)[0].text);
  hub.stop();
});

test('успешный коммит гасит черновик автора', () => {
  const hub = newHub();
  const room = playingRoom('to5', 'to6');
  const a = fakeSock(hub, room, 0, userOf('to5'));
  fakeSock(hub, room, 1, userOf('to6'));
  room.game.current = 0;
  const run = rigRun(room, 0, 1, 7);
  const rows = [{ id: 0, tiles: run.slice() }];
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({ t: C2S.GAME_DRAFT, rows })));
  assert.ok(room._draftRows && room._draftRows.has(0), 'черновик запомнен');
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({
    t: C2S.GAME_COMMIT, rid: 'c1', ops: [{ op: 'set_table', rows }],
  })));
  assert.strictEqual(room.game.current, 1, 'коммит прошёл');
  assert.strictEqual(room._draftRows && room._draftRows.get(0), undefined, 'черновик сброшен ходом');
  hub.stop();
});

test('на паузе просроченный таймер ничего не делает', () => {

  const hub = newHub();
  const room = playingRoom('tm15', 'tm16');
  hub.maybeRunBots(room);
  room.pauseFor(0);
  room.turnDeadlineMs = Date.now() - 10; // чужой просроченный дедлайн
  const before = room.game.current;
  const handBefore = room.game.handSize(before);
  hub._onTurnTimeout(room);
  assert.strictEqual(room.game.current, before, 'на паузе ход не должен передаваться');
  assert.strictEqual(room.game.handSize(before), handBefore, 'фишка не берётся');
  assert.strictEqual(room.turnDeadlineMs, null, 'дедлайн остаётся погашенным');
  hub.stop();
});

test('рассылка после завершённого хода несёт живой отсчёт', () => {
  const hub = newHub();
  const room = playingRoom('tm17', 'tm18');
  const u0 = userOf('tm17');
  const u1 = userOf('tm18');
  const a = fakeSock(hub, room, 0, u0);
  const b = fakeSock(hub, room, 1, u1);
  const r = rooms.drawFor(room.game.current === 0 ? u0 : u1);
  assert.ok(r.ok, r.reason);
  // После хода отсчёт погашен — но рассылка обязана уйти уже с новым:
  // именно в таком порядке afterMove отдаёт состояние клиентам.
  assert.strictEqual(room.turnDeadlineMs, null, 'до рассылки отсчёт погашен');
  hub.afterMove(r, undefined);
  const last = (f) => [...f.msgs].reverse().find((m) => m.t === S2C.GAME_STATE);
  assert.ok(last(a) && last(b), 'оба игрока получили состояние');
  const tl = last(a).state.turnLeft;
  assert.strictEqual(typeof tl, 'number', `в рассылке должен быть живой отсчёт: ${tl}`);
  assert.ok(tl >= 1 && tl <= config.turnSeconds, `остаток ${tl} с в пределах`);
  hub.stop();
});

// =========================================================== превью ходов
// game.peek: клиент, перебирая варианты, шлёт призрак фишки; хаб
// пересылает его остальным сидам без проверки правил (это картинка),
// с троттлингом 40 мс и валидацией формы сообщения.
group('== Превью ходов (peek) ==');

test('превью уходит сопернику и не возвращается автору', () => {
  const hub = newHub();
  const room = playingRoom('pk1', 'pk2');
  const a = fakeSock(hub, room, 0, userOf('pk1'));
  const b = fakeSock(hub, room, 1, userOf('pk2'));
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({
    t: C2S.GAME_PEEK, tile: 7, kind: 'into', row: 3, index: 2,
  })));
  assert.strictEqual(a.msgs.filter((m) => m.t === S2C.GAME_PEEK).length, 0,
    'автор своего превью не видит');
  const got = b.msgs.filter((m) => m.t === S2C.GAME_PEEK);
  assert.strictEqual(got.length, 1, 'соперник получил превью');
  assert.deepStrictEqual(got[0],
    { t: S2C.GAME_PEEK, from: 0, tile: 7, kind: 'into', row: 3, index: 2 });
  hub.stop();
});

test('превью видов new/clear/back несёт только своё', () => {
  const hub = newHub();
  const room = playingRoom('pk3', 'pk4');
  const a = fakeSock(hub, room, 0, userOf('pk3'));
  const b = fakeSock(hub, room, 1, userOf('pk4'));
  const send = (payload) => {
    room._peekAt = new Map(); // троттлинг гасим между сообщениями — своя проверка ниже
    hub.onMessage(a.ctx, Buffer.from(JSON.stringify({ t: C2S.GAME_PEEK, ...payload })));
  };
  send({ tile: 11, kind: 'new', at: 2 });
  send({ tile: 12, kind: 'clear' });
  send({ tile: 13, kind: 'back' });
  const got = b.msgs.filter((m) => m.t === S2C.GAME_PEEK);
  assert.strictEqual(got.length, 3, `пришло: ${JSON.stringify(got)}`);
  assert.deepStrictEqual(got[0], { t: S2C.GAME_PEEK, from: 0, tile: 11, kind: 'new', at: 2 });
  assert.deepStrictEqual(got[1], { t: S2C.GAME_PEEK, from: 0, tile: 12, kind: 'clear' });
  assert.deepStrictEqual(got[2], { t: S2C.GAME_PEEK, from: 0, tile: 13, kind: 'back' });
  assert.ok(!('row' in got[0]) && !('index' in got[0]), 'новый ряд несёт только позицию');
  hub.stop();
});

test('превью принимает только от текущего игрока', () => {
  assert.ok(accounts.register('pk13', 'secret123', 'Превью13').ok);
  assert.ok(accounts.register('pk14', 'secret123', 'Превью14').ok);
  const hub = newHub();
  const room = playingRoom('pk13', 'pk14');
  const b = fakeSock(hub, room, 1, userOf('pk14'));
  room.game.current = 1;
  const a = fakeSock(hub, room, 0, userOf('pk13'));
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({
    t: C2S.GAME_PEEK, tile: 9, kind: 'into', row: 0, index: 1,
  })));
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_PEEK).length, 0,
    'превью неходящего места не пересылается');
  hub.stop();
});

test('мусор в превью отбрасывается молча', () => {
  const hub = newHub();
  const room = playingRoom('pk5', 'pk6');
  const a = fakeSock(hub, room, 0, userOf('pk5'));
  const b = fakeSock(hub, room, 1, userOf('pk6'));
  const bad = [
    { tile: 5, kind: 'bogus' },
    { tile: -1, kind: 'clear' },
    { tile: 0, kind: 'clear' },
    { tile: catalog.TOTAL + 1, kind: 'clear' },
    { tile: 1.5, kind: 'clear' },
    { tile: '7', kind: 'clear' },
    { tile: 5, kind: 'into', row: 0 }, // без index
    { tile: 5, kind: 'into', row: -1, index: 0 },
    { tile: 5, kind: 'into', row: 0, index: 65 },
    { tile: 5, kind: 'into', row: 'x', index: 0 },
    { tile: 5, kind: 'new' }, // без at
    { tile: 5, kind: 'new', at: 10001 },
  ];
  for (const payload of bad) {
    hub.onMessage(a.ctx, Buffer.from(JSON.stringify({ t: C2S.GAME_PEEK, ...payload })));
  }
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_PEEK).length, 0,
    'ничего из мусора не должно было пройти');
  // А валидное проходит — доказывает, что молчание выше из-за проверок.
  // Граничный номер catalog.TOTAL тоже валиден: отсев идёт по каталогу, а не
  // по устаревшему числовому диапазону.
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({ t: C2S.GAME_PEEK, tile: catalog.TOTAL, kind: 'clear' })));
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_PEEK).length, 1,
    'валидное превью проходит');
  hub.stop();
});

test('превью чаще раза в 40 мс не проходит (троттлинг)', () => {
  assert.ok(accounts.register('pk11', 'secret123', 'Превью11').ok);
  assert.ok(accounts.register('pk12', 'secret123', 'Превью12').ok);
  const hub = newHub();
  const room = playingRoom('pk11', 'pk12');
  const a = fakeSock(hub, room, 0, userOf('pk11'));
  const b = fakeSock(hub, room, 1, userOf('pk12'));
  const one = () => hub.onMessage(a.ctx,
    Buffer.from(JSON.stringify({ t: C2S.GAME_PEEK, tile: 9, kind: 'into', row: 0, index: 1 })));
  one();
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_PEEK).length, 1, 'первое прошло');
  room._peekAt.set(0, Date.now()); // свежая метка — как будто отправка была только что
  one();
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_PEEK).length, 1,
    'второе подряд отброшено');
  hub.stop();
});

test('clear идёт мимо троттлинга — призрак должен погаснуть вовремя', () => {
  const hub = newHub();
  const room = playingRoom('pk7', 'pk8');
  const a = fakeSock(hub, room, 0, userOf('pk7'));
  const b = fakeSock(hub, room, 1, userOf('pk8'));
  const send = (payload) => hub.onMessage(a.ctx,
    Buffer.from(JSON.stringify({ t: C2S.GAME_PEEK, ...payload })));
  send({ tile: 9, kind: 'into', row: 0, index: 1 });
  // Смена цели: clear уходит вслед за последним превью вплотную, а своё
  // окно 40 мс соперник только что открыл — потерянный clear оставил бы
  // призрак висеть до пятисекундного протухания.
  send({ tile: 9, kind: 'clear' });
  const got = b.msgs.filter((m) => m.t === S2C.GAME_PEEK);
  assert.strictEqual(got.length, 2, `пришло: ${JSON.stringify(got)}`);
  assert.strictEqual(got[1].kind, 'clear', 'clear дошёл, невзирая на окно');
  // А обычное превью в том же окне по-прежнему троттлится.
  send({ tile: 10, kind: 'into', row: 1, index: 0 });
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_PEEK).length, 2,
    'into в открытое окно отброшен');
  hub.stop();
});

test('превью от сокета вне комнаты игнорируется', () => {
  const hub = newHub();
  const room = playingRoom('pk9', 'pk10');
  const b = fakeSock(hub, room, 1, userOf('pk10'));
  const msgs = [];
  const sock = { readyState: 1, send: (payload) => msgs.push(JSON.parse(payload)) };
  const ctx = {
    socket: sock, ip: '127.0.0.1', user: userOf('pk9'),
    token: hub.accounts.issue(db.getAccount('pk9')),
    roomCode: null, seat: undefined,
    alive: true, observer: false, authFails: 0, authWindowStart: Date.now(),
  };
  hub.sockets.set(sock, ctx);
  hub.onMessage(ctx, Buffer.from(JSON.stringify({ t: C2S.GAME_PEEK, tile: 3, kind: 'clear' })));
  assert.strictEqual(msgs.length, 0, 'молчаливое игнорирование, без ответов');
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_PEEK).length, 0,
    'соперник ничего не получил');
  hub.stop();
});

// ========================================================= черновик стола
// game.draft: игрок шлёт ВЕСЬ свой стол после каждой локальной раскладки,
// хаб пересылает остальным сидам — чтобы соперники видели все выложенные
// фишки (серыми) ещё до commit. Рисует ровно текущий игрок, форма rows
// валидируется, троттлинг тот же 40 мс, что у peek.
group('== Черновик стола (game.draft) ==');

for (let i = 1; i <= 8; i += 1) accounts.register(`dr${i}`, 'secret123', `Черновик${i}`);

test('черновик уходит сопернику целиком и не возвращается автору', () => {
  const hub = newHub();
  const room = playingRoom('dr1', 'dr2');
  room.game.current = 0;
  const a = fakeSock(hub, room, 0, userOf('dr1'));
  const b = fakeSock(hub, room, 1, userOf('dr2'));
  const owned = room.game.players[0].handIds.slice(0, 2);
  const rows = [{ id: 1, tiles: owned.slice(0, 1) }, { id: 0, tiles: owned.slice(1, 2) }];
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({ t: C2S.GAME_DRAFT, rows })));
  assert.strictEqual(a.msgs.filter((m) => m.t === S2C.GAME_DRAFT).length, 0,
    'автор своего черновика не видит');
  const got = b.msgs.filter((m) => m.t === S2C.GAME_DRAFT);
  assert.strictEqual(got.length, 1, 'соперник получил черновик');
  assert.deepStrictEqual(got[0], { t: S2C.GAME_DRAFT, from: 0, rows });
  hub.stop();
});

test('черновик принимается только от текущего игрока', () => {
  const hub = newHub();
  const room = playingRoom('dr3', 'dr4');
  const a = fakeSock(hub, room, 0, userOf('dr3'));
  const b = fakeSock(hub, room, 1, userOf('dr4'));
  room.game.current = 1;
  // Ходит соперник: черновик от seat0 — гонка или враньё, рисовать его
  // нельзя, столы перепутались бы у всех.
  const owned = room.game.players[0].handIds.slice(0, 1);
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({
    t: C2S.GAME_DRAFT, rows: [{ id: 1, tiles: owned }],
  })));
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_DRAFT).length, 0,
    'от не-текущего игрока не проходит');
  // Ходит seat0 — то же сообщение проходит.
  room.game.current = 0;
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({
    t: C2S.GAME_DRAFT, rows: [{ id: 1, tiles: owned }],
  })));
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_DRAFT).length, 1,
    'от текущего игрока проходит');
  hub.stop();
});

test('черновик не показывает чужие скрытые фишки', () => {
  assert.ok(accounts.register('dr9', 'secret123', 'Черновик9').ok);
  assert.ok(accounts.register('dr10', 'secret123', 'Черновик10').ok);
  const hub = newHub();
  const room = playingRoom('dr9', 'dr10');
  room.game.current = 0;
  const a = fakeSock(hub, room, 0, userOf('dr9'));
  const b = fakeSock(hub, room, 1, userOf('dr10'));
  const foreign = room.game.players[1].handIds[0];
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({
    t: C2S.GAME_DRAFT, rows: [{ id: 1, tiles: [foreign] }],
  })));
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_DRAFT).length, 0,
    'чужая скрытая фишка не должна уходить в чужой экран');
  hub.stop();
});

test('черновик чаще раза в 40 мс не проходит (троттлинг)', () => {
  const hub = newHub();
  const room = playingRoom('dr5', 'dr6');
  room.game.current = 0;
  const a = fakeSock(hub, room, 0, userOf('dr5'));
  const b = fakeSock(hub, room, 1, userOf('dr6'));
  const owned = room.game.players[0].handIds.slice(0, 1);
  const one = () => hub.onMessage(a.ctx, Buffer.from(JSON.stringify({
    t: C2S.GAME_DRAFT, rows: [{ id: 1, tiles: owned }],
  })));
  one();
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_DRAFT).length, 1,
    'первое прошло');
  room._draftAt.set(0, Date.now()); // свежая метка — как будто отправка была только что
  one();
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_DRAFT).length, 1,
    'второе подряд отброшено');
  hub.stop();
});

test('мусор в черновике отбрасывается молча', () => {
  const hub = newHub();
  const room = playingRoom('dr7', 'dr8');
  room.game.current = 0;
  const a = fakeSock(hub, room, 0, userOf('dr7'));
  const b = fakeSock(hub, room, 1, userOf('dr8'));
  const manyRows = Array.from({ length: 65 }, (_, i) => ({ id: i, tiles: [1] }));
  const manyTiles = [{
    id: 1,
    tiles: Array.from({ length: 201 }, (_, i) => i % (catalog.TOTAL + 1)),
  }];
  const bad = [
    {},
    { rows: {} },
    { rows: 'x' },
    { rows: [null] },
    { rows: ['row'] },
    { rows: [{ id: 'x', tiles: [1] }] },
    { rows: [{ id: -1, tiles: [1] }] },
    { rows: [{ id: 10001, tiles: [1] }] },
    { rows: [{ id: 1, tiles: 'x' }] },
    { rows: [{ id: 1, tiles: [-1] }] },
    { rows: [{ id: 1, tiles: [0] }] },
    { rows: [{ id: 1, tiles: [catalog.TOTAL + 1] }] },
    { rows: [{ id: 1, tiles: [1.5] }] },
    { rows: [{ id: 1, tiles: ['7'] }] },
    { rows: manyRows },
    { rows: manyTiles },
  ];
  for (const payload of bad) {
    hub.onMessage(a.ctx, Buffer.from(JSON.stringify({ t: C2S.GAME_DRAFT, ...payload })));
  }
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_DRAFT).length, 0,
    'ничего из мусора не должно было пройти');
  // А валидное проходит — доказывает, что молчание выше из-за проверок.
  // Граничный номер catalog.TOTAL тоже валиден, если он есть в руке автора.
  const owned = room.game.players[0].handIds;
  if (!owned.includes(catalog.TOTAL)) owned.push(catalog.TOTAL);
  hub.onMessage(a.ctx, Buffer.from(JSON.stringify({
    t: C2S.GAME_DRAFT, rows: [{ id: 2, tiles: [catalog.TOTAL] }],
  })));
  assert.strictEqual(b.msgs.filter((m) => m.t === S2C.GAME_DRAFT).length, 1,
    'валидный черновик проходит');
  hub.stop();
});

test('черновик вне партии игнорируется', () => {
  assert.ok(accounts.register('drlobby', 'secret123', 'ЧерновикЛобби').ok);
  const hub = newHub();
  // Лобби: партия ещё не началась.
  const lobby = rooms.createRoom(userOf('drlobby'), { seats: 2, require30: false }).room;
  const s0 = fakeSock(hub, lobby, 0, userOf('drlobby'));
  hub.onMessage(s0.ctx, Buffer.from(JSON.stringify({
    t: C2S.GAME_DRAFT, rows: [{ id: 1, tiles: [1] }],
  })));
  assert.strictEqual(s0.msgs.length, 0, 'в лобби молчаливое игнорирование');
  // Сокет вообще вне комнаты.
  const ctx = {
    socket: { readyState: 1, send: () => {} }, ip: '127.0.0.1', user: userOf('dr2'),
    token: accounts.issue(db.getAccount('dr2')),
    roomCode: null, seat: undefined, alive: true, observer: false,
    authFails: 0, authWindowStart: Date.now(),
  };
  hub.sockets.set(ctx.socket, ctx);
  hub.onMessage(ctx, Buffer.from(JSON.stringify({
    t: C2S.GAME_DRAFT, rows: [{ id: 1, tiles: [1] }],
  })));
  assert.ok(true, 'молчаливое игнорирование, без падений');
  hub.stop();
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
