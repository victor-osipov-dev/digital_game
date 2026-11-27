// Playgama Bridge (https://wiki.playgama.com/playgama/bridge-sdk/getting-started).
// SDK-скрипт подключается первым тегом в <head> (Vite-плагин @playgama/bridge),
// поэтому к моменту загрузки бандла window.bridge уже существует. Используем
// именно глобальный экземпляр (импортируем только ТИПЫ — отдельный экземпляр
// из npm-модуля создал бы вторую подписку на события площадки).
// Все вызовы обёрнуты: вне площадки Bridge работает как mock и не бросает.
import type {} from '@playgama/bridge/global';
import type { DeviceKind, PlatformLeaderboard, PlatformPlayer } from './types';
import { BasePlatform } from './base';

function mapDevice(type: string | null | undefined): DeviceKind {
  switch ((type ?? '').toLowerCase()) {
    case 'desktop':
      return 'desktop';
    case 'mobile':
      return 'mobile';
    case 'tablet':
      return 'tablet';
    case 'tv':
      return 'tv';
    default:
      return 'unknown';
  }
}

export class PlaygamaPlatform extends BasePlatform {
  readonly id = 'playgama' as const;
  private initialized = false;
  private audioEnabled = true;
  private active = false;
  private pauseHandlers: Array<() => void> = [];
  private resumeHandlers: Array<() => void> = [];
  private audioHandlers: Array<(enabled: boolean) => void> = [];
  private initPromise: Promise<void> | null = null;

  constructor() {
    super();
    // Требование Playgama 1.2: initialize() должен быть вызван до загрузки
    // движка и любой другой логики. Запускаем handshake сразу при создании
    // провайдера (до Engine/Scene в main.ts), а не в init().
    this.ensureInit();
  }

  /**
   * Единая точка инициализации SDK. Handshake с площадкой (особенно в
   * QA-харнессе) может занимать заметное время — внутренний дедлайн 10 c
   * страхует от вечного ожидания, игра остаётся работоспособной.
   */
  private ensureInit(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        const deadline = new Promise<void>((resolve) => {
          window.setTimeout(resolve, 10000);
        });
        await Promise.race([bridge.initialize(), deadline]);
        this.initialized = bridge.isInitialized;
        if (this.initialized) {
          this.audioEnabled = this.readAudioEnabled();
          this.readSupportedFeatures();
          this.subscribeEvents();
        }
      } catch (e) {
        this.initialized = false;
        // Игра продолжает работать без SDK (mock-поведение Bridge).
        console.warn('[platform] Playgama Bridge init failed', e);
      }
    })();
    return this.initPromise;
  }

  get isEmbedded(): boolean {
    try {
      const id = bridge.platform.id;
      if (id && id !== 'standalone') return true;
      return typeof window !== 'undefined' && window.self !== window.top;
    } catch {
      return true;
    }
  }

  // Возможности площадки уточняются после handshake (могут быть недоступны).
  override supportsRewarded = false;
  override supportsReview = false;
  override supportsShortcut = false;
  supportsPayments = false;
  readonly supportsOnline = true;
  readonly supportsAudio = true;

  private readSupportedFeatures(): void {
    try {
      this.supportsRewarded = bridge.advertisement.isRewardedSupported;
    } catch {
      /* ignore */
    }
    try {
      this.supportsReview = bridge.social.isRateSupported;
      this.supportsShortcut = bridge.social.isAddToHomeScreenSupported;
    } catch {
      /* ignore */
    }
    try {
      this.supportsPayments = bridge.payments.isSupported;
    } catch {
      this.supportsPayments = false;
    }
  }

  async init(): Promise<void> {
    if (typeof window === 'undefined') return;
    // initialize() уже запущен в конструкторе — ждём его завершения.
    await this.ensureInit();
  }

  private readAudioEnabled(): boolean {
    try {
      return bridge.platform.isAudioEnabled !== false;
    } catch {
      return true;
    }
  }

  private subscribeEvents(): void {
    try {
      bridge.platform.on(bridge.EVENT_NAME.PAUSE_STATE_CHANGED, (paused: unknown) => {
        try {
          if (paused) this.pauseHandlers.forEach((cb) => cb());
          else this.resumeHandlers.forEach((cb) => cb());
        } catch {
          /* ignore */
        }
      });
      bridge.platform.on(bridge.EVENT_NAME.AUDIO_STATE_CHANGED, (enabled: unknown) => {
        this.audioEnabled = enabled !== false;
        try {
          this.audioHandlers.forEach((cb) => cb(this.audioEnabled));
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * Отправка platform-сообщения строго ПОСЛЕ инициализации SDK: сообщения,
   * отправленные до handshake, площадка не получает (требование 1.4 —
   * game_ready после фактической готовности, и 2.2.1 — уровневые события).
   */
  private sendWhenReady(message: string): void {
    void this.ensureInit().then(() => {
      try {
        void bridge.platform.sendMessage(message);
      } catch {
        /* ignore */
      }
    });
  }

  gameReady(): void {
    this.sendWhenReady(bridge.PLATFORM_MESSAGE.GAME_READY);
  }

  gameplayStart(): void {
    const message = this.active
      ? bridge.PLATFORM_MESSAGE.LEVEL_RESUMED
      : bridge.PLATFORM_MESSAGE.LEVEL_STARTED;
    this.active = true;
    this.sendWhenReady(message);
  }

  gameplayStop(): void {
    if (this.active) {
      this.active = false;
      this.sendWhenReady(bridge.PLATFORM_MESSAGE.LEVEL_PAUSED);
    }
  }

  levelCompleted(won: boolean): void {
    this.active = false;
    this.sendWhenReady(
      won ? bridge.PLATFORM_MESSAGE.LEVEL_COMPLETED : bridge.PLATFORM_MESSAGE.LEVEL_FAILED,
    );
  }

  private waitForAd(
    event: string,
    show: (placement: string) => void,
    placement: string,
    successState?: string,
  ): Promise<boolean> {
    if (typeof window === 'undefined') return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let sawSuccess = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        try {
          bridge.advertisement.off(event, handler);
        } catch {
          /* ignore */
        }
        resolve(value);
      };
      const handler = (state: string): void => {
        if (state === successState) sawSuccess = true;
        if (state === 'closed') finish(sawSuccess);
        else if (state === 'failed') finish(false);
      };
      const timer = window.setTimeout(() => finish(sawSuccess), 90000);
      try {
        bridge.advertisement.on(event, handler);
        show(placement);
      } catch {
        finish(false);
      }
    });
  }

  async showInterstitial(): Promise<boolean> {
    if (!this.initialized) return false;
    try {
      if (!bridge.advertisement.isInterstitialSupported) return false;
    } catch {
      return false;
    }
    return this.waitForAd(
      bridge.EVENT_NAME.INTERSTITIAL_STATE_CHANGED,
      (p) => bridge.advertisement.showInterstitial(p),
      'game_over',
    );
  }

  async showRewarded(): Promise<boolean> {
    if (!this.initialized) return false;
    try {
      if (!bridge.advertisement.isRewardedSupported) return false;
    } catch {
      return false;
    }
    return this.waitForAd(
      bridge.EVENT_NAME.REWARDED_STATE_CHANGED,
      (p) => bridge.advertisement.showRewarded(p),
      'hint',
      'rewarded',
    );
  }

  async getPlayer(): Promise<PlatformPlayer | null> {
    if (!this.initialized) return null;
    try {
      if (!bridge.player.isAuthorizationSupported) return null;
      const id = bridge.player.id;
      if (!id) return null;
      return {
        uid: String(id),
        name: String(bridge.player.name ?? ''),
        authorized: bridge.player.isAuthorized,
      };
    } catch {
      return null;
    }
  }

  async openAuthDialog(): Promise<boolean> {
    if (!this.initialized) return false;
    try {
      if (!bridge.player.isAuthorizationSupported) return false;
      await bridge.player.authorize();
      return bridge.player.isAuthorized;
    } catch {
      return false;
    }
  }

  async getLeaderboardEntries(name: string): Promise<PlatformLeaderboard> {
    if (!this.initialized) return { entries: [], userRank: 0, error: 'unsupported' };
    try {
      if (bridge.leaderboards.type === 'not_available') {
        return { entries: [], userRank: 0, error: 'unsupported' };
      }
      const rows = await bridge.leaderboards.getEntries(name);
      const entries = (Array.isArray(rows) ? rows : []).map((row) => ({
        name: String(row.name ?? ''),
        score: Number(row.score ?? 0),
        rank: Number(row.rank ?? 0),
      }));
      return { entries, userRank: 0 };
    } catch (e) {
      return { entries: [], userRank: 0, error: (e as Error).message || 'unavailable' };
    }
  }

  async reportLeaderboardScore(name: string, score: number): Promise<boolean> {
    if (!this.initialized) return false;
    try {
      if (bridge.leaderboards.type === 'not_available') return false;
      await bridge.leaderboards.setScore(name, score);
      return true;
    } catch {
      return false;
    }
  }

  getInterfaceLang(): string | null {
    if (!this.initialized) return null;
    try {
      const lang = String(bridge.platform.language ?? '').toLowerCase();
      return lang ? lang.split(/[-_]/)[0] : null;
    } catch {
      return null;
    }
  }

  getDevice(): DeviceKind {
    if (!this.initialized) return 'unknown';
    try {
      return mapDevice(bridge.device.type);
    } catch {
      return 'unknown';
    }
  }

  async toggleFullscreen(): Promise<boolean> {
    // Внутри iframe площадки полноэкранный режим запрашивает родитель
    // (см. fullscreen_bridge.ts); здесь остаётся браузерный фолбэк.
    return super.toggleFullscreen();
  }

  async exitFullscreen(): Promise<boolean> {
    return super.exitFullscreen();
  }

  setBannerVisible(_visible: boolean): void {
    // Баннеры не используем: они перекрывали бы элементы меню на телефоне.
  }

  async canReview(): Promise<boolean> {
    try {
      return this.initialized && bridge.social.isRateSupported;
    } catch {
      return false;
    }
  }

  async requestReview(): Promise<boolean> {
    try {
      if (!this.initialized || !bridge.social.isRateSupported) return false;
      await bridge.social.rate();
      return true;
    } catch {
      return false;
    }
  }

  async canAddShortcut(): Promise<boolean> {
    try {
      return this.initialized && bridge.social.isAddToHomeScreenSupported;
    } catch {
      return false;
    }
  }

  async addShortcut(): Promise<boolean> {
    try {
      if (!this.initialized || !bridge.social.isAddToHomeScreenSupported) return false;
      await bridge.social.addToHomeScreen();
      return true;
    } catch {
      return false;
    }
  }

  async writeClipboard(text: string): Promise<boolean> {
    try {
      if (this.initialized && bridge.clipboard.isSupported) {
        await bridge.clipboard.write(text);
        return true;
      }
    } catch {
      /* браузерный фолбэк ниже */
    }
    return super.writeClipboard(text);
  }

  async storageGet(keys: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const key of keys) out[key] = null;
    if (keys.length === 0) return out;
    // Ждём инициализации: preloadPersist вызывается сразу после initPlatform,
    // а handshake может ещё идти (дедлайн внутри ensureInit страхует).
    await this.ensureInit();
    if (!this.initialized) return out;
    try {
      const data = (await bridge.storage.get(keys)) as unknown;
      if (Array.isArray(data)) {
        keys.forEach((key, i) => {
          const value = data[i];
          out[key] = value === null || value === undefined ? null : String(value);
        });
      } else if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        for (const key of keys) {
          const value = record[key];
          out[key] = value === null || value === undefined ? null : String(value);
        }
      }
    } catch {
      /* нет данных — остаются null */
    }
    return out;
  }

  async storageSet(entries: Record<string, string>): Promise<void> {
    const keys = Object.keys(entries);
    if (keys.length === 0) return;
    await this.ensureInit();
    if (!this.initialized) return;
    try {
      await bridge.storage.set(keys, keys.map((key) => entries[key]));
    } catch {
      /* сохранение не должно ронять игру */
    }
  }

  async storageDelete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.ensureInit();
    if (!this.initialized) return;
    try {
      await bridge.storage.delete(keys);
    } catch {
      /* ignore */
    }
  }

  // ===== покупки (Playgama Bridge payments) =====
  async getProducts(): Promise<import('./types').PlatformProduct[]> {
    await this.ensureInit();
    if (!this.initialized) return [];
    try {
      if (!bridge.payments.isSupported) return [];
      const list = await bridge.payments.getCatalog();
      return (Array.isArray(list) ? list : []).map((p) => ({
        id: String(p.id ?? ''),
        price: p.price,
        currency: p.priceCurrencyCode,
      }));
    } catch {
      return [];
    }
  }

  async getPurchases(): Promise<string[]> {
    await this.ensureInit();
    if (!this.initialized) return [];
    try {
      if (!bridge.payments.isSupported) return [];
      const list = await bridge.payments.getPurchases();
      return (Array.isArray(list) ? list : []).map((p) => String(p.id ?? ''));
    } catch {
      return [];
    }
  }

  async purchase(id: string): Promise<boolean> {
    await this.ensureInit();
    if (!this.initialized || !bridge.payments.isSupported) return false;
    try {
      const res = await bridge.payments.purchase(id);
      return !!res;
    } catch {
      return false;
    }
  }

  async consumePurchase(id: string): Promise<void> {
    await this.ensureInit();
    if (!this.initialized) return;
    try {
      if (!bridge.payments.isSupported) return;
      await bridge.payments.consumePurchase(id);
    } catch {
      /* товары игры постоянные — потребление не критично */
    }
  }

  isAudioEnabled(): boolean {
    return this.initialized ? this.audioEnabled : true;
  }

  onAudioState(cb: (enabled: boolean) => void): void {
    this.audioHandlers.push(cb);
  }

  onPause(cb: () => void): void {
    this.pauseHandlers.push(cb);
  }

  onResume(cb: () => void): void {
    this.resumeHandlers.push(cb);
  }
}