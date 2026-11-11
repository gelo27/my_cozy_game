import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BuildingPieceType, BuiltPiece, SnapResult, SnapSocket, SocketType, WallGridInfo, isWindowPiece, isDoorPiece, isDoorwayPiece, isWindowOrDoorPiece, isSolidWallPiece, isGlassWallPiece, isGlassRoofPiece, shapeOf } from './types/BuildingTypes';
import { BUILDING_PIECES, FLOOR_THICKNESS, HALF_SIZE, MODULE_SIZE, WALL_THICKNESS, isPieceBelowSurface, getPieceMeshTemplate } from './config/BuildingPiecesConfig';
import { FURNITURE_GRID_STEP, isCeilingFurniture, isFurniturePiece } from './furniture/FurnitureCatalog';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { COLLISION_GROUPS, BUILDING_CONFIG } from '../config/constants';

interface CandidatePlacement {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  jointPosition: THREE.Vector3;
  targetPieceId: string;
  targetSocket: SnapSocket | null;
  sourceSocket: SnapSocket | null;
  score: number;
  wallGridInfo?: WallGridInfo | null;
}

function getWallHalfWidth(type: BuildingPieceType): number {
  type = shapeOf(type);
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
  return HALF_SIZE; // 1.0m
}

function getWallHalfHeight(type: BuildingPieceType): number {
  type = shapeOf(type);
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
  return HALF_SIZE; // 1.0m
}

function getFloorHalfSize(type: BuildingPieceType): number {
  if (type === BuildingPieceType.WOOD_FLOOR_1X1) {
    return 0.5;
  }
  return HALF_SIZE; // 1.0m for 2x2
}

function getStairsHalfHeight(type: BuildingPieceType): number {
  if (type === BuildingPieceType.WOOD_STAIRS_2X1) {
    return 0.5;
  }
  return HALF_SIZE; // 1.0m for 2x2
}

function getRailingHalfWidth(type: BuildingPieceType): number {
  if (type === BuildingPieceType.WOOD_RAILING_1M || type === BuildingPieceType.WHITE_DECORATIVE_FENCE_1M) {
    return 0.5;
  }
  return HALF_SIZE; // 1.0m for 2m railing
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

export class SnapSystem {
  public static readonly GRID_SNAP_STEP = 1.0; // Standard 1.0m modular grid step for walls & floors
  public static readonly WINDOW_DOOR_GRID_SNAP_STEP = 0.5; // 0.5m grid step for windows, doors, and wall openings
  private static readonly MAX_BUILD_DISTANCE = 25.0;
  private static readonly MAX_PLACEMENT_DISTANCE = 15.0;
  private static readonly SNAP_RADIUS = 2.8;
  private static readonly PLAYER_COLLISION_RADIUS = 0.65;
  private static readonly OCCUPANCY_THRESHOLD = 0.60;

  private tempRayOrigin = new THREE.Vector3();
  private tempRayDir = new THREE.Vector3();

  constructor() {}

  /**
   * Evaluates snapping for a preview piece given camera ray, placed pieces, and manual yaw.
   * Prioritizes hit normal and crosshair aim direction to select intuitive adjacent build slots.
   * Strictly avoids overlapping identical or category-matching pieces at the same position.
   */
  public evaluateSnap(
    rayOrigin: THREE.Vector3,
    rayDirection: THREE.Vector3,
    pieceType: BuildingPieceType,
    manualYaw: number,
    snappingEnabled: boolean,
    existingPieces: BuiltPiece[],
    physics: PhysicsWorld,
    playerPos: THREE.Vector3,
    playerCollider?: RAPIER.Collider
  ): SnapResult {
    const pieceDef = BUILDING_PIECES[pieceType];
    if (!pieceDef) {
      return this.createDefaultResult();
    }

    this.tempRayOrigin.copy(rayOrigin);
    this.tempRayDir.copy(rayDirection).normalize();

    // Raycast filter that hits environment and dynamic props, but excludes trigger zones and character dynamic bodies
    const buildingRaycastFilter = physics.packCollisionGroups(
      COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS,
      0xffff & ~COLLISION_GROUPS.TRIGGERS & ~COLLISION_GROUPS.CHARACTER
    );

    // 1. Cast ray to ground or environment colliders using Rapier (ignoring player collider and triggers)
    const rayHit = physics.castRayAndGetNormal(
      this.tempRayOrigin,
      this.tempRayDir,
      SnapSystem.MAX_BUILD_DISTANCE,
      playerCollider,
      buildingRaycastFilter
    );

    if (!rayHit) {
      const freeEuler = new THREE.Euler(0, manualYaw, 0, 'YXZ');
      const freeQuat = new THREE.Quaternion().setFromEuler(freeEuler);
      const fakePos = this.tempRayOrigin.clone().addScaledVector(this.tempRayDir, 5.0);
      return {
        isSnapped: false,
        snappedPosition: fakePos,
        snappedRotation: freeEuler,
        snappedQuaternion: freeQuat,
        targetPieceId: null,
        targetSocket: null,
        sourceSocket: null,
        isValidPlacement: false,
        validationReason: 'No surface hit (cannot build in air)',
      };
    }

    let hitPoint = rayHit.point.clone();
    let hitNormal = new THREE.Vector3(0, 1, 0).copy(rayHit.normal);
    let hitPieceDirect: BuiltPiece | null = null;

    try {
      const colliderAny = rayHit.hit.collider as any;
      const body = colliderAny?.parent ? colliderAny.parent() : null;
      const pieceId = (body?.userData as any)?.pieceId || colliderAny?.userData?.pieceId;
      if (pieceId) {
        hitPieceDirect = existingPieces.find((p) => p.id === pieceId) || null;
      }
    } catch {
      // Fallback to spatial proximity if userData not accessible
    }

    // Furniture is placed freely on any upward surface (floor, ground, table top)
    if (isFurniturePiece(pieceType)) {
      return this.evaluateFurniturePlacement(pieceType, hitPoint, hitNormal, manualYaw, snappingEnabled, existingPieces, playerPos);
    }

    // 2. Snapping Logic
    if (snappingEnabled && existingPieces.length > 0) {
      // Find nearby candidate pieces
      const nearbyPieces: BuiltPiece[] = [];
      if (hitPieceDirect) {
        nearbyPieces.push(hitPieceDirect);
      }

      const maxRadius = SnapSystem.SNAP_RADIUS + 1.2;
      const maxRadiusSq = maxRadius * maxRadius;

      for (let i = 0; i < existingPieces.length; i++) {
        const piece = existingPieces[i];
        if (hitPieceDirect && piece.id === hitPieceDirect.id) continue;
        const p = piece.position;
        const dx = p.x - hitPoint.x;
        if (dx > maxRadius || dx < -maxRadius) continue;
        const dz = p.z - hitPoint.z;
        if (dz > maxRadius || dz < -maxRadius) continue;
        const dy = p.y - hitPoint.y;
        if (dy > maxRadius || dy < -maxRadius) continue;

        if (dx * dx + dy * dy + dz * dz <= maxRadiusSq) {
          nearbyPieces.push(piece);
        }
      }

      // Sort nearby pieces so direct hit or closest piece is evaluated first
      nearbyPieces.sort((a, b) => {
        if (hitPieceDirect && a.id === hitPieceDirect.id) return -1;
        if (hitPieceDirect && b.id === hitPieceDirect.id) return 1;
        return a.position.distanceToSquared(hitPoint) - b.position.distanceToSquared(hitPoint);
      });

      const candidates: CandidatePlacement[] = [];

      for (const targetPiece of nearbyPieces) {
        this.generateCandidatesForPair(
          targetPiece,
          pieceType,
          pieceDef,
          hitPoint,
          hitNormal,
          manualYaw,
          existingPieces,
          candidates
        );
      }

      // If we found valid candidates, pick the one with highest score
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];

        const distToPlayer = best.position.distanceTo(playerPos);
        const isClearOfPlayer = distToPlayer >= SnapSystem.PLAYER_COLLISION_RADIUS;
        const isWithinRange = distToPlayer <= SnapSystem.MAX_PLACEMENT_DISTANCE;
        const isBelowSurface = isPieceBelowSurface(pieceType, best.position, best.quaternion);
        const isSupported = isWindowOrDoorPiece(pieceType)
          ? this.isOpeningSupportedBySolidWalls(best.position, best.quaternion, pieceType, existingPieces)
          : true;
        const isValid = isClearOfPlayer && isWithinRange && !isBelowSurface && isSupported;

        let reason = undefined;
        if (!isClearOfPlayer) reason = 'Too close to player character';
        else if (!isWithinRange) reason = 'Too far away (max 15m)';
        else if (isBelowSurface) reason = 'Cannot place elements below the surface';
        else if (!isSupported) reason = 'Must be placed on existing solid walls';

        return {
          isSnapped: true,
          snappedPosition: best.position,
          snappedRotation: new THREE.Euler().setFromQuaternion(best.quaternion, 'YXZ'),
          snappedQuaternion: best.quaternion,
          targetPieceId: best.targetPieceId,
          targetSocket: best.targetSocket,
          sourceSocket: best.sourceSocket,
          isValidPlacement: isValid,
          validationReason: reason,
          wallGridInfo: best.wallGridInfo || null,
        };
      }
    }

    // 2.5 Free placement on wall surface for windows and doors when snapping is disabled
    if (!snappingEnabled && isWindowOrDoorPiece(pieceType) && existingPieces.length > 0) {
      let targetWall = hitPieceDirect && isSolidWallPiece(hitPieceDirect.type) ? hitPieceDirect : null;
      if (!targetWall) {
        for (const piece of existingPieces) {
          if (isSolidWallPiece(piece.type) && piece.position.distanceTo(hitPoint) < 2.5) {
            targetWall = piece;
            break;
          }
        }
      }

      if (targetWall) {
        const targetRight = new THREE.Vector3(1, 0, 0).applyQuaternion(targetWall.quaternion);
        const targetUp = new THREE.Vector3(0, 1, 0);
        const targetForward = new THREE.Vector3(0, 0, 1).applyQuaternion(targetWall.quaternion);
        const userYawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), manualYaw);

        const targetHalfW = getWallHalfWidth(targetWall.type);
        const previewHalfW = getWallHalfWidth(pieceType);
        const targetHalfH = getWallHalfHeight(targetWall.type);
        const previewHalfH = getWallHalfHeight(pieceType);

        const rawHitX = hitPoint.clone().sub(targetWall.position).dot(targetRight);
        const rawHitY = hitPoint.clone().sub(targetWall.position).dot(targetUp);

        const isWinOrDoor = isWindowOrDoorPiece(pieceType);
        const wallGridStep = isWinOrDoor ? SnapSystem.WINDOW_DOOR_GRID_SNAP_STEP : SnapSystem.GRID_SNAP_STEP;

        const snappedLocalX = Math.round(rawHitX / wallGridStep) * wallGridStep;

        // Calculate continuous vertical wall stack bounds for free mode
        let minGridY = -targetHalfH;
        let maxGridY = targetHalfH;

        for (const other of existingPieces) {
          if (!isSolidWallPiece(other.type) || other.id === targetWall.id) continue;
          const delta = other.position.clone().sub(targetWall.position);
          const normDist = Math.abs(delta.dot(targetForward));
          if (normDist > 0.15) continue;

          const otherRight = new THREE.Vector3(1, 0, 0).applyQuaternion(other.quaternion);
          if (Math.abs(otherRight.dot(targetRight)) < 0.9) continue;

          const otherHalfW = getWallHalfWidth(other.type);
          const otherHalfH = getWallHalfHeight(other.type);
          const otherCenterX = delta.dot(targetRight);

          if (Math.abs(otherCenterX) < 16.0) {
            minGridY = Math.min(minGridY, delta.y - otherHalfH);
            maxGridY = Math.max(maxGridY, delta.y + otherHalfH);
          }
        }

        const minAllowedY = minGridY + previewHalfH;
        const maxAllowedY = maxGridY - previewHalfH;
        const snappedOffsetFromMin = Math.round((rawHitY - minAllowedY) / wallGridStep) * wallGridStep;
        const freeLocalY = THREE.MathUtils.clamp(minAllowedY + snappedOffsetFromMin, minAllowedY, maxAllowedY);

        const freePosOnWall = targetWall.position.clone()
          .addScaledVector(targetRight, snappedLocalX)
          .addScaledVector(targetUp, freeLocalY);

        const freeQuatOnWall = targetWall.quaternion.clone().multiply(userYawQuat);

        const distToPlayer = freePosOnWall.distanceTo(playerPos);
        const isClearOfPlayer = distToPlayer >= SnapSystem.PLAYER_COLLISION_RADIUS;
        const isWithinRange = distToPlayer <= SnapSystem.MAX_PLACEMENT_DISTANCE;
        const isBelowSurface = isPieceBelowSurface(pieceType, freePosOnWall, freeQuatOnWall);
        const isSupported = this.isOpeningSupportedBySolidWalls(freePosOnWall, freeQuatOnWall, pieceType, existingPieces);

        const isValid = isClearOfPlayer && isWithinRange && !isBelowSurface && isSupported;
        let reason = undefined;
        if (!isClearOfPlayer) reason = 'Too close to player character';
        else if (!isWithinRange) reason = 'Too far away (max 15m)';
        else if (isBelowSurface) reason = 'Cannot place elements below the surface';
        else if (!isSupported) reason = 'Must be placed on existing solid walls';

        return {
          isSnapped: false,
          snappedPosition: freePosOnWall,
          snappedRotation: new THREE.Euler().setFromQuaternion(freeQuatOnWall, 'YXZ'),
          snappedQuaternion: freeQuatOnWall,
          targetPieceId: targetWall.id,
          targetSocket: null,
          sourceSocket: null,
          isValidPlacement: isValid,
          validationReason: reason,
          wallGridInfo: {
            wallPieceId: targetWall.id,
            wallPosition: targetWall.position.clone(),
            wallQuaternion: targetWall.quaternion.clone(),
            wallWidth: targetHalfW * 2,
            wallHeight: targetHalfH * 2,
            faceSide: (hitNormal.dot(targetForward) >= 0) ? 'front' : 'back',
            gridStep: wallGridStep,
            activeFaceNormal: (hitNormal.dot(targetForward) >= 0) ? targetForward.clone() : targetForward.clone().negate(),
            gridMinX: -targetHalfW,
            gridMaxX: targetHalfW,
            gridMinY: -targetHalfH,
            gridMaxY: targetHalfH,
            previewLocalMinX: snappedLocalX - previewHalfW,
            previewLocalMaxX: snappedLocalX + previewHalfW,
            previewLocalMinY: freeLocalY - previewHalfH,
            previewLocalMaxY: freeLocalY + previewHalfH,
            snappedLocalX: snappedLocalX,
            snappedLocalY: freeLocalY,
            previewWidth: previewHalfW * 2,
            previewHeight: previewHalfH * 2,
          }
        };
      }
    }

    // 2.6 Free placement of Floor / Ceiling on Wall top or bottom when snapping is disabled
    if (!snappingEnabled && this.isFloor(pieceType) && existingPieces.length > 0) {
      let targetWall: BuiltPiece | null = hitPieceDirect && this.isWall(hitPieceDirect.type) ? hitPieceDirect : null;

      if (!targetWall) {
        let bestDist = 2.8;
        for (const piece of existingPieces) {
          if (!this.isWall(piece.type)) continue;
          const wHalfW = getWallHalfWidth(piece.type);
          const wHalfH = getWallHalfHeight(piece.type);
          const wallTopY = piece.position.y + wHalfH;
          const dY = Math.abs(hitPoint.y - wallTopY);
          const dXZ = Math.hypot(hitPoint.x - piece.position.x, hitPoint.z - piece.position.z);

          if (dXZ < wHalfW + 1.6 && dY < 1.6) {
            const totalDist = Math.hypot(dXZ, dY);
            if (totalDist < bestDist) {
              bestDist = totalDist;
              targetWall = piece;
            }
          }
        }
      }

      if (targetWall) {
        const targetRight = new THREE.Vector3(1, 0, 0).applyQuaternion(targetWall.quaternion);
        const targetUp = new THREE.Vector3(0, 1, 0);
        const targetForward = new THREE.Vector3(0, 0, 1).applyQuaternion(targetWall.quaternion);
        const userYawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), manualYaw);

        const targetHalfW = getWallHalfWidth(targetWall.type);
        const targetHalfH = getWallHalfHeight(targetWall.type);
        const previewHalfSize = getFloorHalfSize(pieceType);

        const delta = hitPoint.clone().sub(targetWall.position);
        const rawHitX = delta.dot(targetRight);
        const rawHitY = delta.dot(targetUp);
        const rawHitZ = delta.dot(targetForward);

        const isHitTop = rawHitY >= -targetHalfH * 0.4 || hitNormal.y > 0.3;
        const floorY = isHitTop
          ? targetWall.position.y + targetHalfH - FLOOR_THICKNESS / 2.0
          : targetWall.position.y - targetHalfH + FLOOR_THICKNESS / 2.0;

        // Determine forward/backward side (+Z or -Z in wall local space)
        const forwardSign = (rawHitZ >= 0 || hitNormal.dot(targetForward) > 0.05) ? 1 : -1;
        const forwardOffset = targetForward.clone().multiplyScalar(forwardSign * previewHalfSize);

        // Snap along wall length (X-axis in wall local space)
        const stepX = previewHalfSize === 0.5 ? 0.5 : 1.0;
        const snappedLocalX = Math.round(rawHitX / stepX) * stepX;

        const freePosOnWall = targetWall.position.clone()
          .addScaledVector(targetRight, snappedLocalX)
          .add(forwardOffset)
          .setY(floorY);

        const freeQuatOnWall = targetWall.quaternion.clone().multiply(userYawQuat);

        const distToPlayer = freePosOnWall.distanceTo(playerPos);
        const isClearOfPlayer = distToPlayer >= SnapSystem.PLAYER_COLLISION_RADIUS;
        const isWithinRange = distToPlayer <= SnapSystem.MAX_PLACEMENT_DISTANCE;
        const isOccupied = this.isPositionOccupied(freePosOnWall, pieceType, existingPieces, freeQuatOnWall);
        const isBelowSurface = isPieceBelowSurface(pieceType, freePosOnWall, freeQuatOnWall);

        const isValid = isClearOfPlayer && isWithinRange && !isOccupied && !isBelowSurface;
        let reason = undefined;
        if (!isClearOfPlayer) reason = 'Too close to player character';
        else if (!isWithinRange) reason = 'Too far away (max 15m)';
        else if (isOccupied) reason = 'Space is already occupied';
        else if (isBelowSurface) reason = 'Cannot place elements below the surface';

        return {
          isSnapped: false,
          snappedPosition: freePosOnWall,
          snappedRotation: new THREE.Euler().setFromQuaternion(freeQuatOnWall, 'YXZ'),
          snappedQuaternion: freeQuatOnWall,
          targetPieceId: targetWall.id,
          targetSocket: null,
          sourceSocket: null,
          isValidPlacement: isValid,
          validationReason: reason,
        };
      }
    }

    // 3. Fallback: Grid Placement on Ground / Surface (1x1 grid divided by 2 -> 0.5m grid step)
    const freeEuler = new THREE.Euler(0, manualYaw, 0, 'YXZ');
    const freeQuat = new THREE.Quaternion().setFromEuler(freeEuler);

    const isHorizontal = Math.abs(hitNormal.y) > 0.6;
    let freePos: THREE.Vector3;

    if (isHorizontal) {
      const isWinOrDoor = isWindowOrDoorPiece(pieceType);
      const isProcRoof = this.isRoof(pieceType);
      const halfH = isProcRoof ? 0 : pieceDef.dimensions.y / 2.0;

      if (isWinOrDoor) {
        const hStep = SnapSystem.WINDOW_DOOR_GRID_SNAP_STEP;
        const snappedX = Math.round(hitPoint.x / hStep) * hStep;
        const snappedZ = Math.round(hitPoint.z / hStep) * hStep;
        const surfaceY = hitNormal.y >= 0 ? hitPoint.y + halfH : hitPoint.y - halfH;
        freePos = new THREE.Vector3(snappedX, surfaceY, snappedZ);
      } else {
        // Horizontal surfaces (terrain, ground, floor tops): snap X and Z to 1.0m modular grid
        // Project piece dimensions onto world axes according to rotation
        const pRight = new THREE.Vector3(1, 0, 0).applyQuaternion(freeQuat);
        const pFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(freeQuat);
        const spanX = Math.abs(pRight.x) * pieceDef.dimensions.x + Math.abs(pFwd.x) * pieceDef.dimensions.z;
        const spanZ = Math.abs(pRight.z) * pieceDef.dimensions.x + Math.abs(pFwd.z) * pieceDef.dimensions.z;

        // Helper: snap coordinates so piece boundaries align precisely with the 1.0m integer grid lines.
        // If a span is odd (e.g. 1m, 3m), the center sits at (k + 0.5) so boundaries [k, k+1] are integers.
        // If a span is thin (< 0.45m like wall thickness) or even (e.g. 2m, 4m), the center sits at integer k.
        const snapCoord = (raw: number, span: number) => {
          if (span < 0.45) {
            return Math.round(raw);
          }
          const roundedSpan = Math.round(span);
          if (roundedSpan % 2 === 1) {
            return Math.floor(raw) + 0.5;
          }
          return Math.round(raw);
        };

        const snappedX = snapCoord(hitPoint.x, spanX);
        const snappedZ = snapCoord(hitPoint.z, spanZ);
        const isFloorOnGround = this.isFloor(pieceType) && !hitPieceDirect;
        const groundOffset = isFloorOnGround ? (pieceDef.dimensions.y * BUILDING_CONFIG.GROUND_FLOOR_SINK_PERCENT) : 0;
        let surfaceY = hitNormal.y >= 0 ? hitPoint.y + halfH - groundOffset : hitPoint.y - halfH;

        // If placing a floor on an existing floor slab in free mode, maintain identical plane height
        if (this.isFloor(pieceType) && hitPieceDirect && this.isFloor(hitPieceDirect.type) && hitNormal.y > 0.6) {
          surfaceY = hitPieceDirect.position.y;
        }

        freePos = new THREE.Vector3(snappedX, surfaceY, snappedZ);
      }
    } else {
      // Vertical surfaces (walls, rocks): strictly snap to modular grid cells
      const pieceRight = new THREE.Vector3(1, 0, 0).applyQuaternion(freeQuat);
      const pieceForward = new THREE.Vector3(0, 0, 1).applyQuaternion(freeQuat);

      const extentX = Math.abs(hitNormal.dot(pieceRight)) * (pieceDef.dimensions.x / 2.0);
      const extentZ = Math.abs(hitNormal.dot(pieceForward)) * (pieceDef.dimensions.z / 2.0);
      const halfH = pieceDef.dimensions.y / 2.0;
      const offsetAlongNormal = Math.max(extentX, extentZ, 0.5);

      const targetCenterX = hitPoint.x + hitNormal.x * offsetAlongNormal;
      const targetCenterZ = hitPoint.z + hitNormal.z * offsetAlongNormal;

      const vStep = isWindowOrDoorPiece(pieceType) ? SnapSystem.WINDOW_DOOR_GRID_SNAP_STEP : SnapSystem.GRID_SNAP_STEP;
      const snappedX = Math.round(targetCenterX / vStep) * vStep;
      const snappedZ = Math.round(targetCenterZ / vStep) * vStep;
      const snappedY = Math.round(hitPoint.y / vStep) * vStep;

      freePos = new THREE.Vector3(snappedX, snappedY, snappedZ);
    }

    const distToPlayer = freePos.distanceTo(playerPos);
    const isClearOfPlayer = distToPlayer >= SnapSystem.PLAYER_COLLISION_RADIUS;
    const isWithinRange = distToPlayer <= SnapSystem.MAX_PLACEMENT_DISTANCE;
    const isOccupied = this.isPositionOccupied(freePos, pieceType, existingPieces, freeQuat);
    const isBelowSurface = isPieceBelowSurface(pieceType, freePos, freeQuat);

    const isValid = isClearOfPlayer && isWithinRange && !isOccupied && !isBelowSurface;

    let reason = undefined;
    if (!isClearOfPlayer) reason = 'Too close to player character';
    else if (!isWithinRange) reason = 'Too far away (max 15m)';
    else if (isOccupied) reason = 'Space is already occupied';
    else if (isBelowSurface) reason = 'Cannot place elements below the surface';

    return {
      isSnapped: false,
      snappedPosition: freePos,
      snappedRotation: freeEuler,
      snappedQuaternion: freeQuat,
      targetPieceId: null,
      targetSocket: null,
      sourceSocket: null,
      isValidPlacement: isValid,
      validationReason: reason,
    };
  }

  /**
   * Generates candidate snap placements around a target piece based on surface normal,
   * local hit coordinates, and socket compatibility.
   */
  private generateCandidatesForPair(
    targetPiece: BuiltPiece,
    previewType: BuildingPieceType,
    previewDef: any,
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3,
    manualYaw: number,
    existingPieces: BuiltPiece[],
    candidates: CandidatePlacement[]
  ): void {
    const invTargetQuat = targetPiece.quaternion.clone().invert();
    const localHitPoint = hitPoint.clone().sub(targetPiece.position).applyQuaternion(invTargetQuat);
    const localHitNormal = hitNormal.clone().applyQuaternion(invTargetQuat);

    const isTargetWall = this.isWall(targetPiece.type);
    const isPreviewWall = this.isWall(previewType);
    const isTargetFloor = this.isFloor(targetPiece.type);
    const isPreviewFloor = this.isFloor(previewType);
    const isTargetRoof = this.isRoof(targetPiece.type);
    const isPreviewRoof = this.isRoof(previewType);
    const isTargetStairs = this.isStairs(targetPiece.type);
    const isPreviewStairs = this.isStairs(previewType);
    const isPreviewStraightRailing = this.isStraightRailing(previewType);
    const isTargetStraightRailing = this.isStraightRailing(targetPiece.type);
    const isPreviewStairRailing = this.isStairRailing(previewType);
    const isTargetStairRailing = this.isStairRailing(targetPiece.type);

    // Direction vectors in target piece's local space
    const targetRight = new THREE.Vector3(1, 0, 0).applyQuaternion(targetPiece.quaternion);
    const targetUp = new THREE.Vector3(0, 1, 0);
    const targetForward = new THREE.Vector3(0, 0, 1).applyQuaternion(targetPiece.quaternion);

    // Manual yaw quaternion offset
    const userYawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), manualYaw);

    // --- CASE 0: Window / Door / Doorway embedding into Solid Wall along 0.5m grid ---
    if (isSolidWallPiece(targetPiece.type) && isWindowOrDoorPiece(previewType)) {
      const targetHalfW = getWallHalfWidth(targetPiece.type);
      const previewHalfW = getWallHalfWidth(previewType);
      const targetHalfH = getWallHalfHeight(targetPiece.type);
      const previewHalfH = getWallHalfHeight(previewType);

      const isFront = (localHitNormal.z >= 0 || localHitPoint.z >= 0);
      const faceSide = isFront ? 'front' : 'back';
      const activeFaceNormal = isFront ? targetForward.clone() : targetForward.clone().negate();

      // Find all collinear and coplanar solid walls connected along the same line
      let minGridX = -targetHalfW;
      let maxGridX = targetHalfW;
      let minGridY = -targetHalfH;
      let maxGridY = targetHalfH;

      for (const other of existingPieces) {
        if (!isSolidWallPiece(other.type) || other.id === targetPiece.id) continue;
        const dy = Math.abs(other.position.y - targetPiece.position.y);
        if (dy > 0.4) continue; // Same vertical story

        const delta = other.position.clone().sub(targetPiece.position);
        const normDist = Math.abs(delta.dot(targetForward));
        if (normDist > 0.15) continue; // Same plane

        const otherRight = new THREE.Vector3(1, 0, 0).applyQuaternion(other.quaternion);
        if (Math.abs(otherRight.dot(targetRight)) < 0.9) continue; // Collinear orientation

        const otherHalfW = getWallHalfWidth(other.type);
        const otherHalfH = getWallHalfHeight(other.type);
        const otherCenterX = delta.dot(targetRight);

        // Include connected and adjacent walls in continuous run
        if (Math.abs(otherCenterX) < 16.0) {
          minGridX = Math.min(minGridX, otherCenterX - otherHalfW);
          maxGridX = Math.max(maxGridX, otherCenterX + otherHalfW);
          minGridY = Math.min(minGridY, delta.y - otherHalfH);
          maxGridY = Math.max(maxGridY, delta.y + otherHalfH);
        }
      }

      const step = SnapSystem.WINDOW_DOOR_GRID_SNAP_STEP;

      // Horizontal snapping across the continuous wall face (0.5m sub-step for windows/doors)
      const rawHitX = hitPoint.clone().sub(targetPiece.position).dot(targetRight);
      const snappedLocalX = Math.round(rawHitX / step) * step;

      // Vertical snapping across the wall face (applies to windows, doorways, and doors: 0.5m step)
      const rawHitY = hitPoint.clone().sub(targetPiece.position).dot(targetUp);
      const minAllowedY = minGridY + previewHalfH;
      const maxAllowedY = maxGridY - previewHalfH;
      const snappedOffsetFromMin = Math.round((rawHitY - minAllowedY) / step) * step;
      const snappedLocalY = THREE.MathUtils.clamp(minAllowedY + snappedOffsetFromMin, minAllowedY, maxAllowedY);

      const candidatePos = targetPiece.position.clone()
        .addScaledVector(targetRight, snappedLocalX)
        .addScaledVector(targetUp, snappedLocalY);

      const candidateQuat = targetPiece.quaternion.clone().multiply(userYawQuat);

      const wallGridInfo: WallGridInfo = {
        wallPieceId: targetPiece.id,
        wallPosition: targetPiece.position.clone(),
        wallQuaternion: targetPiece.quaternion.clone(),
        wallWidth: targetHalfW * 2,
        wallHeight: targetHalfH * 2,
        faceSide,
        gridStep: step,
        activeFaceNormal,
        gridMinX: minGridX,
        gridMaxX: maxGridX,
        gridMinY: minGridY,
        gridMaxY: maxGridY,
        previewLocalMinX: snappedLocalX - previewHalfW,
        previewLocalMaxX: snappedLocalX + previewHalfW,
        previewLocalMinY: snappedLocalY - previewHalfH,
        previewLocalMaxY: snappedLocalY + previewHalfH,
        snappedLocalX,
        snappedLocalY,
        previewWidth: previewHalfW * 2,
        previewHeight: previewHalfH * 2,
      };

      this.addCandidateIfFree(
        candidatePos,
        candidateQuat,
        hitPoint,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        9.0, // High priority score so it magnetically attaches to wall surface
        existingPieces,
        candidates,
        null,
        null,
        wallGridInfo
      );
      return;
    }

    // --- CASE A: Wall snapping to Wall ---
    if (isTargetWall && isPreviewWall && !isWindowOrDoorPiece(previewType) && !isWindowOrDoorPiece(targetPiece.type)) {
      const targetHalfW = getWallHalfWidth(targetPiece.type);
      const previewHalfW = getWallHalfWidth(previewType);
      const targetHalfH = getWallHalfHeight(targetPiece.type);
      const previewHalfH = getWallHalfHeight(previewType);
      const sideDist = targetHalfW + previewHalfW;
      const stackDistY = targetHalfH + previewHalfH;

      const isCornerRequested = Math.abs(Math.sin(manualYaw)) > 0.6;
      const rotCollinear = targetPiece.quaternion.clone().multiply(userYawQuat);

      // 1. Collinear extensions: Right side wall (X > 0)
      const posRight = targetPiece.position.clone().addScaledVector(targetRight, sideDist);
      const jointRight = targetPiece.position.clone().addScaledVector(targetRight, targetHalfW);
      this.addCandidateIfFree(
        posRight,
        rotCollinear,
        jointRight,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.x > 0.25 && !isCornerRequested) ? 4.2 : 1.2,
        existingPieces,
        candidates
      );

      // 2. Collinear extensions: Left side wall (X < 0)
      const posLeft = targetPiece.position.clone().addScaledVector(targetRight, -sideDist);
      const jointLeft = targetPiece.position.clone().addScaledVector(targetRight, -targetHalfW);
      this.addCandidateIfFree(
        posLeft,
        rotCollinear,
        jointLeft,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.x < -0.25 && !isCornerRequested) ? 4.2 : 1.2,
        existingPieces,
        candidates
      );

      // 3. Top wall (stacked second story)
      const posTop = targetPiece.position.clone().addScaledVector(targetUp, stackDistY);
      const jointTop = targetPiece.position.clone().addScaledVector(targetUp, targetHalfH);
      this.addCandidateIfFree(
        posTop,
        rotCollinear,
        jointTop,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.y > 0.35 || localHitNormal.y > 0.4) ? 4.8 : 0.8,
        existingPieces,
        candidates
      );

      // 4. Bottom wall (downward extension if elevated)
      const posBottom = targetPiece.position.clone().addScaledVector(targetUp, -stackDistY);
      const jointBottom = targetPiece.position.clone().addScaledVector(targetUp, -targetHalfH);
      this.addCandidateIfFree(
        posBottom,
        rotCollinear,
        jointBottom,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.y < -0.35 || localHitNormal.y < -0.4) ? 4.8 : 0.5,
        existingPieces,
        candidates
      );

      // 5. Perpendicular 90° and -90° Corner Placements at edges
      const rot90Pos = targetPiece.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
      const rot90Neg = targetPiece.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2));

      // Right edge (+X) corners
      const posRightCornerFwd = targetPiece.position.clone()
        .addScaledVector(targetRight, targetHalfW)
        .addScaledVector(targetForward, previewHalfW);
      this.addCandidateIfFree(
        posRightCornerFwd,
        rot90Pos,
        jointRight,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.x > 0.2 && (localHitPoint.z > 0 || isCornerRequested)) ? 4.5 : 2.0,
        existingPieces,
        candidates
      );

      const posRightCornerBack = targetPiece.position.clone()
        .addScaledVector(targetRight, targetHalfW)
        .addScaledVector(targetForward, -previewHalfW);
      this.addCandidateIfFree(
        posRightCornerBack,
        rot90Neg,
        jointRight,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.x > 0.2 && (localHitPoint.z < 0 || isCornerRequested)) ? 4.5 : 2.0,
        existingPieces,
        candidates
      );

      // Left edge (-X) corners
      const posLeftCornerFwd = targetPiece.position.clone()
        .addScaledVector(targetRight, -targetHalfW)
        .addScaledVector(targetForward, previewHalfW);
      this.addCandidateIfFree(
        posLeftCornerFwd,
        rot90Pos,
        jointLeft,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.x < -0.2 && (localHitPoint.z > 0 || isCornerRequested)) ? 4.5 : 2.0,
        existingPieces,
        candidates
      );

      const posLeftCornerBack = targetPiece.position.clone()
        .addScaledVector(targetRight, -targetHalfW)
        .addScaledVector(targetForward, -previewHalfW);
      this.addCandidateIfFree(
        posLeftCornerBack,
        rot90Neg,
        jointLeft,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.x < -0.2 && (localHitPoint.z < 0 || isCornerRequested)) ? 4.5 : 2.0,
        existingPieces,
        candidates
      );

      // 6. T-junctions on Wall faces (perpendicular wall centered on grid/wall centerline)
      // For 1m walls on 2m walls, snap to [-0.5, 0.5] so wall segments remain integer 1m multiples without dead 0.5m gaps
      const tOffsets = targetHalfW === 1.0 ? (previewHalfW === 0.5 ? [-0.5, 0.5] : [0]) : [0];
      const forwardSigns = [-1, 1];

      for (const fSign of forwardSigns) {
        const rotT = fSign > 0 ? rot90Pos : rot90Neg;
        for (const tOff of tOffsets) {
          const posT = targetPiece.position.clone()
            .addScaledVector(targetForward, fSign * previewHalfW)
            .addScaledVector(targetRight, tOff);
          const jointT = targetPiece.position.clone().addScaledVector(targetRight, tOff);

          const isForwardMatch = (fSign > 0 && (localHitNormal.z > 0 || localHitPoint.z > 0)) ||
                                 (fSign < 0 && (localHitNormal.z < 0 || localHitPoint.z < 0));
          const distToHitX = Math.abs(localHitPoint.x - tOff);
          const isLateralMatch = distToHitX < 0.35;

          this.addCandidateIfFree(
            posT,
            rotT,
            jointT,
            targetPiece,
            previewType,
            hitPoint,
            hitNormal,
            isForwardMatch ? (isLateralMatch ? 5.2 : 2.8) : 1.0,
            existingPieces,
            candidates
          );
        }
      }
    }

    // --- CASE B: Floor snapping to Floor ---
    else if (isTargetFloor && isPreviewFloor) {
      const targetHalfSize = getFloorHalfSize(targetPiece.type); // 0.5 for 1x1, 1.0 for 2x2
      const previewHalfSize = getFloorHalfSize(previewType); // 0.5 for 1x1, 1.0 for 2x2
      const stepDist = targetHalfSize + previewHalfSize;

      // Lateral subdivisions on 0.5m grid (1x1 divided by 2)
      // When target is 2x2 (half 1.0) and preview is 1x1 (half 0.5): offsets are [-0.5, 0.5]
      // Otherwise centered [0]
      const lateralOffsets = targetHalfSize === 1.0 && previewHalfSize === 0.5 ? [-0.5, 0.5] : [0];

      for (const lateralOffset of lateralOffsets) {
        // East (+X)
        const posEast = targetPiece.position.clone()
          .addScaledVector(targetRight, stepDist)
          .addScaledVector(targetForward, lateralOffset);
        const jointEast = targetPiece.position.clone()
          .addScaledVector(targetRight, targetHalfSize)
          .addScaledVector(targetForward, lateralOffset);
        this.addCandidateIfFree(
          posEast,
          targetPiece.quaternion.clone().multiply(userYawQuat),
          jointEast,
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          (localHitPoint.x > 0.2 || localHitNormal.x > 0.3) ? 4.0 : 1.0,
          existingPieces,
          candidates
        );

        // West (-X)
        const posWest = targetPiece.position.clone()
          .addScaledVector(targetRight, -stepDist)
          .addScaledVector(targetForward, lateralOffset);
        const jointWest = targetPiece.position.clone()
          .addScaledVector(targetRight, -targetHalfSize)
          .addScaledVector(targetForward, lateralOffset);
        this.addCandidateIfFree(
          posWest,
          targetPiece.quaternion.clone().multiply(userYawQuat),
          jointWest,
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          (localHitPoint.x < -0.2 || localHitNormal.x < -0.3) ? 4.0 : 1.0,
          existingPieces,
          candidates
        );

        // North (+Z)
        const posNorth = targetPiece.position.clone()
          .addScaledVector(targetForward, stepDist)
          .addScaledVector(targetRight, lateralOffset);
        const jointNorth = targetPiece.position.clone()
          .addScaledVector(targetForward, targetHalfSize)
          .addScaledVector(targetRight, lateralOffset);
        this.addCandidateIfFree(
          posNorth,
          targetPiece.quaternion.clone().multiply(userYawQuat),
          jointNorth,
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          (localHitPoint.z > 0.2 || localHitNormal.z > 0.3) ? 4.0 : 1.0,
          existingPieces,
          candidates
        );

        // South (-Z)
        const posSouth = targetPiece.position.clone()
          .addScaledVector(targetForward, -stepDist)
          .addScaledVector(targetRight, lateralOffset);
        const jointSouth = targetPiece.position.clone()
          .addScaledVector(targetForward, -targetHalfSize)
          .addScaledVector(targetRight, lateralOffset);
        this.addCandidateIfFree(
          posSouth,
          targetPiece.quaternion.clone().multiply(userYawQuat),
          jointSouth,
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          (localHitPoint.z < -0.2 || localHitNormal.z < -0.3) ? 4.0 : 1.0,
          existingPieces,
          candidates
        );
      }
    }

    // --- CASE C: Wall snapping on Floor edge ---
    else if (isTargetFloor && isPreviewWall) {
      const targetHalfSize = getFloorHalfSize(targetPiece.type);
      const targetTopY = targetPiece.position.y + (BUILDING_PIECES[targetPiece.type]?.dimensions.y ?? FLOOR_THICKNESS) / 2.0;
      const previewHalfH = getWallHalfHeight(previewType);
      // If the target floor is on/at ground level, wall rests directly on the ground (Y = 0)
      const isTargetFloorOnGround = targetPiece.position.y <= BUILDING_CONFIG.GROUND_SURFACE_Y + 0.35;
      const wallY = isTargetFloorOnGround
        ? BUILDING_CONFIG.GROUND_SURFACE_Y + previewHalfH
        : targetTopY + previewHalfH;
      const isNarrowWall = getWallHalfWidth(previewType) === 0.5;
      const offsets = targetHalfSize === 1.0 && isNarrowWall ? [-0.5, 0.5] : [0];

      for (const offset of offsets) {
        // North edge (+Z)
        const posN = new THREE.Vector3(targetPiece.position.x, wallY, targetPiece.position.z)
          .addScaledVector(targetForward, targetHalfSize)
          .addScaledVector(targetRight, offset);
        const rotN = targetPiece.quaternion.clone().multiply(userYawQuat);
        this.addCandidateIfFree(
          posN,
          rotN,
          posN.clone().setY(targetPiece.position.y),
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          localHitPoint.z > 0.25 ? 4.0 : 1.0,
          existingPieces,
          candidates
        );

        // South edge (-Z)
        const posS = new THREE.Vector3(targetPiece.position.x, wallY, targetPiece.position.z)
          .addScaledVector(targetForward, -targetHalfSize)
          .addScaledVector(targetRight, offset);
        const rotS = targetPiece.quaternion.clone().multiply(userYawQuat);
        this.addCandidateIfFree(
          posS,
          rotS,
          posS.clone().setY(targetPiece.position.y),
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          localHitPoint.z < -0.25 ? 4.0 : 1.0,
          existingPieces,
          candidates
        );

        // East edge (+X) - rotated 90 degrees
        const rot90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
        const posE = new THREE.Vector3(targetPiece.position.x, wallY, targetPiece.position.z)
          .addScaledVector(targetRight, targetHalfSize)
          .addScaledVector(targetForward, offset);
        const rotE = targetPiece.quaternion.clone().multiply(rot90).multiply(userYawQuat);
        this.addCandidateIfFree(
          posE,
          rotE,
          posE.clone().setY(targetPiece.position.y),
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          localHitPoint.x > 0.25 ? 4.0 : 1.0,
          existingPieces,
          candidates
        );

        // West edge (-X) - rotated 90 degrees
        const posW = new THREE.Vector3(targetPiece.position.x, wallY, targetPiece.position.z)
          .addScaledVector(targetRight, -targetHalfSize)
          .addScaledVector(targetForward, offset);
        const rotW = targetPiece.quaternion.clone().multiply(rot90).multiply(userYawQuat);
        this.addCandidateIfFree(
          posW,
          rotW,
          posW.clone().setY(targetPiece.position.y),
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          localHitPoint.x < -0.25 ? 4.0 : 1.0,
          existingPieces,
          candidates
        );
      }
    }

    // --- CASE D: Floor/Ceiling snapping to Wall ---
    else if (isTargetWall && isPreviewFloor) {
      const previewHalfSize = getFloorHalfSize(previewType);
      const targetHalfW = getWallHalfWidth(targetPiece.type);
      const targetHalfH = getWallHalfHeight(targetPiece.type);

      // 1. Forward / Backward outward from wall face (inner edge terminates at center axis of wall)
      const forwardSigns = [-1, 1];

      // 2. Lateral subdivisions (X-axis in wall coords) so edges align with 0.5m grid
      let lateralOffsets: number[] = [0];
      if (targetHalfW === 1.0 && previewHalfSize === 0.5) {
        lateralOffsets = [-0.5, 0.5];
      } else if (targetHalfW === 0.5 && previewHalfSize === 1.0) {
        lateralOffsets = [-0.5, 0.5];
      }

      for (const forwardSign of forwardSigns) {
        const floorForwardOffset = targetForward.clone().multiplyScalar(forwardSign * previewHalfSize);
        const isForwardMatch = (forwardSign > 0 && (localHitNormal.z > 0 || localHitPoint.z > 0)) ||
                               (forwardSign < 0 && (localHitNormal.z < 0 || localHitPoint.z < 0));

        for (const latOffset of lateralOffsets) {
          const floorOffset = floorForwardOffset.clone().addScaledVector(targetRight, latOffset);
          const isLateralMatch = (latOffset > 0 && localHitPoint.x > 0) || (latOffset < 0 && localHitPoint.x < 0) || latOffset === 0;

          // Height A: Floor at Wall bottom (resting on surface/floor base, above Y=0)
          const floorYBot = targetPiece.position.y - targetHalfH + FLOOR_THICKNESS / 2.0;
          const posBot = new THREE.Vector3(targetPiece.position.x, floorYBot, targetPiece.position.z).add(floorOffset);
          const rotBot = targetPiece.quaternion.clone().multiply(userYawQuat);
          this.addCandidateIfFree(
            posBot,
            rotBot,
            posBot.clone().sub(floorForwardOffset.clone().multiplyScalar(0.5)),
            targetPiece,
            previewType,
            hitPoint,
            hitNormal,
            (localHitPoint.y < 0 ? 4.2 : 1.2) * (isForwardMatch ? 1.6 : 0.6) * (isLateralMatch ? 1.2 : 0.8),
            existingPieces,
            candidates
          );

          // Height B: Floor / Ceiling at Wall top (Flush with top edge of the wall, no protrusion upwards)
          const floorYTop = targetPiece.position.y + targetHalfH - FLOOR_THICKNESS / 2.0;
          const posTop = new THREE.Vector3(targetPiece.position.x, floorYTop, targetPiece.position.z).add(floorOffset);
          const rotTop = targetPiece.quaternion.clone().multiply(userYawQuat);
          this.addCandidateIfFree(
            posTop,
            rotTop,
            posTop.clone().sub(floorForwardOffset.clone().multiplyScalar(0.5)),
            targetPiece,
            previewType,
            hitPoint,
            hitNormal,
            (localHitPoint.y >= 0 ? 4.5 : 1.2) * (isForwardMatch ? 1.6 : 0.6) * (isLateralMatch ? 1.2 : 0.8),
            existingPieces,
            candidates
          );
        }
      }

      // 3. Side Extensions: snapping floor extending from the Left (-X) or Right (+X) edge of a wall
      const sideSigns = [-1, 1];
      for (const sideSign of sideSigns) {
        const sideOffset = targetRight.clone().multiplyScalar(sideSign * (targetHalfW + previewHalfSize));
        const zOffsets = [0, previewHalfSize * 0.5, -previewHalfSize * 0.5];
        for (const zOff of zOffsets) {
          const totalSideOffset = sideOffset.clone().addScaledVector(targetForward, zOff);
          const isSideMatch = (sideSign > 0 && localHitPoint.x > 0.3) || (sideSign < 0 && localHitPoint.x < -0.3);

          // Side at Bottom
          const floorYBot = targetPiece.position.y - targetHalfH + FLOOR_THICKNESS / 2.0;
          const posSideBot = new THREE.Vector3(targetPiece.position.x, floorYBot, targetPiece.position.z).add(totalSideOffset);
          const rotSide = targetPiece.quaternion.clone().multiply(userYawQuat);

          this.addCandidateIfFree(
            posSideBot,
            rotSide,
            posSideBot.clone().sub(sideOffset.clone().multiplyScalar(0.5)),
            targetPiece,
            previewType,
            hitPoint,
            hitNormal,
            (localHitPoint.y < 0 ? 3.6 : 1.0) * (isSideMatch ? 1.5 : 0.8),
            existingPieces,
            candidates
          );

          // Side at Top (flush with top of wall)
          const floorYTop = targetPiece.position.y + targetHalfH - FLOOR_THICKNESS / 2.0;
          const posSideTop = new THREE.Vector3(targetPiece.position.x, floorYTop, targetPiece.position.z).add(totalSideOffset);

          this.addCandidateIfFree(
            posSideTop,
            rotSide,
            posSideTop.clone().sub(sideOffset.clone().multiplyScalar(0.5)),
            targetPiece,
            previewType,
            hitPoint,
            hitNormal,
            (localHitPoint.y >= 0 ? 3.6 : 1.0) * (isSideMatch ? 1.5 : 0.8),
            existingPieces,
            candidates
          );
        }
      }
    }

    // --- CASE E: Roof snapping to Roof ---
    else if (isTargetRoof && isPreviewRoof) {
      const tDims = getRoofDimensions(targetPiece.type);
      const pDims = getRoofDimensions(previewType);
      const rotSame = targetPiece.quaternion.clone().multiply(userYawQuat);

      // 1. Forward along ridge / length (Z > 0)
      const distZ = (tDims.length + pDims.length) / 2.0;
      const posFwd = targetPiece.position.clone().addScaledVector(targetForward, distZ);
      const jointFwd = targetPiece.position.clone().addScaledVector(targetForward, tDims.length / 2.0);
      this.addCandidateIfFree(
        posFwd,
        rotSame,
        jointFwd,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.z > 0.2 ? 5.2 : 2.5,
        existingPieces,
        candidates
      );

      // 2. Backward along ridge / length (Z < 0)
      const posBack = targetPiece.position.clone().addScaledVector(targetForward, -distZ);
      const jointBack = targetPiece.position.clone().addScaledVector(targetForward, -tDims.length / 2.0);
      this.addCandidateIfFree(
        posBack,
        rotSame,
        jointBack,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.z < -0.2 ? 5.2 : 2.5,
        existingPieces,
        candidates
      );

      // 3. Sideways Right (+X across pitch)
      const distX = (tDims.width + pDims.width) / 2.0;
      const posRight = targetPiece.position.clone().addScaledVector(targetRight, distX);
      const jointRight = targetPiece.position.clone().addScaledVector(targetRight, tDims.width / 2.0);
      this.addCandidateIfFree(
        posRight,
        rotSame,
        jointRight,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.x > 0.2 ? 4.8 : 2.0,
        existingPieces,
        candidates
      );

      // 4. Sideways Left (-X across pitch)
      const posLeft = targetPiece.position.clone().addScaledVector(targetRight, -distX);
      const jointLeft = targetPiece.position.clone().addScaledVector(targetRight, -tDims.width / 2.0);
      this.addCandidateIfFree(
        posLeft,
        rotSame,
        jointLeft,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.x < -0.2 ? 4.8 : 2.0,
        existingPieces,
        candidates
      );
    }

    // --- CASE F: Roof snapping on Wall / Wall under Roof ---
    else if (isTargetWall && isPreviewRoof) {
      const targetHalfH = getWallHalfHeight(targetPiece.type);
      const pDims = getRoofDimensions(previewType);
      // Procedural roof base is at y = 0, so roof sits directly on top edge of the wall
      const roofY = targetPiece.position.y + targetHalfH;
      const rot = targetPiece.quaternion.clone().multiply(userYawQuat);

      // Option 1: Centered directly over wall
      const posCenter = new THREE.Vector3(targetPiece.position.x, roofY, targetPiece.position.z);
      this.addCandidateIfFree(
        posCenter,
        rot,
        targetPiece.position.clone().addScaledVector(targetUp, targetHalfH),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        5.2,
        existingPieces,
        candidates
      );

      // Option 2: Eave inward (+Z)
      const posIn = posCenter.clone().addScaledVector(targetForward, pDims.width / 2.0);
      this.addCandidateIfFree(
        posIn,
        rot,
        targetPiece.position.clone().addScaledVector(targetUp, targetHalfH),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        4.5,
        existingPieces,
        candidates
      );

      // Option 3: Eave outward (-Z)
      const posOut = posCenter.clone().addScaledVector(targetForward, -pDims.width / 2.0);
      this.addCandidateIfFree(
        posOut,
        rot,
        targetPiece.position.clone().addScaledVector(targetUp, targetHalfH),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        4.5,
        existingPieces,
        candidates
      );
    }

    // --- CASE G: Floor / Ceiling snapping to Roof (Heartopia Ceiling-Based Roof Placement) ---
    else if (isTargetFloor && isPreviewRoof) {
      // Procedural roof base is at y = 0, so it rests directly on top surface of the floor
      const roofY = targetPiece.position.y + FLOOR_THICKNESS / 2.0;
      const rot = targetPiece.quaternion.clone().multiply(userYawQuat);

      const posCenter = new THREE.Vector3(targetPiece.position.x, roofY, targetPiece.position.z);
      this.addCandidateIfFree(
        posCenter,
        rot,
        targetPiece.position.clone().addScaledVector(targetUp, FLOOR_THICKNESS / 2.0),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        5.5,
        existingPieces,
        candidates
      );
    }

    // Wall under Roof
    else if (isTargetRoof && isPreviewWall) {
      const previewHalfH = getWallHalfHeight(previewType);
      // Target roof base is at targetPiece.position.y, so top of the wall meets base of the roof
      const wallYUnderRoof = targetPiece.position.y - previewHalfH;
      const posUnder = new THREE.Vector3(targetPiece.position.x, wallYUnderRoof, targetPiece.position.z);
      const rotWall = targetPiece.quaternion.clone().multiply(userYawQuat);

      this.addCandidateIfFree(
        posUnder,
        rotWall,
        posUnder.clone().addScaledVector(targetUp, previewHalfH),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        4.5,
        existingPieces,
        candidates
      );
    }

    // --- CASE G: Stairs snapping to Stairs (2X2 or 2X1 to 2X2 or 2X1) ---
    else if (isTargetStairs && isPreviewStairs) {
      const targetHalfH = getStairsHalfHeight(targetPiece.type);
      const previewHalfH = getStairsHalfHeight(previewType);
      const stepY = targetHalfH + previewHalfH;

      // 1. Continuation UP (Next flight to next level!)
      const posUp = targetPiece.position.clone()
        .addScaledVector(targetForward, MODULE_SIZE)
        .addScaledVector(targetUp, stepY);
      const jointUp = targetPiece.position.clone()
        .addScaledVector(targetForward, HALF_SIZE)
        .addScaledVector(targetUp, targetHalfH);
      this.addCandidateIfFree(
        posUp,
        targetPiece.quaternion.clone(),
        jointUp,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.z > 0 || localHitPoint.y > 0) ? 5.2 : 1.2,
        existingPieces,
        candidates
      );

      // 2. Continuation DOWN (Extending flight downwards to lower level / ground)
      const posDown = targetPiece.position.clone()
        .addScaledVector(targetForward, -MODULE_SIZE)
        .addScaledVector(targetUp, -stepY);
      const jointDown = targetPiece.position.clone()
        .addScaledVector(targetForward, -HALF_SIZE)
        .addScaledVector(targetUp, -targetHalfH);
      this.addCandidateIfFree(
        posDown,
        targetPiece.quaternion.clone(),
        jointDown,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.z < 0 || localHitPoint.y < 0) ? 5.2 : 1.2,
        existingPieces,
        candidates
      );

      // 3. Side-by-side Right (Wider staircase)
      const posRight = targetPiece.position.clone().addScaledVector(targetRight, MODULE_SIZE);
      const jointRight = targetPiece.position.clone().addScaledVector(targetRight, HALF_SIZE);
      this.addCandidateIfFree(
        posRight,
        targetPiece.quaternion.clone(),
        jointRight,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.x > 0.2 ? 4.5 : 1.0,
        existingPieces,
        candidates
      );

      // 4. Side-by-side Left
      const posLeft = targetPiece.position.clone().addScaledVector(targetRight, -MODULE_SIZE);
      const jointLeft = targetPiece.position.clone().addScaledVector(targetRight, -HALF_SIZE);
      this.addCandidateIfFree(
        posLeft,
        targetPiece.quaternion.clone(),
        jointLeft,
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.x < -0.2 ? 4.5 : 1.0,
        existingPieces,
        candidates
      );
    }

    // --- CASE H: Floor <-> Stairs ---
    // Target is Floor, Preview is Stairs
    else if (isTargetFloor && isPreviewStairs) {
      const targetHalfSize = getFloorHalfSize(targetPiece.type);
      const previewHalfH = getStairsHalfHeight(previewType);
      const edges = [
        { dir: targetForward, name: 'North', yaw: 0 },
        { dir: targetForward.clone().negate(), name: 'South', yaw: Math.PI },
        { dir: targetRight, name: 'East', yaw: -Math.PI / 2 },
        { dir: targetRight.clone().negate(), name: 'West', yaw: Math.PI / 2 },
      ];

      for (const edge of edges) {
        const edgeQuat = targetPiece.quaternion.clone().multiply(
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), edge.yaw)
        );

        // Stairs going UP from floor edge (bottom step rests on floor level)
        const posUp = targetPiece.position.clone()
          .addScaledVector(edge.dir, targetHalfSize + HALF_SIZE)
          .addScaledVector(targetUp, previewHalfH);
        const jointUp = targetPiece.position.clone().addScaledVector(edge.dir, targetHalfSize);
        this.addCandidateIfFree(
          posUp,
          edgeQuat,
          jointUp,
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          localHitPoint.y >= 0 ? 4.2 : 1.5,
          existingPieces,
          candidates
        );

        // Stairs going DOWN from floor edge (top step flush with upper floor level)
        const posDown = targetPiece.position.clone()
          .addScaledVector(edge.dir, targetHalfSize + HALF_SIZE)
          .addScaledVector(targetUp, -previewHalfH);
        const jointDown = targetPiece.position.clone().addScaledVector(edge.dir, targetHalfSize);
        this.addCandidateIfFree(
          posDown,
          edgeQuat,
          jointDown,
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          localHitPoint.y < 0 ? 4.2 : 1.5,
          existingPieces,
          candidates
        );
      }
    }

    // Target is Stairs, Preview is Floor
    else if (isTargetStairs && isPreviewFloor) {
      const targetHalfH = getStairsHalfHeight(targetPiece.type);
      const previewHalfSize = getFloorHalfSize(previewType);

      // Landing at top of stairs (platform)
      const floorYTop = targetPiece.position.y + targetHalfH - FLOOR_THICKNESS / 2;
      const posTop = new THREE.Vector3(targetPiece.position.x, floorYTop, targetPiece.position.z)
        .addScaledVector(targetForward, HALF_SIZE + previewHalfSize);
      const rotTop = targetPiece.quaternion.clone().multiply(userYawQuat);
      this.addCandidateIfFree(
        posTop,
        rotTop,
        targetPiece.position.clone().addScaledVector(targetForward, HALF_SIZE).addScaledVector(targetUp, targetHalfH),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.z > 0 || localHitPoint.y > 0) ? 5.0 : 1.2,
        existingPieces,
        candidates
      );

      // Floor at bottom of stairs (ground / lower landing)
      const floorYBot = targetPiece.position.y - targetHalfH + FLOOR_THICKNESS / 2;
      const posBot = new THREE.Vector3(targetPiece.position.x, floorYBot, targetPiece.position.z)
        .addScaledVector(targetForward, -(HALF_SIZE + previewHalfSize));
      const rotBot = targetPiece.quaternion.clone().multiply(userYawQuat);
      this.addCandidateIfFree(
        posBot,
        rotBot,
        targetPiece.position.clone().addScaledVector(targetForward, -HALF_SIZE).addScaledVector(targetUp, -targetHalfH),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.z < 0 || localHitPoint.y < 0) ? 5.0 : 1.2,
        existingPieces,
        candidates
      );
    }

    // --- CASE I: Wall <-> Stairs ---
    else if (isTargetWall && isPreviewStairs) {
      // Stairs alongside wall on right
      const posRight = targetPiece.position.clone().addScaledVector(targetRight, HALF_SIZE);
      this.addCandidateIfFree(
        posRight,
        targetPiece.quaternion.clone().multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        3.5,
        existingPieces,
        candidates
      );

      // Stairs alongside wall on left
      const posLeft = targetPiece.position.clone().addScaledVector(targetRight, -HALF_SIZE);
      this.addCandidateIfFree(
        posLeft,
        targetPiece.quaternion.clone().multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        3.5,
        existingPieces,
        candidates
      );
    }

    // --- CASE J: Straight Railing on Floor edge (Balconies, Terraces, Verandas) ---
    if (isTargetFloor && isPreviewStraightRailing) {
      const targetHalfSize = getFloorHalfSize(targetPiece.type);
      const targetTopY = targetPiece.position.y + (BUILDING_PIECES[targetPiece.type]?.dimensions.y ?? FLOOR_THICKNESS) / 2.0;
      const railingHalfH = 0.95 / 2.0;
      const railingY = targetTopY + railingHalfH;
      const previewHalfW = getRailingHalfWidth(previewType);
      const isNarrowRailing = previewHalfW === 0.5;
      const offsets = targetHalfSize === 1.0 && isNarrowRailing ? [-0.5, 0.5] : [0];

      for (const offset of offsets) {
        // North edge (+Z)
        const posN = new THREE.Vector3(targetPiece.position.x, railingY, targetPiece.position.z)
          .addScaledVector(targetForward, targetHalfSize)
          .addScaledVector(targetRight, offset);
        const rotN = targetPiece.quaternion.clone().multiply(userYawQuat);
        this.addCandidateIfFree(
          posN,
          rotN,
          posN.clone().setY(targetPiece.position.y),
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          localHitPoint.z > 0.25 ? 4.5 : 1.5,
          existingPieces,
          candidates
        );

        // South edge (-Z)
        const posS = new THREE.Vector3(targetPiece.position.x, railingY, targetPiece.position.z)
          .addScaledVector(targetForward, -targetHalfSize)
          .addScaledVector(targetRight, offset);
        const rotS = targetPiece.quaternion.clone().multiply(userYawQuat);
        this.addCandidateIfFree(
          posS,
          rotS,
          posS.clone().setY(targetPiece.position.y),
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          localHitPoint.z < -0.25 ? 4.5 : 1.5,
          existingPieces,
          candidates
        );

        // East edge (+X) - rotated 90 degrees
        const rot90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
        const posE = new THREE.Vector3(targetPiece.position.x, railingY, targetPiece.position.z)
          .addScaledVector(targetRight, targetHalfSize)
          .addScaledVector(targetForward, offset);
        const rotE = targetPiece.quaternion.clone().multiply(rot90).multiply(userYawQuat);
        this.addCandidateIfFree(
          posE,
          rotE,
          posE.clone().setY(targetPiece.position.y),
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          localHitPoint.x > 0.25 ? 4.5 : 1.5,
          existingPieces,
          candidates
        );

        // West edge (-X) - rotated 90 degrees
        const posW = new THREE.Vector3(targetPiece.position.x, railingY, targetPiece.position.z)
          .addScaledVector(targetRight, -targetHalfSize)
          .addScaledVector(targetForward, offset);
        const rotW = targetPiece.quaternion.clone().multiply(rot90).multiply(userYawQuat);
        this.addCandidateIfFree(
          posW,
          rotW,
          posW.clone().setY(targetPiece.position.y),
          targetPiece,
          previewType,
          hitPoint,
          hitNormal,
          localHitPoint.x < -0.25 ? 4.5 : 1.5,
          existingPieces,
          candidates
        );
      }
    }

    // --- CASE K: Straight Railing to Straight Railing (End-to-End & 90° Corners) ---
    else if (isTargetStraightRailing && isPreviewStraightRailing) {
      const targetHalfW = getRailingHalfWidth(targetPiece.type);
      const previewHalfW = getRailingHalfWidth(previewType);
      const sideDist = targetHalfW + previewHalfW;

      // 1. Collinear extensions: Right side (X > 0)
      const posRight = targetPiece.position.clone().addScaledVector(targetRight, sideDist);
      this.addCandidateIfFree(
        posRight,
        targetPiece.quaternion.clone().multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.x > 0 ? 4.5 : 1.2,
        existingPieces,
        candidates
      );

      // 2. Collinear extensions: Left side (X < 0)
      const posLeft = targetPiece.position.clone().addScaledVector(targetRight, -sideDist);
      this.addCandidateIfFree(
        posLeft,
        targetPiece.quaternion.clone().multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.x < 0 ? 4.5 : 1.2,
        existingPieces,
        candidates
      );

      // 3. 90-degree Corner Turns:
      const rot90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

      const posCornerR1 = targetPiece.position.clone()
        .addScaledVector(targetRight, targetHalfW)
        .addScaledVector(targetForward, previewHalfW);
      this.addCandidateIfFree(
        posCornerR1,
        targetPiece.quaternion.clone().multiply(rot90).multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.x > 0.25 && localHitPoint.z > 0) ? 4.0 : 1.0,
        existingPieces,
        candidates
      );

      const posCornerR2 = targetPiece.position.clone()
        .addScaledVector(targetRight, targetHalfW)
        .addScaledVector(targetForward, -previewHalfW);
      this.addCandidateIfFree(
        posCornerR2,
        targetPiece.quaternion.clone().multiply(rot90).multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.x > 0.25 && localHitPoint.z < 0) ? 4.0 : 1.0,
        existingPieces,
        candidates
      );

      const posCornerL1 = targetPiece.position.clone()
        .addScaledVector(targetRight, -targetHalfW)
        .addScaledVector(targetForward, previewHalfW);
      this.addCandidateIfFree(
        posCornerL1,
        targetPiece.quaternion.clone().multiply(rot90).multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.x < -0.25 && localHitPoint.z > 0) ? 4.0 : 1.0,
        existingPieces,
        candidates
      );

      const posCornerL2 = targetPiece.position.clone()
        .addScaledVector(targetRight, -targetHalfW)
        .addScaledVector(targetForward, -previewHalfW);
      this.addCandidateIfFree(
        posCornerL2,
        targetPiece.quaternion.clone().multiply(rot90).multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        (localHitPoint.x < -0.25 && localHitPoint.z < 0) ? 4.0 : 1.0,
        existingPieces,
        candidates
      );
    }

    // --- CASE L: Floor snapping back to Straight Railing ---
    else if (isTargetStraightRailing && isPreviewFloor) {
      const previewHalfSize = getFloorHalfSize(previewType);
      const floorY = targetPiece.position.y - 0.475 - (BUILDING_PIECES[previewType]?.dimensions.y ?? FLOOR_THICKNESS) / 2.0;

      const posBack = targetPiece.position.clone().setY(floorY).addScaledVector(targetForward, -previewHalfSize);
      this.addCandidateIfFree(
        posBack,
        targetPiece.quaternion.clone().multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.z < 0 ? 4.0 : 1.2,
        existingPieces,
        candidates
      );

      const posFront = targetPiece.position.clone().setY(floorY).addScaledVector(targetForward, previewHalfSize);
      this.addCandidateIfFree(
        posFront,
        targetPiece.quaternion.clone().multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.z > 0 ? 4.0 : 1.2,
        existingPieces,
        candidates
      );
    }

    // --- CASE M: Stair Railing snapping to Stairs side_left / side_right ---
    else if (isTargetStairs && isPreviewStairRailing) {
      // side_left socket of stairs (x = -HALF_SIZE = -1.0)
      const posLeft = targetPiece.position.clone().addScaledVector(targetRight, -HALF_SIZE);
      this.addCandidateIfFree(
        posLeft,
        targetPiece.quaternion.clone().multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.x < 0 ? 5.5 : 1.5,
        existingPieces,
        candidates
      );

      // side_right socket of stairs (x = +HALF_SIZE = +1.0)
      const posRight = targetPiece.position.clone().addScaledVector(targetRight, HALF_SIZE);
      this.addCandidateIfFree(
        posRight,
        targetPiece.quaternion.clone().multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.x > 0 ? 5.5 : 1.5,
        existingPieces,
        candidates
      );
    }

    // --- CASE N: Stairs snapping to existing Stair Railing ---
    else if (isTargetStairRailing && isPreviewStairs) {
      const posRight = targetPiece.position.clone().addScaledVector(targetRight, HALF_SIZE);
      this.addCandidateIfFree(
        posRight,
        targetPiece.quaternion.clone().multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.x > 0 ? 5.0 : 1.5,
        existingPieces,
        candidates
      );

      const posLeft = targetPiece.position.clone().addScaledVector(targetRight, -HALF_SIZE);
      this.addCandidateIfFree(
        posLeft,
        targetPiece.quaternion.clone().multiply(userYawQuat),
        targetPiece.position.clone(),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        localHitPoint.x < 0 ? 5.0 : 1.5,
        existingPieces,
        candidates
      );
    }

    // --- CASE F: General Socket Fallback (Pillars, Stairs, Roofs, etc.) ---
    if (!isWindowOrDoorPiece(previewType) && !isWindowOrDoorPiece(targetPiece.type)) {
      const targetDef = BUILDING_PIECES[targetPiece.type];
      if (targetDef && targetDef.sockets) {
        for (const targetSocket of targetDef.sockets) {
          const targetWorldPos = targetSocket.localPosition
            .clone()
            .applyQuaternion(targetPiece.quaternion)
            .add(targetPiece.position);

          const distToSocket = targetWorldPos.distanceTo(hitPoint);
          if (distToSocket > SnapSystem.SNAP_RADIUS) continue;

          for (const sourceSocket of previewDef.sockets) {
            if (!targetSocket.compatibleWith.includes(sourceSocket.type)) continue;

          // Align complementary sockets
          const targetWorldNormal = targetSocket.localNormal.clone().applyQuaternion(targetPiece.quaternion);
          const forwardFromTarget = targetWorldNormal.clone().negate();

          const snappedQuat = new THREE.Quaternion();
          const sourceNorm = sourceSocket.localNormal.clone().normalize();

          if (sourceNorm.lengthSq() > 0.001) {
            const rotationAxis = new THREE.Vector3().crossVectors(sourceNorm, forwardFromTarget);
            const dot = THREE.MathUtils.clamp(sourceNorm.dot(forwardFromTarget), -1, 1);
            if (rotationAxis.lengthSq() > 0.0001) {
              rotationAxis.normalize();
              snappedQuat.setFromAxisAngle(rotationAxis, Math.acos(dot));
            } else if (dot < -0.999) {
              snappedQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
            }
          } else {
            snappedQuat.copy(targetPiece.quaternion);
          }

          if (manualYaw !== 0) {
            snappedQuat.multiply(userYawQuat);
          }

          const sourceOffsetWorld = sourceSocket.localPosition.clone().applyQuaternion(snappedQuat);
          const candidatePos = targetWorldPos.clone().sub(sourceOffsetWorld);

          this.addCandidateIfFree(
            candidatePos,
            snappedQuat,
            targetWorldPos,
            targetPiece,
            previewType,
            hitPoint,
            hitNormal,
            1.5,
            existingPieces,
            candidates,
            targetSocket,
            sourceSocket
          );
        }
      }
    }
  }
}

  /**
   * Evaluates a candidate position. If not already occupied, scores it based on proximity
   * to hit point and surface normal alignment, and pushes to candidates list.
   */
  private addCandidateIfFree(
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
    jointPos: THREE.Vector3,
    targetPiece: BuiltPiece,
    previewType: BuildingPieceType,
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3,
    priorityMultiplier: number,
    existingPieces: BuiltPiece[],
    candidates: CandidatePlacement[],
    targetSocket: SnapSocket | null = null,
    sourceSocket: SnapSocket | null = null,
    wallGridInfo: WallGridInfo | null = null
  ): void {
    // 0. Platform Surface Check: must NOT be placed below the construction platform surface!
    if (isPieceBelowSurface(previewType, pos, quat)) {
      return;
    }

    // 1. Strict Occupancy Check: must NOT be placed on or inside an existing piece!
    if (this.isPositionOccupied(pos, previewType, existingPieces, quat)) {
      return;
    }

    // 2. Proximity to ray hit point
    const distToHit = jointPos.distanceTo(hitPoint);
    if (distToHit > SnapSystem.SNAP_RADIUS + 1.0) {
      return;
    }

    // 3. Directional Alignment with Hit Normal
    const dirFromTarget = pos.clone().sub(targetPiece.position).normalize();
    const normalDot = dirFromTarget.dot(hitNormal);
    const normalBonus = normalDot > 0.3 ? 3.0 * normalDot : 0.0;

    // 4. Calculate final score
    const proximityScore = Math.max(0, SnapSystem.SNAP_RADIUS + 1.0 - distToHit);
    const score = (proximityScore * 1.5 + normalBonus) * priorityMultiplier;

    candidates.push({
      position: pos,
      quaternion: quat,
      jointPosition: jointPos,
      targetPieceId: targetPiece.id,
      targetSocket,
      sourceSocket,
      score,
      wallGridInfo,
    });
  }

  /**
   * Verifies whether a candidate position is already occupied by an existing piece.
   * Prevents duplicate overlapping walls, floors, or roof slabs, while properly
   * distinguishing perpendicular corner walls and adjoining edges.
   */
  public isPositionOccupied(
    pos: THREE.Vector3,
    previewType: BuildingPieceType,
    existingPieces: BuiltPiece[],
    previewQuat?: THREE.Quaternion
  ): boolean {
    const isPreviewWall = this.isWall(previewType);
    const isPreviewFloor = this.isFloor(previewType);
    const isPreviewStairs = previewType === BuildingPieceType.WOOD_STAIRS_2X2;
    const isPreviewRoof = this.isRoof(previewType);
    const prevHalfSize = isPreviewFloor ? getFloorHalfSize(previewType) : 1.0;
    const prevHalfW = isPreviewWall ? getWallHalfWidth(previewType) : 1.0;
    const prevHalfH = isPreviewWall ? getWallHalfHeight(previewType) : 1.0;

    const pQuat = previewQuat || new THREE.Quaternion();
    const prevRight = new THREE.Vector3(1, 0, 0).applyQuaternion(pQuat);

    for (let i = 0; i < existingPieces.length; i++) {
      const piece = existingPieces[i];
      const p = piece.position;
      const dx = Math.abs(p.x - pos.x);
      const dz = Math.abs(p.z - pos.z);
      const dy = Math.abs(p.y - pos.y);

      // Fast rejection bounding sphere (3.0m)
      if (dx > 3.0 || dz > 3.0 || dy > 3.0) continue;

      // 0. Window / Door / Doorway placement check
      if (isWindowOrDoorPiece(previewType)) {
        if (isWindowOrDoorPiece(piece.type)) {
          const pieceHalfW = getWallHalfWidth(piece.type);
          const prevHalfW = getWallHalfWidth(previewType);
          const pieceHalfH = getWallHalfHeight(piece.type);
          const prevHalfH = getWallHalfHeight(previewType);

          const delta = pos.clone().sub(p);
          const pieceRight = new THREE.Vector3(1, 0, 0).applyQuaternion(piece.quaternion);
          const pieceForward = new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion);
          const localX = Math.abs(delta.dot(pieceRight));
          const localZ = Math.abs(delta.dot(pieceForward));

          if (localZ < 0.25 && localX < (pieceHalfW + prevHalfW - 0.15) && dy < (pieceHalfH + prevHalfH - 0.15)) {
            return true; // Occupied by another window/door
          }
        }
        // Placing a window/door directly on a solid wall is ALLOWED (it cuts a hole)
        if (isSolidWallPiece(piece.type)) {
          continue;
        }
      }

      // Solid wall vs opening: solid wall is allowed to overlap opening piece
      if (isSolidWallPiece(previewType) && isWindowOrDoorPiece(piece.type)) {
        continue;
      }

      // 1. Floor vs Floor overlap check (handles 1x1 inside 2x2 and same-size overlaps)
      if (isPreviewFloor && this.isFloor(piece.type)) {
        if (dy < 0.35) {
          const pieceHalfSize = getFloorHalfSize(piece.type);
          // Overlap along both X and Z axes
          if (dx < (pieceHalfSize + prevHalfSize - 0.08) && dz < (pieceHalfSize + prevHalfSize - 0.08)) {
            return true;
          }
        }
        continue;
      }

      // 2. Wall vs Wall overlap check (distinguishes parallel walls from perpendicular corner/T-junction walls)
      if (isPreviewWall && this.isWall(piece.type)) {
        const pieceHalfH = getWallHalfHeight(piece.type);
        if (dy < (pieceHalfH + prevHalfH - 0.2)) {
          const pieceHalfW = getWallHalfWidth(piece.type);
          const pieceRight = new THREE.Vector3(1, 0, 0).applyQuaternion(piece.quaternion);
          const pieceForward = new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion);

          // Vector from existing piece center to preview center
          const delta = pos.clone().sub(p);
          const localX = Math.abs(delta.dot(pieceRight));
          const localZ = Math.abs(delta.dot(pieceForward));

          // Alignment between wall vectors
          const parallelism = Math.abs(pieceRight.dot(prevRight));

          if (parallelism > 0.707) {
            // Parallel or collinear walls:
            // Collide only if they share the same plane and overlap along their length
            if (localZ < 0.25 && localX < (pieceHalfW + prevHalfW - 0.15)) {
              return true;
            }
          } else {
            // Perpendicular walls (e.g. 90° corner or T-junction):
            // They meet cleanly at corners or edges. They only collide if preview deeply intersects existing wall interior.
            const isCrossingInterior = localX < (pieceHalfW - 0.25) && localZ < (prevHalfW - 0.25);
            if (isCrossingInterior) {
              return true;
            }
          }
        }
        continue;
      }

      // 3. Roof vs Roof overlap check
      if (isPreviewRoof && this.isRoof(piece.type)) {
        if (dy < 0.45) {
          const pDims = getRoofDimensions(previewType);
          const tDims = getRoofDimensions(piece.type);
          if (dx < (pDims.width + tDims.width) / 4.0 && dz < (pDims.length + tDims.length) / 4.0) {
            return true;
          }
        }
        continue;
      }

      // 4. Straight Railing vs Straight Railing overlap check
      if (this.isStraightRailing(previewType) && this.isStraightRailing(piece.type)) {
        if (dy < 0.35) {
          const pieceHalfW = getRailingHalfWidth(piece.type);
          const prevHalfW = getRailingHalfWidth(previewType);
          const pieceRight = new THREE.Vector3(1, 0, 0).applyQuaternion(piece.quaternion);
          const delta = pos.clone().sub(p);
          const localX = Math.abs(delta.dot(pieceRight));
          const localZ = Math.abs(delta.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion)));
          const parallelism = Math.abs(pieceRight.dot(prevRight));
          if (parallelism > 0.707) {
            if (localZ < 0.20 && localX < (pieceHalfW + prevHalfW - 0.15)) {
              return true;
            }
          }
        }
        continue;
      }

      // 4. Exact matching piece overlap
      if (piece.type === previewType) {
        if (dx < 0.3 && dz < 0.3 && dy < 0.3) return true;
      }

      // 4. Overlapping stairs
      if (isPreviewStairs && this.isStairs(piece.type)) {
        if (dx < 0.8 && dz < 0.8 && dy < 0.4) return true;
      }

      // 5. Overlapping roofs
      if (isPreviewRoof && this.isRoof(piece.type)) {
        if (dx < 0.8 && dz < 0.8 && dy < 0.8) return true;
      }

      // 6. Generic center collision (< 0.25m)
      if (dx * dx + dy * dy + dz * dz < 0.04) return true;
    }
    return false;
  }

  public isOpeningSupportedBySolidWalls(
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
    previewType: BuildingPieceType,
    existingPieces: BuiltPiece[]
  ): boolean {
    const previewW = getWallHalfWidth(previewType) * 2;
    const previewH = getWallHalfHeight(previewType) * 2;
    const previewRight = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
    const previewUp = new THREE.Vector3(0, 1, 0);

    const numCols = Math.max(1, Math.round(previewW / 0.5));
    const numRows = Math.max(1, Math.round(previewH / 0.5));

    for (let r = 0; r < numRows; r++) {
      const sy = -previewH / 2 + (r + 0.5) * (previewH / numRows);
      for (let c = 0; c < numCols; c++) {
        const sx = -previewW / 2 + (c + 0.5) * (previewW / numCols);
        const pt = pos.clone().addScaledVector(previewRight, sx).addScaledVector(previewUp, sy);

        let cellSupported = false;
        for (const wall of existingPieces) {
          if (!isSolidWallPiece(wall.type)) continue;
          const dy = Math.abs(pt.y - wall.position.y);
          const wHalfH = getWallHalfHeight(wall.type);
          if (dy > wHalfH + 0.08) continue;

          const wallNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(wall.quaternion);
          const dNorm = Math.abs(pt.clone().sub(wall.position).dot(wallNormal));
          if (dNorm > 0.25) continue;

          const wallRight = new THREE.Vector3(1, 0, 0).applyQuaternion(wall.quaternion);
          const lx = pt.clone().sub(wall.position).dot(wallRight);
          const wHalfW = getWallHalfWidth(wall.type);

          if (Math.abs(lx) <= wHalfW + 0.08) {
            cellSupported = true;
            break;
          }
        }

        if (!cellSupported) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Furniture placement: sits on the aimed surface, snaps to a 25cm grid and quarter turns while
   * snapping is on (V toggles free placement), and must not overlap walls or other furniture.
   */
  private evaluateFurniturePlacement(
    pieceType: BuildingPieceType,
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3,
    manualYaw: number,
    snappingEnabled: boolean,
    existingPieces: BuiltPiece[],
    playerPos: THREE.Vector3
  ): SnapResult {
    const size = getPieceMeshTemplate(pieceType).boundingBox.getSize(new THREE.Vector3());
    const quarter = Math.PI / 2;
    const yaw = snappingEnabled ? Math.round(manualYaw / quarter) * quarter : manualYaw;
    const rotation = new THREE.Euler(0, yaw, 0, 'YXZ');
    const quaternion = new THREE.Quaternion().setFromEuler(rotation);

    const position = hitPoint.clone();
    if (snappingEnabled) {
      position.x = Math.round(position.x / FURNITURE_GRID_STEP) * FURNITURE_GRID_STEP;
      position.z = Math.round(position.z / FURNITURE_GRID_STEP) * FURNITURE_GRID_STEP;
    }
    const hanging = isCeilingFurniture(pieceType);
    position.y = hanging ? hitPoint.y - size.y / 2 : hitPoint.y + size.y / 2;

    // World footprint of the rotated piece
    const c = Math.abs(Math.cos(yaw));
    const s = Math.abs(Math.sin(yaw));
    const halfX = (size.x * c + size.z * s) / 2;
    const halfZ = (size.x * s + size.z * c) / 2;
    const footprint = new THREE.Box3(
      new THREE.Vector3(position.x - halfX, position.y - size.y / 2, position.z - halfZ),
      new THREE.Vector3(position.x + halfX, position.y + size.y / 2, position.z + halfZ)
    ).expandByScalar(-0.02); // touching neighbours / standing on a surface is fine

    // Supports and roofs never block (roof bounds cover the whole attic volume)
    const blockers = existingPieces.filter(
      (piece) =>
        piece.worldBoundingBox &&
        !this.isFloor(piece.type) &&
        !this.isRoof(piece.type) &&
        piece.type !== BuildingPieceType.STONE_FOUNDATION_2X2 &&
        piece.position.distanceToSquared(position) < 36
    );
    const findOverlap = () => blockers.find((piece) => piece.worldBoundingBox!.intersectsBox(footprint));

    // Heartopia-style: aiming close to a wall slides the piece flush against it instead of failing
    if (snappingEnabled) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const hit = findOverlap();
        if (!hit || !this.isWall(hit.type)) break;
        const wb = hit.worldBoundingBox!;
        const pushPosX = wb.max.x - footprint.min.x;
        const pushNegX = footprint.max.x - wb.min.x;
        const pushPosZ = wb.max.z - footprint.min.z;
        const pushNegZ = footprint.max.z - wb.min.z;
        const options = [
          { x: pushPosX, z: 0, len: pushPosX },
          { x: -pushNegX, z: 0, len: pushNegX },
          { x: 0, z: pushPosZ, len: pushPosZ },
          { x: 0, z: -pushNegZ, len: pushNegZ },
        ].filter((o) => o.len > 0);
        options.sort((a, b) => a.len - b.len);
        const push = options[0];
        if (!push || push.len > 0.6) break;
        position.x += push.x;
        position.z += push.z;
        footprint.translate(new THREE.Vector3(push.x, 0, push.z));
      }
    }
    const overlapping = !!findOverlap();

    const dxPlayer = Math.max(Math.abs(playerPos.x - position.x) - halfX, 0);
    const dzPlayer = Math.max(Math.abs(playerPos.z - position.z) - halfZ, 0);
    const playerInside = Math.hypot(dxPlayer, dzPlayer) < 0.3 && Math.abs(playerPos.y - position.y) < size.y / 2 + 0.9;
    const isFlatSurface = hanging ? hitNormal.y < -0.7 : hitNormal.y > 0.7;
    const isWithinRange = position.distanceTo(playerPos) <= SnapSystem.MAX_PLACEMENT_DISTANCE;
    const isBelowSurface = position.y - size.y / 2 < BUILDING_CONFIG.GROUND_SURFACE_Y + BUILDING_CONFIG.MIN_SURFACE_TOLERANCE;

    let reason: string | undefined;
    if (!isFlatSurface) reason = hanging ? 'Hang it from a ceiling' : 'Furniture must stand on a flat surface';
    else if (overlapping) reason = 'Overlaps a wall or other furniture';
    else if (playerInside) reason = 'Too close to player character';
    else if (!isWithinRange) reason = 'Too far away (max 15m)';
    else if (isBelowSurface) reason = 'Cannot place elements below the surface';

    return {
      isSnapped: snappingEnabled,
      snappedPosition: position,
      snappedRotation: rotation,
      snappedQuaternion: quaternion,
      targetPieceId: null,
      targetSocket: null,
      sourceSocket: null,
      isValidPlacement: reason === undefined,
      validationReason: reason,
    };
  }

  public isStairs(type: BuildingPieceType): boolean {
    return (
      type === BuildingPieceType.WOOD_STAIRS_2X2 ||
      type === BuildingPieceType.WOOD_STAIRS_2X1 ||
      type === BuildingPieceType.WOOD_STAIRS_2X3
    );
  }

  public isWall(type: BuildingPieceType): boolean {
    return (
      type === BuildingPieceType.WOOD_WALL_2X3 ||
      type === BuildingPieceType.WOOD_WALL_1X3 ||
      type === BuildingPieceType.WOOD_WALL_1X2 ||
      type === BuildingPieceType.WOOD_WALL_2X1 ||
      type === BuildingPieceType.WOOD_WALL_1X1 ||
      type === BuildingPieceType.WOOD_WALL_WINDOW_1X2 ||
      type === BuildingPieceType.WOOD_WALL_WINDOW_1X1_5 ||
      type === BuildingPieceType.WOOD_WALL_WINDOW_2X2 ||
      type === BuildingPieceType.WOOD_WALL_WINDOW_2X4 ||
      type === BuildingPieceType.WOOD_WALL_DOORWAY_2X2 ||
      type === BuildingPieceType.WOOD_WALL_DOORWAY_1X2 ||
      isGlassWallPiece(type)
    );
  }

  public isRoof(type: BuildingPieceType): boolean {
    return (
      isGlassRoofPiece(type) ||
      type === BuildingPieceType.WOOD_ROOF_26 ||
      type === BuildingPieceType.ROOF_GABLE_2X2 ||
      type === BuildingPieceType.ROOF_GABLE_2X4 ||
      type === BuildingPieceType.ROOF_GABLE_4X4 ||
      type === BuildingPieceType.ROOF_HIP_2X2 ||
      type === BuildingPieceType.ROOF_HIP_2X4 ||
      type === BuildingPieceType.ROOF_HIP_4X4 ||
      type === BuildingPieceType.ROOF_SHED_2X2 ||
      type === BuildingPieceType.ROOF_SHED_2X4 ||
      type === BuildingPieceType.ROOF_SHED_4X4
    );
  }

  public isFloor(type: BuildingPieceType): boolean {
    return (
      type === BuildingPieceType.WOOD_FLOOR_2X2 ||
      type === BuildingPieceType.WOOD_FLOOR_1X1 ||
      type === BuildingPieceType.STONE_FOUNDATION_2X2
    );
  }

  public getGridSnapStep(type: BuildingPieceType): number {
    if (isWindowOrDoorPiece(type)) {
      return SnapSystem.WINDOW_DOOR_GRID_SNAP_STEP;
    }
    return SnapSystem.GRID_SNAP_STEP;
  }

  public isStraightRailing(type: BuildingPieceType): boolean {
    return (
      type === BuildingPieceType.WOOD_RAILING_2M ||
      type === BuildingPieceType.WOOD_RAILING_1M ||
      type === BuildingPieceType.WHITE_DECORATIVE_FENCE_1M
    );
  }

  public isStairRailing(type: BuildingPieceType): boolean {
    return type === BuildingPieceType.WOOD_STAIR_RAILING_2X2;
  }

  public isRailing(type: BuildingPieceType): boolean {
    return this.isStraightRailing(type) || this.isStairRailing(type);
  }

  private createDefaultResult(): SnapResult {
    return {
      isSnapped: false,
      snappedPosition: new THREE.Vector3(),
      snappedRotation: new THREE.Euler(),
      snappedQuaternion: new THREE.Quaternion(),
      targetPieceId: null,
      targetSocket: null,
      sourceSocket: null,
      isValidPlacement: false,
      validationReason: 'Invalid piece definition',
    };
  }
}
