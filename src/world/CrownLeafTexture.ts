import * as THREE from 'three';

const SIZE = 256;
const ROWS = 9;
let texture: THREE.DataTexture | undefined;

/** Bakes the relief into one repeatable, linear brightness channel for the distant crowns. */
export function crownLeafTexture(): THREE.DataTexture {
  if (texture) return texture;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#737373';
  ctx.fillRect(0, 0, SIZE, SIZE);

  let seed = 1337;
  const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const leaves = Array.from({ length: ROWS * ROWS }, () => ({
    x: (random() - 0.5) * 0.46,
    y: (random() - 0.5) * 0.54,
    width: 1.03 + random() * 0.45,
    height: 1.2 + random() * 0.52,
    tilt: (random() - 0.5) * 1.22,
    tone: (random() - 0.5) * 27,
  }));
  const step = SIZE / ROWS;
  const wrap = (value: number) => THREE.MathUtils.euclideanModulo(value, ROWS);
  // Paint from bottom to top so upper leaves overlap the ones below. The outer rows
  // repeat the same seeded shapes so the relief and shadows wrap across both edges.
  for (let row = ROWS + 1; row >= -2; row--) {
    for (let col = -2; col <= ROWS + 1; col++) {
      const y = wrap(row), x = wrap(col);
      const leaf = leaves[y * ROWS + x];
      // Broad groups keep their contrast when the mipmaps average the individual leaves.
      const broadTone = 31 * Math.sin((x + y) * Math.PI * 2 / ROWS)
        + 17 * Math.sin((x - 2 * y) * Math.PI * 2 / ROWS);
      ctx.save();
      ctx.translate((col + (y % 2 ? 0.62 : 0.12) + leaf.x) * step, (row + 0.5 + leaf.y) * step);
      ctx.rotate(leaf.tilt);
      ctx.scale(leaf.width * step, leaf.height * step);
      paintLeaf(ctx, 165 + leaf.tone + broadTone);
      ctx.restore();
    }
  }

  const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const red = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < red.length; i++) red[i] = rgba[i * 4];

  texture = new THREE.DataTexture(red, SIZE, SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function paintLeaf(ctx: CanvasRenderingContext2D, tone: number): void {
  const outline = new Path2D();
  outline.moveTo(-0.04, -0.57);
  outline.bezierCurveTo(0.21, -0.51, 0.48, -0.32, 0.47, -0.04);
  outline.bezierCurveTo(0.49, 0.29, 0.21, 0.53, 0.05, 0.58);
  outline.bezierCurveTo(-0.19, 0.48, -0.48, 0.26, -0.48, -0.02);
  outline.bezierCurveTo(-0.5, -0.25, -0.28, -0.49, -0.04, -0.57);

  ctx.save();
  ctx.translate(0.012, 0.042);
  ctx.fillStyle = 'rgba(48,48,48,0.40)';
  ctx.fill(outline);
  ctx.restore();

  const gray = (value: number) => {
    const channel = Math.round(THREE.MathUtils.clamp(value, 0, 255));
    return `rgb(${channel} ${channel} ${channel})`;
  };
  const face = ctx.createLinearGradient(-0.32, -0.46, 0.29, 0.54);
  face.addColorStop(0, gray(tone - 58));
  face.addColorStop(0.43, gray(tone + 8));
  face.addColorStop(0.83, gray(tone + 41));
  face.addColorStop(1, gray(tone - 23));
  ctx.fillStyle = face;
  ctx.fill(outline);

  ctx.clip(outline);
  ctx.beginPath();
  ctx.moveTo(-0.04, -0.4);
  ctx.quadraticCurveTo(-0.09, 0.02, 0.05, 0.47);
  ctx.strokeStyle = 'rgba(255,255,255,0.19)';
  ctx.lineWidth = 0.024;
  ctx.lineCap = 'round';
  ctx.stroke();
}
