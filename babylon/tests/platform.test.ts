import { afterEach, describe, expect, it } from 'vitest';
import { detectPlatformId } from '../src/platform/detect';
import { StandalonePlatform } from '../src/platform/noop';
import { YandexPlatform } from '../src/platform/yandex';

// Минимальная заглушка window для провайдера Яндекса: SDK уже «внедрён»,
// поэтому init не грузит /sdk.js, а берёт готовый объект.
function installYandex(ysdk: Record<string, unknown>): void {
  const win: Record<string, unknown> = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    location: { search: '', hostname: 'example.com' },
    YaGames: { init: () => Promise.resolve(ysdk) },
    self: {},
  };
  win.top = win;
  (globalThis as unknown as Record<string, unknown>).window = win;
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).window;
});

describe('detectPlatformId', () => {
  it('по умолчанию standalone', () => {
    expect(detectPlatformId({})).toBe('standalone');
    expect(detectPlatformId({ hostname: 'example.com' })).toBe('standalone');
  });

  it('явный ?platform= имеет наивысший приоритет', () => {
    expect(detectPlatformId({ query: '?platform=yandex', hasCrazyGames: true })).toBe('yandex');
    expect(detectPlatformId({ query: '?platform=crazygames', hasYaGames: true })).toBe('crazygames');
    expect(detectPlatformId({ query: '?platform=gd', hasYaGames: true })).toBe('gamedistribution');
    expect(detectPlatformId({ query: '?platform=local', hasYaGames: true })).toBe('standalone');
  });

  it('глобальные объекты SDK', () => {
    expect(detectPlatformId({ hasYaGames: true })).toBe('yandex');
    expect(detectPlatformId({ hasCrazyGames: true })).toBe('crazygames');
    expect(detectPlatformId({ hasGDSdk: true })).toBe('gamedistribution');
  });

  it('эвристика по хосту', () => {
    expect(detectPlatformId({ hostname: 'app.games.s3.yandex.net' })).toBe('yandex');
    expect(detectPlatformId({ hostname: 'www.crazygames.com' })).toBe('crazygames');
  });
});

describe('StandalonePlatform', () => {
  it('все методы безопасны и не бросают', async () => {
    const p = new StandalonePlatform();
    await p.init();
    p.gameReady();
    p.gameplayStart();
    p.gameplayStop();
    expect(await p.showInterstitial()).toBe(false);
    expect(await p.showRewarded()).toBe(false);
    expect(await p.getPlayer()).toBeNull();
    expect(await p.openAuthDialog()).toBe(false);
    expect(await p.getLeaderboardEntries('wins')).toMatchObject({ entries: [], error: 'unsupported' });
    expect(await p.reportLeaderboardScore('wins', 3)).toBe(false);
    expect(p.getInterfaceLang()).toBeNull();
    expect(p.supportsRewarded).toBe(false);
  });

  it('без площадки нет оценки, ярлыка и рекламы; fullscreen — браузерный', async () => {
    const p = new StandalonePlatform();
    await p.init();
    expect(p.supportsFullscreen).toBe(false); // в node/без DOM браузерного fullscreen нет
    expect(p.supportsReview).toBe(false);
    expect(p.supportsShortcut).toBe(false);
    expect(await p.canReview()).toBe(false);
    expect(await p.requestReview()).toBe(false);
    expect(await p.canAddShortcut()).toBe(false);
    expect(await p.addShortcut()).toBe(false);
    expect(p.isFullscreen()).toBe(false);
    expect(typeof (await p.toggleFullscreen())).toBe('boolean');
    expect(typeof (await p.writeClipboard('x'))).toBe('boolean');
    p.setBannerVisible(true);
    p.onPause(() => undefined);
    p.onResume(() => undefined);
  });
});

describe('YandexPlatform: новые возможности SDK', () => {
  it('возвращает гостевой/авторизованный профиль только после явного диалога', async () => {
    let authorized = false;
    const calls: string[] = [];
    installYandex({
      getPlayer: async () => ({
        getUniqueID: () => 'yandex-uid-123',
        getName: () => authorized ? 'Игрок' : 'Гость',
        isAuthorized: () => authorized,
      }),
      auth: {
        openAuthDialog: async () => {
          calls.push('auth');
          authorized = true;
        },
      },
    });
    const p = new YandexPlatform();
    await p.init();
    expect(await p.getPlayer()).toEqual({ uid: 'yandex-uid-123', name: 'Гость', authorized: false });
    expect(calls).toEqual([]);
    expect(await p.openAuthDialog()).toBe(true);
    expect(await p.getPlayer()).toEqual({ uid: 'yandex-uid-123', name: 'Игрок', authorized: true });
    expect(calls).toEqual(['auth']);
  });

  it('читает таблицу Яндекса и записывает подтверждённый счёт', async () => {
    const calls: unknown[][] = [];
    installYandex({
      leaderboards: {
        getEntries: async (name: string, opts: unknown) => {
          calls.push(['get', name, opts]);
          return {
            entries: [{ score: 8, rank: 2, player: { publicName: 'Победитель' } }],
            userRank: 2,
          };
        },
        setScore: async (name: string, score: number) => { calls.push(['set', name, score]); },
      },
    });
    const p = new YandexPlatform();
    await p.init();
    expect(await p.getLeaderboardEntries('wins')).toEqual({
      entries: [{ name: 'Победитель', score: 8, rank: 2 }],
      userRank: 2,
    });
    expect(await p.reportLeaderboardScore('wins', 12)).toBe(true);
    expect(calls[0]).toEqual(['get', 'wins', {
      quantityTop: 5, quantityAround: 5, includeUser: true,
    }]);
    expect(calls[1]).toEqual(['set', 'wins', 12]);
  });

  it('оценка игры: canReview перед requestReview', async () => {
    const calls: string[] = [];
    installYandex({
      features: {},
      feedback: {
        canReview: () => {
          calls.push('can');
          return Promise.resolve({ value: true });
        },
        requestReview: () => {
          calls.push('request');
          return Promise.resolve({ feedbackSent: true });
        },
      },
    });
    const p = new YandexPlatform();
    await p.init();
    expect(p.supportsReview).toBe(true);
    expect(await p.canReview()).toBe(true);
    expect(await p.requestReview()).toBe(true);
    // requestReview обязан сначала сам вызвать canReview (требование SDK).
    expect(calls).toEqual(['can', 'can', 'request']);
  });

  it('оценка недоступна — тихий false', async () => {
    installYandex({
      feedback: { canReview: () => Promise.resolve({ value: false, reason: 'NO_AUTH' }) },
    });
    const p = new YandexPlatform();
    await p.init();
    expect(await p.canReview()).toBe(false);
    expect(await p.requestReview()).toBe(false);
  });

  it('ярлык на рабочий стол', async () => {
    installYandex({
      shortcut: {
        canShowPrompt: () => Promise.resolve({ canShow: true }),
        showPrompt: () => Promise.resolve({ outcome: 'accepted' }),
      },
    });
    const p = new YandexPlatform();
    await p.init();
    expect(p.supportsShortcut).toBe(true);
    expect(await p.canAddShortcut()).toBe(true);
    expect(await p.addShortcut()).toBe(true);
  });

  it('sticky-баннер: show/hide через adv', async () => {
    const calls: string[] = [];
    installYandex({
      adv: {
        showBannerAdv: () => {
          calls.push('show');
          return Promise.resolve({ stickyAdvIsShowing: true });
        },
        hideBannerAdv: () => {
          calls.push('hide');
          return Promise.resolve({ stickyAdvIsShowing: false });
        },
      },
    });
    const p = new YandexPlatform();
    await p.init();
    p.setBannerVisible(false);
    p.setBannerVisible(true);
    await Promise.resolve();
    expect(calls).toEqual(['hide', 'show']);
  });

  it('полноэкранный режим через screen.fullscreen', async () => {
    const fs = {
      STATUS_ON: 'on',
      status: 'off',
      request: () => {
        fs.status = 'on';
        return Promise.resolve();
      },
      exit: () => {
        fs.status = 'off';
        return Promise.resolve();
      },
    };
    installYandex({ screen: { fullscreen: fs } });
    const p = new YandexPlatform();
    await p.init();
    expect(p.supportsFullscreen).toBe(true);
    expect(p.isFullscreen()).toBe(false);
    expect(await p.toggleFullscreen()).toBe(true);
    expect(p.isFullscreen()).toBe(true);
    expect(await p.toggleFullscreen()).toBe(false);
  });

  it('события game_api_pause/resume доходят до подписчиков', async () => {
    const handlers: Record<string, () => void> = {};
    installYandex({
      on: (ev: string, cb: () => void) => {
        handlers[ev] = cb;
      },
    });
    const p = new YandexPlatform();
    await p.init();
    let paused = 0;
    let resumed = 0;
    p.onPause(() => {
      paused += 1;
    });
    p.onResume(() => {
      resumed += 1;
    });
    handlers['game_api_pause']?.();
    handlers['game_api_resume']?.();
    expect(paused).toBe(1);
    expect(resumed).toBe(1);
  });

  it('буфер обмена предпочитает SDK Яндекса', async () => {
    const written: string[] = [];
    installYandex({ clipboard: { writeText: (t: string) => written.push(t) } });
    const p = new YandexPlatform();
    await p.init();
    expect(await p.writeClipboard('ABC123')).toBe(true);
    expect(written).toEqual(['ABC123']);
  });
});
