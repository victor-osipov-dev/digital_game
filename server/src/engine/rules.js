// Порядок чисел на игровом столе и их цветовые семейства.
// Это 1-в-1 порт scripts/core/rules.gd — менять поведение здесь нельзя,
// иначе разойдётся conformance-тест против GDScript.

// Цвета: RED=0, BLUE=1, BLACK=2, ORANGE=3 (совпадает с Tile.TColor)
const RED = 0;
const BLUE = 1;
const BLACK = 2;
const ORANGE = 3;

const MIN_TILES = 3;
const MAX_SET = 4;
const MIN_VALUE = 1;
const MAX_VALUE = 13;
const OPENING_POINTS = 30;

function fail(reason) {
  return { ok: false, reason: reason, kind: '', joker_values: {} };
}

function ok(kind, jokerValues) {
  return { ok: true, reason: '', kind: kind, joker_values: jokerValues };
}

/**
 * @param {Array<{id:number,color:number,value:number,is_joker:boolean}>} tiles
 */
function validateRow(tiles) {
  if (tiles.length < MIN_TILES) {
    return fail('в ряду должно быть минимум 3 числа');
  }
  const asSet = checkSet(tiles);
  if (asSet.ok) return asSet;
  const asRun = checkRun(tiles);
  if (asRun.ok) return asRun;
  let reason = asRun.reason;
  if (reason === '') reason = asSet.reason;
  if (reason === '') {
    reason = 'не серия одного цвета по порядку и не набор одного значения разных цветов';
  }
  return fail(reason);
}

function checkSet(tiles) {
  const values = [];
  const colors = new Set();
  let jokerCount = 0;
  for (const t of tiles) {
    if (t.is_joker) {
      jokerCount += 1;
    } else {
      values.push(t.value);
      colors.add(t.color);
    }
  }
  let firstValue = -1;
  if (values.length > 0) {
    firstValue = values[0];
    for (const v of values) {
      if (v !== firstValue) return fail('');
    }
    if (colors.size !== values.length) {
      return fail('в наборе не может быть двух чисел одного цвета');
    }
  }
  if (tiles.length > MAX_SET) {
    return fail('набор не может быть длиннее 4 чисел (уникальные цвета)');
  }
  if (colors.size + jokerCount > MAX_SET) {
    return fail('в наборе не может быть двух чисел одного цвета');
  }
  const jokerValues = {};
  for (const t of tiles) {
    if (t.is_joker) {
      jokerValues[t.id] = firstValue >= MIN_VALUE ? firstValue : MIN_VALUE;
    }
  }
  return ok('set', jokerValues);
}

function checkRun(tiles) {
  let runColor = -1;
  for (const t of tiles) {
    if (t.is_joker) continue;
    if (runColor === -1) runColor = t.color;
    else if (t.color !== runColor) return fail('серия должна быть одного цвета');
  }

  const jokerValues = {};
  const n = tiles.length;
  let idx = 0;
  let lead = 0;
  while (idx < n && tiles[idx].is_joker) {
    lead += 1;
    idx += 1;
  }

  // ряд целиком из джокеров
  if (idx >= n) {
    if (n > MAX_VALUE) return fail('серия не может быть длиннее 13 чисел');
    for (let i = 0; i < n; i += 1) jokerValues[tiles[i].id] = i + 1;
    return ok('run', jokerValues);
  }

  const firstVal = tiles[idx].value;
  if (firstVal - lead < MIN_VALUE) {
    return fail('серия выходит за пределы чисел 1..13');
  }
  for (let i = 0; i < lead; i += 1) {
    jokerValues[tiles[idx - lead + i].id] = firstVal - lead + i;
  }

  let prev = firstVal;
  idx += 1;

  while (idx < n) {
    const t = tiles[idx];
    if (t.is_joker) {
      let k = 0;
      const start = idx;
      while (idx < n && tiles[idx].is_joker) {
        k += 1;
        idx += 1;
      }
      if (idx >= n) {
        // джокеры в хвосте
        if (prev + k > MAX_VALUE) {
          return fail('серия выходит за пределы чисел 1..13');
        }
        for (let i = 0; i < k; i += 1) jokerValues[tiles[start + i].id] = prev + 1 + i;
        prev += k;
      } else {
        // джокеры в середине: между prev и nxt
        const nxt = tiles[idx].value;
        if (nxt !== prev + k + 1) {
          return fail(`в серии не хватает числа ${prev + k + 1} (стоит ${nxt})`);
        }
        for (let i = 0; i < k; i += 1) jokerValues[tiles[start + i].id] = prev + 1 + i;
        prev = nxt;
        idx += 1;
      }
    } else {
      if (t.value !== prev + 1) {
        return fail(`числа идут не по порядку: после ${prev} нужно ${prev + 1}`);
      }
      prev = t.value;
      idx += 1;
    }
  }
  return ok('run', jokerValues);
}

function rowPoints(tiles) {
  const result = validateRow(tiles);
  const jv = result.joker_values;
  let total = 0;
  for (const t of tiles) {
    if (t.is_joker) total += Number(jv[t.id] ?? 0);
    else total += t.value;
  }
  return total;
}

module.exports = {
  RED, BLUE, BLACK, ORANGE,
  MIN_TILES, MAX_SET, MIN_VALUE, MAX_VALUE, OPENING_POINTS,
  validateRow, rowPoints, rulesText,
};

// Текст правил — источник истины для клиента остаётся rules.gd.
// Эта копия нужна серверу, чтобы отдавать справку без рассинхрона.
function rulesText() {
  return [
    '[b]Цель[/b]',
    'Первый игрок, оставшийся без чисел в руке, побеждает.',
    '',
    '[b]Колода[/b]',
    '108 чисел: 4 цвета (красный, синий, чёрный, оранжевый), значения 1–13,',
    'по 2 экземпляра каждого + 4 джокера (по одному на цвет).',
    'Джокер заменяет любое число любого цвета.',
    '',
    '[b]Ход[/b]',
    'Каждый ход — ровно одно действие: выложить хотя бы одно число из руки',
    'ИЛИ взять одно случайное число из колоды.',
    'В течение хода стол можно свободно перестраивать, а кнопка',
    '«Отменить ход» возвращает стол и руку к началу текущего хода.',
    '',
    '[b]Ряды[/b]',
    'Серия: 3 и более числа одного цвета по порядку (например 5, 6, 7).',
    'Набор: 3 или 4 числа одного значения разных цветов (например 7 красная, 7 синяя, 7 чёрная).',
    'Перестраивать можно любые ряды на столе, включая выложенные другими игроками:',
    'разбивать их, переносить числа между рядами и возвращать в руку.',
    'На поле можно временно разбивать ряды (в том числе на 1 число),',
    'но к концу хода каждый ряд обязан содержать минимум 3 числа и быть валидным.',
    '',
    '[b]Первый ход[/b]',
    'Самый первый ход игры (первый игрок) должен быть не меньше 30 очков (сумма чисел),',
    'если правило включено в настройках.',
    'Всем остальным игрокам выкладываться можно с любого числа очков.',
    '',
    '[b]Колода пуста[/b]',
    'Брать неоткуда — остаётся только выкладка. Если выложить нечем — ход пропускается.',
  ].join('\n');
}
