import * as THREE from 'three';
import { BuiltPiece, BuildingPieceType } from './types/BuildingTypes';
import { BuildingManager } from './BuildingManager';
import { audioEngine } from '../audio/AudioEngine';
import { isProceduralRoofPiece, getDefaultRoofConfig, isPieceBelowSurface } from './config/BuildingPiecesConfig';
import { ProceduralRoofConfig } from './ProceduralRoofSystem';
import { BUILDING_CONFIG } from '../config/constants';

export type ArrowSide =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'forward'
  | 'backward'
  | 'corner_fr'
  | 'corner_fl'
  | 'corner_br'
  | 'corner_bl'
  | 'wall_turn_front'
  | 'wall_turn_back';

export function isCornerSide(side: ArrowSide): boolean {
  return side === 'corner_fr' || side === 'corner_fl' || side === 'corner_br' || side === 'corner_bl';
}

export function isWallTurnSide(side: ArrowSide): boolean {
  return side === 'wall_turn_front' || side === 'wall_turn_back';
}

export function getCornerSigns(side: ArrowSide): { signX: number; signZ: number } {
  switch (side) {
    case 'corner_fr': return { signX: 1, signZ: 1 };
    case 'corner_fl': return { signX: -1, signZ: 1 };
    case 'corner_br': return { signX: 1, signZ: -1 };
    case 'corner_bl': return { signX: -1, signZ: -1 };
    default: return { signX: 0, signZ: 0 };
  }
}

export interface ExtensionConfig {
  side: ArrowSide;
  localPos: THREE.Vector3;
  direction: THREE.Vector3;
  targetLocalOffset: THREE.Vector3;
}

interface ArrowData {
  side: ArrowSide;
  group: THREE.Group;
  mesh: THREE.Group;
  hitBox: THREE.Mesh;
  baseLocalPos: THREE.Vector3;
  direction: THREE.Vector3;
  targetLocalOffset: THREE.Vector3;
  isHovered: boolean;
}

export function isSelectablePiece(type: BuildingPieceType): boolean {
  // All building pieces are selectable and support geometry-tailored extension arrows
  return Object.values(BuildingPieceType).includes(type);
}

export function isSelectableWallPiece(type: BuildingPieceType): boolean {
  return isSelectablePiece(type);
}

export function getPieceDimensions(type: BuildingPieceType, piece?: BuiltPiece): THREE.Vector3 {
  if (piece && piece.roofConfig) {
    const cfg = piece.roofConfig;
    return new THREE.Vector3(cfg.maxX - cfg.minX, cfg.height, cfg.maxZ - cfg.minZ);
  }

  switch (type) {
    case BuildingPieceType.WOOD_WALL_1X1:
      return new THREE.Vector3(1.0, 1.0, 0.12);
    case BuildingPieceType.WOOD_WALL_WINDOW_1X1_5:
      return new THREE.Vector3(1.0, 1.5, 0.12);
    case BuildingPieceType.WOOD_WALL_1X2:
    case BuildingPieceType.WOOD_WALL_WINDOW_1X2:
      return new THREE.Vector3(1.0, 2.0, 0.12);
    case BuildingPieceType.WOOD_WALL_1X3:
      return new THREE.Vector3(1.0, 3.0, 0.12);
    case BuildingPieceType.WOOD_WALL_2X3:
      return new THREE.Vector3(2.0, 3.0, 0.12);
    case BuildingPieceType.WOOD_WALL_2X1:
      return new THREE.Vector3(2.0, 1.0, 0.12);
    case BuildingPieceType.WOOD_WALL_WINDOW_2X2:
      return new THREE.Vector3(2.0, 2.0, 0.12);
    case BuildingPieceType.WOOD_WALL_DOORWAY_2X2:
      return new THREE.Vector3(2.0, 2.0, 0.12);
    case BuildingPieceType.WOOD_WALL_DOORWAY_1X2:
      return new THREE.Vector3(1.0, 2.0, 0.12);
    case BuildingPieceType.WOOD_WALL_WINDOW_2X4:
      return new THREE.Vector3(2.0, 4.0, 0.12);
    case BuildingPieceType.WOOD_FLOOR_2X2:
      return new THREE.Vector3(2.0, 0.2, 2.0);
    case BuildingPieceType.WOOD_FLOOR_1X1:
      return new THREE.Vector3(1.0, 0.2, 1.0);
    case BuildingPieceType.STONE_FOUNDATION_2X2:
      return new THREE.Vector3(2.0, 1.0, 2.0);
    case BuildingPieceType.WOOD_STAIRS_2X2:
      return new THREE.Vector3(2.0, 2.0, 2.0);
    case BuildingPieceType.WOOD_ROOF_26:
      return new THREE.Vector3(2.0, 1.0, 2.0);
    case BuildingPieceType.ROOF_GABLE_2X2:
    case BuildingPieceType.ROOF_HIP_2X2:
    case BuildingPieceType.ROOF_SHED_2X2:
      return new THREE.Vector3(2.0, 0.85, 2.0);
    case BuildingPieceType.ROOF_GABLE_2X4:
    case BuildingPieceType.ROOF_HIP_2X4:
    case BuildingPieceType.ROOF_SHED_2X4:
      return new THREE.Vector3(2.0, 0.85, 4.0);
    case BuildingPieceType.ROOF_GABLE_4X4:
    case BuildingPieceType.ROOF_HIP_4X4:
    case BuildingPieceType.ROOF_SHED_4X4:
      return new THREE.Vector3(4.0, 1.6, 4.0);
    case BuildingPieceType.WOOD_POLE_2M:
      return new THREE.Vector3(0.2, 2.0, 0.2);
    case BuildingPieceType.CHECKER_PILLAR_1M:
    case BuildingPieceType.CORNER_RUSTICATED_QUOIN_1M:
      return new THREE.Vector3(0.4, 1.0, 0.4);
    case BuildingPieceType.WOOD_RAILING_2M:
      return new THREE.Vector3(2.0, 0.95, 0.12);
    case BuildingPieceType.WOOD_RAILING_1M:
    case BuildingPieceType.WHITE_DECORATIVE_FENCE_1M:
      return new THREE.Vector3(1.0, 0.95, 0.12);
    case BuildingPieceType.WOOD_STAIR_RAILING_2X2:
      return new THREE.Vector3(0.12, 2.0, 2.0);
    default:
      return new THREE.Vector3(2.0, 2.0, 2.0);
  }
}

export function getWallDimensions(type: BuildingPieceType): { width: number; height: number } {
  const dim = getPieceDimensions(type);
  return { width: dim.x, height: dim.y };
}

/**
 * Returns tailored directional extension configurations for any building piece type.
 */
export function getPieceExtensionConfigs(type: BuildingPieceType, piece?: BuiltPiece): ExtensionConfig[] {
  const dim = getPieceDimensions(type, piece);
  const arrowDist = 0.28;
  const configs: ExtensionConfig[] = [];

  switch (type) {
    // 1. Walls, Windows, and Doorways (width = dim.x, height = dim.y, depth = 0.12)
    case BuildingPieceType.WOOD_WALL_1X1:
    case BuildingPieceType.WOOD_WALL_1X2:
    case BuildingPieceType.WOOD_WALL_1X3:
    case BuildingPieceType.WOOD_WALL_2X3:
    case BuildingPieceType.WOOD_WALL_2X1:
    case BuildingPieceType.WOOD_WALL_WINDOW_1X1_5:
    case BuildingPieceType.WOOD_WALL_WINDOW_1X2:
    case BuildingPieceType.WOOD_WALL_WINDOW_2X2:
    case BuildingPieceType.WOOD_WALL_WINDOW_2X4:
    case BuildingPieceType.WOOD_WALL_DOORWAY_1X2:
    case BuildingPieceType.WOOD_WALL_DOORWAY_2X2: {
      const W = dim.x;
      const H = dim.y;
      const T = dim.z; // 0.12

      // Left (-X) - Straight extension
      configs.push({
        side: 'left',
        localPos: new THREE.Vector3(-W / 2 - arrowDist, 0, 0),
        direction: new THREE.Vector3(-1, 0, 0),
        targetLocalOffset: new THREE.Vector3(-W, 0, 0),
      });

      // Right (+X) - Straight extension
      configs.push({
        side: 'right',
        localPos: new THREE.Vector3(W / 2 + arrowDist, 0, 0),
        direction: new THREE.Vector3(1, 0, 0),
        targetLocalOffset: new THREE.Vector3(W, 0, 0),
      });

      // Top (+Y) - Vertical up
      configs.push({
        side: 'top',
        localPos: new THREE.Vector3(0, H / 2 + arrowDist, 0),
        direction: new THREE.Vector3(0, 1, 0),
        targetLocalOffset: new THREE.Vector3(0, H, 0),
      });

      // Bottom (-Y) - Vertical down
      configs.push({
        side: 'bottom',
        localPos: new THREE.Vector3(0, -H / 2 - arrowDist, 0),
        direction: new THREE.Vector3(0, -1, 0),
        targetLocalOffset: new THREE.Vector3(0, -H, 0),
      });

      // Front (+Z) - 90 degree corner turn (Orange Arrow)
      configs.push({
        side: 'wall_turn_front',
        localPos: new THREE.Vector3(0, 0, T / 2 + arrowDist),
        direction: new THREE.Vector3(0, 0, 1),
        targetLocalOffset: new THREE.Vector3(0, 0, W),
      });

      // Back (-Z) - 90 degree corner turn (Orange Arrow)
      configs.push({
        side: 'wall_turn_back',
        localPos: new THREE.Vector3(0, 0, -T / 2 - arrowDist),
        direction: new THREE.Vector3(0, 0, -1),
        targetLocalOffset: new THREE.Vector3(0, 0, -W),
      });
      break;
    }

    // 2. Floors & Foundations
    case BuildingPieceType.WOOD_FLOOR_2X2:
    case BuildingPieceType.WOOD_FLOOR_1X1:
    case BuildingPieceType.STONE_FOUNDATION_2X2: {
      const W = dim.x;
      const H = dim.y;
      const L = dim.z;

      // Straight Edge Arrows (Right, Left, Forward, Backward)
      configs.push({
        side: 'right',
        localPos: new THREE.Vector3(W / 2 + arrowDist, 0, 0),
        direction: new THREE.Vector3(1, 0, 0),
        targetLocalOffset: new THREE.Vector3(W, 0, 0),
      });

      configs.push({
        side: 'left',
        localPos: new THREE.Vector3(-W / 2 - arrowDist, 0, 0),
        direction: new THREE.Vector3(-1, 0, 0),
        targetLocalOffset: new THREE.Vector3(-W, 0, 0),
      });

      configs.push({
        side: 'forward',
        localPos: new THREE.Vector3(0, 0, L / 2 + arrowDist),
        direction: new THREE.Vector3(0, 0, 1),
        targetLocalOffset: new THREE.Vector3(0, 0, L),
      });

      configs.push({
        side: 'backward',
        localPos: new THREE.Vector3(0, 0, -L / 2 - arrowDist),
        direction: new THREE.Vector3(0, 0, -1),
        targetLocalOffset: new THREE.Vector3(0, 0, -L),
      });

      // Diagonal Corner Arrows for 2D Rectangular Duplicate / Array Expansion
      const diagDist = arrowDist * 1.15;
      const diagDir = 0.70710678; // 1 / sqrt(2)

      // Front-Right (+X, +Z)
      configs.push({
        side: 'corner_fr',
        localPos: new THREE.Vector3(W / 2 + diagDist, 0, L / 2 + diagDist),
        direction: new THREE.Vector3(diagDir, 0, diagDir),
        targetLocalOffset: new THREE.Vector3(W, 0, L),
      });

      // Front-Left (-X, +Z)
      configs.push({
        side: 'corner_fl',
        localPos: new THREE.Vector3(-W / 2 - diagDist, 0, L / 2 + diagDist),
        direction: new THREE.Vector3(-diagDir, 0, diagDir),
        targetLocalOffset: new THREE.Vector3(-W, 0, L),
      });

      // Back-Right (+X, -Z)
      configs.push({
        side: 'corner_br',
        localPos: new THREE.Vector3(W / 2 + diagDist, 0, -L / 2 - diagDist),
        direction: new THREE.Vector3(diagDir, 0, -diagDir),
        targetLocalOffset: new THREE.Vector3(W, 0, -L),
      });

      // Back-Left (-X, -Z)
      configs.push({
        side: 'corner_bl',
        localPos: new THREE.Vector3(-W / 2 - diagDist, 0, -L / 2 - diagDist),
        direction: new THREE.Vector3(-diagDir, 0, -diagDir),
        targetLocalOffset: new THREE.Vector3(-W, 0, -L),
      });
      break;
    }

    // 3. Pillars / Poles (0.2 x 2.0 x 0.2)
    case BuildingPieceType.WOOD_POLE_2M: {
      const H = dim.y;

      // Top (+Y)
      configs.push({
        side: 'top',
        localPos: new THREE.Vector3(0, H / 2 + arrowDist, 0),
        direction: new THREE.Vector3(0, 1, 0),
        targetLocalOffset: new THREE.Vector3(0, H, 0),
      });

      // Bottom (-Y)
      configs.push({
        side: 'bottom',
        localPos: new THREE.Vector3(0, -H / 2 - arrowDist, 0),
        direction: new THREE.Vector3(0, -1, 0),
        targetLocalOffset: new THREE.Vector3(0, -H, 0),
      });

      // Grid pillars: Right (+X 2m), Left (-X 2m), Forward (+Z 2m), Backward (-Z 2m)
      configs.push({
        side: 'right',
        localPos: new THREE.Vector3(1.0 + arrowDist, 0, 0),
        direction: new THREE.Vector3(1, 0, 0),
        targetLocalOffset: new THREE.Vector3(2.0, 0, 0),
      });
      configs.push({
        side: 'left',
        localPos: new THREE.Vector3(-1.0 - arrowDist, 0, 0),
        direction: new THREE.Vector3(-1, 0, 0),
        targetLocalOffset: new THREE.Vector3(-2.0, 0, 0),
      });
      configs.push({
        side: 'forward',
        localPos: new THREE.Vector3(0, 0, 1.0 + arrowDist),
        direction: new THREE.Vector3(0, 0, 1),
        targetLocalOffset: new THREE.Vector3(0, 0, 2.0),
      });
      configs.push({
        side: 'backward',
        localPos: new THREE.Vector3(0, 0, -1.0 - arrowDist),
        direction: new THREE.Vector3(0, 0, -1),
        targetLocalOffset: new THREE.Vector3(0, 0, -2.0),
      });
      break;
    }

    case BuildingPieceType.CHECKER_PILLAR_1M:
    case BuildingPieceType.CORNER_RUSTICATED_QUOIN_1M: {
      const H = dim.y;

      // Top (+Y) - Arrow pointing UP
      configs.push({
        side: 'top',
        localPos: new THREE.Vector3(0, H / 2 + arrowDist, 0),
        direction: new THREE.Vector3(0, 1, 0),
        targetLocalOffset: new THREE.Vector3(0, H, 0),
      });

      // Bottom (-Y) - Arrow pointing DOWN
      configs.push({
        side: 'bottom',
        localPos: new THREE.Vector3(0, -H / 2 - arrowDist, 0),
        direction: new THREE.Vector3(0, -1, 0),
        targetLocalOffset: new THREE.Vector3(0, -H, 0),
      });
      break;
    }

    // 4. Stairs (2.0 x 2.0 x 2.0)
    case BuildingPieceType.WOOD_STAIRS_2X2: {
      // Up/Forward continuation (rises +2m and steps forward +2m)
      configs.push({
        side: 'top',
        localPos: new THREE.Vector3(0, 1.0 + arrowDist, 1.0 + arrowDist),
        direction: new THREE.Vector3(0, 0.7071, 0.7071),
        targetLocalOffset: new THREE.Vector3(0, 2.0, 2.0),
      });

      // Down/Backward continuation (lowers -2m and steps back -2m)
      configs.push({
        side: 'bottom',
        localPos: new THREE.Vector3(0, -1.0 - arrowDist, -1.0 - arrowDist),
        direction: new THREE.Vector3(0, -0.7071, -0.7071),
        targetLocalOffset: new THREE.Vector3(0, -2.0, -2.0),
      });

      // Parallel stairs: Left & Right
      configs.push({
        side: 'left',
        localPos: new THREE.Vector3(-1.0 - arrowDist, 0, 0),
        direction: new THREE.Vector3(-1, 0, 0),
        targetLocalOffset: new THREE.Vector3(-2.0, 0, 0),
      });
      configs.push({
        side: 'right',
        localPos: new THREE.Vector3(1.0 + arrowDist, 0, 0),
        direction: new THREE.Vector3(1, 0, 0),
        targetLocalOffset: new THREE.Vector3(2.0, 0, 0),
      });
      break;
    }

    // 5. Roofs (Single slope & Procedural 2-pitch/4-pitch)
    case BuildingPieceType.WOOD_ROOF_26: {
      // Sideways extension along eaves (Left & Right)
      configs.push({
        side: 'left',
        localPos: new THREE.Vector3(-1.0 - arrowDist, 0, 0),
        direction: new THREE.Vector3(-1, 0, 0),
        targetLocalOffset: new THREE.Vector3(-2.0, 0, 0),
      });
      configs.push({
        side: 'right',
        localPos: new THREE.Vector3(1.0 + arrowDist, 0, 0),
        direction: new THREE.Vector3(1, 0, 0),
        targetLocalOffset: new THREE.Vector3(2.0, 0, 0),
      });

      // Up the slope (+Y 1m, -Z 2m)
      configs.push({
        side: 'top',
        localPos: new THREE.Vector3(0, 0.5 + arrowDist, -1.0 - arrowDist),
        direction: new THREE.Vector3(0, 0.4472, -0.8944),
        targetLocalOffset: new THREE.Vector3(0, 1.0, -2.0),
      });

      // Down the slope (-Y 1m, +Z 2m)
      configs.push({
        side: 'bottom',
        localPos: new THREE.Vector3(0, -0.5 - arrowDist, 1.0 + arrowDist),
        direction: new THREE.Vector3(0, -0.4472, 0.8944),
        targetLocalOffset: new THREE.Vector3(0, -1.0, 2.0),
      });
      break;
    }

    // 6. Heartopia Procedural Roofs (4 horizontal edge arrows + 1 vertical top ridge arrow)
    case BuildingPieceType.ROOF_GABLE_2X2:
    case BuildingPieceType.ROOF_GABLE_2X4:
    case BuildingPieceType.ROOF_GABLE_4X4:
    case BuildingPieceType.ROOF_HIP_2X2:
    case BuildingPieceType.ROOF_HIP_2X4:
    case BuildingPieceType.ROOF_HIP_4X4:
    case BuildingPieceType.ROOF_SHED_2X2:
    case BuildingPieceType.ROOF_SHED_2X4:
    case BuildingPieceType.ROOF_SHED_4X4: {
      let minX = -dim.x / 2;
      let maxX = dim.x / 2;
      let minZ = -dim.z / 2;
      let maxZ = dim.z / 2;
      let height = dim.y;

      if (piece?.roofConfig) {
        minX = piece.roofConfig.minX;
        maxX = piece.roofConfig.maxX;
        minZ = piece.roofConfig.minZ;
        maxZ = piece.roofConfig.maxZ;
        height = piece.roofConfig.height;
      }

      const midX = (minX + maxX) / 2;
      const midZ = (minZ + maxZ) / 2;
      const aDist = 0.35;

      // 1. Ліва стрілка (-X) - зміна розміру / розширення вліво
      configs.push({
        side: 'left',
        localPos: new THREE.Vector3(minX - aDist, 0, midZ),
        direction: new THREE.Vector3(-1, 0, 0),
        targetLocalOffset: new THREE.Vector3(-0.5, 0, 0),
      });

      // 2. Права стрілка (+X) - зміна розміру / розширення вправо
      configs.push({
        side: 'right',
        localPos: new THREE.Vector3(maxX + aDist, 0, midZ),
        direction: new THREE.Vector3(1, 0, 0),
        targetLocalOffset: new THREE.Vector3(0.5, 0, 0),
      });

      // 3. Задня стрілка (-Z) - зміна розміру / розширення задом
      configs.push({
        side: 'backward',
        localPos: new THREE.Vector3(midX, 0, minZ - aDist),
        direction: new THREE.Vector3(0, 0, -1),
        targetLocalOffset: new THREE.Vector3(0, 0, -0.5),
      });

      // 4. Передня стрілка (+Z) - зміна розміру / розширення передом
      configs.push({
        side: 'forward',
        localPos: new THREE.Vector3(midX, 0, maxZ + aDist),
        direction: new THREE.Vector3(0, 0, 1),
        targetLocalOffset: new THREE.Vector3(0, 0, 0.5),
      });

      // 5. Стрілка вгору (+Y) на коньку - висота гребеня / кут нахилу (pitch height)
      configs.push({
        side: 'top',
        localPos: new THREE.Vector3(midX, height + aDist, midZ),
        direction: new THREE.Vector3(0, 1, 0),
        targetLocalOffset: new THREE.Vector3(0, 0.25, 0),
      });
      break;
    }

    // 6. Straight Railings & Fences (2m & 1m)
    case BuildingPieceType.WOOD_RAILING_2M:
    case BuildingPieceType.WOOD_RAILING_1M:
    case BuildingPieceType.WHITE_DECORATIVE_FENCE_1M: {
      const W = dim.x;
      // Right (+X)
      configs.push({
        side: 'right',
        localPos: new THREE.Vector3(W / 2 + arrowDist, 0, 0),
        direction: new THREE.Vector3(1, 0, 0),
        targetLocalOffset: new THREE.Vector3(W, 0, 0),
      });

      // Left (-X)
      configs.push({
        side: 'left',
        localPos: new THREE.Vector3(-W / 2 - arrowDist, 0, 0),
        direction: new THREE.Vector3(-1, 0, 0),
        targetLocalOffset: new THREE.Vector3(-W, 0, 0),
      });
      break;
    }

    default:
      break;
  }

  return configs;
}

/**
 * PieceSelectionSystem manages active piece selection for ALL building pieces,
 * rendering high-contrast 3D arrows on the edges rendered ALWAYS ON TOP (depthTest: false),
 * and placing adjoining pieces seamlessly when arrows are clicked.
 */
export class WallSelectionSystem {
  public selectedPiece: BuiltPiece | null = null;
  public isDragging: boolean = false;
  private scene: THREE.Scene;
  private buildingManager: BuildingManager | null = null;
  private containerGroup: THREE.Group;
  private selectionOutline: THREE.LineSegments | null = null;
  private arrows: ArrowData[] = [];
  private hitBoxMeshes: THREE.Mesh[] = [];
  private raycaster: THREE.Raycaster = new THREE.Raycaster();
  private animTime: number = 0;
  private hoveredSide: ArrowSide | null = null;

  // Drag-to-Duplicate / Procedural Resize tracking state
  private dragSide: ArrowSide | null = null;
  private dragPiecesPlacedCount: number = 0;
  private dragPlane: THREE.Plane = new THREE.Plane();
  private dragStartIntersection: THREE.Vector3 = new THREE.Vector3();
  private dragStepVectorWorld: THREE.Vector3 = new THREE.Vector3();
  private dragStepDistance: number = 2.0;
  private startRoofConfig: ProceduralRoofConfig | null = null;
  private lastAudioStep: number = 0;
  private lastAudioTime: number = 0;

  constructor(scene: THREE.Scene, buildingManager?: BuildingManager) {
    this.scene = scene;
    this.buildingManager = buildingManager || null;
    this.containerGroup = new THREE.Group();
    this.containerGroup.name = 'PieceSelectionSystem';
    this.containerGroup.visible = false;
    this.containerGroup.renderOrder = 99999;
    this.scene.add(this.containerGroup);
  }

  public setBuildingManager(manager: BuildingManager): void {
    this.buildingManager = manager;
  }

  public isSelectablePiece(type: BuildingPieceType): boolean {
    return isSelectablePiece(type);
  }

  public isSelectableWall(type: BuildingPieceType): boolean {
    return isSelectablePiece(type);
  }

  public getSelectedPiece(): BuiltPiece | null {
    return this.selectedPiece;
  }

  public getSelectedWall(): BuiltPiece | null {
    return this.selectedPiece;
  }

  public getSelectedPieceId(): string | null {
    return this.selectedPiece ? this.selectedPiece.id : null;
  }

  public getSelectedWallId(): string | null {
    return this.getSelectedPieceId();
  }

  /**
   * Sets the active piece and builds its geometry-tailored edge arrows and selection outline.
   */
  public selectPiece(piece: BuiltPiece | null): void {
    if (!piece || !isSelectablePiece(piece.type)) {
      this.deselect();
      return;
    }

    this.selectedPiece = piece;
    this.containerGroup.visible = true;
    this.rebuildVisuals();
  }

  public selectWall(piece: BuiltPiece | null): void {
    this.selectPiece(piece);
  }

  public deselect(): void {
    this.selectedPiece = null;
    this.isDragging = false;
    this.dragSide = null;
    this.dragPiecesPlacedCount = 0;
    this.containerGroup.visible = false;
    this.clearVisuals();
  }

  private clearVisuals(): void {
    while (this.containerGroup.children.length > 0) {
      const child = this.containerGroup.children[0];
      this.containerGroup.remove(child);
      if ((child as any).geometry) {
        (child as any).geometry.dispose();
      }
    }
    this.selectionOutline = null;
    this.arrows = [];
    this.hitBoxMeshes = [];
    this.hoveredSide = null;
  }

  /**
   * Checks if the space where a new piece would be placed along `targetOffset` is free.
   * If there is an existing piece occupying that space, or if it would be below the platform surface, returns false.
   */
  public isDirectionFree(targetLocalOffset: THREE.Vector3, pieceDimensions: THREE.Vector3): boolean {
    if (!this.selectedPiece || !this.buildingManager) return true;

    const worldOffset = targetLocalOffset.clone().applyQuaternion(this.selectedPiece.quaternion);
    const targetPos = this.selectedPiece.position.clone().add(worldOffset);

    // 0. Platform surface check: strictly prevent placement below the construction platform
    if (isPieceBelowSurface(this.selectedPiece.type, targetPos, this.selectedPiece.quaternion, this.selectedPiece)) {
      return false;
    }

    // Query pieces within proximity of the target position
    const searchRadius = Math.max(pieceDimensions.x, pieceDimensions.y, pieceDimensions.z) + 0.6;
    const nearby = this.buildingManager.getPiecesNear(targetPos, searchRadius);

    for (const piece of nearby) {
      if (piece.id === this.selectedPiece.id) continue;

      // 1. Direct center proximity check: if another piece center is within 0.35m of target center
      if (piece.position.distanceTo(targetPos) < 0.35) {
        return false;
      }

      // 2. Check if target point falls within the piece's world bounding box (shrunk slightly to ignore touching edges)
      if (piece.worldBoundingBox) {
        const shrunkBox = piece.worldBoundingBox.clone().expandByScalar(-0.06);
        if (shrunkBox.containsPoint(targetPos)) {
          return false;
        }
      }

      // 3. Proximity on horizontal/vertical plane: if center distance is very close
      const minDim = Math.min(pieceDimensions.x, pieceDimensions.y, pieceDimensions.z);
      const threshold = Math.max(0.4, minDim * 0.6);
      if (piece.position.distanceTo(targetPos) < threshold) {
        return false;
      }
    }

    return true;
  }

  /**
   * Checks whether a specific target world position & orientation for a new piece is valid and collision-free.
   */
  public isCandidatePlacementFree(
    targetPos: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    pieceType: BuildingPieceType,
    pieceDimensions: THREE.Vector3
  ): boolean {
    if (!this.selectedPiece || !this.buildingManager) return true;

    // 0. Platform ground surface check
    if (isPieceBelowSurface(pieceType, targetPos, targetQuat, this.selectedPiece)) {
      return false;
    }

    // 1. Proximity check against nearby pieces
    const searchRadius = Math.max(pieceDimensions.x, pieceDimensions.y, pieceDimensions.z) + 0.6;
    const nearby = this.buildingManager.getPiecesNear(targetPos, searchRadius);

    for (const piece of nearby) {
      if (piece.id === this.selectedPiece.id) continue;

      // Direct center distance check
      if (piece.position.distanceTo(targetPos) < 0.35) {
        return false;
      }

      // Inside world bounding box check
      if (piece.worldBoundingBox) {
        const shrunkBox = piece.worldBoundingBox.clone().expandByScalar(-0.06);
        if (shrunkBox.containsPoint(targetPos)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Evaluates if at least one corner location is free.
   */
  public hasAnyFreeWallTurnCandidate(side: ArrowSide): boolean {
    if (!this.selectedPiece || !this.buildingManager) return true;
    return this.getBestWallTurnCandidate(side) !== null;
  }

  /**
   * Determines the 90-degree corner placement candidate:
   * 1. If both straight ends (+X and -X) are occupied, returns null (hides the orange turn arrows).
   * 2. If the forward end (+X) is open and backward is occupied: places 90° corner at the forward end.
   * 3. If the backward end (-X) is open and forward is occupied: places 90° corner at the backward end.
   * 4. If both ends are free (standalone wall): places 90° corner at the forward end (+X), or backward (-X) if forward corner is blocked.
   */
  public getBestWallTurnCandidate(side: ArrowSide): { position: THREE.Vector3; quaternion: THREE.Quaternion } | null {
    if (!this.selectedPiece || !this.buildingManager) return null;

    const piece = this.selectedPiece;
    const dim = getPieceDimensions(piece.type, piece);
    const W = dim.x;
    const sideSign = side === 'wall_turn_front' ? 1 : -1;

    // Check if the straight line ends (+X and -X) are occupied by straight adjoining walls
    const forwardOccupied = !this.isDirectionFree(new THREE.Vector3(W, 0, 0), dim);
    const backwardOccupied = !this.isDirectionFree(new THREE.Vector3(-W, 0, 0), dim);

    // If both straight sides are occupied by adjoining walls, hide the orange corner arrows
    if (forwardOccupied && backwardOccupied) {
      return null;
    }

    // Rotate 90 degrees around Y axis for the perpendicular wall
    const turnAngle = sideSign > 0 ? -Math.PI / 2 : Math.PI / 2;
    const qRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turnAngle);
    const newQuat = piece.quaternion.clone().multiply(qRot);

    // Two corner candidate positions (in local coordinates of the selected wall):
    // 1. +X End (Forward Corner)
    const posEndLocal = new THREE.Vector3(W / 2, 0, sideSign * (W / 2));
    const worldPosEnd = piece.position.clone().add(posEndLocal.applyQuaternion(piece.quaternion));

    // 2. -X End (Backward Corner)
    const posStartLocal = new THREE.Vector3(-W / 2, 0, sideSign * (W / 2));
    const worldPosStart = piece.position.clone().add(posStartLocal.applyQuaternion(piece.quaternion));

    const isEndFree = this.isCandidatePlacementFree(worldPosEnd, newQuat, piece.type, dim);
    const isStartFree = this.isCandidatePlacementFree(worldPosStart, newQuat, piece.type, dim);

    let candidateOrder: Array<{ pos: THREE.Vector3; free: boolean }>;

    if (!forwardOccupied && backwardOccupied) {
      // Forward end is free, backward is occupied -> candidate is forward corner (+X)
      candidateOrder = [
        { pos: worldPosEnd, free: isEndFree },
      ];
    } else if (forwardOccupied && !backwardOccupied) {
      // Backward end is free, forward is occupied -> candidate is backward corner (-X)
      candidateOrder = [
        { pos: worldPosStart, free: isStartFree },
      ];
    } else {
      // Both ends free (standalone wall) -> prioritize forward end (+X), then backward (-X)
      candidateOrder = [
        { pos: worldPosEnd, free: isEndFree },
        { pos: worldPosStart, free: isStartFree },
      ];
    }

    const validCandidate = candidateOrder.find((c) => c.free);
    if (!validCandidate) return null;

    return {
      position: validCandidate.pos,
      quaternion: newQuat,
    };
  }

  private rebuildVisuals(): void {
    this.clearVisuals();
    if (!this.selectedPiece) return;

    const piece = this.selectedPiece;
    const dim = getPieceDimensions(piece.type, piece);

    // Position and orient container group to match selected piece
    this.containerGroup.position.copy(piece.position);
    this.containerGroup.quaternion.copy(piece.quaternion);

    // 1. Selection Outline Box around the active piece (RENDERED ALWAYS ON TOP)
    let boxGeom: THREE.BoxGeometry;
    if (piece.roofConfig) {
      const cfg = piece.roofConfig;
      const W = cfg.maxX - cfg.minX;
      const L = cfg.maxZ - cfg.minZ;
      const H = cfg.height;
      const midX = (cfg.minX + cfg.maxX) / 2;
      const midZ = (cfg.minZ + cfg.maxZ) / 2;

      boxGeom = new THREE.BoxGeometry(W + 0.04, H + 0.04, L + 0.04);
      boxGeom.translate(midX, H / 2, midZ);
    } else {
      boxGeom = new THREE.BoxGeometry(dim.x + 0.04, dim.y + 0.04, dim.z + 0.04);
    }

    const edgesGeom = new THREE.EdgesGeometry(boxGeom);
    boxGeom.dispose();

    const outlineMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8, // Vibrant Sky Blue
      linewidth: 3.0,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    this.selectionOutline = new THREE.LineSegments(edgesGeom, outlineMat);
    this.selectionOutline.renderOrder = 99999;
    this.containerGroup.add(this.selectionOutline);

    // 2. Build High-Contrast 3D Arrows for all valid extension directions
    const configs = getPieceExtensionConfigs(piece.type, piece);

    for (const config of configs) {
      if (isProceduralRoofPiece(piece.type)) {
        if (piece.position.y >= BUILDING_CONFIG.GROUND_SURFACE_Y + BUILDING_CONFIG.MIN_SURFACE_TOLERANCE) {
          this.createArrow(config);
        }
      } else if (isCornerSide(config.side)) {
        const { signX, signZ } = getCornerSigns(config.side);
        const freeX = this.isDirectionFree(new THREE.Vector3(dim.x * signX, 0, 0), dim);
        const freeZ = this.isDirectionFree(new THREE.Vector3(0, 0, dim.z * signZ), dim);
        const freeDiag = this.isDirectionFree(new THREE.Vector3(dim.x * signX, 0, dim.z * signZ), dim);
        if (freeX || freeZ || freeDiag) {
          this.createArrow(config);
        }
      } else if (isWallTurnSide(config.side)) {
        if (this.hasAnyFreeWallTurnCandidate(config.side)) {
          this.createArrow(config);
        }
      } else if (this.isDirectionFree(config.targetLocalOffset, dim)) {
        this.createArrow(config);
      }
    }
  }

  /**
   * Constructs an ultra-visible, high-contrast 3D arrow pointing along direction.
   * Uses dual-layer geometry (dark casing + bright luminous core + base disc)
   * with depthTest: false and renderOrder = 99999 so it is 100% visible through
   * any transparent object, ghost preview, water, or dense meshes.
   */
  private createArrow(config: ExtensionConfig): void {
    const arrowGroup = new THREE.Group();
    arrowGroup.position.copy(config.localPos);
    arrowGroup.renderOrder = 99999;

    const meshGroup = new THREE.Group();
    meshGroup.renderOrder = 99999;

    const normDir = config.direction.clone().normalize();
    const defaultUp = new THREE.Vector3(0, 1, 0);

    // --- B. High-Contrast Black Casing / Silhouette Outline ---
    const casingShaftGeom = new THREE.CylinderGeometry(0.068, 0.068, 0.28, 16);
    const casingHeadGeom = new THREE.ConeGeometry(0.18, 0.28, 20);
    casingHeadGeom.translate(0, 0.14 + 0.14, 0);

    const casingMat = new THREE.MeshBasicMaterial({
      color: 0x050811,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const casingShaft = new THREE.Mesh(casingShaftGeom, casingMat);
    const casingHead = new THREE.Mesh(casingHeadGeom, casingMat);
    casingShaft.renderOrder = 99998;
    casingHead.renderOrder = 99998;
    meshGroup.add(casingShaft);
    meshGroup.add(casingHead);

    // --- C. Vibrant Luminous Inner Core ---
    const shaftGeom = new THREE.CylinderGeometry(0.046, 0.046, 0.25, 16);
    const headGeom = new THREE.ConeGeometry(0.14, 0.25, 20);
    headGeom.translate(0, 0.125 + 0.125, 0);

    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    const shaftMesh = new THREE.Mesh(shaftGeom, coreMat);
    const headMesh = new THREE.Mesh(headGeom, coreMat);
    shaftMesh.renderOrder = 99999;
    headMesh.renderOrder = 99999;
    meshGroup.add(shaftMesh);
    meshGroup.add(headMesh);

    // Orient meshGroup from default (0, 1, 0) to config.direction
    meshGroup.quaternion.setFromUnitVectors(defaultUp, normDir);
    arrowGroup.add(meshGroup);

    // --- D. Interactive Hit Box for Raycasting & Dragging (Sphere radius 0.5m) ---
    const hitGeom = new THREE.SphereGeometry(0.5, 8, 8);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false, depthTest: false });
    const hitBox = new THREE.Mesh(hitGeom, hitMat);
    (hitBox as any).userData = { arrowSide: config.side };
    hitBox.renderOrder = 99999;
    arrowGroup.add(hitBox);

    this.containerGroup.add(arrowGroup);

    const arrowData: ArrowData = {
      side: config.side,
      group: arrowGroup,
      mesh: meshGroup,
      hitBox,
      baseLocalPos: config.localPos.clone(),
      direction: normDir,
      targetLocalOffset: config.targetLocalOffset.clone(),
      isHovered: false,
    };

    this.arrows.push(arrowData);
    this.hitBoxMeshes.push(hitBox);
  }

  /**
   * Raycasts against the extension arrow hitboxes from camera ray.
   */
  public raycastArrows(rayOrigin: THREE.Vector3, rayDirection: THREE.Vector3): ArrowSide | null {
    if (!this.selectedPiece || this.hitBoxMeshes.length === 0) return null;

    this.raycaster.set(rayOrigin, rayDirection);
    this.raycaster.far = 100.0;
    const intersects = this.raycaster.intersectObjects(this.hitBoxMeshes, false);

    if (intersects.length > 0) {
      const hitObj = intersects[0].object as any;
      return hitObj.userData?.arrowSide || null;
    }

    return null;
  }

  /**
   * Starts a drag gesture on an arrow (procedural resize for roofs, drag-to-duplicate for walls/floors).
   */
  public startDrag(
    side: ArrowSide,
    rayOrigin: THREE.Vector3,
    rayDir: THREE.Vector3,
    buildingManager: BuildingManager
  ): void {
    if (!this.selectedPiece) return;
    if (buildingManager && !this.buildingManager) {
      this.buildingManager = buildingManager;
    }

    const arrowData = this.arrows.find((a) => a.side === side);
    if (!arrowData) return;

    this.isDragging = true;
    this.dragSide = side;
    this.dragPiecesPlacedCount = 0;

    if (isProceduralRoofPiece(this.selectedPiece.type)) {
      this.startRoofConfig = this.selectedPiece.roofConfig
        ? { ...this.selectedPiece.roofConfig }
        : getDefaultRoofConfig(this.selectedPiece.type);
    } else {
      this.startRoofConfig = null;
    }

    this.lastAudioStep = 0;
    this.lastAudioTime = performance.now();

    // Calculate step distance and world direction
    this.dragStepVectorWorld = arrowData.targetLocalOffset.clone().applyQuaternion(this.selectedPiece.quaternion);
    this.dragStepDistance = Math.max(0.25, this.dragStepVectorWorld.length());

    // Construct drag plane: horizontal plane for ground corner arrows, camera-facing plane for straight arrows
    if (isCornerSide(side)) {
      this.dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), this.selectedPiece.position);
    } else {
      const planeNormal = rayDir.clone().negate().normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(planeNormal, this.selectedPiece.position);
    }

    // Find initial intersection
    const ray = new THREE.Ray(rayOrigin, rayDir);
    const hit = new THREE.Vector3();
    if (ray.intersectPlane(this.dragPlane, hit)) {
      this.dragStartIntersection.copy(hit);
    } else {
      this.dragStartIntersection.copy(this.selectedPiece.position);
    }

    // Trigger initial click extension or step
    const placed = this.extendSelectedPiece(side, buildingManager);
    if (placed) {
      this.dragPiecesPlacedCount++;
    }
  }

  /**
   * Updates an ongoing drag gesture. For procedural roofs, resizes geometry live along arrow axis.
   * For walls/floors, places subsequent duplicate pieces as user pulls along axis.
   */
  public updateDrag(
    rayOrigin: THREE.Vector3,
    rayDir: THREE.Vector3,
    buildingManager: BuildingManager
  ): void {
    if (!this.isDragging || !this.dragSide || !this.selectedPiece) return;

    if (isProceduralRoofPiece(this.selectedPiece.type) && this.startRoofConfig) {
      const ray = new THREE.Ray(rayOrigin, rayDir);
      const currentHit = new THREE.Vector3();
      if (!ray.intersectPlane(this.dragPlane, currentHit)) return;

      const delta = currentHit.clone().sub(this.dragStartIntersection);
      const stepNorm = this.dragStepVectorWorld.clone().normalize();
      const projectedDist = delta.dot(stepNorm);

      const isWallOrFloor = isSelectableWallPiece(this.selectedPiece.type) ||
        this.selectedPiece.type === BuildingPieceType.WOOD_FLOOR_2X2 ||
        this.selectedPiece.type === BuildingPieceType.WOOD_FLOOR_1X1 ||
        this.selectedPiece.type === BuildingPieceType.STONE_FOUNDATION_2X2;
      const snapStep = isWallOrFloor ? 0.5 : (this.selectedPiece.roofConfig?.snapSize || 0.5);
      const heightSnapStep = 0.25;

      const steps = Math.round(projectedDist / snapStep);
      const heightSteps = Math.round(projectedDist / heightSnapStep);
      const activeStep = this.dragSide === 'top' ? heightSteps : steps;

      const cfg = this.startRoofConfig;
      let minX = cfg.minX;
      let maxX = cfg.maxX;
      let minZ = cfg.minZ;
      let maxZ = cfg.maxZ;
      let height = cfg.height;

      switch (this.dragSide) {
        case 'left':
          minX = Math.min(maxX - (cfg.minSize || 0.2), cfg.minX - steps * snapStep);
          break;
        case 'right':
          maxX = Math.max(minX + (cfg.minSize || 0.2), cfg.maxX + steps * snapStep);
          break;
        case 'backward':
          minZ = Math.min(maxZ - (cfg.minSize || 0.2), cfg.minZ - steps * snapStep);
          break;
        case 'forward':
          maxZ = Math.max(minZ + (cfg.minSize || 0.2), cfg.maxZ + steps * snapStep);
          break;
        case 'top':
          height = Math.min(cfg.maxHeight || 5.0, Math.max(cfg.minHeight || 0.1, cfg.height + heightSteps * heightSnapStep));
          break;
      }

      // Live visual geometry update (fast 60fps, updatePhysics = false)
      buildingManager.updateRoofConfig(this.selectedPiece.id, { minX, maxX, minZ, maxZ, height }, false);
      this.rebuildVisuals();

      // Clean, throttled audio feedback on snap step threshold changes
      const now = performance.now();
      if (activeStep !== this.lastAudioStep && now - this.lastAudioTime > 120) {
        audioEngine.playBuildPlace(true);
        this.lastAudioStep = activeStep;
        this.lastAudioTime = now;
      }
      return;
    }

    // Handle 2D Rectangular Drag-to-Duplicate for floor corner arrows
    if (isCornerSide(this.dragSide)) {
      const ray = new THREE.Ray(rayOrigin, rayDir);
      const currentHit = new THREE.Vector3();
      if (!ray.intersectPlane(this.dragPlane, currentHit)) return;

      const delta = currentHit.clone().sub(this.selectedPiece.position);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.selectedPiece.quaternion);
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.selectedPiece.quaternion);
      const localDeltaX = delta.dot(right);
      const localDeltaZ = delta.dot(forward);

      const { signX, signZ } = getCornerSigns(this.dragSide);
      const dim = getPieceDimensions(this.selectedPiece.type, this.selectedPiece);
      const stepX = dim.x;
      const stepZ = dim.z;

      const dragX = localDeltaX * signX;
      const dragZ = localDeltaZ * signZ;

      const maxSpan = 12;
      const countX = Math.min(maxSpan, Math.max(0, Math.floor((dragX + stepX * 0.4) / stepX)));
      const countZ = Math.min(maxSpan, Math.max(0, Math.floor((dragZ + stepZ * 0.4) / stepZ)));

      let placedNewCount = 0;
      for (let ix = 0; ix <= countX; ix++) {
        for (let iz = 0; iz <= countZ; iz++) {
          if (ix === 0 && iz === 0) continue;
          const offset = new THREE.Vector3(ix * signX * stepX, 0, iz * signZ * stepZ);
          if (this.isDirectionFree(offset, dim)) {
            const worldOffset = offset.clone().applyQuaternion(this.selectedPiece.quaternion);
            const newPos = this.selectedPiece.position.clone().add(worldOffset);
            if (!isPieceBelowSurface(this.selectedPiece.type, newPos, this.selectedPiece.quaternion, this.selectedPiece)) {
              const newPiece = buildingManager.placePiece(this.selectedPiece.type, newPos, this.selectedPiece.quaternion);
              if (newPiece) {
                buildingManager.copyPieceStyle(this.selectedPiece.id, newPiece.id);
                placedNewCount++;
                this.dragPiecesPlacedCount++;
              }
            }
          }
        }
      }

      if (placedNewCount > 0) {
        const now = performance.now();
        if (now - this.lastAudioTime > 100) {
          audioEngine.playBuildPlace(true);
          this.lastAudioTime = now;
        }
        if (this.selectedPiece.type === BuildingPieceType.WOOD_FLOOR_2X2 || this.selectedPiece.type === BuildingPieceType.WOOD_FLOOR_1X1) {
          buildingManager.confirmFloors();
        } else if (this.selectedPiece.type === BuildingPieceType.STONE_FOUNDATION_2X2) {
          buildingManager.confirmFoundations();
        }
        this.rebuildVisuals();
      }
      return;
    }

    const ray = new THREE.Ray(rayOrigin, rayDir);
    const currentHit = new THREE.Vector3();
    if (!ray.intersectPlane(this.dragPlane, currentHit)) return;

    const delta = currentHit.clone().sub(this.dragStartIntersection);
    const stepNorm = this.dragStepVectorWorld.clone().normalize();
    const projectedDist = delta.dot(stepNorm);

    // If mouse has dragged at least 70% of a full module step distance, place the next piece
    if (projectedDist >= this.dragStepDistance * 0.7) {
      const placed = this.extendSelectedPiece(this.dragSide, buildingManager);
      if (placed) {
        this.dragPiecesPlacedCount++;
        // Advance starting point forward along the step direction
        this.dragStartIntersection.addScaledVector(stepNorm, this.dragStepDistance);
      }
    }
  }

  /**
   * Ends the drag gesture.
   */
  public endDrag(buildingManager: BuildingManager): void {
    if (this.selectedPiece && isProceduralRoofPiece(this.selectedPiece.type)) {
      // Rebuild Rapier physics collider on drag release for finalized geometry
      buildingManager.updateRoofConfig(this.selectedPiece.id, {}, true);
    } else if (this.selectedPiece && this.dragSide && isCornerSide(this.dragSide)) {
      if (this.selectedPiece.type === BuildingPieceType.WOOD_FLOOR_2X2 || this.selectedPiece.type === BuildingPieceType.WOOD_FLOOR_1X1) {
        buildingManager.confirmFloors();
      } else if (this.selectedPiece.type === BuildingPieceType.STONE_FOUNDATION_2X2) {
        buildingManager.confirmFoundations();
      }
    } else if (this.isDragging && this.dragPiecesPlacedCount === 0 && this.dragSide) {
      this.extendSelectedPiece(this.dragSide, buildingManager);
    }
    this.isDragging = false;
    this.dragSide = null;
    this.dragPiecesPlacedCount = 0;
    this.startRoofConfig = null;
    this.lastAudioStep = 0;
  }

  /**
   * Extends the selected piece along the chosen arrow side.
   * For procedural roofs: updates geometry dimensions in-place!
   * For corner arrows: duplicates in 2x2 rectangular block!
   * For standard pieces: places an adjacent duplicate piece.
   */
  public extendSelectedPiece(side: ArrowSide, buildingManager: BuildingManager): BuiltPiece | null {
    if (!this.selectedPiece) return null;
    if (buildingManager && !this.buildingManager) {
      this.buildingManager = buildingManager;
    }

    // Diagonal corner arrows on floors: 2x2 rectangular duplicate in that quadrant
    if (isCornerSide(side)) {
      const dim = getPieceDimensions(this.selectedPiece.type, this.selectedPiece);
      const W = dim.x;
      const L = dim.z;
      const { signX, signZ } = getCornerSigns(side);

      const targetOffsets = [
        new THREE.Vector3(signX * W, 0, 0),
        new THREE.Vector3(0, 0, signZ * L),
        new THREE.Vector3(signX * W, 0, signZ * L),
      ];

      let lastPlaced: BuiltPiece | null = null;
      for (const offset of targetOffsets) {
        if (this.isDirectionFree(offset, dim)) {
          const worldOffset = offset.clone().applyQuaternion(this.selectedPiece.quaternion);
          const newPos = this.selectedPiece.position.clone().add(worldOffset);
          if (!isPieceBelowSurface(this.selectedPiece.type, newPos, this.selectedPiece.quaternion, this.selectedPiece)) {
            const newPiece = buildingManager.placePiece(
              this.selectedPiece.type,
              newPos,
              this.selectedPiece.quaternion
            );
            if (newPiece) {
              buildingManager.copyPieceStyle(this.selectedPiece.id, newPiece.id);
              lastPlaced = newPiece;
            }
          }
        }
      }

      if (lastPlaced) {
        if (this.selectedPiece.type === BuildingPieceType.WOOD_FLOOR_2X2 || this.selectedPiece.type === BuildingPieceType.WOOD_FLOOR_1X1) {
          buildingManager.confirmFloors();
        } else if (this.selectedPiece.type === BuildingPieceType.STONE_FOUNDATION_2X2) {
          buildingManager.confirmFoundations();
        }
        audioEngine.playBuildPlace();
        this.selectPiece(lastPlaced);
        return lastPlaced;
      }
      return null;
    }

    // 90-degree corner wall turn via orange arrows
    if (isWallTurnSide(side)) {
      const bestCandidate = this.getBestWallTurnCandidate(side);
      if (!bestCandidate) return null;

      const newPiece = buildingManager.placePiece(
        this.selectedPiece.type,
        bestCandidate.position,
        bestCandidate.quaternion
      );

      if (newPiece) {
        buildingManager.copyPieceStyle(this.selectedPiece.id, newPiece.id);
        audioEngine.playBuildPlace();
        this.selectPiece(newPiece);
        return newPiece;
      }
      return null;
    }

    // Procedural roofs: update dimensions and geometry in-place!
    if (isProceduralRoofPiece(this.selectedPiece.type)) {
      const piece = this.selectedPiece;
      const cfg = piece.roofConfig || getDefaultRoofConfig(piece.type);
      const minSize = cfg.minSize || 0.2;
      const snapSize = cfg.snapSize || 0.5;

      let minX = cfg.minX;
      let maxX = cfg.maxX;
      let minZ = cfg.minZ;
      let maxZ = cfg.maxZ;
      let height = cfg.height;

      switch (side) {
        case 'left':
          minX -= snapSize;
          if (minX > maxX - minSize) minX = maxX - minSize;
          break;
        case 'right':
          maxX += snapSize;
          if (maxX < minX + minSize) maxX = minX + minSize;
          break;
        case 'backward':
          minZ -= snapSize;
          if (minZ > maxZ - minSize) minZ = maxZ - minSize;
          break;
        case 'forward':
          maxZ += snapSize;
          if (maxZ < minZ + minSize) maxZ = minZ + minSize;
          break;
        case 'top':
          height = Math.min(cfg.maxHeight || 5.0, Math.max(cfg.minHeight || 0.1, height + 0.25));
          break;
      }

      buildingManager.updateRoofConfig(piece.id, { minX, maxX, minZ, maxZ, height });
      this.rebuildVisuals();
      return piece;
    }

    // Standard walls/floors/foundations: place adjacent piece
    const arrowData = this.arrows.find((a) => a.side === side);
    if (!arrowData) return null;

    const dim = getPieceDimensions(this.selectedPiece.type, this.selectedPiece);
    if (!this.isDirectionFree(arrowData.targetLocalOffset, dim)) {
      return null;
    }

    // Convert local offset to world position using the selected piece's orientation
    const worldOffset = arrowData.targetLocalOffset.clone().applyQuaternion(this.selectedPiece.quaternion);
    const newPosition = this.selectedPiece.position.clone().add(worldOffset);

    // Strictly verify piece is not placed below the platform surface
    if (isPieceBelowSurface(this.selectedPiece.type, newPosition, this.selectedPiece.quaternion, this.selectedPiece)) {
      return null;
    }

    // Place identical piece
    const newPiece = buildingManager.placePiece(
      this.selectedPiece.type,
      newPosition,
      this.selectedPiece.quaternion
    );

    if (newPiece) {
      buildingManager.copyPieceStyle(this.selectedPiece.id, newPiece.id);
      this.selectPiece(newPiece);
      audioEngine.playBuildPlace();
    }

    return newPiece;
  }

  public extendSelectedWall(side: ArrowSide, buildingManager: BuildingManager): BuiltPiece | null {
    return this.extendSelectedPiece(side, buildingManager);
  }

  /**
   * Per-frame animation, constant screen-space scale, and hover detection
   */
  public update(dt: number, rayOrigin?: THREE.Vector3, rayDirection?: THREE.Vector3, camera?: THREE.Camera): void {
    if (!this.selectedPiece || !this.containerGroup.visible) return;

    this.animTime += dt;

    // Check hover
    let currentHovered: ArrowSide | null = null;
    if (!this.isDragging && rayOrigin && rayDirection) {
      currentHovered = this.raycastArrows(rayOrigin, rayDirection);
    } else if (this.isDragging) {
      currentHovered = this.dragSide;
    }
    this.hoveredSide = currentHovered;

    // Determine camera position and FOV for distance compensation
    const camPos = new THREE.Vector3();
    let tanFovHalf = Math.tan(THREE.MathUtils.degToRad(30)); // default for 60 deg FOV

    if (camera) {
      camera.getWorldPosition(camPos);
      if ((camera as THREE.PerspectiveCamera).fov) {
        tanFovHalf = Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov * 0.5));
      }
    } else if (rayOrigin) {
      camPos.copy(rayOrigin);
    } else {
      camPos.copy(this.containerGroup.position).add(new THREE.Vector3(0, 5, 8));
    }

    // Animate arrows: subtle bounce along outward direction + hover scaling + CONSTANT SCREEN-SPACE SCALE
    const bounceOffset = Math.sin(this.animTime * 6.0) * 0.035;

    for (const arrow of this.arrows) {
      const isHovered = arrow.side === this.hoveredSide;
      const isActiveDrag = this.isDragging && arrow.side === this.dragSide;
      arrow.isHovered = isHovered;

      // Calculate distance from camera to arrow world position
      const arrowWorldPos = new THREE.Vector3();
      arrow.group.getWorldPosition(arrowWorldPos);
      const dist = Math.max(0.1, camPos.distanceTo(arrowWorldPos));

      // Constant visual scale factor: guarantees the arrow stays the exact same visual size on screen regardless of camera distance
      const constantScreenScale = dist * tanFovHalf * 0.25;

      // Position bounce
      const targetPos = arrow.baseLocalPos.clone().addScaledVector(
        arrow.direction,
        (isHovered ? bounceOffset * 1.5 + 0.05 : bounceOffset) * Math.min(constantScreenScale, 1.2)
      );
      arrow.group.position.copy(targetPos);

      // Scale group to keep constant visual size on screen regardless of distance
      const hoverScaleMultiplier = isActiveDrag ? 1.45 : isHovered ? 1.35 : 1.0;
      const finalScale = constantScreenScale * hoverScaleMultiplier;
      arrow.group.scale.set(finalScale, finalScale, finalScale);

      // Core meshes are child 2 (shaft) and child 3 (cone) in meshGroup
      const coreShaft = arrow.mesh.children[2] as THREE.Mesh;
      const coreHead = arrow.mesh.children[3] as THREE.Mesh;

      const isCorner = isCornerSide(arrow.side);
      const isWallTurn = isWallTurnSide(arrow.side);

      // Color coding:
      // - White/Cyan: Standard straight extensions
      // - Amber/Light Yellow: Diagonal floor corner arrays
      // - Vibrant Orange/Light Orange: 90-Degree Wall Corner Turns
      const defaultColor = isWallTurn ? 0xf97316 : isCorner ? 0xf59e0b : 0xffffff;
      const hoverColor = isWallTurn ? 0xfdba74 : isCorner ? 0xfef08a : 0x38bdf8;
      const activeColor = isActiveDrag ? 0xfacc15 : isHovered ? hoverColor : defaultColor;

      if (coreShaft && coreShaft.material) {
        (coreShaft.material as THREE.MeshBasicMaterial).color.setHex(activeColor);
      }
      if (coreHead && coreHead.material) {
        (coreHead.material as THREE.MeshBasicMaterial).color.setHex(activeColor);
      }
    }

    // Gentle pulse for selection outline
    if (this.selectionOutline) {
      const pulseOpacity = 0.8 + Math.sin(this.animTime * 4.0) * 0.18;
      (this.selectionOutline.material as THREE.LineBasicMaterial).opacity = pulseOpacity;
    }
  }

  public dispose(): void {
    this.deselect();
    if (this.containerGroup.parent) {
      this.containerGroup.parent.remove(this.containerGroup);
    }
  }
}
