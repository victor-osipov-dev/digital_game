import { Container, Control, Rectangle, ScrollViewer, StackPanel, TextBlock } from '@babylonjs/gui';
import { t } from '../core/lang';
import { fs, loadSettings, saveSettings } from '../core/settings';
import { applySoundPreference } from '../core/sound';
import { TEXT_SCALE_NAMES, TILE_SIZE_NAMES } from '../core/settings';
import { BLACK, BLUE, ORANGE, RED, YELLOW, colorHex } from '../core/tile';
import {
  BUTTON_STYLE,
  checkboxRow,
  DropdownCtx,
  dropdownRow,
  enableSmoothScroll,
  estimateWrappedTextHeight,
  mkButton,
  mkLabel,
  modalOverlay,
  SKIN,
  softPanel,
  px,
} from './uiskin';
import { viewHeight, viewWidth } from './viewport';
import type { OnlineStats } from './ports';

// Полноэкранные модалки, общие для меню и игры: правила и настройки.

type Host = StackPanel | import('@babylonjs/gui').Container | import('@babylonjs/gui').Rectangle;

// Мини-изображение фишки и ряда делается теми же прямоугольниками и цифрами,
// что и настоящие карточки на столе — без картинок и внешних ассетов.
interface RuleTile {
  text: string;
  color: string;
  joker?: boolean;
}

const RULE_OK = '#66BB6A';
const RULE_WARN = '#FFB74D';

function ruleTile(item: RuleTile, h: number): Container {
  const w = Math.max(22, Math.round(h * 0.74));
  const root = new Container('ruleTile');
  root.width = px(w);
  root.height = px(h);
  const bg = new Rectangle('ruleTileBg');
  bg.background = item.color;
  bg.color = 'rgba(255,255,255,0.35)';
  bg.thickness = 1;
  bg.cornerRadius = Math.max(3, Math.round(w * 0.16));
  bg.width = '100%';
  bg.height = '100%';
  root.addControl(bg);
  const label = new TextBlock('ruleTileText', item.text);
  label.color = item.joker ? '#3E2A00' : '#ffffff';
  label.fontSize = Math.max(10, Math.round(h * 0.56));
  label.fontFamily = 'Arial, sans-serif';
  if (!item.joker) {
    label.outlineColor = 'rgba(0,0,0,0.5)';
    label.outlineWidth = 2;
  }
  label.width = '100%';
  label.height = '100%';
  root.addControl(label);
  return root;
}

function ruleRow(tiles: RuleTile[], h: number, border?: string): Container {
  const gap = Math.max(3, Math.round(h * 0.12));
  const tileW = Math.max(22, Math.round(h * 0.74));
  const rowW = tiles.length * tileW + Math.max(0, tiles.length - 1) * gap + 12;
  const root = new Container('ruleRow');
  root.width = px(rowW);
  root.height = px(h + 10);
  const frame = new Rectangle('ruleRowFrame');
  frame.background = 'rgba(255,255,255,0.05)';
  frame.color = border ?? SKIN.rowBorder;
  frame.thickness = border ? 2 : 1;
  frame.cornerRadius = 8;
  frame.width = '100%';
  frame.height = '100%';
  root.addControl(frame);
  const line = new StackPanel('ruleRowTiles');
  line.isVertical = false;
  line.spacing = gap;
  line.width = px(rowW - 12);
  line.height = px(h);
  line.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  root.addControl(line);
  for (const tile of tiles) line.addControl(ruleTile(tile, h));
  return root;
}

function ruleArrow(text: string, size: number): TextBlock {
  const lab = mkLabel(text, { color: SKIN.gold, fontSize: size, width: size * 2, height: size * 1.8 });
  lab.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  return lab;
}

export function openRulesOverlay(parent: Host, _onClose: () => void): void {
  _openRules(parent as import('@babylonjs/gui').Container);
}

function _openRules(host: import('@babylonjs/gui').Container): void {
  const vw = viewWidth();
  const vh = viewHeight();
  const panelWidth = Math.min(vw - 24, 560);
  const panelHeight = Math.min(vh - 24, 700);
  const { overlay, close } = modalOverlay(host, 'rulesOverlay', { zIndex: 800 });
  const panel = softPanel({
    bg: SKIN.panelDark,
    border: '#ffffff40',
    thickness: 2,
    corner: 14,
    width: panelWidth,
    height: panelHeight,
  });
  overlay.addControl(panel.root);
  const pcol = new StackPanel('pcol');
  pcol.isVertical = true;
  pcol.spacing = 10;
  pcol.width = '100%';
  pcol.height = '100%';
  pcol.paddingLeft = px(16);
  pcol.paddingRight = px(16);
  pcol.paddingTop = px(12);
  pcol.paddingBottom = px(12);
  panel.root.addControl(pcol);
  const titleFont = fs(22);
  const titleHeight = Math.ceil(titleFont * 1.5);
  const buttonHeight = Math.max(52, Math.ceil(fs(17) * 1.35) + 18);
  pcol.addControl(mkLabel(t('Как играть'), {
    color: SKIN.gold, fontSize: titleFont, width: '100%', height: titleHeight,
  }));
  const scroll = new ScrollViewer('hscroll');
  scroll.thickness = 0;
  scroll.width = '100%';
  scroll.height = px(Math.max(90, panelHeight - titleHeight - buttonHeight - 54));
  pcol.addControl(scroll);
  enableSmoothScroll(scroll);

  // ScrollViewer оставляет место под полосу прокрутки.
  const contentW = Math.max(160, panelWidth - 68);
  const col = new StackPanel('rulesCol');
  col.isVertical = true;
  col.spacing = Math.max(8, Math.ceil(fs(12) * 0.7));
  col.width = px(contentW);
  col.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  scroll.addControl(col);

  const headFont = fs(17);
  const noteFont = fs(14);
  const capFont = fs(12);
  const tileH = Math.max(30, Math.round(fs(15) * 2));
  const tile = (text: number | string, color: number, joker = false): RuleTile => ({
    text: String(text), color: joker ? colorHex(YELLOW) : colorHex(color), joker,
  });
  const addHead = (text: string): void => {
    col.addControl(mkLabel(text, {
      color: SKIN.gold, fontSize: headFont, width: contentW, align: 'left', hAlign: 'left',
      height: Math.ceil(estimateWrappedTextHeight(text, contentW, headFont) + 6),
    }));
  };
  const addNote = (text: string): void => {
    col.addControl(mkLabel(text, {
      color: '#ffffffDD', fontSize: noteFont, width: contentW, noWrap: false, vAlign: 'top',
      align: 'left', hAlign: 'left',
      height: Math.ceil(estimateWrappedTextHeight(text, contentW, noteFont) + 6),
    }));
  };
  const addCaption = (text: string): void => {
    col.addControl(mkLabel(text, {
      color: SKIN.textDim, fontSize: capFont, width: contentW, noWrap: false, vAlign: 'top',
      align: 'left', hAlign: 'left',
      height: Math.ceil(estimateWrappedTextHeight(text, contentW, capFont) + 4),
    }));
  };
  const addDemo = (control: Control): void => {
    control.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    col.addControl(control);
  };

  addHead(t('Цель'));
  addNote(t('Победа: рука пуста'));
  addDemo(ruleRow([tile(3, RED), tile(5, BLUE), tile(9, ORANGE)], tileH));
  addDemo(ruleArrow('↓', noteFont));
  addCaption('0 ✓');

  addHead(t('Колода'));
  addNote(t('Джокер заменяет любое число'));
  addDemo(ruleRow([tile(1, RED), tile(7, BLUE), tile(13, BLACK), tile('★', YELLOW, true)], tileH));

  addHead(t('Ход'));
  addNote(t('Одно действие за ход'));
  addNote(t('Выложи число или возьми из колоды'));
  addDemo(ruleRow([tile(2, RED), tile(4, BLUE), tile(6, ORANGE)], tileH));
  addDemo(ruleArrow('↓', noteFont));
  addDemo(ruleRow([tile(6, ORANGE)], tileH, RULE_OK));

  addHead(t('Ряды'));
  addNote(t('Серия: по порядку, один цвет'));
  addDemo(ruleRow([tile(5, RED), tile(6, RED), tile(7, RED)], tileH, RULE_OK));
  addNote(t('Набор: одно число, разные цвета'));
  addDemo(ruleRow([tile(7, RED), tile(7, BLUE), tile(7, BLACK)], tileH, RULE_OK));
  addNote(t('Можно перестраивать стол'));

  addHead(t('Первый ход'));
  addNote(t('Первый ход: минимум 30 очков'));
  addDemo(ruleRow([tile(10, RED), tile(10, BLUE), tile(10, BLACK)], tileH, RULE_OK));
  addCaption('10 + 10 + 10 = 30');

  addHead(t('Сохранить и вернуть'));
  addNote(t('Сохранить — запомнить расклад стола'));
  addNote(t('Вернуть — восстановить сохранённый расклад'));
  addCaption(t('Сохранённый расклад'));
  addDemo(ruleRow([tile(5, RED), tile(6, RED), tile(7, RED)], tileH, RULE_OK));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('После перестановки'));
  addDemo(ruleRow([tile(5, RED), tile(6, RED), tile(7, RED), tile(8, RED)], tileH, RULE_WARN));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('Вернуть'));
  addDemo(ruleRow([tile(5, RED), tile(6, RED), tile(7, RED)], tileH, RULE_OK));

  const btn = mkButton(t('Закрыть'), {
    fontSize: fs(17), height: buttonHeight, width: Math.min(200, panelWidth - 40), theme: BUTTON_STYLE.green,
  });
  btn.onPointerUpObservable.add(close);
  pcol.addControl(btn);
}

export function openStatsOverlay(
  parent: Host,
  opts: { loadOnline?: () => Promise<OnlineStats | null> } = {},
): void {
  const vw = viewWidth();
  const vh = viewHeight();
  const panelWidth = Math.min(vw - 24, 420);
  const panelHeight = Math.min(vh - 24, 560);
  const contentWidth = Math.max(120, panelWidth - 68);
  const host = parent as import('@babylonjs/gui').Container;
  const { overlay, close } = modalOverlay(host, 'statsOverlay', { zIndex: 820 });
  let closed = false;
  const closeOv = (): void => {
    closed = true;
    close();
  };
  const panel = softPanel({
    bg: SKIN.panelDark,
    border: '#ffffff40',
    thickness: 2,
    corner: 14,
    width: panelWidth,
    height: panelHeight,
  });
  overlay.addControl(panel.root);
  const pcol = new StackPanel('pcol');
  pcol.isVertical = true;
  pcol.spacing = 10;
  pcol.width = '100%';
  pcol.height = '100%';
  pcol.paddingLeft = px(16);
  pcol.paddingRight = px(16);
  pcol.paddingTop = px(12);
  pcol.paddingBottom = px(12);
  panel.root.addControl(pcol);
  const titleHeight = Math.ceil(fs(22) * 1.45);
  const closeHeight = Math.max(48, Math.ceil(fs(16) * 1.35) + 16);
  pcol.addControl(mkLabel(t('Статистика'), { color: SKIN.gold, fontSize: fs(22), height: titleHeight }));
  const scroll = new ScrollViewer('statsScroll');
  scroll.thickness = 0;
  scroll.width = '100%';
  scroll.height = px(Math.max(80, panelHeight - titleHeight - closeHeight - 56));
  pcol.addControl(scroll);
  enableSmoothScroll(scroll);

  const col = new StackPanel('statsCol');
  col.isVertical = true;
  col.width = '100%';
  col.spacing = 6;
  scroll.addControl(col);

  const lineFont = fs(17);
  const lineHeightFor = (text: string, size: number): number =>
    Math.max(Math.ceil(size * 1.45), estimateWrappedTextHeight(text, contentWidth, size));
  const addLine = (
    text: string,
    color = SKIN.text,
    size = lineFont,
  ): ReturnType<typeof mkLabel> => {
    const lab = mkLabel(text, {
      fontSize: size,
      color,
      width: contentWidth,
      height: lineHeightFor(text, size),
      align: 'left',
      hAlign: 'left',
      vAlign: 'top',
      noWrap: false,
    });
    col.addControl(lab);
    return lab;
  };
  const setLine = (lab: ReturnType<typeof mkLabel>, text: string, size = lineFont): void => {
    lab.text = text;
    lab.height = px(lineHeightFor(text, size));
  };
  // Единый блок: локальные и сетевые партии объединены в общие числа.
  const S = loadSettings();
  const gamesLab = addLine(t('Сыграно партий: %d', S.stat_games));
  const winsLab = addLine(t('Побед: %d', S.stat_wins));
  const lossesLab = addLine(t('Поражений: %d', S.stat_losses));
  const unfinished = Math.max(0, S.stat_games - S.stat_wins - S.stat_losses);
  if (unfinished > 0) addLine(t('Незавершённых: %d', unfinished), '#ffffff8c', fs(15));
  const noteLab = addLine(t('Загружаем статистику сети…'), '#ffffff8c', fs(14));

  const applyMerged = (st: OnlineStats | null): void => {
    const games = S.stat_games + (st ? st.games : 0);
    const wins = S.stat_wins + (st ? st.wins : 0);
    const losses = S.stat_losses + (st ? Math.max(0, st.games - st.wins) : 0);
    setLine(gamesLab, t('Сыграно партий: %d', games));
    setLine(winsLab, t('Побед: %d', wins));
    setLine(lossesLab, t('Поражений: %d', losses));
    if (st && st.rank !== undefined) {
      setLine(noteLab, t('Место в таблице: %d', st.rank), fs(14));
      noteLab.isVisible = true;
    } else if (st) {
      noteLab.isVisible = false;
    } else {
      setLine(noteLab, t('Нет данных о сетевых партиях'), fs(14));
      noteLab.isVisible = true;
    }
  };

  if (opts.loadOnline) {
    void opts.loadOnline().then((st) => {
      if (closed) return;
      applyMerged(st);
    }).catch(() => {
      if (closed) return;
      applyMerged(null);
    });
  } else {
    applyMerged(null);
    // Площадка без онлайна: серверных данных нет, упоминание о них лишнее.
    noteLab.isVisible = false;
  }

  const closeBtn = mkButton(t('Закрыть'), {
    fontSize: fs(16),
    height: closeHeight,
    width: Math.min(200, contentWidth),
    theme: BUTTON_STYLE.green,
  });
  closeBtn.onPointerUpObservable.add(closeOv);
  pcol.addControl(closeBtn);
}

export function openSettingsOverlay(
  parent: Host,
  ctx: DropdownCtx,
  onDone: () => void,
  onRebuild: () => void,
): void {
  const vw = viewWidth();
  const vh = viewHeight();
  const panelWidth = Math.min(vw - 24, 440);
  const panelHeight = Math.min(vh - 24, 560);
  const contentWidth = panelWidth - 36;
  const fieldFont = fs(15);
  const fieldHeight = Math.max(42, Math.ceil(fieldFont * 1.35) + 14);
  const labelHeight = Math.ceil(fieldFont * 1.35);
  const host = parent as import('@babylonjs/gui').Container;
  const { overlay, close: closeOv } = modalOverlay(host, 'settingsOverlay', { zIndex: 800 });
  const panel = softPanel({
    bg: SKIN.panelDark,
    border: '#ffffff40',
    thickness: 2,
    corner: 14,
    width: panelWidth,
    height: panelHeight,
  });
  overlay.addControl(panel.root);
  const pcol = new StackPanel('pcol');
  pcol.isVertical = true;
  pcol.spacing = 12;
  pcol.width = '100%';
  pcol.height = '100%';
  pcol.paddingLeft = px(16);
  pcol.paddingRight = px(16);
  pcol.paddingTop = px(12);
  pcol.paddingBottom = px(12);
  panel.root.addControl(pcol);
  const titleHeight = Math.ceil(fs(20) * 1.45);
  const closeHeight = Math.max(48, Math.ceil(fs(16) * 1.35) + 16);
  pcol.addControl(mkLabel(t('Настройки'), { color: SKIN.gold, fontSize: fs(20), height: titleHeight }));
  const scroll = new ScrollViewer('settingsScroll');
  scroll.thickness = 0;
  scroll.width = '100%';
  scroll.height = px(Math.max(80, panelHeight - titleHeight - closeHeight - 56));
  pcol.addControl(scroll);
  enableSmoothScroll(scroll);
  const fields = new StackPanel('settingsFields');
  fields.isVertical = true;
  fields.width = '100%';
  fields.spacing = 10;
  scroll.addControl(fields);
  const S = loadSettings();
  const addDropdown = (label: string): ReturnType<typeof dropdownRow> => {
    const field = new StackPanel('settingsField');
    field.isVertical = true;
    field.width = '100%';
    field.spacing = 2;
    field.addControl(mkLabel(label, { fontSize: fieldFont, height: labelHeight, hAlign: 'left', noWrap: true }));
    const dd = dropdownRow('', ctx, { height: fieldHeight, fontSize: fieldFont, btnWidth: contentWidth });
    dd.root.width = '100%';
    field.addControl(dd.root);
    fields.addControl(field);
    return dd;
  };
  const ddText = addDropdown(t('Текст:'));
  ddText.setOptions(TEXT_SCALE_NAMES.map((s) => t(s)), S.text_scale, (i) => {
    saveSettings({ text_scale: i });
    onRebuild();
  });
  const ddTile = addDropdown(t('Карточки:'));
  ddTile.setOptions(TILE_SIZE_NAMES.map((s) => t(s)), S.tile_step, (i) => {
    saveSettings({ tile_step: i });
    onRebuild();
  });
  const ddLang = addDropdown(t('Язык:'));
  ddLang.setOptions(['Русский', 'English'], S.lang === 'en' ? 1 : 0, (i) => {
    saveSettings({ lang: i === 1 ? 'en' : 'ru' });
    onRebuild();
  });
  const chk = checkboxRow(t('Анимация бота'), S.bot_anim, {
    height: Math.max(fieldHeight, Math.ceil(fieldFont * 2.4)),
    fontSize: fieldFont,
    maxLabelWidth: contentWidth - Math.round(fieldHeight * 0.45) - 8,
    onChange: (v: boolean) => saveSettings({ bot_anim: v }),
  });
  chk.root.horizontalAlignment = 0;
  fields.addControl(chk.root);
  // Звук применяется сразу, без пересборки экрана (требование «настройки
  // во время партии действуют немедленно»).
  const chkSound = checkboxRow(t('Звук'), S.sound, {
    height: Math.max(fieldHeight, Math.ceil(fieldFont * 2.4)),
    fontSize: fieldFont,
    maxLabelWidth: contentWidth - Math.round(fieldHeight * 0.45) - 8,
    onChange: (v: boolean) => {
      saveSettings({ sound: v });
      applySoundPreference(v);
    },
  });
  chkSound.root.horizontalAlignment = 0;
  fields.addControl(chkSound.root);
  const close = mkButton(t('Закрыть'), { fontSize: fs(16), height: closeHeight, width: Math.min(180, contentWidth), theme: BUTTON_STYLE.green });
  close.onPointerUpObservable.add(() => {
    closeOv();
    onDone();
  });
  pcol.addControl(close);
}
