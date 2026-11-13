import { getPatch } from './patches';
import type { CompiledSong } from './SongFormat';
import type { InstrumentBank } from './InstrumentBank';

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  start: number;
  end: number;
  owner: SongPlayer;
}

/** How far ahead notes are handed to the audio thread: a frame hitch this long is never heard. */
export const LOOKAHEAD_MOBILE = 0.8;
export const LOOKAHEAD_DESKTOP = 0.3;

/**
 * Plays notes for every song player through one capped pool of voices. Each note is a single
 * AudioBufferSourceNode and GainNode; when the cap is reached the oldest voice fades out quickly.
 */
export class VoicePool {
  private voices: Voice[] = [];
  public peak = 0;
  /** Voices cut short by the cap (developer panel: should stay rare). */
  public stolen = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly bank: InstrumentBank,
    public limit: number
  ) {}

  public get active(): number {
    const now = this.ctx.currentTime;
    let n = 0;
    for (const v of this.voices) if (v.start <= now && v.end > now) n++;
    return n;
  }

  public play(owner: SongPlayer, patchName: string, midi: number, t: number, dur: number, vel: number, out: AudioNode): void {
    const ctx = this.ctx;
    const patch = getPatch(patchName);
    if (!patch) return;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const s = this.bank.pick(patchName, f);
    if (!s) return;
    const now = ctx.currentTime;
    if (this.voices.length >= this.limit) this.voices = this.voices.filter((v) => v.end > now);
    // The cap is on notes sounding together when this one starts, not on notes queued ahead (a
    // phone's long lookahead queues many that cost nothing yet)
    let sounding = 0;
    for (;;) {
      let k = -1;
      sounding = 0;
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        if (v.start > t || v.end <= t) continue;
        sounding++;
        if (k < 0 || v.end < this.voices[k].end) k = i;
      }
      if (sounding < this.limit) break;
      // Steal the one closest to its end at that moment (a fading tail, not a note just struck)
      this.release(this.voices.splice(k, 1)[0], Math.max(now, t), 0.015);
      this.stolen++;
    }
    this.peak = Math.max(this.peak, sounding + 1);

    // A little human timing, force and tuning: dead-even notes are what make synthesis sound machine-made
    t = Math.max(now, t + (Math.random() - 0.5) * 0.018);
    vel *= 0.85 + Math.random() * 0.3;
    const src = ctx.createBufferSource();
    src.buffer = s.buffer;
    src.playbackRate.value = patch.unpitched ? 0.94 + Math.random() * 0.12 : (f / s.rootFreq) * Math.pow(2, ((Math.random() - 0.5) * 8) / 1200);
    const g = ctx.createGain();
    let end: number;
    if (patch.loop) {
      src.loop = true;
      // Sustained instruments play their onset once, then hold on the seamless loop after it
      if (s.loopStart > 0) {
        src.loopStart = s.loopStart;
        src.loopEnd = s.buffer.duration;
      }
      const atk = patch.attack ?? 0.5, rel = patch.release ?? 1;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + atk);
      g.gain.setTargetAtTime(0, t + dur, rel / 3);
      end = t + dur + rel * 1.6;
    } else {
      end = t + Math.min(s.buffer.duration / src.playbackRate.value, dur + patch.ring);
      g.gain.setValueAtTime(vel, t);
      g.gain.setTargetAtTime(0, end - 0.1, 0.03);
    }
    src.connect(g).connect(out);
    src.start(t);
    src.stop(end);
    this.voices.push({ src, gain: g, start: t, end, owner });
  }

  /** Silences a player's voices (already sounding ones fade, queued ones never start). */
  public stopOwner(owner: SongPlayer, fade: number): void {
    const now = this.ctx.currentTime;
    this.voices = this.voices.filter((v) => {
      if (v.owner !== owner) return true;
      this.release(v, now, fade);
      return false;
    });
  }

  private release(v: Voice, now: number, tc: number): void {
    const at = Math.max(now, v.start);
    v.gain.gain.cancelScheduledValues(at);
    v.gain.gain.setTargetAtTime(0, at, tc);
    try {
      v.src.stop(at + tc * 6);
    } catch {
      /* already stopped */
    }
  }
}

/**
 * One song playing: its own fade gain, a gain per director layer and a stereo position per part.
 * The engine's tick asks it to schedule notes up to the lookahead horizon.
 */
export class SongPlayer {
  public readonly out: GainNode;
  private readonly layers = new Map<string, GainNode>();
  /** Where each layer is heading: a silent layer schedules no notes (no voices spent on it). */
  private readonly layerTarget = new Map<string, number>();
  /** Per part: its layer's name, or null. */
  private readonly partLayer: (string | null)[];
  private readonly partBus: AudioNode[];
  private step = 0;
  private nextTime = 0;
  /** Step to stop at (end of the current section), or -1. */
  private stopAtStep = -1;
  private stopFade = 3;
  public done = false;
  /** All notes scheduled (play-once songs): becomes done once they ring out. */
  private finishedAt = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly pool: VoicePool,
    public readonly song: CompiledSong,
    dest: AudioNode,
    public readonly loop: boolean,
    layerLevels: Readonly<Record<string, number>>
  ) {
    this.out = ctx.createGain();
    this.partLayer = song.parts.map((p) => p.layer);
    this.out.connect(dest);
    this.partBus = song.parts.map((p) => {
      let target: AudioNode = this.out;
      if (p.layer) {
        let lg = this.layers.get(p.layer);
        if (!lg) {
          lg = ctx.createGain();
          lg.gain.value = layerLevels[p.layer] ?? 0;
          lg.connect(this.out);
          this.layers.set(p.layer, lg);
          this.layerTarget.set(p.layer, lg.gain.value);
        }
        target = lg;
      }
      const pan = getPatch(p.patch)?.pan ?? 0;
      if (pan === 0 || !ctx.createStereoPanner) return target;
      const sp = ctx.createStereoPanner();
      sp.pan.value = pan;
      sp.connect(target);
      return sp;
    });
  }

  public start(at: number, fadeIn: number): void {
    this.step = 0;
    this.nextTime = at;
    const g = this.out.gain;
    g.cancelScheduledValues(at);
    if (fadeIn > 0) {
      g.setValueAtTime(0, at);
      g.linearRampToValueAtTime(this.song.gain, at + fadeIn);
    } else {
      g.setValueAtTime(this.song.gain, at);
    }
  }

  public setLayer(name: string, value: number, tc: number): void {
    const lg = this.layers.get(name);
    if (!lg) return;
    lg.gain.setTargetAtTime(value, this.ctx.currentTime, tc);
    this.layerTarget.set(name, value);
  }

  /** Seconds left until the end (play-once) or Infinity (loop). */
  public get remaining(): number {
    if (this.loop) return Infinity;
    return Math.max(0, (this.song.total - this.step) * this.song.stepDur + (this.nextTime - this.ctx.currentTime));
  }

  /** Lets the current section finish, then fades out (weather changed: no cut mid-phrase). */
  public endAtSectionBoundary(fade: number): void {
    if (this.stopAtStep >= 0 || this.done) return;
    const next = this.song.sectionStarts.find((s) => s > this.step);
    // A loop wraps to step 0 instead of reaching `total`
    this.stopAtStep = next ?? (this.loop ? this.song.loopStep : this.song.total);
    this.stopFade = fade;
  }

  public fadeOut(seconds: number): void {
    if (this.done) return;
    this.done = true;
    const now = this.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + seconds);
    this.pool.stopOwner(this, seconds / 3);
    window.setTimeout(() => this.out.disconnect(), (seconds + 1) * 1000);
  }

  /** A part on a layer that is (nearly) silent and staying so. */
  private muted(part: number): boolean {
    const name = this.partLayer[part];
    if (!name) return false;
    return (this.layerTarget.get(name) ?? 0) < 0.01 && this.layers.get(name)!.gain.value < 0.04;
  }

  public schedule(horizon: number): void {
    if (this.done) return;
    const now = this.ctx.currentTime;
    if (this.finishedAt > 0) {
      if (now >= this.finishedAt) this.fadeOut(0.5);
      return;
    }
    // After a pause or a long freeze: carry on from now, never fire the missed notes in one burst
    if (this.nextTime < now - 0.05) this.nextTime = now + 0.05;
    const song = this.song;
    while (this.nextTime < horizon) {
      if (this.step === this.stopAtStep) {
        const wait = Math.max(0, this.nextTime - now);
        window.setTimeout(() => this.fadeOut(this.stopFade), wait * 1000);
        this.finishedAt = Infinity;
        return;
      }
      for (const n of song.table[this.step]) {
        if (this.muted(n.part)) continue;
        this.pool.play(this, n.patch, n.midi, this.nextTime, n.len * song.stepDur, n.vel, this.partBus[n.part]);
      }
      this.nextTime += song.stepDur;
      this.step++;
      if (this.step >= song.total) {
        if (this.loop) this.step = song.loopStep;
        else {
          // Let the last notes ring before calling it done
          this.finishedAt = this.nextTime + 2.5;
          return;
        }
      }
    }
  }
}
