import { Container, Control, Image as GuiImage, Rectangle, ScrollViewer, StackPanel } from '@babylonjs/gui';
import { appName, t } from '../core/lang';
import { fs, fsCapped, loadSettings } from '../core/settings';
import {
  BUTTON_STYLE,
  enableSmoothScroll,
  estimateWrappedTextHeight,
  hrow,
  mkButton,
  mkLabel,
  SKIN,
  softPanel,
  wrapTextToWidth,
  px,
} from './uiskin';
import { openAchievementsOverlay, openModesOverlay, openRulesOverlay, openShopOverlay, openStatsOverlay } from './overlays';
import { openGameSetupOverlay } from './game_setup';
import { platform } from '../platform';
import { play } from '../core/audio';
import {
  CHECKIN_DAYS,
  checkinState,
  claimCheckin,
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

  constructor(private host: MenuHost) {}

  build(root: Container): void {
    const vw = viewWidth();
    const vh = viewHeight();
    const avail = Math.max(200, Math.min(vw - 28, 470));
    // Тонкая полоса прокрутки занимает 4 px вместо 20: освободившееся место
    // отдаём колонке, чтобы элементы не выглядели сдвинутыми влево.
    const colW = Math.max(184, avail - 8);
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
    // Тонкий скроллбар: толстая полоса по умолчанию занимала заметную часть
    // ширины и оставляла пустую полосу справа.
    scroll.barSize = 4;
    // Горизонтального скролла здесь не должно быть: колонка жёстко
    // ограничена avail, а хвост скроллбара прячем.
    (scroll as unknown as { _horizontalBar: Control })._horizontalBar.isVisible = false;
    (scroll as unknown as { _forceHorizontalBar: boolean })._forceHorizontalBar = false;
    center.addControl(scroll);
    enableSmoothScroll(scroll);

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

    // pending_room: «вы всё ещё в комнате» с возвратом/отказом
    const pending = this.host.pendingRoom();
    if (pending) this.addPendingBanner(col, colW, pending);
    // Плашка «кто-то играет по сети»: появляется, когда в списке комнат
    // есть хотя бы одна живая комната. Показан ровно один баннер.
    if (!pending && this.host.hasOnlineRooms()) this.addOnlineBanner(col, colW);

    this.addHero(col, colW);
    this.addProfileCard(col, colW);
    this.addCheckinCard(col, colW);

    // ===== главные действия =====
    const startBtn = mkButton(t('Играть'), { fontSize: fsCapped(22, 1), height: 60, theme: BUTTON_STYLE.green });
    startBtn.width = '100%';
    startBtn.onPointerUpObservable.clear();
    // Режим выбирается большой карточкой с наглядным примером партии.
    startBtn.onPointerUpObservable.add(() => {
      play('click');
      openModesOverlay(this.popups, (mode) => this.host.onStart(mode));
    });
    col.addControl(startBtn);

    if (platform.supportsOnline) {
      const onlineBtn = mkButton(t('Играть с другими'), { fontSize: fsCapped(18, 1), height: 52, theme: BUTTON_STYLE.blueOnline });
      onlineBtn.width = '100%';
      onlineBtn.onPointerUpObservable.clear();
      onlineBtn.onPointerUpObservable.add(() => this.host.onOnline());
      col.addControl(onlineBtn);
    }

    // ===== мета =====
    const modeW = Math.floor((colW - 8) / 2);
    const meta1 = hrow(8);
    meta1.width = '100%';
    meta1.height = px(52);
    const daily = mkButton(t('Ежедневная'), { fontSize: fsCapped(14, 1), height: 52, width: modeW, theme: BUTTON_STYLE.deck });
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
    const shop = mkButton(t('Магазин'), { fontSize: fsCapped(14, 1), height: 52, width: modeW, theme: BUTTON_STYLE.deck });
    shop.onPointerUpObservable.clear();
    shop.onPointerUpObservable.add(() => this.openShop());
    meta1.addControl(daily);
    meta1.addControl(shop);
    col.addControl(meta1);

    const meta2 = hrow(8);
    meta2.width = '100%';
    meta2.height = px(52);
    const unlocked = ACHIEVEMENTS.filter((a) => S.achievements.includes(a.id)).length;
    const ach = mkButton(t('Достижения'), {
      fontSize: fsCapped(14, 1), height: 52, width: modeW, theme: BUTTON_STYLE.deck,
    });
    void unlocked;
    ach.onPointerUpObservable.clear();
    ach.onPointerUpObservable.add(() => this.openAchievements());
    const stats = mkButton(t('Статистика'), { fontSize: fsCapped(14, 1), height: 52, width: modeW, theme: BUTTON_STYLE.deck });
    stats.onPointerUpObservable.clear();
    stats.onPointerUpObservable.add(() => this.openStats());
    meta2.addControl(ach);
    meta2.addControl(stats);
    col.addControl(meta2);

    const bottom = hrow(8);
    bottom.width = '100%';
    bottom.height = px(50);
    const rulesBtn = mkButton(t('Как играть'), {
      fontSize: fsCapped(14, 1), height: 50, width: modeW,
      theme: { bg: '#31363F', hover: '#3A404A', press: '#262B33' },
    });
    rulesBtn.onPointerUpObservable.clear();
    rulesBtn.onPointerUpObservable.add(() => this.openHelp());
    const settings = mkButton(t('Настройки'), {
      fontSize: fsCapped(14, 1), height: 50, width: modeW,
      theme: { bg: '#31363F', hover: '#3A404A', press: '#262B33' },
    });
    settings.onPointerUpObservable.clear();
    settings.onPointerUpObservable.add(() => {
      play('click');
      openGameSetupOverlay(this.popups, () => this.host.rebuild());
    });
    bottom.addControl(rulesBtn);
    bottom.addControl(settings);
    col.addControl(bottom);
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
    // Размеры считаем от кегля: при крупном тексте прежние фиксированные
    // 104 px обрезали звание и монеты.
    const nameFont = fsCapped(16, 0);
    const winsFont = fsCapped(12, 0);
    const nextFont = fsCapped(10, 0);
    const coinFont = fsCapped(18, 0);
    const nameH = Math.ceil(nameFont * 1.45);
    const winsH = Math.ceil(winsFont * 1.45);
    const nextH = Math.ceil(nextFont * 1.45);
    const barH = 8;
    const contentH = nameH + 3 + winsH + 6 + barH + 5 + nextH;
    const cardH = Math.max(104, contentH + 16);
    const top0 = Math.round((cardH - contentH) / 2);
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

    const textW = Math.max(90, colW - 64 - 92);
    const nameLab = mkLabel(t('Звание: %s', rank.name), {
      fontSize: nameFont, color: '#FFE9B0', width: textW, height: nameH,
      align: 'left', hAlign: 'left', vAlign: 'top', noWrap: true,
    });
    nameLab.left = px(64);
    nameLab.top = px(top0);
    nameLab.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    inner.addControl(nameLab);

    const winsLab = mkLabel(t('Побед: %d · за неделю: %d', S.stat_wins, weekWins()), {
      fontSize: winsFont, color: '#ffffff9C', width: Math.max(90, colW - 76), height: winsH,
      align: 'left', hAlign: 'left', vAlign: 'top', noWrap: true,
    });
    winsLab.left = px(64);
    winsLab.top = px(top0 + nameH + 3);
    winsLab.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    inner.addControl(winsLab);

    // Полоса прогресса до следующего звания.
    const barTop = top0 + nameH + 3 + winsH + 6;
    const barW = Math.max(80, colW - 64 - 24);
    const barBg = new Rectangle('rankBarBg');
    barBg.width = px(barW);
    barBg.height = px(barH);
    barBg.cornerRadius = 4;
    barBg.thickness = 0;
    barBg.background = '#FFFFFF1F';
    barBg.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    barBg.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    barBg.left = px(68);
    barBg.top = px(barTop);
    inner.addControl(barBg);
    const barFill = new Rectangle('rankBarFill');
    barFill.width = px(Math.max(4, Math.round(barW * rank.progress)));
    barFill.height = px(barH);
    barFill.cornerRadius = 4;
    barFill.thickness = 0;
    barFill.background = rank.isMax ? '#9BE7A5' : '#FFD54F';
    barFill.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    barFill.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    barFill.left = px(68);
    barFill.top = px(barTop);
    inner.addControl(barFill);

    const nextText = rank.isMax
      ? t('Максимальное звание')
      : t('До «%s»: %d', rankFor(rank.nextAt).name, Math.max(0, rank.nextAt - S.stat_wins));
    const nextLab = mkLabel(nextText, {
      fontSize: nextFont, color: '#ffffff70', width: barW, height: nextH,
      align: 'left', hAlign: 'left', vAlign: 'top', noWrap: true,
    });
    nextLab.left = px(68);
    nextLab.top = px(barTop + barH + 5);
    nextLab.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    inner.addControl(nextLab);

    const coinH = Math.ceil(coinFont * 1.45);
    const coinIcon = mkLabel('●', { fontSize: coinFont, color: '#FFD54F', width: 18, height: coinH });
    coinIcon.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    coinIcon.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    coinIcon.left = px(-52);
    coinIcon.top = px(top0);
    inner.addControl(coinIcon);
    const coinLab = mkLabel(String(coins()), {
      fontSize: coinFont, color: '#FFE9B0', width: 48, height: coinH,
      align: 'right', hAlign: 'right', noWrap: true,
    });
    coinLab.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    coinLab.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    coinLab.top = px(top0);
    inner.addControl(coinLab);
  }

  // ===== ежедневный вход: 7 дней, бонус и анимация монет =====
  private addCheckinCard(col: StackPanel, colW: number): void {
    const state = checkinState();
    const titleFont = fsCapped(14, 1);
    const smallFont = fsCapped(11, 1);
    const titleH = Math.ceil(titleFont * 1.5);
    const dot = Math.min(30, Math.floor((colW - 40 - 6 * 5) / CHECKIN_DAYS));
    const dotS = Math.max(18, dot);
    const stripH = dotS;
    const cardH = titleH + 6 + stripH + 6 + Math.ceil(smallFont * 1.5) + 20;
    const card = softPanel({
      bg: '#FFFFFF0A',
      border: state.available ? '#FFD54F88' : '#ffffff1A',
      thickness: state.available ? 2 : 1,
      corner: 12,
      height: cardH,
    });
    card.root.width = '100%';
    card.root.isPointerBlocker = true;
    if (state.available) {
      card.root.onPointerUpObservable.add(() => {
        const res = claimCheckin();
        if (!res) return;
        play('click');
        const r = card.root._currentMeasure;
        this.animateCoins(r.left + r.width / 2, r.top + r.height / 2, res.coins);
        window.setTimeout(() => this.host.rebuild(), 1100);
      });
    }
    col.addControl(card.root);

    const title = mkLabel(t('Ежедневный вход'), {
      color: state.available ? SKIN.gold : '#ffffffC0',
      fontSize: titleFont, width: colW - 24, height: titleH,
      align: 'left', hAlign: 'left', vAlign: 'top', noWrap: true,
    });
    title.left = px(12);
    title.top = px(8);
    title.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    card.root.addControl(title);

    const strip = new StackPanel('checkinStrip');
    strip.isVertical = false;
    strip.spacing = 5;
    strip.width = px(colW - 24);
    strip.height = px(stripH);
    strip.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    strip.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    strip.top = px(8 + titleH + 6);
    card.root.addControl(strip);
    for (let day = 1; day <= CHECKIN_DAYS; day += 1) {
      const done = day <= state.completed;
      const today = state.available && day === state.todayDay;
      const circle = new Rectangle(`checkinDay${day}`);
      circle.width = px(dotS);
      circle.height = px(dotS);
      circle.cornerRadius = dotS / 2;
      circle.thickness = today ? 2 : 1;
      circle.color = today ? SKIN.gold : done ? '#58C36A' : '#ffffff33';
      circle.background = done ? '#43A04766' : today ? '#FFD54F22' : '#FFFFFF0A';
      circle.isHitTestVisible = false;
      const num = mkLabel(done ? '✓' : String(day), {
        fontSize: Math.max(9, Math.round(dotS * 0.48)),
        color: done ? '#C8FFD3' : today ? SKIN.gold : '#ffffff66',
        width: px(dotS), height: px(dotS), align: 'center', hAlign: 'center', vAlign: 'center',
      });
      num.isHitTestVisible = false;
      circle.addControl(num);
      strip.addControl(circle);
      if (today) this.pulseToday(circle);
    }

    const hint = state.available
      ? t('Забрать +%d монет', state.bonus)
      : t('Серия: %d дн. · заходите завтра', Math.max(1, state.streak));
    const hintLab = mkLabel(hint, {
      color: state.available ? '#FFE9B0' : '#ffffff70',
      fontSize: smallFont, width: colW - 24,
      height: Math.ceil(smallFont * 1.5),
      align: 'left', hAlign: 'left', vAlign: 'top', noWrap: true,
    });
    hintLab.left = px(12);
    hintLab.top = px(8 + titleH + 6 + stripH + 6);
    hintLab.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    card.root.addControl(hintLab);
  }

  // Мягкое «дыхание» сегодняшнего дня: рамка чуть светлеет и гаснет.
  private pulseToday(circle: Rectangle): void {
    let frame = 0;
    const tick = (): void => {
      if (!circle.parent) return;
      frame += 1;
      const k = (Math.sin(frame / 14) + 1) / 2;
      circle.alpha = 0.65 + 0.35 * k;
      if (frame < 240) window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  }

  // Монеты разлетаются вверх от карточки — короткая награда за вход.
  private animateCoins(x: number, y: number, amount: number): void {
    const host = this.popups;
    const parts = 8;
    for (let i = 0; i < parts; i += 1) {
      const label = mkLabel(`+${Math.max(1, Math.round(amount / parts))}`, {
        color: '#FFD54F', fontSize: fsCapped(14, 1), width: 60, height: 20,
        align: 'center', hAlign: 'left', vAlign: 'top', noWrap: true,
      });
      label.left = px(x - 30 + (Math.random() * 80 - 40));
      label.top = px(y);
      label.zIndex = 900;
      label.isHitTestVisible = false;
      label.isPointerBlocker = false;
      host.addControl(label);
      const start = performance.now() + i * 45;
      const drift = (Math.random() * 50 - 25);
      const tick = (now: number): void => {
        const k = Math.min(1, Math.max(0, (now - start) / 800));
        label.top = px(y - 70 * k);
        label.left = px(x - 30 + drift * k);
        label.alpha = 1 - k;
        if (k < 1) window.requestAnimationFrame(tick);
        else host.removeControl(label);
      };
      window.requestAnimationFrame(tick);
    }
    const total = mkLabel(`+${amount} ●`, {
      color: '#FFE9B0', fontSize: fsCapped(20, 1), width: 140, height: 30,
      align: 'center', hAlign: 'left', vAlign: 'top', noWrap: true,
    });
    total.left = px(x - 70);
    total.top = px(y - 10);
    total.zIndex = 901;
    total.isHitTestVisible = false;
    total.isPointerBlocker = false;
    host.addControl(total);
    const start = performance.now();
    const tick = (now: number): void => {
      const k = Math.min(1, (now - start) / 900);
      total.top = px(y - 10 - 60 * k);
      total.alpha = 1 - k;
      if (k < 1) window.requestAnimationFrame(tick);
      else host.removeControl(total);
    };
    window.requestAnimationFrame(tick);
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
