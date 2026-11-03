import { baseIslandHeight, coastRadius } from './IslandGenerator';
import { worldSettings } from './WorldSettings';

export type SiteKind = 'lighthouse' | 'ruins' | 'hut' | 'cave';

/** A landmark picked from the generated terrain. `yaw` is where its front faces (atan2(x, z)). */
export interface IslandSite {
  id: string;
  kind: SiteKind;
  x: number;
  z: number;
  /** Ground height the terrain is levelled to around the site. */
  y: number;
  yaw: number;
  /** Levelled pad radius; the terrain blends back over `padBlend` metres. */
  pad: number;
  padBlend: number;
}

/** Old saves only cover the 128 m farm; landmarks stay well outside it. */
const FARM_CLEAR = 72;

let cache: IslandSite[] | null = null;

/**
 * Deterministic landmark placement on the raw island: a lighthouse on a south-eastern headland,
 * ruins on the highest summit, a hut in quiet hills, and two caves cut into mountain slopes.
 * Searches run once on a coarse grid (a few thousand noise samples).
 */
export function getIslandSites(): IslandSite[] {
  if (cache) return cache;
  const sites: IslandSite[] = [];
  const h = baseIslandHeight;
  const slopeAt = (x: number, z: number) => {
    const dx = h(x + 2, z) - h(x - 2, z);
    const dz = h(x, z + 2) - h(x, z - 2);
    return { gx: dx / 4, gz: dz / 4, mag: Math.hypot(dx, dz) / 4 };
  };

  // Lighthouse: the coastal point that sticks out furthest to sea within the south-east arc
  {
    let best = { score: -Infinity, x: 0, z: 0, a: 0 };
    for (let deg = -20; deg <= 80; deg += 2) {
      const a = (deg * Math.PI) / 180;
      const cx = Math.cos(a), cz = Math.sin(a);
      // Walk inwards from the sea until the ground stands a little above the water
      for (let r = 250; r > 120; r -= 1) {
        const y = h(cx * r, cz * r);
        if (y > worldSettings.waterLevel + 2.2) {
          const score = r - slopeAt(cx * r, cz * r).mag * 20;
          if (score > best.score) best = { score, x: cx * (r - 1), z: cz * (r - 1), a };
          break;
        }
      }
    }
    const y = h(best.x, best.z);
    sites.push({ id: 'lighthouse', kind: 'lighthouse', x: best.x, z: best.z, y: Math.max(y, worldSettings.waterLevel + 2), yaw: Math.atan2(Math.cos(best.a), Math.sin(best.a)), pad: 6, padBlend: 6 });
  }

  // Ruins: the highest summit (the mountains rise to the north-west)
  {
    let best = { y: -Infinity, x: 0, z: 0 };
    for (let z = -220; z <= 220; z += 4) {
      for (let x = -220; x <= 220; x += 4) {
        if (Math.hypot(x, z) > coastRadius(x, z) - 40) continue;
        const y = h(x, z);
        if (y > best.y) best = { y, x, z };
      }
    }
    sites.push({ id: 'ruins', kind: 'ruins', x: best.x, z: best.z, y: best.y - 0.6, yaw: Math.atan2(-best.x, -best.z), pad: 8, padBlend: 7 });
  }

  // Hut: the flattest dry clearing in the eastern hills, away from the coast and the farm
  {
    let best = { score: -Infinity, x: 0, z: 0, y: 0 };
    for (let z = -200; z <= 200; z += 3) {
      for (let x = 0; x <= 220; x += 3) {
        const r = Math.hypot(x, z);
        if (r < 100 || r > coastRadius(x, z) - 45) continue;
        if (z > 0 && x > 0 && Math.atan2(z, x) < 1.2) continue; // leave the lighthouse arc alone
        const y = h(x, z);
        if (y < 1.5 || y > 9) continue;
        const flat = slopeAt(x, z).mag + slopeAt(x + 4, z + 4).mag + slopeAt(x - 4, z - 4).mag;
        const score = -flat * 10 - Math.abs(r - 140) * 0.02;
        if (score > best.score) best = { score, x, z, y };
      }
    }
    sites.push({ id: 'hut', kind: 'hut', x: best.x, z: best.z, y: best.y, yaw: Math.atan2(-best.x, -best.z), pad: 7, padBlend: 6 });
  }

  // Caves: steep mountain flanks facing downhill, high enough to be mountains, spread apart
  {
    const candidates: { score: number; x: number; z: number; y: number; yaw: number }[] = [];
    for (let z = -220; z <= 220; z += 4) {
      for (let x = -220; x <= 220; x += 4) {
        const r = Math.hypot(x, z);
        if (r < FARM_CLEAR + 20 || r > coastRadius(x, z) - 35) continue;
        const y = h(x, z);
        if (y < 5 || y > 15) continue;
        const s = slopeAt(x, z);
        if (s.mag < 0.45 || s.mag > 1.3) continue;
        // The ground in front (downhill) must be walkable so the player can reach the mouth
        const fx = -s.gx / s.mag, fz = -s.gz / s.mag;
        const front = slopeAt(x + fx * 7, z + fz * 7);
        if (front.mag > 0.5) continue;
        candidates.push({ score: s.mag - front.mag - r * 0.002, x, z, y, yaw: Math.atan2(fx, fz) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const picked: typeof candidates = [];
    for (const c of candidates) {
      if (picked.length >= 2) break;
      if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 90)) continue;
      if (sites.some((s) => Math.hypot(s.x - c.x, s.z - c.z) < 40)) continue;
      picked.push(c);
    }
    picked.forEach((c, i) => {
      // The pad sits a little in front of the slope so the arch is half buried in the hill
      const px = c.x + Math.sin(c.yaw) * 2.5;
      const pz = c.z + Math.cos(c.yaw) * 2.5;
      sites.push({ id: `cave${i + 1}`, kind: 'cave', x: px, z: pz, y: h(px, pz) - 0.2, yaw: c.yaw, pad: 3.2, padBlend: 4 });
    });
  }

  cache = sites;
  return sites;
}

/** Blends the terrain toward each site's pad height. */
export function applySitePads(x: number, z: number, y: number): number {
  for (const s of getIslandSites()) {
    const dx = x - s.x, dz = z - s.z;
    const outer = s.pad + s.padBlend;
    const d2 = dx * dx + dz * dz;
    if (d2 > outer * outer) continue;
    const d = Math.sqrt(d2);
    const t = d <= s.pad ? 1 : 1 - (d - s.pad) / s.padBlend;
    const w = t * t * (3 - 2 * t);
    // Cave mouths only cut down into the hill in front, never raise the slope behind
    y = s.kind === 'cave' && y < s.y ? y : y + (s.y - y) * w;
  }
  return y;
}
