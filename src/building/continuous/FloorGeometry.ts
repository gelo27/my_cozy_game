import * as THREE from 'three';
import { BuiltPiece, BuildingPieceType } from '../types/BuildingTypes';
import { FLOOR_THICKNESS, MODULE_SIZE } from '../config/BuildingConstants';
import { MeshBuffers } from './MeshBuffers';

/**
 * Emits merged wood floors: each slab in 0.5 m cells, with the parts under walls cut away (no
 * z-fighting with the wall bottoms, edges flush with wall faces and mitred corners) and side faces
 * only on exposed edges. Top and bottom (ceiling) faces are keyed `pieceId:top` / `pieceId:bottom`.
 */

/** Floor checker tile size, m */
const CHECKER_TILE_SIZE = 0.5;
const CELL = 0.5;

/** A wall's footprint, as a convex polygon, standing from yBase to yTop */
export interface WallObstacle {
  vertices: THREE.Vector2[];
  planes: Array<{ point: THREE.Vector2; normal: THREE.Vector2 }>;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  yBase: number;
  yTop: number;
}

export function createWallObstacle(
  startLeft: THREE.Vector2,
  startRight: THREE.Vector2,
  endLeft: THREE.Vector2,
  endRight: THREE.Vector2,
  yBase: number,
  yTop: number
): WallObstacle {
  let verts = [
    startRight.clone(),
    endRight.clone(),
    endLeft.clone(),
    startLeft.clone(),
  ];

  let area = 0;
  for (let i = 0; i < verts.length; i++) {
    const next = (i + 1) % verts.length;
    area += verts[i].x * verts[next].y - verts[next].x * verts[i].y;
  }
  if (area < 0) {
    verts.reverse();
  }

  const planes: Array<{ point: THREE.Vector2; normal: THREE.Vector2 }> = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < verts.length; i++) {
    const pA = verts[i];
    const pB = verts[(i + 1) % verts.length];

    if (pA.x < minX) minX = pA.x;
    if (pA.x > maxX) maxX = pA.x;
    if (pA.y < minZ) minZ = pA.y;
    if (pA.y > maxZ) maxZ = pA.y;

    const edge = pB.clone().sub(pA);
    const norm = new THREE.Vector2(edge.y, -edge.x).normalize();
    planes.push({ point: pA.clone(), normal: norm });
  }

  return {
    vertices: verts,
    planes,
    minX,
    maxX,
    minZ,
    maxZ,
    yBase,
    yTop,
  };
}

function clipPolygonByPlane(
  polygon: THREE.Vector2[],
  pointOnPlane: THREE.Vector2,
  keepNormal: THREE.Vector2
): THREE.Vector2[] {
  if (polygon.length === 0) return [];
  const output: THREE.Vector2[] = [];

  const isInside = (p: THREE.Vector2) => {
    return (p.x - pointOnPlane.x) * keepNormal.x + (p.y - pointOnPlane.y) * keepNormal.y >= -1e-5;
  };

  const lineIntersection = (p1: THREE.Vector2, p2: THREE.Vector2): THREE.Vector2 => {
    const d1 = (p1.x - pointOnPlane.x) * keepNormal.x + (p1.y - pointOnPlane.y) * keepNormal.y;
    const d2 = (p2.x - pointOnPlane.x) * keepNormal.x + (p2.y - pointOnPlane.y) * keepNormal.y;
    const denom = d1 - d2;
    if (Math.abs(denom) < 1e-7) return p1.clone();
    const t = Math.max(0, Math.min(1, d1 / denom));
    return new THREE.Vector2(
      p1.x + t * (p2.x - p1.x),
      p1.y + t * (p2.y - p1.y)
    );
  };

  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const prev = polygon[(i - 1 + polygon.length) % polygon.length];

    const currentIn = isInside(current);
    const prevIn = isInside(prev);

    if (currentIn) {
      if (!prevIn) {
        output.push(lineIntersection(prev, current));
      }
      output.push(current);
    } else if (prevIn) {
      output.push(lineIntersection(prev, current));
    }
  }

  return output;
}

export function subtractConvexPolygon(
  poly: THREE.Vector2[],
  obstacle: WallObstacle
): THREE.Vector2[][] {
  if (poly.length < 3) return [];

  // 1. Broadphase bounding box check
  let pMinX = Infinity;
  let pMaxX = -Infinity;
  let pMinZ = Infinity;
  let pMaxZ = -Infinity;
  for (const p of poly) {
    if (p.x < pMinX) pMinX = p.x;
    if (p.x > pMaxX) pMaxX = p.x;
    if (p.y < pMinZ) pMinZ = p.y;
    if (p.y > pMaxZ) pMaxZ = p.y;
  }

  if (
    pMaxX < obstacle.minX - 0.001 ||
    pMinX > obstacle.maxX + 0.001 ||
    pMaxZ < obstacle.minZ - 0.001 ||
    pMinZ > obstacle.maxZ + 0.001
  ) {
    return [poly];
  }

  // 2. Check if poly is completely outside any separating edge plane of the convex wall
  for (const pl of obstacle.planes) {
    const allOutside = poly.every(
      (p) => (p.x - pl.point.x) * pl.normal.x + (p.y - pl.point.y) * pl.normal.y >= -1e-5
    );
    if (allOutside) {
      return [poly];
    }
  }

  // 3. Exact CSG difference of convex polygons:
  // Peel off the parts of poly that lie outside each edge of the obstacle.
  const resultingPieces: THREE.Vector2[][] = [];
  let remainingInside: THREE.Vector2[] = poly;

  for (const pl of obstacle.planes) {
    if (remainingInside.length < 3) break;

    // Piece outside this edge plane (normal points outward)
    const outsidePiece = clipPolygonByPlane(remainingInside, pl.point, pl.normal);
    if (outsidePiece.length >= 3) {
      let pieceArea = 0;
      for (let k = 0; k < outsidePiece.length; k++) {
        const nextK = (k + 1) % outsidePiece.length;
        pieceArea += outsidePiece[k].x * outsidePiece[nextK].y - outsidePiece[nextK].x * outsidePiece[k].y;
      }
      if (Math.abs(pieceArea) * 0.5 > 1e-5) {
        resultingPieces.push(outsidePiece);
      }
    }

    // Remaining part inside this edge plane (pointing inward, -normal)
    const inwardNormal = pl.normal.clone().negate();
    remainingInside = clipPolygonByPlane(remainingInside, pl.point, inwardNormal);
  }

  // The final remainingInside is the portion completely engulfed inside the obstacle quad, so it is discarded.
  return resultingPieces;
}

function isPointInAnyFloor(
  pt: THREE.Vector2,
  floorY: number,
  allFloors: BuiltPiece[],
  wallObstacles: WallObstacle[]
): boolean {
  // Check if inside any wall obstacle at this Y level
  for (const w of wallObstacles) {
    if (floorY >= w.yBase - 0.05 && floorY <= w.yTop + 0.05) {
      if (
        pt.x >= w.minX - 0.001 &&
        pt.x <= w.maxX + 0.001 &&
        pt.y >= w.minZ - 0.001 &&
        pt.y <= w.maxZ + 0.001
      ) {
        const isInside = w.planes.every(
          (pl) => (pt.x - pl.point.x) * pl.normal.x + (pt.y - pl.point.y) * pl.normal.y <= 1e-4
        );
        if (isInside) {
          return false; // Inside a wall -> not an interior floor seam
        }
      }
    }
  }

  // Check if inside any floor piece bounds at this Y level
  for (const f of allFloors) {
    if (Math.abs(f.position.y - floorY) > 0.05) continue;
    const is1x1 = f.type === BuildingPieceType.WOOD_FLOOR_1X1;
    const hw = is1x1 ? 0.5 : MODULE_SIZE / 2.0;
    const hl = is1x1 ? 0.5 : MODULE_SIZE / 2.0;

    const floorRight = new THREE.Vector3(1, 0, 0).applyQuaternion(f.quaternion);
    const floorForward = new THREE.Vector3(0, 0, 1).applyQuaternion(f.quaternion);
    const fR = new THREE.Vector2(floorRight.x, floorRight.z).normalize();
    const fF = new THREE.Vector2(floorForward.x, floorForward.z).normalize();

    const d = pt.clone().sub(new THREE.Vector2(f.position.x, f.position.z));
    const lx = d.dot(fR);
    const lz = d.dot(fF);

    if (Math.abs(lx) <= hw - 0.002 && Math.abs(lz) <= hl - 0.002) {
      return true;
    }
  }
  return false;
}

/** Footprint of a wall-like piece without solving its corners: its plain box. */
export function boxObstacle(piece: BuiltPiece, width: number, height: number, thickness: number): WallObstacle {
  const t = new THREE.Vector3(1, 0, 0).applyQuaternion(piece.quaternion);
  const dir = new THREE.Vector2(t.x, t.z).normalize();
  const left = new THREE.Vector2(-dir.y, dir.x);
  const c = new THREE.Vector2(piece.position.x, piece.position.z);
  const hw = width / 2;
  const ht = thickness / 2;
  const at = (a: number, b: number) => c.clone().addScaledVector(dir, a).addScaledVector(left, b);
  return createWallObstacle(at(-hw, ht), at(-hw, -ht), at(hw, ht), at(hw, -ht), piece.position.y - height / 2, piece.position.y + height / 2);
}

/** How far (m) a wall top may sit above a slab's top and still count as covered by it */
const COVER_TOLERANCE = 0.005;

/** True when the top of `wall` ends inside the slab running from `yBase` to `yTop` (the slab lies over it) */
export function slabCoversWallTop(yBase: number, yTop: number, wallTop: number): boolean {
  return wallTop > yBase + COVER_TOLERANCE && wallTop <= yTop + COVER_TOLERANCE;
}

/** Footprint of floor slab `piece`, standing from its bottom to its top */
export function floorObstacle(piece: BuiltPiece): WallObstacle {
  const is1x1 = piece.type === BuildingPieceType.WOOD_FLOOR_1X1;
  const half = is1x1 ? 0.5 : MODULE_SIZE / 2;
  const size = half * 2;
  return boxObstacle(piece, size, FLOOR_THICKNESS, size);
}

/** Pieces of convex polygon `poly` left outside every obstacle, counter-clockwise in (x, z) */
export function subtractObstacles(poly: THREE.Vector2[], obstacles: WallObstacle[]): THREE.Vector2[][] {
  let current: THREE.Vector2[][] = [ccw(poly)];
  for (const o of obstacles) {
    if (current.length === 0) break;
    const next: THREE.Vector2[][] = [];
    for (const p of current) for (const d of subtractConvexPolygon(p, o)) next.push(d);
    current = next;
  }
  return current.filter((p) => p.length >= 3 && Math.abs(signedArea(p)) >= 1e-4);
}

function signedArea(poly: THREE.Vector2[]): number {
  let area = 0;
  for (let k = 0; k < poly.length; k++) {
    const n = poly[(k + 1) % poly.length];
    area += poly[k].x * n.y - n.x * poly[k].y;
  }
  return area * 0.5;
}

function ccw(poly: THREE.Vector2[]): THREE.Vector2[] {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

function insideObstacle(pt: THREE.Vector2, w: WallObstacle): boolean {
  if (pt.x < w.minX - 0.001 || pt.x > w.maxX + 0.001 || pt.y < w.minZ - 0.001 || pt.y > w.maxZ + 0.001) return false;
  return w.planes.every((pl) => (pt.x - pl.point.x) * pl.normal.x + (pt.y - pl.point.y) * pl.normal.y <= 1e-4);
}

export interface FloorStyleIndex {
  /** Material index of the slab's side edges */
  edge: number;
  faceKey: (pieceId: string, side: 'top' | 'bottom') => string;
}

/**
 * Emits floor slab `piece`. `neighbourFloors` are the floors around it (to tell inner seams from
 * exposed edges) and `walls` the wall footprints that may cut it.
 */
export function emitFloor(b: MeshBuffers, piece: BuiltPiece, neighbourFloors: BuiltPiece[], walls: WallObstacle[], style: FloorStyleIndex): void {
  const is1x1 = piece.type === BuildingPieceType.WOOD_FLOOR_1X1;
  const half = is1x1 ? 0.5 : MODULE_SIZE / 2;
  const cells = Math.round((half * 2) / CELL);
  const halfH = FLOOR_THICKNESS / 2;
  const yBase = piece.position.y - halfH;
  const yTop = piece.position.y + halfH;

  // Walls standing in the slab cut its underside (the ceiling stops at the wall faces). Walls that
  // end inside it (their top flush with the slab's top: the storey below) are covered by the slab's
  // top, so the floor of the storey above runs on over them; only walls rising through it cut the top.
  const cutting = walls.filter((w) => yTop > w.yBase + 0.005 && yBase < w.yTop - 0.005);
  const rising = cutting.filter((w) => !slabCoversWallTop(yBase, yTop, w.yTop));
  const covered = cutting.filter((w) => slabCoversWallTop(yBase, yTop, w.yTop));
  const r3 = new THREE.Vector3(1, 0, 0).applyQuaternion(piece.quaternion);
  const f3 = new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion);
  const fR = new THREE.Vector2(r3.x, r3.z).normalize();
  const fF = new THREE.Vector2(f3.x, f3.z).normalize();
  const c = new THREE.Vector2(piece.position.x, piece.position.z);
  const at = (lx: number, lz: number) => c.clone().addScaledVector(fR, lx).addScaledVector(fF, lz);

  const topPolys: THREE.Vector2[][] = [];
  const bottomPolys: THREE.Vector2[][] = [];
  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const lx0 = -half + ix * CELL, lx1 = lx0 + CELL;
      const lz0 = -half + iz * CELL, lz1 = lz0 + CELL;
      const cell = [at(lx0, lz0), at(lx1, lz0), at(lx1, lz1), at(lx0, lz1)];
      const top = subtractObstacles(cell, rising);
      topPolys.push(...top);
      if (covered.length === 0) bottomPolys.push(...top);
      else for (const poly of top) bottomPolys.push(...subtractObstacles(poly, covered));
    }
  }

  b.beginGroup();
  for (const poly of topPolys) b.polygon(poly, yTop, true, CHECKER_TILE_SIZE);
  b.endGroup(style.faceKey(piece.id, 'top'), 0);

  b.beginGroup();
  for (const poly of bottomPolys) b.polygon(poly, yBase, false, CHECKER_TILE_SIZE);
  b.endGroup(style.faceKey(piece.id, 'bottom'), 0);

  // Side faces only on exposed edges (not against another slab, not inside a wall). Edges over a
  // covered wall stay out: the wall below already closes the slab there.
  const polys = topPolys;
  b.beginGroup();
  for (const poly of polys) {
    for (let k = 0; k < poly.length; k++) {
      const pA = poly[k];
      const pB = poly[(k + 1) % poly.length];
      const edge = pB.clone().sub(pA);
      const len = edge.length();
      if (len < 1e-4) continue;
      const n = new THREE.Vector2(edge.y, -edge.x).normalize();
      const probe = pA.clone().add(pB).multiplyScalar(0.5).addScaledVector(n, 0.02);
      if (isPointInAnyFloor(probe, piece.position.y, neighbourFloors, walls)) continue;
      if (covered.some((w) => insideObstacle(probe, w))) continue;
      const v = FLOOR_THICKNESS / CHECKER_TILE_SIZE;
      const u = len / CHECKER_TILE_SIZE;
      b.quad(
        new THREE.Vector3(pA.x, yBase, pA.y),
        new THREE.Vector3(pA.x, yTop, pA.y),
        new THREE.Vector3(pB.x, yTop, pB.y),
        new THREE.Vector3(pB.x, yBase, pB.y),
        [0, 0, 0, v, u, v, u, 0],
        new THREE.Vector3(n.x, 0, n.y)
      );
    }
  }
  b.endGroup(null, style.edge);
}
