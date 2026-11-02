import type { DeviceKind, PlatformAPI, PlatformId } from './types';
import { detectPlatformId } from './detect';
import { StandalonePlatform } from './noop';
import { YandexPlatform } from './yandex';
import { CrazyGamesPlatform } from './crazygames';
import { GameDistributionPlatform } from './gamedistribution';

export type { PlatformAPI, PlatformId };
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
function readGlobals(): { hasYaGames: boolean; hasCrazyGames: boolean; hasGDSdk: boolean } {
  try {
    return {
      hasYaGames: typeof window.YaGames !== 'undefined',
      hasCrazyGames: typeof window.CrazyGames?.SDK !== 'undefined',
      hasGDSdk: typeof window.gdsdk !== 'undefined',
    };
  } catch {
    return { hasYaGames: false, hasCrazyGames: false, hasGDSdk: false };
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

/** Площадка, определённая синхронно при загрузке (детект + ?platform=). */
export const platformId: PlatformId = detectPlatformId({ ...readLocation(), ...readGlobals() });

function createProvider(id: PlatformId): PlatformAPI {
  switch (id) {
    case 'yandex':
      return new YandexPlatform();
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
    try {
      return this.current.isFullscreen();
    } catch {
      return false;
    }
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
  const timeoutMs = opts.timeoutMs ?? 2000;
  let provider = createProvider(platformId);
  // Детект выполняется один раз при загрузке модуля — до появления SDK,
  // который площадки/прокси могут подгрузить позже. Если площадка не
  // опознана и пользователь явно не зафиксировал standalone, пробуем
  // относительный /sdk.js: именно его отдают и Яндекс, и его dev-proxy.
  // На своём сайте это быстрый 404 без последствий.
  if (platformId === 'standalone' && !hasExplicitPlatformParam() && !yaGamesPresent()) {
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
