/**
 * Instrument patches. `synth` is what the worker renders once into small mono buffers (one per
 * root note); the rest is how the sequencer plays them back (one buffer source and one gain per note).
 *
 * A song may colour any patch with a `tone` (brighter, longer, softer...): that becomes its own
 * variant, named `base~key=value,...`, rendered on demand like any other patch. So two tracks
 * that both use the harp need not sound like the same harp.
 */

export type SynthKind = 'modal' | 'ks' | 'bass' | 'pad' | 'sustain' | 'noise' | 'drum';

export interface SynthParams {
  kind: SynthKind;
  /** MIDI notes rendered; playback picks the nearest and shifts the pitch. */
  roots: number[];
  /** Seconds rendered per root (pads and sustains: loop length). */
  dur: number;
  /** modal / drum: [frequency ratio, amplitude, decay seconds]. */
  modes?: [number, number, number][];
  /** modal / drum: strength of the attack transient, and how soft it is (0 felt .. 1 hard). */
  click?: number;
  clickTone?: number;
  /** ks: seconds to fall 60 dB; brightness of the pluck 0..1. */
  t60?: number;
  bright?: number;
  /** ks: where the string is plucked (0..0.5, nearer the bridge is thinner); wooden body resonance 0..1. */
  pos?: number;
  body?: number;
  /** pad / sustain: number of harmonics and their roll-off. */
  harmonics?: number;
  rolloff?: number;
  /** sustain: how much the even harmonics are hollowed out (0 bowed .. 1 clarinet / ocarina). */
  odd?: number;
  /** sustain: breath or bow noise 0..1; vibrato in cents and its rate; detuned copies (Hz apart, 0 none). */
  breath?: number;
  vib?: number;
  vibRate?: number;
  chorus?: number;
  /** sustain: seconds of onset rendered before the loop, and the noisy "chiff" at the start. */
  onset?: number;
  chiff?: number;
  /** sustain: resonant body peak [Hz, gain] (a cello's wood, a voice's formant). */
  formant?: [number, number];
  /** noise: rise and decay (seconds), and how dark (0 hiss .. 1 soft brush). */
  rise?: number;
  tau?: number;
  dark?: number;
  /** drum: the pitch starts this much higher (0.3 = +30 %) and sags to the note in `dropTau` seconds. */
  drop?: number;
  dropTau?: number;
  /** drum: snare-wire / rattle noise: level, decay (seconds) and brightness 0..1. */
  snap?: number;
  snapTau?: number;
  snapTone?: number;
  /** Highest sample rate worth rendering at (dull sounds save memory at 16 kHz). */
  srCap?: number;
}

export interface Patch {
  synth: SynthParams;
  /** One-shots ring this long past the written note length (capped by the sample). */
  ring: number;
  pan: number;
  /** Looping sustain (pads, flute, strings): attack and release in seconds. */
  loop?: boolean;
  attack?: number;
  release?: number;
  /** Plays at its rendered pitch whatever the note (shaker, brush). */
  unpitched?: boolean;
}

export const PATCHES: Record<string, Patch> = {
  kalimba: {
    synth: { kind: 'modal', roots: [62, 74], dur: 1.8, click: 0.22, modes: [[1, 1, 1.5], [2, 0.05, 0.5], [6.27, 0.2, 0.16], [17.55, 0.05, 0.04]] },
    ring: 1.6,
    pan: -0.2,
  },
  marimba: {
    synth: { kind: 'modal', roots: [55, 67], dur: 1.2, click: 0.12, modes: [[1, 1, 0.7], [3.93, 0.22, 0.12], [9.2, 0.05, 0.04]] },
    ring: 1,
    pan: 0.15,
  },
  bells: {
    synth: { kind: 'modal', roots: [74], dur: 2.4, click: 0.08, modes: [[1, 1, 2.2], [2.76, 0.28, 0.7], [5.4, 0.14, 0.25], [8.93, 0.06, 0.1]] },
    ring: 2.2,
    pan: 0.1,
  },
  handpan: {
    synth: { kind: 'modal', roots: [50, 62], dur: 2.4, click: 0.1, modes: [[1, 1, 2.2], [2, 0.35, 1.2], [3.01, 0.12, 0.5], [0.5, 0.08, 1.6]] },
    ring: 2.2,
    pan: -0.1,
  },
  /** Felt piano: near-harmonic partials, two slightly detuned strings, a soft hammer. */
  felt: {
    synth: {
      kind: 'modal',
      roots: [55, 67],
      dur: 2.4,
      click: 0.06,
      clickTone: 0.15,
      modes: [[1, 1, 2.4], [1.0011, 0.55, 2.1], [2.002, 0.38, 1.1], [3.006, 0.16, 0.6], [4.012, 0.07, 0.35], [5.02, 0.03, 0.2]],
    },
    ring: 2,
    pan: 0.05,
  },
  /** Music box: high steel comb tines. */
  musicbox: {
    synth: { kind: 'modal', roots: [76, 88], dur: 1.8, click: 0.18, clickTone: 0.9, modes: [[1, 1, 1.6], [5.4, 0.22, 0.18], [11.1, 0.07, 0.05]] },
    ring: 1.6,
    pan: 0.2,
  },
  pluck: {
    synth: { kind: 'ks', roots: [43, 55, 67], dur: 1.4, t60: 1.7, bright: 0.55 },
    ring: 0.9,
    pan: 0.25,
  },
  harp: {
    synth: { kind: 'ks', roots: [48, 60, 72], dur: 1.8, t60: 2.6, bright: 0.4 },
    ring: 1.6,
    pan: -0.25,
  },
  /** Nylon-string guitar: plucked near the soundhole, with a wooden body. */
  guitar: {
    synth: { kind: 'ks', roots: [43, 55, 67], dur: 1.8, t60: 2.3, bright: 0.32, pos: 0.2, body: 0.4 },
    ring: 1.4,
    pan: -0.15,
  },
  /** Plucked upright bass. */
  upright: {
    synth: { kind: 'ks', roots: [33, 45], dur: 1.3, t60: 1.1, bright: 0.2, pos: 0.25, body: 0.5, srCap: 16000 },
    ring: 0.5,
    pan: 0,
  },
  bass: {
    synth: { kind: 'bass', roots: [38, 50], dur: 1.6, srCap: 16000 },
    ring: 0.15,
    pan: 0,
  },
  /** Wooden flute: breathy, hollow, a late gentle vibrato. */
  flute: {
    synth: { kind: 'sustain', roots: [67, 79], dur: 1, onset: 0.14, harmonics: 6, rolloff: 1.1, odd: 0.45, breath: 0.16, vib: 13, vibRate: 5, chiff: 0.5 },
    ring: 0,
    pan: 0.2,
    loop: true,
    attack: 0.03,
    release: 0.22,
  },
  /** Cello: bowed, warm body, slow bow. */
  cello: {
    synth: { kind: 'sustain', roots: [43, 55], dur: 1, onset: 0.25, harmonics: 16, rolloff: 4, breath: 0.035, vib: 11, vibRate: 5, chorus: 0, chiff: 0.15, formant: [420, 1.4], srCap: 16000 },
    ring: 0,
    pan: -0.15,
    loop: true,
    attack: 0.16,
    release: 0.5,
  },
  /** Soft string section (several players, so no single vibrato stands out). */
  strings: {
    synth: { kind: 'sustain', roots: [55, 67], dur: 1, onset: 0.3, harmonics: 14, rolloff: 3, breath: 0.02, vib: 7, vibRate: 5, chorus: 1, formant: [900, 0.8] },
    ring: 0,
    pan: 0.1,
    loop: true,
    attack: 0.45,
    release: 1,
  },
  /** Accordion / harmonium reed: bright, two reeds a little apart, no vibrato. */
  reed: {
    synth: { kind: 'sustain', roots: [55, 67], dur: 1, onset: 0.05, harmonics: 16, rolloff: 6, odd: 0.2, breath: 0.02, vib: 0, chorus: 2, formant: [1200, 0.6] },
    ring: 0,
    pan: 0.15,
    loop: true,
    attack: 0.05,
    release: 0.14,
  },
  pad: {
    synth: { kind: 'pad', roots: [50, 62], dur: 1, harmonics: 12, rolloff: 2.5 },
    ring: 0,
    pan: 0,
    loop: true,
    attack: 0.7,
    release: 1.4,
  },
  darkpad: {
    synth: { kind: 'pad', roots: [50], dur: 1, harmonics: 6, rolloff: 1.3, srCap: 16000 },
    ring: 0,
    pan: 0,
    loop: true,
    attack: 1.2,
    release: 2,
  },
  shaker: {
    synth: { kind: 'noise', roots: [60], dur: 0.16 },
    ring: 0.1,
    pan: 0.3,
    unpitched: true,
  },
  /** Brush swept over a snare: a soft swish for gentle rhythm. */
  brush: {
    synth: { kind: 'noise', roots: [60], dur: 0.4, rise: 0.025, tau: 0.11, dark: 0.75, srCap: 16000 },
    ring: 0.2,
    pan: -0.2,
    unpitched: true,
  },
  // --- Caves ---

  /** Glass harmonica: a few pure partials swelling in slowly, a slight waver. Ghostly. */
  glass: {
    synth: { kind: 'sustain', roots: [67, 79], dur: 1, onset: 0.3, harmonics: 4, rolloff: 0.7, breath: 0.01, vib: 5, vibRate: 4, chorus: 1, srCap: 22050 },
    ring: 0,
    pan: 0.1,
    loop: true,
    attack: 0.6,
    release: 1.3,
  },
  /**
   * Singing saw: an almost pure tone that swells in from nothing and wavers with a wide, slow-ish
   * vibrato. The classic ghostly sound (old horror films, theremin-like), but soft.
   */
  saw: {
    synth: { kind: 'sustain', roots: [67, 79], dur: 1, onset: 0.4, harmonics: 3, rolloff: 0.6, breath: 0.012, vib: 30, vibRate: 5, srCap: 22050 },
    ring: 0,
    pan: -0.15,
    loop: true,
    attack: 0.4,
    release: 0.9,
  },
  /** A water drop into a pool: a tiny bubble whose pitch rises as it rings. */
  drip: {
    synth: { kind: 'modal', roots: [84], dur: 0.45, click: 0.02, clickTone: 0.9, drop: -0.45, dropTau: 0.025, modes: [[1, 1, 0.09], [2.4, 0.08, 0.03]] },
    ring: 0.35,
    pan: -0.3,
  },
  drum: {
    synth: { kind: 'drum', roots: [45], dur: 0.7, click: 0.35, modes: [[1, 1, 0.22], [1.59, 0.4, 0.12], [2.14, 0.25, 0.08], [2.3, 0.15, 0.06]], srCap: 16000 },
    ring: 0.5,
    pan: 0,
  },

  // --- Danger: a hybrid action kit (big drums, short strings, brass) ---

  /** Taiko: a huge low drum, the pitch sagging after the strike. */
  taiko: {
    synth: { kind: 'drum', roots: [38], dur: 1.3, drop: 0.35, dropTau: 0.045, click: 0.55, clickTone: 0.25, modes: [[1, 1, 0.42], [1.48, 0.32, 0.2], [2.02, 0.18, 0.11], [2.86, 0.08, 0.06]], snap: 0.12, snapTau: 0.05, snapTone: 0.2, srCap: 16000 },
    ring: 0.8,
    pan: 0,
  },
  /** Sub hit: the boom when the player is spotted. */
  boom: {
    synth: { kind: 'drum', roots: [26], dur: 2.6, drop: 1.1, dropTau: 0.11, click: 0.7, clickTone: 0.2, modes: [[1, 1, 1.1], [1.5, 0.25, 0.4], [2.3, 0.08, 0.15]], snap: 0.35, snapTau: 0.35, snapTone: 0.1, srCap: 16000 },
    ring: 2.4,
    pan: 0,
  },
  /** Low toms for the driving 3+3+2 groove. */
  tom: {
    synth: { kind: 'drum', roots: [45, 52], dur: 0.8, drop: 0.25, dropTau: 0.035, click: 0.45, clickTone: 0.35, modes: [[1, 1, 0.26], [1.6, 0.3, 0.11], [2.3, 0.12, 0.05]], srCap: 16000 },
    ring: 0.55,
    pan: -0.25,
  },
  /** Snare: tight skin and a burst of wires. */
  snare: {
    synth: { kind: 'drum', roots: [57], dur: 0.45, drop: 0.12, dropTau: 0.02, click: 0.5, clickTone: 0.7, modes: [[1, 0.6, 0.07], [1.72, 0.3, 0.04]], snap: 1.5, snapTau: 0.11, snapTone: 0.7 },
    ring: 0.35,
    pan: 0.15,
    unpitched: true,
  },
  /** Closed hi-hat tick (also the suspense clock). */
  tick: {
    synth: { kind: 'noise', roots: [60], dur: 0.08, rise: 0.0008, tau: 0.012, dark: 0 },
    ring: 0.05,
    pan: 0.35,
    unpitched: true,
  },
  /** Short bowed strings (spiccato): the action ostinato. A bright bow bite, no vibrato. */
  spiccato: {
    synth: { kind: 'sustain', roots: [43, 55, 67], dur: 0.5, onset: 0.04, harmonics: 18, rolloff: 5, breath: 0.07, vib: 0, chorus: 2, chiff: 0.7, formant: [520, 1.2], srCap: 22050 },
    ring: 0,
    pan: -0.1,
    loop: true,
    attack: 0.006,
    release: 0.07,
  },
  /** Brass section: bright, brassy stabs and held horn lines. */
  brass: {
    synth: { kind: 'sustain', roots: [43, 55, 67], dur: 0.5, onset: 0.08, harmonics: 20, rolloff: 7, breath: 0.03, vib: 4, vibRate: 5, chorus: 2, chiff: 0.25, formant: [1100, 1.6], srCap: 22050 },
    ring: 0,
    pan: 0.15,
    loop: true,
    attack: 0.045,
    release: 0.2,
  },
};

/**
 * How a song may colour a patch. All are optional; numbers are multipliers unless noted.
 * - bright: brighter (>1) or darker (<1) tone
 * - decay: longer (>1) or shorter (<1) ring / string
 * - pan: stereo position (absolute, -1..1)
 * - attack, release: seconds (sustained patches)
 * - vib: vibrato in cents (absolute); breath: breath or bow noise (multiplier)
 */
export interface Tone {
  bright?: number;
  decay?: number;
  pan?: number;
  attack?: number;
  release?: number;
  vib?: number;
  breath?: number;
}

const TONE_KEYS: (keyof Tone)[] = ['attack', 'breath', 'bright', 'decay', 'pan', 'release', 'vib'];

/** The patch name for `base` coloured with `tone` (the base name itself if the tone changes nothing). */
export function tonedName(base: string, tone: Tone | undefined): string {
  if (!tone) return base;
  const parts = TONE_KEYS.filter((k) => typeof tone[k] === 'number').map((k) => `${k}=${+tone[k]!.toFixed(3)}`);
  return parts.length ? `${base}~${parts.join(',')}` : base;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function applyTone(base: Patch, t: Tone): Patch {
  const s: SynthParams = { ...base.synth };
  const p: Patch = { ...base, synth: s };
  const b = t.bright ?? 1, d = t.decay ?? 1;
  if (b !== 1) {
    if (s.kind === 'ks') s.bright = clamp((s.bright ?? 0.5) * b, 0.05, 1);
    if (s.kind === 'modal' || s.kind === 'drum') {
      s.modes = s.modes?.map(([r, a, tau], i) => [r, i === 0 || r < 1.5 ? a : a * Math.pow(b, Math.log2(r) * 0.8), tau]);
      s.click = (s.click ?? 0) * b;
    }
    if (s.kind === 'pad' || s.kind === 'sustain') s.rolloff = (s.rolloff ?? 2.5) * b;
    if (s.kind === 'noise') s.dark = clamp((s.dark ?? 0.3) / b, 0, 0.95);
  }
  if (d !== 1) {
    if (s.kind === 'ks') s.t60 = (s.t60 ?? 1.7) * d;
    if (s.kind === 'modal' || s.kind === 'drum') s.modes = s.modes?.map(([r, a, tau]) => [r, a, tau * d]);
    if (s.kind === 'noise') s.tau = (s.tau ?? 0.035) * d;
    // One-shots keep a longer tail (up to 1.6x memory); loops do not grow
    if (s.kind !== 'pad' && s.kind !== 'sustain') {
      s.dur = s.dur * clamp(d, 0.5, 1.6);
      p.ring = base.ring * d;
    }
  }
  if (t.vib !== undefined) s.vib = t.vib;
  if (t.breath !== undefined) s.breath = (s.breath ?? 0) * t.breath;
  if (t.pan !== undefined) p.pan = clamp(t.pan, -1, 1);
  if (t.attack !== undefined) p.attack = t.attack;
  if (t.release !== undefined) p.release = t.release;
  return p;
}

const variants = new Map<string, Patch | null>();

/** A patch by name, base (`harp`) or toned variant (`harp~bright=0.7,decay=1.3`). */
export function getPatch(name: string): Patch | undefined {
  const direct = PATCHES[name];
  if (direct) return direct;
  if (!variants.has(name)) {
    const [base, spec] = name.split('~');
    let v: Patch | null = null;
    if (PATCHES[base] && spec) {
      const tone: Tone = {};
      for (const kv of spec.split(',')) {
        const [k, val] = kv.split('=');
        if ((TONE_KEYS as string[]).includes(k) && Number.isFinite(Number(val))) tone[k as keyof Tone] = Number(val);
      }
      v = applyTone(PATCHES[base], tone);
    }
    variants.set(name, v);
  }
  return variants.get(name) ?? undefined;
}
