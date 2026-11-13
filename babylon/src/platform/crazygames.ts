import type { DeviceKind, PlatformProgress } from './types';
import { BasePlatform } from './base';

// Минимальные типы CrazyGames SDK v3 (https://docs.crazygames.com/sdk/).
interface CrazyAdCallbacks {
  adStarted?: () => void;
  adFinished?: () => void;
  adError?: (error: unknown, errorData?: unknown) => void;
}
interface CrazyGameSettings {
  disableChat?: boolean;
  muteAudio?: boolean;
}
interface CrazyGame {
  loadingStart?: () => void;
  loadingStop?: () => void;
  // Имена v2: оставлены как резерв для старого SDK/локального адаптера.
  sdkGameLoadingStart?: () => void;
  sdkGameLoadingStop?: () => void;
  gameplayStart?: () => void;
  gameplayStop?: () => void;
  happytime?: () => void;
  settings?: CrazyGameSettings;
  addSettingsChangeListener?: (cb: (settings: CrazyGameSettings) => void) => void;
  removeSettingsChangeListener?: (cb: (settings: CrazyGameSettings) => void) => void;
}
interface CrazyAd {
  requestAd?: (kind: 'midgame' | 'rewarded', callbacks?: CrazyAdCallbacks) => void;
  hasAdblock?: () => Promise<boolean>;
}
interface CrazyData {
  getItem?: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
  clear?: () => void;
}
interface CrazyUser {
  systemInfo?: {
    locale?: string;
    device?: { type?: string };
  };
}
interface CrazySdk {
  init?: () => Promise<void>;
  environment?: 'local' | 'crazygames' | 'disabled' | string;
  game?: CrazyGame;
  ad?: CrazyAd;
  data?: CrazyData;
  user?: CrazyUser;
}

declare global {
  interface Window {
    CrazyGames?: { SDK?: CrazySdk };
  }
}

const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
const PROGRESS_KEY = 'dg_progress';

function sdk(): CrazySdk | null {
  try {
    return typeof window !== 'undefined' ? window.CrazyGames?.SDK ?? null : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(fallback);
    }, ms);
    try {
      p.then(
        (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(fallback);
        },
      );
    } catch {
      clearTimeout(timer);
      resolve(fallback);
    }
  });
}

/**
 * CrazyGames SDK v3.
 * - SDK.init() обязателен; environment === 'disabled' — площадки нет;
 * - loadingStart/Stop — вокруг загрузки, gameplayStart/Stop — вокруг партии;
 * - requestAd('midgame'|'rewarded') — реклама; награда только по adFinished;
 * - data.getItem/setItem — облачный прогресс (модуль включается в сабмите);
 * - game.settings.muteAudio важнее внутриигровой кнопки звука;
 * - user.systemInfo.locale — язык, device.type — устройство.
 */
export class CrazyGamesPlatform extends BasePlatform {
  readonly id = 'crazygames' as const;
  // Реклама доступна только после успешного SDK.init() и при отсутствии
  // блокировщика; до этого кнопки награды не показываем.
  supportsRewarded = false;
  readonly supportsOnline = true;
  readonly supportsAudio = true;

  private lang: string | null = null;
  private ready = false;
  private audioCbs: Array<(enabled: boolean) => void> = [];
  private settingsListener: ((settings: CrazyGameSettings) => void) | null = null;
  private lastMuted: boolean | null = null;

  get isEmbedded(): boolean {
    return true;
  }

  async init(): Promise<void> {
    try {
      if (typeof window === 'undefined') return;
      if (!sdk() && typeof document !== 'undefined') {
        // В сборке тег уже стоит в index.html; фолбэк — для локального
        // тестирования и прямого открытия бандла.
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 4000);
          const el = document.createElement('script');
          el.async = true;
          el.src = SDK_URL;
          const done = (): void => {
            window.clearTimeout(timer);
            resolve();
          };
          el.onload = done;
          el.onerror = done;
          document.head.appendChild(el);
        });
      }
      const api = sdk();
      if (!api) return;
      if (api.init) {
        const result = await withTimeout(
          Promise.resolve(api.init()).then(() => true, () => false),
          4000,
          false,
        );
        this.ready = result && api.environment !== 'disabled';
      } else {
        this.ready = true;
      }
      const locale = api.user?.systemInfo?.locale;
      if (typeof locale === 'string' && locale.length >= 2) {
        this.lang = locale.slice(0, 2).toLowerCase();
      }
      this.subscribeSettings();
      // loadingStart вызываем только после успешного init (в disabled SDK
      // бросает исключения).
      if (this.ready) {
        this.supportsRewarded = true;
        try {
          (api.game?.loadingStart ?? api.game?.sdkGameLoadingStart)?.();
        } catch {
          /* ignore */
        }
        // Блокировщик рекламы: кнопку награды лучше не показывать вовсе.
        try {
          const check = api.ad?.hasAdblock;
          if (check) {
            void Promise.resolve(check.call(api.ad)).then((blocked) => {
              if (blocked) this.supportsRewarded = false;
            }).catch(() => undefined);
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* режим disabled — игра работает без SDK */
    }
  }

  private subscribeSettings(): void {
    const game = sdk()?.game;
    if (!game?.addSettingsChangeListener || this.settingsListener) return;
    this.settingsListener = (settings: CrazyGameSettings): void => {
      const muted = !!settings?.muteAudio;
      const changed = muted !== this.lastMuted;
      this.lastMuted = muted;
      if (!changed) return;
      for (const cb of this.audioCbs) {
        try {
          cb(!muted);
        } catch {
          /* ignore */
        }
      }
    };
    try {
      game.addSettingsChangeListener(this.settingsListener);
      if (typeof game.settings?.muteAudio === 'boolean') {
        this.lastMuted = game.settings.muteAudio;
      }
    } catch {
      /* ignore */
    }
  }

  gameReady(): void {
    try {
      const game = sdk()?.game;
      (game?.loadingStop ?? game?.sdkGameLoadingStop)?.();
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

  /** «Счастливый момент» — площадка может показать рекламу в паузе. */
  happytime(): void {
    try {
      sdk()?.game?.happytime?.();
    } catch {
      /* ignore */
    }
  }

  private requestAd(kind: 'midgame' | 'rewarded'): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const timer = window.setTimeout(() => finish(false), 60000);
      try {
        const api = sdk();
        const request = api?.ad?.requestAd;
        if (!request) {
          window.clearTimeout(timer);
          finish(false);
          return;
        }
        request.call(api?.ad, kind, {
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
    // v3: midgame. Старое имя midroll оставлено в некоторых сборках SDK.
    return this.requestAd('midgame');
  }

  async showRewarded(): Promise<boolean> {
    return this.requestAd('rewarded');
  }

  async loadProgress(): Promise<PlatformProgress | null> {
    try {
      const getItem = sdk()?.data?.getItem;
      if (!getItem) return null;
      const raw = getItem.call(sdk()?.data, PROGRESS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const savedAt = Number(parsed?.saved_at ?? 0);
      return { data: parsed, savedAt: Number.isFinite(savedAt) ? savedAt : 0 };
    } catch {
      return null;
    }
  }

  async saveProgress(data: Record<string, unknown>): Promise<boolean> {
    try {
      const setItem = sdk()?.data?.setItem;
      if (!setItem) return false;
      setItem.call(sdk()?.data, PROGRESS_KEY, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  getInterfaceLang(): string | null {
    return this.lang;
  }

  getDevice(): DeviceKind {
    try {
      const type = (sdk()?.user?.systemInfo?.device?.type ?? '').toLowerCase();
      if (type === 'mobile' || type === 'tablet' || type === 'desktop') return type;
    } catch {
      /* ignore */
    }
    return 'unknown';
  }

  isAudioEnabled(): boolean {
    try {
      const muted = sdk()?.game?.settings?.muteAudio;
      return typeof muted === 'boolean' ? !muted : true;
    } catch {
      return true;
    }
  }

  onAudioChange(cb: (enabled: boolean) => void): void {
    this.audioCbs.push(cb);
    this.subscribeSettings();
  }

  setAudioEnabled(_enabled: boolean): void {
    // Настройка muteAudio принадлежит площадке и имеет приоритет над
    // внутриигровым переключателем — обратно звук не включаем.
  }
}
