import { audioEngine, AudioChannel } from './AudioEngine';

/** What the player walks on; picks the footstep recipe. */
export type FootSurface =
  | 'grass' | 'dirt' | 'asphalt' | 'cobble' | 'sand' | 'snow'
  | 'wood' | 'stone' | 'tile' | 'carpet' | 'water';

/**
 * Footsteps and swimming, synthesised once into short AudioBuffers (no files).
 *
 * Models (after the physically informed footstep work of Turchet, Serafin & Nordahl and Perry
 * Cook's PhISEM):
 * - A step is driven by a ground-reaction-force envelope: a sharp heel strike, then a weaker,
 *   slower roll onto the ball of the foot / toe push-off.
 * - Solid floors (wood, stone, tile, asphalt) = the shoe as an exciter (a short half-sine force
 *   pulse: the harder the floor, the shorter and brighter) ringing a few damped modal resonators of
 *   the floor, plus a whisper of grit under the sole.
 * - Granular ground (grass, gravel/dirt, sand, snow, carpet fibres, water) = PhISEM: at every sample
 *   a particle collision happens with a probability that follows the force envelope, each collision
 *   adds a quickly decaying noise burst, and the sum is coloured by a couple of 2-pole resonances
 *   (the "size" of the particles).
 * - Real recorded / mixed footsteps carry almost no energy below ~150-300 Hz (the force itself is
 *   felt, not heard, and Foley is high-passed), so every recipe ends in a 24 dB/oct high-pass at
 *   its surface's corner. That is what removes the fake "bass thump".
 *
 * Runtime: every sound is rendered once at 24 kHz into a few variants (~2.5 MB for all of them),
 * pre-rendered one per browser idle slot. Playing a sound allocates only the one-shot
 * AudioBufferSourceNode Web Audio requires; gains come from a fixed pool of pre-connected voices
 * and the end handler is one shared function, so walking makes no JS garbage.
 */

/** Random takes per sound: more for steps (heard constantly), fewer for long, rare sounds. */
const VARIANTS = 4;
const VARIANTS_LONG = 2;
const SYNTH_RATE = 24000;
const VOICES = 12;

type Kind = FootSurface | 'wet' | 'stroke' | 'lap' | 'splash' | 'under' | 'exhale';
/** Pre-render order: what the player hears first comes first. */
const WARM_ORDER: Kind[] = ['grass', 'dirt', 'wood', 'sand', 'stone', 'water', 'wet', 'cobble', 'asphalt', 'tile', 'carpet', 'snow', 'stroke', 'lap', 'splash', 'under', 'exhale'];

/** Relative loudness per surface (soft floors are quieter). */
const SURFACE_GAIN: Record<FootSurface, number> = {
  grass: 0.7, dirt: 0.8, asphalt: 0.75, cobble: 0.8, sand: 0.65, snow: 0.8,
  wood: 0.85, stone: 0.75, tile: 0.7, carpet: 0.45, water: 0.85,
};

const R = Math.random;
const rr = (a: number, b: number) => a + R() * (b - a);

// ------------------------------------------------------------------ DSP, in place on Float32Arrays

/** RBJ biquad, run in place. */
function biquad(x: Float32Array, sr: number, type: 'lp' | 'hp' | 'bp', f: number, q = 0.707): void {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const cos = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === 'lp') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; }
  const a0 = 1 + alpha;
  b0 /= a0; b1 /= a0; b2 /= a0;
  const c1 = (-2 * cos) / a0, c2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + b1 * x1 + b2 * x2 - c1 * y1 - c2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    x[i] = y;
  }
}

/** Ground reaction force of one step: heel strike, then the roll / toe push-off. */
interface Grf {
  heelAttack: number;
  heelDecay: number;
  toeAt: number;
  toeAmp: number;
  toeAttack: number;
  toeDecay: number;
}

function envPulse(x: number, a: number, d: number): number {
  return x < 0 ? 0 : x < a ? x / a : Math.exp(-(x - a) / d);
}

function grfAt(t: number, g: Grf): number {
  return envPulse(t, g.heelAttack, g.heelDecay) + g.toeAmp * envPulse(t - g.toeAt, g.toeAttack, g.toeDecay);
}

/** A 2-pole resonance (centre f, pole radius r) used by both models. */
interface Res { f: number; r: number; g: number }

/** Reused excitation buffer: rendering allocates only the outputs. */
let scratch = new Float32Array(SYNTH_RATE);
function scratchOf(n: number): Float32Array {
  if (scratch.length < n) scratch = new Float32Array(n);
  scratch.fill(0, 0, n);
  return scratch.subarray(0, n);
}

/** Runs `x` through parallel 2-pole resonators and ADDS the result to `out`. */
function resonate(x: Float32Array, out: Float32Array, sr: number, bank: Res[]): void {
  for (const m of bank) {
    const c1 = -2 * m.r * Math.cos((2 * Math.PI * m.f) / sr);
    const c2 = m.r * m.r;
    const norm = (1 - m.r) * 2 * m.g; // keeps narrow (high r) modes from exploding
    let y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const y = x[i] * norm - c1 * y1 - c2 * y2;
      y2 = y1; y1 = y;
      out[i] += y;
    }
  }
}

/** Pole radius for a mode that rings for `decay` seconds (time constant). */
const radius = (decay: number, sr: number) => Math.exp(-1 / (decay * sr));

/**
 * PhISEM (Cook): collisions happen with probability density·force, each adds energy to a noise
 * level that decays per sample; the noise is coloured by `bank`. Adds into `out`.
 */
function phisem(out: Float32Array, sr: number, g: Grf, density: number, soundDecay: number, bank: Res[], amp: number, start = 0): void {
  const x = scratchOf(out.length);
  const p = density / sr;
  let level = 0;
  for (let i = 0; i < x.length; i++) {
    const e = grfAt(i / sr - start, g);
    if (R() < p * e) level += e * (0.3 + R());
    level *= soundDecay;
    x[i] = (R() * 2 - 1) * level * amp;
  }
  resonate(x, out, sr, bank);
}

/** Shoe hits a solid floor: half-sine force pulses (heel, toe) ringing the floor's modes. */
function impact(out: Float32Array, sr: number, g: Grf, contactMs: number, modes: [number, number, number][], click: number): void {
  const x = scratchOf(out.length);
  const pulse = (at: number, ms: number, a: number) => {
    const s = Math.floor(at * sr);
    const n = Math.max(2, Math.round((ms / 1000) * sr));
    for (let i = 0; i < n && s + i < x.length; i++) x[s + i] += Math.sin((Math.PI * i) / n) * a;
  };
  pulse(0, contactMs, 1);
  pulse(g.toeAt, contactMs * 1.4, g.toeAmp);
  const bank: Res[] = modes.map(([f, decay, a]) => ({ f: f * rr(0.94, 1.06), r: radius(decay, sr), g: a * 40 }));
  resonate(x, out, sr, bank);
  // The direct contact noise ("click") is broadband but short
  if (click > 0) {
    for (let i = 0; i < out.length; i++) out[i] += x[i] * (R() * 2 - 1) * click;
  }
}

/** Minnaert bubble: a short sine gliding upward as it decays (the "bloop" of water). */
function bubble(out: Float32Array, sr: number, at: number, f0: number, dur: number, amp: number): void {
  const s = Math.floor(at * sr);
  const len = Math.min(Math.ceil(dur * sr), out.length - s);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const k = i / len;
    ph += (2 * Math.PI * f0 * (1 + k * 0.8)) / sr;
    out[s + i] += Math.sin(ph) * Math.min(1, i / (0.002 * sr)) * Math.exp(-k * 4.5) * amp;
  }
}

/** A faint wood creak: a tone rubbed by sparse stick-slip impulses. */
function creak(out: Float32Array, sr: number, at: number, f: number, dur: number, amp: number): void {
  const s = Math.floor(at * sr);
  const len = Math.min(Math.ceil(dur * sr), out.length - s);
  let ph = 0, rub = 0;
  for (let i = 0; i < len; i++) {
    const k = i / len;
    ph += (2 * Math.PI * f * (1 - k * 0.15)) / sr;
    rub = rub * 0.9 + (R() < 0.04 ? 0.5 : 0);
    out[s + i] += (Math.sin(ph) + 0.4 * Math.sin(ph * 2.01) + 0.2 * Math.sin(ph * 3.03)) * rub * Math.sin(Math.PI * k) * amp;
  }
}

/** Filtered noise with an attack / decay envelope (water swishes only). */
function swish(out: Float32Array, sr: number, at: number, attack: number, decay: number, f: number, q: number, amp: number): void {
  const x = scratchOf(out.length);
  const s = Math.floor(at * sr);
  for (let i = s; i < x.length; i++) {
    const t = (i - s) / sr;
    x[i] = (R() * 2 - 1) * (t < attack ? t / attack : Math.exp(-(t - attack) / decay));
  }
  biquad(x, sr, 'bp', f, q);
  for (let i = 0; i < out.length; i++) out[i] += x[i] * amp;
}

/**
 * High-pass (24 dB/oct) at `hp`, gentle low-pass at `lp` (a rubber sole and the air soften the
 * very top: this is what keeps steps from sounding harsh), peak-normalise and fade the tail.
 */
function finish(o: Float32Array, sr: number, hp: number, lp: number, peak = 0.9): Float32Array {
  if (hp > 0) {
    biquad(o, sr, 'hp', hp);
    biquad(o, sr, 'hp', hp);
  }
  if (lp > 0) biquad(o, sr, 'lp', lp, 0.6);
  let max = 0;
  for (let i = 0; i < o.length; i++) max = Math.max(max, Math.abs(o[i]));
  const k = max > 0 ? peak / max : 1;
  const fade = Math.floor(0.02 * sr);
  for (let i = 0; i < o.length; i++) o[i] *= k * (i > o.length - fade ? (o.length - i) / fade : 1);
  return o;
}

const grf = (heelAttack: number, heelDecay: number, toeAt: number, toeAmp: number, toeAttack: number, toeDecay: number): Grf =>
  ({ heelAttack, heelDecay, toeAt: toeAt * rr(0.85, 1.15), toeAmp: toeAmp * rr(0.8, 1.1), toeAttack, toeDecay });

const res = (f: number, r: number, g = 1): Res => ({ f, r, g });

/**
 * A shoe on hard outdoor ground (asphalt, paving, cobbles): a rubber sole does not "click" and
 * the ground barely rings, so a step is a short, soft "thup" of the heel (band-limited contact
 * noise), a quieter roll onto the toe, and the fine scrape of sand and grit under the sole.
 */
function soleOnHardGround(o: Float32Array, sr: number, p: number, grit: number): Grf {
  const g = grf(0.002, 0.022, 0.085, 0.6, 0.004, 0.03);
  swish(o, sr, 0, 0.002, 0.016, 850 * p, 0.55, 1);
  swish(o, sr, 0.001, 0.0015, 0.008, 1900 * p, 0.6, 0.35);
  swish(o, sr, g.toeAt, 0.004, 0.02, 950 * p, 0.55, 0.55 * g.toeAmp);
  phisem(o, sr, g, 650 * grit, 0.9, [res(2300 * p, 0.55), res(3600 * p, 0.5, 0.5)], 0.45 * grit);
  return g;
}

function renderStep(sr: number, surface: FootSurface): Float32Array {
  const long = surface === 'snow' || surface === 'sand' || surface === 'water';
  const o = new Float32Array(Math.ceil(sr * (long ? 0.38 : 0.28)));
  const p = rr(0.92, 1.1); // per-variant shoe / weight
  switch (surface) {
    case 'grass': {
      // Blades bend and snap: many tiny ticks; a soft swish of leaves around the shoe
      const g = grf(0.01, 0.05, 0.09, 0.75, 0.014, 0.06);
      phisem(o, sr, g, 2400, 0.94, [res(2600 * p, 0.7), res(4600 * p, 0.65, 0.6)], 1);
      phisem(o, sr, g, 900, 0.985, [res(1300 * p, 0.55, 0.6)], 0.4);
      return finish(o, sr, 300, 6000);
    }
    case 'dirt': {
      // Dirt path: a soft, dull press into packed earth and a few small pebbles crunching
      const g = grf(0.005, 0.04, 0.09, 0.65, 0.008, 0.045);
      swish(o, sr, 0, 0.005, 0.03, 600 * p, 0.5, 1);
      swish(o, sr, g.toeAt, 0.006, 0.03, 700 * p, 0.5, 0.5 * g.toeAmp);
      phisem(o, sr, g, 650, 0.92, [res(1500 * p, 0.6), res(2800 * p, 0.55, 0.5)], 0.75);
      phisem(o, sr, g, 1800, 0.85, [res(3200 * p, 0.45, 0.4)], 0.2); // dust
      return finish(o, sr, 180, 4200);
    }
    case 'sand': {
      // The foot sinks in: no impact, a soft hiss of sliding grains that swells and drags
      const g = grf(0.022, 0.08, 0.13, 0.7, 0.03, 0.09);
      phisem(o, sr, g, 7000, 0.88, [res(1700 * p, 0.55), res(3600 * p, 0.55, 0.6)], 1);
      return finish(o, sr, 260, 5500);
    }
    case 'snow': {
      // Compacting snow: slower, longer crunch of breaking bonds with a squeaky resonance
      const g = grf(0.016, 0.11, 0.15, 0.55, 0.02, 0.09);
      phisem(o, sr, g, 1600, 0.982, [res(950 * p, 0.86), res(2200 * p, 0.8, 0.8), res(3800 * p, 0.7, 0.4)], 1);
      return finish(o, sr, 220, 5500);
    }
    // Asphalt and cobbles sound alike under shoes; cobbles only have a bit more grit in the joints
    case 'asphalt':
      soleOnHardGround(o, sr, p, 1);
      return finish(o, sr, 200, 4500);
    case 'cobble':
      soleOnHardGround(o, sr, p * rr(0.95, 1.05), 1.4);
      return finish(o, sr, 200, 4500);
    case 'stone': {
      // Flagstones / terracotta indoors: the sole's thup plus a short, dull stone knock
      const g = soleOnHardGround(o, sr, p, 0.6);
      impact(o, sr, g, 1.4, [[1300 * p, 0.008, 0.25], [2600 * p, 0.005, 0.12]], 0);
      return finish(o, sr, 200, 4800);
    }
    case 'tile': {
      // Glazed tile / marble: firmer contact and a short, clear ring
      const g = grf(0.0015, 0.02, 0.075, 0.6, 0.0025, 0.025);
      swish(o, sr, 0, 0.0015, 0.012, 1100 * p, 0.6, 0.6);
      impact(o, sr, g, 1.4, [[2300 * p, 0.02, 0.35], [3900 * p, 0.014, 0.2]], 0.05);
      return finish(o, sr, 260, 6500);
    }
    case 'wood': {
      // Planks: a soft contact ringing the boards' mid modes (no boom), sometimes a creak
      // (contact stays short: a longer one would stop exciting the upper board modes and go boomy)
      const g = grf(0.002, 0.03, 0.08, 0.6, 0.004, 0.04);
      impact(o, sr, g, 1.6, [[340 * p * rr(0.9, 1.1), 0.022, 0.12], [640 * p * rr(0.9, 1.1), 0.02, 0.4], [1150 * p, 0.015, 0.4], [2300 * p, 0.009, 0.22]], 0.1);
      phisem(o, sr, g, 300, 0.9, [res(4000, 0.6)], 0.12);
      if (R() < 0.3) creak(o, sr, rr(0.03, 0.09), rr(320, 520), rr(0.08, 0.14), 0.04);
      return finish(o, sr, 240, 6500);
    }
    case 'carpet': {
      // Fibres compress: a muted brush, almost no ring
      const g = grf(0.012, 0.04, 0.08, 0.6, 0.015, 0.04);
      phisem(o, sr, g, 3500, 0.86, [res(1300 * p, 0.45), res(2600 * p, 0.4, 0.4)], 1);
      return finish(o, sr, 250, 3500);
    }
    case 'water': {
      // Wading: the foot pushes water (a soft slosh) and drops fall back with liquid "plinks"
      swish(o, sr, 0, 0.04, 0.09, 520 * p, 0.6, 1);
      swish(o, sr, 0.02, 0.04, 0.08, 1100 * p, 0.7, 0.35);
      phisem(o, sr, grf(0.06, 0.1, 0.15, 0.5, 0.03, 0.08), 500, 0.985, [res(rr(900, 1300), 0.92), res(rr(1700, 2300), 0.9, 0.5)], 0.6, 0.05);
      for (let i = 0, n = 2 + Math.floor(R() * 3); i < n; i++) bubble(o, sr, rr(0.04, 0.25), rr(450, 1000), rr(0.03, 0.06), rr(0.04, 0.08));
      return finish(o, sr, 150, 4000);
    }
  }
}

/** Extra layer while the ground is soaked by rain: a suction squelch and droplets. */
function renderWet(sr: number): Float32Array {
  const o = new Float32Array(Math.ceil(sr * 0.22));
  const g = grf(0.008, 0.04, 0.07, 0.5, 0.01, 0.04);
  phisem(o, sr, g, 1400, 0.97, [res(rr(800, 1100), 0.88), res(2200, 0.6, 0.4)], 1);
  for (let i = 0; i < 2; i++) bubble(o, sr, rr(0.01, 0.1), rr(700, 1300), 0.025, 0.08);
  return finish(o, sr, 250, 4500);
}

/**
 * Arm stroke at the surface: the hand pushes a body of water (a soft, low "sloosh" that swells
 * and fades), then thrown drops fall back with liquid plinks (strongly resonant, not hissy).
 */
function renderStroke(sr: number): Float32Array {
  const o = new Float32Array(Math.ceil(sr * 0.8));
  swish(o, sr, 0, 0.11, 0.17, rr(420, 560), 0.55, 1);
  swish(o, sr, 0.05, 0.09, 0.13, rr(900, 1200), 0.65, 0.35);
  phisem(o, sr, grf(0.05, 0.14, 0.2, 0.4, 0.05, 0.1), 600, 0.988, [res(rr(850, 1200), 0.93), res(rr(1600, 2200), 0.9, 0.5)], 0.7, 0.12);
  for (let i = 0, n = 3 + Math.floor(R() * 4); i < n; i++) bubble(o, sr, rr(0.12, 0.55), rr(380, 900), rr(0.03, 0.06), rr(0.03, 0.06));
  return finish(o, sr, 110, 3500, 0.8);
}

/** Calm water lapping at the body while floating still: a slow, low slosh. */
function renderLap(sr: number): Float32Array {
  const o = new Float32Array(Math.ceil(sr * 0.7));
  swish(o, sr, 0, 0.16, 0.2, rr(330, 450), 0.6, 1);
  swish(o, sr, 0.08, 0.12, 0.14, rr(700, 900), 0.7, 0.25);
  for (let i = 0; i < 2; i++) bubble(o, sr, rr(0.1, 0.45), rr(300, 600), rr(0.04, 0.07), 0.04);
  return finish(o, sr, 100, 2500, 0.6);
}

/** Jumping or falling in: the impact crack, the plunge and a cloud of bubbles. */
function renderSplash(sr: number): Float32Array {
  const o = new Float32Array(Math.ceil(sr * 1.05));
  phisem(o, sr, grf(0.003, 0.2, 0.15, 0.6, 0.05, 0.3), 9000, 0.97, [res(900, 0.5), res(2000, 0.55), res(3800, 0.5, 0.5)], 1);
  swish(o, sr, 0.01, 0.02, 0.18, 220, 0.8, 0.25); // the plunge has real low end, kept modest
  for (let i = 0; i < 16; i++) bubble(o, sr, rr(0.04, 0.7), rr(300, 1200), rr(0.03, 0.07), rr(0.04, 0.1));
  return finish(o, sr, 90, 6000, 0.95);
}

/**
 * Underwater, moving: everything is dull and round. A slow, low push of water past the ears and,
 * now and then, one or two deep bubbles. Low-passed hard (sound in water reaches the ear through
 * the skull: highs are gone).
 */
function renderUnderStroke(sr: number): Float32Array {
  const o = new Float32Array(Math.ceil(sr * 1.1));
  swish(o, sr, 0, 0.3, 0.35, rr(180, 260), 0.5, 1);
  swish(o, sr, 0.1, 0.25, 0.3, rr(380, 480), 0.6, 0.25);
  for (let i = 0, n = Math.floor(R() * 3); i < n; i++) bubble(o, sr, rr(0.2, 0.8), rr(170, 320), rr(0.08, 0.14), rr(0.04, 0.07));
  return finish(o, sr, 50, 650, 0.7);
}

/** Exhaled bubbles rising past the face: deep, round and soft. */
function renderExhale(sr: number): Float32Array {
  const o = new Float32Array(Math.ceil(sr * 1.3));
  const n = 7 + Math.floor(R() * 6);
  for (let i = 0; i < n; i++) bubble(o, sr, Math.max(0, (i / n) * 1.0 + rr(-0.04, 0.04)), rr(170, 380) * (1 + (i / n) * 0.3), rr(0.06, 0.12), rr(0.12, 0.22));
  return finish(o, sr, 60, 900, 0.6);
}

/** Pressure-like underwater bed: deep slow rumble (looped; underwater the low end is real). */
function renderUnderBed(sr: number): Float32Array {
  const len = Math.floor(sr * 4);
  const o = new Float32Array(len);
  let b = 0;
  for (let i = 0; i < len; i++) {
    b = (b + (R() * 2 - 1) * 0.02) * 0.995; // brown noise
    o[i] = b;
  }
  biquad(o, sr, 'lp', 160);
  biquad(o, sr, 'hp', 25);
  let max = 0;
  for (let i = 0; i < len; i++) max = Math.max(max, Math.abs(o[i]));
  const k = max > 0 ? 0.8 / max : 1;
  // Crossfade the ends so the loop is seamless
  const fade = Math.floor(sr * 0.25);
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    o[i] = o[i] * w + o[len - fade + i] * (1 - w);
  }
  for (let i = 0; i < len; i++) o[i] *= k;
  return o.subarray(0, len - fade);
}

function render(kind: Kind, sr: number): Float32Array {
  switch (kind) {
    case 'wet': return renderWet(sr);
    case 'stroke': return renderStroke(sr);
    case 'lap': return renderLap(sr);
    case 'splash': return renderSplash(sr);
    case 'under': return renderUnderStroke(sr);
    case 'exhale': return renderExhale(sr);
    default: return renderStep(sr, kind);
  }
}

/** Shared `onended`: no closure per sound. Finished sources leave the graph and get collected. */
function releaseSource(this: AudioBufferSourceNode): void {
  this.disconnect();
}

interface VoicePool { gains: GainNode[]; next: number }

export class FootstepAudio {
  private readonly cache = new Map<Kind, AudioBuffer[]>();
  /** Last variant per kind (never the same take twice in a row). */
  private readonly last: Record<Kind, number> = Object.fromEntries(WARM_ORDER.map((k) => [k, -1])) as Record<Kind, number>;
  private readonly pools: Partial<Record<AudioChannel, VoicePool>> = {};
  private bed: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private bedBuffer: AudioBuffer | null = null;
  private strokeTimer = 0;
  private lapTimer = 2;
  private exhaleTimer = 3;
  private wasUnder = false;
  private warmIndex = -1;

  /** One footstep. `intensity` ~0.35 sneaking, 0.6 walking, 1 running, >1 landing. `wet` 0..1 rain-soaked ground. */
  public step(surface: FootSurface, intensity: number, wet = 0): void {
    const g = 0.32 * intensity * SURFACE_GAIN[surface];
    // Running lands harder: a touch brighter
    this.play(surface, g, rr(0.94, 1.06) * (intensity > 0.9 ? 1.04 : 1), false);
    if (wet > 0.15 && surface !== 'water' && surface !== 'snow') this.play('wet', g * 0.5 * wet, rr(0.9, 1.1), false);
  }

  /** Big entry splash (jump / fall into water); `impact` = vertical speed (m/s). */
  public splash(impact: number): void {
    this.play('splash', Math.min(1, 0.25 + impact * 0.07), rr(0.92, 1.05), false);
  }

  /** Per frame: swim strokes, lapping water, bubbles and the underwater bed (positional args: no per-frame objects). */
  public updateSwim(dt: number, swimming: boolean, underwater: boolean, speed: number): void {
    const ctx = audioEngine.context;
    if (!ctx) return;
    if (this.warmIndex < 0) {
      this.warmIndex = 0;
      this.warmNext(ctx);
    }
    // Head goes under: a muffled plunge; comes up: water running off
    if (underwater && !this.wasUnder) this.play('under', 0.22, 0.85, true);
    if (!underwater && this.wasUnder && swimming) this.play('lap', 0.22, 1.05, false);
    this.wasUnder = underwater;

    if (swimming) {
      const moving = speed > 0.4;
      this.strokeTimer -= dt;
      if (moving && this.strokeTimer <= 0) {
        // Faster swimming = quicker, harder strokes
        const k = Math.min(speed / 4, 1);
        // Underwater strokes are slower, glide longer and stay quiet; at the surface they sit at
        // about the level of footsteps on wood
        this.strokeTimer = (0.9 - k * 0.35 + rr(-0.06, 0.06)) * (underwater ? 1.4 : 1);
        if (underwater) this.play('under', 0.14 + k * 0.08, rr(0.92, 1.05), true);
        else this.play('stroke', 0.2 + k * 0.12, rr(0.94, 1.06), false);
      } else if (!moving) {
        this.strokeTimer = Math.min(this.strokeTimer, 0.15);
      }
      if (!underwater && !moving) {
        this.lapTimer -= dt;
        if (this.lapTimer <= 0) {
          this.lapTimer = rr(1.6, 3.2);
          this.play('lap', rr(0.1, 0.15), rr(0.92, 1.06), false);
        }
      }
      if (underwater) {
        this.exhaleTimer -= dt;
        if (this.exhaleTimer <= 0) {
          this.exhaleTimer = rr(3.5, 7);
          this.play('exhale', 0.2, rr(0.92, 1.08), true);
        }
      } else {
        this.exhaleTimer = rr(1.5, 3);
      }
    }

    // Underwater bed only exists while the head is under (started / freed on the transitions)
    if (underwater && !this.bed) {
      const out = audioEngine.channel('sfxDry');
      if (out) {
        const src = ctx.createBufferSource();
        src.buffer = this.loopBuffer(ctx);
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.gain.setTargetAtTime(0.16, ctx.currentTime, 0.4);
        src.connect(gain).connect(out);
        src.start(0, R() * 2);
        this.bed = { src, gain };
      }
    } else if (!underwater && this.bed) {
      const { src, gain } = this.bed;
      this.bed = null;
      gain.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
      src.stop(ctx.currentTime + 0.7);
      src.onended = () => {
        src.disconnect();
        gain.disconnect();
      };
    }
  }

  /** Renders the next uncached sound when the browser is idle, until all exist. */
  private warmNext(ctx: BaseAudioContext): void {
    if (this.warmIndex >= WARM_ORDER.length) return;
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const run = () => {
      this.buffers(ctx, WARM_ORDER[this.warmIndex]);
      this.warmIndex++;
      this.warmNext(ctx);
    };
    if (idle) idle(run, { timeout: 2000 });
    else setTimeout(run, 60);
  }

  private loopBuffer(ctx: AudioContext): AudioBuffer {
    if (this.bedBuffer) return this.bedBuffer;
    // Only a deep rumble: a low rate is enough
    const data = renderUnderBed(8000);
    const buf = ctx.createBuffer(1, data.length, 8000);
    buf.copyToChannel(data, 0);
    return (this.bedBuffer = buf);
  }

  private buffers(ctx: BaseAudioContext, kind: Kind): AudioBuffer[] {
    let list = this.cache.get(kind);
    if (list) return list;
    list = [];
    const count = kind === 'splash' || kind === 'exhale' ? VARIANTS_LONG : VARIANTS;
    for (let i = 0; i < count; i++) {
      const data = render(kind, SYNTH_RATE);
      const buf = ctx.createBuffer(1, data.length, SYNTH_RATE);
      buf.copyToChannel(data, 0);
      list.push(buf);
    }
    this.cache.set(kind, list);
    return list;
  }

  /** Fixed ring of gains feeding a channel, created once (round-robin, a voice is reused ~2 s later at the earliest). */
  private pool(ctx: AudioContext, ch: AudioChannel): VoicePool | null {
    let p = this.pools[ch];
    if (p) return p;
    const out = audioEngine.channel(ch);
    if (!out) return null;
    p = { gains: [], next: 0 };
    for (let i = 0; i < VOICES; i++) {
      const g = ctx.createGain();
      g.connect(out);
      p.gains.push(g);
    }
    return (this.pools[ch] = p);
  }

  /** `dry`: bypasses the underwater muffle (sounds the player hears inside the water). */
  private play(kind: Kind, gain: number, rate: number, dry: boolean): void {
    const ctx = audioEngine.context;
    if (!ctx || gain <= 0.001) return;
    const pool = this.pool(ctx, dry ? 'sfxDry' : 'sfx');
    if (!pool) return;
    const list = this.buffers(ctx, kind);
    let i = Math.floor(R() * list.length);
    if (i === this.last[kind]) i = (i + 1) % list.length;
    this.last[kind] = i;
    const voice = pool.gains[pool.next];
    pool.next = (pool.next + 1) % pool.gains.length;
    voice.gain.value = gain * rr(0.88, 1.08);
    const src = ctx.createBufferSource();
    src.buffer = list[i];
    src.playbackRate.value = rate;
    src.connect(voice);
    src.onended = releaseSource;
    src.start();
  }
}
