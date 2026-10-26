import { describe, expect, it } from 'vitest';
import { CATALOG, TOTAL_TILES, tileById, tryTileById } from '../src/core/deck';

describe('catalog', () => {
  it('содержит 106 фишек', () => {
    expect(TOTAL_TILES).toBe(106);
    expect(CATALOG).toHaveLength(106);
  });

  it('соответствует серверным правилам id', () => {
    expect(tileById(1)).toMatchObject({ color: 0, value: 1, is_joker: false });
    expect(tileById(27)).toMatchObject({ color: 1, value: 1, is_joker: false });
    expect(tileById(105)).toMatchObject({ color: 4, is_joker: true });
    expect(tileById(106)).toMatchObject({ color: 5, is_joker: true });
  });

  it('по 2 копии каждого числа каждого цвета', () => {
    const counts = new Map<string, number>();
    for (const t of CATALOG) {
      if (t.is_joker) continue;
      const key = `${t.color}:${t.value}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(52);
    for (const n of counts.values()) expect(n).toBe(2);
  });

  it('неизвестный id даёт null из tryTileById', () => {
    expect(tryTileById(107)).toBeNull();
    expect(tryTileById(0)).toBeNull();
  });
});
