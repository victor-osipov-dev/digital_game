// Прогресс игрока: локальные настройки/статистика + облако площадки.
//
// Сохранение остаётся в localStorage (мгновенно и без сети), но дополнительно
// уходит в платформенное хранилище (Яндекс, GamePush, CrazyGames, YouTube).
// При запуске сравниваем метки saved_at и берём более свежую копию — так
// прогресс восстанавливается на другом устройстве, а офлайн-игра не ломается.

import { platform } from '../platform';

const SETTINGS_KEY = 'dg.settings';
const PROGRESS_VERSION = 1;

function localSavedAt(): number {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
    const value = Number(parsed?.saved_at ?? 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** Загрузить облачный прогресс, если он свежее локального. */
export async function loadProgress(): Promise<void> {
  try {
    // Жёсткий лимит: Game Ready не должен ждать медленное облако.
    const remote = await Promise.race([
      platform.loadProgress(),
      new Promise<null>((resolve) => {
        try {
          window.setTimeout(() => resolve(null), 1500);
        } catch {
          resolve(null);
        }
      }),
    ]);
    if (!remote) return;
    const data = remote.data ?? {};
    const settings = data.settings;
    if (!settings || typeof settings !== 'object') return;
    const remoteSavedRaw = Number(data.saved_at ?? remote.savedAt ?? 0);
    const remoteSaved = Number.isFinite(remoteSavedRaw) ? remoteSavedRaw : 0;
    if (remoteSaved <= 0 || remoteSaved <= localSavedAt()) return;
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ ...(settings as Record<string, unknown>), saved_at: remoteSaved }),
      );
    } catch {
      /* localStorage запрещён — облако всё равно не применить к настройкам */
    }
  } catch {
    /* нет облака/сети — играем на локальных данных */
  }
}

let timer: number | null = null;
let pending: Record<string, unknown> | null = null;

function writeRemote(data: Record<string, unknown>): void {
  try {
    void platform.saveProgress(data).catch(() => false);
  } catch {
    /* платформа не поддерживает сохранения */
  }
}

/** Отложенная запись прогресса (не чаще одного раза в 600 мс). */
export function scheduleProgressSave(settings: Record<string, unknown>): void {
  pending = settings;
  if (timer !== null) return;
  try {
    timer = window.setTimeout(() => {
      timer = null;
      const data = pending;
      pending = null;
      if (data) writeRemote(data);
    }, 600);
  } catch {
    timer = null;
    writeRemote(settings);
  }
}

/**
 * Немедленно записать накопленный прогресс. Вызывается при уходе со страницы
 * и платформенной паузе (YouTube даёт короткое окно на сохранение).
 */
export function flushProgress(): void {
  if (timer !== null) {
    try {
      window.clearTimeout(timer);
    } catch {
      /* ignore */
    }
    timer = null;
  }
  const data = pending;
  pending = null;
  if (data) writeRemote(data);
}

/** Собрать актуальный снимок локальных настроек для облака. */
export function currentProgressSnapshot(): Record<string, unknown> {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    settings = {};
  }
  const savedAt = Date.now();
  return { version: PROGRESS_VERSION, saved_at: savedAt, settings };
}
