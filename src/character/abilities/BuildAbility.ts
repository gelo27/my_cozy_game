import { t, localName } from '../../i18n/i18n';
import type { TKey } from '../../i18n/en';
import * as THREE from 'three';
import { interactionFocus } from '../../gameplay/InteractionFocus';
import { uiScreens } from '../../ui/UiScreens';
import { cutawayRayStart } from '../../building/BuildCutaway';
import { IAbility, CharacterContext } from './IAbility';
import { DORMER_HEIGHT, DORMER_WIDTH, type DormerStyle } from '../../building/RoofDormers';
import { BuildingPieceType, BuildingTelemetry, BuiltPiece, DormerAction, HouseRoofKind, SnapResult, isSwingDoorPiece, isProceduralRoofPiece, isGlassRoofPiece, isSolidWallPiece } from '../../building/types/BuildingTypes';
import { isOutlineTile } from '../../building/FloorOutlineWalls';
import type { OutlineFillKind } from '../../building/OutlineFill';
import { RoofStyle } from '../../building/ProceduralRoofSystem';
import { BUILDING_PIECES } from '../../building/config/BuildingPiecesConfig';
import { BuildingManager } from '../../building/BuildingManager';
import { SnapSystem } from '../../building/SnapSystem';
import { PreviewGhostRenderer } from '../../building/PreviewGhostRenderer';
import { PieceSelectionSystem } from '../../building/PieceSelectionSystem';
import { audioEngine } from '../../audio/AudioEngine';
import { WallCellHitInfo, PaintingToolMode } from '../../building/WallPaintingSystem';

const PIECE_TYPES_ORDER: BuildingPieceType[] = [
  BuildingPieceType.WOOD_FLOOR_2X2,
  BuildingPieceType.STONE_FOUNDATION_2X2,
  BuildingPieceType.WOOD_WALL_2X3,
  BuildingPieceType.WOOD_WALL_2X1,
  BuildingPieceType.WOOD_WALL_WINDOW_1X2,
  BuildingPieceType.WOOD_WALL_WINDOW_1X1_5,
  BuildingPieceType.WOOD_WALL_WINDOW_2X2,
  BuildingPieceType.WOOD_STAIRS_2X2,
  BuildingPieceType.ROOF_GABLE_2X2,
  BuildingPieceType.ROOF_HIP_2X2,
  BuildingPieceType.ROOF_GABLE_2X4,
  BuildingPieceType.ROOF_GABLE_4X4,
  BuildingPieceType.ROOF_HIP_2X4,
  BuildingPieceType.ROOF_HIP_4X4,
  BuildingPieceType.ROOF_GAMBREL_2X2,
  BuildingPieceType.ROOF_MANSARD_2X2,
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

  private static readonly _raycaster = new THREE.Raycaster();
  private static readonly _cutOrigin = new THREE.Vector3();
  /** Spatial lookup handed to SnapSystem so it skips pieces far from the aimed point */
  private readonly queryNearbyPieces = (center: THREE.Vector3, radius: number) =>
    this.buildingManager ? this.buildingManager.getPiecesTouchingRadius(center, radius) : [];

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
  public pieceSelectionSystem: PieceSelectionSystem | null = null;
  /** Location rule supplied by the engine; building and painting are disabled in caves. */
  private canBuildHere: () => boolean = () => true;

  public currentSnapResult: SnapResult | null = null;
  public aimedPieceId: string | null = null;
  /** Shows the outcome of the [U] house-roof hotkey (wired by the HUD) */
  public onHouseRoofMessage: ((ok: boolean, message: string) => void) | null = null;
  private houseRoofKeyHeld = false;
  /** Whole-house roof picked in the dock: the next wall clicked gets it */
  private houseRoofTool: HouseRoofKind | null = null;
  /** Dormer tool on: clicks on the selected roof's slopes place dormers */
  private dormerTool = false;
  /** Style and size the next dormer gets (and the picked one shows) */
  private dormerSettings: { style: DormerStyle; width: number; height: number } = {
    style: 'gable', width: DORMER_WIDTH.initial, height: DORMER_HEIGHT.initial,
  };
  /** The placed dormer the panel edits */
  private activeDormer: { roofId: string; id: string } | null = null;
  private dormerHint: TKey | null = null;
  private floorWallsKeyHeld = false;

  private wasSnappedPrevious: boolean = false;
  private rotationStep: number = Math.PI / 2; // 90 degrees snap step

  constructor() {}

  public setBuildLocationGuard(guard: () => boolean): void {
    this.canBuildHere = guard;
  }

  public setBuildingSystems(
    manager: BuildingManager,
    ghostRenderer: PreviewGhostRenderer,
    pieceSelectionSystem?: PieceSelectionSystem
  ): void {
    this.buildingManager = manager;
    this.ghostRenderer = ghostRenderer;
    this.pieceSelectionSystem = pieceSelectionSystem || new PieceSelectionSystem(manager.scene, manager);
    if (this.pieceSelectionSystem) {
      this.pieceSelectionSystem.setBuildingManager(manager);
      this.pieceSelectionSystem.fillKindResolver = (piece) => manager.getOutlineFillKind(piece.id);
    }
  }

  public toggleBuildMode(): boolean {
    if (!this.isBuildModeActive && !this.canBuildHere()) return false;
    // One screen at a time: opening build mode closes the backpack, map, panels (UiScreens)
    if (!this.isBuildModeActive && !uiScreens.request('build')) return false;
    this.isBuildModeActive = !this.isBuildModeActive;
    if (this.isBuildModeActive && this.isPaintingModeActive) {
      this.setPaintingMode(false);
    }
    if (this.ghostRenderer) {
      this.ghostRenderer.setVisible(this.isBuildModeActive && this.currentPieceType !== null);
    }
    if (!this.isBuildModeActive && this.pieceSelectionSystem) {
      this.pieceSelectionSystem.deselect();
    }
    if (!this.isBuildModeActive) {
      this.houseRoofTool = null;
      this.dormerTool = false;
      this.activeDormer = null;
      this.buildingManager?.clearDormerPreviews();
    }
    audioEngine.playBuildSelect();
    return this.isBuildModeActive;
  }

  public togglePaintingMode(): boolean {
    if (!this.isPaintingModeActive && !this.canBuildHere()) return false;
    if (!this.isPaintingModeActive && !uiScreens.request('paint')) return false;
    this.isPaintingModeActive = !this.isPaintingModeActive;
    if (this.isPaintingModeActive) {
      if (this.isBuildModeActive) {
        this.isBuildModeActive = false;
        this.ghostRenderer?.setVisible(false);
      }
      this.pieceSelectionSystem?.deselect();
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
    if (!this.canBuildHere()) return false;
    this.endPaintStroke();
    const ok = this.buildingManager?.undoPaint() ?? false;
    if (ok) audioEngine.playPaintPick();
    return ok;
  }

  public redoPaint(): boolean {
    if (!this.canBuildHere()) return false;
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
    if (type !== null && !this.canBuildHere()) return;
    this.houseRoofTool = null;
    this.dormerTool = false;
    if (type === null) {
      this.currentPieceType = null;
      this.selectedIndex = -1;
      if (this.ghostRenderer) {
        this.ghostRenderer.setVisible(false);
      }
      return;
    }

    // Auto-switch to build mode when selecting any piece (closing whatever else is open)
    if (!this.isBuildModeActive) {
      if (!uiScreens.request('build')) return;
      this.isBuildModeActive = true;
      if (this.isPaintingModeActive) {
        this.isPaintingModeActive = false;
      }
    }

    // Always deselect any currently selected installed building element in the world when choosing a piece from UI
    if (this.pieceSelectionSystem) {
      this.pieceSelectionSystem.deselect();
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
    if (!this.canBuildHere()) return;
    const angleDelta = clockwise ? this.rotationStep : -this.rotationStep;

    // 1. If a ghost piece is actively selected for placement in the dock, rotate its preview yaw
    if (this.currentPieceType !== null) {
      this.manualYaw += angleDelta;
      this.manualYaw = ((this.manualYaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      audioEngine.playBuildSelect();
      return;
    }

    // 2. If an already placed piece is actively selected in the world (with arrows/gizmo), rotate that piece!
    const selectedPiece = this.pieceSelectionSystem?.getSelectedPiece();
    if (selectedPiece && this.buildingManager) {
      const rotated = this.buildingManager.rotatePiece(selectedPiece.id, angleDelta);
      if (rotated) {
        this.pieceSelectionSystem?.selectPiece(selectedPiece);
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
          if (this.pieceSelectionSystem?.getSelectedPieceId() === aimedPiece.id) {
            this.pieceSelectionSystem.selectPiece(aimedPiece);
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
    if (!this.canBuildHere()) return this.snappingEnabled;
    this.snappingEnabled = !this.snappingEnabled;
    audioEngine.playBuildSelect();
    return this.snappingEnabled;
  }

  private escWasDown = false;

  public update(dt: number, context: CharacterContext): void {
    if (!this.enabled || !this.buildingManager || !this.ghostRenderer) return;

    const input = context.input as any;
    if (!this.canBuildHere()) {
      // Close both modes on cave entry and discard queued touch actions so they cannot
      // place or demolish a piece after the player has crossed the entrance.
      if (this.isBuildModeActive) this.toggleBuildMode();
      if (this.isPaintingModeActive) this.setPaintingMode(false);
      input.buildToggleJustPressed = false;
      input.paintToggleJustPressed = false;
      input.buildPlaceJustPressed = false;
      input.buildDemolishJustPressed = false;
      this.ghostRenderer.setVisible(false);
      return;
    }
    // Esc acts once per press (held, it would deselect and then leave the mode on the next frame)
    const escDown = !!input.keys?.['Escape'];
    const escPressed = escDown && !this.escWasDown;
    this.escWasDown = escDown;

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
      if (escPressed) {
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
        // Walls cut away between the camera and the player can't be painted through
        cutawayRayStart(raycaster.ray.origin, raycaster.ray.direction, raycaster.ray.origin);

        const baked = this.buildingManager.continuousWallSystem;
        const solved = baked.getLastSolvedCorners();

        const hitInfo = this.buildingManager.wallPaintingSystem.getHoveredCellInfo(
          raycaster,
          baked.getWallMeshes(),
          baked.getFloorMeshes(),
          this.buildingManager.pieces,
          solved,
          (hit) => baked.faceKeyFromHit(hit)
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
      // The door in reach competes with the other E targets (InteractionFocus)
      const nearbyDoorInfo = this.buildingManager.getNearbyDoor(playerPos);
      if (nearbyDoorInfo) interactionFocus.offer('door', nearbyDoorInfo.piece.position);
      // Check for door interaction (press E or click on door in world) when build mode is inactive
      if (input.interactJustPressed || input.isMouseDownJustPressed) {
        if (input.interactJustPressed) {
          // Pressing E opens the door in reach only when it is the focused target
          if (nearbyDoorInfo && interactionFocus.allows('door')) {
            this.buildingManager.toggleDoor(nearbyDoorInfo.piece.id, playerPos);
          }
          return;
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

    // Escape deselects the piece in hand / the active wall; with nothing selected it leaves build mode
    if (escPressed && !this.currentPieceType && !this.houseRoofTool && !this.dormerTool && !this.pieceSelectionSystem?.getSelectedPiece()) {
      this.toggleBuildMode();
      return;
    }
    if (escPressed) {
      this.houseRoofTool = null;
      this.dormerTool = false;
      this.currentPieceType = null;
      this.selectedIndex = -1;
      this.ghostRenderer?.setVisible(false);
      this.pieceSelectionSystem?.deselect();
    }

    // Detect touch/mobile devices
    const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

    // Primary ray for building placement, ghost preview, and aiming/demolish checks
    let rayOrigin = context.cameraPosition;
    let rayDir = context.cameraWorldDirection;

    // On PC/Mouse we use the mouse cursor (when unlocked), but on Mobile we always use the screen center
    // Both rays come from the same mouse/tap position, so one reused raycaster serves both
    let mouseRay: THREE.Ray | null = null;
    if (context.camera?.camera && input.mouseNDC) {
      BuildAbility._raycaster.setFromCamera(input.mouseNDC, context.camera.camera);
      mouseRay = BuildAbility._raycaster.ray;
    }
    if (!isTouchDevice && mouseRay) {
      rayOrigin = mouseRay.origin;
      rayDir = mouseRay.direction;
    }
    // Pieces cut away between the camera and the player are seen through, so aim past them too
    rayOrigin = cutawayRayStart(rayOrigin, rayDir, BuildAbility._cutOrigin);

    // Secondary ray for selecting and dragging white/green extension arrows (always uses touch/mouse tap coords)
    const arrowRayOrigin = mouseRay ? mouseRay.origin : context.cameraPosition;
    const arrowRayDir = mouseRay ? mouseRay.direction : context.cameraWorldDirection;

    // Targeted piece under crosshair / mouse ray
    const targetPiece = this.buildingManager.findPieceUnderRay(rayOrigin, rayDir, 25.0, context.collider);
    this.aimedPieceId = targetPiece ? targetPiece.id : null;

    // Roof over the whole house of the wall under the cursor via [U]
    if (input.keys?.['KeyU'] && !this.houseRoofKeyHeld) {
      const res = this.roofWholeHouse();
      this.onHouseRoofMessage?.(res.ok, res.message);
    }
    this.houseRoofKeyHeld = !!input.keys?.['KeyU'];

    // Outline fill from the selected / aimed wall or floor tile via [K]
    if (input.keys?.['KeyK'] && !this.floorWallsKeyHeld) {
      const res = this.fillOutline();
      this.onHouseRoofMessage?.(res.ok, res.message);
    }
    this.floorWallsKeyHeld = !!input.keys?.['KeyK'];

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
        context.collider,
        this.queryNearbyPieces
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
    if (this.pieceSelectionSystem) {
      this.pieceSelectionSystem.update(dt, arrowRayOrigin, arrowRayDir, context.camera?.camera);
    }

    // --- DRAG-TO-DUPLICATE INTERACTION LOOP ---
    if (this.pieceSelectionSystem && this.buildingManager) {
      // 1. Check if user just pressed mouse button down on an extension arrow to begin dragging
      if (input.isMouseDownJustPressed) {
        // The fill icon acts on the click (release) below; pressing on it starts no drag
        if (this.pieceSelectionSystem.raycastFillButton(arrowRayOrigin, arrowRayDir)) return;
        const hitArrowSide = this.pieceSelectionSystem.raycastArrows(arrowRayOrigin, arrowRayDir);
        if (hitArrowSide && this.pieceSelectionSystem.getSelectedPiece()) {
          this.pieceSelectionSystem.startDrag(hitArrowSide, arrowRayOrigin, arrowRayDir, this.buildingManager);
          this.currentPieceType = null;
          this.selectedIndex = -1;
          this.ghostRenderer?.setVisible(false);
          return;
        }
      }

      // 2. Active dragging update or release
      if (this.pieceSelectionSystem.isDragging) {
        if (input.isMouseDown) {
          this.pieceSelectionSystem.updateDrag(arrowRayOrigin, arrowRayDir, this.buildingManager);
          return;
        } else {
          this.pieceSelectionSystem.endDrag(this.buildingManager);
          return;
        }
      }
    }

    // 6. Demolish check & door interaction

    if (input.interactJustPressed) {
      const nearbyDoorInfo = this.buildingManager.getNearbyDoor(playerPos);
      if (nearbyDoorInfo) {
        // Build mode: E is only the door's (nothing else acts while building)
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
        if (this.pieceSelectionSystem && this.pieceSelectionSystem.getSelectedWallId() === targetPiece.id) {
          this.pieceSelectionSystem.deselect();
        }
        this.buildingManager.demolishPiece(targetPiece.id);
      }
    }

    // 7. Click Interaction:
    // Uses exclusively input.buildPlaceJustPressed (clean mouse release without camera dragging or UI clicks)
    const isClickJustPressed = input.buildPlaceJustPressed;
    if (this.updateDormers(rayOrigin, rayDir, targetPiece, isClickJustPressed)) return;
    if (isClickJustPressed && this.houseRoofTool) {
      // Whole-house roof tool: the clicked wall's house gets the roof
      const res = this.roofWholeHouse(this.houseRoofTool, targetPiece && isSolidWallPiece(targetPiece.type) ? targetPiece : null);
      if (res.ok) this.houseRoofTool = null;
      this.onHouseRoofMessage?.(res.ok, res.message);
      return;
    }
    if (isClickJustPressed) {
      // 7a. PRIORITY 1: Clicked the fill icon or one of the extension arrows on the active piece
      if (this.pieceSelectionSystem?.raycastFillButton(arrowRayOrigin, arrowRayDir)) {
        const res = this.fillOutline(this.pieceSelectionSystem.getSelectedPiece());
        this.onHouseRoofMessage?.(res.ok, res.message);
        this.currentPieceType = null;
        this.selectedIndex = -1;
        this.ghostRenderer.setVisible(false);
        return;
      }
      const hitArrowSide = this.pieceSelectionSystem?.raycastArrows(arrowRayOrigin, arrowRayDir);
      if (hitArrowSide && this.pieceSelectionSystem?.getSelectedPiece() && this.buildingManager) {
        this.pieceSelectionSystem.extendSelectedPiece(hitArrowSide, this.buildingManager);
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

        // Shift held: keep the piece in hand to place another one right away
        const keepPlacing = !!input.buildPlaceKeepPiece;
        if (keepPlacing && placed) {
          this.pieceSelectionSystem?.deselect();
          return;
        }

        // Deselect the piece in the panel on placement so ghost object disappears
        this.currentPieceType = null;
        this.selectedIndex = -1;
        this.ghostRenderer.setVisible(false);

        // Automatically select the newly placed element and show its extension arrows!
        // (placePiece already played the placement sound)
        if (placed && this.pieceSelectionSystem?.isSelectablePiece(placed.type)) {
          this.pieceSelectionSystem.selectPiece(placed);
        } else {
          this.pieceSelectionSystem?.deselect();
        }
        return;
      }

      // 7c. PRIORITY 3: Clicked a door or an already placed piece -> toggle door or select piece!
      if (targetPiece && isSwingDoorPiece(targetPiece.type)) {
        this.buildingManager.toggleDoor(targetPiece.id, playerPos);
        return;
      }

      if (targetPiece && this.pieceSelectionSystem?.isSelectablePiece(targetPiece.type)) {
        this.pieceSelectionSystem.selectPiece(targetPiece);
        this.currentPieceType = null;
        this.selectedIndex = -1;
        this.ghostRenderer.setVisible(false);
        audioEngine.playBuildSelect();
        return;
      }

      // 7d. Clicked outside on empty ground without placement: deselect active piece
      if (!targetPiece) {
        this.pieceSelectionSystem?.deselect();
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
      // SnapSystem reports the reason as an i18n key
      placementReason: this.currentSnapResult?.validationReason
        ? t(this.currentSnapResult.validationReason as TKey)
        : null,
      totalPiecesBuilt: this.buildingManager ? this.buildingManager.getPieceCount() : 0,
      aimingAtPieceId: this.aimedPieceId,
      unconfirmedWallsCount: this.buildingManager ? this.buildingManager.getUnconfirmedWallCount() : 0,
      unconfirmedFloorsCount: this.buildingManager ? this.buildingManager.getUnconfirmedFloorCount() : 0,
      unconfirmedFoundationsCount: this.buildingManager ? this.buildingManager.getUnconfirmedFoundationCount() : 0,
      selectedWallId: this.pieceSelectionSystem?.getSelectedWallId() ?? null,
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
      isRoofSelected: !!this.getSelectedShingleRoof(),
      canRoofHouse: !!this.houseRoofWall(),
      houseRoofTool: this.houseRoofTool,
      fillKind: this.fillTargetKind(),
      dormer: this.dormerTelemetry(),
      currentRoofStyle: this.getSelectedShingleRoof()?.roofStyle ?? this.buildingManager?.defaultRoofStyle,
    };
  }

  private getSelectedShingleRoof(): BuiltPiece | null {
    const piece = this.pieceSelectionSystem?.getSelectedPiece();
    return piece && isProceduralRoofPiece(piece.type) && !isGlassRoofPiece(piece.type) ? piece : null;
  }

  // ----------------------------------------------------------------------------------- dormers

  /**
   * Dormer tool and picking, each frame: the tool previews a dormer on the selected roof's slope
   * under the cursor and places it on a click; a click on a placed dormer picks it for the panel.
   * Returns true when the click was used.
   */
  private updateDormers(rayOrigin: THREE.Vector3, rayDir: THREE.Vector3, target: BuiltPiece | null, click: boolean): boolean {
    const bm = this.buildingManager;
    if (!bm) return false;
    const roof = this.getSelectedShingleRoof();
    if (this.activeDormer && (!roof || roof.id !== this.activeDormer.roofId || !bm.getRoofDormers(roof.id).some((d) => d.id === this.activeDormer!.id))) {
      this.activeDormer = null;
    }
    if (!roof) {
      if (this.dormerTool) this.dormerTool = false;
      this.dormerHint = null;
      bm.clearDormerPreviews();
      return false;
    }
    const onRoof = !target || target.id === roof.id;
    if (!this.dormerTool) {
      bm.clearDormerPreviews();
      this.dormerHint = null;
      if (!click || !onRoof) return false;
      const id = bm.dormerUnderRay(roof.id, rayOrigin, rayDir);
      if (!id) {
        this.activeDormer = null;
        return false;
      }
      this.pickDormer(roof.id, id);
      return true;
    }

    const aimed = onRoof ? bm.pickDormerSpot(roof.id, rayOrigin, rayDir) : null;
    const existing = aimed ? bm.dormerUnderRay(roof.id, rayOrigin, rayDir) : null;
    // Too high up a low roof, the dormer slides down the slope to where it fits
    const fit = aimed && !existing ? bm.fitDormer(roof.id, { ...aimed, ...this.dormerSettings }) : null;
    const spot = fit && !fit.reason ? { x: fit.x, z: fit.z } : aimed;
    if (!aimed || existing) {
      bm.setDormerPreview(roof.id, null);
      this.dormerHint = aimed ? 'build.dormer.pickHint' : 'build.dormer.aim';
    } else {
      this.dormerHint = bm.setDormerPreview(roof.id, { ...spot!, ...this.dormerSettings });
    }
    if (!click || !spot) return false;
    if (existing) {
      this.pickDormer(roof.id, existing);
      return true;
    }
    const res = bm.addDormer(roof.id, { ...spot, ...this.dormerSettings });
    if (res.ok === false) {
      audioEngine.playBuildSelect();
      this.onHouseRoofMessage?.(false, t(res.reason));
    } else {
      this.activeDormer = { roofId: roof.id, id: res.id };
      this.onHouseRoofMessage?.(true, t('build.dormer.placed'));
    }
    return true;
  }

  /** Picks a placed dormer: the panel now shows and changes its style and size */
  private pickDormer(roofId: string, id: string): void {
    const d = this.buildingManager?.getRoofDormers(roofId).find((x) => x.id === id);
    if (!d) return;
    this.activeDormer = { roofId, id };
    this.dormerSettings = { style: d.style, width: d.width, height: d.height };
    audioEngine.playBuildSelect();
  }

  private dormerTelemetry(): BuildingTelemetry['dormer'] {
    const roof = this.getSelectedShingleRoof();
    if (!roof || !this.buildingManager) return null;
    return {
      tool: this.dormerTool,
      ...this.dormerSettings,
      editing: !!this.activeDormer,
      count: this.buildingManager.getRoofDormers(roof.id).length,
      hint: this.dormerHint ? t(this.dormerHint) : null,
    };
  }

  /** Dormer panel buttons. Returns a message to show, or null. */
  public dormerAction(action: DormerAction): { ok: boolean; message: string } | null {
    if (!this.canBuildHere()) return null;
    const bm = this.buildingManager;
    const roof = this.getSelectedShingleRoof();
    if (!bm || !roof) return null;
    const step = (v: number, delta: number, r: { min: number; max: number; step: number }) =>
      +THREE.MathUtils.clamp(Math.round((v + delta * r.step) / r.step) * r.step, r.min, r.max).toFixed(2);
    const next = { ...this.dormerSettings };
    switch (action.kind) {
      case 'tool':
        this.dormerTool = !this.dormerTool;
        if (this.dormerTool) this.activeDormer = null;
        else bm.clearDormerPreviews();
        audioEngine.playBuildSelect();
        return this.dormerTool ? { ok: true, message: t('build.dormer.aim') } : null;
      case 'done':
        this.dormerTool = false;
        this.activeDormer = null;
        bm.clearDormerPreviews();
        audioEngine.playBuildSelect();
        return null;
      case 'delete':
        if (!this.activeDormer) return null;
        bm.removeDormer(roof.id, this.activeDormer.id);
        this.activeDormer = null;
        audioEngine.playBuildDemolish();
        return null;
      case 'style': next.style = action.style; break;
      case 'width': next.width = step(next.width, action.delta, DORMER_WIDTH); break;
      case 'height': next.height = step(next.height, action.delta, DORMER_HEIGHT); break;
    }
    if (this.activeDormer) {
      const reason = bm.updateDormer(roof.id, this.activeDormer.id, next);
      if (reason) {
        audioEngine.playBuildSelect();
        return { ok: false, message: t(reason) };
      }
    }
    this.dormerSettings = next;
    audioEngine.playBuildSelect();
    return null;
  }

  /** The wall a house roof would be built from: the selected wall, else the one under the cursor */
  private houseRoofWall(): BuiltPiece | null {
    const selected = this.pieceSelectionSystem?.getSelectedPiece();
    if (selected && isSolidWallPiece(selected.type)) return selected;
    const aimed = this.aimedPieceId ? this.buildingManager?.getPiece(this.aimedPieceId) : null;
    return aimed && isSolidWallPiece(aimed.type) ? aimed : null;
  }

  /**
   * Picks (or, picked again, drops) the whole-house roof tool: the next wall clicked gets that roof
   * over its whole house. Returns the hint to show.
   */
  public setHouseRoofTool(kind: HouseRoofKind | null): { ok: boolean; message: string } | null {
    if (kind !== null && !this.canBuildHere()) return null;
    if (kind === null || this.houseRoofTool === kind) {
      this.houseRoofTool = null;
      audioEngine.playBuildSelect();
      return null;
    }
    if (!this.isBuildModeActive) {
      this.isBuildModeActive = true;
      if (this.isPaintingModeActive) this.setPaintingMode(false);
    }
    this.currentPieceType = null;
    this.selectedIndex = -1;
    this.ghostRenderer?.setVisible(false);
    this.pieceSelectionSystem?.deselect();
    this.houseRoofTool = kind;
    audioEngine.playBuildSelect();
    return { ok: true, message: t('build.houseRoof.pickWall') };
  }

  /** One roof over the whole house of a wall (the selected / aimed one by default). Returns the message to show. */
  public roofWholeHouse(kind: HouseRoofKind = 'hip', fromWall?: BuiltPiece | null): { ok: boolean; message: string } {
    if (!this.canBuildHere()) return { ok: false, message: t('build.houseRoof.noWall') };
    const wall = fromWall === undefined ? this.houseRoofWall() : fromWall;
    if (!this.buildingManager || !wall) return { ok: false, message: t('build.houseRoof.noWall') };
    const res = this.buildingManager.placeHouseRoof(wall.id, kind);
    if (res.ok === false) {
      audioEngine.playBuildSelect();
      return { ok: false, message: t(res.reason) };
    }
    this.pieceSelectionSystem?.selectPiece(res.piece);
    return { ok: true, message: t('build.houseRoof.done') };
  }

  /** The piece an outline fill starts from: the selected wall / tile, else the one under the cursor */
  private fillTarget(): BuiltPiece | null {
    const fits = (p: BuiltPiece | null | undefined) => !!p && (isSolidWallPiece(p.type) || isOutlineTile(p.type));
    const selected = this.pieceSelectionSystem?.getSelectedPiece();
    if (fits(selected)) return selected!;
    const aimed = this.aimedPieceId ? this.buildingManager?.getPiece(this.aimedPieceId) : null;
    return fits(aimed) ? aimed! : null;
  }

  private fillTargetKind(): OutlineFillKind | null {
    const target = this.fillTarget();
    return target && this.buildingManager ? this.buildingManager.getOutlineFillKind(target.id) : null;
  }

  /** Walls along the floor outline, or the ceiling inside the walls. Returns the message to show. */
  public fillOutline(from?: BuiltPiece | null): { ok: boolean; message: string } {
    if (!this.canBuildHere()) return { ok: false, message: t('build.fill.noPiece') };
    const target = from ?? this.fillTarget();
    if (!this.buildingManager || !target) return { ok: false, message: t('build.fill.noPiece') };
    const res = this.buildingManager.fillOutline(target.id);
    if (res.ok === false) {
      audioEngine.playBuildSelect();
      return { ok: false, message: t(res.reason) };
    }
    // The selected piece may offer another fill now (a filled ceiling offers walls above it)
    this.pieceSelectionSystem?.refresh();
    return { ok: true, message: t(res.kind === 'walls' ? 'build.fill.wallsDone' : 'build.fill.ceilingDone', { n: String(res.placed) }) };
  }

  /** Restyles the selected roof, and makes the style the one new roofs get */
  public setRoofStyle(style: RoofStyle): void {
    if (!this.canBuildHere()) return;
    if (!this.buildingManager) return;
    this.buildingManager.defaultRoofStyle = style;
    const roof = this.getSelectedShingleRoof();
    if (roof) this.buildingManager.setRoofStyle(roof.id, style);
  }

  public confirmWalls(): boolean {
    if (!this.canBuildHere()) return false;
    if (!this.buildingManager) return false;
    return this.buildingManager.confirmWalls();
  }

  public confirmFloors(): boolean {
    if (!this.canBuildHere()) return false;
    if (!this.buildingManager) return false;
    return this.buildingManager.confirmFloors();
  }

  public confirmFoundations(): boolean {
    if (!this.canBuildHere()) return false;
    if (!this.buildingManager) return false;
    return this.buildingManager.confirmFoundations();
  }

  public confirmAll(): boolean {
    if (!this.canBuildHere()) return false;
    if (!this.buildingManager) return false;
    return this.buildingManager.confirmAll();
  }

  public exportScene() {
    if (!this.buildingManager) return null;
    return this.buildingManager.exportScene();
  }

  public downloadSceneJson() {
    if (!this.buildingManager) return null;
    return this.buildingManager.downloadSceneJson();
  }

  public importScene(data: any) {
    if (!this.canBuildHere()) return { success: false, piecesCount: 0, customizedCells: 0, error: 'Building is disabled in caves' };
    if (!this.buildingManager) return { success: false, piecesCount: 0, customizedCells: 0, error: 'BuildingManager not available' };
    return this.buildingManager.importScene(data);
  }

  public cleanup(): void {
    if (this.ghostRenderer) {
      this.ghostRenderer.dispose();
    }
    if (this.pieceSelectionSystem) {
      this.pieceSelectionSystem.dispose();
    }
  }
}
