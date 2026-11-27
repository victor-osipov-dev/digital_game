import { platform } from '../platform';

// Слой сохранений поверх платформенного storage (Playgama Bridge storage —
// требование 3.2.1: сейвы только через Bridge, одним get на старте и
// батчами при записи; на остальных площадках — localStorage).
//
// Модель: синхронный кэш в памяти + отложенная батч-запись. preloadPersist()
// вызывается в main.ts ДО loadSettings(), поэтому все синхронные читатели
// (settings, api, servers, online_lobby) видят актуальные значения.

export const PERSIST_KEYS: string[] = [
  'dg.settings',
  'dg.token',
  'dg.nick',
  'dg.login',
  'dg.pass',
  'dg.pending_server',
  'dg.devHost',
  'dg.ya_auth_uid',
];

const memory = new Map<string, string>();
// Очередь изменений: true — записать, false — удалить.
const dirty = new Map<string, boolean>();
let flushTimer: number | null = null;
const FLUSH_DELAY_MS = 400;

function localValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Прочитать все ключи одним вызовом платформы (Bridge storage.get). */
export async function preloadPersist(): Promise<void> {
  try {
    const values = await platform.storageGet(PERSIST_KEYS);
    for (const key of PERSIST_KEYS) {
      const value = values[key];
      if (value === null || value === undefined) {
        // Площадочное хранилище пусто (SDK не загрузился/новый ключ) —
        // не теряем локальный прогресс.
        const local = localValue(key);
        if (local === null) memory.delete(key);
        else memory.set(key, local);
      } else memory.set(key, value);
    }
  } catch {
    // Нет данных — стартуем как новый игрок; запись всё равно сработает.
  }
}

/** Синхронное чтение из кэша (null — ключа нет). */
export function persistGet(key: string): string | null {
  return memory.get(key) ?? null;
}

export function persistSet(key: string, value: string): void {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* приватный режим/квота — платформа всё равно получит значение */
  }
  schedule(key, true);
}

export function persistRemove(key: string): void {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  schedule(key, false);
}

function schedule(key: string, write: boolean): void {
  dirty.set(key, write);
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushPersist();
  }, FLUSH_DELAY_MS);
}

/** Слить накопленные изменения одним батчем (bridge.storage.set/delete). */
export async function flushPersist(): Promise<void> {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (dirty.size === 0) return;
  const entries: Record<string, string> = {};
  const removeKeys: string[] = [];
  for (const [key, write] of dirty) {
    if (write) entries[key] = memory.get(key) ?? '';
    else removeKeys.push(key);
  }
  dirty.clear();
  const hasWrites = Object.keys(entries).length > 0;
  await Promise.all([
    hasWrites ? platform.storageSet(entries) : Promise.resolve(),
    removeKeys.length > 0 ? platform.storageDelete(removeKeys) : Promise.resolve(),
  ]).catch(() => undefined);
}

// Вкладка скрыта/закрывается — сбрасываем очередь немедленно, чтобы прогресс
// не потерялся (между дебаунсом и реальной записью было до 400 мс).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void flushPersist();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flushPersist());
}
