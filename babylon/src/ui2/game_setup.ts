import { Container, Control, Image as GuiImage, InputText, ScrollViewer, StackPanel } from '@babylonjs/gui';
import { t } from '../core/lang';
import {
  BOT_LEVEL_NAMES,
  MAX_NAME_LEN,
  MAX_PLAYERS,
  MIN_PLAYERS,
  TEXT_SCALE_NAMES,
  TILE_SIZE_NAMES,
  fsCapped,
  loadSettings,
  saveSettings,
  setBot,
  setPlayerCount,
  setPlayerName,
} from '../core/settings';
import {
  BUTTON_STYLE,
  DropdownCtx,
  checkboxRow,
  dropdownRow,
  enableSmoothScroll,
  estimateWrappedTextHeight,
  focusInputOnTap,
  hrow,
  mkButton,
  mkLabel,
  modalOverlay,
  onInputBlur,
  popupList,
  px,
  setInputMaxLength,
  softPanel,
  SKIN,
} from './uiskin';
import { avatarTexture } from './skin_art';
import { viewHeight, viewWidth } from './viewport';
import { applySoundPreference } from '../core/sound';
import { isSoundEnabled, setSoundEnabled } from '../core/audio';

type Host = import('@babylonjs/gui').Container;

interface Preset {
  id: string;
  title: string;
  humans: number;
  bots: number;
}

const PRESETS: Preset[] = [
  { id: '1v3', title: 'Один против трёх', humans: 1, bots: 3 },
  { id: '1v1', title: 'Один против бота', humans: 1, bots: 1 },
  { id: '2local', title: 'Двое на одном устройстве', humans: 2, bots: 0 },
  { id: '4local', title: 'Четверо на одном устройстве', humans: 4, bots: 0 },
];

function presetActive(p: Preset): boolean {
  const s = loadSettings();
  if (s.player_count !== p.humans + p.bots) return false;
  for (let i = 0; i < s.player_count; i += 1) {
    const shouldBeBot = i >= p.humans;
    if ((s.player_is_bot[i] === true) !== shouldBeBot) return false;
  }
  return true;
}

function applyPreset(p: Preset, reopen: () => void): void {
  const total = p.humans + p.bots;
  setPlayerCount(total);
  for (let i = 0; i < total; i += 1) setBot(i, i >= p.humans);
  saveSettings({});
  reopen();
}

export function openGameSetupOverlay(parent: Host, onDone: () => void): void {
  const vw = viewWidth();
  const vh = viewHeight();
  const panelWidth = Math.min(vw - 24, 470);
  const panelHeight = Math.min(vh - 20, 660);
  const contentWidth = Math.max(180, panelWidth - 32);
  const font = fsCapped(15, 1);
  const headFont = fsCapped(20, 1);
  const headH = Math.ceil(headFont * 1.5);
  const closeH = Math.max(46, Math.ceil(fsCapped(16, 1) * 1.35) + 14);

  const { overlay, close } = modalOverlay(parent, 'gameSetupOverlay', { zIndex: 840 });
  const panel = softPanel({
    bg: SKIN.panelDark, border: '#ffffff40', thickness: 2, corner: 16,
    width: panelWidth, height: panelHeight,
  });
  overlay.addControl(panel.root);
  const col = new StackPanel('setupCol');
  col.isVertical = true;
  col.spacing = 8;
  col.width = '100%';
  col.height = '100%';
  col.paddingLeft = px(14);
  col.paddingRight = px(14);
  col.paddingTop = px(10);
  col.paddingBottom = px(10);
  panel.root.addControl(col);

  const popups = new Container('setupPopups');
  popups.width = '100%';
  popups.height = '100%';
  popups.isPointerBlocker = false;
  popups.isHitTestVisible = false;
  overlay.addControl(popups);
  const ctx: DropdownCtx = {
    openFor: (a, items, cur, cb, w) => popupList(popups, a, items, cur, cb, fsCapped(12, 1), w),
  };

  const closeAll = (): void => {
    close();
    onDone();
  };

  col.addControl(mkLabel(t('Настройки партии'), {
    color: SKIN.gold, fontSize: headFont, width: contentWidth, height: headH,
    align: 'left', hAlign: 'left', vAlign: 'center',
  }));

  const scroll = new ScrollViewer('setupScroll');
  scroll.thickness = 0;
  scroll.barSize = 4;
  scroll.width = '100%';
  scroll.height = px(Math.max(120, panelHeight - 20 - headH - closeH - 16));
  col.addControl(scroll);
  enableSmoothScroll(scroll);
  const list = new StackPanel('setupList');
  list.isVertical = true;
  list.spacing = 10;
  list.width = '100%';
  scroll.addControl(list);

  const S = loadSettings();

  // ===== готовые раскладки: наглядные карточки, а не кнопки =====
  list.addControl(mkLabel(t('Быстрый старт'), {
    color: '#ffffffC0', fontSize: fsCapped(13, 1), height: Math.ceil(fsCapped(13, 1) * 1.5),
    align: 'left', hAlign: 'left',
  }));
  const presetGrid = new StackPanel('setupPresets');
  presetGrid.isVertical = true;
  presetGrid.spacing = 8;
  presetGrid.width = '100%';
  list.addControl(presetGrid);
  const avatar = Math.max(22, Math.round(fsCapped(14, 1) * 1.9));
  const presetTextW = Math.max(90, contentWidth - (avatar * 4 + 9) - 24);
  // Заголовки пресетов — короткие подписи: фиксированный базовый кегль
  // надёжнее переносится в узкой колонке, чем максимальный масштаб.
  const presetTitleFont = fsCapped(15, 0);
  for (const preset of PRESETS) {
    const active = presetActive(preset);
    const titleH = Math.max(
      Math.ceil(presetTitleFont * 1.5),
      Math.ceil(estimateWrappedTextHeight(t(preset.title), presetTextW, presetTitleFont)),
    );
    const card = softPanel({
      bg: active ? '#FFD54F18' : '#FFFFFF0A',
      border: active ? '#FFD54FAA' : '#ffffff22',
      thickness: active ? 2 : 1,
      corner: 12,
    });
    card.root.width = '100%';
    card.root.height = px(Math.max(56, avatar + 20, titleH + 16));
    card.root.isPointerBlocker = true;
    card.root.onPointerUpObservable.add(() => applyPreset(preset, reopen));
    presetGrid.addControl(card.root);

    const row = hrow(6);
    row.width = '100%';
    row.height = '100%';
    row.paddingLeft = px(10);
    row.paddingRight = px(10);
    card.root.addControl(row);
    const chips = new StackPanel('presetChips');
    chips.isVertical = false;
    chips.spacing = 3;
    const total = preset.humans + preset.bots;
    const botIds = ['timofey', 'klara', 'arkady', 'max', 'lena'];
    const chipsW = avatar * 4 + 9;
    chips.width = px(chipsW);
    chips.height = px(avatar);
    chips.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    row.addControl(chips);
    // Аватары: человек — гость, боты — свои персонажи.
    for (let i = 0; i < total; i += 1) {
      const isBot = i >= preset.humans;
      const img = new GuiImage(`presetAvatar${i}`, avatarTexture(isBot ? botIds[i % botIds.length] : 'guest'));
      img.width = px(avatar);
      img.height = px(avatar);
      img.stretch = GuiImage.STRETCH_FILL;
      img.isHitTestVisible = false;
      chips.addControl(img);
    }

    const textW = presetTextW;
    const title = mkLabel(t(preset.title), {
      color: active ? SKIN.gold : '#FFFFFF', fontSize: presetTitleFont, width: textW,
      height: titleH, align: 'left', hAlign: 'left', noWrap: false, vAlign: 'top',
    });
    title.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    row.addControl(title);
  }

  // ===== игроки =====
  const countRow = dropdownRow(t('Игроков:'), ctx, {
    height: Math.max(42, Math.ceil(font * 1.4)), fontSize: font, btnWidth: Math.min(120, contentWidth * 0.4),
  });
  const counts: string[] = [];
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n += 1) counts.push(String(n));
  countRow.setOptions(counts, S.player_count - MIN_PLAYERS, (i) => {
    setPlayerCount(Number(counts[i]));
    saveSettings({});
    reopen();
  });
  list.addControl(countRow.root);

  const names = new StackPanel('setupNames');
  names.isVertical = true;
  names.spacing = 8;
  names.width = '100%';
  list.addControl(names);
  const inputH = Math.max(40, Math.ceil(font * 2));
  for (let i = 0; i < S.player_count; i += 1) {
    const row = hrow(8);
    row.width = '100%';
    row.height = px(inputH);
    const input = new InputText(undefined, S.player_names[i] ?? '');
    input.width = px(Math.max(100, contentWidth - 120));
    input.height = px(inputH);
    input.color = SKIN.text;
    input.background = SKIN.deck;
    input.fontSize = font;
    input.fontFamily = 'Arial, sans-serif';
    input.placeholderText = t('Игрок %d', i + 1);
    focusInputOnTap(input);
    setInputMaxLength(input, MAX_NAME_LEN);
    onInputBlur(input, () => setPlayerName(i, input.text));
    row.addControl(input);
    const bot = checkboxRow(t('Бот'), S.player_is_bot[i] ?? false, {
      height: inputH,
      fontSize: font,
      onChange: (v: boolean) => {
        setBot(i, v);
        reopen();
      },
    });
    row.addControl(bot.root);
    names.addControl(row);
  }

  // ===== боты и правила =====
  const diff = dropdownRow(t('Боты:'), ctx, {
    height: Math.max(42, Math.ceil(font * 1.4)), fontSize: font,
    btnWidth: Math.min(220, Math.max(120, contentWidth - 120)),
  });
  diff.setOptions(BOT_LEVEL_NAMES.map((n) => t(n)), S.bot_level, (i) => {
    saveSettings({ bot_level: i });
    reopen();
  });
  list.addControl(diff.root);

  const addCheck = (label: string, value: boolean, onChange: (v: boolean) => void): void => {
    const chk = checkboxRow(label, value, {
      height: Math.max(34, Math.ceil(font * 2)),
      fontSize: font,
      onChange,
    });
    chk.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    list.addControl(chk.root);
  };
  addCheck(t('Первый ход: от 30'), S.require_30, (v) => saveSettings({ require_30: v }));
  addCheck(t('Анимация бота'), S.bot_anim, (v) => saveSettings({ bot_anim: v }));
  addCheck(t('Звук'), isSoundEnabled(), (v) => {
    saveSettings({ sound: v });
    setSoundEnabled(v);
    applySoundPreference(v);
  });

  const optionRow = (label: string, values: string[], current: number, pick: (i: number) => void): void => {
    const dd = dropdownRow(label, ctx, {
      height: Math.max(42, Math.ceil(font * 1.4)), fontSize: font, btnWidth: contentWidth,
    });
    dd.setOptions(values, current, pick);
    list.addControl(dd.root);
  };
  optionRow(t('Текст:'), TEXT_SCALE_NAMES.map((n) => t(n)), S.text_scale, (i) => {
    saveSettings({ text_scale: i });
    reopen();
  });
  optionRow(t('Карточки:'), TILE_SIZE_NAMES.map((n) => t(n)), S.tile_step, (i) => {
    saveSettings({ tile_step: i });
    reopen();
  });
  optionRow(t('Язык'), ['Русский', 'English'], S.lang === 'en' ? 1 : 0, (i) => {
    saveSettings({ lang: i === 1 ? 'en' : 'ru' });
    reopen();
  });

  const done = mkButton(t('Готово'), {
    fontSize: fsCapped(16, 1), height: closeH, width: Math.min(200, contentWidth), theme: BUTTON_STYLE.green,
  });
  done.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  done.onPointerUpObservable.add(closeAll);
  col.addControl(done);

  // Пересобрать окно после изменения количества игроков/ботов/языка.
  function reopen(): void {
    close();
    openGameSetupOverlay(parent, onDone);
  }
}
