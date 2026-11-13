import { ScrollViewer, StackPanel } from '@babylonjs/gui';
import { t } from '../core/lang';
import { fs, loadSettings, saveSettings } from '../core/settings';
import { applySoundPreference } from '../core/sound';
import { rulesText } from '../core/rules';
import { TEXT_SCALE_NAMES, TILE_SIZE_NAMES } from '../core/settings';
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
  const titleHeight = Math.ceil(fs(22) * 1.45);
  const buttonHeight = Math.max(52, Math.ceil(fs(17) * 1.35) + 18);
  pcol.addControl(mkLabel(t('Правила игры'), { color: SKIN.gold, fontSize: fs(22), height: titleHeight }));
  const scroll = new ScrollViewer('hscroll');
  scroll.thickness = 0;
  scroll.width = '100%';
  scroll.height = px(Math.max(90, panelHeight - titleHeight - buttonHeight - 54));
  pcol.addControl(scroll);
  enableSmoothScroll(scroll);
  const rulesWidth = panelWidth - 68;
  const plainRules = rulesPlain();
  const rich = mkLabel(rulesPlain(), {
    fontSize: fs(15), color: '#ffffffE0', vAlign: 'top', hAlign: 'left', align: 'left',
    // ScrollViewer резервирует полосу прокрутки; оставляем ей место,
    // чтобы длинные строки всегда переносились, а не уходили под неё.
    width: rulesWidth,
    height: estimateWrappedTextHeight(plainRules, rulesWidth, fs(15)),
  });
  scroll.addControl(rich);
  window.requestAnimationFrame(() => {
    // Babylon сам знает точную высоту после реального переноса глифов.
    // Оценка выше нужна только для первого кадра до layout-прохода.
    rich.height = px(Math.ceil(rich.computeExpectedHeight()));
  });
  const btn = mkButton(t('Закрыть'), { fontSize: fs(17), height: buttonHeight, width: Math.min(200, panelWidth - 40), theme: BUTTON_STYLE.green });
  btn.onPointerUpObservable.add(close);
  pcol.addControl(btn);
}

function rulesPlain(): string {
  return rulesText().replace(/\[\/?b\]/g, '');
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
