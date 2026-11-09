import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BuildingTelemetry } from './building/types/BuildingTypes';
import { GameEngine, DevStats, EngineMode, DEV_TOOLS_ENABLED } from './engine/GameEngine';
import { AUTOSAVE_SLOT } from './world/SaveSystem';
import { GameplayHudState } from './gameplay/GameplayManager';
import { useConsoleLog } from './hooks/useConsoleLog';
import { useToast } from './hooks/useToast';
import { useBuildingControls } from './hooks/useBuildingControls';
import { useSceneFileTransfer } from './hooks/useSceneFileTransfer';
import { BuildingHUD } from './components/BuildingHUD';
import { HeartopiaPaintingHUD } from './components/HeartopiaPaintingHUD';
import { DebugPanel } from './components/DebugPanel';
import { ViewportHUD } from './components/ViewportHUD';
import { ControlsOverlay } from './components/ControlsOverlay';
import { ConsoleFooter } from './components/ConsoleFooter';
import { HeartopiaInventoryHUD } from './components/HeartopiaInventoryHUD';
import { InteractionPrompts } from './components/InteractionPrompts';
import { promptStore } from './components/promptStore';
import { GameHUD } from './components/game/GameHUD';
import { CookingPanel, ShopPanel } from './components/game/ActivityPanels';
import { WorldMap } from './components/game/WorldMap';
import { SavingBadge } from './components/game/SavingBadge';
import { PauseMenu } from './components/game/PauseMenu';
import { EditorUI } from './components/editor/EditorUI';
import { useLang, dataName, t } from './i18n/i18n';
import { ErrorOverlay, JsonDropOverlay, LoadingOverlay, ToastPill } from './components/ViewportOverlays';

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [engine, setEngine] = useState<GameEngine | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Live state pushed from the simulation loop (throttled by GameEngine)
  const [buildingTelemetry, setBuildingTelemetry] = useState<BuildingTelemetry | null>(null);
  const [hud, setHud] = useState<GameplayHudState | null>(null);
  const [mode, setMode] = useState<EngineMode>('play');
  const [devStats, setDevStats] = useState<DevStats | null>(null);
  const [, setEditorTick] = useState(0);

  const [isWireframe, setIsWireframe] = useState(false);
  const [isInventoryOpen, setIsInventoryOpen] = useState(false);
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [showCharacterInspector, setShowCharacterInspector] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  /** What Escape should close first (read from the engine's key handler, so kept in a ref). */
  const openUiRef = useRef({ inventory: false, map: false, building: false });
  const pausedAtRef = useRef(0);

  useLang();
  const { logs, addLog, clearLogs } = useConsoleLog();
  const { toast, showToast } = useToast();
  const building = useBuildingControls(engine, setBuildingTelemetry, addLog, showToast);
  const sceneFiles = useSceneFileTransfer(engine, buildingTelemetry, setBuildingTelemetry, addLog, showToast);

  const world = engine?.world ?? null;
  const character = world?.character ?? null;
  const buildAbility = character?.buildAbility;

  const notify = useCallback(
    (text: string, type: 'success' | 'info' | 'warn' | 'warning' = 'info') =>
      showToast({ text, type: type === 'warning' ? 'warn' : type }),
    [showToast]
  );

  /** `undefined` toggles the backpack; the input manager unlocks the cursor while it is open. */
  const handleToggleInventory = (open?: boolean) => {
    setIsInventoryOpen((prev) => {
      const next = open ?? !prev;
      if (next !== prev) engineRef.current?.input.setInventoryMode(next);
      return next;
    });
  };

  const setPaused = (paused: boolean) => {
    const e = engineRef.current;
    if (!e || e.mode === 'editor') return;
    e.setPaused(paused);
    pausedAtRef.current = paused ? performance.now() : 0;
    e.input.setInventoryMode(paused || openUiRef.current.inventory || openUiRef.current.map || !!e.world?.gameplay.panel);
    setIsPaused(paused);
  };

  /** Escape: pause, unless Escape is about to close the backpack, map or build mode. */
  const handlePauseHotkey = () => {
    const e = engineRef.current;
    if (!e) return;
    const ui = openUiRef.current;
    if (!e.isPaused && (ui.inventory || ui.map || ui.building)) return;
    // The same Escape that released the mouse (and so already paused) must not resume at once
    if (e.isPaused && performance.now() - pausedAtRef.current < 250) return;
    setPaused(!e.isPaused);
  };

  /** The map frees the cursor like the backpack. */
  const handleToggleMap = (open?: boolean) => {
    setIsMapOpen((prev) => {
      const next = open ?? !prev;
      if (next !== prev) engineRef.current?.input.setInventoryMode(next);
      return next;
    });
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const gameEngine = new GameEngine(containerRef.current, {
      onReady: () => setLoading(false),
      onError: (message) => {
        setErrorMsg(message);
        setLoading(false);
      },
      onLog: addLog,
      onStats: () => {},
      onBuildingTelemetry: setBuildingTelemetry,
      onFarmingPrompt: promptStore.setFarm,
      onGatherPrompt: promptStore.setGather,
      onGameplayPrompt: promptStore.setPlay,
      onResourcesGathered: (items) => {
        const inventory = engineRef.current?.world?.inventoryManager;
        const text = items.map(({ itemId, amount }) => `+${amount} ${dataName('item', itemId, inventory?.getItem(itemId)?.name ?? itemId)}`).join(', ');
        showToast({ text, type: 'success' });
      },
      onWireframeToggled: setIsWireframe,
      onInventoryHotkey: handleToggleInventory,
      onMapHotkey: handleToggleMap,
      onPauseHotkey: handlePauseHotkey,
      onGameplayHud: setHud,
      onNotify: (text, type) => notify(text, type),
      onModeChange: setMode,
      onEditorChanged: () => setEditorTick((t) => t + 1),
      onDevStats: setDevStats,
    });
    engineRef.current = gameEngine;
    setEngine(gameEngine);

    return () => {
      gameEngine.dispose();
      engineRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Browsers spend the first Escape on releasing the mouse: losing the lock while just playing
  // (no backpack, map, panel or build mode freed it) opens the pause menu like games do
  useEffect(() => {
    if (!engine) return;
    const onLockChange = () => {
      if (document.pointerLockElement || document.hidden) return;
      const inp = engine.input;
      if (engine.mode !== 'play' || engine.isPaused || inp.isInventoryOpen || inp.isBuildMode || inp.isPaintMode || inp.isTerrainMode) return;
      if (engine.world?.gameplay.panel) return;
      setPaused(true);
    };
    document.addEventListener('pointerlockchange', onLockChange);
    return () => document.removeEventListener('pointerlockchange', onLockChange);
  }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps

  // Panels free the mouse cursor like the backpack does
  const panelOpen = !!hud?.panel;
  useEffect(() => {
    engine?.input.setInventoryMode(panelOpen || isInventoryOpen);
  }, [panelOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const isEditor = mode === 'editor';
  const isBuildingUI = !!(buildingTelemetry?.isBuildModeActive || buildingTelemetry?.isPaintingModeActive);
  const closePanel = () => world?.gameplay.openPanel(null);
  openUiRef.current = { inventory: isInventoryOpen, map: isMapOpen, building: isBuildingUI };

  return (
    <div className="flex h-[100dvh] w-screen bg-[#0c0c0c] text-[#e0e0e0] select-none overflow-hidden">
      <main className="flex-1 relative overflow-hidden" {...sceneFiles.dropHandlers}>
        {/* 3D Canvas Container */}
        <div
          ref={containerRef}
          onClick={() => {
            if (!isEditor && !buildAbility?.isBuildModeActive && !buildAbility?.isPaintingModeActive && !panelOpen) {
              engine?.input.requestPointerLock();
            }
          }}
          className={`absolute inset-0 w-full h-full ${isEditor ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
        />

        {!loading && !errorMsg && world && (
          <>
            {isEditor ? (
              <EditorUI
                engine={engine!}
                stats={devStats}
                isWireframe={isWireframe}
                onToggleWireframe={() => setIsWireframe(engine!.toggleWireframe())}
                showConsole={showConsole}
                onToggleConsole={() => setShowConsole((v) => !v)}
                showCharacterInspector={showCharacterInspector}
                onToggleCharacterInspector={() => setShowCharacterInspector((v) => !v)}
                notify={notify}
              />
            ) : (
              <>
                <ViewportHUD isWireframe={isWireframe} telemetry={character?.telemetry} camera={engine?.camera ?? null} />
                <ControlsOverlay inputManager={engine?.input ?? null} telemetry={character?.telemetry} />

                <GameHUD
                  hud={hud}
                  inventory={world.inventoryManager}
                  hidden={isBuildingUI}
                  devToolsEnabled={DEV_TOOLS_ENABLED}
                  onOpenBackpack={() => handleToggleInventory()}
                  onToggleBuild={building.toggleBuildMode}
                  onOpenEditor={() => engine!.setMode('editor')}
                  onOpenMap={() => handleToggleMap()}
                  onCallMoped={() => engine!.callMoped()}
                  onPause={() => setPaused(true)}
                  onAction={(a) => world.gameplay.runAction(a)}
                />

                {buildingTelemetry && (
                  <>
                    {isBuildingUI && (
                      <BuildingHUD
                        telemetry={buildingTelemetry}
                        inputManager={engine?.input}
                        onToggleBuildMode={building.toggleBuildMode}
                        onTogglePaintMode={building.togglePaintMode}
                        onSelectPiece={building.selectPiece}
                        onRotatePiece={building.rotatePiece}
                        onToggleSnap={building.toggleSnap}
                        onDemolish={building.demolish}
                        onPlace={building.place}
                        onConfirmWalls={building.confirmWalls}
                        onConfirmFloors={building.confirmFloors}
                        onConfirmFoundations={building.confirmFoundations}
                        onConfirmAll={building.confirmAll}
                      />
                    )}
                    {buildingTelemetry.isPaintingModeActive && (
                      <HeartopiaPaintingHUD
                        telemetry={buildingTelemetry}
                        onTogglePaintMode={building.togglePaintMode}
                        onSelectWallpaper={building.selectWallpaper}
                        onSelectTool={building.selectPaintingTool}
                        onUndo={building.undoPaint}
                        onRedo={building.redoPaint}
                        onSetGridCellSize={building.setGridCellSize}
                      />
                    )}
                  </>
                )}

                {!isBuildingUI && (
                  <>
                    <InteractionPrompts
                      inventoryManager={world.inventoryManager}
                      onOpenInventory={() => handleToggleInventory(true)}
                    />
                  </>
                )}

                <HeartopiaInventoryHUD
                  inventoryManager={world.inventoryManager}
                  isOpen={isInventoryOpen}
                  onClose={() => handleToggleInventory(false)}
                  onEquipItem={(itemId: string) => character?.model.equipToolOrProp(itemId)}
                />

                {!isBuildingUI && hud && !hud.inCave && <SavingBadge />}
                {isMapOpen && <WorldMap world={world} heading={engine!.getHeading} onClose={() => handleToggleMap(false)} />}

                {isPaused && (
                  <PauseMenu
                    onResume={() => setPaused(false)}
                    onSave={() => {
                      world.saves.save(AUTOSAVE_SLOT);
                      showToast({ text: t('pause.saved'), type: 'success' });
                    }}
                    respawnAt={hud?.respawnAt ?? 'spawn'}
                    onRespawn={() => {
                      setPaused(false);
                      engine?.respawnPlayer();
                    }}
                  />
                )}

                {hud?.panel === 'cook' && <CookingPanel hud={hud} gameplay={world.gameplay} inventory={world.inventoryManager} onClose={closePanel} />}
                {hud?.panel === 'shop' && <ShopPanel hud={hud} gameplay={world.gameplay} inventory={world.inventoryManager} onClose={closePanel} />}
              </>
            )}
          </>
        )}

        {/* Doorway fade (caves, lighthouse lookout, sleep, respawn) */}
        <div
          className={`absolute inset-0 z-[45] bg-black pointer-events-none transition-opacity ${hud?.sleeping ? 'duration-700' : 'duration-300'}`}
          style={{ opacity: hud?.fading ? 1 : 0 }}
        />
        {hud?.sleeping && (
          <div className="absolute inset-0 z-[46] flex flex-col items-center justify-center pointer-events-none text-white/85 animate-pulse">
            <span className="text-4xl font-extrabold tracking-[0.3em]">Z z z</span>
            <span className="mt-2 text-sm font-semibold">{t('sleep.zzz')}</span>
          </div>
        )}
        {toast && <ToastPill toast={toast} />}
        {sceneFiles.isDragOver && <JsonDropOverlay />}
        {loading && <LoadingOverlay />}
        {errorMsg && <ErrorOverlay message={errorMsg} />}

        {isEditor && showConsole && (
          <div className="absolute bottom-10 left-[19rem] right-2 z-40 pointer-events-auto">
            <ConsoleFooter logs={logs} onClearLogs={clearLogs} isExpanded={true} setIsExpanded={() => setShowConsole(false)} />
          </div>
        )}
      </main>

      {isEditor && showCharacterInspector && world && (
        <DebugPanel
          controller={character}
          camera={engine?.camera ?? null}
          physics={world.physics}
          debugRenderer={world.debugRenderer}
          onTeleport={() => character?.respawn()}
          onClose={() => setShowCharacterInspector(false)}
        />
      )}
    </div>
  );
}
