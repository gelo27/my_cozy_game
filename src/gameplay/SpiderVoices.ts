import { audioEngine } from '../audio/AudioEngine';

/*
 * The cave spiders' voices. Each sound is rendered ONCE into an AudioBuffer (a few variants per
 * kind, the first time it is needed) and then only played back: one buffer source and one panner
 * per voice, no oscillator / filter graphs per call, and a cap on how many play at once.
 *
 * To keep them from sounding like a synthesizer, they are built the way animal calls are: a
 * pulsed source with jitter and shimmer (the pitch and the loudness of each pulse wander a little,
 * every other pulse is weaker: a rough, creaky voice), mixed with breath noise, shaped by gliding
 * formant resonances, rasped by an irregular stridulation, and given the early reflections of a
 * rocky room.
 */

export type SpiderVoice = 'scream' | 'attack' | 'idle' | 'step';

const VARIANTS: Record<SpiderVoice, number> = { scream: 3, attack: 3, idle: 4, step: 6 };
/**
 * The voices are rendered at this rate (the context resamples on playback): nothing in them needs
 * more than ~10 kHz, and it halves the one-off rendering cost.
 */
const RENDER_RATE = 24000;
/** Voices of one kind sounding at once (more are dropped). */
const MAX_PLAYING: Record<SpiderVoice, number> = { scream: 2, attack: 3, idle: 2, step: 5 };

interface Pos { x: number; y: number; z: number }

// ------------------------------------------------------------------ DSP helpers (offline only)

/** Small deterministic random (variants differ, every session sounds the same). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** RBJ biquad, coefficients re-set as often as the caller likes (time-varying formants). */
class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(private readonly sr: number) {}

  set(type: 'bp' | 'lp' | 'hp', f: number, q: number): this {
    const w = (2 * Math.PI * Math.min(f, this.sr * 0.45)) / this.sr;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    let b0: number, b1: number, b2: number;
    if (type === 'bp') {
      b0 = alpha; b1 = 0; b2 = -alpha;
    } else if (type === 'lp') {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0;
    } else {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0;
    }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = (-2 * cw) / a0; this.a2 = (1 - alpha) / a0;
    return this;
  }

  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Slowly wandering random value in -1..1 (jitter that is not white). */
function wander(r: () => number, rate: number, sr: number): () => number {
  let v = 0, target = 0, n = 0;
  const period = Math.max(1, Math.floor(sr / rate));
  return () => {
    if (n-- <= 0) {
      n = period;
      target = r() * 2 - 1;
    }
    v += (target - v) * (4 / period);
    return v;
  };
}

/** Early reflections of a rock chamber, a soft clip, and the peak normalised to `peak`. */
function finish(d: Float32Array, sr: number, peak: number, room = 0.22): void {
  const taps = [[0.011, 0.5], [0.023, 0.34], [0.037, 0.22], [0.053, 0.14], [0.071, 0.08]];
  const src = d.slice();
  for (const [t, g] of taps) {
    const o = Math.floor(t * sr);
    for (let i = o; i < d.length; i++) d[i] += src[i - o] * g * room * 2;
  }
  let max = 1e-6;
  for (let i = 0; i < d.length; i++) {
    d[i] = Math.tanh(d[i] * 1.4);
    max = Math.max(max, Math.abs(d[i]));
  }
  const k = peak / max;
  // Short fades: no clicks at the ends
  const fade = Math.floor(sr * 0.004);
  for (let i = 0; i < d.length; i++) {
    let g = k;
    if (i < fade) g *= i / fade;
    if (i > d.length - fade) g *= (d.length - i) / fade;
    d[i] *= g;
  }
}

interface CallShape {
  dur: number;
  /** Pitch of the pulses (Hz) over 0..1 of the call. */
  f0(t: number): number;
  /** Formant centres (Hz) over the call. */
  formants(t: number): [number, number, number];
  /** Breath noise share 0..1. */
  breath: number;
  /** Stridulation rate (Hz): the rasp. */
  rasp: number;
  /** Loudness envelope over 0..1. */
  env(t: number): number;
  drive: number;
}

/** A pulsed, rasped, formant-shaped call: the scream and the attack snarl. */
function renderCall(sr: number, seed: number, c: CallShape): Float32Array {
  const r = rng(seed);
  const n = Math.floor(c.dur * sr);
  const out = new Float32Array(n);
  const f1 = new Biquad(sr), f2 = new Biquad(sr), f3 = new Biquad(sr);
  const hp = new Biquad(sr).set('hp', 320, 0.7);
  const pitchJit = wander(r, 25, sr);
  const ampJit = wander(r, 40, sr);
  const raspJit = wander(r, 9, sr);
  let phase = 0, pulse = 0, pulseGain = 1, raspPhase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    if ((i & 31) === 0) {
      const [a, b, cc] = c.formants(t);
      f1.set('bp', a, 4.5);
      f2.set('bp', b, 6);
      f3.set('bp', cc, 8);
    }
    // Pulse source with jitter; each new pulse draws its own loudness (shimmer), every other one weaker
    const f = c.f0(t) * (1 + pitchJit() * 0.045);
    phase += f / sr;
    if (phase >= 1) {
      phase -= 1;
      pulse++;
      pulseGain = (pulse & 1 ? 0.55 + r() * 0.25 : 0.9 + r() * 0.2) * (1 + ampJit() * 0.2);
    }
    const g = phase < 0.32 ? Math.sin((Math.PI * phase) / 0.32) ** 2 * pulseGain : 0;
    const noise = r() * 2 - 1;
    // Breath: always a little, more inside each pulse
    const src = g * (1 - c.breath) + noise * c.breath * (0.35 + g * 0.9);
    // Formants in parallel (F1 strongest)
    let v = f1.run(src) * 1.0 + f2.run(src) * 0.75 + f3.run(src) * 0.45;
    // Stridulation: an irregular rasp chopping the sound
    raspPhase += (c.rasp * (1 + raspJit() * 0.3)) / sr;
    const rp = raspPhase % 1;
    v *= 0.55 + 0.45 * (rp < 0.5 ? 1 : Math.exp(-(rp - 0.5) * 12));
    out[i] = hp.run(v) * c.env(t) * c.drive;
  }
  return out;
}

function renderScream(sr: number, seed: number): Float32Array {
  const r = rng(seed * 7 + 1);
  const peakAt = 0.12 + r() * 0.08;
  const top = 360 + r() * 90;
  const d = renderCall(sr, seed, {
    dur: 0.95 + r() * 0.3,
    f0: (t) => (t < peakAt ? 220 + (top - 220) * (t / peakAt) : top - (top - 150) * Math.pow((t - peakAt) / (1 - peakAt), 0.8)),
    formants: (t) => [950 + 500 * Math.sin(Math.PI * Math.min(1, t * 1.6)), 2500 + 600 * (1 - t), 4300 + 300 * Math.sin(t * 9)],
    breath: 0.42,
    rasp: 46 + r() * 16,
    env: (t) => Math.min(1, t / 0.03) * (t < 0.6 ? 1 + 0.15 * Math.sin(t * 70) : Math.max(0, 1 - (t - 0.6) / 0.4) ** 1.4),
    drive: 2.2,
  });
  finish(d, sr, 0.85, 0.3);
  return d;
}

function renderAttack(sr: number, seed: number): Float32Array {
  const r = rng(seed * 13 + 3);
  const top = 480 + r() * 120;
  const d = renderCall(sr, seed + 99, {
    dur: 0.38 + r() * 0.12,
    f0: (t) => (t < 0.25 ? 300 + (top - 300) * (t / 0.25) : top - (top - 230) * ((t - 0.25) / 0.75)),
    formants: (t) => [1300 - 300 * t, 3100 - 500 * t, 4800],
    breath: 0.55,
    rasp: 70 + r() * 20,
    env: (t) => Math.min(1, t / 0.01) * Math.max(0, 1 - t) ** 1.2,
    drive: 3.2,
  });
  // A hard transient at the snap of the fangs
  const n = Math.floor(sr * 0.012);
  const bp = new Biquad(sr).set('bp', 3600, 2);
  for (let i = 0; i < n; i++) d[i] += bp.run(r() * 2 - 1) * Math.exp(-i / (n * 0.25)) * 1.5;
  finish(d, sr, 0.9, 0.25);
  return d;
}

/** One click: a short resonant tick of chitin on chitin (or on rock). */
function addClick(d: Float32Array, sr: number, at: number, r: () => number, freq: number, gain: number): void {
  const bp = new Biquad(sr).set('bp', freq, 9 + r() * 6);
  const lp = new Biquad(sr).set('lp', 900, 0.8);
  const len = Math.floor(sr * (0.006 + r() * 0.006));
  const o = Math.floor(at * sr);
  for (let i = 0; i < len && o + i < d.length; i++) {
    const e = Math.exp(-i / (len * 0.18));
    const x = r() * 2 - 1;
    d[o + i] += (bp.run(x) * 3 + lp.run(x) * 0.25) * e * gain;
  }
}

/** Guarding: dry chittering in a few bursts over a faint breathy hiss. */
function renderIdle(sr: number, seed: number): Float32Array {
  const r = rng(seed * 31 + 5);
  const dur = 1.2 + r() * 0.7;
  const d = new Float32Array(Math.floor(dur * sr));
  const bursts = 2 + Math.floor(r() * 2);
  let t = 0.05;
  for (let b = 0; b < bursts; b++) {
    const clicks = 4 + Math.floor(r() * 7);
    const gap = 0.022 + r() * 0.03;
    const base = 2600 + r() * 2400;
    for (let i = 0; i < clicks && t < dur - 0.05; i++) {
      addClick(d, sr, t, r, base * (0.85 + r() * 0.3), 0.5 + r() * 0.5);
      t += gap * (0.6 + r() * 0.8);
    }
    t += 0.12 + r() * 0.25;
  }
  // A slow breath under it
  const lp = new Biquad(sr).set('lp', 2200, 0.7);
  const hp = new Biquad(sr).set('hp', 500, 0.7);
  for (let i = 0; i < d.length; i++) {
    const x = i / d.length;
    d[i] += hp.run(lp.run(r() * 2 - 1)) * Math.sin(Math.PI * x) ** 2 * 0.12;
  }
  finish(d, sr, 0.5, 0.35);
  return d;
}

function renderStep(sr: number, seed: number): Float32Array {
  const r = rng(seed * 17 + 11);
  const d = new Float32Array(Math.floor(sr * 0.045));
  addClick(d, sr, 0, r, 3200 + r() * 2800, 1);
  // The tip on stone: a tiny low knock
  const lp = new Biquad(sr).set('lp', 450, 1.2);
  for (let i = 0; i < d.length; i++) d[i] += lp.run(r() * 2 - 1) * Math.exp(-i / (sr * 0.006)) * 0.8;
  finish(d, sr, 0.4, 0.15);
  return d;
}

const RENDER: Record<SpiderVoice, (sr: number, seed: number) => Float32Array> = {
  scream: renderScream,
  attack: renderAttack,
  idle: renderIdle,
  step: renderStep,
};

/** One variant rendered to raw samples (the bank uses it; also handy to audition or test). */
export function renderSpiderVoice(kind: SpiderVoice, sampleRate: number, variant: number): Float32Array {
  return RENDER[kind](sampleRate, variant + 1);
}

// ------------------------------------------------------------------ bank & playback

let bankCtx: BaseAudioContext | null = null;
const bank: Record<SpiderVoice, (AudioBuffer | undefined)[]> = { scream: [], attack: [], idle: [], step: [] };
const playing: Record<SpiderVoice, number> = { scream: 0, attack: 0, idle: 0, step: 0 };

/** One variant of `kind`, rendered the first time it is asked for. */
function buffer(ctx: AudioContext, kind: SpiderVoice): AudioBuffer {
  if (bankCtx !== ctx) {
    bankCtx = ctx;
    for (const k of Object.keys(bank) as SpiderVoice[]) bank[k] = [];
  }
  const i = Math.floor(Math.random() * VARIANTS[kind]);
  return bank[kind][i] ?? renderBuffer(ctx, kind, i);
}

function renderBuffer(ctx: BaseAudioContext, kind: SpiderVoice, i: number): AudioBuffer {
  const data = renderSpiderVoice(kind, RENDER_RATE, i);
  const b = ctx.createBuffer(1, data.length, RENDER_RATE);
  b.copyToChannel(data, 0);
  bank[kind][i] = b;
  return b;
}

let warming = false;

/**
 * Renders every variant ahead of need, one per idle moment (a spider is about: the first shriek
 * must not hitch the frame it is heard in).
 */
export function prewarmSpiderVoices(): void {
  const ctx = audioEngine.context;
  if (warming || !ctx) return;
  if (bankCtx !== ctx) {
    bankCtx = ctx;
    for (const k of Object.keys(bank) as SpiderVoice[]) bank[k] = [];
  }
  const todo: [SpiderVoice, number][] = [];
  for (const k of ['scream', 'attack', 'idle', 'step'] as SpiderVoice[]) {
    for (let i = 0; i < VARIANTS[k]; i++) if (!bank[k][i]) todo.push([k, i]);
  }
  if (!todo.length) return;
  warming = true;
  const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const idle = (cb: () => void) => (ric ? ric.call(window, cb, { timeout: 500 }) : setTimeout(cb, 30));
  const next = () => {
    const job = todo.shift();
    if (!job || bankCtx !== ctx) {
      warming = false;
      return;
    }
    if (!bank[job[0]][job[1]]) renderBuffer(ctx, job[0], job[1]);
    idle(next);
  };
  idle(next);
}

/**
 * Plays a spider voice at `pos`. `size` ~ the spider's scale (bigger is lower). Returns false
 * when it was dropped (no audio yet, or too many of that kind already sounding).
 */
export function playSpiderVoice(kind: SpiderVoice, pos: Pos, size = 1, gain = 1): boolean {
  const ctx = audioEngine.context;
  if (!ctx || playing[kind] >= MAX_PLAYING[kind]) return false;
  const ref = kind === 'step' ? 2 : kind === 'idle' ? 3 : 6;
  const panner = audioEngine.createPanner(pos, ref, ref * 10, 'sfx', kind === 'step');
  if (!panner) return false;
  const src = ctx.createBufferSource();
  src.buffer = buffer(ctx, kind);
  src.playbackRate.value = (1.08 / Math.max(0.6, size)) * (0.93 + Math.random() * 0.14);
  let out: AudioNode = panner;
  let g: GainNode | null = null;
  if (gain !== 1) {
    g = ctx.createGain();
    g.gain.value = gain;
    g.connect(panner);
    out = g;
  }
  src.connect(out);
  playing[kind]++;
  src.onended = () => {
    playing[kind]--;
    src.disconnect();
    g?.disconnect();
    panner.disconnect();
  };
  src.start();
  return true;
}
