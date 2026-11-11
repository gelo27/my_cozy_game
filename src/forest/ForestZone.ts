import * as THREE from 'three';
import { withSnowCover } from '../world/SnowCover';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { COLLISION_GROUPS } from '../config/constants';
import { ParticleManager } from '../particles/ParticleManager';
import { audioEngine } from '../audio/AudioEngine';

export interface TreeData {
  id: number;
  position: THREE.Vector3;
  rotationY: number;
  scale: number;
  trunkHeight: number;
  trunkRadius: number;
  maxHealth: number;
  health: number;
  isFelled: boolean;
  staticBody: RAPIER.RigidBody;
  staticCollider: RAPIER.Collider;
  treeGroup: THREE.Group;
  trunkMesh: THREE.Mesh;
  wobbleAngle: number;
  wobbleVelocity: number;
  wobbleAxis: THREE.Vector3;
  notchAngle?: number;
  // Stump left after felling, removed again when the tree regrows
  stumpMesh?: THREE.Mesh;
  stumpBody?: RAPIER.RigidBody;
  regrowAt?: number;
  growProgress?: number;
}

export interface ForestZoneOptions {
  /** Plant trees at these spots instead of building the separate forest platform. */
  treeSpots?: { position: THREE.Vector3; scale: number }[];
  /** Felled trees grow back after this many seconds (never when omitted). */
  regrowSeconds?: number;
  /** Wood given when a fallen trunk is split; when set, wood goes to this callback instead of spawning log props. */
  woodPerTree?: number;
  onWoodHarvested?: (amount: number, at: THREE.Vector3) => void;
}

/** What the player is aiming the axe at, for prompts. */
export interface ForestTarget {
  kind: 'tree' | 'fallen';
  position: THREE.Vector3;
  radius: number;
  health: number;
  maxHealth: number;
}

export interface FallenTree {
  id: number;
  group: THREE.Group;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  hasHitGround: boolean;
  spawnTime: number;
  hitsToSplit: number;
  length: number;
  radius: number;
}

export interface WoodLog {
  group: THREE.Group;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

export class ForestZone {
  public group: THREE.Group;
  private physics: PhysicsWorld;
  private particleManager: ParticleManager | null;

  // Platform properties (same 90x90 size as First Platform)
  public static readonly PLATFORM_SIZE = 90;
  public static readonly PLATFORM_CENTER = new THREE.Vector3(0, 0, 120);

  // Tree collections
  private trees: TreeData[] = [];
  private fallenTrees: FallenTree[] = [];
  private woodLogs: WoodLog[] = [];
  private stumpsGroup: THREE.Group;

  // Shared geometries & materials for supreme performance
  private sharedTrunkGeos: THREE.BufferGeometry[] = [];
  private sharedTrunkGeo: THREE.BufferGeometry;
  private sharedFoliageConeGeo1: THREE.ConeGeometry;
  private sharedFoliageConeGeo2: THREE.ConeGeometry;
  private sharedFoliageConeGeo3: THREE.ConeGeometry;
  private sharedStumpGeo: THREE.CylinderGeometry;
  private sharedLogGeo: THREE.CylinderGeometry;

  private barkMaterial: THREE.MeshLambertMaterial;
  private freshWoodMaterial: THREE.MeshLambertMaterial;
  private stumpTopMaterial: THREE.MeshLambertMaterial;
  private foliageMaterial1: THREE.MeshLambertMaterial;
  private foliageMaterial2: THREE.MeshLambertMaterial;
  private foliageMaterial3: THREE.MeshLambertMaterial;
  private woodLogMaterial: THREE.MeshLambertMaterial;

  constructor(
    physics: PhysicsWorld,
    scene: THREE.Scene,
    parentGroup: THREE.Object3D,
    particleManager: ParticleManager | null,
    private options: ForestZoneOptions = {}
  ) {
    this.physics = physics;
    this.particleManager = particleManager;

    this.group = new THREE.Group();
    this.group.name = 'ForestZone_ZeldaBotW';
    parentGroup.add(this.group);

    this.stumpsGroup = new THREE.Group();
    this.stumpsGroup.name = 'TreeStumps';
    this.group.add(this.stumpsGroup);

    // Initialize shared materials with Zelda BotW color aesthetics
    this.barkMaterial = new THREE.MeshLambertMaterial({
      color: 0x4a2e1b, // Rich deep cedar bark
      });

    // Freshly exposed cut wood for chopping notch progress (stages 1 & 2) in Zelda BotW style
    this.freshWoodMaterial = new THREE.MeshLambertMaterial({
      color: 0xf5c87a, // Zelda BotW warm bright amber/pine wood core
      flatShading: true, // Crisp hand-chopped faceted look
      side: THREE.DoubleSide, // Always visible from all angles
    });

    // Pre-baked visual tree trunk stages matching user specification:
    // Stage 0: Clean pristine trunk
    // Stage 1: Figure 1 - Initial wedge cut on strike side
    // Stage 2: Figure 2 - Hourglass waist with bilateral V-notches and neck
    // Stage 3: Figure 3 - Deep "X" hourglass cross before felling
    this.sharedTrunkGeos = [];
    for (let stage = 0; stage <= 3; stage++) {
      this.sharedTrunkGeos.push(this.createNotchedTrunkGeometry(0.44, 0.58, 9.0, 16, stage));
    }
    this.sharedTrunkGeo = this.sharedTrunkGeos[0];

    this.sharedFoliageConeGeo1 = new THREE.ConeGeometry(4.2, 4.2, 8);
    this.sharedFoliageConeGeo2 = new THREE.ConeGeometry(3.3, 3.6, 8);
    this.sharedFoliageConeGeo3 = new THREE.ConeGeometry(2.3, 2.9, 7);
    this.sharedStumpGeo = new THREE.CylinderGeometry(0.52, 0.60, 0.50, 10);
    this.sharedLogGeo = new THREE.CylinderGeometry(0.24, 0.24, 1.3, 8);

    // Stump top with tree-rings concentric texture generated procedurally
    this.stumpTopMaterial = new THREE.MeshLambertMaterial({
      color: 0xd2b48c, // Tan wood interior
      });

    this.foliageMaterial1 = withSnowCover(new THREE.MeshLambertMaterial({
      color: 0x2e6f40, // BotW forest deep evergreen
      flatShading: true,
    }));

    this.foliageMaterial2 = withSnowCover(new THREE.MeshLambertMaterial({
      color: 0x3d8b4e, // BotW vibrant mid leaf
      flatShading: true,
    }));

    this.foliageMaterial3 = withSnowCover(new THREE.MeshLambertMaterial({
      color: 0x5ab16b, // BotW bright canopy crown
      flatShading: true,
    }));

    this.woodLogMaterial = new THREE.MeshLambertMaterial({
      color: 0x8a5530,
      });

    if (options.treeSpots) {
      this.plantTreeSpots(options.treeSpots);
    } else {
      this.buildPlatformAndBridge();
      this.spawnForestTrees();
    }
  }

  private plantTreeSpots(spots: { position: THREE.Vector3; scale: number }[]): void {
    spots.forEach((spot, id) => {
      this.createTreeInstance(id, spot.position.clone(), spot.scale, 0.48 * spot.scale, 9.0 * spot.scale);
    });
  }

  /**
   * Read-only lookup of the standing tree or fallen trunk within `reach` of `point`
   * (same hit volumes as checkHit with isAxe = true).
   */
  public findTarget(point: THREE.Vector3, reach: number): ForestTarget | null {
    let best: ForestTarget | null = null;
    let bestDist = Infinity;

    for (const tree of this.trees) {
      if (tree.isFelled) continue;
      const dist = Math.hypot(point.x - tree.position.x, point.z - tree.position.z) - tree.trunkRadius;
      if (dist <= reach && dist < bestDist) {
        bestDist = dist;
        best = { kind: 'tree', position: tree.position.clone(), radius: tree.trunkRadius, health: tree.health, maxHealth: tree.maxHealth };
      }
    }

    for (const fallen of this.fallenTrees) {
      if (!fallen.body.isValid()) continue;
      const t = fallen.body.translation();
      const center = new THREE.Vector3(t.x, t.y, t.z);
      // Distance to the trunk's axis segment
      const r = fallen.body.rotation();
      const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
      const along = THREE.MathUtils.clamp(point.clone().sub(center).dot(axis), -fallen.length / 2, fallen.length / 2);
      const closest = center.clone().addScaledVector(axis, along);
      const dist = Math.hypot(point.x - closest.x, point.z - closest.z) - fallen.radius;
      if (dist <= reach && dist < bestDist) {
        bestDist = dist;
        best = { kind: 'fallen', position: closest, radius: fallen.radius, health: fallen.hitsToSplit, maxHealth: 1 };
      }
    }

    return best;
  }

  /** Standing trees (for baked ground shadows): base position and trunk height. */
  public forEachStandingTree(fn: (pos: THREE.Vector3, trunkHeight: number) => void): void {
    for (const t of this.trees) if (!t.isFelled) fn(t.position, t.trunkHeight);
  }

  public setParticleManager(pm: ParticleManager): void {
    this.particleManager = pm;
  }

  /**
   * Builds the 90x90m Forest Floor and the grand connecting bridge from Main Floor
   */
  private buildPlatformAndBridge(): void {
    const center = ForestZone.PLATFORM_CENTER;
    const size = ForestZone.PLATFORM_SIZE; // 90m
    const thickness = 2.0;

    // 1. Forest Ground Platform (90x90)
    const groundGeo = new THREE.BoxGeometry(size, thickness, size);
    const groundMat = new THREE.MeshLambertMaterial({
      color: 0x28492e, // Deep lush forest floor green / moss
      });
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.position.set(center.x, center.y - thickness / 2, center.z);

    this.group.add(groundMesh);

    // Static physics box for forest floor
    this.physics.createStaticBox(
      groundMesh.position,
      new THREE.Vector3(size, thickness, size),
      new THREE.Euler(),
      COLLISION_GROUPS.ENVIRONMENT
    );

    // 2. Connecting Bridge from Main Floor (Z = 45) to Forest Floor (Z = 75)
    // Span length: 30m, width: 14m, center Z: 60m
    const bridgeLength = 30.0;
    const bridgeWidth = 14.0;
    const bridgeThick = 1.0;
    const bridgeCenter = new THREE.Vector3(0, -bridgeThick / 2, 60);

    const bridgeGeo = new THREE.BoxGeometry(bridgeWidth, bridgeThick, bridgeLength);
    const bridgeMat = new THREE.MeshLambertMaterial({
      color: 0x5a3e26, // Weathered rustic wooden timber bridge
      });
    const bridgeMesh = new THREE.Mesh(bridgeGeo, bridgeMat);
    bridgeMesh.position.copy(bridgeCenter);

    this.group.add(bridgeMesh);

    this.physics.createStaticBox(
      bridgeCenter,
      new THREE.Vector3(bridgeWidth, bridgeThick, bridgeLength),
      new THREE.Euler(),
      COLLISION_GROUPS.ENVIRONMENT
    );

    // Decorative bridge planks and side railings
    const plankMat = new THREE.MeshLambertMaterial({ color: 0x3d2918, });
    for (let z = 46.5; z <= 73.5; z += 2.5) {
      const plankGeo = new THREE.BoxGeometry(bridgeWidth + 0.4, 0.12, 0.5);
      const plank = new THREE.Mesh(plankGeo, plankMat);
      plank.position.set(0, 0.06, z);
      this.group.add(plank);

      // Side railing posts with warm lantern heads
      [-bridgeWidth / 2 - 0.2, bridgeWidth / 2 + 0.2].forEach((xSide) => {
        const postGeo = new THREE.CylinderGeometry(0.12, 0.14, 1.3, 6);
        const post = new THREE.Mesh(postGeo, plankMat);
        post.position.set(xSide, 0.65, z);
        this.group.add(post);

        // Torch glow head
        const lanternGeo = new THREE.BoxGeometry(0.24, 0.28, 0.24);
        const lanternMat = new THREE.MeshBasicMaterial({ color: 0xffaa33 });
        const lantern = new THREE.Mesh(lanternGeo, lanternMat);
        lantern.position.set(xSide, 1.3, z);
        this.group.add(lantern);
      });
    }

    // Connecting horizontal rope rails on bridge
    [-bridgeWidth / 2 - 0.2, bridgeWidth / 2 + 0.2].forEach((xSide) => {
      const ropeGeo = new THREE.CylinderGeometry(0.05, 0.05, bridgeLength, 6);
      const ropeMat = new THREE.MeshLambertMaterial({ color: 0x8b6508, });
      const rope = new THREE.Mesh(ropeGeo, ropeMat);
      rope.rotation.x = Math.PI / 2;
      rope.position.set(xSide, 0.95, 60);
      this.group.add(rope);

      // Add static collider for bridge railings to prevent falling off
      this.physics.createStaticBox(
        new THREE.Vector3(xSide, 0.6, 60),
        new THREE.Vector3(0.4, 1.2, bridgeLength),
        new THREE.Euler(),
        COLLISION_GROUPS.ENVIRONMENT
      );
    });

    // 3. Welcome Archway & Signpost at Forest Entrance (0, 0, 76)
    this.buildForestEntranceSign(new THREE.Vector3(0, 0, 77));

    // 4. Perimeter Rustic Wooden Fence around Forest Floor (with opening at entrance)
    this.buildPerimeterFence(center, size);

    // 5. Environmental details (rocks, wild flowers, moss mounds)
    this.buildEnvironmentalDetails(center, size);
  }

  private buildForestEntranceSign(pos: THREE.Vector3): void {
    const signGroup = new THREE.Group();
    signGroup.position.copy(pos);

    // Wooden gate archway posts
    const postMat = new THREE.MeshLambertMaterial({ color: 0x4a2e1b, });
    const postLeft = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 4.5, 8), postMat);
    postLeft.position.set(-5.5, 2.25, 0);
    signGroup.add(postLeft);

    const postRight = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 4.5, 8), postMat);
    postRight.position.set(5.5, 2.25, 0);
    signGroup.add(postRight);

    // Cross beam
    const crossBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 12.0, 8), postMat);
    crossBeam.rotation.z = Math.PI / 2;
    crossBeam.position.set(0, 4.2, 0);
    signGroup.add(crossBeam);

    // Zelda BotW Banner Sign Board
    const bannerMat = new THREE.MeshLambertMaterial({ color: 0x1c3d23, });
    const banner = new THREE.Mesh(new THREE.BoxGeometry(7.0, 1.1, 0.2), bannerMat);
    banner.position.set(0, 3.8, 0);
    signGroup.add(banner);

    // Golden accent border on sign
    const borderMat = new THREE.MeshBasicMaterial({ color: 0x10b981 });
    const borderTop = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.08, 0.24), borderMat);
    borderTop.position.set(0, 4.35, 0);
    signGroup.add(borderTop);

    const borderBottom = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.08, 0.24), borderMat);
    borderBottom.position.set(0, 3.25, 0);
    signGroup.add(borderBottom);

    this.group.add(signGroup);
  }

  private buildPerimeterFence(center: THREE.Vector3, size: number): void {
    const half = size / 2;
    const fenceHeight = 1.6;
    const fenceThickness = 0.5;
    const fenceMat = new THREE.MeshLambertMaterial({ color: 0x3d2716, });

    const createFenceSection = (pos: THREE.Vector3, dims: THREE.Vector3) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(dims.x, dims.y, dims.z), fenceMat);
      mesh.position.copy(pos);
      this.group.add(mesh);

      this.physics.createStaticBox(pos, dims, new THREE.Euler(), COLLISION_GROUPS.ENVIRONMENT);
    };

    // North fence (Z = center.z + half = 165)
    createFenceSection(
      new THREE.Vector3(center.x, fenceHeight / 2, center.z + half),
      new THREE.Vector3(size, fenceHeight, fenceThickness)
    );

    // West fence (X = -half = -45)
    createFenceSection(
      new THREE.Vector3(center.x - half, fenceHeight / 2, center.z),
      new THREE.Vector3(fenceThickness, fenceHeight, size)
    );

    // East fence (X = +half = 45)
    createFenceSection(
      new THREE.Vector3(center.x + half, fenceHeight / 2, center.z),
      new THREE.Vector3(fenceThickness, fenceHeight, size)
    );

    // South fence (Z = center.z - half = 75), split in two to leave 14m entrance
    const halfSegWidth = (size - 14.0) / 2; // (90 - 14) / 2 = 38m
    const leftCenterX = -half + halfSegWidth / 2; // -45 + 19 = -26
    const rightCenterX = half - halfSegWidth / 2; // +45 - 19 = +26

    createFenceSection(
      new THREE.Vector3(leftCenterX, fenceHeight / 2, center.z - half),
      new THREE.Vector3(halfSegWidth, fenceHeight, fenceThickness)
    );

    createFenceSection(
      new THREE.Vector3(rightCenterX, fenceHeight / 2, center.z - half),
      new THREE.Vector3(halfSegWidth, fenceHeight, fenceThickness)
    );
  }

  private buildEnvironmentalDetails(center: THREE.Vector3, size: number): void {
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x5a636e, flatShading: true });
    const mossRockMat = new THREE.MeshLambertMaterial({ color: 0x3e523b, flatShading: true });

    // Procedural decorative moss boulders and rock clusters
    const rockPositions = [
      new THREE.Vector3(center.x - 25, 0.7, center.z - 15),
      new THREE.Vector3(center.x + 22, 0.9, center.z - 20),
      new THREE.Vector3(center.x - 18, 0.6, center.z + 24),
      new THREE.Vector3(center.x + 30, 0.8, center.z + 18),
      new THREE.Vector3(center.x - 32, 1.1, center.z + 5),
      new THREE.Vector3(center.x + 12, 0.5, center.z + 32),
      new THREE.Vector3(center.x - 5, 0.7, center.z + 35),
    ];

    rockPositions.forEach((pos, idx) => {
      const rockRadius = 0.8 + (idx % 3) * 0.4;
      const rockGeo = new THREE.DodecahedronGeometry(rockRadius, 1);
      const rockMesh = new THREE.Mesh(rockGeo, idx % 2 === 0 ? rockMat : mossRockMat);
      rockMesh.position.copy(pos);
      rockMesh.rotation.set(idx * 0.5, idx * 1.1, idx * 0.7);
      rockMesh.scale.set(1.2, 0.8, 1.1);
      this.group.add(rockMesh);

      this.physics.createStaticBox(
        pos,
        new THREE.Vector3(rockRadius * 2, rockRadius * 1.5, rockRadius * 2),
        new THREE.Euler(),
        COLLISION_GROUPS.ENVIRONMENT
      );
    });
  }

  /**
   * Spawns forest trees with cylindrical collision for trunks
   * Uses optimized shared geometries & materials
   */
  private spawnForestTrees(): void {
    const center = ForestZone.PLATFORM_CENTER;
    const treeCount = 38;

    // Grid-based jitter distribution to ensure good spacing and natural feel
    const minZ = center.z - 36; // 84
    const maxZ = center.z + 38; // 158
    const minX = center.x - 38; // -38
    const maxX = center.x + 38; // +38

    let id = 0;
    const cols = 7;
    const rows = 6;
    const stepX = (maxX - minX) / cols;
    const stepZ = (maxZ - minZ) / rows;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (id >= treeCount) break;

        // Base cell position
        let x = minX + (c + 0.5) * stepX + (Math.random() - 0.5) * (stepX * 0.65);
        let z = minZ + (r + 0.5) * stepZ + (Math.random() - 0.5) * (stepZ * 0.65);

        // Keep center entrance clearing open
        if (Math.abs(x) < 5.5 && z < center.z - 18) {
          continue;
        }

        const scale = 0.85 + Math.random() * 0.35;
        const trunkRadius = 0.48 * scale;
        const trunkHeight = 9.0 * scale;
        const pos = new THREE.Vector3(x, 0, z);

        this.createTreeInstance(id++, pos, scale, trunkRadius, trunkHeight);
      }
    }
  }

  /**
   * Generates a shared trunk cylinder geometry matching the user's progressive cut specification:
   * - Stage 0: Clean pristine trunk (0 hits)
   * - Stage 1 (Figure 1): Initial wedge cut into the strike side with exposed fresh wood
   * - Stage 2 (Figure 2): Bilateral pinched hourglass waist with left/right V-notches and neck
   * - Stage 3 (Figure 3): Deep "X" hourglass cross meeting in the center, tree ready to topple
   * 
   * Cut is positioned at waist/chest height (~1.05m - 1.45m from ground),
   * precisely where the player's axe strikes the tree in 3rd-person view.
   * 
   * Uses multi-material groups:
   * Group 0: barkMaterial (exterior trunk)
   * Group 1: freshWoodMaterial (interior exposed wood cut)
   */
  private createNotchedTrunkGeometry(
    radiusTop: number,
    radiusBottom: number,
    height: number,
    radialSegments: number,
    stage: number
  ): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const barkIndices: number[] = [];
    const woodIndices: number[] = [];

    const N = radialSegments;
    const yMin = -height / 2;
    const yMax = height / 2;

    const getRadius = (y: number) => {
      const t = (y - yMin) / height;
      return radiusBottom + (radiusTop - radiusBottom) * t;
    };

    // Height levels along the trunk:
    // With trunkMesh centered at trunkHeight/2, world Y is: (height/2) + y
    // For waist/chest axe strike height (~1.05m to 1.45m above ground):
    const yCutBot = yMin + 1.05;  // World Y ≈ 1.05m
    const yCutApex = yMin + 1.25; // World Y ≈ 1.25m (cut apex/waist center)
    const yCutTop = yMin + 1.45;  // World Y ≈ 1.45m
    const yMid1 = yMin + 3.8;
    const yMid2 = yMin + 6.5;

    const levels = [yMin, yCutBot, yCutTop, yMid1, yMid2, yMax];
    const numLevels = levels.length;

    // Helper to add vertex
    let vertexCount = 0;
    const addVertex = (x: number, y: number, z: number, u: number, v: number): number => {
      positions.push(x, y, z);
      normals.push(0, 1, 0); // Recalculated by computeVertexNormals
      uvs.push(u, v);
      return vertexCount++;
    };

    const addQuad = (v0: number, v1: number, v2: number, v3: number, target: number[]) => {
      target.push(v0, v1, v2);
      target.push(v0, v2, v3);
    };

    // Generate cylinder ring vertices for each height level
    // (N + 1) vertices per level so u ranges smoothly from 0 to 1 without seam
    const ringVertices: number[][] = [];
    for (let l = 0; l < numLevels; l++) {
      const y = levels[l];
      const r = getRadius(y);
      const row: number[] = [];
      const v = (y - yMin) / height;

      for (let i = 0; i <= N; i++) {
        const theta = (i / N) * Math.PI * 2;
        const x = r * Math.sin(theta);
        const z = r * Math.cos(theta);
        const u = i / N;
        row.push(addVertex(x, y, z, u, v));
      }
      ringVertices.push(row);
    }

    // Connect standard bark bands between levels:
    // Band 0: levels[0] -> levels[1] (base below cut)
    // Band 2: levels[2] -> levels[3]
    // Band 3: levels[3] -> levels[4]
    // Band 4: levels[4] -> levels[5] (top)
    for (let l = 0; l < numLevels - 1; l++) {
      if (l === 1) continue; // Band 1 is the cut zone (levels[1] -> levels[2]), handled per stage below
      for (let i = 0; i < N; i++) {
        const vBot0 = ringVertices[l][i];
        const vBot1 = ringVertices[l][i + 1];
        const vTop1 = ringVertices[l + 1][i + 1];
        const vTop0 = ringVertices[l + 1][i];
        addQuad(vBot0, vBot1, vTop1, vTop0, barkIndices);
      }
    }

    // --- BAND 1 (Cut Zone: yCutBot to yCutTop) ---

    // STAGE 0: Pristine trunk (clean bark cylinder)
    if (stage === 0) {
      for (let i = 0; i < N; i++) {
        const vBot0 = ringVertices[1][i];
        const vBot1 = ringVertices[1][i + 1];
        const vTop1 = ringVertices[2][i + 1];
        const vTop0 = ringVertices[2][i];
        addQuad(vBot0, vBot1, vTop1, vTop0, barkIndices);
      }
    }

    // STAGE 1 (User Figure 1): Initial notch cut on strike side facing player (+Z)
    if (stage === 1) {
      // Bark on non-cut sectors (i from 2 to 13)
      for (let i = 2; i <= 13; i++) {
        const vBot0 = ringVertices[1][i];
        const vBot1 = ringVertices[1][i + 1];
        const vTop1 = ringVertices[2][i + 1];
        const vTop0 = ringVertices[2][i];
        addQuad(vBot0, vBot1, vTop1, vTop0, barkIndices);
      }

      // Cut sectors (14->15, 15->16/0, 0->1, 1->2)
      const rApex = getRadius(yCutApex);
      const rBot = getRadius(yCutBot);
      const rTop = getRadius(yCutTop);

      const maxD = 0.35; // ~60% penetration on the strike side
      const getPenetration = (idx: number) => {
        const normIdx = idx % N;
        if (normIdx === 0) return maxD;
        if (normIdx === 1 || normIdx === 15) return maxD * 0.75;
        return 0.0;
      };

      const cutSectors = [
        { from: 14, to: 15 },
        { from: 15, to: 16 },
        { from: 0, to: 1 },
        { from: 1, to: 2 },
      ];

      for (const sec of cutSectors) {
        const i0 = sec.from;
        const i1 = sec.to;

        const theta0 = (i0 / N) * Math.PI * 2;
        const theta1 = (i1 / N) * Math.PI * 2;

        const p0 = getPenetration(i0);
        const p1 = getPenetration(i1);

        const xBot0 = rBot * Math.sin(theta0);
        const zBot0 = rBot * Math.cos(theta0);
        const xBot1 = rBot * Math.sin(theta1);
        const zBot1 = rBot * Math.cos(theta1);

        const xTop0 = rTop * Math.sin(theta0);
        const zTop0 = rTop * Math.cos(theta0);
        const xTop1 = rTop * Math.sin(theta1);
        const zTop1 = rTop * Math.cos(theta1);

        const xApex0 = rApex * Math.sin(theta0);
        const zApex0 = rApex * Math.cos(theta0) - p0;
        const xApex1 = rApex * Math.sin(theta1);
        const zApex1 = rApex * Math.cos(theta1) - p1;

        // Bottom cut shelf (quad pointing up towards apex)
        const vBotFloor0 = addVertex(xBot0, yCutBot, zBot0, xBot0 + 0.5, zBot0 + 0.5);
        const vBotFloor1 = addVertex(xBot1, yCutBot, zBot1, xBot1 + 0.5, zBot1 + 0.5);
        const vApexFloor1 = addVertex(xApex1, yCutApex, zApex1, xApex1 + 0.5, zApex1 + 0.5);
        const vApexFloor0 = addVertex(xApex0, yCutApex, zApex0, xApex0 + 0.5, zApex0 + 0.5);
        addQuad(vBotFloor0, vBotFloor1, vApexFloor1, vApexFloor0, woodIndices);

        // Top sloping cut ceiling (quad sloping down towards apex)
        const vTopCeil0 = addVertex(xTop0, yCutTop, zTop0, xTop0 + 0.5, zTop0 + 0.5);
        const vTopCeil1 = addVertex(xTop1, yCutTop, zTop1, xTop1 + 0.5, zTop1 + 0.5);
        const vApexCeil0 = addVertex(xApex0, yCutApex, zApex0, xApex0 + 0.5, zApex0 + 0.5);
        const vApexCeil1 = addVertex(xApex1, yCutApex, zApex1, xApex1 + 0.5, zApex1 + 0.5);
        addQuad(vApexCeil0, vApexCeil1, vTopCeil1, vTopCeil0, woodIndices);
      }
    }

    // STAGE 2 (User Figure 2): Bilateral pinched hourglass waist with left/right V-notches and neck
    if (stage === 2) {
      const rWaist = 0.24; // Constricted waist radius (~42% of trunk radius)
      const yWaistBot = yCutApex - 0.04;
      const yWaistTop = yCutApex + 0.04;

      const waistBotVerts: number[] = [];
      const waistTopVerts: number[] = [];

      for (let i = 0; i <= N; i++) {
        const theta = (i / N) * Math.PI * 2;
        const x = rWaist * Math.sin(theta);
        const z = rWaist * Math.cos(theta);
        const u = i / N;
        waistBotVerts.push(addVertex(x, yWaistBot, z, u, 0.45));
        waistTopVerts.push(addVertex(x, yWaistTop, z, u, 0.55));
      }

      for (let i = 0; i < N; i++) {
        const vBot0 = ringVertices[1][i];
        const vBot1 = ringVertices[1][i + 1];
        const vWBot0 = waistBotVerts[i];
        const vWBot1 = waistBotVerts[i + 1];
        const vWTop0 = waistTopVerts[i];
        const vWTop1 = waistTopVerts[i + 1];
        const vTop0 = ringVertices[2][i];
        const vTop1 = ringVertices[2][i + 1];

        // 1. Lower sloped shelf (sloping inward and up to waist bottom)
        addQuad(vBot0, vBot1, vWBot1, vWBot0, woodIndices);

        // 2. Short vertical waist neck
        addQuad(vWBot0, vWBot1, vWTop1, vWTop0, woodIndices);

        // 3. Upper sloped shelf (sloping outward and up to top rim)
        addQuad(vWTop0, vWTop1, vTop1, vTop0, woodIndices);
      }
    }

    // STAGE 3 (User Figure 3): Deep "X" hourglass cross meeting at a central point
    if (stage === 3) {
      const rCore = 0.05; // 5cm central hinge connection before snapping
      const coreVerts: number[] = [];

      for (let i = 0; i <= N; i++) {
        const theta = (i / N) * Math.PI * 2;
        const x = rCore * Math.sin(theta);
        const z = rCore * Math.cos(theta);
        const u = i / N;
        coreVerts.push(addVertex(x, yCutApex, z, u, 0.5));
      }

      for (let i = 0; i < N; i++) {
        const vBot0 = ringVertices[1][i];
        const vBot1 = ringVertices[1][i + 1];
        const vCore0 = coreVerts[i];
        const vCore1 = coreVerts[i + 1];
        const vTop0 = ringVertices[2][i];
        const vTop1 = ringVertices[2][i + 1];

        // 1. Lower cone (sloping inward and up directly to the central apex ring)
        addQuad(vBot0, vBot1, vCore1, vCore0, woodIndices);

        // 2. Upper cone (sloping outward and up from central apex ring to top rim)
        addQuad(vCore0, vCore1, vTop1, vTop0, woodIndices);
      }
    }

    // Bottom and top cylinder caps
    const vCenterBot = addVertex(0, yMin, 0, 0.5, 0.5);
    for (let i = 0; i < N; i++) {
      barkIndices.push(vCenterBot, ringVertices[0][i + 1], ringVertices[0][i]);
    }

    const vCenterTop = addVertex(0, yMax, 0, 0.5, 0.5);
    for (let i = 0; i < N; i++) {
      barkIndices.push(vCenterTop, ringVertices[numLevels - 1][i], ringVertices[numLevels - 1][i + 1]);
    }

    // Combine indices and setup material groups
    const allIndices = [...barkIndices, ...woodIndices];
    geometry.setIndex(allIndices);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

    geometry.addGroup(0, barkIndices.length, 0); // Material 0: barkMaterial
    if (woodIndices.length > 0) {
      geometry.addGroup(barkIndices.length, woodIndices.length, 1); // Material 1: freshWoodMaterial
    }

    geometry.computeVertexNormals();
    return geometry;
  }

  /**
   * Creates a single standing tree with static cylinder collision
   */
  private createTreeInstance(
    id: number,
    position: THREE.Vector3,
    scale: number,
    trunkRadius: number,
    trunkHeight: number
  ): void {
    const treeGroup = new THREE.Group();
    treeGroup.position.copy(position);
    treeGroup.name = `Tree_${id}`;

    // 1. Trunk Mesh with multi-material (bark + fresh wood cut)
    const trunkMesh = new THREE.Mesh(this.sharedTrunkGeos[0], [this.barkMaterial, this.freshWoodMaterial]);
    trunkMesh.scale.set(scale, scale, scale);
    trunkMesh.position.y = trunkHeight / 2;


    treeGroup.add(trunkMesh);

    // 2. Multi-tier Zelda BotW stylized foliage canopies positioned along taller trunk
    const tier1 = new THREE.Mesh(this.sharedFoliageConeGeo1, this.foliageMaterial1);
    tier1.scale.set(scale, scale, scale);
    tier1.position.y = trunkHeight * 0.55;

    treeGroup.add(tier1);

    const tier2 = new THREE.Mesh(this.sharedFoliageConeGeo2, this.foliageMaterial2);
    tier2.scale.set(scale, scale, scale);
    tier2.position.y = trunkHeight * 0.78;

    treeGroup.add(tier2);

    const tier3 = new THREE.Mesh(this.sharedFoliageConeGeo3, this.foliageMaterial3);
    tier3.scale.set(scale, scale, scale);
    tier3.position.y = trunkHeight * 0.98;

    treeGroup.add(tier3);

    this.group.add(treeGroup);

    // 3. Cylindrical Collision for Trunk (as requested by user)
    // Center of cylinder is at y = trunkHeight / 2
    const cylCenter = new THREE.Vector3(position.x, trunkHeight / 2, position.z);
    const { body, collider } = this.physics.createStaticCylinder(
      cylCenter,
      trunkRadius,
      trunkHeight,
      new THREE.Euler(),
      COLLISION_GROUPS.ENVIRONMENT
    );

    this.trees.push({
      id,
      position: position.clone(),
      rotationY: Math.random() * Math.PI * 2,
      scale,
      trunkHeight,
      trunkRadius,
      maxHealth: 5, // Exactly 5 axe hits required to chop down tree
      health: 5,
      isFelled: false,
      staticBody: body,
      staticCollider: collider,
      treeGroup,
      trunkMesh,
      wobbleAngle: 0,
      wobbleVelocity: 0,
      wobbleAxis: new THREE.Vector3(1, 0, 0),
    });
  }

  /**
   * Checks whether an attack (axe slash, bullet, rocket) hits a tree trunk or a fallen log
   */
  public checkHit(
    hitPoint: THREE.Vector3,
    direction: THREE.Vector3,
    damage: number = 1,
    isAxe: boolean = false
  ): { hit: boolean; isFatal: boolean; hitPoint: THREE.Vector3; normal: THREE.Vector3; isLogSplit?: boolean } | null {
    // 1. Check standing trees
    for (let i = 0; i < this.trees.length; i++) {
      const tree = this.trees[i];
      if (tree.isFelled) continue;

      // Distance from trunk axis
      const dx = hitPoint.x - tree.position.x;
      const dz = hitPoint.z - tree.position.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      const dy = hitPoint.y - tree.position.y;

      // Generous cylinder hit threshold (accounting for weapon slash arc)
      const hitRadius = isAxe ? tree.trunkRadius + 0.65 : tree.trunkRadius + 0.35;
      if (horizDist <= hitRadius && dy >= 0 && dy <= tree.trunkHeight + 0.8) {
        // Calculate hit normal pointing outwards from tree center
        const normal = new THREE.Vector3(dx, 0.2, dz).normalize();

        // Progressive damage
        tree.health -= damage;

        // Dynamic spring wobble: wobble axis perpendicular to attack direction
        const attackDirNorm = direction.clone().normalize();
        tree.wobbleAxis.set(-attackDirNorm.z, 0, attackDirNorm.x).normalize();
        // Subtle, tight spring velocity proportional to impact
        tree.wobbleVelocity = (isAxe ? 3.6 : 2.0);

        if (tree.health <= 0) {
          // 5th hit: Felled tree!
          this.fellTree(tree, direction);
          return { hit: true, isFatal: true, hitPoint, normal };
        } else {
          // Hits 1 to 4: Struck but still standing
          const hitsDone = tree.maxHealth - tree.health; // 1, 2, 3, 4

          // Progressive cut stages matching user illustration:
          // Stage 0: Clean pristine trunk (0 hits)
          // Stage 1 (Figure 1): Hit 1 -> Initial wedge cut on strike side
          // Stage 2 (Figure 2): Hits 2 & 3 -> Pinched hourglass waist with bilateral V-notches and neck
          // Stage 3 (Figure 3): Hit 4 -> Deep "X" hourglass cross (core narrowed to 5cm, ready to topple)
          // Fatal Hit 5: Tree snaps at the "X" and falls!
          let stage = 1;
          if (hitsDone >= 4) {
            stage = 3; // Figure 3: Deep "X" cut
          } else if (hitsDone >= 2) {
            stage = 2; // Figure 2: Pinched waist
          } else {
            stage = 1; // Figure 1: Initial notch
          }
          tree.trunkMesh.geometry = this.sharedTrunkGeos[stage];

          // Orient notch towards the side where player chopped so the player clearly sees it:
          // The attack travels towards the tree along `direction`. The surface being struck
          // faces back towards the player who is chopping (-direction).
          if (tree.notchAngle === undefined) {
            let strikeDx = -direction.x;
            let strikeDz = -direction.z;
            if (Math.hypot(strikeDx, strikeDz) < 0.001) {
              strikeDx = hitPoint.x - tree.position.x;
              strikeDz = hitPoint.z - tree.position.z;
            }
            // In the geometry, the notch is centered at local +Z.
            // Rotating by Math.atan2(strikeDx, strikeDz) aligns local +Z directly towards the chopping player!
            tree.notchAngle = Math.atan2(strikeDx, strikeDz);
            tree.trunkMesh.rotation.y = tree.notchAngle;
          }

          audioEngine.at(hitPoint).playWoodChopHit(false);
          return { hit: true, isFatal: false, hitPoint, normal };
        }
      }
    }

    // 2. Check fallen trees (to split into wood logs!)
    for (let i = 0; i < this.fallenTrees.length; i++) {
      const fallen = this.fallenTrees[i];
      const fallenPos = new THREE.Vector3();
      const t = fallen.body.translation();
      fallenPos.set(t.x, t.y, t.z);

      const dist = fallenPos.distanceTo(hitPoint);
      if (dist < fallen.length * 0.7 + 0.8) {
        fallen.hitsToSplit -= damage;
        const normal = new THREE.Vector3(0, 1, 0);

        if (fallen.hitsToSplit <= 0) {
          this.splitFallenTreeIntoLogs(fallen, hitPoint);
          return { hit: true, isFatal: true, hitPoint, normal, isLogSplit: true };
        } else {
          audioEngine.at(hitPoint).playWoodChopHit(false);
          return { hit: true, isFatal: false, hitPoint, normal };
        }
      }
    }

    return null;
  }

  /**
   * Fells the tree in authentic Zelda BotW style:
   * - Stump remains rooted in the ground with concentric rings
   * - Dynamic physical tree trunk + crown falls over with physics gravity and momentum
   * - Creaking wood sound and fluttering leaves
   */
  private fellTree(tree: TreeData, chopDirection: THREE.Vector3): void {
    tree.isFelled = true;

    // 1. Remove static rigid body (Rapier automatically cleans up attached colliders)
    this.physics.removeRigidBody(tree.staticBody);

    // 2. Hide static tree mesh
    tree.treeGroup.visible = false;

    // 3. Spawn a permanent Tree Stump with tree rings
    const stumpMesh = new THREE.Mesh(this.sharedStumpGeo, [
      this.barkMaterial,
      this.stumpTopMaterial, // Top circular face
      this.stumpTopMaterial, // Bottom
    ]);
    stumpMesh.position.set(tree.position.x, 0.25, tree.position.z);
    stumpMesh.scale.set(tree.scale, 1.0, tree.scale);
    tree.stumpMesh = stumpMesh;
    if (this.options.regrowSeconds) {
      tree.regrowAt = performance.now() + this.options.regrowSeconds * 1000;
    }


    this.stumpsGroup.add(stumpMesh);

    // Stump static cylinder collider
    tree.stumpBody = this.physics.createStaticCylinder(
      new THREE.Vector3(tree.position.x, 0.25, tree.position.z),
      tree.trunkRadius * 1.05,
      0.50,
      new THREE.Euler(),
      COLLISION_GROUPS.ENVIRONMENT
    ).body;

    // 4. Audio: wood crack + creak
    audioEngine.at(tree.position).playWoodChopHit(true);
    audioEngine.at(tree.position, 5).playTreeFallCreak();


    // 6. Create Dynamic Falling Tree Entity (bare trunk without green foliage canopies)
    const dynamicGroup = new THREE.Group();
    dynamicGroup.name = `FallingTree_${tree.id}`;

    // Trunk mesh (centered at y = 0 inside local dynamic group to match Rapier body center)
    const dynTrunk = new THREE.Mesh(this.sharedTrunkGeo, this.barkMaterial);
    dynTrunk.scale.set(tree.scale, tree.scale, tree.scale);


    dynamicGroup.add(dynTrunk);

    this.group.add(dynamicGroup);

    // Calculate toppling direction (away from axe chop direction)
    const pushDir = chopDirection.clone().setY(0).normalize();
    if (pushDir.lengthSq() < 0.001) pushDir.set(0, 0, 1);

    // Correct tilt axis perpendicular to push direction in horizontal plane so tree falls forward
    const tiltAxis = new THREE.Vector3(pushDir.z, 0, -pushDir.x).normalize();

    // Spawn dynamic cylinder in Rapier physics right on top of stump
    const stumpHeight = 0.50;
    const dynamicTrunkHeight = tree.trunkHeight;
    const spawnY = stumpHeight + dynamicTrunkHeight / 2 + 0.06;
    const spawnCenter = new THREE.Vector3(
      tree.position.x + pushDir.x * 0.12,
      spawnY,
      tree.position.z + pushDir.z * 0.12
    );

    const { body, collider } = this.physics.createDynamicProp(
      spawnCenter,
      'cylinder',
      { radius: tree.trunkRadius, height: dynamicTrunkHeight },
      70.0 // Tree mass
    );

    // Initial forward tilt angle (~9.2 degrees / 0.16 rad) so gravity immediately initiates self-toppling
    const initialTiltAngle = 0.16;
    const initialQuat = new THREE.Quaternion().setFromAxisAngle(tiltAxis, initialTiltAngle);
    body.setRotation({ x: initialQuat.x, y: initialQuat.y, z: initialQuat.z, w: initialQuat.w }, true);

    // Initial angular and linear velocity to start smooth physical toppling immediately
    body.setAngvel({ x: tiltAxis.x * 3.2, y: (Math.random() - 0.5) * 0.2, z: tiltAxis.z * 3.2 }, true);
    body.setLinvel({ x: pushDir.x * 2.8, y: 0.6, z: pushDir.z * 2.8 }, true);

    // Apply impulse to topple tree away from chop angle
    body.applyImpulse({ x: pushDir.x * 85, y: 12, z: pushDir.z * 85 }, true);
    body.applyTorqueImpulse(
      { x: tiltAxis.x * 360, y: 0, z: tiltAxis.z * 360 },
      true
    );

    this.fallenTrees.push({
      id: tree.id,
      group: dynamicGroup,
      body,
      collider,
      hasHitGround: false,
      spawnTime: performance.now(),
      hitsToSplit: 1, // 1 more axe hit splits it into wood logs!
      length: tree.trunkHeight,
      radius: tree.trunkRadius,
    });
  }

  /**
   * Splits a fallen trunk into 2 carryable Wood Logs (Zelda BotW Campfire Wood)
   */
  private splitFallenTreeIntoLogs(fallen: FallenTree, splitPoint: THREE.Vector3): void {
    // 1. Read position before removing body
    let basePos = splitPoint.clone();
    try {
      if (fallen.body && fallen.body.isValid()) {
        const t = fallen.body.translation();
        if (t && Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)) {
          basePos.set(t.x, Math.max(0.5, t.y), t.z);
        }
      }
    } catch {
      // fallback to splitPoint
    }

    // 2. Remove fallen tree rigid body and mesh from scene
    this.physics.removeRigidBody(fallen.body);
    this.group.remove(fallen.group);

    // Remove from fallen trees list
    const index = this.fallenTrees.indexOf(fallen);
    if (index !== -1) {
      this.fallenTrees.splice(index, 1);
    }

    // 3. Audio & particle feedback
    audioEngine.at(splitPoint).playLogSplit();

    // 4. Farm mode: firewood goes straight to the backpack instead of spawning log props
    if (this.options.onWoodHarvested) {
      this.options.onWoodHarvested(this.options.woodPerTree ?? 1, basePos.clone());
      return;
    }

    // Spawn 2 physical Wood Logs with perfectly matching visual and physics cylinder alignment
    for (let i = 0; i < 2; i++) {
      const logGroup = new THREE.Group();
      logGroup.name = `WoodLog_${fallen.id}_${i}`;

      // Three.js CylinderGeometry (sharedLogGeo) is along the Y axis.
      // We do NOT add any internal rotation to logMesh so that the group coordinates match the Rapier body 1:1!
      const logMesh = new THREE.Mesh(this.sharedLogGeo, this.woodLogMaterial);


      logGroup.add(logMesh);

      this.group.add(logGroup);

      const offset = (i === 0 ? -0.8 : 0.8);
      const logPos = new THREE.Vector3(basePos.x + offset, basePos.y + 0.3, basePos.z);

      const { body, collider } = this.physics.createDynamicProp(
        logPos,
        'cylinder',
        { radius: 0.24, height: 1.3 },
        14.0 // Light enough for CarryAbility (under max mass)
      );

      // Rotate the Rapier rigid body by 90 degrees around Z axis so the cylinder lies horizontally on the ground.
      // Both the visual mesh and the Rapier physical collider rotate together in complete 1:1 synchronization!
      const initialQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      body.setRotation({ x: initialQuat.x, y: initialQuat.y, z: initialQuat.z, w: initialQuat.w }, true);

      // Pop logs into air with scatter impulse
      body.applyImpulse(
        {
          x: offset * 12 + (Math.random() - 0.5) * 6,
          y: 18 + Math.random() * 6,
          z: (Math.random() - 0.5) * 8,
        },
        true
      );

      this.woodLogs.push({ group: logGroup, body, collider });
    }
  }

  /**
   * Main simulation update loop:
   * - Highly optimized Spring Damper simulation for standing trees
   * - Syncs dynamic fallen trees and checks ground crash impact
   * - Syncs dynamic wood logs with 1:1 rotation/translation fidelity
   */
  public update(dt: number, _playerPos?: THREE.Vector3): void {
    const dtClamped = Math.min(dt, 0.033);

    // 0. Regrow felled trees from their stumps
    const now = performance.now();
    for (const tree of this.trees) {
      if (tree.isFelled && tree.regrowAt !== undefined && now >= tree.regrowAt) {
        this.regrowTree(tree);
      } else if (!tree.isFelled && tree.growProgress !== undefined && tree.growProgress < 1) {
        tree.growProgress = Math.min(1, tree.growProgress + dtClamped * 0.8);
        const t = tree.growProgress;
        tree.treeGroup.scale.setScalar(Math.max(0.01, 1 - Math.pow(1 - t, 3)));
      }
    }

    // 1. Update tree trunk spring wobble dynamics (stiff wood elastic recoil)
    for (let i = 0; i < this.trees.length; i++) {
      const tree = this.trees[i];
      if (tree.isFelled) continue;

      if (Math.abs(tree.wobbleAngle) > 0.0001 || Math.abs(tree.wobbleVelocity) > 0.001) {
        // High stiffness & critical damping: F = -k*x - c*v
        const springStiffness = 240.0;
        const damping = 20.0;
        const force = -tree.wobbleAngle * springStiffness - tree.wobbleVelocity * damping;

        tree.wobbleVelocity += force * dtClamped;
        tree.wobbleAngle += tree.wobbleVelocity * dtClamped;

        // Clamp to subtle max recoil angle (max ~2.5 degrees / 0.045 rad)
        tree.wobbleAngle = Math.max(-0.045, Math.min(0.045, tree.wobbleAngle));

        if (Math.abs(tree.wobbleAngle) < 0.0001 && Math.abs(tree.wobbleVelocity) < 0.001) {
          tree.wobbleAngle = 0;
          tree.wobbleVelocity = 0;
          tree.treeGroup.rotation.x = 0;
          tree.treeGroup.rotation.z = 0;
        } else {
          // Apply wobble rotation around wobbleAxis at trunk base
          tree.treeGroup.rotation.x = tree.wobbleAxis.x * tree.wobbleAngle;
          tree.treeGroup.rotation.z = tree.wobbleAxis.z * tree.wobbleAngle;
        }
      } else if (tree.treeGroup.rotation.x !== 0 || tree.treeGroup.rotation.z !== 0) {
        tree.treeGroup.rotation.x = 0;
        tree.treeGroup.rotation.z = 0;
      }
    }

    // 2. Update dynamic fallen trees
    for (let i = 0; i < this.fallenTrees.length; i++) {
      const fallen = this.fallenTrees[i];
      if (!fallen.body.isValid()) continue;

      const t = fallen.body.translation();
      const r = fallen.body.rotation();

      fallen.group.position.set(t.x, t.y, t.z);
      fallen.group.quaternion.set(r.x, r.y, r.z, r.w);

      // Check ground crash impact
      if (!fallen.hasHitGround) {
        const vel = fallen.body.linvel();
        const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
        const age = performance.now() - fallen.spawnTime;

        // When fallen tree strikes ground (y low and vertical speed stopped, or after 1s fall)
        if ((t.y <= 1.2 && Math.abs(vel.y) < 1.5 && age > 450) || age > 2000) {
          fallen.hasHitGround = true;
          audioEngine.at(t, 8).playTreeImpact();

        }
      }
    }

    // 3. Update dynamic wood logs
    for (let i = 0; i < this.woodLogs.length; i++) {
      const log = this.woodLogs[i];
      if (!log.body.isValid()) continue;

      const t = log.body.translation();
      const r = log.body.rotation();

      log.group.position.set(t.x, t.y, t.z);
      log.group.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /**
   * Reset the forest back to pristine standing state
   */
  private regrowTree(tree: TreeData): void {
    if (tree.stumpMesh) this.stumpsGroup.remove(tree.stumpMesh);
    if (tree.stumpBody) this.physics.removeRigidBody(tree.stumpBody);
    tree.stumpMesh = undefined;
    tree.stumpBody = undefined;
    tree.regrowAt = undefined;

    const { body, collider } = this.physics.createStaticCylinder(
      new THREE.Vector3(tree.position.x, tree.trunkHeight / 2, tree.position.z),
      tree.trunkRadius,
      tree.trunkHeight,
      new THREE.Euler(),
      COLLISION_GROUPS.ENVIRONMENT
    );
    tree.staticBody = body;
    tree.staticCollider = collider;

    tree.isFelled = false;
    tree.health = tree.maxHealth;
    tree.notchAngle = undefined;
    tree.trunkMesh.geometry = this.sharedTrunkGeos[0];
    tree.trunkMesh.rotation.y = 0;
    tree.wobbleAngle = 0;
    tree.wobbleVelocity = 0;
    tree.treeGroup.rotation.set(0, 0, 0);
    tree.treeGroup.scale.setScalar(0.01);
    tree.treeGroup.visible = true;
    tree.growProgress = 0;

    this.particleManager?.emitTreeFoliageLeaves(new THREE.Vector3(tree.position.x, 1.5, tree.position.z), 18);
  }

  public reset(): void {
    // Clear fallen trees
    for (const fallen of this.fallenTrees) {
      this.physics.removeCollider(fallen.collider);
      this.physics.removeRigidBody(fallen.body);
      this.group.remove(fallen.group);
    }
    this.fallenTrees = [];

    // Clear wood logs
    for (const log of this.woodLogs) {
      this.physics.removeCollider(log.collider);
      this.physics.removeRigidBody(log.body);
      this.group.remove(log.group);
    }
    this.woodLogs = [];

    // Clear stumps
    while (this.stumpsGroup.children.length > 0) {
      this.stumpsGroup.remove(this.stumpsGroup.children[0]);
    }

    // Remove existing standing tree colliders
    for (const tree of this.trees) {
      if (!tree.isFelled) {
        this.physics.removeCollider(tree.staticCollider);
        this.physics.removeRigidBody(tree.staticBody);
      }
      this.group.remove(tree.treeGroup);
    }
    this.trees = [];

    // Re-spawn standing trees
    this.spawnForestTrees();
  }
}
