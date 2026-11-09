import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import type { RockKind } from '../gathering/GatheringConfig';

/**
 * Procedural rocks in the game's low-poly style: each rock is a few chunky convex blocks (big flat
 * cleavage faces) leaning together. Three LODs share one shape so a switch hardly shows:
 *  - LOD0: every block with its corners chamfered (the bevel catches the light), ore nuggets /
 *    crystals in full;
 *  - LOD1: the same blocks with sharp corners, a few bigger nuggets, simpler crystals;
 *  - LOD2: one hull around the whole rock, the ore only painted onto its faces (crystals: the
 *    three biggest, three-sided).
 * Geometry is non-indexed with flat normals, per-vertex colour and `aGlow` (ore glow).
 */
export interface RockVariant {
  /** LOD0..LOD2 at scale 1 (the rock fits a horizontal radius of ROCK_RADIUS). */
  lods: THREE.BufferGeometry[];
  /** Collider points (the LOD2 hull) at scale 1, xyz packed. */
  hull: Float32Array;
  height: number;
}

/** Horizontal radius every variant is fitted to (m at scale 1). */
export const ROCK_RADIUS = 0.95;
/** Variants built per kind (picked per rock from its position). */
export const ROCK_VARIANTS: Record<RockKind, number> = { stone: 8, iron: 4, copper: 4, gold: 3, crystal: 3 };

const ORE: Partial<Record<RockKind, { color: THREE.Color; glow: number; stain: number }>> = {
  iron: { color: new THREE.Color(0xc2703d), glow: 0, stain: 0.22 },
  copper: { color: new THREE.Color(0x4fa88a), glow: 0, stain: 0.18 },
  gold: { color: new THREE.Color(0xf2c14e), glow: 0.05, stain: 0.12 },
  crystal: { color: new THREE.Color(0xb69bff), glow: 0.16, stain: 0 },
};
const STONE_TONES = [0x8b8f96, 0x7f838b, 0x938e86, 0x777b83].map((c) => new THREE.Color(c));
const CRYSTAL_STONE = new THREE.Color(0x60636c);
const MOSS = new THREE.Color(0x5f7f3c);
/** Faces with every corner below this are under the ground: never drawn. */
const BURIED = -0.06;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 0..1 per plane (coplanar triangles of one face get the same shade). */
function planeHash(n: THREE.Vector3, salt: number): number {
  const h = Math.sin(Math.round(n.x * 12) * 12.9898 + Math.round(n.y * 12) * 78.233 + Math.round(n.z * 12) * 37.719 + salt * 3.17) * 43758.5453;
  return h - Math.floor(h);
}

interface Chunk {
  points: THREE.Vector3[];
  /** Mean half-size (m), for the bevel. */
  size: number;
  tone: number;
}

interface Tri {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  n: THREE.Vector3;
  centre: THREE.Vector3;
  area: number;
}

function hullFaces(points: THREE.Vector3[]): { verts: THREE.Vector3[]; normal: THREE.Vector3 }[] {
  const hull = new ConvexHull().setFromPoints(points);
  const out: { verts: THREE.Vector3[]; normal: THREE.Vector3 }[] = [];
  for (const f of hull.faces) {
    const verts: THREE.Vector3[] = [];
    let e = f.edge;
    do {
      verts.push(e.head().point.clone());
      e = e.next;
    } while (e !== f.edge);
    out.push({ verts, normal: f.normal.clone() });
  }
  return out;
}

function hullTris(points: THREE.Vector3[]): Tri[] {
  const tris: Tri[] = [];
  for (const f of hullFaces(points)) {
    for (let i = 1; i < f.verts.length - 1; i++) {
      const a = f.verts[0], b = f.verts[i], c = f.verts[i + 1];
      const area = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
      tris.push({ a, b, c, n: f.normal, centre: new THREE.Vector3().add(a).add(b).add(c).divideScalar(3), area });
    }
  }
  return tris;
}

/** Chamfers every corner of the hull of `points`: the hull of points `bevel` m along each edge. */
function chamfer(points: THREE.Vector3[], bevel: number): THREE.Vector3[] {
  const hull = new ConvexHull().setFromPoints(points);
  const out: THREE.Vector3[] = [];
  for (const f of hull.faces) {
    let e = f.edge;
    do {
      const a = e.tail()!.point, b = e.head().point;
      const len = a.distanceTo(b);
      out.push(a.clone().lerp(b, Math.min(0.32, bevel / Math.max(1e-4, len))));
      e = e.next;
    } while (e !== f.edge);
  }
  return out;
}

class MeshBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly glow: number[] = [];
  private static readonly _c = new THREE.Color();

  /** Adds the hull of `points`, each face coloured by `paint(normal, centre, out)` (`keepAll`: buried faces too). */
  public hull(points: THREE.Vector3[], paint: (n: THREE.Vector3, centre: THREE.Vector3, out: THREE.Color) => void, glow: number, keepAll = false): void {
    const c = MeshBuilder._c;
    const centre = new THREE.Vector3();
    for (const f of hullFaces(points)) {
      if (!keepAll && f.verts.every((v) => v.y < BURIED)) continue;
      centre.set(0, 0, 0);
      for (const v of f.verts) centre.add(v);
      centre.divideScalar(f.verts.length);
      paint(f.normal, centre, c);
      for (let i = 1; i < f.verts.length - 1; i++) {
        for (const v of [f.verts[0], f.verts[i], f.verts[i + 1]]) {
          this.pos.push(v.x, v.y, v.z);
          this.nor.push(f.normal.x, f.normal.y, f.normal.z);
          this.col.push(c.r, c.g, c.b);
          this.glow.push(glow);
        }
      }
    }
  }

  public build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Roughly even points on an ellipsoid (Fibonacci), jittered; a few pulled in for big flat faces. */
function blockPoints(rnd: () => number, n: number, size: THREE.Vector3, centre: THREE.Vector3, yaw: number, tilt: number): THREE.Vector3[] {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * tilt, yaw, (rnd() - 0.5) * tilt));
  const pts: THREE.Vector3[] = [];
  const twist = rnd() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.3 + rnd() * 0.4)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * 2.39996 + twist + (rnd() - 0.5) * 0.7;
    const k = rnd() < 0.25 ? 0.72 + rnd() * 0.1 : 0.88 + rnd() * 0.17;
    const p = new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r).multiply(size).multiplyScalar(k);
    p.applyQuaternion(q).add(centre);
    // Flat base sunk a little into the ground
    if (p.y < -0.12) p.y = -0.12;
    pts.push(p);
  }
  return pts;
}

type Layout = 'boulder' | 'stack' | 'cluster' | 'slab';

function layoutBlocks(layout: Layout, rnd: () => number): Chunk[] {
  const chunks: Chunk[] = [];
  const add = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, n: number, tilt = 0.35) => {
    const size = new THREE.Vector3(sx, sy, sz);
    chunks.push({ points: blockPoints(rnd, n, size, new THREE.Vector3(cx, cy, cz), rnd() * Math.PI * 2, tilt), size: (sx + sy + sz) / 3, tone: 0.9 + rnd() * 0.16 });
  };
  const a0 = rnd() * Math.PI * 2;
  const around = (a: number, d: number) => [Math.cos(a0 + a) * d, Math.sin(a0 + a) * d];
  if (layout === 'boulder') {
    add(0, 0.3, 0, 0.95, 0.72, 0.85, 12);
    const sides = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < sides; i++) {
      const [x, z] = around(i * 2.4 + rnd() * 0.6, 0.78 + rnd() * 0.15);
      add(x, 0.12, z, 0.42 + rnd() * 0.15, 0.36 + rnd() * 0.12, 0.42 + rnd() * 0.12, 9);
    }
  } else if (layout === 'stack') {
    // Tall cleft rock with a broken block at its foot
    add(0, 0.58, 0, 0.66, 1.08, 0.62, 13, 0.25);
    const [x, z] = around(0, 0.55);
    add(x, 0.16, z, 0.52, 0.42, 0.5, 10);
    const [x2, z2] = around(2.5, 0.5);
    add(x2, 0.1, z2, 0.38, 0.3, 0.36, 8);
  } else if (layout === 'cluster') {
    // Several blocks huddled together, the middle one higher
    for (let i = 0; i < 3; i++) {
      const [x, z] = around(i * 2.1 + rnd() * 0.4, 0.5);
      add(x, 0.28, z, 0.55 + rnd() * 0.12, 0.5 + rnd() * 0.15, 0.55 + rnd() * 0.1, 10);
    }
    add(0, 0.62, 0, 0.5, 0.52, 0.48, 10, 0.5);
  } else {
    // Low wide slab (crystal beds)
    add(0, 0.12, 0, 1, 0.42, 0.9, 12, 0.2);
    const [x, z] = around(0, 0.7);
    add(x, 0.08, z, 0.45, 0.3, 0.42, 9, 0.3);
  }
  return chunks;
}

const LAYOUTS: Record<RockKind, Layout[]> = {
  stone: ['boulder', 'stack', 'cluster', 'boulder', 'cluster', 'stack', 'boulder', 'cluster'],
  iron: ['boulder', 'cluster', 'boulder', 'cluster'],
  copper: ['cluster', 'boulder', 'cluster', 'boulder'],
  gold: ['boulder', 'cluster', 'boulder'],
  crystal: ['slab', 'slab', 'boulder'],
};

interface Nugget {
  points: THREE.Vector3[];
  at: THREE.Vector3;
  big: number;
}

/** Support points of `pts` along a fixed set of directions: a coarse hull for LOD2 and the collider. */
function supportPoints(pts: THREE.Vector3[]): THREE.Vector3[] {
  const dirs: THREE.Vector3[] = [new THREE.Vector3(0, 1, 0)];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    dirs.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    dirs.push(new THREE.Vector3(Math.cos(a + 0.39) * 0.75, 0.66, Math.sin(a + 0.39) * 0.75));
    dirs.push(new THREE.Vector3(Math.cos(a + 0.2), -0.6, Math.sin(a + 0.2)).normalize());
  }
  const out = new Set<THREE.Vector3>();
  for (const d of dirs) {
    let best = pts[0], bd = -Infinity;
    for (const p of pts) {
      const v = p.dot(d);
      if (v > bd) { bd = v; best = p; }
    }
    out.add(best);
  }
  return [...out];
}

/** Crystal prism: a `sides`-gon column with a pointed tip, base sunk into the rock. */
function prismPoints(base: THREE.Vector3, dir: THREE.Vector3, h: number, r: number, sides: number, spin: number): THREE.Vector3[] {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < sides; i++) {
    const a = spin + (i / sides) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, -0.18, Math.sin(a) * r));
    pts.push(new THREE.Vector3(Math.cos(a) * r * 0.92, h * 0.74, Math.sin(a) * r * 0.92));
  }
  pts.push(new THREE.Vector3(0, h, 0));
  return pts.map((p) => p.applyQuaternion(q).add(base));
}

/** Stone and ore colours of a kind (the mined chips take them, tinted per instance). */
export function rockColors(kind: RockKind): { stone: THREE.Color; ore: THREE.Color | null } {
  return { stone: kind === 'crystal' ? CRYSTAL_STONE : STONE_TONES[0], ore: ORE[kind]?.color ?? null };
}

/**
 * A small chamfered stone chip about 1 m across at scale 1, centred on the origin, near-white per
 * face (an instance colour gives it the stone or ore colour). Flown off by the pickaxe.
 */
export function buildChipGeometry(): THREE.BufferGeometry {
  const rnd = mulberry32(0x5eed);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 9; i++) {
    const y = 1 - (2 * (i + 0.5)) / 9;
    const r = Math.sqrt(1 - y * y);
    const a = i * 2.39996 + rnd() * 0.5;
    pts.push(new THREE.Vector3(Math.cos(a) * r * 0.5, y * 0.38, Math.sin(a) * r * 0.45).multiplyScalar(0.85 + rnd() * 0.3));
  }
  const b = new MeshBuilder();
  b.hull(chamfer(pts, 0.08), (n, _c, out) => out.setScalar(0.82 + 0.3 * planeHash(n, 5) + 0.08 * n.y), 0, true);
  const g = b.build();
  g.deleteAttribute('aGlow');
  return g;
}

/**
 * The decorative rocks' LODs (PropSystem `rock_small` / `rock_big`): the same faceted stone as the
 * mineable rocks, sized to the old props (their colliders and baked shadows stay as they were).
 * One material group each, plain vertex-coloured (no glow attribute).
 */
export function buildDecorRockLods(type: 'rock_small' | 'rock_big'): THREE.BufferGeometry[] {
  // rock_big: a huddle of blocks (stone variant 2 is a cluster); rock_small: a low boulder (0)
  const v = type === 'rock_big' ? buildRockVariant('stone', 2, 11) : buildRockVariant('stone', 0, 23);
  const s = type === 'rock_big' ? 1.35 : 0.5;
  return v.lods.map((g) => {
    g.deleteAttribute('aGlow');
    g.scale(s, type === 'rock_small' ? s * 0.8 : s, s);
    g.clearGroups();
    g.addGroup(0, g.getAttribute('position').count, 0);
    g.computeBoundingSphere();
    return g;
  });
}

export function buildRockVariant(kind: RockKind, index: number, salt = 0): RockVariant {
  const rnd = mulberry32(0x9e3779b1 ^ (index * 7919 + kind.length * 104729 + kind.charCodeAt(0) * 31 + salt * 65537));
  const layouts = LAYOUTS[kind];
  const chunks = layoutBlocks(layouts[index % layouts.length], rnd);

  // Fit to the gameplay radius
  let maxR = 0;
  for (const c of chunks) for (const p of c.points) maxR = Math.max(maxR, Math.hypot(p.x, p.z));
  const fit = ROCK_RADIUS / Math.max(0.1, maxR);
  for (const c of chunks) {
    for (const p of c.points) p.set(p.x * fit, p.y >= 0 ? p.y * fit : p.y, p.z * fit);
    c.size *= fit;
  }

  const ore = ORE[kind];
  const stone = kind === 'crystal' ? CRYSTAL_STONE : STONE_TONES[Math.floor(rnd() * STONE_TONES.length)];
  const mossy = kind === 'stone' && rnd() < 0.55;
  // The ore follows a vein: a band around a tilted plane through the rock
  const veinN = new THREE.Vector3(rnd() - 0.5, 0.4 + rnd() * 0.5, rnd() - 0.5).normalize();
  const veinO = new THREE.Vector3(0, 0.45, 0);
  const inVein = (p: THREE.Vector3, band: number) => Math.abs(new THREE.Vector3().subVectors(p, veinO).dot(veinN)) < band;

  const blockTris = chunks.map((c) => hullTris(c.points));
  let height = 0;
  for (const c of chunks) for (const p of c.points) height = Math.max(height, p.y);

  const paintStone = (tone: number, salt: number, stain: number) => (n: THREE.Vector3, centre: THREE.Vector3, out: THREE.Color) => {
    out.copy(stone).multiplyScalar(tone * (0.92 + 0.14 * planeHash(n, salt)));
    // Darker towards the ground (cheap ambient occlusion), light on the faces turned up
    out.multiplyScalar(0.72 + 0.28 * THREE.MathUtils.smoothstep(centre.y, -0.05, 0.75 * height));
    if (n.y > 0.5) out.multiplyScalar(1 + (n.y - 0.5) * 0.18);
    if (mossy && n.y > 0.62) out.lerp(MOSS, Math.min(0.55, (n.y - 0.62) * 1.6));
    if (ore && stain > 0 && inVein(centre, 0.3)) out.lerp(ore.color, stain);
  };

  // Ore nuggets / crystals, placed on the blocks' outer faces (LOD1 hulls)
  const nuggets: Nugget[] = [];
  const crystals: { base: THREE.Vector3; dir: THREE.Vector3; h: number; r: number; spin: number }[] = [];
  if (ore) {
    const all = blockTris.flat();
    const pickFace = (ok: (t: Tri) => boolean): Tri | null => {
      let cands = all.filter(ok);
      if (!cands.length) cands = all.filter((t) => t.n.y > 0);
      let sum = 0;
      for (const t of cands) sum += t.area;
      let r = rnd() * sum;
      for (const t of cands) if ((r -= t.area) <= 0) return t;
      return cands[cands.length - 1] ?? null;
    };
    const onFace = (t: Tri) => {
      let u = rnd(), v = rnd();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      return t.a.clone().addScaledVector(new THREE.Vector3().subVectors(t.b, t.a), u).addScaledVector(new THREE.Vector3().subVectors(t.c, t.a), v);
    };
    if (kind === 'crystal') {
      // A tall one on top, the rest leaning out of the upper faces
      for (let i = 0; i < 6; i++) {
        const t = pickFace((f) => f.n.y > 0.35 && f.centre.y > height * 0.35);
        if (!t) break;
        const base = onFace(t);
        const dir = t.n.clone().multiplyScalar(0.55).add(new THREE.Vector3(0, 1, 0)).normalize();
        crystals.push({ base, dir, h: i === 0 ? 1.15 : 0.45 + rnd() * 0.45, r: i === 0 ? 0.17 : 0.1 + rnd() * 0.05, spin: rnd() * Math.PI });
      }
    } else {
      for (let i = 0; i < 8; i++) {
        const t = pickFace((f) => f.n.y > -0.15 && f.centre.y > 0.08 && inVein(f.centre, 0.24));
        if (!t) break;
        const at = onFace(t).addScaledVector(t.n, 0.03);
        const s = 0.1 + rnd() * 0.08;
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3));
        const pts = [
          [1, 0, 0], [-1, 0, 0], [0, 1.2, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.6, 0.6, 0.6], [-0.6, 0.5, -0.5],
        ].map(([x, y, z]) => new THREE.Vector3(x, y, z).multiplyScalar(s * (0.85 + rnd() * 0.3)).applyQuaternion(q).add(at));
        nuggets.push({ points: pts, at, big: s });
      }
      nuggets.sort((a, b) => b.big - a.big);
    }
  }
  const paintOre = (n: THREE.Vector3, _c: THREE.Vector3, out: THREE.Color) => {
    out.copy(ore!.color).multiplyScalar(0.85 + 0.3 * planeHash(n, 7));
  };

  const lods: THREE.BufferGeometry[] = [];
  // LOD0: chamfered blocks, all the ore
  {
    const b = new MeshBuilder();
    chunks.forEach((c, i) => b.hull(chamfer(c.points, c.size * 0.16), paintStone(c.tone, i, ore?.stain ?? 0), 0));
    // Nuggets are too small for a chamfer to show
    for (const ng of nuggets) b.hull(ng.points, paintOre, ore!.glow);
    for (const c of crystals) b.hull(prismPoints(c.base, c.dir, c.h, c.r, 6, c.spin), paintOre, ore!.glow);
    lods.push(b.build());
  }
  // LOD1: sharp blocks, the three biggest nuggets (a bit larger), four-sided crystals
  {
    const b = new MeshBuilder();
    chunks.forEach((c, i) => b.hull(c.points, paintStone(c.tone, i, ore?.stain ?? 0), 0));
    for (const ng of nuggets.slice(0, 3)) b.hull(ng.points.map((p) => p.clone().sub(ng.at).multiplyScalar(1.35).add(ng.at)), paintOre, ore!.glow);
    for (const c of crystals) b.hull(prismPoints(c.base, c.dir, c.h, c.r, 4, c.spin), paintOre, ore!.glow);
    lods.push(b.build());
  }
  // LOD2: one coarse hull, the ore painted on (crystals: the three biggest, three-sided)
  const all: THREE.Vector3[] = chunks.flatMap((c) => c.points);
  const coarse = supportPoints(all);
  {
    const b = new MeshBuilder();
    b.hull(coarse, (n, centre, out) => {
      paintStone(1, 0, 0)(n, centre, out);
      if (ore && kind !== 'crystal' && nuggets.some((ng) => ng.at.distanceTo(centre) < 0.42)) out.lerp(ore.color, 0.6);
    }, 0);
    for (const c of [...crystals].sort((x, y) => y.h - x.h).slice(0, 3)) b.hull(prismPoints(c.base, c.dir, c.h, c.r * 1.2, 3, c.spin), paintOre, ore!.glow);
    lods.push(b.build());
  }

  const hull = new Float32Array(coarse.length * 3);
  coarse.forEach((p, i) => hull.set([p.x, Math.max(0, p.y), p.z], i * 3));
  return { lods, hull, height };
}
