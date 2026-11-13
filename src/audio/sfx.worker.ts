import { renderTreeSound, type TreeSoundKind } from './TreeSounds';
import { renderFoleySound, type FoleySoundKind } from './FoleySounds';
import { render as renderStep, SYNTH_RATE, type Kind as StepKind } from './FootstepSynth';
import type { SfxBankId } from './SfxRender';

/**
 * Renders pre-synthesised sound effects off the main thread (woodcutting, foley, footsteps); the
 * samples are handed back without copying. The recipes are the same pure functions the main thread
 * falls back to when workers are unavailable.
 */
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; bank: SfxBankId; kind: string; index: number }>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const { id, bank, kind, index } = e.data;
  try {
    let res: { data: Float32Array; rate: number };
    if (bank === 'tree') res = renderTreeSound(kind as TreeSoundKind, index);
    else if (bank === 'foley') res = renderFoleySound(kind as FoleySoundKind, index);
    else res = { data: renderStep(kind as StepKind, SYNTH_RATE), rate: SYNTH_RATE };
    ctx.postMessage({ id, ok: true, data: res.data, rate: res.rate }, [res.data.buffer]);
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String(err) }, []);
  }
};
