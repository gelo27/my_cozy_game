import { injectNightLights } from '../world/NightLighting';
import * as THREE from 'three';
import { WATER_EFFECTS_CONFIG } from '../config/constants';
import { WORLD_SIZE, worldSettings } from '../world/WorldSettings';
import { riverWorld } from '../world/rivers/RiverWorld';
import { injectWaterline } from './WaterDetails';

/**
 * Fake caustics: sunlight focused by the surface waves into a moving web of bright lines on
 * whatever lies under water (sea floor, river beds, the swimmer). Only drawn while the CAMERA is
 * under water: from above, the (opaque) water surface hides the bottom anyway.
 *
 * How it works (one shared GLSL chunk, used by the terrain, the sea bed and the character):
 * - a uniform switch first: with the camera above water every pixel returns at once;
 * - only fragments BELOW the local water surface (the sea, or a river's own level from the river
 *   height texture) and facing up get caustics; the rest return before any texture fetch;
 * - the pattern is two samples of one caustics texture, scrolled in different directions at
 *   different scales and combined with min(): only where both webs cross does a bright line
 *   remain, so the lines wander and re-form like real caustics. Two fetches in total;
 * - chromatic aberration is BAKED into that texture (R and B are the grey pattern shifted a
 *   little either way), so the rainbow fringes cost nothing at run time;
 * - it MULTIPLIES the direct sun / moon light (in lights_fragment_end), so it follows the time of
 *   day, clouds and shadows on its own and never glows at night or in shade;
 * - it fades in just under the surface, dims with depth and fades out with camera distance.
 * Per frame on the CPU: three uniform writes.
 */

/** Tunable look of the caustics (developer panel → «Час, погода, вода»), saved in localStorage. */
export interface CausticsSettings {
  /** Overall strength (extra direct light at a bright line). */
  intensity: number;
  /** Pattern density: texture repeats per metre. */
  scale: number;
  /** Drift speed multiplier. */
  speed: number;
  /** Line sharpness (power applied to the pattern). */
  contrast: number;
  /** Rainbow fringe: how far R and B are shifted, in texels of the 512 px texture. */
  aberration: number;
  /** Fading with water depth (per metre). */
  depthFalloff: number;
  /** Camera distance (m) where the caustics have faded out. */
  maxDistance: number;
  /** Debug: also draw them while the camera is above water. */
  alwaysOn: boolean;
}

export const CAUSTICS_DEFAULTS: Readonly<CausticsSettings> = {
  intensity: WATER_EFFECTS_CONFIG.CAUSTICS_INTENSITY,
  scale: 0.14,
  speed: 1,
  contrast: 1.6,
  aberration: 3,
  depthFalloff: 0.1,
  maxDistance: WATER_EFFECTS_CONFIG.CAUSTICS_MAX_DISTANCE,
  alwaysOn: false,
};

const STORAGE_KEY = 'farm.caustics';

function loadSettings(): CausticsSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) return { ...CAUSTICS_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // ignore broken storage
  }
  return { ...CAUSTICS_DEFAULTS };
}

export const causticsSettings: CausticsSettings = loadSettings();

export const causticsUniforms = {
  uCausticsTime: { value: 0 },
  uCausticsMap: { value: null as THREE.Texture | null },
  uCausticsSea: { value: worldSettings.waterLevel },
  uCausticsRiver: { value: riverWorld.texture as THREE.Texture },
  /** 1 while the camera is under water (or alwaysOn). */
  uCausticsOn: { value: 0 },
  /** intensity, scale, speed, contrast */
  uCausticsParams: { value: new THREE.Vector4() },
  /** depth falloff, distance fade start, distance fade end */
  uCausticsFade: { value: new THREE.Vector3() },
};

export const CAUSTICS_GLSL = /* glsl */ `
uniform sampler2D uCausticsMap;
uniform sampler2D uCausticsRiver;
uniform float uCausticsTime;
uniform float uCausticsSea;
uniform float uCausticsOn;
uniform vec4 uCausticsParams;
uniform vec3 uCausticsFade;
/** Water surface height above a point: the sea, or the river flowing there. */
float causticsWaterY(vec2 xz) {
  vec2 river = texture2D(uCausticsRiver, (xz + ${(WORLD_SIZE * 0.5 + 0.5).toFixed(1)}) / ${(WORLD_SIZE + 1).toFixed(1)}).rg;
  return river.g > 0.5 ? max(uCausticsSea, river.r) : uCausticsSea;
}
/** Extra direct light (per colour channel, 0 = none) at world point wp whose normal has world up-component upY. */
vec3 causticsLight(vec3 wp, float waterY, float upY) {
  // Camera above water: one uniform test for the whole frame (coherent, no derivative issues)
  if (uCausticsOn < 0.5) return vec3(0.0);
  vec2 uv = wp.xz * uCausticsParams.y;
  // Gradients taken before the per-pixel branch, so the fetches below may be skipped
  vec2 gx = dFdx(uv), gy = dFdy(uv);
  float depth = waterY - wp.y;
  if (depth <= 0.02 || upY <= 0.05) return vec3(0.0);
  float fade = smoothstep(0.02, 0.4, depth) * exp(-depth * uCausticsFade.x) * smoothstep(0.05, 0.6, upY)
    * (1.0 - smoothstep(uCausticsFade.y, uCausticsFade.z, distance(wp, cameraPosition)));
  if (fade < 0.004) return vec3(0.0);
  float t = uCausticsTime * uCausticsParams.z;
  // A slow wobble bends the lines a little, as if waves were passing overhead
  vec2 wob = vec2(sin(t * 0.9 + wp.z * 0.35), cos(t * 0.8 + wp.x * 0.35)) * 0.02;
  vec3 a = textureGrad(uCausticsMap, uv + wob + vec2(t * 0.022, t * 0.014), gx, gy).rgb;
  vec3 b = textureGrad(uCausticsMap, uv * 1.31 - wob + vec2(-t * 0.017, t * 0.025) + 0.37, gx * 1.31, gy * 1.31).rgb;
  return pow(min(a, b), vec3(uCausticsParams.w)) * (2.0 * fade * uCausticsParams.x);
}
`;

/** Sky-blue tint of the focused light. */
export const CAUSTICS_TINT = 'vec3(0.85, 1.05, 1.15)';

/**
 * Adds caustics to a lit (Lambert / Standard) material's shader. Needs world position and the
 * world up-component of the normal, taken from the vertex shader.
 */
export function injectCaustics(shader: THREE.WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, causticsUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCauPos;\nvarying float vCauUp;')
    .replace(
      '#include <worldpos_vertex>',
      '#include <worldpos_vertex>\nvCauPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvCauUp = normalize(mat3(modelMatrix) * objectNormal).y;'
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vCauPos;\nvarying float vCauUp;\n${CAUSTICS_GLSL}`)
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>\nreflectedLight.directDiffuse *= 1.0 + causticsLight(vCauPos, causticsWaterY(vCauPos.xz), vCauUp) * ${CAUSTICS_TINT};`
    );
}

// ---------------------------------------------------------------- texture

const TEX = 512;
/** Direction the colours are split along (35°). */
const DISP = { x: 0.819, y: 0.573 };

/** Grey caustics pattern (one byte per texel) the RGB texture is baked from. */
let grey: Uint8Array | null = null;
let bakedAberration = -1;
const texture = new THREE.DataTexture(new Uint8Array(TEX * TEX * 4), TEX, TEX, THREE.RGBAFormat);
texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
texture.generateMipmaps = true;
texture.minFilter = THREE.LinearMipmapLinearFilter;
texture.magFilter = THREE.LinearFilter;
// A light mask, not a colour: the grey values are used as they are
texture.colorSpace = THREE.NoColorSpace;
causticsUniforms.uCausticsMap.value = texture;

/** Procedural stand-in, used only if Caustic_Free.jpg cannot be loaded. */
function proceduralGrey(): Uint8Array {
  const out = new Uint8Array(TEX * TEX);
  for (let y = 0; y < TEX; y++) {
    const ny = (y / TEX) * Math.PI * 2;
    for (let x = 0; x < TEX; x++) {
      const nx = (x / TEX) * Math.PI * 2;
      const p1x = nx * 2 + Math.sin(ny * 2) * 0.45, p1y = ny * 2 + Math.cos(nx * 2) * 0.45;
      const p2x = nx * 3 - Math.cos(ny * 3) * 0.35, p2y = ny * 3 - Math.sin(nx * 3) * 0.35;
      const v = (Math.sin(p1x * 2) * Math.cos(p1y * 2) + Math.cos(p2x * 3) * Math.sin(p2y * 3)) * 0.25 + 0.5;
      out[y * TEX + x] = Math.min(255, Math.pow(v, 3) * 600);
    }
  }
  return out;
}

/** Bilinear, wrapping read of the grey pattern. */
function greyAt(src: Uint8Array, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const m = TEX - 1;
  const xa = x0 & m, xb = (x0 + 1) & m, ya = (y0 & m) * TEX, yb = ((y0 + 1) & m) * TEX;
  const top = src[ya + xa] * (1 - fx) + src[ya + xb] * fx;
  const bot = src[yb + xa] * (1 - fx) + src[yb + xb] * fx;
  return top * (1 - fy) + bot * fy;
}

/** Bakes the RGB texture: G = the pattern, R / B = the pattern shifted by ±aberration texels. */
function bake(aberration: number): void {
  if (!grey) return;
  const src = grey;
  const data = texture.image.data as Uint8Array;
  const dx = DISP.x * aberration, dy = DISP.y * aberration;
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const i = (y * TEX + x) * 4;
      const g = src[y * TEX + x];
      data[i] = aberration > 0.01 ? greyAt(src, x - dx, y - dy) : g;
      data[i + 1] = g;
      data[i + 2] = aberration > 0.01 ? greyAt(src, x + dx, y + dy) : g;
      data[i + 3] = 255;
    }
  }
  texture.needsUpdate = true;
  bakedAberration = aberration;
}

/** Pushes `causticsSettings` into the uniforms (re-bakes the texture if the fringe changed) and saves them. */
export function applyCausticsSettings(save = true): void {
  const s = causticsSettings;
  causticsUniforms.uCausticsParams.value.set(s.intensity, s.scale, s.speed, s.contrast);
  causticsUniforms.uCausticsFade.value.set(s.depthFalloff, s.maxDistance * 0.5, s.maxDistance);
  if (grey && s.aberration !== bakedAberration) bake(s.aberration);
  if (save) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      // storage full / disabled: settings simply do not persist
    }
  }
}

export function resetCausticsSettings(): void {
  Object.assign(causticsSettings, CAUSTICS_DEFAULTS);
  applyCausticsSettings();
}

function setGrey(data: Uint8Array): void {
  grey = data;
  bakedAberration = -1;
  applyCausticsSettings(false);
}

export class WaterEffects {
  public group: THREE.Group;
  public readonly causticsUniforms = causticsUniforms;
  private totalTime = 0;

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = 'WaterEffects_System';
    scene.add(this.group);

    applyCausticsSettings(false);
    if (!grey) {
      new THREE.ImageLoader().load(
        `${import.meta.env.BASE_URL}Caustic_Free.jpg`,
        (img) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = TEX;
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(img, 0, 0, TEX, TEX);
          const rgba = ctx.getImageData(0, 0, TEX, TEX).data;
          const g = new Uint8Array(TEX * TEX);
          for (let i = 0; i < g.length; i++) g[i] = rgba[i * 4 + 1];
          setGrey(g);
        },
        undefined,
        (err) => {
          console.warn('[WaterEffects] Caustic_Free.jpg failed to load, using a procedural pattern:', err);
          setGrey(proceduralGrey());
        }
      );
    }
  }

  /** Adds caustics (and the night lights) to a lit material, e.g. the character's. */
  public applyProjectedCaustics(material: THREE.Material): void {
    material.onBeforeCompile = (shader) => {
      injectNightLights(shader);
      injectCaustics(shader);
      injectWaterline(shader);
    };
    material.needsUpdate = true;
  }

  /** Kept for callers: the surface ripple rings were removed. */
  public emitRipple(_x: number, _z: number, _strength = 1.0, _maxRadius = 3.5, _customDuration?: number): void {}

  /** Kept for callers: the surface ripple rings were removed. */
  public emitRippleBurst(_x: number, _z: number, _intensity = 1.0): void {}

  /** Per frame: advance the pattern, follow the sea level, switch on only with the camera under water. */
  public update(dt: number, cameraUnderwater: boolean): void {
    this.totalTime += dt;
    causticsUniforms.uCausticsTime.value = this.totalTime;
    causticsUniforms.uCausticsSea.value = worldSettings.waterLevel;
    causticsUniforms.uCausticsOn.value = cameraUnderwater || causticsSettings.alwaysOn ? 1 : 0;
  }

  public dispose(): void {}
}
