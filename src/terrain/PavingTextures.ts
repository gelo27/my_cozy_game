import { TerrainTileType } from './types/TerrainTypes';

type Point = [number, number];

interface PavingStyle {
  joint: string;
  tones: readonly string[];
  rounding: number;
  flecks: number;
  strata: number;
}

const STYLES = {
  [TerrainTileType.STONE_COBBLE]: {
    joint: '#585750', tones: ['#8d9087', '#99988c', '#a5a292', '#858782', '#929b96'],
    rounding: 0.32, flecks: 0.10, strata: 0,
  },
  [TerrainTileType.SIDEWALK_PAVERS]: {
    joint: '#62696a', tones: ['#a6afad', '#b0b6b2', '#a2aaa7', '#aeb0a6'],
    rounding: 0.12, flecks: 0.07, strata: 0,
  },
  [TerrainTileType.CLINKER_HERRINGBONE]: {
    joint: '#765145', tones: ['#b97258', '#b1644e', '#c37c60', '#ad634e', '#ca886a'],
    rounding: 0.17, flecks: 0.09, strata: 0,
  },
  [TerrainTileType.GRANITE_SETTS]: {
    joint: '#505156', tones: ['#7a8189', '#8e9295', '#777d83', '#969a9b', '#89848b'],
    rounding: 0.09, flecks: 0.23, strata: 0,
  },
  [TerrainTileType.SANDSTONE_FLAGSTONE]: {
    joint: '#88755d', tones: ['#bea17a', '#c9af87', '#b99b77', '#d2b68d', '#c8a883'],
    rounding: 0.21, flecks: 0.07, strata: 0.13,
  },
  [TerrainTileType.LIMESTONE_PAVERS]: {
    joint: '#a59b88', tones: ['#d9d0ba', '#d4cab6', '#e2d8c4', '#dad2c2'],
    rounding: 0.12, flecks: 0.07, strata: 0.10,
  },
} satisfies Partial<Record<TerrainTileType, PavingStyle>>;

function randomSequence(seed: number): () => number {
  return () => (seed = seed * 16807 % 2147483647) / 2147483647;
}

function paintFlecks(
  ctx: CanvasRenderingContext2D, left: number, top: number, width: number, height: number,
  strength: number, random: () => number, wrap = false,
): void {
  for (let i = 0; i < width * height / 28; i++) {
    const x = left + random() * width;
    const y = top + random() * height;
    ctx.fillStyle = random() < 0.5 ? '#f1ece1' : '#4e4745';
    ctx.globalAlpha = strength * (0.4 + random() * 0.6);
    const w = 0.65 + random() * 1.2;
    const h = 0.6 + random() * 0.65;
    ctx.fillRect(x, y, w, h);
    if (wrap && x + w > width) ctx.fillRect(x - width, y, w, h);
    if (wrap && y + h > height) ctx.fillRect(x, y - height, w, h);
    if (wrap && x + w > width && y + h > height) ctx.fillRect(x - width, y - height, w, h);
  }
  ctx.globalAlpha = 1;
}

/** A continuous stone face, shared by straight and curved curb pieces. */
export function paintCurbTexture(ctx: CanvasRenderingContext2D, size: number, type: keyof typeof STYLES): void {
  const style = STYLES[type];
  const random = randomSequence(type * 7639 + 151);
  const pixels = ctx.createImageData(size, size);
  const tone = style.tones[0];
  const channels = [1, 3, 5].map(i => parseInt(tone.slice(i, i + 2), 16));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * Math.PI * 2 / size, v = y * Math.PI * 2 / size;
      const cloud = 3.4 * Math.sin(3 * u + 2 * v) + 2.1 * Math.sin(7 * u - 4 * v);
      const vein = style.strata ? 70 * style.strata * Math.pow(Math.max(0, Math.sin(5 * v + 2 * u + 0.45 * Math.sin(3 * u))), 16) : 0;
      const i = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels.data[i + channel] = channels[channel] + 7 + cloud + vein;
      }
      pixels.data[i + 3] = 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);
  paintFlecks(ctx, 0, 0, size, size, style.flecks, random, true);
}

function roundedOutline(points: Point[], rounding: number): Path2D {
  const path = new Path2D();
  points.forEach(([x, y], i) => {
    const prev = points[(i + points.length - 1) % points.length];
    const next = points[(i + 1) % points.length];
    const inX = x + (prev[0] - x) * rounding;
    const inY = y + (prev[1] - y) * rounding;
    if (i === 0) path.moveTo(inX, inY);
    else path.lineTo(inX, inY);
    path.quadraticCurveTo(x, y, x + (next[0] - x) * rounding, y + (next[1] - y) * rounding);
  });
  path.closePath();
  return path;
}

function drawStone(
  ctx: CanvasRenderingContext2D, size: number, points: Point[], style: PavingStyle, seed: number,
): void {
  const left = Math.min(...points.map(([x]) => x));
  const right = Math.max(...points.map(([x]) => x));
  const top = Math.min(...points.map(([, y]) => y));
  const bottom = Math.max(...points.map(([, y]) => y));
  const width = right - left;
  const height = bottom - top;
  const outline = roundedOutline(points, style.rounding);
  for (const dx of [-size, 0, size]) {
    if (right + dx <= 0 || left + dx >= size) continue;
    for (const dy of [-size, 0, size]) {
      if (bottom + dy <= 0 || top + dy >= size) continue;
      // Each copy has the same tone and surface details, including across the repeat seam.
      const random = randomSequence(seed);
      ctx.save();
      ctx.translate(dx, dy);
      ctx.fillStyle = style.tones[Math.floor(random() * style.tones.length)];
      ctx.fill(outline);
      ctx.clip(outline);

      const face = ctx.createLinearGradient(left, top, right, bottom);
      face.addColorStop(0, 'rgba(255,247,229,0.18)');
      face.addColorStop(0.55, 'rgba(255,247,229,0)');
      face.addColorStop(1, 'rgba(51,42,36,0.11)');
      ctx.fillStyle = face;
      ctx.fillRect(left, top, width, height);

      if (style.strata) {
        const y = top + height * (0.24 + random() * 0.52);
        ctx.beginPath();
        ctx.moveTo(left, y + height * 0.13);
        ctx.bezierCurveTo(left + width * 0.3, y - height * 0.18, right - width * 0.3, y + height * 0.12, right, y - height * 0.13);
        ctx.strokeStyle = `rgba(255,247,225,${style.strata})`;
        ctx.lineWidth = 0.8 + random();
        ctx.stroke();
      }

      paintFlecks(ctx, left, top, width, height, style.flecks, random);

      const rim = ctx.createLinearGradient(left, top, right, bottom);
      rim.addColorStop(0, 'rgba(255,252,230,0.43)');
      rim.addColorStop(0.48, 'rgba(255,252,230,0)');
      rim.addColorStop(1, 'rgba(48,40,35,0.32)');
      ctx.strokeStyle = rim;
      ctx.lineWidth = Math.min(width, height) * 0.16;
      ctx.stroke(outline);
      ctx.restore();
    }
  }
}

function chippedBlock(x: number, y: number, w: number, h: number, cut: number, random: () => number): Point[] {
  const left = x - w / 2, right = x + w / 2;
  const top = y - h / 2, bottom = y + h / 2;
  const chip = () => cut * (0.6 + random() * 0.8);
  return [
    [left + chip(), top], [right - chip(), top], [right, top + chip()],
    [right, bottom - chip()], [right - chip(), bottom], [left + chip(), bottom],
    [left, bottom - chip()], [left, top + chip()],
  ];
}

// Move each bisector slightly inward to create the joints between adjacent slabs.
function clipSlab(points: Point[], center: Point, neighbor: Point, gap: number): Point[] {
  const dx = neighbor[0] - center[0], dy = neighbor[1] - center[1];
  const limit = (dx * dx + dy * dy) * 0.5 - Math.hypot(dx, dy) * gap;
  const distance = ([x, y]: Point) => (x - center[0]) * dx + (y - center[1]) * dy - limit;
  const result: Point[] = [];
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length];
    const da = distance(a), db = distance(b);
    if (da <= 0) result.push(a);
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db);
      result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  });
  return result;
}

function drawFlagstones(size: number, random: () => number, draw: (points: Point[]) => void): void {
  const step = size / 4;
  const centers: Point[] = Array.from({ length: 16 }, (_, i) => [
    ((i % 4) + 0.5 + (Math.floor(i / 4) % 2) * 0.42 + (random() - 0.5) * 0.43) * step,
    (Math.floor(i / 4) + 0.5 + (random() - 0.5) * 0.5) * step,
  ]);
  for (const center of centers) {
    const [x, y] = center;
    let points: Point[] = [[x - step, y - step], [x + step, y - step], [x + step, y + step], [x - step, y + step]];
    for (const [nx, ny] of centers) {
      for (const dx of [-size, 0, size]) {
        for (const dy of [-size, 0, size]) {
          if (nx + dx === x && ny + dy === y) continue;
          points = clipSlab(points, center, [nx + dx, ny + dy], size * 0.007);
        }
      }
    }
    draw(points);
  }
}

/** Paint only albedo into the terrain layer. All dimensions are relative to the repeat period. */
export function paintPavingTexture(ctx: CanvasRenderingContext2D, size: number, type: keyof typeof STYLES): void {
  const style = STYLES[type];

  const random = randomSequence(type * 9973 + 17);
  const draw = (points: Point[]) => drawStone(ctx, size, points, style, 1 + Math.floor(random() * 2147483645));
  const unit = size / 128;
  ctx.fillStyle = style.joint;
  ctx.fillRect(0, 0, size, size);

  if (type === TerrainTileType.SANDSTONE_FLAGSTONE) {
    drawFlagstones(size, random, draw);
  } else if (type === TerrainTileType.CLINKER_HERRINGBONE) {
    // Each horizontal brick spans diagonals 0–1, each vertical brick spans 3–2.
    const cell = size / 8;
    const short = cell - 1.5 * unit;
    const long = 2 * cell - 1.5 * unit;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const diagonal = (col - row + 8) % 4;
        if (diagonal === 0) draw(chippedBlock((col + 1) * cell, (row + 0.5) * cell, long, short, 1.4 * unit, random));
        if (diagonal === 3) draw(chippedBlock((col + 0.5) * cell, (row + 1) * cell, short, long, 1.4 * unit, random));
      }
    }
  } else {
    const cobble = type === TerrainTileType.STONE_COBBLE;
    const granite = type === TerrainTileType.GRANITE_SETTS;
    const sidewalk = type === TerrainTileType.SIDEWALK_PAVERS;
    const columns = cobble ? 5 : sidewalk ? 2 : 4;
    const rows = cobble ? 6 : 4;
    const width = size / columns, height = size / rows;
    const cut = unit * (cobble || granite ? 4.3 : 1.8);
    const variation = unit * (cobble ? 2.2 : granite ? 1.4 : 0.4);
    for (let row = 0; row < rows; row++) {
      const stagger = (cobble || sidewalk) && row % 2 ? width / 2 : 0;
      for (let col = 0; col < columns; col++) {
        const x = (col + 0.5) * width + stagger + (random() - 0.5) * variation;
        const y = (row + 0.5) * height + (random() - 0.5) * variation;
        const w = width - 2 * unit - random() * variation;
        const h = height - 2 * unit - random() * variation;
        draw(chippedBlock(x, y, w, h, cut, random));
      }
    }
  }
}
