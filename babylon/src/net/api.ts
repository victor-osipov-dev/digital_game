import { loadSettings } from '../core/settings';
import { setServerCatalog } from '../core/deck';
import {
  AuthOkMsg, BoardListMsg, C2S, DraftMsg, GameEnvelope, GameErrorMsg, HelloMsg,
  QuickStateMsg, RoomLeftMsg, RoomLobbyEnvelope, RoomLobbyView, RoomSummary, RoomsListMsg,
  ServerPacket, ServersListMsg, S2C,
  TableRowMsg, ToastMsg, UserView,
} from './protocol';
import { listServerRefs, ServerRef, serverRefById } from './servers';
import { Session } from './session';

// короткий таймаут опроса чужого сервера (probe: 2.5-5 с)
const OBSERVER_TIMEOUT_MS = 5000;
// гоночный опрос серверов при входе (probe TTL/таймаут из servers.gd)
const PROBE_TIMEOUT_MS = 2500;
const TOKEN_KEY = 'dg.token';
const NICK_KEY = 'dg.nick';
const LOGIN_KEY = 'dg.login';
// пароль запоминается, как session.json в оригинале (session.gd:16-86)
const PASS_KEY = 'dg.pass';
// Чтобы в главном меню восстановить pending на сервере, где живёт комната.
const PENDING_SERVER_KEY = 'dg.pending_server';
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;

export interface ApiListeners {
  onGame: (env: GameEnvelope) => void;
  onLobby: (env: RoomLobbyEnvelope) => void;
  onToast: (msg: ToastMsg) => void;
  onError: (msg: GameErrorMsg) => void;
  onQuick: (msg: QuickStateMsg) => void;
  onDraft: (msg: DraftMsg) => void;
  onLeft: (msg: RoomLeftMsg) => void;
  onClosed: () => void;
  // pending_room изменился (banner «вы всё ещё в комнате»)
  onPending: (room: RoomLobbyView | null) => void;
}

export interface RoomWithServer extends RoomSummary {
  serverId: string;
  serverName: string;
}

export interface RoomsAllResult {
  rooms: RoomWithServer[];
  // серверы, которые не ответили (servers.gd failedServers)
  failed: { id: string; name: string }[];
  // сколько серверов реально опрашивали (dev-режим — только он)
  total: number;
}

export class Api {
  session = new Session();
  ref: ServerRef | null = null;
  hello: HelloMsg | null = null;
  user: UserView | null = null;
  // «Вы всё ещё в комнате» (net.gd pending_room): auth.ok.room / room.left
  pendingRoom: RoomLobbyView | null = null;
  // серверы, не ответившие на последний опрос комнат / опрошенные
  private lastFailedServerIds = new Set<string>();
  private lastQueriedServerIds = new Set<string>();
  onServerIdentity: ((srv: NonNullable<HelloMsg['server']>) => void) | null = null;
  listeners: Partial<ApiListeners> = {};

  constructor() {
    this.session.broadcastListeners.add((pkt) => this.routeBroadcast(pkt));
    this.session.closedHandlers.add(() => this.listeners.onClosed?.());
    this.session.reconnectedHandlers.add(() => void this.onReconnected());
  }

  // После авто-reconnect: молчаливый resume и уведомление UI.
  private async onReconnected(): Promise<void> {
    if (this.savedToken) {
      try {
        await this.resume();
      } catch {
        // токен протух — останемся гостем; UI-экраны сами покажут вход
      }
    }
    if (this.hello) setServerCatalog(this.hello.catalog ?? []);
  }

  private setPending(room: RoomLobbyView | null): void {
    this.pendingRoom = room;
    if (room && this.ref) localStorage.setItem(PENDING_SERVER_KEY, this.ref.id);
    else if (!room) localStorage.removeItem(PENDING_SERVER_KEY);
    this.listeners.onPending?.(room);
  }

  get nick(): string {
    return localStorage.getItem(NICK_KEY) ?? '';
  }

  get savedToken(): string {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  }

  get savedLogin(): string {
    return localStorage.getItem(LOGIN_KEY) ?? '';
  }

  get savedPassword(): string {
    return localStorage.getItem(PASS_KEY) ?? '';
  }

  get savedPendingServerId(): string {
    return localStorage.getItem(PENDING_SERVER_KEY) ?? '';
  }

  get isOpen(): boolean {
    return this.session.isOpen;
  }

  async connect(refId: string): Promise<HelloMsg> {
    const ref = serverRefById(refId);
    const hello = (await this.session.open(ref.wsUrl)) as unknown as HelloMsg;
    this.ref = ref;
    this.hello = hello;
    // нумерация фишек — серверная (view_builder.gd:17-58)
    setServerCatalog(hello.catalog ?? []);
    this.session.startPing();
    this.onServerIdentity?.(hello.server);
    if (this.savedToken) {
      await this.resume();
    }
    return hello;
  }

  // Быстрейший живой сервер (online_lobby.gd:365-399 fastest_online):
  // гоночный hello на коротких сокетах, затем обычное подключение к
  // победителю. Если никто не ответил — ошибка первого.
  async connectFastest(ids?: string[]): Promise<HelloMsg> {
    const list = (ids && ids.length > 0) ? ids : listServerRefs().map((r) => r.id);
    const winner = await Promise.any(list.map(async (id) => {
      const ref = serverRefById(id);
      const s = new Session();
      try {
        await withTimeout(s.open(ref.wsUrl), PROBE_TIMEOUT_MS);
        return id;
      } finally {
        s.close();
      }
    }));
    return this.connect(winner);
  }

  disconnect(): void {
    this.session.close();
    this.ref = null;
  }

  async resume(): Promise<AuthOkMsg> {
    const pkt = await this.session.request(C2S.RESUME, { token: this.savedToken }, [S2C.AUTH_OK, S2C.AUTH_ERR]);
    if (pkt.t !== S2C.AUTH_OK) throw new AuthError(String(pkt.reason ?? 'Сессия недействительна'));
    const ok = pkt as unknown as AuthOkMsg;
    this.user = ok.user;
    if (ok.token) localStorage.setItem(TOKEN_KEY, ok.token);
    // место в партии при живом сокете: сообщаем, но не тащим (net.gd:444-455)
    this.setPending(ok.room ?? null);
    return ok;
  }

  async login(login: string, password: string): Promise<AuthOkMsg> {
    const pkt = await this.session.request(C2S.LOGIN, { login, password }, [S2C.AUTH_OK, S2C.AUTH_ERR]);
    if (pkt.t !== S2C.AUTH_OK) throw new AuthError(String(pkt.reason ?? 'Ошибка входа'));
    const ok = pkt as unknown as AuthOkMsg;
    if (ok.token) localStorage.setItem(TOKEN_KEY, ok.token);
    this.user = ok.user;
    localStorage.setItem(NICK_KEY, ok.user.nick);
    localStorage.setItem(LOGIN_KEY, login);
    localStorage.setItem(PASS_KEY, password);
    this.setPending(ok.room ?? null);
    return ok;
  }

  async register(login: string, password: string, nick: string): Promise<AuthOkMsg> {
    const pkt = await this.session.request(C2S.REGISTER, { login, password, nick }, [S2C.AUTH_OK, S2C.AUTH_ERR]);
    if (pkt.t !== S2C.AUTH_OK) throw new AuthError(String(pkt.reason ?? 'Ошибка регистрации'));
    const ok = pkt as unknown as AuthOkMsg;
    if (ok.token) localStorage.setItem(TOKEN_KEY, ok.token);
    this.user = ok.user;
    localStorage.setItem(NICK_KEY, ok.user.nick);
    localStorage.setItem(LOGIN_KEY, login);
    localStorage.setItem(PASS_KEY, password);
    this.setPending(ok.room ?? null);
    return ok;
  }

  async logout(): Promise<void> {
    try {
      await this.session.request(C2S.LOGOUT, {}, null);
    } catch {
      /* fire and forget */
    }
    localStorage.removeItem(TOKEN_KEY);
    this.user = null;
    this.setPending(null);
  }

  requireToken(): string {
    const token = this.user?.token ?? this.savedToken;
    if (!token) throw new AuthError('Нет сессии: войдите заново');
    return token;
  }

  async serversList(): Promise<ServersListMsg> {
    return (await this.session.request(C2S.SERVERS_LIST, {}, [S2C.SERVERS_LIST])) as unknown as ServersListMsg;
  }

  async roomsList(): Promise<RoomsListMsg> {
    return (await this.session.request(C2S.ROOMS_LIST, {}, [S2C.ROOMS_LIST])) as unknown as RoomsListMsg;
  }

  // Список комнат с ОДНОГО сервера: короткий сокет-наблюдатель
  // (lobby.open → rooms.list → close), чтобы не трогать свой сокет и
  // место в комнате (servers.gd:262-411). Быстрый таймаут, как у probe.
  private async roomsOfServer(ref: ServerRef): Promise<RoomWithServer[]> {
    const token = this.requireToken();
    if (this.ref && this.ref.id === ref.id && this.isOpen) {
      const own = await this.roomsList();
      return (own.rooms ?? []).map((r) => ({ ...r, serverId: ref.id, serverName: ref.name }));
    }
    const s = new Session();
    try {
      const list = await withTimeout((async () => {
        await s.open(ref.wsUrl);
        const ok = await s.request(C2S.LOBBY_OPEN, { token }, [S2C.AUTH_OK, S2C.AUTH_ERR]);
        if (ok.t !== S2C.AUTH_OK) throw new AuthError(String(ok.reason ?? 'Нет доступа'));
        return (await s.request(C2S.ROOMS_LIST, {}, [S2C.ROOMS_LIST])) as unknown as RoomsListMsg;
      })(), OBSERVER_TIMEOUT_MS);
      return (list.rooms ?? []).map((r) => ({ ...r, serverId: ref.id, serverName: ref.name }));
    } finally {
      s.close();
    }
  }

  // Комнаты со всех серверов параллельно + список не ответивших.
  async roomsAll(): Promise<RoomsAllResult> {
    const all = listServerRefs();
    // dev-стенд (?server=): работаем только с ним, без стука на прод
    const refs = all.length > 0 && all[0].isDev ? [all[0]] : all;
    const rooms: RoomWithServer[] = [];
    const failed: { id: string; name: string }[] = [];
    await Promise.all(refs.map(async (ref) => {
      try {
        rooms.push(...(await this.roomsOfServer(ref)));
      } catch {
        failed.push({ id: ref.id, name: ref.name });
      }
    }));
    this.lastFailedServerIds = new Set(failed.map((f) => f.id));
    this.lastQueriedServerIds = new Set(refs.map((r) => r.id));
    return { rooms, failed, total: refs.length };
  }

  // Живые серверы (по последнему опросу) — для случайного выбора
  // при создании комнаты (online_lobby.gd:1044, 1076).
  liveServerRefs(): ServerRef[] {
    const all = listServerRefs();
    const pool = all.filter((r) => this.lastQueriedServerIds.size === 0 || this.lastQueriedServerIds.has(r.id));
    const live = pool.filter((r) => !this.lastFailedServerIds.has(r.id));
    return live.length > 0 ? live : pool;
  }

  async boardList(): Promise<BoardListMsg> {
    return (await this.session.request(C2S.BOARD_LIST, {}, [S2C.BOARD_LIST])) as unknown as BoardListMsg;
  }

  async createRoom(opts: { seats: number; require30: boolean; name: string; password: string }): Promise<RoomLobbyEnvelope> {
    const token = this.requireToken();
    const pkt = await this.session.request(C2S.ROOM_CREATE, { token, ...opts }, [S2C.ROOM_STATE, S2C.GAME_ERROR]);
    const env = roomReply(pkt);
    this.setPending(null);
    return env;
  }

  async joinRoom(code: string, password: string): Promise<RoomLobbyEnvelope | GameEnvelope> {
    const token = this.requireToken();
    const pkt = await this.session.request(C2S.ROOM_JOIN, { token, code, password }, [S2C.ROOM_STATE, S2C.GAME_STATE, S2C.GAME_ERROR]);
    if (pkt.t === S2C.GAME_STATE) {
      this.setPending(null);
      return pkt as unknown as GameEnvelope;
    }
    const env = roomReply(pkt);
    this.setPending(null);
    return env;
  }

  async startRoom(): Promise<GameEnvelope> {
    const token = this.requireToken();
    const pkt = await this.session.request(C2S.ROOM_START, { token }, [S2C.GAME_STATE, S2C.GAME_ERROR]);
    if (pkt.t !== S2C.GAME_STATE) throw new ServerError(String(pkt.reason ?? 'Не удалось начать'));
    this.setPending(null);
    return pkt as unknown as GameEnvelope;
  }

  async leaveRoom(): Promise<void> {
    const token = this.requireToken();
    const pkt = await this.session
      .request(C2S.ROOM_LEAVE, { token }, [S2C.ROOM_LEFT, S2C.GAME_ERROR])
      .catch(() => null);
    // Мягкий выход из партии: сервер присылает room — место за нами ещё
    // держится, и «вы всё ещё в комнате» должно остаться (net.gd:464-469).
    if (pkt && pkt.t === S2C.ROOM_LEFT) this.setPending((pkt as unknown as RoomLeftMsg).room ?? null);
    else this.setPending(null);
  }

  // Локальная парковка комнаты (net.gd park_room): вышли в главное меню,
  // не покидая комнату. Сервер о ней знает, баннер «вы всё ещё в комнате»
  // живёт до возврата/выхода.
  parkRoom(room: RoomLobbyView | null): void {
    this.setPending(room);
  }

  async dropRoom(): Promise<void> {
    const token = this.requireToken();
    await this.session.request(C2S.ROOM_DROP, { token }, [S2C.ROOM_LEFT, S2C.GAME_ERROR]).catch(() => undefined);
    this.setPending(null);
  }

  async rejoin(): Promise<GameEnvelope> {
    const token = this.requireToken();
    const pkt = await this.session.request(C2S.GAME_REJOIN, { token }, [S2C.GAME_STATE, S2C.GAME_ERROR]);
    if (pkt.t !== S2C.GAME_STATE) throw new ServerError(String(pkt.reason ?? 'Комната не найдена'));
    this.setPending(null);
    return pkt as unknown as GameEnvelope;
  }

  async quickJoin(seats: number, require30: boolean): Promise<QuickStateMsg | GameEnvelope> {
    const token = this.requireToken();
    const pkt = await this.session.request(C2S.QUICK_JOIN, { token, seats, require30 }, [S2C.QUICK_STATE, S2C.GAME_STATE, S2C.GAME_ERROR]);
    if (pkt.t === S2C.GAME_STATE) return pkt as unknown as GameEnvelope;
    return pkt as unknown as QuickStateMsg;
  }

  async quickLeave(): Promise<QuickStateMsg> {
    const token = this.requireToken();
    return (await this.session.request(C2S.QUICK_LEAVE, { token }, [S2C.QUICK_STATE])) as unknown as QuickStateMsg;
  }

  async commitSetTable(rows: TableRowMsg[]): Promise<GameEnvelope> {
    const token = this.requireToken();
    const pkt = await this.session.request(C2S.GAME_COMMIT, { token, ops: [{ op: 'set_table', rows }] }, [S2C.GAME_STATE, S2C.GAME_ERROR]);
    if (pkt.t !== S2C.GAME_STATE) throw new ServerError(String(pkt.reason ?? 'Ход не принят'));
    return pkt as unknown as GameEnvelope;
  }

  async draw(): Promise<GameEnvelope> {
    const token = this.requireToken();
    const pkt = await this.session.request(C2S.GAME_DRAW, { token }, [S2C.GAME_STATE, S2C.GAME_ERROR]);
    if (pkt.t !== S2C.GAME_STATE) throw new ServerError(String(pkt.reason ?? 'Не удалось взять'));
    return pkt as unknown as GameEnvelope;
  }

  async skip(): Promise<GameEnvelope> {
    const token = this.requireToken();
    const pkt = await this.session.request(C2S.GAME_SKIP, { token }, [S2C.GAME_STATE, S2C.GAME_ERROR]);
    if (pkt.t !== S2C.GAME_STATE) throw new ServerError(String(pkt.reason ?? 'Не удалось пропустить'));
    return pkt as unknown as GameEnvelope;
  }

  sendPeek(payload: { tile: number; kind: 'clear' | 'into' | 'new' | 'back'; row?: number; index?: number }): void {
    const token = this.savedToken;
    if (!token) return;
    this.sendQuiet(C2S.GAME_PEEK, { token, ...payload });
  }

  sendDraft(rows: TableRowMsg[]): void {
    const token = this.savedToken;
    if (!token) return;
    this.sendQuiet(C2S.GAME_DRAFT, { token, rows });
  }

  private sendQuiet(t: string, payload: Record<string, unknown>): void {
    try {
      this.session.send({ t, ...payload });
    } catch {
      /* offline */
    }
  }

  private routeBroadcast(pkt: ServerPacket): void {
    switch (pkt.t) {
      case S2C.GAME_STATE:
        // живой эталон партии: ожидание места закончилось
        this.setPending(null);
        this.listeners.onGame?.(pkt as unknown as GameEnvelope);
        break;
      case S2C.ROOM_STATE:
        this.setPending(null);
        this.listeners.onLobby?.(pkt as unknown as RoomLobbyEnvelope);
        break;
      case S2C.TOAST:
        this.listeners.onToast?.(pkt as unknown as ToastMsg);
        break;
      case S2C.QUICK_STATE:
        this.listeners.onQuick?.(pkt as unknown as QuickStateMsg);
        break;
      case S2C.GAME_ERROR:
        this.listeners.onError?.(pkt as unknown as GameErrorMsg);
        break;
      case S2C.GAME_DRAFT:
        this.listeners.onDraft?.(pkt as unknown as DraftMsg);
        break;
      case S2C.ROOM_LEFT: {
        const left = pkt as unknown as RoomLeftMsg;
        // мягкий выход/выгон: место за нами сохранилось (net.gd:464-469)
        this.setPending(left.room ?? null);
        this.listeners.onLeft?.(left);
        break;
      }
      default:
        break;
    }
  }
}

export class AuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AuthError';
  }
}

export class ServerError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ServerError';
  }
}

function roomReply(pkt: ServerPacket): RoomLobbyEnvelope {
  if (pkt.t !== S2C.ROOM_STATE) throw new ServerError(String(pkt.reason ?? 'Комната недоступна'));
  return pkt as unknown as RoomLobbyEnvelope;
}

export function applyBootstrapLanguage(): void {
  loadSettings();
}

// Гонка с таймаутом: быстрый отказ, как probe серверов (servers.gd:140-231).
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e as Error); },
    );
  });
}
