import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { InputManager } from '../input/InputManager';
import { TerrainSystem, TerrainBrushKind } from '../world/TerrainSystem';
import { PropSystem, PROP_DEF_MAP } from '../world/PropSystem';
import { TerrainTileType } from '../terrain/types/TerrainTypes';
import { RiverEditTool } from './RiverEditTool';
import type { RiverSystem } from '../world/rivers/RiverSystem';
import { riverWorld, stringifyRivers } from '../world/rivers/RiverWorld';
import type { RiverDef } from '../world/rivers/RiverTypes';

export type EditorTool = 'select' | 'place' | 'sculpt' | 'paint' | 'river';

export interface EditorState {
  tool: EditorTool;
  sculptKind: TerrainBrushKind;
  paintTile: TerrainTileType;
  paintFill: boolean;
  placeType: string;
  placeScale: number;
  placeRandomize: boolean;
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
    placeRandomize: true,
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

  private readonly raycaster = new THREE.Raycaster();
  private readonly cursor: THREE.LineLoop;
  private readonly ghost = new THREE.Group();
  private ghostType = '';
  private readonly gizmo: TransformControls;
  private readonly gizmoTarget = new THREE.Object3D();
  private readonly hit = new THREE.Vector3();
  private hasHit = false;
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

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly input: InputManager,
    private readonly terrain: TerrainSystem,
    private readonly props: PropSystem,
    riverSystem: RiverSystem
  ) {
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
    this.touch();
  }

  public set<K extends keyof EditorState>(key: K, value: EditorState[K]): void {
    this.state[key] = value;
    if (key === 'tool' && value !== 'select') this.select(null);
    if (key === 'gizmoMode') this.gizmo.setMode(value as 'translate' | 'rotate');
    if (key === 'tool') this.rivers.setVisible(this.active && value === 'river');
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
      this.gizmoTarget.rotation.set(0, prop.rotationY, 0);
      this.gizmo.attach(this.gizmoTarget);
      this.gizmo.enabled = true;
      this.gizmo.getHelper().visible = true;
      this.gizmo.showX = this.gizmo.showZ = true;
      this.gizmo.showY = true;
    } else {
      this.gizmo.detach();
      this.gizmo.enabled = false;
      this.gizmo.getHelper().visible = false;
    }
    this.touch();
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
    const id = this.props.add(prop.type, prop.position.x + 1.5, prop.position.z, prop.rotationY, prop.scale);
    this.select(id);
  }

  public setSelectedTransform(position: THREE.Vector3, rotationY: number, scale: number): void {
    const id = this.state.selectedPropId;
    if (id === null) return;
    this.props.setTransform(id, position, rotationY, scale);
    this.gizmoTarget.position.copy(position);
    this.gizmoTarget.rotation.set(0, rotationY, 0);
    this.touch();
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
    this.props.setTransform(prop.id, p, this.gizmoTarget.rotation.y, prop.scale);
    this.touch();
  }

  // ---------------------------------------------------------------- undo

  private snapshot(): Snapshot {
    return {
      heights: this.terrain.heights.slice(),
      tiles: this.terrain.tiles.slice(),
      props: this.props.serialize(),
      rivers: stringifyRivers(riverWorld.defs),
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
    this.terrain.heights.set(s.heights);
    this.terrain.tiles.set(s.tiles);
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
    if (tool === 'river') {
      if (this.rivers.busy) return;
      this.raycaster.setFromCamera(this.input.mouseNDC, this.camera);
      const hit = this.terrain.raycast(this.raycaster.ray, 300, new THREE.Vector3());
      this.rivers.pointerDown(this.raycaster, hit, e.shiftKey);
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
      this.duplicateSelected();
    } else if (this.state.tool === 'river' && !e.ctrlKey && this.rivers.keyDown(e)) {
      // handled by the river tool
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      this.deleteSelected();
    } else if (!e.ctrlKey && !this.looking) {
      const tools: Record<string, EditorTool> = { Digit1: 'select', Digit2: 'place', Digit3: 'sculpt', Digit4: 'paint', Digit5: 'river' };
      if (tools[e.code]) this.set('tool', tools[e.code]);
      if (e.code === 'KeyG') this.set('gizmoMode', 'translate');
      if (e.code === 'KeyR' && this.state.tool === 'select') this.set('gizmoMode', 'rotate');
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

    this.raycaster.setFromCamera(this.input.mouseNDC, this.camera);
    this.hasHit = !!this.terrain.raycast(this.raycaster.ray, 300, this.hit);
    const { tool } = this.state;
    const brushTool = tool === 'sculpt' || tool === 'paint';

    this.updateCursor(brushTool && this.hasHit);
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
        const rnd = this.state.placeRandomize;
        const rot = rnd ? Math.random() * Math.PI * 2 : this.ghost.rotation.y;
        const scale = this.state.placeScale * (rnd ? 0.85 + Math.random() * 0.3 : 1);
        this.props.add(this.state.placeType, this.hit.x, this.hit.z, rot, scale);
        this.lastPlaceAt.copy(this.hit);
        this.touch();
      }
    }
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
    const ground = this.terrain.getHeight(this.camera.position.x, this.camera.position.z);
    this.camera.position.y = Math.max(this.camera.position.y, ground + 0.5);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
  }

  private updateCursor(visible: boolean): void {
    this.cursor.visible = visible;
    if (!visible) return;
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

  private updateGhost(visible: boolean): void {
    this.ghost.visible = visible;
    if (!visible) return;
    if (this.ghostType !== this.state.placeType) {
      this.ghostType = this.state.placeType;
      this.ghost.clear();
      const def = PROP_DEF_MAP.get(this.state.placeType);
      if (def) {
        // Borrow a throwaway prop to get the merged geometry, then render it translucent
        const id = this.props.add(def.id, 0, -1000, 0, 1, -1000, false);
        const batch = this.props.group.getObjectByName(`Props_${def.id}`) as THREE.InstancedMesh;
        const mesh = new THREE.Mesh(
          batch.geometry,
          new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.45, depthWrite: false })
        );
        this.ghost.add(mesh);
        if (id !== null) this.props.remove(id);
      }
    }
    this.ghost.position.copy(this.hit);
    this.ghost.scale.setScalar(this.state.placeScale);
  }
}
