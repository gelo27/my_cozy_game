import * as THREE from 'three';
import { fineSurfaceGrain, periodicNoise, stoneSurfaceTone } from './SurfacePatterns';

let surfaceTexture: THREE.DataTexture | undefined;

export function getRockSurfaceTexture(): THREE.DataTexture {
  if (surfaceTexture) return surfaceTexture;
  const side = 256;
  const pixels = new Uint8Array(side * side * 4);
  const byte = (value: number) => Math.round(255 * THREE.MathUtils.clamp(value, 0, 1));
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const u = (x + 0.5) / side, v = (y + 0.5) / side;
    const warpX = u + (periodicNoise(u, v, 5, 17) - 0.5) * 0.17;
    const warpY = v + (periodicNoise(u, v, 5, 47) - 0.5) * 0.15;
    const grain = fineSurfaceGrain(u, v);
    const stone = stoneSurfaceTone(u, v, grain);
    const organic = periodicNoise(warpX, warpY, 9, 89) * 0.7 + periodicNoise(u, v, 30, 23) * 0.3;
    const i = (y * side + x) * 4;
    pixels[i] = byte(stone);
    pixels[i + 1] = byte(organic);
    pixels[i + 2] = byte(grain);
    pixels[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, side, side);
  texture.name = 'Seamless rock, moss and snow detail';
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  surfaceTexture = texture;
  return texture;
}

export const ROCK_SURFACE_TONE_GLSL = `
float rockSurfaceTone(vec3 detail) {
  return 0.72 + detail.r * 0.51 + detail.b * 0.12;
}`;
