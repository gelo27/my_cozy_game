import * as THREE from 'three';

/**
 * A fir drawn from its trunk and a stack of scalloped "umbrellas" (the look of the hand-made
 * example pine): each row is a few big paws whose apex sits on the trunk, fanning out and down
 * past the crown's outline like the panels of an umbrella, with a lobed rim.
 *
 * - The crown mesh is only a guide: its height and widest radius (triangles cut by horizontal
 *   planes, then rays from the axis) set the cone the rows fill, short paws at the top growing
 *   evenly to the widest at the bottom; the crown triangles themselves are dropped.
 * - Rows step down from the very top; every other row is turned by half a paw, so its paws cover
 *   the notches between the paws of the row above. Near the top the paws are short, which closes
 *   the tip.
 * - A paw is darkest at the trunk and lightest at its rim, and only its rim
 *   moves in the wind.
 */
export interface RingScallopOptions {
  /** Paws around the trunk in each row. */
  pawsPerRow: number;
  /** Paw width as a fraction of its reach (6 paws need about 0.6 to close the ring). */
  width: number;
  /** How far the rim hangs below the paw's root, as a multiple of the default droop. */
  droop: number;
  /** How far the bottom row reaches past the crown's widest radius (m). */
  overhang: number;
  /** Vertical step between rows (m). */
  rowStep: number;
  /** Darkening of the paws at the trunk (inner volume). */
  innerShade: number;
  /** Keep the original crown mesh under the paws (darkened by innerShade). */
  keepCrown: boolean;
  seed: number;
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
 * Paw outline measured from the example pine: u = out along the paw / its reach, v = down / its
 * droop, w = across / its reach (at width 0.6), tone = brightness. Vertex 0 is the apex at the
 * trunk; the rest run round the lobed rim.
 */
const PAW: { u: number; v: number; w: number; tone: number }[] = [
  { u: 0, v: 0, w: 0, tone: 0.75 },
  { u: 0.62, v: 0.92, w: 0.257, tone: 0.62 },
  { u: 0.867, v: 0.918, w: 0.298, tone: 0.78 },
  { u: 1.003, v: 1.012, w: 0.186, tone: 0.95 },
  { u: 0.973, v: 0.971, w: 0.087, tone: 0.89 },
  { u: 1.048, v: 1.034, w: 0, tone: 1 },
  { u: 0.973, v: 0.971, w: -0.087, tone: 0.89 },
  { u: 1.003, v: 1.012, w: -0.186, tone: 0.95 },
  { u: 0.867, v: 0.918, w: -0.298, tone: 0.78 },
  { u: 0.62, v: 0.92, w: -0.257, tone: 0.62 },
];
const PAW_TRIS = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 6, 0, 6, 7, 0, 7, 8, 0, 8, 9];
/** Directions sampled around the trunk when measuring the crown. */
const PROBES = 48;
/** Height step (m) when measuring the crown's widest radius. */
const PROFILE_STEP = 0.1;
/** Reach (m) of the paws in the top row. */
const TOP_REACH = 0.55;

export function addRingScallops(src: THREE.BufferGeometry, opts: RingScallopOptions): THREE.BufferGeometry {
  const P = src.getAttribute('position');
  const C = src.getAttribute('color');
  const N = src.getAttribute('normal');
  const index = src.index;
  const triCount = index ? index.count / 3 : P.count / 3;
  const vi = (t: number, k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k);
  const green = (i: number) => isGreen(C.getX(i), C.getY(i), C.getZ(i));

  // Crown triangles, its height range, axis and average colour
  const crown: number[] = [];
  let y0 = Infinity;
  let y1 = -Infinity;
  let cx = 0;
  let cz = 0;
  let cn = 0;
  const col = new THREE.Color(0, 0, 0);
  for (let t = 0; t < triCount; t++) {
    const a = vi(t, 0), b = vi(t, 1), c = vi(t, 2);
    if (!(green(a) && green(b) && green(c))) continue;
    crown.push(a, b, c);
    for (const i of [a, b, c]) {
      y0 = Math.min(y0, P.getY(i));
      y1 = Math.max(y1, P.getY(i));
      cx += P.getX(i);
      cz += P.getZ(i);
      col.r += C.getX(i);
      col.g += C.getY(i);
      col.b += C.getZ(i);
      cn++;
    }
  }
  if (!cn) return src;
  cx /= cn;
  cz /= cn;
  col.multiplyScalar(1 / cn);

  /** Widest crown radius at height y (0 where the crown isn't). */
  const segX: number[] = [];
  const segZ: number[] = [];
  const radiusAt = (y: number): number => {
    segX.length = segZ.length = 0;
    for (let k = 0; k < crown.length; k += 3) {
      // Edge crossings of the plane: a triangle cut by it gives one segment
      let n = 0;
      for (let e = 0; e < 3; e++) {
        const i = crown[k + e];
        const j = crown[k + ((e + 1) % 3)];
        const ya = P.getY(i) - y;
        const yb = P.getY(j) - y;
        if ((ya < 0) === (yb < 0)) continue;
        const f = ya / (ya - yb);
        segX.push(P.getX(i) + (P.getX(j) - P.getX(i)) * f - cx);
        segZ.push(P.getZ(i) + (P.getZ(j) - P.getZ(i)) * f - cz);
        n++;
      }
      if (n === 1) segX.pop(), segZ.pop();
    }
    let max = 0;
    for (let p = 0; p < PROBES; p++) {
      const a = (p / PROBES) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      for (let s = 0; s < segX.length; s += 2) {
        // Ray from the axis against the segment
        const ax = segX[s], az = segZ[s], bx = segX[s + 1], bz = segZ[s + 1];
        const ex = bx - ax, ez = bz - az;
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = (ax * ez - az * ex) / den;
        const u = (ax * dz - az * dx) / den;
        if (t > 0 && u >= 0 && u <= 1) max = Math.max(max, t);
      }
    }
    return max;
  };

  // The crown's widest radius; the paws' reach grows evenly from the top down to it (a clean
  // cone like the example, rather than following every tier of the model)
  let rMax = 0;
  for (let y = y0; y <= y1; y += PROFILE_STEP) rMax = Math.max(rMax, radiusAt(y));
  const lowestRoot = y0 + 1.25;
  const reachAt = (y: number): number =>
    TOP_REACH + (rMax + opts.overhang - TOP_REACH) * THREE.MathUtils.clamp((y1 - y) / Math.max(0.5, y1 - lowestRoot), 0, 1);

  // Trunk (and the crown, when kept) from the source
  const pos: number[] = [];
  const nor: number[] = [];
  const cols: number[] = [];
  const sway: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < P.count; i++) {
    pos.push(P.getX(i), P.getY(i), P.getZ(i));
    nor.push(N.getX(i), N.getY(i), N.getZ(i));
    const k = green(i) ? opts.innerShade : 1;
    cols.push(C.getX(i) * k, C.getY(i) * k, C.getZ(i) * k);
    sway.push(0);
  }
  for (let t = 0; t < triCount; t++) {
    const a = vi(t, 0), b = vi(t, 1), c = vi(t, 2);
    if (!opts.keepCrown && green(a) && green(b) && green(c)) continue;
    idx.push(a, b, c);
  }

  const rand = rng(opts.seed);
  const out = new THREE.Vector3();
  const lit = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const widthK = opts.width / 0.6;
  /** One paw: apex on the trunk at height `y`, pointing at angle `a`. */
  const addPaw = (a: number, y: number, reach: number, drop: number, shade: number) => {
    const rx = Math.cos(a), rz = Math.sin(a);
    // Across the paw (horizontal) and the outward-up normal of its slope
    const ax = -rz, az = rx;
    out.set(rx * drop, reach, rz * drop).normalize();
    lit.set(rx, 0.35 + ((y - y0) / Math.max(1e-3, y1 - y0)) * 0.5, rz).normalize();
    const base = pos.length / 3;
    const r0 = 0.04;
    for (const s of PAW) {
      const r = r0 + s.u * reach;
      const w = s.w * reach * widthK;
      pos.push(cx + rx * r + ax * w, y - s.v * drop, cz + rz * r + az * w);
      nor.push(lit.x, lit.y, lit.z);
      const k = shade * s.tone * (s.u === 0 ? opts.innerShade : 1);
      cols.push(col.r * k, col.g * k, col.b * k);
      sway.push(Math.pow(Math.min(1, s.u), 1.5));
    }
    // Front faces up and out (the double-sided material darkens back faces)
    e1.set(pos[(base + 1) * 3] - pos[base * 3], pos[(base + 1) * 3 + 1] - pos[base * 3 + 1], pos[(base + 1) * 3 + 2] - pos[base * 3 + 2]);
    e2.set(pos[(base + 2) * 3] - pos[base * 3], pos[(base + 2) * 3 + 1] - pos[base * 3 + 1], pos[(base + 2) * 3 + 2] - pos[base * 3 + 2]);
    const flip = e1.cross(e2).dot(out) < 0;
    for (let k = 0; k < PAW_TRIS.length; k += 3) {
      if (flip) idx.push(base + PAW_TRIS[k], base + PAW_TRIS[k + 2], base + PAW_TRIS[k + 1]);
      else idx.push(base + PAW_TRIS[k], base + PAW_TRIS[k + 1], base + PAW_TRIS[k + 2]);
    }
  };

  // Rows from the very top down until the rims reach the crown's bottom
  const n = Math.max(3, Math.round(opts.pawsPerRow));
  for (let ri = 0, y = y1 - 0.05; ; ri++, y -= opts.rowStep * (0.94 + rand() * 0.12)) {
    const reach = reachAt(y);
    const drop = (0.75 + 0.25 * reach) * opts.droop;
    if (y - drop < y0 - 0.25 && ri > 0) break;
    const phase = (ri % 2) * 0.5 + (rand() - 0.5) * 0.1;
    for (let k = 0; k < n; k++) {
      const a = ((k + phase) / n) * Math.PI * 2 + (rand() - 0.5) * (0.25 / n) * Math.PI;
      // Even tone over the whole tree, as in the example (the rim-to-trunk gradient does the shading)
      const shade = 0.98 + rand() * 0.1;
      const jitter = 0.95 + rand() * 0.1;
      addPaw(a, y, reach * jitter, drop * jitter, shade);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setAttribute('sway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx);
  g.addGroup(0, idx.length, 0);
  g.computeBoundingSphere();
  return g;
}
