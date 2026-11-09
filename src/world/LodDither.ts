import * as THREE from 'three';

/**
 * Screen-door (dithered) crossfade between two LODs, as open-world games do it: during a switch
 * both LODs are drawn, the outgoing one dropping pixels in a 4x4 Bayer pattern while the incoming
 * one fills exactly those pixels in. No blending or sorting, and only meshes mid-switch use these
 * materials, so the `discard` cost (no early-z on mobile GPUs) is paid for a fraction of a second.
 *
 * Every fading mesh gets its own material from a pool (its own fade uniform); all of them share
 * one compiled program per base material.
 */

interface DitherMaterial extends THREE.Material {
  userData: { uDither: { value: THREE.Vector2 }; base: THREE.Material };
}

const pools = new Map<THREE.Material, DitherMaterial[]>();

function create(base: THREE.Material): DitherMaterial {
  const m = base.clone() as DitherMaterial;
  const uniform = { value: new THREE.Vector2(0, 0) };
  m.userData = { uDither: uniform, base };
  m.onBeforeCompile = (shader, renderer) => {
    // The base's own patches first (night lights, waterline, and e.g. the trees' wind)
    base.onBeforeCompile.call(base, shader, renderer);
    shader.uniforms.uDither = uniform;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec2 uDither;
        float lodBayer(vec2 p) {
          ivec2 i = ivec2(mod(p, 4.0));
          const float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
          return (m[i.x + i.y * 4] + 0.5) / 16.0;
        }`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        // x: how far the fade is; y = 1 for the outgoing LOD (keeps the complement of the incoming one)
        if ((uDither.y > 0.5) == (lodBayer(gl_FragCoord.xy) < uDither.x)) discard;`,
      );
  };
  m.customProgramCacheKey = () => `lod-dither-${base.uuid}`;
  return m;
}

/** A dithering twin of `base` for one mesh; `outgoing` draws the complement of the incoming LOD. */
export function acquireDither(base: THREE.Material, outgoing: boolean): THREE.Material {
  const m = pools.get(base)?.pop() ?? create(base);
  m.userData.uDither.value.set(0, outgoing ? 1 : 0);
  return m;
}

export function setDitherFade(materials: THREE.Material[], t: number): void {
  for (const m of materials) (m as DitherMaterial).userData.uDither.value.x = t;
}

export function releaseDither(materials: THREE.Material[]): void {
  for (const m of materials) {
    const base = (m as DitherMaterial).userData.base;
    if (!base) continue;
    let pool = pools.get(base);
    if (!pool) pools.set(base, (pool = []));
    pool.push(m as DitherMaterial);
  }
}

const instanced = new Map<THREE.Material, THREE.Material>();

/**
 * Dithering twin of `base` whose fade comes per instance, from an instanced `aLodFade`: 0 draws
 * solid, t > 0 the incoming LOD's share of the pattern at fade t, -t the outgoing one's
 * complement. One material per base serves every fading tree.
 */
export function acquireInstancedDither(base: THREE.Material): THREE.Material {
  let m = instanced.get(base);
  if (m) return m;
  m = base.clone();
  m.onBeforeCompile = (shader, renderer) => {
    base.onBeforeCompile.call(base, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aLodFade;
        varying float vLodFade;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLodFade = aLodFade;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vLodFade;
        float lodBayerI(vec2 p) {
          ivec2 i = ivec2(mod(p, 4.0));
          const float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
          return (m[i.x + i.y * 4] + 0.5) / 16.0;
        }`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vLodFade != 0.0) {
          float b = lodBayerI(gl_FragCoord.xy);
          if (vLodFade > 0.0 ? b >= vLodFade : b < -vLodFade) discard;
        }`);
  };
  m.customProgramCacheKey = () => `lod-dither-inst-${base.uuid}`;
  instanced.set(base, m);
  return m;
}

/** Distance fade band (m) for a family of instanced meshes: x = fade starts, y = fully gone. */
export interface FadeRange {
  value: THREE.Vector2;
}

const distanceTwins = new Map<THREE.Material, THREE.Material>();

/**
 * Dithering twin of an instanced `base` that dissolves each instance by its distance from the
 * camera (XZ, measured at the instance origin) across `range`, so things at the edge of the view
 * melt away plant by plant instead of popping. Only meshes that reach into the fade band should
 * wear it: the `discard` costs early-z on mobile GPUs, so everything nearer keeps the solid base.
 * Twins of materials that share a program (every field crop) share one program too.
 */
export function acquireDistanceDither(base: THREE.Material, range: FadeRange): THREE.Material {
  let m = distanceTwins.get(base);
  if (m) return m;
  m = base.clone();
  m.onBeforeCompile = (shader, renderer) => {
    base.onBeforeCompile.call(base, shader, renderer);
    shader.uniforms.uFadeRange = range;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec2 uFadeRange;
        varying float vDistFade;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec3 io = (modelMatrix * instanceMatrix[3]).xyz;
          #else
            vec3 io = modelMatrix[3].xyz;
          #endif
          // A little per-instance jitter so neighbours don't dissolve in lockstep
          float jit = fract(dot(floor(io.xz * 3.0), vec2(0.06711056, 0.00583715)) * 52.9829189) - 0.5;
          float d = distance(io.xz, cameraPosition.xz) + jit * (uFadeRange.y - uFadeRange.x) * 0.3;
          vDistFade = clamp((d - uFadeRange.x) / max(uFadeRange.y - uFadeRange.x, 0.001), 0.0, 1.0);
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vDistFade;
        float distBayer(vec2 p) {
          ivec2 i = ivec2(mod(p, 4.0));
          const float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
          return (m[i.x + i.y * 4] + 0.5) / 16.0;
        }`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (distBayer(gl_FragCoord.xy) < vDistFade) discard;`);
  };
  const key = base.customProgramCacheKey();
  m.customProgramCacheKey = () => `dist-dither-${key}`;
  distanceTwins.set(base, m);
  return m;
}
