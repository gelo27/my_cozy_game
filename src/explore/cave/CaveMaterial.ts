import * as THREE from 'three';
import { injectNightLights } from '../../world/NightLighting';
import { WET_ABOVE, WET_RANGE } from './CaveGen';
import { CAUSTICS_GLSL, CAUSTICS_TINT, causticsUniforms } from '../../scene/WaterEffects';

/** Shared clock for the cave shaders (ember cracks pulse, water shimmers). */
export const caveUniforms = { uCaveTime: { value: 0 } };

const NOISE_GLSL = `
  float cHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float cNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(cHash(i), cHash(i + vec3(1, 0, 0)), f.x), mix(cHash(i + vec3(0, 1, 0)), cHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(cHash(i + vec3(0, 0, 1)), cHash(i + vec3(1, 0, 1)), f.x), mix(cHash(i + vec3(0, 1, 1)), cHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }`;

/**
 * Cave rock: solid procedural texturing (3D noise evaluated at the surface point, so nothing ever
 * stretches the way projected textures do on caves), three biomes blended by per-vertex weights:
 *
 * - moss grotto: pale limestone, moss on everything that faces up, dark wet streaks;
 * - crystal caverns: blue-grey slate in layered strata, with glinting mineral specks;
 * - ember depths: red-brown basalt with rust bands and glowing cracks.
 *
 * Fine detail fades out with distance so it does not shimmer. A = baked ambient occlusion.
 */
export function createCaveRockMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.onBeforeCompile = (shader) => {
    injectNightLights(shader);
    Object.assign(shader.uniforms, caveUniforms, causticsUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 caveData;
        attribute float caveWet;
        varying vec4 vCave;
        varying float vWet;
        varying vec3 vCavePos;
        varying vec3 vCaveWorld;
        varying vec3 vCaveNrm;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vCaveWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vCave = caveData;
        vWet = caveWet;
        vCavePos = position;
        vCaveNrm = normal;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uCaveTime;
        varying vec4 vCave;
        varying float vWet;
        varying vec3 vCavePos;
        varying vec3 vCaveWorld;
        varying vec3 vCaveNrm;
        ${NOISE_GLSL}
        ${CAUSTICS_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 cp = vCavePos;
        vec3 cn = normalize(vCaveNrm);
        float up = cn.y;
        float dist = length(vViewPosition);
        float detail = 1.0 - smoothstep(14.0, 38.0, dist);
        float grain = cNoise(cp * 2.3) * 0.5 + cNoise(cp * 7.1) * 0.5 * detail;
        float big = cNoise(cp * 0.21 + 3.7);
        vec3 bw = vCave.rgb / max(vCave.r + vCave.g + vCave.b, 0.001);
        vec3 albedo = vec3(0.0);
        vec3 glow = vec3(0.0);

        if (bw.x > 0.01) {
          // Moss grotto
          vec3 lime = mix(vec3(0.50, 0.47, 0.40), vec3(0.62, 0.58, 0.50), big);
          float streak = smoothstep(0.55, 0.85, cNoise(vec3(cp.x * 1.3, cp.y * 0.18, cp.z * 1.3)));
          lime *= 1.0 - streak * 0.45 * (1.0 - abs(up));
          float mossN = cNoise(cp * 0.9 + 11.0) * 0.7 + grain * 0.3;
          float moss = smoothstep(0.15, 0.6, up + (mossN - 0.5) * 0.9);
          vec3 mossC = mix(vec3(0.16, 0.32, 0.10), vec3(0.30, 0.48, 0.16), mossN);
          albedo += mix(lime, mossC, moss) * (0.85 + grain * 0.3) * bw.x;
        }
        if (bw.y > 0.01) {
          // Crystal caverns
          float strata = sin(cp.y * 3.1 + big * 6.0 + cNoise(cp * 0.6) * 3.0) * 0.5 + 0.5;
          vec3 slate = mix(vec3(0.20, 0.23, 0.31), vec3(0.34, 0.37, 0.47), strata * 0.7 + grain * 0.3);
          albedo += slate * bw.y;
          // Sparse tiny mineral glints, only up close (big cells read as snow, so keep them small)
          vec3 sc = floor(cp * 24.0);
          float speck = step(0.992, cHash(sc + 17.0)) * (1.0 - smoothstep(4.0, 12.0, dist));
          float tw = 0.5 + 0.5 * sin(uCaveTime * 2.0 + cHash(sc + 3.0) * 30.0);
          glow += vec3(0.25, 0.55, 0.9) * speck * tw * 0.45 * smoothstep(0.5, 0.9, bw.y);
        }
        if (bw.z > 0.01) {
          // Ember depths
          float band = smoothstep(0.4, 0.8, cNoise(vec3(cp.x * 0.25, cp.y * 1.4, cp.z * 0.25)));
          vec3 basalt = mix(vec3(0.17, 0.11, 0.10), vec3(0.42, 0.20, 0.11), band);
          basalt = mix(basalt, vec3(0.24, 0.21, 0.19), smoothstep(0.55, 0.9, up) * 0.7); // ash floors
          albedo += basalt * (0.8 + grain * 0.4) * bw.z;
          // Thin glowing veins: the zero-crossings of a warped noise, gated so only some areas glow
          float vn = cNoise(cp * 0.7 + 5.0 + (cNoise(cp * 2.1) - 0.5) * 0.6);
          float ridge = 1.0 - abs(vn * 2.0 - 1.0);
          float gate = smoothstep(0.45, 0.7, cNoise(cp * 0.13 + 9.0));
          float crack = smoothstep(0.975, 0.997, ridge) * gate * (1.0 - smoothstep(0.6, 0.95, up) * 0.5);
          float pulse = 0.7 + 0.3 * sin(uCaveTime * 1.3 + cp.x * 0.2 + cp.z * 0.15);
          albedo *= 1.0 - smoothstep(0.93, 0.99, ridge) * gate * 0.6 * bw.z; // scorched rim
          glow += vec3(0.9, 0.28, 0.05) * crack * pulse * 0.9 * bw.z;
        }
        // Near and under the water (see CaveGen WET_*): a dark wet band at the shore, then a blue-green
        // tint deepening with depth and moving caustics on what faces up
        if (vWet > 0.002) {
          float depth = (vWet * 255.0 - 1.0) / 254.0 * ${WET_RANGE.toFixed(1)} - ${WET_ABOVE.toFixed(2)};
          float shore = 1.0 - smoothstep(0.0, ${WET_ABOVE.toFixed(2)}, -depth);
          albedo *= 1.0 - 0.35 * shore;
          if (depth > 0.0) {
            float deep = smoothstep(0.0, 6.0, depth);
            vec3 tint = mix(vec3(0.45, 0.7, 0.75), vec3(0.12, 0.3, 0.45) + vec3(0.0, 0.06, 0.12) * bw.y, deep);
            albedo *= tint;
            // The same caustics as the sea and rivers (WaterEffects), always on down here; the
            // cave has no sun, so they glow faintly in the lake's colour instead of focusing it
            vec3 caustic = causticsPattern(vCaveWorld, depth, up);
            glow += caustic * ${CAUSTICS_TINT} * mix(vec3(0.05, 0.12, 0.12), vec3(0.05, 0.13, 0.24), bw.y);
            glow += vec3(0.002, 0.012, 0.03) * bw.y * (1.0 - deep * 0.5);
          }
        }
        diffuseColor.rgb = albedo * vCave.a;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += glow;`
      );
  };
  mat.customProgramCacheKey = () => 'cave-rock-v6';
  return mat;
}

/**
 * Still cave water: dark, a little see-through, lit by the fake lights, with a slow shimmer. Its
 * colour follows the biome: green in the moss grotto, glowing blue in the flooded crystal caverns,
 * murky amber-brown in the ember depths. Fresnel: looking straight down it is clearer.
 */
export function createCaveWaterMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.84,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (shader) => {
    injectNightLights(shader);
    Object.assign(shader.uniforms, caveUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 waterBiome;
varying vec3 vWPos;
varying vec3 vWWorld;
varying vec3 vWBio;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vWPos = position;
vWWorld = (modelMatrix * vec4(position, 1.0)).xyz;
vWBio = waterBiome;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uCaveTime;
varying vec3 vWPos;
varying vec3 vWWorld;
varying vec3 vWBio;
${NOISE_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 wb = vWBio / max(vWBio.r + vWBio.g + vWBio.b, 0.001);
        vec3 wcol = vec3(0.012, 0.055, 0.04) * wb.x + vec3(0.012, 0.07, 0.16) * wb.y + vec3(0.045, 0.022, 0.008) * wb.z;
        float sh = cNoise(vec3(vWPos.x * 1.4, uCaveTime * 0.35, vWPos.z * 1.4)) * 0.6 + cNoise(vec3(vWPos.x * 3.7 + uCaveTime * 0.2, 0.0, vWPos.z * 3.7)) * 0.4;
        diffuseColor.rgb = wcol * (0.75 + sh * 0.55);
        // Fresnel: clearer looking straight down, a mirror-dark sheet at a glancing angle
        vec3 vdir = normalize(cameraPosition - vWWorld);
        diffuseColor.a = mix(0.95, 0.66, smoothstep(0.15, 0.85, abs(vdir.y)));
        // The flooded caverns glow from below (crystals under the surface)
        float sparkle = smoothstep(0.62, 0.8, cNoise(vec3(vWPos.x * 0.35, uCaveTime * 0.12, vWPos.z * 0.35)));
        vec3 wglow = vec3(0.004, 0.022, 0.05) * wb.y * (0.5 + sparkle * 1.2) + vec3(0.001, 0.005, 0.003) * wb.x + vec3(0.008, 0.003, 0.0) * wb.z;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += wglow;`
      );
  };
  mat.customProgramCacheKey = () => 'cave-water-v3';
  return mat;
}
