import * as THREE from 'three';
import { PhysicsWorld } from './PhysicsWorld';
import { CharacterController } from '../character/CharacterController';
import { isDoorPiece, BuildingPieceType } from '../building/types/BuildingTypes';
import { SEA_FLOOR_Y, WORLD_LIMIT } from '../world/WorldSettings';

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
    // The controller builds its per-frame ground-ray list only while someone draws it
    if (controller) controller.collectGroundRaysDebug = this.enabled;
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
          // Rapier draws the giant open-sea floor and the four safety walls at the world limit.
          // They are physics safety nets, not scene geometry; showing their outlines makes the
          // ocean look like it has a dotted seam and the island look boxed in by giant walls.
          for (let i = 0, color = 0; i + 5 < vArr.length && color + 7 < cArr.length; i += 6, color += 8) {
            const x1 = vArr[i], y1 = vArr[i + 1], z1 = vArr[i + 2];
            const x2 = vArr[i + 3], y2 = vArr[i + 4], z2 = vArr[i + 5];
            const atWorldEdge = (x: number, z: number) =>
              (Math.abs(Math.abs(x) - WORLD_LIMIT) < 2 && Math.abs(z) <= WORLD_LIMIT + 2) ||
              (Math.abs(Math.abs(z) - WORLD_LIMIT) < 2 && Math.abs(x) <= WORLD_LIMIT + 2);
            const safetyNetEdge = atWorldEdge(x1, z1) && atWorldEdge(x2, z2) &&
              Math.max(y1, y2) <= 50 && Math.min(y1, y2) >= SEA_FLOOR_Y - 2;
            if (safetyNetEdge) continue;
            for (let j = 0; j < 6; j++) positions.push(vArr[i + j]);
            for (let j = 0; j < 8; j++) colors.push(cArr[color + j]);
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
