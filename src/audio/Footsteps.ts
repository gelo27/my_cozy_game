import { audioEngine, AudioChannel } from './AudioEngine';
import { OTHER_RANGE, OTHER_VOICES, R, SURFACE_GAIN, SYNTH_RATE, VARIANTS, VARIANTS_LONG, VOICES, WARM_ORDER, render, renderUnderBed, rr, type FootSurface, type Kind } from './FootstepSynth';
import { SfxBank } from './SfxRender';

/** Takes per sound: more for steps (heard constantly), fewer for long, rare sounds. */
const STEP_VARIANTS = Object.fromEntries(WARM_ORDER.map((k) => [k, k === 'splash' || k === 'exhale' ? VARIANTS_LONG : VARIANTS])) as Record<Kind, number>;
const renderTake = (kind: Kind) => ({ data: render(kind, SYNTH_RATE), rate: SYNTH_RATE });

export type { FootSurface } from './FootstepSynth';

/** Shared `onended`: no closure per sound. Finished sources leave the graph and get collected. */
function releaseSource(this: AudioBufferSourceNode): void {
  this.disconnect();
}

interface VoicePool { gains: GainNode[]; next: number }

export class FootstepAudio {
  /** Pre-rendered takes (rendered in the sound worker, see SfxBank). */
  private bank: SfxBank<Kind> | null = null;
  private readonly pools: Partial<Record<AudioChannel, VoicePool>> = {};
  /** Villagers' steps: a ring of panner voices (step + rain layer), repositioned per step. */
  private readonly others: { panner: PannerNode; gain: GainNode; wetGain: GainNode }[] = [];
  private otherNext = 0;
  private bed: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  /** Steps, strokes and lapping sound from the player's body (HRTF on desktop), not inside the head. */
  private panner: PannerNode | null = null;
  private readonly sourcePos = { x: 0, y: 0, z: 0 };
  private bedBuffer: AudioBuffer | null = null;
  private strokeTimer = 0;
  private lapTimer = 2;
  private exhaleTimer = 3;
  private wasUnder = false;

  /** Where the player's body sounds come from (call every frame; the feet / swimmer position). */
  public setPosition(x: number, y: number, z: number): void {
    this.sourcePos.x = x;
    this.sourcePos.y = y;
    this.sourcePos.z = z;
    if (this.panner) audioEngine.setPannerPos(this.panner, this.sourcePos);
  }

  /** One footstep. `intensity` ~0.35 sneaking, 0.6 walking, 1 running, >1 landing. `wet` 0..1 rain-soaked ground. */
  public step(surface: FootSurface, intensity: number, wet = 0): void {
    const g = 0.22 * intensity * SURFACE_GAIN[surface];
    // Running lands harder: a touch brighter
    this.play(surface, g, rr(0.94, 1.06) * (intensity > 0.9 ? 1.04 : 1), false);
    if (wet > 0.15 && surface !== 'water' && surface !== 'snow') this.play('wet', g * 0.5 * wet, rr(0.9, 1.1), false);
  }

  /**
   * Someone else's footstep at a world point (villagers). The same pre-rendered steps through a
   * small fixed ring of cheap equal-power panners (no HRTF, nothing allocated but the one-shot
   * source); the caller culls steps out of earshot.
   */
  public stepAt(surface: FootSurface, intensity: number, wet: number, pos: { x: number; y: number; z: number }): void {
    const ctx = audioEngine.context;
    if (!ctx) return;
    if (this.others.length === 0) {
      for (let i = 0; i < OTHER_VOICES; i++) {
        const panner = audioEngine.createPanner(pos, 3, OTHER_RANGE, 'sfx', true);
        if (!panner) return;
        const gain = ctx.createGain();
        const wetGain = ctx.createGain();
        gain.connect(panner);
        wetGain.connect(panner);
        this.others.push({ panner, gain, wetGain });
      }
    }
    const v = this.others[this.otherNext];
    this.otherNext = (this.otherNext + 1) % this.others.length;
    audioEngine.setPannerPos(v.panner, pos);
    const g = 0.2 * intensity * SURFACE_GAIN[surface];
    this.playInto(ctx, surface, g, rr(0.92, 1.08), v.gain);
    if (wet > 0.15 && surface !== 'water' && surface !== 'snow') this.playInto(ctx, 'wet', g * 0.5 * wet, rr(0.9, 1.1), v.wetGain);
  }

  /** Big entry splash (jump / fall into water); `impact` = vertical speed (m/s). */
  public splash(impact: number): void {
    this.play('splash', Math.min(1, 0.25 + impact * 0.07), rr(0.92, 1.05), false);
  }

  /** Per frame: swim strokes, lapping water, bubbles and the underwater bed (positional args: no per-frame objects). */
  public updateSwim(dt: number, swimming: boolean, underwater: boolean, speed: number): void {
    const ctx = audioEngine.context;
    if (!ctx) return;
    this.takes(ctx).warm();
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
        else this.play('stroke', (0.2 + k * 0.12) * 1.4, rr(0.94, 1.06), false);
      } else if (!moving) {
        this.strokeTimer = Math.min(this.strokeTimer, 0.15);
      }
      if (!underwater && !moving) {
        this.lapTimer -= dt;
        if (this.lapTimer <= 0) {
          this.lapTimer = rr(1.6, 3.2);
          this.play('lap', rr(0.15, 0.22), rr(0.92, 1.06), false);
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

  private loopBuffer(ctx: AudioContext): AudioBuffer {
    if (this.bedBuffer) return this.bedBuffer;
    // Only a deep rumble: a low rate is enough
    const data = renderUnderBed(8000);
    const buf = ctx.createBuffer(1, data.length, 8000);
    buf.copyToChannel(data, 0);
    return (this.bedBuffer = buf);
  }

  private takes(ctx: BaseAudioContext): SfxBank<Kind> {
    return (this.bank ??= new SfxBank<Kind>(ctx, 'step', STEP_VARIANTS, WARM_ORDER, renderTake));
  }


  /** Fixed ring of gains feeding a channel, created once (round-robin, a voice is reused ~2 s later at the earliest). */
  private pool(ctx: AudioContext, ch: AudioChannel): VoicePool | null {
    let p = this.pools[ch];
    if (p) return p;
    let out: AudioNode | null | undefined = audioEngine.channel(ch);
    if (!out) return null;
    if (ch === 'sfx') {
      // Close to the player: full level within a few metres (the camera distance), fading beyond
      this.panner = audioEngine.createPanner(this.sourcePos, 4, 60, 'sfx');
      if (this.panner) out = this.panner;
    }
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
    const voice = pool.gains[pool.next];
    pool.next = (pool.next + 1) % pool.gains.length;
    this.playInto(ctx, kind, gain, rate, voice);
  }

  /** One take of `kind` (never the same as last time) into `voice`, whose gain is set here. */
  private playInto(ctx: AudioContext, kind: Kind, gain: number, rate: number, voice: GainNode): void {
    const buf = this.takes(ctx).get(kind);
    voice.gain.value = gain * rr(0.88, 1.08);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(voice);
    src.onended = releaseSource;
    src.start();
  }

}
