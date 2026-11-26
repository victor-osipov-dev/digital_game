// Планировщик полёта фишек.
//
// Анимация сетевого хода приходит одним пакетом: сервер присылает только
// конечный стол, а клиент дорисовывает перелёты. Если запустить все
// перелёты одновременно, встречные фишки (обмен местами, перенос из ряда в
// ряд, догоняющие друг друга сдвиги) проходят через одну и ту же точку —
// одна карточка полностью закрывает другую, и кажется, что фишки «встали
// друг в друга».
//
// Здесь перелёты планируются заранее: для каждого считается дуга и задержка
// так, чтобы в любой момент времени два летящих призрака не пересекались.
// Логика чистая (без Babylon/DOM), поэтому покрыта юнит-тестами.

export interface FlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlightSpec {
  from: FlightRect;
  to: FlightRect;
  /** Своя длительность перелёта (иначе — общая из опций). */
  duration?: number;
}

export interface FlightTiming {
  /** Задержка старта от начала этапа, мс. */
  delay: number;
  /** Длительность перелёта, мс. */
  duration: number;
  /** Боковое отклонение середины траектории, px (0 — прямая). */
  bend: number;
}

export interface FlightPlanOptions {
  /** Длительность перелёта по умолчанию, мс. */
  duration: number;
  /** Базовая задержка между стартами (конвейер), мс. */
  gap?: number;
  /** Максимальное отклонение дуги, px. */
  maxBend?: number;
}

// Сколько раз проверяем траектории на пересечение.
const SAMPLES = 40;
// Центры ближе 0.9 размера фишки — это уже наложение. Соседние слоты
// (центры на 1 размер + зазор) наложением не считаются.
const OVERLAP = 0.9;
// Шаг, на который откладываем конфликтующий перелёт.
const DELAY_STEP_MS = 40;
// Страховка от бесконечного цикла: 40 шагов = 1.6 с.
const MAX_ATTEMPTS = 40;

function center(rect: FlightRect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

// Горизонтальные перелёты изгибаем вверх/вниз, вертикальные — влево/вправо:
// так встречные потоки расходятся в стороны, а не наезжают друг на друга.
function bendNormal(spec: FlightSpec): { x: number; y: number } {
  const a = center(spec.from);
  const b = center(spec.to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: 0, y: 1 };
  return { x: 1, y: 0 };
}

function travelSign(spec: FlightSpec): number {
  const a = center(spec.from);
  const b = center(spec.to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx === 0 ? 0 : Math.sign(dx);
  return dy === 0 ? 0 : Math.sign(dy);
}

/**
 * Положение центра призрака в момент `at` (мс от начала этапа).
 * `null` — призрак ещё не стартовал или уже приземлился (его там нет).
 */
export function flightPoint(
  spec: FlightSpec,
  timing: FlightTiming,
  at: number,
): { x: number; y: number } | null {
  if (at < timing.delay || at > timing.delay + timing.duration) return null;
  const raw = timing.duration > 0 ? (at - timing.delay) / timing.duration : 1;
  const p = Math.min(1, Math.max(0, raw));
  // Та же кривая, что и в playTileFlight: 1 - (1 - p)^3.
  const eased = 1 - (1 - p) ** 3;
  const a = center(spec.from);
  const b = center(spec.to);
  const n = bendNormal(spec);
  // Дуга-синусоида: в начале и конце полёта отклонение нулевое, а середина
  // траектории быстро уходит вбок. Прямая (bend=0) остаётся прямой.
  const wave = Math.sin(Math.PI * eased) * timing.bend;
  return {
    x: a.x + (b.x - a.x) * eased + n.x * wave,
    y: a.y + (b.y - a.y) * eased + n.y * wave,
  };
}

/** Пересекаются ли два призрака в какой-либо момент времени. */
export function flightsConflict(
  aSpec: FlightSpec,
  aTiming: FlightTiming,
  bSpec: FlightSpec,
  bTiming: FlightTiming,
): boolean {
  const end = Math.max(aTiming.delay + aTiming.duration, bTiming.delay + bTiming.duration);
  if (end <= 0) return false;
  const step = end / SAMPLES;
  const limitX = ((aSpec.to.w + bSpec.to.w) / 2) * OVERLAP;
  const limitY = ((aSpec.to.h + bSpec.to.h) / 2) * OVERLAP;
  for (let i = 0; i < SAMPLES; i += 1) {
    // Берём середины интервалов: в самом начале полёта призраки ещё стоят
    // в точке старта, и это не считается наложением.
    const at = (i + 0.5) * step;
    const pa = flightPoint(aSpec, aTiming, at);
    const pb = flightPoint(bSpec, bTiming, at);
    if (!pa || !pb) continue;
    if (Math.abs(pa.x - pb.x) < limitX && Math.abs(pa.y - pb.y) < limitY) return true;
  }
  return false;
}

/**
 * Раскладывает перелёты на этап.
 *
 * - `gap = 0` — перелёты стартуют вместе (перестановка уже лежащих фишек);
 * - `gap > 0` — конвейер (новые фишки вылетают по очереди).
 *
 * Конфликтующие траектории сначала разводим дугой (встречные — в разные
 * стороны), а если это не помогло — откладываем старт. Поэтому призраки
 * никогда не оказываются в одной точке, но группа остаётся динамичной:
 * без конфликтов все летят одновременно.
 */
export function planFlights(
  specs: FlightSpec[],
  options: FlightPlanOptions,
): FlightTiming[] {
  const baseDuration = Math.max(1, options.duration);
  const gap = Math.max(0, options.gap ?? 0);
  const timings: FlightTiming[] = [];
  let lastStart = 0;

  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    const duration = Math.max(1, spec.duration ?? baseDuration);
    const maxBend = Math.max(1, options.maxBend ?? Math.max(spec.to.h, spec.from.h) * 2);
    const sign = travelSign(spec) || 1;
    const timing: FlightTiming = {
      delay: i === 0 ? 0 : Math.max(0, lastStart + gap),
      duration,
      bend: 0,
    };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let conflict = false;
      for (let j = 0; j < i; j += 1) {
        if (flightsConflict(spec, timing, specs[j], timings[j])) {
          conflict = true;
          break;
        }
      }
      if (!conflict) break;
      if (attempt === 0) timing.bend = sign * maxBend;
      else if (attempt === 1) timing.bend = -timing.bend;
      else {
        // Дуги не хватило — откладываем старт и убираем дугу, чтобы
        // запоздавшая фишка летела уже по прямой.
        timing.bend = 0;
        timing.delay += DELAY_STEP_MS;
      }
    }
    timings.push(timing);
    lastStart = timing.delay;
  }

  return timings;
}
