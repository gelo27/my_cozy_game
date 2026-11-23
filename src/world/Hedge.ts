/** Square hedge modules share the same placement grid, footprint and collider. */
export const HEDGE_TYPE = 'decorative_bush';
export const HEDGE_TILE = 1.5;
export const HEDGE_HEIGHT = 1.15;

export const snapHedge = (coordinate: number): number => Math.round(coordinate / HEDGE_TILE) * HEDGE_TILE;
