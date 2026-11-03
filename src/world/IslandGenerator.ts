import { WORLD_HALF, SEA_FLOOR_Y } from './WorldSettings';
import { applySitePads } from './IslandSites';

/**
 * Deterministic island terrain: the original 128 m farm valley in the middle (unchanged, so old
 * saves line up with it), rolling hills, lakes and a mountain ridge further out, and an uneven
 * coastline with beaches dropping to the sea floor well before the world edge.
 */

function hash(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in [-1, 1]. */
export function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const tx = smooth(x - ix);
  const tz = smooth(z - iz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return ((a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz) * 2 - 1;
}

/** Four-octave fractal noise, roughly in [-1, 1]. */
export function fbm(x: number, z: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < 4; i++) {
    sum += valueNoise(x * f + i * 17.3, z * f - i * 9.1) * amp;
    f *= 2.03;
    amp *= 0.5;
  }
  return sum / 0.9375;
}

function smoothstep(x: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Radius of the shoreline in a direction (m): ~180-225, never reaching the world edge. */
export function coastRadius(x: number, z: number): number {
  const a = Math.atan2(z, x);
  return WORLD_HALF * 0.79 + fbm(Math.cos(a) * 1.6 + 3.1, Math.sin(a) * 1.6 - 1.7) * 26;
}

/** Natural terrain before landmarks level their pads. */
export function baseIslandHeight(x: number, z: number): number {
  const r = Math.sqrt(x * x + z * z);

  // Original world: flat farm in the middle, rolling hills toward its old edges, fishing pond
  const edge = smoothstep(r, 42, 62);
  const hills = (Math.sin(x * 0.11) * Math.cos(z * 0.09) * 0.5 + 0.5) * 5 + Math.sin(x * 0.27 + z * 0.19) * 0.6;
  const outer = smoothstep(r, 64, 115);
  // The old sine hills fade out beyond the old world so they don't repeat across the island
  let y = edge * hills * (1 - outer * 0.75);
  const px = x - 30;
  const pz = z - 28;
  const pd = Math.sqrt(px * px * 0.8 + pz * pz) / 10;
  if (pd < 1.4) y = Math.min(y, -2.6 * (1 - smoothstep(pd, 0.55, 1.4)));

  // New lands beyond the old edge: broad hills, a few lakes, mountains toward the north-west
  if (outer > 0) {
    const n = fbm(x * 0.009, z * 0.009);
    const rolling = (fbm(x * 0.022 - 5.2, z * 0.022 + 8.4) * 0.5 + 0.5) * 4.5;
    const ridge = 1 - Math.abs(fbm(x * 0.006 + 7.3, z * 0.006 - 2.1));
    const mountainZone = smoothstep(-(x + z) * 0.7071, 10, 110);
    const mountains = ridge * ridge * 19 * mountainZone * smoothstep(r, 90, 150);
    const lakes = Math.min(0, n + 0.36) * 12;
    y += outer * (n * 2.5 + rolling + mountains + lakes);
  }

  // Coast: beach slope down to the sea floor
  const coast = coastRadius(x, z);
  const sea = smoothstep(r, coast - 26, coast + 22);
  y = y * (1 - sea) + SEA_FLOOR_Y * sea;
  return Math.max(-12, Math.min(24, y));
}

/** Final generated terrain: the natural island with landmark pads levelled in. */
export function islandHeight(x: number, z: number): number {
  return Math.max(-12, Math.min(24, applySitePads(x, z, baseIslandHeight(x, z))));
}
