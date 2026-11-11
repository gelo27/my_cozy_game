/**
 * Compact song format (v2) and its compiler.
 *
 * Notes are written as scale degrees, not frequencies: `"4:9:2:5"` is step 4, degree 9, two steps
 * long, velocity 5/9. A pattern is one bar. Sequences reuse patterns with a diatonic shift
 * (`a>-2` turns a D chord arpeggio into Bm), repeats (`a*4`) and rests (`-`, `-*3`).
 *
 * A song is a set of sections (each maps part ids to sequences) and a `form` that orders them, so a
 * 2:30 track costs little more than a 1:30 one. Inside a section a shorter sequence loops up to the
 * section's longest one.
 */

export type SongKind = 'track' | 'stinger' | 'loop' | 'motif';

export interface SongPartDef {
  /** Patch name (see patches.ts). */
  i: string;
  /** Director-controlled layer (e.g. 'night', 'attack'); parts without one always sound. */
  layer?: string;
  vol?: number;
  /** Octave shift. */
  oct?: number;
}

export interface SongJson {
  v: 2;
  id: string;
  kind: SongKind;
  title?: string;
  /** Where the director may pick it: time slots, weather types, 'cave', 'danger', or an event id for stingers. */
  mood?: string[];
  bpm: number;
  /** Steps per bar (16 for 4/4 in sixteenths, 12 for 3/4 or 6/8). */
  steps: number;
  /** MIDI note of degree 0. */
  root: number;
  scale: number[];
  /** Overall level of this song (default 1). */
  gain?: number;
  parts: Record<string, SongPartDef>;
  pat: Record<string, string>;
  sections: Record<string, Record<string, string>>;
  form: string;
}

export interface NoteEvent {
  part: number;
  patch: string;
  midi: number;
  /** Length in steps. */
  len: number;
  vel: number;
}

export interface CompiledSong {
  id: string;
  kind: SongKind;
  title: string;
  mood: readonly string[];
  gain: number;
  stepDur: number;
  steps: number;
  total: number;
  /** Notes starting at each step. */
  table: NoteEvent[][];
  parts: { patch: string; layer: string | null }[];
  /** Step index where each section of the form starts (first is 0). */
  sectionStarts: number[];
  /** Every patch the song needs. */
  patches: string[];
  /** Length in seconds. */
  duration: number;
}

const TOKEN = /^([A-Za-z0-9_-]+?)(?:>(-?\d+))?(?:\*(\d+))?$/;

export function compileSong(song: SongJson): CompiledSong {
  const L = song.scale.length;
  const degToMidi = (d: number) => {
    const o = Math.floor(d / L);
    return song.root + 12 * o + song.scale[d - o * L];
  };
  const pats = new Map<string, { st: number; dg: number; len: number; vel: number }[]>();
  for (const [k, s] of Object.entries(song.pat)) {
    pats.set(
      k,
      s.trim().split(/\s+/).map((tok) => {
        const [st, dg, len, vel] = tok.split(':').map(Number);
        if (!Number.isFinite(st) || !Number.isFinite(dg) || st < 0 || st >= song.steps) throw new Error(`${song.id}: bad note "${tok}" in ${k}`);
        return { st, dg, len: len || 1, vel: (vel || 7) / 9 };
      })
    );
  }
  const partIds = Object.keys(song.parts);
  const parts = partIds.map((id) => ({ patch: song.parts[id].i, layer: song.parts[id].layer ?? null }));

  const expand = (seq: string): ({ pat: string; tr: number } | null)[] => {
    const bars: ({ pat: string; tr: number } | null)[] = [];
    for (const tok of seq.trim().split(/\s+/)) {
      const m = TOKEN.exec(tok);
      if (!m) throw new Error(`${song.id}: bad token "${tok}"`);
      if (m[1] !== '-' && !pats.has(m[1])) throw new Error(`${song.id}: unknown pattern "${m[1]}"`);
      for (let r = 0; r < (Number(m[3]) || 1); r++) bars.push(m[1] === '-' ? null : { pat: m[1], tr: Number(m[2]) || 0 });
    }
    return bars;
  };

  const sections = new Map<string, { bars: number; seqs: Map<number, ({ pat: string; tr: number } | null)[]> }>();
  for (const [name, sec] of Object.entries(song.sections)) {
    const seqs = new Map<number, ({ pat: string; tr: number } | null)[]>();
    let bars = 0;
    for (const [pid, seq] of Object.entries(sec)) {
      const pi = partIds.indexOf(pid);
      if (pi < 0) throw new Error(`${song.id}: section ${name} uses unknown part "${pid}"`);
      const b = expand(seq);
      seqs.set(pi, b);
      bars = Math.max(bars, b.length);
    }
    sections.set(name, { bars, seqs });
  }

  const form = song.form.trim().split(/\s+/);
  const totalBars = form.reduce((a, n) => {
    const s = sections.get(n);
    if (!s) throw new Error(`${song.id}: unknown section "${n}" in form`);
    return a + s.bars;
  }, 0);
  const total = totalBars * song.steps;
  const table: NoteEvent[][] = Array.from({ length: total }, () => []);
  const sectionStarts: number[] = [];
  let bar0 = 0;
  for (const name of form) {
    const sec = sections.get(name)!;
    sectionStarts.push(bar0 * song.steps);
    for (const [pi, bars] of sec.seqs) {
      const def = song.parts[partIds[pi]];
      for (let b = 0; b < sec.bars; b++) {
        const bar = bars[b % bars.length];
        if (!bar) continue;
        for (const n of pats.get(bar.pat)!) {
          table[(bar0 + b) * song.steps + n.st].push({
            part: pi,
            patch: def.i,
            midi: degToMidi(n.dg + bar.tr) + 12 * (def.oct ?? 0),
            len: n.len,
            vel: n.vel * (def.vol ?? 1),
          });
        }
      }
    }
    bar0 += sec.bars;
  }
  const stepDur = 60 / song.bpm / 4;
  return {
    id: song.id,
    kind: song.kind,
    title: song.title ?? song.id,
    mood: song.mood ?? [],
    gain: song.gain ?? 1,
    stepDur,
    steps: song.steps,
    total,
    table,
    parts,
    sectionStarts,
    patches: [...new Set(parts.map((p) => p.patch))],
    duration: total * stepDur,
  };
}
