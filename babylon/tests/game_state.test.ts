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

  it('создаёт соло-раскладку с гарантированным решением', () => {
    const state = GameState.createPuzzle();
    expect(state.mode).toBe('puzzle');
    expect(state.playerCount()).toBe(1);
    expect(state.tilesLeftInDeck()).toBe(0);
    expect(state.table).toHaveLength(3);
    expect(state.hand()).toHaveLength(14);
    for (const row of state.table) expect(row.tiles.length).toBeGreaterThanOrEqual(3);

    // Возвращаем фишки из руки в ряды по значению — все ряды должны стать
    // валидными сериями, а рука опустеть. Это и есть решение раскладки.
    const hand = [...state.hand()];
    for (const row of state.table) {
      const color = row.tiles[0].color;
      for (let value = 1; value <= 8; value += 1) {
        if (row.tiles.some((tile) => tile.value === value)) continue;
        const index = hand.findIndex((tile) => tile.color === color && tile.value === value);
        expect(index).toBeGreaterThanOrEqual(0);
        const tile = hand.splice(index, 1)[0];
        const pos = row.tiles.findIndex((item) => item.value > value);
        row.tiles.splice(pos < 0 ? row.tiles.length : pos, 0, tile);
      }
      expect(validateRow(row.tiles).ok).toBe(true);
    }
    expect(hand).toHaveLength(0);
  });
});
