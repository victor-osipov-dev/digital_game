import { afterEach, describe, expect, it } from 'vitest';
import { detectPlatformId } from '../src/platform/detect';
import { StandalonePlatform } from '../src/platform/noop';
import { YandexPlatform } from '../src/platform/yandex';
import { GamePushPlatform } from '../src/platform/gamepush';
import { CrazyGamesPlatform } from '../src/platform/crazygames';
import { YouTubePlatform } from '../src/platform/youtube';

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

// Заглушка GamePush: SDK «пришёл» в onGPInit, поэтому init не ждёт загрузку.
function installGamePush(gp: Record<string, unknown>): void {
  const win: Record<string, unknown> = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    location: { search: '', hostname: 'example.com' },
    __dgGP: gp,
    __dgGamePush: true,
    self: {},
  };
  win.top = win;
  (globalThis as unknown as Record<string, unknown>).window = win;
}

// Заглушка CrazyGames SDK v3: SDK уже «внедрён», init возвращает промис.
function installCrazyGames(sdk: Record<string, unknown>): void {
  const win: Record<string, unknown> = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    location: { search: '', hostname: 'example.com' },
    CrazyGames: { SDK: sdk },
    self: {},
  };
  win.top = win;
  (globalThis as unknown as Record<string, unknown>).window = win;
}

// Заглушка YouTube Playables SDK: глобальный ytgame.
function installYouTube(sdk: Record<string, unknown>): void {
  const win: Record<string, unknown> = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    location: { search: '', hostname: 'example.com' },
    ytgame: sdk,
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
    expect(detectPlatformId({ query: '?platform=gamepush', hasYaGames: true })).toBe('gamepush');
    expect(detectPlatformId({ query: '?platform=gp', hasYaGames: true })).toBe('gamepush');
    expect(detectPlatformId({ query: '?platform=crazygames', hasYaGames: true })).toBe('crazygames');
    expect(detectPlatformId({ query: '?platform=gd', hasYaGames: true })).toBe('gamedistribution');
    expect(detectPlatformId({ query: '?platform=local', hasYaGames: true })).toBe('standalone');
  });

  it('глобальные объекты SDK', () => {
    expect(detectPlatformId({ hasYaGames: true })).toBe('yandex');
    // GamePush — агрегатор: его SDK важнее нативного SDK площадки.
    expect(detectPlatformId({ hasGamePush: true, hasYaGames: true })).toBe('gamepush');
    expect(detectPlatformId({ hasCrazyGames: true })).toBe('crazygames');
    expect(detectPlatformId({ hasYtGame: true })).toBe('youtube');
    expect(detectPlatformId({ hasGDSdk: true })).toBe('gamedistribution');
  });

  it('явный ?platform=youtube', () => {
    expect(detectPlatformId({ query: '?platform=youtube', hasYaGames: true })).toBe('youtube');
    expect(detectPlatformId({ query: '?platform=yt' })).toBe('youtube');
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

describe('GamePushPlatform', () => {
  it('читает язык, устройство и профиль игрока', async () => {
    installGamePush({
      language: 'en-US',
      isMobile: true,
      player: {
        id: 42,
        name: 'Игрок',
        isLoggedIn: true,
        ready: Promise.resolve(),
      },
    });
    const p = new GamePushPlatform();
    await p.init();
    expect(p.id).toBe('gamepush');
    expect(p.getInterfaceLang()).toBe('en');
    expect(p.getDevice()).toBe('mobile');
    expect(await p.getPlayer()).toEqual({ uid: '42', name: 'Игрок', authorized: true });
  });

  it('вход через GamePush: login + событие login', async () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    let loggedIn = false;
    installGamePush({
      player: {
        id: 7,
        isLoggedIn: false,
        on: (ev: string, cb: (...args: unknown[]) => void) => { handlers[ev] = cb; },
        login: () => {
          loggedIn = true;
          handlers.login?.(true);
        },
      },
    });
    const p = new GamePushPlatform();
    await p.init();
    expect(await p.openAuthDialog()).toBe(true);
    expect(loggedIn).toBe(true);
  });

  it('таблица GamePush: scoped fetch по ID и publishRecord', async () => {
    const setCalls: unknown[][] = [];
    const publishCalls: unknown[] = [];
    let synced = 0;
    installGamePush({
      leaderboard: {
        fetchScoped: async (opts: Record<string, unknown>) => {
          expect(opts).toMatchObject({ id: 101345, order: 'DESC', limit: 10 });
          return {
            topPlayers: [
              { id: 1, name: 'Первый', position: 1, wins: 9 },
              { id: 2, name: 'Второй', position: 2, wins: 4 },
            ],
            player: { id: 3, name: 'Я', position: 7, wins: 2 },
          };
        },
        publishRecord: async (opts: Record<string, unknown>) => {
          publishCalls.push(opts);
          return { record: opts.record };
        },
        fetch: async () => {
          throw new Error('global fetch не должен вызываться');
        },
      },
      player: {
        id: 3,
        set: (key: string, value: unknown) => { setCalls.push([key, value]); },
        sync: async () => { synced += 1; },
      },
    });
    const p = new GamePushPlatform();
    await p.init();
    expect(await p.getLeaderboardEntries('wins')).toEqual({
      entries: [
        { name: 'Первый', score: 9, rank: 1 },
        { name: 'Второй', score: 4, rank: 2 },
      ],
      userRank: 7,
    });
    expect(await p.reportLeaderboardScore('wins', 12)).toBe(true);
    expect(publishCalls).toEqual([
      { id: 101345, record: { wins: 12 }, override: true },
    ]);
    expect(setCalls).toEqual([['wins', 12]]);
    expect(synced).toBe(1);
  });

  it('таблица GamePush: резерв по тегу и глобальному полю', async () => {
    const scopedCalls: Array<Record<string, unknown>> = [];
    installGamePush({
      leaderboard: {
        fetchScoped: async (opts: Record<string, unknown>) => {
          scopedCalls.push(opts);
          if (opts.id) throw new Error('leaderboard_not_found');
          return { topPlayers: [{ id: 4, name: 'Тег', position: 1, wins: 5 }] };
        },
        fetch: async () => {
          throw new Error('global fetch не должен вызываться');
        },
      },
    });
    const p = new GamePushPlatform();
    await p.init();
    expect(await p.getLeaderboardEntries('wins')).toMatchObject({
      entries: [{ name: 'Тег', score: 5, rank: 1 }],
    });
    expect(scopedCalls[0]).toMatchObject({ id: 101345 });
    expect(scopedCalls[1]).toMatchObject({ tag: 'wins', variant: 'all' });
  });

  it('таблица GamePush: глобальный fetch, когда scoped недоступен', async () => {
    installGamePush({
      leaderboard: {
        fetchScoped: async () => {
          throw new Error('leaderboard_not_found');
        },
        fetch: async (opts: Record<string, unknown>) => {
          expect(opts).toMatchObject({ orderBy: ['wins'], order: 'DESC', limit: 10 });
          return {
            topPlayers: [{ id: 5, name: 'Глобальный', position: 1, wins: 3 }],
          };
        },
      },
    });
    const p = new GamePushPlatform();
    await p.init();
    expect(await p.getLeaderboardEntries('wins')).toMatchObject({
      entries: [{ name: 'Глобальный', score: 3, rank: 1 }],
    });
  });

  it('реклама и sticky-баннер', async () => {
    const calls: string[] = [];
    installGamePush({
      ads: {
        isFullscreenAvailable: true,
        isRewardedAvailable: true,
        showFullscreen: async () => true,
        showRewardedVideo: async () => true,
        showSticky: () => { calls.push('show'); },
        closeSticky: () => { calls.push('close'); },
      },
    });
    const p = new GamePushPlatform();
    await p.init();
    expect(await p.showInterstitial()).toBe(true);
    expect(await p.showRewarded()).toBe(true);
    p.setBannerVisible(true);
    p.setBannerVisible(false);
    expect(calls).toEqual(['show', 'close']);
  });

  it('полноэкранный режим и события паузы', async () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    let fsOn = false;
    installGamePush({
      fullscreen: {
        get isEnabled() { return fsOn; },
        toggle: () => { fsOn = !fsOn; },
        close: () => { fsOn = false; },
      },
      on: (ev: string, cb: (...args: unknown[]) => void) => { handlers[ev] = cb; },
    });
    const p = new GamePushPlatform();
    await p.init();
    expect(p.isFullscreen()).toBe(false);
    expect(await p.toggleFullscreen()).toBe(true);
    expect(await p.exitFullscreen()).toBe(false);
    let paused = 0;
    let resumed = 0;
    p.onPause(() => { paused += 1; });
    p.onResume(() => { resumed += 1; });
    handlers.pause?.();
    handlers.resume?.();
    expect(paused).toBe(1);
    expect(resumed).toBe(1);
  });

  it('прогресс через storage и звук через sounds', async () => {
    const stored: Record<string, unknown> = {};
    const soundCalls: string[] = [];
    const handlers: Record<string, () => void> = {};
    const sounds = {
      isMuted: false,
      mute: () => { soundCalls.push('mute'); sounds.isMuted = true; },
      unmute: () => { soundCalls.push('unmute'); sounds.isMuted = false; },
      on: (ev: string, cb: () => void) => { handlers[ev] = cb; },
    };
    installGamePush({
      storage: {
        get: async (key: string) => stored[key] ?? null,
        set: async (key: string, value: unknown) => { stored[key] = value; },
      },
      sounds,
    });
    const p = new GamePushPlatform();
    await p.init();
    expect(await p.saveProgress({ saved_at: 5, settings: { lang: 'ru' } })).toBe(true);
    expect(await p.loadProgress()).toMatchObject({ savedAt: 5, data: { settings: { lang: 'ru' } } });
    expect(p.isAudioEnabled()).toBe(true);
    p.setAudioEnabled(false);
    p.setAudioEnabled(true);
    expect(soundCalls).toEqual(['mute', 'unmute']);
    let audio = true;
    p.onAudioChange((v) => { audio = v; });
    sounds.isMuted = true;
    handlers.mute?.();
    expect(audio).toBe(false);
  });

  it('supportsRewarded зависит от доступности рекламы', async () => {
    installGamePush({ ads: { isRewardedAvailable: false } });
    const p = new GamePushPlatform();
    await p.init();
    expect(p.supportsRewarded).toBe(false);
    expect(p.supportsOnline).toBe(true);
  });
});

describe('CrazyGamesPlatform (SDK v3)', () => {
  it('init вызывает SDK.init, loadingStart/Stop и gameplay', async () => {
    const calls: string[] = [];
    installCrazyGames({
      environment: 'local',
      init: async () => { calls.push('init'); },
      game: {
        loadingStart: () => calls.push('loadingStart'),
        loadingStop: () => calls.push('loadingStop'),
        gameplayStart: () => calls.push('gameplayStart'),
        gameplayStop: () => calls.push('gameplayStop'),
      },
      user: { systemInfo: { locale: 'ru-RU', device: { type: 'mobile' } } },
    });
    const p = new CrazyGamesPlatform();
    await p.init();
    expect(calls).toContain('init');
    expect(calls).toContain('loadingStart');
    p.gameReady();
    p.gameplayStart();
    p.gameplayStop();
    expect(calls).toEqual(['init', 'loadingStart', 'loadingStop', 'gameplayStart', 'gameplayStop']);
    expect(p.getInterfaceLang()).toBe('ru');
    expect(p.getDevice()).toBe('mobile');
  });

  it('реклама: midgame и rewarded, награда только по adFinished', async () => {
    const kinds: string[] = [];
    let mode: 'finish' | 'error' = 'finish';
    installCrazyGames({
      environment: 'crazygames',
      init: async () => undefined,
      ad: {
        requestAd: (kind: string, cb: Record<string, (a?: unknown, b?: unknown) => void>) => {
          kinds.push(kind);
          if (mode === 'finish') cb.adFinished?.();
          else cb.adError?.(new Error('no ad'));
        },
      },
    });
    const p = new CrazyGamesPlatform();
    await p.init();
    expect(await p.showInterstitial()).toBe(true);
    expect(await p.showRewarded()).toBe(true);
    mode = 'error';
    expect(await p.showRewarded()).toBe(false);
    expect(kinds).toEqual(['midgame', 'rewarded', 'rewarded']);
  });

  it('прогресс через data и muteAudio важнее кнопки звука', async () => {
    const store: Record<string, string> = {};
    let settings: Record<string, unknown> = { muteAudio: false };
    const listeners: Array<(s: Record<string, unknown>) => void> = [];
    installCrazyGames({
      environment: 'crazygames',
      init: async () => undefined,
      data: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => { store[key] = value; },
      },
      game: {
        get settings() { return settings; },
        addSettingsChangeListener: (cb: (s: Record<string, unknown>) => void) => { listeners.push(cb); },
      },
    });
    const p = new CrazyGamesPlatform();
    await p.init();
    expect(await p.saveProgress({ saved_at: 9, settings: { lang: 'en' } })).toBe(true);
    expect(await p.loadProgress()).toMatchObject({ savedAt: 9 });
    expect(p.isAudioEnabled()).toBe(true);
    let audio = true;
    p.onAudioChange((v) => { audio = v; });
    settings = { muteAudio: true };
    listeners.forEach((cb) => cb(settings));
    expect(audio).toBe(false);
    expect(p.isAudioEnabled()).toBe(false);
  });
});

describe('YouTubePlatform (Playables)', () => {
  it('firstFrameReady до gameReady, язык и звук из system', async () => {
    const calls: string[] = [];
    let audioCb: ((v: boolean) => void) | null = null;
    let pauseCb: (() => void) | null = null;
    let resumeCb: (() => void) | null = null;
    installYouTube({
      IN_PLAYABLES_ENV: true,
      game: {
        firstFrameReady: () => calls.push('firstFrame'),
        gameReady: () => calls.push('ready'),
      },
      system: {
        getLanguage: async () => 'es-419',
        isAudioEnabled: () => true,
        onAudioEnabledChange: (cb: (v: boolean) => void) => { audioCb = cb; },
        onPause: (cb: () => void) => { pauseCb = cb; },
        onResume: (cb: () => void) => { resumeCb = cb; },
      },
    });
    const p = new YouTubePlatform();
    await p.init();
    expect(p.getInterfaceLang()).toBe('es');
    expect(p.supportsOnline).toBe(false);
    p.gameReady();
    expect(calls).toEqual(['firstFrame', 'ready']);
    let audio = true;
    p.onAudioChange((v) => { audio = v; });
    const fireAudio = audioCb as ((v: boolean) => void) | null;
    if (fireAudio) fireAudio(false);
    expect(audio).toBe(false);
    let paused = 0;
    let resumed = 0;
    p.onPause(() => { paused += 1; });
    p.onResume(() => { resumed += 1; });
    const firePause = pauseCb as (() => void) | null;
    const fireResume = resumeCb as (() => void) | null;
    if (firePause) firePause();
    if (fireResume) fireResume();
    expect(paused).toBe(1);
    expect(resumed).toBe(1);
  });

  it('реклама и прогресс через loadData/saveData', async () => {
    let blob = '';
    installYouTube({
      IN_PLAYABLES_ENV: true,
      ads: {
        requestInterstitialAd: async () => undefined,
        requestRewardedAd: async (id: string) => id === 'dg-hint',
      },
      game: {
        loadData: async () => blob,
        saveData: async (data: string) => { blob = data; },
      },
      system: { getLanguage: async () => 'en-US' },
    });
    const p = new YouTubePlatform();
    await p.init();
    expect(await p.showInterstitial()).toBe(true);
    expect(await p.showRewarded()).toBe(true);
    expect(await p.saveProgress({ saved_at: 3, settings: { lang: 'en' } })).toBe(true);
    expect(await p.loadProgress()).toMatchObject({ savedAt: 3 });
  });
});
