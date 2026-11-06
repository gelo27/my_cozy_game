import { planCaveNetwork, meshCaveChunks, CaveGenRequest, CaveMeshJob } from './CaveGen';

/**
 * Cave builder off the main thread. One worker plans a build (layout, water, contents and the list
 * of chunks); then several workers mesh slices of that list at once. Buffers are handed back
 * without copying. Each message carries an `id` that the reply echoes.
 */
type Msg = { id: number; type: 'plan'; req: CaveGenRequest } | { id: number; type: 'mesh'; job: CaveMeshJob };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Msg>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'plan') {
      const plan = planCaveNetwork(msg.req);
      const transfer: Transferable[] = [plan.water.buffer, plan.waterBiome.buffer, plan.drips.buffer];
      for (const p of plan.pools) transfer.push(p.mask.buffer);
      ctx.postMessage({ id: msg.id, ok: true, plan }, transfer);
    } else {
      const mesh = meshCaveChunks(msg.job);
      const transfer: Transferable[] = [];
      for (const c of mesh.chunks) transfer.push(c.positions.buffer, c.normals.buffer, c.data.buffer, c.wet.buffer, c.indices.buffer);
      ctx.postMessage({ id: msg.id, ok: true, mesh }, transfer);
    }
  } catch (err) {
    ctx.postMessage({ id: msg.id, ok: false, error: String(err) }, []);
  }
};
