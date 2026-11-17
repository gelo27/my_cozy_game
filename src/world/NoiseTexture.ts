import * as THREE from 'three';

/** Side of the shared noise texture (texels); the noise repeats every NOISE_SIZE lattice cells. */
export const NOISE_SIZE = 128;

let tex: THREE.DataTexture | null = null;

/**
 * One random value per texel in each of R, G, B, A (four independent lattices), generated once in
 * code. Sampled with linear filtering at smoothstepped coordinates (`texNoise` below) it is the
 * same smooth value noise the shaders used to build from four sin-hashes, in one fetch. Seamless:
 * every texel is independent, so the repeat wrap is just the lattice wrapping around.
 */
export function sharedNoiseTexture(): THREE.DataTexture {
  if (tex) return tex;
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);
  // Fixed seed: the same sky / water / grass pattern on every run
  let s = 0x9e3779b9;
  for (let i = 0; i < data.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    data[i] = (s >>> 0) & 0xff;
  }
  const t = new THREE.DataTexture(data, NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  // Always read at level 0 (textureLod): the smoothstep trick needs the exact texels, no mips
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  tex = t;
  return t;
}

/** The uniform every material using NOISE_TEX_GLSL shares (assign it as `uNoiseTex`). */
export const noiseTexUniform: THREE.IUniform<THREE.DataTexture> = { value: sharedNoiseTexture() };

/**
 * GLSL helpers (vertex or fragment, once per shader). Needs the `uNoiseTex` uniform.
 * `texNoise(p)`: smooth value noise in 0..1 with unit lattice cells, like the old hash noise.
 * `texNoise4(p)`: four independent ones at once (one per channel).
 */
export const NOISE_TEX_GLSL = /* glsl */ `
uniform sampler2D uNoiseTex;
vec4 texNoise4(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(uNoiseTex, (i + f + 0.5) * ${(1 / NOISE_SIZE).toFixed(8)}, 0.0);
}
float texNoise(vec2 p) { return texNoise4(p).r; }
`;
