import * as THREE from 'three';

const SIZE = 128;
const TAU = Math.PI * 2;
const wrap = THREE.MathUtils.euclideanModulo;
const smooth = THREE.MathUtils.smoothstep;
type RGB = readonly [number, number, number];
type Surface = readonly [color: RGB, variation: number, height: number];

interface FloorTexture {
  texture: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  dataUrl: string;
}

function repeatTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

/** Sample one periodic surface for both the albedo and the tangent-space relief. */
function renderFloor(sample: (x: number, y: number) => Surface): FloorTexture {
  const canvas = document.createElement('canvas');
  const normalCanvas = document.createElement('canvas');
  canvas.width = canvas.height = normalCanvas.width = normalCanvas.height = SIZE;
  const albedo = canvas.getContext('2d')!;
  const normals = normalCanvas.getContext('2d')!;
  const colorData = albedo.createImageData(SIZE, SIZE);
  const normalData = normals.createImageData(SIZE, SIZE);
  const height = new Float32Array(SIZE * SIZE);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [color, variation, relief] = sample((x + 0.5) / SIZE, (y + 0.5) / SIZE);
      const pixel = y * SIZE + x;
      height[pixel] = relief;
      for (let channel = 0; channel < 3; channel++) {
        colorData.data[pixel * 4 + channel] = color[channel] + variation;
      }
      colorData.data[pixel * 4 + 3] = 255;
    }
  }

  const at = (x: number, y: number) => height[wrap(y, SIZE) * SIZE + wrap(x, SIZE)];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * 0.5;
      // Canvas rows run down, while texture V goes up.
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5;
      const nz = 1 / Math.hypot(dx, dy, 1);
      const i = (y * SIZE + x) * 4;
      normalData.data[i] = (dx * nz + 1) * 127.5;
      normalData.data[i + 1] = (dy * nz + 1) * 127.5;
      normalData.data[i + 2] = (nz + 1) * 127.5;
      normalData.data[i + 3] = 255;
    }
  }
  albedo.putImageData(colorData, 0, 0);
  normals.putImageData(normalData, 0, 0);
  const texture = repeatTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, normalMap: repeatTexture(normalCanvas), dataUrl: canvas.toDataURL('image/png') };
}

const PINE: RGB = [211, 176, 130];
const WALNUT: RGB = [95, 64, 47];
const OAK: RGB = [173, 124, 76];

/** u runs along a board; v runs across it. Grain and relief wrap with the board. */
function wood(u: number, v: number, tone: number, color: RGB, lengthToWidth: number): Surface {
  const warp = Math.sin(TAU * u) * 0.65 + Math.sin(TAU * (2 * u + tone)) * 0.28;
  const broad = Math.sin(TAU * (3 * v + warp));
  const fine = Math.sin(TAU * (11 * v + warp * 0.52));
  const edge = Math.min(v, 1 - v, u * lengthToWidth, (1 - u) * lengthToWidth);
  const bevel = smooth(edge, 0.005, 0.10);
  return [color, tone * 10 + broad * 4 + fine * 1.6 - (1 - bevel) * 28,
    bevel * 0.95 + (broad * 0.08 + fine * 0.035) * bevel];
}

function plankFloor(color: RGB): FloorTexture {
  return renderFloor((x, y) => {
    const row = Math.floor(y * 6);
    const u = wrap(x + row * 0.381966, 1);
    const v = y * 6 - row;
    const tone = Math.sin(row * 3.72);
    return wood(u, v, tone, color, 6);
  });
}

export function createLightPineFloorTexture(): FloorTexture {
  return plankFloor(PINE);
}

export function createDarkWalnutFloorTexture(): FloorTexture {
  return plankFloor(WALNUT);
}

export function createHerringboneParquetTexture(): FloorTexture {
  return renderFloor((x, y) => {
    const gx = x * 8;
    const gy = y * 8;
    const col = Math.floor(gx);
    const row = Math.floor(gy);
    const diagonal = wrap(col - row, 8);
    if (diagonal < 4) {
      const start = col - diagonal;
      return wood((gx - start) / 4, gy - row, Math.sin(wrap(start, 8) + row * 3), OAK, 4);
    }
    const start = row - (7 - diagonal);
    return wood((gy - start) / 4, gx - col, Math.sin(wrap(start, 8) + col * 3 + 1), OAK, 4);
  });
}

/** Width and height of a tile grid may differ. A staggered row wraps its tile IDs as well. */
function tiledFloor(
  columns: number,
  rows: number,
  staggered: boolean,
  sample: (u: number, v: number, column: number, row: number, bevel: number) => Surface
): FloorTexture {
  return renderFloor((x, y) => {
    const row = Math.floor(y * rows);
    const gx = x * columns - (staggered && row % 2 ? 0.5 : 0);
    const column = Math.floor(gx);
    const u = gx - column;
    const v = y * rows - row;
    const edge = Math.min(u, 1 - u, v, 1 - v);
    return sample(u, v, wrap(column, columns), row, smooth(edge, 0.018, 0.085));
  });
}

export function createCheckerMarbleFloorTexture(): FloorTexture {
  return tiledFloor(4, 4, false, (u, v, col, row, bevel) => {
    const light = (col + row) % 2 === 0;
    const color: RGB = light ? [223, 222, 211] : [48, 51, 55];
    const wave = u * 2.7 - v * 1.8 + 0.22 * Math.sin(v * TAU) + col * 0.7 + row * 0.9;
    const vein = Math.pow(Math.abs(Math.sin(wave * Math.PI)), 14);
    return [color, vein * (light ? -24 : 20) - (1 - bevel) * (light ? 39 : 13), bevel * 0.8];
  });
}

export function createTerracottaCottoFloorTexture(): FloorTexture {
  const clay: RGB = [174, 101, 73];
  return tiledFloor(4, 4, false, (u, v, col, row, bevel) => {
    const tone = Math.sin(col * 5.8 + row * 3.9) * 11;
    const cloud = Math.cos(TAU * (u * 1.3 + v * 0.9)) * 4 + Math.sin(TAU * (u - 2 * v)) * 3;
    return [clay, bevel * (tone + cloud + 6) - (1 - bevel) * 19, bevel * (1 + cloud * 0.024)];
  });
}

export function createFlagstonePaversFloorTexture(): FloorTexture {
  const stone: RGB = [129, 127, 116];
  return tiledFloor(4, 6, true, (u, v, col, row, bevel) => {
    const tone = Math.sin(col * 7.1 + row * 5.3) * 15;
    const grain = Math.cos(TAU * (u * 3 + v * 2)) * Math.sin(TAU * (u - v * 3)) * 4;
    return [stone, (tone + grain) * bevel - (1 - bevel) * 39, bevel * (1.5 + grain * 0.065)];
  });
}

export function createMoroccanMosaicFloorTexture(): FloorTexture {
  const cream: RGB = [222, 208, 176];
  const teal: RGB = [53, 121, 122];
  const blue: RGB = [45, 70, 89];
  const ochre: RGB = [196, 147, 79];
  return tiledFloor(4, 4, false, (u, v, _col, _row, bevel) => {
    const x = Math.abs(u - 0.5);
    const y = Math.abs(v - 0.5);
    const petals = x + y < 0.40 && (x < 0.14 || y < 0.14 || x + y < 0.24);
    const corner = Math.abs(x - 0.35) + Math.abs(y - 0.35) < 0.10;
    const color = x + y < 0.115 ? ochre : petals ? teal : corner ? blue : cream;
    return [bevel < 0.4 ? cream : color, (bevel - 1) * 22, bevel * 0.75];
  });
}

export function createRoyalCarpetFloorTexture(): FloorTexture {
  const burgundy: RGB = [112, 43, 52];
  const gold: RGB = [178, 133, 80];
  return renderFloor((u, v) => {
    const x = wrap(u * 2, 1) - 0.5;
    const y = wrap(v * 2, 1) - 0.5;
    const angle = Math.atan2(y, x);
    const radius = Math.hypot(x, y);
    const petalEdge = 0.207 + 0.072 * Math.cos(angle * 8);
    const medallion = Math.abs(radius - petalEdge) < 0.030 || radius < 0.058;
    const links = Math.abs(Math.abs(x) + Math.abs(y) - 0.5) < 0.018;
    const weave = Math.sin(TAU * u * 48) * Math.cos(TAU * v * 48);
    return [medallion || links ? gold : burgundy, weave * 5, weave * 0.2 + (medallion || links ? 0.13 : 0)];
  });
}
