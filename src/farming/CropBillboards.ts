import * as THREE from 'three';
import atlasUrl from './assets/crop-impostors.png?url';
import frames from './assets/crop-impostors.json';
import { FOLIAGE_NIGHT_LIGHTS, injectNightLights } from '../world/NightLighting';
import { injectPickGlow } from '../world/PickGlow';
import { withVertexLightingQuality } from '../world/VertexLightingQuality';
import type { CropStage, CropType } from './types/FarmingTypes';

const material = new THREE.MeshLambertMaterial({ alphaTest: 0.36 });
material.onBeforeCompile = (shader) => {
  injectNightLights(shader, FOLIAGE_NIGHT_LIGHTS);
  injectPickGlow(shader, 'area');
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      attribute float cropCard;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 root = instanceMatrix[3].xyz;
        vec3 worldRoot = (modelMatrix * vec4(root, 1.0)).xyz;
        vec3 cameraBack = vec3(viewMatrix[0].z, viewMatrix[1].z, viewMatrix[2].z);
        vec3 facing = isOrthographic ? cameraBack : normalize(cameraPosition - worldRoot);
        vec2 flatFacing = facing.xz;
        float flatLength = length(flatFacing);
        vec3 right = flatLength > 0.0001 ? vec3(flatFacing.y, 0.0, -flatFacing.x) / flatLength
          : vec3(viewMatrix[0].x, 0.0, viewMatrix[2].x);
        vec3 up = cross(facing, right);
        // Some leaves project below the root in the bake. Move the card toward the camera
        // just enough to keep that part above the soil without shifting its screen position.
        float groundOffset = max(0.0, -(cropCard * up.y + 0.025)) / max(facing.y, 0.35);
        vec3 offset = right * position.x + up * position.y + facing * groundOffset;
        mat3 axes = mat3(modelMatrix) * mat3(instanceMatrix);
        transformed = transpose(axes) * offset / max(length(axes[1]), 0.0001);
      #endif`);
};
material.customProgramCacheKey = () => 'crop-impostor';
export const CROP_BILLBOARD_MATERIAL = withVertexLightingQuality(material);

const geometries = new Map<string, THREE.BufferGeometry>();
let loading: Promise<void> | undefined;

export function loadCropBillboards(): Promise<void> {
  return loading ??= new THREE.TextureLoader().loadAsync(atlasUrl).then((atlas) => {
    atlas.colorSpace = THREE.SRGBColorSpace;
    material.map = atlas;
    material.needsUpdate = true;
  }).catch((err) => console.warn('[Crops] Impostor atlas failed to load, keeping the field models', err));
}

/** The atlas contains a separately baked and cropped frame for every growth stage. */
export function getCropBillboard(type: CropType, stage: CropStage): THREE.BufferGeometry | null {
  if (!material.map) return null;
  const frame = frames[type]?.[stage - 1];
  if (!frame) return null;
  const key = `${type}:${stage}`;
  const shared = geometries.get(key);
  if (shared) return shared;

  const [left, bottom, right, top] = frame.xy;
  const [x0, y0, x1, y1] = frame.px;
  const u0 = x0 / 1024, u1 = x1 / 1024, v0 = 1 - y1 / 256, v1 = 1 - y0 / 256;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    left, bottom, 0, right, bottom, 0, left, top, 0, right, top, 0,
  ], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u0, v1, u1, v1], 2));
  geometry.setAttribute('cropCard', new THREE.Float32BufferAttribute([bottom, bottom, bottom, bottom], 1));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  // The card rotates around the root and may be nudged forward to clear the ground.
  const radius = Math.hypot(Math.max(Math.abs(left), Math.abs(right)), Math.max(Math.abs(top), Math.abs(bottom)));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius + Math.max(0, -bottom) / 0.35);
  geometries.set(key, geometry);
  return geometry;
}
