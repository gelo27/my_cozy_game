import * as THREE from 'three';

/**
 * Turns a low-poly crown into a leafy one: rounded leaf "scales" laid over the crown like roof
 * tiles. Each scale lies along the crown's surface and hangs downhill on it: its pointed top tucks
 * into the crown under the row above, its round lower rim lifts off the surface and catches the
 * light, and the next row starts in its shadow. Scales are spread evenly (a minimum spacing, not
 * random clumps), so the crown reads as layered foliage instead of confetti.
 *
 * Opaque geometry only (6 vertices, 4 triangles per scale), no textures or alpha test, so on
 * mobile GPUs it costs what any other triangles cost. Normals are bent towards the direction from
 * the crown's centre (a soft, round crown). The original crown is darkened into the shaded inner
 * volume between scales. The `sway` attribute (0 = rigid, 1 = free rim) drives the wind.
 */

export interface CrownLeafOptions {
  /** Upper bound of scales; fewer are placed once the crown is covered at `spacing`. */
  count: number;
  /** Minimum distance between scale centres (m). */
  spacing: number;
  /** Scale length along the slope (m); width follows. */
  size: number;
  /** Multiplier on the original crown colour (the inner, shaded volume). */
  innerShade: number;
  seed: number;
  /**
   * 'scale': round leaf scales (oak); 'scallop': long hanging clumps with a lobed rim that
   * overhang the tier below (pine); 'needle': thin hanging needle blades.
   */
  shape: 'scale' | 'scallop' | 'needle';
  /** Whole leaf pushed off the crown by this much (m), so the wind never sways it into the mesh. */
  offset: number;
  /**
   * Where the soft lighting normal points from: 'centre' of the crown (a round oak) or the trunk
   * 'axis' (a tall cone, which a single centre would light like a ball).
   */
  lightFrom: 'centre' | 'axis';
  /** Needle / scallop width (m); oak scales are as wide as they are long. */
  width?: number;
}

const isGreen = (r: number, g: number, b: number): boolean => g > r && g > b;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Scale outline in its own frame: x across, y down the slope (0 = attachment), z off the surface.
 * Pointed top tucked under the row above, round lower rim lifted off the crown.
 */
const SHAPE: { x: number; y: number; lift: number; tone: number; sway: number }[] = [
  { x: 0, y: -0.38, lift: -0.06, tone: 0.6, sway: 0 }, // top, tucked in
  { x: -0.5, y: 0.02, lift: 0.03, tone: 0.82, sway: 0.35 },
  { x: -0.34, y: 0.46, lift: 0.1, tone: 0.98, sway: 0.7 },
  { x: 0, y: 0.62, lift: 0.14, tone: 1.1, sway: 1 }, // round lower rim
  { x: 0.34, y: 0.46, lift: 0.1, tone: 0.98, sway: 0.7 },
  { x: 0.5, y: 0.02, lift: 0.03, tone: 0.82, sway: 0.35 },
];
/** Fan from the top vertex. */
const FAN = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5];

/** Needle blade, one triangle like a grass blade: root tucked at the top, tip hanging down and out. */
const NEEDLE: typeof SHAPE = [
  { x: -0.5, y: -0.08, lift: -0.02, tone: 0.72, sway: 0 },
  { x: 0, y: 1.0, lift: 0.16, tone: 1.12, sway: 1 },
  { x: 0.5, y: -0.08, lift: -0.02, tone: 0.72, sway: 0 },
];
const NEEDLE_TRIS = [0, 1, 2];

/**
 * Pine clump: tucked point at the top, straight sides, and a rounded rim of three small lobes
 * that curls out and down over the tier below (the stylised fir-branch look).
 */
const SCALLOP: typeof SHAPE = [
  { x: 0, y: -0.3, lift: -0.08, tone: 0.55, sway: 0 },
  { x: -0.44, y: 0.08, lift: 0.02, tone: 0.74, sway: 0.25 },
  { x: -0.46, y: 0.5, lift: 0.12, tone: 0.9, sway: 0.6 },
  { x: -0.26, y: 0.66, lift: 0.2, tone: 1.08, sway: 0.9 },
  { x: -0.12, y: 0.6, lift: 0.2, tone: 1.0, sway: 0.9 },
  { x: 0, y: 0.72, lift: 0.24, tone: 1.14, sway: 1 },
  { x: 0.12, y: 0.6, lift: 0.2, tone: 1.0, sway: 0.9 },
  { x: 0.26, y: 0.66, lift: 0.2, tone: 1.08, sway: 0.9 },
  { x: 0.46, y: 0.5, lift: 0.12, tone: 0.9, sway: 0.6 },
  { x: 0.44, y: 0.08, lift: 0.02, tone: 0.74, sway: 0.25 },
];
/** Fan from the top vertex over the 9 rim vertices. */
const SCALLOP_TRIS = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 6, 0, 6, 7, 0, 7, 8, 0, 8, 9];

export function addCrownLeaves(src: THREE.BufferGeometry, opts: CrownLeafOptions): THREE.BufferGeometry {
  const P = src.getAttribute('position');
  const C = src.getAttribute('color');
  const N = src.getAttribute('normal');
  const index = src.index;
  const triCount = index ? index.count / 3 : P.count / 3;
  const vi = (t: number, k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k);

  // Crown triangles (all three corners green), weighted by area
  const tris: number[] = [];
  const cdf: number[] = [];
  let total = 0;
  const center = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  let minY = Infinity;
  let maxY = -Infinity;
  for (let t = 0; t < triCount; t++) {
    const i0 = vi(t, 0);
    const i1 = vi(t, 1);
    const i2 = vi(t, 2);
    if (![i0, i1, i2].every((i) => isGreen(C.getX(i), C.getY(i), C.getZ(i)))) continue;
    a.fromBufferAttribute(P, i0);
    b.fromBufferAttribute(P, i1);
    c.fromBufferAttribute(P, i2);
    const area = e1.subVectors(b, a).cross(e2.subVectors(c, a)).length() / 2;
    if (area < 1e-5) continue;
    tris.push(t);
    total += area;
    cdf.push(total);
    center.addScaledVector(a.add(b).add(c).multiplyScalar(1 / 3), area);
    minY = Math.min(minY, P.getY(i0), P.getY(i1), P.getY(i2));
    maxY = Math.max(maxY, P.getY(i0), P.getY(i1), P.getY(i2));
  }
  if (!tris.length) return src;
  center.multiplyScalar(1 / total);
  const heightOf = (y: number): number => (y - minY) / Math.max(1e-3, maxY - minY);

  // Original vertices: crown darkened into the inner volume (more so low down), nothing sways
  const n0 = P.count;
  const pos: number[] = Array.from(P.array as ArrayLike<number>);
  const nor: number[] = Array.from(N.array as ArrayLike<number>);
  const col: number[] = [];
  const sway: number[] = new Array(n0).fill(0);
  for (let i = 0; i < n0; i++) {
    const green = isGreen(C.getX(i), C.getY(i), C.getZ(i));
    const k = green ? opts.innerShade * (0.8 + 0.2 * heightOf(P.getY(i))) : 1;
    col.push(C.getX(i) * k, C.getY(i) * k, C.getZ(i) * k);
  }
  const idx: number[] = index ? Array.from(index.array as ArrayLike<number>) : Array.from({ length: n0 }, (_, i) => i);

  // Even spread: a point is kept only if no kept scale is closer than `spacing` (grid lookup)
  const cell = opts.spacing;
  const grid = new Map<string, THREE.Vector3[]>();
  const cellKey = (x: number, y: number, z: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const tooClose = (q: THREE.Vector3): boolean => {
    const cx = Math.floor(q.x / cell);
    const cy = Math.floor(q.y / cell);
    const cz = Math.floor(q.z / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (list && list.some((o) => o.distanceToSquared(q) < cell * cell)) return true;
        }
    return false;
  };

  const rand = rng(opts.seed);
  const p = new THREE.Vector3();
  const fn = new THREE.Vector3();
  const down = new THREE.Vector3();
  const across = new THREE.Vector3();
  const lit = new THREE.Vector3();
  const v = new THREE.Vector3();
  const DOWN = new THREE.Vector3(0, -1, 0);

  let placed = 0;
  for (let attempt = 0; attempt < opts.count * 25 && placed < opts.count; attempt++) {
    // Area-weighted face, uniform point on it
    const r = rand() * total;
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const t = tris[lo];
    const i0 = vi(t, 0);
    a.fromBufferAttribute(P, i0);
    b.fromBufferAttribute(P, vi(t, 1));
    c.fromBufferAttribute(P, vi(t, 2));
    let u = rand();
    let w = rand();
    if (u + w > 1) {
      u = 1 - u;
      w = 1 - w;
    }
    p.copy(a).addScaledVector(e1.subVectors(b, a), u).addScaledVector(e2.subVectors(c, a), w);
    if (tooClose(p)) continue;
    const key = cellKey(p.x, p.y, p.z);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(p.clone());
    placed++;

    // Surface frame: outward normal (smoothed towards the crown's roundness), "down the slope",
    // and across. On the underside, where there is no slope, hang outwards instead.
    fn.subVectors(b, a).cross(e2.subVectors(c, a)).normalize();
    const radial = v.subVectors(p, center).normalize();
    if (fn.dot(radial) < 0) fn.negate();
    fn.lerp(radial, 0.35).normalize();
    down.copy(DOWN).addScaledVector(fn, -DOWN.dot(fn));
    if (down.lengthSq() < 0.04) down.set(radial.x, 0, radial.z);
    // A slight random twist so the rows aren't ruler-straight
    down.addScaledVector(across.crossVectors(fn, down).normalize(), (rand() - 0.5) * 0.5).normalize();
    across.crossVectors(fn, down).normalize();

    // Lighting: mostly the round crown (or the cone around the trunk), a bit of the leaf's own tilt
    if (opts.lightFrom === 'axis') {
      lit.set(p.x - center.x, 0, p.z - center.z).normalize().multiplyScalar(0.6).addScaledVector(fn, 0.4).normalize();
    } else {
      lit.copy(radial).multiplyScalar(0.75).addScaledVector(fn, 0.25).normalize();
    }
    // Off the crown, so the wind never pushes the leaf into it
    p.addScaledVector(fn, opts.offset);

    const needle = opts.shape === 'needle';
    const scallop = opts.shape === 'scallop';
    const shape = needle ? NEEDLE : scallop ? SCALLOP : SHAPE;
    const leafTris = needle ? NEEDLE_TRIS : scallop ? SCALLOP_TRIS : FAN;
    const len = opts.size * (0.85 + rand() * 0.3);
    const wid = needle || scallop ? (opts.width ?? 0.07) * (0.85 + rand() * 0.3) : len * (0.85 + rand() * 0.2);
    const cr = C.getX(i0);
    const cg = C.getY(i0);
    const cb = C.getZ(i0);
    // Lighter towards the top of the crown (sky light), varied per scale
    const shade = (0.88 + rand() * 0.16) * (0.78 + 0.32 * heightOf(p.y));

    const base = pos.length / 3;
    for (const s of shape) {
      v.copy(p)
        .addScaledVector(across, s.x * wid)
        .addScaledVector(down, s.y * len)
        .addScaledVector(fn, s.lift * len);
      pos.push(v.x, v.y, v.z);
      nor.push(lit.x, lit.y, lit.z);
      const k = shade * s.tone;
      col.push(cr * k, cg * k, cb * k);
      sway.push(s.sway);
    }
    // Wind the leaf so its front faces outwards (the double-sided material darkens back faces);
    // the first triangle (vertices 0, 1, 2 in both shapes) sets the winding for the rest
    e1.set(pos[(base + 1) * 3] - pos[base * 3], pos[(base + 1) * 3 + 1] - pos[base * 3 + 1], pos[(base + 1) * 3 + 2] - pos[base * 3 + 2]);
    e2.set(pos[(base + 2) * 3] - pos[base * 3], pos[(base + 2) * 3 + 1] - pos[base * 3 + 1], pos[(base + 2) * 3 + 2] - pos[base * 3 + 2]);
    const outward = e1.cross(e2).dot(fn) >= 0;
    for (let k = 0; k < leafTris.length; k += 3) {
      if (outward) idx.push(base + leafTris[k], base + leafTris[k + 1], base + leafTris[k + 2]);
      else idx.push(base + leafTris[k], base + leafTris[k + 2], base + leafTris[k + 1]);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('sway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx);
  g.addGroup(0, idx.length, 0);
  g.computeBoundingSphere();
  return g;
}
