import { Container, Control, Ellipse, Image as GuiImage, Rectangle, ScrollViewer, StackPanel, TextBlock } from '@babylonjs/gui';
import { t } from '../core/lang';
import { fs, fsCapped, loadSettings, saveSettings } from '../core/settings';
import { applySoundPreference } from '../core/sound';
import { TEXT_SCALE_NAMES, TILE_SIZE_NAMES } from '../core/settings';
import { BLACK, BLUE, ORANGE, RED, YELLOW, colorHex } from '../core/tile';
import {
  BUTTON_STYLE,
  ButtonTheme,
  checkboxRow,
  DropdownCtx,
  dropdownRow,
  enableSmoothScroll,
  estimateWrappedTextHeight,
  hrow,
  mkButton,
  mkLabel,
  modalOverlay,
  SKIN,
  softPanel,
  px,
} from './uiskin';
import { viewHeight, viewWidth } from './viewport';
import type { OnlineStats } from './ports';
import { isSoundEnabled, setSoundEnabled } from '../core/audio';
import {
  ACHIEVEMENTS,
  SHOP_ITEMS,
  achievementProgress,
  addOwned,
  applyItem,
  clearItem,
  coins,
  dailyRewardPreview,
  dailyRewardedToday,
  dailyStreak,
  isUnlocked,
  ownsItem,
  rankFor,
  refreshWeek,
  spendCoins,
} from '../core/meta';
import { platform } from '../platform';
import { tableMatTexture, themeById, tileTexture, TilePalette } from './skin_art';

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
const RULE_BAD = '#E53935';

function ruleTile(item: RuleTile, h: number, minW = 22): Container {
  const w = Math.max(minW, Math.round(h * 0.74));
  const root = new Container('ruleTile');
  root.width = px(w);
  root.height = px(h);
  const bg = new Rectangle('ruleTileBg');
  bg.background = item.color;
  bg.color = 'rgba(255,255,255,0.35)';
  bg.thickness = 1;
  bg.cornerRadius = Math.max(2, Math.round(w * 0.16));
  bg.width = '100%';
  bg.height = '100%';
  root.addControl(bg);
  const label = new TextBlock('ruleTileText', item.text);
  label.color = item.joker ? '#3E2A00' : '#ffffff';
  label.fontSize = Math.max(8, Math.round(h * 0.56));
  label.fontFamily = 'Arial, sans-serif';
  if (!item.joker) {
    label.outlineColor = 'rgba(0,0,0,0.5)';
    label.outlineWidth = h < 24 ? 1 : 2;
  }
  label.width = '100%';
  label.height = '100%';
  root.addControl(label);
  return root;
}

function ruleTilesWidth(count: number, h: number, minW = 22): number {
  const gap = Math.max(2, Math.round(h * 0.12));
  const tileW = Math.max(minW, Math.round(h * 0.74));
  return count * tileW + Math.max(0, count - 1) * gap;
}

function ruleTiles(tiles: RuleTile[], h: number, minW = 22): StackPanel {
  const line = new StackPanel('ruleRowTiles');
  line.isVertical = false;
  line.spacing = Math.max(2, Math.round(h * 0.12));
  line.width = px(ruleTilesWidth(tiles.length, h, minW));
  line.height = px(h);
  line.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  for (const tile of tiles) line.addControl(ruleTile(tile, h, minW));
  return line;
}

// Зелёное поле руки и тёмное поле стола — такие же, как в самой игре.
function ruleField(
  tiles: RuleTile[], h: number, hand: boolean, border?: string, minW = 22,
): Container {
  const pad = Math.max(7, Math.round(h * 0.22));
  const root = new Container('ruleField');
  // Пустая рука всё равно сохраняет ширину поля, чтобы стрелка вела в него.
  root.width = px(ruleTilesWidth(Math.max(tiles.length, 3), h, minW) + pad * 2);
  root.height = px(h + pad * 2);
  const bg = new Rectangle('ruleFieldBg');
  bg.background = hand ? SKIN.handBg : SKIN.board;
  bg.color = hand ? 'rgba(255,255,255,0.22)' : (border ?? SKIN.rowBorder);
  bg.thickness = border ? 2 : 1;
  bg.cornerRadius = 10;
  bg.width = '100%';
  bg.height = '100%';
  root.addControl(bg);
  const line = ruleTiles(tiles, h, minW);
  line.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  root.addControl(line);
  return root;
}

// Кнопки в правиле «Сохранить/Вернуть» выглядят как настоящие кнопки игры.
function ruleButton(label: string, h: number, font: number, theme: ButtonTheme): Container {
  const width = Math.max(110, Math.min(220, Math.round(label.length * font * 0.9 + 32)));
  const root = new Container('ruleButton');
  root.width = px(width);
  root.height = px(h);
  const bg = new Rectangle('ruleButtonBg');
  bg.background = theme.bg;
  bg.thickness = 0;
  bg.cornerRadius = 10;
  bg.width = '100%';
  bg.height = '100%';
  root.addControl(bg);
  const text = new TextBlock('ruleButtonText', label);
  text.color = '#ffffff';
  text.fontSize = font;
  text.fontFamily = 'Arial, sans-serif';
  text.width = '100%';
  text.height = '100%';
  root.addControl(text);
  return root;
}

// Длинный ряд переносится на несколько строк, а не уменьшается до микроразмера.
function ruleFieldWrapped(
  tiles: RuleTile[], h: number, maxWidth: number, border?: string,
): Container {
  const pad = Math.max(7, Math.round(h * 0.22));
  const gap = Math.max(2, Math.round(h * 0.12));
  const tileW = Math.max(22, Math.round(h * 0.74));
  const innerW = Math.max(tileW, maxWidth - pad * 2);
  const perLine = Math.max(1, Math.floor((innerW + gap) / (tileW + gap)));
  const lines: RuleTile[][] = [];
  for (let i = 0; i < tiles.length; i += perLine) lines.push(tiles.slice(i, i + perLine));
  const lineGap = Math.max(4, Math.round(h * 0.12));
  const width = Math.min(maxWidth, Math.max(...lines.map((line) => ruleTilesWidth(line.length, h))) + pad * 2);
  const height = lines.length * h + (lines.length - 1) * lineGap + pad * 2;
  const root = new Container('ruleField');
  root.width = px(width);
  root.height = px(height);
  const bg = new Rectangle('ruleFieldBg');
  bg.background = SKIN.board;
  bg.color = border ?? SKIN.rowBorder;
  bg.thickness = border ? 2 : 1;
  bg.cornerRadius = 10;
  bg.width = '100%';
  bg.height = '100%';
  root.addControl(bg);
  const stack = new StackPanel('ruleWrappedLines');
  stack.isVertical = true;
  stack.spacing = lineGap;
  stack.width = px(width - pad * 2);
  stack.height = px(height - pad * 2);
  stack.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  for (const line of lines) {
    const row = ruleTiles(line, h);
    row.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.addControl(row);
  }
  root.addControl(stack);
  return root;
}

// Один этап примера: поле руки и/или поле стола идут вместе.
function ruleStage(items: Control[], h: number): StackPanel {
  const stage = new StackPanel('ruleStage');
  stage.isVertical = true;
  stage.spacing = Math.max(6, Math.round(h * 0.15));
  stage.width = '100%';
  for (const item of items) {
    item.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    stage.addControl(item);
  }
  return stage;
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
  const ruleCaption = (text: string): TextBlock => mkLabel(text, {
    color: SKIN.textDim, fontSize: capFont, width: contentW, noWrap: false, vAlign: 'top',
    align: 'left', hAlign: 'left',
    height: Math.ceil(estimateWrappedTextHeight(text, contentW, capFont) + 4),
  });
  const addCaption = (text: string): void => {
    col.addControl(ruleCaption(text));
  };
  const addDemo = (control: Control): void => {
    control.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    col.addControl(control);
  };
  // Только в разделе «Ряды»: отступ перед подписью (общий spacing колонки),
  // а подпись плотно прижата к своему ряду.
  let rowGroupCount = 0;
  const addRowGroup = (text: string, demo: Control): void => {
    const group = new StackPanel('ruleGroup');
    group.isVertical = true;
    group.spacing = Math.max(0, Math.round(capFont * 0.1));
    group.width = '100%';
    // Дополнительный отступ сверху у всех групп, кроме первой: между рядом
    // и следующей подписью становится больше воздуха.
    group.paddingTop = px(rowGroupCount > 0 ? Math.max(8, Math.round(capFont * 0.6)) : 0);
    rowGroupCount += 1;
    const lab = ruleCaption(text);
    lab.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    group.addControl(lab);
    demo.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    group.addControl(demo);
    col.addControl(group);
  };

  addHead(t('Цель'));
  addCaption(t('Зелёное — ваша рука, тёмное — стол'));
  addCaption(t('Ваши фишки в руке'));
  addDemo(ruleField([tile(3, RED), tile(5, BLUE), tile(9, ORANGE)], tileH, true));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('Рука пуста — вы победили'));
  addDemo(ruleField([], tileH, true));

  addHead(t('Фишки'));
  addCaption(t('Неправильно: меньше 3 фишек'));
  addDemo(ruleField([tile(1, RED), tile(2, RED)], tileH, false, RULE_BAD));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('Правильно: три подряд'));
  addDemo(ruleField([tile(1, RED), tile(2, RED), tile(3, RED)], tileH, false, RULE_OK));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('Или так: джокер заменяет фишку'));
  addDemo(ruleField([tile(1, RED), tile(2, RED), tile('★', YELLOW, true)], tileH, false, RULE_OK));

  addHead(t('Ряды'));
  addRowGroup(t('Серия из 13 фишек — от 1 до 13'), ruleFieldWrapped(
    Array.from({ length: 13 }, (_, i) => tile(i + 1, RED)),
    tileH, contentW, RULE_OK,
  ));
  addRowGroup(t('Серия из 3 фишек — 5, 6, 7'),
    ruleField([tile(5, RED), tile(6, RED), tile(7, RED)], tileH, false, RULE_OK));
  addRowGroup(t('Набор из 4 фишек — четыре цвета'), ruleField([
    tile(1, RED), tile(1, BLUE), tile(1, BLACK), tile(1, ORANGE),
  ], tileH, false, RULE_OK));
  addRowGroup(t('Набор из 3 фишек — три цвета'),
    ruleField([tile(1, RED), tile(1, BLUE), tile(1, BLACK)], tileH, false, RULE_OK));

  addHead(t('Ход'));
  addCaption(t('В руке — чёрная 7'));
  addDemo(ruleStage([ruleField([tile(7, BLACK)], tileH, true)], tileH));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('На поле — три семёрки разных цветов'));
  addDemo(ruleStage([
    ruleField([tile(7, RED), tile(7, BLUE), tile(7, ORANGE)], tileH, false, RULE_OK),
  ], tileH));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('Выложили её: рука пуста, в ряду четыре 7'));
  addDemo(ruleStage([
    ruleField([], tileH, true),
    ruleField([
      tile(7, RED), tile(7, BLUE), tile(7, ORANGE), tile(7, BLACK),
    ], tileH, false, RULE_OK),
  ], tileH));

  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('Теперь сложнее: снова чёрная 7 в руке'));
  addDemo(ruleStage([ruleField([tile(7, BLACK)], tileH, true)], tileH));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('На поле два ряда: 4-5-6-7 красные и синие'));
  addDemo(ruleStage([
    ruleField([tile(4, RED), tile(5, RED), tile(6, RED), tile(7, RED)], tileH, false, RULE_OK),
    ruleField([tile(4, BLUE), tile(5, BLUE), tile(6, BLUE), tile(7, BLUE)], tileH, false, RULE_OK),
  ], tileH));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('Взяли обе 7, сделали новый ряд — победили'));
  addDemo(ruleStage([
    ruleField([], tileH, true),
    ruleField([tile(4, RED), tile(5, RED), tile(6, RED)], tileH, false, RULE_OK),
    ruleField([tile(4, BLUE), tile(5, BLUE), tile(6, BLUE)], tileH, false, RULE_OK),
    ruleField([tile(7, RED), tile(7, BLUE), tile(7, BLACK)], tileH, false, RULE_OK),
  ], tileH));
  addCaption(t('Или возьмите фишку из колоды — ход завершится'));

  addHead(t('Сохранить и вернуть'));
  const ruleBtnH = Math.max(36, Math.ceil(noteFont * 1.9));
  addCaption(t('Ряд, который хотим сохранить'));
  addDemo(ruleField([tile(5, RED), tile(6, RED), tile(7, RED)], tileH, false, RULE_OK));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('Нажмите «Сохранить»'));
  addDemo(ruleButton(t('Сохранить'), ruleBtnH, noteFont, BUTTON_STYLE.green));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('Переставили фишки'));
  addDemo(ruleField([tile(5, RED), tile(6, RED), tile(7, RED), tile(8, RED)], tileH, false, RULE_WARN));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('Нажмите «Вернуть»'));
  addDemo(ruleButton(t('Вернуть'), ruleBtnH, noteFont, BUTTON_STYLE.deck));
  addDemo(ruleArrow('↓', noteFont));
  addCaption(t('Ряд восстановлен'));
  addDemo(ruleField([tile(5, RED), tile(6, RED), tile(7, RED)], tileH, false, RULE_OK));

  addHead(t('Первый ход'));
  addCaption(t('Необязательно: от 30 очков, если включено в настройках'));
  addDemo(ruleField([tile(10, RED), tile(10, BLUE), tile(10, BLACK)], tileH, false, RULE_OK));
  addCaption('30');

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
  const rankInfo = rankFor(S.stat_wins);
  addLine(t('Звание: %s', rankInfo.name), '#FFE9B0');
  addLine(t('Побед за неделю: %d', refreshWeek()));
  addLine(t('Монеты: %d', coins()), '#FFE9B0');
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
  const ddLang = addDropdown(t('Язык'));
  ddLang.setOptions(['Русский', 'English'], S.lang === 'en' ? 1 : 0, (i) => {
    saveSettings({ lang: i === 1 ? 'en' : 'ru' });
    onRebuild();
  });
  const soundChk = checkboxRow(t('Звук'), isSoundEnabled(), {
    height: Math.max(fieldHeight, Math.ceil(fieldFont * 2.4)),
    fontSize: fieldFont,
    maxLabelWidth: contentWidth - Math.round(fieldHeight * 0.45) - 8,
    onChange: (v: boolean) => setSoundEnabled(v),
  });
  soundChk.root.horizontalAlignment = 0;
  fields.addControl(soundChk.root);
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

// ===== магазин =====
export function openShopOverlay(parent: Host, onChanged: () => void): void {
  const vw = viewWidth();
  const vh = viewHeight();
  const panelWidth = Math.min(vw - 24, 460);
  const panelHeight = Math.min(vh - 24, 640);
  const contentWidth = Math.max(140, panelWidth - 56);
  const host = parent as import('@babylonjs/gui').Container;
  const { overlay, close } = modalOverlay(host, 'shopOverlay', { zIndex: 820 });
  const panel = softPanel({
    bg: SKIN.panelDark, border: '#ffffff40', thickness: 2, corner: 14,
    width: panelWidth, height: panelHeight,
  });
  overlay.addControl(panel.root);
  const pcol = new StackPanel('shopCol');
  pcol.isVertical = true;
  pcol.spacing = 8;
  pcol.width = '100%';
  pcol.height = '100%';
  pcol.paddingLeft = px(14);
  pcol.paddingRight = px(14);
  pcol.paddingTop = px(10);
  pcol.paddingBottom = px(10);
  panel.root.addControl(pcol);

  const head = hrow(8);
  head.width = '100%';
  head.height = px(34);
  head.addControl(mkLabel(t('Магазин'), { color: SKIN.gold, fontSize: fs(21), width: Math.max(80, contentWidth - 120), align: 'left', hAlign: 'left' }));
  const coinsLabel = mkLabel(`● ${coins()}`, { color: '#FFE9B0', fontSize: fs(17), width: 110, align: 'right', hAlign: 'right' });
  head.addControl(coinsLabel);
  pcol.addControl(head);

  const closeH = Math.max(46, Math.ceil(fs(16) * 1.35) + 14);
  // Витрина примерки: сукно и фишки выбранного товара, даже если он не куплен.
  const previewH = 104;

  // ===== витрина =====
  const preview = softPanel({ bg: '#FFFFFF08', border: '#ffffff22', thickness: 1, corner: 10 });
  preview.root.width = '100%';
  preview.root.height = px(previewH);
  pcol.addControl(preview.root);
  const previewFelt = new GuiImage('shopPreviewFelt', tableMatTexture(themeById(loadSettings().table_theme), contentWidth, previewH - 30, 8));
  previewFelt.width = px(contentWidth);
  previewFelt.height = px(previewH - 30);
  previewFelt.stretch = GuiImage.STRETCH_FILL;
  previewFelt.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  previewFelt.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  previewFelt.top = px(4);
  previewFelt.isHitTestVisible = false;
  preview.root.addControl(previewFelt);
  const previewTiles = new StackPanel('shopPreviewTiles');
  previewTiles.isVertical = false;
  previewTiles.spacing = 5;
  previewTiles.width = px(3 * 26 + 10);
  previewTiles.height = px(26);
  previewTiles.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  previewTiles.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  previewTiles.top = px(Math.round((previewH - 30 - 26) / 2) + 4);
  previewTiles.isHitTestVisible = false;
  preview.root.addControl(previewTiles);
  const previewCap = mkLabel(t('Нажмите «Пример», чтобы увидеть оформление'), {
    color: '#ffffffA8', fontSize: fs(11), width: contentWidth, height: Math.ceil(fs(11) * 1.5),
    align: 'center', hAlign: 'center', vAlign: 'bottom', noWrap: true,
  });
  previewCap.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  previewCap.top = px(-4);
  previewCap.isHitTestVisible = false;
  preview.root.addControl(previewCap);

  const scroll = new ScrollViewer('shopScroll');
  scroll.thickness = 0;
  scroll.barSize = 4;
  scroll.width = '100%';
  scroll.height = px(Math.max(100, panelHeight - 34 - previewH - 12 - closeH - 40));
  pcol.addControl(scroll);
  enableSmoothScroll(scroll);
  const list = new StackPanel('shopList');
  list.isVertical = true;
  list.spacing = 8;
  list.width = '100%';
  scroll.addControl(list);

  const applyPreview = (theme: string, palette: string, caption: string): void => {
    previewFelt.source = tableMatTexture(themeById(theme), contentWidth, previewH - 30, 8);
    previewTiles.clearControls();
    for (const value of [5, 6, 7]) {
      const img = new GuiImage(`previewTile${value}`, tileTexture(
        { id: value, color: 0, value, is_joker: false }, false, palette as TilePalette,
      ));
      img.width = px(26);
      img.height = px(26 * 1.4);
      img.stretch = GuiImage.STRETCH_FILL;
      img.isHitTestVisible = false;
      previewTiles.addControl(img);
    }
    previewTiles.height = px(Math.round(26 * 1.4));
    previewTiles.top = px(4 + Math.round((previewH - 30 - 26 * 1.4) / 2));
    previewCap.text = caption;
  };

  const previewFor = (item: (typeof SHOP_ITEMS)[number]): void => {
    const settings = loadSettings();
    let theme = settings.table_theme;
    let palette = settings.tile_palette;
    if (item.kind === 'theme') theme = item.id;
    else if (item.kind === 'palette') palette = item.id;
    else if (item.kind === 'bundle') {
      theme = 'royal';
      palette = 'amber';
    }
    if (item.kind === 'remove_ads') {
      previewCap.text = t('Без рекламы: баннеры и вставки не появятся');
      return;
    }
    applyPreview(theme, palette, t('%s · примерка', t(item.title)));
  };
  const currentSettings = loadSettings();
  applyPreview(
    currentSettings.table_theme,
    currentSettings.tile_palette,
    t('Текущее оформление'),
  );

  const rebuild = (): void => {
    list.clearControls();
    const S = loadSettings();
    for (const item of SHOP_ITEMS) {
      const bundleIds = ['royal', 'burgundy', 'amber', 'marble'];
      const owned = item.kind === 'remove_ads'
        ? S.ads_removed
        : item.kind === 'bundle'
          ? bundleIds.every((id) => ownsItem(id))
          : ownsItem(item.id);
      const current = (item.kind === 'theme' && S.table_theme === item.id)
        || (item.kind === 'palette' && S.tile_palette === item.id);
      const row = softPanel({ bg: '#FFFFFF0D', border: current ? '#FFD54F88' : '#ffffff1A', thickness: 1, corner: 10 });
      row.root.width = '100%';
      // Высота строки и положение текста считаются от кегля: при крупном
      // тексте блок остаётся по центру, а не прижимается к низу карточки.
      const titleFont = fsCapped(16, 1);
      const descFont = fsCapped(12, 1);
      const titleText = t(item.title);
      const descText = t(item.desc);
      const canPreview = item.kind !== 'remove_ads';
      const textW = contentWidth - (canPreview ? 200 : 130);
      const titleH = Math.max(20, Math.ceil(titleFont * 1.3));
      const descH = Math.max(18, Math.ceil(estimateWrappedTextHeight(descText, textW, descFont)));
      const rowH = Math.max(80, titleH + descH + 18);
      row.root.height = px(rowH);
      list.addControl(row.root);
      const box = new Container('shopRow');
      box.width = px(contentWidth);
      box.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
      row.root.addControl(box);
      const textTop = Math.round((rowH - (titleH + 3 + descH)) / 2);
      const title = mkLabel(titleText, {
        fontSize: titleFont, color: current ? SKIN.gold : '#ffffff', width: textW, height: titleH,
        align: 'left', hAlign: 'left', vAlign: 'top', noWrap: true,
      });
      title.left = px(10);
      title.top = px(textTop);
      title.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
      box.addControl(title);
      const desc = mkLabel(descText, {
        fontSize: descFont, color: '#ffffff9C', width: textW, height: descH,
        align: 'left', hAlign: 'left', vAlign: 'top', noWrap: false,
      });
      desc.left = px(10);
      desc.top = px(textTop + titleH + 3);
      desc.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
      box.addControl(desc);
      if (canPreview) {
        // Примерка: оформление показывается на витрине даже без покупки.
        const pv = mkButton(t('Пример'), {
          height: 36, width: 64, fontSize: fs(12), corner: 8,
          theme: { bg: '#26303FCC', hover: '#46566D', press: '#1E2733', border: '#ffffff22' },
        });
        pv.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        pv.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        pv.left = px(-128);
        pv.onPointerUpObservable.clear();
        pv.onPointerUpObservable.add(() => previewFor(item));
        box.addControl(pv);
      }

      let label = '';
      let enabled = true;
      if (owned) {
        if (item.kind === 'bundle') {
          label = t('Куплено');
          enabled = false;
        } else if (item.kind === 'remove_ads') {
          // Постоянная покупка: снять её нельзя.
          label = t('Включено');
          enabled = false;
        } else {
          // Выбранное можно снять и включить снова, покупка остаётся.
          label = current ? t('Снять') : t('Выбрать');
        }
      } else if (item.kind === 'remove_ads' || item.kind === 'bundle') {
        label = platform.supportsPayments ? t('Купить') : t('Недоступно');
        enabled = platform.supportsPayments;
      } else {
        label = t('%d монет', item.price);
        enabled = coins() >= item.price;
      }
      const btnW = 112;
      const btn = mkButton(label, {
        height: 40, width: btnW, fontSize: fs(13), corner: 9,
        theme: !enabled
          ? { bg: '#3A414A', hover: '#3A414A', press: '#3A414A', border: '#ffffff18' }
          : current
            ? { bg: '#2E7D32', hover: '#388E3C', press: '#1B5E20' }
            : BUTTON_STYLE.green,
      });
      btn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
      btn.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
      btn.left = px(-8);
      btn.isEnabled = enabled;
      btn.onPointerUpObservable.clear();
      btn.onPointerUpObservable.add(() => {
        if (owned) {
          if (item.kind === 'theme' || item.kind === 'palette') {
            if (current) clearItem(item.id);
            else applyItem(item.id);
            applyPreview(
              loadSettings().table_theme,
              loadSettings().tile_palette,
              t('Текущее оформление'),
            );
            refresh();
          }
          return;
        }
        if (item.kind === 'remove_ads' || item.kind === 'bundle') {
          btn.isEnabled = false;
          void platform.purchase(item.iapProduct ?? item.id).then((ok) => {
            if (!ok) {
              btn.isEnabled = true;
              btn.textBlock!.text = t('Ошибка оплаты');
              return;
            }
            if (item.kind === 'bundle') {
              for (const id of ['royal', 'burgundy', 'amber', 'marble']) {
                addOwned(id);
                applyItem(id);
              }
            } else {
              addOwned('remove_ads');
              applyItem('remove_ads');
            }
            refresh();
          });
          return;
        }
        if (!spendCoins(item.price)) return;
        addOwned(item.id);
        applyItem(item.id);
        applyPreview(
          loadSettings().table_theme,
          loadSettings().tile_palette,
          t('Текущее оформление'),
        );
        refresh();
      });
      box.addControl(btn);
    }
  };
  rebuild();

  // Магазин обновляется на месте: купленное/снятое видно сразу, без
  // закрытия окна. Меню за оверлеем пересоберётся при закрытии.
  const refresh = (): void => {
    rebuild();
    coinsLabel.text = `● ${coins()}`;
  };

  const closeBtn = mkButton(t('Закрыть'), {
    fontSize: fs(16), height: closeH, width: Math.min(180, contentWidth), theme: BUTTON_STYLE.green,
  });
  closeBtn.onPointerUpObservable.add(() => {
    close();
    onChanged();
  });
  pcol.addControl(closeBtn);
}

// ===== достижения =====
export function openAchievementsOverlay(parent: Host): void {
  const vw = viewWidth();
  const vh = viewHeight();
  const panelWidth = Math.min(vw - 24, 460);
  const panelHeight = Math.min(vh - 24, 640);
  const contentWidth = Math.max(140, panelWidth - 56);
  const host = parent as import('@babylonjs/gui').Container;
  const { overlay, close } = modalOverlay(host, 'achOverlay', { zIndex: 820 });
  const panel = softPanel({
    bg: SKIN.panelDark, border: '#ffffff40', thickness: 2, corner: 14,
    width: panelWidth, height: panelHeight,
  });
  overlay.addControl(panel.root);
  const pcol = new StackPanel('achCol');
  pcol.isVertical = true;
  pcol.spacing = 8;
  pcol.width = '100%';
  pcol.height = '100%';
  pcol.paddingLeft = px(14);
  pcol.paddingRight = px(14);
  pcol.paddingTop = px(10);
  pcol.paddingBottom = px(10);
  panel.root.addControl(pcol);

  const unlocked = ACHIEVEMENTS.filter((a) => isUnlocked(a.id)).length;
  const head = hrow(8);
  head.width = '100%';
  head.height = px(34);
  head.addControl(mkLabel(t('Достижения'), { color: SKIN.gold, fontSize: fs(21), width: Math.max(80, contentWidth - 110), align: 'left', hAlign: 'left' }));
  head.addControl(mkLabel(t('%d из %d', unlocked, ACHIEVEMENTS.length), {
    color: '#FFE9B0', fontSize: fs(15), width: 100, align: 'right', hAlign: 'right',
  }));
  pcol.addControl(head);

  const closeH = Math.max(46, Math.ceil(fs(16) * 1.35) + 14);
  const scroll = new ScrollViewer('achScroll');
  scroll.thickness = 0;
  scroll.barSize = 4;
  scroll.width = '100%';
  scroll.height = px(Math.max(120, panelHeight - 34 - closeH - 40));
  pcol.addControl(scroll);
  enableSmoothScroll(scroll);
  const list = new StackPanel('achList');
  list.isVertical = true;
  list.spacing = 6;
  list.width = '100%';
  scroll.addControl(list);

  for (const a of ACHIEVEMENTS) {
    const got = isUnlocked(a.id);
    const row = softPanel({ bg: got ? '#43A04722' : '#FFFFFF08', border: got ? '#58C36A99' : '#ffffff14', thickness: 1, corner: 10 });
    row.root.width = '100%';
    // Блок текста центрируем по вертикали: при крупном шрифте описание
    // переносится, и фиксированные отступы прижимали его к нижнему краю.
    const titleFont = fsCapped(15, 1);
    const descFont = fsCapped(11, 1);
    const titleText = t(a.title);
    const descText = t(a.desc);
    const textW = contentWidth - 90;
    const titleH = Math.max(20, Math.ceil(titleFont * 1.3));
    const descH = Math.max(18, Math.ceil(estimateWrappedTextHeight(descText, textW, descFont)));
    const prog = got ? null : achievementProgress(a.id);
    const barH = prog ? 7 : 0;
    // Подпись «X/Y» растёт вместе с текстом: раньше её высота была
    // привязана к полоске (13 px), и при крупном шрифте цифры резались
    // сверху и снизу.
    const countFont = fs(10);
    const countH = prog ? Math.max(barH + 6, Math.ceil(countFont * 1.4)) : 0;
    const progH = Math.max(barH, countH);
    const rowH = Math.max(88, titleH + descH + (prog ? 6 + progH + 6 : 0) + 20);
    row.root.height = px(rowH);
    list.addControl(row.root);
    const textTop = Math.round((rowH - (titleH + 3 + descH + (prog ? 6 + progH : 0))) / 2);
    const icon = mkLabel(a.icon, {
      fontSize: fsCapped(22, 1), color: got ? '#9BE7A5' : '#ffffff55', width: 40, height: 40,
      align: 'center', hAlign: 'left', vAlign: 'center',
    });
    icon.left = px(8);
    row.root.addControl(icon);
    const title = mkLabel(titleText, {
      fontSize: titleFont, color: got ? '#DDFFE2' : '#ffffffC0', width: textW, height: titleH,
      align: 'left', hAlign: 'left', vAlign: 'top', noWrap: true,
    });
    title.left = px(48);
    title.top = px(textTop);
    title.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    row.root.addControl(title);
    const desc = mkLabel(descText, {
      fontSize: descFont, color: '#ffffff9C', width: textW, height: descH,
      align: 'left', hAlign: 'left', vAlign: 'top', noWrap: false,
    });
    desc.left = px(48);
    desc.top = px(textTop + titleH + 3);
    desc.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    row.root.addControl(desc);
    if (prog) {
      // Полоска прогресса: видно, сколько осталось до достижения.
      const trackW = Math.max(60, textW - 62);
      const barTop = textTop + titleH + 3 + descH + 6 + Math.round((progH - barH) / 2);
      const track = new Rectangle('achProgressBg');
      track.width = px(trackW);
      track.height = px(barH);
      track.cornerRadius = 3;
      track.thickness = 0;
      track.background = '#FFFFFF1F';
      track.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
      track.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
      track.left = px(48);
      track.top = px(barTop);
      track.isHitTestVisible = false;
      row.root.addControl(track);
      const fill = new Rectangle('achProgressFill');
      fill.width = px(Math.max(3, Math.round(trackW * Math.min(1, prog.have / Math.max(1, prog.need)))));
      fill.height = px(barH);
      fill.cornerRadius = 3;
      fill.thickness = 0;
      fill.background = got ? '#58C36A' : SKIN.gold;
      fill.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
      fill.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
      fill.left = px(48);
      fill.top = px(barTop);
      fill.isHitTestVisible = false;
      row.root.addControl(fill);
      const count = mkLabel(`${Math.min(prog.have, prog.need)}/${prog.need}`, {
        fontSize: countFont, color: '#ffffff80', width: 56, height: countH,
        align: 'right', hAlign: 'right', vAlign: 'center',
      });
      count.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
      count.left = px(-8);
      count.top = px(textTop + titleH + 3 + descH + 6 + Math.round((progH - countH) / 2));
      count.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
      count.isHitTestVisible = false;
      row.root.addControl(count);
    }
    const reward = mkLabel(got ? t('Получено') : `+${a.reward}`, {
      fontSize: fsCapped(12, 1), color: got ? '#9BE7A5' : '#FFD54F', width: 80, height: 22,
      align: 'right', hAlign: 'right', vAlign: 'center',
    });
    reward.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    reward.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    reward.left = px(-8);
    row.root.addControl(reward);
  }

  const closeBtn = mkButton(t('Закрыть'), {
    fontSize: fs(16), height: closeH, width: Math.min(180, contentWidth), theme: BUTTON_STYLE.green,
  });
  closeBtn.onPointerUpObservable.add(close);
  pcol.addControl(closeBtn);
}

// ===== выбор режима: большие карточки с наглядным примером =====
type PlayMode = 'classic' | 'quick' | 'timed' | 'puzzle' | 'daily';

function modeArt(mode: PlayMode, size: number): Container {
  const root = new Container('modeArt');
  root.width = px(size);
  root.height = px(size);
  root.clipChildren = false;
  if (mode === 'classic') {
    // Настоящее сукно и ряд фишек — как на игровом столе.
    const felt = new GuiImage('modeFelt', tableMatTexture(themeById(loadSettings().table_theme), size, size, 6));
    felt.width = '100%';
    felt.height = '100%';
    felt.stretch = GuiImage.STRETCH_FILL;
    felt.isHitTestVisible = false;
    felt.isPointerBlocker = false;
    root.addControl(felt);
    const tileH = Math.max(18, Math.round(size * 0.3));
    const row = hrow(Math.max(2, Math.round(tileH * 0.12)));
    row.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    row.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    row.addControl(ruleTile({ text: '5', color: colorHex(RED) }, tileH));
    row.addControl(ruleTile({ text: '6', color: colorHex(RED) }, tileH));
    row.addControl(ruleTile({ text: '7', color: colorHex(RED) }, tileH));
    root.addControl(row);
    return root;
  }
  if (mode === 'quick') {
    // Полоса до 50 очков и звезда на финише.
    const panel = softPanel({ bg: '#101A14', border: '#FFD54F55', thickness: 1, corner: 12 });
    panel.root.width = '100%';
    panel.root.height = '100%';
    root.addControl(panel.root);
    const target = mkLabel('50', {
      fontSize: Math.max(18, Math.round(size * 0.3)), color: SKIN.gold,
      width: size - 16, height: Math.round(size * 0.34), align: 'center', hAlign: 'center', vAlign: 'top',
    });
    target.top = px(Math.round(size * 0.1));
    target.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    target.isHitTestVisible = false;
    root.addControl(target);
    const barW = Math.round(size * 0.7);
    const barY = Math.round(size * 0.58);
    const track = new Rectangle('modeBarTrack');
    track.width = px(barW);
    track.height = px(9);
    track.cornerRadius = 4;
    track.thickness = 0;
    track.background = '#FFFFFF22';
    track.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    track.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    track.top = px(barY);
    track.isHitTestVisible = false;
    root.addControl(track);
    const fill = new Rectangle('modeBarFill');
    fill.width = px(Math.round(barW * 0.72));
    fill.height = px(9);
    fill.cornerRadius = 4;
    fill.thickness = 0;
    fill.background = SKIN.gold;
    fill.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    fill.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    fill.left = px(Math.round((size - barW) / 2));
    fill.top = px(barY);
    fill.isHitTestVisible = false;
    root.addControl(fill);
    const star = mkLabel('★', {
      fontSize: Math.max(12, Math.round(size * 0.17)), color: '#FFE9B0',
      width: 18, height: 18, align: 'center', hAlign: 'left', vAlign: 'center',
    });
    star.left = px(Math.round((size - barW) / 2 + barW - 9));
    // Чуть выше центра полосы: звёздочка должна стоять на шкале, а не
    // «свисать» под ней (оптический центр глифа ниже геометрического).
    star.top = px(barY - 8);
    star.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    star.isHitTestVisible = false;
    root.addControl(star);
    return root;
  }
  if (mode === 'puzzle') {
    // Полный стол и пустая рука: нужно выложить все фишки.
    const felt = new GuiImage('modeFelt', tableMatTexture(themeById(loadSettings().table_theme), size, size, 6));
    felt.width = '100%';
    felt.height = '100%';
    felt.stretch = GuiImage.STRETCH_FILL;
    felt.isHitTestVisible = false;
    felt.isPointerBlocker = false;
    root.addControl(felt);
    const tileH = Math.max(11, Math.round(size * 0.17));
    const rowsN = 3;
    const rowGap = Math.max(2, Math.round(size * 0.03));
    const stack = new StackPanel('modePuzzleRows');
    stack.isVertical = true;
    stack.spacing = rowGap;
    stack.width = px(size - 8);
    stack.height = px(rowsN * tileH + (rowsN - 1) * rowGap);
    stack.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    stack.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    const previewRows: { text: string; color: number }[][] = [
      [{ text: '3', color: RED }, { text: '4', color: RED }, { text: '5', color: ORANGE }],
      [{ text: '7', color: BLUE }, { text: '7', color: BLACK }, { text: '7', color: RED }],
      [{ text: '8', color: BLUE }, { text: '1', color: BLACK }, { text: '2', color: ORANGE }],
    ];
    for (const rowDef of previewRows) {
      const line = hrow(2);
      line.height = px(tileH);
      for (const cell of rowDef) {
        line.addControl(ruleTile({ text: cell.text, color: colorHex(cell.color) }, tileH));
      }
      stack.addControl(line);
    }
    root.addControl(stack);
    const zero = mkLabel('0', {
      fontSize: Math.max(12, Math.round(size * 0.2)), color: SKIN.gold,
      width: size - 10, height: Math.round(size * 0.22), align: 'right', hAlign: 'right', vAlign: 'bottom',
    });
    zero.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
    zero.top = px(-2);
    zero.isHitTestVisible = false;
    root.addControl(zero);
    return root;
  }
  if (mode === 'daily') {
    // Календарный листок с сегодняшним числом и звездой: челлендж дня.
    const felt = new GuiImage('modeFelt', tableMatTexture(themeById(loadSettings().table_theme), size, size, 6));
    felt.width = '100%';
    felt.height = '100%';
    felt.stretch = GuiImage.STRETCH_FILL;
    felt.isHitTestVisible = false;
    felt.isPointerBlocker = false;
    root.addControl(felt);
    const cardW = Math.round(size * 0.64);
    const cardH = Math.round(size * 0.72);
    const sheet = new Rectangle('modeDailySheet');
    sheet.width = px(cardW);
    sheet.height = px(cardH);
    sheet.cornerRadius = Math.max(4, Math.round(size * 0.06));
    sheet.thickness = 2;
    sheet.color = '#FFD54F';
    sheet.background = '#1C2B24';
    sheet.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    sheet.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    sheet.isHitTestVisible = false;
    root.addControl(sheet);
    const bandH = Math.max(12, Math.round(cardH * 0.26));
    const band = new Rectangle('modeDailyBand');
    band.width = '100%';
    band.height = px(bandH);
    band.cornerRadius = Math.max(3, Math.round(size * 0.05));
    band.thickness = 0;
    band.background = '#FFD54F';
    band.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    band.isHitTestVisible = false;
    sheet.addControl(band);
    const star = mkLabel('★', {
      fontSize: Math.max(9, Math.round(bandH * 0.7)), color: '#3A2C1A',
      width: cardW, height: bandH, align: 'center', hAlign: 'center', vAlign: 'center',
    });
    star.isHitTestVisible = false;
    band.addControl(star);
    const dayNum = mkLabel(String(new Date().getDate()), {
      fontSize: Math.max(14, Math.round(cardH * 0.34)), color: '#FFE9B0',
      width: cardW, height: Math.round(cardH * 0.44), align: 'center', hAlign: 'center', vAlign: 'center',
    });
    dayNum.top = px(Math.round(bandH * 0.35));
    dayNum.isHitTestVisible = false;
    sheet.addControl(dayNum);
    const coin = mkLabel('●', {
      fontSize: Math.max(10, Math.round(cardH * 0.15)), color: SKIN.gold,
      width: cardW, height: Math.round(cardH * 0.2), align: 'center', hAlign: 'center', vAlign: 'bottom',
    });
    coin.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
    coin.top = px(-2);
    coin.isHitTestVisible = false;
    sheet.addControl(coin);
    return root;
  }
  // На время: циферблат и 5:00.
  const panel = softPanel({ bg: '#101822', border: '#7FB3FF55', thickness: 1, corner: 12 });
  panel.root.width = '100%';
  panel.root.height = '100%';
  root.addControl(panel.root);
  const clockSize = Math.round(size * 0.46);
  const timeFont = Math.max(13, Math.round(size * 0.19));
  const timeH = Math.max(14, Math.ceil(timeFont * 1.3));
  // Часы и подпись держим одной группой: между ними 2–3 px, но текст
  // не наезжает на циферблат. Группа центрируется по иконке.
  const groupGap = Math.max(2, Math.round(size * 0.025));
  const groupH = clockSize + groupGap + timeH;
  const groupTop = Math.max(2, Math.round((size - groupH) / 2));
  const clock = new Ellipse('modeClock');
  clock.width = px(clockSize);
  clock.height = px(clockSize);
  clock.thickness = 3;
  clock.color = '#8FC2FF';
  clock.background = '#FFFFFF0F';
  clock.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  clock.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  clock.top = px(groupTop);
  clock.isHitTestVisible = false;
  root.addControl(clock);
  const hand = new Rectangle('modeClockHand');
  hand.width = px(3);
  hand.height = px(Math.round(clockSize * 0.3));
  hand.thickness = 0;
  hand.background = '#EAF3FF';
  hand.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  hand.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  hand.top = px(groupTop + Math.round(clockSize / 2 - clockSize * 0.3));
  hand.isHitTestVisible = false;
  root.addControl(hand);
  const time = mkLabel('5:00', {
    fontSize: timeFont, color: '#EAF3FF',
    width: size, height: timeH, align: 'center', hAlign: 'center', vAlign: 'center',
  });
  time.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  time.top = px(groupTop + clockSize + groupGap);
  time.isHitTestVisible = false;
  root.addControl(time);
  return root;
}

export function openModesOverlay(
  parent: Host,
  onPick: (mode: PlayMode) => void,
): void {
  const vw = viewWidth();
  const vh = viewHeight();
  const PAD = 10;
  const GAP = 8;
  const panelWidth = Math.min(vw - 24, 440);
  const contentWidth = Math.max(180, panelWidth - 28);
  const artSize = Math.max(56, Math.min(92, Math.round(contentWidth * 0.24)));
  // Карточки режимов — навигация, а не текст правил: при максимальном
  // масштабе шрифта подпись в узкой колонке становится нечитаемой.
  const headFont = fsCapped(20, 1);
  const headH = Math.max(30, Math.ceil(estimateWrappedTextHeight(t('Выберите режим'), contentWidth, headFont)));
  const closeH = Math.max(44, Math.ceil(fsCapped(16, 1) * 1.35) + 12);
  const titleFont = fsCapped(17, 1);
  const descFont = fsCapped(12, 1);
  const badgeFont = fsCapped(10, 1);
  // Ширина текста в карточке. От неё зависит, сколько строк займёт описание
  // при текущем размере шрифта, поэтому высоту карточки считаем заранее.
  const textW = Math.max(80, contentWidth - artSize - 34);

  const dailyDoneToday = dailyRewardedToday();
  const dailyDays = dailyStreak();
  const modes: { mode: PlayMode; title: string; desc: string; accent: string; badge: string | null }[] = [
    {
      mode: 'classic', title: 'Обычный',
      desc: 'Первый, кто остался без фишек в руке, побеждает',
      accent: '#FFD54F', badge: 'По умолчанию',
    },
    {
      mode: 'quick', title: 'Быстрая до 50',
      desc: 'Побеждает первый, кто набрал 50 очков',
      accent: '#7FD1A0', badge: null,
    },
    {
      mode: 'timed', title: 'На время 5:00',
      desc: 'Побеждает тот, у кого больше очков за 5 минут',
      accent: '#8FC2FF', badge: null,
    },
    {
      mode: 'puzzle', title: 'Соло-раскладка',
      desc: 'Разберите перемешанные ряды на серии и наборы',
      accent: '#C69CFF', badge: null,
    },
    {
      mode: 'daily',
      title: 'Челлендж дня',
      desc: dailyDoneToday
        ? t('Один расклад для всех · серия: %d дн.', Math.max(1, dailyDays))
        : t('Один расклад для всех, соперник — «Любитель». Награда раз в день.'),
      accent: '#FFB74D',
      badge: dailyDoneToday
        ? t('Сегодня пройдено')
        : t('Награда +%d ●', dailyRewardPreview()),
    },
  ];
  const cards = modes.map((m) => {
    const titleH = Math.ceil(estimateWrappedTextHeight(t(m.title), textW, titleFont));
    const descH = Math.max(
      Math.ceil(descFont * 1.5),
      Math.ceil(estimateWrappedTextHeight(t(m.desc), textW, descFont)),
    );
    const badgeH = m.badge ? Math.ceil(badgeFont * 1.6) : 0;
    const textH = titleH + 3 + descH + (badgeH > 0 ? 3 + badgeH : 0);
    const cardH = Math.max(artSize + 24, textH + 20);
    return { ...m, titleH, descH, badgeH, cardH };
  });
  const cardsH = cards.reduce((sum, m) => sum + m.cardH, 0) + GAP * (cards.length - 1);
  const needed = PAD * 2 + headH + GAP + cardsH + GAP + closeH;
  // Панель подстраивается под карточки; на низком экране список скроллится.
  const panelHeight = Math.min(vh - 20, needed);
  const host = parent as import('@babylonjs/gui').Container;
  const { overlay, close } = modalOverlay(host, 'modesOverlay', { zIndex: 830 });
  const panel = softPanel({
    bg: SKIN.panelDark, border: '#ffffff40', thickness: 2, corner: 16,
    width: panelWidth, height: panelHeight,
  });
  overlay.addControl(panel.root);
  const col = new StackPanel('modesCol');
  col.isVertical = true;
  col.spacing = GAP;
  col.width = '100%';
  col.height = '100%';
  col.paddingLeft = px(14);
  col.paddingRight = px(14);
  col.paddingTop = px(PAD);
  col.paddingBottom = px(PAD);
  panel.root.addControl(col);
  col.addControl(mkLabel(t('Выберите режим'), {
    color: SKIN.gold, fontSize: headFont, width: contentWidth, height: headH,
    align: 'left', hAlign: 'left', vAlign: 'center',
  }));

  const bodyH = Math.max(80, panelHeight - PAD * 2 - headH - GAP * 2 - closeH);
  const scroll = new ScrollViewer('modesScroll');
  scroll.thickness = 0;
  scroll.barSize = 4;
  scroll.width = '100%';
  scroll.height = px(bodyH);
  col.addControl(scroll);
  enableSmoothScroll(scroll);
  const list = new StackPanel('modesList');
  list.isVertical = true;
  list.spacing = GAP;
  list.width = '100%';
  scroll.addControl(list);

  for (const m of cards) {
    const box = softPanel({ bg: '#FFFFFF0A', border: '#ffffff22', thickness: 1, corner: 12, height: m.cardH });
    box.root.width = '100%';
    box.root.isPointerBlocker = true;
    box.root.onPointerEnterObservable.add(() => {
      box.fill.color = m.accent;
      box.fill.thickness = 2;
    });
    box.root.onPointerOutObservable.add(() => {
      box.fill.color = '#ffffff22';
      box.fill.thickness = 1;
    });
    box.root.onPointerUpObservable.add(() => {
      close();
      onPick(m.mode);
    });
    list.addControl(box.root);

    const art = modeArt(m.mode, artSize);
    art.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    art.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    art.left = px(12);
    art.isHitTestVisible = false;
    box.root.addControl(art);

    const text = new StackPanel('modeText');
    text.isVertical = true;
    text.spacing = 3;
    text.width = px(textW);
    text.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    text.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    text.left = px(artSize + 22);
    text.isHitTestVisible = false;
    box.root.addControl(text);

    text.addControl(mkLabel(t(m.title), {
      color: '#FFFFFF', fontSize: titleFont, width: textW,
      height: m.titleH, align: 'left', hAlign: 'left', noWrap: false, vAlign: 'top',
    }));
    text.addControl(mkLabel(t(m.desc), {
      color: '#ffffffA8', fontSize: descFont, width: textW, height: m.descH,
      align: 'left', hAlign: 'left', vAlign: 'top', noWrap: false,
    }));
    if (m.badge) {
      text.addControl(mkLabel(t(m.badge), {
        color: m.accent, fontSize: badgeFont, width: textW,
        height: m.badgeH, align: 'left', hAlign: 'left', vAlign: 'center',
      }));
    }
  }

  const closeBtn = mkButton(t('Отмена'), {
    fontSize: fsCapped(15, 1), height: closeH, width: Math.min(180, contentWidth), theme: BUTTON_STYLE.deck,
  });
  closeBtn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  closeBtn.onPointerUpObservable.add(close);
  col.addControl(closeBtn);
}
