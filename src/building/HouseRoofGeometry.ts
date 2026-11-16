import * as THREE from 'three';
import { WALL_THICKNESS } from './config/BuildingConstants';
import type { ProceduralRoofConfig } from './ProceduralRoofSystem';
import { solvePitch, type RoofShape } from './RoofGeometry';

/**
 * One hip roof over the whole outline of a house (L-, T-, U-shaped and any other right-angled plan).
 *
 * The footprint is the closed loop of wall centre lines in the roof's local space. Every slope has
 * the same pitch, so the roof is the straight skeleton of the footprint: for a right-angled polygon
 * that is its L∞ medial axis, and the roof height at a point is simply the slope times the L∞
 * distance to the footprint boundary (the half size of the largest axis-aligned square centred
 * there that still fits inside). Ridges, hips and valleys (where wings meet, at inner corners) are
 * the creases of that height field.
 *
 * The height field is sampled on a lattice fine enough that every crease runs along lattice lines
 * or cell diagonals, so each cell is exactly one or two planar triangles. Triangles are grouped by
 * the wall edge they slope away from, merged into one polygon per roof face and re-triangulated,
 * so the mesh has no cracks and no overlaps. The eave strip outside the walls carries each face on
 * at the same pitch. Like the rectangular roofs, the slab's underside rests on the walls' outer top
 * edge and the attic ceiling covers the walls' footprint.
 */

const HALF_WALL = WALL_THICKNESS / 2;
type P2 = [number, number];

/** Cells per lattice step used for creases (a crease may sit half way between two wall lines) */
const MAX_CELLS = 24000;
const KEY_SCALE = 1e4;

function signedArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i];
    const [x1, z1] = poly[(i + 1) % poly.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

function pointInPolygon(poly: P2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** L∞ distance from (x, z) to the boundary of a right-angled polygon (edges in `skip` left out) */
function linfToBoundary(poly: P2[], x: number, z: number, skip?: Set<number>): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    if (skip?.has(i)) continue;
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    let d: number;
    if (Math.abs(az - bz) < 1e-9) {
      const lo = Math.min(ax, bx), hi = Math.max(ax, bx);
      d = Math.max(lo - x, 0, x - hi, Math.abs(z - az));
    } else {
      const lo = Math.min(az, bz), hi = Math.max(az, bz);
      d = Math.max(lo - z, 0, z - hi, Math.abs(x - ax));
    }
    if (d < best) best = d;
  }
  return best;
}

/**
 * Cleans a stored footprint: numbers only, collinear and repeated points dropped, counter-clockwise
 * in (x, z), every edge along X or Z. Null when it is not a usable right-angled loop.
 */
export function normalizeFootprint(raw: unknown): P2[] | null {
  if (!Array.isArray(raw)) return null;
  let pts: P2[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = Number(p[0]), z = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const last = pts[pts.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-4 && Math.abs(last[1] - z) < 1e-4) continue;
    pts.push([x, z]);
  }
  if (pts.length > 1) {
    const [f, l] = [pts[0], pts[pts.length - 1]];
    if (Math.abs(f[0] - l[0]) < 1e-4 && Math.abs(f[1] - l[1]) < 1e-4) pts.pop();
  }
  // Drop collinear points (repeat until stable: removing one can expose another)
  for (let changed = true; changed && pts.length >= 3; ) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 1e-6) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (pts.length < 4) return null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (Math.abs(a[0] - b[0]) > 1e-4 && Math.abs(a[1] - b[1]) > 1e-4) return null;
  }
  const area = signedArea(pts);
  if (Math.abs(area) < 1e-3) return null;
  if (area < 0) pts = pts.reverse();
  return pts;
}

/** Outward unit normal of a CCW edge a→b */
function outward(a: P2, b: P2): P2 {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  return [dz / len, -dx / len];
}

/** The footprint pushed out by `d` with mitred (square) corners */
function offsetPolygon(poly: P2[], d: number): P2[] {
  const n = poly.length;
  return poly.map((v, i) => {
    const o0 = outward(poly[(i + n - 1) % n], v);
    const o1 = outward(v, poly[(i + 1) % n]);
    return [v[0] + d * (o0[0] + o1[0]), v[1] + d * (o0[1] + o1[1])] as P2;
  });
}

/**
 * Edges of a gable house roof that end a wing with an upright gable instead of a hip: the edges whose
 * hip face would be a triangle (both corners convex, the square of half its length fits right in
 * front of it). Where two such edges meet at one apex (a square end) only the ones along X are kept.
 */
export function houseGableEdges(poly: P2[]): Set<number> {
  const n = poly.length;
  const convex = (i: number) => {
    const a = poly[(i + n - 1) % n], b = poly[i], c = poly[(i + 1) % n];
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) > 0;
  };
  const byApex = new Map<string, Array<{ i: number; alongX: boolean }>>();
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    if (!convex(i) || !convex((i + 1) % n)) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const o = outward(a, b);
    const mx = (a[0] + b[0]) / 2 - (o[0] * len) / 2, mz = (a[1] + b[1]) / 2 - (o[1] * len) / 2;
    if (!pointInPolygon(poly, mx, mz) || Math.abs(linfToBoundary(poly, mx, mz) - len / 2) > 1e-6) continue;
    const key = `${Math.round(mx * KEY_SCALE)},${Math.round(mz * KEY_SCALE)}`;
    if (!byApex.has(key)) byApex.set(key, []);
    byApex.get(key)!.push({ i, alongX: Math.abs(b[0] - a[0]) > 1e-6 });
  }
  const out = new Set<number>();
  for (const group of byApex.values()) {
    const mixed = group.some((e) => e.alongX) && group.some((e) => !e.alongX);
    for (const e of group) if (!mixed || e.alongX) out.add(e.i);
  }
  // Two gables never share a corner (the eave between them would have nowhere to go)
  for (let i = 0; i < n; i++) if (out.has(i) && out.has((i + 1) % n)) out.delete((i + 1) % n);
  return out;
}

/** Lattice step all footprint coordinates sit on (relative to its first point) */
function latticeStep(poly: P2[]): number {
  const [ox, oz] = poly[0];
  for (const g of [1, 0.5, 0.25, 0.125, 0.1, 0.05]) {
    const fits = poly.every(([x, z]) => {
      const a = (x - ox) / g, b = (z - oz) / g;
      return Math.abs(a - Math.round(a)) < 1e-3 && Math.abs(b - Math.round(b)) < 1e-3;
    });
    if (fits) return g;
  }
  return 0.05;
}

/** Plane of one roof face, as H = s·x + k (axis 'x') or H = s·z + k (axis 'z') in skeleton height */
interface FacePlane {
  axis: 'x' | 'z';
  s: number;
  k: number;
}

const planeKey = (p: FacePlane) => `${p.axis}${p.s > 0 ? '+' : '-'}${Math.round(p.k * KEY_SCALE)}`;
const evalPlane = (p: FacePlane, x: number, z: number) => p.s * (p.axis === 'x' ? x : z) + p.k;

/** Plane through three (x, z, h) points if it is one of the four roof slopes, else null */
function trianglePlane(a: number[], b: number[], c: number[]): FacePlane | null {
  const ux = b[0] - a[0], uz = b[1] - a[1], uh = b[2] - a[2];
  const vx = c[0] - a[0], vz = c[1] - a[1], vh = c[2] - a[2];
  const det = ux * vz - uz * vx;
  if (Math.abs(det) < 1e-12) return null;
  const gx = (uh * vz - uz * vh) / det;
  const gz = (ux * vh - uh * vx) / det;
  if (Math.abs(Math.abs(gx) - 1) < 1e-6 && Math.abs(gz) < 1e-6) {
    const s = Math.sign(gx);
    return { axis: 'x', s, k: a[2] - s * a[0] };
  }
  if (Math.abs(Math.abs(gz) - 1) < 1e-6 && Math.abs(gx) < 1e-6) {
    const s = Math.sign(gz);
    return { axis: 'z', s, k: a[2] - s * a[1] };
  }
  return null;
}

interface Piece {
  /** Vertex keys, counter-clockwise */
  loop: string[];
  plane: FacePlane;
}

export function solveHouseRoofShape(cfg: ProceduralRoofConfig, footprint: P2[]): RoofShape {
  const thickness = THREE.MathUtils.clamp(cfg.fasciaDepth ?? 0.135, 0.04, 0.3);
  const eaveO = Math.max(0, cfg.eaveOverhang ?? cfg.overhang ?? 0.25);
  const h = Math.max(cfg.height, 0.05);

  // Lattice: footprint corners on step g, creases on step g/2 (coarsened for huge plans)
  let g = latticeStep(footprint);
  let poly = footprint;
  const [ox, oz] = footprint[0];
  const xs = footprint.map((p) => p[0]), zs = footprint.map((p) => p[1]);
  const span = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
  while (span / ((g / 2) * (g / 2)) > MAX_CELLS) {
    g *= 2;
    const snapped = footprint.map(([x, z]) => [ox + Math.round((x - ox) / g) * g, oz + Math.round((z - oz) / g) * g]);
    poly = normalizeFootprint(snapped) ?? poly;
  }
  const c = g / 2;

  // Gable roof: the wing ends are upright gables, so the slopes ignore those edges (the roof runs
  // out over them at full height, `gableO` past the wall)
  const gables = cfg.roofType === 'gable' ? houseGableEdges(poly) : new Set<number>();
  const gableO = Math.max(0, cfg.gableOverhang ?? cfg.overhang ?? 0.3);
  const H = (x: number, z: number) => linfToBoundary(poly, x, z, gables);

  // Vertices by lattice-rounded key; `hp` is the skeleton height (L∞ distance inside the walls)
  const verts = new Map<string, { x: number; z: number; hp: number }>();
  const keyOf = (x: number, z: number) => `${Math.round(x * KEY_SCALE)},${Math.round(z * KEY_SCALE)}`;
  const vertex = (x: number, z: number, hp?: number): string => {
    const key = keyOf(x, z);
    if (!verts.has(key)) verts.set(key, { x, z, hp: hp ?? H(x, z) });
    return key;
  };

  const pieces: Piece[] = [];
  let subdivided = false;

  // Linear on the triangle? Checked at interior and edge sample points
  const fitTriangle = (t: number[][]): { plane: FacePlane | null; err: number } => {
    const plane = trianglePlane(t[0], t[1], t[2]);
    if (!plane) return { plane: null, err: Infinity };
    let err = 0;
    const bary = [
      [1 / 3, 1 / 3, 1 / 3], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3],
      [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5],
    ];
    for (const [wa, wb, wc] of bary) {
      const x = t[0][0] * wa + t[1][0] * wb + t[2][0] * wc;
      const z = t[0][1] * wa + t[1][1] * wb + t[2][1] * wc;
      err = Math.max(err, Math.abs(H(x, z) - evalPlane(plane, x, z)));
    }
    return { plane, err };
  };

  const addCell = (x0: number, z0: number, size: number, depth: number): void => {
    const x1 = x0 + size, z1 = z0 + size;
    const P = (x: number, z: number) => [x, z, H(x, z)];
    const c00 = P(x0, z0), c10 = P(x1, z0), c11 = P(x1, z1), c01 = P(x0, z1);
    const splits = [
      [[c00, c10, c11], [c00, c11, c01]],
      [[c00, c10, c01], [c10, c11, c01]],
    ];
    let best: { tris: number[][][]; planes: FacePlane[]; err: number } | null = null;
    for (const tris of splits) {
      const fits = tris.map(fitTriangle);
      const err = Math.max(...fits.map((f) => f.err));
      if (!best || err < best.err) best = { tris, planes: fits.map((f) => f.plane!), err };
      if (err < 1e-7) break;
    }
    if (best!.err > 1e-7 && depth < 3) {
      subdivided = true;
      const hs = size / 2;
      addCell(x0, z0, hs, depth + 1);
      addCell(x0 + hs, z0, hs, depth + 1);
      addCell(x0, z0 + hs, hs, depth + 1);
      addCell(x0 + hs, z0 + hs, hs, depth + 1);
      return;
    }
    best!.tris.forEach((tri, i) => {
      const plane = best!.planes[i];
      if (!plane) return;
      pieces.push({ loop: tri.map((p) => vertex(p[0], p[1], p[2])), plane });
    });
  };

  const minX = Math.min(...poly.map((p) => p[0])), maxX = Math.max(...poly.map((p) => p[0]));
  const minZ = Math.min(...poly.map((p) => p[1])), maxZ = Math.max(...poly.map((p) => p[1]));
  const nx = Math.round((maxX - minX) / c), nz = Math.round((maxZ - minZ) / c);
  let maxHp = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x0 = minX + i * c, z0 = minZ + j * c;
      if (!pointInPolygon(poly, x0 + c / 2, z0 + c / 2)) continue;
      addCell(x0, z0, c, 0);
      maxHp = Math.max(maxHp, H(x0, z0), H(x0 + c, z0), H(x0, z0 + c), H(x0 + c, z0 + c));
    }
  }

  // Eave strips: each wall edge's slope carried on out to the eave line at the same pitch
  const delta = HALF_WALL + eaveO;
  const gd = HALF_WALL + gableO;
  const n = poly.length;
  const outs = poly.map((v, i) => outward(v, poly[(i + 1) % n]));
  const dist = (i: number) => (gables.has(i) ? gd : delta);
  // Eave / rake corner at vertex i: pushed out past both its edges
  const eave: P2[] = poly.map((v, i) => {
    const ip = (i + n - 1) % n;
    return [v[0] + dist(ip) * outs[ip][0] + dist(i) * outs[i][0], v[1] + dist(ip) * outs[ip][1] + dist(i) * outs[i][1]];
  });
  /** Lattice points along edge i (both ends included) */
  const edgePoints = (i: number): P2[] => {
    const a = poly[i], b = poly[(i + 1) % n];
    const steps = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / c));
    return Array.from({ length: steps + 1 }, (_, s) => [a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps] as P2);
  };
  /** Point `p` pushed out past gable edge i to the rake line */
  const rake = (p: P2, i: number): P2 => [p[0] + gd * outs[i][0], p[1] + gd * outs[i][1]];
  const rakePoints = new Map<number, string[]>();
  for (const i of gables) {
    // The faces reaching the gable carry on straight out over it (level across the edge)
    const pts = edgePoints(i);
    const hps = pts.map(([x, z]) => H(x, z));
    const inner = pts.map(([x, z], s) => vertex(x, z, hps[s]));
    const outer = pts.map((p, s) => {
      const q = rake(p, i);
      return vertex(q[0], q[1], hps[s]);
    });
    rakePoints.set(i, outer);
    const alongX = Math.abs(outs[i][1]) > 0.5;
    for (let s = 0; s + 1 < pts.length; s++) {
      const dt = alongX ? pts[s + 1][0] - pts[s][0] : pts[s + 1][1] - pts[s][1];
      const dh = hps[s + 1] - hps[s];
      const t0 = alongX ? pts[s][0] : pts[s][1];
      const sg = Math.sign(dh / dt);
      const plane: FacePlane = Math.abs(dh) > 1e-9
        ? { axis: alongX ? 'x' : 'z', s: sg, k: hps[s] - sg * t0 }
        : { axis: alongX ? 'x' : 'z', s: 0, k: 1e6 + i * 1000 + s };
      pieces.push({ loop: [inner[s], inner[s + 1], outer[s + 1], outer[s]], plane });
    }
  }
  for (let i = 0; i < n; i++) {
    if (gables.has(i)) continue;
    const a = poly[i], b = poly[(i + 1) % n];
    const ip = (i + n - 1) % n, inx = (i + 1) % n;
    const inner: string[] = edgePoints(i).map(([x, z]) => vertex(x, z, 0));
    // Next to a gable the eave runs on out to the rake
    if (gables.has(ip)) inner.unshift(vertex(...rake(a, ip), 0));
    if (gables.has(inx)) inner.push(vertex(...rake(b, inx), 0));
    const ea = eave[i], eb = eave[(i + 1) % n];
    // Inner edge runs a→b (interior on its left), so the strip outside it is b→a, then out
    const loop = [...inner.reverse(), vertex(ea[0], ea[1], -delta), vertex(eb[0], eb[1], -delta)];
    const o = outward(a, b);
    // Skeleton height grows inwards: H = -(o · p) + o · a
    const plane: FacePlane = Math.abs(o[0]) > 0.5
      ? { axis: 'x', s: -o[0], k: o[0] * a[0] }
      : { axis: 'z', s: -o[1], k: o[1] * a[1] };
    pieces.push({ loop, plane });
  }

  // Orient every piece counter-clockwise
  const xz = (k: string): P2 => {
    const v = verts.get(k)!;
    return [v.x, v.z];
  };
  for (const p of pieces) if (signedArea(p.loop.map(xz)) < 0) p.loop.reverse();

  // Sub-divided cells leave vertices in the middle of their neighbours' edges: split those edges
  if (subdivided) {
    const all = Array.from(verts.keys()).map((k) => ({ k, p: xz(k) }));
    for (const piece of pieces) {
      const out: string[] = [];
      for (let i = 0; i < piece.loop.length; i++) {
        const ka = piece.loop[i], kb = piece.loop[(i + 1) % piece.loop.length];
        const a = xz(ka), b = xz(kb);
        out.push(ka);
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len2 = dx * dx + dz * dz;
        const mids: Array<{ k: string; t: number }> = [];
        for (const { k, p } of all) {
          if (k === ka || k === kb) continue;
          const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2;
          if (t <= 1e-6 || t >= 1 - 1e-6) continue;
          const cx = a[0] + dx * t - p[0], cz = a[1] + dz * t - p[1];
          if (cx * cx + cz * cz < 1e-10) mids.push({ k, t });
        }
        mids.sort((u, v) => u.t - v.t);
        for (const m of mids) out.push(m.k);
      }
      piece.loop = out;
    }
  }

  // Group pieces into faces: same plane and sharing an edge
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const edgeOwner = new Map<string, number>();
  pieces.forEach((p, i) => {
    const key = planeKey(p.plane);
    for (let e = 0; e < p.loop.length; e++) {
      const a = p.loop[e], b = p.loop[(e + 1) % p.loop.length];
      const other = edgeOwner.get(`${b}|${a}`);
      if (other !== undefined && planeKey(pieces[other].plane) === key) parent[find(i)] = find(other);
      edgeOwner.set(`${a}|${b}`, i);
    }
  });
  const groups = new Map<number, number[]>();
  pieces.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  });

  // Boundary loops of each face (interior edges cancel out)
  interface Face {
    plane: FacePlane;
    loops: string[][];
  }
  const faces: Face[] = [];
  for (const members of groups.values()) {
    const edges = new Map<string, string>(); // from → to
    const seen = new Set<string>();
    for (const i of members) {
      const loop = pieces[i].loop;
      for (let e = 0; e < loop.length; e++) {
        const a = loop[e], b = loop[(e + 1) % loop.length];
        if (seen.has(`${b}|${a}`)) {
          seen.delete(`${b}|${a}`);
        } else seen.add(`${a}|${b}`);
      }
    }
    for (const e of seen) {
      const [a, b] = e.split('|');
      edges.set(a, b);
    }
    const loops: string[][] = [];
    while (edges.size > 0) {
      const start = edges.keys().next().value as string;
      const loop: string[] = [];
      let cur = start;
      for (let guard = 0; guard < 100000; guard++) {
        loop.push(cur);
        const next = edges.get(cur);
        edges.delete(cur);
        if (next === undefined || next === start) break;
        cur = next;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    faces.push({ plane: pieces[members[0]].plane, loops });
  }

  // Drop vertices that are only a straight-through point on every face that uses them
  const collinearAt = (loop: string[], i: number) => {
    const a = xz(loop[(i + loop.length - 1) % loop.length]), b = xz(loop[i]), cc = xz(loop[(i + 1) % loop.length]);
    return Math.abs((b[0] - a[0]) * (cc[1] - b[1]) - (b[1] - a[1]) * (cc[0] - b[0])) < 1e-9;
  };
  const use = new Map<string, { faces: number; corner: boolean }>();
  faces.forEach((f) => {
    for (const loop of f.loops) {
      loop.forEach((k, i) => {
        const u = use.get(k) ?? { faces: 0, corner: false };
        u.faces++;
        if (!collinearAt(loop, i)) u.corner = true;
        use.set(k, u);
      });
    }
  });
  for (const f of faces) f.loops = f.loops.map((loop) => loop.filter((k) => {
    const u = use.get(k)!;
    return u.corner || u.faces > 2;
  }));

  // Pitch: the highest point is `height` above the wall tops, `run` in from the outer wall line
  const run = maxHp + HALF_WALL;
  const { slope, drop } = solvePitch(h, run, thickness);
  const ye = drop - slope * eaveO;
  const yOf = (hp: number) => ye + slope * (hp + delta);
  const points = new Map<string, THREE.Vector3>();
  const point = (k: string): THREE.Vector3 => {
    let p = points.get(k);
    if (!p) {
      const v = verts.get(k)!;
      p = new THREE.Vector3(v.x, yOf(v.hp), v.z);
      points.set(k, p);
    }
    return p;
  };

  // Triangulate each face
  const top: THREE.Vector3[][] = [];
  const faceOfEdge = new Map<string, number>();
  faces.forEach((f, fi) => {
    const outer = f.loops.filter((l) => signedArea(l.map(xz)) > 0);
    const holes = f.loops.filter((l) => signedArea(l.map(xz)) <= 0);
    for (const loop of outer) {
      const mine = holes.filter((hl) => pointInPolygon(loop.map(xz), ...xz(hl[0])));
      const keys = [...loop, ...mine.flat()];
      const tris = THREE.ShapeUtils.triangulateShape(
        loop.map((k) => new THREE.Vector2(...xz(k))),
        mine.map((hl) => hl.map((k) => new THREE.Vector2(...xz(k))))
      );
      for (const t of tris) top.push(t.map((i) => point(keys[i])));
      for (const l of [loop, ...mine]) {
        l.forEach((k, i) => faceOfEdge.set(`${k}|${l[(i + 1) % l.length]}`, fi));
      }
    }
  });

  // Creases between two faces: ridges and hips get a cap, valleys stay open
  const creases: Array<[THREE.Vector3, THREE.Vector3]> = [];
  for (const [e, fa] of faceOfEdge) {
    const [a, b] = e.split('|');
    const fb = faceOfEdge.get(`${b}|${a}`);
    if (fb === undefined || a > b) continue;
    const pa = xz(a), pb = xz(b);
    const dx = pb[0] - pa[0], dz = pb[1] - pa[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    // A point just inside face A (left of a→b): the roof there is below face B's plane at a peak
    const qx = (pa[0] + pb[0]) / 2 - (dz / len) * 0.05, qz = (pa[1] + pb[1]) / 2 + (dx / len) * 0.05;
    const convex = evalPlane(faces[fb].plane, qx, qz) > evalPlane(faces[fa].plane, qx, qz) + 1e-6;
    if (convex) creases.push([point(a), point(b)]);
  }

  // Eave line, out along each rake where a gable is
  const outline: THREE.Vector3[] = [];
  eave.forEach(([x, z], i) => {
    outline.push(point(vertex(x, z, -delta)));
    for (const k of rakePoints.get(i) ?? []) outline.push(point(k));
  });
  const ceiling = offsetPolygon(poly, HALF_WALL).map(([x, z]) => new THREE.Vector3(x, 0, z));

  // Gables: on the wall's outer face, from its top up to the roof's underside
  const attic: RoofShape['attic'] = [];
  for (const i of gables) {
    const o = outs[i], ip = (i + n - 1) % n, inx = (i + 1) % n;
    const pts = edgePoints(i);
    const hps = pts.map(([x, z]) => H(x, z));
    const a = poly[i], b = poly[inx];
    const wallPts = [new THREE.Vector3(a[0] + HALF_WALL * (outs[ip][0] + o[0]), 0, a[1] + HALF_WALL * (outs[ip][1] + o[1]))];
    for (let s = 1; s + 1 < pts.length; s++) {
      // Only where the profile bends (a fan over straight runs would make slivers)
      if (Math.abs(hps[s - 1] + hps[s + 1] - 2 * hps[s]) < 1e-9) continue;
      wallPts.push(new THREE.Vector3(pts[s][0] + HALF_WALL * o[0], yOf(hps[s]) - drop, pts[s][1] + HALF_WALL * o[1]));
    }
    wallPts.push(new THREE.Vector3(b[0] + HALF_WALL * (outs[inx][0] + o[0]), 0, b[1] + HALF_WALL * (outs[inx][1] + o[1])));
    attic.push({ pts: wallPts, out: new THREE.Vector3(o[0], 0, o[1]) });
  }

  return {
    top,
    outline,
    drop,
    creases,
    attic,
    // A hip roof's eaves are boxed in level; a gable's rakes would cut through a level soffit
    soffit: gables.size > 0 ? undefined : { y: ye - drop, inner: ceiling },
    ceiling,
    capWidth: Math.min(0.11, run * 0.3),
    capRise: 0.06,
  };
}

/** Area of the roof outline seen from above, and of the top triangles (for coverage checks) */
export function houseRoofCoverage(shape: RoofShape, samplesPerMetre = 20): { inside: number; holes: number; overlaps: number; outsideHits: number } {
  const outline: P2[] = shape.outline.map((p) => [p.x, p.z]);
  const xs = outline.map((p) => p[0]), zs = outline.map((p) => p[1]);
  const x0 = Math.min(...xs) - 0.3, x1 = Math.max(...xs) + 0.3;
  const z0 = Math.min(...zs) - 0.3, z1 = Math.max(...zs) + 0.3;
  const step = 1 / samplesPerMetre;
  const tris = shape.top.map((t) => t.map((p) => [p.x, p.z] as P2));
  const inTri = (t: P2[], x: number, z: number) => {
    const s = (a: P2, b: P2) => (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const d1 = s(t[0], t[1]), d2 = s(t[1], t[2]), d3 = s(t[2], t[0]);
    const neg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
    const pos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
    return !(neg && pos);
  };
  let inside = 0, holes = 0, overlaps = 0, outsideHits = 0;
  // Offset by an irrational fraction so samples never land exactly on lattice edges
  for (let x = x0 + step * 0.3819; x < x1; x += step) {
    for (let z = z0 + step * 0.6180; z < z1; z += step) {
      let hits = 0;
      for (const t of tris) if (inTri(t, x, z)) hits++;
      if (pointInPolygon(outline, x, z)) {
        inside++;
        if (hits === 0) holes++;
        if (hits > 1) overlaps++;
      } else if (hits > 0) outsideHits++;
    }
  }
  return { inside, holes, overlaps, outsideHits };
}

/**
 * Distance from the outer wall line to the highest point of a house roof over `footprint` (its
 * widest wing decides it), for picking a pitch.
 */
export function houseRoofRun(footprint: P2[], gable = false): number {
  const poly = normalizeFootprint(footprint);
  if (!poly) return 1;
  const skip = gable ? houseGableEdges(poly) : undefined;
  const c = latticeStep(poly) / 2;
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), z0 = Math.min(...zs);
  const nx = Math.round((Math.max(...xs) - x0) / c), nz = Math.round((Math.max(...zs) - z0) / c);
  let best = 0;
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      const x = x0 + i * c, z = z0 + j * c;
      if (pointInPolygon(poly, x + 1e-4, z + 1e-4) || pointInPolygon(poly, x - 1e-4, z - 1e-4)) best = Math.max(best, linfToBoundary(poly, x, z, skip));
    }
  }
  return best + HALF_WALL;
}
