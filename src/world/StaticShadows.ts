import type * as THREE from 'three';
import { TERRAIN_CHUNK, TERRAIN_CHUNKS, TerrainSystem } from './TerrainSystem';
import { WORLD_HALF, isMobileDevice } from './WorldSettings';
import type { PropSystem } from './PropSystem';
import type { ForestZone } from '../forest/ForestZone';
import type { RockField } from '../gathering/RockField';
import type { PropTreeField } from '../gathering/PropTreeField';
import type { BuildingManager } from '../building/BuildingManager';
import type { GrassField } from './GrassField';
import type { AppleOrchard } from '../gathering/AppleOrchard';

/** A round caster (canopy, bush, boulder) of radius `r`; its shadow lies straight below it. */
interface Disc {
  x: number;
  z: number;
  r: number;
  k: number; // darkness 0..1
}

/** A box caster (building piece): its footprint. */
interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  k: number;
}

const S = TERRAIN_CHUNK + 1;
const NCHUNKS = TERRAIN_CHUNKS * TERRAIN_CHUNKS;
/** Soft edge around casters, metres: a caster near a border also touches the next chunk. */
const PAD = 2;
/** Props no grass grows through (radius multiplier of the caster disc). */
const GRASS_BLOCKERS: Record<string, number> = { well: 1.1, hay: 1.1, rock_big: 0.9 };
const PROP_CASTERS: Record<string, { r: number; k: number }> = {
  tree_pine: { r: 1.8, k: 0.55 },
  tree_round: { r: 2.9, k: 0.6 },
  bush: { r: 0.8, k: 0.4 },
  rock_big: { r: 1.2, k: 0.45 },
  well: { r: 1.0, k: 0.4 },
  hay: { r: 0.85, k: 0.35 },
};

/**
 * Static shadows of static objects baked into the terrain's vertices (one byte per 1 m vertex).
 *
 * No shadow maps and no dependence on the sun: trees, bushes, boulders, ore rocks, the forest and
 * building pieces darken the ground straight below them (soft discs and boxes), uploaded as a
 * vertex attribute the terrain shader multiplies the direct light by. A chunk is rebaked only when
 * the casters over it change (a tree felled or regrown, a rock mined, a piece built), a couple of
 * chunks per frame; the rest of the time this costs nothing.
 */
export class StaticShadows {
  public enabled = true;
  /** Statistics for the dev tools. */
  public readonly stats = { casters: 0, chunksBaked: 0, ms: 0 };

  /** Discs / boxes cast shade; `blocks` are footprints the 3D grass must not poke through. */
  private readonly buckets: { discs: Disc[]; boxes: Box[]; blocks: Box[] }[] = Array.from({ length: NCHUNKS }, () => ({ discs: [], boxes: [], blocks: [] }));
  /** Receives each baked chunk's shade and grass blockers. */
  public grass: GrassField | null = null;
  /** Player-planted apple trees (their canopies shade the ground like the oaks'). */
  public orchard: AppleOrchard | null = null;
  private readonly blockBuf = new Uint8Array(S * S);
  /** Per-chunk fingerprint of its casters at the last bake (NaN = never baked). */
  private readonly baked = new Float64Array(NCHUNKS).fill(NaN);
  private readonly queue: number[] = [];
  private readonly buf = new Uint8Array(S * S);
  private readonly fbuf = new Float32Array(S * S);
  private casterKey = '';
  private checkTimer = 0;
  private readonly perFrame = isMobileDevice() ? 2 : 4;

  constructor(
    private readonly terrain: TerrainSystem,
    private readonly props: PropSystem,
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
      const key = this.computeCasterKey();
      if (key !== this.casterKey) {
        this.casterKey = key;
        this.collectCasters();
        this.queueChanged(focus);
      }
    }
    if (!this.queue.length) return;
    const t0 = performance.now();
    for (let i = 0; i < this.perFrame && this.queue.length; i++) this.bakeChunk(this.queue.shift()!);
    this.stats.ms = performance.now() - t0;
  }

  /** Forces every chunk to rebake on the next update. */
  public invalidate(): void {
    this.casterKey = '';
    this.baked.fill(NaN);
    this.checkTimer = 0;
  }

  private computeCasterKey(): string {
    let trees = 0;
    this.forest.forEachStandingTree(() => trees++);
    let rocks = 0;
    this.rocks.forEachIntact(() => rocks++);
    return `${this.props.revision}|${trees}|${rocks}|${this.buildings.revision}|${this.orchard?.revision ?? 0}`;
  }

  /** Order-independent fingerprint of a chunk's casters. */
  private fingerprint(c: number): number {
    const { discs, boxes, blocks } = this.buckets[c];
    let h = discs.length * 7919 + boxes.length * 104729 + blocks.length * 15485863;
    for (const b of blocks) h += Math.sin(b.x0 * 3.17 + b.z0 * 51.3 + b.x1 * 7.7 + b.z1 * 2.9) * 9871.31;
    for (const d of discs) h += Math.sin(d.x * 12.9898 + d.z * 78.233 + d.r * 37.719 + d.k * 3.1) * 43758.5453;
    for (const b of boxes) h += Math.sin(b.x0 * 12.9898 + b.z0 * 78.233 + b.x1 * 9.17 + b.z1 * 5.71) * 24634.6345;
    return h;
  }

  /** Queues the chunks whose casters changed since their last bake, nearest to the player first. */
  private queueChanged(focus: THREE.Vector3): void {
    const order: { c: number; d: number }[] = [];
    for (let c = 0; c < NCHUNKS; c++) {
      const f = this.fingerprint(c);
      if (f === this.baked[c]) continue;
      this.baked[c] = f;
      const cx = c % TERRAIN_CHUNKS, cz = (c - cx) / TERRAIN_CHUNKS;
      const x = (cx + 0.5) * TERRAIN_CHUNK - WORLD_HALF, z = (cz + 0.5) * TERRAIN_CHUNK - WORLD_HALF;
      order.push({ c, d: (x - focus.x) ** 2 + (z - focus.z) ** 2 });
    }
    order.sort((a, b) => a.d - b.d);
    for (const o of order) if (!this.queue.includes(o.c)) this.queue.push(o.c);
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
      b.blocks.length = 0;
    }
    const addBlock = (box: Box) => this.bucketRange(box.x0, box.z0, box.x1, box.z1, (c) => this.buckets[c].blocks.push(box));
    let n = 0;
    const addDisc = (d: Disc) => {
      n++;
      this.bucketRange(d.x - d.r, d.z - d.r, d.x + d.r, d.z + d.r, (c) => this.buckets[c].discs.push(d));
    };
    for (const p of this.props.list()) {
      const def = PROP_CASTERS[p.type];
      if (!def) continue;
      if ((p.type === 'tree_pine' || p.type === 'tree_round') && this.propTrees.isDown(p.id)) continue;
      addDisc({ x: p.position.x, z: p.position.z, r: def.r * p.scale, k: def.k });
      const br = GRASS_BLOCKERS[p.type];
      if (br) {
        const r = def.r * p.scale * br * 0.7;
        addBlock({ x0: p.position.x - r, z0: p.position.z - r, x1: p.position.x + r, z1: p.position.z + r, k: 1 });
      }
    }
    this.forest.forEachStandingTree((pos) => addDisc({ x: pos.x, z: pos.z, r: 3.4, k: 0.6 }));
    this.orchard?.forEachCanopy((x, z, r) => {
      addDisc({ x, z, r, k: 0.55 });
      // Keep the 3D grass out of the trunk
      const b = r * 0.14;
      addBlock({ x0: x - b, z0: z - b, x1: x + b, z1: z + b, k: 1 });
    });
    this.rocks.forEachIntact((pos, radius) => addDisc({ x: pos.x, z: pos.z, r: radius * 1.1, k: 0.45 }));
    for (const piece of this.buildings.getAllPieces()) {
      const bb = piece.worldBoundingBox;
      if (!bb) continue;
      const ground = this.terrain.getHeight((bb.min.x + bb.max.x) / 2, (bb.min.z + bb.max.z) / 2);
      // Every piece near the ground (floors and paths too) keeps the 3D grass out of its footprint
      if (bb.min.y - ground < 0.6) addBlock({ x0: bb.min.x, z0: bb.min.z, x1: bb.max.x, z1: bb.max.z, k: 1 });
      if (bb.max.y - ground < 0.4) continue; // floors and paths lie on the ground: no shade
      const box: Box = { x0: bb.min.x, z0: bb.min.z, x1: bb.max.x, z1: bb.max.z, k: 0.6 };
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
    const plot = (x: number, z: number, v: number) => {
      const i = (z - oz) * S + (x - ox);
      if (v > f[i]) f[i] = v;
    };

    for (const d of discs) {
      const ext = d.r + 1;
      const x0 = Math.max(Math.ceil(d.x - ext), ox), x1 = Math.min(Math.floor(d.x + ext), ox + TERRAIN_CHUNK);
      const z0 = Math.max(Math.ceil(d.z - ext), oz), z1 = Math.min(Math.floor(d.z + ext), oz + TERRAIN_CHUNK);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const q = Math.hypot(x - d.x, z - d.z) / d.r;
          if (q >= 1) continue;
          // Soft penumbra over the outer 40 %
          const t = Math.min(1, (1 - q) / 0.4);
          plot(x, z, d.k * t * t * (3 - 2 * t));
        }
      }
    }

    for (const b of boxes) {
      const x0 = Math.max(Math.ceil(b.x0 - 1), ox), x1 = Math.min(Math.floor(b.x1 + 1), ox + TERRAIN_CHUNK);
      const z0 = Math.max(Math.ceil(b.z0 - 1), oz), z1 = Math.min(Math.floor(b.z1 + 1), oz + TERRAIN_CHUNK);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          // 1 m soft edge outside the footprint
          const e = Math.min(1, Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.z0 - z, 0, z - b.z1)));
          plot(x, z, b.k * (1 - e));
        }
      }
    }

    const out = this.buf;
    for (let i = 0; i < out.length; i++) out[i] = Math.round(f[i] * 255);
    this.terrain.setChunkShade(c, out);

    if (this.grass) {
      // Grass blockers: the footprint (expanded by half a metre, so no blade leans in), hard edge
      const bl = this.blockBuf;
      bl.fill(0);
      for (const b of this.buckets[c].blocks) {
        const x0 = Math.max(Math.ceil(b.x0 - 0.5), ox), x1 = Math.min(Math.floor(b.x1 + 0.5), ox + TERRAIN_CHUNK);
        const z0 = Math.max(Math.ceil(b.z0 - 0.5), oz), z1 = Math.min(Math.floor(b.z1 + 0.5), oz + TERRAIN_CHUNK);
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) bl[(z - oz) * S + (x - ox)] = 255;
      }
      this.grass.setChunk(c, out, bl);
    }
    this.stats.chunksBaked++;
  }
}
