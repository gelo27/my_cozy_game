import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { TerrainSystem } from '../world/TerrainSystem';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { TerrainTileType } from '../terrain/types/TerrainTypes';
import { waterLevelAt } from '../world/rivers/RiverWorld';
import { CropStage, CropState, CropType } from './types/FarmingTypes';
import { FarmingMeshGenerator } from './FarmingMeshGenerator';
import { FIELD_CROP_MATERIAL, getWheatStageGeometries, loadWheatModel } from './WheatModel';

/** Field side in terrain cells (1 m each). */
export const FIELD_CELLS = 4;
/** Seeds a whole field takes, and crates it yields. */
export const FIELD_SEED_COST = 5;
export const FIELD_CRATE_YIELD = 6;
/** Wheat clumps per side (5 x 5 = 25 per field) and their spacing in metres. */
const WHEAT_ROWS = 5;
const WHEAT_SPACING = 0.68;
/** Max height difference (m) across the field's 5 x 5 corner grid: 2 m over 4 m is ~27°. */
const MAX_SLOPE = 2.0;
const HALF = FIELD_CELLS / 2;

export interface FarmField {
  id: string;
  /** Lowest terrain cell (world metres) on each axis. */
  gx: number;
  gz: number;
  center: THREE.Vector3;
  /** Terrain tiles under the field before it was dug, restored when it is filled back in. */
  prevTiles: number[];
  crop: CropState | null;
  indicator: THREE.Sprite;
}

export type DigBlockReason = 'tile' | 'water' | 'slope' | 'blocked' | 'overlap';

/** What the shovel would do at the spot in front of the player. */
export type ShovelTarget =
  | { kind: 'dig'; gx: number; gz: number; reason: DigBlockReason | null }
  | { kind: 'fill'; field: FarmField }
  | { kind: 'busy'; field: FarmField };

export interface FieldSaveData {
  gx: number;
  gz: number;
  prev: number[];
  crop: CropState | null;
}

interface CropPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrix: THREE.Matrix4;
}

/** Instanced crop parts per (crop, stage); `single` = one plant per placement, else a 2x2 m bed template. */
interface CropVisual {
  parts: CropPart[];
  single: boolean;
}

interface Batch {
  mesh: THREE.InstancedMesh;
  capacity: number;
}

/** Deterministic per-field random so plants keep their layout across reloads. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Big dug-up fields (4 x 4 m of terrain turned to soil) made with the shovel.
 *
 * Performance: every plant of every field is drawn through shared InstancedMeshes, one per
 * crop / stage / material part, so a farm of any size costs a handful of draw calls. Instance
 * buffers are rebuilt only when a field is dug, planted, grows a stage or is harvested; the wind sway
 * runs in the vertex shader. The soil itself is the terrain's own dirt splat layer: no extra mesh.
 */
export class FieldManager {
  private readonly fields = new Map<string, FarmField>();
  private readonly group = new THREE.Group();
  private readonly batches = new Map<string, Batch>();
  private readonly visuals = new Map<string, CropVisual>();
  private dirty = false;
  private nextId = 1;
  private terrain: TerrainSystem | null = null;
  private physics: PhysicsWorld | null = null;
  /** Extra placement check for things without static colliders (garden beds). */
  public isAreaReserved: ((minX: number, minZ: number, maxX: number, maxZ: number) => boolean) | null = null;

  private readonly ghost: THREE.Mesh;
  private readonly ghostMaterial: THREE.MeshBasicMaterial;
  private ghostKey = '';
  private ghostTime = 0;

  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly indicatorMaterial: () => THREE.SpriteMaterial
  ) {
    this.group.name = 'FarmFields';
    scene.add(this.group);

    this.ghostMaterial = new THREE.MeshBasicMaterial({
      map: FieldManager.createGhostTexture(),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const ghostGeo = new THREE.PlaneGeometry(FIELD_CELLS, FIELD_CELLS, FIELD_CELLS * 2, FIELD_CELLS * 2);
    ghostGeo.rotateX(-Math.PI / 2);
    this.ghost = new THREE.Mesh(ghostGeo, this.ghostMaterial);
    this.ghost.name = 'FieldDigGhost';
    this.ghost.visible = false;
    this.ghost.renderOrder = 5;
    this.ghost.frustumCulled = false;
    scene.add(this.ghost);

    this.addShaderWarmers();

    void loadWheatModel().then(() => {
      // Fields planted before the model arrived switch from the procedural fallback
      this.visuals.clear();
      this.dirty = true;
    });
  }

  /**
   * Hidden one-instance meshes carrying every material the fields draw with instancing (the swaying
   * wheat, and the instanced variants of the bed crops' materials, which differ from the plain
   * ones the garden beds use). The engine's load-time shader prewarm compiles hidden objects too,
   * so the first field on screen doesn't stall on a shader compile. They never render.
   */
  private addShaderWarmers(): void {
    // Same attribute layout as the wheat stage geometries (position, normal, RGB colour)
    const wheatProbe = new THREE.BufferGeometry();
    wheatProbe.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    wheatProbe.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    wheatProbe.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9), 3));
    const warm = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
      const mesh = new THREE.InstancedMesh(geometry, material, 1);
      mesh.name = 'FieldShaderWarmer';
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    };
    warm(wheatProbe, FIELD_CROP_MATERIAL);

    const seen = new Set<THREE.Material>();
    for (const type of ['carrot', 'tomato'] as CropType[]) {
      for (const stage of [1, 2, 3] as CropStage[]) {
        for (const part of this.getVisual(type, stage).parts) {
          if (seen.has(part.material)) continue;
          seen.add(part.material);
          warm(part.geometry, part.material);
        }
      }
    }
  }

  public setWorld(terrain: TerrainSystem, physics: PhysicsWorld): void {
    this.terrain = terrain;
    this.physics = physics;
  }

  // ---------------------------------------------------------------- queries

  public getAll(): FarmField[] {
    return Array.from(this.fields.values());
  }

  public get(id: string): FarmField | null {
    return this.fields.get(id) ?? null;
  }

  /** Distance from a point to the field's rectangle on the ground (0 inside). */
  public distanceTo(field: FarmField, x: number, z: number): number {
    const dx = Math.max(field.gx - x, 0, x - (field.gx + FIELD_CELLS));
    const dz = Math.max(field.gz - z, 0, z - (field.gz + FIELD_CELLS));
    return Math.hypot(dx, dz);
  }

  public nearest(x: number, z: number, maxDist: number): { field: FarmField; dist: number } | null {
    let best: FarmField | null = null;
    let bestDist = maxDist;
    for (const f of this.fields.values()) {
      const d = this.distanceTo(f, x, z);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
    return best ? { field: best, dist: bestDist } : null;
  }

  private fieldContaining(x: number, z: number): FarmField | null {
    for (const f of this.fields.values()) {
      if (x >= f.gx && x < f.gx + FIELD_CELLS && z >= f.gz && z < f.gz + FIELD_CELLS) return f;
    }
    return null;
  }

  private overlapping(gx: number, gz: number): FarmField | null {
    for (const f of this.fields.values()) {
      if (Math.abs(gx - f.gx) < FIELD_CELLS && Math.abs(gz - f.gz) < FIELD_CELLS) return f;
    }
    return null;
  }

  /**
   * Resolves the shovel's target for a desired field centre. A centre inside an existing field
   * targets that field (fill it back in); a footprint merely touching one is pushed out to sit flush
   * against it, so neighbouring fields tile edge to edge without fiddly positioning.
   */
  public resolveShovelTarget(cx: number, cz: number): ShovelTarget {
    const inside = this.fieldContaining(cx, cz);
    if (inside) return inside.crop ? { kind: 'busy', field: inside } : { kind: 'fill', field: inside };

    let gx = Math.round(cx - HALF);
    let gz = Math.round(cz - HALF);
    const hit = this.overlapping(gx, gz);
    if (hit) {
      const fcx = hit.gx + HALF;
      const fcz = hit.gz + HALF;
      const penX = FIELD_CELLS - Math.abs(gx - hit.gx);
      const penZ = FIELD_CELLS - Math.abs(gz - hit.gz);
      if (penX <= penZ) gx = hit.gx + (cx >= fcx ? FIELD_CELLS : -FIELD_CELLS);
      else gz = hit.gz + (cz >= fcz ? FIELD_CELLS : -FIELD_CELLS);
    }
    return { kind: 'dig', gx, gz, reason: this.validate(gx, gz) };
  }

  private validate(gx: number, gz: number): DigBlockReason | null {
    const terrain = this.terrain;
    if (!terrain) return 'blocked';
    if (this.overlapping(gx, gz)) return 'overlap';

    for (let z = gz; z < gz + FIELD_CELLS; z++) {
      for (let x = gx; x < gx + FIELD_CELLS; x++) {
        if (!terrain.isInside(x + 0.5, z + 0.5) || terrain.getTile(x, z) !== TerrainTileType.GRASS) return 'tile';
      }
    }

    let minH = Infinity;
    let maxH = -Infinity;
    for (let z = gz; z <= gz + FIELD_CELLS; z++) {
      for (let x = gx; x <= gx + FIELD_CELLS; x++) {
        const h = terrain.getHeight(x, z);
        if (h < waterLevelAt(x, z) + 0.15) return 'water';
        minH = Math.min(minH, h);
        maxH = Math.max(maxH, h);
      }
    }
    if (maxH - minH > MAX_SLOPE) return 'slope';

    if (this.isAreaReserved?.(gx - 0.3, gz - 0.3, gx + FIELD_CELLS + 0.3, gz + FIELD_CELLS + 0.3)) return 'blocked';
    if (this.hasStaticObstacle(gx, gz, minH, maxH)) return 'blocked';
    return null;
  }

  /**
   * Trees, rocks, buildings, fences: any fixed collider (except the terrain) over the footprint.
   * The box spans from just above the lowest ground to 2 m over the highest, so a rock on the low
   * side of a slope still counts.
   */
  private hasStaticObstacle(gx: number, gz: number, groundLow: number, groundTop: number): boolean {
    const physics = this.physics;
    if (!physics?.world) return false;
    const y0 = groundLow + 0.3;
    const y1 = groundTop + 2.3;
    const shape = new RAPIER.Cuboid(HALF - 0.1, (y1 - y0) / 2, HALF - 0.1);
    const pos = { x: gx + HALF, y: (y0 + y1) / 2, z: gz + HALF };
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const hit = physics.world.intersectionWithShape(
      pos,
      rot,
      shape,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      (c) => c.shape.type !== RAPIER.ShapeType.HeightField
    );
    return hit !== null;
  }

  // ---------------------------------------------------------------- editing

  public createField(gx: number, gz: number, crop: CropState | null = null, prevTiles?: number[]): FarmField | null {
    const terrain = this.terrain;
    if (!terrain) return null;
    const prev: number[] = [];
    for (let z = gz; z < gz + FIELD_CELLS; z++) {
      for (let x = gx; x < gx + FIELD_CELLS; x++) {
        prev.push(terrain.getTile(x, z));
        terrain.setTile(x, z, TerrainTileType.DIRT_ROAD);
      }
    }
    const center = new THREE.Vector3(gx + HALF, terrain.getHeight(gx + HALF, gz + HALF), gz + HALF);
    const indicator = new THREE.Sprite(this.indicatorMaterial());
    indicator.scale.set(0.8, 0.8, 1);
    indicator.position.copy(center).setY(center.y + 1.5);
    indicator.visible = false;
    this.group.add(indicator);

    const field: FarmField = {
      id: `field_${this.nextId++}`,
      gx,
      gz,
      center,
      prevTiles: prevTiles && prevTiles.length === prev.length ? prevTiles : prev,
      crop,
      indicator,
    };
    this.fields.set(field.id, field);
    this.dirty = true;
    return field;
  }

  /** Fills a field back in: the original ground returns. */
  public removeField(id: string): boolean {
    const field = this.fields.get(id);
    if (!field) return false;
    const terrain = this.terrain;
    if (terrain) {
      let i = 0;
      for (let z = field.gz; z < field.gz + FIELD_CELLS; z++) {
        for (let x = field.gx; x < field.gx + FIELD_CELLS; x++) terrain.setTile(x, z, field.prevTiles[i++] ?? TerrainTileType.GRASS);
      }
    }
    this.group.remove(field.indicator);
    this.fields.delete(id);
    this.dirty = true;
    return true;
  }

  public clear(): void {
    for (const f of this.fields.values()) this.group.remove(f.indicator);
    this.fields.clear();
    this.dirty = true;
  }

  /** Call after a field's crop type or stage changed. */
  public markCropsDirty(): void {
    this.dirty = true;
  }

  // ---------------------------------------------------------------- ghost

  /** Shows the dig preview: 'ok' green, 'bad' red, 'fill' amber; null hides it. */
  public showGhost(gx: number, gz: number, state: 'ok' | 'bad' | 'fill' | null): void {
    if (!state || !this.terrain) {
      this.ghost.visible = false;
      return;
    }
    this.ghost.visible = true;
    const key = `${gx},${gz},${this.terrain.revision}`;
    if (key !== this.ghostKey) {
      this.ghostKey = key;
      this.ghost.position.set(gx + HALF, 0, gz + HALF);
      const pos = this.ghost.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        pos.setY(i, this.terrain.getHeight(gx + HALF + pos.getX(i), gz + HALF + pos.getZ(i)) + 0.06);
      }
      pos.needsUpdate = true;
    }
    this.ghostMaterial.color.setHex(state === 'ok' ? 0x86efac : state === 'fill' ? 0xfbbf24 : 0xf87171);
  }

  private static createGhostTexture(): THREE.CanvasTexture {
    const S = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(0, 0, S, S);
    // Border with bold corner brackets
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, S - 4, S - 4);
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = 6;
    const c = 26;
    for (const [x, y, dx, dy] of [
      [3, 3, 1, 1],
      [S - 3, 3, -1, 1],
      [3, S - 3, 1, -1],
      [S - 3, S - 3, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x + dx * c, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dy * c);
      ctx.stroke();
    }
    // Planting spots, matching the 5 x 5 wheat layout
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    const span = (WHEAT_SPACING * (WHEAT_ROWS - 1)) / FIELD_CELLS;
    for (let r = 0; r < WHEAT_ROWS; r++) {
      for (let q = 0; q < WHEAT_ROWS; q++) {
        const u = 0.5 + (q / (WHEAT_ROWS - 1) - 0.5) * span;
        const v = 0.5 + (r / (WHEAT_ROWS - 1) - 0.5) * span;
        ctx.beginPath();
        ctx.arc(u * S, v * S, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  // ---------------------------------------------------------------- per frame

  /** Bobs the water-drop indicators, pulses the ghost and rebuilds instances when something changed. */
  public update(dt: number, animTime: number): void {
    if (this.dirty) {
      this.dirty = false;
      this.rebuildInstances();
    }
    if (this.ghost.visible) {
      this.ghostTime += dt;
      this.ghostMaterial.opacity = 0.75 + Math.sin(this.ghostTime * 5) * 0.2;
    }
    let i = 0;
    for (const f of this.fields.values()) {
      i++;
      const needsWater = !!f.crop && f.crop.stage < 3 && !f.crop.isWatered;
      f.indicator.visible = needsWater;
      if (needsWater) {
        f.indicator.position.y = f.center.y + 1.5 + Math.sin(animTime * 3.5 + i * 0.8) * 0.08;
        const s = 0.8 + Math.sin(animTime * 4.5 + i * 0.5) * 0.05;
        f.indicator.scale.set(s, s, 1);
      }
    }
  }

  // ---------------------------------------------------------------- instancing

  private getVisual(type: CropType, stage: CropStage): CropVisual {
    const key = `${type}:${stage}`;
    let visual = this.visuals.get(key);
    if (visual) return visual;

    const wheat = type === 'wheat' ? getWheatStageGeometries() : null;
    if (wheat) {
      visual = { single: true, parts: [{ geometry: wheat[stage], material: FIELD_CROP_MATERIAL, matrix: new THREE.Matrix4() }] };
    } else {
      // Procedural 2 x 2 m bed crops (4 plants each) from the garden-bed generator, lowered onto bare soil
      const template = FarmingMeshGenerator.createCropMesh(type, stage);
      template.updateMatrixWorld(true);
      const lower = new THREE.Matrix4().makeTranslation(0, -0.16, 0);
      const parts: CropPart[] = [];
      template.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        parts.push({
          geometry: mesh.geometry,
          material: mesh.material as THREE.Material,
          matrix: lower.clone().multiply(mesh.matrixWorld),
        });
      });
      visual = { single: false, parts };
    }
    this.visuals.set(key, visual);
    return visual;
  }

  private rebuildInstances(): void {
    const terrain = this.terrain;
    const lists = new Map<string, { part: CropPart; matrices: THREE.Matrix4[] }>();

    for (const field of this.fields.values()) {
      if (!field.crop || !terrain) continue;
      const { cropType, stage } = field.crop;
      const visual = this.getVisual(cropType, stage);
      const placements = this.placementsFor(field, visual.single, terrain);
      visual.parts.forEach((part, pi) => {
        const key = `${cropType}:${stage}:${visual.single ? 's' : 't'}:${pi}`;
        let entry = lists.get(key);
        if (!entry) lists.set(key, (entry = { part, matrices: [] }));
        for (const m of placements) entry.matrices.push(m.clone().multiply(part.matrix));
      });
    }

    for (const [key, batch] of this.batches) {
      if (!lists.has(key)) {
        batch.mesh.count = 0;
        batch.mesh.visible = false;
      }
    }

    for (const [key, { part, matrices }] of lists) {
      let batch = this.batches.get(key);
      if (!batch || batch.capacity < matrices.length) {
        if (batch) {
          this.group.remove(batch.mesh);
          batch.mesh.dispose(); // instance buffers only; geometry and material are shared
        }
        const capacity = Math.max(32, THREE.MathUtils.ceilPowerOfTwo(matrices.length));
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
        mesh.name = `FieldCrops_${key}`;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        batch = { mesh, capacity };
        this.batches.set(key, batch);
      }
      const mesh = batch.mesh;
      for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
      mesh.count = matrices.length;
      mesh.visible = matrices.length > 0;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** Plant transforms on the terrain: a jittered 5 x 5 grid of clumps, or a 2 x 2 grid of bed templates. */
  private placementsFor(field: FarmField, single: boolean, terrain: TerrainSystem): THREE.Matrix4[] {
    const rand = rng(field.gx * 73856093 ^ field.gz * 19349663);
    const out: THREE.Matrix4[] = [];
    const cx = field.gx + HALF;
    const cz = field.gz + HALF;
    const put = (x: number, z: number, yaw: number, scale: number, sink: number) => {
      this.tmpPos.set(x, terrain.getHeight(x, z) - sink, z);
      this.tmpQuat.setFromAxisAngle(this.up, yaw);
      this.tmpScale.setScalar(scale);
      out.push(new THREE.Matrix4().compose(this.tmpPos, this.tmpQuat, this.tmpScale));
    };
    if (single) {
      const start = -((WHEAT_ROWS - 1) * WHEAT_SPACING) / 2;
      for (let r = 0; r < WHEAT_ROWS; r++) {
        for (let q = 0; q < WHEAT_ROWS; q++) {
          const x = cx + start + q * WHEAT_SPACING + (rand() - 0.5) * 0.22;
          const z = cz + start + r * WHEAT_SPACING + (rand() - 0.5) * 0.22;
          put(x, z, rand() * Math.PI * 2, 1.05 + rand() * 0.3, 0.03);
        }
      }
    } else {
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        put(cx + ox, cz + oz, Math.floor(rand() * 4) * (Math.PI / 2), 1, 0);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- save

  public serialize(): FieldSaveData[] {
    return this.getAll().map((f) => ({ gx: f.gx, gz: f.gz, prev: f.prevTiles, crop: f.crop ? { ...f.crop } : null }));
  }

  /** Terrain tiles are already in the terrain save; this restores the fields and their crops. */
  public deserialize(data: FieldSaveData[]): void {
    this.clear();
    for (const d of data) this.createField(d.gx, d.gz, d.crop ? { ...d.crop } : null, d.prev);
  }
}
