import { DataUtils, MathUtils } from 'three';
import { TerrainTileType } from '../terrain/types/TerrainTypes';
import { WORLD_SIZE, worldSettings } from '../world/WorldSettings';
import type { TerrainSystem } from '../world/TerrainSystem';
import { riverWorld } from '../world/rivers/RiverWorld';

/** Cells of the fog-of-war mask per side (4 m each). */
export const EXPLORE_GRID = 128;

/**
 * Paints the island as a hand-drawn style map straight from the heightmap: one pixel per metre,
 * water by depth, painted ground, shore sand, hill shading and contour lines.
 */
export function renderTerrainMap(terrain: TerrainSystem): HTMLCanvasElement {
  const N = WORLD_SIZE;
  const V = N + 1;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  const h = terrain.heights;
  const sea = worldSettings.waterLevel;
  const riverShading = riverWorld.texture.image.data;
  const at = (x: number, z: number) => h[Math.min(N, Math.max(0, z)) * V + Math.min(N, Math.max(0, x))];

  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const y = at(x, z);
      // Rivers hold their own surface above the sea
      const vertex = z * V + x;
      const rs = riverWorld.surface[vertex];
      const water = rs > sea ? rs : sea;
      const dx = at(x + 1, z) - at(x - 1, z);
      const dz = at(x, z + 1) - at(x, z - 1);
      const slope = Math.hypot(dx, dz) / 2;
      let r: number, g: number, b: number;
      if (y < water) {
        // Shallows turn turquoise, deep water navy
        const d = Math.min(1, (water - y) / 9);
        r = 120 - d * 78;
        g = 190 - d * 100;
        b = 200 - d * 60;
      } else {
        const t = Math.min(1, (y - water) / 16);
        r = 120 - t * 30;
        g = 170 - t * 50;
        b = 88 - t * 20;
        // Rock on cliffs and the highest peaks
        const rock = Math.min(1, Math.max(slope > 0.9 ? (slope - 0.9) * 2 : 0, (y - 14) / 5));
        if (rock > 0) {
          r += (150 - r) * rock;
          g += (144 - g) * rock;
          b += (130 - b) * rock;
        }
        const tile = terrain.tiles[z * N + x];
        if (tile === TerrainTileType.DIRT_ROAD) { r = 168; g = 128; b = 88; }
        else if (tile === TerrainTileType.SAND_BEACH) { r = 232; g = 214; b = 160; }
        else if (tile === TerrainTileType.STONE_COBBLE || tile === TerrainTileType.ASPHALT_ROAD) { r = 130; g = 128; b = 124; }
        else if (tile === TerrainTileType.SNOW) { r = 236; g = 242; b = 248; }
        else if (tile === TerrainTileType.FALLEN_LEAVES) { r = 176; g = 104; b = 48; }
        else if (tile === TerrainTileType.DRY_GRASS) { r = 182; g = 162; b = 92; }
        else if (tile === TerrainTileType.BIRCH_GRASS) { r = 132; g = 186; b = 80; }
        else if (tile === TerrainTileType.FLOWER_GRASS) { r += (240 - r) * 0.15; g += (240 - g) * 0.15; b += (230 - b) * 0.15; } // the meadow, a touch paler
        else if (tile === TerrainTileType.GRAVEL) { r = 150; g = 145; b = 136; }
        else if (tile === TerrainTileType.SIDEWALK_PAVERS || tile === TerrainTileType.LIMESTONE_PAVERS) { r = 182; g = 173; b = 151; }
        else if (tile === TerrainTileType.CLINKER_HERRINGBONE) { r = 158; g = 102; b = 77; }
        else if (tile === TerrainTileType.GRANITE_SETTS) { r = 127; g = 121; b = 115; }
        else if (tile === TerrainTileType.SANDSTONE_FLAGSTONE) { r = 187; g = 151; b = 111; }
        else if (tile === TerrainTileType.ICE) { r = 176; g = 212; b = 232; }
        else if (tile === TerrainTileType.MUD) { r = 96; g = 72; b = 52; }
        else if (tile === TerrainTileType.PUDDLE) { r = 92; g = 110; b = 128; }

        // Use the terrain shader's shore falloff and its bank/estuary mask.
        const shoreIndex = vertex * 4;
        const bankWeight = DataUtils.fromHalfFloat(riverShading[shoreIndex + 1]);
        const shoreWater = bankWeight > 0.5
          ? Math.max(sea, DataUtils.fromHalfFloat(riverShading[shoreIndex]))
          : sea;
        const shoreHeight = y - shoreWater;
        if (shoreHeight < 0.55) {
          const riverBank = MathUtils.smoothstep(bankWeight, 0.35, 0.75)
            * MathUtils.smoothstep(shoreWater - sea, 0.12, 0.45)
            * (1 - DataUtils.fromHalfFloat(riverShading[shoreIndex + 2]));
          const coastalSand = 1 - MathUtils.smoothstep(shoreHeight, 0.15, 0.55);
          const riverShore = (1 - MathUtils.smoothstep(shoreHeight, 0.08, 0.32))
            * MathUtils.smoothstep(bankWeight, 0.8, 0.97);
          const sand = MathUtils.lerp(coastalSand, riverShore, riverBank);
          r = MathUtils.lerp(r, 232, sand);
          g = MathUtils.lerp(g, 214, sand);
          b = MathUtils.lerp(b, 160, sand);
        }
      }
      // Hill shading with light from the north-west
      if (y >= water) {
        const shade = 1 + (-dx - dz) * 0.22;
        const s = Math.max(0.65, Math.min(1.25, shade));
        r *= s; g *= s; b *= s;
        // Contour every 4 m
        const c0 = Math.floor((y - water) / 4);
        const c1 = Math.floor((at(x + 1, z) - water) / 4);
        const c2 = Math.floor((at(x, z + 1) - water) / 4);
        if (c0 !== c1 || c0 !== c2) { r *= 0.82; g *= 0.82; b *= 0.82; }
      } else if (Math.floor(y) !== Math.floor(at(x + 1, z)) && y > water - 2) {
        // A light shoreline ripple
        r += 25; g += 25; b += 20;
      }
      const i = (z * N + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
