import caveGenSource from './CaveGen.ts?raw';
import type { CaveGenRequest, CavePlan, CaveMeshResult } from './CaveGen';

/**
 * The last full cave build kept in IndexedDB, so the next start loads its meshes instead of
 * generating them. Keyed by a hash of the generator's own source and the build request (seed,
 * entrances, layout, coast): any change to either makes a fresh build, which replaces the entry.
 * Only one build is kept (~6 MB). Every failure just means "no cache".
 */
const DB = 'farm-cave-cache';
const STORE = 'build';

interface Meta {
  key: string;
  slices: number;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function get<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function caveCacheKey(req: CaveGenRequest): Promise<string | null> {
  try {
    let coast = 0;
    for (let i = 0; i < req.coast.length; i++) coast += req.coast[i] * (i + 1);
    const text = caveGenSource + JSON.stringify({ seed: req.seed, entrances: req.entrances, layout: req.layout ?? null, coast });
    const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** Several records in one read transaction (requests run concurrently). */
function getMany(db: IDBDatabase, keys: string[]): Promise<unknown[] | null> {
  return new Promise((resolve) => {
    try {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      const out: unknown[] = new Array(keys.length);
      let left = keys.length;
      if (!left) return resolve(out);
      keys.forEach((k, i) => {
        const r = store.get(k);
        r.onsuccess = () => {
          out[i] = r.result;
          if (--left === 0) resolve(out);
        };
        r.onerror = () => resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** The cached build for this key, or null. */
export async function loadCaveCache(key: string): Promise<{ plan: CavePlan; slices: CaveMeshResult[] } | null> {
  const db = await open();
  if (!db) return null;
  try {
    const meta = await get<Meta>(db, 'meta');
    if (!meta || meta.key !== key) return null;
    const keys = ['plan', ...Array.from({ length: meta.slices }, (_, i) => `s${i}`)];
    const all = await getMany(db, keys);
    if (!all || all.some((v) => !v)) return null;
    return { plan: all[0] as CavePlan, slices: all.slice(1) as CaveMeshResult[] };
  } finally {
    db.close();
  }
}

/**
 * Collects one build as it arrives (each part is copied into the store when handed over, so the
 * caller may release its arrays right after) and marks it complete at the end.
 */
export class CaveCacheWriter {
  private db: IDBDatabase | null = null;
  private slices = 0;
  private failed = false;
  private readonly ready: Promise<void>;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly key: string) {
    this.ready = open().then((db) => {
      this.db = db;
      if (!db) return;
      return new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => {
            this.failed = true;
            resolve();
          };
        } catch {
          this.failed = true;
          resolve();
        }
      });
    });
  }

  private put(key: string, value: unknown): void {
    // structuredClone now: the arrays go to the GPU and are dropped before the store opens
    let copy: unknown;
    try {
      copy = structuredClone(value);
    } catch {
      this.failed = true;
      return;
    }
    this.chain = this.chain.then(() => this.ready).then(
      () =>
        new Promise<void>((resolve) => {
          if (!this.db || this.failed) return resolve();
          try {
            const tx = this.db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(copy, key);
            tx.oncomplete = () => resolve();
            tx.onerror = tx.onabort = () => {
              this.failed = true;
              resolve();
            };
          } catch {
            this.failed = true;
            resolve();
          }
        })
    );
  }

  public plan(plan: CavePlan): void {
    this.put('plan', plan);
  }

  public slice(s: CaveMeshResult): void {
    this.put(`s${this.slices++}`, s);
  }

  /** Writes the marker that makes the entry usable, then closes the store. */
  public finish(): void {
    const meta: Meta = { key: this.key, slices: this.slices };
    this.put('meta', meta);
    void this.chain.then(() => {
      this.db?.close();
      this.db = null;
    });
  }

  public abort(): void {
    this.failed = true;
    void this.chain.then(() => {
      this.db?.close();
      this.db = null;
    });
  }
}
