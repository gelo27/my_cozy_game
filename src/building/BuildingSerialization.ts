import * as THREE from 'three';
import { BuildingManager } from './BuildingManager';
import { BuildingPieceType, BuildingSceneExportData, SavedPieceData, isDoorPiece } from './types/BuildingTypes';
import { isProceduralRoofPiece } from './config/BuildingPiecesConfig';
import { ProceduralRoofSystem } from './ProceduralRoofSystem';
import { audioEngine } from '../audio/AudioEngine';

/**
 * Rounds a number to the specified number of decimal places for clean, compact JSON serialization.
 */
function roundTo(val: number, decimals: number = 3): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

/**
 * Extracts and formats the full building configuration, materials, and telemetry of the current scene.
 */
export function exportBuildingScene(
  buildingManager: BuildingManager,
  currentRoofStyle: 'terracotta' | 'blue_slate' | 'wood_shingles' = 'terracotta'
): BuildingSceneExportData {
  const pieces = buildingManager.getAllPieces();
  const savedPieces: SavedPieceData[] = [];

  for (const piece of pieces) {
    const saved: SavedPieceData = {
      id: piece.id,
      type: piece.type,
      position: [
        roundTo(piece.position.x, 3),
        roundTo(piece.position.y, 3),
        roundTo(piece.position.z, 3),
      ],
      quaternion: [
        roundTo(piece.quaternion.x, 4),
        roundTo(piece.quaternion.y, 4),
        roundTo(piece.quaternion.z, 4),
        roundTo(piece.quaternion.w, 4),
      ],
      rotation: [
        roundTo(piece.rotation.x, 3),
        roundTo(piece.rotation.y, 3),
        roundTo(piece.rotation.z, 3),
      ],
      health: piece.health,
    };

    if (piece.isOpen !== undefined) {
      saved.isOpen = piece.isOpen;
    }

    if (piece.roofConfig) {
      saved.roofConfig = { ...piece.roofConfig };
    }

    savedPieces.push(saved);
  }

  const wallPainting = buildingManager.wallPaintingSystem.exportPaintedCells();
  const customizedCellsCount = Object.keys(wallPainting).length;

  const exportData: BuildingSceneExportData = {
    version: 1,
    generator: 'House Builder Scene Telemetry Engine',
    exportedAt: new Date().toISOString(),
    metadata: {
      totalPieces: savedPieces.length,
      customizedCells: customizedCellsCount,
      roofStyle: currentRoofStyle,
      confirmed: buildingManager.getUnconfirmedWallCount() === 0 &&
                 buildingManager.getUnconfirmedFloorCount() === 0 &&
                 buildingManager.getUnconfirmedFoundationCount() === 0,
    },
    pieces: savedPieces,
    wallPainting,
  };

  return exportData;
}

/**
 * Triggers a browser download of the scene telemetry as a formatted JSON file.
 */
export function downloadBuildingSceneAsJson(
  buildingManager: BuildingManager,
  currentRoofStyle: 'terracotta' | 'blue_slate' | 'wood_shingles' = 'terracotta'
): { success: boolean; filename: string; piecesCount: number; customizedCells: number; fileSizeKb: number } {
  const data = exportBuildingScene(buildingManager, currentRoofStyle);
  const jsonString = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });

  // Generate ISO date stamp for filename: house_scene_YYYYMMDD_HHmm.json
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const filename = `house_scene_${dateStr}.json`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  const fileSizeKb = Math.round((blob.size / 1024) * 10) / 10;

  return {
    success: true,
    filename,
    piecesCount: data.pieces.length,
    customizedCells: data.metadata.customizedCells,
    fileSizeKb,
  };
}

/**
 * Validates and normalizes parsed JSON content into a safe BuildingSceneExportData structure.
 */
export function parseBuildingSceneJson(jsonContent: string | object): BuildingSceneExportData {
  let parsed: any;
  if (typeof jsonContent === 'string') {
    try {
      parsed = JSON.parse(jsonContent);
    } catch (e: any) {
      throw new Error(`Некоректний синтаксис JSON: ${e?.message || 'Помилка розбору'}`);
    }
  } else {
    parsed = jsonContent;
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Файл не містить валідного обʼєкта сцени');
  }

  const rawPieces = Array.isArray(parsed.pieces) ? parsed.pieces : [];
  if (rawPieces.length === 0 && (!parsed.wallPainting || Object.keys(parsed.wallPainting).length === 0)) {
    throw new Error('У файлі відсутні збережені деталі будівництва');
  }

  const normalizedPieces: SavedPieceData[] = [];
  for (let i = 0; i < rawPieces.length; i++) {
    const p = rawPieces[i];
    if (!p || !p.type) continue;

    // Normalize position: support [x, y, z] or {x, y, z}
    let pos: [number, number, number] = [0, 0, 0];
    if (Array.isArray(p.position) && p.position.length >= 3) {
      pos = [Number(p.position[0]) || 0, Number(p.position[1]) || 0, Number(p.position[2]) || 0];
    } else if (p.position && typeof p.position === 'object') {
      pos = [Number(p.position.x) || 0, Number(p.position.y) || 0, Number(p.position.z) || 0];
    }

    // Normalize quaternion: support [x, y, z, w] or {x, y, z, w}
    let quat: [number, number, number, number] = [0, 0, 0, 1];
    if (Array.isArray(p.quaternion) && p.quaternion.length >= 4) {
      quat = [
        Number(p.quaternion[0]) || 0,
        Number(p.quaternion[1]) || 0,
        Number(p.quaternion[2]) || 0,
        Number(p.quaternion[3]) ?? 1,
      ];
    } else if (p.quaternion && typeof p.quaternion === 'object') {
      quat = [
        Number(p.quaternion.x) || 0,
        Number(p.quaternion.y) || 0,
        Number(p.quaternion.z) || 0,
        Number(p.quaternion.w) ?? 1,
      ];
    }

    normalizedPieces.push({
      id: typeof p.id === 'string' ? p.id : `piece_${i + 1}_${p.type}`,
      type: p.type as BuildingPieceType,
      position: pos,
      quaternion: quat,
      health: typeof p.health === 'number' ? p.health : undefined,
      isOpen: typeof p.isOpen === 'boolean' ? p.isOpen : undefined,
      roofConfig: p.roofConfig && typeof p.roofConfig === 'object' ? p.roofConfig : undefined,
    });
  }

  return {
    version: 1,
    generator: parsed.generator || 'Custom Importer',
    exportedAt: parsed.exportedAt || new Date().toISOString(),
    metadata: {
      totalPieces: normalizedPieces.length,
      customizedCells: parsed.wallPainting ? Object.keys(parsed.wallPainting).length : 0,
      roofStyle: parsed.metadata?.roofStyle || 'terracotta',
      confirmed: parsed.metadata?.confirmed ?? true,
    },
    pieces: normalizedPieces,
    wallPainting: parsed.wallPainting && typeof parsed.wallPainting === 'object' ? parsed.wallPainting : {},
  };
}

/**
 * Reconstructs a saved building scene from serialized data:
 * - Demolishes current scene safely
 * - Spawns all pieces with exact coordinates, rotations, and physics colliders
 * - Reconstructs door open/closed hinge angles and colliders
 * - Reconstructs custom procedural roof parameters and slopes
 * - Reapplies all cell-level wallpaper & facade materials
 * - Bakes seamless continuous walls, floors, and foundations
 */
export function importBuildingScene(
  buildingManager: BuildingManager,
  data: BuildingSceneExportData
): {
  success: boolean;
  piecesCount: number;
  customizedCells: number;
  roofStyle?: 'terracotta' | 'blue_slate' | 'wood_shingles';
  error?: string;
} {
  try {
    // 1. Demolish current scene
    buildingManager.clear();

    let maxIdNum = 1;
    let placedCount = 0;

    // 2. Spawn pieces
    for (const pieceData of data.pieces) {
      const pos = new THREE.Vector3(pieceData.position[0], pieceData.position[1], pieceData.position[2]);
      const quat = new THREE.Quaternion(
        pieceData.quaternion[0],
        pieceData.quaternion[1],
        pieceData.quaternion[2],
        pieceData.quaternion[3]
      );

      const piece = buildingManager.placePiece(pieceData.type, pos, quat, pieceData.id, true);
      if (piece) {
        placedCount++;

        // Track highest ID number
        const idMatch = piece.id.match(/^piece_(\d+)_/);
        if (idMatch) {
          const num = parseInt(idMatch[1], 10);
          if (!isNaN(num) && num >= maxIdNum) {
            maxIdNum = num + 1;
          }
        }

        // Restore procedural roof parameters
        if (pieceData.roofConfig && isProceduralRoofPiece(piece.type)) {
          buildingManager.updateRoofConfig(piece.id, pieceData.roofConfig, true);
        }

        // Restore door hinge position
        if (pieceData.isOpen && isDoorPiece(piece.type)) {
          buildingManager.toggleDoor(piece.id);
        }
      }
    }

    buildingManager.setNextPieceId(maxIdNum);

    // 3. Restore wall painting customizations
    if (data.wallPainting && Object.keys(data.wallPainting).length > 0) {
      buildingManager.wallPaintingSystem.importPaintedCells(data.wallPainting);
    }

    // 4. Restore roof texture style
    const roofStyle = data.metadata.roofStyle || 'terracotta';
    ProceduralRoofSystem.applyRoofTextureStyle(roofStyle);

    // 5. Regenerate seamless continuous meshes
    buildingManager.confirmAll();

    // 6. Audio feedback
    audioEngine.playBuildSnap();

    return {
      success: true,
      piecesCount: placedCount,
      customizedCells: Object.keys(data.wallPainting || {}).length,
      roofStyle,
    };
  } catch (err: any) {
    console.error('[BuildingSerialization] Failed to reconstruct scene:', err);
    return {
      success: false,
      piecesCount: 0,
      customizedCells: 0,
      error: err?.message || 'Не вдалося реконструювати сцену з JSON',
    };
  }
}
