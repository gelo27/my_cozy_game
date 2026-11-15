import * as THREE from 'three';
import { BuildingPieceType, BuiltPiece, SnapSocket, WallGridInfo, shapeOf } from './types/BuildingTypes';
import { HALF_SIZE } from './config/BuildingPiecesConfig';

export interface CandidatePlacement {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  jointPosition: THREE.Vector3;
  targetPieceId: string;
  targetSocket: SnapSocket | null;
  sourceSocket: SnapSocket | null;
  score: number;
  wallGridInfo?: WallGridInfo | null;
}

export function getFloorHalfSize(type: BuildingPieceType): number {
  if (type === BuildingPieceType.WOOD_FLOOR_1X1) {
    return 0.5;
  }
  return HALF_SIZE; // 1.0m for 2x2
}

export function getStairsHalfHeight(type: BuildingPieceType): number {
  if (type === BuildingPieceType.WOOD_STAIRS_2X1) {
    return 0.5;
  }
  return HALF_SIZE; // 1.0m for 2x2
}

export function getRailingHalfWidth(type: BuildingPieceType): number {
  if (type === BuildingPieceType.WOOD_RAILING_1M || type === BuildingPieceType.WHITE_DECORATIVE_FENCE_1M) {
    return 0.5;
  }
  return HALF_SIZE; // 1.0m for 2m railing
}

/**
 * Footprint of a placed roof in its local space: its resized config when it has one (the arrows can
 * grow one side only, so the centre moves off the piece origin), else the type's default size.
 */
export function getPlacedRoofExtent(piece: BuiltPiece): { cx: number; cz: number; width: number; length: number; height: number } {
  const c = piece.roofConfig;
  if (!c) return { cx: 0, cz: 0, ...getRoofDimensions(piece.type) };
  return { cx: (c.minX + c.maxX) / 2, cz: (c.minZ + c.maxZ) / 2, width: c.maxX - c.minX, length: c.maxZ - c.minZ, height: c.height };
}

export function getRoofDimensions(type: BuildingPieceType): { width: number; length: number; height: number } {
  switch (shapeOf(type)) {
    case BuildingPieceType.ROOF_GABLE_2X2:
    case BuildingPieceType.ROOF_HIP_2X2:
    case BuildingPieceType.ROOF_SHED_2X2:
      return { width: 2.0, length: 2.0, height: 0.85 };
    case BuildingPieceType.ROOF_GABLE_2X4:
    case BuildingPieceType.ROOF_HIP_2X4:
    case BuildingPieceType.ROOF_SHED_2X4:
      return { width: 2.0, length: 4.0, height: 0.85 };
    case BuildingPieceType.ROOF_GABLE_4X4:
    case BuildingPieceType.ROOF_HIP_4X4:
    case BuildingPieceType.ROOF_SHED_4X4:
      return { width: 4.0, length: 4.0, height: 1.6 };
    case BuildingPieceType.WOOD_ROOF_26:
    default:
      return { width: 2.0, length: 2.0, height: 0.9 };
  }
}
