import { C2S, parsePacket, ServerPacket, S2C } from './protocol';

export class SessionClosedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SessionClosedError';
  }
}

interface Waiter {
  resolve: (pkt: ServerPacket) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  expect: string[] | null;
}

const PING_INTERVAL_MS = 20000;
const REQUEST_TIMEOUT_MS = 20000;
// Backoff переподключения (net.gd:25-26, 349-364)
const RECONNECT_MIN_MS = 800;
const RECONNECT_MAX_MS = 15000;
// Выгнали вторым окном: переподключение запрещено (net.gd:30, 327-346)
const CLOSE_CODE_KICKED = 4001;

export class Session {
  private ws: WebSocket | null = null;
  private ridCounter = 0;
  private waiters = new Map<string, Waiter>();
  readonly broadcastListeners = new Set<(pkt: ServerPacket) => void>();
  readonly closedHandlers = new Set<() => void>();
  // после успешного переподключения и приветствия (нужно resume/rejoin)
  readonly reconnectedHandlers = new Set<() => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private helloPromise: Promise<ServerPacket> | null = null;
  private lastUrl = '';
  private closeCode = 0;
  private manualClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;

  async open(url: string): Promise<ServerPacket> {
    this.manualClose = false;
    this.closeCode = 0;
    this.lastUrl = url;
    this.cancelReconnect();
    closeSilently(this.ws);
    const ws = new WebSocket(url);
    this.ws = ws;
    this.attach();
    this.helloPromise = new Promise<ServerPacket>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new TimeoutError('Подключение: сервер не отвечает'));
      }, REQUEST_TIMEOUT_MS);
      ws.addEventListener('open', () => undefined, { once: true });
      ws.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new SessionClosedError('Хост недоступен'));
      }, { once: true });
      ws.addEventListener('message', (ev) => {
        if (settled) return;
        let pkt: ServerPacket;
        try {
          pkt = parsePacket(String(ev.data));
        } catch {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(pkt);
      });
    });
    return this.helloPromise;
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.closeCode === CLOSE_CODE_KICKED || this.lastUrl === '') return;
    this.cancelReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectAttempt();
    }, this.reconnectDelay);
    // удвоение с потолком
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(this.reconnectDelay * 1.7));
  }

  private async reconnectAttempt(): Promise<void> {
    try {
      const hello = await this.open(this.lastUrl);
      if (hello.t !== S2C.HELLO) throw new SessionClosedError('не hello');
      this.reconnectDelay = RECONNECT_MIN_MS;
      for (const fn of [...this.reconnectedHandlers]) {
        try { fn(); } catch { /* слушатель сам решит */ }
      }
    } catch {
      // не удалось — снова в очередь
      this.scheduleReconnect();
    }
  }

  private attach(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.addEventListener('message', (ev) => {
      if (ws !== this.ws) return; // старая сокетка после переподключения
      let pkt: ServerPacket;
      try {
        pkt = parsePacket(String(ev.data));
      } catch {
        return;
      }
      this.route(pkt);
    });
    ws.addEventListener('close', (ev) => {
      // Закрытие ПРЕЖНЕГО сокета (мы уже открыли новый) — не потеря связи:
      // иначе каждый новый open запускал бы ещё один reconnect и шторм
      // подключений, а сервер выбивал бы нас кодом 4001 «заменён».
      if (ws !== this.ws) return;
      this.closeCode = typeof ev.code === 'number' ? ev.code : 0;
      this.failAll(new SessionClosedError('Соединение закрыто'));
      for (const fn of this.closedHandlers) fn();
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      if (ws !== this.ws) return;
      this.failAll(new SessionClosedError('Ошибка соединения'));
    });
  }

  private route(pkt: ServerPacket): void {
    const rid = pkt.rid;
    if (rid !== undefined && typeof rid === 'string') {
      const w = this.waiters.get(rid);
      if (w) {
        this.waiters.delete(rid);
        clearTimeout(w.timer);
        if (w.expect === null || w.expect.includes(pkt.t)) {
          w.resolve(pkt);
        } else {
          w.reject(new UnexpectedReplyError(pkt));
        }
        return;
      }
    }
    for (const l of this.broadcastListeners) l(pkt);
  }

  private failAll(e: Error): void {
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(e);
    }
    this.waiters.clear();
    if (this.helloPromise) {
      void this.helloPromise.catch(() => undefined);
      this.helloPromise = null;
    }
  }

  send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new SessionClosedError('Соединение не открыто');
    }
    this.ws.send(JSON.stringify(payload));
  }

  request(t: string, payload: Record<string, unknown> = {}, expect: string[] | null = null): Promise<ServerPacket> {
    const rid = `r${(this.ridCounter += 1)}`;
    return new Promise<ServerPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(rid);
        reject(new TimeoutError(`${t}: сервер не ответил`));
      }, REQUEST_TIMEOUT_MS);
      this.waiters.set(rid, { resolve, reject, timer, expect });
      try {
        this.send({ t, rid, ...payload });
      } catch (e) {
        clearTimeout(timer);
        this.waiters.delete(rid);
        reject(new SessionClosedError((e as Error).message));
      }
    });
  }

  async requestOk(t: string, payload: Record<string, unknown> = {}, expect?: string[]): Promise<ServerPacket> {
    return this.request(t, payload, expect);
  }

  startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try {
        this.request(C2S.PING, {}, ['pong']).catch(() => undefined);
      } catch {
        /* offline */
      }
    }, PING_INTERVAL_MS);
  }

  stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  close(): void {
    this.manualClose = true;
    this.stopPing();
    this.cancelReconnect();
    this.failAll(new SessionClosedError('Соединение закрыто локально'));
    closeSilently(this.ws);
    this.ws = null;
    // broadcastListeners не чистим: это постоянные слушатели Api
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // Идёт авто-переподключение: UI не должен открывать ещё одно соединение.
  get reconnecting(): boolean {
    return this.reconnectTimer !== null;
  }
}

export class TimeoutError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TimeoutError';
  }
}

export class UnexpectedReplyError extends Error {
  pkt: ServerPacket;
  constructor(pkt: ServerPacket) {
    super(`неожиданный тип ответа: ${pkt.t}`);
    this.pkt = pkt;
  }
}

function closeSilently(ws: WebSocket | null): void {
  if (!ws) return;
  try {
    ws.close();
  } catch {
    /* already closed */
  }
}
