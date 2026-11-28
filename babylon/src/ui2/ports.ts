// Статистика сетевых партий приходит с сервера (таблица лидеров),
// поэтому локальные счётчики и сетевые не смешиваются.
export interface OnlineStats {
  games: number;
  wins: number;
  rank?: number;
}

export type StartMode = 'classic' | 'quick' | 'timed' | 'daily' | 'puzzle';

export interface MenuHost {
  rebuild(): void;
  onStart(mode?: StartMode): void;
  onOnline(): void;
  // pending_room: место в комнате сохранилось (баннер в главном меню)
  pendingRoom(): import('../net/protocol').RoomLobbyView | null;
  // Есть ли хотя бы одна живая комната (плашка «Кто-то играет по сети»).
  hasOnlineRooms(): boolean;
  onReturnToRoom(): void;
  onDropRoom(): void;
  // null — нет связи/входа или сервер не вернул данные
  onlineStats(): Promise<OnlineStats | null>;
}

export interface OfflineHost {
  toMenu(): void;
  toLobby(): void;
  replay(mode?: StartMode): void;
  getScene(): import('@babylonjs/core').Scene;
  screenRoot(): import('@babylonjs/gui').Container;
  rebuildScreen(): void;
  rebuild(): void;
  // сетевой слой для сетевой партии (offline-экран в online-режиме)
  gameApi(): import('../net/api').Api;
}

export type ScreenName = 'menu' | 'offline' | 'online';
