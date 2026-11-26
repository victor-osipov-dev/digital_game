import { describe, expect, it } from 'vitest';
import {
  FlightSpec,
  FlightTiming,
  flightsConflict,
  planFlights,
} from '../src/ui2/flight_plan';

const TS = 56;
const SLOT = TS + 2;

function rect(x: number, y: number): { x: number; y: number; w: number; h: number } {
  return { x, y, w: TS, h: TS };
}

function assertNoConflicts(specs: FlightSpec[], timings: FlightTiming[]): void {
  for (let i = 0; i < specs.length; i += 1) {
    for (let j = i + 1; j < specs.length; j += 1) {
      expect(
        flightsConflict(specs[i], timings[i], specs[j], timings[j]),
        `flights ${i} and ${j} overlap`,
      ).toBe(false);
    }
  }
}

describe('flight_plan', () => {
  it('не считает соседние слоты наложением', () => {
    const a: FlightSpec = { from: rect(0, 0), to: rect(SLOT, 0) };
    const b: FlightSpec = { from: rect(SLOT, 0), to: rect(SLOT * 2, 0) };
    const timings = planFlights([a, b], { duration: 300 });
    expect(timings).toEqual([
      { delay: 0, duration: 300, bend: 0 },
      { delay: 0, duration: 300, bend: 0 },
    ]);
    assertNoConflicts([a, b], timings);
  });

  it('обмен местами разводит встречные траектории', () => {
    const a: FlightSpec = { from: rect(0, 0), to: rect(SLOT, 0) };
    const b: FlightSpec = { from: rect(SLOT, 0), to: rect(0, 0) };
    // Без планирования призраки проходят через одну точку.
    expect(flightsConflict(a, { delay: 0, duration: 300, bend: 0 }, b, {
      delay: 0, duration: 300, bend: 0,
    })).toBe(true);
    const timings = planFlights([a, b], { duration: 300 });
    assertNoConflicts([a, b], timings);
    // Либо дуга, либо второй стартует после первого — но не одновременно
    // в одной точке.
    expect(timings[1].delay > 0 || Math.abs(timings[1].bend) > 0).toBe(true);
  });

  it('конвейер новых фишек не накладывает их друг на друга', () => {
    const y = 400;
    const specs: FlightSpec[] = [0, 1, 2].map((i) => ({
      from: rect(20, 40),
      to: rect(40 + i * SLOT, y),
    }));
    const timings = planFlights(specs, { duration: 340, gap: 150 });
    assertNoConflicts(specs, timings);
    for (let i = 1; i < timings.length; i += 1) {
      // Каждый следующий стартует не раньше предыдущего + базовый зазор.
      expect(timings[i].delay - timings[i - 1].delay).toBeGreaterThanOrEqual(150);
    }
    // Последняя фишка не ждёт предыдущую до полного приземления.
    expect(timings[2].delay).toBeLessThan(340);
  });

  it('обгон в одну сторону тоже разводится', () => {
    // Первая едет через два слота и обгоняет соседку, которая сдвигается
    // всего на один слот.
    const a: FlightSpec = { from: rect(0, 0), to: rect(SLOT * 3, 0) };
    const b: FlightSpec = { from: rect(SLOT, 0), to: rect(SLOT * 2, 0) };
    expect(flightsConflict(a, { delay: 0, duration: 300, bend: 0 }, b, {
      delay: 0, duration: 300, bend: 0,
    })).toBe(true);
    const timings = planFlights([a, b], { duration: 300 });
    assertNoConflicts([a, b], timings);
  });

  it('полная перестановка ряда планируется без наложений', () => {
    // Перестановка мест: каждая фишка едет в чужой слот, часть — встречно.
    const order = [3, 0, 5, 1, 6, 2, 7, 4];
    const specs: FlightSpec[] = order.map((dst, src) => ({
      from: rect(src * SLOT, 0),
      to: rect(dst * SLOT, 0),
    }));
    const timings = planFlights(specs, { duration: 300, maxBend: TS * 2 });
    assertNoConflicts(specs, timings);
    expect(timings.every((t) => t.delay < 2000)).toBe(true);
  });

  it('детерминирован: одинаковый вход — одинаковый план', () => {
    const specs: FlightSpec[] = [
      { from: rect(0, 0), to: rect(SLOT * 2, 0) },
      { from: rect(SLOT, 0), to: rect(0, 0) },
      { from: rect(SLOT * 2, 0), to: rect(SLOT, 0) },
    ];
    const first = planFlights(specs, { duration: 280 });
    const second = planFlights(specs, { duration: 280 });
    expect(first).toEqual(second);
    assertNoConflicts(specs, first);
  });
});
