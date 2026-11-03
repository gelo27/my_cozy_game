import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { TextureGenerator } from './ProceduralTextures';

export interface ThreeStoryConfig {
  baseX: number;
  baseZ: number;
  floorHeight: number;
}

export const DEFAULT_STRUCTURE_CONFIG: ThreeStoryConfig = {
  baseX: -120,
  baseZ: -1,
  floorHeight: 3.5,
};

/**
 * ThreeStoryStructure
 * A 3-story tactical outpost architecture with interconnected staircases,
 * solid Rapier physics colliders, visual balustrades, support columns,
 * and high-fidelity multi-tier NavMesh connectivity.
 */
export class ThreeStoryStructure {
  public group: THREE.Group;
  private physics: PhysicsWorld;
  private config: ThreeStoryConfig;

  constructor(physics: PhysicsWorld, config: Partial<ThreeStoryConfig> = {}) {
    this.physics = physics;
    this.config = { ...DEFAULT_STRUCTURE_CONFIG, ...config };
    this.group = new THREE.Group();
    this.group.name = 'ThreeStoryStructure';

    this.buildArchitecture();
  }

  private buildArchitecture(): void {
    const floorMat = TextureGenerator.createZoneMaterial('floor');
    const accentMat = TextureGenerator.createZoneMaterial('accent');

    // High-visibility Crimson Red Ramp Texture
    const redRampMat = new THREE.MeshLambertMaterial({
      map: TextureGenerator.createCheckerTexture({
        primaryColor: '#ef4444', // Bright red
        secondaryColor: '#b91c1c', // Deep rich red
        gridLineColor: '#7f1d1d',
        tiles: 4,
        repeatU: 2,
        repeatV: 8,
      }),
    });

    const redCurbMat = new THREE.MeshLambertMaterial({
      color: 0x991b1b,
    });

    const columnMat = new THREE.MeshLambertMaterial({
      color: 0x334155,
    });

    const railMat = new THREE.MeshLambertMaterial({
      color: 0x94a3b8,
    });

    const deckThickness = 0.35;
    const fh = this.config.floorHeight; // 3.5m

    // ==========================================
    // 1. ARCHITECTURAL SUPPORT COLUMNS
    // ==========================================
    const columnRadius = 0.28;
    const totalHeight = fh * 3; // 10.5m
    const colXPositions = [-126, -122, -118, -114];
    const colZPositions = [-8, -4, 2, 6];

    for (const cx of colXPositions) {
      for (const cz of colZPositions) {
        // Create full-height concrete/steel architectural pillar
        const colGeo = new THREE.CylinderGeometry(columnRadius, columnRadius, totalHeight, 16);
        const colMesh = new THREE.Mesh(colGeo, columnMat);
        colMesh.position.set(cx, totalHeight / 2, cz);
        colMesh.castShadow = false;
        colMesh.receiveShadow = false;
        this.group.add(colMesh);

        this.physics.createStaticBox(
          new THREE.Vector3(cx, totalHeight / 2, cz),
          new THREE.Vector3(columnRadius * 2, totalHeight, columnRadius * 2)
        );
      }
    }

    // ==========================================
    // 2. FLOOR DECKS
    // ==========================================
    // Floor 1: North wing at Y = 3.5m, X in [-126, -114] (width 12m), Z in [2, 6] (depth 4m)
    const f1Center = new THREE.Vector3(-120, fh - deckThickness / 2, 4);
    const f1Size = new THREE.Vector3(12, deckThickness, 4);
    const f1Mesh = new THREE.Mesh(new THREE.BoxGeometry(f1Size.x, f1Size.y, f1Size.z), floorMat);
    f1Mesh.position.copy(f1Center);
    f1Mesh.receiveShadow = false;
    this.group.add(f1Mesh);
    this.physics.createStaticBox(f1Center, f1Size);

    // Floor 2: South wing at Y = 7.0m, X in [-126, -114] (width 12m), Z in [-8, -4] (depth 4m)
    const f2Center = new THREE.Vector3(-120, fh * 2 - deckThickness / 2, -6);
    const f2Size = new THREE.Vector3(12, deckThickness, 4);
    const f2Mesh = new THREE.Mesh(new THREE.BoxGeometry(f2Size.x, f2Size.y, f2Size.z), floorMat);
    f2Mesh.position.copy(f2Center);
    f2Mesh.receiveShadow = false;
    this.group.add(f2Mesh);
    this.physics.createStaticBox(f2Center, f2Size);

    // Floor 3 (Roof Observation Terrace): North wing at Y = 10.5m, X in [-126, -114], Z in [2, 6]
    const f3Center = new THREE.Vector3(-120, fh * 3 - deckThickness / 2, 4);
    const f3Size = new THREE.Vector3(12, deckThickness, 4);
    const f3Mesh = new THREE.Mesh(new THREE.BoxGeometry(f3Size.x, f3Size.y, f3Size.z), accentMat);
    f3Mesh.position.copy(f3Center);
    f3Mesh.receiveShadow = false;
    this.group.add(f3Mesh);
    this.physics.createStaticBox(f3Center, f3Size);

    // ==========================================
    // 3. SLEEK RED RAMPS (Zero blue steps, pure smooth crimson tactical ramps)
    // ==========================================
    const createRedRamp = (
      xMin: number,
      xMax: number,
      zStart: number,
      zEnd: number,
      yStart: number,
      yEnd: number
    ) => {
      const rampWidth = xMax - xMin;
      const xMid = (xMin + xMax) / 2;
      const zLength = Math.abs(zEnd - zStart);
      const zMid = (zStart + zEnd) / 2;
      const heightDelta = yEnd - yStart;
      const yMid = (yStart + yEnd) / 2;

      // Incline angle and total diagonal length
      const slopeAngle = Math.atan2(heightDelta, zEnd - zStart);
      const rampLength = Math.hypot(zLength, heightDelta);

      // Smooth physics collider for seamless character & bot movement
      const colliderThickness = 0.25;
      const rampCenter = new THREE.Vector3(xMid, yMid, zMid);
      const rampSize = new THREE.Vector3(rampWidth, colliderThickness, rampLength);
      this.physics.createStaticBox(
        rampCenter,
        rampSize,
        new THREE.Euler(-slopeAngle, 0, 0)
      );

      // Visual structural Crimson Red Ramp slab (smooth inclined surface)
      const rampGeo = new THREE.BoxGeometry(rampWidth - 0.06, colliderThickness, rampLength);
      const redRampMesh = new THREE.Mesh(rampGeo, redRampMat);
      redRampMesh.position.copy(rampCenter);
      redRampMesh.rotation.x = -slopeAngle;
      redRampMesh.receiveShadow = false;
      redRampMesh.castShadow = false;
      this.group.add(redRampMesh);

      // Side Curbs / Red Safety Edge trims
      const curbWidth = 0.08;
      const curbHeight = 0.16;
      const curbGeo = new THREE.BoxGeometry(curbWidth, curbHeight, rampLength);
      
      const leftCurb = new THREE.Mesh(curbGeo, redCurbMat);
      leftCurb.position.set(xMin + curbWidth / 2, yMid + curbHeight / 2, zMid);
      leftCurb.rotation.x = -slopeAngle;
      this.group.add(leftCurb);

      const rightCurb = new THREE.Mesh(curbGeo, redCurbMat);
      rightCurb.position.set(xMax - curbWidth / 2, yMid + curbHeight / 2, zMid);
      rightCurb.rotation.x = -slopeAngle;
      this.group.add(rightCurb);

      // Safety Side Handrails
      const railH = 0.9;
      const railGeo = new THREE.CylinderGeometry(0.035, 0.035, rampLength, 8);
      
      const leftRail = new THREE.Mesh(railGeo, railMat);
      leftRail.position.set(xMin + 0.06, yMid + railH, zMid);
      leftRail.rotation.x = -slopeAngle + Math.PI / 2;
      this.group.add(leftRail);

      const rightRail = new THREE.Mesh(railGeo, railMat);
      rightRail.position.set(xMax - 0.06, yMid + railH, zMid);
      rightRail.rotation.x = -slopeAngle + Math.PI / 2;
      this.group.add(rightRail);
    };

    // Ramp 1: Ground (Y=0, Z=-4) -> Floor 1 (Y=3.5, Z=2), X in [-122, -118]
    createRedRamp(-122, -118, -4, 2, 0, fh);

    // Ramp 2: Floor 1 (Y=3.5, Z=2) -> Floor 2 (Y=7.0, Z=-4), X in [-126, -122]
    createRedRamp(-126, -122, 2, -4, fh, fh * 2);

    // Ramp 3: Floor 2 (Y=7.0, Z=-4) -> Floor 3 Roof (Y=10.5, Z=2), X in [-118, -114]
    createRedRamp(-118, -114, -4, 2, fh * 2, fh * 3);

    // ==========================================
    // 4. BALUSTRADES / SAFETY RAILINGS ON DECKS
    // ==========================================
    const createDeckRailing = (pos: THREE.Vector3, size: THREE.Vector3) => {
      const rMesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), railMat);
      rMesh.position.copy(pos);
      rMesh.castShadow = false;
      rMesh.receiveShadow = false;
      this.group.add(rMesh);
      this.physics.createStaticBox(pos, size);
    };

    const railHeight = 1.0;
    const railThick = 0.12;

    // Floor 1 perimeter railings (leave openings for stairs):
    // North edge:
    createDeckRailing(new THREE.Vector3(-120, fh + railHeight / 2, 6), new THREE.Vector3(12, railHeight, railThick));
    // East edge:
    createDeckRailing(new THREE.Vector3(-114, fh + railHeight / 2, 4), new THREE.Vector3(railThick, railHeight, 4));

    // Floor 2 perimeter railings:
    // South edge:
    createDeckRailing(new THREE.Vector3(-120, fh * 2 + railHeight / 2, -8), new THREE.Vector3(12, railHeight, railThick));
    // East edge:
    createDeckRailing(new THREE.Vector3(-114, fh * 2 + railHeight / 2, -6), new THREE.Vector3(railThick, railHeight, 4));

    // Floor 3 Roof perimeter railings:
    createDeckRailing(new THREE.Vector3(-120, fh * 3 + railHeight / 2, 6), new THREE.Vector3(12, railHeight, railThick));
    createDeckRailing(new THREE.Vector3(-114, fh * 3 + railHeight / 2, 4), new THREE.Vector3(railThick, railHeight, 4));
    createDeckRailing(new THREE.Vector3(-126, fh * 3 + railHeight / 2, 4), new THREE.Vector3(railThick, railHeight, 4));
  }

  /**
   * Generates continuous CCW NavMesh polygons for the 3 floors and 3 staircases,
   * matching vertices with the ground navmesh grid.
   */
  public static getNavMeshPolygons(
    getVertex: (x: number, y: number, z: number) => THREE.Vector3
  ): THREE.Vector3[][] {
    const polys: THREE.Vector3[][] = [];
    const fh = DEFAULT_STRUCTURE_CONFIG.floorHeight; // 3.5

    // Helper for horizontal planar quads with upward (+Y) normal
    const addPlanar = (x0: number, x1: number, z0: number, z1: number, y: number) => {
      const v00 = getVertex(x0, y, z0);
      const v01 = getVertex(x0, y, z1);
      const v11 = getVertex(x1, y, z1);
      const v10 = getVertex(x1, y, z0);
      polys.push([v00, v01, v11, v10]);
    };

    // Helper for +Z ramp (ascends from z0 to z1) with upward normal
    const addRampPlusZ = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number) => {
      const v00 = getVertex(x0, y0, z0);
      const v01 = getVertex(x0, y1, z1);
      const v11 = getVertex(x1, y1, z1);
      const v10 = getVertex(x1, y0, z0);
      polys.push([v00, v01, v11, v10]);
    };

    // Helper for -Z ramp (ascends from z0 to z1) with upward normal
    const addRampMinusZ = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number) => {
      const v00 = getVertex(x1, y0, z0);
      const v01 = getVertex(x1, y1, z1);
      const v11 = getVertex(x0, y1, z1);
      const v10 = getVertex(x0, y0, z0);
      polys.push([v00, v01, v11, v10]);
    };

    // ==============================================================
    // 1. STAIRS 1: Ground (Y=0, Z=-4) -> Floor 1 (Y=3.5, Z=2)
    // Connects seamlessly to 2m ground cells at Z = -4
    // ==============================================================
    addRampPlusZ(-122, -120, -4, 2, 0, fh);
    addRampPlusZ(-120, -118, -4, 2, 0, fh);

    // ==============================================================
    // 2. FLOOR 1: Deck at Y = 3.5, Z in [2, 6]
    // ==============================================================
    addPlanar(-122, -120, 2, 6, fh); // Center-west landing from Stairs 1
    addPlanar(-120, -118, 2, 6, fh); // Center-east landing from Stairs 1
    addPlanar(-126, -122, 2, 6, fh); // West deck towards Stairs 2
    addPlanar(-118, -114, 2, 6, fh); // East balcony

    // ==============================================================
    // 3. STAIRS 2: Floor 1 (Y=3.5, Z=2) -> Floor 2 (Y=7.0, Z=-4)
    // Runs in -Z along West side: X in [-126, -122]
    // ==============================================================
    addRampMinusZ(-126, -122, 2, -4, fh, fh * 2);

    // ==============================================================
    // 4. FLOOR 2: Deck at Y = 7.0, Z in [-8, -4]
    // 3 tiles: West [-126, -122], Center [-122, -118], East [-118, -114]
    // ==============================================================
    addPlanar(-126, -122, -8, -4, fh * 2); // West landing from Stairs 2
    addPlanar(-122, -118, -8, -4, fh * 2); // Center gallery
    addPlanar(-118, -114, -8, -4, fh * 2); // East deck towards Stairs 3

    // ==============================================================
    // 5. STAIRS 3: Floor 2 (Y=7.0, Z=-4) -> Floor 3 Roof (Y=10.5, Z=2)
    // Runs in +Z along East side: X in [-118, -114]
    // ==============================================================
    addRampPlusZ(-118, -114, -4, 2, fh * 2, fh * 3);

    // ==============================================================
    // 6. FLOOR 3 (ROOF TERRACE): Deck at Y = 10.5, Z in [2, 6]
    // 3 tiles: West [-126, -122], Center [-122, -118], East [-118, -114]
    // ==============================================================
    addPlanar(-118, -114, 2, 6, fh * 3); // East landing from Stairs 3
    addPlanar(-122, -118, 2, 6, fh * 3); // Center observation deck
    addPlanar(-126, -122, 2, 6, fh * 3); // West vantage point

    return polys;
  }
}
