import {
  Button,
  Container,
  Control,
  Rectangle,
  ScrollViewer,
  StackPanel,
  TextBlock,
} from '@babylonjs/gui';
import { PointerEventTypes, Scene } from '@babylonjs/core';
import { t } from '../core/lang';
import {
  fs,
  loadSettings,
  recordLocalGameResult,
  recordLocalGameStarted,
  tileSize,
} from '../core/settings';
import { GameState, GsRow } from '../core/game_state';
import { LEVEL_IMPOSSIBLE, TurnPlanner } from '../core/turn_planner';
import { sortTiles, TileFace } from '../core/tile';
import { validateRow } from '../core/rules';
import { tileById } from '../core/deck';
import { flowGap, layoutFlow, FlowItem } from './flow';
import { TileFigure, TileMarks } from './tile_figure';
import {
  abortTouchGestures,
  BUTTON_STYLE,
  DropdownCtx,
  enableSmoothScroll,
  estimateWrappedTextHeight,
  gapControl,
  mkButton,
  mkLabel,
  modalOverlay,
  popupList,
  setButtonLabel,
  scrollViewerByPixels,
  SKIN,
  wrapTextToWidth,
  softPanel,
  px,
  type ButtonTheme,
} from './uiskin';
import { openRulesOverlay, openSettingsOverlay } from './overlays';
import { platform, withInterstitial } from '../platform';
import { measureTextWidth } from './menu_screen';
import { viewHeight, viewWidth } from './viewport';
import type { OfflineHost } from './ports';
import type { DraftMsg, GameEnvelope, GameErrorMsg, GameView } from '../net/protocol';

interface RowFig {
  rowId: number;
  root: Container;
  fill: Rectangle;
  host: Container;
  figures: TileFigure[];
  items: FlowItem[];
  // визуальная строка каждого тайла (ряды переносятся при переполнении)
  lineOf: number[];
  hintZone: boolean;
}

interface TileSrc {
  kind: 'hand' | 'row';
  rowId: number;
  index: number;
}

interface DragData {
  face: TileFace;
  src: TileSrc;
  previewHost: Container;
  targetRow?: number;
  index?: number;
  obs: import('@babylonjs/core').Observer<import('@babylonjs/core').PointerInfo>;
}

interface TileSnapshot {
  face: TileFace;
  rect: { x: number; y: number; w: number; h: number };
  slot?: string;
  rowId?: number;
  // Скрытые фишки (рука бота) не должны «просвечивать» во время полёта.
  faceDown?: boolean;
}

const DROP_MS = 350;
// Задержка перед раскрытием слота «новый ряд» между рядами при перетаскивании.
const SLOT_REVEAL_MS = 180;
const BOT_THINK_MS = 1500;
const BOT_STEP_MS = 550;
const BOT_MIN_WAIT_MS = 1400;
// Как часто максимум перезапускается автопрокрутка стола за ходом бота.
const BOT_SCROLL_THROTTLE_MS = 1000;
// Единый боковой отступ экрана и отступ сверху: верхняя панель, чипы,
// стол, рука и нижние кнопки живут в одной сетке.
const SIDE_PAD = 12;
const TOP_PAD = 10;

// Оффлайн-экран: стол, рука, drag&drop, боты, пас/победа-оверлеи.
// В onlineMode тот же интерфейс обслуживает сетевую партию: состояние
// приходит с сервера (GAME_STATE/DRAFT), ходы уходят через API.
export class OfflineGame {
  private boardRoot!: Container;
  private state: GameState | null = null;
  private planner = new TurnPlanner();
  running = false;

  // сетевая партия
  onlineMode = false;
  private roomCode = '';
  private onlineTimer: ReturnType<typeof setInterval> | null = null;
  // запрос в полёте: сеть не возвращает мгновенно, двойной ход недопустим
  private sending = false;
  // красная подсветка рядов от серверного game.error (row → reason)
  private serverErrorRows = new Map<number, string>();
  // подтверждённый сервером стол: эталон для expire чужого черновика
  private lastConfirmedTable: { id: number; tiles: number[] }[] = [];
  private lastDraftPayload = '';
  private draftNewIds = new Set<number>();
  private draftFrom = -1;
  private draftExpireTimer = 0;
  private draftResendTimer = 0;
  // ===== очередь презентаций сетевых ходов (game.gd _present_queue) =====
  // Данные применяются сразу (стол всегда актуален), а показываются
  // строго по очереди: шаги — титр — шаги. Цепочки ботов иначе рвут
  // друг друга: следующий коммит прилетал раньше предыдущего.
  private presentQueue: Array<
    | { kind: 'title'; seat: number; text: string }
    | {
        kind: 'steps'; seat: number; ids: number[]; rowId: number;
        before: Map<number, TileSnapshot>; scrollTop: number;
      }
    | {
        kind: 'draft'; seat: number; ids: number[]; rowId: number;
        before: Map<number, TileSnapshot>; scrollTop: number;
      }
  > = [];
  private presentBusy = false;
  private presentGen = 0;
  private shownSeat = -1;
  private flightActive = false;
  private refreshPending = false;
  private titlePendingSeat = -1;
  private titleShownFor = -1;
  private pendingSteps: {
    ids: number[]; seat: number; rowId: number;
    before: Map<number, TileSnapshot>; scrollTop: number;
  }[] = [];
  private tableScrollRaf = 0;
  private tableScrollGeneration = 0;
  private tableScrollDone: (() => void) | null = null;
  // Троттлинг автопрокрутки стола за ходом бота: первое изменение поля
  // подхватываем сразу, дальше — не чаще раза в интервал, чтобы анимация
  // выкладки не перезапускалась на каждом шаге.
  private botScrollTimer = 0;
  private botScrollLastAt = 0;
  private botScrollRowId = -1;
  private botScrollGen = -1;
  private botScrollWaiters: Array<() => void> = [];
  private lastWaitEnv: GameEnvelope | null = null;
  // локальная статистика: партия считается, только если за столом ровно
  // один живой игрок (остальные — боты). Hot-seat не учитывается.
  private localStatsEligible = false;
  private localStatsHumanSeat = -1;
  private localStatsResultDone = false;
  private platformScoreReported = false;
  // wait-панель (paused/waiting/grace)
  private waitHost: Container | null = null;
  private waitLab: TextBlock | null = null;
  private graceTick: ReturnType<typeof setInterval> | null = null;

  private topRow!: StackPanel;
  private topActions!: StackPanel;
  private deckBtn!: Button;
  private saveBtn!: Button;
  private hintBtn!: Button;
  // Значок «AD» на кнопке подсказки: виден, когда бесплатная подсказка
  // использована и следующую можно получить только за просмотр рекламы.
  private hintAdBadge!: Rectangle;
  private timerLab!: TextBlock;
  private timerOverflowRow!: Container;
  private timerOverflowLab!: TextBlock;
  private timerText = '';
  private timerSample = '';
  private timerName = '';
  private timerMine = false;
  private timerOverflowByFit = false;
  private timerSecond = 0;
  private timerInOverflow = false;
  private timerOverflowHeight = 0;
  private allTopActionButtons: Button[] = [];
  private hiddenTopActionNames: string[] = [];
  private chipsRow!: StackPanel;
  private chipsScroll!: ScrollViewer;
  // Плавная горизонтальная прокрутка ряда чипов к игроку, чей сейчас ход.
  private chipsScrollRaf = 0;
  private chipsScrollToken = 0;
  private lastChipSeat = -1;
  private rowsScroll!: ScrollViewer;
  private rowsInner!: StackPanel;
  private handPanel!: Container;
  private handHost!: Container;
  private bottomBtn!: Button;
  private undoBtn!: Button;
  private restoreBtn!: Button;
  private popups!: Container;
  // отдельный слой для бейджей-«галочек»: они шире фишки и не должны
  // обрезаться ни ею, ни соседними фишками
  private badgeLayer!: Container;
  // Призраки перелёта находятся под бейджами, чтобы карточка не закрывала
  // собственную галочку во время движения.
  private flightLayer!: Container;
  // прежние фишки по id на время пересборки — чтобы перенести бейджи
  private inheritFigs: Map<number, TileFigure> | null = null;
  private ctx!: DropdownCtx;

  private rowFigs: RowFig[] = [];
  private rowSlots: { root: Container; fill: Rectangle; at: number }[] = [];
  private handFigs: TileFigure[] = [];
  private dragData: DragData | null = null;
  private dragPointer: { x: number; y: number } | null = null;
  private dragPointerAbort: AbortController | null = null;
  // Слот «новый ряд» между рядами раскрывается с короткой задержкой, чтобы
  // при быстром проносе фишки ряды не раздвигались на каждый кадр.
  private slotActiveAt = -1;
  private slotPendingAt = -1;
  private slotTimer = 0;
  private dragAutoScrollRaf = 0;
  private dragAutoScrollLast = 0;
  private hintTimer = 0;
  private hintsUsed = new Set<number>();
  // Подсветка должна переживать rebuildHand/resize, которые могут случиться
  // при возврате из rewarded-рекламы.
  private hintTileIds = new Set<number>();
  private toastHost: Container | null = null;
  private toastLabel: TextBlock | null = null;
  private flashTimer = 0;
  // Взятые из колоды: место -> id фишки. Пока фишка в руке взявшего —
  // галочка с кружочком в углу (game.gd _draw_marks, tile_view.gd badge).
  private drawMarks = new Map<number, number>();
  // Кто последним брал из колоды: чип показывает «· взял» до следующего
  // взятия или новой партии (game.gd _drew_seat).
  private drewSeat = -1;
  // Диалог подтверждения (Godot: _ask_confirm — «Взять карту», «Выход в меню»).
  private confirmUi: { overlay: Container; close: () => void } | null = null;
  private confirmAction: (() => void) | null = null;
  private flightOrigins = new Map<number, TileSnapshot>();
  private layoutAnimationId = 0;

  constructor(private host: OfflineHost) {}

  get root(): Container {
    return this.boardRoot;
  }

  build(root: Container): void {
    this.cancelActiveDrag();
    this.cancelTableScroll();
    this.cancelBotTableScroll();
    this.cancelChipsScroll();
    this.lastChipSeat = -1;
    this.layoutAnimationId += 1;
    this.boardRoot = root;
    root.clearControls();
    // панель ожидания жила в прежнем дереве — ссылки больше не валидны
    this.waitHost = null;
    this.waitLab = null;
    const bg = new Rectangle('bg');
    bg.background = SKIN.board;
    bg.thickness = 0;
    bg.width = '100%';
    bg.height = '100%';
    bg.isHitTestVisible = false;
    root.addControl(bg);

    this.popups = new Container('popups');
    this.popups.width = '100%';
    this.popups.height = '100%';
    this.popups.isHitTestVisible = false;
    root.addControl(this.popups);
    this.ctx = {
      openFor: (a, items, cur, cb, w) => popupList(this.popups, a, items, cur, cb, fs(12), w),
    };

    const col = new StackPanel('main');
    col.isVertical = true;
    col.width = '100%';
    col.height = '100%';
    col.paddingTop = px(TOP_PAD);
    root.addControl(col);

    this.buildTopbar(col);
    this.buildChipsRow(col);
    this.buildTable(col);
    this.buildHandArea(col);
    this.buildBottom(col);

    this.flightLayer = new Container('flightLayer');
    this.flightLayer.width = '100%';
    this.flightLayer.height = '100%';
    this.flightLayer.isHitTestVisible = false;
    this.flightLayer.isPointerBlocker = false;
    this.flightLayer.clipChildren = false;
    root.addControl(this.flightLayer);

    // Слой бейджей-«галочек»: поверх стола и руки, но ниже модалок —
    // как отдельный слой бейджей в оригинале (tile_view.gd _badge_host).
    // Кружок выходит за карточку и не режется ни фишкой, ни соседями.
    this.badgeLayer = new Container('badgeLayer');
    this.badgeLayer.width = '100%';
    this.badgeLayer.height = '100%';
    this.badgeLayer.isHitTestVisible = false;
    this.badgeLayer.isPointerBlocker = false;
    this.badgeLayer.clipChildren = false;
    root.addControl(this.badgeLayer);

    // popups → последним ребёнком root: порядок рисования в ADT — по
    // детям контейнера, модалки обязаны лежать над столом/рукой.
    if (this.popups.parent) this.popups.parent.removeControl(this.popups);
    root.addControl(this.popups);

    if (this.running) this.refresh();
  }

  private buildTopbar(col: StackPanel): void {
    this.topRow = new StackPanel('topRow');
    this.topRow.isVertical = false;
    this.topRow.width = '100%';
    this.topRow.height = px(46);
    this.topRow.spacing = 6;
    this.topRow.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    this.topRow.paddingLeft = px(SIDE_PAD);
    // Без правого отступа: последняя кнопка (бургер) упирается точно в
    // правый угол экрана.
    this.topRow.paddingRight = px(0);
    // Верхняя панель — горизонтальный StackPanel, который переопределяет
    // выравнивание детей. Поэтому кнопки действий лежат в отдельном
    // контейнере во всю ширину: внутри него горизонтальное выравнивание
    // работает, и бургер упирается точно в правый угол экрана. Хост кладём
    // ПЕРВЫМ, чтобы он не сдвигался вправо предыдущими братьями.
    const actionsHost = new Container('topActionsHost');
    actionsHost.width = '100%';
    actionsHost.height = px(46);
    actionsHost.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    actionsHost.isHitTestVisible = false;
    actionsHost.isPointerBlocker = false;
    this.topRow.addControl(actionsHost);
    const actions = new StackPanel('topActions');
    actions.isVertical = false;
    actions.height = px(46);
    actions.spacing = 6;
    actions.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    actions.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    actionsHost.addControl(actions);
    this.topActions = actions;
    col.addControl(this.topRow);

    this.deckBtn = mkButton(t('Колода: %d', 0), {
      height: 46, width: 108, fontSize: fs(15), theme: BUTTON_STYLE.deck,
    });
    this.deckBtn.onPointerUpObservable.clear();
    this.deckBtn.onPointerUpObservable.add(() => this.onDeckButton());
    this.deckBtn.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.topRow.addControl(this.deckBtn);

    // таймер хода (только сетевая партия)
    this.timerLab = mkLabel('', { fontSize: fs(14), color: SKIN.gold, width: 130, height: 46, noWrap: true, vAlign: 'center' });
    this.timerLab.textWrapping = false;
    this.topRow.addControl(this.timerLab);



    const mkTop = (label: string, onClick: () => void): Button => {
      // Godot (_make_top_button): минимум 60px, ширина — по фактическому
      // тексту (_top_button_need); текст не должен резаться всухую.
      const w = Math.max(60, Math.ceil(measureTextWidth(label, fs(15))) + 26);
      const b = mkButton(label, { height: 46, width: w, fontSize: fs(15), corner: 10, theme: { bg: '#26303F', hover: '#46566D', press: '#1E2733', border: '#ffffff22' } });
      b.onPointerUpObservable.clear();
      b.onPointerUpObservable.add(onClick);
      return b;
    };
    const save = mkTop(t('Сохр.'), () => this.onSaveCheckpoint());
    this.saveBtn = save;
    const restore = mkTop(t('Вернуть'), () => this.onRestoreCheckpoint());
    this.restoreBtn = restore;
    const hint = mkTop(t('Подск.'), () => this.onHint());
    this.hintBtn = hint;
    // Пометка «с рекламой» в правом верхнем углу кнопки подсказки.
    const badge = this.mkAdBadge();
    badge.isVisible = false;
    hint.addControl(badge);
    this.hintAdBadge = badge;
    const help = mkTop('?', () => this.showRulesOverlay());
    const settings = mkTop(t('Настр.'), () => this.showSettingsOverlay());
    const menu = mkTop(t('Меню'), () => {
      if (this.onlineMode) {
        // сетевая партия: подтверждение выхода из комнаты в лобби
        this.askConfirm(t('Выход в меню'), t('Выйти из партии в главное меню? Вы сможете вернуться.'), t('Выйти'), () => this.leaveToMenu());
        return;
      }
      this.askConfirm(t('Выход в меню'), t('Выйти в главное меню?'), t('Выйти'), () => {
        this.running = false;
        withInterstitial(() => this.host.toMenu());
      });
    });
    save.name = 'topSave';
    restore.name = 'topRestore';
    hint.name = 'topHint';
    help.name = 'topHelp';
    settings.name = 'topSettings';
    menu.name = 'topMenu';
    for (const b of [save, restore, hint, help, settings, menu]) actions.addControl(b);
    this.allTopActionButtons = [save, restore, hint, help, settings, menu];

    this.syncTopBar();
  }

  // Узкий экран: три «переполняющих» действия прячем в бургер.
  private syncTopBar(): boolean {
    const vw = viewWidth();
    const actions = this.topActions;
    if (!actions) return false;
    const sep = 6;
    const widthOf = (b: Control): number => {
      const measured = b.widthInPixels;
      const configured = Number.parseFloat(String(b.width));
      return measured || (Number.isFinite(configured) ? configured : 0) || 60;
    };
    const desiredTimerW = this.timerSample
      ? Math.ceil(measureTextWidth(this.timerSample, fs(14))) + 12
      : 0;
    const widthFor = (list: Control[], burger: boolean): number => {
      const actionWidth = list.reduce((acc, b) => acc + widthOf(b), 0)
        + Math.max(0, list.length - 1) * sep
        + (burger ? 60 + (list.length ? sep : 0) : 0);
      return actionWidth + widthOf(this.deckBtn) + 2 * sep;
    };
    const chooseActions = (timerW: number): { shown: Button[]; hasBurger: boolean } => {
      let shown = [...this.allTopActionButtons];
      let hasBurger = false;
      const fits = (): boolean => widthFor(shown, hasBurger) + timerW <= vw - SIDE_PAD * 2;
      while (shown.length > 0 && !fits()) {
        shown.pop();
        hasBurger = true;
      }
      return { shown, hasBurger };
    };
    let { shown, hasBurger } = chooseActions(desiredTimerW);
    // Сначала сохраняем таймер в верхней строке и убираем лишние действия
    // в бургер. Только если даже с одним бургером не хватает ширины —
    // переносим таймер и возвращаем максимум кнопок в строку.
    this.timerOverflowByFit = !!this.timerSample
      && widthFor(shown, hasBurger) + desiredTimerW > vw - SIDE_PAD * 2;
    if (this.timerOverflowByFit) {
      ({ shown, hasBurger } = chooseActions(0));
    }
    this.timerLab.width = px(this.timerOverflowByFit ? 0 : desiredTimerW);
    this.hiddenTopActionNames = this.allTopActionButtons
      .filter((b) => !shown.includes(b))
      .map((b) => b.name ?? '');
    let list: Control[] = shown;
    if (hasBurger) {
      const burger = mkButton('', {
        height: 46, width: 60, fontSize: fs(15), corner: 10,
        theme: { bg: '#26303F', hover: '#46566D', press: '#1E2733', border: '#ffffff22' },
      });
      // Классический бургер: три горизонтальные полоски. Рисуем их
      // прямоугольниками, чтобы значок не зависел от шрифта/глифа.
      const icon = new StackPanel('burgerIcon');
      icon.isVertical = true;
      icon.spacing = 8;
      icon.width = px(28);
      icon.height = px(25);
      icon.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
      icon.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
      icon.isPointerBlocker = false;
      icon.isHitTestVisible = false;
      for (let s = 0; s < 3; s += 1) {
        const stripe = new Rectangle(`burgerStripe${s}`);
        stripe.width = '100%';
        stripe.height = px(3);
        stripe.background = '#ffffffCC';
        stripe.thickness = 0;
        stripe.cornerRadius = 2;
        stripe.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
        stripe.isPointerBlocker = false;
        stripe.isHitTestVisible = false;
        icon.addControl(stripe);
      }
      burger.addControl(icon);
      burger.onPointerUpObservable.clear();
      burger.onPointerUpObservable.add(() => this.openBurger());
      list = [...shown, burger];
    }
    actions.clearControls();
    for (const c of list) actions.addControl(c);
    actions.width = px(list.reduce((acc, b) => acc + widthOf(b), 0) + Math.max(0, list.length - 1) * sep);
    return this.resizeTimerLayout();
  }

  private resetDrawMark(): void {
    this.drawMarks.clear();
    this.drewSeat = -1;
  }

  private clearDraftPresentation(): void {
    if (this.draftExpireTimer) window.clearTimeout(this.draftExpireTimer);
    this.draftExpireTimer = 0;
    this.draftNewIds.clear();
    this.draftFrom = -1;
    this.lastDraftPayload = '';
    this.presentQueue = this.presentQueue.filter((segment) => segment.kind !== 'draft');
    this.cancelTableScroll();
  }

  // Запомнить взятие (game.gd _note_draw): чип «· взял» у любого места,
  // галочка — на фишке в руке, пока она там.
  private noteDraw(seat: number, tileId: number | null): void {
    if (tileId !== null && tileId > 0) this.drawMarks.set(seat, tileId);
    this.drewSeat = seat;
  }

  // Место взяло из колоды: рука выросла на одну при том же столе и без
  // выкладки (game.gd _seat_drew, 1766-1785).
  private seatDrew(prev: GameState, view: GameView, seat: number): boolean {
    if (seat < 0 || seat >= prev.playerCount()) return false;
    if ((view.lastTurn ?? []).length > 0) return false;
    const hc = view.players[seat]?.handCount ?? -1;
    if (prev.handSize(seat) + 1 !== hc) return false;
    const a = prev.table.map((r) => r.tiles.map((t) => t.id));
    const b = view.table.map((r) => r.tileIds);
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private turnTitleText(): string {
    if (!this.state) return '';
    const nm = this.state.playerName(this.state.current);
    return this.currentPlayerIsBot() ? t('Ход: %s (бот)', nm) : t('Ход: %s', nm);
  }

  // Титр хода: большой текст по центру, появление — плавное, как в
  // Godot (_flash_turn_title): 0.3с проявление, 0.7с пауза, 0.35с уход.
  private flashTurnTitle(text: string): void {
    if (this.flashTimer) window.clearTimeout(this.flashTimer);
    // Убираем только прежний титр и пас-оверлей. Бургер с кнопками и
    // другие модалки не трогаем: меню должно переживать смену хода.
    for (const c of [...this.popups.children]) {
      if (c.name === 'flash' || c.name === 'pass') this.popups.removeControl(c);
    }
    const overlay = new Container('flash');
    overlay.width = '100%';
    overlay.height = '100%';
    overlay.zIndex = 640;
    overlay.isPointerBlocker = false;
    const dim = new Rectangle('flashDim');
    dim.background = '#0D1017';
    dim.thickness = 0;
    dim.width = '100%';
    dim.height = '100%';
    dim.isPointerBlocker = true;
    overlay.addControl(dim);
    const titleWidth = Math.max(180, viewWidth() - 48);
    let titleSize = fs(56);
    const minSize = 18;
    const maxTitleHeight = Math.max(72, Math.floor(viewHeight() * 0.46));
    let wrappedTitle = text;
    let titleHeight = 0;
    // Сохраняем крупный титр, пока он укладывается в ширину/высоту. Для
    // длинного имени переносим слова и лишь затем уменьшаем шрифт — никакой
    // части «Ход» или суффикса «(бот)» не обрезаем.
    while (true) {
      wrappedTitle = wrapTextToWidth(text, titleWidth, titleSize);
      titleHeight = estimateWrappedTextHeight(wrappedTitle, titleWidth, titleSize);
      if (titleHeight <= maxTitleHeight || titleSize <= minSize) break;
      titleSize = Math.max(minSize, titleSize - 2);
    }
    const lab = mkLabel(wrappedTitle, {
      fontSize: titleSize,
      color: SKIN.gold,
      width: titleWidth,
      height: titleHeight,
    });
    overlay.addControl(lab);
    this.popups.addControl(overlay);
    overlay.alpha = 0;
    const t0 = Date.now();
    const tick = (): void => {
      const el = Date.now() - t0;
      if (el < 300) overlay.alpha = el / 300;
      else if (el < 1000) overlay.alpha = 1;
      else if (el < 1350) overlay.alpha = 1 - (el - 1000) / 350;
      else {
        if (overlay.parent) this.popups.removeControl(overlay);
        this.flashTimer = 0;
        // титр стирал попапы, включая панель ожидания — вернуть её
        if (this.lastWaitEnv) this.applyWaitState(this.lastWaitEnv);
        return;
      }
      this.flashTimer = window.setTimeout(tick, 32);
    };
    tick();
  }

  private buildChipsRow(col: StackPanel): void {
    const scroll = new ScrollViewer('chipsScroll');
    this.chipsScroll = scroll;
    scroll.thickness = 0;
    scroll.width = '100%';
    scroll.height = px(50);
    scroll.paddingLeft = px(SIDE_PAD);
    scroll.paddingRight = px(SIDE_PAD);
    // Тонкая полоска прокрутки (4px) вместо стандартной 20px.
    scroll.barSize = 4;
    col.addControl(scroll);
    enableSmoothScroll(scroll, 'horizontal');
    this.timerOverflowRow = new Container('timerOverflowRow');
    this.timerOverflowRow.width = '100%';
    this.timerOverflowRow.height = px(0);
    this.timerOverflowRow.isVisible = false;
    this.timerOverflowRow.isHitTestVisible = false;
    this.timerOverflowLab = mkLabel('', {
      fontSize: fs(14), color: SKIN.gold, width: Math.max(120, viewWidth() - 24),
      height: 0, noWrap: true, hAlign: 'center', align: 'center', vAlign: 'center',
    });
    this.timerOverflowLab.isHitTestVisible = false;
    this.timerOverflowRow.addControl(this.timerOverflowLab);
    col.addControl(this.timerOverflowRow);
    const box = new StackPanel('chips');
    box.isVertical = false;
    box.spacing = 6;
    box.adaptWidthToChildren = true;
    box.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    scroll.addControl(box);
    this.chipsRow = box;
  }

  // Фиксированная вертикаль: верхний отступ колонки, верхняя панель,
  // ряд игроков и нижние кнопки.
  private fixedVSpace(): number {
    return TOP_PAD + 46 + 50 + this.timerOverflowHeight + 58;
  }

  // Минимальная высота стола: на очень низких окнах стол ужимается,
  // чтобы рука и нижние кнопки остались на экране, а не уехали за край.
  private static readonly MIN_TABLE_H = 56;

  // Стол — весь остаток экрана, поэтому низ прижат к нижнему краю. Рука
  // считается в худшем случае (14 фишек, уменьшенный размер), чтобы стол
  // никогда не забирал себе её место.
  private tableHeightPx(): number {
    const vh = viewHeight();
    const hs = this.handTileSize();
    return Math.max(OfflineGame.MIN_TABLE_H, Math.floor(vh - this.fixedVSpace() - (hs.y + 26)));
  }

  private buildTable(col: StackPanel): void {
    this.rowsScroll = new ScrollViewer('tableScroll');
    this.rowsScroll.thickness = 0;
    this.rowsScroll.width = '100%';
    this.rowsScroll.height = px(this.tableHeightPx());
    this.rowsScroll.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    // Оставляем тонкий индикатор вертикальной прокрутки.
    this.rowsScroll.barSize = 4;
    // Горизонтального скролла у стола быть не должно: он сдвигал бы ряды
    // вправо и обрезал их. Прячем полосу и запрещаем её появление.
    (this.rowsScroll as unknown as { _horizontalBar: Control })._horizontalBar.isVisible = false;
    (this.rowsScroll as unknown as { _forceHorizontalBar: boolean })._forceHorizontalBar = false;
    col.addControl(this.rowsScroll);
    enableSmoothScroll(this.rowsScroll, 'vertical', { tileDragAllowed: () => this.canInteract() });
    const innerHolder = new StackPanel('innerHolder');
    innerHolder.isVertical = true;
    // Не даём вертикальному StackPanel сжать окно контента до ширины ряда.
    // Иначе сам ряд шириной viewport-24 (с левым отступом 12px) выходит за
    // фактическую clipping-область ScrollViewer на 12px справа.
    innerHolder.width = '100%';
    // Небольшой отступ между рядами: ряды визуально плотнее, а слот
    // «новый ряд» при наведении раздвигает соседей сам.
    innerHolder.spacing = 4;
    // бейджи-«галочки» выходят за карточку — не режем их рядами
    innerHolder.clipChildren = false;
    // Ряды и слоты уже позиционируются с left=SIDE_PAD, а ширина их рамок
    // уже уменьшена на оба отступа. Дополнительный padding здесь сжимал
    // сам ScrollViewer content ещё на 24px и обрезал правый край панели.
    innerHolder.paddingLeft = px(0);
    innerHolder.paddingRight = px(0);
    innerHolder.paddingTop = px(8);
    innerHolder.paddingBottom = px(8);
    this.rowsScroll.addControl(innerHolder);
    this.rowsInner = innerHolder;
  }

  // Ширина области руки (внутри зелёной панели).
  private handAvailW(): number {
    const panelW = Math.max(180, viewWidth() - SIDE_PAD * 2);
    return Math.max(120, panelW - 16);
  }

  // Эффективный размер фишки в руке. На маленьких экранах с крупными
  // карточками 14 фишек даже с переносом строк не помещаются — уменьшаем
  // их так, чтобы вся рука влезала на экран целиком.
  private handTileSize(): { x: number; y: number } {
    const ts = tileSize();
    const availW = this.handAvailW();
    // Сохраняем минимум высоты стола, кнопки и отступы. Уменьшение
    // пересчитывает число карточек в ряду — важно: при крупном размере
    // достаточно уменьшить ширину, чтобы 14 фишек уместились в 2–3 ряда.
    const maxHandH = Math.max(1, viewHeight() - this.fixedVSpace()
      - OfflineGame.MIN_TABLE_H - 26);
    const layoutAt = (scale: number): { size: { x: number; y: number }; height: number } => {
      const size = {
        x: Math.max(18, Math.round(ts.x * scale)),
        y: Math.max(22, Math.round(ts.y * scale)),
      };
      const gap = flowGap(size);
      const perRow = Math.max(1, Math.floor((availW + gap) / (size.x + gap)));
      const rows = Math.ceil(14 / perRow);
      return { size, height: rows * (size.y + gap) - gap };
    };
    const full = layoutAt(1);
    if (full.height <= maxHandH) return ts;
    let low = 0.05;
    let high = 1;
    for (let i = 0; i < 16; i += 1) {
      const mid = (low + high) / 2;
      if (layoutAt(mid).height <= maxHandH) low = mid;
      else high = mid;
    }
    return layoutAt(low).size;
  }

  private buildHandArea(col: StackPanel): void {
    const ts = this.handTileSize();
    this.handPanel = softPanel({
      bg: '#1A5C38',
      bgAlpha: 0.72,
      border: '#7ADB8CD9',
      thickness: 2,
      corner: 12,
      height: ts.y + 26,
    }).root;
    this.handPanel.width = px(Math.max(180, viewWidth() - SIDE_PAD * 2));
    this.handPanel.clipChildren = false;
    this.handPanel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    col.addControl(this.handPanel);
    // Рука без скролла: фишки переносятся на следующие ряды (layoutFlow),
    // высота панели растёт под фактическое число рядов.
    this.handHost = new Container('handHost');
    this.handHost.width = px(this.handAvailW());
    this.handHost.height = px(ts.y);
    this.handHost.clipChildren = false;
    this.handHost.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.handPanel.addControl(this.handHost);
  }

  private bottomButtonWidth(): number {
    // 10px отступы контейнера + 10px зазор между кнопками.
    return Math.max(80, Math.floor((viewWidth() - 20 - 10) / 2));
  }

  private buildBottom(col: StackPanel): void {
    const bottom = new StackPanel('bottom');
    bottom.isVertical = false;
    bottom.width = '100%';
    // 6px сверху + 52px кнопка: внизу под кнопками зазора нет
    bottom.height = px(58);
    bottom.spacing = 10;
    bottom.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
    bottom.paddingLeft = px(10);
    bottom.paddingRight = px(10);
    bottom.paddingTop = px(6);
    col.addControl(bottom);
    const bw = this.bottomButtonWidth();
    this.undoBtn = mkButton(t('Отменить ход'), { height: 52, fontSize: fs(16), width: bw, theme: BUTTON_STYLE.deck });
    this.undoBtn.onPointerUpObservable.clear();
    this.undoBtn.onPointerUpObservable.add(() => this.onUndo());
    bottom.addControl(this.undoBtn);
    this.bottomBtn = mkButton(t('Взять'), { height: 52, fontSize: fs(16), width: bw, theme: BUTTON_STYLE.green });
    this.bottomBtn.onPointerUpObservable.clear();
    this.bottomBtn.onPointerUpObservable.add(() => this.onMainButton());
    bottom.addControl(this.bottomBtn);
    // Всплывающее предупреждение — крупная панель сверху по центру
    // (Godot *toast*); убирается кликом по ней.
    const toastHost = new Container('toast');
    toastHost.width = px(Math.min(viewWidth() - 40, 480));
    toastHost.height = px(52);
    toastHost.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    toastHost.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    toastHost.top = px(96);
    toastHost.zIndex = 620;
    toastHost.isPointerBlocker = true;
    toastHost.isVisible = false;
    const fill = new Rectangle('toastFill');
    fill.background = '#26201A';
    fill.alpha = 0.96;
    fill.cornerRadius = 12;
    fill.color = '#FFD54F88';
    fill.thickness = 2;
    fill.width = '100%';
    fill.height = '100%';
    toastHost.addControl(fill);
    this.toastLabel = mkLabel('', { fontSize: fs(18), color: '#FFE0B2', noWrap: false });
    toastHost.addControl(this.toastLabel);
    // тап по тосту — убрать
    toastHost.onPointerUpObservable.add(() => {
      if (this.hintTimer) {
        window.clearTimeout(this.hintTimer);
        this.hintTileIds.clear();
        this.refresh();
      }
      this.hintTimer = 0;
      if (this.toastHost) this.toastHost.isVisible = false;
    });
    this.boardRoot.addControl(toastHost);
    this.toastHost = toastHost;
  }

  startGame(state: GameState): void {
    this.state = state;
    this.running = true;
    this.platformScoreReported = false;
    this.cancelBotTableScroll();
    this.clearDraftPresentation();
    this.hintsUsed.clear();
    this.hintTileIds.clear();
    this.initLocalStats();
    this.resetDrawMark();
    // новый матч: очередь показа и её метки — с чистого листа
    this.presentGen += 1;
    this.presentQueue = [];
    this.presentBusy = false;
    this.flightActive = false;
    this.refreshPending = false;
    this.titlePendingSeat = -1;
    this.pendingSteps = [];
    this.shownSeat = -1;
    this.titleShownFor = -1;
    this.lastWaitEnv = null;
    this.build(this.boardRoot ?? this.host.screenRoot());
    this.refresh();
    this.checkPassOrBot(true);
    // Партия началась (локальная и сетевая через applyOnlineView) —
    // разметка геймплея для площадок.
    platform.gameplayStart();
  }

  // Локальная статистика ведётся только для «один человек против ботов».
  // Если людей за одним устройством двое и больше — это hot-seat, его не
  // считаем ни в партиях, ни в победах/поражениях. Сетевые партии сюда
  // тоже не попадают: их считает сервер.
  private initLocalStats(): void {
    this.localStatsEligible = false;
    this.localStatsHumanSeat = -1;
    this.localStatsResultDone = false;
    if (this.onlineMode || !this.state) return;
    const humans: number[] = [];
    this.state.players.forEach((p, i) => {
      if (!p.is_bot) humans.push(i);
    });
    if (humans.length !== 1) return;
    this.localStatsEligible = true;
    this.localStatsHumanSeat = humans[0];
    recordLocalGameStarted();
  }

  // ===== сетевая партия =====

  // GAME_STATE/DRAFT приходят из wireApi; все локальные правки — превью,
  // сервер подтверждает их (commit) либо отклоняет (GAME_ERROR).
  applyOnlineView(env: GameEnvelope): void {
    this.onlineMode = true;
    // Серверное состояние может прийти пока палец держит фишку. Старый
    // источник нельзя оставлять в отсоединённом дереве во время refresh.
    if (this.dragData) this.cancelActiveDrag();
    const view = env.state;
    const continuing = this.running && !!this.state && !this.state.finished
      && this.roomCode === view.code;
    const prev = continuing ? this.state : null;
    // Визуальные источники нужны для сетевой анимации перемещения уже
    // лежащих фишек: сервер присылает только конечное состояние ряда.
    const beforeVisuals = continuing ? this.captureTileSnapshots() : new Map<number, TileSnapshot>();
    const beforeScrollTop = this.tableScrollOffsetPx();
    const prevHandIds = prev ? prev.hand().map((t) => t.id) : null;
    // «прилетающие» фишки: впервые попали в серверный стол с этим
    // состоянием (game.gd _fresh_committed_ids)
    const freshIds: number[] = [];
    if (prev) {
      const old = new Set<number>();
      for (const r of prev.table) for (const t of r.tiles) old.add(t.id);
      for (const r of view.table) {
        for (const id of r.tileIds) {
          if (id > 0 && !old.has(id) && !freshIds.includes(id)) freshIds.push(id);
        }
      }
    }
    const changedRowId = prev ? this.changedTableRowId(prev, view.table) : -1;
    const nSeats = view.players.length || 1;
    const curSeat = Math.min(Math.max(view.current, 0), nSeats - 1);
    if (prev && prev.current !== curSeat) this.lastDraftPayload = '';
    // Черновик живёт только до окончания хода автора. Как только сервер
    // передал ход дальше (commit/draw/skip), прозрачность и бейджи draft
    // снимаются немедленно; committed tiles остаются зелёными через
    // lastTurnTileIds до следующего перехода хода.
    if (this.draftFrom >= 0 && (view.finished || curSeat !== this.draftFrom)) {
      this.clearDraftPresentation();
      this.cancelTableScroll();
    }
    const moverSeat = (view.lastTurn ?? []).length === 0
      ? (changedRowId >= 0 && prev ? prev.current : curSeat)
      : (curSeat - 1 + nSeats) % nSeats;
    this.roomCode = view.code;
    this.clearServerErrorRows();
    this.stopRejoinLoop();
    this.stopDraftResend();
    const st = GameState.fromView(view);
    // наша незавершённая раскладка переживает промежуточный game.state
    st.keepLocalTurnFrom(prev);
    if (!continuing) {
      // первое состояние — загрузка стола, а не ход: без очереди
      this.presentGen += 1;
      this.presentQueue = [];
      this.presentBusy = false;
      this.flightActive = false;
      this.refreshPending = false;
      this.titlePendingSeat = -1;
      this.pendingSteps = [];
      this.shownSeat = -1;
      this.startGame(st);
      this.applyWaitState(env);
    } else {
      this.state = st;
      // галочка и чип «· взял»: наша рука выросла ровно на одну фишку —
      // это наше взятие (game.gd _mark_drawn_diff, 2405-2419)
      if (prevHandIds) {
        const added = view.hand.filter((id) => !prevHandIds.includes(id));
        if (added.length === 1) this.noteDraw(view.you, added[0]);
      }
      // Чужое взятие: тот, кто ходил перед текущим, увеличил руку при том
      // же столе и пустом lastTurn (game.gd _seat_drew:1781). Взятие
      // передаёт ход, поэтому место берём СМЕЩЁННЫМ от current, а не
      // mv_seat презентации (при пустом lastTurn он равен текущему).
      const drawSeat = (curSeat - 1 + nSeats) % nSeats;
      if (prev && drawSeat >= 0 && drawSeat !== view.you
        && this.seatDrew(prev, view, drawSeat)) {
        this.drewSeat = drawSeat;
      }
      // пока летит сегмент чужого хода, виды не пересобираем: пересборка
      // убивает полёт. Данные уже применены — откладываем только показ.
      if (this.flightActive) {
        this.refreshPending = true;
        if (!view.finished && (freshIds.length > 0 || changedRowId >= 0) && moverSeat !== view.you) {
          this.pendingSteps.push({
            ids: freshIds, seat: moverSeat, rowId: changedRowId,
            before: beforeVisuals, scrollTop: beforeScrollTop,
          });
        }
        this.titlePendingSeat = view.current;
      } else {
        this.refresh();
        if (!view.finished && (freshIds.length > 0 || changedRowId >= 0) && moverSeat !== view.you) {
          this.enqueueSteps(freshIds, moverSeat, beforeVisuals, beforeScrollTop, changedRowId);
        }
        this.enqueueTurnTitle();
      }
      this.applyWaitState(env);
    }
    this.sending = false;
    this.lastConfirmedTable = view.table.map((r) => ({ id: r.id, tiles: [...r.tileIds] }));
    // Сетевые партии в локальные счётчики не пишем: сервер ведёт свою
    // статистику, и её показывает отдельный блок «Сетевые партии».
    this.setTurnTimer(view.turnLeft, view.myTurn, view.current);
    if (view.finished) {
      // показ прерван: подсветка — на победителя по состоянию
      this.presentGen += 1;
      this.presentQueue = [];
      this.presentBusy = false;
      this.flightActive = false;
      this.refreshPending = false;
      this.titlePendingSeat = -1;
      this.pendingSteps = [];
      this.shownSeat = -1;
      this.refresh();
      this.showWin();
    }
  }

  // ===== очередь презентаций =====

  private turnTitleFor(seat: number): string {
    if (!this.state) return '';
    // свой ход в сети кричим явно (game.gd:1958-1972)
    if (this.onlineMode && this.state.local_seat >= 0 && seat === this.state.local_seat) {
      return t('Ваш ход!');
    }
    const nm = this.state.playerName(seat);
    const isBot = seat >= 0 && seat < this.state.players.length
      ? !!this.state.players[seat].is_bot : false;
    return isBot ? t('Ход: %s (бот)', nm) : t('Ход: %s', nm);
  }

  private enqueueTurnTitle(): void {
    if (!this.state || this.state.finished) return;
    const seat = this.state.current;
    if (this.refreshPending) {
      this.titlePendingSeat = seat;
      return;
    }
    this.appendTurnTitle(seat);
  }

  private appendTurnTitle(seat: number): void {
    if (!this.state || this.state.finished || seat < 0) return;
    // Одно и то же место подряд не титруем: свой ход после своего же
    // показа («Ход: вы» дважды) мигал бы. А вот «Ваш ход!» после чужого
    // взятия (шагов нет, но ход перешёл к нам) показываем — как и для
    // других игроков.
    if (seat === this.titleShownFor) return;
    this.titleShownFor = seat;
    this.presentQueue.push({ kind: 'title', seat, text: this.turnTitleFor(seat) });
    void this.pumpPresent();
  }

  private enqueueSteps(
    ids: number[],
    seat: number,
    before: Map<number, TileSnapshot>,
    scrollTop: number,
    rowIdHint: number,
  ): void {
    // GAME_STATE подтверждает весь сетевой ход одним пакетом, в отличие от
    // локального бота, который обновляет стол после каждой фишки. Запоминаем
    // ряд последней фишки хода, чтобы прокрутить к нему при показе коммита.
    const moved = new Set(ids);
    let targetTile = -1;
    const lastTurn = this.state?.last_turn_tile_ids ?? [];
    for (let i = lastTurn.length - 1; i >= 0; i -= 1) {
      if (moved.has(lastTurn[i])) {
        targetTile = lastTurn[i];
        break;
      }
    }
    if (targetTile < 0) targetTile = ids[ids.length - 1];
    const rowId = rowIdHint >= 0 ? rowIdHint : this.rowIdOfTile(targetTile);
    if (rowId < 0 && ids.length === 0) return;
    this.presentQueue.push({ kind: 'steps', seat, ids: [...ids], rowId, before, scrollTop });
    void this.pumpPresent();
  }

  // Титр ещё актуален: тот игрок ходит прямо сейчас или только что сходил
  private titleFresh(seat: number): boolean {
    if (!this.state || this.state.finished || seat < 0) return false;
    const n = this.state.playerCount();
    if (n <= 0) return false;
    let back = (this.state.current - seat) % n;
    if (back < 0) back += n;
    return back <= 1;
  }

  // Чип подсвечиваем того, кого ПОКАЗЫВАЕМ, а не current по серверу:
  // сервер уже передал ход, а фишки прошлого игрока ещё летят.
  private highlightSeat(): number {
    if (this.shownSeat >= 0) return this.shownSeat;
    return this.state ? this.state.current : -1;
  }

  private showSeat(seat: number): void {
    if (this.shownSeat === seat) return;
    this.shownSeat = seat;
    this.rebuildChips();
  }

  // Крутит очередь: шаги — титр — шаги. Данные уже применены, здесь
  // только показ; следующий сегмент стартует после предыдущего.
  private async pumpPresent(): Promise<void> {
    if (this.presentBusy) return;
    this.presentBusy = true;
    const gen = this.presentGen;
    while (this.presentQueue.length > 0 && gen === this.presentGen && this.running) {
      // Немедленный DRAFT может проигрываться, пока эта очередь ждёт титр;
      // не запускаем следующий committed-сегмент поверх его анимации.
      if (this.flightActive) {
        await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
        continue;
      }
      const seg = this.presentQueue.shift()!;
      if (seg.kind === 'title') {
        if (this.titleFresh(seg.seat)) {
          this.showSeat(seg.seat);
          this.flashTurnTitle(seg.text);
          await new Promise<void>((r) => window.setTimeout(r, 1450));
        }
      } else {
        this.showSeat(seg.seat);
        if (seg.kind === 'draft') {
          if (this.draftFrom !== seg.seat || !this.state || this.state.myTurn()) {
            if (!this.finishPresentedSegment(gen)) return;
            continue;
          }
          this.flightActive = true;
          await this.playQueuedRemoteMove(
            seg.before, seg.ids, seg.seat, seg.rowId, seg.scrollTop, gen, false,
          );
          if (!this.finishPresentedSegment(gen)) return;
          continue;
        } else {
          this.flightActive = true;
          // В сети бот обычно присылает один финальный GAME_STATE за ход, а
          // не промежуточные обновления как локальный бот. Поэтому без этого
          // пути committed-фишки анимировались, но стол к ним не прокручивался.
          if (this.onlineMode && this.state?.players[seg.seat]?.is_bot) {
            await this.playQueuedRemoteMove(
              seg.before, seg.ids, seg.seat, seg.rowId, seg.scrollTop, gen,
            );
            if (!this.finishPresentedSegment(gen)) return;
            continue;
          }
        }
        await this.playQueuedSteps(seg.ids, gen, seg.seat);
        if (!this.finishPresentedSegment(gen)) return;
      }
    }
    if (gen === this.presentGen) {
      this.presentQueue = [];
      this.presentBusy = false;
      this.showSeat(-1);
    }
  }

  private finishPresentedSegment(gen: number): boolean {
    this.flightActive = false;
    if (gen !== this.presentGen) return false;
    if (this.refreshPending) {
      this.refreshPending = false;
      this.refresh();
    }
    const pending = this.pendingSteps.splice(0);
    for (const p of pending) this.enqueueSteps(p.ids, p.seat, p.before, p.scrollTop, p.rowId);
    if (this.titlePendingSeat >= 0) {
      const seat = this.titlePendingSeat;
      this.titlePendingSeat = -1;
      this.appendTurnTitle(seat);
    }
    return true;
  }

  private async playDraftPreview(seg: {
    seat: number; ids: number[]; rowId: number;
    before: Map<number, TileSnapshot>; scrollTop: number;
  }): Promise<void> {
    const gen = this.presentGen;
    this.showSeat(seg.seat);
    this.flightActive = true;
    if (this.draftFrom !== seg.seat || !this.state || this.state.myTurn()) {
      if (this.finishPresentedSegment(gen)) void this.pumpPresent();
      return;
    }
    await this.playQueuedRemoteMove(
      seg.before, seg.ids, seg.seat, seg.rowId, seg.scrollTop, gen, false,
    );
    if (!this.finishPresentedSegment(gen)) return;
    void this.pumpPresent();
  }

  private cancelTableScroll(): void {
    this.tableScrollGeneration += 1;
    if (this.tableScrollRaf) window.cancelAnimationFrame(this.tableScrollRaf);
    this.tableScrollRaf = 0;
    const done = this.tableScrollDone;
    this.tableScrollDone = null;
    done?.();
  }

  // Поставить/сдвинуть цель автопрокрутки. Первый вызов (или если с прошлой
  // прокрутки прошло достаточно времени) срабатывает сразу; частые вызовы
  // в пределах окна троттлинга схлопываются в один отложенный — им уедет
  // самая свежая цель.
  private queueBotTableScroll(rowId: number, gen: number): Promise<void> {
    if (rowId < 0) return Promise.resolve();
    this.botScrollRowId = rowId;
    this.botScrollGen = gen;
    const waitForScroll = new Promise<void>((resolve) => this.botScrollWaiters.push(resolve));
    const since = performance.now() - this.botScrollLastAt;
    if (since >= BOT_SCROLL_THROTTLE_MS) {
      this.flushBotTableScroll();
    } else if (!this.botScrollTimer) {
      this.botScrollTimer = window.setTimeout(
        () => this.flushBotTableScroll(),
        Math.max(0, BOT_SCROLL_THROTTLE_MS - since),
      );
    }
    return waitForScroll;
  }

  private flushBotTableScroll(): void {
    if (this.botScrollTimer) {
      window.clearTimeout(this.botScrollTimer);
      this.botScrollTimer = 0;
    }
    const rowId = this.botScrollRowId;
    const gen = this.botScrollGen;
    const waiters = this.botScrollWaiters.splice(0);
    this.botScrollRowId = -1;
    if (rowId < 0 || gen !== this.presentGen || !this.running) {
      for (const resolve of waiters) resolve();
      return;
    }
    this.botScrollLastAt = performance.now();
    void this.scrollTableToRow(rowId, gen).then(() => {
      for (const resolve of waiters) resolve();
    });
  }

  private cancelBotTableScroll(): void {
    if (this.botScrollTimer) {
      window.clearTimeout(this.botScrollTimer);
      this.botScrollTimer = 0;
    }
    this.botScrollRowId = -1;
    this.botScrollGen = -1;
    this.botScrollLastAt = 0;
    for (const resolve of this.botScrollWaiters.splice(0)) resolve();
  }

  // Текущий вертикальный scroll offset в экранных пикселях. Нужен, чтобы
  // сдвинуть сохранённые экранные координаты фишек на величину автоскролла.
  private tableScrollOffsetPx(): number {
    const sc = this.rowsScroll as unknown as {
      _verticalBar?: { value: number };
      _window?: { _currentMeasure?: { height: number } };
      _clientHeight?: number;
      host?: { idealRatio?: number };
    };
    const value = sc._verticalBar?.value;
    const content = sc._window?._currentMeasure?.height;
    const view = sc._clientHeight;
    const ratio = sc.host?.idealRatio ?? 1;
    if (typeof value !== 'number' || typeof content !== 'number'
      || typeof view !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return 0;
    return value * Math.max(0, (content - view) / ratio);
  }

  private scrollTableToRow(rowId: number, gen: number): Promise<void> {
    this.cancelTableScroll();
    if (rowId < 0) return Promise.resolve();
    const token = this.tableScrollGeneration + 1;
    this.tableScrollGeneration = token;
    return new Promise<void>((resolve) => {
      this.tableScrollDone = resolve;
      let layoutFrames = 0;
      let stalledFrames = 0;
      let last = performance.now();
      // На мобильных WebView Babylon иногда обновляет размеры ScrollViewer
      // позже кадра пересборки ряда. Не отменяем автоскролл из-за первых
      // нулевых замеров/шага: ждём повторного layout и пробуем прокрутить ещё.
      const MAX_LAYOUT_FRAMES = 30;
      const MAX_STALLED_FRAMES = 10;
      const finish = (): void => {
        if (this.tableScrollGeneration !== token) return;
        if (this.tableScrollRaf) window.cancelAnimationFrame(this.tableScrollRaf);
        this.tableScrollRaf = 0;
        this.tableScrollDone = null;
        resolve();
      };
      const tick = (now: number): void => {
        this.tableScrollRaf = 0;
        if (token !== this.tableScrollGeneration || gen !== this.presentGen || !this.running) {
          finish();
          return;
        }
        const row = this.rowFigs.find((fig) => !fig.hintZone && fig.rowId === rowId);
        const target = row ? rectOf(row.root) : { x: 0, y: 0, w: 0, h: 0 };
        const viewport = rectOf(this.rowsScroll);
        if (!row || target.w <= 0 || target.h <= 0 || viewport.h <= 0) {
          if (layoutFrames++ < MAX_LAYOUT_FRAMES) this.tableScrollRaf = window.requestAnimationFrame(tick);
          else finish();
          return;
        }
        const margin = Math.min(18, viewport.h * 0.08);
        let delta = 0;
        if (target.h >= viewport.h - margin * 2) {
          delta = target.y - (viewport.y + margin);
        } else if (target.y < viewport.y + margin) {
          delta = target.y - (viewport.y + margin);
        } else if (target.y + target.h > viewport.y + viewport.h - margin) {
          delta = target.y + target.h - (viewport.y + viewport.h - margin);
        }
        if (Math.abs(delta) < 2) {
          finish();
          return;
        }
        const elapsed = Math.max(8, Math.min(34, now - last));
        last = now;
        const step = Math.sign(delta) * Math.min(Math.abs(delta), 720 * elapsed / 1000);
        if (Math.abs(scrollViewerByPixels(this.rowsScroll, 'vertical', step)) < 0.1) {
          if (stalledFrames++ < MAX_STALLED_FRAMES) {
            last = now;
            this.tableScrollRaf = window.requestAnimationFrame(tick);
          } else finish();
          return;
        }
        stalledFrames = 0;
        this.tableScrollRaf = window.requestAnimationFrame(tick);
      };
      this.tableScrollRaf = window.requestAnimationFrame(tick);
    });
  }

  // Пошаговый прилёт фишек из очереди: прячем их и «привозим» по одной,
  // как в оригинале (_play_queued_steps, game.gd:3404-3447): шаг 0.18 с,
  // полёт TILE_FLY_DUR = 0.34 с, старт — из чипа автора хода. Титр
  // следующего хода встаёт в очередь ПОСЛЕ этих шагов, поэтому сначала
  // проигрывается весь чужой ход, и только потом надпись «Ход: …».
  private async playQueuedSteps(ids: number[], gen: number, seat: number): Promise<void> {
    const figures = this.currentTileFigures();
    const figs: TileFigure[] = [];
    for (const id of ids) {
      const fig = figures.get(id);
      if (fig) figs.push(fig);
    }
    if (figs.length === 0) return;
    // Прячем сразу все: иначе фишки, чья очередь ещё не дошла, мигают на
    // своём месте до начала полёта.
    for (const f of figs) f.root.alpha = 0;
    // Только что пересобранный ряд ещё не получил ширины: Babylon считает
    // раскладку на кадре рендера, и цель полёта сейчас — (0,0). Ждём до
    // трёх кадров, как _views_laid_out в оригинале (game.gd:3423-3433).
    for (let i = 0; i < 3; i += 1) {
      if (figs.every((f) => rectOf(f.root).w > 0)) break;
      await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
      if (gen !== this.presentGen || !this.running) return;
    }
    if (gen !== this.presentGen || !this.running) return;
    const ts = tileSize();
    const targets: { fig: TileFigure; to: { x: number; y: number; w: number; h: number } }[] = [];
    for (const fig of figs) {
      const to = rectOf(fig.root);
      if (to.w <= 0 || to.h <= 0) continue;
      targets.push({ fig, to });
    }
    if (targets.length === 0) {
      for (const f of figs) f.root.alpha = f.rgbaAlpha;
      return;
    }
    const sourceChip = this.chipsRow.children[seat];
    if (sourceChip) this.ensureSeatChipVisible(sourceChip);
    await new Promise<void>((r) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => r())));
    if (gen !== this.presentGen || !this.running) return;
    const spawn = this.chipSpawnRect(seat, ts);
    let maxEnd = 0;
    targets.forEach(({ fig, to }, i) => {
      const delay = Math.min(i * 180, 1200);
      const duration = 340;
      maxEnd = Math.max(maxEnd, delay + duration);
      const start = { face: fig.face, rect: { x: spawn.x, y: spawn.y, w: to.w, h: to.h } };
      const run = (): void => {
        if (gen !== this.presentGen || !this.running) return;
        this.playTileFlight(start, fig, to, { duration, fromScale: 0.45, fromAlpha: 0 });
      };
      if (delay === 0) run();
      else window.setTimeout(run, delay);
    });
    await new Promise<void>((r) => window.setTimeout(r, maxEnd + 360));
  }

  // Удалённый ход приходит целиком одним состоянием. До первого кадра
  // скрываем целевые копии и оставляем призраки на реальных исходных местах.
  // Перестановки стартуют вместе, а новые фишки летят по очереди.
  private async playQueuedRemoteMove(
    before: Map<number, TileSnapshot>,
    freshIds: number[],
    seat: number,
    rowId: number,
    scrollTop: number,
    gen: number,
    slowNew = true,
  ): Promise<void> {
    const slots = this.tileSlotKeys();
    const fresh = new Set(freshIds);
    const reorderedRows = this.reorderedRowIds(before);
    const sourceChip = this.chipsRow.children[seat];
    if (sourceChip) this.ensureSeatChipVisible(sourceChip);
    const moves: Array<{
      source: TileSnapshot | null;
      target: TileFigure;
      isNew: boolean;
      ghost: TileFigure | null;
      rowId: number;
    }> = [];
    for (const row of this.rowFigs) {
      if (row.hintZone) continue;
      for (const target of row.figures) {
        const id = target.face.id;
        const previous = before.get(id);
        let source: TileSnapshot | null = null;
        const isNew = fresh.has(id);
        if (!isNew && previous && (
          previous.slot !== slots.get(id)
          || (previous.rowId !== undefined && reorderedRows.has(previous.rowId))
        )) {
          source = {
            ...previous,
            rect: { ...previous.rect },
          };
        }
        if (!source && !isNew) continue;
        // Важно скрыть конечные фигуры до первого кадра нового layout:
        // иначе ряд успевает целиком «телепортироваться» на новые места.
        target.hideBadgeForFlight();
        target.root.alpha = 0;
        const ghost = source ? this.createFlightGhost(source, target) : null;
        moves.push({ source, target, isNew, ghost, rowId: row.rowId });
      }
    }
    if (moves.length === 0) {
      // Защитный фолбэк для первого обновления без исходных координат.
      await this.playQueuedSteps(freshIds, gen, seat);
      return;
    }

    // showSeat/rebuildChips пересоздаёт чипы. Даём Babylon пару кадров на
    // замер и только затем берём настоящую позицию источника новой фишки.
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
    if (gen !== this.presentGen || !this.running) {
      for (const move of moves) {
        move.ghost?.disposeBadge();
        if (move.ghost?.root.parent) move.ghost.root.parent.removeControl(move.ghost.root);
        move.target.root.alpha = move.target.rgbaAlpha;
        move.target.revealBadge();
      }
      return;
    }
    if (sourceChip) {
      this.ensureSeatChipVisible(sourceChip);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }
    const spawn = this.chipSpawnRect(seat, tileSize());

    // Старые фишки остаются видны призраками на своих прежних местах, пока
    // стол плавно прокручивается к цели. Следим за scroll offset, чтобы эти
    // источники двигались вместе со старым содержимым ScrollViewer.
    let trackingScroll = true;
    let scrollTrackRaf = 0;
    const trackSources = (): void => {
      scrollTrackRaf = 0;
      if (!trackingScroll) return;
      const delta = this.tableScrollOffsetPx() - scrollTop;
      for (const move of moves) {
        if (!move.isNew && move.ghost && move.source) {
          move.ghost.root.top = px(Math.round(move.source.rect.y - delta));
        }
      }
      scrollTrackRaf = window.requestAnimationFrame(trackSources);
    };
    scrollTrackRaf = window.requestAnimationFrame(trackSources);
    await this.queueBotTableScroll(rowId, gen);
    trackingScroll = false;
    if (scrollTrackRaf) window.cancelAnimationFrame(scrollTrackRaf);
    const scrollDelta = this.tableScrollOffsetPx() - scrollTop;
    for (const move of moves) {
      if (!move.isNew && move.source) move.source.rect.y -= scrollDelta;
    }
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));

    const fly = (move: typeof moves[number], duration: number): Promise<void> => {
      // Создаём призрак новой фишки только в момент её полёта: следующие
      // фишки не должны копиться видимыми возле имени игрока.
      if (move.isNew && !move.source) {
        move.source = {
          face: move.target.face,
          faceDown: false,
          rect: { x: spawn.x, y: spawn.y, w: tileSize().x, h: tileSize().y },
        };
        move.ghost = this.createFlightGhost(move.source, move.target);
      }
      const to = rectOf(move.target.root);
      if (to.w <= 0 || to.h <= 0 || !move.source || !move.ghost) {
        move.ghost?.disposeBadge();
        if (move.ghost?.root.parent) move.ghost.root.parent.removeControl(move.ghost.root);
        move.target.root.alpha = move.target.rgbaAlpha;
        move.target.revealBadge();
        return Promise.resolve();
      }
      if (Math.hypot(to.x - move.source.rect.x, to.y - move.source.rect.y) < 3) {
        move.ghost.disposeBadge();
        if (move.ghost.root.parent) move.ghost.root.parent.removeControl(move.ghost.root);
        move.target.root.alpha = move.target.rgbaAlpha;
        move.target.revealBadge();
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        this.playTileFlight(move.source!, move.target, to, {
          duration,
          fromScale: move.isNew ? 0.62 : 0.94,
          fromAlpha: move.isNew ? 0.35 : move.target.rgbaAlpha,
        }, move.ghost!, resolve);
      });
    };

    if (gen !== this.presentGen || !this.running) {
      for (const move of moves) {
        move.ghost?.disposeBadge();
        if (move.ghost?.root.parent) move.ghost.root.parent.removeControl(move.ghost.root);
        move.target.root.alpha = move.target.rgbaAlpha;
        move.target.revealBadge();
      }
      return;
    }

    // Обрабатываем затронутые ряды по очереди. Внутри одного ряда уже
    // лежащие фишки сдвигаются одновременно, а новая летит медленно поверх
    // этой перестройки. Так нет ни столкновения, ни одновременного движения
    // нескольких рядов; будущие новые фишки пока остаются скрытыми.
    const byRow = new Map<number, typeof moves>();
    for (const move of moves) {
      const group = byRow.get(move.rowId) ?? [];
      group.push(move);
      byRow.set(move.rowId, group);
    }
    const rowOrder = this.rowFigs.filter((row) => !row.hintZone).map((row) => row.rowId);
    // Порядок рядов зависит от общего направления перелётов: если фишки
    // смещаются вниз (или в основном по горизонтали), нижние ряды играем
    // первыми, освобождая траектории; при движении вверх — сверху вниз.
    let verticalTravel = 0;
    for (const move of moves) {
      if (!move.source) continue;
      const to = rectOf(move.target.root);
      if (to.w > 0 && to.h > 0) verticalTravel += to.y - move.source.rect.y;
    }
    const animationRowOrder = verticalTravel >= 0 ? rowOrder.slice().reverse() : rowOrder;
    const newDuration = slowNew ? 520 : 340;
    for (const rowId of animationRowOrder) {
      const group = byRow.get(rowId);
      if (!group) continue;
      if (gen !== this.presentGen || !this.running) {
        for (const move of moves) {
          move.ghost?.disposeBadge();
          if (move.ghost?.root.parent) move.ghost.root.parent.removeControl(move.ghost.root);
          move.target.root.alpha = move.target.rgbaAlpha;
          move.target.revealBadge();
        }
        return;
      }
      const existing = group.filter((move) => !move.isNew);
      const placements = group.filter((move) => move.isNew);
      const rearrangeTogether = Promise.all(existing.map((move) => fly(move, 280)));
      const placeInOrder = async (): Promise<void> => {
        for (const move of placements) await fly(move, newDuration);
      };
      await Promise.all([rearrangeTogether, placeInOrder()]);
    }
  }

  private chipSpawnRect(seat: number, ts: { x: number; y: number }): { x: number; y: number } {
    const chip = seat >= 0 ? this.chipsRow.children[seat] ?? null : null;
    const r = chip ? rectOf(chip) : { x: 0, y: 0, w: 0, h: 0 };
    if (r.w > 1 && r.h > 1) return { x: r.x + r.w / 2 - ts.x / 2, y: r.y + r.h / 2 - ts.y / 2 };
    return { x: viewWidth() - 40, y: -60 };
  }

  private ensureSeatChipVisible(chip: Control): void {
    const row = rectOf(this.chipsScroll);
    const item = rectOf(chip);
    if (row.w <= 0 || item.w <= 0) return;
    const margin = 8;
    if (item.x < row.x + margin) {
      scrollViewerByPixels(this.chipsScroll, 'horizontal', item.x - row.x - margin);
    } else if (item.x + item.w > row.x + row.w - margin) {
      scrollViewerByPixels(this.chipsScroll, 'horizontal', item.x + item.w - (row.x + row.w - margin));
    }
  }

  // Сколько пикселей не хватает, чтобы чип места был виден целиком (0 — уже виден).
  private chipsSeatDelta(seat: number): number {
    const chip = seat >= 0 ? this.chipsRow.children[seat] ?? null : null;
    if (!chip) return 0;
    const row = rectOf(this.chipsScroll);
    const item = rectOf(chip);
    if (row.w <= 0 || item.w <= 0) return 0;
    const margin = 10;
    if (item.x < row.x + margin) return item.x - row.x - margin;
    if (item.x + item.w > row.x + row.w - margin) return item.x + item.w - (row.x + row.w - margin);
    return 0;
  }

  // Плавно прокрутить ряд чипов к месту, чей сейчас ход. Вызывается при
  // смене ходящего, чтобы активное имя всегда было видно без рывка.
  //
  // Позиции считаем ВНУТРИ кадра: сразу после rebuildChips меры детей ещё
  // не пересчитаны, и синхронный расчёт давал нулевую цель — прокрутка не
  // запускалась. Поэтому ждём пару кадров, пока появятся размеры.
  private scrollChipsToSeat(seat: number): void {
    if (seat < 0) return;
    if (this.chipsScrollRaf) window.cancelAnimationFrame(this.chipsScrollRaf);
    this.chipsScrollRaf = 0;
    const token = ++this.chipsScrollToken;
    let last = performance.now();
    let layoutTries = 0;
    const tick = (now: number): void => {
      this.chipsScrollRaf = 0;
      if (token !== this.chipsScrollToken || !this.running) return;
      const chip = this.chipsRow.children[seat] ?? null;
      const row = rectOf(this.chipsScroll);
      const item = chip ? rectOf(chip) : { x: 0, y: 0, w: 0, h: 0 };
      if (row.w <= 0 || item.w <= 0) {
        if (layoutTries++ < 6) {
          last = now;
          this.chipsScrollRaf = window.requestAnimationFrame(tick);
        }
        return;
      }
      const delta = this.chipsSeatDelta(seat);
      if (Math.abs(delta) < 1) return;
      const elapsed = Math.max(8, Math.min(40, now - last));
      last = now;
      const step = Math.sign(delta) * Math.min(Math.abs(delta), 900 * elapsed / 1000);
      if (Math.abs(scrollViewerByPixels(this.chipsScroll, 'horizontal', step)) < 0.1) return;
      this.chipsScrollRaf = window.requestAnimationFrame(tick);
    };
    this.chipsScrollRaf = window.requestAnimationFrame(tick);
  }

  private cancelChipsScroll(): void {
    this.chipsScrollToken += 1;
    if (this.chipsScrollRaf) window.cancelAnimationFrame(this.chipsScrollRaf);
    this.chipsScrollRaf = 0;
  }

  // Ряд, в котором лежит фишка (по id) — чтобы прокрутить стол к ходу бота.
  private rowIdOfTile(tileId: number): number {
    if (!this.state || tileId <= 0) return -1;
    for (const row of this.state.table) {
      if (row.tiles.some((t) => t.id === tileId)) return row.id;
    }
    return -1;
  }

  // Находим изменившийся ряд и тогда, когда серверный ход переместил только
  // уже лежащие фишки (в таком случае freshIds может быть пустым).
  private changedTableRowId(prev: GameState, next: GameView['table']): number {
    const oldRows = new Map(prev.table.map((row) => [row.id, row.tiles.map((tile) => tile.id)]));
    let changed = -1;
    for (const row of next) {
      const old = oldRows.get(row.id);
      if (!old || old.length !== row.tileIds.length || old.some((id, i) => id !== row.tileIds[i])) {
        changed = row.id;
      }
    }
    if (changed >= 0) return changed;
    const oldOrder = prev.table.map((row) => row.id);
    const nextOrder = next.map((row) => row.id);
    if (oldOrder.length === nextOrder.length && oldOrder.every((id, i) => id === nextOrder[i])) return -1;
    for (let i = 0; i < Math.min(oldOrder.length, nextOrder.length); i += 1) {
      if (oldOrder[i] !== nextOrder[i]) return nextOrder[i] ?? nextOrder[nextOrder.length - 1] ?? -1;
    }
    return nextOrder[nextOrder.length - 1] ?? -1;
  }

  // Входящий DRAFT: стол другого игрока подменяется его раскладкой.
  // Guard «чей ход», дедуп и устаревание 15 с — как в оригинале
  // (game.gd:2844-2910, 3887-3899).
  applyDraft(msg: DraftMsg): void {
    if (!this.onlineMode || !this.state || this.state.finished) return;
    if (msg.from === this.state.local_seat) return;
    if (msg.from !== this.state.current) return;
    this.draftFrom = msg.from;
    // Срок жизни черновика обновляем ВСЕГДА, даже если стол тот же:
    // автор повторяет висящий черновик каждые 3 с, и этот повтор и есть
    // «я ещё здесь» (game.gd:2851). Иначе повторный пакет дедуплицировался
    // и черновик протухал через 15 с прямо посреди хода соперника.
    if (this.draftExpireTimer) window.clearTimeout(this.draftExpireTimer);
    this.draftExpireTimer = window.setTimeout(() => {
      this.draftExpireTimer = 0;
      // автор замолчал: вернуть последний подтверждённый стол
      if (!this.state || this.state.finished || this.state.myTurn()) return;
      this.applyServerRows(this.lastConfirmedTable);
      this.clearDraftPresentation();
      this.refresh();
    }, 15000);
    const payload = JSON.stringify(msg.rows);
    if (payload === this.lastDraftPayload) return;
    this.lastDraftPayload = payload;
    const beforeVisuals = this.captureTileSnapshots();
    const beforeScrollTop = this.tableScrollOffsetPx();
    const previousRows = this.state.table.map((row, index) => ({
      id: row.id,
      index,
      tiles: row.tiles.map((tile) => tile.id),
    }));
    const previousDraftIds = this.draftNewIds;
    const nextDraftIds = new Set<number>();
    // фишки, которых нет в подтверждённом столе, — «черновые»
    const confirmed = new Set<number>();
    for (const r of this.lastConfirmedTable) for (const id of r.tiles) confirmed.add(id);
    for (const r of msg.rows) for (const id of r.tiles) if (!confirmed.has(id)) nextDraftIds.add(id);
    const animatedIds = [...nextDraftIds].filter((id) => !previousDraftIds.has(id));
    this.draftNewIds = nextDraftIds;
    const oldRows = new Map(previousRows.map((row) => [row.id, row]));
    const changedRows = msg.rows.filter((row, index) => {
      const previous = oldRows.get(row.id);
      return !previous || previous.index !== index
        || previous.tiles.length !== row.tiles.length
        || previous.tiles.some((id, i) => id !== row.tiles[i]);
    });
    const changedContentRows = msg.rows.filter((row) => {
      const previous = oldRows.get(row.id);
      return !previous || previous.tiles.length !== row.tiles.length
        || previous.tiles.some((id, i) => id !== row.tiles[i]);
    });
    const targetRowId = msg.rows.find((row) => animatedIds.some((id) => row.tiles.includes(id)))?.id
      ?? changedContentRows[changedContentRows.length - 1]?.id
      ?? changedRows[0]?.id ?? -1;
    this.applyServerRows(msg.rows);
    this.refresh();
    const segment = {
      kind: 'draft',
      seat: msg.from,
      ids: animatedIds,
      rowId: targetRowId,
      before: beforeVisuals,
      scrollTop: beforeScrollTop,
    } as const;
    if (animatedIds.length > 0 || changedRows.length > 0) {
      if (this.flightActive) this.enqueueDraftSegment(segment);
      else void this.playDraftPreview(segment);
    }
  }

  private enqueueDraftSegment(segment: {
    seat: number; ids: number[]; rowId: number;
    before: Map<number, TileSnapshot>; scrollTop: number;
  }): void {
    const last = this.presentQueue[this.presentQueue.length - 1];
    if (last?.kind === 'draft' && last.seat === segment.seat) {
      last.ids = [...new Set([...last.ids, ...segment.ids])];
      last.rowId = segment.rowId;
    } else {
      this.presentQueue.push({ kind: 'draft', ...segment });
    }
    void this.pumpPresent();
  }

  // GAME_ERROR: причина в тосте; красная подсветка рядов по errors[row].
  // hard — локально ничего не откатываем: сервер уже откатился и шлёт
  // свежий game.state следом (game.gd:1861-1877, hub.js GAME_COMMIT).
  onGameError(msg: GameErrorMsg): void {
    this.serverErrorRows = new Map<number, string>();
    for (const e of msg.errors ?? []) {
      this.serverErrorRows.set(Number(e.row ?? -1), String(e.reason ?? ''));
    }
    this.toast(msg.reason || t('Ход отклонён'));
    this.refresh();
  }

  // Обрыв сокета в разгар партии: тост + цикл «вернуться в партию»
  // (game.gd:1580-1594, 1887-1899): ждём переподключение session, затем
  // game.rejoin.
  onSessionClosed(): void {
    if (!this.onlineMode || !this.running || this.state?.finished) return;
    this.toast(t('Соединение потеряно'));
    this.startRejoinLoop();
  }

  // Цикл возврата в партию после обрыва.
  private rejoinTimer: ReturnType<typeof setInterval> | null = null;
  private rejoinDeadline = 0;
  private startRejoinLoop(): void {
    if (this.rejoinTimer) return;
    this.rejoinDeadline = Date.now() + 120000;
    this.rejoinTimer = setInterval(() => void this.rejoinTick(), 2500);
  }

  private stopRejoinLoop(): void {
    if (this.rejoinTimer) {
      clearInterval(this.rejoinTimer);
      this.rejoinTimer = null;
    }
  }

  private async rejoinTick(): Promise<void> {
    if (!this.running || !this.onlineMode || (this.state && this.state.finished)) {
      this.stopRejoinLoop();
      return;
    }
    if (Date.now() > this.rejoinDeadline) {
      this.stopRejoinLoop();
      this.toast(t('Не удалось вернуться в партию'));
      return;
    }
    const api = this.host.gameApi();
    if (!api.isOpen || !api.user) return; // ждём session-переподключение
    try {
      const env = await api.rejoin();
      this.stopRejoinLoop();
      this.applyOnlineView(env);
      this.toast(t('Вернулись в партию'));
    } catch {
      /* партия ещё не готова — попробуем в следующий тик */
    }
  }

  private applyServerRows(rows: { id: number; tiles: number[] }[]): void {
    const st = this.state!;
    st.table = rows
      .filter((r) => r.tiles.length > 0)
      .map((r) => {
        const row = new GsRow(r.id);
        row.tiles = r.tiles.map((id) => tileById(id));
        return row;
      });
    let maxId = 0;
    for (const r of st.table) maxId = Math.max(maxId, r.id);
    st.reserveRowIds(maxId);
  }

  private setTurnTimer(seconds: number | null, mine: boolean, currentSeat: number): void {
    if (this.onlineTimer) {
      clearInterval(this.onlineTimer);
      this.onlineTimer = null;
    }
    if (!this.timerLab) return;
    const env = this.lastWaitEnv;
    // Отсчёт живёт только в идущей сетевой партии: пауза, ожидание
    // игроков, grace и финал строку гасят (game.gd:1994-2014). Таймер
    // приходит не в каждом состоянии — без числа его тоже не рисуем,
    // иначе на экране «Ваш ход — NaN с».
    if (!this.onlineMode || !this.state || this.state.finished
      || (env && (env.paused || env.waiting || (env.grace ?? 0) > 0))
      || seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
      this.timerText = '';
      this.timerSample = '';
      this.timerName = '';
      this.timerMine = false;
      const changed = this.syncTopBar();
      if (changed && this.state && this.running && this.rowsScroll) this.refresh();
      return;
    }
    // «Ваш ход — N с» / «Ход: X — N с» (game.gd:1994-2014)
    this.timerName = this.state.playerName(currentSeat);
    this.timerMine = mine;
    this.timerSample = this.formatTimerText(888);
    const topLayoutChanged = this.syncTopBar();
    let left = Math.max(0, seconds);
    const render = (): void => {
      const sec = Math.max(1, left); // «0 с» не показываем
      this.timerSecond = sec;
      this.timerText = this.formatTimerText(sec);
      const changed = this.resizeTimerLayout();
      const color = left <= 10 ? SKIN.flag : SKIN.gold;
      this.timerLab.color = color;
      this.timerOverflowLab.color = color;
      if (changed && this.state && this.running && this.rowsScroll) this.refresh();
    };
    render();
    if (topLayoutChanged && this.state && this.running && this.rowsScroll) this.refresh();
    this.onlineTimer = setInterval(() => {
      left -= 1;
      if (left <= 0 && this.onlineTimer) {
        clearInterval(this.onlineTimer);
        this.onlineTimer = null;
      }
      render();
    }, 1000);
  }

  private formatTimerText(seconds: number, name = this.timerName): string {
    return this.timerMine
      ? t('Ваш ход — %d с', seconds)
      : t('Ход: %s — %d с', name, seconds);
  }

  private resizeTimerLayout(): boolean {
    if (!this.timerLab || !this.topRow || !this.timerOverflowRow || !this.timerOverflowLab) return false;
    const font = fs(14);
    this.timerLab.fontSize = font;
    this.timerLab.textWrapping = false;
    const overflow = !!this.timerText && this.timerOverflowByFit;
    const fullWidth = Math.max(120, viewWidth() - 24);
    let overflowFont = font;
    let overflowName = this.timerName;
    if (overflow) {
      while (overflowFont > 11
        && measureTextWidth(this.formatTimerText(888, overflowName), overflowFont) > fullWidth - 12) {
        overflowFont -= 1;
      }
      while (overflowName.length > 1
        && measureTextWidth(this.formatTimerText(888, overflowName), overflowFont) > fullWidth - 12) {
        overflowName = overflowName.slice(0, -1);
      }
      if (overflowName !== this.timerName) overflowName = `${overflowName}…`;
    }
    const overflowHeight = overflow ? Math.ceil(overflowFont * 1.7) + 6 : 0;
    const changed = overflow !== this.timerInOverflow || overflowHeight !== this.timerOverflowHeight;
    this.timerInOverflow = overflow;
    this.timerOverflowHeight = overflowHeight;
    this.timerLab.text = overflow ? '' : this.timerText;
    this.timerLab.isVisible = !overflow;
    this.timerLab.height = px(46);
    this.topRow.height = px(46);
    this.timerOverflowRow.isVisible = overflow;
    this.timerOverflowRow.height = px(overflowHeight);
    this.timerOverflowLab.text = overflow ? this.formatTimerText(this.timerSecond, overflowName) : '';
    this.timerOverflowLab.fontSize = overflowFont;
    this.timerOverflowLab.width = px(fullWidth);
    this.timerOverflowLab.height = px(overflowHeight);
    this.timerOverflowLab.textWrapping = false;
    this.deckBtn.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    const actions = this.topRow.children.find((c) => c.name === 'topActions') as StackPanel | undefined;
    if (actions) {
      actions.height = px(46);
      actions.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    }
    return changed;
  }

  // Панель ожидания: пауза/ожидание соперника/восстановление связи.
  // grace > 0 — соперник отвалился, идёт отсчёт (game.gd:1716-1735).
  private applyWaitState(env: GameEnvelope): void {
    this.lastWaitEnv = env;
    const grace = env.grace ?? 0;
    if (grace > 0 && !env.state.finished) {
      this.startGraceCountdown(grace);
      this.updateActionRow();
      return;
    }
    this.stopGraceCountdown();
    if (env.paused || env.waiting) this.showWaitPanel(t('Ожидание игроков…'));
    else this.hideWaitPanel();
    // пауза блокирует действия — пересчитать кнопки сразу, не дожидаясь
    // следующей пересборки
    this.updateActionRow();
  }

  private startGraceCountdown(graceSec: number): void {
    if (this.graceTick) {
      clearInterval(this.graceTick);
      this.graceTick = null;
    }
    let left = Math.max(0, Math.round(graceSec));
    const render = (): void => {
      this.showWaitPanel(t('Соперник не отвечает. Осталось ждать %d с', Math.max(0, left)));
    };
    render();
    this.graceTick = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        this.stopGraceCountdown();
        this.hideWaitPanel();
        return;
      }
      render();
    }, 1000);
  }

  private stopGraceCountdown(): void {
    if (this.graceTick) {
      clearInterval(this.graceTick);
      this.graceTick = null;
    }
  }
    // Панель ожидания НЕ модальная: это пояснение «почему нельзя ходить»,
  // а не блокировка интерфейса — меню/выход должны оставаться доступны.
  private showWaitPanel(text: string): void {
    const width = Math.min(viewWidth() - 24, 460);
    const font = fs(15);
    const contentW = Math.max(120, width - 24);
    const wrapped = wrapTextToWidth(text, contentW, font);
    const height = Math.max(44, estimateWrappedTextHeight(wrapped, contentW, font) + 8);
    if (this.waitHost && this.waitLab) {
      this.waitLab.text = wrapped;
      this.waitLab.height = px(height - 8);
      this.waitHost.height = px(height);
      return;
    }
    const host = new Container('wait');
    host.width = px(width);
    host.height = px(height);
    host.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    host.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    host.top = px(112);
    host.zIndex = 630;
    host.isPointerBlocker = false;
    host.isHitTestVisible = false;
    const fill = softPanel({ bg: '#1565C0E6', border: '#90CAF9', thickness: 1, corner: 10 });
    fill.root.width = '100%';
    fill.root.height = '100%';
    fill.root.isHitTestVisible = false;
    host.addControl(fill.root);
    const lab = mkLabel(wrapped, {
      fontSize: font, color: '#FFFFFF', width: contentW, height: height - 8, noWrap: false,
    });
    lab.isHitTestVisible = false;
    host.addControl(lab);
    this.boardRoot.addControl(host);
    this.waitHost = host;
    this.waitLab = lab;
  }

  private hideWaitPanel(): void {
    if (this.waitHost) {
      if (this.waitHost.parent) this.waitHost.parent.removeControl(this.waitHost);
      this.waitHost = null;
      this.waitLab = null;
    }
  }

  // Повтор своего черновика каждые 3 с, пока ход не завершён
  // (game.gd:2916-2949): переподключившийся соперник не останется с
  // пустым столом.
  // Повтор своего черновика каждые 3 с, пока ход не завершён
  // (game.gd:2929-2949): у соперника черновик протухает через 15 с, если
  // автор замолчал, поэтому неизменённый стол тоже нужно повторять —
  // иначе чужие фишки «пропадают» посреди хода.
  private startDraftResend(): void {
    if (this.draftResendTimer) return;
    this.draftResendTimer = window.setInterval(() => {
      if (!this.onlineMode || !this.state || !this.state.myTurn() || this.state.finished
        || this.state.turn_placed.length === 0) {
        this.stopDraftResend();
        return;
      }
      const rows = this.state.localTableRows();
      this.lastDraftPayload = JSON.stringify(rows);
      this.host.gameApi().sendDraft(rows);
    }, 3000);
  }

  private sendMyDraft(): void {
    if (!this.state) return;
    const rows = this.state.localTableRows();
    this.lastDraftPayload = JSON.stringify(rows);
    this.host.gameApi().sendDraft(rows);
    this.startDraftResend();
  }

  private stopDraftResend(): void {
    if (this.draftResendTimer) {
      clearInterval(this.draftResendTimer);
      this.draftResendTimer = 0;
    }
  }

  private clearServerErrorRows(): void {
    this.serverErrorRows = new Map<number, string>();
  }

  // Останов таймеров при уходе с экрана (без утечек interval).
  stopTimers(): void {
    this.cancelActiveDrag();
    this.cancelTableScroll();
    this.cancelBotTableScroll();
    this.cancelChipsScroll();
    this.stopRejoinLoop();
    this.stopDraftResend();
    this.stopGraceCountdown();
    if (this.flashTimer) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = 0;
    }
    // показа прерываем: смена экрана/уход не должны доигрывать очередь
    this.presentGen += 1;
    this.presentQueue = [];
    this.presentBusy = false;
    this.flightActive = false;
    this.refreshPending = false;
    this.titlePendingSeat = -1;
    this.pendingSteps = [];
    this.shownSeat = -1;
    this.clearDraftPresentation();
    this.hideWaitPanel();
    if (this.onlineTimer) {
      clearInterval(this.onlineTimer);
      this.onlineTimer = null;
    }
    if (this.hintTimer) {
      window.clearTimeout(this.hintTimer);
      this.hintTimer = 0;
    }
    this.hintTileIds.clear();
  }

  // Сетевые ходы: ответ — новый GAME_STATE. Пока запрос в полёте,
  // взаимодействие заблокировано (game.gd _sending).
  private async doDrawOnline(): Promise<void> {
    this.sending = true;
    try {
      this.applyOnlineView(await this.host.gameApi().draw());
    } catch (e) {
      this.sending = false;
      this.toast((e as Error).message);
    }
  }

  private async doSkipOnline(): Promise<void> {
    this.sending = true;
    try {
      this.applyOnlineView(await this.host.gameApi().skip());
    } catch (e) {
      this.sending = false;
      this.toast((e as Error).message);
    }
  }

  private async doCommitOnline(): Promise<void> {
    this.sending = true;
    try {
      const rows = this.state ? this.state.setTableRows() : [];
      this.applyOnlineView(await this.host.gameApi().commitSetTable(rows));
    } catch (e) {
      this.sending = false;
      this.toast((e as Error).message);
    }
  }

  private currentPlayerIsBot(): boolean {
    if (!this.state) return false;
    return this.state.players[this.state.current].is_bot;
  }

  // Пас-оверлей, если ход человека в hot-seat; иначе — ход бота.
  // first: партия только началась — «Игра начинается - первый ход:».
  // В onlineMode порядок ходов ведёт сервер: ни пасов, ни локальных ботов.
  private checkPassOrBot(first = false): void {
    this.clearPass();
    this.refresh();
    if (!this.state || this.state.finished) {
      if (this.state && this.state.finished) this.showWin();
      return;
    }
    if (this.onlineMode) return;
    const s = loadSettings();
    if (s.player_count > 1 && !this.currentPlayerIsBot()) {
      this.showPass(first
        ? t('Игра начинается - первый ход:')
        : t('Передайте устройство игроку'), this.state.playerName(this.state.current), () => {
        this.clearPass();
        this.refresh();
      });
      return;
    }
    if (this.currentPlayerIsBot()) this.runBotTurn();
  }

  private showPass(title: string, name: string, onReady: () => void): void {
    const { overlay, close } = modalOverlay(this.popups, 'pass', { alpha: 0.88, zIndex: 800 });
    const passW = Math.max(160, Math.floor(viewWidth() * 0.86));
    const passScrollH = Math.max(120, viewHeight() - 24);
    const scroll = new ScrollViewer('passScroll');
    scroll.thickness = 0;
    scroll.barSize = 4;
    scroll.width = px(passW);
    scroll.height = px(passScrollH);
    scroll.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    scroll.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    const col = new StackPanel('passCol');
    col.isVertical = true;
    col.spacing = 16;
    col.width = px(passW);
    col.height = px(1);
    col.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    const passTitleH = estimateWrappedTextHeight(title, passW, fs(18));
    const wrappedName = wrapTextToWidth(name, passW, fs(30));
    const passNameH = estimateWrappedTextHeight(wrappedName, passW, fs(30));
    const passButtonH = 56;
    let passContentH = passTitleH + passNameH + 24 + passButtonH + 16 * 3;
    col.height = px(passContentH);
    let insideScroll = passContentH > passScrollH;
    // Высота по реальному переносу строк: на телефоне с крупным текстом
    // заголовок/имя занимают несколько строк, и фиксированная высота
    // резала их сверху и снизу.
    const titleLab = mkLabel(title, {
      fontSize: fs(18),
      color: '#ffffffCC',
      width: passW,
      height: passTitleH,
    });
    col.addControl(titleLab);
    const nameLab = mkLabel(wrappedName, {
      fontSize: fs(30),
      color: SKIN.gold,
      width: passW,
      height: passNameH,
    });
    col.addControl(nameLab);
    // Точная высота после реального переноса глифов (оценка выше нужна
    // только для первого кадра до layout-прохода).
    window.requestAnimationFrame(() => {
      const th = Math.ceil(titleLab.computeExpectedHeight());
      if (th > 0) titleLab.height = px(Math.max(titleLab.heightInPixels, th));
      const nh = Math.ceil(nameLab.computeExpectedHeight());
      if (nh > 0) nameLab.height = px(Math.max(nameLab.heightInPixels, nh));
      const actualContentH = titleLab.heightInPixels + nameLab.heightInPixels + 24 + passButtonH + 16 * 3;
      passContentH = actualContentH;
      col.height = px(passContentH);
      if (passContentH > passScrollH && !insideScroll) {
        overlay.removeControl(col);
        overlay.addControl(scroll);
        scroll.addControl(col);
        enableSmoothScroll(scroll);
        insideScroll = true;
      }
    });
    col.addControl(gapControl(24));
    const go = mkButton(t('Готов(-а)'), { height: 56, width: 220, fontSize: fs(20), theme: BUTTON_STYLE.green });
    go.onPointerUpObservable.clear();
    go.onPointerUpObservable.add(() => {
      close();
      onReady();
    });
    col.addControl(go);
    if (insideScroll) {
      overlay.addControl(scroll);
      scroll.addControl(col);
      enableSmoothScroll(scroll);
      col.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    } else {
      // Короткая плашка — прямой ребёнок полноэкранного слоя. Так Babylon
      // центрирует весь блок, а не только окно ScrollViewer около верхнего края.
      col.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
      overlay.addControl(col);
    }
  }

  private clearOverlays(): void {
    // Удаляем все модальные слои (пас/победа/меню) — после хода.
    while (this.popups.children.length > 0) this.popups.removeControl(this.popups.children[0]);
  }

  private clearPass(): void {
    // При смене хода убираем только пас-оверлеи. Активное меню бургера
    // (если оно открыто) должно остаться на экране.
    for (const c of [...this.popups.children]) {
      if (c.name === 'pass') this.popups.removeControl(c);
    }
  }

  private clearTransientOverlays(): void {
    const doomed = this.popups.children.filter((c) => c.name === 'pass' || c.name === 'burger');
    for (const d of doomed) this.popups.removeControl(d);
  }

  showWin(): void {
    this.clearOverlays();
    this.reportPlatformWins();
    platform.gameplayStop();
    this.running = false;
    this.stopTimers();
    const { overlay } = modalOverlay(this.popups, 'win', { alpha: 0.9, zIndex: 850 });
    const winW = Math.max(160, Math.floor(viewWidth() * 0.86));
    const winScrollH = Math.max(120, viewHeight() - 24);
    const col = new StackPanel('wincol');
    col.isVertical = true;
    const winSpacing = Math.max(8, Math.min(20, Math.floor(viewHeight() / 28)));
    col.spacing = winSpacing;
    col.width = px(winW);
    col.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    const winnerName = this.state && this.state.winner >= 0 ? this.state.playerName(this.state.winner) : '—';
    const winnerText = wrapTextToWidth(t('Победил %s', winnerName), winW - 12, fs(28));
    const winnerH = estimateWrappedTextHeight(winnerText, winW - 12, fs(28));
    col.addControl(mkLabel(winnerText, {
      fontSize: fs(28),
      color: SKIN.gold,
      width: '100%',
      height: winnerH,
    }));
    col.addControl(gapControl(10));
    // «Посмотреть стол»: закрыть оверлей и оставить финальный расклад
    // с плавающей кнопкой «Результат» (game.gd:2226-2237, 2268-2292)
    const actionW = Math.max(120, Math.min(220, winW - 20));
    const peek = mkButton(t('Посмотреть стол'), { height: 44, width: actionW, fontSize: fs(15), theme: BUTTON_STYLE.deck });
    peek.onPointerUpObservable.clear();
    peek.onPointerUpObservable.add(() => {
      this.clearOverlays();
      this.showResultChip();
    });
    col.addControl(peek);
    if (this.onlineMode) {
      // сетевая партия: покинуть комнату (место освобождается) и в лобби
      const back = mkButton(t('В меню'), { height: 54, width: actionW, fontSize: fs(18), theme: BUTTON_STYLE.green });
      back.onPointerUpObservable.clear();
      back.onPointerUpObservable.add(() => this.leaveToMenu());
      col.addControl(back);
    } else {
      const again = mkButton(t('Заново'), { height: 54, width: actionW, fontSize: fs(18), theme: BUTTON_STYLE.green });
      again.onPointerUpObservable.clear();
      // Новая партия — логическая пауза: сначала interstitial площадки,
      // затем запуск (действие выполняется всегда, даже без рекламы).
      again.onPointerUpObservable.add(() => withInterstitial(() => this.host.replay()));
      col.addControl(again);
      const back = mkButton(t('В меню'), { height: 46, width: actionW, fontSize: fs(16), theme: BUTTON_STYLE.blueOnline });
      back.onPointerUpObservable.clear();
      back.onPointerUpObservable.add(() => withInterstitial(() => this.host.toMenu()));
      col.addControl(back);
    }
    const actionHeight = this.onlineMode ? 54 : 54 + 46;
    const childCount = this.onlineMode ? 4 : 5;
    const winContentH = winnerH + 10 + 44 + actionHeight + winSpacing * (childCount - 1);
    col.height = px(winContentH);
    if (winContentH <= winScrollH) {
      col.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
      overlay.addControl(col);
    } else {
      const scroll = new ScrollViewer('winScroll');
      scroll.thickness = 0;
      scroll.barSize = 4;
      scroll.width = px(winW);
      scroll.height = px(winScrollH);
      scroll.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
      scroll.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
      overlay.addControl(scroll);
      scroll.addControl(col);
      enableSmoothScroll(scroll);
      col.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    }
  }

  // Сервер остаётся источником истины: площадочный SDK (Яндекс или GamePush)
  // получает только значение wins из board.list после подтверждённой сетевой
  // победы. Локальные результаты и переданные клиентом очки не отправляем.
  private reportPlatformWins(): void {
    const platformId = platform.id;
    const supportsWins = platformId === 'yandex' || platformId === 'gamepush';
    if (this.platformScoreReported || !this.onlineMode || !supportsWins
      || !this.state || this.state.winner !== this.state.local_seat) return;
    this.platformScoreReported = true;
    void this.host.gameApi().boardList().then((board) => {
      if (board.me && Number.isFinite(board.me.wins)) {
        return platform.reportLeaderboardScore('wins', Math.max(0, board.me.wins));
      }
      return false;
    }).catch(() => false);
  }

  // Плавающая кнопка «Результат» после «Посмотреть стол».
  private showResultChip(): void {
    const chip = mkButton(t('Результат'), { height: 44, width: 150, fontSize: fs(15), theme: BUTTON_STYLE.blueOnline });
    chip.name = 'resultChip';
    chip.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    chip.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
    chip.left = px(-12);
    chip.top = px(-12);
    chip.zIndex = 840;
    chip.onPointerUpObservable.clear();
    chip.onPointerUpObservable.add(() => this.showWin());
    this.popups.addControl(chip);
  }

  refresh(): void {
    if (!this.state) return;
    // идёт полёт из очереди презентаций: пересборка убила бы виды и
    // полёт оборвался бы — откладываем (game.gd _refresh_pending)
    if (this.onlineMode && this.flightActive) {
      this.refreshPending = true;
      return;
    }
    const before = this.captureTileSnapshots();
    const ts = tileSize();
    const deckLabel = t('Колода: %d', this.state.tilesLeftInDeck());
    setDeckLabel(this.deckBtn, deckLabel);
    this.deckBtn.width = px(Math.max(108, Math.ceil(measureTextWidth(deckLabel, fs(15))) + 26));
    this.deckBtn.fontSize = fs(15);
    this.deckBtn.textBlock!.fontSize = fs(15);
    this.syncTopBar();
    this.rebuildChips();
    // Ход сменился — плавно подводим ряд чипов к активному игроку.
    if (this.state.current !== this.lastChipSeat) {
      this.lastChipSeat = this.state.current;
      this.scrollChipsToSeat(this.state.current);
    }
    // Бейджи переезжают от прежних фишек к новым: пересборка не должна
    // гасить «галочки» ни на кадр (иначе ряд мигает при каждой выкладке).
    this.inheritFigs = new Map<number, TileFigure>();
    for (const r of this.rowFigs) for (const f of r.figures) this.inheritFigs.set(f.face.id, f);
    for (const f of this.handFigs) this.inheritFigs.set(f.face.id, f);
    this.rebuildRows(ts);
    this.rebuildHand();
    this.inheritFigs = null;
    this.updateActionRow();
    // В сети чужой ход показывает очередь презентаций, а не общий дифф.
    // myTurn здесь уже может быть true, потому что сервер переключил ход на
    // нас после ответа бота; turn_placed отличает нашу локальную выкладку от
    // только что подтверждённого чужого хода.
    const localOnlineEdit = this.onlineMode && this.state.myTurn()
      && this.state.turn_placed.length > 0;
    if (!this.onlineMode || localOnlineEdit) this.animateTileTransitions(before);
  }

  private captureTileSnapshots(): Map<number, TileSnapshot> {
    const snapshots = new Map<number, TileSnapshot>();
    const slots = this.tileSlotKeys();
    const collect = (f: TileFigure, rowId?: number): void => {
      const rect = rectOf(f.root);
      if (rect.w > 0 && rect.h > 0) {
        snapshots.set(f.face.id, {
          face: f.face,
          rect,
          slot: slots.get(f.face.id),
          rowId,
          faceDown: f.faceDown,
        });
      }
    };
    for (const row of this.rowFigs) {
      if (!row.hintZone) for (const f of row.figures) collect(f, row.rowId);
    }
    for (const f of this.handFigs) collect(f);
    return snapshots;
  }

  // Слот визуального layout. Сравнение до/после позволяет ещё ДО кадра
  // Babylon спрятать только действительно перемещаемые фишки, не моргая
  // неизменившимися рядами и рукой.
  private tileSlotKeys(): Map<number, string> {
    const slots = new Map<number, string>();
    const rows = this.rowFigs.filter((r) => !r.hintZone);
    for (const row of rows) {
      for (let i = 0; i < row.figures.length; i += 1) {
        slots.set(row.figures[i].face.id,
          `row:${row.rowId}:${i}:${row.lineOf[i] ?? 0}`);
      }
    }
    for (let i = 0; i < this.handFigs.length; i += 1) {
      slots.set(this.handFigs[i].face.id, `hand:${i}`);
    }
    return slots;
  }

  // Ряд считаем переставленным только если изменился относительный порядок
  // старых рядов. Добавление/удаление ряда само по себе не должно запускать
  // анимацию для всех рядов ниже него.
  private reorderedRowIds(before: Map<number, TileSnapshot>): Set<number> {
    const previousOrder = [...new Set(
      [...before.values()]
        .map((snapshot) => snapshot.rowId)
        .filter((rowId): rowId is number => rowId !== undefined),
    )];
    const currentOrder = this.rowFigs.filter((row) => !row.hintZone).map((row) => row.rowId);
    const oldRows = new Set(previousOrder);
    const newRows = new Set(currentOrder);
    const oldCommonOrder = previousOrder.filter((rowId) => newRows.has(rowId));
    const newCommonOrder = currentOrder.filter((rowId) => oldRows.has(rowId));
    const reordered = new Set<number>();
    for (let i = 0; i < oldCommonOrder.length; i += 1) {
      if (oldCommonOrder[i] !== newCommonOrder[i]) {
        reordered.add(oldCommonOrder[i]);
        if (newCommonOrder[i] !== undefined) reordered.add(newCommonOrder[i]);
      }
    }
    return reordered;
  }

  private currentTileFigures(): Map<number, TileFigure> {
    const figures = new Map<number, TileFigure>();
    for (const row of this.rowFigs) for (const f of row.figures) figures.set(f.face.id, f);
    for (const f of this.handFigs) figures.set(f.face.id, f);
    return figures;
  }

  private animateTileTransitions(before: Map<number, TileSnapshot>): void {
    if (before.size === 0 && this.flightOrigins.size === 0) return;
    const requestId = ++this.layoutAnimationId;
    const figures = this.currentTileFigures();
    const origins = new Map(this.flightOrigins);
    this.flightOrigins.clear();
    const slots = this.tileSlotKeys();
    const reorderedRows = this.reorderedRowIds(before);
    const pending: { source: TileSnapshot; target: TileFigure; ghost: TileFigure; fade: boolean }[] = [];

    // Сначала определяем только реально сдвинувшиеся слоты и прячем их
    // синхронно с refresh. Иначе Babylon успевал один кадр показать новые
    // координаты, после чего плитки дёргались обратно к точке старта.
    for (const [id, target] of figures) {
      const origin = origins.get(id);
      const previous = before.get(id);
      if (!origin && (!previous || (
        previous.slot === slots.get(id)
        && (previous.rowId === undefined || !reorderedRows.has(previous.rowId))
      ))) continue;
      const source = origin ?? previous;
      if (!source) continue;
      target.hideBadgeForFlight();
      target.root.alpha = 0;
      const ghost = this.createFlightGhost(source, target);
      pending.push({ source, target, ghost, fade: !!origin });
    }
    if (pending.length === 0) return;

    let layoutFrames = 0;
    const finish = (): void => {
      for (const p of pending) {
        p.ghost.disposeBadge();
        if (p.ghost.root.parent) p.ghost.root.parent.removeControl(p.ghost.root);
        p.target.root.alpha = p.target.rgbaAlpha;
        p.target.revealBadge();
      }
    };
    const launch = (): void => {
      if (requestId !== this.layoutAnimationId || !this.running) {
        finish();
        return;
      }
      const ready = pending.every((p) => rectOf(p.target.root).w > 0 && rectOf(p.target.root).h > 0);
      if (!ready && layoutFrames < 3) {
        layoutFrames += 1;
        window.requestAnimationFrame(launch);
        return;
      }
      for (const p of pending) {
        if (requestId !== this.layoutAnimationId || !this.running) {
          finish();
          return;
        }
        const to = rectOf(p.target.root);
        if (to.w <= 0 || to.h <= 0) {
          p.ghost.disposeBadge();
          if (p.ghost.root.parent) p.ghost.root.parent.removeControl(p.ghost.root);
          p.target.root.alpha = p.target.rgbaAlpha;
          p.target.revealBadge();
          continue;
        }
        const dist = Math.hypot(to.x - p.source.rect.x, to.y - p.source.rect.y);
        if (dist < 2) {
          p.ghost.disposeBadge();
          if (p.ghost.root.parent) p.ghost.root.parent.removeControl(p.ghost.root);
          p.target.root.alpha = p.target.rgbaAlpha;
          p.target.revealBadge();
          continue;
        }
        const duration = Math.round(Math.max(240, Math.min(460, dist / 0.9)));
        this.playTileFlight(p.source, p.target, to, {
          duration,
          fromScale: 1,
          fromAlpha: p.fade ? 0 : p.target.rgbaAlpha,
        }, p.ghost);
      }
    };
    window.requestAnimationFrame(launch);
  }

  private playTileFlight(
    source: TileSnapshot,
    target: TileFigure,
    to: { x: number; y: number; w: number; h: number },
    opts: { duration?: number; fromScale?: number; fromAlpha?: number } = {},
    existingGhost?: TileFigure,
    onComplete?: () => void,
  ): void {
    target.hideBadgeForFlight();
    target.root.alpha = 0;
    const ghost = existingGhost ?? this.createFlightGhost(source, target);
    const root = ghost.root;

    const duration = opts.duration ?? 240;
    const fromScale = opts.fromScale ?? 1;
    const fromAlpha = opts.fromAlpha ?? 1;
    const endAlpha = target.rgbaAlpha;
    root.scaleX = fromScale;
    root.scaleY = fromScale;
    root.alpha = fromAlpha;
    const start = performance.now();
    const step = (now: number): void => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - progress) ** 3;
      root.left = px(Math.round(source.rect.x + (to.x - source.rect.x) * eased));
      root.top = px(Math.round(source.rect.y + (to.y - source.rect.y) * eased));
      const scale = fromScale + (1 - fromScale) * eased;
      root.scaleX = scale;
      root.scaleY = scale;
      // как Godot: проявление за 0.76 длительности полёта (SINE ease-out)
      const fade = Math.min(1, progress / 0.76);
      root.alpha = fromAlpha + (endAlpha - fromAlpha) * (1 - (1 - fade) ** 2);
      if (progress < 1) {
        window.requestAnimationFrame(step);
        return;
      }
      ghost.disposeBadge();
      if (root.parent) root.parent.removeControl(root);
      target.root.alpha = endAlpha;
      // Бейдж возвращаем сразу, без пустого кадра до следующего tick'а.
      target.revealBadge();
      onComplete?.();
    };
    window.requestAnimationFrame(step);
  }

  private createFlightGhost(source: TileSnapshot, target: TileFigure): TileFigure {
    // Копируем все метки, включая draft: иначе зелёная рамка пропадает
    // во время полёта. Бейдж живёт в отдельном слое над flightLayer.
    // Если источник — скрытая фишка (рука бота), призрак тоже летит
    // рубашкой вверх, чтобы игрок не увидел число на мгновение.
    const ghost = new TileFigure(
      source.face,
      source.faceDown === true,
      target.flightMarks(),
      tileSize(),
      this.badgeLayer,
      target.badgeShown(),
    );
    const root = ghost.root;
    root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    root.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    root.left = px(Math.round(source.rect.x));
    root.top = px(Math.round(source.rect.y));
    root.zIndex = 680;
    root.isPointerBlocker = false;
    root.alpha = target.rgbaAlpha;
    this.flightLayer.addControl(root);
    return ghost;
  }

  relayout(): void {
    if (this.state && this.running) {
      this.syncTopBar();
      this.rowsScroll.height = px(this.tableHeightPx());
      this.handPanel.width = px(Math.max(180, viewWidth() - SIDE_PAD * 2));
      const bw = this.bottomButtonWidth();
      this.undoBtn.width = px(bw);
      this.bottomBtn.width = px(bw);
      this.refresh();
    }
  }

  private rebuildChips(): void {
    this.chipsRow.clearControls();
    for (let i = 0; i < this.state!.playerCount(); i += 1) {
      // в сети имена из GAME_VIEW (настройки — только для офлайна);
      // счётчик руки — с оверрайдом (чужие руки тайлами неизвестны)
      const chipName = this.state!.playerName(i);
      const handN = this.state!.handSize(i);
      const isCur = i === this.highlightSeat();
      // своя незавершённая раскладка в свой ход — «ваш ход»
      const myTurnNow = this.state!.myTurn() && this.state!.turn_placed.length > 0;
      const isYou = i === this.state!.local_seat;
      const isBot = !!this.state!.players[i].is_bot;
      let chipText = `${isCur ? '▶ ' : ''}${chipName}`;
      if (isYou) chipText += t(' · вы');
      if (isBot) chipText += t(' · бот');
      if (isYou && myTurnNow) chipText += t(' · ваш ход');
      else if (isCur && !isYou) chipText += t(' · ходит');
      if (handN > 0) chipText += ` · ${handN}`;
      if (i === this.drewSeat) chipText += t(' · взял');
      if (!this.state!.isConnectedPlayer(i) && !isBot) chipText += t(' · нет связи');
      const chipWidth = Math.max(112, Math.ceil(measureTextWidth(chipText, fs(11))) + 24);

      const chip = new Container('chip');
      chip.width = px(chipWidth);
      // Высота с запасом под масштаб текста: при клипе по краям у текста
      // срезались верхние/нижние пиксели глифов.
      chip.height = px(40);
      chip.clipChildren = true;
      const fill = new Rectangle('chipFill');
      fill.cornerRadius = 8;
      fill.thickness = 1;
      fill.color = isCur ? '#FFD54F' : '#ffffff30';
      fill.background = isCur ? '#FFD54F33' : '#ffffff12';
      fill.width = '100%';
      fill.height = '100%';
      fill.isHitTestVisible = false;
      chip.addControl(fill);
      const label = mkLabel(chipText, {
        fontSize: fs(11), color: isCur ? SKIN.gold : '#ffffffB0',
        width: chipWidth - 20, height: 40, hAlign: 'left', noWrap: true,
      });
      label.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
      label.left = px(10);
      chip.addControl(label);
      this.chipsRow.addControl(chip);
    }
  }

  // === рендер стола/руки ===
  // Зона «новый ряд» находится после стола, а промежуточные слоты нужны
  // только между уже существующими рядами.
  private rebuildRows(ts: { x: number; y: number }): void {
    // Ширина стола фиксирована относительно экрана: 12px слева и 12px
    // справа, независимо от того, видна ли тонкая полоса прокрутки.
    // Раньше ширина бралась из уже посчитанной меры окна скролла, и если
    // полоса появлялась позже, ряд становился на пару пикселей шире и
    // правый отступ «съедался».
    const vw = viewWidth();
    const innerW = Math.max(150, vw - 24);
    this.rowsInner.clearControls();
    this.rowFigs = [];
    this.rowSlots = [];
    const rows: RowFig[] = [];
    let tableIdx = 0;
    for (const row of this.state!.table) {
      if (row.tiles.length === 0) { tableIdx += 1; continue; }
      // серверная подсветка идёт по ИНДЕКСУ в table (engine: errors[].row)
      const fig = this.makeRowBlock(row.id, row.tiles, ts, innerW, false, this.serverErrorRows.has(tableIdx));
      tableIdx += 1;
      rows.push(fig);
    }
    for (let i = 0; i < rows.length; i += 1) {
      const fig = rows[i];
      this.rowsInner.addControl(fig.root);
      this.rowFigs.push(fig);
      if (i < rows.length - 1) {
        const slot = this.makeSlotSpacer(ts, innerW);
        this.rowsInner.addControl(slot.root);
        this.rowSlots.push({ root: slot.root, fill: slot.fill, at: i + 1 });
      }
    }
    const hintFig = this.makeHintZone(ts, innerW);
    this.rowsInner.addControl(hintFig.root);
    this.rowFigs.push(hintFig);
  }

  private makeSlotSpacer(ts: { x: number; y: number }, innerW: number): { root: Container; fill: Rectangle } {
    const hostC = new Container('rowSlot');
    hostC.width = px(innerW);
    hostC.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    hostC.left = px(12);
    // Слот невидим и схлопнут, пока фишка не наведена между рядами:
    // постоянного большого зазора между рядами нет. При наведении слот
    // с задержкой раздувается до 10px (hoverSlot/highlightSlot) и подсвечивается.
    hostC.height = px(1);
    hostC.isVisible = true;
    const fill = new Rectangle('slotFill');
    fill.cornerRadius = 6;
    fill.thickness = 0;
    fill.color = '#FFD54F00';
    fill.background = '#FFD54F00';
    fill.width = '100%';
    fill.height = '100%';
    fill.isHitTestVisible = false;
    hostC.addControl(fill);
    return { root: hostC, fill };
  }

  private makeRowBlock(rowId: number, tiles: TileFace[], ts: { x: number; y: number }, innerW: number, hint: boolean, serverInvalid = false): RowFig {
    const hostC = new Container('rowBlock');
    hostC.width = px(innerW);
    hostC.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    hostC.left = px(12);
    hostC.clipChildren = false;
    // высота — по фактическому числу визуальных строк: при переполнении
    // ряд растёт вниз и вмещает все фишки
    hostC.height = px(ts.y + 16);
    // невалидный ряд обводится красным: локальная проверка + серверная
    // (game.error приходит с индексами рядов)
    const invalid = !hint && (serverInvalid || !validateRow(tiles).ok);
    const block = softPanel({
      bg: invalid ? '#E539351A' : '#ffffff0D',
      border: invalid ? SKIN.rowBorderInvalid : '#00000055',
      thickness: invalid ? 2 : 1,
      corner: 10,
    });
    block.root.width = '100%';
    block.root.height = '100%';
    hostC.addControl(block.root);
    const host = new Container('rowHost');
    host.width = px(innerW - 20);
    host.clipChildren = false;
    host.height = px(ts.y);
    host.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    host.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    host.left = pxa(0);
    host.top = pxa(0);
    hostC.addControl(host);
    const fig: RowFig = { rowId, root: hostC, fill: block.fill, host, figures: [], items: [], lineOf: [], hintZone: hint };
    let marks: TileMarks[] = [];
    if (!hint) marks = tiles.map((_tl, i) => this.markFor({ kind: 'row', rowId, index: i }));
    for (let i = 0; i < tiles.length; i += 1) {
      // Чужой черновик помечается как draft: полупрозрачность, жирная
      // зелёная рамка и галочка в углу (game.gd get_tile_marks:3062-3072).
      const m: TileMarks = { ...(marks[i] ?? {}) };
      if (this.draftNewIds.has(tiles[i].id)) m.draft = true;
      const f = new TileFigure(tiles[i], false, m, ts, this.badgeLayer, false, this.inheritFigs?.get(tiles[i].id) ?? null);
      this.wireDrag(f, { kind: 'row', rowId, index: i });
      fig.figures.push(f);
      fig.items.push({ root: f.root, width: ts.x, height: ts.y });
    }
    const laid = layoutFlow(host, fig.items, innerW - 20, preschoolGap(ts));
    fig.lineOf = laid.lineOf;
    host.height = px(laid.totalHeight);
    hostC.height = px(laid.totalHeight + 16);
    return fig;
  }

  private markFor(src: TileSrc): TileMarks {
    const marks: TileMarks = {};
    if (!this.state) return marks;
    if (src.kind !== 'row') return marks;
    const row = this.state.rowById(src.rowId);
    if (!row) return marks;
    const tile = row.tiles[src.index];
    if (!tile) return marks;
    if (this.state.turn_placed.includes(tile)) marks.draft = true;
    else if (this.state.last_turn_tile_ids.includes(tile.id)) marks.last = true;
    return marks;
  }

  private makeHintZone(ts: { x: number; y: number }, innerW: number): RowFig {
    const hostC = new Container('hintZone');
    hostC.width = px(innerW);
    hostC.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    // Текст с теми же отступами от краёв, что и у остальных панелей:
    // слева 12px, справа 12px (полоса прокрутки не в счёт).
    hostC.left = px(12);
    const hintInset = 10;
    const hintW = innerW - 12;
    const hintText = t('Перетащите сюда число — новый ряд');
    const labelW = hintW - hintInset;
    const labelH = estimateWrappedTextHeight(hintText, labelW, fs(13));
    hostC.height = px(Math.max(ts.y + 16, labelH + 8));
    const block = softPanel({ bg: '#2E7D3222', border: '#2E7D3280', thickness: 2, corner: 10 });
    block.root.width = '100%';
    block.root.height = '100%';
    hostC.addControl(block.root);
    // Надпись по центру зоны сброса.
    const lab = mkLabel(hintText, {
      fontSize: fs(13), color: '#9CD6A5', width: labelW,
      height: labelH, align: 'center', hAlign: 'center', vAlign: 'center',
    });
    hostC.addControl(lab);
    return { rowId: -1, root: hostC, fill: block.fill, host: hostC, figures: [], items: [], lineOf: [], hintZone: true };
  }

  private rebuildHand(): void {
    this.handHost.clearControls();
    this.handFigs = [];
    if (!this.state) return;
    const hand = this.state.hand();
    sortTiles(hand);
    // В сети внизу всегда наша рука, в офлайне — рука текущего игрока;
    // галочка ставится на фишку того места, которое её брало (а не того,
    // чей сейчас ход): взятие сразу передаёт ход дальше.
    const handSeat = this.onlineMode ? this.state.local_seat : this.state.current;
    const drawnTileId = this.drawMarks.get(handSeat) ?? null;
    // Когда ходит бот (офлайн), его руку игроку не показываем: фишки
    // лежат рубашкой вверх, без чисел.
    const faceDown = !this.onlineMode && this.state.players[handSeat]?.is_bot === true;
    const ts = this.handTileSize();
    const items: FlowItem[] = [];
    for (let i = 0; i < hand.length; i += 1) {
      const face = hand[i];
      const f = new TileFigure(face, faceDown, {
        hint: this.hintTileIds.has(face.id),
        drawn: drawnTileId === face.id,
      }, ts, this.badgeLayer, false, this.inheritFigs?.get(face.id) ?? null);
      this.wireDrag(f, { kind: 'hand', rowId: -1, index: i });
      this.handFigs.push(f);
      items.push({ root: f.root, width: ts.x, height: ts.y });
    }
    // Ширина руки зависит от текущего размера поля: при смене разрешения её
    // нужно пересчитать, иначе раскладка центруется по старой ширине и фишки
    // уезжают в сторону и обрезаются.
    this.handPanel.width = px(Math.max(180, viewWidth() - SIDE_PAD * 2));
    this.handHost.width = px(this.handAvailW());
    // Перенос строк: фишки раскладываются рядами по доступной ширине.
    const laid = layoutFlow(this.handHost, items, this.handAvailW(), flowGap(ts));
    this.handHost.height = px(Math.max(ts.y, laid.totalHeight));
    const handH = laid.totalHeight + 26;
    this.handPanel.height = px(handH);
    // Стол забирает весь остаток под фактическую высоту руки: рука всегда
    // видна целиком, а стол скроллится.
    if (this.rowsScroll) {
      this.rowsScroll.height = px(Math.max(
        OfflineGame.MIN_TABLE_H,
        Math.floor(viewHeight() - this.fixedVSpace() - handH),
      ));
    }
  }

  // Базовый фон кнопки: Babylon в disabled рисует disabledColor, но простой
  // возврат isEnabled=true может оставить чужой hover-фон — восстанавливаем.
  private btnBaseBg = new Map<Button, string>();

  private setBtnEnabled(b: Button, on: boolean): void {
    if (!this.btnBaseBg.has(b)) this.btnBaseBg.set(b, String(b.background ?? ''));
    if (b.isEnabled === on) return;
    b.isEnabled = on;
    b.disabledColor = '#FFFFFF1F';
    if (on) b.background = this.btnBaseBg.get(b) as string;
    if (b.textBlock) b.textBlock.alpha = on ? 1 : 0.45;
  }

  private updateActionRow(): void {
    if (!this.state) return;
    const env = this.lastWaitEnv;
    // Пауза/ожидание/grace: ходить нельзя — гасим все действия, как в
    // оригинале (_update_buttons: busy = бот или «не наш ход», locked).
    const paused = !!env && (env.paused || env.waiting || (env.grace ?? 0) > 0);
    const botNow = this.currentPlayerIsBot();
    const notMyTurn = this.onlineMode && !this.state.myTurn();
    const locked = this.state.finished || this.sending || botNow || notMyTurn || paused;
    const placed = this.state.turn_placed.length > 0;
    // «Отменить ход» — возврат к началу хода (Godot: restore_turn_snapshot);
    // доступен и тогда, когда фишки только перемещены/разложены, но ход
    // ещё не завершён (turn_dirty покрывает правки на столе).
    this.setBtnEnabled(this.undoBtn, !locked && (placed || this.state.turn_dirty));
    this.setBtnEnabled(this.saveBtn, !locked && placed);
    this.setBtnEnabled(this.restoreBtn, !locked && this.state.checkpoints.length > 0);
    // Подсказка: на площадках — всегда за рекламу (кнопка активна, горит
    // значок «AD»); на своём сайте — одна бесплатная на игрока за партию.
    const needAd = platform.supportsRewarded;
    const hintUsed = this.hintsUsed.has(this.state.current);
    this.setBtnEnabled(this.hintBtn, !locked && (needAd || !hintUsed));
    if (this.hintAdBadge) this.hintAdBadge.isVisible = !locked && needAd;
    this.setBtnEnabled(this.deckBtn, !locked && !placed && this.state.canDraw());
    if (this.state.finished) {
      setButtonLabel(this.bottomBtn, t('Игра окончена'));
      this.setBtnEnabled(this.bottomBtn, false);
      return;
    }
    // запрос в полёте: все действия гаснут до ответа сервера
    if (this.sending) {
      setButtonLabel(this.bottomBtn, t('…'));
      this.setBtnEnabled(this.bottomBtn, false);
      return;
    }
    if (botNow) {
      setButtonLabel(this.bottomBtn, t('Ход бота'));
      this.setBtnEnabled(this.bottomBtn, false);
      return;
    }
    if (placed) setButtonLabel(this.bottomBtn, t('Продолжить'));
    else if (this.state.canSkip()) setButtonLabel(this.bottomBtn, t('Пропуск хода'));
    else setButtonLabel(this.bottomBtn, t('Взять'));
    this.setBtnEnabled(this.bottomBtn, !locked);
  }

  // === Действия ===
  private onSaveCheckpoint(): void {
    if (!this.state) return;
    if (this.state.saveCheckpoint()) {
      this.toast(t('Расклад сохранён'));
      this.refresh();
    }
  }

  private onUndo(): void {
    if (!this.state) return;
    // Godot: _on_undo_pressed → restore_turn_snapshot (весь ход целиком).
    if (this.state.restoreTurnSnapshot()) {
      // в сети перемещение уходит черновиком и остальным
      if (this.onlineMode) this.sendMyDraft();
      this.refresh();
    }
  }

  private onRestoreCheckpoint(): void {
    if (!this.state) return;
    if (this.state.restoreCheckpoint()) {
      if (this.onlineMode) this.sendMyDraft();
      this.refresh();
    }
  }

  private onHint(): void {
    if (!this.state || this.state.finished || this.currentPlayerIsBot()) return;
    if (platform.supportsRewarded) {
      // На площадках подсказка — только за просмотр rewarded-видео,
      // с самого первого использования. Строго по согласию игрока.
      this.askConfirm(
        t('Реклама'),
        t('Посмотреть рекламу и получить подсказку?'),
        t('Смотреть'),
        () => {
          void platform.showRewarded().then((ok) => {
            if (ok) this.giveHint(false);
            else this.toast(t('Не удалось показать рекламу'));
          });
        },
      );
      return;
    }
    // Свой сайт / standalone: одна бесплатная подсказка на игрока за
    // партию (как в оригинале Godot: _hints_used).
    if (this.hintsUsed.has(this.state.current)) {
      this.toast(t('Подсказка уже была использована'));
      return;
    }
    this.giveHint(true);
  }

  // countAsUsed — засчитать в лимит бесплатных (только standalone;
  // подсказки за рекламу не лимитируются).
  private giveHint(countAsUsed: boolean): void {
    if (!this.state || this.state.finished || this.currentPlayerIsBot()) return;
    const plan = this.planner.plan(this.state, LEVEL_IMPOSSIBLE);
    if (plan.action === 'draw') {
      this.toast(t('Подсказка: возьмите из колоды'));
      return;
    }
    if (plan.action === 'place' && plan.tiles.length > 0) {
      this.hintTileIds = new Set(plan.tiles);
      // Обновляем всю руку, а не только текущие объекты TileFigure: после
      // resize/возврата из рекламы Babylon может пересоздать их. rebuildHand
      // повторно наложит подсказку из hintTileIds.
      this.refresh();
      // Подсказки за рекламу не лимитируются; бесплатная (standalone) —
      // одноразовая.
      if (countAsUsed) this.hintsUsed.add(this.state.current);
      this.toast(t('Подсказка: выложите %d чисел', plan.tiles.length));
      if (this.hintTimer) window.clearTimeout(this.hintTimer);
      this.hintTimer = window.setTimeout(() => {
        this.hintTimer = 0;
        this.hintTileIds.clear();
        this.refresh();
      }, 2600);
    }
  }

  // Пометка «кнопка с рекламой»: локализованный текст (RU «Реклама», EN «Ad»),
  // а не западное «AD». Небольшой жёлтый бейдж в углу кнопки.
  private mkAdBadge(): Rectangle {
    const text = t('Реклама');
    const font = 9;
    const w = Math.ceil(measureTextWidth(text, font)) + 10;
    const badge = new Rectangle('hintAdBadge');
    badge.width = px(w);
    badge.height = px(14);
    badge.cornerRadius = 4;
    badge.background = '#FFC107';
    badge.color = '#00000000';
    badge.thickness = 0;
    badge.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    badge.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    badge.isPointerBlocker = false;
    badge.isHitTestVisible = false;
    const label = new TextBlock('hintAdText', text);
    label.color = '#1A1A1A';
    label.fontSize = font;
    label.fontFamily = 'Arial, sans-serif';
    label.isHitTestVisible = false;
    badge.addControl(label);
    return badge;
  }

  // Бургер: столбик скрытых действий под верхней панелью у правого края,
  // тап мимо закрывает. Показывается НИЖЕ бургера (не перекрывая его) и
  // с собственным фоном.
  private openBurger(): void {
    const wasOpen = this.popups.children.some((c) => c.name === 'burger');
    this.clearTransientOverlays();
    if (wasOpen) return;
    // Катчер носит то же имя, что и панель: clearTransientOverlays() ищет
    // по имени 'burger' и должен удалять И ПАНЕЛЬ, И катчер. Если катчер
    // останется, он перехватит все тапы по экрану — кнопки «умрут»
    // (работает только скролл фишек через document-capture).
    const catcher = new Container('burger');
    catcher.width = '100%';
    catcher.height = '100%';
    catcher.isPointerBlocker = true;
    catcher.zIndex = 690;
    catcher.onPointerUpObservable.add(() => this.clearTransientOverlays());
    this.popups.addControl(catcher);

    // Темы с рамкой: у кнопок появляется видимая граница, и закругление
    // углов (cornerRadius) отчётливо видно даже на тёмном фоне панели.
    const deckTheme: ButtonTheme = { bg: '#2F3B4C', hover: '#4A5C73', press: '#263040', border: '#ffffff26' };
    const menuTheme: ButtonTheme = { bg: '#1F4E79', hover: '#2A6CA8', press: '#163A5C', border: '#ffffff26' };
    const items: { label: string; onClick: () => void; theme: ButtonTheme; ad?: boolean }[] = [];
    if (this.hiddenTopActionNames.includes('topSave')) items.push({ label: t('Сохр.'), onClick: () => this.onSaveCheckpoint(), theme: deckTheme });
    if (this.hiddenTopActionNames.includes('topRestore')) items.push({ label: t('Вернуть'), onClick: () => this.onRestoreCheckpoint(), theme: deckTheme });
    if (this.hiddenTopActionNames.includes('topHint')) items.push({ label: t('Подск.'), onClick: () => this.onHint(), theme: deckTheme, ad: platform.supportsRewarded });
    if (this.hiddenTopActionNames.includes('topHelp')) items.push({ label: t('Правила'), onClick: () => this.showRulesOverlay(), theme: deckTheme });
    if (this.hiddenTopActionNames.includes('topSettings')) items.push({ label: t('Настр.'), onClick: () => this.showSettingsOverlay(), theme: deckTheme });
    if (this.hiddenTopActionNames.includes('topMenu')) items.push({
      label: t('Меню'),
      onClick: () => {
        if (this.onlineMode) {
          this.askConfirm(t('Выход в меню'), t('Выйти из партии в главное меню? Вы сможете вернуться.'), t('Выйти'), () => this.leaveToMenu());
          return;
        }
        this.askConfirm(t('Выход в меню'), t('Выйти в главное меню?'), t('Выйти'), () => {
          this.running = false;
          withInterstitial(() => this.host.toMenu());
        });
      },
      theme: menuTheme,
    });
    if (items.length === 0) return;

    const boxW = 160;
    const btnH = 46;
    const gap = 6;
    const padV = 8;
    const boxH = padV * 2 + items.length * btnH + Math.max(0, items.length - 1) * gap;
    const box = softPanel({
      bg: SKIN.panelDark,
      border: '#ffffff40',
      thickness: 2,
      corner: 10,
      width: boxW,
      height: boxH,
    });
    // То же имя, что у катчера и внутренней панели: закрытие удаляет весь
    // блок целиком (иначе фоновая рамка оставалась бы на экране).
    box.root.name = 'burger';
    box.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    box.root.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    // Сдвиг вниз: верхняя панель занимает ~46px — меню раскрывается ПОД
    // бургером, а не поверх него.
    box.root.top = px(56);
    box.root.zIndex = 700;
    this.popups.addControl(box.root);

    const panel = new StackPanel('burger');
    panel.isVertical = true;
    panel.spacing = gap;
    panel.width = px(boxW - 16);
    panel.paddingLeft = px(8);
    panel.paddingRight = px(8);
    panel.paddingTop = px(padV);
    panel.paddingBottom = px(padV);
    box.root.addControl(panel);
    for (const it of items) {
      // Ширина = внутреннее поле панели (boxW минус padding 8+8): иначе
      // кнопки вылезают за пределы панели и кажутся обрезанными.
      const b = mkButton(it.label, { height: btnH, width: boxW - 32, fontSize: fs(15), corner: 14, theme: it.theme });
      if (it.ad) b.addControl(this.mkAdBadge());
      b.onPointerUpObservable.clear();
      b.onPointerUpObservable.add(() => {
        this.clearTransientOverlays();
        it.onClick();
      });
      panel.addControl(b);
    }
  }

  private showRulesOverlay(): void {
    openRulesOverlay(this.popups, () => {});
  }

  // Сетевая партия: временный выход ведёт в главное меню и сохраняет
  // место (game.gd _on_leave_to_menu: finished → room.drop, иначе room.leave).
  // Выход — логическая пауза: сначала interstitial площадки, затем меню.
  private leaveToMenu(): void {
    this.running = false;
    this.stopTimers();
    const api = this.host.gameApi();
    try {
      if (this.state && this.state.finished) void api.dropRoom();
      else void api.leaveRoom();
    } catch {
      /* комната может уже не существовать */
    }
    withInterstitial(() => this.host.toMenu());
  }

  private showSettingsOverlay(): void {
    openSettingsOverlay(this.popups, this.ctx, () => {}, () => {
      // Масштаб текста, размер фишек и язык требуют пересборки контролов.
      // Пересборка сохраняет GameState; после неё сразу открываем настройки
      // заново, чтобы игрок мог менять несколько параметров подряд.
      this.host.rebuildScreen();
      this.showSettingsOverlay();
    });
  }

  private onDeckButton(): void {
    if (!this.state || this.state.finished || this.currentPlayerIsBot()) return;
    if (this.state.turn_placed.length > 0) {
      this.toast(t('Нельзя брать из колоды после выкладки'));
      return;
    }
    const status = this.state.tableStatus();
    if (!status.ok) {
      this.toast(status.errors[0]?.reason ?? t('Стол в невалидном состоянии'));
      return;
    }
    this.askConfirm(
      t('Взять карту'),
      t('Взять число из колоды?\nХод сразу завершится.'),
      t('Взять'),
      () => this.doDraw(),
    );
  }

  private doDraw(): void {
    if (!this.state) return;
    // в сети ход делает сервер: бейдж «взял» расставит applyOnlineView
    if (this.onlineMode) {
      void this.doDrawOnline();
      return;
    }
    const deckRect = rectOf(this.deckBtn);
    const drawingSeat = this.state.current;
    const res = this.state.drawFromDeck();
    if (res.ok) {
      if (res.tile && deckRect.w > 0 && deckRect.h > 0) {
        const ts = tileSize();
        this.flightOrigins.set(res.tile.id, {
          face: res.tile,
          rect: {
            x: deckRect.x + deckRect.w / 2 - ts.x / 2,
            y: deckRect.y + deckRect.h / 2 - ts.y / 2,
            w: ts.x,
            h: ts.y,
          },
        });
      }
      if (res.tile) this.noteDraw(drawingSeat, res.tile.id);
      this.toast(res.tile ? (res.tile.is_joker ? '★' : String(res.tile.value)) : '');
      this.refresh();
      window.setTimeout(() => {
        if (this.running) this.checkPassOrBot();
      }, DROP_MS);
    } else {
      this.toast(res.reason);
    }
  }

  private onMainButton(): void {
    if (!this.state || this.state.finished || !this.running) return;
    if (this.currentPlayerIsBot()) return;
    if (this.state.turn_placed.length > 0) this.doEndTurn();
    else if (this.state.tilesLeftInDeck() > 0) this.onDeckButton();
    else this.doSkip();
  }

  private doEndTurn(): void {
    if (!this.state) return;
    const check = this.state.checkTurn();
    if (!check.ok) {
      if (check.errors.length > 0) this.toast(check.errors[0].reason);
      else this.toast(check.reason);
      return;
    }
    // в сети: отправляем раскладку, сервер возвращает GAME_STATE
    if (this.onlineMode) {
      void this.doCommitOnline();
      return;
    }
    const res = this.state.endTurn();
    if (res.win) {
      this.recordResult();
      this.showWin();
      return;
    }
    this.checkPassOrBot();
  }

  // Итог локальной партии «один человек против ботов». Победа — если
  // выиграл единственный живой игрок, иначе поражение. Hot-seat сюда не
  // доходит (localStatsEligible = false), в сети статистику ведёт сервер.
  private recordResult(): void {
    if (this.onlineMode || !this.localStatsEligible || this.localStatsResultDone) return;
    if (!this.state) return;
    this.localStatsResultDone = true;
    recordLocalGameResult(this.state.winner === this.localStatsHumanSeat);
  }

  private doSkip(): void {
    if (!this.state) return;
    if (this.onlineMode) {
      void this.doSkipOnline();
      return;
    }
    const res = this.state.skipTurn();
    if (!res.ok) {
      this.toast(res.reason);
      return;
    }
    this.checkPassOrBot();
  }

  // Показать всплывающее сообщение (в верхней части, крупно; убрать — тапом).
  toast(s: string): void {
    if (this.hintTimer) window.clearTimeout(this.hintTimer);
    this.hintTimer = 0;
    if (!this.toastHost || !this.toastLabel) return;
    s = t(s);
    if (!s) {
      this.toastHost.isVisible = false;
      return;
    }
    // высота под фактическое число строк (перенос длинных сообщений)
    const size = fs(18);
    const boxW = Math.max(120, Math.min(viewWidth() - 40, 480));
    const textW = Math.max(100, boxW - 24);
    s = wrapTextToWidth(s, textW, size);
    const lineH = estimateWrappedTextHeight(s, textW, size);
    const h = Math.max(52, lineH + 20);
    this.toastHost.width = px(boxW);
    this.toastHost.height = px(h);
    this.toastLabel.width = px(textW);
    this.toastLabel.height = px(h - 12);
    this.toastLabel.text = s;
    this.toastHost.isVisible = true;
    this.hintTimer = window.setTimeout(() => {
      this.hintTimer = 0;
      this.toastHost!.isVisible = false;
    }, 2600);
  }

  // Godot game.gd _build_confirm_dialog: панель #171F2B с зелёной рамкой,
  // титул золотом fs22, текст fs16 белый, [ОК зелёная][Отмена], клик мимо
  // панели закрывает. Один диалог на оба вопроса.
  private askConfirm(title: string, text: string, okText: string, action: () => void): void {
    // Окончена ли партия — не преграда: после экрана победы и «Посмотреть
    // стол» running уже false, но кнопка «Меню» обязана работать.
    if (!this.popups || (!this.running && !this.state?.finished)) return;
    this.closeConfirm();
    const m = modalOverlay(this.popups, 'confirm', { alpha: 0.6, zIndex: 930 });
    this.confirmUi = m;
    const dim = m.overlay.children[0];
    if (dim) dim.onPointerDownObservable.add(() => this.closeConfirm());
    this.confirmAction = action;
    const vw = viewWidth();
    const panelWidth = Math.min(Math.round(vw * 0.92), 420);
    const contentW = Math.max(120, panelWidth - 40);
    const titleSize = fs(22);
    const textSize = fs(16);
    // Высоты по РЕАЛЬНОМУ переносу строк: на телефоне с крупным текстом
    // строки занимают несколько линий, иначе текст режется сверху/снизу.
    const wrappedTitle = wrapTextToWidth(title, contentW, titleSize);
    const titleH = estimateWrappedTextHeight(wrappedTitle, contentW, titleSize);
    const lines = text.split('\n').map((line) => wrapTextToWidth(line, contentW, textSize));
    const lineHs = lines.map((line) => estimateWrappedTextHeight(line, contentW, textSize));
    const btnH = 52;
    const okW = Math.max(120, Math.min(contentW, measureTextWidth(okText, fs(16)) + 40));
    const cancelW = Math.max(120, Math.min(contentW, measureTextWidth(t('Отмена'), fs(16)) + 40));
    // Если две кнопки не помещаются в ширину — ставим их друг под другом,
    // иначе правая/левая уходит за край панели.
    const rowVertical = okW + cancelW + 12 > contentW;
    const rowH = rowVertical ? btnH * 2 + 12 : btnH;
    const kids = [titleH, ...lineHs, rowH];
    const ph = 32 + kids.reduce((a: number, b: number) => a + b, 0) + 12 * (kids.length - 1);
    const panel = softPanel({ bg: '#171F2B', bgAlpha: 0.98, border: '#43A047', thickness: 2, corner: 14 });
    panel.root.width = px(panelWidth);
    panel.root.height = px(ph);
    panel.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    const confirmScrollH = Math.max(120, viewHeight() - 24);
    panel.root.verticalAlignment = ph <= confirmScrollH
      ? Control.VERTICAL_ALIGNMENT_CENTER
      : Control.VERTICAL_ALIGNMENT_TOP;
    const col = new StackPanel('confirmBox');
    col.isVertical = true;
    col.width = '100%';
    col.spacing = 12;
    col.paddingLeft = pxa(20);
    col.paddingRight = pxa(20);
    col.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    panel.root.addControl(col);
    col.addControl(mkLabel(wrappedTitle, {
      fontSize: titleSize, color: SKIN.gold, width: contentW, height: titleH,
    }));
    lines.forEach((line, i) => {
      col.addControl(mkLabel(line, {
        fontSize: textSize, color: '#ffffffE6', width: contentW, height: lineHs[i],
      }));
    });
    const row = new StackPanel('confirmRow');
    row.isVertical = rowVertical;
    row.height = px(rowH);
    row.spacing = 12;
    row.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    const ok = mkButton(okText, {
      height: btnH, width: rowVertical ? contentW : okW, fontSize: fs(16),
      theme: BUTTON_STYLE.green,
    });
    ok.onPointerUpObservable.clear();
    ok.onPointerUpObservable.add(() => {
      const act = this.confirmAction;
      this.closeConfirm();
      if (act) act();
    });
    const cancel = mkButton(t('Отмена'), {
      height: btnH, width: rowVertical ? contentW : cancelW, fontSize: fs(16),
      theme: { bg: '#31363F', hover: '#3A404A', press: '#262B33' },
    });
    cancel.onPointerUpObservable.clear();
    cancel.onPointerUpObservable.add(() => this.closeConfirm());
    row.addControl(ok);
    row.addControl(cancel);
    col.addControl(row);

    if (ph <= confirmScrollH) {
      // Короткий диалог размещаем прямо в полноэкранном overlay. Если
      // положить его в ScrollViewer, Babylon выравнивает его у начала окна.
      m.overlay.addControl(panel.root);
    } else {
      const scroll = new ScrollViewer('confirmScroll');
      scroll.thickness = 0;
      scroll.barSize = 4;
      scroll.width = px(panelWidth);
      scroll.height = px(confirmScrollH);
      scroll.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
      scroll.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
      m.overlay.addControl(scroll);
      scroll.addControl(panel.root);
      enableSmoothScroll(scroll);
    }
  }

  private closeConfirm(): void {
    this.confirmAction = null;
    if (this.confirmUi) {
      const ui = this.confirmUi;
      this.confirmUi = null;
      ui.close();
    }
  }

  // === Drag & drop ===
  private canInteract(): boolean {
    return !!this.state && this.running && !this.state.finished && this.state.myTurn() && !this.currentPlayerIsBot()
      && !this.sending
      && this.popups.children.length === 0;
  }

  private wireDrag(f: TileFigure, src: TileSrc): void {
    f.root.onPointerDownObservable.add((coords) => {
      if (!this.canInteract()) return;
      // Babylon даёт точные GUI-координаты нажатия в первом аргументе
      // (Vector2WithInfo) — это и есть точка захвата.
      if (coords && Number.isFinite((coords as { x?: number }).x)) {
        nativePointer.x = (coords as { x: number }).x;
        nativePointer.y = (coords as { y: number }).y;
      }
      this.beginDrag(f, src);
    });
  }

  private beginDrag(f: TileFigure, src: TileSrc): void {
    if (this.dragData || !this.state) return;
    // Фактический старт drag отменяет все touch-жесты скролла: document
    // получает pointerdown раньше Babylon, и хит-тест мог ошибиться.
    abortTouchGestures();
    const ts = tileSize();
    const previewHost = new Container('dragPreview');
    previewHost.width = px(ts.x);
    previewHost.height = px(ts.y);
    // left/top у GUI-контрола — это смещение ОТ точки выравнивания.
    // Контейнер по умолчанию выравнивается по центру, из-за чего позиция
    // курсора добавлялась к центру canvas и превью улетало вправо-вниз.
    // Drag-слой живёт в экранных координатах, поэтому якорим его в (0, 0).
    previewHost.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    previewHost.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    previewHost.zIndex = 600;
    previewHost.isPointerBlocker = false;
    const ghost = new TileFigure(f.face, false, { drawn: false }, ts);
    previewHost.addControl(ghost.root);
    this.boardRoot.addControl(previewHost);
    ghost.root.alpha = 0.9;
    f.root.alpha = 0.35;
    const scene = this.host.getScene();
    let unified: import('@babylonjs/core').Observer<import('@babylonjs/core').PointerInfo> | null = null;
    const onUpInternal = (): void => {
      if (unified !== null) scene.onPointerObservable.remove(unified);
      unified = null;
      this.clearSlotHighlight();
      this.dragEnd();
    };
    unified = scene.onPointerObservable.add((pi) => {
      if (!this.dragData) return;
      switch (pi.type) {
        case PointerEventTypes.POINTERMOVE:
          {
            const g = guiPointer(scene, pi);
            this.dragPointer = g;
            this.updateDragHover(g);
            this.scheduleDragAutoScroll();
          }
          break;
        case PointerEventTypes.POINTERUP:
          onUpInternal();
          break;
        default:
          break;
      }
    });
    this.dragData = { face: f.face, src, previewHost, targetRow: undefined, index: undefined, obs: unified! };
    // На touch-у некоторых браузеров Babylon не присылает непрерывный
    // POINTERMOVE удерживаемой фишки (особенно у края canvas). Дублируем
    // слежение нативным событием окна, привязанным к тому же указателю.
    this.dragPointerAbort?.abort();
    this.dragPointerAbort = new AbortController();
    const activePointerId = nativePointer.pointerId;
    window.addEventListener('pointermove', (event) => {
      if (!this.dragData || (activePointerId !== null && event.pointerId !== activePointerId)) return;
      const canvas = scene.getEngine().getRenderingCanvas();
      if (!canvas) return;
      const bounds = canvas.getBoundingClientRect();
      const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      this.dragPointer = point;
      this.updateDragHover(point);
      this.scheduleDragAutoScroll();
    }, { capture: true, signal: this.dragPointerAbort.signal });
    const rect0 = rectOf(this.boardRoot);
    const np = lastNativePointer();
    const g0 = (np.x !== 0 || np.y !== 0)
      ? np
      : canvasToGui(scene, scene.pointerX, scene.pointerY);
    previewHost.left = pxa(Math.max(rect0.x + 10, g0.x - ts.x / 2));
    previewHost.top = pxa(Math.max(rect0.y + 10, g0.y - ts.y / 2));
    this.dragPointer = g0;
    this.updateDragHover(g0);
    this.scheduleDragAutoScroll();
  }

  private updateDragHover(g: { x: number; y: number }): void {
    const dd = this.dragData;
    if (!dd) return;
    const ts = tileSize();
    dd.previewHost.left = pxa(Math.round(g.x - ts.x / 2));
    dd.previewHost.top = pxa(Math.round(g.y - ts.y / 2));
    const handRect = rectOf(this.handPanel);
    if (g.y >= handRect.y) {
      dd.targetRow = -2;
      dd.index = -1;
    } else {
      const hit = this.rowsHit(g.x, g.y);
      const slotAt = hit && hit.rowId === -3 ? hit.index : -1;
      this.hoverSlot(slotAt);
      // Ряд «между рядами» становится целью не раньше, чем слот раскрылся.
      const slotReady = hit !== null && (hit.rowId !== -3 || this.slotActiveAt === slotAt);
      dd.targetRow = slotReady ? hit!.rowId : undefined;
      dd.index = slotReady ? hit!.index : undefined;
    }
  }

  // Наведение на слот «новый ряд»: раскрываем его с небольшой задержкой.
  // При уходе слот схлопывается сразу, поэтому быстрый пронос фишки мимо
  // середины стола не раздвигает ряды без надобности.
  private hoverSlot(at: number): void {
    if (at === this.slotActiveAt || at === this.slotPendingAt) return;
    if (this.slotTimer) {
      window.clearTimeout(this.slotTimer);
      this.slotTimer = 0;
    }
    this.slotPendingAt = -1;
    if (this.slotActiveAt !== -1) {
      this.slotActiveAt = -1;
      this.highlightSlot(-1);
    }
    if (at < 0) return;
    this.slotPendingAt = at;
    this.slotTimer = window.setTimeout(() => {
      this.slotTimer = 0;
      if (!this.dragData || this.slotPendingAt !== at) return;
      this.slotPendingAt = -1;
      this.slotActiveAt = at;
      this.highlightSlot(at);
      // Слот раскрылся под неподвижным пальцем — обновляем цель захвата.
      if (this.dragPointer) this.updateDragHover(this.dragPointer);
    }, SLOT_REVEAL_MS);
  }

  private dragEdgeIntent(): { direction: number; strength: number } | null {
    const p = this.dragPointer;
    const r = rectOf(this.rowsScroll);
    if (!p || r.w <= 0 || r.h <= 0 || p.x < r.x - 8 || p.x > r.x + r.w + 8) return null;
    const edge = Math.min(64, Math.max(16, r.h * 0.18));
    const topDistance = p.y - r.y;
    const bottomDistance = r.y + r.h - p.y;
    if (topDistance <= edge && topDistance <= bottomDistance) {
      return { direction: -1, strength: Math.max(0, Math.min(1, 1 - topDistance / edge)) };
    }
    if (bottomDistance <= edge) {
      return { direction: 1, strength: Math.max(0, Math.min(1, 1 - bottomDistance / edge)) };
    }
    return null;
  }

  private scheduleDragAutoScroll(): void {
    if (!this.dragData) return;
    if (this.dragAutoScrollRaf) return;
    this.dragAutoScrollLast = performance.now();
    const tick = (now: number): void => {
      this.dragAutoScrollRaf = 0;
      if (!this.dragData) return;
      const intent = this.dragEdgeIntent();
      if (!intent) {
        // Keep watching while the tile is held: the pointer can enter an edge
        // zone without another Babylon GUI event on touch devices.
        this.dragAutoScrollLast = now;
        this.dragAutoScrollRaf = window.requestAnimationFrame(tick);
        return;
      }
      const elapsed = Math.max(0, Math.min(40, now - this.dragAutoScrollLast));
      this.dragAutoScrollLast = now;
      const speed = 140 + 560 * intent.strength;
      const moved = scrollViewerByPixels(this.rowsScroll, 'vertical', intent.direction * speed * elapsed / 1000);
      // При неподвижном пальце фишка должна продолжать наводиться на ряд,
      // который под ней оказался после прокрутки.
      if (this.dragPointer) this.updateDragHover(this.dragPointer);
      // Не завершаем цикл на границе прокрутки: пользователь может отвести
      // стол от края, не отпуская фишку, и продолжить прокрутку.
      if (Math.abs(moved) < 0.01) {
        this.dragAutoScrollRaf = window.requestAnimationFrame(tick);
        return;
      }
      this.dragAutoScrollRaf = window.requestAnimationFrame(tick);
    };
    this.dragAutoScrollRaf = window.requestAnimationFrame(tick);
  }

  private stopDragAutoScroll(): void {
    if (this.dragAutoScrollRaf) window.cancelAnimationFrame(this.dragAutoScrollRaf);
    this.dragAutoScrollRaf = 0;
    this.dragPointer = null;
    this.dragPointerAbort?.abort();
    this.dragPointerAbort = null;
  }

  private cancelActiveDrag(): void {
    this.stopDragAutoScroll();
    const dd = this.dragData;
    if (!dd) return;
    this.dragData = null;
    this.host.getScene().onPointerObservable.remove(dd.obs);
    this.clearSlotHighlight();
    if (dd.previewHost.parent) dd.previewHost.parent.removeControl(dd.previewHost);
    const source = [...this.handFigs, ...this.rowFigs.flatMap((row) => row.figures)]
      .find((fig) => fig.face.id === dd.face.id);
    if (source) source.root.alpha = source.rgbaAlpha;
  }

  private rowsHit(pxx: number, pyy: number): { rowId: number; index: number } | null {
    // слоты «новый ряд» между рядами — проверяем первыми
    for (const sl of this.rowSlots) {
      const r = rectOf(sl.root);
      if (r.w <= 0 || r.h <= 0) continue;
      if (pyy >= r.y - 5 && pyy <= r.y + r.h + 5 && pxx >= r.x - 6 && pxx <= r.x + r.w + 6) {
        return { rowId: -3, index: sl.at };
      }
    }
    for (const fig of this.rowFigs) {
      const r = rectOf(fig.root);
      if (r.w <= 0 || r.h <= 0) continue;
      if (pyy >= r.y - 6 && pyy <= r.y + r.h + 6 && pxx >= r.x - 8 && pxx <= r.x + r.w + 8) {
        if (fig.hintZone) return { rowId: -1, index: -1 };
        const rHost = rectOf(fig.host);
        const relY = pyy - rHost.y;
        // визуальные строки ряда (ряд переносится при переполнении):
        // сначала выбираем строку по Y, затем позицию в ней по X
        const spans = new Map<number, { top: number; bottom: number; idx: number[] }>();
        fig.figures.forEach((f, i) => {
          const fr = rectOf(f.root);
          const fy0 = fr.y - rHost.y;
          const fy1 = fy0 + Math.max(fr.h, 1);
          const li = fig.lineOf[i] ?? 0;
          let s = spans.get(li);
          if (!s) { s = { top: fy0, bottom: fy1, idx: [] }; spans.set(li, s); }
          s.top = Math.min(s.top, fy0);
          s.bottom = Math.max(s.bottom, fy1);
          s.idx.push(i);
        });
        const keys = [...spans.keys()].sort((a, b) => a - b);
        let line = keys[0] ?? 0;
        for (const k of keys) {
          const s = spans.get(k);
          if (!s) continue;
          if (relY <= s.bottom + 4) { line = k; break; }
          line = k;
        }
        const idxs = spans.get(line)?.idx ?? [];
        let found = fig.figures.length;
        for (const i of idxs) {
          const fr = rectOf(fig.figures[i].root);
          if (pxx < fr.x + fr.w / 2) { found = i; break; }
          found = i + 1;
        }
        return { rowId: fig.rowId, index: found };
      }
    }
    return null;
  }

  private highlightSlot(at: number): void {
    for (const sl of this.rowSlots) {
      const active = sl.at === at;
      // раздувается только наведённый слот — «раздвинуть ряды»
      sl.root.height = px(active ? 10 : 1);
      sl.fill.color = active ? '#FFD54F99' : '#FFD54F00';
      sl.fill.background = active ? '#FFD54F26' : '#FFD54F00';
    }
  }

  private clearSlotHighlight(): void {
    if (this.slotTimer) {
      window.clearTimeout(this.slotTimer);
      this.slotTimer = 0;
    }
    this.slotPendingAt = -1;
    this.slotActiveAt = -1;
    for (const sl of this.rowSlots) {
      sl.root.height = px(1);
      sl.fill.color = '#FFD54F00';
      sl.fill.background = '#FFD54F00';
    }
  }

  private dragEnd(): void {
    const dd = this.dragData;
    this.dragData = null;
    this.stopDragAutoScroll();
    if (!dd) return;
    const previewRect = rectOf(dd.previewHost);
    if (dd.previewHost.parent) dd.previewHost.parent.removeControl(dd.previewHost);
    if (!this.state || dd.targetRow === undefined || dd.targetRow === undefined) {
      this.refresh();
      return;
    }
    const index = dd.index === undefined ? -1 : dd.index;
    const ok = this.applyDrop(dd.face.id, dd.src, dd.targetRow, index);
    if (ok && previewRect.w > 0 && previewRect.h > 0) {
      this.flightOrigins.set(dd.face.id, { face: dd.face, rect: previewRect });
    }
    // Без тоста: промежуточное состояние стола видно по красной обводке
    // невалидных рядов; объяснение — по кнопке «Продолжить»/«Взять».
    this.refresh();
    // в сети каждое перемещение — черновик остальным + повтор каждые 3 с
    if (this.onlineMode && ok && this.state && this.state.myTurn()) this.sendMyDraft();
  }

  private applyDrop(tileId: number, src: TileSrc, targetRow: number, index: number): boolean {    if (!this.state) return false;
    if (targetRow === -2) {
      if (src.kind === 'row') return this.state.takeBackToHand(src.rowId, tileId);
      return false;
    }
    if (targetRow === -3) {
      // слот «новый ряд» между рядами: создаём ряд на позиции index
      const row = this.state.addRowAt(index);
      if (src.kind === 'row') return this.state.moveTile(src.rowId, tileId, row.id, 0);
      return this.state.placeFromHand(tileId, row.id, 0);
    }
    if (targetRow === -1) {
      // зона «новый ряд»: и из руки, и переносом из другого ряда
      const row = this.state.addRow();
      if (src.kind === 'row') return this.state.moveTile(src.rowId, tileId, row.id, 0);
      return this.state.placeFromHand(tileId, row.id, 0);
    }
    if (src.kind === 'row') {
      return this.state.moveTile(src.rowId, tileId, targetRow, Math.max(0, index));
    }
    if (this.state.rowById(targetRow) !== null) {
      return this.state.placeFromHand(tileId, targetRow, Math.max(0, index));
    }
    return false;
  }

  // === Ход бота с анимацией ===
  private runBotTurn(): void {
    if (!this.running || !this.state || this.state.finished) return;
    this.flashTurnTitle(this.turnTitleText());
    window.setTimeout(() => {
      if (!this.running || !this.state || this.state.finished) return;
      // Читаем настройку непосредственно перед ходом: переключение анимации
      // во время паузы «бот думает» должно примениться к этому ходу.
      const anim = loadSettings().bot_anim;
      const plan = this.planner.plan(this.state, LEVEL_IMPOSSIBLE);
      this.playPlan(plan.ops, plan.action, plan.tiles, anim);
    }, BOT_THINK_MS);
  }

  private playPlan(ops: any[], action: string, tiles: number[], stepwise: boolean): void {
    if (!this.state) return;
    void tiles;
    if (action === 'draw') {
      const deckRect = rectOf(this.deckBtn);
      const drawSeat = this.state.current;
      const drawn = this.state.drawFromDeck();
      if (drawn.tile) this.noteDraw(drawSeat, drawn.tile.id);
      if (drawn.tile && deckRect.w > 0 && deckRect.h > 0) {
        const ts = tileSize();
        this.flightOrigins.set(drawn.tile.id, {
          face: drawn.tile,
          rect: {
            x: deckRect.x + deckRect.w / 2 - ts.x / 2,
            y: deckRect.y + deckRect.h / 2 - ts.y / 2,
            w: ts.x,
            h: ts.y,
          },
        });
      }
      // drawFromDeck сам вызывает advance(), поэтому endTurn здесь дал бы
      // боту лишний ход и перескочил бы ещё одного игрока.
      setTimeout(() => {
        if (!this.running) return;
        this.refresh();
        this.checkPassOrBot();
      }, BOT_MIN_WAIT_MS);
      return;
    }
    if (action === 'skip') {
      this.state.skipTurn();
      setTimeout(() => {
        if (!this.running) return;
        this.refresh();
        this.checkPassOrBot();
      }, BOT_MIN_WAIT_MS);
      return;
    }
    if (action === 'place' && ops.length > 0) {
      // Godot: _bot_place_stepwise — операции применяются ПО ОДНОЙ (с
      // общей картой созданных рядов), с паузой между шагами. Если шаг
      // не прошёл — возврат к снимку хода и завершение хода фолбэком.
      const seq = [...ops];
      const apply = this.state.createOpsLooper();
      let lastPlacedTile = -1;
      const fail = (): void => {
        if (this.running && this.state) this.state.restoreTurnSnapshot();
        this.cancelBotTableScroll();
        setTimeout(() => this.botEndTurn(), BOT_MIN_WAIT_MS);
      };
      const step = (): void => {
        if (!this.running || !this.state) return;
        if (seq.length === 0) {
          // Финал выкладки: отменяем отложенный троттл и доезжаем до
          // последней изменённой фишки, только затем заканчиваем ход.
          this.cancelBotTableScroll();
          const rowId = this.rowIdOfTile(lastPlacedTile);
          void this.scrollTableToRow(rowId, this.presentGen).then(() => {
            if (this.running) setTimeout(() => this.botEndTurn(), BOT_MIN_WAIT_MS);
          });
          return;
        }
        const op = seq.shift()!;
        this.queueBotTileFlight(op);
        if (!apply(op)) {
          fail();
          return;
        }
        lastPlacedTile = Number(op.tile ?? -1);
        this.refresh();
        // Первое изменение поля подхватываем сразу, дальше — по троттлу,
        // чтобы анимация выкладки не перезапускалась на каждом шаге.
        this.queueBotTableScroll(this.rowIdOfTile(lastPlacedTile), this.presentGen);
        if (stepwise && seq.length > 0) window.setTimeout(step, BOT_STEP_MS);
        else step();
      };
      step();
      return;
    }
    setTimeout(() => this.botEndTurn(), BOT_MIN_WAIT_MS);
  }

  private botEndTurn(): void {
    if (!this.state || !this.running || this.state.finished) return;
    const res = this.state.endTurn();
    if (res.win) {
      this.recordResult();
      this.showWin();
      return;
    }
    // endTurn может не пройти (невалидный стол) — бот не может застрять
    // на своём ходе: добираем из колоды либо пропускаем, затем пробуем
    // пройти дальше.
    if (!res.ok) {
      const drawSeat = this.state.current;
      if (this.state.deck.count() > 0) {
        const fb = this.state.drawFromDeck();
        if (fb.tile) this.noteDraw(drawSeat, fb.tile.id);
      } else this.state.skipTurn();
    }
    this.refresh();
    this.checkPassOrBot();
  }

  private queueBotTileFlight(op: { op?: unknown; tile?: unknown }): void {
    if (!this.state || String(op.op ?? '') !== 'place') return;
    const tileId = Number(op.tile ?? -1);
    const face = this.state.hand().find((tile) => tile.id === tileId);
    const chip = this.chipsRow.children[this.state.current] ?? null;
    const chipRect = rectOf(chip);
    if (!face || chipRect.w <= 0 || chipRect.h <= 0) return;
    const ts = tileSize();
    this.flightOrigins.set(tileId, {
      face,
      rect: {
        x: chipRect.x + chipRect.w / 2 - ts.x / 2,
        y: chipRect.y + chipRect.h / 2 - ts.y / 2,
        w: ts.x,
        h: ts.y,
      },
    });
  }
}

function preschoolGap(ts: { x: number }): number {
  return Math.max(3, Math.min(8, Math.round(ts.x * 0.1)));
}

function pxa(n: number): string {
  return `${n}px`;
}

// Пересчёт координат указателя в координаты GUI-слоя. scene.pointerX/Y
// дают буферные пиксели (с учётом DPR), а ADT живёт в CSS-пикселях —
// без пересчёта превью уезжает вправо-вниз на экранах с DPR > 1.
function canvasToGui(scene: Scene, x: number, y: number): { x: number; y: number } {
  const eng = scene.getEngine();
  const cv = eng.getRenderingCanvas() as HTMLCanvasElement | null;
  const cw = cv ? Math.max(1, cv.clientWidth) : 1;
  const ch = cv ? Math.max(1, cv.clientHeight) : 1;
  return {
    x: x * (cw / Math.max(1, eng.getRenderWidth())),
    y: y * (ch / Math.max(1, eng.getRenderHeight())),
  };
}

function guiPointer(scene: Scene, pi: import('@babylonjs/core').PointerInfo): { x: number; y: number } {
  const ev = pi.event as { clientX?: number; clientY?: number } | undefined;
  if (ev && typeof ev.clientX === 'number' && typeof ev.clientY === 'number') {
    const cv = scene.getEngine().getRenderingCanvas() as HTMLCanvasElement | null;
    if (cv) {
      const r = cv.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }
  }
  return canvasToGui(scene, scene.pointerX, scene.pointerY);
}

// Babylon обновляет scene.pointerX/Y на pointermove, а не на pointerdown:
// в момент захвата фишки превью ставилось в точку ПРОШЛОГО движения мыши
// (справа-снизу). Держим свежие CSS-координаты из нативных событий в
// фазе захвата — до того, как обработчик Babylon начнёт drag.
const nativePointer: { x: number; y: number; pointerId: number | null } = { x: 0, y: 0, pointerId: null };
if (typeof window !== 'undefined') {
  const update = (e: PointerEvent): void => {
    try {
      const app = (window as unknown as { __app?: { canvas?: HTMLCanvasElement } }).__app;
      const cv = app?.canvas;
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      nativePointer.x = e.clientX - r.left;
      nativePointer.y = e.clientY - r.top;
      if (e.type === 'pointerdown') nativePointer.pointerId = e.pointerId;
      else if ((e.type === 'pointerup' || e.type === 'pointercancel') && nativePointer.pointerId === e.pointerId) {
        nativePointer.pointerId = null;
      }
    } catch {
      // экран ещё не построен — ignore
    }
  };
  window.addEventListener('pointermove', update, true);
  window.addEventListener('pointerdown', update, true);
}
function lastNativePointer(): { x: number; y: number } {
  return nativePointer;
}

function setDeckLabel(btn: Button, s: string): void {
  const tb = btn.children.find((c) => c instanceof TextBlock) as TextBlock | undefined;
  if (tb) tb.text = s;
}

function rectOf(c: Control | null): { x: number; y: number; w: number; h: number } {
  try {
    const m = (c as unknown as { _currentMeasure?: { left: number; top: number; width: number; height: number } })._currentMeasure;
    if (m && Number.isFinite(m.left) && Number.isFinite(m.top)) {
      return { x: m.left, y: m.top, w: m.width, h: m.height };
    }
  } catch {
    // нет измерения
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}
