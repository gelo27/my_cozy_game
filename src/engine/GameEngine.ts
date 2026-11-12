import type { PestKind } from '../gameplay/Pests';
import type { Shark } from '../gameplay/Shark';
import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { CharacterController } from '../character/CharacterController';
import { CharacterModel } from '../character/CharacterModel';
import { loadWheatModel } from '../farming/WheatModel';
import { loadCropModels } from '../farming/CropModels';
import { FIELD_CELLS } from '../farming/FieldManager';
import { hitchLog } from './HitchLog';
import { loadTreeModels, setFoliageWeatherWind } from '../world/TreeModels';
import { setSnowCover } from '../world/SnowCover';
import { Season, firstDayOf } from '../world/Seasons';
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
import { CoastAudio, CoastState } from '../audio/CoastAudio';
import { AmbientAudio } from '../audio/AmbientAudio';
import { audioEngine } from '../audio/AudioEngine';
import { music, type MusicWorldState } from '../audio/music/MusicDirector';
import { caveAudio } from '../audio/CaveAudio';
import { FootstepAudio, FootSurface } from '../audio/Footsteps';
import { WheatRustle } from '../audio/WheatRustle';
import { TerrainTileType } from '../terrain/types/TerrainTypes';
import type RAPIER from '@dimforge/rapier3d-compat';

const WHITE_MIST = new THREE.Color(0.92, 0.95, 1);

/** Painted terrain tile -> footstep recipe. */
const TILE_SURFACE: Record<TerrainTileType, FootSurface> = {
  [TerrainTileType.GRASS]: 'grass',
  [TerrainTileType.DIRT_ROAD]: 'dirt',
  [TerrainTileType.ASPHALT_ROAD]: 'asphalt',
  [TerrainTileType.STONE_COBBLE]: 'cobble',
  [TerrainTileType.SAND_BEACH]: 'sand',
  [TerrainTileType.SNOW]: 'snow',
};

/** Floor paint (building) -> footstep recipe; unpainted floors are wooden planks. */
function floorSurface(wallpaperId: string): FootSurface {
  if (/carpet|rug/.test(wallpaperId)) return 'carpet';
  if (/marble|mosaic|tile/.test(wallpaperId)) return 'tile';
  if (/flagstone|cotto|stone|brick|concrete|cobble/.test(wallpaperId)) return 'stone';
  return 'wood';
}
import { PrecipitationOcclusion } from '../world/PrecipitationOcclusion';
import { GridNavigator } from '../navigation/GridNavigator';
import { CompanionNPC } from '../npc/CompanionNPC';
import { MAX_WORKERS, WorkerManager } from '../npc/WorkerManager';
import { TaskBoard, WorkerRole } from '../npc/TaskBoard';
import { FarmStorage, STORAGE_CHEST } from '../npc/FarmStorage';
import { t } from '../i18n/i18n';
import { PropTreeField } from '../gathering/PropTreeField';
import { AppleOrchard } from '../gathering/AppleOrchard';
import { FlowerBeds } from '../gathering/FlowerBeds';
import { TreeNursery } from '../gathering/TreeNursery';
import { GroundAim } from '../gathering/GroundAim';
import { loadAppleModels } from '../world/AppleTreeModel';
import { BushSway, FLOWER_SWAY_OPTIONS } from '../world/BushSway';
import { FallingLeaves } from '../particles/FallingLeaves';
import { RockField } from '../gathering/RockField';
import { GATHERING_CONFIG, ROCK_SPOTS, TREE_SPOTS } from '../gathering/GatheringConfig';
import { GatherPrompt } from '../character/abilities/GatheringAbility';
import { ConsoleLogEntry } from '../components/ConsoleFooter';
import { VehicleController } from '../vehicle/VehicleController';
import { MopedController } from '../vehicle/MopedController';
import { BoatController } from '../vehicle/BoatController';
import { buildLighthousePier } from '../world/Pier';
import { WildlifeSystem } from '../wildlife/WildlifeSystem';
import { StaticShadows } from '../world/StaticShadows';
import { GrassField } from '../world/GrassField';
import { LightningStrikes } from '../world/Lightning';
import { TerrainSystem } from '../world/TerrainSystem';
import { WaterSystem } from '../world/WaterSystem';
import { setRippleCamera } from '../scene/WaterDetails';
import { waterRippleSim } from '../scene/WaterRippleSim';
import { updatePickGlow } from '../world/PickGlow';
import { updateCloudShadows } from '../world/CloudShadows';
import { LightShafts } from '../world/LightShafts';
import { RiverSystem } from '../world/rivers/RiverSystem';
import { riverWorld } from '../world/rivers/RiverWorld';
import { WeatherSystem } from '../world/WeatherSystem';
import { PropSystem, PropInstance, PROP_GLOW_MATERIALS } from '../world/PropSystem';
import { NightLighting, installGlobalNightLights, setGroundMist } from '../world/NightLighting';
import { SaveSystem, AUTOSAVE_SLOT } from '../world/SaveSystem';
import { setAlgaeDaylight } from '../world/AlgaeChains';
import { setWebLight } from '../world/SpiderWebs';
import { setGlassLight } from '../scene/GlassMatcap';
import { VIEW_DISTANCE, isMobileDevice, worldSettings } from '../world/WorldSettings';
import { GameplayManager, GameplayHudState, GameplayPrompt } from '../gameplay/GameplayManager';
import { EditorController } from '../editor/EditorController';
import { ExplorationManager } from '../explore/ExplorationManager';

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
  onGameplayPrompt(prompt: GameplayPrompt | null): void;
  /** Items just added to the backpack by chopping or mining. */
  onResourcesGathered(items: { itemId: string; amount: number }[]): void;
  onWireframeToggled(enabled: boolean): void;
  /** `undefined` toggles, `false` closes (Escape). */
  onInventoryHotkey(open?: boolean): void;
  /** `undefined` toggles the island map, `false` closes it. */
  onMapHotkey(open?: boolean): void;
  /** Escape with nothing else to close: toggle the pause menu. */
  onPauseHotkey(): void;
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
  rivers: RiverSystem;
  weather: WeatherSystem;
  props: PropSystem;
  nightLighting: NightLighting;
  inventoryManager: InventoryManager;
  farmingManager: FarmingManager;
  forest: ForestZone;
  propTrees: PropTreeField;
  orchard: AppleOrchard;
  nursery: TreeNursery;
  bushSway: BushSway;
  flowerSway: BushSway;
  fallingLeaves: FallingLeaves;
  rocks: RockField;
  particleManager: ParticleManager;
  vehicle: VehicleController;
  moped: MopedController;
  boat: BoatController;
  wildlife: WildlifeSystem;
  shadows: StaticShadows;
  grass: GrassField;
  lightning: LightningStrikes;
  exploration: ExplorationManager;
  gameplay: GameplayManager;
  editor: EditorController;
  saves: SaveSystem;
}

/**
 * Owns the Three.js renderer, Rapier physics and every gameplay system,
 * and runs the main simulation & render loop outside of React.
 */
/** Structural equality for small plain HUD objects (no strings built, unlike a JSON.stringify compare). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  if (ka.length !== Object.keys(b as object).length) return false;
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

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
  public readonly ambient = new AmbientAudio();
  /** Surf and gulls along the shores. */
  private readonly coast = new CoastAudio();
  private coastState: CoastState | null = null;
  /** Reused every frame (no per-frame garbage). */
  private readonly musicState: MusicWorldState = {
    timeOfDay: 12, night: 0, weather: 'clear', rain: 0, inCave: false, underwater: false, sleeping: false, threat: 0,
  };
  /** Fake god rays while the camera is under water. */
  private lightShafts: LightShafts | null = null;
  private readonly footsteps = new FootstepAudio();
  private readonly mistColor = new THREE.Color();
  private readonly wheatRustle = new WheatRustle();
  private prevSwimming = false;
  private prevVelY = 0;
  private campfireTimer = 0;
  private landTimer = 0;
  /** Pause menu open: no simulation, no rendering (the last frame stays on the canvas). */
  private paused = false;
  /** Draw one frame while paused (after a resize the canvas is cleared). */
  private pausedRedraw = false;
  /** 1 on land, fading to 0 when the player is far out at sea (no crickets there). */
  private landNear = 1;
  private portalId = '';
  private readonly portalPerches: THREE.Vector3[] = [];
  private readonly portalPoint = new THREE.Vector3();
  private perchTimer = 0;
  /** Tree tops around the listener that birds sing from (rebuilt once a second). */
  private readonly birdPerches: THREE.Vector3[] = [];
  /** 0..1 how much forest is around the player (number of trees within earshot). */
  private forestNear = 0;
  private nearestCampfire: THREE.Vector3 | null = null;
  private waterTimer = 0;
  /** Where the river sound is aimed: glides after the nearest point on the river. */
  private readonly riverTarget = new THREE.Vector3();
  private readonly riverSoundPos = new THREE.Vector3();
  private riverLoud = 0;
  private riverSound: { position: THREE.Vector3; loud: number } | null = null;
  private readonly fallSounds: import('../world/rivers/RiverSystem').FallSound[] = [];
  private readonly listenerPos = new THREE.Vector3();

  // Adaptive resolution: drops the pixel ratio when frames run long, restores it when there is headroom
  private lastFarmPrompt = '';
  /** Reused for the field-wheat pushers so the frame loop doesn't allocate. */
  private readonly pushTmp = new THREE.Vector3();
  /** Scratch list: the sharks parting the algae this frame. */
  private readonly sharkTmp: Shark[] = [];
  private lastGatherPrompt: unknown = null;
  private lastPlayPrompt: GameplayPrompt | null = null;
  private readonly glowClump = { x: 0, z: 0, half: 0 };
  private readonly glowField = { x: 0, z: 0, half: 0 };

  private updatePickGlowTargets(dt: number, editing: boolean): void {
    const w = this.world;
    if (!w || editing) {
      updatePickGlow(dt, null, null);
      return;
    }
    // The clump only while it still stands (it may have just been picked)
    const c = w.gameplay.prompt?.action === 'flowers' ? w.gameplay.flowerTarget : null;
    const clump = c && w.props.get(c.id) === c ? this.glowClump : null;
    if (clump && c) {
      clump.x = c.position.x;
      clump.z = c.position.z;
    }
    const fp = w.character.farmingAbility?.currentPrompt;
    const f = fp?.canHarvest && fp.isField ? w.farmingManager.fields.get(fp.plotId) : null;
    const field = f ? this.glowField : null;
    if (field && f) {
      field.x = f.center.x;
      field.z = f.center.z;
      // The field's own square (neighbouring fields can touch it, so no margin)
      field.half = FIELD_CELLS / 2 + 0.02;
    }
    updatePickGlow(dt, clump, field);
  }

  private maxPixelRatio = 1;
  private minPixelRatio = 0.75;
  private perfWindowMs = 0;
  private perfWindowFrames = 0;
  private perfSlowWindows = 0;
  private perfFastWindows = 0;
  private lastPixelRatioRaise = -Infinity;
  /** A pixel ratio that just proved too slow can't be returned to until this time. */
  private pixelRatioCeiling = Infinity;
  private pixelRatioCeilingUntil = 0;

  constructor(private readonly container: HTMLElement, private readonly callbacks: GameEngineCallbacks) {
    // Dev: the hitch logger notes every push into React (each one is a commit after the frame)
    if (import.meta.env.DEV) {
      const cb = callbacks as unknown as Record<string, unknown>;
      for (const k of Object.keys(cb)) {
        const fn = cb[k];
        if (typeof fn !== 'function' || k === 'onStats') continue;
        cb[k] = (...args: unknown[]) => {
          hitchLog.react();
          return (fn as (...a: unknown[]) => unknown)(...args);
        };
      }
    }
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
    this.camera.camera.far = VIEW_DISTANCE; // distance fog hides the rest of the island and the sea
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
    // Cave network: GPU buffers, colliders, the generator worker if still running, its sounds
    this.world?.exploration.dispose();
    caveAudio.dispose();
    this.wheatRustle.dispose();
    this.physics.dispose();
    this.renderer.dispose();
    this.renderer.domElement.parentElement?.removeChild(this.renderer.domElement);
  }

  private readonly headingDir = new THREE.Vector3();

  /** Camera compass bearing in radians: 0 = north (-Z), PI/2 = east (+X). */
  public getHeading = (): number => {
    const d = this.camera.camera.getWorldDirection(this.headingDir);
    return Math.atan2(d.x, -d.z);
  };

  /** Toggles Rapier collider wireframe rendering and returns the new state. */
  public toggleWireframe(): boolean {
    return this.world?.debugRenderer.toggle() ?? false;
  }

  public get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Pause menu: back to the bed the player last slept in (if it still stands), otherwise to the
   * starting point. Works from a vehicle and from the caves; the doorway fade covers the jump.
   */
  public respawnPlayer(): void {
    const w = this.world;
    if (!w || this.mode !== 'play' || w.gameplay.sleeping) return;
    const spawn = SPAWN_POSITION.clone();
    spawn.y = Math.max(w.terrain.getHeight(spawn.x, spawn.z), worldSettings.waterLevel) + 1.5;
    const { pos, atBed } = w.gameplay.respawnTarget(spawn);
    for (const ride of [w.vehicle, w.moped, w.boat]) if (ride.isPlayerInside) ride.exit(w.character, this.camera);
    if (w.gameplay.fishing.busy) w.gameplay.fishing.cancel();
    w.gameplay.openPanel(null);
    w.exploration.teleport(w.character, this.camera, pos, () => this.callbacks.onNotify(t(atBed ? 'respawn.bed' : 'respawn.spawn'), 'info'));
  }

  /** Freezes the whole game (simulation, clock, rendering) and ducks the ambience. */
  public setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    audioEngine.setPaused(paused);
    if (paused && this.world) this.world.saves.save(AUTOSAVE_SLOT);
    // Do not let the paused time arrive as one big step
    this.clock.getDelta();
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
      water.setTerrain(terrain);
      setRippleCamera(this.camera.camera);
      this.lightShafts = new LightShafts(scene);
      waterRippleSim.setGround((x, z) => terrain.getHeight(x, z));
      const rivers = new RiverSystem(scene, terrain);
      const weather = new WeatherSystem(scene);
      weather.onLightning = () => this.ambient.thunder(this.listenerPos, weather.sound.thunder);
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
      farmingManager.setWorld(terrain, physics);
      // Lamp furniture inside buildings and the landmarks' torches feed the night lighting
      let exploration: ExplorationManager | null = null;
      nightLighting.setExtraLights(
        () => {
          const out: ExtraLight[] = exploration ? exploration.getLights() : [];
          for (const piece of buildingManager.getAllPieces()) {
            const light = FURNITURE_LIGHTS[piece.type];
            if (light) out.push({ x: piece.position.x, y: piece.position.y + light.yOffset, z: piece.position.z, range: light.range, halo: light.halo, intensity: light.intensity });
          }
          return out;
        },
        { bulbs: [FURNITURE_MATERIALS.bulb], shades: [FURNITURE_MATERIALS.shade] },
        () => buildingManager.revision * 4096 + (exploration?.lightRevision ?? 0)
      );

      const character = new CharacterController(physics, scene, SPAWN_POSITION.clone(), particleManager);
      character.setWaterSystems(waterEffects, waterParticles);
      character.setBuildingSystems(buildingManager, previewGhostRenderer);
      character.onFootstep = (intensity, point, collider) => this.playFootstep(intensity, point, collider);
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
      const propTrees = new PropTreeField(props, particleManager, physics);
      propTrees.getCollector = () => character.getPosition();
      farmingManager.getCollector = () => character.getPosition();
      const bushSway = new BushSway(props);
      propTrees.bushSway = bushSway;
      const flowerSway = new BushSway(props, FLOWER_SWAY_OPTIONS);
      // A freshly dug field clears the flowers and mushrooms standing on it
      farmingManager.fields.onDug = (field) => {
        const cx = field.gx + FIELD_CELLS / 2;
        const cz = field.gz + FIELD_CELLS / 2;
        const doomed: number[] = [];
        for (const type of ['flowers', 'mushrooms']) {
          props.forEachNear(cx, cz, FIELD_CELLS, (p) => {
            const reach = FIELD_CELLS / 2 + 0.35 * p.scale;
            if (Math.abs(p.position.x - cx) < reach && Math.abs(p.position.z - cz) < reach) doomed.push(p.id);
          }, type);
        }
        for (const id of doomed) {
          flowerSway.forget(id);
          props.remove(id);
        }
      };
      const fallingLeaves = new FallingLeaves(scene, (x, z) => terrain.getHeight(x, z));
      propTrees.leaves = fallingLeaves;
      propTrees.onWood = (amount) => giveResources([{ itemId: 'wood', amount }]);
      // A felled tree / cleared bush drops its seed: a cone, an acorn or a cutting to plant again
      propTrees.onSeed = (itemId, amount) => giveResources([{ itemId, amount }]);
      character.setGatheringSystems(forest, rocks, inventoryManager, propTrees);
      // Player-planted apple trees: not on fields, not in the caves
      const orchard = new AppleOrchard(scene, physics, terrain, particleManager);
      orchard.leaves = fallingLeaves;
      orchard.props = props;
      orchard.feller = propTrees;
      orchard.onItems = (items) => giveResources(items);
      orchard.isBlocked = (x, z) => !!exploration?.inCave || !!farmingManager.fields.nearest(x, z, 0.9);
      character.gatheringAbility.orchard = orchard;
      // Tulips: picked by hand (E), planted again from the hotbar (same ground rules as the saplings)
      const flowerBeds = new FlowerBeds(scene, props, terrain, physics, particleManager, flowerSway);
      flowerBeds.isBlocked = orchard.isBlocked;
      character.gatheringAbility.flowers = flowerBeds;
      // Pines, oaks and bushes planted from those seeds (same ground rules)
      const nursery = new TreeNursery(scene, props, terrain, physics, particleManager);
      nursery.isBlocked = orchard.isBlocked;
      character.gatheringAbility.nursery = nursery;
      // RMB with the shovel / tulips: aim at the ground with the crosshair, like the slingshot
      character.groundAim = new GroundAim(terrain);

      const vehicle = new VehicleController(physics, scene, new THREE.Vector3(7, 1.2, 2), -Math.PI / 2);
      const mopedSpawn = new THREE.Vector3(2.4, 0, -1.6);
      mopedSpawn.y = terrain.getHeight(mopedSpawn.x, mopedSpawn.z) + 0.45;
      const moped = new MopedController(physics, scene, terrain, mopedSpawn, -Math.PI / 2);
      const gameplay = new GameplayManager(scene, character, inventoryManager, props, weather, terrain, particleManager);
      gameplay.onNotify = (text, type) => callbacks.onNotify(text, type);
      // Pests and pebbles query walls / sight lines through physics; the slingshot aims where the camera looks
      gameplay.attachPhysics(physics);
      gameplay.aim = (out) => this.camera.camera.getWorldDirection(out);
      gameplay.eye = (out) => this.camera.camera.getWorldPosition(out);
      character.gatheringAbility.pests = gameplay.pests;
      // Spider webs: the axe cuts them, their pull holds the player back
      character.gatheringAbility.webs = props.webs;
      character.restraint = (vel) => props.webs.restrain(vel);
      // Threads stick to the arms, legs, head and body (posed only when a web is touching the player)
      props.webs.setBody({
        parts: () => character.model.bodyParts(),
        pose: () => character.model.group.updateMatrixWorld(true),
      });
      // Frameless webs anchor to the cave walls only once those colliders exist (after a load they build over a few frames)
      props.webs.collidersReady = () => !!exploration?.caveNetwork.collidersReady;
      // Sleeping skips eight hours: crops grow and the weather chain moves on; the morning is autosaved
      gameplay.onTimeSkip = (seconds) => {
        weather.director.update(seconds);
        farmingManager.fastForward(seconds);
        gameplay.workers?.fastForward(seconds);
        orchard.fastForward(seconds);
        nursery.fastForward(seconds);
      };
      gameplay.onWake = () => this.world?.saves.save(AUTOSAVE_SLOT);
      // Stations, the NPC, finds and a faced pet take E from the shovel
      character.farmingAbility.activityProbe = (pos) => gameplay.hasActivityForShovel(pos);
      gameplay.flowers = flowerBeds;

      // Villager companion: paths come from a physics-sampled grid that resets when anything is built
      // Props changing one at a time (a felled tree, a placed lamp) only forget the cells around them
      const nav = new GridNavigator(physics, () => (buildingManager.revision * 100003 + props.solidRevision) * 7919 + terrain.revision, {
        cell: 0.5,
        radius: 0.28,
        height: 1.5, // the character capsule is 1.5 m tall
        maxStepUp: 0.45,
        maxDrop: 1.2,
        minFloorY: () => worldSettings.waterLevel - 0.25,
        doors: () => buildingManager.getDoorOpenings(),
        stairs: () => buildingManager.getStairs(),
        edits: () => props.drainNavEdits(),
      });
      buildingManager.onDoorToggled = (piece) => nav.doorToggled(piece.position);
      const npcSpawn = new THREE.Vector3(-4, 0, 7);
      npcSpawn.y = terrain.getHeight(npcSpawn.x, npcSpawn.z);
      const doorControl = {
        isOpen: (id: string) => !!buildingManager.getPiece(id)?.isOpen,
        toggle: (id: string, from: THREE.Vector3) => buildingManager.toggleDoor(id, from),
      };
      gameplay.companion = new CompanionNPC(physics, scene, nav, npcSpawn, t('npc.name'), doorControl);
      // Farm storage: every storage chest opens onto one shared stock (chest spots cached per prop revision)
      let chestRev = -1;
      let chestAt = -Infinity;
      let chestSpots: THREE.Vector3[] = [];
      const storage = new FarmStorage(() => {
        // Props change often (felled trees, webs): look again at most every 2 s
        const now = performance.now();
        if (props.revision !== chestRev && now - chestAt > 2000) {
          chestRev = props.revision;
          chestAt = now;
          chestSpots = props.list().filter((p) => p.type === STORAGE_CHEST).map((p) => p.position.clone());
        }
        return chestSpots;
      });
      gameplay.storage = storage;
      // Farmhands with energy, hunger and a daily routine; in work hours they take jobs from the
      // fields, the forest and the quarry, with seeds and meals from the storage chests
      const taskBoard = new TaskBoard(
        farmingManager,
        {
          count: (id) => storage.count(id),
          take: (id, n) => storage.take(id, n),
          put: (items) => {
            if (!storage.hasChest) {
              giveResources(items);
              return;
            }
            // A full stack spills into the backpack rather than vanishing
            const spill = items.map(({ itemId, amount }) => ({ itemId, amount: amount - storage.put(itemId, amount) })).filter((i) => i.amount > 0);
            if (spill.length) giveResources(spill);
          },
          get hasChest() {
            return storage.hasChest;
          },
        },
        () => farmingManager.rainIntensity > 0.35,
        () => workers.workCenter
      );
      taskBoard.trees = propTrees;
      taskBoard.rocks = rocks;
      taskBoard.orchard = orchard;
      const workers = new WorkerManager(physics, scene, nav, doorControl, () => buildingManager.getAllPieces(), (x, z) => terrain.getHeight(x, z), taskBoard, new THREE.Vector3(npcSpawn.x + 6, npcSpawn.y, npcSpawn.z + 5));
      workers.findChest = (from) => storage.nearestChest(from);
      workers.onNotify = (text) => callbacks.onNotify(text, 'warning');
      for (let i = 0; i < 3; i++) workers.spawn(new THREE.Vector3(npcSpawn.x + 2 + i * 1.6, 0, npcSpawn.z + 2.5));
      gameplay.workers = workers;
      exploration = new ExplorationManager(scene, physics, terrain, props, rocks, inventoryManager, gameplay, weather, nightLighting, particleManager);
      exploration.onNotify = (text, type) => callbacks.onNotify(text, type);
      exploration.onItems = (items) => callbacks.onResourcesGathered(items);
      const explorer = exploration;
      gameplay.explore = {
        get prompt() {
          return explorer.prompt;
        },
        get fading() {
          return explorer.fading;
        },
        get inCave() {
          return explorer.inCave;
        },
        interact: () => explorer.interact(character, this.camera),
      };
      // Wooden jetty at the lighthouse with the motorboat moored alongside
      const lighthouse = exploration.sites.find((s) => s.kind === 'lighthouse')!;
      const pier = buildLighthousePier(lighthouse, terrain, scene, physics);
      const boat = new BoatController(physics, scene, terrain, pier.boatSpawn, pier.boatYaw);
      boat.dock.copy(pier.end).lerp(pier.start, 0.25);
      const wildlife = new WildlifeSystem(scene, terrain, props, weather);
      const shadows = new StaticShadows(terrain, props, forest, rocks, propTrees, buildingManager);
      shadows.orchard = orchard;
      const grass = new GrassField(scene, terrain);
      shadows.grass = grass;
      // Storm bolts that land near the player: a warning, then the strike, flash and thunder
      const lightning = new LightningStrikes(scene, (x, z) => terrain.getHeight(x, z));
      lightning.onStrike = (pos) => {
        weather.flashNow(1);
        this.ambient.thunder(this.listenerPos, Math.max(weather.sound.thunder, 0.6), pos);
      };
      weather.onGroundStrike = () => {
        const wd = this.world;
        if (!wd || lightning.busy || wd.exploration.inCave || weather.underwater > 0.5) return false;
        const p = wd.character.getPosition();
        if (weather.isSheltered(p)) return false;
        for (let tries = 0; tries < 6; tries++) {
          const a = Math.random() * Math.PI * 2;
          const d = 7 + Math.random() * 19;
          const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
          if (!terrain.isInside(x, z)) continue;
          const y = Math.max(terrain.getHeight(x, z), riverWorld.waterLevelAt(x, z));
          if (weather.isSheltered(new THREE.Vector3(x, y, z))) continue;
          lightning.schedule(x, y, z);
          return true;
        }
        return false;
      };
      const editor = new EditorController(scene, this.camera.camera, this.renderer.domElement, this.input, terrain, props, rivers, exploration.caveNetwork, physics);
      editor.pests = gameplay.pests;
      editor.onNotify = (text, type) => callbacks.onNotify(text, type);
      const debugRenderer = new DebugRenderer(physics, scene);

      this.world = {
        physics,
        character,
        debugRenderer,
        terrain,
        water,
        rivers,
        weather,
        props,
        nightLighting,
        inventoryManager,
        farmingManager,
        forest,
        propTrees,
        orchard,
        nursery,
        bushSway,
        flowerSway,
        fallingLeaves,
        rocks,
        particleManager,
        vehicle,
        moped,
        boat,
        wildlife,
        shadows,
        grass,
        lightning,
        exploration,
        gameplay,
        editor,
        saves: null as unknown as SaveSystem,
      };
      this.world.saves = new SaveSystem(this.world);

      // Resume the last session, or dress a fresh world
      if (!this.world.saves.load(AUTOSAVE_SLOT)) {
        props.populateDefault();
        exploration.clearSiteProps();
        gameplay.pets.spawnDefaults(SPAWN_POSITION);
      } else {
        callbacks.onLog('info', 'Відновлено останнє автозбереження.');
      }
      if (!gameplay.pets.pets.length) gameplay.pets.spawnDefaults(SPAWN_POSITION);
      // Hedgehogs and baby dragons in the wilds, sharks in the sea, spiders in the caves (not saved:
      // each session gets fresh ones; the cave spiders come once the network has built)
      gameplay.pests.populate(character.getPosition());

      window.addEventListener('keydown', this.handleKeyDown);
      window.addEventListener('keyup', this.handleKeyUp);
      window.addEventListener('pagehide', this.handlePageHide);
      if (DEV_TOOLS_ENABLED) (window as unknown as { dev: unknown }).dev = this.createDevApi();

      // Compile every shader now, behind the loading screen, instead of on first sight in play
      await this.prewarmShaders();
      if (this.isDisposed) return;

      this.clock.start();
      this.lastFpsUpdate = performance.now();
      this.animate();
      callbacks.onReady();
    } catch (err: any) {
      console.error('Failed to initialize 3D scene / Rapier physics:', err);
      this.callbacks.onError(err?.message || 'Error loading physics engine');
    }
  }

  /**
   * Compiles the shader programs of everything in the scene, hidden objects included (boat prompt,
   * wildlife pools, night-only lights' materials), through KHR_parallel_shader_compile where the
   * browser has it, so the driver builds them in parallel without blocking the page. Without the
   * extension it still moves the cost to load time. Capped at a few seconds so a slow driver can't
   * hold the loading screen forever; anything left simply compiles on first use as before.
   */
  public shaderPrewarmMs = 0;
  public shaderPrewarmPrograms = 0;
  private async prewarmShaders(): Promise<void> {
    const t0 = performance.now();
    try {
      // The player / NPC model and the wheat load asynchronously: wait for them (capped) so their
      // shaders are compiled here too instead of hitching the first frames of play
      const assets = Promise.allSettled([CharacterModel.preload(), loadWheatModel(), loadCropModels(), loadTreeModels(), loadAppleModels()]);
      await Promise.race([assets, new Promise((r) => setTimeout(r, 6000))]);
      // Let the models' own load callbacks attach their meshes to the scene first
      await new Promise((r) => setTimeout(r, 0));
      this.world?.terrain.updateLod(this.camera.camera.position);
      const timeout = new Promise<void>((r) => setTimeout(r, 4000));
      await Promise.race([this.renderer.compileAsync(this.scene, this.camera.camera).then(() => undefined), timeout]);
    } catch (err) {
      console.warn('Shader prewarm failed', err);
    }
    this.shaderPrewarmMs = performance.now() - t0;
    this.shaderPrewarmPrograms = this.renderer.info.programs?.length ?? 0;
  }

  // Loop state
  private readonly clock = new THREE.Clock(false);
  private frameCount = 0;
  private lastFpsUpdate = 0;
  private autosaveTimer = 60;
  private hudTimer = 0;
  private lastHudKey = '';
  private lastHudState: unknown = null;
  private lastBuildingTelemetry: BuildingTelemetry | null = null;
  private lastEditorRevision = -1;
  private frameMsAccum = 0;
  private lastStepMs = 0;
  /** Building revision the terrain's roof-shelter mask was last built from. */
  private shelterRevision = -1;

  /** Frame cap (0 = every vsync). On 120 / 144 Hz screens this halves the work for the same look. */
  public maxFps = 60;
  /** Ideal time of the last simulated frame (ms, requestAnimationFrame clock). */
  private lastFrameAt = -1e9;

  private animate = (now: number = performance.now()): void => {
    if (this.isDisposed || !this.world) return;
    this.animationFrameId = requestAnimationFrame(this.animate);
    if (this.paused) {
      this.clock.getDelta();
      if (this.pausedRedraw) {
        this.pausedRedraw = false;
        this.renderer.render(this.scene, this.camera.camera);
      }
      return;
    }
    if (this.maxFps > 0) {
      // Skip vsyncs that come too early; the ideal schedule advances by exactly one interval, so on
      // 144 Hz the frames alternate between 2 and 3 vsyncs and still average the target rate
      const interval = 1000 / this.maxFps;
      if (now - this.lastFrameAt < interval - 2) return;
      this.lastFrameAt = Math.max(this.lastFrameAt + interval, now - interval);
    }
    const frameStart = performance.now();
    hitchLog.begin(now);
    hitchLog.mark(0);

    const w = this.world;
    const { character, farmingManager, forest, rocks, particleManager, debugRenderer, vehicle, moped, terrain, editor } = w;
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
      moped.notifyMouseLook();
      w.boat.notifyMouseLook();
    }
    const mouseScroll = inputManager.consumeMouseScroll();
    if (mouseScroll !== 0 && !editing) tpCamera.handleZoom(mouseScroll);

    // Vehicle forces are applied before the physics step; one interact press enters one vehicle
    const truckDriving = !editing && vehicle.update(dt, inputManager, tpCamera, character);
    const mopedDriving = !editing && !truckDriving && moped.update(dt, inputManager, tpCamera, character, !vehicle.isPlayerNear);
    const boatDriving =
      !editing && !truckDriving && !mopedDriving && w.boat.update(dt, inputManager, tpCamera, character, !vehicle.isPlayerNear && !moped.isPlayerNear);
    const isDriving = truckDriving || mopedDriving || boatDriving;
    const ride = truckDriving ? vehicle : mopedDriving ? moped : boatDriving ? w.boat : null;

    hitchLog.mark(1);
    const pStart = performance.now();
    if (dt > 0) physics.step(dt);
    const stepTime = performance.now() - pStart;
    this.lastStepMs = stepTime;
    hitchLog.mark(2);
    vehicle.syncVisuals(dt);
    moped.syncVisuals(dt);
    w.boat.night = w.weather.nightFactor;
    w.boat.syncVisuals(dt);

    // Asleep in bed: the player stays put until morning
    if (!editing && !isDriving && !w.gameplay.sleeping) character.update(dt, inputManager, tpCamera);
    // Splash drops, the swimmer's rising air bubbles and the caustics' clock
    character.swimAbility?.waterParticles?.update(dt);
    const camPos = this.camera.camera.position;
    character.swimAbility?.waterEffects?.update(dt, camPos.y < riverWorld.waterLevelAt3(camPos.x, camPos.y, camPos.z));
    const buildings = character.buildAbility?.buildingManager;
    buildings?.flushPendingRegeneration();
    // Ground under roofs (greenhouses) stays dry: refresh the terrain mask when buildings change
    if (buildings && buildings.revision !== this.shelterRevision) {
      this.shelterRevision = buildings.revision;
      w.terrain.setShelter(buildings.getShelterRects());
    }
    if (character.buildAbility) {
      inputManager.setBuildMode(character.buildAbility.isBuildModeActive);
      inputManager.setPaintMode(character.buildAbility.isPaintingModeActive);
    }

    hitchLog.mark(3);
    // World systems
    terrain.update(rawDt);
    w.props.update();
    w.props.updateVisibility(this.camera.camera.position);
    const rainOnWater = w.exploration.inCave ? 0 : w.weather.rainIntensity * (1 - w.weather.snowAmount);
    w.water.update(dt, this.camera.camera.position);
    // Ripple wave simulation around the player (developer toggle; asleep when nothing stirs)
    waterRippleSim.update(this.renderer, dt, rainOnWater, editing ? this.camera.camera.position : ride ? ride.getPosition() : character.getPosition());
    w.rivers.update(dt, w.weather.nightFactor);
    updateCloudShadows(dt, w.weather.sunDir, w.weather.cloudCover, w.weather.nightFactor);
    // What the HUD prompt is about glows: the tulip clump E picks, the ripe field E harvests
    this.updatePickGlowTargets(dt, editing);
    if (editing) {
      editor.update(rawDt);
    } else {
      tpCamera.isHoldingObject = character.telemetry.isHoldingObject;
      tpCamera.isBuilding = character.telemetry.isBuildModeActive || isPaintingMode;
      const cameraTargetPos = ride ? ride.getPosition() : character.getPosition();
      tpCamera.update(dt, cameraTargetPos, physics, ride ? ride.collider : character.collider);
    }
    w.weather.update(dt, tpCamera.camera.position);
    this.lightShafts?.update(dt, this.camera.camera, {
      sunDir: w.weather.sunDir,
      sunColor: w.weather.sun.color,
      underwater: w.weather.underwater,
      night: w.weather.nightFactor,
      cover: w.weather.cloudCover,
      cave: Math.max(w.weather.caveFactor, w.exploration.inCave ? 1 : 0),
    });
    w.nightLighting.setViewportHeight(this.renderer.domElement.height);
    w.lightning.update(dt, tpCamera.camera, this.renderer.domElement.height);
    w.nightLighting.update(dt, tpCamera.camera, editing ? null : ride ? ride.getPosition() : character.getPosition());
    farmingManager.rainIntensity = w.weather.rainIntensity;
    farmingManager.meltWet = w.weather.melting && !w.exploration.inCave;
    this.updateAudio(dt, editing ? tpCamera.camera.position : ride ? ride.getPosition() : character.getPosition(), ride);

    hitchLog.mark(4);
    // Bodies that part the field wheat (springs run only for stalks they touch)
    const fields = farmingManager.fields;
    const bushes = w.bushSway;
    const flowers = w.flowerSway;
    fields.clearPushers();
    // The rustle is gathered around the player (or the ride), where the listener cares about it
    const earPos = ride ? ride.getPosition() : character.getPosition();
    fields.setRustleEar(earPos.x, earPos.z, !editing);
    bushes.clearPushers();
    flowers.clearPushers();
    const grassField = w.grass;
    grassField.clearPushers();
    const algae = w.props.algae;
    algae.clearPushers();
    if (!editing) {
      if (character.body) {
        const cp = character.body.translation();
        fields.addPusher(cp.x, cp.y - 0.9, cp.z, 0.8);
        bushes.addPusher(cp.x, cp.y - 0.9, cp.z, 0.4);
        flowers.addPusher(cp.x, cp.y - 0.9, cp.z, 0.35);
        if (!isDriving) grassField.addPusher(cp.x, cp.y - 0.9, cp.z, 0.55);
        algae.addPusher(cp.x, cp.y - 0.9, cp.z, 0.35, 1.8);
      }
      // Sharks swimming through the algae part it (two nearest the camera: 3 capsules each)
      for (const shark of w.gameplay.pests.sharksNear(this.camera.camera.position, 45, 2, this.sharkTmp)) {
        shark.bodyCapsules((x, y, z, r, h) => algae.addPusher(x, y, z, r, h));
      }
      moped.getPosition(this.pushTmp);
      fields.addPusher(this.pushTmp.x, this.pushTmp.y, this.pushTmp.z, 1.0);
      bushes.addPusher(this.pushTmp.x, this.pushTmp.y, this.pushTmp.z, 0.7);
      flowers.addPusher(this.pushTmp.x, this.pushTmp.y, this.pushTmp.z, 0.7);
      grassField.addPusher(this.pushTmp.x, this.pushTmp.y, this.pushTmp.z, 0.8);
      // Farmhands walking through the wheat (only near the camera, where it shows)
      const crew = w.gameplay.workers?.workers;
      if (crew) {
        const cam = this.camera.camera.position;
        for (let i = 0; i < crew.length; i++) {
          const wp = crew[i].model.group.position;
          if (crew[i].asleep || Math.abs(wp.x - cam.x) + Math.abs(wp.z - cam.z) > 50) continue;
          const fy = wp.y - 0.9;
          fields.addPusher(wp.x, fy, wp.z, 0.7);
          grassField.addPusher(wp.x, fy, wp.z, 0.5);
        }
      }
      const pets = w.gameplay.pets.pets;
      for (let i = 0; i < pets.length; i++) {
        const pp = pets[i].group.position;
        fields.addPusher(pp.x, pp.y, pp.z, 0.55);
        bushes.addPusher(pp.x, pp.y, pp.z, 0.35);
        flowers.addPusher(pp.x, pp.y, pp.z, 0.3);
        grassField.addPusher(pp.x, pp.y, pp.z, 0.4);
      }
    } else {
      // Editor: the fly camera parts the algae, so the springs can be tried while placing them
      const cam = this.camera.camera.position;
      algae.addPusher(cam.x, cam.y - 0.4, cam.z, 0.4, 0.8);
    }
    // Sunlight on the algae: full by day, none at night or in caves, dimmed by rain
    setAlgaeDaylight(w.exploration.inCave ? 0 : (1 - w.weather.nightFactor) * (1 - w.weather.rainIntensity * 0.6));
    algae.update(dt, this.camera.camera.position);
    // Spider webs: the player on foot sticks to them (not while editing, driving or asleep)
    const webs = w.props.webs;
    webs.setPlayer(!editing && !isDriving && !w.gameplay.sleeping && character.body ? character.body.translation() : null);
    webs.setViewportHeight(this.renderer.domElement.height);
    setWebLight(w.exploration.inCave ? 0.35 : 1 - w.weather.nightFactor * 0.8);
    // Matcap glass is unlit: dim it with the daylight (night, overcast) so it never glows in the dark
    setGlassLight(
      w.exploration.inCave
        ? 0.25
        : (1 - w.weather.nightFactor * 0.82) * (1 - w.weather.cloudCover * 0.25) * (1 - w.weather.rainIntensity * 0.15)
    );
    webs.update(dt, this.camera.camera);
    bushes.update(dt);
    flowers.update(dt);
    w.fallingLeaves.update(dt);
    const grass = w.grass;
    grass.enabled = !w.exploration.inCave;
    w.propTrees.ambientLeaves = !w.exploration.inCave && !editing;
    const wt = w.weather.weather;
    w.propTrees.gustsAllowed = wt !== 'rain' && wt !== 'storm' && wt !== 'snow' && wt !== 'blizzard' && w.weather.rainIntensity < 0.05;
    setFoliageWeatherWind(w.exploration.inCave ? 0 : w.weather.sound.wind);
    w.terrain.setSnowCover(w.weather.snowCover);
    grass.snowCover = w.weather.snowCover;
    // Footprints fill in within a minute or two of heavy snowfall, and barely at all once it stops
    grass.printFill = w.weather.snowAmount > 0.05 ? 50 / w.weather.snowAmount : 1500;
    setSnowCover(w.exploration.inCave ? 0 : w.weather.snowCover);
    {
      // Low mist over the ground while it snows (and a faint one over a white landscape)
      const pp = character.getPosition();
      const mist = w.exploration.inCave ? 0 : Math.max(w.weather.snowAmount, w.weather.snowCover * 0.25);
      this.mistColor.copy(this.scene.fog!.color).lerp(WHITE_MIST, 0.35);
      setGroundMist(mist, w.terrain.getHeight(pp.x, pp.z) + 1.2, this.mistColor);
    }
    grass.update(dt, tpCamera.camera, w.weather.sound.wind, editing ? this.camera.camera.position : ride ? ride.getPosition() : character.getPosition());
    hitchLog.mark(5);
    farmingManager.update(dt);
    farmingManager.fields.updateVisibility(this.camera.camera.position);
    hitchLog.mark(6);
    forest.update(dt);
    w.propTrees.update(dt);
    w.orchard.update(dt, character.getPosition(), tpCamera.camera.position);
    w.nursery.update(dt, character.getPosition());
    rocks.update(dt, tpCamera.camera.position);
    w.exploration.update(dt, ride ? ride.getPosition() : character.getPosition(), !editing && !isDriving);
    w.wildlife.update(dt, editing ? tpCamera.camera.position : ride ? ride.getPosition() : character.getPosition(), tpCamera.camera, !!w.exploration.inCave);
    w.shadows.update(dt, editing ? tpCamera.camera.position : ride ? ride.getPosition() : character.getPosition());
    if (!editing) w.gameplay.update(dt, inputManager, isDriving, this.consumeKeyG());

    // Push prompts to React only when they actually change (each push re-renders the HUD tree)
    if (this.frameCount % 4 === 0 && character.farmingAbility) {
      const farm = character.farmingAbility.currentPrompt;
      const gather = character.gatheringAbility.currentPrompt;
      // Compared by what the HUD shows: the raw prompt also carries growthProgress and the plot id,
      // which change every frame on a growing crop / every bed while running across a field, and each
      // push is a React commit
      const farmKey = farm
        ? `${farm.actionText}|${farm.canPlant}${farm.canWater}${farm.canHarvest}${!!farm.canDig}|${farm.shovel ?? ''}|${Math.round((farm.holdProgress ?? 0) * 40)}`
        : '';
      if (farmKey !== this.lastFarmPrompt) {
        this.lastFarmPrompt = farmKey;
        callbacks.onFarmingPrompt(farm ? { ...farm } : null);
      }
      // Changes only through GameplayManager.setPrompt (a new object each time)
      if (w.gameplay.prompt !== this.lastPlayPrompt) {
        this.lastPlayPrompt = w.gameplay.prompt;
        callbacks.onGameplayPrompt(this.lastPlayPrompt);
      }
      if (!deepEqual(gather, this.lastGatherPrompt)) {
        const copy = gather ? { ...gather } : null;
        this.lastGatherPrompt = copy;
        callbacks.onGatherPrompt(copy);
      }
    }

    particleManager.update(dt);
    debugRenderer.update(character);

    w.terrain.updateLod(tpCamera.camera.position);
    hitchLog.mark(7);
    this.renderer.render(this.scene, tpCamera.camera);
    hitchLog.mark(8);

    // Throttled UI pushes
    this.hudTimer -= rawDt;
    const hudKey = w.gameplay.hudKey;
    // The reel minigame marker moves continuously: stream it while active
    if (w.gameplay.fishing.state.phase === 'reel' && this.frameCount % 2 === 0) callbacks.onGameplayHud(w.gameplay.getHudState());
    if (this.hudTimer <= 0 || hudKey !== this.lastHudKey) {
      // Each push re-renders the whole React tree (hundreds of KB of garbage on a phone): the
      // periodic refresh (buff / cooking timers, pet affection) only goes out when something changed
      const state = w.gameplay.getHudState();
      if (hudKey !== this.lastHudKey || !deepEqual(state, this.lastHudState)) {
        this.lastHudState = state;
        callbacks.onGameplayHud(state);
      }
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
      this.scheduleAutosave();
    }

    this.frameMsAccum += performance.now() - frameStart;
    this.updateDiagnostics(stepTime);
    hitchLog.mark(9);
  };

  /**
   * The periodic autosave (capture + JSON + localStorage, several ms) runs in the browser's idle time
   * after a frame instead of inside one, so it doesn't add a hitch on top of the frame's own work.
   * Leaving the page still saves synchronously (pagehide).
   */
  private autosavePending = false;
  private scheduleAutosave(): void {
    if (this.autosavePending) return;
    this.autosavePending = true;
    // The HUD badge ("Saving game") listens for this event
    window.dispatchEvent(new Event('autosave-start'));
    const run = () => {
      this.autosavePending = false;
      if (!this.isDisposed && this.world && this.mode === 'play') this.world.saves.save(AUTOSAVE_SLOT);
      window.dispatchEvent(new Event('autosave-end'));
    };
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 5000 });
    else window.setTimeout(run, 0);
  }

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
      // Only the editor shows these: in play mode they'd re-render the whole UI 3x a second
      if (DEV_TOOLS_ENABLED && this.mode === 'editor') {
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

      if (character.buildAbility) this.pushBuildingTelemetry(character.buildAbility.getTelemetry());
    } else if (character.buildAbility && (character.buildAbility.isBuildModeActive || character.buildAbility.isPaintingModeActive)) {
      if (this.frameCount % 4 === 0) this.pushBuildingTelemetry(character.buildAbility.getTelemetry());
    }
  }

  /** Sends building telemetry to React only when a field changed (each push re-renders the UI). */
  private pushBuildingTelemetry(next: BuildingTelemetry): void {
    const prev = this.lastBuildingTelemetry;
    if (prev) {
      let same = true;
      for (const k in next) {
        if (next[k as keyof BuildingTelemetry] !== prev[k as keyof BuildingTelemetry]) {
          same = false;
          break;
        }
      }
      if (same && Object.keys(prev).length === Object.keys(next).length) return;
    }
    this.lastBuildingTelemetry = next;
    this.callbacks.onBuildingTelemetry({ ...next });
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

    // Every change reallocates the canvas (a visible hitch), so it needs a sustained reason:
    // two slow windows in a row to drop, five fast ones to rise, and after a rise that had to be
    // undone the higher level stays blocked for a minute instead of flip-flopping.
    const now = performance.now();
    const pr = this.renderer.getPixelRatio();
    let next = pr;
    this.perfSlowWindows = avgFps < 45 ? this.perfSlowWindows + 1 : 0;
    this.perfFastWindows = avgFps > 58 ? this.perfFastWindows + 1 : 0;
    if (this.perfSlowWindows >= 2) {
      next = Math.max(this.minPixelRatio, pr - 0.15);
      if (now - this.lastPixelRatioRaise < 15000) this.pixelRatioCeilingUntil = now + 60000;
      this.pixelRatioCeiling = Math.min(this.pixelRatioCeiling, pr);
      this.perfSlowWindows = this.perfFastWindows = 0;
    } else if (this.perfFastWindows >= 5) {
      if (now > this.pixelRatioCeilingUntil) this.pixelRatioCeiling = this.maxPixelRatio;
      const ceiling = now > this.pixelRatioCeilingUntil ? this.maxPixelRatio : this.pixelRatioCeiling - 0.01;
      next = Math.min(ceiling, pr + 0.1);
      if (next < pr) next = pr;
      this.perfFastWindows = 0;
      if (next > pr + 0.01) this.lastPixelRatioRaise = now;
    }
    if (Math.abs(next - pr) > 0.01) {
      this.renderer.setPixelRatio(next);
      // Browser console only: the in-game log is App state, a push would re-render the whole UI on
      // top of the canvas reallocation
      console.info(`Render resolution: ${Math.round(next * 100)}% (FPS ${Math.round(avgFps)})`);
    }
  }

  /** Listener at the camera; ambience (rain, wind, campfire, engine) around the player. */
  private updateAudio(dt: number, playerPos: THREE.Vector3, ride: VehicleController | MopedController | BoatController | null): void {
    const w = this.world;
    if (!w) return;
    const camera = this.camera.camera;
    audioEngine.updateListener(camera);
    const cp = camera.position;
    const underwater = cp.y < riverWorld.waterLevelAt3(cp.x, cp.y, cp.z) || !!w.character.oxygenAbility?.isUnderwater;
    audioEngine.setUnderwater(underwater);
    this.listenerPos.copy(camera.position);
    if (!audioEngine.context) return;
    caveAudio.update(dt, !!w.exploration.inCave, this.listenerPos);
    // Soundtrack: time of day and weather pick the track; enemies after the player start the danger loop
    const ms = this.musicState;
    ms.timeOfDay = worldSettings.timeOfDay;
    ms.night = w.weather.nightFactor;
    ms.weather = w.weather.weather;
    ms.rain = w.weather.rainIntensity * (1 - w.weather.snowAmount);
    ms.inCave = !!w.exploration.inCave;
    ms.underwater = underwater;
    ms.sleeping = w.gameplay.sleeping;
    ms.threat = w.gameplay.pests.threatLevel(playerPos);
    music.update(dt, ms);

    // Swimming: entry splash, strokes, lapping, bubbles and the underwater bed
    const tel = w.character.telemetry;
    const swimming = tel.isSwimming;
    // Body sounds (steps, strokes) come from the player, a little below the centre
    this.footsteps.setPosition(playerPos.x, playerPos.y - 0.4, playerPos.z);
    if (swimming && !this.prevSwimming && this.prevVelY < -2.5) this.footsteps.splash(-this.prevVelY);
    this.prevSwimming = swimming;
    this.prevVelY = tel.velocity.y;
    this.footsteps.updateSwim(dt, swimming, swimming && !!w.character.oxygenAbility?.isUnderwater, tel.speed);

    // Wheat parting around the player: driven by how fast the nearby stalks actually move (last frame's springs)
    const fields = w.farmingManager.fields;
    const rustle = fields.rustle;
    this.wheatRustle.setPosition(playerPos.x, playerPos.y - 0.5, playerPos.z);
    this.wheatRustle.update(dt, rustle.energy, rustle.hits, rustle.dry, Math.max(w.weather.rainIntensity, fields.rainWet ? 0.6 : 0));

    this.campfireTimer -= dt;
    if (this.campfireTimer <= 0) {
      this.campfireTimer = 0.5;
      const fire = w.props.findNearest('campfire', playerPos, 30);
      this.nearestCampfire = fire ? fire.position.clone().setY(fire.position.y + 0.4) : null;
    }
    // Distance to the nearest dry land: ring-sample the terrain twice a second
    this.landTimer -= dt;
    if (this.landTimer <= 0) {
      this.landTimer = 0.5;
      let nearest = Infinity;
      outer: for (const r of [0, 20, 45, 80, 120, 170]) {
        for (let k = 0; k < (r === 0 ? 1 : 12); k++) {
          const a = (k / 12) * Math.PI * 2;
          const hx = playerPos.x + Math.cos(a) * r, hz = playerPos.z + Math.sin(a) * r;
          if (w.terrain.getHeight(hx, hz) > worldSettings.waterLevel + 0.4) { nearest = r; break outer; }
        }
      }
      this.landNear = 1 - Math.min(Math.max((nearest - 40) / 100, 0), 1);
    }
    // Birds sit in the trees around the player: sample up to 40 tree tops within earshot
    this.perchTimer -= dt;
    if (this.perchTimer <= 0) {
      this.perchTimer = 1;
      const R = 65;
      const perches = this.birdPerches;
      let seen = 0;
      const visit = (p: PropInstance) => {
        const dx = p.position.x - playerPos.x, dz = p.position.z - playerPos.z;
        if (dx * dx + dz * dz > R * R) return;
        seen++;
        // Reservoir sampling: an even spread over the whole forest, not the first cells visited
        const slot = seen <= 40 ? seen - 1 : Math.floor(Math.random() * seen);
        if (slot >= 40) return;
        const v = perches[slot] ?? (perches[slot] = new THREE.Vector3());
        v.set(p.position.x, p.position.y + (2.8 + Math.random() * 1.8) * p.scale, p.position.z);
      };
      w.props.forEachNear(playerPos.x, playerPos.z, R, visit, 'tree_pine');
      w.props.forEachNear(playerPos.x, playerPos.z, R, visit, 'tree_round');
      perches.length = Math.min(seen, 40);
      this.forestNear = Math.min(seen / 30, 1);
    }
    const weather = w.weather;
    const snd = weather.sound;
    // Underground the outside is still heard, through the nearest mouth (AmbientAudio muffles it)
    const portal = w.exploration.inCave ? this.cavePortal(w.exploration.caveNetwork.entrances, this.listenerPos) : null;
    const outdoors = !w.exploration.inCave || portal ? 1 : 0;
    // Rivers: the nearest point on a centre line, looked up 10x a second through a spatial hash,
    // and the panner glides after it every frame (no hops between sample points). Waterfalls are
    // fixed sources, only the two loudest within earshot play.
    this.waterTimer -= dt;
    if (this.waterTimer <= 0) {
      this.waterTimer = 0.1;
      const inCave = w.exploration.inCave;
      const prev = this.riverLoud;
      this.riverLoud = inCave ? 0 : w.rivers.riverSound(playerPos, this.riverTarget);
      // A different river far from the last point: jump there instead of sweeping across land
      if (this.riverLoud > 0 && (prev === 0 || this.riverTarget.distanceToSquared(this.riverSoundPos) > 30 * 30)) {
        this.riverSoundPos.copy(this.riverTarget);
      }
      if (inCave) this.fallSounds.length = 0;
      else w.rivers.fallsNear(playerPos, 2, this.fallSounds);
    }
    if (this.riverLoud > 0) {
      this.riverSoundPos.lerp(this.riverTarget, 1 - Math.exp(-dt * 6));
      this.riverSound = { position: this.riverSoundPos, loud: this.riverLoud };
    } else {
      this.riverSound = null;
    }
    const underRoof = !outdoors || (!portal && weather.isSheltered(playerPos));
    // One state object reused every frame (no per-frame garbage)
    const cs = (this.coastState ??= {
      listener: this.listenerPos,
      height: (x, z) => w.terrain.getHeight(x, z),
      terrainRevision: 0, waterLevel: 0, inCave: false, night: 0, rain: 0, wind: 0, underRoof: false,
    });
    cs.terrainRevision = w.terrain.revision;
    cs.waterLevel = worldSettings.waterLevel;
    cs.inCave = !!w.exploration.inCave;
    cs.night = weather.nightFactor;
    cs.rain = weather.rainIntensity * (1 - weather.snowAmount);
    cs.wind = snd.wind;
    cs.underRoof = underRoof;
    this.coast.update(cs, dt);
    this.ambient.update({
      listener: this.listenerPos,
      river: this.riverSound,
      falls: this.fallSounds,
      // Every level below is scaled by the weather's sound profile (developer panel → weather)
      rain: weather.rainIntensity * (1 - weather.snowAmount) * outdoors * snd.rain,
      wind: snd.wind * outdoors,
      birds: snd.birds * (1 - weather.nightFactor) * outdoors * (portal ? 0.8 : 0.35 + 0.65 * this.forestNear),
      birdRate: snd.birdRate,
      birdPerches: portal ? this.portalPerches : outdoors ? this.birdPerches : [],
      breeze: snd.breeze * outdoors * (1 - weather.nightFactor * 0.4),
      fog: snd.fog * outdoors,
      // Falling snow and a white blanket swallow the highs: the outside goes hushed and dull
      // (a blizzard howls instead: the hush mostly gives way to the wind)
      snow: Math.max(weather.snowAmount, weather.snowCover * 0.6) * outdoors * (1 - weather.blizzardMix * 0.75),
      night: snd.insects * weather.nightFactor * outdoors * (portal ? 1 : this.landNear),
      underRoof,
      portal,
      campfire: this.nearestCampfire,
      engine: ride
        ? { position: ride.getPosition(), speedKmh: ride.speedKmh, kind: ride === w.moped ? 'scooter' : ride === w.boat ? 'boat' : 'truck' }
        : null,
    });
  }

  /**
   * The way-out end of the cave mouth nearest the listener (flooded mouths lead under the sea and
   * let nothing through), and a few perches just outside it where the birds are heard singing.
   */
  private cavePortal(entrances: readonly { id: string; mouth: THREE.Vector3; yaw: number; underwater: boolean }[], listener: THREE.Vector3): THREE.Vector3 | null {
    let best: (typeof entrances)[number] | null = null;
    let bestD = Infinity;
    for (const e of entrances) {
      if (e.underwater) continue;
      const d = e.mouth.distanceToSquared(listener);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (!best) return null;
    if (this.portalId !== best.id) {
      this.portalId = best.id;
      // Outside the mouth: back along the way in, spread a little sideways and up into the trees
      const ix = Math.sin(best.yaw), iz = Math.cos(best.yaw);
      this.portalPerches.length = 0;
      for (let i = 0; i < 10; i++) {
        const back = 5 + Math.random() * 10, side = (Math.random() - 0.5) * 12;
        this.portalPerches.push(new THREE.Vector3(best.mouth.x - ix * back - iz * side, best.mouth.y + 2.5 + Math.random() * 4, best.mouth.z - iz * back + ix * side));
      }
    }
    // The daylight end of the tunnel, about head high
    return this.portalPoint.set(best.mouth.x, best.mouth.y + 1.5, best.mouth.z);
  }

  /** What the foot landed on: building floor paint, structure/prop tag, wading water or the painted terrain tile. */
  private surfaceUnder(p: THREE.Vector3, collider: RAPIER.Collider | null): FootSurface {
    const w = this.world!;
    if (riverWorld.waterLevelAt3(p.x, p.y + 0.5, p.z) > p.y + 0.04) return 'water';
    const ud = (collider as unknown as { userData?: { pieceId?: string; pieceType?: string; surface?: FootSurface } } | null)?.userData;
    if (ud?.pieceId) {
      const type = ud.pieceType ?? '';
      if (type.startsWith('STONE')) return 'stone';
      const bm = w.character.buildAbility?.buildingManager;
      if (type.includes('FLOOR') && bm) return floorSurface(bm.wallPaintingSystem.getCellWallpaper(ud.pieceId, 'top'));
      return 'wood';
    }
    if (ud?.surface) return ud.surface;
    if (w.exploration.inCave) return 'stone';
    if (Math.abs(p.y - w.terrain.getHeight(p.x, p.z)) < 0.3) {
      const tile = TILE_SURFACE[w.terrain.getTile(Math.floor(p.x), Math.floor(p.z))] ?? 'grass';
      // Fallen snow covers the ground once it is more than a dusting (it melts on fields and dirt tracks)
      return w.weather.snowCover > 0.35 && tile !== 'dirt' && p.y > worldSettings.waterLevel + 0.3 ? 'snow' : tile;
    }
    return 'stone';
  }

  private playFootstep(intensity: number, point: THREE.Vector3, collider: RAPIER.Collider | null): void {
    const w = this.world;
    if (!w || this.paused || this.mode !== 'play' || !audioEngine.context) return;
    const surface = this.surfaceUnder(point, collider);
    // Rain soaks open ground: steps get a squelch layer (not under roofs, in caves or on floors)
    const weather = w.weather;
    const exposed = !w.exploration.inCave && !weather.isSheltered(point) && !(collider as unknown as { userData?: { pieceId?: string } } | null)?.userData?.pieceId;
    const wet = exposed ? weather.rainIntensity * (1 - weather.snowAmount) : 0;
    this.footsteps.step(surface, intensity, wet);
    this.coast.duck(intensity);
  }

  /** Brings the scooter to the player (V key / HUD button). Not underground or while riding. */
  public callMoped(): void {
    const w = this.world;
    if (!w || w.moped.isPlayerInside || w.vehicle.isPlayerInside || w.boat.isPlayerInside || this.mode !== 'play') return;
    const ok = !w.exploration.inCave && w.moped.callTo(w.character);
    this.callbacks.onNotify(t(ok ? 'moped.called' : 'moped.cantCall'), ok ? 'info' : 'warning');
  }

  private consumeKeyG(): boolean {
    const g = this.keyG;
    this.keyG = false;
    return g;
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (this.paused) {
      if (e.code === 'Escape') this.callbacks.onPauseHotkey();
      return;
    }
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
    } else if (e.code === 'KeyV' && !e.repeat) {
      this.callMoped();
    } else if (e.code === 'KeyM' && !e.repeat) {
      this.callbacks.onMapHotkey();
    } else if (e.code === 'KeyJ' && !e.repeat && this.world?.gameplay.workers) {
      const gp = this.world.gameplay;
      gp.openPanel(gp.panel === 'workers' ? null : 'workers');
    } else if (e.code === 'KeyQ') {
      this.callbacks.onInventoryHotkey();
    } else if (e.code === 'Escape') {
      // Esc closes what is open; with nothing open it pauses (App decides, it knows the panels)
      if (!this.world?.gameplay.panel) this.callbacks.onPauseHotkey();
      this.callbacks.onInventoryHotkey(false);
      this.callbacks.onMapHotkey(false);
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
    this.pausedRedraw = true;
  };

  /** `window.dev` console helpers (dev builds only). */
  private createDevApi() {
    const w = this.world!;
    return {
      engine: this,
      world: w,
      /** Lands a bolt (after its warning) at x, z, or a few metres in front of the player. */
      strike: (x?: number, z?: number) => {
        const p = w.character.getPosition();
        const sx = x ?? p.x + 6, sz = z ?? p.z;
        w.lightning.schedule(sx, Math.max(w.terrain.getHeight(sx, sz), riverWorld.waterLevelAt(sx, sz)), sz);
      },
      /** Every apple tree grown and at `phase` (rest | bloom | fruit | ripe; default ripe). */
      apples: (phase?: 'rest' | 'bloom' | 'fruit' | 'ripe') => w.orchard.devGrow(phase),
      tp: (x: number, z: number, y?: number) =>
        w.character.respawn(new THREE.Vector3(x, (y ?? w.terrain.getHeight(x, z)) + 1.5, z)),
      time: (hour: number) => (worldSettings.timeOfDay = ((hour % 24) + 24) % 24),
      weather: (type: Parameters<WeatherSystem['setWeather']>[0]) => w.weather.setWeather(type),
      /** Jump to the first day of a season ('spring' | 'summer' | 'autumn' | 'winter'). */
      season: (s: Season) => (worldSettings.day = firstDayOf(s)),
      /** Rainbow as after a rain (needs daytime; try time(8) or time(17)). */
      rainbow: () => w.weather.devRainbow(),
      /** Automatic weather on/off, and the upcoming states. */
      weatherAuto: (on = true) => (w.weather.director.auto = on),
      forecast: () => w.weather.director.forecast().map((f) => ({ ...f })),
      water: (level: number) => (worldSettings.waterLevel = level),
      give: (itemId: string, n = 1) => w.inventoryManager.addItem(itemId, n),
      /** An enemy ('hedgehog' | 'dragon' | 'shark' | 'spider') a few metres from the player. */
      enemy: (kind: PestKind) => !!w.gameplay.pests.spawnNear(kind, w.character.getPosition(), !!w.exploration.inCave),
      spawn: (type: string, x: number, z: number, rot = 0, scale = 1) => w.props.add(type, x, z, rot, scale),
      save: (slot = 'dev') => w.saves.save(slot),
      load: (slot = 'dev') => w.saves.load(slot),
      editor: (on = true) => this.setMode(on ? 'editor' : 'play'),
      stats: () => ({ ...this.renderer.info.render, ...this.renderer.info.memory }),
      npcPath: (on = true) => {
        w.gameplay.companion?.setDebug(on);
        w.gameplay.workers?.setDebug(on);
      },
      /** Storage chest stock: `dev.storage.list()`, `dev.storage.put('dish_bread', 5)`. */
      storage: {
        list: () => w.gameplay.storage?.list(),
        put: (id: string, n = 1) => w.gameplay.storage?.put(id, n),
      },
      /** Farmhands: `dev.workers.list()`, `dev.workers.hire(n)` near the player (up to MAX_WORKERS). */
      workers: {
        list: () =>
          w.gameplay.workers?.workers.map((x) => ({ name: x.name, role: x.role, energy: Math.round(x.energy), food: Math.round(x.food), activity: x.activity, errand: x.errand, task: x.task?.key ?? null, carry: x.carry.map((c) => `${c.itemId}x${c.amount}`).join(','), done: x.jobsDone, bed: x.bed?.key ?? null })),
        food: (v: number) => w.gameplay.workers?.workers.forEach((x) => (x.food = v)),
        role: (role: WorkerRole) => w.gameplay.workers?.workers.forEach((x) => x.setRole(role)),
        jobs: () => w.gameplay.workers?.board?.counts(),
        hire: (n = 1) => {
          let hired = 0;
          for (let i = 0; i < n; i++) {
            const p = w.character.getPosition();
            if (!w.gameplay.workers?.spawn(new THREE.Vector3(p.x + 2 + Math.random() * 2, 0, p.z + Math.random() * 2))) break;
            hired++;
          }
          return `${hired} hired, ${w.gameplay.workers?.workers.length ?? 0}/${MAX_WORKERS}`;
        },
        energy: (v: number) => w.gameplay.workers?.workers.forEach((x) => (x.energy = v)),
      },
      /** Rivers: defs, samples (`riverWorld.get(id)`), water queries. */
      rivers: riverWorld,
      /** Wildlife: `dev.wild.stats`, `dev.wild.enabled = false` to measure its cost. */
      wild: w.wildlife,
      shadows: w.shadows,
      grass: w.grass,
    };
  }
}
