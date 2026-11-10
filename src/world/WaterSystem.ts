import { injectNightLights } from './NightLighting';
import * as THREE from 'three';
import { SEA_FLOOR_Y, WORLD_SIZE, worldSettings } from './WorldSettings';
import type { TerrainSystem } from './TerrainSystem';
import { injectCaustics } from '../scene/WaterEffects';
import { WATER_DETAIL_GLSL, WATER_RIPPLE_GLSL, rippleUniforms, updateWaterDetails } from '../scene/WaterDetails';
import { waterSettings } from './WaterSettings';

/** The sea planes follow the camera and reach past the far plane, so the ocean meets the horizon. */
const OCEAN_SIZE = 1200;
const HALF = WORLD_SIZE / 2;
const V = WORLD_SIZE + 1;
/** Bed heights are stored as bytes: h = byte / 16 - HEIGHT_OFFSET (1/16 m steps, -12.75 .. +3.2 m). */
const HEIGHT_OFFSET = 12.75;
/** Re-upload the bed heights at most this often while the terrain is being sculpted (s). */
const HEIGHT_REFRESH = 0.25;

/**
 * The sea: one opaque plane at `worldSettings.waterLevel` (lakes on the island and the open sea),
 * plus a plain sea-bed plane under it. Both follow the camera, so the sea is endless to the eye.
 *
 * Opaque on purpose: no sorting, no blending, no overdraw, and the bottom is never drawn twice.
 * What makes it read as water instead of a blue floor (all in one fragment pass, 3 fetches):
 * - colour by real depth: the terrain heights are kept in a small byte texture, so each pixel
 *   knows how far down the bed is: turquoise shallows, deep blue further out (no depth pre-pass);
 * - waves: two scrolling samples of a normal map tilt the surface normal, which drives the
 *   diffuse light, a sharp sun glint and a Fresnel sky reflection at grazing angles; the detail
 *   calms down with distance, so far water does not shimmer;
 * - shore foam: a crisp white line where the water meets the land and broken ripple bands that
 *   drift in, plus rain rings while it rains and ripple rings around the swimmer / wader
 *   (WaterDetails.ts);
 * - from below (camera under water) the surface is a dim ceiling with a bright Snell's window.
 */
export class WaterSystem {
  public readonly mesh: THREE.Mesh;
  private readonly seabed: THREE.Mesh;
  private readonly material: THREE.MeshLambertMaterial;
  private readonly uniforms = {
    uTime: { value: 0 },
    uWaterNormals: { value: null as THREE.Texture | null },
    uBedHeight: { value: null as THREE.Texture | null },
    /** 0..1: rain rings on the surface. */
    uRain: { value: 0 },
    /** Dev-panel tunables (see WaterSettings.ts). */
    uShallow: { value: new THREE.Color() },
    uDeep: { value: new THREE.Color() },
    uFoamCol: { value: new THREE.Color() },
    /** x depthFalloff, y waveNear, z waveFar, w waveSpeed */
    uWaveA: { value: new THREE.Vector4() },
    /** x scale1, y scale2, z detailStart, w detailEnd */
    uWaveB: { value: new THREE.Vector4() },
    /** x fresnel, y glint, z glintSharpness, w foamAmount */
    uShine: { value: new THREE.Vector4() },
    /** x foamLine, y rippleFoam(0/1), z rippleSpeed */
    uFoam: { value: new THREE.Vector3() },
    uOpacity: { value: 1 },
  };
  private readonly heightData = new Uint8Array(V * V);
  private readonly heightTex: THREE.DataTexture;
  private terrain: TerrainSystem | null = null;
  private terrainRevision = -1;
  private heightTimer = 0;
  /** The terrain's sand texture, for the open-sea bed (set with the terrain). */
  private readonly bedSand = { value: null as THREE.Texture | null };

  constructor(scene: THREE.Scene) {
    this.heightData.fill(0);
    this.heightTex = new THREE.DataTexture(this.heightData, V, V, THREE.RedFormat, THREE.UnsignedByteType);
    this.heightTex.magFilter = this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.colorSpace = THREE.NoColorSpace;
    this.heightTex.unpackAlignment = 1; // 513-byte rows
    this.heightTex.needsUpdate = true;
    this.uniforms.uBedHeight.value = this.heightTex;

    const normals = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}water_normals.jpg`);
    normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
    normals.colorSpace = THREE.NoColorSpace;
    normals.anisotropy = 4;
    this.uniforms.uWaterNormals.value = normals;

    const geo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, 1, 1);
    geo.rotateX(-Math.PI / 2);
    // Seen from below when diving: the underside of the surface must show too
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    mat.customProgramCacheKey = () => 'sea-water';
    mat.onBeforeCompile = (shader) => {
      injectNightLights(shader);
      Object.assign(shader.uniforms, this.uniforms, rippleUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSeaW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeaW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vSeaW;
uniform float uTime;
uniform sampler2D uWaterNormals;
uniform sampler2D uBedHeight;
uniform float uRain;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoamCol;
uniform vec4 uWaveA;
uniform vec4 uWaveB;
uniform vec4 uShine;
uniform vec3 uFoam;
uniform float uOpacity;
${WATER_DETAIL_GLSL}
${WATER_RIPPLE_GLSL}
float seaDepth;
float seaFoam;
vec3 seaWorldN;`
        )
        .replace(
          '#include <map_fragment>',
          `// Depth to the bed under this pixel (outside the island: the flat sea bed)
vec2 bedUv = (vSeaW.xz + ${(HALF + 0.5).toFixed(1)}) / ${V.toFixed(1)};
float inIsland = step(abs(vSeaW.x), ${HALF.toFixed(1)}) * step(abs(vSeaW.z), ${HALF.toFixed(1)});
float bedY = mix(${SEA_FLOOR_Y.toFixed(2)},texture2D(uBedHeight, bedUv).r * 15.9375 - ${HEIGHT_OFFSET.toFixed(2)}, inIsland);
seaDepth = max(vSeaW.y - bedY, 0.0);

// Waves: two normal-map layers drifting apart; flatter with distance so far water stays calm
float seaDist = distance(vSeaW, cameraPosition);
float detail = 1.0 - smoothstep(uWaveB.z, uWaveB.w, seaDist);
vec3 n1 = texture2D(uWaterNormals, vSeaW.xz * uWaveB.x + uTime * uWaveA.w * vec2(0.011, 0.007)).xyz * 2.0 - 1.0;
vec3 n2 = texture2D(uWaterNormals, vSeaW.xz * uWaveB.y + uTime * uWaveA.w * vec2(-0.015, 0.010)).xyz * 2.0 - 1.0;
vec2 slope = (n1.xy * 0.6 + n2.xy * 0.4) * mix(uWaveA.z, uWaveA.y, detail);
// Simulated waves around the player (developer toggle): they tilt the surface, so they catch the sun
float simH;
vec2 simG;
wdSimSample(vSeaW.xz, simH, simG);
slope += simG * uWdSimLook.y;
seaWorldN = normalize(vec3(slope.x, 1.0, slope.y));

// Shallow turquoise -> deep blue (linear colours)
vec3 seaCol = mix(uShallow, uDeep, 1.0 - exp(-seaDepth * uWaveA.x));
seaCol *= 0.94 + (n1.z + n2.z) * 0.04;
// Shore (flat white details, crisp edges): a line at the waterline, and ripple bands following
// the depth contours that drift in toward the shore. Each band is cut into pieces by noise, so
// it reads as separate ripples, and thins out over deeper water. No branches: fwidth inside.
float wobble = (n1.x + n2.y) * 0.6;
float ripPh = seaDepth * 2.6 + uTime * uFoam.z + wobble * 0.12;
float ripAa = fwidth(ripPh) * 1.2 + 0.002;
float ripBreak = wdNoise(vSeaW.xz * 0.45 + floor(ripPh) * 13.7);
float ripW = mix(0.3, 0.05, smoothstep(0.0, 1.4, seaDepth));
float ripF = fract(ripPh);
seaFoam = smoothstep(1.0 - ripW - ripAa, 1.0 - ripW, ripF) * (1.0 - smoothstep(1.0 - ripAa, 1.0, ripF));
seaFoam *= uFoam.y * smoothstep(0.45, 0.5, ripBreak) * (1.0 - smoothstep(1.1, 1.6, seaDepth)) * (1.0 - smoothstep(60.0, 140.0, seaDist));
float lineD = seaDepth + wobble * 0.04;
seaFoam = max(seaFoam, 1.0 - smoothstep(uFoam.x, uFoam.x + fwidth(lineD) * 1.5 + 0.005, lineD));
seaFoam *= inIsland * uShine.w;
// Rain: crisp rings where the drops hit (open sea too); the uniform test skips them in dry weather
float seaRings = wdRainRings(vSeaW.xz, uTime, uRain) * (1.0 - smoothstep(25.0, 55.0, seaDist));
if (uRain > 0.01) seaFoam = max(seaFoam, seaRings);
// Ripple rings from the swimmer, wading legs and splashes
// (derivatives first: the distance test below skips the loop for far pixels)
float seaRipAa = length(fwidth(vSeaW.xz));
float seaSimAa = fwidth(simH);
float seaRip = seaDist < 80.0 ? wdRipples(vSeaW.xz, seaRipAa) * (1.0 - smoothstep(45.0, 80.0, seaDist)) : 0.0;
seaFoam = max(seaFoam, max(seaRip * 0.9, wdSimCrest(simH, seaSimAa)));
diffuseColor.rgb = mix(seaCol, uFoamCol, clamp(seaFoam, 0.0, 1.0));
diffuseColor.a = max(uOpacity, clamp(seaFoam, 0.0, 1.0));`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `// The wave normal (world -> view); flipped for the underside seen from below
normal = normalize((viewMatrix * vec4(gl_FrontFacing ? seaWorldN : -seaWorldN, 0.0)).xyz);`
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
vec3 seaV = normalize(vViewPosition);
float seaNV = clamp(dot(normal, seaV), 0.0, 1.0);
vec3 seaSky = ambientLightColor;
#if NUM_HEMI_LIGHTS > 0
seaSky += hemisphereLights[0].skyColor;
#endif
if (gl_FrontFacing) {
  // Fresnel: grazing angles mirror the sky
  float fres = 0.02 + uShine.x * pow(1.0 - seaNV, 5.0);
  totalEmissiveRadiance += seaSky * vec3(0.55, 0.75, 0.95) * fres * (1.0 - seaFoam);
  #if NUM_DIR_LIGHTS > 0
  // Sun glint: a sharp highlight plus a soft sheen around it
  float nh = max(dot(normal, normalize(directionalLights[0].direction + seaV)), 0.0);
  totalEmissiveRadiance += directionalLights[0].color * (pow(nh, uShine.z) * uShine.y + pow(nh, 48.0) * 0.12) * (1.0 - seaFoam);
  #endif
} else {
  // From below: a dim ceiling, with the bright Snell's window straight overhead
  float window = smoothstep(0.55, 0.9, seaNV);
  totalEmissiveRadiance += seaSky * vec3(0.12, 0.45, 0.55) * (0.15 + window * 0.9);
}`
        );
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

  /** The terrain whose heights give the water its depth colour and shore foam. */
  public setTerrain(terrain: TerrainSystem): void {
    this.terrain = terrain;
    this.terrainRevision = -1;
    this.bedSand.value = terrain.sandLayer;
  }

  /** `rain` 0..1 draws rain rings on the sea. */
  public update(dt: number, camera?: THREE.Vector3, rain = 0): void {
    this.uniforms.uTime.value += dt;
    this.uniforms.uRain.value = rain;
    const ws = waterSettings;
    const u = this.uniforms;
    u.uShallow.value.set(ws.shallowColor);
    u.uDeep.value.set(ws.deepColor);
    u.uFoamCol.value.set(ws.foamColor);
    u.uWaveA.value.set(ws.depthFalloff, ws.waveNear, ws.waveFar, ws.waveSpeed);
    u.uWaveB.value.set(ws.waveScale1, ws.waveScale2, ws.detailStart, Math.max(ws.detailEnd, ws.detailStart + 1));
    u.uShine.value.set(ws.fresnel, ws.glint, ws.glintSharpness, ws.foamAmount);
    u.uOpacity.value = ws.opacity;
    if (this.material.transparent !== ws.transparent) {
      // The opaque/blended variants are different programs, so the material must be rebuilt
      this.material.transparent = ws.transparent;
      this.material.needsUpdate = true;
    }
    u.uFoam.value.set(ws.foamLine, ws.rippleFoam ? 1 : 0, ws.rippleSpeed);
    updateWaterDetails(dt);
    this.mesh.position.y = worldSettings.waterLevel;
    if (camera) {
      this.mesh.position.x = this.seabed.position.x = camera.x;
      this.mesh.position.z = this.seabed.position.z = camera.z;
    }
    this.heightTimer -= dt;
    if (this.terrain && this.terrain.revision !== this.terrainRevision && this.heightTimer <= 0) {
      this.heightTimer = HEIGHT_REFRESH;
      this.terrainRevision = this.terrain.revision;
      const h = this.terrain.heights;
      const d = this.heightData;
      for (let i = 0; i < d.length; i++) {
        const b = (h[i] + HEIGHT_OFFSET) * 16;
        d[i] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
      this.heightTex.needsUpdate = true;
    }
  }
}
