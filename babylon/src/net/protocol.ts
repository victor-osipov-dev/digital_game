const C2S = {
  REGISTER: 'auth.register',
  LOGIN: 'auth.login',
  RESUME: 'auth.resume',
  LOBBY_OPEN: 'lobby.open',
  LOGOUT: 'auth.logout',
  CHANGE_PASSWORD: 'auth.password',
  CHANGE_NICK: 'auth.nick',
  ACCOUNT_DELETE: 'account.delete',
  SERVERS_LIST: 'servers.list',
  ROOMS_LIST: 'rooms.list',
  ROOM_CREATE: 'room.create',
  ROOM_JOIN: 'room.join',
  ROOM_LEAVE: 'room.leave',
  ROOM_DROP: 'room.drop',
  ROOM_START: 'room.start',
  BOARD_LIST: 'board.list',
  QUICK_JOIN: 'quick.join',
  QUICK_LEAVE: 'quick.leave',
  GAME_COMMIT: 'game.commit',
  GAME_DRAW: 'game.draw',
  GAME_SKIP: 'game.skip',
  GAME_REJOIN: 'game.rejoin',
  GAME_PEEK: 'game.peek',
  GAME_DRAFT: 'game.draft',
  PING: 'ping',
} as const;

const S2C = {
  HELLO: 'hello',
  AUTH_OK: 'auth.ok',
  AUTH_ERR: 'auth.err',
  ACCOUNT_DELETED: 'account.deleted',
  SERVERS_LIST: 'servers.list',
  ROOMS_LIST: 'rooms.list',
  BOARD_LIST: 'board.list',
  ROOM_STATE: 'room.state',
  ROOM_LEFT: 'room.left',
  QUICK_STATE: 'quick.state',
  GAME_STATE: 'game.state',
  GAME_ERROR: 'game.error',
  GAME_PEEK: 'game.peek',
  GAME_DRAFT: 'game.draft',
  TOAST: 'toast',
  PONG: 'pong',
} as const;

export { C2S, S2C };

export interface TileFaceMsg { id: number; color: number; value: number; is_joker: boolean; }
export interface ServerMsg {
  id: string; name: string; region: string;
  host: string; port: number; protocol?: number;
  version?: string; online?: boolean; self?: boolean;
}
export interface HelloMsg {
  t: typeof S2C.HELLO;
  server: ServerMsg;
  catalog: TileFaceMsg[];
  graceMs: number;
}
export interface UserView { token?: string; login: string; nick: string; id?: number; games?: number; wins?: number; }
export interface AuthOkMsg { t: typeof S2C.AUTH_OK; notice?: string; token?: string; user: UserView; room?: RoomLobbyView; }
export interface AuthErrMsg { t: typeof S2C.AUTH_ERR; reason: string; }

export interface RoomPlayersEntry { seat: number; empty: boolean; nick: string; connected: boolean; }
export interface RoomLobbyView {
  code: string; name: string; seats: number; require30: boolean;
  hasPassword: boolean; state: 'lobby' | 'playing';
  you: number; isHost: boolean; players: RoomPlayersEntry[];
}
export interface GamePlayerView {
  seat: number; nick: string; handCount: number; connected: boolean;
  dropped: boolean; isBot: boolean; isYou: boolean;
}
export interface TableRowMsg { id: number; tiles: number[]; }
// В game.state сервер отдаёт стол как {id, tileIds} (views.js gameView),
// а в черновиках/commit — как {id, tiles}. Это разные формы.
export interface TableRowView { id: number; tileIds: number[]; }
export interface GameView {
  code: string; require30: boolean; seats: number; you: number;
  hand: number[]; players: GamePlayerView[];
  table: TableRowView[]; deckCount: number; current: number;
  myTurn: boolean; turnLeft: number | null; firstTurn: boolean;
  turnPlaced: number[]; lastTurn: number[];
  finished: boolean; winner: number; winnerName: string;
}
export interface GameEnvelope {
  t: typeof S2C.GAME_STATE;
  state: GameView;
  grace?: number; paused?: boolean; waiting?: boolean;
  rid?: string;
}
export interface RoomLobbyEnvelope { t: typeof S2C.ROOM_STATE; room: RoomLobbyView; rid?: string; }
export interface RoomLeftMsg { t: typeof S2C.ROOM_LEFT; soft?: boolean; room?: RoomLobbyView; }
export interface QuickQueueState { inQueue: boolean; key?: string; seats?: number; require30?: boolean; waiting: number; queues?: Array<{ key: string; seats: number; require30: boolean; waiting: number }>; }
export interface QuickStateMsg { t: typeof S2C.QUICK_STATE; queue: QuickQueueState; }
export interface RoomSummary {
  code: string; name: string; seats: number; require30: boolean;
  hasPassword: boolean; host: string; state: string;
  players: Array<{ nick: string; connected: boolean; isBot: boolean }>;
  filled: number; bots: number;
}
export interface RoomsListMsg { t: typeof S2C.ROOMS_LIST; rooms: RoomSummary[]; server: ServerMsg; }
export interface ServersListMsg { t: typeof S2C.SERVERS_LIST; servers: ServerMsg[]; }
export interface BoardEntry { nick: string; games: number; wins: number; }
export interface BoardListMsg { t: typeof S2C.BOARD_LIST; entries: BoardEntry[]; me: (BoardEntry & { rank: number }) | null; }
export interface GameRowError { row: number; reason: string; }
export interface GameErrorMsg { t: typeof S2C.GAME_ERROR; reason: string; errors?: GameRowError[]; hard?: boolean; }
export interface ToastMsg { t: typeof S2C.TOAST; text: string; }
export interface PeekMsg { t: typeof S2C.GAME_PEEK; from: number; tile: number; kind: 'clear' | 'into' | 'new' | 'back'; row?: number; index?: number; }
export interface DraftMsg { t: typeof S2C.GAME_DRAFT; from: number; rows: TableRowMsg[]; }
export type ServerPacket = Record<string, unknown> & { t: string; rid?: string };

export const MAX_OPS_PER_COMMIT = 64;

export function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === null ? '' : clean(v)));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = clean(v);
    }
    return out;
  }
  return value;
}

export function parsePacket(text: string): ServerPacket {
  const parsed = JSON.parse(text) as ServerPacket;
  return clean(parsed) as ServerPacket;
}
