import * as THREE from 'three';
import { CHARACTER_CONFIG } from '../config/constants';

const FEET_OFFSET = CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT + CHARACTER_CONFIG.CAPSULE_RADIUS;

// View-space foot position and strength. Receiver shaders already have vViewPosition,
// so the projection needs neither an extra varying nor a second draw of the surface.
const playerShadow = { value: new THREE.Vector4(0, 0, 0, 0) };

export function updatePlayerShadow(player: THREE.Vector3, camera: THREE.Camera, enabled: boolean): void {
  if (!enabled) {
    playerShadow.value.w = 0;
    return;
  }

  camera.updateWorldMatrix(true, false);
  const view = camera.matrixWorldInverse.elements;
  const y = player.y - FEET_OFFSET;
  playerShadow.value.set(
    view[0] * player.x + view[4] * y + view[8] * player.z + view[12],
    view[1] * player.x + view[5] * y + view[9] * player.z + view[13],
    view[2] * player.x + view[6] * y + view[10] * player.z + view[14],
    0.48
  );
}

export function injectPlayerShadow(shader: Pick<THREE.WebGLProgramParametersWithUniforms, 'uniforms' | 'fragmentShader'>): void {
  shader.uniforms.uPlayerShadow = playerShadow;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
#ifdef OPAQUE
uniform vec4 uPlayerShadow;
float playerShadowMask(vec3 viewPosition, vec3 viewNormal) {
  if (uPlayerShadow.w <= 0.0) return 0.0;
  vec3 delta = viewPosition - uPlayerShadow.xyz;
  float d2 = dot(delta, delta);
  // Reject distant fragments before the cylinder and receiver tests.
  if (d2 >= 5.59) return 0.0;
  vec3 up = viewMatrix[1].xyz;
  float drop = -dot(delta, up);
  if (drop <= -0.44 || drop >= 2.25) return 0.0;
  float fade = smoothstep(0.08, 2.25, drop);
  float radius = mix(0.50, 0.725, fade);
  float radialSq = max(0.0, d2 - drop * drop) / (radius * radius);
  if (radialSq >= 1.0) return 0.0;
  // Upward-facing surfaces receive the projection, including slopes and stair treads.
  float facing = smoothstep(0.18, 0.6, dot(viewNormal, up));
  return uPlayerShadow.w * facing * (1.0 - fade)
    * smoothstep(-0.44, -0.12, drop) * (1.0 - smoothstep(0.04, 1.0, radialSq));
}
#endif`)
    .replace('#include <opaque_fragment>', `#include <opaque_fragment>
#ifdef OPAQUE
gl_FragColor.rgb *= 1.0 - playerShadowMask(-vViewPosition, nonPerturbedNormal);
#endif`);
}
