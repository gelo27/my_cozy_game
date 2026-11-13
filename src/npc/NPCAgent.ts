import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld, NPC_GHOST_COLLIDERS } from '../physics/PhysicsWorld';
import { CharacterModel } from '../character/CharacterModel';
import { CHARACTER_CONFIG, COLLISION_GROUPS } from '../config/constants';
import { GridNavigator, NavDoor, PathPoint } from '../navigation/GridNavigator';

/** How villagers use doors (BuildingManager behind it). */
export interface DoorControl {
  isOpen(id: string): boolean;
  toggle(id: string, from: THREE.Vector3): void;
}

export const NPC_FEET = CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT + CHARACTER_CONFIG.CAPSULE_RADIUS;
export const NPC_WALK = 4.2;
export const NPC_RUN = 6.6;
/** Colliders of every villager: they walk through each other instead of jamming in a crowd. */
const NPC_COLLIDERS = new Set<number>();
// ...and through open door leaves (see NPC_GHOST_COLLIDERS)
const notNpc = (c: RAPIER.Collider): boolean => !NPC_COLLIDERS.has(c.handle) && !NPC_GHOST_COLLIDERS.has(c.handle);
/** Everything but the player: villagers never block or shove the player, nor the other way round. */
const NPC_FILTER = 0xffff & ~COLLISION_GROUPS.CHARACTER;

/** Re-plan when the goal moved this far from the last planned one (m)... */
const REPLAN_MOVE = 1.2;
/** Searches in a row allowed to return nothing while looking for the way to another floor. */
const SEARCH_TRIES = 40;
/** ...but not more often than this (s). */
const REPLAN_MIN_INTERVAL = 0.35;

/**
 * A walking villager body: a kinematic Rapier character controller (autostep for stairs, snap to
 * ground, slides along walls) steered along paths from GridNavigator, opening doors on the way.
 * Planning is event-driven, not per frame: only when the goal moved enough, the path ran out, or the
 * agent got stuck. When stuck it forgets the cached cells around itself (the world may have
 * changed) and re-plans. Subclasses decide where to go (`drive`).
 */
export class NPCAgent {
  /**
   * Set by the engine: one of this villager's feet planted (from the walk / run clip, like the
   * player's). The engine culls by distance before asking for the ground (`groundUnder`).
   */
  public static onFootstep: ((intensity: number, agent: NPCAgent) => void) | null = null;
  public readonly model: CharacterModel;
  public readonly name: string;
  /** Debug: draws the current path when enabled. */
  public debugLine: THREE.Line | null = null;
  /**
   * Shared planning budget: returns false when another agent already planned this frame, so a crowd
   * never runs several A* searches in one frame (the agent keeps walking and asks again next frame).
   */
  public planGate: (() => boolean) | null = null;
  /** A* node budget per search (smaller for agents that only make short trips). */
  protected planNodes = 2500;
  /** Physics cell samples per search (uncached ground); fewer = cheaper searches, more of them partial. */
  protected planSamples = 160;
  /** A partial plan is continued this long after it was made (s), walking it meanwhile. */
  protected partialRetry = 0.05;

  protected readonly body: RAPIER.RigidBody;
  protected readonly collider: RAPIER.Collider;
  protected readonly kcc: RAPIER.KinematicCharacterController;
  /** Controller query groups: the player's capsule is not an obstacle. */
  private readonly moveGroups: number;
  protected path: PathPoint[] = [];
  protected pathIndex = 0;
  protected stuckTime = 0;
  private searchTries = 0;
  protected speed = 0;
  /** Doors it opened itself, closed again once everyone has walked away. */
  private openedDoors = new Map<string, NavDoor>();
  private lastGoal = new THREE.Vector3(Infinity, 0, Infinity);
  private replanTimer = 0;
  /** The last plan stopped at the sample budget: finish planning a few frames later. */
  private partial = false;
  private vy = 0;
  private grounded = false;
  /** Drawn height of the body: eases up over steps instead of popping (null = not placed yet). */
  private visualY: number | null = null;
  /** Walking speed the animation sees: smoothed, so a one-frame snag doesn't flick it to idle. */
  private animSpeed = 0;

  protected static readonly _v = new THREE.Vector3();
  private static readonly _feet = new THREE.Vector3();
  private static readonly _dir = new THREE.Vector3();

  constructor(
    protected readonly physics: PhysicsWorld,
    protected readonly scene: THREE.Scene,
    protected readonly nav: GridNavigator,
    spawn: THREE.Vector3,
    name: string,
    protected readonly doors: DoorControl | null = null,
    color = 0xd8e8ff
  ) {
    this.name = name;
    this.model = new CharacterModel(color);
    scene.add(this.model.group);
    this.model.onFootstep = (intensity) => NPCAgent.onFootstep?.(intensity, this);

    const rapier = physics.rapier;
    this.body = physics.world.createRigidBody(
      rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + NPC_FEET + 0.05, spawn.z)
    );
    this.collider = physics.world.createCollider(
      rapier.ColliderDesc.capsule(CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT, CHARACTER_CONFIG.CAPSULE_RADIUS).setCollisionGroups(
        physics.packCollisionGroups(COLLISION_GROUPS.DYNAMIC_PROPS, NPC_FILTER)
      ),
      this.body
    );
    NPC_COLLIDERS.add(this.collider.handle);
    this.moveGroups = physics.packCollisionGroups(COLLISION_GROUPS.DYNAMIC_PROPS, NPC_FILTER);
    this.kcc = physics.world.createCharacterController(0.02);
    this.kcc.enableAutostep(0.45, 0.15, true);
    this.kcc.enableSnapToGround(0.4);
    this.kcc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.kcc.setApplyImpulsesToDynamicBodies(false);
  }

  /** Capsule centre. */
  public getPosition(target = new THREE.Vector3()): THREE.Vector3 {
    const t = this.body.translation();
    return target.set(t.x, t.y, t.z);
  }

  /** Point on the ground under the capsule. */
  public getFeet(target = new THREE.Vector3()): THREE.Vector3 {
    const t = this.body.translation();
    return target.set(t.x, t.y - NPC_FEET, t.z);
  }

  /**
   * One movement step toward `goal` (feet level; null stands still) at `targetSpeed`.
   * `other` is where the player is: doors this agent opened stay open while they are close to one.
   * `look` is faced while standing (null keeps the current facing).
   */
  protected drive(dt: number, goal: THREE.Vector3 | null, targetSpeed: number, other: THREE.Vector3, look: THREE.Vector3 | null = null): void {
    const pos = this.getPosition(NPCAgent._v);
    let moveX = 0;
    let moveZ = 0;
    if (goal) {
      const dir = this.steer(pos, goal, dt);
      if (dir) {
        moveX = dir.x;
        moveZ = dir.z;
      } else {
        targetSpeed = 0;
      }
    } else {
      targetSpeed = 0;
      this.path = [];
    }

    this.updateDoors(pos, other);

    // Standing on the ground with nowhere to go: no controller query (most of a crowd, most of the time)
    if (targetSpeed === 0 && this.speed === 0 && this.grounded && this.stuckTime === 0) {
      this.model.group.position.set(pos.x, this.smoothY(pos.y, dt), pos.z);
      this.animSpeed = 0;
      this.animate(dt, 0, look ? Math.atan2(look.x - pos.x, look.z - pos.z) : null);
      return;
    }

    // Accelerate / brake smoothly
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * (targetSpeed > this.speed ? 6 : 10));
    if (targetSpeed === 0 && this.speed < 0.05) this.speed = 0;

    // Gravity; the controller snaps to the ground on slopes and steps
    this.vy = this.grounded ? -1 : Math.max(this.vy - 25 * dt, -30);
    const desired = { x: moveX * this.speed * dt, y: this.vy * dt, z: moveZ * this.speed * dt };
    this.kcc.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, this.moveGroups, notNpc);
    let m = this.kcc.computedMovement();
    this.grounded = this.kcc.computedGrounded();
    // Autostep misses low edges like a floor slab's lip; when blocked, retry the move lifted by a step
    const wantXZ = Math.hypot(desired.x, desired.z);
    if (wantXZ > 0.02 && Math.hypot(m.x, m.z) < wantXZ * 0.25) {
      this.kcc.computeColliderMovement(this.collider, { x: desired.x, y: 0.2, z: desired.z }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, this.moveGroups, notNpc);
      const lifted = this.kcc.computedMovement();
      if (Math.hypot(lifted.x, lifted.z) > wantXZ * 0.5) m = lifted;
    }
    this.body.setNextKinematicTranslation({ x: pos.x + m.x, y: pos.y + m.y, z: pos.z + m.z });

    // Stuck: wanted to walk, barely moved
    const moved = Math.hypot(m.x, m.z);
    if (wantXZ > 0.02 && moved < wantXZ * 0.25) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt * 2);
    if (this.stuckTime > 0.8 && this.path.length) {
      // The cache may be outdated (something was just built here): resample and re-plan
      this.nav.invalidateAround(pos, 2);
      this.path = [];
    }

    // Face movement, or `look` while standing
    const hs = moved / Math.max(dt, 1e-4);
    let faceAngle: number | null = null;
    if (moved > 0.002) faceAngle = Math.atan2(m.x, m.z);
    else if (look) faceAngle = Math.atan2(look.x - pos.x, look.z - pos.z);

    this.model.group.position.set(pos.x + m.x, this.smoothY(pos.y + m.y, dt), pos.z + m.z);
    // Blocked for a frame at a corner or a step: keeps the walk going instead of a hitch to idle
    this.animSpeed += (hs - this.animSpeed) * Math.min(1, dt * (hs > this.animSpeed ? 14 : 10));
    this.animate(dt, this.animSpeed, faceAngle);
  }

  /**
   * The drawn height follows the body, but climbs a step (autostep, a curb, the lifted retry)
   * over a few frames: no little hop. Going down and big changes (teleports) follow at once.
   */
  private smoothY(y: number, dt: number): number {
    const v = this.visualY;
    this.visualY = v === null || y < v || y - v > 0.6 ? y : v + (y - v) * Math.min(1, dt * 12);
    return this.visualY;
  }

  /** Plays the standing / walking clips for horizontal speed `hs`. */
  protected animate(dt: number, hs: number, faceAngle: number | null): void {
    this.model.updateAnimation(
      dt,
      {
        isGrounded: this.grounded,
        isMoving: hs > 0.25,
        isSprinting: hs > NPC_WALK + 0.5,
        isCrouching: false,
        isDashing: false,
        speed: hs,
        verticalVelocity: this.grounded ? 0 : this.vy,
      },
      faceAngle
    );
  }

  /** True once the current path is used up (arrived, or no route this frame). */
  protected get pathDone(): boolean {
    return this.pathIndex >= this.path.length && !this.partial;
  }

  /** Direction (unit, horizontal) toward the next waypoint, planning when needed. */
  private steer(pos: THREE.Vector3, goal: THREE.Vector3, dt: number): THREE.Vector3 | null {
    this.replanTimer -= dt;
    const needPlan =
      this.pathIndex >= this.path.length || this.partial || (this.replanTimer <= 0 && goal.distanceTo(this.lastGoal) > REPLAN_MOVE);
    if (needPlan && this.replanTimer <= 0 && (!this.planGate || this.planGate())) {
      this.replanTimer = REPLAN_MIN_INTERVAL;
      this.lastGoal.copy(goal);
      const feet = NPCAgent._feet.set(pos.x, pos.y - NPC_FEET, pos.z);
      this.path = this.nav.findPath(feet, goal, this.planNodes, this.planSamples);
      this.pathIndex = 0;
      // Partial (budget hit): walk it now, finish planning a few frames later...
      this.partial = this.nav.lastPartial;
      if (this.partial && this.path.length === 0 && this.nav.lastSearching && ++this.searchTries <= SEARCH_TRIES) {
        // Goal on another floor, no way up found yet: stand and keep searching for a moment
        this.replanTimer = this.partialRetry;
      } else if (this.partial) {
        const end = this.path[this.path.length - 1];
        if (!end || Math.hypot(end.x - feet.x, end.z - feet.z) < 1.5) {
          // ...unless it got nowhere: the goal is unreachable (on furniture, across water), and
          // searching the whole window again every few frames would eat the frame budget
          this.partial = false;
          this.replanTimer = 2;
        } else {
          this.replanTimer = this.partialRetry;
        }
      }
      if (this.path.length) this.searchTries = 0;
      this.updateDebugLine(feet);
    }
    if (this.pathIndex >= this.path.length) return null;

    let wp = this.path[this.pathIndex];
    // Door waypoints are hit closely: turning early would cut into an open leaf next to the opening
    while (Math.hypot(wp.x - pos.x, wp.z - pos.z) < (wp.door ? 0.15 : 0.35)) {
      this.pathIndex++;
      if (this.pathIndex >= this.path.length) return null;
      wp = this.path[this.pathIndex];
    }
    return NPCAgent._dir.set(wp.x - pos.x, 0, wp.z - pos.z).normalize();
  }

  /** Forgets the current route (the next drive plans a new one). */
  protected clearPath(): void {
    this.path = [];
    this.pathIndex = 0;
    this.partial = false;
    this.stuckTime = 0;
    this.searchTries = 0;
    this.lastGoal.set(Infinity, 0, Infinity);
  }

  /** Opens a closed door just ahead on the path; closes the ones it opened once left behind. */
  private updateDoors(pos: THREE.Vector3, other: THREE.Vector3): void {
    if (!this.doors) return;
    for (let i = this.pathIndex; i < Math.min(this.path.length, this.pathIndex + 2); i++) {
      const d = this.path[i].door;
      if (!d || Math.hypot(d.x - pos.x, d.z - pos.z) > 1.6 || this.doors.isOpen(d.id)) continue;
      this.doors.toggle(d.id, pos);
      this.openedDoors.set(d.id, d);
    }
    for (const [id, d] of this.openedDoors) {
      if (Math.hypot(d.x - pos.x, d.z - pos.z) < 2.5 || Math.hypot(d.x - other.x, d.z - other.z) < 2.5) continue;
      if (this.path.some((p, i) => i >= this.pathIndex && p.door === d)) continue;
      if (this.doors.isOpen(id)) this.doors.toggle(id, pos);
      this.openedDoors.delete(id);
    }
  }

  /** Moves the capsule onto a ground point (feet level) at once. */
  private static readonly _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  /**
   * Nothing solid between two floor points, tested at waist height (above a bed or a step, below a
   * door's header): a spot behind a wall is not one it got to.
   */
  protected lineClear(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
    const r = NPCAgent._ray;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return true;
    r.origin.x = a.x; r.origin.y = a.y + 1.0; r.origin.z = a.z;
    r.dir.x = dx / len; r.dir.y = dy / len; r.dir.z = dz / len;
    const hit = this.physics.world.castRay(r, len, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, this.moveGroups, undefined, undefined, notNpc);
    return !hit;
  }

  /** What the agent stands on (one short ray down; for footstep surfaces), or null. */
  public groundUnder(): RAPIER.Collider | null {
    const r = NPCAgent._ray;
    const t = this.body.translation();
    r.origin.x = t.x; r.origin.y = t.y - NPC_FEET + 0.3; r.origin.z = t.z;
    r.dir.x = 0; r.dir.y = -1; r.dir.z = 0;
    const hit = this.physics.world.castRay(r, 0.8, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, this.moveGroups, undefined, undefined, notNpc);
    return hit ? hit.collider : null;
  }

  protected placeAt(p: { x: number; y: number; z: number }): void {
    this.body.setTranslation({ x: p.x, y: p.y + NPC_FEET + 0.05, z: p.z }, true);
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y + NPC_FEET + 0.05, z: p.z });
    this.model.group.position.set(p.x, p.y + NPC_FEET + 0.05, p.z);
    this.visualY = null;
    this.clearPath();
    this.vy = 0;
  }

  private updateDebugLine(from: THREE.Vector3): void {
    if (!this.debugLine) return;
    const pts = [from, ...this.path].map((p) => new THREE.Vector3(p.x, p.y + 0.15, p.z));
    this.debugLine.geometry.setFromPoints(pts);
  }

  /** Shows the planned path as a line (dev tool). */
  /** Frees the physics body (subclasses that can be removed). */
  protected disposeBody(): void {
    NPC_COLLIDERS.delete(this.collider.handle);
    this.physics.world.removeCollider(this.collider, false);
    this.physics.world.removeRigidBody(this.body);
  }

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
