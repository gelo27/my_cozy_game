import * as THREE from 'three';
import { BuiltPiece, getWallSize, isDoorPiece, isDoorwayPiece } from '../types/BuildingTypes';
import { WALL_THICKNESS } from '../config/BuildingConstants';
import { MeshBuffers } from './MeshBuffers';
import { SolvedWall, WallRow } from './WallJoints';
import { slabCoversWallTop, subtractObstacles, WallObstacle } from './FloorGeometry';

/**
 * Emits the merged mesh of solved walls: both faces (cut around windows and doors), the reveals
 * inside each opening, end caps, top and bottom edges, and the hubs of 3+ wall joints.
 *
 * Face UVs are in metres (U along the wall in world space, so patterns run on across walls in a
 * line; V up from the wall's base, so wainscoting stays at the floor); the wallpaper tile scale is
 * applied by PaintableMesh. Faces are keyed `pieceId:left` / `pieceId:right` for painting.
 */

/** Trim (edges, caps, reveals) checker tile size, m */
const TRIM_TILE = 0.5;
const EPS = 1e-4;

export interface WallOpening {
  piece: BuiltPiece;
  /** Hole extent in the wall's local frame (x along the wall from its centre, y from its centre) */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Openings (windows, doors, doorways) in `opening pieces` that cut through `wall`. */
export function findWallOpenings(wall: BuiltPiece, openingPieces: BuiltPiece[]): WallOpening[] {
  const tangent = new THREE.Vector3(1, 0, 0).applyQuaternion(wall.quaternion);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(wall.quaternion);
  const [w, h] = getWallSize(wall.type);
  const out: WallOpening[] = [];
  const delta = new THREE.Vector3();
  const opTangent = new THREE.Vector3();
  for (const op of openingPieces) {
    delta.subVectors(op.position, wall.position);
    if (Math.abs(delta.dot(normal)) > 0.35) continue;
    opTangent.set(1, 0, 0).applyQuaternion(op.quaternion);
    if (Math.abs(opTangent.dot(tangent)) < 0.707) continue;
    const [ow, oh] = getWallSize(op.type);
    const lx = delta.dot(tangent);
    const ly = delta.y;
    const o = { piece: op, minX: lx - ow / 2, maxX: lx + ow / 2, minY: ly - oh / 2, maxY: ly + oh / 2 };
    const overlapX = Math.min(w / 2, o.maxX) - Math.max(-w / 2, o.minX);
    const overlapY = Math.min(h / 2, o.maxY) - Math.max(-h / 2, o.minY);
    if (overlapX > 0.02 && overlapY > 0.02) out.push(o);
  }
  return out;
}

/** [min,max] minus the x extents of `holes` */
function solidIntervals(min: number, max: number, holes: Array<{ minX: number; maxX: number }>): Array<[number, number]> {
  let solids: Array<[number, number]> = [[min, max]];
  for (const h of holes) {
    const next: Array<[number, number]> = [];
    for (const [a, b] of solids) {
      if (h.maxX <= a + EPS || h.minX >= b - EPS) {
        next.push([a, b]);
        continue;
      }
      if (h.minX > a + EPS) next.push([a, h.minX]);
      if (h.maxX < b - EPS) next.push([h.maxX, b]);
    }
    solids = next;
  }
  return solids;
}

const v3 = (p: THREE.Vector2, y: number) => new THREE.Vector3(p.x, y, p.y);

/** Slabs whose body holds a wall top at height y */
function coversAt(covers: WallObstacle[], y: number): WallObstacle[] {
  return covers.filter((c) => slabCoversWallTop(c.yBase, c.yTop, y));
}
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

export interface WallStyleIndex {
  /** Material index of trim (edges, caps, reveals) */
  edge: number;
  faceKey: (pieceId: string, side: 'left' | 'right') => string;
}

/**
 * `covers` are the footprints of floor slabs that lie over this wall's top (the floor of the storey
 * above): the top edge is left out under them, so it never shows through or z-fights with the floor.
 */
export function emitWall(b: MeshBuffers, solved: SolvedWall, openings: WallOpening[], style: WallStyleIndex, covers: WallObstacle[] = []): void {
  const { seg, rows } = solved;
  const piece = seg.piece;
  const center = new THREE.Vector2(piece.position.x, piece.position.z);
  const tan = seg.dir;
  const along = (p: THREE.Vector2) => (p.x - center.x) * tan.x + (p.y - center.y) * tan.y;
  /** World-space U: patterns line up across walls in the same line */
  const uOffset = center.x * tan.x + center.y * tan.y;
  const halfW = seg.halfW;
  const py = piece.position.y;

  rows.forEach((row, r) => {
    const rowOps = openings.filter((o) => Math.min(row.y1, py + o.maxY) - Math.max(row.y0, py + o.minY) > 0.02);
    emitFace(b, row, 'left', rowOps, along, uOffset, seg.yBase, py, style.faceKey(piece.id, 'left'));
    emitFace(b, row, 'right', rowOps, along, uOffset, seg.yBase, py, style.faceKey(piece.id, 'right'));

    b.beginGroup();
    emitReveals(b, row, rowOps, along, halfW, py, seg.yBase, seg.yTop);
    emitCaps(b, row, openings, halfW, py);
    if (r === 0) emitEdge(b, row, row.y0, false, openings, along, py);
    if (r === rows.length - 1) emitEdge(b, row, row.y1, true, openings, along, py, covers);
    for (const hub of solved.hubs) {
      if (hub.y0 !== row.y0) continue;
      if (hub.top) {
        const over = coversAt(covers, hub.y1);
        if (over.length === 0) b.polygon(hub.points, hub.y1, true, TRIM_TILE);
        else for (const p of subtractObstacles(hub.points, over)) b.polygon(p, hub.y1, true, TRIM_TILE);
      }
      if (hub.bottom) b.polygon(hub.points, hub.y0, false, TRIM_TILE);
    }
    b.endGroup(null, style.edge);
  });
}

/** Point on the face edge a→b at wall-local x (clamped to the edge) */
function onEdge(a: THREE.Vector2, b: THREE.Vector2, xa: number, xb: number, x: number): THREE.Vector2 {
  const span = Math.abs(xb - xa) < 1e-5 ? 1e-5 : xb - xa;
  const t = THREE.MathUtils.clamp((x - xa) / span, 0, 1);
  return a.clone().lerp(b, t);
}

function emitFace(
  b: MeshBuffers,
  row: WallRow,
  side: 'left' | 'right',
  ops: WallOpening[],
  along: (p: THREE.Vector2) => number,
  uOffset: number,
  yBase: number,
  py: number,
  key: string
): void {
  const isLeft = side === 'left';
  const a = isLeft ? row.startLeft : row.startRight;
  const e = isLeft ? row.endLeft : row.endRight;
  const xa = along(a);
  const xe = along(e);
  const lo = Math.min(xa, xe);
  const hi = Math.max(xa, xe);
  const uSign = isLeft ? 1 : -1;

  const rect = (x0: number, x1: number, ya: number, yb: number) => {
    if (x1 - x0 <= EPS || yb - ya <= 0.005) return;
    const p0 = onEdge(a, e, xa, xe, x0);
    const p1 = onEdge(a, e, xa, xe, x1);
    const u0 = uSign * (x0 + uOffset);
    const u1 = uSign * (x1 + uOffset);
    const v0 = ya - yBase;
    const v1 = yb - yBase;
    if (isLeft) {
      b.quad(v3(p0, ya), v3(p1, ya), v3(p1, yb), v3(p0, yb), [u0, v0, u1, v0, u1, v1, u0, v1]);
    } else {
      b.quad(v3(p1, ya), v3(p0, ya), v3(p0, yb), v3(p1, yb), [u1, v0, u0, v0, u0, v1, u1, v1]);
    }
  };

  b.beginGroup();
  for (const [x0, x1] of solidIntervals(lo, hi, ops)) rect(x0, x1, row.y0, row.y1);
  for (const op of ops) {
    const x0 = Math.max(lo, op.minX);
    const x1 = Math.min(hi, op.maxX);
    if (x1 - x0 <= EPS) continue;
    const opY0 = py + op.minY;
    const opY1 = py + op.maxY;
    if (opY0 > row.y0 + 0.005) rect(x0, x1, row.y0, Math.min(row.y1, opY0)); // below (sill)
    if (opY1 < row.y1 - 0.005) rect(x0, x1, Math.max(row.y0, opY1), row.y1); // above (header)
  }
  b.endGroup(key, 0, true);
}

/** Inside faces of each hole: the two jambs, the head and the sill. */
function emitReveals(
  b: MeshBuffers,
  row: WallRow,
  ops: WallOpening[],
  along: (p: THREE.Vector2) => number,
  halfW: number,
  py: number,
  wallBase: number,
  wallTop: number
): void {
  const xsl = along(row.startLeft), xel = along(row.endLeft);
  const xsr = along(row.startRight), xer = along(row.endRight);
  const T = WALL_THICKNESS / TRIM_TILE;
  for (const op of ops) {
    const opY0 = py + op.minY;
    const opY1 = py + op.maxY;
    const y0 = Math.max(row.y0, opY0);
    const y1 = Math.min(row.y1, opY1);
    if (y1 <= y0 + 0.005) continue;
    const x0 = Math.max(-halfW, op.minX);
    const x1 = Math.min(halfW, op.maxX);
    if (x1 - x0 <= 0.005) continue;
    const l0 = onEdge(row.startLeft, row.endLeft, xsl, xel, x0);
    const l1 = onEdge(row.startLeft, row.endLeft, xsl, xel, x1);
    const r0 = onEdge(row.startRight, row.endRight, xsr, xer, x0);
    const r1 = onEdge(row.startRight, row.endRight, xsr, xer, x1);
    const H = (y1 - y0) / TRIM_TILE;
    const W = (x1 - x0) / TRIM_TILE;
    // Jambs only where the hole's side is inside this wall (a hole across two walls has one per wall)
    if (op.minX > -halfW + 0.01) b.quad(v3(l0, y0), v3(r0, y0), v3(r0, y1), v3(l0, y1), [0, 0, T, 0, T, H, 0, H]);
    if (op.maxX < halfW - 0.01) b.quad(v3(r1, y0), v3(l1, y0), v3(l1, y1), v3(r1, y1), [0, 0, T, 0, T, H, 0, H]);
    // Head and sill where the hole ends inside the wall (not at its top or bottom)
    if (Math.abs(y1 - opY1) < 0.005 && y1 < wallTop - 0.01) {
      b.quad(v3(l0, y1), v3(r0, y1), v3(r1, y1), v3(l1, y1), [0, 0, W, 0, W, T, 0, T], DOWN);
    }
    const isDoor = isDoorPiece(op.piece.type) || isDoorwayPiece(op.piece.type);
    if (!isDoor && Math.abs(y0 - opY0) < 0.005 && y0 > wallBase + 0.01) {
      b.quad(v3(l0, y0), v3(l1, y0), v3(r1, y0), v3(r0, y0), [0, 0, T, 0, T, W, 0, W], UP);
    }
  }
}

function emitCaps(b: MeshBuffers, row: WallRow, ops: WallOpening[], halfW: number, py: number): void {
  const T = WALL_THICKNESS / TRIM_TILE;
  const H = (row.y1 - row.y0) / TRIM_TILE;
  // An opening running through the whole row at the end leaves nothing to cap
  const through = (atStart: boolean) =>
    ops.some((op) =>
      (atStart ? op.minX <= -halfW + 0.01 : op.maxX >= halfW - 0.01) &&
      py + op.minY <= row.y0 + 0.005 &&
      py + op.maxY >= row.y1 - 0.005
    );
  if (row.hasStartCap && !through(true)) {
    b.quad(v3(row.startRight, row.y0), v3(row.startLeft, row.y0), v3(row.startLeft, row.y1), v3(row.startRight, row.y1), [0, 0, T, 0, T, H, 0, H]);
  }
  if (row.hasEndCap && !through(false)) {
    b.quad(v3(row.endLeft, row.y0), v3(row.endRight, row.y0), v3(row.endRight, row.y1), v3(row.endLeft, row.y1), [0, 0, T, 0, T, H, 0, H]);
  }
}

/**
 * Top or bottom edge of the wall at height y, left out over openings that reach it (a door at the
 * floor, a tall window at the top) but kept on the solid parts beside them.
 */
function emitEdge(
  b: MeshBuffers,
  row: WallRow,
  y: number,
  top: boolean,
  ops: WallOpening[],
  along: (p: THREE.Vector2) => number,
  py: number,
  covers: WallObstacle[] = []
): void {
  const over = top ? coversAt(covers, y) : [];
  const holes = ops.filter((op) => (top ? py + op.maxY >= y - 0.005 : py + op.minY <= y + 0.005));
  const xsl = along(row.startLeft), xel = along(row.endLeft);
  const xsr = along(row.startRight), xer = along(row.endRight);
  const lo = Math.min(xsl, xel, xsr, xer) - 1;
  const hi = Math.max(xsl, xel, xsr, xer) + 1;
  for (const [x0, x1] of solidIntervals(lo, hi, holes)) {
    // Open ends of an interval are the real (mitred) corners
    const l0 = x0 <= lo + EPS ? row.startLeft : onEdge(row.startLeft, row.endLeft, xsl, xel, x0);
    const r0 = x0 <= lo + EPS ? row.startRight : onEdge(row.startRight, row.endRight, xsr, xer, x0);
    const l1 = x1 >= hi - EPS ? row.endLeft : onEdge(row.startLeft, row.endLeft, xsl, xel, x1);
    const r1 = x1 >= hi - EPS ? row.endRight : onEdge(row.startRight, row.endRight, xsr, xer, x1);
    const len = Math.max(l0.distanceTo(l1), r0.distanceTo(r1)) / TRIM_TILE;
    const T = WALL_THICKNESS / TRIM_TILE;
    if (top && over.length > 0) {
      const quad = [l0, l1, r1, r0];
      const left = subtractObstacles(quad, over);
      // Untouched by any slab: keep the strip's own along-the-wall UVs
      if (left.length === 1 && left[0].length === 4 && left[0].every((p) => quad.some((q) => q.distanceToSquared(p) < 1e-10))) {
        b.quad(v3(l0, y), v3(l1, y), v3(r1, y), v3(r0, y), [0, 0, len, 0, len, T, 0, T], UP);
      } else {
        for (const p of left) b.polygon(p, y, true, TRIM_TILE);
      }
    } else if (top) b.quad(v3(l0, y), v3(l1, y), v3(r1, y), v3(r0, y), [0, 0, len, 0, len, T, 0, T], UP);
    else b.quad(v3(l0, y), v3(r0, y), v3(r1, y), v3(l1, y), [0, 0, len, 0, len, T, 0, T], DOWN);
  }
}
