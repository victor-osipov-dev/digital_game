'use strict';

const { WebSocketServer } = require('ws');
const nodeNet = require('net');
const { config } = require('./config');
const log = require('./log');
const { C2S, S2C, RID_FIELD, MAX_MESSAGE_BYTES } = require('./protocol');
const catalog = require('./engine/catalog');
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
 * Валидация rows черновика стола (game.draft).
 *
 * Это картинка, а не ход: правила и состав рук не проверяем, но сюда
 * лезет чужой сокет, поэтому вся геометрия нормализуется в жёстких
 * пределах — иначе можно сыпать мусором и раздуть рассылку. Возвращает
 * нормализованный массив или null, если формат не годится.
 */
function cleanDraftRows(rows, game) {
  if (!Array.isArray(rows) || rows.length > 64) return null;
  // Черновик — картинка текущего стола автора, а не произвольный набор
  // номеров. Проверяем каждую фишку по объединению его руки и стола: так
  // нельзя показать чужую скрытую фишку или продублировать одну фишку.
  const allowed = new Set();
  if (game) {
    const me = game.players[game.current];
    if (me) for (const id of me.handIds) allowed.add(id);
    for (const row of game.table) for (const id of row.tileIds) allowed.add(id);
  }
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') return null;
    if (!Number.isInteger(r.id) || r.id < 0 || r.id > 10000) return null;
    if (!Array.isArray(r.tiles)) return null;
    total += r.tiles.length;
    if (total > 200) return null;
    const tiles = [];
    for (const t of r.tiles) {
      // Именно наличие в каталоге, а не числовой диапазон: диапазон уже
      // один раз отстал от колоды (108 вместо 106) и пропустил несуществующие
      // номера в чужой экран.
      if (!Number.isInteger(t) || !catalog.BY_ID.has(t)) return null;
      if (game && (!allowed.has(t) || seen.has(t))) return null;
      seen.add(t);
      tiles.push(t);
    }
    out.push({ id: r.id, tiles });
  }
  return out;
}

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
    this.ipAuth = new Map(); // доверенный IP -> {count, windowStart}
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
      if (room._turnTimer) { clearTimeout(room._turnTimer); room._turnTimer = null; }
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
      token: null,
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
    if (room) {
      // Пауза (или выход в ожидание) уже гасит отсчёт хода — пересчитать
      // его нужно и здесь, и до рассылки: клиент должен увидеть состояние
      // с тем отсчётом, какое реально действует после ухода.
      this.maybeRunBots(room);
      this.broadcastRoom(room, null);
    }
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

    // Привязка соединения к живой сессии проверяется на каждом
    // аутентифицированном сообщении: выход и смена пароля обязаны гасить
    // и уже открытый сокет, а не только будущие входы по токену.
    if (ctx.user && !this.accounts.sessionAlive(ctx.token)) {
      ctx.user = null;
      ctx.token = null;
      this.reply(ctx, { t: S2C.AUTH_ERR, reason: 'Сессия недействительна' }, rid);
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
    const ip = String((ctx && ctx.ip) || '?');
    let bucket = this.ipAuth.get(ip);
    if (!bucket || now - bucket.windowStart > 60000) bucket = { count: 0, windowStart: now };
    if (!ctx || now - ctx.authWindowStart > 60000) {
      if (ctx) {
        ctx.authWindowStart = now;
        ctx.authFails = 0;
      }
    }
    if (ctx && ctx.authFails >= config.authAttemptsPerMinute) return false;
    if (bucket.count >= config.authIpAttemptsPerMinute) return false;
    if (ctx) ctx.authFails += 1;
    bucket.count += 1;
    this.ipAuth.set(ip, bucket);
    // Чистим только просроченные записи и только когда карта заметно
    // выросла: иначе сами счётчики стали бы точкой утечки памяти.
    if (this.ipAuth.size > 1000) {
      for (const [key, entry] of this.ipAuth) {
        if (now - entry.windowStart > 60000) this.ipAuth.delete(key);
      }
    }
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
        ctx.token = String(msg.token || '');
        ctx.observer = true;
        this.reply(ctx, { t: S2C.AUTH_OK, user: this.accounts.publicView(r.account) }, rid);
        break;
      }
      case C2S.LOGOUT: {
        // Отзываем сессию именно этого соединения, а не любой токен из
        // сообщения: иначе вошедший игрок мог бы гасить чужие сессии.
        const target = ctx.token || String(msg.token || '');
        this.accounts.logout(target);
        // Отзыв должен уехать соседям сразу, а не ждать минутного gossip:
        // иначе токен ещё жил бы на другом сервере.
        this.cluster.push().catch(() => {});
        ctx.user = null;
        ctx.token = null;
        this.reply(ctx, { t: S2C.AUTH_ERR, reason: 'Вы вышли' }, rid);
        break;
      }
      case C2S.CHANGE_PASSWORD: {
        const r = this.accounts.changePassword(ctx.user.account, msg.old, msg.new);
        if (!r.ok) { this.reply(ctx, { t: S2C.GAME_ERROR, reason: r.reason }, rid); break; }
        ctx.user.account = r.account;
        ctx.token = r.token || ctx.token;
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
        // Отсчёт (и планирование ботов) пересчитываем ДО рассылки: иначе
        // клиенты получат состояние с погашенным таймером и не запустят
        // свой отсчёт.
        this.maybeRunBots(r.room);
        if (r.playing) {
          // Вход в идущую партию: личным ответом уходит уже само состояние
          // партии (с рукой этого игрока), а не лобби. Иначе клиент показал
          // бы лобби и потребовал бы «нажать старт» в идущей игре.
          this.pushGameState(r.room, r.seat, rid);
        } else {
          this.reply(ctx, { t: S2C.ROOM_STATE, room: views.fullLobbyView(r.room, r.seat) }, rid);
        }
        this.broadcastRoom(r.room, r.seat);
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
          this.maybeRunBots(room);
          this.broadcastRoom(room, null);
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
          this.maybeRunBots(room);
          this.broadcastRoom(room, null);
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
        const r = this.rooms.quickJoin(ctx.user, msg);
        if (!r.ok) {
          this.reply(ctx, { t: S2C.GAME_ERROR, reason: r.reason }, rid);
          break;
        }
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
        this.maybeRunBots(r.room);
        this.pushGameState(r.room, r.seat, rid);
        this.broadcastRoom(r.room, r.seat);
        break;
      }

      case C2S.GAME_PEEK: {
        // Превью хода («он перебирает, куда положить»): пересылаем
        // остальным без проверки правил — это только картинка. Фишку
        // клиент рисует по своему каталогу из hello, сюда уходит лишь
        // номер, так что подделать цвет/значение нельзя. shape валидируем,
        // чтобы чужой сокет не сыпал мусором в чужой экран.
        const room = ctx.roomCode ? this.rooms.rooms.get(ctx.roomCode) : null;
        if (!room || room.state !== 'playing') break;
        const seat = ctx.seat;
        if (!(seat >= 0 && seat < room.seats)) break;
        // Превью — тоже только от текущего игрока: чужое «думаю сюда»
        // от неходящего места врёт про стол точно так же, как черновик.
        if (!room.game || room.game.current !== seat) break;
        const kind = msg.kind;
        if (kind !== 'clear' && kind !== 'into' && kind !== 'new' && kind !== 'back') break;
        if (!Number.isInteger(msg.tile) || !catalog.BY_ID.has(msg.tile)) break;
        const peek = { t: S2C.GAME_PEEK, from: seat, tile: msg.tile, kind };
        if (kind === 'into') {
          if (!Number.isInteger(msg.row) || msg.row < 0 || msg.row > 10000) break;
          if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index > 64) break;
          peek.row = msg.row;
          peek.index = msg.index;
        } else if (kind === 'new') {
          if (!Number.isInteger(msg.at) || msg.at < 0 || msg.at > 10000) break;
          peek.at = msg.at;
        }
        // Троттлинг: клиент шлёт только при смене цели, но и на всякий
        // случай не даём сыпать превью чаще, чем раз в 40 мс. Сам «убери
        // призрак» мимо окна: на смене цели clear идёт вплотную к последнему
        // превью, и потерянный clear оставлял бы призрак висеть до
        // собственного протухания.
        const now = Date.now();
        if (kind !== 'clear' && room._peekAt && now - (room._peekAt.get(seat) || 0) < 40) break;
        if (!room._peekAt) room._peekAt = new Map();
        room._peekAt.set(seat, now);
        for (let s = 0; s < room.seats; s += 1) {
          if (s === seat) continue;            // автору не шлём
          const c = this.ctxOfSeat(room, s);
          if (c) this.send(c, peek);
        }
        break;
      }

      case C2S.GAME_DRAFT: {
        // Черновик стола: автор шлёт ВЕСЬ свой стол после каждой локальной
        // раскладки, чтобы соперники видели все выложенные фишки (серыми)
        // ещё до commit. Как и peek — это только картинка, но рисует её
        // ровно текущий игрок: черновик не в свой ход соврал бы про стол.
        const room = ctx.roomCode ? this.rooms.rooms.get(ctx.roomCode) : null;
        if (!room || room.state !== 'playing') break;
        const seat = ctx.seat;
        if (!(seat >= 0 && seat < room.seats)) break;
        if (!room.game || room.game.current !== seat) break;
        const rows = cleanDraftRows(msg.rows, room.game);
        if (!rows) break;
        // Троттлинг — тот же 40 мс, что у peek: клиент шлёт только при
        // изменении стола, но и на всякий случай не даём сыпать чаще.
        const now = Date.now();
        if (room._draftAt && now - (room._draftAt.get(seat) || 0) < 40) break;
        if (!room._draftAt) room._draftAt = new Map();
        room._draftAt.set(seat, now);
        const draft = { t: S2C.GAME_DRAFT, from: seat, rows };
        // Последний черновик помним: если дедлайн застанет готовый стол,
        // примем его как ход, а не будем брать из колоды поверх выкладки.
        // Черновик свежий по построению: принимается только от текущего
        // игрока, а ход текущего закрывает любое его изменение (коммит,
        // взятие, пропуск, автоход) — протухший дальше не переживёт
        // валидацию хода и откатится.
        if (!room._draftRows) room._draftRows = new Map();
        room._draftRows.set(seat, rows);
        for (let s = 0; s < room.seats; s += 1) {
          if (s === seat) continue;            // автору не шлём
          const c = this.ctxOfSeat(room, s);
          if (c) this.send(c, draft);
        }
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
    ctx.token = r.token || null;
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
    // Ход закрыт своим действием — черновик автора больше не черновик.
    if (room && room._draftRows) room._draftRows.delete(r.seat);
    // Дедлайн нового хода — до рассылки: клиенты должны получить состояние
    // с уже запущенным отсчётом, а не с погашенным таймером.
    this.maybeRunBots(room);
    this.pushGameState(room, r.seat, rid);
    this.broadcastRoom(room, r.seat);
    if (room.state === 'playing' && room.game.finished) {
      const w = room.game.players[room.game.winner];
      log.info(`комната ${room.code}: победа ${w ? w.name : '?'}`);
    }
  }

  // ------------------------------------------------------------ боты

  /**
   * Начало партии добралось до хаба: комната собрана людьми и ботами.
   * Это единственное место, откуда идёт рассылка старта, поэтому и
   * кнопка «начать», и автостарт по таймеру дают ровно одно событие.
   */
  onRoomPlay(room) {
    // Новая партия — старые черновики (места те же) недействительны.
    room._draftRows = new Map();
    // Старт: сначала отсчёт (и планирование ботов), потом рассылка —
    // первый кадр партии у всех клиентов уже с живым таймером.
    this.maybeRunBots(room);
    this.broadcastRoom(room, null);
  }

  /**
   * Если ход за ботом — запланировать его ход. Дубли в очереди гасим
   * флагом room._botTimer; паузу (ждём переподключение человека) пропускаем.
   */
  maybeRunBots(room) {
    if (!room) return;
    // Отсчёт хода живёт рядом с ботами: любое изменение состояния комнаты
    // (ход, вход/выход, пауза, ожидание) проходит черезсюда и пересчитывает
    // дедлайн вместе с таймером.
    this._scheduleTurn(room);
    // Ждём второго живого игрока — боты молчат до прихода человека.
    if (room.waiting) return;
    // И то же, когда живых осталось меньше двух: один человек за столом
    // ботов — партия ждёт людей, а не ходит сама.
    if (this.rooms.humanCount(room) < 2) return;
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
      if (this.rooms.humanCount(room) < 2) return;
      if (room.isPaused()) { this.maybeRunBots(room); return; }
      this.playBotTurn(room);
    }, delay);
    if (room._botTimer.unref) room._botTimer.unref();
  }

  /**
   * Отсчёт текущего хода. Дедлайн ставится, когда отсчёта нет (старт
   * партии, возобновление после паузы, только что завершённый ход),
   * иначе таймер просто перепланируется на уже известный дедлайн.
   * Пока отсчёта быть не должно (пауза, ожидание второго, конец
   * партии) — дедлайн гаснет и никто его не трогает.
   */
  _scheduleTurn(room) {
    if (room._turnTimer) {
      clearTimeout(room._turnTimer);
      room._turnTimer = null;
    }
    const alive = this.rooms.rooms.get(room.code) === room
      && room.state === 'playing' && room.game && !room.game.finished
      && !room.waiting && !room.isPaused();
    if (!alive) {
      room.turnDeadlineMs = null;
      return;
    }
    // Текущий мог смениться без завершения хода (выбыл, место занял бот):
    // прежний дедлайн чужой, начинаем отсчёт для нового.
    if (room.turnDeadlineMs == null || room.turnDeadlineFor !== room.game.current) {
      room.turnDeadlineMs = Date.now() + config.turnSeconds * 1000;
      room.turnDeadlineFor = room.game.current;
    }
    const delay = Math.max(50, room.turnDeadlineMs - Date.now() + 80);
    room._turnTimer = setTimeout(() => {
      room._turnTimer = null;
      this._onTurnTimeout(room);
    }, delay);
    if (room._turnTimer.unref) room._turnTimer.unref();
  }

  /**
   * Время хода вышло: сервер сам берёт фишку из колоды (на пустой колоде
   * пропускает ход) и передаёт очередь дальше — партия не встаёт, даже
   * если игрок отвлёкся. Зеркалит ботий fallback: beginTurn ->
   * drawFromDeck -> (пусто? skipTurn) -> commit.
   */
  _onTurnTimeout(room) {
    if (this.rooms.rooms.get(room.code) !== room) return;
    if (room.state !== 'playing' || !room.game || room.game.finished
      || room.waiting || room.isPaused()) {
      room.turnDeadlineMs = null;
      return;
    }
    // Дедлайн сбили или сменяли (возобновление, уход текущего) — ждём новый.
    if (room.turnDeadlineMs == null || Date.now() < room.turnDeadlineMs - 5
      || room.turnDeadlineFor !== room.game.current) {
      room.turnDeadlineMs = null;
      this._scheduleTurn(room);
      return;
    }
    room.turnDeadlineMs = null;
    const g = room.game;
    const seat = g.current;
    if (!g.players[seat]) return;
    // Дедлайн застал готовый стол: игрок разложил валидный черновик, но
    // не успел нажать «Продолжить». Принимаем его как ход — так честнее,
    // чем молча брать из колоды поверх готовой выкладки. Невалидный
    // черновик (или его отсутствие) — обычный автовзят.
    if (this._acceptDraftTurn(room, seat)) {
      this.maybeRunBots(room);
      this.broadcastRoom(room, null);
      return;
    }
    let drew = false;
    try {
      g.beginTurn();
      const r = g.drawFromDeck();
      drew = r.ok;
      if (!r.ok) {
        if (g.tilesLeftInDeck() === 0) {
          g.skipTurn();
        } else {
          // Рисовать не вышло, а колода жива — не гадаем почему, а
          // возвращаем отсчёт и даём команде время самой разобраться.
          g.rollback();
          log.warn(`комната ${room.code}: авто-ход не удался (${r.reason})`);
          this.maybeRunBots(room);
          return;
        }
      }
      g.commit();
      room.touch();
    } catch (e) {
      log.error(`комната ${room.code}: авто-ход упал: ${e.stack || e.message}`);
      try { g.rollback(); } catch (_) { /* транзакции могло не быть */ }
      return;
    }
    const ctx = this.ctxOfSeat(room, seat);
    if (ctx) {
      this.send(ctx, {
        t: S2C.TOAST,
        text: drew ? 'Время хода вышло — фишка взята из колоды'
          : 'Время хода вышло — ход пропущен автоматически',
      });
    }
    log.info(`комната ${room.code}: время хода игрока ${seat} вышло — авто-взятие из колоды`);
    this.maybeRunBots(room);
    this.broadcastRoom(room, null);
  }

  /**
   * Дедлайн при готовом черновике: стол игрока уже валиден — засчитываем
   * ход, а не берём из колоды. Проверка та же, что у обычного коммита
   * (set_table + endTurn с откатом), мутации при отказе нет.
   */
  _acceptDraftTurn(room, seat) {
    const g = room.game;
    const rows = room._draftRows ? room._draftRows.get(seat) : null;
    if (room._draftRows) room._draftRows.delete(seat);
    if (!rows || rows.length === 0) return false;
    let win = false;
    try {
      g.beginTurn();
      const applied = g.applyOps([{ op: 'set_table', rows }]);
      const res = applied ? g.endTurn() : { ok: false };
      if (!applied || !res.ok) {
        g.rollback();
        return false;
      }
      g.commit();
      room.touch();
      win = res.win === true;
      const rec = room.players[seat];
      if (rec && rec.login) this.db.addResult(rec.login, win);
    } catch (e) {
      log.warn(`комната ${room.code}: черновик к дедлайну не встал (${e.message})`);
      try { g.rollback(); } catch (_) { /* транзакции могло не быть */ }
      return false;
    }
    const ctx = this.ctxOfSeat(room, seat);
    if (ctx) {
      this.send(ctx, {
        t: S2C.TOAST,
        text: 'Время хода вышло — ваш стол принят как ход',
      });
    }
    log.info(`комната ${room.code}: время хода игрока ${seat} вышло — готовый стол засчитан`);
    return true;
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
          // Ход бота кончился — прежний отсчёт гасим до _scheduleTurn.
          room.turnDeadlineMs = null;
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
      room.turnDeadlineMs = null;
      this.afterBotMove(room);
    } catch (e) {
      log.error(`комната ${room.code}: бот упал: ${e.stack || e.message}`);
      try { g.rollback(); } catch (_) { /* транзакции могло не быть */ }
    }
  }

  afterBotMove(room) {
    this.maybeRunBots(room);
    this.broadcastRoom(room, null);
  }

  drainExpired() {
    for (const room of this.rooms.expireDisconnects()) {
      this.maybeRunBots(room);
      this.broadcastRoom(room, null);
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
      this.maybeRunBots(room);
      this.broadcastRoom(room, null);
    }
    void now;
  }
}

function cleanIpAddress(raw) {
  let s = String(raw || '').trim();
  if (s === '') return '';
  const bracket = s.match(/^\[([^\]]+)\](?::\d{1,5})?$/);
  if (bracket) s = bracket[1];
  else {
    const v4port = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/);
    if (v4port) s = v4port[1];
  }
  const zone = s.indexOf('%');
  if (zone > 0) s = s.slice(0, zone);
  s = s.toLowerCase();
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7);
    if (nodeNet.isIP(v4) === 4) s = v4;
  }
  return nodeNet.isIP(s) ? s : '';
}

function ipToBytes(ip) {
  if (nodeNet.isIP(ip) === 4) return Buffer.from(ip.split('.').map((x) => Number(x)));
  const halves = ip.split('::');
  if (halves.length < 1 || halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((x) => x !== '') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((x) => x !== '') : [];
  const groups = [...head, ...tail];
  const expanded = [];
  for (const g of groups) {
    if (g.includes('.')) {
      const bytes = g.split('.').map((x) => Number(x));
      if (bytes.length !== 4 || bytes.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
      expanded.push(((bytes[0] * 256 + bytes[1]).toString(16)));
      expanded.push(((bytes[2] * 256 + bytes[3]).toString(16)));
    } else expanded.push(g);
  }
  if (halves.length === 1 && expanded.length !== 8) return null;
  if (halves.length === 2) {
    if (expanded.length > 8) return null;
    expanded.unshift(...new Array(8 - expanded.length).fill('0'));
  }
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    const v = parseInt(expanded[i], 16);
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) return null;
    out.writeUInt16BE(v, i * 2);
  }
  return out;
}

function parseTrustedProxy(raw) {
  const s = String(raw || '').trim();
  if (s === '') return null;
  const slash = s.lastIndexOf('/');
  if (slash === -1) {
    const ip = cleanIpAddress(s);
    if (ip === '') return null;
    return { bytes: ipToBytes(ip), bits: ipToBytes(ip).length * 8 };
  }
  const ip = cleanIpAddress(s.slice(0, slash));
  const bits = Number(s.slice(slash + 1));
  const bytes = ip === '' ? null : ipToBytes(ip);
  if (!bytes || !Number.isInteger(bits) || bits < 0 || bits > bytes.length * 8) return null;
  return { bytes, bits };
}

function trustedAddressMatches(ip, rule) {
  const bytes = ipToBytes(ip);
  if (!bytes || bytes.length !== rule.bytes.length) return false;
  const full = Math.floor(rule.bits / 8);
  const rest = rule.bits % 8;
  if (!bytes.subarray(0, full).equals(rule.bytes.subarray(0, full))) return false;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (bytes[full] & mask) === (rule.bytes[full] & mask);
}

function trustedClientIp(remoteAddress, headers, trustedProxies) {
  const remote = cleanIpAddress(remoteAddress);
  if (remote === '') return '?';
  const rules = (trustedProxies || []).map(parseTrustedProxy).filter(Boolean);
  if (rules.length === 0) return remote;
  const raw = headers ? headers['x-forwarded-for'] : '';
  const forwarded = String(raw || '').split(',').map(cleanIpAddress).filter((x) => x !== '');
  const chain = [...forwarded, remote];
  let client = remote;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const trusted = rules.some((rule) => trustedAddressMatches(chain[i], rule));
    if (!trusted) {
      client = chain[i];
      break;
    }
    client = chain[i];
  }
  return client;
}

function clientIp(req) {
  return trustedClientIp(
    req && req.socket ? req.socket.remoteAddress : '',
    req ? req.headers : {},
    config.trustedProxies,
  );
}

module.exports = { Hub };
