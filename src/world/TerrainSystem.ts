import { injectNightLights } from './NightLighting';
import { withVertexLightingQuality } from './VertexLightingQuality';
import { updateSnowMask } from './SnowCover';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { COLLISION_GROUPS } from '../config/constants';
import { GRASSY_TILES, TerrainTileType, TILE_DEFINITIONS, sanitizeTile } from '../terrain/types/TerrainTypes';
import { paintCurbTexture, paintPavingTexture } from '../terrain/PavingTextures';
import { PAVING_FLAG, PAVING_TYPES, writeTerrainTileRules } from '../terrain/PavingRules';
import { SEA_BED_TOP, SEA_FLOOR_Y, WORLD_HALF, WORLD_LIMIT, WORLD_SIZE, isMobileDevice, worldSettings } from './WorldSettings';
import { coastRadius, islandHeight } from './IslandGenerator';
import { riverWorld, unionRect, GridRect } from './rivers/RiverWorld';
import { causticsUniforms, CAUSTICS_GLSL } from '../scene/WaterEffects';
import { rippleSimUniforms } from '../scene/WaterRippleSim';
import { TRAIL_HALF, TRAIL_SIZE } from './GrassTrail';

const N = WORLD_SIZE; // cells per side (1 m cells)
const V = N + 1; // vertices per side
const CHUNK = 64; // metres per render + physics chunk -> 8x8; fits the 512 m map
const CHUNKS = N / CHUNK;
export const TERRAIN_CHUNK = CHUNK;
export const TERRAIN_CHUNKS = CHUNKS;
/** Ground this close to a water surface belongs to the shoreline, not a rain puddle (m). */
export const PUDDLE_SHORE_CLEARANCE = 0.04;
/** Vertex step per LOD level (1 m, 2 m, 4 m, 8 m). */
const LOD_STEPS = [1, 2, 4, 8];
/**
 * Distance (camera to the chunk's footprint, metres) up to which each LOD level is used; past the
 * last one the coarsest. Phones switch earlier: their GPUs pay the most per vertex.
 */
const LOD_DIST_PC = [100, 190, 300];
const LOD_DIST_MOBILE = [60, 120, 190];
/** Keep vertices touching the sea and the bilinear border of the sea's estuary mask. */
const SEA_CLIP_CLEARANCE = 0.02;
const ESTUARY_MASK_GUARD = 1;

/**
 * Index buffer for one chunk at vertex step `s`: an s-spaced grid inside, and a border ring whose
 * outer edge keeps every 1 m vertex (fans), so neighbours at any LOD meet without cracks.
 */
function buildLodIndex(s: number): number[] {
  const S = CHUNK + 1;
  const out: number[] = [];
  const id = (x: number, z: number) => z * S + x;
  // Front face = clockwise in (x, z), as the full-res grid (a, a+S, a+1)
  const tri = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => {
    const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (cross === 0) return;
    if (cross < 0) out.push(id(ax, az), id(bx, bz), id(cx, cz));
    else out.push(id(ax, az), id(cx, cz), id(bx, bz));
  };
  if (s === 1) {
    for (let z = 0; z < CHUNK; z++) for (let x = 0; x < CHUNK; x++) tri(x, z, x, z + 1, x + 1, z), tri(x + 1, z, x, z + 1, x + 1, z + 1);
    return out;
  }
  const E = CHUNK - s; // inner grid spans s..E
  for (let z = s; z < E; z += s) {
    for (let x = s; x < E; x += s) tri(x, z, x, z + s, x + s, z), tri(x + s, z, x, z + s, x + s, z + s);
  }
  // Border strips: inner segment A-B at distance s from the edge, 1 m steps along the edge
  type P = [number, number];
  const strip = (A: P, B: P, edge: (t: number) => P) => {
    const h = s / 2;
    for (let i = 0; i < s; i++) {
      const p = edge(i), q = edge(i + 1), apex = i < h ? A : B;
      tri(p[0], p[1], q[0], q[1], apex[0], apex[1]);
    }
    const m = edge(h);
    tri(m[0], m[1], A[0], A[1], B[0], B[1]);
  };
  for (let a = s; a < E; a += s) {
    strip([a, s], [a + s, s], (t) => [a + t, 0]); // z = 0 side
    strip([a, E], [a + s, E], (t) => [a + t, CHUNK]); // z = max side
    strip([s, a], [s, a + s], (t) => [0, a + t]); // x = 0 side
    strip([E, a], [E, a + s], (t) => [CHUNK, a + t]); // x = max side
  }
  // Corners: fan from the inner corner vertex over both 1 m edges
  const corner = (ix: number, iz: number, ox: number, oz: number) => {
    const path: P[] = [];
    for (let t = 0; t <= s; t++) path.push([ix + (ox - ix) * (t / s), oz]); // along the z edge
    for (let t = 1; t <= s; t++) path.push([ox, oz + (iz - oz) * (t / s)]); // along the x edge
    for (let i = 0; i + 1 < path.length; i++) tri(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1], ix, iz);
  };
  corner(s, s, 0, 0);
  corner(E, s, CHUNK, 0);
  corner(s, E, 0, CHUNK);
  corner(E, E, CHUNK, CHUNK);
  return out;
}

export type TerrainBrushKind = 'raise' | 'lower' | 'smooth' | 'flatten';

/**
 * Serialized terrain, base64. Formats 'd1' and 'd2' store run-length encoded Int16 pairs (count,
 * value) of the height difference from the generated island in centimetres, and of the tile ids.
 * 'd2' marks terrain rebased to the expanded seabed. Without `enc`: raw Int16 cm heights and raw
 * tile bytes (old saves, possibly a smaller world that gets placed in the island's centre).
 */
export interface TerrainSaveData {
  size: number;
  heights: string;
  tiles: string;
  enc?: 'd1' | 'd2';
}

/**
 * Heightmap terrain with GPU texture splatting.
 *
 * - Heights: (N+1)^2 grid, 1 m spacing, rendered as 64 m chunk meshes sharing one index buffer;
 *   chunks outside the camera frustum (and beyond the far plane) are skipped by three.js.
 * - Surface types: one byte per cell (`tiles`), packed with curb rules into an RG8 texture. The
 *   shader reads the 4 cells around each pixel, weights them bilinearly itself (soft borders) and
 *   samples each surface from one texture array (one layer per type, one texture unit for all),
 *   so any number of surface types costs the same: a pixel fetches only the 1-4 surfaces it
 *   actually touches. Only painted rows are re-uploaded. splatB's blue channel is the damp soil of
 *   watered fields (setWetness), its alpha the ground under roofs (setShelter): kept dry in the
 *   rain and free of fallen snow.
 * - Physics: one Rapier heightfield per chunk, so a brush stroke rebuilds only the chunks it touched.
 * - Beyond the island: a sea-bed collider, and invisible walls far out in the open sea.
 */
export class TerrainSystem {
  public readonly group = new THREE.Group();
  public readonly heights = new Float32Array(V * V);
  // Store fitted cuts separately so refits, removal and saves retain the terrain underneath.
  private readonly riverCuts = new Float32Array(V * V);
  public onTerrainRiversRebuilt: (() => void) | null = null;
  public readonly tiles = new Uint8Array(N * N);

  private readonly material: THREE.MeshLambertMaterial;
  private readonly chunkMeshes: THREE.Mesh[] = [];
  /** Per chunk, one geometry per LOD level sharing the position / normal buffers. */
  private readonly chunkLods: THREE.BufferGeometry[][] = [];
  private readonly lodDist = isMobileDevice() ? LOD_DIST_MOBILE : LOD_DIST_PC;
  /** Triangles in the visible chunk meshes' current LODs, before frustum culling. */
  public lodTriangles = 0;
  private seaMaskRevision = -1;
  private readonly seaMaskHoles: GridRect[] = [];
  private readonly dirtyChunks = new Set<number>();
  private readonly tileData = new Uint8Array(N * N * 2);
  private readonly tileTex: THREE.DataTexture;
  private tileFullPending = true;
  private readonly splatB: THREE.DataTexture;
  /** CPU-built basin mask (R8, one texel per terrain cell); refreshed only when heights change. */
  private readonly puddleMaskData = new Uint8Array(N * N);
  private readonly puddleMaskTex: THREE.DataTexture;
  private puddleMaskDirty = { x0: 0, z0: 0, x1: N - 1, z1: N - 1 };
  private puddleMaskFullPending = true;
  private splatDirty = true;
  /**
   * A whole-texture splat upload is queued for this frame's render: partial ranges must not be
   * added on top of it (three.js would upload only those ranges, and the very first upload
   * allocates the texture empty).
   */
  private splatFullPending = true;
  /** Cell rectangle of tiles changed since the last splat upload. */
  private splatRect = { x0: 0, z0: 0, x1: N - 1, z1: N - 1 };
  private readonly physicsDirtyChunks = new Set<number>();
  private physicsTimer = 0;
  private readonly chunkColliders: (RAPIER.Collider | null)[] = new Array(CHUNKS * CHUNKS).fill(null);
  private body: RAPIER.RigidBody | null = null;
  private readonly uniforms = { uWaterLevel: { value: worldSettings.waterLevel }, uRainWet: { value: 0 },
    // Rain falling right now (ripples in puddles), puddle water level (0 dried out .. 1 brimming)
    uRainFall: { value: 0 },
    uPuddleFill: { value: 0 },
    uPuddleSkyH: { value: new THREE.Color(0.28, 0.38, 0.48) },
    uPuddleSkyZ: { value: new THREE.Color(0.18, 0.3, 0.48) },
    uPuddleCloud: { value: new THREE.Color(0.7, 0.75, 0.8) },
    uPuddleCloudShade: { value: new THREE.Color(0.35, 0.4, 0.48) },
    uPuddleSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uPuddleSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
    uPuddleCloudCover: { value: 0.25 },
    uTerrTime: { value: 0 },
    uSnowCover: { value: 0 },
    // Footprints (GrassTrail's blue channel) around the player, and the window's centre
    uSnowTrail: { value: null as THREE.Texture | null },
    uSnowTrailC: { value: new THREE.Vector2(1e9, 1e9) },
  };
  /** Bumped on every height edit so dependants (props, water) can re-snap lazily. */
  public revision = 0;
  /** Bumped whenever a tile changes (grass density follows it). */
  public tileRevision = 0;
  /** Told which cells' tiles changed (inclusive cell rect), e.g. so the 3D grass redoes only them. */
  public onTilesDirty: ((x0: number, z0: number, x1: number, z1: number) => void) | null = null;
  /** Told which vertices' heights changed (inclusive vertex rect). */
  public onHeightsDirty: ((x0: number, z0: number, x1: number, z1: number) => void) | null = null;
  /** The grass surface texture (3D grass takes its colour from it). */
  public grassLayer!: THREE.Texture;
  /** The sand surface texture (the open-sea bed continues it past the map edge). */
  public sandLayer!: THREE.Texture;

  constructor(scene: THREE.Scene, private readonly physics: PhysicsWorld) {
    this.group.name = 'Terrain';
    scene.add(this.group);

    this.tileTex = new THREE.DataTexture(this.tileData, N, N, THREE.RGFormat, THREE.UnsignedByteType);
    this.tileTex.magFilter = THREE.NearestFilter;
    this.tileTex.minFilter = THREE.NearestFilter;
    this.tileTex.generateMipmaps = false;
    this.tileTex.unpackAlignment = 1;
    this.tileTex.onUpdate = () => { this.tileFullPending = false; };
    this.splatB = new THREE.DataTexture(new Uint8Array(N * N * 4), N, N, THREE.RGBAFormat);
    this.splatB.magFilter = THREE.LinearFilter;
    this.splatB.minFilter = THREE.LinearFilter;
    this.splatB.generateMipmaps = false;
    this.splatB.needsUpdate = true;
    this.puddleMaskTex = new THREE.DataTexture(this.puddleMaskData, N, N, THREE.RedFormat, THREE.UnsignedByteType);
    this.puddleMaskTex.magFilter = THREE.LinearFilter;
    this.puddleMaskTex.minFilter = THREE.LinearFilter;
    this.puddleMaskTex.generateMipmaps = false;
    this.puddleMaskTex.unpackAlignment = 1;
    this.puddleMaskTex.colorSpace = THREE.NoColorSpace;

    this.material = this.createMaterial();
    this.generateDefaultWorld();
    riverWorld.setPlacementGround((x, z) => this.getPlacementHeight(x, z));
    this.recutTerrainRivers();
    this.rebuildPuddleMask(0, 0, N - 1, N - 1);
    this.puddleMaskFullPending = true;
    this.buildChunks();
    this.createWorldBounds();
  }

  // ---------------------------------------------------------------- queries

  public getHeight(x: number, z: number): number {
    return this.sampleHeight(x, z, false);
  }

  public getPlacementHeight(x: number, z: number): number {
    return this.sampleHeight(x, z, true);
  }

  private sampleHeight(x: number, z: number, uncarved: boolean): number {
    const fx = THREE.MathUtils.clamp(x + WORLD_HALF, 0, N);
    const fz = THREE.MathUtils.clamp(z + WORLD_HALF, 0, N);
    const ix = Math.min(Math.floor(fx), N - 1);
    const iz = Math.min(Math.floor(fz), N - 1);
    const tx = fx - ix;
    const tz = fz - iz;
    const h = this.heights;
    const row = iz * V + ix;
    const cut = this.riverCuts;
    const a = h[row] - (uncarved ? cut[row] : 0);
    const b = h[row + 1] - (uncarved ? cut[row + 1] : 0);
    const c = h[row + V] - (uncarved ? cut[row + V] : 0);
    const d = h[row + V + 1] - (uncarved ? cut[row + V + 1] : 0);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  public isInside(x: number, z: number): boolean {
    return Math.abs(x) <= WORLD_HALF && Math.abs(z) <= WORLD_HALF;
  }

  /** Ray march against the heightmap (no physics, no triangle tests). */
  public raycast(ray: THREE.Ray, maxDist = 250, target = new THREE.Vector3()): THREE.Vector3 | null {
    const step = 0.5;
    let prevT = 0;
    for (let t = 0; t <= maxDist; t += step) {
      ray.at(t, target);
      if (!this.isInside(target.x, target.z)) {
        if (t > 0 && ray.direction.y >= 0) return null;
        prevT = t;
        continue;
      }
      if (target.y <= this.getHeight(target.x, target.z)) {
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          ray.at(mid, target);
          if (target.y <= this.getHeight(target.x, target.z)) hi = mid;
          else lo = mid;
        }
        ray.at(hi, target);
        target.y = this.getHeight(target.x, target.z);
        return target;
      }
      prevT = t;
    }
    return null;
  }

  public getTile(gx: number, gz: number): TerrainTileType {
    const ix = gx + WORLD_HALF;
    const iz = gz + WORLD_HALF;
    if (ix < 0 || iz < 0 || ix >= N || iz >= N) return TerrainTileType.GRASS;
    return this.tiles[iz * N + ix];
  }

  /** 0..1 natural basin likelihood before checking for flooding. */
  private puddlePotentialAt(x: number, z: number): number {
    const ix = Math.floor(x + WORLD_HALF);
    const iz = Math.floor(z + WORLD_HALF);
    if (ix < 0 || iz < 0 || ix >= N || iz >= N) return 0;
    return this.puddleMaskData[iz * N + ix] / 255;
  }

  /** Painted and natural puddles can hold rain only above the local surface water. */
  public hasPuddleAt(x: number, z: number, tile: TerrainTileType, minFill = 0.25): boolean {
    return this.puddleFill > minFill &&
      (tile === TerrainTileType.PUDDLE || this.puddlePotentialAt(x, z) > 0.4) &&
      this.getHeight(x, z) > riverWorld.waterLevelAt(x, z) + PUDDLE_SHORE_CLEARANCE;
  }

  /** Texture shared with terrain / grass shaders; no per-frame copies. */
  public get puddleMaskTexture(): THREE.Texture { return this.puddleMaskTex; }
  public get puddleFill(): number { return this.uniforms.uPuddleFill.value; }

  // ---------------------------------------------------------------- editing

  public setTile(gx: number, gz: number, type: TerrainTileType): boolean {
    const ix = gx + WORLD_HALF;
    const iz = gz + WORLD_HALF;
    if (ix < 0 || iz < 0 || ix >= N || iz >= N) return false;
    if (this.tiles[iz * N + ix] === type) return false;
    this.tiles[iz * N + ix] = type;
    this.markSplatDirty(ix, iz, ix, iz);
    return true;
  }

  public paintCircle(x: number, z: number, radius: number, type: TerrainTileType): void {
    const r = Math.max(0.5, radius);
    for (let gz = Math.floor(z - r); gz <= Math.ceil(z + r); gz++) {
      for (let gx = Math.floor(x - r); gx <= Math.ceil(x + r); gx++) {
        const dx = gx + 0.5 - x;
        const dz = gz + 0.5 - z;
        if (dx * dx + dz * dz <= r * r) this.setTile(gx, gz, type);
      }
    }
  }

  /** Flood fill of connected same-type cells (capped). */
  public fillTiles(x: number, z: number, type: TerrainTileType, maxCells = 6000): void {
    const sx = Math.floor(x) + WORLD_HALF;
    const sz = Math.floor(z) + WORLD_HALF;
    if (sx < 0 || sz < 0 || sx >= N || sz >= N) return;
    const from = this.tiles[sz * N + sx];
    if (from === type) return;
    const stack = [sz * N + sx];
    let count = 0;
    let x0 = sx, x1 = sx, z0 = sz, z1 = sz;
    while (stack.length && count < maxCells) {
      const i = stack.pop()!;
      if (this.tiles[i] !== from) continue;
      this.tiles[i] = type;
      count++;
      const cx = i % N;
      const cz = (i - cx) / N;
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx);
      z0 = Math.min(z0, cz); z1 = Math.max(z1, cz);
      if (cx > 0) stack.push(i - 1);
      if (cx < N - 1) stack.push(i + 1);
      if (cz > 0) stack.push(i - N);
      if (cz < N - 1) stack.push(i + N);
    }
    this.markSplatDirty(x0, z0, x1, z1);
  }

  private markSplatDirty(x0: number, z0: number, x1: number, z1: number): void {
    this.saveEdits++;
    const r = this.splatRect;
    if (!this.splatDirty) {
      r.x0 = x0;
      r.z0 = z0;
      r.x1 = x1;
      r.z1 = z1;
    } else {
      r.x0 = Math.min(r.x0, x0);
      r.z0 = Math.min(r.z0, z0);
      r.x1 = Math.max(r.x1, x1);
      r.z1 = Math.max(r.z1, z1);
    }
    this.splatDirty = true;
    this.tileRevision++;
    this.onTilesDirty?.(x0, z0, x1, z1);
  }

  /**
   * Sculpt brush with smooth falloff. `strength` is metres per second at the brush centre.
   * `flattenTo` is the target height for the flatten brush.
   */
  public sculpt(kind: TerrainBrushKind, x: number, z: number, radius: number, strength: number, dt: number, flattenTo = 0): void {
    const r = Math.max(1, radius);
    const minX = Math.max(0, Math.floor(x + WORLD_HALF - r));
    const maxX = Math.min(N, Math.ceil(x + WORLD_HALF + r));
    const minZ = Math.max(0, Math.floor(z + WORLD_HALF - r));
    const maxZ = Math.min(N, Math.ceil(z + WORLD_HALF + r));
    const h = this.heights;
    const src = kind === 'smooth' ? h.slice() : h;

    for (let iz = minZ; iz <= maxZ; iz++) {
      for (let ix = minX; ix <= maxX; ix++) {
        const dx = ix - WORLD_HALF - x;
        const dz = iz - WORLD_HALF - z;
        const d = Math.sqrt(dx * dx + dz * dz) / r;
        if (d >= 1) continue;
        const falloff = 0.5 + 0.5 * Math.cos(d * Math.PI); // smooth bell
        const k = falloff * strength * dt;
        const i = iz * V + ix;
        if (kind === 'raise') h[i] += k;
        else if (kind === 'lower') h[i] -= k;
        else if (kind === 'flatten') h[i] += (flattenTo - h[i]) * Math.min(1, k * 2);
        else {
          let sum = 0;
          let n = 0;
          for (let oz = -1; oz <= 1; oz++) {
            for (let ox = -1; ox <= 1; ox++) {
              const jx = ix + ox;
              const jz = iz + oz;
              if (jx < 0 || jz < 0 || jx > N || jz > N) continue;
              sum += src[jz * V + jx];
              n++;
            }
          }
          h[i] += (sum / n - h[i]) * Math.min(1, k * 2);
        }
        h[i] = THREE.MathUtils.clamp(h[i], SEA_FLOOR_Y, 128);
      }
    }
    this.markHeightsDirty(minX, minZ, maxX, maxZ);
  }

  private markHeightsDirty(minX: number, minZ: number, maxX: number, maxZ: number): void {
    this.rebuildPuddleMask(minX - 6, minZ - 6, maxX + 6, maxZ + 6);
    // A vertex on a chunk edge belongs to both neighbours; normals also read one cell further out
    const c0x = Math.max(0, Math.floor((minX - 1) / CHUNK));
    const c1x = Math.min(CHUNKS - 1, Math.floor((maxX + 1) / CHUNK));
    const c0z = Math.max(0, Math.floor((minZ - 1) / CHUNK));
    const c1z = Math.min(CHUNKS - 1, Math.floor((maxZ + 1) / CHUNK));
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        this.dirtyChunks.add(cz * CHUNKS + cx);
        this.physicsDirtyChunks.add(cz * CHUNKS + cx);
      }
    }
    this.revision++;
    this.saveEdits++;
    this.onHeightsDirty?.(minX, minZ, maxX, maxZ);
  }

  /** Call once per frame: uploads changed chunks / weights; physics rebuilds at most 4x per second. */
  public update(dt: number): void {
    this.uniforms.uWaterLevel.value = worldSettings.waterLevel;
    this.uniforms.uTerrTime.value = (this.uniforms.uTerrTime.value + dt) % 1000;
    // Last frame's render took the queued full upload
    this.splatFullPending = false;
    if (this.dirtyChunks.size) {
      for (const c of this.dirtyChunks) this.writeChunkGeometry(c);
      this.dirtyChunks.clear();
    }
    if (this.splatDirty) {
      this.uploadSplat();
      this.splatDirty = false;
    }
    if (this.puddleMaskFullPending || this.puddleMaskDirty.x0 <= this.puddleMaskDirty.x1) this.uploadPuddleMask();
    this.physicsTimer -= dt;
    if (this.physicsDirtyChunks.size && this.physicsTimer <= 0) {
      this.rebuildDirtyColliders();
      this.physicsTimer = 0.25;
    }
  }

  /** Height-vs-neighbour average identifies concave basins while rejecting slopes and hilltops. */
  private rebuildPuddleMask(x0: number, z0: number, x1: number, z1: number): void {
    const ax = Math.max(0, Math.floor(x0)), az = Math.max(0, Math.floor(z0));
    const bx = Math.min(N - 1, Math.ceil(x1)), bz = Math.min(N - 1, Math.ceil(z1));
    const h = this.heights;
    const sample = (x: number, z: number) => h[THREE.MathUtils.clamp(z, 0, N) * V + THREE.MathUtils.clamp(x, 0, N)];
    for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) {
      const center = sample(x, z);
      let near = 0, far = 0;
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4, dx = Math.round(Math.cos(a)), dz = Math.round(Math.sin(a));
        near += sample(x + dx * 3, z + dz * 3);
        far += sample(x + dx * 6, z + dz * 6);
      }
      const basin = ((near + far) / 16) - center;
      const slope = Math.hypot((sample(x + 1, z) - sample(x - 1, z)) * 0.5, (sample(x, z + 1) - sample(x, z - 1)) * 0.5);
      const basinMask = THREE.MathUtils.smoothstep(basin, 0.08, 0.42) * (1 - THREE.MathUtils.smoothstep(slope, 0.16, 0.5));
      this.puddleMaskData[z * N + x] = Math.round(basinMask * 255);
    }
    const r = this.puddleMaskDirty;
    r.x0 = Math.min(r.x0, ax); r.z0 = Math.min(r.z0, az);
    r.x1 = Math.max(r.x1, bx); r.z1 = Math.max(r.z1, bz);
  }

  private uploadPuddleMask(): void {
    const r = this.puddleMaskDirty;
    const rows = r.z1 - r.z0 + 1;
    if (this.puddleMaskFullPending || rows * (r.x1 - r.x0 + 1) > (N * N) / 4) {
      this.puddleMaskTex.clearUpdateRanges();
      this.puddleMaskFullPending = true;
    } else {
      const count = (r.x1 - r.x0 + 1) * 4;
      for (let z = r.z0; z <= r.z1; z++) this.puddleMaskTex.addUpdateRange((z * N + r.x0) * 4, count);
    }
    this.puddleMaskTex.needsUpdate = true;
    this.puddleMaskFullPending = false;
    r.x0 = N; r.z0 = N; r.x1 = -1; r.z1 = -1;
  }

  /** Forces the physics heightfield to match immediately (e.g. on brush release). */
  public commit(): void {
    if (this.physicsDirtyChunks.size) this.rebuildDirtyColliders();
  }

  // ---------------------------------------------------------------- generation

  /** Generated island heights (rounded to cm, as saved) and default tiles. */
  private static baseCache: { heights: Int16Array; tiles: Uint8Array } | null = null;

  private static base(): { heights: Int16Array; tiles: Uint8Array } {
    if (TerrainSystem.baseCache) return TerrainSystem.baseCache;
    // Natural island first; rivers are carved into it (they read the natural ground for their levels)
    const natural = new Float32Array(V * V);
    for (let iz = 0; iz <= N; iz++) {
      for (let ix = 0; ix <= N; ix++) natural[iz * V + ix] = islandHeight(ix - WORLD_HALF, iz - WORLD_HALF);
    }
    riverWorld.setNatural(natural);
    const carved = riverWorld.computeRegion({ x0: 0, z0: 0, x1: N, z1: N });
    const heights = new Int16Array(V * V);
    for (let i = 0; i < heights.length; i++) heights[i] = Math.round(carved[i] * 100);
    const tiles = new Uint8Array(N * N).fill(TerrainTileType.GRASS);
    // Dirt path from spawn towards the pond
    for (let t = 0; t <= 1; t += 0.01) {
      const x = THREE.MathUtils.lerp(2, 22, t);
      const z = THREE.MathUtils.lerp(6, 21, t) + Math.sin(t * 6) * 1.5;
      for (let gz = Math.floor(z - 1.1); gz <= Math.ceil(z + 1.1); gz++) {
        for (let gx = Math.floor(x - 1.1); gx <= Math.ceil(x + 1.1); gx++) {
          const dx = gx + 0.5 - x;
          const dz = gz + 0.5 - z;
          if (dx * dx + dz * dz <= 1.21) tiles[(gz + WORLD_HALF) * N + gx + WORLD_HALF] = TerrainTileType.DIRT_ROAD;
        }
      }
    }
    TerrainSystem.baseCache = { heights, tiles };
    return TerrainSystem.baseCache;
  }

  /**
   * Regenerates the rivers' part of the generated terrain in a rectangle (a river was edited).
   * With `applyToLive` the current heights shift by the same amount, so the player's sculpting on
   * top is kept; without it only the base moves (undo restores the live heights itself).
   */
  public refreshRivers(rect: GridRect | null, applyToLive = true): void {
    if (!rect) return;
    const base = TerrainSystem.base();
    const carved = riverWorld.computeRegion(rect);
    const w = rect.x1 - rect.x0 + 1;
    for (let iz = rect.z0; iz <= rect.z1; iz++) {
      for (let ix = rect.x0; ix <= rect.x1; ix++) {
        const i = iz * V + ix;
        const cm = Math.round(carved[(iz - rect.z0) * w + ix - rect.x0] * 100);
        if (applyToLive) {
          this.heights[i] += (cm - base.heights[i]) / 100 - this.riverCuts[i];
          this.riverCuts[i] = 0;
        }
        base.heights[i] = cm;
      }
    }
    if (applyToLive && riverWorld.defs.some(d => d.fitTerrain)) {
      riverWorld.invalidateTerrainProfiles(riverWorld.lastChanged);
      this.carveTerrainRivers(rect);
    }
    this.markHeightsDirty(rect.x0, rect.z0, rect.x1, rect.z1);
  }

  private carveTerrainRivers(rect: GridRect): void {
    const w = rect.x1 - rect.x0 + 1;
    const carved = new Float32Array(w * (rect.z1 - rect.z0 + 1));
    for (let z = rect.z0; z <= rect.z1; z++) {
      const row = z * V + rect.x0;
      carved.set(this.heights.subarray(row, row + w), (z - rect.z0) * w);
    }
    riverWorld.carveTerrainRegion(rect, carved);
    for (let z = rect.z0; z <= rect.z1; z++) for (let x = rect.x0; x <= rect.x1; x++) {
      const i = z * V + x;
      const y = carved[(z - rect.z0) * w + x - rect.x0];
      this.riverCuts[i] = y - this.heights[i];
      this.heights[i] = y;
    }
  }

  private recutTerrainRivers(): void {
    const previous = riverWorld.terrainRiverRegion();
    riverWorld.invalidateTerrainProfiles();
    const rect = unionRect(previous, riverWorld.terrainRiverRegion());
    if (!rect) return;
    this.refreshRivers(rect);
    this.onTerrainRiversRebuilt?.();
  }

  public captureUncarvedHeights(): Float32Array {
    return this.heights.map((y, i) => y - this.riverCuts[i]);
  }

  public restoreUncarvedHeights(heights: Float32Array): void {
    this.heights.set(heights);
    this.riverCuts.fill(0);
    this.invalidateSaveCache();
  }

  private generateDefaultWorld(): void {
    const base = TerrainSystem.base();
    for (let i = 0; i < this.heights.length; i++) this.heights[i] = base.heights[i] / 100;
    this.tiles.set(base.tiles);
    this.markSplatDirty(0, 0, N - 1, N - 1);
    for (let i = 0; i < CHUNKS * CHUNKS; i++) this.physicsDirtyChunks.add(i);
  }

  public resetFlat(): void {
    this.heights.fill(0);
    this.riverCuts.fill(0);
    this.recutTerrainRivers();
    this.tiles.fill(TerrainTileType.GRASS);
    this.markHeightsDirty(0, 0, N, N);
    this.markSplatDirty(0, 0, N - 1, N - 1);
  }

  // ---------------------------------------------------------------- rendering

  private buildChunks(): void {
    const S = CHUNK + 1;
    // One index buffer per LOD level, shared by all chunks; vertices stay full resolution
    const indices = LOD_STEPS.map((s) => new THREE.Uint16BufferAttribute(buildLodIndex(s), 1));

    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const position = new THREE.BufferAttribute(new Float32Array(S * S * 3), 3);
        const normal = new THREE.BufferAttribute(new Float32Array(S * S * 3), 3);
        // Baked shadow of static objects per vertex (0 = lit, 1 = full shade), see StaticShadows
        const shade = new THREE.BufferAttribute(new Uint8Array(S * S), 1, true);
        const lods = indices.map((index) => {
          const g = new THREE.BufferGeometry();
          g.setIndex(index);
          g.setAttribute('position', position);
          g.setAttribute('normal', normal);
          g.setAttribute('aShade', shade);
          return g;
        });
        this.chunkLods.push(lods);
        const geo = lods[0];
        const mesh = new THREE.Mesh(geo, this.material);
        mesh.name = `TerrainChunk_${cx}_${cz}`;
        mesh.matrixAutoUpdate = false;
        this.chunkMeshes.push(mesh);
        this.group.add(mesh);
        this.writeChunkGeometry(cz * CHUNKS + cx);
      }
    }
  }

  private writeChunkGeometry(chunkIndex: number): void {
    const cx = chunkIndex % CHUNKS;
    const cz = (chunkIndex - cx) / CHUNKS;
    const mesh = this.chunkMeshes[chunkIndex];
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nor = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const p = pos.array as Float32Array;
    const n = nor.array as Float32Array;
    const h = this.heights;
    const S = CHUNK + 1;
    let k = 0;
    for (let z = 0; z < S; z++) {
      const iz = cz * CHUNK + z;
      for (let x = 0; x < S; x++) {
        const ix = cx * CHUNK + x;
        const y = h[iz * V + ix];
        p[k] = ix - WORLD_HALF;
        p[k + 1] = y;
        p[k + 2] = iz - WORLD_HALF;
        // Central-difference normal, continuous across chunk borders
        const hl = h[iz * V + Math.max(0, ix - 1)];
        const hr = h[iz * V + Math.min(N, ix + 1)];
        const hd = h[Math.max(0, iz - 1) * V + ix];
        const hu = h[Math.min(N, iz + 1) * V + ix];
        let nx = hl - hr;
        let ny = 2;
        let nz = hd - hu;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        n[k] = nx / len;
        n[k + 1] = ny / len;
        n[k + 2] = nz / len;
        k += 3;
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    const lods = this.chunkLods[chunkIndex];
    lods[0].computeBoundingSphere();
    lods[0].computeBoundingBox();
    for (let i = 1; i < lods.length; i++) {
      lods[i].boundingSphere = lods[0].boundingSphere;
      lods[i].boundingBox = lods[0].boundingBox;
    }
  }

  /**
   * Picks each chunk's LOD from the camera's horizontal distance to its footprint. Every LOD keeps
   * full-resolution chunk borders, so neighbours never crack; normals are per 1 m vertex, so the
   * lighting stays the same and only the silhouette of far hills simplifies.
   */
  /** Replaces a chunk's baked shadow ((CHUNK+1)^2 bytes, row-major from the chunk's -X/-Z corner). */
  public setChunkShade(chunkIndex: number, data: Uint8Array): void {
    const attr = this.chunkLods[chunkIndex][0].getAttribute('aShade') as THREE.BufferAttribute;
    (attr.array as Uint8Array).set(data);
    attr.needsUpdate = true;
  }

  public updateLod(camera: THREE.Vector3, seaLevel: number | null = null): void {
    if (seaLevel !== null && this.seaMaskRevision !== riverWorld.revision) {
      this.seaMaskRevision = riverWorld.revision;
      this.seaMaskHoles.length = 0;
      for (const river of riverWorld.all()) {
        const rect = riverWorld.rectOf(river);
        if (rect) this.seaMaskHoles.push(rect);
      }
    }
    let tris = 0;
    for (let c = 0; c < this.chunkMeshes.length; c++) {
      const mesh = this.chunkMeshes[c];
      mesh.visible = seaLevel === null || !this.seaOccludesChunk(camera, seaLevel, mesh.geometry.boundingBox!);
      if (!mesh.visible) continue;
      const cx = c % CHUNKS, cz = (c - cx) / CHUNKS;
      const x0 = cx * CHUNK - WORLD_HALF, z0 = cz * CHUNK - WORLD_HALF;
      const dx = Math.max(x0 - camera.x, 0, camera.x - (x0 + CHUNK));
      const dz = Math.max(z0 - camera.z, 0, camera.z - (z0 + CHUNK));
      const d = Math.sqrt(dx * dx + dz * dz);
      let level = 0;
      while (level < this.lodDist.length && d > this.lodDist[level]) level++;
      const geo = this.chunkLods[c][level];
      if (mesh.geometry !== geo) mesh.geometry = geo;
      tris += geo.index!.count / 3;
    }
    this.lodTriangles = tris;
  }

  private seaOccludesChunk(camera: THREE.Vector3, level: number, bounds: THREE.Box3): boolean {
    const above = camera.y > level;
    if (above ? bounds.max.y >= level - SEA_CLIP_CLEARANCE : bounds.min.y <= level + SEA_CLIP_CLEARANCE) return false;
    if (this.seaMaskHoles.length === 0) return true;

    // Project the chunk's bounds from the camera onto the sea plane. A river can punch a hole
    // in the surface between the camera and the chunk, even when the chunk itself is well offshore.
    const t0 = (level - camera.y) / (bounds.min.y - camera.y);
    const t1 = (level - camera.y) / (bounds.max.y - camera.y);
    const near = Math.min(t0, t1), far = Math.max(t0, t1);
    const minX = bounds.min.x - camera.x, maxX = bounds.max.x - camera.x;
    const minZ = bounds.min.z - camera.z, maxZ = bounds.max.z - camera.z;
    const x0 = camera.x + minX * (minX < 0 ? far : near) + WORLD_HALF - ESTUARY_MASK_GUARD;
    const x1 = camera.x + maxX * (maxX > 0 ? far : near) + WORLD_HALF + ESTUARY_MASK_GUARD;
    const z0 = camera.z + minZ * (minZ < 0 ? far : near) + WORLD_HALF - ESTUARY_MASK_GUARD;
    const z1 = camera.z + maxZ * (maxZ > 0 ? far : near) + WORLD_HALF + ESTUARY_MASK_GUARD;
    for (const hole of this.seaMaskHoles) {
      if (x0 <= hole.x1 && x1 >= hole.x0 && z0 <= hole.z1 && z1 >= hole.z0) return false;
    }
    return true;
  }

  private uploadSplat(): void {
    const r = this.splatRect;
    // Snow-tile mask for the snow caps on trees, bushes and rocks (SnowCover)
    updateSnowMask(this.tiles, r.x0, r.z0, r.x1, r.z1);
    // A changed tile can alter the curb of any of its eight neighbours.
    const x0 = Math.max(0, r.x0 - 1), z0 = Math.max(0, r.z0 - 1);
    const x1 = Math.min(N - 1, r.x1 + 1), z1 = Math.min(N - 1, r.z1 + 1);
    writeTerrainTileRules(this.tileData, this.tiles, N, x0, z0, x1, z1);
    if (this.splatFullPending || (r.z1 - r.z0 + 1) * (r.x1 - r.x0 + 1) > (N * N) / 4) {
      if (!this.splatFullPending) {
        this.splatB.clearUpdateRanges();
        this.splatB.needsUpdate = true;
      }
      this.splatFullPending = true;
    }
    if (this.tileFullPending || (z1 - z0 + 1) * (x1 - x0 + 1) > (N * N) / 4) {
      this.tileTex.clearUpdateRanges();
      this.tileFullPending = true;
    } else {
      // three.js reads update ranges as RGBA components (stride hard-coded to 4) even for this
      // RG8 texture: ranges are given x4 so they map back to texels.
      const count = (x1 - x0 + 1) * 4;
      for (let z = z0; z <= z1; z++) this.tileTex.addUpdateRange((z * N + x0) * 4, count);
    }
    this.tileTex.needsUpdate = true;
  }

  /** Rain soaking all bare earth (the dirt layer): 0 dry .. 1 the darkest damp soil. */
  public setRainWetness(value: number): void {
    this.uniforms.uRainWet.value = value;
  }

  /** Rain falling now (0..1): rings on the puddles. */
  public setRainFall(value: number): void {
    this.uniforms.uRainFall.value = value;
  }

  /** How full the painted puddles are: 0 only their deepest middles hold water .. 1 brimming. */
  public setPuddleFill(value: number): void {
    this.uniforms.uPuddleFill.value = value;
  }

  /** Keep puddle highlights in sync with the current procedural sky without a reflection pass. */
  public setPuddleSky(sky: { horizon: THREE.Color; zenith: THREE.Color; cloudLit: THREE.Color; cloudShade: THREE.Color; cover: number; sunDir: THREE.Vector3; sunColor: THREE.Color }): void {
    this.uniforms.uPuddleSkyH.value.copy(sky.horizon);
    this.uniforms.uPuddleSkyZ.value.copy(sky.zenith);
    this.uniforms.uPuddleCloud.value.copy(sky.cloudLit);
    this.uniforms.uPuddleCloudShade.value.copy(sky.cloudShade);
    this.uniforms.uPuddleSunDir.value.copy(sky.sunDir);
    this.uniforms.uPuddleSunColor.value.copy(sky.sunColor);
    this.uniforms.uPuddleCloudCover.value = sky.cover;
  }

  /** Fallen snow from the weather (0 bare .. 1 white everywhere); settles in patches first. */
  public setSnowCover(value: number): void {
    this.uniforms.uSnowCover.value = value;
  }

  /** The trail field whose blue channel holds footprints, and its (live) window centre. */
  public setSnowTrail(texture: THREE.Texture, center: THREE.Vector2): void {
    this.uniforms.uSnowTrail.value = texture;
    this.uniforms.uSnowTrailC.value = center;
  }

  /**
   * Damp soil (a watered field, rain on the fields): how much darker the ground is over the cell
   * rectangle `gx..gx+w-1`, `gz..gz+h-1` (world metres), 0..255. Kept in splatB's blue channel and
   * sampled with the surface weights, so it costs no draw call; only the touched rows upload.
   */
  public setWetness(gx: number, gz: number, w: number, h: number, value: number): void {
    const v = Math.max(0, Math.min(255, Math.round(value)));
    const b = this.splatB.image.data as Uint8Array;
    const x0 = Math.max(0, gx + WORLD_HALF);
    const x1 = Math.min(N - 1, gx + WORLD_HALF + w - 1);
    if (x1 < x0) return;
    let changed = false;
    for (let iz = Math.max(0, gz + WORLD_HALF); iz <= Math.min(N - 1, gz + WORLD_HALF + h - 1); iz++) {
      let rowChanged = false;
      for (let ix = x0; ix <= x1; ix++) {
        const o = (iz * N + ix) * 4 + 2;
        if (b[o] !== v) {
          b[o] = v;
          rowChanged = true;
        }
      }
      if (!rowChanged) continue;
      changed = true;
      if (!this.splatFullPending) this.splatB.addUpdateRange((iz * N + x0) * 4, (x1 - x0 + 1) * 4);
    }
    if (changed) this.splatB.needsUpdate = true;
  }

  /** Cells (row-major indices into the N x N grid) currently marked as under a roof. */
  private shelteredCells: number[] = [];

  /**
   * Ground under roofs (greenhouses, houses): world-space rectangles whose cells stay dry in the
   * rain and get no fallen snow. Replaces the previous set; kept in splatB's alpha channel.
   */
  public setShelter(rects: { x0: number; z0: number; x1: number; z1: number }[]): void {
    const b = this.splatB.image.data as Uint8Array;
    const next: number[] = [];
    for (const r of rects) {
      // Cells whose centre lies inside the rectangle
      const cx0 = Math.max(0, Math.ceil(r.x0 - 0.5) + WORLD_HALF);
      const cx1 = Math.min(N - 1, Math.floor(r.x1 - 0.5) + WORLD_HALF);
      const cz0 = Math.max(0, Math.ceil(r.z0 - 0.5) + WORLD_HALF);
      const cz1 = Math.min(N - 1, Math.floor(r.z1 - 0.5) + WORLD_HALF);
      for (let iz = cz0; iz <= cz1; iz++) for (let ix = cx0; ix <= cx1; ix++) next.push(iz * N + ix);
    }
    const keep = new Set(next);
    const rows = new Set<number>();
    for (const i of this.shelteredCells) {
      if (keep.has(i) || b[i * 4 + 3] === 0) continue;
      b[i * 4 + 3] = 0;
      rows.add(Math.floor(i / N));
    }
    for (const i of next) {
      if (b[i * 4 + 3] === 255) continue;
      b[i * 4 + 3] = 255;
      rows.add(Math.floor(i / N));
    }
    this.shelteredCells = next;
    if (!rows.size) return;
    // Whole rows: few roofs touch few rows
    if (!this.splatFullPending) for (const z of rows) this.splatB.addUpdateRange(z * N * 4, N * 4);
    this.splatB.needsUpdate = true;
  }

  /** True when the ground cell at world (x, z) is under a roof (see setShelter). */
  public isSheltered(x: number, z: number): boolean {
    const ix = Math.floor(x) + WORLD_HALF;
    const iz = Math.floor(z) + WORLD_HALF;
    if (ix < 0 || iz < 0 || ix >= N || iz >= N) return false;
    return (this.splatB.image.data as Uint8Array)[(iz * N + ix) * 4 + 3] > 127;
  }

  private createMaterial(): THREE.MeshLambertMaterial {
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    // Phones already use the cheaper surface shader at standard quality.
    const lite = isMobileDevice();
    if (lite) mat.defines = { TERRAIN_LITE: '' };
    mat.customProgramCacheKey = () => (lite ? 'terrain-lite' : 'terrain');
    const layers = {
      tGrass: createLayerTexture(TerrainTileType.GRASS),
      tLayers: createSurfaceArray(),
      tRock: createRockTexture(),
    };
    this.grassLayer = layers.tGrass;
    // The sea bed past the map edge continues the sand (WaterSystem): its own 2D texture
    this.sandLayer = createLayerTexture(TerrainTileType.SAND_BEACH);
    mat.onBeforeCompile = (shader) => {
      injectNightLights(shader, { perVertex: lite, ground: true, playerShadow: true });
      Object.assign(shader.uniforms, this.uniforms, causticsUniforms, rippleSimUniforms, {
        tRiver: { value: riverWorld.texture },
        tTiles: { value: this.tileTex },
        tSplatB: { value: this.splatB },
        tPuddleMask: { value: this.puddleMaskTex },
        uWorldSize: { value: WORLD_SIZE },
      });
      for (const [k, v] of Object.entries(layers)) shader.uniforms[k] = { value: v };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTerrWorld;\nvarying float vTerrUpY;\nvarying vec3 vTerrN;\nattribute float aShade;\nvarying float vShade;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvTerrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTerrN = normalize(mat3(modelMatrix) * objectNormal);\nvTerrUpY = vTerrN.y;\nvShade = aShade;'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
#if defined(QUALITY_VERTEX_LIGHTING) && !defined(TERRAIN_LITE)
  #define TERRAIN_LITE
#endif
varying vec3 vTerrWorld;
varying float vTerrUpY;
varying vec3 vTerrN;
varying float vShade;
uniform sampler2D tGrass, tRock, tTiles, tSplatB, tRiver;
uniform highp sampler2DArray tLayers;
${SURFACE_GLSL}
uniform float uWorldSize;
uniform float uWaterLevel;
uniform float uRainWet;
uniform float uRainFall;
uniform float uPuddleFill;
uniform sampler2D tPuddleMask;
uniform vec3 uPuddleSkyH, uPuddleSkyZ, uPuddleCloud, uPuddleCloudShade, uPuddleSunDir, uPuddleSunColor;
uniform float uPuddleCloudCover;
uniform float uTerrTime;
// The wave simulation around the player (WaterRippleSim): puddles ripple with it too
uniform sampler2D uWdSim;
uniform vec4 uWdSimArea;
uniform vec4 uWdSimLook;
uniform float uSnowCover;
uniform sampler2D uSnowTrail;
uniform vec2 uSnowTrailC;
float terrWaterY;
${CAUSTICS_GLSL}
// Rock on steep slopes: triplanar, so it never smears down a cliff the way a top-down (XZ)
// projection does. Side projections only fetch where they actually show.
vec3 rockTriplanar(float scale) {
  vec3 w = abs(normalize(vTerrN));
  w = w * w * w * w;
  w /= w.x + w.y + w.z;
  vec3 p = vTerrWorld * scale;
  vec3 c = vec3(0.0);
  if (w.y > 0.01) c += texture2D(tRock, p.xz).rgb * w.y;
  if (w.x > 0.01) c += texture2D(tRock, p.zy + 0.37).rgb * w.x;
  if (w.z > 0.01) c += texture2D(tRock, p.xy + 0.71).rgb * w.z;
  return c;
}
#ifndef TERRAIN_LITE
// Three neighbouring hex centres form a triangle. Each centre has a fixed transform:
// both sides of a triangle edge use the same two samples there, so no seam can appear.
vec3 terrHexColor(vec2 uv, vec2 dx, vec2 dy, int layer) {
  vec2 skew = vec2(uv.x - uv.y * 0.5773503, uv.y * 1.1547005) * 0.81;
  ivec2 cell = ivec2(floor(skew));
  vec2 f = fract(skew);
  bool upper = f.x + f.y > 1.0;
  ivec2 corner = upper ? cell + ivec2(1) : cell;
  vec3 w = upper ? vec3(f.x + f.y - 1.0, 1.0 - f.y, 1.0 - f.x)
                 : vec3(1.0 - f.x - f.y, f.x, f.y);
  // Emphasise the closest sample to keep the texture crisp inside each tile.
  w *= w * w;
  w /= w.x + w.y + w.z;
  vec3 color = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    ivec2 tile = i == 0 ? corner : cell + (i == 1 ? ivec2(1, 0) : ivec2(0, 1));
    uint seed = uint(tile.x) * 0x8da6b343u ^ uint(tile.y) * 0xd8163841u ^ 0xcb1ab31fu;
    seed = (seed ^ (seed >> 16u)) * 0x7feb352du;
    seed = (seed ^ (seed >> 15u)) * 0x846ca68bu;
    seed ^= seed >> 16u;
    vec2 offset = vec2(float(seed & 1023u), float((seed >> 10u) & 1023u)) / 1024.0;
    vec2 axis = (seed & 0x100000u) == 0u ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    axis *= (seed & 0x200000u) == 0u ? 1.0 : -1.0;
    mat2 rotation = mat2(axis, vec2(-axis.y, axis.x));
    vec2 p = rotation * uv + offset;
    // Gradients follow the rotation, never the discontinuous tile ID or random offset.
    vec2 gx = rotation * dx, gy = rotation * dy;
    vec3 sampleColor = layer < 0 ? textureGrad(tGrass, p, gx, gy).rgb
      : textureGrad(tLayers, vec3(p, float(layer)), gx, gy).rgb;
    color += sampleColor * w[i];
  }
  return color;
}
#endif
vec3 terrSurfaceColor(vec2 uv, vec2 dx, vec2 dy, int id) {
#ifndef TERRAIN_LITE
  if (T_HEX[id] > 0.5) return terrHexColor(uv, dx, dy, T_LAYER[id]);
#endif
  return textureGrad(tLayers, vec3(uv, float(T_LAYER[id])), dx, dy).rgb;
}
vec3 terrainColor() {
  vec2 suv = (vTerrWorld.xz + uWorldSize * 0.5) / uWorldSize;
  vec2 uv = vTerrWorld.xz * 0.5;
  vec2 duvX = dFdx(uv), duvY = dFdy(uv);
  // Local water: the sea, or a river's surface near its channel
  vec2 riverUv = (vTerrWorld.xz + uWorldSize * 0.5 + 0.5) / (uWorldSize + 1.0);
  vec3 river = texture2D(tRiver, riverUv).rgb;
  float estuarySand = river.b;
  float waterY = river.g > 0.5 ? max(uWaterLevel, river.r) : uWaterLevel;
  terrWaterY = waterY;
#ifdef TERRAIN_LITE
  // Analytic border noise instead of a second grass fetch
  float n = (sin(vTerrWorld.x * 0.37 + sin(vTerrWorld.z * 0.23) * 2.0) * sin(vTerrWorld.z * 0.41 + vTerrWorld.x * 0.11)) * 0.3;
#else
  float n = texture2D(tGrass, vTerrWorld.xz * 0.061).a - 0.5;
#endif
  // Surface layers, blended in two steps so a seam between two surfaces never lets the grass
  // through (each weight thresholded on its own used to drop both to ~0 mid-seam where the noise
  // dips, showing a green stripe):
  // 1. coverage: is there any surface here at all? The summed weight is ~1 across a seam between
  //    two surfaces, so only the edge against grass gets the ragged noisy border.
  // 2. which surface: the raw shares, jittered by the noise with opposite signs per layer (ragged
  //    seams between surfaces too) and sharpened, then renormalised to sum to 1.
  // The 4 cells around the pixel are read by id and weighted bilinearly here; equal ids merge,
  // so a pixel deals with at most 4 (usually 0-1) distinct surfaces, whatever the type count.
  vec2 tp = vTerrWorld.xz + uWorldSize * 0.5 - 0.5;
  vec2 tf = fract(tp);
  ivec2 t0 = ivec2(floor(tp));
  ivec2 tMax = ivec2(int(uWorldSize) - 1);
  ivec4 sIds = ivec4(0);
  vec4 sW = vec4(0.0);
  int sN = 0;
  ivec2 a = terrTileAt(t0, tMax);
  ivec2 b = terrTileAt(t0 + ivec2(1, 0), tMax);
  ivec2 cTile = terrTileAt(t0 + ivec2(0, 1), tMax);
  ivec2 d = terrTileAt(t0 + ivec2(1, 1), tMax);
  ivec2 cell = tf.y < 0.5 ? (tf.x < 0.5 ? a : b) : (tf.x < 0.5 ? cTile : d);
  int cellId = cell.x & ${PAVING_FLAG - 1};
  if (terrIsPaving(cell.x)) {
    // The curb and paving meet the cell boundary exactly.
    sIds.x = cellId;
    sW.x = 1.0;
    sN = 1;
  } else {
    // Give the nearest unpaved surface any paving weight crossing its edge.
    terrAddTile(terrIsPaving(a.x) ? cellId : a.x, (1.0 - tf.x) * (1.0 - tf.y), sIds, sW, sN);
    terrAddTile(terrIsPaving(b.x) ? cellId : b.x, tf.x * (1.0 - tf.y), sIds, sW, sN);
    terrAddTile(terrIsPaving(cTile.x) ? cellId : cTile.x, (1.0 - tf.x) * tf.y, sIds, sW, sN);
    terrAddTile(terrIsPaving(d.x) ? cellId : d.x, tf.x * tf.y, sIds, sW, sN);
  }
  vec3 paintedColor = vec3(0.0);
  float paintedCover = 0.0;
  vec3 sandColor = vec3(0.0);
  bool hasSandColor = false;
  // Weights of bare earth (rain darkens it, fallen snow melts on it) and of painted snow tiles
  float earthW = 0.0;
  float snowTileW = 0.0;
  float iceW = 0.0;
  float mudW = 0.0;
  float puddleW = 0.0;
  if (sN > 0) {
    float total = sW.x + sW.y + sW.z + sW.w;
    float cover = smoothstep(0.32, 0.68, total + n * 0.45);
    float invT = 1.0 / max(total, 1e-4);
    vec4 sp = vec4(0.0);
    float pSum = 0.0;
    for (int i = 0; i < 4; i++) {
      if (i >= sN) break;
      float pi = max(sW[i] * invT + T_JITTER[sIds[i]] * n, 0.0);
      pi *= pi;
      pi *= pi;
      sp[i] = pi;
      pSum += pi;
    }
    // Final weights, summing to cover. Overlay surfaces (snow) are laid on top later, so the
    // ground ones are renormalised among themselves: a snow / asphalt seam shows asphalt under the
    // thinning snow, never grass
    vec4 wt = sp * (cover / max(pSum, 1e-4));
    vec3 surf = vec3(0.0);
    float other = 0.0;
    for (int i = 0; i < 4; i++) {
      if (i >= sN) break;
      float w = wt[i];
      if (w < 0.001) continue;
      int id = sIds[i];
      earthW += w * T_EARTH[id];
      iceW += w * T_ICE[id];
      mudW += w * T_MUD[id];
      puddleW += w * T_PUDDLE[id];
      if (T_OVERLAY[id] > 0.5) {
        snowTileW += w;
        continue;
      }
      vec3 layerColor = terrSurfaceColor(uv, duvX, duvY, id);
      if (cell.y != 0) {
        layerColor = terrCurb(layerColor, id, cell.y, fract(tp + 0.5), uv, duvX, duvY);
      }
      if (id == ${TerrainTileType.SAND_BEACH}) {
        sandColor = layerColor;
        hasSandColor = true;
      }
      surf += layerColor * w;
      other += w;
    }
    if (other > 0.001) {
      paintedColor = surf / other;
      paintedCover = cover;
    }
  }
  // Sandy shore by the sea and in estuaries, a narrow gravel strip along rivers upstream
  float riverBank = smoothstep(0.35, 0.75, river.g) * smoothstep(0.12, 0.45, waterY - uWaterLevel) * (1.0 - estuarySand);
  // River gravel only hugs the water (the weight is 1 within ~2.5 m of the channel): flat
  // floodplains that happen to sit just above the water stay grass
  float beach = mix(1.0 - smoothstep(waterY + 0.15, waterY + 0.55, vTerrWorld.y),
    (1.0 - smoothstep(waterY + 0.08, waterY + 0.32, vTerrWorld.y)) * smoothstep(0.8, 0.97, river.g), riverBank);
  float bedSand = smoothstep(0.0, 0.08, waterY - vTerrWorld.y) * smoothstep(0.0, 0.8, river.g);
  if (!hasSandColor && (beach > 0.001 || bedSand > 0.0)) {
    sandColor = terrSurfaceColor(uv, duvX, duvY, ${TerrainTileType.SAND_BEACH});
  }
  // Skip the grass fetches where it is fully covered by a painted surface or shore sand.
  vec3 c = paintedColor;
  if (paintedCover < 1.0 && beach < 1.0) {
#ifdef TERRAIN_LITE
    vec3 grassColor = textureGrad(tGrass, uv, duvX, duvY).rgb;
#else
    vec3 grassColor = terrHexColor(uv, duvX, duvY, -1);
#endif
    c = mix(grassColor, paintedColor, paintedCover);
  }
  // Painted sand is already part of the surface blend above; the shore adds sand on top
  if (beach > 0.001) c = mix(c, sandColor, beach);
  float rock = smoothstep(0.8, 0.62, vTerrUpY);
  if (rock > 0.001) c = mix(c, rockTriplanar(0.5), rock);
  // Ice: a cold sky sheen, strongest at grazing angles (a cheap Fresnel instead of a reflection)
  if (iceW > 0.001) {
    float iceFres = 1.0 - max(dot(normalize(cameraPosition - vTerrWorld), normalize(vTerrN)), 0.0);
    iceFres *= iceFres * iceFres;
    c = mix(c, vec3(0.78, 0.88, 1.0), iceW * (1.0 - rock) * (0.1 + iceFres * 0.6));
  }
  // Damp soil: watered fields, and in the rain every patch of bare earth (the dirt layer) as one
  // surface; dark wet earth, a little mottled, under the snow
  // splatB.a: ground under a roof (greenhouse, house) stays dry in the rain and gets no snow
  vec2 wetDry = texture2D(tSplatB, suv).ba;
  float roofed = wetDry.y;
  float wet = max(wetDry.x, uRainWet * earthW * (1.0 - roofed));
  if (wet > 0.004) c = mix(c, vec3(0.0123, 0.0052, 0.003), wet * (0.82 + 0.36 * n));
  // Clip both painted and natural pools at the local shoreline, including blended tile edges.
  if (vTerrWorld.y <= waterY + ${PUDDLE_SHORE_CLEARANCE}) {
    puddleW = 0.0;
  } else if (uPuddleFill > 0.01) {
    // The CPU-built mask marks concave basins from terrain heights; read it only while wet.
    float autoPool = texture2D(tPuddleMask, suv).r * (1.0 - roofed) * smoothstep(0.02, 0.18, uPuddleFill);
    puddleW = max(puddleW, autoPool);
  }
  // Mud and puddle beds: footprints pressed in (dark, wet hollows), and a wet sheen of the sky,
  // brighter at grazing angles and in the rain
  float soft = (mudW + puddleW) * (1.0 - rock);
  // View angle terms: only worked out on mud / puddle pixels (everywhere else they stay unused)
  vec3 toEyeT = vec3(0.0, 1.0, 0.0);
  float fresT = 0.0;
  if (soft > 0.001) {
    toEyeT = normalize(cameraPosition - vTerrWorld);
    fresT = 1.0 - max(dot(toEyeT, normalize(vTerrN)), 0.0);
    fresT *= fresT * fresT;
    vec2 mtD = abs(vTerrWorld.xz - uSnowTrailC);
    float mtEdge = max(mtD.x, mtD.y);
    if (mtEdge < ${TRAIL_HALF.toFixed(2)}) {
      float pr = texture2D(uSnowTrail, vTerrWorld.xz / ${TRAIL_SIZE.toFixed(1)}).b * smoothstep(${TRAIL_HALF.toFixed(2)}, ${(TRAIL_HALF - 3).toFixed(2)}, mtEdge);
      // Pressed-in hollows: darker, and in the rain they hold a little water that catches the sky
      float prK = min(1.0, pr * 1.4) * soft;
      c = mix(c, c * 0.45, prK);
      c += vec3(0.16, 0.19, 0.23) * prK * uRainWet * (0.25 + fresT);
    }
    c = mix(c, vec3(0.16, 0.19, 0.23), soft * (0.02 + uRainWet * 0.06 + fresT * (0.12 + uRainWet * 0.22)));
  }
  // Puddles: water lies where the painted patch is deepest; the pool shrinks as it dries.
  if (puddleW > 0.001) {
    // Shape: the painted weight (deepest in the middle) broken up by finer noise, so a drying
    // puddle shrinks into a few separate pools
    float pn = texture2D(tGrass, vTerrWorld.xz * 0.23 + 0.31).a - 0.5;
    float depth = puddleW + pn * 0.9 + n * 0.3;
    float lvl = mix(1.12, 0.3, uPuddleFill);
    float water = smoothstep(lvl - 0.04, lvl + 0.04, depth) * (1.0 - rock);
    if (water > 0.001) {
      // Simulated waves (steps, splashes, rain drops) near the player: their slope tilts the
      // surface, so the sky's reflection brightens on one side of each crest and dims on the other
      vec2 simG = vec2(0.0);
      float simOn = 0.0;
      if (uWdSimArea.w > 0.5) {
        vec2 suvW = (vTerrWorld.xz - uWdSimArea.xy) * uWdSimArea.z;
        vec2 e2W = min(suvW, 1.0 - suvW);
        simOn = smoothstep(0.0, 0.15, min(e2W.x, e2W.y));
        if (simOn > 0.0) simG = textureLod(uWdSim, suvW, 0.0).ba * simOn * uWdSimLook.y;
      }
      vec3 nW = normalize(vec3(-simG.x, 1.0, -simG.y));
      vec3 viewW = normalize(cameraPosition - vTerrWorld);
      float fresW = 1.0 - max(dot(viewW, nW), 0.0);
      fresW *= fresW;
      // Reflect the view ray into the procedural sky. Two broad hashed cloud bands mimic the
      // sky dome at almost no cost; no screen-space reflection or extra render target is needed.
      vec3 reflectW = reflect(-viewW, nW);
      float skyH = clamp(reflectW.y, 0.0, 1.0);
      vec3 skyW = mix(uPuddleSkyH, uPuddleSkyZ, pow(skyH, 0.5));
      vec2 cloudUv = reflectW.xz / max(0.18, abs(reflectW.y) + 0.18);
      float cloudN = sin(cloudUv.x * 3.1 + cloudUv.y * 1.7) * sin(cloudUv.y * 2.6 - cloudUv.x * 1.2);
      float cloudMask = smoothstep(-0.18, 0.22, cloudN + (uPuddleCloudCover - 0.5) * 0.45);
      skyW = mix(skyW, mix(uPuddleCloudShade, uPuddleCloud, smoothstep(0.3, 0.9, skyH)), cloudMask * uPuddleCloudCover);
      float sunReflection = pow(max(dot(reflectW, normalize(uPuddleSunDir)), 0.0), 96.0);
      skyW += uPuddleSunColor * sunReflection * 0.75;
      float ripple = 0.0;
      // Drawn rain rings only where the simulation isn't running (it drops its own)
      if (uRainFall > 0.02 && simOn < 0.999) {
        // Rings from drops: one per 0.33 m cell, at a random spot and phase, sparser in light rain
        for (int k = 0; k < 2; k++) {
          vec2 rp = vTerrWorld.xz * 3.0 + float(k) * vec2(0.5, 0.37);
          vec2 ci = floor(rp);
          float h1 = fract(sin(dot(ci, vec2(127.1, 311.7)) + float(k) * 7.0) * 43758.5453);
          float h2 = fract(h1 * 91.7);
          vec2 f = fract(rp) - 0.5 - (vec2(h1, h2) - 0.5) * 0.4;
          float ph = fract(uTerrTime * 1.4 + h1 * 3.0);
          float r = length(f);
          ripple += smoothstep(0.1, 0.02, abs(r - 0.04 - ph * 0.42)) * (1.0 - ph) * step(h2, uRainFall * 0.55);
        }
        ripple *= 1.0 - simOn;
      }
      float simShade = clamp(dot(simG, vec2(0.55, 0.45)) * 0.6, -0.35, 0.35);
      // (linear colours: the sky's reflection is dimmer than it looks in sRGB)
      vec3 sky = skyW;
      vec3 waterC = mix(c * 0.72, sky, 0.16 + fresW * 0.34) + sky * (ripple * 0.28 + simShade * 0.3);
      waterC = max(waterC, vec3(0.0));
      // Keep the ground clearly visible through shallow water; reflection stays a soft highlight.
      c = mix(c, waterC, water * mix(0.3, 0.48, uPuddleFill) * smoothstep(0.015, 0.12, uPuddleFill));
    }
  }
  // Snow: settles last, but never on rocky slopes (weight fades with the rock mask) and melts
  // into slush at the waterline. Drifts (macro noise) are bright, hollows take a cold blue tint,
  // and sparse view-dependent glints twinkle as the camera moves.
  // Fallen snow from the weather: the drift noise decides where it settles first, so a light
  // dusting shows as patches that join up as it deepens (no extra texture fetches)
  // Bare earth (fields, dirt paths) stays dark: the snow melts on tilled soil and trodden tracks
  float snowW = uSnowCover > 0.001 ? max(snowTileW, smoothstep(0.0, 0.3, uSnowCover * 1.6 - 0.55 + n * 1.2) * (1.0 - earthW) * (1.0 - roofed)) : snowTileW;
  if (snowW > 0.001) {
    float sw = snowW * (1.0 - rock) * smoothstep(waterY + 0.05, waterY + 0.35, vTerrWorld.y);
    float drift = clamp(n * 2.2 + 0.5, 0.0, 1.0);
#ifdef TERRAIN_LITE
    vec3 snow = mix(vec3(0.76, 0.84, 0.94), vec3(1.0, 1.0, 1.02), drift);
    snow = mix(snow, vec3(0.70, 0.78, 0.90), smoothstep(0.97, 0.75, vTerrUpY) * 0.5);
#else
    vec3 sTex = texture(tLayers, vec3(uv * 0.5, ${SNOW_LAYER}.0)).rgb;
    vec3 snow = mix(vec3(0.74, 0.82, 0.93), vec3(1.0, 1.0, 1.02), drift) * mix(0.93, 1.04, sTex.g);
    snow = mix(snow, vec3(0.70, 0.78, 0.90), smoothstep(0.97, 0.75, vTerrUpY) * 0.5);
    // Fine crystal grid (~3.5cm cells); each glint is a small round dot, not the whole cell
    vec2 gp = vTerrWorld.xz * 28.0;
    vec2 cell = floor(gp);
    float h = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
    vec2 off = vec2(h, fract(h * 17.31)) * 0.5 + 0.25;
    float dotM = smoothstep(0.3, 0.1, length(fract(gp) - off));
    vec3 toCam = cameraPosition - vTerrWorld;
    float tw = fract(sin(dot(cell + floor(toCam.xz * 2.5 + toCam.y), vec2(269.5, 183.3))) * 17853.13);
    float glint = step(0.9, h) * step(0.6, tw) * dotM * smoothstep(28.0, 5.0, length(toCam));
    snow += glint * 1.1;
#endif
    // Footprints: trodden snow is packed down and sits in shadow (one fetch, only near the player)
    vec2 stD = abs(vTerrWorld.xz - uSnowTrailC);
    float stEdge = max(stD.x, stD.y);
    if (stEdge < ${TRAIL_HALF.toFixed(2)}) {
      float pr = texture2D(uSnowTrail, vTerrWorld.xz / ${TRAIL_SIZE.toFixed(1)}).b * smoothstep(${TRAIL_HALF.toFixed(2)}, ${(TRAIL_HALF - 3).toFixed(2)}, stEdge);
      snow = mix(snow, snow * vec3(0.52, 0.6, 0.76), min(1.0, pr * 1.3));
    }
    c = mix(c, snow, sw);
  }
  // Submerged channels and lakes use the same sand sample as the shore and painted sand.
  if (bedSand > 0.0) c = mix(c, sandColor, bedSand);
  c *= mix(1.0, 0.62, smoothstep(waterY, waterY - 1.5, vTerrWorld.y));
  return c;
}`
        )
        .replace('#include <map_fragment>', 'diffuseColor.rgb *= terrainColor();')
        // Baked static shadows dim the sun / moon; a little contact darkening of the sky light too
        .replace(
          '#include <lights_fragment_end>',
          '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= 1.0 - vShade;\nreflectedLight.indirectDiffuse *= 1.0 - vShade * 0.3;\n' +
            // Sea floor and river beds: the sun's caustics (and the shade of duckweed above)
            'reflectedLight.directDiffuse *= causticsSun(vTerrWorld, terrWaterY, vTerrUpY);'
        );
    };
    return withVertexLightingQuality(mat);
  }

  // ---------------------------------------------------------------- physics

  private rebuildDirtyColliders(): void {
    const { rapier, world } = this.physics;
    if (!this.body) this.body = world.createRigidBody(rapier.RigidBodyDesc.fixed());
    const S = CHUNK + 1;
    const data = new Float32Array(S * S);
    const groups = this.physics.packCollisionGroups(COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.TERRAIN, 0xffff);
    for (const c of this.physicsDirtyChunks) {
      const cx = c % CHUNKS;
      const cz = (c - cx) / CHUNKS;
      const old = this.chunkColliders[c];
      if (old) world.removeCollider(old, false);
      // Rapier heightfields are column-major with columns along X, centred on the collider
      for (let x = 0; x < S; x++) {
        for (let z = 0; z < S; z++) data[x * S + z] = this.heights[(cz * CHUNK + z) * V + cx * CHUNK + x];
      }
      this.chunkColliders[c] = world.createCollider(
        rapier.ColliderDesc.heightfield(CHUNK, CHUNK, data, { x: CHUNK, y: 1, z: CHUNK })
          .setTranslation(cx * CHUNK + CHUNK / 2 - WORLD_HALF, 0, cz * CHUNK + CHUNK / 2 - WORLD_HALF)
          .setFriction(0.9)
          .setCollisionGroups(groups),
        this.body
      );
    }
    this.physicsDirtyChunks.clear();
  }

  /** Sea bed under the open sea, and invisible walls far out in it so nothing leaves the world. */
  private createWorldBounds(): void {
    const s = WORLD_LIMIT * 2;
    this.physics.createStaticBox(new THREE.Vector3(0, SEA_BED_TOP - 0.5, 0), new THREE.Vector3(s, 1, s));
    const h = 60;
    const t = 1;
    const walls: [number, number, number, number][] = [
      [0, -WORLD_LIMIT - t / 2, s + 2 * t, t],
      [0, WORLD_LIMIT + t / 2, s + 2 * t, t],
      [-WORLD_LIMIT - t / 2, 0, t, s + 2 * t],
      [WORLD_LIMIT + t / 2, 0, t, s + 2 * t],
    ];
    for (const [x, z, sx, sz] of walls) {
      this.physics.createStaticBox(new THREE.Vector3(x, h / 2 - 13, z), new THREE.Vector3(sx, h, sz));
    }
  }

  // ---------------------------------------------------------------- save / load

  /** Bumped by every height or tile edit: the autosave reuses the last encoding while it's unchanged. */
  private saveEdits = 0;
  private saveCache: { edits: number; data: TerrainSaveData } | null = null;

  /** For code that writes `heights` / `tiles` directly (editor undo) before serializing. */
  public invalidateSaveCache(): void {
    this.saveEdits++;
  }

  public serialize(): TerrainSaveData {
    // Encoding is ~0.5 M cells of diff + RLE (tens of ms and MBs of garbage on a phone) for a world
    // that usually hasn't been sculpted since the last autosave
    if (this.saveCache?.edits === this.saveEdits) return this.saveCache.data;
    const data = this.encode();
    this.saveCache = { edits: this.saveEdits, data };
    return data;
  }

  private encode(): TerrainSaveData {
    const base = TerrainSystem.base();
    const dh = new Int16Array(V * V);
    for (let i = 0; i < dh.length; i++) dh[i] = Math.round((this.heights[i] - this.riverCuts[i]) * 100) - base.heights[i];
    const dt = new Int16Array(N * N);
    for (let i = 0; i < dt.length; i++) dt[i] = this.tiles[i];
    return { size: N, enc: 'd2', heights: rleEncode(dh), tiles: rleEncode(dt) };
  }

  /** True when the last load placed an older, smaller world in the island's centre. */
  public expandedFromLegacy = false;

  public deserialize(data: TerrainSaveData): void {
    this.expandedFromLegacy = false;
    const base = TerrainSystem.base();
    if ((data.enc === 'd1' || data.enc === 'd2') && data.size > 0 && data.size <= 2048) {
      const s = data.size;
      const sv = s + 1;
      const dh = rleDecode(data.heights, sv * sv);
      const dt = rleDecode(data.tiles, s * s);
      const copySize = Math.min(s, N);
      const sourceOffset = Math.floor((s - copySize) / 2);
      const targetOffset = Math.floor((N - copySize) / 2);
      const rebaseUnderwater = data.enc === 'd1' || s > N;
      // Keep the center of expanded saves when shrinking the map, and center older smaller saves
      // when growing it. This preserves the island's world coordinates in either direction.
      this.heights.set(base.heights);
      this.tiles.set(base.tiles);
      for (let z = 0; z <= copySize; z++) {
        for (let x = 0; x <= copySize; x++) {
          const oldIndex = (z + sourceOffset) * sv + x + sourceOffset;
          const newIndex = (z + targetOffset) * V + x + targetOffset;
          const generated = base.heights[newIndex];
          this.heights[newIndex] = rebaseUnderwater
            ? this.rebaseLegacySeabed(generated, dh[oldIndex], x + targetOffset - N / 2, z + targetOffset - N / 2)
            : (generated + dh[oldIndex]) / 100;
        }
      }
      for (let z = 0; z < copySize; z++) {
        for (let x = 0; x < copySize; x++) {
          this.tiles[(z + targetOffset) * N + x + targetOffset] = sanitizeTile(dt[(z + sourceOffset) * s + x + sourceOffset]);
        }
      }
      this.expandedFromLegacy = s < N;
    } else if (!data.enc && data.size <= N) {
      this.loadLegacy(data, base);
    } else {
      return;
    }
    this.riverCuts.fill(0);
    this.recutTerrainRivers();
    this.markHeightsDirty(0, 0, N, N);
    this.markSplatDirty(0, 0, N - 1, N - 1);
    this.commit();
  }

  /** Old raw saves store the whole old square, including its flat -11 m seabed. */
  private loadLegacy(data: TerrainSaveData, base: { heights: Int16Array; tiles: Uint8Array }): void {
    const s = data.size;
    const sv = s + 1;
    const o = (N - s) / 2;
    const cm = new Int16Array(fromBase64(data.heights).buffer);
    const oldTiles = fromBase64(data.tiles);
    // The old square ended on a flat -11 m seabed. Extending its edge values outward (or keeping
    // them at all) stamps a visible square shelf into the expanded ocean. Retain the saved land
    // and shoreline, then smoothly hand submerged cells back to the new generated seabed.
    const LEGACY_SEA_FLOOR = -11;
    const SHORE_HANDOFF_DEPTH = -0.6;
    const EDGE_FADE = 24;
    for (let iz = 0; iz <= N; iz++) {
      for (let ix = 0; ix <= N; ix++) {
        const lx = ix - o;
        const lz = iz - o;
        const cx = Math.min(s, Math.max(0, lx));
        const cz = Math.min(s, Math.max(0, lz));
        const old = (cm[cz * sv + cx] ?? 0) / 100;
        const inside = lx >= 0 && lx <= s && lz >= 0 && lz <= s;
        let keepOld = inside ? 1 : 0;
        if (inside && s < N) {
          const edgeDistance = Math.min(lx, s - lx, lz, s - lz);
          const fadesFromEdge = THREE.MathUtils.smoothstep(edgeDistance, 0, EDGE_FADE);
          const fadesBelowShore = THREE.MathUtils.smoothstep(old, LEGACY_SEA_FLOOR, SHORE_HANDOFF_DEPTH);
          keepOld *= fadesFromEdge * fadesBelowShore;
        }
        const generated = base.heights[iz * V + ix] / 100;
        this.heights[iz * V + ix] = generated + (old - generated) * keepOld;
      }
    }
    this.tiles.set(base.tiles);
    for (let z = 0; z < s; z++) {
      for (let x = 0; x < s; x++) this.tiles[(z + o) * N + x + o] = sanitizeTile(oldTiles[z * s + x] ?? TerrainTileType.GRASS);
    }
    this.expandedFromLegacy = s < N;
  }

  /**
   * Early expanded-world saves baked the old square -11 m shelf into their d1 deltas. Keep saved
   * land and the shallow shoreline, but fade those legacy underwater deltas back to the generated
   * seabed by distance from the natural coast. New d2 saves load exactly and are not rebased again.
   */
  private rebaseLegacySeabed(generatedCm: number, deltaCm: number, x: number, z: number): number {
    const generated = generatedCm / 100;
    const saved = (generatedCm + deltaCm) / 100;
    if (saved >= worldSettings.waterLevel) return saved;
    const offshore = Math.hypot(x, z) - coastRadius(x, z);
    const fade = THREE.MathUtils.smoothstep(offshore, 8, 90);
    return generated + (saved - generated) * (1 - fade);
  }
}

// ------------------------------------------------------------------ helpers

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Run-length encoding as Int16 (count, value) pairs, base64. */
function rleEncode(values: Int16Array): string {
  const out: number[] = [];
  let i = 0;
  while (i < values.length) {
    const v = values[i];
    let n = 1;
    while (i + n < values.length && values[i + n] === v && n < 32767) n++;
    out.push(n, v);
    i += n;
  }
  return toBase64(new Uint8Array(new Int16Array(out).buffer));
}

function rleDecode(b64: string, length: number): Int16Array {
  const bytes = fromBase64(b64);
  const pairs = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const out = new Int16Array(length);
  let k = 0;
  for (let i = 0; i + 1 < pairs.length && k < length; i += 2) {
    out.fill(pairs[i + 1], k, Math.min(length, k + pairs[i]));
    k += pairs[i];
  }
  return out;
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Seamless 2 m x 2 m surface texture per tile type (alpha channel of grass = macro noise). */
// ---------------------------------------------------------------- surface layers

/** Every surface type drawn from the texture array (all but grass, the base), in layer order. */
const SURFACE_TILES = (Object.keys(TILE_DEFINITIONS).map(Number) as TerrainTileType[]).filter(
  (t) => t !== TerrainTileType.GRASS
);

/**
 * Shader traits per surface type. `jitter`: how the border noise pushes this layer's share
 * (neighbouring types with opposite signs make the seam between them ragged; defaults cycle
 * through +-0.45 / +-0.3). `earth`: bare soil, darkened by rain, fallen snow melts on it.
 * `overlay`: laid over the other surfaces afterwards with its own look (snow). `ice`: a glossy sheen. `mud`: wet sheen and footprints. `puddle`: like mud, plus water that
 * fills and dries with the rain. A new type needs
 * only a TerrainTileType + TILE_DEFINITIONS entry (+ a pattern in createLayerTexture); add it here
 * only if it needs one of these traits.
 */
const SURFACE_TRAITS: Partial<Record<TerrainTileType, { jitter?: number; earth?: boolean; overlay?: boolean; ice?: boolean; mud?: boolean; puddle?: boolean }>> = {
  [TerrainTileType.DIRT_ROAD]: { jitter: 0.45, earth: true },
  [TerrainTileType.ASPHALT_ROAD]: { jitter: -0.45 },
  [TerrainTileType.STONE_COBBLE]: { jitter: 0.3 },
  [TerrainTileType.SIDEWALK_PAVERS]: { jitter: 0.12 },
  [TerrainTileType.CLINKER_HERRINGBONE]: { jitter: 0.18 },
  [TerrainTileType.GRANITE_SETTS]: { jitter: 0.28 },
  [TerrainTileType.SANDSTONE_FLAGSTONE]: { jitter: 0.32 },
  [TerrainTileType.LIMESTONE_PAVERS]: { jitter: 0.12 },
  [TerrainTileType.SAND_BEACH]: { jitter: -0.3 },
  [TerrainTileType.SNOW]: { jitter: 0, overlay: true },
  [TerrainTileType.ICE]: { ice: true },
  [TerrainTileType.MUD]: { earth: true, mud: true },
  [TerrainTileType.PUDDLE]: { earth: true, puddle: true },
};

const SNOW_LAYER = SURFACE_TILES.indexOf(TerrainTileType.SNOW);
const CURB_LAYER = SURFACE_TILES.length;

/** GLSL lookup tables indexed by tile id (layer, jitter, traits) and the tile fetch helpers. */
const SURFACE_GLSL = (() => {
  const count = Math.max(...SURFACE_TILES, 0) + 1;
  const layer: number[] = new Array(count).fill(-1);
  const jitter: number[] = new Array(count).fill(0);
  const earth: number[] = new Array(count).fill(0);
  const overlay: number[] = new Array(count).fill(0);
  const ice: number[] = new Array(count).fill(0);
  const mud: number[] = new Array(count).fill(0);
  const puddle: number[] = new Array(count).fill(0);
  const hex: number[] = new Array(count).fill(0);
  const curbLayer: number[] = new Array(count).fill(-1);
  PAVING_TYPES.forEach((type, i) => { curbLayer[type] = CURB_LAYER + i; });
  const cycle = [0.45, -0.45, 0.3, -0.3];
  SURFACE_TILES.forEach((t, i) => {
    const tr = SURFACE_TRAITS[t] ?? {};
    layer[t] = i;
    jitter[t] = tr.jitter ?? cycle[i % cycle.length];
    earth[t] = tr.earth ? 1 : 0;
    overlay[t] = tr.overlay ? 1 : 0;
    ice[t] = tr.ice ? 1 : 0;
    mud[t] = tr.mud ? 1 : 0;
    puddle[t] = tr.puddle ? 1 : 0;
    hex[t] = GRASSY_TILES.has(t) || tr.earth || t === TerrainTileType.SAND_BEACH ? 1 : 0;
  });
  const f = (v: number[]) => v.map((x) => x.toFixed(3)).join(', ');
  return `
#define TERR_TILE_N ${count}
const int T_LAYER[${count}] = int[${count}](${layer.join(', ')});
const float T_JITTER[${count}] = float[${count}](${f(jitter)});
const float T_EARTH[${count}] = float[${count}](${f(earth)});
const float T_OVERLAY[${count}] = float[${count}](${f(overlay)});
const float T_ICE[${count}] = float[${count}](${f(ice)});
const float T_MUD[${count}] = float[${count}](${f(mud)});
const float T_PUDDLE[${count}] = float[${count}](${f(puddle)});
const int T_CURB_LAYER[${count}] = int[${count}](${curbLayer.join(', ')});
#ifndef TERRAIN_LITE
const float T_HEX[${count}] = float[${count}](${f(hex)});
#endif
ivec2 terrTileAt(ivec2 p, ivec2 tMax) {
  return ivec2(texelFetch(tTiles, clamp(p, ivec2(0), tMax), 0).rg * 255.0 + 0.5);
}
bool terrIsPaving(int tileCode) {
  return (tileCode & ${PAVING_FLAG}) != 0;
}
vec3 terrCurb(vec3 base, int id, int mask, vec2 p, vec2 stoneUv, vec2 dx, vec2 dy) {
  const float width = 0.17;
  const float shadowReach = 0.055;
  bool west = p.x < 0.5;
  bool north = p.y < 0.5;
  vec2 q = vec2(west ? p.x : 1.0 - p.x, north ? p.y : 1.0 - p.y);
  bool sideX = (mask & (west ? 8 : 2)) != 0;
  bool sideZ = (mask & (north ? 1 : 4)) != 0;
  int insideCorner = north ? (west ? 16 : 32) : (west ? 128 : 64);
  bool concave = (mask & insideCorner) != 0;
  float ex = sideX ? q.x : 1.0;
  float ez = sideZ ? q.y : 1.0;
  float faceDist = concave ? length(q) : min(ex, ez);
  float dist = faceDist;
  // The texture repeats every two metres; convert its gradients back to cell units for AA.
  float aa = clamp(max(length(dx), length(dy)) * 1.10, 0.002, width * 0.45);

  bool convex = sideX && sideZ;
  const float block = 1.0 / 3.0;
  if (convex && max(q.x, q.y) < block) {
    // A single rounded corner block, tangent to the two straight runs.
    dist = block - length(max(vec2(block) - q, vec2(0.0)));
  }
  if (dist >= width + max(aa, shadowReach)) return base;
  // Reuse the curb contour so the falloff follows both kinds of corner.
  float contactShade = 1.0 - smoothstep(0.0, shadowReach, dist - width);
  base *= 1.0 - 0.24 * contactShade;
  if (dist >= width + aa) return base;
  float alpha = 1.0 - smoothstep(width - aa, width + aa, dist);
  float along = sideX ? p.y : p.x;
  float jointDist = abs(fract(along * 3.0 + 0.5) - 0.5) * block;
  if (convex) jointDist = abs(max(q.x, q.y) - block);
  if (concave) jointDist = min(q.x, q.y);
  float joint = 1.0 - smoothstep(0.003, 0.010 + aa * 0.45, jointDist);
  joint *= 1.0 - smoothstep(0.030, 0.095, aa);
  float outerShade = 1.0 - smoothstep(0.0, 0.023, faceDist);
  float innerShade = smoothstep(width - 0.032, width, dist);
  float rim = smoothstep(0.008, 0.030, faceDist) * (1.0 - smoothstep(0.030, 0.062, faceDist));
  // World-space UVs never flip or rotate on the corner diagonal.
  vec3 stone = textureGrad(tLayers, vec3(stoneUv, float(T_CURB_LAYER[id])), dx, dy).rgb;
  stone *= 1.0 + 0.11 * rim - 0.13 * outerShade - 0.17 * innerShade - 0.30 * joint;
  return mix(base, stone, alpha);
}
// Accumulates a cell's bilinear weight per distinct surface (grass and unknown ids are skipped)
void terrAddTile(int id, float w, inout ivec4 ids, inout vec4 ws, inout int cnt) {
  if (id <= 0 || id >= TERR_TILE_N || w <= 0.0) return;
  if (T_LAYER[id] < 0) return;
  for (int i = 0; i < 4; i++) {
    if (i < cnt && ids[i] == id) {
      ws[i] += w;
      return;
    }
  }
  ids[cnt] = id;
  ws[cnt] = w;
  cnt++;
}`;
})();

/**
 * All surface textures in one texture array (layer i = SURFACE_TILES[i]): one texture unit for any
 * number of surface types, instead of one sampler each (WebGL2 guarantees only 16 per shader).
 */
function createSurfaceArray(): THREE.DataArrayTexture {
  const size = 128;
  const layerBytes = size * size * 4;
  const layerCount = CURB_LAYER + PAVING_TYPES.length;
  const data = new Uint8Array(layerBytes * layerCount);
  SURFACE_TILES.forEach((t, i) => {
    const tex = createLayerTexture(t);
    const canvas = tex.image as HTMLCanvasElement;
    data.set(canvas.getContext('2d')!.getImageData(0, 0, size, size).data, i * layerBytes);
    tex.dispose();
  });
  const curbCanvas = document.createElement('canvas');
  curbCanvas.width = curbCanvas.height = size;
  const curb = curbCanvas.getContext('2d')!;
  PAVING_TYPES.forEach((type, i) => {
    paintCurbTexture(curb, size, type);
    data.set(curb.getImageData(0, 0, size, size).data, (CURB_LAYER + i) * layerBytes);
  });
  const arr = new THREE.DataArrayTexture(data, size, size, layerCount);
  arr.format = THREE.RGBAFormat;
  arr.type = THREE.UnsignedByteType;
  arr.colorSpace = THREE.SRGBColorSpace;
  arr.wrapS = arr.wrapT = THREE.RepeatWrapping;
  arr.magFilter = THREE.LinearFilter;
  arr.minFilter = THREE.LinearMipmapLinearFilter;
  arr.generateMipmaps = true;
  arr.anisotropy = 4;
  arr.needsUpdate = true;
  return arr;
}

function createLayerTexture(type: TerrainTileType): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const def = TILE_DEFINITIONS[type];
  ctx.fillStyle = def.primaryColor;
  ctx.fillRect(0, 0, size, size);
  let seed = type * 9973 + 17;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const wrapRect = (x: number, y: number, w: number, h: number) => {
    for (const ox of [0, -size]) for (const oy of [0, -size]) ctx.fillRect(x + ox, y + oy, w, h);
  };
  /** Draws a shape around (x, y) on all sides it may cross, so the tile stays seamless. */
  const wrapShape = (x: number, y: number, draw: () => void) => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.save();
        ctx.translate(x + ox, y + oy);
        draw();
        ctx.restore();
      }
    }
  };
  const ellipse = (x: number, y: number, rx: number, ry: number, rot: number) => {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    ctx.fill();
  };
  switch (type) {
    case TerrainTileType.GRASS:
    case TerrainTileType.FLOWER_GRASS: {
      // The flowered meadow repeats the base's blades stroke for stroke (same seed and colours),
      // so its border against plain grass never shows: only the flowers differ
      seed = TerrainTileType.GRASS * 9973 + 17;
      for (let i = 0; i < 2200; i++) {
        ctx.fillStyle = rnd() < 0.5 ? def.secondaryColor : def.accentColor;
        ctx.globalAlpha = 0.35 + rnd() * 0.4;
        wrapRect(rnd() * size, rnd() * size, 2, 4 + rnd() * 4);
      }
      if (type === TerrainTileType.FLOWER_GRASS) {
        // Small white five-petal flowers with a yellow eye, a few alone, most in loose clusters
        seed = type * 9973 + 17;
        const flower = (r: number, a: number) => {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = '#1f3d18';
          ellipse(0.8, 1, r * 1.9, r * 1.6, 0); // a soft shadow on the grass
          ctx.globalAlpha = 0.95;
          for (let k = 0; k < 5; k++) {
            const pa = a + (k / 5) * Math.PI * 2;
            ctx.fillStyle = k % 2 ? '#f4f6ee' : '#fdfdf8';
            ellipse(Math.cos(pa) * r, Math.sin(pa) * r, r * 0.95, r * 0.6, pa);
          }
          ctx.fillStyle = '#e8c03a';
          ellipse(0, 0, r * 0.5, r * 0.5, 0);
        };
        for (let c = 0; c < 22; c++) {
          const cx = rnd() * size, cy = rnd() * size;
          const n = rnd() < 0.3 ? 1 : 2 + ((rnd() * 4) | 0);
          for (let i = 0; i < n; i++) {
            const d = i === 0 ? 0 : 5 + rnd() * 14, da = rnd() * Math.PI * 2;
            const r = 1.6 + rnd() * 1.3, a = rnd() * Math.PI;
            wrapShape(cx + Math.cos(da) * d, cy + Math.sin(da) * d, () => flower(r, a));
          }
        }
      }
      break;
    }
    case TerrainTileType.STONE_COBBLE:
    case TerrainTileType.SIDEWALK_PAVERS:
    case TerrainTileType.CLINKER_HERRINGBONE:
    case TerrainTileType.GRANITE_SETTS:
    case TerrainTileType.SANDSTONE_FLAGSTONE:
    case TerrainTileType.LIMESTONE_PAVERS:
      paintPavingTexture(ctx, size, type);
      break;

    case TerrainTileType.SNOW:
      // Soft wind-blown ripples and fine crystals; the shader adds drifts, blue shade and glints
      for (let i = 0; i < 90; i++) {
        ctx.fillStyle = rnd() < 0.5 ? def.secondaryColor : def.accentColor;
        ctx.globalAlpha = 0.18 + rnd() * 0.2;
        wrapRect(rnd() * size, rnd() * size, 30 + rnd() * 60, 3 + rnd() * 5);
      }
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = rnd() < 0.7 ? def.accentColor : def.secondaryColor;
        ctx.globalAlpha = 0.3 + rnd() * 0.4;
        wrapRect(rnd() * size, rnd() * size, 1, 1);
      }
      break;
    case TerrainTileType.DRY_GRASS:
    case TerrainTileType.BIRCH_GRASS: {
      // Blade strokes like the grass base (dry: a few pale straws and bare patches between)
      const dry = type === TerrainTileType.DRY_GRASS;
      for (let i = 0; i < 2400; i++) {
        ctx.fillStyle = rnd() < 0.5 ? def.secondaryColor : def.accentColor;
        ctx.globalAlpha = 0.35 + rnd() * 0.4;
        wrapRect(rnd() * size, rnd() * size, 2, 4 + rnd() * 5);
      }
      if (dry) {
        for (let i = 0; i < 40; i++) {
          ctx.fillStyle = '#7d6a3c';
          ctx.globalAlpha = 0.2 + rnd() * 0.2;
          wrapShape(rnd() * size, rnd() * size, () => ellipse(0, 0, 8 + rnd() * 16, 5 + rnd() * 10, rnd() * Math.PI));
        }
        for (let i = 0; i < 260; i++) {
          ctx.fillStyle = '#e2d28e';
          ctx.globalAlpha = 0.5 + rnd() * 0.3;
          wrapRect(rnd() * size, rnd() * size, 1, 5 + rnd() * 6);
        }
      }
      break;
    }
    case TerrainTileType.FALLEN_LEAVES: {
      // Overlapping leaves in autumn colours over dark forest litter, each with a midrib
      const colours = ['#a8441f', '#c8622a', '#d9922f', '#e2b23a', '#8a3a1c', '#6e4a22', '#b07a2c', '#9c5a24'];
      for (let i = 0; i < 520; i++) {
        const x = rnd() * size, y = rnd() * size;
        const l = 6 + rnd() * 9, w = l * (0.4 + rnd() * 0.25), a = rnd() * Math.PI * 2;
        ctx.globalAlpha = 0.85 + rnd() * 0.15;
        ctx.fillStyle = colours[(rnd() * colours.length) | 0];
        wrapShape(x, y, () => ellipse(0, 0, l, w, a));
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = '#4a2a12';
        ctx.lineWidth = 0.8;
        wrapShape(x, y, () => {
          ctx.beginPath();
          ctx.moveTo(-Math.cos(a) * l, -Math.sin(a) * l);
          ctx.lineTo(Math.cos(a) * l, Math.sin(a) * l);
          ctx.stroke();
        });
      }
      break;
    }
    case TerrainTileType.GRAVEL: {
      // Packed small stones: each one a shaded pebble with a lit top-left and a dark rim
      const tones = ['#9a958b', '#7f7a71', '#b1aca1', '#6c675f', '#8e8a84', '#a39a8a'];
      for (let i = 0; i < 1500; i++) {
        const x = rnd() * size, y = rnd() * size;
        const r = 1.5 + rnd() * 3.2, a = rnd() * Math.PI;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#4a4640';
        wrapShape(x + 0.8, y + 0.9, () => ellipse(0, 0, r * 1.15, r * 0.85, a));
        ctx.fillStyle = tones[(rnd() * tones.length) | 0];
        wrapShape(x, y, () => ellipse(0, 0, r * 1.1, r * 0.8, a));
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#d4cfc4';
        wrapShape(x - r * 0.3, y - r * 0.3, () => ellipse(0, 0, r * 0.45, r * 0.3, a));
      }
      break;
    }
    case TerrainTileType.ICE: {
      // Clear ice: soft deep and pale patches, frozen bubbles, long white cracks
      for (let i = 0; i < 30; i++) {
        ctx.fillStyle = rnd() < 0.5 ? def.secondaryColor : def.accentColor;
        ctx.globalAlpha = 0.15 + rnd() * 0.2;
        wrapShape(rnd() * size, rnd() * size, () => ellipse(0, 0, 20 + rnd() * 50, 12 + rnd() * 30, rnd() * Math.PI));
      }
      for (let i = 0; i < 120; i++) {
        ctx.fillStyle = '#f2f9fd';
        ctx.globalAlpha = 0.3 + rnd() * 0.4;
        const r = 0.6 + rnd() * 1.4;
        wrapShape(rnd() * size, rnd() * size, () => ellipse(0, 0, r, r, 0));
      }
      ctx.strokeStyle = '#f4fbff';
      for (let i = 0; i < 14; i++) {
        const x = rnd() * size, y = rnd() * size;
        let a = rnd() * Math.PI * 2;
        ctx.globalAlpha = 0.35 + rnd() * 0.35;
        ctx.lineWidth = 0.6 + rnd() * 0.8;
        const pts: [number, number][] = [[0, 0]];
        let px = 0, py = 0;
        for (let k = 0; k < 6; k++) {
          a += (rnd() - 0.5) * 1.1;
          const step = 6 + rnd() * 14;
          px += Math.cos(a) * step;
          py += Math.sin(a) * step;
          pts.push([px, py]);
        }
        wrapShape(x, y, () => {
          ctx.beginPath();
          ctx.moveTo(0, 0);
          for (const [qx, qy] of pts) ctx.lineTo(qx, qy);
          ctx.stroke();
        });
      }
      break;
    }
    case TerrainTileType.MUD:
    case TerrainTileType.PUDDLE: {
      // Churned wet earth: soft lumps with a lit rim, darker wet hollows, a few small stones
      for (let i = 0; i < 60; i++) {
        ctx.fillStyle = rnd() < 0.5 ? '#2c2016' : def.accentColor;
        ctx.globalAlpha = 0.25 + rnd() * 0.25;
        wrapShape(rnd() * size, rnd() * size, () => ellipse(0, 0, 10 + rnd() * 26, 6 + rnd() * 16, rnd() * Math.PI));
      }
      for (let i = 0; i < 700; i++) {
        const x = rnd() * size, y = rnd() * size, r = 1.5 + rnd() * 4, a = rnd() * Math.PI;
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = def.secondaryColor;
        wrapShape(x + 0.7, y + 0.8, () => ellipse(0, 0, r, r * 0.7, a));
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = def.accentColor;
        wrapShape(x, y, () => ellipse(0, 0, r * 0.8, r * 0.55, a));
      }
      for (let i = 0; i < 90; i++) {
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = rnd() < 0.5 ? '#6f665a' : '#857b6c';
        const r = 0.8 + rnd() * 1.6;
        wrapShape(rnd() * size, rnd() * size, () => ellipse(0, 0, r, r * 0.8, 0));
      }
      break;
    }
    case TerrainTileType.ASPHALT_ROAD:
      for (let i = 0; i < 3000; i++) {
        ctx.fillStyle = rnd() < 0.5 ? def.secondaryColor : '#4a5058';
        ctx.globalAlpha = 0.6;
        wrapRect(rnd() * size, rnd() * size, 2, 2);
      }
      break;
    default:
      for (let i = 0; i < 1600; i++) {
        ctx.fillStyle = rnd() < 0.5 ? def.secondaryColor : def.accentColor;
        ctx.globalAlpha = 0.25 + rnd() * 0.35;
        const s = 2 + rnd() * 5;
        wrapRect(rnd() * size, rnd() * size, s, s);
      }
  }
  ctx.globalAlpha = 1;

  if (type === TerrainTileType.GRASS) {
    // Macro variation noise in alpha for irregular surface edges and weather effects.
    const img = ctx.getImageData(0, 0, size, size);
    const blobs = Array.from({ length: 40 }, () => [rnd() * size, rnd() * size, 20 + rnd() * 50, rnd()]);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let v = 0.5;
        for (const [bx, by, br, bv] of blobs) {
          const dx = Math.min(Math.abs(x - bx), size - Math.abs(x - bx));
          const dy = Math.min(Math.abs(y - by), size - Math.abs(y - by));
          const d = Math.sqrt(dx * dx + dy * dy) / br;
          if (d < 1) v += (bv - 0.5) * (1 - d) * 0.8;
        }
        img.data[(y * size + x) * 4 + 3] = Math.max(0, Math.min(255, v * 255));
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  if (type === TerrainTileType.GRASS) tex.premultiplyAlpha = false;
  return tex;
}

function createRockTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#7b756c';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 500; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? '#6a645b' : '#8d877d';
    ctx.globalAlpha = 0.5;
    ctx.fillRect(Math.random() * size, Math.random() * size, 3 + Math.random() * 6, 2 + Math.random() * 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
