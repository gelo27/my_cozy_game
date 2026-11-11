/**
 * Mutable world-wide settings shared by gameplay systems (swimming, fishing, weather...).
 * Editors write here; systems read every frame, so there is no event plumbing to keep in sync.
 */
export const WORLD_SIZE = 512; // metres of terrain, spans [-256, 256] on X and Z
export const WORLD_HALF = WORLD_SIZE / 2;
/** Open sea around the island; invisible walls stand this far out, hidden by distance fog. */
export const WORLD_LIMIT = WORLD_HALF + 260;
/** Sea bed depth beyond the island (the terrain slopes down to it at the coast). */
export const SEA_FLOOR_Y = -11;
/** Open-sea bed (visual plane and collider), just under the island's lowest possible terrain. */
export const SEA_BED_TOP = SEA_FLOOR_Y - 0.25;

export const worldSettings = {
  /** Global water surface height. Any terrain below it is underwater. */
  waterLevel: -0.6,
  /** Hours 0..24 */
  timeOfDay: 9,
  /** Days passed since the world began (the clock wrapping past midnight adds one). */
  day: 0,
  /** In-game days in each season (spring, summer, autumn, winter; see Seasons.ts). */
  daysPerSeason: 7,
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
