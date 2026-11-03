import * as THREE from 'three';
import { BuiltPiece, BuildingPieceType, isDoorPiece, isDoorwayPiece } from './types/BuildingTypes';
import { BUILDING_MATERIALS, WALL_THICKNESS, FLOOR_THICKNESS, MODULE_SIZE } from './config/BuildingPiecesConfig';
import type { WallPaintingSystem } from './WallPaintingSystem';

export interface WallNode {
  key: string;
  pos: THREE.Vector3;
  connections: Array<{
    pieceId: string;
    dir: THREE.Vector2; // unit horizontal direction away from this node
    isStart: boolean;
  }>;
}

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

export interface SolvedRowCorner {
  startLeft: THREE.Vector2;
  startRight: THREE.Vector2;
  endLeft: THREE.Vector2;
  endRight: THREE.Vector2;
  y0: number;
  y1: number;
  hasStartCap: boolean;
  hasEndCap: boolean;
}

export interface SolvedSegmentData {
  pieceId: string;
  piece: BuiltPiece;
  yBase: number;
  yTop: number;
  numColsL: number;
  numColsR: number;
  numRows: number;
  rows: SolvedRowCorner[];
  summary: SolvedSegmentCorners;
}

const CHECKER_TILE_SIZE = 0.5; // 0.5m per checker tile pair (25cm per square)
const WALL_UV_TILE_WIDTH = MODULE_SIZE; // one wallpaper texture repeat spans a standard 2m wall module
const STONE_TILE_SIZE = 1.0; // 1.0m per stone block pair

interface WallObstacle {
  pieceId: string;
  vertices: THREE.Vector2[];
  planes: Array<{ point: THREE.Vector2; normal: THREE.Vector2 }>;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  yBase: number;
  yTop: number;
}

function createWallObstacle(
  pieceId: string,
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
    pieceId,
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

function subtractConvexPolygon(
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

/**
 * ContinuousWallSystem (Unified Continuous Mesh & Regeneration Engine)
 * Manages procedural mesh regeneration for:
 * 1. Continuous Seamless Walls & Windows (with corner miters and checker pattern)
 * 2. Continuous Seamless Floors (with parquet checker pattern and perimeter edges)
 * 3. Continuous Seamless Stone Foundations (with granite masonry pattern and perimeter edges)
 */
interface SolidSubInterval {
  minX: number;
  maxX: number;
}

function getSolidSubIntervals(
  cMin: number,
  cMax: number,
  openings: Array<{ minX: number; maxX: number }>
): SolidSubInterval[] {
  let solids: SolidSubInterval[] = [{ minX: cMin, maxX: cMax }];

  for (const op of openings) {
    const nextSolids: SolidSubInterval[] = [];
    for (const sol of solids) {
      if (op.maxX <= sol.minX + 1e-4 || op.minX >= sol.maxX - 1e-4) {
        nextSolids.push(sol);
      } else {
        if (op.minX > sol.minX + 1e-4) {
          nextSolids.push({ minX: sol.minX, maxX: op.minX });
        }
        if (op.maxX < sol.maxX - 1e-4) {
          nextSolids.push({ minX: op.maxX, maxX: sol.maxX });
        }
      }
    }
    solids = nextSolids;
  }

  return solids;
}

export class ContinuousWallSystem {
  private continuousWallMesh: THREE.Mesh | null = null;
  private continuousFloorMesh: THREE.Mesh | null = null;
  private continuousFoundationMesh: THREE.Mesh | null = null;

  public wallPaintingSystem: WallPaintingSystem | null = null;
  public lastSolvedCorners: Map<string, SolvedSegmentCorners> = new Map();
  public lastWallPieces: Map<string, BuiltPiece> = new Map();

  private unconfirmedWallPieceIds: Set<string> = new Set();
  private unconfirmedFloorPieceIds: Set<string> = new Set();
  private unconfirmedFoundationPieceIds: Set<string> = new Set();

  private sceneGroup: THREE.Group;

  constructor(sceneGroup: THREE.Group, wallPaintingSystem?: WallPaintingSystem) {
    this.sceneGroup = sceneGroup;
    this.wallPaintingSystem = wallPaintingSystem || null;
  }

  public setPaintingSystem(sys: WallPaintingSystem): void {
    this.wallPaintingSystem = sys;
  }

  public getContinuousWallMesh(): THREE.Mesh | null {
    return this.continuousWallMesh;
  }

  public getContinuousFloorMesh(): THREE.Mesh | null {
    return this.continuousFloorMesh;
  }

  public getLastSolvedCorners(): Map<string, SolvedSegmentCorners> {
    return this.lastSolvedCorners;
  }

  public isSolidWallPiece(type: BuildingPieceType): boolean {
    return (
      type === BuildingPieceType.WOOD_WALL_2X3 ||
      type === BuildingPieceType.WOOD_WALL_1X3 ||
      type === BuildingPieceType.WOOD_WALL_2X1 ||
      type === BuildingPieceType.WOOD_WALL_1X2 ||
      type === BuildingPieceType.WOOD_WALL_1X1
    );
  }

  public isWindowPiece(type: BuildingPieceType): boolean {
    return (
      type === BuildingPieceType.WOOD_WALL_WINDOW_2X2 ||
      type === BuildingPieceType.WOOD_WALL_WINDOW_1X2 ||
      type === BuildingPieceType.WOOD_WALL_WINDOW_1X1_5 ||
      type === BuildingPieceType.WOOD_WALL_WINDOW_2X4
    );
  }

  public isDoorPiece(type: BuildingPieceType): boolean {
    return (
      type === BuildingPieceType.WOOD_DOOR_SINGLE ||
      type === BuildingPieceType.WOOD_DOOR_DOUBLE ||
      type === BuildingPieceType.DOOR_GRAND_SIDELITES_2X2 ||
      type === BuildingPieceType.DOOR_WHITE_2PANEL_1X2 ||
      type === BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2 ||
      type === BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2
    );
  }

  public isDoorwayPiece(type: BuildingPieceType): boolean {
    return (
      type === BuildingPieceType.WOOD_WALL_DOORWAY_2X2 ||
      type === BuildingPieceType.WOOD_WALL_DOORWAY_1X2
    );
  }

  public isOpeningPiece(type: BuildingPieceType): boolean {
    return this.isWindowPiece(type) || this.isDoorPiece(type) || this.isDoorwayPiece(type);
  }

  public getPieceWidth(type: BuildingPieceType): number {
    if (
      type === BuildingPieceType.WOOD_WALL_1X3 ||
      type === BuildingPieceType.WOOD_WALL_1X2 ||
      type === BuildingPieceType.WOOD_WALL_1X1 ||
      type === BuildingPieceType.WOOD_WALL_WINDOW_1X2 ||
      type === BuildingPieceType.WOOD_WALL_WINDOW_1X1_5 ||
      type === BuildingPieceType.WOOD_WALL_DOORWAY_1X2 ||
      type === BuildingPieceType.WOOD_DOOR_SINGLE ||
      type === BuildingPieceType.DOOR_WHITE_2PANEL_1X2 ||
      type === BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2 ||
      type === BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2
    ) {
      return 1.0;
    }
    return 2.0;
  }

  public getPieceHeight(type: BuildingPieceType): number {
    if (type === BuildingPieceType.WOOD_WALL_WINDOW_2X4) {
      return 4.0;
    }
    if (type === BuildingPieceType.WOOD_WALL_2X3 || type === BuildingPieceType.WOOD_WALL_1X3) {
      return 3.0;
    }
    if (type === BuildingPieceType.WOOD_WALL_WINDOW_1X1_5) {
      return 1.5;
    }
    if (type === BuildingPieceType.WOOD_WALL_2X1 || type === BuildingPieceType.WOOD_WALL_1X1) {
      return 1.0;
    }
    return 2.0;
  }

  public isWallPiece(type: BuildingPieceType): boolean {
    return this.isSolidWallPiece(type);
  }

  public isFloorPiece(type: BuildingPieceType): boolean {
    return (
      type === BuildingPieceType.WOOD_FLOOR_2X2 ||
      type === BuildingPieceType.WOOD_FLOOR_1X1
    );
  }

  public isFoundationPiece(type: BuildingPieceType): boolean {
    return type === BuildingPieceType.STONE_FOUNDATION_2X2;
  }

  public isConfirmablePiece(type: BuildingPieceType): boolean {
    return this.isSolidWallPiece(type) || this.isFloorPiece(type) || this.isFoundationPiece(type);
  }

  public registerPiece(piece: BuiltPiece): void {
    if (this.isSolidWallPiece(piece.type)) {
      this.unconfirmedWallPieceIds.add(piece.id);
      piece.isConfirmed = false;
    } else if (this.isFloorPiece(piece.type)) {
      this.unconfirmedFloorPieceIds.add(piece.id);
      piece.isConfirmed = false;
    } else if (this.isFoundationPiece(piece.type)) {
      this.unconfirmedFoundationPieceIds.add(piece.id);
      piece.isConfirmed = false;
    } else if (this.isOpeningPiece(piece.type)) {
      piece.isConfirmed = true;
      piece.meshGroup.visible = true;
    }
  }

  public unregisterPiece(pieceId: string): void {
    this.unconfirmedWallPieceIds.delete(pieceId);
    this.unconfirmedFloorPieceIds.delete(pieceId);
    this.unconfirmedFoundationPieceIds.delete(pieceId);
  }

  public getUnconfirmedWallCount(): number {
    return this.unconfirmedWallPieceIds.size;
  }

  public getUnconfirmedFloorCount(): number {
    return this.unconfirmedFloorPieceIds.size;
  }

  public getUnconfirmedFoundationCount(): number {
    return this.unconfirmedFoundationPieceIds.size;
  }

  public getUnconfirmedCount(): number {
    return (
      this.unconfirmedWallPieceIds.size +
      this.unconfirmedFloorPieceIds.size +
      this.unconfirmedFoundationPieceIds.size
    );
  }

  /**
   * Regenerates solid walls into a seamless continuous mesh with corner miters.
   * Windows remain individual 3D objects with frames and glass.
   */
  public regenerateWalls(pieces: Map<string, BuiltPiece>): boolean {
    this.lastWallPieces = pieces;
    const wallPieces: BuiltPiece[] = [];
    for (const piece of pieces.values()) {
      if (this.isSolidWallPiece(piece.type)) {
        wallPieces.push(piece);
      }
    }

    if (this.continuousWallMesh) {
      this.sceneGroup.remove(this.continuousWallMesh);
      this.continuousWallMesh.geometry.dispose();
      this.continuousWallMesh = null;
    }

    if (wallPieces.length === 0) {
      this.unconfirmedWallPieceIds.clear();
      this.lastSolvedCorners.clear();
      return false;
    }

    const solvedCornersResult = this.solveWallCornerNetwork(wallPieces);
    this.lastSolvedCorners = solvedCornersResult.summaryMap;
    const wallGeometry = this.buildContinuousWallGeometry(wallPieces, solvedCornersResult);

    if (wallGeometry) {
      const materials = this.wallPaintingSystem ? (this.wallPaintingSystem.getAllMaterials() as any) : BUILDING_MATERIALS.wallChecker;
      this.continuousWallMesh = new THREE.Mesh(wallGeometry, materials);
      this.continuousWallMesh.name = 'ContinuousWallSystem_WallMesh';
      this.continuousWallMesh.castShadow = false;
      this.continuousWallMesh.receiveShadow = false;
      this.sceneGroup.add(this.continuousWallMesh);

      for (const piece of wallPieces) {
        piece.meshGroup.visible = false;
        piece.isConfirmed = true;
      }
      this.unconfirmedWallPieceIds.clear();
      return true;
    }

    return false;
  }

  /**
   * Regenerates wood floors into a continuous, seamless floor mesh with dynamic wall trimming.
   */
  public regenerateFloors(pieces: Map<string, BuiltPiece>): boolean {
    const floorPieces: BuiltPiece[] = [];
    for (const piece of pieces.values()) {
      if (this.isFloorPiece(piece.type)) {
        floorPieces.push(piece);
      }
    }

    if (this.continuousFloorMesh) {
      this.sceneGroup.remove(this.continuousFloorMesh);
      this.continuousFloorMesh.geometry.dispose();
      this.continuousFloorMesh = null;
    }

    if (floorPieces.length === 0) {
      this.unconfirmedFloorPieceIds.clear();
      return false;
    }

    const floorGeometry = this.buildContinuousFloorGeometry(floorPieces, pieces);

    if (floorGeometry) {
      const materials = this.wallPaintingSystem
        ? (this.wallPaintingSystem.getAllMaterials() as any)
        : BUILDING_MATERIALS.floorChecker;
      this.continuousFloorMesh = new THREE.Mesh(floorGeometry, materials);
      this.continuousFloorMesh.name = 'ContinuousWallSystem_FloorMesh';
      this.continuousFloorMesh.castShadow = false;
      this.continuousFloorMesh.receiveShadow = false;
      this.sceneGroup.add(this.continuousFloorMesh);

      for (const piece of floorPieces) {
        piece.meshGroup.visible = false;
        piece.isConfirmed = true;
      }
      this.unconfirmedFloorPieceIds.clear();
      return true;
    }

    return false;
  }

  /**
   * Regenerates stone foundations into a continuous stone monolith.
   */
  public regenerateFoundations(pieces: Map<string, BuiltPiece>): boolean {
    const foundationPieces: BuiltPiece[] = [];
    for (const piece of pieces.values()) {
      if (this.isFoundationPiece(piece.type)) {
        foundationPieces.push(piece);
      }
    }

    if (this.continuousFoundationMesh) {
      this.sceneGroup.remove(this.continuousFoundationMesh);
      this.continuousFoundationMesh.geometry.dispose();
      this.continuousFoundationMesh = null;
    }

    if (foundationPieces.length === 0) {
      this.unconfirmedFoundationPieceIds.clear();
      return false;
    }

    const foundationGeometry = this.buildContinuousFoundationGeometry(foundationPieces);

    if (foundationGeometry) {
      this.continuousFoundationMesh = new THREE.Mesh(foundationGeometry, BUILDING_MATERIALS.stone);
      this.continuousFoundationMesh.name = 'ContinuousWallSystem_FoundationMesh';
      this.continuousFoundationMesh.castShadow = false;
      this.continuousFoundationMesh.receiveShadow = false;
      this.sceneGroup.add(this.continuousFoundationMesh);

      for (const piece of foundationPieces) {
        piece.meshGroup.visible = false;
        piece.isConfirmed = true;
      }
      this.unconfirmedFoundationPieceIds.clear();
      return true;
    }

    return false;
  }

  /**
   * Regenerates all walls, floors, and stone foundations separately.
   */
  public regenerateAll(pieces: Map<string, BuiltPiece>): boolean {
    const rWalls = this.regenerateWalls(pieces);
    const rFloors = this.regenerateFloors(pieces);
    const rFoundations = this.regenerateFoundations(pieces);
    return rWalls || rFloors || rFoundations;
  }

  public regenerate(pieces: Map<string, BuiltPiece>): boolean {
    return this.regenerateAll(pieces);
  }

  private clearContinuousMeshes(): void {
    if (this.continuousWallMesh) {
      this.sceneGroup.remove(this.continuousWallMesh);
      this.continuousWallMesh.geometry.dispose();
      this.continuousWallMesh = null;
    }
    if (this.continuousFloorMesh) {
      this.sceneGroup.remove(this.continuousFloorMesh);
      this.continuousFloorMesh.geometry.dispose();
      this.continuousFloorMesh = null;
    }
    if (this.continuousFoundationMesh) {
      this.sceneGroup.remove(this.continuousFoundationMesh);
      this.continuousFoundationMesh.geometry.dispose();
      this.continuousFoundationMesh = null;
    }
  }

  /**
   * Helper to append a 4-vertex quad to buffer arrays
   */
  /**
   * Reorders the index buffer so triangles sharing a material are contiguous, then emits one
   * group per material. Three.js issues one draw call per group, so per-quad groups would cost
   * thousands of draw calls on a large house; this keeps it at one call per wallpaper in use.
   * Index ranges not covered by any group were never rendered and are dropped.
   */
  private static applyMergedMaterialGroups(
    geo: THREE.BufferGeometry,
    indices: number[],
    groups: Array<{ start: number; count: number; materialIndex: number }>
  ): void {
    const buckets = new Map<number, number[]>();
    for (const g of groups) {
      let bucket = buckets.get(g.materialIndex);
      if (!bucket) {
        bucket = [];
        buckets.set(g.materialIndex, bucket);
      }
      for (let i = g.start; i < g.start + g.count; i++) {
        bucket.push(indices[i]);
      }
    }

    const merged: number[] = [];
    const sortedMaterials = Array.from(buckets.keys()).sort((a, b) => a - b);
    for (const materialIndex of sortedMaterials) {
      const bucket = buckets.get(materialIndex)!;
      geo.addGroup(merged.length, bucket.length, materialIndex);
      for (let i = 0; i < bucket.length; i++) merged.push(bucket[i]);
    }
    geo.setIndex(merged);
  }

  /**
   * Converts the UVs of the quad just appended (U in 2m modules, V as 0..1 of the row height)
   * into the wallpaper's own physical tile size, so textures keep their real proportions on
   * walls of any height and V=0 always sits on the floor (wainscot stays at the bottom).
   */
  private applyWallpaperUVScale(uvs: number[], wallpaperId: string | undefined, rowHeight: number, rowOffset: number): void {
    const tile = this.wallPaintingSystem?.getTileSize(wallpaperId) ?? { width: WALL_UV_TILE_WIDTH, height: WALL_UV_TILE_WIDTH };
    const uScale = WALL_UV_TILE_WIDTH / tile.width;
    for (let i = uvs.length - 8; i < uvs.length; i += 2) {
      uvs[i] *= uScale;
      uvs[i + 1] = (uvs[i + 1] * rowHeight + rowOffset) / tile.height;
    }
  }

  private static appendQuad(
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    p4: THREE.Vector3,
    uv1: THREE.Vector2,
    uv2: THREE.Vector2,
    uv3: THREE.Vector2,
    uv4: THREE.Vector2,
    positions: number[],
    normals: number[],
    uvs: number[],
    indices: number[],
    vertexOffset: number,
    normalOverride?: THREE.Vector3
  ): number {
    let n = normalOverride;
    if (!n) {
      const vA = new THREE.Vector3().subVectors(p2, p1);
      const vB = new THREE.Vector3().subVectors(p4, p1);
      n = new THREE.Vector3().crossVectors(vA, vB).normalize();
    }

    positions.push(
      p1.x, p1.y, p1.z,
      p2.x, p2.y, p2.z,
      p3.x, p3.y, p3.z,
      p4.x, p4.y, p4.z
    );

    normals.push(
      n.x, n.y, n.z,
      n.x, n.y, n.z,
      n.x, n.y, n.z,
      n.x, n.y, n.z
    );

    uvs.push(
      uv1.x, uv1.y,
      uv2.x, uv2.y,
      uv3.x, uv3.y,
      uv4.x, uv4.y
    );

    // Two triangles per quad: (0, 1, 2) and (0, 2, 3)
    indices.push(
      vertexOffset, vertexOffset + 1, vertexOffset + 2,
      vertexOffset, vertexOffset + 2, vertexOffset + 3
    );

    return vertexOffset + 4;
  }

  // =========================================================================
  // 1. CONTINUOUS WALL MESH GENERATOR
  // =========================================================================

  private solveWallCornerNetwork(
    pieces: BuiltPiece[]
  ): {
    summaryMap: Map<string, SolvedSegmentCorners>;
    segmentDataMap: Map<string, SolvedSegmentData>;
  } {
    const summaryMap = new Map<string, SolvedSegmentCorners>();
    const segmentDataMap = new Map<string, SolvedSegmentData>();

    const isClose2D = (pA: THREE.Vector3, pB: THREE.Vector3) => {
      const dx = pA.x - pB.x;
      const dz = pA.z - pB.z;
      return dx * dx + dz * dz < 0.12 * 0.12; // 12cm distance tolerance
    };

    // Prepare horizontal geometry data for each wall piece
    const rawSegments = pieces.map((piece) => {
      const forwardX = new THREE.Vector3(1, 0, 0).applyQuaternion(piece.quaternion);
      const width = this.getPieceWidth(piece.type);
      const hw = width / 2.0;
      const height = this.getPieceHeight(piece.type);

      const p1 = piece.position.clone().addScaledVector(forwardX, -hw);
      const p2 = piece.position.clone().addScaledVector(forwardX, hw);

      const yBase = piece.position.y - height / 2.0;
      const yTop = piece.position.y + height / 2.0;

      const dirFromP1 = new THREE.Vector2(forwardX.x, forwardX.z).normalize();
      const dirFromP2 = new THREE.Vector2(-forwardX.x, -forwardX.z).normalize();

      const numRows = 1; // 1 seamless vertical span per wall piece (no internal horizontal seams)
      const rowHeight = height;

      return {
        piece,
        p1,
        p2,
        dirFromP1,
        dirFromP2,
        width,
        height,
        yBase,
        yTop,
        numRows,
        rowHeight,
      };
    });

    const getCornerAtNode = (
      nodePos: THREE.Vector2,
      connections: Array<{ pieceId: string; dir: THREE.Vector2; isStart: boolean }>,
      pieceId: string,
      isStart: boolean
    ): { left: THREE.Vector2; right: THREE.Vector2; isDeadEnd: boolean } => {
      const halfT = WALL_THICKNESS / 2.0;
      const current = connections.find((c) => c.pieceId === pieceId && c.isStart === isStart);
      if (!current) {
        return {
          left: new THREE.Vector2(nodePos.x, nodePos.y),
          right: new THREE.Vector2(nodePos.x, nodePos.y),
          isDeadEnd: true,
        };
      }

      const d = current.dir.clone().normalize();
      const leftNorm = new THREE.Vector2(-d.y, d.x);

      if (connections.length <= 1) {
        return {
          left: nodePos.clone().addScaledVector(leftNorm, halfT),
          right: nodePos.clone().addScaledVector(leftNorm, -halfT),
          isDeadEnd: true,
        };
      }

      if (connections.length === 2) {
        const other = connections.find((c) => c !== current)!;
        const dot = d.dot(other.dir);

        if (dot < -0.85) {
          // Collinear straight wall
          return {
            left: nodePos.clone().addScaledVector(leftNorm, halfT),
            right: nodePos.clone().addScaledVector(leftNorm, -halfT),
            isDeadEnd: false,
          };
        }

        const cross = d.x * other.dir.y - d.y * other.dir.x;
        const bisector = new THREE.Vector2().addVectors(d, other.dir).normalize();
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        const sinHalfAngle = Math.sin(angle / 2);
        const cornerDist =
          sinHalfAngle > 0.05
            ? Math.min(halfT * 2.5, halfT / sinHalfAngle)
            : halfT * Math.SQRT2;

        if (cross > 0) {
          const innerCorner = nodePos.clone().addScaledVector(bisector, cornerDist);
          const outerCorner = nodePos.clone().addScaledVector(bisector, -cornerDist);
          return {
            left: innerCorner,
            right: outerCorner,
            isDeadEnd: false,
          };
        } else {
          const innerCorner = nodePos.clone().addScaledVector(bisector, cornerDist);
          const outerCorner = nodePos.clone().addScaledVector(bisector, -cornerDist);
          return {
            left: outerCorner,
            right: innerCorner,
            isDeadEnd: false,
          };
        }
      }

      // 3 or more connections (T-junction or cross): flat end with intersection filling
      return {
        left: nodePos.clone().addScaledVector(leftNorm, halfT),
        right: nodePos.clone().addScaledVector(leftNorm, -halfT),
        isDeadEnd: false,
      };
    };

    for (const seg of rawSegments) {
      const rows: SolvedRowCorner[] = [];

      for (let r = 0; r < seg.numRows; r++) {
        const y0 = seg.yBase + r * seg.rowHeight;
        const y1 = seg.yBase + (r + 1) * seg.rowHeight;
        const yMid = (y0 + y1) * 0.5;

        // Find all active connections at p1 and p2 using distance tolerance
        const activeConnK1: Array<{ pieceId: string; dir: THREE.Vector2; isStart: boolean }> = [];
        const activeConnK2: Array<{ pieceId: string; dir: THREE.Vector2; isStart: boolean }> = [];

        for (const otherSeg of rawSegments) {
          // Check if other piece covers this height slice
          if (otherSeg.yBase - 0.05 <= yMid && yMid <= otherSeg.yTop + 0.05) {
            if (isClose2D(otherSeg.p1, seg.p1)) {
              activeConnK1.push({ pieceId: otherSeg.piece.id, dir: otherSeg.dirFromP1, isStart: true });
            }
            if (isClose2D(otherSeg.p2, seg.p1)) {
              activeConnK1.push({ pieceId: otherSeg.piece.id, dir: otherSeg.dirFromP2, isStart: false });
            }
            if (isClose2D(otherSeg.p1, seg.p2)) {
              activeConnK2.push({ pieceId: otherSeg.piece.id, dir: otherSeg.dirFromP1, isStart: true });
            }
            if (isClose2D(otherSeg.p2, seg.p2)) {
              activeConnK2.push({ pieceId: otherSeg.piece.id, dir: otherSeg.dirFromP2, isStart: false });
            }
          }
        }

        const startNodePos = new THREE.Vector2(seg.p1.x, seg.p1.z);
        const endNodePos = new THREE.Vector2(seg.p2.x, seg.p2.z);

        const startCorner = getCornerAtNode(startNodePos, activeConnK1, seg.piece.id, true);
        const endCorner = getCornerAtNode(endNodePos, activeConnK2, seg.piece.id, false);

        rows.push({
          startLeft: startCorner.left,
          startRight: startCorner.right,
          endLeft: endCorner.right,
          endRight: endCorner.left,
          y0,
          y1,
          hasStartCap: startCorner.isDeadEnd,
          hasEndCap: endCorner.isDeadEnd,
        });
      }

      // Summary corners for painting and raycasting
      const firstRow = rows[0];

      const summary: SolvedSegmentCorners = {
        startLeft: firstRow.startLeft,
        startRight: firstRow.startRight,
        endLeft: firstRow.endLeft,
        endRight: firstRow.endRight,
        yBase: seg.yBase,
        yTop: seg.yTop,
        hasStartCap: rows.some((rw) => rw.hasStartCap),
        hasEndCap: rows.some((rw) => rw.hasEndCap),
      };

      summaryMap.set(seg.piece.id, summary);

      const v_b_sl = new THREE.Vector3(firstRow.startLeft.x, seg.yBase, firstRow.startLeft.y);
      const v_b_el = new THREE.Vector3(firstRow.endLeft.x, seg.yBase, firstRow.endLeft.y);
      const v_b_sr = new THREE.Vector3(firstRow.startRight.x, seg.yBase, firstRow.startRight.y);
      const v_b_er = new THREE.Vector3(firstRow.endRight.x, seg.yBase, firstRow.endRight.y);

      const numColsL = 1;
      const numColsR = 1;

      segmentDataMap.set(seg.piece.id, {
        pieceId: seg.piece.id,
        piece: seg.piece,
        yBase: seg.yBase,
        yTop: seg.yTop,
        numColsL,
        numColsR,
        numRows: seg.numRows,
        rows,
        summary,
      });
    }

    return { summaryMap, segmentDataMap };
  }

  private buildContinuousWallGeometry(
    pieces: BuiltPiece[],
    solved: {
      summaryMap: Map<string, SolvedSegmentCorners>;
      segmentDataMap: Map<string, SolvedSegmentData>;
    }
  ): THREE.BufferGeometry | null {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const geoGroups: Array<{ start: number; count: number; materialIndex: number }> = [];
    let vertexOffset = 0;

    // Collect all openings (windows, doors, doorways)
    const openingPieces: BuiltPiece[] = [];
    if (this.lastWallPieces) {
      for (const p of this.lastWallPieces.values()) {
        if (this.isOpeningPiece(p.type)) {
          openingPieces.push(p);
        }
      }
    }

    for (const piece of pieces) {
      const segData = solved.segmentDataMap.get(piece.id);
      if (!segData) continue;

      const { numColsL, numColsR, numRows, rows } = segData;
      const numCols = numColsL;

      const wallTangent = new THREE.Vector3(1, 0, 0).applyQuaternion(piece.quaternion);
      const wallNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion);
      const wallWidth = this.getPieceWidth(piece.type);
      const wallHeight = this.getPieceHeight(piece.type);

      const pieceOpenings: Array<{
        op: BuiltPiece;
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
      }> = [];

      for (const op of openingPieces) {
        const delta = op.position.clone().sub(piece.position);
        const distNormal = Math.abs(delta.dot(wallNormal));
        if (distNormal > 0.35) continue;

        const opTangent = new THREE.Vector3(1, 0, 0).applyQuaternion(op.quaternion);
        if (Math.abs(opTangent.dot(wallTangent)) < 0.707) continue;

        const localX = delta.dot(wallTangent);
        const localY = delta.y;
        const opW = this.getPieceWidth(op.type);
        const opH = this.getPieceHeight(op.type);
        const opMinX = localX - opW / 2;
        const opMaxX = localX + opW / 2;
        const opMinY = localY - opH / 2;
        const opMaxY = localY + opH / 2;

        const overlapMinX = Math.max(-wallWidth / 2, opMinX);
        const overlapMaxX = Math.min(wallWidth / 2, opMaxX);
        const overlapX = overlapMaxX - overlapMinX;

        const overlapMinY = Math.max(-wallHeight / 2, opMinY);
        const overlapMaxY = Math.min(wallHeight / 2, opMaxY);
        const overlapY = overlapMaxY - overlapMinY;

        if (overlapX > 0.02 && overlapY > 0.02) {
          pieceOpenings.push({
            op,
            minX: opMinX,
            maxX: opMaxX,
            minY: opMinY,
            maxY: opMaxY,
          });
        }
      }

      // Render each row's left and right faces, end caps, inner jambs, and transitions
      for (let r = 0; r < numRows; r++) {
        const row = rows[r];
        const { startLeft, startRight, endLeft, endRight, y0, y1, hasStartCap, hasEndCap } = row;

        const v_b_sl = new THREE.Vector3(startLeft.x, y0, startLeft.y);
        const v_b_sr = new THREE.Vector3(startRight.x, y0, startRight.y);
        const v_b_el = new THREE.Vector3(endLeft.x, y0, endLeft.y);
        const v_b_er = new THREE.Vector3(endRight.x, y0, endRight.y);

        const v_t_sl = new THREE.Vector3(startLeft.x, y1, startLeft.y);
        const v_t_sr = new THREE.Vector3(startRight.x, y1, startRight.y);
        const v_t_el = new THREE.Vector3(endLeft.x, y1, endLeft.y);
        const v_t_er = new THREE.Vector3(endRight.x, y1, endRight.y);

        const rowMinY = y0 - piece.position.y;
        const rowMaxY = y1 - piece.position.y;
        const rowOpenings = pieceOpenings.filter(
          (op) => Math.min(rowMaxY, op.maxY) - Math.max(rowMinY, op.minY) > 0.02
        );

        const piece2DPos = new THREE.Vector2(piece.position.x, piece.position.z);
        const wallTangent2D = new THREE.Vector2(wallTangent.x, wallTangent.z).normalize();
        // World-space U so wallpaper keeps the same scale on 1m/2m walls and flows across collinear pieces
        const tangentOffset = piece2DPos.dot(wallTangent2D);

        const lx_start_L = startLeft.clone().sub(piece2DPos).dot(wallTangent2D);
        const lx_end_L = endLeft.clone().sub(piece2DPos).dot(wallTangent2D);
        const dirL = Math.abs(lx_end_L - lx_start_L) < 1e-5 ? 1e-5 : lx_end_L - lx_start_L;

        const lx_start_R = startRight.clone().sub(piece2DPos).dot(wallTangent2D);
        const lx_end_R = endRight.clone().sub(piece2DPos).dot(wallTangent2D);
        const dirR = Math.abs(lx_end_R - lx_start_R) < 1e-5 ? 1e-5 : lx_end_R - lx_start_R;

        // --- Left face quad cells for this row ---
        // Outward normal points towards left side (+Z in local wall)
        // CCW vertices: p_bl (start), p_br (end), p_tr (end), p_tl (start)
        for (let c = 0; c < numColsL; c++) {
          const u0 = c / numColsL;
          const u1 = (c + 1) / numColsL;

          const cellX0 = lx_start_L + u0 * dirL;
          const cellX1 = lx_start_L + u1 * dirL;
          const cMin = Math.min(cellX0, cellX1);
          const cMax = Math.max(cellX0, cellX1);
          const cSpan = Math.max(1e-4, cMax - cMin);

          // 1. Outside openings: full height quad
          const solids = getSolidSubIntervals(cMin, cMax, rowOpenings);

          for (const sol of solids) {
            const u_a = (sol.minX - lx_start_L) / dirL;
            const u_b = (sol.maxX - lx_start_L) / dirL;
            const u_sub0 = Math.max(0, Math.min(1, Math.min(u_a, u_b)));
            const u_sub1 = Math.max(0, Math.min(1, Math.max(u_a, u_b)));

            if (u_sub1 - u_sub0 <= 1e-4) continue;

            const p_bl = v_b_sl.clone().lerp(v_b_el, u_sub0);
            const p_br = v_b_sl.clone().lerp(v_b_el, u_sub1);
            const p_tr = v_t_sl.clone().lerp(v_t_el, u_sub1);
            const p_tl = v_t_sl.clone().lerp(v_t_el, u_sub0);

            const u_start = (sol.minX + tangentOffset) / WALL_UV_TILE_WIDTH;
            const u_end = (sol.maxX + tangentOffset) / WALL_UV_TILE_WIDTH;

            const quadStart = indices.length;
            vertexOffset = ContinuousWallSystem.appendQuad(
              p_bl, p_br, p_tr, p_tl,
              new THREE.Vector2(u_start, 0),
              new THREE.Vector2(u_end, 0),
              new THREE.Vector2(u_end, 1),
              new THREE.Vector2(u_start, 1),
              positions, normals, uvs, indices, vertexOffset
            );

            const wallpaperId = this.wallPaintingSystem?.getCellWallpaper(piece.id, 'left', c, r);
            const matIndex = this.wallPaintingSystem?.getMaterialIndex(wallpaperId) ?? 0;
            this.applyWallpaperUVScale(uvs, wallpaperId, y1 - y0, y0 - segData.yBase);
            geoGroups.push({ start: quadStart, count: 6, materialIndex: matIndex });
          }

          // 2. Inside openings: wall below opening and wall above opening
          for (const op of rowOpenings) {
            const overlapMinX = Math.max(cMin, op.minX);
            const overlapMaxX = Math.min(cMax, op.maxX);
            if (overlapMaxX - overlapMinX <= 1e-4) continue;

            const u_a = (overlapMinX - lx_start_L) / dirL;
            const u_b = (overlapMaxX - lx_start_L) / dirL;
            const u_sub0 = Math.max(0, Math.min(1, Math.min(u_a, u_b)));
            const u_sub1 = Math.max(0, Math.min(1, Math.max(u_a, u_b)));
            if (u_sub1 - u_sub0 <= 1e-4) continue;

            const opY0 = piece.position.y + op.minY;
            const opY1 = piece.position.y + op.maxY;
            const u_start = (overlapMinX + tangentOffset) / WALL_UV_TILE_WIDTH;
            const u_end = (overlapMaxX + tangentOffset) / WALL_UV_TILE_WIDTH;

            // A. Wall BELOW opening (sill)
            if (opY0 > y0 + 0.005) {
              const y_top = Math.min(y1, opY0);
              const p_bl = v_b_sl.clone().lerp(v_b_el, u_sub0).setY(y0);
              const p_br = v_b_sl.clone().lerp(v_b_el, u_sub1).setY(y0);
              const p_tr = v_b_sl.clone().lerp(v_b_el, u_sub1).setY(y_top);
              const p_tl = v_t_sl.clone().lerp(v_t_el, u_sub0).setY(y_top);

              const v_end = (y_top - y0) / (y1 - y0);
              const quadStart = indices.length;
              vertexOffset = ContinuousWallSystem.appendQuad(
                p_bl, p_br, p_tr, p_tl,
                new THREE.Vector2(u_start, 0),
                new THREE.Vector2(u_end, 0),
                new THREE.Vector2(u_end, v_end),
                new THREE.Vector2(u_start, v_end),
                positions, normals, uvs, indices, vertexOffset
              );
              const wallpaperId = this.wallPaintingSystem?.getCellWallpaper(piece.id, 'left', c, r);
              const matIndex = this.wallPaintingSystem?.getMaterialIndex(wallpaperId) ?? 0;
              this.applyWallpaperUVScale(uvs, wallpaperId, y1 - y0, y0 - segData.yBase);
            geoGroups.push({ start: quadStart, count: 6, materialIndex: matIndex });
            }

            // B. Wall ABOVE opening (header)
            if (opY1 < y1 - 0.005) {
              const y_bot = Math.max(y0, opY1);
              const p_bl = v_b_sl.clone().lerp(v_b_el, u_sub0).setY(y_bot);
              const p_br = v_b_sl.clone().lerp(v_b_el, u_sub1).setY(y_bot);
              const p_tr = v_t_sl.clone().lerp(v_t_el, u_sub1).setY(y1);
              const p_tl = v_t_sl.clone().lerp(v_t_el, u_sub0).setY(y1);

              const v_start = (y_bot - y0) / (y1 - y0);
              const quadStart = indices.length;
              vertexOffset = ContinuousWallSystem.appendQuad(
                p_bl, p_br, p_tr, p_tl,
                new THREE.Vector2(u_start, v_start),
                new THREE.Vector2(u_end, v_start),
                new THREE.Vector2(u_end, 1),
                new THREE.Vector2(u_start, 1),
                positions, normals, uvs, indices, vertexOffset
              );
              const wallpaperId = this.wallPaintingSystem?.getCellWallpaper(piece.id, 'left', c, r);
              const matIndex = this.wallPaintingSystem?.getMaterialIndex(wallpaperId) ?? 0;
              this.applyWallpaperUVScale(uvs, wallpaperId, y1 - y0, y0 - segData.yBase);
            geoGroups.push({ start: quadStart, count: 6, materialIndex: matIndex });
            }
          }
        }

        // --- Right face quad cells for this row ---
        // Outward normal points towards right side (-Z in local wall)
        // CCW vertices: p_br (end), p_bl (start), p_tl (start), p_tr (end)
        for (let c = 0; c < numColsR; c++) {
          const u0 = c / numColsR;
          const u1 = (c + 1) / numColsR;

          const cellX0 = lx_start_R + u0 * dirR;
          const cellX1 = lx_start_R + u1 * dirR;
          const cMin = Math.min(cellX0, cellX1);
          const cMax = Math.max(cellX0, cellX1);
          const cSpan = Math.max(1e-4, cMax - cMin);

          // 1. Outside openings: full height quad
          const solids = getSolidSubIntervals(cMin, cMax, rowOpenings);

          for (const sol of solids) {
            const u_a = (sol.minX - lx_start_R) / dirR;
            const u_b = (sol.maxX - lx_start_R) / dirR;
            const u_sub0 = Math.max(0, Math.min(1, Math.min(u_a, u_b)));
            const u_sub1 = Math.max(0, Math.min(1, Math.max(u_a, u_b)));

            if (u_sub1 - u_sub0 <= 1e-4) continue;

            const p_bl = v_b_sr.clone().lerp(v_b_er, u_sub0);
            const p_br = v_b_sr.clone().lerp(v_b_er, u_sub1);
            const p_tr = v_t_sr.clone().lerp(v_t_er, u_sub1);
            const p_tl = v_t_sr.clone().lerp(v_t_er, u_sub0);

            const u_start = -(sol.minX + tangentOffset) / WALL_UV_TILE_WIDTH;
            const u_end = -(sol.maxX + tangentOffset) / WALL_UV_TILE_WIDTH;

            const quadStart = indices.length;
            vertexOffset = ContinuousWallSystem.appendQuad(
              p_br, p_bl, p_tl, p_tr,
              new THREE.Vector2(u_end, 0),
              new THREE.Vector2(u_start, 0),
              new THREE.Vector2(u_start, 1),
              new THREE.Vector2(u_end, 1),
              positions, normals, uvs, indices, vertexOffset
            );

            const wallpaperId = this.wallPaintingSystem?.getCellWallpaper(piece.id, 'right', c, r);
            const matIndex = this.wallPaintingSystem?.getMaterialIndex(wallpaperId) ?? 0;
            this.applyWallpaperUVScale(uvs, wallpaperId, y1 - y0, y0 - segData.yBase);
            geoGroups.push({ start: quadStart, count: 6, materialIndex: matIndex });
          }

          // 2. Inside openings: wall below opening and wall above opening
          for (const op of rowOpenings) {
            const overlapMinX = Math.max(cMin, op.minX);
            const overlapMaxX = Math.min(cMax, op.maxX);
            if (overlapMaxX - overlapMinX <= 1e-4) continue;

            const u_a = (overlapMinX - lx_start_R) / dirR;
            const u_b = (overlapMaxX - lx_start_R) / dirR;
            const u_sub0 = Math.max(0, Math.min(1, Math.min(u_a, u_b)));
            const u_sub1 = Math.max(0, Math.min(1, Math.max(u_a, u_b)));
            if (u_sub1 - u_sub0 <= 1e-4) continue;

            const opY0 = piece.position.y + op.minY;
            const opY1 = piece.position.y + op.maxY;
            const u_start = -(overlapMinX + tangentOffset) / WALL_UV_TILE_WIDTH;
            const u_end = -(overlapMaxX + tangentOffset) / WALL_UV_TILE_WIDTH;

            // A. Wall BELOW opening (sill)
            if (opY0 > y0 + 0.005) {
              const y_top = Math.min(y1, opY0);
              const p_bl = v_b_sr.clone().lerp(v_b_er, u_sub0).setY(y0);
              const p_br = v_b_sr.clone().lerp(v_b_er, u_sub1).setY(y0);
              const p_tr = v_t_sr.clone().lerp(v_t_er, u_sub1).setY(y_top);
              const p_tl = v_t_sr.clone().lerp(v_t_er, u_sub0).setY(y_top);

              const v_end = (y_top - y0) / (y1 - y0);
              const quadStart = indices.length;
              vertexOffset = ContinuousWallSystem.appendQuad(
                p_br, p_bl, p_tl, p_tr,
                new THREE.Vector2(u_end, 0),
                new THREE.Vector2(u_start, 0),
                new THREE.Vector2(u_start, v_end),
                new THREE.Vector2(u_end, v_end),
                positions, normals, uvs, indices, vertexOffset
              );
              const wallpaperId = this.wallPaintingSystem?.getCellWallpaper(piece.id, 'right', c, r);
              const matIndex = this.wallPaintingSystem?.getMaterialIndex(wallpaperId) ?? 0;
              this.applyWallpaperUVScale(uvs, wallpaperId, y1 - y0, y0 - segData.yBase);
            geoGroups.push({ start: quadStart, count: 6, materialIndex: matIndex });
            }

            // B. Wall ABOVE opening (header)
            if (opY1 < y1 - 0.005) {
              const y_bot = Math.max(y0, opY1);
              const p_bl = v_b_sr.clone().lerp(v_b_er, u_sub0).setY(y_bot);
              const p_br = v_b_sr.clone().lerp(v_b_er, u_sub1).setY(y_bot);
              const p_tr = v_t_sr.clone().lerp(v_t_er, u_sub1).setY(y1);
              const p_tl = v_t_sr.clone().lerp(v_t_er, u_sub0).setY(y1);

              const v_start = (y_bot - y0) / (y1 - y0);
              const quadStart = indices.length;
              vertexOffset = ContinuousWallSystem.appendQuad(
                p_br, p_bl, p_tl, p_tr,
                new THREE.Vector2(u_end, v_start),
                new THREE.Vector2(u_start, v_start),
                new THREE.Vector2(u_start, 1),
                new THREE.Vector2(u_end, 1),
                positions, normals, uvs, indices, vertexOffset
              );
              const wallpaperId = this.wallPaintingSystem?.getCellWallpaper(piece.id, 'right', c, r);
              const matIndex = this.wallPaintingSystem?.getMaterialIndex(wallpaperId) ?? 0;
              this.applyWallpaperUVScale(uvs, wallpaperId, y1 - y0, y0 - segData.yBase);
            geoGroups.push({ start: quadStart, count: 6, materialIndex: matIndex });
            }
          }
        }

        // --- Inner Jambs / Reveals around hole perimeters for this row ---
        for (const op of rowOpenings) {
          const opY0 = piece.position.y + op.minY;
          const opY1 = piece.position.y + op.maxY;
          const holeY0 = Math.max(y0, opY0);
          const holeY1 = Math.min(y1, opY1);

          if (holeY1 <= holeY0 + 0.005) continue;

          // Hole X limits clamped to this wall piece
          const holeMinX = Math.max(-wallWidth / 2, op.minX);
          const holeMaxX = Math.min(wallWidth / 2, op.maxX);
          if (holeMaxX - holeMinX <= 0.005) continue;

          const u0_L = Math.max(0, Math.min(1, (holeMinX - lx_start_L) / dirL));
          const u1_L = Math.max(0, Math.min(1, (holeMaxX - lx_start_L) / dirL));
          const u0_R = Math.max(0, Math.min(1, (holeMinX - lx_start_R) / dirR));
          const u1_R = Math.max(0, Math.min(1, (holeMaxX - lx_start_R) / dirR));

          const p_L_b0 = v_b_sl.clone().lerp(v_b_el, u0_L).setY(holeY0);
          const p_L_b1 = v_b_sl.clone().lerp(v_b_el, u1_L).setY(holeY0);
          const p_L_t0 = v_b_sl.clone().lerp(v_b_el, u0_L).setY(holeY1);
          const p_L_t1 = v_b_sl.clone().lerp(v_b_el, u1_L).setY(holeY1);

          const p_R_b0 = v_b_sr.clone().lerp(v_b_er, u0_R).setY(holeY0);
          const p_R_b1 = v_b_sr.clone().lerp(v_b_er, u1_R).setY(holeY0);
          const p_R_t0 = v_b_sr.clone().lerp(v_b_er, u0_R).setY(holeY1);
          const p_R_t1 = v_b_sr.clone().lerp(v_b_er, u1_R).setY(holeY1);

          const jambStart = indices.length;

          // 1. Left Jamb (facing +X into opening): ONLY if left edge of opening is inside this wall
          if (op.minX > -wallWidth / 2 + 0.01) {
            vertexOffset = ContinuousWallSystem.appendQuad(
              p_L_b0, p_R_b0, p_R_t0, p_L_t0,
              new THREE.Vector2(0, 0),
              new THREE.Vector2(WALL_THICKNESS / CHECKER_TILE_SIZE, 0),
              new THREE.Vector2(WALL_THICKNESS / CHECKER_TILE_SIZE, (holeY1 - holeY0) / CHECKER_TILE_SIZE),
              new THREE.Vector2(0, (holeY1 - holeY0) / CHECKER_TILE_SIZE),
              positions, normals, uvs, indices, vertexOffset
            );
          }

          // 2. Right Jamb (facing -X into opening): ONLY if right edge of opening is inside this wall
          if (op.maxX < wallWidth / 2 - 0.01) {
            vertexOffset = ContinuousWallSystem.appendQuad(
              p_R_b1, p_L_b1, p_L_t1, p_R_t1,
              new THREE.Vector2(0, 0),
              new THREE.Vector2(WALL_THICKNESS / CHECKER_TILE_SIZE, 0),
              new THREE.Vector2(WALL_THICKNESS / CHECKER_TILE_SIZE, (holeY1 - holeY0) / CHECKER_TILE_SIZE),
              new THREE.Vector2(0, (holeY1 - holeY0) / CHECKER_TILE_SIZE),
              positions, normals, uvs, indices, vertexOffset
            );
          }

          // 3. Top Header Jamb (facing -Y down): ONLY if top of opening is below top of wall
          if (op.maxY < wallHeight / 2 - 0.01 && Math.abs(holeY1 - opY1) < 0.005) {
            vertexOffset = ContinuousWallSystem.appendQuad(
              p_L_t0, p_R_t0, p_R_t1, p_L_t1,
              new THREE.Vector2(0, 0),
              new THREE.Vector2((holeMaxX - holeMinX) / CHECKER_TILE_SIZE, 0),
              new THREE.Vector2((holeMaxX - holeMinX) / CHECKER_TILE_SIZE, WALL_THICKNESS / CHECKER_TILE_SIZE),
              new THREE.Vector2(0, WALL_THICKNESS / CHECKER_TILE_SIZE),
              positions, normals, uvs, indices, vertexOffset,
              new THREE.Vector3(0, -1, 0)
            );
          }

          // 4. Bottom Sill Jamb (facing +Y up): ONLY if bottom of opening is above bottom of wall
          if (
            op.minY > -wallHeight / 2 + 0.01 &&
            Math.abs(holeY0 - opY0) < 0.005 &&
            !this.isDoorPiece(op.op.type) &&
            !this.isDoorwayPiece(op.op.type)
          ) {
            vertexOffset = ContinuousWallSystem.appendQuad(
              p_L_b0, p_L_b1, p_R_b1, p_R_b0,
              new THREE.Vector2(0, 0),
              new THREE.Vector2(WALL_THICKNESS / CHECKER_TILE_SIZE, 0),
              new THREE.Vector2(WALL_THICKNESS / CHECKER_TILE_SIZE, (holeMaxX - holeMinX) / CHECKER_TILE_SIZE),
              new THREE.Vector2(0, (holeMaxX - holeMinX) / CHECKER_TILE_SIZE),
              positions, normals, uvs, indices, vertexOffset,
              new THREE.Vector3(0, 1, 0)
            );
          }

          const jambCount = indices.length - jambStart;
          if (jambCount > 0) {
            geoGroups.push({ start: jambStart, count: jambCount, materialIndex: 0 });
          }
        }

        // --- Trim / Caps for this row ---
        const trimStart = indices.length;

        // End cap at start for this row (only if solid dead end and no opening spanning start across full row)
        const penetratesStart = pieceOpenings.some((op) => {
          const opY0 = piece.position.y + op.minY;
          const opY1 = piece.position.y + op.maxY;
          return op.minX <= -wallWidth / 2 + 0.01 && opY0 <= y0 + 0.005 && opY1 >= y1 - 0.005;
        });
        if (hasStartCap && !penetratesStart) {
          vertexOffset = ContinuousWallSystem.appendQuad(
            v_b_sr, v_b_sl, v_t_sl, v_t_sr,
            new THREE.Vector2(0, 0),
            new THREE.Vector2(WALL_THICKNESS / CHECKER_TILE_SIZE, 0),
            new THREE.Vector2(WALL_THICKNESS / CHECKER_TILE_SIZE, (y1 - y0) / CHECKER_TILE_SIZE),
            new THREE.Vector2(0, (y1 - y0) / CHECKER_TILE_SIZE),
            positions, normals, uvs, indices, vertexOffset
          );
        }

        // End cap at end for this row (only if solid dead end and no opening spanning end across full row)
        const penetratesEnd = pieceOpenings.some((op) => {
          const opY0 = piece.position.y + op.minY;
          const opY1 = piece.position.y + op.maxY;
          return op.maxX >= wallWidth / 2 - 0.01 && opY0 <= y0 + 0.005 && opY1 >= y1 - 0.005;
        });
        if (hasEndCap && !penetratesEnd) {
          vertexOffset = ContinuousWallSystem.appendQuad(
            v_b_el, v_b_er, v_t_er, v_t_el,
            new THREE.Vector2(0, 0),
            new THREE.Vector2(WALL_THICKNESS / CHECKER_TILE_SIZE, 0),
            new THREE.Vector2(WALL_THICKNESS / CHECKER_TILE_SIZE, (y1 - y0) / CHECKER_TILE_SIZE),
            new THREE.Vector2(0, (y1 - y0) / CHECKER_TILE_SIZE),
            positions, normals, uvs, indices, vertexOffset
          );
        }

        // Bottom face for the bottom-most row (skip base if hole penetrates to floor)
        if (r === 0) {
          for (let c = 0; c < numCols; c++) {
            const cellMinX = -wallWidth / 2 + c * (wallWidth / numCols);
            const cellMaxX = -wallWidth / 2 + (c + 1) * (wallWidth / numCols);
            const penetratesBase = pieceOpenings.some((op) => {
              const opY0 = piece.position.y + op.minY;
              const overlapX = Math.min(cellMaxX, op.maxX) - Math.max(cellMinX, op.minX);
              return overlapX > 0.01 && opY0 <= y0 + 0.005;
            });
            if (penetratesBase) continue;

            const u0 = c / numCols;
            const u1 = (c + 1) / numCols;
            const p_L_b0 = v_b_sl.clone().lerp(v_b_el, u0);
            const p_L_b1 = v_b_sl.clone().lerp(v_b_el, u1);
            const p_R_b0 = v_b_sr.clone().lerp(v_b_er, u0);
            const p_R_b1 = v_b_sr.clone().lerp(v_b_er, u1);

            vertexOffset = ContinuousWallSystem.appendQuad(
              p_L_b0, p_R_b0, p_R_b1, p_L_b1,
              new THREE.Vector2(0, 0),
              new THREE.Vector2((u1 - u0) * wallWidth / CHECKER_TILE_SIZE, 0),
              new THREE.Vector2((u1 - u0) * wallWidth / CHECKER_TILE_SIZE, WALL_THICKNESS / CHECKER_TILE_SIZE),
              new THREE.Vector2(0, WALL_THICKNESS / CHECKER_TILE_SIZE),
              positions, normals, uvs, indices, vertexOffset,
              new THREE.Vector3(0, -1, 0)
            );
          }
        }

        // Top face for the top-most row (skip top if hole penetrates to ceiling)
        if (r === numRows - 1) {
          for (let c = 0; c < numCols; c++) {
            const cellMinX = -wallWidth / 2 + c * (wallWidth / numCols);
            const cellMaxX = -wallWidth / 2 + (c + 1) * (wallWidth / numCols);
            const penetratesTop = pieceOpenings.some((op) => {
              const opY1 = piece.position.y + op.maxY;
              const overlapX = Math.min(cellMaxX, op.maxX) - Math.max(cellMinX, op.minX);
              return overlapX > 0.01 && opY1 >= y1 - 0.005;
            });
            if (penetratesTop) continue;

            const u0 = c / numCols;
            const u1 = (c + 1) / numCols;
            const p_L_t0 = v_t_sl.clone().lerp(v_t_el, u0);
            const p_L_t1 = v_t_sl.clone().lerp(v_t_el, u1);
            const p_R_t0 = v_t_sr.clone().lerp(v_t_er, u0);
            const p_R_t1 = v_t_sr.clone().lerp(v_t_er, u1);

            vertexOffset = ContinuousWallSystem.appendQuad(
              p_L_t0, p_L_t1, p_R_t1, p_R_t0,
              new THREE.Vector2(0, 0),
              new THREE.Vector2((u1 - u0) * wallWidth / CHECKER_TILE_SIZE, 0),
              new THREE.Vector2((u1 - u0) * wallWidth / CHECKER_TILE_SIZE, WALL_THICKNESS / CHECKER_TILE_SIZE),
              new THREE.Vector2(0, WALL_THICKNESS / CHECKER_TILE_SIZE),
              positions, normals, uvs, indices, vertexOffset,
              new THREE.Vector3(0, 1, 0)
            );
          }
        }

        const trimCount = indices.length - trimStart;
        if (trimCount > 0) {
          geoGroups.push({ start: trimStart, count: trimCount, materialIndex: 0 });
        }
      }
    }

    if (positions.length === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    ContinuousWallSystem.applyMergedMaterialGroups(geo, indices, geoGroups);

    return geo;
  }

  // =========================================================================
  // 2. CONTINUOUS FLOOR MESH GENERATOR
  // =========================================================================

  /**
   * Merges all contiguous 2x2 & 1x1 floor slabs into a seamless floor geometry.
   * Dynamically trims any floor geometry that penetrates into walls at the same height level,
   * eliminating z-flickering from above and aligning floor edges cleanly to inner/outer wall faces and mitered corners.
   */
  private buildContinuousFloorGeometry(
    floorPieces: BuiltPiece[],
    allPieces?: Map<string, BuiltPiece>
  ): THREE.BufferGeometry | null {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let vertexOffset = 0;
    const geoGroups: Array<{ start: number; count: number; materialIndex: number }> = [];

    // 1. Gather all wall-like pieces and compute their exact solved mitered corner footprint
    const wallPieces: BuiltPiece[] = [];
    if (allPieces) {
      for (const p of allPieces.values()) {
        if (
          this.isSolidWallPiece(p.type) ||
          this.isWindowPiece(p.type) ||
          this.isDoorwayPiece(p.type) ||
          this.isDoorPiece(p.type)
        ) {
          wallPieces.push(p);
        }
      }
    }

    const wallObstacles: WallObstacle[] = [];
    if (wallPieces.length > 0) {
      const solvedCorners = this.solveWallCornerNetwork(wallPieces);
      for (const p of wallPieces) {
        const summary = solvedCorners.summaryMap.get(p.id);
        if (summary) {
          wallObstacles.push(
            createWallObstacle(
              p.id,
              summary.startLeft,
              summary.startRight,
              summary.endLeft,
              summary.endRight,
              summary.yBase,
              summary.yTop
            )
          );
        }
      }
    }

    const halfH = FLOOR_THICKNESS / 2.0; // 0.06m
    const stepSize = 0.5; // 0.5m grid subdivision matching checker parquet tiles

    for (const piece of floorPieces) {
      const is1x1 = piece.type === BuildingPieceType.WOOD_FLOOR_1X1;
      const halfW = is1x1 ? 0.5 : MODULE_SIZE / 2.0;
      const halfL = is1x1 ? 0.5 : MODULE_SIZE / 2.0;
      const numCols = is1x1 ? 2 : 4;
      const numRows = is1x1 ? 2 : 4;

      const floorYBase = piece.position.y - halfH;
      const floorYTop = piece.position.y + halfH;

      // Material indexes for this floor slab piece (top = floor, bottom = ceiling)
      const topWpId = this.wallPaintingSystem ? this.wallPaintingSystem.getCellWallpaper(piece.id, 'top', 0, 0) : 'default';
      const topMatIdx = this.wallPaintingSystem ? this.wallPaintingSystem.getMaterialIndex(topWpId) : 0;

      const botWpId = this.wallPaintingSystem ? this.wallPaintingSystem.getCellWallpaper(piece.id, 'bottom', 0, 0) : 'default';
      const botMatIdx = this.wallPaintingSystem ? this.wallPaintingSystem.getMaterialIndex(botWpId) : 0;

      // Filter walls that vertically overlap with this floor slab
      const overlappingWalls = wallObstacles.filter(
        (w) => floorYTop > w.yBase + 0.005 && floorYBase < w.yTop - 0.005
      );

      const floorRight = new THREE.Vector3(1, 0, 0).applyQuaternion(piece.quaternion);
      const floorForward = new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion);
      const fR = new THREE.Vector2(floorRight.x, floorRight.z).normalize();
      const fF = new THREE.Vector2(floorForward.x, floorForward.z).normalize();
      const fCenter = new THREE.Vector2(piece.position.x, piece.position.z);

      for (let iz = 0; iz < numRows; iz++) {
        for (let ix = 0; ix < numCols; ix++) {
          const lx0 = -halfW + ix * stepSize;
          const lx1 = lx0 + stepSize;
          const lz0 = -halfL + iz * stepSize;
          const lz1 = lz0 + stepSize;

          // 4 corners of 0.5m sub-cell in world 2D coords (CCW: SW, SE, NE, NW)
          const p0 = fCenter.clone().addScaledVector(fR, lx0).addScaledVector(fF, lz0);
          const p1 = fCenter.clone().addScaledVector(fR, lx1).addScaledVector(fF, lz0);
          const p2 = fCenter.clone().addScaledVector(fR, lx1).addScaledVector(fF, lz1);
          const p3 = fCenter.clone().addScaledVector(fR, lx0).addScaledVector(fF, lz1);

          let currentPolys: THREE.Vector2[][] = [[p0, p1, p2, p3]];

          for (const wall of overlappingWalls) {
            if (currentPolys.length === 0) break;
            const nextPolys: THREE.Vector2[][] = [];
            for (const poly of currentPolys) {
              const diff = subtractConvexPolygon(poly, wall);
              for (const d of diff) {
                nextPolys.push(d);
              }
            }
            currentPolys = nextPolys;
          }

          for (const poly of currentPolys) {
            if (poly.length < 3) continue;

            // Compute area
            let area = 0;
            for (let k = 0; k < poly.length; k++) {
              const nextK = (k + 1) % poly.length;
              area += poly[k].x * poly[nextK].y - poly[nextK].x * poly[k].y;
            }
            area = Math.abs(area) * 0.5;
            if (area < 1e-4) continue;

            // 1. Top face (walkable floor surface) - upward normal (+Y) winding order: vA -> vC -> vB
            const topStart = indices.length;
            for (let i = 1; i < poly.length - 1; i++) {
              const a = poly[0];
              const b = poly[i];
              const c = poly[i + 1];

              const vA = new THREE.Vector3(a.x, floorYTop, a.y);
              const vB = new THREE.Vector3(b.x, floorYTop, b.y);
              const vC = new THREE.Vector3(c.x, floorYTop, c.y);

              positions.push(vA.x, vA.y, vA.z, vC.x, vC.y, vC.z, vB.x, vB.y, vB.z);
              normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
              uvs.push(
                a.x / CHECKER_TILE_SIZE, a.y / CHECKER_TILE_SIZE,
                c.x / CHECKER_TILE_SIZE, c.y / CHECKER_TILE_SIZE,
                b.x / CHECKER_TILE_SIZE, b.y / CHECKER_TILE_SIZE
              );
              indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2);
              vertexOffset += 3;
            }
            const topCount = indices.length - topStart;
            if (topCount > 0) {
              geoGroups.push({ start: topStart, count: topCount, materialIndex: topMatIdx });
            }

            // 2. Bottom face (ceiling surface) - downward normal (-Y) winding order: vbA -> vbB -> vbC
            const botStart = indices.length;
            for (let i = 1; i < poly.length - 1; i++) {
              const a = poly[0];
              const b = poly[i];
              const c = poly[i + 1];

              const vbA = new THREE.Vector3(a.x, floorYBase, a.y);
              const vbB = new THREE.Vector3(b.x, floorYBase, b.y);
              const vbC = new THREE.Vector3(c.x, floorYBase, c.y);

              positions.push(vbA.x, vbA.y, vbA.z, vbB.x, vbB.y, vbB.z, vbC.x, vbC.y, vbC.z);
              normals.push(0, -1, 0, 0, -1, 0, 0, -1, 0);
              uvs.push(
                a.x / CHECKER_TILE_SIZE, a.y / CHECKER_TILE_SIZE,
                b.x / CHECKER_TILE_SIZE, b.y / CHECKER_TILE_SIZE,
                c.x / CHECKER_TILE_SIZE, c.y / CHECKER_TILE_SIZE
              );
              indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2);
              vertexOffset += 3;
            }
            const botCount = indices.length - botStart;
            if (botCount > 0) {
              geoGroups.push({ start: botStart, count: botCount, materialIndex: botMatIdx });
            }

            // 3. Side Perimeter Faces (Only generated for exposed boundaries or wall-trimmed edges)
            const sideStart = indices.length;
            for (let k = 0; k < poly.length; k++) {
              const pA = poly[k];
              const pB = poly[(k + 1) % poly.length];

              const edgeVec = pB.clone().sub(pA);
              const edgeLen = edgeVec.length();
              if (edgeLen < 1e-4) continue;

              const edgeNormal = new THREE.Vector2(edgeVec.y, -edgeVec.x).normalize();
              const midPoint = pA.clone().add(pB).multiplyScalar(0.5);
              const testPt = midPoint.clone().addScaledVector(edgeNormal, 0.02);

              const isInteriorSeam = isPointInAnyFloor(testPt, piece.position.y, floorPieces, wallObstacles);
              if (!isInteriorSeam) {
                const vBotA = new THREE.Vector3(pA.x, floorYBase, pA.y);
                const vBotB = new THREE.Vector3(pB.x, floorYBase, pB.y);
                const vTopB = new THREE.Vector3(pB.x, floorYTop, pB.y);
                const vTopA = new THREE.Vector3(pA.x, floorYTop, pA.y);

                const sideN = new THREE.Vector3(edgeNormal.x, 0, edgeNormal.y);

                vertexOffset = ContinuousWallSystem.appendQuad(
                  vBotA, vTopA, vTopB, vBotB,
                  new THREE.Vector2(0, 0),
                  new THREE.Vector2(0, FLOOR_THICKNESS / CHECKER_TILE_SIZE),
                  new THREE.Vector2(edgeLen / CHECKER_TILE_SIZE, FLOOR_THICKNESS / CHECKER_TILE_SIZE),
                  new THREE.Vector2(edgeLen / CHECKER_TILE_SIZE, 0),
                  positions, normals, uvs, indices, vertexOffset,
                  sideN
                );
              }
            }
            const sideCount = indices.length - sideStart;
            if (sideCount > 0) {
              geoGroups.push({ start: sideStart, count: sideCount, materialIndex: 0 });
            }
          }
        }
      }
    }

    if (positions.length === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    ContinuousWallSystem.applyMergedMaterialGroups(geo, indices, geoGroups);

    return geo;
  }

  // =========================================================================
  // 3. CONTINUOUS STONE FOUNDATION MESH GENERATOR
  // =========================================================================

  /**
   * Merges all contiguous 2x2 stone foundation blocks into a seamless foundation monolith.
   * Generates continuous world-aligned chiseled stone UVs and eliminates internal seams.
   */
  private buildContinuousFoundationGeometry(foundationPieces: BuiltPiece[]): THREE.BufferGeometry | null {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let vertexOffset = 0;

    const snapKey = (x: number, y: number, z: number) =>
      `${Math.round(x * 2) / 2}_${Math.round(y * 10) / 10}_${Math.round(z * 2) / 2}`;

    const foundationSet = new Set<string>();
    for (const p of foundationPieces) {
      foundationSet.add(snapKey(p.position.x, p.position.y, p.position.z));
    }

    const halfW = MODULE_SIZE / 2.0; // 1.0m
    const halfL = MODULE_SIZE / 2.0; // 1.0m
    const foundationHeight = 1.0; // 1.0m height
    const halfH = foundationHeight / 2.0; // 0.5m

    for (const piece of foundationPieces) {
      const px = piece.position.x;
      const py = piece.position.y;
      const pz = piece.position.z;

      const minX = px - halfW;
      const maxX = px + halfW;
      const minZ = pz - halfL;
      const maxZ = pz + halfL;
      const yTop = py + halfH;
      const yBase = py - halfH;

      const v_top_nw = new THREE.Vector3(minX, yTop, minZ);
      const v_top_ne = new THREE.Vector3(maxX, yTop, minZ);
      const v_top_se = new THREE.Vector3(maxX, yTop, maxZ);
      const v_top_sw = new THREE.Vector3(minX, yTop, maxZ);

      const v_bot_nw = new THREE.Vector3(minX, yBase, minZ);
      const v_bot_ne = new THREE.Vector3(maxX, yBase, minZ);
      const v_bot_se = new THREE.Vector3(maxX, yBase, maxZ);
      const v_bot_sw = new THREE.Vector3(minX, yBase, maxZ);

      const uMin = minX / STONE_TILE_SIZE;
      const uMax = maxX / STONE_TILE_SIZE;
      const vMin = minZ / STONE_TILE_SIZE;
      const vMax = maxZ / STONE_TILE_SIZE;

      // 1. Top Face
      vertexOffset = ContinuousWallSystem.appendQuad(
        v_top_nw, v_top_sw, v_top_se, v_top_ne,
        new THREE.Vector2(uMin, vMin),
        new THREE.Vector2(uMin, vMax),
        new THREE.Vector2(uMax, vMax),
        new THREE.Vector2(uMax, vMin),
        positions, normals, uvs, indices, vertexOffset,
        new THREE.Vector3(0, 1, 0)
      );

      // 2. Bottom Face - Correct downward normal winding order
      vertexOffset = ContinuousWallSystem.appendQuad(
        v_bot_nw, v_bot_ne, v_bot_se, v_bot_sw,
        new THREE.Vector2(uMin, vMin),
        new THREE.Vector2(uMax, vMin),
        new THREE.Vector2(uMax, vMax),
        new THREE.Vector2(uMin, vMax),
        positions, normals, uvs, indices, vertexOffset,
        new THREE.Vector3(0, -1, 0)
      );

      // 3. Side Perimeter Faces
      const hasNorthNeighbor = foundationSet.has(snapKey(px, py, pz - MODULE_SIZE));
      const hasSouthNeighbor = foundationSet.has(snapKey(px, py, pz + MODULE_SIZE));
      const hasEastNeighbor = foundationSet.has(snapKey(px + MODULE_SIZE, py, pz));
      const hasWestNeighbor = foundationSet.has(snapKey(px - MODULE_SIZE, py, pz));

      // North Face (-Z)
      if (!hasNorthNeighbor) {
        vertexOffset = ContinuousWallSystem.appendQuad(
          v_bot_nw, v_top_nw, v_top_ne, v_bot_ne,
          new THREE.Vector2(uMin, 0),
          new THREE.Vector2(uMin, foundationHeight / STONE_TILE_SIZE),
          new THREE.Vector2(uMax, foundationHeight / STONE_TILE_SIZE),
          new THREE.Vector2(uMax, 0),
          positions, normals, uvs, indices, vertexOffset,
          new THREE.Vector3(0, 0, -1)
        );
      }

      // South Face (+Z)
      if (!hasSouthNeighbor) {
        vertexOffset = ContinuousWallSystem.appendQuad(
          v_bot_se, v_top_se, v_top_sw, v_bot_sw,
          new THREE.Vector2(uMax, 0),
          new THREE.Vector2(uMax, foundationHeight / STONE_TILE_SIZE),
          new THREE.Vector2(uMin, foundationHeight / STONE_TILE_SIZE),
          new THREE.Vector2(uMin, 0),
          positions, normals, uvs, indices, vertexOffset,
          new THREE.Vector3(0, 0, 1)
        );
      }

      // East Face (+X)
      if (!hasEastNeighbor) {
        vertexOffset = ContinuousWallSystem.appendQuad(
          v_bot_ne, v_top_ne, v_top_se, v_bot_se,
          new THREE.Vector2(vMin, 0),
          new THREE.Vector2(vMin, foundationHeight / STONE_TILE_SIZE),
          new THREE.Vector2(vMax, foundationHeight / STONE_TILE_SIZE),
          new THREE.Vector2(vMax, 0),
          positions, normals, uvs, indices, vertexOffset,
          new THREE.Vector3(1, 0, 0)
        );
      }

      // West Face (-X)
      if (!hasWestNeighbor) {
        vertexOffset = ContinuousWallSystem.appendQuad(
          v_bot_sw, v_top_sw, v_top_nw, v_bot_nw,
          new THREE.Vector2(vMax, 0),
          new THREE.Vector2(vMax, foundationHeight / STONE_TILE_SIZE),
          new THREE.Vector2(vMin, foundationHeight / STONE_TILE_SIZE),
          new THREE.Vector2(vMin, 0),
          positions, normals, uvs, indices, vertexOffset,
          new THREE.Vector3(-1, 0, 0)
        );
      }
    }

    if (positions.length === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    return geo;
  }

  public dispose(): void {
    this.clearContinuousMeshes();
    this.unconfirmedWallPieceIds.clear();
    this.unconfirmedFloorPieceIds.clear();
    this.unconfirmedFoundationPieceIds.clear();
  }
}
