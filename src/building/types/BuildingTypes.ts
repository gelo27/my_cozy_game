import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

export enum BuildingPieceType {
  WOOD_FLOOR_2X2 = 'WOOD_FLOOR_2X2',
  WOOD_FLOOR_1X1 = 'WOOD_FLOOR_1X1',
  WOOD_WALL_2X3 = 'WOOD_WALL_2X3',
  WOOD_WALL_1X3 = 'WOOD_WALL_1X3',
  WOOD_WALL_1X2 = 'WOOD_WALL_1X2',
  WOOD_WALL_2X1 = 'WOOD_WALL_2X1',
  WOOD_WALL_1X1 = 'WOOD_WALL_1X1',
  WOOD_WALL_WINDOW_1X2 = 'WOOD_WALL_WINDOW_1X2',
  WOOD_WALL_WINDOW_1X1_5 = 'WOOD_WALL_WINDOW_1X1_5',
  WOOD_WALL_WINDOW_2X2 = 'WOOD_WALL_WINDOW_2X2',
  WOOD_WALL_WINDOW_2X4 = 'WOOD_WALL_WINDOW_2X4',
  WOOD_WALL_DOORWAY_2X2 = 'WOOD_WALL_DOORWAY_2X2',
  WOOD_WALL_DOORWAY_1X2 = 'WOOD_WALL_DOORWAY_1X2',
  WOOD_DOOR_SINGLE = 'WOOD_DOOR_SINGLE',
  WOOD_DOOR_DOUBLE = 'WOOD_DOOR_DOUBLE',
  DOOR_GRAND_SIDELITES_2X2 = 'DOOR_GRAND_SIDELITES_2X2',
  DOOR_WHITE_2PANEL_1X2 = 'DOOR_WHITE_2PANEL_1X2',
  DOOR_COTTAGE_WINDOW_1X2 = 'DOOR_COTTAGE_WINDOW_1X2',
  DOOR_COLONIAL_6PANEL_1X2 = 'DOOR_COLONIAL_6PANEL_1X2',
  WOOD_STAIRS_2X2 = 'WOOD_STAIRS_2X2',
  WOOD_STAIRS_2X1 = 'WOOD_STAIRS_2X1',
  WOOD_STAIRS_2X3 = 'WOOD_STAIRS_2X3',
  WOOD_ROOF_26 = 'WOOD_ROOF_26',
  ROOF_GABLE_2X2 = 'ROOF_GABLE_2X2',
  ROOF_GABLE_2X4 = 'ROOF_GABLE_2X4',
  ROOF_GABLE_4X4 = 'ROOF_GABLE_4X4',
  ROOF_HIP_2X2 = 'ROOF_HIP_2X2',
  ROOF_HIP_2X4 = 'ROOF_HIP_2X4',
  ROOF_HIP_4X4 = 'ROOF_HIP_4X4',
  ROOF_SHED_2X2 = 'ROOF_SHED_2X2',
  ROOF_SHED_2X4 = 'ROOF_SHED_2X4',
  ROOF_SHED_4X4 = 'ROOF_SHED_4X4',
  ROOF_GAMBREL_2X2 = 'ROOF_GAMBREL_2X2',
  ROOF_MANSARD_2X2 = 'ROOF_MANSARD_2X2',
  WOOD_POLE_2M = 'WOOD_POLE_2M',
  CHECKER_PILLAR_1M = 'CHECKER_PILLAR_1M',
  CORNER_RUSTICATED_QUOIN_1M = 'CORNER_RUSTICATED_QUOIN_1M',
  STONE_FOUNDATION_2X2 = 'STONE_FOUNDATION_2X2',
  WOOD_RAILING_2M = 'WOOD_RAILING_2M',
  WOOD_RAILING_1M = 'WOOD_RAILING_1M',
  WOOD_STAIR_RAILING_2X2 = 'WOOD_STAIR_RAILING_2X2',
  WHITE_DECORATIVE_FENCE_1M = 'WHITE_DECORATIVE_FENCE_1M',
  FURN_DINING_TABLE = 'FURN_DINING_TABLE',
  FURN_COFFEE_TABLE = 'FURN_COFFEE_TABLE',
  FURN_WOOD_CHAIR = 'FURN_WOOD_CHAIR',
  FURN_ARMCHAIR = 'FURN_ARMCHAIR',
  FURN_SOFA = 'FURN_SOFA',
  FURN_BED_SINGLE = 'FURN_BED_SINGLE',
  FURN_BED_DOUBLE = 'FURN_BED_DOUBLE',
  FURN_WARDROBE = 'FURN_WARDROBE',
  FURN_DRESSER = 'FURN_DRESSER',
  FURN_NIGHTSTAND = 'FURN_NIGHTSTAND',
  FURN_BOOKSHELF = 'FURN_BOOKSHELF',
  FURN_CHANDELIER = 'FURN_CHANDELIER',
  FURN_TABLE_LAMP = 'FURN_TABLE_LAMP',
  // Greenhouse (glasshouse) pieces: same footprint and snapping as their wooden twins
  GLASS_WALL_2X3 = 'GLASS_WALL_2X3',
  GLASS_WALL_1X3 = 'GLASS_WALL_1X3',
  GLASS_DOORWAY_1X3 = 'GLASS_DOORWAY_1X3',
  GLASS_DOOR_1X3 = 'GLASS_DOOR_1X3',
  GLASS_ROOF_GABLE_2X2 = 'GLASS_ROOF_GABLE_2X2',
  GLASS_ROOF_SHED_2X2 = 'GLASS_ROOF_SHED_2X2',
}

export enum PieceCategory {
  WALLS = 'WALLS',
  WINDOWS = 'WINDOWS',
  DOORS = 'DOORS',
  FLOORS = 'FLOORS',
  STAIRS = 'STAIRS',
  ROOFS = 'ROOFS',
  PILLARS = 'PILLARS',
  RAILINGS = 'RAILINGS',
  WOOD_STRUCTURE = 'WOOD_STRUCTURE',
  ROOFING = 'ROOFING',
  FOUNDATION = 'FOUNDATION',
  FURNITURE = 'FURNITURE',
  GREENHOUSE = 'GREENHOUSE',
}

export enum SocketType {
  FLOOR_EDGE = 'FLOOR_EDGE',
  WALL_TOP = 'WALL_TOP',
  WALL_BOTTOM = 'WALL_BOTTOM',
  WALL_SIDE = 'WALL_SIDE',
  STAIRS_TOP = 'STAIRS_TOP',
  STAIRS_BOTTOM = 'STAIRS_BOTTOM',
  ROOF_EAVE = 'ROOF_EAVE',
  ROOF_RIDGE = 'ROOF_RIDGE',
  PILLAR_TOP = 'PILLAR_TOP',
  PILLAR_BOTTOM = 'PILLAR_BOTTOM',
}

export interface SnapSocket {
  id: string;
  type: SocketType;
  localPosition: THREE.Vector3;
  localNormal: THREE.Vector3;
  localUp: THREE.Vector3;
  compatibleWith: SocketType[];
  /** Optional alignment offset rotation in radians */
  alignmentYaw?: number;
}

export interface BuildingPieceDef {
  type: BuildingPieceType;
  name: string;
  ukrainianName: string;
  category: PieceCategory;
  dimensions: THREE.Vector3;
  sockets: SnapSocket[];
  woodCost: number;
  stoneCost: number;
  maxHealth: number;
  iconName: string;
  description: string;
  isWalkableSlope?: boolean;
}

import type { ProceduralRoofConfig, RoofStyle } from '../ProceduralRoofSystem';
import type { DormerStyle } from '../RoofDormers';

export interface BuiltPiece {
  id: string;
  type: BuildingPieceType;
  position: THREE.Vector3;
  rotation: THREE.Euler;
  quaternion: THREE.Quaternion;
  meshGroup: THREE.Group;
  staticBody: RAPIER.RigidBody;
  staticCollider: RAPIER.Collider;
  health: number;
  maxHealth: number;
  createdAt: number;
  worldBoundingBox?: THREE.Box3;
  isConfirmed?: boolean;
  roofConfig?: ProceduralRoofConfig;
  /** Shingle style of a procedural roof (each roof keeps its own) */
  roofStyle?: RoofStyle;
  isOpen?: boolean;
  lastSwingMultiplier?: number;
}

// ---------------------------------------------------------------------------
// Piece traits: one row per piece type. Adding a new BuildingPieceType fails to compile until it
// gets a row here, and every is*Piece() / size helper below reads this table instead of its own list.
// ---------------------------------------------------------------------------

export type PieceKind =
  | 'floor'
  | 'foundation'
  | 'wall'
  | 'window'
  | 'door'
  | 'doorway'
  | 'stairs'
  | 'roof'
  | 'pillar'
  | 'railing'
  | 'furniture';

export interface PieceTraits {
  kind: PieceKind;
  /** Greenhouse glass piece: stand-alone (not merged into continuous walls, no openings cut) */
  glass?: boolean;
  /** Wooden piece whose size, sockets and snapping this one shares (glass twins) */
  shape?: BuildingPieceType;
  /** Has a leaf the player can swing open */
  swing?: boolean;
  /** Roof drawn by ProceduralRoofGenerator, resizable with arrows */
  proceduralRoof?: boolean;
  /** Furniture that hangs from a ceiling instead of standing on a surface */
  ceilingHung?: boolean;
  /** Width x height in the wall plane, meters (walls and wall openings) */
  wallSize?: [number, number];
}

const T = BuildingPieceType;
export const PIECE_TRAITS: Record<BuildingPieceType, PieceTraits> = {
  [T.WOOD_FLOOR_2X2]: { kind: 'floor' },
  [T.WOOD_FLOOR_1X1]: { kind: 'floor' },
  [T.STONE_FOUNDATION_2X2]: { kind: 'foundation' },

  [T.WOOD_WALL_2X3]: { kind: 'wall', wallSize: [2, 3] },
  [T.WOOD_WALL_1X3]: { kind: 'wall', wallSize: [1, 3] },
  [T.WOOD_WALL_1X2]: { kind: 'wall', wallSize: [1, 2] },
  [T.WOOD_WALL_2X1]: { kind: 'wall', wallSize: [2, 1] },
  [T.WOOD_WALL_1X1]: { kind: 'wall', wallSize: [1, 1] },

  [T.WOOD_WALL_WINDOW_1X2]: { kind: 'window', wallSize: [1, 2] },
  [T.WOOD_WALL_WINDOW_1X1_5]: { kind: 'window', wallSize: [1, 1.5] },
  [T.WOOD_WALL_WINDOW_2X2]: { kind: 'window', wallSize: [2, 2] },
  [T.WOOD_WALL_WINDOW_2X4]: { kind: 'window', wallSize: [2, 4] },

  [T.WOOD_WALL_DOORWAY_2X2]: { kind: 'doorway', wallSize: [2, 2] },
  [T.WOOD_WALL_DOORWAY_1X2]: { kind: 'doorway', wallSize: [1, 2] },

  [T.WOOD_DOOR_SINGLE]: { kind: 'door', swing: true, wallSize: [1, 2] },
  [T.WOOD_DOOR_DOUBLE]: { kind: 'door', swing: true, wallSize: [2, 2] },
  [T.DOOR_GRAND_SIDELITES_2X2]: { kind: 'door', swing: true, wallSize: [2, 2] },
  [T.DOOR_WHITE_2PANEL_1X2]: { kind: 'door', swing: true, wallSize: [1, 2] },
  [T.DOOR_COTTAGE_WINDOW_1X2]: { kind: 'door', swing: true, wallSize: [1, 2] },
  [T.DOOR_COLONIAL_6PANEL_1X2]: { kind: 'door', swing: true, wallSize: [1, 2] },

  [T.WOOD_STAIRS_2X2]: { kind: 'stairs' },
  [T.WOOD_STAIRS_2X1]: { kind: 'stairs' },
  [T.WOOD_STAIRS_2X3]: { kind: 'stairs' },

  [T.WOOD_ROOF_26]: { kind: 'roof' },
  [T.ROOF_GABLE_2X2]: { kind: 'roof', proceduralRoof: true },
  [T.ROOF_GABLE_2X4]: { kind: 'roof', proceduralRoof: true },
  [T.ROOF_GABLE_4X4]: { kind: 'roof', proceduralRoof: true },
  [T.ROOF_HIP_2X2]: { kind: 'roof', proceduralRoof: true },
  [T.ROOF_HIP_2X4]: { kind: 'roof', proceduralRoof: true },
  [T.ROOF_HIP_4X4]: { kind: 'roof', proceduralRoof: true },
  [T.ROOF_SHED_2X2]: { kind: 'roof', proceduralRoof: true },
  [T.ROOF_SHED_2X4]: { kind: 'roof', proceduralRoof: true },
  [T.ROOF_SHED_4X4]: { kind: 'roof', proceduralRoof: true },
  [T.ROOF_GAMBREL_2X2]: { kind: 'roof', proceduralRoof: true },
  [T.ROOF_MANSARD_2X2]: { kind: 'roof', proceduralRoof: true },

  [T.WOOD_POLE_2M]: { kind: 'pillar' },
  [T.CHECKER_PILLAR_1M]: { kind: 'pillar' },
  [T.CORNER_RUSTICATED_QUOIN_1M]: { kind: 'pillar' },

  [T.WOOD_RAILING_2M]: { kind: 'railing' },
  [T.WOOD_RAILING_1M]: { kind: 'railing' },
  [T.WOOD_STAIR_RAILING_2X2]: { kind: 'railing' },
  [T.WHITE_DECORATIVE_FENCE_1M]: { kind: 'railing' },

  [T.FURN_DINING_TABLE]: { kind: 'furniture' },
  [T.FURN_COFFEE_TABLE]: { kind: 'furniture' },
  [T.FURN_WOOD_CHAIR]: { kind: 'furniture' },
  [T.FURN_ARMCHAIR]: { kind: 'furniture' },
  [T.FURN_SOFA]: { kind: 'furniture' },
  [T.FURN_BED_SINGLE]: { kind: 'furniture' },
  [T.FURN_BED_DOUBLE]: { kind: 'furniture' },
  [T.FURN_WARDROBE]: { kind: 'furniture' },
  [T.FURN_DRESSER]: { kind: 'furniture' },
  [T.FURN_NIGHTSTAND]: { kind: 'furniture' },
  [T.FURN_BOOKSHELF]: { kind: 'furniture' },
  [T.FURN_CHANDELIER]: { kind: 'furniture', ceilingHung: true },
  [T.FURN_TABLE_LAMP]: { kind: 'furniture' },

  // Greenhouse: same footprint and snapping as their wooden twins
  [T.GLASS_WALL_2X3]: { kind: 'wall', glass: true, shape: T.WOOD_WALL_2X3 },
  [T.GLASS_WALL_1X3]: { kind: 'wall', glass: true, shape: T.WOOD_WALL_1X3 },
  [T.GLASS_DOORWAY_1X3]: { kind: 'doorway', glass: true, shape: T.WOOD_WALL_1X3 },
  [T.GLASS_DOOR_1X3]: { kind: 'door', glass: true, swing: true, shape: T.WOOD_WALL_1X3 },
  [T.GLASS_ROOF_GABLE_2X2]: { kind: 'roof', glass: true, proceduralRoof: true, shape: T.ROOF_GABLE_2X2 },
  [T.GLASS_ROOF_SHED_2X2]: { kind: 'roof', glass: true, proceduralRoof: true, shape: T.ROOF_SHED_2X2 },
};

export function pieceTraits(type: BuildingPieceType): PieceTraits {
  return PIECE_TRAITS[type];
}

/** Glass greenhouse wall panels: stand-alone walls (not merged into continuous walls, no openings cut). */
export function isGlassWallPiece(type: BuildingPieceType): boolean {
  const t = PIECE_TRAITS[type];
  return !!t?.glass && (t.kind === 'wall' || t.kind === 'doorway' || t.kind === 'door');
}

export function isGlassRoofPiece(type: BuildingPieceType): boolean {
  const t = PIECE_TRAITS[type];
  return !!t?.glass && t.kind === 'roof';
}

export function isGreenhousePiece(type: BuildingPieceType): boolean {
  return !!PIECE_TRAITS[type]?.glass;
}

/**
 * The wooden piece whose shape (size, sockets, snapping, roof config) a glass piece shares.
 * Every non-glass type maps to itself, so size/snap lookups can switch on `shapeOf(type)`.
 */
export function shapeOf(type: BuildingPieceType): BuildingPieceType {
  return PIECE_TRAITS[type]?.shape ?? type;
}

/** Wooden door set into a wall opening (the glass greenhouse door is a wall panel, not one of these). */
export function isDoorPiece(type: BuildingPieceType): boolean {
  const t = PIECE_TRAITS[type];
  return t?.kind === 'door' && !t.glass;
}

/**
 * Any piece with a swinging leaf the player can open: wall-embedded doors plus the stand-alone
 * greenhouse glass door (which is a wall panel itself, so it is not an `isDoorPiece` opening).
 */
export function isSwingDoorPiece(type: BuildingPieceType): boolean {
  return !!PIECE_TRAITS[type]?.swing;
}

export function isDoorwayPiece(type: BuildingPieceType): boolean {
  const t = PIECE_TRAITS[type];
  return t?.kind === 'doorway' && !t.glass;
}

export function isWindowPiece(type: BuildingPieceType): boolean {
  return PIECE_TRAITS[type]?.kind === 'window';
}

/** Openings cut into continuous wooden walls: windows, doors and empty doorways. */
export function isWindowOrDoorPiece(type: BuildingPieceType): boolean {
  return isWindowPiece(type) || isDoorPiece(type) || isDoorwayPiece(type);
}

/** Wooden wall panels merged into continuous walls. */
export function isSolidWallPiece(type: BuildingPieceType): boolean {
  const t = PIECE_TRAITS[type];
  return t?.kind === 'wall' && !t.glass;
}

export function isFloorPiece(type: BuildingPieceType): boolean {
  return PIECE_TRAITS[type]?.kind === 'floor';
}

export function isFoundationPiece(type: BuildingPieceType): boolean {
  return PIECE_TRAITS[type]?.kind === 'foundation';
}

export function isProceduralRoofPiece(type: BuildingPieceType): boolean {
  return !!PIECE_TRAITS[type]?.proceduralRoof;
}

export function isFurniturePiece(type: BuildingPieceType): boolean {
  return PIECE_TRAITS[type]?.kind === 'furniture';
}

/** Furniture that hangs from a ceiling instead of standing on a surface. */
export function isCeilingFurniture(type: BuildingPieceType): boolean {
  return !!PIECE_TRAITS[type]?.ceilingHung;
}

/**
 * Size of a wall or wall opening in the wall plane (meters), 2 x 2 for anything without one.
 * Pass `shapeOf(type)` to read a glass piece's wooden twin.
 */
export function getWallSize(type: BuildingPieceType): [number, number] {
  return PIECE_TRAITS[type]?.wallSize ?? [2, 2];
}

export function getWallHalfWidth(type: BuildingPieceType): number {
  return getWallSize(shapeOf(type))[0] / 2;
}

export function getWallHalfHeight(type: BuildingPieceType): number {
  return getWallSize(shapeOf(type))[1] / 2;
}

export interface WallGridInfo {
  wallPieceId: string;
  wallPosition: THREE.Vector3;
  wallQuaternion: THREE.Quaternion;
  wallWidth: number;
  wallHeight: number;
  faceSide: 'front' | 'back';
  gridStep: number;
  activeFaceNormal: THREE.Vector3;
  gridMinX: number;
  gridMaxX: number;
  gridMinY: number;
  gridMaxY: number;
  previewLocalMinX: number;
  previewLocalMaxX: number;
  previewLocalMinY: number;
  previewLocalMaxY: number;
  snappedLocalX: number;
  snappedLocalY: number;
  previewWidth: number;
  previewHeight: number;
}

export interface SnapResult {
  isSnapped: boolean;
  snappedPosition: THREE.Vector3;
  snappedRotation: THREE.Euler;
  snappedQuaternion: THREE.Quaternion;
  targetPieceId: string | null;
  targetSocket: SnapSocket | null;
  sourceSocket: SnapSocket | null;
  isValidPlacement: boolean;
  validationReason?: string;
  wallGridInfo?: WallGridInfo | null;
}

export interface BuildPreviewState {
  isActive: boolean;
  selectedPieceType: BuildingPieceType;
  currentYaw: number;
  snappingEnabled: boolean;
  snapResult: SnapResult | null;
  aimDistance: number;
  canAfford: boolean;
}

/** Roof kinds that can cover a whole house outline */
export type HouseRoofKind = 'gable' | 'hip' | 'gambrel' | 'mansard';

export interface BuildingTelemetry {
  isBuildModeActive: boolean;
  selectedPieceType: BuildingPieceType | null;
  selectedPieceName: string;
  isSnapped: boolean;
  snappingEnabled: boolean;
  isValidPlacement: boolean;
  /** Localized reason why the piece can't be placed here (null when placement is valid) */
  placementReason?: string | null;
  totalPiecesBuilt: number;
  aimingAtPieceId: string | null;
  unconfirmedWallsCount?: number;
  unconfirmedFloorsCount?: number;
  unconfirmedFoundationsCount?: number;
  unconfirmedRoofsCount?: number;
  selectedWallId?: string | null;
  isPaintingModeActive?: boolean;
  activeWallpaperId?: string;
  activePaintingTool?: string;
  hoveredCellFace?: string | null;
  hoveredCellFaceKind?: 'outer' | 'inner' | 'floor' | 'ceiling' | null;
  hoveredCellCoords?: string | null;
  hoveredCellWallpaperName?: string | null;
  customizedCellsCount?: number;
  canUndoPaint?: boolean;
  canRedoPaint?: boolean;
  fillPreviewCount?: number;
  /** Style of the selected roof, or the one new roofs get */
  currentRoofStyle?: RoofStyle;
  /** A shingle roof is selected, so the style buttons restyle it */
  isRoofSelected?: boolean;
  /** A wall is selected or under the cursor: "roof the whole house" can run */
  canRoofHouse?: boolean;
  /** Whole-house roof tool picked in the dock: the next wall clicked gets this roof over its house */
  houseRoofTool?: HouseRoofKind | null;
  /** The outline fill the selected / aimed wall or floor tile offers */
  fillKind?: 'walls' | 'ceiling' | null;
  /** Dormer panel of the selected shingle roof */
  dormer?: DormerTelemetry | null;
}

export interface DormerTelemetry {
  /** The dormer tool is on: the next click on the roof's slope places one */
  tool: boolean;
  style: DormerStyle;
  width: number;
  height: number;
  /** A placed dormer is picked: style and size buttons change it */
  editing: boolean;
  /** Dormers on the selected roof */
  count: number;
  /** Localized hint (why the hovered spot does not fit, what to do next), or null */
  hint: string | null;
}

/** What the dormer panel asks for */
export type DormerAction =
  | { kind: 'tool' }
  | { kind: 'style'; style: DormerStyle }
  | { kind: 'width'; delta: number }
  | { kind: 'height'; delta: number }
  | { kind: 'delete' }
  | { kind: 'done' };

export interface SavedPieceData {
  id: string;
  type: BuildingPieceType;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  rotation?: [number, number, number];
  health?: number;
  isOpen?: boolean;
  roofConfig?: ProceduralRoofConfig;
  roofStyle?: RoofStyle;
}

export interface BuildingSceneExportData {
  version: 1;
  generator: string;
  exportedAt: string;
  metadata: {
    totalPieces: number;
    customizedCells: number;
    /** Scene-wide roof style of older saves; roofs now carry their own */
    roofStyle?: string;
    confirmed: boolean;
  };
  pieces: SavedPieceData[];
  wallPainting?: Record<string, string>;
}

