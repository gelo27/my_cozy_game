import * as THREE from 'three';
import type { RiverSample, SampledRiver } from './RiverTypes';
import { lakeEdgeDistance } from './RiverSpline';

/** Vertices across the ribbon. Rivers are flat across, so a few are plenty. */
const ACROSS = 5;
/** The ribbon reaches this far past the channel edge, under the banks, so no gap shows. */
const OVERLAP = 0.6;
/** Rows along a waterfall's arc. */
const ARC_ROWS = 10;
/** The arc ends this far under the pool surface, so the seam hides in the water. */
const ARC_SINK = 0.25;
/** Each river is cut into pieces about this long, so off-screen and far pieces are skipped. */
export const CHUNK_LENGTH = 64;
/** Lake mesh grid spacing (m). */
const LAKE_CELL = 2;

interface Row {
  x: number;
  z: number;
  y: number;
  hw: number;
  tx: number;
  tz: number;
  /** Texture distance along the flow (arc length on waterfalls, so streaks fall down them). */
  v: number;
  foam: number;
  alpha: number;
  mouth: number;
}

const row = (q: RiverSample, v: number): Row => ({ x: q.x, z: q.z, y: q.s, hw: q.hw, tx: q.tx, tz: q.tz, v, foam: q.foam, alpha: q.alpha, mouth: q.mouth });

/**
 * Water ribbon along a river's samples: flat across the channel at the surface height.
 * A waterfall is not a flat step: from the lip the water follows a projectile arc (out by
 * `travel`, down by the drop with t^2), so the curtain bulges out and lands in the plunge pool.
 * Attributes: `uv` = (metres across from the centre, metres along the flow) for flow scrolling;
 * `aRiver` = (foam, alpha, 0..1 across, estuary 0..2) for white water, fades, bank foam and the
 * blend into the sea.
 */
export function buildRiverGeometry(river: SampledRiver): THREE.BufferGeometry[] {
  const S = river.samples;
  if (S.length < 2) return [];

  // 1. Rows: the samples, with each waterfall's straight drop replaced by its arc
  const rows: Row[] = [];
  const fallAt = new Map(river.falls.map((f) => [f.start, f]));
  let vShift = 0;
  let k = 0;
  while (k < S.length) {
    const q = S[k];
    rows.push(row(q, q.dist + vShift));
    const f = fallAt.get(k);
    if (!f || f.travel < 0.05 || f.end >= S.length - 1) {
      k++;
      continue;
    }
    const foot = S[f.end];
    const drop = f.top - f.bottom;
    let arc = 0;
    let px = q.x, py = q.s, pz = q.z;
    for (let i = 1; i <= ARC_ROWS; i++) {
      const t = i / ARC_ROWS;
      const x = q.x + f.tx * f.travel * t;
      const z = q.z + f.tz * f.travel * t;
      const y = f.top - (drop + ARC_SINK) * t * t;
      arc += Math.hypot(x - px, y - py, z - pz);
      px = x;
      py = y;
      pz = z;
      rows.push({
        x, z, y,
        hw: q.hw + (foot.hw - q.hw) * t,
        tx: f.tx,
        tz: f.tz,
        v: q.dist + vShift + arc,
        foam: 1,
        alpha: q.alpha + (foot.alpha - q.alpha) * t,
        mouth: q.mouth + (foot.mouth - q.mouth) * t,
      });
    }
    // Resume with the pool, past where the arc lands
    let j = f.end;
    while (j < S.length - 1 && S[j].dist <= q.dist + f.travel + 0.4) j++;
    vShift += arc - (S[j].dist - q.dist);
    k = j;
  }

  // 2. Pieces of about CHUNK_LENGTH along the flow, sharing their boundary row (no seams).
  // Fully transparent stretches (inside a lake or another river) are skipped
  const pieces: THREE.BufferGeometry[] = [];
  let a = 0;
  while (a < rows.length - 1) {
    let b = a + 1;
    while (b < rows.length - 1 && rows[b].v - rows[a].v < CHUNK_LENGTH) b++;
    let visible = false;
    for (let k = a; k <= b && !visible; k++) visible = rows[k].alpha > 0.01;
    if (visible) pieces.push(ribbon(rows.slice(a, b + 1)));
    a = b;
  }
  return pieces;
}

function ribbon(rows: Row[]): THREE.BufferGeometry {
  const count = rows.length * ACROSS;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const attr = new Float32Array(count * 4);
  let v = 0;
  for (const r of rows) {
    // Left of the flow direction
    const nx = -r.tz, nz = r.tx;
    const half = r.hw + OVERLAP;
    for (let c = 0; c < ACROSS; c++) {
      const u = (c / (ACROSS - 1)) * 2 - 1;
      pos[v * 3] = r.x + nx * u * half;
      pos[v * 3 + 1] = r.y;
      pos[v * 3 + 2] = r.z + nz * u * half;
      uv[v * 2] = u * half;
      uv[v * 2 + 1] = r.v;
      attr[v * 4] = r.foam;
      attr[v * 4 + 1] = r.alpha;
      attr[v * 4 + 2] = Math.abs(u) * (half / Math.max(0.3, r.hw));
      attr[v * 4 + 3] = r.mouth;
      v++;
    }
  }
  const index: number[] = [];
  for (let k2 = 0; k2 < rows.length - 1; k2++) {
    for (let c = 0; c < ACROSS - 1; c++) {
      const a = k2 * ACROSS + c;
      const b = a + ACROSS;
      // Counter-clockwise seen from above (normals up)
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aRiver', new THREE.BufferAttribute(attr, 4));
  geo.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/**
 * A lake's water: a 2 m grid clipped to the shoreline. Grid vertices just outside the shore are
 * pulled onto a line OVERLAP metres past it, so the edge follows the curve instead of the grid.
 * `aRiver.z` rises from 0 in open water to ~1.1 at the edge (bank foam), uv = world XZ.
 */
export function buildLakeGeometry(river: SampledRiver): THREE.BufferGeometry | null {
  const L = river.lake;
  if (!L) return null;
  const { xs, zs, level } = L;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    minX = Math.min(minX, xs[i]);
    maxX = Math.max(maxX, xs[i]);
    minZ = Math.min(minZ, zs[i]);
    maxZ = Math.max(maxZ, zs[i]);
  }
  const pad = LAKE_CELL + OVERLAP;
  const x0 = minX - pad, z0 = minZ - pad;
  const nx = Math.ceil((maxX - minX + pad * 2) / LAKE_CELL) + 1;
  const nz = Math.ceil((maxZ - minZ + pad * 2) / LAKE_CELL) + 1;
  const sd = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) sd[j * nx + i] = lakeEdgeDistance(xs, zs, x0 + i * LAKE_CELL, z0 + j * LAKE_CELL);

  const pos: number[] = [];
  const uv: number[] = [];
  const attr: number[] = [];
  const vid = new Int32Array(nx * nz).fill(-1);
  const vertex = (i: number, j: number): number => {
    const g = j * nx + i;
    if (vid[g] >= 0) return vid[g];
    let x = x0 + i * LAKE_CELL, z = z0 + j * LAKE_CELL;
    let d = sd[g];
    if (d > OVERLAP) {
      // Pull onto the overlap line along the distance gradient
      const gx = (sd[j * nx + Math.min(nx - 1, i + 1)] - sd[j * nx + Math.max(0, i - 1)]) / (2 * LAKE_CELL);
      const gz = (sd[Math.min(nz - 1, j + 1) * nx + i] - sd[Math.max(0, j - 1) * nx + i]) / (2 * LAKE_CELL);
      const gl = Math.hypot(gx, gz) || 1;
      x -= (gx / gl) * (d - OVERLAP);
      z -= (gz / gl) * (d - OVERLAP);
      d = OVERLAP;
    }
    vid[g] = pos.length / 3;
    pos.push(x, level, z);
    uv.push(x, z);
    attr.push(0, 1, Math.min(1.1, Math.max(0, 1 + d / 3)), 0);
    return vid[g];
  };
  const index: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const g = j * nx + i;
      // Any corner in the water (or close to it) keeps the cell
      if (Math.min(sd[g], sd[g + 1], sd[g + nx], sd[g + nx + 1]) > OVERLAP) continue;
      const a = vertex(i, j), b = vertex(i + 1, j), c = vertex(i, j + 1), d = vertex(i + 1, j + 1);
      index.push(a, c, b, b, c, d);
    }
  }
  if (!index.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aRiver', new THREE.Float32BufferAttribute(attr, 4));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}
