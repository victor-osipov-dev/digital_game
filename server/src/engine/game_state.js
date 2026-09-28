// Авторитетное состояние партии. Порт scripts/core/game_state.gd.
//
// Ключевое отличие от GDScript-версии: внутри состояние хранится как
// массивы id фишек, а не как объекты Tile. Фишки неизменяемы и лежат
// в общем каталоге, поэтому снапшот/откат/сериализация получаются
// тривиальными, а по сети передаются только id.
//
// ЧТОБЫ НЕ РАСХОДИТЬСЯ С GDScript: любые правки правил повторять в обоих
// местах и проверять тестом tests/test_conformance.gd.

const Rules = require('./rules');
const catalog = require('./catalog');
const { Deck } = require('./deck');

const DEAL_SIZE = 14;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;

function sortedIds(ids) {
  // тот же порядок, что у Tile.sort_tiles: не-джокеры по цвету затем
  // по значению, джокеры в конце
  const arr = ids.slice();
  arr.sort((a, b) => {
    const ta = catalog.BY_ID.get(a);
    const tb = catalog.BY_ID.get(b);
    if (ta.is_joker !== tb.is_joker) return ta.is_joker ? 1 : -1;
    if (ta.color !== tb.color) return ta.color - tb.color;
    return ta.value - tb.value;
  });
  return arr;
}

/**
 * Порядок фишек внутри ряда, в котором сервер их и будет хранить.
 *
 * Клиент присылает тот стол, который у него на экране, и человек в этот
 * момент вправе перетряхнуть набор как угодно. Порядок внутри НАБОРА
 * правилам не противоречит (checkSet порядок не смотрит вовсе), а ряд —
 * это по сути кольцо: тот же 10, 11, 12 можно показать и с 11, и с 12.
 * Раньше сервер сохранял порядок как есть, и переставленный ряд падал в
 * endTurn с «числа идут не по порядку» — то есть за обычное шевеление
 * фишками игрока ругали.
 *
 * Поэтому порядок приводится к каноническому: сначала пробуем ровно то,
 * что прислал клиент (тогда нормальная игра не меняется ни на йоту),
 * затем повороты присланного порядка, затем возрастание с джокерами в
 * каждой из щелей. Если годного порядка нет — оставляем присланный, и
 * тогда разберётся endTurn и скажет почему.
 *
 * Обратимо: validateRow — чистая функция, а наборы и так принимаются в
 * любом порядке, так что первая же проба проходит для них всегда.
 */
function canonicalOrder(ids) {
  const valid = (arr) => Rules.validateRow(arr.map((id) => catalog.BY_ID.get(id))).ok;
  if (valid(ids)) return ids;

  const n = ids.length;
  for (let k = 1; k < n; k += 1) {
    const rot = ids.slice(k).concat(ids.slice(0, k));
    if (valid(rot)) return rot;
  }

  const tiles = ids.map((id) => catalog.BY_ID.get(id));
  const plain = tiles.filter((t) => !t.is_joker).sort((a, b) => a.value - b.value);
  const jokers = tiles.filter((t) => t.is_joker);
  if (plain.length > 0) {
    // Джокер в ряду закрывает одно число, поэтому годных мест столько,
    // сколько промежутков между обычными числами плюс два края.
    for (let at = 0; at <= plain.length; at += 1) {
      const cand = plain.slice(0, at).concat(jokers, plain.slice(at)).map((t) => t.id);
      if (valid(cand)) return cand;
    }
  }
  return ids;
}

class GameState {
  constructor() {
    this.players = []; // {seat, name, handIds, connected, dropped}
    this.table = []; // {id, tileIds}
    this.deck = null;
    this.current = 0;
    this.require30 = true;
    this.firstTurn = true;
    this.finished = false;
    this.winner = -1;
    this.turnPlacedIds = [];
    this.lastTurnTileIds = [];
    this.nextRowId = 1;
    this._tx = null;
  }

  // ------------------------------------------------------------ создание

  static create(numPlayers, names, require30, rng) {
    const st = new GameState();
    st.require30 = !!require30;
    const n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, numPlayers | 0));
    for (let i = 0; i < n; i += 1) {
      let pname = `Игрок ${i + 1}`;
      if (i < names.length && String(names[i]).trim() !== '') {
        pname = String(names[i]).trim();
      }
      st.players.push({
        seat: i,
        name: pname.slice(0, 24),
        handIds: [],
        connected: false,
        dropped: false,
      });
    }
    st.deck = new Deck(rng);
    for (const p of st.players) {
      for (let i = 0; i < DEAL_SIZE; i += 1) {
        const t = st.deck.draw();
        if (t === null) break;
        p.handIds.push(t);
      }
      p.handIds = sortedIds(p.handIds);
    }
    return st;
  }

  // ------------------------------------------------------------ доступ

  playerCount() { return this.players.length; }

  playerName(i) { return this.players[i] ? this.players[i].name : ''; }

  currentPlayer() { return this.players[this.current]; }

  /**
   * Рука текущего игрока. Возвращаем КОПИЮ: авторитетное состояние не должно
   * меняться из чужой руки. Иначе `for (id of game.hand()) place(id)` молча
   * пропускает фишки — цикл идёт по массиву, который вырезает на ходу.
   */
  hand() {
    return this.currentPlayer() ? this.currentPlayer().handIds.slice() : [];
  }

  handSize(i) { return this.players[i] ? this.players[i].handIds.length : 0; }

  tilesLeftInDeck() { return this.deck ? this.deck.count() : 0; }

  // ------------------------------------------------------------ права хода

  canTouchRow() { return !this.finished; }

  canPlaceInto() { return !this.finished; }

  canTakeBack(tileId) { return !this.finished && this.turnPlacedIds.indexOf(tileId) !== -1; }

  canDraw() {
    return !this.finished
      && this.turnPlacedIds.length === 0
      && this.tilesLeftInDeck() > 0
      && this.tableStatus().ok;
  }

  canSkip() {
    return !this.finished
      && this.turnPlacedIds.length === 0
      && this.tilesLeftInDeck() === 0
      && this.tableStatus().ok;
  }

  // ------------------------------------------------------------ стол

  addRow() {
    const row = { id: this.nextRowId, tileIds: [] };
    this.nextRowId += 1;
    this.table.push(row);
    return row;
  }

  removeRow(row) {
    const i = this.table.indexOf(row);
    if (i !== -1) this.table.splice(i, 1);
  }

  rowById(rowId) {
    for (const r of this.table) if (r.id === rowId) return r;
    return null;
  }

  // ------------------------------------------------------------ ходы

  placeFromHand(tileId, rowId, index) {
    if (this.finished) return false;
    const row = this.rowById(rowId);
    if (row === null) return null;
    // Именно живой массив, а не hand(): копию править бесполезно.
    const hand = this.currentPlayer() ? this.currentPlayer().handIds : null;
    if (hand === null) return false;
    const at = hand.indexOf(tileId);
    if (at === -1) return false;
    hand.splice(at, 1);
    const pos = Math.max(0, Math.min(index, row.tileIds.length));
    row.tileIds.splice(pos, 0, tileId);
    this.turnPlacedIds.push(tileId);
    return true;
  }

  moveTile(srcRowId, tileId, dstRowId, dstIndex) {
    if (this.finished) return false;
    const src = this.rowById(srcRowId);
    const dst = this.rowById(dstRowId);
    if (src === null || dst === null) return false;
    const old = src.tileIds.indexOf(tileId);
    if (old === -1) return false;
    if (src === dst) {
      src.tileIds.splice(old, 1);
      let target = dstIndex;
      if (old < target) target -= 1;
      target = Math.max(0, Math.min(target, src.tileIds.length));
      src.tileIds.splice(target, 0, tileId);
      return true;
    }
    src.tileIds.splice(old, 1);
    const pos = Math.max(0, Math.min(dstIndex, dst.tileIds.length));
    dst.tileIds.splice(pos, 0, tileId);
    if (src.tileIds.length === 0) this.removeRow(src);
    return true;
  }

  takeBackToHand(rowId, tileId) {
    if (this.finished) return false;
    const row = this.rowById(rowId);
    if (row === null) return false;
    const idx = row.tileIds.indexOf(tileId);
    if (idx === -1) return false;
    if (!this.canTakeBack(tileId)) return false;
    row.tileIds.splice(idx, 1);
    const at = this.turnPlacedIds.indexOf(tileId);
    if (at !== -1) this.turnPlacedIds.splice(at, 1);
    this.currentPlayer().handIds = sortedIds(this.currentPlayer().handIds.concat([tileId]));
    if (row.tileIds.length === 0) this.removeRow(row);
    return true;
  }

  /**
   * Полная перестановка стола одним куском: rows = [{id, tiles:[tileId,...]}],
   * где id > 0 — существующий ряд, id = 0 — новый.
   *
   * Клиенту не нужно уметь вычислять последовательность place/move: он
   * отправляет тот стол, который получился у него на экране, а сервер
   * пересобирает его у себя. Обманывать тут нечем — сервер всё равно
   * проверяет и состав фишек, и правила (этим занимается endTurn).
   *
   * Что сервер проверяет жёстко:
   *   - каждая присланная фишка либо уже лежала на столе, либо была в руке
   *     игрока на НАЧАЛЕ этого хода; выдумать фишку нельзя;
   *   - одна фишка не может оказаться в двух местах;
   *   - всё, что лежало на столе ДО этого хода, обязано там и остаться.
   *     Забрать назад можно только то, что игрок выложил сам в этом ходу,
   *     а «выложил сам» сервер знает точно: такой фишки не было ни на столе,
   *     ни в его руке в начале хода.
   *
   * setTable всегда идёт первой (и единственной) операцией хода, поэтому
   * рука и стол в этот момент ещё исходные.
   */
  setTable(rows) {
    if (this.finished) return false;
    if (!Array.isArray(rows)) return false;
    const hand = this.currentPlayer() ? this.currentPlayer().handIds : null;
    if (hand === null) return false;
    const handStart = new Set(hand);
    const tableStart = new Set();
    for (const r of this.table) for (const id of r.tileIds) tableStart.add(id);

    const out = [];
    const seen = new Set();
    const usedRows = new Set();
    for (const spec of rows) {
      if (!spec || typeof spec !== 'object') return false;
      const tiles = spec.tiles;
      if (!Array.isArray(tiles)) return false;
      if (tiles.length === 0) continue; // пустой ряд просто исчезает
      const rowId = spec.id | 0;
      if (rowId < 0) return false;
      if (rowId > 0) {
        if (usedRows.has(rowId) || this.rowById(rowId) === null) return false;
        usedRows.add(rowId);
      }
      const ids = [];
      for (const raw of tiles) {
        const id = raw | 0;
        if (!catalog.BY_ID.has(id)) return false;
        if (seen.has(id)) return false;
        if (!tableStart.has(id) && !handStart.has(id)) return false;
        seen.add(id);
        ids.push(id);
      }
      out.push({ id: rowId, tileIds: ids });
    }
    for (const id of tableStart) {
      if (seen.has(id)) continue;
      // Исчезнуть сможет только фишка, выложенная самим игроком в этом ходу.
      if (handStart.has(id)) continue;
      return false;
    }

    const rebuilt = [];
    for (const spec of out) {
      let row = spec.id > 0 ? this.rowById(spec.id) : null;
      if (row === null) row = this.addRow();
      row.tileIds = canonicalOrder(spec.tileIds);
      rebuilt.push(row);
    }
    // Порядок рядов на экране задаёт клиент — он же им и пользуется.
    this.table = rebuilt;

    // Ход игрока — это ровно те фишки, которые ушли из его руки на стол.
    const placed = [];
    for (const spec of out) for (const id of spec.tileIds) if (handStart.has(id)) placed.push(id);
    this.turnPlacedIds = placed;

    const keep = hand.filter((id) => !seen.has(id));
    for (const id of tableStart) if (!seen.has(id)) keep.push(id);
    hand.length = 0;
    for (const id of keep) hand.push(id);
    return true;
  }

  drawFromDeck() {
    if (this.finished) return { ok: false, reason: 'Игра окончена' };
    if (this.turnPlacedIds.length !== 0) {
      return { ok: false, reason: 'Нельзя брать из колоды после выкладки' };
    }
    if (this.tilesLeftInDeck() === 0) return { ok: false, reason: 'Колода пуста' };
    const status = this.tableStatus();
    if (!status.ok) {
      return { ok: false, reason: 'Сначала закончите перестановку на столе' };
    }
    const tileId = this.deck.draw();
    if (tileId === null) return { ok: false, reason: 'Колода пуста' };
    this.currentPlayer().handIds = sortedIds(this.currentPlayer().handIds.concat([tileId]));
    this.advance();
    return { ok: true, reason: '', tile: tileId };
  }

  skipTurn() {
    if (this.finished) return { ok: false, reason: 'Игра окончена' };
    if (this.tilesLeftInDeck() > 0) {
      return { ok: false, reason: 'Колода ещё полна — возьмите число' };
    }
    if (this.turnPlacedIds.length !== 0) {
      return { ok: false, reason: 'Воспользуйтесь кнопкой «Продолжить»' };
    }
    const status = this.tableStatus();
    if (!status.ok) {
      return { ok: false, reason: 'Сначала закончите перестановку на столе' };
    }
    this.advance();
    return { ok: true, reason: '' };
  }

  endTurn() {
    if (this.finished) return { ok: false, reason: 'Игра окончена' };
    if (this.turnPlacedIds.length === 0) {
      return { ok: false, reason: 'Выложите хотя бы одно число или возьмите из колоды' };
    }
    const status = this.tableStatus();
    if (!status.ok) {
      return {
        ok: false,
        reason: status.errors.length > 0 ? String(status.errors[0].reason) : 'Стол в невалидном состоянии',
        errors: status.errors,
      };
    }
    if (this.require30 && this.firstTurn) {
      const pts = this.openingPoints();
      if (pts < Rules.OPENING_POINTS) {
        return {
          ok: false,
          reason: `Самый первый ход игры — минимум ${Rules.OPENING_POINTS} очков (у вас ${pts})`,
          errors: [],
        };
      }
    }
    this.firstTurn = false;
    this.removeEmptyRows();
    if (this.currentPlayer().handIds.length === 0) {
      this.winner = this.current;
      this.finished = true;
      return { ok: true, reason: '', errors: [], win: true };
    }
    this.advance();
    return { ok: true, reason: '', errors: [], win: false };
  }

  // ------------------------------------------------------------ валидация

  tableStatus() {
    const errors = [];
    for (let i = 0; i < this.table.length; i += 1) {
      const row = this.table[i];
      if (row.tileIds.length === 0) continue;
      const result = Rules.validateRow(catalog.tiles(row.tileIds));
      if (!result.ok) errors.push({ row: i, reason: result.reason });
    }
    return { ok: errors.length === 0, errors };
  }

  openingPoints() {
    let total = 0;
    for (const id of this.turnPlacedIds) {
      let handled = false;
      for (const row of this.table) {
        const idx = row.tileIds.indexOf(id);
        if (idx === -1) continue;
        const result = Rules.validateRow(catalog.tiles(row.tileIds));
        const t = catalog.BY_ID.get(id);
        if (t.is_joker && result.ok) {
          total += Number(result.joker_values[id] ?? 0);
        } else {
          total += t.value;
        }
        handled = true;
        break;
      }
      if (handled) continue;
    }
    return total;
  }

  // ------------------------------------------------------------ смена хода

  advance() {
    this.lastTurnTileIds = this.turnPlacedIds.slice();
    this.turnPlacedIds = [];
    this.firstTurn = false;
    const next = this.nextActiveSeat(this.current);
    if (next === -1) {
      this.finished = true;
      return;
    }
    this.current = next;
  }

  // Ищем следующего не-выбывшего. Выбыть можно только по обрыву связи,
  // поэтому если остались двое — партия продолжается без выбывшего.
  nextActiveSeat(from) {
    const n = this.players.length;
    for (let step = 1; step <= n; step += 1) {
      const seat = (from + step) % n;
      if (!this.players[seat].dropped) return seat;
    }
    return -1;
  }

  removeEmptyRows() {
    this.table = this.table.filter((r) => r.tileIds.length > 0);
  }

  // ------------------------------------------------------------ применение ops

  /**
   * ops: [{op:"place", tile, to, index}, {op:"move", tile, from, to, index}]
   *  - to/from: "r<id>" — существующий ряд, "n<k>" — новый ряд (k в пределах хода)
   * или один ops: [{op:"set_table", rows:[{id, tiles:[...]}]}]
   *
   * Проверки прав здесь нет намеренно: placeFromHand ищет фишку в РУКЕ
   * текущего игрока, moveTile — в исходном ряду, setTable — в руке и на
   * столе. Подделать чужую фишку нельзя ни одним из способов.
   */
  applyOps(ops) {
    if (this.finished) return false;
    // set_table пересобирает стол целиком, мешать его с place/move
    // бессмысленно: клиент, приславший и то и другое, не знает, чего
    // он хочет. Отказываем сразу, а не разбираем чужую ошибку.
    if (ops.length === 1 && String(ops[0].op || '') === 'set_table') {
      return this.setTable(ops[0].rows);
    }
    const created = new Map();
    for (const op of ops) {
      const kind = String(op.op || '');
      if (kind === 'place') {
        const row = this.resolveRef(String(op.to || ''), created);
        if (row === null) return false;
        if (this.placeFromHand(op.tile | 0, row.id, op.index | 0) !== true) return false;
      } else if (kind === 'move') {
        const src = this.resolveRef(String(op.from || ''), created);
        const dst = this.resolveRef(String(op.to || ''), created);
        if (src === null || dst === null) return false;
        if (this.moveTile(src.id, op.tile | 0, dst.id, op.index | 0) !== true) return false;
      } else {
        return false;
      }
    }
    return true;
  }

  resolveRef(ref, created) {
    if (ref.charAt(0) === 'n') {
      if (!created.has(ref)) {
        created.set(ref, this.addRow().id);
      }
      return this.rowById(created.get(ref));
    }
    if (ref.charAt(0) === 'r') {
      return this.rowById(parseInt(ref.slice(1), 10));
    }
    return null;
  }

  // ------------------------------------------------------------ транзакции

  captureAll() {
    return {
      table: this.table.map((r) => ({ id: r.id, tileIds: r.tileIds.slice() })),
      hands: this.players.map((p) => p.handIds.slice()),
      dropped: this.players.map((p) => p.dropped),
      deckIds: this.deck ? this.deck.ids.slice() : [],
      current: this.current,
      require30: this.require30,
      firstTurn: this.firstTurn,
      finished: this.finished,
      winner: this.winner,
      turnPlacedIds: this.turnPlacedIds.slice(),
      lastTurnTileIds: this.lastTurnTileIds.slice(),
      nextRowId: this.nextRowId,
    };
  }

  restoreAll(s) {
    this.table = s.table.map((r) => ({ id: r.id, tileIds: r.tileIds.slice() }));
    for (let i = 0; i < this.players.length; i += 1) {
      this.players[i].handIds = (s.hands[i] || []).slice();
      this.players[i].dropped = !!s.dropped[i];
    }
    if (this.deck) this.deck.ids = s.deckIds.slice();
    this.current = s.current;
    this.require30 = s.require30;
    this.firstTurn = s.firstTurn;
    this.finished = s.finished;
    this.winner = s.winner;
    this.turnPlacedIds = s.turnPlacedIds.slice();
    this.lastTurnTileIds = s.lastTurnTileIds.slice();
    this.nextRowId = s.nextRowId;
  }

  // Правильный приём: applyOps может упасть на середине и оставить стол
  // в мусорном состоянии, поэтому откат обязателен.
  beginTurn() {
    this._tx = this.captureAll();
  }

  rollback() {
    if (this._tx) {
      this.restoreAll(this._tx);
      this._tx = null;
    }
  }

  commit() {
    this._tx = null;
  }

  // ------------------------------------------------------------ выбывание

  /** Игрок окончательно выбыл (не вернулся за 90 секунд). */
  dropPlayer(seat) {
    const p = this.players[seat];
    if (!p || p.dropped) return false;
    p.dropped = true;
    p.connected = false;
    if (this.finished) return true;
    if (this.current === seat) {
      // он не успел завершить ход — откатываем его черновик
      this.turnPlacedIds = [];
      const next = this.nextActiveSeat(seat);
      if (next === -1) this.finished = true;
      else this.current = next;
    }
    return true;
  }
}

module.exports = { GameState, DEAL_SIZE, MIN_PLAYERS, MAX_PLAYERS, sortedIds };
