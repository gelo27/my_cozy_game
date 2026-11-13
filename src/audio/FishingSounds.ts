import { audioEngine } from './AudioEngine';
import { render as renderFootstep } from './FootstepSynth';

/**
 * Sounds of the fishing rod. Each one is a recorded sample when the file is there
 * (public/sounds/fishing/<file>.ogg, .mp3 as a second try), otherwise a stand-in rendered once
 * into a buffer: playing either costs one buffer source, one gain and one panner, nothing is
 * synthesised per play. Variety comes from small random pitch / level changes.
 *
 * Files looked for (short mono clips, ~44.1 kHz; any length the clip needs):
 *   cast_whoosh   rod swish on the cast
 *   bobber_splash float landing on the water
 *   spool_tick    ONE soft tick of the spool turning: line paying out on the cast and winding in
 *   nibble_plip   tiny dip of the float when a fish tastes the bait
 *   bite_splash   fish on: the line twangs taut as the float is yanked under
 *   fish_thrash   a hooked fish jerking the taut line (a short twang)
 *   snag_tug      hook tugging at a snagged weed: wet rustle, small slosh (one tug)
 *   snag_free     hook tearing out of the weed
 *   catch_splash  fish lifted out of the water (by default the wading-step splash)
 */
export type FishingSound = 'cast' | 'splash' | 'spool' | 'plip' | 'bite' | 'thrash' | 'snagTug' | 'snagFree' | 'catch';

const FILES: Record<FishingSound, string> = {
  cast: 'cast_whoosh',
  splash: 'bobber_splash',
  spool: 'spool_tick',
  plip: 'nibble_plip',
  bite: 'bite_splash',
  thrash: 'fish_thrash',
  snagTug: 'snag_tug',
  snagFree: 'snag_free',
  catch: 'catch_splash',
};

interface Pos {
  x: number;
  y: number;
  z: number;
}

// ------------------------------------------------------------------ stand-in renderers (run once)

type Render = (sr: number) => Float32Array;

/** Seeded noise, so the stand-ins sound the same every session. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** State-variable filter over a buffer: band-pass with a moving centre (Hz per sample). */
function bandpass(x: Float32Array, sr: number, freq: (i: number) => number, q: number): Float32Array {
  const out = new Float32Array(x.length);
  let low = 0, band = 0;
  const damp = 1 / q;
  for (let i = 0; i < x.length; i++) {
    const f = 2 * Math.sin((Math.PI * Math.min(freq(i), sr * 0.45)) / sr);
    const high = x[i] - low - damp * band;
    band += f * high;
    low += f * band;
    out[i] = band;
  }
  return out;
}

function lowpass(x: Float32Array, sr: number, hz: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y += (x[i] - y) * a;
    x[i] = y;
  }
  return x;
}

function normalize(x: Float32Array, peak = 0.9): Float32Array {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  // Fades: a tiny one in (keeps the attack of clicks crisp), a longer one out (no click at the end)
  const fi = Math.min(6, x.length >> 3);
  for (let i = 0; i < fi; i++) x[i] *= i / fi;
  const fo = Math.min(64, x.length >> 2);
  for (let i = 0; i < fo; i++) x[x.length - 1 - i] *= i / fo;
  return x;
}

/**
 * A taut fishing line as a physical string (Karplus-Strong): a delay line one period long, fed
 * by `drive` (a pluck, or noise rubbing it), losing a little and getting a little duller on every
 * trip. That is how a real string rings, so it has none of the "pure sine" sound of additive tones.
 * `freq(t)` may slide (the delay is read with linear interpolation); `t60` seconds to die by 60 dB;
 * `bright` 0..1 how much top end survives each period (nylon line is dull: ~0.3-0.6).
 */
function lineString(sr: number, len: number, freq: (t: number) => number, t60: number, bright: number, drive: Float32Array): Float32Array {
  const n = Math.floor(sr * len);
  const out = new Float32Array(n);
  const size = 4096;
  const buf = new Float32Array(size);
  let w = 0;
  let prev = 0;
  const s = 0.5 + 0.5 * (1 - bright); // loop low-pass: 0.5 = brightest averaging filter
  for (let i = 0; i < n; i++) {
    const f = freq(i / sr);
    const d = Math.min(size - 2, sr / f);
    const rp = w - d;
    const i0 = Math.floor(rp);
    const fr = rp - i0;
    const a = buf[(i0 + size) & (size - 1)];
    const b = buf[(i0 + 1 + size) & (size - 1)];
    const y = a + (b - a) * fr;
    const g = Math.pow(10, -3 / (f * t60));
    const lp = s * y + (1 - s) * prev;
    prev = y;
    buf[w] = lp * g + (i < drive.length ? drive[i] : 0);
    out[i] = y;
    w = (w + 1) & (size - 1);
  }
  return out;
}

/** A pluck to drive `lineString`: a short burst of noise, softened, picked off-centre. */
function pluck(sr: number, period: number, soft: number, seed: number): Float32Array {
  const n = Math.max(8, Math.floor(sr * period));
  const r = rng(seed);
  const x = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += (r() - lp) * (1 - soft);
    x[i] = lp;
  }
  // Pick position: subtracting a delayed copy notches harmonics like plucking near the end
  const k = Math.floor(n * 0.18);
  for (let i = n - 1; i >= k; i--) x[i] -= x[i - k];
  return x;
}

/** Water hit: a "plop" (bubble cavity: a falling sine) plus spray (decaying, darkening noise). */
function splashLike(sr: number, len: number, plopHz: number, plopLen: number, spray: number, seed: number, drips = 0): Float32Array {
  const n = Math.floor(sr * len);
  const r = rng(seed);
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    noise[i] = r() * Math.exp(-t * (7 / len)) * (1 - Math.exp(-t * 400));
  }
  const sprayed = bandpass(noise, sr, (i) => 4200 * Math.exp((-i / sr) * 5) + 700, 0.8);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = plopHz * (0.55 + 0.45 * Math.exp(-t * 18)) * (1 + 0.6 * Math.exp(-t * 60));
    ph += (2 * Math.PI * f) / sr;
    const plop = Math.sin(ph) * Math.exp(-t / plopLen) * (1 - Math.exp(-t * 900));
    out[i] = plop * 0.8 + sprayed[i] * spray;
  }
  // Drops falling back: little rising bubble chirps
  for (let d = 0; d < drips; d++) {
    const t0 = 0.08 + Math.abs(r()) * (len - 0.15);
    const hz = 900 + Math.abs(r()) * 900;
    const i0 = Math.floor(t0 * sr);
    let p = 0;
    for (let i = 0; i < sr * 0.045 && i0 + i < n; i++) {
      const t = i / sr;
      p += (2 * Math.PI * hz * (1 + t * 14)) / sr;
      out[i0 + i] += Math.sin(p) * Math.exp(-t * 90) * 0.35;
    }
  }
  return normalize(out);
}

const RENDER: Record<FishingSound, Render> = {
  cast: (sr) => {
    // A rod whipped forward: the swish swells fast to the whip and dies off, the band sliding
    // up and back down (the tip passing the ear), a thin whistle of the blank, then line hiss
    const len = 0.6;
    const n = Math.floor(sr * len);
    const r = rng(12);
    const x = new Float32Array(n);
    const peak = 0.3;
    const env = (t: number) => (t < peak ? Math.pow(t / peak, 2.4) : Math.exp(-(t - peak) * 9));
    for (let i = 0; i < n; i++) x[i] = r() * env(i / sr);
    const band = (i: number) => {
      const t = i / sr;
      const d = (t - peak) / 0.09;
      return 700 + 2600 * Math.exp(-d * d);
    };
    const body = bandpass(x, sr, band, 1.6);
    const air = bandpass(x, sr, (i) => band(i) * 2.2, 3.5);
    const out = new Float32Array(n);
    let ph = 0;
    const r2 = rng(13);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      // Blank whistle: a faint, wavering tone riding the swell
      const d = (t - peak) / 0.07;
      ph += (2 * Math.PI * (1350 - (t - peak) * 900 + r2() * 30)) / sr;
      const whistle = Math.sin(ph) * Math.exp(-d * d) * 0.12;
      // Line running off the guides after the whip
      const hiss = t > peak ? r2() * 0.05 * Math.exp(-(t - peak) * 5) : 0;
      out[i] = body[i] + air[i] * 0.45 + whistle + hiss;
    }
    return normalize(lowpass(out, sr, 9000), 0.8);
  },
  splash: (sr) => {
    // "Bulk": the same drop-into-water plink as the cave pools (CaveAudio.plink): a sine whose
    // trapped bubble rings at a rising pitch, 4 ms attack, gone in 0.2 s
    const f0 = 900;
    const rise = 2.3;
    const riseT = 0.07;
    const decay = 0.2;
    const n = Math.floor(sr * (decay + 0.03));
    const out = new Float32Array(n);
    const floor = Math.log(1e-4);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      ph += (2 * Math.PI * f0 * Math.pow(rise, Math.min(t, riseT) / riseT)) / sr;
      const a = t < 0.004 ? Math.exp(floor * (1 - t / 0.004)) : Math.exp((floor * (t - 0.004)) / (decay - 0.004));
      out[i] = Math.sin(ph) * a;
    }
    return normalize(out, 0.85);
  },
  bite: (sr) => {
    // Fish on: the line snaps taut in one deep twang (pitch jumping up as the tension hits), with
    // the float yanked under the water below it
    const len = 0.75;
    const f = (t: number) => 150 * (1 + 0.1 * (1 - Math.exp(-t * 35)));
    const twang = lineString(sr, len, f, 0.45, 0.55, pluck(sr, 1 / 150, 0.35, 32));
    const pull = splashLike(sr, 0.5, 240, 0.07, 0.7, 31, 2);
    const out = new Float32Array(twang.length);
    for (let i = 0; i < out.length; i++) out[i] = twang[i] + (pull[i] ?? 0) * 0.35;
    return normalize(lowpass(out, sr, 4500), 0.85);
  },
  thrash: (sr) => {
    // The fish jerking on the line: a short, hard tug that twangs the taut string (rubbed, not
    // plucked clean, and quickly damped by the water); pitch varies per play
    const len = 0.3;
    const n = Math.floor(sr * len);
    const r = rng(42);
    const drive = pluck(sr, 1 / 170, 0.3, 43);
    const rub = new Float32Array(Math.floor(sr * 0.06));
    for (let i = 0; i < rub.length; i++) rub[i] = r() * 0.06 * Math.exp((-i / sr) * 40);
    const d = new Float32Array(Math.max(drive.length, rub.length));
    for (let i = 0; i < d.length; i++) d[i] = (drive[i] ?? 0) + (rub[i] ?? 0);
    const tone = lineString(sr, len, (t) => 170 * (1 + 0.06 * (1 - Math.exp(-t * 50))), 0.22, 0.45, d);
    return normalize(lowpass(tone.subarray(0, n), sr, 3800), 0.75);
  },
  // The fish lifted out of the water: the same splash as a foot wading through it
  catch: (sr) => normalize(renderFootstep('water', sr), 0.85),
  plip: (sr) => {
    const n = Math.floor(sr * 0.09);
    const x = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      ph += (2 * Math.PI * (650 + t * 9000)) / sr;
      x[i] = Math.sin(ph) * Math.exp(-t * 55) * (1 - Math.exp(-t * 2000));
    }
    return normalize(x, 0.6);
  },
  spool: (sr) => {
    // Line slipping off a free-spinning spool: a soft, dull tick with a little line hiss
    const n = Math.floor(sr * 0.025);
    const r = rng(91);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = r() * Math.exp((-i / sr) * 600);
    const a = bandpass(x, sr, () => 1700, 3);
    const b = bandpass(x, sr, () => 5200, 1.5);
    for (let i = 0; i < n; i++) a[i] = a[i] + b[i] * 0.35;
    return normalize(a, 0.6);
  },
  snagTug: (sr) => {
    // The line drawn taut against the weed: the string is rubbed (noise fed in for the whole tug,
    // like a stick-slip drag through the stalk) while the tension climbs and the pitch rises
    const len = 0.36;
    const n = Math.floor(sr * len);
    const r = rng(76);
    const rub = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, t * 40) * Math.exp(-Math.max(0, t - 0.08) * 11);
      rub[i] = r() * env * 0.08;
    }
    const kick = pluck(sr, 1 / 130, 0.4, 77);
    for (let i = 0; i < kick.length; i++) rub[i] += kick[i] * 0.6;
    const tone = lineString(sr, len, (t) => 130 + 70 * (1 - Math.exp(-t * 12)), 0.35, 0.4, rub);
    return normalize(lowpass(tone, sr, 3500), 0.7);
  },
  snagFree: (sr) => {
    // The hook tears free: the tension lets go in one clean pluck of the line, the pitch sagging a
    // little as it slackens, ringing out over a light release of water
    const len = 1.0;
    const f = (t: number) => 220 * (1 + 0.08 * Math.exp(-t * 18));
    const ring = lineString(sr, len, f, 0.9, 0.5, pluck(sr, 1 / 220, 0.25, 84));
    const wash = splashLike(sr, 0.4, 420, 0.03, 0.4, 83, 1);
    const out = new Float32Array(ring.length);
    for (let i = 0; i < out.length; i++) out[i] = ring[i] + (wash[i] ?? 0) * 0.2;
    return normalize(lowpass(out, sr, 5000), 0.8);
  },
};

// ------------------------------------------------------------------ player

class FishingSoundBank {
  private readonly buffers = new Map<FishingSound, AudioBuffer>();
  private ctx: AudioContext | null = null;
  /** Next scheduled reel tick (audio clock) and the reel's level while it spins. */
  private reelNext = 0;
  private reelPanner: PannerNode | null = null;
  private spoolNext = 0;
  private spoolPanner: PannerNode | null = null;

  /** Loads (or renders) every sound once the audio context exists. */
  private ensure(ctx: AudioContext): void {
    if (this.ctx === ctx) return;
    this.ctx = ctx;
    this.buffers.clear();
    for (const name of Object.keys(FILES) as FishingSound[]) {
      // The stand-in right away, the recording replaces it once it has loaded
      const data = RENDER[name](ctx.sampleRate);
      const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.copyToChannel(data, 0);
      this.buffers.set(name, buf);
      void this.load(ctx, name);
    }
  }

  private async load(ctx: AudioContext, name: FishingSound): Promise<void> {
    for (const ext of ['ogg', 'mp3']) {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}sounds/fishing/${FILES[name]}.${ext}`);
        if (!res.ok || !(res.headers.get('content-type') ?? '').match(/audio|octet/)) continue;
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        if (this.ctx === ctx) this.buffers.set(name, buf);
        return;
      } catch {
        /* not there / undecodable: keep the stand-in */
      }
    }
  }

  /** Plays `name` at `pos` (world). `vol` 0..1+, `pitch` playback rate. */
  public play(name: FishingSound, pos: Pos, vol = 1, pitch = 1, when = 0): void {
    const ctx = audioEngine.context;
    if (!ctx) return;
    this.ensure(ctx);
    const buf = this.buffers.get(name);
    const panner = audioEngine.createPanner(pos, 4, 40);
    if (!buf || !panner) return;
    this.start(ctx, buf, panner, vol, pitch, when, true);
  }

  private start(ctx: AudioContext, buf: AudioBuffer, out: AudioNode, vol: number, pitch: number, when: number, ownsOut: boolean): void {
    const panner = out;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch * (0.94 + Math.random() * 0.12);
    const g = ctx.createGain();
    g.gain.value = vol * (0.85 + Math.random() * 0.15);
    src.connect(g);
    g.connect(panner);
    const t = Math.max(ctx.currentTime, when);
    src.start(t);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      if (ownsOut) panner.disconnect();
    };
  }

  /**
   * Per frame while reeling: ratchet ticks at a rate following the reel speed (m/s), scheduled a
   * little ahead on the audio clock so they stay even at any frame rate.
   */
  public reel(pos: Pos, speed: number): void {
    const ctx = audioEngine.context;
    if (!ctx) return;
    this.ensure(ctx);
    // One cheap panner for every tick (it is the angler's own reel)
    // The angler's own reel is feedback: it skips the underwater muffle and carries across the whole
    // cast (the camera sits out by the float)
    if (!this.reelPanner || this.reelPanner.context !== ctx) this.reelPanner = audioEngine.createPanner(pos, 18, 60, 'sfxDry', true);
    const panner = this.reelPanner;
    const buf = this.buffers.get('spool'); // the same spool sound as on the cast, just wound the other way
    if (!panner || !buf) return;
    audioEngine.setPannerPos(panner, pos);
    const rate = 8 + speed * 9; // ticks per second
    const now = ctx.currentTime;
    if (this.reelNext < now) this.reelNext = now;
    while (this.reelNext < now + 0.06) {
      this.start(ctx, buf, panner, (0.3 + Math.min(0.25, speed * 0.04)) * (audioEngine.isUnderwater ? 0.8 : 1), 0.85 + Math.min(0.4, speed * 0.05), this.reelNext, false);
      this.reelNext += 1 / rate;
    }
  }

  /** Per frame during the cast: the spool spinning free, ticking faster the faster the line runs out (m/s). */
  public spool(pos: Pos, lineSpeed: number): void {
    const ctx = audioEngine.context;
    if (!ctx) return;
    this.ensure(ctx);
    if (!this.spoolPanner || this.spoolPanner.context !== ctx) this.spoolPanner = audioEngine.createPanner(pos, 12, 50, 'sfx', true);
    const panner = this.spoolPanner;
    const buf = this.buffers.get('spool');
    if (!panner || !buf) return;
    audioEngine.setPannerPos(panner, pos);
    // ~one spool turn per 0.25 m of line, a few ticks per turn
    const rate = Math.min(70, 10 + lineSpeed * 4);
    const vol = 0.18 + Math.min(0.22, lineSpeed * 0.012);
    const now = ctx.currentTime;
    if (this.spoolNext < now) this.spoolNext = now;
    while (this.spoolNext < now + 0.05) {
      this.start(ctx, buf, panner, vol, 0.85 + Math.min(0.4, lineSpeed * 0.02), this.spoolNext, false);
      this.spoolNext += 1 / rate;
    }
  }
}

export const fishingSounds = new FishingSoundBank();
