import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { GridNavigator } from '../navigation/GridNavigator';
import { DoorControl, NPCAgent, NPC_FEET, NPC_RUN, NPC_WALK } from './NPCAgent';

export type { DoorControl } from './NPCAgent';

/** How close it walks up to the player before stopping (m). */
const STOP_DIST = 2.0;
/** Beyond this distance, or when stuck for long, it catches up like game companions do (m). */
const TELEPORT_DIST = 45;
/** Height difference that means the player stands on another floor, not just up a slope (m). */
const FLOOR_GAP = 1.2;

/**
 * A villager who can follow the player (E toggles follow / stay). Movement comes from NPCAgent;
 * when stuck for a few seconds or hopelessly far it reappears near the player out of the way.
 */
export class CompanionNPC extends NPCAgent {
  public following = false;

  private static readonly _goal = new THREE.Vector3();

  constructor(physics: PhysicsWorld, scene: THREE.Scene, nav: GridNavigator, spawn: THREE.Vector3, name: string, doors: DoorControl | null = null) {
    super(physics, scene, nav, spawn, name, doors);
  }

  public toggleFollow(): boolean {
    this.following = !this.following;
    this.clearPath();
    return this.following;
  }

  public update(dt: number, player: THREE.Vector3): void {
    const pos = this.getPosition(NPCAgent._v);
    const dx = player.x - pos.x;
    const dz = player.z - pos.z;
    const flat = Math.hypot(dx, dz);
    // On another floor (upstairs above us) the player is far however close they look from above
    const otherFloor = Math.abs(player.y - NPC_FEET - (pos.y - NPC_FEET)) > FLOOR_GAP;
    const dist = otherFloor ? Math.max(flat, STOP_DIST + 1) : flat;
    let goal: THREE.Vector3 | null = null;
    let speed = 0;

    if (this.following) {
      if (dist > TELEPORT_DIST || (this.stuckTime > 3 && dist > 6)) {
        this.teleportNear(player);
        return;
      }
      if (dist > STOP_DIST) {
        if (otherFloor || flat < 0.5) {
          // Another floor: head for the player's own spot (a point short of them could miss the
          // upper floor's edge and land on the ground below); the stop distance halts us on arrival
          goal = CompanionNPC._goal.set(player.x, player.y - NPC_FEET, player.z);
        } else {
          // Aim a little short of the player, on the side we come from, so we don't walk into them
          goal = CompanionNPC._goal.set(player.x - (dx / flat) * 1.4, player.y - NPC_FEET, player.z - (dz / flat) * 1.4);
        }
        speed = dist > 7 ? NPC_RUN : NPC_WALK;
      }
    }
    this.drive(dt, goal, speed, player, dist < 6 ? player : null);
  }

  private teleportNear(player: THREE.Vector3): void {
    const behind = new THREE.Vector3(player.x - 2, player.y - NPC_FEET, player.z - 2);
    const spot = this.nav.snap(behind.x, behind.z, behind.y) ?? this.nav.nearestWalkable(behind, 8);
    this.placeAt(spot ?? { x: player.x, y: player.y - NPC_FEET, z: player.z });
  }
}
