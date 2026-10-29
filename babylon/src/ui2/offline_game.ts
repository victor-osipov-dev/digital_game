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
import { fs, loadSettings, recordGame, tileSize } from '../core/settings';
import { GameState, GsRow } from '../core/game_state';
import { LEVEL_IMPOSSIBLE, TurnPlanner } from '../core/turn_planner';
import { sortTiles, TileFace } from '../core/tile';
import { validateRow } from '../core/rules';
import { tileById } from '../core/deck';
import { layoutFlow, FlowItem } from './flow';
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
  SKIN,
  softPanel,
  px,
} from './uiskin';
import { openRulesOverlay, openSettingsOverlay } from './overlays';
import { measureTextWidth } from './menu_screen';
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
}

const DROP_MS = 350;
const BOT_THINK_MS = 1500;
const BOT_STEP_MS = 550;
const BOT_MIN_WAIT_MS = 1400;
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
    | { kind: 'steps'; seat: number; ids: number[] }
  > = [];
  private presentBusy = false;
  private presentGen = 0;
  private shownSeat = -1;
  private flightActive = false;
  private refreshPending = false;
  private titlePendingSeat = -1;
  private titleShownFor = -1;
  private pendingSteps: { ids: number[]; seat: number }[] = [];
  private lastWaitEnv: GameEnvelope | null = null;
  // статистика сетевой партии — один раз на партию
  private onlineStatsDone = false;
  // wait-панель (paused/waiting/grace)
  private waitHost: Container | null = null;
  private waitLab: TextBlock | null = null;
  private graceTick: ReturnType<typeof setInterval> | null = null;

  private topRow!: StackPanel;
  private deckBtn!: Button;
  private saveBtn!: Button;
  private hintBtn!: Button;
  private timerLab!: TextBlock;
  private allTopActionButtons: Button[] = [];
  private hiddenTopActionNames: string[] = [];
  private chipsRow!: StackPanel;
  private rowsScroll!: ScrollViewer;
  private rowsInner!: StackPanel;
  private handPanel!: Container;
  private handHost!: StackPanel;
  private handScroll!: ScrollViewer;
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
  private hintTimer = 0;
  private hintsUsed = new Set<number>();
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
    this.topRow.paddingRight = px(SIDE_PAD);
    col.addControl(this.topRow);

    this.deckBtn = mkButton(t('Колода: %d', 0), {
      height: 46, width: 108, fontSize: fs(15), theme: BUTTON_STYLE.deck,
    });
    this.deckBtn.onPointerUpObservable.clear();
    this.deckBtn.onPointerUpObservable.add(() => this.onDeckButton());
    this.topRow.addControl(this.deckBtn);

    // таймер хода (только сетевая партия)
    this.timerLab = mkLabel(' ', { fontSize: fs(14), color: SKIN.gold, width: 130, height: 46, noWrap: true });
    this.topRow.addControl(this.timerLab);

    const actions = new StackPanel('topActions');
    actions.isVertical = false;
    actions.height = px(46);
    actions.spacing = 6;
    actions.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    actions.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    this.topRow.addControl(actions);

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
    const help = mkTop('?', () => this.showRulesOverlay());
    const settings = mkTop(t('Настр.'), () => this.showSettingsOverlay());
    const menu = mkTop(t('Меню'), () => {
      if (this.onlineMode) {
        // сетевая партия: подтверждение выхода из комнаты в лобби
        this.askConfirm(t('Выход в лобби'), t('Выйти из комнаты в лобби?'), t('Выйти'), () => this.leaveToLobby());
        return;
      }
      this.askConfirm(t('Выход в меню'), t('Выйти в главное меню?'), t('Выйти'), () => {
        this.running = false;
        this.host.toMenu();
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
  private syncTopBar(): void {
    const vw = window.innerWidth;
    const actions = this.topRow.children.find((c) => c.name === 'topActions') as StackPanel;
    if (!actions) return;
    const sep = 6;
    const widthOf = (b: Control): number => (b as Button).widthInPixels || 60;
    const fits = (list: Control[], burger: boolean): boolean => {
      const actionWidth = list.reduce((acc, b) => acc + widthOf(b), 0)
        + Math.max(0, list.length - 1) * sep
        + (burger ? 60 + (list.length ? sep : 0) : 0);
      const timerW = 130;
      const need = actionWidth + widthOf(this.deckBtn) + timerW + 2 * sep;
      return need <= vw - SIDE_PAD * 2;
    };
    let shown = [...this.allTopActionButtons];
    let hasBurger = false;
    while (shown.length > 0 && !fits(shown, hasBurger)) {
      shown.pop();
      hasBurger = true;
    }
    this.hiddenTopActionNames = this.allTopActionButtons
      .filter((b) => !shown.includes(b))
      .map((b) => b.name ?? '');
    let list: Control[] = shown;
    if (hasBurger) {
      const burger = mkButton('...', {
        height: 46, width: 60, fontSize: fs(15), corner: 10,
        theme: { bg: '#26303F', hover: '#46566D', press: '#1E2733', border: '#ffffff22' },
      });
      burger.onPointerUpObservable.clear();
      burger.onPointerUpObservable.add(() => this.openBurger());
      list = [...shown, burger];
    }
    actions.clearControls();
    for (const c of list) actions.addControl(c);
    actions.width = px(list.reduce((acc, b) => acc + widthOf(b), 0) + Math.max(0, list.length - 1) * sep);
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
    this.popups.clearControls();
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
    const titleWidth = Math.max(180, window.innerWidth - 48);
    const desiredSize = fs(56);
    const naturalWidth = Math.max(1, measureTextWidth(text, desiredSize));
    const titleSize = Math.max(fs(24), Math.min(desiredSize, Math.floor(desiredSize * titleWidth / naturalWidth)));
    const lab = mkLabel(text, {
      fontSize: titleSize,
      color: SKIN.gold,
      width: titleWidth,
      height: Math.ceil(titleSize * 1.55),
      noWrap: true,
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
    scroll.thickness = 0;
    scroll.width = '100%';
    scroll.height = px(50);
    scroll.paddingLeft = px(SIDE_PAD);
    scroll.paddingRight = px(SIDE_PAD);
    enableSmoothScroll(scroll, 'horizontal');
    col.addControl(scroll);
    const box = new StackPanel('chips');
    box.isVertical = false;
    box.spacing = 6;
    box.adaptWidthToChildren = true;
    box.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    scroll.addControl(box);
    this.chipsRow = box;
  }

  // Высоты в px (сверены с фактическими мерами StackPanel): стол —
  // весь остаток экрана, поэтому низ прижат к нижнему краю.
  private tableHeightPx(): number {
    const vh = window.innerHeight;
    const ts = tileSize();
    return Math.max(120, Math.floor(vh - TOP_PAD - 46 - 50 - (ts.y + 26) - 6 - 58));
  }

  private buildTable(col: StackPanel): void {
    this.rowsScroll = new ScrollViewer('tableScroll');
    this.rowsScroll.thickness = 0;
    this.rowsScroll.width = '100%';
    this.rowsScroll.height = px(this.tableHeightPx());
    this.rowsScroll.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    enableSmoothScroll(this.rowsScroll, 'vertical', { tileDragAllowed: () => this.canInteract() });
    col.addControl(this.rowsScroll);
    const innerHolder = new StackPanel('innerHolder');
    innerHolder.isVertical = true;
    innerHolder.spacing = 6;
    // бейджи-«галочки» выходят за карточку — не режем их рядами
    innerHolder.clipChildren = false;
    innerHolder.paddingLeft = px(SIDE_PAD);
    innerHolder.paddingRight = px(SIDE_PAD);
    innerHolder.paddingTop = px(8);
    innerHolder.paddingBottom = px(8);
    this.rowsScroll.addControl(innerHolder);
    this.rowsInner = innerHolder;
  }

  private buildHandArea(col: StackPanel): void {
    const ts = tileSize();
    this.handPanel = softPanel({
      bg: '#1A5C38',
      bgAlpha: 0.72,
      border: '#7ADB8CD9',
      thickness: 2,
      corner: 12,
      height: ts.y + 26,
    }).root;
    this.handPanel.width = px(Math.max(180, window.innerWidth - SIDE_PAD * 2));
    this.handPanel.clipChildren = false;
    this.handPanel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    col.addControl(this.handPanel);
    this.handScroll = new ScrollViewer('handScroll');
    this.handScroll.thickness = 0;
    this.handScroll.width = '100%';
    // Выше фишки на запас под бейдж-«галочку» в правом верхнем углу.
    this.handScroll.height = px(ts.y + 20);
    this.handScroll.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.handScroll.barSize = 2;
    enableSmoothScroll(this.handScroll, 'horizontal', { tileDragAllowed: () => this.canInteract() });
    this.handPanel.addControl(this.handScroll);
    this.handHost = new StackPanel('handHost');
    this.handHost.isVertical = false;
    this.handHost.spacing = 6;
    this.handHost.clipChildren = false;
    this.handHost.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    // фишка не прилипает к левому краю зелёного поля (padding у
    // ScrollViewer не смещает контент — только у панели детей)
    this.handHost.paddingLeft = px(10);
    this.handHost.paddingRight = px(6);
    this.handScroll.addControl(this.handHost);
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
    const bw = Math.max(80, Math.floor((window.innerWidth - 20 - 10) / 2));
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
    toastHost.width = px(Math.min(window.innerWidth - 40, 480));
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
      if (this.hintTimer) window.clearTimeout(this.hintTimer);
      this.hintTimer = 0;
      if (this.toastHost) this.toastHost.isVisible = false;
    });
    this.boardRoot.addControl(toastHost);
    this.toastHost = toastHost;
  }

  startGame(state: GameState): void {
    this.state = state;
    this.running = true;
    this.clearDraftPresentation();
    this.hintsUsed.clear();
    this.onlineStatsDone = false;
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
  }

  // ===== сетевая партия =====

  // GAME_STATE/DRAFT приходят из wireApi; все локальные правки — превью,
  // сервер подтверждает их (commit) либо отклоняет (GAME_ERROR).
  applyOnlineView(env: GameEnvelope): void {
    this.onlineMode = true;
    const view = env.state;
    const continuing = this.running && !!this.state && !this.state.finished
      && this.roomCode === view.code;
    const prev = continuing ? this.state : null;
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
    const nSeats = view.players.length || 1;
    const curSeat = Math.min(Math.max(view.current, 0), nSeats - 1);
    if (prev && prev.current !== curSeat) this.lastDraftPayload = '';
    // Черновик живёт только до окончания хода автора. Как только сервер
    // передал ход дальше (commit/draw/skip), прозрачность и бейджи draft
    // снимаются немедленно; committed tiles остаются зелёными через
    // lastTurnTileIds до следующего перехода хода.
    if (this.draftFrom >= 0 && (view.finished || curSeat !== this.draftFrom)) {
      this.clearDraftPresentation();
    }
    const moverSeat = (view.lastTurn ?? []).length === 0
      ? curSeat
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
        if (!view.finished && freshIds.length > 0 && moverSeat !== view.you) {
          this.pendingSteps.push({ ids: freshIds, seat: moverSeat });
        }
        this.titlePendingSeat = view.current;
      } else {
        this.refresh();
        if (!view.finished && freshIds.length > 0 && moverSeat !== view.you) {
          this.enqueueSteps(freshIds, moverSeat);
        }
        this.enqueueTurnTitle();
      }
      this.applyWaitState(env);
    }
    this.sending = false;
    this.lastConfirmedTable = view.table.map((r) => ({ id: r.id, tiles: [...r.tileIds] }));
    // локальная статистика сетевой партии: won = победил наш seat
    // (game.gd:2313-2325), один раз за партию
    if (view.finished && !this.onlineStatsDone) {
      this.onlineStatsDone = true;
      const won = view.winner === view.you;
      recordGame(won, !won);
    }
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

  private enqueueSteps(ids: number[], seat: number): void {
    if (ids.length === 0) return;
    this.presentQueue.push({ kind: 'steps', seat, ids: [...ids] });
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
      const seg = this.presentQueue.shift()!;
      if (seg.kind === 'title') {
        if (this.titleFresh(seg.seat)) {
          this.showSeat(seg.seat);
          this.flashTurnTitle(seg.text);
          await new Promise<void>((r) => window.setTimeout(r, 1450));
        }
      } else {
        this.showSeat(seg.seat);
        this.flightActive = true;
        await this.playQueuedSteps(seg.ids, gen, seg.seat);
        this.flightActive = false;
        if (gen !== this.presentGen) return;
        // пересборка/титр, заказанные посреди полёта
        if (this.refreshPending) {
          this.refreshPending = false;
          this.refresh();
        }
        const pending = this.pendingSteps.splice(0);
        for (const p of pending) this.enqueueSteps(p.ids, p.seat);
        if (this.titlePendingSeat >= 0) {
          const s = this.titlePendingSeat;
          this.titlePendingSeat = -1;
          this.appendTurnTitle(s);
        }
      }
    }
    if (gen === this.presentGen) {
      this.presentQueue = [];
      this.presentBusy = false;
      this.showSeat(-1);
    }
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

  private chipSpawnRect(seat: number, ts: { x: number; y: number }): { x: number; y: number } {
    const chip = seat >= 0 ? this.chipsRow.children[seat] ?? null : null;
    const r = chip ? rectOf(chip) : { x: 0, y: 0, w: 0, h: 0 };
    if (r.w > 1 && r.h > 1) return { x: r.x + r.w / 2 - ts.x / 2, y: r.y + r.h / 2 - ts.y / 2 };
    return { x: window.innerWidth - 40, y: -60 };
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
    this.draftNewIds = new Set<number>();
    // фишки, которых нет в подтверждённом столе, — «черновые»
    const confirmed = new Set<number>();
    for (const r of this.lastConfirmedTable) for (const id of r.tiles) confirmed.add(id);
    for (const r of msg.rows) for (const id of r.tiles) if (!confirmed.has(id)) this.draftNewIds.add(id);
    this.applyServerRows(msg.rows);
    this.refresh();
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
      this.timerLab.text = '';
      return;
    }
    // «Ваш ход — N с» / «Ход: X — N с» (game.gd:1994-2014)
    const curName = this.state ? this.state.playerName(currentSeat) : '';
    let left = Math.max(0, seconds);
    const render = (): void => {
      const sec = Math.max(1, left); // «0 с» не показываем
      this.timerLab.text = mine
        ? t('Ваш ход — %d с', sec)
        : t('Ход: %s — %d с', curName, sec);
      this.timerLab.width = px(Math.min(150, Math.ceil(measureTextWidth(this.timerLab.text, fs(14))) + 10));
      this.timerLab.color = left <= 10 ? SKIN.flag : SKIN.gold;
    };
    render();
    this.onlineTimer = setInterval(() => {
      left -= 1;
      if (left <= 0 && this.onlineTimer) {
        clearInterval(this.onlineTimer);
        this.onlineTimer = null;
      }
      render();
    }, 1000);
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
    if (this.waitHost && this.waitLab) {
      this.waitLab.text = text;
      return;
    }
    const host = new Container('wait');
    host.width = px(Math.min(window.innerWidth - 24, 460));
    host.height = px(44);
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
    const lab = mkLabel(text, { fontSize: fs(15), color: '#FFFFFF', noWrap: false, height: 40 });
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
    this.stopRejoinLoop();
    this.stopDraftResend();
    this.stopGraceCountdown();
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
    const col = new StackPanel('passCol');
    col.isVertical = true;
    col.spacing = 16;
    col.width = '70%';
    col.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    col.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    overlay.addControl(col);
    col.addControl(mkLabel(title, { fontSize: fs(18), color: '#ffffffCC' }));
    col.addControl(mkLabel(name, { fontSize: fs(30), color: SKIN.gold }));
    col.addControl(gapControl(24));
    const go = mkButton(t('Готов(-а)'), { height: 56, width: 220, fontSize: fs(20), theme: BUTTON_STYLE.green });
    go.onPointerUpObservable.clear();
    go.onPointerUpObservable.add(() => {
      close();
      onReady();
    });
    col.addControl(go);
  }

  private clearOverlays(): void {
    // Удаляем все модальные слои (пас/победа/меню) — после хода.
    while (this.popups.children.length > 0) this.popups.removeControl(this.popups.children[0]);
  }

  private clearPass(): void {
    // Пас-оверлеи удаляются точечно: победный — остаётся до клика.
    // Простая политика: удаляем только не-победные слои.
    this.clearTransientOverlays();
  }

  private clearTransientOverlays(): void {
    const doomed = this.popups.children.filter((c) => c.name === 'pass' || c.name === 'burger');
    for (const d of doomed) this.popups.removeControl(d);
  }

  showWin(): void {
    this.clearOverlays();
    this.running = false;
    this.stopTimers();
    const { overlay } = modalOverlay(this.popups, 'win', { alpha: 0.9, zIndex: 850 });
    const col = new StackPanel('wincol');
    col.isVertical = true;
    col.spacing = 20;
    col.width = '80%';
    col.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    col.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    overlay.addControl(col);
    const winnerName = this.state && this.state.winner >= 0 ? this.state.playerName(this.state.winner) : '—';
    col.addControl(mkLabel(t('Победил %s', winnerName), { fontSize: fs(28), color: SKIN.gold }));
    col.addControl(gapControl(10));
    // «Посмотреть стол»: закрыть оверлей и оставить финальный расклад
    // с плавающей кнопкой «Результат» (game.gd:2226-2237, 2268-2292)
    const peek = mkButton(t('Посмотреть стол'), { height: 44, width: 220, fontSize: fs(15), theme: BUTTON_STYLE.deck });
    peek.onPointerUpObservable.clear();
    peek.onPointerUpObservable.add(() => {
      this.clearOverlays();
      this.showResultChip();
    });
    col.addControl(peek);
    if (this.onlineMode) {
      // сетевая партия: покинуть комнату (место освобождается) и в лобби
      const back = mkButton(t('К лобби'), { height: 54, width: 200, fontSize: fs(18), theme: BUTTON_STYLE.green });
      back.onPointerUpObservable.clear();
      back.onPointerUpObservable.add(() => this.leaveToLobby());
      col.addControl(back);
      return;
    }
    const again = mkButton(t('Заново'), { height: 54, width: 200, fontSize: fs(18), theme: BUTTON_STYLE.green });
    again.onPointerUpObservable.clear();
    again.onPointerUpObservable.add(() => this.host.replay());
    col.addControl(again);
    const back = mkButton(t('В меню'), { height: 46, width: 200, fontSize: fs(16), theme: BUTTON_STYLE.blueOnline });
    back.onPointerUpObservable.clear();
    back.onPointerUpObservable.add(() => this.host.toMenu());
    col.addControl(back);
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
    // Бейджи переезжают от прежних фишек к новым: пересборка не должна
    // гасить «галочки» ни на кадр (иначе ряд мигает при каждой выкладке).
    this.inheritFigs = new Map<number, TileFigure>();
    for (const r of this.rowFigs) for (const f of r.figures) this.inheritFigs.set(f.face.id, f);
    for (const f of this.handFigs) this.inheritFigs.set(f.face.id, f);
    this.rebuildRows(ts);
    this.rebuildHand(ts);
    this.inheritFigs = null;
    this.updateActionRow();
    // в сети чужие ходы показывает очередь презентаций, а не общий
    // дифф: иначе фишки летели бы дважды
    if (!this.onlineMode || this.state.myTurn()) this.animateTileTransitions(before);
  }

  private captureTileSnapshots(): Map<number, TileSnapshot> {
    const snapshots = new Map<number, TileSnapshot>();
    const slots = this.tileSlotKeys();
    const collect = (f: TileFigure): void => {
      const rect = rectOf(f.root);
      if (rect.w > 0 && rect.h > 0) {
        snapshots.set(f.face.id, { face: f.face, rect, slot: slots.get(f.face.id) });
      }
    };
    for (const row of this.rowFigs) for (const f of row.figures) collect(f);
    for (const f of this.handFigs) collect(f);
    return snapshots;
  }

  // Слот визуального layout. Сравнение до/после позволяет ещё ДО кадра
  // Babylon спрятать только действительно перемещаемые фишки, не моргая
  // неизменившимися рядами и рукой.
  private tileSlotKeys(): Map<number, string> {
    const slots = new Map<number, string>();
    const rows = this.rowFigs.filter((r) => !r.hintZone);
    let prefixHeights = '';
    for (let ri = 0; ri < rows.length; ri += 1) {
      const row = rows[ri];
      const height = String(row.root.height);
      for (let i = 0; i < row.figures.length; i += 1) {
        slots.set(row.figures[i].face.id,
          `row:${ri}:${prefixHeights}:${row.rowId}:${i}:${row.lineOf[i] ?? 0}`);
      }
      prefixHeights += `${height};`;
    }
    for (let i = 0; i < this.handFigs.length; i += 1) {
      slots.set(this.handFigs[i].face.id, `hand:${i}`);
    }
    return slots;
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
    const pending: { source: TileSnapshot; target: TileFigure; ghost: TileFigure; fade: boolean }[] = [];

    // Сначала определяем только реально сдвинувшиеся слоты и прячем их
    // синхронно с refresh. Иначе Babylon успевал один кадр показать новые
    // координаты, после чего плитки дёргались обратно к точке старта.
    for (const [id, target] of figures) {
      const origin = origins.get(id);
      const previous = before.get(id);
      if (!origin && (!previous || previous.slot === slots.get(id))) continue;
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
    };
    window.requestAnimationFrame(step);
  }

  private createFlightGhost(source: TileSnapshot, target: TileFigure): TileFigure {
    // Копируем все метки, включая draft: иначе зелёная рамка пропадает
    // во время полёта. Бейдж живёт в отдельном слое над flightLayer.
    const ghost = new TileFigure(
      source.face,
      false,
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
      this.handPanel.width = px(Math.max(180, window.innerWidth - SIDE_PAD * 2));
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
      chip.height = px(34);
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
        width: chipWidth - 20, height: 34, hAlign: 'left', noWrap: true,
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
    const vw = window.innerWidth;
    const innerW = Math.max(180, vw - SIDE_PAD * 2);
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
    // Слот невидим и схлопнут, пока фишка не наведена между рядами:
    // постоянного большого зазора между рядами нет. При наведении слот
    // раздувается до 12px (highlightSlot) и подсвечивается.
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
    hostC.height = px(ts.y + 16);
    const block = softPanel({ bg: '#2E7D3222', border: '#2E7D3280', thickness: 2, corner: 10 });
    block.root.width = '100%';
    block.root.height = '100%';
    hostC.addControl(block.root);
    const lab = mkLabel(t('Перетащите сюда число — новый ряд'), {
      fontSize: fs(13), color: '#9CD6A5', width: innerW - 24,
      height: Math.ceil(fs(13) * 2.6),
    });
    hostC.addControl(lab);
    return { rowId: -1, root: hostC, fill: block.fill, host: hostC, figures: [], items: [], lineOf: [], hintZone: true };
  }

  private rebuildHand(ts: { x: number; y: number }): void {
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
    void ts;
    for (let i = 0; i < hand.length; i += 1) {
      const face = hand[i];
      const f = new TileFigure(face, false, drawnTileId === face.id ? { drawn: true } : {}, ts, this.badgeLayer, false, this.inheritFigs?.get(face.id) ?? null);
      this.wireDrag(f, { kind: 'hand', rowId: -1, index: i });
      this.handFigs.push(f);
      this.handHost.addControl(f.root);
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
    // «Вернуть» — восстановление сохранённого чекпоинта.
    this.setBtnEnabled(this.undoBtn, !locked && placed);
    this.setBtnEnabled(this.saveBtn, !locked && placed);
    this.setBtnEnabled(this.restoreBtn, !locked && this.state.checkpoints.length > 0);
    this.setBtnEnabled(this.hintBtn, !locked && !this.hintsUsed.has(this.state.current));
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
    // Godot: одна подсказка на игрока за партию (_hints_used).
    if (this.hintsUsed.has(this.state.current)) {
      this.toast(t('Подсказка уже была использована'));
      return;
    }
    const plan = this.planner.plan(this.state, LEVEL_IMPOSSIBLE);
    if (plan.action === 'draw') {
      this.toast(t('Подсказка: возьмите из колоды'));
      return;
    }
    if (plan.action === 'place' && plan.tiles.length > 0) {
      const planned = new Set<number>(plan.tiles);
      const handSeat = this.onlineMode ? this.state.local_seat : this.state.current;
      const drawnId = this.drawMarks.get(handSeat) ?? -1;
      for (const f of this.handFigs) {
        if (planned.has(f.face.id)) {
          // метки пересчитываются целиком, как refresh_marks в оригинале:
          // иначе подсказка стёрла бы галочку взятой фишки
          f.refreshMarks({ hint: true, drawn: f.face.id === drawnId });
        }
      }
      this.hintsUsed.add(this.state.current);
      this.toast(t('Подсказка: выложите %d чисел', plan.tiles.length));
      if (this.hintTimer) window.clearTimeout(this.hintTimer);
      this.hintTimer = window.setTimeout(() => {
        this.hintTimer = 0;
        this.refresh();
      }, 2600);
    }
  }

  // Бургер: столбик скрытых действий у правого края, тап мимо закрывает.
  private openBurger(): void {
    const wasOpen = this.popups.children.some((c) => c.name === 'burger');
    this.clearTransientOverlays();
    if (wasOpen) return;
    const catcher = new Container('burgerCatcher');
    catcher.width = '100%';
    catcher.height = '100%';
    catcher.isPointerBlocker = true;
    catcher.zIndex = 690;
    catcher.onPointerUpObservable.add(() => this.clearTransientOverlays());
    this.popups.addControl(catcher);
    const panel = new StackPanel('burger');
    panel.isVertical = true;
    panel.spacing = 8;
    panel.width = px(150);
    panel.paddingLeft = px(8);
    panel.paddingRight = px(8);
    panel.paddingTop = px(8);
    panel.paddingBottom = px(8);
    panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    panel.zIndex = 700;
    const mk = (label: string, onClick: () => void, theme = BUTTON_STYLE.deck) => {
      const b = mkButton(label, { height: 48, fontSize: fs(15), theme });
      b.onPointerUpObservable.clear();
      b.onPointerUpObservable.add(() => {
        this.clearTransientOverlays();
        onClick();
      });
      panel.addControl(b);
    };
    if (this.hiddenTopActionNames.includes('topSave')) mk(t('Сохр.'), () => this.onSaveCheckpoint());
    if (this.hiddenTopActionNames.includes('topRestore')) mk(t('Вернуть'), () => this.onRestoreCheckpoint());
    if (this.hiddenTopActionNames.includes('topHint')) mk(t('Подск.'), () => this.onHint());
    if (this.hiddenTopActionNames.includes('topHelp')) mk(t('Правила'), () => this.showRulesOverlay());
    if (this.hiddenTopActionNames.includes('topSettings')) mk(t('Настр.'), () => this.showSettingsOverlay());
    if (this.hiddenTopActionNames.includes('topMenu')) mk(t('Меню'), () => {
      if (this.onlineMode) {
        this.askConfirm(t('Выход в лобби'), t('Выйти из комнаты в лобби?'), t('Выйти'), () => this.leaveToLobby());
        return;
      }
      this.askConfirm(t('Выход в меню'), t('Выйти в главное меню?'), t('Выйти'), () => {
        this.running = false;
        this.host.toMenu();
      });
    }, BUTTON_STYLE.blueOnline);
    this.popups.addControl(panel);
  }

  private showRulesOverlay(): void {
    openRulesOverlay(this.popups, () => {});
  }

  // Сетевая партия: покинуть комнату и вернуться в лобби сетевого меню.
  // После конца партии место освобождается сразу (game.gd:687-701:
  // finished → drop_room, иначе leave_room).
  private leaveToLobby(): void {
    this.running = false;
    this.stopTimers();
    const api = this.host.gameApi();
    try {
      if (this.state && this.state.finished) void api.dropRoom();
      else void api.leaveRoom();
    } catch {
      /* комната может уже не существовать */
    }
    this.host.toLobby();
  }

  private showSettingsOverlay(): void {
    openSettingsOverlay(this.popups, this.ctx, () => this.host.rebuildScreen(), this.host.rebuildScreen);
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

  // Godot _record_stats: won = не бот-победитель; запись один раз за
  // партию, независимо от того, чей ход завершился. В сети статистику
  // ведёт сервер — локально не пишем.
  private recordResult(): void {
    if (this.onlineMode) return;
    if (!this.state) return;
    const winner = this.state.winner;
    const botWon = winner !== undefined && !!this.state.players[winner]?.is_bot;
    recordGame(!botWon, botWon);
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
    if (!s) {
      this.toastHost.isVisible = false;
      return;
    }
    // высота под фактическое число строк (перенос длинных сообщений)
    const size = fs(18);
    const lineH = estimateWrappedTextHeight(s, Math.min(window.innerWidth - 64, 456), size);
    const h = Math.max(52, lineH + 20);
    this.toastHost.height = px(h);
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
    if (!this.popups || !this.running) return;
    this.closeConfirm();
    const m = modalOverlay(this.popups, 'confirm', { alpha: 0.6, zIndex: 930 });
    this.confirmUi = m;
    const dim = m.overlay.children[0];
    if (dim) dim.onPointerDownObservable.add(() => this.closeConfirm());
    this.confirmAction = action;
    const vw = window.innerWidth;
    const titleH = Math.round(fs(22) * 1.4);
    const lineH = Math.round(fs(16) * 1.5);
    const linesH = text.split('\n').map(() => lineH);
    // Панель в кнопку-высоту контента: Container без height тянет на 100%.
    const kids = [titleH, ...linesH, 52];
    const ph = 32 + kids.reduce((a: number, b: number) => a + b, 0) + 12 * (kids.length - 1);
    const panel = softPanel({ bg: '#171F2B', bgAlpha: 0.98, border: '#43A047', thickness: 2, corner: 14 });
    panel.root.width = px(Math.min(Math.round(vw * 0.9), 420));
    panel.root.height = px(ph);
    panel.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    panel.root.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    m.overlay.addControl(panel.root);
    const col = new StackPanel('confirmBox');
    col.isVertical = true;
    col.width = '100%';
    col.spacing = 12;
    col.paddingLeft = pxa(20);
    col.paddingRight = pxa(20);
    col.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    panel.root.addControl(col);
    col.addControl(mkLabel(title, { fontSize: fs(22), color: SKIN.gold, height: titleH }));
    for (const line of text.split('\n')) {
      col.addControl(mkLabel(line, { fontSize: fs(16), color: '#ffffffE6', height: lineH }));
    }
    const row = new StackPanel('confirmRow');
    row.isVertical = false;
    row.height = px(52);
    row.spacing = 12;
    row.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    const ok = mkButton(okText, {
      height: 52, width: Math.max(120, measureTextWidth(okText, fs(16)) + 40), fontSize: fs(16),
      theme: BUTTON_STYLE.green,
    });
    ok.onPointerUpObservable.clear();
    ok.onPointerUpObservable.add(() => {
      const act = this.confirmAction;
      this.closeConfirm();
      if (act) act();
    });
    const cancel = mkButton(t('Отмена'), {
      height: 52, width: Math.max(120, measureTextWidth(t('Отмена'), fs(16)) + 40), fontSize: fs(16),
      theme: { bg: '#31363F', hover: '#3A404A', press: '#262B33' },
    });
    cancel.onPointerUpObservable.clear();
    cancel.onPointerUpObservable.add(() => this.closeConfirm());
    row.addControl(ok);
    row.addControl(cancel);
    col.addControl(row);
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
            previewHost.left = pxa(Math.round(g.x - ts.x / 2));
            previewHost.top = pxa(Math.round(g.y - ts.y / 2));
            const handRect = rectOf(this.handPanel);
            if (g.y >= handRect.y) {
              this.dragData.targetRow = -2;
              this.dragData.index = -1;
            } else {
              const hit = this.rowsHit(g.x, g.y);
              this.highlightSlot(hit && hit.rowId === -3 ? hit.index : -1);
              this.dragData.targetRow = hit ? hit.rowId : undefined;
              this.dragData.index = hit ? hit.index : undefined;
            }
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
    const rect0 = rectOf(this.boardRoot);
    const np = lastNativePointer();
    const g0 = (np.x !== 0 || np.y !== 0)
      ? np
      : canvasToGui(scene, scene.pointerX, scene.pointerY);
    previewHost.left = pxa(Math.max(rect0.x + 10, g0.x - ts.x / 2));
    previewHost.top = pxa(Math.max(rect0.y + 10, g0.y - ts.y / 2));
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
      sl.root.height = px(active ? 12 : 1);
      sl.fill.color = active ? '#FFD54F99' : '#FFD54F00';
      sl.fill.background = active ? '#FFD54F26' : '#FFD54F00';
    }
  }

  private clearSlotHighlight(): void {
    for (const sl of this.rowSlots) {
      sl.root.height = px(1);
      sl.fill.color = '#FFD54F00';
      sl.fill.background = '#FFD54F00';
    }
  }

  private dragEnd(): void {
    const dd = this.dragData;
    this.dragData = null;
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
    const s = loadSettings();
    const level = s.bot_level;
    const anim = s.bot_anim;
    this.flashTurnTitle(this.turnTitleText());
    window.setTimeout(() => {
      if (!this.running || !this.state || this.state.finished) return;
      const plan = this.planner.plan(this.state, level);
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
      const fail = (): void => {
        if (this.running && this.state) this.state.restoreTurnSnapshot();
        setTimeout(() => this.botEndTurn(), BOT_MIN_WAIT_MS);
      };
      const step = (): void => {
        if (!this.running || !this.state) return;
        if (seq.length === 0) {
          setTimeout(() => this.botEndTurn(), BOT_MIN_WAIT_MS);
          return;
        }
        const op = seq.shift()!;
        this.queueBotTileFlight(op);
        if (!apply(op)) {
          fail();
          return;
        }
        this.refresh();
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
const nativePointer = { x: 0, y: 0 };
if (typeof window !== 'undefined') {
  const update = (e: PointerEvent): void => {
    try {
      const app = (window as unknown as { __app?: { canvas?: HTMLCanvasElement } }).__app;
      const cv = app?.canvas;
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      nativePointer.x = e.clientX - r.left;
      nativePointer.y = e.clientY - r.top;
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
