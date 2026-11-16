import * as THREE from 'three';
import { BuiltPiece, BuildingPieceType, PieceCategory, isSolidWallPiece } from './types/BuildingTypes';
import { BUILDING_PIECES, FLOOR_THICKNESS, HALF_SIZE, MODULE_SIZE } from './config/BuildingPiecesConfig';
import { describeWallSeg } from './continuous/WallJoints';
import { findHouseOutline } from './HouseOutline';
import { isOutlineTile, planFloorOutlineWalls, outlineWallType } from './FloorOutlineWalls';
import type { TKey } from '../i18n/en';

/**
 * Fill along an outline, started from one piece:
 * - a wall fills walls along the outline of the floor it stands on;
 * - a tile lying on the wall tops (a ceiling) fills the ceiling over the whole walled outline;
 * - any other 2×2 floor tile fills walls along its own outline.
 */

type Near = (center: THREE.Vector3, radius: number) => BuiltPiece[];

export type OutlineFillKind = 'walls' | 'ceiling';

export interface CeilingTile {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export type CeilingPlan = { ok: true; tiles: CeilingTile[] } | { ok: false; reason: TKey };

const tileTop = (p: BuiltPiece) => p.position.y + (BUILDING_PIECES[p.type]?.dimensions.y ?? FLOOR_THICKNESS) / 2;
const LEVEL_EPS = 0.15;

/** The floor tile whose edge a wall stands on */
export function floorTileUnderWall(wall: BuiltPiece, near: Near): BuiltPiece | null {
  if (!isSolidWallPiece(wall.type)) return null;
  const seg = describeWallSeg(wall);
  const mid = new THREE.Vector3((seg.p1.x + seg.p2.x) / 2, seg.yBase, (seg.p1.y + seg.p2.y) / 2);
  for (const p of near(mid, MODULE_SIZE)) {
    if (!isOutlineTile(p.type)) continue;
    // Ground floors sit a little above the ground the wall stands on
    if (Math.abs(tileTop(p) - seg.yBase) > 0.2) continue;
    const d = new THREE.Vector2(p.position.x - mid.x, p.position.z - mid.z);
    if (Math.abs(Math.abs(d.dot(seg.left)) - HALF_SIZE) > 0.1 || Math.abs(d.dot(seg.dir)) > seg.halfW) continue;
    return p;
  }
  return null;
}

/** A wall the tile lies on, with its top level with the tile's top */
function wallUnderTile(tile: BuiltPiece, near: Near): BuiltPiece | null {
  const top = tileTop(tile);
  for (const p of near(tile.position, MODULE_SIZE + 0.5)) {
    if (!isSolidWallPiece(p.type)) continue;
    const seg = describeWallSeg(p);
    if (Math.abs(seg.yTop - top) > LEVEL_EPS) continue;
    // The wall runs along one of the tile's edges
    const d = new THREE.Vector2(tile.position.x, tile.position.z).sub(seg.p1);
    const along = d.dot(seg.dir);
    if (Math.abs(Math.abs(d.dot(seg.left)) - HALF_SIZE) > 0.1 || along < -0.1 || along > seg.halfW * 2 + 0.1) continue;
    return p;
  }
  return null;
}

/** Ceiling tiles still missing inside the walled outline the tile lies on */
export function planCeiling(tile: BuiltPiece, near: Near): CeilingPlan {
  if (!isOutlineTile(tile.type)) return { ok: false, reason: 'build.fill.noPiece' };
  const wall = wallUnderTile(tile, near);
  if (!wall) return { ok: false, reason: 'build.fill.noWalls' };
  const found = findHouseOutline(wall, near, describeWallSeg(wall).yTop);
  if (found.ok === false) return { ok: false, reason: found.reason };
  const { origin, quaternion, footprint } = found.outline;

  const inv = quaternion.clone().invert();
  const toLocal = (w: THREE.Vector3) => w.clone().sub(origin).applyQuaternion(inv);
  const inside = (x: number, z: number) => {
    let c = false;
    for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i++) {
      const [xi, zi] = footprint[i], [xj, zj] = footprint[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };

  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(tile.quaternion).setY(0).normalize();
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(tile.quaternion).setY(0).normalize();
  // The tile grid must be square to the outline
  const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  if (Math.abs(Math.abs(right.dot(ax)) - 1) > 1e-3 && Math.abs(Math.abs(fwd.dot(ax)) - 1) > 1e-3) {
    return { ok: false, reason: 'build.houseRoof.notSquare' };
  }

  // Cells of the tile's grid covering the outline's bounds
  let reach = 0;
  for (const [x, z] of footprint) reach = Math.max(reach, Math.hypot(x, z));
  const c0 = toLocal(tile.position);
  const n = Math.ceil((reach + Math.hypot(c0.x, c0.z)) / MODULE_SIZE) + 1;
  const top = tileTop(tile);
  const tiles: CeilingTile[] = [];
  const probe: Array<[number, number]> = [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const c = tile.position.clone().addScaledVector(right, i * MODULE_SIZE).addScaledVector(fwd, j * MODULE_SIZE);
      // Whole cell inside the outline: centre, corners and edge middles
      const ok = probe.every(([a, b]) => {
        const l = toLocal(c.clone().addScaledVector(right, a * (HALF_SIZE - 0.05)).addScaledVector(fwd, b * (HALF_SIZE - 0.05)));
        return inside(l.x, l.z);
      });
      if (!ok || cellTaken(c, top, near)) continue;
      tiles.push({ position: c, quaternion: tile.quaternion.clone() });
    }
  }
  return { ok: true, tiles };
}

/** A floor tile is already there, or stairs come up through this cell */
function cellTaken(c: THREE.Vector3, top: number, near: Near): boolean {
  for (const p of near(c, MODULE_SIZE)) {
    const def = BUILDING_PIECES[p.type];
    if (!def) continue;
    const dx = Math.abs(p.position.x - c.x), dz = Math.abs(p.position.z - c.z);
    if (isOutlineTile(p.type) || def.category === PieceCategory.FLOORS) {
      if (dx < HALF_SIZE - 0.05 && dz < HALF_SIZE - 0.05 && Math.abs(tileTop(p) - top) < 0.3) return true;
    } else if (def.category === PieceCategory.STAIRS) {
      const stairTop = p.position.y + def.dimensions.y / 2;
      if (stairTop > top - 0.6 && p.position.y - def.dimensions.y / 2 < top && dx < HALF_SIZE + 0.4 && dz < HALF_SIZE + 0.4) return true;
    }
  }
  return false;
}

/** What a fill started from this piece would do, or null when there is nothing to fill */
export function outlineFillKind(piece: BuiltPiece, near: Near): OutlineFillKind | null {
  if (isSolidWallPiece(piece.type)) {
    const tile = floorTileUnderWall(piece, near);
    if (!tile) return null;
    const plan = planFloorOutlineWalls(tile, near, outlineWallType(piece.type));
    return plan.ok && plan.walls.length > 0 ? 'walls' : null;
  }
  if (!isOutlineTile(piece.type)) return null;
  if (wallUnderTile(piece, near)) {
    const plan = planCeiling(piece, near);
    if (plan.ok && plan.tiles.length > 0) return 'ceiling';
  }
  const walls = planFloorOutlineWalls(piece, near);
  return walls.ok && walls.walls.length > 0 ? 'walls' : null;
}

export const CEILING_TILE_TYPE = BuildingPieceType.WOOD_FLOOR_2X2;
