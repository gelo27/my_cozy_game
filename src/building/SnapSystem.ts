import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BuildingPieceType, BuiltPiece, SnapResult, SnapSocket, SocketType, WallGridInfo, isWindowPiece, isDoorPiece, isDoorwayPiece, isWindowOrDoorPiece, isSolidWallPiece, isGlassWallPiece, isGlassRoofPiece, shapeOf, getWallHalfWidth, getWallHalfHeight, pieceTraits } from './types/BuildingTypes';
import { BUILDING_PIECES, FLOOR_THICKNESS, HALF_SIZE, MODULE_SIZE, WALL_THICKNESS, isPieceBelowSurface, getPieceMeshTemplate } from './config/BuildingPiecesConfig';
import { FURNITURE_GRID_STEP, isCeilingFurniture, isFurniturePiece } from './furniture/FurnitureCatalog';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { COLLISION_GROUPS, BUILDING_CONFIG } from '../config/constants';

import { CandidatePlacement, getFloorHalfSize, getStairsHalfHeight, getRailingHalfWidth, getRoofDimensions, getPlacedRoofExtent } from './SnapShapes';
import { generateCandidatesForPair } from './SnapCandidates';

export { getRoofDimensions } from './SnapShapes';

export class SnapSystem {
  public static readonly GRID_SNAP_STEP = 1.0; // Standard 1.0m modular grid step for walls & floors
  public static readonly WINDOW_DOOR_GRID_SNAP_STEP = 0.5; // 0.5m grid step for windows, doors, and wall openings
  private static readonly MAX_BUILD_DISTANCE = 25.0;
  private static readonly MAX_PLACEMENT_DISTANCE = 15.0;
  public static readonly SNAP_RADIUS = 2.8;
  private static readonly PLAYER_COLLISION_RADIUS = 0.65;
  private static readonly OCCUPANCY_THRESHOLD = 0.60;
  /**
   * Every snap, support and overlap check looks only at pieces this close to the aimed point:
   * snap candidates sit within SNAP_RADIUS, and the largest standard piece is 4x4 m.
   */
  private static readonly NEARBY_QUERY_RADIUS = 12.0;

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
    playerCollider?: RAPIER.Collider,
    /** Spatial query for pieces near a point; without it every piece in `existingPieces` is checked */
    queryNearby?: (center: THREE.Vector3, radius: number) => BuiltPiece[]
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
        validationReason: 'build.why.noSurface',
      };
    }

    let hitPoint = rayHit.point.clone();
    let hitNormal = new THREE.Vector3(0, 1, 0).copy(rayHit.normal);
    let hitPieceDirect: BuiltPiece | null = null;

    // From here on only pieces around the aimed point matter
    if (queryNearby) {
      existingPieces = queryNearby(hitPoint, SnapSystem.NEARBY_QUERY_RADIUS);
    }

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
        generateCandidatesForPair(this, 
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
        if (!isClearOfPlayer) reason = 'build.why.tooClose';
        else if (!isWithinRange) reason = 'build.why.tooFar';
        else if (isBelowSurface) reason = 'build.why.belowSurface';
        else if (!isSupported) reason = 'build.why.needWall';

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
        // The wall whose plane the aimed point lies on (within its width), not just any wall nearby
        let bestDist = 0.6;
        for (const piece of existingPieces) {
          if (!isSolidWallPiece(piece.type)) continue;
          const local = hitPoint.clone().sub(piece.position).applyQuaternion(piece.quaternion.clone().invert());
          if (Math.abs(local.x) > getWallHalfWidth(piece.type) + 0.3) continue;
          if (Math.abs(local.y) > getWallHalfHeight(piece.type) + 0.3) continue;
          if (Math.abs(local.z) < bestDist) {
            bestDist = Math.abs(local.z);
            targetWall = piece;
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
        if (!isClearOfPlayer) reason = 'build.why.tooClose';
        else if (!isWithinRange) reason = 'build.why.tooFar';
        else if (isBelowSurface) reason = 'build.why.belowSurface';
        else if (!isSupported) reason = 'build.why.needWall';

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
        if (!isClearOfPlayer) reason = 'build.why.tooClose';
        else if (!isWithinRange) reason = 'build.why.tooFar';
        else if (isOccupied) reason = 'build.why.occupied';
        else if (isBelowSurface) reason = 'build.why.belowSurface';

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
    if (!isClearOfPlayer) reason = 'build.why.tooClose';
    else if (!isWithinRange) reason = 'build.why.tooFar';
    else if (isOccupied) reason = 'build.why.occupied';
    else if (isBelowSurface) reason = 'build.why.belowSurface';

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
   * Evaluates a candidate position. If not already occupied, scores it based on proximity
   * to hit point and surface normal alignment, and pushes to candidates list.
   */
  /** @internal used by SnapCandidates */
  public addCandidateIfFree(
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

      // Roof vs roof: compare footprints in the placed roof's frame (it may be resized and off-centre)
      if (isPreviewRoof && this.isRoof(piece.type)) {
        if (dy < 0.45 && this.roofsOverlap(pos, previewType, pQuat, piece)) return true;
        continue;
      }

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

      // 6. Generic center collision (< 0.25m)
      if (dx * dx + dy * dy + dz * dz < 0.04) return true;
    }
    return false;
  }

  /** Whether a new roof at `pos` would cover part of a placed one (touching edges is fine) */
  private roofsOverlap(pos: THREE.Vector3, previewType: BuildingPieceType, previewQuat: THREE.Quaternion, placed: BuiltPiece): boolean {
    const t = getPlacedRoofExtent(placed);
    const p = getRoofDimensions(previewType);
    const inv = placed.quaternion.clone().invert();
    const local = pos.clone().sub(placed.position).applyQuaternion(inv);
    const previewRight = new THREE.Vector3(1, 0, 0).applyQuaternion(previewQuat).applyQuaternion(inv);
    const turned = Math.abs(previewRight.x) < 0.707;
    const pW = turned ? p.length : p.width;
    const pL = turned ? p.width : p.length;
    const MARGIN = 0.1;
    return Math.abs(local.x - t.cx) < (pW + t.width) / 2 - MARGIN && Math.abs(local.z - t.cz) < (pL + t.length) / 2 - MARGIN;
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
    if (!isFlatSurface) reason = hanging ? 'build.why.needCeiling' : 'build.why.needFlat';
    else if (overlapping) reason = 'build.why.overlaps';
    else if (playerInside) reason = 'build.why.tooClose';
    else if (!isWithinRange) reason = 'build.why.tooFar';
    else if (isBelowSurface) reason = 'build.why.belowSurface';

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
    return pieceTraits(type).kind === 'stairs';
  }

  /** Wall panels and wall openings that carry their own wall (not wooden doors, which sit in one) */
  public isWall(type: BuildingPieceType): boolean {
    const kind = pieceTraits(type).kind;
    return kind === 'wall' || kind === 'window' || kind === 'doorway' || isGlassWallPiece(type);
  }

  public isRoof(type: BuildingPieceType): boolean {
    return pieceTraits(type).kind === 'roof';
  }

  /** Floors and foundations */
  public isFloor(type: BuildingPieceType): boolean {
    const kind = pieceTraits(type).kind;
    return kind === 'floor' || kind === 'foundation';
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
      validationReason: 'build.why.invalid',
    };
  }
}
