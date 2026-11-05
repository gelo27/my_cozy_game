import * as THREE from 'three';
import { injectNightLights } from '../world/NightLighting';
import { injectWaterline } from '../scene/WaterDetails';

/**
 * How an animal's vertices move. All motion runs in the vertex shader from a per-instance
 * `aAnim` (phase, rate, amplitude, extra) and one shared clock, so the CPU only writes a matrix
 * and four floats per visible animal.
 *
 * Body parts are tagged per vertex (`aPart`):
 * - FLAP: 1 / 2 = left / right wing, rotated about the body's long axis. aAnim.z = flap angle,
 *         aAnim.w = 1 folds the wings (perched).
 * - SWIM: the body sways sideways, more toward the tail (-Z). aAnim.z = sway amplitude.
 * - WALK: 1..4 = legs FL, FR, BL, BR swing about their hip (`aHip` = hip height),
 *         5 = head bobs, 6 = tail wags. aAnim.z = stride amplitude (0 when standing),
 *         aAnim.w = gait: 0 = trot (diagonal pairs), 1 = bound (front pair, then back pair).
 */
export type AnimalAnimMode = 'flap' | 'swim' | 'walk';

export const PART = { BODY: 0, WING_L: 1, WING_R: 2, LEG_FL: 1, LEG_FR: 2, LEG_BL: 3, LEG_BR: 4, HEAD: 5, TAIL: 6 } as const;

/** Shared clock for every animal material (seconds, wraps to keep float precision). */
export const animalTime = { value: 0 };

const DEFORM: Record<AnimalAnimMode, string> = {
  flap: `
    if (aPart > 0.5) {
      float side = aPart < 1.5 ? -1.0 : 1.0;
      // aAnim.w folds the wings along the body (perched gulls)
      transformed.x *= 1.0 - 0.68 * aAnim.w;
      transformed.z -= abs(transformed.x) * aAnim.w * 0.8;
      float ang = sin(aph) * aAnim.z * side - aAnim.w * 0.35 * side;
      float c = cos(ang), s = sin(ang);
      transformed.xy = vec2(c * transformed.x - s * transformed.y, s * transformed.x + c * transformed.y);
    }`,
  swim: `
    float tailT = clamp(0.5 - transformed.z / max(uLength, 0.001), 0.0, 1.2);
    transformed.x += sin(aph - transformed.z * 6.0 / max(uLength, 0.001)) * aAnim.z * tailT * tailT * uLength;`,
  walk: `
    if (aPart > 0.5 && aPart < 4.5) {
      float front = aPart < 2.5 ? 1.0 : 0.0;
      float left = mod(aPart, 2.0) > 0.5 ? 1.0 : 0.0;
      // trot: FL+BR together; bound: both fronts together, both backs half a cycle later
      float legPh = mix(abs(front - left) * 3.14159, (1.0 - front) * 3.14159, aAnim.w);
      float sw = sin(aph + legPh) * aAnim.z;
      float lever = max(0.0, aHip - transformed.y);
      transformed.z += sw * lever;
      transformed.y += max(0.0, cos(aph + legPh)) * aAnim.z * lever * 0.35;
    } else if (aPart > 4.5 && aPart < 5.5) {
      transformed.y += sin(aph * 2.0) * aAnim.z * 0.04 * uLength;
    } else if (aPart > 5.5) {
      transformed.x += sin(aph * 1.5) * (0.05 + aAnim.z * 0.05) * uLength;
    }`,
};

/**
 * One Lambert material per species, vertex-coloured (each body part has its own colour, the
 * instance colour tints it), with the animation above injected into `begin_vertex`.
 */
export function createAnimalMaterial(mode: AnimalAnimMode, length: number, opts: { flat?: boolean; doubleSide?: boolean } = {}): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: opts.flat ?? true,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
  mat.onBeforeCompile = (shader) => {
    injectNightLights(shader);
    injectWaterline(shader);
    shader.uniforms.uTime = animalTime;
    shader.uniforms.uLength = { value: length };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aPart;
attribute float aHip;
attribute vec4 aAnim;
uniform float uTime;
uniform float uLength;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  float aph = uTime * aAnim.y + aAnim.x;
  ${DEFORM[mode]}
}`
      );
  };
  mat.customProgramCacheKey = () => `animal-${mode}`;
  return mat;
}
