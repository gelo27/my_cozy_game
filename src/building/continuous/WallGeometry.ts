import * as THREE from 'three';
import { BuiltPiece, BuildingPieceType, getWallSize } from '../types/BuildingTypes';
import { BAY_EAVE_Y, WALL_THICKNESS } from '../config/BuildingConstants';
import { MeshBuffers } from './MeshBuffers';
import { SolvedWall, WallRow, WallSeg } from './WallJoints';
import { archedDoorContour, openingContour } from '../OpeningContour';
import { clipPolygonByPlane, convexObstacle, subtractConvexPolygon, slabCoversWallTop, subtractObstacles, WallObstacle } from './FloorGeometry';

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
export const WALL_OPENING_NEIGHBOUR_MARGIN = 2.5;
export interface WallOpening {
  /** Convex opening in local horizontal metres and world height. */
  outline: WallObstacle;
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
    if (Math.abs(lx) >= (w + ow) / 2 - EPS || Math.abs(delta.y) >= (h + oh) / 2 - EPS) continue;
    const profile = op.type === BuildingPieceType.WOOD_WALL_WINDOW_ROUND ? 'round'
      : op.type === BuildingPieceType.WOOD_WALL_WINDOW_ARCH || op.type === BuildingPieceType.WOOD_WALL_WINDOW_PALLADIAN ? 'arch' : 'rect';
    const points = op.type === BuildingPieceType.WOOD_DOOR_ARCH
      ? archedDoorContour()
      : openingContour(profile, ow, oh);
    // Keep the wall behind the solid canopy, including the corners above the hips.
    if (op.type === BuildingPieceType.WOOD_WALL_WINDOW_BAY) {
      for (const p of points) p.y = Math.min(p.y, BAY_EAVE_Y);
    }
    for (const p of points) { p.x += lx; p.y += op.position.y; }
    out.push({ outline: convexObstacle(points, 0, 0) });
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

  rows.forEach((row, r) => {
    const rowOps = openings.filter((o) => Math.min(row.y1, o.outline.maxZ) - Math.max(row.y0, o.outline.minZ) > EPS);
    emitFace(b, row, 'left', rowOps, along, uOffset, seg.yBase, style.faceKey(piece.id, 'left'));
    emitFace(b, row, 'right', rowOps, along, uOffset, seg.yBase, style.faceKey(piece.id, 'right'));

    b.beginGroup();
    emitReveals(b, row, rowOps, along, halfW, seg.yBase, seg.yTop);
    emitCaps(b, row, openings, halfW);
    if (r === 0) emitEdge(b, row, row.y0, false, openings, along);
    if (r === rows.length - 1) emitEdge(b, row, row.y1, true, openings, along, covers);
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

/** Point on the face edge aв†’b at wall-local x (clamped to the edge) */
function onEdge(a: THREE.Vector2, b: THREE.Vector2, xa: number, xb: number, x: number): THREE.Vector2 {
  const span = Math.abs(xb - xa) < 1e-5 ? 1e-5 : xb - xa;
  const t = THREE.MathUtils.clamp((x - xa) / span, 0, 1);
  return a.clone().lerp(b, t);
}

/** Triangulate around complete contours so adjacent triangles share their edge endpoints.
 * For a cut that spans walls or height bands, clip those triangles to this face afterwards. */
function wallFacePolygons(x0: number, x1: number, y0: number, y1: number, ops: WallOpening[]) {
  const rectangle = (l: number, r: number, b: number, t: number) => [
    new THREE.Vector2(l, b), new THREE.Vector2(r, b), new THREE.Vector2(r, t), new THREE.Vector2(l, t),
  ];
  const face = rectangle(x0, x1, y0, y1);
  if (!ops.length) return [face];
  const holes = ops.map(op => op.outline);
  // Imported layouts can have overlapping cutouts. Earcut expects separate holes.
  if (holes.some((a, i) => holes.slice(i + 1).some(b =>
    a.maxX >= b.minX && b.maxX >= a.minX && a.maxZ >= b.minZ && b.maxZ >= a.minZ))) {
    return holes.reduce((faces, hole) => faces.flatMap(p => subtractConvexPolygon(p, hole, 1e-10)), [face]);
  }
  const outer = rectangle(
    Math.min(x0, ...holes.map(h => h.minX - EPS)), Math.max(x1, ...holes.map(h => h.maxX + EPS)),
    Math.min(y0, ...holes.map(h => h.minZ - EPS)), Math.max(y1, ...holes.map(h => h.maxZ + EPS)),
  );
  const contours = holes.map(h => h.vertices);
  const triangles = THREE.ShapeUtils.triangulateShape(outer, contours);
  const points = outer.concat(...contours);
  let polygons = triangles.map(tri => tri.map(i => points[i]));
  for (let i = 0; i < 4; i++) {
    const a = face[i], b = face[(i + 1) % 4];
    const normal = new THREE.Vector2(a.y - b.y, b.x - a.x).normalize();
    if (outer.some(p => p.clone().sub(a).dot(normal) < 0)) {
      polygons = polygons.map(p => clipPolygonByPlane(p, a, normal)).filter(p => p.length >= 3);
    }
  }
  return polygons;
}

function emitFace(
  b: MeshBuffers,
  row: WallRow,
  side: 'left' | 'right',
  ops: WallOpening[],
  along: (p: THREE.Vector2) => number,
  uOffset: number,
  yBase: number,
  key: string
): void {
  const left = side === 'left';
  const start = left ? row.startLeft : row.startRight;
  const end = left ? row.endLeft : row.endRight;
  const x0 = along(start), x1 = along(end);
  const faces = wallFacePolygons(x0, x1, row.y0, row.y1, ops);

  const tangent = end.clone().sub(start).normalize().multiplyScalar(left ? 1 : -1);
  b.beginGroup();
  for (const face of faces) {
    const first = b.vertexCount;
    for (const p of face) {
      const world = onEdge(start, end, x0, x1, p.x);
      b.positions.push(world.x, p.y, world.y);
      b.normals.push(-tangent.y, 0, tangent.x);
      b.uvs.push((left ? 1 : -1) * (p.x + uOffset), p.y - yBase);
    }
    for (let i = 1; i + 1 < face.length; i++) {
      if (left) b.indices.push(first, first + i, first + i + 1);
      else b.indices.push(first, first + i + 1, first + i);
    }
  }
  b.endGroup(key, 0, true);
}

/** Clip a contour edge to the portion of the opening inside this wall and height band. */
function emitReveals(b: MeshBuffers, row: WallRow, ops: WallOpening[], along: (p: THREE.Vector2) => number,
  halfW: number, wallBase: number, wallTop: number): void {
  const point = (a: THREE.Vector2, e: THREE.Vector2, p: THREE.Vector2) =>
    v3(onEdge(a, e, along(a), along(e), p.x), p.y);
  for (const op of ops) {
    const verts = op.outline.vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], e = verts[(i + 1) % verts.length];
      let lo = 0, hi = 1;
      for (const [start, delta, min, max] of [[a.x, e.x - a.x, -halfW, halfW], [a.y, e.y - a.y, row.y0, row.y1]]) {
        if (Math.abs(delta) < 1e-10) {
          if (start < min - EPS || start > max + EPS) hi = -1;
        } else {
          const t0 = (min - start) / delta, t1 = (max - start) / delta;
          lo = Math.max(lo, Math.min(t0, t1));
          hi = Math.min(hi, Math.max(t0, t1));
        }
      }
      if (hi <= lo) continue;
      if (Math.abs(a.y - e.y) < EPS && (a.y <= wallBase + EPS || a.y >= wallTop - EPS)) continue;
      const p = a.clone().lerp(e, lo), q = a.clone().lerp(e, hi);
      const u = p.distanceTo(q) / TRIM_TILE, v = WALL_THICKNESS / TRIM_TILE;
      b.quad(point(row.startLeft,row.endLeft,p), point(row.startLeft,row.endLeft,q),
        point(row.startRight,row.endRight,q), point(row.startRight,row.endRight,p), [0,0,u,0,u,v,0,v]);
    }
  }
}

/** Interval occupied by a convex opening at a wall end or horizontal edge. */
function sections(ops: WallOpening[], axis: 'x' | 'y', value: number) {
  const other = axis === 'x' ? 'y' : 'x';
  return ops.flatMap(({ outline }) => {
    const hits: number[] = [];
    const pts = outline.vertices;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (Math.abs(a[axis] - value) < EPS) hits.push(a[other]);
      if ((a[axis] < value) !== (b[axis] < value))
        hits.push(THREE.MathUtils.lerp(a[other], b[other], (value - a[axis]) / (b[axis] - a[axis])));
    }
    return hits.length ? [{ minX: Math.min(...hits), maxX: Math.max(...hits) }] : [];
  });
}

/** The solid parts of a wall's footprint at the height where it meets a floor. */
export function wallFootprintAtHeight(footprint: WallObstacle, seg: WallSeg, openings: WallOpening[], y: number): WallObstacle[] {
  const holes = sections(openings, 'y', y).filter(({ minX, maxX }) => maxX - minX > EPS);
  if (!holes.length) return [footprint];

  const origin = seg.p1.clone().addScaledVector(seg.dir, seg.halfW);
  const offset = seg.dir.dot(origin);
  const xs = footprint.vertices.map(p => seg.dir.dot(p) - offset);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const reverse = seg.dir.clone().negate();
  const pieces: WallObstacle[] = [];
  for (const [lo, hi] of solidIntervals(min, max, holes)) {
    let poly = footprint.vertices;
    if (lo > min + EPS) poly = clipPolygonByPlane(poly, origin.clone().addScaledVector(seg.dir, lo), seg.dir);
    if (hi < max - EPS) poly = clipPolygonByPlane(poly, origin.clone().addScaledVector(seg.dir, hi), reverse);
    if (poly === footprint.vertices) {
      pieces.push(footprint);
    } else {
      const vertices = poly.filter((p, i) => p.distanceToSquared(poly[(i + 1) % poly.length]) > EPS * EPS);
      if (vertices.length >= 3) pieces.push(convexObstacle(vertices, footprint.yBase, footprint.yTop));
    }
  }
  return pieces;
}

function emitCaps(b: MeshBuffers, row: WallRow, ops: WallOpening[], halfW: number): void {
  const cap = (a: THREE.Vector2, e: THREE.Vector2, x: number) => {
    for (const [lo, hi] of solidIntervals(row.y0, row.y1, sections(ops, 'x', x))) {
      const u = WALL_THICKNESS / TRIM_TILE, v = (hi-lo) / TRIM_TILE;
      b.quad(v3(a,lo), v3(e,lo), v3(e,hi), v3(a,hi), [0,0,u,0,u,v,0,v]);
    }
  };
  if (row.hasStartCap) cap(row.startRight,row.startLeft,-halfW);
  if (row.hasEndCap) cap(row.endLeft,row.endRight,halfW);
}

function emitEdge(b: MeshBuffers, row: WallRow, y: number, top: boolean, ops: WallOpening[],
  along: (p: THREE.Vector2) => number, covers: WallObstacle[] = []): void {
  const over = top ? coversAt(covers, y) : [];
  const holes = sections(ops, 'y', y);
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
