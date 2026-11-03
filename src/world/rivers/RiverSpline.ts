import type { RiverDef, RiverSample, SampledRiver, WaterfallInfo } from './RiverTypes';

/** Centre-line sample spacing (m). The terrain grid is 1 m, so finer buys nothing. */
const STEP = 1;
/** How far beyond the channel edge the banks are shaped (m). */
export const BANK = 14;
/** The auto surface sits this far below the natural ground. */
const SURFACE_BELOW_GROUND = 0.3;
/** Drops at least this tall (m) count as a waterfall (mist, sound). */
const MIN_FALL = 1.2;

function smoothstep(x: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Centripetal Catmull-Rom between p1 and p2 (no loops or cusps at sharp turns). */
function catmullRom(
  p0x: number, p0z: number, p1x: number, p1z: number, p2x: number, p2z: number, p3x: number, p3z: number,
  t: number, out: { x: number; z: number }
): void {
  const k = (ax: number, az: number, bx: number, bz: number) => Math.max(1e-4, Math.sqrt(Math.hypot(bx - ax, bz - az)));
  const t0 = 0;
  const t1 = t0 + k(p0x, p0z, p1x, p1z);
  const t2 = t1 + k(p1x, p1z, p2x, p2z);
  const t3 = t2 + k(p2x, p2z, p3x, p3z);
  const u = t1 + (t2 - t1) * t;
  const lerp = (a: number, b: number, ta: number, tb: number) => (ta === tb ? a : a + ((b - a) * (u - ta)) / (tb - ta));
  const a1x = lerp(p0x, p1x, t0, t1), a1z = lerp(p0z, p1z, t0, t1);
  const a2x = lerp(p1x, p2x, t1, t2), a2z = lerp(p1z, p2z, t1, t2);
  const a3x = lerp(p2x, p3x, t2, t3), a3z = lerp(p2z, p3z, t2, t3);
  const b1x = lerp(a1x, a2x, t0, t2), b1z = lerp(a1z, a2z, t0, t2);
  const b2x = lerp(a2x, a3x, t1, t3), b2z = lerp(a2z, a3z, t1, t3);
  out.x = lerp(b1x, b2x, t1, t2);
  out.z = lerp(b1z, b2z, t1, t2);
}

/**
 * Turns the control points into ~1 m samples with a water surface profile:
 * - the surface follows the natural ground (minus 0.3 m) but never flows uphill, so a river cuts
 *   a valley through any rise in its way;
 * - a point's `fall` drops the surface by that much right there (everything below is cut deeper,
 *   which leaves a gorge under the waterfall);
 * - pinned `y` values hold the surface (a lake level or a weir), raising banks when needed;
 * - the surface never goes below the sea, and fades out where it meets it.
 */
export function sampleRiver(def: RiverDef, groundAt: (x: number, z: number) => number, sea: number): SampledRiver {
  const pts = def.points;
  const samples: RiverSample[] = [];
  const pointSample: number[] = [];
  const out: SampledRiver = { def, samples, pointSample, falls: [], minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  if (pts.length < 2) {
    if (pts.length === 1) pointSample.push(0);
    return out;
  }

  // 1. Centre line
  const p = { x: 0, z: 0 };
  const width = (i: number) => Math.max(0.6, pts[i].w ?? def.width);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const pa = i > 0 ? pts[i - 1] : { x: 2 * a.x - b.x, z: 2 * a.z - b.z };
    const pb = i + 2 < pts.length ? pts[i + 2] : { x: 2 * b.x - a.x, z: 2 * b.z - a.z };
    let len = 0;
    let px = a.x, pz = a.z;
    for (let j = 1; j <= 16; j++) {
      catmullRom(pa.x, pa.z, a.x, a.z, b.x, b.z, pb.x, pb.z, j / 16, p);
      len += Math.hypot(p.x - px, p.z - pz);
      px = p.x;
      pz = p.z;
    }
    const n = Math.max(1, Math.ceil(len / STEP));
    pointSample.push(samples.length);
    const last = i === pts.length - 2;
    for (let j = 0; j < n + (last ? 1 : 0); j++) {
      const t = j / n;
      catmullRom(pa.x, pa.z, a.x, a.z, b.x, b.z, pb.x, pb.z, t, p);
      const w = width(i) + (width(i + 1) - width(i)) * t;
      const depthScale = Math.min(1.4, Math.max(0.5, w / Math.max(0.6, def.width)));
      samples.push({ x: p.x, z: p.z, s: 0, hw: w / 2, depth: def.depth * depthScale, tx: 0, tz: 1, dist: 0, foam: 0, alpha: 1 });
    }
  }
  pointSample.push(samples.length - 1);
  const S = samples.length;

  // 2. Distances and tangents
  for (let k = 0; k < S; k++) {
    const a = samples[Math.max(0, k - 1)], b = samples[Math.min(S - 1, k + 1)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    samples[k].tx = (b.x - a.x) / l;
    samples[k].tz = (b.z - a.z) / l;
    if (k > 0) samples[k].dist = samples[k - 1].dist + Math.hypot(samples[k].x - samples[k - 1].x, samples[k].z - samples[k - 1].z);
  }

  // 3. Surface profile
  const pin = new Map<number, number>();
  const fall = new Map<number, number>();
  pts.forEach((pt, i) => {
    if (pt.y !== undefined) pin.set(pointSample[i], pt.y);
    if (pt.fall && pt.fall > 0 && i > 0) fall.set(pointSample[i], pt.fall);
  });
  for (let k = 0; k < S; k++) {
    const q = samples[k];
    // The lowest of the centre and both sides, so the water never floats above a bank
    const nx = -q.tz * q.hw * 0.6, nz = q.tx * q.hw * 0.6;
    const ground = Math.min(groundAt(q.x, q.z), groundAt(q.x + nx, q.z + nz), groundAt(q.x - nx, q.z - nz));
    let v = ground - SURFACE_BELOW_GROUND;
    const pinned = pin.get(k);
    if (pinned !== undefined) v = pinned;
    if (k > 0) {
      const prev = samples[k - 1].s;
      v = Math.min(v, prev - (fall.get(k) ?? 0));
    }
    q.s = v;
  }
  // Pinned levels also hold the water up behind them
  let floor = -Infinity;
  for (let k = S - 1; k >= 0; k--) {
    if (pin.has(k)) floor = samples[k].s;
    samples[k].s = Math.max(samples[k].s, floor, sea + 0.03);
  }

  // 4. White water, plunge pools and waterfalls
  for (let k = 1; k < S; k++) {
    const a = samples[k - 1], b = samples[k];
    const run = Math.max(0.2, b.dist - a.dist);
    const slope = (a.s - b.s) / run;
    const f = smoothstep(slope, 0.3, 0.9);
    a.foam = Math.max(a.foam, f);
    b.foam = Math.max(b.foam, f);
  }
  let k = 1;
  while (k < S) {
    // A run of steep steps is one waterfall
    const steep = (i: number) => samples[i - 1].s - samples[i].s > 0.85 * Math.max(0.2, samples[i].dist - samples[i - 1].dist);
    if (!steep(k)) {
      k++;
      continue;
    }
    const start = k - 1;
    while (k < S && steep(k)) k++;
    const end = k - 1;
    const top = samples[start].s, bottom = samples[end].s;
    const drop = top - bottom;
    if (drop >= MIN_FALL) {
      const foot = samples[end];
      out.falls.push({ x: foot.x, z: foot.z, top, bottom, width: foot.hw * 2, tx: foot.tx, tz: foot.tz });
      // Plunge pool: deeper and wider just below, churning white water for a few metres
      for (let j = 0; j < 7 && end + j < S; j++) {
        const q = samples[end + j];
        const w = 1 - j / 7;
        q.depth += Math.min(drop * 0.25, 1.4) * w;
        q.hw *= 1 + 0.3 * w;
        q.foam = Math.max(q.foam, w);
      }
    }
  }

  // 5. Fade the ribbon in at the source and out at the mouth / into the sea
  const total = samples[S - 1].dist;
  for (const q of samples) {
    q.alpha = Math.min(1, q.dist / 3, (total - q.dist) / 3, smoothstep(q.s, sea + 0.04, sea + 0.3));
  }

  // 6. Bounds
  for (const q of samples) {
    const r = q.hw + BANK + 2;
    out.minX = Math.min(out.minX, q.x - r);
    out.maxX = Math.max(out.maxX, q.x + r);
    out.minZ = Math.min(out.minZ, q.z - r);
    out.maxZ = Math.max(out.maxZ, q.z + r);
  }
  return out;
}
