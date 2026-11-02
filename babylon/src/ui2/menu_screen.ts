import { Button, Container, Control, InputText, Rectangle, ScrollViewer, StackPanel } from '@babylonjs/gui';
import { appName, t } from '../core/lang';
import {
  BOT_LEVEL_NAMES,
  fs,
  loadSettings,
  MAX_PLAYERS,
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
  popupList,
  SKIN,
  setButtonLabel,
  softPanel,
  DropdownCtx,
  px,
} from './uiskin';
import { openRulesOverlay, openStatsOverlay } from './overlays';
import { platform } from '../platform';
import { showDomToast } from './dom_toast';

import type { MenuHost } from './ports';
import { viewHeight, viewWidth } from './viewport';

function px1(n: number): string {
  return `${n}px`;
}

export class MenuScreen {
  private popups!: Container;
  private ctx!: DropdownCtx;
  // Токен сборки: асинхронные проверки площадки (оценка/ярлык) не должны
  // добавлять кнопки в уже пересобранное меню.
  private buildToken = 0;

  constructor(private host: MenuHost) {}

  build(root: Container): void {
    const token = ++this.buildToken;
    const vw = viewWidth();
    const vh = viewHeight();
    const avail = Math.max(200, Math.min(vw - 28, 470));
    // Колонка на 16px уже окна скролла: вертикальный скроллбар съедает
    // ширину клиентской области, и иначе включался горизонтальный.
    const colW = Math.max(184, avail - 16);
    const S = loadSettings();

    const bg = new Rectangle('bg');
    bg.background = SKIN.bg;
    bg.thickness = 0;
    bg.width = '100%';
    bg.height = '100%';
    bg.isHitTestVisible = false;
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

    const col = new StackPanel('menuBox');
    col.isVertical = true;
    col.width = px(colW);
    col.paddingLeft = '0px';
    col.paddingTop = px(8);
    col.spacing = 6;
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

    const titleText = appName();
    const titleFont = fitFontSize(titleText, colW, fs(38));
    const title = mkLabel(titleText, {
      color: SKIN.gold,
      fontSize: titleFont,
      width: '100%',
      height: Math.max(52, estimateWrappedTextHeight(titleText, colW, titleFont)),
      noWrap: false,
      vAlign: 'center',
    });
    col.addControl(title);

    const subtitleFont = fs(16);
    const subtitleText = t('числа · 4 цвета · джокеры');
    // Высота по реальному переносу строк: на телефоне с крупным текстом
    // подпись занимает несколько строк, и фиксированная высота резала её.
    const subtitle = mkLabel(subtitleText, {
      color: '#ffffff8c', fontSize: subtitleFont, width: colW,
      height: estimateWrappedTextHeight(subtitleText, colW, subtitleFont),
      align: 'center', hAlign: 'center', vAlign: 'center',
    });
    col.addControl(subtitle);

    // pending_room: «вы всё ещё в комнате» с возвратом/отказом
    const pending = this.host.pendingRoom();
    if (pending) {
      const message = pending.state === 'playing'
        ? t('Вы всё ещё в партии «%s»', pending.name || pending.code)
        : t('Вы всё ещё в комнате «%s»', pending.name || pending.code);
      const innerW = Math.max(120, colW - 20);
      const labelFont = fs(14);
      const labelH = estimateWrappedTextHeight(message, innerW, labelFont) + 4;
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
      box.root.height = px(6 + labelH + 6 + actionH + 8);
      const bcol = new StackPanel('pendingCol');
      bcol.isVertical = true;
      bcol.spacing = 6;
      bcol.width = px(innerW);
      bcol.paddingLeft = px(10);
      bcol.paddingTop = px(6);
      box.root.addControl(bcol);
      const pendingLabel = mkLabel(message, {
        fontSize: labelFont,
        color: SKIN.noteGold,
        width: innerW,
        height: labelH,
        noWrap: false,
        align: 'left',
        vAlign: 'top',
      });
      pendingLabel.resizeToFit = true;
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

    col.addControl(gapControl(8));

    this.addCountRow(col, S.player_count, colW);

    col.addControl(mkLabel(t('Имена игроков:'), { fontSize: fs(17), color: '#ffffffE6' }));

    const names = new StackPanel('namesBox');
    names.isVertical = true;
    names.spacing = 8;
    names.width = '100%';
    names.height = px((S.player_count * 46) + Math.max(0, S.player_count - 1) * 8);
    for (let i = 0; i < S.player_count; i += 1) {
      names.addControl(this.nameRow(i, S.player_names[i] ?? '', colW));
    }
    col.addControl(names);

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
    // Отступ после «Анимация бота» перед блоком настроек.
    col.addControl(gapControl(8));

    const optLblW = Math.max(
      measureTextWidth(t('Текст:'), fs(15)),
      measureTextWidth(t('Карточки:'), fs(15)),
      measureTextWidth(t('Сложность ботов:'), fs(15)),
      measureTextWidth(t('Язык:'), fs(15)),
    ) + 6;
    this.optionRowStr(col, t('Текст:'), textScaleNamesLocalized(), S.text_scale, (i) => {
      saveSettings({ text_scale: i });
      this.host.rebuild();
    }, colW, optLblW);
    this.optionRowStr(col, t('Карточки:'), tileSizeNamesLocalized(), S.tile_step, (i) => {
      saveSettings({ tile_step: i });
      this.host.rebuild();
    }, colW, optLblW);
    this.optionRowStr(col, t('Сложность ботов:'), botLevelNamesLocalized(), S.bot_level, (i) => {
      saveSettings({ bot_level: i });
    }, colW, optLblW);
    this.optionRowStr(col, t('Язык:'), ['Русский', 'English'], S.lang === 'en' ? 1 : 0, (i) => {
      saveSettings({ lang: i === 1 ? 'en' : 'ru' });
      this.host.rebuild();
    }, colW, optLblW);
    // Отступ после настройки языка перед кнопкой «Начать».
    col.addControl(gapControl(8));

    const startBtn = mkButton(t('Начать'), { fontSize: fs(20), height: 58, theme: BUTTON_STYLE.green });
    startBtn.width = '100%';
    startBtn.onPointerUpObservable.clear();
    startBtn.onPointerUpObservable.add(() => this.host.onStart());
    col.addControl(startBtn);

    const onlineBtn = mkButton(t('Играть с другими'), { fontSize: fs(17), height: 50, theme: BUTTON_STYLE.blueOnline });
    onlineBtn.width = '100%';
    onlineBtn.onPointerUpObservable.clear();
    onlineBtn.onPointerUpObservable.add(() => this.host.onOnline());
    col.addControl(onlineBtn);

    const statsBtn = mkButton(t('Статистика'), { fontSize: fs(17), height: 50, theme: BUTTON_STYLE.deck });
    statsBtn.width = '100%';
    statsBtn.onPointerUpObservable.clear();
    statsBtn.onPointerUpObservable.add(() => this.openStats());
    col.addControl(statsBtn);

    // Кнопки площадки: полный экран, оценка игры, ярлык на рабочий стол.
    this.addPlatformActions(col, colW, token);

    const bottom = hrow(14);
    bottom.width = '100%';
    bottom.height = px(50);
    // Внутри iframe площадки кнопка «Выход» бесполезна (window.close там
    // не работает) и запрещена рекомендациями — показываем только на
    // отдельной странице своего сайта.
    const embedded = platform.isEmbedded && platform.id !== 'standalone';
    const rulesW = embedded ? colW : Math.floor(colW / 2) - 7;
    const rulesBtn = mkButton(t('Как играть'), { fontSize: fs(16), height: 50, width: Math.floor(rulesW), theme: { bg: '#31363F', hover: '#3A404A', press: '#262B33' } });
    rulesBtn.onPointerUpObservable.clear();
    rulesBtn.onPointerUpObservable.add(() => this.openHelp());
    bottom.addControl(rulesBtn);
    if (!embedded) {
      const quitBtn = mkButton(t('Выход'), { fontSize: fs(16), height: 50, width: Math.floor(colW / 2) - 7, theme: { bg: '#31363F', hover: '#3A404A', press: '#262B33' } });
      quitBtn.onPointerUpObservable.clear();
      quitBtn.onPointerUpObservable.add(() => window.close());
      bottom.addControl(quitBtn);
    }
    col.addControl(bottom);
  }

  /**
   * Кнопки площадки в главном меню:
   * - полный экран (браузерный или через SDK площадки);
   * - «Оценить игру» и «Добавить на рабочий стол» — только если площадка
   *   их поддерживает и они реально доступны этому игроку (проверка
   *   асинхронная, поэтому кнопки появляются после ответа SDK).
   */
  private addPlatformActions(col: StackPanel, colW: number, token: number): void {
    if (!platform.supportsFullscreen && !platform.supportsReview && !platform.supportsShortcut) return;
    const grey = { bg: '#31363F', hover: '#3A404A', press: '#262B33' };
    const box = new StackPanel('platformActions');
    box.isVertical = true;
    box.spacing = 8;
    box.width = '100%';

    if (platform.supportsFullscreen) {
      const sync = (b: Button): void => {
        setButtonLabel(b, t(platform.isFullscreen() ? 'Выйти из полного экрана' : 'На весь экран'));
      };
      const btn = mkButton('', { fontSize: fs(16), height: 46, width: colW, theme: grey });
      sync(btn);
      btn.onPointerUpObservable.clear();
      btn.onPointerUpObservable.add(() => {
        void platform.toggleFullscreen().then(() => sync(btn));
      });
      box.addControl(btn);
    }
    col.addControl(box);

    if (platform.supportsReview) {
      void platform.canReview().then((ok) => {
        if (!ok || token !== this.buildToken) return;
        const btn = mkButton(t('Оценить игру'), { fontSize: fs(16), height: 46, width: colW, theme: grey });
        btn.onPointerUpObservable.clear();
        btn.onPointerUpObservable.add(() => {
          void platform.requestReview().then((sent) => {
            showDomToast(t(sent ? 'Спасибо за оценку!' : 'Оценить игру можно позже'));
          });
        });
        box.addControl(btn);
      });
    }

    if (platform.supportsShortcut) {
      void platform.canAddShortcut().then((ok) => {
        if (!ok || token !== this.buildToken) return;
        const btn = mkButton(t('Добавить на рабочий стол'), { fontSize: fs(16), height: 46, width: colW, theme: grey });
        btn.onPointerUpObservable.clear();
        btn.onPointerUpObservable.add(() => {
          void platform.addShortcut().then((added) => {
            showDomToast(t(added ? 'Ярлык добавлен. Спасибо!' : 'Не удалось добавить ярлык'));
          });
        });
        box.addControl(btn);
      });
    }
  }

  private addCountRow(col: StackPanel, playerCount: number, avail: number): void {
    const items: string[] = [];
    for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n += 1) items.push(String(n));
    const btnW = 110;
    const labelW = measureTextWidth(t('Игроков:'), fs(17)) + 6;
    const stacked = labelW + 10 + btnW > avail;
    const dd = dropdownRow(t('Игроков:'), this.ctx, {
      height: 50,
      fontSize: fs(17),
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
    input.onBlurObservable.add(() => setPlayerName(i, input.text));
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
    // Общая модалка правил: тот же отступ текста и заголовка, что и в игре.
    openRulesOverlay(this.popups, () => {});
  }

  private openStats(): void {
    // Локальные и сетевые партии показаны раздельно, чтобы счётчики
    // не смешивались: сетевые данные приходят с сервера.
    openStatsOverlay(this.popups, { loadOnline: () => this.host.onlineStats() });
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

function botLevelNamesLocalized(): string[] {
  return BOT_LEVEL_NAMES.map((s) => t(s));
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
