import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { CharacterController } from '../character/CharacterController';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { DebugRenderer } from '../physics/DebugRenderer';
import { InputManager } from '../input/InputManager';
import { ParticleManager } from '../particles/ParticleManager';
import { WaterEffects } from '../scene/WaterEffects';
import { WaterParticleSystem } from '../particles/WaterParticleSystem';
import { BuildingManager } from '../building/BuildingManager';
import { PreviewGhostRenderer } from '../building/PreviewGhostRenderer';
import { BuildingTelemetry } from '../building/types/BuildingTypes';
import { InventoryManager } from '../inventory/InventoryManager';
import { FarmingManager } from '../farming/FarmingManager';
import { FarmInteractionPrompt } from '../farming/types/FarmingTypes';
import { ForestZone } from '../forest/ForestZone';
import { FURNITURE_LIGHTS, FURNITURE_MATERIALS } from '../building/furniture/FurnitureCatalog';
import type { ExtraLight } from '../world/NightLighting';
import { AmbientAudio } from '../audio/AmbientAudio';
import { audioEngine } from '../audio/AudioEngine';
import { PrecipitationOcclusion } from '../world/PrecipitationOcclusion';
import { GridNavigator } from '../navigation/GridNavigator';
import { CompanionNPC } from '../npc/CompanionNPC';
import { t } from '../i18n/i18n';
import { PropTreeField } from '../gathering/PropTreeField';
import { RockField } from '../gathering/RockField';
import { GATHERING_CONFIG, ROCK_SPOTS, TREE_SPOTS } from '../gathering/GatheringConfig';
import { GatherPrompt } from '../character/abilities/GatheringAbility';
import { ConsoleLogEntry } from '../components/ConsoleFooter';
import { VehicleController } from '../vehicle/VehicleController';
import { TerrainSystem } from '../world/TerrainSystem';
import { WaterSystem } from '../world/WaterSystem';
import { WeatherSystem } from '../world/WeatherSystem';
import { PropSystem, PROP_GLOW_MATERIALS } from '../world/PropSystem';
import { NightLighting, installGlobalNightLights } from '../world/NightLighting';
import { SaveSystem, AUTOSAVE_SLOT } from '../world/SaveSystem';
import { isMobileDevice, worldSettings } from '../world/WorldSettings';
import { GameplayManager, GameplayHudState } from '../gameplay/GameplayManager';
import { EditorController } from '../editor/EditorController';

export const SPAWN_POSITION = new THREE.Vector3(0, 2.0, 5.0);

/** Developer tools are available in dev builds, or in production with `?dev` in the URL. */
export const DEV_TOOLS_ENABLED =
  import.meta.env.DEV || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('dev'));

export type EngineMode = 'play' | 'editor';

export interface DevStats {
  fps: number;
  frameMs: number;
  physicsMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  heapMb: number | null;
  props: number;
  pieces: number;
}

/**
 * Bridge from the simulation loop to the React UI.
 * All callbacks are throttled by the engine; none of them run every frame.
 */
export interface GameEngineCallbacks {
  onReady(): void;
  onError(message: string): void;
  onLog(type: ConsoleLogEntry['type'], message: string): void;
  onStats(fps: number, physicsTimeMs: number): void;
  onBuildingTelemetry(telemetry: BuildingTelemetry): void;
  onFarmingPrompt(prompt: FarmInteractionPrompt | null): void;
  onGatherPrompt(prompt: GatherPrompt | null): void;
  /** Items just added to the backpack by chopping or mining. */
  onResourcesGathered(items: { itemId: string; amount: number }[]): void;
  onWireframeToggled(enabled: boolean): void;
  /** `undefined` toggles, `false` closes (Escape). */
  onInventoryHotkey(open?: boolean): void;
  onGameplayHud(state: GameplayHudState): void;
  onNotify(text: string, type?: 'success' | 'info' | 'warning'): void;
  onModeChange(mode: EngineMode): void;
  onEditorChanged(): void;
  onDevStats(stats: DevStats): void;
}

/** Systems that only exist after the async Rapier initialization succeeded. */
export interface GameWorld {
  physics: PhysicsWorld;
  character: CharacterController;
  debugRenderer: DebugRenderer;
  terrain: TerrainSystem;
  water: WaterSystem;
  weather: WeatherSystem;
  props: PropSystem;
  nightLighting: NightLighting;
  inventoryManager: InventoryManager;
  farmingManager: FarmingManager;
  forest: ForestZone;
  propTrees: PropTreeField;
  rocks: RockField;
  particleManager: ParticleManager;
  vehicle: VehicleController;
  gameplay: GameplayManager;
  editor: EditorController;
  saves: SaveSystem;
}

/**
 * Owns the Three.js renderer, Rapier physics and every gameplay system,
 * and runs the main simulation & render loop outside of React.
 */
export class GameEngine {
  public readonly camera: ThirdPersonCamera;
  public readonly input: InputManager;
  public world: GameWorld | null = null;
  public mode: EngineMode = 'play';

  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly physics = new PhysicsWorld();
  private readonly resizeObserver: ResizeObserver;
  private animationFrameId = 0;
  private isDisposed = false;
  private keyG = false;
  private readonly ambient = new AmbientAudio();
  private campfireTimer = 0;
  private nearestCampfire: THREE.Vector3 | null = null;
  private readonly listenerPos = new THREE.Vector3();

  // Adaptive resolution: drops the pixel ratio when frames run long, restores it when there is headroom
  private lastFarmPromptKey = '';
  private lastGatherPromptKey = '';

  private maxPixelRatio = 1;
  private minPixelRatio = 0.75;
  private perfWindowMs = 0;
  private perfWindowFrames = 0;

  constructor(private readonly container: HTMLElement, private readonly callbacks: GameEngineCallbacks) {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const isMobile = isMobileDevice();
    // Must run before any material compiles so every lit shader gets the night light loop
    installGlobalNightLights();
    // MSAA on top of a high-DPI backbuffer is wasted fill-rate; HiDPI screens are sharp enough without it
    this.renderer = new THREE.WebGLRenderer({
      antialias: !isMobile && window.devicePixelRatio < 1.5,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setSize(width, height);
    this.maxPixelRatio = isMobile ? Math.min(window.devicePixelRatio, 1.0) : Math.min(window.devicePixelRatio, 1.5);
    this.minPixelRatio = isMobile ? 0.6 : 0.75;
    this.renderer.setPixelRatio(this.maxPixelRatio);
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.camera = new ThirdPersonCamera(width / height);
    this.camera.camera.far = 220; // distance fog hides the rest of the 512 m island and the sea
    this.camera.camera.updateProjectionMatrix();
    this.input = new InputManager(container);

    window.addEventListener('resize', this.handleResize);
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(container);

    this.init();
  }

  public dispose(): void {
    this.isDisposed = true;
    if (this.world && this.mode === 'play') this.world.saves.save(AUTOSAVE_SLOT);
    cancelAnimationFrame(this.animationFrameId);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('pagehide', this.handlePageHide);
    window.removeEventListener('resize', this.handleResize);
    this.resizeObserver.disconnect();
    this.input.dispose();
    this.world?.editor.dispose();
    this.world?.debugRenderer.dispose();
    this.physics.dispose();
    this.renderer.dispose();
    this.renderer.domElement.parentElement?.removeChild(this.renderer.domElement);
  }

  /** Toggles Rapier collider wireframe rendering and returns the new state. */
  public toggleWireframe(): boolean {
    return this.world?.debugRenderer.toggle() ?? false;
  }

  public setMode(mode: EngineMode): void {
    if (!this.world || this.mode === mode || (mode === 'editor' && !DEV_TOOLS_ENABLED)) return;
    const { character, editor } = this.world;
    if (mode === 'editor') {
      if (character.buildAbility?.isBuildModeActive) character.buildAbility.toggleBuildMode();
      if (character.buildAbility?.isPaintingModeActive) character.buildAbility.togglePaintingMode();
      this.world.gameplay.fishing.cancel();
    }
    this.mode = mode;
    editor.setActive(mode === 'editor');
    this.callbacks.onModeChange(mode);
  }

  private async init(): Promise<void> {
    try {
      await this.physics.init();
      if (this.isDisposed) return;

      const { scene, physics, callbacks } = this;

      // World: terrain, water, sky/weather, placeable props
      const terrain = new TerrainSystem(scene, physics);
      terrain.commit();
      const water = new WaterSystem(scene);
      const weather = new WeatherSystem(scene);
      weather.onLightning = () => this.ambient.thunder(this.listenerPos);
      weather.setOcclusion(new PrecipitationOcclusion(physics, WeatherSystem.PRECIP_BOX));
      const props = new PropSystem(scene, physics, terrain);
      const nightLighting = new NightLighting(scene, props, weather, PROP_GLOW_MATERIALS);

      const waterEffects = new WaterEffects(scene);
      const waterParticles = new WaterParticleSystem(scene);
      const particleManager = new ParticleManager(scene);

      const buildingManager = new BuildingManager(physics, scene, particleManager);
      const previewGhostRenderer = new PreviewGhostRenderer(scene);

      const inventoryManager = new InventoryManager();
      const farmingManager = new FarmingManager(scene, particleManager);
      buildingManager.setFarmingManager(farmingManager);
      // Lamp furniture inside buildings feeds the night lighting
      nightLighting.setExtraLights(
        () => {
          const out: ExtraLight[] = [];
          for (const piece of buildingManager.getAllPieces()) {
            const light = FURNITURE_LIGHTS[piece.type];
            if (light) out.push({ x: piece.position.x, y: piece.position.y + light.yOffset, z: piece.position.z, range: light.range, halo: light.halo, intensity: light.intensity });
          }
          return out;
        },
        { bulbs: [FURNITURE_MATERIALS.bulb], shades: [FURNITURE_MATERIALS.shade] }
      );

      const character = new CharacterController(physics, scene, SPAWN_POSITION.clone(), particleManager);
      character.setWaterSystems(waterEffects, waterParticles);
      character.setBuildingSystems(buildingManager, previewGhostRenderer);
      character.setFarmingSystems(farmingManager, inventoryManager);

      const giveResources = (items: { itemId: string; amount: number }[]) => {
        items.forEach(({ itemId, amount }) => inventoryManager.addItem(itemId, amount));
        callbacks.onResourcesGathered(items);
      };
      const forest = new ForestZone(physics, scene, scene, particleManager, {
        treeSpots: TREE_SPOTS,
        regrowSeconds: GATHERING_CONFIG.TREE_REGROW_SECONDS,
        woodPerTree: GATHERING_CONFIG.TREE_WOOD_YIELD,
        onWoodHarvested: (amount) => giveResources([{ itemId: 'wood', amount }]),
      });
      const rocks = new RockField(physics, scene, particleManager, ROCK_SPOTS);
      rocks.onMined = (drops) => giveResources(drops);
      const propTrees = new PropTreeField(props, particleManager);
      propTrees.onWood = (amount) => giveResources([{ itemId: 'wood', amount }]);
      character.setGatheringSystems(forest, rocks, inventoryManager, propTrees);

      const vehicle = new VehicleController(physics, scene, new THREE.Vector3(7, 1.2, 2), -Math.PI / 2);
      const gameplay = new GameplayManager(scene, character, inventoryManager, props, weather, terrain, particleManager);
      gameplay.onNotify = (text, type) => callbacks.onNotify(text, type);

      // Villager companion: paths come from a physics-sampled grid that resets when anything is built
      const nav = new GridNavigator(physics, () => (buildingManager.revision * 100003 + props.revision) * 7919 + terrain.revision, {
        cell: 0.5,
        radius: 0.28,
        height: 1.5, // the character capsule is 1.5 m tall
        maxStepUp: 0.45,
        maxDrop: 1.2,
        minFloorY: () => worldSettings.waterLevel - 0.25,
        doors: () => buildingManager.getDoorOpenings(),
      });
      buildingManager.onDoorToggled = (piece) => nav.invalidateAround(piece.position, 2.5);
      const npcSpawn = new THREE.Vector3(-4, 0, 7);
      npcSpawn.y = terrain.getHeight(npcSpawn.x, npcSpawn.z);
      gameplay.companion = new CompanionNPC(physics, scene, nav, npcSpawn, t('npc.name'), {
        isOpen: (id) => !!buildingManager.getPiece(id)?.isOpen,
        toggle: (id, from) => buildingManager.toggleDoor(id, from),
      });
      const editor = new EditorController(scene, this.camera.camera, this.renderer.domElement, this.input, terrain, props);
      const debugRenderer = new DebugRenderer(physics, scene);

      this.world = {
        physics,
        character,
        debugRenderer,
        terrain,
        water,
        weather,
        props,
        nightLighting,
        inventoryManager,
        farmingManager,
        forest,
        propTrees,
        rocks,
        particleManager,
        vehicle,
        gameplay,
        editor,
        saves: null as unknown as SaveSystem,
      };
      this.world.saves = new SaveSystem(this.world);

      // Resume the last session, or dress a fresh world
      if (!this.world.saves.load(AUTOSAVE_SLOT)) {
        props.populateDefault();
        gameplay.pets.spawnDefaults(SPAWN_POSITION);
      } else {
        callbacks.onLog('info', 'Відновлено останнє автозбереження.');
      }
      if (!gameplay.pets.pets.length) gameplay.pets.spawnDefaults(SPAWN_POSITION);

      window.addEventListener('keydown', this.handleKeyDown);
      window.addEventListener('keyup', this.handleKeyUp);
      window.addEventListener('pagehide', this.handlePageHide);
      if (DEV_TOOLS_ENABLED) (window as unknown as { dev: unknown }).dev = this.createDevApi();

      this.clock.start();
      this.lastFpsUpdate = performance.now();
      this.animate();
      callbacks.onReady();
    } catch (err: any) {
      console.error('Failed to initialize 3D scene / Rapier physics:', err);
      this.callbacks.onError(err?.message || 'Error loading physics engine');
    }
  }

  // Loop state
  private readonly clock = new THREE.Clock(false);
  private frameCount = 0;
  private lastFpsUpdate = 0;
  private autosaveTimer = 60;
  private hudTimer = 0;
  private lastHudKey = '';
  private lastEditorRevision = -1;
  private frameMsAccum = 0;
  private lastStepMs = 0;

  private animate = (): void => {
    if (this.isDisposed || !this.world) return;
    this.animationFrameId = requestAnimationFrame(this.animate);
    const frameStart = performance.now();

    const w = this.world;
    const { character, farmingManager, forest, rocks, particleManager, debugRenderer, vehicle, terrain, editor } = w;
    const { input: inputManager, camera: tpCamera, physics, callbacks } = this;
    const editing = this.mode === 'editor';

    const rawDt = Math.min(this.clock.getDelta(), 0.05);
    const dt = rawDt * worldSettings.timeScale;

    inputManager.update();

    const mouseDelta = inputManager.consumeMouseDelta();
    const isDraggingWall = character.buildAbility?.wallSelectionSystem?.isDragging ?? false;
    const isPaintingMode = character.buildAbility?.isPaintingModeActive ?? false;
    const isPaintingWithLMB = isPaintingMode && inputManager.isMouseDown;
    if (!editing && !isDraggingWall && !isPaintingWithLMB && (mouseDelta.x !== 0 || mouseDelta.y !== 0)) {
      tpCamera.handleMouseInput(mouseDelta.x, mouseDelta.y);
      vehicle.notifyMouseLook();
    }
    const mouseScroll = inputManager.consumeMouseScroll();
    if (mouseScroll !== 0 && !editing) tpCamera.handleZoom(mouseScroll);

    // Vehicle forces are applied before the physics step
    const isDriving = !editing && vehicle.update(dt, inputManager, tpCamera, character);

    const pStart = performance.now();
    if (dt > 0) physics.step(dt);
    const stepTime = performance.now() - pStart;
    this.lastStepMs = stepTime;
    vehicle.syncVisuals(dt);

    if (!editing && !isDriving) character.update(dt, inputManager, tpCamera);
    character.buildAbility?.buildingManager?.flushPendingRegeneration();
    if (character.buildAbility) {
      inputManager.setBuildMode(character.buildAbility.isBuildModeActive);
      inputManager.setPaintMode(character.buildAbility.isPaintingModeActive);
    }

    // World systems
    terrain.update(rawDt);
    w.props.update();
    w.props.updateVisibility(this.camera.camera.position);
    w.water.update(dt, this.camera.camera.position);
    if (editing) {
      editor.update(rawDt);
    } else {
      tpCamera.isHoldingObject = character.telemetry.isHoldingObject;
      tpCamera.isBuilding = character.telemetry.isBuildModeActive || isPaintingMode;
      const cameraTargetPos = isDriving ? vehicle.getPosition() : character.getPosition();
      tpCamera.update(dt, cameraTargetPos, physics, isDriving ? vehicle.collider : character.collider);
    }
    w.weather.update(dt, tpCamera.camera.position);
    w.nightLighting.setViewportHeight(this.renderer.domElement.height);
    w.nightLighting.update(dt, tpCamera.camera.position, editing ? null : isDriving ? vehicle.getPosition() : character.getPosition());
    farmingManager.rainIntensity = w.weather.rainIntensity;
    this.updateAudio(dt, editing ? tpCamera.camera.position : isDriving ? vehicle.getPosition() : character.getPosition(), isDriving);

    farmingManager.update(dt);
    forest.update(dt);
    w.propTrees.update(dt);
    rocks.update(dt);
    if (!editing) w.gameplay.update(dt, inputManager, isDriving, this.consumeKeyG());

    // Push prompts to React only when they actually change (each push re-renders the HUD tree)
    if (this.frameCount % 4 === 0 && character.farmingAbility) {
      const farm = character.farmingAbility.currentPrompt;
      const gather = character.gatheringAbility.currentPrompt;
      const farmKey = farm ? JSON.stringify(farm) : '';
      const gatherKey = gather ? JSON.stringify(gather) : '';
      if (farmKey !== this.lastFarmPromptKey) {
        this.lastFarmPromptKey = farmKey;
        callbacks.onFarmingPrompt(farm ? { ...farm } : null);
      }
      if (gatherKey !== this.lastGatherPromptKey) {
        this.lastGatherPromptKey = gatherKey;
        callbacks.onGatherPrompt(gather ? { ...gather } : null);
      }
    }

    particleManager.update(dt);
    debugRenderer.update(character);

    this.renderer.render(this.scene, tpCamera.camera);

    // Throttled UI pushes
    this.hudTimer -= rawDt;
    const hudKey = w.gameplay.hudKey;
    // The reel minigame marker moves continuously: stream it while active
    if (w.gameplay.fishing.state.phase === 'reel' && this.frameCount % 2 === 0) callbacks.onGameplayHud(w.gameplay.getHudState());
    if (this.hudTimer <= 0 || hudKey !== this.lastHudKey) {
      if (hudKey !== this.lastHudKey || this.hudTimer <= 0) callbacks.onGameplayHud(w.gameplay.getHudState());
      this.lastHudKey = hudKey;
      this.hudTimer = 0.5;
    }
    if (editor.revision !== this.lastEditorRevision) {
      this.lastEditorRevision = editor.revision;
      callbacks.onEditorChanged();
    }

    this.autosaveTimer -= rawDt;
    if (this.autosaveTimer <= 0 && !editing) {
      this.autosaveTimer = 60;
      w.saves.save(AUTOSAVE_SLOT);
    }

    this.frameMsAccum += performance.now() - frameStart;
    this.updateDiagnostics(stepTime);
  };

  /** Diagnostics & Telemetry updates (~3 times per second). */
  private updateDiagnostics(stepTime: number): void {
    const { character, props } = this.world!;
    const { callbacks } = this;

    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsUpdate >= 300) {
      const fps = (this.frameCount * 1000) / (now - this.lastFpsUpdate);
      this.adaptResolution(fps, now - this.lastFpsUpdate);
      callbacks.onStats(fps, stepTime);
      if (DEV_TOOLS_ENABLED) {
        const info = this.renderer.info;
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        callbacks.onDevStats({
          fps,
          frameMs: this.frameMsAccum / this.frameCount,
          physicsMs: this.lastStepMs,
          drawCalls: info.render.calls,
          triangles: info.render.triangles,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          programs: info.programs?.length ?? 0,
          heapMb: mem ? mem.usedJSHeapSize / 1048576 : null,
          props: props.count(),
          pieces: character.buildAbility?.buildingManager?.getPieceCount() ?? 0,
        });
      }
      this.frameCount = 0;
      this.frameMsAccum = 0;
      this.lastFpsUpdate = now;

      if (character.buildAbility) callbacks.onBuildingTelemetry({ ...character.buildAbility.getTelemetry() });
    } else if (character.buildAbility && (character.buildAbility.isBuildModeActive || character.buildAbility.isPaintingModeActive)) {
      if (this.frameCount % 4 === 0) callbacks.onBuildingTelemetry({ ...character.buildAbility.getTelemetry() });
    }
  }

  /** Called ~3x per second. Ignores hidden tabs (rAF is paused/throttled there, fps means nothing). */
  private adaptResolution(fps: number, windowMs: number): void {
    if (document.hidden || !document.hasFocus()) {
      this.perfWindowMs = this.perfWindowFrames = 0;
      return;
    }
    this.perfWindowMs += windowMs;
    this.perfWindowFrames += (fps * windowMs) / 1000;
    if (this.perfWindowMs < 2000) return;
    const avgFps = (this.perfWindowFrames * 1000) / this.perfWindowMs;
    this.perfWindowMs = this.perfWindowFrames = 0;

    const pr = this.renderer.getPixelRatio();
    let next = pr;
    if (avgFps < 45) next = Math.max(this.minPixelRatio, pr - 0.15);
    else if (avgFps > 58) next = Math.min(this.maxPixelRatio, pr + 0.1);
    if (Math.abs(next - pr) > 0.01) {
      this.renderer.setPixelRatio(next);
      this.callbacks.onLog('info', `Роздільна здатність рендера: ${Math.round(next * 100)}% (FPS ${Math.round(avgFps)})`);
    }
  }

  /** Listener at the camera; ambience (rain, wind, campfire, engine) around the player. */
  private updateAudio(dt: number, playerPos: THREE.Vector3, isDriving: boolean): void {
    const w = this.world;
    if (!w) return;
    const camera = this.camera.camera;
    audioEngine.updateListener(camera);
    audioEngine.setUnderwater(camera.position.y < worldSettings.waterLevel || !!w.character.oxygenAbility?.isUnderwater);
    this.listenerPos.copy(camera.position);
    if (!audioEngine.context) return;

    this.campfireTimer -= dt;
    if (this.campfireTimer <= 0) {
      this.campfireTimer = 0.5;
      const fire = w.props.findNearest('campfire', playerPos, 30);
      this.nearestCampfire = fire ? fire.position.clone().setY(fire.position.y + 0.4) : null;
    }
    const weather = w.weather;
    const storm = weather.weather === 'storm' ? 1 : 0;
    this.ambient.update({
      listener: this.listenerPos,
      rain: weather.rainIntensity * (1 - weather.snowAmount),
      wind: Math.max(storm * 0.9, weather.snowAmount * 0.7, weather.weather === 'rain' ? 0.25 : 0),
      underRoof: weather.isSheltered(playerPos),
      campfire: this.nearestCampfire,
      engine: isDriving ? { position: w.vehicle.getPosition(), speedKmh: w.vehicle.speedKmh } : null,
    });
  }

  private consumeKeyG(): boolean {
    const g = this.keyG;
    this.keyG = false;
    return g;
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'F1' || (e.code === 'Backquote' && DEV_TOOLS_ENABLED)) {
      e.preventDefault();
      this.setMode(this.mode === 'editor' ? 'play' : 'editor');
      return;
    }
    if (this.mode === 'editor') return;
    if (this.world?.character.buildAbility?.handlePaintHotkey(e)) {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
      return;
    }
    if (e.code === 'KeyG' && !e.repeat) {
      this.keyG = true;
    } else if (e.code === 'KeyH' && DEV_TOOLS_ENABLED) {
      this.callbacks.onWireframeToggled(this.toggleWireframe());
    } else if (e.code === 'KeyQ') {
      this.callbacks.onInventoryHotkey();
    } else if (e.code === 'Escape') {
      this.callbacks.onInventoryHotkey(false);
      if (this.world?.gameplay.panel) this.world.gameplay.openPanel(null);
    }
  };

  private handleKeyUp = (): void => {};

  private handlePageHide = (): void => {
    if (this.world && this.mode === 'play') this.world.saves.save(AUTOSAVE_SLOT);
  };

  private handleResize = (): void => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.camera.aspect = w / h;
    this.camera.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  /** `window.dev` console helpers (dev builds only). */
  private createDevApi() {
    const w = this.world!;
    return {
      engine: this,
      world: w,
      tp: (x: number, z: number, y?: number) =>
        w.character.respawn(new THREE.Vector3(x, (y ?? w.terrain.getHeight(x, z)) + 1.5, z)),
      time: (hour: number) => (worldSettings.timeOfDay = ((hour % 24) + 24) % 24),
      weather: (type: Parameters<WeatherSystem['setWeather']>[0]) => w.weather.setWeather(type),
      water: (level: number) => (worldSettings.waterLevel = level),
      give: (itemId: string, n = 1) => w.inventoryManager.addItem(itemId, n),
      spawn: (type: string, x: number, z: number, rot = 0, scale = 1) => w.props.add(type, x, z, rot, scale),
      save: (slot = 'dev') => w.saves.save(slot),
      load: (slot = 'dev') => w.saves.load(slot),
      editor: (on = true) => this.setMode(on ? 'editor' : 'play'),
      stats: () => ({ ...this.renderer.info.render, ...this.renderer.info.memory }),
      npcPath: (on = true) => w.gameplay.companion?.setDebug(on),
    };
  }
}
