import { BuildingPieceType, BuildingTelemetry } from '../building/types/BuildingTypes';
import { PaintingToolMode } from '../building/WallPaintingSystem';
import { GameEngine } from '../engine/GameEngine';
import { AddLog } from './useConsoleLog';
import { ShowToast } from './useToast';

/** Handlers wiring BuildingHUD & HeartopiaPaintingHUD to the character's BuildAbility. */
export function useBuildingControls(
  engine: GameEngine | null,
  setBuildingTelemetry: (telemetry: BuildingTelemetry) => void,
  addLog: AddLog,
  showToast: ShowToast,
) {
  const buildAbility = engine?.world?.character.buildAbility;
  const input = engine?.input;

  // Runs an action against BuildAbility, then refreshes the HUD telemetry
  const withBuild = <T,>(action: (build: NonNullable<typeof buildAbility>) => T): T | undefined => {
    if (!buildAbility) return undefined;
    const result = action(buildAbility);
    setBuildingTelemetry({ ...buildAbility.getTelemetry() });
    return result;
  };

  const confirmWith = (confirm: () => boolean, message: string) => {
    if (withBuild(confirm)) {
      addLog('event', message);
    }
  };

  return {
    toggleBuildMode: () => withBuild(build => input?.setBuildMode(build.toggleBuildMode())),

    togglePaintMode: () =>
      withBuild(build => {
        const active = build.togglePaintingMode();
        input?.setPaintMode(active);
        if (active) {
          addLog('event', 'Режим розфарбовування стін Heartopia АКТИВОВАНО: незалежні шпалери/фасад по клітинках [P]');
        }
      }),

    selectWallpaper: (id: string) => withBuild(build => build.setWallpaper(id)),

    selectPaintingTool: (tool: PaintingToolMode) => withBuild(build => build.setPaintingTool(tool)),

    undoPaint: () => withBuild(build => build.undoPaint()),

    redoPaint: () => withBuild(build => build.redoPaint()),

    setGridCellSize: (size: number) => {
      withBuild(build => build.setGridCellSize(size));
      if (buildAbility) {
        showToast({ text: `Розмір сітки фарбування: ${size === 1.0 ? '1×1м' : '0.5×0.5м'}`, type: 'info' });
      }
    },

    selectPiece: (type: BuildingPieceType) => withBuild(build => build.setPieceType(type)),

    rotatePiece: () => withBuild(build => build.rotatePiece(true)),

    toggleSnap: () => withBuild(build => build.toggleSnapping()),

    demolish: () => {
      if (input) input.touchState.buildDemolishJustPressed = true;
    },

    place: () => {
      if (input) input.touchState.buildPlaceJustPressed = true;
    },

    confirmWalls: () =>
      confirmWith(() => buildAbility!.confirmWalls(), 'Стіни підтверджено: згенеровано суцільний меш стін без швів'),

    confirmFloors: () =>
      confirmWith(() => buildAbility!.confirmFloors(), 'Підлогу підтверджено: згенеровано суцільний меш підлоги'),

    confirmFoundations: () =>
      confirmWith(() => buildAbility!.confirmFoundations(), 'Фундамент підтверджено: згенеровано суцільний камʼяний меш'),

    confirmAll: () =>
      confirmWith(() => buildAbility!.confirmAll(), 'Усі елементи підтверджено: згенеровано окремі суцільні меші'),
  };
}
