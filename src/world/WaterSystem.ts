import { injectNightLights } from './NightLighting';
import * as THREE from 'three';
import { SEA_FLOOR_Y, WORLD_SIZE, worldSettings } from './WorldSettings';
import type { TerrainSystem } from './TerrainSystem';
import { injectCaustics } from '../scene/WaterEffects';
import { WATER_DETAIL_GLSL, WATER_RIPPLE_GLSL, rippleUniforms, updateWaterDetails } from '../scene/WaterDetails';
import { waterSettings } from './WaterSettings';
import { riverWorld } from './rivers/RiverWorld';
import {
  WATER_LIGHT_GLSL,
  WATER_NORMAL_GLSL,
  SEA_SURFACE_GLSL,
  setWaterBoatHull,
  WATER_SURFACE_GLSL,
  setWaterTerrain,
  updateWaterSurface,
  waterSurfaceUniforms,
} from './WaterSurface';

/** The sea planes follow the camera and stay well beyond the visible horizon. */
const OCEAN_SIZE = 4000;
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
  private boatHull: THREE.Object3D | null = null;
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
${WATER_SURFACE_GLSL}
${SEA_SURFACE_GLSL}`
        )
        .replace(
          '#include <map_fragment>',
          `if (wsInsideBoat(vSeaW)) discard;
vec4 estuary = texture2D(uEstuary, wsBedUv(vSeaW.xz)) * wsInIsland(vSeaW.xz);
if (estuary.a >= 0.5) discard;
diffuseColor = wsSeaSurface(vSeaW, estuary.rg, uOpacity, wsPondTint(vSeaW.xz));`
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
    // Slightly above the terrain floor: the 5 cm cutout overlap hides the square map-edge seam
    // without two nearly coplanar surfaces fighting in the depth buffer.
    this.seabed.position.y = SEA_FLOOR_Y + 0.03;
    this.seabed.frustumCulled = false;
    scene.add(this.seabed);
  }

  /** The terrain whose heights give the water its depth colour and shore lines. */
  public setTerrain(terrain: TerrainSystem): void {
    this.terrain = terrain;
    this.terrainRevision = -1;
    this.bedSand.value = terrain.sandLayer;
  }

  public setBoatHull(hull: THREE.Object3D | null): void {
    this.boatHull = hull;
    setWaterBoatHull(hull);
  }

  /** The opaque sea can occlude land across it, as long as it also clears the camera's near plane. */
  public terrainOcclusionLevel(camera: THREE.PerspectiveCamera): number | null {
    if (!this.mesh.visible || this.material.transparent || waterSettings.transparent) return null;
    const seaLevel = this.mesh.position.y;
    const { x, y, z } = camera.position;
    // Only use the plane when it covers the camera's view, even after a teleport or camera cut.
    const offset = Math.max(Math.abs(x - this.mesh.position.x), Math.abs(z - this.mesh.position.z));
    if (offset + camera.far >= OCEAN_SIZE / 2) return null;
    const p = camera.projectionMatrix.elements;
    const nearReach = camera.near * Math.hypot(1, (1 + Math.abs(p[8])) / p[0], (1 + Math.abs(p[9])) / p[5]);
    if (Math.abs(y - seaLevel) <= nearReach + 0.01) return null;
    const inlandLevel = riverWorld.riverSurfaceAt(x, z);
    if (inlandLevel > seaLevel && y < inlandLevel) return null;
    return seaLevel;
  }

  public update(dt: number, camera?: THREE.Vector3): void {
    const ws = waterSettings;
    setWaterBoatHull(this.boatHull);
    updateWaterSurface(dt);
    this.uOpacity.value = ws.opacity;
    if (this.material.transparent !== ws.transparent) {
      // The opaque/blended variants are different programs, so the material must be rebuilt
      this.material.transparent = ws.transparent;
      this.material.needsUpdate = true;
    }
    updateWaterDetails(dt);
    this.mesh.position.y = worldSettings.waterLevel;
    const bedY = this.terrain?.seaFloorY ?? SEA_FLOOR_Y;
    this.seabed.position.y = bedY + 0.03;
    waterSurfaceUniforms.uWsSeaFloorY.value = bedY;
    if (camera) {
      this.mesh.position.x = this.seabed.position.x = camera.x;
      this.mesh.position.z = this.seabed.position.z = camera.z;
    }
    this.heightTimer -= dt;
    const level = worldSettings.waterLevel;
    if (this.terrain && (this.terrain.revision !== this.terrainRevision || level !== this.terrainLevel) && this.heightTimer <= 0) {
      this.heightTimer = HEIGHT_REFRESH;
      const changes = this.terrain.takeWaterHeightChanges();
      const local = this.terrainRevision >= 0 && this.terrainLevel === level;
      this.terrainRevision = this.terrain.revision;
      this.terrainLevel = level;
      setWaterTerrain(this.terrain.heights, level, local ? changes ?? undefined : undefined);
    }
  }
}
