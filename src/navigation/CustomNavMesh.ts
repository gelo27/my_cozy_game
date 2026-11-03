import * as THREE from 'three';
import { NavPolygon, NavPortal, NavAABB } from './NavTypes';
import { NavGeometry } from './NavGeometry';
import { SpatialHashGrid } from './SpatialHashGrid';

export class CustomNavMesh {
  public polygons: NavPolygon[] = [];
  public spatialGrid: SpatialHashGrid;
  private nextPolyId: number = 1;

  constructor(gridCellSize: number = 4.0) {
    this.spatialGrid = new SpatialHashGrid(gridCellSize);
  }

  public clear(): void {
    this.polygons = [];
    this.spatialGrid.clear();
    this.nextPolyId = 1;
  }

  /**
   * Builds the navigation mesh and graph topology from a list of raw convex 3D polygon vertex arrays.
   */
  public buildFromPolygons(rawPolygons: THREE.Vector3[][]): void {
    this.clear();

    // 1. Create NavPolygon instances with geometry metadata
    for (let i = 0; i < rawPolygons.length; i++) {
      const vertices = rawPolygons[i];
      if (vertices.length < 3) continue;

      const poly = this.createPolygon(vertices);
      this.polygons.push(poly);
      this.spatialGrid.insert(poly);
    }

    // 2. Build adjacency graph and portals across matching/overlapping edges
    this.buildPortals();
  }

  private createPolygon(vertices: THREE.Vector3[]): NavPolygon {
    const id = this.nextPolyId++;
    const vCount = vertices.length;

    // Centroid
    const centroid = new THREE.Vector3();
    for (let i = 0; i < vCount; i++) {
      centroid.add(vertices[i]);
    }
    centroid.divideScalar(vCount);

    // Normal using Newell's method for robust 3D plane fitting
    const normal = new THREE.Vector3();
    for (let i = 0; i < vCount; i++) {
      const cur = vertices[i];
      const next = vertices[(i + 1) % vCount];
      normal.x += (cur.y - next.y) * (cur.z + next.z);
      normal.y += (cur.z - next.z) * (cur.x + next.x);
      normal.z += (cur.x - next.x) * (cur.y + next.y);
    }
    normal.normalize();

    // Ensure normal points upward (+Y) for walkable surface
    if (normal.y < 0) {
      normal.negate();
    }

    const planeD = -normal.dot(vertices[0]);

    // AABB
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (let i = 0; i < vCount; i++) {
      const v = vertices[i];
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.z > maxZ) maxZ = v.z;
    }

    const aabb: NavAABB = { minX, maxX, minY, maxY, minZ, maxZ };

    return {
      id,
      vertices: vertices.map(v => v.clone()),
      centroid,
      normal,
      planeD,
      aabb,
      portals: [],
    };
  }

  /**
   * Efficiently links adjacent polygons with portals using the Spatial Hash Grid.
   */
  private buildPortals(): void {
    const edgeMid = new THREE.Vector3();

    for (let i = 0; i < this.polygons.length; i++) {
      const polyA = this.polygons[i];
      const vCountA = polyA.vertices.length;

      for (let ea = 0; ea < vCountA; ea++) {
        const a1 = polyA.vertices[ea];
        const a2 = polyA.vertices[(ea + 1) % vCountA];
        edgeMid.copy(a1).add(a2).multiplyScalar(0.5);

        // Fetch candidate neighbors in spatial cell around edge midpoint
        const candidates = this.spatialGrid.getCandidates(edgeMid.x, edgeMid.z, 2.5);

        for (let c = 0; c < candidates.length; c++) {
          const polyB = candidates[c];
          if (polyB.id === polyA.id) continue;

          // Check if already connected
          let alreadyConnected = false;
          for (let p = 0; p < polyA.portals.length; p++) {
            if (polyA.portals[p].toPolyId === polyB.id) {
              alreadyConnected = true;
              break;
            }
          }
          if (alreadyConnected) continue;

          // Vertical tier compatibility check
          if (Math.abs(polyA.centroid.y - polyB.centroid.y) > 4.5) continue;

          const vCountB = polyB.vertices.length;
          for (let eb = 0; eb < vCountB; eb++) {
            const b1 = polyB.vertices[eb];
            const b2 = polyB.vertices[(eb + 1) % vCountB];

            const overlap = NavGeometry.findSegmentOverlap3D(a1, a2, b1, b2, 0.15, 0.12);
            if (overlap) {
              this.createBidirectionalPortals(polyA, polyB, overlap.p1, overlap.p2);
              break;
            }
          }
        }
      }
    }
  }

  private createBidirectionalPortals(
    polyA: NavPolygon,
    polyB: NavPolygon,
    segP1: THREE.Vector3,
    segP2: THREE.Vector3
  ): void {
    const midpoint = new THREE.Vector3().copy(segP1).add(segP2).multiplyScalar(0.5);
    const width = segP1.distanceTo(segP2);
    const cost = polyA.centroid.distanceTo(midpoint) + midpoint.distanceTo(polyB.centroid);

    // Transition vector from polyA to polyB
    const transAX = polyB.centroid.x - polyA.centroid.x;
    const transAZ = polyB.centroid.z - polyA.centroid.z;

    // Determine which vertex is to the left of the transition direction from polyA to polyB
    // NavGeometry.turn(transAX, transAZ, Px - Ax, Pz - Az) > 0 means P is to the left (CCW turn)
    const d1TurnA = NavGeometry.turn(transAX, transAZ, segP1.x - polyA.centroid.x, segP1.z - polyA.centroid.z);
    const d2TurnA = NavGeometry.turn(transAX, transAZ, segP2.x - polyA.centroid.x, segP2.z - polyA.centroid.z);

    const leftA = d1TurnA >= d2TurnA ? segP1.clone() : segP2.clone();
    const rightA = d1TurnA >= d2TurnA ? segP2.clone() : segP1.clone();

    // From polyB towards polyA:
    const transBX = -transAX;
    const transBZ = -transAZ;
    const d1TurnB = NavGeometry.turn(transBX, transBZ, segP1.x - polyB.centroid.x, segP1.z - polyB.centroid.z);
    const d2TurnB = NavGeometry.turn(transBX, transBZ, segP2.x - polyB.centroid.x, segP2.z - polyB.centroid.z);

    const leftB = d1TurnB >= d2TurnB ? segP1.clone() : segP2.clone();
    const rightB = d1TurnB >= d2TurnB ? segP2.clone() : segP1.clone();

    const portalAtoB: NavPortal = {
      fromPolyId: polyA.id,
      toPolyId: polyB.id,
      left: leftA,
      right: rightA,
      midpoint: midpoint.clone(),
      width,
      cost,
    };

    const portalBtoA: NavPortal = {
      fromPolyId: polyB.id,
      toPolyId: polyA.id,
      left: leftB,
      right: rightB,
      midpoint: midpoint.clone(),
      width,
      cost,
    };

    polyA.portals.push(portalAtoB);
    polyB.portals.push(portalBtoA);
  }

  public getPolygon(id: number): NavPolygon | undefined {
    return this.polygons.find(p => p.id === id);
  }

  public findContainingPolygon(
    p: THREE.Vector3,
    maxVerticalDelta: number = 2.5
  ): { polygon: NavPolygon; clamped: THREE.Vector3 } | null {
    return this.spatialGrid.findContainingPolygon(p, maxVerticalDelta);
  }
}
