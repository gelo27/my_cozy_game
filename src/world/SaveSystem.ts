import * as THREE from 'three';
import { BuildingSceneExportData } from '../building/types/BuildingTypes';
import { TerrainSaveData } from './TerrainSystem';
import { PropSaveData, MILLSTONE_SPOT, FOREST_VERSION } from './PropSystem';
import { PetSaveData } from '../gameplay/PetSystem';
import { WeatherType } from './WeatherSystem';
import { worldSettings } from './WorldSettings';
import type { GameWorld } from '../engine/GameEngine';
import type { CropState } from '../farming/types/FarmingTypes';
import type { FieldSaveData } from '../farming/FieldManager';
import type { ExplorationSaveData } from '../explore/ExplorationManager';

export const SAVE_VERSION = 2;
const KEY_PREFIX = 'cozyfarm.save.';
export const AUTOSAVE_SLOT = 'auto';

export interface WorldSaveData {
  version: number;
  savedAt: string;
  terrain: TerrainSaveData;
  waterLevel: number;
  timeOfDay: number;
  weather: WeatherType;
  props: PropSaveData[];
  /** Forest generation the props came from (missing = before the denser forests). */
  forest?: number;
  buildings: BuildingSceneExportData | null;
  crops: { x: number; z: number; crop: CropState }[];
  /** Shovel-dug fields (their soil tiles are part of the terrain save). */
  fields?: FieldSaveData[];
  inventory: { items: Record<string, number>; equipped: string | null };
  player: [number, number, number];
  vehicle: { p: [number, number, number]; yaw: number } | null;
  moped?: { p: [number, number, number]; yaw: number };
  boat?: { p: [number, number, number]; yaw: number };
  exploration?: ExplorationSaveData;
  pets: PetSaveData[];
}

export interface SaveSlotInfo {
  slot: string;
  savedAt: string;
  sizeKb: number;
}

/**
 * Whole-world save/load. Slots live in localStorage (terrain is stored as edits over the generated
 * island, so a typical save is ~200-400 KB, mostly props);
 * files can be exported/imported as JSON for sharing levels between developers.
 */
export class SaveSystem {
  constructor(private readonly world: GameWorld) {}

  public capture(): WorldSaveData {
    const w = this.world;
    const items: Record<string, number> = {};
    for (const item of w.inventoryManager.getItems()) items[item.id] = item.count;
    // While riding, the on-foot body is parked under the world: save the player beside the vehicle
    const ride = w.vehicle.isPlayerInside ? w.vehicle : w.moped.isPlayerInside ? w.moped : null;
    // A save made in the caves resumes outside the nearest cave mouth;
    // a save made at sea resumes on the pier
    const p = w.boat.isPlayerInside
      ? w.boat.dock.clone().add(new THREE.Vector3(0, 1.2, 0))
      : ride
      ? ride.getPosition().add(new THREE.Vector3(1.5, 1.2, 0))
      : w.exploration.inCave
        ? w.exploration.savePosition(w.character.getPosition()).add(new THREE.Vector3(0, 1.2, 0))
        : w.character.getPosition();
    const vt = w.vehicle.body.translation();
    const vr = w.vehicle.body.rotation();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(vr.x, vr.y, vr.z, vr.w));
    return {
      version: SAVE_VERSION,
      savedAt: new Date().toISOString(),
      terrain: w.terrain.serialize(),
      waterLevel: worldSettings.waterLevel,
      timeOfDay: worldSettings.timeOfDay,
      weather: w.weather.weather,
      props: w.props.serialize(),
      forest: w.props.forestVersion,
      buildings: w.character.buildAbility?.buildingManager?.exportScene() ?? null,
      crops: w.farmingManager.serializeCrops(),
      fields: w.farmingManager.serializeFields(),
      inventory: { items, equipped: w.inventoryManager.getEquippedItemId() },
      player: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
      vehicle: { p: [vt.x, vt.y + 0.3, vt.z], yaw: Math.atan2(fwd.x, fwd.z) },
      moped: { p: w.moped.getPosition().add(new THREE.Vector3(0, 0.2, 0)).toArray() as [number, number, number], yaw: w.moped.getYaw() },
      boat: { p: w.boat.getPosition().toArray() as [number, number, number], yaw: w.boat.getYaw() },
      pets: w.gameplay.pets.serialize(),
      exploration: w.exploration.serialize(),
    };
  }

  public apply(data: WorldSaveData): void {
    const w = this.world;
    worldSettings.waterLevel = data.waterLevel;
    worldSettings.timeOfDay = data.timeOfDay;
    w.weather.setWeather(data.weather);
    w.terrain.deserialize(data.terrain);
    w.props.deserialize(data.props);
    // Saves from before the millstone existed get one at its usual spot
    w.props.ensureStation('millstone', MILLSTONE_SPOT.x, MILLSTONE_SPOT.z);
    // A save from the old 128 m world now sits in the island's centre: grow nature around it
    w.props.forestVersion = data.forest ?? 0;
    if (w.terrain.expandedFromLegacy) {
      w.props.populateWilderness();
      w.props.forestVersion = 0;
    }
    // Worlds from before the denser forests get the extra trees once (after buildings load)
    if (w.props.forestVersion < FOREST_VERSION) w.props.queueForestUpgrade();
    w.exploration.clearSiteProps();
    w.exploration.deserialize(data.exploration);

    const bm = w.character.buildAbility?.buildingManager;
    if (bm) {
      bm.clear();
      if (data.buildings) bm.importScene(data.buildings);
      bm.flushPendingRegeneration();
    }
    w.farmingManager.deserializeCrops(data.crops ?? []);
    w.farmingManager.deserializeFields(data.fields ?? []);

    const inv = w.inventoryManager;
    for (const item of inv.getItems()) {
      const count = data.inventory.items[item.id];
      if (count === undefined) continue;
      if (count > item.count) inv.addItem(item.id, count - item.count);
      else if (count < item.count) inv.removeItem(item.id, item.count - count);
    }
    if (data.inventory.equipped !== inv.getEquippedItemId()) inv.equipItem(data.inventory.equipped);

    w.character.respawn(new THREE.Vector3(...data.player).add(new THREE.Vector3(0, 0.3, 0)));
    if (data.vehicle) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), data.vehicle.yaw);
      w.vehicle.body.setTranslation({ x: data.vehicle.p[0], y: data.vehicle.p[1], z: data.vehicle.p[2] }, true);
      w.vehicle.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      w.vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
    if (data.moped) w.moped.place(new THREE.Vector3(...data.moped.p), data.moped.yaw);
    if (data.boat) w.boat.place(new THREE.Vector3(...data.boat.p), data.boat.yaw);
    if (data.pets?.length) w.gameplay.pets.deserialize(data.pets);
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
    if (!data) return false;
    this.apply(data);
    return true;
  }

  public static read(slot: string): WorldSaveData | null {
    try {
      const raw = localStorage.getItem(KEY_PREFIX + slot);
      if (!raw) return null;
      const data = JSON.parse(raw) as WorldSaveData;
      return data.version === SAVE_VERSION ? data : null;
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

  public importFile(file: File): Promise<boolean> {
    return file.text().then((text) => {
      try {
        const data = JSON.parse(text) as WorldSaveData;
        if (data.version !== SAVE_VERSION || !data.terrain) return false;
        this.apply(data);
        return true;
      } catch {
        return false;
      }
    });
  }
}
