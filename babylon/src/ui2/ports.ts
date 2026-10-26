export interface MenuHost {
  rebuild(): void;
  onStart(): void;
  onOnline(): void;
  // pending_room: место в комнате сохранилось (баннер в главном меню)
  pendingRoom(): import('../net/protocol').RoomLobbyView | null;
  onReturnToRoom(): void;
  onDropRoom(): void;
}

export interface OfflineHost {
  toMenu(): void;
  toLobby(): void;
  replay(): void;
  getScene(): import('@babylonjs/core').Scene;
  screenRoot(): import('@babylonjs/gui').Container;
  rebuildScreen(): void;
  rebuild(): void;
  // сетевой слой для сетевой партии (offline-экран в online-режиме)
  gameApi(): import('../net/api').Api;
}

export type ScreenName = 'menu' | 'offline' | 'online';
