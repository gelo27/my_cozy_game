import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FURNITURE_PIECE_DEFS, buildFurnitureTemplate, isFurniturePiece } from '../furniture/FurnitureCatalog';
import { BuildingPieceDef, BuildingPieceType, BuiltPiece, PieceCategory, SocketType, isGlassRoofPiece, isProceduralRoofPiece, shapeOf } from '../types/BuildingTypes';
import type { RoofType } from '../ProceduralRoofSystem';
import { ProceduralRoofGenerator } from '../ProceduralRoofSystem';
import { GreenhouseRoofGenerator } from '../GreenhouseRoofGenerator';
import type { ProceduralRoofConfig } from '../ProceduralRoofSystem';
import { BUILDING_CONFIG } from '../../config/constants';
import { createGlassMaterial } from '../../scene/GlassMatcap';
import { BUILDING_MATERIALS, DORMER_GLASS, GREENHOUSE_GLASS_FAR, WINDOW_GLASS_FAR, addFarGlassTwins } from './BuildingMaterials';
import { MODULE_SIZE, HALF_SIZE, WALL_THICKNESS, FLOOR_THICKNESS } from './BuildingConstants';
import { applyDefaultWallFaces } from './DefaultWallMaterials';
import type { PieceMeshTemplate } from './meshes/PieceMeshTemplate';
import { buildGreenhouseWallGeometry, GH_LEAF_W, GH_LEAF_H, GH_LEAF_Y, GH_HINGE_X, pushBox, greenhouseDoorLeafParts, greenhouseDoorFrameParts, mergeGreenhouseParts, buildGreenhouseDoorGeometry, buildGreenhouseDoorFrame, buildGreenhouseDoorLeaf } from './meshes/GreenhouseGeometry';
import { buildBayWindowGeometry, buildWindowPieceGeometry, buildSingleHungWindowPieceGeometry, buildArchedWindowPieceGeometry, buildOuterDoorFrameGeometry, buildDoorwayWallGeometry, buildSingleDoorGeometry, buildDoubleDoorGeometry, buildGrandSideliteDoorFrameGeometry, buildGrandMahoganyDoorLeaf, buildWhite2PanelDoorFrameGeometry, buildWhite2PanelDoorLeaf, buildCottageWindowDoorFrameGeometry, buildCottageWindowDoorLeaf, buildColonial6PanelDoorFrameGeometry, buildColonial6PanelDoorLeaf } from './meshes/OpeningGeometry';
import { buildStraightRailingGeometry, buildStairRailingGeometry, buildWhiteDecorativeFenceGeometry } from './meshes/RailingGeometry';

// Textures, materials, unit sizes and the mesh template type live in their own modules;
// re-exported here so existing imports of BuildingPiecesConfig keep working.
export * from './BuildingTextures';
export { BUILDING_MATERIALS, GREENHOUSE_GLASS_FAR, WINDOW_GLASS_FAR, addFarGlassTwins } from './BuildingMaterials';
export { MODULE_SIZE, HALF_SIZE, WALL_THICKNESS, FLOOR_THICKNESS } from './BuildingConstants';
export type { PieceMeshTemplate } from './meshes/PieceMeshTemplate';

function windowPieceDef(type: BuildingPieceType, name: string, ukrainianName: string, width: number, height: number, woodCost: number): BuildingPieceDef {
  const socket = (id: string, x: number, y: number, normal: THREE.Vector3, type: SocketType) => ({
    id, type, localPosition: new THREE.Vector3(x, y, 0), localNormal: normal,
    // Wall top/bottom sockets use the wall normal as their up axis. This matches the existing
    // opening pieces and keeps the window face parallel to the wall when the snap solver aligns it.
    localUp: id === 'bottom' || id === 'top' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0),
    compatibleWith: id === 'bottom'
      ? [SocketType.FLOOR_EDGE, SocketType.WALL_TOP]
      : id === 'top'
        ? [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE]
        : [SocketType.WALL_SIDE],
  });
  return {
    type, name, ukrainianName, category: PieceCategory.WINDOWS,
    dimensions: new THREE.Vector3(width, height, WALL_THICKNESS), woodCost, stoneCost: 0, maxHealth: 100,
    iconName: 'AppWindow', description: name,
    sockets: [
      socket('bottom', 0, -height / 2, new THREE.Vector3(0, -1, 0), SocketType.WALL_BOTTOM),
      socket('top', 0, height / 2, new THREE.Vector3(0, 1, 0), SocketType.WALL_TOP),
      socket('left', -width / 2, 0, new THREE.Vector3(-1, 0, 0), SocketType.WALL_SIDE),
      socket('right', width / 2, 0, new THREE.Vector3(1, 0, 0), SocketType.WALL_SIDE),
    ],
  };
}

export const BUILDING_PIECES: Record<BuildingPieceType, BuildingPieceDef> = {
  ...FURNITURE_PIECE_DEFS,
  [BuildingPieceType.WOOD_FLOOR_2X2]: {
    type: BuildingPieceType.WOOD_FLOOR_2X2,
    name: 'Wood Floor 2x2m',
    ukrainianName: 'Дерев’яна підлога 2х2м',
    category: PieceCategory.FLOORS,
    dimensions: new THREE.Vector3(MODULE_SIZE, FLOOR_THICKNESS, MODULE_SIZE),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'Square',
    description: 'Плаский дерев’яний настил для підлоги або стелі. Має 4 сокети з боків та сокети під колони.',
    sockets: [
      {
        id: 'north',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      {
        id: 'south',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      {
        id: 'east',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      {
        id: 'west',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      // Corner pillar sockets
      {
        id: 'corner_ne',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.PILLAR_BOTTOM],
      },
      {
        id: 'corner_nw',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.PILLAR_BOTTOM],
      },
      {
        id: 'corner_se',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.PILLAR_BOTTOM],
      },
      {
        id: 'corner_sw',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.PILLAR_BOTTOM],
      },
    ],
  },

  [BuildingPieceType.WOOD_FLOOR_1X1]: {
    type: BuildingPieceType.WOOD_FLOOR_1X1,
    name: 'Wood Floor 1x1m',
    ukrainianName: 'Дерев’яна підлога 1х1м',
    category: PieceCategory.FLOORS,
    dimensions: new THREE.Vector3(1.0, FLOOR_THICKNESS, 1.0),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'Square',
    description: 'Компактний плаский дерев’яний настил 1х1м для підлоги або стелі.',
    sockets: [
      {
        id: 'north',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0, 0.5),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      {
        id: 'south',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0, -0.5),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      {
        id: 'east',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      {
        id: 'west',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_2X3]: {
    type: BuildingPieceType.WOOD_WALL_2X3,
    name: 'Wood Wall 2x3m',
    ukrainianName: 'Дерев’яна стіна 2х3м',
    category: PieceCategory.WALLS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 3.0, WALL_THICKNESS),
    woodCost: 3,
    stoneCost: 0,
    maxHealth: 150,
    iconName: 'Columns2',
    description: 'Широка висока дерев’яна стіна 2х3м для створення високих поверхів та просторих залів.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -1.5, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, 1.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-1.0, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(1.0, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_1X3]: {
    type: BuildingPieceType.WOOD_WALL_1X3,
    name: 'Wood Wall 1x3m',
    ukrainianName: 'Дерев’яна стіна 1х3м',
    category: PieceCategory.WALLS,
    dimensions: new THREE.Vector3(1.0, 3.0, WALL_THICKNESS),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 120,
    iconName: 'Columns',
    description: 'Висока вертикальна дерев’яна стіна 1х3м для високих стель та фасадів.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -1.5, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, 1.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_1X2]: {
    type: BuildingPieceType.WOOD_WALL_1X2,
    name: 'Wood Wall 1x2m',
    ukrainianName: 'Дерев’яна стіна 1х2м',
    category: PieceCategory.WALLS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'Columns2',
    description: 'Вузька вертикальна дерев’яна стіна шириною 1 метр для точного планування приміщень.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_2X1]: {
    type: BuildingPieceType.WOOD_WALL_2X1,
    name: 'Wood Wall 2x1m',
    ukrainianName: 'Напівстіна 2х1м',
    category: PieceCategory.WALLS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 1.0, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 70,
    iconName: 'Columns2',
    description: 'Коротка дерев’яна напівстіна 2х1м для огорож, перил, мансардних скосів та низьких прибудов.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.5, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, 0.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_1X1]: {
    type: BuildingPieceType.WOOD_WALL_1X1,
    name: 'Wood Wall 1x1m',
    ukrainianName: 'Стіна 1х1м',
    category: PieceCategory.WALLS,
    dimensions: new THREE.Vector3(1.0, 1.0, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 60,
    iconName: 'Square',
    description: 'Компактний модуль дерев’яної стіни 1х1м для детального планування та завершення стін.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.5, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, 0.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_DOORWAY_2X2]: {
    type: BuildingPieceType.WOOD_WALL_DOORWAY_2X2,
    name: 'Wood Wall with Doorway 2x2m',
    ukrainianName: 'Стіновий пройм 2х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(MODULE_SIZE, MODULE_SIZE, WALL_THICKNESS),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'DoorOpen',
    description: 'Дверна стінова коробка 2х2м під двостулкові двері з декоративною лиштвою.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_DOORWAY_1X2]: {
    type: BuildingPieceType.WOOD_WALL_DOORWAY_1X2,
    name: 'Wood Wall with Doorway 1x2m',
    ukrainianName: 'Стіновий пройм 1х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'DoorOpen',
    description: 'Дверна стінова коробка 1х2м під одинарні двері з дерев’яним фрамужним лутком.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_DOOR_SINGLE]: {
    type: BuildingPieceType.WOOD_DOOR_SINGLE,
    name: 'Wood Door Single 1x2m',
    ukrainianName: 'Одинарні двері 1х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, 0.08),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'DoorOpen',
    description: 'Одинарні дерев’яні двері 1х2м з кованими петлями, металевою ручкою та механізмом обертання.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_DOOR_DOUBLE]: {
    type: BuildingPieceType.WOOD_DOOR_DOUBLE,
    name: 'Wood Door Double 2x2m',
    ukrainianName: 'Двостулкові двері 2х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(MODULE_SIZE, MODULE_SIZE, 0.08),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'DoorOpen',
    description: 'Двостулкові дерев’яні парадні двері 2х2м із зустрічним відкриттям стей та масивними засувами.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.DOOR_GRAND_SIDELITES_2X2]: {
    type: BuildingPieceType.DOOR_GRAND_SIDELITES_2X2,
    name: 'Grand Entry Door with Sidelites 2x2m',
    ukrainianName: 'Парадні двері з бічним склінням 2х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(MODULE_SIZE, MODULE_SIZE, 0.08),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 120,
    iconName: 'DoorOpen',
    description: 'Розкішні вхідні двері з масиву червоного дерева з декоративними філенками, бічними вікнами-фрамугами та темною бронзовою ручкою.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.DOOR_WHITE_2PANEL_1X2]: {
    type: BuildingPieceType.DOOR_WHITE_2PANEL_1X2,
    name: 'White 2-Panel Shaker Door 1x2m',
    ukrainianName: 'Білі двері 2-панельні 1х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, 0.08),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'DoorClosed',
    description: 'Елегантні білі міжкімнатні двері в стилі шейкер з двома втопленими панелями та витонченою золотистою ручкою.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2]: {
    type: BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2,
    name: 'Cottage Door with 4-Pane Window 1x2m',
    ukrainianName: 'Котеджні двері з вікном 1х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, 0.08),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 85,
    iconName: 'DoorClosed',
    description: 'Графітові двері у стилі кантрі з 4-секційним віконним склінням зверху, фільонкою знизу та золотистою нажимною ручкою.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2]: {
    type: BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2,
    name: 'Colonial 6-Panel Door 1x2m',
    ukrainianName: 'Колоніальні двері 6-панельні 1х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, 0.08),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'DoorClosed',
    description: 'Класичні кремові двері з шістьма рельєфними фільонками та круглою золотистою ручкою-кнобом.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_WINDOW_1X2]: {
    type: BuildingPieceType.WOOD_WALL_WINDOW_1X2,
    name: 'Wood Wall with Window 1x2m',
    ukrainianName: 'Стіна з вікном 1х2м',
    category: PieceCategory.WINDOWS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'AppWindow',
    description: 'Вузька дерев’яна стіна 1х2м з віконним отвором та обрамленням для природного освітлення.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_WINDOW_1X1_5]: {
    type: BuildingPieceType.WOOD_WALL_WINDOW_1X1_5,
    name: 'Wood Wall with Window 1x1.5m',
    ukrainianName: 'Вікно 1х1.5м',
    category: PieceCategory.WINDOWS,
    dimensions: new THREE.Vector3(1.0, 1.5, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'AppWindow',
    description: 'Компактне вікно 1х1.5м з рамою та склінням для встановлення у стіни.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.75, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, 0.75, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_WINDOW_2X2]: {
    type: BuildingPieceType.WOOD_WALL_WINDOW_2X2,
    name: 'Wood Wall with Window 2x2m',
    ukrainianName: 'Стіна з вікном 2х2м',
    category: PieceCategory.WINDOWS,
    dimensions: new THREE.Vector3(MODULE_SIZE, MODULE_SIZE, WALL_THICKNESS),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'AppWindow',
    description: 'Стандартна дерев’яна стіна 2х2м з великим віконним отвором, підвіконням та перекладиною.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_WINDOW_2X4]: {
    type: BuildingPieceType.WOOD_WALL_WINDOW_2X4,
    name: 'Wood Wall with Window 2x4m',
    ukrainianName: 'Висока стіна з вікном 2х4м',
    category: PieceCategory.WINDOWS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 4.0, WALL_THICKNESS),
    woodCost: 4,
    stoneCost: 0,
    maxHealth: 180,
    iconName: 'AppWindow',
    description: 'Висока стіна 2х4м з великим ошатним вікном для панорамного освітлення великих приміщень.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -2.0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, 2.0, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_WINDOW_SINGLE_HUNG]: windowPieceDef(BuildingPieceType.WOOD_WALL_WINDOW_SINGLE_HUNG, 'Single-Hung Window 1x2m', 'Одностулкове підвісне вікно 1х2м', 1, 2, 1),
  [BuildingPieceType.WOOD_WALL_WINDOW_ARCH]: windowPieceDef(BuildingPieceType.WOOD_WALL_WINDOW_ARCH, 'Arched Window 1x2m', 'Аркове вікно 1х2м', 1, 2, 2),
  [BuildingPieceType.WOOD_WALL_WINDOW_PALLADIAN]: windowPieceDef(BuildingPieceType.WOOD_WALL_WINDOW_PALLADIAN, 'Palladian Window 1x2m', 'Паладіанське вікно 1х2м', 1, 2, 3),
  [BuildingPieceType.WOOD_WALL_WINDOW_BAY]: windowPieceDef(BuildingPieceType.WOOD_WALL_WINDOW_BAY, 'Bay Window 2.5x1.5m', 'Еркерне вікно 2,5×1,5 м', 2.5, 1.5, 5),
  [BuildingPieceType.WOOD_WALL_WINDOW_ROUND]: windowPieceDef(BuildingPieceType.WOOD_WALL_WINDOW_ROUND, 'Round Window 1x1m', 'Кругле вікно 1х1м', 1, 1, 2),

  [BuildingPieceType.WOOD_STAIRS_2X2]: {
    type: BuildingPieceType.WOOD_STAIRS_2X2,
    name: 'Wood Stairs 2x2m',
    ukrainianName: 'Дерев’яні сходи 2х2м',
    category: PieceCategory.STAIRS,
    dimensions: new THREE.Vector3(MODULE_SIZE, MODULE_SIZE, MODULE_SIZE),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'TrendingUp',
    description: 'Зручні сходи з 5 сходинками для підйому на наступний поверх або дах (2м висоти).',
    isWalkableSlope: true,
    sockets: [
      {
        id: 'bottom',
        type: SocketType.STAIRS_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.STAIRS_TOP],
      },
      {
        id: 'top',
        type: SocketType.STAIRS_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.STAIRS_BOTTOM],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_STAIRS_2X1]: {
    type: BuildingPieceType.WOOD_STAIRS_2X1,
    name: 'Wood Stairs 2x1m',
    ukrainianName: 'Дерев’яні сходи 2х1м',
    category: PieceCategory.STAIRS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 1.0, MODULE_SIZE),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'TrendingUp',
    description: 'Компактні сходи висотою в 1 одиницю (1м) для терас, переходів між фундаментами та півповерхів.',
    isWalkableSlope: true,
    sockets: [
      {
        id: 'bottom',
        type: SocketType.STAIRS_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.5, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.STAIRS_TOP],
      },
      {
        id: 'top',
        type: SocketType.STAIRS_TOP,
        localPosition: new THREE.Vector3(0, 0.5, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.STAIRS_BOTTOM],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_STAIRS_2X3]: {
    type: BuildingPieceType.WOOD_STAIRS_2X3,
    name: 'Wood Stairs 2x3m',
    ukrainianName: 'Дерев’яні сходи 2х3м (висота 3м)',
    category: PieceCategory.STAIRS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 3.0, 3.0),
    woodCost: 3,
    stoneCost: 0,
    maxHealth: 120,
    iconName: 'TrendingUp',
    description: 'Високі сходи висотою в 3 одиниці (3м) з комфортним 45° кутом нахилу як у сходів 2х2м.',
    isWalkableSlope: true,
    sockets: [
      {
        id: 'bottom',
        type: SocketType.STAIRS_BOTTOM,
        localPosition: new THREE.Vector3(0, -1.5, -1.5),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.STAIRS_TOP],
      },
      {
        id: 'top',
        type: SocketType.STAIRS_TOP,
        localPosition: new THREE.Vector3(0, 1.5, 1.5),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.STAIRS_BOTTOM],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_ROOF_26]: {
    type: BuildingPieceType.WOOD_ROOF_26,
    name: 'Wood Roof 26°',
    ukrainianName: 'Дах зі стріхою 26°',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.9, MODULE_SIZE),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'Home',
    description: 'Пологий скандинавський дах зі стріхою (26 градусів) для затишних хатин та залів.',
    sockets: [
      {
        id: 'eave',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, -0.45, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.ROOF_RIDGE],
      },
      {
        id: 'ridge',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.45, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, -1),
        compatibleWith: [SocketType.ROOF_RIDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  // =========================================================================
  // HEARTOPIA PROCEDURAL ROOF PIECES (2-Pitched Gable & 4-Pitched Hipped)
  // =========================================================================
  [BuildingPieceType.ROOF_GABLE_2X2]: {
    type: BuildingPieceType.ROOF_GABLE_2X2,
    name: 'Gable Roof',
    ukrainianName: 'Двосхилий дах',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, MODULE_SIZE),
    woodCost: 4,
    stoneCost: 0,
    maxHealth: 150,
    iconName: 'Home',
    description: 'Процедурний двосхилий дах Heartopia з налаштовуваними розмірами, схилами, карнизами та коньком.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_front',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
      {
        id: 'ridge_back',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
    ],
  },

  [BuildingPieceType.ROOF_GABLE_2X4]: {
    type: BuildingPieceType.ROOF_GABLE_2X4,
    name: 'Gable Roof 2x4m',
    ukrainianName: 'Двосхилий дах 2х4м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, 4.0),
    woodCost: 6,
    stoneCost: 0,
    maxHealth: 200,
    iconName: 'Home',
    description: 'Видовжений двосхилий 2-похилий дах Heartopia для стандартних прямокутних кімнат та будинків.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_front',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, -2.0),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
      {
        id: 'ridge_back',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, 2.0),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
    ],
  },

  [BuildingPieceType.ROOF_GABLE_4X4]: {
    type: BuildingPieceType.ROOF_GABLE_4X4,
    name: 'Gable Roof 4x4m',
    ukrainianName: 'Великий двосхилий дах 4х4м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(4.0, 1.6, 4.0),
    woodCost: 10,
    stoneCost: 0,
    maxHealth: 300,
    iconName: 'Home',
    description: 'Масивний двосхилий 2-похилий дах Heartopia для перекриття двоповерхових залів та котеджів 4х4м.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-2.0, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(2.0, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_front',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 1.6, -2.0),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
      {
        id: 'ridge_back',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 1.6, 2.0),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
    ],
  },

  [BuildingPieceType.ROOF_HIP_2X2]: {
    type: BuildingPieceType.ROOF_HIP_2X2,
    name: 'Hipped Roof',
    ukrainianName: 'Вальмовий дах',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, MODULE_SIZE),
    woodCost: 5,
    stoneCost: 0,
    maxHealth: 160,
    iconName: 'Shield',
    description: 'Процедурний 4-схилий вальмовий дах Heartopia з автоматичною орієнтацією конька та крокв.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_north',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_south',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_west',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_east',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.ROOF_HIP_2X4]: {
    type: BuildingPieceType.ROOF_HIP_2X4,
    name: 'Hipped Roof 2x4m',
    ukrainianName: 'Вальмовий 4-похилий дах 2х4м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, 4.0),
    woodCost: 7,
    stoneCost: 0,
    maxHealth: 220,
    iconName: 'Shield',
    description: 'Вальмовий чотирисхилий дах Heartopia для подовжених будинків з двома трапеціями та двома вальмами.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_north',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -2.0),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_south',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, 2.0),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_west',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_east',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.ROOF_HIP_4X4]: {
    type: BuildingPieceType.ROOF_HIP_4X4,
    name: 'Hipped Roof 4x4m',
    ukrainianName: 'Великий вальмовий дах 4х4м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(4.0, 1.6, 4.0),
    woodCost: 12,
    stoneCost: 0,
    maxHealth: 320,
    iconName: 'Shield',
    description: 'Величний 4-похилий шатровий дах Heartopia для вілл та маєтків 4х4м з виразним карнизом.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_north',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -2.0),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_south',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, 2.0),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_west',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-2.0, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_east',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(2.0, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  // BROKEN-PITCH ROOFS (ЛАМАНИЙ / МАНСАРДНИЙ ДАХ)
  [BuildingPieceType.ROOF_GAMBREL_2X2]: {
    type: BuildingPieceType.ROOF_GAMBREL_2X2,
    name: 'Gambrel Roof',
    ukrainianName: 'Ламаний дах',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, MODULE_SIZE),
    woodCost: 4,
    stoneCost: 0,
    maxHealth: 150,
    iconName: 'Home',
    description: 'Двосхилий дах із переломом: круті нижні схили й пологий верх, як у старій стодолі. Дає високе горище.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_front',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
      {
        id: 'ridge_back',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
    ],
  },

  [BuildingPieceType.ROOF_MANSARD_2X2]: {
    type: BuildingPieceType.ROOF_MANSARD_2X2,
    name: 'Mansard Roof',
    ukrainianName: 'Мансардний дах',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, MODULE_SIZE),
    woodCost: 5,
    stoneCost: 0,
    maxHealth: 160,
    iconName: 'Shield',
    description: 'Чотирисхилий дах із переломом: майже вертикальні нижні схили з усіх боків і пологий верх. Під ним цілий мансардний поверх.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_north',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_south',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_west',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_east',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  // 1-PITCHED SHED ROOFS (ОДНОСХИЛИЙ ДАХ)
  [BuildingPieceType.ROOF_SHED_2X2]: {
    type: BuildingPieceType.ROOF_SHED_2X2,
    name: 'Shed Roof 2x2m',
    ukrainianName: 'Односхилий дах 2х2м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, MODULE_SIZE),
    woodCost: 4,
    stoneCost: 0,
    maxHealth: 150,
    iconName: 'Home',
    description: 'Сучасний односхилий дах у стилі Sims 4 для веранд, прибудов та сучасних котеджів 2х2м з текстурованими коньками та карнизами.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_low',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_high',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_RIDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0.425, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0.425, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.ROOF_SHED_2X4]: {
    type: BuildingPieceType.ROOF_SHED_2X4,
    name: 'Shed Roof 2x4m',
    ukrainianName: 'Односхилий дах 2х4м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, 4.0),
    woodCost: 7,
    stoneCost: 0,
    maxHealth: 220,
    iconName: 'Home',
    description: 'Подовжений односхилий дах 2х4м для великих терас, гаражів та навісів.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_low',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -2.0),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_high',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, 2.0),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_RIDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0.425, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0.425, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.ROOF_SHED_4X4]: {
    type: BuildingPieceType.ROOF_SHED_4X4,
    name: 'Shed Roof 4x4m',
    ukrainianName: 'Великий односхилий дах 4х4м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(4.0, 1.6, 4.0),
    woodCost: 12,
    stoneCost: 0,
    maxHealth: 320,
    iconName: 'Home',
    description: 'Масивний односхилий дах 4х4м для архітектурних студій, вілл та сучасних просторів.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_low',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -2.0),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_high',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 1.6, 2.0),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_RIDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-2.0, 0.8, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(2.0, 0.8, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.WOOD_POLE_2M]: {
    type: BuildingPieceType.WOOD_POLE_2M,
    name: 'Wood Pole 2m',
    ukrainianName: 'Кругла колона 2м',
    category: PieceCategory.PILLARS,
    dimensions: new THREE.Vector3(0.24, MODULE_SIZE, 0.24),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 120,
    iconName: 'MinusVertical',
    description: 'Опорна вертикальна балка / колона для підтримки навісів, балконів та перекриттів.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.PILLAR_TOP],
      },
      {
        id: 'top',
        type: SocketType.PILLAR_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.PILLAR_BOTTOM, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.CHECKER_PILLAR_1M]: {
    type: BuildingPieceType.CHECKER_PILLAR_1M,
    name: 'Square Checker Pillar 1m',
    ukrainianName: 'Квадратна опора 1м (Чекер)',
    category: PieceCategory.PILLARS,
    dimensions: new THREE.Vector3(0.4, 1.0, 0.4),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 150,
    iconName: 'Box',
    description: 'Квадратна опора висотою 1м із контрастною текстурою-чекером та можливістю дублювання вгору/вниз.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.5, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.PILLAR_TOP],
      },
      {
        id: 'top',
        type: SocketType.PILLAR_TOP,
        localPosition: new THREE.Vector3(0, 0.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.PILLAR_BOTTOM, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.CORNER_RUSTICATED_QUOIN_1M]: {
    type: BuildingPieceType.CORNER_RUSTICATED_QUOIN_1M,
    name: 'Corner Rusticated Quoin 1m',
    ukrainianName: 'Кутовий фасадний босаж (Русти) 1м',
    category: PieceCategory.PILLARS,
    dimensions: new THREE.Vector3(0.4, 1.0, 0.4),
    woodCost: 0,
    stoneCost: 2,
    maxHealth: 200,
    iconName: 'Box',
    description: 'Декоративний кутовий фасадний блок (русти/босаж) висотою 1м із рельефними кам’яними блоками.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.5, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.PILLAR_TOP],
      },
      {
        id: 'top',
        type: SocketType.PILLAR_TOP,
        localPosition: new THREE.Vector3(0, 0.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.PILLAR_BOTTOM, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.STONE_FOUNDATION_2X2]: {
    type: BuildingPieceType.STONE_FOUNDATION_2X2,
    name: 'Stone Foundation 2x2m',
    ukrainianName: 'Кам’яний фундамент 2х2м',
    category: PieceCategory.FLOORS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 1.0, MODULE_SIZE),
    woodCost: 0,
    stoneCost: 4,
    maxHealth: 250,
    iconName: 'Box',
    description: 'Міцний кам’яний блок фундаменту для вирівнювання рельєфу та стійкості конструкцій.',
    sockets: [
      {
        id: 'top',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.PILLAR_BOTTOM],
      },
      {
        id: 'side_n',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE],
      },
      {
        id: 'side_s',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE],
      },
      {
        id: 'side_e',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE],
      },
      {
        id: 'side_w',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE],
      },
    ],
  },

  // =========================================================================
  // RAILINGS & BALUSTRADES (WOOD_RAILING_2M, WOOD_RAILING_1M, WOOD_STAIR_RAILING_2X2)
  // =========================================================================
  [BuildingPieceType.WOOD_RAILING_2M]: {
    type: BuildingPieceType.WOOD_RAILING_2M,
    name: 'Wood Railing 2m',
    ukrainianName: 'Дерев’яні перила 2м',
    category: PieceCategory.RAILINGS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.95, 0.12),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'Fence',
    description: 'Прямі перила заввишки ~0.95м для відкритих терас, балконів та веранд. Запобігають падінню персонажа.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.475, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_RAILING_1M]: {
    type: BuildingPieceType.WOOD_RAILING_1M,
    name: 'Wood Railing 1m',
    ukrainianName: 'Дерев’яні перила 1м',
    category: PieceCategory.RAILINGS,
    dimensions: new THREE.Vector3(1.0, 0.95, 0.12),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 60,
    iconName: 'Fence',
    description: 'Короткі прямі перила заввишки ~0.95м для кутів, вузьких секцій або балконів. Запобігають падінню персонажа.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.475, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_STAIR_RAILING_2X2]: {
    type: BuildingPieceType.WOOD_STAIR_RAILING_2X2,
    name: 'Wood Stair Railing 2x2m',
    ukrainianName: 'Похилі сходові перила 2х2м',
    category: PieceCategory.RAILINGS,
    dimensions: new THREE.Vector3(0.12, MODULE_SIZE, MODULE_SIZE),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'TrendingUp',
    description: 'Похилі перила під кутом 45° для захисту країв сходових маршів 2х2м. Кріпляться до сокетів сходів side_left або side_right.',
    sockets: [
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WHITE_DECORATIVE_FENCE_1M]: {
    type: BuildingPieceType.WHITE_DECORATIVE_FENCE_1M,
    name: 'White Decorative Fence 1x1',
    ukrainianName: 'Декоративний білий заборчик 1х1',
    category: PieceCategory.RAILINGS,
    dimensions: new THREE.Vector3(1.0, 0.95, 0.12),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 70,
    iconName: 'Fence',
    description: 'Ошатний білий декоративний парканчик 1х1м з фігурними штахетниками та пірамідальними навершями стовпчиків. Чудово пасує для огорожі подвір’я, клумб, садів та відкритих зон відпочинку.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.475, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  // ===========================================================================
  // GREENHOUSE (glasshouse). Sockets are copied from the wooden twin after this table.
  // ===========================================================================
  [BuildingPieceType.GLASS_WALL_2X3]: {
    type: BuildingPieceType.GLASS_WALL_2X3,
    name: 'Glass Wall 2x3m',
    ukrainianName: 'Скляна стіна 2х3м',
    category: PieceCategory.GREENHOUSE,
    dimensions: new THREE.Vector3(MODULE_SIZE, 3.0, WALL_THICKNESS),
    woodCost: 2,
    stoneCost: 1,
    maxHealth: 80,
    iconName: 'PanelsTopLeft',
    description: 'Скляна панель теплиці 2х3м у білій рамі: пропускає світло, захищає від дощу та снігу.',
    sockets: [],
  },

  [BuildingPieceType.GLASS_WALL_1X3]: {
    type: BuildingPieceType.GLASS_WALL_1X3,
    name: 'Glass Wall 1x3m',
    ukrainianName: 'Скляна стіна 1х3м',
    category: PieceCategory.GREENHOUSE,
    dimensions: new THREE.Vector3(1.0, 3.0, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 1,
    maxHealth: 60,
    iconName: 'PanelsTopLeft',
    description: 'Вузька скляна панель теплиці 1х3м.',
    sockets: [],
  },

  [BuildingPieceType.GLASS_DOORWAY_1X3]: {
    type: BuildingPieceType.GLASS_DOORWAY_1X3,
    name: 'Glass Doorway 1x3m',
    ukrainianName: 'Скляний вхід 1х3м',
    category: PieceCategory.GREENHOUSE,
    dimensions: new THREE.Vector3(1.0, 3.0, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 1,
    maxHealth: 60,
    iconName: 'DoorOpen',
    description: 'Вхід у теплицю: рама зі скляною фрамугою над прохідним отвором.',
    sockets: [],
  },

  [BuildingPieceType.GLASS_DOOR_1X3]: {
    type: BuildingPieceType.GLASS_DOOR_1X3,
    name: 'Glass Door 1x3m',
    ukrainianName: 'Скляні двері 1х3м',
    category: PieceCategory.GREENHOUSE,
    dimensions: new THREE.Vector3(1.0, 3.0, WALL_THICKNESS),
    woodCost: 2,
    stoneCost: 1,
    maxHealth: 70,
    iconName: 'DoorClosed',
    description: 'Засклені двері теплиці зі стулкою, що відчиняється, та скляною фрамугою над нею.',
    sockets: [],
  },

  [BuildingPieceType.GLASS_ROOF_GABLE_2X2]: {
    type: BuildingPieceType.GLASS_ROOF_GABLE_2X2,
    name: 'Glass Gable Roof',
    ukrainianName: 'Скляний двосхилий дах',
    category: PieceCategory.GREENHOUSE,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, MODULE_SIZE),
    woodCost: 2,
    stoneCost: 2,
    maxHealth: 120,
    iconName: 'Home',
    description: 'Засклений двосхилий дах теплиці; розтягується стрілками як звичайний дах.',
    sockets: [],
  },

  [BuildingPieceType.GLASS_ROOF_SHED_2X2]: {
    type: BuildingPieceType.GLASS_ROOF_SHED_2X2,
    name: 'Glass Lean-to Roof',
    ukrainianName: 'Скляний односхилий дах',
    category: PieceCategory.GREENHOUSE,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, MODULE_SIZE),
    woodCost: 2,
    stoneCost: 2,
    maxHealth: 120,
    iconName: 'Home',
    description: 'Засклений односхилий дах для прибудованої до стіни теплиці.',
    sockets: [],
  },
};

// Glass pieces snap exactly like their wooden twins
for (const def of Object.values(BUILDING_PIECES)) {
  const twin = shapeOf(def.type);
  if (twin !== def.type) def.sockets = BUILDING_PIECES[twin].sockets;
}

let ghDoorFrameTpl: PieceMeshTemplate | null = null;
let ghDoorLeafTpl: PieceMeshTemplate | null = null;

const TEMPLATE_CACHE = new Map<BuildingPieceType, PieceMeshTemplate>();

/**
 * Builds and caches optimized merged geometries with multi-material groups for each piece type.
 * Ensures that 250+ building pieces share the exact same GPU vertex buffers and only require
 * 1 single Mesh per placed element instead of 5-8 sub-meshes, saving thousands of draw calls.
 */
export function getPieceMeshTemplate(type: BuildingPieceType): PieceMeshTemplate {
  const cached = TEMPLATE_CACHE.get(type);
  if (cached) return cached;

  const template = isFurniturePiece(type) ? buildFurnitureTemplate(type) : buildTemplateForPiece(type);
  template.geometry.computeBoundingBox();
  template.boundingBox = template.geometry.boundingBox!.clone();
  TEMPLATE_CACHE.set(type, template);
  return template;
}


function buildTemplateForPiece(type: BuildingPieceType): PieceMeshTemplate {
  switch (type) {
    case BuildingPieceType.GLASS_WALL_2X3:
      return buildGreenhouseWallGeometry(MODULE_SIZE, 3.0);
    case BuildingPieceType.GLASS_WALL_1X3:
      return buildGreenhouseWallGeometry(1.0, 3.0);
    case BuildingPieceType.GLASS_DOORWAY_1X3:
      return buildGreenhouseWallGeometry(1.0, 3.0, true);
    case BuildingPieceType.GLASS_DOOR_1X3:
      return buildGreenhouseDoorGeometry();
    case BuildingPieceType.GLASS_ROOF_GABLE_2X2:
    case BuildingPieceType.GLASS_ROOF_SHED_2X2: {
      // Real glasshouse roof mesh: [glass, wooden glazing frame]
      const geo = createRoofGeometry(type, getDefaultRoofConfig(type));
      return {
        geometry: geo,
        materials: [BUILDING_MATERIALS.greenhouseGlass, BUILDING_MATERIALS.greenhouseFrame],
        boundingBox: new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute),
      };
    }

    case BuildingPieceType.DOOR_GRAND_SIDELITES_2X2: {
      const outerFrameTpl = buildGrandSideliteDoorFrameGeometry();
      const leafTpl = buildGrandMahoganyDoorLeaf();

      const leafGeo = leafTpl.geometry.clone();
      leafGeo.translate(0, -0.04, 0);

      const mergedGeo = mergeGeometries([outerFrameTpl.geometry.clone(), leafGeo], true)!;
      leafGeo.dispose();

      return {
        geometry: mergedGeo,
        materials: [
          BUILDING_MATERIALS.woodMahogany,
          BUILDING_MATERIALS.windowGlass,
          BUILDING_MATERIALS.woodMahogany,
          BUILDING_MATERIALS.bronzeHardware,
        ],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.DOOR_WHITE_2PANEL_1X2: {
      const outerFrameTpl = buildWhite2PanelDoorFrameGeometry();
      const leafTpl = buildWhite2PanelDoorLeaf();

      const leafGeo = leafTpl.geometry.clone();
      leafGeo.translate(0, -0.06, 0);

      const mergedGeo = mergeGeometries([outerFrameTpl.geometry.clone(), leafGeo], true)!;
      leafGeo.dispose();

      return {
        geometry: mergedGeo,
        materials: [BUILDING_MATERIALS.woodWhiteDoor, BUILDING_MATERIALS.woodWhiteDoor, BUILDING_MATERIALS.brassHardware],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2: {
      const outerFrameTpl = buildCottageWindowDoorFrameGeometry();
      const leafTpl = buildCottageWindowDoorLeaf();

      const leafGeo = leafTpl.geometry.clone();
      leafGeo.translate(0, -0.06, 0);

      const mergedGeo = mergeGeometries([outerFrameTpl.geometry.clone(), leafGeo], true)!;
      leafGeo.dispose();

      return {
        geometry: mergedGeo,
        materials: [
          BUILDING_MATERIALS.woodCharcoal,
          BUILDING_MATERIALS.woodCharcoal,
          BUILDING_MATERIALS.windowGlass,
          BUILDING_MATERIALS.brassHardware,
        ],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2: {
      const outerFrameTpl = buildColonial6PanelDoorFrameGeometry();
      const leafTpl = buildColonial6PanelDoorLeaf();

      const leafGeo = leafTpl.geometry.clone();
      leafGeo.translate(0, -0.06, 0);

      const mergedGeo = mergeGeometries([outerFrameTpl.geometry.clone(), leafGeo], true)!;
      leafGeo.dispose();

      return {
        geometry: mergedGeo,
        materials: [BUILDING_MATERIALS.woodCream, BUILDING_MATERIALS.woodCream, BUILDING_MATERIALS.brassHardware],
        boundingBox: new THREE.Box3(),
      };
    }
    case BuildingPieceType.WOOD_WALL_DOORWAY_2X2: {
      return buildDoorwayWallGeometry(MODULE_SIZE, MODULE_SIZE);
    }

    case BuildingPieceType.WOOD_WALL_DOORWAY_1X2: {
      return buildDoorwayWallGeometry(1.0, MODULE_SIZE);
    }

    case BuildingPieceType.WOOD_DOOR_SINGLE: {
      const outerFrameTpl = buildOuterDoorFrameGeometry(1.0, MODULE_SIZE);
      const leafTpl = buildSingleDoorGeometry();

      const leafGeo = leafTpl.geometry.clone();
      leafGeo.translate(0, -0.06, 0);

      const mergedGeo = mergeGeometries([outerFrameTpl.geometry.clone(), leafGeo], true)!;
      leafGeo.dispose();

      return {
        geometry: mergedGeo,
        materials: [BUILDING_MATERIALS.woodDark, BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_DOOR_DOUBLE: {
      const outerFrameTpl = buildOuterDoorFrameGeometry(MODULE_SIZE, MODULE_SIZE);
      const doubleLeafTpl = buildDoubleDoorGeometry();

      const leavesGeo = doubleLeafTpl.geometry.clone();
      leavesGeo.translate(0, -0.06, 0);

      const mergedGeo = mergeGeometries([outerFrameTpl.geometry.clone(), leavesGeo], true)!;
      leavesGeo.dispose();

      return {
        geometry: mergedGeo,
        materials: [BUILDING_MATERIALS.woodDark, BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
        boundingBox: new THREE.Box3(),
      };
    }
    case BuildingPieceType.WOOD_FLOOR_2X2: {
      // Clean, simple floor slab geometry with checker parquet texture
      const floorGeo = new THREE.BoxGeometry(MODULE_SIZE, FLOOR_THICKNESS, MODULE_SIZE);
      return {
        geometry: floorGeo,
        materials: [BUILDING_MATERIALS.floorChecker],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_FLOOR_1X1: {
      const floorGeo = new THREE.BoxGeometry(1.0, FLOOR_THICKNESS, 1.0);
      return {
        geometry: floorGeo,
        materials: [BUILDING_MATERIALS.floorChecker],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_WALL_2X3: {
      const wallGeo = new THREE.BoxGeometry(MODULE_SIZE, 3.0, WALL_THICKNESS);
      return {
        geometry: wallGeo,
        materials: applyDefaultWallFaces(wallGeo, MODULE_SIZE, 3.0),
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_WALL_1X3: {
      // Simple clean wall geometry with checker texture (Heartopia style)
      const wallGeo = new THREE.BoxGeometry(1.0, 3.0, WALL_THICKNESS);
      return {
        geometry: wallGeo,
        materials: applyDefaultWallFaces(wallGeo, 1.0, 3.0),
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_WALL_1X2: {
      const width = 1.0;
      const wallGeo = new THREE.BoxGeometry(width, MODULE_SIZE, WALL_THICKNESS);
      return {
        geometry: wallGeo,
        materials: applyDefaultWallFaces(wallGeo, width, MODULE_SIZE),
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_WALL_2X1: {
      const height = 1.0;
      const width = MODULE_SIZE;
      const wallGeo = new THREE.BoxGeometry(width, height, WALL_THICKNESS);
      return {
        geometry: wallGeo,
        materials: applyDefaultWallFaces(wallGeo, width, height),
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_WALL_1X1: {
      const wallGeo = new THREE.BoxGeometry(1.0, 1.0, WALL_THICKNESS);
      return {
        geometry: wallGeo,
        materials: applyDefaultWallFaces(wallGeo, 1.0, 1.0),
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_WALL_WINDOW_2X2: {
      return buildWindowPieceGeometry(MODULE_SIZE, MODULE_SIZE);
    }

    case BuildingPieceType.WOOD_WALL_WINDOW_2X4: {
      return buildWindowPieceGeometry(MODULE_SIZE, 4.0);
    }

    case BuildingPieceType.WOOD_WALL_WINDOW_1X2: {
      return buildWindowPieceGeometry(1.0, MODULE_SIZE);
    }

    case BuildingPieceType.WOOD_WALL_WINDOW_1X1_5: {
      return buildWindowPieceGeometry(1.0, 1.5);
    }

    case BuildingPieceType.WOOD_WALL_WINDOW_SINGLE_HUNG:
      return buildSingleHungWindowPieceGeometry(1.0, 2.0);
    case BuildingPieceType.WOOD_WALL_WINDOW_ARCH:
      return buildArchedWindowPieceGeometry(1.0, 2.0, 'arch');
    case BuildingPieceType.WOOD_WALL_WINDOW_PALLADIAN:
      return buildArchedWindowPieceGeometry(1.0, 2.0, 'palladian');
    case BuildingPieceType.WOOD_WALL_WINDOW_BAY:
      return buildBayWindowGeometry();
    case BuildingPieceType.WOOD_WALL_WINDOW_ROUND:
      return buildArchedWindowPieceGeometry(1.0, 1.0, 'round');

    case BuildingPieceType.WOOD_STAIRS_2X2: {
      const stepCount = 5;
      const stepH = MODULE_SIZE / stepCount;
      const stepD = MODULE_SIZE / stepCount;
      const stairWidth = MODULE_SIZE - 0.20;

      // 1. Wood steps
      const stepGeos: THREE.BufferGeometry[] = [];
      for (let i = 0; i < stepCount; i++) {
        const step = new THREE.BoxGeometry(stairWidth, stepH, stepD * 1.05);
        const y = -HALF_SIZE + (i + 0.5) * stepH;
        const z = -HALF_SIZE + (i + 0.5) * stepD;
        step.translate(0, y, z);
        stepGeos.push(step);
      }
      const mergedWood = mergeGeometries(stepGeos)!;
      stepGeos.forEach((g) => g.dispose());

      // 2. Dark wood stringers
      const stringerLength = Math.sqrt(2) * MODULE_SIZE;
      const stGeo = new THREE.BoxGeometry(0.12, 0.28, stringerLength);

      const stLeft = stGeo.clone();
      stLeft.rotateX(-Math.PI / 4);
      stLeft.translate(-HALF_SIZE + 0.06, 0, 0);

      const stRight = stGeo.clone();
      stRight.rotateX(-Math.PI / 4);
      stRight.translate(HALF_SIZE - 0.06, 0, 0);
      stGeo.dispose();

      const mergedDark = mergeGeometries([stLeft, stRight])!;
      stLeft.dispose();
      stRight.dispose();

      const finalGeo = mergeGeometries([mergedWood, mergedDark], true)!;
      mergedWood.dispose();
      mergedDark.dispose();

      return {
        geometry: finalGeo,
        materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_STAIRS_2X1: {
      const stepCount = 3;
      const stairH = 1.0;
      const stepH = stairH / stepCount;
      const stepD = MODULE_SIZE / stepCount;
      const stairWidth = MODULE_SIZE - 0.20;

      // 1. Wood steps (height = 1.0, centered from -0.5 to +0.5)
      const stepGeos: THREE.BufferGeometry[] = [];
      for (let i = 0; i < stepCount; i++) {
        const step = new THREE.BoxGeometry(stairWidth, stepH, stepD * 1.05);
        const y = -0.5 + (i + 0.5) * stepH;
        const z = -HALF_SIZE + (i + 0.5) * stepD;
        step.translate(0, y, z);
        stepGeos.push(step);
      }
      const mergedWood = mergeGeometries(stepGeos)!;
      stepGeos.forEach((g) => g.dispose());

      // 2. Dark wood stringers (slope = atan2(1, 2) ≈ 26.56°)
      const stringerLength = Math.sqrt(MODULE_SIZE * MODULE_SIZE + stairH * stairH);
      const stairAngle = Math.atan2(stairH, MODULE_SIZE);
      const stGeo = new THREE.BoxGeometry(0.12, 0.22, stringerLength);

      const stLeft = stGeo.clone();
      stLeft.rotateX(-stairAngle);
      stLeft.translate(-HALF_SIZE + 0.06, 0, 0);

      const stRight = stGeo.clone();
      stRight.rotateX(-stairAngle);
      stRight.translate(HALF_SIZE - 0.06, 0, 0);
      stGeo.dispose();

      const mergedDark = mergeGeometries([stLeft, stRight])!;
      stLeft.dispose();
      stRight.dispose();

      const finalGeo = mergeGeometries([mergedWood, mergedDark], true)!;
      mergedWood.dispose();
      mergedDark.dispose();

      return {
        geometry: finalGeo,
        materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_STAIRS_2X3: {
      const stepCount = 8;
      const stairH = 3.0;
      const stairL = 3.0;
      const stepH = stairH / stepCount; // 0.375m
      const stepD = stairL / stepCount; // 0.375m -> 45 degree slope matching 2x2
      const stairWidth = MODULE_SIZE - 0.20;

      // 1. Wood steps (height = 3.0, centered from -1.5 to +1.5; depth = 3.0, centered from -1.5 to +1.5)
      const stepGeos: THREE.BufferGeometry[] = [];
      for (let i = 0; i < stepCount; i++) {
        const step = new THREE.BoxGeometry(stairWidth, stepH, stepD * 1.05);
        const y = -1.5 + (i + 0.5) * stepH;
        const z = -1.5 + (i + 0.5) * stepD;
        step.translate(0, y, z);
        stepGeos.push(step);
      }
      const mergedWood = mergeGeometries(stepGeos)!;
      stepGeos.forEach((g) => g.dispose());

      // 2. Dark wood stringers (slope = 45° -> rotateX(-Math.PI / 4))
      const stringerLength = Math.sqrt(stairL * stairL + stairH * stairH);
      const stGeo = new THREE.BoxGeometry(0.12, 0.32, stringerLength);

      const stLeft = stGeo.clone();
      stLeft.rotateX(-Math.PI / 4);
      stLeft.translate(-HALF_SIZE + 0.06, 0, 0);

      const stRight = stGeo.clone();
      stRight.rotateX(-Math.PI / 4);
      stRight.translate(HALF_SIZE - 0.06, 0, 0);
      stGeo.dispose();

      const mergedDark = mergeGeometries([stLeft, stRight])!;
      stLeft.dispose();
      stRight.dispose();

      const finalGeo = mergeGeometries([mergedWood, mergedDark], true)!;
      mergedWood.dispose();
      mergedDark.dispose();

      return {
        geometry: finalGeo,
        materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_ROOF_26: {
      const roofAngle = Math.atan2(0.9, MODULE_SIZE);
      const roofPlaneLen = Math.sqrt(MODULE_SIZE * MODULE_SIZE + 0.9 * 0.9);

      // 1. Thatch roof plane
      const roofGeo = new THREE.BoxGeometry(MODULE_SIZE, 0.12, roofPlaneLen);
      roofGeo.rotateX(-roofAngle);

      // 2. Dark wood rafters, ridge, and eave
      const rafterGeo = new THREE.BoxGeometry(0.14, 0.16, roofPlaneLen);

      const r1 = rafterGeo.clone();
      r1.rotateX(-roofAngle);
      r1.translate(-HALF_SIZE + 0.1, -0.06, 0);

      const r2 = rafterGeo.clone();
      r2.rotateX(-roofAngle);
      r2.translate(HALF_SIZE - 0.1, -0.06, 0);
      rafterGeo.dispose();

      const ridge = new THREE.BoxGeometry(MODULE_SIZE, 0.14, 0.14);
      ridge.translate(0, 0.45, HALF_SIZE);

      const eave = new THREE.BoxGeometry(MODULE_SIZE, 0.14, 0.12);
      eave.translate(0, -0.45, -HALF_SIZE);

      const mergedDark = mergeGeometries([r1, r2, ridge, eave])!;
      r1.dispose();
      r2.dispose();
      ridge.dispose();
      eave.dispose();

      const finalGeo = mergeGeometries([roofGeo, mergedDark], true)!;
      roofGeo.dispose();
      mergedDark.dispose();

      return {
        geometry: finalGeo,
        materials: [BUILDING_MATERIALS.roof, BUILDING_MATERIALS.woodDark],
        boundingBox: new THREE.Box3(),
      };
    }

    // =========================================================================
    // 2-PITCHED GABLE, HIP & 1-PITCHED SHED ROOFS (SIMS 4 PROCEDURAL)
    // =========================================================================
    case BuildingPieceType.ROOF_GABLE_2X2:
    case BuildingPieceType.ROOF_GABLE_2X4:
    case BuildingPieceType.ROOF_GABLE_4X4:
    case BuildingPieceType.ROOF_HIP_2X2:
    case BuildingPieceType.ROOF_HIP_2X4:
    case BuildingPieceType.ROOF_HIP_4X4:
    case BuildingPieceType.ROOF_SHED_2X2:
    case BuildingPieceType.ROOF_SHED_2X4:
    case BuildingPieceType.ROOF_SHED_4X4:
    case BuildingPieceType.ROOF_GAMBREL_2X2:
    case BuildingPieceType.ROOF_MANSARD_2X2: {
      const geo = ProceduralRoofGenerator.createBufferGeometry(getDefaultRoofConfig(type));
      return {
        geometry: geo,
        materials: [BUILDING_MATERIALS.roofHeartopia, BUILDING_MATERIALS.roofTrim, BUILDING_MATERIALS.roofGableWall, DORMER_GLASS],
        boundingBox: new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute),
      };
    }

    case BuildingPieceType.WOOD_POLE_2M: {
      const poleGeo = new THREE.CylinderGeometry(0.12, 0.12, MODULE_SIZE, 8);
      return {
        geometry: poleGeo,
        materials: [BUILDING_MATERIALS.wood],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.CHECKER_PILLAR_1M: {
      const pillarGeo = new THREE.BoxGeometry(0.4, 1.0, 0.4);
      return {
        geometry: pillarGeo,
        materials: [BUILDING_MATERIALS.pillarChecker],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.CORNER_RUSTICATED_QUOIN_1M: {
      const geoms: THREE.BufferGeometry[] = [];
      const courseH = 0.23;
      const gap = 0.02;
      const reliefT = 0.04; // 4cm subtle facade relief (does not excessively protrude)
      const wallHalfT = WALL_THICKNESS / 2.0; // 0.08m - outer wall boundary

      for (let i = 0; i < 4; i++) {
        const yCenter = -0.375 + i * (courseH + gap);
        const isXLong = i % 2 === 0;

        // Alternating wing lengths along the corner facades
        const lenX = isXLong ? 0.28 : 0.15;
        const lenZ = isXLong ? 0.15 : 0.28;

        // Wing along X facade (hugs exterior face Z in [wallHalfT, wallHalfT + reliefT])
        const boxX = new THREE.BoxGeometry(lenX, courseH, reliefT);
        boxX.translate((wallHalfT + reliefT) - lenX / 2.0, yCenter, wallHalfT + reliefT / 2.0);
        geoms.push(boxX);

        // Wing along Z facade (hugs exterior face X in [wallHalfT, wallHalfT + reliefT])
        const boxZ = new THREE.BoxGeometry(reliefT, courseH, lenZ);
        boxZ.translate(wallHalfT + reliefT / 2.0, yCenter, wallHalfT - lenZ / 2.0);
        geoms.push(boxZ);
      }

      const merged = mergeGeometries(geoms, false);
      return {
        geometry: merged || new THREE.BoxGeometry(0.3, 1.0, 0.3),
        materials: [BUILDING_MATERIALS.rusticatedStone],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.STONE_FOUNDATION_2X2: {
      const stoneGeo = new THREE.BoxGeometry(MODULE_SIZE, 1.0, MODULE_SIZE);
      return {
        geometry: stoneGeo,
        materials: [BUILDING_MATERIALS.stone],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_RAILING_2M: {
      return buildStraightRailingGeometry(MODULE_SIZE, 0.95);
    }

    case BuildingPieceType.WOOD_RAILING_1M: {
      return buildStraightRailingGeometry(1.0, 0.95);
    }

    case BuildingPieceType.WOOD_STAIR_RAILING_2X2: {
      return buildStairRailingGeometry();
    }

    case BuildingPieceType.WHITE_DECORATIVE_FENCE_1M: {
      return buildWhiteDecorativeFenceGeometry();
    }
  }
}


// Builder to create 3D Groups for each piece type (1 consolidated mesh per piece)
export function createPieceMeshGroup(
  type: BuildingPieceType,
  isGhost: boolean = false,
  ghostMaterial?: THREE.Material
): THREE.Group {
  const group = new THREE.Group();
  group.name = `BuildingPiece_${type}`;

  const template = getPieceMeshTemplate(type);

  // If this is a real placed door, assemble interactive hinge pivot groups with static outer frame (top, left, right)
  if (!isGhost && type === BuildingPieceType.WOOD_DOOR_SINGLE) {
    const frameTpl = buildOuterDoorFrameGeometry(1.0, MODULE_SIZE);
    const frameMesh = new THREE.Mesh(
      frameTpl.geometry,
      frameTpl.materials.length === 1 ? frameTpl.materials[0] : frameTpl.materials
    );


    group.add(frameMesh);

    const singleTemplate = buildSingleDoorGeometry();
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'doorPivot';
    pivotGroup.position.set(-0.42, 0, 0); // Hinge pivot at left jamb inner edge

    const leafMesh = new THREE.Mesh(
      singleTemplate.geometry,
      singleTemplate.materials.length === 1 ? singleTemplate.materials[0] : singleTemplate.materials
    );
    leafMesh.position.set(0.42, -0.06, 0); // Offset leaf center so it fits inside 0.84x1.88 opening


    pivotGroup.add(leafMesh);
    group.add(pivotGroup);
    return group;
  }

  if (!isGhost && type === BuildingPieceType.GLASS_DOOR_1X3) {
    // Shared cached geometry: frame stays put, the leaf swings on a hinge pivot (toggleDoor)
    ghDoorFrameTpl ??= buildGreenhouseDoorFrame();
    ghDoorLeafTpl ??= buildGreenhouseDoorLeaf();
    group.add(new THREE.Mesh(ghDoorFrameTpl.geometry, ghDoorFrameTpl.materials));
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'doorPivot';
    pivotGroup.position.set(GH_HINGE_X, 0, 0);
    const leafMesh = new THREE.Mesh(ghDoorLeafTpl.geometry, ghDoorLeafTpl.materials);
    leafMesh.position.set(-GH_HINGE_X, GH_LEAF_Y, 0);
    pivotGroup.add(leafMesh);
    group.add(pivotGroup);
    return group;
  }

  if (!isGhost && type === BuildingPieceType.WOOD_DOOR_DOUBLE) {
    const frameTpl = buildOuterDoorFrameGeometry(MODULE_SIZE, MODULE_SIZE);
    const frameMesh = new THREE.Mesh(
      frameTpl.geometry,
      frameTpl.materials.length === 1 ? frameTpl.materials[0] : frameTpl.materials
    );


    group.add(frameMesh);

    const singleTemplate = buildSingleDoorGeometry();

    // Left leaf hinge pivot
    const leftPivot = new THREE.Group();
    leftPivot.name = 'doorPivotLeft';
    leftPivot.position.set(-0.90, 0, 0);

    const leftMesh = new THREE.Mesh(
      singleTemplate.geometry,
      singleTemplate.materials.length === 1 ? singleTemplate.materials[0] : singleTemplate.materials
    );
    leftMesh.position.set(0.45, -0.06, 0);


    leftPivot.add(leftMesh);
    group.add(leftPivot);

    // Right leaf hinge pivot
    const rightPivot = new THREE.Group();
    rightPivot.name = 'doorPivotRight';
    rightPivot.position.set(0.90, 0, 0);

    const rightGeo = singleTemplate.geometry.clone();
    rightGeo.rotateY(Math.PI);
    const rightMesh = new THREE.Mesh(
      rightGeo,
      singleTemplate.materials.length === 1 ? singleTemplate.materials[0] : singleTemplate.materials
    );
    rightMesh.position.set(-0.45, -0.06, 0);


    rightPivot.add(rightMesh);
    group.add(rightPivot);

    return group;
  }

  if (!isGhost && type === BuildingPieceType.DOOR_GRAND_SIDELITES_2X2) {
    const frameTpl = buildGrandSideliteDoorFrameGeometry();
    const frameMesh = new THREE.Mesh(
      frameTpl.geometry,
      frameTpl.materials.length === 1 ? frameTpl.materials[0] : frameTpl.materials
    );


    group.add(frameMesh);

    const leafTpl = buildGrandMahoganyDoorLeaf();
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'doorPivot';
    pivotGroup.position.set(-0.44, 0, 0); // Hinge pivot at left mullion post edge of center doorway

    const leafMesh = new THREE.Mesh(
      leafTpl.geometry,
      leafTpl.materials.length === 1 ? leafTpl.materials[0] : leafTpl.materials
    );
    leafMesh.position.set(0.44, -0.04, 0);


    pivotGroup.add(leafMesh);
    group.add(pivotGroup);
    return group;
  }

  if (!isGhost && type === BuildingPieceType.DOOR_WHITE_2PANEL_1X2) {
    const frameTpl = buildWhite2PanelDoorFrameGeometry();
    const frameMesh = new THREE.Mesh(
      frameTpl.geometry,
      frameTpl.materials.length === 1 ? frameTpl.materials[0] : frameTpl.materials
    );


    group.add(frameMesh);

    const leafTpl = buildWhite2PanelDoorLeaf();
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'doorPivot';
    pivotGroup.position.set(-0.42, 0, 0);

    const leafMesh = new THREE.Mesh(
      leafTpl.geometry,
      leafTpl.materials.length === 1 ? leafTpl.materials[0] : leafTpl.materials
    );
    leafMesh.position.set(0.42, -0.06, 0);


    pivotGroup.add(leafMesh);
    group.add(pivotGroup);
    return group;
  }

  if (!isGhost && type === BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2) {
    const frameTpl = buildCottageWindowDoorFrameGeometry();
    const frameMesh = new THREE.Mesh(
      frameTpl.geometry,
      frameTpl.materials.length === 1 ? frameTpl.materials[0] : frameTpl.materials
    );


    group.add(frameMesh);

    const leafTpl = buildCottageWindowDoorLeaf();
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'doorPivot';
    pivotGroup.position.set(-0.42, 0, 0);

    const leafMesh = new THREE.Mesh(
      leafTpl.geometry,
      leafTpl.materials.length === 1 ? leafTpl.materials[0] : leafTpl.materials
    );
    leafMesh.position.set(0.42, -0.06, 0);


    pivotGroup.add(leafMesh);
    group.add(pivotGroup);
    return group;
  }

  if (!isGhost && type === BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2) {
    const frameTpl = buildColonial6PanelDoorFrameGeometry();
    const frameMesh = new THREE.Mesh(
      frameTpl.geometry,
      frameTpl.materials.length === 1 ? frameTpl.materials[0] : frameTpl.materials
    );


    group.add(frameMesh);

    const leafTpl = buildColonial6PanelDoorLeaf();
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'doorPivot';
    pivotGroup.position.set(-0.42, 0, 0);

    const leafMesh = new THREE.Mesh(
      leafTpl.geometry,
      leafTpl.materials.length === 1 ? leafTpl.materials[0] : leafTpl.materials
    );
    leafMesh.position.set(0.42, -0.06, 0);


    pivotGroup.add(leafMesh);
    group.add(pivotGroup);
    return group;
  }

  const mat = isGhost
    ? (ghostMaterial || BUILDING_MATERIALS.ghostValid)
    : (template.materials.length === 1 ? template.materials[0] : template.materials);

  const isRoof = isProceduralRoofPiece(type);
  // CRITICAL: Procedural roofs MUST have their own unique BufferGeometry instance per piece!
  // Sharing template.geometry causes procedural deformation of one roof to mutate all instances in the scene.
  const geometry = isRoof ? createRoofGeometry(type, getDefaultRoofConfig(type)) : template.geometry;

  const mesh = new THREE.Mesh(geometry, mat);


  group.add(mesh);
  return group;
}

/** Fresh per-piece roof geometry: glass roofs use the greenhouse generator, the rest the shingle one. */
export function createRoofGeometry(type: BuildingPieceType, config: Partial<ProceduralRoofConfig>): THREE.BufferGeometry {
  return isGlassRoofPiece(type)
    ? GreenhouseRoofGenerator.createGeometry(config)
    : ProceduralRoofGenerator.createBufferGeometry(config);
}

// Re-exported for existing imports; the list itself lives in PIECE_TRAITS
export { isProceduralRoofPiece } from '../types/BuildingTypes';

export function getDefaultRoofConfig(type: BuildingPieceType) {
  let roofType: RoofType = 'gable';
  if (type.includes('HIP')) roofType = 'hip';
  else if (type.includes('SHED')) roofType = 'shed';
  else if (type.includes('GAMBREL')) roofType = 'gambrel';
  else if (type.includes('MANSARD')) roofType = 'mansard';

  switch (shapeOf(type)) {
    case BuildingPieceType.ROOF_GABLE_2X2:
    case BuildingPieceType.ROOF_HIP_2X2:
    case BuildingPieceType.ROOF_SHED_2X2:
    case BuildingPieceType.ROOF_GAMBREL_2X2:
    case BuildingPieceType.ROOF_MANSARD_2X2:
      return {
        minX: -1.0,
        maxX: 1.0,
        minZ: -1.0,
        maxZ: 1.0,
        height: 0.85,
        roofType,
        minSize: 0.2,
        minHeight: 0.1,
        maxHeight: 5.0,
        snapSize: 0.5,
      };
    case BuildingPieceType.ROOF_GABLE_2X4:
    case BuildingPieceType.ROOF_HIP_2X4:
    case BuildingPieceType.ROOF_SHED_2X4:
      return {
        minX: -1.0,
        maxX: 1.0,
        minZ: -2.0,
        maxZ: 2.0,
        height: 0.85,
        roofType,
        minSize: 0.2,
        minHeight: 0.1,
        maxHeight: 5.0,
        snapSize: 0.5,
      };
    case BuildingPieceType.ROOF_GABLE_4X4:
    case BuildingPieceType.ROOF_HIP_4X4:
    case BuildingPieceType.ROOF_SHED_4X4:
      return {
        minX: -2.0,
        maxX: 2.0,
        minZ: -2.0,
        maxZ: 2.0,
        height: 1.6,
        roofType,
        minSize: 0.2,
        minHeight: 0.1,
        maxHeight: 5.0,
        snapSize: 0.5,
      };
    default:
      return {
        minX: -1.0,
        maxX: 1.0,
        minZ: -1.0,
        maxZ: 1.0,
        height: 0.85,
        roofType,
        minSize: 0.2,
        minHeight: 0.1,
        maxHeight: 5.0,
        snapSize: 0.5,
      };
  }
}

/**
 * Calculates the half-height extent (along world Y) for any building piece taking rotation into account.
 */
export function getPieceHalfExtentY(
  type: BuildingPieceType,
  quaternion?: THREE.Quaternion,
  piece?: BuiltPiece
): number {
  if (piece && piece.roofConfig) {
    // For procedural roofs, pivot is at the base plane and height extends upward
    return 0;
  }
  const pieceDef = BUILDING_PIECES[type];
  const dim = pieceDef ? pieceDef.dimensions : new THREE.Vector3(2.0, 2.0, 2.0);
  if (!quaternion) {
    return dim.y * 0.5;
  }
  const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  const localY = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  const localZ = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
  return (
    (dim.x * 0.5) * Math.abs(localX.y) +
    (dim.y * 0.5) * Math.abs(localY.y) +
    (dim.z * 0.5) * Math.abs(localZ.y)
  );
}

/**
 * Validates if a piece at the target position and orientation would penetrate or be located
 * below the construction platform surface (Y = 0).
 */
export function isPieceBelowSurface(
  type: BuildingPieceType,
  position: THREE.Vector3,
  quaternion?: THREE.Quaternion,
  piece?: BuiltPiece
): boolean {
  if (piece && piece.roofConfig) {
    return position.y < BUILDING_CONFIG.GROUND_SURFACE_Y + BUILDING_CONFIG.MIN_SURFACE_TOLERANCE;
  }
  const halfExtentY = getPieceHalfExtentY(type, quaternion, piece);
  const bottomY = position.y - halfExtentY;
  const pieceDef = BUILDING_PIECES[type];
  const maxGroundSink = pieceDef?.category === PieceCategory.FLOORS
    ? pieceDef.dimensions.y * BUILDING_CONFIG.GROUND_FLOOR_SINK_PERCENT
    : 0;
  return bottomY < BUILDING_CONFIG.GROUND_SURFACE_Y - maxGroundSink + BUILDING_CONFIG.MIN_SURFACE_TOLERANCE;
}
