import * as THREE from 'three';
import { audioEngine } from './AudioEngine';

/** What the ambience reads from the world each frame. */
export interface AmbientState {
  listener: THREE.Vector3;
  /** 0..1 rain loudness (0 for snow). */
  rain: number;
  /** 0..1 wind loudness (storms, snow). */
  wind: number;
  /** 0..1 night-time insect ambience (only clear or cloudy nights, outdoors). */
  night: number;
  /** 0..1 daytime birdsong (by weather, time of day and how much forest is around). */
  birds: number;
  /** Multiplier of how often birds sing (1 = default pauses). */
  birdRate: number;
  /** Tree tops near the listener where birds sit and sing from (spatial sources). */
  birdPerches: THREE.Vector3[];
  /** 0..1 gentle breeze (clear/cloudy weather, anywhere outdoors). */
  breeze: number;
  /** True when a roof or big static collider is above the player: rain sounds muffled. */
  underRoof: boolean;
  /** Nearest burning campfire within earshot, or null. */
  campfire: THREE.Vector3 | null;
  /** Nearest river (a point gliding along its centre line, loudness 0..1 before falloff), or null. */
  river: { position: THREE.Vector3; loud: number } | null;
  /** Waterfalls within earshot, each at a fixed spot. */
  falls: { id: string; position: THREE.Vector3; loud: number }[];
  /** Vehicle engine while the player drives it, or null. */
  engine: { position: THREE.Vector3; speedKmh: number; kind: 'truck' | 'scooter' | 'boat' } | null;
}

/** Seconds of looping noise; long enough that the loop point is not audible. */
const NOISE_SECONDS = 2.5;
/** River and waterfall loops fall silent at these distances (m). */
const RIVER_RANGE = 34;
const FALL_RANGE = 64;

interface WaterLoop {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
}

/** The campfire falls silent at this distance (m). */
const FIRE_EARSHOT = 14;

interface CricketVoice {
  osc: OscillatorNode;
  gain: GainNode;
  pan: StereoPannerNode;
  next: number;
  kind: 'chirp' | 'trill';
  period: number;
  pulses: number;
  gap: number;
  vol: number;
}
/** Bird voices, by species index used in birdPhrase. */
export const BIRD_SPECIES = [
  { id: 'tit', label: 'Велика синиця' },
  { id: 'sparrow', label: 'Горобець' },
  { id: 'robin', label: 'Вільшанка' },
] as const;

const BIRDS_KEY = 'farm-bird-species-v2';

/** Which species may sing (developer panel); persisted in localStorage. */
export const birdSpeciesEnabled: boolean[] = (() => {
  const on = BIRD_SPECIES.map(() => true);
  try {
    const data = JSON.parse(localStorage.getItem(BIRDS_KEY) ?? 'null');
    if (Array.isArray(data)) data.forEach((v, i) => { if (i < on.length && typeof v === 'boolean') on[i] = v; });
  } catch { /* defaults */ }
  return on;
})();

export function setBirdSpeciesEnabled(index: number, enabled: boolean): void {
  birdSpeciesEnabled[index] = enabled;
  try {
    localStorage.setItem(BIRDS_KEY, JSON.stringify(birdSpeciesEnabled));
  } catch { /* ignore */ }
}

/** Birds are heard from up to this far (m); full loudness within BIRD_REF. */
const BIRD_RANGE = 70;
const BIRD_REF = 7;

interface BirdTrack {
  next: number;
  /** Phrases feed this: level -> roof/underwater low-pass -> tone -> panner at the bird's tree. */
  input: GainNode;
  level: GainNode;
  filter: BiquadFilterNode;
  panner: PannerNode;
  /** Tree the bird sings from (copied, so the perch list can be rebuilt freely). */
  perch: THREE.Vector3 | null;
  /** Preferred species for this bird, so each one keeps a recognisable voice. */
  species: number[];
  pitch: number;
}
interface Birds {
  tracks: BirdTrack[];
}
interface Crickets {
  gain: GainNode;
  voices: CricketVoice[];
  extra: AudioScheduledSourceNode[];
  filter: BiquadFilterNode;
}

/**
 * Looping ambience built from a couple of shared noise buffers (no files):
 * - rain: band-limited noise around the listener, low-passed hard when a roof is overhead so it
 *   becomes the dull drumming you hear indoors;
 * - wind: slow-modulated low noise for storms and snow;
 * - thunder: a delayed rumble from a random direction after each lightning flash;
 * - campfire: crackle placed at the nearest fire (a PannerNode, only while within earshot);
 * - engine: a filtered sawtooth at the car whose pitch follows its speed.
 * Every loop starts lazily on the first need and only its gain/filter params change per frame.
 */
export class AmbientAudio {
  private noise: AudioBuffer | null = null;
  private crackle: AudioBuffer | null = null;
  private rain: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private wind: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; lfo: OscillatorNode } | null = null;
  private fire: { src: AudioBufferSourceNode; gain: GainNode; panner: PannerNode } | null = null;
  private engine: { osc: OscillatorNode; sub: OscillatorNode; filter: BiquadFilterNode; gain: GainNode; panner: PannerNode } | null = null;
  private water: WaterLoop | null = null;
  private readonly fallLoops = new Map<string, WaterLoop>();
  private roofMix = 0;
  private crickets: Crickets | null = null;
  private birds: Birds | null = null;
  private breeze: { src: AudioBufferSourceNode; hiSrc: AudioBufferSourceNode; gain: GainNode; hiGain: GainNode; lfos: OscillatorNode[] } | null = null;

  public update(s: AmbientState): void {
    const ctx = audioEngine.context;
    const bus = audioEngine.bus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    this.roofMix += ((s.underRoof ? 1 : 0) - this.roofMix) * 0.08;

    // Daytime: a few birds sing now and then; a soft breeze under everything
    const under = audioEngine.isUnderwater;
    if (s.birds > 0.02 && s.birdPerches.length > 0 && !this.birds) this.birds = this.startBirds(ctx, bus);
    if (this.birds) {
      const cut = under ? 220 : 16000 * Math.pow(0.07, this.roofMix);
      // x1.5: the panner's distance falloff takes back roughly that much on average
      const lvl = s.birds * 1.5 * (1 - this.roofMix * 0.72) * (under ? 0.25 : 1);
      for (const tr of this.birds.tracks) {
        tr.filter.frequency.setTargetAtTime(cut, t, 0.15);
        tr.level.gain.setTargetAtTime(lvl, t, 1.5);
      }
      if (s.birds > 0.05) this.updateBirds(ctx, this.birds, t, s);
    }
    if (s.breeze > 0.02 && !this.breeze) this.breeze = this.startBreeze(ctx, bus);
    if (this.breeze) {
      const k = s.breeze * (1 - this.roofMix * 0.72) * (under ? 0.25 : 1);
      this.breeze.gain.gain.setTargetAtTime(k * 0.05, t, 1.5);
      this.breeze.hiGain.gain.setTargetAtTime(k * 0.012, t, 1.5);
    }

    // Night: crickets chirp continuously
    if (s.night > 0.02 && !this.crickets) this.crickets = this.startCrickets(ctx, bus);
    if (this.crickets) {
      this.updateCrickets(this.crickets, t);
      // (under: see above)
      // Indoors the outside world is dull and quiet; underwater it is almost gone
      const cut = under ? 220 : 16000 * Math.pow(0.07, this.roofMix);
      this.crickets.filter.frequency.setTargetAtTime(cut, t, 0.15);
      this.crickets.gain.gain.setTargetAtTime(s.night * 0.5 * (1 - this.roofMix * 0.72) * (under ? 0.25 : 1), t, under ? 0.2 : 1.2);
      if (s.night < 0.02 && this.crickets.gain.gain.value < 0.003) {
        this.stop(this.crickets.gain, [...this.crickets.voices.map((v) => v.osc), ...this.crickets.extra], [this.crickets.gain, this.crickets.filter]);
        this.crickets = null;
      }
    }

    // Rain
    if (s.rain > 0.01 && !this.rain) this.rain = this.startRain(ctx, bus);
    if (this.rain) {
      const cutoff = 4200 * (1 - this.roofMix) + 520 * this.roofMix;
      this.rain.filter.frequency.setTargetAtTime(cutoff, t, 0.1);
      this.rain.gain.gain.setTargetAtTime(s.rain * (0.1 + this.roofMix * 0.03), t, 0.3);
    }

    // Wind
    if (s.wind > 0.01 && !this.wind) this.wind = this.startWind(ctx, bus);
    if (this.wind) this.wind.gain.gain.setTargetAtTime(s.wind * 0.07 * (1 - this.roofMix * 0.6), t, 0.5);

    // Campfire: the loop only exists while a fire is close enough to hear
    if (s.campfire && s.campfire.distanceToSquared(s.listener) < FIRE_EARSHOT * FIRE_EARSHOT) {
      if (!this.fire) this.fire = this.startFire(ctx, s.campfire);
      if (this.fire) audioEngine.setPannerPos(this.fire.panner, s.campfire);
    } else if (this.fire) {
      this.stop(this.fire.gain, [this.fire.src], [this.fire.panner]);
      this.fire = null;
    }

    // Rivers babble: one panned loop that glides along the nearest river
    if (s.river) {
      if (!this.water) this.water = this.startWater(ctx, s.river.position, 1900, 0.9, 1.15, RIVER_RANGE);
      if (this.water) {
        audioEngine.setPannerPos(this.water.panner, s.river.position);
        this.water.gain.gain.setTargetAtTime(s.river.loud * 0.28, t, 0.4);
      }
    } else if (this.water) {
      this.stop(this.water.gain, [this.water.src], [this.water.panner]);
      this.water = null;
    }

    // Waterfalls roar from where they land: a loop per fall within earshot, placed once
    for (const f of s.falls) {
      let loop = this.fallLoops.get(f.id);
      if (!loop) {
        const started = this.startWater(ctx, f.position, 900, 0.5, 0.7, FALL_RANGE);
        if (!started) continue;
        this.fallLoops.set(f.id, (loop = started));
      }
      loop.gain.gain.setTargetAtTime(f.loud * 0.55, t, 0.4);
    }
    for (const [id, loop] of this.fallLoops) {
      if (s.falls.some((f) => f.id === id)) continue;
      this.stop(loop.gain, [loop.src], [loop.panner]);
      this.fallLoops.delete(id);
    }

    // Engine
    if (s.engine) {
      if (!this.engine) this.engine = this.startEngine(ctx, s.engine.position);
      if (this.engine) {
        // A scooter's small two-stroke buzzes about twice as high as the truck
        // ...and an outboard sits in between, muffled by the water around its leg
        const scooter = s.engine.kind === 'scooter';
        const boat = s.engine.kind === 'boat';
        const k = Math.min(s.engine.speedKmh / (scooter ? 60 : boat ? 42 : 55), 1);
        const pitch = scooter ? 2.1 : boat ? 1.55 : 1;
        this.engine.osc.frequency.setTargetAtTime((48 + k * 95) * pitch, t, boat ? 0.25 : 0.12);
        this.engine.sub.frequency.setTargetAtTime((24 + k * 47) * pitch, t, boat ? 0.25 : 0.12);
        this.engine.filter.frequency.setTargetAtTime((380 + k * 900) * (scooter ? 1.6 : boat ? 0.85 : 1), t, 0.15);
        this.engine.gain.gain.setTargetAtTime((0.04 + k * 0.05) * (scooter ? 0.75 : boat ? 0.9 : 1), t, 0.15);
        audioEngine.setPannerPos(this.engine.panner, s.engine.position);
      }
    } else if (this.engine) {
      this.stop(this.engine.gain, [this.engine.osc, this.engine.sub], [this.engine.panner]);
      this.engine = null;
    }
  }

  /** Thunder after a lightning flash: farther strikes rumble later and lower. */
  /** A distant rumble, or with `at` a bolt that landed there: a sharp crack, then the roll. */
  public thunder(listener: THREE.Vector3, volume = 1, at?: THREE.Vector3): void {
    const ctx = audioEngine.context;
    if (!ctx || volume <= 0.001) return;
    if (at) this.crack(ctx, listener, at, volume);
    const dist = at ? Math.max(at.distanceTo(listener), 5) : 150 + Math.random() * 450;
    const a = Math.random() * Math.PI * 2;
    const pos = at
      ? { x: at.x, y: at.y + 10, z: at.z }
      : { x: listener.x + Math.cos(a) * 60, y: listener.y + 25, z: listener.z + Math.sin(a) * 60 };
    const panner = audioEngine.createPanner(pos, 60, 2000, 'ambient');
    if (!panner) return;
    const t = ctx.currentTime + dist / 343;
    const src = ctx.createBufferSource();
    src.buffer = this.getNoise(ctx);
    src.playbackRate.value = 0.5;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900 - dist, t);
    filter.frequency.exponentialRampToValueAtTime(120, t + 2.5);
    const gain = ctx.createGain();
    const peak = Math.max(0.001, (0.9 - dist / 900) * volume);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.08);
    gain.gain.setValueAtTime(peak * 0.6, t + 0.4);
    gain.gain.exponentialRampToValueAtTime(peak * 0.8, t + 0.7);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    src.connect(filter).connect(gain).connect(panner);
    src.start(t);
    src.stop(t + 3.3);
    src.onended = () => panner.disconnect();
  }

  /** The snap of a close strike: a short burst of bright noise falling in pitch. */
  private crack(ctx: AudioContext, listener: THREE.Vector3, at: THREE.Vector3, volume: number): void {
    const panner = audioEngine.createPanner({ x: at.x, y: at.y + 2, z: at.z }, 20, 2000, 'ambient');
    if (!panner) return;
    const dist = at.distanceTo(listener);
    const t = ctx.currentTime + dist / 343;
    const src = ctx.createBufferSource();
    src.buffer = this.getNoise(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(7000, t);
    filter.frequency.exponentialRampToValueAtTime(300, t + 0.9);
    const gain = ctx.createGain();
    const peak = Math.max(0.001, Math.min(1.4, 1.6 - dist / 40) * volume);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(peak * 0.25, t + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    src.connect(filter).connect(gain).connect(panner);
    src.start(t);
    src.stop(t + 1.3);
    src.onended = () => panner.disconnect();
  }

  private startBreeze(ctx: AudioContext, bus: AudioNode) {
    // Low "whoosh" of air plus a faint high rustle of leaves; slow gusts swell both
    const mk = (type: BiquadFilterType, freq: number, q: number, rate: number) => {
      const src = this.loop(ctx, this.getNoise(ctx));
      src.playbackRate.value = rate;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(bus);
      src.start(0, Math.random() * NOISE_SECONDS);
      return { src, f, g };
    };
    const low = mk('bandpass', 380, 0.5, 0.4);
    const hi = mk('bandpass', 2800, 0.8, 0.9);
    const lfos: OscillatorNode[] = [];
    // Gusts: slow incommensurate waves on the band centre, so the sweep never repeats evenly
    const gusts: [number, number, AudioParam][] = [
      [0.06, 140, low.f.frequency],
      [0.17, 80, low.f.frequency],
      [0.11, 600, hi.f.frequency],
    ];
    for (const [rate, depth, target] of gusts) {
      const o = ctx.createOscillator();
      o.frequency.value = rate;
      const og = ctx.createGain();
      og.gain.value = depth;
      o.connect(og).connect(target);
      o.start();
      lfos.push(o);
    }
    return { src: low.src, hiSrc: hi.src, gain: low.g, hiGain: hi.g, lfos };
  }

  private startBirds(ctx: AudioContext, bus: AudioNode): Birds {
    // Faint woodland echo, shared and not positional (the forest reflects from everywhere)
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.32;
    const fb = ctx.createGain();
    fb.gain.value = 0.12;
    const wlp = ctx.createBiquadFilter();
    wlp.type = 'lowpass';
    wlp.frequency.value = 2500;
    const wet = ctx.createGain();
    wet.gain.value = 0.07;
    delay.connect(wlp).connect(fb).connect(delay);
    wlp.connect(wet).connect(bus);
    // species: 0 great tit, 1 sparrow, 2 robin
    const setups: number[][] = [[0, 2], [1, 0], [2, 1], [1, 2], [0, 1], [2, 0]];
    const tracks: BirdTrack[] = [];
    for (const species of setups) {
      const panner = audioEngine.createPanner({ x: 0, y: -1000, z: 0 }, BIRD_REF, BIRD_RANGE, 'ambient', true);
      if (!panner) continue;
      const input = ctx.createGain();
      const level = ctx.createGain();
      level.gain.value = 0;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 16000;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 4500 + Math.random() * 5500;
      input.connect(level).connect(filter).connect(tone).connect(panner);
      level.connect(delay);
      tracks.push({ next: ctx.currentTime + 2 + Math.random() * 8, input, level, filter, panner, perch: null, species, pitch: 0.85 + Math.random() * 0.35 });
    }
    return { tracks };
  }

  private updateBirds(ctx: AudioContext, b: Birds, t: number, s: AmbientState): void {
    const perches = s.birdPerches;
    // A sparse grove holds a bird or two; a deep forest all of them
    const active = Math.min(b.tracks.length, Math.ceil(perches.length / 5));
    const rate = Math.max(0.05, s.birdRate);
    const range2 = (BIRD_RANGE * 0.9) ** 2;
    for (let i = 0; i < b.tracks.length; i++) {
      const tr = b.tracks[i];
      if (t < tr.next) continue;
      if (i >= active || perches.length === 0) {
        tr.next = t + 2 + Math.random() * 4;
        continue;
      }
      // Stay on the same tree, sometimes hop to another one; leave trees the listener walked away from
      if (!tr.perch || Math.random() < 0.3 || tr.perch.distanceToSquared(s.listener) > range2) {
        tr.perch = (tr.perch ?? new THREE.Vector3()).copy(perches[Math.floor(Math.random() * perches.length)]);
        audioEngine.setPannerPos(tr.panner, tr.perch);
      }
      // Only species left switched on: the bird's own first, otherwise any allowed voice
      let pool = tr.species.filter((n) => birdSpeciesEnabled[n]);
      if (pool.length === 0) pool = BIRD_SPECIES.map((_, n) => n).filter((n) => birdSpeciesEnabled[n]);
      if (pool.length === 0) {
        tr.next = t + 3;
        continue;
      }
      const sp = pool[Math.floor(Math.random() * pool.length)];
      const len = this.birdPhrase(ctx, tr, sp, t + 0.05);
      // Long quiet pauses between phrases keep it pleasant rather than annoying
      tr.next = t + len + (3 + Math.random() * (14 - s.birds * 5)) / rate;
    }
  }

  /** Developer panel: one phrase of `species`, flat and close, regardless of weather or forest. */
  public previewBird(species: number): void {
    const ctx = audioEngine.context;
    const out = audioEngine.channel('sfx');
    if (!ctx || !out) return;
    const input = ctx.createGain();
    input.gain.value = 1.2;
    input.connect(out);
    const len = this.birdPhrase(ctx, { input, pitch: 1 } as BirdTrack, species, ctx.currentTime + 0.05);
    setTimeout(() => input.disconnect(), (len + 0.5) * 1000);
  }

  /** Schedules one phrase of one bird; returns its length (s). */
  private birdPhrase(ctx: AudioContext, tr: BirdTrack, species: number, t0: number): number {
    const R = Math.random;
    // Whistle = fundamental + two quiet harmonics; real bird tones are not pure sines
    const oscs = [1, 2, 3].map((m) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      return { o, m };
    });
    const g = ctx.createGain();
    g.gain.value = 0;
    const hg = [1, 0.16, 0.05];
    oscs.forEach(({ o }, i) => {
      const og = ctx.createGain();
      og.gain.value = hg[i];
      o.connect(og).connect(g);
    });
    // Real distance comes from the panner; a little variation per phrase keeps it alive
    const dist = ctx.createGain();
    dist.gain.value = 0.8 + R() * 0.2;
    g.connect(dist).connect(tr.input);
    // Vibrato / warble, retuned per note
    const vib = ctx.createOscillator();
    vib.frequency.value = 25;
    const vg = ctx.createGain();
    vg.gain.value = 0;
    vib.connect(vg);
    for (const { o } of oscs) vg.connect(o.detune);

    const setF = (hz: number, at: number, ramp?: number) => {
      for (const { o, m } of oscs) {
        // Harmonics of the highest calls overshoot the oscillator's range (24 kHz): the browser warns on each
        const f = Math.min(hz * m, 23900);
        if (ramp === undefined) o.frequency.setValueAtTime(f, at);
        else o.frequency.exponentialRampToValueAtTime(f, at + ramp);
      }
    };
    /** shape: 0 straight glide, 1 arch (up then down), 2 hook (down then up) */
    const note = (at: number, dur: number, f0: number, f1: number, vol: number, shape = 0, vibDepth = 6, vibRate = 24) => {
      setF(f0, at);
      if (shape === 1) {
        setF(Math.max(f0, f1) * 1.08, at, dur * 0.45);
        setF(f1, at + dur * 0.45, dur * 0.55);
      } else if (shape === 2) {
        setF(Math.min(f0, f1) * 0.9, at, dur * 0.5);
        setF(f1, at + dur * 0.5, dur * 0.5);
      } else setF(f1, at, dur);
      vg.gain.setValueAtTime(vibDepth, at);
      vib.frequency.setValueAtTime(vibRate, at);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(vol, at + Math.min(0.015, dur * 0.25));
      g.gain.linearRampToValueAtTime(vol * 0.75, at + dur * 0.65);
      g.gain.linearRampToValueAtTime(0.0001, at + dur);
    };
    const p = tr.pitch;
    let t = t0;
    if (species === 0) {
      // Great tit: a sharp, ringing "tea-cher, tea-cher": two-note units repeated
      const hi = (4600 + R() * 600) * p;
      const lo = hi * 0.72;
      const reps = 3 + Math.floor(R() * 4);
      for (let i = 0; i < reps; i++) {
        note(t, 0.09, hi * 1.02, hi * 0.97, 0.05, 0, 3, 30);
        note(t + 0.115, 0.1, lo * 1.04, lo * 0.98, 0.045, 0, 3, 30);
        t += 0.4 + R() * 0.04;
      }
    } else if (species === 1) {
      // House sparrow: scrappy "chirp-chip-cheep" in loose, uneven groups
      const groups = 2 + Math.floor(R() * 3);
      for (let gi = 0; gi < groups; gi++) {
        const n = 2 + Math.floor(R() * 3);
        for (let i = 0; i < n; i++) {
          const base = (2700 + R() * 1500) * p;
          const dur = 0.04 + R() * 0.06;
          note(t, dur, base, base * (0.7 + R() * 0.6), 0.045 + R() * 0.03, R() < 0.6 ? 1 : 2, 8, 30);
          t += dur + 0.05 + R() * 0.08;
        }
        t += 0.15 + R() * 0.5;
      }
    } else {
      // Robin: thin, liquid notes in quick runs, sliding down and up, with a wobbling tail
      const runs = 2 + Math.floor(R() * 2);
      for (let r = 0; r < runs; r++) {
        const n = 4 + Math.floor(R() * 5);
        let base = (3600 + R() * 1800) * p;
        for (let i = 0; i < n; i++) {
          const dur = 0.05 + R() * 0.09;
          base = Math.min(6200, Math.max(2600, base * (0.82 + R() * 0.36)));
          note(t, dur, base, base * (R() < 0.5 ? 0.78 : 1.2), 0.045 + R() * 0.02, Math.floor(R() * 3), 10, 28 + R() * 14);
          t += dur + 0.02 + R() * 0.05;
        }
        t += 0.25 + R() * 0.5;
      }
    }
    const end = t + 0.1;
    for (const { o } of oscs) {
      o.start(t0);
      o.stop(end);
    }
    vib.start(t0);
    vib.stop(end);
    oscs[0].o.onended = () => {
      g.disconnect();
      dist.disconnect();
      vg.disconnect();
    };
    return end - t0;
  }

  private startCrickets(ctx: AudioContext, bus: AudioNode): Crickets {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 16000;
    gain.connect(filter).connect(bus);
    // Quiet night bed: soft rustle of leaves and grass, slowly breathing
    const bed = this.loop(ctx, this.getNoise(ctx));
    bed.playbackRate.value = 0.6;
    const bf = ctx.createBiquadFilter();
    bf.type = 'lowpass';
    bf.frequency.value = 750;
    const bg = ctx.createGain();
    bg.gain.value = 0.1;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lg = ctx.createGain();
    lg.gain.value = 0.06;
    lfo.connect(lg).connect(bg.gain);
    bed.connect(bf).connect(bg).connect(gain);
    bed.start(0, Math.random() * NOISE_SECONDS);
    lfo.start();
    const voices: CricketVoice[] = [];
    for (let i = 0; i < 7; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const vg = ctx.createGain();
      vg.gain.value = 0;
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.random() * 2 - 1;
      osc.connect(vg).connect(pan).connect(gain);
      osc.start();
      const v: CricketVoice = { osc, gain: vg, pan, next: ctx.currentTime + Math.random() * 3, kind: 'chirp', period: 1, pulses: 3, gap: 0.03, vol: 0.1 };
      this.rerollVoice(v);
      voices.push(v);
    }
    return { gain, voices, extra: [bed, lfo], filter };
  }

  /** Gives a voice a new personality: pitch, rhythm and loudness (as if another insect took over). */
  private rerollVoice(v: CricketVoice): void {
    const trill = Math.random() < 0.3;
    v.kind = trill ? 'trill' : 'chirp';
    v.osc.frequency.value = trill ? 3000 + Math.random() * 1200 : 4200 + Math.random() * 1600;
    v.period = trill ? 2 + Math.random() * 3 : 0.5 + Math.random() * 1.1;
    v.pulses = 2 + Math.floor(Math.random() * 4);
    v.gap = 0.028 + Math.random() * 0.016;
    v.vol = (0.03 + Math.random() * 0.07) * (trill ? 0.7 : 1);
    v.pan.pan.value = Math.random() * 2 - 1;
  }

  /** Schedules each voice's next chirps a little ahead, so the pattern never loops. */
  private updateCrickets(c: Crickets, t: number): void {
    for (const v of c.voices) {
      while (v.next < t + 0.4) {
        const g = v.gain.gain;
        const s = Math.max(v.next, t);
        let end = s;
        if (v.kind === 'chirp') {
          // Short pulses (~14 ms) in a group, slightly louder towards the end of the group
          for (let p = 0; p < v.pulses; p++) {
            const ps = s + p * v.gap;
            const a = v.vol * (0.7 + 0.3 * (p / v.pulses));
            g.setValueAtTime(0, ps);
            g.linearRampToValueAtTime(a, ps + 0.005);
            g.linearRampToValueAtTime(0, ps + 0.016);
            end = ps + 0.016;
          }
          v.next = s + v.period * (0.85 + Math.random() * 0.3);
        } else {
          // Trill: a fast buzz of ~45 pulses/s that swells and fades over a second or two
          const dur = 1 + Math.random() * 1.8;
          const n = Math.floor(dur * 45);
          for (let p = 0; p < n; p++) {
            const ps = s + p / 45;
            const env = Math.sin((Math.PI * p) / n);
            g.setValueAtTime(0, ps);
            g.linearRampToValueAtTime(v.vol * 0.6 * env, ps + 0.006);
            g.linearRampToValueAtTime(0, ps + 0.016);
            end = ps + 0.016;
          }
          v.next = s + dur + v.period;
        }
        // Now and then the insect goes quiet or is replaced by another one
        if (Math.random() < 0.12) {
          v.next = end + 2 + Math.random() * 8;
          this.rerollVoice(v);
        }
      }
    }
  }

  // ------------------------------------------------------------------ loops

  private startRain(ctx: AudioContext, bus: AudioNode) {
    const src = this.loop(ctx, this.getNoise(ctx));
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 4200;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(hp).connect(filter).connect(gain).connect(bus);
    src.start();
    return { src, filter, gain };
  }

  private startWind(ctx: AudioContext, bus: AudioNode) {
    const src = this.loop(ctx, this.getNoise(ctx));
    src.playbackRate.value = 0.35;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.7;
    // Slow gusts sweep the band
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 240;
    lfo.connect(lfoGain).connect(filter.frequency);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(bus);
    src.start();
    lfo.start();
    return { src, filter, gain, lfo };
  }

  private startFire(ctx: AudioContext, pos: THREE.Vector3) {
    const panner = audioEngine.createPanner(pos, 1.5, FIRE_EARSHOT, 'ambient');
    if (!panner) return null;
    const src = this.loop(ctx, this.getCrackle(ctx));
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 1);
    src.connect(gain).connect(panner);
    src.start();
    return { src, gain, panner };
  }

  /** A band-passed noise loop at a point: higher and brighter for rivers, deep for waterfalls. */
  private startWater(ctx: AudioContext, pos: THREE.Vector3, freq: number, q: number, rate: number, range: number): WaterLoop | null {
    const panner = audioEngine.createPanner(pos, 4, range, 'ambient');
    if (!panner) return null;
    const src = this.loop(ctx, this.getNoise(ctx));
    src.playbackRate.value = rate;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(panner);
    // Each loop starts at its own spot in the shared buffer, so two falls never sound identical
    src.start(0, Math.random() * NOISE_SECONDS);
    return { src, filter, gain, panner };
  }

  private startEngine(ctx: AudioContext, pos: THREE.Vector3) {
    const panner = audioEngine.createPanner(pos, 4, 40);
    if (!panner) return null;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 48;
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = 24;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 380;
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter);
    sub.connect(subGain).connect(filter);
    filter.connect(gain).connect(panner);
    osc.start();
    sub.start();
    return { osc, sub, filter, gain, panner };
  }

  private loop(ctx: AudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    return src;
  }

  /** Fades a loop out, then stops and disconnects it. */
  private stop(gain: GainNode, sources: AudioScheduledSourceNode[], nodes: AudioNode[]): void {
    const ctx = audioEngine.context;
    if (!ctx) return;
    gain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    const end = ctx.currentTime + 0.8;
    for (const s of sources) s.stop(end);
    sources[0].onended = () => nodes.forEach((n) => n.disconnect());
  }

  private getNoise(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Pinkish noise (Paul Kellet's economy filter) sounds like rain rather than hiss
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
    }
    // Crossfade the ends so the loop is seamless
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] = d[i] * k + d[len - fade + i] * (1 - k);
    }
    this.noise = buf;
    return buf;
  }

  private getCrackle(ctx: AudioContext): AudioBuffer {
    if (this.crackle) return this.crackle;
    const len = Math.floor(ctx.sampleRate * 3);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Soft low roar of the flames
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp = lp * 0.97 + (Math.random() * 2 - 1) * 0.03;
      d[i] = lp * 0.6;
    }
    // Random pops and snaps
    const pops = 55;
    for (let p = 0; p < pops; p++) {
      const start = Math.floor(Math.random() * (len - 2000));
      const size = 80 + Math.floor(Math.random() * 900);
      const amp = 0.15 + Math.random() * 0.55;
      for (let i = 0; i < size; i++) d[start + i] += (Math.random() * 2 - 1) * amp * Math.exp((-i / size) * 6);
    }
    this.crackle = buf;
    return buf;
  }
}
