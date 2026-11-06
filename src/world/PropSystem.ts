import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { TerrainSystem } from './TerrainSystem';
import { WORLD_HALF, isMobileDevice, worldSettings } from './WorldSettings';
import { riverWorld } from './rivers/RiverWorld';
import { coastRadius, fbm } from './IslandGenerator';
import { TerrainTileType } from '../terrain/types/TerrainTypes';

/**
 * Props are batched per type AND per square cell, so whole cells get culled. Far-seen types (trees,
 * boulders) use big cells for fewer draw calls; small things use small cells for tighter culling.
 */
const CELL_SMALL = 64;
const CELL_BIG = 128;
/** Phones draw props a bit less far (the fog is thick there anyway). */
const VIEW_SCALE = isMobileDevice() ? 0.75 : 1;
/** How far each type stays drawn (m); small things vanish first. Default for the rest: 160. */
const VIEW_DIST: Record<string, number> = {
  tree_pine: 240,
  tree_round: 240,
  rock_big: 200,
  bush: 130,
  rock_small: 95,
  flowers: 75,
  mushrooms: 60,
};
/**
 * Beyond this distance (from the cell's nearest edge) a tree cell swaps to a low-poly version.
 * LOD types use small cells so the swap follows the camera closely; a few metres of hysteresis
 * keep a cell from flickering between the two at the boundary.
 */
const LOD_DIST = (isMobileDevice() ? 50 : 70);
const LOD_HYSTERESIS = 8;
/** Bump when the generated forests change, so older saves get the new trees once. */
export const FOREST_VERSION = 1;

export type PropCategory = 'nature' | 'decor' | 'farm' | 'stations';

export interface PropDef {
  id: string;
  name: string;
  icon: string; // lucide icon name, resolved by the editor UI
  category: PropCategory;
  /** Collider: cylinder [radius, height] or box [w, h, d]; none when walk-through. */
  collider?: { kind: 'cyl'; r: number; h: number } | { kind: 'box'; w: number; h: number; d: number };
  build: (b: PropBuilder) => void;
}

export interface PropInstance {
  id: number;
  type: string;
  position: THREE.Vector3;
  rotationY: number;
  scale: number;
  /** Keep the prop glued to the terrain when heights change. */
  grounded: boolean;
}

export interface PropSaveData {
  type: string;
  p: [number, number, number];
  r: number;
  s: number;
  g?: boolean;
}

// ------------------------------------------------------------------ shared materials

const M = {
  bark: new THREE.MeshLambertMaterial({ color: 0x6b4426 }),
  pine: new THREE.MeshLambertMaterial({ color: 0x2f6b3a }),
  leaf: new THREE.MeshLambertMaterial({ color: 0x4f9a3c }),
  bush: new THREE.MeshLambertMaterial({ color: 0x3f8a3a }),
  rock: new THREE.MeshLambertMaterial({ color: 0x8a8580, flatShading: true }),
  wood: new THREE.MeshLambertMaterial({ color: 0xa87444 }),
  darkWood: new THREE.MeshLambertMaterial({ color: 0x6e4a2c }),
  metal: new THREE.MeshLambertMaterial({ color: 0x3c4148 }),
  stone: new THREE.MeshLambertMaterial({ color: 0x9b958c }),
  lamp: new THREE.MeshBasicMaterial({ color: 0xffe9a8 }),
  fire: new THREE.MeshBasicMaterial({ color: 0xff8a2a }),
  hay: new THREE.MeshLambertMaterial({ color: 0xe0c060 }),
  water: new THREE.MeshLambertMaterial({ color: 0x3fa7c9 }),
  red: new THREE.MeshLambertMaterial({ color: 0xd9534f }),
  white: new THREE.MeshLambertMaterial({ color: 0xf3efe6 }),
  petalPink: new THREE.MeshLambertMaterial({ color: 0xf48fb1 }),
  petalYellow: new THREE.MeshLambertMaterial({ color: 0xffd54f }),
  mushroom: new THREE.MeshLambertMaterial({ color: 0xc62828 }),
};

const WHITE = new THREE.Color(1, 1, 1);
const VERTEX_COLOR_MAT = new THREE.MeshLambertMaterial({ vertexColors: true });

/** Self-lit materials the night lighting drives (bulbs brighten at dusk, fire flickers). */
export const PROP_GLOW_MATERIALS = { lamp: M.lamp, fire: M.fire };

/** Collects primitives per material, then merges into one geometry with one group per material. */
export class PropBuilder {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();

  private add(mat: THREE.Material, g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0): void {
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat)!.push(g.index ? g.toNonIndexed() : g);
  }
  box(mat: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0, ry = 0) {
    this.add(mat, new THREE.BoxGeometry(w, h, d), x, y, z, ry);
  }
  cyl(mat: THREE.Material, rt: number, rb: number, h: number, x = 0, y = 0, z = 0, seg = 8) {
    this.add(mat, new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z);
  }
  cone(mat: THREE.Material, r: number, h: number, x = 0, y = 0, z = 0, seg = 8) {
    this.add(mat, new THREE.ConeGeometry(r, h, seg), x, y, z);
  }
  ball(mat: THREE.Material, r: number, x = 0, y = 0, z = 0, detail = 1) {
    this.add(mat, new THREE.IcosahedronGeometry(r, detail), x, y, z);
  }
  rock(mat: THREE.Material, r: number, x = 0, y = 0, z = 0, sy = 0.7) {
    const g = new THREE.DodecahedronGeometry(r, 0);
    g.scale(1, sy, 0.85);
    this.add(mat, g, x, y, z);
  }
  /**
   * Plain smooth Lambert parts are baked into vertex colours and share one material, so most props
   * (trees, bushes) are a single draw call per batch; special materials keep their own group.
   */
  build(): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } {
    const materials: THREE.Material[] = [];
    const merged: THREE.BufferGeometry[] = [];
    const baked: THREE.BufferGeometry[] = [];
    for (const [mat, list] of this.parts) {
      const lambert = mat as THREE.MeshLambertMaterial;
      const bake = lambert.isMeshLambertMaterial && !lambert.flatShading && !lambert.map && !lambert.transparent;
      const color = bake ? lambert.color : WHITE;
      for (const g of list) {
        g.deleteAttribute('uv');
        const n = g.getAttribute('position').count;
        const c = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      }
      if (bake) {
        baked.push(...list);
        continue;
      }
      merged.push(mergeGeometries(list)!);
      list.forEach((g) => g.dispose());
      materials.push(mat);
    }
    if (baked.length) {
      merged.push(mergeGeometries(baked)!);
      baked.forEach((g) => g.dispose());
      materials.push(VERTEX_COLOR_MAT);
    }
    const geometry = mergeGeometries(merged, true)!;
    merged.forEach((g) => g.dispose());
    geometry.computeBoundingSphere();
    return { geometry, materials };
  }
}

// ------------------------------------------------------------------ catalog (all props sit on y=0)

export const PROP_DEFS: PropDef[] = [
  {
    id: 'tree_pine', name: 'Ялина', icon: 'TreePine', category: 'nature',
    collider: { kind: 'cyl', r: 0.35, h: 3 },
    build: (b) => {
      b.cyl(M.bark, 0.18, 0.28, 1.6, 0, 0.8, 0, 6);
      b.cone(M.pine, 1.6, 2.2, 0, 2.2, 0);
      b.cone(M.pine, 1.25, 1.9, 0, 3.2, 0);
      b.cone(M.pine, 0.85, 1.5, 0, 4.1, 0);
    },
  },
  {
    id: 'tree_round', name: 'Дуб', icon: 'TreeDeciduous', category: 'nature',
    collider: { kind: 'cyl', r: 0.35, h: 3 },
    build: (b) => {
      b.cyl(M.bark, 0.22, 0.32, 2.2, 0, 1.1, 0, 6);
      b.ball(M.leaf, 1.5, 0, 3.1, 0);
      b.ball(M.leaf, 1.0, 0.9, 2.7, 0.4);
      b.ball(M.leaf, 1.0, -0.8, 2.8, -0.5);
    },
  },
  {
    id: 'bush', name: 'Кущ', icon: 'Sprout', category: 'nature',
    build: (b) => {
      b.ball(M.bush, 0.6, 0, 0.45, 0);
      b.ball(M.bush, 0.45, 0.5, 0.35, 0.2);
      b.ball(M.bush, 0.4, -0.45, 0.3, -0.2);
    },
  },
  {
    id: 'rock_small', name: 'Камінець', icon: 'Gem', category: 'nature',
    build: (b) => {
      b.rock(M.rock, 0.35, 0, 0.18, 0);
      b.rock(M.rock, 0.22, 0.35, 0.1, 0.15);
    },
  },
  {
    id: 'rock_big', name: 'Валун', icon: 'Mountain', category: 'nature',
    collider: { kind: 'cyl', r: 1.0, h: 1.4 },
    build: (b) => {
      b.rock(M.rock, 1.1, 0, 0.6, 0);
      b.rock(M.rock, 0.6, 0.9, 0.3, 0.4);
    },
  },
  {
    id: 'flowers', name: 'Квіти', icon: 'Flower2', category: 'nature',
    build: (b) => {
      for (let i = 0; i < 7; i++) {
        const a = i * 2.4;
        const r = 0.15 + (i % 3) * 0.15;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        b.cyl(M.leaf, 0.015, 0.015, 0.3, x, 0.15, z, 4);
        b.ball(i % 2 ? M.petalPink : M.petalYellow, 0.07, x, 0.32, z, 0);
      }
    },
  },
  {
    id: 'mushrooms', name: 'Гриби', icon: 'Cherry', category: 'nature',
    build: (b) => {
      for (const [x, z, s] of [[0, 0, 1], [0.2, 0.15, 0.7], [-0.15, 0.2, 0.6]]) {
        b.cyl(M.white, 0.04 * s, 0.05 * s, 0.18 * s, x, 0.09 * s, z, 6);
        b.cone(M.mushroom, 0.13 * s, 0.1 * s, x, 0.22 * s, z, 8);
      }
    },
  },
  {
    id: 'stump', name: 'Пень', icon: 'Circle', category: 'nature',
    collider: { kind: 'cyl', r: 0.4, h: 0.5 },
    build: (b) => {
      b.cyl(M.bark, 0.38, 0.45, 0.45, 0, 0.22, 0, 8);
      b.cyl(M.wood, 0.34, 0.34, 0.02, 0, 0.455, 0, 8);
    },
  },
  {
    id: 'fence', name: 'Паркан', icon: 'Fence', category: 'decor',
    collider: { kind: 'box', w: 2, h: 1, d: 0.15 },
    build: (b) => {
      b.box(M.wood, 0.12, 1.0, 0.12, -0.95, 0.5, 0);
      b.box(M.wood, 0.12, 1.0, 0.12, 0.95, 0.5, 0);
      b.box(M.wood, 2.0, 0.1, 0.06, 0, 0.75, 0);
      b.box(M.wood, 2.0, 0.1, 0.06, 0, 0.4, 0);
    },
  },
  {
    id: 'lamp', name: 'Ліхтар', icon: 'Lamp', category: 'decor',
    collider: { kind: 'cyl', r: 0.15, h: 2.4 },
    build: (b) => {
      b.cyl(M.metal, 0.06, 0.08, 2.3, 0, 1.15, 0, 6);
      b.box(M.metal, 0.32, 0.06, 0.32, 0, 2.3, 0);
      b.box(M.lamp, 0.24, 0.3, 0.24, 0, 2.48, 0);
      b.cone(M.metal, 0.24, 0.18, 0, 2.72, 0, 4);
    },
  },
  {
    id: 'bench', name: 'Лавка', icon: 'Armchair', category: 'decor',
    collider: { kind: 'box', w: 1.6, h: 0.9, d: 0.6 },
    build: (b) => {
      b.box(M.wood, 1.6, 0.08, 0.45, 0, 0.45, 0);
      b.box(M.wood, 1.6, 0.35, 0.06, 0, 0.75, -0.2);
      for (const x of [-0.7, 0.7]) b.box(M.metal, 0.08, 0.45, 0.4, x, 0.22, 0);
    },
  },
  {
    id: 'crate', name: 'Ящик', icon: 'Box', category: 'decor',
    collider: { kind: 'box', w: 0.8, h: 0.8, d: 0.8 },
    build: (b) => {
      b.box(M.wood, 0.8, 0.8, 0.8, 0, 0.4, 0);
      b.box(M.darkWood, 0.84, 0.08, 0.84, 0, 0.78, 0);
      b.box(M.darkWood, 0.84, 0.08, 0.84, 0, 0.04, 0);
    },
  },
  {
    id: 'hay', name: 'Сіно', icon: 'Wheat', category: 'farm',
    collider: { kind: 'cyl', r: 0.6, h: 1.0 },
    build: (b) => {
      const g = new THREE.CylinderGeometry(0.6, 0.6, 1.1, 12);
      g.rotateZ(Math.PI / 2);
      (b as any).add(M.hay, g, 0, 0.6, 0);
    },
  },
  {
    id: 'well', name: 'Криниця', icon: 'Droplets', category: 'farm',
    collider: { kind: 'cyl', r: 0.9, h: 1.0 },
    build: (b) => {
      b.cyl(M.stone, 0.85, 0.9, 0.8, 0, 0.4, 0, 10);
      b.cyl(M.water, 0.7, 0.7, 0.05, 0, 0.75, 0, 10);
      for (const x of [-0.75, 0.75]) b.box(M.darkWood, 0.12, 1.6, 0.12, x, 1.2, 0);
      b.cone(M.red, 1.15, 0.6, 0, 2.25, 0, 4);
    },
  },
  {
    id: 'campfire', name: 'Багаття', icon: 'Flame', category: 'stations',
    build: (b) => {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        b.rock(M.rock, 0.16, Math.cos(a) * 0.55, 0.08, Math.sin(a) * 0.55);
      }
      for (let i = 0; i < 3; i++) b.box(M.darkWood, 0.8, 0.1, 0.1, 0, 0.12, 0, (i * Math.PI) / 3);
      b.cone(M.fire, 0.25, 0.55, 0, 0.42, 0, 5);
    },
  },
  {
    // Hand quern: two stacked millstones on a low stone plinth, with a wooden crank handle
    id: 'millstone', name: 'Жорна', icon: 'Wheat', category: 'stations',
    collider: { kind: 'cyl', r: 0.75, h: 0.9 },
    build: (b) => {
      b.cyl(M.stone, 0.78, 0.85, 0.35, 0, 0.175, 0, 10);
      b.cyl(M.rock, 0.62, 0.62, 0.2, 0, 0.45, 0, 12);
      b.cyl(M.rock, 0.6, 0.62, 0.2, 0, 0.66, 0, 12);
      b.cyl(M.darkWood, 0.09, 0.09, 0.06, 0, 0.79, 0, 8);
      b.box(M.wood, 0.07, 0.42, 0.07, 0.45, 0.95, 0);
      b.cyl(M.white, 0.5, 0.5, 0.02, 0, 0.36, 0, 12); // flour dusted on the plinth
    },
  },
  {
    id: 'mailbox', name: 'Поштова скринька', icon: 'Mailbox', category: 'decor',
    build: (b) => {
      b.box(M.darkWood, 0.1, 1.0, 0.1, 0, 0.5, 0);
      b.box(M.red, 0.3, 0.25, 0.45, 0, 1.1, 0);
    },
  },
];

export const PROP_DEF_MAP = new Map(PROP_DEFS.map((d) => [d.id, d]));

/** Far versions of the trees (same baked material, ~1/3 of the triangles for the round tree). */
const LOD_BUILDS: Record<string, (b: PropBuilder) => void> = {
  tree_pine: (b) => {
    b.cyl(M.bark, 0.18, 0.28, 1.6, 0, 0.8, 0, 4);
    b.cone(M.pine, 1.6, 2.2, 0, 2.2, 0, 6);
    b.cone(M.pine, 1.25, 1.9, 0, 3.2, 0, 6);
    b.cone(M.pine, 0.85, 1.5, 0, 4.1, 0, 6);
  },
  tree_round: (b) => {
    // Detail-0 icosahedra sit inside their radius: grow them a little to keep the silhouette
    b.cyl(M.bark, 0.22, 0.32, 2.2, 0, 1.1, 0, 4);
    b.ball(M.leaf, 1.62, 0, 3.1, 0, 0);
    b.ball(M.leaf, 1.08, 0.9, 2.7, 0.4, 0);
    b.ball(M.leaf, 1.08, -0.8, 2.8, -0.5, 0);
  },
};

/** Where the farm's millstone stands (between the well and the campfire). */
export const MILLSTONE_SPOT = { x: -1.5, z: 13 };

// ------------------------------------------------------------------ system

interface PropBatch {
  def: PropDef;
  mesh: THREE.InstancedMesh;
  ids: number[]; // instance slot -> prop id
  cx: number;
  cz: number;
  size: number;
  viewDist: number;
  /** Shared high/low geometries for LOD types; `far` says which one the mesh draws now. */
  lod: { near: THREE.BufferGeometry; far: THREE.BufferGeometry } | null;
  far: boolean;
}

/**
 * Placeable world props. Each prop type is one InstancedMesh (with a material per merged group)
 * per 64 m cell: a forest of thousands of trees costs a few draw calls, and cells outside the view
 * frustum or beyond the type's draw distance are skipped entirely. The cells double as a spatial
 * index for nearest-prop queries.
 */
export class PropSystem {
  public readonly group = new THREE.Group();
  private readonly batches = new Map<string, PropBatch>();
  private readonly props = new Map<number, PropInstance>();
  private readonly batchOf = new Map<number, PropBatch>();
  private readonly slotOf = new Map<number, number>();
  private readonly bodies = new Map<number, RAPIER.RigidBody>();
  /** Temporary visual pose (chop wobble, fall, regrow) per prop; not saved. */
  /** Props that exist only for this session (stumps of felled trees). */
  private readonly transient = new Set<number>();
  private readonly poses = new Map<number, { axis: THREE.Vector3; angle: number; scale: number }>();
  private nextId = 1;
  private terrainRevision = -1;
  /** Bumped on any add/remove/move so UIs can refresh their lists. */
  public revision = 0;

  private static readonly _m = new THREE.Matrix4();
  private static readonly _q = new THREE.Quaternion();
  private static readonly _tilt = new THREE.Quaternion();
  private static readonly _s = new THREE.Vector3();
  private static readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene, private readonly physics: PhysicsWorld, private readonly terrain: TerrainSystem) {
    this.group.name = 'Props';
    scene.add(this.group);
  }

  private readonly geometries = new Map<string, { geometry: THREE.BufferGeometry; materials: THREE.Material[] }>();
  private readonly lodGeometries = new Map<string, THREE.BufferGeometry>();
  /** Frames left before an old save's forests get densified (waits for buildings' colliders). */
  private densifyIn = -1;
  /** Forest generation the current world has (saved with the world). */
  public forestVersion = FOREST_VERSION;

  private static cellSize(type: string): number {
    if (LOD_BUILDS[type]) return CELL_SMALL;
    return (VIEW_DIST[type] ?? 160) > 160 ? CELL_BIG : CELL_SMALL;
  }

  private getLod(type: string, near: THREE.BufferGeometry): PropBatch['lod'] {
    const build = LOD_BUILDS[type];
    if (!build) return null;
    let far = this.lodGeometries.get(type);
    if (!far) {
      const b = new PropBuilder();
      build(b);
      const built = b.build();
      far = built.geometry;
      this.lodGeometries.set(type, far);
    }
    return { near, far };
  }

  private getBatch(type: string, x: number, z: number): PropBatch | null {
    const size = PropSystem.cellSize(type);
    const cx = Math.floor(x / size);
    const cz = Math.floor(z / size);
    const key = `${type}|${cx}|${cz}`;
    let batch = this.batches.get(key);
    if (batch) return batch;
    const def = PROP_DEF_MAP.get(type);
    if (!def) return null;
    let shared = this.geometries.get(type);
    if (!shared) {
      const b = new PropBuilder();
      def.build(b);
      shared = b.build();
      this.geometries.set(type, shared);
    }
    const mesh = new THREE.InstancedMesh(shared.geometry, shared.materials, 16);
    mesh.count = 0;
    mesh.name = `Props_${type}_${cx}_${cz}`;
    this.setCellBounds(mesh, cx, cz, size);
    this.group.add(mesh);
    batch = {
      def, mesh, ids: [], cx, cz, size,
      viewDist: (VIEW_DIST[type] ?? 160) * VIEW_SCALE,
      lod: this.getLod(type, shared.geometry),
      far: false,
    };
    this.batches.set(key, batch);
    return batch;
  }

  /** Fixed bounding sphere of the cell (also covers props placed on roofs), used for culling and picking. */
  private setCellBounds(mesh: THREE.InstancedMesh, cx: number, cz: number, size: number): void {
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3((cx + 0.5) * size, 6, (cz + 0.5) * size), size * 0.7072 + 30);
  }

  private ensureCapacity(batch: PropBatch): void {
    const cap = batch.mesh.instanceMatrix.count;
    if (batch.ids.length < cap) return;
    const old = batch.mesh;
    const mesh = new THREE.InstancedMesh(old.geometry, old.material, cap * 2);
    mesh.name = old.name;
    this.setCellBounds(mesh, batch.cx, batch.cz, batch.size);
    mesh.visible = old.visible;
    for (let i = 0; i < old.count; i++) {
      old.getMatrixAt(i, PropSystem._m);
      mesh.setMatrixAt(i, PropSystem._m);
    }
    mesh.count = old.count;
    this.group.remove(old);
    old.dispose();
    this.group.add(mesh);
    batch.mesh = mesh;
  }

  private attach(prop: PropInstance, batch: PropBatch): void {
    this.ensureCapacity(batch);
    batch.ids.push(prop.id);
    batch.mesh.count = batch.ids.length;
    this.batchOf.set(prop.id, batch);
    this.slotOf.set(prop.id, batch.ids.length - 1);
    this.writeMatrix(batch, batch.ids.length - 1, prop);
  }

  private detach(id: number): void {
    const batch = this.batchOf.get(id);
    if (!batch) return;
    const slot = this.slotOf.get(id)!;
    const last = batch.ids.length - 1;
    if (slot !== last) {
      // Swap the last instance into the freed slot
      batch.mesh.getMatrixAt(last, PropSystem._m);
      batch.mesh.setMatrixAt(slot, PropSystem._m);
      batch.ids[slot] = batch.ids[last];
      this.slotOf.set(batch.ids[slot], slot);
    }
    batch.ids.pop();
    batch.mesh.count = batch.ids.length;
    batch.mesh.instanceMatrix.needsUpdate = true;
    this.batchOf.delete(id);
    this.slotOf.delete(id);
  }

  /** Shows only the cells within each type's draw distance of the camera (call once per frame). */
  public updateVisibility(camera: THREE.Vector3): void {
    for (const b of this.batches.values()) {
      const x0 = b.cx * b.size;
      const z0 = b.cz * b.size;
      const dx = Math.max(x0 - camera.x, 0, camera.x - x0 - b.size);
      const dz = Math.max(z0 - camera.z, 0, camera.z - z0 - b.size);
      const d2 = dx * dx + dz * dz;
      b.mesh.visible = b.ids.length > 0 && d2 < b.viewDist * b.viewDist;
      if (b.lod && b.mesh.visible) {
        const edge = b.far ? LOD_DIST - LOD_HYSTERESIS : LOD_DIST;
        const far = d2 > edge * edge;
        if (far !== b.far) {
          b.far = far;
          b.mesh.geometry = far ? b.lod.far : b.lod.near;
        }
      }
    }
  }

  /** Calls `fn` for every prop whose cell overlaps the circle (then filter by exact distance). */
  public forEachNear(x: number, z: number, radius: number, fn: (p: PropInstance) => void, type?: string): void {
    for (const b of this.batches.values()) {
      if (type && b.def.id !== type) continue;
      if (b.cx < Math.floor((x - radius) / b.size) || b.cx > Math.floor((x + radius) / b.size)) continue;
      if (b.cz < Math.floor((z - radius) / b.size) || b.cz > Math.floor((z + radius) / b.size)) continue;
      for (const id of b.ids) fn(this.props.get(id)!);
    }
  }

  public add(type: string, x: number, z: number, rotationY = 0, scale = 1, y?: number, grounded = true): number | null {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const batch = this.getBatch(type, x, z);
    if (!batch) return null;
    const id = this.nextId++;
    const prop: PropInstance = {
      id,
      type,
      position: new THREE.Vector3(x, y ?? this.terrain.getHeight(x, z), z),
      rotationY,
      scale,
      grounded,
    };
    this.props.set(id, prop);
    this.attach(prop, batch);
    this.createBody(prop, batch.def);
    this.revision++;
    return id;
  }

  public remove(id: number): void {
    const prop = this.props.get(id);
    if (!prop) return;
    this.detach(id);
    const body = this.bodies.get(id);
    if (body) this.physics.removeRigidBody(body);
    this.bodies.delete(id);
    this.poses.delete(id);
    this.transient.delete(id);
    this.props.delete(id);
    this.revision++;
  }

  /**
   * Overrides how a prop is drawn without changing its saved transform: tilt around `axis`
   * (horizontal, pivot at the base) and a scale multiplier (0 hides it). `null` restores it.
   */
  public setPose(id: number, pose: { axis: THREE.Vector3; angle: number; scale: number } | null): void {
    const prop = this.props.get(id);
    if (!prop) return;
    if (pose) this.poses.set(id, pose);
    else this.poses.delete(id);
    this.writeMatrix(this.batchOf.get(id)!, this.slotOf.get(id)!, prop);
  }

  private transientRevision = 0;
  public setTransient(id: number): void {
    this.transient.add(id);
    this.transientRevision++;
  }

  /** Removes or restores a prop's collider (e.g. a felled tree). */
  public setSolid(id: number, solid: boolean): void {
    const prop = this.props.get(id);
    if (!prop) return;
    const body = this.bodies.get(id);
    if (!solid) {
      if (body) this.physics.removeRigidBody(body);
      this.bodies.delete(id);
    } else if (!body) {
      this.createBody(prop, this.batchOf.get(id)!.def);
    }
  }

  public setTransform(id: number, position: THREE.Vector3, rotationY: number, scale: number): void {
    const prop = this.props.get(id);
    if (!prop) return;
    prop.position.copy(position);
    prop.rotationY = rotationY;
    prop.scale = scale;
    let batch = this.batchOf.get(id)!;
    if (batch.cx !== Math.floor(position.x / batch.size) || batch.cz !== Math.floor(position.z / batch.size)) {
      // Moved into another cell
      this.detach(id);
      batch = this.getBatch(prop.type, position.x, position.z)!;
      this.attach(prop, batch);
    } else {
      this.writeMatrix(batch, this.slotOf.get(id)!, prop);
    }
    const body = this.bodies.get(id);
    if (body) this.physics.removeRigidBody(body);
    this.createBody(prop, batch.def);
    this.revision++;
  }

  public get(id: number): PropInstance | undefined {
    return this.props.get(id);
  }

  public list(): PropInstance[] {
    return [...this.props.values()];
  }

  public count(): number {
    return this.props.size;
  }

  public clear(): void {
    for (const id of [...this.props.keys()]) this.remove(id);
  }

  /** Nearest prop of a type (e.g. 'campfire' for cooking) within range. */
  public findNearest(type: string, pos: THREE.Vector3, maxDist: number): PropInstance | null {
    let best: PropInstance | null = null;
    let bestD = maxDist * maxDist;
    this.forEachNear(
      pos.x,
      pos.z,
      maxDist,
      (p) => {
        const d = p.position.distanceToSquared(pos);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      },
      type
    );
    return best;
  }

  public pick(raycaster: THREE.Raycaster): { id: number; point: THREE.Vector3; distance: number } | null {
    let best: { id: number; point: THREE.Vector3; distance: number } | null = null;
    for (const batch of this.batches.values()) {
      if (!batch.mesh.count) continue;
      const hits = raycaster.intersectObject(batch.mesh, false);
      const h = hits[0];
      if (h && h.instanceId !== undefined && (!best || h.distance < best.distance)) {
        best = { id: batch.ids[h.instanceId], point: h.point.clone(), distance: h.distance };
      }
    }
    return best;
  }

  /** Re-snap grounded props after terrain sculpting (cheap, only when the terrain changed). */
  public update(): void {
    if (this.densifyIn >= 0 && this.densifyIn-- === 0) this.densifyForests(true);
    if (this.terrainRevision === this.terrain.revision) return;
    const first = this.terrainRevision === -1;
    this.terrainRevision = this.terrain.revision;
    if (first) return;
    for (const prop of this.props.values()) {
      if (!prop.grounded) continue;
      const y = this.terrain.getHeight(prop.position.x, prop.position.z);
      if (Math.abs(y - prop.position.y) > 0.01) {
        prop.position.y = y;
        const batch = this.batchOf.get(prop.id)!;
        this.writeMatrix(batch, this.slotOf.get(prop.id)!, prop);
        const body = this.bodies.get(prop.id);
        if (body) body.setTranslation({ x: prop.position.x, y: y + this.colliderOffset(batch.def), z: prop.position.z }, false);
      }
    }
  }

  private colliderOffset(def: PropDef): number {
    return def.collider ? def.collider.h / 2 : 0;
  }

  private writeMatrix(batch: PropBatch, slot: number, prop: PropInstance): void {
    PropSystem._q.setFromAxisAngle(PropSystem._up, prop.rotationY);
    const pose = this.poses.get(prop.id);
    if (pose) PropSystem._q.premultiply(PropSystem._tilt.setFromAxisAngle(pose.axis, pose.angle));
    PropSystem._s.setScalar(prop.scale * (pose ? Math.max(pose.scale, 1e-4) : 1));
    PropSystem._m.compose(prop.position, PropSystem._q, PropSystem._s);
    batch.mesh.setMatrixAt(slot, PropSystem._m);
    batch.mesh.instanceMatrix.needsUpdate = true;
  }

  private createBody(prop: PropInstance, def: PropDef): void {
    const c = def.collider;
    if (!c) return;
    const s = prop.scale;
    const pos = new THREE.Vector3(prop.position.x, prop.position.y + (c.h * s) / 2, prop.position.z);
    const rot = new THREE.Euler(0, prop.rotationY, 0);
    const res =
      c.kind === 'cyl'
        ? this.physics.createStaticCylinder(pos, c.r * s, c.h * s, rot)
        : this.physics.createStaticBox(pos, new THREE.Vector3(c.w * s, c.h * s, c.d * s), rot);
    // Step sounds: rocks and stone stations sound like stone, everything else is timber
    const stone = /rock|stone|mill|quern|campfire|well/.test(def.id);
    (res.collider as unknown as { userData: unknown }).userData = { surface: stone ? 'stone' : 'wood' };
    this.bodies.set(prop.id, res.body);
  }

  private saveCache: { key: string; data: PropSaveData[] } | null = null;

  public serialize(): PropSaveData[] {
    // Reused while nothing moved (props change only through this class; grounded ones follow the terrain)
    const key = `${this.revision}|${this.terrain.revision}|${this.transientRevision}`;
    if (this.saveCache?.key === key) return this.saveCache.data;
    const data = this.list().filter((p) => !this.transient.has(p.id)).map((p): PropSaveData => ({
      type: p.type,
      p: [+p.position.x.toFixed(3), +p.position.y.toFixed(3), +p.position.z.toFixed(3)],
      r: +p.rotationY.toFixed(4),
      s: +p.scale.toFixed(3),
      g: p.grounded ? undefined : false,
    }));
    this.saveCache = { key, data };
    return data;
  }

  public deserialize(data: PropSaveData[]): void {
    this.clear();
    for (const d of data) this.add(d.type, d.p[0], d.p[2], d.r, d.s, d.p[1], d.g !== false);
  }

  /** Default decoration so a fresh world does not look empty. */
  /**
   * Adds a station prop if the world has none of that type yet. Called for new worlds and after
   * loading a save, so worlds saved before the station existed still get one.
   */
  public ensureStation(type: string, x: number, z: number, rotationY = 0): void {
    for (const p of this.props.values()) if (p.type === type) return;
    this.add(type, x, z, rotationY, 1);
  }

  public populateDefault(): void {
    const ring = (type: string, cx: number, cz: number, n: number, r0: number, r1: number, seed: number) => {
      let s = seed;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const r = r0 + rnd() * (r1 - r0);
        this.add(type, cx + Math.cos(a) * r, cz + Math.sin(a) * r, rnd() * Math.PI * 2, 0.8 + rnd() * 0.5);
      }
    };
    ring('tree_pine', 0, 0, 34, 46, 60, 7);
    ring('tree_round', 0, 0, 16, 44, 58, 11);
    ring('bush', 0, 0, 24, 36, 56, 23);
    ring('flowers', 0, 0, 20, 10, 40, 31);
    ring('rock_small', 0, 0, 14, 20, 55, 41);
    ring('rock_big', 0, 0, 5, 50, 60, 53);
    ring('mushrooms', -20, -12, 6, 4, 12, 61);
    this.add('campfire', 4, 14, 0, 1);
    this.add('bench', 4, 16.6, Math.PI, 1);
    this.add('well', -6, 10, 0, 1);
    this.add('mailbox', 3, 5, -Math.PI / 2, 1);
    this.ensureStation('millstone', MILLSTONE_SPOT.x, MILLSTONE_SPOT.z);
    this.add('lamp', 9, 12, 0, 1);
    this.add('hay', -3, 20, 0.4, 1);
    for (let i = 0; i < 5; i++) this.add('fence', 18 + i * 2, 24, 0, 1);
    this.populateWilderness();
    this.densifyForests(false);
  }

  /**
   * Older saves were generated with sparser forests: densify them a couple of frames from now, once
   * the physics broadphase knows the loaded buildings (so no tree grows through a house).
   */
  public queueForestUpgrade(): void {
    this.densifyIn = 2;
  }

  /**
   * Second pass of forest trees between the first pass ones (roughly doubles forests; meadows,
   * bushes and rocks stay as they were). Keeps clear of other props, player-painted ground and,
   * when asked, of any collider (buildings, fences).
   */
  public densifyForests(checkColliders: boolean): void {
    this.densifyIn = -1;
    this.forestVersion = FOREST_VERSION;
    let s = 4242;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const STEP = 6.5;
    const water = worldSettings.waterLevel;
    const MIN_GAP = 2.6;
    const rot0 = new RAPIER.Quaternion(0, 0, 0, 1);
    const probe = checkColliders ? new RAPIER.Cylinder(1.5, 0.7) : null;
    let tooClose = false;
    const near = (p: PropInstance, x: number, z: number) => {
      const dx = p.position.x - x;
      const dz = p.position.z - z;
      if (dx * dx + dz * dz < MIN_GAP * MIN_GAP) tooClose = true;
    };
    for (let gz = -WORLD_HALF + STEP / 2; gz < WORLD_HALF; gz += STEP) {
      for (let gx = -WORLD_HALF + STEP / 2; gx < WORLD_HALF; gx += STEP) {
        const x = gx + rnd() * STEP;
        const z = gz + rnd() * STEP;
        const pick = rnd();
        const rot = rnd() * Math.PI * 2;
        const scale = 0.8 + rnd() * 0.55;
        const pineRoll = rnd();
        if (pick >= 0.7) continue;
        if (Math.hypot(x, z) < 66 || Math.hypot(x, z) > coastRadius(x, z) - 8) continue;
        const forest = fbm(x * 0.012 + 40, z * 0.012 - 13);
        if (forest <= -0.02) continue;
        const y = this.terrain.getHeight(x, z);
        if (y < water + 0.5 || y < riverWorld.waterLevelAt(x, z) + 0.5 || riverWorld.depthAt(x, z) > 0) continue;
        const slope = Math.abs(this.terrain.getHeight(x + 1, z) - y) + Math.abs(this.terrain.getHeight(x, z + 1) - y);
        if (slope > 1.1) continue;
        if (this.terrain.getTile(Math.floor(x), Math.floor(z)) !== TerrainTileType.GRASS) continue;
        tooClose = false;
        this.forEachNear(x, z, MIN_GAP, (p) => near(p, x, z));
        if (tooClose) continue;
        if (probe) {
          const hit = this.physics.world.intersectionWithShape(
            { x, y: y + 1.7, z }, rot0, probe,
            RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
            undefined, undefined, undefined,
            (c) => c.shape.type !== RAPIER.ShapeType.HeightField
          );
          if (hit) continue;
        }
        const pine = y > 6 || forest > 0.3 ? 0.75 : 0.35;
        this.add(pineRoll < pine ? 'tree_pine' : 'tree_round', x, z, rot, scale);
      }
    }
  }

  /**
   * Forests, meadows and boulders across the island outside the original farm area. Deterministic,
   * so the same world comes out every time; densities follow noise, avoiding water and steep slopes.
   */
  public populateWilderness(): void {
    let s = 9001;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const STEP = 6.5;
    const water = worldSettings.waterLevel;
    for (let gz = -WORLD_HALF; gz < WORLD_HALF; gz += STEP) {
      for (let gx = -WORLD_HALF; gx < WORLD_HALF; gx += STEP) {
        const x = gx + rnd() * STEP;
        const z = gz + rnd() * STEP;
        const pick = rnd();
        const r = Math.hypot(x, z);
        if (r < 66 || r > coastRadius(x, z) - 8) continue;
        const y = this.terrain.getHeight(x, z);
        if (y < water + 0.5 || y < riverWorld.waterLevelAt(x, z) + 0.5 || riverWorld.depthAt(x, z) > 0) continue;
        const slope = Math.abs(this.terrain.getHeight(x + 1, z) - y) + Math.abs(this.terrain.getHeight(x, z + 1) - y);
        const forest = fbm(x * 0.012 + 40, z * 0.012 - 13);
        const rot = rnd() * Math.PI * 2;
        const scale = 0.8 + rnd() * 0.55;
        if (slope > 1.1) {
          if (pick < 0.12) this.add('rock_big', x, z, rot, scale);
          else if (pick < 0.3) this.add('rock_small', x, z, rot, scale);
        } else if (forest > -0.02) {
          // Forest: pines up high, round trees in the lowlands
          const pine = y > 6 || forest > 0.3 ? 0.75 : 0.35;
          if (pick < 0.7) this.add(rnd() < pine ? 'tree_pine' : 'tree_round', x, z, rot, scale);
          else if (pick < 0.78) this.add('bush', x, z, rot, scale);
          else if (pick < 0.82) this.add('mushrooms', x, z, rot, scale);
        } else {
          // Meadows: scattered trees, bushes, flowers and stones
          if (pick < 0.05) this.add(rnd() < 0.5 ? 'tree_round' : 'tree_pine', x, z, rot, scale);
          else if (pick < 0.13) this.add('bush', x, z, rot, scale);
          else if (pick < 0.25) this.add('flowers', x, z, rot, scale);
          else if (pick < 0.29) this.add('rock_small', x, z, rot, scale);
          else if (pick < 0.3) this.add('rock_big', x, z, rot, scale);
        }
      }
    }
  }
}
