import * as THREE from 'three';
import { WALL_THICKNESS } from './config/BuildingConstants';
import type { ProceduralRoofConfig } from './ProceduralRoofSystem';
import { normalizeFootprint, solveHouseRoofShape } from './HouseRoofGeometry';
import { withDormers, type DormerGeometry, type DormerLayout } from './RoofDormers';

/**
 * Shape of a procedural roof in its local space (y = 0 is the top of the walls it sits on;
 * minX..maxX / minZ..maxZ are the wall centre lines, or the bounds of `footprint` for a house roof).
 *
 * The roof is a slab of constant thickness: its underside rests on the outer top edge of the walls
 * and the eaves carry on down past it, so there is never a gap between wall and roof. Frontons and
 * attic walls stand flush with the walls' outer faces and end exactly on the underside.
 */
export interface RoofShape {
  /** Top surface polygons (planar, any winding) */
  top: THREE.Vector3[][];
  /** Closed loop around the top surface: the eave / rake edge */
  outline: THREE.Vector3[];
  /** Vertical slab thickness (the underside is the top moved down by it) */
  drop: number;
  /**
   * Underside point of each top vertex, when the slab is not one vertical thickness throughout
   * (slopes of different pitch keep the same board width; eave ends cut square to the slope)
   */
  under?: Map<THREE.Vector3, THREE.Vector3>;
  /** Ridge and hip lines that get a raised cap; both ends are vertices of the adjacent top polygons */
  creases: Array<[THREE.Vector3, THREE.Vector3]>;
  /** Frontons and attic walls with their outward direction */
  attic: Array<{ pts: THREE.Vector3[]; out: THREE.Vector3 }>;
  /**
   * Flat boxed eave: a level soffit at `y` from the eave line in to `inner` (the walls' outer faces)
   * instead of an underside that follows the slope
   */
  soffit?: { y: number; inner: THREE.Vector3[] };
  /** Attic ceiling over the walls' footprint, seen from below (any simple polygon) */
  ceiling: THREE.Vector3[];
  /** Ridge cap half width and rise */
  capWidth: number;
  capRise: number;
  /** Dormers standing on the slopes, and where each one of the config's dormers went */
  dormers?: DormerGeometry;
  dormerLayout?: DormerLayout[];
}

const HALF_WALL = WALL_THICKNESS / 2;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Slope (rise per metre) of a slab whose top is `rise` above the wall top at the ridge, `run` metres
 * in from the outer wall line, with its underside on that line. The vertical thickness grows with
 * the pitch, so this is solved by a few fixed-point steps.
 */
export function solvePitch(rise: number, run: number, thickness: number): { slope: number; drop: number } {
  let slope = rise / Math.max(run, 0.05);
  let drop = thickness;
  for (let i = 0; i < 8; i++) {
    drop = Math.min(thickness * Math.sqrt(1 + slope * slope), rise * 0.5);
    slope = (rise - drop) / Math.max(run, 0.05);
  }
  return { slope: Math.max(slope, 0), drop };
}

/** The roof with its dormers */
export function solveRoofShape(cfg: ProceduralRoofConfig): RoofShape {
  return withDormers(solveBaseRoofShape(cfg), cfg.dormers);
}

/** The roof alone, without dormers (cached per config object: dormer placement asks it often) */
const baseCache = new WeakMap<ProceduralRoofConfig, RoofShape>();
export function solveBaseRoofShape(cfg: ProceduralRoofConfig): RoofShape {
  let shape = baseCache.get(cfg);
  if (!shape) {
    shape = solveBareRoof(cfg);
    baseCache.set(cfg, shape);
  }
  return shape;
}

function solveBareRoof(cfg: ProceduralRoofConfig): RoofShape {
  // A roof over a whole house outline (L, T, U...): one hip roof following the walls
  if (cfg.footprint) {
    const footprint = normalizeFootprint(cfg.footprint);
    if (footprint) return solveHouseRoofShape(cfg, footprint);
  }
  const thickness = THREE.MathUtils.clamp(cfg.fasciaDepth ?? 0.135, 0.04, 0.3);
  const eaveO = Math.max(0, cfg.eaveOverhang ?? cfg.overhang ?? 0.25);
  const gableO = Math.max(0, cfg.gableOverhang ?? cfg.overhang ?? 0.3);
  const h = Math.max(cfg.height, 0.05);

  // Outer wall faces
  const X0 = cfg.minX - HALF_WALL, X1 = cfg.maxX + HALF_WALL;
  const Z0 = cfg.minZ - HALF_WALL, Z1 = cfg.maxZ + HALF_WALL;
  const midX = (X0 + X1) / 2, midZ = (Z0 + Z1) / 2;
  const ceiling = [V(X0, 0, Z0), V(X1, 0, Z0), V(X1, 0, Z1), V(X0, 0, Z1)];

  if (cfg.roofType === 'shed') {
    // Low edge at -Z, high edge at +Z; the top reaches `height` over the high wall
    const { slope, drop } = solvePitch(h, Z1 - Z0, thickness);
    const y = (z: number) => drop + slope * (z - Z0);
    const ex0 = X0 - gableO, ex1 = X1 + gableO, ez0 = Z0 - eaveO, ez1 = Z1 + eaveO;
    const a = V(ex0, y(ez0), ez0), b = V(ex1, y(ez0), ez0), c = V(ex1, y(ez1), ez1), d = V(ex0, y(ez1), ez1);
    const highUnder = y(Z1) - drop;
    return {
      top: [[a, b, c, d]],
      outline: [a, b, c, d],
      drop,
      creases: [],
      attic: [
        { pts: [V(X0, 0, Z0), V(X0, 0, Z1), V(X0, highUnder, Z1)], out: V(-1, 0, 0) },
        { pts: [V(X1, 0, Z0), V(X1, 0, Z1), V(X1, highUnder, Z1)], out: V(1, 0, 0) },
        { pts: [V(X0, 0, Z1), V(X1, 0, Z1), V(X1, highUnder, Z1), V(X0, highUnder, Z1)], out: V(0, 0, 1) },
      ],
      ceiling,
      capWidth: 0,
      capRise: 0,
    };
  }

  if (cfg.roofType === 'hip') {
    const wo = X1 - X0, lo = Z1 - Z0;
    const run = Math.min(wo, lo) / 2;
    const { slope, drop } = solvePitch(h, run, thickness);
    const ye = drop - slope * eaveO;
    const ex0 = X0 - eaveO, ex1 = X1 + eaveO, ez0 = Z0 - eaveO, ez1 = Z1 + eaveO;
    const reach = run + eaveO; // ridge inset from the eave line
    const alongZ = lo >= wo;
    const r0 = alongZ ? V(midX, h, ez0 + reach) : V(ex0 + reach, h, midZ);
    const r1 = alongZ ? V(midX, h, ez1 - reach) : V(ex1 - reach, h, midZ);
    const cLF = V(ex0, ye, ez0), cRF = V(ex1, ye, ez0), cRB = V(ex1, ye, ez1), cLB = V(ex0, ye, ez1);
    const square = r0.distanceTo(r1) < 1e-3;
    const r1s = square ? r0 : r1;

    const top = alongZ
      ? [[cLF, cRF, r0], [cRB, cLB, r1s], [cLB, cLF, r0, r1s], [cRF, cRB, r1s, r0]]
      : [[cLF, cLB, r0], [cRB, cRF, r1s], [cRF, cLF, r0, r1s], [cLB, cRB, r1s, r0]];
    const creases: Array<[THREE.Vector3, THREE.Vector3]> = alongZ
      ? [[cLF, r0], [cRF, r0], [cLB, r1s], [cRB, r1s]]
      : [[cLF, r0], [cLB, r0], [cRF, r1s], [cRB, r1s]];
    if (!square) creases.push([r0, r1s]);
    return {
      top: top.map((poly) => poly.filter((p, i) => poly.indexOf(p) === i)),
      outline: [cLF, cRF, cRB, cLB],
      drop,
      creases,
      attic: [],
      soffit: { y: ye - drop, inner: ceiling },
      ceiling,
      capWidth: Math.min(0.11, run * 0.3),
      capRise: 0.06,
    };
  }

  if (cfg.roofType === 'gambrel') return solveGambrel(X0, X1, Z0, Z1, h, thickness, eaveO, gableO, ceiling);
  if (cfg.roofType === 'mansard') return solveMansard(X0, X1, Z0, Z1, h, thickness, eaveO, ceiling);

  // Gable: ridge along Z, slopes facing -X and +X
  const run = (X1 - X0) / 2;
  const { slope, drop } = solvePitch(h, run, thickness);
  const ye = drop - slope * eaveO;
  const ex0 = X0 - eaveO, ex1 = X1 + eaveO, ez0 = Z0 - gableO, ez1 = Z1 + gableO;
  const lf = V(ex0, ye, ez0), lb = V(ex0, ye, ez1), rf = V(ex1, ye, ez0), rb = V(ex1, ye, ez1);
  const af = V(midX, h, ez0), ab = V(midX, h, ez1);
  const apexUnder = h - drop;
  return {
    top: [[lf, lb, ab, af], [rb, rf, af, ab]],
    outline: [lf, af, rf, rb, ab, lb],
    drop,
    creases: [[af, ab]],
    attic: [
      { pts: [V(X0, 0, Z0), V(midX, apexUnder, Z0), V(X1, 0, Z0)], out: V(0, 0, -1) },
      { pts: [V(X0, 0, Z1), V(midX, apexUnder, Z1), V(X1, 0, Z1)], out: V(0, 0, 1) },
    ],
    ceiling,
    capWidth: Math.min(0.11, run * 0.3),
    capRise: 0.06,
  };
}

// Broken-pitch roofs: a steep lower slope from the eave up to a knee, then a shallow upper slope.
// The knee sits KNEE_IN of the run in from the wall line, KNEE_UP of the height up.
const KNEE_IN = 0.3;
const KNEE_UP = 0.62;
// A mansard's lower slopes are close to upright walls, its top a low, flat-looking hip
const MANSARD_KNEE_IN = 0.17;
const MANSARD_KNEE_UP = 0.78;
/** How far below the wall top the eave of a steep lower slope may hang */
const MAX_EAVE_HANG = 0.3;

/** Gambrel: a gable with a knee in each slope (ridge along Z, frontons at both Z ends) */
function solveGambrel(
  X0: number, X1: number, Z0: number, Z1: number,
  h: number, thickness: number, eaveOverhang: number, gableO: number, ceiling: THREE.Vector3[]
): RoofShape {
  const run = (X1 - X0) / 2;
  const midX = (X0 + X1) / 2;
  const kIn = run * KNEE_IN;
  const { slope, drop } = solvePitch(h * KNEE_UP, kIn, thickness);
  const yk = drop + slope * kIn;
  // On a steep slope a full overhang would hang far down the wall: keep the eave a short kick,
  // but long enough that the square-cut end's lower edge comes out past the wall face and below
  // its top (shorter, the cut ends inside the wall line and leaves a slot over the wall)
  const t = drop / Math.sqrt(1 + slope * slope);
  const cutReach = (t * slope) / Math.sqrt(1 + slope * slope);
  const eaveO = Math.max(Math.min(eaveOverhang, MAX_EAVE_HANG / Math.max(slope, 0.01)), cutReach + 0.03);
  const ye = drop - slope * eaveO;
  const ez0 = Z0 - gableO, ez1 = Z1 + gableO;
  const xL = X0 + kIn, xR = X1 - kIn;
  const eL0 = V(X0 - eaveO, ye, ez0), eL1 = V(X0 - eaveO, ye, ez1);
  const eR0 = V(X1 + eaveO, ye, ez0), eR1 = V(X1 + eaveO, ye, ez1);
  const kL0 = V(xL, yk, ez0), kL1 = V(xL, yk, ez1), kR0 = V(xR, yk, ez0), kR1 = V(xR, yk, ez1);
  const r0 = V(midX, h, ez0), r1 = V(midX, h, ez1);

  // Underside of the profile: each slope's top line moved in by the same board width `t`
  // (perpendicular), meeting the next slope's at the knee and ridge; the eave end is cut square to
  // the slope instead of plumb, so it never runs out into a long point. `t` is what the lower
  // slope's vertical thickness `drop` is across, so its underside still rests on the wall edge.
  const upSlope = (h - yk) / Math.max(midX - xL, 0.05);
  const nLow = new THREE.Vector2(-slope, 1).normalize();   // up-out normal of the left lower slope
  const nUp = new THREE.Vector2(-upSlope, 1).normalize();  // left upper slope
  const nUpR = new THREE.Vector2(upSlope, 1).normalize();  // right upper slope
  const miter = (a: THREE.Vector2, b: THREE.Vector2) => a.clone().add(b).multiplyScalar(t / (1 + a.dot(b)));
  const kneeIn = miter(nLow, nUp);    // knee: left lower meets left upper (mirrored on the right)
  const ridgeIn = miter(nUp, nUpR);
  const eaveIn = nLow.clone().multiplyScalar(t);
  const under = new Map<THREE.Vector3, THREE.Vector3>();
  const set = (p: THREE.Vector3, d: THREE.Vector2, mirror: boolean) =>
    under.set(p, V(p.x - (mirror ? -d.x : d.x), p.y - d.y, p.z));
  for (const [e, k] of [[eL0, kL0], [eL1, kL1]]) { set(e, eaveIn, false); set(k, kneeIn, false); }
  for (const [e, k] of [[eR0, kR0], [eR1, kR1]]) { set(e, eaveIn, true); set(k, kneeIn, true); }
  set(r0, ridgeIn, false);
  set(r1, ridgeIn, false);
  const u = (q: THREE.Vector3, z: number) => { const w = under.get(q)!; return V(w.x, w.y, z); };
  // Frontons reach up to that underside
  const fronton = (z: number) => [V(X0, 0, z), u(kL0, z), u(r0, z), u(kR0, z), V(X1, 0, z)];
  return {
    under,
    top: [[eL0, eL1, kL1, kL0], [kL0, kL1, r1, r0], [eR1, eR0, kR0, kR1], [kR1, kR0, r0, r1]],
    outline: [eL0, kL0, r0, kR0, eR0, eR1, kR1, r1, kL1, eL1],
    drop,
    // Ridge, and a trim along each knee so the break in the slope reads from afar
    creases: [[r0, r1], [kL0, kL1], [kR0, kR1]],
    attic: [
      { pts: fronton(Z0), out: V(0, 0, -1) },
      { pts: fronton(Z1), out: V(0, 0, 1) },
    ],
    ceiling,
    capWidth: Math.min(0.11, run * 0.3),
    capRise: 0.06,
  };
}

/** Mansard: steep lower slopes on all four sides up to a knee ring, a low hip roof on top */
function solveMansard(
  X0: number, X1: number, Z0: number, Z1: number,
  h: number, thickness: number, eaveOverhang: number, ceiling: THREE.Vector3[]
): RoofShape {
  const wo = X1 - X0, lo = Z1 - Z0;
  const run = Math.min(wo, lo) / 2;
  const kIn = run * MANSARD_KNEE_IN;
  // The eave board stays one plank deep however tall the roof gets (the steep slope's vertical
  // thickness would grow with the height); the slab is closed underneath by the soffit anyway
  const drop = Math.min(thickness * 1.2, h * 0.2);
  const yk = Math.max(h * MANSARD_KNEE_UP, drop + 0.05);
  const slope = (yk - drop) / Math.max(kIn, 0.05);
  // On a steep slope a full overhang would hang far down the wall: keep the eave a short kick
  const eaveO = Math.min(eaveOverhang, MAX_EAVE_HANG / Math.max(slope, 0.01));
  const ye = drop - slope * eaveO;
  // Eave ring and knee ring
  const ex0 = X0 - eaveO, ex1 = X1 + eaveO, ez0 = Z0 - eaveO, ez1 = Z1 + eaveO;
  const kx0 = X0 + kIn, kx1 = X1 - kIn, kz0 = Z0 + kIn, kz1 = Z1 - kIn;
  const eLF = V(ex0, ye, ez0), eRF = V(ex1, ye, ez0), eRB = V(ex1, ye, ez1), eLB = V(ex0, ye, ez1);
  const kLF = V(kx0, yk, kz0), kRF = V(kx1, yk, kz0), kRB = V(kx1, yk, kz1), kLB = V(kx0, yk, kz1);
  // Low hip over the knee ring, its ridge along the longer side
  const kw = kx1 - kx0, kl = kz1 - kz0;
  const reach = Math.min(kw, kl) / 2;
  const midX = (X0 + X1) / 2, midZ = (Z0 + Z1) / 2;
  const alongZ = kl >= kw;
  const r0 = alongZ ? V(midX, h, kz0 + reach) : V(kx0 + reach, h, midZ);
  let r1 = alongZ ? V(midX, h, kz1 - reach) : V(kx1 - reach, h, midZ);
  const square = r0.distanceTo(r1) < 1e-3;
  if (square) r1 = r0;
  const upper = alongZ
    ? [[kLF, kRF, r0], [kRB, kLB, r1], [kLB, kLF, r0, r1], [kRF, kRB, r1, r0]]
    : [[kLF, kLB, r0], [kRB, kRF, r1], [kRF, kLF, r0, r1], [kLB, kRB, r1, r0]];
  const lower = [[eLF, eRF, kRF, kLF], [eRF, eRB, kRB, kRF], [eRB, eLB, kLB, kRB], [eLB, eLF, kLF, kLB]];
  const creases: Array<[THREE.Vector3, THREE.Vector3]> = [
    [eLF, kLF], [eRF, kRF], [eRB, kRB], [eLB, kLB],
    // Trim round the knee ring, where the steep sides meet the low top
    [kLF, kRF], [kRF, kRB], [kRB, kLB], [kLB, kLF],
    ...(alongZ
      ? [[kLF, r0], [kRF, r0], [kLB, r1], [kRB, r1]]
      : [[kLF, r0], [kLB, r0], [kRF, r1], [kRB, r1]]) as Array<[THREE.Vector3, THREE.Vector3]>,
  ];
  if (!square) creases.push([r0, r1]);
  return {
    top: [...lower, ...upper.map((poly) => poly.filter((p, i) => poly.indexOf(p) === i))],
    outline: [eLF, eRF, eRB, eLB],
    drop,
    creases,
    attic: [],
    soffit: { y: ye - drop, inner: ceiling },
    ceiling,
    capWidth: Math.min(0.11, run * 0.3),
    capRise: 0.06,
  };
}

/** Footprint of a roof at the wall centre lines, in its local space */
export function roofFootprint(cfg: Pick<ProceduralRoofConfig, 'minX' | 'maxX' | 'minZ' | 'maxZ'>) {
  return {
    cx: (cfg.minX + cfg.maxX) / 2,
    cz: (cfg.minZ + cfg.maxZ) / 2,
    width: cfg.maxX - cfg.minX,
    length: cfg.maxZ - cfg.minZ,
  };
}

// ---------------------------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------------------------

/** Per-material triangle soup with flat normals and face-planar metre UVs */
class RoofBuilder {
  readonly buckets = [0, 1, 2, 3].map(() => ({ p: [] as number[], n: [] as number[], u: [] as number[] }));
  private readonly t = new THREE.Vector3();
  private readonly b = new THREE.Vector3();

  constructor(private readonly uvScale: number) {}

  /** Triangle fan of a planar polygon, wound so its normal points along `hint` */
  polygon(pts: THREE.Vector3[], mat: 0 | 1 | 2 | 3, hint: THREE.Vector3, uvOf?: (q: THREE.Vector3, k: number) => [number, number]): void {
    if (pts.length < 3) return;
    const n = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      n.x += (a.y - c.y) * (a.z + c.z);
      n.y += (a.z - c.z) * (a.x + c.x);
      n.z += (a.x - c.x) * (a.y + c.y);
    }
    if (n.lengthSq() < 1e-12) return;
    n.normalize();
    const ordered = n.dot(hint) < 0 ? [...pts].reverse() : pts;
    if (n.dot(hint) < 0) n.negate();
    const flipped = ordered !== pts;
    const uv = uvOf
      ? ordered.flatMap((q, i) => uvOf(q, flipped ? pts.length - 1 - i : i))
      : this.planarUV(n, ordered);
    const { p, n: nb, u } = this.buckets[mat];
    for (let i = 1; i < ordered.length - 1; i++) {
      for (const k of [0, i, i + 1]) {
        const q = ordered[k];
        p.push(q.x, q.y, q.z);
        nb.push(n.x, n.y, n.z);
        u.push(uv[k * 2], uv[k * 2 + 1]);
      }
    }
  }

  /** U runs level along the face, V up it (from y = 0), both in metres, so courses line up */
  private planarUV(n: THREE.Vector3, pts: THREE.Vector3[]): number[] {
    const s = this.uvScale;
    const out: number[] = [];
    if (Math.abs(n.y) > 0.985) {
      for (const q of pts) out.push(q.x * s, q.z * s);
      return out;
    }
    this.t.set(n.z, 0, -n.x).normalize(); // UP x n
    this.b.crossVectors(n, this.t).normalize();
    if (this.b.y < 0) this.b.negate();
    const rise = this.b.y;
    for (const q of pts) out.push(q.dot(this.t) * s, (rise > 1e-3 ? q.y / rise : q.dot(this.b)) * s);
    return out;
  }
}

const faceNormal = (poly: THREE.Vector3[]) => {
  const n = new THREE.Vector3();
  for (let i = 1; i < poly.length - 1; i++) {
    const e1 = new THREE.Vector3().subVectors(poly[i], poly[0]);
    const e2 = new THREE.Vector3().subVectors(poly[i + 1], poly[0]);
    n.add(e1.cross(e2));
  }
  n.normalize();
  if (n.y < 0) n.negate();
  return n;
};

/**
 * Material 0: shingles and ridge caps; 1: white trim (fascia, underside, attic ceiling);
 * 2: frontons / attic walls (the outer wall finish below); 3: dormer window glass.
 */
export function emitRoof(shape: RoofShape, uvScale: number) {
  const b = new RoofBuilder(uvScale);
  const UP = V(0, 1, 0);
  const DOWN = V(0, -1, 0);
  const down = V(0, -shape.drop, 0);
  const dn = (p: THREE.Vector3) => shape.under?.get(p) ?? p.clone().add(down);

  // Top surface and the underside a slab thickness below it
  for (const poly of shape.top) {
    b.polygon(poly, 0, UP);
    if (!shape.soffit) b.polygon(poly.map(dn), 1, DOWN);
  }
  if (shape.soffit) {
    // Level soffit ring between the fascia's bottom edge and the walls
    const y = shape.soffit.y;
    const outer = shape.outline.map((p) => V(p.x, y, p.z));
    const inner = shape.soffit.inner.map((p) => V(p.x, y, p.z));
    const all = [...outer, ...inner];
    const tris = THREE.ShapeUtils.triangulateShape(
      outer.map((p) => new THREE.Vector2(p.x, p.z)),
      [inner.map((p) => new THREE.Vector2(p.x, p.z))]
    );
    for (const t of tris) b.polygon(t.map((i) => all[i]), 1, DOWN);
  }

  // Fascia and rake boards around the edge, facing out (the outline may have inner corners)
  let area = 0;
  for (let i = 0; i < shape.outline.length; i++) {
    const a = shape.outline[i], c = shape.outline[(i + 1) % shape.outline.length];
    area += a.x * c.z - c.x * a.z;
  }
  const side = area >= 0 ? 1 : -1;
  for (let i = 0; i < shape.outline.length; i++) {
    const a = shape.outline[i], c = shape.outline[(i + 1) % shape.outline.length];
    const out = new THREE.Vector3((c.z - a.z) * side, 0, -(c.x - a.x) * side);
    b.polygon([a, c, dn(c), dn(a)], 1, out);
  }

  // Raised ridge / hip caps: a shallow tent over each crease, its tiles laid along it. A hip cap
  // runs on past the eave corner and is closed underneath, so it reads as a solid cap end.
  const caps = (creases: Array<[THREE.Vector3, THREE.Vector3]>, top: THREE.Vector3[][], atEave: (p: THREE.Vector3) => boolean) => {
    const ext = 0.05;
    for (const [p, q] of creases) {
      const t = new THREE.Vector3().subVectors(q, p);
      if (t.lengthSq() < 1e-6) continue;
      t.normalize();
      const sides = top.filter((poly) => poly.includes(p) && poly.includes(q));
      if (sides.length !== 2) continue;
      const us = sides.map((poly) => {
        const u = new THREE.Vector3().crossVectors(faceNormal(poly), t).normalize();
        if (u.y > 0) u.negate();
        return u.multiplyScalar(shape.capWidth);
      });
      // Eave-corner ends of a sloping crease stick out past the corner
      const startOut = atEave(p) && p.y < q.y - 1e-3;
      const endOut = atEave(q) && q.y < p.y - 1e-3;
      const a = startOut ? p.clone().addScaledVector(t, -ext) : p;
      const c = endOut ? q.clone().addScaledVector(t, ext) : q;
      const lift = V(0, shape.capRise, 0);
      const aTop = a.clone().add(lift), cTop = c.clone().add(lift);
      // U across the cap side (kept between two shingle grooves), V along the crease in metres
      const along = (x: THREE.Vector3) => x.dot(t) * uvScale;
      for (const u of us) {
        const out = u.clone().normalize().add(V(0, 0.6, 0));
        const quad = [a.clone().add(u), c.clone().add(u), cTop, aTop];
        b.polygon(quad, 0, out, (x, k) => [k < 2 ? 0.058 : 0.004, along(x)]);
      }
      const [u0, u1] = us;
      b.polygon([a.clone().add(u0), aTop, a.clone().add(u1)], 0, t.clone().negate());
      b.polygon([c.clone().add(u0), cTop, c.clone().add(u1)], 0, t);
      // Underside of the part hanging past the corner: up to where the cap's edges are back over
      // the roof (inside the roof slab from there on)
      const reach = (shape.capWidth * 1.05) / Math.max(0.3, Math.hypot(t.x, t.z));
      if (startOut) {
        const k = p.clone().addScaledVector(t, reach);
        b.polygon([a.clone().add(u0), k.clone().add(u0), k.clone().add(u1), a.clone().add(u1)], 0, DOWN);
      }
      if (endOut) {
        const k = q.clone().addScaledVector(t, -reach);
        b.polygon([c.clone().add(u0), k.clone().add(u0), k.clone().add(u1), c.clone().add(u1)], 0, DOWN);
      }
    }
  };
  if (shape.capWidth > 0) caps(shape.creases, shape.top, (p) => shape.outline.includes(p));

  // Dormers: shingled roofs with their caps, walls, trim and window glass
  if (shape.dormers) {
    const d = shape.dormers;
    for (const poly of d.top) b.polygon(poly, 0, UP);
    for (const part of d.parts) b.polygon(part.pts, part.mat, part.out);
    if (shape.capWidth > 0) caps(d.creases, d.top, (p) => d.eaves.has(p));
  }

  // Attic ceiling and frontons / attic walls
  const ceilingTris = THREE.ShapeUtils.triangulateShape(shape.ceiling.map((p) => new THREE.Vector2(p.x, p.z)), []);
  for (const t of ceilingTris) b.polygon(t.map((i) => shape.ceiling[i]), 1, DOWN);
  for (const wall of shape.attic) b.polygon(wall.pts, 2, wall.out);

  return b.buckets;
}

/** Collision soup: the top surface the player walks on, plus frontons / attic walls */
export function roofColliderTriangles(shape: RoofShape): number[] {
  const out: number[] = [];
  const fan = (pts: THREE.Vector3[]) => {
    for (let i = 1; i < pts.length - 1; i++) {
      for (const q of [pts[0], pts[i], pts[i + 1]]) out.push(q.x, q.y, q.z);
    }
  };
  for (const poly of shape.top) fan(poly);
  for (const wall of shape.attic) fan(wall.pts);
  if (shape.dormers) {
    for (const poly of shape.dormers.top) fan(poly);
    for (const part of shape.dormers.parts) if (part.mat === 2 || part.mat === 3) fan(part.pts);
  }
  return out;
}
