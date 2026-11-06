import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { CaveNetwork } from '../explore/cave/CaveNetwork';
import {
  CaveLayout, LayoutHub, LayoutItem, LayoutTunnel, ItemType, HubKind, TunnelKind,
  layoutDirtyBoxes, makeTunnel, nextLayoutId, prepareLayoutGeometry, tunnelGeometry, hubWater, CRYSTAL_COLORS,
} from '../explore/cave/CaveGen';

export type CaveSelection =
  | { kind: 'hub'; id: string }
  | { kind: 'tunnel'; id: string }
  | { kind: 'item'; id: number }
  | { kind: 'biome'; index: number }
  | null;

/** What a click in the cave view does: pick, add a chamber, connect two chambers, or place an item. */
export type CaveAddMode = 'none' | 'hub' | 'connect' | ItemType;

export const CAVE_ITEM_TYPES: ItemType[] = ['chest', 'ore', 'crystal', 'mushroom', 'ember', 'light', 'stalactite', 'stalagmite', 'pillar', 'drip'];

const ITEM_COLORS: Record<ItemType, number> = {
  chest: 0xfacc15, ore: 0xf97316, crystal: 0x60a5fa, mushroom: 0x2dd4bf, ember: 0xef4444, light: 0xfef08a,
  stalactite: 0xa8a29e, stalagmite: 0x78716c, pillar: 0x57534e, drip: 0x38bdf8,
};
const HUB_COLORS: Record<HubKind, number> = { chamber: 0x38bdf8, grand: 0xa855f7, lake: 0x22d3ee };
const TUNNEL_COLORS: Record<TunnelKind, number> = { ramp: 0x94a3b8, stairs: 0xe2e8f0, drop: 0xf97316, sump: 0x3b82f6, flood: 0x06b6d4 };
const BIOME_COLORS = [0x4ade80, 0x60a5fa, 0xf97316];
const REBUILD_DELAY = 0.35;

interface Handle {
  pos: THREE.Vector3;
  sel: NonNullable<CaveSelection>;
}

export interface CaveEditHooks {
  pushUndo(): void;
  touch(): void;
}

/**
 * Developer cave editor (editor tool 6). Works on a copy of the network's layout: every chamber is a
 * wire ellipse with a handle at its floor, tunnels are polylines with a handle in the middle, items
 * are coloured markers, and the three biome centres are big spheres. Click to pick (the gizmo moves
 * chambers with everything in them, items and biome centres), the panel edits the rest. Edits
 * rebuild live in the worker: only the chunks they touch are re-meshed.
 *
 * Add modes: a chamber where you click (joined to the selected or nearest chamber), a tunnel from
 * the selected chamber to the one you click, or an item on the rock surface under the cursor.
 * "Save to project" writes src/explore/cave/caves.json through the dev server.
 */
export class CaveEditTool {
  public selection: CaveSelection = null;
  public addMode: CaveAddMode = 'none';
  public unsaved = false;
  /** Show the whole network even with other tools. */
  public alwaysShow = false;
  public status = '';
  /** The layout being edited (null until the network has built once). */
  public work: CaveLayout | null = null;

  private visible = false;
  private readonly helpers = new THREE.Group();
  private readonly helperGeos: THREE.BufferGeometry[] = [];
  private readonly lineMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.85 });
  private readonly handleMat = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.9 });
  private readonly biomeMat = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.35, wireframe: true });
  private readonly selMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, wireframe: true });
  private readonly handleGeo = new THREE.OctahedronGeometry(0.6, 0);
  private readonly selMesh = new THREE.Mesh(new THREE.SphereGeometry(1.3, 10, 6), this.selMat);
  private handles: Handle[] = [];
  private readonly gizmo: TransformControls;
  private readonly gizmoTarget = new THREE.Object3D();
  private dragStart = new THREE.Vector3();
  /** Layout the network currently has (or is building): dirty boxes are diffs against it. */
  private sent: CaveLayout | null = null;
  private editVersion = 0;
  private sentVersion = 0;
  private rebuildTimer = -1;
  private helpersDirty = true;

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    private readonly network: CaveNetwork,
    private readonly physics: PhysicsWorld,
    private readonly hooks: CaveEditHooks
  ) {
    this.helpers.name = 'CaveEditorHelpers';
    this.helpers.visible = false;
    this.helpers.renderOrder = 30;
    scene.add(this.helpers);
    this.selMesh.renderOrder = 31;
    this.selMesh.visible = false;
    scene.add(this.selMesh);

    this.gizmo = new TransformControls(camera, dom);
    this.gizmo.setSize(0.9);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      if (dragging) {
        this.hooks.pushUndo();
        this.dragStart.copy(this.gizmoTarget.position);
      } else this.scheduleRebuild(0);
    });
    this.gizmo.addEventListener('objectChange', () => this.applyGizmo());
    scene.add(this.gizmo.getHelper());
    this.gizmo.getHelper().visible = false;
    this.gizmo.enabled = false;
    scene.add(this.gizmoTarget);

    network.onBuilt = (layout) => {
      // Adopt what the worker built unless more edits are already waiting
      if (this.editVersion === this.sentVersion) {
        this.work = structuredClone(layout);
        this.sent = structuredClone(layout);
        this.helpersDirty = true;
        this.validateSelection();
      }
      this.status = '';
      this.hooks.touch();
    };
    if (network.layout) {
      this.work = structuredClone(network.layout);
      this.sent = structuredClone(network.layout);
    }
  }

  public get origin(): THREE.Vector3 {
    return this.network.origin;
  }

  public get busy(): boolean {
    return this.network.busy || this.rebuildTimer >= 0;
  }

  public get stats() {
    return this.network.stats;
  }

  public get chunkCount(): number {
    return this.network.chunkCount;
  }

  public dispose(): void {
    this.gizmo.dispose();
    this.clearHelpers();
    this.helpers.removeFromParent();
    this.selMesh.removeFromParent();
    this.selMesh.geometry.dispose();
    [this.lineMat, this.handleMat, this.biomeMat, this.selMat].forEach((m) => m.dispose());
    this.handleGeo.dispose();
    this.network.onBuilt = null;
  }

  /** Shows the network and the helpers (the cave tool is active) or hides them. */
  public setVisible(tool: boolean, editorActive: boolean): void {
    const show = editorActive && (tool || this.alwaysShow);
    this.network.setEditorView(show);
    this.network.setKeepWorker(editorActive && tool);
    this.visible = editorActive && tool;
    this.helpers.visible = this.visible;
    this.helpersDirty = true;
    if (!this.visible) {
      this.attachGizmo(false);
      this.selMesh.visible = false;
    } else this.select(this.selection);
  }

  // ---------------------------------------------------------------- selection

  public get hub(): LayoutHub | undefined {
    const s = this.selection;
    return s?.kind === 'hub' ? this.work?.hubs.find((h) => h.id === s.id) : undefined;
  }

  public get tunnel(): LayoutTunnel | undefined {
    const s = this.selection;
    return s?.kind === 'tunnel' ? this.work?.tunnels.find((t) => t.id === s.id) : undefined;
  }

  public get item(): LayoutItem | undefined {
    const s = this.selection;
    return s?.kind === 'item' ? this.work?.items.find((i) => i.id === s.id) : undefined;
  }

  private validateSelection(): void {
    const s = this.selection;
    if (!s) return;
    const ok = s.kind === 'hub' ? !!this.hub : s.kind === 'tunnel' ? !!this.tunnel : s.kind === 'item' ? !!this.item : true;
    this.select(ok ? s : null);
  }

  public select(sel: CaveSelection): void {
    this.selection = sel;
    const p = sel ? this.selectionPos(sel) : null;
    if (p && this.visible) {
      this.gizmoTarget.position.copy(p);
      this.selMesh.position.copy(p);
      this.selMesh.visible = true;
      this.attachGizmo(sel!.kind !== 'tunnel');
      this.gizmo.showY = sel!.kind !== 'biome';
    } else {
      this.selMesh.visible = false;
      this.attachGizmo(false);
    }
    this.hooks.touch();
  }

  private attachGizmo(on: boolean): void {
    if (on) {
      this.gizmo.attach(this.gizmoTarget);
      this.gizmo.enabled = true;
      this.gizmo.getHelper().visible = true;
    } else {
      this.gizmo.detach();
      this.gizmo.enabled = false;
      this.gizmo.getHelper().visible = false;
    }
  }

  /** World position of a selection's handle. */
  private selectionPos(sel: NonNullable<CaveSelection>): THREE.Vector3 | null {
    const w = this.work;
    if (!w) return null;
    const o = this.origin;
    switch (sel.kind) {
      case 'hub': {
        const h = w.hubs.find((x) => x.id === sel.id);
        return h ? new THREE.Vector3(h.x + o.x, h.floor + o.y, h.z + o.z) : null;
      }
      case 'item': {
        const it = w.items.find((x) => x.id === sel.id);
        return it ? new THREE.Vector3(it.x + o.x, it.y + o.y, it.z + o.z) : null;
      }
      case 'biome': {
        const b = w.biomes[sel.index];
        return b ? new THREE.Vector3(b.x + o.x, o.y + 25, b.z + o.z) : null;
      }
      case 'tunnel': {
        const hubs = prepareLayoutGeometry(w);
        const t = w.tunnels.find((x) => x.id === sel.id);
        const g = t && tunnelGeometry(hubs, t);
        if (!g) return null;
        const m = g.P(0.5);
        return new THREE.Vector3(m.x + o.x, (g.A.y + g.B.y) / 2 + o.y, m.z + o.z);
      }
    }
  }

  public isGizmoActive(): boolean {
    return this.gizmo.dragging || (this.gizmo.enabled && !!this.gizmo.axis);
  }

  private applyGizmo(): void {
    const w = this.work, sel = this.selection;
    if (!w || !sel) return;
    const o = this.origin;
    const p = this.gizmoTarget.position;
    if (sel.kind === 'hub') {
      const h = this.hub;
      if (!h) return;
      const dx = p.x - o.x - h.x, dy = p.y - o.y - h.floor, dz = p.z - o.z - h.z;
      h.x = r2(h.x + dx);
      h.z = r2(h.z + dz);
      h.floor = r2(h.floor + dy);
      if (h.water !== undefined && h.water !== null) h.water = r2(h.water + dy);
      // Everything in the chamber moves with it
      for (const it of w.items) {
        if (it.hub !== h.id) continue;
        it.x = r2(it.x + dx);
        it.y = r2(it.y + dy);
        it.z = r2(it.z + dz);
      }
    } else if (sel.kind === 'item') {
      const it = this.item;
      if (!it) return;
      it.x = r2(p.x - o.x);
      it.y = r2(p.y - o.y);
      it.z = r2(p.z - o.z);
    } else if (sel.kind === 'biome') {
      const b = w.biomes[sel.index];
      b.x = r2(p.x - o.x);
      b.z = r2(p.z - o.z);
    }
    this.selMesh.position.copy(p);
    this.markEdited(false);
  }

  // ---------------------------------------------------------------- editing

  /** Applies a change to the working layout (one undo step unless `undo` is false) and rebuilds. */
  public edit(fn: (layout: CaveLayout) => void, undo = true): void {
    if (!this.work) return;
    if (undo) this.hooks.pushUndo();
    fn(this.work);
    this.markEdited(true);
    this.select(this.selection);
  }

  private markEdited(rebuildSoon: boolean): void {
    this.editVersion++;
    this.unsaved = true;
    this.helpersDirty = true;
    if (rebuildSoon) this.scheduleRebuild(REBUILD_DELAY);
    this.hooks.touch();
  }

  private scheduleRebuild(delay: number): void {
    this.rebuildTimer = delay;
  }

  private flushRebuild(): void {
    this.rebuildTimer = -1;
    const w = this.work;
    if (!w) return;
    const dirty = this.sent ? layoutDirtyBoxes(this.sent, w, this.entrancesIn()) : null;
    this.sent = structuredClone(w);
    this.sentVersion = this.editVersion;
    this.status = 'Перебудова…';
    this.network.rebuild(w, dirty);
    this.hooks.touch();
  }

  private entrancesIn() {
    return this.network.entrancesIn;
  }

  /** Replaces the layout (undo / redo / load): a full rebuild if the biomes moved, else partial. */
  public setLayout(layout: CaveLayout): void {
    this.work = structuredClone(layout);
    this.markEdited(false);
    this.scheduleRebuild(0);
    this.validateSelection();
  }

  /** A fresh procedural network from a seed (replaces every edit). */
  public regenerate(seed: number): void {
    this.hooks.pushUndo();
    this.status = 'Генерація…';
    this.sent = null;
    this.editVersion++;
    this.sentVersion = this.editVersion;
    this.unsaved = true;
    this.select(null);
    this.network.rebuild(null, null, seed);
    this.hooks.touch();
  }

  public deleteSelected(): void {
    const sel = this.selection;
    if (!sel || !this.work) return;
    if (sel.kind === 'hub') {
      const h = this.hub;
      if (h?.entrance) {
        this.status = 'Камеру входу не можна видалити';
        this.hooks.touch();
        return;
      }
      this.edit((w) => {
        w.hubs = w.hubs.filter((x) => x.id !== sel.id);
        w.tunnels = w.tunnels.filter((t) => t.a !== sel.id && t.b !== sel.id);
        w.items = w.items.filter((i) => i.hub !== sel.id);
      });
    } else if (sel.kind === 'tunnel') {
      this.edit((w) => {
        w.tunnels = w.tunnels.filter((t) => t.id !== sel.id);
        for (const h of w.hubs) if (h.shelf === sel.id) h.shelf = null;
      });
    } else if (sel.kind === 'item') {
      this.edit((w) => (w.items = w.items.filter((i) => i.id !== sel.id)));
    }
    this.select(null);
  }

  public duplicateSelected(): void {
    const it = this.item;
    if (!it || !this.work) return;
    const copy = { ...structuredClone(it), id: this.work.nextItem, x: r2(it.x + 1.5) };
    this.edit((w) => {
      w.nextItem++;
      w.items.push(copy);
    });
    this.select({ kind: 'item', id: copy.id });
  }

  // ---------------------------------------------------------------- picking and placing

  /** Left click in the cave view. Returns true when it was handled. */
  public pointerDown(raycaster: THREE.Raycaster, ndc: THREE.Vector2): boolean {
    if (!this.visible || !this.work || this.isGizmoActive()) return false;
    const mode = this.addMode;
    if (mode === 'none' || mode === 'connect') {
      const picked = this.pickHandle(ndc);
      if (mode === 'connect' && picked?.kind === 'hub') return this.connectTo(picked.id);
      this.select(picked);
      return true;
    }
    const hit = this.surfaceHit(raycaster.ray);
    if (mode === 'hub') {
      const o = this.origin;
      // On the rock under the cursor, or 15 m in front of the camera
      const p = hit ? hit.point.clone() : raycaster.ray.at(15, new THREE.Vector3());
      this.addHub(p.x - o.x, p.y - o.y, p.z - o.z);
      return true;
    }
    if (!hit) {
      this.status = 'Наведіть на камінь печери';
      this.hooks.touch();
      return true;
    }
    this.addItem(mode, hit.point, hit.normal);
    return true;
  }

  /** Nearest handle within ~16 px of the cursor (the closest to the camera on ties). */
  private pickHandle(ndc: THREE.Vector2): CaveSelection {
    const v = new THREE.Vector3();
    let best: Handle | null = null;
    let bestScore = Infinity;
    const halfW = window.innerWidth / 2, halfH = window.innerHeight / 2;
    for (const h of this.handles) {
      v.copy(h.pos).project(this.camera);
      if (v.z < -1 || v.z > 1) continue;
      const px = Math.hypot((v.x - ndc.x) * halfW, (v.y - ndc.y) * halfH);
      if (px > 16) continue;
      const score = px + h.pos.distanceTo(this.camera.position) * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = h;
      }
    }
    return best ? best.sel : null;
  }

  /**
   * First rock surface the ray meets from the air side (chunk faces point into the air; seen from
   * outside the cave the ray first passes through the back of the ceiling, which is skipped).
   */
  private surfaceHit(ray: THREE.Ray): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const from = ray.origin.clone();
    let left = 600;
    for (let i = 0; i < 12 && left > 0; i++) {
      const r = this.physics.castRayAndGetNormal(from, ray.direction, left);
      if (!r) return null;
      if (r.normal.dot(ray.direction) < 0 && this.network.contains(r.point)) return { point: r.point, normal: r.normal };
      const step = r.point.distanceTo(from) + 0.05;
      from.addScaledVector(ray.direction, step);
      left -= step;
    }
    return null;
  }

  private nearestHub(x: number, z: number, skip?: string): LayoutHub | undefined {
    let best: LayoutHub | undefined;
    let bestD = Infinity;
    for (const h of this.work?.hubs ?? []) {
      if (h.id === skip) continue;
      const d = Math.hypot(h.x - x, h.z - z);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  private addHub(x: number, y: number, z: number): void {
    const w = this.work!;
    const from = this.hub ?? this.nearestHub(x, z);
    const hub: LayoutHub = { id: nextLayoutId('h', w.hubs), x: r2(x), z: r2(z), floor: r2(y), rx: 9, ry: 6, rz: 7.5, rot: 0, kind: 'chamber' };
    this.edit((l) => {
      l.hubs.push(hub);
      if (from) l.tunnels.push(makeTunnel(l, from, hub));
    });
    this.select({ kind: 'hub', id: hub.id });
  }

  private connectTo(id: string): boolean {
    const a = this.hub, w = this.work!;
    const b = w.hubs.find((h) => h.id === id);
    if (!a || !b || a === b) {
      this.select({ kind: 'hub', id });
      return true;
    }
    if (w.tunnels.some((t) => (t.a === a.id && t.b === b.id) || (t.a === b.id && t.b === a.id))) {
      this.status = 'Ці камери вже з’єднані';
      this.select({ kind: 'hub', id });
      return true;
    }
    const t = makeTunnel(w, a, b);
    this.edit((l) => l.tunnels.push(t));
    this.select({ kind: 'tunnel', id: t.id });
    return true;
  }

  private addItem(type: ItemType, point: THREE.Vector3, normal: THREE.Vector3): void {
    const w = this.work!;
    const o = this.origin;
    const x = r2(point.x - o.x), y = point.y - o.y, z = r2(point.z - o.z);
    const ceiling = normal.y < -0.3;
    const hub = this.nearestHub(x, z)?.id;
    const it: LayoutItem = { id: w.nextItem, t: type, x, y: r2(y), z, hub };
    switch (type) {
      case 'chest': {
        const used = new Set(w.items.filter((i) => i.t === 'chest').map((i) => i.chest));
        it.chest = ['cave1', 'cave2', 'cave3'].find((c) => !used.has(c)) ?? 'cave1';
        it.yaw = 0;
        break;
      }
      case 'ore':
        it.ore = 'iron';
        break;
      case 'crystal':
        it.color = 0;
        it.size = 1;
        break;
      case 'mushroom':
        it.glow = true;
        break;
      case 'light':
        it.y = r2(y + (ceiling ? -1 : 1.5));
        it.rgb = [1, 0.85, 0.6];
        it.range = 8;
        it.intensity = 1;
        break;
      case 'stalactite':
        it.y = r2(y + 0.25);
        it.len = 2.2;
        it.r = 0.45;
        it.bx = 0;
        it.bz = 0;
        break;
      case 'stalagmite':
        it.y = r2(y - 0.25);
        it.len = 1.4;
        it.r = 0.5;
        break;
      case 'pillar':
        it.r = 1.5;
        break;
      case 'drip':
        it.y = r2(y - 0.05);
        break;
      default:
        break;
    }
    this.edit((l) => {
      l.nextItem++;
      l.items.push(it);
    });
    this.select({ kind: 'item', id: it.id });
  }

  // ---------------------------------------------------------------- saving

  public toJson(): string {
    return JSON.stringify(this.work);
  }

  /** Writes caves.json through the dev server; falls back to downloading the file. */
  public async saveToProject(): Promise<'saved' | 'downloaded' | 'empty'> {
    if (!this.work) return 'empty';
    const json = this.toJson();
    try {
      const res = await fetch('/__dev/caves', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
      if (res.ok) {
        this.unsaved = false;
        this.hooks.touch();
        return 'saved';
      }
    } catch {
      // No dev server: download instead
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'caves.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return 'downloaded';
  }

  /** Where the fly camera should go to see the whole network (above its centre, looking down). */
  public overviewPosition(): THREE.Vector3 {
    return this.origin.clone().add(new THREE.Vector3(0, 150, 160));
  }

  /** World position of the selection (for focusing the camera). */
  public selectedWorldPos(): THREE.Vector3 | null {
    return this.selection ? this.selectionPos(this.selection) : null;
  }

  // ---------------------------------------------------------------- frame

  public update(dt: number): void {
    if (this.rebuildTimer >= 0 && !this.gizmo.dragging) {
      this.rebuildTimer -= dt;
      if (this.rebuildTimer < 0) this.flushRebuild();
    }
    if (this.visible && this.helpersDirty) this.rebuildHelpers();
  }

  private clearHelpers(): void {
    for (const c of [...this.helpers.children]) c.removeFromParent();
    this.helperGeos.forEach((g) => g.dispose());
    this.helperGeos.length = 0;
  }

  /** Wire chambers, tunnel lines, handles and item markers from the working layout. */
  private rebuildHelpers(): void {
    this.helpersDirty = false;
    this.clearHelpers();
    this.handles = [];
    const w = this.work;
    if (!w) return;
    const o = this.origin;
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number) => {
      c.setHex(color);
      pos.push(ax + o.x, ay + o.y, az + o.z, bx + o.x, by + o.y, bz + o.z);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };

    for (const h of w.hubs) {
      const color = h.entrance ? 0xfbbf24 : HUB_COLORS[h.kind];
      const cos = Math.cos(h.rot), sin = Math.sin(h.rot);
      const at = (a: number, frac: number) => {
        const lx = Math.cos(a) * h.rx * frac, lz = Math.sin(a) * h.rz * frac;
        return [h.x + lx * cos - lz * sin, h.z + lx * sin + lz * cos];
      };
      const N = 28;
      for (let i = 0; i < N; i++) {
        const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
        const [x0, z0] = at(a0, 1), [x1, z1] = at(a1, 1);
        seg(x0, h.floor, z0, x1, h.floor, z1, color);
        // Vertical outline along the long axis
        const y0 = h.floor + Math.sin(a0) * h.ry, y1 = h.floor + Math.sin(a1) * h.ry;
        if (y0 >= h.floor - 0.01 && y1 >= h.floor - 0.01) {
          const [vx0, vz0] = at(0, Math.cos(a0)), [vx1, vz1] = at(0, Math.cos(a1));
          seg(vx0, y0, vz0, vx1, y1, vz1, color);
        }
      }
      const lvl = hubWater(h);
      if (!Number.isNaN(lvl)) {
        for (let i = 0; i < N; i++) {
          const [x0, z0] = at((i / N) * Math.PI * 2, 0.62), [x1, z1] = at(((i + 1) / N) * Math.PI * 2, 0.62);
          seg(x0, lvl, z0, x1, lvl, z1, 0x22d3ee);
        }
      }
      this.handles.push({ pos: new THREE.Vector3(h.x + o.x, h.floor + o.y, h.z + o.z), sel: { kind: 'hub', id: h.id } });
    }

    const hubs = prepareLayoutGeometry(w);
    for (const t of w.tunnels) {
      const g = tunnelGeometry(hubs, t);
      if (!g) continue;
      const color = TUNNEL_COLORS[t.kind];
      const S = 16;
      let prev = g.P(0);
      for (let i = 1; i <= S; i++) {
        const u = i / S;
        const p = g.P(u);
        seg(prev.x, g.A.y + (g.B.y - g.A.y) * ((i - 1) / S) + 1, prev.z, p.x, g.A.y + (g.B.y - g.A.y) * u + 1, p.z, color);
        prev = p;
      }
      const m = g.P(0.5);
      this.handles.push({ pos: new THREE.Vector3(m.x + o.x, (g.A.y + g.B.y) / 2 + 1 + o.y, m.z + o.z), sel: { kind: 'tunnel', id: t.id } });
    }

    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const lines = new THREE.LineSegments(geo, this.lineMat);
      lines.frustumCulled = false;
      lines.renderOrder = 30;
      this.helpers.add(lines);
      this.helperGeos.push(geo);
    }

    // Handles and item markers: one instanced mesh, coloured per instance
    const marks: { p: THREE.Vector3; color: number; s: number }[] = [];
    for (const h of this.handles) {
      const sel = h.sel;
      if (sel.kind === 'hub') {
        const hub = hubs.get(sel.id)!;
        marks.push({ p: h.pos, color: hub.entrance ? 0xfbbf24 : HUB_COLORS[hub.kind], s: 1.6 });
      } else marks.push({ p: h.pos, color: TUNNEL_COLORS[w.tunnels.find((t) => t.id === (sel as { id: string }).id)!.kind], s: 1.1 });
    }
    for (const it of w.items) {
      const p = new THREE.Vector3(it.x + o.x, it.y + o.y, it.z + o.z);
      const color = it.t === 'crystal' ? new THREE.Color(...(CRYSTAL_COLORS[it.color ?? 0] ?? CRYSTAL_COLORS[0])).getHex() : ITEM_COLORS[it.t];
      marks.push({ p, color, s: it.t === 'pillar' ? 1.2 : 0.6 });
      this.handles.push({ pos: p, sel: { kind: 'item', id: it.id } });
    }
    if (marks.length) {
      const mesh = new THREE.InstancedMesh(this.handleGeo, this.handleMat, marks.length);
      const m = new THREE.Matrix4();
      const sc = new THREE.Vector3();
      const q = new THREE.Quaternion();
      marks.forEach((k, i) => {
        mesh.setMatrixAt(i, m.compose(k.p, q, sc.setScalar(k.s)));
        mesh.setColorAt(i, c.setHex(k.color));
      });
      mesh.frustumCulled = false;
      mesh.renderOrder = 31;
      this.helpers.add(mesh);
      // The instanced mesh shares handleGeo (disposed with the tool), nothing else to free
    }

    // Biome centres: big wire spheres high above the network
    w.biomes.forEach((b, i) => {
      const geo = new THREE.SphereGeometry(6, 12, 8);
      const mat = this.biomeMat.clone();
      mat.color.setHex(BIOME_COLORS[i]);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(b.x + o.x, o.y + 25, b.z + o.z);
      mesh.renderOrder = 30;
      this.helpers.add(mesh);
      this.helperGeos.push(geo);
      // The cloned material goes with the helper on the next rebuild
      mesh.addEventListener('removed', () => mat.dispose());
      this.handles.push({ pos: mesh.position.clone(), sel: { kind: 'biome', index: i } });
    });
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100;
