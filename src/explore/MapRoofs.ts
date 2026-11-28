import { Vector3 } from 'three';
import { HALF_SIZE } from '../building/config/BuildingConstants';
import type { RoofStyle } from '../building/ProceduralRoofSystem';
import { solveBaseRoofShape } from '../building/RoofGeometry';
import { BuildingPieceType, isGlassRoofPiece, type BuiltPiece } from '../building/types/BuildingTypes';
import type { TerrainSystem } from '../world/TerrainSystem';
import { WORLD_HALF, WORLD_SIZE } from '../world/WorldSettings';

const ROOF_COLORS = {
  barkwood: [145, 91, 66],
  sunrise: [183, 115, 69],
  mission: [175, 87, 61],
  blue_slate: [84, 108, 130],
  scalloped_clay: [165, 99, 80],
  standing_seam: [113, 126, 122],
  thatch: [181, 143, 76],
} satisfies Record<RoofStyle, [number, number, number]>;
const GLASS_COLOR = [116, 168, 173];
const LIGHT = new Vector3(-0.58, 0.65, -0.5).normalize();

const legacySlope = [
  new Vector3(-HALF_SIZE, -0.45, -HALF_SIZE),
  new Vector3(HALF_SIZE, -0.45, -HALF_SIZE),
  new Vector3(HALF_SIZE, 0.45, HALF_SIZE),
  new Vector3(-HALF_SIZE, 0.45, HALF_SIZE),
];

/** Projects authored roof slopes onto the island map at the display canvas resolution. */
export function renderMapRoofs(
  pieces: Iterable<BuiltPiece>,
  terrain: TerrainSystem,
  size: number,
  reuse?: HTMLCanvasElement,
): HTMLCanvasElement {
  const canvas = reuse ?? document.createElement('canvas');
  if (canvas.width !== size || canvas.height !== size) canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  const scale = size / WORLD_SIZE;
  const project = (coordinate: number) => (coordinate + WORLD_HALF) * scale;
  const path = (points: readonly Vector3[]) => {
    ctx.beginPath();
    ctx.moveTo(project(points[0].x), project(points[0].z));
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(project(points[i].x), project(points[i].z));
    }
    ctx.closePath();
  };

  const roofs = [];
  for (const piece of pieces) {
    const shape = piece.roofConfig && solveBaseRoofShape(piece.roofConfig);
    const legacy = piece.type === BuildingPieceType.WOOD_ROOF_26;
    if (!shape && !legacy) continue;
    const toWorld = (p: Vector3) => p.clone().applyQuaternion(piece.quaternion).add(piece.position);
    const top = (shape ? shape.top : [legacySlope]).map(face => face.map(toWorld));
    if (!top.some(face => face.some(p => p.y >= terrain.getHeight(p.x, p.z)))) continue;

    const outline = (shape ? shape.outline : legacySlope).map(toWorld);
    const color = isGlassRoofPiece(piece.type) ? GLASS_COLOR : ROOF_COLORS[piece.roofStyle ?? (legacy ? 'thatch' : 'barkwood')];
    const height = outline.reduce((sum, p) => sum + p.y, 0) / outline.length;
    roofs.push({ top, outline, color, height });
  }
  roofs.sort((a, b) => a.height - b.height);

  const edge = new Vector3();
  const normal = new Vector3();
  const shade = (color: readonly number[], factor: number) =>
    `rgb(${Math.round(color[0] * factor)}, ${Math.round(color[1] * factor)}, ${Math.round(color[2] * factor)})`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1;
  for (const { top, outline, color } of roofs) {
    // Fill beneath the faces so their antialiased shared edges don't leak the terrain color.
    path(outline);
    ctx.fillStyle = shade(color, 0.93);
    ctx.strokeStyle = shade(color, 0.54);
    ctx.fill();
    ctx.stroke();

    for (const face of top) {
      // Sum the oriented triangle normals so concave faces and collinear corners shade correctly.
      normal.set(0, 0, 0);
      for (let i = 0; i < face.length; i++) {
        normal.add(edge.crossVectors(face[i], face[(i + 1) % face.length]));
      }
      normal.normalize();
      if (normal.y < 0) normal.negate();
      path(face);
      ctx.fillStyle = shade(color, 0.62 + 0.66 * Math.max(0, normal.dot(LIGHT)));
      ctx.fill();
    }
  }
  return canvas;
}
