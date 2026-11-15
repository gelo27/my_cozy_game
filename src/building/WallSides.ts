import * as THREE from 'three';
import { BuiltPiece, getWallHalfHeight, getWallHalfWidth, isFloorPiece, isFoundationPiece, isSolidWallPiece } from './types/BuildingTypes';
import { describeWallSeg, wallSegsTouch, WallSeg } from './continuous/WallJoints';

/**
 * Decides which side of each solid wall faces outdoors, from the layout of the building rather than
 * the piece's rotation (a wall turned with the orange corner arrow can end up facing either way).
 *
 * The +Z face ("left" in the wall solver and painting) is outer by default. A wall is "flipped" when
 * its +Z face points indoors instead:
 *  1. a floor or foundation on exactly one side of the wall marks that side as indoors;
 *  2. otherwise the side towards the middle of the walls it is connected to is indoors;
 *  3. otherwise (a lone wall, or no clear answer) the rotation decides, as before.
 */

/** Distance from the wall centre line at which floors are probed on each side */
const FLOOR_PROBE_OFFSET = 0.6;
/** How far a floor's top may sit from the wall's bottom and still count as the floor it stands on */
const FLOOR_LEVEL_TOLERANCE = 0.35;
/** The cluster centre must be at least this far off the wall plane to decide a side */
const CENTROID_MIN_OFFSET = 0.15;

interface WallInfo {
  piece: BuiltPiece;
  center: THREE.Vector3;
  /** +Z face normal in the XZ plane */
  normal: THREE.Vector3;
  /** Centre line, as the wall mesh joins it (same corner and T-junction rules) */
  seg: WallSeg;
  length: number;
  bottomY: number;
}

function describeWall(piece: BuiltPiece): WallInfo {
  const halfW = getWallHalfWidth(piece.type);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion);
  normal.y = 0;
  normal.normalize();
  const c = piece.position;
  return {
    piece,
    center: c.clone(),
    normal,
    seg: describeWallSeg(piece),
    length: halfW * 2,
    bottomY: c.y - getWallHalfHeight(piece.type),
  };
}

function touches(a: WallInfo, b: WallInfo): boolean {
  if (Math.abs(a.center.y - b.center.y) > 4) return false; // different storeys of unrelated buildings
  return wallSegsTouch(a.seg, b.seg);
}

/** Whether a floor or foundation covers the XZ point at about the level the wall stands on. */
function hasFloorAt(
  x: number,
  z: number,
  level: number,
  queryNearby: (center: THREE.Vector3, radius: number) => BuiltPiece[]
): boolean {
  const probe = new THREE.Vector3(x, level, z);
  for (const p of queryNearby(probe, 3)) {
    if (!isFloorPiece(p.type) && !isFoundationPiece(p.type)) continue;
    const box = p.worldBoundingBox;
    if (!box) continue;
    if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue;
    if (Math.abs(box.max.y - level) <= FLOOR_LEVEL_TOLERANCE) return true;
  }
  return false;
}

/** Ids of solid walls whose +Z face points indoors. */
export function computeFlippedWalls(
  pieces: BuiltPiece[],
  queryNearby: (center: THREE.Vector3, radius: number) => BuiltPiece[]
): Set<string> {
  const walls = pieces.filter((p) => isSolidWallPiece(p.type)).map(describeWall);
  const flipped = new Set<string>();
  if (walls.length === 0) return flipped;

  // Group connected walls (union-find)
  const parent = walls.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      if (touches(walls[i], walls[j])) parent[find(i)] = find(j);
    }
  }
  const centroids = new Map<number, { sum: THREE.Vector2; weight: number }>();
  walls.forEach((w, i) => {
    const root = find(i);
    const entry = centroids.get(root) ?? { sum: new THREE.Vector2(), weight: 0 };
    entry.sum.add(new THREE.Vector2(w.center.x, w.center.z).multiplyScalar(w.length));
    entry.weight += w.length;
    centroids.set(root, entry);
  });

  walls.forEach((w, i) => {
    // 1. Floors on one side only
    const outX = w.center.x + w.normal.x * FLOOR_PROBE_OFFSET;
    const outZ = w.center.z + w.normal.z * FLOOR_PROBE_OFFSET;
    const inX = w.center.x - w.normal.x * FLOOR_PROBE_OFFSET;
    const inZ = w.center.z - w.normal.z * FLOOR_PROBE_OFFSET;
    const floorOnPlusZ = hasFloorAt(outX, outZ, w.bottomY, queryNearby);
    const floorOnMinusZ = hasFloorAt(inX, inZ, w.bottomY, queryNearby);
    if (floorOnPlusZ !== floorOnMinusZ) {
      if (floorOnPlusZ) flipped.add(w.piece.id);
      return;
    }

    // 2. Towards the middle of the connected walls
    const entry = centroids.get(find(i))!;
    const cx = entry.sum.x / entry.weight;
    const cz = entry.sum.y / entry.weight;
    const offset = (cx - w.center.x) * w.normal.x + (cz - w.center.z) * w.normal.z;
    if (offset > CENTROID_MIN_OFFSET) flipped.add(w.piece.id);
    // 3. Otherwise keep the rotation's default (+Z outer)
  });
  return flipped;
}
