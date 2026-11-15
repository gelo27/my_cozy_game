import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  BuildingPieceType,
  BuiltPiece,
  isDoorPiece,
  isDoorwayPiece,
  isWindowPiece,
  isWindowOrDoorPiece,
  isSolidWallPiece,
  getWallHalfWidth,
  getWallHalfHeight,
  BuildingSceneExportData,
  shapeOf,
  isGlassRoofPiece,
  isSwingDoorPiece,
  isGreenhousePiece,
  PieceCategory,
  isFloorPiece,
  isFoundationPiece,
  getWallSize,
} from './types/BuildingTypes';
import { GreenhouseBatch } from './GreenhouseBatch';
import { BUILDING_PIECES, BUILDING_MATERIALS, createPieceMeshGroup, getPieceMeshTemplate, HALF_SIZE, MODULE_SIZE, WALL_THICKNESS, isProceduralRoofPiece, getDefaultRoofConfig, isPieceBelowSurface, createRoofGeometry, addFarGlassTwins } from './config/BuildingPiecesConfig';
import { ProceduralRoofGenerator, ProceduralRoofConfig, RoofStyle, DEFAULT_ROOF_STYLE } from './ProceduralRoofSystem';
import { findHouseOutline } from './HouseOutline';
import { houseRoofRun } from './HouseRoofGeometry';
import { planFloorOutlineWalls, OUTLINE_WALL_TYPE } from './FloorOutlineWalls';
import type { TKey } from '../i18n/en';
import { dressRoof, resetRoofAtticTile } from './RoofDressing';
import { PhysicsWorld, NPC_GHOST_COLLIDERS } from '../physics/PhysicsWorld';
import { COLLISION_GROUPS } from '../config/constants';
import { ParticleManager } from '../particles/ParticleManager';
import { audioEngine } from '../audio/AudioEngine';
import { ContinuousWallSystem } from './ContinuousWallSystem';
import { WallPaintingSystem, WallCellHitInfo, PaintChangeScope } from './WallPaintingSystem';
import { computeFlippedWalls } from './WallSides';
import { setWallPieceFlipped } from './config/DefaultWallMaterials';
import { isFurniturePiece } from './furniture/FurnitureCatalog';
import { exportBuildingScene, importBuildingScene, downloadBuildingSceneAsJson } from './BuildingSerialization';

/**
 * High-performance 3D spatial partitioning grid for fast O(1) proximity lookups of building pieces.
 */
class SpatialPieceGrid {
  private cellSize: number = 4.0;
  private cells: Map<string, Set<BuiltPiece>> = new Map();

  constructor(cellSize: number = 4.0) {
    this.cellSize = cellSize;
  }

  private getKey(x: number, y: number, z: number): string {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    return `${cx},${cy},${cz}`;
  }

  public insert(piece: BuiltPiece): void {
    const key = this.getKey(piece.position.x, piece.position.y, piece.position.z);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = new Set();
      this.cells.set(key, cell);
    }
    cell.add(piece);
  }

  public remove(piece: BuiltPiece): void {
    const key = this.getKey(piece.position.x, piece.position.y, piece.position.z);
    const cell = this.cells.get(key);
    if (cell) {
      cell.delete(piece);
      if (cell.size === 0) {
        this.cells.delete(key);
      }
    }
  }

  public getPiecesInRadius(center: THREE.Vector3, radius: number): BuiltPiece[] {
    const results: BuiltPiece[] = [];
    const radiusSq = radius * radius;
    const minX = Math.floor((center.x - radius) / this.cellSize);
    const maxX = Math.floor((center.x + radius) / this.cellSize);
    const minY = Math.floor((center.y - radius) / this.cellSize);
    const maxY = Math.floor((center.y + radius) / this.cellSize);
    const minZ = Math.floor((center.z - radius) / this.cellSize);
    const maxZ = Math.floor((center.z + radius) / this.cellSize);

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const key = `${cx},${cy},${cz}`;
          const cell = this.cells.get(key);
          if (!cell) continue;
          for (const piece of cell) {
            if (piece.position.distanceToSquared(center) <= radiusSq) {
              results.push(piece);
            }
          }
        }
      }
    }
    return results;
  }

  public clear(): void {
    this.cells.clear();
  }
}

export class BuildingManager {
  public pieces: Map<string, BuiltPiece> = new Map();
  /** Bumped whenever colliders change (place, remove, move): navigation re-samples. */
  public revision = 0;
  /** Door open/close only changes colliders around that door, so navigation forgets just those cells. */
  public onDoorToggled: ((piece: BuiltPiece) => void) | null = null;
  public group: THREE.Group;
  public continuousWallSystem: ContinuousWallSystem;
  public wallPaintingSystem: WallPaintingSystem;
  private nextPieceId: number = 1;
  private spatialGrid: SpatialPieceGrid = new SpatialPieceGrid(4.0);
  /** Pieces bigger than LARGE_PIECE_EXTENT: their bounds reach well past their grid cell */
  private readonly largePieces = new Set<BuiltPiece>();
  private static readonly LARGE_PIECE_EXTENT = 6.0;
  private static readonly _tempSize = new THREE.Vector3();
  private cachedPiecesArray: BuiltPiece[] | null = null;

  // Baked meshes are rebuilt at most once per frame: edits only mark chunks dirty,
  // flushPendingRegeneration() (called from the game loop) does the actual rebuild.
  /** `revision` the outer/inner wall sides were last worked out for */
  private wallSidesRevision = -1;
  /** `revision` the roofs' frontons last matched their walls for; paint changes force a re-check */
  private roofDressingRevision = -1;
  private roofDressingDirty = false;
  /** Shingle style new roofs get */
  public defaultRoofStyle: RoofStyle = DEFAULT_ROOF_STYLE;

  // Greenhouse pieces are merged per chunk into a few shared meshes (see GreenhouseBatch);
  // "live" ones (a roof whose resize arrows are being dragged) stay as their own mesh meanwhile.
  public readonly greenhouseBatch: GreenhouseBatch;
  private dirtyGreenhouse = false;
  private readonly liveGreenhouseIds = new Set<string>();

  // Reusable scratch objects to eliminate per-frame allocations during raycasts
  private static readonly _tempRay = new THREE.Ray();
  private static readonly _tempHitPoint = new THREE.Vector3();

  constructor(
    private physics: PhysicsWorld,
    public scene: THREE.Scene,
    private particleManager?: ParticleManager
  ) {
    this.group = new THREE.Group();
    this.group.name = 'BuildingManager_ConstructedWorld';
    this.scene.add(this.group);
    this.wallPaintingSystem = new WallPaintingSystem(this.group, BUILDING_MATERIALS.wallChecker);
    this.continuousWallSystem = new ContinuousWallSystem(this.group, this.wallPaintingSystem, {
      getPieces: () => this.pieces,
      near: (center, radius) => this.getPiecesTouchingRadius(center, radius),
    });
    this.greenhouseBatch = new GreenhouseBatch(this.group);
  }

  private markGreenhouseDirty(type: BuildingPieceType): void {
    if (isGreenhousePiece(type)) this.dirtyGreenhouse = true;
  }

  /**
   * Paints (or erases with 'default') a batch of faces as one undoable step.
   * Mesh rebuild is deferred to the end of the frame, so dragging across many faces stays cheap.
   */
  public paintFaces(faces: WallCellHitInfo[], wallpaperId: string): boolean {
    const changed = this.wallPaintingSystem.applyFaceChanges(
      faces.map((f) => ({ pieceId: f.pieceId, faceSide: f.faceSide, wallpaperId }))
    );
    if (changed) this.markPaintDirty(changed);
    return changed !== null;
  }

  public beginPaintStroke(): void {
    this.wallPaintingSystem.beginStroke();
  }

  public endPaintStroke(): void {
    this.wallPaintingSystem.endStroke();
  }

  public undoPaint(): boolean {
    const changed = this.wallPaintingSystem.undo((id) => this.pieces.has(id));
    if (changed) this.markPaintDirty(changed);
    return changed !== null;
  }

  public redoPaint(): boolean {
    const changed = this.wallPaintingSystem.redo((id) => this.pieces.has(id));
    if (changed) this.markPaintDirty(changed);
    return changed !== null;
  }

  /** Painted faces are re-skinned in place (no geometry rebuild); pending pieces get baked. */
  private markPaintDirty(changed: PaintChangeScope): void {
    this.continuousWallSystem.repaint(changed.pieceIds);
    this.roofDressingDirty = true; // frontons follow the outer finish of their walls
  }

  /** Rebuilds the baked chunks marked dirty since the last call. Cheap no-op when nothing changed. */
  public flushPendingRegeneration(): void {
    this.updateWallSides();
    this.continuousWallSystem.flush();
    this.updateRoofDressing();
    if (this.dirtyGreenhouse) {
      this.dirtyGreenhouse = false;
      this.greenhouseBatch.rebuild(this.pieces.values(), (id) => this.liveGreenhouseIds.has(id));
    }
  }

  private updateRoofDressing(): void {
    if (this.roofDressingRevision === this.revision && !this.roofDressingDirty) return;
    this.roofDressingRevision = this.revision;
    this.roofDressingDirty = false;
    for (const piece of this.pieces.values()) {
      if (isProceduralRoofPiece(piece.type)) this.dressRoof(piece);
    }
  }

  private dressRoof(piece: BuiltPiece): void {
    dressRoof(piece, this.wallPaintingSystem, (c, r) => this.getPiecesNear(c, r));
  }

  /**
   * Puts one hip roof over the whole house `wallId` belongs to, following its outer walls (valleys
   * at inner corners). A house roof already standing on the same outline is replaced.
   */
  public placeHouseRoof(wallId: string): { ok: true; piece: BuiltPiece } | { ok: false; reason: TKey } {
    const wall = this.pieces.get(wallId);
    if (!wall) return { ok: false, reason: 'build.houseRoof.noWall' };
    const found = findHouseOutline(wall, (c, r) => this.getPiecesNear(c, r));
    if (found.ok === false) return { ok: false, reason: found.reason };
    const { origin, quaternion, footprint } = found.outline;

    for (const p of this.getPiecesNear(origin, 1)) {
      if (p.roofConfig?.footprint && p.position.distanceTo(origin) < 0.2) this.demolishPiece(p.id);
    }

    const piece = this.placePiece(BuildingPieceType.ROOF_HIP_4X4, origin, quaternion);
    if (!piece) return { ok: false, reason: 'build.houseRoof.failed' };
    const xs = footprint.map((p) => p[0]), zs = footprint.map((p) => p[1]);
    // About 30 degrees, in the height arrow's 0.25 m steps
    const height = THREE.MathUtils.clamp(Math.round((houseRoofRun(footprint) * 0.6 + 0.12) / 0.25) * 0.25, 0.5, 5);
    this.updateRoofConfig(piece.id, {
      roofType: 'hip',
      footprint,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
      height,
      maxHeight: Math.max(5, height),
    });
    return { ok: true, piece };
  }

  /**
   * Walls on every outer edge of the floor this tile belongs to (2 m walls on the tile edges).
   * Edges that already hold a wall, window, door or railing are skipped.
   */
  public placeFloorOutlineWalls(floorId: string): { ok: true; placed: number } | { ok: false; reason: TKey } {
    const floor = this.pieces.get(floorId);
    if (!floor) return { ok: false, reason: 'build.floorWalls.noFloor' };
    const plan = planFloorOutlineWalls(floor, (c, r) => this.getPiecesNear(c, r));
    if (plan.ok === false) return { ok: false, reason: plan.reason };
    if (plan.walls.length === 0) return { ok: false, reason: 'build.floorWalls.nothing' };
    let placed = 0;
    plan.walls.forEach((w, i) => {
      // One sound for the whole outline
      if (this.placePiece(OUTLINE_WALL_TYPE, w.position, w.quaternion, undefined, i > 0)) placed++;
    });
    return placed > 0 ? { ok: true, placed } : { ok: false, reason: 'build.floorWalls.failed' };
  }

  /** Gives one roof a shingle style; returns false for anything that is not a shingle roof */
  public setRoofStyle(pieceId: string, style: RoofStyle): boolean {
    const piece = this.pieces.get(pieceId);
    if (!piece || !isProceduralRoofPiece(piece.type) || isGlassRoofPiece(piece.type)) return false;
    piece.roofStyle = style;
    this.dressRoof(piece);
    return true;
  }

  /**
   * Works out which side of every wall faces outdoors whenever the building changed, and re-skins the
   * walls whose outer side moved (siding outside, wainscoting inside).
   */
  private updateWallSides(): void {
    if (this.wallSidesRevision === this.revision) return;
    this.wallSidesRevision = this.revision;
    const flipped = computeFlippedWalls(this.getAllPieces(), (c, r) => this.getPiecesNear(c, r));
    for (const id of this.wallPaintingSystem.setFlippedWalls(flipped)) {
      const piece = this.pieces.get(id);
      if (!piece) continue;
      setWallPieceFlipped(piece.meshGroup, flipped.has(id));
      if (piece.isConfirmed) this.continuousWallSystem.repaint([id]);
    }
  }

  /**
   * Copies style / wallpapers from sourcePieceId to targetPieceId and regenerates wall visuals.
   */
  public copyPieceStyle(sourcePieceId: string, targetPieceId: string): boolean {
    const sourcePiece = this.pieces.get(sourcePieceId);
    const targetPiece = this.pieces.get(targetPieceId);
    if (!sourcePiece || !targetPiece) return false;

    if (sourcePiece.roofConfig && targetPiece.roofConfig) {
      if (sourcePiece.roofConfig.overhang !== undefined) {
        targetPiece.roofConfig.overhang = sourcePiece.roofConfig.overhang;
      }
      if (sourcePiece.roofConfig.eaveOverhang !== undefined) {
        targetPiece.roofConfig.eaveOverhang = sourcePiece.roofConfig.eaveOverhang;
      }
      if (sourcePiece.roofConfig.gableOverhang !== undefined) {
        targetPiece.roofConfig.gableOverhang = sourcePiece.roofConfig.gableOverhang;
      }
      if (sourcePiece.roofConfig.fasciaDepth !== undefined) {
        targetPiece.roofConfig.fasciaDepth = sourcePiece.roofConfig.fasciaDepth;
      }
    }
    if (sourcePiece.roofStyle && targetPiece.roofConfig) this.setRoofStyle(targetPieceId, sourcePiece.roofStyle);

    const copiedWallpapers = this.wallPaintingSystem.copyPieceStyle(sourcePieceId, targetPieceId);
    if (copiedWallpapers) this.continuousWallSystem.repaint([targetPieceId]);
    return true;
  }

  public getAllPieces(): BuiltPiece[] {
    if (!this.cachedPiecesArray) {
      this.cachedPiecesArray = Array.from(this.pieces.values());
    }
    return this.cachedPiecesArray;
  }

  public getPiecesNear(center: THREE.Vector3, radius: number): BuiltPiece[] {
    return this.spatialGrid.getPiecesInRadius(center, radius);
  }

  /**
   * Pieces whose bounds come within `radius` of `center`. The grid indexes pieces by their origin,
   * so oversized ones (a stretched roof) are checked by their bounding box on top of the grid query.
   */
  public getPiecesTouchingRadius(center: THREE.Vector3, radius: number): BuiltPiece[] {
    const result = this.spatialGrid.getPiecesInRadius(center, radius);
    if (this.largePieces.size > 0) {
      const radiusSq = radius * radius;
      for (const piece of this.largePieces) {
        if (piece.position.distanceToSquared(center) <= radiusSq) continue; // already in the grid result
        if (piece.worldBoundingBox && piece.worldBoundingBox.distanceToPoint(center) <= radius) result.push(piece);
      }
    }
    return result;
  }

  /** Keeps `largePieces` in sync with a piece's current bounding box. */
  private trackPieceSize(piece: BuiltPiece): void {
    const box = piece.worldBoundingBox;
    if (!box) {
      this.largePieces.delete(piece);
      return;
    }
    const size = box.getSize(BuildingManager._tempSize);
    if (Math.max(size.x, size.y, size.z) > BuildingManager.LARGE_PIECE_EXTENT) this.largePieces.add(piece);
    else this.largePieces.delete(piece);
  }

  public getPieceCount(): number {
    return this.pieces.size;
  }

  /**
   * Spawns a built piece in the world with full Rapier physics collisions and 3D visual fidelity.
   * Optimizes performance by baking static matrices and caching precomputed bounding boxes.
   */
  public placePiece(
    type: BuildingPieceType,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    customId?: string,
    skipAudioParticles: boolean = false
  ): BuiltPiece | null {
    if (!this.physics.isInitialized()) return null;

    const pieceDef = BUILDING_PIECES[type];
    if (!pieceDef) return null;

    // Reject placement if the piece would penetrate below the construction platform surface
    if (isPieceBelowSurface(type, position, quaternion)) {
      return null;
    }

    const id = customId || `piece_${this.nextPieceId++}_${type}`;
    if (customId) {
      const idMatch = customId.match(/^piece_(\d+)_/);
      if (idMatch) {
        const num = parseInt(idMatch[1], 10);
        if (!isNaN(num)) {
          this.nextPieceId = Math.max(this.nextPieceId, num + 1);
        }
      }
    }
    const euler = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ');

    // 1. Create Consolidated 3D Visual Mesh (1 single mesh per piece, sharing template geometry)
    const meshGroup = createPieceMeshGroup(type, false);
    addFarGlassTwins(meshGroup); // windows, glazed doors, greenhouse: near/far dithered glass
    meshGroup.position.copy(position);
    meshGroup.quaternion.copy(quaternion);
    meshGroup.userData = { pieceId: id, pieceType: type };

    // Freeze transformation matrices for static building elements
    // This stops Three.js from traversing and re-multiplying world matrices every single frame!
    meshGroup.updateMatrix();
    meshGroup.updateMatrixWorld(true);
    meshGroup.matrixAutoUpdate = false;
    for (let i = 0; i < meshGroup.children.length; i++) {
      const child = meshGroup.children[i];
      child.updateMatrix();
      child.updateMatrixWorld(true);
      child.matrixAutoUpdate = false;
    }

    this.group.add(meshGroup);

    // 2. Precompute world bounding box once at placement time
    const template = getPieceMeshTemplate(type);
    const worldBoundingBox = template.boundingBox.clone().applyMatrix4(meshGroup.matrixWorld);

    // 3. Create Static Rapier Body
    const bodyDesc = this.physics.rapier.RigidBodyDesc.fixed()
      .setTranslation(position.x, position.y, position.z)
      .setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });

    const staticBody = this.physics.world.createRigidBody(bodyDesc);
    staticBody.userData = { pieceId: id, pieceType: type };

    // 4. Create Specific Collision Shape
    const staticCollider = this.createColliderForPiece(type, staticBody);
    (staticCollider as any).userData = { pieceId: id, pieceType: type };

    const builtPiece: BuiltPiece = {
      id,
      type,
      position: position.clone(),
      rotation: euler,
      quaternion: quaternion.clone(),
      meshGroup,
      staticBody,
      staticCollider,
      health: pieceDef.maxHealth,
      maxHealth: pieceDef.maxHealth,
      createdAt: performance.now(),
      worldBoundingBox,
      roofConfig: isProceduralRoofPiece(type) ? getDefaultRoofConfig(type) : undefined,
      roofStyle: isProceduralRoofPiece(type) && !isGlassRoofPiece(type) ? this.defaultRoofStyle : undefined,
    };

    this.pieces.set(id, builtPiece);
    this.spatialGrid.insert(builtPiece);
    this.trackPieceSize(builtPiece);
    this.markGreenhouseDirty(type);
    this.cachedPiecesArray = null; // Invalidate cached pieces array
    this.revision++;

    if (isProceduralRoofPiece(type)) {
      this.rebuildRoofPhysicsCollider(builtPiece);
      this.dressRoof(builtPiece);
    }
    if (isSwingDoorPiece(type)) {
      this.rebuildDoorPhysicsCollider(builtPiece);
    }

    // Walls, floors and foundations start unconfirmed; a window or door cuts its hole in the baked walls
    this.continuousWallSystem.registerPiece(builtPiece);

    // Rebuild physics colliders for solid walls if doors or solid walls are added/modified
    this.rebuildWallCollidersAroundPiece(builtPiece);

    // Audio and particles
    if (!skipAudioParticles) {
      const isWood = type !== BuildingPieceType.STONE_FOUNDATION_2X2;
      audioEngine.at(builtPiece.position).playBuildPlace(isWood);
      if (this.particleManager) {
        this.particleManager.emitBuildPuff(position, isWood);
      }
    }

    return builtPiece;
  }

  /**
   * Procedurally updates the dimensions, geometry, bounding box, and physics collider of a roof piece in-place.
   */
  public updateRoofConfig(
    pieceId: string,
    newConfig: Partial<ProceduralRoofConfig>,
    updatePhysics: boolean = true
  ): BuiltPiece | null {
    const piece = this.pieces.get(pieceId);
    if (!piece || !isProceduralRoofPiece(piece.type)) return null;

    const currentConfig = piece.roofConfig || getDefaultRoofConfig(piece.type);
    const updatedConfig: ProceduralRoofConfig = { ...currentConfig, ...newConfig };
    piece.roofConfig = updatedConfig;

    // 1. Find roof mesh inside piece.meshGroup
    let roofMesh: THREE.Mesh | null = null;
    piece.meshGroup.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && !roofMesh) {
        roofMesh = child as THREE.Mesh;
      }
    });

    if (roofMesh) {
      // Temporarily enable matrix auto-update to apply scale/geometry changes
      piece.meshGroup.matrixAutoUpdate = true;
      (roofMesh as THREE.Mesh).matrixAutoUpdate = true;

      // Update geometry procedurally. Glass roofs change topology with size (more glazing bars),
      // so they get a fresh geometry instead of an in-place update.
      if (isGlassRoofPiece(piece.type)) {
        // The roof mesh and its far-glass twin share one geometry: swap it on both
        const mesh = roofMesh as THREE.Mesh;
        const old = mesh.geometry;
        const geo = createRoofGeometry(piece.type, updatedConfig);
        piece.meshGroup.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry = geo;
        });
        old.dispose();
        // While dragging (no physics update) the roof is drawn on its own, then rejoins the batch
        const wasLive = this.liveGreenhouseIds.has(piece.id);
        if (updatePhysics) this.liveGreenhouseIds.delete(piece.id);
        else this.liveGreenhouseIds.add(piece.id);
        if (updatePhysics || !wasLive) this.dirtyGreenhouse = true;
      } else {
        ProceduralRoofGenerator.updateBufferGeometry((roofMesh as THREE.Mesh).geometry, updatedConfig);
        resetRoofAtticTile(piece);
        this.dressRoof(piece);
      }

      piece.meshGroup.updateMatrix();
      piece.meshGroup.updateMatrixWorld(true);
      piece.meshGroup.matrixAutoUpdate = false;
      (roofMesh as THREE.Mesh).matrixAutoUpdate = false;
    }

    // 2. Re-calculate precomputed world bounding box
    piece.worldBoundingBox = new THREE.Box3().setFromObject(piece.meshGroup);
    this.trackPieceSize(piece);

    // 3. Re-create Rapier Physics Collider for new slope geometry if requested
    if (updatePhysics) {
      this.rebuildRoofPhysicsCollider(piece);
      // Final size: dependants (roof shelter on the ground, baked shade) follow the revision
      this.revision++;
    }

    return piece;
  }

  /**
   * Re-creates the Rapier physics collider using ultra-lightweight slope-only geometry
   * (excludes decorative wooden trim beams for max physics performance).
   */
  public rebuildRoofPhysicsCollider(piece: BuiltPiece): void {
    if (!piece || !isProceduralRoofPiece(piece.type)) return;
    const cfg = piece.roofConfig || getDefaultRoofConfig(piece.type);
    const colBuffers = ProceduralRoofGenerator.generateColliderBuffers(cfg);

    try {
      if (piece.staticCollider && piece.staticCollider.isValid()) {
        this.physics.world.removeCollider(piece.staticCollider, true);
      }

      const colGroup = this.physics.packCollisionGroups(
        COLLISION_GROUPS.ENVIRONMENT,
        0xffff
      );
      const colliderDesc = this.physics.rapier.ColliderDesc.trimesh(colBuffers.positions, colBuffers.indices)
        .setFriction(0.6)
        .setRestitution(0.0)
        .setCollisionGroups(colGroup);

      piece.staticCollider = this.physics.world.createCollider(colliderDesc, piece.staticBody);
      (piece.staticCollider as any).userData = { pieceId: piece.id, pieceType: piece.type };
    } catch (e) {
      console.warn('[BuildingManager] Error updating roof physics collider:', e);
    }
  }

  /**
   * Rotates an already built piece by angleDelta (default +90 degrees = Math.PI / 2).
   * Note: Pieces that are already merged/regenerated into a continuous mesh (confirmed walls & floors)
   * cannot be individually rotated.
   */
  public rotatePiece(pieceId: string, angleDelta: number = Math.PI / 2): boolean {
    const piece = this.pieces.get(pieceId);
    if (!piece) return false;

    // Disallow rotating confirmed/merged continuous walls, floors, or foundations whose individual meshes are hidden
    if (
      piece.isConfirmed &&
      !piece.meshGroup.visible &&
      this.continuousWallSystem.isConfirmablePiece(piece.type)
    ) {
      return false;
    }

    // 1. Calculate new rotation
    const currentEuler = new THREE.Euler().setFromQuaternion(piece.quaternion, 'YXZ');
    currentEuler.y = ((currentEuler.y + angleDelta) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    piece.rotation.copy(currentEuler);
    piece.quaternion.setFromEuler(piece.rotation);

    // 2. Update visual mesh group
    piece.meshGroup.matrixAutoUpdate = true;
    piece.meshGroup.quaternion.copy(piece.quaternion);
    piece.meshGroup.updateMatrix();
    piece.meshGroup.updateMatrixWorld(true);
    piece.meshGroup.matrixAutoUpdate = false;
    for (let i = 0; i < piece.meshGroup.children.length; i++) {
      const child = piece.meshGroup.children[i];
      child.updateMatrix();
      child.updateMatrixWorld(true);
      child.matrixAutoUpdate = false;
    }

    // 3. Update world bounding box
    if (isProceduralRoofPiece(piece.type)) {
      piece.worldBoundingBox = new THREE.Box3().setFromObject(piece.meshGroup);
    } else {
      const template = getPieceMeshTemplate(piece.type);
      piece.worldBoundingBox = template.boundingBox.clone().applyMatrix4(piece.meshGroup.matrixWorld);
    }
    this.trackPieceSize(piece);

    // 4. Update Rapier static rigid body rotation
    if (piece.staticBody) {
      piece.staticBody.setRotation(
        { x: piece.quaternion.x, y: piece.quaternion.y, z: piece.quaternion.z, w: piece.quaternion.w },
        true
      );
    }

    // 5. If procedural roof, rebuild its collider
    if (isProceduralRoofPiece(piece.type)) {
      this.rebuildRoofPhysicsCollider(piece);
    }

    // 6. Update Spatial Grid
    this.spatialGrid.remove(piece);
    this.spatialGrid.insert(piece);
    this.markGreenhouseDirty(piece.type);
    this.cachedPiecesArray = null;
    this.revision++;

    // 7. Baked meshes around it (a turned window moves its hole; a turned pending wall re-cuts the floor)
    this.continuousWallSystem.pieceChanged(piece);

    // 8. Recompute wall colliders if wall/opening rotated
    if (
      isSolidWallPiece(piece.type) ||
      isWindowPiece(piece.type) ||
      isDoorPiece(piece.type) ||
      isDoorwayPiece(piece.type)
    ) {
      this.rebuildWallCollidersAroundPiece(piece);
    }

    return true;
  }

  public getPiece(pieceId: string): BuiltPiece | null {
    return this.pieces.get(pieceId) || null;
  }

  /**
   * Toggles door open/closed state with hinge rotation animation and collider updates.
   * Dynamically opens the door AWAY from the player depending on which side of the sensor trigger zone the player is standing on.
   */
  public toggleDoor(pieceId: string, playerPosition?: THREE.Vector3): boolean {
    const piece = this.pieces.get(pieceId);
    if (!piece || !isSwingDoorPiece(piece.type)) return false;

    piece.isOpen = !piece.isOpen;
    const isOpen = piece.isOpen;
    const openAngle = Math.PI * 0.55;

    let swingMultiplier = 1;
    if (isOpen) {
      if (playerPosition) {
        const doorForward = new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion);
        const toPlayer = playerPosition.clone().sub(piece.position);
        // dot >= 0: Player is on front (+Z) side -> swing AWAY into -Z space (multiplier = 1)
        // dot < 0: Player is on back (-Z) side -> swing AWAY into +Z space (multiplier = -1)
        const dot = toPlayer.dot(doorForward);
        swingMultiplier = dot >= 0 ? 1 : -1;
      } else {
        swingMultiplier = piece.lastSwingMultiplier || 1;
      }
      piece.lastSwingMultiplier = swingMultiplier;
    } else {
      swingMultiplier = piece.lastSwingMultiplier || 1;
    }

    piece.meshGroup.traverse((child) => {
      if (child.name === 'doorPivot') {
        child.matrixAutoUpdate = true;
        child.rotation.y = isOpen ? openAngle * swingMultiplier : 0;
        child.updateMatrix();
        child.matrixWorldNeedsUpdate = true;
      } else if (child.name === 'doorPivotLeft') {
        child.matrixAutoUpdate = true;
        child.rotation.y = isOpen ? openAngle * swingMultiplier : 0;
        child.updateMatrix();
        child.matrixWorldNeedsUpdate = true;
      } else if (child.name === 'doorPivotRight') {
        child.matrixAutoUpdate = true;
        child.rotation.y = isOpen ? -openAngle * swingMultiplier : 0;
        child.updateMatrix();
        child.matrixWorldNeedsUpdate = true;
      }
    });

    piece.meshGroup.matrixWorldNeedsUpdate = true;
    piece.meshGroup.updateMatrixWorld(true);

    // Rebuild physics collider for open/closed state
    this.rebuildDoorPhysicsCollider(piece);
    this.onDoorToggled?.(piece);

    // Audio feedback
    audioEngine.at(piece.position).playDoorToggle(isOpen);

    return true;
  }

  /**
   * Stair flights for navigation: the walkable ends (floor level) of every stair piece. A ramp
   * rises from the piece's -Z/-Y edge to its +Z/+Y edge (see the stair colliders).
   */
  public getStairs(): { bottom: THREE.Vector3; top: THREE.Vector3 }[] {
    const out = [];
    for (const piece of this.pieces.values()) {
      const def = BUILDING_PIECES[piece.type];
      if (def?.category !== PieceCategory.STAIRS) continue;
      const d = def.dimensions;
      out.push({
        bottom: new THREE.Vector3(0, -d.y / 2, -d.z / 2).applyQuaternion(piece.quaternion).add(piece.position),
        top: new THREE.Vector3(0, d.y / 2, d.z / 2).applyQuaternion(piece.quaternion).add(piece.position),
      });
    }
    return out;
  }

  /**
   * Door openings for navigation: floor centre, facing normal and clear half-width between the jambs
   * (matches the frame colliders in rebuildDoorPhysicsCollider).
   */
  public getDoorOpenings(): {
    id: string; x: number; y: number; z: number; nx: number; nz: number; half: number; body: RAPIER.RigidBody | null; swing: number; reach: number;
  }[] {
    const out = [];
    for (const piece of this.pieces.values()) {
      if (!isSwingDoorPiece(piece.type)) continue;
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion);
      const isGlass = piece.type === BuildingPieceType.GLASS_DOOR_1X3;
      const half =
        piece.type === BuildingPieceType.WOOD_DOOR_DOUBLE ? 0.9 : piece.type === BuildingPieceType.DOOR_GRAND_SIDELITES_2X2 ? 0.46 : isGlass ? 0.43 : 0.42;
      out.push({
        id: piece.id,
        x: piece.position.x,
        y: piece.position.y - (isGlass ? 1.5 : 1.0),
        z: piece.position.z,
        nx: n.x,
        nz: n.z,
        half,
        body: piece.staticBody ?? null,
        // Swing multiplier 1 puts the open leaves on the door's -Z side (see rebuildDoorPhysicsCollider)
        swing: piece.isOpen ? -(piece.lastSwingMultiplier || 1) : 0,
        // Leaf length: one leaf spans the opening, a double door's two leaves half of it each
        reach: piece.type === BuildingPieceType.WOOD_DOOR_DOUBLE ? half : half * 2,
      });
    }
    return out;
  }

  /**
   * Detects if player is inside the door's sensor trigger zone (covering front +Z and back -Z sides).
   * Returns nearby door piece and side info (isPlayerInFront).
   */
  public getNearbyDoor(
    playerPosition: THREE.Vector3,
    maxDistance: number = 2.8
  ): { piece: BuiltPiece; distance: number; isPlayerInFront: boolean } | null {
    let closest: { piece: BuiltPiece; distance: number; isPlayerInFront: boolean } | null = null;
    let minDistance = maxDistance;

    for (const piece of this.pieces.values()) {
      if (!isSwingDoorPiece(piece.type)) continue;

      const dist = playerPosition.distanceTo(piece.position);
      if (dist < minDistance) {
        // Transform player position to local door space to evaluate sensor box bounds
        const localPos = playerPosition.clone().sub(piece.position).applyQuaternion(piece.quaternion.clone().invert());
        const isDoubleWide = isDoorPiece(piece.type) && getWallSize(piece.type)[0] >= 2;
        const halfWidth = isDoubleWide ? 1.4 : 0.8;

        if (Math.abs(localPos.x) <= halfWidth && Math.abs(localPos.z) <= 1.5 && Math.abs(localPos.y) <= 1.8) {
          const doorForward = new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion);
          const toPlayer = playerPosition.clone().sub(piece.position);
          const isPlayerInFront = toPlayer.dot(doorForward) >= 0;

          minDistance = dist;
          closest = { piece, distance: dist, isPlayerInFront };
        }
      }
    }

    return closest;
  }

  /**
   * Re-creates door physics colliders based on current isOpen rotation state and swing direction.
   */
  public rebuildDoorPhysicsCollider(piece: BuiltPiece): void {
    if (!piece || !isSwingDoorPiece(piece.type)) return;

    try {
      if (piece.staticBody && piece.staticBody.isValid()) {
        const num = piece.staticBody.numColliders();
        for (let i = num - 1; i >= 0; i--) {
          const c = piece.staticBody.collider(i);
          if (c && c.isValid()) {
            NPC_GHOST_COLLIDERS.delete(c.handle);
            this.physics.world.removeCollider(c, false);
          }
        }
      }

      const colGroup = this.physics.packCollisionGroups(
        COLLISION_GROUPS.ENVIRONMENT,
        0xffff
      );

      const sensorColGroup = this.physics.packCollisionGroups(
        COLLISION_GROUPS.TRIGGERS,
        COLLISION_GROUPS.CHARACTER
      );

      const swingMultiplier = piece.lastSwingMultiplier || 1;

      const isSingleDoorType = isDoorPiece(piece.type) && getWallSize(piece.type)[0] < 2;

      if (piece.type === BuildingPieceType.GLASS_DOOR_1X3) {
        // Greenhouse door, 3m panel: transom above a 0.86 x 2.25m opening (leaf centre y = -0.355)
        const transomDesc = this.physics.rapier.ColliderDesc.cuboid(0.5, 0.36, WALL_THICKNESS / 2.0)
          .setTranslation(0, 1.14, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(transomDesc, piece.staticBody);
        for (const x of [-0.47, 0.47]) {
          const jamb = this.physics.rapier.ColliderDesc.cuboid(0.03, 1.5, WALL_THICKNESS / 2.0)
            .setTranslation(x, 0, 0)
            .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
          this.physics.world.createCollider(jamb, piece.staticBody);
        }

        const sensorDesc = this.physics.rapier.ColliderDesc.cuboid(0.8, 1.5, 1.3)
          .setSensor(true)
          .setCollisionGroups(sensorColGroup);
        const sensorCollider = this.physics.world.createCollider(sensorDesc, piece.staticBody);
        (sensorCollider as any).userData = { isDoorSensor: true, pieceId: piece.id };

        if (piece.isOpen) {
          const rotY = swingMultiplier === 1 ? -Math.PI / 2 : Math.PI / 2;
          const openQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
          const offsetZ = swingMultiplier === 1 ? -0.43 : 0.43;
          const desc = this.physics.rapier.ColliderDesc.cuboid(0.43, 1.12, 0.03)
            .setTranslation(-0.43, -0.355, offsetZ)
            .setRotation({ x: openQuat.x, y: openQuat.y, z: openQuat.z, w: openQuat.w })
            .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
          piece.staticCollider = this.physics.world.createCollider(desc, piece.staticBody);
          NPC_GHOST_COLLIDERS.add(piece.staticCollider.handle);
        } else {
          const desc = this.physics.rapier.ColliderDesc.cuboid(0.43, 1.12, 0.03)
            .setTranslation(0, -0.355, 0)
            .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
          piece.staticCollider = this.physics.world.createCollider(desc, piece.staticBody);
        }
      } else if (isSingleDoorType) {
        // Permanent outer frame colliders (top header, left jamb, right jamb)
        const topHeaderDesc = this.physics.rapier.ColliderDesc.cuboid(0.50, 0.06, WALL_THICKNESS / 2.0)
          .setTranslation(0, 0.94, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(topHeaderDesc, piece.staticBody);

        const leftJambDesc = this.physics.rapier.ColliderDesc.cuboid(0.04, 0.94, WALL_THICKNESS / 2.0)
          .setTranslation(-0.46, -0.06, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(leftJambDesc, piece.staticBody);

        const rightJambDesc = this.physics.rapier.ColliderDesc.cuboid(0.04, 0.94, WALL_THICKNESS / 2.0)
          .setTranslation(0.46, -0.06, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(rightJambDesc, piece.staticBody);

        // Door proximity collision sensor trigger
        const sensorDesc = this.physics.rapier.ColliderDesc.cuboid(0.8, 1.2, 1.3)
          .setSensor(true)
          .setCollisionGroups(sensorColGroup);
        const sensorCollider = this.physics.world.createCollider(sensorDesc, piece.staticBody);
        (sensorCollider as any).userData = { isDoorSensor: true, pieceId: piece.id };

        // Moving door leaf panel collider
        if (piece.isOpen) {
          const rotY = swingMultiplier === 1 ? -Math.PI / 2 : Math.PI / 2;
          const openQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
          const offsetZ = swingMultiplier === 1 ? -0.42 : 0.42;
          const desc = this.physics.rapier.ColliderDesc.cuboid(0.42, 0.94, 0.03)
            .setTranslation(-0.42, -0.06, offsetZ)
            .setRotation({ x: openQuat.x, y: openQuat.y, z: openQuat.z, w: openQuat.w })
            .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
          piece.staticCollider = this.physics.world.createCollider(desc, piece.staticBody);
          NPC_GHOST_COLLIDERS.add(piece.staticCollider.handle);
        } else {
          const desc = this.physics.rapier.ColliderDesc.cuboid(0.42, 0.94, 0.03)
            .setTranslation(0, -0.06, 0)
            .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
          piece.staticCollider = this.physics.world.createCollider(desc, piece.staticBody);
        }
      } else if (piece.type === BuildingPieceType.DOOR_GRAND_SIDELITES_2X2) {
        // Grand entry door: 2.0m wide unit with stationary sidelites and center swinging door
        const topHeaderDesc = this.physics.rapier.ColliderDesc.cuboid(1.0, 0.06, WALL_THICKNESS / 2.0)
          .setTranslation(0, 0.94, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(topHeaderDesc, piece.staticBody);

        // Stationary left sidelite wall & glass barrier
        const leftSideliteDesc = this.physics.rapier.ColliderDesc.cuboid(0.25, 0.94, WALL_THICKNESS / 2.0)
          .setTranslation(-0.75, -0.06, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(leftSideliteDesc, piece.staticBody);

        // Stationary right sidelite wall & glass barrier
        const rightSideliteDesc = this.physics.rapier.ColliderDesc.cuboid(0.25, 0.94, WALL_THICKNESS / 2.0)
          .setTranslation(0.75, -0.06, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(rightSideliteDesc, piece.staticBody);

        // Proximity sensor trigger for center opening
        const sensorDesc = this.physics.rapier.ColliderDesc.cuboid(1.2, 1.2, 1.3)
          .setSensor(true)
          .setCollisionGroups(sensorColGroup);
        const sensorCollider = this.physics.world.createCollider(sensorDesc, piece.staticBody);
        (sensorCollider as any).userData = { isDoorSensor: true, pieceId: piece.id };

        // Center door leaf collider (width 0.92, half-extent 0.46)
        if (piece.isOpen) {
          const rotY = swingMultiplier === 1 ? -Math.PI / 2 : Math.PI / 2;
          const openQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
          const offsetZ = swingMultiplier === 1 ? -0.46 : 0.46;
          const desc = this.physics.rapier.ColliderDesc.cuboid(0.46, 0.94, 0.03)
            .setTranslation(-0.46, -0.06, offsetZ)
            .setRotation({ x: openQuat.x, y: openQuat.y, z: openQuat.z, w: openQuat.w })
            .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
          piece.staticCollider = this.physics.world.createCollider(desc, piece.staticBody);
          NPC_GHOST_COLLIDERS.add(piece.staticCollider.handle);
        } else {
          const desc = this.physics.rapier.ColliderDesc.cuboid(0.46, 0.94, 0.03)
            .setTranslation(0, -0.06, 0)
            .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
          piece.staticCollider = this.physics.world.createCollider(desc, piece.staticBody);
        }
      } else if (piece.type === BuildingPieceType.WOOD_DOOR_DOUBLE) {
        // Permanent outer frame colliders
        const topHeaderDesc = this.physics.rapier.ColliderDesc.cuboid(1.0, 0.06, WALL_THICKNESS / 2.0)
          .setTranslation(0, 0.94, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(topHeaderDesc, piece.staticBody);

        const leftJambDesc = this.physics.rapier.ColliderDesc.cuboid(0.05, 0.94, WALL_THICKNESS / 2.0)
          .setTranslation(-0.95, -0.06, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(leftJambDesc, piece.staticBody);

        const rightJambDesc = this.physics.rapier.ColliderDesc.cuboid(0.05, 0.94, WALL_THICKNESS / 2.0)
          .setTranslation(0.95, -0.06, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(rightJambDesc, piece.staticBody);

        // Door proximity collision sensor trigger
        const sensorDesc = this.physics.rapier.ColliderDesc.cuboid(1.3, 1.2, 1.3)
          .setSensor(true)
          .setCollisionGroups(sensorColGroup);
        const sensorCollider = this.physics.world.createCollider(sensorDesc, piece.staticBody);
        (sensorCollider as any).userData = { isDoorSensor: true, pieceId: piece.id };

        if (piece.isOpen) {
          const leftRotY = swingMultiplier === 1 ? -Math.PI / 2 : Math.PI / 2;
          const rightRotY = swingMultiplier === 1 ? Math.PI / 2 : -Math.PI / 2;
          const offsetZ = swingMultiplier === 1 ? -0.45 : 0.45;

          const leftQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), leftRotY);
          const leftDesc = this.physics.rapier.ColliderDesc.cuboid(0.45, 0.94, 0.03)
            .setTranslation(-0.90, -0.06, offsetZ)
            .setRotation({ x: leftQuat.x, y: leftQuat.y, z: leftQuat.z, w: leftQuat.w })
            .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
          NPC_GHOST_COLLIDERS.add(this.physics.world.createCollider(leftDesc, piece.staticBody).handle);

          const rightQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rightRotY);
          const rightDesc = this.physics.rapier.ColliderDesc.cuboid(0.45, 0.94, 0.03)
            .setTranslation(0.90, -0.06, offsetZ)
            .setRotation({ x: rightQuat.x, y: rightQuat.y, z: rightQuat.z, w: rightQuat.w })
            .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
          piece.staticCollider = this.physics.world.createCollider(rightDesc, piece.staticBody);
          NPC_GHOST_COLLIDERS.add(piece.staticCollider.handle);
        } else {
          const desc = this.physics.rapier.ColliderDesc.cuboid(0.90, 0.94, 0.03)
            .setTranslation(0, -0.06, 0)
            .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
          piece.staticCollider = this.physics.world.createCollider(desc, piece.staticBody);
        }
      }

      if (piece.staticCollider) {
        (piece.staticCollider as any).userData = { pieceId: piece.id, pieceType: piece.type };
      }
    } catch (e) {
      console.warn('[BuildingManager] Error updating door physics collider:', e);
    }
  }

  /**
   * Rebuilds physics colliders for solid walls to accommodate door and window openings,
   * allowing player passage through doorways and clean raycast selection/targeting of placed windows.
   */
  public rebuildWallCollidersAroundPiece(piece: BuiltPiece): void {
    const isOpening = isDoorPiece(piece.type) || isDoorwayPiece(piece.type) || isWindowPiece(piece.type);
    const isWall = isSolidWallPiece(piece.type);

    if (!isOpening && !isWall) return;

    const wallsToRebuild: BuiltPiece[] = [];
    if (isWall) {
      wallsToRebuild.push(piece);
    } else if (isOpening) {
      for (const other of this.pieces.values()) {
        if (!isSolidWallPiece(other.type)) continue;
        const dy = Math.abs(other.position.y - piece.position.y);
        if (dy > 2.5) continue;
        const delta = piece.position.clone().sub(other.position);
        const wallNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(other.quaternion);
        if (Math.abs(delta.dot(wallNormal)) > 0.35) continue;
        const wallTangent = new THREE.Vector3(1, 0, 0).applyQuaternion(other.quaternion);
        const localX = Math.abs(delta.dot(wallTangent));
        const wHalfW = getWallHalfWidth(other.type);
        const oHalfW = getWallHalfWidth(piece.type);
        if (localX < wHalfW + oHalfW) {
          wallsToRebuild.push(other);
        }
      }
    }

    for (const wall of wallsToRebuild) {
      this.rebuildSolidWallCollider(wall);
    }
  }

  public rebuildSolidWallCollider(wall: BuiltPiece): void {
    if (!wall || !isSolidWallPiece(wall.type) || !wall.staticBody || !wall.staticBody.isValid()) return;

    // Remove existing colliders on the solid wall body
    try {
      const num = wall.staticBody.numColliders();
      for (let i = num - 1; i >= 0; i--) {
        const c = wall.staticBody.collider(i);
        if (c && c.isValid()) {
          this.physics.world.removeCollider(c, false);
        }
      }
    } catch (e) {
      console.warn('[BuildingManager] Error clearing wall colliders:', e);
    }

    const colGroup = this.physics.packCollisionGroups(COLLISION_GROUPS.ENVIRONMENT, 0xffff);
    const wallHalfW = getWallHalfWidth(wall.type);
    const wallHalfH = getWallHalfHeight(wall.type);
    const wallTangent = new THREE.Vector3(1, 0, 0).applyQuaternion(wall.quaternion);
    const wallNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(wall.quaternion);

    // Find all doors/doorways/windows cutting this wall
    const overlappingOpenings: Array<{ minX: number; maxX: number; minY: number; maxY: number }> = [];
    for (const other of this.pieces.values()) {
      if (!isDoorPiece(other.type) && !isDoorwayPiece(other.type) && !isWindowPiece(other.type)) continue;
      const dy = Math.abs(other.position.y - wall.position.y);
      if (dy > wallHalfH + getWallHalfHeight(other.type) + 0.5) continue;
      const delta = other.position.clone().sub(wall.position);
      if (Math.abs(delta.dot(wallNormal)) > 0.35) continue;

      const otherTangent = new THREE.Vector3(1, 0, 0).applyQuaternion(other.quaternion);
      if (Math.abs(otherTangent.dot(wallTangent)) < 0.707) continue;

      const localX = delta.dot(wallTangent);
      const localY = delta.y;
      const oHalfW = getWallHalfWidth(other.type);
      const oHalfH = getWallHalfHeight(other.type);

      const oMinX = localX - oHalfW;
      const oMaxX = localX + oHalfW;
      const oMinY = localY - oHalfH;
      const oMaxY = localY + oHalfH;

      // Check overlap with wall rectangular bounds [-wallHalfW, wallHalfW] x [-wallHalfH, wallHalfH]
      if (oMaxX > -wallHalfW + 0.02 && oMinX < wallHalfW - 0.02 && oMaxY > -wallHalfH + 0.02 && oMinY < wallHalfH - 0.02) {
        overlappingOpenings.push({
          minX: Math.max(-wallHalfW, oMinX),
          maxX: Math.min(wallHalfW, oMaxX),
          minY: Math.max(-wallHalfH, oMinY),
          maxY: Math.min(wallHalfH, oMaxY),
        });
      }
    }

    // If no openings overlap, generate standard full solid wall cuboid
    if (overlappingOpenings.length === 0) {
      const desc = this.physics.rapier.ColliderDesc.cuboid(wallHalfW, wallHalfH, WALL_THICKNESS / 2.0)
        .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
      wall.staticCollider = this.physics.world.createCollider(desc, wall.staticBody);
      (wall.staticCollider as any).userData = { pieceId: wall.id, pieceType: wall.type };
      return;
    }

    // 2D Exact Interval Grid Partitioning
    // Collect all unique X split coordinates within [-wallHalfW, wallHalfW]
    const rawXSplits = [-wallHalfW, wallHalfW];
    for (const op of overlappingOpenings) {
      rawXSplits.push(op.minX, op.maxX);
    }
    rawXSplits.sort((a, b) => a - b);
    const xSplits: number[] = [];
    for (const x of rawXSplits) {
      if (xSplits.length === 0 || Math.abs(x - xSplits[xSplits.length - 1]) > 0.01) {
        xSplits.push(x);
      }
    }

    // Collect all unique Y split coordinates within [-wallHalfH, wallHalfH]
    const rawYSplits = [-wallHalfH, wallHalfH];
    for (const op of overlappingOpenings) {
      rawYSplits.push(op.minY, op.maxY);
    }
    rawYSplits.sort((a, b) => a - b);
    const ySplits: number[] = [];
    for (const y of rawYSplits) {
      if (ySplits.length === 0 || Math.abs(y - ySplits[ySplits.length - 1]) > 0.01) {
        ySplits.push(y);
      }
    }

    // Determine solidity of each 2D cell
    const numRows = ySplits.length - 1;
    const numCols = xSplits.length - 1;
    const cellSolid: boolean[][] = [];

    for (let j = 0; j < numRows; j++) {
      cellSolid[j] = [];
      const y0 = ySplits[j];
      const y1 = ySplits[j + 1];
      const cy = (y0 + y1) / 2;

      for (let k = 0; k < numCols; k++) {
        const x0 = xSplits[k];
        const x1 = xSplits[k + 1];
        const cx = (x0 + x1) / 2;

        const isInsideOpening = overlappingOpenings.some(
          (op) =>
            cx >= op.minX - 0.005 &&
            cx <= op.maxX + 0.005 &&
            cy >= op.minY - 0.005 &&
            cy <= op.maxY + 0.005
        );

        cellSolid[j][k] = !isInsideOpening && x1 - x0 > 0.01 && y1 - y0 > 0.01;
      }
    }

    // Merge contiguous solid cells horizontally along each row
    interface SolidRect {
      x0: number;
      x1: number;
      y0: number;
      y1: number;
    }
    const solidRects: SolidRect[] = [];

    for (let j = 0; j < numRows; j++) {
      let startK = -1;
      for (let k = 0; k < numCols; k++) {
        if (cellSolid[j][k]) {
          if (startK === -1) startK = k;
        } else {
          if (startK !== -1) {
            solidRects.push({
              x0: xSplits[startK],
              x1: xSplits[k],
              y0: ySplits[j],
              y1: ySplits[j + 1],
            });
            startK = -1;
          }
        }
      }
      if (startK !== -1) {
        solidRects.push({
          x0: xSplits[startK],
          x1: xSplits[numCols],
          y0: ySplits[j],
          y1: ySplits[j + 1],
        });
      }
    }

    // Merge vertically adjacent rectangles with matching horizontal spans
    let merged = true;
    while (merged) {
      merged = false;
      for (let a = 0; a < solidRects.length; a++) {
        for (let b = a + 1; b < solidRects.length; b++) {
          const rA = solidRects[a];
          const rB = solidRects[b];
          if (
            Math.abs(rA.x0 - rB.x0) < 0.005 &&
            Math.abs(rA.x1 - rB.x1) < 0.005 &&
            Math.abs(rA.y1 - rB.y0) < 0.005
          ) {
            rA.y1 = rB.y1;
            solidRects.splice(b, 1);
            merged = true;
            break;
          }
        }
        if (merged) break;
      }
    }

    // Create Rapier colliders for all resulting solid rectangles
    wall.staticCollider = undefined as any;
    for (const r of solidRects) {
      const spanW = r.x1 - r.x0;
      const spanH = r.y1 - r.y0;
      if (spanW < 0.02 || spanH < 0.02) continue;

      const centerX = (r.x0 + r.x1) / 2;
      const centerY = (r.y0 + r.y1) / 2;

      const desc = this.physics.rapier.ColliderDesc.cuboid(spanW / 2, spanH / 2, WALL_THICKNESS / 2.0)
        .setTranslation(centerX, centerY, 0)
        .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
      const c = this.physics.world.createCollider(desc, wall.staticBody);
      (c as any).userData = { pieceId: wall.id, pieceType: wall.type };

      if (!wall.staticCollider) {
        wall.staticCollider = c;
      }
    }
  }

  /**
   * Demolishes an existing piece, releasing resources and physics colliders.
   */
  public demolishPiece(id: string): boolean {
    const piece = this.pieces.get(id);
    if (!piece) return false;

    this.continuousWallSystem.unregisterPiece(piece);

    // 1. Remove from physics
    try {
      if (piece.staticCollider && piece.staticCollider.isValid()) {
        this.physics.world.removeCollider(piece.staticCollider, true);
      }
      if (piece.staticBody && piece.staticBody.isValid()) {
        this.physics.world.removeRigidBody(piece.staticBody);
      }
    } catch (err) {
      console.warn('[BuildingManager] Physics collider removal error:', err);
    }

    // 2. Remove from 3D Scene. Template geometry is shared and stays cached; only procedural roofs
    // own a per-piece geometry, which must be freed here or it stays on the GPU forever.
    this.group.remove(piece.meshGroup);
    if (isProceduralRoofPiece(piece.type)) {
      piece.meshGroup.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
    }

    // 3. Update spatial index & cache
    this.spatialGrid.remove(piece);
    this.largePieces.delete(piece);
    this.liveGreenhouseIds.delete(piece.id);
    this.markGreenhouseDirty(piece.type);
    this.cachedPiecesArray = null;
    this.revision++;

    // 4. Sound & Particles
    const isWood = piece.type !== BuildingPieceType.STONE_FOUNDATION_2X2;
    audioEngine.at(piece.position, 4).playBuildDemolish();
    if (this.particleManager) {
      this.particleManager.emitBuildPuff(piece.position, isWood);
    }

    this.pieces.delete(id);
    this.wallPaintingSystem.removePiece(id);

    // Rebuild physics colliders for any solid walls if a door was demolished
    this.rebuildWallCollidersAroundPiece(piece);

    return true;
  }

  /**
   * Casts a ray from player viewpoint to find the targeted piece for deconstruction or repair.
   * Utilizes Rapier's BVH raycast for hardware-accelerated O(1) detection, with precomputed
   * bounding box fallback without per-frame memory allocation or vertex traversal.
   */
  public findPieceUnderRay(
    rayOrigin: THREE.Vector3,
    rayDirection: THREE.Vector3,
    maxDistance: number = 25.0,
    excludeCollider?: RAPIER.Collider
  ): BuiltPiece | null {
    // 1. Fast Path: Rapier BVH Physics Raycast (< 0.01ms)
    try {
      const buildingRaycastFilter = this.physics.packCollisionGroups(
        COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS,
        0xffff & ~COLLISION_GROUPS.TRIGGERS & ~COLLISION_GROUPS.CHARACTER
      );
      const rayHit = this.physics.castRay(
        rayOrigin,
        rayDirection,
        maxDistance,
        true,
        undefined,
        buildingRaycastFilter,
        excludeCollider
      );
      if (rayHit) {
        const colliderAny = rayHit.collider as any;
        const body = colliderAny?.parent ? colliderAny.parent() : null;
        const pieceId = (body?.userData as any)?.pieceId || colliderAny?.userData?.pieceId;
        if (pieceId) {
          const hitPiece = this.pieces.get(pieceId);
          if (hitPiece) return hitPiece;
        }
      }
    } catch {
      // Fallback below
    }

    // 2. Fallback Path: Precomputed World Bounding Boxes (Zero Allocations)
    BuildingManager._tempRay.set(rayOrigin, rayDirection);
    let closestPiece: BuiltPiece | null = null;
    let minDistance = maxDistance;

    for (const piece of this.pieces.values()) {
      if (!piece.worldBoundingBox) continue;

      if (BuildingManager._tempRay.intersectBox(piece.worldBoundingBox, BuildingManager._tempHitPoint)) {
        const dist = rayOrigin.distanceTo(BuildingManager._tempHitPoint);
        if (dist < minDistance) {
          minDistance = dist;
          closestPiece = piece;
        }
      }
    }

    return closestPiece;
  }

  /**
   * Creates Rapier physics colliders tailored to the piece's geometry.
   */
  private createColliderForPiece(type: BuildingPieceType, body: RAPIER.RigidBody): RAPIER.Collider {
    const colGroup = this.physics.packCollisionGroups(
      COLLISION_GROUPS.ENVIRONMENT,
      0xffff
    );

    const sensorColGroup = this.physics.packCollisionGroups(
      COLLISION_GROUPS.TRIGGERS,
      COLLISION_GROUPS.CHARACTER
    );

    let colliderDesc: RAPIER.ColliderDesc;

    // Furniture: one box matching the visual mesh bounds (pivot is the box centre)
    if (isFurniturePiece(type)) {
      const size = getPieceMeshTemplate(type).boundingBox.getSize(new THREE.Vector3());
      colliderDesc = this.physics.rapier.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setFriction(0.6)
        .setRestitution(0.0)
        .setCollisionGroups(colGroup);
      return this.physics.world.createCollider(colliderDesc, body);
    }

    // Glass doorway 1x3: transom header over a walk-through opening, flanked by slim posts
    if (type === BuildingPieceType.GLASS_DOORWAY_1X3) {
      const header = this.physics.rapier.ColliderDesc.cuboid(0.5, 0.3, WALL_THICKNESS / 2.0)
        .setTranslation(0, 1.2, 0)
        .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
      this.physics.world.createCollider(header, body);
      for (const x of [-0.46, 0.46]) {
        const post = this.physics.rapier.ColliderDesc.cuboid(0.04, 1.2, WALL_THICKNESS / 2.0)
          .setTranslation(x, -0.3, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        if (x > 0) return this.physics.world.createCollider(post, body);
        this.physics.world.createCollider(post, body);
      }
    }

    // Glass greenhouse pieces collide exactly like their wooden twins
    switch (shapeOf(type)) {
      case BuildingPieceType.WOOD_FLOOR_2X2: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, 0.06, HALF_SIZE)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_FLOOR_1X1: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(0.5, 0.06, 0.5)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_WALL_2X3: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, 1.5, WALL_THICKNESS / 2.0)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_WALL_1X3: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(0.5, 1.5, WALL_THICKNESS / 2.0)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_WALL_WINDOW_2X2: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, HALF_SIZE, WALL_THICKNESS / 2.0)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_WALL_1X2:
      case BuildingPieceType.WOOD_WALL_WINDOW_1X2: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(0.5, HALF_SIZE, WALL_THICKNESS / 2.0)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_WALL_WINDOW_1X1_5: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(0.5, 0.75, WALL_THICKNESS / 2.0)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_WALL_2X1: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, 0.5, WALL_THICKNESS / 2.0)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_WALL_1X1: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(0.5, 0.5, WALL_THICKNESS / 2.0)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_WALL_WINDOW_2X4: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, 2.0, WALL_THICKNESS / 2.0)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_STAIRS_2X2: {
        // Tilted smooth ramp collider matching the step slope (rising from -Z/-Y to +Z/+Y)
        // This allows character controller to walk up and down fluidly without catching on step edges!
        const rampLength = Math.sqrt(MODULE_SIZE * MODULE_SIZE + MODULE_SIZE * MODULE_SIZE);
        const rampQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 4);
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, 0.08, rampLength / 2.0)
          .setRotation({ x: rampQuat.x, y: rampQuat.y, z: rampQuat.z, w: rampQuat.w })
          .setFriction(0.7)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_STAIRS_2X1: {
        // Tilted smooth ramp collider for 1-unit high stairs (atan2(1, 2) ≈ 26.565°)
        const rampLength = Math.sqrt(MODULE_SIZE * MODULE_SIZE + 1.0 * 1.0);
        const rampAngle = Math.atan2(1.0, MODULE_SIZE);
        const rampQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -rampAngle);
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, 0.08, rampLength / 2.0)
          .setRotation({ x: rampQuat.x, y: rampQuat.y, z: rampQuat.z, w: rampQuat.w })
          .setFriction(0.7)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_STAIRS_2X3: {
        // Tilted smooth ramp collider matching 3m height / 3m length at 45° slope (same angle as 2x2)
        const rampLength = Math.sqrt(3.0 * 3.0 + 3.0 * 3.0);
        const rampQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 4);
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, 0.08, rampLength / 2.0)
          .setRotation({ x: rampQuat.x, y: rampQuat.y, z: rampQuat.z, w: rampQuat.w })
          .setFriction(0.7)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_ROOF_26: {
        const roofLength = Math.sqrt(MODULE_SIZE * MODULE_SIZE + 0.9 * 0.9);
        const roofAngle = Math.atan2(0.9, MODULE_SIZE);
        const roofQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -roofAngle);
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, 0.08, roofLength / 2.0)
          .setRotation({ x: roofQuat.x, y: roofQuat.y, z: roofQuat.z, w: roofQuat.w })
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.ROOF_GABLE_2X2:
      case BuildingPieceType.ROOF_HIP_2X2:
      case BuildingPieceType.ROOF_SHED_2X2: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, 0.42, HALF_SIZE)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.ROOF_GABLE_2X4:
      case BuildingPieceType.ROOF_HIP_2X4:
      case BuildingPieceType.ROOF_SHED_2X4: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, 0.42, 2.0)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.ROOF_GABLE_4X4:
      case BuildingPieceType.ROOF_HIP_4X4:
      case BuildingPieceType.ROOF_SHED_4X4: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(2.0, 0.8, 2.0)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_POLE_2M: {
        colliderDesc = this.physics.rapier.ColliderDesc.cylinder(HALF_SIZE, 0.12)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.CHECKER_PILLAR_1M: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(0.2, 0.5, 0.2)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.CORNER_RUSTICATED_QUOIN_1M: {
        // Decorative facade element with non-blocking sensor collider
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(0.15, 0.5, 0.15)
          .setSensor(true)
          .setCollisionGroups(sensorColGroup);
        break;
      }

      case BuildingPieceType.STONE_FOUNDATION_2X2: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, 0.5, HALF_SIZE)
          .setFriction(0.8)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_WALL_DOORWAY_2X2: {
        const lintelDesc = this.physics.rapier.ColliderDesc.cuboid(1.0, 0.15, WALL_THICKNESS / 2.0)
          .setTranslation(0, 0.85, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(lintelDesc, body);

        const leftDesc = this.physics.rapier.ColliderDesc.cuboid(0.1, 0.85, WALL_THICKNESS / 2.0)
          .setTranslation(-0.9, -0.15, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(leftDesc, body);

        const rightDesc = this.physics.rapier.ColliderDesc.cuboid(0.1, 0.85, WALL_THICKNESS / 2.0)
          .setTranslation(0.9, -0.15, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        return this.physics.world.createCollider(rightDesc, body);
      }

      case BuildingPieceType.WOOD_WALL_DOORWAY_1X2: {
        const lintelDesc = this.physics.rapier.ColliderDesc.cuboid(0.5, 0.15, WALL_THICKNESS / 2.0)
          .setTranslation(0, 0.85, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(lintelDesc, body);

        const leftDesc = this.physics.rapier.ColliderDesc.cuboid(0.06, 0.85, WALL_THICKNESS / 2.0)
          .setTranslation(-0.44, -0.15, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        this.physics.world.createCollider(leftDesc, body);

        const rightDesc = this.physics.rapier.ColliderDesc.cuboid(0.06, 0.85, WALL_THICKNESS / 2.0)
          .setTranslation(0.44, -0.15, 0)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        return this.physics.world.createCollider(rightDesc, body);
      }

      case BuildingPieceType.WOOD_DOOR_SINGLE:
      case BuildingPieceType.DOOR_WHITE_2PANEL_1X2:
      case BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2:
      case BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(0.44, 0.94, 0.04)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_DOOR_DOUBLE:
      case BuildingPieceType.DOOR_GRAND_SIDELITES_2X2: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(0.9, 0.94, 0.04)
          .setFriction(0.6).setRestitution(0.0).setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_RAILING_2M: {
        // 2m straight railing: width 2.0 (half-extent 1.0), height 0.95 (half-extent 0.475), thickness 0.12 (half-extent 0.06)
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, 0.475, 0.06)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_RAILING_1M:
      case BuildingPieceType.WHITE_DECORATIVE_FENCE_1M: {
        // 1m straight railing / decorative fence: width 1.0 (half-extent 0.5), height 0.95 (half-extent 0.475), thickness 0.12 (half-extent 0.06)
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(0.5, 0.475, 0.06)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }

      case BuildingPieceType.WOOD_STAIR_RAILING_2X2: {
        // 45-degree sloped barrier along stair slope (rises from -Z/-Y to +Z/+Y)
        const rampLength = Math.sqrt(MODULE_SIZE * MODULE_SIZE + MODULE_SIZE * MODULE_SIZE);
        const rampQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 4);
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(0.06, 0.475, rampLength / 2.0)
          .setTranslation(0, 0.55, 0)
          .setRotation({ x: rampQuat.x, y: rampQuat.y, z: rampQuat.z, w: rampQuat.w })
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(colGroup);
        break;
      }


      default: {
        colliderDesc = this.physics.rapier.ColliderDesc.cuboid(HALF_SIZE, HALF_SIZE, HALF_SIZE)
          .setCollisionGroups(colGroup);
      }
    }

    return this.physics.world.createCollider(colliderDesc, body);
  }

  /**
   * Spawns a starter Norse longhouse foundation and frame at given coordinates.
   */
  public spawnStarterVikingCabin(origin: THREE.Vector3 = new THREE.Vector3(14, 0, 10)): void {
    const rot0 = new THREE.Quaternion();
    const rot90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const rot180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const rot270 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);

    // 2x2 Floor Grid (4 tiles = 4m x 4m)
    for (let x = -1; x <= 1; x += 2) {
      for (let z = -1; z <= 1; z += 2) {
        this.placePiece(
          BuildingPieceType.WOOD_FLOOR_2X2,
          new THREE.Vector3(origin.x + x * 1.0, origin.y + 0.06, origin.z + z * 1.0),
          rot0
        );
      }
    }

    // Front wall with window and doorway with double door
    this.placePiece(
      BuildingPieceType.WOOD_WALL_WINDOW_2X2,
      new THREE.Vector3(origin.x - 1.0, origin.y + 1.0, origin.z + 2.0),
      rot0
    );
    this.placePiece(
      BuildingPieceType.WOOD_WALL_DOORWAY_2X2,
      new THREE.Vector3(origin.x + 1.0, origin.y + 1.0, origin.z + 2.0),
      rot0
    );
    this.placePiece(
      BuildingPieceType.WOOD_DOOR_DOUBLE,
      new THREE.Vector3(origin.x + 1.0, origin.y + 1.0, origin.z + 2.0),
      rot0
    );

    // Back walls
    this.placePiece(
      BuildingPieceType.WOOD_WALL_1X2,
      new THREE.Vector3(origin.x - 1.5, origin.y + 1.0, origin.z - 2.0),
      rot180
    );
    this.placePiece(
      BuildingPieceType.WOOD_WALL_1X2,
      new THREE.Vector3(origin.x - 0.5, origin.y + 1.0, origin.z - 2.0),
      rot180
    );
    this.placePiece(
      BuildingPieceType.WOOD_WALL_1X2,
      new THREE.Vector3(origin.x + 0.5, origin.y + 1.0, origin.z - 2.0),
      rot180
    );
    this.placePiece(
      BuildingPieceType.WOOD_WALL_1X2,
      new THREE.Vector3(origin.x + 1.5, origin.y + 1.0, origin.z - 2.0),
      rot180
    );

    // Left walls
    this.placePiece(
      BuildingPieceType.WOOD_WALL_1X2,
      new THREE.Vector3(origin.x - 2.0, origin.y + 1.0, origin.z - 1.5),
      rot90
    );
    this.placePiece(
      BuildingPieceType.WOOD_WALL_1X2,
      new THREE.Vector3(origin.x - 2.0, origin.y + 1.0, origin.z - 0.5),
      rot90
    );
    this.placePiece(
      BuildingPieceType.WOOD_WALL_1X2,
      new THREE.Vector3(origin.x - 2.0, origin.y + 1.0, origin.z + 0.5),
      rot90
    );
    this.placePiece(
      BuildingPieceType.WOOD_WALL_1X2,
      new THREE.Vector3(origin.x - 2.0, origin.y + 1.0, origin.z + 1.5),
      rot90
    );

    // Right walls
    this.placePiece(
      BuildingPieceType.WOOD_WALL_1X2,
      new THREE.Vector3(origin.x + 2.0, origin.y + 1.0, origin.z - 1.5),
      rot270
    );
    this.placePiece(
      BuildingPieceType.WOOD_WALL_1X2,
      new THREE.Vector3(origin.x + 2.0, origin.y + 1.0, origin.z - 0.5),
      rot270
    );
    this.placePiece(
      BuildingPieceType.WOOD_WALL_1X2,
      new THREE.Vector3(origin.x + 2.0, origin.y + 1.0, origin.z + 0.5),
      rot270
    );
    this.placePiece(
      BuildingPieceType.WOOD_WALL_1X2,
      new THREE.Vector3(origin.x + 2.0, origin.y + 1.0, origin.z + 1.5),
      rot270
    );

    // Stairs approaching doorway
    this.placePiece(
      BuildingPieceType.WOOD_STAIRS_2X2,
      new THREE.Vector3(origin.x - 1.0, origin.y, origin.z + 4.0),
      rot180
    );

    // Procedural 2-Pitched Gable Roof crowning the starter cabin (Heartopia style)
    this.placePiece(
      BuildingPieceType.ROOF_GABLE_4X4,
      new THREE.Vector3(origin.x, origin.y + 2.8, origin.z),
      rot0
    );

    // Bake demo house walls and floors into continuous seamless meshes with checker texture
    this.confirmAll();
  }

  /**
   * Confirmation: bakes all pending walls into the merged wall mesh (mitred corners, holes for
   * windows and doors). Nothing else bakes pending pieces, except painting or cutting into them.
   */
  public confirmWalls(): boolean {
    const success = this.continuousWallSystem.confirm('walls');
    if (success) {
      audioEngine.playBuildSnap();
    }
    return success;
  }

  public confirmFloors(): boolean {
    const success = this.continuousWallSystem.confirm('floors');
    if (success) {
      audioEngine.playBuildSnap();
    }
    return success;
  }

  public confirmFoundations(): boolean {
    const success = this.continuousWallSystem.confirm('foundations');
    if (success) {
      audioEngine.playBuildSnap();
    }
    return success;
  }

  public confirmAll(): boolean {
    const success = this.continuousWallSystem.confirm('all');
    if (success) {
      audioEngine.playBuildSnap();
    }
    return success;
  }

  /** Ground rectangles under roofs (world XZ, without the eave overhang) that rain cannot reach. */
  public getShelterRects(): { x0: number; z0: number; x1: number; z1: number }[] {
    const out: { x0: number; z0: number; x1: number; z1: number }[] = [];
    for (const piece of this.pieces.values()) {
      if (!isProceduralRoofPiece(piece.type) && piece.type !== BuildingPieceType.WOOD_ROOF_26) continue;
      const cfg = piece.roofConfig;
      if (cfg) {
        // The walls' footprint (the overhang drips just outside them)
        const box = new THREE.Box3();
        for (const x of [cfg.minX, cfg.maxX]) {
          for (const z of [cfg.minZ, cfg.maxZ]) {
            box.expandByPoint(new THREE.Vector3(x, 0, z).applyQuaternion(piece.quaternion).add(piece.position));
          }
        }
        out.push({ x0: box.min.x, z0: box.min.z, x1: box.max.x, z1: box.max.z });
        continue;
      }
      const bb = piece.worldBoundingBox;
      if (!bb) continue;
      const inset = 0.25; // drop the overhang/gutter: drips fall just outside the walls
      out.push({ x0: bb.min.x + inset, z0: bb.min.z + inset, x1: bb.max.x - inset, z1: bb.max.z - inset });
    }
    return out;
  }

  /**
   * Axis-aligned "room" around a light at `p` for the night lighting: starts as the light's range cube
   * and is cut by the nearest wall on each side (along the axis lines through `p`), the floor below and
   * the floor or roof above. The box ends on the walls' inner faces, so light stays inside.
   * Returns null when nothing bounds the light (it then lights its whole sphere).
   */
  public getLightVolume(p: THREE.Vector3, range: number): THREE.Box3 | null {
    const box = new THREE.Box3(
      new THREE.Vector3(p.x - range, p.y - range, p.z - range),
      new THREE.Vector3(p.x + range, p.y + range, p.z + range)
    );
    let cut = false;
    const eps = 0.05;
    for (const piece of this.getPiecesNear(p, range + 5)) {
      const bb = piece.worldBoundingBox;
      if (!bb || isGreenhousePiece(piece.type)) continue; // glass lets the light out
      const type = piece.type;
      const sx = bb.max.x - bb.min.x;
      const sz = bb.max.z - bb.min.z;

      if (isSolidWallPiece(type) || isWindowOrDoorPiece(type)) {
        if (p.y < bb.min.y - 0.1 || p.y > bb.max.y + 0.3) continue;
        // Only walls running along X or Z (a diagonal wall's box is not thin)
        if (sx * 3 < sz) {
          if (p.z < bb.min.z - eps || p.z > bb.max.z + eps) continue;
          if (bb.max.x <= p.x && bb.max.x > box.min.x) { box.min.x = bb.max.x; cut = true; }
          else if (bb.min.x >= p.x && bb.min.x < box.max.x) { box.max.x = bb.min.x; cut = true; }
        } else if (sz * 3 < sx) {
          if (p.x < bb.min.x - eps || p.x > bb.max.x + eps) continue;
          if (bb.max.z <= p.z && bb.max.z > box.min.z) { box.min.z = bb.max.z; cut = true; }
          else if (bb.min.z >= p.z && bb.min.z < box.max.z) { box.max.z = bb.min.z; cut = true; }
        }
        continue;
      }

      const isFloor = isFloorPiece(type) || isFoundationPiece(type);
      const isRoof = isProceduralRoofPiece(type) || type === BuildingPieceType.WOOD_ROOF_26;
      if (!isFloor && !isRoof) continue;
      if (p.x < bb.min.x - eps || p.x > bb.max.x + eps || p.z < bb.min.z - eps || p.z > bb.max.z + eps) continue;
      if (isFloor && bb.max.y <= p.y + 0.05) {
        if (bb.max.y > box.min.y) { box.min.y = bb.max.y; cut = true; }
      } else if (bb.min.y >= p.y - 0.05) {
        // A floor above caps at its underside; a roof at its ridge (its inner slopes stay lit)
        const top = isRoof ? bb.max.y : bb.min.y;
        if (top < box.max.y) { box.max.y = top; cut = true; }
      }
    }
    return cut ? box : null;
  }

  public getUnconfirmedWallCount(): number {
    return this.continuousWallSystem.getUnconfirmedWallCount();
  }

  public getUnconfirmedFloorCount(): number {
    return this.continuousWallSystem.getUnconfirmedFloorCount();
  }

  public getUnconfirmedFoundationCount(): number {
    return this.continuousWallSystem.getUnconfirmedFoundationCount();
  }

  public setNextPieceId(nextId: number): void {
    this.nextPieceId = Math.max(this.nextPieceId, nextId);
  }

  public exportScene(): BuildingSceneExportData {
    return exportBuildingScene(this);
  }

  public downloadSceneJson() {
    return downloadBuildingSceneAsJson(this);
  }

  public importScene(data: BuildingSceneExportData) {
    return importBuildingScene(this, data);
  }

  public clear(): void {
    for (const piece of Array.from(this.pieces.values())) {
      this.demolishPiece(piece.id);
    }
    this.wallPaintingSystem.clearAllCustomizations();
    this.continuousWallSystem.dispose();
  }

  public dispose(): void {
    this.clear();
    this.continuousWallSystem.dispose();
    this.greenhouseBatch.dispose();
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
  }
}
