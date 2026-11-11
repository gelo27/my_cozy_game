import { compileSong, type CompiledSong, type SongJson } from './SongFormat';

/**
 * Every song in ./songs. The JSON is tiny (a few KB per track), so it ships in the bundle; each song
 * is compiled the first time the director wants it. A file holds one song or an array of them.
 */
const files = import.meta.glob<SongJson | SongJson[]>('./songs/*.json', { eager: true, import: 'default' });

const raw: SongJson[] = Object.values(files).flatMap((f) => (Array.isArray(f) ? f : [f]));
const compiled = new Map<string, CompiledSong | null>();

export const songIds: readonly string[] = raw.map((s) => s.id);

export function songMeta(id: string): SongJson | undefined {
  return raw.find((s) => s.id === id);
}

/** Songs of a kind whose mood list passes `test`. */
export function findSongs(kind: SongJson['kind'], test: (mood: readonly string[]) => boolean): SongJson[] {
  return raw.filter((s) => s.kind === kind && test(s.mood ?? []));
}

export function getSong(id: string): CompiledSong | null {
  if (!compiled.has(id)) {
    const src = songMeta(id);
    let c: CompiledSong | null = null;
    try {
      c = src ? compileSong(src) : null;
    } catch (err) {
      console.warn(`Music: song "${id}" does not compile:`, err);
    }
    compiled.set(id, c);
  }
  return compiled.get(id) ?? null;
}
