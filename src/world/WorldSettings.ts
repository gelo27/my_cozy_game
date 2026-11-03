/**
 * Mutable world-wide settings shared by gameplay systems (swimming, fishing, weather...).
 * Editors write here; systems read every frame, so there is no event plumbing to keep in sync.
 */
export const WORLD_SIZE = 128; // metres, world spans [-64, 64] on X and Z
export const WORLD_HALF = WORLD_SIZE / 2;

export const worldSettings = {
  /** Global water surface height. Any terrain below it is underwater. */
  waterLevel: -0.6,
  /** Hours 0..24 */
  timeOfDay: 9,
  /** Real seconds per in-game hour; 0 freezes the clock. */
  secondsPerHour: 60,
  /** Global simulation speed for the editor (0 = paused). */
  timeScale: 1,
};

export const isMobileDevice = (): boolean =>
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
