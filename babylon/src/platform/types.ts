// Платформенный слой: единый интерфейс для всех браузерных площадок
// (Яндекс Игры, CrazyGames, GameDistribution, свой сайт / standalone).
//
// Правила:
// - игра вызывает только PlatformAPI и никогда не обращается к SDK
//   площадок напрямую;
// - провайдер обязан никогда не ронять игру: любой вызов SDK обёрнут,
//   при отсутствии SDK всё превращается в no-op;
// - инициализация ограничена таймаутом и не блокирует запуск игры.
export type PlatformId = 'yandex' | 'gamepush' | 'crazygames' | 'gamedistribution' | 'standalone';

export type DeviceKind = 'desktop' | 'mobile' | 'tablet' | 'tv' | 'unknown';

export interface PlatformPlayer {
  uid: string;
  name: string;
  authorized: boolean;
}

export interface PlatformLeaderboardEntry {
  name: string;
  score: number;
  rank: number;
}

export interface PlatformLeaderboard {
  entries: PlatformLeaderboardEntry[];
  userRank: number;
  error?: string;
}

export interface PlatformAPI {
  readonly id: PlatformId;
  /** Игра запущена внутри iframe площадки (а не отдельной страницей). */
  readonly isEmbedded: boolean;
  /** Площадка умеет видеорекламу с вознаграждением. */
  readonly supportsRewarded: boolean;
  /** Площадка умеет управлять полноэкранным режимом. */
  readonly supportsFullscreen: boolean;
  /** Площадка умеет запрашивать оценку игры. */
  readonly supportsReview: boolean;
  /** Площадка умеет предлагать ярлык на рабочий стол. */
  readonly supportsShortcut: boolean;
  /** Подключение SDK. Никогда не бросает исключение. */
  init(): Promise<void>;
  /** Игра загрузилась и готова к взаимодействию (Yandex Game Ready и аналоги). */
  gameReady(): void;
  /** Игрок начал/возобновил игровой процесс. */
  gameplayStart(): void;
  /** Игровой процесс приостановлен/завершён. */
  gameplayStop(): void;
  /**
   * Полноэкранная реклама в логической паузе.
   * @returns true — реклама была показана, false — пропущена/ошибка.
   * Никогда не бросает исключение и всегда завершается (есть таймаут).
   */
  showInterstitial(): Promise<boolean>;
  /**
   * Видеореклама с вознаграждением (только после явного согласия игрока).
   * @returns true — просмотр засчитан, можно выдавать награду.
   */
  showRewarded(): Promise<boolean>;
  /** Профиль площадки без диалога входа (у гостя возвращается lite-ID). */
  getPlayer(): Promise<PlatformPlayer | null>;
  /** Явный диалог входа площадки; вызывается только после нажатия игрока. */
  openAuthDialog(): Promise<boolean>;
  /** Платформенная таблица; ошибка не должна скрывать серверный топ. */
  getLeaderboardEntries(name: string): Promise<PlatformLeaderboard>;
  /** Запись очков в таблицу площадки из подтверждённых сервером данных. */
  reportLeaderboardScore(name: string, score: number): Promise<boolean>;
  /** Язык интерфейса площадки в формате 'ru' | 'en' | ..., null — неизвестен. */
  getInterfaceLang(): string | null;
  getDevice(): DeviceKind;
  /**
   * Текущий полноэкранный статус. На площадках без своего API — статус
   * браузерного fullscreen.
   */
  isFullscreen(): boolean;
  /**
   * Переключить полноэкранный режим (вызывать только из жеста игрока).
   * @returns новое состояние: true — игра развернута на весь экран.
   * Никогда не бросает исключение.
   */
  toggleFullscreen(): Promise<boolean>;
  /**
   * Выйти из полноэкранного режима (вызывать только из жеста игрока).
   * @returns true — игра всё ещё развернута на весь экран.
   * Никогда не бросает исключение.
   */
  exitFullscreen(): Promise<boolean>;
  /**
   * Показать/скрыть sticky-баннер площадки (если он подключён в консоли).
   * Безопасный no-op на площадках без такой возможности.
   */
  setBannerVisible(visible: boolean): void;
  /** Доступна ли оценка игры конкретному игроку (нужна авторизация). */
  canReview(): Promise<boolean>;
  /** Запросить оценку игры; true — игрок оставил оценку/отзыв. */
  requestReview(): Promise<boolean>;
  /** Можно ли предложить добавить ярлык на рабочий стол. */
  canAddShortcut(): Promise<boolean>;
  /** Показать нативный диалог ярлыка; true — игрок согласился. */
  addShortcut(): Promise<boolean>;
  /** Записать текст в буфер обмена площадки; true — успех. */
  writeClipboard(text: string): Promise<boolean>;
  /** Подписка на платформенную паузу (реклама, сворачивание окна). */
  onPause(cb: () => void): void;
  /** Подписка на платформенное возобновление игры. */
  onResume(cb: () => void): void;
}
