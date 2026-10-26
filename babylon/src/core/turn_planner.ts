import { GameState } from './game_state';
import { OPENING_POINTS, MAX_SET, MAX_VALUE, MIN_TILES, MIN_VALUE, rowPoints, validateRow } from './rules';
import { TileFace } from './tile';

export const LEVEL_EASY = 0;
export const LEVEL_MEDIUM = 1;
export const LEVEL_HARD = 2;
export const LEVEL_IMPOSSIBLE = 3;

const BUDGET_MEDIUM = 8000;
const BUDGET_HARD = 40000;

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

export interface Candidate {
  kind: string;
  refs: string[];
  ops: any[];
  hand_ids: number[];
  points: number;
  hand_points: number;
  bonus: number;
  jokers: number;
  score: number;
}

export interface PlanResult {
  action: 'place' | 'draw' | 'skip' | 'end';
  ops: any[];
  points: number;
  tiles: number[];
}

const END_PLAN: PlanResult = { action: 'end', ops: [], points: 0, tiles: [] };

function idsOf(tiles: TileFace[]): number[] {
  return tiles.map((t) => t.id);
}

function jokerCount(tiles: TileFace[]): number {
  let n = 0;
  for (const t of tiles) if (t.is_joker) n += 1;
  return n;
}

function handPointsOf(tiles: TileFace[], res: { joker_values: Record<number, number> }): number {
  let total = 0;
  for (const t of tiles) {
    if (t.is_joker) total += res.joker_values[t.id] ?? 0;
    else total += t.value;
  }
  return total;
}

function shapeOk(tiles: TileFace[]): boolean {
  let colorsOk = true;
  let valuesOk = true;
  let c0 = -1;
  let v0 = -1;
  for (const t of tiles) {
    if (t.is_joker) continue;
    if (c0 === -1) c0 = t.color;
    else if (t.color !== c0) colorsOk = false;
    if (v0 === -1) v0 = t.value;
    else if (t.value !== v0) valuesOk = false;
    if (!colorsOk && !valuesOk) return false;
  }
  return colorsOk || valuesOk;
}

export class TurnPlanner {
  private _state!: GameState;
  private _level = LEVEL_MEDIUM;
  private _candidates: Candidate[] = [];
  private _hand_ids = new Set<number>();
  private _base_points = 0;
  private _need30 = false;
  private _n_ref = 0;
  private _budget = 0;
  private _best: any = {};
  private _suffix: number[] = [];
  private _cover: Set<number>[] = [];

  private _rb_budget = 0;
  private _rb_emitted = 0;
  private _rb_mand: TileFace[] = [];
  private _rb_opt: TileFace[] = [];
  private _rb_refs: string[] = [];
  private _rb_src = new Map<number, string>();
  private _rb_hand_ids = new Set<number>();
  private _rb_old_pts = 0;
  private _rb_groups: TileFace[][] = [];
  private _rb_used_opt = 0;
  private _rb_pool_max = 8;
  private _rb_opt_max = 8;
  private _rb_cand_cap = 150;
  private _rb_try_budget = 6000;
  private _rb_pairs = true;

  static plan(state: GameState, level: number): PlanResult {
    const p = new TurnPlanner();
    return p.plan(state, level);
  }

  plan(state: GameState, level: number): PlanResult {
    this._state = state;
    this._level = Math.min(Math.max(level, 0), 3);
    this.setupRebuildParams();
    if (state.finished) return { ...END_PLAN };
    this._base_points = state.openingPoints();
    this._need30 = state.require_30 && state.first_turn;
    this.buildCandidates();
    this.rankCandidates();
    if (this._level === LEVEL_EASY) {
      const single = this.randomSingle();
      if (single !== null) return single;
      if (state.canDraw() && Math.random() < 0.35) return { action: 'draw', ops: [], points: 0, tiles: [] };
    }
    this._budget = this._level <= LEVEL_MEDIUM ? BUDGET_MEDIUM : BUDGET_HARD;
    this.search();
    if (this._best !== null && this._best !== undefined && Object.keys(this._best).length > 0) {
      return {
        action: 'place',
        ops: this._best.ops,
        points: Number(this._best.points),
        tiles: this._best.tiles,
      };
    }
    if (state.canDraw()) return { action: 'draw', ops: [], points: 0, tiles: [] };
    if (state.canSkip()) return { action: 'skip', ops: [], points: 0, tiles: [] };
    return { ...END_PLAN };
  }

  mk(kind: string, refs: string[], ops: any[], handIds: number[], points: number,
    handPoints: number, bonus: number, jokers = 0): Candidate {
    let pen = 0;
    for (let i = 0; i < jokers; i += 1) pen += this.jokerPenalty();
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

  jokerPenalty(): number {
    if (this._level <= LEVEL_EASY) return 0.0;
    const total = 106.0;
    const left = this._state.tilesLeftInDeck();
    if (total <= 0.0) return JOKER_HOLD_LATE[this._level];
    const late = 1.0 - left / total;
    const a = JOKER_HOLD[this._level];
    const b = JOKER_HOLD_LATE[this._level];
    return a + (b - a) * late;
  }

  nextNRef(): string {
    const ref = `n${this._n_ref}`;
    this._n_ref += 1;
    return ref;
  }

  randomSingle(): PlanResult | null {
    const pool: Candidate[] = [];
    for (const c of this._candidates) {
      if (c.score <= 0) continue;
      if (this._need30 && this._base_points + c.hand_points < OPENING_POINTS) continue;
      pool.push(c);
    }
    if (pool.length === 0) return null;
    const c = pool[Math.floor(Math.random() * pool.length)];
    return { action: 'place', ops: [...c.ops], points: c.points, tiles: [...c.hand_ids] };
  }

  buildCandidates(): void {
    this._candidates = [];
    this._hand_ids = new Set();
    this._n_ref = 0;
    const hand = this._state.hand();
    for (const t of hand) this._hand_ids.add(t.id);
    this.packCandidates(hand);
    this.extendCandidates(hand);
    if (this._level >= LEVEL_IMPOSSIBLE) {
      this.stealCandidates(hand);
      this.bridgeCandidates(hand);
    }
    if (this._level >= LEVEL_MEDIUM) this.rebuildCandidates(hand);
  }

  rankCandidates(): void {
    this._candidates.sort((a, b) => b.score - a.score);
    let cap = CAP_MEDIUM;
    switch (this._level) {
      case LEVEL_EASY: cap = CAP_EASY; break;
      case LEVEL_MEDIUM: cap = CAP_MEDIUM; break;
      case LEVEL_HARD: cap = CAP_HARD; break;
      case LEVEL_IMPOSSIBLE: cap = CAP_IMPOSSIBLE; break;
      default: break;
    }
    if (this._candidates.length > cap) this._candidates.length = cap;
  }

  packCandidates(hand: TileFace[]): void {
    const n = hand.length;
    if (n < 3 || n > 16) return;
    const limit = 1 << n;
    for (let mask = 1; mask < limit; mask += 1) {
      const subset: TileFace[] = [];
      for (let i = 0; i < n; i += 1) {
        if ((mask & (1 << i)) !== 0) subset.push(hand[i]);
      }
      if (subset.length < 3) continue;
      if (!shapeOk(subset)) continue;
      for (const order of this.orders(subset)) {
        const res = validateRow(order);
        if (!res.ok) continue;
        const pts = rowPoints(order);
        const ref = this.nextNRef();
        const ops = order.map((t) => ({ op: 'place', tile: t.id, to: ref, index: 99 }));
        this._candidates.push(this.mk('new', [ref], ops, idsOf(order), pts, pts, 0, jokerCount(order)));
        break;
      }
    }
  }

  extendCandidates(hand: TileFace[]): void {
    if (hand.length === 0) return;
    const combos = this.combos(hand, 1, 3);
    for (const r of this._state.table) {
      if (r.tiles.length === 0) continue;
      const oldRes = validateRow(r.tiles);
      const oldPts = oldRes.ok ? rowPoints(r.tiles) : 0;
      const ref = `r${r.id}`;
      for (const combo of combos) {
        if (!shapeOk([...r.tiles, ...combo])) continue;
        let done = false;
        for (const order of this.orders(combo)) {
          if (done) break;
          for (let side = 0; side < 2; side += 1) {
            const comp: TileFace[] = side === 1 ? [...order, ...r.tiles] : [...r.tiles, ...order];
            const res = validateRow(comp);
            if (!res.ok) continue;
            const newPts = rowPoints(comp);
            const ops = order.map((t, i) => ({
              op: 'place',
              tile: t.id,
              to: ref,
              index: side === 1 ? i : 99,
            }));
            this._candidates.push(this.mk('extend', [ref], ops, idsOf(order),
              newPts - oldPts, handPointsOf(order, res), 0, jokerCount(order)));
            done = true;
            break;
          }
        }
      }
    }
  }

  combos(hand: TileFace[], lo: number, hi: number): TileFace[][] {
    const out: TileFace[][] = [];
    const n = hand.length;
    for (let comboSize = lo; comboSize <= hi; comboSize += 1) {
      if (comboSize > n) break;
      const idx: number[] = [];
      for (let i = 0; i < comboSize; i += 1) idx.push(i);
      while (true) {
        out.push(idx.map((i) => hand[i]));
        let p = comboSize - 1;
        while (p >= 0 && idx[p] === n - comboSize + p) p -= 1;
        if (p < 0) break;
        idx[p] += 1;
        for (let q = p + 1; q < comboSize; q += 1) idx[q] = idx[q - 1] + 1;
      }
    }
    return out;
  }

  orders(tiles: TileFace[]): TileFace[][] {
    const sorted = [...tiles];
    sorted.sort((a, b) => {
      if (a.is_joker !== b.is_joker) return a.is_joker ? 1 : -1;
      if (a.color !== b.color) return a.color - b.color;
      return a.value - b.value;
    });
    const out: TileFace[][] = [sorted];
    const jokers = sorted.filter((t) => t.is_joker);
    const reals = sorted.filter((t) => !t.is_joker);
    if (jokers.length === 0 || sorted.length > 8) return out;
    this.collectOrders(0, 0, sorted.length, jokers.length, [], reals, jokers, out);
    return out;
  }

  collectOrders(start: number, depth: number, n: number, k: number, pos: number[],
    reals: TileFace[], jokers: TileFace[], out: TileFace[][]): void {
    if (depth === k) {
      const chosen = new Set<number>();
      for (const pt of pos) chosen.add(pt);
      const order: TileFace[] = [];
      let ridx = 0;
      for (let i = 0; i < n; i += 1) {
        if (chosen.has(i)) order.push(jokers[pos.indexOf(i)]);
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

  stealCandidates(hand: TileFace[]): void {
    if (hand.length < 2) return;
    const combos = this.combos(hand, 2, 3);
    for (const r of this._state.table) {
      if (r.tiles.length < 4) continue;
      const oldRes = validateRow(r.tiles);
      if (!oldRes.ok) continue;
      const oldPts = rowPoints(r.tiles);
      const srcRef = `r${r.id}`;
      for (let ti = 0; ti < r.tiles.length; ti += 1) {
        const t = r.tiles[ti];
        const rest = [...r.tiles];
        rest.splice(ti, 1);
        if (rest.length < 3) continue;
        if (!validateRow(rest).ok) continue;
        const restPts = rowPoints(rest);
        for (const combo of combos) {
          if (!this.stealPrefilter(t, combo)) continue;
          const pool: TileFace[] = [...combo, t];
          if (!shapeOk(pool)) continue;
          for (const order of this.orders(pool)) {
            const res = validateRow(order);
            if (!res.ok) continue;
            const pos = order.indexOf(t);
            const sOrder = [...order];
            sOrder.splice(sOrder.indexOf(t), 1);
            const ref = this.nextNRef();
            const ops: any[] = sOrder.map((s) => ({ op: 'place', tile: s.id, to: ref, index: 99 }));
            ops.push({ op: 'move', tile: t.id, from: srcRef, to: ref, index: pos });
            const newPts = rowPoints(order);
            this._candidates.push(this.mk('steal', [srcRef, ref], ops, idsOf(sOrder),
              newPts + restPts - oldPts, handPointsOf(sOrder, res), BONUS_STEAL, jokerCount(sOrder)));
            break;
          }
        }
      }
    }
  }

  stealPrefilter(t: TileFace, combo: TileFace[]): boolean {
    let colorsOk = true;
    let valuesOk = true;
    let c0 = -1;
    let v0 = -1;
    for (const s of combo) {
      if (s.is_joker) continue;
      if (c0 === -1) c0 = s.color;
      else if (s.color !== c0) colorsOk = false;
      if (v0 === -1) v0 = s.value;
      else if (s.value !== v0) valuesOk = false;
    }
    if (!colorsOk && !valuesOk) return false;
    if (t.is_joker) return true;
    if (colorsOk && (c0 === -1 || c0 === t.color)) return true;
    if (valuesOk && (v0 === -1 || v0 === t.value)) return true;
    return false;
  }

  bridgeCandidates(hand: TileFace[]): void {
    if (hand.length === 0) return;
    const runs: any[] = [];
    for (const r of this._state.table) {
      if (r.tiles.length < 3) continue;
      if (r.tiles[0].is_joker || r.tiles[r.tiles.length - 1].is_joker) continue;
      const res = validateRow(r.tiles);
      if (res.ok && res.kind === 'run') runs.push(r);
    }
    for (let i = 0; i < runs.length; i += 1) {
      for (let j = 0; j < runs.length; j += 1) {
        if (i === j) continue;
        const A = runs[i];
        const B = runs[j];
        const colA = A.tiles[0].color;
        const colB = B.tiles[0].color;
        if (colA !== colB) continue;
        const aMax = A.tiles[A.tiles.length - 1].value;
        const bMin = B.tiles[0].value;
        if (bMin <= aMax + 1) continue;
        const gap: number[] = [];
        for (let v = aMax + 1; v < bMin; v += 1) gap.push(v);
        if (gap.length > hand.length) continue;
        const gapTiles = this.fillGap(hand, gap, colA);
        if (gapTiles.length === 0 && gap.length > 0) continue;
        const comp: TileFace[] = [...A.tiles, ...gapTiles, ...B.tiles];
        const res = validateRow(comp);
        if (!res.ok) continue;
        const refA = `r${A.id}`;
        const refB = `r${B.id}`;
        const ops: any[] = gapTiles.map((h) => ({ op: 'place', tile: h.id, to: refA, index: 99 }));
        for (const h of B.tiles) ops.push({ op: 'move', tile: h.id, from: refB, to: refA, index: 99 });
        const gain = rowPoints(comp) - rowPoints(A.tiles) - rowPoints(B.tiles);
        this._candidates.push(this.mk('bridge', [refA, refB], ops, idsOf(gapTiles),
          gain, handPointsOf(gapTiles, res), BONUS_BRIDGE, jokerCount(gapTiles)));
      }
    }
  }

  fillGap(hand: TileFace[], gap: number[], color: number): TileFace[] {
    const used = new Set<number>();
    const out: TileFace[] = [];
    for (const v of gap) {
      let found: TileFace | null = null;
      for (const h of hand) {
        if (used.has(h.id) || h.is_joker) continue;
        if (h.color === color && h.value === v) {
          found = h;
          break;
        }
      }
      if (found === null) {
        for (const h of hand) {
          if (used.has(h.id) || !h.is_joker) continue;
          found = h;
          break;
        }
      }
      if (found === null) return [];
      used.add(found.id);
      out.push(found);
    }
    return out;
  }

  setupRebuildParams(): void {
    if (this._level === LEVEL_MEDIUM) {
      this._rb_pool_max = 6;
      this._rb_opt_max = 4;
      this._rb_cand_cap = 12;
      this._rb_try_budget = 900;
      this._rb_pairs = false;
    } else if (this._level === LEVEL_HARD) {
      this._rb_pool_max = 7;
      this._rb_opt_max = 6;
      this._rb_cand_cap = 40;
      this._rb_try_budget = 2500;
      this._rb_pairs = true;
    }
  }

  rebuildCandidates(hand: TileFace[]): void {
    if (hand.length === 0) return;
    this._rb_emitted = 0;
    const rows: any[] = [];
    for (const r of this._state.table) {
      if (r.tiles.length > 0) rows.push(r);
    }
    for (let i = 0; i < rows.length; i += 1) {
      if (this._rb_emitted >= this._rb_cand_cap) return;
      const ri = rows[i];
      if (ri.tiles.length <= this._rb_pool_max) this.rebuildTry([ri], hand);
      if (!this._rb_pairs) continue;
      for (let j = i + 1; j < rows.length; j += 1) {
        if (this._rb_emitted >= this._rb_cand_cap) return;
        const rj = rows[j];
        if (ri.tiles.length + rj.tiles.length <= this._rb_pool_max) this.rebuildTry([ri, rj], hand);
      }
    }
  }

  rebuildRelevant(hand: TileFace[], pool: TileFace[]): TileFace[] {
    const out: TileFace[] = [];
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
    if (out.length > this._rb_opt_max) out.length = this._rb_opt_max;
    return out;
  }

  rebuildTry(srcRows: any[], hand: TileFace[]): void {
    this._rb_mand = [];
    this._rb_opt = [];
    this._rb_refs = [];
    this._rb_src = new Map();
    this._rb_hand_ids = new Set();
    this._rb_old_pts = 0;
    for (const row of srcRows) {
      this._rb_refs.push(`r${row.id}`);
      this._rb_old_pts += rowPoints(row.tiles);
      for (const t of row.tiles) {
        this._rb_mand.push(t);
        this._rb_src.set(t.id, `r${row.id}`);
      }
    }
    this._rb_opt = this.rebuildRelevant(hand, this._rb_mand);
    if (this._rb_opt.length === 0) return;
    for (const t of this._rb_opt) this._rb_hand_ids.add(t.id);
    this._rb_groups = [];
    this._rb_used_opt = 0;
    this._rb_budget = this._rb_try_budget;
    this.rbCover();
  }

  rbCover(): void {
    this._rb_budget -= 1;
    if (this._rb_budget <= 0) return;
    if (this._rb_mand.length === 0) {
      if (this._rb_used_opt >= 1) this.rbEmit();
      return;
    }
    const tMin = this._rb_mand[0];
    for (const g of this.rbGroupsFor(tMin)) {
      if (this._rb_budget <= 0) return;
      const gIds = new Set(g.map((t) => t.id));
      const newMand = this._rb_mand.filter((t) => !gIds.has(t.id));
      const newOpt: TileFace[] = [];
      let added = 0;
      for (const t of this._rb_opt) {
        if (gIds.has(t.id)) added += 1;
        else newOpt.push(t);
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
      if (this._rb_budget <= 0) return;
    }
  }

  rbGroupsFor(tMin: TileFace): TileFace[][] {
    const out: TileFace[][] = [];
    if (this._rb_budget <= 0 || this._rb_emitted >= this._rb_cand_cap) return out;
    out.push(...this.rbSetGroups(tMin));
    if (this._rb_budget <= 0) return out;
    out.push(...this.rbSeriesGroups(tMin));
    const filtered: TileFace[][] = [];
    for (const g of out) {
      if (g.length > REBUILD_GROUP_MAX) continue;
      if (!g.some((t) => t.id === tMin.id)) continue;
      filtered.push(g);
    }
    return filtered;
  }

  rbSetGroups(tMin: TileFace): TileFace[][] {
    const out: TileFace[][] = [];
    const all: TileFace[] = [...this._rb_mand, ...this._rb_opt];
    const jokers = all.filter((t) => t.is_joker);
    const values: number[] = [];
    if (!tMin.is_joker) values.push(tMin.value);
    else {
      const seen = new Set<number>();
      for (const tt of all) {
        if (!tt.is_joker && !seen.has(tt.value)) {
          seen.add(tt.value);
          values.push(tt.value);
        }
      }
    }
    for (const v of values) {
      if (this._rb_budget <= 0) return out;
      const reals = all.filter((t) => !t.is_joker && t.value === v);
      const cand: TileFace[] = [...reals, ...jokers];
      for (let size = MIN_TILES; size <= MAX_SET; size += 1) {
        if (size > cand.length) break;
        for (const subset of rbSubsets(cand, size)) {
          this._rb_budget -= 1;
          if (this._rb_budget <= 0) return out;
          if (!validateRow(subset).ok) continue;
          out.push(subset);
        }
      }
    }
    return out;
  }

  rbSeriesGroups(tMin: TileFace): TileFace[][] {
    const out: TileFace[][] = [];
    const all: TileFace[] = [...this._rb_mand, ...this._rb_opt];
    const colors: number[] = [];
    if (!tMin.is_joker) colors.push(tMin.color);
    else {
      const seen = new Set<number>();
      for (const tt of all) {
        if (!tt.is_joker && !seen.has(tt.color)) {
          seen.add(tt.color);
          colors.push(tt.color);
        }
      }
      if (colors.length === 0) return out;
    }
    let v0 = -1;
    if (!tMin.is_joker) v0 = tMin.value;
    else {
      for (const t of all) {
        if (!t.is_joker) {
          v0 = t.value;
          break;
        }
      }
    }
    if (v0 < 0) return out;
    const jokers = all.filter((t) => t.is_joker);
    const dj = jokers.length;
    const lo = Math.max(MIN_VALUE, v0 - 6);
    const hi = Math.min(MAX_VALUE, v0 + 6);
    for (const c of colors) {
      for (let s = lo; s <= v0; s += 1) {
        for (let e = v0; e <= hi; e += 1) {
          if (this._rb_budget <= 0) return out;
          const reals: TileFace[] = [];
          const holes: number[] = [];
          for (let v = s; v <= e; v += 1) {
            let pick: TileFace | null = null;
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
            if (pick === null) holes.push(v);
            else reals.push(pick);
          }
          if (holes.length > dj) continue;
          if (reals.length + Math.min(dj, holes.length + 2) < MIN_TILES) continue;
          if (reals.length > REBUILD_GROUP_MAX) continue;
          for (let m = holes.length; m <= Math.min(dj, holes.length + 2); m += 1) {
            if (reals.length + m > REBUILD_GROUP_MAX) continue;
            for (const subset of rbSubsets(jokers, m)) {
              this._rb_budget -= 1;
              if (this._rb_budget <= 0) return out;
              const extra = m - holes.length;
              for (let trail = 0; trail <= extra; trail += 1) {
                this._rb_budget -= 1;
                if (this._rb_budget <= 0) return out;
                const order: TileFace[] = [];
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
                if (!validateRow(order).ok) continue;
                out.push(order);
              }
            }
          }
        }
      }
    }
    return out;
  }

  rbEmit(): void {
    if (this._rb_emitted >= this._rb_cand_cap) return;
    const ops: any[] = [];
    const hand_ids: number[] = [];
    let pts = 0;
    let hp = 0;
    const newRefs: string[] = [];
    for (const g of this._rb_groups) {
      const ref = this.nextNRef();
      newRefs.push(ref);
      const res = validateRow(g);
      if (!res.ok) return;
      pts += rowPoints(g);
      const jv = res.joker_values;
      for (let i = 0; i < g.length; i += 1) {
        const t = g[i];
        if (this._rb_hand_ids.has(t.id)) {
          ops.push({ op: 'place', tile: t.id, to: ref, index: i });
          hand_ids.push(t.id);
          if (t.is_joker) hp += jv[t.id] ?? 0;
          else hp += t.value;
        } else {
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
    if (hand_ids.length === 0) return;
    const refs: string[] = [...this._rb_refs, ...newRefs];
    const played: TileFace[] = [];
    for (const g of this._rb_groups) {
      for (const t of g) {
        if (hand_ids.includes(t.id)) played.push(t);
      }
    }
    this._candidates.push(this.mk('rebuild', refs, ops, hand_ids, pts - this._rb_old_pts,
      hp, BONUS_REBUILD, jokerCount(played)));
    this._rb_emitted += 1;
  }

  search(): void {
    const n = this._candidates.length;
    this._suffix = new Array(n + 1);
    this._suffix[n] = 0.0;
    for (let i = n - 1; i >= 0; i -= 1) {
      this._suffix[i] = this._suffix[i + 1] + Math.max(0.0, this._candidates[i].score);
    }
    this._cover = new Array(n + 1);
    this._cover[n] = new Set<number>();
    for (let i = n - 1; i >= 0; i -= 1) {
      const m = new Set<number>(this._cover[i + 1]);
      for (const tid of this._candidates[i].hand_ids) m.add(tid);
      this._cover[i] = m;
    }
    this._best = {};
    this.bt(0, new Set<number>(), new Set<string>(), [], 0, 0);
  }

  bt(i: number, usedHand: Set<number>, usedRefs: Set<string>, chosen: Candidate[],
    handPoints: number, curScore: number): void {
    this._budget -= 1;
    if (this._budget <= 0) return;
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
      const uh = new Set<number>(usedHand);
      const ur = new Set<string>(usedRefs);
      for (const tid of c.hand_ids) uh.add(tid);
      for (const ref of c.refs) ur.add(ref);
      chosen.push(c);
      const nextHp = handPoints + c.hand_points;
      const nextScore = curScore + c.score;
      if (uh.size === this._hand_ids.size) this.leaf(chosen, uh, nextHp, nextScore);
      else this.bt(i + 1, uh, ur, chosen, nextHp, nextScore);
      chosen.pop();
      if (this._budget <= 0) return;
    }
    this.bt(i + 1, usedHand, usedRefs, chosen, handPoints, curScore);
  }

  leaf(chosen: Candidate[], usedHand: Set<number>, handPoints: number, curScore: number): void {
    if (chosen.length === 0) return;
    const wins = usedHand.size === this._hand_ids.size;
    if (this._need30 && this._base_points + handPoints < OPENING_POINTS) return;
    if (!wins && curScore <= 0) return;
    const bestScore = this._best && this._best.score !== undefined ? this._best.score : null;
    if (bestScore !== null && curScore <= bestScore && !wins) return;
    const ops: any[] = [];
    let pts = 0;
    const tiles: number[] = [];
    for (const c of chosen) {
      ops.push(...c.ops);
      pts += c.points;
      tiles.push(...c.hand_ids);
    }
    this._best = { ops, points: pts, tiles, score: curScore, win: wins };
    if (wins) this._budget = 0;
  }

  conflicts(c: Candidate, usedHand: Set<number>, usedRefs: Set<string>): boolean {
    for (const tid of c.hand_ids) {
      if (usedHand.has(tid)) return true;
    }
    for (const ref of c.refs) {
      if (usedRefs.has(ref)) return true;
    }
    return false;
  }

  canWin(usedHand: Set<number>, i: number): boolean {
    for (const tid of this._hand_ids) {
      if (usedHand.has(tid)) continue;
      if (!this._cover[i].has(tid)) return false;
    }
    return true;
  }
}

function rbSubsets(items: TileFace[], k: number): TileFace[][] {
  const out: TileFace[][] = [];
  if (k <= 0) return [[]];
  if (items.length < k) return out;
  rbSubsetsRec(items, 0, [], k, out);
  return out;
}

function rbSubsetsRec(items: TileFace[], start: number, cur: TileFace[], k: number, out: TileFace[][]): void {
  if (cur.length === k) {
    out.push([...cur]);
    return;
  }
  for (let i = start; i <= items.length - (k - cur.length); i += 1) {
    cur.push(items[i]);
    rbSubsetsRec(items, i + 1, cur, k, out);
    cur.pop();
  }
}
