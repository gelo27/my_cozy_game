import { audioEngine } from '../audio/AudioEngine';

interface Pos { x: number; y: number; z: number }

/**
 * Tiny synthesized voices for the island's pests. Each call builds a
 * few short-lived nodes into a positional panner that is released when the sound ends.
 */
function voice(pos: Pos | null, seconds: number, build: (ctx: AudioContext, out: AudioNode, t: number) => void, ref = 4): void {
  const ctx = audioEngine.context;
  if (!ctx) return;
  const panner = pos ? audioEngine.createPanner(pos, ref, ref * 12) : null;
  const out = panner ?? audioEngine.channel('sfx');
  if (!out) return;
  build(ctx, out, ctx.currentTime);
  if (panner) window.setTimeout(() => panner.disconnect(), (seconds + 0.3) * 1000);
}

function tone(ctx: AudioContext, out: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, vol: number): void {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.015, dur * 0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** One shared second of white noise; each voice plays a random slice of it (no buffer per sound). */
let sharedNoise: AudioBuffer | null = null;
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (sharedNoise && sharedNoise.sampleRate === ctx.sampleRate) return sharedNoise;
  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return (sharedNoise = buf);
}

function noise(ctx: AudioContext, out: AudioNode, t: number, dur: number, vol: number, freq: number, q = 1, type: BiquadFilterType = 'bandpass', sweepTo?: number): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = dur > 0.9;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t, src.loop ? Math.random() : Math.random() * Math.max(0, 0.98 - dur));
  src.stop(t + dur + 0.02);
}

export const critterSounds = {
  /** Hedgehog curling up: a short huff. */
  huff(pos: Pos): void {
    voice(pos, 0.3, (ctx, out, t) => {
      noise(ctx, out, t, 0.18, 0.18, 900, 1.5);
      tone(ctx, out, t, 'sawtooth', 220, 140, 0.15, 0.04);
    }, 5);
  },
  /** Rolling rumble (called repeatedly while it rolls). */
  roll(pos: Pos): void {
    voice(pos, 0.25, (ctx, out, t) => noise(ctx, out, t, 0.22, 0.1, 260, 0.8, 'lowpass'), 5);
  },
  /** Something hit the player. */
  ouch(): void {
    voice(null, 0.4, (ctx, out, t) => {
      tone(ctx, out, t, 'square', 420, 160, 0.22, 0.09);
      noise(ctx, out, t, 0.12, 0.2, 1200, 1);
    });
  },
  /** Baby dragon: a little roar, then the whoosh of a fireball. */
  fireball(pos: Pos): void {
    voice(pos, 0.7, (ctx, out, t) => {
      tone(ctx, out, t, 'sawtooth', 380, 220, 0.2, 0.06);
      noise(ctx, out, t + 0.12, 0.5, 0.25, 500, 0.7, 'lowpass', 1800);
    }, 6);
  },
  explode(pos: Pos): void {
    voice(pos, 0.7, (ctx, out, t) => {
      noise(ctx, out, t, 0.55, 0.45, 1400, 0.6, 'lowpass', 120);
      tone(ctx, out, t, 'sine', 140, 50, 0.4, 0.2);
    }, 6);
  },
  wingFlap(pos: Pos): void {
    voice(pos, 0.15, (ctx, out, t) => noise(ctx, out, t, 0.1, 0.07, 400, 1, 'lowpass'), 4);
  },
  /** Slingshot release: the band's twang and a short whip of air. */
  slingshot(pos: Pos): void {
    voice(pos, 0.3, (ctx, out, t) => {
      tone(ctx, out, t, 'triangle', 520, 180, 0.12, 0.08);
      noise(ctx, out, t, 0.14, 0.12, 2400, 1.2, 'bandpass', 900);
    }, 4);
  },
  /** A pebble knocking on wood, stone or the ground. */
  pebbleHit(pos: Pos): void {
    voice(pos, 0.15, (ctx, out, t) => {
      tone(ctx, out, t, 'sine', 900 + Math.random() * 500, 400, 0.06, 0.07);
      noise(ctx, out, t, 0.05, 0.12, 3000, 2);
    }, 4);
  },
  /** Shark rushing in: a low surge of water. */
  sharkSurge(pos: Pos): void {
    voice(pos, 0.9, (ctx, out, t) => {
      noise(ctx, out, t, 0.8, 0.22, 300, 0.6, 'lowpass', 900);
      tone(ctx, out, t, 'sine', 70, 45, 0.7, 0.12);
    }, 6);
  },
  /** Shark jaws snapping shut. */
  sharkBite(pos: Pos): void {
    voice(pos, 0.4, (ctx, out, t) => {
      noise(ctx, out, t, 0.09, 0.4, 2600, 1.4);
      tone(ctx, out, t, 'square', 180, 60, 0.12, 0.12);
      noise(ctx, out, t + 0.05, 0.25, 0.25, 500, 0.7, 'lowpass', 150);
    }, 6);
  },
  /** A pest takes a hit: hedgehogs squeak, dragons yelp lower, sharks thud, spiders screech. */
  hurt(pos: Pos, kind: 'hedgehog' | 'dragon' | 'shark' | 'spider'): void {
    const f = kind === 'hedgehog' ? 1250 : kind === 'dragon' ? 620 : kind === 'shark' ? 240 : 1900;
    voice(pos, 0.35, (ctx, out, t) => {
      tone(ctx, out, t, 'square', f, f * 0.55, 0.16, 0.06);
      noise(ctx, out, t, 0.08, 0.16, 1800, 1);
    }, 5);
  },
  /** A beaten pest vanishes in a puff. */
  poof(pos: Pos): void {
    voice(pos, 0.7, (ctx, out, t) => {
      noise(ctx, out, t, 0.45, 0.3, 1800, 0.7, 'lowpass', 200);
      tone(ctx, out, t, 'sine', 300, 900, 0.25, 0.08);
      tone(ctx, out, t + 0.12, 'sine', 600, 1400, 0.2, 0.06);
    }, 6);
  },
};
