/**
 * Woodcutting and mining sounds, synthesised ONCE into small mono buffers (22 kHz) and then just replayed:
 * at runtime every sound is a single AudioBufferSourceNode + gain, which costs next to nothing on
 * phones (the old versions built 3–6 oscillators / filters per hit). A few variants of each are
 * rendered, and playback picks one with a slight pitch / level jitter so repeats don't sound canned.
 *
 * The recipes are physical-ish: an axe bite is a sharp click, a crunch of torn fibres and the
 * trunk's short inharmonic "tok"; a falling tree tears at the hinge, groans (stick-slip pulses
 * through wooden resonances, not a low buzz) and whooshes through the air; the landing is a deep
 * ground thump with branches cracking and leaves settling.
 */

/** Sample rate of the sound being rendered (the long, dull ones use a lower one). */
let SR = 22050;
const RATE: Record<string, number> = { fall: 16000, impact: 16000, rockBreak: 16000 };

type Kind = 'chop' | 'chopFatal' | 'swing' | 'fall' | 'impact' | 'split' | 'mine' | 'mineCrystal' | 'rockBreak';

const VARIANTS: Record<Kind, number> = { chop: 4, chopFatal: 2, swing: 3, fall: 2, impact: 2, split: 2, mine: 4, mineCrystal: 2, rockBreak: 2 };

/** Small seeded PRNG so every variant is stable and distinct. */
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

/** RBJ biquad (direct form I) as a per-sample function. */
function biquad(type: 'lp' | 'hp' | 'bp', f: number, q: number): (x: number) => number {
  const w = (2 * Math.PI * Math.min(f, SR * 0.45)) / SR;
  const c = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === 'lp') (b0 = (1 - c) / 2), (b1 = 1 - c), (b2 = (1 - c) / 2);
  else if (type === 'hp') (b0 = (1 + c) / 2), (b1 = -(1 + c)), (b2 = (1 + c) / 2);
  else (b0 = al), (b1 = 0), (b2 = -al);
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  b0 /= a0; b1 /= a0; b2 /= a0;
  const na1 = a1 / a0, na2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

const sec = (s: number) => Math.floor(s * SR);

/** A damped sine (one vibrating mode of the wood / ground), with a soft attack so it doesn't click. */
function mode(d: Float32Array, at: number, f: number, tau: number, amp: number, r: () => number, attack = 0.002): void {
  const start = sec(at), n = Math.min(d.length - start, sec(tau * 7));
  // Recursive oscillator and decay: no sin / exp per sample
  const w = (2 * Math.PI * f) / SR, cw = Math.cos(w), sw = Math.sin(w), dec = Math.exp(-1 / (tau * SR));
  const ph = r() * Math.PI * 2;
  let c = Math.cos(ph), s = Math.sin(ph), e = amp;
  const atk = Math.max(1, sec(attack));
  for (let i = 0; i < n; i++) {
    d[start + i] += e * (i < atk ? i / atk : 1) * s;
    const nc = c * cw - s * sw;
    s = s * cw + c * sw;
    c = nc;
    e *= dec;
  }
}

/** Noise shaped by `env(t)` (t in s from `at`) through a filter chain. */
function noise(d: Float32Array, at: number, len: number, env: (t: number) => number, chain: ((x: number) => number)[], amp: number, r: () => number): void {
  const start = sec(at), n = Math.min(d.length - start, sec(len));
  // Long bursts: the envelope is sampled every 8 samples (sub-millisecond, inaudible)
  const every = len > 0.05 ? 8 : 1;
  let e = 0;
  for (let i = 0; i < n; i++) {
    if (i % every === 0) e = env(i / SR);
    let x = (r() * 2 - 1) * e;
    for (const f of chain) x = f(x);
    d[start + i] += x * amp;
  }
}

/** Sparse clicks (wood fibres / twigs snapping), `rate(t)` per second, rung through a filter chain. */
function crackles(d: Float32Array, at: number, len: number, rate: (t: number) => number, level: (t: number) => number, chain: ((x: number) => number)[], amp: number, r: () => number): void {
  const start = sec(at), n = Math.min(d.length - start, sec(len));
  let p = 0;
  for (let i = 0; i < n; i++) {
    if (i % 8 === 0) p = rate(i / SR) / SR;
    let x = 0;
    if (r() < p) x = (r() < 0.5 ? -1 : 1) * (0.3 + r() * 0.7) * level(i / SR);
    for (const f of chain) x = f(x);
    d[start + i] += x * amp;
  }
}

const exp = (tau: number) => (t: number) => Math.exp(-t / tau);

/** The axe biting into a trunk. */
function chop(r: () => number, fatal: boolean): Float32Array {
  const d = new Float32Array(sec(fatal ? 0.55 : 0.36));
  // Living wood is soft and wet: it damps almost at once and never rings like a pipe. So the
  // body is noise through broad, low-Q resonances (a "thock"), not clean sine modes.
  // Steel meets wood: a short click, not too bright
  noise(d, 0, 0.005, exp(0.0007), [biquad('hp', 1200, 0.7)], 0.6, r);
  // The thock: broad wooden resonances, each gone within a few tens of ms
  const b = 0.9 + r() * 0.2;
  noise(d, 0, 0.12, exp(0.03), [biquad('bp', 420 * b, 2.2)], 2.4, r);
  noise(d, 0, 0.1, exp(0.022), [biquad('bp', 720 * b, 2.4)], 1.6, r);
  noise(d, 0, 0.07, exp(0.014), [biquad('bp', 1200 * b, 2.4)], 1.0, r);
  // Torn fibres: grainy crunch (dense tiny cracks) rather than smooth hiss, with a second
  // squeeze as the wedge of the blade drives in
  const crunch = [biquad('bp', 2100 + r() * 500, 0.9)];
  crackles(d, 0.001, 0.06, (t) => 1800 * Math.exp(-t / 0.016), () => 1, crunch, 1.4, r);
  crackles(d, 0.009 + r() * 0.006, 0.05, (t) => 900 * Math.exp(-t / 0.012), () => 0.7, [biquad('bp', 1400, 1)], 1.2, r);
  noise(d, 0.001, 0.05, exp(0.012), [biquad('bp', 1700, 1)], 0.5, r);
  // The trunk taking the blow: a short, dull low thump (low-passed noise, barely any tone)
  noise(d, 0, 0.12, (t) => Math.min(1, t / 0.002) * Math.exp(-t / 0.035), [biquad('lp', 180, 0.7), biquad('lp', 240, 0.6)], 6, r);
  mode(d, 0, 85 + r() * 15, 0.035, 0.12, r, 0.003);
  if (fatal) {
    // The last fibres give way: a hard splintering crack right after the bite
    noise(d, 0.03, 0.05, exp(0.008), [biquad('hp', 500, 0.7)], 1.1, r);
    crackles(d, 0.04, 0.35, (t) => 90 * Math.exp(-t / 0.12), () => 1, [biquad('bp', 1500, 1.4)], 1.8, r);
  }
  return d;
}

/** The axe cutting the air: a band of noise sweeping up and back down. */
function swing(r: () => number): Float32Array {
  const len = 0.2 + r() * 0.04;
  const d = new Float32Array(sec(len));
  const peak = 0.09 + r() * 0.03;
  // Swept band-pass (coefficients per sample: only ~5k samples, rendered once)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / SR;
    const k = Math.min(1, t / peak);
    const f = t < peak ? 450 + 1100 * k * k : 1550 * Math.exp(-(t - peak) / 0.06) + 350;
    const w = (2 * Math.PI * f) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * 1.6), a0 = 1 + al;
    const x = r() * 2 - 1;
    const y = ((al * x - al * x2) - (-2 * c) * y1 - (1 - al) * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    const env = t < peak ? Math.pow(t / peak, 2) : Math.exp(-(t - peak) / 0.035);
    d[i] = y * env;
  }
  return d;
}

/**
 * The tree going over (starts on the felling blow): the hinge tears with a crack, the trunk groans
 * and pops as it tilts, then the crown rushes through the air faster and faster.
 */
function fall(r: () => number): Float32Array {
  const d = new Float32Array(sec(1.9));
  // Hinge tearing
  noise(d, 0.04, 0.06, exp(0.012), [biquad('hp', 350, 0.7), biquad('lp', 5000, 0.7)], 1.0, r);
  mode(d, 0.04, 105 + r() * 20, 0.09, 0.35, r, 0.003);
  // Groan: stick-slip pulses (irregular, 16 → 45 per second) ringing wooden resonances. Pitched
  // in the mids with the lows cut, so it creaks instead of buzzing.
  const groan = new Float32Array(d.length);
  {
    const res = [biquad('bp', 380 + r() * 60, 11), biquad('bp', 900 + r() * 120, 9), biquad('bp', 1650 + r() * 200, 7)];
    const mix = [0.7, 0.45, 0.25];
    const hp = biquad('hp', 260, 0.7);
    const start = sec(0.12), end = sec(1.0);
    let next = start;
    for (let i = start; i < end; i++) {
      const t = (i - start) / (end - start);
      let x = 0;
      if (i >= next) {
        const rate = 16 + 29 * t;
        next = i + Math.max(1, Math.round((SR / rate) * (0.7 + r() * 0.6)));
        // Swells in, wavers, dies away
        x = Math.sin(Math.PI * Math.min(1, t * 1.15)) * (0.6 + r() * 0.4);
      }
      let y = 0;
      for (let k = 0; k < 3; k++) y += res[k](x) * mix[k];
      groan[i] = hp(y);
    }
  }
  for (let i = 0; i < d.length; i++) d[i] += groan[i] * 2.2;
  // Fibres popping as it leans, thinning out
  crackles(d, 0.1, 0.9, (t) => 30 * Math.exp(-t / 0.4) + 4, () => 1, [biquad('bp', 1900, 1.3)], 1.2, r);
  // The crown through the air: a rising rush, cut off (the landing is its own sound)
  noise(
    d, 0.35, 1.55,
    (t) => {
      const k = Math.min(1, t / 1.15);
      return k * k * (t > 1.2 ? Math.exp(-(t - 1.2) / 0.1) : 1);
    },
    [biquad('bp', 1100, 0.6), biquad('lp', 3500, 0.7)], 0.55, r
  );
  return d;
}

/** The trunk and crown hitting the ground. */
function impact(r: () => number): Float32Array {
  const d = new Float32Array(sec(1.7));
  const thump = (at: number, amp: number) => {
    // Ground: low-passed noise burst + the trunk's lowest modes
    noise(d, at, 0.5, (t) => Math.min(1, t / 0.004) * Math.exp(-t / 0.11), [biquad('lp', 170, 0.8), biquad('lp', 220, 0.6)], 7 * amp, r);
    mode(d, at, 46 + r() * 8, 0.17, 0.55 * amp, r, 0.006);
    mode(d, at, 74 + r() * 10, 0.11, 0.4 * amp, r, 0.005);
    // The trunk itself knocking
    mode(d, at, 210 + r() * 40, 0.06, 0.22 * amp, r);
    mode(d, at, 340 + r() * 60, 0.045, 0.14 * amp, r);
    noise(d, at, 0.05, exp(0.01), [biquad('bp', 700, 1.2)], 0.9 * amp, r);
  };
  thump(0, 1);
  thump(0.24 + r() * 0.08, 0.35);
  // Branches snapping all over the crown, then fewer
  crackles(d, 0.005, 0.9, (t) => 160 * Math.exp(-t / 0.18) + 6, () => 1, [biquad('bp', 1700, 1.1)], 1.6, r);
  crackles(d, 0.01, 0.6, (t) => 60 * Math.exp(-t / 0.15), () => 1, [biquad('bp', 650, 1.6)], 1.8, r);
  // Leaves crashing and settling
  noise(d, 0, 1.6, (t) => Math.min(1, t / 0.01) * Math.exp(-t / 0.35), [biquad('bp', 2600, 0.7)], 0.7, r);
  return d;
}

/** A felled trunk split into logs: a dry crack and a hollow knock. */
function split(r: () => number): Float32Array {
  const d = new Float32Array(sec(0.45));
  noise(d, 0, 0.006, exp(0.0008), [biquad('hp', 1800, 0.7)], 0.8, r);
  noise(d, 0.004, 0.06, exp(0.01), [biquad('hp', 450, 0.7)], 1.2, r);
  crackles(d, 0.01, 0.25, (t) => 120 * Math.exp(-t / 0.06), () => 1, [biquad('bp', 1800, 1.3)], 1.6, r);
  // The knock: broad wooden resonances excited by noise (clean sines would ring like a pipe)
  const b = 0.9 + r() * 0.2;
  noise(d, 0, 0.14, exp(0.035), [biquad('bp', 340 * b, 2.8)], 2.4, r);
  noise(d, 0, 0.1, exp(0.024), [biquad('bp', 600 * b, 2.8)], 1.5, r);
  noise(d, 0, 0.12, (t) => Math.min(1, t / 0.002) * Math.exp(-t / 0.04), [biquad('lp', 200, 0.7), biquad('lp', 260, 0.6)], 5, r);
  return d;
}

/**
 * A pick striking stone. Rock is stiff and hard: the hit is a sharp, bright "clack" with almost no
 * low end, the steel head gives a short inharmonic clink, chips spray off, and a few grains
 * trickle down a moment later. Crystal adds a glassy ring.
 */
function mine(r: () => number, crystal: boolean): Float32Array {
  const d = new Float32Array(sec(crystal ? 0.9 : 0.55));
  // Contact: a very short, hard broadband click
  noise(d, 0, 0.004, exp(0.0005), [biquad('hp', 900, 0.7)], 1.0, r);
  // The stone's clack: bright, narrow-ish resonances that die fast
  const b = 0.9 + r() * 0.2;
  noise(d, 0, 0.06, exp(0.012), [biquad('bp', 2300 * b, 3)], 2.2, r);
  noise(d, 0, 0.05, exp(0.009), [biquad('bp', 3900 * b, 3)], 1.4, r);
  noise(d, 0, 0.08, exp(0.018), [biquad('bp', 1100 * b, 2.2)], 1.3, r);
  // A dull knock of the block itself (short: stone doesn't boom)
  noise(d, 0, 0.08, (t) => Math.min(1, t / 0.0015) * Math.exp(-t / 0.02), [biquad('lp', 380, 0.7)], 2.5, r);
  // The pick head: a short metallic clink (inharmonic, quiet, ~0.1 s)
  const m = 2600 + r() * 500;
  mode(d, 0, m, 0.07, 0.07, r, 0.0005);
  mode(d, 0, m * 1.47, 0.05, 0.05, r, 0.0005);
  mode(d, 0, m * 2.09, 0.035, 0.035, r, 0.0005);
  // Chips flying: dense bright ticks for a few tens of ms
  crackles(d, 0.002, 0.07, (t) => 1500 * Math.exp(-t / 0.02), () => 1, [biquad('bp', 4500, 1.2)], 1.0, r);
  // Grit trickling down the face afterwards
  crackles(d, 0.12 + r() * 0.06, 0.35, (t) => 70 * Math.exp(-t / 0.12), () => 0.35 + r() * 0.3, [biquad('bp', 3200, 1.6)], 2.2, r);
  if (crystal) {
    // Glassy ring of the crystal: high, slightly detuned partials that linger
    const c = 1900 + r() * 400;
    for (const [k, a, tau] of [[1, 0.12, 0.35], [2.76, 0.08, 0.25], [5.4, 0.05, 0.16], [1.004, 0.06, 0.3]] as const) mode(d, 0.001, c * k, tau, a, r, 0.001);
  }
  return d;
}

/** A rock giving way: a heavy crack, a crunching thump, then rubble tumbling and settling. */
function rockBreak(r: () => number): Float32Array {
  const d = new Float32Array(sec(1.3));
  noise(d, 0, 0.03, exp(0.006), [biquad('hp', 300, 0.7), biquad('lp', 6500, 0.7)], 1.3, r);
  noise(d, 0, 0.3, (t) => Math.min(1, t / 0.003) * Math.exp(-t / 0.07), [biquad('lp', 260, 0.7), biquad('lp', 320, 0.6)], 6, r);
  noise(d, 0.002, 0.12, exp(0.03), [biquad('bp', 1300, 1.5)], 1.6, r);
  // Chunks knocking against each other as the pile collapses
  for (let i = 0; i < 7; i++) {
    const at = 0.04 + r() * 0.55;
    const f = 500 + r() * 900;
    noise(d, at, 0.06, exp(0.01 + r() * 0.01), [biquad('bp', f, 2.5)], 0.9 * (1 - at), r);
  }
  // Gravel pouring, then the last pebbles
  crackles(d, 0.01, 1.1, (t) => 400 * Math.exp(-t / 0.22) + 10 * Math.exp(-t / 0.6), () => 1, [biquad('bp', 3000, 1.1)], 1.3, r);
  noise(d, 0.01, 0.9, (t) => Math.min(1, t / 0.02) * Math.exp(-t / 0.2), [biquad('bp', 2400, 0.8)], 0.35, r);
  return d;
}

const RECIPES: Record<Kind, (r: () => number, i: number) => Float32Array> = {
  chop: (r) => chop(r, false),
  chopFatal: (r) => chop(r, true),
  swing,
  fall,
  impact,
  split,
  mine: (r) => mine(r, false),
  mineCrystal: (r) => mine(r, true),
  rockBreak,
};

/** Order the variants are rendered in ahead of time (what's needed first goes first). */
const WARM_ORDER: Kind[] = ['swing', 'chop', 'chopFatal', 'mine', 'fall', 'impact', 'rockBreak', 'split', 'mineCrystal'];

/**
 * Renders variant `index` of `kind` (pure: no audio context, so it also runs in the sound-render
 * worker). Peak-normalised, with a short fade-out.
 */
export function renderTreeSound(kind: Kind, index: number): { data: Float32Array; rate: number } {
  SR = RATE[kind] ?? 22050;
  const data = RECIPES[kind](rng(0x9e37 + index * 7919 + kind.length * 104729), index);
  // Normalise: every variant peaks at the same level; the caller sets the loudness
  let peak = 0;
  for (let j = 0; j < data.length; j++) peak = Math.max(peak, Math.abs(data[j]));
  const g = peak > 0 ? 0.95 / peak : 1;
  // Short fade-out so a cut tail never clicks
  const fade = Math.min(data.length, sec(0.01));
  for (let j = data.length - fade; j < data.length; j++) data[j] *= (data.length - j) / fade;
  for (let j = 0; j < data.length; j++) data[j] *= g;
  return { data, rate: SR };
}

export type TreeSoundKind = Kind;
/** Variants per kind, and the order they are rendered in ahead of time. */
export const TREE_VARIANTS = VARIANTS;
export const TREE_WARM_ORDER = WARM_ORDER;
