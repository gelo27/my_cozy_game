import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { GridNavigator } from '../navigation/GridNavigator';
import { DoorControl, NPCAgent, NPC_FEET, NPC_RUN, NPC_WALK } from './NPCAgent';
import { npcSwimFeet, npcWaterLevel } from './NPCWater';

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

  public update(dt: number, player: THREE.Vector3, playerSwimming = false): void {
    const pos = this.getPosition(NPCAgent._v);
    const dx = player.x - pos.x;
    const dz = player.z - pos.z;
    const flat = Math.hypot(dx, dz);
    // On another floor (upstairs above us) the player is far however close they look from above
    const waterLevel = playerSwimming ? npcWaterLevel(player.x, player.y, player.z) : NaN;
    const swimmingGoal = Number.isFinite(waterLevel);
    const goalY = swimmingGoal ? npcSwimFeet(waterLevel) : player.y - NPC_FEET;
    const otherFloor = Math.abs(goalY - (pos.y - NPC_FEET)) > FLOOR_GAP;
    const headingAshore = this.isSwimming && !swimmingGoal;
    const dist = otherFloor ? Math.max(flat, STOP_DIST + 1) : flat;
    let goal: THREE.Vector3 | null = null;
    let speed = 0;

    if (this.following) {
      if (dist > TELEPORT_DIST || (this.stuckTime > 3 && dist > 6)) {
        this.teleportNear(player, goalY, swimmingGoal);
        return;
      }
      if (dist > STOP_DIST || headingAshore) {
        if (swimmingGoal || headingAshore || otherFloor || flat < 0.5) {
          // Use the player’s shore side or floor by aiming at their exact column.
          // The stop distance still halts the companion short of them.
          goal = CompanionNPC._goal.set(player.x, goalY, player.z);
        } else {
          // Aim a little short of the player, on the side we come from, so we don't walk into them
          goal = CompanionNPC._goal.set(player.x - (dx / flat) * 1.4, goalY, player.z - (dz / flat) * 1.4);
        }
        speed = dist > 7 ? NPC_RUN : NPC_WALK;
      }
    }
    this.drive(dt, goal, speed, player, dist < 6 ? player : null);
  }

  private teleportNear(player: THREE.Vector3, goalY: number, swimmingGoal: boolean): void {
    if (swimmingGoal) {
      this.placeAt({ x: player.x, y: goalY, z: player.z });
      return;
    }
    const behind = new THREE.Vector3(player.x - 2, goalY, player.z - 2);
    const spot = this.nav.snap(behind.x, behind.z, behind.y) ?? this.nav.nearestWalkable(behind, 8);
    this.placeAt(spot ?? { x: player.x, y: goalY, z: player.z });
  }
}
