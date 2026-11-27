import { Container, Control, Image as GuiImage, InputText, Rectangle, ScrollViewer, StackPanel } from '@babylonjs/gui';
import { appName, t } from '../core/lang';
import {
  BOT_LEVEL_NAMES,
  fs,
  loadSettings,
  MAX_PLAYERS,
  MAX_NAME_LEN,
  MIN_PLAYERS,
  saveSettings,
  setPlayerCount,
  setPlayerName,
  setBot,
  TEXT_SCALE_NAMES,
  TILE_SIZE_NAMES,
} from '../core/settings';
import {
  BUTTON_STYLE,
  checkboxRow,
  dropdownRow,
  enableSmoothScroll,
  estimateWrappedTextHeight,
  focusInputOnTap,
  gapControl,
  hrow,
  mkButton,
  mkLabel,
  onInputBlur,
  popupList,
  setInputMaxLength,
  SKIN,
  softPanel,
  wrapTextToWidth,
  DropdownCtx,
  px,
} from './uiskin';
import { openAchievementsOverlay, openRulesOverlay, openShopOverlay, openStatsOverlay } from './overlays';
import { platform } from '../platform';
import { applySoundPreference } from '../core/sound';
import {
  coins,
  dailyRewardedToday,
  rankFor,
  weekWins,
  ACHIEVEMENTS,
} from '../core/meta';
import { avatarTexture, roomTexture, tileTexture } from './skin_art';

import type { MenuHost } from './ports';
import { viewHeight, viewWidth } from './viewport';

function px1(n: number): string {
  return `${n}px`;
}

export class MenuScreen {
  private popups!: Container;
  private ctx!: DropdownCtx;
  private settingsOpen = false;
  private menuScroll: ScrollViewer | null = null;

  constructor(private host: MenuHost) {}

  build(root: Container): void {
    const vw = viewWidth();
    const vh = viewHeight();
    const avail = Math.max(200, Math.min(vw - 28, 470));
    // Колонка на 16px уже окна скролла: вертикальный скроллбар съедает
    // ширину клиентской области, и иначе включался горизонтальный.
    const colW = Math.max(184, avail - 16);
    const S = loadSettings();

    const bg = new GuiImage('bg', roomTexture(vw, vh));
    bg.width = '100%';
    bg.height = '100%';
    bg.stretch = GuiImage.STRETCH_FILL;
    bg.isHitTestVisible = false;
    bg.isPointerBlocker = false;
    root.addControl(bg);

    const center = new Container('center');
    center.width = '100%';
    center.height = '100%';
    root.addControl(center);

    const scroll = new ScrollViewer('menuScroll');
    scroll.thickness = 0;
    scroll.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    scroll.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    scroll.width = px(avail + 12);
    scroll.height = px1(Math.floor(vh));
    // Горизонтального скролла здесь не должно быть: колонка жёстко
    // ограничена avail, а хвост скроллбара прячем.
    (scroll as unknown as { _horizontalBar: Control })._horizontalBar.isVisible = false;
    (scroll as unknown as { _forceHorizontalBar: boolean })._forceHorizontalBar = false;
    center.addControl(scroll);
    enableSmoothScroll(scroll);
    this.menuScroll = scroll;

    const col = new StackPanel('menuBox');
    col.isVertical = true;
    col.width = px(colW);
    col.paddingLeft = '0px';
    col.paddingTop = px(10);
    col.spacing = 8;
    scroll.addControl(col);

    this.popups = new Container('popups');
    this.popups.width = '100%';
    this.popups.height = '100%';
    this.popups.isPointerBlocker = false;
    this.popups.isHitTestVisible = false;
    root.addControl(this.popups);
    this.ctx = {
      openFor: (a, items, cur, cb, w) => popupList(this.popups, a, items, cur, cb, fs(12), w),
    };

    // pending_room: «вы всё ещё в комнате» с возвратом/отказом
    const pending = this.host.pendingRoom();
    if (pending) this.addPendingBanner(col, colW, pending);
    // Плашка «кто-то играет по сети»: появляется, когда в списке комнат
    // есть хотя бы одна живая комната. Показан ровно один баннер.
    if (!pending && this.host.hasOnlineRooms()) this.addOnlineBanner(col, colW);

    this.addHero(col, colW);
    this.addProfileCard(col, colW);

    // ===== главные действия =====
    const startBtn = mkButton(t('Играть'), { fontSize: fs(22), height: 60, theme: BUTTON_STYLE.green });
    startBtn.width = '100%';
    startBtn.onPointerUpObservable.clear();
    startBtn.onPointerUpObservable.add(() => this.host.onStart('classic'));
    col.addControl(startBtn);

    if (platform.supportsOnline) {
      const onlineBtn = mkButton(t('Играть с другими'), { fontSize: fs(18), height: 52, theme: BUTTON_STYLE.blueOnline });
      onlineBtn.width = '100%';
      onlineBtn.onPointerUpObservable.clear();
      onlineBtn.onPointerUpObservable.add(() => this.host.onOnline());
      col.addControl(onlineBtn);
    }

    // ===== режимы =====
    const modes = hrow(8);
    modes.width = '100%';
    modes.height = px(48);
    const modeW = Math.floor((colW - 8) / 2);
    const quick = mkButton(t('Быстрая до 50'), { fontSize: fs(14), height: 48, width: modeW, theme: BUTTON_STYLE.deck });
    quick.onPointerUpObservable.clear();
    quick.onPointerUpObservable.add(() => this.host.onStart('quick'));
    const timed = mkButton(t('На время 5:00'), { fontSize: fs(14), height: 48, width: modeW, theme: BUTTON_STYLE.deck });
    timed.onPointerUpObservable.clear();
    timed.onPointerUpObservable.add(() => this.host.onStart('timed'));
    modes.addControl(quick);
    modes.addControl(timed);
    col.addControl(modes);

    // ===== мета =====
    const meta1 = hrow(8);
    meta1.width = '100%';
    meta1.height = px(52);
    const daily = mkButton(t('Ежедневная'), { fontSize: fs(14), height: 52, width: modeW, theme: BUTTON_STYLE.deck });
    daily.onPointerUpObservable.clear();
    daily.onPointerUpObservable.add(() => this.host.onStart('daily'));
    if (!dailyRewardedToday()) {
      // Золотая точка: сегодняшняя награда ещё не получена.
      const dot = new Rectangle('dailyDot');
      dot.width = px(10);
      dot.height = px(10);
      dot.cornerRadius = 5;
      dot.thickness = 0;
      dot.background = SKIN.gold;
      dot.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
      dot.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
      dot.left = px(-8);
      dot.top = px(8);
      dot.isHitTestVisible = false;
      dot.isPointerBlocker = false;
      daily.addControl(dot);
    }
    const shop = mkButton(t('Магазин'), { fontSize: fs(14), height: 52, width: modeW, theme: BUTTON_STYLE.deck });
    shop.onPointerUpObservable.clear();
    shop.onPointerUpObservable.add(() => this.openShop());
    meta1.addControl(daily);
    meta1.addControl(shop);
    col.addControl(meta1);

    const meta2 = hrow(8);
    meta2.width = '100%';
    meta2.height = px(52);
    const unlocked = ACHIEVEMENTS.filter((a) => S.achievements.includes(a.id)).length;
    const ach = mkButton(t('Достижения %d/%d', unlocked, ACHIEVEMENTS.length), {
      fontSize: fs(14), height: 52, width: modeW, theme: BUTTON_STYLE.deck,
    });
    ach.onPointerUpObservable.clear();
    ach.onPointerUpObservable.add(() => this.openAchievements());
    const stats = mkButton(t('Статистика'), { fontSize: fs(14), height: 52, width: modeW, theme: BUTTON_STYLE.deck });
    stats.onPointerUpObservable.clear();
    stats.onPointerUpObservable.add(() => this.openStats());
    meta2.addControl(ach);
    meta2.addControl(stats);
    col.addControl(meta2);

    const bottom = hrow(8);
    bottom.width = '100%';
    bottom.height = px(50);
    const rulesBtn = mkButton(t('Как играть'), {
      fontSize: fs(14), height: 50, width: modeW,
      theme: { bg: '#31363F', hover: '#3A404A', press: '#262B33' },
    });
    rulesBtn.onPointerUpObservable.clear();
    rulesBtn.onPointerUpObservable.add(() => this.openHelp());
    const settings = mkButton(t(this.settingsOpen ? 'Скрыть настройки' : 'Настройки партии'), {
      fontSize: fs(14), height: 50, width: modeW,
      theme: this.settingsOpen
        ? { bg: '#5A4A1E', hover: '#6E5A25', press: '#463A17', border: '#FFD54F66' }
        : { bg: '#31363F', hover: '#3A404A', press: '#262B33' },
    });
    settings.onPointerUpObservable.clear();
    settings.onPointerUpObservable.add(() => {
      this.settingsOpen = !this.settingsOpen;
      this.host.rebuild();
      if (this.settingsOpen) {
        window.setTimeout(() => {
          try {
            if (this.menuScroll) this.menuScroll.verticalBar.value = 1;
          } catch {
            /* скролл ещё не готов */
          }
        }, 60);
      }
    });
    bottom.addControl(rulesBtn);
    bottom.addControl(settings);
    col.addControl(bottom);

    if (this.settingsOpen) this.buildSettings(col, colW, S);
  }

  // ===== шапка: три фишки веером, название =====
  private addHero(col: StackPanel, colW: number): void {
    const hero = new Container('hero');
    hero.width = px(colW);
    hero.height = px(86);
    const tileW = 52;
    const tileH = 73;
    const specs: { color: number; value: number; rot: number; x: number }[] = [
      { color: 0, value: 7, rot: -0.18, x: -62 },
      { color: 1, value: 7, rot: 0, x: 0 },
      { color: 3, value: 7, rot: 0.18, x: 62 },
    ];
    for (const s of specs) {
      const img = new GuiImage('heroTile', tileTexture({ id: 0, color: s.color, value: s.value, is_joker: false }, false));
      img.width = px(tileW);
      img.height = px(tileH);
      img.stretch = GuiImage.STRETCH_FILL;
      img.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
      img.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
      img.left = px(s.x);
      img.top = px(4);
      img.rotation = s.rot;
      img.isHitTestVisible = false;
      img.isPointerBlocker = false;
      hero.addControl(img);
    }
    col.addControl(hero);

    const titleText = appName();
    const titleFont = fitFontSize(titleText, colW, fs(40));
    const title = mkLabel(titleText, {
      color: SKIN.gold,
      fontSize: titleFont,
      width: '100%',
      height: Math.max(50, estimateWrappedTextHeight(titleText, colW, titleFont)),
      noWrap: false,
      vAlign: 'center',
    });
    title.outlineColor = 'rgba(0,0,0,0.55)';
    title.outlineWidth = 3;
    col.addControl(title);

    const subtitleFont = fs(15);
    const subtitleText = t('Руммикуб · числа и цвета');
    const subtitle = mkLabel(subtitleText, {
      color: '#ffffffA8', fontSize: subtitleFont, width: colW,
      height: estimateWrappedTextHeight(subtitleText, colW, subtitleFont),
      align: 'center', hAlign: 'center', vAlign: 'center',
    });
    col.addControl(subtitle);
  }

  // ===== карточка игрока: звание, прогресс, монеты =====
  private addProfileCard(col: StackPanel, colW: number): void {
    const S = loadSettings();
    const rank = rankFor(S.stat_wins);
    const cardH = 104;
    const box = softPanel({ bg: '#FFFFFF0D', border: '#FFD54F55', thickness: 1, corner: 12, height: cardH });
    box.root.width = '100%';
    col.addControl(box.root);
    const inner = new Container('profileInner');
    inner.width = px(colW - 20);
    inner.height = px(cardH - 12);
    inner.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    box.root.addControl(inner);

    const av = new GuiImage('meAvatar', avatarTexture('guest'));
    av.width = px(56);
    av.height = px(56);
    av.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    av.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    av.isHitTestVisible = false;
    inner.addControl(av);

    const nameLab = mkLabel(t('Звание: %s', rank.name), {
      fontSize: fs(16), color: '#FFE9B0', width: colW - 160, height: 24,
      align: 'left', hAlign: 'left', vAlign: 'top', noWrap: true,
    });
    nameLab.left = px(68);
    nameLab.top = px(6);
    nameLab.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    inner.addControl(nameLab);

    const winsLab = mkLabel(t('Побед: %d · за неделю: %d', S.stat_wins, weekWins()), {
      fontSize: fs(12), color: '#ffffff9C', width: colW - 160, height: 20,
      align: 'left', hAlign: 'left', vAlign: 'top', noWrap: true,
    });
    winsLab.left = px(68);
    winsLab.top = px(32);
    winsLab.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    inner.addControl(winsLab);

    // Полоса прогресса до следующего звания.
    const barW = Math.max(80, colW - 194);
    const barBg = new Rectangle('rankBarBg');
    barBg.width = px(barW);
    barBg.height = px(8);
    barBg.cornerRadius = 4;
    barBg.thickness = 0;
    barBg.background = '#FFFFFF1F';
    barBg.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    barBg.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    barBg.left = px(68);
    barBg.top = px(58);
    inner.addControl(barBg);
    const barFill = new Rectangle('rankBarFill');
    barFill.width = px(Math.max(4, Math.round(barW * rank.progress)));
    barFill.height = px(8);
    barFill.cornerRadius = 4;
    barFill.thickness = 0;
    barFill.background = rank.isMax ? '#9BE7A5' : '#FFD54F';
    barFill.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    barFill.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    barFill.left = px(68);
    barFill.top = px(58);
    inner.addControl(barFill);

    const nextText = rank.isMax
      ? t('Максимальное звание')
      : t('До «%s»: %d', rankFor(rank.nextAt).name, Math.max(0, rank.nextAt - S.stat_wins));
    const nextLab = mkLabel(nextText, {
      fontSize: fs(10), color: '#ffffff70', width: barW, height: 16,
      align: 'left', hAlign: 'left', vAlign: 'top', noWrap: true,
    });
    nextLab.left = px(68);
    nextLab.top = px(70);
    nextLab.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    inner.addControl(nextLab);

    const coinIcon = mkLabel('●', { fontSize: fs(18), color: '#FFD54F', width: 16, height: 26 });
    coinIcon.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    coinIcon.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    coinIcon.left = px(-50);
    coinIcon.top = px(8);
    inner.addControl(coinIcon);
    const coinLab = mkLabel(String(coins()), {
      fontSize: fs(18), color: '#FFE9B0', width: 46, height: 26,
      align: 'right', hAlign: 'right', noWrap: true,
    });
    coinLab.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    coinLab.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    coinLab.top = px(8);
    inner.addControl(coinLab);
  }

  // ===== блок настроек партии (скрыт по умолчанию) =====
  private buildSettings(col: StackPanel, colW: number, S: ReturnType<typeof loadSettings>): void {
    col.addControl(gapControl(4));
    const head = mkLabel(t('Настройки партии'), {
      fontSize: fs(16), color: SKIN.gold, height: 28, align: 'left', hAlign: 'left',
    });
    col.addControl(head);

    this.addCountRow(col, S.player_count, colW);

    col.addControl(mkLabel(t('Имена игроков:'), {
      fontSize: fs(16), color: '#ffffffE6', height: Math.max(28, Math.ceil(fs(16) * 1.45)),
    }));

    const names = new StackPanel('namesBox');
    names.isVertical = true;
    names.spacing = 8;
    names.width = '100%';
    names.height = px((S.player_count * 46) + Math.max(0, S.player_count - 1) * 8);
    for (let i = 0; i < S.player_count; i += 1) {
      names.addControl(this.nameRow(i, S.player_names[i] ?? '', colW));
    }
    col.addControl(names);

    // Сложность ботов: характер и аватар зависят от уровня.
    const diff = dropdownRow(t('Боты:'), this.ctx, {
      height: 44, fontSize: fs(15), btnWidth: Math.min(220, Math.max(130, colW - 120)),
    });
    diff.setOptions(BOT_LEVEL_NAMES.map((n) => t(n)), S.bot_level, (i) => {
      saveSettings({ bot_level: i });
      this.host.rebuild();
    });
    col.addControl(diff.root);

    const req30 = checkboxRow(t('Первый ход: от 30'), S.require_30, {
      height: 34,
      fontSize: fs(15),
      onChange: (v) => saveSettings({ require_30: v }),
    });
    req30.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    col.addControl(req30.root);

    const botAnim = checkboxRow(t('Анимация бота'), S.bot_anim, {
      height: 34,
      fontSize: fs(15),
      onChange: (v) => saveSettings({ bot_anim: v }),
    });
    botAnim.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    col.addControl(botAnim.root);

    const sound = checkboxRow(t('Звук'), S.sound, {
      height: 34,
      fontSize: fs(15),
      onChange: (v) => {
        saveSettings({ sound: v });
        applySoundPreference(v);
      },
    });
    sound.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    col.addControl(sound.root);

    col.addControl(gapControl(4));
    const LANG_LABEL = t('Язык');
    const optLblW = Math.max(
      measureTextWidth(t('Текст:'), fs(15)),
      measureTextWidth(t('Карточки:'), fs(15)),
      measureTextWidth(LANG_LABEL, fs(15)),
    ) + 6;
    this.optionRowStr(col, t('Текст:'), textScaleNamesLocalized(), S.text_scale, (i) => {
      saveSettings({ text_scale: i });
      this.host.rebuild();
    }, colW, optLblW);
    this.optionRowStr(col, t('Карточки:'), tileSizeNamesLocalized(), S.tile_step, (i) => {
      saveSettings({ tile_step: i });
      this.host.rebuild();
    }, colW, optLblW);
    this.optionRowStr(col, LANG_LABEL, ['Русский', 'English'], S.lang === 'en' ? 1 : 0, (i) => {
      saveSettings({ lang: i === 1 ? 'en' : 'ru' });
      this.host.rebuild();
    }, colW, optLblW);
  }

  private addPendingBanner(col: StackPanel, colW: number, pending: NonNullable<ReturnType<MenuHost['pendingRoom']>>): void {
    const message = pending.state === 'playing'
      ? t('Вы всё ещё в партии «%s»', pending.name || pending.code)
      : t('Вы всё ещё в комнате «%s»', pending.name || pending.code);
    const pad = 12;
    const innerW = Math.max(120, colW - 2 * pad);
    const labelFont = fs(14);
    const wrappedMessage = wrapTextToWidth(message, innerW, labelFont);
    const labelH = estimateWrappedTextHeight(wrappedMessage, innerW, labelFont) + 4;
    const buttonFont = fs(14);
    const buttonH = Math.max(40, Math.ceil(buttonFont * 1.7));
    const backText = t('Вернуться');
    const dropText = t('Покинуть');
    const backNeed = Math.ceil(measureTextWidth(backText, buttonFont)) + 28;
    const dropNeed = Math.ceil(measureTextWidth(dropText, buttonFont)) + 28;
    const stackButtons = backNeed + dropNeed + 8 > innerW;
    const actionH = stackButtons ? buttonH * 2 + 8 : buttonH;
    const box = softPanel({ bg: '#FFD54F14', border: SKIN.gold, thickness: 2, corner: 10 });
    box.root.width = '100%';
    box.root.height = px(pad + labelH + 6 + actionH + pad);
    const bcol = new StackPanel('pendingCol');
    bcol.isVertical = true;
    bcol.spacing = 6;
    bcol.width = px(innerW);
    bcol.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    bcol.paddingLeft = '0px';
    bcol.paddingRight = '0px';
    box.root.addControl(bcol);
    const pendingLabel = mkLabel(wrappedMessage, {
      fontSize: labelFont,
      color: SKIN.noteGold,
      width: innerW,
      height: labelH,
      noWrap: false,
      align: 'left',
      vAlign: 'top',
    });
    pendingLabel.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    bcol.addControl(pendingLabel);
    const actions = new StackPanel('pendingActions');
    actions.isVertical = stackButtons;
    actions.spacing = 8;
    actions.width = px(innerW);
    actions.height = px(actionH);
    bcol.addControl(actions);
    const buttonW = stackButtons ? innerW : Math.floor((innerW - 8) / 2);
    const backBtn = mkButton(backText, { height: buttonH, width: buttonW, fontSize: buttonFont, theme: BUTTON_STYLE.green });
    backBtn.onPointerUpObservable.clear();
    backBtn.onPointerUpObservable.add(() => this.host.onReturnToRoom());
    const dropBtn = mkButton(dropText, { height: buttonH, width: buttonW, fontSize: buttonFont, theme: BUTTON_STYLE.deck });
    dropBtn.onPointerUpObservable.clear();
    dropBtn.onPointerUpObservable.add(() => this.host.onDropRoom());
    actions.addControl(backBtn);
    actions.addControl(dropBtn);
    col.addControl(box.root);
  }

  private addOnlineBanner(col: StackPanel, colW: number): void {
    const onlineText = t('Кто-то играет по сети');
    const onlineFont = fs(15);
    const pad = 10;
    const labelH = Math.max(34, Math.ceil(onlineFont * 1.8));
    const onlinePanel = softPanel({
      bg: '#7CFFB2', bgAlpha: 0.08, border: '#7CFFB2',
      thickness: 2, corner: 10, width: colW, height: pad * 2 + labelH,
    });
    onlinePanel.root.addControl(mkLabel(onlineText, {
      color: '#A8FFC8',
      fontSize: onlineFont,
      width: colW - pad * 2,
      height: labelH,
      align: 'center',
      hAlign: 'center',
      vAlign: 'center',
    }));
    col.addControl(onlinePanel.root);
  }

  private addCountRow(col: StackPanel, playerCount: number, avail: number): void {
    const items: string[] = [];
    for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n += 1) items.push(String(n));
    const btnW = 110;
    const labelW = measureTextWidth(t('Игроков:'), fs(17)) + 6;
    const stacked = labelW + 10 + btnW > avail;
    const dd = dropdownRow(t('Игроков:'), this.ctx, {
      height: 48,
      fontSize: fs(16),
      btnWidth: btnW,
      stacked,
    });
    if (!stacked) dd.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    dd.setOptions(items, playerCount - MIN_PLAYERS, (i) => {
      setPlayerCount(Number(items[i]));
      saveSettings({});
      this.host.rebuild();
    });
    col.addControl(dd.root);
  }

  private optionRowStr(
    col: StackPanel,
    label: string,
    names: string[],
    current: number,
    onPick: (i: number) => void,
    avail: number,
    lblW: number,
  ): void {
    // Все ряды настроек получают одинаковую ширину метки (по самой
    // длинной), чтобы кнопки стояли ровной колонкой у левого края.
    const btnW = Math.min(Math.max(avail - lblW - 34, 130), 240);
    // На узком экране (320) подпись и кнопка не помещаются в строку —
    // кладём кнопку под подпись; в остальных случаях оставляем как было.
    const stacked = avail < 300 || lblW + 10 + btnW > avail;
    const dd = dropdownRow(label, this.ctx, {
      height: 42,
      fontSize: fs(15),
      lblWidth: stacked ? avail : lblW,
      // В перенесённом виде кнопка занимает всю доступную ширину — текст
      // опций (например «Максимум») помещается целиком.
      btnWidth: stacked ? avail : Math.min(btnW, avail),
      stacked,
    });
    dd.setOptions(names, current, onPick);
    col.addControl(dd.root);
  }

  private nameRow(i: number, value: string, avail: number): StackPanel {
    const sp = hrow(8);
    sp.width = '100%';
    sp.height = px(46);
    const input = new InputText(undefined, value);
    input.width = px1(Math.max(100, Math.floor(avail - 118)));
    input.height = 46;
    input.color = SKIN.text;
    input.background = SKIN.deck;
    input.fontSize = fs(16);
    input.fontFamily = 'Arial, sans-serif';
    input.placeholderText = t('Игрок %d', i + 1);
    focusInputOnTap(input);
    setInputMaxLength(input, MAX_NAME_LEN);
    onInputBlur(input, () => setPlayerName(i, input.text));
    sp.addControl(input);
    const bot = checkboxRow(t('Бот'), loadSettings().player_is_bot[i] ?? false, {
      height: 46,
      fontSize: fs(16),
      onChange: (v) => setBot(i, v),
    });
    void bot.setChecked;
    sp.addControl(bot.root);
    return sp;
  }

  private openHelp(): void {
    openRulesOverlay(this.popups, () => {});
  }

  private openStats(): void {
    openStatsOverlay(this.popups, platform.supportsOnline
      ? { loadOnline: () => this.host.onlineStats() }
      : {});
  }

  private openShop(): void {
    openShopOverlay(this.popups, () => this.host.rebuild());
  }

  private openAchievements(): void {
    openAchievementsOverlay(this.popups);
  }
}

export type { MenuHost } from './ports';

// Локализованные самоназвания элементов управления: значения массивов
// тоже переводим (только не «Русский»/«English»).
function textScaleNamesLocalized(): string[] {
  return TEXT_SCALE_NAMES.map((s) => t(s));
}

function tileSizeNamesLocalized(): string[] {
  return TILE_SIZE_NAMES.map((s) => t(s));
}

function fitFontSize(text: string, avail: number, base: number): number {
  let size = base;
  while (size > 12) {
    if (measureTextWidth(text, size) <= avail) break;
    size -= 1;
  }
  return size;
}

const measureCanvas: { c: HTMLCanvasElement | null } = { c: null };

export function measureTextWidth(text: string, fontSize: number): number {
  if (measureCanvas.c === null) measureCanvas.c = document.createElement('canvas');
  const ctx = measureCanvas.c.getContext('2d');
  if (!ctx) return fontSize * text.length * 0.6;
  ctx.font = `${fontSize}px Arial`;
  return ctx.measureText(text).width;
}
