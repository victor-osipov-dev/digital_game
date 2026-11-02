// Простой DOM-тост поверх canvas. Babylon-тост есть только на игровом
// экране, а действия площадки (оценка, ярлык, копирование кода комнаты)
// доступны и в меню/лобби. Тост не перехватывает указатель и не мешает игре.
let host: HTMLDivElement | null = null;
let hideTimer: number | null = null;

export function showDomToast(text: string): void {
  if (typeof document === 'undefined' || !text) return;
  try {
    if (!host) {
      host = document.createElement('div');
      host.id = 'dg-toast';
      host.setAttribute('role', 'status');
      host.style.cssText =
        'position:fixed;left:50%;bottom:12%;transform:translateX(-50%);' +
        'max-width:min(88vw,460px);padding:12px 18px;border-radius:10px;' +
        'background:rgba(20,24,32,0.94);color:#FFE0B2;' +
        'border:1px solid rgba(255,213,79,0.5);' +
        'font:15px/1.35 Arial,sans-serif;text-align:center;pointer-events:none;' +
        'z-index:9000;opacity:0;transition:opacity .18s ease;';
      document.body.appendChild(host);
    }
    host.textContent = text;
    host.style.opacity = '1';
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (host) host.style.opacity = '0';
      hideTimer = null;
    }, 2600);
  } catch {
    /* ignore */
  }
}
