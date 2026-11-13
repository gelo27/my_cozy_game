import { renderTreeSound, TREE_VARIANTS, TREE_WARM_ORDER, type TreeSoundKind } from './TreeSounds';
import { renderFoleySound, FOLEY_VARIANTS, FOLEY_WARM_ORDER, type FoleySoundKind } from './FoleySounds';

/** Which recipe set a render request is for. */
export type SfxBankId = 'tree' | 'foley' | 'step';

interface Rendered {
  data: Float32Array;
  rate: number;
}

// ------------------------------------------------------------------------- worker client

/** undefined: not tried yet; null: unavailable (or it failed), render on the main thread instead. */
let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, (r: Rendered | null) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const w = new Worker(new URL('./sfx.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; data?: Float32Array; rate?: number }>) => {
      const cb = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      cb?.(e.data.ok && e.data.data && e.data.rate ? { data: e.data.data, rate: e.data.rate } : null);
    };
    w.onerror = () => {
      // Broken worker: everything still waiting (and everything later) renders on the main thread
      worker = null;
      w.terminate();
      for (const cb of waiting.values()) cb(null);
      waiting.clear();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** Renders one variant in the worker; null when no worker can do it. Requests run in order. */
function renderOffThread(bank: SfxBankId, kind: string, index: number): Promise<Rendered | null> {
  const w = getWorker();
  if (!w) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, bank, kind, index });
  });
}

// ---------------------------------------------------------------------------------- bank

const idle: (cb: () => void) => void =
  typeof requestIdleCallback === 'function' ? (cb) => requestIdleCallback(cb, { timeout: 2000 }) : (cb) => setTimeout(cb, 150);

/**
 * Pre-rendered variants of a set of sounds for one audio context. `warm()` asks the sound-render
 * worker for every variant at once, so their synthesis never runs on the main thread (only the
 * copy into an AudioBuffer does); without a worker they are rendered one per idle slice instead.
 * A sound asked for before any of its variants exists is rendered on the spot (one variant).
 * Playback picks a variant, never the same one twice in a row.
 */
export class SfxBank<K extends string> {
  private readonly cache = new Map<K, AudioBuffer[]>();
  private readonly last = new Map<K, number>();
  /** Next seed index per kind: every render (worker or on the spot) is a distinct take. */
  private readonly nextIndex = new Map<K, number>();
  private warmed = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly id: SfxBankId,
    private readonly variants: Record<K, number>,
    private readonly order: readonly K[],
    private readonly render: (kind: K, index: number) => Rendered,
  ) {}

  public get(kind: K): AudioBuffer {
    const list = this.cache.get(kind);
    if (!list || list.length === 0) return this.add(kind, this.render(kind, this.takeIndex(kind)));
    let i = (Math.random() * list.length) | 0;
    if (list.length > 1 && i === this.last.get(kind)) i = (i + 1) % list.length;
    this.last.set(kind, i);
    return list[i];
  }

  /** Starts rendering every missing variant (once). */
  public warm(): void {
    if (this.warmed) return;
    this.warmed = true;
    if (!getWorker()) {
      this.warmOnMainThread();
      return;
    }
    let fellBack = false;
    for (const kind of this.order) {
      for (let n = this.count(kind); n < this.variants[kind]; n++) {
        void renderOffThread(this.id, kind, this.takeIndex(kind)).then((r) => {
          if (r) this.add(kind, r);
          else if (!fellBack) {
            fellBack = true;
            this.warmOnMainThread();
          }
        });
      }
    }
  }

  private warmOnMainThread(): void {
    const step = () => {
      const kind = this.order.find((k) => this.count(k) < this.variants[k]);
      if (!kind) return;
      this.add(kind, this.render(kind, this.takeIndex(kind)));
      setTimeout(() => idle(step), 150);
    };
    idle(step);
  }

  private count(kind: K): number {
    return this.cache.get(kind)?.length ?? 0;
  }

  private takeIndex(kind: K): number {
    const i = this.nextIndex.get(kind) ?? 0;
    this.nextIndex.set(kind, i + 1);
    return i;
  }

  private add(kind: K, r: Rendered): AudioBuffer {
    const buf = this.ctx.createBuffer(1, r.data.length, r.rate);
    buf.copyToChannel(r.data, 0);
    let list = this.cache.get(kind);
    if (!list) this.cache.set(kind, (list = []));
    if (list.length < this.variants[kind]) list.push(buf);
    return buf;
  }
}

/** Woodcutting and mining sounds (see TreeSounds). */
export class TreeSoundBank extends SfxBank<TreeSoundKind> {
  constructor(ctx: BaseAudioContext) {
    super(ctx, 'tree', TREE_VARIANTS, TREE_WARM_ORDER, renderTreeSound);
  }
}

/** Door, watering, shovel and distant-thunder sounds (see FoleySounds). */
export class FoleySoundBank extends SfxBank<FoleySoundKind> {
  constructor(ctx: BaseAudioContext) {
    super(ctx, 'foley', FOLEY_VARIANTS, FOLEY_WARM_ORDER, renderFoleySound);
  }
}
