import type { DeviceKind, PlatformAPI } from './types';
import {
  browserIsFullscreen,
  browserToggleFullscreen,
  browserWriteClipboard,
} from './browser';

// Минимальные типы YaGames SDK (только то, что используем).
interface YsdkGameplayApi {
  start?: () => void;
  stop?: () => void;
}
interface YsdkLoadingApi {
  ready?: () => void;
}
interface YsdkAdvCallbacks {
  onOpen?: () => void;
  onClose?: (wasShown: boolean) => void;
  onError?: (error: unknown) => void;
  onRewarded?: () => void;
}
interface YsdkBannerStatus {
  stickyAdvIsShowing?: boolean;
  reason?: 'ADV_IS_NOT_CONNECTED' | 'UNKNOWN';
}
interface YsdkAdv {
  // Dev-адаптер прокси (yandex-dev-adapter.js) читает колбэки из вложенного
  // поля `callbacks`, боевой SDK — из корня объекта. Передаём обе формы:
  // лишнее поле боевой SDK игнорирует.
  showFullscreenAdv?: (callbacks?: YsdkAdvCallbacks & { callbacks?: YsdkAdvCallbacks }) => void;
  showRewardedVideo?: (callbacks?: YsdkAdvCallbacks & { callbacks?: YsdkAdvCallbacks }) => void;
  showBannerAdv?: () => Promise<YsdkBannerStatus> | void;
  hideBannerAdv?: () => Promise<{ stickyAdvIsShowing?: boolean }> | void;
  getBannerAdvStatus?: () => Promise<YsdkBannerStatus>;
}
interface YsdkFullscreen {
  STATUS_ON?: string;
  STATUS_OFF?: string;
  status?: string;
  request?: () => Promise<void> | void;
  exit?: () => Promise<void> | void;
}
interface YsdkFeedback {
  canReview?: () => Promise<{ value?: boolean; reason?: string }>;
  requestReview?: () => Promise<{ feedbackSent?: boolean }>;
}
interface YsdkShortcut {
  canShowPrompt?: () => Promise<{ canShow?: boolean }>;
  showPrompt?: () => Promise<{ outcome?: string }>;
}
interface YsdkClipboard {
  writeText?: (text: string) => void;
}
interface Ysdk {
  features?: { LoadingAPI?: YsdkLoadingApi; GameplayAPI?: YsdkGameplayApi };
  environment?: { i18n?: { lang?: string }; payload?: string };
  deviceInfo?: {
    type?: string;
    isMobile?: () => boolean;
    isDesktop?: () => boolean;
    isTablet?: () => boolean;
    isTV?: () => boolean;
  };
  adv?: YsdkAdv;
  screen?: { fullscreen?: YsdkFullscreen };
  feedback?: YsdkFeedback;
  shortcut?: YsdkShortcut;
  clipboard?: YsdkClipboard;
  on?: (event: string, listener: () => void) => void;
  off?: (event: string, listener: () => void) => void;
}

declare global {
  interface Window {
    YaGames?: { init: (opts?: { signed?: boolean }) => Promise<Ysdk> };
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

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer = 0;
  const timeout = new Promise<T>((resolve) => {
    timer = window.setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p, timeout]).finally(() => window.clearTimeout(timer));
}

/**
 * Яндекс Игры (https://yandex.ru/dev/games/doc/ru).
 * - SDK: сначала относительный /sdk.js (требование для архива на сервере
 *   Яндекса), затем абсолютный фолбэк для своего домена.
 * - Game Ready / Gameplay-разметка, interstitial, rewarded и sticky-баннер —
 *   по документации; полноэкранный режим, оценка игры и ярлык — через SDK.
 * - Авторизация НЕ запрашивается: игра полностью проходима гостем,
 *   прогресс хранится локально (п. 1.2.2 требований).
 * - Облачные сейвы не используем осознанно: опция cloud-saves в черновике
 *   остаётся выключенной, п. 1.11 не применяется.
 */
export class YandexPlatform implements PlatformAPI {
  readonly id = 'yandex' as const;
  readonly isEmbedded = true;
  readonly supportsRewarded = true;
  readonly supportsFullscreen = true;
  readonly supportsReview = true;
  readonly supportsShortcut = true;

  private ysdk: Ysdk | null = null;
  private lang: string | null = null;
  private pauseCbs: Array<() => void> = [];
  private resumeCbs: Array<() => void> = [];
  private pauseListener: (() => void) | null = null;
  private resumeListener: (() => void) | null = null;
  // Тестовый режим: ?fakeads=1 симулирует показ рекламы видимым
  // оверлеем с обратным отсчётом, чтобы проверить весь флоу без настоящей
  // площадки. Только явный query-параметр — в проде на Яндексе он
  // отсутствует и ни на что не влияет.
  private fakeAds = false;

  async init(): Promise<void> {
    try {
      if (typeof window !== 'undefined' && /(?:^|[?&])fakeads=1/.test(window.location?.search ?? '')) {
        this.fakeAds = true;
        try {
          console.info('[platform] yandex: fake ads enabled (?fakeads=1)');
        } catch {
          /* ignore */
        }
        return;
      }
      // Настоящий SDK грузим только в правдоподобном контексте Яндекса
      // (SDK уже внедрён, iframe площадки или её хост). Иначе SDK спамит
      // ошибками postMessage в консоль и только мешает: работаем тихо.
      if (!this.isPlausibleContext()) return;
      if (typeof window !== 'undefined' && !window.YaGames) {
        try {
          await loadScript('/sdk.js', 4000);
        } catch {
          await loadScript('https://yandex.ru/games/sdk/v2', 4000);
        }
      }
      const ysdk = await withTimeout(
        window.YaGames!.init(),
        5000,
        null as unknown as Ysdk,
      );
      if (!ysdk) return;
      this.ysdk = ysdk;
      const lang = ysdk.environment?.i18n?.lang;
      if (typeof lang === 'string' && lang.length >= 2) {
        this.lang = lang.slice(0, 2).toLowerCase();
      }
      this.subscribePlatformEvents();
    } catch {
      this.ysdk = null;
    }
  }

  // game_api_pause/resume: платформа сама сообщает о показе рекламы,
  // сворачивании вкладки и т. п. События согласованы с GameplayAPI.
  private subscribePlatformEvents(): void {
    try {
      if (!this.ysdk?.on) return;
      if (!this.pauseListener) {
        this.pauseListener = (): void => {
          for (const cb of this.pauseCbs) {
            try {
              cb();
            } catch {
              /* подписчик не должен ломать остальные */
            }
          }
        };
        this.ysdk.on('game_api_pause', this.pauseListener);
      }
      if (!this.resumeListener) {
        this.resumeListener = (): void => {
          for (const cb of this.resumeCbs) {
            try {
              cb();
            } catch {
              /* ignore */
            }
          }
        };
        this.ysdk.on('game_api_resume', this.resumeListener);
      }
    } catch {
      /* ignore */
    }
  }

  onPause(cb: () => void): void {
    this.pauseCbs.push(cb);
  }

  onResume(cb: () => void): void {
    this.resumeCbs.push(cb);
  }

  gameReady(): void {
    try {
      this.ysdk?.features?.LoadingAPI?.ready?.();
    } catch {
      /* платформа недоступна — игра продолжает работать */
    }
  }

  gameplayStart(): void {
    try {
      this.ysdk?.features?.GameplayAPI?.start?.();
    } catch {
      /* ignore */
    }
  }

  gameplayStop(): void {
    try {
      this.ysdk?.features?.GameplayAPI?.stop?.();
    } catch {
      /* ignore */
    }
  }

  async showInterstitial(): Promise<boolean> {
    if (this.fakeAds) {
      // Видимый тестовый показ вместо настоящей рекламы.
      await this.showFakeAd('interstitial', 2000);
      return true;
    }
    const adv = this.ysdk?.adv;
    if (!adv?.showFullscreenAdv) return false;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const timer = window.setTimeout(() => finish(false), 15000);
      try {
        // Дублируем колбэки во вложенное поле `callbacks`: так их понимает
        // dev-адаптер прокси, боевой SDK лишнее поле игнорирует.
        const cb = {
          onClose: (wasShown: boolean) => {
            window.clearTimeout(timer);
            finish(!!wasShown);
          },
          onError: () => {
            window.clearTimeout(timer);
            finish(false);
          },
        };
        adv.showFullscreenAdv!({ ...cb, callbacks: cb });
      } catch {
        window.clearTimeout(timer);
        finish(false);
      }
    });
  }

  async showRewarded(): Promise<boolean> {
    if (this.fakeAds) {
      await this.showFakeAd('rewarded', 3000);
      return true;
    }
    const adv = this.ysdk?.adv;
    if (!adv?.showRewardedVideo) return false;
    return new Promise((resolve) => {
      let done = false;
      let rewarded = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const timer = window.setTimeout(() => finish(false), 60000);
      try {
        // Дублируем колбэки во вложенное поле `callbacks` для dev-адаптера.
        const cb = {
          onRewarded: () => {
            rewarded = true;
          },
          onClose: () => {
            window.clearTimeout(timer);
            finish(rewarded);
          },
          onError: () => {
            window.clearTimeout(timer);
            finish(false);
          },
        };
        adv.showRewardedVideo!({ ...cb, callbacks: cb });
      } catch {
        window.clearTimeout(timer);
        finish(false);
      }
    });
  }

  /**
   * Управление sticky-баннером. Работает, только если в Консоли разработчика
   * включена опция «Использовать API для показа sticky-баннера» — иначе
   * методы безопасно ничего не делают (баннер показывается по настройке).
   */
  setBannerVisible(visible: boolean): void {
    try {
      const adv = this.ysdk?.adv;
      if (!adv) return;
      const res = visible ? adv.showBannerAdv?.() : adv.hideBannerAdv?.();
      if (res && typeof (res as Promise<unknown>).then === 'function') {
        (res as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  }

  isFullscreen(): boolean {
    try {
      const fs = this.ysdk?.screen?.fullscreen;
      if (fs?.status) return fs.status === (fs.STATUS_ON ?? 'on');
    } catch {
      /* ignore */
    }
    return browserIsFullscreen();
  }

  async toggleFullscreen(): Promise<boolean> {
    try {
      const fs = this.ysdk?.screen?.fullscreen;
      if (fs) {
        if (this.isFullscreen()) await fs.exit?.();
        else await fs.request?.();
        return this.isFullscreen();
      }
    } catch {
      /* браузер/платформа запретили смену режима — вернём статус ниже */
    }
    return browserToggleFullscreen();
  }

  async canReview(): Promise<boolean> {
    try {
      const fb = this.ysdk?.feedback;
      if (!fb?.canReview) return false;
      const res = await withTimeout(fb.canReview(), 3000, { value: false });
      return !!res?.value;
    } catch {
      return false;
    }
  }

  async requestReview(): Promise<boolean> {
    try {
      const fb = this.ysdk?.feedback;
      if (!fb?.canReview || !fb?.requestReview) return false;
      // Документация требует вызвать canReview() перед requestReview().
      const can = await withTimeout(fb.canReview(), 3000, { value: false });
      if (!can?.value) return false;
      const res = await withTimeout(fb.requestReview(), 15000, { feedbackSent: false });
      return !!res?.feedbackSent;
    } catch {
      return false;
    }
  }

  async canAddShortcut(): Promise<boolean> {
    try {
      const sc = this.ysdk?.shortcut;
      if (!sc?.canShowPrompt) return false;
      const res = await withTimeout(sc.canShowPrompt(), 3000, { canShow: false });
      return !!res?.canShow;
    } catch {
      return false;
    }
  }

  async addShortcut(): Promise<boolean> {
    try {
      const sc = this.ysdk?.shortcut;
      if (!sc?.canShowPrompt || !sc?.showPrompt) return false;
      const can = await withTimeout(sc.canShowPrompt(), 3000, { canShow: false });
      if (!can?.canShow) return false;
      const res = await withTimeout(sc.showPrompt(), 30000, { outcome: '' });
      return res?.outcome === 'accepted';
    } catch {
      return false;
    }
  }

  async writeClipboard(text: string): Promise<boolean> {
    try {
      const clip = this.ysdk?.clipboard;
      if (clip?.writeText) {
        clip.writeText(text);
        return true;
      }
    } catch {
      /* падаем в браузерный фолбэк */
    }
    return browserWriteClipboard(text);
  }

  getInterfaceLang(): string | null {
    return this.lang;
  }

  /**
   * Похоже ли окружение на настоящее размещение в Яндекс Играх:
   * SDK уже внедрён (платформа/прокси/тесты) либо игра во фрейме
   * площадки / её хост. Проверка нужна, чтобы не тянуть боевой SDK
   * на своём сайте/локально, где он лишь спамит ошибками в консоль.
   */
  private isPlausibleContext(): boolean {
    try {
      if (typeof window === 'undefined') return false;
      try {
        if (window.YaGames) return true;
      } catch {
        return true;
      }
      try {
        if (window.self !== window.top) return true;
      } catch {
        return true; // нет доступа к top — мы во фрейме
      }
      const host = (window.location?.hostname ?? '').toLowerCase();
      return host.includes('yandex');
    } catch {
      return false;
    }
  }

  getDevice(): DeviceKind {
    try {
      const d = this.ysdk?.deviceInfo;
      if (!d) return 'unknown';
      if (typeof d.isTV === 'function' && d.isTV()) return 'tv';
      if (typeof d.isTablet === 'function' && d.isTablet()) return 'tablet';
      if (typeof d.isMobile === 'function' && d.isMobile()) return 'mobile';
      if (typeof d.isDesktop === 'function' && d.isDesktop()) return 'desktop';
      const t = (d.type ?? '').toLowerCase();
      if (t === 'mobile' || t === 'tablet' || t === 'tv' || t === 'desktop') return t;
    } catch {
      /* ignore */
    }
    return 'unknown';
  }

  private fakeOverlay: HTMLElement | null = null;

  /**
   * Видимый тестовый показ для ?fakeads=1: полноэкранный тёмный оверлей
   * с пометкой «тестовый показ» и обратным отсчётом. Настоящие рекламные
   * креативы показывает только реальная площадка; dev-адаптер прокси
   * рисует свой собственный оверлей сам, этот мок — лишь для проверки
   * флоу без площадки.
   */
  private showFakeAd(kind: 'interstitial' | 'rewarded', durationMs: number): Promise<void> {
    return new Promise((resolve) => {
      try {
        if (typeof document === 'undefined') {
          resolve();
          return;
        }
        this.hideFakeAd();
        const root = document.createElement('div');
        root.id = 'dg-fake-ad';
        root.setAttribute('role', 'dialog');
        root.setAttribute(
          'aria-label',
          kind === 'rewarded' ? 'Тестовая видеореклама' : 'Тестовый рекламный блок',
        );
        const secs = Math.max(1, Math.round(durationMs / 1000));
        root.style.cssText =
          'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.92);' +
          'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;' +
          'font-family:Arial,sans-serif;';
        const badge = document.createElement('div');
        badge.textContent = 'ТЕСТОВЫЙ ПОКАЗ · FAKEADS';
        badge.style.cssText = 'color:#FFC107;font-size:13px;letter-spacing:3px;';
        const title = document.createElement('div');
        title.textContent = kind === 'rewarded' ? 'Видеореклама' : 'Реклама';
        title.style.cssText = 'color:#fff;font-size:34px;font-weight:bold;';
        const counter = document.createElement('div');
        counter.textContent = String(secs);
        counter.style.cssText = 'color:#9A9BA8;font-size:15px;';
        root.appendChild(badge);
        root.appendChild(title);
        root.appendChild(counter);
        document.body.appendChild(root);
        this.fakeOverlay = root;
        const startedAt = Date.now();
        const timer = window.setInterval(() => {
          const left = Math.max(0, Math.ceil((durationMs - (Date.now() - startedAt)) / 1000));
          counter.textContent = String(left);
          if (Date.now() - startedAt >= durationMs) {
            window.clearInterval(timer);
            this.hideFakeAd();
            resolve();
          }
        }, 200);
      } catch {
        resolve();
      }
    });
  }

  private hideFakeAd(): void {
    try {
      this.fakeOverlay?.remove();
    } catch {
      /* ignore */
    }
    this.fakeOverlay = null;
  }
}
