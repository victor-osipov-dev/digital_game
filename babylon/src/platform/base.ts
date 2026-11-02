import type { DeviceKind, PlatformAPI, PlatformId } from './types';
import {
  browserFullscreenAvailable,
  browserIsFullscreen,
  browserToggleFullscreen,
  browserWriteClipboard,
} from './browser';

/**
 * Базовая площадка «своего сайта» и фундамент для остальных провайдеров:
 * браузерный fullscreen и буфер обмена, отсутствие рекламы, оценок и
 * ярлыков. Конкретные площадки наследуют класс и переопределяют нужное.
 */
export abstract class BasePlatform implements PlatformAPI {
  abstract readonly id: PlatformId;
  abstract get isEmbedded(): boolean;

  readonly supportsRewarded: boolean = false;
  readonly supportsFullscreen: boolean = browserFullscreenAvailable();
  readonly supportsReview: boolean = false;
  readonly supportsShortcut: boolean = false;

  abstract init(): Promise<void>;

  gameReady(): void {
    // no-op
  }

  gameplayStart(): void {
    // no-op
  }

  gameplayStop(): void {
    // no-op
  }

  async showInterstitial(): Promise<boolean> {
    return false;
  }

  async showRewarded(): Promise<boolean> {
    return false;
  }

  getInterfaceLang(): string | null {
    return null;
  }

  getDevice(): DeviceKind {
    return 'unknown';
  }

  isFullscreen(): boolean {
    return browserIsFullscreen();
  }

  async toggleFullscreen(): Promise<boolean> {
    return browserToggleFullscreen();
  }

  setBannerVisible(_visible: boolean): void {
    // no-op
  }

  async canReview(): Promise<boolean> {
    return false;
  }

  async requestReview(): Promise<boolean> {
    return false;
  }

  async canAddShortcut(): Promise<boolean> {
    return false;
  }

  async addShortcut(): Promise<boolean> {
    return false;
  }

  async writeClipboard(text: string): Promise<boolean> {
    return browserWriteClipboard(text);
  }

  onPause(_cb: () => void): void {
    // no-op: платформенных событий паузы нет
  }

  onResume(_cb: () => void): void {
    // no-op
  }
}
