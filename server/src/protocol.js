'use strict';

// Контракт клиент<->сервер. Зеркалится в scripts/net/protocol.gd —
// если меняешь здесь, меняй там, иначе клиент перестанет понимать ответы.
//
// Транспорт: WebSocket, каждое сообщение — JSON-объект с полем "t".
// Формат: { "t": "<тип>", ...остальные поля }
//
// Поле "rid" (идентификатор запроса): клиент кладёт в запрос строку и по ней
// узнаёт СВОЙ ответ. Без него не отличить «мой ход отклонили» от
// «соперник что-то сделал» — оба события приходят одним типом сообщения.
// В рассылках (чужие ходы, вход соседа) rid не проставляется: клиент обязан
// применять чужое состояние вслепую, не выдавая его за результат своего хода.

const catalog = require('./engine/catalog');

const C2S = {
  // --- вход -------------------------------------------------------------
  REGISTER: 'auth.register',      // {login, password, nick} -> auth.ok
  LOGIN: 'auth.login',            // {login, password}        -> auth.ok
  RESUME: 'auth.resume',          // {token}                  -> auth.ok
  YA_LOGIN: 'auth.ya',           // {uid, nick} -> auth.ok (только Web/Yandex ID)
  // Наблюдатель: вход только на чтение, для чтения списка комнат с чужого
  // сервера. Обычный вход для этого не годится — он перехватывает сокет
  // игрока в комнате, и закрытие такой связи выбивает его из партии.
  LOBBY_OPEN: 'lobby.open',       // {token}                  -> auth.ok
  LOGOUT: 'auth.logout',          // {}
  CHANGE_PASSWORD: 'auth.password', // {old, new} -> auth.ok
  CHANGE_NICK: 'auth.nick',       // {nick} -> auth.ok

  // --- кластер и комнаты ------------------------------------------------
  SERVERS_LIST: 'servers.list',   // {} -> servers.list
  ROOMS_LIST: 'rooms.list',       // {} -> rooms.list
  ROOM_CREATE: 'room.create',     // {seats, require30, name, password} -> room.state
  ROOM_JOIN: 'room.join',         // {code, password} -> room.state | game.state
  ROOM_LEAVE: 'room.leave',       // {} -> room.left
  ROOM_DROP: 'room.drop',         // {} -> room.left  (полный выход, место освобождается сразу)
  ROOM_START: 'room.start',       // {} -> room.state | game.state
  ROOM_CHAT: 'room.chat',         // {text} -> room.chat  (зарезервировано)

  // --- быстрый матч -----------------------------------------------------
  QUICK_JOIN: 'quick.join',       // {seats, require30} -> quick.state | room.state
  QUICK_LEAVE: 'quick.leave',     // {} -> quick.state

  // --- партия -----------------------------------------------------------
  GAME_COMMIT: 'game.commit',     // {ops:[...]} -> game.state | game.error
  GAME_DRAW: 'game.draw',         // {}         -> game.state | game.error
  GAME_SKIP: 'game.skip',         // {}         -> game.state | game.error
  GAME_REJOIN: 'game.rejoin',     // {} -> game.state   (переподключение)
  // Превью хода: игрок перебирает, куда положить/убрать фишку. Без ответа:
  // сервер пересылает остальным соперникам, чтобы те видели «он думает
  // тут». kind: clear | into | new | back.
  GAME_PEEK: 'game.peek',         // {tile, kind, row?, index?, at?}
  // Черновик стола: ВЕСЬ стол автора в момент локальной раскладки. Уходит
  // после каждого изменения стола (и повторяется на всякий случай), чтобы
  // соперники видели все выложенные им фишки (серыми) ещё до commit.
  // Формат rows совпадает с rows в op "set_table" у game.commit.
  GAME_DRAFT: 'game.draft',       // {rows:[{id, tiles:[tile_id,...]}, ...]}

  PING: 'ping',                   // {} -> pong
};

const S2C = {
  HELLO: 'hello',
  AUTH_OK: 'auth.ok',
  AUTH_ERR: 'auth.err',
  SERVERS_LIST: 'servers.list',
  ROOMS_LIST: 'rooms.list',
  ROOM_STATE: 'room.state',
  ROOM_LEFT: 'room.left',
  QUICK_STATE: 'quick.state',
  GAME_STATE: 'game.state',
  GAME_ERROR: 'game.error',
  // Превью хода соперника: {from, tile, kind, row?, index?, at?} — без rid,
  // рассылка. Отправителю не приходит (он и так знает, что перебирает).
  GAME_PEEK: 'game.peek',
  // Черновик стола соперника: {from, rows} — без rid, рассылка. Рисуется
  // вместо базового стола, пока автор не завершит ход (game.state гасит).
  GAME_DRAFT: 'game.draft',
  TOAST: 'toast',
  PONG: 'pong',
};

// Фишка: клиент не обязан знать id -> (цвет, значение, джокер), сервер
// присылает каталог один раз в hello.
const TILE = { id: 'id', color: 'color', value: 'value', isJoker: 'is_joker' };

// Число фишек в каталоге. Для проверки ID его больше не используем:
// диапазон уже отставал от колоды, поэтому превью и черновик сверяются
// напрямую с catalog.BY_ID.
const CATALOG_SIZE = catalog.TOTAL;

const MAX_OPS_PER_COMMIT = 64;
const MAX_MESSAGE_BYTES = 256 * 1024;

// Поле-коррелятор запроса и ответа.
const RID_FIELD = 'rid';

module.exports = { C2S, S2C, TILE, RID_FIELD, CATALOG_SIZE, MAX_OPS_PER_COMMIT, MAX_MESSAGE_BYTES };
