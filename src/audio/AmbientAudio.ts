import * as THREE from 'three';
import { audioEngine } from './AudioEngine';

/** What the ambience reads from the world each frame. */
export interface AmbientState {
  listener: THREE.Vector3;
  /** 0..1 rain loudness (0 for snow). */
  rain: number;
  /** 0..1 wind loudness (storms, snow). */
  wind: number;
  /** True when a roof or big static collider is above the player: rain sounds muffled. */
  underRoof: boolean;
  /** Nearest burning campfire within earshot, or null. */
  campfire: THREE.Vector3 | null;
  /** Loudest nearby river or waterfall (0..1 before distance falloff), or null. */
  water: { position: THREE.Vector3; loud: number; fall: boolean } | null;
  /** Vehicle engine while the player drives it, or null. */
  engine: { position: THREE.Vector3; speedKmh: number; kind: 'truck' | 'scooter' } | null;
}

/** Seconds of looping noise; long enough that the loop point is not audible. */
const NOISE_SECONDS = 2.5;
/** The campfire falls silent at this distance (m). */
const FIRE_EARSHOT = 14;

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
  private water: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; panner: PannerNode } | null = null;
  private roofMix = 0;

  public update(s: AmbientState): void {
    const ctx = audioEngine.context;
    const bus = audioEngine.bus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;

    // Rain
    if (s.rain > 0.01 && !this.rain) this.rain = this.startRain(ctx, bus);
    if (this.rain) {
      this.roofMix += ((s.underRoof ? 1 : 0) - this.roofMix) * 0.08;
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

    // Rivers babble, waterfalls roar: one panned noise loop at the loudest water within earshot
    if (s.water) {
      if (!this.water) this.water = this.startWater(ctx, s.water.position);
      if (this.water) {
        audioEngine.setPannerPos(this.water.panner, s.water.position);
        this.water.filter.frequency.setTargetAtTime(s.water.fall ? 900 : 1900, t, 0.4);
        this.water.filter.Q.value = s.water.fall ? 0.5 : 0.9;
        this.water.src.playbackRate.setTargetAtTime(s.water.fall ? 0.7 : 1.15, t, 0.4);
        this.water.gain.gain.setTargetAtTime(s.water.loud * (s.water.fall ? 0.55 : 0.28), t, 0.4);
      }
    } else if (this.water) {
      this.stop(this.water.gain, [this.water.src], [this.water.panner]);
      this.water = null;
    }

    // Engine
    if (s.engine) {
      if (!this.engine) this.engine = this.startEngine(ctx, s.engine.position);
      if (this.engine) {
        // A scooter's small two-stroke buzzes about twice as high as the truck
        const scooter = s.engine.kind === 'scooter';
        const k = Math.min(s.engine.speedKmh / (scooter ? 60 : 55), 1);
        const pitch = scooter ? 2.1 : 1;
        this.engine.osc.frequency.setTargetAtTime((48 + k * 95) * pitch, t, 0.12);
        this.engine.sub.frequency.setTargetAtTime((24 + k * 47) * pitch, t, 0.12);
        this.engine.filter.frequency.setTargetAtTime((380 + k * 900) * (scooter ? 1.6 : 1), t, 0.15);
        this.engine.gain.gain.setTargetAtTime((0.04 + k * 0.05) * (scooter ? 0.75 : 1), t, 0.15);
        audioEngine.setPannerPos(this.engine.panner, s.engine.position);
      }
    } else if (this.engine) {
      this.stop(this.engine.gain, [this.engine.osc, this.engine.sub], [this.engine.panner]);
      this.engine = null;
    }
  }

  /** Thunder after a lightning flash: farther strikes rumble later and lower. */
  public thunder(listener: THREE.Vector3): void {
    const ctx = audioEngine.context;
    if (!ctx) return;
    const dist = 150 + Math.random() * 450;
    const a = Math.random() * Math.PI * 2;
    const pos = { x: listener.x + Math.cos(a) * 60, y: listener.y + 25, z: listener.z + Math.sin(a) * 60 };
    const panner = audioEngine.createPanner(pos, 60, 2000);
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
    const peak = 0.9 - dist / 900;
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
    const panner = audioEngine.createPanner(pos, 1.5, FIRE_EARSHOT);
    if (!panner) return null;
    const src = this.loop(ctx, this.getCrackle(ctx));
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 1);
    src.connect(gain).connect(panner);
    src.start();
    return { src, gain, panner };
  }

  private startWater(ctx: AudioContext, pos: THREE.Vector3) {
    const panner = audioEngine.createPanner(pos, 4, 60);
    if (!panner) return null;
    const src = this.loop(ctx, this.getNoise(ctx));
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(panner);
    src.start();
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
