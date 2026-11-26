import * as THREE from 'three';
import { WORLD_SIZE } from './WorldSettings';
import { WaterPaintMask } from './WaterPaintMask';

/**
 * Duckweed (ряска) on ponds and lakes: painted by hand in the editor (tool 8), drawn by the
 * shared water shader (WaterSurface.ts), so the sea, lakes and rivers all show it.
 *
 * - Where: one byte per 0.5 m cell over the island (RES² R8 texture, linear filtered), 0 = clean
 *   water .. 255 = a solid carpet. A brush stroke re-uploads only the rows it touched;
 * - Look: a tiling tile of tiny fronds made once at start-up (no asset), sampled twice at
 *   different scales and turns so the repeat does not show. Every cluster of fronds in it has a
 *   rank: a cell with density d shows only the clusters ranked below d, so thin cover breaks into
 *   separate little leaves and thick cover closes into a carpet. Far away the leaves give way to
 *   their average colour (no shimmer);
 * - Cost: one fetch of the small mask per water pixel; two more fetches only where duckweed is.
 */

export const DUCKWEED_RES = 1024;
const HALF = WORLD_SIZE / 2;
/** Size of one frond tile (m) and its texture (px). */
const TILE_M = 0.9;
const TILE_PX = 256;

/** What DUCKWEED_CORE_GLSL reads (the caustics use only these). */
export const duckweedCoreUniforms = {
  uWsWeed: { value: null as THREE.Texture | null },
  /** Pushed-aside field around the player (DuckweedSim.ts): RG displacement (m), B clearance, A pile. */
  uWsWeedSim: { value: null as THREE.Texture | null },
  /** origin x, origin z, 1 / area size, on (0/1) */
  uWsWeedSimArea: { value: new THREE.Vector4(0, 0, 1, 0) },
};

export const duckweedUniforms = {
  ...duckweedCoreUniforms,
  uWsWeedLeaf: { value: null as THREE.Texture | null },
  /** Linear colours: young bright green, older yellowish green. */
  uWsWeedA: { value: new THREE.Color(0x3f8a17) },
  uWsWeedB: { value: new THREE.Color(0x76a024) },
};

/**
 * The painted cover after the push (shared by the water surface and the caustics under it):
 * wsWeedPushed(xz, pile) moves xz by the displacement D and returns the cover 0..1 there, with
 * the crowded rim (pile) denser and the opening cleared. A point with no duckweed of its own
 * returns after one fetch, before the push field is read. Guarded: a shader may get it twice.
 * Needs duckweedCoreUniforms.
 */
export const DUCKWEED_CORE_GLSL = /* glsl */ `
#ifndef WS_WEED_CORE
#define WS_WEED_CORE
uniform sampler2D uWsWeed;
uniform sampler2D uWsWeedSim;
uniform vec4 uWsWeedSimArea;
float wsWeedMask(vec2 xz) {
  float inside = step(abs(xz.x), ${HALF.toFixed(1)}) * step(abs(xz.y), ${HALF.toFixed(1)});
  return texture2D(uWsWeed, (xz + ${HALF.toFixed(1)}) / ${WORLD_SIZE.toFixed(1)}).r * inside;
}
float wsWeedPushed(inout vec2 xz, out float pile) {
  pile = 0.0;
  float m = wsWeedMask(xz);
  if (m < 0.004 || uWsWeedSimArea.w < 0.5) return m;
  vec2 suv = (xz - uWsWeedSimArea.xy) * uWsWeedSimArea.z;
  if (suv.x <= 0.0 || suv.y <= 0.0 || suv.x >= 1.0 || suv.y >= 1.0) return m;
  // Pushed aside by the swimmer: the duckweed of (xz - D) is drawn here, minus what was cleared,
  // and the cover crowded into a rim around the opening is denser
  vec4 push = texture2D(uWsWeedSim, suv);
  pile = push.w;
  if (dot(push.xy, push.xy) > 1e-6) {
    xz -= push.xy;
    m = wsWeedMask(xz);
  }
  return min(1.0, m * (1.0 + pile * 1.5)) * (1.0 - push.z);
}
/** Light let through the duckweed over xz (1 = open water): dimmed and turned green. */
vec3 wsWeedLight(vec2 xz) {
  float pile;
  float m = wsWeedPushed(xz, pile);
  if (m < 0.004) return vec3(1.0);
  float cover = clamp(m * 1.15, 0.0, 1.0);
  return mix(vec3(1.0), vec3(0.3, 0.46, 0.15), cover);
}
#endif
`;

/**
 * Fragment helpers (inside WATER_SURFACE_GLSL, so after wdNoise). Call
 * wsDuckweed(xz, cameraDistance, drift) in map_fragment; it fills wsWeed (0..1 cover) and
 * wsWeedCol. wsWeed stays 0 in shaders that never call it, so the lighting can always read it.
 */
export const DUCKWEED_GLSL = /* glsl */ `
${DUCKWEED_CORE_GLSL}
uniform sampler2D uWsWeedLeaf;
uniform vec3 uWsWeedA;
uniform vec3 uWsWeedB;
float wsWeed = 0.0;
vec3 wsWeedCol = vec3(0.0);
void wsDuckweed(vec2 xz, float dist, vec2 drift) {
  float pile;
  float m = wsWeedPushed(xz, pile);
  if (m < 0.004) return;
  // Ragged, patchy edges where the cover thins out; a full carpet stays whole
  float n = wdNoise(xz * 0.45) * 0.6 + wdNoise(xz * 1.9 + 7.3) * 0.4;
  float dens = clamp(m * 1.15 + (n - 0.5) * 0.7 * (1.0 - m), 0.0, 1.0);
  // Two turned, scaled layers of the frond tile (r cover, g tint, b rank, a lightness)
  vec2 p = (xz + drift) * ${(1 / TILE_M).toFixed(4)};
  vec4 a = texture2D(uWsWeedLeaf, p);
  vec4 b = texture2D(uWsWeedLeaf, mat2(0.8, -0.6, 0.6, 0.8) * p * 1.37 + 0.31);
  float ca = a.r * smoothstep(a.b - 0.04, a.b + 0.04, dens);
  float cb = b.r * smoothstep(b.b - 0.04, b.b + 0.04, dens);
  vec4 top = ca >= cb ? a : b;
  float leaf = 1.0 - (1.0 - ca) * (1.0 - cb);
  vec3 col = mix(uWsWeedA, uWsWeedB, top.g) * mix(0.7, 1.1, top.a);
  // Thick cover closes up: the gaps between the top fronds show more fronds in shade, not water
  float mat = smoothstep(0.55, 0.95, dens);
  vec3 under = uWsWeedA * 0.5;
  float cover = max(leaf, mat * 0.97);
  col = mix(under, col, leaf / max(cover, 1e-3));
  // Crowded fronds overlap and shade each other a little
  col *= 1.0 - 0.18 * pile;
  // Far away: the average cover and colour (the pattern is finer than a pixel there)
  float far = smoothstep(22.0, 70.0, dist);
  wsWeed = mix(cover, min(1.0, dens * 1.1), far);
  wsWeedCol = mix(col, mix(uWsWeedA, uWsWeedB, 0.35) * 0.85, far);
}
`;

// ---------------------------------------------------------------- frond tile

function hash(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Clusters of 1-4 oval fronds, seamless (drawn wrapped), with a rank per cluster. */
function buildLeafTile(): THREE.DataTexture {
  const N = TILE_PX;
  const data = new Uint8Array(N * N * 4);
  // Background: no cover, rank 1 (never shown)
  for (let i = 0; i < N * N; i++) data[i * 4 + 2] = 255;
  const pxPerM = N / TILE_M;
  let seed = 1;
  const rnd = () => hash(seed++);
  const CLUSTERS = 340;
  for (let c = 0; c < CLUSTERS; c++) {
    const cx = rnd() * N;
    const cy = rnd() * N;
    // Ranks spread evenly over the clusters (stratified), so thin cover is still even
    const rank = Math.min(0.98, (c + rnd()) / CLUSTERS);
    const tint = rnd();
    const count = 1 + Math.floor(rnd() * 3.99);
    const baseA = rnd() * Math.PI * 2;
    for (let f = 0; f < count; f++) {
      // Fronds of 4..6 cm (bigger than life, so they read at play distance), budding off the first
      const len = (0.02 + rnd() * 0.01) * pxPerM;
      const wid = len * (0.62 + rnd() * 0.15);
      const ang = baseA + f * (Math.PI * 0.5 + (rnd() - 0.5) * 0.8);
      const off = f === 0 ? 0 : len * 1.25;
      const fx = cx + Math.cos(ang) * off;
      const fy = cy + Math.sin(ang) * off;
      const rot = ang + (rnd() - 0.5) * 0.6;
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      const ext = Math.ceil(len + 2);
      const fTint = Math.min(1, Math.max(0, tint + (rnd() - 0.5) * 0.3));
      for (let dy = -ext; dy <= ext; dy++) {
        for (let dx = -ext; dx <= ext; dx++) {
          const px = Math.floor(fx) + dx;
          const py = Math.floor(fy) + dy;
          const lx = px + 0.5 - fx;
          const ly = py + 0.5 - fy;
          const u = (lx * cr + ly * sr) / len;
          const v = (-lx * sr + ly * cr) / wid;
          const r = Math.sqrt(u * u + v * v);
          // ~1 px soft edge
          const cov = Math.min(1, Math.max(0, (1 - r) * len * 0.8));
          if (cov <= 0) continue;
          const i = ((((py % N) + N) % N) * N + (((px % N) + N) % N)) * 4;
          const prev = data[i] / 255;
          data[i] = Math.round(Math.max(prev, cov) * 255);
          if (cov >= prev * 0.9) {
            data[i + 1] = Math.round(fTint * 255);
            data[i + 2] = Math.round(rank * 255);
            // Lighter centre, a darker rim and a faint midrib dip
            const light = (1 - r * r * 0.6) * (1 - 0.15 * Math.exp(-v * v * 40) * (1 - Math.abs(u)));
            data[i + 3] = Math.round(Math.min(1, Math.max(0, light)) * 255);
          }
        }
      }
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------- the painted mask

export const duckweed = new WaterPaintMask(DUCKWEED_RES);
duckweedCoreUniforms.uWsWeed.value = duckweed.texture;
duckweedUniforms.uWsWeedLeaf.value = buildLeafTile();
