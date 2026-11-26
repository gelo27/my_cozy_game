import { MathUtils } from 'three';
import { fineSurfaceGrain, periodicNoise } from './SurfacePatterns';

const PALETTES = {
  grass: [[57, 101, 45], [86, 141, 67]],
  birch: [[51, 87, 58], [100, 140, 82]],
  dry: [[106, 101, 53], [158, 148, 83]],
  sand: [[180, 148, 104], [227, 203, 153]],
  dirt: [[99, 69, 48], [161, 121, 85]],
} as const;

type Surface = keyof typeof PALETTES;

export function paintGroundSurface(ctx: CanvasRenderingContext2D, size: number, surface: Surface): void {
  const image = ctx.createImageData(size, size);
  const [shade, light] = PALETTES[surface];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    const grain = fineSurfaceGrain(u, v);
    const pattern = groundTone(surface, u, v, grain);
    const i = (y * size + x) * 4;
    for (let c = 0; c < 3; c++) image.data[i + c] = MathUtils.lerp(shade[c], light[c], pattern);
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

function groundTone(surface: Surface, u: number, v: number, grain: number): number {
  const patch = periodicNoise(u, v, 7, 81);
  if (surface === 'sand') {
    const bend = (periodicNoise(u, v, 5, 105) - 0.5) * 0.14;
    const drift = periodicNoise(u, v + bend, 5, 29, 13);
    return 0.34 + drift * 0.19 + patch * 0.12 + grain * 0.34;
  }
  if (surface === 'dirt') {
    const clumps = periodicNoise(u, v, 24, 100);
    const grit = MathUtils.smoothstep(periodicNoise(u, v, 44, 63), 0.77, 0.94);
    return 0.12 + patch * 0.16 + clumps * 0.48 + grain * 0.16 + grit * 0.08;
  }
  const drift = (periodicNoise(u, v, 10, 44) - 0.5) * 0.055;
  const blades = MathUtils.smoothstep(periodicNoise(u + drift, v, 42, 23, 21), 0.45, 0.80);
  return 0.28 + patch * 0.16 + blades * 0.30 + grain * 0.21;
}
