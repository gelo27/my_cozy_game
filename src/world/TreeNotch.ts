import * as THREE from 'three';

/** Cut band on the trunk (m above the tree base): bottom rim, apex of the notch, top rim. */
const BOT = 0.7;
const APEX = 0.9;
/** Height of the break where a felled tree's top parts from its stump. */
export const CUT_APEX = APEX;
const TOP = 1.1;
/** Only brown faces closer to the axis than this belong to the trunk (the oak's is ~0.8 m thick at the base). */
const TRUNK_R = 1.1;
/** Half-width of the notch on stage 1, around the strike direction. */
const WEDGE_HALF_ANGLE = (50 * Math.PI) / 180;
const FRESH_WOOD = new THREE.Color(0xf5c87a);

/** Vertex while cutting: position, normal, colour. */
type V = [number, number, number, number, number, number, number, number, number];
interface RingPt {
  a: number;
  v: V;
}

const isGreen = (v: V): boolean => v[7] > v[6] && v[7] > v[8];
const lerpV = (a: V, b: V, t: number): V => a.map((x, i) => x + (b[i] - x) * t) as V;

/**
 * The tree model with the axe cut carved into its own trunk. Trunk faces crossing the cut band are
 * clipped at its rims, and the band is rebuilt from the trunk's real cross-section there (same
 * outline, bark colour and normals), notched for the stage:
 * 1 = wedge on the strike side, 2 = pinched hourglass waist, 3 = deep "X" ready to topple.
 * `phi` is the strike side in the tree's local frame (angle of (x, z) = (sin, cos)).
 */
export function buildNotchedTree(source: THREE.BufferGeometry, stage: number, phi: number): THREE.BufferGeometry {
  const src = source.index ? source.toNonIndexed() : source;
  const P = src.getAttribute('position');
  const Nn = src.getAttribute('normal');
  const C = src.getAttribute('color');
  const out: number[] = [];
  const ringBot: RingPt[] = [];
  const ringTop: RingPt[] = [];
  const vert = (i: number): V => [P.getX(i), P.getY(i), P.getZ(i), Nn.getX(i), Nn.getY(i), Nn.getZ(i), C.getX(i), C.getY(i), C.getZ(i)];
  const emitPoly = (poly: V[]): void => {
    for (let k = 1; k + 1 < poly.length; k++) out.push(...poly[0], ...poly[k], ...poly[k + 1]);
  };

  for (let i = 0; i < P.count; i += 3) {
    const tri = [vert(i), vert(i + 1), vert(i + 2)];
    const minY = Math.min(tri[0][1], tri[1][1], tri[2][1]);
    const maxY = Math.max(tri[0][1], tri[1][1], tri[2][1]);
    const trunk =
      minY < TOP && maxY > BOT && tri.every((v) => !isGreen(v) && Math.hypot(v[0], v[2]) < TRUNK_R);
    if (!trunk) {
      emitPoly(tri);
      continue;
    }
    collectRing(tri, BOT, ringBot);
    collectRing(tri, TOP, ringTop);
    emitPoly(clip(tri, BOT, true));
    emitPoly(clip(tri, TOP, false));
  }
  if (src !== source) src.dispose();

  if (ringBot.length >= 3 && ringTop.length >= 3) buildBand(out, ringBot, ringTop, stage, phi);

  return toGeometry(out);
}

/**
 * Splits the (stage 3) notched tree at the apex of the cut: `stump` is everything below it and
 * stays on the ground, `top` falls. Faces crossing the break are clipped, so both halves meet
 * exactly at the "X".
 */
export function splitAtCut(geo: THREE.BufferGeometry): { stump: THREE.BufferGeometry; top: THREE.BufferGeometry } {
  const P = geo.getAttribute('position');
  const Nn = geo.getAttribute('normal');
  const C = geo.getAttribute('color');
  const below: number[] = [];
  const above: number[] = [];
  const vert = (i: number): V => [P.getX(i), P.getY(i), P.getZ(i), Nn.getX(i), Nn.getY(i), Nn.getZ(i), C.getX(i), C.getY(i), C.getZ(i)];
  const emit = (out: number[], poly: V[]): void => {
    for (let k = 1; k + 1 < poly.length; k++) out.push(...poly[0], ...poly[k], ...poly[k + 1]);
  };
  for (let i = 0; i + 2 < P.count; i += 3) {
    const tri = [vert(i), vert(i + 1), vert(i + 2)];
    const minY = Math.min(tri[0][1], tri[1][1], tri[2][1]);
    const maxY = Math.max(tri[0][1], tri[1][1], tri[2][1]);
    if (maxY <= APEX && minY >= APEX - 1e-5) {
      // Flat in the break (the hinge cap): both halves need it
      emit(below, tri);
      emit(above, tri);
    } else if (maxY <= APEX) emit(below, tri);
    else if (minY >= APEX) emit(above, tri);
    else {
      emit(below, clip(tri, APEX, true));
      emit(above, clip(tri, APEX, false));
    }
  }
  return { stump: toGeometry(below), top: toGeometry(above) };
}

function toGeometry(out: number[]): THREE.BufferGeometry {
  const n = out.length / 9;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos.set(out.slice(i * 9, i * 9 + 3), i * 3);
    nor.set(out.slice(i * 9 + 3, i * 9 + 6), i * 3);
    col.set(out.slice(i * 9 + 6, i * 9 + 9), i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/** Points where the triangle's edges cross the plane y = h. */
function collectRing(tri: V[], h: number, ring: RingPt[]): void {
  for (let k = 0; k < 3; k++) {
    const a = tri[k];
    const b = tri[(k + 1) % 3];
    if ((a[1] < h) === (b[1] < h)) continue;
    const v = lerpV(a, b, (h - a[1]) / (b[1] - a[1]));
    ring.push({ a: 0, v });
  }
}

/** Sutherland-Hodgman: the part of the triangle below (keepBelow) or above the plane y = h. */
function clip(poly: V[], h: number, keepBelow: boolean): V[] {
  const inside = (v: V): boolean => (keepBelow ? v[1] <= h : v[1] >= h);
  const res: V[] = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    if (inside(a)) res.push(a);
    if (inside(a) !== inside(b)) res.push(lerpV(a, b, (h - a[1]) / (b[1] - a[1])));
  }
  return res;
}

const TAU = Math.PI * 2;
const wrap = (a: number): number => ((a % TAU) + TAU) % TAU;

/** Sorts a ring's points by angle around the axis and drops duplicates (shared edges). */
function sortRing(ring: RingPt[], cx: number, cz: number): RingPt[] {
  for (const p of ring) p.a = wrap(Math.atan2(p.v[0] - cx, p.v[2] - cz));
  ring.sort((x, y) => x.a - y.a);
  const res: RingPt[] = [];
  for (const p of ring) {
    const last = res[res.length - 1];
    if (last && Math.abs(last.v[0] - p.v[0]) < 1e-4 && Math.abs(last.v[2] - p.v[2]) < 1e-4) continue;
    res.push(p);
  }
  return res;
}

/** The ring's outline where the ray from the axis at angle `a` crosses it (normal and colour interpolated). */
function sample(ring: RingPt[], a: number, cx: number, cz: number): V {
  const dx = Math.sin(a);
  const dz = Math.cos(a);
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k];
    const q = ring[(k + 1) % ring.length];
    const span = wrap(q.a - p.a) || TAU;
    if (wrap(a - p.a) > span + 1e-6) continue;
    const ex = q.v[0] - p.v[0];
    const ez = q.v[2] - p.v[2];
    const den = ex * dz - ez * dx;
    const px = p.v[0] - cx;
    const pz = p.v[2] - cz;
    const s = Math.abs(den) < 1e-9 ? 0 : THREE.MathUtils.clamp(-(px * dz - pz * dx) / den, 0, 1);
    return lerpV(p.v, q.v, s);
  }
  return ring[0].v;
}

/** Rebuilds the band between the two rims for the given stage. */
function buildBand(out: number[], botRaw: RingPt[], topRaw: RingPt[], stage: number, phi: number): void {
  let cx = 0;
  let cz = 0;
  for (const p of [...botRaw, ...topRaw]) {
    cx += p.v[0];
    cz += p.v[2];
  }
  cx /= botRaw.length + topRaw.length;
  cz /= botRaw.length + topRaw.length;
  const bot = sortRing(botRaw, cx, cz);
  const top = sortRing(topRaw, cx, cz);

  // Every outline corner of both rims, plus an even fan around the strike side for the notch
  const angles = [...bot.map((p) => p.a), ...top.map((p) => p.a)];
  for (let k = 0; k < 32; k++) angles.push(wrap(phi + (k / 32) * TAU));
  angles.sort((x, y) => x - y);
  const as = angles.filter((a, i) => i === 0 || a - angles[i - 1] > 1e-3);
  if (TAU - as[as.length - 1] + as[0] < 1e-3) as.pop();

  const rows = as.map((a) => {
    const b = sample(bot, a, cx, cz);
    const t = sample(top, a, cx, cz);
    const r = (Math.hypot(b[0] - cx, b[2] - cz) + Math.hypot(t[0] - cx, t[2] - cz)) / 2;
    return { a, b, t, r };
  });
  const wood = (a: number, r: number, y: number): V => [cx + Math.sin(a) * r, y, cz + Math.cos(a) * r, 0, 1, 0, FRESH_WOOD.r, FRESH_WOOD.g, FRESH_WOOD.b];
  const depth = (a: number): number => {
    const d = Math.abs(Math.atan2(Math.sin(a - phi), Math.cos(a - phi)));
    return d >= WEDGE_HALF_ANGLE ? 0 : Math.cos((d / WEDGE_HALF_ANGLE) * (Math.PI / 2));
  };

  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    const q = rows[(i + 1) % rows.length];
    const mid = p.a + wrap(q.a - p.a) / 2;
    if (stage <= 0) {
      quad(out, p.b, q.b, q.t, p.t, mid, false);
    } else if (stage === 1) {
      const dp = depth(p.a);
      const dq = depth(q.a);
      if (dp === 0 && dq === 0) {
        quad(out, p.b, q.b, q.t, p.t, mid, false);
        continue;
      }
      // ~60% of the radius deep at the strike side, as on the forest's trees
      const ap = wood(p.a, p.r * (1 - 0.62 * dp), APEX);
      const aq = wood(q.a, q.r * (1 - 0.62 * dq), APEX);
      quad(out, asWood(p.b), asWood(q.b), aq, ap, mid, true);
      quad(out, ap, aq, asWood(q.t), asWood(p.t), mid, true);
    } else if (stage === 2) {
      const wpB = wood(p.a, p.r * 0.42, APEX - 0.04);
      const wqB = wood(q.a, q.r * 0.42, APEX - 0.04);
      const wpT = wood(p.a, p.r * 0.42, APEX + 0.04);
      const wqT = wood(q.a, q.r * 0.42, APEX + 0.04);
      quad(out, asWood(p.b), asWood(q.b), wqB, wpB, mid, true);
      quad(out, wpB, wqB, wqT, wpT, mid, true);
      quad(out, wpT, wqT, asWood(q.t), asWood(p.t), mid, true);
    } else {
      const cp = wood(p.a, p.r * 0.09, APEX);
      const cq = wood(q.a, q.r * 0.09, APEX);
      quad(out, asWood(p.b), asWood(q.b), cq, cp, mid, true);
      quad(out, cp, cq, asWood(q.t), asWood(p.t), mid, true);
      // Close the hinge: after the split this cap is the centre of the stump's (and the top's) cut
      const centre: V = [cx, APEX, cz, 0, 1, 0, FRESH_WOOD.r, FRESH_WOOD.g, FRESH_WOOD.b];
      const up = (v: V): V => [v[0], v[1], v[2], 0, 1, 0, v[6], v[7], v[8]];
      out.push(...centre, ...up(cp), ...up(cq));
    }
  }
}

/** The rim point coloured as fresh wood (the cut faces start right at the bark's edge). */
function asWood(v: V): V {
  return [v[0], v[1], v[2], v[3], v[4], v[5], FRESH_WOOD.r, FRESH_WOOD.g, FRESH_WOOD.b];
}

const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Two triangles a-b-c, a-c-d wound to face outwards (angle `mid`). Cut faces get a flat normal;
 * bark keeps the trunk's interpolated normals so the band shades like the rest of the trunk.
 */
function quad(out: number[], a: V, b: V, c: V, d: V, mid: number, flat: boolean): void {
  _e1.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  _e2.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  _n.crossVectors(_e2, _e1);
  if (_n.lengthSq() < 1e-12) {
    _e2.set(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    _n.crossVectors(_e1, _e2);
  }
  const outward = _n.x * Math.sin(mid) + _n.z * Math.cos(mid) >= 0;
  _n.normalize();
  if (!outward) _n.negate();
  const fix = (v: V): V => (flat ? [v[0], v[1], v[2], _n.x, _n.y, _n.z, v[6], v[7], v[8]] : v);
  const [A, B, Cc, D] = [fix(a), fix(b), fix(c), fix(d)];
  if (outward) out.push(...A, ...B, ...Cc, ...A, ...Cc, ...D);
  else out.push(...A, ...Cc, ...B, ...A, ...D, ...Cc);
}
