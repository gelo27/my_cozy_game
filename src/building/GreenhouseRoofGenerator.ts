import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DEFAULT_ROOF_CONFIG, ProceduralRoofConfig } from './ProceduralRoofSystem';

/**
 * Real glasshouse roof mesh, built from the same ProceduralRoofConfig as the shingle roofs
 * (so resizing gizmos, snapping, saving and the slope collider all keep working), but shaped
 * like a Victorian greenhouse instead of a shingled roof:
 *
 * - gutter beams along both eaves, a ridge beam with finials at both ends
 * - glazing bars (rafters) every ~0.5m from eave to ridge, purlin rails across the slopes
 * - gable ends: rake beams, bottom tie, vertical mullions and glazed triangles
 * - lean-to ("shed") variant: low gutter, high wall-plate header, glazed side triangles and rear
 *
 * Geometry groups: 0 = glass, 1 = wooden frame.
 */

const GUTTER_W = 0.12;
const GUTTER_H = 0.1;
const RIDGE_W = 0.1;
const RIDGE_H = 0.14;
const RAFTER_W = 0.045;
const RAFTER_H = 0.07;
const RAKE_W = 0.08;
const RAKE_H = 0.09;
const MULLION_W = 0.045;
const GLASS_T = 0.012;
const BAY = 0.5; // glazing bar spacing (m)
const EAVE_OVERHANG = 0.06;

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();

class RoofBuilder {
  readonly glass: THREE.BufferGeometry[] = [];
  readonly frame: THREE.BufferGeometry[] = [];

  /** Box of size (sx, sy, sz) centred at `c`, with local axes (ax, ay, az) (orthonormal). */
  box(
    target: THREE.BufferGeometry[],
    c: THREE.Vector3,
    ax: THREE.Vector3,
    ay: THREE.Vector3,
    az: THREE.Vector3,
    sx: number,
    sy: number,
    sz: number
  ): void {
    if (sx <= 1e-3 || sy <= 1e-3 || sz <= 1e-3) return;
    const g = new THREE.BoxGeometry(sx, sy, sz);
    _m.makeBasis(ax, ay, az).setPosition(c);
    g.applyMatrix4(_m);
    target.push(g);
  }

  /**
   * Beam from a to b with cross-section w (across) x h (along `up`, made perpendicular to the beam).
   * `inset` shortens both ends.
   */
  beam(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, up = new THREE.Vector3(0, 1, 0), inset = 0): void {
    _z.subVectors(b, a);
    const len = _z.length() - inset * 2;
    if (len <= 1e-3) return;
    _z.normalize();
    _y.copy(up).addScaledVector(_z, -up.dot(_z));
    if (_y.lengthSq() < 1e-6) _y.set(1, 0, 0).addScaledVector(_z, -_z.x);
    _y.normalize();
    _x.crossVectors(_y, _z).normalize();
    const c = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    this.box(this.frame, c, _x.clone(), _y.clone(), _z.clone(), w, h, len);
  }

  /** Flat glass quad a-b-c-d (planar), as a thin indexed slab-less surface (double-sided material). */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void {
    this.poly([a, b, c, d]);
  }

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
    this.poly([a, b, c]);
  }

  private poly(pts: THREE.Vector3[]): void {
    const n = new THREE.Vector3().subVectors(pts[1], pts[0]).cross(new THREE.Vector3().subVectors(pts[2], pts[0])).normalize();
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    for (const p of pts) {
      pos.push(p.x, p.y, p.z);
      nor.push(n.x, n.y, n.z);
      uv.push(p.x + p.z, p.y);
    }
    const idx: number[] = [];
    for (let i = 1; i < pts.length - 1; i++) idx.push(0, i, i + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.glass.push(g);
  }

  /** Decorative ridge finial: a short post with a small ball on top. */
  finial(at: THREE.Vector3): void {
    const post = new THREE.CylinderGeometry(0.025, 0.035, 0.22, 8);
    post.translate(at.x, at.y + 0.11, at.z);
    const ball = new THREE.SphereGeometry(0.05, 10, 8);
    ball.translate(at.x, at.y + 0.25, at.z);
    // Sphere/cylinder are indexed with position/normal/uv like BoxGeometry, so they merge cleanly
    this.frame.push(post, ball);
  }

  build(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const glass = this.glass.length ? mergeGeometries(this.glass) : null;
    const frame = this.frame.length ? mergeGeometries(this.frame) : null;
    this.glass.forEach((g) => g.dispose());
    this.frame.forEach((g) => g.dispose());
    // Keep group indices stable (0 glass, 1 frame) even if one side is empty
    parts.push(glass ?? emptyGeometry(), frame ?? emptyGeometry());
    const merged = mergeGeometries(parts, true)!;
    parts.forEach((g) => g.dispose());
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }
}

function emptyGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
  g.setIndex([0, 1, 2]);
  return g;
}

/** Evenly spaced stations strictly between a and b, about `step` apart. */
function stations(a: number, b: number, step: number): number[] {
  const n = Math.max(1, Math.round((b - a) / step));
  const out: number[] = [];
  for (let i = 1; i < n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function buildGable(b: RoofBuilder, cfg: ProceduralRoofConfig): void {
  const { minX, maxX, minZ, maxZ, height: h } = cfg;
  const midX = (minX + maxX) / 2;
  const halfSpan = (maxX - minX) / 2;
  const z0 = minZ - EAVE_OVERHANG;
  const z1 = maxZ + EAVE_OVERHANG;
  const glassLift = RAFTER_H / 2; // glass rests on top of the glazing bars

  // Slope normals (outward) for the left (-X) and right (+X) planes
  const slopeLen = Math.hypot(halfSpan, h);
  const nL = V(-h / slopeLen, halfSpan / slopeLen, 0);
  const nR = V(h / slopeLen, halfSpan / slopeLen, 0);

  // --- Gutters along both eaves, ridge beam on top
  b.beam(V(minX, -GUTTER_H / 2, z0), V(minX, -GUTTER_H / 2, z1), GUTTER_W, GUTTER_H);
  b.beam(V(maxX, -GUTTER_H / 2, z0), V(maxX, -GUTTER_H / 2, z1), GUTTER_W, GUTTER_H);
  b.beam(V(midX, h, z0), V(midX, h, z1), RIDGE_W, RIDGE_H);
  b.finial(V(midX, h + RIDGE_H / 2, z0));
  b.finial(V(midX, h + RIDGE_H / 2, z1));

  // --- Glazing bars (rafters) eave -> ridge on both slopes, including the two end rafters
  const zs = [minZ, ...stations(minZ, maxZ, BAY), maxZ];
  for (const z of zs) {
    const end = z === minZ || z === maxZ;
    const w = end ? RAKE_W : RAFTER_W;
    const hh = end ? RAKE_H : RAFTER_H;
    b.beam(V(minX, 0, z), V(midX, h, z), w, hh, nL, 0);
    b.beam(V(maxX, 0, z), V(midX, h, z), w, hh, nR, 0);
  }

  // --- Purlins: one rail across each slope at mid height
  for (const [sx, n] of [[minX, nL], [maxX, nR]] as const) {
    const px = sx + (midX - sx) * 0.5;
    b.beam(V(px, h * 0.5, z0), V(px, h * 0.5, z1), RAFTER_H * 0.9, RAFTER_W, n);
  }

  // --- Slope glass (sits on the bars, from gutter edge to ridge)
  const lift = (n: THREE.Vector3, p: THREE.Vector3) => p.addScaledVector(n, glassLift);
  b.quad(lift(nL, V(minX, 0, z0)), lift(nL, V(minX, 0, z1)), lift(nL, V(midX, h, z1)), lift(nL, V(midX, h, z0)));
  b.quad(lift(nR, V(maxX, 0, z1)), lift(nR, V(maxX, 0, z0)), lift(nR, V(midX, h, z0)), lift(nR, V(midX, h, z1)));

  // --- Gable ends: bottom tie, vertical mullions, glazed triangle
  for (const z of [minZ, maxZ]) {
    b.beam(V(minX, 0.03, z), V(maxX, 0.03, z), RAKE_W, 0.06, V(0, 1, 0));
    for (const x of stations(minX, maxX, BAY)) {
      const top = h * (1 - Math.abs(x - midX) / halfSpan);
      if (top < 0.08) continue;
      b.beam(V(x, 0.06, z), V(x, top, z), MULLION_W, MULLION_W, V(0, 0, 1));
    }
    b.tri(V(minX, 0.06, z), V(maxX, 0.06, z), V(midX, h, z));
  }
}

function buildShed(b: RoofBuilder, cfg: ProceduralRoofConfig): void {
  // Lean-to: low edge at minZ (y=0), high edge at maxZ (y=height), slope runs along Z
  const { minX, maxX, minZ, maxZ, height: h } = cfg;
  const run = maxZ - minZ;
  const slopeLen = Math.hypot(run, h);
  const n = V(0, run / slopeLen, -h / slopeLen);
  const x0 = minX - EAVE_OVERHANG;
  const x1 = maxX + EAVE_OVERHANG;
  const glassLift = RAFTER_H / 2;

  // Gutter on the low edge, wall-plate header on the high edge
  b.beam(V(x0, -GUTTER_H / 2, minZ), V(x1, -GUTTER_H / 2, minZ), GUTTER_W, GUTTER_H);
  b.beam(V(x0, h, maxZ), V(x1, h, maxZ), RIDGE_H, RIDGE_W, V(0, 0, 1));

  // Rafters every ~0.5m across X, end rafters heavier
  const xs = [minX, ...stations(minX, maxX, BAY), maxX];
  for (const x of xs) {
    const end = x === minX || x === maxX;
    b.beam(V(x, 0, minZ), V(x, h, maxZ), end ? RAKE_W : RAFTER_W, end ? RAKE_H : RAFTER_H, n);
  }
  // Purlin at mid slope
  b.beam(V(x0, h * 0.5, minZ + run * 0.5), V(x1, h * 0.5, minZ + run * 0.5), RAFTER_H * 0.9, RAFTER_W, n);

  // Slope glass
  const lift = (p: THREE.Vector3) => p.addScaledVector(n, glassLift);
  b.quad(lift(V(x0, 0, minZ)), lift(V(x0, h, maxZ)), lift(V(x1, h, maxZ)), lift(V(x1, 0, minZ)));

  // Side triangles (x = minX / maxX): bottom tie, mullions, glass
  for (const x of [minX, maxX]) {
    b.beam(V(x, 0.03, minZ), V(x, 0.03, maxZ), RAKE_W, 0.06);
    for (const z of stations(minZ, maxZ, BAY)) {
      const top = (h * (z - minZ)) / run;
      if (top < 0.08) continue;
      b.beam(V(x, 0.06, z), V(x, top, z), MULLION_W, MULLION_W, V(1, 0, 0));
    }
    b.tri(V(x, 0.06, minZ), V(x, 0.06, maxZ), V(x, h, maxZ));
  }

  // Rear (high) wall between the wall plate and the header: glazed with mullions
  if (h > 0.1) {
    b.beam(V(minX, 0.03, maxZ), V(maxX, 0.03, maxZ), RAKE_W, 0.06);
    for (const x of stations(minX, maxX, BAY)) {
      b.beam(V(x, 0.06, maxZ), V(x, h, maxZ), MULLION_W, MULLION_W, V(0, 0, 1));
    }
    b.quad(V(minX, 0.06, maxZ), V(maxX, 0.06, maxZ), V(maxX, h, maxZ), V(minX, h, maxZ));
  }
}

export class GreenhouseRoofGenerator {
  /** Glass (group 0) + frame (group 1) geometry for a glass roof config ('gable' or 'shed'). */
  public static createGeometry(config: Partial<ProceduralRoofConfig>): THREE.BufferGeometry {
    const cfg: ProceduralRoofConfig = { ...DEFAULT_ROOF_CONFIG, ...config };
    const b = new RoofBuilder();
    if (cfg.roofType === 'shed') buildShed(b, cfg);
    else buildGable(b, cfg);
    return b.build();
  }
}
