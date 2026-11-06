import * as THREE from 'three';
import riversJson from './rivers.json';
import { WORLD_HALF, WORLD_SIZE, worldSettings } from '../WorldSettings';
import { islandHeight } from '../IslandGenerator';
import { BANK, lakeEdgeDistance, sampleLake, sampleRiver, type WaterNear } from './RiverSpline';
import type { RiverDef, SampledRiver } from './RiverTypes';

const N = WORLD_SIZE;
const V = N + 1;

/** Inclusive rectangle of terrain vertex indices. */
export interface GridRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export function unionRect(a: GridRect | null, b: GridRect | null): GridRect | null {
  if (!a) return b;
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), z1: Math.max(a.z1, b.z1) };
}

function smoothstep(x: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Every river on the island, shared by terrain generation, rendering and gameplay queries:
 * - samples each river's spline into a surface profile (lazily, on the natural terrain);
 * - carves channels, banks, levees and gorges into the generated heights (`computeRegion`);
 * - keeps a per-vertex water surface grid so `waterLevelAt` is one array read, used by swimming,
 *   fishing, the map and props instead of the single sea level;
 * - keeps a small half-float texture (surface, weight) for the terrain shader's wet banks.
 */
class RiverWorld {
  public defs: RiverDef[];
  /** Natural heights (no rivers), metres, set by the terrain on first generation. */
  private natural: Float32Array | null = null;
  private readonly sampled = new Map<string, SampledRiver>();
  /** Water surface where a river holds water, NaN elsewhere. */
  public readonly surface = new Float32Array(V * V).fill(NaN);
  /** Water depth over the generated bed, and the current (m/s, XZ), where `surface` is set. */
  private readonly depth = new Float32Array(V * V);
  private readonly flowX = new Float32Array(V * V);
  private readonly flowZ = new Float32Array(V * V);
  /** Terrain shader data: R = surface (dilated past the banks), G = 0..1 weight. */
  private readonly shadeData = new Uint16Array(V * V * 2);
  public readonly texture: THREE.DataTexture;
  /** Bumped on every change (meshes, map, helpers redraw lazily). */
  public revision = 0;

  constructor(defs: RiverDef[]) {
    this.defs = defs;
    this.texture = new THREE.DataTexture(this.shadeData, V, V, THREE.RGFormat, THREE.HalfFloatType);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  // ---------------------------------------------------------------- queries

  /** Still water underground (cave pools): surface at a 3D point, NaN where there is none. */
  public caveWater: ((x: number, y: number, z: number) => number) | null = null;

  /** Cave pool surface at a 3D point, or NaN (no cave water there). */
  public caveLevelAt(x: number, y: number, z: number): number {
    return this.caveWater ? this.caveWater(x, y, z) : NaN;
  }

  /**
   * Water surface for something at a 3D point: a cave pool when it is in one, else the sea or a
   * river. Use this for the player and camera (pools sit above dry tunnels in the same column).
   */
  public waterLevelAt3(x: number, y: number, z: number): number {
    const c = this.caveWater ? this.caveWater(x, y, z) : NaN;
    return Number.isNaN(c) ? this.waterLevelAt(x, z) : c;
  }

  /** Water surface at a point: the sea, or a river where one holds water. */
  public waterLevelAt(x: number, z: number): number {
    const sea = worldSettings.waterLevel;
    const s = this.riverSurfaceAt(x, z);
    return s > sea ? s : sea;
  }

  /** River surface at a point, NaN outside every river. */
  public riverSurfaceAt(x: number, z: number): number {
    const g = this.cell(x, z);
    return g < 0 ? NaN : this.surface[g];
  }

  /** Depth of river water over its generated bed (0 outside rivers). */
  public depthAt(x: number, z: number): number {
    const g = this.cell(x, z);
    return g < 0 || Number.isNaN(this.surface[g]) ? 0 : this.depth[g];
  }

  /** River current at a point (m/s); zero outside rivers. */
  public flowAt(x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
    const g = this.cell(x, z);
    const wet = g >= 0 && !Number.isNaN(this.surface[g]);
    out.x = wet ? this.flowX[g] : 0;
    out.z = wet ? this.flowZ[g] : 0;
    return out;
  }

  private cell(x: number, z: number): number {
    const ix = Math.round(x + WORLD_HALF);
    const iz = Math.round(z + WORLD_HALF);
    return ix < 0 || iz < 0 || ix > N || iz > N ? -1 : iz * V + ix;
  }

  /** Natural ground (no rivers): what auto surfaces follow. */
  public naturalAt(x: number, z: number): number {
    const h = this.natural;
    if (!h) return islandHeight(x, z);
    const fx = Math.min(N, Math.max(0, x + WORLD_HALF));
    const fz = Math.min(N, Math.max(0, z + WORLD_HALF));
    const ix = Math.min(Math.floor(fx), N - 1);
    const iz = Math.min(Math.floor(fz), N - 1);
    const tx = fx - ix, tz = fz - iz;
    const a = h[iz * V + ix], b = h[iz * V + ix + 1], c = h[(iz + 1) * V + ix], d = h[(iz + 1) * V + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  public get(id: string): SampledRiver | undefined {
    const def = this.defs.find((d) => d.id === id);
    if (!def) return undefined;
    let s = this.sampled.get(id);
    if (!s || s.def !== def) {
      this.computing.add(id);
      try {
        const ground = (x: number, z: number) => this.naturalAt(x, z);
        s =
          def.kind === 'lake'
            ? sampleLake(def, ground, worldSettings.waterLevel)
            : sampleRiver(def, ground, worldSettings.waterLevel, (x, z) => this.waterNear(x, z, id));
      } finally {
        this.computing.delete(id);
      }
      this.sampled.set(id, s);
    }
    return s;
  }

  /** Rivers being sampled right now (a branch asks its parent; never the other way round too). */
  private readonly computing = new Set<string>();

  /**
   * The nearest other water around (x, z): a lake, or another river's channel, with the signed
   * distance to its edge (negative inside). Lakes never depend on rivers, so they are always safe
   * to ask; a river being sampled is skipped (a branch asks its parent, not the other way round).
   */
  private waterNear(x: number, z: number, self: string): WaterNear | null {
    let best: WaterNear | null = null;
    for (const d of this.defs) {
      if (d.id === self || this.computing.has(d.id)) continue;
      const o = this.get(d.id);
      if (!o || x < o.minX || x > o.maxX || z < o.minZ || z > o.maxZ) continue;
      if (o.lake) {
        const edge = lakeEdgeDistance(o.lake.xs, o.lake.zs, x, z);
        if (!best || edge < best.edge) best = { id: d.id, s: o.lake.level, edge, hw: 50, lake: true };
        continue;
      }
      if (o.samples.length < 2 || d.kind === 'lake') continue;
      let bk = -1;
      let bd = Infinity;
      const S = o.samples;
      for (let k = 0; k < S.length; k++) {
        const q = S[k];
        const dx = q.x - x, dz = q.z - z;
        const e = Math.sqrt(dx * dx + dz * dz) - q.hw;
        if (e < bd) {
          bd = e;
          bk = k;
        }
      }
      if (bk >= 0 && (!best || bd < best.edge)) best = { id: d.id, s: S[bk].s, edge: bd, hw: S[bk].hw, lake: false };
    }
    return best;
  }

  /** Rivers re-sampled by the last `invalidate` / `remove` (their meshes need rebuilding). */
  public lastChanged: string[] = [];

  public all(): SampledRiver[] {
    return this.defs.map((d) => this.get(d.id)!);
  }

  // ---------------------------------------------------------------- editing

  public setNatural(heights: Float32Array): void {
    this.natural = heights;
    this.sampled.clear();
  }

  /** Re-samples one river after its def changed; returns the terrain area to regenerate. */
  public invalidate(id: string): GridRect | null {
    return this.resample([id], null);
  }

  public remove(id: string): GridRect | null {
    const old = this.sampled.get(id) ?? this.get(id);
    this.defs = this.defs.filter((d) => d.id !== id);
    this.sampled.delete(id);
    // Whatever joined it or crossed its area loses that attachment
    return this.resample([], old ? this.rectOf(old) : null);
  }

  /**
   * Re-samples rivers, then every river whose area overlaps what they covered before or after
   * (branches, tributaries, rivers through a lake: they may attach, detach or change level).
   * Lakes only change when edited themselves. Returns the terrain area to regenerate.
   */
  private resample(ids: string[], rect: GridRect | null): GridRect | null {
    const changed = new Set(ids);
    const queue = [...ids];
    const overlaps = (o: SampledRiver, r: GridRect) => {
      const a = this.rectOf(o);
      return !!a && a.x0 <= r.x1 && a.x1 >= r.x0 && a.z0 <= r.z1 && a.z1 >= r.z0;
    };
    const spread = (r: GridRect) => {
      for (const d of this.defs) {
        if (changed.has(d.id) || d.kind === 'lake') continue;
        const o = this.get(d.id);
        if (o && overlaps(o, r)) {
          changed.add(d.id);
          queue.push(d.id);
        }
      }
    };
    if (rect) spread(rect);
    while (queue.length) {
      const cur = queue.shift()!;
      const old = this.sampled.get(cur);
      this.sampled.delete(cur);
      const now = this.get(cur);
      const r = unionRect(old ? this.rectOf(old) : null, now ? this.rectOf(now) : null);
      rect = unionRect(rect, r);
      if (r) spread(r);
    }
    this.lastChanged = [...changed];
    this.revision++;
    return rect;
  }

  /** Replaces every river (undo, load); returns the union of old and new areas. */
  public replaceAll(defs: RiverDef[]): GridRect | null {
    let rect: GridRect | null = null;
    for (const s of this.all()) rect = unionRect(rect, this.rectOf(s));
    this.defs = defs;
    this.sampled.clear();
    for (const s of this.all()) rect = unionRect(rect, this.rectOf(s));
    this.revision++;
    return rect;
  }

  public rectOf(s: SampledRiver): GridRect | null {
    if (s.samples.length < 2) return null;
    const x0 = Math.max(0, Math.floor(s.minX + WORLD_HALF));
    const z0 = Math.max(0, Math.floor(s.minZ + WORLD_HALF));
    const x1 = Math.min(N, Math.ceil(s.maxX + WORLD_HALF));
    const z1 = Math.min(N, Math.ceil(s.maxZ + WORLD_HALF));
    return x1 < x0 || z1 < z0 ? null : { x0, z0, x1, z1 };
  }

  // ---------------------------------------------------------------- carving

  /**
   * Generated heights (metres) for a rectangle of vertices: natural terrain with every river
   * carved in. Also rewrites the water surface grid and shader data inside the rectangle.
   * Rivers apply in order; where one meets another's water it only ever cuts, never builds a
   * levee across it, so confluences stay open.
   */
  public computeRegion(rect: GridRect): Float32Array {
    const natural = this.natural!;
    const w = rect.x1 - rect.x0 + 1;
    const h = rect.z1 - rect.z0 + 1;
    const out = new Float32Array(w * h);
    for (let z = 0; z < h; z++) {
      const row = (rect.z0 + z) * V + rect.x0;
      out.set(natural.subarray(row, row + w), z * w);
      this.surface.fill(NaN, row, row + w);
      this.shadeData.fill(0, row * 2, (row + w) * 2);
    }
    const wet = new Uint8Array(w * h);
    const shadeW = new Float32Array(w * h);
    // Lakes first: rivers then only cut into their water, never build levees across it
    const all = this.all();
    for (const pass of [true, false]) {
      for (const river of all) {
        if (!!river.lake !== pass) continue;
        const r = this.rectOf(river);
        if (!r || r.x1 < rect.x0 || r.x0 > rect.x1 || r.z1 < rect.z0 || r.z0 > rect.z1) continue;
        if (river.lake) this.carveLake(river, out, rect, wet, shadeW);
        else if (river.def.kind !== 'lake') this.carveRiver(river, out, rect, wet, shadeW);
      }
    }
    this.texture.needsUpdate = true;
    this.revision++;
    return out;
  }

  private carveRiver(river: SampledRiver, out: Float32Array, rect: GridRect, wet: Uint8Array, shadeW: Float32Array): void {
    const S = river.samples;
    const r = this.rectOf(river)!;
    const levees = river.def.levees !== false;
    const sea = worldSettings.waterLevel;
    const bx0 = Math.max(rect.x0, r.x0), bz0 = Math.max(rect.z0, r.z0);
    const bx1 = Math.min(rect.x1, r.x1), bz1 = Math.min(rect.z1, r.z1);
    const bw = bx1 - bx0 + 1, bh = bz1 - bz0 + 1;
    const bestD = new Float32Array(bw * bh).fill(Infinity);
    const bestK = new Int32Array(bw * bh);
    const bestT = new Float32Array(bw * bh);

    // Nearest centre-line segment for every vertex near the river
    for (let k = 0; k < S.length - 1; k++) {
      const a = S[k], b = S[k + 1];
      const R = Math.max(a.hw, b.hw) + BANK;
      const cx0 = Math.max(bx0, Math.floor(Math.min(a.x, b.x) - R + WORLD_HALF));
      const cx1 = Math.min(bx1, Math.ceil(Math.max(a.x, b.x) + R + WORLD_HALF));
      const cz0 = Math.max(bz0, Math.floor(Math.min(a.z, b.z) - R + WORLD_HALF));
      const cz1 = Math.min(bz1, Math.ceil(Math.max(a.z, b.z) + R + WORLD_HALF));
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = Math.max(1e-6, dx * dx + dz * dz);
      for (let iz = cz0; iz <= cz1; iz++) {
        const pz = iz - WORLD_HALF;
        for (let ix = cx0; ix <= cx1; ix++) {
          const px = ix - WORLD_HALF;
          let t = ((px - a.x) * dx + (pz - a.z) * dz) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = a.x + dx * t - px, ez = a.z + dz * t - pz;
          const d2 = ex * ex + ez * ez;
          const j = (iz - bz0) * bw + ix - bx0;
          if (d2 < bestD[j]) {
            bestD[j] = d2;
            bestK[j] = k;
            bestT[j] = t;
          }
        }
      }
    }

    const ow = rect.x1 - rect.x0 + 1;
    for (let iz = bz0; iz <= bz1; iz++) {
      for (let ix = bx0; ix <= bx1; ix++) {
        const j = (iz - bz0) * bw + ix - bx0;
        if (bestD[j] === Infinity) continue;
        const d = Math.sqrt(bestD[j]);
        const a = S[bestK[j]], b = S[bestK[j] + 1], t = bestT[j];
        const s = a.s + (b.s - a.s) * t;
        const hw = a.hw + (b.hw - a.hw) * t;
        const dep = a.depth + (b.depth - a.depth) * t;
        // Estuary weight: 0 upstream, 1 at the shoreline and beyond
        const e = Math.min(1, a.mouth + (b.mouth - a.mouth) * t);
        const R = hw + BANK;
        if (d > R + 6) continue;
        const i = (iz - rect.z0) * ow + ix - rect.x0;
        const g = iz * V + ix;

        if (d <= R) {
          const cur = out[i];
          let y: number;
          if (d <= hw) {
            // Rounded channel bed, deepest in the middle
            const q = d / hw;
            y = s - dep * (1 - q * q) - 0.02;
            if (wet[i]) y = Math.min(y, cur);
            // At the mouth the bed only ever deepens: it never builds up the sea floor
            if (cur < y) y += (cur - y) * e;
          } else {
            // Banks: cut down where the ground is higher, raise a low levee where it is lower.
            // Toward the mouth the banks flatten into broad sandy shores, and no levee is ever
            // built on ground that already lies under the sea or a lake.
            const x = d - hw;
            const cut = s + x * 0.6 * (1 - 0.65 * e) + Math.max(0, x - 4) ** 2 * 0.15 * (1 - 0.7 * e);
            const raise = levees && !wet[i] && cur > sea - 0.05 && e < 1;
            const levee = s + 0.25 * (1 - e) - Math.max(0, x - 1.5) * 0.5;
            y = Math.min(raise ? Math.max(cur, levee) : cur, cut);
            y += (cur - y) * smoothstep(d, R - 3, R);
          }
          out[i] = y;
          if (d <= hw + 0.9) {
            wet[i] = 1;
            const old = this.surface[g];
            // Equal levels (a river crossing a lake): the lake's still water stays
            if (!(old >= s - 1e-3)) {
              this.surface[g] = s;
              this.depth[g] = Math.max(0, s - y);
              // Current: faster on steep stretches, slack near the banks
              const slope = (a.s - b.s) / Math.max(0.3, b.dist - a.dist);
              const speed = (0.6 + Math.min(2.4, slope * 4)) * (1 - Math.min(1, d / (hw + 0.9)) * 0.6);
              this.flowX[g] = (a.tx + (b.tx - a.tx) * t) * speed;
              this.flowZ[g] = (a.tz + (b.tz - a.tz) * t) * speed;
            }
          }
        }

        // Shader data: weight fades out past the banks, the surface reaches a little further so
        // bilinear filtering near the fade never mixes in empty texels
        const sw = 1 - smoothstep(d, hw + 2.5, hw + 4);
        if (sw >= shadeW[i]) {
          if (sw > 0 || shadeW[i] === 0) this.shadeData[g * 2] = THREE.DataUtils.toHalfFloat(s);
          if (sw > 0) {
            shadeW[i] = sw;
            this.shadeData[g * 2 + 1] = THREE.DataUtils.toHalfFloat(sw);
          }
        }
      }
    }
  }

  /**
   * A lake: flat water inside the outline with a shelving bed, banks cut down around it (and a low
   * levee where the ground outside is lower, unless levees are off). Distances come from the
   * shoreline segments; inside/outside from scanline crossings, row by row.
   */
  private carveLake(lake: SampledRiver, out: Float32Array, rect: GridRect, wet: Uint8Array, shadeW: Float32Array): void {
    const L = lake.lake!;
    const r = this.rectOf(lake)!;
    const level = L.level;
    const depth = lake.def.depth;
    const levees = lake.def.levees !== false;
    const sea = worldSettings.waterLevel;
    const xs = L.xs, zs = L.zs, n = xs.length;
    const bx0 = Math.max(rect.x0, r.x0), bz0 = Math.max(rect.z0, r.z0);
    const bx1 = Math.min(rect.x1, r.x1), bz1 = Math.min(rect.z1, r.z1);
    if (bx1 < bx0 || bz1 < bz0) return;
    const bw = bx1 - bx0 + 1, bh = bz1 - bz0 + 1;
    const bestD = new Float32Array(bw * bh).fill(Infinity);
    const R = BANK + 1;
    for (let i = 0; i < n; i++) {
      const ax = xs[i], az = zs[i], bx = xs[(i + 1) % n], bz = zs[(i + 1) % n];
      const cx0 = Math.max(bx0, Math.floor(Math.min(ax, bx) - R + WORLD_HALF));
      const cx1 = Math.min(bx1, Math.ceil(Math.max(ax, bx) + R + WORLD_HALF));
      const cz0 = Math.max(bz0, Math.floor(Math.min(az, bz) - R + WORLD_HALF));
      const cz1 = Math.min(bz1, Math.ceil(Math.max(az, bz) + R + WORLD_HALF));
      const dx = bx - ax, dz = bz - az;
      const len2 = Math.max(1e-6, dx * dx + dz * dz);
      for (let iz = cz0; iz <= cz1; iz++) {
        const pz = iz - WORLD_HALF;
        for (let ix = cx0; ix <= cx1; ix++) {
          const px = ix - WORLD_HALF;
          let t = ((px - ax) * dx + (pz - az) * dz) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = ax + dx * t - px, ez = az + dz * t - pz;
          const d2 = ex * ex + ez * ez;
          const j = (iz - bz0) * bw + ix - bx0;
          if (d2 < bestD[j]) bestD[j] = d2;
        }
      }
    }
    const ow = rect.x1 - rect.x0 + 1;
    const cross: number[] = [];
    const shelf = Math.max(2.5, depth * 3.5);
    for (let iz = bz0; iz <= bz1; iz++) {
      const pz = iz - WORLD_HALF;
      cross.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        if (zs[j] > pz !== zs[i] > pz) cross.push(xs[j] + ((pz - zs[j]) * (xs[i] - xs[j])) / (zs[i] - zs[j]));
      }
      cross.sort((a, b) => a - b);
      let c = 0;
      for (let ix = bx0; ix <= bx1; ix++) {
        const px = ix - WORLD_HALF;
        while (c < cross.length && cross[c] <= px) c++;
        const inside = (c & 1) === 1;
        const d = Math.sqrt(bestD[(iz - bz0) * bw + ix - bx0]);
        const sd = inside ? -d : d;
        if (sd > R) continue;
        const i = (iz - rect.z0) * ow + ix - rect.x0;
        const g = iz * V + ix;
        const cur = out[i];
        let y: number;
        if (sd <= 0) {
          // Shelving bed: shallow at the shore, full depth a few metres in
          y = Math.min(cur, level - 0.12 - (depth - 0.12) * smoothstep(-sd, 0, shelf));
        } else {
          const x = sd;
          const cut = level + 0.12 + x * 0.5 + Math.max(0, x - 4) ** 2 * 0.12;
          const raise = levees && !wet[i] && cur > sea - 0.05;
          const levee = level + 0.25 - Math.max(0, x - 1.5) * 0.5;
          y = Math.min(raise ? Math.max(cur, levee) : cur, cut);
          y += (cur - y) * smoothstep(x, BANK - 3, BANK);
        }
        out[i] = y;
        if (sd <= 0.9) {
          wet[i] = 1;
          if (!(this.surface[g] > level)) {
            this.surface[g] = level;
            this.depth[g] = Math.max(0, level - y);
            this.flowX[g] = 0;
            this.flowZ[g] = 0;
          }
        }
        const sw = 1 - smoothstep(Math.max(0, sd), 2.5, 4);
        if (sw >= shadeW[i]) {
          if (sw > 0 || shadeW[i] === 0) this.shadeData[g * 2] = THREE.DataUtils.toHalfFloat(level);
          if (sw > 0) {
            shadeW[i] = sw;
            this.shadeData[g * 2 + 1] = THREE.DataUtils.toHalfFloat(sw);
          }
        }
      }
    }
  }
}

export const riverWorld = new RiverWorld(riversJson as RiverDef[]);

/** Water surface at a point (sea or river). The one function gameplay should ask. */
export function waterLevelAt(x: number, z: number): number {
  return riverWorld.waterLevelAt(x, z);
}

/** Pretty JSON for rivers.json: one point per line, so diffs stay readable. */
export function stringifyRivers(defs: RiverDef[]): string {
  const round = (v: number) => Math.round(v * 100) / 100;
  const point = (p: RiverDef['points'][number]) => {
    const o: Record<string, number> = { x: round(p.x), z: round(p.z) };
    if (p.y !== undefined) o.y = round(p.y);
    if (p.w !== undefined) o.w = round(p.w);
    if (p.d !== undefined) o.d = round(p.d);
    if (p.fall) o.fall = round(p.fall);
    if (p.bulge !== undefined) o.bulge = round(p.bulge);
    return JSON.stringify(o);
  };
  const river = (d: RiverDef) =>
    `  {\n    "id": ${JSON.stringify(d.id)},\n    "name": ${JSON.stringify(d.name)},\n${d.kind ? `    "kind": ${JSON.stringify(d.kind)},\n` : ''}${d.level !== undefined ? `    "level": ${round(d.level)},\n` : ''}    "width": ${round(d.width)},\n    "depth": ${round(d.depth)},${d.levees === false ? '\n    "levees": false,' : ''}\n    "points": [\n${d.points.map((p) => `      ${point(p)}`).join(',\n')}\n    ]\n  }`;
  return defs.length ? `[\n${defs.map(river).join(',\n')}\n]\n` : '[]\n';
}
