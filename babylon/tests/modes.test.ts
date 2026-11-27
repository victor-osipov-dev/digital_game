import { describe, expect, it } from 'vitest';
import { GameState } from '../src/core/game_state';

describe('match modes and seeded deck', () => {
  it('deals the same hands for the same daily seed', () => {
    const a = GameState.create(2, ['A', 'B'], false, 123456);
    const b = GameState.create(2, ['A', 'B'], false, 123456);
    const ids = (s: GameState): number[] => s.players.flatMap((p) => p.hand.map((t) => t.id));
    expect(ids(a)).toEqual(ids(b));
    expect(a.deck.tiles.map((t) => t.id)).toEqual(b.deck.tiles.map((t) => t.id));
  });

  it('quick mode scores a turn and ends at the target', () => {
    const s = GameState.create(2, ['A', 'B'], false, 7);
    s.mode = 'quick';
    s.target = 10;
    s.first_turn = false;
    s.current = 0;
    // Ряд 1-2-3: 6 очков — ещё не победа.
    const deck = s.deck.tiles;
    const take = (color: number, value: number) => {
      const i = deck.findIndex((t) => t.color === color && t.value === value);
      if (i >= 0) return deck.splice(i, 1)[0];
      for (const p of s.players) {
        const j = p.hand.findIndex((t) => t.color === color && t.value === value);
        if (j >= 0) return p.hand.splice(j, 1)[0];
      }
      throw new Error(`tile ${color}:${value} not found`);
    };
    const tiles = [take(0, 1), take(0, 2), take(0, 3)];
    s.players[0].hand = [...tiles, ...s.players[0].hand];
    const row = s.addRow();
    tiles.forEach((t) => s.placeFromHand(t.id, row.id, row.tiles.length));
    const first = s.endTurn();
    expect(first.ok).toBe(true);
    expect(s.scores[0]).toBe(6);
    expect(s.finished).toBe(false);

    // Второй ход добирает до 10 очков и завершает партию.
    s.current = 0;
    const more = [take(1, 5), take(1, 6), take(1, 7)];
    s.players[0].hand = [...more, ...s.players[0].hand];
    const row2 = s.addRow();
    more.forEach((t) => s.placeFromHand(t.id, row2.id, row2.tiles.length));
    const second = s.endTurn();
    expect(second.ok).toBe(true);
    expect(second.win).toBe(true);
    expect(s.finished).toBe(true);
    expect(s.winner).toBe(0);
    expect(s.scores[0]).toBe(24);
  });

  it('timed finish prefers points, then fewer tiles', () => {
    const s = GameState.create(2, ['A', 'B'], false, 9);
    s.mode = 'timed';
    s.scores = [12, 12];
    s.players[0].hand = s.players[0].hand.slice(0, 3);
    s.players[1].hand = s.players[1].hand.slice(0, 5);
    expect(s.finishByTime()).toBe(0);
    s.players[1].hand = s.players[1].hand.slice(0, 1);
    s.finished = false;
    expect(s.finishByTime()).toBe(1);
  });
});
