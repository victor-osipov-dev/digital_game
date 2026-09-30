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
    // Ожидание второго живого игрока: в партии остался один человек.
    // Пока true — никто не ходит, боты молчат, место ушедшего свободно
    // и может занять как вернувшийся, так и новый игрок.
    this.waiting = false;
    this.sockets = new Map(); // seat -> socket
    this.fromQuick = !!opts.fromQuick;
    // Таймер «дозабрать пустые места ботами» (ставится в лобби, чистится
    // при старте). Боты ходят по room._botTimer из хаба.
    this.startTimer = null;
    // Отсчёт текущего хода: мс-дедлайн. null — отсчёта нет (пауза,
    // ожидание второго игрока, партия кончена); ставится и гасится хабом,
    // при каждом завершённом ходе сбрасывается — see hub._scheduleTurn.
    this.turnDeadlineMs = null;
    // Чей это дедлайн (g.current на момент установки): если текущий
    // сменился без завершения хода, чужой дедлайн пересоздаётся.
    this.turnDeadlineFor = null;
    this._turnTimer = null;
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
    // Пока ждём переподключения, ходить некому — отсчёт гасим. Возобновит
    // его хаб, как только пауза снимется (maybeRunBots -> _scheduleTurn).
    this.turnDeadlineMs = null;
  }

  clearPause(seat) { this.paused.delete(seat); }

  /** Секунд до конца отсчёта текущего хода (null — отсчёта нет). */
  turnLeft() {
    if (this.turnDeadlineMs == null) return null;
    return Math.max(0, Math.ceil((this.turnDeadlineMs - Date.now()) / 1000));
  }

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
    for (const room of this.rooms.values()) {
      if (room.startTimer) { clearTimeout(room.startTimer); room.startTimer = null; }
      if (room._turnTimer) { clearTimeout(room._turnTimer); room._turnTimer = null; }
    }
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
    if (room.passwordHash && !this._checkRoomPassword(room, password)) {
      return { ok: false, reason: 'Неверный пароль комнаты' };
    }
    const existing = room.seatOfUser(user.id);
    if (existing !== -1) {
      // Мягкий выход не отбирает место: вернувшемуся отдаём его же стул.
      return { ok: true, room, seat: existing, playing: room.state === 'playing' };
    }
    if (room.state === 'playing') {
      // В идущую партию можно войти на освободившееся место или взамен
      // бота. Сервер сам заменяет бота человеком.
      let seat = room.freeSeat();
      if (seat === -1) {
        const bots = this._botSeats(room);
        if (bots.length === 0) return { ok: false, reason: 'В комнате нет свободных мест' };
        seat = bots[0];
      }
      this._seatHumanIntoPlaying(room, user, seat);
      // Второй живой пришёл (или вернулся) — ожидание кончилось,
      // хабу остаётся расслать состояние и запустить ботов.
      if (room.waiting && this.humanCount(room) >= 2) {
        room.waiting = false;
        log.info(`комната ${room.code}: ${user.nick} занял место ${seat} — ожидание второго снято`);
      }
      return { ok: true, room, seat, playing: true };
    }
    const seat = room.freeSeat();
    if (seat === -1) return { ok: false, reason: 'В комнате нет свободных мест' };
    this._seatPlayer(room, user, seat);
    if (room.isFull()) this._launchIfFull(room);
    else this._armStart(room);
    // Последним вошедшим заполнил комнату — она уже играет, и личным ответом
    // хаб отдаст ему не лобби, а партию.
    return { ok: true, room, seat, playing: room.state === 'playing' };
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
      isBot: false,
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
      // Мягкий выход из партии. Место остаётся за игроком (и он числится
      // в byUser): вход в аккаунт не должен принудительно возвращать его,
      // но сам человек может вернуться — game.rejoin или room.join. Если
      // не вернётся за grace, место уйдёт обычным expireDisconnects.
      room.sockets.delete(seat);
      const p = room.players[seat];
      if (p) p.connected = false;
      if (room.game) {
        const gp = room.game.players[seat];
        if (gp) gp.connected = false;
      }
      room.pauseFor(seat);
      room.touch();
      return { ok: true, room, seat, soft: true };
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

  // ------------------------------------------------------------ боты и автостарт

  /** Живые люди (боты в «занятости» не считаются). */
  humanCount(room) {
    let n = 0;
    for (const p of room.players) if (p !== null && !p.isBot) n += 1;
    return n;
  }

  _botSeats(room) {
    const out = [];
    for (let i = 0; i < room.seats; i += 1) {
      if (room.players[i] && room.players[i].isBot) out.push(i);
    }
    return out;
  }

  _hasBotSeat(room) {
    for (let i = 0; i < room.seats; i += 1) {
      if (room.players[i] && room.players[i].isBot) return true;
    }
    return false;
  }

  /** Запись «За бота сидит бот» без привязки к аккаунту. */
  _seatBotAt(room, seat) {
    room.players[seat] = {
      userId: null,
      login: '',
      nick: `Бот ${seat + 1}`,
      connected: false,
      joinedMs: Date.now(),
      wins: 0,
      isBot: true,
    };
  }

  _fillBots(room) {
    for (let i = 0; i < room.seats; i += 1) {
      if (room.players[i] !== null) continue;
      this._seatBotAt(room, i);
    }
  }

  /**
   * Человек занял место в идущей партии (пустое или бота). Перезаписываем
   * обоих: и запись комнаты, и (через _seatHumanIntoPlaying) игрока партии.
   */
  _seatHumanIntoPlaying(room, user, seat) {
    const wasBot = !!(room.players[seat] && room.players[seat].isBot);
    this._seatPlayer(room, user, seat);
    if (room.game && room.game.players[seat]) {
      const gp = room.game.players[seat];
      gp.name = user.nick;
      gp.connected = false;
      gp.dropped = false;
      gp.isBot = false;
    }
    log.info(`комната ${room.code}: ${user.nick} вошёл в идущую партию (место ${seat}, было ботом: ${wasBot})`);
  }

  /**
   * Место переходит боту: человек не вернулся за время ожидания. Место не
   * освобождается (партия полна), аккаунт отвязывается от комнаты.
   */
  _botifySeat(room, seat) {
    const p = room.players[seat];
    if (p && p.userId !== null && p.userId !== undefined) this.byUser.delete(p.userId);
    this._seatBotAt(room, seat);
    if (room.game && room.game.players[seat] && !room.game.players[seat].dropped) {
      const gp = room.game.players[seat];
      gp.name = room.players[seat].nick;
      gp.connected = false;
      gp.dropped = false;
      gp.isBot = true;
      // Бот начинает ход с чистого стола: недоконченный черновик не его.
      if (room.game.current === seat && room.game.turnPlacedIds.length > 0) {
        room.game.rollback();
      }
    }
    room.touch();
  }

  /**
   * Поставить таймер «начать партию с ботами». Ставится только когда в лобби
   * два и более живых игрока и комната ещё не заполнена; полная комната
   * стартует сразу через _launchIfFull.
   */
  _armStart(room) {
    if (room.state !== 'lobby') return;
    if (this.humanCount(room) < 2) return;
    if (room.startTimer) return;
    room.startTimer = setTimeout(() => {
      room.startTimer = null;
      this._launchGame(room);
    }, config.botFillWaitMs);
    if (room.startTimer.unref) room.startTimer.unref();
  }

  _launchIfFull(room) {
    if (room.state !== 'lobby') return;
    if (room.filled() < room.seats) return;
    if (this.humanCount(room) < 2) return;
    this._launchGame(room);
  }

  /**
   * Общий путь старта: из таймера, из заполнения, из startGame, из быстрой
   * очереди. Добирает пустые места ботами, создаёт партию и зовёт onPlay —
   * хаб на нём рассылает состояние и запускает ботов.
   */
  _launchGame(room) {
    if (room.state !== 'lobby') return { ok: false, reason: 'Партия уже началась' };
    // Таймер мог сработать после удаления комнаты (sweep/выход) — не стартуем.
    if (this.rooms.get(room.code) !== room) return { ok: false, reason: 'Комнаты больше нет' };
    const humans = this.humanCount(room);
    if (humans < 2) return { ok: false, reason: 'Нужно минимум 2 игрока' };
    if (room.startTimer) { clearTimeout(room.startTimer); room.startTimer = null; }
    this._fillBots(room);
    const names = room.players.map((p) => (p ? p.nick : '?'));
    room.game = GameState.create(room.seats, names, room.require30);
    for (let i = 0; i < room.seats; i += 1) {
      const gp = room.game.players[i];
      const p = room.players[i];
      gp.connected = !!(room.sockets.has(i)) && !p.isBot;
      gp.isBot = !!p.isBot;
    }
    room.state = 'playing';
    room.paused.clear();
    room.touch();
    log.info(`комната ${room.code}: партия началась (людей ${humans} из ${room.seats} мест, ботов добираем)`);
    if (typeof this.onPlay === 'function') this.onPlay(room);
    return { ok: true, room };
  }

  listRooms() {
    const out = [];
    for (const room of this.rooms.values()) {
      if (room.state === 'lobby') {
        if (room.isFull()) continue;
      } else if (room.state !== 'playing'
          || (room.freeSeat() === -1 && !this._hasBotSeat(room))) {
        // В идущую партию показываем только то, куда ещё можно войти:
        // пустое место (ждущая второго комната) или место бота. Партия
        // без единого свободного места в список не попадает.
        continue;
      }
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
    if (this.humanCount(room) < 2) {
      return { ok: false, reason: `Нужно минимум 2 игрока, сейчас ${this.humanCount(room)}` };
    }
    // Раньше ждали заполнения ВСЕХ мест и всех на связи. Теперь пустые места
    // на старте занимают боты, а таймер автостарта их доберёт и без кнопки.
    return this._launchGame(room);
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
    // Ход кончился — отсчёт прежнего игрока больше не нужен: новый запустит
    // хаб (maybeRunBots -> _scheduleTurn), когда дойдёт до рассылки.
    room.turnDeadlineMs = null;
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
    room.turnDeadlineMs = null;
    return { ok: true, room, seat };
  }

  _blocked(room, seat) {
    if (room.waiting) return true;
    if (room.isPaused()) return true;
    return false;
  }

  _blockedReason(room, seat) {
    if (room.waiting) return 'Ждём второго игрока';
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

  /**
   * Время ожидания переподключения вышло. Дальше — по числу живых людей
   * за столом: двое и больше — место занимает бот и партия продолжается;
   * один — включается ожидание второго, а место ушедшего освобождается;
   * ноль — комнате конец.
   */
  expireDisconnects() {
    const now = Date.now();
    const touched = [];
    for (const room of this.rooms.values()) {
      if (room.state !== 'playing') continue;
      for (const [seat, d] of Array.from(room.paused.entries())) {
        if (d.deadline > now) continue;
        room.paused.delete(seat);
        const p = room.players[seat];
        if (!p) continue;
        // О конца партии судить нечего: результат уже подведён, место
        // боту — просто чтобы «пустых» фишек не осталось в представлении.
        if (room.game && room.game.finished) {
          this._botifySeat(room, seat);
          log.info(`комната ${room.code}: место ${seat} занято ботом (партия окончена)`);
          touched.push(room);
          continue;
        }
        const others = this.humanCount(room) - (p && !p.isBot ? 1 : 0);
        if (others === 0) {
          // Уходить «с концами» имеет право последний живой — за ним
          // держаться больше некому, комната удаляется.
          this._deleteRoom(room, 'остался один и ушёл');
          touched.push(room);
          break;
        }
        if (others >= 2) {
          this._botifySeat(room, seat);
          log.info(`комната ${room.code}: место ${seat} занято ботом (игрок не вернулся)`);
          touched.push(room);
          continue;
        }
        // Остался один живой: ждём второго. Место ушедшего освобождаем —
        // держать его сверх срока нельзя, иначе комната с одним
        // свободным местом, занятым бы ушедшим, останется непроходимой.
        this._freeExpiredSeat(room, seat);
        room.waiting = true;
        log.info(`комната ${room.code}: остался один игрок — ждём второго (место ${seat} свободно)`);
        touched.push(room);
      }
    }
    return touched;
  }

  /** Освободить место по превышению срока: аккаунт отвязывается, место пустеет. */
  _freeExpiredSeat(room, seat) {
    const p = room.players[seat];
    if (!p) return;
    if (p.userId !== null && p.userId !== undefined) {
      this.byUser.delete(p.userId);
      this._dropFromQuick(p.userId);
    }
    room.players[seat] = null;
    room.sockets.delete(seat);
    room.touch();
  }

  /** Удалить комнату и отвязать всех, кто в ней ещё числится. */
  _deleteRoom(room, why) {
    for (const p of room.players) {
      if (p && p.userId !== null && p.userId !== undefined) {
        this.byUser.delete(p.userId);
        this._dropFromQuick(p.userId);
      }
    }
    // Сокетов в комнате больше нет: иначе рассылка после уборки поедет
    // живым людям в уже несуществующую партию.
    room.sockets.clear();
    if (room.startTimer) {
      clearTimeout(room.startTimer);
      room.startTimer = null;
    }
    if (room._turnTimer) {
      clearTimeout(room._turnTimer);
      room._turnTimer = null;
    }
    this.rooms.delete(room.code);
    log.info(`комната ${room.code} удалена (${why})`);
  }

  /** Явный ПОЛНЫЙ выход из комнаты: место освобождается сразу, в любом
   *  состоянии (лобби или идущая партия). Мягкий выход — leaveRoom; сюда
   *  ходят, когда игрок не хочет, чтобы его возвращали в комнату вообще. */
  leaveGame(user) {
    const room = this.roomOf(user);
    if (!room) return { ok: true, room: null };
    const seat = room.seatOfUser(user.id);
    if (seat >= 0) {
      room.sockets.delete(seat);
      room.players[seat] = null;
      room.paused.delete(seat);
      if (room.game) {
        room.game.dropPlayer(seat);
        // Выбывший мог быть текущим: чужой дедлайн в отсчёте остался бы.
        room.turnDeadlineMs = null;
      }
    }
    this.byUser.delete(user.id);
    this._dropFromQuick(user.id);
    this._cleanupRoom(room);
    return { ok: true, room, lobby: room.state === 'lobby' };
  }

  /** Комната (лобби или партия), в которой игрок до сих пор числится, —
   *  только для чтения. Возврата сюда НЕТ: вернуть игрока — его решение. */
  stuckRoom(user) {
    const code = this.byUser.get(user.id);
    if (!code) return null;
    const room = this.rooms.get(code);
    if (!room) return null;
    const seat = room.seatOfUser(user.id);
    if (seat < 0) return null;
    return { room, seat };
  }

  _cleanupRoom(room) {
    if (room.state === 'playing') {
      if (room.game && room.game.finished) {
        this._deleteRoom(room, 'партия окончена');
        return;
      }
      const humans = this.humanCount(room);
      if (humans === 0) {
        this._deleteRoom(room, 'играть некому');
        return;
      }
      if (humans === 1 && !room.waiting) {
        // Последний вышел из двух — второй остался один: не закрываем
        // за ним, а включаем ожидание. Полная комната при этом не
        // потерялась: ушедшее место освободилось (выход полный).
        room.waiting = true;
        log.info(`комната ${room.code}: один игрок — ждём второго`);
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
