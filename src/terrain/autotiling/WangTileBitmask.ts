import { TileDefinition, TerrainTileType } from '../types/TerrainTypes';

export const BITMASK_N  = 1;
export const BITMASK_E  = 2;
export const BITMASK_S  = 4;
export const BITMASK_W  = 8;
export const BITMASK_NE = 16;
export const BITMASK_SE = 32;
export const BITMASK_SW = 64;
export const BITMASK_NW = 128;

/**
 * Coordinate-based deterministic hash for natural procedural variations
 */
function hash2D(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Calculates the 8-neighbor Wang Auto-Tiling Bitmask for a cell.
 * Diagonal corners are only marked active if both adjacent cardinal neighbors match.
 */
export function calculate8NeighborBitmask(
  getTileAt: (gx: number, gz: number) => TerrainTileType,
  gx: number,
  gz: number,
  targetType: TerrainTileType
): number {
  if (targetType === TerrainTileType.GRASS) return 0;

  const n  = getTileAt(gx, gz - 1) === targetType;
  const e  = getTileAt(gx + 1, gz) === targetType;
  const s  = getTileAt(gx, gz + 1) === targetType;
  const w  = getTileAt(gx - 1, gz) === targetType;

  const ne = (n && e) ? (getTileAt(gx + 1, gz - 1) === targetType) : false;
  const se = (s && e) ? (getTileAt(gx + 1, gz + 1) === targetType) : false;
  const sw = (s && w) ? (getTileAt(gx - 1, gz + 1) === targetType) : false;
  const nw = (n && w) ? (getTileAt(gx - 1, gz - 1) === targetType) : false;

  let bitmask = 0;
  if (n)  bitmask |= BITMASK_N;
  if (e)  bitmask |= BITMASK_E;
  if (s)  bitmask |= BITMASK_S;
  if (w)  bitmask |= BITMASK_W;
  if (ne) bitmask |= BITMASK_NE;
  if (se) bitmask |= BITMASK_SE;
  if (sw) bitmask |= BITMASK_SW;
  if (nw) bitmask |= BITMASK_NW;

  return bitmask;
}

/**
 * Draws a natural, lush grass base onto a cell with coordinate-seeded organic variations
 */
export function drawGrassBase(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  gx: number = 0,
  gz: number = 0
): void {
  // Deterministic seed for this cell
  const seed = hash2D(gx, gz);
  const colorVariant = seed % 4;

  // Rich base grass palettes
  const grassShades = ['#38732a', '#346c26', '#3b782c', '#336a25'];
  ctx.fillStyle = grassShades[colorVariant];
  ctx.fillRect(px, py, size, size);

  // Organic fine blade tufts (subtle natural variation)
  const numTufts = 3 + (seed % 3);
  for (let i = 0; i < numTufts; i++) {
    const tuftSeed = hash2D(gx * 11 + i, gz * 17 + i);
    const ox = px + (tuftSeed % (size - 8)) + 4;
    const oy = py + ((tuftSeed >> 4) % (size - 8)) + 4;
    const bladeColor = (tuftSeed & 1) ? '#448532' : '#2d5e21';

    ctx.fillStyle = bladeColor;
    ctx.fillRect(ox, oy, 2, 3);
    ctx.fillRect(ox + 1, oy - 1, 1, 3);
  }
}

/**
 * Renders an auto-tiled tile onto a 2D Canvas context.
 * Uses a mathematically seamless 4-corner boundary algorithm:
 * - When adjacent to the same tile type, the border is 0 margin (100% solid, zero seams).
 * - When adjacent to grass, an organic border margin transitions smoothly into grass.
 * - Smooth cubic bezier curves for outer corners and inner concave diagonal corners.
 */
export function drawAutoTiledTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  bitmask: number,
  tileDef: TileDefinition,
  gx: number = 0,
  gz: number = 0
): void {
  // 1. Draw natural Grass base background
  drawGrassBase(ctx, px, py, size, gx, gz);

  // If this tile is pure grass, base drawing is complete
  if (tileDef.id === TerrainTileType.GRASS) {
    return;
  }

  const hasN = (bitmask & BITMASK_N) !== 0;
  const hasE = (bitmask & BITMASK_E) !== 0;
  const hasS = (bitmask & BITMASK_S) !== 0;
  const hasW = (bitmask & BITMASK_W) !== 0;
  const hasNE = (bitmask & BITMASK_NE) !== 0;
  const hasSE = (bitmask & BITMASK_SE) !== 0;
  const hasSW = (bitmask & BITMASK_SW) !== 0;
  const hasNW = (bitmask & BITMASK_NW) !== 0;

  // Margin for grass transition borders (only where neighbor is grass)
  // When neighbor is matching tile, margin is 0 (solid connection)
  const B = Math.round(size * 0.16); // ~10px for 64px cell
  const half = size / 2;
  const cx = px + half;
  const cy = py + half;

  const leftEdge   = hasW ? px : px + B;
  const rightEdge  = hasE ? px + size : px + size - B;
  const topEdge    = hasN ? py : py + B;
  const bottomEdge = hasS ? py + size : py + size - B;

  ctx.save();

  // 2. Build Seamless Closed Vector Path for Tile Surface
  ctx.beginPath();
  ctx.moveTo(cx, topEdge);

  // --- TOP-RIGHT (NE) CORNER ---
  if (!hasN && !hasE) {
    // Outer convex curve
    ctx.bezierCurveTo(px + size - B * 1.5, py + B, px + size - B, py + B * 1.5, rightEdge, cy);
  } else if (hasN && !hasE) {
    // Straight vertical right edge
    ctx.lineTo(rightEdge, topEdge);
    ctx.lineTo(rightEdge, cy);
  } else if (!hasN && hasE) {
    // Straight horizontal top edge continuing East
    ctx.lineTo(rightEdge, topEdge);
    ctx.lineTo(rightEdge, cy);
  } else {
    // hasN && hasE
    if (hasNE) {
      // Solid corner
      ctx.lineTo(px + size, py);
      ctx.lineTo(px + size, cy);
    } else {
      // Inner concave diagonal corner
      ctx.lineTo(px + size - B, py);
      ctx.bezierCurveTo(px + size - B * 0.8, py + B * 0.4, px + size - B * 0.4, py + B * 0.8, px + size, py + B);
      ctx.lineTo(px + size, cy);
    }
  }

  // --- BOTTOM-RIGHT (SE) CORNER ---
  if (!hasS && !hasE) {
    // Outer convex curve
    ctx.bezierCurveTo(px + size - B, py + size - B * 1.5, px + size - B * 1.5, py + size - B, cx, bottomEdge);
  } else if (hasS && !hasE) {
    // Straight vertical right edge continuing South
    ctx.lineTo(rightEdge, bottomEdge);
    ctx.lineTo(cx, bottomEdge);
  } else if (!hasS && hasE) {
    // Straight horizontal bottom edge
    ctx.lineTo(rightEdge, bottomEdge);
    ctx.lineTo(cx, bottomEdge);
  } else {
    // hasS && hasE
    if (hasSE) {
      // Solid corner
      ctx.lineTo(px + size, py + size);
      ctx.lineTo(cx, py + size);
    } else {
      // Inner concave diagonal corner
      ctx.lineTo(px + size, py + size - B);
      ctx.bezierCurveTo(px + size - B * 0.4, py + size - B * 0.8, px + size - B * 0.8, py + size - B * 0.4, px + size - B, py + size);
      ctx.lineTo(cx, py + size);
    }
  }

  // --- BOTTOM-LEFT (SW) CORNER ---
  if (!hasS && !hasW) {
    // Outer convex curve
    ctx.bezierCurveTo(px + B * 1.5, py + size - B, px + B, py + size - B * 1.5, leftEdge, cy);
  } else if (hasS && !hasW) {
    // Straight vertical left edge
    ctx.lineTo(leftEdge, bottomEdge);
    ctx.lineTo(leftEdge, cy);
  } else if (!hasS && hasW) {
    // Straight horizontal bottom edge continuing West
    ctx.lineTo(leftEdge, bottomEdge);
    ctx.lineTo(leftEdge, cy);
  } else {
    // hasS && hasW
    if (hasSW) {
      // Solid corner
      ctx.lineTo(px, py + size);
      ctx.lineTo(px, cy);
    } else {
      // Inner concave diagonal corner
      ctx.lineTo(px + B, py + size);
      ctx.bezierCurveTo(px + B * 0.8, py + size - B * 0.4, px + B * 0.4, py + size - B * 0.8, px, py + size - B);
      ctx.lineTo(px, cy);
    }
  }

  // --- TOP-LEFT (NW) CORNER ---
  if (!hasN && !hasW) {
    // Outer convex curve
    ctx.bezierCurveTo(px + B, py + B * 1.5, px + B * 1.5, py + B, cx, topEdge);
  } else if (hasN && !hasW) {
    // Straight vertical left edge continuing North
    ctx.lineTo(leftEdge, topEdge);
    ctx.lineTo(cx, topEdge);
  } else if (!hasN && hasW) {
    // Straight horizontal top edge
    ctx.lineTo(leftEdge, topEdge);
    ctx.lineTo(cx, topEdge);
  } else {
    // hasN && hasW
    if (hasNW) {
      // Solid corner
      ctx.lineTo(px, py);
      ctx.lineTo(cx, py);
    } else {
      // Inner concave diagonal corner
      ctx.lineTo(px, py + B);
      ctx.bezierCurveTo(px + B * 0.4, py + B * 0.8, px + B * 0.8, py + B * 0.4, px + B, py);
      ctx.lineTo(cx, py);
    }
  }

  ctx.closePath();

  // 3. Render Depth Rim / Contact Shadow on Grass
  ctx.strokeStyle = 'rgba(20, 45, 15, 0.4)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // 4. Fill Main Material Body
  ctx.fillStyle = tileDef.primaryColor;
  ctx.fill();

  // 5. Material-Specific Procedural Texturing clipped inside the seamless shape
  ctx.clip();

  const seed = hash2D(gx, gz);

  if (tileDef.id === TerrainTileType.DIRT_ROAD) {
    // Rich earthy soil texture with fine grain and pebble specks
    ctx.fillStyle = '#6b4725';
    for (let i = 0; i < 8; i++) {
      const pSeed = hash2D(gx * 7 + i, gz * 13 + i);
      const dotX = px + (pSeed % (size - 4)) + 2;
      const dotY = py + ((pSeed >> 4) % (size - 4)) + 2;
      const dotR = 1 + (pSeed % 2);
      ctx.fillRect(dotX, dotY, dotR, dotR);
    }

    // Light gravel specks
    ctx.fillStyle = '#8f683e';
    for (let i = 0; i < 5; i++) {
      const pSeed = hash2D(gx * 19 + i, gz * 23 + i);
      const dotX = px + (pSeed % (size - 6)) + 3;
      const dotY = py + ((pSeed >> 5) % (size - 6)) + 3;
      ctx.fillRect(dotX, dotY, 1.5, 1.5);
    }

    // Soft organic darker soil rim along outer boundary
    ctx.strokeStyle = '#57381a';
    ctx.lineWidth = 1.5;
    ctx.stroke();

  } else if (tileDef.id === TerrainTileType.ASPHALT_ROAD) {
    // Fine aggregate noise
    ctx.fillStyle = '#1e2126';
    for (let i = 0; i < 10; i++) {
      const pSeed = hash2D(gx * 5 + i, gz * 9 + i);
      const dotX = px + (pSeed % (size - 4)) + 2;
      const dotY = py + ((pSeed >> 4) % (size - 4)) + 2;
      ctx.fillRect(dotX, dotY, 1, 1);
    }

    // Crisp concrete road curbs along grass boundaries
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = Math.max(2, size * 0.05);
    ctx.stroke();

    // Yellow Center Lines
    ctx.strokeStyle = tileDef.accentColor;
    ctx.lineWidth = Math.max(2, size * 0.06);

    const isStraightVert = (hasN || hasS) && !hasE && !hasW;
    const isStraightHoriz = (hasE || hasW) && !hasN && !hasS;

    if (isStraightVert) {
      ctx.setLineDash([size * 0.25, size * 0.15]);
      ctx.beginPath();
      ctx.moveTo(cx, py);
      ctx.lineTo(cx, py + size);
      ctx.stroke();
    } else if (isStraightHoriz) {
      ctx.setLineDash([size * 0.25, size * 0.15]);
      ctx.beginPath();
      ctx.moveTo(px, cy);
      ctx.lineTo(px + size, cy);
      ctx.stroke();
    } else if (hasN || hasE || hasS || hasW) {
      // Intersection or turn center point
      ctx.setLineDash([]);
      ctx.fillStyle = tileDef.accentColor;
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.08, 0, Math.PI * 2);
      ctx.fill();
    }

  } else if (tileDef.id === TerrainTileType.STONE_COBBLE) {
    // Cobblestone Pavers Grid
    ctx.strokeStyle = tileDef.borderColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);

    const steps = 4;
    const stepSize = size / steps;
    for (let i = 1; i < steps; i++) {
      ctx.beginPath();
      ctx.moveTo(px, py + i * stepSize);
      ctx.lineTo(px + size, py + i * stepSize);
      ctx.stroke();

      const offset = (i % 2) * (stepSize / 2);
      for (let j = 0; j <= steps; j++) {
        const vx = px + j * stepSize + offset;
        ctx.beginPath();
        ctx.moveTo(vx, py + (i - 1) * stepSize);
        ctx.lineTo(vx, py + i * stepSize);
        ctx.stroke();
      }
    }

  }

  ctx.restore();
}
