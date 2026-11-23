// Unit size: 2 meters modular system (Valheim standard)
export const MODULE_SIZE = 2.0;
export const HALF_SIZE = MODULE_SIZE / 2.0; // 1.0m
export const WALL_THICKNESS = 0.16;
export const FLOOR_THICKNESS = 0.12;

/** Bay sill footprint in local X/Z, starting at the rear left jamb. */
export const BAY_FOOTPRINT = [[-1.25, -0.08], [-1.25, 0.08], [-0.72, 0.6],
  [0.72, 0.6], [1.25, 0.08], [1.25, -0.08]] as const;
export const BAY_EAVE_Y = 0.49;
export const BAY_RIDGE_X = 0.62;
