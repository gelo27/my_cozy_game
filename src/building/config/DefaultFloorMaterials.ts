import * as THREE from 'three';
import { createLightPineFloorTexture } from '../textures/FloorTextures';

export const DEFAULT_FLOOR_WALLPAPER_ID = 'floor_light_pine';
export const FLOOR_TRIM_WALLPAPER_ID = 'floor_slab_trim';
export const DEFAULT_FLOOR_TILE_SIZE = 1.8;

const pine = createLightPineFloorTexture();
export const DEFAULT_FLOOR_THUMBNAIL = pine.dataUrl;
export const DEFAULT_FLOOR_MATERIAL = new THREE.MeshLambertMaterial({
  map: pine.texture,
  normalMap: pine.normalMap,
  normalScale: new THREE.Vector2(0.7, 0.7),
});

// The same pattern crosses independently placed slabs and baked chunks, regardless of yaw.
DEFAULT_FLOOR_MATERIAL.onBeforeCompile = function (shader, renderer) {
  // The engine installs indoor shade and night lighting on this hook at startup.
  THREE.Material.prototype.onBeforeCompile.call(this, shader, renderer);
  shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `
    #include <uv_vertex>
    vec2 floorUv = (modelMatrix * vec4(position, 1.0)).xz / ${DEFAULT_FLOOR_TILE_SIZE.toFixed(2)};
    vMapUv = floorUv;
    vNormalMapUv = floorUv;
  `);
};
DEFAULT_FLOOR_MATERIAL.customProgramCacheKey = () => 'floor-pine-world-uv';

export const FLOOR_TRIM_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xe0d2ba });
const trim = FLOOR_TRIM_MATERIAL;
/** BoxGeometry material order is +X, -X, +Y, -Y, +Z, -Z. */
export const DEFAULT_FLOOR_FACES: THREE.Material[] = [trim, trim, DEFAULT_FLOOR_MATERIAL, trim, trim, trim];
