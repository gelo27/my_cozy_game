import * as THREE from 'three';
import { NavPolygon } from './NavTypes';
import { NavGeometry } from './NavGeometry';

/**
 * 2D Spatial Hash Grid for high-performance O(1) NavMesh polygon queries.
 * Partitioning by XZ coordinates with height-tier discrimination.
 */
export class SpatialHashGrid {
  private cellSize: number;
  private invCellSize: number;
  private grid: Map<string, NavPolygon[]> = new Map();

  constructor(cellSize: number = 4.0) {
    this.cellSize = cellSize;
    this.invCellSize = 1.0 / cellSize;
  }

  private getKey(cellX: number, cellZ: number): string {
    return `${cellX},${cellZ}`;
  }

  public clear(): void {
    this.grid.clear();
  }

  /**
   * Inserts a polygon into all cells overlapped by its bounding box.
   */
  public insert(polygon: NavPolygon): void {
    const minCX = Math.floor(polygon.aabb.minX * this.invCellSize);
    const maxCX = Math.floor(polygon.aabb.maxX * this.invCellSize);
    const minCZ = Math.floor(polygon.aabb.minZ * this.invCellSize);
    const maxCZ = Math.floor(polygon.aabb.maxZ * this.invCellSize);

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        const key = this.getKey(cx, cz);
        let list = this.grid.get(key);
        if (!list) {
          list = [];
          this.grid.set(key, list);
        }
        if (!list.includes(polygon)) {
          list.push(polygon);
        }
      }
    }
  }

  /**
   * Retrieves all candidate polygons in cells around (x, z) within radius.
   */
  public getCandidates(x: number, z: number, searchRadius: number = 1): NavPolygon[] {
    const baseCX = Math.floor(x * this.invCellSize);
    const baseCZ = Math.floor(z * this.invCellSize);
    const cellRadius = Math.ceil(searchRadius * this.invCellSize);

    const candidates: NavPolygon[] = [];
    const visitedIds = new Set<number>();

    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dz = -cellRadius; dz <= cellRadius; dz++) {
        const list = this.grid.get(this.getKey(baseCX + dx, baseCZ + dz));
        if (list) {
          for (let i = 0; i < list.length; i++) {
            const poly = list[i];
            if (!visitedIds.has(poly.id)) {
              visitedIds.add(poly.id);
              candidates.push(poly);
            }
          }
        }
      }
    }

    return candidates;
  }

  /**
   * Finds the exact polygon that contains point p horizontally (XZ)
   * and matches vertically within maxVerticalDelta.
   */
  public findContainingPolygon(p: THREE.Vector3, maxVerticalDelta: number = 2.5): { polygon: NavPolygon; clamped: THREE.Vector3 } | null {
    const candidates = this.getCandidates(p.x, p.z, this.cellSize);
    if (candidates.length === 0) return null;

    let bestPoly: NavPolygon | null = null;
    let minVertDelta = Infinity;
    const tempProj = new THREE.Vector3();
    const clamped = new THREE.Vector3();

    // Phase 1: Direct 2D footprint containment
    for (let i = 0; i < candidates.length; i++) {
      const poly = candidates[i];
      if (NavGeometry.pointInConvexPolygon2D(p.x, p.z, poly.vertices)) {
        NavGeometry.projectPointToPlane(p, poly.normal, poly.planeD, tempProj);
        const vertDelta = Math.abs(tempProj.y - p.y);
        if (vertDelta <= maxVerticalDelta && vertDelta < minVertDelta) {
          minVertDelta = vertDelta;
          bestPoly = poly;
          clamped.copy(tempProj);
        }
      }
    }

    if (bestPoly) {
      return { polygon: bestPoly, clamped };
    }

    // Phase 2: Closest polygon within tier (e.g. if slightly off edge or near wall)
    let minDistanceSq = Infinity;
    const tempClosest = new THREE.Vector3();

    for (let i = 0; i < candidates.length; i++) {
      const poly = candidates[i];
      // Vertical tier sanity check
      if (Math.abs(poly.centroid.y - p.y) <= maxVerticalDelta + 1.0) {
        NavGeometry.closestPointOnPolygon3D(p, poly, tempClosest);
        const distSq = p.distanceToSquared(tempClosest);
        if (distSq < minDistanceSq && Math.abs(tempClosest.y - p.y) <= maxVerticalDelta) {
          minDistanceSq = distSq;
          bestPoly = poly;
          clamped.copy(tempClosest);
        }
      }
    }

    if (bestPoly && minDistanceSq < 9.0) { // within 3.0m
      return { polygon: bestPoly, clamped };
    }

    return null;
  }
}
