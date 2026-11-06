import { generateCaveNetwork, CaveGenInput, CaveGenOutput } from './CaveGen';

/** Builds the cave network off the main thread and hands the buffers back without copying them. */
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<CaveGenInput>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  try {
    const out: CaveGenOutput = generateCaveNetwork(e.data);
    const transfer: Transferable[] = [out.water.buffer, out.drips.buffer];
    for (const c of out.chunks) transfer.push(c.positions.buffer, c.normals.buffer, c.data.buffer, c.indices.buffer);
    for (const p of out.pools) transfer.push(p.mask.buffer);
    ctx.postMessage({ ok: true, out }, transfer);
  } catch (err) {
    ctx.postMessage({ ok: false, error: String(err) }, []);
  }
};
