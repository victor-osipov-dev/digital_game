// Мета-прогресс: звания за победы, монеты, достижения, ежедневная серия,
// недельный счётчик побед и магазин тем. Всё хранится в настройках, поэтому
// автоматически попадает в облачное сохранение площадки.

import { loadSettings, saveSettings } from './settings';
import { platform } from '../platform';
import { t } from './lang';

export interface RankInfo {
  index: number;
  name: string;
  wins: number;
  nextAt: number;
  prevAt: number;
  progress: number;
  isMax: boolean;
}

const RANKS: { at: number; name: string }[] = [
  { at: 0, name: 'Новичок' },
  { at: 3, name: 'Любитель' },
  { at: 10, name: 'Игрок' },
  { at: 25, name: 'Опытный' },
  { at: 50, name: 'Мастер' },
  { at: 100, name: 'Гроссмейстер' },
  { at: 250, name: 'Легенда' },
];

export function rankFor(wins: number): RankInfo {
  let index = 0;
  for (let i = 0; i < RANKS.length; i += 1) {
    if (wins >= RANKS[i].at) index = i;
  }
  const prevAt = RANKS[index].at;
  const isMax = index >= RANKS.length - 1;
  const nextAt = isMax ? prevAt : RANKS[index + 1].at;
  const span = Math.max(1, nextAt - prevAt);
  const progress = isMax ? 1 : Math.max(0, Math.min(1, (wins - prevAt) / span));
  return { index, name: t(RANKS[index].name), wins, nextAt, prevAt, progress, isMax };
}

// Персонажи ботов: имя и аватар зависят от сложности и места за столом.
export const BOT_CHARACTERS = [
  { id: 'timofey', name: 'Тимофей' },
  { id: 'klara', name: 'Клара' },
  { id: 'arkady', name: 'Аркадий' },
  { id: 'max', name: 'Макс' },
  { id: 'lena', name: 'Лена' },
];

export function botCharacterFor(seat: number, level: number): { id: string; name: string } {
  return BOT_CHARACTERS[(Math.max(0, seat) + Math.max(0, level)) % BOT_CHARACTERS.length];
}

export interface AchievementDef {  id: string;
  title: string;
  desc: string;
  reward: number;
  /** Символ-иконка (рисуется текстом, без внешних ассетов). */
  icon: string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_win', title: 'Первый нейрон', desc: 'Выиграйте первую партию', reward: 30, icon: '★' },
  { id: 'wins_5', title: 'Синапсы крепнут', desc: 'Выиграйте 5 партий', reward: 60, icon: '✦' },
  { id: 'wins_20', title: 'Ясный ум', desc: 'Выиграйте 20 партий', reward: 150, icon: '✧' },
  { id: 'games_10', title: 'Тренировка памяти', desc: 'Сыграйте 10 партий', reward: 40, icon: '◉' },
  { id: 'joker_use', title: 'Гибкое мышление', desc: 'Выложите джокер в готовую комбинацию', reward: 25, icon: '✱' },
  { id: 'combo_5', title: 'Мозговой штурм', desc: 'Выложите 5 фишек за один ход', reward: 40, icon: '≡' },
  { id: 'fast_win', title: 'Скорость реакции', desc: 'Победите быстрее чем за 5 минут', reward: 70, icon: '➤' },
  { id: 'four_players', title: 'Социальный интеллект', desc: 'Сыграйте вчетвером или больше', reward: 30, icon: '❖' },
  { id: 'daily_play', title: 'Зарядка для ума', desc: 'Сыграйте ежедневную партию', reward: 30, icon: '☀' },
  { id: 'no_hint_win', title: 'Своим умом', desc: 'Победите, не используя подсказки', reward: 80, icon: '✎' },
  { id: 'quick_win', title: 'Мгновенный расчёт', desc: 'Выиграйте партию до 50 очков', reward: 60, icon: '⚡' },
  { id: 'collector', title: 'Эстет стола', desc: 'Откройте четыре оформления', reward: 100, icon: '◈' },
  { id: 'rich_1000', title: 'Копилка нейронов', desc: 'Накопите 1000 монет', reward: 100, icon: '●' },
  { id: 'run_8', title: 'Длинная цепь', desc: 'Выложите серию из 8 и более фишек', reward: 70, icon: '⛓' },
  { id: 'streak_3', title: 'Нейроразминка', desc: 'Заходите в игру 3 дня подряд', reward: 40, icon: '☼' },
  { id: 'streak_7', title: 'Неделя для мозга', desc: '7 дней подряд — привычка тренировать память', reward: 120, icon: '✺' },
  { id: 'puzzle_solve', title: 'Соло-разминка', desc: 'Соберите все фишки в соло-раскладке', reward: 80, icon: '◍' },
];

/** Прогресс достижения по сохранённой статистике (для полоски в списке). */
export function achievementProgress(id: string): { have: number; need: number } | null {
  const s = loadSettings();
  switch (id) {
    case 'first_win': return { have: Math.min(1, s.stat_wins), need: 1 };
    case 'wins_5': return { have: Math.min(5, s.stat_wins), need: 5 };
    case 'wins_20': return { have: Math.min(20, s.stat_wins), need: 20 };
    case 'games_10': return { have: Math.min(10, s.stat_games), need: 10 };
    case 'rich_1000': return { have: Math.min(1000, s.coins), need: 1000 };
    case 'collector': return { have: Math.min(4, s.owned_items.length), need: 4 };
    case 'streak_3': return { have: Math.min(3, s.checkin_streak), need: 3 };
    case 'streak_7': return { have: Math.min(7, s.checkin_streak), need: 7 };
    case 'run_8': return { have: Math.min(8, s.stat_best_run), need: 8 };
    default: return null;
  }
}

export function achievementById(id: string): AchievementDef | null {
  return ACHIEVEMENTS.find((a) => a.id === id) ?? null;
}

export function isUnlocked(id: string): boolean {
  return loadSettings().achievements.includes(id);
}

/** Открыть достижение; возвращает описание, если оно новое. */
export function unlockAchievement(id: string): AchievementDef | null {
  const def = achievementById(id);
  if (!def) return null;
  const s = loadSettings();
  if (s.achievements.includes(id)) return null;
  s.achievements = [...s.achievements, id];
  s.coins += def.reward;
  saveSettings({});
  try {
    platform.unlockAchievement?.(id);
  } catch {
    /* площадка без достижений */
  }
  return def;
}

// ===== ежедневная серия и неделя =====
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dayKey(d);
}

/** ISO-неделя: счётчик побед обнуляется при смене недели. */
export function weekKey(): string {
  const d = new Date();
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return dayKey(d);
}

export function refreshWeek(): number {
  const s = loadSettings();
  const key = weekKey();
  if (s.week_key !== key) {
    s.week_key = key;
    s.week_wins = 0;
    saveSettings({});
  }
  return s.week_wins;
}

export function weekWins(): number {
  return refreshWeek();
}

export function dailyStreak(): number {
  return loadSettings().daily_streak;
}

export function dailyRewardedToday(): boolean {
  return loadSettings().daily_last === dayKey();
}

/** Награда за завершённую ежедневную партию — один раз в день. */
export function claimDailyReward(): number {
  const s = loadSettings();
  const today = dayKey();
  if (s.daily_last === today) return 0;
  const streak = s.daily_last === yesterdayKey() ? s.daily_streak + 1 : 1;
  const bonus = 60 + Math.min(5, streak - 1) * 20;
  s.daily_last = today;
  s.daily_streak = streak;
  s.coins += bonus;
  saveSettings({});
  return bonus;
}

/** Сложность соперника в ежедневной партии: одинаковая для всех игроков. */
export const DAILY_BOT_LEVEL = 1;

/** Сколько монет дадут за сегодняшнюю ежедневную партию (без изменения). */
export function dailyRewardPreview(): number {
  const s = loadSettings();
  const streak = s.daily_last === yesterdayKey() ? s.daily_streak + 1 : 1;
  return 60 + Math.min(5, streak - 1) * 20;
}

// ===== ежедневный вход (чек-ин) =====
export const CHECKIN_DAYS = 7;

/** Бонус за день цикла 1…7: 20, 30, 40, 50, 60, 70, 80. */
export function checkinBonus(day: number): number {
  return 20 + (Math.max(1, Math.min(CHECKIN_DAYS, day)) - 1) * 10;
}

export function checkinCycleDay(streak: number): number {
  return ((Math.max(0, streak) - 1) % CHECKIN_DAYS) + 1;
}

export interface CheckinState {
  available: boolean;
  /** Всего дней подряд (включая сегодняшний, если он уже получен). */
  streak: number;
  /** Сколько дней текущего цикла уже закрыто (0…7). */
  completed: number;
  /** Номер сегодняшнего дня цикла (1…7). */
  todayDay: number;
  /** Сколько дадут за сегодняшний вход. */
  bonus: number;
}

export function checkinState(): CheckinState {
  const s = loadSettings();
  const available = s.checkin_last !== dayKey();
  const continued = s.checkin_last === yesterdayKey();
  const completed = available
    ? (continued ? s.checkin_streak % CHECKIN_DAYS : 0)
    : checkinCycleDay(s.checkin_streak);
  const day = available ? Math.min(CHECKIN_DAYS, completed + 1) : checkinCycleDay(s.checkin_streak);
  return {
    available,
    streak: s.checkin_streak,
    completed,
    todayDay: day,
    bonus: checkinBonus(day),
  };
}

/** Забрать ежедневный бонус. Возвращает награду и новые достижения. */
export function claimCheckin(): { coins: number; streak: number; unlocked: AchievementDef[] } | null {
  const s = loadSettings();
  const today = dayKey();
  if (s.checkin_last === today) return null;
  const streak = s.checkin_last === yesterdayKey() ? s.checkin_streak + 1 : 1;
  const bonus = checkinBonus(checkinCycleDay(streak));
  s.checkin_last = today;
  s.checkin_streak = streak;
  s.coins += bonus;
  saveSettings({});
  const unlocked: AchievementDef[] = [];
  const grant = (id: string): void => {
    const def = unlockAchievement(id);
    if (def) unlocked.push(def);
  };
  if (streak >= 3) grant('streak_3');
  if (streak >= 7) grant('streak_7');
  if (loadSettings().coins >= 1000) grant('rich_1000');
  return { coins: bonus, streak, unlocked };
}

/** Сид ежедневного расклада: одинаковый у всех игроков в этот день. */
export function dailySeed(): number {
  const key = dayKey();
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ===== монеты и покупки =====
export function coins(): number {
  return loadSettings().coins;
}

export function addCoins(n: number): number {
  const s = loadSettings();
  s.coins = Math.max(0, s.coins + Math.round(n));
  saveSettings({});
  if (s.coins >= 1000) unlockAchievement('rich_1000');
  return s.coins;
}

export function spendCoins(n: number): boolean {
  const s = loadSettings();
  if (s.coins < n) return false;
  s.coins -= n;
  saveSettings({});
  return true;
}

export interface ShopItem {
  id: string;
  kind: 'theme' | 'palette' | 'remove_ads' | 'bundle';
  title: string;
  desc: string;
  price: number;
  iapProduct?: string;
}

export const BUNDLE_ITEMS = ['royal', 'burgundy', 'amber', 'marble'];

export const SHOP_ITEMS: ShopItem[] = [
  { id: 'royal', kind: 'theme', title: 'Синий лорд', desc: 'Королевский синий', price: 300 },
  { id: 'burgundy', kind: 'theme', title: 'Бордо', desc: 'Винное сукно', price: 300 },
  { id: 'amber', kind: 'palette', title: 'Янтарь', desc: 'Медовые фишки', price: 250 },
  { id: 'marble', kind: 'palette', title: 'Мрамор', desc: 'Светлый камень', price: 250 },
  { id: 'color', kind: 'palette', title: 'Цветные', desc: 'Цветной фон, белые числа', price: 350 },
  {
    id: 'theme_pack', kind: 'bundle', title: 'Набор оформлений',
    desc: 'Все темы стола и фишек', price: 0, iapProduct: 'theme_pack',
  },
  { id: 'remove_ads', kind: 'remove_ads', title: 'Без рекламы', desc: 'Межстраничная реклама', price: 0, iapProduct: 'remove_ads' },
];

export function ownsItem(id: string): boolean {
  return loadSettings().owned_items.includes(id);
}

export function addOwned(id: string): void {
  const s = loadSettings();
  if (!s.owned_items.includes(id)) {
    s.owned_items = [...s.owned_items, id];
    saveSettings({});
  }
  if (s.owned_items.length >= 4) unlockAchievement('collector');
}

export function applyItem(id: string): void {
  if (id === 'emerald' || id === 'royal' || id === 'burgundy') {
    saveSettings({ table_theme: id });
  } else if (id === 'ivory' || id === 'amber' || id === 'marble' || id === 'color') {
    saveSettings({ tile_palette: id });
  } else if (id === 'remove_ads') {
    saveSettings({ ads_removed: true });
  }
}

/**
 * Снять выбранное оформление и вернуть базовое. Покупка при этом остаётся:
 * товар можно включить снова в любой момент.
 */
export function clearItem(id: string): void {
  if (id === 'royal' || id === 'burgundy') {
    if (loadSettings().table_theme === id) saveSettings({ table_theme: 'emerald' });
  } else if (id === 'amber' || id === 'marble' || id === 'color') {
    if (loadSettings().tile_palette === id) saveSettings({ tile_palette: 'ivory' });
  }
}

/** Восстановить постоянные покупки после перезапуска/смены устройства. */
export async function restorePurchases(): Promise<void> {
  try {
    const ids = await platform.getPurchases();
    for (const id of ids) {
      if (id === 'theme_pack') {
        for (const themeId of ['royal', 'burgundy', 'amber', 'marble']) {
          addOwned(themeId);
        }
        continue;
      }
      if (!SHOP_ITEMS.some((item) => item.id === id)) continue;
      addOwned(id);
      applyItem(id);
    }
  } catch {
    /* площадка без платежей */
  }
}

/**
 * Выдать достижения, которые можно подтвердить уже сохранённой статистикой.
 * Нужно игрокам, накопившим партии до появления достижений: иначе награда
 * выдавалась бы только после следующей завершённой партии.
 * Проверяем только те условия, которые реально хранятся в настройках.
 */
export function syncAchievements(): AchievementDef[] {
  const unlocked: AchievementDef[] = [];
  const grant = (id: string): void => {
    const def = unlockAchievement(id);
    if (def) unlocked.push(def);
  };
  // Победы и число партий.
  const wins = loadSettings().stat_wins;
  if (wins >= 1) grant('first_win');
  if (wins >= 5) grant('wins_5');
  if (wins >= 20) grant('wins_20');
  if (loadSettings().stat_games >= 10) grant('games_10');
  // Ежедневные партии: дата последней награды сохраняется.
  const s = loadSettings();
  if (s.daily_last !== '' || s.daily_streak > 0) grant('daily_play');
  // Ежедневные входы и лучшая серия.
  if (loadSettings().checkin_streak >= 3) grant('streak_3');
  if (loadSettings().checkin_streak >= 7) grant('streak_7');
  if (loadSettings().stat_best_run >= 8) grant('run_8');
  // Покупки в магазине.
  if (loadSettings().owned_items.length >= 4) grant('collector');
  // Богач — после остальных наград: они тоже добавляют монеты.
  if (loadSettings().coins >= 1000) grant('rich_1000');
  return unlocked;
}

// ===== итоги партии =====
export interface GameEndInfo {
  won: boolean;
  players: number;
  seconds: number;
  mode: 'classic' | 'quick' | 'timed' | 'daily' | 'puzzle';
  usedHint: boolean;
  usedJoker: boolean;
  maxTurnTiles: number;
}

export interface GameEndReward {
  coins: number;
  unlocked: AchievementDef[];
}

/** Начислить монеты и достижения за завершённую партию. */
export function onGameEnd(info: GameEndInfo): GameEndReward {
  const s = loadSettings();
  refreshWeek();
  const base = info.won ? 60 : 20;
  const modeBonus = info.mode === 'classic' ? 0 : 20;
  const unlocked: AchievementDef[] = [];
  const grant = (id: string): void => {
    const def = unlockAchievement(id);
    if (def) unlocked.push(def);
  };
  s.coins += base + modeBonus;
  if (info.won) s.week_wins += 1;
  saveSettings({});

  if (s.stat_wins >= 1) grant('first_win');
  if (s.stat_wins >= 5) grant('wins_5');
  if (s.stat_wins >= 20) grant('wins_20');
  if (s.stat_games >= 10) grant('games_10');
  if (info.players >= 4) grant('four_players');
  if (info.usedJoker) grant('joker_use');
  if (info.maxTurnTiles >= 5) grant('combo_5');
  if (info.won && info.seconds > 0 && info.seconds < 300) grant('fast_win');
  if (info.won && !info.usedHint) grant('no_hint_win');
  if (info.won && (info.mode === 'quick' || info.mode === 'timed')) grant('quick_win');
  if (info.mode === 'daily') grant('daily_play');
  if (info.mode === 'puzzle' && info.won) grant('puzzle_solve');
  if (s.coins >= 1000) grant('rich_1000');
  return { coins: base + modeBonus, unlocked };
}
