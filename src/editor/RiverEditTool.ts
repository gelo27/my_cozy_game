import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { TerrainSystem } from '../world/TerrainSystem';
import type { RiverSystem } from '../world/rivers/RiverSystem';
import { riverWorld, stringifyRivers } from '../world/rivers/RiverWorld';
import type { RiverDef, RiverPoint } from '../world/rivers/RiverTypes';

export type RiverKind = 'river' | 'stream';

/** Live edits re-carve the terrain at most this often while dragging (s). */
const DRAG_REBUILD_INTERVAL = 0.12;

const PRESETS: Record<RiverKind, { width: number; depth: number; name: string }> = {
  river: { width: 7, depth: 1.6, name: 'Річка' },
  stream: { width: 2.6, depth: 0.6, name: 'Струмок' },
};

const COLORS = { line: 0x38bdf8, foam: 0xf97316, point: 0x38bdf8, selected: 0xfacc15, fall: 0xf97316, pinned: 0xa855f7, dim: 0x64748b };

interface Hooks {
  pushUndo(): void;
  touch(): void;
}

/**
 * Editor tool for rivers, streams and waterfalls (key 5):
 * - click the terrain to add a point at the end of the selected river (or start a new river);
 *   with the first point selected, the new point goes before it; Shift+click inserts a point into
 *   the nearest stretch;
 * - click a handle to select it and drag it with the gizmo (the Y arrow pins the water surface);
 * - every edit re-samples the spline and re-carves only the terrain it covers, live;
 * - "Save to project" writes src/world/rivers/rivers.json through the dev server.
 */
export class RiverEditTool {
  public selectedRiver: string | null = null;
  public selectedPoint = -1;
  /** True when rivers changed since they were last saved to the project file. */
  public unsaved = false;
  public visible = false;

  private readonly helpers = new THREE.Group();
  private readonly handleGeo = new THREE.SphereGeometry(0.55, 14, 10);
  private readonly handleMats = new Map<number, THREE.MeshBasicMaterial>();
  private readonly gizmo: TransformControls;
  private readonly target = new THREE.Object3D();
  private helperKey = '';
  private rebuildPending: string | null = null;
  private rebuildTimer = 0;

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    dom: HTMLElement,
    private readonly rivers: RiverSystem,
    private readonly terrain: TerrainSystem,
    private readonly hooks: Hooks
  ) {
    this.helpers.name = 'RiverEditorHelpers';
    this.helpers.visible = false;
    scene.add(this.helpers);
    scene.add(this.target);

    this.gizmo = new TransformControls(camera, dom);
    this.gizmo.setSize(0.7);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      if ((e as unknown as { value: boolean }).value) {
        this.hooks.pushUndo();
      } else {
        this.flushRebuild();
        this.terrain.commit();
        this.hooks.touch();
      }
    });
    this.gizmo.addEventListener('objectChange', () => this.applyGizmo());
    scene.add(this.gizmo.getHelper());
    this.gizmo.getHelper().visible = false;
    this.gizmo.enabled = false;
  }

  public dispose(): void {
    this.gizmo.dispose();
  }

  // ---------------------------------------------------------------- state

  public get river(): RiverDef | undefined {
    return riverWorld.defs.find((d) => d.id === this.selectedRiver);
  }

  public get point(): RiverPoint | undefined {
    return this.river?.points[this.selectedPoint];
  }

  /** True while the gizmo is hovered or dragged, so clicks belong to it. */
  public get busy(): boolean {
    return this.gizmo.dragging || !!this.gizmo.axis;
  }

  public setVisible(v: boolean): void {
    this.visible = v;
    this.helpers.visible = v;
    this.helperKey = '';
    this.attachGizmo();
  }

  public select(riverId: string | null, point = -1): void {
    this.selectedRiver = riverId;
    this.selectedPoint = riverId ? point : -1;
    this.helperKey = '';
    this.attachGizmo();
    this.hooks.touch();
  }

  // ---------------------------------------------------------------- editing

  /** One undo step before a continuous edit (slider drag); follow with `undo = false` edits. */
  public beginEdit(): void {
    this.hooks.pushUndo();
  }

  public newRiver(kind: RiverKind, first?: { x: number; z: number }): RiverDef {
    const p = PRESETS[kind];
    const n = riverWorld.defs.filter((d) => d.name.startsWith(p.name)).length + 1;
    const def: RiverDef = {
      id: `${kind}_${Date.now().toString(36)}`,
      name: `${p.name} ${n}`,
      width: p.width,
      depth: p.depth,
      points: first ? [{ x: first.x, z: first.z }] : [],
    };
    this.hooks.pushUndo();
    this.rivers.addRiver(def);
    this.unsaved = true;
    this.select(def.id, first ? 0 : -1);
    return def;
  }

  public deleteRiver(id: string): void {
    this.hooks.pushUndo();
    this.rivers.removeRiver(id);
    this.terrain.commit();
    this.unsaved = true;
    if (this.selectedRiver === id) this.select(null);
    else this.hooks.touch();
  }

  /** Changes river-wide settings (width, depth, name). */
  public setRiver(patch: Partial<Pick<RiverDef, 'name' | 'width' | 'depth'>>, undo = true): void {
    const r = this.river;
    if (!r) return;
    if (undo) this.hooks.pushUndo();
    Object.assign(r, patch);
    if (patch.name === undefined || Object.keys(patch).length > 1) this.changed(r.id, !undo);
    this.unsaved = true;
    this.hooks.touch();
  }

  /** Changes the selected point. `undefined` values clear an override (back to auto). */
  public setPoint(patch: Partial<RiverPoint>, undo = true): void {
    const r = this.river;
    const p = this.point;
    if (!r || !p) return;
    if (undo) this.hooks.pushUndo();
    for (const [k, v] of Object.entries(patch) as [keyof RiverPoint, number | undefined][]) {
      if (v === undefined || (k === 'fall' && !v)) delete p[k];
      else p[k] = v;
    }
    this.changed(r.id, !undo);
    this.unsaved = true;
    this.hooks.touch();
  }

  public deletePoint(): void {
    const r = this.river;
    if (!r || !this.point) return;
    this.hooks.pushUndo();
    r.points.splice(this.selectedPoint, 1);
    this.changed(r.id);
    this.terrain.commit();
    this.unsaved = true;
    this.select(r.id, Math.min(this.selectedPoint, r.points.length - 1));
  }

  /** Current surface height at the selected point (pinned or automatic). */
  public pointSurface(index = this.selectedPoint): number | null {
    const s = this.selectedRiver ? riverWorld.get(this.selectedRiver) : undefined;
    const k = s?.pointSample[index];
    return s && k !== undefined && s.samples[k] ? s.samples[k].s : null;
  }

  public pointPosition(index = this.selectedPoint): THREE.Vector3 | null {
    const p = this.river?.points[index];
    if (!p) return null;
    const y = this.pointSurface(index) ?? this.terrain.getHeight(p.x, p.z);
    return new THREE.Vector3(p.x, y, p.z);
  }

  // ---------------------------------------------------------------- save

  public toJson(): string {
    return stringifyRivers(riverWorld.defs);
  }

  /** Writes rivers.json through the dev server; falls back to downloading the file. */
  public async saveToProject(): Promise<'saved' | 'downloaded'> {
    const json = this.toJson();
    try {
      const res = await fetch('/__dev/rivers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
      if (res.ok) {
        this.unsaved = false;
        this.hooks.touch();
        return 'saved';
      }
    } catch {
      // No dev server (production build with ?dev): download instead
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'rivers.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return 'downloaded';
  }

  // ---------------------------------------------------------------- input

  /** Left click in the viewport with the river tool. */
  public pointerDown(raycaster: THREE.Raycaster, hit: THREE.Vector3 | null, shift: boolean): void {
    const handle = this.pickHandle(raycaster);
    if (handle) {
      this.select(handle.river, handle.index);
      return;
    }
    if (!hit) return;
    const r = this.river;
    if (!r) {
      this.newRiver('river', hit);
      return;
    }
    this.hooks.pushUndo();
    const p: RiverPoint = { x: round(hit.x), z: round(hit.z) };
    let index: number;
    if (shift && r.points.length >= 2) {
      index = nearestSegment(r.points, hit.x, hit.z) + 1;
    } else if (this.selectedPoint === 0 && r.points.length > 1) {
      index = 0;
    } else {
      index = r.points.length;
    }
    r.points.splice(index, 0, p);
    this.changed(r.id);
    this.terrain.commit();
    this.unsaved = true;
    this.select(r.id, index);
  }

  public keyDown(e: KeyboardEvent): boolean {
    if (e.code === 'Delete' || e.code === 'Backspace') {
      this.deletePoint();
      return true;
    }
    if (e.code === 'Escape') {
      this.select(this.selectedRiver, -1);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- frame

  public update(dt: number): void {
    if (this.rebuildPending) {
      this.rebuildTimer -= dt;
      if (this.rebuildTimer <= 0) this.flushRebuild();
    }
    if (!this.visible) return;
    const key = `${riverWorld.revision}|${this.selectedRiver}|${this.selectedPoint}|${riverWorld.defs.length}`;
    if (key !== this.helperKey) {
      this.helperKey = key;
      this.rebuildHelpers();
    }
  }

  // ---------------------------------------------------------------- internals

  /** Live rebuild: immediate for clicks, throttled while dragging. */
  private changed(id: string, throttled = this.gizmo.dragging): void {
    if (this.rebuildPending && this.rebuildPending !== id) this.flushRebuild();
    this.rebuildPending = id;
    if (!throttled) this.flushRebuild();
    else if (this.rebuildTimer <= 0) this.rebuildTimer = DRAG_REBUILD_INTERVAL;
  }

  private flushRebuild(): void {
    const id = this.rebuildPending;
    this.rebuildPending = null;
    this.rebuildTimer = 0;
    if (id) this.rivers.updateRiver(id);
    if (!this.gizmo.dragging) this.attachGizmo();
  }

  private applyGizmo(): void {
    const p = this.point;
    const r = this.river;
    if (!p || !r) return;
    const t = this.target.position;
    if (this.gizmo.axis === 'Y') {
      p.y = round(t.y);
    } else {
      p.x = round(t.x);
      p.z = round(t.z);
    }
    this.unsaved = true;
    this.changed(r.id, true);
  }

  private attachGizmo(): void {
    const pos = this.visible ? this.pointPosition() : null;
    if (!pos) {
      this.gizmo.detach();
      this.gizmo.enabled = false;
      this.gizmo.getHelper().visible = false;
      return;
    }
    this.target.position.copy(pos);
    this.target.updateMatrixWorld();
    if (this.gizmo.object !== this.target) this.gizmo.attach(this.target);
    this.gizmo.enabled = true;
    this.gizmo.getHelper().visible = true;
  }

  private pickHandle(raycaster: THREE.Raycaster): { river: string; index: number } | null {
    const hits = raycaster.intersectObjects(this.helpers.children.filter((c) => c.userData.handle), false);
    const h = hits[0]?.object.userData;
    return h ? { river: h.river, index: h.index } : null;
  }

  private material(color: number): THREE.MeshBasicMaterial {
    let m = this.handleMats.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
      this.handleMats.set(color, m);
    }
    return m;
  }

  /** Centre lines, channel edges and point handles; rebuilt only when something changed. */
  private rebuildHelpers(): void {
    for (const c of [...this.helpers.children]) {
      this.helpers.remove(c);
      if (c instanceof THREE.Line || c instanceof THREE.LineSegments) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    }
    for (const river of riverWorld.all()) {
      const selected = river.def.id === this.selectedRiver;
      const S = river.samples;
      if (S.length >= 2) {
        const pos: number[] = [];
        const col: number[] = [];
        const c = new THREE.Color();
        for (const q of S) {
          pos.push(q.x, q.s + 0.15, q.z);
          c.setHex(selected ? COLORS.line : COLORS.dim).lerp(new THREE.Color(COLORS.foam), q.foam);
          col.push(c.r, c.g, c.b);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
        line.renderOrder = 30;
        this.helpers.add(line);

        if (selected) {
          // Channel edges
          const edge: number[] = [];
          for (let k = 0; k < S.length - 1; k++) {
            for (const side of [-1, 1]) {
              const a = S[k], b = S[k + 1];
              edge.push(a.x - a.tz * a.hw * side, a.s + 0.1, a.z + a.tx * a.hw * side);
              edge.push(b.x - b.tz * b.hw * side, b.s + 0.1, b.z + b.tx * b.hw * side);
            }
          }
          const eg = new THREE.BufferGeometry();
          eg.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
          const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.5, depthTest: false }));
          edges.renderOrder = 30;
          this.helpers.add(edges);
        }
      }

      river.def.points.forEach((p, i) => {
        const k = river.pointSample[i];
        const y = k !== undefined && S[k] ? S[k].s : this.terrain.getHeight(p.x, p.z);
        const isSel = selected && i === this.selectedPoint;
        const color = isSel ? COLORS.selected : !selected ? COLORS.dim : p.fall ? COLORS.fall : p.y !== undefined ? COLORS.pinned : COLORS.point;
        const m = new THREE.Mesh(this.handleGeo, this.material(color));
        m.position.set(p.x, y + 0.5, p.z);
        m.scale.setScalar(isSel ? 1.25 : i === 0 ? 1.1 : 0.85);
        m.renderOrder = 31;
        m.userData = { handle: true, river: river.def.id, index: i };
        this.helpers.add(m);
      });
    }
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Index of the control-point segment closest to (x, z). */
function nearestSegment(points: RiverPoint[], x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / Math.max(1e-6, dx * dx + dz * dz)));
    const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
