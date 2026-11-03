export enum TerrainTileType {
  GRASS = 0,
  DIRT_ROAD = 1,
  ASPHALT_ROAD = 2,
  STONE_COBBLE = 3,
  SAND_BEACH = 4,
  WATER_CHANNEL = 5,
  WOOD_DECK = 6,
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
  [TerrainTileType.WATER_CHANNEL]: {
    id: TerrainTileType.WATER_CHANNEL,
    name: 'Water Channel',
    ukrainianName: 'Водний канал / Річка',
    category: 'nature',
    primaryColor: '#2b79a0',
    secondaryColor: '#1d5472',
    accentColor: '#4bb2e6',
    borderColor: '#12384d',
    icon: '🌊',
    description: 'Прозорий водний канал з береговою лінією',
  },
  [TerrainTileType.WOOD_DECK]: {
    id: TerrainTileType.WOOD_DECK,
    name: 'Wooden Deck',
    ukrainianName: 'Дерев’яний настил',
    category: 'building',
    primaryColor: '#965d34',
    secondaryColor: '#754421',
    accentColor: '#b87948',
    borderColor: '#542f14',
    icon: '🛖',
    description: 'Дерев’яний паркетний настил для тераси',
  },
};
