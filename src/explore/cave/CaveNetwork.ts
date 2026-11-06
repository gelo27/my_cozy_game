import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import type { ExtraLight } from '../../world/NightLighting';
import { STRUCTURE_MATERIALS } from '../StructureBuilder';
import { generateCaveNetwork, CaveGenInput, CaveGenOutput, CaveEntranceIn, CaveChunk, CRYSTAL_COLORS } from './CaveGen';
import { createCaveRockMaterial, createCaveWaterMaterial, caveUniforms } from './CaveMaterial';
import { CaveDrips } from './CaveDrips';

/** Chunks farther than this from the player are hidden (the cave fog swallows them long before). */
const VIEW_RADIUS = 62;
const LIGHT_BUCKET = 32;
/** Colliders built per frame in the background once the mesh data has arrived. */
const COLLIDERS_PER_FRAME = 6;

interface ChunkView {
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
}

export interface CaveContentsWorld {
  chests: { id: string; pos: THREE.Vector3; yaw: number }[];
  ores: { pos: THREE.Vector3; kind: CaveGenOutput['ores'][number]['kind'] }[];
  mushrooms: THREE.Vector3[];
}

/**
 * The island-wide cave network on the main thread: generated in a worker at startup, then turned
 * into chunk meshes (one shared shader), water, glowing crystals and embers, entrance torches,
 * colliders (spread over frames) and a light list bucketed by area. Lives in its own pocket of the
 * world at `origin`; cave-local x/z are island x/z, so the map can show where you are underground.
 */
export class CaveNetwork {
  public readonly group = new THREE.Group();
  public entrances: CaveEntranceWorld[] = [];
  public ready = false;
  public stats: CaveGenOutput['stats'] | null = null;
  /** Called once with the things other systems own (chests, ore, mushrooms). */
  public onReady: ((contents: CaveContentsWorld) => void) | null = null;

  private worker: Worker | null = null;
  private disposed = false;
  private readonly rockMat = createCaveRockMaterial();
  private readonly waterMat = createCaveWaterMaterial();
  private readonly ownedMaterials: THREE.Material[] = [this.rockMat, this.waterMat];
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private chunks: ChunkView[] = [];
  private colliderQueue: ChunkView[] = [];
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
    entrances: CaveEntranceIn[],
    coast: Float32Array,
    seed: number
  ) {
    this.group.name = 'CaveNetwork';
    this.group.position.copy(origin);
    this.group.visible = false;
    scene.add(this.group);
    this.start({ seed, entrances, coast });
  }

  private start(input: CaveGenInput): void {
    try {
      this.worker = new Worker(new URL('./caveWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ ok: boolean; out?: CaveGenOutput; error?: string }>) => {
        this.stopWorker();
        if (e.data.ok && e.data.out) this.build(e.data.out);
        else {
          console.warn('[CaveNetwork] worker failed, generating on the main thread:', e.data.error);
          this.build(generateCaveNetwork(input));
        }
      };
      this.worker.onerror = (err) => {
        console.warn('[CaveNetwork] worker error, generating on the main thread:', err.message);
        this.stopWorker();
        if (!this.ready && !this.disposed) this.build(generateCaveNetwork(input));
      };
      this.worker.postMessage(input);
    } catch {
      // No module workers: build when the first frame has gone out
      setTimeout(() => {
        if (!this.disposed) this.build(generateCaveNetwork(input));
      }, 0);
    }
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  // ---------------------------------------------------------------- build

  private build(out: CaveGenOutput): void {
    if (this.disposed || this.ready) return;
    const o = this.origin;
    const W = (p: [number, number, number]) => new THREE.Vector3(p[0] + o.x, p[1] + o.y, p[2] + o.z);

    for (const c of out.chunks) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(c.normals, 3));
      geo.setAttribute('caveData', new THREE.BufferAttribute(c.data, 4, true));
      geo.setIndex(new THREE.BufferAttribute(c.indices, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(c.cx, c.cy, c.cz), c.radius);
      const mesh = new THREE.Mesh(geo, this.rockMat);
      mesh.matrixAutoUpdate = false;
      mesh.raycast = () => {}; // CPU arrays are released after upload; physics does the picking
      mesh.updateMatrix();
      mesh.visible = false;
      this.group.add(mesh);
      this.ownedGeometries.push(geo);
      const view: ChunkView = { mesh, center: new THREE.Vector3(c.cx + o.x, c.cy + o.y, c.cz + o.z), radius: c.radius, data: c, body: null };
      this.chunks.push(view);
      this.colliderQueue.push(view);
    }

    if (out.water.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(out.water, 3));
      const nrm = new Float32Array(out.water.length);
      for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.computeBoundingSphere();
      const water = new THREE.Mesh(geo, this.waterMat);
      water.renderOrder = 2;
      this.group.add(water);
      this.ownedGeometries.push(geo);
    }
    this.pools = out.pools;

    this.buildCrystals(out);
    this.buildEmbers(out);
    this.buildEntrances(out);

    for (const l of out.lights) {
      const light: ExtraLight = { x: l.x + o.x, y: l.y + o.y, z: l.z + o.z, range: l.range, halo: l.halo, intensity: l.intensity, color: l.color, flicker: l.flicker };
      const key = this.bucketKey(light.x, light.z);
      let list = this.lightBuckets.get(key);
      if (!list) this.lightBuckets.set(key, (list = []));
      list.push(light);
    }

    const drips = new Float32Array(out.drips.length);
    for (let i = 0; i < drips.length; i += 5) {
      drips[i] = out.drips[i] + o.x;
      drips[i + 1] = out.drips[i + 1] + o.y;
      drips[i + 2] = out.drips[i + 2] + o.z;
      drips[i + 3] = out.drips[i + 3] + o.y;
      drips[i + 4] = out.drips[i + 4];
    }
    this.drips = new CaveDrips(drips);
    this.group.add(this.drips.group);
    // The drips work in world space; the group is offset by the origin
    this.drips.group.position.set(-o.x, -o.y, -o.z);

    this.entrances = out.entrances.map((e) => ({ id: e.id, mouth: W(e.mouth), spawn: W(e.spawn), yaw: e.yaw }));
    this.stats = out.stats;
    this.ready = true;
    console.info(`[CaveNetwork] ${out.stats.hubs} chambers, ${out.stats.tunnels} tunnels, ${out.stats.chunks} chunks, ${out.stats.triangles} triangles in ${out.stats.ms} ms`);
    this.onReady?.({
      chests: out.chests.map((c) => ({ id: c.id, pos: W(c.pos), yaw: c.yaw })),
      ores: out.ores.map((r) => ({ pos: W(r.pos), kind: r.kind })),
      mushrooms: out.mushrooms.map(W),
    });
  }

  /** Glowing crystal clusters, merged into one unlit mesh per colour. */
  private buildCrystals(out: CaveGenOutput): void {
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
      const rgb = CRYSTAL_COLORS[color];
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(rgb[0] * 0.95, rgb[1] * 0.95, rgb[2] * 0.95) });
      this.group.add(new THREE.Mesh(geo, mat));
      this.ownedGeometries.push(geo);
      this.ownedMaterials.push(mat);
    }
  }

  /** Ember vents: glowing coals in a ring of dark stones. */
  private buildEmbers(out: CaveGenOutput): void {
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
    if (coalGeo) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xff6a20 });
      this.group.add(new THREE.Mesh(coalGeo, mat));
      this.ownedGeometries.push(coalGeo);
      this.ownedMaterials.push(mat);
    }
    if (stoneGeo) {
      const mat = new THREE.MeshLambertMaterial({ color: 0x2b1d18, emissive: 0x200800 });
      this.group.add(new THREE.Mesh(stoneGeo, mat));
      this.ownedGeometries.push(stoneGeo);
      this.ownedMaterials.push(mat);
    }
  }

  /** Torches beside each way in, and the bright disc of daylight on the end wall. */
  private buildEntrances(out: CaveGenOutput): void {
    const poles: THREE.BufferGeometry[] = [];
    const flames: THREE.BufferGeometry[] = [];
    const glows: THREE.BufferGeometry[] = [];
    for (const e of out.entrances) {
      for (const t of e.torches) {
        poles.push(new THREE.CylinderGeometry(0.05, 0.06, 1.3, 6).translate(t[0], t[1] + 0.65, t[2]));
        flames.push(new THREE.ConeGeometry(0.1, 0.25, 6).translate(t[0], t[1] + 1.42, t[2]));
      }
      const g = new THREE.CircleGeometry(1.7, 20);
      g.scale(1, 1.15, 1);
      g.rotateY(e.yaw); // the disc faces into the cave
      g.translate(e.glow[0], e.glow[1], e.glow[2]);
      glows.push(g);
    }
    const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, owned: boolean) => {
      const geo = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      if (!geo) return;
      this.group.add(new THREE.Mesh(geo, mat));
      this.ownedGeometries.push(geo);
      if (owned) this.ownedMaterials.push(mat);
    };
    add(poles, STRUCTURE_MATERIALS.darkWood, false);
    add(flames, new THREE.MeshBasicMaterial({ color: 0xffb347 }), true);
    add(glows, new THREE.MeshBasicMaterial({ color: 0xdff3ff, fog: false }), true);
  }

  // ---------------------------------------------------------------- queries

  private bucketKey(x: number, z: number): number {
    return Math.floor((x - this.origin.x) / LIGHT_BUCKET + 64) * 1024 + Math.floor((z - this.origin.z) / LIGHT_BUCKET + 64);
  }

  /** Changes when the player moves into another light bucket (the light list must be rebuilt). */
  public lightKey(pos: THREE.Vector3): number {
    return this.bucketKey(pos.x, pos.z);
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
      const i = Math.floor(lx - p.minX), j = Math.floor(lz - p.minZ);
      if (i < 0 || j < 0 || i >= p.w || j >= p.h || !p.mask[j * p.w + i]) continue;
      return p.level + this.origin.y;
    }
    return NaN;
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
    for (const name of ['position', 'normal', 'caveData'] as const) {
      const attr = geo.getAttribute(name) as THREE.BufferAttribute;
      attr.onUpload(releaseArray);
    }
    geo.index?.onUpload(releaseArray);
  }

  public update(dt: number, player: THREE.Vector3, inCave: boolean): void {
    if (!this.ready) return;
    // Colliders in the background, a few per frame
    for (let i = 0; i < COLLIDERS_PER_FRAME && this.colliderQueue.length; i++) this.buildCollider(this.colliderQueue.pop()!);

    this.group.visible = inCave;
    if (!inCave) {
      if (this.wasVisible) {
        this.drips?.clear();
        for (const c of this.chunks) c.mesh.visible = false;
      }
      this.wasVisible = false;
      return;
    }
    this.time += dt;
    caveUniforms.uCaveTime.value = this.time;

    this.cullTimer -= dt;
    if (this.cullTimer <= 0 || !this.wasVisible) {
      this.cullTimer = 0.2;
      for (const c of this.chunks) {
        const d = c.center.distanceTo(player) - c.radius;
        c.mesh.visible = d < VIEW_RADIUS;
      }
    }
    this.wasVisible = true;
    this.drips?.update(dt, player);
  }

  public dispose(): void {
    this.disposed = true;
    this.stopWorker();
    for (const c of this.chunks) {
      if (c.body && this.physics.isInitialized()) this.physics.removeRigidBody(c.body);
    }
    this.chunks = [];
    this.colliderQueue = [];
    this.ownedGeometries.forEach((g) => g.dispose());
    this.ownedMaterials.forEach((m) => m.dispose());
    this.drips?.dispose();
    this.lightBuckets.clear();
    this.pools = [];
    this.group.removeFromParent();
    this.onReady = null;
  }
}

function releaseArray(this: THREE.BufferAttribute): void {
  (this as unknown as { array: ArrayLike<number> | null }).array = null;
}
