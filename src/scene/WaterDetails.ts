import * as THREE from 'three';
import { WORLD_SIZE, worldSettings } from '../world/WorldSettings';
import { riverWorld } from '../world/rivers/RiverWorld';
import { rippleSimUniforms, waterRippleSim } from './WaterRippleSim';

/**
 * Flat white water details, drawn crisp (step-like edges, antialiased with fwidth) for a clean
 * stylised look:
 * - the WATERLINE: every lit object that crosses a water surface (sea or river) gets a thin white
 *   band where it meets the water — posts, legs, hulls, the swimmer. It costs one river-texture
 *   fetch per VERTEX and a compare per pixel, so it is patched into every lit material;
 * - a small value noise for the broken shore ripples on the sea;
 * - RIPPLE RINGS: crisp rings spreading from whatever disturbs the surface (the swimmer's strokes,
 *   wading legs, splashes, floating props). The CPU keeps a small ring buffer of sources (centre,
 *   birth time, radius, strength, life, motion); each frame only the live ones near the camera
 *   and inside its view are packed into uniforms, and the sea and river shaders loop over just
 *   those, drawing them analytically (no texture, no geometry). Rings tear up as they spread,
 *   and a moving source's rings are squeezed ahead and stretched behind;
 * - or, with «Симуляція» on in the developer panel, real waves from a small GPU height field
 *   around the player (WaterRippleSim.ts): the same emit calls drop dents into it.
 */

interface PatchableShader {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

/** Half thickness of the white band (m). */
const WATERLINE_HALF = 0.028;

export const waterDetailUniforms = {
  uWdTime: { value: 0 },
  uWdSea: { value: worldSettings.waterLevel },
  uWdRiver: { value: riverWorld.texture as THREE.Texture },
};

/** How many ripple sources can be alive at once (oldest is overwritten). */
const RIPPLE_COUNT = 32;
/** Rings further than this from the camera are not drawn (m); the shaders fade them out before it. */
export const RIPPLE_MAX_DIST = 80;
/** Speed (m/s) at which a moving source's rings are stretched the most. */
const STRETCH_SPEED = 4;

export const rippleUniforms = {
  uWdTime: waterDetailUniforms.uWdTime,
  /** x, z centre, birth time, max radius (m); only the first uWdRipCount are alive and on screen. */
  uWdRipA: { value: Array.from({ length: RIPPLE_COUNT }, () => new THREE.Vector4(0, 0, -1e4, 1)) },
  /** strength 0..1, life (s), motion stretch x, z (|v| <= 1) */
  uWdRipB: { value: Array.from({ length: RIPPLE_COUNT }, () => new THREE.Vector4(0, 1, 0, 0)) },
  /** How many sources the shaders loop over (0 = the loop is skipped). */
  uWdRipCount: { value: 0 },
  ...rippleSimUniforms,
};

interface RippleSource { x: number; y: number; z: number; t0: number; r: number; s: number; life: number; mx: number; mz: number }
const sources: RippleSource[] = Array.from({ length: RIPPLE_COUNT }, () => ({ x: 0, y: 0, z: 0, t0: -1e4, r: 1, s: 0, life: 1, mx: 0, mz: 0 }));
let rippleNext = 0;
let rippleCamera: THREE.Camera | null = null;
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
const sphere = new THREE.Sphere();

/** The camera whose view the rings are culled against (set once by the engine). */
export function setRippleCamera(camera: THREE.Camera): void {
  rippleCamera = camera;
}

/**
 * Starts a ring spreading on the water surface at (x, z). Strength 0..1 is its whiteness,
 * maxRadius how far it spreads (m); life defaults to a duration that suits the radius.
 * (vx, vz) = velocity of the source (m/s): its rings are squeezed ahead and stretched behind.
 * With the wave simulation on, the same call drops a dent into the simulated field instead.
 */
export function emitWaterRipple(x: number, z: number, strength = 0.6, maxRadius = 2.5, life?: number, vx = 0, vz = 0): void {
  const s = THREE.MathUtils.clamp(strength, 0, 1);
  if (waterRippleSim.active) {
    waterRippleSim.addDrop(x, z, s, maxRadius);
    return;
  }
  const src = sources[rippleNext];
  rippleNext = (rippleNext + 1) % RIPPLE_COUNT;
  const sp = Math.hypot(vx, vz);
  const k = sp > 1e-3 ? Math.min(sp / STRETCH_SPEED, 1) / sp : 0;
  src.x = x;
  src.z = z;
  src.y = riverWorld.waterLevelAt(x, z);
  src.t0 = waterDetailUniforms.uWdTime.value;
  src.r = Math.max(0.2, maxRadius);
  src.s = s;
  src.life = Math.max(0.2, life ?? 0.9 + maxRadius * 0.45);
  src.mx = vx * k;
  src.mz = vz * k;
}

/**
 * Per frame while the player is in the water: the wave simulation follows it and its motion
 * pushes a wake (does nothing with the analytic rings).
 */
export function setWaterBody(x: number, z: number, speed: number, radius = 0.4): void {
  if (waterRippleSim.active) waterRippleSim.setBody(x, z, speed, radius);
}

/** Per frame for a hand / foot moving in the water (slot 1..4): its own small wake in the simulation. */
export function setWaterLimb(slot: number, x: number, z: number, speed: number, radius = 0.16): void {
  if (waterRippleSim.active) waterRippleSim.setPusher(slot, x, z, speed, radius);
}

/**
 * Per frame (from the sea system): time and the sea level, and the list of rings the shaders
 * loop over: only the live ones, near the camera and inside its view, packed at the front.
 */
export function updateWaterDetails(dt: number): void {
  const t = (waterDetailUniforms.uWdTime.value += dt);
  waterDetailUniforms.uWdSea.value = worldSettings.waterLevel;
  const cam = rippleCamera;
  if (cam) {
    cam.updateMatrixWorld();
    projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
  }
  const A = rippleUniforms.uWdRipA.value;
  const B = rippleUniforms.uWdRipB.value;
  const maxD2 = RIPPLE_MAX_DIST * RIPPLE_MAX_DIST;
  let n = 0;
  for (let i = 0; i < RIPPLE_COUNT; i++) {
    const src = sources[i];
    const age = t - src.t0;
    if (age <= 0 || age >= src.life) continue;
    if (cam) {
      const p = cam.position;
      const dx = src.x - p.x, dz = src.z - p.z;
      if (dx * dx + dz * dz > maxD2) continue;
      sphere.center.set(src.x, src.y, src.z);
      sphere.radius = src.r * 1.3;
      if (!frustum.intersectsSphere(sphere)) continue;
    }
    A[n].set(src.x, src.z, src.t0, src.r);
    B[n].set(src.s, src.life, src.mx, src.mz);
    n++;
  }
  rippleUniforms.uWdRipCount.value = n;
}

/** Hash and value noise. */
export const WATER_DETAIL_GLSL = /* glsl */ `
float wdHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wdNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wdHash(i), wdHash(i + vec2(1, 0)), f.x), mix(wdHash(i + vec2(0, 1)), wdHash(i + vec2(1, 1)), f.x), f.y);
}
`;

/**
 * Ripple rings (fragment shader of a water surface). Needs WATER_DETAIL_GLSL before it and the
 * rippleUniforms. `aa` = pixel size in metres (length(fwidth(worldXZ)), taken outside branches).
 */
export const WATER_RIPPLE_GLSL = /* glsl */ `
#define WD_RIPPLES ${RIPPLE_COUNT}
uniform float uWdTime;
uniform vec4 uWdRipA[WD_RIPPLES];
uniform vec4 uWdRipB[WD_RIPPLES];
uniform int uWdRipCount;
uniform sampler2D uWdSim;
uniform vec4 uWdSimArea;
uniform vec4 uWdSimLook;
/** Analytic rings. No derivatives inside: may be called in a branch (e.g. a distance early-out). */
float wdRipples(vec2 xz, float aa) {
  if (uWdRipCount == 0) return 0.0;
  // A little wobble so the rings are not perfect circles
  float wob = (wdNoise(xz * 2.3) - 0.5) * 0.07;
  float v = 0.0;
  for (int i = 0; i < WD_RIPPLES; i++) {
    if (i >= uWdRipCount) break;
    vec4 a = uWdRipA[i];
    vec4 b = uWdRipB[i];
    float p = (uWdTime - a.z) / b.y;
    if (p <= 0.0 || p >= 1.0) continue;
    vec2 dv = xz - a.xy;
    float d2 = dot(dv, dv);
    if (d2 > a.w * a.w * 1.8) continue;
    float dist = sqrt(d2);
    vec2 dir = dv / max(dist, 1e-3);
    // Moving source: the ring is squeezed ahead of it (bow wave) and stretched behind
    float mv = dot(dir, b.zw);
    float e = 1.0 - (1.0 - p) * (1.0 - p);      // fast at first, then slowing down
    float r = (0.12 + a.w * e) * (1.0 - 0.38 * mv);
    dist += wob;
    // Half width: thins out to nothing as the ring spreads (that is what makes it die away).
    // Thinner than a pixel, the line keeps a pixel's width but loses coverage in proportion,
    // so it narrows smoothly to zero instead of flickering.
    float w = 0.065 * (1.0 - p) * (1.0 - p * 0.35);
    float outer = (1.0 - smoothstep(w, w + aa, abs(dist - r))) * min(1.0, 2.0 * w / aa);
    // A fainter second ring trailing inside the first (thinner still)
    float r2 = r * 0.6;
    float w2 = w * 0.7;
    float inner = (1.0 - smoothstep(w2, w2 + aa, abs(dist - r2))) * min(1.0, 2.0 * w2 / aa) * 0.6 * step(0.1, r2);
    // Broken into pieces around the ring: a fresh ring is whole, it tears up as it spreads
    float brk = wdNoise(dir * 2.6 + fract(a.z * 0.1373) * 61.0);
    float keep = smoothstep(0.18, 0.4, brk + (1.0 - p) * 0.3);
    // Fade in at birth; the end is left to the thinning, with only a short soft tail
    float fade = smoothstep(0.0, 0.08, p) * (1.0 - smoothstep(0.75, 1.0, p));
    v = max(v, max(outer, inner) * fade * b.x * keep);
  }
  // Far away the rings get thinner than a pixel: fade them rather than let them flicker
  return min(v, 1.0) * (1.0 - smoothstep(0.05, 0.14, aa));
}
/** Simulated waves at xz: height (h) and slope (g); zero outside the area or with the sim off. */
void wdSimSample(vec2 xz, out float h, out vec2 g) {
  h = 0.0;
  g = vec2(0.0);
  if (uWdSimArea.w < 0.5) return;
  vec2 uv = (xz - uWdSimArea.xy) * uWdSimArea.z;
  vec2 e2 = min(uv, 1.0 - uv);
  float edge = smoothstep(0.0, 0.15, min(e2.x, e2.y));
  if (edge <= 0.0) return;
  vec4 s = textureLod(uWdSim, uv, 0.0);
  h = s.r * edge;
  g = s.ba * edge;
}
/** White crest where a simulated wave stands high. aa = fwidth(h), taken outside branches. */
float wdSimCrest(float h, float aa) {
  return smoothstep(uWdSimLook.x, uWdSimLook.x + aa * 1.5 + 1e-4, h) * uWdSimLook.z;
}
`;

/**
 * Adds the white waterline to a lit built-in material (Lambert / Standard / Phong / Toon).
 * Safe to call more than once. Not for the terrain or the water surfaces themselves.
 */
export function injectWaterline(shader: PatchableShader): void {
  if (shader.vertexShader.includes('vWaterlineH')) return;
  if (!shader.vertexShader.includes('#include <worldpos_vertex>') || !shader.fragmentShader.includes('#include <color_fragment>')) return;
  Object.assign(shader.uniforms, waterDetailUniforms);
  const half = (WORLD_SIZE * 0.5 + 0.5).toFixed(1);
  const size = (WORLD_SIZE + 1).toFixed(1);
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
uniform float uWdTime;
uniform float uWdSea;
uniform sampler2D uWdRiver;
varying float vWaterlineH;`
    )
    .replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
{
  vec4 wlP = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
  wlP = batchingMatrix * wlP;
  #endif
  #ifdef USE_INSTANCING
  wlP = instanceMatrix * wlP;
  #endif
  wlP = modelMatrix * wlP;
  // Local water surface: the sea, or the river flowing here; a gentle bob so the band lives
  vec2 wlRiver = texture2D(uWdRiver, (wlP.xz + ${half}) / ${size}).rg;
  float wlY = wlRiver.g > 0.5 ? max(uWdSea, wlRiver.r) : uWdSea;
  wlY += sin(uWdTime * 1.3 + wlP.x * 0.7 + wlP.z * 0.5) * 0.012;
  vWaterlineH = wlP.y - wlY;
}`
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vWaterlineH;')
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
{
  float wlAa = fwidth(vWaterlineH);
  float wl = 1.0 - smoothstep(${WATERLINE_HALF}, ${WATERLINE_HALF} + wlAa * 1.5, abs(vWaterlineH));
  // Far away the band gets thinner than a pixel: fade it rather than let it flicker
  wl *= 1.0 - smoothstep(0.04, 0.2, wlAa);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.97, 1.0), wl);
}`
    );
}
