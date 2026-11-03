import * as THREE from 'three';
import { PhysicsWorld } from './PhysicsWorld';
import { CharacterController } from '../character/CharacterController';
import { isDoorPiece, BuildingPieceType } from '../building/types/BuildingTypes';

export class DebugRenderer {
  public lines: THREE.LineSegments;
  private material: THREE.LineBasicMaterial;
  private geometry: THREE.BufferGeometry;
  public enabled: boolean = false;

  constructor(private physics: PhysicsWorld, private scene: THREE.Scene) {
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: true,
      transparent: true,
      opacity: 0.90,
    });

    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.lines.visible = enabled;
  }

  public toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  public update(controller?: CharacterController): void {
    if (!this.enabled || !this.physics.isInitialized()) return;

    try {
      let positions: number[] = [];
      let colors: number[] = [];

      try {
        const buffers = this.physics.world.debugRender();
        if (
          buffers &&
          buffers.vertices &&
          buffers.colors &&
          buffers.vertices.buffer &&
          buffers.vertices.buffer.byteLength > 0
        ) {
          const vArr = buffers.vertices;
          const cArr = buffers.colors;
          const vLen = vArr.length;
          const cLen = cArr.length;
          positions = new Array(vLen);
          for (let i = 0; i < vLen; i++) {
            positions[i] = vArr[i];
          }
          colors = new Array(cLen);
          for (let i = 0; i < cLen; i++) {
            colors[i] = cArr[i];
          }
        }
      } catch {
        positions = [];
        colors = [];
      }

      // Append 5 ground raycasts debug visuals if controller is provided
      if (controller && controller.groundRaysDebug && controller.groundRaysDebug.length > 0) {
        for (const ray of controller.groundRaysDebug) {
          const orig = ray.origin;
          const end = ray.isHit && ray.hitPoint ? ray.hitPoint : ray.target;

          // Ray line segment (Origin -> End/Hit)
          positions.push(orig.x, orig.y, orig.z);
          positions.push(end.x, end.y, end.z);

          // Color coding:
          // Center ray hit: Green (0.1, 1.0, 0.2), Edge hit: Cyan (0.0, 0.95, 1.0), Miss: Bright Red (1.0, 0.1, 0.2)
          let r = 1.0, g = 0.1, b = 0.2, a = 1.0;
          if (ray.isHit) {
            if (ray.id === 'center') {
              r = 0.1; g = 1.0; b = 0.2; // Green
            } else {
              r = 0.0; g = 0.95; b = 1.0; // Cyan
            }
          }
          colors.push(r, g, b, a);
          colors.push(r, g, b, a);

          // If ray hit, render crosshair hit marker + surface normal tick mark
          if (ray.isHit && ray.hitPoint && ray.hitNormal) {
            const hp = ray.hitPoint;
            const norm = ray.hitNormal;
            const s = 0.06; // crosshair half-size

            // Hit crosshair line X
            positions.push(hp.x - s, hp.y + 0.01, hp.z);
            positions.push(hp.x + s, hp.y + 0.01, hp.z);
            colors.push(1.0, 1.0, 0.0, 1.0);
            colors.push(1.0, 1.0, 0.0, 1.0);

            // Hit crosshair line Z
            positions.push(hp.x, hp.y + 0.01, hp.z - s);
            positions.push(hp.x, hp.y + 0.01, hp.z + s);
            colors.push(1.0, 1.0, 0.0, 1.0);
            colors.push(1.0, 1.0, 0.0, 1.0);

            // Hit Normal Vector tick line (0.2m long)
            positions.push(hp.x, hp.y, hp.z);
            positions.push(hp.x + norm.x * 0.2, hp.y + norm.y * 0.2, hp.z + norm.z * 0.2);
            colors.push(0.2, 1.0, 0.8, 1.0);
            colors.push(0.2, 1.0, 0.8, 1.0);
          }
        }
      }

      // Render manual wireframes for door sensor triggers (orange wireframe box)
      if (controller && controller.buildAbility && controller.buildAbility.buildingManager) {
        const manager = controller.buildAbility.buildingManager;
        for (const piece of manager.pieces.values()) {
          if (isDoorPiece(piece.type)) {
            const isDoubleWide = piece.type === BuildingPieceType.WOOD_DOOR_DOUBLE || piece.type === BuildingPieceType.DOOR_GRAND_SIDELITES_2X2;
            const hx = isDoubleWide ? 1.3 : 0.8;
            const hy = 1.2;
            const hz = 1.3;

            const localVertices = [
              // Bottom face
              new THREE.Vector3(-hx, -hy, -hz), new THREE.Vector3(hx, -hy, -hz),
              new THREE.Vector3(hx, -hy, -hz), new THREE.Vector3(hx, -hy, hz),
              new THREE.Vector3(hx, -hy, hz), new THREE.Vector3(-hx, -hy, hz),
              new THREE.Vector3(-hx, -hy, hz), new THREE.Vector3(-hx, -hy, -hz),
              // Top face
              new THREE.Vector3(-hx, hy, -hz), new THREE.Vector3(hx, hy, -hz),
              new THREE.Vector3(hx, hy, -hz), new THREE.Vector3(hx, hy, hz),
              new THREE.Vector3(hx, hy, hz), new THREE.Vector3(-hx, hy, hz),
              new THREE.Vector3(-hx, hy, hz), new THREE.Vector3(-hx, hy, -hz),
              // Vertical edges
              new THREE.Vector3(-hx, -hy, -hz), new THREE.Vector3(-hx, hy, -hz),
              new THREE.Vector3(hx, -hy, -hz), new THREE.Vector3(hx, hy, -hz),
              new THREE.Vector3(hx, -hy, hz), new THREE.Vector3(hx, hy, hz),
              new THREE.Vector3(-hx, -hy, hz), new THREE.Vector3(-hx, hy, hz),
            ];

            // Apply door's position and orientation
            for (const v of localVertices) {
              v.applyQuaternion(piece.quaternion);
              v.add(piece.position);
              positions.push(v.x, v.y, v.z);
              // Warm orange sensor color
              colors.push(1.0, 0.65, 0.0, 1.0);
            }
          }
        }
      }

      if (positions.length > 0) {
        this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
      }
    } catch {
      // Safe fallback during physics transitions
    }
  }

  public dispose(): void {
    this.enabled = false;
    this.scene.remove(this.lines);
    this.geometry.dispose();
    this.material.dispose();
  }
}
