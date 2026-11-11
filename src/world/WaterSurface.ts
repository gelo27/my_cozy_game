import * as THREE from 'three';
import { SEA_FLOOR_Y, WORLD_SIZE } from './WorldSettings';
import { waterSettings } from './WaterSettings';

/**
 * The one water look, shared by the sea (WaterSystem) and the rivers / lakes (RiverSystem):
 * - colour by real depth: the terrain heights are kept in a half-float texture, so every water
 *   pixel (sea, river or lake: river beds are carved into the same terrain) knows how far down
 *   the bed is: turquoise shallows, deep blue further out;
 * - waves: two scrolling samples of a normal map tilt the surface normal, which drives the
 *   diffuse light, a sharp sun glint and a Fresnel sky reflection at grazing angles; the detail
 *   calms down with distance. Rivers sample it in their own (across, along) metres, scrolled
 *   downstream, and turn the slope back into world space with the flow direction;
 * - shore lines: thin white strokes parallel to the shore that drift in, thin out and vanish,
 *   cut into tapered dashes (both ends narrow to nothing). They are drawn at a distance from the
 *   shore in metres: for the sea from a distance-to-shore texture built from the terrain, for a
 *   river from its bank distance (an attribute), so they hug the coastline evenly whatever the
 *   slope of the bed;
 * - from below (camera under water) the surface is a dim ceiling with a bright Snell's window.
 */

const HALF = WORLD_SIZE / 2;
const V = WORLD_SIZE + 1;
/** Shore distance texture covers 0..SHORE_RANGE metres (bytes, linear filtered). */
const SHORE_RANGE = 8;

export const waterSurfaceUniforms = {
  uWsTime: { value: 0 },
  uWsNormals: { value: null as THREE.Texture | null },
  /** Terrain heights (m, half float), one texel per terrain vertex. */
  uWsBed: { value: null as THREE.Texture | null },
  /** Distance to the nearest shore (0..1 = 0..SHORE_RANGE m), for the sea's shore lines. */
  uWsShore: { value: null as THREE.Texture | null },
  uWsShallow: { value: new THREE.Color() },
  uWsDeep: { value: new THREE.Color() },
  uWsFoamCol: { value: new THREE.Color() },
  /** x depthFalloff, y waveNear, z waveFar, w waveSpeed */
  uWsWaveA: { value: new THREE.Vector4() },
  /** x scale1, y scale2, z detailStart, w detailEnd */
  uWsWaveB: { value: new THREE.Vector4() },
  /** x fresnel, y glint, z glintSharpness, w foamAmount */
  uWsShine: { value: new THREE.Vector4() },
  /** x waterline (m of depth), y shore lines on (0/1), z cycles per second */
  uWsFoam: { value: new THREE.Vector3() },
  /** x line count, y half width (m), z reach (m), w dash density (1/m) */
  uWsShoreA: { value: new THREE.Vector4() },
  /** x gap 0..1 */
  uWsShoreB: { value: new THREE.Vector4() },
};

const normals = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}water_normals.jpg`);
normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
normals.colorSpace = THREE.NoColorSpace;
normals.anisotropy = 4;
waterSurfaceUniforms.uWsNormals.value = normals;

/** Per frame: the clock, and the developer-panel settings into the uniforms. */
export function updateWaterSurface(dt: number): void {
  const u = waterSurfaceUniforms;
  const ws = waterSettings;
  u.uWsTime.value += dt;
  u.uWsShallow.value.set(ws.shallowColor);
  u.uWsDeep.value.set(ws.deepColor);
  u.uWsFoamCol.value.set(ws.foamColor);
  u.uWsWaveA.value.set(ws.depthFalloff, ws.waveNear, ws.waveFar, ws.waveSpeed);
  u.uWsWaveB.value.set(ws.waveScale1, ws.waveScale2, ws.detailStart, Math.max(ws.detailEnd, ws.detailStart + 1));
  u.uWsShine.value.set(ws.fresnel, ws.glint, ws.glintSharpness, ws.foamAmount);
  u.uWsFoam.value.set(ws.foamLine, ws.rippleFoam ? 1 : 0, ws.rippleSpeed);
  u.uWsShoreA.value.set(Math.round(ws.shoreLineCount), ws.shoreLineWidth, ws.shoreLineReach, ws.shoreLineDash);
  u.uWsShoreB.value.set(ws.shoreLineGap, 0, 0, 0);
}

/**
 * Declarations and helpers (fragment shader, after #include <common>; needs WATER_DETAIL_GLSL
 * for wdNoise). Globals wsN / wsFoam are filled in map_fragment and read by the lighting.
 */
export const WATER_SURFACE_GLSL = /* glsl */ `
uniform float uWsTime;
uniform sampler2D uWsNormals;
uniform sampler2D uWsBed;
uniform sampler2D uWsShore;
uniform vec3 uWsShallow;
uniform vec3 uWsDeep;
uniform vec3 uWsFoamCol;
uniform vec4 uWsWaveA;
uniform vec4 uWsWaveB;
uniform vec4 uWsShine;
uniform vec3 uWsFoam;
uniform vec4 uWsShoreA;
uniform vec4 uWsShoreB;
vec3 wsN;
float wsFoam;
/** Terrain texture uv of a world point, and 1 inside the island / 0 outside. */
vec2 wsBedUv(vec2 xz) { return (xz + ${(HALF + 0.5).toFixed(1)}) / ${V.toFixed(1)}; }
float wsInIsland(vec2 xz) { return step(abs(xz.x), ${HALF.toFixed(1)}) * step(abs(xz.y), ${HALF.toFixed(1)}); }
/** Height of the bed under a point (outside the island: the flat sea floor). */
float wsBedY(vec2 xz) { return mix(${SEA_FLOOR_Y.toFixed(2)}, texture2D(uWsBed, wsBedUv(xz)).r, wsInIsland(xz)); }
/**
 * Wave slope at p (in the frame p is measured in), calmer with camera distance; shade = a little
 * light / dark from the waves, wob = a small wobble for edges.
 */
vec2 wsWaves(vec2 p, float dist, out float shade, out float wob) {
  float detail = 1.0 - smoothstep(uWsWaveB.z, uWsWaveB.w, dist);
  vec3 n1 = texture2D(uWsNormals, p * uWsWaveB.x + uWsTime * uWsWaveA.w * vec2(0.011, 0.007)).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(uWsNormals, p * uWsWaveB.y + uWsTime * uWsWaveA.w * vec2(-0.015, 0.010)).xyz * 2.0 - 1.0;
  shade = 0.94 + (n1.z + n2.z) * 0.04;
  wob = (n1.x + n2.y) * 0.6;
  return (n1.xy * 0.6 + n2.xy * 0.4) * mix(uWsWaveA.z, uWsWaveA.y, detail);
}
/** Shallow turquoise -> deep blue (linear colours). */
vec3 wsColour(float depth, float shade) {
  return mix(uWsShallow, uWsDeep, 1.0 - exp(-depth * uWsWaveA.x)) * shade;
}
/**
 * Shore lines at d metres from the shore. dashP = where along the shore (world xz, or metres
 * along a river bank), aa = fwidth(d). Each line is born at the reach, drifts in, grows and thins
 * to nothing; it is cut into dashes whose width eases to zero at both ends. reachMax caps how far
 * out lines are born (a narrow river: well short of the middle). No derivatives inside.
 */
float wsShoreLines(float d, vec2 dashP, float aa, float seed, float reachMax) {
  float reach = min(uWsShoreA.z, reachMax);
  if (uWsFoam.y < 0.5 || reach < 0.05 || d > reach + 0.6) return 0.0;
  aa = max(aa, 1e-4);
  float v = 0.0;
  for (int k = 0; k < 4; k++) {
    if (float(k) >= uWsShoreA.x) break;
    float c = uWsTime * uWsFoam.z * 0.5 + float(k) / uWsShoreA.x;
    float ph = fract(c);
    float gen = floor(c) + seed + float(k) * 7.31;
    // A gentle meander, so the line is not a perfect offset of the shore
    float wob = (wdNoise(dashP * 0.35 + gen * 3.1) - 0.5) * 0.3;
    float lineD = 0.3 + reach * (1.0 - ph) + wob * min(1.0, reach);
    float life = sin(3.14159265 * ph);
    float n = wdNoise(dashP * uWsShoreA.w + vec2(gen * 13.7, gen * 5.3));
    float taper = smoothstep(uWsShoreB.x, uWsShoreB.x + 0.25, n);
    float hw = uWsShoreA.y * life * taper;
    float dd = abs(d - lineD);
    v = max(v, (1.0 - smoothstep(hw, hw + aa, dd)) * min(1.0, 2.0 * hw / aa));
  }
  // Lines thinner than a pixel far away: fade instead of flicker
  return v * (1.0 - smoothstep(0.06, 0.2, aa));
}
`;

/** The surface normal (world wsN) into the view space normal; flipped for the underside. */
export const WATER_NORMAL_GLSL = /* glsl */ `
normal = normalize((viewMatrix * vec4(gl_FrontFacing ? wsN : -wsN, 0.0)).xyz);`;

/** Added after #include <lights_fragment_end>: sky reflection, sun glint, the view from below. */
export const WATER_LIGHT_GLSL = /* glsl */ `
vec3 wsV = normalize(vViewPosition);
float wsNV = clamp(dot(normal, wsV), 0.0, 1.0);
vec3 wsSky = ambientLightColor;
#if NUM_HEMI_LIGHTS > 0
wsSky += hemisphereLights[0].skyColor;
#endif
if (gl_FrontFacing) {
  // Fresnel: grazing angles mirror the sky
  float fres = 0.02 + uWsShine.x * pow(1.0 - wsNV, 5.0);
  totalEmissiveRadiance += wsSky * vec3(0.55, 0.75, 0.95) * fres * (1.0 - wsFoam);
  #if NUM_DIR_LIGHTS > 0
  // Sun glint: a sharp highlight plus a soft sheen around it
  float nh = max(dot(normal, normalize(directionalLights[0].direction + wsV)), 0.0);
  totalEmissiveRadiance += directionalLights[0].color * csSun * (pow(nh, uWsShine.z) * uWsShine.y + pow(nh, 48.0) * 0.12) * (1.0 - wsFoam);
  #endif
} else {
  // From below: a dim ceiling, with the bright Snell's window straight overhead
  float window = smoothstep(0.55, 0.9, wsNV);
  totalEmissiveRadiance += wsSky * vec3(0.12, 0.45, 0.55) * (0.15 + window * 0.9);
}`;

// ---------------------------------------------------------------- bed and shore textures

const bedData = new Uint16Array(V * V);
const bedTex = new THREE.DataTexture(bedData, V, V, THREE.RedFormat, THREE.HalfFloatType);
bedTex.magFilter = bedTex.minFilter = THREE.LinearFilter;
bedTex.colorSpace = THREE.NoColorSpace;
bedTex.unpackAlignment = 2;
bedData.fill(THREE.DataUtils.toHalfFloat(SEA_FLOOR_Y));
bedTex.needsUpdate = true;
waterSurfaceUniforms.uWsBed.value = bedTex;

const shoreData = new Uint8Array(V * V).fill(255);
const shoreTex = new THREE.DataTexture(shoreData, V, V, THREE.RedFormat, THREE.UnsignedByteType);
shoreTex.magFilter = shoreTex.minFilter = THREE.LinearFilter;
shoreTex.colorSpace = THREE.NoColorSpace;
shoreTex.unpackAlignment = 1; // 513-byte rows
shoreTex.needsUpdate = true;
waterSurfaceUniforms.uWsShore.value = shoreTex;

/** SHORE_RANGE in metres, for the shader's decode. */
export const WATER_SHORE_RANGE = SHORE_RANGE;

// Scratch for the distance transform
const INF = 1e20;
const grid = new Float64Array(V * V);
const f1 = new Float64Array(V);
const d1 = new Float64Array(V);
const vIdx = new Int32Array(V);
const zB = new Float64Array(V + 1);
const blurA = new Float32Array(V * V);

/** Felzenszwalb & Huttenlocher 1D squared distance transform of f (length n) into d. */
function edt1d(f: Float64Array, d: Float64Array, n: number): void {
  let k = 0;
  vIdx[0] = 0;
  zB[0] = -INF;
  zB[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[vIdx[k]] + vIdx[k] * vIdx[k])) / (2 * q - 2 * vIdx[k]);
    while (s <= zB[k]) {
      k--;
      s = ((f[q] + q * q) - (f[vIdx[k]] + vIdx[k] * vIdx[k])) / (2 * q - 2 * vIdx[k]);
    }
    k++;
    vIdx[k] = q;
    zB[k] = s;
    zB[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (zB[k + 1] < q) k++;
    const dq = q - vIdx[k];
    d[q] = dq * dq + f[vIdx[k]];
  }
}

/**
 * New terrain heights (one per terrain vertex, 1 m apart) and sea level: re-uploads the bed
 * heights and rebuilds the distance-to-shore field (exact Euclidean distance transform from the
 * land vertices, made smooth with two small blurs so the shore lines follow flowing curves
 * instead of the 1 m grid). A few milliseconds; done only when the terrain or the level changes.
 */
export function setWaterTerrain(heights: Float32Array | number[], seaLevel: number): void {
  const n = V * V;
  for (let i = 0; i < n; i++) {
    bedData[i] = THREE.DataUtils.toHalfFloat(heights[i]);
    grid[i] = heights[i] >= seaLevel ? 0 : INF;
  }
  bedTex.needsUpdate = true;
  // Columns, then rows
  for (let x = 0; x < V; x++) {
    for (let y = 0; y < V; y++) f1[y] = grid[y * V + x];
    edt1d(f1, d1, V);
    for (let y = 0; y < V; y++) grid[y * V + x] = d1[y];
  }
  for (let y = 0; y < V; y++) {
    const row = y * V;
    for (let x = 0; x < V; x++) f1[x] = grid[row + x];
    edt1d(f1, d1, V);
    for (let x = 0; x < V; x++) grid[row + x] = d1[x];
  }
  // Distance in metres; the shore itself lies about half a cell short of the nearest land vertex
  const field = blurA;
  for (let i = 0; i < n; i++) field[i] = Math.min(SHORE_RANGE, Math.max(0, Math.sqrt(grid[i]) - 0.5));
  // Two 3×3 box blurs (separable) round off the grid's staircase
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < V; y++) {
      const row = y * V;
      let prev = field[row];
      for (let x = 0; x < V; x++) {
        const cur = field[row + x];
        const next = x + 1 < V ? field[row + x + 1] : cur;
        field[row + x] = (prev + cur + next) / 3;
        prev = cur;
      }
    }
    for (let x = 0; x < V; x++) {
      let prev = field[x];
      for (let y = 0; y < V; y++) {
        const i = y * V + x;
        const cur = field[i];
        const next = y + 1 < V ? field[i + V] : cur;
        field[i] = (prev + cur + next) / 3;
        prev = cur;
      }
    }
  }
  for (let i = 0; i < n; i++) shoreData[i] = Math.round((field[i] / SHORE_RANGE) * 255);
  shoreTex.needsUpdate = true;
}
