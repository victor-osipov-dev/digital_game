import { afterEach, describe, expect, it } from 'vitest';
import { hintTilesText, setLang } from '../src/core/lang';
import {
  applyItem,
  checkinState,
  claimCheckin,
  clearItem,
  dailyRewardPreview,
  isUnlocked,
  rankFor,
  syncAchievements,
  yesterdayKey,
} from '../src/core/meta';
import { loadSettings, saveSettings } from '../src/core/settings';

// В node-окружении нет window, а сохранение настроек планирует отложенную
// запись через window.setTimeout. Даём минимальную заглушку для тестов.
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  (globalThis as unknown as { window: unknown }).window = {
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
}

describe('russian plurals in hints', () => {
  afterEach(() => setLang('ru'));

  it('uses число / числа / чисел correctly', () => {
    setLang('ru');
    const cases: Array<[number, string]> = [
      [1, 'Подсказка: выложите 1 число'],
      [2, 'Подсказка: выложите 2 числа'],
      [4, 'Подсказка: выложите 4 числа'],
      [5, 'Подсказка: выложите 5 чисел'],
      [11, 'Подсказка: выложите 11 чисел'],
      [21, 'Подсказка: выложите 21 число'],
      [22, 'Подсказка: выложите 22 числа'],
    ];
    for (const [n, text] of cases) expect(hintTilesText(n)).toBe(text);
  });

  it('uses tiles in English', () => {
    setLang('en');
    expect(hintTilesText(1)).toBe('Hint: lay down 1 tile');
    expect(hintTilesText(4)).toBe('Hint: lay down 4 tiles');
  });
});

describe('ranks', () => {
  it('grows with wins', () => {
    expect(rankFor(0).name).toBe('Новичок');
    expect(rankFor(3).name).toBe('Любитель');
    expect(rankFor(250).isMax).toBe(true);
    expect(rankFor(1).nextAt).toBe(3);
  });
});

describe('achievement backfill', () => {
  afterEach(() => {
    saveSettings({
      achievements: [], stat_wins: 0, stat_games: 0, stat_losses: 0,
      coins: 0, owned_items: [], daily_last: '', daily_streak: 0,
      checkin_last: '', checkin_streak: 0, stat_best_run: 0,
    });
  });

  it('unlocks everything the saved stats can prove', () => {
    saveSettings({ stat_wins: 21, stat_games: 21, daily_streak: 2, daily_last: '2026-01-01' });
    syncAchievements();
    for (const id of ['first_win', 'wins_5', 'wins_20', 'games_10', 'daily_play']) {
      expect(isUnlocked(id), id).toBe(true);
    }
  });

  it('does not grant the same achievement twice', () => {
    saveSettings({ stat_wins: 5 });
    const first = syncAchievements();
    expect(first.map((a) => a.id)).toContain('wins_5');
    expect(syncAchievements()).toEqual([]);
  });
});

describe('shop equip toggling', () => {
  afterEach(() => {
    saveSettings({
      table_theme: 'emerald', tile_palette: 'ivory', owned_items: ['emerald', 'ivory'],
    });
  });

  it('can unequip a purchased style and equip it again', () => {
    saveSettings({ owned_items: ['emerald', 'ivory', 'amber'] });
    applyItem('amber');
    expect(loadSettings().tile_palette).toBe('amber');
    clearItem('amber');
    expect(loadSettings().tile_palette).toBe('ivory');
    // Покупка осталась: включаем снова.
    applyItem('amber');
    expect(loadSettings().tile_palette).toBe('amber');
    // Снятие другого товара не сбрасывает текущий выбор.
    clearItem('marble');
    expect(loadSettings().tile_palette).toBe('amber');
  });
});

describe('daily challenge reward', () => {
  afterEach(() => saveSettings({ daily_last: '', daily_streak: 0 }));

  it('previews the next reward and grows with the streak', () => {
    expect(dailyRewardPreview()).toBe(60);
    saveSettings({ daily_last: yesterdayKey(), daily_streak: 2 });
    expect(dailyRewardPreview()).toBe(100);
  });
});

describe('daily check-in', () => {
  afterEach(() => {
    saveSettings({
      achievements: [], coins: 0, checkin_last: '', checkin_streak: 0,
      stat_wins: 0, stat_games: 0, owned_items: [], daily_last: '', daily_streak: 0,
    });
  });

  it('gives the day bonus once per day', () => {
    const first = claimCheckin();
    expect(first?.coins).toBe(20);
    expect(first?.streak).toBe(1);
    expect(checkinState().available).toBe(false);
    expect(claimCheckin()).toBeNull();
  });

  it('continues the streak and unlocks the 7-day achievement', () => {
    saveSettings({ checkin_last: yesterdayKey(), checkin_streak: 6, coins: 0 });
    const res = claimCheckin();
    expect(res?.streak).toBe(7);
    expect(res?.coins).toBe(80);
    expect(isUnlocked('streak_7')).toBe(true);
  });
});
