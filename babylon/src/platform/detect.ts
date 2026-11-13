import type { PlatformId } from './types';

export interface DetectInput {
  /** Полный query string, например location.search. */
  query?: string;
  /** Хост страницы в нижнем регистре, например location.hostname. */
  hostname?: string;
  /** В странице уже есть глобальный объект SDK площадки. */
  hasYaGames?: boolean;
  hasGamePush?: boolean;
  hasCrazyGames?: boolean;
  hasGDSdk?: boolean;
}

function queryPlatform(query: string | undefined): PlatformId | null {
  if (!query) return null;
  const m = /(?:^|[?&])platform=([a-z]+)/i.exec(query);
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (v === 'yandex' || v === 'ya') return 'yandex';
  if (v === 'gamepush' || v === 'gp') return 'gamepush';
  if (v === 'crazygames' || v === 'crazy' || v === 'cg') return 'crazygames';
  if (v === 'gamedistribution' || v === 'gd' || v === 'gamedist') return 'gamedistribution';
  if (v === 'standalone' || v === 'local' || v === 'none') return 'standalone';
  return null;
}

/**
 * Чистая функция выбора площадки (покрыта юнит-тестами).
 * Приоритет: явный ?platform= > глобальные объекты SDK > хост > standalone.
 */
export function detectPlatformId(input: DetectInput = {}): PlatformId {
  const forced = queryPlatform(input.query);
  if (forced) return forced;
  // GamePush сам подключает SDK нижележащей площадки. Если он есть на
  // странице, именно он управляет рекламой, паузой и профилем, поэтому
  // проверяем его раньше нативных SDK (на Яндексе через GamePush будут
  // одновременно доступны gp и YaGames).
  if (input.hasGamePush) return 'gamepush';
  if (input.hasYaGames) return 'yandex';
  if (input.hasCrazyGames) return 'crazygames';
  if (input.hasGDSdk) return 'gamedistribution';
  const host = (input.hostname ?? '').toLowerCase();
  if (host.includes('yandex')) return 'yandex';
  if (host.includes('crazygames')) return 'crazygames';
  if (host.includes('gamedistribution') || host.includes('gamedist')) return 'gamedistribution';
  return 'standalone';
}
