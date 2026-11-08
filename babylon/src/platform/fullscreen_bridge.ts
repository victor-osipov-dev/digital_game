// Мост с родительской страницей сайта (fimdi).
//
// Игра может быть встроена во фрейм (например, rudigitalgame.fimdi.ru),
// и тогда полноэкранным режимом управляет РОДИТЕЛЬ, а не сама игра: из
// фрейма `document.fullscreenElement` не виден, и выйти тоже нельзя.
// Родитель сообщает о смене режима сообщением:
//
//   window.parent.postMessage(
//     { source: 'fimdi', type: 'fullscreenchange', fullscreen: true },
//     '*',
//   );
//
// Игра запоминает это состояние (его использует platform.isFullscreen) и
// пересчитывает компоновку. Наоборот, игра может попросить родителя выйти
// из полноэкранного режима — requestParentFullscreen(false).
//
// Безопасность: сообщение лишь отражает состояние UI и запускает relayout;
// никаких команд по нему не выполняется, поэтому источник не проверяется.

const FIMDI_SOURCE = 'fimdi';
const GAME_SOURCE = 'game';
const FULLSCREEN_CHANGE = 'fullscreenchange';

interface FimdiFullscreenMessage {
  source: typeof FIMDI_SOURCE;
  type: typeof FULLSCREEN_CHANGE;
  fullscreen: boolean;
}

function parseFimdiMessage(data: unknown): FimdiFullscreenMessage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.source !== FIMDI_SOURCE) return null;
  if (d.type !== FULLSCREEN_CHANGE) return null;
  if (typeof d.fullscreen !== 'boolean') return null;
  return { source: FIMDI_SOURCE, type: FULLSCREEN_CHANGE, fullscreen: d.fullscreen };
}

let reported: boolean | null = null;
let installed = false;
const listeners = new Set<(fullscreen: boolean) => void>();

/** Установить обработчик сообщений родителя (один раз за сеанс). */
export function installFullscreenBridge(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('message', (event: MessageEvent) => {
    const msg = parseFimdiMessage(event.data);
    if (!msg) return;
    reported = msg.fullscreen;
    for (const cb of [...listeners]) {
      try {
        cb(msg.fullscreen);
      } catch {
        /* подписчик не должен ломать обработку сообщения */
      }
    }
    // Смена полноэкранного режима у родителя меняет размер фрейма —
    // просим приложение пересчитать компоновку.
    try {
      window.dispatchEvent(new Event('resize'));
    } catch {
      /* ignore */
    }
  });
}

/** Последнее сообщённое родителем состояние: null — ещё не сообщал. */
export function reportedFullscreenState(): boolean | null {
  return reported;
}

/** Подписка на смену полноэкранного режима, о которой сообщил родитель. */
export function onReportedFullscreen(cb: (fullscreen: boolean) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Попросить родителя включить/выключить полноэкранный режим. Работает только
 * внутри фрейма; на отдельной странице — безопасный no-op.
 */
export function requestParentFullscreen(fullscreen: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (window.self === window.top) return;
    window.parent.postMessage({ source: GAME_SOURCE, type: 'fullscreen', fullscreen }, '*');
  } catch {
    /* кросс-доменный родитель: сообщение не доставить — это не ошибка */
  }
}
