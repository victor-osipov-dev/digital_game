import { Button, Control, InputText, Rectangle, StackPanel, TextBlock } from '@babylonjs/gui';
import { FONT_MAIN, UI } from './theme';
import { focusInputOnTap } from '../ui2/uiskin';

export function el(name: string): Control {
  return new Control(name);
}

export function text(name: string, s: string, size = 16, color = UI.text): TextBlock {
  const tb = new TextBlock(name, s);
  tb.color = color;
  tb.fontSize = size;
  tb.fontFamily = FONT_MAIN;
  tb.resizeToFit = false;
  return tb;
}

let btnSeq = 0;

export function button(label: string, size = 16, bg = UI.accent): Button {
  const b = Button.CreateSimpleButton(`btn${(btnSeq += 1)}`, label);
  b.color = '#ffffff';
  b.background = bg;
  b.cornerRadius = 10;
  b.height = '40px';
  b.width = '160px';
  b.fontFamily = FONT_MAIN;
  b.fontSize = size;
  b.thickness = 0;
  b.paddingBottom = '2px';
  return b;
}

export function panel(name: string, child?: Control): Rectangle {
  const r = new Rectangle(name);
  r.width = '560px';
  r.height = '640px';
  r.cornerRadius = 14;
  r.thickness = 1;
  r.color = '#2c2d36';
  r.background = UI.panel;
  r.adaptHeightToChildren = false;
  r.adaptWidthToChildren = false;
  if (child) r.addControl(child);
  return r;
}

export function column(): StackPanel {
  const sp = new StackPanel('col');
  sp.width = '100%';
  sp.isVertical = true;
  sp.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  return sp;
}

export function input(placeholder: string, password = false): InputText {
  const it = new InputText(undefined, '');
  it.placeholderText = placeholder;
  it.height = '40px';
  it.width = '320px';
  it.color = UI.text;
  it.background = UI.panel2;
  it.fontSize = 16;
  it.fontFamily = FONT_MAIN;
  if (password) it.maxWidth = '320px';
  focusInputOnTap(it);
  return it;
}

export function gap(h = 10): Control {
  const c = new Control();
  c.height = `${h}px`;
  return c;
}

export function row(): StackPanel {
  const sp = new StackPanel();
  sp.isVertical = false;
  return sp;
}
