// Каталог всех 108 фишек. Порядок выдачи id повторяет scripts/core/deck.gd,
// чтобы клиент и сервер одинаково понимали «число с id = 37».
// Ничего не перемешиваем: перемешивание — забота колоды.

const RULES = require('./rules');

const VALUES = 13;
const COPIES = 2;
const JOKERS = RULES.RED >= 0 ? 4 : 4; // Tile.COLOR_COUNT
const TOTAL = 4 * VALUES * COPIES + JOKERS; // 108

/** @type {Array<{id:number,color:number,value:number,is_joker:boolean}>} */
const CATALOG = [];
/** @type {Map<number, {id:number,color:number,value:number,is_joker:boolean}>} */
const BY_ID = new Map();

(function build() {
  let nextId = 1;
  for (let c = 0; c < 4; c += 1) {
    for (let v = 1; v <= VALUES; v += 1) {
      for (let copy = 0; copy < COPIES; copy += 1) {
        const t = { id: nextId, color: c, value: v, is_joker: false };
        CATALOG.push(t);
        BY_ID.set(nextId, t);
        nextId += 1;
      }
    }
  }
  for (let c = 0; c < 4; c += 1) {
    const t = { id: nextId, color: c, value: 1, is_joker: true };
    CATALOG.push(t);
    BY_ID.set(nextId, t);
    nextId += 1;
  }
})();

function tile(id) {
  return BY_ID.get(id);
}

function tiles(ids) {
  return ids.map((id) => BY_ID.get(id));
}

module.exports = { VALUES, COPIES, JOKERS, TOTAL, CATALOG, BY_ID, tile, tiles };
