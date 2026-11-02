import { BasePlatform } from './base';

// Минимальные типы GameDistribution (Azerion) HTML5 SDK.
interface GDSdk {
  showAd?: (kind?: 'rewarded') => Promise<unknown> | unknown;
  gameplayStart?: () => void;
  gameplayStop?: () => void;
  preloadAd?: (kind?: 'rewarded') => void;
}

declare global {
  interface Window {
    GD_OPTIONS?: Record<string, unknown>;
    gdsdk?: GDSdk;
  }
}

function getQueryParam(name: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const m = new RegExp(`(?:^|[?&])${name}=([^&]*)`).exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

function loadScript(src: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('no document'));
      return;
    }
    const timer = window.setTimeout(() => reject(new Error(`sdk load timeout: ${src}`)), timeoutMs);
    const el = document.createElement('script');
    el.async = true;
    el.src = src;
    el.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    el.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error(`sdk load failed: ${src}`));
    };
    document.head.appendChild(el);
  });
}

function sdk(): GDSdk | null {
  try {
    return typeof window !== 'undefined' ? window.gdsdk ?? null : null;
  } catch {
    return null;
  }
}

/**
 * GameDistribution (Azerion).
 * - До загрузки SDK нужно задать window.GD_OPTIONS = { gameId }.
 *   gameId берётся из query-параметра ?gamedist_id= (см. README).
 * - showAd() — interstitial в логической паузе, showAd('rewarded') —
 *   только по явному согласию игрока. Вызовы версий SDK tolerant:
 *   промисы и исключения обрабатываются, игра никогда не блокируется.
 * - Полноэкранный режим — браузерный (своего API у площадки нет).
 */
export class GameDistributionPlatform extends BasePlatform {
  readonly id = 'gamedistribution' as const;
  readonly supportsRewarded = true;

  get isEmbedded(): boolean {
    return true;
  }

  async init(): Promise<void> {
    try {
      if (typeof window === 'undefined') return;
      // Без gameId реклама всё равно не работает, а сам SDK в чужом
      // окружении лишь шумит ошибками в консоль — не грузим его.
      const presetId =
        typeof window.GD_OPTIONS?.gameId === 'string' ? (window.GD_OPTIONS.gameId as string) : '';
      const paramId = getQueryParam('gamedist_id') ?? '';
      if (!presetId && !paramId) return;
      if (!window.gdsdk) {
        if (!window.GD_OPTIONS) {
          const gameId = getQueryParam('gamedist_id') ?? '';
          window.GD_OPTIONS = { gameId };
        }
        try {
          await loadScript('https://html5.api.gamedistribution.com/main.min.js', 4000);
        } catch {
          /* без SDK игра работает как standalone */
        }
      }
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

  private async showAd(kind?: 'rewarded'): Promise<boolean> {
    const api = sdk();
    if (!api?.showAd) return false;
    try {
      const res = api.showAd(kind);
      if (res && typeof (res as Promise<unknown>).then === 'function') {
        const raced = await Promise.race([
          (res as Promise<unknown>).then(() => true as const, () => false as const),
          new Promise<false>((resolve) => window.setTimeout(() => resolve(false), 60000)),
        ]);
        return raced;
      }
      // Старые версии SDK — колбэки через GD_OPTIONS.onEvent; считаем,
      // что показ инициирован, но результат неизвестен → false, чтобы
      // игра просто продолжилась.
      return false;
    } catch {
      return false;
    }
  }

  async showInterstitial(): Promise<boolean> {
    return this.showAd();
  }

  async showRewarded(): Promise<boolean> {
    return this.showAd('rewarded');
  }
}
