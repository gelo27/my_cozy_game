import * as THREE from 'three';
import { audioEngine } from './AudioEngine';

/**
 * Underground soundscape: a reverb send on the effects (footsteps, picks, splashes all ring off the
 * rock), a low rumble bed, now and then a distant rockfall, far drips all around, and the positional
 * plinks of drops falling from the stalactites near the player.
 *
 * Nothing runs above ground: the rumble loop is stopped and the reverb send disconnected once the
 * mix has faded out, and every one-shot disconnects its nodes when it ends.
 */
class CaveAudio {
  private mix = 0;
  private brown: AudioBuffer | null = null;
  private rumble: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; lfo: OscillatorNode; lfoGain: GainNode } | null = null;
  private eventTimer = 18;
  private farDripTimer = 1;
  private dripBudget = 4;
  private readonly tmp = new THREE.Vector3();

  /** Call every frame. `listener` is the camera position. */
  public update(dt: number, inCave: boolean, listener: THREE.Vector3): void {
    const ctx = audioEngine.context;
    if (!ctx) return;
    this.mix += ((inCave ? 1 : 0) - this.mix) * (1 - Math.exp(-dt * 1.6));
    if (!inCave && this.mix < 0.004) this.mix = 0;
    audioEngine.setReverb(this.mix * (audioEngine.isUnderwater ? 0.25 : 0.6));
    this.dripBudget = Math.min(4, this.dripBudget + dt * 3);

    if (this.mix > 0.01 && !this.rumble) this.startRumble(ctx);
    if (this.rumble) {
      this.rumble.gain.gain.setTargetAtTime(0.14 * this.mix, ctx.currentTime, 0.3);
      if (this.mix === 0) this.stopRumble();
    }
    if (!inCave) return;

    this.eventTimer -= dt;
    if (this.eventTimer <= 0) {
      this.eventTimer = 25 + Math.random() * 40;
      this.distantRockfall(ctx, listener);
    }
    this.farDripTimer -= dt;
    if (this.farDripTimer <= 0) {
      this.farDripTimer = 0.6 + Math.random() * 2.4;
      const a = Math.random() * Math.PI * 2, d = 9 + Math.random() * 16;
      this.tmp.set(listener.x + Math.cos(a) * d, listener.y + 2 + Math.random() * 4, listener.z + Math.sin(a) * d);
      this.plink(ctx, this.tmp, Math.random() < 0.3, 0.35);
    }
  }

  /** A drop landing at `pos` (on rock, or in a pool when `water`). Rate limited. */
  public drip(pos: THREE.Vector3, water: boolean): void {
    const ctx = audioEngine.context;
    if (!ctx || this.dripBudget < 1) return;
    this.dripBudget -= 1;
    this.plink(ctx, pos, water, 1);
  }

  private plink(ctx: AudioContext, pos: THREE.Vector3, water: boolean, level: number): void {
    const panner = audioEngine.createPanner(pos, 1.5, 30, 'sfx', true);
    if (!panner) return;
    const t = ctx.currentTime + 0.005;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    // A water drop "plinks" upward: the bubble it traps rings at a rising pitch
    const f0 = water ? 650 + Math.random() * 500 : 1300 + Math.random() * 1500;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * (water ? 2.3 : 1.6), t + (water ? 0.07 : 0.035));
    const decay = water ? 0.2 : 0.09;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32 * level, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(g).connect(panner);
    osc.start(t);
    osc.stop(t + decay + 0.05);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
      panner.disconnect();
    };
  }

  private brownNoise(ctx: AudioContext): AudioBuffer {
    if (this.brown && this.brown.sampleRate === ctx.sampleRate) return this.brown;
    const len = Math.floor(ctx.sampleRate * 4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    // Cross-fade the loop seam
    const fade = 2048;
    for (let i = 0; i < fade; i++) d[len - fade + i] = d[len - fade + i] * (1 - i / fade) + d[i] * (i / fade);
    this.brown = buf;
    return buf;
  }

  private startRumble(ctx: AudioContext): void {
    const bus = audioEngine.bus;
    if (!bus) return;
    const src = ctx.createBufferSource();
    src.buffer = this.brownNoise(ctx);
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 110;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    // A very slow swell, like air moving through the tunnels
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain).connect(gain.gain);
    src.connect(filter).connect(gain).connect(bus);
    src.start();
    lfo.start();
    this.rumble = { src, filter, gain, lfo, lfoGain };
  }

  private stopRumble(): void {
    const r = this.rumble;
    if (!r) return;
    this.rumble = null;
    try {
      r.src.stop();
      r.lfo.stop();
    } catch {
      /* already stopped */
    }
    r.src.disconnect();
    r.filter.disconnect();
    r.gain.disconnect();
    r.lfo.disconnect();
    r.lfoGain.disconnect();
  }

  /** Far-off rocks settling: a deep swell, then a few pebbles skittering. */
  private distantRockfall(ctx: AudioContext, listener: THREE.Vector3): void {
    const a = Math.random() * Math.PI * 2;
    this.tmp.set(listener.x + Math.cos(a) * 28, listener.y + 3, listener.z + Math.sin(a) * 28);
    const panner = audioEngine.createPanner(this.tmp, 30, 200, 'ambient', true);
    if (!panner) return;
    const t = ctx.currentTime + 0.02;
    const dur = 3.5 + Math.random() * 2;
    const src = ctx.createBufferSource();
    src.buffer = this.brownNoise(ctx);
    src.playbackRate.value = 0.6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(70, t);
    lp.frequency.linearRampToValueAtTime(260, t + dur * 0.3);
    lp.frequency.linearRampToValueAtTime(60, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.55, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(panner);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.1);
    // Pebbles: short bright ticks trailing the swell
    const ticks: { o: OscillatorNode; tg: GainNode }[] = [];
    const n = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const tt = t + dur * (0.35 + Math.random() * 0.45);
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 900 + Math.random() * 1800;
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.0001, tt);
      tg.gain.exponentialRampToValueAtTime(0.06, tt + 0.003);
      tg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.05);
      o.connect(tg).connect(panner);
      o.start(tt);
      o.stop(tt + 0.07);
      ticks.push({ o, tg });
    }
    src.onended = () => {
      src.disconnect();
      lp.disconnect();
      g.disconnect();
      for (const { o, tg } of ticks) {
        o.disconnect();
        tg.disconnect();
      }
      panner.disconnect();
    };
  }

  public dispose(): void {
    this.stopRumble();
    this.mix = 0;
    audioEngine.setReverb(0);
  }
}

export const caveAudio = new CaveAudio();
