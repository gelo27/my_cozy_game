import * as THREE from 'three';

/**
 * Maple and birch, made from the trees pack's oak instead of shipping new models: the same
 * low-poly trunk and crown, reshaped (thinner trunk, crown narrowed / stretched upwards) and
 * repainted. They share the oak's material, LOD lists and instancing, so each type costs only its
 * own instanced draws: no new shaders, textures or materials.
 */

export interface TreeShape {
  /** Trunk (and its branches) thickness about the trunk axis. */
  trunkXZ: number;
  /** Crown width about the trunk axis. */
  crownXZ: number;
  /** Crown height about its base (> 1 stretches it upwards). */
  crownY: number;
  /** The crown starts this much higher (m): the bare trunk below it grows by as much. */
  crownLift: number;
}

export const MAPLE_SHAPE: TreeShape = { trunkXZ: 0.88, crownXZ: 0.9, crownY: 1.18, crownLift: 0.15 };
export const BIRCH_SHAPE: TreeShape = { trunkXZ: 0.5, crownXZ: 0.66, crownY: 1.1, crownLift: 0.5 };

const isGreen = (C: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number): boolean =>
  C.getY(i) > C.getX(i) && C.getY(i) > C.getZ(i);

/**
 * Crown (leaf) colour of any tree model, as the felling code tells crown from bark: green, or the
 * maple's orange-yellow (red over green with almost no blue; every bark, the oak's, pine's,
 * maple's and birch's, keeps at least ~18% of its red in blue).
 */
export const isCrownColor = (r: number, g: number, b: number): boolean => (g > r && g > b) || (r > g && b < r * 0.08);

/** Lowest crown (green) vertex of a tree geometry, or null without a crown. */
function crownBase(g: THREE.BufferGeometry): number | null {
  const P = g.getAttribute('position');
  const C = g.getAttribute('color');
  let base = Infinity;
  for (let i = 0; i < P.count; i++) if (isGreen(C, i)) base = Math.min(base, P.getY(i));
  return Number.isFinite(base) && base > 0.1 ? base : null;
}

/**
 * Copy of an oak geometry reshaped to `s`. Heights map piecewise (trunk below the crown base
 * stretched by the lift, everything above by the crown's stretch), so trunk and crown stay joined;
 * normals follow the non-uniform scale. The crown stays green here: the leaves are laid on it
 * and the felling code finds it by that, the colours come last (`paintTree`).
 */
export function reshapeOak(src: THREE.BufferGeometry, s: TreeShape): THREE.BufferGeometry {
  const g = src.clone();
  const base = crownBase(g);
  if (base === null) return g;
  const P = g.getAttribute('position') as THREE.BufferAttribute;
  const N = g.getAttribute('normal') as THREE.BufferAttribute;
  const C = g.getAttribute('color');
  const lowK = (base + s.crownLift) / base;
  for (let i = 0; i < P.count; i++) {
    const y = P.getY(i);
    const low = y < base;
    const ky = low ? lowK : s.crownY;
    const kxz = isGreen(C, i) ? s.crownXZ : s.trunkXZ;
    P.setXYZ(i, P.getX(i) * kxz, low ? y * lowK : base + s.crownLift + (y - base) * s.crownY, P.getZ(i) * kxz);
    const nx = N.getX(i) / kxz, ny = N.getY(i) / ky, nz = N.getZ(i) / kxz;
    const l = Math.hypot(nx, ny, nz) || 1;
    N.setXYZ(i, nx / l, ny / l, nz / l);
  }
  P.needsUpdate = true;
  N.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

/** Average brightness of the crown (green) vertices: the oak's own leaf colour as a reference. */
export function crownBrightness(g: THREE.BufferGeometry): number {
  const C = g.getAttribute('color');
  let sum = 0;
  let n = 0;
  for (let i = 0; i < C.count; i++) {
    if (!isGreen(C, i)) continue;
    sum += C.getX(i) + C.getY(i) + C.getZ(i);
    n++;
  }
  return n ? sum / n : 1;
}

export interface TreePaint {
  /** Two leaf colours the crown blends between in soft patches (hex, sRGB). */
  leafA: number;
  leafB: number;
  /** Patch size of the blend (m). */
  patch: number;
  /** Bark colour, or null to keep the oak's. */
  bark: number | null;
}

export const MAPLE_PAINT: TreePaint = { leafA: 0xe8661c, leafB: 0xf2b230, patch: 1.6, bark: 0x5a4030 };
export const BIRCH_PAINT: TreePaint = { leafA: 0xb4d24c, leafB: 0x8fc23e, patch: 1.3, bark: 0xe6e1d4 };

const A = new THREE.Color();
const B = new THREE.Color();
const BARK = new THREE.Color();

/**
 * Repaints a (leafed) tree geometry in place: every crown and leaf vertex keeps its shading (its
 * brightness against the oak crown's `refBrightness`) but takes the blend of the two leaf colours
 * at its spot; bark vertices take the bark colour.
 */
export function paintTree(g: THREE.BufferGeometry, p: TreePaint, refBrightness: number): THREE.BufferGeometry {
  const P = g.getAttribute('position');
  const C = g.getAttribute('color') as THREE.BufferAttribute;
  A.setHex(p.leafA);
  B.setHex(p.leafB);
  if (p.bark !== null) BARK.setHex(p.bark);
  const f = 1 / p.patch;
  // The bark's average brightness: each bark vertex keeps its shading relative to it
  let barkSum = 0;
  let barkN = 0;
  for (let i = 0; i < C.count; i++) {
    if (isGreen(C, i)) continue;
    barkSum += C.getX(i) + C.getY(i) + C.getZ(i);
    barkN++;
  }
  const barkRef = barkN ? barkSum / barkN : 1;
  for (let i = 0; i < C.count; i++) {
    const r = C.getX(i), gr = C.getY(i), b = C.getZ(i);
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    if (gr > r && gr > b) {
      const k = (r + gr + b) / refBrightness;
      // Smooth, seamless patches (no per-leaf seams): a product of slow waves over the crown
      const t = 0.5 + 0.5 * Math.sin(x * f * 2.1 + Math.sin(z * f * 1.7) * 1.3) * Math.cos(z * f * 1.9 - y * f * 1.1);
      C.setXYZ(i, (A.r + (B.r - A.r) * t) * k, (A.g + (B.g - A.g) * t) * k, (A.b + (B.b - A.b) * t) * k);
    } else if (p.bark !== null) {
      // Bark keeps the model's own shading relative to its brown
      const k = 0.55 + 0.45 * Math.min(1.6, (r + gr + b) / barkRef);
      C.setXYZ(i, BARK.r * k, BARK.g * k, BARK.b * k);
    }
  }
  C.needsUpdate = true;
  return g;
}
