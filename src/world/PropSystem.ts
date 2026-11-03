import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { TerrainSystem } from './TerrainSystem';

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
  build(): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } {
    const materials: THREE.Material[] = [];
    const merged: THREE.BufferGeometry[] = [];
    for (const [mat, list] of this.parts) {
      for (const g of list) {
        g.deleteAttribute('uv');
      }
      merged.push(mergeGeometries(list)!);
      list.forEach((g) => g.dispose());
      materials.push(mat);
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
    id: 'mailbox', name: 'Поштова скринька', icon: 'Mailbox', category: 'decor',
    build: (b) => {
      b.box(M.darkWood, 0.1, 1.0, 0.1, 0, 0.5, 0);
      b.box(M.red, 0.3, 0.25, 0.45, 0, 1.1, 0);
    },
  },
];

export const PROP_DEF_MAP = new Map(PROP_DEFS.map((d) => [d.id, d]));

// ------------------------------------------------------------------ system

interface PropBatch {
  def: PropDef;
  mesh: THREE.InstancedMesh;
  ids: number[]; // instance slot -> prop id
}

/**
 * Placeable world props. Each prop type is ONE InstancedMesh (with a material per merged group),
 * so a forest of 300 trees costs a handful of draw calls.
 */
export class PropSystem {
  public readonly group = new THREE.Group();
  private readonly batches = new Map<string, PropBatch>();
  private readonly props = new Map<number, PropInstance>();
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

  private getBatch(type: string): PropBatch | null {
    let batch = this.batches.get(type);
    if (batch) return batch;
    const def = PROP_DEF_MAP.get(type);
    if (!def) return null;
    const b = new PropBuilder();
    def.build(b);
    const { geometry, materials } = b.build();
    const mesh = new THREE.InstancedMesh(geometry, materials, 16);
    mesh.count = 0;
    mesh.name = `Props_${type}`;
    mesh.frustumCulled = false; // instances spread over the map; culled per batch would hide them
    this.group.add(mesh);
    batch = { def, mesh, ids: [] };
    this.batches.set(type, batch);
    return batch;
  }

  private ensureCapacity(batch: PropBatch): void {
    const cap = batch.mesh.instanceMatrix.count;
    if (batch.ids.length < cap) return;
    const old = batch.mesh;
    const mesh = new THREE.InstancedMesh(old.geometry, old.material, cap * 2);
    mesh.name = old.name;
    mesh.frustumCulled = false;
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

  public add(type: string, x: number, z: number, rotationY = 0, scale = 1, y?: number, grounded = true): number | null {
    const batch = this.getBatch(type);
    if (!batch || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    this.ensureCapacity(batch);
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
    batch.ids.push(id);
    batch.mesh.count = batch.ids.length;
    this.writeMatrix(batch, batch.ids.length - 1, prop);
    this.createBody(prop, batch.def);
    this.revision++;
    return id;
  }

  public remove(id: number): void {
    const prop = this.props.get(id);
    if (!prop) return;
    const batch = this.batches.get(prop.type)!;
    const slot = batch.ids.indexOf(id);
    const last = batch.ids.length - 1;
    if (slot !== last) {
      // Swap the last instance into the freed slot
      batch.mesh.getMatrixAt(last, PropSystem._m);
      batch.mesh.setMatrixAt(slot, PropSystem._m);
      batch.ids[slot] = batch.ids[last];
    }
    batch.ids.pop();
    batch.mesh.count = batch.ids.length;
    batch.mesh.instanceMatrix.needsUpdate = true;
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
    const batch = this.batches.get(prop.type)!;
    this.writeMatrix(batch, batch.ids.indexOf(id), prop);
  }

  public setTransient(id: number): void {
    this.transient.add(id);
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
      this.createBody(prop, this.batches.get(prop.type)!.def);
    }
  }

  public setTransform(id: number, position: THREE.Vector3, rotationY: number, scale: number): void {
    const prop = this.props.get(id);
    if (!prop) return;
    prop.position.copy(position);
    prop.rotationY = rotationY;
    prop.scale = scale;
    const batch = this.batches.get(prop.type)!;
    this.writeMatrix(batch, batch.ids.indexOf(id), prop);
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
    for (const p of this.props.values()) {
      if (p.type !== type) continue;
      const d = p.position.distanceToSquared(pos);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  public pick(raycaster: THREE.Raycaster): { id: number; point: THREE.Vector3; distance: number } | null {
    let best: { id: number; point: THREE.Vector3; distance: number } | null = null;
    for (const batch of this.batches.values()) {
      if (!batch.mesh.count) continue;
      batch.mesh.computeBoundingSphere();
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
    if (this.terrainRevision === this.terrain.revision) return;
    const first = this.terrainRevision === -1;
    this.terrainRevision = this.terrain.revision;
    if (first) return;
    for (const prop of this.props.values()) {
      if (!prop.grounded) continue;
      const y = this.terrain.getHeight(prop.position.x, prop.position.z);
      if (Math.abs(y - prop.position.y) > 0.01) {
        prop.position.y = y;
        const batch = this.batches.get(prop.type)!;
        this.writeMatrix(batch, batch.ids.indexOf(prop.id), prop);
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
    this.bodies.set(prop.id, res.body);
  }

  public serialize(): PropSaveData[] {
    return this.list().filter((p) => !this.transient.has(p.id)).map((p) => ({
      type: p.type,
      p: [+p.position.x.toFixed(3), +p.position.y.toFixed(3), +p.position.z.toFixed(3)],
      r: +p.rotationY.toFixed(4),
      s: +p.scale.toFixed(3),
      g: p.grounded ? undefined : false,
    }));
  }

  public deserialize(data: PropSaveData[]): void {
    this.clear();
    for (const d of data) this.add(d.type, d.p[0], d.p[2], d.r, d.s, d.p[1], d.g !== false);
  }

  /** Default decoration so a fresh world does not look empty. */
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
    this.add('lamp', 9, 12, 0, 1);
    this.add('hay', -3, 20, 0.4, 1);
    for (let i = 0; i < 5; i++) this.add('fence', 18 + i * 2, 24, 0, 1);
  }
}
