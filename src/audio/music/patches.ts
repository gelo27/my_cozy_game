/**
 * Instrument patches. `synth` is what the worker renders once into small mono buffers (one per
 * root note); the rest is how the sequencer plays them back (one buffer source and one gain per note).
 *
 * Only struck and plucked sounds plus pads: those are the ones synthesis gets truly natural.
 */

export type SynthKind = 'modal' | 'ks' | 'bass' | 'pad' | 'noise' | 'drum';

export interface SynthParams {
  kind: SynthKind;
  /** MIDI notes rendered; playback picks the nearest and shifts the pitch. */
  roots: number[];
  /** Seconds rendered per root (pads: loop length). */
  dur: number;
  /** modal / drum: [frequency ratio, amplitude, decay seconds]. */
  modes?: [number, number, number][];
  /** modal / drum: strength of the attack transient. */
  click?: number;
  /** ks: seconds to fall 60 dB; brightness of the pluck 0..1. */
  t60?: number;
  bright?: number;
  /** pad: number of harmonics and their roll-off. */
  harmonics?: number;
  rolloff?: number;
  /** Highest sample rate worth rendering at (dull sounds save memory at 16 kHz). */
  srCap?: number;
}

export interface Patch {
  synth: SynthParams;
  /** One-shots ring this long past the written note length (capped by the sample). */
  ring: number;
  pan: number;
  /** Looping sustain (pads): attack and release in seconds. */
  loop?: boolean;
  attack?: number;
  release?: number;
  /** Plays at its rendered pitch whatever the note (shaker). */
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
  bass: {
    synth: { kind: 'bass', roots: [38, 50], dur: 1.6, srCap: 16000 },
    ring: 0.15,
    pan: 0,
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
  drum: {
    synth: { kind: 'drum', roots: [45], dur: 0.7, click: 0.35, modes: [[1, 1, 0.22], [1.59, 0.4, 0.12], [2.14, 0.25, 0.08], [2.3, 0.15, 0.06]], srCap: 16000 },
    ring: 0.5,
    pan: 0,
  },
};
