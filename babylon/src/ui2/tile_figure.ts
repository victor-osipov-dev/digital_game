import { Container, Control, Image as GuiImage, Rectangle, ScrollViewer, StackPanel, TextBlock } from '@babylonjs/gui';
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
  private marks: TileMarks;
  rgbaAlpha = 1;

  constructor(
    face: TileFace,
    faceDown: boolean,
    marks: TileMarks,
    tsOverride?: { x: number; y: number },
    // слой бейджей: если задан, «галочка» живёт поверх стола и не режется
    badgeHost?: Container | null,
    // показать «галочку» без остальных меток (призрак полёта): она
    // едет вместе с фишкой, а не появляется сразу на месте
    showBadge = false,
    // прежняя фишка той же карточки: её бейдж переходит сюда, чтобы
    // пересборка не гасила «галочку» ни на кадр
    inherit?: TileFigure | null,
  ) {
    this.face = face;
    this.faceDown = faceDown;
    this.badgeHost = badgeHost ?? null;
    this.marks = { ...marks };
    const ts = tsOverride ?? tileSize();
    this.ts = ts;
    const root = this.root;
    root.width = px(ts.x);
    root.height = px(ts.y);
    // Бейдж-«галочка» сидит в правом верхнем углу и чуть выходит за
    // карточку (как отдельный слой бейджей в оригинале) — не режем его.
    root.clipChildren = false;

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

    // Галочка с кружочком в правом верхнем углу: взятая из колоды фишка
    // и своя живая выкладка (в Godot badge = mark_drawn OR mark_draft,
    // tile_view.gd:170-189).
    if (!faceDown && (marks.drawn || marks.draft || showBadge)) {
      const carried = inherit ? inherit.takeBadge() : null;
      if (carried && this.badgeHost) {
        // Бейдж уже стоит на месте — продолжаем вести его этой фишкой.
        this.badge = carried;
        this.badgeWanted = true;
        this.startBadgeSync(carried, ts.y * 0.13);
      } else {
        this.addBadge();
      }
    }
  }

  // Отдать свой бейдж новой фишке той же карточки (пересборка ряда):
  // слой не трогаем, поэтому «галочка» не мигает.
  takeBadge(): GuiImage | null {
    const b = this.badge;
    this.badge = null;
    if (!b || b.parent === null) return null;
    return b;
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
    this.marks = { ...m };
    const bw = clampInt(Math.round(this.ts.x * 0.05), 1, 3);
    this.applyMarkBorder(m, bw);
    if (!this.faceDown && (m.drawn || m.draft)) {
      this.badgeWanted = true;
      if (this.badge === null || (this.badgeHost && this.badge.parent === null)) {
        this.badge = null;
        this.addBadge();
      } else {
        this.badge.isVisible = true;
      }
    } else if (this.badge !== null) {
      this.badgeWanted = false;
      this.badge.isVisible = false;
    }
  }

  private badge: GuiImage | null = null;
  private readonly badgeHost: Container | null;
  private badgeWanted = false;
  private badgeRaf = 0;

  private addBadge(): void {
    const r = this.ts.y * 0.13;
    const d = Math.round(r * 2);
    const badge = new GuiImage('badge', dataURL('badge'));
    badge.width = px(d);
    badge.height = px(d);
    badge.isHitTestVisible = false;
    this.badgeWanted = true;
    if (this.badgeHost) {
      // Внешний слой: координаты абсолютные, обновляем каждый кадр —
      // фишка может прокручиваться и переезжать. До первого замера
      // прячем: иначе свежий бейдж один кадр стоит в (0,0) белым пятном,
      // пока старый (от пересобранной фишки) снимается — видно мерцание.
      badge.horizontalAlignment = Container.HORIZONTAL_ALIGNMENT_LEFT;
      badge.verticalAlignment = Container.VERTICAL_ALIGNMENT_TOP;
      badge.isVisible = false;
      this.badgeHost.addControl(badge);
      this.startBadgeSync(badge, r);
    } else {
      // Фолбэк (превью перетаскивания и т.п.): бейдж внутри фишки.
      badge.horizontalAlignment = Container.HORIZONTAL_ALIGNMENT_RIGHT;
      badge.verticalAlignment = Container.VERTICAL_ALIGNMENT_TOP;
      badge.left = px(Math.round(r * 1.4));
      badge.top = px(-Math.round(r * 0.8));
      this.root.addControl(badge);
    }
    this.badge = badge;
  }

  // Пока бейдж нужен, следим за положением фишки: скролл стола/руки не
  // двигает наш слой, а «галочка» обязана ехать вместе с карточкой.
  private startBadgeSync(badge: GuiImage, r: number): void {
    if (this.badgeRaf) return;
    const host = this.badgeHost as Container;
    const hostParent = host.parent;
    const hostTop = topOf(host);
    let positionInitialized = false;
    const tick = (): void => {
      this.badgeRaf = 0;
      if (this.badge !== badge) return;
      // Метка снята или пересборка отсоединила фишки от дерева: убираем
      // бейдж. Проверяем не только parent у самой фишки — у пересобранных
      // рядов parent остаётся внутри уже отсоединённого поддерева.
      if (!this.badgeWanted || topOf(this.root) !== hostTop) {
        if (badge.parent) badge.parent.removeControl(badge);
        return;
      }
      const rect = measureOf(this.root);
      // Раскладка ещё не посчитана (новые виды меряются на кадре рендера):
      // подождём, но не снимаем бейдж навсегда.
      if (rect.w <= 0) {
        this.badgeRaf = window.requestAnimationFrame(tick);
        return;
      }
      // Новая летящая фишка — прямой ребёнок слоя игры. Babylon может
      // сообщить ей ширину до того, как обновил left/top после addControl;
      // не показываем бейдж в старых координатах (часто (0,0)) даже на кадр.
      if (!positionInitialized && hostParent && this.root.parent === hostParent) {
        const parentRect = measureOf(hostParent);
        const expectedX = parentRect.x + this.root.leftInPixels;
        const expectedY = parentRect.y + this.root.topInPixels;
        if (Math.abs(rect.x - expectedX) > 60 || Math.abs(rect.y - expectedY) > 60) {
          this.badgeRaf = window.requestAnimationFrame(tick);
          return;
        }
      }
      positionInitialized = true;
      badge.left = px(Math.round(rect.x + this.ts.x - 1 - r));
      badge.top = px(Math.round(rect.y + 1 - r));
      // За пределами своего скролла (стол/рука) не виснем над кнопками.
      // Пока фишка летит, она скрыта (alpha 0) — «галочку» везёт призрак,
      // поэтому на месте не показываем её раньше карточки.
      const sc = scrollRectOf(this.root);
      badge.isVisible = this.root.alpha > 0.05 && (!sc || (
        rect.x - 12 < sc.x + sc.w && rect.x + rect.w + 12 > sc.x
        && rect.y - 12 < sc.y + sc.h && rect.y + rect.h + 12 > sc.y
      ));
      this.badgeRaf = window.requestAnimationFrame(tick);
    };
    this.badgeRaf = window.requestAnimationFrame(tick);
  }

  // Есть ли у фишки «галочка» (для призрака полёта: он обязан везти её
  // вместе с карточкой).
  badgeShown(): boolean {
    return this.badgeWanted && this.badge !== null;
  }

  // Гасим бейдж цели синхронно со стартом полёта. Ожидать следующего
  // requestAnimationFrame нельзя: внешний бейдж на миг останется на
  // конечной позиции и будет перекрыт летящей фишкой белым пятном.
  hideBadgeForFlight(): void {
    if (this.badgeHost && this.badge) this.badge.isVisible = false;
  }

  // Те же метки нужны временной фишке-слайду: зелёная рамка/прозрачность
  // не должны пропадать, пока настоящий control скрыт на время анимации.
  flightMarks(): TileMarks {
    return { ...this.marks };
  }

  // Поставить бейдж сразу (без ожидания следующего кадра): вызывается в
  // момент приземления фишки, чтобы между «призрак убрали» и «бейдж на
  // месте» не было пустого кадра.
  revealBadge(): void {
    if (!this.badgeWanted || !this.badge) return;
    if (this.badge.parent === null) {
      this.badge = null;
      this.addBadge();
      return;
    }
    const rect = measureOf(this.root);
    if (rect.w <= 0) return;
    const r = this.ts.y * 0.13;
    this.badge.left = px(Math.round(rect.x + this.ts.x - 1 - r));
    this.badge.top = px(Math.round(rect.y + 1 - r));
    this.badge.isVisible = true;
  }

  // У временной фишки полёта убираем внешний бейдж синхронно при посадке;
  // настоящий бейдж цели уже будет показан на той же позиции.
  disposeBadge(): void {
    this.badgeWanted = false;
    if (this.badge?.parent) this.badge.parent.removeControl(this.badge);
    this.badge = null;
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

// Самый верхний предок контрола: после пересборки ряда поддерево остаётся
// отсоединённым где-то посередине (у самой фишки parent ещё не null), так
// что «в дереве ли фишка» надёжно решает сравнение верхушек.
function topOf(c: Control): Control {
  let p: Control = c;
  let guard = 0;
  while (p.parent && guard < 100) {
    p = p.parent;
    guard += 1;
  }
  return p;
}

function measureOf(c: Control): { x: number; y: number; w: number; h: number } {
  const m = (c as unknown as { _currentMeasure?: { left: number; top: number; width: number; height: number } })._currentMeasure;
  if (m && Number.isFinite(m.left) && Number.isFinite(m.top)) {
    return { x: m.left, y: m.top, w: m.width, h: m.height };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

// Ближайший ScrollViewer-родитель: за его пределами бейдж не показываем
// (иначе «галочка» висела бы над кнопками при прокрутке).
function scrollRectOf(c: Control): { x: number; y: number; w: number; h: number } | null {
  let p: Control | null = c.parent;
  while (p) {
    if (p instanceof ScrollViewer) {
      const m = measureOf(p);
      if (m.w > 0 && m.h > 0) return m;
    }
    p = p.parent;
  }
  return null;
}

export function tileRow(tiles: TileFigure[], gapX = 6): StackPanel {
  const sp = new StackPanel('tileRow');
  sp.isVertical = false;
  sp.spacing = gapX;
  for (const f of tiles) sp.addControl(f.root);
  return sp;
}
