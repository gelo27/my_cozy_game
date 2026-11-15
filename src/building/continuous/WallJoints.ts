import * as THREE from 'three';
import { BuiltPiece, getWallSize } from '../types/BuildingTypes';
import { WALL_THICKNESS } from '../config/BuildingConstants';

/**
 * How solid walls join: corners, straight runs, T-junctions and crossings, at any angle and between
 * walls of different heights. One set of rules, shared by the wall mesh, the floor trimming and the
 * inside/outside detection (WallSides).
 *
 * A wall is a centre-line segment p1→p2 ("start" → "end") with thickness. Its +Z face is "left".
 * Where wall ends meet, each wall's two side lines are cut where they cross the side lines of the
 * walls next to it (going round the joint), so footprints meet edge to edge without overlap; a joint
 * of three or more walls leaves a small middle polygon (the "hub") that is filled separately.
 * A wall end that stops on the side of another wall (a T) is cut flush with that wall's face.
 */

/** Wall ends closer than this (m) are one joint */
export const WALL_JOINT_TOLERANCE = 0.12;
/** A wall end this close (m) to another wall's centre line butts into it (T-junction) */
export const WALL_T_TOLERANCE = WALL_THICKNESS / 2 + WALL_JOINT_TOLERANCE;
/** Mitre points of very sharp corners are kept within this many half-thicknesses of the joint */
const MAX_MITER = 6;
/** Height bands thinner than this (m) are merged */
const BAND_EPS = 0.02;

const HALF_T = WALL_THICKNESS / 2;

export interface WallSeg {
  piece: BuiltPiece;
  /** Centre line ends (x, z) */
  p1: THREE.Vector2;
  p2: THREE.Vector2;
  /** Unit direction p1 → p2 */
  dir: THREE.Vector2;
  /** +Z ("left") face normal */
  left: THREE.Vector2;
  halfW: number;
  yBase: number;
  yTop: number;
}

export function describeWallSeg(piece: BuiltPiece): WallSeg {
  const [width, height] = getWallSize(piece.type);
  const t = new THREE.Vector3(1, 0, 0).applyQuaternion(piece.quaternion);
  const dir = new THREE.Vector2(t.x, t.z).normalize();
  const c = new THREE.Vector2(piece.position.x, piece.position.z);
  const halfW = width / 2;
  return {
    piece,
    p1: c.clone().addScaledVector(dir, -halfW),
    p2: c.clone().addScaledVector(dir, halfW),
    dir,
    left: new THREE.Vector2(-dir.y, dir.x),
    halfW,
    yBase: piece.position.y - height / 2,
    yTop: piece.position.y + height / 2,
  };
}

/** One horizontal band of a wall, with its four footprint corners. */
export interface WallRow {
  y0: number;
  y1: number;
  startLeft: THREE.Vector2;
  startRight: THREE.Vector2;
  endLeft: THREE.Vector2;
  endRight: THREE.Vector2;
  /** The end is open (nothing joins there): it needs an end cap */
  hasStartCap: boolean;
  hasEndCap: boolean;
}

/** Middle polygon of a joint of 3+ walls, filled on top / underneath where it is exposed. */
export interface WallHub {
  points: THREE.Vector2[];
  y0: number;
  y1: number;
  top: boolean;
  bottom: boolean;
}

export interface SolvedWall {
  seg: WallSeg;
  rows: WallRow[];
  /** Hubs this wall is responsible for drawing (each hub is drawn by exactly one of its walls) */
  hubs: WallHub[];
}

interface EndLink {
  seg: WallSeg;
  /** Unit direction from the joint along the linked wall */
  away: THREE.Vector2;
}

interface TLink {
  seg: WallSeg;
}

const _a = new THREE.Vector2();
const _b = new THREE.Vector2();

function distToSegment(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): { dist: number; t: number } {
  const ab = _a.subVectors(b, a);
  const lenSq = ab.lengthSq();
  const t = lenSq > 0 ? THREE.MathUtils.clamp(_b.subVectors(p, a).dot(ab) / lenSq, 0, 1) : 0;
  const dx = a.x + ab.x * t - p.x;
  const dy = a.y + ab.y * t - p.y;
  return { dist: Math.hypot(dx, dy), t };
}

/** Whether two walls touch (shared joint or T), for grouping walls into buildings. */
export function wallSegsTouch(a: WallSeg, b: WallSeg): boolean {
  if (a.yTop < b.yBase - 0.05 || b.yTop < a.yBase - 0.05) return false;
  return (
    distToSegment(a.p1, b.p1, b.p2).dist < WALL_T_TOLERANCE ||
    distToSegment(a.p2, b.p1, b.p2).dist < WALL_T_TOLERANCE ||
    distToSegment(b.p1, a.p1, a.p2).dist < WALL_T_TOLERANCE ||
    distToSegment(b.p2, a.p1, a.p2).dist < WALL_T_TOLERANCE
  );
}

const covers = (s: WallSeg, y: number) => s.yBase - 0.05 <= y && y <= s.yTop + 0.05;

/** Intersection of lines (p + s·d) and (q + t·e), or null when parallel. */
function intersectLines(p: THREE.Vector2, d: THREE.Vector2, q: THREE.Vector2, e: THREE.Vector2): THREE.Vector2 | null {
  const cross = d.x * e.y - d.y * e.x;
  if (Math.abs(cross) < 1e-6) return null;
  const s = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / cross;
  return new THREE.Vector2(p.x + d.x * s, p.y + d.y * s);
}

/** CCW angle (0..2π) from a to b */
function ccwAngle(a: THREE.Vector2, b: THREE.Vector2): number {
  let ang = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
  if (ang <= 1e-6) ang += Math.PI * 2;
  return ang;
}

function clampMiter(node: THREE.Vector2, p: THREE.Vector2): THREE.Vector2 {
  const d = p.clone().sub(node);
  const max = HALF_T * MAX_MITER;
  if (d.lengthSq() > max * max) d.setLength(max);
  return node.clone().add(d);
}

/**
 * Corners of a wall end at `node`, the wall running from the joint along `away`, joined with `links`
 * (the other walls meeting there in this height band). Left/right are seen looking along `away`.
 */
function jointCorners(node: THREE.Vector2, away: THREE.Vector2, links: EndLink[]): { left: THREE.Vector2; right: THREE.Vector2 } {
  const leftN = new THREE.Vector2(-away.y, away.x);
  const myLeft = node.clone().addScaledVector(leftN, HALF_T);
  const myRight = node.clone().addScaledVector(leftN, -HALF_T);
  if (links.length === 0) return { left: myLeft, right: myRight };
  // Nearest neighbour turning counter-clockwise (left side) and clockwise (right side)
  let lBest = links[0], lAng = Infinity, rBest = links[0], rAng = -Infinity;
  for (const l of links) {
    const ang = ccwAngle(away, l.away);
    if (ang < lAng) { lAng = ang; lBest = l; }
    if (ang > rAng) { rAng = ang; rBest = l; }
  }
  const lN = new THREE.Vector2(-lBest.away.y, lBest.away.x);
  const rN = new THREE.Vector2(-rBest.away.y, rBest.away.x);
  // The left neighbour faces us with its right side, the right neighbour with its left side
  const left = intersectLines(myLeft, away, node.clone().addScaledVector(lN, -HALF_T), lBest.away);
  const right = intersectLines(myRight, away, node.clone().addScaledVector(rN, HALF_T), rBest.away);
  return {
    left: left ? clampMiter(node, left) : myLeft,
    right: right ? clampMiter(node, right) : myRight,
  };
}

/** Corners of a wall end that butts into the side of `into` (T-junction): flush with its face. */
function teeCorners(node: THREE.Vector2, away: THREE.Vector2, into: WallSeg): { left: THREE.Vector2; right: THREE.Vector2 } {
  const leftN = new THREE.Vector2(-away.y, away.x);
  // The face of `into` on our side: we run away from the joint, so towards where we go
  const side = Math.sign(away.dot(into.left)) || 1;
  const faceP = into.p1.clone().addScaledVector(into.left, HALF_T * side);
  const myLeft = node.clone().addScaledVector(leftN, HALF_T);
  const myRight = node.clone().addScaledVector(leftN, -HALF_T);
  const left = intersectLines(myLeft, away, faceP, into.dir);
  const right = intersectLines(myRight, away, faceP, into.dir);
  return {
    left: left ? clampMiter(node, left) : myLeft,
    right: right ? clampMiter(node, right) : myRight,
  };
}

interface EndInfo {
  node: THREE.Vector2;
  away: THREE.Vector2;
  links: EndLink[];
  tees: TLink[];
}

function endInfo(seg: WallSeg, atStart: boolean, neighbours: WallSeg[]): EndInfo {
  const node = atStart ? seg.p1 : seg.p2;
  const away = atStart ? seg.dir.clone() : seg.dir.clone().negate();
  const links: EndLink[] = [];
  const tees: TLink[] = [];
  for (const o of neighbours) {
    if (o === seg) continue;
    if (o.p1.distanceTo(node) < WALL_JOINT_TOLERANCE) links.push({ seg: o, away: o.dir.clone() });
    else if (o.p2.distanceTo(node) < WALL_JOINT_TOLERANCE) links.push({ seg: o, away: o.dir.clone().negate() });
    else {
      const { dist, t } = distToSegment(node, o.p1, o.p2);
      const len = o.halfW * 2;
      const inside = t * len > WALL_JOINT_TOLERANCE && (1 - t) * len > WALL_JOINT_TOLERANCE;
      // Butting into the side: not running along it
      if (inside && dist < WALL_T_TOLERANCE && Math.abs(away.dot(o.dir)) < 0.97) tees.push({ seg: o });
    }
  }
  return { node, away, links, tees };
}

function bandKey(links: EndLink[]): string {
  return links.map((l) => l.seg.piece.id).sort().join('|');
}

/**
 * Solves one wall against its `neighbours` (walls whose ends may touch it; extra walls are fine).
 * The wall is split into height bands wherever the set of joined walls changes, so a tall wall
 * meeting a low one is mitred only where they overlap and gets an end cap above.
 */
export function solveWall(seg: WallSeg, neighbours: WallSeg[]): SolvedWall {
  const start = endInfo(seg, true, neighbours);
  const end = endInfo(seg, false, neighbours);

  const cuts = new Set<number>([seg.yBase, seg.yTop]);
  for (const info of [start, end]) {
    for (const s of [...info.links.map((l) => l.seg), ...info.tees.map((t) => t.seg)]) {
      for (const y of [s.yBase, s.yTop]) {
        if (y > seg.yBase + BAND_EPS && y < seg.yTop - BAND_EPS) cuts.add(y);
      }
    }
  }
  const ys = Array.from(cuts).sort((a, b) => a - b);
  const bands: number[] = [ys[0]];
  for (let i = 1; i < ys.length; i++) if (ys[i] - bands[bands.length - 1] > BAND_EPS) bands.push(ys[i]);
  if (bands.length < 2) bands.push(seg.yTop);
  bands[bands.length - 1] = seg.yTop;

  const rows: WallRow[] = [];
  const hubs: WallHub[] = [];
  for (let i = 0; i < bands.length - 1; i++) {
    const y0 = bands[i];
    const y1 = bands[i + 1];
    const yMid = (y0 + y1) / 2;
    const s = solveEnd(seg, start, yMid);
    const e = solveEnd(seg, end, yMid);
    rows.push({
      y0,
      y1,
      startLeft: s.left,
      startRight: s.right,
      // At the end the wall runs back towards the start: its node-left is the wall's right side
      endLeft: e.right,
      endRight: e.left,
      hasStartCap: s.open,
      hasEndCap: e.open,
    });
    for (const [info, res] of [[start, s], [end, e]] as const) {
      const hub = res.links.length >= 2 ? buildHub(seg, info, res.links, y0, y1) : null;
      if (hub) hubs.push(hub);
    }
  }
  return { seg, rows, hubs };
}

function solveEnd(seg: WallSeg, info: EndInfo, yMid: number): { left: THREE.Vector2; right: THREE.Vector2; open: boolean; links: EndLink[] } {
  const links = info.links.filter((l) => covers(l.seg, yMid));
  if (links.length > 0) return { ...jointCorners(info.node, info.away, links), open: false, links };
  const tee = info.tees.find((t) => covers(t.seg, yMid));
  if (tee) return { ...teeCorners(info.node, info.away, tee.seg), open: false, links };
  const c = jointCorners(info.node, info.away, []);
  return { ...c, open: true, links };
}

/**
 * The hub of a 3+ wall joint for band y0..y1, if `seg` is the wall that draws it (lowest id).
 * Its top/bottom are only drawn where the joint above/below is different (otherwise it is inside).
 */
function buildHub(seg: WallSeg, info: EndInfo, links: EndLink[], y0: number, y1: number): WallHub | null {
  const all: EndLink[] = [{ seg, away: info.away }, ...links];
  const ids = all.map((l) => l.seg.piece.id).sort();
  if (ids[0] !== seg.piece.id) return null;
  const pts: THREE.Vector2[] = [];
  for (const l of all) {
    const others = all.filter((o) => o !== l);
    const c = jointCorners(info.node, l.away, others);
    for (const p of [c.left, c.right]) if (!pts.some((q) => q.distanceToSquared(p) < 1e-6)) pts.push(p);
  }
  if (pts.length < 3) return null;
  const n = info.node;
  pts.sort((a, b) => Math.atan2(a.y - n.y, a.x - n.x) - Math.atan2(b.y - n.y, b.x - n.x));
  const key = bandKey(links);
  const above = bandKey(info.links.filter((l) => covers(l.seg, y1 + 0.06)));
  const below = bandKey(info.links.filter((l) => covers(l.seg, y0 - 0.06)));
  return {
    points: pts,
    y0,
    y1,
    top: !(seg.yTop > y1 + BAND_EPS && above === key),
    bottom: !(seg.yBase < y0 - BAND_EPS && below === key),
  };
}

/** Footprint quad of a solved wall at its base (for floor trimming and paint picking). */
export interface SolvedSegmentCorners {
  startLeft: THREE.Vector2;
  startRight: THREE.Vector2;
  endLeft: THREE.Vector2;
  endRight: THREE.Vector2;
  yBase: number;
  yTop: number;
  hasStartCap: boolean;
  hasEndCap: boolean;
}

export function summarizeWall(w: SolvedWall): SolvedSegmentCorners {
  const r = w.rows[0];
  return {
    startLeft: r.startLeft,
    startRight: r.startRight,
    endLeft: r.endLeft,
    endRight: r.endRight,
    yBase: w.seg.yBase,
    yTop: w.seg.yTop,
    hasStartCap: w.rows.some((rw) => rw.hasStartCap),
    hasEndCap: w.rows.some((rw) => rw.hasEndCap),
  };
}
