import * as THREE from 'three';
import { audioEngine } from './AudioEngine';
import { WORLD_HALF } from '../world/WorldSettings';

/** What the shore ambience reads each frame. */
export interface CoastState {
  listener: THREE.Vector3;
  /** Terrain height lookup, its edit revision and the sea level (the coastline is traced from them). */
  height: (x: number, z: number) => number;
  terrainRevision: number;
  waterLevel: number;
  /** Underground: the sea is silent. */
  inCave: boolean;
  /** 0 day .. 1 night (gulls sleep at night). */
  night: number;
  /** 0..1 rain (gulls hide; the surf hisses a little more). */
  rain: number;
  /** 0..1 storm wind: bigger, louder, more frequent breakers. */
  wind: number;
  /** A roof overhead: the sea sounds dull and far. */
  underRoof: boolean;
}

/** Coastline resolution: one shore point per this many radians (≈5 m apart on this island). */
const COAST_POINTS = 256;
/** The surf is only heard close to the water: silent beyond this distance from the waterline (m). Gulls carry farther. */
const SURF_RANGE = 28;
const GULL_RANGE = 170;
/** The two surf voices sit this far along the shore on either side of the closest point (m). */
const SURF_SPREAD = 7;
const GULL_TRACKS = 3;
/** Seconds of the pre-rendered noise and bubble buffers. */
const NOISE_SECONDS = 3;
const BUBBLE_SECONDS = 4;
/** Overall surf loudness (calm sea / storm): kept low so it never masks nearby sounds. */
const SURF_LEVEL = 0.07;
const SURF_STORM_LEVEL = 0.07;
/** A footstep pushes the surf this far down for a moment, so the player's own steps stay on top. */
const STEP_DUCK = 0.45;

interface SurfVoice {
  /** Every lap, wave and fizz of this stretch of shore feeds here. */
  bus: GainNode;
  /** Dips under the player's footsteps (see duck()). */
  duck: GainNode;
  level: GainNode;
  panner: PannerNode;
  /** Next big wave and next small lap (context time). */
  nextWave: number;
  nextLap: number;
  pos: THREE.Vector3;
  target: THREE.Vector3;
}

interface GullTrack {
  input: GainNode;
  level: GainNode;
  muffle: BiquadFilterNode;
  panner: PannerNode;
  next: number;
  /** Centre of the bird's lazy circle over the shore, its radius, phase and height. */
  centre: THREE.Vector3;
  radius: number;
  phase: number;
  pitch: number;
}

const tmpPos = new THREE.Vector3();

/**
 * Sea ambience along the island's shores, all synthesized:
 * - surf: two voices at the closest stretch of coast (to either side of it, so the sea is wide in
 *   stereo) built from short water events, not a filtered noise loop: small laps slapping the sand,
 *   and now and then a wave that sloshes in, breaks in a few splashes and drains back fizzing with
 *   bubbles (a pre-rendered bubble field: upward-chirping resonances, the real sound of water);
 * - gulls: a few birds circling over the waterline near the listener, calling now and then.
 *
 * The coastline is traced once (256 radial marches on the heightmap) and again only when the
 * terrain or sea level change; per frame there is one scan over those points, a few panner moves
 * and a few short-lived nodes per splash scheduled half a second ahead. Nothing runs away from the sea.
 */
export class CoastAudio {
  /** Waterline points (x, z) around the island; NaN where no land was found. */
  private readonly coast = new Float32Array(COAST_POINTS * 2);
  private coastKey = '';
  private coastValid = false;
  private rebuildTimer = 0;
  private noise: AudioBuffer | null = null;
  private bubbles: AudioBuffer | null = null;
  private surf: SurfVoice[] | null = null;
  private gulls: GullTrack[] | null = null;
  private roofMix = 0;
  private scanTimer = 0;
  /** Distance to the waterline and the closest index along the coast (fractional). */
  private shoreDist = Infinity;
  private shoreAt = 0;
  private readonly nearest = new THREE.Vector3();

  public update(s: CoastState, dt: number): void {
    const ctx = audioEngine.context;
    if (!ctx) return;
    this.traceCoast(s, dt);
    this.roofMix += ((s.underRoof ? 1 : 0) - this.roofMix) * Math.min(1, dt * 5);

    // Where the shore is: re-scanned 5x a second, the voices glide after it in between
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = 0.2;
      this.findNearest(s.listener);
    }
    const t = ctx.currentTime;
    const audible = !s.inCave && this.coastValid;

    // ---- surf
    const surfOn = audible && this.shoreDist < SURF_RANGE;
    if (surfOn && !this.surf) this.surf = this.startSurf(ctx);
    if (this.surf) {
      const storm = Math.min(1, s.wind);
      const level = surfOn ? (SURF_LEVEL + storm * SURF_STORM_LEVEL) * (1 - this.roofMix * 0.6) : 0;
      for (let i = 0; i < this.surf.length; i++) {
        const v = this.surf[i];
        // Right at the waterline (a metre out), where the water actually breaks on the sand
        this.pointAlong(this.shoreAt, (i === 0 ? -1 : 1) * SURF_SPREAD, 1, v.target);
        v.target.y = s.waterLevel + 0.2;
        v.pos.lerp(v.target, 1 - Math.exp(-dt * 2));
        audioEngine.setPannerPos(v.panner, v.pos);
        v.level.gain.setTargetAtTime(level, t, 0.6);
        if (surfOn) this.scheduleSurf(ctx, v, t, storm);
      }
      if (!surfOn && this.shoreDist > SURF_RANGE + 8) {
        for (const v of this.surf) {
          v.level.gain.setTargetAtTime(0, t, 0.3);
          const { level: l, panner: p } = v;
          window.setTimeout(() => {
            l.disconnect();
            p.disconnect();
          }, 4000);
        }
        this.surf = null;
      }
    }

    // ---- gulls (daytime, dry weather, near the sea)
    const gullLevel = audible ? (1 - s.night) * (1 - Math.min(1, s.rain * 1.6)) * (1 - Math.min(1, s.wind * 1.2)) : 0;
    const gullsOn = gullLevel > 0.05 && this.shoreDist < GULL_RANGE;
    if (gullsOn && !this.gulls) this.gulls = this.startGulls(ctx, s.waterLevel);
    if (this.gulls) {
      const cut = audioEngine.isUnderwater ? 260 : 15000 * Math.pow(0.08, this.roofMix);
      for (const g of this.gulls) {
        g.level.gain.setTargetAtTime(gullsOn ? gullLevel * 0.9 * (1 - this.roofMix * 0.7) : 0, t, 1.2);
        g.muffle.frequency.setTargetAtTime(cut, t, 0.2);
        // Lazy circles over the waterline
        g.phase += dt * (0.18 + g.radius * 0.004);
        tmpPos.set(g.centre.x + Math.cos(g.phase) * g.radius, g.centre.y + Math.sin(g.phase * 0.7) * 1.5, g.centre.z + Math.sin(g.phase) * g.radius);
        audioEngine.setPannerPos(g.panner, tmpPos);
        if (gullsOn && t >= g.next) {
          // A bird left far behind flies over to the stretch of shore near the listener
          if (g.centre.distanceToSquared(s.listener) > GULL_RANGE * GULL_RANGE * 0.5 || Math.random() < 0.25) this.placeGull(g, s.waterLevel);
          const len = this.gullCall(ctx, g, t + 0.05);
          g.next = t + len + 3 + Math.random() * 11;
        }
      }
      if (!gullsOn && this.shoreDist > GULL_RANGE + 30) {
        for (const g of this.gulls) g.level.disconnect();
        for (const g of this.gulls) g.panner.disconnect();
        this.gulls = null;
      }
    }
  }

  // ------------------------------------------------------------------ coastline

  /** Traces the waterline: from the open sea inward along each ray, the first dry ground. */
  private traceCoast(s: CoastState, dt: number): void {
    this.rebuildTimer -= dt;
    const key = `${s.waterLevel.toFixed(2)}|${s.terrainRevision}`;
    if (key === this.coastKey || (this.coastValid && this.rebuildTimer > 0)) return;
    this.coastKey = key;
    this.rebuildTimer = 5;
    const c = this.coast;
    let found = 0;
    for (let i = 0; i < COAST_POINTS; i++) {
      const a = (i / COAST_POINTS) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      c[i * 2] = NaN;
      c[i * 2 + 1] = NaN;
      for (let r = WORLD_HALF - 2; r > 20; r -= 1) {
        if (s.height(ca * r, sa * r) > s.waterLevel) {
          c[i * 2] = ca * (r + 0.5);
          c[i * 2 + 1] = sa * (r + 0.5);
          found++;
          break;
        }
      }
    }
    this.coastValid = found > COAST_POINTS / 2;
    this.scanTimer = 0;
  }

  private findNearest(p: THREE.Vector3): void {
    const c = this.coast;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < COAST_POINTS; i++) {
      const x = c[i * 2];
      if (Number.isNaN(x)) continue;
      const dx = x - p.x, dz = c[i * 2 + 1] - p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) {
      this.shoreDist = Infinity;
      return;
    }
    // Refine on the two segments around the closest point
    let at = best;
    let dist = Math.sqrt(bestD);
    for (const j of [best - 1, best]) {
      const a = (j + COAST_POINTS) % COAST_POINTS, b = (a + 1) % COAST_POINTS;
      const ax = c[a * 2], az = c[a * 2 + 1], bx = c[b * 2], bz = c[b * 2 + 1];
      if (Number.isNaN(ax) || Number.isNaN(bx)) continue;
      const sx = bx - ax, sz = bz - az;
      const len2 = sx * sx + sz * sz || 1;
      const k = THREE.MathUtils.clamp(((p.x - ax) * sx + (p.z - az) * sz) / len2, 0, 1);
      const d = Math.hypot(ax + sx * k - p.x, az + sz * k - p.z);
      if (d < dist) {
        dist = d;
        at = j + k;
      }
    }
    this.shoreDist = dist;
    this.shoreAt = (at + COAST_POINTS) % COAST_POINTS;
    this.pointAlong(this.shoreAt, 0, 0, this.nearest);
  }

  /** A point `along` metres along the coast from index `at`, pushed `seaward` metres out to sea. */
  private pointAlong(at: number, along: number, seaward: number, out: THREE.Vector3): THREE.Vector3 {
    const c = this.coast;
    let i = Math.floor(at);
    let k = at - i;
    let left = along;
    const dir = Math.sign(along) || 1;
    // Walk segment by segment (≈5 m each), at most half the island
    for (let n = 0; n < COAST_POINTS / 2 && Math.abs(left) > 1e-3; n++) {
      const a = ((i % COAST_POINTS) + COAST_POINTS) % COAST_POINTS, b = (a + 1) % COAST_POINTS;
      const segLen = Math.hypot(c[b * 2] - c[a * 2], c[b * 2 + 1] - c[a * 2 + 1]);
      if (!(segLen > 0)) break;
      const room = dir > 0 ? (1 - k) * segLen : k * segLen;
      if (Math.abs(left) <= room) {
        k += left / segLen;
        left = 0;
        break;
      }
      left -= dir * room;
      if (dir > 0) {
        i++;
        k = 0;
      } else {
        i--;
        k = 1;
      }
    }
    const a = ((i % COAST_POINTS) + COAST_POINTS) % COAST_POINTS, b = (a + 1) % COAST_POINTS;
    let x = c[a * 2] + (c[b * 2] - c[a * 2]) * k;
    let z = c[a * 2 + 1] + (c[b * 2 + 1] - c[a * 2 + 1]) * k;
    if (Number.isNaN(x) || Number.isNaN(z)) {
      x = c[a * 2] || 0;
      z = c[a * 2 + 1] || 0;
    }
    const r = Math.hypot(x, z) || 1;
    return out.set(x + (x / r) * seaward, 0, z + (z / r) * seaward);
  }

  // ------------------------------------------------------------------ surf

  private startSurf(ctx: AudioContext): SurfVoice[] {
    const voices: SurfVoice[] = [];
    for (let i = 0; i < 2; i++) {
      // Full loudness within ~3 m of the water, silent by SURF_RANGE
      const panner = audioEngine.createPanner(this.nearest, 3, SURF_RANGE + SURF_SPREAD, 'ambient');
      if (!panner) break;
      const bus = ctx.createGain();
      const duck = ctx.createGain();
      // Bubbles and splashes stay below ~2.6 kHz: the crunch of sand under the feet lives above it
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 2600;
      tone.Q.value = 0.5;
      const level = ctx.createGain();
      level.gain.value = 0;
      bus.connect(tone).connect(duck).connect(level).connect(panner);
      voices.push({
        bus, duck, level, panner,
        // The two sides wash in out of step with each other
        nextWave: ctx.currentTime + 0.5 + i * (2.5 + Math.random() * 2),
        nextLap: ctx.currentTime + 0.2 + Math.random(),
        pos: this.nearest.clone(),
        target: new THREE.Vector3(),
      });
    }
    return voices;
  }

  /**
   * Schedules the shore half a second ahead: small laps of water slapping the sand every second or
   * so, and every 6-10 s a real wave — the swell sloshing in, a cluster of splashes as it breaks,
   * then the foam fizzing and gurgling as it drains back.
   */
  private scheduleSurf(ctx: AudioContext, v: SurfVoice, t: number, storm: number): void {
    const R = Math.random;
    while (v.nextLap < t + 0.5) {
      const s = Math.max(v.nextLap, t);
      this.lap(ctx, v.bus, s, 0.2 + R() * 0.3 + storm * 0.15);
      v.nextLap = s + 0.35 + R() * 1.3 * (1 - storm * 0.5);
    }
    while (v.nextWave < t + 0.5) {
      const s = Math.max(v.nextWave, t);
      const size = 0.7 + R() * 0.4 + storm * 0.6;
      const rise = 1.1 + R() * 0.8;
      // The swell: a low, soft slosh building up
      this.wash(ctx, v.bus, s, rise + 0.3, 0.16 * size, 160, 520, 0.6);
      // It breaks: a few splashes in quick succession
      const n = 3 + Math.floor(R() * 3 + storm * 3);
      for (let k = 0; k < n; k++) this.lap(ctx, v.bus, s + rise + k * (0.06 + R() * 0.12), Math.min(0.9, size * (0.6 + R() * 0.35)));
      // Foam drains back down the sand: fizzing bubbles under a fading hiss of water
      const drain = 2 + R() * 1.5 + storm;
      this.fizz(ctx, v.bus, s + rise + 0.1, drain, 0.3 * size);
      this.wash(ctx, v.bus, s + rise + 0.15, drain, 0.09 * size, 900, 300, 0.15);
      v.nextWave = s + rise + drain + 2 + R() * 3 * (1 - storm * 0.6);
      // Small laps pause while the wave runs up
      v.nextLap = Math.max(v.nextLap, s + rise + drain * 0.6);
    }
  }

  /** One slap of water on the sand: a short, hollow, mid-low splash with a few bubbles after it. */
  private lap(ctx: AudioContext, out: AudioNode, t: number, vol: number): void {
    const R = Math.random;
    const src = ctx.createBufferSource();
    src.buffer = this.getNoise(ctx);
    src.playbackRate.value = 0.8 + R() * 0.5;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    const f = 300 + R() * 500;
    band.frequency.setValueAtTime(f * 1.6, t);
    band.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.25); // the "plap" falls in pitch
    band.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015 + R() * 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18 + R() * 0.2);
    src.connect(band).connect(g).connect(out);
    src.start(t, R() * (NOISE_SECONDS - 0.6));
    src.stop(t + 0.5);
    src.onended = () => g.disconnect();
    if (R() < 0.7) this.fizz(ctx, out, t + 0.04, 0.25 + R() * 0.4, vol * 0.45);
  }

  /** Bubbles: a slice of the pre-rendered bubble field (real water "sounds" are mostly these). */
  private fizz(ctx: AudioContext, out: AudioNode, t: number, dur: number, vol: number): void {
    const src = ctx.createBufferSource();
    src.buffer = this.getBubbles(ctx);
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.08, dur * 0.2));
    g.gain.setTargetAtTime(0.0001, t + dur * 0.3, dur / 3);
    src.connect(g).connect(out);
    src.start(t, Math.random() * Math.max(0, BUBBLE_SECONDS - dur - 0.5));
    src.stop(t + dur + 0.3);
    src.onended = () => g.disconnect();
  }

  /** A soft body of moving water: low-passed noise swelling or draining, its colour sweeping f0 → f1. */
  private wash(ctx: AudioContext, out: AudioNode, t: number, dur: number, vol: number, f0: number, f1: number, attack: number): void {
    const src = ctx.createBufferSource();
    src.buffer = this.getNoise(ctx);
    src.playbackRate.value = 0.7;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(f0, t);
    lp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + dur * attack);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(out);
    src.start(t, Math.random() * Math.max(0, NOISE_SECONDS - dur));
    if (dur > NOISE_SECONDS - 0.1) src.loop = true;
    src.stop(t + dur + 0.05);
    src.onended = () => g.disconnect();
  }

  /**
   * A field of popping bubbles, rendered once: each bubble rings at its size's resonance and
   * chirps upward as it rises and shrinks (the classic sound of water). Big bubbles are rarer,
   * lower and louder; small ones high, quick and many.
   */
  private getBubbles(ctx: AudioContext): AudioBuffer {
    if (this.bubbles) return this.bubbles;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * BUBBLE_SECONDS);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const count = 1100;
    for (let b = 0; b < count; b++) {
      const size = Math.pow(Math.random(), 2.2); // 0 = tiny, 1 = big
      const f0 = 3800 - size * 3300; // 500 Hz .. 3.8 kHz
      const tau = 0.003 + size * 0.012; // ring time
      const amp = (0.15 + size * 0.85) * (0.4 + Math.random() * 0.6);
      const start = Math.floor(Math.random() * (len - sr * 0.1));
      const n = Math.min(Math.floor(tau * 5 * sr), len - start);
      // Decaying phasor (no sin/exp per sample); its step is re-tuned every 16 samples for the chirp
      const decay = Math.exp(-1 / (tau * sr));
      let re = 0, im = amp, c = 1, s = 0;
      for (let i = 0; i < n; i++) {
        if ((i & 15) === 0) {
          const w = (2 * Math.PI * f0 * (1 + (0.1 * i) / (tau * sr))) / sr; // upward chirp
          c = Math.cos(w) * decay;
          s = Math.sin(w) * decay;
        }
        const nr = re * c - im * s;
        im = re * s + im * c;
        re = nr;
        d[start + i] += im;
      }
    }
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    const k = 0.9 / (peak || 1);
    for (let i = 0; i < len; i++) d[i] *= k;
    this.bubbles = buf;
    return buf;
  }

  /** A footstep of the player: the surf ducks under it briefly (near sounds win, as they do for the ear). */
  public duck(intensity = 1): void {
    const ctx = audioEngine.context;
    if (!ctx || !this.surf) return;
    const t = ctx.currentTime;
    const low = 1 - STEP_DUCK * Math.min(1, intensity);
    for (const v of this.surf) {
      const g = v.duck.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(low, t + 0.03);
      g.setTargetAtTime(1, t + 0.18, 0.25);
    }
  }

  // ------------------------------------------------------------------ gulls

  private startGulls(ctx: AudioContext, waterLevel: number): GullTrack[] {
    const tracks: GullTrack[] = [];
    for (let i = 0; i < GULL_TRACKS; i++) {
      const panner = audioEngine.createPanner(this.nearest, 9, GULL_RANGE, 'ambient', true);
      if (!panner) break;
      const input = ctx.createGain();
      const level = ctx.createGain();
      level.gain.value = 0;
      const muffle = ctx.createBiquadFilter();
      muffle.type = 'lowpass';
      muffle.frequency.value = 15000;
      input.connect(level).connect(muffle).connect(panner);
      const g: GullTrack = {
        input, level, muffle, panner,
        next: ctx.currentTime + 1 + Math.random() * 6 + i * 2,
        centre: new THREE.Vector3(), radius: 0, phase: Math.random() * Math.PI * 2, pitch: 0.88 + Math.random() * 0.25,
      };
      this.placeGull(g, waterLevel);
      tracks.push(g);
    }
    return tracks;
  }

  /** Puts a bird over the waterline within ~70 m of the closest shore point. */
  private placeGull(g: GullTrack, waterLevel: number): void {
    const along = (Math.random() * 2 - 1) * 70;
    this.pointAlong(this.shoreAt, along, -8 + Math.random() * 30, g.centre);
    g.centre.y = waterLevel + 6 + Math.random() * 10;
    g.radius = 4 + Math.random() * 9;
  }

  /** One gull's phrase: a few "kee-ow" mews, sometimes a laughing run. Returns its length (s). */
  private gullCall(ctx: AudioContext, g: GullTrack, t0: number): number {
    const R = Math.random;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    const o2g = ctx.createGain();
    o2g.gain.value = 0.25;
    // A buzzy throat: fast vibrato on both oscillators
    const vib = ctx.createOscillator();
    vib.frequency.value = 28 + R() * 14;
    const vg = ctx.createGain();
    vg.gain.value = 40;
    vib.connect(vg);
    vg.connect(osc.frequency);
    vg.connect(osc2.frequency);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1900 * g.pitch;
    band.Q.value = 1.3;
    const amp = ctx.createGain();
    amp.gain.value = 0;
    osc.connect(band);
    osc2.connect(o2g).connect(band);
    band.connect(amp).connect(g.input);

    const p = g.pitch;
    let t = t0;
    const note = (dur: number, f0: number, fPeak: number, f1: number, vol: number) => {
      for (const [o, m] of [[osc, 1], [osc2, 0.5]] as const) {
        o.frequency.setValueAtTime(f0 * m, t);
        o.frequency.linearRampToValueAtTime(fPeak * m, t + dur * 0.3);
        o.frequency.exponentialRampToValueAtTime(f1 * m, t + dur);
      }
      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.linearRampToValueAtTime(vol, t + dur * 0.12);
      amp.gain.linearRampToValueAtTime(vol * 0.8, t + dur * 0.6);
      amp.gain.linearRampToValueAtTime(0.0001, t + dur);
    };
    if (R() < 0.3) {
      // Laughing run: short notes, falling
      const n = 4 + Math.floor(R() * 5);
      for (let i = 0; i < n; i++) {
        const f = (1250 - i * 45) * p;
        note(0.11 + R() * 0.04, f * 0.85, f * 1.08, f * 0.8, 0.05);
        t += 0.17 + R() * 0.05;
      }
    } else {
      // Long mews: "kee-ow", with pauses
      const n = 1 + Math.floor(R() * 3);
      for (let i = 0; i < n; i++) {
        const dur = 0.32 + R() * 0.22;
        note(dur, 950 * p, 1500 * p, 700 * p, 0.06);
        t += dur + 0.25 + R() * 0.45;
      }
    }
    const end = t + 0.1;
    osc.start(t0);
    osc2.start(t0);
    vib.start(t0);
    osc.stop(end);
    osc2.stop(end);
    vib.stop(end);
    osc.onended = () => {
      amp.disconnect();
      band.disconnect();
      vg.disconnect();
      o2g.disconnect();
    };
    return end - t0;
  }

  // ------------------------------------------------------------------ helpers

  private getNoise(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Brownish noise: deep and soft, like water rather than hiss
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
    const fade = Math.floor(ctx.sampleRate * 0.08);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] = d[i] * k + d[len - fade + i] * (1 - k);
    }
    this.noise = buf;
    return buf;
  }
}
