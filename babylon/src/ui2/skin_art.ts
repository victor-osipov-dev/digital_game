// Процедурный арт интерфейса: сукно стола, деревянная рама, объёмные
// фишки и аватары ботов. Всё рисуется на canvas один раз и кэшируется
// в data-URL — во сборке нет внешних картинок, а стиль остаётся единым.

import { colorHex, TileFace } from '../core/tile';

const TILE_W = 160;
const TILE_H = 224;

const cache = new Map<string, string>();

function mk(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  return { c, ctx };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function shade(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, Math.min(255, Math.round(lerp((n >> 16) & 255, amount > 0 ? 255 : 0, Math.abs(amount)))));
  const g = Math.max(0, Math.min(255, Math.round(lerp((n >> 8) & 255, amount > 0 ? 255 : 0, Math.abs(amount)))));
  const b = Math.max(0, Math.min(255, Math.round(lerp(n & 255, amount > 0 ? 255 : 0, Math.abs(amount)))));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export interface TableTheme {
  id: string;
  feltTop: string;
  feltBottom: string;
  feltLight: string;
  rimTop: string;
  rimBottom: string;
  rimDark: string;
  lane: string;
  laneBorder: string;
  roomTop: string;
  roomBottom: string;
  accent: string;
}

// Темы стола. В магазине открываются покупкой; пока доступна базовая.
export const TABLE_THEMES: TableTheme[] = [
  {
    id: 'emerald',
    feltTop: '#2A7350',
    feltBottom: '#123A28',
    feltLight: '#3C8A62',
    rimTop: '#6B4226',
    rimBottom: '#3B2113',
    rimDark: '#241108',
    lane: 'rgba(8, 30, 19, 0.34)',
    laneBorder: 'rgba(255, 246, 214, 0.16)',
    roomTop: '#171B18',
    roomBottom: '#0A0D0B',
    accent: '#F5D06B',
  },
  {
    id: 'royal',
    feltTop: '#2B4E86',
    feltBottom: '#122544',
    feltLight: '#3E6BA8',
    rimTop: '#5A3A26',
    rimBottom: '#2E1B0F',
    rimDark: '#1B0F07',
    lane: 'rgba(6, 18, 36, 0.36)',
    laneBorder: 'rgba(220, 235, 255, 0.16)',
    roomTop: '#131722',
    roomBottom: '#080A10',
    accent: '#FFD86B',
  },
  {
    id: 'burgundy',
    feltTop: '#7A2A34',
    feltBottom: '#3A0F16',
    feltLight: '#9A3E4A',
    rimTop: '#5E3A22',
    rimBottom: '#301A0E',
    rimDark: '#1C0E06',
    lane: 'rgba(38, 6, 12, 0.34)',
    laneBorder: 'rgba(255, 226, 206, 0.16)',
    roomTop: '#1D1516',
    roomBottom: '#0C0809',
    accent: '#FFD98A',
  },
];

export function themeById(id: string | null | undefined): TableTheme {
  return TABLE_THEMES.find((th) => th.id === id) ?? TABLE_THEMES[0];
}

// ===== сукно =====
function paintFelt(ctx: CanvasRenderingContext2D, theme: TableTheme, ox: number, oy: number, W: number, H: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, W, H);
  ctx.clip();

  const g = ctx.createLinearGradient(ox, oy, ox + W * 0.35, oy + H);
  g.addColorStop(0, theme.feltTop);
  g.addColorStop(1, theme.feltBottom);
  ctx.fillStyle = g;
  ctx.fillRect(ox, oy, W, H);

  // Мягкий свет от верхнего левого угла.
  const light = ctx.createRadialGradient(ox + W * 0.28, oy + H * 0.12, 8, ox + W * 0.28, oy + H * 0.12, Math.max(W, H) * 0.95);
  light.addColorStop(0, `${theme.feltLight}66`);
  light.addColorStop(0.55, `${theme.feltLight}1A`);
  light.addColorStop(1, '#00000000');
  ctx.fillStyle = light;
  ctx.fillRect(ox, oy, W, H);

  // Ворс: мелкие точки и короткие волокна.
  let seed = 1337 + Math.round(W + H);
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const dots = Math.min(26000, Math.round(W * H * 0.09));
  for (let i = 0; i < dots; i += 1) {
    const x = ox + rnd() * W;
    const y = oy + rnd() * H;
    const a = 0.02 + rnd() * 0.05;
    ctx.fillStyle = rnd() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.5})`;
    const s = rnd() > 0.9 ? 1.6 : 1;
    ctx.fillRect(x, y, s, s);
  }
  const fibers = Math.min(2200, Math.round(W * H * 0.006));
  for (let i = 0; i < fibers; i += 1) {
    const x = ox + rnd() * W;
    const y = oy + rnd() * H;
    const len = 2 + rnd() * 7;
    ctx.strokeStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rnd() - 0.5) * 2);
    ctx.stroke();
  }

  // Виньетка по краям.
  const vig = ctx.createRadialGradient(ox + W / 2, oy + H / 2, Math.min(W, H) * 0.2, ox + W / 2, oy + H / 2, Math.max(W, H) * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(0.7, 'rgba(0,0,0,0.18)');
  vig.addColorStop(1, 'rgba(0,0,0,0.52)');
  ctx.fillStyle = vig;
  ctx.fillRect(ox, oy, W, H);
  ctx.restore();
}

export function feltTexture(theme: TableTheme, w: number, h: number): string {
  const W = Math.max(64, Math.min(1600, Math.round(w / 24) * 24));
  const H = Math.max(64, Math.min(1600, Math.round(h / 24) * 24));
  const key = `felt:${theme.id}:${W}x${H}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { c, ctx } = mk(W, H);
  paintFelt(ctx, theme, 0, 0, W, H);
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

// Мат стола целиком: деревянная рама, сукно и внутренняя тень.
// Рисуется под столом одной картинкой — так проще и дешевле, чем
// собирать рамку из четырёх панелей.
export function tableMatTexture(theme: TableTheme, w: number, h: number, inset = 14): string {
  const W = Math.max(200, Math.min(1920, Math.round(w / 24) * 24));
  const H = Math.max(140, Math.min(1400, Math.round(h / 24) * 24));
  const key = `mat:${theme.id}:${W}x${H}:${inset}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { c, ctx } = mk(W, H);
  // Скруглённые углы всего стола: вне радиуса остаётся прозрачный фон.
  const outerR = Math.max(10, Math.min(24, Math.round(Math.min(W, H) * 0.035)));
  ctx.clearRect(0, 0, W, H);
  roundRect(ctx, 0, 0, W, H, outerR);
  ctx.clip();

  // Дерево по всему периметру.
  const wood = ctx.createLinearGradient(0, 0, 0, H);
  wood.addColorStop(0, theme.rimTop);
  wood.addColorStop(0.45, theme.rimBottom);
  wood.addColorStop(1, theme.rimDark);
  ctx.fillStyle = wood;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < Math.max(6, Math.round(H / 8)); i += 1) {
    const off = (i / Math.max(6, Math.round(H / 8))) * H;
    const alpha = 0.04 + ((i * 37) % 11) / 120;
    ctx.strokeStyle = i % 2 === 0 ? `rgba(255,226,190,${alpha})` : `rgba(0,0,0,${alpha * 1.5})`;
    ctx.lineWidth = 0.8 + (i % 3) * 0.5;
    ctx.beginPath();
    for (let p = 0; p <= W; p += 14) {
      const y = off + Math.sin(p * 0.02 + i) * 2.2 + Math.sin(p * 0.007 + i * 2) * 1.6;
      if (p === 0) ctx.moveTo(p, y);
      else ctx.lineTo(p, y);
    }
    ctx.stroke();
  }

  const x = inset;
  const y = inset;
  const fw = W - inset * 2;
  const fh = H - inset * 2;
  const r = 16;

  // Внутренняя тень от рамы на сукне.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 3;
  roundRect(ctx, x, y, fw, fh, r);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, x, y, fw, fh, r);
  ctx.clip();
  paintFelt(ctx, theme, x, y, fw, fh);
  // Лёгкий блик по верхней кромке сукна.
  const sheen = ctx.createLinearGradient(0, y, 0, y + fh * 0.22);
  sheen.addColorStop(0, 'rgba(255,255,255,0.09)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, fw, fh * 0.22);
  ctx.restore();

  // Тёмный кант вокруг сукна.
  roundRect(ctx, x + 0.5, y + 0.5, fw - 1, fh - 1, r);
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 2;
  ctx.stroke();
  roundRect(ctx, x + 2, y + 2, fw - 4, fh - 4, r - 1);
  ctx.strokeStyle = 'rgba(255,244,220,0.10)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Фаска по внешнему скруглённому краю деревянной рамы.
  roundRect(ctx, 1.5, 1.5, W - 3, H - 3, Math.max(1, outerR - 2));
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
  roundRect(ctx, 3, 3, W - 6, H - 6, Math.max(1, outerR - 3));
  ctx.strokeStyle = 'rgba(255,236,205,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

// ===== дерево =====
export function woodTexture(theme: TableTheme, w: number, h: number, vertical = false, corner = 0): string {
  const W = Math.max(32, Math.min(1200, Math.round(w / 16) * 16));
  const H = Math.max(32, Math.min(1200, Math.round(h / 16) * 16));
  const rad = Math.max(0, Math.min(Math.round(corner), Math.floor(Math.min(W, H) / 2)));
  const key = `wood:${theme.id}:${W}x${H}:${vertical ? 'v' : 'h'}:${rad}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { c, ctx } = mk(W, H);
  if (rad > 0) {
    // Скруглённая доска: всё, что вне радиуса, остаётся прозрачным.
    roundRect(ctx, 0, 0, W, H, rad);
    ctx.clip();
  }
  const len = vertical ? H : W;
  const thick = vertical ? W : H;
  const g = vertical
    ? ctx.createLinearGradient(0, 0, W, 0)
    : ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, theme.rimTop);
  g.addColorStop(0.55, theme.rimBottom);
  g.addColorStop(1, theme.rimDark);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  let seed = 7331;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  // Волокна вдоль доски.
  const lines = Math.max(8, Math.round(thick / 3));
  for (let i = 0; i < lines; i += 1) {
    const off = (i / lines) * thick + (rnd() - 0.5) * 4;
    const amp = 1 + rnd() * 3;
    const alpha = 0.05 + rnd() * 0.12;
    ctx.strokeStyle = rnd() > 0.5 ? `rgba(255,225,190,${alpha})` : `rgba(0,0,0,${alpha * 1.4})`;
    ctx.lineWidth = 0.6 + rnd() * 1.4;
    ctx.beginPath();
    for (let p = 0; p <= len; p += 8) {
      const wobble = Math.sin(p * 0.035 + i * 1.7) * amp + Math.sin(p * 0.011 + i) * amp * 1.6;
      const x = vertical ? off + wobble : p;
      const y = vertical ? p : off + wobble;
      if (p === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Светлая кромка сверху/слева.
  const edge = vertical
    ? ctx.createLinearGradient(0, 0, W * 0.4, 0)
    : ctx.createLinearGradient(0, 0, 0, H * 0.4);
  edge.addColorStop(0, 'rgba(255,236,205,0.22)');
  edge.addColorStop(1, 'rgba(255,236,205,0)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, W, H);

  if (rad > 0) {
    // Мягкая фаска по скруглённому краю доски.
    roundRect(ctx, 1.5, 1.5, W - 3, H - 3, Math.max(1, rad - 2));
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    roundRect(ctx, 3, 3, W - 6, H - 6, Math.max(1, rad - 3));
    ctx.strokeStyle = 'rgba(255,236,205,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

// Фон «комнаты»: тёмный градиент с мягким светом над столом.
export function roomTexture(w: number, h: number): string {
  const W = Math.max(64, Math.min(1920, Math.round(w / 32) * 32));
  const H = Math.max(64, Math.min(1200, Math.round(h / 32) * 32));
  const key = `room:${W}x${H}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { c, ctx } = mk(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1B201D');
  g.addColorStop(0.55, '#101411');
  g.addColorStop(1, '#070908');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const light = ctx.createRadialGradient(W * 0.5, H * 0.08, 10, W * 0.5, H * 0.08, Math.max(W, H) * 0.75);
  light.addColorStop(0, 'rgba(255, 240, 200, 0.10)');
  light.addColorStop(0.5, 'rgba(255, 240, 200, 0.03)');
  light.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, W, H);
  const vig = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.8);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

// ===== фишки =====

export type TilePalette = 'ivory' | 'amber' | 'marble' | 'color';

// Тело фишки: слоновая кость с фаской, цветным числом и небольшим углублением.
function tileBody(ctx: CanvasRenderingContext2D, face: TileFace, palette: TilePalette): void {
  const W = TILE_W;
  const H = TILE_H;
  const r = 18;
  const base = face.color === 2 ? '#2B2F36' : colorHex(face.color);
  const pal = palette === 'color'
    ? { top: shade(base, 0.16), bottom: shade(base, -0.12), edge: shade(base, -0.34), ink: '#FFFFFF' }
    : palette === 'amber'
      ? { top: '#FFF2CF', bottom: '#E8C98C', edge: '#C9A25B', ink: '#4A2E10' }
      : palette === 'marble'
        ? { top: '#F8FAFF', bottom: '#C7D0DF', edge: '#9FAABC', ink: '#2C3444' }
        : { top: '#FFFDF4', bottom: '#EADDBE', edge: '#CDBC94', ink: '#3A2C1A' };

  // Толщина фишки: нижняя и правая тёмные грани.
  roundRect(ctx, 5, 9, W - 10, H - 12, r);
  ctx.fillStyle = shade(pal.edge, -0.28);
  ctx.fill();
  roundRect(ctx, 3, 5, W - 9, H - 11, r);
  ctx.fillStyle = pal.edge;
  ctx.fill();

  // Лицевая поверхность.
  const g = ctx.createLinearGradient(0, 4, W * 0.35, H - 6);
  g.addColorStop(0, pal.top);
  g.addColorStop(0.55, shade(pal.top, -0.05));
  g.addColorStop(1, pal.bottom);
  roundRect(ctx, 4, 3, W - 11, H - 14, r);
  ctx.fillStyle = g;
  ctx.fill();

  // Мрамор: прожилки поверх светлого камня, иначе палитра почти не
  // отличалась от «слоновой кости».
  if (palette === 'marble') drawMarbleVeins(ctx);

  // Верхняя светлая кромка и нижняя тень — объём.
  ctx.save();
  roundRect(ctx, 6, 5, W - 15, H - 18, r - 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  roundRect(ctx, 6, 8, W - 15, H - 18, r - 2);
  ctx.strokeStyle = 'rgba(90, 62, 30, 0.16)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Углубление внизу, как на обложке.
  ctx.beginPath();
  ctx.arc(W / 2 - 2, H - 40, 14, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(120, 96, 58, 0.10)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(W / 2 - 2, H - 39, 14, Math.PI * 0.15, Math.PI * 1.05);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (face.is_joker) {
    drawStar(ctx, W / 2 - 2, H / 2 - 8, 42);
    return;
  }

  const ink = palette === 'color' ? '#FFFFFF' : (face.color === 2 ? '#23262B' : colorHex(face.color));
  drawNumber(ctx, String(face.value), W / 2 - 2, H / 2 - 8, ink, palette === 'color');
}

function drawMarbleVeins(ctx: CanvasRenderingContext2D): void {
  const W = TILE_W;
  const H = TILE_H;
  ctx.save();
  roundRect(ctx, 4, 3, W - 11, H - 14, 18);
  ctx.clip();
  ctx.lineCap = 'round';
  const veins: { color: string; width: number; p: number[] }[] = [
    // Основные прожилки — по диагонали через всю фишку.
    { color: 'rgba(104,118,142,0.26)', width: 3, p: [-12, 64, 36, 20, 88, 120, 172, 58] },
    { color: 'rgba(104,118,142,0.20)', width: 2.4, p: [-12, 196, 48, 166, 112, 224, 172, 150] },
    // Светлая жилка — блик камня.
    { color: 'rgba(255,255,255,0.75)', width: 1.6, p: [-8, 118, 40, 92, 96, 148, 168, 104] },
    // Короткие ответвления.
    { color: 'rgba(104,118,142,0.18)', width: 1.5, p: [46, 44, 60, 76, 42, 100, 62, 132] },
    { color: 'rgba(104,118,142,0.15)', width: 1.3, p: [104, 94, 122, 112, 108, 140, 132, 164] },
  ];
  for (const v of veins) {
    ctx.beginPath();
    ctx.moveTo(v.p[0], v.p[1]);
    ctx.bezierCurveTo(v.p[2], v.p[3], v.p[4], v.p[5], v.p[6], v.p[7]);
    ctx.strokeStyle = v.color;
    ctx.lineWidth = v.width;
    ctx.stroke();
  }
  ctx.restore();
}

function drawNumber(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  color: string,
  light = false,
): void {
  // Один размер для однозначных и двузначных чисел: цифра не «прыгает»
  // при переходе 9 → 10.
  let size = 100;
  const font = (s: number): string => `bold ${s}px Arial, Helvetica, sans-serif`;
  ctx.font = font(size);
  while (size > 40 && ctx.measureText(text).width > TILE_W - 34) {
    size -= 4;
    ctx.font = font(size);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Вдавленное число: тёмная тень сверху-слева, светлая подсветка снизу.
  // На цветном фоне подсветка инвертирована, чтобы белые цифры читались.
  ctx.fillStyle = light ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.55)';
  ctx.fillText(text, cx + 2, cy + 3);
  ctx.fillStyle = light ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.18)';
  ctx.fillText(text, cx - 1, cy - 2);
  ctx.fillStyle = color;
  ctx.fillText(text, cx, cy);
  // Блик на верхней трети цифры.
  const grad = ctx.createLinearGradient(0, cy - size * 0.45, 0, cy + size * 0.1);
  grad.addColorStop(0, light ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.30)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillText(text, cx, cy);
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const colors = ['#E53935', '#1E88E5', '#212121', '#FB8C00'];
  for (let i = 0; i < 4; i += 1) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r * 1.25, (Math.PI / 2) * i + Math.PI / 4, (Math.PI / 2) * (i + 1) + Math.PI / 4);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = colors[i];
    ctx.fillRect(0, 0, TILE_W, TILE_H);
    ctx.restore();
  }
  ctx.beginPath();
  for (let k = 0; k < 10; k += 1) {
    const rr = k % 2 === 0 ? r : r * 0.42;
    const a = -Math.PI / 2 + k * (Math.PI / 5);
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(50,35,10,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// Рубашка: синяя фишка с ромбами.
function tileBack(ctx: CanvasRenderingContext2D): void {
  const W = TILE_W;
  const H = TILE_H;
  const r = 18;
  roundRect(ctx, 5, 9, W - 10, H - 12, r);
  ctx.fillStyle = '#12283F';
  ctx.fill();
  roundRect(ctx, 3, 5, W - 9, H - 11, r);
  ctx.fillStyle = '#1B3B5C';
  ctx.fill();
  const g = ctx.createLinearGradient(0, 4, W * 0.4, H - 6);
  g.addColorStop(0, '#2B5A88');
  g.addColorStop(1, '#183851');
  roundRect(ctx, 4, 3, W - 11, H - 14, r);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  roundRect(ctx, 4, 3, W - 11, H - 14, r);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 3;
  for (let i = -H; i < W + H; i += 26) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + H, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i, H);
    ctx.lineTo(i + H, 0);
    ctx.stroke();
  }
  ctx.restore();
  ctx.save();
  roundRect(ctx, 6, 5, W - 15, H - 18, r - 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  // Ромб по центру.
  ctx.beginPath();
  ctx.moveTo(W / 2 - 2, H / 2 - 34);
  ctx.lineTo(W / 2 + 24, H / 2 - 8);
  ctx.lineTo(W / 2 - 2, H / 2 + 18);
  ctx.lineTo(W / 2 - 28, H / 2 - 8);
  ctx.closePath();
  ctx.fillStyle = 'rgba(245, 208, 107, 0.85)';
  ctx.fill();
}

export function tileTexture(face: TileFace, faceDown: boolean, palette: TilePalette = 'ivory'): string {
  const key = `tile:${faceDown ? 'back' : `${face.color}:${face.value}:${face.is_joker ? 1 : 0}`}:${palette}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { c, ctx } = mk(TILE_W, TILE_H);
  if (faceDown) tileBack(ctx);
  else tileBody(ctx, face, palette);
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

// ===== аватары =====

export interface AvatarSpec {
  bg: string;
  skin: string;
  hair: string;
  shirt: string;
  hairStyle: 'short' | 'bald' | 'long' | 'bun' | 'cap';
  glasses: boolean;
  beard: boolean;
  smile: number;
}

export const BOT_AVATARS: Record<string, AvatarSpec> = {
  timofey: { bg: '#4E6E8E', skin: '#E8B98F', hair: '#B8B8B8', shirt: '#6D7F5B', hairStyle: 'bald', glasses: true, beard: false, smile: 0.6 },
  klara: { bg: '#7A5C8E', skin: '#F0C8A2', hair: '#8A5A3B', shirt: '#9C6B7A', hairStyle: 'bun', glasses: true, beard: false, smile: 0.8 },
  arkady: { bg: '#3F6B5C', skin: '#D9A87C', hair: '#4A3B33', shirt: '#3E4C63', hairStyle: 'short', glasses: true, beard: true, smile: 0.4 },
  max: { bg: '#7A4A3A', skin: '#D8A47A', hair: '#2B211C', shirt: '#2E3138', hairStyle: 'cap', glasses: false, beard: true, smile: 1.1 },
  lena: { bg: '#4A7A82', skin: '#F2CDAA', hair: '#C46A32', shirt: '#4F6E9C', hairStyle: 'long', glasses: false, beard: false, smile: 0.9 },
  guest: { bg: '#4A5468', skin: '#E8B98F', hair: '#3A2E28', shirt: '#556070', hairStyle: 'short', glasses: false, beard: false, smile: 0.7 },
};

export function avatarTexture(id: string, ring?: string): string {
  const key = `avatar:${id}:${ring ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const spec = BOT_AVATARS[id] ?? BOT_AVATARS.guest;
  const S = 128;
  const { c, ctx } = mk(S, S);
  ctx.clearRect(0, 0, S, S);
  // Круглый фон.
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
  const g = ctx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, shade(spec.bg, 0.18));
  g.addColorStop(1, shade(spec.bg, -0.22));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
  ctx.clip();

  // Плечи.
  ctx.beginPath();
  ctx.ellipse(S / 2, S * 1.02, S * 0.40, S * 0.34, 0, Math.PI, Math.PI * 2);
  ctx.fillStyle = spec.shirt;
  ctx.fill();
  // Шея и голова.
  ctx.fillStyle = shade(spec.skin, -0.10);
  ctx.fillRect(S * 0.42, S * 0.62, S * 0.16, S * 0.16);
  ctx.beginPath();
  ctx.ellipse(S / 2, S * 0.50, S * 0.24, S * 0.27, 0, 0, Math.PI * 2);
  ctx.fillStyle = spec.skin;
  ctx.fill();

  // Волосы.
  ctx.fillStyle = spec.hair;
  if (spec.hairStyle === 'bald') {
    // Не «лысина», а седые волосы: шапка волос начинается от макушки.
    ctx.beginPath();
    ctx.ellipse(S / 2, S * 0.39, S * 0.25, S * 0.16, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(S * 0.27, S * 0.44, S * 0.035, S * 0.09, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(S * 0.73, S * 0.44, S * 0.035, S * 0.09, -0.2, 0, Math.PI * 2);
    ctx.fill();
  } else if (spec.hairStyle === 'long') {
    ctx.beginPath();
    ctx.ellipse(S / 2, S * 0.52, S * 0.28, S * 0.31, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(S * 0.26, S * 0.62, S * 0.09, S * 0.20, 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(S * 0.74, S * 0.62, S * 0.09, S * 0.20, -0.15, 0, Math.PI * 2);
    ctx.fill();
  } else if (spec.hairStyle === 'bun') {
    ctx.beginPath();
    ctx.ellipse(S / 2, S * 0.42, S * 0.255, S * 0.21, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(S / 2, S * 0.17, S * 0.10, 0, Math.PI * 2);
    ctx.fill();
  } else if (spec.hairStyle === 'cap') {
    ctx.beginPath();
    ctx.ellipse(S / 2, S * 0.36, S * 0.265, S * 0.17, 0, Math.PI, Math.PI * 2);
    ctx.fillStyle = '#2B2F36';
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(S * 0.60, S * 0.37, S * 0.18, S * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.ellipse(S / 2, S * 0.39, S * 0.25, S * 0.17, 0, Math.PI, Math.PI * 2);
    ctx.fill();
  }

  // Глаза.
  if (spec.glasses) {
    ctx.strokeStyle = '#2A2A2E';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(S * 0.40, S * 0.49, S * 0.075, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(S * 0.60, S * 0.49, S * 0.075, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(S * 0.475, S * 0.49);
    ctx.lineTo(S * 0.525, S * 0.49);
    ctx.stroke();
  }
  ctx.fillStyle = '#2A2A2E';
  ctx.beginPath();
  ctx.arc(S * 0.40, S * 0.49, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(S * 0.60, S * 0.49, 3.2, 0, Math.PI * 2);
  ctx.fill();

  // Брови.
  ctx.strokeStyle = shade(spec.hair, -0.1);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(S * 0.34, S * 0.42);
  ctx.lineTo(S * 0.45, S * 0.41);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(S * 0.55, S * 0.41);
  ctx.lineTo(S * 0.66, S * 0.42);
  ctx.stroke();

  // Улыбка.
  ctx.strokeStyle = '#8A4A3A';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(S / 2, S * 0.55, S * 0.10, 0.25 * Math.PI, 0.75 * Math.PI * spec.smile);
  ctx.stroke();

  // Борода.
  if (spec.beard) {
    ctx.beginPath();
    ctx.ellipse(S / 2, S * 0.63, S * 0.19, S * 0.13, 0, 0, Math.PI);
    ctx.fillStyle = shade(spec.hair, -0.05);
    ctx.fill();
  }
  ctx.restore();
  // Ободок: у аватаров с ролью (игрок/бот) — цветное кольцо, иначе
  // обычная тёмная кромка.
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2);
  ctx.strokeStyle = ring ?? 'rgba(0,0,0,0.35)';
  ctx.lineWidth = ring ? 7 : 3;
  ctx.stroke();
  if (ring) {
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}
