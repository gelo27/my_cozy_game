import * as THREE from 'three';
import { ProceduralRoofConfig, DEFAULT_ROOF_CONFIG, ProceduralRoofGenerator } from './ProceduralRoofSystem';

export type GizmoHandleType = 'left' | 'right' | 'front' | 'back' | 'top' | 'move';

export interface RoofGizmoChangeCallback {
  (config: ProceduralRoofConfig, position?: THREE.Vector3): void;
}

/**
 * Interactive 3D Gizmo Controller for Procedural Roofs
 * Provides real-time 3D handles for editing:
 * - minX (Left, Red)
 * - maxX (Right, Red)
 * - minZ (Front, Blue)
 * - maxZ (Back, Blue)
 * - height (Top, Green)
 * - move (Center, White)
 * With ray-plane projection math, grid snapping, and live geometry regeneration.
 */
export class ProceduralRoofGizmos {
  public group: THREE.Group;
  private handles: Map<GizmoHandleType, THREE.Mesh> = new Map();
  private isDragging: boolean = false;
  private activeGizmo: GizmoHandleType | null = null;
  private startWorldPos: THREE.Vector3 | null = null;
  private dragOffset: THREE.Vector3 | null = null;

  private startMinX: number = -1;
  private startMaxX: number = 1;
  private startMinZ: number = -1;
  private startMaxZ: number = 1;
  private startHeight: number = 1;
  private startEntityPos: THREE.Vector3 = new THREE.Vector3();

  public config: ProceduralRoofConfig;
  public gizmoScale: number = 1.0;
  public isEnabled: boolean = true;

  private raycaster = new THREE.Raycaster();
  private mouseVec = new THREE.Vector2();

  constructor(
    private camera: THREE.Camera,
    private domElement: HTMLElement,
    initialConfig: Partial<ProceduralRoofConfig> = {},
    private onChange?: RoofGizmoChangeCallback
  ) {
    this.config = { ...DEFAULT_ROOF_CONFIG, ...initialConfig };
    this.group = new THREE.Group();
    this.group.name = 'ProceduralRoofGizmos_Group';

    this.createGizmos();
    this.updateGizmoPositions();

    this.bindEvents();
  }

  private createGizmos(): void {
    const s = 0.3 * (this.gizmoScale || 1.0);

    const configs: Array<{
      name: GizmoHandleType;
      color: number;
      type: 'cone' | 'box';
      rotation?: THREE.Euler;
    }> = [
      { name: 'left', color: 0xef4444, type: 'cone', rotation: new THREE.Euler(0, 0, Math.PI / 2) },
      { name: 'right', color: 0xef4444, type: 'cone', rotation: new THREE.Euler(0, 0, -Math.PI / 2) },
      { name: 'front', color: 0x3b82f6, type: 'cone', rotation: new THREE.Euler(-Math.PI / 2, 0, 0) },
      { name: 'back', color: 0x3b82f6, type: 'cone', rotation: new THREE.Euler(Math.PI / 2, 0, 0) },
      { name: 'top', color: 0x22c55e, type: 'cone', rotation: new THREE.Euler(0, 0, 0) },
      { name: 'move', color: 0xf8fafc, type: 'box' },
    ];

    configs.forEach((cfg) => {
      let geo: THREE.BufferGeometry;
      if (cfg.type === 'cone') {
        geo = new THREE.ConeGeometry(s * 0.7, s * 1.6, 16);
      } else {
        geo = new THREE.BoxGeometry(s * 1.1, s * 1.1, s * 1.1);
      }

      if (cfg.rotation) {
        geo.applyQuaternion(new THREE.Quaternion().setFromEuler(cfg.rotation));
      }

      const mat = new THREE.MeshBasicMaterial({
        color: cfg.color,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.9,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `Gizmo_${cfg.name}`;
      mesh.renderOrder = 9999;
      mesh.userData = { gizmoType: cfg.name };

      this.handles.set(cfg.name, mesh);
      this.group.add(mesh);
    });
  }

  public updateGizmoPositions(): void {
    const midX = (this.config.minX + this.config.maxX) / 2;
    const midZ = (this.config.minZ + this.config.maxZ) / 2;
    const offset = 0.45 * this.gizmoScale;

    const positions: Record<GizmoHandleType, THREE.Vector3> = {
      left: new THREE.Vector3(this.config.minX - offset, 0, midZ),
      right: new THREE.Vector3(this.config.maxX + offset, 0, midZ),
      front: new THREE.Vector3(midX, 0, this.config.minZ - offset),
      back: new THREE.Vector3(midX, 0, this.config.maxZ + offset),
      top: new THREE.Vector3(midX, this.config.height + offset, midZ),
      move: new THREE.Vector3(midX, 0, midZ),
    };

    positions.left && this.handles.get('left')?.position.copy(positions.left);
    positions.right && this.handles.get('right')?.position.copy(positions.right);
    positions.front && this.handles.get('front')?.position.copy(positions.front);
    positions.back && this.handles.get('back')?.position.copy(positions.back);
    positions.top && this.handles.get('top')?.position.copy(positions.top);
    positions.move && this.handles.get('move')?.position.copy(positions.move);
  }

  public setConfig(newConfig: Partial<ProceduralRoofConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.updateGizmoPositions();
  }

  public setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.isEnabled = visible;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.isEnabled || !this.group.visible) return;
    if (e.button !== 0) return; // Left mouse only

    const rect = this.domElement.getBoundingClientRect();
    this.mouseVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouseVec, this.camera);
    const meshes = Array.from(this.handles.values());
    const intersects = this.raycaster.intersectObjects(meshes, false);

    if (intersects.length > 0) {
      const hit = intersects[0].object as THREE.Mesh;
      const type = hit.userData.gizmoType as GizmoHandleType;
      if (type) {
        this.isDragging = true;
        this.activeGizmo = type;

        this.startEntityPos = this.group.position.clone();
        this.startWorldPos = this.getRayPlaneIntersection(e.clientX, e.clientY);

        this.startMinX = this.config.minX;
        this.startMaxX = this.config.maxX;
        this.startMinZ = this.config.minZ;
        this.startMaxZ = this.config.maxZ;
        this.startHeight = this.config.height;
        this.dragOffset = null;

        e.stopPropagation();
      }
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.isDragging || !this.activeGizmo || !this.startWorldPos) return;

    const currentWorldPos = this.getRayPlaneIntersection(e.clientX, e.clientY);
    const delta = new THREE.Vector3().subVectors(currentWorldPos, this.startWorldPos);

    const snapSize = this.config.snapSize || 0.5;
    const snap = (v: number) => Math.round(v / snapSize) * snapSize;
    const minSize = this.config.minSize || 0.2;
    const minH = this.config.minHeight || 0.1;
    const maxH = this.config.maxHeight || 5.0;

    let changed = false;

    switch (this.activeGizmo) {
      case 'move': {
        const newPos = new THREE.Vector3(
          snap(this.startEntityPos.x + delta.x),
          snap(this.startEntityPos.y + delta.y),
          snap(this.startEntityPos.z + delta.z)
        );
        this.group.position.copy(newPos);
        changed = true;
        break;
      }

      case 'left': {
        let nMinX = snap(this.startMinX + delta.x);
        if (nMinX > this.config.maxX - minSize) nMinX = this.config.maxX - minSize;
        if (nMinX !== this.config.minX) {
          this.config.minX = nMinX;
          changed = true;
        }
        break;
      }

      case 'right': {
        let nMaxX = snap(this.startMaxX + delta.x);
        if (nMaxX < this.config.minX + minSize) nMaxX = this.config.minX + minSize;
        if (nMaxX !== this.config.maxX) {
          this.config.maxX = nMaxX;
          changed = true;
        }
        break;
      }

      case 'front': {
        let nMinZ = snap(this.startMinZ + delta.z);
        if (nMinZ > this.config.maxZ - minSize) nMinZ = this.config.maxZ - minSize;
        if (nMinZ !== this.config.minZ) {
          this.config.minZ = nMinZ;
          changed = true;
        }
        break;
      }

      case 'back': {
        let nMaxZ = snap(this.startMaxZ + delta.z);
        if (nMaxZ < this.config.minZ + minSize) nMaxZ = this.config.minZ + minSize;
        if (nMaxZ !== this.config.maxZ) {
          this.config.maxZ = nMaxZ;
          changed = true;
        }
        break;
      }

      case 'top': {
        let nH = snap(this.startHeight + delta.y);
        if (nH < minH) nH = minH;
        if (nH > maxH) nH = maxH;
        if (nH !== this.config.height) {
          this.config.height = nH;
          changed = true;
        }
        break;
      }
    }

    if (changed) {
      this.updateGizmoPositions();
      this.onChange?.(this.config, this.group.position);
    }
  };

  private onPointerUp = () => {
    this.isDragging = false;
    this.activeGizmo = null;
    this.startWorldPos = null;
    this.dragOffset = null;
  };

  private getRayPlaneIntersection(clientX: number, clientY: number): THREE.Vector3 {
    const rect = this.domElement.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;

    const rayOrigin = new THREE.Vector3();
    const rayDir = new THREE.Vector3();

    if (this.camera instanceof THREE.PerspectiveCamera) {
      rayOrigin.setFromMatrixPosition(this.camera.matrixWorld);
      rayDir.set(x, y, 0.5).unproject(this.camera).sub(rayOrigin).normalize();
    } else {
      rayOrigin.set(x, y, -1).unproject(this.camera);
      rayDir.set(0, 0, -1).transformDirection(this.camera.matrixWorld);
    }

    let planeNormal = new THREE.Vector3(0, 1, 0);

    if (this.activeGizmo === 'top' || this.activeGizmo === 'move') {
      const camForward = new THREE.Vector3();
      this.camera.getWorldDirection(camForward);
      planeNormal.copy(camForward).negate();
      planeNormal.y = 0;
      if (planeNormal.lengthSq() < 0.001) planeNormal.set(0, 0, 1);
      planeNormal.normalize();
    }

    const planePoint = this.group.position;
    const dot = planeNormal.dot(rayDir);
    if (Math.abs(dot) < 0.0001) return planePoint.clone();

    const t = planeNormal.dot(new THREE.Vector3().subVectors(planePoint, rayOrigin)) / dot;
    return rayOrigin.clone().add(rayDir.clone().multiplyScalar(t));
  }

  private bindEvents(): void {
    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  public dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);

    this.handles.forEach((mesh) => {
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else {
        mesh.material.dispose();
      }
    });
    this.handles.clear();

    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
  }
}
