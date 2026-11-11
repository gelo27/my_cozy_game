import * as THREE from 'three';
import type { TerrainSystem } from '../world/TerrainSystem';

/** How far from the player (horizontal m) an aimed shovel / planting spot may be. */
export const GROUND_AIM_REACH = 4.5;

export interface GroundAimHit {
  /** Where the crosshair ray meets the ground. */
  point: THREE.Vector3;
  /** Within GROUND_AIM_REACH of the player. */
  inReach: boolean;
}

const STEP = 0.35;

/**
 * Where the crosshair (the camera's centre ray) meets the terrain, for aiming the shovel and the
 * things planted from the hotbar with RMB, like the slingshot. Marches the height field in
 * STEP-metre steps over a short stretch past the player, then bisects the crossing: a few dozen
 * height lookups per frame, and only while aiming.
 */
export class GroundAim {
  private readonly hit: GroundAimHit = { point: new THREE.Vector3(), inReach: false };

  constructor(private readonly terrain: TerrainSystem) {}

  public update(eye: THREE.Vector3, dir: THREE.Vector3, player: THREE.Vector3): GroundAimHit | null {
    const t = this.terrain;
    // Start a little past the camera (it can sit inside a slope), end a bit beyond the reach
    const toPlayer = Math.hypot(player.x - eye.x, player.y - eye.y, player.z - eye.z);
    const far = toPlayer + GROUND_AIM_REACH + 2;
    let prev = 0.5;
    if (eye.y + dir.y * prev < t.getHeight(eye.x + dir.x * prev, eye.z + dir.z * prev)) return null;
    let found = -1;
    for (let d = prev + STEP; d <= far; d += STEP) {
      if (eye.y + dir.y * d <= t.getHeight(eye.x + dir.x * d, eye.z + dir.z * d)) {
        found = d;
        break;
      }
      prev = d;
    }
    if (found < 0) return null;
    // Bisect the step that crossed the ground
    let lo = prev, hi = found;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) * 0.5;
      if (eye.y + dir.y * mid <= t.getHeight(eye.x + dir.x * mid, eye.z + dir.z * mid)) hi = mid;
      else lo = mid;
    }
    const p = this.hit.point.set(eye.x + dir.x * hi, 0, eye.z + dir.z * hi);
    p.y = t.getHeight(p.x, p.z);
    this.hit.inReach = Math.hypot(p.x - player.x, p.z - player.z) <= GROUND_AIM_REACH && Math.abs(p.y - (player.y - 0.9)) < 2.5;
    return this.hit;
  }
}
