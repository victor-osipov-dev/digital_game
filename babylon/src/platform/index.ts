import type { DeviceKind, PlatformAPI, PlatformId, PlatformLeaderboard, PlatformPlayer } from './types';
import { detectPlatformId } from './detect';
import { StandalonePlatform } from './noop';
import { YandexPlatform } from './yandex';
import { GamePushPlatform } from './gamepush';
import { CrazyGamesPlatform } from './crazygames';
import { GameDistributionPlatform } from './gamedistribution';
import {
  installFullscreenBridge,
  reportedFullscreenState,
  requestParentFullscreen,
} from './fullscreen_bridge';

export type { PlatformAPI, PlatformId, PlatformLeaderboard, PlatformLeaderboardEntry, PlatformPlayer } from './types';
export type { DeviceKind } from './types';

function hasExplicitPlatformParam(): boolean {
  try {
    if (typeof window === 'undefined' || !window.location) return false;
    return /(?:^|[?&])platform=[a-z]+/i.test(window.location.search ?? '');
  } catch {
    return false;
  }
}

function loadProbeScript(src: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (typeof document === 'undefined') {
        resolve();
        return;
      }
      const timer = window.setTimeout(resolve, timeoutMs);
      const el = document.createElement('script');
      el.async = true;
      el.src = src;
      const done = (): void => {
        window.clearTimeout(timer);
        resolve();
      };
      el.onload = done;
      el.onerror = done;
      document.head.appendChild(el);
    } catch {
      resolve();
    }
  });
}

function yaGamesPresent(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.YaGames;
  } catch {
    return false;
  }
}
function readGlobals(): {
  hasYaGames: boolean;
  hasGamePush: boolean;
  hasCrazyGames: boolean;
  hasGDSdk: boolean;
} {
  try {
    return {
      hasYaGames: typeof window.YaGames !== 'undefined',
      // __dgGamePush ставится синхронным сниппетом до загрузки SDK, поэтому
      // площадка опознаётся даже если game-score.js ещё не пришёл.
      hasGamePush: typeof window.__dgGP !== 'undefined'
        || typeof window.gp !== 'undefined'
        || window.__dgGamePush === true,
      hasCrazyGames: typeof window.CrazyGames?.SDK !== 'undefined',
      hasGDSdk: typeof window.gdsdk !== 'undefined',
    };
  } catch {
    return { hasYaGames: false, hasGamePush: false, hasCrazyGames: false, hasGDSdk: false };
  }
}

function readLocation(): { query: string; hostname: string } {
  try {
    if (typeof window === 'undefined' || !window.location) return { query: '', hostname: '' };
    return {
      query: window.location.search ?? '',
      hostname: (window.location.hostname ?? '').toLowerCase(),
    };
  } catch {
    return { query: '', hostname: '' };
  }
}

// Цель сборки задаётся Vite-define (см. vite.config.ts). 'auto' — площадка
// определяется в рантайме; иное значение жёстко фиксирует площадку, чтобы
// сборка для своего сайта не содержала и не пыталась загрузить Яндекс SDK.
function buildPlatformTarget(): PlatformId | null {
  try {
    const v = __DG_PLATFORM_TARGET__;
    if (v === 'yandex' || v === 'gamepush' || v === 'crazygames'
      || v === 'gamedistribution' || v === 'standalone') {
      return v;
    }
  } catch {
    // define не подставлен (например, юнит-тесты) — работаем в auto-режиме.
  }
  return null;
}

const forcedTarget = buildPlatformTarget();

/** Площадка, определённая синхронно при загрузке (цель сборки + детект + ?platform=). */
export const platformId: PlatformId = forcedTarget
  ?? detectPlatformId({ ...readLocation(), ...readGlobals() });

function createProvider(id: PlatformId): PlatformAPI {
  switch (id) {
    case 'yandex':
      return new YandexPlatform();
    case 'gamepush':
      return new GamePushPlatform();
    case 'crazygames':
      return new CrazyGamesPlatform();
    case 'gamedistribution':
      return new GameDistributionPlatform();
    default:
      return new StandalonePlatform();
  }
}

/**
 * Фасад: код игры всегда обращается к `platform`, конкретный провайдер
 * подставляется в initPlatform(). До инициализации работает standalone.
 */
class PlatformFacade implements PlatformAPI {
  private current: PlatformAPI = new StandalonePlatform();

  setProvider(p: PlatformAPI): void {
    this.current = p;
  }

  get id(): PlatformId {
    return this.current.id;
  }

  get isEmbedded(): boolean {
    try {
      return this.current.isEmbedded;
    } catch {
      return false;
    }
  }

  get supportsRewarded(): boolean {
    try {
      return this.current.supportsRewarded;
    } catch {
      return false;
    }
  }

  get supportsFullscreen(): boolean {
    try {
      return this.current.supportsFullscreen;
    } catch {
      return false;
    }
  }

  get supportsReview(): boolean {
    try {
      return this.current.supportsReview;
    } catch {
      return false;
    }
  }

  get supportsShortcut(): boolean {
    try {
      return this.current.supportsShortcut;
    } catch {
      return false;
    }
  }

  async init(): Promise<void> {
    await this.current.init();
  }

  gameReady(): void {
    try {
      this.current.gameReady();
    } catch {
      /* ignore */
    }
  }

  gameplayStart(): void {
    try {
      this.current.gameplayStart();
    } catch {
      /* ignore */
    }
  }

  gameplayStop(): void {
    try {
      this.current.gameplayStop();
    } catch {
      /* ignore */
    }
  }

  async showInterstitial(): Promise<boolean> {
    try {
      return await this.current.showInterstitial();
    } catch {
      return false;
    }
  }

  async showRewarded(): Promise<boolean> {
    try {
      return await this.current.showRewarded();
    } catch {
      return false;
    }
  }

  async getPlayer(): Promise<PlatformPlayer | null> {
    try {
      return await this.current.getPlayer();
    } catch {
      return null;
    }
  }

  async openAuthDialog(): Promise<boolean> {
    try {
      return await this.current.openAuthDialog();
    } catch {
      return false;
    }
  }

  async getLeaderboardEntries(name: string): Promise<PlatformLeaderboard> {
    try {
      return await this.current.getLeaderboardEntries(name);
    } catch (e) {
      return { entries: [], userRank: 0, error: (e as Error).message || 'unavailable' };
    }
  }

  async reportLeaderboardScore(name: string, score: number): Promise<boolean> {
    try {
      return await this.current.reportLeaderboardScore(name, score);
    } catch {
      return false;
    }
  }

  getInterfaceLang(): string | null {
    try {
      return this.current.getInterfaceLang();
    } catch {
      return null;
    }
  }

  getDevice(): DeviceKind {
    try {
      return this.current.getDevice();
    } catch {
      return 'unknown';
    }
  }

  isFullscreen(): boolean {
    // Во фрейме состояние сообщает родитель (fimdi-мост): изнутри
    // document.fullscreenElement не виден. Учитываем оба источника.
    if (reportedFullscreenState() === true) return true;
    try {
      return this.current.isFullscreen();
    } catch {
      return false;
    }
  }

  async exitFullscreen(): Promise<boolean> {
    let result = false;
    try {
      result = await this.current.exitFullscreen();
    } catch {
      result = false;
    }
    // Внутри фрейма полноэкранным режимом управляет родитель — просим и его.
    try {
      if (this.isEmbedded) requestParentFullscreen(false);
    } catch {
      /* ignore */
    }
    return result;
  }

  async toggleFullscreen(): Promise<boolean> {
    try {
      return await this.current.toggleFullscreen();
    } catch {
      return false;
    }
  }

  setBannerVisible(visible: boolean): void {
    try {
      this.current.setBannerVisible(visible);
    } catch {
      /* ignore */
    }
  }

  async canReview(): Promise<boolean> {
    try {
      return await this.current.canReview();
    } catch {
      return false;
    }
  }

  async requestReview(): Promise<boolean> {
    try {
      return await this.current.requestReview();
    } catch {
      return false;
    }
  }

  async canAddShortcut(): Promise<boolean> {
    try {
      return await this.current.canAddShortcut();
    } catch {
      return false;
    }
  }

  async addShortcut(): Promise<boolean> {
    try {
      return await this.current.addShortcut();
    } catch {
      return false;
    }
  }

  async writeClipboard(text: string): Promise<boolean> {
    try {
      return await this.current.writeClipboard(text);
    } catch {
      return false;
    }
  }

  onPause(cb: () => void): void {
    try {
      this.current.onPause(cb);
    } catch {
      /* ignore */
    }
  }

  onResume(cb: () => void): void {
    try {
      this.current.onResume(cb);
    } catch {
      /* ignore */
    }
  }
}

export const platform: PlatformAPI = new PlatformFacade();

let initialized = false;

/**
 * Инициализация площадки. Никогда не бросает исключение и ограничена
 * таймаутом, чтобы игра запускалась даже без сети/SDK.
 */
export async function initPlatform(opts: { timeoutMs?: number } = {}): Promise<PlatformAPI> {
  if (initialized) return platform;
  initialized = true;
  // Мост с родителем (fimdi): состояние полноэкранного режима из фрейма.
  installFullscreenBridge();
  const timeoutMs = opts.timeoutMs ?? 2000;
  let provider = createProvider(platformId);
  // Детект выполняется один раз при загрузке модуля — до появления SDK,
  // который площадки/прокси могут подгрузить позже. Если площадка не
  // опознана и пользователь явно не зафиксировал standalone, пробуем
  // относительный /sdk.js: именно его отдают и Яндекс, и его dev-proxy.
  // На своём сайте это быстрый 404 без последствий.
  if (forcedTarget === null && platformId === 'standalone'
    && !hasExplicitPlatformParam() && !yaGamesPresent()) {
    await loadProbeScript('/sdk.js', Math.min(1500, timeoutMs));
    if (yaGamesPresent()) {
      provider = new YandexPlatform();
    }
  }
  (platform as PlatformFacade).setProvider(provider);
  try {
    let timer = 0;
    const timeout = new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, timeoutMs);
    });
    await Promise.race([provider.init(), timeout]);
    window.clearTimeout(timer);
  } catch {
    /* остаёмся на частично инициализированном провайдере — все методы безопасны */
  }
  try {
    // Одна строка диагностики: какая площадка определена и подключился ли SDK.
    // Это info, не ошибка (п. 6.4 требует отсутствия именно ошибок в консоли).
    // id берём у активного провайдера: после probe он может отличаться
    // от стартового platformId.
    console.info(
      `[platform] id=${platform.id} embedded=${platform.isEmbedded} ` +
        `lang=${platform.getInterfaceLang() ?? 'n/a'} rewarded=${platform.supportsRewarded}`,
    );
  } catch {
    /* ignore */
  }
  return platform;
}

/** Язык интерфейса площадки ('ru' | 'en' | ...), null — неизвестен. */
export function getPlatformInterfaceLang(): string | null {
  return platform.getInterfaceLang();
}

/**
 * Показать interstitial-рекламу в логической паузе и продолжить действие.
 * Действие выполняется ВСЕГДА — даже если рекламы нет или SDK упал.
 */
export function withInterstitial(action: () => void): void {
  platform.gameplayStop();
  void platform
    .showInterstitial()
    .catch(() => false)
    .then(() => action());
}
