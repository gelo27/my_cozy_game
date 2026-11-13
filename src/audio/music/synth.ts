import type { SynthParams } from './patches';

export type SpaceName = 'room' | 'hall' | 'field' | 'cave';

/**
 * Pure sample synthesis (no Web Audio, no DOM): runs in the music worker, or on the main thread
 * if a worker cannot start. Everything is mono Float32 at a low sample rate.
 */

export interface RenderedSample {
  patch: string;
  sr: number;
  /** Real pitch of the sample (Karplus-Strong and pad loops land slightly off the note). */
  rootFreq: number;
  /** Looping patches: seconds of onset before the loop begins (the loop runs to the end). */
  loopStart: number;
  data: Float32Array;
}

export interface SynthRequest {
  patches: { name: string; synth: SynthParams }[];
  sr: number;
  /** Also render a stereo reverb impulse at this rate (the context's own) for this space. */
  irSr?: number;
  space?: SpaceName;
}

export interface SynthResult {
  samples: RenderedSample[];
  ir: Float32Array[] | null;
  ms: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function normalize(d: Float32Array, peak: number): void {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) {
    const k = peak / m;
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
}

function fadeOut(d: Float32Array, sr: number, sec: number): void {
  const n = Math.min(d.length, Math.floor(sr * sec));
  for (let i = 0; i < n; i++) d[d.length - 1 - i] *= i / n;
}

function lowpass(d: Float32Array, fc: number, sr: number): void {
  const a = Math.exp((-2 * Math.PI * fc) / sr);
  let y = 0;
  for (let i = 0; i < d.length; i++) {
    y = d[i] * (1 - a) + y * a;
    d[i] = y;
  }
}

/** Sum of damped sines (bar / tine / membrane modes) with a short noise transient. */
function modal(sr: number, f: number, p: SynthParams, r: () => number, drum: boolean): Float32Array {
  const n = Math.floor(sr * p.dur);
  const d = new Float32Array(n);
  for (const [ratio, amp, tau0] of p.modes ?? [[1, 1, 1]]) {
    const fr = f * ratio;
    if (fr > sr * 0.45) continue;
    const tau = drum ? tau0 : tau0 * Math.pow(262 / f, 0.35);
    const w = (2 * Math.PI * fr) / sr, cw = Math.cos(w), sw = Math.sin(w), dec = Math.exp(-1 / (tau * sr));
    const len = Math.min(n, Math.floor(tau * 7 * sr)), att = Math.floor(sr * 0.0015);
    const drop = p.drop ?? 0;
    if (drop > 0) {
      // A struck membrane starts sharp and sags to its pitch (the "doom" of a taiko or a tom)
      const kd = Math.exp(-1 / ((p.dropTau ?? 0.05) * sr));
      let ph = 0, e = amp, bend = drop;
      for (let i = 0; i < len; i++) {
        ph += w * (1 + bend);
        bend *= kd;
        d[i] += Math.sin(ph) * e * (i < att ? i / att : 1);
        e *= dec;
      }
      continue;
    }
    let c = 1, s = 0, e = amp;
    for (let i = 0; i < len; i++) {
      const nc = c * cw - s * sw;
      s = s * cw + c * sw;
      c = nc;
      d[i] += s * e * (i < att ? i / att : 1);
      e *= dec;
    }
  }
  // Snare wires / skin rattle: a band of noise with its own decay
  const snap = p.snap ?? 0;
  if (snap > 0) {
    const kd = Math.exp(-1 / ((p.snapTau ?? 0.1) * sr)), a = 1 - (p.snapTone ?? 0.6);
    let lp = 0, lo = 0, e = snap;
    for (let i = 0; i < n; i++) {
      const x = r() * 2 - 1;
      lp += (x - lp) * (1 - a * 0.9);
      lo += (lp - lo) * 0.04;
      d[i] += (lp - lo) * e;
      e *= kd;
    }
  }
  const click = p.click ?? 0;
  const tone = p.clickTone ?? (drum ? 0.35 : 0.6);
  const cl = Math.floor(sr * (drum ? 0.012 : tone < 0.3 ? 0.008 : 0.004));
  let y = 0;
  for (let i = 0; i < cl; i++) {
    y += (r() * 2 - 1 - y) * tone;
    d[i] += y * click * (1 - i / cl);
  }
  normalize(d, 0.9);
  fadeOut(d, sr, Math.min(0.4, p.dur * 0.25));
  return d;
}

/** Karplus-Strong plucked string. Returns the real pitch (the delay line is a whole number of samples). */
function ks(sr: number, f: number, p: SynthParams, r: () => number): { data: Float32Array; rootFreq: number } {
  const n = Math.floor(sr * p.dur);
  const d = new Float32Array(n);
  const N = Math.max(2, Math.round(sr / f - 0.5));
  const buf = new Float32Array(N);
  const soft = 1 - (p.bright ?? 0.5) * 0.8;
  let y = 0, mean = 0;
  for (let i = 0; i < N; i++) {
    y += (r() * 2 - 1 - y) * (1 - soft * 0.9);
    buf[i] = y;
    mean += y;
  }
  mean /= N;
  for (let i = 0; i < N; i++) buf[i] -= mean;
  // Plucking away from the end cancels the harmonics with a node there (rounder, less "chip")
  const P = Math.round((p.pos ?? 0) * N);
  if (P > 0) {
    const src = buf.slice();
    for (let i = 0; i < N; i++) buf[i] = src[i] - src[(i - P + N) % N];
  }
  const realF = sr / (N + 0.5);
  const g = Math.pow(0.001, 1 / (realF * (p.t60 ?? 1.7)));
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const a = buf[idx], b = buf[(idx + 1) % N];
    d[i] = a;
    buf[idx] = g * 0.5 * (a + b);
    idx = (idx + 1) % N;
  }
  lowpass(d, 6000, sr);
  if (p.body) woodBody(d, sr, p.body);
  normalize(d, 0.9);
  fadeOut(d, sr, 0.08);
  return { data: d, rootFreq: realF };
}

/** Two-pole resonator, in place, mixed with the dry signal. */
function resonate(d: Float32Array, sr: number, fc: number, q: number, mix: number): void {
  const w = (2 * Math.PI * fc) / sr, rr = Math.exp(-w / (2 * q));
  const a1 = 2 * rr * Math.cos(w), a2 = -rr * rr, g = 1 - rr;
  let y1 = 0, y2 = 0;
  for (let i = 0; i < d.length; i++) {
    const y = g * d[i] + a1 * y1 + a2 * y2;
    y2 = y1;
    y1 = y;
    d[i] += y * mix;
  }
}

/** A guitar's or bass's wooden box: a few low resonances that give the string its warmth. */
function woodBody(d: Float32Array, sr: number, amount: number): void {
  for (const [fc, q] of [[105, 6], [205, 5], [390, 4]] as const) resonate(d, sr, fc, q, amount * 1.6);
}

function bass(sr: number, f: number, p: SynthParams): Float32Array {
  const n = Math.floor(sr * p.dur);
  const d = new Float32Array(n);
  const w = (2 * Math.PI * f) / sr;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = (1 - Math.exp(-t / 0.008)) * Math.exp(-t / 0.9);
    const v = Math.sin(w * i) + 0.28 * Math.sin(2 * w * i) + 0.08 * Math.sin(3 * w * i);
    d[i] = Math.tanh(1.4 * v) * env;
  }
  normalize(d, 0.9);
  fadeOut(d, sr, 0.05);
  return d;
}

/** Seamless loop: every partial makes a whole number of cycles over the buffer; detuned copies beat slowly. */
function pad(sr: number, f: number, p: SynthParams, r: () => number): { data: Float32Array; rootFreq: number } {
  const L = p.dur, n = Math.floor(sr * L);
  const d = new Float32Array(n);
  const k0 = Math.max(1, Math.round(f * L));
  const H = p.harmonics ?? 12, ro = p.rolloff ?? 2.5;
  for (let h = 1; h <= H; h++) {
    if (f * h > sr * 0.42) break;
    const amp = (1 / h) * Math.exp(-(h - 1) / ro);
    for (const v of [-1, 0, 1]) {
      const k = k0 * h + v, ph = r() * 6.283, a = amp * (v === 0 ? 1 : 0.7), w = (2 * Math.PI * k) / n;
      for (let i = 0; i < n; i++) d[i] += a * Math.sin(w * i + ph);
    }
  }
  normalize(d, 0.6);
  return { data: d, rootFreq: k0 / L };
}

/**
 * Sustained wind / bow / reed: an onset, then a seamless loop. Every partial, the vibrato and the
 * breath noise repeat exactly over the loop, so a note can hold for as long as it is written.
 */
function sustain(sr: number, f: number, p: SynthParams, r: () => number): { data: Float32Array; rootFreq: number; loopStart: number } {
  const L = p.dur, nL = Math.floor(sr * L), nA = Math.floor(sr * (p.onset ?? 0.1)), n = nA + nL;
  const d = new Float32Array(n);
  const k0 = Math.max(1, Math.round(f * L));
  const f0 = k0 / L;
  const H = p.harmonics ?? 8, ro = p.rolloff ?? 2, odd = p.odd ?? 0;
  const V = Math.max(1, Math.round((p.vibRate ?? 5) * L));
  const vibDepth = Math.pow(2, (p.vib ?? 0) / 1200) - 1;
  const ch = Math.round((p.chorus ?? 0) * L);
  const [fmHz, fmGain] = p.formant ?? [0, 0];
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = i >= nA ? 1 : Math.pow(i / nA, 1.6);
  const vibPhase = r() * 6.283;
  for (let h = 1; h <= H; h++) {
    const fh = f0 * h;
    if (fh > sr * 0.42) break;
    let amp = (1 / h) * Math.exp(-(h - 1) / ro);
    if (h % 2 === 0) amp *= 1 - odd;
    if (fmGain) amp *= 1 + fmGain * Math.exp(-Math.pow((fh - fmHz) / (fmHz * 0.5), 2));
    for (const v of ch ? [-ch, 0, ch] : [0]) {
      const k = k0 * h + v, ph = r() * 6.283, a = amp * (v === 0 ? 1 : 0.6);
      // Phase-modulation index giving this partial the vibrato depth; it grows in with the onset
      const beta = (vibDepth * k) / V;
      const w = (2 * Math.PI * k) / nL, wv = (2 * Math.PI * V) / nL;
      for (let i = 0; i < n; i++) {
        const u = i - nA, e = env[i];
        d[i] += a * e * Math.sin(w * u + ph + beta * e * e * Math.sin(wv * u + vibPhase));
      }
    }
  }
  // Breath / bow noise: one loop length of noise coloured round the note, made periodic by
  // running the filter three times round and keeping the last pass
  const breath = p.breath ?? 0;
  if (breath > 0) {
    const white = new Float32Array(nL);
    for (let i = 0; i < nL; i++) white[i] = r() * 2 - 1;
    const wC = (2 * Math.PI * Math.min(f0 * 1.5, sr * 0.4)) / sr, rr = Math.exp(-wC / 4);
    const a1 = 2 * rr * Math.cos(wC), a2 = -rr * rr;
    const col = new Float32Array(nL);
    let y1 = 0, y2 = 0, lp = 0;
    for (let pass = 0; pass < 3; pass++)
      for (let i = 0; i < nL; i++) {
        const y = (1 - rr) * white[i] + a1 * y1 + a2 * y2;
        y2 = y1;
        y1 = y;
        lp += (white[i] - lp) * 0.25;
        if (pass === 2) col[i] = y * 3 + lp * 0.35;
      }
    let sig = 0, rms = 0;
    for (let i = nA; i < n; i++) sig += d[i] * d[i];
    for (let i = 0; i < nL; i++) rms += col[i] * col[i];
    const k = breath * Math.sqrt(sig / nL / (rms / nL + 1e-12));
    for (let i = 0; i < n; i++) d[i] += col[(((i - nA) % nL) + nL) % nL] * k * env[i];
  }
  // The "chiff" of a note starting: a short noise burst, gone before the loop begins
  const chiff = p.chiff ?? 0;
  if (chiff > 0 && nA > 0) {
    let y = 0;
    for (let i = 0; i < nA; i++) {
      y += (r() * 2 - 1 - y) * 0.5;
      d[i] += y * chiff * 0.35 * Math.pow(1 - i / nA, 3);
    }
  }
  normalize(d, 0.6);
  return { data: d, rootFreq: f0, loopStart: nA / sr };
}

function shaker(sr: number, p: SynthParams, r: () => number): Float32Array {
  const n = Math.floor(sr * p.dur);
  const d = new Float32Array(n);
  const rise = p.rise ?? 0.006, tau = p.tau ?? 0.035, dark = p.dark ?? 0;
  let y = 0, z = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, x = r() * 2 - 1;
    y += (x - y) * 0.3;
    z += (x - y - z) * (1 - dark);
    d[i] = z * (1 - Math.exp(-t / rise)) * Math.exp(-t / tau);
  }
  normalize(d, 0.7);
  fadeOut(d, sr, 0.01);
  return d;
}

/** Reverb spaces: length, pre-delay, how dark the tail gets, early reflections (seconds) and tail level. */
export const SPACES: Record<SpaceName, { sec: number; pre: number; dark: number; early: number[]; tail: number }> = {
  /** Small wooden room: short, close, warm. */
  room: { sec: 0.7, pre: 0.004, dark: 0.6, early: [0.007, 0.013, 0.021], tail: 1 },
  /** The default: a soft hall. */
  hall: { sec: 1.5, pre: 0.012, dark: 0.8, early: [], tail: 1 },
  /** Open air: a thin short tail and a far echo off the woods. */
  field: { sec: 1.1, pre: 0.02, dark: 0.85, early: [0.11, 0.21], tail: 0.45 },
  /** Stone cave: long and dark. */
  cave: { sec: 2.6, pre: 0.03, dark: 0.82, early: [0.045, 0.08, 0.12], tail: 1 },
};

/** Stereo impulse: pre-delay, early reflections, then decaying noise that darkens as it fades. */
function impulse(sr: number, space: SpaceName, r: () => number): Float32Array[] {
  const sp = SPACES[space];
  const n = Math.floor(sr * sp.sec), pre = Math.floor(sr * sp.pre);
  const out: Float32Array[] = [];
  for (let ch = 0; ch < 2; ch++) {
    const d = new Float32Array(n);
    let y = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / (n - pre), a = Math.min(0.97, 0.15 + sp.dark * t);
      y += (r() * 2 - 1 - y) * (1 - a);
      d[i] = y * Math.exp(-6.9 * t) * sp.tail;
    }
    sp.early.forEach((e, k) => {
      const at = Math.floor(sr * e * (ch ? 1.07 : 0.94));
      if (at < n) d[at] += 0.4 / (k + 1);
    });
    out.push(d);
  }
  return out;
}

export function synthesize(req: SynthRequest): SynthResult {
  const t0 = performance.now();
  const samples: RenderedSample[] = [];
  for (const { name, synth: p } of req.patches) {
    const sr = Math.min(req.sr, p.srCap ?? req.sr);
    p.roots.forEach((m, k) => {
      // Stable per patch and root, so a re-render sounds the same
      let seed = k + 1;
      for (let i = 0; i < name.length; i++) seed = (seed * 31 + name.charCodeAt(i)) >>> 0;
      const r = rng(seed);
      const f = mtof(m);
      let data: Float32Array, rootFreq = f, loopStart = 0;
      if (p.kind === 'modal' || p.kind === 'drum') data = modal(sr, f, p, r, p.kind === 'drum');
      else if (p.kind === 'ks') ({ data, rootFreq } = ks(sr, f, p, r));
      else if (p.kind === 'bass') data = bass(sr, f, p);
      else if (p.kind === 'pad') ({ data, rootFreq } = pad(sr, f, p, r));
      else if (p.kind === 'sustain') ({ data, rootFreq, loopStart } = sustain(sr, f, p, r));
      else data = shaker(sr, p, r);
      samples.push({ patch: name, sr, rootFreq, loopStart, data });
    });
  }
  const ir = req.irSr ? impulse(req.irSr, req.space ?? 'hall', rng(99)) : null;
  return { samples, ir, ms: performance.now() - t0 };
}
