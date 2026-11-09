import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import type { ExtraLight } from '../../world/NightLighting';
import { STRUCTURE_MATERIALS } from '../StructureBuilder';
import {
  planCaveNetwork, meshCaveChunks, chunkEntranceDistance, CaveGenRequest, CaveGenOutput, CaveEntranceIn, CaveChunk, CaveLayout, Box,
  CavePlan, CaveMeshJob, CaveMeshResult, CRYSTAL_COLORS,
} from './CaveGen';
import { caveCacheKey, loadCaveCache, CaveCacheWriter } from './CaveCache';
import { createCaveRockMaterial, createCaveWaterMaterial, caveUniforms } from './CaveMaterial';
import { CaveDrips } from './CaveDrips';

/** Chunks farther than this from the player are hidden (the cave fog swallows them long before). */
const VIEW_RADIUS = 62;
const LIGHT_BUCKET = 32;
/** Colliders built per frame in the background once the mesh data has arrived. */
const COLLIDERS_PER_FRAME = 6;
/** Chunks within this distance of an entrance spawn are meshed first (the network is enterable then). */
const PRIORITY_RADIUS = 40;
/** Chunks per worker job after the priority ones. */
const SLICE = 20;

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  /** Build revision whose layout this worker holds (it is sent once per worker per build). */
  rev: number;
  onReply: ((r: WorkerReply) => void) | null;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  plan?: CavePlan;
  mesh?: CaveMeshResult;
  error?: string;
}

interface BuildState {
  gen: number;
  rev: number;
  req: CaveGenRequest;
  plan: CavePlan;
  queue: { keys: number[]; priority: boolean }[];
  running: number;
  priorityLeft: number;
  t0: number;
  triangles: number;
  chunks: number;
  cache: CaveCacheWriter | null;
}

interface ChunkView {
  key: number;
  mesh: THREE.Mesh;
  center: THREE.Vector3;
  radius: number;
  data: CaveChunk | null;
  body: RAPIER.RigidBody | null;
}

export interface CaveEntranceWorld {
  id: string;
  /** Exit prompt spot (feet height). */
  mouth: THREE.Vector3;
  spawn: THREE.Vector3;
  yaw: number;
  underwater: boolean;
}

export interface CaveContentsWorld {
  chests: { id: string; pos: THREE.Vector3; yaw: number }[];
  ores: { pos: THREE.Vector3; kind: CaveGenOutput['ores'][number]['kind'] }[];
  mushrooms: THREE.Vector3[];
}

/**
 * The island-wide cave network on the main thread: generated in a worker, then turned into chunk
 * meshes (one shared shader), water, glowing crystals and embers, entrance torches, colliders
 * (spread over frames) and a light list bucketed by area. Lives in its own pocket of the world at
 * `origin`; cave-local x/z are island x/z, so the map can show where you are underground.
 *
 * The layout can be rebuilt at any time (the cave editor): only the chunks the edit touched are
 * re-meshed and swapped; the decorations, water, lights and contents are rebuilt whole.
 */
export class CaveNetwork {
  public readonly group = new THREE.Group();
  public entrances: CaveEntranceWorld[] = [];
  public ready = false;
  public stats: CaveGenOutput['stats'] | null = null;
  /** The layout the current meshes were built from (null until the first build). */
  public layout: CaveLayout | null = null;
  /** Bumped on every applied build (lights, contents and entrances may have changed). */
  public revision = 0;
  /** Called after every build with the things other systems own (chests, ore, mushrooms). */
  public onContents: ((contents: CaveContentsWorld) => void) | null = null;
  /** Called after every build with the layout it came from. */
  public onBuilt: ((layout: CaveLayout, stats: CaveGenOutput['stats']) => void) | null = null;
  /** Whether a rebuild is running or waiting. */
  public get busy(): boolean {
    return this.inFlight || !!this.queued;
  }

  private workers: PoolWorker[] = [];
  /** Keep the workers between builds (the editor rebuilds often). */
  private keepWorker = false;
  /** Bumped per build: replies of an older build are ignored. */
  private gen = 0;
  private revCounter = 0;
  private build: BuildState | null = null;
  private inFlight = false;
  private queued: CaveGenRequest | null = null;
  private loggedFirst = false;
  private startT = 0;
  private disposed = false;
  private editorView = false;
  private readonly rockMat = createCaveRockMaterial();
  private readonly waterMat = createCaveWaterMaterial();
  private readonly chunks = new Map<number, ChunkView>();
  private colliderQueue: ChunkView[] = [];
  /** Water, crystals, embers, entrances: rebuilt whole on every build. */
  private readonly decor = new THREE.Group();
  private decorGeometries: THREE.BufferGeometry[] = [];
  private decorMaterials: THREE.Material[] = [];
  private readonly lightBuckets = new Map<number, ExtraLight[]>();
  private pools: CaveGenOutput['pools'] = [];
  private drips: CaveDrips | null = null;
  private cullTimer = 0;
  private time = 0;
  private wasVisible = false;

  constructor(
    scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
    public readonly origin: THREE.Vector3,
    public readonly entrancesIn: CaveEntranceIn[],
    private readonly coast: Float32Array,
    private readonly seed: number,
    layout: CaveLayout | null
  ) {
    this.group.name = 'CaveNetwork';
    this.group.position.copy(origin);
    this.group.visible = false;
    this.decor.name = 'CaveDecor';
    this.group.add(this.decor);
    scene.add(this.group);
    this.start({ seed, entrances: entrancesIn, coast, layout }, true);
  }

  /**
   * Rebuilds from a layout (null: plan a fresh one from `seed`). With `dirty` only the chunks those
   * boxes touch are re-meshed; null re-meshes everything. A rebuild asked for while one runs waits
   * and merges with the next.
   */
  public rebuild(layout: CaveLayout | null, dirty: Box[] | null, seed = this.seed): void {
    const req: CaveGenRequest = { seed, entrances: this.entrancesIn, coast: this.coast, layout: layout ? structuredClone(layout) : null, dirty };
    if (this.inFlight) {
      // Only the newest layout matters; the dirty areas of every skipped one still need re-meshing
      const prev = this.queued;
      if (prev) req.dirty = prev.dirty && dirty ? [...prev.dirty, ...dirty] : null;
      this.queued = req;
      return;
    }
    this.start(req, false);
  }

  /** Keeps the workers alive between builds (for the editor); off terminates them once idle. */
  public setKeepWorker(on: boolean): void {
    this.keepWorker = on;
    if (!on && !this.inFlight) this.stopWorkers();
  }

  // ---------------------------------------------------------------- build pipeline

  /**
   * One build: a worker plans it (layout, water, contents, the chunk list), the pool meshes the
   * chunks in slices, those near the entrances first. The network is `ready` (enterable) once the
   * entrance slices are in; the rest streams in behind. The first full build of a session is
   * cached in IndexedDB and loaded from there next time.
   */
  private start(req: CaveGenRequest, useCache: boolean): void {
    this.inFlight = true;
    this.startT = performance.now();
    const gen = ++this.gen;
    this.build = null;
    if (!useCache) {
      this.planInWorker(gen, req, null);
      return;
    }
    void (async () => {
      const key = await caveCacheKey(req);
      const hit = key ? await loadCaveCache(key).catch(() => null) : null;
      if (this.disposed || gen !== this.gen) return;
      if (hit) {
        this.beginBuild(gen, req, hit.plan, null);
        for (const s of hit.slices) this.applySlice(gen, s);
        console.info(`[CaveNetwork] loaded from cache in ${Math.round(performance.now() - this.startT)} ms`);
        this.endBuild(gen);
        return;
      }
      this.planInWorker(gen, req, key ? new CaveCacheWriter(key) : null);
    })();
  }

  private poolSize(): number {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    return Math.max(1, Math.min(4, cores - 1));
  }

  /** A worker of the pool (created on first use); null when module workers are unavailable. */
  private workerAt(i: number): PoolWorker | null {
    if (this.workers[i]) return this.workers[i];
    try {
      const w: PoolWorker = { worker: new Worker(new URL('./caveWorker.ts', import.meta.url), { type: 'module' }), busy: false, rev: NaN, onReply: null };
      w.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        const cb = w.onReply;
        w.onReply = null;
        w.busy = false;
        cb?.(e.data);
      };
      w.worker.onerror = (err) => {
        const cb = w.onReply;
        w.onReply = null;
        w.busy = false;
        cb?.({ id: -1, ok: false, error: err.message });
      };
      this.workers[i] = w;
      return w;
    } catch {
      return null;
    }
  }

  private post(w: PoolWorker, msg: unknown, onReply: (r: WorkerReply) => void): void {
    w.busy = true;
    w.onReply = onReply;
    w.worker.postMessage(msg);
  }

  private planInWorker(gen: number, req: CaveGenRequest, cache: CaveCacheWriter | null): void {
    const w = this.workerAt(0);
    if (!w) {
      // No module workers: build on the main thread once the current frame has gone out
      setTimeout(() => this.buildOnMainThread(gen, req), 0);
      return;
    }
    this.post(w, { id: gen, type: 'plan', req }, (r) => {
      if (this.disposed || gen !== this.gen) return;
      if (!r.ok || !r.plan) {
        console.warn('[CaveNetwork] worker failed, generating on the main thread:', r.error);
        cache?.abort();
        this.buildOnMainThread(gen, req);
        return;
      }
      cache?.plan(r.plan);
      this.beginBuild(gen, req, r.plan, cache);
      this.pump();
    });
  }

  private buildOnMainThread(gen: number, req: CaveGenRequest): void {
    if (this.disposed || gen !== this.gen) return;
    const plan = planCaveNetwork(req);
    this.beginBuild(gen, req, plan, null);
    const b = this.build!;
    b.queue.length = 0;
    this.applySlice(gen, meshCaveChunks({ layout: plan.layout, entrances: req.entrances, wetPools: plan.wetPools, keys: plan.meshKeys, rev: b.rev }));
    this.endBuild(gen);
  }

  /** Applies a plan and splits its chunk list into slices: the entrance surroundings first. */
  private beginBuild(gen: number, req: CaveGenRequest, plan: CavePlan, cache: CaveCacheWriter | null): void {
    const spawns = plan.entrances.map((e) => e.spawn);
    const near: number[] = [];
    const far: number[] = [];
    for (const k of plan.meshKeys) (chunkEntranceDistance(k, spawns) < PRIORITY_RADIUS ? near : far).push(k);
    const n = this.poolSize();
    const queue: { keys: number[]; priority: boolean }[] = [];
    // The near chunks spread evenly over every worker, then the rest in small slices (good balance)
    const per = Math.max(1, Math.ceil(near.length / n));
    for (let i = 0; i < near.length; i += per) queue.push({ keys: near.slice(i, i + per), priority: true });
    for (let i = 0; i < far.length; i += SLICE) queue.push({ keys: far.slice(i, i + SLICE), priority: false });
    this.build = {
      gen,
      rev: ++this.revCounter,
      req,
      plan,
      queue,
      running: 0,
      priorityLeft: queue.filter((q) => q.priority).length,
      t0: this.startT,
      triangles: 0,
      chunks: 0,
      cache,
    };
    this.applyPlan(plan);
    if (this.build.priorityLeft === 0) this.markReady();
  }

  /** Hands queued slices to idle workers. */
  private pump(): void {
    const b = this.build;
    if (!b || this.disposed) return;
    const n = this.poolSize();
    for (let i = 0; i < n && b.queue.length; i++) {
      const w = this.workerAt(i);
      if (!w || w.busy) continue;
      const slice = b.queue.shift()!;
      const sendLayout = w.rev !== b.rev;
      w.rev = b.rev;
      b.running++;
      const gen = b.gen;
      const job: CaveMeshJob = { layout: sendLayout ? b.plan.layout : null, entrances: b.req.entrances, wetPools: sendLayout ? b.plan.wetPools : [], keys: slice.keys, rev: b.rev };
      this.post(w, { id: gen, type: 'mesh', job }, (r) => {
        if (this.disposed || gen !== this.gen || !this.build) return;
        const bb = this.build;
        bb.running--;
        if (!r.ok || !r.mesh) {
          // Mesh this slice here instead (a worker should not fail; stay correct if it does)
          console.warn('[CaveNetwork] mesh worker failed:', r.error);
          w.rev = NaN;
          r = { id: gen, ok: true, mesh: meshCaveChunks({ layout: bb.plan.layout, entrances: bb.req.entrances, wetPools: bb.plan.wetPools, keys: slice.keys, rev: -bb.rev }) };
        }
        bb.cache?.slice(r.mesh!);
        this.applySlice(gen, r.mesh!);
        if (slice.priority && --bb.priorityLeft === 0) this.markReady();
        if (bb.queue.length) this.pump();
        else if (bb.running === 0) this.endBuild(gen);
      });
    }
  }

  private markReady(): void {
    const first = !this.ready;
    this.ready = true;
    if (first && this.build) console.info(`[CaveNetwork] entrances ready in ${Math.round(performance.now() - this.build.t0)} ms`);
  }

  private endBuild(gen: number): void {
    const b = this.build;
    if (!b || b.gen !== gen) return;
    this.build = null;
    this.inFlight = false;
    this.markReady();
    b.cache?.finish();
    const ms = Math.round(performance.now() - b.t0);
    this.stats = { ...b.plan.stats, ms, meshMs: ms - b.plan.stats.ms, chunks: this.chunks.size, triangles: b.triangles };
    if (!this.loggedFirst) {
      this.loggedFirst = true;
      const s = this.stats;
      console.info(`[CaveNetwork] ${s.hubs} chambers, ${s.tunnels} tunnels, ${s.pools} pools, ${s.chunks} chunks, ${s.triangles} triangles in ${ms} ms (${this.poolSize()} workers)`);
    }
    this.onBuilt?.(b.plan.layout, this.stats);
    const next = this.queued;
    this.queued = null;
    if (next) this.start(next, false);
    else if (!this.keepWorker) this.stopWorkers();
  }

  private stopWorkers(): void {
    for (const w of this.workers) w?.worker.terminate();
    this.workers = [];
  }

  // ---------------------------------------------------------------- applying results

  private applySlice(gen: number, s: CaveMeshResult): void {
    if (gen !== this.gen || this.disposed) return;
    const o = this.origin;
    // The slice replaces whatever those chunks held (an edit may also have emptied some)
    for (const key of s.keys) {
      const old = this.chunks.get(key);
      if (old) this.removeChunk(old);
    }
    for (const c of s.chunks) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(c.normals, 3));
      geo.setAttribute('caveData', new THREE.BufferAttribute(c.data, 4, true));
      geo.setAttribute('caveWet', new THREE.BufferAttribute(c.wet, 1, true));
      geo.setIndex(new THREE.BufferAttribute(c.indices, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(c.cx, c.cy, c.cz), c.radius);
      const mesh = new THREE.Mesh(geo, this.rockMat);
      mesh.matrixAutoUpdate = false;
      mesh.raycast = () => {}; // CPU arrays are released after upload; physics does the picking
      mesh.updateMatrix();
      mesh.visible = this.editorView;
      this.group.add(mesh);
      const view: ChunkView = { key: c.key, mesh, center: new THREE.Vector3(c.cx + o.x, c.cy + o.y, c.cz + o.z), radius: c.radius, data: c, body: null };
      this.chunks.set(c.key, view);
      this.colliderQueue.push(view);
    }
    if (this.build) this.build.triangles += s.triangles;
    this.cullTimer = 0;
  }

  /** Everything of a build but the rock: water, decorations, lights, drips, entrances, contents. */
  private applyPlan(plan: CavePlan): void {
    const o = this.origin;
    const W = (p: [number, number, number]) => new THREE.Vector3(p[0] + o.x, p[1] + o.y, p[2] + o.z);

    // A full build drops every old chunk; a partial one the chunks that are now solid
    const drop = plan.clearKeys ?? [...this.chunks.keys()];
    for (const key of drop) {
      const view = this.chunks.get(key);
      if (view) this.removeChunk(view);
    }
    if (drop.length) {
      const gone = new Set(drop);
      this.colliderQueue = this.colliderQueue.filter((v) => !gone.has(v.key));
    }

    this.clearDecor();
    if (plan.water.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(plan.water, 3));
      const nrm = new Float32Array(plan.water.length);
      for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute('waterBiome', new THREE.BufferAttribute(plan.waterBiome, 3, true));
      geo.computeBoundingSphere();
      const water = new THREE.Mesh(geo, this.waterMat);
      water.renderOrder = 2;
      this.decor.add(water);
      this.decorGeometries.push(geo);
    }
    this.pools = plan.pools;
    this.buildCrystals(plan);
    this.buildEmbers(plan);
    this.buildEntrances(plan);

    this.lightBuckets.clear();
    for (const l of plan.lights) {
      const light: ExtraLight = { x: l.x + o.x, y: l.y + o.y, z: l.z + o.z, range: l.range, halo: l.halo, intensity: l.intensity, color: l.color, flicker: l.flicker };
      const key = this.bucketKey(light.x, light.z);
      let list = this.lightBuckets.get(key);
      if (!list) this.lightBuckets.set(key, (list = []));
      list.push(light);
    }

    const drips = new Float32Array(plan.drips.length);
    for (let i = 0; i < drips.length; i += 5) {
      drips[i] = plan.drips[i] + o.x;
      drips[i + 1] = plan.drips[i + 1] + o.y;
      drips[i + 2] = plan.drips[i + 2] + o.z;
      drips[i + 3] = plan.drips[i + 3] + o.y;
      drips[i + 4] = plan.drips[i + 4];
    }
    if (this.drips) {
      this.drips.group.removeFromParent();
      this.drips.dispose();
    }
    this.drips = new CaveDrips(drips);
    this.group.add(this.drips.group);
    // The drips work in world space; the group is offset by the origin
    this.drips.group.position.set(-o.x, -o.y, -o.z);

    this.entrances = plan.entrances.map((e) => ({ id: e.id, mouth: W(e.mouth), spawn: W(e.spawn), yaw: e.yaw, underwater: e.underwater }));
    this.layout = plan.layout;
    this.revision++;
    this.onContents?.({
      chests: plan.chests.map((c) => ({ id: c.id, pos: W(c.pos), yaw: c.yaw })),
      ores: plan.ores.map((r) => ({ pos: W(r.pos), kind: r.kind })),
      mushrooms: plan.mushrooms.map(W),
    });
  }

  private removeChunk(view: ChunkView): void {
    if (view.body && this.physics.isInitialized()) this.physics.removeRigidBody(view.body);
    view.body = null;
    view.data = null;
    view.mesh.geometry.dispose();
    view.mesh.removeFromParent();
    this.chunks.delete(view.key);
  }

  private clearDecor(): void {
    for (const c of [...this.decor.children]) c.removeFromParent();
    this.decorGeometries.forEach((g) => g.dispose());
    this.decorMaterials.forEach((m) => m.dispose());
    this.decorGeometries = [];
    this.decorMaterials = [];
  }

  private addDecor(geo: THREE.BufferGeometry, mat: THREE.Material, ownMaterial: boolean): void {
    this.decor.add(new THREE.Mesh(geo, mat));
    this.decorGeometries.push(geo);
    if (ownMaterial) this.decorMaterials.push(mat);
  }

  /** Glowing crystal clusters, merged into one unlit mesh per colour. */
  private buildCrystals(out: CavePlan): void {
    const byColor = new Map<number, THREE.BufferGeometry[]>();
    out.crystals.forEach((c, i) => {
      let geos = byColor.get(c.color);
      if (!geos) byColor.set(c.color, (geos = []));
      for (let k = 0; k < 5; k++) {
        const a = i * 2.1 + k * 1.37;
        const h = (0.45 + (k % 3) * 0.22) * c.size;
        const g = new THREE.CylinderGeometry(0, (0.08 + (k % 2) * 0.05) * c.size, h, 5);
        g.translate(0, h / 2, 0);
        g.rotateX(Math.sin(a) * 0.55);
        g.rotateZ(Math.cos(a) * 0.55);
        g.translate(c.pos[0] + Math.cos(a) * 0.16 * k * c.size, c.pos[1] - 0.06, c.pos[2] + Math.sin(a) * 0.16 * k * c.size);
        geos.push(g);
      }
    });
    for (const [color, geos] of byColor) {
      const geo = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      if (!geo) continue;
      const rgb = CRYSTAL_COLORS[color] ?? CRYSTAL_COLORS[0];
      this.addDecor(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(rgb[0] * 0.95, rgb[1] * 0.95, rgb[2] * 0.95) }), true);
    }
  }

  /** Ember vents: glowing coals in a ring of dark stones. */
  private buildEmbers(out: CavePlan): void {
    const coals: THREE.BufferGeometry[] = [];
    const stones: THREE.BufferGeometry[] = [];
    out.embers.forEach((p, i) => {
      for (let k = 0; k < 4; k++) {
        const a = i * 1.9 + k * 1.6;
        const g = new THREE.IcosahedronGeometry(0.12 + (k % 2) * 0.07, 0);
        g.translate(p[0] + Math.cos(a) * 0.22, p[1] + 0.05, p[2] + Math.sin(a) * 0.22);
        coals.push(g);
      }
      for (let k = 0; k < 5; k++) {
        const a = i * 0.7 + (k / 5) * Math.PI * 2;
        const g = new THREE.DodecahedronGeometry(0.2 + (k % 3) * 0.06, 0);
        g.scale(1, 0.7, 1);
        g.translate(p[0] + Math.cos(a) * 0.55, p[1] + 0.08, p[2] + Math.sin(a) * 0.55);
        stones.push(g);
      }
    });
    const coalGeo = coals.length ? mergeGeometries(coals) : null;
    const stoneGeo = stones.length ? mergeGeometries(stones) : null;
    coals.forEach((g) => g.dispose());
    stones.forEach((g) => g.dispose());
    if (coalGeo) this.addDecor(coalGeo, new THREE.MeshBasicMaterial({ color: 0xff6a20 }), true);
    if (stoneGeo) this.addDecor(stoneGeo, new THREE.MeshLambertMaterial({ color: 0x2b1d18, emissive: 0x200800 }), true);
  }

  /** Torches beside each way in, and the disc of daylight (sea light, under water) on the end wall. */
  private buildEntrances(out: CavePlan): void {
    const poles: THREE.BufferGeometry[] = [];
    const flames: THREE.BufferGeometry[] = [];
    const glows: THREE.BufferGeometry[] = [];
    const seaGlows: THREE.BufferGeometry[] = [];
    for (const e of out.entrances) {
      for (const t of e.torches) {
        poles.push(new THREE.CylinderGeometry(0.05, 0.06, 1.3, 6).translate(t[0], t[1] + 0.65, t[2]));
        flames.push(new THREE.ConeGeometry(0.1, 0.25, 6).translate(t[0], t[1] + 1.42, t[2]));
      }
      const g = new THREE.CircleGeometry(1.7, 20);
      g.scale(1, 1.15, 1);
      g.rotateY(e.yaw); // the disc faces into the cave
      g.translate(e.glow[0], e.glow[1], e.glow[2]);
      (e.underwater ? seaGlows : glows).push(g);
    }
    const add = (geos: THREE.BufferGeometry[], mat: () => THREE.Material, owned: boolean) => {
      if (!geos.length) return;
      const geo = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      if (geo) this.addDecor(geo, mat(), owned);
    };
    add(poles, () => STRUCTURE_MATERIALS.darkWood, false);
    add(flames, () => new THREE.MeshBasicMaterial({ color: 0xffb347 }), true);
    add(glows, () => new THREE.MeshBasicMaterial({ color: 0xdff3ff, fog: false }), true);
    add(seaGlows, () => new THREE.MeshBasicMaterial({ color: 0x5fc4e6, fog: false }), true);
  }

  // ---------------------------------------------------------------- editor view

  /**
   * Developer view: every chunk shown at once from outside (the chunk faces point into the air, so
   * ceilings seen from above are culled and the floors, tunnels and water show through).
   */
  public setEditorView(on: boolean): void {
    if (this.editorView === on) return;
    this.editorView = on;
    this.cullTimer = 0;
    // Seen from far above, the outdoor fog would wash the whole network out
    for (const m of [this.rockMat, this.waterMat]) {
      m.fog = !on;
      m.needsUpdate = true;
    }
    if (on) {
      this.group.visible = true;
      for (const c of this.chunks.values()) c.mesh.visible = true;
    } else this.wasVisible = true; // the next update hides or culls as usual
  }

  /** Chunk meshes currently built (the stats of a partial rebuild only count the re-meshed ones). */
  public get chunkCount(): number {
    return this.chunks.size;
  }

  public get inEditorView(): boolean {
    return this.editorView;
  }

  // ---------------------------------------------------------------- queries

  private bucketKey(x: number, z: number): number {
    return Math.floor((x - this.origin.x) / LIGHT_BUCKET + 64) * 1024 + Math.floor((z - this.origin.z) / LIGHT_BUCKET + 64);
  }

  /** Changes when the player moves into another light bucket or the lights are rebuilt. */
  public lightKey(pos: THREE.Vector3): number {
    return this.bucketKey(pos.x, pos.z) + this.revision * 1e7;
  }

  /** Cave lights in the 3x3 buckets around a point. */
  public lightsNear(pos: THREE.Vector3, out: ExtraLight[]): void {
    const k = this.bucketKey(pos.x, pos.z);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const list = this.lightBuckets.get(k + i * 1024 + j);
        if (list) for (const l of list) out.push(l);
      }
    }
  }

  /** Cave water surface at a world point, or NaN where there is none. */
  public waterLevelAt(x: number, y: number, z: number): number {
    if (!this.ready) return NaN;
    const lx = x - this.origin.x, ly = y - this.origin.y, lz = z - this.origin.z;
    for (const p of this.pools) {
      if (ly < p.minY - 1 || ly > p.level + 2.5) continue;
      const i = Math.floor((lx - p.minX) / p.cell), j = Math.floor((lz - p.minZ) / p.cell);
      if (i < 0 || j < 0 || i >= p.w || j >= p.h || !p.mask[j * p.w + i]) continue;
      return p.level + this.origin.y;
    }
    return NaN;
  }

  /** Built and every chunk's collider made (rays against the cave walls can be trusted). */
  public get collidersReady(): boolean {
    return this.ready && this.colliderQueue.length === 0;
  }

  /** Whether a world point lies in the cave pocket (rough box). */
  public contains(p: THREE.Vector3): boolean {
    return Math.abs(p.x - this.origin.x) < 300 && Math.abs(p.z - this.origin.z) < 300 && Math.abs(p.y - this.origin.y) < 120;
  }

  // ---------------------------------------------------------------- frame

  /** Builds every collider still queued (before the player is put inside). */
  public finishColliders(): void {
    while (this.colliderQueue.length) this.buildCollider(this.colliderQueue.pop()!);
  }

  private buildCollider(view: ChunkView): void {
    const c = view.data;
    if (!c || !this.physics.isInitialized()) return;
    const idx = new Uint32Array(c.colliderIndexCount);
    for (let i = 0; i < idx.length; i++) idx[i] = c.indices[i];
    view.body = this.physics.createStaticTrimesh(this.origin, c.positions, idx).body;
    view.data = null;
    // The GPU keeps its own copy: once uploaded, the JS arrays are dropped
    const geo = view.mesh.geometry;
    for (const name of ['position', 'normal', 'caveData', 'caveWet'] as const) {
      const attr = geo.getAttribute(name) as THREE.BufferAttribute;
      attr.onUpload(releaseArray);
    }
    geo.index?.onUpload(releaseArray);
  }

  public update(dt: number, player: THREE.Vector3, inCave: boolean): void {
    if (!this.ready) return;
    // Colliders in the background, a few per frame
    for (let i = 0; i < COLLIDERS_PER_FRAME && this.colliderQueue.length; i++) this.buildCollider(this.colliderQueue.pop()!);

    this.time += dt;
    caveUniforms.uCaveTime.value = this.time;
    if (this.editorView) {
      this.group.visible = true;
      if (inCave) this.drips?.update(dt, player);
      return;
    }

    this.group.visible = inCave;
    if (!inCave) {
      if (this.wasVisible) {
        this.drips?.clear();
        for (const c of this.chunks.values()) c.mesh.visible = false;
      }
      this.wasVisible = false;
      return;
    }

    this.cullTimer -= dt;
    if (this.cullTimer <= 0 || !this.wasVisible) {
      this.cullTimer = 0.2;
      for (const c of this.chunks.values()) {
        const d = c.center.distanceTo(player) - c.radius;
        c.mesh.visible = d < VIEW_RADIUS;
      }
    }
    this.wasVisible = true;
    this.drips?.update(dt, player);
  }

  public dispose(): void {
    this.disposed = true;
    this.queued = null;
    this.gen++;
    this.build?.cache?.abort();
    this.build = null;
    this.stopWorkers();
    for (const c of [...this.chunks.values()]) this.removeChunk(c);
    this.colliderQueue = [];
    this.clearDecor();
    this.rockMat.dispose();
    this.waterMat.dispose();
    if (this.drips) {
      this.drips.group.removeFromParent();
      this.drips.dispose();
    }
    this.drips = null;
    this.lightBuckets.clear();
    this.pools = [];
    this.group.removeFromParent();
    this.onContents = null;
    this.onBuilt = null;
  }
}

function releaseArray(this: THREE.BufferAttribute): void {
  (this as unknown as { array: ArrayLike<number> | null }).array = null;
}
