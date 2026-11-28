import { describe, expect, it } from 'vitest';
import { tileById } from '../src/core/deck';
import { GameState } from '../src/core/game_state';
import { validateRow } from '../src/core/rules';
import { BOT_LEVEL_NAMES } from '../src/core/settings';
import { LEVEL_EASY, LEVEL_IMPOSSIBLE, LEVEL_MEDIUM, TurnPlanner } from '../src/core/turn_planner';
import { faces } from './helpers';

// id = цвет*26 + (значение-1)*2 + копия + 1
const RED_5 = 9;
const RED_6 = 11;
const RED_7 = 13;
const RED_RUN_1_9 = [1, 3, 5, 7, 9, 11, 13, 15, 17];
// Две синие фишки, из которых нельзя собрать отдельный ряд, — рука из 11
// фишек не даёт победить одним ходом, поэтому лимит сложности действует.
const BLUE_5 = 35;
const BLUE_6 = 37;
const BLUE_7 = 39;
const JOKER_YELLOW = 105;

describe('bot difficulty and large hands', () => {
  it('offers four difficulty levels', () => {
    expect(BOT_LEVEL_NAMES).toEqual(['Новичок', 'Любитель', 'Сложный', 'Невозможный']);
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

describe('guaranteed bot move', () => {
  const makeState = (hand: number[], require30 = false): GameState => {
    const state = GameState.create(2, ['Бот', 'Игрок'], require30);
    state.first_turn = false;
    state.current = 0;
    state.players[0].hand = faces(hand);
    return state;
  };

  it('finds a minimal run when the hand is tiny', () => {
    const state = makeState([RED_5, RED_6, RED_7]);
    const planner = new TurnPlanner();
    const row = planner.bestRowFromHand(state.hand(), 0);
    expect(row).not.toBeNull();
    expect(validateRow(row!).ok).toBe(true);
    expect(row!.map((t) => t.value).sort((a, b) => a - b)).toEqual([5, 6, 7]);
  });

  it('builds a set with a joker when nothing else fits', () => {
    const state = makeState([RED_7, BLUE_7, JOKER_YELLOW]);
    const row = new TurnPlanner().bestRowFromHand(state.hand(), 0);
    expect(row).not.toBeNull();
    expect(validateRow(row!).ok).toBe(true);
  });

  it('respects the opening 30 point rule', () => {
    // 5-6-7 = 18 очков: для первого хода мало, ряда быть не должно.
    const state = makeState([RED_5, RED_6, RED_7], true);
    const planner = new TurnPlanner();
    planner.plan(state, LEVEL_MEDIUM); // выставляет режим и базу очков
    expect(planner.bestRowFromHand(state.hand(), 30)).toBeNull();
  });

  it('caps how many tiles each difficulty lays down', () => {
    const easyState = makeState(RED_RUN_1_9);
    const easy = new TurnPlanner().plan(easyState, LEVEL_EASY);
    expect(easy.action).toBe('place');
    expect(easy.tiles.length).toBeLessThanOrEqual(4);

    const mediumState = makeState([...RED_RUN_1_9, BLUE_5, BLUE_6]);
    const medium = new TurnPlanner().plan(mediumState, LEVEL_MEDIUM);
    expect(medium.action).toBe('place');
    expect(medium.tiles.length).toBeGreaterThan(0);
    expect(medium.tiles.length).toBeLessThanOrEqual(6);
  });

  it('always returns a place action when a legal row exists', () => {
    for (const level of [LEVEL_EASY, LEVEL_MEDIUM]) {
      const s = makeState([...RED_RUN_1_9, JOKER_YELLOW]);
      const plan = new TurnPlanner().plan(s, level);
      expect(plan.action).toBe('place');
      expect(s.applyOps(plan.ops)).toBe(true);
    }
  });
});
