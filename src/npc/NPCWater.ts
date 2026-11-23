import { CHARACTER_CONFIG, WATER_FOG_CONFIG, WATER_PHYSICS_CONFIG } from '../config/constants';
import { riverWorld } from '../world/rivers/RiverWorld';

const BODY_TO_FEET = CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT + CHARACTER_CONFIG.CAPSULE_RADIUS;

/** Surface in the NPC's world volume, or NaN outside the water bounds. */
export function npcWaterLevel(x: number, y: number, z: number): number {
  const cave = riverWorld.caveLevelAt(x, y, z);
  if (Number.isFinite(cave)) return cave;
  if (x < WATER_FOG_CONFIG.BOUNDS_MIN_X || x > WATER_FOG_CONFIG.BOUNDS_MAX_X ||
      z < WATER_FOG_CONFIG.BOUNDS_MIN_Z || z > WATER_FOG_CONFIG.BOUNDS_MAX_Z || y < -28) return NaN;
  return riverWorld.waterLevelAt(x, z);
}

export function npcSwimDepth(x: number, y: number, z: number, swimming: boolean): number {
  const river = Number.isNaN(riverWorld.caveLevelAt(x, y, z)) && !Number.isNaN(riverWorld.riverSurfaceAt(x, z));
  const water = WATER_PHYSICS_CONFIG;
  if (river) return swimming ? water.RIVER_SWIM_DEPTH_EXIT : water.RIVER_SWIM_DEPTH_ENTER;
  return swimming ? water.WADE_DEPTH_EXIT : water.WADE_DEPTH_ENTER;
}

/** Navigation height at the soles of the floating capsule. */
export function npcSwimFeet(level: number): number {
  return level - WATER_PHYSICS_CONFIG.SWIM_SURFACE_OFFSET - BODY_TO_FEET;
}

/** The real floor in shallows, or the virtual floor for a surface swimmer. */
export function npcWaterPathHeight(x: number, z: number, refY: number, floorY: number): number {
  const bodyY = refY + BODY_TO_FEET;
  const level = npcWaterLevel(x, bodyY, z);
  if (!Number.isFinite(level) || floorY >= level) return NaN;
  const swimY = npcSwimFeet(level);
  if (!Number.isFinite(floorY) && Math.abs(swimY - refY) > 1.2) return NaN;
  return level - floorY >= npcSwimDepth(x, bodyY, z, false) ? swimY : floorY;
}
