import { synthesize, type SynthRequest } from './synth';

/** Renders instrument samples off the main thread; buffers are handed back without copying. */
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; req: SynthRequest }>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const { id, req } = e.data;
  try {
    const res = synthesize(req);
    const transfer: Transferable[] = res.samples.map((s) => s.data.buffer);
    if (res.ir) for (const d of res.ir) transfer.push(d.buffer);
    ctx.postMessage({ id, ok: true, res }, transfer);
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String(err) }, []);
  }
};
