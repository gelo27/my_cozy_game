import { getPatch } from './patches';
import { synthesize, type SpaceName, type SynthRequest, type SynthResult } from './synth';

interface BankSample {
  buffer: AudioBuffer;
  rootFreq: number;
  loopStart: number;
}

/**
 * Rendered instrument samples. Patches are synthesised on demand in a worker (main thread only if
 * no worker can start), kept while in use, and the least recently used ones are dropped once the
 * memory budget is passed. Pinned patches (the danger loop's) are never dropped, so it starts at once.
 */
export class InstrumentBank {
  private readonly samples = new Map<string, BankSample[]>();
  private readonly bytes = new Map<string, number>();
  private readonly lastUse = new Map<string, number>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly pinned = new Set<string>();
  private worker: Worker | null = null;
  private workerFailed = false;
  private nextId = 1;
  private readonly replies = new Map<number, { resolve: (r: SynthResult) => void; reject: (e: unknown) => void }>();
  /** Last render time (ms) and where it ran, for the developer panel. */
  public lastRenderMs = 0;
  public renderedOn: 'worker' | 'main' | '' = '';

  constructor(
    private readonly ctx: AudioContext,
    private readonly sampleRate: number,
    private readonly budgetBytes: number
  ) {}

  public get totalBytes(): number {
    let t = 0;
    for (const b of this.bytes.values()) t += b;
    return t;
  }

  public has(patch: string): boolean {
    return this.samples.has(patch);
  }

  public pin(patches: Iterable<string>): void {
    for (const p of patches) this.pinned.add(p);
  }

  /** Nearest rendered root for a frequency (null if the patch is not ready). */
  public pick(patch: string, freq: number): BankSample | null {
    const list = this.samples.get(patch);
    if (!list) return null;
    this.lastUse.set(patch, performance.now());
    let best = list[0];
    for (const s of list) if (Math.abs(Math.log(freq / s.rootFreq)) < Math.abs(Math.log(freq / best.rootFreq))) best = s;
    return best;
  }

  /** Renders whatever of `patches` is missing. `inUse` are kept even when over budget. */
  public ensure(patches: readonly string[], inUse: ReadonlySet<string>): Promise<void> {
    const now = performance.now();
    for (const p of patches) this.lastUse.set(p, now);
    const missing = patches.filter((p) => !this.samples.has(p) && !this.pending.has(p) && getPatch(p));
    const waits = patches.map((p) => this.pending.get(p)).filter((p): p is Promise<void> => !!p);
    if (missing.length) {
      const job = this.render(missing).then(() => {
        for (const p of missing) this.pending.delete(p);
        this.evict(new Set([...inUse, ...patches]));
      });
      for (const p of missing) this.pending.set(p, job);
      waits.push(job);
    }
    return Promise.all(waits).then(() => undefined);
  }

  /** Stereo reverb impulse for a space, at the context's rate (rendered alongside nothing else). */
  public async impulse(space: SpaceName = 'hall'): Promise<AudioBuffer> {
    const res = await this.run({ patches: [], sr: this.sampleRate, irSr: this.ctx.sampleRate, space });
    const ir = res.ir!;
    const buf = this.ctx.createBuffer(2, ir[0].length, this.ctx.sampleRate);
    buf.copyToChannel(ir[0] as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(ir[1] as Float32Array<ArrayBuffer>, 1);
    return buf;
  }

  private async render(names: string[]): Promise<void> {
    const res = await this.run({ patches: names.map((name) => ({ name, synth: getPatch(name)!.synth })), sr: this.sampleRate });
    this.lastRenderMs = res.ms;
    for (const s of res.samples) {
      const buf = this.ctx.createBuffer(1, s.data.length, s.sr);
      buf.copyToChannel(s.data as Float32Array<ArrayBuffer>, 0);
      const list = this.samples.get(s.patch) ?? [];
      list.push({ buffer: buf, rootFreq: s.rootFreq, loopStart: s.loopStart });
      this.samples.set(s.patch, list);
      this.bytes.set(s.patch, (this.bytes.get(s.patch) ?? 0) + s.data.length * 4);
    }
  }

  private evict(keep: ReadonlySet<string>): void {
    let total = this.totalBytes;
    if (total <= this.budgetBytes) return;
    const order = [...this.samples.keys()].filter((p) => !keep.has(p) && !this.pinned.has(p)).sort((a, b) => (this.lastUse.get(a) ?? 0) - (this.lastUse.get(b) ?? 0));
    for (const p of order) {
      if (total <= this.budgetBytes) break;
      total -= this.bytes.get(p) ?? 0;
      this.samples.delete(p);
      this.bytes.delete(p);
    }
  }

  private run(req: SynthRequest): Promise<SynthResult> {
    if (!this.worker && !this.workerFailed) {
      try {
        this.worker = new Worker(new URL('./synth.worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; res?: SynthResult; error?: string }>) => {
          const r = this.replies.get(e.data.id);
          if (!r) return;
          this.replies.delete(e.data.id);
          if (e.data.ok && e.data.res) r.resolve(e.data.res);
          else r.reject(new Error(e.data.error));
        };
        this.worker.onerror = () => this.failWorker();
      } catch {
        this.workerFailed = true;
      }
    }
    if (!this.worker) {
      this.renderedOn = 'main';
      return Promise.resolve(synthesize(req));
    }
    this.renderedOn = 'worker';
    const id = this.nextId++;
    return new Promise<SynthResult>((resolve, reject) => {
      this.replies.set(id, { resolve, reject });
      this.worker!.postMessage({ id, req });
    }).catch(() => {
      // A worker that cannot run (blocked, crashed) falls back to the main thread once
      this.failWorker();
      this.renderedOn = 'main';
      return synthesize(req);
    });
  }

  private failWorker(): void {
    this.workerFailed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const r of this.replies.values()) r.reject(new Error('music worker failed'));
    this.replies.clear();
  }
}
