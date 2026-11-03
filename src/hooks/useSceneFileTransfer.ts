import React, { useState } from 'react';
import { BuildingTelemetry } from '../building/types/BuildingTypes';
import { parseBuildingSceneJson } from '../building/BuildingSerialization';
import { GameEngine } from '../engine/GameEngine';
import { AddLog } from './useConsoleLog';
import { ShowToast } from './useToast';

/** JSON export/import of the building scene, including drag & drop onto the viewport. */
export function useSceneFileTransfer(
  engine: GameEngine | null,
  buildingTelemetry: BuildingTelemetry | null,
  setBuildingTelemetry: (telemetry: BuildingTelemetry) => void,
  addLog: AddLog,
  showToast: ShowToast,
) {
  const [isDragOver, setIsDragOver] = useState(false);
  const buildAbility = engine?.world?.character.buildAbility;
  const buildingManager = buildAbility?.buildingManager;

  const warnNotReady = () => showToast({ text: 'Менеджер будівництва ще не ініціалізовано', type: 'warn' });

  const exportJSON = () => {
    if (!buildingManager) return warnNotReady();
    const res = buildingManager.downloadSceneJson(buildingTelemetry?.currentRoofStyle);
    if (res.success) {
      const msg = `Експортовано ${res.piecesCount} обʼєктів та ${res.customizedCells} клітинок (${res.fileSizeKb} KB)`;
      showToast({ text: `✓ ${msg}`, type: 'success' });
      addLog('info', `[Експорт JSON] ${msg} -> ${res.filename}`);
    }
  };

  const importJSON = async (file: File) => {
    if (!buildAbility || !buildingManager) return warnNotReady();
    const reportError = (errorMsg: string) => {
      showToast({ text: `✕ ${errorMsg}`, type: 'warn' });
      addLog('warn', `[Імпорт JSON] ${errorMsg}`);
    };
    try {
      const text = await file.text();
      const res = buildingManager.importScene(parseBuildingSceneJson(text));
      if (res.success) {
        setBuildingTelemetry({ ...buildAbility.getTelemetry() });
        const msg = `Відновлено ${res.piecesCount} деталей будівлі та ${res.customizedCells} розфарбованих клітинок стін!`;
        showToast({ text: `✓ ${msg}`, type: 'success' });
        addLog('event', `[Імпорт JSON] ${msg} (стиль даху: ${res.roofStyle})`);
      } else {
        reportError(res.error || 'Помилка відновлення сцени');
      }
    } catch (err: any) {
      reportError(err?.message || 'Помилка зчитування JSON файлу');
    }
  };

  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      if (!isDragOver) setIsDragOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
    },
    onDrop: async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      if (file.name.endsWith('.json') || file.type.includes('json')) {
        await importJSON(file);
      } else {
        showToast({ text: 'Будь ласка, перетягніть валідний файл .json', type: 'warn' });
      }
    },
  };

  return { isDragOver, exportJSON, importJSON, dropHandlers };
}
