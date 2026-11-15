import * as THREE from 'three';

/**
 * See-through cutaway for building and painting: whatever building geometry stands between the
 * camera and the player (walls, roofs, the storey above, furniture) dissolves inside a soft cone
 * along the view line, instead of the camera jumping in to the player's back.
 *
 * Building materials get a small patch (a dithered `discard`, so no sorting or blending) driven by
 * shared uniforms; `cutAmount` is the same test on the CPU, so the build and paint rays can start
 * past the cut-away part and never pick a wall the player cannot see.
 */

/** Cone radius (m) at the camera and at the player */
const RADIUS_NEAR = 0.45;
const RADIUS_FAR = 1.15;
/** Width of the soft edge, as a share of the radius */
const EDGE_SOFT = 0.35;
/** The cut stops this far (m) in front of the player, fading over END_SOFT */
const END_MARGIN = 0.2;
const END_SOFT = 0.3;
/** Geometry below the player's feet plus this (m) stays: the floor they stand on */
const FLOOR_KEEP = 0.15;

const uniforms = {
  uCutA: { value: new THREE.Vector3() },
  uCutB: { value: new THREE.Vector3() },
  /** x: strength 0..1, y: feet level */
  uCutP: { value: new THREE.Vector2(0, -1e9) },
};

/** Current cut strength (0 = off); eased by `updateCutaway`. */
let strength = 0;

/**
 * Moves the cut: from the camera at `cameraPos` to the player at `target` (their chest), standing
 * at `feetY`. `active` eases the cut in or out.
 */
export function updateCutaway(dt: number, active: boolean, cameraPos: THREE.Vector3, target: THREE.Vector3, feetY: number): void {
  strength += ((active ? 1 : 0) - strength) * (1 - Math.exp(-(active ? 8 : 6) * dt));
  if (strength < 0.002) strength = 0;
  uniforms.uCutA.value.copy(cameraPos);
  uniforms.uCutB.value.copy(target);
  uniforms.uCutP.value.set(strength, feetY);
}

export function isCutawayActive(): boolean {
  return strength > 0;
}

const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();

/** How strongly the cut removes building geometry at world point `p` (0 = kept, 1 = fully gone). */
export function cutAmount(p: THREE.Vector3): number {
  if (strength <= 0) return 0;
  const { uCutA: a, uCutB: b, uCutP: params } = uniforms;
  if (p.y < params.value.y + FLOOR_KEEP) return 0;
  const ab = _ab.subVectors(b.value, a.value);
  const len2 = ab.lengthSq();
  if (len2 < 1e-6) return 0;
  const ap = _ap.subVectors(p, a.value);
  const t = ap.dot(ab) / len2;
  if (t <= 0) return 0;
  const len = Math.sqrt(len2);
  const endFade = THREE.MathUtils.clamp(((1 - t) * len - END_MARGIN) / END_SOFT, 0, 1);
  if (endFade <= 0) return 0;
  const r = RADIUS_NEAR + (RADIUS_FAR - RADIUS_NEAR) * Math.min(t, 1);
  const d = ap.addScaledVector(ab, -t).length();
  const radial = THREE.MathUtils.clamp((r - d) / (r * EDGE_SOFT), 0, 1);
  return strength * radial * endFade;
}

const _p = new THREE.Vector3();
const RAY_STEP = 0.08;

/**
 * Start of a pick ray past the cut-away geometry: walks from `origin` along `dir` while the cut
 * removes most of what is there, so raycasts skip walls the player sees through. Writes `out`.
 */
export function cutawayRayStart(origin: THREE.Vector3, dir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(origin);
  if (strength <= 0) return out;
  const maxLen = uniforms.uCutA.value.distanceTo(uniforms.uCutB.value) + 1;
  // The camera itself is the cone's tip (counts as not cut), so sampling starts a step out
  let s = RAY_STEP;
  if (cutAmount(_p.copy(origin).addScaledVector(dir, s)) <= 0.5) return out;
  while (s < maxLen && cutAmount(_p.copy(origin).addScaledVector(dir, s)) > 0.5) s += RAY_STEP;
  return out.addScaledVector(dir, s);
}

// ------------------------------------------------------------------ material patch

const VERT_HEAD = `#include <common>
varying vec3 vCutWorld;`;
const VERT_BODY = `#include <project_vertex>
{
  vec4 cutP = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    cutP = batchingMatrix * cutP;
  #endif
  #ifdef USE_INSTANCING
    cutP = instanceMatrix * cutP;
  #endif
  vCutWorld = (modelMatrix * cutP).xyz;
}`;
const FRAG_HEAD = `#include <common>
varying vec3 vCutWorld;
uniform vec3 uCutA;
uniform vec3 uCutB;
uniform vec2 uCutP;
float cutBayer(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  const float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  return (m[i.x + i.y * 4] + 0.5) / 16.0;
}`;
const FRAG_BODY = `#include <clipping_planes_fragment>
if (uCutP.x > 0.0 && vCutWorld.y >= uCutP.y + ${FLOOR_KEEP.toFixed(3)}) {
  vec3 cutAB = uCutB - uCutA;
  float cutL2 = max(dot(cutAB, cutAB), 1e-6);
  vec3 cutAP = vCutWorld - uCutA;
  float cutT = dot(cutAP, cutAB) / cutL2;
  if (cutT > 0.0) {
    float cutLen = sqrt(cutL2);
    float cutEnd = clamp(((1.0 - cutT) * cutLen - ${END_MARGIN.toFixed(3)}) / ${END_SOFT.toFixed(3)}, 0.0, 1.0);
    float cutR = mix(${RADIUS_NEAR.toFixed(3)}, ${RADIUS_FAR.toFixed(3)}, min(cutT, 1.0));
    float cutD = length(cutAP - cutAB * cutT);
    float cutRadial = clamp((cutR - cutD) / (cutR * ${EDGE_SOFT.toFixed(3)}), 0.0, 1.0);
    if (cutBayer(gl_FragCoord.xy) < uCutP.x * cutRadial * cutEnd) discard;
  }
}`;

type Patchable = THREE.Material & { isMeshLambertMaterial?: boolean; isMeshStandardMaterial?: boolean; isMeshPhongMaterial?: boolean; isMeshToonMaterial?: boolean };

/** Our onBeforeCompile per patched material, to notice when someone replaced it later */
const patched = new WeakMap<THREE.Material, THREE.Material['onBeforeCompile']>();

function patchMaterial(m: Patchable): void {
  if (!(m.isMeshLambertMaterial || m.isMeshStandardMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial)) return;
  if (patched.get(m) === m.onBeforeCompile) return;
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  const hook: THREE.Material['onBeforeCompile'] = function (this: THREE.Material, shader, renderer) {
    prev.call(this, shader, renderer);
    shader.uniforms.uCutA = uniforms.uCutA;
    shader.uniforms.uCutB = uniforms.uCutB;
    shader.uniforms.uCutP = uniforms.uCutP;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', VERT_HEAD).replace('#include <project_vertex>', VERT_BODY);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', FRAG_HEAD).replace('#include <clipping_planes_fragment>', FRAG_BODY);
  };
  m.onBeforeCompile = hook;
  // The default key is the onBeforeCompile source: keep the previous one's, or materials with
  // different patches underneath would share a program
  const defaultKey = prevKey === THREE.Material.prototype.customProgramCacheKey;
  m.customProgramCacheKey = function (this: THREE.Material) {
    return `${defaultKey ? prev.toString() : prevKey.call(this)}|build-cutaway`;
  };
  m.needsUpdate = true;
  patched.set(m, hook);
}

/** Patches the lit materials of every mesh under `root` (cheap to repeat: patched ones are skipped). */
export function patchCutawayMaterials(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material;
    if (Array.isArray(mat)) for (const m of mat) patchMaterial(m as Patchable);
    else if (mat) patchMaterial(mat as Patchable);
  });
}
