import { TreeSoundBank, type TreeSoundKind } from './TreeSounds';
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
        if (this.ctx?.state === 'suspended' && !this.paused) this.ctx.resume();
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
        else if (!this.paused) this.ctx.resume();
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
      // Woodcutting sounds are pre-rendered in small idle slices, well before the first chop
      setTimeout(() => this.warmTreeSounds(), 2000);
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
    const ctx = this.ctx;
    if (!ctx) return;
    if (paused) {
      // After the quick fade, stop the whole audio graph: nothing can keep sounding behind the
      // menu (scheduled splashes, loops) and no audio is processed while paused
      window.setTimeout(() => {
        if (this.paused && ctx.state === 'running') void ctx.suspend();
      }, 250);
    } else if (ctx.state === 'suspended' && !document.hidden) {
      void ctx.resume();
    }
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

  private readonly noiseCache = new Map<string, AudioBuffer>();
  /** Noise bursts are rendered once per (length, shape) and reused: filling ~50k samples per hit is garbage and a hitch. */
  private noiseBuffer(seconds: number, decay = false, gain = 1): AudioBuffer {
    const ctx = this.ctx!;
    const key = `${seconds}|${decay}|${gain}|${ctx.sampleRate}`;
    let buf = this.noiseCache.get(key);
    if (!buf) {
      const n = Math.floor(ctx.sampleRate * seconds);
      buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * gain * (decay ? 1 - i / n : 1);
      this.noiseCache.set(key, buf);
    }
    return buf;
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
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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

  /** The axe cutting the air (pre-rendered whoosh). */
  public playAxeSwing() {
    this.playTree('swing', 0.32, 0.1);
  }

  /** The axe biting into a trunk; the felling blow ends in a splintering crack. */
  public playWoodChopHit(isFatal: boolean = false) {
    this.playTree(isFatal ? 'chopFatal' : 'chop', isFatal ? 0.7 : 0.6, 0.08);
  }

  /** The tree going over: hinge crack, a wooden groan with popping fibres, the crown's rush. */
  public playTreeFallCreak() {
    this.playTree('fall', 0.55, 0.06);
  }

  /** The trunk and crown landing: a deep ground thump, a bounce, branches snapping, leaves. */
  public playTreeImpact() {
    this.playTree('impact', 0.9, 0.08);
  }

  /** Splitting a fallen trunk into logs: a dry crack and a hollow knock. */
  public playLogSplit() {
    this.playTree('split', 0.6, 0.08);
  }

  /** A pick striking rock (crystal rings glassy). */
  public playMineHit(crystal = false) {
    this.playTree(crystal ? 'mineCrystal' : 'mine', 0.6, 0.07);
  }

  /** A rock breaking apart into rubble. */
  public playRockBreak() {
    this.playTree('rockBreak', 0.85, 0.08);
  }

  private treeBank: TreeSoundBank | null = null;
  private treeWarm = false;

  /** Renders the woodcutting sounds one variant per idle slice once audio is running. */
  private warmTreeSounds(): void {
    if (this.treeWarm || !this.ctx) return;
    this.treeWarm = true;
    if (!this.treeBank) this.treeBank = new TreeSoundBank(this.ctx);
    const idle: (cb: () => void) => void =
      typeof requestIdleCallback === 'function' ? (cb) => requestIdleCallback(cb, { timeout: 1500 }) : (cb) => setTimeout(cb, 120);
    const step = () => {
      if (this.treeBank?.warmStep()) setTimeout(() => idle(step), 150);
    };
    idle(step);
  }

  /** One pre-rendered woodcutting sound: a single buffer source and gain (cheap on phones). */
  private playTree(kind: TreeSoundKind, gain: number, pitchJitter: number): void {
    const s = this.begin();
    if (!s) return;
    const { ctx, out, t } = s;
    if (!this.treeBank) this.treeBank = new TreeSoundBank(ctx);
    this.warmTreeSounds();
    const src = ctx.createBufferSource();
    src.buffer = this.treeBank.get(kind);
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * pitchJitter;
    const g = ctx.createGain();
    g.gain.value = gain * (0.85 + Math.random() * 0.15);
    src.connect(g).connect(out);
    src.start(t);
  }

  /**
   * Valheim hammer construction thud (satisfying heavy wood or stone placement sound)
   */
  public playBuildPlace(isWood: boolean = true) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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
    const noiseBuffer = this.noiseBuffer(0.1);
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
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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
    const noiseBuffer = this.noiseBuffer(0.12, true);
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
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
    const out = this.output();

    const t = this.ctx.currentTime;
    const duration = 0.45;

    // Filtered pinkish noise for water droplets
    const noiseBuffer = this.noiseBuffer(duration, false, 0.7);
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
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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
      if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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
   * Leafy swish of a bush something pushes through: two band-passed noise bursts (a soft body
   * and a crisp leaf rattle). `intensity` 0..1 sets the loudness and length. Cached noise
   * buffers, five nodes, nothing kept alive afterwards.
   */
  public playBushRustle(intensity = 1) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
    const out = this.output();
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const k = Math.min(1, Math.max(0.15, intensity));
    const len = 0.18 + 0.2 * k;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.4);
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(2600 + Math.random() * 900, t);
    band.frequency.linearRampToValueAtTime(1500, t + len);
    band.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16 * k, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(band);
    band.connect(g);
    g.connect(out);
    src.start(t, Math.random() * 0.1);
    src.stop(t + len + 0.02);
  }

  /** Axe into a bush: a dull twiggy snap plus a burst of leaves (louder when it goes down). */
  public playBushChop(isFatal = false) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
    const out = this.output();
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const snap = ctx.createBufferSource();
    snap.buffer = this.noiseBuffer(0.05);
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = isFatal ? 1300 : 1700;
    hp.Q.value = 2.5;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(isFatal ? 0.4 : 0.28, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    snap.connect(hp);
    hp.connect(sg);
    sg.connect(out);
    snap.start(t);
    const leaves = ctx.createBufferSource();
    leaves.buffer = this.noiseBuffer(0.4);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(3200, t);
    band.frequency.linearRampToValueAtTime(1800, t + 0.35);
    band.Q.value = 0.8;
    const lg = ctx.createGain();
    const len = isFatal ? 0.45 : 0.28;
    lg.gain.setValueAtTime(0.0001, t);
    lg.gain.linearRampToValueAtTime(isFatal ? 0.26 : 0.18, t + 0.02);
    lg.gain.exponentialRampToValueAtTime(0.001, t + len);
    leaves.connect(band);
    band.connect(lg);
    lg.connect(out);
    leaves.start(t);
    leaves.stop(t + len + 0.02);
  }

  /** Starts a sound: the context (resumed if needed), its destination and the time, or null. */
  private begin(): { ctx: AudioContext; out: AudioNode; t: number } | null {
    if (!this.ctx) this.init();
    if (!this.ctx) {
      this.pendingPos = null;
      return null;
    }
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
    return { ctx: this.ctx, out: this.output(), t: this.ctx.currentTime };
  }

  /**
   * A silk thread snapping: a dry broadband tick, the thread's short high "ting" ringing off it,
   * and the freed end whipping back through the air. Two cached noise buffers, a handful of nodes.
   */
  public playWebSnap(intensity = 1) {
    const s = this.begin();
    if (!s) return;
    const { ctx, out, t } = s;
    const k = Math.max(0.2, Math.min(1, intensity));
    const r = Math.random;
    // Tick + ting from one short decaying burst
    const click = ctx.createBufferSource();
    click.buffer = this.noiseBuffer(0.012, true);
    click.playbackRate.value = 0.8 + r() * 0.5;
    const tickBand = ctx.createBiquadFilter();
    tickBand.type = 'bandpass';
    tickBand.frequency.value = 3200 + r() * 2800;
    tickBand.Q.value = 0.9;
    const tickGain = ctx.createGain();
    tickGain.gain.value = 0.26 * k;
    click.connect(tickBand);
    tickBand.connect(tickGain);
    tickGain.connect(out);
    const ring = ctx.createBiquadFilter();
    ring.type = 'bandpass';
    ring.frequency.value = 2300 + r() * 1700;
    ring.Q.value = 28;
    const ringGain = ctx.createGain();
    ringGain.gain.value = 0.9 * k;
    click.connect(ring);
    ring.connect(ringGain);
    ringGain.connect(out);
    click.start(t);
    // The loose end whipping back: a quick falling swish
    const whip = ctx.createBufferSource();
    whip.buffer = this.noiseBuffer(0.09);
    const sweep = ctx.createBiquadFilter();
    sweep.type = 'bandpass';
    sweep.Q.value = 3.5;
    const top = 6000 + r() * 2500;
    const len = 0.045 + r() * 0.035;
    const t0 = t + 0.004;
    sweep.frequency.setValueAtTime(top, t0);
    sweep.frequency.exponentialRampToValueAtTime(top * 0.28, t0 + len);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t0);
    wg.gain.exponentialRampToValueAtTime(0.075 * k, t0 + 0.005);
    wg.gain.exponentialRampToValueAtTime(0.001, t0 + len);
    whip.connect(sweep);
    sweep.connect(wg);
    wg.connect(out);
    whip.start(t0);
    whip.stop(t0 + len + 0.01);
  }

  /** The axe through a web: a swishy, papery tear (more threads cut, louder and longer). */
  public playWebCut(amount = 0.5) {
    const s = this.begin();
    if (!s) return;
    const { ctx, out, t } = s;
    const k = Math.max(0.25, Math.min(1, amount));
    const len = 0.14 + 0.16 * k;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.35);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(5200, t);
    bp.frequency.exponentialRampToValueAtTime(2200, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.2 * k, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(bp);
    bp.connect(g);
    g.connect(out);
    src.start(t);
    src.stop(t + len + 0.02);
  }

  /**
   * Joyful ascending celebration chime for harvesting Heartopia crops
   */
  /** An apple hitting the ground: a soft, short, low thump (louder for a harder landing). */
  public playAppleThud(intensity = 1) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
    const out = this.output();
    const t = this.ctx.currentTime;
    const k = Math.max(0.15, Math.min(1, intensity));
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    const f = 150 + Math.random() * 60;
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.45, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.32 * k, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  /** An apple picked up: a quick bright pop. */
  public playApplePickup() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
    const out = this.output();
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    const f = 620 + Math.random() * 120;
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 1.9, t + 0.07);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  public playHarvest() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && !document.hidden && !this.paused) this.ctx.resume();
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

/**
 * One engine (and one AudioContext) per page. Kept on globalThis so a hot reload of this module in
 * development reuses it instead of starting a second context that the pause menu would not mute.
 */
export const audioEngine: AudioEngine = ((globalThis as { __farmAudioEngine?: AudioEngine }).__farmAudioEngine ??= new AudioEngine());

