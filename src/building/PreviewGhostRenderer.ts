import * as THREE from 'three';
import { BuildingPieceType, SnapResult, WallGridInfo, isWindowOrDoorPiece } from './types/BuildingTypes';
import { BUILDING_MATERIALS, BUILDING_PIECES, WALL_THICKNESS, createPieceMeshGroup, isProceduralRoofPiece } from './config/BuildingPiecesConfig';

export class PreviewGhostRenderer {
  public group: THREE.Group;
  private currentGhostMesh: THREE.Group | null = null;
  private currentPieceType: BuildingPieceType | null = null;
  private socketIndicator: THREE.Mesh;
  private floorGridHelper: THREE.GridHelper;
  private wallFaceGridGroup: THREE.Group;
  private wallGridLines: THREE.LineSegments | null = null;
  private wallHighlightLines: THREE.LineSegments | null = null;
  private isVisible: boolean = false;

  constructor(private scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = 'BuildingPreviewGhost_Group';

    // Small luminous snap point sphere
    const markerGeo = new THREE.SphereGeometry(0.08, 12, 12);
    this.socketIndicator = new THREE.Mesh(markerGeo, BUILDING_MATERIALS.socketMarker);
    this.socketIndicator.visible = false;
    this.group.add(this.socketIndicator);

    // 1.0m Visual Floor Grid Helper (6m size with 6 divisions = 1m cells)
    this.floorGridHelper = new THREE.GridHelper(6.0, 6, 0x38bdf8, 0x0284c7);
    if (Array.isArray(this.floorGridHelper.material)) {
      this.floorGridHelper.material.forEach((m) => {
        m.transparent = true;
        m.opacity = 0.4;
        m.depthWrite = false;
      });
    } else {
      this.floorGridHelper.material.transparent = true;
      this.floorGridHelper.material.opacity = 0.4;
      this.floorGridHelper.material.depthWrite = false;
    }
    this.floorGridHelper.visible = false;
    this.group.add(this.floorGridHelper);

    // Dedicated Wall Face Grid Group
    this.wallFaceGridGroup = new THREE.Group();
    this.wallFaceGridGroup.name = 'WallFaceGrid_Group';
    this.wallFaceGridGroup.visible = false;
    this.group.add(this.wallFaceGridGroup);

    this.scene.add(this.group);
  }

  public setVisible(visible: boolean): void {
    this.isVisible = visible;
    this.group.visible = visible;
    if (!visible) {
      if (this.socketIndicator) this.socketIndicator.visible = false;
      if (this.floorGridHelper) this.floorGridHelper.visible = false;
      if (this.wallFaceGridGroup) this.wallFaceGridGroup.visible = false;
    }
  }

  public update(pieceType: BuildingPieceType, snapResult: SnapResult | null): void {
    if (!this.isVisible || !snapResult) {
      this.group.visible = false;
      if (this.floorGridHelper) this.floorGridHelper.visible = false;
      if (this.wallFaceGridGroup) this.wallFaceGridGroup.visible = false;
      return;
    }
    this.group.visible = true;

    // Re-create ghost mesh if piece type changed
    if (this.currentPieceType !== pieceType || !this.currentGhostMesh) {
      if (this.currentGhostMesh) {
        this.group.remove(this.currentGhostMesh);
        // Ghosts reuse the cached piece templates (shared with every placed piece): disposing those
        // would force a GPU re-upload. Only a procedural roof ghost owns its geometry.
        if (this.currentPieceType && isProceduralRoofPiece(this.currentPieceType)) this.disposeHierarchy(this.currentGhostMesh);
      }
      this.currentPieceType = pieceType;
      this.currentGhostMesh = createPieceMeshGroup(pieceType, true, BUILDING_MATERIALS.ghostValid);
      this.group.add(this.currentGhostMesh);
    }

    // Calculate 3D preview ghost position
    let ghostPosition = snapResult.snappedPosition.clone();

    // Offset window & door ghosts from the wall surface so they float in front of the wall instead of clipping in its center
    if (isWindowOrDoorPiece(pieceType)) {
      let activeNormal: THREE.Vector3 | null = null;
      if (snapResult.wallGridInfo?.activeFaceNormal) {
        activeNormal = snapResult.wallGridInfo.activeFaceNormal.clone();
      } else {
        activeNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(snapResult.snappedQuaternion);
      }

      if (activeNormal) {
        // WALL_THICKNESS = 0.20m (half-thickness = 0.10m).
        // Offset of 0.22m places the ghost preview 0.12m in front of the outer wall face.
        const offsetDistance = WALL_THICKNESS / 2 + 0.12;
        ghostPosition.addScaledVector(activeNormal, offsetDistance);
      }
    }

    // Update position and rotation
    this.currentGhostMesh.position.copy(ghostPosition);
    this.currentGhostMesh.quaternion.copy(snapResult.snappedQuaternion);

    // Apply color depending on placement validity
    const targetMat = snapResult.isValidPlacement
      ? BUILDING_MATERIALS.ghostValid
      : BUILDING_MATERIALS.ghostInvalid;

    this.currentGhostMesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.material = targetMat;
      }
    });

    // Handle Wall Face Grid vs Floor Grid
    if (snapResult.wallGridInfo) {
      this.floorGridHelper.visible = false;
      this.updateWallFaceGrid(snapResult.wallGridInfo, snapResult.isValidPlacement);
    } else {
      this.wallFaceGridGroup.visible = false;
      const pieceDef = BUILDING_PIECES[pieceType];
      const halfH = (pieceDef?.dimensions?.y ?? 0.2) / 2.0;
      this.floorGridHelper.position.set(
        ghostPosition.x,
        ghostPosition.y - halfH + 0.015,
        ghostPosition.z
      );
      this.floorGridHelper.visible = true;
    }

    // Snap point socket indicator
    if (snapResult.isSnapped && snapResult.targetSocket && snapResult.targetPieceId) {
      this.socketIndicator.visible = true;
      this.socketIndicator.position.copy(ghostPosition);
      if (snapResult.sourceSocket) {
        const offset = snapResult.sourceSocket.localPosition.clone().applyQuaternion(snapResult.snappedQuaternion);
        this.socketIndicator.position.add(offset);
      }
    } else {
      this.socketIndicator.visible = false;
    }
  }

  private updateWallFaceGrid(info: WallGridInfo, isValid: boolean): void {
    this.wallFaceGridGroup.visible = true;
    this.wallFaceGridGroup.position.copy(info.wallPosition);
    this.wallFaceGridGroup.quaternion.copy(info.wallQuaternion);

    // Clean up previous geometry
    while (this.wallFaceGridGroup.children.length > 0) {
      const child = this.wallFaceGridGroup.children[0];
      this.wallFaceGridGroup.remove(child);
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    }

    const gridMinX = info.gridMinX ?? -info.wallWidth / 2;
    const gridMaxX = info.gridMaxX ?? info.wallWidth / 2;
    const gridMinY = info.gridMinY ?? -info.wallHeight / 2;
    const gridMaxY = info.gridMaxY ?? info.wallHeight / 2;
    const zOffset = (info.faceSide === 'front' ? 1 : -1) * (WALL_THICKNESS / 2 + 0.008);

    // 1. Construct grid lines across the active wall face (including continuous collinear segments)
    const gridPositions: number[] = [];
    const step = info.gridStep || 0.5;

    // Vertical lines
    for (let x = gridMinX; x <= gridMaxX + 1e-4; x += step) {
      gridPositions.push(x, gridMinY, zOffset);
      gridPositions.push(x, gridMaxY, zOffset);
    }
    // Horizontal lines
    for (let y = gridMinY; y <= gridMaxY + 1e-4; y += step) {
      gridPositions.push(gridMinX, y, zOffset);
      gridPositions.push(gridMaxX, y, zOffset);
    }

    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPositions, 3));
    const gridMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });
    this.wallGridLines = new THREE.LineSegments(gridGeo, gridMat);
    this.wallFaceGridGroup.add(this.wallGridLines);

    // 2. Construct placement outline highlight on the wall face
    const hlPositions: number[] = [];
    const minX = info.previewLocalMinX;
    const maxX = info.previewLocalMaxX;
    const minY = info.previewLocalMinY;
    const maxY = info.previewLocalMaxY;
    const hlZ = zOffset + (info.faceSide === 'front' ? 0.002 : -0.002);

    hlPositions.push(minX, minY, hlZ, maxX, minY, hlZ);
    hlPositions.push(maxX, minY, hlZ, maxX, maxY, hlZ);
    hlPositions.push(maxX, maxY, hlZ, minX, maxY, hlZ);
    hlPositions.push(minX, maxY, hlZ, minX, minY, hlZ);

    const hlGeo = new THREE.BufferGeometry();
    hlGeo.setAttribute('position', new THREE.Float32BufferAttribute(hlPositions, 3));
    const hlMat = new THREE.LineBasicMaterial({
      color: isValid ? 0x22c55e : 0xef4444,
      linewidth: 2,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.wallHighlightLines = new THREE.LineSegments(hlGeo, hlMat);
    this.wallFaceGridGroup.add(this.wallHighlightLines);
  }

  public dispose(): void {
    if (this.currentGhostMesh) {
      this.group.remove(this.currentGhostMesh);
      if (this.currentPieceType && isProceduralRoofPiece(this.currentPieceType)) this.disposeHierarchy(this.currentGhostMesh);
    }
    if (this.floorGridHelper) {
      this.floorGridHelper.geometry.dispose();
      if (Array.isArray(this.floorGridHelper.material)) {
        this.floorGridHelper.material.forEach((m) => m.dispose());
      } else {
        this.floorGridHelper.material.dispose();
      }
    }
    while (this.wallFaceGridGroup.children.length > 0) {
      const child = this.wallFaceGridGroup.children[0];
      this.wallFaceGridGroup.remove(child);
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    }
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
  }

  private disposeHierarchy(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        if (child.geometry) child.geometry.dispose();
      }
    });
  }
}

