import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { COLLISION_GROUPS } from '../config/constants';
import { TerrainTileType, TILE_DEFINITIONS } from '../terrain/types/TerrainTypes';
import { WORLD_HALF, WORLD_SIZE, worldSettings } from './WorldSettings';

const N = WORLD_SIZE; // cells per side (1 m cells)
const V = N + 1; // vertices per side
const CHUNK = 32; // metres per render chunk -> 4x4 = 16 draw calls
const CHUNKS = N / CHUNK;

export type TerrainBrushKind = 'raise' | 'lower' | 'smooth' | 'flatten';

/** Serialized terrain: heights in centimetres and one tile id per cell, both base64. */
export interface TerrainSaveData {
  size: number;
  heights: string;
  tiles: string;
}

/**
 * Heightmap terrain with GPU texture splatting.
 *
 * - Heights: (N+1)^2 grid, 1 m spacing, rendered as 16 chunk meshes sharing one index buffer.
 * - Surface types: one byte per cell, uploaded to two tiny RGBA weight textures (128x128) that the
 *   shader samples bilinearly, so tile borders blend softly with zero canvas redraws.
 * - Physics: a single Rapier heightfield, rebuilt (throttled) only after height edits.
 */
export class TerrainSystem {
  public readonly group = new THREE.Group();
  public readonly heights = new Float32Array(V * V);
  public readonly tiles = new Uint8Array(N * N);

  private readonly material: THREE.MeshLambertMaterial;
  private readonly chunkMeshes: THREE.Mesh[] = [];
  private readonly dirtyChunks = new Set<number>();
  private readonly splatA: THREE.DataTexture;
  private readonly splatB: THREE.DataTexture;
  private splatDirty = true;
  private physicsDirty = true;
  private physicsTimer = 0;
  private collider: RAPIER.Collider | null = null;
  private body: RAPIER.RigidBody | null = null;
  private readonly uniforms = { uWaterLevel: { value: worldSettings.waterLevel } };
  /** Bumped on every height edit so dependants (props, water) can re-snap lazily. */
  public revision = 0;

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
    this.splatDirty = true;
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
    this.splatDirty = true;
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
        h[i] = THREE.MathUtils.clamp(h[i], -12, 24);
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
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) this.dirtyChunks.add(cz * CHUNKS + cx);
    this.physicsDirty = true;
    this.revision++;
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
    if (this.physicsDirty && this.physicsTimer <= 0) {
      this.rebuildCollider();
      this.physicsDirty = false;
      this.physicsTimer = 0.25;
    }
  }

  /** Forces the physics heightfield to match immediately (e.g. on brush release). */
  public commit(): void {
    if (this.physicsDirty) {
      this.rebuildCollider();
      this.physicsDirty = false;
    }
  }

  // ---------------------------------------------------------------- generation

  private generateDefaultWorld(): void {
    const h = this.heights;
    for (let iz = 0; iz <= N; iz++) {
      for (let ix = 0; ix <= N; ix++) {
        const x = ix - WORLD_HALF;
        const z = iz - WORLD_HALF;
        // Flat farm in the middle, rolling hills toward the edges
        const r = Math.sqrt(x * x + z * z);
        const edge = THREE.MathUtils.smoothstep(r, 42, 62);
        const hills = (Math.sin(x * 0.11) * Math.cos(z * 0.09) * 0.5 + 0.5) * 5 + Math.sin(x * 0.27 + z * 0.19) * 0.6;
        let y = edge * hills;
        // Fishing pond north-east of the farm
        const px = x - 30;
        const pz = z - 28;
        const pd = Math.sqrt(px * px * 0.8 + pz * pz) / 10;
        if (pd < 1.4) y = Math.min(y, -2.6 * (1 - THREE.MathUtils.smoothstep(pd, 0.55, 1.4)));
        h[iz * V + ix] = y;
      }
    }
    this.tiles.fill(TerrainTileType.GRASS);
    // Dirt path from spawn towards the pond
    for (let t = 0; t <= 1; t += 0.01) {
      this.paintCircle(THREE.MathUtils.lerp(2, 22, t), THREE.MathUtils.lerp(6, 21, t) + Math.sin(t * 6) * 1.5, 1.1, TerrainTileType.DIRT_ROAD);
    }
    this.splatDirty = true;
    this.physicsDirty = true;
  }

  public resetFlat(): void {
    this.heights.fill(0);
    this.tiles.fill(TerrainTileType.GRASS);
    this.markHeightsDirty(0, 0, N, N);
    this.splatDirty = true;
  }

  // ---------------------------------------------------------------- rendering

  private buildChunks(): void {
    const S = CHUNK + 1;
    const index: number[] = [];
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const a = z * S + x;
        index.push(a, a + S, a + 1, a + 1, a + S, a + S + 1);
      }
    }
    const sharedIndex = new THREE.Uint16BufferAttribute(index, 1);

    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const geo = new THREE.BufferGeometry();
        geo.setIndex(sharedIndex);
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(S * S * 3), 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(S * S * 3), 3));
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
    mesh.geometry.computeBoundingSphere();
    mesh.geometry.computeBoundingBox();
  }

  private uploadSplat(): void {
    const a = this.splatA.image.data as Uint8Array;
    const b = this.splatB.image.data as Uint8Array;
    a.fill(0);
    b.fill(0);
    // Layer order: A = dirt, asphalt, cobble, sand | B = water, wood
    const slot: Record<number, [Uint8Array, number] | null> = {
      [TerrainTileType.GRASS]: null,
      [TerrainTileType.DIRT_ROAD]: [a, 0],
      [TerrainTileType.ASPHALT_ROAD]: [a, 1],
      [TerrainTileType.STONE_COBBLE]: [a, 2],
      [TerrainTileType.SAND_BEACH]: [a, 3],
      [TerrainTileType.WATER_CHANNEL]: [b, 0],
      [TerrainTileType.WOOD_DECK]: [b, 1],
    };
    for (let i = 0; i < N * N; i++) {
      const s = slot[this.tiles[i]];
      if (s) s[0][i * 4 + s[1]] = 255;
    }
    this.splatA.needsUpdate = true;
    this.splatB.needsUpdate = true;
  }

  private createMaterial(): THREE.MeshLambertMaterial {
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const layers = {
      tGrass: createLayerTexture(TerrainTileType.GRASS),
      tDirt: createLayerTexture(TerrainTileType.DIRT_ROAD),
      tAsphalt: createLayerTexture(TerrainTileType.ASPHALT_ROAD),
      tCobble: createLayerTexture(TerrainTileType.STONE_COBBLE),
      tSand: createLayerTexture(TerrainTileType.SAND_BEACH),
      tWater: createLayerTexture(TerrainTileType.WATER_CHANNEL),
      tWood: createLayerTexture(TerrainTileType.WOOD_DECK),
      tRock: createRockTexture(),
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms, {
        tSplatA: { value: this.splatA },
        tSplatB: { value: this.splatB },
        uWorldSize: { value: WORLD_SIZE },
      });
      for (const [k, v] of Object.entries(layers)) shader.uniforms[k] = { value: v };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTerrWorld;\nvarying float vTerrUpY;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvTerrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTerrUpY = normalize(mat3(modelMatrix) * objectNormal).y;'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vTerrWorld;
varying float vTerrUpY;
uniform sampler2D tGrass, tDirt, tAsphalt, tCobble, tSand, tWater, tWood, tRock, tSplatA, tSplatB;
uniform float uWorldSize;
uniform float uWaterLevel;
vec3 terrainColor() {
  vec2 suv = (vTerrWorld.xz + uWorldSize * 0.5) / uWorldSize;
  vec2 uv = vTerrWorld.xz * 0.5;
  vec4 g = texture2D(tGrass, uv);
  float n = texture2D(tGrass, vTerrWorld.xz * 0.061).a - 0.5;
  vec4 wa = smoothstep(0.32, 0.68, texture2D(tSplatA, suv) + n * 0.45);
  vec2 wb = smoothstep(0.32, 0.68, texture2D(tSplatB, suv).rg + n * 0.45);
  vec3 c = g.rgb;
  if (wa.r > 0.001) c = mix(c, texture2D(tDirt, uv).rgb, wa.r);
  if (wa.g > 0.001) c = mix(c, texture2D(tAsphalt, uv).rgb, wa.g);
  if (wa.b > 0.001) c = mix(c, texture2D(tCobble, uv).rgb, wa.b);
  float beach = smoothstep(uWaterLevel + 0.55, uWaterLevel + 0.15, vTerrWorld.y);
  float sandW = max(wa.a, beach);
  if (sandW > 0.001) c = mix(c, texture2D(tSand, uv).rgb, sandW);
  if (wb.r > 0.001) c = mix(c, texture2D(tWater, uv).rgb, wb.r);
  if (wb.g > 0.001) c = mix(c, texture2D(tWood, uv).rgb, wb.g);
  float rock = smoothstep(0.8, 0.62, vTerrUpY);
  if (rock > 0.001) c = mix(c, texture2D(tRock, uv).rgb, rock);
  // Wet, darker soil below the waterline
  c *= mix(1.0, 0.62, smoothstep(uWaterLevel, uWaterLevel - 1.5, vTerrWorld.y));
  return c;
}`
        )
        .replace('#include <map_fragment>', 'diffuseColor.rgb *= terrainColor();');
    };
    return mat;
  }

  // ---------------------------------------------------------------- physics

  private rebuildCollider(): void {
    const { rapier, world } = this.physics;
    if (!this.body) {
      this.body = world.createRigidBody(rapier.RigidBodyDesc.fixed());
    }
    if (this.collider) world.removeCollider(this.collider, false);
    // Rapier heightfields are column-major with columns along X
    const data = new Float32Array(V * V);
    for (let ix = 0; ix <= N; ix++) {
      for (let iz = 0; iz <= N; iz++) data[ix * V + iz] = this.heights[iz * V + ix];
    }
    this.collider = world.createCollider(
      rapier.ColliderDesc.heightfield(N, N, data, { x: WORLD_SIZE, y: 1, z: WORLD_SIZE })
        .setFriction(0.9)
        .setCollisionGroups(this.physics.packCollisionGroups(COLLISION_GROUPS.ENVIRONMENT, 0xffff)),
      this.body
    );
  }

  /** Invisible walls at the world edge so nothing falls off the map. */
  private createWorldBounds(): void {
    const h = 30;
    const t = 1;
    const s = WORLD_SIZE + 2 * t;
    const walls: [number, number, number, number][] = [
      [0, -WORLD_HALF - t / 2, s, t],
      [0, WORLD_HALF + t / 2, s, t],
      [-WORLD_HALF - t / 2, 0, t, s],
      [WORLD_HALF + t / 2, 0, t, s],
    ];
    for (const [x, z, sx, sz] of walls) {
      this.physics.createStaticBox(new THREE.Vector3(x, h / 2 - 12, z), new THREE.Vector3(sx, h, sz));
    }
  }

  // ---------------------------------------------------------------- save / load

  public serialize(): TerrainSaveData {
    const cm = new Int16Array(V * V);
    for (let i = 0; i < cm.length; i++) cm[i] = Math.round(this.heights[i] * 100);
    return { size: N, heights: toBase64(new Uint8Array(cm.buffer)), tiles: toBase64(this.tiles) };
  }

  public deserialize(data: TerrainSaveData): void {
    if (data.size !== N) return;
    const cm = new Int16Array(fromBase64(data.heights).buffer);
    for (let i = 0; i < Math.min(cm.length, this.heights.length); i++) this.heights[i] = cm[i] / 100;
    this.tiles.set(fromBase64(data.tiles).subarray(0, this.tiles.length));
    this.markHeightsDirty(0, 0, N, N);
    this.splatDirty = true;
    this.commit();
  }
}

// ------------------------------------------------------------------ helpers

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
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
    case TerrainTileType.WOOD_DECK:
      for (let y = 0; y < 8; y++) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = y % 2 ? def.secondaryColor : def.primaryColor;
        ctx.fillRect(0, y * 32, size, 30);
        ctx.fillStyle = def.borderColor;
        ctx.fillRect(0, y * 32 + 30, size, 2);
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
