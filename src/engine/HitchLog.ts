/**
 * Dev-only hitch logger: the frame loop drops timestamps between its stages, and when the gap to
 * the next frame is long the previous frame's breakdown goes to the browser console. It says
 * whether the time went into the game's own frame (which stage), a React commit, a GC, or
 * somewhere outside the game (GPU, browser, extensions).
 * No allocations unless a hitch is printed.
 */
const STAGES = ['input+rides', 'physics', 'character', 'world', 'foliage', 'farm', 'rest', 'render', 'ui'] as const;
const THRESHOLD_MS = 35;

const enabled = import.meta.env.DEV;
const marks = new Float64Array(STAGES.length + 1);
let lastFrameAt = 0;
let lastHeap = 0;
let reactPushes = 0;
const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;

export const hitchLog = {
  /** Start of a frame (rAF timestamp); reports the previous frame when the gap is long. */
  begin(now: number): void {
    if (!enabled) return;
    const gap = now - lastFrameAt;
    const heap = mem ? mem.usedJSHeapSize : 0;
    if (lastFrameAt > 0 && gap > THRESHOLD_MS && marks[STAGES.length] > 0) {
      const work = marks[STAGES.length] - marks[0];
      const parts: string[] = [];
      for (let i = 0; i < STAGES.length; i++) {
        const ms = marks[i + 1] - marks[i];
        if (ms >= 0.5) parts.push(`${STAGES[i]} ${ms.toFixed(1)}`);
      }
      const gc = mem && heap < lastHeap - 512 * 1024 ? ` | GC freed ${((lastHeap - heap) / 1048576).toFixed(1)} MB` : '';
      console.warn(
        `[hitch] ${gap.toFixed(0)} ms between frames | game frame ${work.toFixed(1)} ms (${parts.join(', ')})` +
          ` | outside the frame ${(gap - work).toFixed(0)} ms` +
          `${reactPushes ? ` | React updates pushed: ${reactPushes}` : ''}${gc}`
      );
    }
    lastFrameAt = now;
    lastHeap = heap;
    reactPushes = 0;
    marks.fill(0);
  },
  /** Timestamp after stage `i` (0 = frame start). */
  mark(i: number): void {
    if (enabled) marks[i] = performance.now();
  },
  /** A callback into React went out this frame. */
  react(): void {
    reactPushes++;
  },
};
