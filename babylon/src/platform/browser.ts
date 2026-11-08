// Общие браузерные примитивы для площадок без собственного API:
// полноэкранный режим и буфер обмена. Все функции безопасны: никогда не
// бросают исключение и корректно работают в окружении без DOM (тесты).

type FullscreenDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  msFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  msRequestFullscreen?: () => Promise<void> | void;
};

function doc(): FullscreenDocument | null {
  try {
    return typeof document === 'undefined' ? null : (document as FullscreenDocument);
  } catch {
    return null;
  }
}

/** Поддерживает ли браузер программный полноэкранный режим. */
export function browserFullscreenAvailable(): boolean {
  const d = doc();
  if (!d) return false;
  try {
    return Boolean(d.fullscreenEnabled ?? d.webkitFullscreenEnabled ?? d.msFullscreenEnabled);
  } catch {
    return false;
  }
}

/** Активен ли сейчас полноэкранный режим браузера. */
export function browserIsFullscreen(): boolean {
  const d = doc();
  if (!d) return false;
  try {
    return Boolean(d.fullscreenElement ?? d.webkitFullscreenElement ?? d.msFullscreenElement);
  } catch {
    return false;
  }
}

/** Выйти из полноэкранного режима браузера; false — уже не на весь экран. */
export async function browserExitFullscreen(): Promise<boolean> {
  const d = doc();
  if (!d) return false;
  try {
    if (browserIsFullscreen()) {
      const exit = d.exitFullscreen ?? d.webkitExitFullscreen ?? d.msExitFullscreen;
      await exit?.call(d);
    }
  } catch {
    /* браузер запретил выход без жеста — вернём фактический статус */
  }
  return browserIsFullscreen();
}

/**
 * Переключить полноэкранный режим браузера. Браузер может отклонить запрос
 * (нет жеста пользователя, iframe без allowfullscreen) — тогда просто
 * возвращаем фактическое состояние.
 */
export async function browserToggleFullscreen(): Promise<boolean> {
  const d = doc();
  if (!d) return false;
  try {
    if (browserIsFullscreen()) {
      const exit = d.exitFullscreen ?? d.webkitExitFullscreen ?? d.msExitFullscreen;
      await exit?.call(d);
    } else {
      const el = (d.documentElement ?? null) as FullscreenElement | null;
      if (el) {
        const request = el.requestFullscreen ?? el.webkitRequestFullscreen ?? el.msRequestFullscreen;
        await request?.call(el);
      }
    }
  } catch {
    /* смена режима запрещена без жеста — вернём фактический статус ниже */
  }
  return browserIsFullscreen();
}

/** Записать текст в буфер обмена (Clipboard API, затем execCommand-фолбэк). */
export async function browserWriteClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* нет разрешения или не secure context — пробуем фолбэк ниже */
  }
  const d = doc();
  if (!d || !d.body) return false;
  try {
    const ta = d.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    d.body.appendChild(ta);
    ta.select();
    const ok = d.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
