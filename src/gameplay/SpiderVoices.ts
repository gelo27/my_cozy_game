import { audioEngine } from '../audio/AudioEngine';

/*
 * The cave spiders' voices. Each sound is rendered ONCE into an AudioBuffer (a few variants per
 * kind, the first time it is needed) and then only played back: one buffer source and one panner
 * per voice, no oscillator / filter graphs per call, and a cap on how many play at once.
 *
 * The sounds are built from layers, as creature designers build big bugs (see the note below).
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
  // Hash the seed first: neighbouring small seeds would otherwise start out almost alike
  let s = (Math.imul(seed ^ 0x5bd1e995, 0x9e3779b1) ^ (seed << 16)) >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  for (let i = 0; i < 4; i++) next();
  return next;
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

/*
 * Big-bug voices are not voices: there is no throat, so no clear pitch and no vowel (a pitched,
 * formant-shaped call sounds like a crow's caw). They are built from layers instead.
 *
 * The scream follows the giant-spider recipe of big fantasy films: a high, wet squealing screech
 * (the classic source is a squeezed rubber toy full of liquid: squeaks breaking up into bubbles),
 * with almost no low end, under a long, rough, alligator-like hiss. Clicks of the mandibles start it.
 */

/** Sample range [from, to) of a layer that starts at `t0` and lasts `dur`, clipped to the buffer. */
function span(d: Float32Array, sr: number, t0: number, dur: number): [number, number] {
  const o = Math.max(0, Math.floor(t0 * sr));
  return [o, Math.min(d.length, o + Math.floor(dur * sr))];
}

/**
 * Wet squeal: a squeezed, liquid-filled rubber squeak. A narrow, slightly distorted tone whose pitch
 * jitters fast and jumps as the squeeze catches and slips, choked now and then by the liquid.
 */
function wetSqueal(
  d: Float32Array, sr: number, r: () => number,
  o: { t0: number; dur: number; f: (t: number) => number; env: (t: number) => number; gain: number }
): void {
  const [i0, i1] = span(d, sr, o.t0, o.dur);
  const n = i1 - i0;
  const fast = wander(r, 38, sr), slow = wander(r, 7, sr);
  const hp = new Biquad(sr).set('hp', 700, 0.7);
  let ph = 0, jump = 1, nextJump = 0, choke = 1, chokeTarget = 1, nextChoke = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // The squeeze catches and slips: the pitch hops by a few semitones every 30-90 ms
    if (i >= nextJump) {
      nextJump = i + Math.floor(sr * (0.03 + r() * 0.06));
      jump = Math.pow(2, ((r() - 0.5) * 5) / 12);
    }
    // Liquid in the way: the squeal gutters and comes back
    if (i >= nextChoke) {
      nextChoke = i + Math.floor(sr * (0.02 + r() * 0.05));
      chokeTarget = r() < 0.25 ? 0.15 + r() * 0.3 : 0.8 + r() * 0.2;
    }
    choke += (chokeTarget - choke) * 0.004;
    const f = o.f(t) * jump * (1 + fast() * 0.06 + slow() * 0.05);
    ph += f / sr;
    // A pinched rubbery tone: a sine pushed into distortion (odd overtones), edged with noise
    const x = Math.tanh(Math.sin(2 * Math.PI * ph) * 2.6) + (r() * 2 - 1) * 0.18;
    d[i0 + i] += hp.run(x) * choke * o.env(t) * o.gain;
  }
}

/** Bubbles: tiny rising "blups" of liquid, `density` a second (the wetness of the screech). */
function gurgle(d: Float32Array, sr: number, r: () => number, t0: number, dur: number, density: number, env: (t: number) => number, gain: number): void {
  const [i0, i1] = span(d, sr, t0, dur);
  let i = i0;
  while (i < i1) {
    i += Math.floor((sr / density) * (0.2 + r() * 1.6));
    if (i >= i1) break;
    const f0 = 500 + r() * 1300, rise = 0.3 + r() * 0.6, tau = 0.006 + r() * 0.014;
    const len = Math.min(d.length - i, Math.floor(tau * 5 * sr));
    const g = gain * (0.4 + r() * 0.6) * env((i - i0) / (i1 - i0));
    let ph = 0;
    for (let k = 0; k < len; k++) {
      const tt = k / sr;
      ph += (f0 * (1 + rise * (1 - Math.exp(-tt / tau)))) / sr;
      d[i + k] += Math.sin(2 * Math.PI * ph) * Math.exp(-tt / tau) * g;
    }
  }
}

/**
 * Hiss: air forced out. `bright` 1 is the thin spiracle hiss; lower is the throatier hiss of a big
 * reptile. `flutter` (Hz) shakes it like an alligator's rough exhale.
 */
function hiss(d: Float32Array, sr: number, r: () => number, t0: number, dur: number, env: (t: number) => number, gain: number, bright = 1, flutter = 0): void {
  const [i0, i1] = span(d, sr, t0, dur);
  const n = i1 - i0;
  const hp = new Biquad(sr).set('hp', 1400 * bright, 0.7);
  const bp = new Biquad(sr).set('bp', 4600 * bright, 0.9);
  const rough = wander(r, 70, sr), flJit = wander(r, 5, sr);
  let fl = 0;
  for (let i = 0; i < n; i++) {
    const x = r() * 2 - 1;
    const v = hp.run(x) * 0.6 + bp.run(x) * 0.9;
    let a = 0.8 + rough() * 0.25;
    if (flutter > 0) {
      fl += (flutter * (1 + flJit() * 0.3)) / sr;
      a *= 0.6 + 0.4 * Math.abs(Math.sin(Math.PI * fl));
    }
    d[i0 + i] += v * a * env(i / n) * gain;
  }
}

/** Creaking rattle: dark noise chopped into uneven ticks 25-45 times a second (a low, dry growl). */
function rattle(d: Float32Array, sr: number, r: () => number, t0: number, dur: number, rate: number, env: (t: number) => number, gain: number): void {
  const [i0, i1] = span(d, sr, t0, dur);
  const n = i1 - i0;
  const lp = new Biquad(sr).set('lp', 750, 0.9);
  const hp = new Biquad(sr).set('hp', 110, 0.7);
  const body = new Biquad(sr).set('bp', 300 + r() * 120, 3);
  const jit = wander(r, 12, sr);
  let ph = 0, tick = 0;
  for (let i = 0; i < n; i++) {
    ph += (rate * (1 + jit() * 0.35)) / sr;
    if (ph >= 1) {
      ph -= 1;
      tick = 0.5 + r() * 0.5;
    }
    tick *= 0.9965;
    const x = hp.run(lp.run(r() * 2 - 1));
    d[i0 + i] += (x + body.run(x) * 1.5) * tick * env(i / n) * gain * 2.5;
  }
}

/** A burst of mandible clicks (chittering) between `t0` and `t0 + dur`. */
function chitter(d: Float32Array, sr: number, r: () => number, t0: number, dur: number, gap: number, gain: number): void {
  const base = 2400 + r() * 2000;
  for (let t = t0; t < t0 + dur; t += gap * (0.55 + r() * 0.9)) addClick(d, sr, t, r, base * (0.8 + r() * 0.4), gain * (0.6 + r() * 0.4));
}

const attackRelease = (a: number, relFrom: number, curve = 1.4) => (t: number) =>
  Math.min(1, t / a) * (t < relFrom ? 1 : Math.max(0, 1 - (t - relFrom) / (1 - relFrom)) ** curve);

/**
 * Spotting the player: the mandibles click, a high wet squealing screech breaks out of a long,
 * rough reptile hiss that outlasts it.
 */
function renderScream(sr: number, seed: number): Float32Array {
  const r = rng(seed * 7 + 1);
  const dur = 1.3 + r() * 0.4;
  const d = new Float32Array(Math.floor(dur * sr));
  const peakAt = 0.12 + r() * 0.1;
  const lo = 1500 + r() * 300, top = 2700 + r() * 700, end = 1700 + r() * 300;
  const sq = dur * (0.55 + r() * 0.15);
  chitter(d, sr, r, 0, 0.1, 0.015, 0.8);
  wetSqueal(d, sr, r, {
    t0: 0.06,
    dur: sq,
    f: (t) => (t < peakAt ? lo + (top - lo) * (t / peakAt) : top - (top - end) * Math.pow((t - peakAt) / (1 - peakAt), 0.8)),
    env: attackRelease(0.04, 0.6, 1.3),
    gain: 0.75,
  });
  gurgle(d, sr, r, 0.08, sq + 0.15, 55, attackRelease(0.1, 0.5), 0.35);
  // The hiss swells under the squeal and carries on after it, fading slowly
  hiss(d, sr, r, 0.03, dur - 0.03, (t) => Math.min(1, t / 0.12) * (t < 0.45 ? 0.75 + t : Math.max(0, 1 - (t - 0.45) / 0.55) ** 1.3 * 1.2), 0.75, 0.42, 21 + r() * 6);
  finish(d, sr, 0.42, 0.3);
  return d;
}

/** Lunging / biting: a fang snap, a hard hiss and a short wet squeal. */
function renderAttack(sr: number, seed: number): Float32Array {
  const r = rng(seed * 13 + 3);
  const dur = 0.45 + r() * 0.15;
  const d = new Float32Array(Math.floor(dur * sr));
  const top = 2800 + r() * 700;
  wetSqueal(d, sr, r, { t0: 0.015, dur: dur * 0.55, f: (t) => top - 700 * t, env: attackRelease(0.01, 0.4, 1.2), gain: 0.65 });
  gurgle(d, sr, r, 0.02, dur * 0.6, 70, attackRelease(0.02, 0.4), 0.3);
  hiss(d, sr, r, 0, dur, attackRelease(0.008, 0.2, 1.5), 1, 0.5, 26);
  // A hard transient at the snap of the fangs
  const n = Math.floor(sr * 0.012);
  const bp = new Biquad(sr).set('bp', 3600, 2);
  for (let i = 0; i < n; i++) d[i] += bp.run(r() * 2 - 1) * Math.exp(-i / (n * 0.25)) * 1.5;
  finish(d, sr, 0.45, 0.25);
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
  // A slow hiss and a faint creak under it
  hiss(d, sr, r, 0, dur, (x) => Math.sin(Math.PI * x) ** 2, 0.1, 0.8);
  rattle(d, sr, r, dur * 0.2, dur * 0.6, 26, (x) => Math.sin(Math.PI * x) ** 2, 0.25);
  gurgle(d, sr, r, dur * 0.3, dur * 0.4, 8, (x) => Math.sin(Math.PI * x), 0.12);
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
