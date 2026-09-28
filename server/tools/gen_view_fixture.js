'use strict';

// Снимает настоящие представления партии с живого кода сервера и кладёт их
// в tests/fixtures/views.json.
//
// Зачем: views.js и scripts/net/view_builder.gd — две стороны одного
// контракта, и ничто их не связывает на этапе сборки. Переименуют поле в
// одной — и клиент молча получит нули вместо чужих фишек. Тест на
// захардкоженном JSON такое не поймает: он проверит только сам себя.
//
// Поэтому фикстура снимается с НАСТОЯЩИХ rooms.js/views.js на настоящей
// раздаче и после настоящих ходов, отправленных тем же set_table, который
// шлёт клиент. Клиентский тест собирает из неё GameState и сверяет всё,
// что сервер обещал прислать.
//
//     node server/tools/gen_view_fixture.js

const fs = require('fs');
const path = require('path');

const { Rooms } = require('../src/rooms');
const views = require('../src/views');
const catalog = require('../src/engine/catalog');

const OUT = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'views.json');

// Единственный метод, который комнаты зовут у базы. Настоящую базу ради
// снятия фикстуры поднимать незачем.
const db = { addResult() {} };

function user(id, nick) {
  return { id, nick, login: nick.toLowerCase() };
}

/** Настоящий сокет у каждого места: без этого партия не начнётся. */
function markAllConnected(room) {
  for (let i = 0; i < room.seats; i += 1) {
    room.sockets.set(i, { id: `sock-${room.code}-${i}` });
    if (room.players[i]) room.players[i].connected = true;
  }
}

/** Три фишки одного цвета с подряд идущими значениями — минимальный ряд. */
function findRun(handIds) {
  const byColor = new Map();
  for (const id of handIds) {
    const t = catalog.tile(id);
    if (t.is_joker) continue;
    if (!byColor.has(t.color)) byColor.set(t.color, []);
    byColor.get(t.color).push(t);
  }
  for (const list of byColor.values()) {
    list.sort((a, b) => a.value - b.value);
    for (let i = 0; i + 2 < list.length; i += 1) {
      const a = list[i];
      const b = list[i + 1];
      const c = list[i + 2];
      if (b.value === a.value + 1 && c.value === b.value + 1) {
        return [a.id, b.id, c.id];
      }
    }
  }
  return null;
}

function main() {
  const rooms = new Rooms(db);
  const players = [user('u1', 'Алиса'), user('u2', 'Борис'), user('u3', 'Кэрол')];

  // Раздача случайна, а ряд из трёх подряд идущих есть не в каждой руке.
  // Фикстуру переснимаем, пока не попадём: подсовывать «удобные» фишки
  // в руку нельзя — тогда снимок перестанет отражать настоящую партию.
  const ATTEMPTS = 400;
  let room = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const tryRooms = new Rooms(db);
    const made = tryRooms.createRoom(players[0], { seats: 3, require30: false, name: 'Тестовая' });
    if (!made.ok) throw new Error(`createRoom: ${made.reason}`);
    const r = made.room;
    tryRooms.joinRoom(players[1], r.code, '');
    tryRooms.joinRoom(players[2], r.code, '');
    markAllConnected(r);
    if (!tryRooms.startGame(players[0]).ok) {
      tryRooms.stop();
      continue;
    }
    // Два настоящих хода, отправленных ровно так же, как шлёт клиент: одним
    // set_table со ВСЕМ столом, а не только со своей частью. Так устроен
    // протокол — сервер сверяет присланный стол целиком и не даёт «убрать»
    // чужой ряд. Здесь это проверяется по-настоящему.
    let ok = true;
    for (let i = 0; i < 2; i += 1) {
      const seat = r.game.current;
      const run = findRun(r.game.players[seat].handIds);
      if (!run) { ok = false; break; }
      const rows = r.game.table.map((row) => ({ id: row.id, tiles: row.tileIds.slice() }));
      rows.push({ id: 0, tiles: run });
      const res = tryRooms.commitTurn(players[seat], [{ op: 'set_table', rows }]);
      if (!res.ok) throw new Error(`ход ${seat}: ${res.reason}`);
    }
    // Ходим дальше только если выложены оба ряда: иначе снимок получится
    // без начала партии, и половина проверок будет не о чем.
    if (ok && r.game.table.length === 2) {
      tryRooms.stop();
      room = r;
      break;
    }
    tryRooms.stop();
  }
  if (!room) throw new Error(`за ${ATTEMPTS} попыток не выпало двух рядов подряд`);

  // Комната, остающаяся в лобби: нужен пример не начавшейся партии.
  const spare = rooms.createRoom(players[1], { seats: 2, name: 'Свободная' });
  markAllConnected(spare.room);

  const game = room.game;
  const payload = {
    catalog: views.tileCatalog(),
    game: {
      // Все три места: у одного наш ход, у других — нет. Один снимок
      // ничего не проверяет насчёт подсветки и чужой руки.
      seat0: views.gameView(room, 0),
      seat1: views.gameView(room, 1),
      seat2: views.gameView(room, 2),
    },
    lobby: views.fullLobbyView(spare.room, 0),
    summary: views.roomSummary(spare.room, -1),
    // Что клиентский тест обязан подтвердить, посмотрев на снимки.
    expectations: {
      deckCount: game.tilesLeftInDeck(),
      tableRows: game.table.map((r) => ({ id: r.id, tiles: r.tileIds.slice() })),
      handCounts: game.players.map((p) => p.handIds.length),
      current: game.current,
      lastTurn: game.lastTurnTileIds.slice(),
      firstTurn: game.firstTurn,
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  rooms.stop();
  process.stdout.write(
    `записано ${path.relative(process.cwd(), OUT)}\n`
    + `  фишек в каталоге: ${payload.catalog.length}\n`
    + `  мест: ${payload.game.seat0.seats}, ходит: ${payload.expectations.current}\n`
    + `  в колоде: ${payload.expectations.deckCount}\n`,
  );
}

main();
