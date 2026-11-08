import * as THREE from 'three';
import { injectNightLights } from './NightLighting';
import { WORLD_HALF, WORLD_SIZE, worldSettings } from './WorldSettings';
import { riverWorld } from './rivers/RiverWorld';
import { TERRAIN_CHUNK, TERRAIN_CHUNKS, type TerrainSystem } from './TerrainSystem';
import { TerrainTileType } from '../terrain/types/TerrainTypes';
import { vegetationRevision, vegetationSettings as veg } from './VegetationSettings';

const N = WORLD_SIZE;
const V = N + 1;
const S = TERRAIN_CHUNK + 1;
/** Redo changed parts of the height / density textures at most this often while editing (s). */
const REFRESH = 0.1;
/** Up to this many changed rows go up as row ranges; more and the whole texture is re-sent. */
const MAX_RANGE_ROWS = 96;

/** An inclusive rect of 1 m vertices, empty while x0 > x1. */
interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}
const emptyRect = (): Rect => ({ x0: V, z0: V, x1: -1, z1: -1 });
const isEmpty = (r: Rect) => r.x0 > r.x1 || r.z0 > r.z1;
function grow(r: Rect, x0: number, z0: number, x1: number, z1: number): void {
  r.x0 = Math.max(0, Math.min(r.x0, Math.floor(x0)));
  r.z0 = Math.max(0, Math.min(r.z0, Math.floor(z0)));
  r.x1 = Math.min(V - 1, Math.max(r.x1, Math.ceil(x1)));
  r.z1 = Math.min(V - 1, Math.max(r.z1, Math.ceil(z1)));
}

/** Patch size, blade count, height, width, wind and shading come live from VegetationSettings. */

/**
 * 3D grass: one draw call of single-triangle blades on every grass tile near the camera.
 *
 * - The blades never move on the CPU: their roots lie on a fixed square patch, and the vertex
 *   shader wraps each root (`mod`) into the square around the camera, so a blade keeps its world
 *   spot while the patch "rolls" along with the view. Only a few uniforms are written per frame.
 * - Each blade sits on the ground (a half-float copy of the terrain heights), takes the terrain's
 *   own grass colour at its root and the ground's normal (straight up) for lighting, so the field
 *   blends into the terrain with no seam; the base is darker, the tip lighter.
 * - Where it grows: a byte density per 1 m vertex, built on the CPU from the tiles (grass only),
 *   the slope (rock on steep ground), and blockers (building pieces incl. floors and paths, wells,
 *   hay, boulders — baked by StaticShadows). The shader adds the beach / river-bank rule the
 *   terrain uses, so no blade stands on sand or under water.
 * - The baked static shadows (trees, buildings) darken the blades as they darken the ground.
 * - Wind: two noise octaves bend the tips (stronger in storms).
 * - Blades turn to face the camera, and shrink to nothing near the patch edge (no hard border).
 */
export class GrassField {
  public readonly mesh: THREE.Mesh;
  public enabled = true;

  private readonly heightData = new Uint16Array(V * V);
  private readonly heightTex: THREE.DataTexture;
  /** R = density, G = baked shade, B = blocked (by buildings / props), per 1 m vertex. */
  private readonly data = new Uint8Array(V * V * 4);
  private readonly dataTex: THREE.DataTexture;

  private readonly uniforms = {
    uGrCenter: { value: new THREE.Vector2() },
    uGrTime: { value: 0 },
    uGrWind: { value: 0.3 },
    uGrSea: { value: worldSettings.waterLevel },
    uGrHeight: { value: null as THREE.Texture | null },
    uGrData: { value: null as THREE.Texture | null },
    uGrRiver: { value: riverWorld.texture as THREE.Texture },
    uGrColor: { value: null as THREE.Texture | null },
    uGrSize: { value: veg.grassPatch },
    uGrHeightK: { value: veg.grassHeight },
    uGrWidth: { value: veg.grassWidth },
    uGrWindK: { value: veg.grassWind },
    uGrShadeA: { value: veg.grassBaseShade },
    uGrShadeB: { value: veg.grassTipShade },
  };
  /** Blades rebuilt this long after the patch / density sliders stop moving (s). */
  private grassRevision = vegetationRevision.grass;
  private rebuildIn = -1;

  /** Vertices whose height / density must be redone (only the changed area, never the island). */
  private readonly heightRect = emptyRect();
  private readonly densityRect = emptyRect();
  /** Rows of the data texture to re-send (shade and density), or everything. */
  private readonly uploadRect = emptyRect();
  private terrainRevision = -1;
  private tileRevision = -1;
  private timer = 0;

  constructor(scene: THREE.Scene, private readonly terrain: TerrainSystem) {
    this.heightTex = new THREE.DataTexture(this.heightData, V, V, THREE.RedFormat, THREE.HalfFloatType);
    this.dataTex = new THREE.DataTexture(this.data, V, V, THREE.RGBAFormat);
    for (const t of [this.heightTex, this.dataTex]) {
      t.magFilter = t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.colorSpace = THREE.NoColorSpace;
    }
    this.uniforms.uGrHeight.value = this.heightTex;
    this.uniforms.uGrData.value = this.dataTex;
    this.uniforms.uGrColor.value = terrain.grassLayer;

    // The terrain reports exactly what changed; the first update builds everything once
    terrain.onHeightsDirty = (x0, z0, x1, z1) => {
      grow(this.heightRect, x0, z0, x1, z1);
      grow(this.densityRect, x0 - 1, z0 - 1, x1 + 1, z1 + 1); // slopes read the neighbours
    };
    terrain.onTilesDirty = (x0, z0, x1, z1) => grow(this.densityRect, x0, z0, x1 + 1, z1 + 1); // cells -> vertices
    this.terrainRevision = terrain.revision;
    this.tileRevision = terrain.tileRevision;
    grow(this.heightRect, 0, 0, V - 1, V - 1);
    grow(this.densityRect, 0, 0, V - 1, V - 1);

    this.mesh = new THREE.Mesh(this.buildGeometry(), this.buildMaterial());
    this.mesh.name = 'Grass';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
  }

  // ---------------------------------------------------------------- per frame

  /** `wind` 0..1 (calm .. storm). */
  public update(dt: number, camera: THREE.Camera, wind: number): void {
    this.mesh.visible = this.enabled && veg.grassEnabled;
    if (!this.mesh.visible) return;
    const u = this.uniforms;
    if (vegetationRevision.grass !== this.grassRevision) {
      this.grassRevision = vegetationRevision.grass;
      this.rebuildIn = 0.3;
    }
    if (this.rebuildIn >= 0 && (this.rebuildIn -= dt) < 0) {
      const old = this.mesh.geometry;
      this.mesh.geometry = this.buildGeometry();
      old.dispose();
      u.uGrSize.value = veg.grassPatch;
    }
    const PATCH = u.uGrSize.value;
    u.uGrHeightK.value = veg.grassHeight;
    u.uGrWidth.value = veg.grassWidth;
    u.uGrWindK.value = veg.grassWind;
    u.uGrShadeA.value = veg.grassBaseShade;
    u.uGrShadeB.value = veg.grassTipShade;
    u.uGrTime.value += dt;
    u.uGrSea.value = worldSettings.waterLevel;
    u.uGrWind.value += (0.25 + wind * 0.75 - u.uGrWind.value) * (1 - Math.exp(-dt * 0.5));
    // The patch sits a little ahead of the camera, where the view actually looks
    const e = camera.matrixWorld.elements;
    const fx = -e[8], fz = -e[10];
    const fl = Math.hypot(fx, fz) || 1;
    u.uGrCenter.value.set(camera.position.x + (fx / fl) * PATCH * 0.28, camera.position.z + (fz / fl) * PATCH * 0.28);

    // Safety net: a change that bypassed the callbacks redoes everything once
    const t = this.terrain;
    if (t.revision !== this.terrainRevision || t.tileRevision !== this.tileRevision) {
      if (isEmpty(this.heightRect) && isEmpty(this.densityRect)) {
        grow(this.heightRect, 0, 0, V - 1, V - 1);
        grow(this.densityRect, 0, 0, V - 1, V - 1);
      }
      this.terrainRevision = t.revision;
      this.tileRevision = t.tileRevision;
    }
    this.timer -= dt;
    if (this.timer <= 0 && (!isEmpty(this.heightRect) || !isEmpty(this.densityRect))) {
      this.timer = REFRESH;
      if (!isEmpty(this.heightRect)) this.uploadHeights(this.heightRect);
      if (!isEmpty(this.densityRect)) this.rebuildDensity(this.densityRect);
    }
    this.flushData();
  }

  // ---------------------------------------------------------------- baked inputs (StaticShadows)

  /** A chunk's baked shade and blockers ((CHUNK+1)^2 bytes each, row-major from its -X/-Z corner). */
  public setChunk(chunkIndex: number, shade: Uint8Array, block: Uint8Array): void {
    const cx = chunkIndex % TERRAIN_CHUNKS, cz = (chunkIndex - cx) / TERRAIN_CHUNKS;
    const gx = cx * TERRAIN_CHUNK, gz = cz * TERRAIN_CHUNK;
    const d = this.data;
    let changedBlock = false;
    for (let z = 0; z < S; z++) {
      const row = (gz + z) * V + gx;
      for (let x = 0; x < S; x++) {
        const o = (row + x) * 4;
        d[o + 1] = shade[z * S + x];
        if (d[o + 2] !== block[z * S + x]) {
          d[o + 2] = block[z * S + x];
          changedBlock = true;
        }
      }
    }
    if (changedBlock) grow(this.densityRect, gx, gz, gx + S - 1, gz + S - 1);
    grow(this.uploadRect, gx, gz, gx + S - 1, gz + S - 1);
  }

  /** Converts the changed heights to half floats (the R16F texture itself is small enough to re-send). */
  private uploadHeights(r: Rect): void {
    const h = this.terrain.heights;
    const out = this.heightData;
    const toHalf = THREE.DataUtils.toHalfFloat;
    for (let z = r.z0; z <= r.z1; z++) {
      for (let i = z * V + r.x0, e = z * V + r.x1; i <= e; i++) out[i] = toHalf(h[i]);
    }
    this.heightTex.needsUpdate = true;
    Object.assign(r, emptyRect());
  }

  /** Grass density of the vertices in `r`: grass tiles around them, not too steep, not blocked. */
  private rebuildDensity(r: Rect): void {
    const h = this.terrain.heights;
    const tiles = this.terrain.tiles;
    const d = this.data;
    const grass = TerrainTileType.GRASS;
    for (let z = r.z0; z <= r.z1; z++) {
      for (let x = r.x0; x <= r.x1; x++) {
        // Share of the (up to) four cells around this vertex that are grass
        let g = 0, n = 0;
        for (let dz = -1; dz <= 0; dz++) {
          const cz = z + dz;
          if (cz < 0 || cz >= N) continue;
          for (let dx = -1; dx <= 0; dx++) {
            const cx = x + dx;
            if (cx < 0 || cx >= N) continue;
            n++;
            if (tiles[cz * N + cx] === grass) g++;
          }
        }
        let v = n ? g / n : 0;
        if (v > 0) {
          // Steep ground turns to rock in the terrain shader: no grass there either
          const hx = h[z * V + Math.min(x + 1, N)] - h[z * V + Math.max(x - 1, 0)];
          const hz = h[Math.min(z + 1, N) * V + x] - h[Math.max(z - 1, 0) * V + x];
          const up = 2 / Math.sqrt(hx * hx + hz * hz + 4);
          const k = THREE.MathUtils.clamp((up - 0.62) / 0.18, 0, 1);
          v *= k * k * (3 - 2 * k);
        }
        const o = (z * V + x) * 4;
        d[o] = (v * (255 - d[o + 2]) + 0.5) | 0;
      }
    }
    grow(this.uploadRect, r.x0, r.z0, r.x1, r.z1);
    Object.assign(r, emptyRect());
  }

  /** Sends the changed rows of the density / shade texture (all of it after a big change). */
  private flushData(): void {
    const r = this.uploadRect;
    if (isEmpty(r)) return;
    const tex = this.dataTex;
    if (r.z1 - r.z0 + 1 <= MAX_RANGE_ROWS) {
      const count = (r.x1 - r.x0 + 1) * 4;
      for (let z = r.z0; z <= r.z1; z++) tex.addUpdateRange((z * V + r.x0) * 4, count);
    } else {
      tex.clearUpdateRanges();
    }
    tex.needsUpdate = true;
    Object.assign(r, emptyRect());
  }

  // ---------------------------------------------------------------- mesh

  private buildGeometry(): THREE.BufferGeometry {
    const BLADES = Math.max(10, Math.round(veg.grassBlades));
    const count = BLADES * BLADES;
    const cell = veg.grassPatch / BLADES;
    const pos = new Float32Array(count * 9);
    const rnd = new Float32Array(count * 9);
    let b = 0;
    for (let iz = 0; iz < BLADES; iz++) {
      for (let ix = 0; ix < BLADES; ix++, b++) {
        const x = (ix + Math.random()) * cell;
        const z = (iz + Math.random()) * cell;
        const r0 = Math.random(), r1 = Math.random(), r2 = Math.random();
        for (let k = 0; k < 3; k++) {
          const o = b * 9 + k * 3;
          pos[o] = x;
          pos[o + 2] = z;
          rnd[o] = r0;
          rnd[o + 1] = r1;
          rnd[o + 2] = r2;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aGrRnd', new THREE.BufferAttribute(rnd, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return geo;
  }

  private buildMaterial(): THREE.Material {
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    mat.customProgramCacheKey = () => 'grass-field';
    const half = (WORLD_HALF + 0.5).toFixed(1);
    const size = V.toFixed(1);
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec3 aGrRnd;
uniform vec2 uGrCenter;
uniform float uGrTime;
uniform float uGrWind;
uniform float uGrSea;
uniform sampler2D uGrHeight;
uniform sampler2D uGrData;
uniform sampler2D uGrRiver;
uniform sampler2D uGrColor;
uniform float uGrSize;
uniform float uGrHeightK;
uniform float uGrWidth;
uniform float uGrWindK;
varying vec3 vGrCol;
varying float vGrTip;
varying float vGrShade;
float grHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float grNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(grHash(i), grHash(i + vec2(1, 0)), f.x), mix(grHash(i + vec2(0, 1)), grHash(i + vec2(1, 1)), f.x), f.y);
}`
        )
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace(
          '#include <begin_vertex>',
          `// Wrap the blade's fixed root into the square around the patch centre
float GR_SIZE = uGrSize;
vec2 grLocal = mod(position.xz - uGrCenter + GR_SIZE * 0.5, GR_SIZE) - GR_SIZE * 0.5;
vec2 grRoot = uGrCenter + grLocal;
vec2 grUv = (grRoot + ${half}) / ${size};
float grY = texture2D(uGrHeight, grUv).r;
vec4 grD = texture2D(uGrData, grUv);
vGrShade = grD.g;
// Same sand rule as the terrain: none on the beach, the river gravel or under water
vec2 grRiver = texture2D(uGrRiver, grUv).rg;
float grWaterY = grRiver.g > 0.5 ? max(uGrSea, grRiver.r) : uGrSea;
float grBeach = (grRiver.g > 0.5 && grWaterY > uGrSea + 0.3)
  ? smoothstep(grWaterY + 0.32, grWaterY + 0.08, grY) * smoothstep(0.8, 0.97, grRiver.g)
  : smoothstep(grWaterY + 0.55, grWaterY + 0.15, grY);
float grEdge = 1.0 - smoothstep(GR_SIZE * 0.22, GR_SIZE * 0.49, length(grLocal));
float grDens = grD.r * (1.0 - grBeach);
// Height: per blade, clumps of taller and shorter grass, thinning out at density borders
float grClump = grNoise(grRoot * 0.21) * 0.7 + grNoise(grRoot * 0.73 + 5.3) * 0.3;
float grH = uGrHeightK * mix(0.5, 1.0, aGrRnd.x) * (0.45 + grClump * 1.0)
  * smoothstep(0.02, 0.95, grDens) * grEdge;
int grVi = gl_VertexID % 3;
vGrTip = grVi == 2 ? 1.0 : 0.0;
vec3 transformed = vec3(grRoot.x, grY - 0.03, grRoot.y);
if (grH > 0.03) {
  // Turn to face the camera, with a little random yaw
  vec2 grDir = normalize(grRoot - cameraPosition.xz + 1e-4);
  float grA = (aGrRnd.y - 0.5) * 0.9;
  vec2 grSide = vec2(-grDir.y, grDir.x);
  grSide = vec2(grSide.x * cos(grA) - grSide.y * sin(grA), grSide.x * sin(grA) + grSide.y * cos(grA));
  float grW = uGrWidth * mix(0.7, 1.3, aGrRnd.z) * min(1.0, grH * 4.0);
  if (grVi == 0) transformed.xz -= grSide * grW;
  else if (grVi == 1) transformed.xz += grSide * grW;
  else {
    // Tip: a resting lean and the wind (two noise octaves drifting along it)
    vec2 grWindDir = vec2(0.8, 0.6);
    float grGust = grNoise(grRoot * 0.09 - grWindDir * uGrTime * 0.9) * 0.75 + grNoise(grRoot * 0.37 - grWindDir * uGrTime * 2.1) * 0.25;
    vec2 grBend = grWindDir * (grGust - 0.25) * uGrWind * uGrWindK * 1.3;
    grBend += grDir * (aGrRnd.y - 0.5) * 0.5 + grSide * (aGrRnd.z - 0.5) * 0.4;
    grBend += grWindDir * sin(uGrTime * (2.5 + aGrRnd.x * 2.0) + aGrRnd.y * 6.28) * 0.06 * uGrWind * uGrWindK;
    float grB = length(grBend);
    if (grB > 1.4) grBend *= 1.4 / grB;
    // Keep the blade's length: the more it bends, the lower the tip
    transformed.xz += grBend * grH;
    transformed.y += grH * (1.0 - 0.35 * min(dot(grBend, grBend), 1.0));
  }
}
// The terrain's own grass colour at the root (a coarse mip: the average tone, no speckle)
vec3 grCol = textureLod(uGrColor, grRoot * 0.5, 3.0).rgb;
vGrCol = grCol * mix(0.9, 1.1, aGrRnd.z);`
        );
      injectNightLights(shader, { perVertex: true });
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vGrCol;
varying float vGrTip;
varying float vGrShade;
uniform float uGrShadeA;
uniform float uGrShadeB;`
        )
        // Darker at the base (dense blades shade each other), sunlit and a touch warmer at the tip
        .replace(
          '#include <map_fragment>',
          'diffuseColor.rgb *= vGrCol * mix(uGrShadeA, uGrShadeB, vGrTip) * mix(vec3(1.0), vec3(1.06, 1.05, 0.9), vGrTip);'
        )
        // Lit like the ground under it (normal straight up), on both faces
        .replace(
          '#include <normal_fragment_maps>',
          '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);'
        )
        .replace(
          '#include <lights_fragment_end>',
          '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= 1.0 - vGrShade;\nreflectedLight.indirectDiffuse *= 1.0 - vGrShade * 0.3;'
        );
    };
    return mat;
  }
}
