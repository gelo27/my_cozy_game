import * as THREE from 'three';
import { BuiltPiece, isSolidWallPiece } from './types/BuildingTypes';
import { describeWallSeg, wallSegsTouch, WallSeg, WALL_JOINT_TOLERANCE, WALL_T_TOLERANCE } from './continuous/WallJoints';
import type { TKey } from '../i18n/en';
import { normalizeFootprint } from './HouseRoofGeometry';

/**
 * The closed outline of a house's outer walls, for a roof over the whole house.
 *
 * Starting from one wall, the walls it is joined to (same corner and T rules as the wall mesh) are
 * collected; the top storey's walls are turned into a planar graph of centre lines (joints merged,
 * T-junctions split), stray walls that lead nowhere are trimmed, and the outer face of what is left
 * is the outline. Inner walls drop out on their own: they only bound rooms inside it.
 */

type Near = (center: THREE.Vector3, radius: number) => BuiltPiece[];
type P2 = [number, number];

export interface HouseOutline {
  /** Roof origin: middle of the outline at the wall tops */
  origin: THREE.Vector3;
  /** Roof rotation: local X runs along the seed wall */
  quaternion: THREE.Quaternion;
  /** Wall centre-line loop in roof-local (x, z), counter-clockwise */
  footprint: P2[];
  /** Walls the outline was built from (top storey) */
  wallIds: string[];
}

export type HouseOutlineResult = { ok: true; outline: HouseOutline } | { ok: false; reason: TKey };

const MAX_WALLS = 600;
const SAME_LEVEL = 0.15;
/** Walls must run along the seed wall or across it, within this |cos| */
const AXIS_COS = 0.9995;

export function findHouseOutline(seed: BuiltPiece, near: Near): HouseOutlineResult {
  if (!isSolidWallPiece(seed.type)) return { ok: false, reason: 'build.houseRoof.noWall' };

  // 1. Every wall joined to the seed, at any storey
  const seedSeg = describeWallSeg(seed);
  const segs = new Map<string, WallSeg>([[seed.id, seedSeg]]);
  const queue = [seedSeg];
  while (queue.length > 0 && segs.size < MAX_WALLS) {
    const s = queue.pop()!;
    const mid = new THREE.Vector3((s.p1.x + s.p2.x) / 2, (s.yBase + s.yTop) / 2, (s.p1.y + s.p2.y) / 2);
    for (const p of near(mid, s.halfW + 3)) {
      if (segs.has(p.id) || !isSolidWallPiece(p.type)) continue;
      const o = describeWallSeg(p);
      if (!wallSegsTouch(s, o)) continue;
      segs.set(p.id, o);
      queue.push(o);
    }
  }

  // 2. The top storey: walls whose tops are level with the highest one
  const level = Math.max(...Array.from(segs.values()).map((s) => s.yTop));
  const top = Array.from(segs.values()).filter((s) => Math.abs(s.yTop - level) < SAME_LEVEL);

  // 3. Roof frame: X along the seed wall
  const ax = new THREE.Vector2(seedSeg.dir.x, seedSeg.dir.y);
  const az = new THREE.Vector2(-ax.y, ax.x);
  const toLocal = (p: THREE.Vector2): P2 => [p.dot(ax), p.dot(az)];
  for (const s of top) {
    // Neither along the seed wall nor square to it
    if (Math.abs(s.dir.dot(ax)) < AXIS_COS && Math.abs(s.dir.dot(az)) < AXIS_COS) {
      return { ok: false, reason: 'build.houseRoof.notSquare' };
    }
  }

  // 4. Planar graph of centre lines. Each wall is snapped onto its own axis line.
  const nodes: P2[] = [];
  const nodeAt = (p: P2): number => {
    for (let i = 0; i < nodes.length; i++) {
      if (Math.abs(nodes[i][0] - p[0]) < WALL_JOINT_TOLERANCE && Math.abs(nodes[i][1] - p[1]) < WALL_JOINT_TOLERANCE) return i;
    }
    nodes.push([p[0], p[1]]);
    return nodes.length - 1;
  };
  interface Line {
    alongX: boolean;
    /** Fixed coordinate (z for a wall along X) */
    at: number;
    a: number;
    b: number;
  }
  const lines: Line[] = top.map((s) => {
    const p = toLocal(s.p1), q = toLocal(s.p2);
    const alongX = Math.abs(s.dir.dot(ax)) > 0.5;
    return alongX
      ? { alongX, at: (p[1] + q[1]) / 2, a: nodeAt([p[0], (p[1] + q[1]) / 2]), b: nodeAt([q[0], (p[1] + q[1]) / 2]) }
      : { alongX, at: (p[0] + q[0]) / 2, a: nodeAt([(p[0] + q[0]) / 2, p[1]]), b: nodeAt([(p[0] + q[0]) / 2, q[1]]) };
  });

  // Joints lie on both walls' centre lines
  for (const l of lines) {
    for (const end of [l.a, l.b]) nodes[end][l.alongX ? 1 : 0] = l.at;
  }

  // A wall end butting into the side of another wall (T) is moved onto that wall's centre line
  for (const l of lines) {
    for (const end of [l.a, l.b]) {
      for (const o of lines) {
        if (o === l || o.alongX === l.alongX) continue;
        const n = nodes[end];
        const along = o.alongX ? n[0] : n[1];
        const across = o.alongX ? n[1] : n[0];
        const lo = Math.min(o.alongX ? nodes[o.a][0] : nodes[o.a][1], o.alongX ? nodes[o.b][0] : nodes[o.b][1]);
        const hi = Math.max(o.alongX ? nodes[o.a][0] : nodes[o.a][1], o.alongX ? nodes[o.b][0] : nodes[o.b][1]);
        if (along < lo - WALL_JOINT_TOLERANCE || along > hi + WALL_JOINT_TOLERANCE) continue;
        if (Math.abs(across - o.at) >= WALL_T_TOLERANCE) continue;
        if (o.alongX) n[1] = o.at;
        else n[0] = o.at;
      }
    }
  }

  // Split every wall at the nodes lying on it, then deduplicate edges
  const adj = new Map<number, Set<number>>();
  const link = (i: number, j: number) => {
    if (i === j) return;
    if (!adj.has(i)) adj.set(i, new Set());
    if (!adj.has(j)) adj.set(j, new Set());
    adj.get(i)!.add(j);
    adj.get(j)!.add(i);
  };
  for (const l of lines) {
    const k = l.alongX ? 0 : 1;
    const lo = Math.min(nodes[l.a][k], nodes[l.b][k]), hi = Math.max(nodes[l.a][k], nodes[l.b][k]);
    const on = nodes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => Math.abs(n[1 - k] - l.at) < 1e-3 && n[k] >= lo - 1e-3 && n[k] <= hi + 1e-3)
      .sort((u, v) => u.n[k] - v.n[k]);
    for (let i = 0; i + 1 < on.length; i++) link(on[i].i, on[i + 1].i);
  }

  // 5. Trim walls that lead nowhere (a fence-like wall sticking out, an unfinished inner wall)
  for (let changed = true; changed; ) {
    changed = false;
    for (const [i, set] of adj) {
      if (set.size >= 2) continue;
      for (const j of set) adj.get(j)!.delete(i);
      adj.delete(i);
      changed = true;
    }
  }
  if (adj.size < 4) return { ok: false, reason: 'build.houseRoof.notClosed' };

  // 6. Outer face: walk keeping the outside on the left (always take the most counter-clockwise turn)
  const start = Array.from(adj.keys()).reduce((best, i) =>
    nodes[i][1] < nodes[best][1] - 1e-6 || (Math.abs(nodes[i][1] - nodes[best][1]) < 1e-6 && nodes[i][0] < nodes[best][0]) ? i : best
  );
  const angle = (from: number, to: number) => Math.atan2(nodes[to][1] - nodes[from][1], nodes[to][0] - nodes[from][0]);
  // From the lowest-left node the outline leaves along +X (inside on the left) when it can
  const next = Array.from(adj.get(start)!).reduce((best, j) => (angle(start, j) < angle(start, best) ? j : best));
  const loop: number[] = [start];
  const used = new Set<string>();
  let prev = start, cur = next;
  for (let guard = 0; guard < 10000; guard++) {
    const key = `${prev}>${cur}`;
    if (used.has(key)) return { ok: false, reason: 'build.houseRoof.notClosed' };
    used.add(key);
    if (cur === start) break;
    loop.push(cur);
    // First wall counter-clockwise from the way back: the sharpest right turn, which keeps the
    // outside on our right and skips inner walls
    const back = angle(cur, prev);
    let best = -1, bestTurn = Infinity;
    for (const j of adj.get(cur)!) {
      let turn = angle(cur, j) - back;
      while (turn <= 1e-9) turn += Math.PI * 2;
      if (turn < bestTurn) { bestTurn = turn; best = j; }
    }
    prev = cur;
    cur = best;
  }
  if (cur !== start) return { ok: false, reason: 'build.houseRoof.notClosed' };
  // A node visited twice means two parts joined at a single point or by one wall: not one house
  if (new Set(loop).size !== loop.length) return { ok: false, reason: 'build.houseRoof.notClosed' };

  let footprint: P2[] = loop.map((i) => [nodes[i][0], nodes[i][1]]);
  let area = 0;
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i], b = footprint[(i + 1) % footprint.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(area) < 1) return { ok: false, reason: 'build.houseRoof.notClosed' };
  const clean = normalizeFootprint(footprint);
  if (!clean) return { ok: false, reason: 'build.houseRoof.notClosed' };
  footprint = clean;

  // 7. Centre the roof on the outline
  const xs = footprint.map((p) => p[0]), zs = footprint.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  footprint = footprint.map(([x, z]) => [Math.round((x - cx) * 1000) / 1000, Math.round((z - cz) * 1000) / 1000]);
  const world = ax.clone().multiplyScalar(cx).add(az.clone().multiplyScalar(cz));
  // Local X → world (ax.x, 0, ax.y); local Z → world (az.x, 0, az.y)
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(ax.x, 0, ax.y),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(az.x, 0, az.y)
  );
  return {
    ok: true,
    outline: {
      origin: new THREE.Vector3(world.x, level, world.y),
      quaternion: new THREE.Quaternion().setFromRotationMatrix(basis),
      footprint,
      wallIds: top.map((s) => s.piece.id),
    },
  };
}
