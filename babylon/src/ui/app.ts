import { Scene } from '@babylonjs/core';
import { AdvancedDynamicTexture, Container } from '@babylonjs/gui';
import { Api } from '../net/api';
import { applyTitle, t } from '../core/lang';
import { MenuScreen } from '../ui2/menu_screen';
import { OfflineGame } from '../ui2/offline_game';
import { OnlineLobby } from '../ui2/online_lobby';
import { loadSettings } from '../core/settings';
import { GameState } from '../core/game_state';
import type { MenuHost, OfflineHost, OnlineStats, ScreenName } from '../ui2/ports';
import { GameEnvelope, RoomLobbyView } from '../net/protocol';
import { endInputSession, installGlobalTouchGuard, isInputSessionActive, onInputSessionEnd } from '../ui2/uiskin';
import { platform } from '../platform';

export class App implements MenuHost, OfflineHost {
  readonly adt: AdvancedDynamicTexture;
  readonly api = new Api();
  readonly menu: MenuScreen;
  readonly online: OnlineLobby;
  offline: OfflineGame | null = null;
  private root = new Container('root');
  private currentName: ScreenName | null = null;
  private menuConnectionTask: Promise<void> | null = null;
  // Пересборка, отложенная на время ввода: открытие мобильной клавиатуры
  // меняет размер canvas, но пересоздавать экран нельзя — вместе с полем
  // пропадут фокус и каретка.
  private pendingRelayout = false;
  private pendingRebuild = false;
  private relayoutTimer: number | null = null;
  private builtWidth = 0;
  private builtHeight = 0;

  constructor(
    readonly scene: Scene,
    readonly canvas: HTMLCanvasElement,
  ) {
    this.adt = AdvancedDynamicTexture.CreateFullscreenUI('ui', true, scene);
    this.adt.addControl(this.root);
    installGlobalTouchGuard(this.root);
    this.menu = new MenuScreen(this);
    this.online = new OnlineLobby(this);
    this.wireApi();
    onInputSessionEnd(() => this.schedulePendingRelayout());
    this.show('menu');
    this.startMenuConnection();
  }

  // Восстанавливаем авторизованную сессию, пока игрок ещё в главном меню:
  // сервер сразу сообщит, числится ли за ним комната/партия. Комната
  // привязана к своему серверу, поэтому сначала reconnect на прошлый host.
  private startMenuConnection(): void {
    // Площадка без БЭК/онлайна (YouTube Playables, GameDistribution):
    // не подключаемся к серверу и не показываем баннеры комнат.
    if (!platform.supportsOnline) return;
    if (this.api.isOpen || this.menuConnectionTask) return;
    const task = (async () => {
      try {
        const serverId = this.api.savedPendingServerId;
        if (serverId) await this.api.connect(serverId);
        else await this.api.connectFastest();
      } catch {
        // Не блокируем меню: при открытии сетевого экрана лобби повторит
        // обычный перебор доступных серверов и покажет причину.
      }
    })();
    let tracked: Promise<void>;
    tracked = task.finally(() => {
      if (this.menuConnectionTask === tracked) this.menuConnectionTask = null;
    });
    this.menuConnectionTask = tracked;
  }

  async waitForMenuConnection(): Promise<void> {
    await this.menuConnectionTask?.catch(() => undefined);
  }

  // MenuHost: меню и оверлеи пересобираются при смене языка/масштабов.
  rebuild(): void {
    // Пересборка во время ввода уничтожила бы поле (ввод уходил бы в уже
    // удалённый контрол). Откладываем до конца ввода.
    if (isInputSessionActive()) {
      this.pendingRebuild = true;
      return;
    }
    applyTitle();
    if (this.currentName === 'offline' && this.offline) {
      this.offline.build(this.root);
      this.offline.relayout();
      return;
    }
    if (this.currentName === 'online') {
      this.restoreOnline();
      return;
    }
    this.root.clearControls();
    if (this.currentName === 'menu') this.menu.build(this.root);
    window.dispatchEvent(new Event('resize'));
  }

  relayout(): void {
    // Пока игрок печатает, экран не пересобираем: на телефоне открытие
    // клавиатуры меняет высоту canvas, а пересборка уничтожила бы поле
    // вместе с фокусом и кареткой. Вернёмся к ней после конца ввода.
    if (isInputSessionActive()) {
      this.pendingRelayout = true;
      return;
    }
    if (this.currentName === 'menu') {
      // Меню строится в пикселях под конкретный размер экрана. При resize
      // и особенно при открытии игры на весь экран его нужно пересобрать,
      // иначе оно остаётся в габаритах прежнего маленького окна.
      this.root.clearControls();
      this.menu.build(this.root);
    } else if (this.currentName === 'offline' && this.offline) {
      this.offline.relayout();
    } else if (this.currentName === 'online') {
      this.restoreOnline();
    }
    this.builtWidth = this.canvas.clientWidth;
    this.builtHeight = this.canvas.clientHeight;
  }

  // Отложенная пересборка выполняется после blur поля, но не мгновенно:
  // тап по кнопке сразу после ввода должен успеть дойти до контрола.
  private schedulePendingRelayout(): void {
    if ((!this.pendingRelayout && !this.pendingRebuild) || this.relayoutTimer !== null) return;
    this.relayoutTimer = window.setTimeout(() => {
      this.relayoutTimer = null;
      if (!this.pendingRelayout && !this.pendingRebuild) return;
      // Успели перейти в другое поле — ждём конца ввода.
      if (isInputSessionActive()) return;
      if (this.pendingRebuild) {
        this.pendingRebuild = false;
        this.pendingRelayout = false;
        this.rebuild();
        this.builtWidth = this.canvas.clientWidth;
        this.builtHeight = this.canvas.clientHeight;
        return;
      }
      this.pendingRelayout = false;
      // Размер вернулся к тому, под который экран уже построен (клавиатура
      // закрылась) — пересобирать нечего.
      if (Math.round(this.canvas.clientWidth) === this.builtWidth
        && Math.round(this.canvas.clientHeight) === this.builtHeight) return;
      this.relayout();
    }, 150);
  }

  // Пересборка сетевого экрана (смена языка, поворот) не должна терять
  // лобби комнаты: последняя ROOM_STATE запоминается и подставляется
  // в новый экземпляр экрана.
  private restoreOnline(): void {
    this.online.build(this.root);
    this.online.applyPending(this.api.pendingRoom);
    if (this.lastLobby) this.online.onRoomState(this.lastLobby);
    else this.online.updateButtons();
  }

  private wireApi(): void {
    const l = this.api.listeners;
    l.onGame = (env) => {
      this.enterGame(env);
    };
    l.onLobby = (env) => {
      this.roomState(env.room);
    };
    l.onDraft = (msg) => this.offline?.applyDraft(msg);
    l.onError = (msg) => {
      if (this.current === 'offline' && this.offline) this.offline.onGameError(msg);
      else if (this.current === 'online') this.showToast(t(msg.reason ?? 'Ошибка'), true);
    };
    l.onToast = (msg) => this.showToast(msg.text, false);
    l.onLeft = () => {
      this.lastLobby = null;
      if (this.current === 'online') this.online.onLeftRoom();
    };
    l.onClosed = () => {
      if (this.current === 'offline' && this.offline) this.offline.onSessionClosed();
      this.lastLobby = null;
      if (this.current === 'online') this.online.onSessionClosed();
    };
    l.onQuick = () => undefined; // quick-очередь заменена матча-подбором по списку
    l.onPending = (room) => {
      this.online.applyPending(room);
      // главное меню показывает баннер «вы всё ещё в комнате» — обновляем
      // живьём, иначе он появляется только после повторного входа в меню
      if (this.currentName === 'menu') this.rebuild();
    };
  }

  private lastLobby: RoomLobbyView | null = null;

  // GAME_STATE: сетевая партия на том же 2D-экране, что и офлайн.
  enterGame(env: GameEnvelope): void {
    if (this.currentName === 'menu') {
      // Партия началась/идёт, пока мы в главном меню после парковки:
      // экран не подменяем, но место за нами держится — баннер должен
      // звать «вернуться в партию» (online_lobby.gd:289-301).
      this.lastLobby = null;
      this.api.parkRoom({
        code: env.state.code,
        name: env.state.code,
        seats: env.state.seats,
        require30: env.state.require30,
        hasPassword: false,
        state: 'playing',
        you: env.state.you,
        isHost: false,
        players: [],
      });
      return;
    }
    if (this.currentName !== 'offline') this.show('offline');
    if (!this.offline) this.offline = new OfflineGame(this);
    this.offline.onlineMode = true;
    this.offline.applyOnlineView(env);
  }

  // ROOM_STATE: лобби комнаты (гостевая) или возврат комнаты к ожиданию
  // после конца партии — рисуем страницы сетевого меню.
  roomState(room: RoomLobbyView): void {
    if (this.currentName === 'menu') {
      // В главном меню после парковки комнату не открываем: только
      // обновляем «вы всё ещё в комнате» (online_lobby.gd:1138-1151).
      this.lastLobby = null;
      this.api.parkRoom(room);
      return;
    }
    this.lastLobby = room;
    // партия кончилась/вернулись в лобби — экран игры останавливаем
    if (this.offline && this.offline.onlineMode) {
      this.offline.running = false;
      this.offline.stopTimers();
    }
    if (this.current !== 'online') this.show('online');
    this.online.onRoomState(room);
  }

  showToast(text: string, isError: boolean): void {
    void isError;
    if (this.current === 'offline' && this.offline) this.offline.toast(text);
    else if (this.current === 'online') this.online.showToast(text);
  }

  show(name: ScreenName): void {
    // Смена экрана очищает дерево контролов — активный ввод нужно корректно
    // завершить, иначе поле исчезнет вместе с набранным текстом.
    if (isInputSessionActive()) endInputSession();
    if (this.currentName === name) {
      this.rebuild();
      return;
    }
    // Уход с экрана партии — остановка геймплея для площадки.
    if (this.currentName === 'offline') platform.gameplayStop();
    this.currentName = name;
    // Sticky-баннер площадки: в меню/лобби показываем, во время партии
    // скрываем — реклама не должна мешать активной игре (п. 4.4).
    platform.setBannerVisible(name !== 'offline');
    this.root.clearControls();
    applyTitle();
    if (name === 'menu') {
      this.menu.build(this.root);
      this.startMenuConnection();
      return;
    }
    if (name === 'offline') {
      if (!this.offline) this.offline = new OfflineGame(this);
      this.offline.build(this.root);
      return;
    }
    if (name === 'online') {
      this.online.build(this.root);
      void this.online.enter();
      return;
    }
  }

  onStart(): void {
    this.show('offline');
    this.replay();
  }

  onOnline(): void {
    if (!platform.supportsOnline) return;
    this.show('online');
  }

  // pending_room для баннера главного меню
  pendingRoom(): RoomLobbyView | null {
    if (!platform.supportsOnline) return null;
    return this.api.pendingRoom;
  }

  // Сетевая статистика для окна «Статистика». Источник — серверная
  // таблица лидеров; локальные счётчики её не дублируют.
  async onlineStats(): Promise<OnlineStats | null> {
    if (!platform.supportsOnline) return null;
    const cached = this.api.user;
    if (this.api.session.isOpen) {
      try {
        const res = await this.api.boardList();
        if (res.me) {
          return { games: res.me.games, wins: res.me.wins, rank: res.me.rank };
        }
      } catch {
        // нет входа/связи — покажем кэш из auth, если он есть
      }
    }
    if (cached && typeof cached.games === 'number') {
      return { games: cached.games, wins: cached.wins ?? 0 };
    }
    return null;
  }

  onReturnToRoom(): void {
    this.online.preparePendingReturn();
    this.show('online');
    void this.online.returnToPending();
  }

  onDropRoom(): void {
    void this.online.dropPending();
  }

  // OnlineHost: «Назад» из сетевого меню. Комнату не покидаем —
  // место за нами сохраняется, как в оригинале (park_room).
  onLeaveOnline(): void {
    const { started, room } = this.online.takeRoomForLeave();
    this.lastLobby = null;
    if (started) {
      // Партия уже начата: мягкий выход, сервер пришлёт room в ROOM_LEFT,
      // и «вы всё ещё в партии» можно вернуть (online_lobby.gd:203-209).
      void this.api.leaveRoom();
    } else if (room) {
      // Лобби: комнату не трогаем на сервере, паркуем локально
      // (online_lobby.gd:210-215).
      this.api.parkRoom(room);
    }
    this.show('menu');
  }

  // OfflineHost
  toMenu(): void {
    platform.gameplayStop();
    if (this.offline?.onlineMode) {
      this.online.resetAfterGameExit();
      this.lastLobby = null;
    }
    if (this.offline) {
      this.offline.running = false;
      this.offline.stopTimers();
    }
    this.offline = null;
    this.show('menu');
  }

  // Сетевая партия кончилась — возврат в лобби комнаты (ROOM_STATE).
  toLobby(): void {
    platform.gameplayStop();
    if (this.offline) {
      this.offline.running = false;
      this.offline.stopTimers();
    }
    this.show('online');
  }

  replay(): void {
    const S = loadSettings();
    const names: string[] = [];
    for (let i = 0; i < S.player_count; i += 1) names.push(S.player_names[i] ?? '');
    const st = GameState.create(S.player_count, names, S.require_30);
    st.local_seat = -1;
    for (let i = 0; i < S.player_count; i += 1) {
      st.players[i].is_bot = S.player_is_bot[i] ?? false;
    }
    this.offline = new OfflineGame(this);
    this.offline.build(this.root);
    this.offline.startGame(st);
  }

  getScene(): Scene {
    return this.scene;
  }

  screenRoot(): Container {
    return this.root;
  }

  gameApi(): Api {
    return this.api;
  }

  rebuildScreen(): void {
    if (this.currentName === 'offline' && this.offline) {
      this.offline.build(this.root);
      this.offline.relayout();
    } else {
      this.rebuild();
    }
  }

  get current(): ScreenName | null {
    return this.currentName;
  }

  /** Партия реально идёт (для возобновления gameplay после сворачивания). */
  isPlaying(): boolean {
    return !!this.offline?.running;
  }
}

