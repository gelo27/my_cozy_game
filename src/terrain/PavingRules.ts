import { TerrainTileType } from './types/TerrainTypes';

export const PAVING_TYPES = [
  TerrainTileType.STONE_COBBLE,
  TerrainTileType.SIDEWALK_PAVERS,
  TerrainTileType.CLINKER_HERRINGBONE,
  TerrainTileType.GRANITE_SETTS,
  TerrainTileType.SANDSTONE_FLAGSTONE,
  TerrainTileType.LIMESTONE_PAVERS,
] as const;

export type PavingTile = (typeof PAVING_TYPES)[number];
const PAVING_TILES = new Set<TerrainTileType>(PAVING_TYPES);

export const PAVING_FLAG = 128;

/** RG8 texel: tile ID with the paving flag in R, curb edges and inside corners in G. */
export function writeTerrainTileRules(
  data: Uint8Array, tiles: Uint8Array, size: number, x0: number, z0: number, x1: number, z1: number,
): void {
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const index = z * size + x;
      const type = tiles[index];
      const paving = PAVING_TILES.has(type);
      data[index * 2] = type | (paving ? PAVING_FLAG : 0);
      data[index * 2 + 1] = paving ? pavingMask(tiles, size, x, z, index, type) : 0;
    }
  }
}

function pavingMask(tiles: Uint8Array, size: number, x: number, z: number, index: number, type: TerrainTileType): number {
  const north = z > 0 ? tiles[index - size] : -1;
  const east = x + 1 < size ? tiles[index + 1] : -1;
  const south = z + 1 < size ? tiles[index + size] : -1;
  const west = x > 0 ? tiles[index - 1] : -1;
  // A lower tile ID owns the shared border between two different paving finishes.
  const owns = (neighbor: number) => neighbor !== type && (!PAVING_TILES.has(neighbor) || type < neighbor);
  let mask = 0;
  if (owns(north)) mask |= 1;
  if (owns(east)) mask |= 2;
  if (owns(south)) mask |= 4;
  if (owns(west)) mask |= 8;
  // Two matching sides guarantee the diagonal index is in bounds.
  if (north === type && west === type && owns(tiles[index - size - 1])) mask |= 16;
  if (north === type && east === type && owns(tiles[index - size + 1])) mask |= 32;
  if (south === type && east === type && owns(tiles[index + size + 1])) mask |= 64;
  if (south === type && west === type && owns(tiles[index + size - 1])) mask |= 128;
  return mask;
}

