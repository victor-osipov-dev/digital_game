import type { DeviceKind, PlatformProgress } from './types';
import { BasePlatform } from './base';

// Минимальные типы YouTube Playables SDK (https://developers.google.com/youtube/gaming/playables/reference/sdk).
// SDK обязан быть подключён тегом в index.html ДО кода игры и приходит
// глобальным объектом ytgame. В рантайме внешние скрипты запрещены.
interface YtAds {
  requestInterstitialAd?: () => Promise<void>;
  requestRewardedAd?: (rewardId: string) => Promise<boolean>;
}

interface YtGameApi {
  firstFrameReady?: () => void;
  gameReady?: () => void;
  loadData?: () => Promise<string>;
  saveData?: (data: string) => Promise<void>;
}

interface YtSystem {
  getLanguage?: () => Promise<string>;
  isAudioEnabled?: () => boolean;
  onAudioEnabledChange?: (cb: (enabled: boolean) => void) => (() => void) | void;
  onPause?: (cb: () => void) => (() => void) | void;
  onResume?: (cb: () => void) => (() => void) | void;
}

interface YtSdk {
  IN_PLAYABLES_ENV?: boolean;
  ads?: YtAds;
  game?: YtGameApi;
  system?: YtSystem;
}

declare global {
  interface Window {
    ytgame?: YtSdk;
  }
}

const REWARD_ID = 'dg-hint';

function sdk(): YtSdk | null {
  try {
    return typeof window !== 'undefined' ? window.ytgame ?? null : null;
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

function langCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 2) return null;
  return value.slice(0, 2).toLowerCase();
}

/**
 * YouTube Playables.
 * - firstFrameReady() → gameReady() — обязательная последовательность;
 * - язык только через system.getLanguage(), неподдерживаемый → английский;
 * - звук — system.isAudioEnabled()/onAudioEnabledChange();
 * - прогресс — game.loadData()/saveData() (единый JSON-блоб);
 * - реклама — interstitial в паузах, rewarded строго по согласию;
 * - онлайн/БЭК/лидерборды не поддерживаются и скрываются в UI.
 */
export class YouTubePlatform extends BasePlatform {
  readonly id = 'youtube' as const;
  readonly supportsRewarded = true;
  readonly supportsOnline = false;
  readonly supportsAudio = true;
  // Полноэкранный режим внутри YouTube контролирует плеер.
  readonly supportsFullscreen = false;

  private lang: string | null = null;
  private audio = true;
  private pauseCbs: Array<() => void> = [];
  private resumeCbs: Array<() => void> = [];
  private audioCbs: Array<(enabled: boolean) => void> = [];
  private subscribed = false;
  private firstFrameSent = false;

  get isEmbedded(): boolean {
    return true;
  }

  async init(): Promise<void> {
    const api = sdk();
    if (!api) return;
    this.audio = this.readAudio();
    try {
      const lang = await withTimeout(
        api.system?.getLanguage?.() ?? Promise.resolve(''),
        1500,
        '',
      );
      this.lang = langCode(lang);
    } catch {
      this.lang = null;
    }
    this.subscribe();
  }

  private readAudio(): boolean {
    try {
      const value = sdk()?.system?.isAudioEnabled?.();
      return typeof value === 'boolean' ? value : true;
    } catch {
      return true;
    }
  }

  private subscribe(): void {
    if (this.subscribed) return;
    const api = sdk();
    if (!api) return;
    this.subscribed = true;
    try {
      api.system?.onAudioEnabledChange?.((enabled) => {
        this.audio = !!enabled;
        for (const cb of this.audioCbs) {
          try {
            cb(this.audio);
          } catch {
            /* ignore */
          }
        }
      });
    } catch {
      /* ignore */
    }
    try {
      api.system?.onPause?.(() => {
        for (const cb of this.pauseCbs) {
          try {
            cb();
          } catch {
            /* ignore */
          }
        }
      });
    } catch {
      /* ignore */
    }
    try {
      api.system?.onResume?.(() => {
        for (const cb of this.resumeCbs) {
          try {
            cb();
          } catch {
            /* ignore */
          }
        }
      });
    } catch {
      /* ignore */
    }
  }

  gameReady(): void {
    const api = sdk();
    if (!api) return;
    try {
      // Контракт SDK: firstFrameReady() обязательно ДО gameReady().
      if (!this.firstFrameSent) {
        this.firstFrameSent = true;
        api.game?.firstFrameReady?.();
      }
      api.game?.gameReady?.();
    } catch {
      /* ignore */
    }
  }

  async showInterstitial(): Promise<boolean> {
    const request = sdk()?.ads?.requestInterstitialAd;
    if (!request) return false;
    try {
      await withTimeout(request.call(sdk()?.ads), 20000, undefined);
      return true;
    } catch {
      return false;
    }
  }

  async showRewarded(): Promise<boolean> {
    const request = sdk()?.ads?.requestRewardedAd;
    if (!request) return false;
    try {
      return await withTimeout(request.call(sdk()?.ads, REWARD_ID), 60000, false);
    } catch {
      return false;
    }
  }

  async loadProgress(): Promise<PlatformProgress | null> {
    try {
      const load = sdk()?.game?.loadData;
      if (!load) return null;
      const raw = await withTimeout(load.call(sdk()?.game), 5000, '');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const data = parsed?.dg_progress;
      if (!data || typeof data !== 'object') return null;
      const record = data as Record<string, unknown>;
      const savedAt = Number(record.saved_at ?? 0);
      return { data: record, savedAt: Number.isFinite(savedAt) ? savedAt : 0 };
    } catch {
      return null;
    }
  }

  async saveProgress(data: Record<string, unknown>): Promise<boolean> {
    const api = sdk();
    if (!api?.game?.saveData) return false;
    try {
      // loadData возвращает весь блоб: сохраняем чужие ключи, обновляем свой.
      let blob: Record<string, unknown> = {};
      try {
        const raw = await withTimeout(api.game.loadData?.() ?? Promise.resolve(''), 4000, '');
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object') blob = parsed as Record<string, unknown>;
        }
      } catch {
        blob = {};
      }
      blob.dg_progress = data;
      await withTimeout(api.game.saveData(JSON.stringify(blob)), 5000, undefined);
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
      if (typeof navigator === 'undefined') return 'unknown';
      const ua = navigator.userAgent ?? '';
      if (/iPad|Tablet/i.test(ua)) return 'tablet';
      if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
      return 'desktop';
    } catch {
      return 'unknown';
    }
  }

  isAudioEnabled(): boolean {
    return this.readAudio();
  }

  onAudioChange(cb: (enabled: boolean) => void): void {
    this.audioCbs.push(cb);
    this.subscribe();
  }

  setAudioEnabled(_enabled: boolean): void {
    // В YouTube звуком управляет системная настройка плеера, игра её не меняет.
  }

  onPause(cb: () => void): void {
    this.pauseCbs.push(cb);
    this.subscribe();
  }

  onResume(cb: () => void): void {
    this.resumeCbs.push(cb);
    this.subscribe();
  }
}
