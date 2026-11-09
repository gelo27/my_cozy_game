import { audioEngine } from './AudioEngine';

/**
 * Wheat rustling as the player (or the moped) wades through a field.
 *
 * Driven by the stalk springs themselves (FieldManager.rustle), not by the walk speed: what is
 * heard is how fast the stalks near the player actually move, so it swells while pushing through,
 * fades to nothing when standing still in the wheat, and leaves a soft tail as the stalks wobble
 * back upright behind you.
 *
 * Model: a stalk clump brushing past is a burst of many tiny collisions (leaves, awns and ears
 * scraping each other and the clothes): PhISEM-style particles whose rate follows the push
 * envelope, each a sub-millisecond noise tick, coloured by the stalks' "size". Ripe, dry wheat is
 * stiff and light: bright (3–7 kHz), crisp, with the ears' seeds rattling as the stalk whips free.
 * Green wheat is soft and wet: a smoother, lower swish (1.5–3.5 kHz) with almost no ticks. Rain
 * soaks the stalks: the crackle goes and everything gets duller.
 *
 * Runtime cost: everything is rendered once (22 kHz mono, in idle slices) into a few short "brush"
 * one-shots and two seamless 2.4 s beds (green / ripe). While in the wheat, two looping sources run
 * through one low-pass and one panner; a brush one-shot plays for each clump a body starts pushing.
 * Outside the fields the beds are stopped: nothing runs at all.
 */

const SR = 22050;
const BED_SECONDS = 2.4;
const BRUSH_VARIANTS = 4;
const VOICES = 8;
/**
 * Stalk energy (summed tip speed, m/s) at which the stalks count as ~63 % "moving". Wading at any
 * pace keeps it around 11–15 (the springs ring whatever the speed), so the loudness itself comes
 * from how fast the body rubs through them (RUB_REF), and this mostly gates and shapes the tail.
 */
const ENERGY_REF = 6;
/** Body speed (m/s) through the stalks that rustles at full strength (a sprint; walking is 4.5). */
const RUB_REF = 7;
/** Rustle left while standing among still-wobbling stalks (fraction of full). */
const RUB_FLOOR = 0.22;
const BED_GAIN = 0.2;
const BRUSH_GAIN = 0.13;
/** Silence (s) after which the beds are stopped. */
const BED_IDLE_STOP = 1.5;

const R = Math.random;
const rr = (a: number, b: number) => a + R() * (b - a);

// ------------------------------------------------------------------ DSP (render time only)

/** RBJ biquad run in place over `x`. */
function biquad(x: Float32Array, type: 'lp' | 'hp' | 'bp', f: number, q = 0.707): void {
  const w = (2 * Math.PI * Math.min(f, SR * 0.45)) / SR;
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

/** Push envelope of one clump: pressed aside (rise), dragged along, then whipping free. */
function pushEnv(t: number, rise: number, hold: number, fall: number): number {
  if (t < 0) return 0;
  if (t < rise) { const k = t / rise; return k * k; }
  if (t < rise + hold) return 1;
  return Math.exp(-(t - rise - hold) / fall);
}

/**
 * Collision texture: at each sample a particle hits with probability `density`·env, adding energy
 * to a noise level that dies within `tickDecay` seconds. Returns a new buffer (not yet coloured).
 */
function particles(n: number, density: number, tickDecay: number, env: (t: number) => number): Float32Array {
  const x = new Float32Array(n);
  const p = density / SR;
  const dec = Math.exp(-1 / (tickDecay * SR));
  let level = 0;
  let e = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 7) === 0) e = env(i / SR);
    if (R() < p * e) level += (0.4 + R()) * e;
    level *= dec;
    x[i] = (R() * 2 - 1) * level;
  }
  return x;
}

/** Smooth noise under an envelope (the broadband swish of many stalks sliding). */
function swish(n: number, env: (t: number) => number): Float32Array {
  const x = new Float32Array(n);
  let e = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 7) === 0) e = env(i / SR);
    x[i] = (R() * 2 - 1) * e;
  }
  return x;
}

function mixInto(out: Float32Array, src: Float32Array, gain: number, at = 0): void {
  // Wraps around the end, so a bed stays seamless when it loops
  const n = out.length;
  for (let i = 0; i < src.length; i++) out[(at + i) % n] += src[i] * gain;
}

/** One clump of stalks brushing past the body. `dry` 0 green .. 1 ripe. */
function brush(dry: number): Float32Array {
  const rise = rr(0.035, 0.08), hold = rr(0.03, 0.09), fall = rr(0.08, 0.15) * (1.3 - dry * 0.4);
  const len = rise + hold + fall * 4;
  const n = Math.ceil(len * SR);
  const env = (t: number) => pushEnv(t, rise, hold, fall);
  const out = new Float32Array(n);

  // Leaves and awns scraping: dense ticks; dry ones are short and sharp, green ones soft and blurred
  const ticks = particles(n, 1800 + dry * 2200, 0.00035 + (1 - dry) * 0.0009, env);
  const t1 = ticks.slice();
  biquad(t1, 'bp', (1900 + dry * 2300) * rr(0.9, 1.1), 1.1);
  biquad(ticks, 'bp', (3600 + dry * 3000) * rr(0.9, 1.1), 1.4);
  mixInto(out, t1, 1.0);
  mixInto(out, ticks, 0.6 + dry * 0.5);

  // The smooth slide of stalks along cloth: broadband, centred lower for soft green wheat
  const s = swish(n, env);
  biquad(s, 'bp', (1300 + dry * 1500) * rr(0.9, 1.15), 0.8);
  biquad(s, 'lp', 5000 + dry * 2500);
  mixInto(out, s, 0.32 + (1 - dry) * 0.35);

  if (dry > 0.4) {
    // The stalk springs free and the ripe ears rattle: a handful of bright seed clicks
    const clicks = Math.round((4 + R() * 8) * dry);
    const c = new Float32Array(n);
    for (let k = 0; k < clicks; k++) {
      const at = Math.floor((rise + hold + R() * fall * 2.2) * SR);
      const a = (0.5 + R()) * Math.exp(-(at / SR - rise - hold) / (fall * 1.5));
      const decay = Math.exp(-1 / (0.0004 * SR));
      let l = a;
      for (let i = at; i < Math.min(n, at + 60); i++) { c[i] += (R() * 2 - 1) * l; l *= decay; }
    }
    biquad(c, 'bp', rr(4500, 6500), 1.6);
    mixInto(out, c, 2.2 * dry);
  }

  // Rustle has no real low end: anything under ~350 Hz would only read as a thump
  biquad(out, 'hp', 350);
  biquad(out, 'hp', 350);
  return out;
}

/**
 * A seamless loop of continuous wading: many overlapping brushes at random times, levels and
 * speeds (stalks come in clusters), written wrap-around so the loop has no seam. Built from the
 * already rendered brush takes (resampled), so it costs a mix, not a fresh synthesis.
 */
function bed(dry: number, takes: Float32Array[]): Float32Array {
  const n = Math.round(BED_SECONDS * SR);
  const out = new Float32Array(n);
  const count = 26;
  for (let k = 0; k < count; k++) {
    const src = takes[(R() * takes.length) | 0];
    const rate = rr(0.85, 1.18);
    const gain = rr(0.35, 1);
    const at = Math.floor(R() * n);
    const len = Math.floor((src.length - 1) / rate);
    for (let i = 0; i < len; i++) {
      const p = i * rate, j = p | 0, f = p - j;
      out[(at + i) % n] += (src[j] + (src[j + 1] - src[j]) * f) * gain;
    }
  }
  // A faint continuous hiss of the stalks further out swaying against each other
  const hiss = swish(n + 2048, () => 1);
  biquad(hiss, 'bp', 2200 + dry * 2000, 0.6);
  biquad(hiss, 'hp', 400);
  // Drop the filter warm-up and crossfade the overshoot into the start, so the hiss loops cleanly
  const fade = 2048;
  for (let i = 0; i < n; i++) {
    let v = hiss[i + fade];
    if (i < fade) {
      const k = i / fade;
      v = v * k + hiss[i + fade + n - fade] * (1 - k);
    }
    out[i] += v * 0.12;
  }
  return out;
}

function normalise(d: Float32Array, peak = 0.95): Float32Array {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m;
  return d;
}

/** Brushes also get a short fade-out so a cut tail never clicks. */
function fadeTail(d: Float32Array): Float32Array {
  const f = Math.min(d.length, Math.floor(0.012 * SR));
  for (let i = d.length - f; i < d.length; i++) d[i] *= (d.length - i) / f;
  return d;
}

type BankKey = 'bedDry' | 'bedGreen' | 'brushDry' | 'brushGreen';
const WARM: BankKey[] = ['brushDry', 'brushGreen', 'bedDry', 'bedGreen'];

/** Shared `onended`: no closure per sound. */
function releaseSource(this: AudioBufferSourceNode): void {
  this.disconnect();
}

interface Bed { src: AudioBufferSourceNode; gain: GainNode }

export class WheatRustle {
  private readonly bank: Partial<Record<BankKey, AudioBuffer[]>> = {};
  /** Raw brush takes, kept to build the beds from. */
  private readonly takes: { brushDry: Float32Array[]; brushGreen: Float32Array[] } = { brushDry: [], brushGreen: [] };
  private warmIndex = -1;
  private warmQueued = false;

  private filter: BiquadFilterNode | null = null;
  private panner: PannerNode | null = null;
  private voices: GainNode[] = [];
  private nextVoice = 0;
  private beds: { dry: Bed; green: Bed } | null = null;
  private readonly pos = { x: 0, y: 0, z: 0 };
  /** Horizontal speed of the listener (m/s), from position steps; smoothed. */
  private speed = 0;
  private moved = 0;
  private hasPos = false;

  private drive = 0;
  private hitCredit = 0;
  private sinceBrush = 1;
  private silentFor = 0;

  /** Where the rustle comes from: the player's legs. */
  public setPosition(x: number, y: number, z: number): void {
    if (this.hasPos) this.moved += Math.hypot(x - this.pos.x, z - this.pos.z);
    this.hasPos = true;
    this.pos.x = x;
    this.pos.y = y;
    this.pos.z = z;
    if (this.panner) audioEngine.setPannerPos(this.panner, this.pos);
  }

  /**
   * Per frame. `energy`, `hits`, `dry` straight from FieldManager.rustle; `wet` 0..1 rain-soaked
   * stalks. Allocates nothing except the one-shot source of a brush.
   */
  public update(dt: number, energy: number, hits: number, dry: number, wet: number): void {
    // How fast the body rubs through the stalks (a teleport / respawn jump is ignored)
    const step = this.moved;
    this.moved = 0;
    const v = dt > 0 ? step / dt : 0;
    if (v < 40) this.speed += (v - this.speed) * (1 - Math.exp(-dt / 0.12));
    const ctx = audioEngine.context;
    if (!ctx) return;
    if (this.warmIndex < 0) {
      this.warmIndex = 0;
      this.warmNext(ctx);
    }

    // Soaked stalks are limp and quiet: no crackle, duller
    const dryness = dry * (1 - 0.75 * wet);
    const rub = Math.min(1.15, RUB_FLOOR + (1 - RUB_FLOOR) * (this.speed / RUB_REF));
    const target = (1 - Math.exp(-energy / ENERGY_REF)) * rub;
    // Fast attack (stalks start moving at once), slower release (they wobble down)
    const tau = target > this.drive ? 0.04 : 0.22;
    this.drive += (target - this.drive) * (1 - Math.exp(-dt / tau));
    const drive = this.drive;

    if (drive < 0.004 && hits <= 0) {
      if (this.beds) {
        this.silentFor += dt;
        this.setBeds(ctx, 0, dryness);
        if (this.silentFor > BED_IDLE_STOP) this.stopBeds(ctx);
      }
      this.hitCredit = 0;
      this.sinceBrush += dt;
      return;
    }
    this.silentFor = 0;
    if (!this.ensureGraph(ctx)) return;

    // Beds: the continuous wading texture, crossfaded by dryness, brisker the faster the stalks move
    if (!this.beds) this.startBeds(ctx);
    this.setBeds(ctx, drive, dryness);
    const t = ctx.currentTime;
    this.filter!.frequency.setTargetAtTime((wet > 0.3 ? 3800 : 9000) * (0.5 + 0.5 * drive), t, 0.08);

    // Brushes: one per clump a body has just started to push (rate-limited so a sprint doesn't machine-gun)
    this.sinceBrush += dt;
    this.hitCredit = Math.min(3, this.hitCredit + hits);
    if (this.hitCredit >= 0.6 && this.sinceBrush > 0.05 + R() * 0.04) {
      const strength = Math.min(1, this.hitCredit);
      this.hitCredit -= Math.max(0.6, strength);
      this.sinceBrush = 0;
      this.brush(ctx, dryness, BRUSH_GAIN * (0.45 + 0.55 * Math.max(drive, strength * 0.6)));
    }
  }

  public dispose(): void {
    const ctx = audioEngine.context;
    if (ctx) this.stopBeds(ctx);
  }

  // ---------------------------------------------------------------- playback

  private ensureGraph(ctx: AudioContext): boolean {
    if (this.filter) return true;
    this.panner = audioEngine.createPanner(this.pos, 4, 50, 'sfx');
    if (!this.panner) return false;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 0.5;
    f.frequency.value = 6000;
    f.connect(this.panner);
    this.filter = f;
    for (let i = 0; i < VOICES; i++) {
      const g = ctx.createGain();
      g.connect(f);
      this.voices.push(g);
    }
    return true;
  }

  private startBeds(ctx: AudioContext): void {
    const make = (key: 'bedDry' | 'bedGreen'): Bed | null => {
      const buf = this.get(ctx, key);
      if (!buf) return null;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain);
      gain.connect(this.filter!);
      // Random start point: re-entering the field never begins on the same texture
      src.start(ctx.currentTime, R() * buf.duration);
      return { src, gain };
    };
    const dry = make('bedDry');
    const green = make('bedGreen');
    if (dry && green) this.beds = { dry, green };
    else {
      // Still rendering (first seconds of a session): brushes carry it meanwhile
      for (const b of [dry, green]) if (b) { b.src.stop(); b.src.disconnect(); b.gain.disconnect(); }
    }
  }

  private setBeds(ctx: AudioContext, drive: number, dryness: number): void {
    const b = this.beds;
    if (!b) return;
    const t = ctx.currentTime;
    // Loudness grows a bit faster than linear with motion: a slow push is barely a whisper
    const level = BED_GAIN * drive * (0.4 + 0.6 * drive);
    b.dry.gain.gain.setTargetAtTime(level * dryness, t, 0.05);
    b.green.gain.gain.setTargetAtTime(level * (1 - dryness) * 0.85, t, 0.05);
    const rate = 0.9 + 0.2 * drive;
    b.dry.src.playbackRate.setTargetAtTime(rate, t, 0.1);
    b.green.src.playbackRate.setTargetAtTime(rate * 0.97, t, 0.1);
  }

  private stopBeds(ctx: AudioContext): void {
    const b = this.beds;
    if (!b) return;
    this.beds = null;
    const t = ctx.currentTime;
    for (const bed of [b.dry, b.green]) {
      bed.gain.gain.setTargetAtTime(0, t, 0.05);
      bed.src.stop(t + 0.3);
      bed.src.onended = () => {
        bed.src.disconnect();
        bed.gain.disconnect();
      };
    }
  }

  private brush(ctx: AudioContext, dryness: number, gain: number): void {
    const key: BankKey = R() < dryness ? 'brushDry' : 'brushGreen';
    const buf = this.get(ctx, key);
    if (!buf || gain < 0.002) return;
    const voice = this.voices[this.nextVoice];
    this.nextVoice = (this.nextVoice + 1) % this.voices.length;
    voice.gain.value = gain * rr(0.8, 1.1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rr(0.88, 1.14);
    src.connect(voice);
    src.onended = releaseSource;
    src.start();
  }

  // ---------------------------------------------------------------- bank

  /** A random variant, or null while it isn't rendered yet (a missing brush is rendered on the spot: one take, a few ms). */
  private get(ctx: BaseAudioContext, key: BankKey): AudioBuffer | null {
    const list = this.bank[key];
    if (list && list.length > 0) return list[(R() * list.length) | 0];
    // Beds are the long renders: leave them to the idle warm-up instead of hitching a frame
    if (key === 'bedDry' || key === 'bedGreen') return null;
    return this.renderOne(ctx, key);
  }

  /** Whether `key` still lacks takes (brushes have several, beds one). */
  private missing(key: BankKey): boolean {
    const want = key === 'brushDry' || key === 'brushGreen' ? BRUSH_VARIANTS : 1;
    return (this.bank[key]?.length ?? 0) < want;
  }

  /** Renders ONE more take of `key` (a bed is built from its brush takes, so those come first). */
  private renderOne(ctx: BaseAudioContext, key: BankKey): AudioBuffer {
    let data: Float32Array;
    if (key === 'brushDry' || key === 'brushGreen') {
      data = fadeTail(normalise(brush(key === 'brushDry' ? rr(0.85, 1) : rr(0, 0.2))));
      this.takes[key].push(data);
    } else {
      const from = key === 'bedDry' ? 'brushDry' : 'brushGreen';
      while (this.missing(from)) this.renderOne(ctx, from);
      data = normalise(bed(key === 'bedDry' ? 1 : 0.1, this.takes[from]), 0.8);
    }
    const buf = ctx.createBuffer(1, data.length, SR);
    buf.copyToChannel(data, 0);
    (this.bank[key] ??= []).push(buf);
    return buf;
  }

  /** Renders the next missing take when the browser is idle, one per slot (each a few ms). */
  private warmNext(ctx: BaseAudioContext): void {
    if (this.warmQueued) return;
    while (this.warmIndex < WARM.length && !this.missing(WARM[this.warmIndex])) this.warmIndex++;
    if (this.warmIndex >= WARM.length) return;
    this.warmQueued = true;
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const run = () => {
      this.warmQueued = false;
      if (this.missing(WARM[this.warmIndex])) this.renderOne(ctx, WARM[this.warmIndex]);
      this.warmNext(ctx);
    };
    if (idle) idle(run, { timeout: 3000 });
    else setTimeout(run, 80);
  }
}
