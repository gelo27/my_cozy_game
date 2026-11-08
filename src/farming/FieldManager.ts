import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { TerrainSystem } from '../world/TerrainSystem';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { TerrainTileType } from '../terrain/types/TerrainTypes';
import { waterLevelAt } from '../world/rivers/RiverWorld';
import { CropStage, CropState, CropType } from './types/FarmingTypes';
import { FIELD_CROP_MATERIAL, getWheatStageGeometries, loadWheatModel } from './WheatModel';
import { getCropModel, loadCropModels } from './CropModels';

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
const WHEAT_LAYOUT = { rows: WHEAT_ROWS, spacing: WHEAT_SPACING, scale: 1.2 };

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
  /** Dark damp-soil overlay, built on first watering and freed with the field. */
  wetMesh: THREE.Mesh | null;
  /** 0..1, eases towards 1 while watered so the soil darkens and dries gradually. */
  wetness: number;
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
  /** Tip offset (m) at full push when this part's plants spring away from bodies; 0 = rigid. */
  maxBend: number;
}

/** Field layout of single plants: rows x rows, `spacing` m apart, base scale. */
interface SingleLayout {
  rows: number;
  spacing: number;
  scale: number;
}

/** Instanced crop parts per (crop, stage), one plant per placement (no parts until the model loads). */
interface CropVisual {
  parts: CropPart[];
  single: SingleLayout;
}

interface Batch {
  mesh: THREE.InstancedMesh;
  capacity: number;
  /** Per-plant springs (single-plant springy batches only). */
  springs: SpringSet | null;
}

/**
 * Bend springs for one springy batch (wheat, corn, tomato, eggplant, strawberry). `bend` is uploaded as the per-instance `aBend` attribute: the
 * world-space XZ offset of a stalk's tip. Only plants a pusher touched are simulated, and only the
 * changed index range is re-uploaded; once everything settles nothing runs at all.
 */
interface SpringSet {
  attr: THREE.InstancedBufferAttribute;
  bend: Float32Array;
  vel: Float32Array;
  target: Float32Array;
  /** Plant base XZ in world space. */
  base: Float32Array;
  isActive: Uint8Array;
  active: number[];
  /** Tip offset (m) at full push for this crop. */
  maxBend: number;
}

/** Tip offset (m) at full push, spring stiffness and damping (underdamped: a couple of wobbles). */
const WHEAT_MAX_BEND = 0.42;
const SPRING_K = 70;
const SPRING_DAMP = 5.5;
const MAX_PUSHERS = 16;

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
  /** Set by FarmingManager while it rains: all fields look soaked, crops or not. */
  public rainWet = false;
  private physics: PhysicsWorld | null = null;

  private readonly ghost: THREE.Mesh;
  private readonly ghostMaterial: THREE.MeshBasicMaterial;
  private ghostKey = '';
  private ghostTime = 0;

  /** Wheat instances of each field inside its batch, for the proximity push. */
  // Plain arrays (not Map/Set iteration) so the per-frame spring pass allocates nothing
  private wheatSlots: { field: FarmField; springs: SpringSet; start: number; count: number }[] = [];
  private springSets: SpringSet[] = [];
  /** x, y, z, radius per pusher, refilled every frame. */
  private readonly pushers = new Float32Array(MAX_PUSHERS * 4);
  private pusherCount = 0;

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

    // Fields planted before a model arrived switch from the procedural fallback
    const refresh = () => {
      this.visuals.clear();
      this.dirty = true;
    };
    void loadWheatModel().then(refresh);
    void loadCropModels().then(refresh);
  }

  /**
   * Hidden meshes carrying the field shaders. Every crop material shares the instanced crop
   * program, so this covers crops whose models load later too. The engine's load-time shader prewarm compiles hidden
   * objects, so the first field on screen doesn't stall on a shader compile. They never render.
   */
  private addShaderWarmers(): void {
    // Same attribute layout as the wheat stage geometries (position, normal, RGB colour)
    const wheatProbe = new THREE.BufferGeometry();
    wheatProbe.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    wheatProbe.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    wheatProbe.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9), 3));
    wheatProbe.setAttribute('aBend', new THREE.InstancedBufferAttribute(new Float32Array(2), 2));
    const warm = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
      const mesh = new THREE.InstancedMesh(geometry, material, 1);
      mesh.name = 'FieldShaderWarmer';
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    };
    warm(wheatProbe, FIELD_CROP_MATERIAL);

    // Damp-soil overlay: same material setup as createWetMesh (per-field copies share the program)
    const dampProbe = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshLambertMaterial({ color: 0x1e1009, alphaMap: FieldManager.wetAlphaTexture(), transparent: true, depthWrite: false })
    );
    dampProbe.name = 'FieldShaderWarmer';
    dampProbe.visible = false;
    dampProbe.frustumCulled = false;
    this.group.add(dampProbe);
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
      wetMesh: null,
      wetness: crop?.isWatered ? 1 : 0,
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
    this.disposeWetMesh(field);
    this.fields.delete(id);
    this.dirty = true;
    return true;
  }

  public clear(): void {
    for (const f of this.fields.values()) {
      this.group.remove(f.indicator);
      this.disposeWetMesh(f);
    }
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
    this.updateSprings(dt);
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
      this.updateWetness(f, dt);
    }
  }

  // ---------------------------------------------------------------- damp soil

  /** Soaks in quickly after watering, dries out slowly once the stage has used the water up. */
  private updateWetness(f: FarmField, dt: number): void {
    const target = f.crop?.isWatered || this.rainWet ? 1 : 0;
    if (f.wetness === target && (target === 0 || f.wetMesh)) return;
    f.wetness = target > f.wetness ? Math.min(1, f.wetness + dt * 1.6) : Math.max(0, f.wetness - dt * 0.25);
    if (f.wetness > 0 && !f.wetMesh) f.wetMesh = this.createWetMesh(f);
    if (f.wetMesh) {
      f.wetMesh.visible = f.wetness > 0.01;
      (f.wetMesh.material as THREE.MeshLambertMaterial).opacity = 0.55 * f.wetness;
    }
  }

  /** A terrain-hugging dark patch with soft edges over the field's soil (one per field, 81 verts). */
  private createWetMesh(f: FarmField): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(FIELD_CELLS + 0.6, FIELD_CELLS + 0.6, 8, 8);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const cx = f.gx + HALF;
    const cz = f.gz + HALF;
    for (let i = 0; i < pos.count; i++) {
      const h = this.terrain ? this.terrain.getHeight(cx + pos.getX(i), cz + pos.getZ(i)) : f.center.y;
      pos.setY(i, h + 0.035);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({
      color: 0x1e1009,
      alphaMap: FieldManager.wetAlphaTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `FieldDamp_${f.id}`;
    mesh.position.set(cx, 0, cz);
    mesh.renderOrder = 1;
    mesh.visible = false;
    this.group.add(mesh);
    return mesh;
  }

  private disposeWetMesh(f: FarmField): void {
    if (!f.wetMesh) return;
    this.group.remove(f.wetMesh);
    f.wetMesh.geometry.dispose();
    (f.wetMesh.material as THREE.Material).dispose(); // the shared alpha texture stays
    f.wetMesh = null;
  }

  private static wetAlpha: THREE.CanvasTexture | null = null;

  /** Shared soft-edged square mask (with a little mottling so the damp patch isn't flat). */
  private static wetAlphaTexture(): THREE.CanvasTexture {
    if (this.wetAlpha) return this.wetAlpha;
    const S = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(S, S);
    const rand = rng(1234);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        // Distance to the square's edge, 0 at the border, fading over ~18% of the side
        const u = Math.min(x, S - 1 - x) / S;
        const v = Math.min(y, S - 1 - y) / S;
        const edge = Math.min(1, Math.min(u, v) / 0.18);
        const a = edge * edge * (3 - 2 * edge) * (0.82 + rand() * 0.18);
        const o = (y * S + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(a * 255);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.wetAlpha = new THREE.CanvasTexture(canvas);
    return this.wetAlpha;
  }

  // ---------------------------------------------------------------- proximity push

  /** Call once per frame before update(), then addPusher() for each body that parts the wheat. */
  public clearPushers(): void {
    this.pusherCount = 0;
  }

  /** A body at (x, y, z) pushing stalks within `radius` metres (y is its feet or centre). */
  public addPusher(x: number, y: number, z: number, radius: number): void {
    if (this.pusherCount >= MAX_PUSHERS) return;
    const o = this.pusherCount++ * 4;
    this.pushers[o] = x;
    this.pushers[o + 1] = y;
    this.pushers[o + 2] = z;
    this.pushers[o + 3] = radius;
  }

  private updateSprings(dt: number): void {
    if (this.wheatSlots.length === 0) return;

    // Targets of the moving plants relax to upright unless a pusher holds them this frame
    for (let k = 0; k < this.springSets.length; k++) {
      const s = this.springSets[k];
      for (let a = 0; a < s.active.length; a++) s.target[s.active[a] * 2] = s.target[s.active[a] * 2 + 1] = 0;
    }

    for (let p = 0; p < this.pusherCount; p++) {
      const px = this.pushers[p * 4];
      const py = this.pushers[p * 4 + 1];
      const pz = this.pushers[p * 4 + 2];
      const r = this.pushers[p * 4 + 3];
      for (let w = 0; w < this.wheatSlots.length; w++) {
        const slot = this.wheatSlots[w];
        const field = slot.field;
        const dy = py - field.center.y;
        if (dy < -1.5 || dy > 2.5) continue; // jumping high over it, or on a bridge below
        if (this.distanceTo(field, px, pz) > r) continue;
        const s = slot.springs;
        for (let i = slot.start; i < slot.start + slot.count; i++) {
          const dx = s.base[i * 2] - px;
          const dz = s.base[i * 2 + 1] - pz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          const d = Math.sqrt(d2);
          const f = 1 - d / r;
          const push = s.maxBend * f * (2 - f); // eased: firm near the body, soft at the edge
          if (d > 1e-3) {
            s.target[i * 2] += (dx / d) * push;
            s.target[i * 2 + 1] += (dz / d) * push;
          } else {
            s.target[i * 2] += push;
          }
          if (!s.isActive[i]) {
            s.isActive[i] = 1;
            s.active.push(i);
          }
        }
      }
    }

    const h = Math.min(dt, 1 / 30);
    for (let k = 0; k < this.springSets.length; k++) {
      const s = this.springSets[k];
      if (s.active.length === 0) continue;
      let lo = Infinity;
      let hi = -1;
      for (let a = s.active.length - 1; a >= 0; a--) {
        const i = s.active[a];
        const ix = i * 2;
        let tx = s.target[ix];
        let tz = s.target[ix + 1];
        const tl = Math.hypot(tx, tz);
        if (tl > s.maxBend) {
          tx *= s.maxBend / tl;
          tz *= s.maxBend / tl;
        }
        // Semi-implicit Euler: stable at these stiffnesses with the 1/30 s step cap
        s.vel[ix] += (SPRING_K * (tx - s.bend[ix]) - SPRING_DAMP * s.vel[ix]) * h;
        s.vel[ix + 1] += (SPRING_K * (tz - s.bend[ix + 1]) - SPRING_DAMP * s.vel[ix + 1]) * h;
        s.bend[ix] += s.vel[ix] * h;
        s.bend[ix + 1] += s.vel[ix + 1] * h;
        lo = Math.min(lo, i);
        hi = Math.max(hi, i);
        const settled =
          tl === 0 &&
          Math.abs(s.bend[ix]) + Math.abs(s.bend[ix + 1]) < 0.002 &&
          Math.abs(s.vel[ix]) + Math.abs(s.vel[ix + 1]) < 0.01;
        if (settled) {
          s.bend[ix] = s.bend[ix + 1] = s.vel[ix] = s.vel[ix + 1] = 0;
          s.isActive[i] = 0;
          s.active[a] = s.active[s.active.length - 1];
          s.active.pop();
        }
      }
      if (hi >= 0) {
        s.attr.clearUpdateRanges();
        s.attr.addUpdateRange(lo * 2, (hi - lo + 1) * 2);
        s.attr.needsUpdate = true;
      }
    }
  }

  /**
   * Springs for a (new or regrown) wheat batch. The stage geometry is shared only by this batch, so
   * disposing it frees its GPU buffers, including the previous smaller aBend: no orphaned buffers.
   * The old set is dropped from the list, leaving its typed arrays to the GC.
   */
  private createSprings(geometry: THREE.BufferGeometry, capacity: number, previous: SpringSet | null, maxBend: number): SpringSet {
    if (previous) this.springSets = this.springSets.filter((s) => s !== previous);
    const bend = new Float32Array(capacity * 2);
    const attr = new THREE.InstancedBufferAttribute(bend, 2);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.dispose();
    geometry.setAttribute('aBend', attr);
    const s: SpringSet = {
      attr,
      bend,
      vel: new Float32Array(capacity * 2),
      target: new Float32Array(capacity * 2),
      base: new Float32Array(capacity * 2),
      isActive: new Uint8Array(capacity),
      active: [],
      maxBend,
    };
    this.springSets.push(s);
    return s;
  }

  /** Plants moved (planted / harvested / re-laid out): everything stands upright again. */
  private resetSprings(s: SpringSet): void {
    s.bend.fill(0);
    s.vel.fill(0);
    s.target.fill(0);
    s.isActive.fill(0);
    s.active.length = 0;
    s.attr.clearUpdateRanges();
    s.attr.needsUpdate = true;
  }

  // ---------------------------------------------------------------- instancing

  private getVisual(type: CropType, stage: CropStage): CropVisual {
    const key = `${type}:${stage}`;
    let visual = this.visuals.get(key);
    if (visual) return visual;

    const wheat = type === 'wheat' ? getWheatStageGeometries() : null;
    const model = getCropModel(type);
    if (wheat) {
      visual = {
        single: WHEAT_LAYOUT,
        parts: [{ geometry: wheat[stage], material: FIELD_CROP_MATERIAL, matrix: new THREE.Matrix4(), maxBend: WHEAT_MAX_BEND }],
      };
    } else if (model) {
      // Plant pack: one instance per plant. A springy crop's batch owns its aBend attribute, so it
      // gets its own copy of the stage geometry; rigid crops share the model's
      const geometry = model.push ? model.stages[stage].clone() : model.stages[stage];
      visual = {
        single: model.field,
        parts: [{ geometry, material: model.material, matrix: new THREE.Matrix4(), maxBend: model.push?.maxBend ?? 0 }],
      };
    } else {
      // Model still loading: nothing to draw yet (the load clears this cache)
      visual = { single: WHEAT_LAYOUT, parts: [] };
    }
    this.visuals.set(key, visual);
    return visual;
  }

  private rebuildInstances(): void {
    const terrain = this.terrain;
    type Entry = { part: CropPart; matrices: THREE.Matrix4[]; owners: { field: FarmField; start: number; count: number }[] };
    const lists = new Map<string, Entry>();

    for (const field of this.fields.values()) {
      if (!field.crop || !terrain) continue;
      const { cropType, stage } = field.crop;
      const visual = this.getVisual(cropType, stage);
      const placements = this.placementsFor(field, visual.single, terrain);
      visual.parts.forEach((part, pi) => {
        const key = `${cropType}:${stage}:${pi}`;
        let entry = lists.get(key);
        if (!entry) lists.set(key, (entry = { part, matrices: [], owners: [] }));
        entry.owners.push({ field, start: entry.matrices.length, count: placements.length });
        for (const m of placements) entry.matrices.push(m.clone().multiply(part.matrix));
      });
    }

    this.wheatSlots = [];

    for (const [key, batch] of this.batches) {
      if (!lists.has(key)) {
        batch.mesh.count = 0;
        batch.mesh.visible = false;
      }
    }

    for (const [key, { part, matrices, owners }] of lists) {
      const springy = part.maxBend > 0;
      let batch = this.batches.get(key);
      if (!batch || batch.capacity < matrices.length) {
        const previousSprings = batch?.springs ?? null;
        if (batch) {
          this.group.remove(batch.mesh);
          batch.mesh.dispose(); // instance buffers only; geometry and material are shared
        }
        const capacity = Math.max(32, THREE.MathUtils.ceilPowerOfTwo(matrices.length));
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
        mesh.name = `FieldCrops_${key}`;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        const springs = springy ? this.createSprings(part.geometry, capacity, previousSprings, part.maxBend) : null;
        batch = { mesh, capacity, springs };
        this.batches.set(key, batch);
      }
      const mesh = batch.mesh;
      for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
      const springs = batch.springs;
      if (springs) {
        this.resetSprings(springs);
        for (let i = 0; i < matrices.length; i++) {
          springs.base[i * 2] = matrices[i].elements[12];
          springs.base[i * 2 + 1] = matrices[i].elements[14];
        }
        for (const o of owners) this.wheatSlots.push({ field: o.field, springs, start: o.start, count: o.count });
      }
      mesh.count = matrices.length;
      mesh.visible = matrices.length > 0;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** Plant transforms on the terrain: a jittered rows x rows grid. */
  private placementsFor(field: FarmField, layout: SingleLayout, terrain: TerrainSystem): THREE.Matrix4[] {
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
    const { rows, spacing, scale } = layout;
    const start = -((rows - 1) * spacing) / 2;
    const jitter = spacing * 0.32;
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < rows; q++) {
        const x = cx + start + q * spacing + (rand() - 0.5) * jitter;
        const z = cz + start + r * spacing + (rand() - 0.5) * jitter;
        put(x, z, rand() * Math.PI * 2, scale * (0.88 + rand() * 0.25), 0.03);
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
