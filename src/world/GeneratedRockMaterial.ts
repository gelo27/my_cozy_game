import * as THREE from 'three';
import { PAVING_FLAG } from '../terrain/PavingRules';
import { TerrainTileType as Tile } from '../terrain/types/TerrainTypes';
import { uSnowCover, withSnowCover } from './SnowCover';
import { withVertexLightingQuality } from './VertexLightingQuality';
import { WORLD_HALF, WORLD_SIZE } from './WorldSettings';
import { getRockSurfaceTexture, ROCK_SURFACE_TONE_GLSL } from './RockSurfaceTexture';

export interface RockContactMaps {
  heights: THREE.DataTexture;
  tiles: THREE.DataTexture;
  waterLevel: THREE.IUniform<number>;
}

export function createGeneratedRockMaterial(contact?: RockContactMaps, previewMode?: THREE.IUniform<number>): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  if (contact) withSnowCover(material, 'vRockCover.y');
  const appearance = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    appearance.call(this, shader, renderer);
    shader.uniforms.tRockSurface = { value: getRockSurfaceTexture() };
    if (previewMode) shader.uniforms.uRockCoverPreview = previewMode;
    if (contact) {
      shader.uniforms.tRockHeights = { value: contact.heights };
      shader.uniforms.tRockTiles = { value: contact.tiles };
      shader.uniforms.uRockWaterLevel = contact.waterLevel;
      shader.uniforms.uRockSeasonSnow = uSnowCover;
    }
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
      varying vec3 vRockPosition;
      varying vec3 vRockNormal;
      attribute vec4 aRockCover;
      varying vec4 vRockCover;
      ${contact ? 'varying vec3 vRockWorldPosition;' : ''}`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vRockPosition = transformed;
        vRockNormal = normal;
        vRockCover = aRockCover;
        ${contact ? `vec4 rockPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          rockPosition = instanceMatrix * rockPosition;
        #endif
        vRockWorldPosition = (modelMatrix * rockPosition).xyz;` : ''}`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      uniform sampler2D tRockSurface;
      ${ROCK_SURFACE_TONE_GLSL}
      varying vec3 vRockPosition;
      varying vec3 vRockNormal;
      varying vec4 vRockCover;
      ${previewMode ? 'uniform float uRockCoverPreview;' : ''}
      ${ROCK_COVER_GLSL}
      ${contact ? ROCK_CONTACT_GLSL : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 rockUV = vRockPosition * 0.78;
        vec3 rockWeights = smoothstep(vec3(0.12), vec3(0.9), abs(normalize(vRockNormal)));
        rockWeights /= dot(rockWeights, vec3(1.0));
        vec3 rockDetail = texture2D(tRockSurface, rockUV.zy).rgb * rockWeights.x
                       + texture2D(tRockSurface, rockUV.xz).rgb * rockWeights.y
                       + texture2D(tRockSurface, rockUV.xy).rgb * rockWeights.z;
        diffuseColor.rgb *= rockSurfaceTone(rockDetail);
        ${contact ? 'diffuseColor.rgb = rockGroundContact(diffuseColor.rgb, rockDetail.gb);' : previewMode ? `
        if (uRockCoverPreview > 0.5) {
          diffuseColor.rgb = rockCoverBlend(diffuseColor.rgb, rockDetail.gb, vRockPosition.y,
            1.0 - step(1.5, uRockCoverPreview), step(1.5, uRockCoverPreview));
        }` : ''}`);
  };
  material.customProgramCacheKey = () => contact ? 'generated-rock-terrain' : previewMode ? 'generated-rock-preview-cover' : 'generated-rock-preview';
  return contact ? withVertexLightingQuality(material) : material;
}

const MOSS_TILES = [Tile.GRASS, Tile.DIRT_ROAD, Tile.FALLEN_LEAVES, Tile.DRY_GRASS, Tile.BIRCH_GRASS, Tile.MUD, Tile.FLOWER_GRASS];
const ROCK_COVER_GLSL = `
  vec3 rockCoverBlend(vec3 stone, vec2 detail, float gap, float mossStrength, float snowStrength) {
    float breakup = smoothstep(0.22, 0.62, detail.x);
    float above = max(0.0, gap);
    float nearGround = smoothstep(-0.12, -0.035, gap);
    vec2 reach = vRockCover.zw * mix(0.37, 1.0, breakup);
    vec2 cover = nearGround * (vec2(1.0) - smoothstep(reach * 0.18, reach, vec2(above)));
    vec3 moss = mix(vec3(0.056, 0.091, 0.026), vec3(0.20, 0.29, 0.075), breakup * 0.72 + detail.y * 0.28);
    vec3 snow = mix(vec3(0.64, 0.74, 0.83), vec3(0.9, 0.94, 0.98), detail.y);
    stone = mix(stone, moss, cover.x * mossStrength * vRockCover.x * (0.52 + breakup * 0.38));
    return mix(stone, snow, cover.y * snowStrength * vRockCover.y * 0.96);
  }`;

const ROCK_CONTACT_GLSL = `
  varying vec3 vRockWorldPosition;
  uniform sampler2D tRockHeights;
  uniform sampler2D tRockTiles;
  uniform float uRockWaterLevel;
  uniform float uRockSeasonSnow;

  vec3 rockGroundContact(vec3 stone, vec2 detail) {
    if (max(vRockCover.x, vRockCover.y) <= 0.0) return stone;
    vec2 grid = vRockWorldPosition.xz + ${WORLD_HALF.toFixed(1)};
    if (any(lessThan(grid, vec2(0.0))) || any(greaterThan(grid, vec2(${WORLD_SIZE.toFixed(1)})))) return stone;
    float ground = texture2D(tRockHeights, (grid + 0.5) / ${(WORLD_SIZE + 1).toFixed(1)}).r;
    float gap = vRockWorldPosition.y - ground;
    if (gap > max(vRockCover.z, vRockCover.w) || gap < -0.12 || ground < uRockWaterLevel - 0.045) return stone;

    float tile = mod(floor(texture2D(tRockTiles, grid / ${WORLD_SIZE.toFixed(1)}).r * 255.0 + 0.5), ${PAVING_FLAG.toFixed(1)});
    bool growsMoss = ${MOSS_TILES.map((tile) => `tile == ${tile.toFixed(1)}`).join(' || ')};
    float snow = tile == ${Tile.SNOW.toFixed(1)} ? 1.0 : smoothstep(0.1, 0.55, uRockSeasonSnow);
    return rockCoverBlend(stone, detail, gap, growsMoss ? 1.0 : 0.0, snow);
  }`;
