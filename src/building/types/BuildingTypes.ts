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

import { ProceduralRoofConfig } from '../ProceduralRoofSystem';

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
  isOpen?: boolean;
  lastSwingMultiplier?: number;
}

export function isDoorPiece(type: BuildingPieceType): boolean {
  return (
    type === BuildingPieceType.WOOD_DOOR_SINGLE ||
    type === BuildingPieceType.WOOD_DOOR_DOUBLE ||
    type === BuildingPieceType.DOOR_GRAND_SIDELITES_2X2 ||
    type === BuildingPieceType.DOOR_WHITE_2PANEL_1X2 ||
    type === BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2 ||
    type === BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2
  );
}

export function isDoorwayPiece(type: BuildingPieceType): boolean {
  return type === BuildingPieceType.WOOD_WALL_DOORWAY_2X2 || type === BuildingPieceType.WOOD_WALL_DOORWAY_1X2;
}

export function isWindowPiece(type: BuildingPieceType): boolean {
  return (
    type === BuildingPieceType.WOOD_WALL_WINDOW_1X2 ||
    type === BuildingPieceType.WOOD_WALL_WINDOW_1X1_5 ||
    type === BuildingPieceType.WOOD_WALL_WINDOW_2X2 ||
    type === BuildingPieceType.WOOD_WALL_WINDOW_2X4
  );
}

export function isWindowOrDoorPiece(type: BuildingPieceType): boolean {
  return isWindowPiece(type) || isDoorPiece(type) || isDoorwayPiece(type);
}

export function isSolidWallPiece(type: BuildingPieceType): boolean {
  return (
    type === BuildingPieceType.WOOD_WALL_2X3 ||
    type === BuildingPieceType.WOOD_WALL_1X3 ||
    type === BuildingPieceType.WOOD_WALL_1X2 ||
    type === BuildingPieceType.WOOD_WALL_2X1 ||
    type === BuildingPieceType.WOOD_WALL_1X1
  );
}

export function getWallHalfWidth(type: BuildingPieceType): number {
  if (
    type === BuildingPieceType.WOOD_WALL_1X3 ||
    type === BuildingPieceType.WOOD_WALL_1X2 ||
    type === BuildingPieceType.WOOD_WALL_1X1 ||
    type === BuildingPieceType.WOOD_WALL_WINDOW_1X2 ||
    type === BuildingPieceType.WOOD_WALL_WINDOW_1X1_5 ||
    type === BuildingPieceType.WOOD_WALL_DOORWAY_1X2 ||
    type === BuildingPieceType.WOOD_DOOR_SINGLE ||
    type === BuildingPieceType.DOOR_WHITE_2PANEL_1X2 ||
    type === BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2 ||
    type === BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2
  ) {
    return 0.5;
  }
  return 1.0; // 1.0m (HALF_SIZE)
}

export function getWallHalfHeight(type: BuildingPieceType): number {
  if (type === BuildingPieceType.WOOD_WALL_WINDOW_2X4) {
    return 2.0;
  }
  if (type === BuildingPieceType.WOOD_WALL_2X3 || type === BuildingPieceType.WOOD_WALL_1X3) {
    return 1.5;
  }
  if (type === BuildingPieceType.WOOD_WALL_WINDOW_1X1_5) {
    return 0.75;
  }
  if (type === BuildingPieceType.WOOD_WALL_2X1 || type === BuildingPieceType.WOOD_WALL_1X1) {
    return 0.5;
  }
  return 1.0; // 1.0m (HALF_SIZE)
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

export interface BuildingTelemetry {
  isBuildModeActive: boolean;
  selectedPieceType: BuildingPieceType | null;
  selectedPieceName: string;
  isSnapped: boolean;
  snappingEnabled: boolean;
  isValidPlacement: boolean;
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
  gridCellSize?: number;
  currentRoofStyle?: 'terracotta' | 'blue_slate' | 'wood_shingles';
}

export interface SavedPieceData {
  id: string;
  type: BuildingPieceType;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  rotation?: [number, number, number];
  health?: number;
  isOpen?: boolean;
  roofConfig?: ProceduralRoofConfig;
}

export interface BuildingSceneExportData {
  version: 1;
  generator: string;
  exportedAt: string;
  metadata: {
    totalPieces: number;
    customizedCells: number;
    roofStyle?: 'terracotta' | 'blue_slate' | 'wood_shingles';
    confirmed: boolean;
  };
  pieces: SavedPieceData[];
  wallPainting?: Record<string, string>;
}

