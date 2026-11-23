// Генератор аудио-ассетов игры (public/audio/*.mp3).
// Чистый JS: синтез звука + кодирование в mp3 через @breezystack/lamejs.
// Запуск: node tools/gen-audio.mjs (после изменения звукового дизайна).
import { Mp3Encoder } from '@breezystack/lamejs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'audio');
mkdirSync(outDir, { recursive: true });

const SR = 44100;

// Float32 [-1..1] -> Int16
function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

function encodeMp3(f32, kbps) {
  const enc = new Mp3Encoder(1, SR, kbps);
  const pcm = toInt16(f32);
  const parts = [];
  const block = 1152 * 8;
  for (let i = 0; i < pcm.length; i += block) {
    const chunk = enc.encodeBuffer(pcm.subarray(i, i + block));
    if (chunk.length > 0) parts.push(Buffer.from(chunk));
  }
  const tail = enc.flush();
  if (tail.length > 0) parts.push(Buffer.from(tail));
  return Buffer.concat(parts);
}

// Тоновый сигнал с огибающей (attack/decay) в буфер.
function tone(buf, startSec, durSec, freq, vol, opts = {}) {
  const { attack = 0.005, release = durSec * 0.6, kind = 'sine', glide = 1 } = opts;
  const n0 = Math.floor(startSec * SR);
  const n = Math.min(Math.floor(durSec * SR), buf.length - n0);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = freq * (1 + (glide - 1) * (t / durSec));
    const phase = 2 * Math.PI * f * t;
    let s;
    if (kind === 'triangle') {
      s = 2 / Math.PI * Math.asin(Math.sin(phase));
    } else if (kind === 'square') {
      s = Math.sin(phase) >= 0 ? 0.6 : -0.6;
    } else {
      s = Math.sin(phase);
    }
    // Огибающая: быстрая атака, экспоненциальный спад.
    const a = Math.min(1, t / Math.max(attack, 0.001));
    const d = Math.exp(-t / Math.max(release, 0.02));
    buf[n0 + i] += s * vol * a * d;
  }
}

// Короткий шумовой щелчок (транзиент).
function noise(buf, startSec, durSec, vol, decay = 0.03) {
  const n0 = Math.floor(startSec * SR);
  const n = Math.min(Math.floor(durSec * SR), buf.length - n0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    // Простое сглаживание шума — мягкий «клик» без жёстких скачков.
    const r = Math.random() * 2 - 1;
    last = last * 0.5 + r * 0.5;
    buf[n0 + i] += last * vol * Math.exp(-(i / SR) / decay);
  }
}

function normalize(buf, peak = 0.9) {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  if (max === 0) return buf;
  const g = peak / max;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

const A4 = 440;
const note = (semi) => A4 * Math.pow(2, semi / 12); // полутоны от A4

// --- click: мягкий тик ~50 мс ---
{
  const buf = new Float32Array(Math.floor(0.08 * SR));
  tone(buf, 0, 0.05, 1900, 0.5, { release: 0.012 });
  noise(buf, 0, 0.02, 0.25, 0.006);
  writeFileSync(join(outDir, 'click.mp3'), encodeMp3(normalize(buf, 0.7), 96));
}

// --- place: деревянный «тук» ~120 мс ---
{
  const buf = new Float32Array(Math.floor(0.18 * SR));
  tone(buf, 0, 0.12, 210, 0.8, { release: 0.045, glide: 0.72 });
  tone(buf, 0, 0.05, 620, 0.25, { release: 0.02 });
  noise(buf, 0, 0.03, 0.3, 0.008);
  writeFileSync(join(outDir, 'place.mp3'), encodeMp3(normalize(buf, 0.8), 96));
}

// --- win: восходящее арпеджио ~0.9 с ---
{
  const buf = new Float32Array(Math.floor(1.1 * SR));
  // A4, C#5, E5, A5
  const seq = [0, 4, 7, 12];
  seq.forEach((semi, i) => {
    tone(buf, i * 0.13, 0.5, note(semi), 0.5, { kind: 'triangle', release: 0.22 });
  });
  tone(buf, 0.52, 0.55, note(12), 0.4, { release: 0.3 });
  writeFileSync(join(outDir, 'win.mp3'), encodeMp3(normalize(buf, 0.85), 96));
}

// --- lose: нисходящий мотив ~0.8 с ---
{
  const buf = new Float32Array(Math.floor(1.0 * SR));
  // E4, C4, A3
  const seq = [-7, -12, -19];
  seq.forEach((semi, i) => {
    tone(buf, i * 0.22, 0.45, note(semi), 0.5, { kind: 'triangle', release: 0.25 });
  });
  writeFileSync(join(outDir, 'lose.mp3'), encodeMp3(normalize(buf, 0.8), 96));
}

// --- music: 32-секундная амбиентная петля ---
// Периодичность: все частоты кратны 1/L — петля сшивается без щелчка.
{
  const L = 32;
  const buf = new Float32Array(Math.floor(L * SR));
  // Пентатоника ля-минор, мягкая арпеджио-подложка.
  const scale = [-12, -5, 0, 3, 5, 7, 10, 12]; // полутоны от A4
  const freqFor = (f) => Math.round(f * L) / L; // кратность периоду петли
  const tones = [];
  for (let k = 0; k < 8; k++) {
    const semi = scale[k % scale.length] - 12 * Math.floor(k / scale.length);
    tones.push(freqFor(note(semi) / 2)); // октавой ниже — спокойнее
  }
  // Арпеджио: каждые 2 с — новая нота с долгой атакой/релизом.
  for (let step = 0; step < 16; step++) {
    const f = tones[step % tones.length];
    const start = (step * L) / 16;
    const dur = L / 8; // ноты перекрываются
    tone(buf, start, dur, f, 0.16, {
      attack: 0.8,
      release: 1.6,
      kind: 'triangle',
    });
    // Терпкий «бас»-слой раз в такт.
    if (step % 4 === 0) {
      tone(buf, start, dur, f / 4, 0.12, { attack: 0.5, release: 1.2 });
    }
  }
  // Медленная «дыхательная» подложка: два тона с биениями.
  tone(buf, 0, L, freqFor(110), 0.05, { attack: 4, release: 6 });
  tone(buf, 0, L, freqFor(110 * 1.5), 0.03, { attack: 6, release: 8 });
  normalize(buf, 0.55);
  // Идеальная петля: хвост (последние 2 с) подмешивается в начало.
  const fadeN = Math.floor(2 * SR);
  for (let i = 0; i < fadeN; i++) {
    const w = i / fadeN;
    buf[i] += buf[buf.length - fadeN + i] * w;
  }
  const loop = buf.subarray(0, buf.length - fadeN);
  writeFileSync(join(outDir, 'music.mp3'), encodeMp3(loop, 64));
}

for (const f of ['click', 'place', 'win', 'lose', 'music']) {
  const p = join(outDir, `${f}.mp3`);
  const size = (await import('node:fs')).statSync(p).size;
  console.log(`${f}.mp3: ${(size / 1024).toFixed(1)} KB`);
}
console.log('OK');
