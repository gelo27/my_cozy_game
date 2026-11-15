/*
 * The slingshot's sounds rendered offline from simple physical models (run once into buffers):
 *  - the band creaking as it is drawn: stick-slip friction of rubber on leather, a train of tiny
 *    slips getting faster with tension, ringing through the rubber's resonances;
 *  - the release: a sharp snap, the rubber slapping forward, a damped twang of the band and the
 *    leather pouch flapping, a knock in the wooden fork;
 *  - the pebble whistling away (band-passed air, falling as it leaves, fluttering as it spins);
 *  - impacts by modal synthesis: a small stone's stiff high modes, the surface's knock, the
 *    dull thud and grit of dirt, the slap and body thump of a creature.
 * Every render is seeded, so a variant sounds the same each session.
 */

export type SlingSynthSound = 'draw' | 'full' | 'release' | 'whoosh' | 'hard' | 'ground' | 'thwack';

/** Seeded noise in -1..1. */
function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

type Filt = 'low' | 'band' | 'high';

/** Zero-delay state-variable filter (stable at any centre); `freq` may move per sample. */
function svf(x: Float32Array, sr: number, freq: number | ((i: number) => number), q: number, mode: Filt): Float32Array {
  const out = new Float32Array(x.length);
  const k = 1 / q;
  let ic1 = 0, ic2 = 0;
  const fixed = typeof freq === 'number';
  let g = fixed ? Math.tan((Math.PI * Math.min(freq as number, sr * 0.45)) / sr) : 0;
  for (let i = 0; i < x.length; i++) {
    if (!fixed) g = Math.tan((Math.PI * Math.min((freq as (i: number) => number)(i), sr * 0.45)) / sr);
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x[i] - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    out[i] = mode === 'low' ? v2 : mode === 'band' ? v1 : x[i] - k * v1 - v2;
  }
  return out;
}

/** Noise shaped by `env(t)` (s). */
function noise(n: number, sr: number, r: () => number, env: (t: number) => number): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = r() * env(i / sr);
  return x;
}

function mix(out: Float32Array, x: Float32Array, gain: number, at = 0): void {
  for (let i = 0; i < x.length && i + at < out.length; i++) out[i + at] += x[i] * gain;
}

/**
 * Adds one damped resonant mode at `start` (s): frequency `f` gliding down from `f * glide`
 * (time constant `glideT`), amplitude decaying with time constant `decay`.
 */
function mode(out: Float32Array, sr: number, start: number, f: number, decay: number, amp: number, glide = 1, glideT = 0.01): void {
  const i0 = Math.floor(start * sr);
  const n = Math.min(out.length - i0, Math.ceil(decay * 7 * sr));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const fi = f * (1 + (glide - 1) * Math.exp(-t / glideT));
    if (fi >= sr * 0.45) continue;
    ph += (2 * Math.PI * fi) / sr;
    // 0.3 ms attack, so the mode starts without a click of its own
    const a = Math.min(1, t / 0.0003) * Math.exp(-t / decay);
    out[i + i0] += Math.sin(ph) * a * amp;
  }
}

/** Short decaying noise burst (an impulse with some width) at `start`. */
function burst(out: Float32Array, sr: number, r: () => number, start: number, tau: number, amp: number, f: number, q: number, m: Filt): void {
  const n = Math.ceil(tau * 7 * sr);
  const x = svf(noise(n, sr, r, (t) => Math.exp(-t / tau)), sr, f, q, m);
  mix(out, x, amp, Math.floor(start * sr));
}

function normalize(x: Float32Array, peak: number): Float32Array {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 0) {
    const k = peak / m;
    for (let i = 0; i < x.length; i++) x[i] *= k;
  }
  // Gentle fade on the last 5 ms so a tail never ends on a click
  const f = Math.min(x.length, 240);
  for (let i = 0; i < f; i++) x[x.length - 1 - i] *= i / f;
  return x;
}

/** Stick-slip friction: a train of tiny slips at `rate(t)` slips/s, `amp(t)` loud, into `out`. */
function stickSlip(out: Float32Array, sr: number, r: () => number, rate: (t: number) => number, amp: (t: number) => number, until: number): void {
  let t = 0.01;
  while (t < until) {
    const a = amp(t) * (0.35 + 0.65 * Math.abs(r()));
    const i0 = Math.floor(t * sr);
    // Each slip: a ~0.5 ms burst
    const w = Math.ceil(sr * 0.0005);
    for (let i = 0; i < w && i0 + i < out.length; i++) out[i0 + i] += r() * a * (1 - i / w);
    t += (1 / Math.max(5, rate(t))) * (0.55 + 0.9 * Math.abs(r()));
  }
}

/** Rubber and leather stretching under a full draw (≈0.7 s). */
function renderDraw(sr: number, v: number): Float32Array {
  const r = rng(101 + v * 17);
  const dur = 0.72;
  const n = Math.floor(dur * sr);
  const ex = new Float32Array(n);
  // Slips speed up as the band tightens, and get a little louder
  stickSlip(ex, sr, r, (t) => 22 + 150 * Math.pow(t / dur, 1.4), (t) => 0.4 + 0.6 * (t / dur), dur - 0.02);
  const out = new Float32Array(n);
  // The stretched rubber's resonances, rising with tension
  const rise = (i: number) => 1 + 0.3 * (i / n);
  const base = [720 + v * 70, 1650 + v * 90, 3000 + v * 140];
  const gains = [1, 0.65, 0.35];
  const qs = [7, 9, 11];
  for (let k = 0; k < 3; k++) mix(out, svf(ex, sr, (i) => base[k] * rise(i), qs[k], 'band'), gains[k]);
  // Leather crinkle: sparse clicks, high
  const crk = new Float32Array(n);
  for (let i = 0; i < n; i++) if (Math.abs(r()) > 0.9985) crk[i] = r();
  mix(out, svf(crk, sr, 3200, 0.8, 'high'), 0.9);
  // A low rub of the hand on the pouch
  mix(out, svf(noise(n, sr, r, (t) => 0.5 * Math.min(1, t / 0.08) * (1 - 0.5 * t / dur)), sr, 320, 0.7, 'low'), 0.25);
  // Swell in: the first pull is soft
  for (let i = 0; i < n; i++) out[i] *= Math.min(1, i / (sr * 0.06));
  return normalize(out, 0.5);
}

/** The band at full stretch: a tight, quick creak. */
function renderFull(sr: number, v: number): Float32Array {
  const r = rng(211 + v * 23);
  const dur = 0.18;
  const n = Math.floor(dur * sr);
  const ex = new Float32Array(n);
  stickSlip(ex, sr, r, (t) => 260 - 600 * t, (t) => Math.exp(-t / 0.05), 0.12);
  const out = new Float32Array(n);
  mix(out, svf(ex, sr, 1950 + v * 120, 13, 'band'), 1);
  mix(out, svf(ex, sr, 3500 + v * 200, 14, 'band'), 0.5);
  mix(out, svf(ex, sr, 900, 6, 'band'), 0.35);
  return normalize(out, 0.42);
}

/** The shot: snap, rubber slap, the band's twang, the pouch flap, a knock in the fork. */
function renderRelease(sr: number, v: number): Float32Array {
  const r = rng(307 + v * 29);
  const n = Math.floor(0.38 * sr);
  const out = new Float32Array(n);
  // Snap: the very sharp edge of the band letting go
  burst(out, sr, r, 0, 0.0005, 1.3, 1800, 0.7, 'high');
  // Rubber slapping forward
  burst(out, sr, r, 0.0008, 0.006, 0.8, 2600, 0.7, 'low');
  // Leather pouch flapping past the fork
  burst(out, sr, r, 0.007 + v * 0.002, 0.011, 0.45, 1100 + v * 120, 1.4, 'band');
  burst(out, sr, r, 0.021 + v * 0.003, 0.008, 0.2, 1500, 1.6, 'band');
  // The band's twang: a fundamental dropping as the stretch goes out of it, with a stiff overtone
  const f = 118 + v * 14 + r() * 6;
  mode(out, sr, 0.001, f, 0.055, 0.85, 1.9, 0.012);
  mode(out, sr, 0.001, f * 2.73, 0.022, 0.3, 1.6, 0.01);
  mode(out, sr, 0.001, f * 4.9, 0.01, 0.12, 1.3, 0.01);
  // The frame jolting in the hand
  mode(out, sr, 0.002, 68 + v * 5, 0.06, 0.45, 1.3, 0.015);
  // The wooden fork knocking
  mode(out, sr, 0.001, 540 + v * 40, 0.016, 0.22);
  mode(out, sr, 0.001, 1380 + v * 70, 0.009, 0.14);
  return normalize(out, 0.9);
}

/** The pebble whistling away through the air, spinning. */
function renderWhoosh(sr: number, v: number): Float32Array {
  const r = rng(401 + v * 31);
  const dur = 0.5;
  const n = Math.floor(dur * sr);
  const env = (t: number) => Math.min(1, t / 0.006) * Math.exp(-t / (0.09 + v * 0.015));
  const flutter = 26 + v * 7;
  const src = noise(n, sr, r, (t) => env(t) * (1 + 0.35 * Math.sin(2 * Math.PI * flutter * t)));
  const out = new Float32Array(n);
  // Falls in pitch as it leaves (a little Doppler)
  mix(out, svf(src, sr, (i) => 650 + 3300 * Math.exp(-i / sr / 0.14), 1.6, 'band'), 1);
  mix(out, svf(src, sr, (i) => 1800 + 4000 * Math.exp(-i / sr / 0.1), 3, 'band'), 0.35);
  mix(out, svf(src, sr, 700, 0.7, 'low'), 0.35);
  return normalize(out, 0.55);
}

/** A pebble clacking on rock or wood, with a tiny second bounce. */
function renderHard(sr: number, v: number): Float32Array {
  const r = rng(503 + v * 37);
  const n = Math.floor(0.32 * sr);
  const out = new Float32Array(n);
  const s = 0.85 + 0.3 * Math.abs(r());
  const fs = [2350, 3750, 5300, 7700, 9900].map((f) => f * s * (0.95 + 0.1 * Math.abs(r())));
  const ds = [0.034, 0.024, 0.017, 0.011, 0.007];
  const as = [1, 0.7, 0.55, 0.4, 0.3];
  const strike = (at: number, k: number) => {
    burst(out, sr, r, at, 0.0003, 0.9 * k, 3000, 0.7, 'high');
    for (let i = 0; i < fs.length; i++) mode(out, sr, at, fs[i], ds[i], as[i] * k * (0.8 + 0.4 * Math.abs(r())));
  };
  strike(0, 1);
  // The surface's own knock: lower, quicker (rock or a plank)
  const knock = 380 + 260 * Math.abs(r());
  mode(out, sr, 0, knock, 0.02, 0.55);
  mode(out, sr, 0, knock * 2.4, 0.012, 0.28);
  // Skips and clicks once more
  strike(0.035 + 0.03 * Math.abs(r()), 0.32);
  if (v % 2 === 1) strike(0.09 + 0.02 * Math.abs(r()), 0.12);
  return normalize(out, 0.7);
}

/** A pebble thudding into dirt or grass, with a spatter of grit. */
function renderGround(sr: number, v: number): Float32Array {
  const r = rng(601 + v * 41);
  const n = Math.floor(0.26 * sr);
  const out = new Float32Array(n);
  burst(out, sr, r, 0, 0.014, 1, 650 + v * 60, 0.7, 'low');
  mode(out, sr, 0, 92 + v * 12 + r() * 6, 0.04, 0.95, 1.5, 0.01);
  mode(out, sr, 0, 240 + v * 20, 0.018, 0.3);
  // Grit scattering: sparse clicks thinning out
  const grit = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if (Math.abs(r()) > 1 - 0.006 * Math.exp(-t / 0.03)) grit[i] = r();
  }
  mix(out, svf(grit, sr, 2200, 0.7, 'high'), 0.9);
  burst(out, sr, r, 0.002, 0.035, 0.18, 1700, 1.2, 'band');
  return normalize(out, 0.7);
}

/** A pebble smacking into a creature: slap, flesh, body thump. */
function renderThwack(sr: number, v: number): Float32Array {
  const r = rng(701 + v * 43);
  const n = Math.floor(0.3 * sr);
  const out = new Float32Array(n);
  burst(out, sr, r, 0, 0.004, 1, 3200, 0.7, 'low');
  burst(out, sr, r, 0.001, 0.018, 0.8, 430 + v * 50, 1, 'band');
  mode(out, sr, 0, 135 + v * 15, 0.07, 0.9, 1.6, 0.012);
  mode(out, sr, 0, 58 + v * 6, 0.08, 0.5, 1.2, 0.02);
  // A wet edge
  burst(out, sr, r, 0.004, 0.012, 0.18, 1900, 2.5, 'band');
  return normalize(out, 0.85);
}

const RENDER: Record<SlingSynthSound, (sr: number, v: number) => Float32Array> = {
  draw: renderDraw,
  full: renderFull,
  release: renderRelease,
  whoosh: renderWhoosh,
  hard: renderHard,
  ground: renderGround,
  thwack: renderThwack,
};

/** Variants rendered per sound. */
export const SYNTH_VARIANTS: Record<SlingSynthSound, number> = {
  draw: 2,
  full: 2,
  release: 3,
  whoosh: 3,
  hard: 4,
  ground: 3,
  thwack: 3,
};

export function renderSling(name: SlingSynthSound, sr: number, variant: number): Float32Array {
  return RENDER[name](sr, variant);
}
