import { WaterPaintMask } from './WaterPaintMask';

// One byte per metre of the island. Linear filtering softens the edges of a painted area.
export const POND_TINT_RES = 512;
export const pondTint = new WaterPaintMask(POND_TINT_RES, true);
