import { t, localName } from '../../i18n/i18n';
import * as THREE from 'three';
import { IAbility, CharacterContext } from './IAbility';
import { BuildingPieceType, BuildingTelemetry, SnapResult, isSwingDoorPiece } from '../../building/types/BuildingTypes';
import { BUILDING_PIECES } from '../../building/config/BuildingPiecesConfig';
import { BuildingManager } from '../../building/BuildingManager';
import { SnapSystem } from '../../building/SnapSystem';
import { PreviewGhostRenderer } from '../../building/PreviewGhostRenderer';
import { WallSelectionSystem } from '../../building/WallSelectionSystem';
import { audioEngine } from '../../audio/AudioEngine';
import { WallCellHitInfo, PaintingToolMode } from '../../building/WallPaintingSystem';

const PIECE_TYPES_ORDER: BuildingPieceType[] = [
  BuildingPieceType.WOOD_FLOOR_2X2,
  BuildingPieceType.WOOD_FLOOR_1X1,
  BuildingPieceType.STONE_FOUNDATION_2X2,
  BuildingPieceType.WOOD_WALL_2X3,
  BuildingPieceType.WOOD_WALL_1X3,
  BuildingPieceType.WOOD_WALL_1X2,
  BuildingPieceType.WOOD_WALL_2X1,
  BuildingPieceType.WOOD_WALL_1X1,
  BuildingPieceType.WOOD_WALL_WINDOW_1X2,
  BuildingPieceType.WOOD_WALL_WINDOW_1X1_5,
  BuildingPieceType.WOOD_WALL_WINDOW_2X2,
  BuildingPieceType.WOOD_WALL_WINDOW_2X4,
  BuildingPieceType.WOOD_STAIRS_2X2,
  BuildingPieceType.ROOF_GABLE_2X2,
  BuildingPieceType.ROOF_HIP_2X2,
  BuildingPieceType.ROOF_GABLE_2X4,
  BuildingPieceType.ROOF_GABLE_4X4,
  BuildingPieceType.ROOF_HIP_2X4,
  BuildingPieceType.ROOF_HIP_4X4,
  BuildingPieceType.WOOD_ROOF_26,
  BuildingPieceType.WOOD_POLE_2M,
  BuildingPieceType.CHECKER_PILLAR_1M,
  BuildingPieceType.CORNER_RUSTICATED_QUOIN_1M,
  BuildingPieceType.GLASS_WALL_2X3,
  BuildingPieceType.GLASS_WALL_1X3,
  BuildingPieceType.GLASS_DOORWAY_1X3,
  BuildingPieceType.GLASS_DOOR_1X3,
  BuildingPieceType.GLASS_ROOF_GABLE_2X2,
  BuildingPieceType.GLASS_ROOF_SHED_2X2,
];

export class BuildAbility implements IAbility {
  public name = 'BuildAbility';
  public enabled = true;

  public isBuildModeActive: boolean = false;
  public isPaintingModeActive: boolean = false;
  public activeWallpaperId: string = 'wainscot_white_wood';
  public activePaintingTool: PaintingToolMode = 'wall';
  public currentHoverCellInfo: WallCellHitInfo | null = null;
  private lastPaintedKey: string | null = null;
  private paintStrokeActive = false;
  private currentFillFaces: WallCellHitInfo[] | null = null;

  public currentPieceType: BuildingPieceType | null = null;
  public selectedIndex: number = -1; // -1 means no piece selected (Inspection/Wall Selection/Arrow mode)
  public manualYaw: number = 0;
  public snappingEnabled: boolean = true;

  public buildingManager: BuildingManager | null = null;
  public snapSystem: SnapSystem = new SnapSystem();
  public ghostRenderer: PreviewGhostRenderer | null = null;
  public wallSelectionSystem: WallSelectionSystem | null = null;

  public currentSnapResult: SnapResult | null = null;
  public aimedPieceId: string | null = null;

  private wasSnappedPrevious: boolean = false;
  private rotationStep: number = Math.PI / 2; // 90 degrees snap step

  constructor() {}

  public setBuildingSystems(
    manager: BuildingManager,
    ghostRenderer: PreviewGhostRenderer,
    wallSelectionSystem?: WallSelectionSystem
  ): void {
    this.buildingManager = manager;
    this.ghostRenderer = ghostRenderer;
    this.wallSelectionSystem = wallSelectionSystem || new WallSelectionSystem(manager.scene, manager);
    if (this.wallSelectionSystem) {
      this.wallSelectionSystem.setBuildingManager(manager);
    }
  }

  public toggleBuildMode(): boolean {
    this.isBuildModeActive = !this.isBuildModeActive;
    if (this.isBuildModeActive && this.isPaintingModeActive) {
      this.setPaintingMode(false);
    }
    if (this.ghostRenderer) {
      this.ghostRenderer.setVisible(this.isBuildModeActive && this.currentPieceType !== null);
    }
    if (!this.isBuildModeActive && this.wallSelectionSystem) {
      this.wallSelectionSystem.deselect();
    }
    audioEngine.playBuildSelect();
    return this.isBuildModeActive;
  }

  public togglePaintingMode(): boolean {
    this.isPaintingModeActive = !this.isPaintingModeActive;
    if (this.isPaintingModeActive) {
      if (this.isBuildModeActive) {
        this.isBuildModeActive = false;
        this.ghostRenderer?.setVisible(false);
      }
      this.wallSelectionSystem?.deselect();
      // Ensure walls are baked and continuous for seamless painting
      if (this.buildingManager) {
        this.buildingManager.confirmWalls();
      }
      audioEngine.playPaintPick();
    } else {
      this.currentHoverCellInfo = null;
      this.currentFillFaces = null;
      this.endPaintStroke();
      this.buildingManager?.wallPaintingSystem.setHoverVisible(false);
      audioEngine.playBuildSelect();
    }
    return this.isPaintingModeActive;
  }

  public setPaintingMode(active: boolean): void {
    if (this.isPaintingModeActive !== active) {
      this.togglePaintingMode();
    }
  }

  public setWallpaper(id: string): void {
    this.activeWallpaperId = id;
    audioEngine.playBuildSelect();
  }

  public setPaintingTool(tool: PaintingToolMode): void {
    this.activePaintingTool = tool;
    audioEngine.playBuildSelect();
  }

  public undoPaint(): boolean {
    this.endPaintStroke();
    const ok = this.buildingManager?.undoPaint() ?? false;
    if (ok) audioEngine.playPaintPick();
    return ok;
  }

  public redoPaint(): boolean {
    this.endPaintStroke();
    const ok = this.buildingManager?.redoPaint() ?? false;
    if (ok) audioEngine.playPaintBrush();
    return ok;
  }

  private endPaintStroke(): void {
    if (this.paintStrokeActive) {
      this.paintStrokeActive = false;
      this.buildingManager?.endPaintStroke();
    }
  }

  /**
   * Paint-mode hotkeys, driven by keydown events so quick taps are never missed:
   * Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) undo/redo, 1-4 switch tools. Returns true when handled.
   */
  public handlePaintHotkey(e: KeyboardEvent): boolean {
    if (!this.isPaintingModeActive || e.repeat) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyZ') {
      if (e.shiftKey) this.redoPaint();
      else this.undoPaint();
      return true;
    }
    if (ctrl && e.code === 'KeyY') {
      this.redoPaint();
      return true;
    }
    if (ctrl || e.altKey) return false;
    const toolByKey: Record<string, PaintingToolMode> = {
      Digit1: 'wall',
      Digit2: 'fill',
      Digit3: 'picker',
      Digit4: 'eraser',
    };
    const tool = toolByKey[e.code];
    if (!tool) return false;
    if (this.activePaintingTool !== tool) this.setPaintingTool(tool);
    return true;
  }

  public setPieceType(type: BuildingPieceType | null): void {
    if (type === null) {
      this.currentPieceType = null;
      this.selectedIndex = -1;
      if (this.ghostRenderer) {
        this.ghostRenderer.setVisible(false);
      }
      return;
    }

    // Auto-switch to build mode when selecting any piece
    if (!this.isBuildModeActive) {
      this.isBuildModeActive = true;
      if (this.isPaintingModeActive) {
        this.isPaintingModeActive = false;
      }
    }

    // Always deselect any currently selected installed building element in the world when choosing a piece from UI
    if (this.wallSelectionSystem) {
      this.wallSelectionSystem.deselect();
    }

    if (this.currentPieceType === type) {
      // Toggle off / deselect if already selected
      this.currentPieceType = null;
      this.selectedIndex = -1;
      if (this.ghostRenderer) {
        this.ghostRenderer.setVisible(false);
      }
    } else {
      this.currentPieceType = type;
      this.selectedIndex = PIECE_TYPES_ORDER.indexOf(type);
      if (this.ghostRenderer) {
        this.ghostRenderer.setVisible(true);
      }
      audioEngine.playBuildSelect();
    }
  }

  public getCurrentPieceType(): BuildingPieceType | null {
    return this.currentPieceType;
  }

  public rotatePiece(clockwise: boolean = true): void {
    const angleDelta = clockwise ? this.rotationStep : -this.rotationStep;

    // 1. If a ghost piece is actively selected for placement in the dock, rotate its preview yaw
    if (this.currentPieceType !== null) {
      this.manualYaw += angleDelta;
      this.manualYaw = ((this.manualYaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      audioEngine.playBuildSelect();
      return;
    }

    // 2. If an already placed piece is actively selected in the world (with arrows/gizmo), rotate that piece!
    const selectedPiece = this.wallSelectionSystem?.getSelectedPiece();
    if (selectedPiece && this.buildingManager) {
      const rotated = this.buildingManager.rotatePiece(selectedPiece.id, angleDelta);
      if (rotated) {
        this.wallSelectionSystem?.selectPiece(selectedPiece);
        audioEngine.playBuildSelect();
        return;
      }
    }

    // 3. If player is aiming at a placed piece under crosshair / mouse ray
    if (this.aimedPieceId && this.buildingManager) {
      const aimedPiece = this.buildingManager.getPiece(this.aimedPieceId);
      if (aimedPiece) {
        const rotated = this.buildingManager.rotatePiece(aimedPiece.id, angleDelta);
        if (rotated) {
          if (this.wallSelectionSystem?.getSelectedPieceId() === aimedPiece.id) {
            this.wallSelectionSystem.selectPiece(aimedPiece);
          }
          audioEngine.playBuildSelect();
          return;
        }
      }
    }

    // 4. Fallback: rotate manual placement yaw
    this.manualYaw += angleDelta;
    this.manualYaw = ((this.manualYaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    audioEngine.playBuildSelect();
  }

  public toggleSnapping(): boolean {
    this.snappingEnabled = !this.snappingEnabled;
    audioEngine.playBuildSelect();
    return this.snappingEnabled;
  }

  public update(dt: number, context: CharacterContext): void {
    if (!this.enabled || !this.buildingManager || !this.ghostRenderer) return;

    const input = context.input as any;

    const playerPos = new THREE.Vector3(
      context.body.translation().x,
      context.body.translation().y,
      context.body.translation().z
    );

    // 0. Toggle Painting Mode with [KeyP]
    if (input.paintToggleJustPressed) {
      this.togglePaintingMode();
    }

    // Handle Active Painting Mode
    if (this.isPaintingModeActive) {
      // Holster weapons so shooting does not trigger
      context.activeWeapon = 0;

      if (this.ghostRenderer) {
        this.ghostRenderer.setVisible(false);
      }

      // Escape key exits painting mode
      if (input.keys?.['Escape']) {
        this.setPaintingMode(false);
        return;
      }

      // KeyB switches to build mode
      if (input.buildToggleJustPressed) {
        this.setPaintingMode(false);
        this.toggleBuildMode();
        return;
      }

      // Raycast against the continuous wall mesh using camera NDC cursor or center
      if (this.buildingManager && context.camera?.camera) {
        const raycaster = new THREE.Raycaster();
        if (input.mouseNDC) {
          raycaster.setFromCamera(input.mouseNDC, context.camera.camera);
        } else {
          raycaster.set(context.cameraPosition, context.cameraWorldDirection);
        }

        const wallMesh = this.buildingManager.continuousWallSystem.getContinuousWallMesh();
        const floorMesh = this.buildingManager.continuousWallSystem.getContinuousFloorMesh();
        const solved = this.buildingManager.continuousWallSystem.getLastSolvedCorners();

        const hitInfo = this.buildingManager.wallPaintingSystem.getHoveredCellInfo(
          raycaster,
          wallMesh,
          floorMesh,
          this.buildingManager.pieces,
          solved
        );

        this.currentHoverCellInfo = hitInfo;
        const paintSystem = this.buildingManager.wallPaintingSystem;
        paintSystem.updateHoverHighlight(hitInfo, this.activeWallpaperId);

        // Fill tool previews the whole region it would paint
        this.currentFillFaces =
          hitInfo && this.activePaintingTool === 'fill'
            ? paintSystem.collectFillFaces(hitInfo, this.buildingManager.pieces, solved)
            : null;
        paintSystem.updateFillPreview(this.currentFillFaces, this.activeWallpaperId);

        // Click or hold to paint / erase (one undo step per stroke); fill & picker act once per click
        const isTrigger = input.isMouseDown || input.buildPlaceJustPressed;
        if (isTrigger && hitInfo) {
          const strokeStarted = !this.paintStrokeActive;
          if (strokeStarted) {
            this.paintStrokeActive = true;
            this.buildingManager.beginPaintStroke();
          }
          const isSingleShot = this.activePaintingTool === 'fill' || this.activePaintingTool === 'picker';
          const actionKey = `${hitInfo.pieceId}:${hitInfo.faceSide}:${this.activePaintingTool}:${this.activeWallpaperId}`;
          if (this.lastPaintedKey !== actionKey && (!isSingleShot || strokeStarted)) {
            this.lastPaintedKey = actionKey;
            this.applyPaintAction(hitInfo);
          }
        } else if (!isTrigger) {
          this.lastPaintedKey = null;
          this.endPaintStroke();
        }
      }
      return;
    }

    // 1. Toggle Build Mode with [KeyB]
    if (input.buildToggleJustPressed) {
      this.toggleBuildMode();
    }

    if (!this.isBuildModeActive) {
      if (this.ghostRenderer) {
        this.ghostRenderer.setVisible(false);
      }
      // Check for door interaction (press E or click on door in world) when build mode is inactive
      if (input.interactJustPressed || input.isMouseDownJustPressed) {
        if (input.interactJustPressed) {
          // Pressing E checks proximity trigger zone
          const nearbyDoorInfo = this.buildingManager.getNearbyDoor(playerPos);
          if (nearbyDoorInfo) {
            this.buildingManager.toggleDoor(nearbyDoorInfo.piece.id, playerPos);
            return;
          }
        }
        // Fallback to raycasting if click or no nearby door
        let rayOrigin = context.cameraPosition;
        let rayDir = context.cameraWorldDirection;
        if (context.camera?.camera && input.mouseNDC) {
          const raycaster = new THREE.Raycaster();
          raycaster.setFromCamera(input.mouseNDC, context.camera.camera);
          rayOrigin = raycaster.ray.origin;
          rayDir = raycaster.ray.direction;
        }
        const doorPiece = this.buildingManager.findPieceUnderRay(rayOrigin, rayDir, 25.0, context.collider);
        if (doorPiece && isSwingDoorPiece(doorPiece.type)) {
          this.buildingManager.toggleDoor(doorPiece.id, playerPos);
        }
      }
      return;
    }

    // When in Build Mode: holster weapons so weapon firing does not interfere
    context.activeWeapon = 0;

    // 2. Select / Toggle Piece via hotkeys [1] to [9]
    const toggleSlot = (idx: number) => {
      if (idx >= 0 && idx < PIECE_TYPES_ORDER.length) {
        this.setPieceType(PIECE_TYPES_ORDER[idx]);
      }
    };

    if (input.weapon1JustPressed) toggleSlot(0);
    if (input.weapon2JustPressed) toggleSlot(1);
    if (input.weapon3JustPressed) toggleSlot(2);
    if (input.weapon4JustPressed) toggleSlot(3);
    if (input.weapon5JustPressed) toggleSlot(4);
    if (input.weapon6JustPressed) toggleSlot(5);
    if (input.weapon7JustPressed) toggleSlot(6);
    if (input.weapon8JustPressed) toggleSlot(7);
    if (input.weapon9JustPressed) toggleSlot(8);

    if (typeof input.buildSelectSlot === 'number') {
      if (input.buildSelectSlot >= 0 && input.buildSelectSlot < PIECE_TYPES_ORDER.length) {
        toggleSlot(input.buildSelectSlot);
      } else if (input.buildSelectSlot === -1) {
        this.currentPieceType = null;
        this.selectedIndex = -1;
        this.ghostRenderer?.setVisible(false);
      }
      input.buildSelectSlot = undefined;
    }

    // Escape key deselects currently selected piece and active wall
    if (input.keys?.['Escape']) {
      this.currentPieceType = null;
      this.selectedIndex = -1;
      this.ghostRenderer?.setVisible(false);
      this.wallSelectionSystem?.deselect();
    }

    // Detect touch/mobile devices
    const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

    // Primary ray for building placement, ghost preview, and aiming/demolish checks
    let rayOrigin = context.cameraPosition;
    let rayDir = context.cameraWorldDirection;

    // On PC/Mouse we use the mouse cursor (when unlocked), but on Mobile we always use the screen center
    if (!isTouchDevice && context.camera?.camera && input.mouseNDC) {
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(input.mouseNDC, context.camera.camera);
      rayOrigin = raycaster.ray.origin;
      rayDir = raycaster.ray.direction;
    }

    // Secondary ray for selecting and dragging white/green extension arrows (always uses touch/mouse tap coords)
    let arrowRayOrigin = context.cameraPosition;
    let arrowRayDir = context.cameraWorldDirection;
    if (context.camera?.camera && input.mouseNDC) {
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(input.mouseNDC, context.camera.camera);
      arrowRayOrigin = raycaster.ray.origin;
      arrowRayDir = raycaster.ray.direction;
    }

    // Targeted piece under crosshair / mouse ray
    const targetPiece = this.buildingManager.findPieceUnderRay(rayOrigin, rayDir, 25.0, context.collider);
    this.aimedPieceId = targetPiece ? targetPiece.id : null;

    // 3. Rotate piece via [R] key
    if (input.reloadJustPressed || input.buildRotateJustPressed) {
      this.rotatePiece(true);
    }

    // 4. Toggle Snapping via [V]
    if (input.buildSnapToggleJustPressed) {
      this.toggleSnapping();
    }

    const hasSelectedPiece = this.currentPieceType !== null;
    const currentPieceType = this.currentPieceType;

    // 5. Evaluate snapping & Ghost preview ONLY when a piece is actively selected
    if (hasSelectedPiece && currentPieceType) {
      this.ghostRenderer.setVisible(true);
      const snapResult = this.snapSystem.evaluateSnap(
        rayOrigin,
        rayDir,
        currentPieceType,
        this.manualYaw,
        this.snappingEnabled,
        this.buildingManager.getAllPieces(),
        context.physics,
        playerPos,
        context.collider
      );
      this.currentSnapResult = snapResult;

      // Audible snap feedback
      if (snapResult.isSnapped && !this.wasSnappedPrevious) {
        audioEngine.playBuildSnap();
      }
      this.wasSnappedPrevious = snapResult.isSnapped;

      // Update 3D preview ghost
      this.ghostRenderer.update(currentPieceType, snapResult);
    } else {
      // No piece selected: hide ghost completely!
      this.ghostRenderer.setVisible(false);
      this.currentSnapResult = null;
      this.wasSnappedPrevious = false;
    }

    // Update Wall Selection System (animations & hover detection on extension arrows)
    if (this.wallSelectionSystem) {
      this.wallSelectionSystem.update(dt, arrowRayOrigin, arrowRayDir, context.camera?.camera);
    }

    // --- DRAG-TO-DUPLICATE INTERACTION LOOP ---
    if (this.wallSelectionSystem && this.buildingManager) {
      // 1. Check if user just pressed mouse button down on an extension arrow to begin dragging
      if (input.isMouseDownJustPressed) {
        const hitArrowSide = this.wallSelectionSystem.raycastArrows(arrowRayOrigin, arrowRayDir);
        if (hitArrowSide && this.wallSelectionSystem.getSelectedPiece()) {
          this.wallSelectionSystem.startDrag(hitArrowSide, arrowRayOrigin, arrowRayDir, this.buildingManager);
          this.currentPieceType = null;
          this.selectedIndex = -1;
          this.ghostRenderer?.setVisible(false);
          return;
        }
      }

      // 2. Active dragging update or release
      if (this.wallSelectionSystem.isDragging) {
        if (input.isMouseDown) {
          this.wallSelectionSystem.updateDrag(arrowRayOrigin, arrowRayDir, this.buildingManager);
          return;
        } else {
          this.wallSelectionSystem.endDrag(this.buildingManager);
          return;
        }
      }
    }

    // 6. Demolish check & door interaction

    if (input.interactJustPressed) {
      const nearbyDoorInfo = this.buildingManager.getNearbyDoor(playerPos);
      if (nearbyDoorInfo) {
        this.buildingManager.toggleDoor(nearbyDoorInfo.piece.id, playerPos);
      } else if (targetPiece && isSwingDoorPiece(targetPiece.type)) {
        this.buildingManager.toggleDoor(targetPiece.id, playerPos);
      }
    }

    if (input.buildDemolishJustPressed) {
      if (hasSelectedPiece && !targetPiece) {
        // Right-clicking empty space while holding a piece cancels/deselects the piece!
        this.currentPieceType = null;
        this.selectedIndex = -1;
        this.ghostRenderer.setVisible(false);
      } else if (targetPiece) {
        if (this.wallSelectionSystem && this.wallSelectionSystem.getSelectedWallId() === targetPiece.id) {
          this.wallSelectionSystem.deselect();
        }
        this.buildingManager.demolishPiece(targetPiece.id);
      }
    }

    // 7. Click Interaction:
    // Uses exclusively input.buildPlaceJustPressed (clean mouse release without camera dragging or UI clicks)
    const isClickJustPressed = input.buildPlaceJustPressed;
    if (isClickJustPressed) {
      // 7a. PRIORITY 1: Clicked on one of the high-contrast extension arrows on the active piece
      const hitArrowSide = this.wallSelectionSystem?.raycastArrows(arrowRayOrigin, arrowRayDir);
      if (hitArrowSide && this.wallSelectionSystem?.getSelectedPiece() && this.buildingManager) {
        this.wallSelectionSystem.extendSelectedPiece(hitArrowSide, this.buildingManager);
        // Ensure UI piece is deselected so ghost does not appear
        this.currentPieceType = null;
        this.selectedIndex = -1;
        this.ghostRenderer.setVisible(false);
        return;
      }

      // 7b. PRIORITY 2: A piece is actively selected in the dock and placement is valid
      if (hasSelectedPiece && currentPieceType && this.currentSnapResult?.isValidPlacement) {
        const placed = this.buildingManager.placePiece(
          currentPieceType,
          this.currentSnapResult.snappedPosition,
          this.currentSnapResult.snappedQuaternion
        );

        // Deselect the piece in the panel on placement so ghost object disappears
        this.currentPieceType = null;
        this.selectedIndex = -1;
        this.ghostRenderer.setVisible(false);

        // Automatically select the newly placed element and show its extension arrows!
        if (placed && this.wallSelectionSystem?.isSelectablePiece(placed.type)) {
          this.wallSelectionSystem.selectPiece(placed);
        } else {
          this.wallSelectionSystem?.deselect();
        }
        audioEngine.playBuildPlace();
        return;
      }

      // 7c. PRIORITY 3: Clicked a door or an already placed piece -> toggle door or select piece!
      if (targetPiece && isSwingDoorPiece(targetPiece.type)) {
        this.buildingManager.toggleDoor(targetPiece.id, playerPos);
        return;
      }

      if (targetPiece && this.wallSelectionSystem?.isSelectablePiece(targetPiece.type)) {
        this.wallSelectionSystem.selectPiece(targetPiece);
        this.currentPieceType = null;
        this.selectedIndex = -1;
        this.ghostRenderer.setVisible(false);
        audioEngine.playBuildSelect();
        return;
      }

      // 7d. Clicked outside on empty ground without placement: deselect active piece
      if (!targetPiece) {
        this.wallSelectionSystem?.deselect();
      }
    }
  }

  private applyPaintAction(hitInfo: WallCellHitInfo): void {
    if (!this.buildingManager) return;

    switch (this.activePaintingTool) {
      case 'picker': {
        const sampled = hitInfo.currentWallpaperId;
        if (sampled && sampled !== 'default') {
          this.activeWallpaperId = sampled;
          // Picking a colour means the user wants to paint with it next
          this.activePaintingTool = 'wall';
          audioEngine.playPaintPick();
        }
        break;
      }
      case 'eraser': {
        if (this.buildingManager.paintFaces([hitInfo], 'default')) audioEngine.playPaintBrush();
        break;
      }
      case 'fill': {
        const faces = this.currentFillFaces && this.currentFillFaces.length > 0 ? this.currentFillFaces : [hitInfo];
        if (this.buildingManager.paintFaces(faces, this.activeWallpaperId)) audioEngine.playPaintBrush();
        break;
      }
      case 'wall':
      default: {
        if (this.buildingManager.paintFaces([hitInfo], this.activeWallpaperId)) audioEngine.playPaintBrush();
        break;
      }
    }
  }

  public getTelemetry(): BuildingTelemetry {
    const currentPieceType = this.getCurrentPieceType();
    const pieceDef = currentPieceType ? BUILDING_PIECES[currentPieceType] : null;

    const hoveredDef = this.currentHoverCellInfo
      ? this.buildingManager?.wallPaintingSystem.wallpaperMap.get(this.currentHoverCellInfo.currentWallpaperId)
      : null;

    return {
      isBuildModeActive: this.isBuildModeActive,
      selectedPieceType: currentPieceType,
      selectedPieceName: pieceDef ? localName(pieceDef) : t('build.noneSelected'),
      isSnapped: this.currentSnapResult?.isSnapped ?? false,
      snappingEnabled: this.snappingEnabled,
      isValidPlacement: this.currentSnapResult?.isValidPlacement ?? false,
      totalPiecesBuilt: this.buildingManager ? this.buildingManager.getPieceCount() : 0,
      aimingAtPieceId: this.aimedPieceId,
      unconfirmedWallsCount: this.buildingManager ? this.buildingManager.getUnconfirmedWallCount() : 0,
      unconfirmedFloorsCount: this.buildingManager ? this.buildingManager.getUnconfirmedFloorCount() : 0,
      unconfirmedFoundationsCount: this.buildingManager ? this.buildingManager.getUnconfirmedFoundationCount() : 0,
      selectedWallId: this.wallSelectionSystem?.getSelectedWallId() ?? null,
      isPaintingModeActive: this.isPaintingModeActive,
      activeWallpaperId: this.activeWallpaperId,
      activePaintingTool: this.activePaintingTool,
      hoveredCellFace: this.currentHoverCellInfo?.faceLabel ?? null,
      hoveredCellCoords: this.currentHoverCellInfo
        ? t('paint.wallSize', { w: this.currentHoverCellInfo.width.toFixed(1), h: this.currentHoverCellInfo.height.toFixed(1) })
        : null,
      hoveredCellWallpaperName: hoveredDef ? localName(hoveredDef) : (this.currentHoverCellInfo ? t('paint.defaultWall') : null),
      hoveredCellFaceKind: this.currentHoverCellInfo?.faceKind ?? null,
      customizedCellsCount: this.buildingManager?.wallPaintingSystem.getCustomizationCount() ?? 0,
      canUndoPaint: this.buildingManager?.wallPaintingSystem.canUndo() ?? false,
      canRedoPaint: this.buildingManager?.wallPaintingSystem.canRedo() ?? false,
      fillPreviewCount: this.currentFillFaces?.length ?? 0,
      gridCellSize: this.buildingManager?.wallPaintingSystem.gridCellSize ?? 1.0,
    };
  }

  public setGridCellSize(size: number): void {
    if (this.buildingManager) {
      this.buildingManager.setGridCellSize(size);
      audioEngine.playBuildSelect();
    }
  }

  public confirmWalls(): boolean {
    if (!this.buildingManager) return false;
    return this.buildingManager.confirmWalls();
  }

  public confirmFloors(): boolean {
    if (!this.buildingManager) return false;
    return this.buildingManager.confirmFloors();
  }

  public confirmFoundations(): boolean {
    if (!this.buildingManager) return false;
    return this.buildingManager.confirmFoundations();
  }

  public confirmAll(): boolean {
    if (!this.buildingManager) return false;
    return this.buildingManager.confirmAll();
  }

  public exportScene(roofStyle?: 'terracotta' | 'blue_slate' | 'wood_shingles') {
    if (!this.buildingManager) return null;
    return this.buildingManager.exportScene(roofStyle);
  }

  public downloadSceneJson(roofStyle?: 'terracotta' | 'blue_slate' | 'wood_shingles') {
    if (!this.buildingManager) return null;
    return this.buildingManager.downloadSceneJson(roofStyle);
  }

  public importScene(data: any) {
    if (!this.buildingManager) return { success: false, piecesCount: 0, customizedCells: 0, error: 'BuildingManager not available' };
    return this.buildingManager.importScene(data);
  }

  public cleanup(): void {
    if (this.ghostRenderer) {
      this.ghostRenderer.dispose();
    }
    if (this.wallSelectionSystem) {
      this.wallSelectionSystem.dispose();
    }
  }
}
