import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { InputManager } from '../input/InputManager';
import { TerrainSystem, TerrainBrushKind } from '../world/TerrainSystem';
import { PropSystem, PROP_DEF_MAP } from '../world/PropSystem';
import { ALGAE_DEFAULT_LINKS } from '../world/AlgaeChains';
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

export type EditorTool = 'select' | 'place' | 'sculpt' | 'paint' | 'river' | 'cave' | 'enemy';

export interface EditorState {
  tool: EditorTool;
  sculptKind: TerrainBrushKind;
  paintTile: TerrainTileType;
  paintFill: boolean;
  placeType: string;
  placeScale: number;
  /** Links in a placed algae stalk (chain props). */
  placeChainLength: number;
  /** Algae: root and top colours given to placed stalks (sRGB hex); null = the panel's colours. */
  placeAlgaeColors: [number, number] | null;
  /** Spider web shape given to placed webs. */
  placeWeb: WebParams;
  /** Placed webs turn to span the passage under the cursor (its narrowest way across). */
  placeWebAutoOrient: boolean;
  placeRandomize: boolean;
  /** Enemy put down by the enemy tool. */
  enemyKind: PestKind;
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
  props: ReturnType<PropSystem['serialize']>;
  rivers: string;
  /** Cave layout JSON ('' before the network has built). */
  caves: string;
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
    placeType: 'tree_pine',
    placeScale: 1,
    placeChainLength: ALGAE_DEFAULT_LINKS,
    placeAlgaeColors: null,
    placeWeb: { ...WEB_DEFAULTS },
    placeWebAutoOrient: true,
    placeRandomize: true,
    enemyKind: 'spider',
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
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

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
      if ((e as unknown as { value: boolean }).value) this.pushUndo();
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

  public select(id: number | null): void {
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

  /** Webs turn on all three axes; other props only about Y (moving still works on all three). */
  private updateGizmoAxes(): void {
    const id = this.state.selectedPropId;
    const prop = id !== null ? this.props.get(id) : undefined;
    const web = !!prop && !!PROP_DEF_MAP.get(prop.type)?.web;
    const rotate = this.state.gizmoMode === 'rotate';
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
    const id = this.props.add(prop.type, prop.position.x + 1.5, prop.position.z, prop.rotationY, prop.scale, prop.grounded ? undefined : prop.position.y, prop.grounded, prop.length, prop.colors, prop.web, null, prop.tilt);
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
      heights: this.terrain.heights.slice(),
      tiles: this.terrain.tiles.slice(),
      props: this.props.serialize(),
      rivers: stringifyRivers(riverWorld.defs),
      caves: this.caves.work ? JSON.stringify(this.caves.work) : '',
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
    this.terrain.heights.set(s.heights);
    this.terrain.tiles.set(s.tiles);
    this.terrain.invalidateSaveCache();
    const save = this.terrain.serialize();
    this.terrain.deserialize(save); // marks all chunks/splat/physics dirty
    this.props.deserialize(s.props);
    this.select(null);
  }

  public pushUndo(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 30) this.undoStack.shift();
    this.redoStack.length = 0;
    this.touch();
  }

  public undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
    this.touch();
  }

  public redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
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
      this.raycaster.setFromCamera(this.input.mouseNDC, this.camera);
      const hit = this.props.pick(this.raycaster);
      this.select(hit ? hit.id : null);
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
      else this.duplicateSelected();
    } else if (this.state.tool === 'river' && !e.ctrlKey && this.rivers.keyDown(e)) {
      // handled by the river tool
    } else if (this.state.tool === 'cave' && (e.code === 'Delete' || e.code === 'Backspace')) {
      this.caves.deleteSelected();
    } else if (this.state.tool === 'cave' && e.code === 'Escape') {
      this.caves.addMode = 'none';
      this.caves.select(null);
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      this.deleteSelected();
    } else if (!e.ctrlKey && !this.looking) {
      const tools: Record<string, EditorTool> = { Digit1: 'select', Digit2: 'place', Digit3: 'sculpt', Digit4: 'paint', Digit5: 'river', Digit6: 'cave', Digit7: 'enemy' };
      if (tools[e.code]) this.set('tool', tools[e.code]);
      if (e.code === 'KeyG') this.set('gizmoMode', 'translate');
      if (e.code === 'KeyR' && this.state.tool === 'select') this.set('gizmoMode', 'rotate');
      if (e.code === 'KeyF' && this.state.tool === 'cave') {
        const p = this.caves.selectedWorldPos();
        if (p) this.focusOn(p);
      }
      if (e.code === 'BracketLeft') this.set('brushRadius', Math.max(1, this.state.brushRadius - 1));
      if (e.code === 'BracketRight') this.set('brushRadius', Math.min(20, this.state.brushRadius + 1));
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

    this.raycaster.setFromCamera(this.input.mouseNDC, this.camera);
    this.hasHit = !!this.terrain.raycast(this.raycaster.ray, 300, this.hit);
    this.hitOnTerrain = true;
    this.hitNormal.set(0, 1, 0);
    const { tool } = this.state;
    // Placing in the caves: the terrain ray misses the cave pocket, its colliders take the hit
    if (tool === 'place' || tool === 'enemy') this.castIntoCaves();
    // Sharks go in the water: the sea surface under the cursor counts as the hit
    if (tool === 'enemy' && this.state.enemyKind === 'shark') this.castOntoSea();
    const brushTool = tool === 'sculpt' || tool === 'paint';

    this.updateCursor((brushTool || tool === 'enemy') && this.hasHit);
    this.updateGhost(tool === 'place' && this.hasHit);

    if (!this.stroking || !this.input.isMouseDown || !this.hasHit) return;
    const { brushRadius: r, brushStrength: s } = this.state;
    if (tool === 'sculpt') {
      this.terrain.sculpt(this.state.sculptKind, this.hit.x, this.hit.z, r, s, dt, this.flattenHeight);
    } else if (tool === 'paint') {
      this.terrain.paintCircle(this.hit.x, this.hit.z, r * 0.5, this.state.paintTile);
    } else if (tool === 'place') {
      // Click places one; dragging scatters with spacing proportional to the prop size
      const spacing = Math.max(1.2, this.state.placeScale * 2);
      if (this.hit.distanceTo(this.lastPlaceAt) >= spacing) {
        // Webs keep the ghost's turn (across the passage) and size
        const rnd = this.state.placeRandomize && !PROP_DEF_MAP.get(this.state.placeType)?.web;
        const rot = rnd ? Math.random() * Math.PI * 2 : this.ghost.rotation.y;
        const scale = this.state.placeScale * (rnd ? 0.85 + Math.random() * 0.3 : 1);
        const y = this.hitOnTerrain ? undefined : this.hit.y;
        this.props.add(this.state.placeType, this.hit.x, this.hit.z, rot, scale, y, this.hitOnTerrain, this.state.placeChainLength, this.state.placeAlgaeColors, this.state.placeWeb);
        this.lastPlaceAt.copy(this.hit);
        this.touch();
      }
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
    pests.spawnAt(kind, this.hit, this.hitOnTerrain, kind === 'spider' ? this.hitNormal : undefined);
    this.touch();
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
    const r = this.state.tool === 'paint' ? this.state.brushRadius * 0.5 : this.state.brushRadius;
    const attr = this.cursor.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = attr.array as Float32Array;
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      const x = this.hit.x + Math.cos(t) * r;
      const z = this.hit.z + Math.sin(t) * r;
      a[i * 3] = x;
      a[i * 3 + 1] = this.terrain.getHeight(x, z) + 0.08;
      a[i * 3 + 2] = z;
    }
    attr.needsUpdate = true;
    const colors: Record<string, number> = { raise: 0x22c55e, lower: 0xf97316, smooth: 0x38bdf8, flatten: 0xa855f7 };
    (this.cursor.material as THREE.LineBasicMaterial).color.setHex(
      this.state.tool === 'paint' ? 0xfacc15 : colors[this.state.sculptKind]
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
    // The type's shared geometry (algae: the stalk of the chosen length), rendered translucent
    const geometry = this.props.previewGeometry(this.state.placeType, this.state.placeChainLength, this.state.placeWeb);
    if (this.ghostType !== this.state.placeType || this.ghostGeometry !== geometry) {
      this.ghostType = this.state.placeType;
      this.ghostGeometry = geometry;
      this.ghost.clear();
      if (geometry && PROP_DEF_MAP.has(this.state.placeType)) {
        const mesh = new THREE.Mesh(geometry, this.ghostMaterial);
        this.ghost.add(mesh);
      }
    }
    this.ghost.position.copy(this.hit);
    this.ghost.scale.setScalar(this.state.placeScale);
    if (web) this.updateWebGhost();
  }
}
