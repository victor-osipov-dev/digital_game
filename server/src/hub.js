'use strict';

const { WebSocketServer } = require('ws');
const { config } = require('./config');
const log = require('./log');
const { C2S, S2C, RID_FIELD, MAX_MESSAGE_BYTES } = require('./protocol');
const views = require('./views');
const { planGame } = require('./engine/bot');

/**
 * Что может соединение-наблюдатель (lobby.open).
 *
 * Наблюдатель — короткая связь, которой клиент читает список комнат с
 * чужого сервера. Ему нужен вход (rooms.list только вошедшим), но не
 * нужно право что-то менять. Белый список, а не чёрный: команда,
 * добавленная в сервер позже, по умолчанию наблюдателю недоступна.
 */
const OBSERVER_ALLOWED = [C2S.ROOMS_LIST, C2S.SERVERS_LIST, C2S.PING];

/**
 * Хаб: держит сокеты, гоняет сообщения между клиентом и Rooms/Accounts.
 *
 * Правило безопасности: наружу уходит только то, что собрал views.js.
 * Руки соперников клиент не получает ни при каких обстоятельствах.
 */
class Hub {
  constructor({ db, accounts, cluster, rooms }) {
    this.db = db;
    this.accounts = accounts;
    this.cluster = cluster;
    this.rooms = rooms;
    this.sockets = new Map(); // socket -> {socket, ip, user, roomCode, seat, alive, authFails}
    this.ipCounts = new Map();
    this.wss = null;
    this.clock = setInterval(() => this.tick(), config.pingIntervalMs);
    if (this.clock.unref) this.clock.unref();
    this.drain = setInterval(() => this.drainExpired(), 5000);
    if (this.drain.unref) this.drain.unref();
  }

  attach(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });
    this.wss.on('connection', (socket, req) => this.onConnection(socket, req));
    log.info(`ws слушает, лимит сообщения ${MAX_MESSAGE_BYTES / 1024} КБ`);
  }

  stop() {
    if (this.clock) clearInterval(this.clock);
    if (this.drain) clearInterval(this.drain);
    if (this.wss) this.wss.close();
    for (const room of this.rooms.rooms.values()) {
      if (room._botTimer) { clearTimeout(room._botTimer); room._botTimer = null; }
    }
  }

  // ------------------------------------------------------------ сокеты

  onConnection(socket, req) {
    const ip = clientIp(req);
    const count = this.ipCounts.get(ip) || 0;
    if (count >= config.maxSocketsPerIp) {
      log.warn(`отказ по лимиту сокетов с ${ip} (${count})`);
      try { socket.close(1008, 'too many connections'); } catch (_) { /* уже закрыт */ }
      return;
    }
    this.ipCounts.set(ip, count + 1);

    const ctx = {
      socket,
      ip,
      user: null,
      alive: true,
      authFails: 0,
      authWindowStart: Date.now(),
      // Сокет вытеснен более новым соединением того же игрока. Такой сокет
      // не имеет права ничего трогать при закрытии: место в комнате теперь
      // не его, и выход из комнаты на его закрытии выбил бы игрока.
      superseded: false,
      // Соединение только для чтения (lobby.open): см. OBSERVER_ALLOWED.
      observer: false,
    };
    this.sockets.set(socket, ctx);
    log.debug(`подключение с ${ip} (всего ${this.sockets.size})`);

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.onMessage(ctx, data);
    });
    socket.on('close', () => this.onClose(ctx));
    socket.on('error', (e) => log.debug(`ошибка сокета ${ip}: ${e.message}`));
    socket.on('pong', () => { ctx.alive = true; });

    this.send(ctx, {
      t: S2C.HELLO,
      server: {
        id: config.serverId,
        name: config.serverName,
        region: config.region,
        host: config.publicHost,
        port: config.publicPort,
        protocol: config.protocolVersion,
      },
      catalog: views.tileCatalog(),
      graceMs: config.disconnectGraceMs,
    });
  }

  onClose(ctx) {
    this.sockets.delete(ctx.socket);
    this.ipCounts.set(ctx.ip, Math.max(0, (this.ipCounts.get(ctx.ip) || 1) - 1));
    if (!ctx.user) return;
    // Наблюдатель сокетом не владеет. Если вызвать здесь onDisconnect, то
    // закрытие проходной связи выбило бы настоящего игрока из его комнаты
    // и удалило её. Проверка обязана стоять именно тут, а не в rooms.js:
    // иначе на сервере пришлось бы знать про режим наблюдателя.
    if (ctx.observer) return;
    // Место в столе занял более новый сокет того же игрока: закрытие этого
    // не означает ухода из комнаты. Без проверки игрок, вернувшийся после
    // обрыва, терял комнату в момент возврата.
    if (ctx.superseded) return;
    const room = this.rooms.onDisconnect(ctx.user);
    log.info(`${ctx.user.nick} отключился${room ? ` (комната ${room.code})` : ''}`);
    if (room) this.broadcastRoom(room, null);
  }

  // ------------------------------------------------------------ сообщения

  onMessage(ctx, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch (_) {
      this.send(ctx, { t: S2C.GAME_ERROR, reason: 'Некорректное сообщение' });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      this.send(ctx, { t: S2C.GAME_ERROR, reason: 'Некорректное сообщение' });
      return;
    }
    ctx.alive = true;
    const rid = msg[RID_FIELD];

    // Аутентифицированные команды
    const needsAuth = ![
      C2S.REGISTER, C2S.LOGIN, C2S.RESUME, C2S.LOBBY_OPEN,
      C2S.SERVERS_LIST, C2S.PING,
    ].includes(msg.t);
    if (needsAuth && !ctx.user) {
      this.reply(ctx, { t: S2C.AUTH_ERR, reason: 'Сначала войдите' }, rid);
      return;
    }

    // Наблюдатель не имеет права менять состояние. Смысл в том, чтобы связь,
    // которой читают список комнат с чужого сервера, не могла ни войти в
    // комнату, ни создать, ни выйти. Ничего из этого ей и не нужно, а
    // вот посторонний вход под именем игрока — источник настоящих бед.
    if (ctx.observer && !OBSERVER_ALLOWED.includes(msg.t)) {
      this.reply(ctx, { t: S2C.GAME_ERROR, reason: 'Соединение только для чтения' }, rid);
      return;
    }

    // Ограничение попыток входа
    if ([C2S.REGISTER, C2S.LOGIN].includes(msg.t) && !this.allowAuth(ctx)) {
      this.reply(ctx, { t: S2C.AUTH_ERR, reason: 'Слишком много попыток. Подождите минуту.' }, rid);
      return;
    }

    try {
      this.route(ctx, msg, rid);
    } catch (e) {
      log.error(`обработка ${msg.t} упала: ${e.stack || e.message}`);
      this.reply(ctx, { t: S2C.GAME_ERROR, reason: 'Внутренняя ошибка сервера' }, rid);
    }
  }

  allowAuth(ctx) {
    const now = Date.now();
    if (now - ctx.authWindowStart > 60000) {
      ctx.authWindowStart = now;
      ctx.authFails = 0;
    }
    if (ctx.authFails >= config.authAttemptsPerMinute) return false;
    ctx.authFails += 1;
    return true;
  }

  route(ctx, msg, rid) {
    switch (msg.t) {
      // ------------------------------------------------------- вход
      case C2S.REGISTER: {
        const r = this.accounts.register(msg.login, msg.password, msg.nick);
        if (!r.ok) { this.failAuth(ctx, r.reason, rid); break; }
        this.succeedAuth(ctx, r, 'Аккаунт создан', rid);
        // Новый аккаунт сразу уходит соседям, чтобы вход работал на обоих
        // серверах без ожидания минутной сверки.
        this.cluster.push().catch(() => {});
        break;
      }
      case C2S.LOGIN: {
        const r = this.accounts.login(msg.login, msg.password);
        if (!r.ok) { this.failAuth(ctx, r.reason, rid); break; }
        this.succeedAuth(ctx, r, null, rid);
        break;
      }
      case C2S.RESUME: {
        const r = this.accounts.resume(msg.token);
        if (!r.ok) { this.failAuth(ctx, r.reason, rid); break; }
        this.succeedAuth(ctx, r, null, rid);
        break;
      }
      case C2S.LOBBY_OPEN: {
        // Наблюдатель: может ТОЛЬКО читать. Нужен для списка комнат с
        // чужого сервера — клиент спрашивает каждый сервер отдельной
        // короткой связью (у него одно основное соединение на свой сервер).
        const r = this.accounts.resume(msg.token);
        if (!r.ok) { this.failAuth(ctx, r.reason, rid); break; }
        ctx.user = {
          id: r.account.login_ci,
          account: r.account,
          login: r.account.login,
          nick: r.account.nick,
        };
        ctx.observer = true;
        this.reply(ctx, { t: S2C.AUTH_OK, user: this.accounts.publicView(r.account) }, rid);
        break;
      }
      case C2S.LOGOUT: {
        if (ctx.user) this.accounts.logout(msg.token || '');
        ctx.user = null;
        this.reply(ctx, { t: S2C.AUTH_ERR, reason: 'Вы вышли' }, rid);
        break;
      }
      case C2S.CHANGE_PASSWORD: {
        const r = this.accounts.changePassword(ctx.user.account, msg.old, msg.new);
        if (!r.ok) { this.reply(ctx, { t: S2C.GAME_ERROR, reason: r.reason }, rid); break; }
        ctx.user.account = r.account;
        this.cluster.push().catch(() => {});
        this.reply(ctx, { t: S2C.AUTH_OK, token: r.token, user: this.accounts.publicView(r.account) }, rid);
        break;
      }
      case C2S.CHANGE_NICK: {
        const r = this.accounts.changeNick(ctx.user.account, msg.nick);
        if (!r.ok) { this.reply(ctx, { t: S2C.GAME_ERROR, reason: r.reason }, rid); break; }
        ctx.user.account = r.account;
        this.cluster.push().catch(() => {});
        this.reply(ctx, { t: S2C.AUTH_OK, user: this.accounts.publicView(r.account) }, rid);
        break;
      }

      // ------------------------------------------------------- кластер
      case C2S.SERVERS_LIST: {
        this.reply(ctx, { t: S2C.SERVERS_LIST, servers: this.cluster.registry() }, rid);
        break;
      }
      case C2S.ROOMS_LIST: {
        this.reply(ctx, {
          t: S2C.ROOMS_LIST, rooms: this.rooms.listRooms(), server: this.selfPublic(),
        }, rid);
        break;
      }

      // ------------------------------------------------------- комнаты
      case C2S.ROOM_CREATE: {
        const r = this.rooms.createRoom(ctx.user, msg);
        if (!r.ok) { this.reply(ctx, { t: S2C.GAME_ERROR, reason: r.reason }, rid); break; }
        this.attachSeat(ctx, r.room, r.seat);
        this.reply(ctx, { t: S2C.ROOM_STATE, room: views.fullLobbyView(r.room, r.seat) }, rid);
        this.broadcastRoom(r.room, r.seat);
        break;
      }
      case C2S.ROOM_JOIN: {
        const r = this.rooms.joinRoom(ctx.user, msg.code, msg.password);
        if (!r.ok) { this.reply(ctx, { t: S2C.GAME_ERROR, reason: r.reason }, rid); break; }
        this.attachSeat(ctx, r.room, r.seat);
        if (r.playing) {
          // Вход в идущую партию: личным ответом уходит уже само состояние
          // партии (с рукой этого игрока), а не лобби. Иначе клиент показал
          // бы лобби и потребовал бы «нажать старт» в идущей игре.
          this.pushGameState(r.room, r.seat, rid);
        } else {
          this.reply(ctx, { t: S2C.ROOM_STATE, room: views.fullLobbyView(r.room, r.seat) }, rid);
        }
        this.broadcastRoom(r.room, r.seat);
        this.maybeRunBots(r.room);
        break;
      }
      case C2S.ROOM_LEAVE: {
        const room = this.rooms.roomOf(ctx.user);
        const r = this.rooms.leaveRoom(ctx.user);
        if (!r.ok) { this.reply(ctx, { t: S2C.GAME_ERROR, reason: r.reason }, rid); break; }
        ctx.roomCode = null;
        ctx.seat = -1;
        const out = { t: S2C.ROOM_LEFT, soft: !!r.soft };
        // Мягкий выход из партии: место осталось, и клиент должен знать,
        // в какой комнате его ещё ждут, чтобы предложить вернуться.
        if (r.soft && r.room) out.room = views.roomSummary(r.room, r.seat);
        this.reply(ctx, out, rid);
        if (room) {
          this.broadcastRoom(room, null);
          this.maybeRunBots(room);
        }
        break;
      }
      case C2S.ROOM_DROP: {
        const room = this.rooms.roomOf(ctx.user);
        this.rooms.leaveGame(ctx.user);
        ctx.roomCode = null;
        ctx.seat = -1;
        this.reply(ctx, { t: S2C.ROOM_LEFT }, rid);
        if (room) {
          this.broadcastRoom(room, null);
          this.maybeRunBots(room);
        }
        break;
      }
      case C2S.ROOM_START: {
        const r = this.rooms.startGame(ctx.user);
        if (!r.ok) { this.reply(ctx, { t: S2C.GAME_ERROR, reason: r.reason }, rid); break; }
        // Старт сам вызывает rooms.onPlay → hub.onRoomPlay, который рассылает
        // состояние всем участникам. Здесь хозяину — только личный ответ
        // (тот же GAME_STATE, но с rid, чтобы клиент закрыл свой запрос).
        this.pushGameState(r.room, r.seat, rid);
        break;
      }

      // ------------------------------------------------------- быстрый матч
      case C2S.QUICK_JOIN: {
        // Сначала пробуем собрать комнату из уже стоящих в очереди.
        this.rooms.quickJoin(ctx.user, msg);
        this.maybeFormQuick();
        this.sendQueueState(ctx, rid);
        break;
      }
      case C2S.QUICK_LEAVE: {
        this.rooms.quickLeave(ctx.user);
        this.sendQueueState(ctx, rid);
        break;
      }

      // ------------------------------------------------------- партия
      case C2S.GAME_COMMIT: {
        const r = this.rooms.commitTurn(ctx.user, msg.ops);
        if (!r.ok) {
          this.reply(ctx, {
            t: S2C.GAME_ERROR, reason: r.reason, errors: r.errors || [], hard: !!r.hard,
          }, rid);
          // Клиенту нужен свежий эталон, чтобы откатиться к серверному столу.
          if (r.hard && r.room) this.pushGameState(r.room, r.seat, rid);
          break;
        }
        this.afterMove(r, rid);
        break;
      }
      case C2S.GAME_DRAW: {
        const r = this.rooms.drawFor(ctx.user);
        if (!r.ok) { this.reply(ctx, { t: S2C.GAME_ERROR, reason: r.reason }, rid); break; }
        this.afterMove(r, rid);
        break;
      }
      case C2S.GAME_SKIP: {
        const r = this.rooms.skipFor(ctx.user);
        if (!r.ok) { this.reply(ctx, { t: S2C.GAME_ERROR, reason: r.reason }, rid); break; }
        this.afterMove(r, rid);
        break;
      }
      case C2S.GAME_REJOIN: {
        const r = this.rooms.onReconnect(ctx.user, ctx.socket,
          (room, seat, socket) => this.claimSeat(room, seat, socket));
        if (!r) { this.reply(ctx, { t: S2C.GAME_ERROR, reason: 'Партия не найдена' }, rid); break; }
        ctx.roomCode = r.room.code;
        ctx.seat = r.seat;
        this.pushGameState(r.room, r.seat, rid);
        this.broadcastRoom(r.room, r.seat);
        this.maybeRunBots(r.room);
        break;
      }

      case C2S.PING: {
        this.reply(ctx, { t: S2C.PONG, now: Date.now() }, rid);
        break;
      }
      default: {
        this.reply(ctx, { t: S2C.GAME_ERROR, reason: `Неизвестная команда ${msg.t}` }, rid);
      }
    }
  }

  // ------------------------------------------------------------ помощники

  selfPublic() {
    return {
      id: config.serverId, name: config.serverName, region: config.region,
      host: config.publicHost, port: config.publicPort,
    };
  }

  failAuth(ctx, reason, rid) {
    log.info(`вход не удался с ${ctx.ip}: ${reason}`);
    this.reply(ctx, { t: S2C.AUTH_ERR, reason }, rid);
  }

  succeedAuth(ctx, r, notice, rid) {
    ctx.user = {
      id: r.account.login_ci,
      account: r.account,
      login: r.account.login,
      nick: r.account.nick,
    };
    const out = {
      t: S2C.AUTH_OK,
      token: r.token,
      user: this.accounts.publicView(r.account),
      server: this.selfPublic(),
    };
    // Вход в аккаунт — не возврат в комнату: если игрок всё ещё числится
    // в партии (мягкий выход / забытое место / живой старый сокет в лобби),
    // сообщаем об этом в auth.ok.room, но сами его туда не тащим. Возврат —
    // явное решение игрока: game.rejoin из партии или room.join из лобби.
    const stuck = this.rooms.stuckRoom(ctx.user);
    if (stuck) out.room = views.roomSummary(stuck.room, stuck.seat);
    // notice кладём только когда он есть. JSON null — это не «пустая
    // строка», и клиент на нём спотыкается: Dictionary.get('notice', '')
    // при ключе со значением null возвращает null, а не умолчание, и
    // String(null) в GDScript — ошибка времени выполнения. Клиент
    // теперь чистит null на входе (NetProtocol.clean), но и серверу
    // незачем отправлять то, что читать нечем.
    if (notice) out.notice = notice;
    this.reply(ctx, out, rid);
  }

  /**
   * Привязать сокет к месту за столом. Имя НЕ attach: attach() уже занят
   * под HTTP-сервер, и при совпадении имён выигрывает последнее объявление
   * в классе — сервер падал бы на старте.
   */
  attachSeat(ctx, room, seat) {
    ctx.roomCode = room.code;
    ctx.seat = seat;
    this.claimSeat(room, seat, ctx.socket);
    room.clearPause(seat);
    const p = room.players[seat];
    if (p) p.connected = true;
    if (room.game && room.game.players[seat] && !room.game.players[seat].isBot) {
      room.game.players[seat].connected = true;
    }
    room.touch();
  }

  /**
   * Забрать место в столе себе, вытеснив прежнего владельца.
   *
   * Место принадлежит ИГРОКУ, а не сокету, но обработчик закрытия привязан
   * к сокету. Без этого шага всё ломалось так: игрок возвращался после обрыва
   * (или открывалось второе соединение под его именем), место перепривязывалось
   * на новый сокет, а при закрытии старого сервер считал, что игрок ушёл, и
   * выбивал его из комнаты. Партию с одним игроком сервер удаляет — то есть
   * обычное переподключение уничтожало комнату.
   *
   * Прежний сокет помечается вытесненным и закрывается: он уже не тот, кому
   * принадлежит место, и push-рассылки в него больше не должны уходить.
   */
  claimSeat(room, seat, socket) {
    const old = room.sockets.get(seat);
    room.sockets.set(seat, socket);
    if (!old || old === socket) return;
    const oldCtx = this.sockets.get(old);
    if (oldCtx) {
      oldCtx.superseded = true;
      try { old.close(4001, 'replaced by a newer connection'); } catch (_) { /* уже закрыт */ }
    }
  }

  afterMove(r, rid) {
    const room = r.room;
    this.pushGameState(room, r.seat, rid);
    this.broadcastRoom(room, r.seat);
    if (room.state === 'playing' && room.game.finished) {
      const w = room.game.players[room.game.winner];
      log.info(`комната ${room.code}: победа ${w ? w.name : '?'}`);
    }
    this.maybeRunBots(room);
  }

  // ------------------------------------------------------------ боты

  /**
   * Начало партии добралось до хаба: комната собрана людьми и ботами.
   * Это единственное место, откуда идёт рассылка старта, поэтому и
   * кнопка «начать», и автостарт по таймеру дают ровно одно событие.
   */
  onRoomPlay(room) {
    this.broadcastRoom(room, null);
    this.maybeRunBots(room);
  }

  /**
   * Если ход за ботом — запланировать его ход. Дубли в очереди гасим
   * флагом room._botTimer; паузу (ждём переподключение человека) пропускаем.
   */
  maybeRunBots(room) {
    if (!room) return;
    // Ждём второго живого игрока — боты молчат до прихода человека.
    if (room.waiting) return;
    if (this.rooms.rooms.get(room.code) !== room) return;
    if (room.state !== 'playing' || !room.game || room.game.finished) return;
    if (room.isPaused()) return;
    if (room._botTimer) return;
    const cur = room.game.currentPlayer();
    if (!cur || !cur.isBot) return;
    const delay = config.botTurnDelayMs
      + Math.floor(Math.random() * (config.botTurnJitterMs + 1));
    room._botTimer = setTimeout(() => {
      room._botTimer = null;
      if (room.state !== 'playing' || !room.game || room.game.finished) return;
      if (this.rooms.rooms.get(room.code) !== room) return;
      // Ждём второго живого — ход бота откладывается до прихода человека.
      if (room.waiting) return;
      if (room.isPaused()) { this.maybeRunBots(room); return; }
      this.playBotTurn(room);
    }, delay);
    if (room._botTimer.unref) room._botTimer.unref();
  }

  /**
   * Ход бота: план (см. engine/bot.js) применяется ровно как ход живого
   * игрока — beginTurn/applyOps/endTurn/commit. Если выложить нечего или
   * план не прошёл, бот берёт из колоды, на пустой колоде пропускает ход.
   */
  playBotTurn(room) {
    const g = room.game;
    const seat = g.current;
    const player = g.players[seat];
    if (!player || !player.isBot || player.dropped || room.isPaused()) return;
    try {
      const plan = planGame(g);
      if (plan) {
        g.beginTurn();
        let ok = g.applyOps(plan.ops);
        const res = ok ? g.endTurn() : { ok: false };
        if (!ok || !res.ok) {
          g.rollback();
          log.info(`комната ${room.code}: бот ${player.name} промахнулся планом, берёт из колоды`);
        } else {
          g.commit();
          room.touch();
          const rec = room.players[seat];
          if (rec && rec.login) this.db.addResult(rec.login, res.win === true);
          else if (res.win === true) log.info(`комната ${room.code}: бот ${player.name} победил`);
          this.afterBotMove(room);
          return;
        }
      }
      // Нечего выкладывать (или план отклонён движком) — берём из колоды.
      g.beginTurn();
      let r = g.drawFromDeck();
      if (!r.ok) {
        if (g.tilesLeftInDeck() === 0) r = g.skipTurn();
        else {
          g.rollback();
          log.warn(`комната ${room.code}: бот не смог походить (${r.reason})`);
          return;
        }
      }
      g.commit();
      room.touch();
      this.afterBotMove(room);
    } catch (e) {
      log.error(`комната ${room.code}: бот упал: ${e.stack || e.message}`);
      try { g.rollback(); } catch (_) { /* транзакции могло не быть */ }
    }
  }

  afterBotMove(room) {
    this.broadcastRoom(room, null);
    this.maybeRunBots(room);
  }

  drainExpired() {
    for (const room of this.rooms.expireDisconnects()) {
      this.broadcastRoom(room, null);
      this.maybeRunBots(room);
    }
  }

  maybeFormQuick() {
    // Соберём все очереди, где набралось достаточно людей.
    for (const q of Array.from(this.rooms.quick.values())) {
      const formed = this.rooms._tryFormQuick(q);
      if (formed) this.broadcastRoom(formed.room, null);
    }
    // Уведомить оставшихся в очередях об изменившемся состоянии.
    for (const ctx of this.sockets.values()) {
      if (!ctx.user) continue;
      const q = this.rooms.quickStateFor(ctx.user);
      if (q.inQueue) this.send(ctx, { t: S2C.QUICK_STATE, queue: q });
    }
  }

  sendQueueState(ctx, rid) {
    const q = this.rooms.quickStateFor(ctx.user);
    this.reply(ctx, { t: S2C.QUICK_STATE, queue: q }, rid);
  }

  /**
   * Рассылка состояния комнаты. Если playing — шлём каждому ЕГО представление
   * партии (с его рукой и без чужих), если lobby — общее лобби.
   * @param {number|null} except  это место уже получило личный ответ, повтор
   *                              ему не нужен
   */
  broadcastRoom(room, except) {
    if (!room) return;
    for (let seat = 0; seat < room.seats; seat += 1) {
      if (except !== null && except !== undefined && except >= 0 && seat === except) continue;
      if (room.state === 'lobby') this.pushLobby(room, seat);
      else this.pushGameState(room, seat);
    }
  }

  pushLobby(room, seat) {
    const ctx = this.ctxOfSeat(room, seat);
    if (!ctx) return;
    this.send(ctx, { t: S2C.ROOM_STATE, room: views.fullLobbyView(room, seat) });
  }

  pushGameState(room, seat, rid) {
    if (room.state !== 'playing') { this.broadcastRoom(room, null); return; }
    const seats = seat >= 0 ? [seat] : room.players.map((_, i) => i);
    for (const s of seats) {
      const ctx = this.ctxOfSeat(room, s);
      if (!ctx) continue;
      this.send(ctx, {
        t: S2C.GAME_STATE,
        state: views.gameView(room, s),
        grace: s >= 0 && room.paused.has(s) ? room.graceRemaining(s) : 0,
        paused: room.isPaused(),
        waiting: !!room.waiting,
      }, rid);
    }
  }

  ctxOfSeat(room, seat) {
    const socket = room.sockets.get(seat);
    if (!socket) return null;
    return this.sockets.get(socket) || null;
  }

  /**
   * Личный ответ на запрос. Только здесь проставляется rid — рассылки
   * идут через send и остаются без него, иначе клиент примет чужой ход
   * за результат своего.
   */
  reply(ctx, obj, rid) {
    if (rid === undefined || rid === null) { this.send(ctx, obj); return; }
    this.send(ctx, { ...obj, [RID_FIELD]: rid });
  }

  send(ctx, obj, rid) {
    try {
      if (ctx.socket.readyState !== 1) return;
      const payload = rid === undefined || rid === null ? obj : { ...obj, [RID_FIELD]: rid };
      ctx.socket.send(JSON.stringify(payload));
    } catch (e) {
      log.debug(`не удалось отправить: ${e.message}`);
    }
  }

  tick() {
    const now = Date.now();
    for (const ctx of this.sockets.values()) {
      if (!ctx.alive) {
        try { ctx.socket.terminate(); } catch (_) { /* уже мёртв */ }
        continue;
      }
      ctx.alive = false;
      try { ctx.socket.ping(); } catch (_) { /* уже мёртв */ }
    }
    // Комнаты с истёкшим ожиданием переподключения.
    for (const room of this.rooms.expireDisconnects()) {
      this.broadcastRoom(room, null);
      this.maybeRunBots(room);
    }
    void now;
  }
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket ? req.socket.remoteAddress : '?';
}

module.exports = { Hub };
