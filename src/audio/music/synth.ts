import type { SynthParams } from './patches';

/**
 * Pure sample synthesis (no Web Audio, no DOM): runs in the music worker, or on the main thread
 * if a worker cannot start. Everything is mono Float32 at a low sample rate.
 */

export interface RenderedSample {
  patch: string;
  sr: number;
  /** Real pitch of the sample (Karplus-Strong and pad loops land slightly off the note). */
  rootFreq: number;
  data: Float32Array;
}

export interface SynthRequest {
  patches: { name: string; synth: SynthParams }[];
  sr: number;
  /** Also render a stereo reverb impulse at this rate (the context's own). */
  irSr?: number;
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
    let c = 1, s = 0, e = amp;
    for (let i = 0; i < len; i++) {
      const nc = c * cw - s * sw;
      s = s * cw + c * sw;
      c = nc;
      d[i] += s * e * (i < att ? i / att : 1);
      e *= dec;
    }
  }
  const click = p.click ?? 0;
  const cl = Math.floor(sr * (drum ? 0.012 : 0.004));
  let y = 0;
  for (let i = 0; i < cl; i++) {
    y += (r() * 2 - 1 - y) * (drum ? 0.35 : 0.6);
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
  normalize(d, 0.9);
  fadeOut(d, sr, 0.08);
  return { data: d, rootFreq: realF };
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

function shaker(sr: number, p: SynthParams, r: () => number): Float32Array {
  const n = Math.floor(sr * p.dur);
  const d = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, x = r() * 2 - 1;
    y += (x - y) * 0.3;
    d[i] = (x - y) * (1 - Math.exp(-t / 0.006)) * Math.exp(-t / 0.035);
  }
  normalize(d, 0.7);
  fadeOut(d, sr, 0.01);
  return d;
}

/** Stereo hall: pre-delay, then decaying noise that darkens as it fades. */
function impulse(sr: number, sec: number, r: () => number): Float32Array[] {
  const n = Math.floor(sr * sec), pre = Math.floor(sr * 0.012);
  const out: Float32Array[] = [];
  for (let ch = 0; ch < 2; ch++) {
    const d = new Float32Array(n);
    let y = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / (n - pre), a = 0.15 + 0.8 * t;
      y += (r() * 2 - 1 - y) * (1 - a);
      d[i] = y * Math.exp(-6.9 * t);
    }
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
      let data: Float32Array, rootFreq = f;
      if (p.kind === 'modal' || p.kind === 'drum') data = modal(sr, f, p, r, p.kind === 'drum');
      else if (p.kind === 'ks') ({ data, rootFreq } = ks(sr, f, p, r));
      else if (p.kind === 'bass') data = bass(sr, f, p);
      else if (p.kind === 'pad') ({ data, rootFreq } = pad(sr, f, p, r));
      else data = shaker(sr, p, r);
      samples.push({ patch: name, sr, rootFreq, data });
    });
  }
  const ir = req.irSr ? impulse(req.irSr, 1.5, rng(99)) : null;
  return { samples, ir, ms: performance.now() - t0 };
}
