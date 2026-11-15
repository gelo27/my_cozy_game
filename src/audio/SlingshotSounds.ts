import { audioEngine } from './AudioEngine';
import { renderSling, SYNTH_VARIANTS } from './SlingshotSynth';

/**
 * Recorded sounds of the slingshot, layered so a shot reads as weighty: the band creaks as it is
 * drawn, the pouch snaps on release with a whip of air behind the pebble, and the pebble clacks on
 * stone or thuds into dirt. Each sound is a recording in public/sounds/slingshot/ (.ogg, then .mp3);
 * a sound can have variants <file>_1, <file>_2, … (one is picked at random, never the same twice in
 * a row). Until a recording is there, the sound is rendered once by the audio engine from a
 * physical model (SlingshotSynth): a recording found later replaces it.
 *
 * Files looked for (short mono clips, ~44.1 kHz, trimmed tight at the start):
 *   sling_draw     rubber band and leather pouch stretching (≈0.6 s, the length of a full draw)
 *   sling_full     the band creaking at full stretch
 *   sling_release  the band snapping forward and the pouch slapping (the shot itself)
 *   sling_whoosh   the pebble zipping away through the air
 *   pebble_hard    pebble clacking on rock or wood
 *   pebble_ground  pebble thudding into dirt or grass
 *   pebble_thwack  pebble smacking into a creature
 */
export type SlingSound = 'draw' | 'full' | 'release' | 'whoosh' | 'hard' | 'ground' | 'thwack';

const FILES: Record<SlingSound, string> = {
  draw: 'sling_draw',
  full: 'sling_full',
  release: 'sling_release',
  whoosh: 'sling_whoosh',
  hard: 'pebble_hard',
  ground: 'pebble_ground',
  thwack: 'pebble_thwack',
};

/** Variants tried per sound (<file>_1 … <file>_N, stopping at the first one missing). */
const MAX_VARIANTS = 6;

interface Pos {
  x: number;
  y: number;
  z: number;
}

interface Opts {
  vol?: number;
  pitch?: number;
  /** Random pitch spread (± fraction). */
  spread?: number;
  /** Seconds from now. */
  delay?: number;
  /** Panner reference distance (m). */
  ref?: number;
}

class SlingshotSoundBank {
  private ctx: AudioContext | null = null;
  private buffers = new Map<SlingSound, AudioBuffer[]>();
  private last = new Map<SlingSound, number>();
  private drawing: { src: AudioBufferSourceNode; gain: GainNode } | null = null;

  /** Has at least one recording of `name` loaded (otherwise the caller plays its synth stand-in). */
  public has(name: SlingSound): boolean {
    this.ensure();
    return (this.buffers.get(name)?.length ?? 0) > 0;
  }

  /** Starts loading the recordings (call early, e.g. when the slingshot is first equipped). */
  public ensure(): void {
    const ctx = audioEngine.context;
    if (!ctx || this.ctx === ctx) return;
    this.ctx = ctx;
    this.buffers.clear();
    this.recorded.clear();
    for (const name of Object.keys(FILES) as SlingSound[]) {
      this.buffers.set(name, []);
      void this.loadAll(ctx, name);
    }
    this.renderStandIns(ctx);
  }

  /**
   * Renders the stand-ins one variant per task (each takes a few ms), so equipping the slingshot
   * never stalls a frame; until a sound is ready its caller plays the simple synth.
   */
  private renderStandIns(ctx: AudioContext): void {
    const jobs: [SlingSound, number][] = [];
    // The shot itself first, then what follows it
    for (const name of ['release', 'whoosh', 'draw', 'full', 'hard', 'ground', 'thwack'] as SlingSound[])
      for (let v = 0; v < SYNTH_VARIANTS[name]; v++) jobs.push([name, v]);
    const step = () => {
      const job = jobs.shift();
      if (!job || this.ctx !== ctx) return;
      const [name, v] = job;
      if (!this.recorded.has(name)) {
        const data = renderSling(name, ctx.sampleRate, v);
        const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
        buf.copyToChannel(data, 0);
        this.buffers.get(name)?.push(buf);
      }
      window.setTimeout(step, 16);
    };
    window.setTimeout(step, 0);
  }

  private async loadAll(ctx: AudioContext, name: SlingSound): Promise<void> {
    const base = FILES[name];
    const plain = await this.load(ctx, base);
    if (plain) this.add(ctx, name, plain);
    for (let i = 1; i <= MAX_VARIANTS; i++) {
      const buf = await this.load(ctx, `${base}_${i}`);
      if (!buf) break;
      this.add(ctx, name, buf);
    }
  }

  /** Sounds whose rendered stand-ins have been replaced by recordings. */
  private recorded = new Set<SlingSound>();

  private add(ctx: AudioContext, name: SlingSound, buf: AudioBuffer): void {
    if (this.ctx !== ctx) return;
    if (!this.recorded.has(name)) {
      this.recorded.add(name);
      this.buffers.set(name, []);
      this.last.delete(name);
    }
    this.buffers.get(name)?.push(buf);
  }

  private async load(ctx: AudioContext, file: string): Promise<AudioBuffer | null> {
    for (const ext of ['ogg', 'mp3', 'wav']) {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}sounds/slingshot/${file}.${ext}`);
        // The dev server answers a missing file with the page itself: only take audio
        if (!res.ok || !(res.headers.get('content-type') ?? '').match(/audio|octet/)) continue;
        return await ctx.decodeAudioData(await res.arrayBuffer());
      } catch {
        /* not there / undecodable */
      }
    }
    return null;
  }

  /** A random variant, not the one played last time. */
  private pick(name: SlingSound): AudioBuffer | null {
    const list = this.buffers.get(name);
    if (!list || list.length === 0) return null;
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === this.last.get(name)) i = (i + 1) % list.length;
    this.last.set(name, i);
    return list[i];
  }

  /** Plays `name` at `pos` (world), or as the player's own sound when `pos` is null. */
  public play(name: SlingSound, pos: Pos | null, o: Opts = {}): { src: AudioBufferSourceNode; gain: GainNode } | null {
    this.ensure();
    const ctx = this.ctx;
    const buf = this.pick(name);
    if (!ctx || !buf) return null;
    const ref = o.ref ?? 4;
    const out = pos ? audioEngine.createPanner(pos, ref, ref * 14) : audioEngine.channel('sfx');
    if (!out) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const spread = o.spread ?? 0.06;
    src.playbackRate.value = (o.pitch ?? 1) * (1 - spread + Math.random() * spread * 2);
    const gain = ctx.createGain();
    gain.gain.value = (o.vol ?? 1) * (0.88 + Math.random() * 0.12);
    src.connect(gain);
    gain.connect(out);
    src.start(ctx.currentTime + (o.delay ?? 0));
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
      if (pos) out.disconnect();
    };
    return { src, gain };
  }

  /** The band being pulled back (cut off by stopDraw on release or cancel). */
  public startDraw(drawTime: number): boolean {
    this.stopDraw(0.03);
    this.ensure();
    const buf = this.buffers.get('draw')?.[0];
    if (!buf) return false;
    // Stretch the recording to the draw: a full pull ends as the band reaches full stretch
    const pitch = Math.min(1.25, Math.max(0.8, buf.duration / drawTime));
    this.drawing = this.play('draw', null, { vol: 0.75, pitch, spread: 0.03 });
    return !!this.drawing;
  }

  /** Fades the draw creak out over `fade` seconds. */
  public stopDraw(fade = 0.04): void {
    const d = this.drawing;
    const ctx = this.ctx;
    this.drawing = null;
    if (!d || !ctx) return;
    const t = ctx.currentTime;
    d.gain.gain.cancelScheduledValues(t);
    d.gain.gain.setValueAtTime(d.gain.gain.value, t);
    d.gain.gain.linearRampToValueAtTime(0, t + fade);
    try {
      d.src.stop(t + fade + 0.01);
    } catch {
      /* already stopped */
    }
  }
}

export const slingshotSounds = new SlingshotSoundBank();
