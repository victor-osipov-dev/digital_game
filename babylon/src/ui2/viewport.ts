// Размер игрового поля берём у canvas, а не у window.
//
// Игру встраивают в iframe/контейнер и открывают на весь экран: при этом
// меняется размер самого canvas, а окно сайта может остаться прежним.
// Если строить UI по window.innerWidth/innerHeight, после fullscreen он
// остаётся «маленьким» и обрезанным. clientWidth/clientHeight всегда дают
// фактический CSS-размер игрового поля.
function gameCanvas(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById('canvas');
  return el instanceof HTMLCanvasElement ? el : null;
}

export function viewWidth(): number {
  const width = gameCanvas()?.clientWidth ?? 0;
  if (width > 0) return width;
  return typeof window === 'undefined' ? 0 : window.innerWidth;
}

export function viewHeight(): number {
  const height = gameCanvas()?.clientHeight ?? 0;
  if (height > 0) return height;
  return typeof window === 'undefined' ? 0 : window.innerHeight;
}
