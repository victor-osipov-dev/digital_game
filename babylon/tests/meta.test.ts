import { afterEach, describe, expect, it } from 'vitest';
import { hintTilesText, setLang } from '../src/core/lang';
import { rankFor } from '../src/core/meta';

describe('russian plurals in hints', () => {
  afterEach(() => setLang('ru'));

  it('uses число / числа / чисел correctly', () => {
    setLang('ru');
    const cases: Array<[number, string]> = [
      [1, 'Подсказка: выложите 1 число'],
      [2, 'Подсказка: выложите 2 числа'],
      [4, 'Подсказка: выложите 4 числа'],
      [5, 'Подсказка: выложите 5 чисел'],
      [11, 'Подсказка: выложите 11 чисел'],
      [21, 'Подсказка: выложите 21 число'],
      [22, 'Подсказка: выложите 22 числа'],
    ];
    for (const [n, text] of cases) expect(hintTilesText(n)).toBe(text);
  });

  it('uses tiles in English', () => {
    setLang('en');
    expect(hintTilesText(1)).toBe('Hint: lay down 1 tile');
    expect(hintTilesText(4)).toBe('Hint: lay down 4 tiles');
  });
});

describe('ranks', () => {
  it('grows with wins', () => {
    expect(rankFor(0).name).toBe('Новичок');
    expect(rankFor(3).name).toBe('Любитель');
    expect(rankFor(250).isMax).toBe(true);
    expect(rankFor(1).nextAt).toBe(3);
  });
});
