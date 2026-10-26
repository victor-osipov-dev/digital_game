import { Container, Image as GuiImage, Rectangle, StackPanel, TextBlock } from '@babylonjs/gui';
import { colorHex, TileFace } from '../core/tile';
import { fs, tileSize } from '../core/settings';
import { dataURL } from './art';
import { px } from './uiskin';

export interface TileMarks {
  hint?: boolean;
  draft?: boolean;
  last?: boolean;
  drawn?: boolean;
}

const GREEN = '#43A047';

// Визуал одной фишки: цветная панель, число с тёмной обводкой, джокер —
// канвасная звезда (полигон в Babylon GUI не нарисовать), рамки меток.
export class TileFigure {
  readonly root: Container = new Container('tileFig');
  readonly bg: Rectangle;
  private starImages: GuiImage[] = [];
  readonly face: TileFace;
  readonly faceDown: boolean;
  readonly ts: { x: number; y: number };
  rgbaAlpha = 1;

  constructor(face: TileFace, faceDown: boolean, marks: TileMarks, tsOverride?: { x: number; y: number }) {
    this.face = face;
    this.faceDown = faceDown;
    const ts = tsOverride ?? tileSize();
    this.ts = ts;
    const root = this.root;
    root.width = px(ts.x);
    root.height = px(ts.y);

    const bw = clampInt(Math.round(ts.x * 0.05), 1, 3);
    const corner = clampInt(Math.round(ts.x * 0.14), 3, 12);

    this.bg = new Rectangle('bg');
    this.bg.cornerRadius = corner;
    this.bg.thickness = faceDown ? Math.max(bw, 2) : bw;
    if (faceDown) {
      this.bg.background = '#2B3140';
      this.bg.color = '#ffffff4d';
      this.bg.alpha = 1;
    } else {
      this.bg.background = colorHex(face.color);
      this.applyMarkBorder(marks, bw);
    }
    this.bg.width = '100%';
    this.bg.height = '100%';
    this.bg.horizontalAlignment = Container.HORIZONTAL_ALIGNMENT_CENTER;
    this.bg.verticalAlignment = Container.VERTICAL_ALIGNMENT_CENTER;
    root.addControl(this.bg);

    if (!faceDown) {
      if (face.is_joker) {
        const img = new GuiImage('star', dataURL('star'));
        const s = Math.round(Math.min(ts.x, ts.y) * 0.98);
        img.width = px(s);
        img.height = px(s);
        img.horizontalAlignment = Container.HORIZONTAL_ALIGNMENT_CENTER;
        img.verticalAlignment = Container.VERTICAL_ALIGNMENT_CENTER;
        root.addControl(img);
        this.starImages.push(img);
      } else {
        const fPrefix = fs(Math.round(ts.y * 0.4));
        const fsize = Math.max(8, Math.min(fPrefix, Math.round((ts.x - 6) * 0.82)));
        const label = new TextBlock('num', String(face.value));
        label.color = '#ffffff';
        label.fontSize = fsize;
        label.fontFamily = 'Arial, sans-serif';
    label.outlineColor = 'rgba(0,0,0,0.5)';
    label.outlineWidth = Math.max(2, Math.floor(fsize / 6));
        label.textHorizontalAlignment = Container.HORIZONTAL_ALIGNMENT_CENTER;
        label.textVerticalAlignment = Container.VERTICAL_ALIGNMENT_CENTER;
        label.width = '100%';
        label.height = '100%';
        root.addControl(label);
      }
    }

    if (!faceDown && marks.drawn) {
      this.addBadge();
    }
  }

  private applyMarkBorder(m: TileMarks, bw: number): void {
    if (m.hint) {
      this.bg.color = '#FFFFFF';
      this.bg.thickness = Math.max(bw + 2, 5);
    } else if (m.draft) {
      this.bg.color = GREEN;
      this.bg.thickness = Math.max(bw + 3, 5);
      this.rgbaAlpha = 0.72;
      this.root.alpha = 0.72;
    } else if (m.last) {
      this.bg.color = GREEN;
      this.bg.thickness = Math.max(bw + 3, 5);
    } else {
      const border = this.face.is_joker ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.18)';
      this.bg.color = border;
      this.bg.thickness = this.face.is_joker ? Math.max(bw, 2) : bw;
    }
  }

  refreshMarks(m: TileMarks): void {
    this.root.alpha = 1;
    this.rgbaAlpha = 1;
    const bw = clampInt(Math.round(this.ts.x * 0.05), 1, 3);
    this.applyMarkBorder(m, bw);
    if (!this.faceDown && m.drawn) {
      if (this.badge === null) this.addBadge();
    } else if (this.badge !== null) {
      this.badge.isVisible = false;
    }
  }

  private badge: GuiImage | null = null;

  private addBadge(): void {
    const r = this.ts.y * 0.13;
    const d = Math.round(r * 2);
    const badge = new GuiImage('badge', dataURL('badge'));
    badge.width = px(d);
    badge.height = px(d);
    badge.horizontalAlignment = Container.HORIZONTAL_ALIGNMENT_RIGHT;
    badge.verticalAlignment = Container.VERTICAL_ALIGNMENT_TOP;
    badge.left = px(Math.round(r * 1.4));
    badge.top = px(-Math.round(r * 0.8));
    this.root.addControl(badge);
    this.badge = badge;
  }

  // Короткая подпись фишки (для экранных читалок/логов).
  infoText(): string {
    if (this.face.is_joker) return 'Джокер — заменяет любое число любого цвета';
    return `${this.face.value}`;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function tileRow(tiles: TileFigure[], gapX = 6): StackPanel {
  const sp = new StackPanel('tileRow');
  sp.isVertical = false;
  sp.spacing = gapX;
  for (const f of tiles) sp.addControl(f.root);
  return sp;
}
