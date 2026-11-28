import { FIELD_CELLS } from '../farming/FieldManager';
import type { FarmingManager } from '../farming/FarmingManager';
import type { AppleOrchard } from '../gathering/AppleOrchard';
import type { FlowerBeds } from '../gathering/FlowerBeds';
import type { TreeNursery } from '../gathering/TreeNursery';
import type { PropTreeField } from '../gathering/PropTreeField';
import { stripDistanceSq } from '../terrain/TerrainStrip';
import { TREE_TYPES, type PropInstance, type PropSystem } from '../world/PropSystem';
import { HEDGE_TYPE } from '../world/Hedge';
import { riverWorld } from '../world/rivers/RiverWorld';
import type { TerrainSystem } from '../world/TerrainSystem';

interface ClearingSystems {
  terrain: TerrainSystem;
  props: PropSystem;
  propTrees: PropTreeField;
  orchard: AppleOrchard;
  nursery: TreeNursery;
  flowers: FlowerBeds;
  farming: FarmingManager;
  collect: (items: { itemId: string; amount: number }[]) => void;
}

export function createBulldozerClearing({ terrain, props, propTrees, orchard, nursery, flowers, farming, collect }: ClearingSystems) {
  const plants: PropInstance[] = [];
  const items = new Map<string, number>();
  const give = (id: string, amount: number) => items.set(id, (items.get(id) ?? 0) + amount);

  return (ax: number, az: number, bx: number, bz: number, halfWidth: number): void => {
    const dx = bx - ax, dz = bz - az;
    const inverseLengthSq = 1 / (dx * dx + dz * dz);
    if (!Number.isFinite(inverseLengthSq)) return;
    const radiusSq = halfWidth * halfWidth;
    const distanceSq = (x: number, z: number) => stripDistanceSq(x, z, ax, az, dx, dz, inverseLengthSq);
    const dry = (x: number, z: number) => terrain.getHeight(x, z) > riverWorld.waterLevelAt(x, z) + 0.15;
    const covers = (x: number, z: number) => distanceSq(x, z) < radiusSq && dry(x, z);

    const midX = (ax + bx) * 0.5, midZ = (az + bz) * 0.5;
    props.forEachNear(midX, midZ, Math.hypot(dx, dz) * 0.5 + halfWidth, prop => {
      if (!prop.grounded || (prop.type !== 'flowers' && prop.type !== 'couch_grass' && prop.type !== 'bush' &&
          prop.type !== HEDGE_TYPE && !TREE_TYPES.has(prop.type))) return;
      if (covers(prop.position.x, prop.position.z)) plants.push(prop);
    });
    // Removing an instance repacks its batch, so collect candidates before changing it.
    for (const plant of plants) {
      if (plant.type === 'flowers') {
        const item = flowers.pick(plant.id, false);
        if (item) give(item, 1);
      } else if (plant.type === 'couch_grass') {
        props.remove(plant.id);
      } else {
        propTrees.clearForGrading(plant.id, give);
      }
    }
    plants.length = 0;
    orchard.clearForGrading(covers, give);
    nursery.clearForGrading(covers, give);

    farming.fields.forEachInBounds(
      Math.min(ax, bx) - halfWidth, Math.min(az, bz) - halfWidth,
      Math.max(ax, bx) + halfWidth, Math.max(az, bz) + halfWidth,
      field => {
        const x0 = field.gx, z0 = field.gz, x1 = x0 + FIELD_CELLS, z1 = z0 + FIELD_CELLS;
        if (!dry(field.center.x, field.center.z)) return;
        // A rectangle meets the strip at an endpoint, a corner, or by crossing its centreline.
        const nearEndpoint = (x: number, z: number) =>
          Math.max(x0 - x, x - x1, 0) ** 2 + Math.max(z0 - z, z - z1, 0) ** 2 < radiusSq;
        if (nearEndpoint(ax, az) || nearEndpoint(bx, bz) ||
            distanceSq(x0, z0) < radiusSq || distanceSq(x0, z1) < radiusSq ||
            distanceSq(x1, z0) < radiusSq || distanceSq(x1, z1) < radiusSq ||
            crossesField(ax, az, dx, dz, x0, z0, x1, z1)) farming.clearForGrading(field, give);
      },
    );

    // Removed fields restore the tiles they were dug on. Expose soil after that restoration.
    terrain.paintGradedStrip(ax, az, bx, bz, halfWidth);
    if (items.size) {
      const rewards = Array.from(items, ([itemId, amount]) => ({ itemId, amount }));
      items.clear();
      collect(rewards);
    }
  };
}

function crossesField(ax: number, az: number, dx: number, dz: number, x0: number, z0: number, x1: number, z1: number): boolean {
  if ((!dx && (ax < x0 || ax > x1)) || (!dz && (az < z0 || az > z1))) return false;
  const tx0 = dx ? (x0 - ax) / dx : -Infinity, tx1 = dx ? (x1 - ax) / dx : Infinity;
  const tz0 = dz ? (z0 - az) / dz : -Infinity, tz1 = dz ? (z1 - az) / dz : Infinity;
  return Math.max(0, Math.min(tx0, tx1), Math.min(tz0, tz1)) <= Math.min(1, Math.max(tx0, tx1), Math.max(tz0, tz1));
}
