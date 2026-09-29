'use strict';

// Планировщик ходов для серверного бота.
//
// Бот смотрит на свою руку и стол и предлагает один составной ход
// set_table: чужие ряды остаются как есть, свои он достраивает, а из руки
// выкладывает новые серии/наборы. Точность гарантирует сам движок: любой
// план прогоняется beginTurn → applyOps → endTurn → rollback, поэтому бот
// физически не может предложить того, что правила не примут. Движок же
// решает, проходит ли план первый ход с 30 очками.
//
// planGame НЕ мутирует авторитетное состояние: все пробы происходят внутри
// транзакций с обязательным rollback.

const catalog = require('./catalog');
const Rules = require('./rules');

const JOKERS_PER_ROW = 2; // больше двух джокеров на ряд правила не спасут
const POOL_SIZE = 14; // сколько кандидатов рассматриваем на комбо
const COMBO_MAX = 3; // максимум групп в одном ходе
const MAX_NEW = 360; // потолок кандидатов «новая серия/набор»
const MAX_EXT = 400; // потолок кандидатов «достроить ряд»

/**
 * Ход бота для состояния g (авторитетный GameState). Возвращает
 * {ops:[{op:'set_table', rows:[...]}], points, win} либо null, если
 * выложить нечего (движок тогда скажет боту взять из колоды).
 */
function planGame(g) {
  const handIds = g.hand();
  const cands = collectCandidates(g, handIds).sort((a, b) => strength(b) - strength(a));
  const pool = cands.slice(0, POOL_SIZE);

  const conflicts = pool.map(() => new Array(pool.length).fill(false));
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = 0; j < pool.length; j += 1) {
      if (i !== j) conflicts[i][j] = conflict(pool[i], pool[j]);
    }
  }

  let best = null;
  const consider = (idxs) => {
    const trial = evalCombo(g, idxs.map((k) => pool[k]));
    if (trial && better(trial, best)) best = trial;
  };

  for (let len = 1; len <= COMBO_MAX; len += 1) {
    const run = (start, idxs) => {
      if (idxs.length === len) {
        for (let i = 0; i < idxs.length; i += 1) {
          for (let j = i + 1; j < idxs.length; j += 1) {
            if (conflicts[idxs[i]][idxs[j]]) return;
          }
        }
        consider(idxs);
        return;
      }
      for (let k = start; k < pool.length; k += 1) run(k + 1, idxs.concat(k));
    };
    run(0, []);
    if (best && best.win) break; // рука опустела — дальше искать выгоднее некуда
  }

  return best
    ? { ops: [{ op: 'set_table', rows: best.tableSpec }], points: best.points, win: best.win }
    : null;
}

function evalCombo(g, groups) {
  const touched = new Set();
  const spec = [];
  for (const gr of groups) {
    if (gr.kind === 'new') {
      spec.push({ id: 0, tiles: gr.tiles });
    } else {
      if (touched.has(gr.rowId)) return null;
      touched.add(gr.rowId);
      spec.push({ id: gr.rowId, tiles: gr.tiles });
    }
  }
  for (const row of g.table) {
    if (touched.has(row.id)) continue;
    spec.push({ id: row.id, tiles: row.tileIds.slice() });
  }

  const snap = g.captureAll();
  g.beginTurn();
  let points = 0;
  let win = false;
  let ok = g.applyOps([{ op: 'set_table', rows: spec }]);
  if (ok) {
    points = g.openingPoints();
    const r = g.endTurn();
    ok = r.ok;
    win = ok && r.win === true;
  }
  g.rollback();
  if (!ok) return null;
  let added = 0;
  for (const gr of groups) added += gr.placed;
  return { tableSpec: spec, points, added, win };
}

function better(a, b) {
  if (!b) return true;
  if (a.win !== b.win) return a.win;
  if (a.added !== b.added) return a.added > b.added;
  return a.points > b.points;
}

function strength(c) {
  return c.placed * 1000 + c.points;
}

function conflict(a, b) {
  for (const id of a.usedTiles) if (b.usedTiles.has(id)) return true;
  if (a.rowId && b.rowId && a.rowId === b.rowId) return true;
  return false;
}

function collectCandidates(g, handIds) {
  const handTiles = handIds.map((id) => catalog.BY_ID.get(id));
  const jokers = handTiles.filter((t) => t.is_joker);
  const reals = handTiles.filter((t) => !t.is_joker);

  const have = new Map(); // "color:value" -> tile
  const valuesByColor = [[], [], [], []];
  for (const t of reals) {
    const key = t.color + ':' + t.value;
    if (!have.has(key)) have.set(key, t);
    if (!valuesByColor[t.color].includes(t.value)) valuesByColor[t.color].push(t.value);
  }

  const out = [];
  const add = (c) => { if (c && out.length < MAX_NEW + MAX_EXT) out.push(c); };

  // --- новые серии из руки -------------------------------------------
  for (let color = 0; color < 4; color += 1) {
    const vals = valuesByColor[color];
    for (let start = 1; start <= 13; start += 1) {
      for (let len = 3; len <= 13 - start + 1; len += 1) {
        const missing = [];
        for (let v = start; v < start + len; v += 1) {
          if (!vals.includes(v)) missing.push(v);
        }
        if (missing.length > jokers.length || missing.length > JOKERS_PER_ROW) continue;
        let j = 0;
        const tiles = [];
        for (let v = start; v < start + len; v += 1) {
          if (vals.includes(v)) tiles.push(have.get(color + ':' + v).id);
          else tiles.push(jokers[j++].id);
        }
        add(mkNew(tiles));
      }
    }
  }

  // --- новые наборы из руки ------------------------------------------
  const colorsByValue = new Map(); // value -> [color]
  for (const t of reals) {
    if (!colorsByValue.has(t.value)) colorsByValue.set(t.value, []);
    if (!colorsByValue.get(t.value).includes(t.color)) colorsByValue.get(t.value).push(t.color);
  }
  for (const [value, colors] of colorsByValue) {
    if (colors.length >= 3) add(mkNew([byVal(colors[0], value), byVal(colors[1], value), byVal(colors[2], value)]));
    if (colors.length >= 4) {
      add(mkNew([byVal(colors[0], value), byVal(colors[1], value), byVal(colors[2], value), byVal(colors[3], value)]));
    }
  }
  function byVal(color, value) {
    return have.get(color + ':' + value).id;
  }

  // --- достроить существующие ряды ------------------------------------
  for (const row of g.table) {
    if (out.length >= MAX_NEW + MAX_EXT) break;
    const base = catalog.tiles(row.tileIds);
    if (base.length < 3) continue;
    const kind = Rules.validateRow(base);
    if (!kind.ok) continue;
    const baseReals = base.filter((t) => !t.is_joker);
    if (baseReals.length === 0) continue; // ряд из одних джокеров трогаем левыми руками

    const pool = [];
    const haveColors = new Set();
    if (kind.kind === 'run') {
      const runColor = baseReals[0].color;
      const minV = Math.min(...baseReals.map((t) => t.value));
      const maxV = Math.max(...baseReals.map((t) => t.value));
      for (const t of reals) {
        if (t.color !== runColor) continue;
        if (t.value < minV || t.value > maxV) pool.push(t);
      }
    } else if (kind.kind === 'set') {
      const setValue = baseReals[0].value;
      for (const t of baseReals) haveColors.add(t.color);
      for (const t of reals) {
        if (t.value !== setValue) continue;
        if (haveColors.has(t.color)) continue;
        pool.push(t);
      }
    } else {
      continue;
    }
    for (const jt of jokers) pool.push(jt);

    const baseJokers = base.filter((t) => t.is_joker).length;
    const subs = subsetsUpTo2(dedupePool(pool), baseJokers);
    for (const subset of subs) {
      if (subset.length === 0) continue;
      const addTiles = subset.map((t) => catalog.BY_ID.get(t.id));
      const merged = base.map((t) => t.id).concat(addTiles.map((t) => t.id)).sort();
      if (!canArrange(base, addTiles)) continue;
      let pts = 0;
      for (const t of addTiles) pts += t.is_joker ? 8 : t.value;
      add({
        kind: 'ext',
        rowId: row.id,
        tiles: merged,
        placed: addTiles.length,
        points: pts,
        usedTiles: new Set(addTiles.map((t) => t.id)),
      });
    }
  }
  return out;
}

function mkNew(tiles) {
  const t = tiles.map((id) => catalog.BY_ID.get(id));
  if (!Rules.validateRow(t).ok) return null;
  return { kind: 'new', rowId: 0, tiles, placed: tiles.length, points: Rules.rowPoints(t), usedTiles: new Set(tiles) };
}

function dedupePool(pool) {
  const seen = new Set();
  const out = [];
  for (const t of pool) {
    const key = t.is_joker ? 'id:' + t.id : t.color + ':' + t.value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.slice(0, 8);
}

function subsetsUpTo2(pool, baseJokers) {
  const out = [];
  for (let i = 0; i < pool.length; i += 1) {
    const t = pool[i];
    if (t.is_joker && baseJokers + 1 > JOKERS_PER_ROW) continue;
    out.push([t]);
    for (let j = i + 1; j < pool.length; j += 1) {
      const u = pool[j];
      const tj = t.is_joker ? 1 : 0;
      const uj = u.is_joker ? 1 : 0;
      if (baseJokers + tj + uj > JOKERS_PER_ROW) continue;
      out.push([t, u]);
    }
  }
  return out;
}

/**
 * Правила не обязаны принять ряд в «ручном» порядке кандидата — проверяем
 * честно: попытка как набора в любом порядке, затем как серии с джокерами
 * в каждой из щелей.
 */
function canArrange(base, addTiles) {
  const all = base.concat(addTiles);
  const t = all.map((x) => catalog.BY_ID.get(x.id));
  const reals = t.filter((x) => !x.is_joker);
  const js = t.filter((x) => x.is_joker);
  if (Rules.validateRow(reals.concat(js)).ok) return true;
  if (reals.length === 0) return js.length >= 3;
  if (js.length === 0) return false;
  if (!reals.every((x) => x.color === reals[0].color)) return false;
  const plain = reals.slice().sort((a, b) => a.value - b.value);
  for (let at = 0; at <= plain.length; at += 1) {
    const cand = plain.slice(0, at).concat(js, plain.slice(at));
    if (Rules.validateRow(cand).ok) return true;
  }
  return false;
}

module.exports = { planGame };