import * as THREE from 'three';
import { injectNightLights } from './NightLighting';
import { injectWaterline } from '../scene/WaterDetails';

/**
 * Fallen snow on things standing outdoors (tree crowns, bushes, rocks): the faces that look up
 * turn white as WeatherSystem.snowCover builds up, the steeper ones later.
 *
 * Opt-in per material (a global patch would also whiten floors indoors, characters and animals).
 * Worked out per vertex into one varying; the fragment pays a single mix, and nothing at all is
 * computed while there is no snow (the uniform is 0).
 */
// On globalThis so a hot-reloaded copy of this module shares the uniform compiled shaders read
const store = globalThis as { __snowCover?: { value: number } };
export const uSnowCover = (store.__snowCover ??= { value: 0 });

/** 0..1 fallen snow (WeatherSystem.snowCover), once per frame. */
export function setSnowCover(v: number): void {
  uSnowCover.value = v;
}

interface PatchableShader {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

/** Adds the snow cap to a lit built-in shader (after any other vertex patches). Safe to call twice. */
export function injectSnowCover(shader: PatchableShader): void {
  if (shader.vertexShader.includes('uSnowCover')) return;
  if (!shader.vertexShader.includes('#include <project_vertex>') || !shader.fragmentShader.includes('#include <color_fragment>')) return;
  shader.uniforms.uSnowCover = uSnowCover;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uSnowCover;\nvarying float vSnowK;')
    .replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vSnowK = 0.0;
      if (uSnowCover > 0.001) {
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
        // Uneven: some clumps hold more snow than others
        float snNoise = sin(snP.x * 1.7 + sin(snP.z * 1.3)) * sin(snP.z * 1.9 + snP.y * 2.3);
        float snUp = snN.y + snNoise * 0.25;
        // A light dusting only on the flattest tops; a deep cover reaches the steeper sides too
        vSnowK = smoothstep(0.0, 0.25, snUp - 0.85 + uSnowCover * 0.75) * smoothstep(0.0, 0.5, uSnowCover);
      }`
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vSnowK;')
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.87, 0.95), vSnowK * 0.92);');
}

/** For a plain material with no onBeforeCompile of its own: night lights, waterline and snow. */
export function withSnowCover<T extends THREE.Material>(mat: T): T {
  mat.onBeforeCompile = (shader) => {
    injectNightLights(shader);
    injectWaterline(shader);
    injectSnowCover(shader);
  };
  return mat;
}
