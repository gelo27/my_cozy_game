import { injectNightLights } from './NightLighting';
import * as THREE from 'three';
import { SEA_FLOOR_Y, WORLD_SIZE, worldSettings } from './WorldSettings';
import type { TerrainSystem } from './TerrainSystem';
import { injectCaustics } from '../scene/WaterEffects';
import { WATER_DETAIL_GLSL, WATER_RIPPLE_GLSL, rippleUniforms, updateWaterDetails } from '../scene/WaterDetails';
import { waterSettings } from './WaterSettings';
import {
  WATER_LIGHT_GLSL,
  WATER_NORMAL_GLSL,
  WATER_SHORE_RANGE,
  WATER_SURFACE_GLSL,
  setWaterTerrain,
  updateWaterSurface,
  waterSurfaceUniforms,
} from './WaterSurface';

/** The sea planes follow the camera and reach past the far plane, so the ocean meets the horizon. */
const OCEAN_SIZE = 1200;
const HALF = WORLD_SIZE / 2;
/** Re-upload the bed heights and the shore field at most this often while the terrain is being sculpted (s). */
const HEIGHT_REFRESH = 0.25;

/**
 * The sea: one opaque plane at `worldSettings.waterLevel` (lakes on the island and the open sea),
 * plus a plain sea-bed plane under it. Both follow the camera, so the sea is endless to the eye.
 *
 * Opaque on purpose: no sorting, no blending, no overdraw, and the bottom is never drawn twice.
 * The look (depth colour, waves, glints, shore lines, the view from below) is the shared water
 * surface of WaterSurface.ts, which the rivers and lakes use too; on top of it the sea has a
 * crisp, broken white line where the water meets the land, the ripple rings around the swimmer
 * and the wave simulation near the player (WaterDetails.ts, WaterRippleSim.ts).
 */
export class WaterSystem {
  public readonly mesh: THREE.Mesh;
  private readonly seabed: THREE.Mesh;
  private readonly material: THREE.MeshLambertMaterial;
  private readonly uOpacity = { value: 1 };
  private terrain: TerrainSystem | null = null;
  private terrainRevision = -1;
  private terrainLevel = NaN;
  private heightTimer = 0;
  /** The terrain's sand texture, for the open-sea bed (set with the terrain). */
  private readonly bedSand = { value: null as THREE.Texture | null };

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, 1, 1);
    geo.rotateX(-Math.PI / 2);
    // Seen from below when diving: the underside of the surface must show too
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    mat.customProgramCacheKey = () => 'sea-water';
    mat.onBeforeCompile = (shader) => {
      injectNightLights(shader);
      Object.assign(shader.uniforms, waterSurfaceUniforms, rippleUniforms);
      shader.uniforms.uOpacity = this.uOpacity;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSeaW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeaW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vSeaW;
uniform float uOpacity;
${WATER_DETAIL_GLSL}
${WATER_RIPPLE_GLSL}
${WATER_SURFACE_GLSL}`
        )
        .replace(
          '#include <map_fragment>',
          `// Depth to the bed under this pixel (outside the island: the flat sea bed)
float inIsland = wsInIsland(vSeaW.xz);
float seaDepth = max(vSeaW.y - wsBedY(vSeaW.xz), 0.0);
float seaDist = distance(vSeaW, cameraPosition);
float shade, wobble;
vec2 slope = wsWaves(vSeaW.xz, seaDist, shade, wobble);
// Simulated waves around the player (developer toggle): they tilt the surface, so they catch the sun
float simH;
vec2 simG;
wdSimSample(vSeaW.xz, simH, simG);
slope += simG * uWdSimLook.y;
wsN = normalize(vec3(slope.x, 1.0, slope.y));
vec3 seaCol = wsColour(seaDepth, shade);

// Shore: distance to the nearest land (m) from the shore field; a light band along the shore,
// and the thin dashed lines that drift in toward it
float shoreD = mix(${WATER_SHORE_RANGE.toFixed(1)}, texture2D(uWsShore, wsBedUv(vSeaW.xz)).r * ${WATER_SHORE_RANGE.toFixed(1)}, inIsland);
float shoreAa = fwidth(shoreD);
seaCol = mix(seaCol, uWsShallow * 1.25, (1.0 - smoothstep(0.0, 1.6, shoreD)) * 0.3 * inIsland);
wsFoam = wsShoreLines(shoreD, vSeaW.xz, shoreAa, 0.0, 99.0) * (1.0 - smoothstep(60.0, 140.0, seaDist));
// Where the water touches the land: a thin crisp line, broken into pieces
float lineD = seaDepth + wobble * 0.02;
float lineBreak = smoothstep(0.3, 0.5, wdNoise(vSeaW.xz * 0.9 + uWsTime * 0.04));
wsFoam = max(wsFoam, (1.0 - smoothstep(uWsFoam.x * 0.5, uWsFoam.x * 0.5 + fwidth(lineD) * 1.5 + 0.004, lineD)) * mix(0.35, 1.0, lineBreak));
wsFoam *= inIsland * uWsShine.w;
// Ripple rings from the swimmer, wading legs and splashes
// (derivatives first: the distance test below skips the loop for far pixels)
float seaRipAa = length(fwidth(vSeaW.xz));
float seaSimAa = fwidth(simH);
float seaRip = seaDist < 80.0 ? wdRipples(vSeaW.xz, seaRipAa) * (1.0 - smoothstep(45.0, 80.0, seaDist)) : 0.0;
wsFoam = clamp(max(wsFoam, max(seaRip * 0.9, wdSimCrest(simH, seaSimAa))), 0.0, 1.0);
diffuseColor.rgb = mix(seaCol, uWsFoamCol, wsFoam);
diffuseColor.a = max(uOpacity, wsFoam);`
        )
        .replace('#include <normal_fragment_maps>', WATER_NORMAL_GLSL)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${WATER_LIGHT_GLSL}`);
    };
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'Water';
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    const bedGeo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, 1, 1);
    bedGeo.rotateX(-Math.PI / 2);
    // Past the map edge the bed continues the terrain's own sea floor seamlessly: the same sand
    // texture at the same scale, the same under-water darkening, caustics and night lights, at the
    // same height. Over the island it is cut away (the terrain is there), save a 5 cm overlap that
    // hides any hairline crack along the edge.
    const bedMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    bedMat.customProgramCacheKey = () => 'sea-bed';
    bedMat.onBeforeCompile = (shader) => {
      injectNightLights(shader);
      injectCaustics(shader);
      shader.uniforms.uBedSand = this.bedSand;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uBedSand;')
        .replace(
          '#include <map_fragment>',
          `if (max(abs(vCauPos.x), abs(vCauPos.z)) < ${(HALF - 0.05).toFixed(2)}) discard;
diffuseColor.rgb *= texture2D(uBedSand, vCauPos.xz * 0.5).rgb
  * mix(1.0, 0.62, smoothstep(uCausticsSea, uCausticsSea - 1.5, vCauPos.y));`
        );
    };
    this.seabed = new THREE.Mesh(bedGeo, bedMat);
    this.seabed.name = 'SeaBed';
    // A hair under the terrain's lowest height, so the overlap strip never z-fights
    this.seabed.position.y = SEA_FLOOR_Y - 0.01;
    this.seabed.frustumCulled = false;
    scene.add(this.seabed);
  }

  /** The terrain whose heights give the water its depth colour and shore lines. */
  public setTerrain(terrain: TerrainSystem): void {
    this.terrain = terrain;
    this.terrainRevision = -1;
    this.bedSand.value = terrain.sandLayer;
  }

  public update(dt: number, camera?: THREE.Vector3): void {
    const ws = waterSettings;
    updateWaterSurface(dt);
    this.uOpacity.value = ws.opacity;
    if (this.material.transparent !== ws.transparent) {
      // The opaque/blended variants are different programs, so the material must be rebuilt
      this.material.transparent = ws.transparent;
      this.material.needsUpdate = true;
    }
    updateWaterDetails(dt);
    this.mesh.position.y = worldSettings.waterLevel;
    if (camera) {
      this.mesh.position.x = this.seabed.position.x = camera.x;
      this.mesh.position.z = this.seabed.position.z = camera.z;
    }
    this.heightTimer -= dt;
    const level = worldSettings.waterLevel;
    if (this.terrain && (this.terrain.revision !== this.terrainRevision || level !== this.terrainLevel) && this.heightTimer <= 0) {
      this.heightTimer = HEIGHT_REFRESH;
      this.terrainRevision = this.terrain.revision;
      this.terrainLevel = level;
      setWaterTerrain(this.terrain.heights, level);
    }
  }
}
