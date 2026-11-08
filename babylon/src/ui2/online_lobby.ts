import {
  Button,
  Container,
  Control,
  InputText,
  Rectangle,
  ScrollViewer,
  StackPanel,
} from '@babylonjs/gui';
import { t } from '../core/lang';
import { fs, loadSettings, MAX_NAME_LEN } from '../core/settings';
import { AuthError, RoomWithServer } from '../net/api';
import {
  BoardListMsg,
  GameEnvelope,
  RoomLobbyEnvelope,
  RoomLobbyView,
  S2C,
} from '../net/protocol';
import { listServerRefs } from '../net/servers';
import type { App } from '../ui/app';
import {
  BUTTON_STYLE,
  ButtonTheme,
  checkboxRow,
  dropdownRow,
  DropdownCtx,
  enableSmoothScroll,
  estimateWrappedTextHeight,
  focusInputOnTap,
  hrow,
  mkButton,
  mkLabel,
  modalOverlay,
  popupList,
  setButtonLabel,
  setInputMaxLength,
  SKIN,
  softPanel,
  px,
  wrapTextToWidth,
} from './uiskin';
import { measureTextWidth } from './menu_screen';
import { viewHeight, viewWidth } from './viewport';
import { platform } from '../platform';
import { showDomToast } from './dom_toast';

// Порт scripts/ui/online_lobby.gd: сетевое меню — единый экран с тремя
// страницами (вход / комнаты / лобби комнаты), как в оригинале.
// Осознанные отличия от оригинала:
//  - probe серверов (servers.gd) в TS-клиенте нет — подключаемся к
//    dev-серверу, если задан, иначе по порядку к встроенным; список
//    комнат приходит только с текущего сервера;
//  - баннер «вы всё ещё в комнате» (pending_room) не портирован:
//    протокол не сообщает о чужой комнате после reconnect;
//  - «Удалить аккаунт» — Android-only в оригинале, здесь нет.
const GOLD = SKIN.gold;
const NOTE = 'rgba(255,255,255,0.7)';
const WARN = '#FF8A80';
const WHITE90 = 'rgba(255,255,255,0.9)';
const WHITE85 = 'rgba(255,255,255,0.85)';
const WEAK50 = 'rgba(255,255,255,0.5)';
const GREY_THEME: ButtonTheme = { bg: '#31363F', hover: '#3A404A', press: '#262B33' };
const TAB_ACTIVE: ButtonTheme = { bg: '#37578C', hover: '#3B5D96', press: '#2C456E' };

const ROOMS_PAGE_SIZE = 5;
const ROUND_H = 48;
const SMALL_H = 40;
const FIELD_H = 44;
const ROOMS_MIN_H = 190;
const PLAYERS_MIN_H = 160;
const HEALTH_TICK_MS = 20000;
const ROOMS_TICK_MS = 10000;
// uid, в который мы сами вошли по авторизованному Yandex ID. По нему
// отличаем настоящий вход от гостевого lite-ID (у обоих логин «ya:»).
const YA_AUTH_UID_KEY = 'dg.ya_auth_uid';

type PageName = 'auth' | 'rooms' | 'lobby';

// _field-порт: тёмное поле высотой с кнопку. Ширина — «100%» по умолчанию
// (в столбике поле тянется на всю страницу); в горизонтальных рядах
// ширина задаётся после создания.
function mkField(placeholder: string, opts: { secret?: boolean; width?: number | string } = {}): InputText {
  const e = new InputText('fld');
  e.placeholderText = placeholder;
  e.height = px(FIELD_H);
  e.width = opts.width !== undefined
    ? (typeof opts.width === 'number' ? px(opts.width) : opts.width)
    : '100%';
  e.color = SKIN.text;
  e.background = '#242B38';
  e.thickness = 1;
  e.fontSize = fs(15);
  e.textHighlightColor = '#37578C';
  e.focusedBackground = '#2A3240';
  // Маскировки пароля в @babylonjs/gui нет: как и в 3D-экране поля,
  // пароль вводится открытым текстом, ограничиваем только ширину.
  if (opts.secret) e.maxWidth = '480px';
  e.hoverCursor = 'text';
  focusInputOnTap(e);
  return e;
}

// _set_note-порт: строка-примечание, видима только с текстом.
function mkNote(): { root: StackPanel; lab: ReturnType<typeof mkLabel> } {
  const wrap = new StackPanel('noteWrap');
  wrap.isVertical = true;
  wrap.width = '100%';
  const lab = mkLabel('', { fontSize: fs(15), color: NOTE, width: '100%', height: 22 });
  lab.resizeToFit = true;
  lab.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  wrap.addControl(lab);
  return { root: wrap, lab };
}

function setNote(lab: ReturnType<typeof mkLabel>, text: string, warn: boolean): void {
  lab.text = text;
  lab.isVisible = text !== '';
  lab.color = warn ? WARN : NOTE;
}

// _apply_accent-порт: подложка акцентная, текст всегда белый.
function accentButton(label: string, theme: ButtonTheme, height: number, fontSize: number, width?: number): Button {
  // width передаём в mkButton: он подгоняет шрифт под фиксированную ширину,
  // иначе длинная подпись обрезается по бокам.
  const b = mkButton(label, { height, fontSize, theme, corner: 10, width });
  if (width === undefined) b.width = '100%';
  return b;
}

function greyButton(label: string, height: number, fontSize: number, width?: number): Button {
  return accentButton(label, GREY_THEME, height, fontSize, width);
}

function headerLabel(text: string, size: number): ReturnType<typeof mkLabel> {
  const lab = mkLabel(text, { fontSize: size, color: WHITE90, width: '100%', height: Math.round(size * 1.6) });
  lab.resizeToFit = true;
  lab.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  return lab;
}

function textTruncate(text: string, fontSize: number, avail: number): string {
  if (measureTextWidth(text, fontSize) <= avail) return text;
  let out = text;
  while (out.length > 1 && measureTextWidth(`${out}…`, fontSize) > avail) out = out.slice(0, -1);
  return `${out}…`;
}

// Места 1–3 — цвета медалей, своя строка — синим (_rank_color-порт).
function rankColor(rank: number, mine: boolean): string {
  if (mine) return '#90CAF9';
  if (rank === 1) return '#FFD54F';
  if (rank === 2) return '#C0C0C0';
  if (rank === 3) return '#CD7F32';
  return 'rgba(255,255,255,0.55)';
}

export class OnlineLobby {
  private app: App;
  private popups!: Container;
  private ctx: DropdownCtx;
  private avail = 480;
  private backBtnW = 96;

  private titleLabel!: ReturnType<typeof mkLabel>;
  private statusLab!: ReturnType<typeof mkLabel>;
  private busyLab!: ReturnType<typeof mkLabel>;

  private pageAuth!: StackPanel;
  private pageRooms!: StackPanel;
  private pageLobby!: StackPanel;

  private nickEdit!: InputText;
  private authNoteLab!: ReturnType<typeof mkLabel>;
  private loginBtn!: Button;
  private yaInfoLab!: ReturnType<typeof mkLabel>;
  private yaLoginBtn!: Button;
  private yaGuestBtn!: Button;

  private playBtn!: Button;
  private boardBtn!: Button;
  private yaUpsellBtn!: Button;
  private yaUpsellLab!: ReturnType<typeof mkLabel>;
  private tabCreateBtn!: Button;
  private tabCodeBtn!: Button;
  private createBox!: StackPanel;
  private codeBox!: StackPanel;
  private seatsDropdown!: ReturnType<typeof dropdownRow>;
  private roomName!: InputText;
  private roomPass!: InputText;
  private require30: boolean;
  private createBtn!: Button;
  private joinCode!: InputText;
  private joinPass!: InputText;
  private joinBtn!: Button;
  private roomsNoteLab!: ReturnType<typeof mkLabel>;
  private roomsHeader!: StackPanel;
  private roomsRefreshRow!: StackPanel;
  private refreshBtn!: Button;
  private roomsBox!: StackPanel;
  private pageRow!: StackPanel;
  private pagePrev!: Button;
  private pageNext!: Button;
  private pageLabel!: ReturnType<typeof mkLabel>;

  private lobbyCodeLab!: ReturnType<typeof mkLabel>;
  private lobbySeats!: ReturnType<typeof mkLabel>;
  private lobbyPlayers!: StackPanel;
  private lobbyNoteLab!: ReturnType<typeof mkLabel>;
  private startBtn!: Button;
  private leaveBtn!: Button;

  private pendingBox!: Container;
  private pendingLab!: ReturnType<typeof mkLabel>;
  private pendingRoomState: RoomLobbyView | null = null;
  private pendingReturnBtn!: Button;
  private pendingLeaveBtn!: Button;
  private pendingActions!: StackPanel;

  private rooms: RoomWithServer[] = [];
  private roomsPage = 0;
  private busyFlag = false;
  private roomsLoading = false;
  private roomsTab: '' | 'create' | 'code' = '';
  private page: PageName = 'auth';
  private currentRoom: RoomLobbyView | null = null;
  private lobbyReady = false;
  private started = false;
  private connecting = false;
  private boardOpen = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private roomsTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App) {
    this.app = app;
    this.require30 = loadSettings().require_30;
    this.ctx = {
      openFor: (a, items, cur, cb, w) => popupList(this.popups, a, items, cur, cb, fs(15), w),
    };
  }

  // =============================================================== сборка

  build(root: Container): void {
    this.stopTimers();
    root.clearControls();

    const vw = viewWidth();
    const vh = viewHeight();
    // Контейнер-поля (padding 14) обрезает детей, а скролл берём на 6px шире
    // колонки (запас под полосу прокрутки). Поэтому колонка на 6px уже
    // доступной ширины: иначе скролл вылезает за поля и обрезается слева.
    this.avail = Math.max(240, Math.min(vw - 28 - 6, 536));

    const bg = new Rectangle('onlBg');
    bg.background = '#12151C';
    bg.thickness = 0;
    bg.width = '100%';
    bg.height = '100%';
    bg.isHitTestVisible = false;
    root.addControl(bg);

    // Всплывашки (OptionButton-списки) — верхний слой экрана, как в меню.
    this.popups = new Container('onlPopups');
    this.popups.width = '100%';
    this.popups.height = '100%';
    this.popups.isPointerBlocker = false;
    this.popups.isHitTestVisible = false;
    root.addControl(this.popups);

    const margin = new Container('onlMargin');
    margin.width = '100%';
    margin.height = '100%';
    margin.paddingLeft = px(14);
    margin.paddingRight = px(14);
    margin.paddingTop = px(12);
    margin.paddingBottom = px(12);
    root.addControl(margin);

    const scroll = new ScrollViewer('onlScroll');
    scroll.thickness = 0;
    scroll.barSize = 2;
    scroll.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    scroll.width = px(this.avail + 6);
    scroll.height = px(vh - 24);
    margin.addControl(scroll);
    enableSmoothScroll(scroll);

    const col = new StackPanel('onlCol');
    col.isVertical = true;
    col.spacing = 10;
    col.width = px(this.avail);
    scroll.addControl(col);

    // --- шапка: заголовок вписывается в место после «Назад»
    const head = hrow(10);
    head.width = '100%';
    head.height = px(46);
    col.addControl(head);
    this.backBtnW = Math.max(96, Math.round(measureTextWidth(t('Назад'), fs(15))) + 30);
    this.titleLabel = mkLabel(t('ИГРА ПО СЕТИ'), {
      fontSize: this.fitFontSize(),
      noWrap: true,
      color: WHITE90,
      width: Math.max(120, this.avail - this.backBtnW - 10),
      height: 46,
      hAlign: 'left',
      align: 'left',
      vAlign: 'center',
    });
    head.addControl(this.titleLabel);
    const backBtn = greyButton(t('Назад'), SMALL_H, fs(16), this.backBtnW);
    backBtn.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    backBtn.onPointerUpObservable.add(() => this.app.onLeaveOnline());
    head.addControl(backBtn);

    const st = mkNote();
    this.statusLab = st.lab;
    col.addControl(st.root);
    const bs = mkNote();
    this.busyLab = bs.lab;
    col.addControl(bs.root);

    // --- страницы
    this.pageAuth = this.buildAuth();
    this.pageRooms = this.buildRooms();
    this.pageLobby = this.buildLobby();
    col.addControl(this.pageAuth);
    col.addControl(this.pageRooms);
    col.addControl(this.pageLobby);

    this.setPage(this.page);
    this.applyPending(this.app.api.pendingRoom);
    // popups — ПОСЛЕДНИМ ребёнком root: иначе доска лидеров и списки
    // dropdown рисуются под страницами и не получают клики
    if (this.popups.parent) this.popups.parent.removeControl(this.popups);
    root.addControl(this.popups);
    this.updateStatus();
    this.updateButtons();
  }

  private fitFontSize(): number {
    // Заголовок ужимается под «Назад», а не обрезается.
    const full = t('ИГРА ПО СЕТИ');
    const room = Math.max(120, this.avail - this.backBtnW - 10);
    let size = fs(22);
    while (size > 12 && measureTextWidth(full, size) > room) size -= 1;
    return size;
  }

  // _update_buttons-порт: состояние ВСЕХ кнопок считается здесь, целиком.
  // «Назад», вкладки и пагинация — локальные действия без сети: гаснуть
  // им не с чего. Остальное — запросы и смена сессий. Вызывается и из App
  // (пересборка экрана при смене настроек).
  updateButtons(): void {
    const busy = this.busyFlag;
    // Для входа нужен не просто открытый сокет, а приветствие сервера:
    // connect() возвращает hello, так что этого достаточно.
    const linked = this.app.api.isOpen;
    const authed = Boolean(this.app.api.user);
    const dis = (b: Button, cond: boolean): void => { b.isEnabled = !cond; };
    dis(this.loginBtn, busy || !linked);
    dis(this.yaLoginBtn, busy || !linked);
    dis(this.yaGuestBtn, busy || !linked);
    dis(this.yaUpsellBtn, busy || !linked);
    // Кнопка входа по Yandex ID из комнат: только на Яндексе и пока текущий
    // серверный аккаунт не совпадает с тем, в который мы сами входили по
    // авторизованному Yandex ID. Гостевой lite-ID тоже носит логин «ya:»,
    // поэтому префикса недостаточно — помним uid своего яндексового входа.
    const myYaUid = localStorage.getItem(YA_AUTH_UID_KEY) ?? '';
    const login = String(this.app.api.user?.login ?? '');
    const matchesOwnYandexLogin = myYaUid !== '' && login === `ya:${myYaUid}`;
    this.yaUpsellBtn.isVisible = platform.id === 'yandex'
      && !!this.app.api.user && !matchesOwnYandexLogin;
    this.yaUpsellLab.isVisible = this.yaUpsellBtn.isVisible;
    dis(this.refreshBtn, busy || this.roomsLoading || !linked);
    dis(this.createBtn, busy || !authed);
    dis(this.playBtn, busy || !authed);
    dis(this.joinBtn, busy || !authed);
    dis(this.startBtn, busy || !authed || !this.lobbyReady);
    dis(this.leaveBtn, busy || !authed);
    this.updatePagination();
  }

  // Пагинация — локальный перелист: границы применяем поверх любых гашений.
  private updatePagination(): void {
    const pages = Math.max(1, Math.ceil(this.rooms.length / ROOMS_PAGE_SIZE));
    this.pagePrev.isEnabled = !this.busyFlag && this.roomsPage > 0;
    this.pageNext.isEnabled = !this.busyFlag && this.roomsPage < pages - 1;
  }

  // =============================================================== страница входа

  private buildAuth(): StackPanel {
    const page = new StackPanel('onlAuth');
    page.isVertical = true;
    page.spacing = 12;
    page.isVisible = false;

    const isYandex = platform.id === 'yandex';
    page.addControl(headerLabel(isYandex ? t('Онлайн через Яндекс ID') : t('Вход'), fs(19)));

    const benefit = t('Вход через Яндекс привязывает сетевые результаты к профилю, использует имя из Яндекса и открывает таблицу Яндекс Игр. Гостевой режим тоже позволяет играть по сети, но гостевой прогресс может не восстановиться при смене устройства или профиля.');
    const benefitW = Math.max(160, this.avail - 24);
    const benefitText = wrapTextToWidth(benefit, benefitW, fs(14));
    this.yaInfoLab = mkLabel(benefitText, {
      fontSize: fs(14), color: WHITE85, width: '100%',
      height: estimateWrappedTextHeight(benefitText, benefitW, fs(14)) + 8,
      noWrap: false, align: 'center', vAlign: 'center',
    });
    this.yaInfoLab.isVisible = isYandex;
    page.addControl(this.yaInfoLab);

    this.yaLoginBtn = accentButton(t('Войти через Яндекс'), BUTTON_STYLE.online, ROUND_H, fs(16));
    this.yaLoginBtn.isVisible = isYandex;
    this.yaLoginBtn.onPointerUpObservable.add(() => void this.signInWithYandex(true));
    page.addControl(this.yaLoginBtn);

    this.yaGuestBtn = greyButton(t('Продолжить гостем'), ROUND_H, fs(16));
    this.yaGuestBtn.isVisible = isYandex;
    this.yaGuestBtn.onPointerUpObservable.add(() => this.showGuestForm());
    page.addControl(this.yaGuestBtn);

    this.nickEdit = mkField(t('имя в игре'));
    this.nickEdit.isVisible = !isYandex;
    setInputMaxLength(this.nickEdit, MAX_NAME_LEN);
    page.addControl(this.nickEdit);

    this.loginBtn = accentButton(t('Войти'), BUTTON_STYLE.online, ROUND_H, fs(17));
    this.loginBtn.isVisible = !isYandex;
    this.loginBtn.onPointerUpObservable.add(() => void this.doGuestLogin());
    page.addControl(this.loginBtn);

    const an = mkNote();
    this.authNoteLab = an.lab;
    page.addControl(an.root);
    return page;
  }

  // =============================================================== страница комнат

  private buildRooms(): StackPanel {
    const page = new StackPanel('onlRooms');
    page.isVertical = true;
    page.spacing = 12;
    page.isVisible = false;

    // --- баннер «вы всё ещё в комнате» (net.gd pending_room)
    this.pendingBox = new Container('onlPending');
    this.pendingBox.width = '100%';
    this.pendingBox.height = px(80);
    this.pendingBox.clipChildren = false;
    this.pendingBox.isVisible = false;
    const pendingFill = new Rectangle('pendingFill');
    pendingFill.cornerRadius = 10;
    pendingFill.thickness = 2;
    pendingFill.color = SKIN.gold;
    pendingFill.background = '#FFD54F14';
    pendingFill.width = '100%';
    pendingFill.height = '100%';
    pendingFill.isHitTestVisible = false;
    this.pendingBox.addControl(pendingFill);
    this.pendingLab = mkLabel('', { fontSize: fs(13), color: WHITE90, height: SMALL_H, noWrap: false, align: 'left', vAlign: 'top' });
    this.pendingLab.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    this.pendingLab.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    this.pendingLab.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    this.pendingBox.addControl(this.pendingLab);
    this.pendingActions = new StackPanel('pendingActions');
    this.pendingActions.isVertical = false;
    this.pendingActions.spacing = 8;
    this.pendingBox.addControl(this.pendingActions);
    this.pendingReturnBtn = greyButton(t('Вернуться'), SMALL_H, fs(13), 96);
    this.pendingReturnBtn.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.pendingReturnBtn.onPointerUpObservable.add(() => { void this.returnToPending(); });
    this.pendingActions.addControl(this.pendingReturnBtn);
    this.pendingLeaveBtn = greyButton(t('Покинуть'), SMALL_H, fs(13), 88);
    this.pendingLeaveBtn.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.pendingLeaveBtn.onPointerUpObservable.add(() => { void this.dropPending(); });
    this.pendingActions.addControl(this.pendingLeaveBtn);
    page.addControl(this.pendingBox);

    this.playBtn = accentButton(t('Играть по сети'), BUTTON_STYLE.green, 58, fs(20));
    this.playBtn.onPointerUpObservable.add(() => void this.doQuick());
    page.addControl(this.playBtn);

    this.boardBtn = accentButton(t('Таблица лидеров'), BUTTON_STYLE.blueOnline, ROUND_H, fs(16));
    this.boardBtn.onPointerUpObservable.add(() => void this.openBoard());
    page.addControl(this.boardBtn);

    // Гость на Яндексе позже может войти по Yandex ID: пояснение и кнопка
    // появляются, когда текущий аккаунт не яндексовый.
    this.yaUpsellLab = mkLabel(t('Войдите через Яндекс ID, чтобы сохранить прогресс'), {
      fontSize: fs(13), color: NOTE, width: '100%', height: 34, noWrap: false, align: 'center',
    });
    this.yaUpsellLab.isVisible = false;
    page.addControl(this.yaUpsellLab);
    this.yaUpsellBtn = accentButton(t('Войти через Яндекс'), BUTTON_STYLE.online, ROUND_H, fs(16));
    this.yaUpsellBtn.isVisible = false;
    this.yaUpsellBtn.onPointerUpObservable.add(() => void this.signInWithYandex(false));
    page.addControl(this.yaUpsellBtn);

    // --- вкладки: видна только одна форма, в начале — ни одной.
    // На экране уже 360px — в колонку (подписи целиком); шире — в ряд.
    const stackTabs = viewWidth() < 360;
    const tabs = new StackPanel('onlTabs');
    tabs.isVertical = stackTabs;
    tabs.spacing = 8;
    tabs.width = '100%';
    tabs.height = px(stackTabs ? 46 * 2 + 8 : 46);
    tabs.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    page.addControl(tabs);
    this.tabCreateBtn = this.tabButton(t('Создать комнату'), 'create', tabs, !stackTabs);
    this.tabCodeBtn = this.tabButton(t('Войти по коду'), 'code', tabs, !stackTabs);

    // --- создать (за вкладкой)
    this.createBox = new StackPanel('onlCreate');
    this.createBox.isVertical = true;
    this.createBox.spacing = 8;
    this.createBox.isVisible = false;
    page.addControl(this.createBox);
    this.createBox.addControl(headerLabel(t('Своя комната'), fs(19)));
    const crow = hrow(8);
    crow.width = '100%';
    crow.height = px(FIELD_H);
    this.createBox.addControl(crow);
    const seatsItems: string[] = [];
    for (let n = 2; n <= 5; n += 1) seatsItems.push(t('мест: %d', n));
    this.seatsDropdown = dropdownRow('', this.ctx, { height: FIELD_H, fontSize: fs(15) });
    this.seatsDropdown.setOptions(seatsItems, 1, () => undefined);
    // В оригинале это OptionButton без подписи: метку прячем, кнопку
    // дожимаем до честной ширины элемента.
    const seatsLbl = this.seatsDropdown.root.children[0] as Control;
    seatsLbl.isVisible = false;
    const seatsBtn = this.seatsDropdown.root.children[1] as Control;
    seatsBtn.isVisible = true;
    seatsBtn.width = px(110);
    seatsBtn.height = px(FIELD_H);
    this.seatsDropdown.root.height = px(FIELD_H);
    this.seatsDropdown.root.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    crow.addControl(this.seatsDropdown.root);
    // как в оригинале: название и пароль делят остаток ширины ряда
    // поровну (SIZE_EXPAND_FILL twice); «100%» в горизонтальном ряду
    // выталкивает соседей за край — только числа
    const nameW = Math.max(100, Math.round((this.avail - 110 - 16) / 2));
    this.roomName = mkField(t('название (необязательно)'), { width: nameW });
    crow.addControl(this.roomName);
    this.roomPass = mkField(t('пароль (необязательно)'), { width: nameW, secret: true });
    crow.addControl(this.roomPass);
    const chk = checkboxRow(t('Первый ход: от 30'), this.require30, {
      height: 38,
      fontSize: fs(15),
      onChange: (v) => { this.require30 = v; },
    });
    chk.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    this.createBox.addControl(chk.root);
    this.createBtn = accentButton(t('Создать'), BUTTON_STYLE.green, ROUND_H, fs(16));
    this.createBtn.onPointerUpObservable.add(() => void this.doCreate());
    this.createBox.addControl(this.createBtn);

    // --- по коду (за вкладкой), форма стоит сразу за созданием
    this.codeBox = new StackPanel('onlCode');
    this.codeBox.isVertical = true;
    this.codeBox.spacing = 8;
    this.codeBox.isVisible = false;
    page.addControl(this.codeBox);
    this.codeBox.addControl(headerLabel(t('Войти по коду'), fs(15)));
    const codeRow = hrow(8);
    codeRow.width = '100%';
    codeRow.height = px(FIELD_H);
    this.codeBox.addControl(codeRow);
    this.joinCode = mkField(t('код'), { width: Math.round(this.avail * 0.3) });
    codeRow.addControl(this.joinCode);
    this.joinPass = mkField(t('пароль'), { width: Math.round(this.avail * 0.3), secret: true });
    codeRow.addControl(this.joinPass);
    this.joinBtn = greyButton(t('Войти'), FIELD_H, fs(15), 110);
    this.joinBtn.onPointerUpObservable.add(() =>
      void this.doJoin(this.joinCode.text.trim().toUpperCase(), this.joinPass.text));
    codeRow.addControl(this.joinBtn);

    // --- список
    page.addControl(headerLabel(t('Все комнаты'), fs(19)));
    this.roomsHeader = new StackPanel('roomsHeader');
    this.roomsHeader.isVertical = true;
    this.roomsHeader.width = '100%';
    this.roomsHeader.spacing = 4;
    page.addControl(this.roomsHeader);
    this.roomsNoteLab = mkLabel('', {
      fontSize: fs(15), color: NOTE, width: '100%', height: SMALL_H,
      noWrap: false, align: 'left', vAlign: 'top',
    });
    this.roomsNoteLab.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    this.roomsHeader.addControl(this.roomsNoteLab);
    this.roomsRefreshRow = hrow(0);
    this.roomsRefreshRow.width = '100%';
    this.roomsHeader.addControl(this.roomsRefreshRow);
    this.refreshBtn = greyButton(t('Обновить'), SMALL_H, fs(15), 120);
    this.refreshBtn.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.refreshBtn.onPointerUpObservable.add(() => { void this.refreshRooms(false); });
    this.roomsRefreshRow.addControl(this.refreshBtn);
    this.layoutRoomsHeader();

    this.roomsBox = new StackPanel('onlRoomsBox');
    this.roomsBox.isVertical = true;
    this.roomsBox.spacing = 4;
    this.roomsBox.width = '100%';
    this.roomsBox.height = px(ROOMS_MIN_H);
    page.addControl(this.roomsBox);

    // --- пагинация: видна, только если страниц больше одной
    this.pageRow = hrow(8);
    this.pageRow.width = '100%';
    this.pageRow.height = px(SMALL_H);
    this.pageRow.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.pageRow.isVisible = false;
    page.addControl(this.pageRow);
    this.pagePrev = greyButton(t('‹'), SMALL_H, fs(16), 44);
    this.pagePrev.onPointerUpObservable.add(() => this.pageStep(-1));
    this.pageRow.addControl(this.pagePrev);
    this.pageLabel = mkLabel('', { fontSize: fs(15), color: 'rgba(255,255,255,0.7)', width: 120, height: SMALL_H });
    this.pageRow.addControl(this.pageLabel);
    this.pageNext = greyButton(t('›'), SMALL_H, fs(16), 44);
    this.pageNext.onPointerUpObservable.add(() => this.pageStep(1));
    this.pageRow.addControl(this.pageNext);

    return page;
  }

  private tabButton(label: string, tab: 'create' | 'code', row: StackPanel, sideBySide: boolean): Button {
    const active = (): boolean => this.roomsTab === tab;
    // В ряд — половина ширины; в колонке — вся ширина.
    const w = sideBySide ? Math.max(90, Math.floor((this.avail - 8) / 2)) : this.avail;
    const b = greyButton(label, 46, fs(15), w);
    b.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    b.onPointerEnterObservable.add(() => { b.background = active() ? TAB_ACTIVE.hover : GREY_THEME.hover; });
    b.onPointerOutObservable.add(() => { b.background = active() ? TAB_ACTIVE.bg : GREY_THEME.bg; });
    b.onPointerUpObservable.add(() => {
      this.roomsTab = active() ? '' : tab;
      this.syncRoomsTab();
    });
    row.addControl(b);
    return b;
  }

  private syncRoomsTab(): void {
    this.createBox.isVisible = this.roomsTab === 'create';
    this.codeBox.isVisible = this.roomsTab === 'code';
    this.tabCreateBtn.background = this.roomsTab === 'create' ? TAB_ACTIVE.bg : GREY_THEME.bg;
    this.tabCodeBtn.background = this.roomsTab === 'code' ? TAB_ACTIVE.bg : GREY_THEME.bg;
  }

  // =============================================================== страница лобби комнаты

  private buildLobby(): StackPanel {
    const page = new StackPanel('onlLobby');
    page.isVertical = true;
    page.spacing = 12;
    page.isVisible = false;

    this.lobbyCodeLab = headerLabel('', fs(24));
    page.addControl(this.lobbyCodeLab);
    this.lobbySeats = mkLabel('', { fontSize: fs(15), color: 'rgba(255,255,255,0.6)', width: '100%', height: 30 });
    this.lobbySeats.resizeToFit = true;
    this.lobbySeats.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    page.addControl(this.lobbySeats);

    // Код комнаты удобно передать друзьям: копируем в буфер обмена
    // (SDK площадки или браузерный фолбэк).
    const copyText = t('Скопировать код');
    const copyBtn = greyButton(
      copyText,
      SMALL_H,
      fs(15),
      Math.max(150, Math.round(measureTextWidth(copyText, fs(15))) + 32),
    );
    copyBtn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    copyBtn.onPointerUpObservable.add(() => void this.doCopyCode());
    page.addControl(copyBtn);

    this.lobbyPlayers = new StackPanel('onlPlayers');
    this.lobbyPlayers.isVertical = true;
    this.lobbyPlayers.spacing = 6;
    this.lobbyPlayers.width = '100%';
    this.lobbyPlayers.height = px(PLAYERS_MIN_H);
    page.addControl(this.lobbyPlayers);

    const hint = mkLabel(t('Для начала нужны двое живых игроков — остальные места займут боты.'), {
      fontSize: fs(14),
      color: WEAK50,
      width: '100%',
      height: 40,
    });
    hint.resizeToFit = true;
    hint.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    page.addControl(hint);

    const ln = mkNote();
    this.lobbyNoteLab = ln.lab;
    page.addControl(ln.root);

    this.startBtn = accentButton(t('Начать партию'), BUTTON_STYLE.green, 52, fs(18));
    this.startBtn.onPointerUpObservable.add(() => void this.doStart());
    page.addControl(this.startBtn);
    this.leaveBtn = greyButton(t('Выйти'), ROUND_H, fs(15));
    this.leaveBtn.onPointerUpObservable.add(() => void this.doLeaveRoom());
    page.addControl(this.leaveBtn);
    return page;
  }

  // =============================================================== страницы и статусы

  private setPage(page: PageName): void {
    this.page = page;
    this.pageAuth.isVisible = page === 'auth';
    this.pageRooms.isVisible = page === 'rooms';
    this.pageLobby.isVisible = page === 'lobby';
    this.updateStatus();
  }

  // _update_status-порт: сервер и активный игрок, или причина молчания.
  private updateStatus(): void {
    const api = this.app.api;
    let text = t('Сервер: %s', t(api.ref?.name ?? '?'));
    let warn = false;
    if (!api.isOpen) {
      // авто-переподключение ещё идёт — не пугаем «нет связи»
      const retrying = api.session.reconnecting;
      text = retrying ? t('Переподключаемся к серверу…') : t('Нет связи с сервером');
      warn = !retrying;
    } else if (api.user) {
      text += t(' · %s', api.user.nick);
    }
    setNote(this.statusLab, text, warn);
  }

  private setBusy(text: string): void {
    this.busyFlag = text !== '';
    setNote(this.busyLab, text, false);
    this.updateButtons();
  }

  // =============================================================== вход

  private async doGuestLogin(): Promise<void> {
    const nick = this.nickEdit.text.trim();
    if (nick === '') {
      setNote(this.authNoteLab, t('Введите ник'), true);
      return;
    }
    setNote(this.authNoteLab, t('Входим…'), false);
    try {
      await this.app.api.guestLogin(nick);
      setNote(this.authNoteLab, t('Вход выполнен'), false);
      await this.gotoRooms();
    } catch (e) {
      setNote(this.authNoteLab, t((e as Error).message) || t('Не удалось войти'), true);
    }
  }

  // «Продолжить гостем» на Яндексе: показываем обычную форму входа с именем
  // (логин/пароль генерируются на лету), а не логиним по lite-ID молча.
  private showGuestForm(): void {
    this.nickEdit.isVisible = true;
    this.loginBtn.isVisible = true;
    this.yaGuestBtn.isVisible = false;
    this.fillAuthDefaults();
    this.updateButtons();
  }

  // Вход по Yandex ID. fromAuthPage — вызывается со страницы входа (там
  // показываем итог строкой); иначе (апгрейд из комнат) итог идёт тостом.
  private async signInWithYandex(fromAuthPage: boolean): Promise<void> {
    if (this.busyFlag || platform.id !== 'yandex') return;
    this.setBusy(t('Получаем профиль Яндекс…'));
    let profile = await platform.getPlayer();
    if (!this.alive()) {
      this.setBusy('');
      return;
    }
    if (!profile?.uid) {
      this.setBusy('');
      this.reportYandexResult(fromAuthPage, t('Не удалось получить гостевой профиль Яндекса'), true);
      if (fromAuthPage) this.showGuestForm();
      return;
    }

    if (!profile.authorized) {
      this.setBusy(t('Открываем вход через Яндекс…'));
      const opened = await platform.openAuthDialog();
      if (!this.alive()) {
        this.setBusy('');
        return;
      }
      if (!opened) {
        this.setBusy('');
        this.reportYandexResult(fromAuthPage, t('Вход через Яндекс отменён. Можно продолжить гостем.'), false);
        return;
      }
      profile = await platform.getPlayer();
      if (!this.alive()) {
        this.setBusy('');
        return;
      }
      if (!profile?.uid || !profile.authorized) {
        this.setBusy('');
        this.reportYandexResult(fromAuthPage, t('Вход в Яндекс не выполнен. Можно продолжить гостем.'), false);
        return;
      }
    }

    this.setBusy(t('Входим через Яндекс…'));
    try {
      await this.app.api.yandexLogin(profile.uid, profile.name || t('Гость'));
      localStorage.setItem(YA_AUTH_UID_KEY, profile.uid);
      this.setBusy('');
      this.updateStatus();
      if (fromAuthPage || this.page === 'auth') {
        await this.gotoRooms();
      } else {
        this.updateButtons();
        await this.loadRooms(true);
        showDomToast(t('Вход через Яндекс выполнен'));
      }
    } catch (e) {
      this.setBusy('');
      this.reportYandexResult(fromAuthPage, t((e as Error).message) || t('Не удалось войти'), true);
    }
  }

  private reportYandexResult(fromAuthPage: boolean, text: string, warn: boolean): void {
    if (fromAuthPage || this.page === 'auth') setNote(this.authNoteLab, text, warn);
    else showDomToast(text);
  }

  // Экран ещё жив и не ушёл на другую страницу, пока шёл асинхронный шаг.
  private alive(): boolean {
    return this.pageAuth?.parent != null || this.pageRooms?.parent != null;
  }

  // =============================================================== подключение

  // Скрытый вход для вернувшегося игрока: логин/пароль сохранены в
  // браузере — форма входа не показывается.
  private async tryAutoLogin(): Promise<void> {
    if (this.app.api.user || !this.app.api.hasSavedCredentials) return;
    try {
      await this.app.api.guestLogin(this.app.api.nick || '');
    } catch {
      // аккаунт не восстановился — показываем форму с именем
    }
  }

  // _enter-порт: связь уже есть — сразу по состоянию, иначе подключаемся.
  async enter(): Promise<void> {
    this.startTimers();
    this.updateStatus();
    if (this.app.api.isOpen) {
      await this.routeAfterConnection();
      return;
    }
    await this.doConnect();
  }

  private fillAuthDefaults(): void {
    if (this.nickEdit.text === '') this.nickEdit.text = this.app.api.nick;
  }

  private authPageActive(): boolean {
    return this.page === 'auth' && this.pageAuth?.parent != null;
  }

  private async routeAfterConnection(): Promise<void> {
    await this.tryAutoLogin();
    if (this.app.api.user) {
      if (this.currentRoom) this.applyRoom(this.currentRoom);
      else await this.gotoRooms();
      return;
    }
    this.setPage('auth');
    this.fillAuthDefaults();
    setNote(this.authNoteLab, '', false);
    if (platform.id === 'yandex') void this.tryAuthorizedYandexLogin();
    this.updateButtons();
  }

  // Если Яндекс ID уже авторизован в контейнере, не показываем лишний
  // диалог. Гостевой lite-ID используется только после явного выбора игрока.
  private async tryAuthorizedYandexLogin(): Promise<void> {
    if (this.app.api.user || this.busyFlag) return;
    this.setBusy(t('Получаем профиль Яндекс…'));
    const profile = await platform.getPlayer();
    if (!this.authPageActive() || !profile?.uid || !profile.authorized || this.app.api.user) {
      this.setBusy('');
      return;
    }
    this.setBusy(t('Входим через Яндекс…'));
    try {
      await this.app.api.yandexLogin(profile.uid, profile.name || t('Гость'));
      localStorage.setItem(YA_AUTH_UID_KEY, profile.uid);
      this.setBusy('');
      await this.gotoRooms();
    } catch (e) {
      this.setBusy('');
      setNote(this.authNoteLab, t((e as Error).message) || t('Не удалось войти'), true);
    }
  }

  // _do_connect-порт: сессия общая для кластера, вход на любом сервере
  // открывает комнаты; партия живёт только на своём сервере, поэтому
  // сервер выбирается один раз и не меняется посреди игры.
  async doConnect(): Promise<void> {
    if (this.connecting) return;
    // Главное меню может уже поднимать сохранённую сессию. Дождёмся этого
    // рукопожатия, чтобы не открыть второй сокет и не вытеснить себя из
    // комнаты во время resume.
    await this.app.waitForMenuConnection();
    if (this.app.api.isOpen) {
      this.updateStatus();
      await this.routeAfterConnection();
      return;
    }
    this.connecting = true;
    let lastErr = '';
    // сначала гоночный опрос: входим на быстрейший живой сервер
    try {
      this.setBusy(t('Подключаемся к серверу…'));
      await this.app.api.connectFastest();
    } catch (e) {
      // никто не ответил гонкой — обычный последовательный перебор
      for (const ref of listServerRefs()) {
        this.setBusy(t('Подключаемся к %s…', t(ref.name)));
        try {
          await this.app.api.connect(ref.id);
          lastErr = '';
          break;
        } catch (e2) {
          if (e2 instanceof AuthError) {
            // Сокет жив, сессии нет — дальше работает форма входа.
            lastErr = '';
            break;
          }
          lastErr = (e2 as Error).message;
        }
      }
      if (lastErr === '' && !this.app.api.isOpen) {
        // ни гонка, ни перебор не дали сокета
        lastErr = (e as Error).message || t('Нет связи с сервером');
      }
    }
    this.connecting = false;
    this.setBusy('');
    this.updateStatus();
    if (lastErr !== '' || !this.app.api.isOpen) {
      setNote(this.busyLab, lastErr === '' ? t('Нет связи с сервером') : t(lastErr), true);
      return;
    }
    await this.routeAfterConnection();
  }

  // =============================================================== комнаты

  private async gotoRooms(): Promise<void> {
    this.setPage('rooms');
    if (this.rooms.length === 0) {
      await this.loadRooms(false);
    } else {
      this.renderRooms();
      this.updateButtons();
    }
  }

  // _load_rooms-порт: список комнат сервер отдаёт только вошедшим.
  private async loadRooms(quiet: boolean): Promise<void> {
    const api = this.app.api;
    if (!api.user) {
      this.setPage('auth');
      this.fillAuthDefaults();
      this.updateButtons();
      return;
    }
    if (!api.isOpen) {
      await this.doConnect();
      if (!api.isOpen) return;
    }
    this.roomsLoading = true;
    if (!quiet) this.setBusy(t('Собираем список комнат…'));
    try {
      const res = await api.roomsAll();
      this.rooms = res.rooms;
      this.roomsPage = 0;
      // Технические сведения о серверах кластера игроку не нужны — оставляем
      // только число найденных комнат.
      this.setRoomsNote(t('Комнат найдено: %d', this.rooms.length), false);
    } catch (e) {
      this.rooms = [];
      this.setRoomsNote(t((e as Error).message) || t('Не удалось получить список'), true);
    }
    this.roomsLoading = false;
    if (!quiet) this.setBusy('');
    if (this.page === 'rooms') this.renderRooms();
    this.updateButtons();
  }

  private setRoomsNote(text: string, warn: boolean): void {
    setNote(this.roomsNoteLab, t(text), warn);
    this.layoutRoomsHeader();
  }

  private layoutRoomsHeader(): void {
    if (!this.roomsNoteLab || !this.refreshBtn || !this.roomsHeader || !this.roomsRefreshRow) return;
    const noteFont = fs(15);
    // Пустое примечание скрываем: иначе вертикальный StackPanel всё равно
    // резервирует промежуток под этим ребёнком, а высоту шапки считали без
    // него — кнопку «Обновить» срезало снизу на эти самые пиксели.
    const hasNote = this.roomsNoteLab.text.trim() !== '';
    this.roomsNoteLab.isVisible = hasNote;
    const noteH = hasNote
      ? estimateWrappedTextHeight(this.roomsNoteLab.text, this.avail, noteFont) + 4
      : 0;
    this.roomsNoteLab.fontSize = noteFont;
    this.roomsNoteLab.width = px(this.avail);
    this.roomsNoteLab.height = px(noteH);
    this.roomsNoteLab.resizeToFit = false;
    const buttonFont = fs(15);
    const buttonH = Math.max(SMALL_H, Math.ceil(buttonFont * 1.7));
    const buttonW = Math.min(this.avail, Math.max(120, Math.ceil(measureTextWidth(t('Обновить'), buttonFont)) + 32));
    this.refreshBtn.width = px(buttonW);
    this.refreshBtn.height = px(buttonH);
    this.refreshBtn.fontSize = buttonFont;
    this.refreshBtn.textBlock!.fontSize = buttonFont;
    this.refreshBtn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    this.refreshBtn.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    this.roomsRefreshRow.height = px(buttonH);
    this.roomsRefreshRow.width = '100%';
    this.roomsHeader.height = px(noteH + (hasNote ? 4 : 0) + buttonH);
  }

  private async refreshRooms(quiet: boolean): Promise<void> {
    // Обновление уже летит: второе вдогонку перетёрло бы ответы.
    if (this.roomsLoading || this.busyFlag) return;
    await this.loadRooms(quiet);
  }

  private renderRooms(): void {
    this.roomsBox.clearControls();
    const total = this.rooms.length;
    const pages = Math.max(1, Math.ceil(total / ROOMS_PAGE_SIZE));
    this.roomsPage = Math.max(0, Math.min(this.roomsPage, pages - 1));
    let renderedHeight = 0;
    if (total === 0) {
      const empty = mkLabel(t('Пока никто не создал комнату. Создайте свою.'), {
        fontSize: fs(16),
        color: WEAK50,
        width: '100%',
        height: 44,
        hAlign: 'left',
      });
      empty.resizeToFit = true;
      empty.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
      this.roomsBox.addControl(empty);
      renderedHeight = ROOMS_MIN_H;
    } else {
      const start = this.roomsPage * ROOMS_PAGE_SIZE;
      const end = Math.min(start + ROOMS_PAGE_SIZE, total);
      for (let i = start; i < end; i += 1) {
        const row = this.roomRow(this.rooms[i]);
        this.roomsBox.addControl(row);
        renderedHeight += Number.parseFloat(String(row.height)) || 56;
        if (i > start) renderedHeight += this.roomsBox.spacing;
      }
    }
    // Карточки при крупном тексте могут быть выше стандартного окна списка;
    // пусть растёт содержимое внешнего скролла, а не обрезается сама карточка.
    this.roomsBox.height = px(Math.max(ROOMS_MIN_H, renderedHeight));
    this.pageRow.isVisible = pages > 1;
    this.pageLabel.text = t('Стр. %d из %d', this.roomsPage + 1, pages);
    const disable = this.busyFlag;
    this.pagePrev.isEnabled = !disable;
    this.pageNext.isEnabled = !disable;
    this.updatePagination();
  }

  private pageStep(dir: number): void {
    const pages = Math.max(1, Math.ceil(this.rooms.length / ROOMS_PAGE_SIZE));
    this.roomsPage = Math.max(0, Math.min(this.roomsPage + dir, pages - 1));
    this.renderRooms();
  }

  // _make_room_row-порт: карточка «название · заполнение · флаги» + Войти.
  private roomRow(room: RoomWithServer): StackPanel {
    const row = new StackPanel('roomRow');
    row.isVertical = false;
    row.width = '100%';
    row.height = px(56);

    const card = softPanel({
      bg: 'rgba(255,255,255,0.05)',
      border: 'rgba(255,255,255,0.12)',
      thickness: 1,
      corner: 10,
    });
    card.root.width = '100%';
    card.root.height = '100%';
    row.addControl(card.root);

    let text = t('%s · %d/%d', room.name || '?', room.filled, room.seats);
    // Идущая партия тоже в списке: в неё можно войти вместо бота.
    if (room.state === 'playing') text += t(' · идёт');
    if (room.bots > 0) text += t(' · боты %d', room.bots);
    if (room.hasPassword) text += t(' · пароль');

    const font = fs(16);
    const buttonFont = fs(16);
    const pad = 12;
    const gap = 10;
    const joinW = Math.max(84, Math.ceil(measureTextWidth(t('Войти'), buttonFont)) + 28);
    const buttonH = Math.max(38, Math.ceil(buttonFont * 1.55));
    // Ширина содержимого карточки: сверху/снизу скруглённая карточка на всю
    // ширину колонки, внутри — поля pad по краям.
    const innerW = Math.max(80, this.avail - 24);
    const contentW = Math.max(60, innerW - 2 * pad);
    // Текст слева, кнопка справа. Если тексту не остаётся места (узкий
    // экран) или он не влезает в одну строку — кнопка уходит вниз, а не
    // наезжает на текст.
    const sideLabelW = Math.max(60, contentW - joinW - gap);
    const sideWrapped = wrapTextToWidth(text, sideLabelW, font);
    const sideLabelH = estimateWrappedTextHeight(sideWrapped, sideLabelW, font);
    const stacked = sideLabelW < 110 || sideLabelH > buttonH + 6;
    const labelW = stacked ? contentW : sideLabelW;
    const wrappedText = stacked ? wrapTextToWidth(text, contentW, font) : sideWrapped;
    const labelH = stacked ? estimateWrappedTextHeight(wrappedText, contentW, font) : sideLabelH;
    const rowH = stacked
      ? pad + labelH + 6 + buttonH + pad
      : Math.max(buttonH + 2 * pad, labelH + 2 * pad);
    row.height = px(rowH);
    const lab = mkLabel(wrappedText, {
      fontSize: font,
      color: WHITE90,
      width: labelW,
      height: stacked ? labelH : rowH - 2 * pad,
      noWrap: false,
      align: 'left',
      vAlign: 'center',
    });
    // Текст и контрол — строго по левому краю с отступом pad (раньше был
    // задан только hAlign, а текст внутри центрировался — отсюда «отступ»).
    lab.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    lab.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    lab.verticalAlignment = stacked ? Control.VERTICAL_ALIGNMENT_TOP : Control.VERTICAL_ALIGNMENT_CENTER;
    lab.left = px(pad);
    lab.top = px(stacked ? pad : 0);
    card.root.addControl(lab);

    const join = accentButton(t('Войти'), BUTTON_STYLE.deck, buttonH, buttonFont, joinW);
    join.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    join.verticalAlignment = stacked ? Control.VERTICAL_ALIGNMENT_BOTTOM : Control.VERTICAL_ALIGNMENT_CENTER;
    join.left = px(-pad);
    if (stacked) join.top = px(-pad);
    join.onPointerUpObservable.add(() =>
      void this.doJoin(room.code, room.hasPassword ? this.joinPass.text : ''));
    card.root.addControl(join);
    return row;
  }

  // =============================================================== действия комнат

  // _do_join-порт: лобби комнаты или — если вошли последним/вместо бота —
  // уже сама партия (в ответе придёт game.state).
  private async doJoin(code: string, password: string): Promise<void> {
    const api = this.app.api;
    if (code === '') return;
    // Повторный вход по кнопке списка — новое явное действие возврата;
    // старый started latch не должен проглотить GAME_STATE.
    this.started = false;
    if (!api.user) {
      this.setPage('auth');
      this.fillAuthDefaults();
      this.updateButtons();
      return;
    }
    if (!api.isOpen) {
      await this.doConnect();
      if (!api.isOpen) return;
    }
    this.setBusy(t('Заходим в %s…', code));
    try {
      // комната могла быть на другом сервере: сначала переключаем связь
      const target = this.rooms.find((r) => r.code.toUpperCase() === code.toUpperCase());
      if (target && api.ref && target.serverId !== api.ref.id) {
        await api.connect(target.serverId);
      }
      const env = await api.joinRoom(code, password);
      this.setBusy('');
      if (env.t === 'room.state') {
        this.applyRoom(env.room);
        return;
      }
      this.enterGame(env);
    } catch (e) {
      // комнаты нет на текущем сервере — обходим остальные живые
      // (online_lobby.gd:967-990)
      const others = listServerRefs().filter((r) => r.id !== api.ref?.id);
      for (const ref of others) {
        try {
          await api.connect(ref.id);
          const env = await api.joinRoom(code, password);
          this.setBusy('');
          if (env.t === 'room.state') {
            this.applyRoom(env.room);
            return;
          }
          this.enterGame(env);
          return;
        } catch {
          /* следующий сервер */
        }
      }
      this.setBusy('');
      const reason = (e as Error).message;
      if (reason === 'Комната не найдена'
        && this.app.api.pendingRoom?.code.toUpperCase() === code.toUpperCase()) {
        // Сервер больше не держит место: не оставляем в меню обещание
        // вернуться в уже удалённую комнату (online_lobby.gd:985-989).
        this.app.api.parkRoom(null);
      }
      this.setRoomsNote(t(reason) || t('Не удалось войти в комнату'), true);
    }
  }

  private async doCreate(): Promise<void> {
    const api = this.app.api;
    if (!api.user) {
      this.setPage('auth');
      this.fillAuthDefaults();
      this.updateButtons();
      return;
    }
    if (!api.isOpen) {
      await this.doConnect();
      if (!api.isOpen) return;
    }
    // комнату создаём на случайном живом сервере (online_lobby.gd:1044)
    const live = api.liveServerRefs();
    const pick = live[Math.floor(Math.random() * live.length)];
    if (pick && api.ref && pick.id !== api.ref.id) {
      try {
        await api.connect(pick.id);
      } catch {
        /* останемся на текущем */
      }
    }
    const seats = 2 + this.seatsDropdown.getSelected();
    this.setBusy(t('Создаём комнату…'));
    try {
      const env = await api.createRoom({
        seats,
        require30: this.require30,
        name: this.roomName.text,
        password: this.roomPass.text,
      });
      this.setBusy('');
      this.applyRoom(env.room);
    } catch (e) {
      this.setBusy('');
      this.setRoomsNote(t((e as Error).message) || t('Не удалось создать комнату'), true);
    }
  }

  // _do_quick-порт: заходим в самую полную публичную комнату с людьми;
  // нет такой — создаём свою на 4 места и ждём в ней.
  private async doQuick(): Promise<void> {
    const api = this.app.api;
    if (!api.user) {
      this.setPage('auth');
      this.fillAuthDefaults();
      this.updateButtons();
      return;
    }
    await this.loadRooms(false);
    const target = this.pickQuickRoom();
    if (target) {
      await this.doJoin(target.code, '');
      return;
    }
    if (!api.isOpen) {
      await this.doConnect();
      if (!api.isOpen) return;
    }
    this.setBusy(t('Создаём комнату…'));
    try {
      const env = await api.createRoom({
        seats: 4,
        require30: this.require30,
        name: t('Быстрая игра'),
        password: '',
      });
      this.setBusy('');
      this.applyRoom(env.room);
    } catch (e) {
      this.setBusy('');
      this.setRoomsNote(t((e as Error).message) || t('Не удалось создать комнату'), true);
    }
  }

  // _pick_quick_room-порт: публичная, где уже есть люди; из нескольких —
  // самая полная, там живее всего.
  private pickQuickRoom(): RoomWithServer | null {
    let best: RoomWithServer | null = null;
    let bestFilled = 0;
    for (const r of this.rooms) {
      if (r.hasPassword || r.filled < 1) continue;
      if (r.filled > bestFilled) {
        bestFilled = r.filled;
        best = r;
      }
    }
    return best;
  }

  // =============================================================== лобби комнаты

  // _show_lobby-порт.
  applyRoom(room: RoomLobbyView): void {
    this.started = false;
    this.currentRoom = room;
    this.setPage('lobby');
    this.lobbyCodeLab.text = t('Комната %s', room.code);
    setNote(this.lobbyNoteLab, '', false);

    this.lobbyPlayers.clearControls();
    // Сервер присылает ВСЕ места, включая пустые: считаем занятые сами,
    // иначе «Начать» была бы всегда доступна.
    let taken = 0;
    for (const p of room.players) {
      if (!p.empty) taken += 1;
      let nick = p.nick;
      if (p.empty) nick = t('— свободно —');
      else if (!p.connected) nick += t(' (нет связи)');
      if (p.seat === room.you) nick = t('» ') + nick;
      const line = mkLabel(t('Место %d:  %s', p.seat + 1, nick), {
        fontSize: fs(15),
        color: p.seat === room.you ? '#90CAF9' : WHITE85,
        width: '100%',
        height: 22,
        hAlign: 'left',
      });
      line.resizeToFit = true;
      line.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
      this.lobbyPlayers.addControl(line);
    }
    this.lobbyReady = taken >= 2;
    this.lobbySeats.text = t('%s · свободно %d из %d · первый ход: %s',
      t(this.app.api.ref?.name ?? '?'), Math.max(0, room.seats - taken), room.seats,
      room.require30 ? t('от 30') : t('любой'));

    const isHost = room.isHost;
    this.startBtn.isVisible = isHost;
    if (isHost) {
      setButtonLabel(this.startBtn, this.lobbyReady
        ? t('Начать партию')
        : t('Ждём игроков (%d из %d)', taken, room.seats));
    }
    setNote(this.lobbyNoteLab, taken >= room.seats
      ? t('Все на месте. %s', isHost ? t('Начинайте.') : t('Ждём, начнёт хост.'))
      : t('Ждём остальных игроков (%d из %d).', taken, room.seats), false);
    this.updateButtons();
  }

  private async doCopyCode(): Promise<void> {
    const code = this.currentRoom?.code;
    if (!code) return;
    const ok = await platform.writeClipboard(code);
    showDomToast(t(ok ? 'Код скопирован' : 'Не удалось скопировать'));
  }

  private enterGame(env: GameEnvelope): void {
    // Смена экрана уже заказана broadcast'ом — повторный вызов
    // осиротил бы первый экземпляр.
    if (this.started) return;
    this.started = true;
    this.app.enterGame(env);
  }

  private async doStart(): Promise<void> {
    if (!this.currentRoom?.isHost) return;
    this.setBusy(t('Начинаем…'));
    try {
      const env = await this.app.api.startRoom();
      this.setBusy('');
      if (env.t === 'game.state') {
        this.enterGame(env);
        return;
      }
      setNote(this.lobbyNoteLab, t('Не удалось начать партию'), true);
    } catch (e) {
      this.setBusy('');
      setNote(this.lobbyNoteLab, t((e as Error).message) || t('Не удалось начать партию'), true);
    }
  }

  private async doLeaveRoom(): Promise<void> {
    this.setBusy(t('Покидаем комнату…'));
    try {
      await this.app.api.leaveRoom();
    } catch { /* комната могла закрыться сама */ }
    this.setBusy('');
    this.currentRoom = null;
    this.setPage('rooms');
    await this.loadRooms(false);
  }

  // =============================================================== таблица лидеров

  private async openBoard(): Promise<void> {
    if (this.boardOpen) return;
    this.boardOpen = true;
    const { overlay, close } = modalOverlay(this.popups, 'board', { alpha: 0.6, zIndex: 950 });
    const showYandex = platform.id === 'yandex';
    const vh = viewHeight();
    const ROW_H = 26;
    const MAX_ENTRIES = 10;
    const MAX_LIST_H = MAX_ENTRIES * ROW_H + 4;
    const panelW = Math.max(160, Math.min(480, viewWidth() - 32));
    // Убираем горизонтальный скролл геометрией: контентная ширина фиксирована
    // с вычетом полей панели, а строки таблицы используют только её остаток.
    const contentW = Math.max(128, panelW - 32);
    const modalScrollH = Math.max(120, vh - 24);
    const GAP = 8;
    const PAD_Y = 12;
    const TITLE_H = 30;
    const RANK_H = 24;
    const NOTE_H = 34;
    const TOGGLE_H = 36;
    const CLOSE_H = 44;

    const panel = softPanel({
      bg: SKIN.panelDark,
      bgAlpha: 0.98,
      corner: 10,
      width: panelW,
      height: 320,
    });
    panel.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    panel.root.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    let modalScroll: ScrollViewer | null = null;
    const setPanelHeight = (height: number): void => {
      panel.root.height = px(height);
      const needsScroll = height > modalScrollH;
      if (needsScroll && !modalScroll) {
        overlay.removeControl(panel.root);
        modalScroll = new ScrollViewer('boardModalScroll');
        modalScroll.thickness = 0;
        modalScroll.barSize = 4;
        // Вертикальная полоса не должна сжимать дочернюю панель и создавать
        // горизонтальное переполнение. Горизонтальный скролл здесь не нужен.
        modalScroll.width = px(panelW + 6);
        modalScroll.height = px(modalScrollH);
        modalScroll.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
        modalScroll.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        modalScroll.horizontalBar.isVisible = false;
        overlay.addControl(modalScroll);
        modalScroll.addControl(panel.root);
        enableSmoothScroll(modalScroll);
      } else if (!needsScroll && modalScroll) {
        modalScroll.removeControl(panel.root);
        overlay.removeControl(modalScroll);
        modalScroll = null;
        panel.root.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        overlay.addControl(panel.root);
      } else if (!modalScroll) {
        panel.root.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
      }
      if (modalScroll) panel.root.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    };
    overlay.addControl(panel.root);

    const box = new StackPanel('boardBox');
    box.isVertical = true;
    box.spacing = GAP;
    box.width = px(contentW);
    box.height = '100%';
    box.paddingLeft = '0px';
    box.paddingRight = '0px';
    box.paddingTop = px(PAD_Y);
    box.paddingBottom = px(PAD_Y);
    box.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    panel.root.addControl(box);

    box.addControl(mkLabel(showYandex ? t('Лидеры Яндекс Игр') : t('Таблица лидеров'), {
      fontSize: fs(20), color: GOLD, height: TITLE_H,
    }));
    let yaGrid: StackPanel | null = null;
    let yaRankLab: ReturnType<typeof mkLabel> | null = null;
    let yaNoteLab: ReturnType<typeof mkLabel> | null = null;
    let serverToggle: Button | null = null;
    let serverExpanded = false;
    if (showYandex) {
      yaGrid = new StackPanel('yaBoardGrid');
      yaGrid.isVertical = true;
      yaGrid.spacing = 4;
      yaGrid.width = '100%';
      yaGrid.height = px(0);
      yaGrid.isVisible = false;
      box.addControl(yaGrid);
      yaRankLab = mkLabel('', { fontSize: fs(15), color: '#90CAF9', width: '100%', height: RANK_H });
      yaRankLab.isVisible = false;
      box.addControl(yaRankLab);
      yaNoteLab = mkLabel(t('Загружаем таблицу Яндекса…'), {
        fontSize: fs(13), color: WHITE85, width: '100%', height: NOTE_H, noWrap: false,
      });
      box.addControl(yaNoteLab);
      serverToggle = greyButton(t('Показать общий топ'), TOGGLE_H, fs(13), contentW);
      serverToggle.onPointerUpObservable.add(() => {
        serverExpanded = !serverExpanded;
        serverSection.isVisible = serverExpanded;
        setButtonLabel(serverToggle!, t(serverExpanded
          ? 'Скрыть общий топ'
          : 'Показать общий топ'));
        setPanelHeight(calculatePanelHeight());
      });
      box.addControl(serverToggle);
    }

    const serverSection = new StackPanel('serverBoardSection');
    serverSection.isVertical = true;
    serverSection.spacing = 6;
    serverSection.width = '100%';
    serverSection.isVisible = !showYandex;
    serverSection.addControl(mkLabel(t(showYandex ? 'Все платформы' : 'Общий рейтинг всех платформ'), {
      fontSize: fs(15), color: WHITE90, height: 24,
    }));
    const grid = new StackPanel('boardGrid');
    grid.isVertical = true;
    grid.spacing = 4;
    grid.width = '100%';
    grid.height = px(0);
    grid.isVisible = false;
    serverSection.addControl(grid);

    const meLab = mkLabel('', { fontSize: fs(14), color: '#90CAF9', width: '100%', height: 40, noWrap: false });
    serverSection.addControl(meLab);
    const serverNoteLab = mkLabel('', {
      fontSize: fs(13), color: NOTE, width: '100%', height: NOTE_H, noWrap: false,
    });
    serverSection.addControl(serverNoteLab);
    box.addControl(serverSection);

    let open = true;
    const doClose = (): void => {
      if (!open) return;
      open = false;
      this.boardOpen = false;
      close();
    };
    const cl = accentButton(t('Закрыть'), BUTTON_STYLE.green, CLOSE_H, fs(16), contentW);
    cl.onPointerUpObservable.add(doClose);
    box.addControl(cl);
    const dim = overlay.children[0] as Rectangle;
    dim.onPointerUpObservable.add(doClose);

    let serverListH = 0;
    const getServerSectionHeight = (): number => {
      const heights = [24];
      if (grid.isVisible) heights.push(serverListH);
      heights.push(40);
      if (serverNoteLab.isVisible) heights.push(NOTE_H);
      return heights.reduce((sum, height) => sum + height, 0)
        + serverSection.spacing * Math.max(0, heights.length - 1);
    };
    const calculatePanelHeight = (): number => {
      let children = [TITLE_H];
      if (showYandex) {
        if (yaGrid?.isVisible) children.push(yaGrid.heightInPixels || 0);
        if (yaRankLab?.isVisible) children.push(RANK_H);
        if (yaNoteLab?.isVisible) children.push(NOTE_H);
        children.push(TOGGLE_H);
      }
      if (!showYandex || serverExpanded) children.push(getServerSectionHeight());
      children.push(CLOSE_H);
      return PAD_Y * 2 + children.reduce((sum, height) => sum + height, 0)
        + GAP * Math.max(0, children.length - 1);
    };
    setNote(serverNoteLab, t('Загружаем таблицу…'), false);
    serverNoteLab.isVisible = true;
    serverSection.height = px(getServerSectionHeight());
    setPanelHeight(calculatePanelHeight());
    meLab.text = '';
    grid.clearControls();
    const yaLoad = showYandex
      ? platform.getLeaderboardEntries('wins')
      : Promise.resolve(null);
    const [serverResult, yaResult] = await Promise.allSettled([
      this.app.api.boardList(),
      yaLoad,
    ]);
    if (!open) return;

    if (serverResult.status === 'fulfilled') {
      const res: BoardListMsg = serverResult.value;
      this.renderBoard(res, grid, meLab, serverNoteLab, contentW);
      const n = Math.min(MAX_ENTRIES, (res.entries ?? []).length);
      if (n === 0) {
        grid.isVisible = false;
        grid.height = px(0);
        serverListH = 0;
        setNote(serverNoteLab, '', false);
      } else {
        grid.isVisible = true;
        serverListH = Math.min(MAX_LIST_H, n * ROW_H + 4);
        grid.height = px(serverListH);
      }
    } else {
      grid.isVisible = false;
      grid.height = px(0);
      serverListH = 0;
      meLab.text = '';
      setNote(serverNoteLab, t((serverResult.reason as Error).message) || t('Не удалось загрузить таблицу'), true);
    }
    serverSection.height = px(getServerSectionHeight());

    if (showYandex && yaGrid && yaRankLab && yaNoteLab) {
      yaGrid.clearControls();
      if (yaResult.status === 'fulfilled' && yaResult.value) {
        const data = yaResult.value;
        this.renderYandexBoard(data, yaGrid, yaRankLab, yaNoteLab, contentW);
        const n = Math.min(MAX_ENTRIES, data.entries.length);
        yaGrid.isVisible = n > 0;
        yaGrid.height = px(n > 0 ? Math.min(MAX_LIST_H, n * ROW_H + 4) : 0);
      } else {
        yaGrid.isVisible = false;
        yaGrid.height = px(0);
        yaRankLab.text = '';
        yaRankLab.isVisible = false;
        setNote(yaNoteLab, t('Не удалось загрузить таблицу Яндекса'), true);
      }
    }
    serverSection.height = px(getServerSectionHeight());
    setPanelHeight(calculatePanelHeight());
  }

  private renderYandexBoard(
    data: Awaited<ReturnType<typeof platform.getLeaderboardEntries>>,
    grid: StackPanel,
    rankLab: ReturnType<typeof mkLabel>,
    noteLab: ReturnType<typeof mkLabel>,
    contentW: number,
  ): void {
    grid.clearControls();
    const entries = data.entries.slice(0, 10);
    if (entries.length === 0) {
      grid.isVisible = false;
      setNote(noteLab, data.error
        ? t('Не удалось загрузить таблицу Яндекса')
        : t('Нет сыгранных партий'), !!data.error);
    } else {
      grid.isVisible = true;
      setNote(noteLab, '', false);
      const nameW = Math.max(28, contentW - 100);
      entries.forEach((entry, i) => {
        const rank = entry.rank > 0 ? entry.rank : i + 1;
        const row = hrow(12);
        row.width = '100%';
        row.height = px(22);
        row.addControl(mkLabel(`${rank}.`, {
          fontSize: fs(15), noWrap: true, color: rankColor(rank, false),
          width: 34, height: 22, hAlign: 'left',
        }));
        row.addControl(mkLabel(textTruncate(entry.name, fs(15), nameW), {
          fontSize: fs(15), noWrap: true, color: WHITE90,
          width: nameW, height: 22, hAlign: 'left',
        }));
        row.addControl(mkLabel(String(entry.score), {
          fontSize: fs(15), noWrap: true, color: WHITE90,
          width: 42, height: 22, hAlign: 'right',
        }));
        grid.addControl(row);
      });
    }
    rankLab.text = data.userRank > 0
      ? t('Ваше место: %d', data.userRank)
      : '';
    rankLab.isVisible = data.userRank > 0;
  }

  // _render_board-порт: строки «место · игрок · победы».
  private renderBoard(
    res: BoardListMsg,
    grid: StackPanel,
    meLab: ReturnType<typeof mkLabel>,
    noteLab: ReturnType<typeof mkLabel>,
    contentW: number,
  ): void {
    grid.clearControls();
    const nameW = Math.max(28, Math.min(340, contentW - 100));
    const entries = (res.entries ?? []).slice(0, 10);
    if (entries.length === 0) {
      setNote(noteLab, t('Нет сыгранных партий'), false);
    } else {
      setNote(noteLab, '', false);
    }
    const myNick = res.me?.nick ?? '';
    entries.forEach((e, i) => {
      const mine = myNick !== '' && e.nick === myNick;
      const row = hrow(12);
      row.width = '100%';
      row.height = px(22);
      row.addControl(mkLabel(`${i + 1}.`, {
        fontSize: fs(15), noWrap: true,
        color: rankColor(i + 1, mine), width: 34, height: 22, hAlign: 'left',
      }));
      row.addControl(mkLabel(textTruncate(e.nick, fs(15), nameW), {
        fontSize: fs(15), noWrap: true,
        color: mine ? '#90CAF9' : WHITE90, width: nameW, height: 22, hAlign: 'left',
      }));
      row.addControl(mkLabel(String(e.wins), {
        fontSize: fs(15), noWrap: true,
        color: mine ? '#90CAF9' : WHITE90, width: 42, height: 22, hAlign: 'right',
      }));
      grid.addControl(row);
    });
    if (res.me) {
      meLab.text = t('Ваше место: %d · побед %d · партий %d', res.me.rank, res.me.wins, res.me.games);
    } else {
      meLab.text = t('Сыграйте партию, чтобы попасть в топ');
    }
  }

  // =============================================================== события сети (из App)

  // «Назад» в главное меню (online_lobby.gd close(), 203-218): комнату не
  // покидаем. Идущая партия — мягкий выход (место держится, сервер вернёт
  // room в ROOM_LEFT); лобби — просто паркуем локально. Возвращаем решение,
  // чтобы App сделал запрос/баннер.
  takeRoomForLeave(): { started: boolean; room: RoomLobbyView | null } {
    const out = { started: this.started, room: this.currentRoom };
    this.started = false;
    this.currentRoom = null;
    this.lobbyReady = false;
    return out;
  }

  // Игра закрылась в главное меню: забываем экранное состояние старой
  // комнаты, но pending в Api оставляем для баннера и последующего resume.
  resetAfterGameExit(): void {
    this.started = false;
    this.currentRoom = null;
    this.lobbyReady = false;
  }

  preparePendingReturn(): void {
    this.started = false;
    this.currentRoom = null;
    this.lobbyReady = false;
  }

  onRoomState(room: RoomLobbyView): void {
    this.applyRoom(room);
  }

  // ROOM_LEFT: комната закрылась (или нас выписали) — возвращаемся в список.
  onLeftRoom(): void {
    this.started = false;
    this.currentRoom = null;
    if (this.page === 'lobby') {
      this.setPage('rooms');
      void this.loadRooms(false);
    }
  }

  onSessionClosed(): void {
    this.updateStatus();
    setNote(this.busyLab, t('Нет связи с сервером'), true);
  }

  // ===== pending_room: «вы всё ещё в комнате» (net.gd 46-219) =====

  // Место сохранилось (мягкий выход / вход при живой комнате):
  // баннер на странице комнат с «Вернуться»/«Покинуть».
  applyPending(room: RoomLobbyView | null): void {
    this.pendingRoomState = room;
    if (!this.pendingBox) return;
    this.pendingBox.isVisible = room !== null;
    this.pendingLab.text = room
      ? (room.state === 'playing'
        ? t('Вы всё ещё в партии «%s». Вернуться?', room.name || room.code)
        : t('Вы всё ещё в комнате «%s». Вернуться?', room.name || room.code))
      : '';
    if (room) this.layoutPendingBox();
  }

  // Баннер растёт по высоте и складывает кнопки в колонку, если крупный
  // текст уже не помещается рядом. Фиксированная строка обрезала и подпись,
  // и кнопку «Покинуть» при масштабе ×2.
  private layoutPendingBox(): void {
    if (!this.pendingRoomState) return;
    const innerW = Math.max(120, this.avail - 24);
    const labelFont = fs(13);
    const labelH = estimateWrappedTextHeight(this.pendingLab.text, innerW, labelFont) + 4;
    this.pendingLab.fontSize = labelFont;
    this.pendingLab.width = px(innerW);
    this.pendingLab.height = px(labelH);
    this.pendingLab.left = px(12);
    this.pendingLab.top = px(8);
    this.pendingLab.resizeToFit = true;
    const buttonFont = fs(13);
    const buttonH = Math.max(SMALL_H, Math.ceil(buttonFont * 1.7));
    const returnW = Math.max(96, Math.ceil(measureTextWidth(this.pendingReturnBtn.textBlock!.text, buttonFont)) + 28);
    const leaveW = Math.max(88, Math.ceil(measureTextWidth(this.pendingLeaveBtn.textBlock!.text, buttonFont)) + 28);
    const stacked = returnW + leaveW + 8 > innerW;
    const buttonW = stacked ? innerW : Math.floor((innerW - 8) / 2);
    const actionsH = stacked ? buttonH * 2 + 8 : buttonH;
    this.pendingActions.isVertical = stacked;
    this.pendingActions.spacing = 8;
    this.pendingActions.width = px(innerW);
    this.pendingActions.height = px(actionsH);
    this.pendingActions.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    this.pendingActions.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    this.pendingActions.left = px(12);
    this.pendingActions.top = px(8 + labelH + 6);
    for (const b of [this.pendingReturnBtn, this.pendingLeaveBtn]) {
      b.width = px(buttonW);
      b.height = px(buttonH);
      b.fontSize = buttonFont;
      b.textBlock!.fontSize = buttonFont;
      b.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    }
    this.pendingBox.height = px(8 + labelH + 6 + actionsH + 8);
  }

  // Вернуться: идущая партия — через game.rejoin, лобби — room.join.
  // busyFlag здесь не преграда: вход в меню параллельно запускает сбор
  // списка комнат, и раньше этот флаг молча глотал «Вернуться».
  private returning = false;

  async returnToPending(): Promise<void> {
    const room = this.pendingRoomState;
    if (!room || this.returning) return;
    this.preparePendingReturn();
    this.returning = true;
    this.setBusy(t('Заходим в %s…', room.code));
    try {
      if (room.state === 'playing') {
        const env = await this.app.api.rejoin();
        this.setBusy('');
        this.onRoomStateOrGame(env);
        return;
      }
      const env = await this.app.api.joinRoom(room.code, '');
      this.setBusy('');
      this.onRoomStateOrGame(env);
    } catch (e) {
      this.setBusy('');
      const msg = (e as Error).message;
      // Комнаты больше нет: место не держится, баннер врал бы
      // (online_lobby.gd:985-989).
      if (msg.includes('не найдена')) this.app.api.parkRoom(null);
      this.showToast(msg);
    } finally {
      this.returning = false;
    }
  }

  // Покинуть место окончательно (room.drop).
  async dropPending(): Promise<void> {
    if (!this.pendingRoomState || this.returning) return;
    this.returning = true;
    this.setBusy(t('Покидаем комнату…'));
    try {
      await this.app.api.dropRoom();
    } catch {
      /* уже не существует */
    }
    this.setBusy('');
    this.returning = false;
  }

  // Ответ join/rejoin: лобби или сразу партия.
  private onRoomStateOrGame(env: RoomLobbyEnvelope | GameEnvelope): void {
    if (env.t === S2C.GAME_STATE) {
      if (this.started) return;
      this.started = true;
      this.app.enterGame(env as GameEnvelope);
      return;
    }
    this.applyRoom((env as RoomLobbyEnvelope).room);
  }

  // Серверный TOAST: показываем в busy-строке и прибираем через 4 с.
  showToast(text: string): void {
    if (this.busyFlag) return;
    setNote(this.busyLab, t(text), false);
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      if (!this.busyFlag) setNote(this.busyLab, '', false);
      this.toastTimer = null;
    }, 4000);
  }

  // =============================================================== таймеры

  private startTimers(): void {
    this.stopTimers();
    this.healthTimer = setInterval(() => void this.onHealthTick(), HEALTH_TICK_MS);
    this.roomsTimer = setInterval(() => void this.onRoomsTick(), ROOMS_TICK_MS);
  }

  stopTimers(): void {
    if (this.healthTimer !== null) clearInterval(this.healthTimer);
    if (this.roomsTimer !== null) clearInterval(this.roomsTimer);
    this.healthTimer = null;
    this.roomsTimer = null;
  }

  // _on_tick-порт: сервер умирает молча — сами пробуем вернуться.
  private async onHealthTick(): Promise<void> {
    const api = this.app.api;
    if (api.isOpen || this.connecting || this.busyFlag) return;
    // сессия сама переподключается с backoff — не мешаем вторым сокетом
    if (api.session.reconnecting) {
      this.updateStatus();
      return;
    }
    if (!api.ref) return;
    try {
      await api.connect(api.ref.id);
    } catch {
      return; // остаёмся офлайн до следующего тика
    }
    this.updateStatus();
    setNote(this.busyLab, '', false);
    this.updateButtons();
    if (api.user && this.page === 'rooms') void this.loadRooms(true);
  }

  // _on_rooms_tick-порт: раз в 10 секунд молча освежаем список, пока на
  // него смотрим: только чтение и только в покое.
  private async onRoomsTick(): Promise<void> {
    // Освежаем, только пока реально открыт экран комнат: таймер продолжает
    // жить и после ухода из «Игры по сети», и без этой проверки шли бы
    // лишние запросы в фоне.
    if (this.app.current !== 'online' || this.page !== 'rooms') return;
    if (this.busyFlag || this.roomsLoading || !this.app.api.user) return;
    await this.loadRooms(true);
  }
}
