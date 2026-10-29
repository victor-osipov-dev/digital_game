import { t } from './lang';

export const RED = 0;
export const BLUE = 1;
export const BLACK = 2;
export const ORANGE = 3;
export const YELLOW = 4;
export const PURPLE = 5;

export interface TileFace {
  id: number;
  color: number;
  value: number;
  is_joker: boolean;
}

export function colorHex(c: number): string {
  switch (c) {
    case RED: return '#E53935';
    case BLUE: return '#1E88E5';
    case BLACK: return '#212121';
    case ORANGE: return '#FB8C00';
    case YELLOW: return '#FDD835';
    case PURPLE: return '#8E24AA';
    default: return '#9E9E9E';
  }
}

export function colorName(c: number): string {
  switch (c) {
    case RED: return t('красный');
    case BLUE: return t('синий');
    case BLACK: return t('чёрный');
    case ORANGE: return t('оранжевый');
    case YELLOW: return t('жёлтый');
    case PURPLE: return t('фиолетовый');
    default: return '?';
  }
}

export function sortTiles<T extends TileFace>(tiles: T[]): void {
  tiles.sort((a, b) => {
    if (a.is_joker !== b.is_joker) return a.is_joker ? 1 : -1;
    if (a.color !== b.color) return a.color - b.color;
    return a.value - b.value;
  });
}
