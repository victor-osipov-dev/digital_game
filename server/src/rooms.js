'use strict';

const crypto = require('crypto');
const { config } = require('./config');
const log = require('./log');
const { GameState } = require('./engine/game_state');
const views = require('./views');
const { C2S, S2C, MAX_OPS_PER_COMMIT } = require('./protocol');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов (0/O, 1/I)

function makeCode(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function hashRoomPassword(plain) {
  if (!plain) return null;
  return crypto.createHash('sha256').update(`room:${String(plain)}`).digest('base64url');
}

class Room {
  constructor(opts) {
    this.code = opts.code;
    this.name = opts.name;
    this.seats = opts.seats;
    this.require30 = !!opts.require30;
    this.passwordHash = opts.passwordHash || null;
    this.hostSeat = 0;
    this.players = new Array(this.seats).fill(null);
    this.state = 'lobby'; // lobby | playing | finished
    this.game = null;
    this.createdMs = Date.now();
    this.lastActivityMs = Date.now();
    // seat -> {deadline, at}
    this.paused = new Map();
    this.sockets = new Map(); // seat -> socket
    this.fromQuick = !!opts.fromQuick;
  }

  seatOfUser(userId) {
    for (let i = 0; i < this.seats; i += 1) {
      if (this.players[i] && this.players[i].userId === userId) return i;
    }
    return -1;
  }

  filled() {
    return this.players.reduce((n, p) => n + (p !== null ? 1 : 0), 0);
  }

  freeSeat() {
    for (let i = 0; i < this.seats; i += 1) if (this.players[i] === null) return i;
    return -1;
  }

  isFull() { return this.freeSeat() === -1; }

  allConnected() {
    return this.players.every((p) => p !== null && p.connected);
  }

  touch() { this.lastActivityMs = Date.now(); }

  /** Есть ли игрок, ожидающий переподключения. */
  isPaused() {
    const now = Date.now();
    for (const d of this.paused.values()) if (d.deadline > now) return true;
    return false;
  }

  pauseFor(seat) {
    this.paused.set(seat, { deadline: Date.now() + config.disconnectGraceMs, at: Date.now() });
  }

  clearPause(seat) { this.paused.delete(seat); }

  /** Секунд до конца ожидания переподключения (0 = не ждём). */
  graceRemaining(seat) {
    const d = this.paused.get(seat);
    if (!d) return 0;
    return Math.max(0, Math.ceil((d.deadline - Date.now()) / 1000));
  }
}

class Rooms {
  constructor(db) {
    this.db = db;
    this.rooms = new Map();      // code -> Room
    this.quick = new Map();     // key -> {seats, require30, waiting:[userId], timer}
    this.byUser = new Map();    // userId -> code
    this.sweeper = setInterval(() => this.sweep(), config.quickMatchSweepMs);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  // ------------------------------------------------------------ комнаты

  createRoom(user, opts) {
    if (this.rooms.size >= config.maxRooms) {
      return { ok: false, reason: 'На сервере слишком много комнат, попробуйте другой' };
    }
    const seats = Math.max(2, Math.min(5, Number(opts.seats) || 2));
    let code = makeCode(5);
    for (let i = 0; i < 20 && this.rooms.has(code); i += 1) code = makeCode(5);
    if (this.rooms.has(code)) return { ok: false, reason: 'Не удалось создать код комнаты' };

    const name = String(opts.name || '').trim().slice(0, 24)
      || `Комната ${code}`;
    const room = new Room({
      code,
      name,
      seats,
      require30: opts.require30 !== false,
      passwordHash: hashRoomPassword(opts.password),
      fromQuick: !!opts.fromQuick,
    });
    this.rooms.set(code, room);
    this._seatPlayer(room, user, 0);
    log.info(`комната ${code} создана: ${seats} места, require30=${room.require30}`);
    return { ok: true, room, seat: 0 };
  }

  joinRoom(user, code, password) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) return { ok: false, reason: 'Комната не найдена' };
    if (room.state !== 'lobby') return { ok: false, reason: 'Партия уже началась' };
    if (room.passwordHash && !this._checkRoomPassword(room, password)) {
      return { ok: false, reason: 'Неверный пароль комнаты' };
    }
    const existing = room.seatOfUser(user.id);
    if (existing !== -1) return { ok: true, room, seat: existing };
    const seat = room.freeSeat();
    if (seat === -1) return { ok: false, reason: 'В комнате нет свободных мест' };
    this._seatPlayer(room, user, seat);
    return { ok: true, room, seat };
  }

  _checkRoomPassword(room, password) {
    if (!room.passwordHash) return true;
    if (!password) return false;
    const h = crypto.createHash('sha256').update(`room:${String(password)}`).digest('base64url');
    const a = Buffer.from(h);
    const b = Buffer.from(room.passwordHash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  _seatPlayer(room, user, seat) {
    room.players[seat] = {
      userId: user.id,
      login: user.login,
      nick: user.nick,
      connected: false,
      joinedMs: Date.now(),
      wins: 0,
    };
    this.byUser.set(user.id, room.code);
    room.touch();
  }

  leaveRoom(user) {
    const code = this.byUser.get(user.id);
    if (!code) return { ok: true, room: null, seat: -1 };
    const room = this.rooms.get(code);
    if (!room) { this.byUser.delete(user.id); return { ok: true, room: null, seat: -1 }; }
    const seat = room.seatOfUser(user.id);
    if (seat === -1) { this.byUser.delete(user.id); return { ok: true, room, seat: -1 }; }
    if (room.state === 'playing') {
      // Из партии не выходим молча — сначала считаем, что человек отвалился.
      // Явный выход делает leaveGame (см. hub).
      return { ok: false, reason: 'Сначала выйдите из партии' };
    }
    room.players[seat] = null;
    room.sockets.delete(seat);
    room.paused.delete(seat);
    this.byUser.delete(user.id);
    this._dropFromQuick(user.id);
    this._maybeCloseLobby(room);
    return { ok: true, room, seat };
  }

  _maybeCloseLobby(room) {
    if (room.state === 'lobby' && room.filled() <= 1) {
      this.rooms.delete(room.code);
      log.info(`комната ${room.code} удалена (осталось ${room.filled()})`);
    }
  }

  listRooms() {
    const out = [];
    for (const room of this.rooms.values()) {
      if (room.state !== 'lobby') continue;
      if (room.isFull()) continue;
      out.push(views.roomSummary(room, -1));
    }
    out.sort((a, b) => (a.filled / a.seats) - (b.filled / b.seats));
    return out;
  }

  roomOf(user) {
    const code = this.byUser.get(user.id);
    if (!code) return null;
    return this.rooms.get(code) || null;
  }

  // ------------------------------------------------------------ старт

  startGame(user) {
    const room = this.roomOf(user);
    if (!room) return { ok: false, reason: 'Вы не в комнате' };
    const seat = room.seatOfUser(user.id);
    if (seat !== room.hostSeat) return { ok: false, reason: 'Начинает хост комнаты' };
    if (room.state !== 'lobby') return { ok: false, reason: 'Партия уже идёт' };
    if (room.filled() < 2) {
      return { ok: false, reason: `Нужно минимум 2 игрока, сейчас ${room.filled()}` };
    }
    // Решили ждать заполнения ВСЕХ мест, а не играть «сколько пришло».
    if (room.filled() < room.seats) {
      return {
        ok: false,
        reason: `Занято ${room.filled()} из ${room.seats}. Дождитесь всех игроков или освободите место.`,
      };
    }
    if (!room.allConnected()) {
      return { ok: false, reason: 'Не все игроки на связи' };
    }
    const names = room.players.map((p) => (p ? p.nick : '?'));
    room.game = GameState.create(room.seats, names, room.require30);
    for (let i = 0; i < room.seats; i += 1) {
      room.game.players[i].connected = !!(room.sockets.has(i));
    }
    room.state = 'playing';
    room.paused.clear();
    room.touch();
    log.info(`комната ${room.code}: партия началась (${room.seats} игроков)`);
    return { ok: true, room, seat };
  }

  // ------------------------------------------------------------ ходы партии

  /**
   * Ход игрока: сервер применяет присланные операции к своему состоянию,
   * проверяет всё сам и либо принимает ход целиком, либо откатывает его.
   * Клиент не может «выложить» то, чего у него нет: place ищет фишку в руке
   * текущего игрока, move — в исходном ряду.
   */
  commitTurn(user, ops) {
    const room = this.roomOf(user);
    if (!room || room.state !== 'playing') return this._no('Партия не идёт');
    const seat = room.seatOfUser(user.id);
    if (seat < 0) return this._no('Вы не в этой партии', room, -1);
    const g = room.game;
    if (g.finished) return this._no('Игра окончена', room, seat);
    if (g.current !== seat) return this._no('Сейчас не ваш ход', room, seat);
    if (this._blocked(room, seat)) return this._no(this._blockedReason(room, seat), room, seat);
    if (!Array.isArray(ops) || ops.length === 0) {
      return this._no('Пустой ход', room, seat);
    }
    if (ops.length > MAX_OPS_PER_COMMIT) {
      return this._no('Слишком много операций за ход', room, seat);
    }
    for (const op of ops) {
      if (!op || typeof op !== 'object') return this._no('Мусор в ходе', room, seat);
    }

    g.beginTurn();
    if (!g.applyOps(ops)) {
      g.rollback();
      return this._no(
        'Ход отклонён: нельзя переместить эти числа (проверьте, что они ещё на столе)',
        room, seat, true,
      );
    }
    const result = g.endTurn();
    if (!result.ok) {
      // Обязательный откат: иначе невалидный стол уедет в следующий ход.
      g.rollback();
      return {
        ok: false,
        reason: String(result.reason || 'Ход отклонён'),
        errors: result.errors || [],
        hard: true,
        room,
        seat,
      };
    }
    g.commit();
    room.touch();
    this.db.addResult(room.players[seat].login, result.win === true);
    return { ok: true, room, seat, win: result.win === true };
  }

  drawFor(user) {
    return this._simpleTurn(user, (g) => g.drawFromDeck(), 'Взять');
  }

  skipFor(user) {
    return this._simpleTurn(user, (g) => g.skipTurn(), 'Пропуск');
  }

  /** Отказ с адресом комнаты: хабу нужно знать, кому слать откат. */
  _no(reason, room = null, seat = -1, hard = false) {
    return { ok: false, reason, hard, room, seat, errors: [] };
  }

  _simpleTurn(user, fn, label) {
    const room = this.roomOf(user);
    if (!room || room.state !== 'playing') return this._no('Партия не идёт');
    const seat = room.seatOfUser(user.id);
    if (seat < 0) return this._no('Вы не в этой партии', room, -1);
    const g = room.game;
    if (g.finished) return this._no('Игра окончена', room, seat);
    if (g.current !== seat) return this._no('Сейчас не ваш ход', room, seat);
    if (this._blocked(room, seat)) return this._no(this._blockedReason(room, seat), room, seat);
    g.beginTurn();
    const r = fn(g);
    if (!r.ok) {
      g.rollback();
      return this._no(String(r.reason || `${label}: отказ`), room, seat, true);
    }
    g.commit();
    room.touch();
    return { ok: true, room, seat };
  }

  _blocked(room, seat) {
    if (room.isPaused()) return true;
    return false;
  }

  _blockedReason(room, seat) {
    const waits = [];
    for (const [s, d] of room.paused) {
      if (d.deadline > Date.now()) waits.push(`${room.players[s].nick} (${Math.ceil((d.deadline - Date.now()) / 1000)} с)`);
    }
    if (waits.length > 0) {
      return `Ждём переподключения: ${waits.join(', ')}`;
    }
    return 'Игра на паузе';
  }

  // ------------------------------------------------------------ обрывы

  /** Сокет отвалился. В лобби — сразу освобождаем место, в партии — ждём. */
  onDisconnect(user) {
    const code = this.byUser.get(user.id);
    if (!code) return null;
    const room = this.rooms.get(code);
    if (!room) return null;
    const seat = room.seatOfUser(user.id);
    if (seat < 0) return room;
    room.sockets.delete(seat);
    if (room.state === 'lobby') {
      room.players[seat] = null;
      this.byUser.delete(user.id);
      this._dropFromQuick(user.id);
      this._maybeCloseLobby(room);
      return room;
    }
    const p = room.players[seat];
    if (p) p.connected = false;
    if (room.game) {
      const gp = room.game.players[seat];
      if (gp) gp.connected = false;
    }
    room.pauseFor(seat);
    log.info(`комната ${room.code}: ${p ? p.nick : '?'} отключился, ждём ${config.disconnectGraceMs / 1000} с`);
    return room;
  }

  /**
   * Игрок вернулся.
   *
   * claim(room, seat, socket) обязан не просто записать сокет, а ещё и
   * вытеснить прежнего владельца места (см. Hub.claimSeat). Если перепривязка
   * будет молчаливой, закрытие старого сокета выбьет игрока из комнаты,
   * а комнату с одним игроком сервер удаляет.
   */
  onReconnect(user, socket, claim) {
    const code = this.byUser.get(user.id);
    if (!code) return null;
    const room = this.rooms.get(code);
    if (!room) return null;
    const seat = room.seatOfUser(user.id);
    if (seat < 0) return null;
    (claim || ((rm, st, sk) => rm.sockets.set(st, sk)))(room, seat, socket);
    room.clearPause(seat);
    const p = room.players[seat];
    if (p) p.connected = true;
    if (room.game) {
      const gp = room.game.players[seat];
      if (gp) {
        gp.connected = true;
        // Человек мог отвалиться посреди своего хода — откатываем черновик,
        // чтобы он начал ход заново с чистого стола.
        if (room.game.current === seat && room.game.turnPlacedIds.length > 0) {
          room.game.rollback();
        }
      }
    }
    room.touch();
    log.info(`комната ${room.code}: ${p ? p.nick : '?'} снова на связи`);
    return { room, seat };
  }

  /** Время ожидания переподключения вышло — игрок выбывает из партии. */
  expireDisconnects() {
    const now = Date.now();
    const touched = [];
    for (const room of this.rooms.values()) {
      if (room.state !== 'playing') continue;
      for (const [seat, d] of Array.from(room.paused.entries())) {
        if (d.deadline > now) continue;
        room.paused.delete(seat);
        if (room.game) room.game.dropPlayer(seat);
        log.info(`комната ${room.code}: место ${seat} потеряно, игрок не вернулся`);
        touched.push(room);
      }
    }
    return touched;
  }

  /** Явный выход из партии. */
  leaveGame(user) {
    const room = this.roomOf(user);
    if (!room) return { ok: true, room: null };
    if (room.state === 'lobby') {
      return { ok: true, room, lobby: true };
    }
    const seat = room.seatOfUser(user.id);
    if (seat >= 0) {
      room.sockets.delete(seat);
      room.players[seat] = null;
      room.paused.delete(seat);
      if (room.game) room.game.dropPlayer(seat);
    }
    this.byUser.delete(user.id);
    this._dropFromQuick(user.id);
    this._cleanupRoom(room);
    return { ok: true, room, lobby: false };
  }

  _cleanupRoom(room) {
    if (room.state === 'playing') {
      // Партия продолжается без ушедших. Убираем комнату, когда играть
      // больше некому или все выбыли.
      const alive = room.game.players.filter((p) => !p.dropped).length;
      if (alive < 2) {
        this.rooms.delete(room.code);
        log.info(`комната ${room.code} закрыта, играть некому`);
      } else if (room.game.finished) {
        this.rooms.delete(room.code);
      }
      return;
    }
    this._maybeCloseLobby(room);
  }

  // ------------------------------------------------------------ быстрый матч

  quickKey(seats, require30) { return `${seats}:${require30 ? 1 : 0}`; }

  quickJoin(user, opts) {
    const seats = Math.max(2, Math.min(5, Number(opts.seats) || 2));
    const require30 = opts.require30 !== false;
    const key = this.quickKey(seats, require30);
    let q = this.quick.get(key);
    if (!q) {
      q = { key, seats, require30, waiting: [], timer: null, createdMs: Date.now() };
      this.quick.set(key, q);
    }
    if (!q.waiting.includes(user.id)) q.waiting.push(user.id);
    this._armQuickTimer(q);
    return { ok: true, queue: this.quickStateFor(user) };
  }

  quickLeave(user) {
    this._dropFromQuick(user.id);
    return { ok: true, queue: this.quickStateFor(user) };
  }

  _dropFromQuick(userId) {
    for (const q of this.quick.values()) {
      const i = q.waiting.indexOf(userId);
      if (i !== -1) q.waiting.splice(i, 1);
      if (q.waiting.length === 0 && q.timer) {
        clearTimeout(q.timer);
        q.timer = null;
      }
    }
  }

  quickStateFor(user) {
    for (const q of this.quick.values()) {
      if (q.waiting.includes(user.id)) {
        return { inQueue: true, key: q.key, seats: q.seats, require30: q.require30, waiting: q.waiting.length };
      }
    }
    return { inQueue: false, queues: Array.from(this.quick.values()).map((q) => ({
      key: q.key, seats: q.seats, require30: q.require30, waiting: q.waiting.length,
    })) };
  }

  _armQuickTimer(q) {
    if (q.timer) return;
    q.timer = setTimeout(() => {
      q.timer = null;
      this._tryFormQuick(q);
    }, config.quickMatchWaitMs);
    if (q.timer.unref) q.timer.unref();
  }

  /**
   * Собираем комнату из очереди. Набираем ровно seats человек; если в
   * очереди их больше, берём тех, кто ждёт дольше всех.
   */
  _tryFormQuick(q) {
    if (q.waiting.length < 2) return null;
    const need = q.seats;
    const take = q.waiting.slice(0, need);
    if (take.length < 2) return null;
    for (const uid of take) {
      const i = q.waiting.indexOf(uid);
      if (i !== -1) q.waiting.splice(i, 1);
    }
    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
    if (q.waiting.length > 0) this._armQuickTimer(q);

    const code = makeCode(5);
    const room = new Room({
      code,
      name: `Быстрый матч ${q.seats}`,
      seats: q.seats,
      require30: q.require30,
      fromQuick: true,
    });
    this.rooms.set(code, room);
    for (let i = 0; i < q.seats; i += 1) {
      if (take[i] === undefined) { room.players[i] = null; continue; }
      const user = this.userResolver ? this.userResolver(take[i]) : null;
      if (!user) { room.players[i] = null; continue; }
      this._seatPlayer(room, user, i);
    }
    log.info(`быстрый матч ${q.key}: собрана комната ${code} на ${q.seats}`);
    return { room, seats: take };
  }

  /** Вызывается из хаба: у пользователя есть комната? */
  setUserResolver(fn) { this.userResolver = fn; }

  // ------------------------------------------------------------ уборка

  sweep() {
    const now = Date.now();
    for (const q of this.quick.values()) {
      if (q.waiting.length === 0) {
        this.quick.delete(q.key);
        continue;
      }
      this._tryFormQuick(q);
    }
    for (const room of Array.from(this.rooms.values())) {
      if (room.state === 'lobby' && now - room.lastActivityMs > config.roomIdleTtlMs) {
        this.rooms.delete(room.code);
        log.info(`комната ${room.code} удалена по таймауту простоя`);
      }
    }
  }
}

module.exports = { Rooms, Room, makeCode, hashRoomPassword };
