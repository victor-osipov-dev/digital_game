import { Container, Control, Rectangle } from '@babylonjs/gui';
import { px } from './uiskin';

export interface FlowItem {
  root: Control;
  width: number;
  height: number;
}

export interface FlowLayout {
  lines: number;
  totalHeight: number;
  // номер визуальной строки для каждого элемента (в порядке items)
  lineOf: number[];
}

// FlowTiles-порт: ручная раскладка с переносом строк и центрированием
// каждой строки по горизонтальной оси. Контейнер — обычный Control,
// дети позиционируются абсолютными left/top.
// HGAP/VGAP как в оригинале: clampf(ts.x * 0.1, 3, 8).
export function flowGap(ts: { x: number }): number {
  return Math.max(3, Math.min(8, Math.round(ts.x * 0.1)));
}

export function layoutFlow(
  container: Container,
  items: FlowItem[],
  widthPx: number,
  gap?: number,
): FlowLayout {
  container.clearControls();
  const g = gap !== undefined ? gap : flowGap({ x: items.length > 0 ? items[0].width : 40 });
  const rows: { items: FlowItem[]; w: number; at: number[] }[] = [];
  let cur: FlowItem[] = [];
  let curAt: number[] = [];
  let curW = 0;
  for (let k = 0; k < items.length; k += 1) {
    const it = items[k];
    const need = curW + (cur.length > 0 ? g : 0) + it.width;
    if (cur.length > 0 && need > widthPx) {
      rows.push({ items: cur, w: curW, at: curAt });
      cur = [it];
      curAt = [k];
      curW = it.width;
    } else {
      cur.push(it);
      curAt.push(k);
      curW = need;
    }
  }
  if (cur.length > 0) rows.push({ items: cur, w: curW, at: curAt });
  const lineOf: number[] = new Array<number>(items.length).fill(0);
  let y = 0;
  for (let rI = 0; rI < rows.length; rI += 1) {
    const row = rows[rI];
    const hRow = Math.max(...row.items.map((it) => it.height));
    let lx = Math.max(0, Math.floor((widthPx - row.w) / 2));
    for (const it of row.items) {
      it.root.width = px(it.width);
      it.root.height = px(it.height);
      it.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
      it.root.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
      it.root.left = px(lx);
      it.root.top = px(y);
      container.addControl(it.root);
      lx += it.width + g;
    }
    for (const k of row.at) lineOf[k] = rI;
    y += hRow + g;
  }
  const total = rows.length > 0 ? Math.max(0, y - g) : 0;
  return { lines: rows.length, totalHeight: total, lineOf };
}

// Фон раскладки (полупрозрачные панели-«блоки» у рук/рядов не зависят
// от размеров детей — дети не должны менять ширину контейнера).
export function flowHost(minH: number, name = 'flowHost'): Container {
  const c = new Container(name);
  c.height = px(minH);
  const bg = new Rectangle('bg');
  bg.width = '100%';
  bg.height = '100%';
  bg.thickness = 0;
  bg.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  bg.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  c.addControl(bg);
  return c;
}
