import * as THREE from 'three';
import { BuildingSceneExportData } from '../building/types/BuildingTypes';
import { TerrainSaveData } from './TerrainSystem';
import { PropSaveData, MILLSTONE_SPOT, FOREST_VERSION } from './PropSystem';
import { PetSaveData } from '../gameplay/PetSystem';
import { WeatherType } from './WeatherSystem';
import type { WeatherDirectorSave } from './WeatherDirector';
import { MAX_SEA_FLOOR_DEPTH, MIN_SEA_FLOOR_DEPTH, WORLD_SIZE, worldSettings } from './WorldSettings';
import { duckweed } from './Duckweed';
import { POND_TINT_RES, pondTint } from './PondTint';
import { SEASONS, Season, legacySeasonOf } from './Seasons';
import type { GameWorld } from '../engine/GameEngine';
import type { FieldSaveData } from '../farming/FieldManager';
import type { ExplorationSaveData } from '../explore/ExplorationManager';
import type { OrchardSaveData } from '../gathering/AppleOrchard';
import type { NurserySaveData } from '../gathering/TreeNursery';
import { MAX_WORKERS, type WorkerSaveData } from '../npc/WorkerManager';
import { STORAGE_CHEST, STORAGE_CHEST_SPOT } from '../npc/FarmStorage';
import { ROCK_TYPES } from '../gathering/GatheringConfig';
import type { AuthoredRock } from '../gathering/RockField';
import { PEST_KINDS, type AuthoredPest, type PestKind } from '../gameplay/Pests';
import { isGeneratedRockSave, isGeneratedRockType, MAX_GENERATED_ROCKS, type GeneratedRockSave } from './GeneratedRocks';
import { isBridgeSave, type BridgeDef } from './BridgeTypes';

export const SAVE_VERSION = 3;
const LEGACY_SAVE_VERSION = 2;
const KEY_PREFIX = 'cozyfarm.save.';
export const AUTOSAVE_SLOT = 'auto';

function migrateOreId(id: string): string {
  if (id === 'gold_nugget') return 'gold_ore';
  if (id === 'silver_nugget') return 'silver_ore';
  return id;
}

function mergeOreStacks(items: Record<string, number>): Record<string, number> {
  const { gold_nugget = 0, silver_nugget = 0, ...counts } = items;
  counts.gold_ore = (counts.gold_ore ?? 0) + gold_nugget;
  counts.silver_ore = (counts.silver_ore ?? 0) + silver_nugget;
  return counts;
}

export interface WorldSaveData {
  version: number;
  savedAt: string;
  terrain: TerrainSaveData;
  waterLevel: number;
  timeOfDay: number;
  weather: WeatherType;
  /** Automatic weather chain (missing in older saves: rolled fresh). */
  weatherDirector?: WeatherDirectorSave;
  /** Snow lying on the ground 0..1 (missing in older saves: none). */
  snowCover?: number;
  props: PropSaveData[];
  generatedRocks?: GeneratedRockSave[];
  /** Forest generation the props came from (missing = before the denser forests). */
  forest?: number;
  buildings: BuildingSceneExportData | null;
  bridges?: BridgeDef[];
  /** Garden-bed crops of old saves (beds were removed): ignored. */
  crops?: unknown;
  /** Shovel-dug fields (their soil tiles are part of the terrain save). */
  fields?: FieldSaveData[];
  /** Player-planted apple trees and apples lying around (missing in older saves). */
  orchard?: OrchardSaveData;
  /** Saplings the player planted from cones, acorns and bush cuttings (missing in older saves). */
  nursery?: NurserySaveData;
  inventory: { items: Record<string, number>; equipped: string | null; hotbar?: (string | null)[]; capacity?: number; dynamiteStackGifted?: boolean };
  player: [number, number, number];
  vehicle: { p: [number, number, number]; yaw: number } | null;
  moped?: { p: [number, number, number]; yaw: number };
  boat?: { p: [number, number, number]; yaw: number };
  exploration?: ExplorationSaveData;
  pets: PetSaveData[];
  /** Farmhands (missing in older saves: the starting crew stays). */
  workers?: WorkerSaveData[];
  authoredRocks?: AuthoredRock[];
  authoredPests?: AuthoredPest[];
  /** The farm storage chests' shared stock. */
  storage?: Record<string, number>;
  /** Days passed (missing in older saves: 0). */
  day?: number;
  /** Fixed season; saves from before it follow their day counter (legacySeasonOf) */
  season?: Season;
  /** Duckweed painted on the water (Duckweed.ts RLE; missing: none). */
  duckweed?: string;
  /** Painted weight of the pond palette, using the water mask's byte RLE. */
  pondTint?: string;
  /** Sleep and respawn: the bed slept in last and that night's index. */
  sleep?: { bed: [number, number, number] | null; night: number };
}

export interface SaveSlotInfo {
  slot: string;
  savedAt: string;
  sizeKb: number;
}


const MAX_SAVE_FILE_BYTES = 32 * 1024 * 1024;
const WEATHER_TYPES: readonly string[] = ['clear', 'cloudy', 'rain', 'storm', 'fog', 'snow', 'blizzard'];

type SaveRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SaveRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isNumberTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100_000 && value.every((item) => typeof item === 'string');
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 1_000_000 && value.every(isFiniteNumber);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((item) => isFiniteNumber(item) && item >= 0);
}

function decodeSaveBase64(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4_000_000) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    return atob(value);
  } catch {
    return null;
  }
}

/** Validate the RLE pair stream before TerrainSystem allocates and decodes its full heightmap. */
function isValidRleBase64(value: unknown, expectedValues: number): boolean {
  const decoded = decodeSaveBase64(value);
  if (decoded === null || decoded.length === 0 || decoded.length % 4 !== 0) return false;

  let total = 0;
  for (let i = 0; i < decoded.length; i += 4) {
    const rawCount = decoded.charCodeAt(i) | (decoded.charCodeAt(i + 1) << 8);
    const count = rawCount >= 0x8000 ? rawCount - 0x10000 : rawCount;
    if (count <= 0) return false;
    total += count;
    if (total > expectedValues) return false;
  }
  return total === expectedValues;
}

function isTerrainSave(value: unknown): value is TerrainSaveData {
  if (!isRecord(value) || !isIntegerInRange(value.size, 1, WORLD_SIZE)) return false;
  const depth = value.seaFloorDepth;
  if (depth !== undefined && (!isFiniteNumber(depth) || depth < MIN_SEA_FLOOR_DEPTH || depth > MAX_SEA_FLOOR_DEPTH)) return false;
  const size = value.size as number;

  if (value.enc === 'd1' || value.enc === 'd2') {
    return isValidRleBase64(value.heights, (size + 1) * (size + 1)) &&
      isValidRleBase64(value.tiles, size * size);
  }

  if (value.enc !== undefined) return false;
  const heights = decodeSaveBase64(value.heights);
  const tiles = decodeSaveBase64(value.tiles);
  return heights !== null && tiles !== null &&
    heights.length === (size + 1) * (size + 1) * 2 &&
    tiles.length === size * size;
}

function isSavedPiece(value: unknown): boolean {
  if (!isRecord(value) ||
      typeof value.id !== 'string' || typeof value.type !== 'string' ||
      !isNumberTuple(value.position, 3) || !isNumberTuple(value.quaternion, 4)) return false;
  if (value.rotation !== undefined && !isNumberTuple(value.rotation, 3)) return false;
  if (value.health !== undefined && !isFiniteNumber(value.health)) return false;
  if (value.isOpen !== undefined && typeof value.isOpen !== 'boolean') return false;
  if (value.roofConfig !== undefined && !isRecord(value.roofConfig)) return false;
  if (value.roofStyle !== undefined && typeof value.roofStyle !== 'string') return false;
  const q = value.quaternion as number[];
  return q.some((part) => Math.abs(part) > 1e-8);
}

function isBuildingSave(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || value.version !== 1 ||
      !isRecord(value.metadata) || !Array.isArray(value.pieces) || value.pieces.length > 100_000) return false;
  const metadata = value.metadata;
  if (!isIntegerInRange(metadata.totalPieces, 0, 100_000) ||
      !isIntegerInRange(metadata.customizedCells, 0, 10_000_000) ||
      typeof metadata.confirmed !== 'boolean') return false;
  if (metadata.roofStyle !== undefined && typeof metadata.roofStyle !== 'string') return false;
  if (!value.pieces.every(isSavedPiece)) return false;
  if (value.wallPainting !== undefined &&
      (!isRecord(value.wallPainting) || !Object.values(value.wallPainting).every((v) => typeof v === 'string'))) return false;
  return true;
}

function isPropSave(value: unknown): value is PropSaveData {
  return isRecord(value) && typeof value.type === 'string' &&
    isNumberTuple(value.p, 3) && isFiniteNumber(value.r) &&
    isFiniteNumber(value.s) && value.s > 0 && value.s <= 100 &&
    (value.g === undefined || typeof value.g === 'boolean') &&
    (value.n === undefined || isFiniteNumber(value.n)) &&
    (value.c === undefined || isNumberTuple(value.c, 2)) &&
    (value.hd === undefined || isFiniteNumber(value.hd)) &&
    (value.w === undefined || isRecord(value.w)) &&
    (value.wa === undefined || isNumberArray(value.wa)) &&
    (value.t === undefined || isNumberTuple(value.t, 2));
}

function isVehicleSave(value: unknown): boolean {
  return isRecord(value) && isNumberTuple(value.p, 3) && isFiniteNumber(value.yaw);
}

function isPetSave(value: unknown): boolean {
  return isRecord(value) && (value.kind === 'cat' || value.kind === 'dog') &&
    typeof value.name === 'string' && isFiniteNumber(value.affection) &&
    isNumberTuple(value.p, 2);
}

function isWorkerSave(value: unknown): boolean {
  if (!isRecord(value) || !isIntegerInRange(value.slot, 0, 1000) ||
      typeof value.role !== 'string' || !isFiniteNumber(value.energy) ||
      !isFiniteNumber(value.jobsDone) || !isNumberTuple(value.pos, 3) ||
      !isNumberTuple(value.home, 3) || typeof value.asleep !== 'boolean' ||
      !(value.bed === undefined || value.bed === null || typeof value.bed === 'string')) return false;
  if (value.food !== undefined && !isFiniteNumber(value.food)) return false;
  if (value.carry !== undefined &&
      (!Array.isArray(value.carry) || !value.carry.every((item) =>
        isRecord(item) && typeof item.itemId === 'string' && isFiniteNumber(item.amount) && item.amount >= 0))) return false;
  return true;
}

function isExplorationSave(value: unknown): boolean {
  return isRecord(value) && typeof value.explored === 'string' &&
    isStringArray(value.discovered) && isStringArray(value.chests) &&
    isStringArray(value.recipes) && Array.isArray(value.markers) &&
    value.markers.length <= 100_000 && value.markers.every(isRecord) &&
    (value.caveExcavations === undefined || (Array.isArray(value.caveExcavations) && value.caveExcavations.every(cut =>
      isRecord(cut) && isFiniteNumber(cut.x) && isFiniteNumber(cut.y) && isFiniteNumber(cut.z) && isFiniteNumber(cut.r) && cut.r > 0))) &&
    (value.caveNuggets === undefined || (Array.isArray(value.caveNuggets) && value.caveNuggets.every(nugget =>
      isRecord(nugget) && isFiniteNumber(nugget.x) && isFiniteNumber(nugget.y) && isFiniteNumber(nugget.z) &&
      (nugget.metal === 'gold' || nugget.metal === 'silver') && typeof nugget.collected === 'boolean' &&
      Array.isArray(nugget.normal) && nugget.normal.length === 3 && nugget.normal.every(isFiniteNumber))));
}

function isWeatherDirectorSave(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.rng) && isFiniteNumber(value.hoursLeft) &&
    Array.isArray(value.queue) && value.queue.length <= 100 &&
    value.queue.every((entry) => isRecord(entry) &&
      WEATHER_TYPES.includes(String(entry.type)) && isFiniteNumber(entry.hours) && entry.hours > 0) &&
    typeof value.auto === 'boolean';
}

/** Runtime guard for both local saves and user-supplied world files. */
function isWorldSaveData(value: unknown): value is WorldSaveData {
  if (!isRecord(value) || (value.version !== SAVE_VERSION && value.version !== LEGACY_SAVE_VERSION) ||
      typeof value.savedAt !== 'string' || !isTerrainSave(value.terrain) ||
      !isFiniteNumber(value.waterLevel) || !isFiniteNumber(value.timeOfDay) ||
      value.timeOfDay < 0 || value.timeOfDay > 24 ||
      !WEATHER_TYPES.includes(String(value.weather)) ||
      !Array.isArray(value.props) || value.props.length > 200_000 ||
      !value.props.every(isPropSave) || !isBuildingSave(value.buildings)) return false;
  if (value.bridges !== undefined && !isBridgeSave(value.bridges)) return false;

  const rockTypes = new Set<string>();
  if (value.generatedRocks !== undefined) {
    if (!Array.isArray(value.generatedRocks) || value.generatedRocks.length > MAX_GENERATED_ROCKS) return false;
    for (const rock of value.generatedRocks) {
      if (!isGeneratedRockSave(rock) || rockTypes.has(rock.id)) return false;
      rockTypes.add(rock.id);
    }
  }
  if (value.props.some(({ type }) => isGeneratedRockType(type) && !rockTypes.has(type))) return false;

  if (!isRecord(value.inventory) || !isNumberRecord(value.inventory.items) ||
      !(value.inventory.equipped === null || typeof value.inventory.equipped === 'string') ||
      (value.inventory.hotbar !== undefined &&
        (!Array.isArray(value.inventory.hotbar) ||
          !value.inventory.hotbar.every((item) => item === null || typeof item === 'string'))) ||
      (value.inventory.capacity !== undefined &&
        !isIntegerInRange(value.inventory.capacity, 1, 100_000)) ||
      !isNumberTuple(value.player, 3) ||
      !(value.vehicle === null || isVehicleSave(value.vehicle))) return false;

  if (value.pets !== undefined &&
      (!Array.isArray(value.pets) || value.pets.length > 1000 || !value.pets.every(isPetSave))) return false;
  if (value.moped !== undefined && !isVehicleSave(value.moped)) return false;
  if (value.boat !== undefined && !isVehicleSave(value.boat)) return false;
  if (value.fields !== undefined &&
      (!Array.isArray(value.fields) || value.fields.length > 100_000 ||
        !value.fields.every((field) => isRecord(field) && isFiniteNumber(field.gx) &&
          isFiniteNumber(field.gz) && isNumberArray(field.prev) &&
          (field.crop === null || field.crop === undefined || isRecord(field.crop))))) return false;
  if (value.orchard !== undefined &&
      (!isRecord(value.orchard) || !Array.isArray(value.orchard.t) ||
        !value.orchard.t.every((row) => isNumberArray(row)) ||
        (value.orchard.a !== undefined &&
          (!Array.isArray(value.orchard.a) || !value.orchard.a.every((row) => isNumberArray(row)))))) return false;
  if (value.nursery !== undefined &&
      (!Array.isArray(value.nursery) || !value.nursery.every((row) =>
        Array.isArray(row) && row.length === 6 && typeof row[0] === 'string' &&
        row.slice(1).every(isFiniteNumber)))) return false;
  if (value.exploration !== undefined && !isExplorationSave(value.exploration)) return false;
  if (value.workers !== undefined &&
      (!Array.isArray(value.workers) || value.workers.length > MAX_WORKERS || !value.workers.every(isWorkerSave))) return false;
  if (value.authoredRocks !== undefined) {
    if (!Array.isArray(value.authoredRocks) || value.authoredRocks.length > 512) return false;
    const ids = new Set<number>();
    for (const rock of value.authoredRocks) {
      if (!isRecord(rock) || !isIntegerInRange(rock.id, -1_000_000, -1) ||
          typeof rock.kind !== 'string' || !Object.hasOwn(ROCK_TYPES, rock.kind) ||
          !isNumberTuple(rock.position, 3) || rock.position.some((coordinate) => Math.abs(coordinate) > 3000) ||
          !isFiniteNumber(rock.scale) || rock.scale < 0.1 || rock.scale > 10) return false;
      if (ids.has(rock.id as number)) return false;
      ids.add(rock.id as number);
    }
  }
  if (value.authoredPests !== undefined) {
    if (!Array.isArray(value.authoredPests) || value.authoredPests.length > 256) return false;
    const ids = new Set<number>();
    for (const pest of value.authoredPests) {
      if (!isRecord(pest) || !isIntegerInRange(pest.id, 1, 1_000_000) || !PEST_KINDS.includes(pest.kind as PestKind) ||
          !isNumberTuple(pest.position, 3) || pest.position.some((coordinate) => Math.abs(coordinate) > 3000) ||
          (pest.normal !== undefined && (!isNumberTuple(pest.normal, 3) || pest.normal.some((component) => Math.abs(component) > 1.01)))) return false;
      if (ids.has(pest.id as number)) return false;
      ids.add(pest.id as number);
    }
  }
  if (value.storage !== undefined && !isNumberRecord(value.storage)) return false;
  if (value.weatherDirector !== undefined && !isWeatherDirectorSave(value.weatherDirector)) return false;
  if (value.snowCover !== undefined &&
      (!isFiniteNumber(value.snowCover) || value.snowCover < 0 || value.snowCover > 1)) return false;
  if (value.forest !== undefined && !isIntegerInRange(value.forest, 0, 1_000_000)) return false;
  if (value.day !== undefined && (!isFiniteNumber(value.day) || value.day < 0)) return false;
  if (value.season !== undefined && !['spring', 'summer', 'autumn', 'winter'].includes(String(value.season))) return false;
  if (value.duckweed !== undefined && decodeSaveBase64(value.duckweed) === null) return false;
  if (value.pondTint !== undefined) {
    const decoded = decodeSaveBase64(value.pondTint);
    if (!decoded || decoded.length % 3 !== 0 || decoded.length > POND_TINT_RES ** 2 * 3) return false;
    let cells = 0;
    for (let i = 0; i < decoded.length; i += 3) {
      const run = decoded.charCodeAt(i + 1) | (decoded.charCodeAt(i + 2) << 8);
      if (run === 0) return false;
      cells += run;
      if (cells > POND_TINT_RES ** 2) return false;
    }
    if (cells !== POND_TINT_RES ** 2) return false;
  }
  if (value.sleep !== undefined &&
      (!isRecord(value.sleep) ||
        !(value.sleep.bed === null || isNumberTuple(value.sleep.bed, 3)) ||
        !isFiniteNumber(value.sleep.night))) return false;
  return true;
}

/**
 * Whole-world save/load. Slots live in localStorage (terrain is stored as edits over the generated
 * island, so a typical save is ~200-400 KB, mostly props);
 * files can be exported/imported as JSON for sharing levels between developers.
 */
export class SaveSystem {
  private recoveryRequired = false;

  constructor(private readonly world: GameWorld) {}

  public capture(): WorldSaveData {
    return this.captureWorld();
  }

  private captureWorld(forRollback = false): WorldSaveData {
    const w = this.world;
    const items: Record<string, number> = {};
    for (const item of w.inventoryManager.getItems()) items[item.id] = item.count;
    // While riding, the on-foot body is parked under the world: save the player beside the vehicle
    const ride = w.vehicle.isPlayerInside ? w.vehicle : w.moped.isPlayerInside ? w.moped : null;
    // A save made in the caves resumes outside the nearest cave mouth;
    // a save made at sea resumes on the pier
    const p = forRollback ? w.character.getPosition() : w.boat.isPlayerInside
      ? w.boat.dock.clone().add(new THREE.Vector3(0, 1.2, 0))
      : ride
      ? ride.getPosition().add(new THREE.Vector3(1.5, 1.2, 0))
      : w.exploration.inCave
        ? w.exploration.savePosition(w.character.getPosition()).add(new THREE.Vector3(0, 1.2, 0))
        : w.character.getPosition();
    const vt = w.vehicle.body.translation();
    const vr = w.vehicle.body.rotation();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(vr.x, vr.y, vr.z, vr.w));
    const generatedRocks = w.props.serializeGeneratedRocks();
    const bridges = w.bridges.serialize();
    return {
      version: SAVE_VERSION,
      savedAt: new Date().toISOString(),
      terrain: w.terrain.serialize(),
      waterLevel: worldSettings.waterLevel,
      duckweed: duckweed.serialize(),
      pondTint: pondTint.serialize(),
      timeOfDay: worldSettings.timeOfDay,
      weather: w.weather.weather,
      weatherDirector: w.weather.director.serialize(),
      snowCover: +w.weather.snowCover.toFixed(3),
      props: w.props.serialize(),
      generatedRocks: generatedRocks.length ? generatedRocks : undefined,
      forest: w.props.forestVersion,
      buildings: w.character.buildAbility?.buildingManager?.exportScene() ?? null,
      bridges: bridges.length ? bridges : undefined,
      fields: w.farmingManager.serializeFields(),
      orchard: w.orchard.serialize(),
      nursery: w.nursery.serialize(),
      inventory: {
        items,
        equipped: w.inventoryManager.getEquippedItemId(),
        hotbar: w.inventoryManager.getHotbar(),
        capacity: w.inventoryManager.getCapacity(),
        dynamiteStackGifted: true,
      },
      player: forRollback ? [p.x, p.y, p.z] : [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
      vehicle: { p: [vt.x, vt.y + (forRollback ? 0 : 0.3), vt.z], yaw: Math.atan2(fwd.x, fwd.z) },
      moped: { p: w.moped.getPosition().add(new THREE.Vector3(0, forRollback ? 0 : 0.2, 0)).toArray(), yaw: w.moped.getYaw() },
      boat: { p: w.boat.getPosition().toArray() as [number, number, number], yaw: w.boat.getYaw() },
      pets: w.gameplay.pets.serialize(),
      workers: w.gameplay.workers?.serialize(),
      authoredRocks: w.rocks.serializeAuthored(),
      authoredPests: w.gameplay.pests.serializeAuthored(),
      storage: w.gameplay.storage?.serialize(),
      day: worldSettings.day,
      season: worldSettings.season,
      sleep: {
        bed: w.gameplay.respawnBed ? (w.gameplay.respawnBed.toArray().map((v) => +v.toFixed(2)) as [number, number, number]) : null,
        night: w.gameplay.lastSleepNight,
      },
      exploration: w.exploration.serialize(),
    };
  }

  private apply(data: WorldSaveData, restoring = false): void {
    const w = this.world;
    worldSettings.waterLevel = data.waterLevel;
    worldSettings.timeOfDay = data.timeOfDay;
    worldSettings.day = data.day ?? 0;
    worldSettings.season = data.season && SEASONS.includes(data.season) ? data.season : legacySeasonOf(worldSettings.day);
    w.gameplay.respawnBed = data.sleep?.bed ? new THREE.Vector3(...data.sleep.bed) : null;
    w.gameplay.lastSleepNight = data.sleep?.night ?? -1;
    w.weather.setWeather(data.weather);
    w.weather.director.deserialize(data.weather, data.weatherDirector);
    w.weather.snowCover = Math.min(1, Math.max(0, data.snowCover ?? 0));
    w.terrain.deserialize(data.terrain);
    w.bridges.deserialize(data.bridges);
    duckweed.deserialize(data.duckweed);
    pondTint.deserialize(data.pondTint);
    w.props.deserialize(data.props, data.generatedRocks);
    // Saves from before the millstone existed get one at its usual spot
    if (!restoring) w.props.ensureStation('millstone', MILLSTONE_SPOT.x, MILLSTONE_SPOT.z);
    // ...and a storage chest for the farmhands
    if (!restoring) w.props.ensureStation(STORAGE_CHEST, STORAGE_CHEST_SPOT.x, STORAGE_CHEST_SPOT.z, Math.PI);
    // A save from the old 128 m world now sits in the island's centre: grow nature around it
    w.props.forestVersion = data.forest ?? 0;
    if (w.terrain.expandedFromLegacy) {
      w.props.populateWilderness();
      w.props.forestVersion = 0;
    }
    // Worlds from before the denser forests get the extra trees once (after buildings load)
    if (!restoring && w.props.forestVersion < FOREST_VERSION) w.props.queueForestUpgrade();
    w.exploration.clearSiteProps();
    w.exploration.deserialize(data.exploration);

    const bm = w.character.buildAbility?.buildingManager;
    if (bm) {
      bm.clear();
      if (data.buildings) bm.importScene(data.buildings);
      bm.flushPendingRegeneration();
    }
    w.farmingManager.deserializeFields(data.fields ?? []);
    w.orchard.deserialize(data.orchard);
    w.nursery.deserialize(data.nursery);

    const inv = w.inventoryManager;
    const inventoryItems = mergeOreStacks(data.inventory.items);
    for (const item of inv.getItems()) {
      const count = inventoryItems[item.id];
      if (count === undefined) continue;
      if (count > item.count) inv.addItem(item.id, count - item.count);
      else if (count < item.count) inv.removeItem(item.id, item.count - count);
    }
    // One-time grant for existing saves: raise the starter dynamite stack to 99 without refilling it on later loads.
    if (!data.inventory.dynamiteStackGifted) {
      inv.addItem('dynamite', Math.max(0, 99 - inv.getItemCount('dynamite')));
    }
    const equipped = data.inventory.equipped === null ? null : migrateOreId(data.inventory.equipped);
    if (equipped !== inv.getEquippedItemId()) inv.equipItem(equipped);
    // Saves from before the hotbar keep the default tool row
    if (data.inventory.hotbar) inv.setHotbar(data.inventory.hotbar.map(id => id === null ? null : migrateOreId(id)));
    // Saves from before the slingshot: it joins the hotbar once (if a slot is free)
    if (data.inventory.items.slingshot === undefined && !inv.isOnHotbar('slingshot')) inv.addToHotbar('slingshot');
    // Saves from before dynamite: the new starter stack joins the hotbar once (if a slot is free)
    if (data.inventory.items.dynamite === undefined && !inv.isOnHotbar('dynamite')) inv.addToHotbar('dynamite');
    if (data.inventory.capacity) inv.setCapacity(data.inventory.capacity);

    const [px, py, pz] = data.player;
    w.character.respawn(new THREE.Vector3(px, py + (restoring ? 0 : 0.3), pz));
    if (data.vehicle) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), data.vehicle.yaw);
      w.vehicle.body.setTranslation({ x: data.vehicle.p[0], y: data.vehicle.p[1], z: data.vehicle.p[2] }, true);
      w.vehicle.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      w.vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
    if (data.moped) w.moped.place(new THREE.Vector3(...data.moped.p), data.moped.yaw);
    if (data.boat) w.boat.place(new THREE.Vector3(...data.boat.p), data.boat.yaw);
    if (data.pets?.length || (restoring && data.pets)) w.gameplay.pets.deserialize(data.pets);
    w.gameplay.storage?.deserialize(data.storage && mergeOreStacks(data.storage));
    if (data.workers && w.gameplay.workers) {
      w.gameplay.workers.deserialize(data.workers.map(worker => ({
        ...worker, carry: worker.carry?.map(item => ({ ...item, itemId: migrateOreId(item.itemId) })),
      })));
    }
    w.rocks.restoreAuthored(data.authoredRocks ?? []);
    // Older worlds still carry enemy placements made before the map was cleared.
    if (data.version === LEGACY_SAVE_VERSION) w.gameplay.pests.clear();
    else w.gameplay.pests.restoreAuthored(data.authoredPests ?? []);
  }

  /** Called after a save was applied (the engine then uploads the new world to the GPU in one go). */
  public onApplied: (() => void) | null = null;

  public get needsRecovery(): boolean {
    return this.recoveryRequired;
  }

  private restoreWorld(data: WorldSaveData): boolean {
    const { exploration, gameplay } = this.world;
    const previousCave = exploration.inCave;
    const previousAnchor = gameplay.anchorOverride;
    let previous: WorldSaveData;
    try {
      previous = this.captureWorld(true);
    } catch (error) {
      console.warn('[SaveSystem] could not snapshot the current world', error);
      return false;
    }

    try {
      this.apply(data);
      this.recoveryRequired = false;
    } catch (error) {
      console.warn('[SaveSystem] load failed; restoring the previous world', error);
      try {
        this.apply(previous, true);
        exploration.inCave = previousCave;
        gameplay.anchorOverride = previousAnchor;
        this.notifyApplied();
      } catch (restoreError) {
        this.recoveryRequired = true;
        console.error('[SaveSystem] failed to restore the previous world', restoreError);
      }
      return false;
    }
    this.notifyApplied();
    return true;
  }

  private notifyApplied(): void {
    try {
      this.onApplied?.();
    } catch (error) {
      console.error('[SaveSystem] post-load notification failed', error);
    }
  }

  // ---------------------------------------------------------------- slots

  /**
   * Terrain and props are by far the biggest parts and rarely change (their captures are cached by
   * identity): keep their JSON text too instead of re-stringifying hundreds of KB every minute.
   */
  private jsonCache = new Map<string, { data: unknown; json: string }>();

  private serializeCapture(): string {
    const data = this.capture() as unknown as Record<string, unknown>;
    const heavy: [string, string][] = [];
    for (const key of ['terrain', 'props']) {
      const value = data[key];
      let entry = this.jsonCache.get(key);
      if (!entry || entry.data !== value) {
        entry = { data: value, json: JSON.stringify(value) };
        this.jsonCache.set(key, entry);
      }
      heavy.push([key, entry.json]);
      data[key] = null;
    }
    let out = JSON.stringify(data);
    for (const [key, json] of heavy) out = out.replace(`"${key}":null`, () => `"${key}":${json}`);
    return out;
  }

  public save(slot: string): boolean {
    if (this.recoveryRequired) return false;
    try {
      localStorage.setItem(KEY_PREFIX + slot, this.serializeCapture());
      return true;
    } catch (err) {
      console.warn('[SaveSystem] save failed', err);
      return false;
    }
  }

  public load(slot: string): boolean {
    const data = SaveSystem.read(slot);
    return data !== null && this.restoreWorld(data);
  }

  public static read(slot: string): WorldSaveData | null {
    try {
      const raw = localStorage.getItem(KEY_PREFIX + slot);
      if (!raw) return null;
      const data: unknown = JSON.parse(raw);
      return isWorldSaveData(data) ? data : null;
    } catch {
      return null;
    }
  }

  public static delete(slot: string): void {
    try {
      localStorage.removeItem(KEY_PREFIX + slot);
    } catch {
      // storage unavailable
    }
  }

  public static listSlots(): SaveSlotInfo[] {
    const out: SaveSlotInfo[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(KEY_PREFIX)) continue;
        const raw = localStorage.getItem(key) ?? '';
        let savedAt = '';
        try {
          savedAt = (JSON.parse(raw) as WorldSaveData).savedAt;
        } catch {
          // corrupt slot
        }
        out.push({ slot: key.slice(KEY_PREFIX.length), savedAt, sizeKb: Math.round(raw.length / 1024) });
      }
    } catch {
      // storage unavailable (private mode)
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  public exportFile(name = 'world'): void {
    const blob = new Blob([JSON.stringify(this.capture())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.world.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /**
   * The world a first session starts in (no autosave yet): public/worlds/default.world.json.
   * False when it is missing or doesn't match this save version (the generated world is used then).
   */
  public async loadDefaultWorld(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}worlds/default.world.json`, signal ? { signal } : undefined);
      if (!res.ok || signal?.aborted) return false;
      const data: unknown = await res.json();
      if (signal?.aborted || !isWorldSaveData(data)) return false;
      return this.restoreWorld(data);
    } catch {
      return false;
    }
  }

  public importFile(file: File): Promise<boolean> {
    if (file.size > MAX_SAVE_FILE_BYTES) return Promise.resolve(false);

    return file.text().then((text) => {
      if (text.length > MAX_SAVE_FILE_BYTES) return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return false;
      }
      if (!isWorldSaveData(parsed)) return false;

      return this.restoreWorld(parsed);
    }).catch((err) => {
      console.warn('[SaveSystem] could not read import file', err);
      return false;
    });
  }
}
