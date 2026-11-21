// GENERATED from babylon/src/core/turn_planner.ts; keep this planner in sync with the browser client.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TurnPlanner = exports.LEVEL_IMPOSSIBLE = exports.LEVEL_HARD = exports.LEVEL_MEDIUM = exports.LEVEL_EASY = void 0;
const rules_1 = require("./rules");
exports.LEVEL_EASY = 0;
exports.LEVEL_MEDIUM = 1;
exports.LEVEL_HARD = 2;
exports.LEVEL_IMPOSSIBLE = 3;
const BUDGET_MEDIUM = 8000;
const BUDGET_HARD = 40000;
// Жёсткий лимит ограничивает задержку одного хода и в браузере, и на сервере.
const PLANNER_TIME_MS = [16, 20, 26, 80];
const CAP_EASY = 60;
const CAP_MEDIUM = 80;
const CAP_HARD = 400;
const CAP_IMPOSSIBLE = 900;
const BONUS_STEAL = 6;
const BONUS_BRIDGE = 12;
const BONUS_REBUILD = 4;
const REBUILD_GROUP_MAX = 8;
const JOKER_HOLD = [0.0, 40.0, 55.0, 70.0];
const JOKER_HOLD_LATE = [0.0, 8.0, 12.0, 16.0];
const END_PLAN = { action: 'end', ops: [], points: 0, tiles: [] };
function idsOf(tiles) {
    return tiles.map((t) => t.id);
}
function jokerCount(tiles) {
    let n = 0;
    for (const t of tiles)
        if (t.is_joker)
            n += 1;
    return n;
}
function handPointsOf(tiles, res) {
    let total = 0;
    for (const t of tiles) {
        if (t.is_joker)
            total += res.joker_values[t.id] ?? 0;
        else
            total += t.value;
    }
    return total;
}
function shapeOk(tiles) {
    let colorsOk = true;
    let valuesOk = true;
    let c0 = -1;
    let v0 = -1;
    for (const t of tiles) {
        if (t.is_joker)
            continue;
        if (c0 === -1)
            c0 = t.color;
        else if (t.color !== c0)
            colorsOk = false;
        if (v0 === -1)
            v0 = t.value;
        else if (t.value !== v0)
            valuesOk = false;
        if (!colorsOk && !valuesOk)
            return false;
    }
    return colorsOk || valuesOk;
}
class TurnPlanner {
    _state;
    _level = exports.LEVEL_MEDIUM;
    _candidates = [];
    _hand_ids = new Set();
    _base_points = 0;
    _need30 = false;
    _n_ref = 0;
    _budget = 0;
    _best = {};
    _suffix = [];
    _cover = [];
    _deadline = Number.POSITIVE_INFINITY;
    _rb_budget = 0;
    _rb_emitted = 0;
    _rb_mand = [];
    _rb_opt = [];
    _rb_refs = [];
    _rb_src = new Map();
    _rb_hand_ids = new Set();
    _rb_old_pts = 0;
    _rb_groups = [];
    _rb_used_opt = 0;
    _rb_pool_max = 8;
    _rb_opt_max = 8;
    _rb_cand_cap = 150;
    _rb_try_budget = 6000;
    _rb_pairs = true;
    static plan(state, level) {
        const p = new TurnPlanner();
        return p.plan(state, level);
    }
    plan(state, level) {
        this._state = state;
        this._level = Math.min(Math.max(level, 0), 3);
        this._deadline = nowMs() + PLANNER_TIME_MS[this._level];
        this.setupRebuildParams();
        if (state.finished)
            return { ...END_PLAN };
        this._base_points = state.openingPoints();
        this._need30 = state.require_30 && state.first_turn;
        this.buildCandidates();
        this.rankCandidates();
        if (this._level === exports.LEVEL_EASY) {
            const single = this.randomSingle();
            if (single !== null)
                return single;
            if (state.canDraw() && Math.random() < 0.35)
                return { action: 'draw', ops: [], points: 0, tiles: [] };
        }
        this._budget = this._level <= exports.LEVEL_MEDIUM ? BUDGET_MEDIUM : BUDGET_HARD;
        this.search();
        if (this._best !== null && this._best !== undefined && Object.keys(this._best).length > 0) {
            return {
                action: 'place',
                ops: this._best.ops,
                points: Number(this._best.points),
                tiles: this._best.tiles,
            };
        }
        // Если общий перебор упёрся в лимит, не объявляем ход невозможным,
        // когда генератор уже нашёл заведомо допустимую выкладку. Это особенно
        // важно при большой руке: иначе бот мог брать фишки, хотя ход есть.
        const fallback = this._candidates.find((c) => !this._need30 || this._base_points + c.hand_points >= rules_1.OPENING_POINTS);
        if (fallback) {
            return {
                action: 'place',
                ops: [...fallback.ops],
                points: fallback.points,
                tiles: [...fallback.hand_ids],
            };
        }
        if (state.canDraw())
            return { action: 'draw', ops: [], points: 0, tiles: [] };
        if (state.canSkip())
            return { action: 'skip', ops: [], points: 0, tiles: [] };
        return { ...END_PLAN };
    }
    outOfTime() {
        return nowMs() >= this._deadline;
    }
    mk(kind, refs, ops, handIds, points, handPoints, bonus, jokers = 0) {
        let pen = 0;
        for (let i = 0; i < jokers; i += 1)
            pen += this.jokerPenalty();
        return {
            kind,
            refs,
            ops,
            hand_ids: handIds,
            points,
            hand_points: handPoints,
            bonus,
            jokers,
            score: points * 4 + handIds.length * 6 + bonus - pen,
        };
    }
    jokerPenalty() {
        if (this._level <= exports.LEVEL_EASY)
            return 0.0;
        const total = 106.0;
        const left = this._state.tilesLeftInDeck();
        if (total <= 0.0)
            return JOKER_HOLD_LATE[this._level];
        const late = 1.0 - left / total;
        const a = JOKER_HOLD[this._level];
        const b = JOKER_HOLD_LATE[this._level];
        return a + (b - a) * late;
    }
    nextNRef() {
        const ref = `n${this._n_ref}`;
        this._n_ref += 1;
        return ref;
    }
    randomSingle() {
        const pool = [];
        for (const c of this._candidates) {
            if (c.score <= 0)
                continue;
            if (this._need30 && this._base_points + c.hand_points < rules_1.OPENING_POINTS)
                continue;
            pool.push(c);
        }
        if (pool.length === 0)
            return null;
        const c = pool[Math.floor(Math.random() * pool.length)];
        return { action: 'place', ops: [...c.ops], points: c.points, tiles: [...c.hand_ids] };
    }
    buildCandidates() {
        this._candidates = [];
        this._hand_ids = new Set();
        this._n_ref = 0;
        const hand = this._state.hand();
        for (const t of hand)
            this._hand_ids.add(t.id);
        this.packCandidates(hand);
        this.extendCandidates(hand);
        if (this._level >= exports.LEVEL_IMPOSSIBLE) {
            this.stealCandidates(hand);
            this.bridgeCandidates(hand);
        }
        if (this._level >= exports.LEVEL_MEDIUM)
            this.rebuildCandidates(hand);
    }
    rankCandidates() {
        this._candidates.sort((a, b) => b.score - a.score);
        let cap = CAP_MEDIUM;
        switch (this._level) {
            case exports.LEVEL_EASY:
                cap = CAP_EASY;
                break;
            case exports.LEVEL_MEDIUM:
                cap = CAP_MEDIUM;
                break;
            case exports.LEVEL_HARD:
                cap = CAP_HARD;
                break;
            case exports.LEVEL_IMPOSSIBLE:
                cap = CAP_IMPOSSIBLE;
                break;
            default: break;
        }
        if (this._candidates.length > cap)
            this._candidates.length = cap;
    }
    packCandidates(hand) {
        const n = hand.length;
        if (n < 3)
            return;
        if (n > 16) {
            this.packCandidatesLargeHand(hand);
            return;
        }
        const limit = 1 << n;
        for (let mask = 1; mask < limit; mask += 1) {
            if ((mask & 7) === 0 && this.outOfTime())
                return;
            const subset = [];
            for (let i = 0; i < n; i += 1) {
                if ((mask & (1 << i)) !== 0)
                    subset.push(hand[i]);
            }
            if (subset.length < 3)
                continue;
            if (!shapeOk(subset))
                continue;
            for (const order of this.orders(subset)) {
                const res = (0, rules_1.validateRow)(order);
                if (!res.ok)
                    continue;
                const pts = (0, rules_1.rowPoints)(order);
                const ref = this.nextNRef();
                const ops = order.map((t) => ({ op: 'place', tile: t.id, to: ref, index: 99 }));
                this._candidates.push(this.mk('new', [ref], ops, idsOf(order), pts, pts, 0, jokerCount(order)));
                break;
            }
        }
    }
    // Полный набор вариантов новых рядов для больших рук. Перебор всех
    // 2^N подмножеств становится непригоден уже после 16 фишек, поэтому
    // строим серии по цвету/значению, а наборы по значению/цвету. Все
    // физические дубликаты и варианты с джокерами рассматриваются до общего
    // дедлайна планировщика.
    packCandidatesLargeHand(hand) {
        const byColorValue = new Map();
        const jokers = hand.filter((tile) => tile.is_joker);
        for (const tile of hand) {
            if (tile.is_joker)
                continue;
            const key = `${tile.color}:${tile.value}`;
            const list = byColorValue.get(key) ?? [];
            list.push(tile);
            byColorValue.set(key, list);
        }
        const emitted = new Set();
        const addGroup = (tiles) => {
            if (this.outOfTime() || tiles.length < rules_1.MIN_TILES || tiles.length > rules_1.MAX_VALUE)
                return;
            const key = idsOf(tiles).slice().sort((a, b) => a - b).join(',');
            if (emitted.has(key))
                return;
            const validation = (0, rules_1.validateRow)(tiles);
            if (!validation.ok)
                return;
            emitted.add(key);
            const ref = this.nextNRef();
            const ops = tiles.map((tile, index) => ({ op: 'place', tile: tile.id, to: ref, index }));
            const points = (0, rules_1.rowPoints)(tiles);
            this._candidates.push(this.mk('new', [ref], ops, idsOf(tiles), points, handPointsOf(tiles, validation), 0, jokerCount(tiles)));
        };
        // Наборы: один реальный тайл каждого выбранного цвета и от 0 до 2
        // джокеров. Копии одной пары (цвет/значение) перебираются отдельно.
        for (let value = rules_1.MIN_VALUE; value <= rules_1.MAX_VALUE && !this.outOfTime(); value += 1) {
            for (let mask = 1; mask < (1 << 4) && !this.outOfTime(); mask += 1) {
                const colors = [];
                const choices = [];
                let possible = true;
                for (let color = 0; color < 4; color += 1) {
                    if ((mask & (1 << color)) === 0)
                        continue;
                    const found = byColorValue.get(`${color}:${value}`);
                    if (!found || found.length === 0) {
                        possible = false;
                        break;
                    }
                    colors.push(color);
                    choices.push(found);
                }
                if (!possible || colors.length > rules_1.MAX_SET)
                    continue;
                for (const totalSize of [3, 4]) {
                    const jokerN = totalSize - colors.length;
                    if (jokerN < 0 || jokerN > jokers.length || jokerN > 2)
                        continue;
                    const chosen = [];
                    const chooseJokers = (at, left) => {
                        if (this.outOfTime())
                            return;
                        if (left === 0) {
                            addGroup(chosen);
                            return;
                        }
                        for (let i = at; i <= jokers.length - left; i += 1) {
                            chosen.push(jokers[i]);
                            chooseJokers(i + 1, left - 1);
                            chosen.pop();
                            if (this.outOfTime())
                                return;
                        }
                    };
                    const chooseColors = (i) => {
                        if (this.outOfTime())
                            return;
                        if (i === choices.length) {
                            chooseJokers(0, jokerN);
                            return;
                        }
                        for (const tile of choices[i]) {
                            chosen.push(tile);
                            chooseColors(i + 1);
                            chosen.pop();
                            if (this.outOfTime())
                                return;
                        }
                    };
                    chooseColors(0);
                }
            }
        }
        // Серии: каждая позиция либо закрывается реальным числом, либо одним
        // из имеющихся джокеров. Поэтому сохраняются и варианты, где джокер
        // выгоднее придержать или оставить обычную копию для другого ряда.
        for (let color = 0; color < 4 && !this.outOfTime(); color += 1) {
            for (let start = rules_1.MIN_VALUE; start <= rules_1.MAX_VALUE - 2 && !this.outOfTime(); start += 1) {
                for (let end = start + 2; end <= rules_1.MAX_VALUE && !this.outOfTime(); end += 1) {
                    const values = [];
                    let possible = true;
                    for (let value = start; value <= end; value += 1) {
                        values.push(value);
                        if (!byColorValue.has(`${color}:${value}`) && jokers.length === 0) {
                            possible = false;
                            break;
                        }
                    }
                    if (!possible)
                        continue;
                    const chosen = [];
                    const usedJokers = new Set();
                    const fill = (i) => {
                        if (this.outOfTime())
                            return;
                        if (i === values.length) {
                            addGroup(chosen);
                            return;
                        }
                        const value = values[i];
                        for (const tile of byColorValue.get(`${color}:${value}`) ?? []) {
                            chosen.push(tile);
                            fill(i + 1);
                            chosen.pop();
                            if (this.outOfTime())
                                return;
                        }
                        if (usedJokers.size >= 2)
                            return;
                        for (const joker of jokers) {
                            if (usedJokers.has(joker.id))
                                continue;
                            usedJokers.add(joker.id);
                            chosen.push(joker);
                            fill(i + 1);
                            chosen.pop();
                            usedJokers.delete(joker.id);
                            if (this.outOfTime())
                                return;
                        }
                    };
                    fill(0);
                }
            }
        }
    }
    extendCandidates(hand) {
        if (hand.length === 0)
            return;
        const combos = this.combos(hand, 1, 3);
        for (const r of this._state.table) {
            if (this.outOfTime())
                return;
            if (r.tiles.length === 0)
                continue;
            const oldRes = (0, rules_1.validateRow)(r.tiles);
            const oldPts = oldRes.ok ? (0, rules_1.rowPoints)(r.tiles) : 0;
            const ref = `r${r.id}`;
            for (const combo of combos) {
                if (this.outOfTime())
                    return;
                if (!shapeOk([...r.tiles, ...combo]))
                    continue;
                let done = false;
                for (const order of this.orders(combo)) {
                    if (done)
                        break;
                    for (let side = 0; side < 2; side += 1) {
                        const comp = side === 1 ? [...order, ...r.tiles] : [...r.tiles, ...order];
                        const res = (0, rules_1.validateRow)(comp);
                        if (!res.ok)
                            continue;
                        const newPts = (0, rules_1.rowPoints)(comp);
                        const ops = order.map((t, i) => ({
                            op: 'place',
                            tile: t.id,
                            to: ref,
                            index: side === 1 ? i : 99,
                        }));
                        this._candidates.push(this.mk('extend', [ref], ops, idsOf(order), newPts - oldPts, handPointsOf(order, res), 0, jokerCount(order)));
                        done = true;
                        break;
                    }
                }
            }
        }
    }
    combos(hand, lo, hi) {
        const out = [];
        const n = hand.length;
        for (let comboSize = lo; comboSize <= hi; comboSize += 1) {
            if (comboSize > n)
                break;
            const idx = [];
            for (let i = 0; i < comboSize; i += 1)
                idx.push(i);
            while (true) {
                if ((out.length & 31) === 0 && this.outOfTime())
                    return out;
                out.push(idx.map((i) => hand[i]));
                let p = comboSize - 1;
                while (p >= 0 && idx[p] === n - comboSize + p)
                    p -= 1;
                if (p < 0)
                    break;
                idx[p] += 1;
                for (let q = p + 1; q < comboSize; q += 1)
                    idx[q] = idx[q - 1] + 1;
            }
        }
        return out;
    }
    orders(tiles) {
        const sorted = [...tiles];
        sorted.sort((a, b) => {
            if (a.is_joker !== b.is_joker)
                return a.is_joker ? 1 : -1;
            if (a.color !== b.color)
                return a.color - b.color;
            return a.value - b.value;
        });
        const out = [sorted];
        const jokers = sorted.filter((t) => t.is_joker);
        const reals = sorted.filter((t) => !t.is_joker);
        if (jokers.length === 0 || sorted.length > 8)
            return out;
        this.collectOrders(0, 0, sorted.length, jokers.length, [], reals, jokers, out);
        return out;
    }
    collectOrders(start, depth, n, k, pos, reals, jokers, out) {
        if (depth === k) {
            const chosen = new Set();
            for (const pt of pos)
                chosen.add(pt);
            const order = [];
            let ridx = 0;
            for (let i = 0; i < n; i += 1) {
                if (chosen.has(i))
                    order.push(jokers[pos.indexOf(i)]);
                else {
                    order.push(reals[ridx]);
                    ridx += 1;
                }
            }
            out.push(order);
            return;
        }
        for (let p = start; p <= n - (k - depth); p += 1) {
            pos.push(p);
            this.collectOrders(p + 1, depth + 1, n, k, pos, reals, jokers, out);
            pos.pop();
        }
    }
    stealCandidates(hand) {
        if (hand.length < 2)
            return;
        const combos = this.combos(hand, 2, 3);
        for (const r of this._state.table) {
            if (this.outOfTime())
                return;
            if (r.tiles.length < 4)
                continue;
            const oldRes = (0, rules_1.validateRow)(r.tiles);
            if (!oldRes.ok)
                continue;
            const oldPts = (0, rules_1.rowPoints)(r.tiles);
            const srcRef = `r${r.id}`;
            for (let ti = 0; ti < r.tiles.length; ti += 1) {
                if (this.outOfTime())
                    return;
                const t = r.tiles[ti];
                const rest = [...r.tiles];
                rest.splice(ti, 1);
                if (rest.length < 3)
                    continue;
                if (!(0, rules_1.validateRow)(rest).ok)
                    continue;
                const restPts = (0, rules_1.rowPoints)(rest);
                for (const combo of combos) {
                    if (this.outOfTime())
                        return;
                    if (!this.stealPrefilter(t, combo))
                        continue;
                    const pool = [...combo, t];
                    if (!shapeOk(pool))
                        continue;
                    for (const order of this.orders(pool)) {
                        const res = (0, rules_1.validateRow)(order);
                        if (!res.ok)
                            continue;
                        const pos = order.indexOf(t);
                        const sOrder = [...order];
                        sOrder.splice(sOrder.indexOf(t), 1);
                        const ref = this.nextNRef();
                        const ops = sOrder.map((s) => ({ op: 'place', tile: s.id, to: ref, index: 99 }));
                        ops.push({ op: 'move', tile: t.id, from: srcRef, to: ref, index: pos });
                        const newPts = (0, rules_1.rowPoints)(order);
                        this._candidates.push(this.mk('steal', [srcRef, ref], ops, idsOf(sOrder), newPts + restPts - oldPts, handPointsOf(sOrder, res), BONUS_STEAL, jokerCount(sOrder)));
                        break;
                    }
                }
            }
        }
    }
    stealPrefilter(t, combo) {
        let colorsOk = true;
        let valuesOk = true;
        let c0 = -1;
        let v0 = -1;
        for (const s of combo) {
            if (s.is_joker)
                continue;
            if (c0 === -1)
                c0 = s.color;
            else if (s.color !== c0)
                colorsOk = false;
            if (v0 === -1)
                v0 = s.value;
            else if (s.value !== v0)
                valuesOk = false;
        }
        if (!colorsOk && !valuesOk)
            return false;
        if (t.is_joker)
            return true;
        if (colorsOk && (c0 === -1 || c0 === t.color))
            return true;
        if (valuesOk && (v0 === -1 || v0 === t.value))
            return true;
        return false;
    }
    bridgeCandidates(hand) {
        if (hand.length === 0)
            return;
        const runs = [];
        for (const r of this._state.table) {
            if (this.outOfTime())
                return;
            if (r.tiles.length < 3)
                continue;
            if (r.tiles[0].is_joker || r.tiles[r.tiles.length - 1].is_joker)
                continue;
            const res = (0, rules_1.validateRow)(r.tiles);
            if (res.ok && res.kind === 'run')
                runs.push(r);
        }
        for (let i = 0; i < runs.length; i += 1) {
            if (this.outOfTime())
                return;
            for (let j = 0; j < runs.length; j += 1) {
                if ((j & 15) === 0 && this.outOfTime())
                    return;
                if (i === j)
                    continue;
                const A = runs[i];
                const B = runs[j];
                const colA = A.tiles[0].color;
                const colB = B.tiles[0].color;
                if (colA !== colB)
                    continue;
                const aMax = A.tiles[A.tiles.length - 1].value;
                const bMin = B.tiles[0].value;
                if (bMin <= aMax + 1)
                    continue;
                const gap = [];
                for (let v = aMax + 1; v < bMin; v += 1)
                    gap.push(v);
                if (gap.length > hand.length)
                    continue;
                const gapTiles = this.fillGap(hand, gap, colA);
                if (gapTiles.length === 0 && gap.length > 0)
                    continue;
                const comp = [...A.tiles, ...gapTiles, ...B.tiles];
                const res = (0, rules_1.validateRow)(comp);
                if (!res.ok)
                    continue;
                const refA = `r${A.id}`;
                const refB = `r${B.id}`;
                const ops = gapTiles.map((h) => ({ op: 'place', tile: h.id, to: refA, index: 99 }));
                for (const h of B.tiles)
                    ops.push({ op: 'move', tile: h.id, from: refB, to: refA, index: 99 });
                const gain = (0, rules_1.rowPoints)(comp) - (0, rules_1.rowPoints)(A.tiles) - (0, rules_1.rowPoints)(B.tiles);
                this._candidates.push(this.mk('bridge', [refA, refB], ops, idsOf(gapTiles), gain, handPointsOf(gapTiles, res), BONUS_BRIDGE, jokerCount(gapTiles)));
            }
        }
    }
    fillGap(hand, gap, color) {
        const used = new Set();
        const out = [];
        for (const v of gap) {
            let found = null;
            for (const h of hand) {
                if (used.has(h.id) || h.is_joker)
                    continue;
                if (h.color === color && h.value === v) {
                    found = h;
                    break;
                }
            }
            if (found === null) {
                for (const h of hand) {
                    if (used.has(h.id) || !h.is_joker)
                        continue;
                    found = h;
                    break;
                }
            }
            if (found === null)
                return [];
            used.add(found.id);
            out.push(found);
        }
        return out;
    }
    setupRebuildParams() {
        if (this._level === exports.LEVEL_MEDIUM) {
            this._rb_pool_max = 6;
            this._rb_opt_max = 4;
            this._rb_cand_cap = 12;
            this._rb_try_budget = 900;
            this._rb_pairs = false;
        }
        else if (this._level === exports.LEVEL_HARD) {
            this._rb_pool_max = 7;
            this._rb_opt_max = 6;
            this._rb_cand_cap = 40;
            this._rb_try_budget = 2500;
            this._rb_pairs = true;
        }
    }
    rebuildCandidates(hand) {
        if (hand.length === 0)
            return;
        this._rb_emitted = 0;
        const rows = [];
        for (const r of this._state.table) {
            if (r.tiles.length > 0)
                rows.push(r);
        }
        for (let i = 0; i < rows.length; i += 1) {
            if (this.outOfTime())
                return;
            if (this._rb_emitted >= this._rb_cand_cap)
                return;
            const ri = rows[i];
            if (ri.tiles.length <= this._rb_pool_max)
                this.rebuildTry([ri], hand);
            if (!this._rb_pairs)
                continue;
            for (let j = i + 1; j < rows.length; j += 1) {
                if ((j & 15) === 0 && this.outOfTime())
                    return;
                if (this._rb_emitted >= this._rb_cand_cap)
                    return;
                const rj = rows[j];
                if (ri.tiles.length + rj.tiles.length <= this._rb_pool_max)
                    this.rebuildTry([ri, rj], hand);
            }
        }
    }
    rebuildRelevant(hand, pool) {
        const out = [];
        for (const ht of hand) {
            if (ht.is_joker) {
                out.push(ht);
                continue;
            }
            for (const pt of pool) {
                if (pt.is_joker) {
                    out.push(ht);
                    break;
                }
                if (pt.value === ht.value) {
                    out.push(ht);
                    break;
                }
                if (pt.color === ht.color && Math.abs(pt.value - ht.value) <= 6) {
                    out.push(ht);
                    break;
                }
            }
        }
        if (out.length > this._rb_opt_max)
            out.length = this._rb_opt_max;
        return out;
    }
    rebuildTry(srcRows, hand) {
        this._rb_mand = [];
        this._rb_opt = [];
        this._rb_refs = [];
        this._rb_src = new Map();
        this._rb_hand_ids = new Set();
        this._rb_old_pts = 0;
        for (const row of srcRows) {
            this._rb_refs.push(`r${row.id}`);
            this._rb_old_pts += (0, rules_1.rowPoints)(row.tiles);
            for (const t of row.tiles) {
                this._rb_mand.push(t);
                this._rb_src.set(t.id, `r${row.id}`);
            }
        }
        this._rb_opt = this.rebuildRelevant(hand, this._rb_mand);
        if (this._rb_opt.length === 0)
            return;
        for (const t of this._rb_opt)
            this._rb_hand_ids.add(t.id);
        this._rb_groups = [];
        this._rb_used_opt = 0;
        this._rb_budget = this._rb_try_budget;
        this.rbCover();
    }
    rbCover() {
        this._rb_budget -= 1;
        if (this._rb_budget <= 0 || this.outOfTime())
            return;
        if (this._rb_mand.length === 0) {
            if (this._rb_used_opt >= 1)
                this.rbEmit();
            return;
        }
        const tMin = this._rb_mand[0];
        for (const g of this.rbGroupsFor(tMin)) {
            if (this._rb_budget <= 0 || this.outOfTime())
                return;
            const gIds = new Set(g.map((t) => t.id));
            const newMand = this._rb_mand.filter((t) => !gIds.has(t.id));
            const newOpt = [];
            let added = 0;
            for (const t of this._rb_opt) {
                if (gIds.has(t.id))
                    added += 1;
                else
                    newOpt.push(t);
            }
            const savedMand = this._rb_mand;
            const savedOpt = this._rb_opt;
            const savedUsed = this._rb_used_opt;
            this._rb_mand = newMand;
            this._rb_opt = newOpt;
            this._rb_used_opt += added;
            this._rb_groups.push(g);
            this.rbCover();
            this._rb_groups.pop();
            this._rb_mand = savedMand;
            this._rb_opt = savedOpt;
            this._rb_used_opt = savedUsed;
            if (this._rb_budget <= 0)
                return;
        }
    }
    rbGroupsFor(tMin) {
        const out = [];
        if (this._rb_budget <= 0 || this._rb_emitted >= this._rb_cand_cap)
            return out;
        out.push(...this.rbSetGroups(tMin));
        if (this._rb_budget <= 0)
            return out;
        out.push(...this.rbSeriesGroups(tMin));
        const filtered = [];
        for (const g of out) {
            if (g.length > REBUILD_GROUP_MAX)
                continue;
            if (!g.some((t) => t.id === tMin.id))
                continue;
            filtered.push(g);
        }
        return filtered;
    }
    rbSetGroups(tMin) {
        const out = [];
        const all = [...this._rb_mand, ...this._rb_opt];
        const jokers = all.filter((t) => t.is_joker);
        const values = [];
        if (!tMin.is_joker)
            values.push(tMin.value);
        else {
            const seen = new Set();
            for (const tt of all) {
                if (!tt.is_joker && !seen.has(tt.value)) {
                    seen.add(tt.value);
                    values.push(tt.value);
                }
            }
        }
        for (const v of values) {
            if (this._rb_budget <= 0)
                return out;
            const reals = all.filter((t) => !t.is_joker && t.value === v);
            const cand = [...reals, ...jokers];
            for (let size = rules_1.MIN_TILES; size <= rules_1.MAX_SET; size += 1) {
                if (size > cand.length)
                    break;
                for (const subset of rbSubsets(cand, size, () => this.outOfTime() || this._rb_budget <= 0)) {
                    this._rb_budget -= 1;
                    if (this._rb_budget <= 0)
                        return out;
                    if (!(0, rules_1.validateRow)(subset).ok)
                        continue;
                    out.push(subset);
                }
            }
        }
        return out;
    }
    rbSeriesGroups(tMin) {
        const out = [];
        const all = [...this._rb_mand, ...this._rb_opt];
        const colors = [];
        if (!tMin.is_joker)
            colors.push(tMin.color);
        else {
            const seen = new Set();
            for (const tt of all) {
                if (!tt.is_joker && !seen.has(tt.color)) {
                    seen.add(tt.color);
                    colors.push(tt.color);
                }
            }
            if (colors.length === 0)
                return out;
        }
        let v0 = -1;
        if (!tMin.is_joker)
            v0 = tMin.value;
        else {
            for (const t of all) {
                if (!t.is_joker) {
                    v0 = t.value;
                    break;
                }
            }
        }
        if (v0 < 0)
            return out;
        const jokers = all.filter((t) => t.is_joker);
        const dj = jokers.length;
        const lo = Math.max(rules_1.MIN_VALUE, v0 - 6);
        const hi = Math.min(rules_1.MAX_VALUE, v0 + 6);
        for (const c of colors) {
            for (let s = lo; s <= v0; s += 1) {
                for (let e = v0; e <= hi; e += 1) {
                    if (this._rb_budget <= 0)
                        return out;
                    const reals = [];
                    const holes = [];
                    for (let v = s; v <= e; v += 1) {
                        let pick = null;
                        for (const tt of this._rb_mand) {
                            if (!tt.is_joker && tt.color === c && tt.value === v) {
                                pick = tt;
                                break;
                            }
                        }
                        if (pick === null) {
                            for (const tt of this._rb_opt) {
                                if (!tt.is_joker && tt.color === c && tt.value === v) {
                                    pick = tt;
                                    break;
                                }
                            }
                        }
                        if (pick === null)
                            holes.push(v);
                        else
                            reals.push(pick);
                    }
                    if (holes.length > dj)
                        continue;
                    if (reals.length + Math.min(dj, holes.length + 2) < rules_1.MIN_TILES)
                        continue;
                    if (reals.length > REBUILD_GROUP_MAX)
                        continue;
                    for (let m = holes.length; m <= Math.min(dj, holes.length + 2); m += 1) {
                        if (reals.length + m > REBUILD_GROUP_MAX)
                            continue;
                        for (const subset of rbSubsets(jokers, m, () => this.outOfTime() || this._rb_budget <= 0)) {
                            this._rb_budget -= 1;
                            if (this._rb_budget <= 0)
                                return out;
                            const extra = m - holes.length;
                            for (let trail = 0; trail <= extra; trail += 1) {
                                this._rb_budget -= 1;
                                if (this._rb_budget <= 0)
                                    return out;
                                const order = [];
                                let head = extra - trail;
                                let idx = 0;
                                for (let k = 0; k < head; k += 1) {
                                    order.push(subset[idx]);
                                    idx += 1;
                                }
                                for (let v = s; v <= e; v += 1) {
                                    let placed = false;
                                    for (const t of reals) {
                                        if (t.value === v) {
                                            order.push(t);
                                            placed = true;
                                            break;
                                        }
                                    }
                                    if (!placed) {
                                        order.push(subset[idx]);
                                        idx += 1;
                                    }
                                }
                                for (let k = idx; k < m; k += 1) {
                                    order.push(subset[k]);
                                }
                                if (!(0, rules_1.validateRow)(order).ok)
                                    continue;
                                out.push(order);
                            }
                        }
                    }
                }
            }
        }
        return out;
    }
    rbEmit() {
        if (this._rb_emitted >= this._rb_cand_cap)
            return;
        const ops = [];
        const hand_ids = [];
        let pts = 0;
        let hp = 0;
        const newRefs = [];
        for (const g of this._rb_groups) {
            const ref = this.nextNRef();
            newRefs.push(ref);
            const res = (0, rules_1.validateRow)(g);
            if (!res.ok)
                return;
            pts += (0, rules_1.rowPoints)(g);
            const jv = res.joker_values;
            for (let i = 0; i < g.length; i += 1) {
                const t = g[i];
                if (this._rb_hand_ids.has(t.id)) {
                    ops.push({ op: 'place', tile: t.id, to: ref, index: i });
                    hand_ids.push(t.id);
                    if (t.is_joker)
                        hp += jv[t.id] ?? 0;
                    else
                        hp += t.value;
                }
                else {
                    ops.push({
                        op: 'move',
                        tile: t.id,
                        from: this._rb_src.get(t.id) ?? '',
                        to: ref,
                        index: i,
                    });
                }
            }
        }
        if (hand_ids.length === 0)
            return;
        const refs = [...this._rb_refs, ...newRefs];
        const played = [];
        for (const g of this._rb_groups) {
            for (const t of g) {
                if (hand_ids.includes(t.id))
                    played.push(t);
            }
        }
        this._candidates.push(this.mk('rebuild', refs, ops, hand_ids, pts - this._rb_old_pts, hp, BONUS_REBUILD, jokerCount(played)));
        this._rb_emitted += 1;
    }
    search() {
        const n = this._candidates.length;
        this._suffix = new Array(n + 1);
        this._suffix[n] = 0.0;
        for (let i = n - 1; i >= 0; i -= 1) {
            this._suffix[i] = this._suffix[i + 1] + Math.max(0.0, this._candidates[i].score);
        }
        this._cover = new Array(n + 1);
        this._cover[n] = new Set();
        for (let i = n - 1; i >= 0; i -= 1) {
            const m = new Set(this._cover[i + 1]);
            for (const tid of this._candidates[i].hand_ids)
                m.add(tid);
            this._cover[i] = m;
        }
        this._best = {};
        this.bt(0, new Set(), new Set(), [], 0, 0);
    }
    bt(i, usedHand, usedRefs, chosen, handPoints, curScore) {
        this._budget -= 1;
        if (this._budget <= 0 || this.outOfTime())
            return;
        if (i >= this._candidates.length) {
            this.leaf(chosen, usedHand, handPoints, curScore);
            return;
        }
        const bestScore = this._best && this._best.score !== undefined ? this._best.score : null;
        if (bestScore !== null && curScore + this._suffix[i] <= bestScore && !this.canWin(usedHand, i)) {
            return;
        }
        const c = this._candidates[i];
        if (!this.conflicts(c, usedHand, usedRefs)) {
            const uh = new Set(usedHand);
            const ur = new Set(usedRefs);
            for (const tid of c.hand_ids)
                uh.add(tid);
            for (const ref of c.refs)
                ur.add(ref);
            chosen.push(c);
            const nextHp = handPoints + c.hand_points;
            const nextScore = curScore + c.score;
            if (uh.size === this._hand_ids.size)
                this.leaf(chosen, uh, nextHp, nextScore);
            else
                this.bt(i + 1, uh, ur, chosen, nextHp, nextScore);
            chosen.pop();
            if (this._budget <= 0)
                return;
        }
        this.bt(i + 1, usedHand, usedRefs, chosen, handPoints, curScore);
    }
    leaf(chosen, usedHand, handPoints, curScore) {
        if (chosen.length === 0)
            return;
        const wins = usedHand.size === this._hand_ids.size;
        if (this._need30 && this._base_points + handPoints < rules_1.OPENING_POINTS)
            return;
        if (!wins && curScore <= 0)
            return;
        const bestScore = this._best && this._best.score !== undefined ? this._best.score : null;
        if (bestScore !== null && curScore <= bestScore && !wins)
            return;
        const ops = [];
        let pts = 0;
        const tiles = [];
        for (const c of chosen) {
            ops.push(...c.ops);
            pts += c.points;
            tiles.push(...c.hand_ids);
        }
        this._best = { ops, points: pts, tiles, score: curScore, win: wins };
        if (wins)
            this._budget = 0;
    }
    conflicts(c, usedHand, usedRefs) {
        for (const tid of c.hand_ids) {
            if (usedHand.has(tid))
                return true;
        }
        for (const ref of c.refs) {
            if (usedRefs.has(ref))
                return true;
        }
        return false;
    }
    canWin(usedHand, i) {
        for (const tid of this._hand_ids) {
            if (usedHand.has(tid))
                continue;
            if (!this._cover[i].has(tid))
                return false;
        }
        return true;
    }
}
exports.TurnPlanner = TurnPlanner;
function rbSubsets(items, k, stop = () => false) {
    const out = [];
    if (k <= 0)
        return [[]];
    if (items.length < k)
        return out;
    rbSubsetsRec(items, 0, [], k, out, stop);
    return out;
}
function rbSubsetsRec(items, start, cur, k, out, stop) {
    if (stop())
        return;
    if (cur.length === k) {
        out.push([...cur]);
        return;
    }
    for (let i = start; i <= items.length - (k - cur.length); i += 1) {
        if ((i & 7) === 0 && stop())
            return;
        cur.push(items[i]);
        rbSubsetsRec(items, i + 1, cur, k, out, stop);
        cur.pop();
    }
}
function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
