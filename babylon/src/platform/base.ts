import type {
  DeviceKind,
  PlatformAPI,
  PlatformId,
  PlatformLeaderboard,
  PlatformPlayer,
  PlatformProgress,
} from './types';
import {
  browserExitFullscreen,
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
  readonly supportsOnline: boolean = true;
  readonly supportsAudio: boolean = false;
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

  async getPlayer(): Promise<PlatformPlayer | null> {
    return null;
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
    return null;
  }

  getDevice(): DeviceKind {
    return 'unknown';
  }

  async loadProgress(): Promise<PlatformProgress | null> {
    return null;
  }

  async saveProgress(_data: Record<string, unknown>): Promise<boolean> {
    return false;
  }

  isAudioEnabled(): boolean {
    return true;
  }

  onAudioChange(_cb: (enabled: boolean) => void): void {
    // no-op: у площадки нет управления звуком
  }

  setAudioEnabled(_enabled: boolean): void {
    // no-op
  }

  isFullscreen(): boolean {
    return browserIsFullscreen();
  }

  async toggleFullscreen(): Promise<boolean> {
    return browserToggleFullscreen();
  }

  async exitFullscreen(): Promise<boolean> {
    return browserExitFullscreen();
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
