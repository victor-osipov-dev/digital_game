import { describe, expect, it } from 'vitest';
import { tileById } from '../src/core/deck';
import { rowPoints, validateRow } from '../src/core/rules';
import { faces } from './helpers';

const red1 = 1;
const red1b = 2;
const blue1 = 27;
const black1 = 53;
const orange1 = 79;
const runBlack13 = (v: number) => black1 + 2 * (v - 1);

describe('validateRow: наборы', () => {
  it('наряд разных цветов одного значения — валиден', () => {
    const v = validateRow(faces([red1, blue1, black1]));
    expect(v.ok).toBe(true);
    expect(v.kind).toBe('set');
  });

  it('две фишки одного цвета в наборе — невалидно', () => {
    expect(validateRow(faces([red1, red1b, black1])).ok).toBe(false);
  });

  it('набор из 4 цветов — валиден', () => {
    expect(validateRow(faces([red1, blue1, black1, orange1])).ok).toBe(true);
  });

  it('меньше 3 фишек — невалидно', () => {
    expect(validateRow(faces([red1, blue1])).ok).toBe(false);
  });
});

describe('validateRow: серии', () => {
  it('1 2 3 одного цвета', () => {
    const v = validateRow(faces([runBlack13(1), runBlack13(2), runBlack13(3)]));
    expect(v.ok).toBe(true);
    expect(v.kind).toBe('run');
  });

  it('серия от 1 до 13', () => {
    const ids: number[] = [];
    for (let v = 1; v <= 13; v += 1) ids.push(runBlack13(v));
    expect(validateRow(faces(ids)).ok).toBe(true);
  });

  it('повтор числа в серии — невалиден', () => {
    const ids: number[] = [];
    for (let v = 1; v <= 13; v += 1) ids.push(runBlack13(v));
    expect(validateRow(faces([...ids, black1 + 25])).ok).toBe(false);
  });

  it('смешение цветов в серии — невалидно', () => {
    expect(validateRow(faces([black1, orange1, runBlack13(3)])).ok).toBe(false);
  });

  it('джокер продолжает серию', () => {
    const v = validateRow(faces([runBlack13(1), 105, runBlack13(3)]));
    expect(v.ok).toBe(true);
    expect(v.joker_values[105]).toBe(2);
  });

  it('джокер на старте', () => {
    const v = validateRow(faces([105, runBlack13(2), runBlack13(3)]));
    expect(v.ok).toBe(true);
    expect(v.joker_values[105]).toBe(1);
  });

  it('два джокера в наборе', () => {
    const v = validateRow(faces([red1, 105, 106]));
    expect(v.ok).toBe(true);
  });

  it('джокер не может вывести за 13', () => {
    expect(validateRow(faces([105, 51, 52])).ok).toBe(false);
  });
});

describe('rowPoints', () => {
  it('считает сумму с джокером как замещённое число', () => {
    expect(rowPoints(faces([runBlack13(1), 105, runBlack13(3)]))).toBe(6);
  });
});

describe('порядок блоков каталога', () => {
  it('id 26 — красная 13, id 27 — синяя 1', () => {
    expect(tileById(26)).toMatchObject({ color: 0, value: 13 });
    expect(tileById(27)).toMatchObject({ color: 1, value: 1 });
  });
});
