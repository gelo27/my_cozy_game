import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { CharacterModel } from '../character/CharacterModel';
import { CHARACTER_CONFIG, COLLISION_GROUPS } from '../config/constants';
import { GridNavigator } from '../navigation/GridNavigator';

const FEET = CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT + CHARACTER_CONFIG.CAPSULE_RADIUS;
const WALK = 4.2;
const RUN = 6.6;
/** How close it walks up to the player before stopping (m). */
const STOP_DIST = 2.0;
/** Re-plan when the player moved this far from the last goal (m)... */
const REPLAN_MOVE = 1.2;
/** ...but not more often than this (s). */
const REPLAN_MIN_INTERVAL = 0.35;
/** Beyond this distance, or when stuck for long, it catches up like game companions do (m). */
const TELEPORT_DIST = 45;

/**
 * A villager who can follow the player (E toggles follow / stay).
 *
 * Movement is a kinematic Rapier character controller (autostep for stairs, snap to ground, slides
 * along walls), steered along paths from GridNavigator. Planning is event-driven, not per frame:
 * only when the player has moved enough, the path ran out, or the agent got stuck. When stuck it
 * forgets the cached cells around itself (the world may have changed) and re-plans; after a few
 * seconds or when hopelessly far it reappears near the player out of the way.
 */
export class CompanionNPC {
  public readonly model: CharacterModel;
  public following = false;
  public readonly name: string;

  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly kcc: RAPIER.KinematicCharacterController;
  private path: THREE.Vector3[] = [];
  private pathIndex = 0;
  private lastGoal = new THREE.Vector3(Infinity, 0, Infinity);
  private replanTimer = 0;
  private stuckTime = 0;
  private vy = 0;
  private speed = 0;
  private facing = 0;
  private grounded = false;
  /** Debug: draws the current path when enabled. */
  public debugLine: THREE.Line | null = null;

  private static readonly _v = new THREE.Vector3();
  private static readonly _goal = new THREE.Vector3();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
    private readonly nav: GridNavigator,
    spawn: THREE.Vector3,
    name: string
  ) {
    this.name = name;
    this.model = new CharacterModel(0xd8e8ff);
    scene.add(this.model.group);

    const rapier = physics.rapier;
    this.body = physics.world.createRigidBody(
      rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + FEET + 0.05, spawn.z)
    );
    this.collider = physics.world.createCollider(
      rapier.ColliderDesc.capsule(CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT, CHARACTER_CONFIG.CAPSULE_RADIUS).setCollisionGroups(
        physics.packCollisionGroups(COLLISION_GROUPS.DYNAMIC_PROPS, 0xffff)
      ),
      this.body
    );
    this.kcc = physics.world.createCharacterController(0.02);
    this.kcc.enableAutostep(0.45, 0.15, true);
    this.kcc.enableSnapToGround(0.4);
    this.kcc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.kcc.setApplyImpulsesToDynamicBodies(false);
  }

  public getPosition(target = new THREE.Vector3()): THREE.Vector3 {
    const t = this.body.translation();
    return target.set(t.x, t.y, t.z);
  }

  public toggleFollow(): boolean {
    this.following = !this.following;
    this.path = [];
    this.stuckTime = 0;
    return this.following;
  }

  public update(dt: number, player: THREE.Vector3): void {
    const pos = this.getPosition(CompanionNPC._v);
    const dx = player.x - pos.x;
    const dz = player.z - pos.z;
    const dist = Math.hypot(dx, dz);
    let moveX = 0;
    let moveZ = 0;
    let targetSpeed = 0;

    if (this.following) {
      if (dist > TELEPORT_DIST || (this.stuckTime > 3 && dist > 6)) {
        this.teleportNear(player);
        return;
      }
      if (dist > STOP_DIST) {
        const dir = this.steer(pos, player, dist, dt);
        if (dir) {
          moveX = dir.x;
          moveZ = dir.z;
          targetSpeed = dist > 7 ? RUN : WALK;
        }
      } else {
        this.path = [];
      }
    }

    // Accelerate / brake smoothly
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * (targetSpeed > this.speed ? 6 : 10));
    if (targetSpeed === 0 && this.speed < 0.05) this.speed = 0;

    // Gravity; the controller snaps to the ground on slopes and steps
    this.vy = this.grounded ? -1 : Math.max(this.vy - 25 * dt, -30);
    const desired = { x: moveX * this.speed * dt, y: this.vy * dt, z: moveZ * this.speed * dt };
    this.kcc.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    const m = this.kcc.computedMovement();
    this.grounded = this.kcc.computedGrounded();
    this.body.setNextKinematicTranslation({ x: pos.x + m.x, y: pos.y + m.y, z: pos.z + m.z });

    // Stuck: wanted to walk, barely moved
    const wanted = Math.hypot(desired.x, desired.z);
    const moved = Math.hypot(m.x, m.z);
    if (wanted > 0.02 && moved < wanted * 0.25) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt * 2);
    if (this.stuckTime > 0.8 && this.path.length) {
      // The cache may be outdated (something was just built here): resample and re-plan
      this.nav.invalidateAround(pos, 2);
      this.path = [];
    }

    // Face movement, or the player while standing close
    const hs = moved / Math.max(dt, 1e-4);
    let faceAngle: number | null = null;
    if (moved > 0.002) faceAngle = Math.atan2(m.x, m.z);
    else if (dist < 6) faceAngle = Math.atan2(dx, dz);
    if (faceAngle !== null) this.facing = faceAngle;

    this.model.group.position.set(pos.x + m.x, pos.y + m.y, pos.z + m.z);
    this.model.updateAnimation(
      dt,
      {
        isGrounded: this.grounded,
        isMoving: hs > 0.25,
        isSprinting: hs > WALK + 0.5,
        isCrouching: false,
        isDashing: false,
        speed: hs,
        verticalVelocity: this.grounded ? 0 : this.vy,
      },
      faceAngle
    );
  }

  /** Direction (unit, horizontal) toward the next waypoint, planning when needed. */
  private steer(pos: THREE.Vector3, player: THREE.Vector3, dist: number, dt: number): THREE.Vector3 | null {
    this.replanTimer -= dt;
    // Aim a little short of the player, on the side we come from, so we don't walk into them
    const goal = CompanionNPC._goal.set(player.x - ((player.x - pos.x) / dist) * 1.4, player.y - FEET, player.z - ((player.z - pos.z) / dist) * 1.4);
    const feet = new THREE.Vector3(pos.x, pos.y - FEET, pos.z);

    const needPlan =
      this.pathIndex >= this.path.length ||
      this.nav.lastPartial ||
      (this.replanTimer <= 0 && goal.distanceTo(this.lastGoal) > REPLAN_MOVE);
    if (needPlan && this.replanTimer <= 0) {
      this.replanTimer = REPLAN_MIN_INTERVAL;
      this.lastGoal.copy(goal);
      this.path = this.nav.findPath(feet, goal);
      this.pathIndex = 0;
      // Partial (sample budget hit): walk it now, finish planning a few frames later
      if (this.nav.lastPartial) this.replanTimer = 0.05;
      this.updateDebugLine(feet);
    }
    if (this.pathIndex >= this.path.length) return null;

    let wp = this.path[this.pathIndex];
    while (Math.hypot(wp.x - pos.x, wp.z - pos.z) < 0.35) {
      this.pathIndex++;
      if (this.pathIndex >= this.path.length) return null;
      wp = this.path[this.pathIndex];
    }
    const d = new THREE.Vector3(wp.x - pos.x, 0, wp.z - pos.z);
    return d.normalize();
  }

  private teleportNear(player: THREE.Vector3): void {
    const behind = new THREE.Vector3(player.x - 2, player.y - FEET, player.z - 2);
    const spot = this.nav.snap(behind.x, behind.z, behind.y) ?? this.nav.nearestWalkable(behind, 8);
    const p = spot ?? { x: player.x, y: player.y - FEET, z: player.z };
    this.body.setTranslation({ x: p.x, y: p.y + FEET + 0.05, z: p.z }, true);
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y + FEET + 0.05, z: p.z });
    this.path = [];
    this.stuckTime = 0;
    this.vy = 0;
  }

  private updateDebugLine(from: THREE.Vector3): void {
    if (!this.debugLine) return;
    const pts = [from, ...this.path].map((p) => new THREE.Vector3(p.x, p.y + 0.15, p.z));
    this.debugLine.geometry.setFromPoints(pts);
  }

  /** Shows the planned path as a line (dev tool). */
  public setDebug(on: boolean): void {
    if (on && !this.debugLine) {
      this.debugLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff3366, depthTest: false }));
      this.debugLine.renderOrder = 999;
      this.debugLine.frustumCulled = false;
      this.scene.add(this.debugLine);
    } else if (!on && this.debugLine) {
      this.scene.remove(this.debugLine);
      this.debugLine.geometry.dispose();
      this.debugLine = null;
    }
  }
}
