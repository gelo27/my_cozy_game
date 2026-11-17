import { t } from '../i18n/i18n';
import { BuildingPieceType, BuildingTelemetry, HouseRoofKind, DormerAction } from '../building/types/BuildingTypes';
import { PaintingToolMode } from '../building/WallPaintingSystem';
import { RoofStyle } from '../building/ProceduralRoofSystem';
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

  if (buildAbility) {
    buildAbility.onHouseRoofMessage = (ok, message) => {
      showToast({ text: message, type: ok ? 'success' : 'warn' });
      setBuildingTelemetry({ ...buildAbility.getTelemetry() });
    };
  }

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

    /** The paint mode's Build tab: painting off, build mode on. */
    switchToBuild: () =>
      withBuild(build => {
        build.setPaintingMode(false);
        input?.setPaintMode(false);
        if (!build.isBuildModeActive) build.toggleBuildMode();
        input?.setBuildMode(true);
      }),

    selectWallpaper: (id: string) => withBuild(build => build.setWallpaper(id)),

    selectPaintingTool: (tool: PaintingToolMode) => withBuild(build => build.setPaintingTool(tool)),

    undoPaint: () => withBuild(build => build.undoPaint()),

    redoPaint: () => withBuild(build => build.redoPaint()),

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
      confirmWith(() => buildAbility!.confirmWalls(), t('build.confirmedWalls')),

    confirmFloors: () =>
      confirmWith(() => buildAbility!.confirmFloors(), t('build.confirmedFloors')),

    confirmFoundations: () =>
      confirmWith(() => buildAbility!.confirmFoundations(), t('build.confirmedFoundations')),

    confirmAll: () =>
      confirmWith(() => buildAbility!.confirmAll(), t('build.confirmedAll')),

    setRoofStyle: (style: RoofStyle) => withBuild(build => build.setRoofStyle(style)),

    fillOutline: () =>
      withBuild(build => {
        const res = build.fillOutline();
        showToast({ text: res.message, type: res.ok ? 'success' : 'warn' });
        if (res.ok) addLog('event', res.message);
      }),

    dormerAction: (action: DormerAction) =>
      withBuild(build => {
        const res = build.dormerAction(action);
        if (res) showToast({ text: res.message, type: res.ok ? 'success' : 'warn' });
      }),

    selectHouseRoofTool: (kind: HouseRoofKind) =>
      withBuild(build => {
        const res = build.setHouseRoofTool(kind);
        if (res) showToast({ text: res.message, type: 'success' });
      }),

    roofWholeHouse: () =>
      withBuild(build => {
        const res = build.roofWholeHouse();
        showToast({ text: res.message, type: res.ok ? 'success' : 'warn' });
        if (res.ok) addLog('event', res.message);
      }),
  };
}
