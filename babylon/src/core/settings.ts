import { getLang, LangCode, setLang, t } from './lang';
import { getPlatformInterfaceLang } from '../platform';

const KEY = 'dg.settings';
// Версия схемы настроек. v2: локальный дефолт — один человек против ботов,
// а статистика разделена на локальную и сетевую (серверную).
const SETTINGS_VERSION = 2;

export type { LangCode };

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;
// Максимальная длина имени игрока/ника — как на сервере (checkNick: 24).
export const MAX_NAME_LEN = 24;

// Лестница масштабов: маленький — ровно прежний ×1.0, большой — ×2.
export const TEXT_SCALES = [1.0, 1.3, 2.0];
export const FS_MIN = 12;
export const TILE_WIDTHS = [32, 40, 48, 60, 66, 72];
export const BOT_LEVEL_NAMES = ['Лёгкий', 'Средний', 'Сложный', 'Невозможный'];

export const TEXT_SCALE_NAMES = ['Маленький', 'Средний', 'Большой'];
export const TILE_SIZE_NAMES = ['Крошечный', 'Маленький', 'Средний', 'Крупный', 'Большой', 'Максимум'];

export interface Settings {
  lang: LangCode;
  sound: boolean;
  player_count: number;
  require_30: boolean;
  player_names: string[];
  player_is_bot: boolean[];
  text_scale: number;
  tile_step: number;
  bot_level: number;
  bot_anim: boolean;
  stat_games: number;
  stat_wins: number;
  stat_losses: number;
  settings_version: number;
}

function clampi(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function defaults(): Settings {
  // Godot: дефолт жёстко «ru» (авто-язык был только из SDK Яндекс Игр).
  return {
    lang: 'ru' as LangCode,
    sound: true,
    player_count: MIN_PLAYERS,
    require_30: false,
    player_names: [t('Игрок %d', 1), t('Игрок %d', 2)],
    // По умолчанию один живой игрок против бота. Дополнительные места,
    // которые добавляет setPlayerCount, тоже становятся ботами.
    player_is_bot: [false, true],
    text_scale: 1,
    tile_step: 5,
    bot_level: 2,
    bot_anim: true,
    stat_games: 0,
    stat_wins: 0,
    stat_losses: 0,
    settings_version: SETTINGS_VERSION,
  };
}

let cache: Settings | null = null;

export function loadSettings(): Settings {
  if (cache) return cache;
  let parsed: any = {};
  try {
    parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as any;
  } catch {
    parsed = {};
  }
  // Язык применяем ДО defaults(): имена игроков по умолчанию создаются
  // через t() и должны быть на выбранном языке, а не на стартовом русском.
  // Для первого запуска (сохранений ещё нет) дефолт берём из языка
  // интерфейса площадки (требование Яндекс Игр 2.14); ручная настройка
  // всегда приоритетнее.
  const storedLang = parsed.lang === 'en' || parsed.lang === 'ru' ? parsed.lang : null;
  const platformLang = getPlatformInterfaceLang() === 'en' ? 'en' : null;
  const lang = storedLang ?? platformLang ?? 'ru';
  setLang(lang);
  const d = defaults();
  const playerCount = clampi(Number(parsed.player_count ?? d.player_count), MIN_PLAYERS, MAX_PLAYERS);
  let playerIsBot: boolean[] = Array.isArray(parsed.player_is_bot)
    ? parsed.player_is_bot.map((v: unknown) => Boolean(v))
    : [...d.player_is_bot];
  // Миграция старых сохранений: раньше дефолтом были два человека.
  // Теперь локальная игра по умолчанию — первый игрок против ботов.
  // Осознанную настройку «все люди» после v2 не трогаем.
  const version = Number(parsed.settings_version ?? 1);
  if (version < 2 && playerIsBot.length > 0 && playerIsBot.every((isBot) => !isBot)) {
    playerIsBot = Array.from({ length: playerCount }, (_, i) => i > 0);
  }
  const s: Settings = {
    lang,
    sound: typeof parsed.sound === 'boolean' ? parsed.sound : d.sound,
    player_count: playerCount,
    require_30: typeof parsed.require_30 === 'boolean' ? parsed.require_30 : d.require_30,
    player_names: Array.isArray(parsed.player_names) ? parsed.player_names.map(String) : [...d.player_names],
    player_is_bot: playerIsBot,
    text_scale: clampi(Number(parsed.text_scale ?? d.text_scale), 0, TEXT_SCALES.length - 1),
    tile_step: clampi(Number(parsed.tile_step ?? d.tile_step), 0, TILE_WIDTHS.length - 1),
    bot_level: clampi(Number(parsed.bot_level ?? d.bot_level), 0, BOT_LEVEL_NAMES.length - 1),
    bot_anim: typeof parsed.bot_anim === 'boolean' ? parsed.bot_anim : d.bot_anim,
    stat_games: Math.max(0, Number(parsed.stat_games ?? 0)),
    stat_wins: Math.max(0, Number(parsed.stat_wins ?? 0)),
    stat_losses: Math.max(0, Number(parsed.stat_losses ?? 0)),
    settings_version: SETTINGS_VERSION,
  };
  cache = s;
  fixup();
  applyLang(s.lang);
  return s;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const s = { ...loadSettings(), ...patch };
  cache = s;
  fixup();
  localStorage.setItem(KEY, JSON.stringify(s));
  applyLang(s.lang);
  return s;
}

function fixup(): void {
  const s = cache!;
  while (s.player_names.length < s.player_count) {
    s.player_names.push(t('Игрок %d', s.player_names.length + 1));
  }
  while (s.player_names.length > s.player_count) s.player_names.pop();
  // Новые места (после увеличения числа игроков) — по умолчанию боты,
  // чтобы локальная игра оставалась «один человек против ботов».
  while (s.player_is_bot.length < s.player_count) s.player_is_bot.push(true);
  while (s.player_is_bot.length > s.player_count) s.player_is_bot.pop();
}

function applyLang(code: LangCode): void {
  if (getLang() !== code) setLang(code);
}

// Размер шрифта: база × шкала, но не ниже читаемого минимума.
export function fs(base: number): number {
  const s = loadSettings();
  const idx = clampi(s.text_scale, 0, TEXT_SCALES.length - 1);
  return Math.max(FS_MIN, Math.round(base * TEXT_SCALES[idx]));
}

// Тот же размер с потолком по шкале («Средний» — cap 1).
export function fsCapped(base: number, capScale: number): number {
  const s = loadSettings();
  const idx = clampi(Math.min(s.text_scale, capScale), 0, TEXT_SCALES.length - 1);
  return Math.max(FS_MIN, Math.round(base * TEXT_SCALES[idx]));
}

// Размер интерактивного контроля, растёт со шкалой текста.
export function touch(base: number): number {
  const s = loadSettings();
  const idx = clampi(s.text_scale, 0, TEXT_SCALES.length - 1);
  return Math.max(1, Math.round(base * TEXT_SCALES[idx]));
}

export function touchCapped(base: number, capScale: number): number {
  const s = loadSettings();
  const idx = clampi(Math.min(s.text_scale, capScale), 0, TEXT_SCALES.length - 1);
  return Math.max(1, Math.round(base * TEXT_SCALES[idx]));
}

// Ширина контрола с потолком по ширине окна (44%).
export function touchW(base: number, vw?: number): number {
  const w = touch(base);
  const view = vw ?? (typeof window !== 'undefined' ? window.innerWidth : 576);
  return Math.min(w, Math.floor(view * 0.44));
}

// Размер фишки: idx 0 — квадрат, остальные — высота ×1.4.
export function tileSize(): { x: number; y: number } {
  const s = loadSettings();
  const idx = clampi(s.tile_step, 0, TILE_WIDTHS.length - 1);
  const w = TILE_WIDTHS[idx];
  if (idx === 0) return { x: w, y: w };
  return { x: w, y: Math.round(w * 1.4 * 100) / 100 };
}

export function isBot(index: number): boolean {
  const s = loadSettings();
  if (index < 0 || index >= s.player_is_bot.length) return false;
  return s.player_is_bot[index];
}

export function setBot(index: number, value: boolean): void {
  const s = loadSettings();
  if (index >= 0 && index < s.player_is_bot.length) {
    s.player_is_bot[index] = value;
    saveSettings({});
  }
}

export function setPlayerCount(n: number): void {
  const s = loadSettings();
  s.player_count = clampi(n, MIN_PLAYERS, MAX_PLAYERS);
  saveSettings({});
}

export function setPlayerName(index: number, value: string): void {
  const s = loadSettings();
  if (index >= 0 && index < s.player_names.length) {
    const cleaned = value.trim().slice(0, MAX_NAME_LEN);
    s.player_names[index] = cleaned !== '' ? cleaned : t('Игрок %d', index + 1);
    saveSettings({});
  }
}

export function setLanguage(code: LangCode): void {
  saveSettings({ lang: code === 'en' ? 'en' : 'ru' });
}

// Локальная статистика: только партии «один человек против ботов».
// Игра засчитывается в момент запуска, а победа/поражение — по её итогу.
// Hot-seat (два и более человека на одном устройстве) сюда не попадает,
// сетевые партии считает сервер и в локальные счётчики они не входят.
export function recordLocalGameStarted(): void {
  const s = loadSettings();
  s.stat_games += 1;
  saveSettings({});
}

export function recordLocalGameResult(won: boolean): void {
  const s = loadSettings();
  if (won) s.stat_wins += 1;
  else s.stat_losses += 1;
  saveSettings({});
}
