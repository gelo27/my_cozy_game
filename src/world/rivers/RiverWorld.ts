import * as THREE from 'three';
import riversJson from './rivers.json';
import { WORLD_HALF, WORLD_SIZE, worldSettings } from '../WorldSettings';
import { islandHeight } from '../IslandGenerator';
import { BANK, sampleRiver } from './RiverSpline';
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
      s = sampleRiver(def, (x, z) => this.naturalAt(x, z), worldSettings.waterLevel);
      this.sampled.set(id, s);
    }
    return s;
  }

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
    const old = this.sampled.get(id);
    this.sampled.delete(id);
    const now = this.get(id);
    this.revision++;
    return unionRect(old ? this.rectOf(old) : null, now ? this.rectOf(now) : null);
  }

  public remove(id: string): GridRect | null {
    const old = this.sampled.get(id) ?? this.get(id);
    this.defs = this.defs.filter((d) => d.id !== id);
    this.sampled.delete(id);
    this.revision++;
    return old ? this.rectOf(old) : null;
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
    for (const river of this.all()) {
      const r = this.rectOf(river);
      if (!r || r.x1 < rect.x0 || r.x0 > rect.x1 || r.z1 < rect.z0 || r.z0 > rect.z1) continue;
      this.carveRiver(river, out, rect, wet, shadeW);
    }
    this.texture.needsUpdate = true;
    this.revision++;
    return out;
  }

  private carveRiver(river: SampledRiver, out: Float32Array, rect: GridRect, wet: Uint8Array, shadeW: Float32Array): void {
    const S = river.samples;
    const r = this.rectOf(river)!;
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
          } else {
            // Banks: cut down where the ground is higher, raise a low levee where it is lower
            const x = d - hw;
            const cut = s + x * 0.6 + Math.max(0, x - 4) ** 2 * 0.15;
            const levee = s + 0.25 - Math.max(0, x - 1.5) * 0.5;
            y = Math.min(wet[i] ? cur : Math.max(cur, levee), cut);
            y += (cur - y) * smoothstep(d, R - 3, R);
          }
          out[i] = y;
          if (d <= hw + 0.9) {
            wet[i] = 1;
            const old = this.surface[g];
            if (!(old > s)) {
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
    if (p.fall) o.fall = round(p.fall);
    return JSON.stringify(o);
  };
  const river = (d: RiverDef) =>
    `  {\n    "id": ${JSON.stringify(d.id)},\n    "name": ${JSON.stringify(d.name)},\n    "width": ${round(d.width)},\n    "depth": ${round(d.depth)},\n    "points": [\n${d.points.map((p) => `      ${point(p)}`).join(',\n')}\n    ]\n  }`;
  return defs.length ? `[\n${defs.map(river).join(',\n')}\n]\n` : '[]\n';
}
