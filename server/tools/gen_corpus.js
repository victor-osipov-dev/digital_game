// Генерирует tests/fixtures/rules_corpus.json — «контракт» правил.
//
// Контракт — это список раскладов и вердиктов, которые ОДНОВРЕМЕННО верны
// для scripts/core/rules.gd (GDScript) и server/src/engine/rules.js (JS).
// Меняешь правила в одном движке — падает tests/test_conformance.gd.
//
//   node server/tools/gen_corpus.js [seed] [count]
//
// Формат кейса: [ [[color,value,isJoker], ...], [ok, kind, reason, [[id,val],...], points] ]
// Здесь c — 0..3, v — 1..13, j — 0/1. id в ответе — позиция в раскладке
// (0-based), а не реальный id фишки, чтобы кейсы были компактными.

const path = require('path');
const fs = require('fs');
const Rules = require(path.join(__dirname, '..', 'src', 'engine', 'rules'));

const seedArg = Number(process.argv[2] || 20260928);
const countArg = Number(process.argv[3] || 2500);

// mulberry32 — тот же PRNG, что и в tests/test_conformance.gd
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(seedArg);
const ri = (n) => Math.floor(rng() * n);

const C = 4;
const V = 13;

function tileSpec(c, v, j) { return [c, v, j]; }

function isJokerSpec(s) { return s[2] === 1; }

// Материализуем кейс в фишки, где id = позиция в раскладке.
function materialize(spec) {
  return spec.map((s, i) => ({
    id: i, color: s[0], value: s[1], is_joker: isJokerSpec(s),
  }));
}

function verdictOf(spec) {
  const tiles = materialize(spec);
  const res = Rules.validateRow(tiles);
  // Только реально присутствующие значения джокеров. Отсутствие ключа тоже
  // часть контракта (у невалидных рядов joker_values пуст), поэтому сверяется
  // и набор ключей, и их значения — расхождение поймается в любую сторону.
  const jv = [];
  for (const t of tiles) {
    if (!t.is_joker) continue;
    if (Object.prototype.hasOwnProperty.call(res.joker_values, t.id)) {
      jv.push([t.id, Number(res.joker_values[t.id])]);
    }
  }
  return [
    res.ok ? 1 : 0,
    String(res.kind || ''),
    String(res.reason || ''),
    jv,
    Rules.rowPoints(tiles),
  ];
}

// ------------------------------------------------------------ генераторы

const cases = [];
const seen = new Set();

function push(spec) {
  if (spec.length < 1) return;
  const key = JSON.stringify(spec);
  if (seen.has(key)) return;
  seen.add(key);
  cases.push(spec);
}

function run(color, start, len) {
  const out = [];
  for (let i = 0; i < len; i += 1) {
    if (start + i > V) break;
    out.push(tileSpec(color, start + i, 0));
  }
  return out;
}

function setOf(value, colors) {
  return colors.map((c) => tileSpec(c, value, 0));
}

/** Подставить джокеры в указанные позиции, остальные позиции — дырки. */
function withJokers(base, jokerPositions, fillFrom) {
  const out = base.slice();
  const n = Math.max(base.length, Math.max(0, ...jokerPositions.map((p) => p + 1)));
  while (out.length < n) out.push(null);
  for (const p of jokerPositions) out[p] = tileSpec(C, 1, 1);
  return out.filter((s) => s !== null);
}

function insertJokerAt(base, pos) {
  const out = base.slice();
  out.splice(pos, 0, tileSpec(C, 1, 1));
  return out;
}

// --- 1. Явные граничные случаи -----------------------------------------
const EDGE = [
  [], [tileSpec(0, 5, 0)], [tileSpec(0, 5, 0), tileSpec(0, 6, 0)],
  run(0, 1, 3),                                  // минимальная серия с 1
  run(0, 11, 3),                                 // 11,12,13 — упирается в потолок
  run(0, 12, 3),                                 // 12,13,14 -> 14 не существует
  run(0, 10, 4),
  setOf(7, [0, 1, 2]),
  setOf(7, [0, 1, 2, 3]),                         // полный набор из 4
  setOf(7, [0, 1, 2, 3]).concat([tileSpec(0, 7, 0)]), // 5 штук -> отказ
  [tileSpec(0, 1, 0), tileSpec(0, 1, 0), tileSpec(1, 1, 0)], // два числа одного цвета
  run(0, 5, 3).concat([tileSpec(0, 6, 0)]),      // 5,6,7 + 6
  [tileSpec(0, 1, 0), tileSpec(0, 3, 0), tileSpec(0, 5, 0)], // разрыв
  [tileSpec(0, 1, 0), tileSpec(1, 2, 0), tileSpec(2, 3, 0)], // разные цвета
  // джокеры
  [tileSpec(0, 1, 1), tileSpec(0, 1, 1), tileSpec(0, 1, 1)],   // три джокера
  [tileSpec(0, 1, 1), tileSpec(0, 1, 1), tileSpec(0, 1, 1), tileSpec(0, 1, 1)], // 4 джокера
  [tileSpec(0, 1, 1), tileSpec(0, 1, 1), tileSpec(0, 1, 1), tileSpec(0, 1, 1), tileSpec(0, 1, 1)], // 5 джокеров
  [tileSpec(0, 1, 1), tileSpec(0, 2, 0), tileSpec(0, 3, 0)],   // джокер в начале
  [tileSpec(0, 1, 1), tileSpec(0, 2, 0), tileSpec(0, 3, 0), tileSpec(0, 4, 0)], // джокер в начале, длиннее
  [tileSpec(0, 1, 0), tileSpec(0, 2, 1), tileSpec(0, 3, 0)],   // джокер в середине, не хватает 2
  [tileSpec(0, 1, 0), tileSpec(0, 2, 0), tileSpec(0, 3, 1)],   // джокер в хвосте
  [tileSpec(0, 1, 0), tileSpec(0, 2, 0), tileSpec(0, 3, 1), tileSpec(0, 4, 0)], // хвост внутри
  [tileSpec(0, 1, 0), tileSpec(0, 2, 0), tileSpec(0, 3, 0), tileSpec(0, 4, 1), tileSpec(0, 5, 0)],
  [tileSpec(0, 11, 0), tileSpec(0, 12, 0), tileSpec(0, 13, 1)], // хвост вылезает за 13
  [tileSpec(0, 12, 0), tileSpec(0, 13, 0), tileSpec(0, 13, 1)],
  [tileSpec(0, 1, 1), tileSpec(0, 1, 0), tileSpec(0, 2, 0)],   // джокер вылезает за 1
  [tileSpec(0, 2, 0), tileSpec(0, 2, 0), tileSpec(0, 2, 1)],   // два одинаковых + джокер
  [tileSpec(0, 2, 0), tileSpec(1, 2, 0), tileSpec(0, 2, 1)],   // набор с джокером
  [tileSpec(0, 2, 0), tileSpec(1, 2, 0), tileSpec(2, 2, 0), tileSpec(0, 2, 1)], // полный набор + джокер
  [tileSpec(0, 2, 0), tileSpec(1, 2, 0), tileSpec(0, 2, 0), tileSpec(0, 2, 1)], // дубль цвета
  [tileSpec(0, 2, 0), tileSpec(0, 2, 1), tileSpec(0, 2, 1)],
  [tileSpec(0, 2, 0), tileSpec(0, 2, 1), tileSpec(0, 2, 1), tileSpec(0, 2, 1)],
  [tileSpec(0, 1, 0), tileSpec(1, 1, 1), tileSpec(2, 1, 0)],   // набор: два джокера
];
for (const e of EDGE) push(e);

// --- 2. Систематически: серии с джокером в каждой позиции ----------------
for (let c = 0; c < C; c += 1) {
  for (let len = 3; len <= 8; len += 1) {
    for (let start = 1; start + len - 1 <= V; start += 1) {
      const base = run(c, start, len);
      push(base);
      for (let p = 0; p <= base.length; p += 1) {
        push(insertJokerAt(base, p));            // один джокер
        push(insertJokerAt(insertJokerAt(base, p), p)); // два джокера
      }
      // дырка, «слепленная» джокером, и настоящая дырка
      const holed = base.slice();
      holed.splice(1, 1);
      push(holed);
      push(insertJokerAt(holed, 1));
    }
  }
}

// --- 3. Систематически: наборы с джокерами ------------------------------
for (let value = 1; value <= V; value += 1) {
  for (let mask = 0; mask < 16; mask += 1) {
    const colors = [0, 1, 2, 3].filter((c) => (mask & (1 << c)) !== 0);
    if (colors.length < 2) continue;
    const base = setOf(value, colors);
    push(base);
    push(insertJokerAt(base, 0));
    push(insertJokerAt(base, base.length));
    push(insertJokerAt(insertJokerAt(base, 0), 0));
    // дубль цвета внутри набора
    const dup = base.slice();
    dup.push(tileSpec(colors[0], value, 0));
    push(dup);
  }
}

// --- 4. Случайные раскладки --------------------------------------------
const NAMES = countArg;
for (let i = 0; i < NAMES * 4; i += 1) {
  const n = 1 + ri(8);
  const spec = [];
  let sameValue = rng() < 0.4;
  const c0 = ri(C);
  const v0 = 1 + ri(V);
  let cursor = 1 + ri(V);
  for (let k = 0; k < n; k += 1) {
    if (rng() < 0.18) {
      spec.push(tileSpec(ri(C), 1, 1));
      continue;
    }
    if (sameValue) {
      spec.push(tileSpec(ri(C), v0, 0));
    } else if (rng() < 0.75) {
      const c = rng() < 0.85 ? c0 : ri(C);
      if (cursor > V) cursor = 1;
      spec.push(tileSpec(c, cursor, 0));
      cursor += 1 + (rng() < 0.25 ? 1 : 0);
    } else {
      spec.push(tileSpec(ri(C), 1 + ri(V), 0));
    }
  }
  push(spec);
}

// ------------------------------------------------------------ вывод
const out = cases.map((spec) => [spec, verdictOf(spec)]);
const target = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'rules_corpus.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out));

let okCount = 0;
let runCount = 0;
let setCount = 0;
for (const [, v] of out) {
  if (v[0] === 1) {
    okCount += 1;
    if (v[1] === 'run') runCount += 1;
    if (v[1] === 'set') setCount += 1;
  }
}
console.log(`seed=${seedArg}`);
console.log(`cases:      ${out.length}`);
console.log(`valid:      ${okCount}  (run=${runCount}, set=${setCount})`);
console.log(`invalid:    ${out.length - okCount}`);
console.log(`file:       ${target}`);
console.log(`size:       ${(fs.statSync(target).size / 1024).toFixed(1)} KB`);
