import * as THREE from 'three';
import type { BuildingManager } from '../building/BuildingManager';
import type { FarmingManager } from '../farming/FarmingManager';
import type { AppleOrchard } from '../gathering/AppleOrchard';
import type { PropTreeField } from '../gathering/PropTreeField';
import type { RockField } from '../gathering/RockField';
import { t } from '../i18n/i18n';
import { GridNavigator } from '../navigation/GridNavigator';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { PropSystem } from '../world/PropSystem';
import type { TerrainSystem } from '../world/TerrainSystem';
import { worldSettings } from '../world/WorldSettings';
import { riverWorld } from '../world/rivers/RiverWorld';
import { CompanionNPC } from './CompanionNPC';
import { FarmStorage, STORAGE_CHEST } from './FarmStorage';
import { npcWaterPathHeight } from './NPCWater';
import { TaskBoard, type Items } from './TaskBoard';
import { WorkerManager } from './WorkerManager';

interface FarmSettlementDependencies {
  physics: PhysicsWorld;
  scene: THREE.Scene;
  buildingManager: BuildingManager;
  terrain: TerrainSystem;
  props: PropSystem;
  farmingManager: FarmingManager;
  propTrees: PropTreeField;
  rocks: RockField;
  orchard: AppleOrchard;
  giveResources(items: Items): void;
  onWarning(text: string): void;
}

/** Wires the farm's navigation, jobs and shared storage at the scene boundary. */
export function createFarmSettlement({
  physics, scene, buildingManager, terrain, props, farmingManager,
  propTrees, rocks, orchard, giveResources, onWarning,
}: FarmSettlementDependencies) {
  // Villager companion: paths come from a physics-sampled grid that resets when anything is built
  // Props changing one at a time (a felled tree, a placed lamp) only forget the cells around them
  const nav = new GridNavigator(physics, () =>
    `${buildingManager.revision}|${props.solidRevision}|${terrain.revision}|${riverWorld.revision}|${worldSettings.waterLevel}`, {
    cell: 0.5,
    radius: 0.28,
    height: 1.5, // the character capsule is 1.5 m tall
    maxStepUp: 0.45,
    maxDrop: 1.2,
    minFloorY: () => worldSettings.waterLevel - 0.25,
    waterPathHeight: npcWaterPathHeight,
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
  const companion = new CompanionNPC(physics, scene, nav, npcSpawn, t('npc.name'), doorControl);
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
  workers.onNotify = onWarning;
  for (let i = 0; i < 3; i++) workers.spawn(new THREE.Vector3(npcSpawn.x + 2 + i * 1.6, 0, npcSpawn.z + 2.5));
  return { companion, storage, workers };
}
