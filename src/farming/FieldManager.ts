import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { TerrainSystem } from '../world/TerrainSystem';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { TerrainTileType } from '../terrain/types/TerrainTypes';
import { waterLevelAt } from '../world/rivers/RiverWorld';
import { CropStage, CropState, CropType } from './types/FarmingTypes';
import { FIELD_CROP_MATERIAL, getWheatStageGeometries, loadWheatModel } from './WheatModel';
import { getCropModel, loadCropModels } from './CropModels';
import { FadeRange, acquireDistanceDither } from '../world/LodDither';
import { isMobileDevice } from '../world/WorldSettings';

/** Field side in terrain cells (1 m each). */
export const FIELD_CELLS = 3;
/** Field side used by older saves; such fields are shrunk to FIELD_CELLS on load. */
const LEGACY_FIELD_CELLS = 4;
/** Seeds a whole field takes, and crates it yields. */
export const FIELD_SEED_COST = 3;
export const FIELD_CRATE_YIELD = 4;
/** Wheat clumps per side (4 x 4 = 16 per field) and their spacing in metres. */
const WHEAT_ROWS = 4;
const WHEAT_SPACING = 0.68;
/** Max height difference (m) across the field's 4 x 4 corner grid: 1.5 m over 3 m is ~27°. */
const MAX_SLOPE = 1.5;
const HALF = FIELD_CELLS / 2;
const WHEAT_LAYOUT = { rows: WHEAT_ROWS, spacing: WHEAT_SPACING, scale: 1.2, interleave: true };
/**
 * Crops are batched per CROP_CELL x CROP_CELL m cell, so fields out of view or out of range cost
 * nothing. Plants dissolve (dithered) between the fade start and end (m from the camera); phones
 * stop drawing them sooner.
 */
const CROP_CELL = 32;
/** Darkest the damp soil overlay gets. */
const WET_OPACITY = 0.55;
const CROP_FADE: FadeRange = { value: isMobileDevice() ? new THREE.Vector2(42, 55) : new THREE.Vector2(68, 85) };

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
  /** 0..1, eases towards 1 while watered so the soil darkens and dries gradually. */
  wetness: number;
  /** Damp-soil value last written to the terrain (0..255, -1 = not yet). */
  wetShown: number;
}

export type DigBlockReason = 'tile' | 'water' | 'slope' | 'blocked' | 'overlap';

/** What the shovel would do at the spot in front of the player. */
export type ShovelTarget =
  | { kind: 'dig'; gx: number; gz: number; reason: DigBlockReason | null }
  | { kind: 'fill'; field: FarmField }
  | { kind: 'uproot'; field: FarmField };

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
  /** How loud its stalks rustle when moved (0 = silent) and how dry they are (0 green, 1 ripe). */
  rustle?: { gain: number; dry: number };
}

/** Field layout of single plants: rows x rows, `spacing` m apart, base scale. */
interface SingleLayout {
  rows: number;
  spacing: number;
  scale: number;
  /** Also fill the gap between every four plants (a staggered, denser stand). */
  interleave?: boolean;
  /** Yaw (rad) every plant faces, give or take a little; random when unset. 0 = model +X to the east. */
  facing?: number;
}

/** Spread around a crop's `facing` (rad, either way). */
const FACING_JITTER = 0.6;

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
  part: CropPart;
  /** The batch's own copy of the geometry (springy batches carry their aBend on it). */
  ownsGeometry: boolean;
  /** Cell (CROP_CELL m) the batch's fields stand in. */
  cx: number;
  cz: number;
  /** Wearing the distance-dither twin (the cell reaches into the fade band). */
  fading: boolean;
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
  /** Rustle loudness (0 = silent) and dryness of this batch's stalks. */
  rustleGain: number;
  rustleDry: number;
}

/** Tip offset (m) at full push, spring stiffness and damping (underdamped: a couple of wobbles). */
const WHEAT_MAX_BEND = 0.42;
const SPRING_K = 70;
const SPRING_DAMP = 5.5;
const MAX_PUSHERS = 16;
/** Stalks farther than this (m) from the rustle ear aren't heard. */
const RUSTLE_EAR_RADIUS = 3;
/** Rustle per wheat stage: seedlings barely whisper, green stalks swish, ripe ones crackle. */
const WHEAT_RUSTLE: Record<CropStage, { gain: number; dry: number }> = {
  1: { gain: 0.2, dry: 0 },
  2: { gain: 0.75, dry: 0.3 },
  3: { gain: 1, dry: 1 },
};

const IDENTITY = new THREE.Matrix4();
const isIdentity = (m: THREE.Matrix4) => m.equals(IDENTITY);

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
 * Big dug-up fields (3 x 3 m of terrain turned to soil) made with the shovel.
 *
 * Performance: plants are drawn through InstancedMeshes, one per crop / stage / part in each
 * CROP_CELL cell, so a farm costs a handful of draw calls and cells out of view or past the fade
 * distance are skipped (far ones dissolve with a dither, see updateVisibility). Instance
 * buffers are rebuilt only when a field is dug, planted, grows a stage or is harvested; the wind sway
 * runs in the vertex shader. The soil itself is the terrain's own dirt splat layer and its damp look
 * a channel of the terrain's splat texture (TerrainSystem.setWetness): no extra mesh or draw call.
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

  /** Where the rustle is heard (the player); see setRustleEar(). */
  private readonly ear = { x: 0, z: 0, on: false };
  /**
   * Stalk motion near the ear, refreshed by every update(): `energy` = summed tip speed (m/s,
   * loudness-weighted), `hits` = stalks a body just started pushing (one brush each), `dry` = the
   * energy-weighted dryness of what moved. Read by the wheat-rustle audio.
   */
  public readonly rustle = { energy: 0, hits: 0, dry: 0 };

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
    // ...and its distance-dither twin, which every crop's far fields share
    warm(wheatProbe, acquireDistanceDither(FIELD_CROP_MATERIAL, CROP_FADE));
  }

  public setWorld(terrain: TerrainSystem, physics: PhysicsWorld): void {
    this.terrain = terrain;
    this.physics = physics;
  }

  // ---------------------------------------------------------------- queries

  /** The field's soil is under a roof (greenhouse): rain and snowmelt do not reach it. */
  public isSheltered(f: FarmField): boolean {
    return !!this.terrain && this.terrain.isSheltered(f.center.x, f.center.z);
  }

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
    if (inside) return inside.crop ? { kind: 'uproot', field: inside } : { kind: 'fill', field: inside };

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

  /** Called when the shovel digs a new field (not when a save restores one). */
  public onDug: ((field: FarmField) => void) | null = null;

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
      wetness: crop?.isWatered ? 1 : 0,
      wetShown: -1,
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
    this.dryOut(field);
    this.placementCache.delete(id);
    this.fields.delete(id);
    this.dirty = true;
    return true;
  }

  public clear(): void {
    for (const f of this.fields.values()) {
      this.group.remove(f.indicator);
      this.dryOut(f);
    }
    this.fields.clear();
    this.placementCache.clear();
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
    // Planting spots, matching the wheat layout
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
    // Rain darkens all bare earth at once (one uniform), soaking in fast and drying slowly
    const rain = this.rainWet ? 1 : 0;
    if (this.rainWetness !== rain) {
      this.rainWetness = rain > this.rainWetness ? Math.min(1, this.rainWetness + dt * 1.6) : Math.max(0, this.rainWetness - dt * 0.25);
      this.terrain?.setRainWetness(this.rainWetness * WET_OPACITY);
    }
    if (this.dirty) {
      this.dirty = false;
      this.rebuildInstances();
      this.visibilityAt.set(Infinity, Infinity);
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

  /** Rain's soaking of all bare earth, 0..1 (eased; see update). */
  private rainWetness = 0;

  /** Soaks in quickly after watering, dries out slowly once the stage has used the water up. */
  private updateWetness(f: FarmField, dt: number): void {
    const target = f.crop?.isWatered ? 1 : 0;
    if (f.wetness !== target) {
      f.wetness = target > f.wetness ? Math.min(1, f.wetness + dt * 1.6) : Math.max(0, f.wetness - dt * 0.25);
    }
    // Written into the terrain's splat texture (a few texels, only when the value changes);
    // neighbouring watered fields blend into one damp patch there
    const v = Math.round(WET_OPACITY * f.wetness * 255);
    if (v !== f.wetShown && this.terrain) {
      f.wetShown = v;
      this.terrain.setWetness(f.gx, f.gz, FIELD_CELLS, FIELD_CELLS, v);
    }
  }

  /** The field is gone: its soil is dry again. */
  private dryOut(f: FarmField): void {
    if (f.wetShown > 0) this.terrain?.setWetness(f.gx, f.gz, FIELD_CELLS, FIELD_CELLS, 0);
    f.wetShown = 0;
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

  /** The point the rustle is gathered around (null: nobody listening, nothing gathered). */
  public setRustleEar(x: number, z: number, on: boolean): void {
    this.ear.x = x;
    this.ear.z = z;
    this.ear.on = on;
  }

  private updateSprings(dt: number): void {
    const rustle = this.rustle;
    rustle.energy = rustle.hits = 0;
    if (this.wheatSlots.length === 0) return;
    const ear = this.ear;
    const earR2 = ear.on ? RUSTLE_EAR_RADIUS * RUSTLE_EAR_RADIUS : -1;
    let dryW = 0;

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
            if (s.rustleGain > 0) {
              const ex = s.base[i * 2] - ear.x, ez = s.base[i * 2 + 1] - ear.z;
              if (ex * ex + ez * ez < earR2) rustle.hits += s.rustleGain * f;
            }
          }
        }
      }
    }

    const h = Math.min(dt, 1 / 30);
    for (let k = 0; k < this.springSets.length; k++) {
      const s = this.springSets[k];
      if (s.active.length === 0) continue;
      const loud = s.rustleGain > 0 && earR2 > 0;
      let energy = 0;
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
        if (loud) {
          const ex = s.base[ix] - ear.x, ez = s.base[ix + 1] - ear.z;
          const e2 = ex * ex + ez * ez;
          // Nearer stalks louder; |vx| + |vz| is close enough to the speed and needs no sqrt
          if (e2 < earR2) energy += (Math.abs(s.vel[ix]) + Math.abs(s.vel[ix + 1])) * (1 - e2 / earR2);
        }
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
      if (energy > 0) {
        energy *= s.rustleGain;
        rustle.energy += energy;
        dryW += energy * s.rustleDry;
      }
      if (hi >= 0) {
        s.attr.clearUpdateRanges();
        s.attr.addUpdateRange(lo * 2, (hi - lo + 1) * 2);
        s.attr.needsUpdate = true;
      }
    }
    rustle.dry = rustle.energy > 0 ? dryW / rustle.energy : 0;
  }

  /**
   * Springs for a (new or regrown) wheat batch. The stage geometry is shared only by this batch, so
   * disposing it frees its GPU buffers, including the previous smaller aBend: no orphaned buffers.
   * The old set is dropped from the list, leaving its typed arrays to the GC.
   */
  private createSprings(geometry: THREE.BufferGeometry, capacity: number, previous: SpringSet | null, maxBend: number, rustle?: { gain: number; dry: number }): SpringSet {
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
      rustleGain: rustle?.gain ?? 0,
      rustleDry: rustle?.dry ?? 0,
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
        parts: [{ geometry: wheat[stage], material: FIELD_CROP_MATERIAL, matrix: new THREE.Matrix4(), maxBend: WHEAT_MAX_BEND, rustle: WHEAT_RUSTLE[stage] }],
      };
    } else if (model) {
      // Plant pack: one instance per plant (springy batches copy the geometry for their aBend)
      visual = {
        single: model.field,
        parts: [{ geometry: model.stages[stage], material: model.material, matrix: new THREE.Matrix4(), maxBend: model.push?.maxBend ?? 0 }],
      };
    } else {
      // Model still loading: nothing to draw yet (the load clears this cache)
      visual = { single: WHEAT_LAYOUT, parts: [] };
    }
    this.visuals.set(key, visual);
    return visual;
  }

  /** Frees a batch: its instance buffers, its own geometry copy and its springs. */
  private disposeBatch(batch: Batch): void {
    this.group.remove(batch.mesh);
    batch.mesh.dispose();
    if (batch.ownsGeometry) batch.mesh.geometry.dispose();
    if (batch.springs) this.springSets = this.springSets.filter((s) => s !== batch.springs);
  }

  /** Camera spot (XZ) of the last visibility pass; reset to force one. */
  private readonly visibilityAt = new THREE.Vector2(Infinity, Infinity);

  /**
   * Per frame, from the camera: cells past the fade end are skipped, cells reaching into the fade
   * band dissolve their far plants (dither twin), nearer cells draw solid (no discard, so mobile
   * GPUs keep early-z). Re-checked only once the camera has moved a bit.
   */
  public updateVisibility(camera: THREE.Vector3): void {
    if (Math.abs(camera.x - this.visibilityAt.x) + Math.abs(camera.z - this.visibilityAt.y) < 0.5) return;
    this.visibilityAt.set(camera.x, camera.z);
    const start = CROP_FADE.value.x;
    const end = CROP_FADE.value.y;
    // Fields poke a little past their cell (a field's centre picks the cell)
    const pad = 2;
    for (const b of this.batches.values()) {
      const x0 = b.cx * CROP_CELL - pad;
      const z0 = b.cz * CROP_CELL - pad;
      const x1 = x0 + CROP_CELL + 2 * pad;
      const z1 = z0 + CROP_CELL + 2 * pad;
      const near = Math.hypot(Math.max(x0 - camera.x, 0, camera.x - x1), Math.max(z0 - camera.z, 0, camera.z - z1));
      const far = Math.hypot(Math.max(Math.abs(camera.x - x0), Math.abs(camera.x - x1)), Math.max(Math.abs(camera.z - z0), Math.abs(camera.z - z1)));
      // The shader's per-plant jitter moves the band by up to 15% of its width either way
      const slack = (end - start) * 0.15;
      b.mesh.visible = b.mesh.count > 0 && near < end + slack;
      const fading = b.mesh.visible && far > start - slack;
      if (fading !== b.fading) {
        b.fading = fading;
        b.mesh.material = fading ? acquireDistanceDither(b.part.material, CROP_FADE) : b.part.material;
      }
    }
  }

  private rebuildInstances(): void {
    const terrain = this.terrain;
    type Entry = { part: CropPart; cx: number; cz: number; matrices: THREE.Matrix4[]; owners: { field: FarmField; start: number; count: number }[] };
    const lists = new Map<string, Entry>();

    for (const field of this.fields.values()) {
      if (!field.crop || !terrain) continue;
      const { cropType, stage } = field.crop;
      const visual = this.getVisual(cropType, stage);
      const placements = this.cachedPlacements(field, visual.single, terrain);
      const cx = Math.floor(field.center.x / CROP_CELL);
      const cz = Math.floor(field.center.z / CROP_CELL);
      visual.parts.forEach((part, pi) => {
        const key = `${cropType}:${stage}:${pi}|${cx}|${cz}`;
        let entry = lists.get(key);
        if (!entry) lists.set(key, (entry = { part, cx, cz, matrices: [], owners: [] }));
        entry.owners.push({ field, start: entry.matrices.length, count: placements.length });
        // Parts sit at the plant's origin (identity matrix): share the cached placement matrices
        if (isIdentity(part.matrix)) for (const m of placements) entry.matrices.push(m);
        else for (const m of placements) entry.matrices.push(m.clone().multiply(part.matrix));
      });
    }

    this.wheatSlots = [];

    // Cells whose fields were all harvested or filled in let go of their batch entirely
    for (const [key, batch] of this.batches) {
      if (!lists.has(key)) {
        this.disposeBatch(batch);
        this.batches.delete(key);
      }
    }

    for (const [key, { part, cx, cz, matrices, owners }] of lists) {
      const springy = part.maxBend > 0;
      let batch = this.batches.get(key);
      if (!batch || batch.capacity < matrices.length || batch.part !== part) {
        if (batch) this.disposeBatch(batch);
        // Small cells hold few plants: start small, grow in powers of two
        const capacity = Math.max(16, THREE.MathUtils.ceilPowerOfTwo(matrices.length));
        // A springy batch carries its aBend on the geometry, so it gets its own copy
        const geometry = springy ? part.geometry.clone() : part.geometry;
        const mesh = new THREE.InstancedMesh(geometry, part.material, capacity);
        mesh.name = `FieldCrops_${key}`;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        const springs = springy ? this.createSprings(geometry, capacity, null, part.maxBend, part.rustle) : null;
        batch = { mesh, capacity, springs, part, ownsGeometry: springy, cx, cz, fading: false };
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
      batch.fading = false;
      mesh.material = part.material;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /**
   * A field's plant transforms for a layout, kept between rebuilds: a stage change anywhere on the
   * farm rebuilds every batch, and re-sampling the terrain for every plant of every field each time
   * was most of that cost. Fields never move; the cache entry goes with the field.
   */
  private readonly placementCache = new Map<string, { layout: SingleLayout; matrices: THREE.Matrix4[] }>();

  private cachedPlacements(field: FarmField, layout: SingleLayout, terrain: TerrainSystem): THREE.Matrix4[] {
    const hit = this.placementCache.get(field.id);
    if (hit && hit.layout === layout) return hit.matrices;
    const matrices = this.placementsFor(field, layout, terrain);
    this.placementCache.set(field.id, { layout, matrices });
    return matrices;
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
    const { rows, spacing, scale, facing } = layout;
    const yaw = () => (facing === undefined ? rand() * Math.PI * 2 : facing + (rand() - 0.5) * 2 * FACING_JITTER);
    const start = -((rows - 1) * spacing) / 2;
    const jitter = spacing * 0.32;
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < rows; q++) {
        const x = cx + start + q * spacing + (rand() - 0.5) * jitter;
        const z = cz + start + r * spacing + (rand() - 0.5) * jitter;
        put(x, z, yaw(), scale * (0.88 + rand() * 0.25), 0.03);
      }
    }
    if (layout.interleave) {
      for (let r = 0; r < rows - 1; r++) {
        for (let q = 0; q < rows - 1; q++) {
          const x = cx + start + (q + 0.5) * spacing + (rand() - 0.5) * jitter;
          const z = cz + start + (r + 0.5) * spacing + (rand() - 0.5) * jitter;
          put(x, z, yaw(), scale * (0.8 + rand() * 0.25), 0.03);
        }
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
    const legacyLen = LEGACY_FIELD_CELLS * LEGACY_FIELD_CELLS;
    for (const d of data) {
      let prev = d.prev;
      if (prev && prev.length === legacyLen && this.terrain) {
        // Old 4 x 4 field: give its ground back, then re-dig it as a 3 x 3 field from the same corner
        let i = 0;
        for (let z = d.gz; z < d.gz + LEGACY_FIELD_CELLS; z++) {
          for (let x = d.gx; x < d.gx + LEGACY_FIELD_CELLS; x++) this.terrain.setTile(x, z, prev[i++] ?? TerrainTileType.GRASS);
        }
        prev = undefined;
      }
      this.createField(d.gx, d.gz, d.crop ? { ...d.crop } : null, prev);
    }
  }
}
