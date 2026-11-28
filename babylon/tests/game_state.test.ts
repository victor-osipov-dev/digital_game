import { describe, expect, it } from 'vitest';
import { GameState } from '../src/core/game_state';
import { tileById } from '../src/core/deck';
import { validateRow } from '../src/core/rules';
import { BLACK, BLUE, ORANGE, RED } from '../src/core/tile';

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

  it('создаёт сложную соло-раскладку с сериями и набором', () => {
    const state = GameState.createPuzzle();
    expect(state.mode).toBe('puzzle');
    expect(state.playerCount()).toBe(1);
    expect(state.tilesLeftInDeck()).toBe(0);
    expect(state.table).toHaveLength(4);
    expect(state.table.map((row) => row.tiles.length)).toEqual([4, 4, 3, 3]);
    expect(state.hand()).toHaveLength(5);

    // Все ряды перемешаны: на столе нет ни готовой серии, ни готового набора.
    for (const row of state.table) {
      expect(validateRow(row.tiles).ok).toBe(false);
    }

    // Ни одну фишку из руки нельзя просто дописать в готовый ряд.
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

    // Решение: собрать пять эталонных рядов — две серии, набор и ещё две серии.
    const solution: [number, number][][] = [
      [[RED, 3], [RED, 4], [RED, 5], [RED, 6], [RED, 7]],
      [[BLUE, 10], [BLUE, 11], [BLUE, 12], [BLUE, 13]],
      [[RED, 9], [BLUE, 9], [BLACK, 9]],
      [[BLACK, 1], [BLACK, 2], [BLACK, 3], [BLACK, 4]],
      [[ORANGE, 5], [ORANGE, 6], [ORANGE, 7]],
    ];
    let usedSet = false;
    for (const pairs of solution) {
      const target = state.addRow();
      for (const [color, value] of pairs) {
        const fromHand = state.hand().find((tile) => tile.color === color && tile.value === value);
        if (fromHand) {
          expect(state.placeFromHand(fromHand.id, target.id, target.tiles.length)).toBe(true);
          continue;
        }
        let moved = false;
        for (const row of [...state.table]) {
          if (row === target) continue;
          const tile = row.tiles.find((item) => item.color === color && item.value === value);
          if (!tile) continue;
          expect(state.moveTile(row.id, tile.id, target.id, target.tiles.length)).toBe(true);
          moved = true;
          break;
        }
        expect(moved).toBe(true);
      }
      const result = validateRow(target.tiles);
      expect(result.ok).toBe(true);
      if (result.kind === 'set') usedSet = true;
    }
    // В раскладке действительно есть набор, а не только серии.
    expect(usedSet).toBe(true);
    expect(state.hand()).toHaveLength(0);
    expect(state.endTurn().win).toBe(true);
  });
});
