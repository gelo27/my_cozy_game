import * as THREE from 'three';

const SIZE = 128;
const TAU = Math.PI * 2;
const { euclideanModulo: wrap, smoothstep } = THREE.MathUtils;
type RGB = readonly [number, number, number];
type Sample = readonly [RGB, number];
type Cell = { u: number; v: number; col: number; row: number };

function roofTexture(sample: (x: number, y: number) => Sample): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [color, variation] = sample((x + 0.5) / SIZE, (y + 0.5) / SIZE);
      const i = (y * SIZE + x) * 4;
      image.data[i] = color[0] + variation;
      image.data[i + 1] = color[1] + variation;
      image.data[i + 2] = color[2] + variation;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function courses(columns: number, rows: number, sample: (cell: Cell) => Sample): THREE.CanvasTexture {
  return roofTexture((x, y) => {
    const row = Math.floor(y * rows);
    const gx = x * columns + (row % 2) * 0.5;
    const col = Math.floor(gx);
    return sample({ u: gx - col, v: y * rows - row, col: wrap(col, columns), row });
  });
}

function tileTone(col: number, row: number): number {
  return Math.sin(col * 6.7 + row * 3.9) * 0.65 + Math.cos(col * 2.3 - row * 8.2) * 0.35;
}

/** Thin highlight on the lower lip and a short shadow at the top of the next course. */
function overlap(v: number): number {
  return -22 * (1 - smoothstep(v, 0.015, 0.19)) + 15 * smoothstep(v, 0.76, 0.98);
}

function woodShakes(color: RGB, columns: number): THREE.CanvasTexture {
  return courses(columns, 4, ({ u, v, col, row }) => {
    const tone = tileTone(col, row);
    const warp = Math.sin(v * 3.6 + tone) * 0.34 + tone * 1.8;
    const grain = Math.sin(TAU * (2.1 * u + warp)) * 4 + Math.sin(TAU * (5.7 * u + warp * 0.65)) * 2.4;
    const edge = Math.min(u, 1 - u);
    const gap = 1 - smoothstep(edge, 0.018, 0.083);
    const chip = smoothstep(v, 0.83, 1) * (1 - smoothstep(edge, 0.04, 0.19)) * 10;
    return [color, 14 * tone + grain + overlap(v) - 28 * gap - chip];
  });
}

export function createBarkwoodShingleTexture(): THREE.CanvasTexture {
  return woodShakes([84, 57, 41], 5);
}

export function createSunriseShingleTexture(): THREE.CanvasTexture {
  return woodShakes([150, 98, 58], 6);
}

export function createMissionTileTexture(): THREE.CanvasTexture {
  const clay: RGB = [160, 77, 47];
  return roofTexture((x, y) => {
    const gx = x * 5;
    const col = Math.floor(gx);
    const row = Math.floor(y * 4);
    const v = y * 4 - row;
    const arch = (Math.cos(TAU * (gx - 0.45)) + 1) * 0.5;
    const highlight = Math.pow((Math.cos(TAU * (gx - 0.30)) + 1) * 0.5, 5);
    const grain = Math.sin(TAU * (gx * 3 + y * 13)) * Math.cos(TAU * (x * 19 - y * 17));
    return [clay, 36 * arch + 10 * highlight - 22 + 10 * tileTone(col, row) * arch + overlap(v) + 3 * grain];
  });
}

export function createBlueSlateTexture(): THREE.CanvasTexture {
  const slate: RGB = [79, 98, 112];
  return courses(4, 4, ({ u, v, col, row }) => {
    const tone = tileTone(col, row);
    const chip = smoothstep(v, 0.76, 1) * (0.10 + tone * 0.035);
    const edge = Math.min(u, 1 - u) - chip;
    const vein = Math.sin(TAU * (v * 2.5 - u * 0.62 + tone * 2 + Math.sin(u * 5.3) * 0.17));
    return [slate, 17 * tone + 8 * Math.pow(Math.max(0, vein), 7) + overlap(v) - 27 * (1 - smoothstep(edge, 0.015, 0.073))];
  });
}

export function createScallopedRoofTexture(): THREE.CanvasTexture {
  const clay: RGB = [88, 118, 98];
  return courses(5, 4, ({ u, v, col, row }) => {
    const shape = 1 - 0.44 * (1 - Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2)));
    const edge = Math.min(u, 1 - u);
    const face = 1 - smoothstep(v - shape, -0.035, 0.018);
    const lip = smoothstep(v - shape, -0.145, -0.028);
    const tone = tileTone(col, row);
    return [clay, -31 + face * (25 + 13 * tone + 16 * lip - 23 * (1 - smoothstep(edge, 0.008, 0.069)))];
  });
}

export function createStandingSeamRoofTexture(): THREE.CanvasTexture {
  const metal: RGB = [68, 94, 94];
  return roofTexture((x, y) => {
    const panel = x * 3;
    const u = wrap(panel, 1);
    const gap = Math.min(u, 1 - u);
    const seam = 1 - smoothstep(gap, 0.021, 0.067);
    const lip = seam * (u < 0.5 ? 31 : -13);
    return [metal, lip + 6 * Math.cos(TAU * (panel - 0.27)) + 3 * Math.sin(TAU * (x * 4 + y))];
  });
}

export function createStrawRoofTexture(): THREE.CanvasTexture {
  const straw: RGB = [159, 124, 68];
  return roofTexture((x, y) => {
    const v = wrap(y * 3 + Math.sin(TAU * x * 3) * 0.07, 1);
    const sway = Math.sin(TAU * y * 2) * 0.42 + Math.sin(TAU * (x * 2 + y)) * 0.27;
    const stems = Math.sin(TAU * (x * 46 + sway)) * 11 + Math.cos(TAU * (x * 27 + sway)) * 7;
    const bundles = Math.cos(TAU * (x * 8 + Math.sin(TAU * y * 3) * 0.19)) * 12;
    return [straw, stems + bundles + overlap(v)];
  });
}
