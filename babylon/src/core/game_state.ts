import { OPENING_POINTS, validateRow } from './rules';
import { t } from './lang';
import { tileById, tryTileById } from './deck';
import { sortTiles, TileFace } from './tile';
import type { GameView } from '../net/protocol';

export const DEAL_SIZE = 14;
export const MAX_CHECKPOINTS = 3;

export class GsPlayer {
  name = '';
  hand: TileFace[] = [];
  is_bot = false;
  constructor(name = '') {
    this.name = name;
  }
}

export class GsRow {
  id = 0;
  tiles: TileFace[] = [];
  constructor(id = 0) {
    this.id = id;
  }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export class Deck {
  tiles: TileFace[] = [];
  constructor() {
    this.rebuild();
  }
  rebuild(): void {
    const catalog: TileFace[] = [];
    let nextId = 1;
    for (let c = 0; c < 4; c += 1) {
      for (let v = 1; v <= 13; v += 1) {
        for (let copy = 0; copy < 2; copy += 1) {
          catalog.push({ id: nextId, color: c, value: v, is_joker: false });
          nextId += 1;
        }
      }
    }
    catalog.push({ id: nextId, color: 4 /* YELLOW */, value: 1, is_joker: true });
    nextId += 1;
    catalog.push({ id: nextId, color: 5 /* PURPLE */, value: 1, is_joker: true });
    nextId += 1;
    shuffle(catalog);
    this.tiles = catalog;
  }
  draw(): TileFace | null {
    return this.tiles.pop() ?? null;
  }
  count(): number {
    return this.tiles.length;
  }
  totalTiles(): number {
    return 106;
  }
}

export interface TurnResult {
  ok: boolean;
  reason: string;
  errors: { row: number; reason: string }[];
  win: boolean;
  tile?: TileFace | null;
}

const OK: TurnResult = { ok: true, reason: '', errors: [], win: false };

function failResult(reason: string): TurnResult {
  return { ok: false, reason, errors: [], win: false };
}

export interface TableSnapshotEntry {
  id: number;
  tiles: TileFace[];
}

export class GameState {
  players: GsPlayer[] = [];
  table: GsRow[] = [];
  deck: Deck = new Deck();
  current = 0;
  require_30 = true;
  first_turn = true;
  finished = false;
  winner = -1;
  turn_placed: TileFace[] = [];
  turn_dirty = false;
  last_turn_tile_ids: number[] = [];
  checkpoints: { table: TableSnapshotEntry[]; hand: TileFace[]; turn_placed: TileFace[] }[] = [];
  private _snap_table: TableSnapshotEntry[] = [];
  private _snap_hand: TileFace[] = [];
  private _next_row_id = 1;
  private _server_row_id_max = 0;
  // сетевая партия
  local_seat = -1;
  hand_count_override: number[] = [];
  deck_count_override = -1;
  connected: boolean[] = [];

  static create(numPlayers: number, names: string[], require30: boolean): GameState {
    const state = new GameState();
    state.require_30 = require30;
    for (let i = 0; i < numPlayers; i += 1) {
      const langName = t('Игрок %d', i + 1);
      const nm = i < names.length && names[i].trim() !== '' ? names[i].trim() : langName;
      state.players.push(new GsPlayer(nm));
    }
    for (const p of state.players) {
      for (let i = 0; i < DEAL_SIZE; i += 1) {
        const tl = state.deck.draw();
        if (tl === null) break;
        p.hand.push(tl);
      }
      sortTiles(p.hand);
    }
    state.takeTurnSnapshot();
    return state;
  }

  // Сборка состояния из серверного GAME_STATE (сетевая партия):
  // своя рука — настоящие фишки; чужие — только счётчики
  // (hand_count_override), тайлы им не известны.
  static fromView(view: GameView): GameState {
    const s = new GameState();
    s.require_30 = view.require30;
    s.first_turn = view.firstTurn;
    s.finished = view.finished;
    s.winner = view.finished ? view.winner : -1;
    s.current = view.current;
    s.local_seat = view.you;
    s.deck_count_override = Math.max(0, view.deckCount);
    s.last_turn_tile_ids = [...view.lastTurn];
    for (const p of view.players) {
      const pl = new GsPlayer(p.nick);
      pl.is_bot = p.isBot;
      s.players.push(pl);
      s.connected.push(p.connected);
      s.hand_count_override.push(p.handCount);
    }
    if (s.players[view.you]) {
      s.players[view.you].is_bot = false;
      s.players[view.you].hand = view.hand.map((id) => tileById(id));
    }
    s.turn_placed = view.turnPlaced
      .map((id) => tryTileById(id))
      .filter((tl): tl is TileFace => tl !== null);
    s.table = view.table
      .filter((r) => r.tileIds.length > 0)
      .map((r) => {
        const row = new GsRow(r.id);
        row.tiles = r.tileIds.map((id) => tileById(id));
        return row;
      });
    let maxId = 0;
    for (const r of s.table) maxId = Math.max(maxId, r.id);
    s.reserveRowIds(maxId);
    s.takeTurnSnapshot();
    return s;
  }

  playerCount(): number {
    return this.players.length;
  }
  playerName(i: number): string {
    return this.players[i].name;
  }
  currentPlayer(): GsPlayer {
    return this.players[this.current];
  }
  isBotPlayer(i: number): boolean {
    if (this.local_seat < 0 || i < 0 || i >= this.players.length) return false;
    return this.players[i].is_bot;
  }
  isConnectedPlayer(i: number): boolean {
    if (i < 0 || i >= this.connected.length) return true;
    return this.connected[i];
  }
  handSeat(): number {
    return this.local_seat >= 0 ? this.local_seat : this.current;
  }
  myTurn(): boolean {
    return this.local_seat < 0 || this.current === this.local_seat;
  }
  hand(): TileFace[] {
    return this.players[this.handSeat()].hand;
  }
  handSize(i: number): number {
    if (this.hand_count_override.length > 0 && i >= 0 && i < this.hand_count_override.length) {
      return this.hand_count_override[i];
    }
    if (i < 0 || i >= this.players.length) return 0;
    return this.players[i].hand.length;
  }
  tilesLeftInDeck(): number {
    if (this.deck_count_override >= 0) return this.deck_count_override;
    return this.deck.count();
  }
  canTouchRow(_row: GsRow): boolean {
    return !this.finished;
  }
  canPlaceInto(_row: GsRow): boolean {
    return !this.finished;
  }
  canTakeBack(tile: TileFace): boolean {
    return !this.finished && this.turn_placed.includes(tile);
  }
  canDraw(): boolean {
    return !this.finished && this.turn_placed.length === 0
      && this.tilesLeftInDeck() > 0 && this.tableStatus().ok;
  }
  canSkip(): boolean {
    return !this.finished && this.turn_placed.length === 0
      && this.tilesLeftInDeck() === 0 && this.tableStatus().ok;
  }
  addRow(): GsRow {
    const row = new GsRow(this._next_row_id);
    this._next_row_id += 1;
    this.table.push(row);
    this.turn_dirty = true;
    return row;
  }
  // Вставка нового ряда на конкретную позицию (слот «новый ряд» между
  // рядами в UI): как addRow, но со splice по индексу.
  addRowAt(index: number): GsRow {
    const row = new GsRow(this._next_row_id);
    this._next_row_id += 1;
    this.table.splice(Math.max(0, Math.min(index, this.table.length)), 0, row);
    this.turn_dirty = true;
    return row;
  }
  reserveRowIds(used: number): void {
    this._next_row_id = Math.max(this._next_row_id, used + 1);
    this._server_row_id_max = Math.max(this._server_row_id_max, used);
  }
  removeRow(row: GsRow): void {
    const i = this.table.indexOf(row);
    if (i >= 0) this.table.splice(i, 1);
  }
  rowById(rowId: number): GsRow | null {
    for (const row of this.table) {
      if (row.id === rowId) return row;
    }
    return null;
  }
  placeFromHand(tileId: number, rowId: number, index: number): boolean {
    if (this.finished) return false;
    const row = this.rowById(rowId);
    if (row === null || !this.canTouchRow(row)) return false;
    const handTiles = this.hand();
    let tile: TileFace | null = null;
    for (const t of handTiles) {
      if (t.id === tileId) {
        tile = t;
        break;
      }
    }
    if (tile === null) return false;
    handTiles.splice(handTiles.indexOf(tile), 1);
    const pos = Math.min(Math.max(index, 0), row.tiles.length);
    row.tiles.splice(pos, 0, tile);
    this.turn_placed.push(tile);
    this.turn_dirty = true;
    return true;
  }
  moveTile(srcRowId: number, tileId: number, dstRowId: number, dstIndex: number): boolean {
    if (this.finished) return false;
    const src = this.rowById(srcRowId);
    const dst = this.rowById(dstRowId);
    if (src === null || dst === null) return false;
    if (!this.canTouchRow(src) || !this.canTouchRow(dst)) return false;
    const old = this.indexOfTile(src, tileId);
    if (old < 0) return false;
    const tile = src.tiles[old];
    if (src === dst) {
      src.tiles.splice(old, 1);
      let target = dstIndex;
      if (old < target) target -= 1;
      target = Math.min(Math.max(target, 0), src.tiles.length);
      src.tiles.splice(target, 0, tile);
      this.turn_dirty = true;
      return true;
    }
    src.tiles.splice(old, 1);
    const pos = Math.min(Math.max(dstIndex, 0), dst.tiles.length);
    dst.tiles.splice(pos, 0, tile);
    if (src.tiles.length === 0) this.removeRow(src);
    this.turn_dirty = true;
    return true;
  }
  takeBackToHand(rowId: number, tileId: number): boolean {
    if (this.finished) return false;
    const row = this.rowById(rowId);
    if (row === null) return false;
    const idx = this.indexOfTile(row, tileId);
    if (idx < 0) return false;
    const tile = row.tiles[idx];
    if (!this.turn_placed.includes(tile)) return false;
    row.tiles.splice(idx, 1);
    this.turn_placed.splice(this.turn_placed.indexOf(tile), 1);
    this.turn_dirty = true;
    const owner = this.handSeat();
    this.players[owner].hand.push(tile);
    sortTiles(this.players[owner].hand);
    if (row.tiles.length === 0) this.removeRow(row);
    return true;
  }
  drawFromDeck(): TurnResult {
    if (this.finished) return failResult(t('Игра окончена'));
    if (this.turn_placed.length !== 0) return failResult(t('Нельзя брать из колоды после выкладки'));
    if (this.deck.count() === 0) return failResult(t('Колода пуста'));
    const status = this.tableStatus();
    if (!status.ok) return failResult(t('Сначала закончите перестановку на столе'));
    const tile = this.deck.draw();
    if (tile === null) return failResult(t('Колода пуста'));
    const me = this.players[this.handSeat()];
    me.hand.push(tile);
    sortTiles(me.hand);
    this.advance();
    return { ok: true, reason: '', errors: [], win: false, tile };
  }
  skipTurn(): TurnResult {
    if (this.finished) return failResult(t('Игра окончена'));
    if (this.deck.count() > 0) return failResult(t('Колода ещё полна - возьмите число'));
    if (this.turn_placed.length !== 0) return failResult(t('Воспользуйтесь кнопкой «Продолжить»'));
    const status = this.tableStatus();
    if (!status.ok) return failResult(t('Сначала закончите перестановку на столе'));
    this.advance();
    return { ...OK };
  }
  checkTurn(): TurnResult {
    if (this.finished) return failResult(t('Игра окончена'));
    if (this.turn_placed.length === 0) {
      return failResult(t('Выложите хотя бы одно число или возьмите из колоды'));
    }
    const status = this.tableStatus();
    if (!status.ok) {
      const errors: { row: number; reason: string }[] = status.errors;
      return {
        ok: false,
        reason: errors.length > 0 ? errors[0].reason : t('Стол в невалидном состоянии'),
        errors,
        win: false,
      };
    }
    if (this.require_30 && this.first_turn) {
      const pts = this.openingPoints();
      if (pts < OPENING_POINTS) {
        return {
          ok: false,
          reason: t('Самый первый ход игры - минимум %d очков (у вас %d)', OPENING_POINTS, pts),
          errors: [],
          win: false,
        };
      }
    }
    return { ...OK };
  }
  endTurn(): TurnResult {
    const check = this.checkTurn();
    if (!check.ok) return check;
    this.first_turn = false;
    this.removeEmptyRows();
    if (this.hand().length === 0) {
      this.winner = this.handSeat();
      this.finished = true;
      return { ok: true, reason: '', errors: [], win: true };
    }
    this.advance();
    return { ...OK };
  }
  setTableRows(): { id: number; tiles: number[] }[] {
    const rows: { id: number; tiles: number[] }[] = [];
    for (const row of this.table) {
      if (row.tiles.length === 0) continue;
      const ids = row.tiles.map((t2) => t2.id);
      const id = row.id <= this._server_row_id_max ? row.id : 0;
      rows.push({ id, tiles: ids });
    }
    return rows;
  }
  tableStatus(): { ok: boolean; errors: { row: number; reason: string }[] } {
    const errors: { row: number; reason: string }[] = [];
    for (let i = 0; i < this.table.length; i += 1) {
      const tiles = this.table[i].tiles;
      if (tiles.length === 0) continue;
      const result = validateRow(tiles);
      if (!result.ok) errors.push({ row: i, reason: result.reason });
    }
    return { ok: errors.length === 0, errors };
  }
  openingPoints(): number {
    let total = 0;
    for (const tile of this.turn_placed) {
      for (const row of this.table) {
        const idx = this.indexOfTile(row, tile.id);
        if (idx < 0) continue;
        const result = validateRow(row.tiles);
        if (tile.is_joker && result.ok) total += result.joker_values[tile.id] ?? 0;
        else total += tile.value;
        break;
      }
    }
    return total;
  }
  private advance(): void {
    this.last_turn_tile_ids = this.turn_placed.map((t2) => t2.id);
    this.turn_placed = [];
    this.first_turn = false;
    this.checkpoints = [];
    this.current = (this.current + 1) % this.playerCount();
    this.takeTurnSnapshot();
  }
  saveCheckpoint(): boolean {
    if (this.finished || !this.turn_dirty) return false;
    this.checkpoints.push({
      table: this.captureTable(),
      hand: [...this.hand()],
      turn_placed: [...this.turn_placed],
    });
    while (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.shift();
    return true;
  }
  restoreCheckpoint(): boolean {
    if (this.finished || this.checkpoints.length === 0) return false;
    const snap = this.checkpoints.pop()!;
    this.applyTable(snap.table);
    this.players[this.handSeat()].hand = [...snap.hand];
    this.turn_placed = [...snap.turn_placed];
    this.turn_dirty = true;
    return true;
  }
  checkpointCount(): number {
    return this.checkpoints.length;
  }
  applyOps(ops: any[]): boolean {
    if (this.finished) return false;
    const created: Record<string, number> = {};
    for (const op of ops) {
      const kind = String(op.op ?? '');
      if (kind === 'place') {
        const row = this.resolveRef(String(op.to ?? ''), created);
        if (row === null) return false;
        if (!this.placeFromHand(Number(op.tile ?? -1), row.id, Number(op.index ?? 99))) return false;
      } else if (kind === 'move') {
        const src = this.resolveRef(String(op.from ?? ''), created);
        const dst = this.resolveRef(String(op.to ?? ''), created);
        if (src === null || dst === null) return false;
        if (!this.moveTile(src.id, Number(op.tile ?? -1), dst.id, Number(op.index ?? 99))) return false;
      } else {
        return false;
      }
    }
    return true;
  }
  // Итератор операций с ОБЩЕЙ картой созданных рядов: позволяет применять
  // `place`-операции по одной (для пошаговой анимации бота), не заводя при
  // этом отдельную строку на каждую фишку. Соответствует пакетной семантике
  // applyOps, но с разбиением по шагам.
  createOpsLooper(): (op: any) => boolean {
    const created: Record<string, number> = {};
    return (op: any): boolean => {
      if (this.finished) return false;
      const kind = String(op.op ?? '');
      if (kind === 'place') {
        const row = this.resolveRef(String(op.to ?? ''), created);
        if (row === null) return false;
        return this.placeFromHand(Number(op.tile ?? -1), row.id, Number(op.index ?? 99));
      }
      if (kind === 'move') {
        const src = this.resolveRef(String(op.from ?? ''), created);
        const dst = this.resolveRef(String(op.to ?? ''), created);
        if (src === null || dst === null) return false;
        return this.moveTile(src.id, Number(op.tile ?? -1), dst.id, Number(op.index ?? 99));
      }
      return false;
    };
  }
  private resolveRef(ref: string, created: Record<string, number>): GsRow | null {
    if (ref.startsWith('n')) {
      if (!(ref in created)) created[ref] = this.addRow().id;
      return this.rowById(created[ref]);
    }
    if (ref.startsWith('r')) return this.rowById(Number(ref.slice(1)));
    return null;
  }
  private removeEmptyRows(): void {
    this.table = this.table.filter((row) => row.tiles.length > 0);
  }
  captureTable(): TableSnapshotEntry[] {
    return this.table.map((r) => ({ id: r.id, tiles: [...r.tiles] }));
  }
  applyTable(data: TableSnapshotEntry[]): void {
    this.table = data.map((entry) => {
      const r = new GsRow(entry.id);
      r.tiles = [...entry.tiles];
      return r;
    });
  }
  takeTurnSnapshot(): void {
    this._snap_table = this.captureTable();
    this._snap_hand = [...this.players[this.handSeat()].hand];
    this.turn_dirty = false;
  }
  restoreTurnSnapshot(): boolean {
    if (this.finished) return false;
    this.applyTable(this._snap_table);
    this.players[this.handSeat()].hand = [...this._snap_hand];
    this.turn_placed = [];
    this.turn_dirty = false;
    return true;
  }
  keepLocalTurnFrom(prev: GameState | null): boolean {
    if (prev === null || prev.finished || this.finished) return false;
    if (this.local_seat < 0 || this.current !== this.local_seat) return false;
    if (!prev.turn_dirty || prev.turn_placed.length === 0) return false;
    if (JSON.stringify(prev.snapSignature) !== JSON.stringify(this.snapSignature)) return false;
    this.applyTable(prev.captureTable());
    this.turn_placed = [...prev.turn_placed];
    const handP = this.players[this.handSeat()];
    for (const tp of this.turn_placed) {
      const hi = handP.hand.findIndex((h) => h.id === tp.id);
      if (hi >= 0) handP.hand.splice(hi, 1);
    }
    this.turn_dirty = true;
    return true;
  }
  get snapSignature(): Array<{ id: number; ids: number[] }> {
    return this._snap_table.map((e) => ({ id: e.id, ids: e.tiles.map((t2) => t2.id) }));
  }
  private indexOfTile(row: GsRow, tileId: number): number {
    for (let i = 0; i < row.tiles.length; i += 1) {
      if (row.tiles[i].id === tileId) return i;
    }
    return -1;
  }
}


