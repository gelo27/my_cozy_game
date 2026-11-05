import * as THREE from 'three';
import { WORLD_SIZE, worldSettings } from '../world/WorldSettings';
import { riverWorld } from '../world/rivers/RiverWorld';

/**
 * Flat white water details, drawn crisp (step-like edges, antialiased with fwidth) for a clean
 * stylised look:
 * - the WATERLINE: every lit object that crosses a water surface (sea or river) gets a thin white
 *   band where it meets the water — posts, legs, hulls, the swimmer. It costs one river-texture
 *   fetch per VERTEX and a compare per pixel, so it is patched into every lit material;
 * - RAIN RINGS: crisp rings spreading where drops hit (sea and rivers share this chunk);
 * - a small value noise for the broken shore ripples on the sea.
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

/** Per frame (from the sea system): time and the sea level. */
export function updateWaterDetails(dt: number): void {
  waterDetailUniforms.uWdTime.value += dt;
  waterDetailUniforms.uWdSea.value = worldSettings.waterLevel;
}

/** Hash, value noise and rain rings. Uses derivatives: call outside non-uniform branches. */
export const WATER_DETAIL_GLSL = /* glsl */ `
float wdHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wdNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wdHash(i), wdHash(i + vec2(1, 0)), f.x), mix(wdHash(i + vec2(0, 1)), wdHash(i + vec2(1, 1)), f.x), f.y);
}
/** One layer: a ring per cell, at a random spot and phase, kept inside its cell. */
float wdRingLayer(vec2 q, float aa, float t, float rain, float seed) {
  vec2 ci = floor(q);
  float ph = fract(t * 1.15 + wdHash(ci + seed) * 7.0);
  float alive = step(wdHash(ci + seed + 1.3), rain * 0.7);
  vec2 c = vec2(wdHash(ci + seed + 3.1), wdHash(ci + seed + 7.7)) * 0.5 + 0.25;
  float r = sqrt(ph) * 0.24;                 // fast at first, then slowing down
  float w = mix(0.04, 0.012, ph);           // thins out as it spreads
  float d = abs(length(fract(q) - c) - r);
  return (1.0 - smoothstep(w, w + aa, d)) * (1.0 - smoothstep(0.65, 1.0, ph)) * alive;
}
/** Rain rings at world point xz (0..1). rain 0..1 = how many cells are dripping. */
float wdRainRings(vec2 xz, float t, float rain) {
  vec2 q = xz * 2.2;
  float aa = length(fwidth(q)) * 0.8;
  float far = 1.0 - smoothstep(0.06, 0.2, aa); // cells smaller than a few pixels: fade out
  float v = max(wdRingLayer(q, aa, t, rain, 0.0), wdRingLayer(q + 0.5, aa, t * 0.93 + 0.4, rain, 17.0));
  return v * far;
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
