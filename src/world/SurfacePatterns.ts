import { MathUtils } from 'three';

function lattice(x: number, y: number, periodX: number, periodY: number, seed: number): number {
  let h = Math.imul(MathUtils.euclideanModulo(x, periodX) + seed, 0x9e3779b1) ^
    Math.imul(MathUtils.euclideanModulo(y, periodY) + 31, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

/** Noise repeats smoothly at each edge, including when the lattice is stretched. */
export function periodicNoise(u: number, v: number, periodX: number, seed: number, periodY = periodX): number {
  const x = u * periodX, y = v * periodY;
  const ix = Math.floor(x), iy = Math.floor(y);
  const tx = x - ix, ty = y - iy;
  const a = tx * tx * (3 - 2 * tx), b = ty * ty * (3 - 2 * ty);
  const top = MathUtils.lerp(lattice(ix, iy, periodX, periodY, seed), lattice(ix + 1, iy, periodX, periodY, seed), a);
  const bottom = MathUtils.lerp(lattice(ix, iy + 1, periodX, periodY, seed), lattice(ix + 1, iy + 1, periodX, periodY, seed), a);
  return MathUtils.lerp(top, bottom, b);
}

export function fineSurfaceGrain(u: number, v: number): number {
  return periodicNoise(u, v, 80, 59) * 0.68 + periodicNoise(u, v, 34, 13) * 0.32;
}

export function stoneSurfaceTone(u: number, v: number, grain: number): number {
  const x = u + (periodicNoise(u, v, 5, 17) - 0.5) * 0.17;
  const y = v + (periodicNoise(u, v, 5, 47) - 0.5) * 0.15;
  return periodicNoise(x, y, 6, 71) * 0.48 + periodicNoise(u, v, 18, 7) * 0.37 + grain * 0.15;
}
