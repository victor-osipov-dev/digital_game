import { tryTileById, tileById } from './deck';
import { t as tr } from './lang';
import { TileFace } from './tile';

export const MIN_TILES = 3;
export const MAX_SET = 4;
export const MIN_VALUE = 1;
export const MAX_VALUE = 13;
export const OPENING_POINTS = 30;

export interface RowValidation {
  ok: boolean;
  reason: string;
  kind: '' | 'set' | 'run';
  joker_values: Record<number, number>;
}

function fail(reason: string): RowValidation {
  return { ok: false, reason, kind: '', joker_values: {} };
}

function pass(kind: 'set' | 'run', jokerValues: Record<number, number>): RowValidation {
  return { ok: true, reason: '', kind, joker_values: jokerValues };
}

export function validateRow(tiles: TileFace[]): RowValidation {
  if (tiles.length < MIN_TILES) {
    return fail(tr('в ряду должно быть минимум 3 числа'));
  }
  const asSet = checkSet(tiles);
  if (asSet.ok) return asSet;
  const asRun = checkRun(tiles);
  if (asRun.ok) return asRun;
  let reason = asRun.reason;
  if (reason === '') reason = asSet.reason;
  if (reason === '') {
    reason = tr('не серия одного цвета по порядку и не набор одного значения разных цветов');
  }
  return fail(reason);
}

function checkSet(tiles: TileFace[]): RowValidation {
  const values: number[] = [];
  const colors = new Set<number>();
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
      return fail(tr('в наборе не может быть двух чисел одного цвета'));
    }
  }
  if (tiles.length > MAX_SET) {
    return fail(tr('набор не может быть длиннее 4 чисел (уникальные цвета)'));
  }
  if (colors.size + jokerCount > MAX_SET) {
    return fail(tr('в наборе не может быть двух чисел одного цвета'));
  }
  const jokerValues: Record<number, number> = {};
  for (const t of tiles) {
    if (t.is_joker) {
      jokerValues[t.id] = firstValue >= MIN_VALUE ? firstValue : MIN_VALUE;
    }
  }
  return pass('set', jokerValues);
}

function checkRun(tiles: TileFace[]): RowValidation {
  let runColor = -1;
  for (const t of tiles) {
    if (t.is_joker) continue;
    if (runColor === -1) runColor = t.color;
    else if (t.color !== runColor) return fail(tr('серия должна быть одного цвета'));
  }

  const jokerValues: Record<number, number> = {};
  const n = tiles.length;
  let idx = 0;
  let lead = 0;
  while (idx < n && tiles[idx].is_joker) {
    lead += 1;
    idx += 1;
  }

  if (idx >= n) {
    if (n > MAX_VALUE) return fail(tr('серия не может быть длиннее 13 чисел'));
    for (let i = 0; i < n; i += 1) jokerValues[tiles[i].id] = i + 1;
    return pass('run', jokerValues);
  }

  const firstVal = tiles[idx].value;
  if (firstVal - lead < MIN_VALUE) {
    return fail(tr('серия выходит за пределы чисел 1..13'));
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
        if (prev + k > MAX_VALUE) {
          return fail(tr('серия выходит за пределы чисел 1..13'));
        }
        for (let i = 0; i < k; i += 1) jokerValues[tiles[start + i].id] = prev + 1 + i;
        prev += k;
      } else {
        const nxt = tiles[idx].value;
        if (nxt !== prev + k + 1) {
          return fail(tr('в серии не хватает числа %d (стоит %d)', prev + k + 1, nxt));
        }
        for (let i = 0; i < k; i += 1) jokerValues[tiles[start + i].id] = prev + 1 + i;
        prev = nxt;
        idx += 1;
      }
    } else {
      if (t.value !== prev + 1) {
        return fail(tr('числа идут не по порядку: после %d нужно %d', prev, prev + 1));
      }
      prev = t.value;
      idx += 1;
    }
  }
  return pass('run', jokerValues);
}

export function rowPoints(tiles: TileFace[]): number {
  const result = validateRow(tiles);
  let total = 0;
  for (const t of tiles) {
    if (t.is_joker) total += result.joker_values[t.id] ?? 0;
    else total += t.value;
  }
  return total;
}

export function rulesText(): string {
  return [
    tr('[b]Цель[/b]'),
    tr('Первый игрок, оставшийся без чисел в руке, побеждает.'),
    '',
    tr('[b]Колода[/b]'),
    tr('106 чисел: 4 цвета (красный, синий, чёрный, оранжевый), значения 1–13,'),
    tr('по 2 экземпляра каждого + 2 джокера (жёлтый и фиолетовый).'),
    tr('Джокер заменяет любое число любого цвета.'),
    '',
    tr('[b]Ход[/b]'),
    tr('Каждый ход — ровно одно действие: выложить хотя бы одно число из руки'),
    tr('ИЛИ взять одно случайное число из колоды.'),
    tr('В течение хода стол можно свободно перестраивать, а кнопка'),
    tr('«Отменить ход» возвращает стол и руку к началу текущего хода.'),
    '',
    tr('[b]Ряды[/b]'),
    tr('Серия: 3 и более числа одного цвета по порядку (например 5, 6, 7).'),
    tr('Набор: 3 или 4 числа одного значения разных цветов (например 7 красная, 7 синяя, 7 чёрная).'),
    tr('Перестраивать можно любые ряды на столе, включая выложенные другими игроками:'),
    tr('разбивать их, переносить числа между рядами и возвращать в руку.'),
    tr('На поле можно временно разбивать ряды (в том числе на 1 число),'),
    tr('но к концу хода каждый ряд обязан содержать минимум 3 числа и быть валидным.'),
    '',
    tr('[b]Первый ход[/b]'),
    tr('Самый первый ход игры (первый игрок) должен быть не меньше 30 очков (сумма чисел),'),
    tr('если правило включено в настройках.'),
    tr('Всем остальным игрокам выкладываться можно с любого числа очков.'),
    '',
    tr('[b]Колода пуста[/b]'),
    tr('Брать неоткуда — остаётся только выкладка. Если выложить нечем — ход пропускается.'),
  ].join('\n');
}

export const rowByIdTileIds = (ids: number[]): TileFace[] => ids.map((id) => tileById(id));
export const rowTryByIdTileIds = (ids: number[]): TileFace[] => ids.map((id) => tryTileById(id)!).filter(Boolean);
