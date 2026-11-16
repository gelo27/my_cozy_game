export enum TerrainTileType {
  GRASS = 0,
  DIRT_ROAD = 1,
  ASPHALT_ROAD = 2,
  STONE_COBBLE = 3,
  SAND_BEACH = 4,
  // 5 (water channel) and 6 (wooden deck) were removed; old saves remap them via LEGACY_TILE_REMAP
  SNOW = 7,
  FALLEN_LEAVES = 8,
  DRY_GRASS = 9,
  BIRCH_GRASS = 10,
  GRAVEL = 11,
  ICE = 12,
  MUD = 13,
  PUDDLE = 14,
}

/** Tiles that grow 3D grass blades (each in its own tint: GrassField). */
export const GRASSY_TILES: ReadonlySet<TerrainTileType> = new Set([
  TerrainTileType.GRASS,
  TerrainTileType.DRY_GRASS,
  TerrainTileType.BIRCH_GRASS,
]);

/** Tile ids that no longer exist, mapped to what old saves should show instead. */
export const LEGACY_TILE_REMAP: Readonly<Record<number, TerrainTileType>> = {
  5: TerrainTileType.SAND_BEACH,
  6: TerrainTileType.DIRT_ROAD,
};

/** Any stored tile byte -> a valid tile type (unknown ids fall back to grass). */
export function sanitizeTile(v: number): TerrainTileType {
  if (v in TILE_DEFINITIONS) return v as TerrainTileType;
  return LEGACY_TILE_REMAP[v] ?? TerrainTileType.GRASS;
}

export type TerrainToolMode = 'brush' | 'line' | 'rectangle' | 'eraser' | 'fill';

export type TerrainBrushSize = 1 | 2 | 3 | 5;

export interface TileDefinition {
  id: TerrainTileType;
  name: string;
  ukrainianName: string;
  category: 'road' | 'path' | 'nature' | 'building';
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  borderColor: string;
  icon: string;
  description: string;
}

export interface GridCoord {
  gx: number;
  gz: number;
}

export interface TerrainChunkKey {
  cx: number;
  cz: number;
}

export const CHUNK_GRID_SIZE = 16; // 16x16 tiles per chunk
export const TILE_WORLD_SIZE = 1.0; // 1.0 meter per grid tile
export const CHUNK_WORLD_SIZE = CHUNK_GRID_SIZE * TILE_WORLD_SIZE; // 16 meters per chunk

export const TILE_DEFINITIONS: Record<TerrainTileType, TileDefinition> = {
  [TerrainTileType.GRASS]: {
    id: TerrainTileType.GRASS,
    name: 'Grass Surface',
    ukrainianName: 'Трава / Газон',
    category: 'nature',
    primaryColor: '#3d7833',
    secondaryColor: '#2d5c25',
    accentColor: '#529e44',
    borderColor: '#24481d',
    icon: '🌿',
    description: 'Основний природний газон',
  },
  [TerrainTileType.DIRT_ROAD]: {
    id: TerrainTileType.DIRT_ROAD,
    name: 'Dirt Path',
    ukrainianName: 'Ґрунтова стежка',
    category: 'path',
    primaryColor: '#8a6543',
    secondaryColor: '#6e4e32',
    accentColor: '#a88059',
    borderColor: '#523a23',
    icon: '🌲',
    description: 'Ґрунтова дорога з автоматичними м’якими краями',
  },
  [TerrainTileType.ASPHALT_ROAD]: {
    id: TerrainTileType.ASPHALT_ROAD,
    name: 'Asphalt Highway',
    ukrainianName: 'Асфальтова дорога',
    category: 'road',
    primaryColor: '#33383e',
    secondaryColor: '#23262a',
    accentColor: '#f5bd02', // Yellow road line mark
    borderColor: '#181a1c',
    icon: '🛣️',
    description: 'Міська асфальтова траса з розміткою та бордюрами',
  },
  [TerrainTileType.STONE_COBBLE]: {
    id: TerrainTileType.STONE_COBBLE,
    name: 'Stone Cobblestone',
    ukrainianName: 'Кам’яна бруківка',
    category: 'road',
    primaryColor: '#6c737e',
    secondaryColor: '#505660',
    accentColor: '#8c94a2',
    borderColor: '#3c414a',
    icon: '🧱',
    description: 'Класична мощена бруківка з масковим розгалуженням',
  },
  [TerrainTileType.SAND_BEACH]: {
    id: TerrainTileType.SAND_BEACH,
    name: 'Sand Beach',
    ukrainianName: 'Пісок / Пляж',
    category: 'nature',
    primaryColor: '#d9b875',
    secondaryColor: '#be9e5a',
    accentColor: '#ecd396',
    borderColor: '#987d40',
    icon: '🏖️',
    description: 'М’який золотистий піщаний покрив',
  },
  [TerrainTileType.SNOW]: {
    id: TerrainTileType.SNOW,
    name: 'Snow Cover',
    ukrainianName: 'Сніговий покрив',
    category: 'nature',
    primaryColor: '#eef3f8',
    secondaryColor: '#d6e2ef',
    accentColor: '#ffffff',
    borderColor: '#b7c8dc',
    icon: '❄️',
    description: 'Пухкий сніг з блискітками та блакитними тінями',
  },
  [TerrainTileType.FALLEN_LEAVES]: {
    id: TerrainTileType.FALLEN_LEAVES,
    name: 'Fallen Leaves',
    ukrainianName: 'Опале листя',
    category: 'nature',
    primaryColor: '#8a5a2b',
    secondaryColor: '#b8702a',
    accentColor: '#d29a36',
    borderColor: '#5e3c1c',
    icon: '🍂',
    description: 'Осінній килим з рудого, жовтого й бурого листя',
  },
  [TerrainTileType.DRY_GRASS]: {
    id: TerrainTileType.DRY_GRASS,
    name: 'Dry Grass',
    ukrainianName: 'Суха трава',
    category: 'nature',
    primaryColor: '#a8924e',
    secondaryColor: '#8c773c',
    accentColor: '#c8b268',
    borderColor: '#6a5a2c',
    icon: '🌾',
    description: 'Вигоріла жовта трава',
  },
  [TerrainTileType.BIRCH_GRASS]: {
    id: TerrainTileType.BIRCH_GRASS,
    name: 'Birch Grove Grass',
    ukrainianName: 'Світла трава (березовий гай)',
    category: 'nature',
    primaryColor: '#6fa83c',
    secondaryColor: '#5c9630',
    accentColor: '#8cc452',
    borderColor: '#4a7a26',
    icon: '🌱',
    description: 'Світла салатова трава березового гаю',
  },
  [TerrainTileType.GRAVEL]: {
    id: TerrainTileType.GRAVEL,
    name: 'Gravel',
    ukrainianName: 'Гравій',
    category: 'path',
    primaryColor: '#8b867d',
    secondaryColor: '#6f6a62',
    accentColor: '#a8a399',
    borderColor: '#55514a',
    icon: '🪨',
    description: 'Дрібний сірий гравій',
  },
  [TerrainTileType.ICE]: {
    id: TerrainTileType.ICE,
    name: 'Ice',
    ukrainianName: 'Лід',
    category: 'nature',
    primaryColor: '#a9cde0',
    secondaryColor: '#8fb8d0',
    accentColor: '#dcedf6',
    borderColor: '#6f9ab4',
    icon: '🧊',
    description: 'Гладкий слизький лід: по ньому ковзають',
  },
  [TerrainTileType.MUD]: {
    id: TerrainTileType.MUD,
    name: 'Mud',
    ukrainianName: 'Багнюка',
    category: 'nature',
    primaryColor: '#4a3524',
    secondaryColor: '#3a291b',
    accentColor: '#5e4530',
    borderColor: '#2a1d13',
    icon: '🟤',
    description: 'Мокра багнюка: сповільнює, лишає сліди, у дощ блищить',
  },
  [TerrainTileType.PUDDLE]: {
    id: TerrainTileType.PUDDLE,
    name: 'Puddle',
    ukrainianName: 'Калюжа',
    category: 'nature',
    primaryColor: '#3e3226',
    secondaryColor: '#33281e',
    accentColor: '#4d3e2f',
    borderColor: '#251c14',
    icon: '💧',
    description: 'Калюжа: наповнюється в дощ, по ній біжать брижі, потім висихає',
  },
};
