'use strict';

// Сериализация состояния для клиента. Главное правило: клиент видит только
// СВОЮ руку. Руки соперников уходят наружу исключительно числом фишек —
// иначе сервер перестаёт быть авторитетным.

const catalog = require('./engine/catalog');

function tileCatalog() {
  return catalog.CATALOG.map((t) => ({
    id: t.id, color: t.color, value: t.value, is_joker: t.is_joker,
  }));
}

/** Представление комнаты для списка комнат. */
function roomSummary(room, selfSeat) {
  const players = room.players
    .filter((p) => p !== null)
    .map((p) => ({ nick: p.nick, connected: p.connected, isBot: !!p.isBot }));
  // Занятость для списка — живыми людьми: бот-места и так видны отдельно,
  // и «партия на 1/4 с ботами» не должна выглядеть как «ждём троих».
  const humans = players.filter((p) => !p.isBot).length;
  return {
    code: room.code,
    name: room.name,
    seats: room.seats,
    require30: room.require30,
    hasPassword: !!room.passwordHash,
    host: room.seats > 0 ? (room.players[0] ? room.players[0].nick : '?') : '?',
    state: room.state,
    players,
    filled: humans,
    bots: players.filter((p) => p.isBot).length,
  };
}

/** Представление лобби (до начала партии). */
function roomLobbyView(room, selfSeat) {
  return {
    code: room.code,
    name: room.name,
    seats: room.seats,
    require30: room.require30,
    hasPassword: !!room.passwordHash,
    state: room.state,
    you: selfSeat === undefined ? -1 : selfSeat,
    isHost: selfSeat === 0,
    players: [],
  };
}

function lobbyPlayers(room) {
  const out = [];
  for (let i = 0; i < room.seats; i += 1) {
    const p = room.players[i];
    if (p === null) {
      out.push({ seat: i, empty: true, nick: '', connected: false });
    } else {
      out.push({
        seat: i, empty: false, nick: p.nick, connected: p.connected,
      });
    }
  }
  return out;
}

function fullLobbyView(room, selfSeat) {
  const v = roomLobbyView(room, selfSeat);
  v.players = lobbyPlayers(room);
  return v;
}

/**
 * Представление партии ДЛЯ КОНКРЕТНОГО ИГРОКА.
 * @param {Room} room
 * @param {number} seat  чьё это представление
 */
function gameView(room, seat) {
  const g = room.game;
  const mine = g.players[seat];
  return {
    code: room.code,
    require30: g.require30,
    seats: g.players.length,
    you: seat,
    // Своя рука целиком...
    hand: mine ? mine.handIds.slice() : [],
    // ...чужие — только количеством
    players: g.players.map((p) => ({
      seat: p.seat,
      nick: p.name,
      handCount: p.handIds.length,
      connected: p.connected,
      dropped: p.dropped,
      isBot: !!p.isBot,
      isYou: p.seat === seat,
    })),
    // Стол публичен целиком
    table: g.table.map((r) => ({ id: r.id, tileIds: r.tileIds.slice() })),
    deckCount: g.tilesLeftInDeck(),
    current: g.current,
    myTurn: g.current === seat && !g.finished,
    // Сколько секунд осталось на текущий ход (null — отсчёта нет:
    // пауза, ожидание второго игрока, партия окончена).
    turnLeft: g.finished ? null : room.turnLeft(),
    firstTurn: g.firstTurn,
    // свои ходы подсвечиваем отдельно от чужих
    turnPlaced: g.current === seat ? g.turnPlacedIds.slice() : [],
    lastTurn: g.lastTurnTileIds.slice(),
    finished: g.finished,
    winner: g.winner,
    winnerName: g.winner >= 0 ? g.players[g.winner].name : '',
  };
}

module.exports = { tileCatalog, roomSummary, fullLobbyView, gameView };
