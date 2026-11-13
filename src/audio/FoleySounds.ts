/**
 * Door, watering-can, shovel and thunder sounds, synthesised ONCE into small mono buffers and then only
 * replayed (one AudioBufferSourceNode + gain per play, like TreeSounds). A few variants of each are
 * rendered in idle slices; playback picks one with a slight pitch / level jitter.
 *
 * The recipes follow how the real sounds are made, not oscillator chirps:
 * - Opening a door: a quiet latch click, then the same hinge creak as closing, a little higher.
 *   A creak is stick-slip friction: an irregular train of tiny impulses ringing the narrow
 *   resonances of the hinge and the door leaf.
 * - A door slam is the leaf hitting the frame: a short contact crack, the panel's broad, dull
 *   wooden resonances (noise through low-Q band-passes; clean sines would ring like a bell), a
 *   low thump carried through the wall, the latch tongue clacking into the strike plate (a few
 *   inharmonic metal modes) and the leaf rattling once or twice as it settles.
 * - Water sounds liquid because its resonances keep moving: the pour is noise through resonant
 *   band-passes whose pitch hops at random every few ms ("babble"), a livelier upper layer over
 *   a rounder low splash, with dull pats on the soil, the water sloshing in the can as it tips
 *   and a few tiny splashes as the last drops fall (no hiss, no synthetic bloops).
 * - Distant thunder (`rumble`) is the sum of N-shaped shock waves from every metre of a tortuous
 *   lightning channel, arriving at different times (Few / Ribner & Roy): farther segments,
 *   stretched and dulled by the air, roll in as clusters (the "rolls" of thunder) over a deep
 *   growl. (A close strike is played live in AmbientAudio.)
 */

let SR = 22050;
type Kind = 'doorOpen' | 'doorClose' | 'water' | 'rumble' | 'shovelDig' | 'shovelPat';

const RATE: Record<Kind, number> = { doorOpen: 22050, doorClose: 22050, water: 16000, rumble: 6000, shovelDig: 22050, shovelPat: 22050 };
const VARIANTS: Record<Kind, number> = { doorOpen: 3, doorClose: 3, water: 3, rumble: 3, shovelDig: 4, shovelPat: 2 };
/** Pre-render order: what the player hears most often first. */
const WARM_ORDER: Kind[] = ['doorOpen', 'doorClose', 'shovelDig', 'shovelPat', 'water', 'rumble'];

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
  const a0 = 1 + al;
  b0 /= a0; b1 /= a0; b2 /= a0;
  const na1 = (-2 * c) / a0, na2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

/** Runs a whole buffer through a filter, in place. */
function filterAll(d: Float32Array, f: (x: number) => number): void {
  for (let i = 0; i < d.length; i++) d[i] = f(d[i]);
}

const sec = (s: number) => Math.floor(s * SR);
const exp = (tau: number) => (t: number) => Math.exp(-t / tau);
const smooth = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** A damped sine (one metal mode), recursive oscillator: no sin / exp per sample. */
function mode(d: Float32Array, at: number, f: number, tau: number, amp: number, r: () => number, attack = 0.0005): void {
  const start = sec(at), n = Math.min(d.length - start, sec(tau * 7));
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
  const every = len > 0.05 ? 8 : 1;
  let e = 0;
  for (let i = 0; i < n; i++) {
    if (i % every === 0) e = env(i / SR);
    let x = (r() * 2 - 1) * e;
    for (let j = 0; j < chain.length; j++) x = chain[j](x);
    d[start + i] += x * amp;
  }
}

/**
 * Stick-slip friction (hinge / board creak): impulses at a wavering rate gliding r0 -> r1 per
 * second, rung through narrow resonances `bands` ([Hz, Q, gain]), swelling by `shape(k)`.
 */
function creak(
  d: Float32Array, at: number, len: number, r0: number, r1: number,
  bands: [number, number, number][], amp: number, r: () => number,
  shape: (k: number) => number = (k) => Math.sin(Math.PI * k),
): void {
  const start = sec(at), n = Math.min(d.length - start, sec(len));
  const res = bands.map(([f, q]) => biquad('bp', f, q));
  const hp = biquad('hp', 220, 0.7);
  const wob = r() * Math.PI * 2, wobRate = 2 + r() * 3;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const k = i / n;
    let x = 0;
    if (i >= next) {
      // The rate wavers (hand speed, grain of the wood) and jitters pulse to pulse
      const rate = (r0 + (r1 - r0) * k) * (1 + 0.18 * Math.sin(wob + 2 * Math.PI * wobRate * (i / SR)));
      next = i + Math.max(1, Math.round((SR / rate) * (0.8 + r() * 0.4)));
      x = shape(k) * (0.55 + r() * 0.45);
    }
    let y = 0;
    for (let j = 0; j < res.length; j++) y += res[j](x) * bands[j][2];
    d[start + i] += hp(y) * amp;
  }
}

/** One N-shaped shock wave of length T (s): a jump up, a linear fall to the same depth below. */
function nwave(d: Float32Array, at: number, T: number, amp: number): void {
  const s = sec(at), n = Math.max(2, Math.round(T * SR));
  if (s < 0) return;
  const k = 2 / (n - 1);
  for (let i = 0; i < n && s + i < d.length; i++) d[s + i] += amp * (1 - k * i);
}

/** Standard normal sample (Box–Muller). */
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

// ------------------------------------------------------------------------------------- doors

/** The latch: the handle turns and the tongue slides back (two small metallic clicks). */
function latch(d: Float32Array, at: number, r: () => number, amp: number): void {
  for (const [dt, a] of [[0, 1], [0.025 + r() * 0.02, 0.6]] as const) {
    const t = at + dt;
    noise(d, t, 0.004, exp(0.0006), [biquad('hp', 2500, 0.7)], 0.5 * a * amp, r);
    const m = 2600 + r() * 900;
    mode(d, t, m, 0.018, 0.07 * a * amp, r);
    mode(d, t, m * 1.53, 0.012, 0.05 * a * amp, r);
    mode(d, t, m * 2.31, 0.008, 0.035 * a * amp, r);
    // The handle mechanism has a little body too
    noise(d, t, 0.03, exp(0.006), [biquad('bp', 900 + r() * 300, 2.5)], 0.35 * a * amp, r);
  }
}

/** Hinge + leaf resonances for a creak (the hinge squeals high, the leaf answers lower). */
function hingeBands(r: () => number, tone = 1): [number, number, number][] {
  const b = (0.85 + r() * 0.3) * tone;
  return [
    [560 * b, 7, 1],
    [1180 * b, 9, 0.8],
    [2350 * b, 12, 0.5],
    [3900 * b, 14, 0.25],
  ];
}

/**
 * Opening a door: the same hinge creak as when it closes, a little higher and rising instead of
 * falling, after a quiet click of the latch, with the air the leaf moves.
 */
function doorOpen(r: () => number): Float32Array {
  const d = new Float32Array(sec(0.6));
  latch(d, 0, r, 0.4);
  const len = 0.17 + r() * 0.06;
  const at = 0.04;
  creak(d, at, len, 85 + r() * 30, 140 + r() * 40, hingeBands(r, 1.15), 10, r, (k) => Math.min(1, k * 4) * (1 - k * 0.5));
  noise(d, at, len + 0.05, (t) => Math.sin(Math.PI * Math.min(1, t / (len + 0.05))), [biquad('bp', 560, 0.7)], 0.3, r);
  return d;
}

function doorClose(r: () => number): Float32Array {
  const d = new Float32Array(sec(0.85));
  const hit = 0.13 + r() * 0.06;
  // The swing: a short creak and the air pushed ahead of the leaf
  creak(d, 0.0, hit, 130 + r() * 50, 80 + r() * 30, hingeBands(r), 10, r, (k) => Math.min(1, k * 4) * (1 - k * 0.5));
  noise(d, 0.0, hit + 0.02, (t) => Math.pow(Math.min(1, t / hit), 2), [biquad('bp', 520, 0.7)], 0.35, r);
  // Contact: wood on wood, a short crack
  noise(d, hit, 0.006, exp(0.0009), [biquad('hp', 700, 0.7)], 0.55, r);
  // The panel: broad, dull wooden resonances, gone within a few tens of ms
  const b = 0.88 + r() * 0.24;
  noise(d, hit, 0.3, (t) => Math.min(1, t / 0.0015) * Math.exp(-t / 0.055), [biquad('bp', 145 * b, 1.4)], 6, r);
  noise(d, hit, 0.22, (t) => Math.min(1, t / 0.001) * Math.exp(-t / 0.04), [biquad('bp', 270 * b, 2)], 3.6, r);
  noise(d, hit, 0.15, exp(0.026), [biquad('bp', 540 * b, 2.4)], 2.1, r);
  noise(d, hit, 0.1, exp(0.016), [biquad('bp', 1150 * b, 2.8)], 1.1, r);
  // The thump carried through the wall and floor
  noise(d, hit, 0.3, (t) => Math.min(1, t / 0.003) * Math.exp(-t / 0.07), [biquad('lp', 110, 0.8), biquad('lp', 150, 0.7)], 4, r);
  // The latch tongue snapping into the strike plate
  const lt = hit + 0.003 + r() * 0.004;
  noise(d, lt, 0.004, exp(0.0005), [biquad('hp', 2200, 0.7)], 0.35, r);
  const m = 1900 + r() * 600;
  mode(d, lt, m, 0.03, 0.1, r);
  mode(d, lt, m * 1.62, 0.022, 0.07, r);
  mode(d, lt, m * 2.47, 0.014, 0.05, r);
  // The leaf settles: one or two small rattles against the stop
  const rattles = 1 + Math.floor(r() * 2.5);
  for (let i = 0; i < rattles; i++) {
    const at = hit + 0.035 + i * (0.025 + r() * 0.03);
    noise(d, at, 0.04, exp(0.007), [biquad('bp', 700 + r() * 700, 3)], 0.7 * Math.pow(0.55, i), r);
  }
  // A short room tail
  noise(d, hit + 0.01, 0.4, (t) => Math.min(1, t / 0.01) * Math.exp(-t / 0.11), [biquad('lp', 700, 0.7)], 0.5, r);
  return d;
}

// ---------------------------------------------------------------------------------- watering

/** Matches the WATER clip (2 s): the can tips at ~0.4 s and pours until ~1.6 s. */
const POUR_ON = 0.38;
const POUR_OFF = 1.6;

/**
 * Babbling water: noise through a resonant band-pass (Chamberlin state-variable filter, cheap and
 * stable below SR/6) whose centre jumps to a random pitch in [lo, hi] every few ms and glides
 * there. That wandering resonance is what the ear hears as liquid (brooks, pouring, splashing);
 * plain filtered noise is just hiss. `level(t)` (t in s from 0) shapes it. Adds into `d`.
 */
function babble(d: Float32Array, s0: number, s1: number, lo: number, hi: number, q: number, hopMs: [number, number], level: (t: number) => number, amp: number, r: () => number): void {
  const damp = 1 / q;
  const lr = Math.log(hi / lo);
  let target = lo * Math.exp(r() * lr), fc = target;
  let low = 0, band = 0, next = s0, e = 0, f = 0;
  const glide = 1 - Math.exp(-1 / (0.0015 * SR));
  for (let i = s0; i < s1; i++) {
    if (i >= next) {
      target = lo * Math.exp(r() * lr);
      next = i + Math.max(1, Math.round(((hopMs[0] + r() * (hopMs[1] - hopMs[0])) / 1000) * SR));
    }
    if ((i & 7) === 0) {
      e = level(i / SR);
      f = 2 * Math.sin((Math.PI * fc) / SR);
    }
    fc += (target - fc) * glide;
    const x = (r() * 2 - 1) * e;
    low += f * band;
    const high = x - low - damp * band;
    band += f * high;
    d[i] += band * amp;
  }
}

function water(r: () => number): Float32Array {
  const d = new Float32Array(sec(2.05));
  const ph1 = r() * 6.3, ph2 = r() * 6.3;
  // How hard the stream is right now: swells in, wavers with the hand, cuts off as the can rights
  const pour = (t: number) =>
    Math.max(0, smooth(POUR_ON, POUR_ON + 0.12, t) * (1 - smooth(POUR_OFF - 0.18, POUR_OFF, t)) *
      (1 + 0.15 * Math.sin(ph1 + 2 * Math.PI * 2.3 * t) + 0.07 * Math.sin(ph2 + 2 * Math.PI * 5.3 * t)));

  // Water shifting in the can as it tips: a soft, low slosh
  babble(d, sec(0.08), sec(0.45), 180, 420, 3, [12, 30], (t) => Math.sin(Math.PI * Math.min(1, Math.max(0, t - 0.08) / 0.37)), 0.5, r);

  const s0 = sec(POUR_ON), s1 = Math.min(d.length, sec(POUR_OFF + 0.02));
  // The shower landing in the wet bed: a lively, liquid babble...
  babble(d, s0, s1, 650, 2400, 5, [3, 9], pour, 1, r);
  babble(d, s0, s1, 900, 2600, 6, [2, 6], pour, 0.6, r);
  // ...over a rounder, lower splash body
  babble(d, s0, s1, 280, 800, 3, [6, 16], pour, 0.8, r);
  // Drops patting the soil: dull and quiet underneath
  {
    const pat = biquad('bp', 650 + r() * 150, 0.9), lp = biquad('lp', 1400, 0.7);
    let p = 0;
    for (let i = s0; i < s1; i++) {
      if ((i - s0) % 8 === 0) p = (400 * pour(i / SR)) / SR;
      const x = r() < p ? (r() < 0.5 ? -1 : 1) * (0.3 + r() * 0.7) : 0;
      d[i] += lp(pat(x)) * 1.2;
    }
  }
  // The last few drops after the can is righted: tiny splashes (a babble burst each)
  const drips = 3 + Math.floor(r() * 4);
  for (let i = 0; i < drips; i++) {
    const t = POUR_OFF + 0.03 + Math.pow(r(), 1.4) * 0.36;
    const fade = 1 - (t - POUR_OFF) / 0.45;
    const a = sec(t);
    babble(d, a, Math.min(d.length, a + sec(0.04)), 700, 1800, 6, [4, 8], (u) => Math.exp(-(u - t) / 0.009), 0.7 * fade, r);
  }
  const hp = biquad('hp', 130, 0.7), lp = biquad('lp', 3200, 0.6);
  for (let i = 0; i < d.length; i++) d[i] = lp(hp(d[i]));
  return d;
}

// ------------------------------------------------------------------------------------ shovel

/** Grains / clods: sparse impulses at `rate(t)` per second (t from `at`) rung through `chain`. */
function grains(d: Float32Array, at: number, len: number, rate: (t: number) => number, chain: ((x: number) => number)[], amp: number, r: () => number): void {
  const start = sec(at), n = Math.min(d.length - start, sec(len));
  let p = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 7) === 0) p = rate(i / SR) / SR;
    let x = r() < p ? (r() < 0.5 ? -1 : 1) * (0.3 + r() * 0.7) : 0;
    for (let j = 0; j < chain.length; j++) x = chain[j](x);
    d[start + i] += x * amp;
  }
}

/** A few soft clods landing on loose soil: dull pats spread over `spread` s, then trickling grains. */
function clods(d: Float32Array, at: number, spread: number, count: number, amp: number, r: () => number): void {
  for (let i = 0; i < count; i++) {
    const t = at + Math.pow(r(), 1.5) * spread;
    const a = amp * (0.5 + r() * 0.5) * (1 - 0.5 * (t - at) / Math.max(spread, 0.001));
    noise(d, t, 0.06, (u) => Math.min(1, u / 0.002) * Math.exp(-u / 0.012), [biquad('bp', 320 + r() * 380, 0.9)], 2.2 * a, r);
  }
  grains(d, at, 0.3, (u) => 900 * Math.exp(-u / 0.07), [biquad('bp', 2200 + r() * 800, 0.9), biquad('lp', 4500, 0.7)], 0.9 * amp, r);
}

/**
 * The spade going into soil and the earth thrown aside (starts at the blade's impact):
 * - the stab: the steel edge slicing through grains, a dense gritty "chhk" (no metallic ring:
 *   soil damps the blade at once, only a faint, dull trace of it), over the dull push of the
 *   earth compressing;
 * - the pry: soil tearing as the blade levers up, a few cracks of roots and clods;
 * - the toss: earth sliding off the blade, then landing as soft pats and trickling grains.
 */
function shovelDig(r: () => number): Float32Array {
  const d = new Float32Array(sec(0.75));
  const b = 0.9 + r() * 0.2;
  // Stab
  noise(d, 0, 0.004, exp(0.0008), [biquad('hp', 1500, 0.7)], 0.35, r);
  grains(d, 0, 0.14, (t) => 5000 * Math.exp(-t / 0.035) + 600 * Math.exp(-t / 0.09), [biquad('bp', 2600 * b, 0.8)], 1.4, r);
  noise(d, 0, 0.16, (t) => Math.min(1, t / 0.003) * Math.exp(-t / 0.045), [biquad('bp', 1500 * b, 0.9)], 0.55, r);
  noise(d, 0, 0.2, (t) => Math.min(1, t / 0.004) * Math.exp(-t / 0.04), [biquad('lp', 220, 0.8), biquad('hp', 70, 0.7)], 3.2, r);
  mode(d, 0.001, 950 * b, 0.007, 0.03, r);
  mode(d, 0.001, 2350 * b, 0.005, 0.02, r);
  // Pry: soil tearing, a crack or two
  const pry = 0.1 + r() * 0.04;
  grains(d, pry, 0.14, (t) => 450 * Math.sin(Math.PI * Math.min(1, t / 0.14)), [biquad('bp', 1100 * b, 1.1)], 2.2, r);
  noise(d, pry, 0.14, (t) => Math.sin(Math.PI * Math.min(1, t / 0.14)), [biquad('bp', 900, 0.8), biquad('lp', 2000, 0.7)], 0.18, r);
  if (r() < 0.6) noise(d, pry + 0.03 + r() * 0.06, 0.03, exp(0.005), [biquad('bp', 1600 + r() * 800, 1.6)], 0.8, r);
  // Toss: earth sliding off the blade...
  const slide = 0.22 + r() * 0.05;
  grains(d, slide, 0.12, (t) => 1600 * Math.sin(Math.PI * Math.min(1, t / 0.12)), [biquad('bp', 2400 * b, 0.9)], 0.9, r);
  noise(d, slide, 0.12, (t) => Math.sin(Math.PI * Math.min(1, t / 0.12)), [biquad('bp', 1800, 0.7)], 0.12, r);
  // ...and landing
  clods(d, slide + 0.12 + r() * 0.04, 0.06, 3 + Math.floor(r() * 3), 1, r);
  const hp = biquad('hp', 80, 0.7), lp = biquad('lp', 6000, 0.6);
  for (let i = 0; i < d.length; i++) d[i] = lp(hp(d[i]));
  return d;
}

/** The back of the spade patting the dug bed flat: two dull slaps on loose earth. */
function shovelPat(r: () => number): Float32Array {
  const d = new Float32Array(sec(0.6));
  const pat = (at: number, a: number) => {
    noise(d, at, 0.12, (t) => Math.min(1, t / 0.002) * Math.exp(-t / 0.022), [biquad('bp', 260 + r() * 80, 0.8)], 3 * a, r);
    noise(d, at, 0.1, (t) => Math.min(1, t / 0.003) * Math.exp(-t / 0.03), [biquad('lp', 160, 0.8), biquad('hp', 60, 0.7)], 2.4 * a, r);
    noise(d, at, 0.03, exp(0.006), [biquad('bp', 900, 0.8)], 0.35 * a, r);
    grains(d, at, 0.08, (t) => 1200 * Math.exp(-t / 0.025), [biquad('bp', 2400, 0.9)], 0.8 * a, r);
    mode(d, at + 0.001, 820 + r() * 120, 0.006, 0.02 * a, r);
  };
  pat(0, 1);
  pat(0.16 + r() * 0.05, 0.65);
  grains(d, 0.05, 0.4, (t) => 120 * Math.exp(-t / 0.15), [biquad('bp', 2000, 1)], 0.8, r);
  const hp = biquad('hp', 70, 0.7), lp = biquad('lp', 5000, 0.6);
  for (let i = 0; i < d.length; i++) d[i] = lp(hp(d[i]));
  return d;
}

// ----------------------------------------------------------------------------------- thunder

interface Roll { c: number; w: number; g: number; n: number }

/** Clusters of arrivals ("rolls") from the far parts of the channel. */
function rolls(r: () => number, first: number, count: number, gap: [number, number], width: [number, number], decay: number, n: [number, number]): Roll[] {
  const out: Roll[] = [];
  let c = first;
  for (let i = 0; i < count; i++) {
    const g = (0.45 + r() * 0.55) * Math.exp(-(c - first) / decay) * (r() < 0.3 ? 1.5 : 1);
    out.push({ c, w: width[0] + r() * (width[1] - width[0]), g, n: Math.floor(n[0] + r() * (n[1] - n[0])) });
    c += gap[0] + r() * (gap[1] - gap[0]);
  }
  return out;
}

/** The rolls as N-waves (longer and so lower the later they arrive) plus their growl envelope. */
function renderRolls(d: Float32Array, rs: Roll[], r: () => number, T0: number, Tgrow: number, Tjit: number): (t: number) => number {
  for (const ro of rs) {
    for (let i = 0; i < ro.n; i++) {
      const t = ro.c + gauss(r) * ro.w;
      if (t < 0) continue;
      const T = T0 + Tgrow * t + r() * Tjit;
      const amp = ro.g * (0.35 + r() * 0.65) * (r() < 0.06 ? 2.2 : 1) * (r() < 0.5 ? 1 : -1);
      nwave(d, t, T, amp);
    }
  }
  return (t: number) => {
    let e = 0;
    for (const ro of rs) {
      const z = (t - ro.c) / (ro.w * 1.4);
      e += ro.g * Math.exp(-z * z);
    }
    return e;
  };
}

/** Distant thunder: no crack, only the stretched, dull roll that swells in and out. */
function rumble(r: () => number): Float32Array {
  const d = new Float32Array(sec(7));
  const rs = rolls(r, 0.25 + r() * 0.35, 3 + Math.floor(r() * 3), [0.6, 1.6], [0.25, 0.75], 3.5, [160, 320]);
  const env = renderRolls(d, rs, r, 0.012, 0.003, 0.02);
  noise(d, 0, 7, (t) => env(t) * 0.9 * smooth(0, 0.5, t), [biquad('lp', 70, 0.8), biquad('lp', 100, 0.7)], 10, r);
  // (the air has already taken the highs: one gentle low-pass is enough; N-waves carry no DC)
  const l1 = biquad('lp', 1000, 0.6), h1 = biquad('hp', 26, 0.7);
  for (let i = 0; i < d.length; i++) d[i] = h1(l1(d[i]));
  return d;
}

const RECIPES: Record<Kind, (r: () => number) => Float32Array> = { doorOpen, doorClose, water, rumble, shovelDig, shovelPat };

/**
 * Renders variant `index` of `kind` (pure: no audio context, so it also runs in the sound-render
 * worker). Peak-normalised, with a short fade-out.
 */
export function renderFoleySound(kind: Kind, index: number): { data: Float32Array; rate: number } {
  SR = RATE[kind];
  const data = RECIPES[kind](rng(0x51ed + index * 7919 + kind.length * 104729));
  let peak = 0;
  for (let j = 0; j < data.length; j++) peak = Math.max(peak, Math.abs(data[j]));
  const g = peak > 0 ? 0.95 / peak : 1;
  const fade = Math.min(data.length, sec(0.02));
  for (let j = data.length - fade; j < data.length; j++) data[j] *= (data.length - j) / fade;
  for (let j = 0; j < data.length; j++) data[j] *= g;
  return { data, rate: SR };
}

export type FoleySoundKind = Kind;
/** Variants per kind, and the order they are rendered in ahead of time. */
export const FOLEY_VARIANTS = VARIANTS;
export const FOLEY_WARM_ORDER = WARM_ORDER;
