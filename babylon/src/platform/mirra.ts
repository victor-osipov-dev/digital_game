// MirraWeb SDK (MirraSDK): единый JS-фреймворк Mirra Games, который сам
// определяет площадку (Яндекс, VK, OK, CrazyGames, GameDistribution, Y8,
// Lagged, MirraHub и др.) и даёт рекламу, платежи, данные, достижения,
// язык и аналитику. Скрипт SDK подключается в <head> до бандла игры.
//
// Все вызовы обёрнуты: без SDK игра работает как standalone и никогда
// не падает из-за рекламы/платежей.

import type { DeviceKind, PlatformLeaderboard, PlatformPlayer, PlatformProduct, PlatformProgress } from './types';
import { BasePlatform } from './base';

interface MirraAds {
  isInterstitialAvailable: boolean;
  isInterstitialReady: boolean;
  isRewardedAvailable: boolean;
  isRewardedReady: boolean;
  invokeInterstitial: (onOpen: () => void, onClose: (ok: boolean) => void) => void;
  invokeRewarded: (onOpen: () => void, onClose: (ok: boolean) => void) => void;
}

interface MirraPayments {
  products?: Array<{ tag?: string; price?: number; currency?: string }>;
  purchases?: string[];
  isProductPurchased: (tag: string) => boolean;
  getProductPrice: (tag: string) => number;
  getProductCurrency: (tag: string) => string;
  purchase: (tag: string, onSuccess: () => void, onError: () => void) => void;
  updatePurchases: () => Promise<void>;
}

interface MirraSdk {
  ads: MirraAds;
  data: {
    get: (key: string, fallback?: unknown) => unknown;
    set: (key: string, value: unknown, save?: boolean) => void;
    hasKey: (key: string) => boolean;
    deleteKey: (key: string, save?: boolean) => void;
    flush: () => Promise<void>;
  };
  payments: MirraPayments;
  achievements: {
    unlock: (id: string) => Promise<unknown> | void;
  };
  analytics: {
    gameIsReady: () => void;
    gameplayStart: (level?: number) => void;
    gameplayStop: (level?: number) => void;
  };
  language: { current: number };
  device: { isMobile: boolean; systemType: string };
  platform: { current: string; appId: string };
}

interface MirraGlobal {
  createInstance?: (settings: Record<string, unknown>) => Promise<MirraSdk>;
}

function bridgeGlobal(): MirraGlobal | null {
  try {
    const g = (window as unknown as { MirraSDK?: MirraGlobal }).MirraSDK;
    return g && typeof g.createInstance === 'function' ? g : null;
  } catch {
    return null;
  }
}

function mapLang(index: number | undefined): string | null {
  // Порядок MirraSDK: 0 en, 1 ru, 2 ja, 3 zh, ... Нам нужны ru/en.
  if (index === 1) return 'ru';
  if (index === 0) return 'en';
  return index === undefined ? null : 'en';
}

export class MirraPlatform extends BasePlatform {
  readonly id = 'mirra' as const;
  private sdk: MirraSdk | null = null;
  private initPromise: Promise<void> | null = null;
  private pauseHandlers: Array<() => void> = [];
  private resumeHandlers: Array<() => void> = [];
  private installed = false;
  override supportsRewarded = false;
  override supportsReview = false;
  override supportsShortcut = false;
  supportsPayments = false;
  supportsOnline = true;
  readonly supportsAudio = false;

  constructor() {
    super();
    const features = (window as unknown as {
      MIRRA_FEATURES?: { menuAutoConnect?: boolean; online?: boolean };
    }).MIRRA_FEATURES;
    this.menuAutoConnect = features?.menuAutoConnect !== false;
    this.supportsOnline = features?.online !== false;
    this.initPromise = this.ensureInit();
  }

  private ensureInit(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        const deadline = Date.now() + 2500;
        let g = bridgeGlobal();
        while (!g && Date.now() < deadline) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
          g = bridgeGlobal();
        }
        if (!g) return;
        const create = g.createInstance;
        if (!create) return;
        const settings = ((window as unknown as { MIRRA_SETTINGS?: Record<string, unknown> }).MIRRA_SETTINGS) ?? {};
        const sdk = await create(settings);
        if (!sdk) return;
        this.sdk = sdk;
        this.supportsRewarded = !!sdk.ads?.isRewardedAvailable;
        this.supportsPayments = !!sdk.payments;
        this.installPause();
      } catch (e) {
        console.warn('[platform] MirraSDK init failed', e);
      }
    })();
    return this.initPromise;
  }

  private installPause(): void {
    if (this.installed) return;
    this.installed = true;
    const pause = (): void => this.pauseHandlers.forEach((cb) => cb());
    const resume = (): void => this.resumeHandlers.forEach((cb) => cb());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pause();
      else resume();
    });
    window.addEventListener('blur', pause);
    window.addEventListener('focus', resume);
  }

  async init(): Promise<void> {
    await this.ensureInit();
  }

  get isEmbedded(): boolean {
    try {
      if (window.self !== window.top) return true;
    } catch {
      return true;
    }
    return this.sdk !== null;
  }

  gameReady(): void {
    try {
      this.sdk?.analytics.gameIsReady();
    } catch {
      /* ignore */
    }
  }

  gameplayStart(): void {
    try {
      this.sdk?.analytics.gameplayStart(0);
    } catch {
      /* ignore */
    }
  }

  gameplayStop(): void {
    try {
      this.sdk?.analytics.gameplayStop(0);
    } catch {
      /* ignore */
    }
  }

  private waitAd(kind: 'interstitial' | 'rewarded'): Promise<boolean> {
    const sdk = this.sdk;
    if (!sdk) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(ok);
      };
      const timer = window.setTimeout(() => finish(false), 90000);
      try {
        const open = (): void => undefined;
        const close = (ok: boolean): void => finish(!!ok);
        if (kind === 'interstitial') sdk.ads.invokeInterstitial(open, close);
        else sdk.ads.invokeRewarded(open, close);
      } catch {
        finish(false);
      }
    });
  }

  async showInterstitial(): Promise<boolean> {
    if (!this.sdk?.ads?.isInterstitialAvailable) return false;
    return this.waitAd('interstitial');
  }

  async showRewarded(): Promise<boolean> {
    if (!this.sdk?.ads?.isRewardedAvailable) return false;
    return this.waitAd('rewarded');
  }

  async getPlayer(): Promise<PlatformPlayer | null> {
    // MirraSDK не даёт публичного профиля во всех окружениях; имя берём
    // из Id платформы, если оно есть.
    try {
      const id = this.sdk?.platform?.appId;
      if (!id) return null;
      return { uid: String(id), name: '', authorized: false };
    } catch {
      return null;
    }
  }

  async openAuthDialog(): Promise<boolean> {
    return false;
  }

  async getLeaderboardEntries(_name: string): Promise<PlatformLeaderboard> {
    return { entries: [], userRank: 0, error: 'unsupported' };
  }

  async reportLeaderboardScore(_name: string, _score: number): Promise<boolean> {
    return false;
  }

  getInterfaceLang(): string | null {
    return mapLang(this.sdk?.language?.current);
  }

  getDevice(): DeviceKind {
    if (!this.sdk) return 'unknown';
    return this.sdk.device?.isMobile ? 'mobile' : 'desktop';
  }

  async storageGet(keys: string[]): Promise<Record<string, string | null>> {
    await this.ensureInit();
    const out: Record<string, string | null> = {};
    for (const key of keys) {
      try {
        const value = this.sdk?.data.get(key, null);
        out[key] = value === null || value === undefined ? null : String(value);
      } catch {
        out[key] = null;
      }
    }
    return out;
  }

  async storageSet(entries: Record<string, string>): Promise<void> {
    await this.ensureInit();
    if (!this.sdk) return;
    try {
      for (const [key, value] of Object.entries(entries)) this.sdk.data.set(key, value, false);
      await this.sdk.data.flush();
    } catch {
      /* сохранение не должно ронять игру */
    }
  }

  async storageDelete(keys: string[]): Promise<void> {
    await this.ensureInit();
    if (!this.sdk) return;
    try {
      for (const key of keys) this.sdk.data.deleteKey(key, false);
      await this.sdk.data.flush();
    } catch {
      /* ignore */
    }
  }

  async loadProgress(): Promise<PlatformProgress | null> {
    await this.ensureInit();
    try {
      const raw = this.sdk?.data.get('dg.progress', null);
      if (typeof raw !== 'string') return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return { data: parsed, savedAt: Number(parsed.saved_at ?? 0) };
    } catch {
      return null;
    }
  }

  async saveProgress(data: Record<string, unknown>): Promise<boolean> {
    await this.ensureInit();
    if (!this.sdk) return false;
    try {
      this.sdk.data.set('dg.progress', JSON.stringify(data), false);
      await this.sdk.data.flush();
      return true;
    } catch {
      return false;
    }
  }

  async getProducts(): Promise<PlatformProduct[]> {
    await this.ensureInit();
    if (!this.sdk) return [];
    try {
      const list = this.sdk.payments.products ?? [];
      return list.map((p) => ({
        id: String(p.tag ?? ''),
        price: p.price,
        currency: p.currency,
      }));
    } catch {
      return [];
    }
  }

  async getPurchases(): Promise<string[]> {
    await this.ensureInit();
    if (!this.sdk) return [];
    try {
      await this.sdk.payments.updatePurchases();
      return [...(this.sdk.payments.purchases ?? [])];
    } catch {
      return [];
    }
  }

  async purchase(id: string): Promise<boolean> {
    await this.ensureInit();
    const sdk = this.sdk;
    if (!sdk) return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(ok);
      };
      const timer = window.setTimeout(() => finish(false), 120000);
      try {
        sdk.payments.purchase(id, () => finish(true), () => finish(false));
      } catch {
        finish(false);
      }
    });
  }

  async consumePurchase(_id: string): Promise<void> {
    // Все товары игры постоянные — потребление не требуется.
  }

  unlockAchievement(id: string): void {
    try {
      void this.sdk?.achievements?.unlock(id);
    } catch {
      /* ignore */
    }
  }

  onPause(cb: () => void): void {
    this.pauseHandlers.push(cb);
  }

  onResume(cb: () => void): void {
    this.resumeHandlers.push(cb);
  }
}
