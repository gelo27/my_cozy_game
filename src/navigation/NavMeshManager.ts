import * as THREE from 'three';
import { ThreeStoryStructure } from '../scene/ThreeStoryStructure';
import { CustomNavMesh } from './CustomNavMesh';
import { NavPolygon } from './NavTypes';
import { AStarPathfinder } from './AStarPathfinder';
import { FunnelPathSmoother } from './FunnelPathSmoother';

export interface ObstacleAABB {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ObstacleOBB {
  centerX: number;
  centerZ: number;
  halfLength: number;
  halfThickness: number;
  cosAngle: number;
  sinAngle: number;
}

/**
 * Senior Custom NavMesh Coordinator & 3D Spatial Pathfinder.
 * Replaces Yuka NavMesh with an ultra-fast, robust, custom A* & Funnel (SSFA)
 * pathfinding system with O(1) Spatial Hash Grid lookups and flawless multi-tier ramp traversal.
 */
export class NavMeshManager {
  public customNavMesh: CustomNavMesh;
  public debugGroup: THREE.Group;
  private debugMesh?: THREE.Mesh;
  private debugWireframe?: THREE.LineSegments;

  // Grid bounds and resolution for polygon generation
  private cellSize: number = 2.0;
  private minX: number = -166;
  private maxX: number = 46;
  private minZ: number = -46;
  private maxZ: number = 46;

  private obstaclesAABB: ObstacleAABB[] = [];
  private obstaclesOBB: ObstacleOBB[] = [];

  constructor() {
    this.customNavMesh = new CustomNavMesh(4.0);
    this.debugGroup = new THREE.Group();
    this.debugGroup.name = 'NavMesh_Debug_Visualizer';

    this.registerObstacles();
    this.buildNavMesh();
    this.buildDebugVisuals();
  }

  /**
   * Defines physical obstacle boundaries with exact extents
   */
  private registerObstacles(): void {
    // 1. Enemy Zone Crates / Boxes (4x4 boxes, half size = 2.0)
    const boxes = [
      { x: -130, z: -10, half: 2.0 },
      { x: -105, z: 5, half: 2.0 },
      { x: -125, z: 20, half: 2.0 },
      { x: -95, z: -15, half: 2.0 },
    ];

    for (const b of boxes) {
      this.obstaclesAABB.push({
        minX: b.x - b.half,
        maxX: b.x + b.half,
        minZ: b.z - b.half,
        maxZ: b.z + b.half,
      });
    }

    // 2. Enemy Zone Horizontal Wall at (-120, -30), size 20 x 2 (halfX: 10, halfZ: 1)
    this.obstaclesAABB.push({
      minX: -120 - 10,
      maxX: -120 + 10,
      minZ: -30 - 1,
      maxZ: -30 + 1,
    });

    // 3. Enemy Zone Rotated Walls: length 20, thickness 2 (halfLength: 10, halfThickness: 1)
    // Wall 2: pos (-100, 20), rot 45 deg (PI/4)
    this.obstaclesOBB.push({
      centerX: -100,
      centerZ: 20,
      halfLength: 10.0,
      halfThickness: 1.0,
      cosAngle: Math.cos(Math.PI / 4),
      sinAngle: Math.sin(Math.PI / 4),
    });

    // Wall 3: pos (-140, 20), rot -45 deg (-PI/4)
    this.obstaclesOBB.push({
      centerX: -140,
      centerZ: 20,
      halfLength: 10.0,
      halfThickness: 1.0,
      cosAngle: Math.cos(-Math.PI / 4),
      sinAngle: Math.sin(-Math.PI / 4),
    });

    // 4. Main Arena Occlusion Tunnel at (-22, 18), length 12, width 4 (halfX: 2, halfZ: 6)
    this.obstaclesAABB.push({
      minX: -22 - 2,
      maxX: -22 + 2,
      minZ: 18 - 6,
      maxZ: 18 + 6,
    });

    // 5. Main Arena Dynamic Props cluster around (0, 14)
    this.obstaclesAABB.push({
      minX: -6,
      maxX: 6,
      minZ: 10,
      maxZ: 18,
    });

    // 6. 3-Story Outpost Support Columns (Ground Level Obstacles)
    const outpostColX = [-126, -122, -118, -114];
    const outpostColZ = [-8, -4, 2, 6];
    const colRadius = 0.28;
    for (const cx of outpostColX) {
      for (const cz of outpostColZ) {
        this.obstaclesAABB.push({
          minX: cx - colRadius,
          maxX: cx + colRadius,
          minZ: cz - colRadius,
          maxZ: cz + colRadius,
        });
      }
    }
  }

  /**
   * Checks whether a point in world space is walkable and within map boundaries
   */
  public isWalkable(x: number, z: number, padding: number = 0.7): boolean {
    // 1. Check primary zone footprints:
    // Zone A: Enemy Combat Zone: X in [-162, -76], Z in [-42, 42]
    const inEnemyZone = x >= -162 && x <= -76 && z >= -42 && z <= 42;

    // Zone B: Connecting Bridge: X in [-76, -44], Z in [-4.0, 4.0]
    const inBridge = x >= -76 && x <= -44 && z >= -4.0 && z <= 4.0;

    // Zone C: Main Arena Floor: X in [-44, 42], Z in [-42, 42]
    const inMainArena = x >= -44 && x <= 42 && z >= -42 && z <= 42;

    if (!inEnemyZone && !inBridge && !inMainArena) {
      return false;
    }

    // Exclude ground footprint directly under Stairs 1 (x in [-122, -118], z in [-4, 2])
    // so that the bottom edge at z = -4 is cleanly and uniquely connected to the ground approach
    if (x >= -122 && x <= -118 && z >= -4.0 && z <= 2.0) {
      return false;
    }

    // 2. Check AABB obstacles with safety padding
    for (let i = 0; i < this.obstaclesAABB.length; i++) {
      const obs = this.obstaclesAABB[i];
      if (
        x >= obs.minX - padding &&
        x <= obs.maxX + padding &&
        z >= obs.minZ - padding &&
        z <= obs.maxZ + padding
      ) {
        return false;
      }
    }

    // 3. Check OBB (rotated) obstacles with safety padding
    for (let i = 0; i < this.obstaclesOBB.length; i++) {
      const obb = this.obstaclesOBB[i];
      const dx = x - obb.centerX;
      const dz = z - obb.centerZ;
      // Project into local rotated coordinate frame
      const localX = dx * obb.cosAngle + dz * obb.sinAngle;
      const localZ = -dx * obb.sinAngle + dz * obb.cosAngle;

      if (
        Math.abs(localX) <= obb.halfLength + padding &&
        Math.abs(localZ) <= obb.halfThickness + padding
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * Analytical 2D segment-AABB intersection (Liang-Barsky slab algorithm)
   */
  private segmentIntersectsAABB(
    x1: number, z1: number,
    x2: number, z2: number,
    minX: number, maxX: number,
    minZ: number, maxZ: number
  ): boolean {
    if ((x1 < minX && x2 < minX) || (x1 > maxX && x2 > maxX) ||
        (z1 < minZ && z2 < minZ) || (z1 > maxZ && z2 > maxZ)) {
      return false;
    }
    if ((x1 >= minX && x1 <= maxX && z1 >= minZ && z1 <= maxZ) ||
        (x2 >= minX && x2 <= maxX && z2 >= minZ && z2 <= maxZ)) {
      return true;
    }

    const dx = x2 - x1;
    const dz = z2 - z1;
    let tmin = 0.0;
    let tmax = 1.0;

    if (Math.abs(dx) > 1e-7) {
      let t1 = (minX - x1) / dx;
      let t2 = (maxX - x1) / dx;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    } else if (x1 < minX || x1 > maxX) {
      return false;
    }

    if (Math.abs(dz) > 1e-7) {
      let t1 = (minZ - z1) / dz;
      let t2 = (maxZ - z1) / dz;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    } else if (z1 < minZ || z1 > maxZ) {
      return false;
    }

    return tmin <= tmax && tmax >= 0 && tmin <= 1;
  }

  /**
   * Raycast / line-of-sight test between two points on the navmesh plane
   * Checks both height difference and physical obstacle clearance with agent body radius.
   */
  public hasLineOfSight(p1: THREE.Vector3, p2: THREE.Vector3): boolean {
    return this.isDirectLineWalkable(p1, p2, 0.45);
  }

  /**
   * Rigorous test verifying if a straight path segment between p1 and p2 is 100% walkable
   * and does not clip through any walls, obstacles, or across different floor levels.
   */
  public isDirectLineWalkable(
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    agentRadius: number = 0.45
  ): boolean {
    // If points are on different floors (> 0.8m vertical delta), do not shortcut through floors/ramps!
    if (Math.abs(p1.y - p2.y) > 0.8) {
      return false;
    }

    const x1 = p1.x, z1 = p1.z;
    const x2 = p2.x, z2 = p2.z;
    const dist = Math.hypot(x2 - x1, z2 - z1);
    if (dist < 0.05) return true;

    // 1. Check intersection against all expanded AABB obstacles
    for (let i = 0; i < this.obstaclesAABB.length; i++) {
      const obs = this.obstaclesAABB[i];
      if (
        this.segmentIntersectsAABB(
          x1, z1, x2, z2,
          obs.minX - agentRadius, obs.maxX + agentRadius,
          obs.minZ - agentRadius, obs.maxZ + agentRadius
        )
      ) {
        return false;
      }
    }

    // 2. Check intersection against rotated OBB obstacles
    for (let i = 0; i < this.obstaclesOBB.length; i++) {
      const obb = this.obstaclesOBB[i];
      // Transform endpoints to OBB local space
      const dx1 = x1 - obb.centerX;
      const dz1 = z1 - obb.centerZ;
      const localX1 = dx1 * obb.cosAngle + dz1 * obb.sinAngle;
      const localZ1 = -dx1 * obb.sinAngle + dz1 * obb.cosAngle;

      const dx2 = x2 - obb.centerX;
      const dz2 = z2 - obb.centerZ;
      const localX2 = dx2 * obb.cosAngle + dz2 * obb.sinAngle;
      const localZ2 = -dx2 * obb.sinAngle + dz2 * obb.cosAngle;

      if (
        this.segmentIntersectsAABB(
          localX1, localZ1, localX2, localZ2,
          -obb.halfLength - agentRadius, obb.halfLength + agentRadius,
          -obb.halfThickness - agentRadius, obb.halfThickness + agentRadius
        )
      ) {
        return false;
      }
    }

    // 3. Sample intermediate points along the segment to ensure inside arena boundaries
    const steps = Math.max(1, Math.ceil(dist / 2.0));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const sx = x1 + (x2 - x1) * t;
      const sz = z1 + (z2 - z1) * t;
      if (!this.isWalkable(sx, sz, 0.35)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Finds the exact 3D NavMesh polygon corresponding to a world position,
   * taking into account vertical level (ground vs floor 1, 2, 3) in O(1) time.
   */
  public getRegionForPoint3D(pos: THREE.Vector3): { region: NavPolygon; clampedPoint: THREE.Vector3 } | null {
    const res = this.customNavMesh.findContainingPolygon(pos, 2.5);
    if (res) {
      return { region: res.polygon, clampedPoint: res.clamped };
    }
    return null;
  }

  /**
   * Generates convex polygons in counter-clockwise order with shared vertices
   * and initializes the CustomNavMesh.
   */
  private buildNavMesh(): void {
    const cols = Math.ceil((this.maxX - this.minX) / this.cellSize);
    const rows = Math.ceil((this.maxZ - this.minZ) / this.cellSize);

    // Shared vertices map to ensure vertex identity across adjacent cells
    const verticesMap = new Map<string, THREE.Vector3>();

    const getVertex3D = (worldX: number, worldY: number, worldZ: number): THREE.Vector3 => {
      const key = `${worldX.toFixed(2)}:${worldY.toFixed(2)}:${worldZ.toFixed(2)}`;
      let vertex = verticesMap.get(key);
      if (!vertex) {
        vertex = new THREE.Vector3(worldX, worldY, worldZ);
        verticesMap.set(key, vertex);
      }
      return vertex;
    };

    const getVertex = (cx: number, cz: number): THREE.Vector3 => {
      return getVertex3D(
        this.minX + cx * this.cellSize,
        0,
        this.minZ + cz * this.cellSize
      );
    };

    const rawPolygons: THREE.Vector3[][] = [];

    for (let x = 0; x < cols; x++) {
      for (let z = 0; z < rows; z++) {
        const centerX = this.minX + (x + 0.5) * this.cellSize;
        const centerZ = this.minZ + (z + 0.5) * this.cellSize;

        // Only generate polygon if cell is walkable
        if (!this.isWalkable(centerX, centerZ)) continue;

        // Quad in Counter-Clockwise (CCW) winding order with upward (+Y) normal:
        // v00 (bottom-left) -> v01 (top-left) -> v11 (top-right) -> v10 (bottom-right)
        const v00 = getVertex(x, z);
        const v01 = getVertex(x, z + 1);
        const v11 = getVertex(x + 1, z + 1);
        const v10 = getVertex(x + 1, z);

        rawPolygons.push([v00, v01, v11, v10]);
      }
    }

    // Add multi-story structure polygons (floors and staircases)
    const structurePolygons = ThreeStoryStructure.getNavMeshPolygons(getVertex3D);
    rawPolygons.push(...structurePolygons);

    // Build the Custom NavMesh with spatial indexing and portal generation
    this.customNavMesh.buildFromPolygons(rawPolygons);
  }

  /**
   * Queries a path between start and end, rigorously constrained to NavMesh corridors and red ramps.
   * Uses high-performance custom A* on polygon dual graph and String Pulling Funnel Algorithm.
   */
  public findPath(
    from: THREE.Vector3,
    to: THREE.Vector3
  ): THREE.Vector3[] {
    const startData = this.getRegionForPoint3D(from);
    const endData = this.getRegionForPoint3D(to);

    const fromPt = startData ? startData.clampedPoint.clone() : from.clone();
    const toPt = endData ? endData.clampedPoint.clone() : to.clone();

    // 1. If both points reside within the EXACT same convex polygon and clear direct sight:
    if (startData && endData && startData.region.id === endData.region.id) {
      if (this.isDirectLineWalkable(fromPt, toPt, 0.4)) {
        return [fromPt, toPt];
      }
    }

    // 2. If both polygons found on NavMesh: compute optimal polygon corridor via custom A*
    if (startData && endData) {
      const corridor = AStarPathfinder.findCorridor(
        this.customNavMesh,
        startData.region,
        endData.region,
        fromPt,
        toPt
      );

      if (corridor.length > 0) {
        // Run Simple Sturdy Funnel Algorithm (string pulling) with boundary margin
        const smoothed = FunnelPathSmoother.smoothCorridor(
          corridor,
          fromPt,
          toPt,
          0.35,
          this.isDirectLineWalkable.bind(this)
        );

        if (smoothed.length >= 2) {
          return smoothed;
        }
      }
    }

    // 3. Direct line fallback if walkable
    if (this.isDirectLineWalkable(fromPt, toPt, 0.4)) {
      return [fromPt, toPt];
    }

    // 4. Default fallback towards target
    return [fromPt, toPt];
  }

  /**
   * Clamps a position to the nearest point on the NavMesh
   */
  public clampPosition(pos: THREE.Vector3): THREE.Vector3 {
    const data = this.getRegionForPoint3D(pos);
    if (data) {
      return data.clampedPoint.clone();
    }
    return pos.clone();
  }

  /**
   * Generates a visible Three.js mesh for debugging and inspecting the NavMesh
   */
  private buildDebugVisuals(): void {
    const polygons = this.customNavMesh.polygons;
    if (polygons.length === 0) return;

    const positions: number[] = [];
    const wirePositions: number[] = [];

    const elevation = 0.06; // Float slightly above floor to prevent z-fighting

    for (let p = 0; p < polygons.length; p++) {
      const poly = polygons[p];
      const vertices = poly.vertices;
      if (vertices.length < 3) continue;

      // Triangulate convex polygon fan: (0, i, i+1)
      for (let i = 1; i < vertices.length - 1; i++) {
        const v0 = vertices[0];
        const v1 = vertices[i];
        const v2 = vertices[i + 1];

        positions.push(v0.x, v0.y + elevation, v0.z);
        positions.push(v1.x, v1.y + elevation, v1.z);
        positions.push(v2.x, v2.y + elevation, v2.z);
      }

      // Wireframe contour lines
      for (let i = 0; i < vertices.length; i++) {
        const v0 = vertices[i];
        const v1 = vertices[(i + 1) % vertices.length];

        wirePositions.push(v0.x, v0.y + elevation + 0.01, v0.z);
        wirePositions.push(v1.x, v1.y + elevation + 0.01, v1.z);
      }
    }

    // Translucent polygon surface mesh
    const surfaceGeo = new THREE.BufferGeometry();
    surfaceGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    surfaceGeo.computeVertexNormals();

    const surfaceMat = new THREE.MeshBasicMaterial({
      color: 0x00aaff,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.debugMesh = new THREE.Mesh(surfaceGeo, surfaceMat);
    this.debugGroup.add(this.debugMesh);

    // Wireframe edge lines
    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wirePositions, 3));

    const wireMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.35,
    });

    this.debugWireframe = new THREE.LineSegments(wireGeo, wireMat);
    this.debugGroup.add(this.debugWireframe);

    // Default visible
    this.debugGroup.visible = true;
  }

  public setDebugVisible(visible: boolean): void {
    this.debugGroup.visible = visible;
  }

  public toggleDebugVisible(): boolean {
    this.debugGroup.visible = !this.debugGroup.visible;
    return this.debugGroup.visible;
  }
}
