import { describe, expect, it } from 'vitest';
import { GameState } from '../src/core/game_state';
import { tileById } from '../src/core/deck';
import { validateRow } from '../src/core/rules';

describe('GameState', () => {
  it('сохраняет фишки победного хода для последней подсветки', () => {
    const state = GameState.create(2, ['Игрок', 'Бот'], false);
    const winningTiles = [5, 7, 9]; // серия 3–5 одного цвета
    state.players[0].hand = winningTiles.map(tileById);
    const row = state.addRow();

    for (const id of winningTiles) {
      expect(state.placeFromHand(id, row.id, row.tiles.length)).toBe(true);
    }

    const result = state.endTurn();
    expect(result.win).toBe(true);
    expect(state.last_turn_tile_ids).toEqual(winningTiles);
    expect(state.turn_placed).toHaveLength(0);
  });

  it('создаёт соло-раскладку, которую нельзя решить без перестройки', () => {
    const state = GameState.createPuzzle();
    expect(state.mode).toBe('puzzle');
    expect(state.playerCount()).toBe(1);
    expect(state.tilesLeftInDeck()).toBe(0);
    expect(state.table).toHaveLength(3);
    for (const row of state.table) {
      expect(row.tiles.length).toBe(8);
      expect(validateRow(row.tiles).ok).toBe(true);
    }
    expect(state.hand()).toHaveLength(6);

    // Ни одну фишку из руки нельзя просто дописать в готовые ряды.
    for (const tile of state.hand()) {
      for (const row of state.table) {
        for (let index = 0; index <= row.tiles.length; index += 1) {
          const next = [...row.tiles];
          next.splice(index, 0, tile);
          expect(validateRow(next).ok).toBe(false);
        }
      }
    }
    // И из руки нельзя собрать отдельный ряд.
    const hand = state.hand();
    for (let i = 0; i < hand.length; i += 1) {
      for (let j = i + 1; j < hand.length; j += 1) {
        for (let k = j + 1; k < hand.length; k += 1) {
          expect(validateRow([hand[i], hand[j], hand[k]]).ok).toBe(false);
        }
      }
    }

    // Решение: разобрать каждый ряд и собрать две серии на цвет.
    for (const row of [...state.table]) {
      const color = row.tiles[0].color;
      const pair = state.hand().filter((tile) => tile.color === color)
        .map((tile) => tile.value)
        .sort((a, b) => a - b);
      expect(pair).toHaveLength(2);
      const start = pair[0];
      const target = state.addRow();
      if (start <= 4) {
        // Берём начало ряда: 1..start-1 + пара из руки.
        for (const tile of row.tiles.filter((t) => t.value < start)) {
          expect(state.moveTile(row.id, tile.id, target.id, target.tiles.length)).toBe(true);
        }
        const tiles = state.hand().filter((t) => t.color === color).sort((a, b) => a.value - b.value);
        for (const tile of tiles) {
          expect(state.placeFromHand(tile.id, target.id, target.tiles.length)).toBe(true);
        }
      } else {
        // Берём хвост ряда: пара из руки + оставшиеся старшие числа.
        for (const tile of row.tiles.filter((t) => t.value > start + 1)) {
          expect(state.moveTile(row.id, tile.id, target.id, target.tiles.length)).toBe(true);
        }
        const tiles = state.hand().filter((t) => t.color === color).sort((a, b) => b.value - a.value);
        for (const tile of tiles) {
          expect(state.placeFromHand(tile.id, target.id, 0)).toBe(true);
        }
      }
      expect(validateRow(target.tiles).ok).toBe(true);
      expect(validateRow(row.tiles).ok).toBe(true);
    }
    expect(state.hand()).toHaveLength(0);
    expect(state.endTurn().win).toBe(true);
  });
});
