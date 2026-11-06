import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { BoatModel, BOAT_HALF_LENGTH, BOAT_HALF_WIDTH } from './BoatModel';
import { InputManager } from '../input/InputManager';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { CharacterController } from '../character/CharacterController';
import { COLLISION_GROUPS } from '../config/constants';
import { riverWorld } from '../world/rivers/RiverWorld';
import type { TerrainSystem } from '../world/TerrainSystem';

/** Arcade motorboat tuning. */
export const BOAT_CONFIG = {
  MAX_SPEED_KMH: 36,
  BOOST_SPEED_KMH: 46,
  MAX_REVERSE_KMH: 7,
  ACCEL: 5,
  BRAKE: 7,
  WATER_DRAG: 0.12, // linear part
  WATER_DRAG_QUAD: 0.006, // quadratic part
  TURN_RATE: 1.25, // rad/s
  MIN_TURN_SPEED: 0.6, // m/s for full steering authority at low speed
  STEER_SPEED: 4,
  MIN_DEPTH: 0.45, // keel clearance: shallower water counts as land
  MAX_STEP_UP: 0.35, // waterfalls cannot be climbed
  INTERACT_RADIUS: 3.3,
  CAMERA_FOLLOW_DELAY: 1.0,
} as const;

/**
 * Rideable motorboat. A kinematic box follows the local water surface (`riverWorld.waterLevelAt`,
 * so it floats on the sea, lakes and rivers alike, river currents push it, and it drops down
 * waterfalls but never climbs them). It can only move where the water under its bow, stern and
 * middle is deep enough, so it never drives onto land; colliders (the pier, rocks) block it.
 * Pitch, roll and bobbing are visual only.
 */
export class BoatController {
  public readonly model = new BoatModel();
  public body!: RAPIER.RigidBody;
  public collider!: RAPIER.Collider;
  public isPlayerInside = false;
  public isPlayerNear = false;
  public speedKmh = 0;
  /** 0..1, set by the engine for the bow light. */
  public night = 0;
  /** A dry spot on the pier deck (saves made at sea resume here). */
  public readonly dock = new THREE.Vector3();

  private character: CharacterController | null = null;
  private readonly pos = new THREE.Vector3();
  private surfaceY = 0;
  private speed = 0;
  private yaw: number;
  private steer = 0;
  private yawRate = 0;
  private pitch = 0;
  private roll = 0;
  private spin = 0;
  private elapsed = 0;
  private lastMouseTime = -Infinity;
  private readonly home = new THREE.Vector3();
  private readonly homeYaw: number;
  private readonly flow = { x: 0, z: 0 };

  private static readonly _v = new THREE.Vector3();
  private static readonly _d = new THREE.Vector3();
  private static readonly _down = new THREE.Vector3(0, -1, 0);
  private static readonly _q = new THREE.Quaternion();
  private static readonly _e = new THREE.Euler(0, 0, 0, 'YXZ');
  private static readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly physics: PhysicsWorld,
    scene: THREE.Scene,
    private readonly terrain: TerrainSystem,
    spawn: THREE.Vector3,
    spawnYaw = 0
  ) {
    this.yaw = spawnYaw;
    this.homeYaw = spawnYaw;
    this.home.copy(spawn);
    this.pos.copy(spawn);
    this.surfaceY = riverWorld.waterLevelAt(spawn.x, spawn.z);
    scene.add(this.model.group);
    const { rapier, world } = physics;
    this.body = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, this.surfaceY, spawn.z));
    this.body.userData = { isVehicle: true, type: 'boat' };
    this.collider = world.createCollider(
      rapier.ColliderDesc.cuboid(BOAT_HALF_WIDTH, 0.3, BOAT_HALF_LENGTH * 0.95)
        .setTranslation(0, 0.15, 0)
        .setFriction(0.8)
        .setCollisionGroups(
          physics.packCollisionGroups(COLLISION_GROUPS.DYNAMIC_PROPS, COLLISION_GROUPS.DYNAMIC_PROPS | COLLISION_GROUPS.CHARACTER)
        ),
      this.body
    );
    this.writeBody(true);
    this.syncVisuals(0);
  }

  public getPosition(target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(this.pos.x, this.surfaceY, this.pos.z);
  }

  public getYaw(): number {
    return this.yaw;
  }

  public notifyMouseLook(): void {
    this.lastMouseTime = this.elapsed;
  }

  /** Teleports the boat (save/load). Falls back to its mooring if the spot is not navigable. */
  public place(p: THREE.Vector3, yaw: number): void {
    const ok = this.navigable(p.x, p.z, yaw, riverWorld.waterLevelAt(p.x, p.z));
    const at = ok ? p : this.home;
    this.yaw = ok ? yaw : this.homeYaw;
    this.speed = 0;
    this.pos.set(at.x, 0, at.z);
    this.surfaceY = riverWorld.waterLevelAt(at.x, at.z);
    this.writeBody(true);
  }

  /** Back to the pier (used by the reset key, or when stranded). */
  public returnHome(): void {
    this.place(this.home, this.homeYaw);
  }

  /** Call once per frame BEFORE physics.step(). Returns true while the player drives. */
  public update(dt: number, input: InputManager, camera: ThirdPersonCamera, character: CharacterController, allowEnter = true): boolean {
    this.elapsed += dt;
    const m = input.movement;

    if (!this.isPlayerInside) {
      const cp = character.body.translation();
      const dx = cp.x - this.pos.x, dy = cp.y - this.surfaceY, dz = cp.z - this.pos.z;
      this.isPlayerNear = allowEnter && dx * dx + dz * dz < BOAT_CONFIG.INTERACT_RADIUS ** 2 && dy > -1 && dy < 2.6;
      this.model.setPromptVisible(this.isPlayerNear);
      if (this.isPlayerNear && m.interactJustPressed) this.enter(character, camera);
      if (!this.isPlayerInside) {
        // Moored: drifts to a stop and only rides the swell
        this.drive(dt, 0, 0, true, false, false);
        return false;
      }
    } else if (m.interactJustPressed) {
      this.exit(character, camera);
      return false;
    }

    if (m.reset) this.returnHome();
    this.drive(dt, m.forward, m.right, m.jump, m.sprint, true);
    this.followCamera(dt, camera);
    return true;
  }

  /** Can the hull sit at (x, z) heading `yaw` on water at `level`? */
  private navigable(x: number, z: number, yaw: number, level: number): boolean {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const L = BOAT_HALF_LENGTH * 0.92;
    const W = BOAT_HALF_WIDTH * 0.9;
    // Bow, stern, middle and the two beam points (no temp arrays: this runs every frame)
    return (
      this.deepEnough(x + fx * L, z + fz * L, level) &&
      this.deepEnough(x - fx * L, z - fz * L, level) &&
      this.deepEnough(x, z, level) &&
      this.deepEnough(x + fz * W, z - fx * W, level) &&
      this.deepEnough(x - fz * W, z + fx * W, level)
    );
  }

  private deepEnough(px: number, pz: number, level: number): boolean {
    const w = riverWorld.waterLevelAt(px, pz);
    return w - this.terrain.getHeight(px, pz) >= BOAT_CONFIG.MIN_DEPTH && w <= level + BOAT_CONFIG.MAX_STEP_UP;
  }

  /** Something solid (pier post, rock, building) within `dist` along `dir` at hull height? */
  private blocked(dirX: number, dirZ: number, dist: number): boolean {
    const d = BoatController._d.set(dirX, 0, dirZ);
    if (d.lengthSq() < 1e-6) return false;
    d.normalize();
    const side = BoatController._v;
    // Two heights: posts and rocks at the waterline, a pier deck just above the gunwale
    for (const h of [0.25, 0.7]) {
      for (const off of [-BOAT_HALF_WIDTH * 0.8, 0, BOAT_HALF_WIDTH * 0.8]) {
        side.set(this.pos.x + d.z * off, this.surfaceY + h, this.pos.z - d.x * off);
        if (this.physics.castRay(side, d, dist, true, undefined, undefined, this.collider)) return true;
      }
    }
    return false;
  }

  private drive(dt: number, throttle: number, steerInput: number, brake: boolean, boost: boolean, driven: boolean): void {
    const C = BOAT_CONFIG;
    const maxFwd = (boost ? C.BOOST_SPEED_KMH : C.MAX_SPEED_KMH) / 3.6;
    const maxRev = C.MAX_REVERSE_KMH / 3.6;

    if (brake) {
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), C.BRAKE * dt);
    } else if (throttle > 0.05) {
      const headroom = Math.max(0, 1 - this.speed / maxFwd);
      this.speed += (this.speed < 0 ? C.BRAKE : C.ACCEL * (0.3 + 0.7 * headroom)) * throttle * dt;
      if (this.speed > maxFwd) this.speed = Math.max(maxFwd, this.speed - C.BRAKE * 0.3 * dt);
    } else if (throttle < -0.05) {
      if (this.speed > 0.2) this.speed = Math.max(0, this.speed - C.BRAKE * dt);
      else this.speed = Math.max(-maxRev, this.speed - C.ACCEL * 0.5 * dt);
    }
    // Water drag always works (no "coasting" on water)
    const drag = C.WATER_DRAG * Math.abs(this.speed) + C.WATER_DRAG_QUAD * this.speed * this.speed + (throttle === 0 ? 0.25 : 0);
    this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), drag * dt);

    // Rudder: a boat turns only while water flows past the motor
    this.steer += (steerInput - this.steer) * (1 - Math.exp(-C.STEER_SPEED * dt));
    const speedAbs = Math.abs(this.speed);
    const authority = Math.min(1, (speedAbs + Math.abs(throttle) * 0.8) / (C.MIN_TURN_SPEED + 2.5));
    const targetRate = -this.steer * C.TURN_RATE * authority * Math.sign(this.speed || throttle || 1);
    this.yawRate += (targetRate - this.yawRate) * (1 - Math.exp(-3 * dt));
    const newYaw = this.yaw + this.yawRate * dt;
    if (this.navigable(this.pos.x, this.pos.z, newYaw, this.surfaceY)) this.yaw = newYaw;
    else this.yawRate = 0;

    // Motion: heading speed plus the river current (moored boats stay put)
    if (driven) riverWorld.flowAt(this.pos.x, this.pos.z, this.flow);
    else this.flow.x = this.flow.z = 0;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const mx = (fx * this.speed + this.flow.x * 0.8) * dt;
    const mz = (fz * this.speed + this.flow.z * 0.8) * dt;
    if (mx !== 0 || mz !== 0) {
      const lead = BOAT_HALF_LENGTH + 0.15;
      const stepLen = Math.hypot(mx, mz);
      const tryMove = (ax: number, az: number) =>
        this.navigable(this.pos.x + ax, this.pos.z + az, this.yaw, this.surfaceY) && !this.blocked(ax, az, lead + Math.hypot(ax, az));
      if (stepLen > 0 && tryMove(mx, mz)) {
        this.pos.x += mx;
        this.pos.z += mz;
      } else if (stepLen > 0 && tryMove(mx, 0)) {
        this.pos.x += mx;
        this.speed *= 0.97;
      } else if (stepLen > 0 && tryMove(0, mz)) {
        this.pos.z += mz;
        this.speed *= 0.97;
      } else {
        // Ran aground or into the pier: a soft bump back
        this.speed = -this.speed * 0.2;
      }
    }

    // Surface follows the local water (drops over waterfalls quickly, rises along a river gently)
    const target = riverWorld.waterLevelAt(this.pos.x, this.pos.z);
    this.surfaceY += (target - this.surfaceY) * (1 - Math.exp(-(target < this.surfaceY ? 5 : 8) * dt));
    this.speedKmh = speedAbs * 3.6;
    this.writeBody(false);
  }

  private writeBody(teleport: boolean): void {
    const q = BoatController._q.setFromAxisAngle(BoatController._up, this.yaw);
    if (teleport) {
      this.body.setTranslation({ x: this.pos.x, y: this.surfaceY, z: this.pos.z }, true);
      this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    } else {
      this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.surfaceY, z: this.pos.z });
      this.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
  }

  private followCamera(dt: number, camera: ThirdPersonCamera): void {
    if (this.elapsed - this.lastMouseTime < BOAT_CONFIG.CAMERA_FOLLOW_DELAY || this.speedKmh < 4 || this.speed < 0) return;
    let delta = this.yaw + Math.PI - camera.targetYaw;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    camera.targetYaw += delta * (1 - Math.exp(-2 * dt));
  }

  /** Call once per frame AFTER physics.step(). Swell, planing pitch and banking are visual only. */
  public syncVisuals(dt: number): void {
    const t = this.elapsed;
    const speedT = Math.min(Math.abs(this.speed) / (BOAT_CONFIG.MAX_SPEED_KMH / 3.6), 1);
    // Bow rises while accelerating onto the plane, settles at speed
    const targetPitch = -0.02 - speedT * 0.07 + Math.sin(t * 1.7 + 1) * 0.02 * (1 - speedT * 0.5);
    const targetRoll = THREE.MathUtils.clamp(this.yawRate * speedT * 0.22, -0.2, 0.2) + Math.sin(t * 1.3) * 0.03;
    const k = 1 - Math.exp(-5 * dt);
    this.pitch += (targetPitch - this.pitch) * k;
    this.roll += (targetRoll - this.roll) * k;
    const bob = Math.sin(t * 1.9) * 0.05 + Math.sin(t * 3.1 + 0.7) * 0.02 - speedT * 0.04;

    const g = this.model.group;
    g.position.set(this.pos.x, this.surfaceY, this.pos.z);
    g.rotation.set(0, this.yaw, 0);
    this.model.hull.position.y = bob;
    this.model.hull.quaternion.setFromEuler(BoatController._e.set(this.pitch, 0, this.roll));
    this.spin += (this.isPlayerInside ? 8 + this.speedKmh : 0) * dt;
    this.model.setRig(this.steer, this.spin, this.night);

    if (this.isPlayerInside && this.character) {
      const rider = this.character.model;
      g.updateMatrixWorld(true);
      this.model.seatAnchor.getWorldPosition(rider.group.position);
      this.model.hull.getWorldQuaternion(rider.group.quaternion);
      rider.updateAnimation(dt, RIDER_STATE, null);
    }
  }

  private enter(character: CharacterController, camera: ThirdPersonCamera): void {
    this.isPlayerInside = true;
    this.isPlayerNear = false;
    this.character = character;
    this.model.setPromptVisible(false);
    if (character.carryAbility?.isHolding) character.carryAbility.dropObject();
    if (character.carryAbility) character.carryAbility.enabled = false;
    character.collider.setEnabled(false);
    character.body.setBodyType(this.physics.rapier.RigidBodyType.KinematicPositionBased, true);
    character.body.setTranslation({ x: 0, y: -200, z: 0 }, true);
    character.model.isRiding = true;
    character.model.weaponPivot.visible = false;
    camera.targetDistance = 6.4;
    camera.heightOffset = 1.2;
  }

  /** Steps onto the nearest dry spot (the pier, a beach) or, failing that, into the water beside the boat. */
  private exit(character: CharacterController, camera: ThirdPersonCamera): void {
    this.isPlayerInside = false;
    this.speedKmh = 0;
    this.character = null;
    character.model.isRiding = false;
    character.model.weaponPivot.visible = true;
    character.model.setFacingAngleInstant(this.yaw);
    character.model.group.rotation.set(0, this.yaw, 0);

    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const exitPos = new THREE.Vector3();
    let found = false;
    for (const [side, along] of [[1, 0], [-1, 0], [1, -0.9], [-1, -0.9], [1, 0.9], [-1, 0.9], [0, 1.25], [0, -1.25]]) {
      for (const reach of [BOAT_HALF_WIDTH + 0.8, BOAT_HALF_WIDTH + 1.8]) {
        const sx = side * reach, sz = along * BOAT_HALF_LENGTH;
        const x = this.pos.x + fz * sx + fx * sz;
        const z = this.pos.z - fx * sx + fz * sz;
        const from = BoatController._v.set(x, this.surfaceY + 3, z);
        const hit = this.physics.castRay(from, BoatController._down, 5, true, undefined, undefined, this.collider);
        if (!hit) continue;
        const y = from.y - hit.timeOfImpact;
        if (y > riverWorld.waterLevelAt(x, z) + 0.15 && y < this.surfaceY + 2.2) {
          exitPos.set(x, y + 0.95, z);
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) exitPos.set(this.pos.x + fz * (BOAT_HALF_WIDTH + 0.7), this.surfaceY + 0.3, this.pos.z - fx * (BOAT_HALF_WIDTH + 0.7));

    character.body.setBodyType(this.physics.rapier.RigidBodyType.Dynamic, true);
    character.collider.setEnabled(true);
    if (character.carryAbility) character.carryAbility.enabled = true;
    character.respawn(exitPos);
    camera.targetDistance = 4.2;
    camera.heightOffset = 0.75;
  }
}

const RIDER_STATE = {
  isGrounded: true,
  isMoving: false,
  isSprinting: false,
  isCrouching: false,
  isDashing: false,
  speed: 0,
  verticalVelocity: 0,
};
