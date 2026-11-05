import { injectNightLights } from './NightLighting';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { COLLISION_GROUPS } from '../config/constants';
import { TerrainTileType, TILE_DEFINITIONS, sanitizeTile } from '../terrain/types/TerrainTypes';
import { SEA_BED_TOP, SEA_FLOOR_Y, WORLD_HALF, WORLD_LIMIT, WORLD_SIZE, isMobileDevice, worldSettings } from './WorldSettings';
import { islandHeight } from './IslandGenerator';
import { riverWorld, GridRect } from './rivers/RiverWorld';
import { causticsUniforms, CAUSTICS_GLSL, CAUSTICS_TINT } from '../scene/WaterEffects';

const N = WORLD_SIZE; // cells per side (1 m cells)
const V = N + 1; // vertices per side
const CHUNK = 64; // metres per render + physics chunk -> 8x8; the camera frustum culls most of them
const CHUNKS = N / CHUNK;
export const TERRAIN_CHUNK = CHUNK;
export const TERRAIN_CHUNKS = CHUNKS;
/** Vertex step per LOD level (1 m, 2 m, 4 m, 8 m). */
const LOD_STEPS = [1, 2, 4, 8];
/**
 * Distance (camera to the chunk's footprint, metres) up to which each LOD level is used; past the
 * last one the coarsest. Phones switch earlier: their GPUs pay the most per vertex.
 */
const LOD_DIST_PC = [100, 190, 300];
const LOD_DIST_MOBILE = [60, 120, 190];

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
 * Serialized terrain, base64. Format 'd1': run-length encoded Int16 pairs (count, value) of the
 * height difference from the generated island in centimetres, and of the tile ids, so an untouched
 * world is a few bytes and edits cost only where they are. Without `enc`: raw Int16 cm heights and
 * raw tile bytes (old saves, possibly a smaller world that gets placed in the island's centre).
 */
export interface TerrainSaveData {
  size: number;
  heights: string;
  tiles: string;
  enc?: 'd1';
}

/**
 * Heightmap terrain with GPU texture splatting.
 *
 * - Heights: (N+1)^2 grid, 1 m spacing, rendered as 64 m chunk meshes sharing one index buffer;
 *   chunks outside the camera frustum (and beyond the far plane) are skipped by three.js.
 * - Surface types: one byte per cell, uploaded to two RGBA weight textures (N x N) that the shader
 *   samples bilinearly, so tile borders blend softly; only the painted rectangle is rewritten.
 * - Physics: one Rapier heightfield per chunk, so a brush stroke rebuilds only the chunks it touched.
 * - Beyond the island: a sea-bed collider, and invisible walls far out in the open sea.
 */
export class TerrainSystem {
  public readonly group = new THREE.Group();
  public readonly heights = new Float32Array(V * V);
  public readonly tiles = new Uint8Array(N * N);

  private readonly material: THREE.MeshLambertMaterial;
  private readonly chunkMeshes: THREE.Mesh[] = [];
  /** Per chunk, one geometry per LOD level sharing the position / normal buffers. */
  private readonly chunkLods: THREE.BufferGeometry[][] = [];
  private readonly lodDist = isMobileDevice() ? LOD_DIST_MOBILE : LOD_DIST_PC;
  /** Triangles in the chunk meshes' current LODs (all chunks, before frustum culling). */
  public lodTriangles = 0;
  private readonly dirtyChunks = new Set<number>();
  private readonly splatA: THREE.DataTexture;
  private readonly splatB: THREE.DataTexture;
  private splatDirty = true;
  /** Cell rectangle of tiles changed since the last splat upload. */
  private splatRect = { x0: 0, z0: 0, x1: N - 1, z1: N - 1 };
  private readonly physicsDirtyChunks = new Set<number>();
  private physicsTimer = 0;
  private readonly chunkColliders: (RAPIER.Collider | null)[] = new Array(CHUNKS * CHUNKS).fill(null);
  private body: RAPIER.RigidBody | null = null;
  private readonly uniforms = { uWaterLevel: { value: worldSettings.waterLevel } };
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

  constructor(scene: THREE.Scene, private readonly physics: PhysicsWorld) {
    this.group.name = 'Terrain';
    scene.add(this.group);

    this.splatA = new THREE.DataTexture(new Uint8Array(N * N * 4), N, N, THREE.RGBAFormat);
    this.splatB = new THREE.DataTexture(new Uint8Array(N * N * 4), N, N, THREE.RGBAFormat);
    for (const t of [this.splatA, this.splatB]) {
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
    }

    this.material = this.createMaterial();
    this.generateDefaultWorld();
    this.buildChunks();
    this.createWorldBounds();
  }

  // ---------------------------------------------------------------- queries

  public getHeight(x: number, z: number): number {
    const fx = THREE.MathUtils.clamp(x + WORLD_HALF, 0, N);
    const fz = THREE.MathUtils.clamp(z + WORLD_HALF, 0, N);
    const ix = Math.min(Math.floor(fx), N - 1);
    const iz = Math.min(Math.floor(fz), N - 1);
    const tx = fx - ix;
    const tz = fz - iz;
    const h = this.heights;
    const a = h[iz * V + ix];
    const b = h[iz * V + ix + 1];
    const c = h[(iz + 1) * V + ix];
    const d = h[(iz + 1) * V + ix + 1];
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
    while (stack.length && count < maxCells) {
      const i = stack.pop()!;
      if (this.tiles[i] !== from) continue;
      this.tiles[i] = type;
      count++;
      const cx = i % N;
      const cz = (i - cx) / N;
      if (cx > 0) stack.push(i - 1);
      if (cx < N - 1) stack.push(i + 1);
      if (cz > 0) stack.push(i - N);
      if (cz < N - 1) stack.push(i + N);
    }
    this.markSplatDirty(0, 0, N - 1, N - 1);
  }

  private markSplatDirty(x0: number, z0: number, x1: number, z1: number): void {
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
        h[i] = THREE.MathUtils.clamp(h[i], SEA_FLOOR_Y, 24);
      }
    }
    this.markHeightsDirty(minX, minZ, maxX, maxZ);
  }

  private markHeightsDirty(minX: number, minZ: number, maxX: number, maxZ: number): void {
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
    this.onHeightsDirty?.(minX, minZ, maxX, maxZ);
  }

  /** Call once per frame: uploads changed chunks / weights; physics rebuilds at most 4x per second. */
  public update(dt: number): void {
    this.uniforms.uWaterLevel.value = worldSettings.waterLevel;
    if (this.dirtyChunks.size) {
      for (const c of this.dirtyChunks) this.writeChunkGeometry(c);
      this.dirtyChunks.clear();
    }
    if (this.splatDirty) {
      this.uploadSplat();
      this.splatDirty = false;
    }
    this.physicsTimer -= dt;
    if (this.physicsDirtyChunks.size && this.physicsTimer <= 0) {
      this.rebuildDirtyColliders();
      this.physicsTimer = 0.25;
    }
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
        if (applyToLive) this.heights[i] += (cm - base.heights[i]) / 100;
        base.heights[i] = cm;
      }
    }
    this.markHeightsDirty(rect.x0, rect.z0, rect.x1, rect.z1);
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

  public updateLod(camera: THREE.Vector3): void {
    let tris = 0;
    for (let c = 0; c < this.chunkMeshes.length; c++) {
      const cx = c % CHUNKS, cz = (c - cx) / CHUNKS;
      const x0 = cx * CHUNK - WORLD_HALF, z0 = cz * CHUNK - WORLD_HALF;
      const dx = Math.max(x0 - camera.x, 0, camera.x - (x0 + CHUNK));
      const dz = Math.max(z0 - camera.z, 0, camera.z - (z0 + CHUNK));
      const d = Math.sqrt(dx * dx + dz * dz);
      let level = 0;
      while (level < this.lodDist.length && d > this.lodDist[level]) level++;
      const geo = this.chunkLods[c][level];
      const mesh = this.chunkMeshes[c];
      if (mesh.geometry !== geo) mesh.geometry = geo;
      tris += geo.index!.count / 3;
    }
    this.lodTriangles = tris;
  }

  private uploadSplat(): void {
    const a = this.splatA.image.data as Uint8Array;
    const b = this.splatB.image.data as Uint8Array;
    // Layer order: A = dirt, asphalt, cobble, sand | B = snow
    const slot: Record<number, [Uint8Array, number] | null> = {
      [TerrainTileType.GRASS]: null,
      [TerrainTileType.DIRT_ROAD]: [a, 0],
      [TerrainTileType.ASPHALT_ROAD]: [a, 1],
      [TerrainTileType.STONE_COBBLE]: [a, 2],
      [TerrainTileType.SAND_BEACH]: [a, 3],
      [TerrainTileType.SNOW]: [b, 0],
    };
    const r = this.splatRect;
    for (let z = r.z0; z <= r.z1; z++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = z * N + x;
        a.fill(0, i * 4, i * 4 + 4);
        b.fill(0, i * 4, i * 4 + 4);
        const s = slot[this.tiles[i]];
        if (s) s[0][i * 4 + s[1]] = 255;
      }
    }
    this.splatA.needsUpdate = true;
    this.splatB.needsUpdate = true;
  }

  private createMaterial(): THREE.MeshLambertMaterial {
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    // Phones get a lighter fragment path: 2-3 fewer texture fetches and no snow glints
    const lite = isMobileDevice();
    if (lite) mat.defines = { TERRAIN_LITE: '' };
    mat.customProgramCacheKey = () => (lite ? 'terrain-lite' : 'terrain');
    const layers = {
      tGrass: createLayerTexture(TerrainTileType.GRASS),
      tDirt: createLayerTexture(TerrainTileType.DIRT_ROAD),
      tAsphalt: createLayerTexture(TerrainTileType.ASPHALT_ROAD),
      tCobble: createLayerTexture(TerrainTileType.STONE_COBBLE),
      tSand: createLayerTexture(TerrainTileType.SAND_BEACH),
      tSnow: createLayerTexture(TerrainTileType.SNOW),
      tRock: createRockTexture(),
    };
    this.grassLayer = layers.tGrass;
    mat.onBeforeCompile = (shader) => {
      injectNightLights(shader, { perVertex: lite });
      Object.assign(shader.uniforms, this.uniforms, causticsUniforms, {
        tRiver: { value: riverWorld.texture },
        tSplatA: { value: this.splatA },
        tSplatB: { value: this.splatB },
        uWorldSize: { value: WORLD_SIZE },
      });
      for (const [k, v] of Object.entries(layers)) shader.uniforms[k] = { value: v };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTerrWorld;\nvarying float vTerrUpY;\nattribute float aShade;\nvarying float vShade;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvTerrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTerrUpY = normalize(mat3(modelMatrix) * objectNormal).y;\nvShade = aShade;'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vTerrWorld;
varying float vTerrUpY;
varying float vShade;
uniform sampler2D tGrass, tDirt, tAsphalt, tCobble, tSand, tSnow, tRock, tSplatA, tSplatB, tRiver;
uniform float uWorldSize;
uniform float uWaterLevel;
float terrWaterY;
${CAUSTICS_GLSL}
vec3 terrainColor() {
  vec2 suv = (vTerrWorld.xz + uWorldSize * 0.5) / uWorldSize;
  vec2 uv = vTerrWorld.xz * 0.5;
  // Local water: the sea, or a river's surface near its channel
  vec2 river = texture2D(tRiver, (vTerrWorld.xz + uWorldSize * 0.5 + 0.5) / (uWorldSize + 1.0)).rg;
  float waterY = river.g > 0.5 ? max(uWaterLevel, river.r) : uWaterLevel;
  terrWaterY = waterY;
  vec4 g = texture2D(tGrass, uv);
#ifdef TERRAIN_LITE
  // Phones: analytic border noise instead of a second grass fetch
  float n = (sin(vTerrWorld.x * 0.37 + sin(vTerrWorld.z * 0.23) * 2.0) * sin(vTerrWorld.z * 0.41 + vTerrWorld.x * 0.11)) * 0.3;
#else
  float n = texture2D(tGrass, vTerrWorld.xz * 0.061).a - 0.5;
#endif
  vec4 wa = smoothstep(0.32, 0.68, texture2D(tSplatA, suv) + n * 0.45);
  vec2 wb = smoothstep(0.32, 0.68, texture2D(tSplatB, suv).rg + n * 0.45);
  vec3 c = g.rgb;
  if (wa.r > 0.001) c = mix(c, texture2D(tDirt, uv).rgb, wa.r);
  if (wa.g > 0.001) c = mix(c, texture2D(tAsphalt, uv).rgb, wa.g);
  if (wa.b > 0.001) c = mix(c, texture2D(tCobble, uv).rgb, wa.b);
  // Sandy shore by the sea and in estuaries, a narrow gravel strip along rivers upstream
  bool riverBank = river.g > 0.5 && waterY > uWaterLevel + 0.3;
  // River gravel only hugs the water (the weight is 1 within ~2.5 m of the channel): flat
  // floodplains that happen to sit just above the water stay grass
  float beach = riverBank
    ? smoothstep(waterY + 0.32, waterY + 0.08, vTerrWorld.y) * smoothstep(0.8, 0.97, river.g)
    : smoothstep(waterY + 0.55, waterY + 0.15, vTerrWorld.y);
  float sandW = max(wa.a, beach);
  if (sandW > 0.001) c = mix(c, texture2D(tSand, uv).rgb, sandW);
  float rock = smoothstep(0.8, 0.62, vTerrUpY);
  if (rock > 0.001) c = mix(c, texture2D(tRock, uv).rgb, rock);
  // Snow: settles last, over everything incl. rock, but thins out on steep slopes and melts
  // into slush at the waterline. Drifts (macro noise) are bright, hollows take a cold blue tint,
  // and sparse view-dependent glints twinkle as the camera moves.
  if (wb.r > 0.001) {
    float sw = wb.r * (1.0 - smoothstep(0.55, 0.35, vTerrUpY) * 0.7) * smoothstep(waterY + 0.05, waterY + 0.35, vTerrWorld.y);
    float drift = clamp(n * 2.2 + 0.5, 0.0, 1.0);
#ifdef TERRAIN_LITE
    vec3 snow = mix(vec3(0.76, 0.84, 0.94), vec3(1.0, 1.0, 1.02), drift);
    snow = mix(snow, vec3(0.70, 0.78, 0.90), smoothstep(0.97, 0.75, vTerrUpY) * 0.5);
#else
    vec3 sTex = texture2D(tSnow, uv * 0.5).rgb;
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
    c = mix(c, snow, sw);
  }
  // River beds are gravel; everything below the waterline is wet and darker
  float underRiver = smoothstep(waterY - 0.05, waterY - 0.4, vTerrWorld.y) * step(0.5, river.g);
#ifdef TERRAIN_LITE
  c = mix(c, vec3(0.42, 0.38, 0.32), underRiver * 0.6);
#else
  if (underRiver > 0.001) c = mix(c, texture2D(tRock, uv * 1.7).rgb * vec3(0.95, 0.9, 0.8), underRiver * 0.75);
#endif
  c *= mix(1.0, 0.62, smoothstep(waterY, waterY - 1.5, vTerrWorld.y));
  return c;
}`
        )
        .replace('#include <map_fragment>', 'diffuseColor.rgb *= terrainColor();')
        // Baked static shadows dim the sun / moon; a little contact darkening of the sky light too
        .replace(
          '#include <lights_fragment_end>',
          '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= 1.0 - vShade;\nreflectedLight.indirectDiffuse *= 1.0 - vShade * 0.3;\n' +
            // Sea floor and river beds: the sun's caustics
            `reflectedLight.directDiffuse *= 1.0 + causticsLight(vTerrWorld, terrWaterY, vTerrUpY) * ${CAUSTICS_TINT};`
        );
    };
    return mat;
  }

  // ---------------------------------------------------------------- physics

  private rebuildDirtyColliders(): void {
    const { rapier, world } = this.physics;
    if (!this.body) this.body = world.createRigidBody(rapier.RigidBodyDesc.fixed());
    const S = CHUNK + 1;
    const data = new Float32Array(S * S);
    const groups = this.physics.packCollisionGroups(COLLISION_GROUPS.ENVIRONMENT, 0xffff);
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

  public serialize(): TerrainSaveData {
    const base = TerrainSystem.base();
    const dh = new Int16Array(V * V);
    for (let i = 0; i < dh.length; i++) dh[i] = Math.round(this.heights[i] * 100) - base.heights[i];
    const dt = new Int16Array(N * N);
    for (let i = 0; i < dt.length; i++) dt[i] = this.tiles[i];
    return { size: N, enc: 'd1', heights: rleEncode(dh), tiles: rleEncode(dt) };
  }

  /** True when the last load placed an older, smaller world in the island's centre. */
  public expandedFromLegacy = false;

  public deserialize(data: TerrainSaveData): void {
    this.expandedFromLegacy = false;
    const base = TerrainSystem.base();
    if (data.enc === 'd1' && data.size === N) {
      const dh = rleDecode(data.heights, V * V);
      for (let i = 0; i < dh.length; i++) this.heights[i] = (base.heights[i] + dh[i]) / 100;
      const dt = rleDecode(data.tiles, N * N);
      for (let i = 0; i < dt.length; i++) this.tiles[i] = sanitizeTile(dt[i]);
    } else if (!data.enc && data.size <= N) {
      this.loadLegacy(data, base);
    } else {
      return;
    }
    this.markHeightsDirty(0, 0, N, N);
    this.markSplatDirty(0, 0, N - 1, N - 1);
    this.commit();
  }

  /** Old raw saves: their (smaller) world goes in the middle, blended into the island around it. */
  private loadLegacy(data: TerrainSaveData, base: { heights: Int16Array; tiles: Uint8Array }): void {
    const s = data.size;
    const sv = s + 1;
    const o = (N - s) / 2;
    const cm = new Int16Array(fromBase64(data.heights).buffer);
    const oldTiles = fromBase64(data.tiles);
    const BLEND = 24;
    for (let iz = 0; iz <= N; iz++) {
      for (let ix = 0; ix <= N; ix++) {
        const lx = ix - o;
        const lz = iz - o;
        const cx = Math.min(s, Math.max(0, lx));
        const cz = Math.min(s, Math.max(0, lz));
        const old = (cm[cz * sv + cx] ?? 0) / 100;
        const d = Math.hypot(lx - cx, lz - cz);
        const t = THREE.MathUtils.smoothstep(d, 0, BLEND);
        this.heights[iz * V + ix] = old * (1 - t) + (base.heights[iz * V + ix] / 100) * t;
      }
    }
    this.tiles.set(base.tiles);
    for (let z = 0; z < s; z++) {
      for (let x = 0; x < s; x++) this.tiles[(z + o) * N + x + o] = sanitizeTile(oldTiles[z * s + x] ?? TerrainTileType.GRASS);
    }
    this.expandedFromLegacy = s < N;
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
function createLayerTexture(type: TerrainTileType): THREE.CanvasTexture {
  const size = 256;
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

  switch (type) {
    case TerrainTileType.GRASS:
      for (let i = 0; i < 2200; i++) {
        ctx.fillStyle = rnd() < 0.5 ? def.secondaryColor : def.accentColor;
        ctx.globalAlpha = 0.35 + rnd() * 0.4;
        wrapRect(rnd() * size, rnd() * size, 2, 4 + rnd() * 4);
      }
      break;
    case TerrainTileType.STONE_COBBLE:
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          ctx.fillStyle = rnd() < 0.5 ? def.secondaryColor : def.accentColor;
          ctx.globalAlpha = 1;
          const off = y % 2 ? 16 : 0;
          wrapRect(x * 32 + off + 2, y * 32 + 2, 28, 28);
        }
      }
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
    // Macro variation noise in alpha: soft blobs, used to break up blend edges and tint
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
