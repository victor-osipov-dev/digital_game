import { BasePlatform } from './base';

/**
 * Свой сайт / локальный запуск / неизвестная площадка.
 * Все вызовы — безопасные no-op: игра работает полностью офлайн,
 * реклама отсутствует, язык определяется настройками и браузером.
 * Полноэкранный режим и буфер обмена — браузерные.
 */
export class StandalonePlatform extends BasePlatform {
  readonly id = 'standalone' as const;

  get isEmbedded(): boolean {
    try {
      return typeof window !== 'undefined' && window.self !== window.top;
    } catch {
      // Доступ к window.top запрещён политикой — значит, мы во фрейме.
      return true;
    }
  }

  async init(): Promise<void> {
    // Подключать нечего.
  }
}
