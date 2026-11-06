import * as THREE from 'three';
import { isMobileDevice } from '../world/WorldSettings';
import { userSettings, onUserSettingsChange } from '../config/userSettings';

/** Mixer channels, each with its own volume in the pause menu. */
/** `sfxDry`: effects heard inside the water (after the underwater muffle), e.g. bubbles. */
export type AudioChannel = 'sfx' | 'ambient' | 'music' | 'sfxDry';

export interface SoundPos {
  x: number;
  y: number;
  z: number;
}

/**
 * Procedural sound effects (Web Audio, no files).
 *
 * Spatial: `audioEngine.at(position).playX()` routes that one sound through a PannerNode placed in
 * the world, and the listener follows the camera (updateListener), so chops, building, splashes of
 * the watering can etc. come from where they happen and fade with distance. Calls without `at()`
 * stay flat (UI clicks, inventory). HRTF on desktop, cheaper equal-power panning on phones.
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Player volume after everything else (pause menu "Master"). */
  private volume: GainNode | null = null;
  private readonly channels: Partial<Record<AudioChannel, GainNode>> = {};
  /** Everything is silent while the game is paused. */
  private paused = false;
  private pendingPos: SoundPos | null = null;
  private pendingRef = 0;
  /** Low-pass on the master bus: wide open in air, closes underwater. */
  private muffle: BiquadFilterNode | null = null;
  private underwater = false;
  private readonly listenerPos = new THREE.Vector3();
  private readonly hrtf = !isMobileDevice();
  private static readonly _fwd = new THREE.Vector3();
  private static readonly _up = new THREE.Vector3();

  constructor() {
    // Browsers only allow audio after a gesture: create/resume the context on the first one
    if (typeof window !== 'undefined') {
      const unlock = () => {
        this.init();
        if (this.ctx?.state === 'suspended') this.ctx.resume();
        if (this.ctx?.state === 'running') {
          window.removeEventListener('pointerdown', unlock);
          window.removeEventListener('keydown', unlock);
        }
      };
      window.addEventListener('pointerdown', unlock);
      window.addEventListener('keydown', unlock);

      // Silence everything while the tab is in the background; pick up again when it comes back
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) this.ctx.suspend();
        else this.ctx.resume();
      });
    }
  }

  public init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.muffle = this.ctx.createBiquadFilter();
      this.muffle.type = 'lowpass';
      this.muffle.frequency.value = 20000;
      this.muffle.Q.value = 0.5;
      this.volume = this.ctx.createGain();
      this.master.connect(this.muffle).connect(this.volume).connect(this.ctx.destination);
      for (const ch of ['sfx', 'ambient', 'music', 'sfxDry'] as AudioChannel[]) {
        const g = this.ctx.createGain();
        g.connect(ch === 'sfxDry' ? this.volume : this.master);
        this.channels[ch] = g;
      }
      this.applyVolumes(true);
      onUserSettingsChange(() => this.applyVolumes());
    }
  }

  /** Pushes the pause-menu volumes into the mixer (smoothly, so sliders do not click). */
  private applyVolumes(instant = false): void {
    if (!this.ctx || !this.volume) return;
    const u = userSettings;
    const t = this.ctx.currentTime;
    const set = (g: GainNode | undefined, v: number) => {
      if (!g) return;
      if (instant) g.gain.value = v;
      else g.gain.setTargetAtTime(v, t, 0.05);
    };
    // Squared: a slider feels linear to the ear. Nature sounds are effects too: one slider for both
    const sfx = u.sfxOn ? u.sfx * u.sfx : 0;
    set(this.volume, this.paused ? 0 : u.master * u.master);
    set(this.channels.sfx, sfx);
    set(this.channels.ambient, sfx);
    set(this.channels.sfxDry, sfx);
    set(this.channels.music, u.musicOn ? u.music * u.music : 0);
  }

  /** Pause mutes every channel (quick fade, no click); resuming fades them back in. */
  public setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.applyVolumes();
  }

  /** Input of one mixer channel (null before the first user gesture). */
  public channel(ch: AudioChannel): AudioNode | null {
    return this.channels[ch] ?? null;
  }

  public get isUnderwater(): boolean {
    return this.underwater;
  }

  /** The running audio context, or null before the first user gesture. */
  public get context(): AudioContext | null {
    return this.ctx && this.ctx.state === 'running' ? this.ctx : null;
  }

  /**
   * Places the NEXT play call in the world. `refDistance` is how far (m) the sound keeps its full
   * volume; it halves at roughly twice that.
   */
  public at(pos: SoundPos, refDistance = 3): this {
    this.pendingPos = { x: pos.x, y: pos.y, z: pos.z };
    this.pendingRef = refDistance;
    return this;
  }

  /**
   * A panner at `pos` feeding the master bus (also used by ambient loops). Volume is full up to
   * `refDistance` and falls linearly to silence at `maxDistance`, so far sounds really go quiet.
   */
  /** `cheap`: plain equal-power panning even on desktop (many quiet sources, e.g. birds). */
  public createPanner(pos: SoundPos, refDistance = 3, maxDistance = refDistance * 12, channel: AudioChannel = 'sfx', cheap = false): PannerNode | null {
    const out = this.channels[channel];
    if (!this.ctx || !out) return null;
    const p = this.ctx.createPanner();
    p.panningModel = this.hrtf && !cheap ? 'HRTF' : 'equalpower';
    p.distanceModel = 'linear';
    p.refDistance = refDistance;
    p.maxDistance = maxDistance;
    p.rolloffFactor = 1;
    this.setPannerPos(p, pos);
    p.connect(out);
    return p;
  }

  public setPannerPos(p: PannerNode, pos: SoundPos): void {
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
  }

  /** Flat (non-positional) input of the ambience channel. */
  public get bus(): AudioNode | null {
    return this.channels.ambient ?? null;
  }

  /**
   * Underwater everything turns dull and a bit quieter, like real hearing through water:
   * the master low-pass glides down to ~350 Hz.
   */
  public setUnderwater(underwater: boolean): void {
    if (underwater === this.underwater || !this.ctx || !this.muffle || !this.master) return;
    this.underwater = underwater;
    const t = this.ctx.currentTime;
    this.muffle.frequency.setTargetAtTime(underwater ? 350 : 20000, t, underwater ? 0.06 : 0.15);
    this.master.gain.setTargetAtTime(underwater ? 0.65 : 0.9, t, 0.1);
  }

  /** Moves the listener to the camera. Call once per frame. */
  public updateListener(camera: THREE.Camera): void {
    this.listenerPos.copy(camera.position);
    const ctx = this.context;
    if (!ctx) return;
    const l = ctx.listener;
    const pos = camera.position;
    const fwd = camera.getWorldDirection(AudioEngine._fwd);
    const up = AudioEngine._up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x;
      l.forwardY.value = fwd.y;
      l.forwardZ.value = fwd.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  private reverb: { send: GainNode; conv: ConvolverNode; wet: GainNode; connected: boolean } | null = null;

  /**
   * Room reverb on the effects and ambience (caves): 0 = dry. The convolver is only fed while the
   * mix is up, so above ground it costs nothing; its impulse response is built once, on first use.
   */
  public setReverb(mix: number): void {
    const ctx = this.ctx;
    const sfx = this.channels.sfx, amb = this.channels.ambient;
    if (!ctx || !this.master || !sfx || !amb) return;
    if (mix <= 0.001 && !this.reverb?.connected) return;
    if (!this.reverb) {
      const send = ctx.createGain();
      const conv = ctx.createConvolver();
      conv.buffer = this.makeImpulse(ctx, 2.6);
      const wet = ctx.createGain();
      wet.gain.value = 0;
      send.connect(conv).connect(wet).connect(this.master);
      this.reverb = { send, conv, wet, connected: false };
    }
    const r = this.reverb;
    if (mix > 0.001 && !r.connected) {
      sfx.connect(r.send);
      amb.connect(r.send);
      r.connected = true;
    }
    r.wet.gain.setTargetAtTime(mix, ctx.currentTime, 0.25);
    if (mix <= 0.001 && r.connected && r.wet.gain.value < 0.002) {
      sfx.disconnect(r.send);
      amb.disconnect(r.send);
      r.connected = false;
    }
  }

  /** Stereo decaying noise with a few early reflections, like a rocky hall. */
  private makeImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * 0.5;
      }
      for (const [ms, g] of [[11, 0.5], [23, 0.35], [37, 0.3], [58, 0.22], [83, 0.16]]) {
        const at = Math.floor(((ms + ch * 3) / 1000) * ctx.sampleRate);
        if (at < len) d[at] += g * (ch ? -1 : 1);
      }
    }
    return buf;
  }

  /** Destination for the sound being built: a world panner after at(), else the flat bus. */
  private output(): AudioNode {
    const pos = this.pendingPos;
    this.pendingPos = null;
    if (pos && this.ctx) {
      // Out of earshot: play into a muted node instead of building a panner chain
      const dx = pos.x - this.listenerPos.x, dy = pos.y - this.listenerPos.y, dz = pos.z - this.listenerPos.z;
      const max = this.pendingRef * 12;
      if (dx * dx + dy * dy + dz * dz > max * max) {
        const mute = this.ctx.createGain();
        mute.gain.value = 0;
        return mute;
      }
      const p = this.createPanner(pos, this.pendingRef);
      if (p) {
        // Let the panner be collected once the sound has finished
        setTimeout(() => p.disconnect(), 4000);
        return p;
      }
    }
    return this.channels.sfx ?? this.master ?? this.ctx!.destination;
  }

  public playHitSound() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    // High pitch "tick" for hit marker
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(800, t + 0.05);

    gain.gain.setValueAtTime(0.3, t);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.05);

    osc.connect(gain);
    gain.connect(out);

    osc.start(t);
    osc.stop(t + 0.1);
  }

  /**
   * Zelda BotW style stamina / oxygen low warning pulse
   */
  public playOxygenPulse(critical: boolean = false) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    const startFreq = critical ? 480 : 380;
    const endFreq = critical ? 240 : 280;

    osc.frequency.setValueAtTime(startFreq, t);
    osc.frequency.exponentialRampToValueAtTime(endFreq, t + 0.12);

    const maxGain = critical ? 0.35 : 0.2;
    gain.gain.setValueAtTime(0.01, t);
    gain.gain.linearRampToValueAtTime(maxGain, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + (critical ? 0.22 : 0.16));

    osc.connect(gain);
    gain.connect(out);

    osc.start(t);
    osc.stop(t + 0.25);
  }

  /**
   * Zelda BotW style stamina wheel full replenishment chime
   */
  public playOxygenReplenished() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    
    // Pleasant 2-note ascending harmonic chime
    [880, 1320].forEach((freq, idx) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const noteTime = t + idx * 0.08;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, noteTime);

      gain.gain.setValueAtTime(0.01, noteTime);
      gain.gain.linearRampToValueAtTime(0.18, noteTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.28);

      osc.connect(gain);
      gain.connect(out);

      osc.start(noteTime);
      osc.stop(noteTime + 0.3);
    });
  }

  /**
   * Surfacing breath / gasp sound
   */
  public playSurfacingBreath() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(440, t + 0.18);

    gain.gain.setValueAtTime(0.01, t);
    gain.gain.linearRampToValueAtTime(0.15, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);

    osc.connect(gain);
    gain.connect(out);

    osc.start(t);
    osc.stop(t + 0.28);
  }

  /**
   * Zelda BotW Woodcutter's Axe whoosh swing sound
   */
  public playAxeSwing() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    
    // Filtered noise swoosh + rapid pitch sweep
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.16);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(600, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.16);

    gain.gain.setValueAtTime(0.01, t);
    gain.gain.linearRampToValueAtTime(0.22, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    osc.start(t);
    osc.stop(t + 0.2);
  }

  /**
   * Juicy Zelda BotW woodcutting chop impact (axe biting into tree trunk)
   */
  public playWoodChopHit(isFatal: boolean = false) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;

    // 1. Sharp metallic axe bite "CLANK-THWACK"
    const oscBite = this.ctx.createOscillator();
    const gainBite = this.ctx.createGain();
    oscBite.type = 'triangle';
    oscBite.frequency.setValueAtTime(isFatal ? 380 : 320, t);
    oscBite.frequency.exponentialRampToValueAtTime(80, t + 0.08);

    gainBite.gain.setValueAtTime(0.4, t);
    gainBite.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    oscBite.connect(gainBite);
    gainBite.connect(out);
    oscBite.start(t);
    oscBite.stop(t + 0.13);

    // 2. Heavy wooden body resonance "THUD"
    const oscWood = this.ctx.createOscillator();
    const gainWood = this.ctx.createGain();
    oscWood.type = 'sine';
    oscWood.frequency.setValueAtTime(isFatal ? 110 : 135, t);
    oscWood.frequency.exponentialRampToValueAtTime(40, t + 0.2);

    gainWood.gain.setValueAtTime(0.55, t);
    gainWood.gain.exponentialRampToValueAtTime(0.001, t + 0.22);

    oscWood.connect(gainWood);
    gainWood.connect(out);
    oscWood.start(t);
    oscWood.stop(t + 0.23);

    // 3. Splinter crack (noise burst)
    const bufferSize = this.ctx.sampleRate * 0.06;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
    const whiteNoise = this.ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;

    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = isFatal ? 2200 : 1800;
    noiseFilter.Q.value = 3.0;

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.35, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);

    whiteNoise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(out);
    whiteNoise.start(t);
  }

  /**
   * Wooden trunk creaking / cracking as the tree starts to topple
   */
  public playTreeFallCreak() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;

    // Dual FM modulated groaning creaks
    const carrier = this.ctx.createOscillator();
    const modulator = this.ctx.createOscillator();
    const modGain = this.ctx.createGain();
    const outGain = this.ctx.createGain();

    carrier.type = 'sawtooth';
    carrier.frequency.setValueAtTime(85, t);
    carrier.frequency.linearRampToValueAtTime(60, t + 0.6);

    modulator.type = 'sine';
    modulator.frequency.setValueAtTime(14, t);
    modulator.frequency.linearRampToValueAtTime(8, t + 0.6);
    modGain.gain.setValueAtTime(45, t);

    modulator.connect(carrier.frequency);

    outGain.gain.setValueAtTime(0.01, t);
    outGain.gain.linearRampToValueAtTime(0.3, t + 0.1);
    outGain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);

    carrier.connect(outGain);
    outGain.connect(out);

    modulator.start(t);
    carrier.start(t);
    modulator.stop(t + 0.75);
    carrier.stop(t + 0.75);
  }

  /**
   * Heavy thud + ground shake impact when fallen tree hits ground
   */
  public playTreeImpact() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;

    // Sub bass impact
    const subOsc = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(90, t);
    subOsc.frequency.exponentialRampToValueAtTime(25, t + 0.4);

    subGain.gain.setValueAtTime(0.7, t);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);

    subOsc.connect(subGain);
    subGain.connect(out);
    subOsc.start(t);
    subOsc.stop(t + 0.5);

    // Leaves rustle whoosh
    const bufferSize = this.ctx.sampleRate * 0.25;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, t);
    filter.frequency.exponentialRampToValueAtTime(250, t + 0.25);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.25, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(out);
    noise.start(t);
  }

  /**
   * Splitting a fallen trunk into wood logs (crisp pop & crack)
   */
  public playLogSplit() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(280, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.1);

    gain.gain.setValueAtTime(0.45, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);

    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  /**
   * Valheim hammer construction thud (satisfying heavy wood or stone placement sound)
   */
  public playBuildPlace(isWood: boolean = true) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;

    // Heavy hammer punch
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = isWood ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(isWood ? 220 : 140, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.14);

    gain.gain.setValueAtTime(0.55, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + 0.2);

    // Wood/Stone clack & texture transient
    const bufferSize = this.ctx.sampleRate * 0.1;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = isWood ? 'bandpass' : 'lowpass';
    filter.frequency.setValueAtTime(isWood ? 1800 : 700, t);
    filter.Q.setValueAtTime(2.0, t);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.35, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(out);
    noise.start(t);
  }

  /**
   * Wooden door opening / closing squeak & latch thud
   */
  public playDoorToggle(isOpen: boolean = true) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;

    // 1. Hinge creak/squeak pitch sweep
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(isOpen ? 180 : 320, t);
    osc.frequency.exponentialRampToValueAtTime(isOpen ? 380 : 120, t + 0.18);

    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);

    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + 0.24);

    // 2. Heavy latch / frame thud
    const subOsc = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    subOsc.type = 'triangle';
    subOsc.frequency.setValueAtTime(isOpen ? 120 : 200, t + 0.05);
    subOsc.frequency.exponentialRampToValueAtTime(40, t + 0.2);

    subGain.gain.setValueAtTime(0.35, t + 0.05);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);

    subOsc.connect(subGain);
    subGain.connect(out);
    subOsc.start(t + 0.05);
    subOsc.stop(t + 0.25);
  }

  /**
   * Snapping sound (crisp magnetic lock clack)
   */
  public playBuildSnap() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1760, t + 0.04);

    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);

    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  /**
   * Demolish / dismantle piece (wood cracking or stone rubble)
   */
  public playBuildDemolish() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(30, t + 0.22);

    gain.gain.setValueAtTime(0.4, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);

    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  /**
   * UI piece selection click
   */
  public playBuildSelect() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(650, t);
    osc.frequency.exponentialRampToValueAtTime(950, t + 0.03);

    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + 0.05);
  }

  /**
   * Cozy Heartopia wallpaper painting brush sound (soft textured stroke + gentle tone)
   */
  public playPaintBrush() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;

    // Harmonic chime note (E5 -> G#5)
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(659.25, t); // E5
    osc.frequency.exponentialRampToValueAtTime(830.61, t + 0.08); // G#5

    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);

    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + 0.15);

    // Soft roller/brush swoosh noise
    const bufferSize = Math.floor(this.ctx.sampleRate * 0.12);
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1400, t);
    filter.Q.setValueAtTime(1.8, t);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.1, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(out);
    noise.start(t);
    noise.stop(t + 0.13);
  }

  /**
   * Cute bubble pop sound for eyedropper sampling
   */
  public playPaintPick() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, t);
    osc.frequency.exponentialRampToValueAtTime(1200, t + 0.07);

    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);

    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  /**
   * Trickling water spray sound for Heartopia watering can
   */
  public playWatering() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    const duration = 0.45;

    // Filtered pinkish noise for water droplets
    const bufferSize = Math.floor(this.ctx.sampleRate * duration);
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.7;
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const bandpass = this.ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime(2200, t);
    bandpass.frequency.linearRampToValueAtTime(1600, t + duration);
    bandpass.Q.setValueAtTime(3.0, t);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.01, t);
    gain.gain.linearRampToValueAtTime(0.25, t + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    noise.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(out);
    noise.start(t);
    noise.stop(t + duration);

    // Subtle harmonic droplet chirp
    const osc = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1400, t);
    osc.frequency.exponentialRampToValueAtTime(900, t + 0.25);
    oscGain.gain.setValueAtTime(0.12, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(oscGain);
    oscGain.connect(out);
    osc.start(t);
    osc.stop(t + 0.26);
  }

  /**
   * Earthy gentle pop / rustle for planting seeds
   */
  public playPlantSeed() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(680, t + 0.12);

    gain.gain.setValueAtTime(0.28, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);

    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  private holdOsc: OscillatorNode | null = null;
  private holdGain: GainNode | null = null;

  /**
   * Soft rising tone that follows a hold-to-act ring while it fills (0..1). Pass null to stop it.
   */
  public setHoldFill(progress: number | null) {
    if (progress === null) {
      if (this.holdOsc && this.holdGain && this.ctx) {
        const t = this.ctx.currentTime;
        const osc = this.holdOsc;
        this.holdGain.gain.cancelScheduledValues(t);
        this.holdGain.gain.setTargetAtTime(0.0001, t, 0.03);
        osc.stop(t + 0.15);
        this.holdOsc = null;
        this.holdGain = null;
      }
      return;
    }
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (!this.holdOsc || !this.holdGain) {
      if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, t);
      osc.connect(gain);
      gain.connect(this.output());
      osc.start(t);
      this.holdOsc = osc;
      this.holdGain = gain;
    }
    const p = Math.min(1, Math.max(0, progress));
    // Pentatonic-ish rise from ~330 Hz to ~990 Hz, a little louder as it fills
    this.holdOsc.frequency.setTargetAtTime(330 * Math.pow(3, p), t, 0.03);
    this.holdGain.gain.setTargetAtTime(0.05 + 0.07 * p, t, 0.04);
  }

  /**
   * Joyful ascending celebration chime for harvesting Heartopia crops
   */
  public playHarvest() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6 major chord

    notes.forEach((freq, idx) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      const noteTime = t + idx * 0.08;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, noteTime);

      gain.gain.setValueAtTime(0.22, noteTime);
      gain.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.35);

      osc.connect(gain);
      gain.connect(out);
      osc.start(noteTime);
      osc.stop(noteTime + 0.36);
    });
  }
}

export const audioEngine = new AudioEngine();

