import type { RiverDef, RiverSample, SampledRiver } from './RiverTypes';

/** Centre-line sample spacing (m). The terrain grid is 1 m, so finer buys nothing. */
const STEP = 1;
/** How far beyond the channel edge the banks are shaped (m). */
export const BANK = 14;
/** The auto surface sits this far below the natural ground. */
const SURFACE_BELOW_GROUND = 0.4;
/** Drops at least this tall (m) count as a waterfall (mist, sound). */
const MIN_FALL = 1.2;
/** The ribbon reaches this far out over the sea, fading as it blends in (m). */
const MOUTH_OUT = 10;
/** Default waterfall arc (`RiverPoint.bulge`). */
export const DEFAULT_BULGE = 0.6;

/** Another river's or lake's water near a point, for branches, confluences and lakes. */
export interface WaterNear {
  id: string;
  /** Its surface there. */
  s: number;
  /** Signed distance to its edge (m): negative inside the water. */
  edge: number;
  /** Its half width there (lakes: a large number). */
  hw: number;
  lake: boolean;
}

/** Joins reach this far out of the other water (flared banks, eased surface). */
const JOIN_REACH = 7;

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
 * - the surface follows the natural ground (minus 0.4 m) but never flows uphill, so a river cuts
 *   a valley through any rise in its way;
 * - a point's `fall` drops the surface by that much right there (everything below is cut deeper,
 *   which leaves a gorge under the waterfall);
 * - pinned `y` values hold the surface (a lake level or a weir), raising banks when needed;
 * - the surface never goes below the sea, and fades out where it meets it;
 * - a river whose source lies in another river's channel branches off it (starting at that
 *   river's level), and one whose end lies in another's channel flows into it (ending at its level).
 */
export function sampleRiver(
  def: RiverDef,
  groundAt: (x: number, z: number) => number,
  sea: number,
  near?: (x: number, z: number) => WaterNear | null
): SampledRiver {
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
  // Depth: the point's own, else the river's scaled with the width (narrows get shallower)
  const depth = (i: number) => pts[i].d ?? def.depth * Math.min(1.4, Math.max(0.5, width(i) / Math.max(0.6, def.width)));
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
      const dep = Math.max(0.1, depth(i) + (depth(i + 1) - depth(i)) * t);
      samples.push({ x: p.x, z: p.z, s: 0, hw: w / 2, depth: dep, tx: 0, tz: 1, dist: 0, foam: 0, alpha: 1, mouth: 0 });
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

  // 2b. Joins: the stretch where a branch leaves its parent, a tributary enters another river,
  // or the river runs into, out of or through a lake. There the channel flares into the other
  // water, the surface eases onto its level and the ribbon fades out inside it
  const join: (WaterNear | null)[] = new Array(S).fill(null);
  const startW = near?.(samples[0].x, samples[0].z) ?? null;
  const endW = near?.(samples[S - 1].x, samples[S - 1].z) ?? null;
  const from = startW && startW.edge < 0.5 ? startW : null;
  const into = endW && endW.edge < 0.5 ? endW : null;
  out.branchOf = from?.id;
  out.flowsInto = into?.id;
  if (near) {
    // From each attached end, until the river is clear of that water
    const walk = (k0: number, dir: number, id: string) => {
      for (let k = k0; k >= 0 && k < S; k += dir) {
        const w = near(samples[k].x, samples[k].z);
        if (!w || w.id !== id || w.edge > JOIN_REACH) break;
        join[k] = w;
      }
    };
    if (from) walk(0, 1, from.id);
    if (into) walk(S - 1, -1, into.id);
    // Lakes anywhere along the way (the river may cross one)
    for (let k = 0; k < S; k++) {
      if (join[k]) continue;
      const w = near(samples[k].x, samples[k].z);
      if (w?.lake && w.edge < JOIN_REACH) join[k] = w;
    }
  }

  // 3. Surface profile
  const pin = new Map<number, number>();
  const fall = new Map<number, number>();
  pts.forEach((pt, i) => {
    if (pt.y !== undefined) pin.set(pointSample[i], pt.y);
    if (pt.fall && pt.fall > 0 && i > 0) fall.set(pointSample[i], pt.fall);
  });
  // Inside another river or a lake the water takes its level
  for (let k = 0; k < S; k++) {
    const j = join[k];
    if (j && j.edge < 0 && !pin.has(k)) pin.set(k, j.s);
  }
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

  // Ease onto the other water's level over the join, and flare the banks open into it
  for (let k = 0; k < S; k++) {
    const j = join[k];
    if (!j) continue;
    const q = samples[k];
    if (j.edge >= 0 && j.s < q.s) q.s += (j.s - q.s) * (1 - smoothstep(j.edge, 0, 2.5));
    q.hw *= 1 + 0.7 * (1 - smoothstep(j.edge, 0, JOIN_REACH));
  }

  // 4. Estuary: where the river reaches standing water (the sea or a lake) it widens into a
  // funnel and its surface eases down to the sea level instead of meeting it at an angle
  let coast = -1;
  for (let k = S - 1; k >= 0; k--) {
    if (groundAt(samples[k].x, samples[k].z) >= sea + 0.25) {
      coast = k + 1;
      break;
    }
  }
  if (coast > 0 && coast < S) {
    const distM = samples[coast].dist;
    // Authored waterfalls and pinned levels near the coast keep their height: the funnel starts below them
    let lastFeature = -Infinity;
    for (const k of [...fall.keys(), ...pin.keys()]) if (k <= coast) lastFeature = Math.max(lastFeature, samples[k].dist);
    const L = Math.max(4, Math.min(40, Math.max(20, samples[coast].hw * 12), distM - lastFeature - 2));
    for (const q of samples) {
      const up = distM - q.dist;
      const e = up >= 0 ? 1 - smoothstep(up, 0, L) : 1;
      if (e <= 0) continue;
      q.mouth = up >= 0 ? e : 1 + Math.min(1, -up / MOUTH_OUT);
      q.hw *= 1 + 1.6 * e;
      q.depth *= 1 - 0.35 * e;
      const k = 1 - e;
      q.s = sea + 0.03 + (q.s - sea - 0.03) * k * k;
    }
  }

  // 5. White water, plunge pools and waterfalls
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
      const lip = samples[start], foot = samples[end];
      // The water leaves the lip with some speed and arcs out before it lands
      let bulge = DEFAULT_BULGE;
      pts.forEach((pt, i) => {
        if (pointSample[i] > start && pointSample[i] <= end && pt.bulge !== undefined) bulge = pt.bulge;
      });
      const arcOut = Math.max(0, bulge) * (0.5 + Math.sqrt(drop) * 0.8);
      let dx = foot.x - lip.x, dz = foot.z - lip.z;
      const dl = Math.hypot(dx, dz);
      if (dl > 0.05) {
        dx /= dl;
        dz /= dl;
      } else {
        dx = foot.tx;
        dz = foot.tz;
      }
      // Never shorter than the drop's own run, so the arc always clears the carved slope
      const travel = Math.max(arcOut, dl);
      out.falls.push({ x: lip.x + dx * travel, z: lip.z + dz * travel, start, end, travel, top, bottom, width: foot.hw * 2, tx: dx, tz: dz });
      // Plunge pool: deeper and wider just below (reaching past where the arc lands), churning
      const pool = 7 + Math.ceil(travel);
      for (let j = 0; j < pool && end + j < S; j++) {
        const q = samples[end + j];
        const w = 1 - j / pool;
        q.depth += Math.min(drop * 0.25, 1.4) * w;
        q.hw *= 1 + 0.3 * w;
        q.foam = Math.max(q.foam, w);
      }
    }
  }

  // A tributary churns a little where it meets the other water
  if (into) {
    for (let k = S - 1; k >= 0 && join[k]; k--) {
      const e = join[k]!.edge;
      samples[k].foam = Math.max(samples[k].foam, 0.4 * (1 - smoothstep(Math.abs(e + 0.6), 0, 2.2)));
    }
  }

  // 6. Fade the ribbon in at the source and out at the mouth: past the shoreline it fades over
  // MOUTH_OUT metres into the sea; a river with no shoreline fades as its surface reaches the sea.
  // Inside other water (a parent river, the river it joins, a lake) the ribbon fades out from that
  // water's edge inward, so the surfaces meet with no step and never double up
  const total = samples[S - 1].dist;
  for (let k = 0; k < S; k++) {
    const q = samples[k];
    const sea_ = coast > 0 ? 1 - smoothstep(q.mouth, 1, 2) : smoothstep(q.s, sea + 0.04, sea + 0.3);
    const ends = Math.min(from ? 1 : q.dist / 3, into ? 1 : (total - q.dist) / 3 + (q.mouth > 1 ? 1 : 0));
    const j = join[k];
    const inside = j ? smoothstep(j.edge, -Math.min(3, Math.max(1, j.hw * 0.8)), -0.15) : 1;
    q.alpha = Math.min(1, ends, sea_, inside);
  }

  // 7. Bounds
  for (const q of samples) {
    const r = q.hw + BANK + 2;
    out.minX = Math.min(out.minX, q.x - r);
    out.maxX = Math.max(out.maxX, q.x + r);
    out.minZ = Math.min(out.minZ, q.z - r);
    out.maxZ = Math.max(out.maxZ, q.z + r);
  }
  return out;
}

/**
 * A lake: the points are a closed outline (centripetal Catmull-Rom, ~1 m samples) holding flat
 * water at `def.level`, or just below the lowest natural ground on its shore. `samples` is the
 * shoreline (for the editor and bounds) and `lake` the shape the terrain and mesh use.
 */
export function sampleLake(def: RiverDef, groundAt: (x: number, z: number) => number, sea: number): SampledRiver {
  const pts = def.points;
  const samples: RiverSample[] = [];
  const pointSample: number[] = [];
  const out: SampledRiver = { def, samples, pointSample, falls: [], minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  const n = pts.length;
  const p = { x: 0, z: 0 };
  const push = (x: number, z: number) =>
    samples.push({ x, z, s: 0, hw: 0, depth: def.depth, tx: 0, tz: 1, dist: 0, foam: 0, alpha: 1, mouth: 0 });
  if (n < 3) {
    // Not a shape yet: just the handles
    for (const pt of pts) {
      pointSample.push(samples.length);
      push(pt.x, pt.z);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const pa = pts[(i + n - 1) % n], pb = pts[(i + 2) % n];
      const steps = Math.max(1, Math.ceil((Math.hypot(b.x - a.x, b.z - a.z) * 1.15) / STEP));
      pointSample.push(samples.length);
      for (let j = 0; j < steps; j++) {
        catmullRom(pa.x, pa.z, a.x, a.z, b.x, b.z, pb.x, pb.z, j / steps, p);
        push(p.x, p.z);
      }
    }
  }
  let low = Infinity;
  for (const q of samples) low = Math.min(low, groundAt(q.x, q.z));
  const level = Math.max(sea + 0.03, def.level ?? low - SURFACE_BELOW_GROUND);
  const S = samples.length;
  for (let k = 0; k < S; k++) {
    const q = samples[k];
    q.s = level;
    const a = samples[(k + S - 1) % S], b = samples[(k + 1) % S];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    q.tx = (b.x - a.x) / l;
    q.tz = (b.z - a.z) / l;
    if (k > 0) q.dist = samples[k - 1].dist + Math.hypot(q.x - samples[k - 1].x, q.z - samples[k - 1].z);
    const r = BANK + 2;
    out.minX = Math.min(out.minX, q.x - r);
    out.maxX = Math.max(out.maxX, q.x + r);
    out.minZ = Math.min(out.minZ, q.z - r);
    out.maxZ = Math.max(out.maxZ, q.z + r);
  }
  if (n >= 3 && S >= 3) {
    out.lake = { level, xs: Float32Array.from(samples, (q) => q.x), zs: Float32Array.from(samples, (q) => q.z) };
  }
  return out;
}

/** Signed distance from (x, z) to a closed outline: negative inside. */
export function lakeEdgeDistance(xs: Float32Array, zs: Float32Array, x: number, z: number): number {
  const n = xs.length;
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = xs[j], az = zs[j], bx = xs[i], bz = zs[i];
    if (az > z !== bz > z && x < ax + ((z - az) * (bx - ax)) / (bz - az)) inside = !inside;
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / Math.max(1e-6, dx * dx + dz * dz)));
    const ex = ax + dx * t - x, ez = az + dz * t - z;
    const d2 = ex * ex + ez * ez;
    if (d2 < best) best = d2;
  }
  return inside ? -Math.sqrt(best) : Math.sqrt(best);
}
