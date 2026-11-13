import type {
  DeviceKind,
  PlatformLeaderboard,
  PlatformLeaderboardEntry,
  PlatformPlayer,
} from './types';
import { BasePlatform } from './base';
import {
  browserExitFullscreen,
  browserIsFullscreen,
  browserToggleFullscreen,
} from './browser';

// Минимальные типы GamePush SDK (https://docs.gamepush.com).
// SDK приходит в global-функцию onGPInit, поэтому конкретные поля описываем
// только для того, что реально используем, и все вызовы оборачиваем.
interface GpAds {
  showFullscreen?: (opts?: Record<string, unknown>) => Promise<unknown> | void;
  showRewardedVideo?: (opts?: Record<string, unknown>) => Promise<unknown> | void;
  showSticky?: () => Promise<unknown> | void;
  closeSticky?: () => Promise<unknown> | void;
  isFullscreenAvailable?: boolean;
  isRewardedAvailable?: boolean;
  isStickyAvailable?: boolean;
}

interface GpPlayer {
  id?: number | string;
  name?: string;
  avatar?: string;
  isLoggedIn?: boolean;
  authToken?: string;
  ready?: Promise<unknown>;
  get?: (key: string) => unknown;
  set?: (key: string, value: unknown) => void;
  sync?: (opts?: Record<string, unknown>) => Promise<unknown>;
  login?: () => Promise<unknown> | void;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
}

interface GpLeaderboardPlayer {
  id?: number | string;
  name?: string;
  position?: number;
  rank?: number;
  score?: number;
  [key: string]: unknown;
}

interface GpLeaderboardResult {
  players?: GpLeaderboardPlayer[];
  topPlayers?: GpLeaderboardPlayer[];
  player?: GpLeaderboardPlayer;
}

interface GpLeaderboard {
  fetch?: (opts: Record<string, unknown>) => Promise<GpLeaderboardResult>;
  fetchScoped?: (opts: Record<string, unknown>) => Promise<GpLeaderboardResult>;
  publishRecord?: (opts: Record<string, unknown>) => Promise<unknown>;
}

interface GpFullscreen {
  isEnabled?: boolean;
  open?: () => Promise<unknown> | void;
  close?: () => Promise<unknown> | void;
  toggle?: () => Promise<unknown> | void;
}

interface GpPlatformInfo {
  type?: string;
  hasIntegratedAuth?: boolean;
  isLogoutAvailable?: boolean;
  isSecretCodeAuthAvailable?: boolean;
}

interface GamePushSdk {
  player?: GpPlayer;
  ads?: GpAds;
  leaderboard?: GpLeaderboard;
  fullscreen?: GpFullscreen;
  platform?: GpPlatformInfo;
  language?: string;
  isMobile?: boolean;
  isPaused?: boolean;
  gameStart?: () => void;
  gameplayStart?: () => void;
  gameplayStop?: () => void;
  on?: (event: string, cb: () => void) => void;
}

declare global {
  interface Window {
    gp?: GamePushSdk;
    // onGPInit вызывается SDK; сниппет в index.html кладёт сюда же объект.
    __dgGP?: GamePushSdk | null;
    // Синхронный маркер: на странице есть сниппет GamePush, даже если SDK
    // ещё не успел загрузиться. Нужен для автоопределения площадки.
    __dgGamePush?: boolean;
  }
}

function sdk(): GamePushSdk | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.__dgGP ?? window.gp ?? null;
  } catch {
    return null;
  }
}

function langCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 2) return null;
  return value.slice(0, 2).toLowerCase();
}

function navigatorLang(): string | null {
  try {
    return langCode(typeof navigator !== 'undefined' ? navigator.language : null);
  } catch {
    return null;
  }
}

// Таблица wins, созданная в панели GamePush (Leaderboards → #101345).
// Глобальный fetch ищет таблицу по тегу global@wins; ручная таблица имеет тег
// wins и доступна через scoped-API. Сначала используем точный ID, затем тег,
// чтобы пересоздание таблицы с тем же тегом не ломало игру.
const WINS_BOARD_ID = 101345;
const WINS_BOARD_TAG = 'wins';
const WINS_BOARD_VARIANT = 'all';

type ScopedBoardRef = { id?: number; tag?: string; variant?: string };

function waitValue<T>(p: Promise<T> | undefined, ms: number, fallback: T): Promise<T> {
  if (!p) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    let done = false;
    const finish = (value: T): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    try {
      p.then(finish).catch(() => finish(fallback));
    } catch {
      finish(fallback);
    }
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(label))), ms);
    try {
      p.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
      );
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}


// Рекламные методы GamePush возвращают Promise. Для fullscreen «успех» — это
// любое завершение, кроме явного false; для rewarded награда только при true.
function adFinished(p: Promise<unknown> | void, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), ms);
    try {
      if (!p) {
        finish(true);
        return;
      }
      p.then((value) => finish(value !== false)).catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
}

function rewardedFinished(p: Promise<unknown> | void, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), ms);
    try {
      if (!p) {
        finish(false);
        return;
      }
      p.then((value) => finish(value === true)).catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
}

/**
 * GamePush (https://docs.gamepush.com).
 *
 * SDK подключается сниппетом из index.html (только в сборке `--mode gamepush`)
 * и сам определяет нижележащую площадку: свой сайт, Яндекс Игры, VK, Telegram
 * и т. д. Игра при этом общается только с `PlatformAPI`, а не с gp напрямую.
 *
 * Что используем:
 * - `gp.gameStart()` — игра загрузилась;
 * - `gp.gameplayStart/Stop()` — разметка геймплея;
 * - `gp.ads.showFullscreen/showRewardedVideo` и sticky-баннер;
 * - `gp.player` — профиль, явный вход и поле `wins` для таблицы;
 * - `gp.leaderboard.fetch` — витрина лидерборда GamePush;
 * - `gp.fullscreen` — полноэкранный режим;
 * - `gp.language`, `gp.isMobile`, события pause/resume.
 *
 * Ограничение и особенности лидерборда: в панели GamePush нужно числовое
 * поле `wins` (number, public). Ручная таблица `wins` — это scoped-таблица:
 * игра сначала ищет её по ID/тегу и публикует рекорд через
 * `publishRecord`, а глобальную `global@wins` (если она есть) обновляет
 * через `player.set('wins') + sync`. Если ни одной таблицы нет, витрина
 * покажет ошибку — серверный рейтинг остаётся основным.
 */
export class GamePushPlatform extends BasePlatform {
  readonly id = 'gamepush' as const;
  readonly supportsRewarded = true;
  readonly supportsFullscreen = true;
  readonly supportsReview = false;
  readonly supportsShortcut = false;

  get isEmbedded(): boolean {
    // GamePush — платформенный слой; даже на своём сайте он управляет
    // полноэкранным режимом и рекламой как площадка.
    return true;
  }

  private lang: string | null = null;
  private pauseCbs: Array<() => void> = [];
  private resumeCbs: Array<() => void> = [];
  private subscribed = false;
  // Какая таблица wins реально ответила: ручная scoped или глобальная.
  private boardRef: ScopedBoardRef | 'global' | null = null;

  async init(): Promise<void> {
    try {
      if (typeof window === 'undefined') return;
      // Не ждём дольше общего таймаута initPlatform: если SDK загрузится
      // позже, методы всё равно увидят его через sdk().
      const gp = await this.waitForSdk(1200);
      if (!gp) return;
      this.lang = langCode(gp.language);
      this.subscribe();
    } catch {
      // SDK недоступен — игра работает без платформенных функций.
    }
  }

  private async waitForSdk(ms: number): Promise<GamePushSdk | null> {
    const ready = sdk();
    if (ready) return ready;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const gp = sdk();
      if (gp) return gp;
    }
    return sdk();
  }

  private subscribe(): void {
    if (this.subscribed) return;
    const gp = sdk();
    if (!gp?.on) return;
    this.subscribed = true;
    try {
      gp.on('pause', () => this.fire(this.pauseCbs));
    } catch {
      /* ignore */
    }
    try {
      gp.on('resume', () => this.fire(this.resumeCbs));
    } catch {
      /* ignore */
    }
  }

  private fire(cbs: Array<() => void>): void {
    for (const cb of cbs) {
      try {
        cb();
      } catch {
        /* подписчик не должен ломать остальные */
      }
    }
  }

  onPause(cb: () => void): void {
    this.pauseCbs.push(cb);
    this.subscribe();
  }

  onResume(cb: () => void): void {
    this.resumeCbs.push(cb);
    this.subscribe();
  }

  gameReady(): void {
    this.subscribe();
    try {
      sdk()?.gameStart?.();
    } catch {
      /* ignore */
    }
  }

  gameplayStart(): void {
    try {
      sdk()?.gameplayStart?.();
    } catch {
      /* ignore */
    }
  }

  gameplayStop(): void {
    try {
      sdk()?.gameplayStop?.();
    } catch {
      /* ignore */
    }
  }

  async showInterstitial(): Promise<boolean> {
    const ads = sdk()?.ads;
    if (!ads?.showFullscreen || ads.isFullscreenAvailable === false) return false;
    try {
      return await adFinished(ads.showFullscreen(), 20000);
    } catch {
      return false;
    }
  }

  async showRewarded(): Promise<boolean> {
    const ads = sdk()?.ads;
    if (!ads?.showRewardedVideo || ads.isRewardedAvailable === false) return false;
    try {
      return await rewardedFinished(ads.showRewardedVideo(), 60000);
    } catch {
      return false;
    }
  }

  setBannerVisible(visible: boolean): void {
    try {
      const ads = sdk()?.ads;
      if (!ads) return;
      if (visible && ads.isStickyAvailable === false) return;
      const result = visible ? ads.showSticky?.() : ads.closeSticky?.();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  }

  async getPlayer(): Promise<PlatformPlayer | null> {
    try {
      const player = sdk()?.player;
      if (!player) return null;
      // player.ready — синхронизация с сервером GamePush. Ждём ограниченно:
      // лобби не должно зависать, если сеть площадки недоступна.
      await waitValue(player.ready, 5000, undefined);
      let id: unknown = player.id;
      if (id === undefined || id === null) {
        try {
          id = player.get?.('id');
        } catch {
          /* optional */
        }
      }
      if (id === undefined || id === null || String(id).trim() === '') return null;
      let name = String(player.name ?? '').trim();
      if (name === '') {
        try {
          name = String(player.get?.('name') ?? '').trim();
        } catch {
          /* optional */
        }
      }
      return {
        uid: String(id),
        name,
        authorized: !!player.isLoggedIn,
      };
    } catch {
      return null;
    }
  }

  async openAuthDialog(): Promise<boolean> {
    const player = sdk()?.player;
    const login = player?.login;
    if (!player || !login) return false;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), 60000);
      try {
        // Основной сигнал — событие login; Promise-форма поддерживается не
        // всеми версиями SDK, поэтому обрабатываем оба варианта.
        player.on?.('login', (...args: unknown[]) => {
          const value = args[0];
          finish(typeof value === 'boolean' ? value : true);
        });
        const result = login.call(player);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          (result as Promise<unknown>)
            .then((value) => {
              if (typeof value === 'boolean') finish(value);
            })
            .catch(() => finish(false));
        }
      } catch {
        finish(false);
      }
    });
  }

  private scopedRefs(): ScopedBoardRef[] {
    const refs: ScopedBoardRef[] = [
      { id: WINS_BOARD_ID },
      { tag: WINS_BOARD_TAG, variant: WINS_BOARD_VARIANT },
      { tag: WINS_BOARD_TAG },
    ];
    if (this.boardRef && this.boardRef !== 'global') {
      const key = JSON.stringify(this.boardRef);
      return [this.boardRef, ...refs.filter((ref) => JSON.stringify(ref) !== key)];
    }
    return refs;
  }

  private async fetchScopedBoard(
    ref: ScopedBoardRef,
    field: string,
  ): Promise<{ result: GpLeaderboardResult | null; error?: string }> {
    const leaderboard = sdk()?.leaderboard;
    if (!leaderboard?.fetchScoped) return { result: null, error: 'no scoped leaderboard API' };
    try {
      const result = await withTimeout(
        leaderboard.fetchScoped({
          ...ref,
          order: 'DESC',
          limit: 10,
          includeFields: ['rank'],
          withMe: 'first',
        }),
        10000,
        'leaderboard timeout',
      );
      return { result };
    } catch (error) {
      return { result: null, error: (error as Error).message || 'leaderboard unavailable' };
    }
  }

  private async fetchGlobalBoard(
    field: string,
  ): Promise<{ result: GpLeaderboardResult | null; error?: string }> {
    const leaderboard = sdk()?.leaderboard;
    if (!leaderboard?.fetch) return { result: null, error: 'no leaderboard API' };
    try {
      const result = await withTimeout(
        leaderboard.fetch({
          orderBy: [field],
          order: 'DESC',
          limit: 10,
          includeFields: ['rank'],
          withMe: 'first',
        }),
        10000,
        'leaderboard timeout',
      );
      return { result };
    } catch (error) {
      return { result: null, error: (error as Error).message || 'leaderboard unavailable' };
    }
  }

  private parseBoard(result: GpLeaderboardResult, field: string): PlatformLeaderboard {
    // topPlayers — чистый список лидеров. players может содержать моего
    // игрока первым (withMe: 'first'), поэтому он только резерв.
    const raw = Array.isArray(result.topPlayers)
      ? result.topPlayers
      : Array.isArray(result.players)
        ? result.players
        : [];
    const entries: PlatformLeaderboardEntry[] = [];
    const seen = new Set<string>();
    raw.forEach((entry, index) => {
      const key = `${entry.id ?? ''}|${entry.name ?? ''}|${entry.position ?? index}`;
      if (seen.has(key)) return;
      seen.add(key);
      const score = Number(entry[field] ?? entry.score ?? 0);
      const rank = Number(entry.position ?? entry.rank ?? index + 1);
      entries.push({
        name: String(entry.name ?? '').trim() || '—',
        score: Math.max(0, Math.floor(Number.isFinite(score) ? score : 0)),
        rank: Math.max(0, Math.floor(Number.isFinite(rank) ? rank : index + 1)),
      });
    });
    entries.sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
    const userRank = Number(result.player?.position ?? result.player?.rank ?? 0);
    return {
      entries: entries.slice(0, 10),
      userRank: Math.max(0, Math.floor(Number.isFinite(userRank) ? userRank : 0)),
    };
  }

  async getLeaderboardEntries(name: string): Promise<PlatformLeaderboard> {
    const field = String(name || 'wins');
    let lastError = '';
    // Ручная таблица wins — scoped: именно её создают в панели GamePush.
    // Глобальная таблица global@wins используется как резерв.
    if (this.boardRef !== 'global') {
      for (const ref of this.scopedRefs()) {
        const res = await this.fetchScopedBoard(ref, field);
        if (res.result) {
          this.boardRef = ref;
          return this.parseBoard(res.result, field);
        }
        lastError = res.error || lastError;
      }
    }
    const global = await this.fetchGlobalBoard(field);
    if (global.result) {
      this.boardRef = 'global';
      return this.parseBoard(global.result, field);
    }
    lastError = global.error || lastError;
    return { entries: [], userRank: 0, error: lastError || 'leaderboard unavailable' };
  }

  async reportLeaderboardScore(name: string, score: number): Promise<boolean> {
    const gp = sdk();
    const leaderboard = gp?.leaderboard;
    const player = gp?.player;
    if (!Number.isFinite(score) || score < 0) return false;
    const field = String(name || 'wins');
    const wins = Math.max(0, Math.floor(score));
    let ok = false;

    // Scoped-таблица не синхронизируется автоматически: рекорд нужно
    // опубликовать явно. Если таблицу пересоздали, пробуем ID, тег и scope.
    if (this.boardRef !== 'global' && leaderboard?.publishRecord) {
      const refs = this.boardRef ? [this.boardRef] : this.scopedRefs();
      for (const ref of refs) {
        try {
          await withTimeout(
            Promise.resolve(leaderboard.publishRecord({
              ...ref,
              record: { [field]: wins },
              override: true,
            })),
            10000,
            'publish timeout',
          );
          this.boardRef = ref;
          ok = true;
          break;
        } catch {
          /* пробуем следующую форму таблицы */
        }
      }
    }

    // Поле wins всё равно синхронизируем: если в проекте есть глобальная
    // таблица global@wins, она обновится автоматически.
    if (player?.set && player.sync) {
      try {
        player.set(field, wins);
        await withTimeout(
          player.sync({ storage: 'preferred' }) as Promise<unknown>,
          10000,
          'sync timeout',
        );
        ok = true;
      } catch {
        /* глобальная таблица не настроена — scoped-публикация уже могла пройти */
      }
    }
    return ok;
  }

  getInterfaceLang(): string | null {
    return this.lang ?? navigatorLang();
  }

  getDevice(): DeviceKind {
    try {
      const mobile = sdk()?.isMobile;
      if (mobile === true) return 'mobile';
      if (mobile === false) return 'desktop';
    } catch {
      /* ignore */
    }
    return 'unknown';
  }

  isFullscreen(): boolean {
    try {
      const fs = sdk()?.fullscreen;
      if (typeof fs?.isEnabled === 'boolean') return fs.isEnabled;
    } catch {
      /* ignore */
    }
    return browserIsFullscreen();
  }

  async toggleFullscreen(): Promise<boolean> {
    try {
      const fs = sdk()?.fullscreen;
      if (fs?.toggle) {
        await Promise.resolve(fs.toggle());
        return this.isFullscreen();
      }
      if (fs) {
        if (this.isFullscreen()) await Promise.resolve(fs.close?.());
        else await Promise.resolve(fs.open?.());
        return this.isFullscreen();
      }
    } catch {
      /* платформа запретила смену режима — пробуем браузерный API */
    }
    return browserToggleFullscreen();
  }

  async exitFullscreen(): Promise<boolean> {
    try {
      const fs = sdk()?.fullscreen;
      if (fs?.close) {
        await Promise.resolve(fs.close());
        return this.isFullscreen();
      }
    } catch {
      /* ignore */
    }
    return browserExitFullscreen();
  }
}
