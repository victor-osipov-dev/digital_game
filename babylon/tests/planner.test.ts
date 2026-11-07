import { describe, expect, it } from 'vitest';
import { tileById } from '../src/core/deck';
import { GameState } from '../src/core/game_state';
import { BOT_LEVEL_NAMES } from '../src/core/settings';
import { LEVEL_IMPOSSIBLE, TurnPlanner } from '../src/core/turn_planner';

describe('bot difficulty and large hands', () => {
  it('offers only the impossible difficulty', () => {
    expect(BOT_LEVEL_NAMES).toEqual(['Невозможный']);
  });

  it('finds a valid new row from a hand larger than 16 tiles', () => {
    const state = GameState.create(2, ['Бот', 'Игрок'], false);
    state.first_turn = false;
    const run = [1, 3, 5]; // один цвет, значения 1–3
    const handIds = [...run];
    for (let id = 1; id <= 106 && handIds.length < 40; id += 1) {
      if (!handIds.includes(id)) handIds.push(id);
    }
    state.players[0].hand = handIds.map(tileById);
    state.current = 0;

    const plan = new TurnPlanner().plan(state, LEVEL_IMPOSSIBLE);
    expect(plan.action).toBe('place');
    expect(plan.tiles.length).toBeGreaterThan(0);
    expect(state.applyOps(plan.ops)).toBe(true);
    expect(state.endTurn().ok).toBe(true);
  });
});
