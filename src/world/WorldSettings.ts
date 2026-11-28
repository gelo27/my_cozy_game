import type { Season } from './Seasons';

/**
 * Mutable world-wide settings shared by gameplay systems (swimming, fishing, weather...).
 * Editors write here; systems read every frame, so there is no event plumbing to keep in sync.
 */
export const WORLD_SIZE = 512; // metres of terrain, spans [-256, 256] on X and Z
export const WORLD_HALF = WORLD_SIZE / 2;
/** Central waters classified as the farm pond for fishing. */
export const FARM_POND_FISHING_RADIUS = 72;
/** Keep the generated island's shoreline fixed while the underwater map grows around it. */
export const ISLAND_HALF = 256;
/** Keep the open-water buffer beyond the terrain, as in the original world. */
export const WORLD_LIMIT = WORLD_HALF + 260;
/** Sea bed depth beyond the island (the terrain slopes down to it at the coast). */
export const SEA_FLOOR_Y = -128;
export const MIN_SEA_FLOOR_DEPTH = 8;
export const MAX_SEA_FLOOR_DEPTH = -SEA_FLOOR_Y;
export const SEA_BED_COLLIDER_OFFSET = 0.25;

export const worldSettings = {
  /** Global water surface height. Any terrain below it is underwater. */
  waterLevel: -0.6,
  /** Hours 0..24 */
  timeOfDay: 9,
  /** Days passed since the world began (the clock wrapping past midnight adds one). */
  day: 0,
  /** The season; it does not change by itself as days pass (see Seasons.ts). */
  season: 'spring' as Season,
  /** Real seconds per in-game hour; 0 freezes the clock. */
  secondsPerHour: 60,
  /** Global simulation speed for the editor (0 = paused). */
  timeScale: 1,
};

export const isMobileDevice = (): boolean =>
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

/** Camera far plane: phones keep 220 m, PCs see almost the whole island. */
export const VIEW_DISTANCE = isMobileDevice() ? 220 : 420;
/** Fog density multiplier so the haze reaches the same thickness at the far plane on every device. */
export const FOG_SCALE = 220 / VIEW_DISTANCE;
