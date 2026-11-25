import * as THREE from 'three';
import atlasUrl from './assets/tree-impostors.png?url';
import frames from './assets/tree-impostors.json';
import { injectWaterline } from '../scene/WaterDetails';
import { FOLIAGE_NIGHT_LIGHTS, injectNightLights } from './NightLighting';
import { injectSnowCover } from './SnowCover';
import { withVertexLightingQuality } from './VertexLightingQuality';

const ATLAS_SIZE = 512;
const geometries = new Map<string, THREE.BufferGeometry>();
const material = new THREE.MeshLambertMaterial({ alphaTest: 0.42 });
material.onBeforeCompile = (shader) => {
  injectNightLights(shader, FOLIAGE_NIGHT_LIGHTS);
  injectWaterline(shader);
  injectSnowCover(shader);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      attribute vec3 treeHighPlane;
      attribute vec2 treeHighUv;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 treeOrigin = (modelMatrix * instanceMatrix[3]).xyz;
        vec3 treeX = mat3(modelMatrix) * instanceMatrix[0].xyz;
        vec3 treeZ = mat3(modelMatrix) * instanceMatrix[2].xyz;
        float treeScale = length(mat3(modelMatrix) * instanceMatrix[1].xyz);
        vec3 eye = isOrthographic
          ? vec3(viewMatrix[0].z, viewMatrix[1].z, viewMatrix[2].z)
          : cameraPosition - treeOrigin - vec3(0.0, 3.5 * treeScale, 0.0);
        float horizontal = length(eye.xz);
        vec2 right = horizontal > 0.0001 ? vec2(eye.z, -eye.x) / horizontal : vec2(1.0, 0.0);
        // The two images were baked at 16 and 39 degrees. Spread the change slightly across trees.
        float stagger = fract(dot(treeOrigin.xz, vec2(0.317, 0.487)));
        bool highView = eye.y > horizontal * mix(0.49, 0.56, stagger);
        vec2 plane = highView ? treeHighPlane.xy : position.xy;
        if (highView) vMapUv = treeHighUv;
        transformed = vec3(dot(normalize(treeX).xz, right) * plane.x, plane.y,
          dot(normalize(treeZ).xz, right) * plane.x);
      #endif`)
    .replace('vec3 snN = objectNormal;', 'vec3 snN = vec3(0.0, treeHighPlane.z, 1.0 - treeHighPlane.z);');
};
material.customProgramCacheKey = () => 'tree-impostor';
export const TREE_BILLBOARD_MATERIAL = withVertexLightingQuality(material);

export async function loadTreeBillboards(): Promise<void> {
  try {
    const atlas = await new THREE.TextureLoader().loadAsync(atlasUrl);
    atlas.colorSpace = THREE.SRGBColorSpace;
    material.map = atlas;
    material.needsUpdate = true;
  } catch (err) {
    console.warn('[Trees] Impostor atlas failed to load, keeping the distant mesh', err);
  }
}

/** Each frame is split into two fitted, coplanar quads with a common horizontal edge. */
export function getTreeBillboard(type: string): THREE.BufferGeometry | null {
  const shared = geometries.get(type);
  if (shared) return shared;
  const views = frames[type as keyof typeof frames];
  if (!material.map || !views) return null;
  const positions: number[] = [], highPositions: number[] = [];
  const uvs: number[] = [], highUvs: number[] = [], normals: number[] = [];
  for (let part = 0; part < 2; part++) {
    for (let corner = 0; corner < 4; corner++) {
      const right = corner % 2 === 1, top = corner >= 2;
      const x = right ? 2 : 0, y = top ? 3 : 1;
      const low = views[0][part], high = views[1][part];
      positions.push(low.xy[x], low.xy[y], 0);
      highPositions.push(high.xy[x], high.xy[y], part === 1 && top ? 1 : 0);
      normals.push(0, 1, 0);
      // Pixel rectangles are in PNG coordinates, with the origin at the top left.
      const v = top ? 1 : 3;
      uvs.push(low.px[x] / ATLAS_SIZE, 1 - low.px[v] / ATLAS_SIZE);
      highUvs.push(high.px[x] / ATLAS_SIZE, 1 - high.px[v] / ATLAS_SIZE);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('treeHighPlane', new THREE.Float32BufferAttribute(highPositions, 3));
  geometry.setAttribute('treeHighUv', new THREE.Float32BufferAttribute(highUvs, 2));
  geometry.setIndex([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
  geometry.addGroup(0, 12, 0);
  geometry.computeBoundingSphere();
  geometries.set(type, geometry);
  return geometry;
}
