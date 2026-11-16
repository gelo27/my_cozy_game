import * as THREE from 'three';
import type { RoofShape } from './RoofGeometry';

/**
 * Dormers: small gabled / hipped / shed / flat-roofed window boxes standing on any sloping face of a
 * procedural roof. Every roof generator builds its top out of planar polygons, so a dormer only needs
 * the face it stands on: gable, hip, shed, gambrel and mansard roofs and whole-house roofs all get
 * them the same way.
 *
 * A dormer is stored by the point (roof local x, z) where the middle of its front wall meets the
 * slope, so it follows the roof when that is rebuilt; a dormer that no longer fits its face is just
 * not drawn. Its walls are open planes like the frontons, standing on the slope; the window panes are
 * opaque glass, so the roof needs no hole under it.
 */

export type DormerStyle = 'gable' | 'hip' | 'shed' | 'flat';
export const DORMER_STYLES: DormerStyle[] = ['gable', 'hip', 'shed', 'flat'];

export interface RoofDormer {
  id: string;
  /** Roof local position of the middle of the front wall's foot on the slope */
  x: number;
  z: number;
  /** Width of the front wall (m) */
  width: number;
  /** Height of the front wall up to the dormer roof's underside (m) */
  height: number;
  style: DormerStyle;
}

export const DORMER_WIDTH = { min: 1, max: 4, step: 0.5, initial: 1.5 };
export const DORMER_HEIGHT = { min: 0.6, max: 2, step: 0.2, initial: 1 };
/** Grid the placement point snaps to (roof local metres) */
export const DORMER_SNAP = 0.25;

/** Polygon of a dormer part: 0 shingles, 1 white trim, 2 walls (outer wall finish), 3 window glass */
export interface DormerPart {
  pts: THREE.Vector3[];
  mat: 0 | 1 | 2 | 3;
  out: THREE.Vector3;
}

export interface DormerGeometry {
  /** Shingled roof faces (planar) */
  top: THREE.Vector3[][];
  /** Ridges and hips that get a cap; ends are vertices of two `top` faces */
  creases: Array<[THREE.Vector3, THREE.Vector3]>;
  /** Crease ends at an eave corner (the cap runs on past them) */
  eaves: Set<THREE.Vector3>;
  parts: DormerPart[];
}

export type DormerFailure = 'build.dormer.noSlope' | 'build.dormer.tooFlat' | 'build.dormer.noFit' | 'build.dormer.overlap';

export interface DormerLayout {
  id: string;
  ok: boolean;
  reason?: DormerFailure;
  /** Ground plan the dormer covers (roof local x, z), overhang included */
  plan?: THREE.Vector2[];
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const DOWN = V(0, -1, 0);
/** Faces flatter than this carry no dormer */
const MIN_SLOPE = 0.25;
/** Roof board thickness, overhang and window frame sizes */
const SLAB = 0.09;
const OVER = 0.12;
const REVEAL = 0.08;
const FRAME = 0.06;
const BAR = 0.025;
const SILL = 0.07;

const upNormal = (poly: THREE.Vector3[]) => {
  const n = new THREE.Vector3();
  for (let i = 1; i < poly.length - 1; i++) {
    const e1 = new THREE.Vector3().subVectors(poly[i], poly[0]);
    const e2 = new THREE.Vector3().subVectors(poly[i + 1], poly[0]);
    n.add(e1.cross(e2));
  }
  if (n.lengthSq() < 1e-12) return null;
  n.normalize();
  if (n.y < 0) n.negate();
  return n;
};

/** Point in polygon (x, z), points within `tol` of an edge count as inside */
function insideXZ(poly: THREE.Vector3[], x: number, z: number, tol = 0): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  if (inside || tol <= 0) return inside;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j].x, az = poly[j].z, bx = poly[i].x, bz = poly[i].z;
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
    if (Math.hypot(ax + dx * t - x, az + dz * t - z) <= tol) return true;
  }
  return false;
}

/** Sloping face of the roof top under (x, z), with its frame */
interface Slope {
  poly: THREE.Vector3[];
  /** Height of the face at (x, z) */
  y: number;
  /** Level outward (downhill) direction and the level direction along the eave */
  out: THREE.Vector3;
  along: THREE.Vector3;
  /** Rise per metre going in (uphill) */
  slope: number;
}

function slopeAt(top: THREE.Vector3[][], x: number, z: number): Slope | null | 'flat' {
  let flat = false;
  for (const poly of top) {
    if (!insideXZ(poly, x, z, 1e-4)) continue;
    const n = upNormal(poly);
    if (!n) continue;
    const h = Math.hypot(n.x, n.z);
    const slope = h / Math.max(n.y, 1e-3);
    if (slope < MIN_SLOPE) { flat = true; continue; }
    const out = V(n.x / h, 0, n.z / h);
    const p0 = poly[0];
    const y = p0.y - slope * ((x - p0.x) * out.x + (z - p0.z) * out.z);
    return { poly, y, out, along: V(-out.z, 0, out.x), slope };
  }
  return flat ? 'flat' : null;
}

/** Level downhill direction of the sloping face under (x, z), or null */
export function slopeOutAt(top: THREE.Vector3[][], x: number, z: number): THREE.Vector3 | null {
  const sl = slopeAt(top, x, z);
  return sl && sl !== 'flat' ? sl.out : null;
}

/** Nearest hit of a (roof local) ray with the roof top, or null */
export function pickRoofTop(top: THREE.Vector3[][], origin: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null;
  let bestT = Infinity;
  for (const poly of top) {
    const n = upNormal(poly);
    if (!n) continue;
    const den = n.dot(dir);
    if (Math.abs(den) < 1e-6) continue;
    const t = n.dot(new THREE.Vector3().subVectors(poly[0], origin)) / den;
    if (t <= 0 || t >= bestT) continue;
    const p = origin.clone().addScaledVector(dir, t);
    if (!insideXZ(poly, p.x, p.z, 1e-3)) continue;
    bestT = t;
    best = p;
  }
  return best;
}

/** Separating axis test of two convex polygons (x, z) */
function convexOverlap(a: THREE.Vector2[], b: THREE.Vector2[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const nx = -(q.y - p.y), ny = q.x - p.x;
      const span = (pts: THREE.Vector2[]) => {
        let lo = Infinity, hi = -Infinity;
        for (const s of pts) { const d = s.x * nx + s.y * ny; lo = Math.min(lo, d); hi = Math.max(hi, d); }
        return [lo, hi];
      };
      const [a0, a1] = span(a), [b0, b1] = span(b);
      if (a1 <= b0 + 1e-4 || b1 <= a0 + 1e-4) return false;
    }
  }
  return true;
}

/** Point in a convex plan (x, z) */
export function planContains(plan: THREE.Vector2[], x: number, z: number): boolean {
  return insideXZ(plan.map((p) => V(p.x, 0, p.y)), x, z, 0.05);
}

/** Height field of the roof top: the highest face over a point (planes with bounds, for speed) */
class Surface {
  private readonly faces: Array<{ poly: THREE.Vector3[]; n: THREE.Vector3; x0: number; x1: number; z0: number; z1: number }> = [];
  /** Heights of the top's vertices (where the slope may break) */
  readonly breaks: number[];

  constructor(top: THREE.Vector3[][]) {
    const ys = new Set<number>();
    for (const poly of top) {
      const n = upNormal(poly);
      if (!n || n.y < 1e-3) continue;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of poly) {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
        ys.add(Math.round(p.y * 1000) / 1000);
      }
      this.faces.push({ poly, n, x0, x1, z0, z1 });
    }
    this.breaks = [...ys];
  }

  /** Height of the roof top at (x, z), or null off the roof */
  y(x: number, z: number): number | null {
    let best: number | null = null;
    for (const f of this.faces) {
      if (x < f.x0 - 1e-4 || x > f.x1 + 1e-4 || z < f.z0 - 1e-4 || z > f.z1 + 1e-4) continue;
      if (!insideXZ(f.poly, x, z, 1e-4)) continue;
      const p = f.poly[0];
      const y = p.y - (f.n.x * (x - p.x) + f.n.z * (z - p.z)) / f.n.y;
      if (best === null || y > best) best = y;
    }
    return best;
  }
}

/** How far in a dormer may reach looking for the roof behind it (m) */
const MAX_REACH = 10;
const REACH_STEP = 0.1;

interface Built {
  geo: DormerGeometry;
  plan: THREE.Vector2[];
}

/**
 * One dormer standing at its point. Its back runs into the roof wherever the roof surface rises to
 * meet it, over a knee onto the next face too (gambrel and mansard dormers tie into the upper
 * slope). Returns null when it does not fit: its foot off a slope, or the roof never rising to meet
 * its back (past a ridge, off the roof's edge).
 */
function buildDormer(d: RoofDormer, sl: Slope, surf: Surface): Built | null {
  const s = sl.slope;
  const F = V(d.x, sl.y, d.z);
  const a = sl.along, o = sl.out;
  // Dormer frame: lat along the eave, dep in from the front wall, h up from the front wall's foot
  const P = (lat: number, dep: number, h: number) =>
    V(F.x + a.x * lat - o.x * dep, F.y + h, F.z + a.z * lat - o.z * dep);
  /** Roof height (relative to the foot) at (lat, dep), or null off the roof */
  const roofH = (lat: number, dep: number) => {
    const y = surf.y(F.x + a.x * lat - o.x * dep, F.z + a.z * lat - o.z * dep);
    return y === null ? null : y - F.y;
  };
  /** First depth (from the front wall) where the roof rises to the line h0 + rise * dep */
  const reach = (lat: number, h0: number, rise = 0): number | null => {
    const gap = (dep: number) => { const r = roofH(lat, dep); return r === null ? null : r - (h0 + rise * dep); };
    let d0 = 0;
    let g0 = gap(0);
    if (g0 === null) return null;
    if (g0 >= 0) return 0;
    let prevRoof = roofH(lat, 0)!;
    for (let d1 = REACH_STEP; d1 <= MAX_REACH; d1 += REACH_STEP) {
      const g1 = gap(d1);
      if (g1 === null) return null;
      // The roof must keep rising behind the dormer: past a ridge (or along it) the dormer is
      // taller than the roof, and must not tunnel on to another wing's slope
      const r1 = roofH(lat, d1)!;
      if (r1 < prevRoof + REACH_STEP * 0.05) return null;
      prevRoof = r1;
      if (g1 >= 0) {
        let lo = d0, hi = d1;
        for (let i = 0; i < 14; i++) {
          const m = (lo + hi) / 2;
          const gm = gap(m);
          if (gm !== null && gm >= 0) hi = m; else lo = m;
        }
        return hi;
      }
      d0 = d1;
      g0 = g1;
    }
    return null;
  };
  const relBreaks = surf.breaks.map((y) => y - F.y);

  const hw = Math.max(d.width, 0.4) / 2;
  const H = Math.max(d.height, 0.3);
  // The front corners stand on the same slope as the middle
  for (const side of [-1, 1]) {
    const r = roofH(side * hw, 0);
    if (r === null || Math.abs(r) > 0.03) return null;
  }
  // Pitch of a gable / hip dormer's roof: the roof's own, but low on the steep lower slope of a
  // gambrel / mansard (a steep one would rise past the knee and ridge)
  const k = s > 1.4 ? 0.6 : THREE.MathUtils.clamp(s, 0.5, 1.2);
  const R = k * hw;
  const ho = hw + OVER;
  const top: THREE.Vector3[][] = [];
  const creases: Array<[THREE.Vector3, THREE.Vector3]> = [];
  const eaves = new Set<THREE.Vector3>();
  const parts: DormerPart[] = [];
  const sub = (p: THREE.Vector3) => p.clone().add(V(0, -SLAB, 0));
  const board = (p: THREE.Vector3, q: THREE.Vector3, out: THREE.Vector3) => parts.push({ pts: [p, q, sub(q), sub(p)], mat: 1, out });
  const roofFace = (poly: THREE.Vector3[]) => {
    for (const tri of triangulatePlanar(poly)) {
      top.push(tri);
      parts.push({ pts: tri.map(sub), mat: 1, out: DOWN });
    }
  };
  const left = a.clone().negate(), right = a, front = o;
  const backs: THREE.Vector3[] = [];

  let style = d.style;
  const hT = H + SLAB - k * OVER; // top of a gable / hip dormer's eave edge
  const Hr = H + R + SLAB;        // top of its ridge
  let cheekRise = 0;

  let wallTop: Array<[number, number]>; // front wall outline above its foot (lat, h), left to right
  if (style === 'gable' || style === 'hip') {
    // Valley from the eave corner up to the ridge, where the dormer's slope meets the roof:
    // samples, plus the heights where the roof's slope breaks (knees)
    const us = new Set<number>();
    for (let i = 0; i <= 8; i++) us.add(i / 8);
    for (const b of relBreaks) { const u = (b - hT) / (Hr - hT); if (u > 0 && u < 1) us.add(u); }
    const chain: Array<[number, number, number]> = []; // lat (>= 0), dep, h
    for (const u of [...us].sort((x, y) => x - y)) {
      const lat = ho * (1 - u), h = hT + (Hr - hT) * u;
      const dep = reach(lat, h);
      if (dep === null) return null;
      chain.push([lat, Math.max(dep, -OVER + 0.02), h]);
    }
    const rbDep = chain[chain.length - 1][1];
    if (style === 'hip' && rbDep <= hw + 0.05) style = 'gable';
    const eL = P(-ho, -OVER, hT), eR = P(ho, -OVER, hT);
    const rb = P(0, rbDep, Hr);
    const rf = style === 'hip' ? P(0, hw, Hr) : P(0, -OVER, Hr);
    const valley = (side: number) => chain.slice(0, -1).map(([lat, dep, h]) => P(side * lat, dep, h));
    const vL = valley(-1), vR = valley(1);
    roofFace([eL, ...vL, rb, rf]);
    roofFace([eR, rf, rb, ...vR.slice().reverse()]);
    board(eL, vL[0], left);
    board(eR, vR[0], right);
    creases.push([rf, rb]);
    if (style === 'hip') {
      roofFace([eL, rf, eR]);
      board(eL, eR, front);
      creases.push([eL, rf], [eR, rf]);
      eaves.add(eL).add(eR);
      wallTop = [[-hw, H], [hw, H]];
    } else {
      board(eL, rf, front);
      board(rf, eR, front);
      wallTop = [[-hw, H], [0, H + R], [hw, H]];
    }
    backs.push(...vL, ...vR, rb);
  } else {
    // Shed: a shallower single slope from the front back up into the roof; flat: level
    cheekRise = style === 'shed' ? Math.min(s * 0.3, 0.35) : 0;
    const t0 = H + SLAB;
    const line: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const lat = -ho + (2 * ho * i) / 8;
      const dep = reach(lat, t0, cheekRise);
      if (dep === null) return null;
      line.push(P(lat, dep, t0 + cheekRise * dep));
    }
    const eL = P(-ho, -OVER, t0 - cheekRise * OVER), eR = P(ho, -OVER, t0 - cheekRise * OVER);
    roofFace([eL, ...line, eR]);
    board(eL, eR, front);
    board(eL, line[0], left);
    board(eR, line[line.length - 1], right);
    wallTop = [[-hw, H], [hw, H]];
    backs.push(...line);
  }

  // Cheeks: from the front wall back along the roof (bending over a knee) to where the roof meets
  // the underside of the dormer's roof
  for (const side of [-1, 1]) {
    const lat = side * hw;
    const back = reach(lat, H, cheekRise);
    if (back === null) return null;
    const deps = new Set<number>([back]);
    for (let i = 1; i < 8; i++) deps.add((back * i) / 8);
    for (const b of relBreaks) { const dep = b > 0 && b < H + cheekRise * back ? reach(lat, b) : null; if (dep !== null && dep > 0 && dep < back) deps.add(dep); }
    const foot: THREE.Vector3[] = [P(lat, 0, 0)];
    for (const dep of [...deps].sort((x, y) => x - y)) {
      const r = roofH(lat, dep);
      if (r === null) return null;
      foot.push(P(lat, dep, Math.min(r, H + cheekRise * dep)));
    }
    for (const tri of triangulatePlanar([...foot, P(lat, 0, H)])) parts.push({ pts: tri, mat: 2, out: side < 0 ? left : right });
  }

  // Front wall with its windows (one per ~1.4 m of width)
  const n = Math.max(1, Math.round(d.width / 1.4));
  const gap = 0.22;
  const ww = Math.min((2 * hw - gap * (n + 1)) / n, 1.1);
  const wy0 = Math.min(0.25, H * 0.25), wy1 = H - Math.min(0.15, H * 0.15);
  const step = (2 * hw) / n;
  const windows: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const c = -hw + step * (i + 0.5);
    windows.push([c - ww / 2, c + ww / 2]);
  }
  const contour = [new THREE.Vector2(-hw, 0), new THREE.Vector2(hw, 0), ...wallTop.slice().reverse().map(([l, h]) => new THREE.Vector2(l, h))];
  const holes = windows.map(([l0, l1]) => [new THREE.Vector2(l0, wy0), new THREE.Vector2(l0, wy1), new THREE.Vector2(l1, wy1), new THREE.Vector2(l1, wy0)]);
  const all = [...contour, ...holes.flat()];
  for (const tri of THREE.ShapeUtils.triangulateShape(contour, holes)) {
    parts.push({ pts: tri.map((i) => P(all[i].x, 0, all[i].y)), mat: 2, out: front });
  }
  const f = -0.012; // trim stands just proud of the wall
  for (const [l0, l1] of windows) {
    const rect = (x0: number, x1: number, y0: number, y1: number, dep: number, mat: 1 | 3) =>
      parts.push({ pts: [P(x0, dep, y0), P(x1, dep, y0), P(x1, dep, y1), P(x0, dep, y1)], mat, out: front });
    // Reveals into the wall, glass at their back, glazing bars, frame and sill
    parts.push({ pts: [P(l0, 0, wy0), P(l0, REVEAL, wy0), P(l0, REVEAL, wy1), P(l0, 0, wy1)], mat: 1, out: right });
    parts.push({ pts: [P(l1, 0, wy0), P(l1, REVEAL, wy0), P(l1, REVEAL, wy1), P(l1, 0, wy1)], mat: 1, out: left });
    parts.push({ pts: [P(l0, 0, wy1), P(l0, REVEAL, wy1), P(l1, REVEAL, wy1), P(l1, 0, wy1)], mat: 1, out: DOWN });
    parts.push({ pts: [P(l0, 0, wy0), P(l0, REVEAL, wy0), P(l1, REVEAL, wy0), P(l1, 0, wy0)], mat: 1, out: UP });
    rect(l0, l1, wy0, wy1, REVEAL, 3);
    const cm = (l0 + l1) / 2, hm = (wy0 + wy1) / 2;
    rect(cm - BAR, cm + BAR, wy0, wy1, REVEAL - 0.01, 1);
    rect(l0, l1, hm - BAR, hm + BAR, REVEAL - 0.012, 1);
    rect(l0 - FRAME, l1 + FRAME, wy1, wy1 + FRAME, f, 1);
    rect(l0 - FRAME, l0, wy0, wy1, f, 1);
    rect(l1, l1 + FRAME, wy0, wy1, f, 1);
    // Sill: a ledge under the window
    const s0 = wy0 - 0.05;
    parts.push({ pts: [P(l0 - FRAME, -SILL, wy0), P(l1 + FRAME, -SILL, wy0), P(l1 + FRAME, 0, wy0), P(l0 - FRAME, 0, wy0)], mat: 1, out: UP });
    rect(l0 - FRAME, l1 + FRAME, s0, wy0, -SILL, 1);
    parts.push({ pts: [P(l0 - FRAME, -SILL, s0), P(l0 - FRAME, 0, s0), P(l1 + FRAME, 0, s0), P(l1 + FRAME, -SILL, s0)], mat: 1, out: DOWN });
    parts.push({ pts: [P(l0 - FRAME, -SILL, s0), P(l0 - FRAME, -SILL, wy0), P(l0 - FRAME, 0, wy0), P(l0 - FRAME, 0, s0)], mat: 1, out: left });
    parts.push({ pts: [P(l1 + FRAME, -SILL, s0), P(l1 + FRAME, 0, s0), P(l1 + FRAME, 0, wy0), P(l1 + FRAME, -SILL, wy0)], mat: 1, out: right });
  }

  const depth = Math.max(...backs.map((p) => (F.x - p.x) * o.x + (F.z - p.z) * o.z));
  const plan2 = (lat: number, dep: number) => new THREE.Vector2(F.x + a.x * lat - o.x * dep, F.z + a.z * lat - o.z * dep);
  return {
    geo: { top, creases, eaves, parts },
    plan: [plan2(-ho, -OVER), plan2(ho, -OVER), plan2(ho, depth), plan2(-ho, depth)],
  };
}

/** Triangles of a planar polygon (any shape, no self crossings), in its own plane */
function triangulatePlanar(poly: THREE.Vector3[]): THREE.Vector3[][] {
  const pts = poly.filter((p, i) => p.distanceToSquared(poly[(i + 1) % poly.length]) > 1e-10);
  if (pts.length < 3) return [];
  if (pts.length === 3) return [pts];
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    n.x += (p.y - q.y) * (p.z + q.z);
    n.y += (p.z - q.z) * (p.x + q.x);
    n.z += (p.x - q.x) * (p.y + q.y);
  }
  if (n.lengthSq() < 1e-12) return [];
  n.normalize();
  const u = Math.abs(n.y) < 0.9 ? new THREE.Vector3().crossVectors(UP, n).normalize() : V(1, 0, 0);
  const v = new THREE.Vector3().crossVectors(n, u);
  const flat = pts.map((p) => new THREE.Vector2(p.dot(u), p.dot(v)));
  return THREE.ShapeUtils.triangulateShape(flat, []).map((t) => t.map((i) => pts[i]));
}

/**
 * Lays the dormers out on the roof top: each stands on the sloping face under its point, must fit
 * on the roof and must not overlap an earlier one. Returns their geometry and where each one went.
 */
export function layOutDormers(top: THREE.Vector3[][], dormers: RoofDormer[]): { geo: DormerGeometry; layout: DormerLayout[] } {
  const geo: DormerGeometry = { top: [], creases: [], eaves: new Set(), parts: [] };
  const layout: DormerLayout[] = [];
  const placed: THREE.Vector2[][] = [];
  const surf = dormers.length ? new Surface(top) : null;
  for (const d of dormers) {
    const sl = slopeAt(top, d.x, d.z);
    if (sl === null) { layout.push({ id: d.id, ok: false, reason: 'build.dormer.noSlope' }); continue; }
    if (sl === 'flat') { layout.push({ id: d.id, ok: false, reason: 'build.dormer.tooFlat' }); continue; }
    const b = buildDormer(d, sl, surf!);
    if (!b) {
      layout.push({ id: d.id, ok: false, reason: 'build.dormer.noFit' });
      continue;
    }
    if (placed.some((p) => convexOverlap(p, b.plan))) {
      layout.push({ id: d.id, ok: false, reason: 'build.dormer.overlap', plan: b.plan });
      continue;
    }
    placed.push(b.plan);
    geo.top.push(...b.geo.top);
    geo.creases.push(...b.geo.creases);
    b.geo.eaves.forEach((p) => geo.eaves.add(p));
    geo.parts.push(...b.geo.parts);
    layout.push({ id: d.id, ok: true, plan: b.plan });
  }
  return { geo, layout };
}

/** Attaches the dormers' geometry to a roof shape */
export function withDormers(shape: RoofShape, dormers: RoofDormer[] | undefined): RoofShape {
  if (!dormers || dormers.length === 0) return shape;
  const { geo, layout } = layOutDormers(shape.top, dormers);
  return { ...shape, dormers: geo, dormerLayout: layout };
}

/** Saved dormers, cleaned up (unknown fields dropped, sizes clamped) */
export function sanitizeDormers(raw: unknown): RoofDormer[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RoofDormer[] = [];
  raw.forEach((d, i) => {
    if (!d || typeof d !== 'object') return;
    const x = Number((d as any).x), z = Number((d as any).z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const num = (v: unknown, r: { min: number; max: number; initial: number }) => {
      const n = Number(v);
      return Number.isFinite(n) ? THREE.MathUtils.clamp(n, r.min, r.max) : r.initial;
    };
    const style = DORMER_STYLES.includes((d as any).style) ? (d as any).style as DormerStyle : 'gable';
    out.push({
      id: typeof (d as any).id === 'string' ? (d as any).id : `dormer_${i}`,
      x, z,
      width: num((d as any).width, DORMER_WIDTH),
      height: num((d as any).height, DORMER_HEIGHT),
      style,
    });
  });
  return out.length ? out : undefined;
}
