import * as THREE from 'three';
import { BuildingPieceType, BuiltPiece, WallGridInfo, isWindowOrDoorPiece, isSolidWallPiece, getWallHalfWidth, getWallHalfHeight } from './types/BuildingTypes';
import { BUILDING_PIECES, FLOOR_THICKNESS, HALF_SIZE, MODULE_SIZE, WALL_THICKNESS } from './config/BuildingPiecesConfig';
import { BUILDING_CONFIG } from '../config/constants';
import { CandidatePlacement, getFloorHalfSize, getStairsHalfHeight, getRailingHalfWidth, getRoofDimensions, getPlacedRoofExtent } from './SnapShapes';
import { SnapSystem } from './SnapSystem';

/** How far (m) the aimed point may be off a wall's centre plane for an opening to go in that wall */
const OPENING_PLANE_TOLERANCE = 0.6;
/** How far (m) past the ends of a wall run the aimed point may be */
const OPENING_RUN_TOLERANCE = 0.3;
/** Openings are scored by distance only: the side-of-target bonus means nothing for them */
const NO_NORMAL_BONUS = new THREE.Vector3();

/**
 * Generates candidate snap placements around a target piece based on surface normal,
 * local hit coordinates, and socket compatibility.
 */
export function generateCandidatesForPair(
  snap: SnapSystem,
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

  const isTargetWall = snap.isWall(targetPiece.type);
  const isPreviewWall = snap.isWall(previewType);
  const isTargetFloor = snap.isFloor(targetPiece.type);
  const isPreviewFloor = snap.isFloor(previewType);
  const isTargetRoof = snap.isRoof(targetPiece.type);
  const isPreviewRoof = snap.isRoof(previewType);
  const isTargetStairs = snap.isStairs(targetPiece.type);
  const isPreviewStairs = snap.isStairs(previewType);
  const isPreviewStraightRailing = snap.isStraightRailing(previewType);
  const isTargetStraightRailing = snap.isStraightRailing(targetPiece.type);
  const isPreviewStairRailing = snap.isStairRailing(previewType);
  const isTargetStairRailing = snap.isStairRailing(targetPiece.type);

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

    // Only the wall actually aimed at: the hit must lie on this wall's plane and within its run.
    // Without this a perpendicular wall at a corner (or one behind) projected the hit onto its own
    // line and won, turning the opening its way and moving it where nobody aimed.
    const planeDist = Math.abs(localHitPoint.z);
    if (planeDist > OPENING_PLANE_TOLERANCE) return;
    const rawHitX = hitPoint.clone().sub(targetPiece.position).dot(targetRight);
    if (rawHitX < minGridX - OPENING_RUN_TOLERANCE || rawHitX > maxGridX + OPENING_RUN_TOLERANCE) return;

    // Horizontal snapping across the continuous wall face (0.5m sub-step for windows/doors),
    // kept inside the wall run
    let snappedLocalX = Math.round(rawHitX / step) * step;
    const minX = minGridX + previewHalfW;
    const maxX = maxGridX - previewHalfW;
    snappedLocalX = minX <= maxX ? THREE.MathUtils.clamp(snappedLocalX, minX, maxX) : (minGridX + maxGridX) / 2;

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

    // Scored by how far the hit is from this wall's plane, and whether the face hit is this
    // wall's front or back (not its end or top, which is how a perpendicular wall gets hit)
    const onPlane = hitPoint.clone().addScaledVector(targetForward, -localHitPoint.z);
    const facesWall = Math.abs(localHitNormal.z) >= 0.5;
    snap.addCandidateIfFree(
      candidatePos,
      candidateQuat,
      onPlane,
      targetPiece,
      previewType,
      hitPoint,
      NO_NORMAL_BONUS,
      facesWall ? 9.0 : 3.0, // High priority so it magnetically attaches to the wall surface
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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

        snap.addCandidateIfFree(
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
      snap.addCandidateIfFree(
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
      snap.addCandidateIfFree(
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
      snap.addCandidateIfFree(
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
      snap.addCandidateIfFree(
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
      snap.addCandidateIfFree(
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
      snap.addCandidateIfFree(
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
      snap.addCandidateIfFree(
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
      snap.addCandidateIfFree(
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
        snap.addCandidateIfFree(
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
        snap.addCandidateIfFree(
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

        snap.addCandidateIfFree(
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

        snap.addCandidateIfFree(
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

  // --- CASE E: Roof snapping to Roof (against the target's real, possibly resized, footprint) ---
  else if (isTargetRoof && isPreviewRoof) {
    const t = getPlacedRoofExtent(targetPiece);
    const pDims = getRoofDimensions(previewType);
    const rotSame = targetPiece.quaternion.clone().multiply(userYawQuat);
    const centre = targetPiece.position.clone().addScaledVector(targetRight, t.cx).addScaledVector(targetForward, t.cz);
    const hitX = localHitPoint.x - t.cx;
    const hitZ = localHitPoint.z - t.cz;
    const distZ = (t.length + pDims.length) / 2.0;
    const distX = (t.width + pDims.width) / 2.0;
    const sides: Array<{ axis: THREE.Vector3; dist: number; half: number; score: number }> = [
      { axis: targetForward, dist: distZ, half: t.length / 2, score: hitZ > 0.2 ? 5.2 : 2.5 },
      { axis: targetForward.clone().negate(), dist: distZ, half: t.length / 2, score: hitZ < -0.2 ? 5.2 : 2.5 },
      { axis: targetRight, dist: distX, half: t.width / 2, score: hitX > 0.2 ? 4.8 : 2.0 },
      { axis: targetRight.clone().negate(), dist: distX, half: t.width / 2, score: hitX < -0.2 ? 4.8 : 2.0 },
    ];
    for (const side of sides) {
      snap.addCandidateIfFree(
        centre.clone().addScaledVector(side.axis, side.dist),
        rotSame,
        centre.clone().addScaledVector(side.axis, side.half),
        targetPiece,
        previewType,
        hitPoint,
        hitNormal,
        side.score,
        existingPieces,
        candidates
      );
    }
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    const t = getPlacedRoofExtent(targetPiece);
    const posUnder = targetPiece.position.clone().addScaledVector(targetRight, t.cx).addScaledVector(targetForward, t.cz);
    posUnder.y = wallYUnderRoof;
    const rotWall = targetPiece.quaternion.clone().multiply(userYawQuat);

    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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

    // Aiming at the floor's top: the stairs stand right under the cursor, on the floor's 1 m grid
    // (footprint edges on the floor's tile lines), turned with [R] in quarter turns
    const onTop = localHitNormal.y > 0.6 &&
      Math.abs(localHitPoint.x) <= targetHalfSize + 0.05 && Math.abs(localHitPoint.z) <= targetHalfSize + 0.05;
    if (onTop) {
      const localX = Math.round(localHitPoint.x);
      const localZ = Math.round(localHitPoint.z);
      const pos = targetPiece.position.clone()
        .addScaledVector(targetRight, localX)
        .addScaledVector(targetForward, localZ)
        .addScaledVector(targetUp, previewHalfH);
      // Walls on this floor push the stairs out until they stand flush with the wall face on the
      // cursor's side; give up if they still cut into a wall after that
      const stairsHalf = HALF_SIZE;
      let blocked = false;
      for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        blocked = false;
        for (const wall of existingPieces) {
          if (!isSolidWallPiece(wall.type)) continue;
          const wallBase = wall.position.y - getWallHalfHeight(wall.type);
          if (Math.abs(wallBase - targetPiece.position.y) > 0.4) continue;
          const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(wall.quaternion);
          const n = new THREE.Vector3(0, 0, 1).applyQuaternion(wall.quaternion);
          // Only walls square to the floor's tiles
          if (Math.abs(dir.dot(targetRight)) < 0.99 && Math.abs(dir.dot(targetForward)) < 0.99) continue;
          const d = pos.clone().sub(wall.position);
          const along = d.dot(dir), across = d.dot(n);
          if (Math.abs(along) >= getWallHalfWidth(wall.type) + stairsHalf - 1e-3) continue;
          if (Math.abs(across) >= stairsHalf + WALL_THICKNESS / 2 - 1e-3) continue;
          if (pass === 2) { blocked = true; break; }
          const side = Math.sign(hitPoint.clone().sub(wall.position).dot(n)) || Math.sign(across) || 1;
          pos.addScaledVector(n, side * (stairsHalf + WALL_THICKNESS / 2) - across);
          moved = true;
        }
        if (!moved) break;
      }
      // No room between the walls here: only the edge candidates below remain
      if (!blocked) {
      const quarter = Math.round(manualYaw / (Math.PI / 2)) * (Math.PI / 2);
      const quat = targetPiece.quaternion.clone().multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), quarter)
      );
      const joint = new THREE.Vector3(pos.x, hitPoint.y, pos.z);
      snap.addCandidateIfFree(pos, quat, joint, targetPiece, previewType, hitPoint, hitNormal, 8.0, existingPieces, candidates);
      }
    }
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
      snap.addCandidateIfFree(
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
      snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
  // Stairs stand against the aimed face of the wall and run along it, on a 1 m grid along the wall;
  // [R] turns them in quarter turns (up the other way, or away from the wall)
  else if (isTargetWall && isPreviewStairs) {
    const previewHalfH = getStairsHalfHeight(previewType);
    const side = localHitNormal.z > 0.3 ? 1 : localHitNormal.z < -0.3 ? -1 : (localHitPoint.z >= 0 ? 1 : -1);
    const halfW = getWallHalfWidth(targetPiece.type);
    // Along the wall: footprint edges on the 1 m grid from the wall's ends
    const offset = (halfW % 1 === 0) ? 0 : 0.5;
    const localX = Math.round(localHitPoint.x - offset) + offset;
    const wallBase = targetPiece.position.y - getWallHalfHeight(targetPiece.type);
    const center = targetPiece.position.clone()
      .addScaledVector(targetRight, localX)
      .addScaledVector(targetForward, side * (WALL_THICKNESS / 2 + HALF_SIZE));
    // Stand on the floor under them when there is one (same height as stairs placed on that floor)
    let baseY = wallBase;
    for (const other of existingPieces) {
      if (!snap.isFloor(other.type)) continue;
      const half = getFloorHalfSize(other.type);
      const d = center.clone().sub(other.position);
      const ox = d.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(other.quaternion));
      const oz = d.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(other.quaternion));
      if (Math.abs(ox) > half || Math.abs(oz) > half) continue;
      if (Math.abs(other.position.y - wallBase) > 0.3) continue;
      baseY = other.position.y;
      break;
    }
    const pos = new THREE.Vector3(center.x, baseY + previewHalfH, center.z);
    const quarter = Math.round(manualYaw / (Math.PI / 2)) * (Math.PI / 2);
    const quat = targetPiece.quaternion.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 + quarter)
    );
    const joint = targetPiece.position.clone()
      .addScaledVector(targetRight, localX)
      .addScaledVector(targetForward, side * (WALL_THICKNESS / 2));
    joint.y = hitPoint.y;
    snap.addCandidateIfFree(pos, quat, joint, targetPiece, previewType, hitPoint, hitNormal, 3.5, existingPieces, candidates);
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
      snap.addCandidateIfFree(
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
      snap.addCandidateIfFree(
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
      snap.addCandidateIfFree(
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
      snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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
    snap.addCandidateIfFree(
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

        snap.addCandidateIfFree(
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
