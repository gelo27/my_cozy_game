import * as THREE from 'three';
import { BuiltPiece, BuildingPieceType, PieceCategory, isFloorPiece, isFoundationPiece } from './types/BuildingTypes';
import { BUILDING_PIECES, FLOOR_THICKNESS, HALF_SIZE, MODULE_SIZE } from './config/BuildingPiecesConfig';
import { BUILDING_CONFIG } from '../config/constants';
import type { TKey } from '../i18n/en';

/**
 * Walls along the outline of a floor: every 2×2 tile joined to the seed (same level, same grid) is
 * collected, and each tile edge that faces the open outside gets one 2 m wall standing on the
 * edge line (holes enclosed by the floor — a courtyard, a stairwell — get none), the way a wall snaps onto a floor edge by hand. Edges that already hold a wall, window,
 * door or railing are left alone, so openings can be placed first and the rest filled in after.
 */

type Near = (center: THREE.Vector3, radius: number) => BuiltPiece[];

export interface OutlineWall {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export type FloorOutlineResult = { ok: true; walls: OutlineWall[]; tiles: number } | { ok: false; reason: TKey };

const MAX_TILES = 1500;
const GRID_EPS = 0.06;
const LEVEL_EPS = 0.05;

export const OUTLINE_WALL_TYPE = BuildingPieceType.WOOD_WALL_2X3;

/** Square 2×2 floor or foundation tiles */
export function isOutlineTile(type: BuildingPieceType): boolean {
  if (!isFloorPiece(type) && !isFoundationPiece(type)) return false;
  const d = BUILDING_PIECES[type]?.dimensions;
  return !!d && Math.abs(d.x - MODULE_SIZE) < 1e-3 && Math.abs(d.z - MODULE_SIZE) < 1e-3;
}

const tileTop = (p: BuiltPiece) => p.position.y + (BUILDING_PIECES[p.type]?.dimensions.y ?? FLOOR_THICKNESS) / 2;

/** Pieces that fill a wall slot on an edge */
function holdsEdge(type: BuildingPieceType): boolean {
  const c = BUILDING_PIECES[type]?.category;
  return c === PieceCategory.WALLS || c === PieceCategory.WINDOWS || c === PieceCategory.DOORS || c === PieceCategory.RAILINGS;
}

export function planFloorOutlineWalls(seed: BuiltPiece, near: Near): FloorOutlineResult {
  if (!isOutlineTile(seed.type)) return { ok: false, reason: 'build.floorWalls.noFloor' };

  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(seed.quaternion).setY(0).normalize();
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(seed.quaternion).setY(0).normalize();
  const top = tileTop(seed);
  const origin = seed.position.clone();

  // Grid cell of a tile in the seed's frame, or null when it is off this grid / level
  const cellOf = (p: BuiltPiece): [number, number] | null => {
    if (!isOutlineTile(p.type) || Math.abs(tileTop(p) - top) > LEVEL_EPS) return null;
    const pr = new THREE.Vector3(1, 0, 0).applyQuaternion(p.quaternion);
    if (Math.abs(Math.abs(pr.dot(right)) - 1) > 1e-3 && Math.abs(Math.abs(pr.dot(fwd)) - 1) > 1e-3) return null;
    const d = p.position.clone().sub(origin);
    const u = d.dot(right) / MODULE_SIZE, v = d.dot(fwd) / MODULE_SIZE;
    const iu = Math.round(u), iv = Math.round(v);
    if (Math.abs(u - iu) * MODULE_SIZE > GRID_EPS || Math.abs(v - iv) * MODULE_SIZE > GRID_EPS) return null;
    return [iu, iv];
  };

  // 1. Tiles joined edge to edge
  const key = (u: number, v: number) => `${u},${v}`;
  const cells = new Set<string>([key(0, 0)]);
  const queue: Array<[number, number]> = [[0, 0]];
  while (queue.length > 0 && cells.size < MAX_TILES) {
    const [u, v] = queue.pop()!;
    const c = origin.clone().addScaledVector(right, u * MODULE_SIZE).addScaledVector(fwd, v * MODULE_SIZE);
    for (const p of near(c, MODULE_SIZE + 0.5)) {
      const cell = cellOf(p);
      if (!cell) continue;
      const [pu, pv] = cell;
      if (Math.abs(pu - u) + Math.abs(pv - v) !== 1 || cells.has(key(pu, pv))) continue;
      cells.add(key(pu, pv));
      queue.push([pu, pv]);
    }
  }

  // 2. Wall height, as when a wall snaps onto this floor's edge by hand
  const halfH = BUILDING_PIECES[OUTLINE_WALL_TYPE].dimensions.y / 2;
  const onGround = seed.position.y <= BUILDING_CONFIG.GROUND_SURFACE_Y + 0.35;
  const wallY = (onGround ? BUILDING_CONFIG.GROUND_SURFACE_Y : top) + halfH;
  const rot90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const qAlongX = seed.quaternion.clone();
  const qAlongZ = seed.quaternion.clone().multiply(rot90);

  // 3. Empty cells reachable from beyond the floor's bounds: the outside. Empty cells the floor
  // closes in (holes) are not, so their edges stay open.
  const sides: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const k of cells) {
    const [u, v] = k.split(',').map(Number);
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  minU--; maxU++; minV--; maxV++;
  const outside = new Set<string>([key(minU, minV)]);
  const fill: Array<[number, number]> = [[minU, minV]];
  while (fill.length > 0) {
    const [u, v] = fill.pop()!;
    for (const [du, dv] of sides) {
      const nu = u + du, nv = v + dv, nk = key(nu, nv);
      if (nu < minU || nu > maxU || nv < minV || nv > maxV || cells.has(nk) || outside.has(nk)) continue;
      outside.add(nk);
      fill.push([nu, nv]);
    }
  }

  // 4. Outer edges: the outside on the other side
  const walls: OutlineWall[] = [];
  for (const k of cells) {
    const [u, v] = k.split(',').map(Number);
    const c = origin.clone().addScaledVector(right, u * MODULE_SIZE).addScaledVector(fwd, v * MODULE_SIZE);
    for (const [du, dv] of sides) {
      if (!outside.has(key(u + du, v + dv))) continue;
      const position = c.clone().addScaledVector(right, du * HALF_SIZE).addScaledVector(fwd, dv * HALF_SIZE).setY(wallY);
      if (edgeTaken(position, halfH, near)) continue;
      walls.push({ position, quaternion: (du === 0 ? qAlongX : qAlongZ).clone() });
    }
  }
  return { ok: true, walls, tiles: cells.size };
}

const _inv = new THREE.Quaternion();
const _local = new THREE.Vector3();

/** Something wall-like already stands on the edge whose middle is pos */
function edgeTaken(pos: THREE.Vector3, halfH: number, near: Near): boolean {
  for (const p of near(pos, 2.5)) {
    if (!holdsEdge(p.type)) continue;
    const d = BUILDING_PIECES[p.type]?.dimensions;
    if (!d) continue;
    _local.copy(pos).sub(p.position).applyQuaternion(_inv.copy(p.quaternion).invert());
    // On the same line, covering the middle of the edge, overlapping in height
    if (Math.abs(_local.z) < 0.3 && Math.abs(_local.x) < d.x / 2 - 0.05 && Math.abs(_local.y) < halfH + d.y / 2 - 0.1) return true;
  }
  return false;
}
