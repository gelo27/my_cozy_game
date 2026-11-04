import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { injectNightLights } from '../world/NightLighting';
import { CropStage } from './types/FarmingTypes';

const WHEAT_URL = `${import.meta.env.BASE_URL}models/wheat.glb`;

/** Shared clock for the field sway; FarmingManager advances it. */
export const fieldCropTime = { value: 0 };

/**
 * One vertex-coloured material for every field plant. Stalks sway with the square of their height,
 * phase-shifted by the instance position, so the whole field ripples without any per-frame CPU work.
 */
export const FIELD_CROP_MATERIAL = (() => {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    injectNightLights(shader);
    shader.uniforms.uTime = fieldCropTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
{
  vec3 ip = instanceMatrix[3].xyz;
  float h = max(position.y, 0.0);
  float bend = h * h;
  float gust = sin(uTime * 0.6 + ip.x * 0.11 + ip.z * 0.07) * 0.5 + 0.5;
  transformed.x += sin(uTime * 1.9 + ip.x * 0.8 + ip.z * 0.5) * (0.05 + gust * 0.07) * bend;
  transformed.z += cos(uTime * 1.5 + ip.z * 0.9 - ip.x * 0.3) * 0.04 * bend;
}
#endif`
      );
  };
  mat.customProgramCacheKey = () => 'field-crop-sway';
  return mat;
})();

/** Stage colour pairs [stem/ear (dark), leaves/grains (light)] in linear RGB. */
const STAGE_COLORS: Record<CropStage, [THREE.Color, THREE.Color]> = {
  1: [new THREE.Color(0.09, 0.32, 0.04), new THREE.Color(0.2, 0.52, 0.07)],
  2: [new THREE.Color(0.16, 0.4, 0.05), new THREE.Color(0.42, 0.6, 0.1)],
  3: [new THREE.Color(0.708, 0.407, 0.08), new THREE.Color(1.0, 0.791, 0.15)],
};

let stageGeometries: Record<CropStage, THREE.BufferGeometry> | null = null;
let loading: Promise<void> | null = null;

/** The three wheat stage geometries once the GLB has loaded (null until then). */
export function getWheatStageGeometries(): Record<CropStage, THREE.BufferGeometry> | null {
  return stageGeometries;
}

/** Loads the mature wheat model once and derives the sprout and green stages from it. */
export function loadWheatModel(): Promise<void> {
  if (loading) return loading;
  loading = new GLTFLoader()
    .loadAsync(WHEAT_URL)
    .then((gltf) => {
      let source: THREE.BufferGeometry | null = null;
      gltf.scene.traverse((o) => {
        if (!source && (o as THREE.Mesh).isMesh) source = (o as THREE.Mesh).geometry;
      });
      if (!source) throw new Error('wheat.glb has no mesh');
      stageGeometries = {
        1: buildStage(source, 1),
        2: buildStage(source, 2),
        3: buildStage(source, 3),
      };
    })
    .catch((err) => console.warn('[Wheat] model failed to load, fields use procedural wheat', err));
  return loading;
}

/**
 * Stage 3 is the model as authored (only colours re-quantised). Stage 2 is shorter and green with
 * unripe ears; stage 1 is a low, wide green tuft. The light/dark split of the source vertex colours
 * (stalk vs. leaves/grains) is kept so each stage still reads with the same two-tone shading.
 */
function buildStage(source: THREE.BufferGeometry, stage: CropStage): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const srcPos = source.getAttribute('position');
  const srcCol = source.getAttribute('color');
  const count = srcPos.count;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const [dark, light] = STAGE_COLORS[stage];
  const sy = stage === 1 ? 0.32 : stage === 2 ? 0.74 : 1;
  const sxz = stage === 1 ? 1.25 : stage === 2 ? 0.95 : 1;
  for (let i = 0; i < count; i++) {
    pos[i * 3] = srcPos.getX(i) * sxz;
    pos[i * 3 + 1] = srcPos.getY(i) * sy;
    pos[i * 3 + 2] = srcPos.getZ(i) * sxz;
    // Source has two tones: luminance tells stalk (dark) from leaves / grains (light)
    const lum = srcCol ? srcCol.getX(i) * 0.3 + srcCol.getY(i) * 0.6 + srcCol.getZ(i) * 0.1 : 1;
    const t = THREE.MathUtils.clamp((lum - 0.42) / (0.8 - 0.42), 0, 1);
    // Ripe heads fade to green at the base so the field reads less flat
    const shade = stage === 3 ? 1 : 0.78 + 0.22 * Math.min(1, srcPos.getY(i) / 0.8);
    col[i * 3] = (dark.r + (light.r - dark.r) * t) * shade;
    col[i * 3 + 1] = (dark.g + (light.g - dark.g) * t) * shade;
    col[i * 3 + 2] = (dark.b + (light.b - dark.b) * t) * shade;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (source.index) g.setIndex(source.index.clone());
  // Authored normals keep the model's faceted look; the mild stage scaling barely tilts them
  const srcNormal = source.getAttribute('normal');
  if (srcNormal) g.setAttribute('normal', srcNormal.clone());
  else g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
