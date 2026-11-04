import * as THREE from 'three';
import { TERRAIN_CHUNK, TERRAIN_CHUNKS, TerrainSystem } from './TerrainSystem';
import { WORLD_HALF, isMobileDevice } from './WorldSettings';
import type { PropSystem } from './PropSystem';
import type { WeatherSystem } from './WeatherSystem';
import type { ForestZone } from '../forest/ForestZone';
import type { RockField } from '../gathering/RockField';
import type { PropTreeField } from '../gathering/PropTreeField';
import type { BuildingManager } from '../building/BuildingManager';

/** A round caster: canopy / boulder of radius `r` whose centre is `h` metres above the ground. */
interface Disc {
  x: number;
  z: number;
  r: number;
  h: number;
  k: number; // darkness 0..1
}

/** A box caster (building piece): footprint plus its bottom / top height above the ground. */
interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  hb: number;
  ht: number;
  k: number;
}

const S = TERRAIN_CHUNK + 1;
/** Longest shadow offset considered when bucketing casters into chunks (metres). */
const PAD = 16;
const PROP_CASTERS: Record<string, { r: number; h: number; k: number; base: number }> = {
  tree_pine: { r: 1.5, h: 3.0, k: 0.55, base: 0.25 },
  tree_round: { r: 1.8, h: 3.0, k: 0.6, base: 0.25 },
  bush: { r: 0.75, h: 0.45, k: 0.4, base: 0.3 },
  rock_big: { r: 1.1, h: 0.6, k: 0.45, base: 0.3 },
  well: { r: 1.0, h: 0.9, k: 0.4, base: 0.3 },
  hay: { r: 0.8, h: 0.5, k: 0.35, base: 0.3 },
};

/**
 * Shadows of static objects baked into the terrain's vertices (one byte per 1 m vertex).
 *
 * No shadow maps: trees, bushes, boulders, ore rocks, the forest and building pieces are reduced to
 * discs and boxes, and each chunk's shade is rasterised on the CPU along the current sun (or moon)
 * direction, then uploaded as a vertex attribute the terrain shader multiplies the direct light by.
 * Rebakes happen only when the casters change or the light has turned a few degrees, a few chunks
 * per frame, nearest to the player first, so the cost is spread out and close to zero on average.
 */
export class StaticShadows {
  public enabled = true;
  /** Last bake statistics, for the dev tools. */
  public readonly stats = { casters: 0, chunksBaked: 0, ms: 0 };

  private readonly buckets: { discs: Disc[]; boxes: Box[] }[] = Array.from({ length: TERRAIN_CHUNKS * TERRAIN_CHUNKS }, () => ({ discs: [], boxes: [] }));
  private readonly queue: number[] = [];
  private readonly buf = new Uint8Array(S * S);
  private readonly fbuf = new Float32Array(S * S);
  private readonly bakedDir = new THREE.Vector3(0, -1, 0);
  private readonly light = new THREE.Vector3();
  private casterKey = '';
  private checkTimer = 0;
  private readonly perFrame = isMobileDevice() ? 2 : 4;

  constructor(
    private readonly terrain: TerrainSystem,
    private readonly props: PropSystem,
    private readonly weather: WeatherSystem,
    private readonly forest: ForestZone,
    private readonly rocks: RockField,
    private readonly propTrees: PropTreeField,
    private readonly buildings: BuildingManager
  ) {}

  /** Call once per frame with the player (or vehicle) position. */
  public update(dt: number, focus: THREE.Vector3): void {
    if (!this.enabled) return;
    this.checkTimer -= dt;
    if (this.checkTimer <= 0) {
      this.checkTimer = 0.5;
      // Direction the light travels (from the sky to the ground); low suns are clamped so
      // shadows stay a sensible length at dawn and dusk
      const sun = this.weather.sun;
      this.light.subVectors(sun.target.position, sun.position).normalize();
      if (this.light.y > -0.3) {
        this.light.y = -0.3;
        this.light.normalize();
      }
      const key = this.computeCasterKey();
      const turned = this.light.dot(this.bakedDir) < 0.9995; // ~1.8 degrees
      if (key !== this.casterKey) {
        this.casterKey = key;
        this.collectCasters();
        this.requeue(focus);
      } else if (turned && this.queue.length === 0) {
        this.requeue(focus);
      }
    }
    if (!this.queue.length) return;
    const t0 = performance.now();
    for (let i = 0; i < this.perFrame && this.queue.length; i++) this.bakeChunk(this.queue.shift()!);
    this.stats.ms = performance.now() - t0;
  }

  /** Forces a full rebake on the next update (after a save is loaded, for example). */
  public invalidate(): void {
    this.casterKey = '';
    this.checkTimer = 0;
  }

  private computeCasterKey(): string {
    let felled = 0;
    this.forest.forEachStandingTree(() => felled++);
    let rocks = 0;
    this.rocks.forEachIntact(() => rocks++);
    return `${this.props.revision}|${felled}|${rocks}|${this.buildings.revision}|${this.terrain.revision}`;
  }

  /** Every chunk, nearest to the player first. */
  private requeue(focus: THREE.Vector3): void {
    const order: { c: number; d: number }[] = [];
    for (let c = 0; c < TERRAIN_CHUNKS * TERRAIN_CHUNKS; c++) {
      const cx = c % TERRAIN_CHUNKS, cz = (c - cx) / TERRAIN_CHUNKS;
      const x = (cx + 0.5) * TERRAIN_CHUNK - WORLD_HALF, z = (cz + 0.5) * TERRAIN_CHUNK - WORLD_HALF;
      order.push({ c, d: (x - focus.x) ** 2 + (z - focus.z) ** 2 });
    }
    order.sort((a, b) => a.d - b.d);
    // One light direction for the whole pass, so neighbouring chunks always match
    this.bakedDir.copy(this.light);
    this.queue.length = 0;
    for (const o of order) this.queue.push(o.c);
  }

  private bucketRange(x0: number, z0: number, x1: number, z1: number, fn: (c: number) => void): void {
    const c0x = Math.max(0, Math.floor((x0 - PAD + WORLD_HALF) / TERRAIN_CHUNK));
    const c1x = Math.min(TERRAIN_CHUNKS - 1, Math.floor((x1 + PAD + WORLD_HALF) / TERRAIN_CHUNK));
    const c0z = Math.max(0, Math.floor((z0 - PAD + WORLD_HALF) / TERRAIN_CHUNK));
    const c1z = Math.min(TERRAIN_CHUNKS - 1, Math.floor((z1 + PAD + WORLD_HALF) / TERRAIN_CHUNK));
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) fn(cz * TERRAIN_CHUNKS + cx);
  }

  private collectCasters(): void {
    for (const b of this.buckets) {
      b.discs.length = 0;
      b.boxes.length = 0;
    }
    let n = 0;
    const addDisc = (d: Disc) => {
      n++;
      this.bucketRange(d.x - d.r, d.z - d.r, d.x + d.r, d.z + d.r, (c) => this.buckets[c].discs.push(d));
    };
    for (const p of this.props.list()) {
      const def = PROP_CASTERS[p.type];
      if (!def) continue;
      if ((p.type === 'tree_pine' || p.type === 'tree_round') && this.propTrees.isDown(p.id)) continue;
      const s = p.scale;
      addDisc({ x: p.position.x, z: p.position.z, r: def.r * s, h: def.h * s, k: def.k });
      // Soft contact darkening right at the base, independent of the sun
      addDisc({ x: p.position.x, z: p.position.z, r: def.r * s * 0.6, h: 0, k: def.base });
    }
    this.forest.forEachStandingTree((pos, trunkHeight) => {
      addDisc({ x: pos.x, z: pos.z, r: 3.4, h: trunkHeight * 0.7, k: 0.6 });
      addDisc({ x: pos.x, z: pos.z, r: 1.6, h: 0, k: 0.3 });
    });
    this.rocks.forEachIntact((pos, radius) => {
      addDisc({ x: pos.x, z: pos.z, r: radius * 0.95, h: radius * 0.5, k: 0.45 });
    });
    for (const piece of this.buildings.getAllPieces()) {
      const bb = piece.worldBoundingBox;
      if (!bb) continue;
      const ground = this.terrain.getHeight((bb.min.x + bb.max.x) / 2, (bb.min.z + bb.max.z) / 2);
      const ht = bb.max.y - ground;
      if (ht < 0.4) continue; // floors and paths lie on the ground
      const box: Box = { x0: bb.min.x, z0: bb.min.z, x1: bb.max.x, z1: bb.max.z, hb: Math.max(0, bb.min.y - ground), ht, k: 0.7 };
      n++;
      this.bucketRange(box.x0, box.z0, box.x1, box.z1, (c) => this.buckets[c].boxes.push(box));
    }
    this.stats.casters = n;
  }

  private bakeChunk(c: number): void {
    const cx = c % TERRAIN_CHUNKS, cz = (c - cx) / TERRAIN_CHUNKS;
    const ox = cx * TERRAIN_CHUNK - WORLD_HALF, oz = cz * TERRAIN_CHUNK - WORLD_HALF;
    const f = this.fbuf;
    f.fill(0);
    const { discs, boxes } = this.buckets[c];
    // Ground offset per metre of caster height, along the light
    const L = this.bakedDir;
    const sx = L.x / -L.y, sz = L.z / -L.y;
    const len = Math.hypot(sx, sz);
    const ux = len > 1e-4 ? sx / len : 1, uz = len > 1e-4 ? sz / len : 0;
    // A sphere's shadow is stretched along the light by 1 / sin(elevation)
    const stretch = Math.min(2.5, 1 / -L.y);

    const plot = (x: number, z: number, v: number) => {
      const lx = Math.round(x - ox), lz = Math.round(z - oz);
      if (lx < 0 || lz < 0 || lx >= S || lz >= S) return;
      const i = lz * S + lx;
      if (v > f[i]) f[i] = v;
    };

    for (const d of discs) {
      const cxw = d.x + sx * d.h, czw = d.z + sz * d.h;
      const ra = d.r * (d.h > 0 ? stretch : 1), rb = d.r;
      const ext = Math.max(ra, rb) + 1;
      const x0 = Math.max(Math.ceil(cxw - ext), ox), x1 = Math.min(Math.floor(cxw + ext), ox + TERRAIN_CHUNK);
      const z0 = Math.max(Math.ceil(czw - ext), oz), z1 = Math.min(Math.floor(czw + ext), oz + TERRAIN_CHUNK);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cxw, dz = z - czw;
          const a = (dx * ux + dz * uz) / ra, b = (dz * ux - dx * uz) / rb;
          const q = Math.sqrt(a * a + b * b);
          if (q >= 1) continue;
          // Soft penumbra over the outer 40 %
          const t = Math.min(1, (1 - q) / 0.4);
          plot(x, z, d.k * t * t * (3 - 2 * t));
        }
      }
    }

    for (const b of boxes) {
      // Sweep the footprint from the bottom's shadow to the top's (three steps cover walls / roofs)
      for (let step = 0; step < 3; step++) {
        const h = b.hb + ((b.ht - b.hb) * step) / 2;
        const bx0 = b.x0 + sx * h, bx1 = b.x1 + sx * h, bz0 = b.z0 + sz * h, bz1 = b.z1 + sz * h;
        const x0 = Math.max(Math.ceil(bx0 - 1), ox), x1 = Math.min(Math.floor(bx1 + 1), ox + TERRAIN_CHUNK);
        const z0 = Math.max(Math.ceil(bz0 - 1), oz), z1 = Math.min(Math.floor(bz1 + 1), oz + TERRAIN_CHUNK);
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            // 1 m soft edge outside the footprint
            const ex = Math.max(bx0 - x, 0, x - bx1), ez = Math.max(bz0 - z, 0, z - bz1);
            const e = Math.min(1, Math.hypot(ex, ez));
            plot(x, z, b.k * (1 - e));
          }
        }
      }
    }

    const out = this.buf;
    for (let i = 0; i < out.length; i++) out[i] = Math.round(f[i] * 255);
    this.terrain.setChunkShade(c, out);
    this.stats.chunksBaked++;
  }
}
