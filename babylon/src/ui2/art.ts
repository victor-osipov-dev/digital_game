// Общие канвасные текстуры: звезда джокера, ромб рубашки, бейдж-галочка.
// В Babylon GUI нет рисования полигонов, поэтому полигоны оригинала
// рисуются в офф-скрин-канвасе один раз и кэшируются PNG data-URL.

type Ctx2D = CanvasRenderingContext2D;

function mk(size: number): { c: HTMLCanvasElement; ctx: Ctx2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d') as Ctx2D;
  return { c, ctx };
}

export function starPoints(cx: number, cy: number, rOut: number): [number, number][] {
  const rIn = rOut * 0.382;
  const pts: [number, number][] = [];
  for (let k = 0; k < 10; k += 1) {
    const r = k % 2 === 0 ? rOut : rIn;
    const a = -Math.PI * 0.5 + k * (Math.PI / 5);
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function poly(ctx: Ctx2D, pts: [number, number][]): void {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 1) {
    if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]);
    else ctx.lineTo(pts[i][0], pts[i][1]);
  }
  ctx.closePath();
}

const S = 128;

const cache = new Map<string, string>();

function starURL(): string {
  const key = 'star';
  const hit = cache.get(key);
  if (hit) return hit;
  const { c, ctx } = mk(S);
  const cXY = S / 2;
  ctx.clearRect(0, 0, S, S);
  // Широкий чёрный ореол (x1.35), как в оригинале — x1.14 с мягкостью.
  poly(ctx, starPoints(cXY, cXY, (S / 2 - 6) * 1.35));
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();
  poly(ctx, starPoints(cXY, cXY, (S / 2 - 6) * 1.14));
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fill();
  poly(ctx, starPoints(cXY, cXY, S / 2 - 6));
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

function diamondURL(): string {
  const key = 'diamond';
  const hit = cache.get(key);
  if (hit) return hit;
  const { c, ctx } = mk(S);
  const m = S * 0.5;
  const r = S * 0.2;
  ctx.clearRect(0, 0, S, S);
  ctx.beginPath();
  ctx.moveTo(m, m - r);
  ctx.lineTo(m + r, m);
  ctx.lineTo(m, m + r);
  ctx.lineTo(m - r, m);
  ctx.closePath();
  ctx.fillStyle = '#FFD54F';
  ctx.fill();
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

// Белый кружок + зелёная галочка (#2E9E5B), как BadgeDot.
function badgeURL(): string {
  const key = 'badge';
  const hit = cache.get(key);
  if (hit) return hit;
  const { c, ctx } = mk(S);
  const m = S / 2;
  ctx.clearRect(0, 0, S, S);
  ctx.beginPath();
  ctx.arc(m, m, S * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  const g = '#2E9E5B';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = g;
  ctx.lineWidth = S * 0.09;
  ctx.beginPath();
  ctx.moveTo(m - S * 0.16, m + S * 0.02);
  ctx.lineTo(m - S * 0.04, m + S * 0.14);
  ctx.lineTo(m + S * 0.17, m - S * 0.13);
  ctx.stroke();
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

export function dataURL(kind: 'star' | 'diamond' | 'badge'): string {
  return kind === 'star' ? starURL() : kind === 'diamond' ? diamondURL() : badgeURL();
}
