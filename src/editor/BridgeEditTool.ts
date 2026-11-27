import * as THREE from 'three';
import type { BridgeSystem } from '../world/BridgeSystem';
import {
  BRIDGE_DEFAULTS, BRIDGE_LANDING_LIFT, MAX_BRIDGES, MAX_BRIDGE_SPAN, MIN_BRIDGE_SPAN,
  bridgeSpan, isBridgeDef, type BridgeDef, type BridgeSettings,
} from '../world/BridgeTypes';

type End = 'a' | 'b';
type Draft = BridgeSettings & { id: string; a: BridgeDef['a'] | null; b: BridgeDef['b'] | null };
type BridgeState = BridgeDef | undefined;

export class BridgeEditTool {
  public draft: Draft = this.newDraft();
  public selected: string | null = null;
  public picking: End | null = 'a';
  public edited = false;

  private readonly helpers = new THREE.Group();
  private readonly markerGeometry = new THREE.SphereGeometry(0.12, 10, 8);
  private readonly a = this.makeMarker(0x38bdf8);
  private readonly b = this.makeMarker(0xfbbf24);
  private readonly aim = this.makeMarker(0xffffff);
  private preview: ReturnType<BridgeSystem['preview']> | null = null;
  private hidden: string | null = null;
  private previewDirty = true;

  constructor(
    scene: THREE.Scene,
    private readonly bridges: BridgeSystem,
    private readonly touch: () => void,
    private readonly record: (label: string, id: string, before: BridgeState) => void,
  ) {
    this.helpers.name = 'BridgeEditorPreview';
    this.helpers.visible = false;
    this.helpers.add(this.a, this.b, this.aim);
    scene.add(this.helpers);
  }

  private makeMarker(color: number): THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> {
    const marker = new THREE.Mesh(this.markerGeometry, new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }));
    marker.renderOrder = 22;
    marker.visible = false;
    return marker;
  }

  private newDraft(settings: BridgeSettings = BRIDGE_DEFAULTS): Draft {
    return { ...settings, id: `bridge_${THREE.MathUtils.generateUUID()}`, a: null, b: null };
  }

  public get span(): number {
    return this.draft.a && this.draft.b ? bridgeSpan(this.draft.a, this.draft.b) : 0;
  }

  public get definition(): BridgeDef | undefined {
    return isBridgeDef(this.draft) ? this.draft : undefined;
  }

  public get list(): BridgeDef[] {
    return this.bridges.serialize();
  }

  public get atLimit(): boolean {
    return !this.selected && this.list.length >= MAX_BRIDGES;
  }

  public get spanInvalid(): boolean {
    return !!this.draft.a && !!this.draft.b && (this.span < MIN_BRIDGE_SPAN || this.span > MAX_BRIDGE_SPAN);
  }

  public get canApply(): boolean {
    return !this.picking && this.edited && !this.atLimit && !!this.definition;
  }

  public setVisible(visible: boolean): void {
    if (this.helpers.visible === visible) return;
    this.helpers.visible = visible;
    this.previewDirty = true;
    if (!visible) {
      this.clearPreview();
      this.aim.visible = false;
    }
  }

  public select(id: string | null): void {
    const def = id ? this.bridges.get(id) : undefined;
    this.selected = def?.id ?? null;
    this.draft = def ?? this.newDraft(this.draft);
    this.picking = def ? null : 'a';
    this.edited = false;
    this.changed();
  }

  public reset(): void {
    this.draft = this.newDraft();
    this.select(null);
  }

  public beginPick(end: End): void {
    this.picking = end;
    this.touch();
  }

  public cancel(): void {
    if (this.picking && (this.selected || (this.draft.a && this.draft.b))) {
      this.picking = null;
      this.touch();
      return;
    }
    this.select(this.selected);
  }

  public pointerDown(hit: THREE.Vector3): void {
    if (!this.picking || this.atLimit) return;
    const end = this.picking;
    this.draft = {
      ...this.draft,
      [end]: { x: hit.x, y: hit.y + BRIDGE_LANDING_LIFT, z: hit.z },
    };
    this.picking = this.draft.a ? this.draft.b ? null : 'b' : 'a';
    this.edited = true;
    this.changed();
  }

  public setSettings(settings: Partial<BridgeSettings>): void {
    this.draft = { ...this.draft, ...settings };
    this.edited = true;
    this.changed();
  }

  public setHeight(end: End, y: number): void {
    const point = this.draft[end];
    if (!point || !Number.isFinite(y)) return;
    this.draft = { ...this.draft, [end]: { ...point, y: THREE.MathUtils.clamp(y, -256, 256) } };
    this.edited = true;
    this.changed();
  }

  public apply(): void {
    const def = this.definition;
    if (!def || !this.canApply) return;
    const before = this.bridges.get(def.id);
    this.clearPreview();
    this.bridges.set(def.id, def);
    this.record(before ? 'Змінено міст' : 'Збудовано міст', def.id, before);
    this.select(def.id);
  }

  public deleteSelected(): void {
    const id = this.selected;
    const before = id ? this.bridges.get(id) : undefined;
    if (!before) return;
    this.clearPreview();
    this.bridges.set(before.id);
    this.record('Видалено міст', before.id, before);
    this.select(null);
  }

  public restore(id: string, def: BridgeState): void {
    this.clearPreview();
    this.bridges.set(id, def);
    this.select(def?.id ?? null);
  }

  public update(hit: THREE.Vector3 | null): void {
    if (!this.helpers.visible) return;
    this.aim.visible = !!this.picking && !!hit;
    if (this.aim.visible && hit) {
      this.aim.position.copy(hit);
      this.aim.position.y += BRIDGE_LANDING_LIFT + 0.06;
    }
    if (!this.previewDirty) return;
    this.previewDirty = false;
    this.clearPreview();
    this.positionMarker(this.a, this.draft.a);
    this.positionMarker(this.b, this.draft.b);
    const def = this.definition;
    if (!def || !this.edited) return;
    if (this.selected) {
      this.hidden = this.selected;
      this.bridges.setVisible(this.hidden, false);
    }
    this.preview = this.bridges.preview(def);
    this.helpers.add(this.preview);
  }

  private positionMarker(marker: THREE.Mesh, point: BridgeDef['a'] | null): void {
    marker.visible = !!point;
    if (point) marker.position.set(point.x, point.y + 0.06, point.z);
  }

  private changed(): void {
    this.previewDirty = true;
    this.touch();
  }

  private clearPreview(): void {
    if (this.hidden) this.bridges.setVisible(this.hidden, true);
    if (this.preview) this.bridges.releaseMesh(this.preview);
    this.hidden = null;
    this.preview = null;
  }

  public dispose(): void {
    this.clearPreview();
    this.helpers.removeFromParent();
    this.markerGeometry.dispose();
    for (const marker of [this.a, this.b, this.aim]) marker.material.dispose();
  }
}
