'use strict';

// Серверный бот использует тот же планировщик, что и офлайн-клиент
// (turn_planner.js — CommonJS-сборка src/core/turn_planner.ts).
// GameState сервера хранит только id фишек, поэтому здесь адаптируем его
// к структуре, которую ожидает TurnPlanner; само состояние не меняем.

const catalog = require('./catalog');
const { TurnPlanner, LEVEL_IMPOSSIBLE } = require('./turn_planner');

function planGame(game) {
  const state = {
    finished: game.finished,
    require_30: game.require30,
    first_turn: game.firstTurn,
    table: game.table.map((row) => ({
      id: row.id,
      tiles: row.tileIds.map((id) => catalog.BY_ID.get(id)),
    })),
    hand: () => game.hand().map((id) => catalog.BY_ID.get(id)),
    openingPoints: () => game.openingPoints(),
    tilesLeftInDeck: () => game.tilesLeftInDeck(),
    canDraw: () => game.canDraw(),
    canSkip: () => game.canSkip(),
  };

  const plan = TurnPlanner.plan(state, LEVEL_IMPOSSIBLE);
  if (plan.action !== 'place' || plan.ops.length === 0) return null;
  return { ops: plan.ops, points: plan.points, win: false };
}

module.exports = { planGame };
