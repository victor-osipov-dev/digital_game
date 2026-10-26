import { PURPLE, TileFace, YELLOW } from './tile';
import type { TileFaceMsg } from '../net/protocol';

export const VALUES = 13;
export const COPIES = 2;
export const JOKER_COLORS = [YELLOW, PURPLE];
export const JOKERS = JOKER_COLORS.length;
export const TOTAL_TILES = 4 * VALUES * COPIES + JOKERS;

const BY_ID = new Map<number, TileFace>();

(function build() {
  let nextId = 1;
  for (let c = 0; c < 4; c += 1) {
    for (let v = 1; v <= VALUES; v += 1) {
      for (let copy = 0; copy < COPIES; copy += 1) {
        BY_ID.set(nextId, { id: nextId, color: c, value: v, is_joker: false });
        nextId += 1;
      }
    }
  }
  for (const c of JOKER_COLORS) {
    BY_ID.set(nextId, { id: nextId, color: c, value: 1, is_joker: true });
    nextId += 1;
  }
})();

// Каталог приходит с сервера в hello (view_builder.gd:17-58) и кэшируется
// на сеанс: нумерация id — серверная, локальная схема служит только
// до первого приветствия.
export function setServerCatalog(catalog: TileFaceMsg[]): void {
  if (!Array.isArray(catalog) || catalog.length < 100) return;
  BY_ID.clear();
  for (const m of catalog) {
    BY_ID.set(m.id, { id: m.id, color: m.color, value: m.value, is_joker: !!m.is_joker });
  }
}

export function tileById(id: number): TileFace {
  const t = BY_ID.get(id);
  if (!t) {
    // неизвестный id: не роняем партию — серая заглушка + журнал
    console.warn(`unknown tile id ${id} — заглушка`);
    return { id, color: 0, value: 0, is_joker: false };
  }
  return t;
}

export function tryTileById(id: number): TileFace | null {
  return BY_ID.get(id) ?? null;
}

export const CATALOG: TileFace[] = Array.from(BY_ID.values());

export function tileCopy(tile: TileFace): TileFace {
  return { id: tile.id, color: tile.color, value: tile.value, is_joker: tile.is_joker };
}
