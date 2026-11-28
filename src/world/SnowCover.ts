import * as THREE from 'three';
import { injectNightLights } from './NightLighting';
import { injectWaterline } from '../scene/WaterDetails';
import { TerrainTileType } from '../terrain/types/TerrainTypes';
import { WORLD_HALF, WORLD_SIZE } from './WorldSettings';

/**
 * Fallen snow on things standing outdoors (tree crowns, bushes, rocks): the faces that look up
 * turn white as WeatherSystem.snowCover builds up, the steeper ones later. Where the ground is
 * painted with snow tiles they wear a full cap whatever the weather (the snow mask below).
 *
 * Opt-in per material (a global patch would also whiten floors indoors, characters and animals).
 * Worked out per vertex into one varying; the fragment pays a single mix, and nothing at all is
 * computed while there is no snow (no fallen snow and no snow tile anywhere on the map).
 */
const N = WORLD_SIZE;

interface SnowStore {
  cover: { value: number };
  maskOn: { value: number };
  mask: { value: THREE.DataTexture };
  maskData: Uint8Array;
  /** Snow tiles on the map (the mask is skipped altogether while there are none). */
  maskCount: number;
  /** A whole-texture upload is queued: no partial ranges on top of it (see TerrainSystem). */
  maskFullPending: boolean;
  outdoors: boolean;
}

function createStore(): SnowStore {
  const data = new Uint8Array(N * N);
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  // Linear: a soft 1 m edge at the border of a snowy patch
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  const s: SnowStore = {
    cover: { value: 0 },
    maskOn: { value: 0 },
    mask: { value: tex },
    maskData: data,
    maskCount: 0,
    maskFullPending: true,
    outdoors: true,
  };
  tex.onUpdate = () => { s.maskFullPending = false; };
  return s;
}

// On globalThis so a hot-reloaded copy of this module shares the uniforms compiled shaders read
const store = globalThis as { __snowStore?: SnowStore };
const snow = (store.__snowStore ??= createStore());
export const uSnowCover = snow.cover;

/** 0..1 fallen snow (WeatherSystem.snowCover), once per frame; `outdoors` false in caves. */
export function setSnowCover(v: number, outdoors = true): void {
  snow.cover.value = outdoors ? v : 0;
  snow.outdoors = outdoors;
  snow.maskOn.value = outdoors && snow.maskCount > 0 ? 1 : 0;
}

/**
 * Re-reads the snow tiles of the inclusive cell rect from the terrain's `tiles` (N x N, one byte
 * per 1 m cell) into the mask; only the changed rows are re-uploaded.
 */
export function updateSnowMask(tiles: Uint8Array, x0: number, z0: number, x1: number, z1: number): void {
  const d = snow.maskData;
  let delta = 0;
  let changedRows = 0;
  let rowLo = N, rowHi = -1;
  for (let z = z0; z <= z1; z++) {
    let rowChanged = false;
    for (let x = x0, i = z * N + x0; x <= x1; x++, i++) {
      const v = tiles[i] === TerrainTileType.SNOW ? 255 : 0;
      if (d[i] === v) continue;
      delta += v ? 1 : -1;
      d[i] = v;
      rowChanged = true;
    }
    if (rowChanged) {
      changedRows++;
      rowLo = Math.min(rowLo, z);
      rowHi = Math.max(rowHi, z);
    }
  }
  if (!changedRows) return;
  snow.maskCount += delta;
  snow.maskOn.value = snow.outdoors && snow.maskCount > 0 ? 1 : 0;
  const tex = snow.mask.value;
  if (snow.maskFullPending || (rowHi - rowLo + 1) * (x1 - x0 + 1) > (N * N) / 4) {
    tex.clearUpdateRanges();
    snow.maskFullPending = true;
  } else {
    // three.js reads update ranges as RGBA components (stride 4) even for an R8 texture
    const count = (x1 - x0 + 1) * 4;
    for (let z = rowLo; z <= rowHi; z++) tex.addUpdateRange((z * N + x0) * 4, count);
  }
  tex.needsUpdate = true;
}

interface PatchableShader {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

/** Adds the snow cap to a lit built-in shader (after any other vertex patches). Safe to call twice. */
export function injectSnowCover(shader: PatchableShader, strength = '1.0'): void {
  if (shader.vertexShader.includes('uSnowCover')) return;
  if (!shader.vertexShader.includes('#include <project_vertex>') || !shader.fragmentShader.includes('#include <color_fragment>')) return;
  shader.uniforms.uSnowCover = snow.cover;
  shader.uniforms.uSnowMaskOn = snow.maskOn;
  shader.uniforms.tSnowMask = snow.mask;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uSnowCover;\nuniform float uSnowMaskOn;\nuniform sampler2D tSnowMask;\nvarying float vSnowK;')
    .replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vSnowK = 0.0;
      if (uSnowCover > 0.001 || uSnowMaskOn > 0.5) {
        vec3 snN = objectNormal;
        vec4 snP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          snN = mat3(instanceMatrix) * snN;
          snP = instanceMatrix * snP;
        #endif
        #ifdef USE_BATCHING
          snN = mat3(batchingMatrix) * snN;
          snP = batchingMatrix * snP;
        #endif
        snN = normalize(mat3(modelMatrix) * snN);
        snP = modelMatrix * snP;
        // Painted snow tiles under this vertex: a full winter cap there, whatever the weather
        float snCov = uSnowCover;
        if (uSnowMaskOn > 0.5) snCov = max(snCov, texture2D(tSnowMask, (snP.xz + ${WORLD_HALF.toFixed(1)}) / ${N.toFixed(1)}).r);
        // Uneven: some clumps hold more snow than others
        float snNoise = sin(snP.x * 1.7 + sin(snP.z * 1.3)) * sin(snP.z * 1.9 + snP.y * 2.3);
        float snUp = snN.y + snNoise * 0.25;
        // A light dusting only on the flattest tops; a deep cover reaches the steeper sides too
        vSnowK = smoothstep(0.0, 0.25, snUp - 0.85 + snCov * 0.75) * smoothstep(0.0, 0.5, snCov);
      }`
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vSnowK;')
    .replace('#include <color_fragment>', `#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.87, 0.95), vSnowK * 0.92 * (${strength}));`);
}

/** For a plain material with no onBeforeCompile of its own: night lights, waterline and snow. */
export function withSnowCover<T extends THREE.Material>(mat: T, strength?: string): T {
  mat.onBeforeCompile = (shader) => {
    injectNightLights(shader, { playerShadow: true });
    injectWaterline(shader);
    injectSnowCover(shader, strength);
  };
  return mat;
}
