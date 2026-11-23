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

// Ассеты Playgama: фоновая музыка и эффекты из public/audio/*.mp3.
// Если файлов нет (другие сборки), эффекты играют синтезированными тонами.
const MP3_FILES: Partial<Record<SoundKind, string>> = {
  click: 'audio/click.mp3',
  place: 'audio/place.mp3',
  win: 'audio/win.mp3',
  lose: 'audio/lose.mp3',
};
const MUSIC_FILE = 'audio/music.mp3';
const MUSIC_VOLUME = 0.32;

let userEnabled = true;
let sdkEnabled = true;
let adMuted = false;
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let musicGain: GainNode | null = null;
let musicSource: AudioBufferSourceNode | null = null;
let musicBuffer: AudioBuffer | null = null;
const sfxBuffers = new Map<SoundKind, AudioBuffer>();
let assetsLoading = false;

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
    musicGain = ctx.createGain();
    musicGain.gain.value = 0;
    musicGain.connect(master);
  } catch {
    ctx = null;
    master = null;
  }
  return ctx;
}

async function loadBuffer(url: string): Promise<AudioBuffer | null> {
  const c = ensureContext();
  if (!c) return null;
  try {
    const res = await fetch(new URL(url, document.baseURI));
    if (!res.ok) return null;
    return await c.decodeAudioData(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Ленивая загрузка mp3: только после первого жеста игрока. */
async function loadAssets(): Promise<void> {
  if (assetsLoading || !ensureContext()) return;
  assetsLoading = true;
  const kinds = Object.keys(MP3_FILES) as SoundKind[];
  const buffers = await Promise.all([
    loadBuffer(MUSIC_FILE),
    ...kinds.map((kind) => loadBuffer(MP3_FILES[kind]!)),
  ]);
  musicBuffer = buffers[0];
  kinds.forEach((kind, i) => {
    const buffer = buffers[i + 1];
    if (buffer) sfxBuffers.set(kind, buffer);
  });
  assetsLoading = false;
  applyMusic();
}

/** Фоновая музыка играет только при audible() и когда ассеты загружены. */
function applyMusic(): void {
  const c = ctx;
  if (!c || !musicGain || !musicBuffer) return;
  try {
    if (!audible()) {
      if (musicSource) {
        musicSource.loop = false;
        try { musicSource.stop(); } catch { /* уже остановлен */ }
        musicSource = null;
      }
      musicGain.gain.setTargetAtTime(0, c.currentTime, 0.08);
      return;
    }
    if (!musicSource) {
      const src = c.createBufferSource();
      src.buffer = musicBuffer;
      src.loop = true;
      src.connect(musicGain);
      src.onended = () => {
        if (musicSource === src) musicSource = null;
      };
      src.start();
      musicSource = src;
    }
    musicGain.gain.setTargetAtTime(MUSIC_VOLUME, c.currentTime, 0.4);
  } catch {
    /* музыка не критична */
  }
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
  applyMusic();
}

export function isSoundEnabled(): boolean {
  return userEnabled;
}

/** Разрешение звука со стороны SDK площадки (muteAudio и аналоги). */
export function setSdkAudioEnabled(enabled: boolean): void {
  sdkEnabled = enabled;
  if (!enabled) stopAll();
  applyMusic();
}

/** Глушение на время показа рекламы. */
export function setAdMuted(muted: boolean): void {
  adMuted = muted;
  if (muted) stopAll();
  applyMusic();
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
    if (ctx && musicSource) {
      musicSource.loop = false;
      try { musicSource.stop(); } catch { /* уже остановлен */ }
      musicSource = null;
    }
    if (ctx && musicGain) {
      musicGain.gain.cancelScheduledValues(ctx.currentTime);
      musicGain.gain.setValueAtTime(0, ctx.currentTime);
      musicGain.disconnect();
      musicGain = ctx.createGain();
      musicGain.gain.value = 0;
      if (master) musicGain.connect(master);
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
  // Сначала mp3-ассет, если он уже загружен; синтез — фолбэк.
  const buffer = sfxBuffers.get(kind);
  if (buffer && master) {
    try {
      const src = c.createBufferSource();
      src.buffer = buffer;
      src.connect(master);
      src.start();
      return;
    } catch {
      /* пробуем синтезированный эффект */
    }
  }
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
  void resumeContext();
  void loadAssets();
}

/** Алиас для кода, использовавшего сfx() до объединения аудио-модулей. */
export function sfx(name: SoundKind): void {
  play(name);
}
