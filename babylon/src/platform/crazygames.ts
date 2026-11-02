import type { DeviceKind } from './types';
import { BasePlatform } from './base';

// Минимальные типы CrazyGames SDK v2 (только то, что используем).
interface CrazyAdCallbacks {
  adStarted?: () => void;
  adFinished?: () => void;
  adError?: (error: unknown, errorData?: unknown) => void;
}
interface CrazySdk {
  game?: {
    gameplayStart?: () => void;
    gameplayStop?: () => void;
    sdkGameLoadingStart?: () => void;
    sdkGameLoadingStop?: () => void;
    happytime?: () => void;
  };
  ad?: {
    requestAd?: (kind: 'midroll' | 'rewarded', callbacks?: CrazyAdCallbacks) => void;
  };
}

declare global {
  interface Window {
    CrazyGames?: { SDK?: CrazySdk };
  }
}

function sdk(): CrazySdk | null {
  try {
    return typeof window !== 'undefined' ? window.CrazyGames?.SDK ?? null : null;
  } catch {
    return null;
  }
}

/**
 * CrazyGames (https://docs.crazygames.com/sdk/html5-v2/intro).
 * - SDK подключается тегом <script src="https://sdk.crazygames.com/crazygames-sdk-v2.js">
 *   (см. README) и самоинициализируется; отдельные вызовы init не нужны.
 * - sdkGameLoadingStart/Stop — вокруг загрузки, gameplayStart/Stop — вокруг
 *   партии, midroll — в логических паузах, rewarded — только по согласию.
 * - Вне доменов CrazyGames/localhost SDK в режиме disabled и бросает
 *   исключения — все вызовы обёрнуты, игра продолжает работать.
 * - Полноэкранный режим — браузерный (у площадки своего API для него нет).
 */
export class CrazyGamesPlatform extends BasePlatform {
  readonly id = 'crazygames' as const;
  readonly supportsRewarded = true;

  get isEmbedded(): boolean {
    return true;
  }

  async init(): Promise<void> {
    try {
      if (typeof window === 'undefined') return;
      if (!sdk() && typeof document !== 'undefined') {
        // Тег в index.html не обязателен: подгружаем SDK сами, чтобы один
        // и тот же билд работал везде без правок.
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 4000);
          const el = document.createElement('script');
          el.async = true;
          el.src = 'https://sdk.crazygames.com/crazygames-sdk-v2.js';
          const done = (): void => {
            window.clearTimeout(timer);
            resolve();
          };
          el.onload = done;
          el.onerror = done;
          document.head.appendChild(el);
        });
      }
      sdk()?.game?.sdkGameLoadingStart?.();
    } catch {
      /* режим disabled — игра работает без SDK */
    }
  }

  gameReady(): void {
    try {
      sdk()?.game?.sdkGameLoadingStop?.();
    } catch {
      /* ignore */
    }
  }

  gameplayStart(): void {
    try {
      sdk()?.game?.gameplayStart?.();
    } catch {
      /* ignore */
    }
  }

  gameplayStop(): void {
    try {
      sdk()?.game?.gameplayStop?.();
    } catch {
      /* ignore */
    }
  }

  private requestAd(kind: 'midroll' | 'rewarded'): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const timer = window.setTimeout(() => finish(false), 60000);
      try {
        const request = sdk()?.ad?.requestAd;
        if (!request) {
          window.clearTimeout(timer);
          finish(false);
          return;
        }
        request.call(sdk()?.ad, kind, {
          adFinished: () => {
            window.clearTimeout(timer);
            finish(true);
          },
          adError: () => {
            window.clearTimeout(timer);
            finish(false);
          },
        });
      } catch {
        window.clearTimeout(timer);
        finish(false);
      }
    });
  }

  async showInterstitial(): Promise<boolean> {
    return this.requestAd('midroll');
  }

  async showRewarded(): Promise<boolean> {
    return this.requestAd('rewarded');
  }

  getDevice(): DeviceKind {
    return 'unknown';
  }
}
