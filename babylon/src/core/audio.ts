// Звук игры: короткие синтезированные эффекты через WebAudio.
//
// Ассетов в проекте нет, поэтому все звуки генерируются на лету. Модуль не
// импортирует платформенный слой (иначе получился бы цикл): площадка сообщает
// о своём mute через setSdkAudioEnabled(), а реклама — через setAdMuted().
//
// Итоговое состояние: пользовательская настройка && разрешение SDK && не реклама.
// Так требование «звук выключается при рекламе» и «настройка площадки важнее
// внутриигровой» выполняются в одном месте.

type SoundKind = 'click' | 'place' | 'draw' | 'turn' | 'win' | 'lose';

let userEnabled = true;
let sdkEnabled = true;
let adMuted = false;
let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function audioContextCtor(): typeof AudioContext | null {
  try {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    return w.AudioContext ?? w.webkitAudioContext ?? null;
  } catch {
    return null;
  }
}

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.18;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
    master = null;
  }
  return ctx;
}

function audible(): boolean {
  return userEnabled && sdkEnabled && !adMuted;
}

/** Пользовательская настройка звука (кнопка в меню/настройках). */
export function setSoundEnabled(enabled: boolean): void {
  userEnabled = enabled;
  // AudioContext НЕ создаём здесь: его можно создать только из жеста.
  // Разбудит его play()/unlockAudio() при первом нажатии.
  if (!enabled) stopAll();
}

export function isSoundEnabled(): boolean {
  return userEnabled;
}

/** Разрешение звука со стороны SDK площадки (muteAudio и аналоги). */
export function setSdkAudioEnabled(enabled: boolean): void {
  sdkEnabled = enabled;
  if (!enabled) stopAll();
}

/** Глушение на время показа рекламы. */
export function setAdMuted(muted: boolean): void {
  adMuted = muted;
  if (muted) stopAll();
}

/** Итоговое состояние — учитывает и настройку игрока, и SDK, и рекламу. */
export function isAudible(): boolean {
  return audible();
}

async function resumeContext(): Promise<void> {
  const c = ensureContext();
  if (!c) return;
  try {
    if (c.state === 'suspended') await c.resume();
  } catch {
    /* автоплей заблокирован — оживёт на следующем жесте */
  }
}

function stopAll(): void {
  try {
    // Быстрый способ оборвать уже запланированные ноты: пересоздаём мастер.
    if (ctx && master) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(0, ctx.currentTime);
      master.disconnect();
      master = ctx.createGain();
      master.gain.value = 0.18;
      master.connect(ctx.destination);
    }
  } catch {
    /* ignore */
  }
}

function tone(
  freq: number,
  delay: number,
  duration: number,
  type: OscillatorType = 'sine',
  volume = 1,
): void {
  const c = ensureContext();
  if (!c || !master) return;
  try {
    const start = c.currentTime + Math.max(0, delay);
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    // Плавная атака/затухание без щелчков.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  } catch {
    /* звук не критичен для игры */
  }
}

/** Проиграть короткий эффект. Безопасно вызывать когда угодно. */
export function play(kind: SoundKind): void {
  if (!audible()) return;
  const c = ensureContext();
  if (!c) return;
  if (c.state === 'suspended') void resumeContext();
  switch (kind) {
    case 'click':
      tone(720, 0, 0.05, 'triangle', 0.5);
      break;
    case 'place':
      tone(440, 0, 0.07, 'triangle', 0.7);
      tone(660, 0.06, 0.1, 'triangle', 0.6);
      break;
    case 'draw':
      tone(320, 0, 0.08, 'sine', 0.6);
      tone(380, 0.07, 0.09, 'sine', 0.5);
      break;
    case 'turn':
      tone(880, 0, 0.09, 'sine', 0.5);
      break;
    case 'win':
      tone(523, 0, 0.14, 'triangle', 0.7);
      tone(659, 0.12, 0.14, 'triangle', 0.7);
      tone(784, 0.24, 0.18, 'triangle', 0.7);
      tone(1046, 0.38, 0.26, 'triangle', 0.6);
      break;
    case 'lose':
      tone(392, 0, 0.16, 'sine', 0.6);
      tone(294, 0.14, 0.22, 'sine', 0.5);
      tone(196, 0.3, 0.3, 'sine', 0.45);
      break;
  }
}

/** Разбудить AudioContext из пользовательского жеста (первый тап). */
export function unlockAudio(): void {
  if (!audible()) return;
  void resumeContext();
}
