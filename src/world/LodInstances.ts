import * as THREE from 'three';
import { acquireInstancedDither } from './LodDither';

/**
 * One drawn list of instances (prop ids <-> slots of an InstancedMesh), grown on demand. A fading
 * list also carries a per-instance `aLodFade` value for the instanced dither material.
 */
class InstanceList {
  public mesh: THREE.InstancedMesh;
  public readonly ids: number[] = [];
  private readonly slots = new Map<number, number>();
  private fade: THREE.InstancedBufferAttribute | null = null;
  private source: THREE.BufferGeometry;
  /** Materials worn instead of the shared ones (the distance dither at the view's edge). */
  private override: THREE.Material[] | null = null;
  private static readonly _m = new THREE.Matrix4();

  constructor(
    private readonly parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    private readonly materials: THREE.Material[],
    private readonly bounds: THREE.Sphere,
    private readonly name: string,
    private readonly fading: boolean,
  ) {
    this.source = geometry;
    this.mesh = this.make(8);
  }

  public has(id: number): boolean {
    return this.slots.has(id);
  }

  public add(id: number, m: THREE.Matrix4, fade = 0): void {
    if (this.ids.length >= this.mesh.instanceMatrix.count) this.grow();
    const slot = this.ids.length;
    this.ids.push(id);
    this.slots.set(id, slot);
    this.mesh.setMatrixAt(slot, m);
    this.mesh.count = this.ids.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.fade) this.setFadeAt(slot, fade);
    if (this.mesh.parent !== this.parent) this.parent.add(this.mesh);
  }

  public remove(id: number): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    const last = this.ids.length - 1;
    if (slot !== last) {
      // Swap the last instance into the freed slot
      this.mesh.getMatrixAt(last, InstanceList._m);
      this.mesh.setMatrixAt(slot, InstanceList._m);
      const moved = this.ids[last];
      this.ids[slot] = moved;
      this.slots.set(moved, slot);
      if (this.fade) this.setFadeAt(slot, this.fade.getX(last));
    }
    this.ids.pop();
    this.slots.delete(id);
    this.mesh.count = this.ids.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    // Empty lists leave the scene graph: no draw call, no culling test
    if (!this.ids.length) this.mesh.removeFromParent();
  }

  public setMatrix(id: number, m: THREE.Matrix4): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    this.mesh.setMatrixAt(slot, m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  public setFade(id: number, v: number): void {
    const slot = this.slots.get(id);
    if (slot !== undefined) this.setFadeAt(slot, v);
  }

  public setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  /** Steady lists only: wear `materials` (null = the shared ones again). */
  public setMaterials(materials: THREE.Material[] | null): void {
    this.override = materials;
    this.mesh.material = materials ?? this.materials;
  }

  public dispose(): void {
    this.mesh.removeFromParent();
    if (this.fading) this.mesh.geometry.dispose();
    this.mesh.dispose();
  }

  private setFadeAt(slot: number, v: number): void {
    this.fade!.setX(slot, v);
    this.fade!.needsUpdate = true;
  }

  private make(capacity: number): THREE.InstancedMesh {
    let geometry = this.source;
    let materials = this.override ?? this.materials;
    if (this.fading) {
      this.fade = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      this.fade.setUsage(THREE.DynamicDrawUsage);
      geometry = this.wrap(this.source, this.fade);
      materials = this.materials.map((m) => acquireInstancedDither(m));
    }
    const mesh = new THREE.InstancedMesh(geometry, materials, capacity);
    mesh.count = 0;
    mesh.name = this.name;
    mesh.boundingSphere = this.bounds;
    return mesh;
  }

  /**
   * The shared LOD geometry plus this list's own per-instance fade (attributes are shared by
   * reference, so the GPU keeps one copy of the vertex data).
   */
  private wrap(src: THREE.BufferGeometry, fade: THREE.InstancedBufferAttribute): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr);
    g.setIndex(src.index);
    for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    g.boundingSphere = src.boundingSphere;
    g.setAttribute('aLodFade', fade);
    return g;
  }

  private grow(): void {
    const old = this.mesh;
    const oldFade = this.fade;
    const mesh = this.make(old.instanceMatrix.count * 2);
    for (let i = 0; i < old.count; i++) {
      old.getMatrixAt(i, InstanceList._m);
      mesh.setMatrixAt(i, InstanceList._m);
      if (oldFade) this.fade!.setX(i, oldFade.getX(i));
    }
    mesh.count = old.count;
    mesh.visible = old.visible;
    const parent = old.parent;
    old.removeFromParent();
    if (this.fading) old.geometry.dispose();
    old.dispose();
    if (parent) parent.add(mesh);
    this.mesh = mesh;
  }
}

interface Transition {
  from: number;
  to: number;
  t: number;
}

/**
 * Per-tree LOD for one cell of one prop type: every instance is drawn at the level its own
 * distance asks for (not the cell's), from one instanced list per level. A tree changing level
 * dissolves from one into the other through two small "fading" lists with a per-instance dither,
 * so only the few trees mid-switch use the discard shader; everything else draws plain.
 */
export class LodInstances {
  private readonly steady: InstanceList[];
  private readonly fading: InstanceList[];
  private readonly levelOf = new Map<number, number>();
  private readonly transitions = new Map<number, Transition>();
  /** Level every instance is at (no transitions), or -1. */
  public uniform = -1;
  private static readonly _m = new THREE.Matrix4();

  constructor(parent: THREE.Object3D, lods: THREE.BufferGeometry[], materials: THREE.Material[], bounds: THREE.Sphere, name: string) {
    this.steady = lods.map((g, i) => new InstanceList(parent, g, materials, bounds, `${name}_lod${i}`, false));
    this.fading = lods.map((g, i) => new InstanceList(parent, g, materials, bounds, `${name}_lod${i}_fade`, true));
  }

  public get levels(): number {
    return this.steady.length;
  }

  public levelOfId(id: number): number {
    return this.levelOf.get(id) ?? 0;
  }

  public get busy(): boolean {
    return this.transitions.size > 0;
  }

  public add(id: number, m: THREE.Matrix4, level: number): void {
    this.levelOf.set(id, level);
    this.steady[level].add(id, m);
    if (this.uniform !== level) this.uniform = -1;
    if (this.levelOf.size === 1) this.uniform = level;
  }

  public remove(id: number): void {
    const level = this.levelOf.get(id);
    if (level === undefined) return;
    const tr = this.transitions.get(id);
    if (tr) {
      this.fading[tr.from].remove(id);
      this.fading[tr.to].remove(id);
      this.transitions.delete(id);
    } else {
      this.steady[level].remove(id);
    }
    this.levelOf.delete(id);
  }

  public setMatrix(id: number, m: THREE.Matrix4): void {
    const tr = this.transitions.get(id);
    if (tr) {
      this.fading[tr.from].setMatrix(id, m);
      this.fading[tr.to].setMatrix(id, m);
    } else {
      const level = this.levelOf.get(id);
      if (level !== undefined) this.steady[level].setMatrix(id, m);
    }
  }

  /** Moves one instance to `level`: at once when `fadeSeconds` is ~0, else dithered over it. */
  public setLevel(id: number, level: number, m: THREE.Matrix4, fadeSeconds: number): void {
    const from = this.levelOf.get(id);
    if (from === undefined || from === level || this.transitions.has(id)) return;
    this.uniform = -1;
    this.levelOf.set(id, level);
    this.steady[from].remove(id);
    if (fadeSeconds < 0.02) {
      this.steady[level].add(id, m);
      return;
    }
    // Outgoing keeps the pixels the incoming one hasn't taken yet
    this.fading[from].add(id, m, -1e-4);
    this.fading[level].add(id, m, 1e-4);
    this.transitions.set(id, { from, to: level, t: 0 });
  }

  /** Advances the per-tree crossfades; finished trees go back to the plain lists. */
  public step(dt: number, fadeSeconds: number, matrixOf: (id: number, out: THREE.Matrix4) => THREE.Matrix4): void {
    if (!this.transitions.size) return;
    const k = dt / Math.max(0.02, fadeSeconds);
    for (const [id, tr] of this.transitions) {
      tr.t += k;
      if (tr.t >= 1) {
        this.fading[tr.from].remove(id);
        this.fading[tr.to].remove(id);
        this.transitions.delete(id);
        this.steady[tr.to].add(id, matrixOf(id, LodInstances._m));
        continue;
      }
      this.fading[tr.from].setFade(id, -Math.max(1e-4, tr.t));
      this.fading[tr.to].setFade(id, Math.max(1e-4, tr.t));
    }
  }

  /**
   * The farthest level's plain list wears `materials` (the edge-of-view distance dither) while its
   * cell reaches into the fade band; null puts the solid ones back.
   */
  public setFarMaterials(materials: THREE.Material[] | null): void {
    this.steady[this.steady.length - 1].setMaterials(materials);
  }

  public setVisible(v: boolean): void {
    for (const l of this.steady) l.setVisible(v);
    for (const l of this.fading) l.setVisible(v);
  }

  /** Calls `fn` for every instance (id and its current level). */
  public forEach(fn: (id: number, level: number) => void): void {
    for (const [id, level] of this.levelOf) fn(id, level);
  }

  public markUniform(level: number): void {
    this.uniform = level;
  }

  public dispose(): void {
    for (const l of this.steady) l.dispose();
    for (const l of this.fading) l.dispose();
  }
}
