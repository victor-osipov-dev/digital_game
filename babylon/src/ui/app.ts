import { Scene } from '@babylonjs/core';
import { AdvancedDynamicTexture, Container } from '@babylonjs/gui';
import { Api } from '../net/api';
import { applyTitle } from '../core/lang';
import { MenuScreen } from '../ui2/menu_screen';
import { OfflineGame } from '../ui2/offline_game';
import { OnlineLobby } from '../ui2/online_lobby';
import { loadSettings } from '../core/settings';
import { GameState } from '../core/game_state';
import type { MenuHost, OfflineHost, ScreenName } from '../ui2/ports';
import { GameEnvelope, RoomLobbyView } from '../net/protocol';
import { installGlobalTouchGuard } from '../ui2/uiskin';

export class App implements MenuHost, OfflineHost {
  readonly adt: AdvancedDynamicTexture;
  readonly api = new Api();
  readonly menu: MenuScreen;
  readonly online: OnlineLobby;
  offline: OfflineGame | null = null;
  private root = new Container('root');
  private currentName: ScreenName | null = null;

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
    window.addEventListener('resize', () => this.relayout());
    this.show('menu');
  }

  // MenuHost: меню и оверлеи пересобираются при смене языка/масштабов.
  rebuild(): void {
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
    if (this.currentName === 'offline' && this.offline) this.offline.relayout();
    if (this.currentName === 'online') this.restoreOnline();
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
      else if (this.current === 'online') this.showToast(msg.reason ?? 'Ошибка', true);
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
    l.onPending = (room) => this.online.applyPending(room);
  }

  private lastLobby: RoomLobbyView | null = null;

  // GAME_STATE: сетевая партия на том же 2D-экране, что и офлайн.
  enterGame(env: GameEnvelope): void {
    if (this.currentName !== 'offline') this.show('offline');
    if (!this.offline) this.offline = new OfflineGame(this);
    this.offline.onlineMode = true;
    this.offline.applyOnlineView(env);
  }

  // ROOM_STATE: лобби комнаты (гостевая) или возврат комнаты к ожиданию
  // после конца партии — рисуем страницы сетевого меню.
  roomState(room: RoomLobbyView): void {
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
    if (this.currentName === name) {
      this.rebuild();
      return;
    }
    this.currentName = name;
    this.root.clearControls();
    applyTitle();
    if (name === 'menu') {
      this.menu.build(this.root);
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
    this.show('online');
  }

  // pending_room для баннера главного меню
  pendingRoom(): RoomLobbyView | null {
    return this.api.pendingRoom;
  }

  onReturnToRoom(): void {
    this.show('online');
    void this.online.returnToPending();
  }

  onDropRoom(): void {
    void this.online.dropPending();
  }

  // OnlineHost: «Назад» из сетевого меню. Комнату не покидаем —
  // место за нами сохраняется, как в оригинале (park_room).
  onLeaveOnline(): void {
    this.show('menu');
  }

  // OfflineHost
  toMenu(): void {
    if (this.offline) {
      this.offline.running = false;
      this.offline.stopTimers();
    }
    this.offline = null;
    this.show('menu');
  }

  // Сетевая партия кончилась — возврат в лобби комнаты (ROOM_STATE).
  toLobby(): void {
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
}

