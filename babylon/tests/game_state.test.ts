import { describe, expect, it } from 'vitest';
import { GameState } from '../src/core/game_state';
import { tileById } from '../src/core/deck';

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
});
