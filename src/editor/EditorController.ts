import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { InputManager } from '../input/InputManager';
import { TerrainSystem, TerrainBrushKind } from '../world/TerrainSystem';
import { PropSystem, PROP_DEF_MAP } from '../world/PropSystem';
import { HEDGE_TYPE, snapHedge } from '../world/Hedge';
import { ALGAE_DEFAULT_LINKS, LILY } from '../world/AlgaeChains';
import { WEB_DEFAULTS, WebParams, clampWeb } from '../world/SpiderWebs';
import { TerrainTileType } from '../terrain/types/TerrainTypes';
import { RiverEditTool } from './RiverEditTool';
import type { RiverSystem } from '../world/rivers/RiverSystem';
import { riverWorld, stringifyRivers } from '../world/rivers/RiverWorld';
import type { RiverDef } from '../world/rivers/RiverTypes';
import { CaveEditTool } from './CaveEditTool';
import type { CaveNetwork } from '../explore/cave/CaveNetwork';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { PestKind, PestSystem } from '../gameplay/Pests';
import { worldSettings } from '../world/WorldSettings';
import { duckweed } from '../world/Duckweed';

export type EditorTool = 'select' | 'place' | 'sculpt' | 'paint' | 'river' | 'cave' | 'enemy' | 'duckweed' | 'scatter';

/** Where the object brush may put things: dry land, under water, or both. */
export type ScatterWhere = 'land' | 'water' | 'any';

/** Props the object brush can scatter (webs need a passage to span, stations are one-offs). */
export function isScatterable(type: string): boolean {
  const def = PROP_DEF_MAP.get(type);
  return !!def && !def.web && def.category !== 'stations';
}

export interface EditorState {
  tool: EditorTool;
  sculptKind: TerrainBrushKind;
  paintTile: TerrainTileType;
  paintFill: boolean;
  /** Duckweed brush: clears the cover instead of growing it. */
  duckweedErase: boolean;
  /** Duckweed brush: how fast the centre fills to a full carpet (1 = in a second). */
  duckweedRate: number;
  placeType: string;
  placeScale: number;
  /** Links in a placed algae stalk (chain props). */
  placeChainLength: number;
  /** Algae: root and top colours given to placed stalks (sRGB hex); null = the panel's colours. */
  placeAlgaeColors: [number, number] | null;
  /** Water lily: what caps placed stems (0 = leaf, 1 = flower). */
  placeLilyHead: number;
  /**
   * Water lily: 'bottom' roots it where the cursor hits the ground with the chosen length;
   * 'surface' takes the water surface under the cursor and gives the stem just enough links to
   * reach it from the bottom below (its head then floats).
   */
  placeLilyAnchor: 'bottom' | 'surface';
  /** Spider web shape given to placed webs. */
  placeWeb: WebParams;
  /** Placed webs turn to span the passage under the cursor (its narrowest way across). */
  placeWebAutoOrient: boolean;
  placeRandomize: boolean;
  /** Enemy put down by the enemy tool. */
  enemyKind: PestKind;
  /** Object brush: the mix of types it scatters (each new object picks one at random). */
  scatterTypes: string[];
  /** Object brush: objects of the mix per 100 m² it fills the brush circle up to. */
  scatterDensity: number;
  /** Object brush: least distance between scattered objects (m). */
  scatterSpacing: number;
  scatterScaleMin: number;
  scatterScaleMax: number;
  scatterRandomRot: boolean;
  /** Object brush: steepest ground it still puts objects on (degrees). */
  scatterMaxSlope: number;
  scatterWhere: ScatterWhere;
  /** Object brush: only on these ground covers (empty = any). */
  scatterTiles: TerrainTileType[];
  /** Object brush: keeps clear of other objects too (at half the spacing). */
  scatterAvoidOthers: boolean;
  /** Object brush removes instead of placing (Shift flips it while painting). */
  scatterErase: boolean;
  /** Erasing takes every object type (not stations), not only the brush's mix. */
  scatterEraseAll: boolean;
  brushRadius: number;
  brushStrength: number;
  gizmoMode: 'translate' | 'rotate';
  selectedPropId: number | null;
  canUndo: boolean;
  canRedo: boolean;
  cameraSpeed: number;
}

interface Snapshot {
  heights: Float32Array;
  tiles: Uint8Array;
  props: ReturnType<PropSystem['captureEditorProps']>;
  rivers: string;
  /** Cave layout JSON ('' before the network has built). */
  caves: string;
  /** Duckweed cells (Duckweed.ts). */
  duckweed: Uint8Array;
}

interface HistorySwap {
  (): HistorySwap;
}

/**
 * World editor: free-fly camera, terrain sculpt/paint, prop placement and a transform gizmo.
 * All edits are undoable (whole-world snapshots are small: ~85 KB for terrain + props JSON).
 */
export class EditorController {
  public active = false;
  public readonly state: EditorState = {
    tool: 'select',
    sculptKind: 'raise',
    paintTile: TerrainTileType.DIRT_ROAD,
    paintFill: false,
    duckweedErase: false,
    duckweedRate: 1.5,
    placeType: 'tree_pine',
    placeScale: 1,
    placeChainLength: ALGAE_DEFAULT_LINKS,
    placeAlgaeColors: null,
    placeLilyHead: 0,
    placeLilyAnchor: 'surface',
    placeWeb: { ...WEB_DEFAULTS },
    placeWebAutoOrient: true,
    placeRandomize: true,
    enemyKind: 'spider',
    scatterTypes: ['tree_pine', 'tree_round', 'bush'],
    scatterDensity: 4,
    scatterSpacing: 2.5,
    scatterScaleMin: 0.8,
    scatterScaleMax: 1.25,
    scatterRandomRot: true,
    scatterMaxSlope: 35,
    scatterWhere: 'land',
    scatterTiles: [],
    scatterAvoidOthers: true,
    scatterErase: false,
    scatterEraseAll: false,
    brushRadius: 4,
    brushStrength: 2,
    gizmoMode: 'translate',
    selectedPropId: null,
    canUndo: false,
    canRedo: false,
    cameraSpeed: 14,
  };
  /** Bumped whenever `state` changes so React can re-read it. */
  public revision = 0;
  /** Revision of world edits since the last editor save/load action. */
  public editRevision = 0;
  public savedEditRevision = 0;
  private nextEditRevision = 1;
  public readonly recentActions: { label: string; at: number }[] = [];
  /** The enemies (set by the engine once gameplay is up): the enemy tool puts them in the world. */
  public pests: PestSystem | null = null;
  /** Messages for the developer (a refused enemy placement). */
  public onNotify: (text: string, type?: 'success' | 'info' | 'warning') => void = () => {};

  private readonly raycaster = new THREE.Raycaster();
  private readonly cursor: THREE.LineLoop;
  private readonly ghost = new THREE.Group();
  private readonly ghostMaterial = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
  private ghostType = '';
  private ghostGeometry: THREE.BufferGeometry | null = null;
  /** Placement ghost of a frameless web: lines from its hub to where each radial would anchor. */
  private readonly anchorLines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.9, depthTest: false })
  );
  /** Where the web ghost was last oriented / its anchors cast (recomputed once the cursor moves). */
  private readonly ghostWebAt = new THREE.Vector3(Infinity, 0, 0);
  private ghostWebKey = '';
  private readonly gizmo: TransformControls;
  private readonly gizmoTarget = new THREE.Object3D();
  private sceneTransform: ((position: THREE.Vector3, yaw: number, mode: 'translate' | 'rotate') => void) | null = null;
  private sceneCanRotate = false;
  private readonly hit = new THREE.Vector3();
  private hasHit = false;
  /** The cursor is on the island's terrain (props placed there stay glued to it); false in the caves. */
  private hitOnTerrain = true;
  /** Surface normal at the hit (facing the camera): a placed spider stands on walls and ceilings too. */
  private readonly hitNormal = new THREE.Vector3(0, 1, 0);
  private readonly rayDir = new THREE.Vector3();
  private stroking = false;
  private flattenHeight = 0;
  private lastPlaceAt = new THREE.Vector3(Infinity, 0, 0);
  private undoStack: HistorySwap[] = [];
  private redoStack: HistorySwap[] = [];
  public scenePicking: ((ray: THREE.Raycaster, additive: boolean) => void) | null = null;
  public sceneHover: ((point: THREE.Vector3 | null) => void) | null = null;
  public sceneShortcut: ((action: 'delete' | 'duplicate') => void) | null = null;
  public sceneSelectionRefresh: (() => void) | null = null;

  // Fly camera
  private yaw = 0;
  private pitch = -0.5;
  private looking = false;
  private readonly keys = new Set<string>();

  /** River / stream / waterfall authoring (tool 5). */
  public readonly rivers: RiverEditTool;
  /** Cave network authoring (tool 6). */
  public readonly caves: CaveEditTool;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly input: InputManager,
    private readonly terrain: TerrainSystem,
    private readonly props: PropSystem,
    riverSystem: RiverSystem,
    private readonly caveNetwork: CaveNetwork,
    private readonly physics: PhysicsWorld
  ) {
    this.caves = new CaveEditTool(scene, camera, dom, caveNetwork, physics, {
      pushUndo: () => this.pushUndo(),
      touch: () => this.touch(),
    });
    this.rivers = new RiverEditTool(scene, camera, dom, riverSystem, terrain, {
      pushUndo: () => this.pushUndo(),
      touch: () => this.touch(),
    });
    this.riverSystem = riverSystem;
    const ringPts = new Float32Array(65 * 3);
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.BufferAttribute(ringPts, 3));
    this.cursor = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: 0x38bdf8, depthTest: false, transparent: true }));
    this.cursor.renderOrder = 20;
    this.cursor.frustumCulled = false;
    this.cursor.visible = false;
    scene.add(this.cursor);

    this.ghost.visible = false;
    scene.add(this.ghost);
    this.anchorLines.visible = false;
    this.anchorLines.renderOrder = 10;
    this.anchorLines.frustumCulled = false;
    scene.add(this.anchorLines);

    this.gizmo = new TransformControls(camera, dom);
    this.gizmo.setSize(0.8);
    this.gizmo.showY = true;
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      if (this.sceneTransform) {
        if (!dragging) this.sceneTransform(this.gizmoTarget.position.clone(), this.gizmoTarget.rotation.y, this.state.gizmoMode);
      } else if (dragging && this.state.selectedPropId !== null) this.trackSelectedProp();
    });
    this.gizmo.addEventListener('objectChange', () => this.applyGizmo());
    scene.add(this.gizmo.getHelper());
    this.gizmo.getHelper().visible = false;
    this.gizmo.enabled = false;
    scene.add(this.gizmoTarget);

    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    dom.addEventListener('contextmenu', (e) => this.active && e.preventDefault());
  }

  private readonly riverSystem: RiverSystem;

  public dispose(): void {
    this.rivers.dispose();
    this.caves.dispose();
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.gizmo.dispose();
  }

  // ---------------------------------------------------------------- mode / state

  public setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.input.setTerrainMode(active); // frees the mouse cursor
    if (active) {
      // Start the fly camera where the gameplay camera was
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    } else {
      this.select(null);
      this.cursor.visible = false;
      this.ghost.visible = false;
      this.keys.clear();
      this.looking = false;
    }
    this.rivers.setVisible(active && this.state.tool === 'river');
    this.caves.setVisible(this.state.tool === 'cave', active);
    this.touch();
  }

  public set<K extends keyof EditorState>(key: K, value: EditorState[K]): void {
    this.state[key] = value;
    if (key === 'tool' && value !== 'select') this.select(null);
    if (key === 'gizmoMode') {
      this.gizmo.setMode(value as 'translate' | 'rotate');
      this.updateGizmoAxes();
    }
    if (key === 'tool') {
      this.rivers.setVisible(this.active && value === 'river');
      this.caves.setVisible(value === 'cave', this.active);
    }
    this.touch();
  }

  private touch(): void {
    this.state.canUndo = this.undoStack.length > 0;
    this.state.canRedo = this.redoStack.length > 0;
    this.revision++;
  }

  public clearHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.recentActions.length = 0;
    this.select(null);
    this.markSaved();
  }

  public select(id: number | null): void {
    this.sceneTransform = null;
    this.state.selectedPropId = id;
    const prop = id !== null ? this.props.get(id) : undefined;
    if (prop) {
      this.gizmoTarget.position.copy(prop.position);
      this.gizmoTarget.rotation.set(prop.tilt?.[0] ?? 0, prop.rotationY, prop.tilt?.[1] ?? 0, 'YXZ');
      this.gizmo.attach(this.gizmoTarget);
      this.gizmo.enabled = true;
      this.gizmo.getHelper().visible = true;
      this.updateGizmoAxes();
    } else {
      this.gizmo.detach();
      this.gizmo.enabled = false;
      this.gizmo.getHelper().visible = false;
    }
    this.touch();
  }

  public selectSceneTransform(
    position: THREE.Vector3, yaw: number | undefined,
    commit: (position: THREE.Vector3, yaw: number, mode: 'translate' | 'rotate') => void,
  ): void {
    this.state.selectedPropId = null;
    this.sceneTransform = commit;
    this.sceneCanRotate = yaw !== undefined;
    if (!this.sceneCanRotate && this.state.gizmoMode === 'rotate') this.set('gizmoMode', 'translate');
    this.gizmoTarget.position.copy(position);
    this.gizmoTarget.rotation.set(0, yaw ?? 0, 0, 'YXZ');
    this.gizmo.attach(this.gizmoTarget);
    this.gizmo.getHelper().visible = true;
    this.updateGizmoAxes();
    this.touch();
  }

  /** Webs turn on all three axes; other props only about Y (moving still works on all three). */
  private updateGizmoAxes(): void {
    const id = this.state.selectedPropId;
    const prop = id !== null ? this.props.get(id) : undefined;
    const web = !!prop && !!PROP_DEF_MAP.get(prop.type)?.web;
    const rotate = this.state.gizmoMode === 'rotate';
    if (this.sceneTransform) this.gizmo.enabled = !rotate || this.sceneCanRotate;
    this.gizmo.showX = this.gizmo.showZ = !rotate || web;
    this.gizmo.showY = true;
    // Webs rotate about their own axes (the tilt is in the web's frame)
    this.gizmo.setSpace(web && rotate ? 'local' : 'world');
  }

  public deleteSelected(): void {
    const id = this.state.selectedPropId;
    if (id === null) return;
    this.pushUndo();
    this.props.remove(id);
    this.select(null);
  }

  public duplicateSelected(): void {
    const prop = this.state.selectedPropId !== null ? this.props.get(this.state.selectedPropId) : undefined;
    if (!prop) return;
    this.pushUndo();
    const id = this.props.add(prop.type, prop.position.x + 1.5, prop.position.z, prop.rotationY, prop.scale, prop.grounded ? undefined : prop.position.y, prop.grounded, prop.length, prop.colors, prop.web, null, prop.tilt, prop.head);
    this.select(id);
  }

  /** Algae: the selected stalk's own colours, or null for the panel's (push the undo step first). */
  public setSelectedChainColors(colors: [number, number] | null): void {
    const id = this.state.selectedPropId;
    if (id === null) return;
    this.props.setChainColors(id, colors);
    this.touch();
  }

  /** Spider web: changes the selected web's shape / strength (push the undo step on drag start). */
  public setSelectedWeb(patch: Partial<WebParams>): void {
    const id = this.state.selectedPropId;
    if (id === null) return;
    this.props.setWebParams(id, patch);
    this.touch();
  }

  /** Chain props: changes the selected stalk's link count (push the undo step on drag start). */
  /** Water lily: the selected plant's head (0 = leaf, 1 = flower; push the undo step first). */
  public setSelectedChainHead(head: number): void {
    const id = this.state.selectedPropId;
    if (id === null) return;
    this.props.setChainHead(id, head);
    this.touch();
  }

  public setSelectedChainLength(length: number): void {
    const id = this.state.selectedPropId;
    if (id === null) return;
    this.props.setChainLength(id, length);
    this.touch();
  }

  public setSelectedTransform(position: THREE.Vector3, rotationY: number, scale: number, tilt?: [number, number]): void {
    const id = this.state.selectedPropId;
    if (id === null) return;
    this.props.setTransform(id, position, rotationY, scale, tilt);
    const t = this.props.get(id)?.tilt;
    this.gizmoTarget.position.copy(position);
    this.gizmoTarget.rotation.set(t?.[0] ?? 0, rotationY, t?.[1] ?? 0, 'YXZ');
    this.touch();
  }

  /** Puts the fly camera at a point looking down (pitch) toward the given yaw. */
  public flyTo(position: THREE.Vector3, pitch = -0.75, yaw = 0): void {
    this.camera.position.copy(position);
    this.pitch = pitch;
    this.yaw = yaw;
  }

  public focusOn(position: THREE.Vector3): void {
    const back = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(10);
    this.camera.position.copy(position).add(back).add(new THREE.Vector3(0, 7, 0));
    this.pitch = -0.55;
  }

  private applyGizmo(): void {
    const id = this.state.selectedPropId;
    const prop = id !== null ? this.props.get(id) : undefined;
    if (!prop) return;
    const p = this.gizmoTarget.position;
    // Translating keeps grounded props on the terrain unless the user drags Y explicitly
    prop.grounded = Math.abs(p.y - this.terrain.getHeight(p.x, p.z)) < 0.05 || prop.grounded && this.gizmo.axis !== 'Y';
    if (prop.grounded) p.y = this.terrain.getHeight(p.x, p.z);
    const r = this.gizmoTarget.rotation;
    if (PROP_DEF_MAP.get(prop.type)?.web) {
      r.reorder('YXZ');
      this.props.setTransform(prop.id, p, r.y, prop.scale, [r.x, r.z]);
    } else this.props.setTransform(prop.id, p, r.y, prop.scale);
    this.touch();
  }

  // ---------------------------------------------------------------- undo

  private snapshot(): Snapshot {
    return {
      heights: this.terrain.captureUncarvedHeights(),
      tiles: this.terrain.tiles.slice(),
      props: this.props.captureEditorProps(),
      rivers: stringifyRivers(riverWorld.defs),
      caves: this.caves.work ? JSON.stringify(this.caves.work) : '',
      duckweed: duckweed.snapshot(),
    };
  }

  private restore(s: Snapshot): void {
    // Rivers first: they move the generated base the live heights are stored against
    if (s.rivers !== stringifyRivers(riverWorld.defs)) {
      this.riverSystem.replaceAll(JSON.parse(s.rivers) as RiverDef[], false);
      this.rivers.unsaved = true;
      if (!riverWorld.defs.some((d) => d.id === this.rivers.selectedRiver)) this.rivers.select(null);
      else this.rivers.select(this.rivers.selectedRiver, -1);
    }
    if (s.caves && s.caves !== (this.caves.work ? JSON.stringify(this.caves.work) : '')) this.caves.setLayout(JSON.parse(s.caves));
    this.terrain.restoreUncarvedHeights(s.heights);
    this.terrain.tiles.set(s.tiles);
    const save = this.terrain.serialize();
    this.terrain.deserialize(save); // marks all chunks/splat/physics dirty
    this.props.restoreEditorProps(s.props);
    duckweed.restore(s.duckweed);
    this.select(null);
  }

  public pushUndo(): void {
    this.trackChange(this.actionLabel(), () => this.snapshot(), (state) => this.restore(state));
  }

  public trackSelectedProp(): void {
    const id = this.state.selectedPropId;
    if (id === null) return;
    this.trackChange('Властивості об’єкта', () => this.props.captureEditorProp(id), (data) => {
      this.props.restoreEditorProp(id, data);
      this.select(data ? id : null);
    });
  }

  public trackChange<T>(label: string, capture: () => T, restore: (state: T) => void): void {
    this.recordChange(label, capture, restore, capture());
  }

  public recordChange<T>(label: string, capture: () => T, restore: (state: T) => void, before: T): void {
    const swap = (state: T, version: number): HistorySwap => () => {
      const inverse = swap(capture(), this.editRevision);
      restore(state);
      this.editRevision = version;
      return inverse;
    };
    this.undoStack.push(swap(before, this.editRevision));
    if (this.undoStack.length > 30) this.undoStack.shift();
    this.redoStack.length = 0;
    this.editRevision = this.nextEditRevision++;
    this.recordEdit(label);
    this.touch();
  }

  private actionLabel(): string {
    return ({
      place: 'Розміщення об’єкта', sculpt: 'Зміна рельєфу', paint: 'Зміна покриття',
      river: 'Зміна річки', cave: 'Зміна печери', duckweed: 'Зміна ряски', scatter: 'Пензель об’єктів',
      enemy: 'Зміна ворогів', select: 'Зміна сцени',
    } as const)[this.state.tool] ?? 'Зміна світу';
  }

  private recordEdit(label: string): void {
    this.recentActions.unshift({ label, at: Date.now() });
    if (this.recentActions.length > 20) this.recentActions.length = 20;
  }

  public markSaved(): void {
    this.savedEditRevision = this.editRevision;
    this.touch();
  }

  public get hasUnsavedEdits(): boolean {
    return this.editRevision !== this.savedEditRevision;
  }

  public undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(s());
    this.sceneSelectionRefresh?.();
    this.recordEdit('Скасовано дію');
    this.touch();
  }

  public redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(s());
    this.sceneSelectionRefresh?.();
    this.recordEdit('Повторено дію');
    this.touch();
  }

  // ---------------------------------------------------------------- input

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.active) return;
    if (e.button === 2) {
      this.looking = true;
      return;
    }
    if (e.button !== 0 || this.gizmo.dragging || (this.gizmo.axis && this.state.tool === 'select')) return;
    const { tool } = this.state;
    if (tool === 'cave') {
      this.raycaster.setFromCamera(this.input.mouseNDC, this.camera);
      this.caves.pointerDown(this.raycaster, this.input.mouseNDC);
    } else if (tool === 'river') {
      if (this.rivers.busy) return;
      this.raycaster.setFromCamera(this.input.mouseNDC, this.camera);
      const hit = this.terrain.raycast(this.raycaster.ray, 300, new THREE.Vector3());
      this.rivers.pointerDown(this.raycaster, hit, e.shiftKey);
    } else if (tool === 'enemy') {
      this.placeEnemy();
    } else if (tool === 'select') {
      const rect = this.dom.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const cursor = new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, 1 - (e.clientY - rect.top) / rect.height * 2);
      this.raycaster.setFromCamera(cursor, this.camera);
      if (this.scenePicking) {
        this.scenePicking(this.raycaster, e.shiftKey);
        return;
      }
      const hit = this.props.pick(this.raycaster);
      this.select(hit ? hit.id : null);
    } else if (tool === 'place') {
      const rect = this.dom.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const cursor = new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, 1 - (e.clientY - rect.top) / rect.height * 2);
      this.updatePlacementHit(cursor);
      this.updateGhost(this.hasHit);
      if (!this.ghost.visible) return;
      this.pushUndo();
      this.stroking = true;
      this.lastPlaceAt.set(Infinity, 0, 0);
      this.placeAtHit();
    } else if (this.hasHit) {
      this.pushUndo();
      this.stroking = true;
      this.flattenHeight = this.hit.y;
      this.lastPlaceAt.set(Infinity, 0, 0);
      if (tool === 'paint' && this.state.paintFill) {
        this.terrain.fillTiles(this.hit.x, this.hit.z, this.state.paintTile);
        this.stroking = false;
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button === 2) this.looking = false;
    if (e.button === 0 && this.stroking) {
      this.stroking = false;
      this.terrain.commit();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.active || !this.looking) return;
    this.yaw -= e.movementX * 0.004;
    this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.004, -1.5, 1.5);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    this.keys.add(e.code);
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
      e.preventDefault();
      this.redo();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD') {
      e.preventDefault();
      if (this.state.tool === 'cave') this.caves.duplicateSelected();
      else if (this.state.tool === 'select' && this.sceneShortcut) this.sceneShortcut('duplicate');
      else this.duplicateSelected();
    } else if (this.state.tool === 'river' && !e.ctrlKey && this.rivers.keyDown(e)) {
      // handled by the river tool
    } else if (this.state.tool === 'cave' && (e.code === 'Delete' || e.code === 'Backspace')) {
      this.caves.deleteSelected();
    } else if (this.state.tool === 'cave' && e.code === 'Escape') {
      this.caves.addMode = 'none';
      this.caves.select(null);
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      if (this.state.tool === 'select' && this.sceneShortcut) this.sceneShortcut('delete');
      else this.deleteSelected();
    } else if (!e.ctrlKey && !this.looking) {
      const tools: Record<string, EditorTool> = { Digit1: 'select', Digit2: 'place', Digit3: 'sculpt', Digit4: 'paint', Digit5: 'river', Digit6: 'cave', Digit7: 'enemy', Digit8: 'duckweed', Digit9: 'scatter' };
      if (tools[e.code]) this.set('tool', tools[e.code]);
      if (e.code === 'KeyG') this.set('gizmoMode', 'translate');
      if (e.code === 'KeyR' && this.state.tool === 'select') this.set('gizmoMode', 'rotate');
      if (e.code === 'KeyF' && this.state.tool === 'cave') {
        const p = this.caves.selectedWorldPos();
        if (p) this.focusOn(p);
      }
      if (e.code === 'BracketLeft') this.set('brushRadius', Math.max(1, this.state.brushRadius - 1));
      if (e.code === 'BracketRight') this.set('brushRadius', Math.min(this.state.tool === 'scatter' ? 40 : 20, this.state.brushRadius + 1));
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  // ---------------------------------------------------------------- frame

  public update(dt: number): void {
    if (!this.active) return;
    this.updateFlyCamera(dt);
    this.rivers.update(dt);
    this.caves.update(dt);

    const { tool } = this.state;
    this.updatePlacementHit(this.input.mouseNDC);
    // Sharks go in the water: the sea surface under the cursor counts as the hit
    if (tool === 'enemy' && this.state.enemyKind === 'shark') this.castOntoSea();
    // Duckweed is painted on the water surface (sea, lakes, rivers), not on the bottom under it
    if (tool === 'duckweed') this.castOntoWater();
    this.sceneHover?.(tool === 'select' && this.hasHit && !this.looking ? this.hit : null);
    const brushTool = tool === 'sculpt' || tool === 'paint' || tool === 'duckweed' || tool === 'scatter';

    this.updateCursor((brushTool || tool === 'enemy') && this.hasHit);
    this.updateGhost(tool === 'place' && this.hasHit);

    if (!this.stroking || !this.input.isMouseDown || !this.hasHit) return;
    const { brushRadius: r, brushStrength: s } = this.state;
    if (tool === 'sculpt') {
      this.terrain.sculpt(this.state.sculptKind, this.hit.x, this.hit.z, r, s, dt, this.flattenHeight);
    } else if (tool === 'paint') {
      this.terrain.paintCircle(this.hit.x, this.hit.z, r * 0.5, this.state.paintTile);
    } else if (tool === 'duckweed') {
      duckweed.paint(this.hit.x, this.hit.z, r, this.state.duckweedRate, dt, this.state.duckweedErase);
    } else if (tool === 'scatter') {
      if (this.scatterErasing()) this.scatterErase(this.hit.x, this.hit.z, r);
      else this.scatterFill(this.hit.x, this.hit.z, r);
    } else if (tool === 'place') {
      this.placeAtHit();
    }
  }

  private updatePlacementHit(cursor: THREE.Vector2): void {
    this.raycaster.setFromCamera(cursor, this.camera);
    this.hasHit = !!this.terrain.raycast(this.raycaster.ray, 300, this.hit);
    this.hitOnTerrain = true;
    this.hitNormal.set(0, 1, 0);
    const { tool } = this.state;
    if (tool === 'place' || tool === 'enemy') this.castIntoCaves();
    if (tool === 'place' && this.lilyOnSurface()) this.castOntoSea();
  }

  private placeAtHit(): void {
    const { placeType, placeRandomize, placeScale, placeAlgaeColors, placeWeb, placeLilyHead } = this.state;
    const hedge = placeType === HEDGE_TYPE;
    const at = hedge ? this.ghost.position : this.hit;
    const spacing = hedge ? 0.5 : Math.max(1.2, placeScale * 2);
    if (at.distanceTo(this.lastPlaceAt) < spacing) return;

    const randomize = !hedge && placeRandomize && !PROP_DEF_MAP.get(placeType)?.web;
    const yaw = hedge ? 0 : randomize ? Math.random() * Math.PI * 2 : this.ghost.rotation.y;
    const scale = hedge ? 1 : placeScale * (randomize ? 0.85 + Math.random() * 0.3 : 1);
    const y = this.hitOnTerrain ? undefined : this.hit.y;
    const links = this.placeLinks(scale);
    if (links === null) return;

    const id = this.props.add(
      placeType, at.x, at.z, yaw, scale, y, this.hitOnTerrain, links, placeAlgaeColors, placeWeb,
      null, null, placeLilyHead,
    );
    if (id === null) return;
    if (this.lilyOnSurface()) this.centreLilyHead(id, yaw, scale);
    this.lastPlaceAt.copy(at);
    this.touch();
  }

  // ---------------------------------------------------------------- object brush

  /** The object brush removes this frame: its erase mode, flipped while Shift is held. */
  private scatterErasing(): boolean {
    const shift = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    return this.state.scatterErase !== shift;
  }

  /** Brush types that exist and can be scattered. */
  private scatterMix(): string[] {
    return this.state.scatterTypes.filter(isScatterable);
  }

  /** Every prop standing within `radius` of (x, z): batched ones through the grid, chains and webs (`withLoose`) by a scan. */
  private propsNear(x: number, z: number, radius: number, withLoose: boolean): { id: number; type: string; x: number; z: number }[] {
    const out: { id: number; type: string; x: number; z: number }[] = [];
    const r2 = radius * radius;
    const take = (p: { id: number; type: string; position: THREE.Vector3 }) => {
      const dx = p.position.x - x;
      const dz = p.position.z - z;
      if (dx * dx + dz * dz <= r2) out.push({ id: p.id, type: p.type, x: p.position.x, z: p.position.z });
    };
    this.props.forEachNear(x, z, radius, take);
    if (withLoose) {
      for (const p of this.props.list()) {
        const def = PROP_DEF_MAP.get(p.type);
        if (def?.chain || def?.web) take(p);
      }
    }
    return out;
  }

  /** Ground at (x, z) passes the brush's filters (on the island, slope, water, ground cover). */
  private scatterGroundOk(x: number, z: number): boolean {
    const st = this.state;
    const t = this.terrain;
    if (!t.isInside(x, z)) return false;
    const ground = t.getHeight(x, z);
    if (st.scatterMaxSlope < 89) {
      const gx = t.getHeight(x + 0.5, z) - t.getHeight(x - 0.5, z);
      const gz = t.getHeight(x, z + 0.5) - t.getHeight(x, z - 0.5);
      if (Math.atan(Math.hypot(gx, gz)) * THREE.MathUtils.RAD2DEG > st.scatterMaxSlope) return false;
    }
    if (st.scatterWhere !== 'any') {
      const wet = riverWorld.waterLevelAt(x, z) > ground + 0.05;
      if (wet !== (st.scatterWhere === 'water')) return false;
    }
    if (st.scatterTiles.length && !st.scatterTiles.includes(t.getTile(Math.floor(x), Math.floor(z)))) return false;
    return true;
  }

  /** Links of a chain prop scattered at (x, z): a surface lily just reaches the water there (null: too shallow). */
  private scatterLinks(type: string, x: number, z: number, scale: number): number | null | undefined {
    const chain = PROP_DEF_MAP.get(type)?.chain;
    if (!chain) return undefined;
    if (chain !== 'lily' || this.state.placeLilyAnchor !== 'surface') return this.state.placeChainLength;
    const linkH = LILY.parts?.linkH ?? 0;
    const depth = riverWorld.waterLevelAt(x, z) - this.terrain.getHeight(x, z);
    if (!linkH || depth < 0.15) return null;
    return LILY.clampLinks(Math.ceil(depth / (linkH * scale)));
  }

  /**
   * Tops the brush circle up to the chosen density: random spots in it that pass the filters and
   * keep the spacing get a random type of the mix. Holding still never piles objects up.
   */
  private scatterFill(cx: number, cz: number, r: number): void {
    const st = this.state;
    const mix = this.scatterMix();
    if (!mix.length) return;
    const mixSet = new Set(mix);
    const spacing = Math.max(0.2, st.scatterSpacing);
    const target = Math.max(1, Math.round((st.scatterDensity * Math.PI * r * r) / 100));
    const loose = mix.some((t) => PROP_DEF_MAP.get(t)?.chain);
    const near = this.propsNear(cx, cz, r + spacing, loose);
    let have = 0;
    for (const p of near) if (mixSet.has(p.type) && (p.x - cx) ** 2 + (p.z - cz) ** 2 <= r * r) have++;
    // Capped per frame, so a big brush fills over a few frames instead of in one hitch
    let need = Math.min(target - have, 40);
    if (need <= 0) return;
    const minS2 = spacing * spacing;
    const otherS2 = (spacing * 0.5) ** 2;
    const lo = Math.min(st.scatterScaleMin, st.scatterScaleMax);
    const hi = Math.max(st.scatterScaleMin, st.scatterScaleMax);
    let tries = Math.min(need * 10, 160);
    let placed = 0;
    while (need > 0 && tries-- > 0) {
      const a = Math.random() * Math.PI * 2;
      const d = r * Math.sqrt(Math.random());
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      let clear = true;
      for (const p of near) {
        const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (mixSet.has(p.type) ? d2 < minS2 : st.scatterAvoidOthers && d2 < otherS2) {
          clear = false;
          break;
        }
      }
      if (!clear || !this.scatterGroundOk(x, z)) continue;
      const type = mix[Math.floor(Math.random() * mix.length)];
      const scale = lo + Math.random() * (hi - lo);
      const rot = st.scatterRandomRot ? Math.random() * Math.PI * 2 : 0;
      const links = this.scatterLinks(type, x, z, scale);
      if (links === null) continue;
      const id = this.props.add(type, x, z, rot, scale, undefined, true, links, st.placeAlgaeColors, null, null, null, st.placeLilyHead);
      if (id === null) continue;
      if (PROP_DEF_MAP.get(type)?.chain === 'lily' && st.placeLilyAnchor === 'surface') this.centreLilyHead(id, rot, scale);
      near.push({ id, type, x, z });
      need--;
      placed++;
    }
    if (placed) this.touch();
  }

  /** Removes the brush mix's objects (or every object but the stations) inside the circle. */
  private scatterErase(cx: number, cz: number, r: number): void {
    const all = this.state.scatterEraseAll;
    const mix = new Set(this.scatterMix());
    const loose = all || [...mix].some((t) => PROP_DEF_MAP.get(t)?.chain);
    let removed = 0;
    for (const p of this.propsNear(cx, cz, r, loose)) {
      if (all ? PROP_DEF_MAP.get(p.type)?.category === 'stations' : !mix.has(p.type)) continue;
      this.props.remove(p.id);
      removed++;
    }
    if (removed) this.touch();
  }


  private lilyOnSurface(): boolean {
    return PROP_DEF_MAP.get(this.state.placeType)?.chain === 'lily' && this.state.placeLilyAnchor === 'surface';
  }

  /**
   * Links of the chain about to be placed at the cursor: the chosen length, or for a water lily
   * put on the surface just enough for its stem to reach the water from the bottom below (null:
   * no water there to float on).
   */
  private placeLinks(scale: number): number | null {
    if (!this.lilyOnSurface()) return this.state.placeChainLength;
    const linkH = LILY.parts?.linkH ?? 0;
    if (!this.hitOnTerrain || !linkH) return null;
    const depth = riverWorld.waterLevelAt(this.hit.x, this.hit.z) - this.terrain.getHeight(this.hit.x, this.hit.z);
    if (depth < 0.15) return null;
    return LILY.clampLinks(Math.ceil(depth / (linkH * scale)));
  }

  /**
   * A lily put on the surface lays its spare stem in an arc, so its head comes to rest beside the
   * root: the root moves back by that much (once), so the head floats where the cursor was.
   */
  private centreLilyHead(id: number, rot: number, scale: number): void {
    const off = new THREE.Vector3();
    if (!this.props.lilies.headOffset(id, off) || off.lengthSq() < 0.01) return;
    const prop = this.props.get(id);
    if (!prop) return;
    const x = prop.position.x - off.x;
    const z = prop.position.z - off.z;
    const ground = this.terrain.getHeight(x, z);
    // Only onto ground still under the water (not up a bank)
    const depth = riverWorld.waterLevelAt(x, z) - ground;
    if (depth < 0.15) return;
    this.props.setTransform(id, new THREE.Vector3(x, ground, z), rot, scale);
    // Still just long enough to reach the surface from the new spot
    const linkH = LILY.parts?.linkH ?? 0;
    if (linkH) {
      const links = LILY.clampLinks(Math.ceil(depth / (linkH * scale)));
      if (links !== prop.length) this.props.setChainLength(id, links);
    }
  }

  /** The sea surface under the cursor, when the ray crosses it before the ground (or misses the island). */
  private castOntoSea(): void {
    const ray = this.raycaster.ray;
    if (ray.direction.y >= -1e-3) return;
    const t = (worldSettings.waterLevel - ray.origin.y) / ray.direction.y;
    if (t < 0 || t > 600) return;
    if (this.hasHit && (!this.hitOnTerrain || ray.origin.distanceTo(this.hit) < t)) return;
    ray.at(t, this.hit);
    this.hasHit = true;
    this.hitOnTerrain = true;
  }

  /**
   * The water surface under the cursor (the sea, or a lake / river above it): where the ray crosses
   * the surface height before the ground. A few fixed-point steps settle on the right surface
   * when its level changes along the ray (a lake above the sea).
   */
  private castOntoWater(): void {
    const ray = this.raycaster.ray;
    if (ray.direction.y >= -1e-3) return;
    if (!this.hasHit || !this.hitOnTerrain) {
      this.castOntoSea();
      return;
    }
    let level = riverWorld.waterLevelAt(this.hit.x, this.hit.z);
    if (level <= this.hit.y) return; // dry ground: paint right there
    const p = new THREE.Vector3();
    for (let i = 0; i < 4; i++) {
      const t = (level - ray.origin.y) / ray.direction.y;
      if (t < 0) return;
      ray.at(t, p);
      level = riverWorld.waterLevelAt(p.x, p.z);
    }
    if (p.y < this.terrain.getHeight(p.x, p.z)) return;
    this.hit.copy(p);
  }

  /** Enemy tool click: the chosen kind at the cursor, or why it cannot live there. */
  private placeEnemy(): void {
    const pests = this.pests;
    if (!pests || !this.hasHit) return;
    const kind = this.state.enemyKind;
    const err = pests.placementError(kind, this.hit, this.hitOnTerrain, this.hitNormal);
    if (err) {
      this.onNotify(err, 'warning');
      return;
    }
    const before = pests.serializeAuthored();
    if (pests.spawnAt(kind, this.hit, this.hitOnTerrain, kind === 'spider' ? this.hitNormal : undefined)) {
      this.recordChange('Розміщення істоти', () => pests.serializeAuthored(), (data) => pests.restoreAuthored(data), before);
    }
  }

  /** A cave surface under the cursor nearer than the terrain hit (if any) becomes the hit. */
  private castIntoCaves(): void {
    const ray = this.raycaster.ray;
    const res = this.physics.castRayAndGetNormal(ray.origin, this.rayDir.copy(ray.direction), 300);
    if (!res) return;
    const toi = res.hit.timeOfImpact;
    if (this.hasHit && ray.origin.distanceTo(this.hit) <= toi) return;
    const point = ray.at(toi, new THREE.Vector3());
    if (!this.caveNetwork.contains(point)) return;
    this.hit.copy(point);
    this.hitNormal.copy(res.normal);
    // The ray's hit normal can face either way: the camera's side is the open air
    if (this.hitNormal.dot(ray.direction) > 0) this.hitNormal.negate();
    this.hasHit = true;
    this.hitOnTerrain = false;
  }

  private updateFlyCamera(dt: number): void {
    const k = this.keys;
    const speed = this.state.cameraSpeed * (k.has('ShiftLeft') ? 3 : 1) * dt;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = new THREE.Vector3();
    if (!(k.has('ControlLeft') || k.has('MetaLeft'))) {
      if (k.has('KeyW')) move.add(fwd);
      if (k.has('KeyS')) move.sub(fwd);
      if (k.has('KeyD')) move.add(right);
      if (k.has('KeyA')) move.sub(right);
      if (k.has('KeyE') || k.has('Space')) move.y += 1;
      if (k.has('KeyQ')) move.y -= 1;
    }
    if (move.lengthSq() > 0) this.camera.position.addScaledVector(move.normalize(), speed);
    // Over the island the camera stays above the ground; the cave pocket lies far beyond it
    if (Math.abs(this.camera.position.x) < 400) {
      const ground = this.terrain.getHeight(this.camera.position.x, this.camera.position.z);
      this.camera.position.y = Math.max(this.camera.position.y, ground + 0.5);
    }
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
  }

  private updateCursor(visible: boolean): void {
    this.cursor.visible = visible;
    if (!visible) return;
    if (this.state.tool === 'enemy') {
      // A flat ring where the enemy goes: green where it can live, red where it cannot
      const kind = this.state.enemyKind;
      const r = kind === 'shark' ? 1.8 : kind === 'dragon' ? 1 : 0.8;
      const attr = this.cursor.geometry.getAttribute('position') as THREE.BufferAttribute;
      const a = attr.array as Float32Array;
      for (let i = 0; i <= 64; i++) {
        const t = (i / 64) * Math.PI * 2;
        a[i * 3] = this.hit.x + Math.cos(t) * r;
        a[i * 3 + 1] = this.hit.y + 0.08;
        a[i * 3 + 2] = this.hit.z + Math.sin(t) * r;
      }
      attr.needsUpdate = true;
      const ok = !!this.pests && !this.pests.placementError(kind, this.hit, this.hitOnTerrain, this.hitNormal);
      (this.cursor.material as THREE.LineBasicMaterial).color.setHex(ok ? 0x22c55e : 0xef4444);
      return;
    }
    const weed = this.state.tool === 'duckweed';
    const r = this.state.tool === 'paint' ? this.state.brushRadius * 0.5 : this.state.brushRadius;
    const attr = this.cursor.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = attr.array as Float32Array;
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      const x = this.hit.x + Math.cos(t) * r;
      const z = this.hit.z + Math.sin(t) * r;
      a[i * 3] = x;
      a[i * 3 + 1] = (weed ? Math.max(this.terrain.getHeight(x, z), riverWorld.waterLevelAt(x, z)) : this.terrain.getHeight(x, z)) + 0.08;
      a[i * 3 + 2] = z;
    }
    attr.needsUpdate = true;
    const colors: Record<string, number> = { raise: 0x22c55e, lower: 0xf97316, smooth: 0x38bdf8, flatten: 0xa855f7 };
    (this.cursor.material as THREE.LineBasicMaterial).color.setHex(
      weed ? (this.state.duckweedErase ? 0xf97316 : 0x84cc16)
        : this.state.tool === 'scatter' ? (this.scatterErasing() ? 0xef4444 : 0x22c55e)
        : this.state.tool === 'paint' ? 0xfacc15 : colors[this.state.sculptKind]
    );
  }

  /**
   * The way across the passage at `at`: of 12 horizontal lines through the web's middle, the
   * one whose walls on both sides are nearest. Returns the web's yaw, or null in the open.
   */
  private passageYaw(at: THREE.Vector3, height: number): number | null {
    if (!this.physics.isInitialized()) return null;
    const o = new THREE.Vector3(at.x, at.y + Math.min(height * 0.5, 1.6), at.z);
    const d = new THREE.Vector3();
    const MAX = 12;
    let best = Infinity;
    let yaw: number | null = null;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI;
      d.set(Math.cos(a), 0, Math.sin(a));
      const fwd = this.physics.castRay(o, d, MAX);
      const back = this.physics.castRay(o, d.negate(), MAX);
      if (!fwd || !back) continue;
      const span = fwd.timeOfImpact + back.timeOfImpact;
      if (span < best) {
        best = span;
        // The web's right axis (cos y, 0, -sin y) along this line
        yaw = Math.atan2(-Math.sin(a), Math.cos(a));
      }
    }
    return yaw;
  }

  /** Web ghost: turned across the passage, and (frameless) lines to where its threads would anchor. */
  private updateWebGhost(): void {
    const params = clampWeb(this.state.placeWeb);
    const scale = this.state.placeScale;
    const key = `${JSON.stringify(params)}|${scale}|${this.state.placeWebAutoOrient}`;
    if (this.ghostWebKey === key && this.ghostWebAt.distanceToSquared(this.hit) < 0.0025) return;
    this.ghostWebKey = key;
    this.ghostWebAt.copy(this.hit);
    if (this.state.placeWebAutoOrient) {
      const yaw = this.passageYaw(this.hit, params.h * scale);
      if (yaw !== null) this.ghost.rotation.y = yaw;
    }
    const pts = this.props.webs.previewAnchors(this.hit, this.ghost.rotation.y, undefined, params, scale);
    const geo = this.anchorLines.geometry;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    geo.computeBoundingSphere();
    this.anchorLines.visible = pts.length > 0;
  }

  private updateGhost(visible: boolean): void {
    this.ghost.visible = visible;
    const web = visible && !!PROP_DEF_MAP.get(this.state.placeType)?.web;
    if (!web) {
      this.anchorLines.visible = false;
      if (this.ghostWebKey) this.ghost.rotation.y = 0;
      this.ghostWebKey = '';
    }
    if (!visible) return;
    // A lily on the surface: its stem from the bottom up to the water (none where there is none)
    const links = this.placeLinks(this.state.placeScale);
    if (links === null) {
      this.ghost.visible = false;
      return;
    }
    // The type's shared geometry (algae: the stalk of the chosen length), rendered translucent
    const hedge = this.state.placeType === HEDGE_TYPE;
    this.ghost.position.copy(this.hit);
    if (hedge) {
      const x = snapHedge(this.hit.x), z = snapHedge(this.hit.z);
      this.ghost.position.set(x, this.hitOnTerrain ? this.terrain.getHeight(x, z) : this.hit.y, z);
      this.ghost.rotation.y = 0;
    }
    const mask = hedge ? this.props.hedgeMaskAt(this.ghost.position) : 0;
    const geometry = this.props.previewGeometry(this.state.placeType, links, this.state.placeWeb, this.state.placeLilyHead, mask);
    if (this.ghostType !== this.state.placeType || this.ghostGeometry !== geometry) {
      this.ghostType = this.state.placeType;
      this.ghostGeometry = geometry;
      this.ghost.clear();
      if (geometry && PROP_DEF_MAP.has(this.state.placeType)) {
        const mesh = new THREE.Mesh(geometry, this.ghostMaterial);
        this.ghost.add(mesh);
      }
    }
    if (this.lilyOnSurface()) this.ghost.position.y = this.terrain.getHeight(this.hit.x, this.hit.z);
    this.ghost.scale.setScalar(hedge ? 1 : this.state.placeScale);
    if (web) this.updateWebGhost();
  }
}
