import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { MopedModel, MOPED_WHEEL_RADIUS } from './MopedModel';
import { InputManager } from '../input/InputManager';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { CharacterController } from '../character/CharacterController';
import { COLLISION_GROUPS } from '../config/constants';
import { worldSettings } from '../world/WorldSettings';
import type { TerrainSystem } from '../world/TerrainSystem';

/** Arcade scooter tuning: quick to pick up, hard to crash, never tips over. */
export const MOPED_CONFIG = {
  MAX_SPEED_KMH: 52,
  BOOST_SPEED_KMH: 64, // holding Sprint
  MAX_REVERSE_KMH: 8,
  ACCEL: 7.5, // m/s² from standstill, fading toward top speed
  BRAKE: 16,
  COAST_DRAG: 2.2,
  TURN_RATE: 2.5, // rad/s at low speed
  TURN_RATE_AT_SPEED: 1.35, // rad/s at top speed
  STEER_SPEED: 7,
  MAX_LEAN: 0.42,
  MAX_CLIMB_DEG: 38, // steeper ground slows the scooter to a crawl
  RIDE_RADIUS: 0.28, // capsule radius; the capsule lies along the scooter
  RIDE_HALF_LENGTH: 0.42,
  INTERACT_RADIUS: 2.6,
  CAMERA_FOLLOW_DELAY: 1.0,
  CALL_COOLDOWN: 4,
} as const;

/**
 * Rideable scooter. A rotation-locked dynamic capsule slides over the ground; this class picks the
 * velocity along the ground plane every frame (so slopes and bumps feel smooth), while gravity and
 * collisions stay with Rapier. Lean and pitch are purely visual, so it can never fall over.
 * The rider is the real character model, posed on the saddle.
 */
export class MopedController {
  public readonly model = new MopedModel();
  public body!: RAPIER.RigidBody;
  public collider!: RAPIER.Collider;
  public isPlayerInside = false;
  public isPlayerNear = false;
  public speedKmh = 0;

  private character: CharacterController | null = null;
  private speed = 0; // signed m/s along the heading
  private yaw: number;
  private steer = 0;
  private lean = 0;
  private pitch = 0;
  private spin = 0;
  private grounded = false;
  private submergedTime = 0;
  private lastMouseTime = -Infinity;
  private elapsed = 0;
  private callCooldown = 0;
  private readonly lastSafe = new THREE.Vector3();
  private lastSafeYaw = 0;
  private safeTimer = 0;
  private readonly groundNormal = new THREE.Vector3(0, 1, 0);

  private static readonly _v = new THREE.Vector3();
  private static readonly _fwd = new THREE.Vector3();
  private static readonly _down = new THREE.Vector3(0, -1, 0);
  private static readonly _q = new THREE.Quaternion();
  private static readonly _e = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(
    private readonly physics: PhysicsWorld,
    scene: THREE.Scene,
    private readonly terrain: TerrainSystem,
    spawn: THREE.Vector3,
    spawnYaw = 0
  ) {
    this.yaw = spawnYaw;
    this.lastSafe.copy(spawn);
    this.lastSafeYaw = spawnYaw;
    scene.add(this.model.group);
    this.createPhysics(spawn);
    this.syncVisuals(0);
  }

  private createPhysics(spawn: THREE.Vector3): void {
    const { rapier, world } = this.physics;
    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .lockRotations()
        .setLinearDamping(0.05)
        .setCcdEnabled(true)
    );
    this.body.userData = { isVehicle: true, type: 'moped' };
    // The capsule lies along Z: Rapier capsules stand along Y, so turn it on its side
    const q = MopedController._q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    this.collider = world.createCollider(
      rapier.ColliderDesc.capsule(MOPED_CONFIG.RIDE_HALF_LENGTH, MOPED_CONFIG.RIDE_RADIUS)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setMass(140)
        // Min combine: the ground's own friction must not scrub the speed this class sets
        .setFriction(0)
        .setFrictionCombineRule(rapier.CoefficientCombineRule.Min)
        .setRestitution(0)
        .setCollisionGroups(
          this.physics.packCollisionGroups(
            COLLISION_GROUPS.DYNAMIC_PROPS,
            COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS | COLLISION_GROUPS.CHARACTER
          )
        ),
      this.body
    );
    this.applyYaw();
  }

  public getPosition(target = new THREE.Vector3()): THREE.Vector3 {
    const t = this.body.translation();
    return target.set(t.x, t.y, t.z);
  }

  public getYaw(): number {
    return this.yaw;
  }

  public notifyMouseLook(): void {
    this.lastMouseTime = this.elapsed;
  }

  /** Teleports the parked scooter (save/load, "call scooter"). */
  public place(pos: THREE.Vector3, yaw: number): void {
    this.yaw = yaw;
    this.speed = 0;
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.applyYaw();
    this.lastSafe.copy(pos);
    this.lastSafeYaw = yaw;
  }

  /**
   * Brings the parked scooter to the player's side (the "whistle" from horse games).
   * Returns false while on cooldown, when riding, or when there is no dry ground nearby.
   */
  public callTo(character: CharacterController): boolean {
    if (this.isPlayerInside || this.callCooldown > 0) return false;
    const p = character.getPosition();
    const facing = character.getFacingDirection();
    for (const [side, back] of [[1.6, -0.6], [-1.6, -0.6], [0, -2.2], [0, 2.2]]) {
      const x = p.x + facing.z * side + facing.x * back;
      const z = p.z - facing.x * side + facing.z * back;
      const ground = this.findGround(x, p.y + 2, z);
      if (ground === null || ground < worldSettings.waterLevel + 0.1 || Math.abs(ground - (p.y - 0.75)) > 2.5) continue;
      this.place(MopedController._v.set(x, ground + MOPED_CONFIG.RIDE_RADIUS + 0.15, z), Math.atan2(facing.x, facing.z));
      this.callCooldown = MOPED_CONFIG.CALL_COOLDOWN;
      return true;
    }
    return false;
  }

  private findGround(x: number, fromY: number, z: number): number | null {
    const hit = this.physics.castRay(MopedController._v.set(x, fromY, z), MopedController._down, 6, true, undefined, undefined, this.collider);
    return hit ? fromY - hit.timeOfImpact : null;
  }

  /**
   * Call once per frame BEFORE physics.step(). Returns true while the player rides.
   * `allowEnter` is false while another vehicle claimed this frame's interact press.
   */
  public update(dt: number, input: InputManager, camera: ThirdPersonCamera, character: CharacterController, allowEnter = true): boolean {
    this.elapsed += dt;
    this.callCooldown = Math.max(0, this.callCooldown - dt);
    const m = input.movement;
    this.probeGround();
    this.trackSafeSpot(dt);

    if (!this.isPlayerInside) {
      const cp = character.body.translation();
      const t = this.body.translation();
      const dx = cp.x - t.x, dy = cp.y - t.y, dz = cp.z - t.z;
      this.isPlayerNear = allowEnter && dx * dx + dy * dy + dz * dz < MOPED_CONFIG.INTERACT_RADIUS ** 2;
      this.model.setPromptVisible(this.isPlayerNear);
      if (this.isPlayerNear && m.interactJustPressed) this.enter(character, camera);
      if (!this.isPlayerInside) {
        this.park(dt);
        return false;
      }
    } else if (m.interactJustPressed) {
      this.exit(character, camera);
      return false;
    }

    if (m.reset || this.body.translation().y < -30) this.place(this.lastSafe, this.lastSafeYaw);

    // Scooters drown: after a moment in deep water, drop the rider and pop back to the last dry spot
    if (this.isSubmerged()) {
      this.submergedTime += dt;
      if (this.submergedTime > 1.0) {
        this.exit(character, camera);
        this.place(this.lastSafe, this.lastSafeYaw);
        return false;
      }
    } else {
      this.submergedTime = 0;
    }

    this.ride(dt, m.forward, m.right, m.jump, m.sprint);
    this.followCamera(dt, camera);
    return true;
  }

  private park(dt: number): void {
    this.speed *= Math.exp(-6 * dt);
    if (this.body.isSleeping()) return;
    const v = this.body.linvel();
    const fwd = MopedController._fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    if (this.grounded) this.body.setLinvel({ x: fwd.x * this.speed, y: Math.min(v.y, 0), z: fwd.z * this.speed }, true);
    if (this.isSubmerged()) {
      this.submergedTime += dt;
      if (this.submergedTime > 2) this.place(this.lastSafe, this.lastSafeYaw);
    }
  }

  private isSubmerged(): boolean {
    return this.body.translation().y < worldSettings.waterLevel - 0.15;
  }

  private probeGround(): void {
    const t = this.body.translation();
    const reach = MOPED_CONFIG.RIDE_RADIUS + 0.35;
    const hit = this.physics.castRayAndGetNormal(MopedController._v.set(t.x, t.y, t.z), MopedController._down, reach, this.collider);
    this.grounded = !!hit && hit.normal.y > 0.35;
    if (hit && this.grounded) this.groundNormal.lerp(hit.normal, 0.35).normalize();
    else this.groundNormal.lerp(MopedController._v.set(0, 1, 0), 0.05).normalize();
  }

  private trackSafeSpot(dt: number): void {
    this.safeTimer -= dt;
    if (this.safeTimer > 0 || !this.grounded) return;
    this.safeTimer = 0.5;
    const t = this.body.translation();
    if (Math.abs(this.speed) < 9 && this.terrain.getHeight(t.x, t.z) > worldSettings.waterLevel + 0.3 && t.y > worldSettings.waterLevel + 0.3) {
      this.lastSafe.set(t.x, t.y + 0.3, t.z);
      this.lastSafeYaw = this.yaw;
    }
  }

  private ride(dt: number, throttle: number, steerInput: number, brakeHeld: boolean, boost: boolean): void {
    const C = MOPED_CONFIG;
    const maxFwd = (boost ? C.BOOST_SPEED_KMH : C.MAX_SPEED_KMH) / 3.6;
    const maxRev = C.MAX_REVERSE_KMH / 3.6;
    let braking = brakeHeld;

    if (this.grounded) {
      if (brakeHeld) {
        this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), C.BRAKE * dt);
      } else if (throttle > 0.05) {
        if (this.speed < -0.2) {
          this.speed = Math.min(0, this.speed + C.BRAKE * dt);
          braking = true;
        } else {
          const headroom = Math.max(0, 1 - this.speed / maxFwd);
          this.speed += C.ACCEL * throttle * (0.35 + 0.65 * headroom) * dt;
          if (this.speed > maxFwd) this.speed = Math.max(maxFwd, this.speed - C.BRAKE * 0.4 * dt);
        }
      } else if (throttle < -0.05) {
        if (this.speed > 0.2) {
          this.speed = Math.max(0, this.speed - C.BRAKE * dt);
          braking = true;
        } else {
          this.speed = Math.max(-maxRev, this.speed - C.ACCEL * 0.5 * dt);
        }
      } else {
        const drag = C.COAST_DRAG + 0.015 * this.speed * this.speed;
        this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), drag * dt);
      }

      // Hills: gravity along the slope, and a hard limit on climbing walls
      const n = this.groundNormal;
      const fwd = MopedController._fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const along = n.x * fwd.x + n.z * fwd.z; // >0 downhill ahead, <0 uphill
      this.speed += along * 9 * dt * Math.sign(this.speed || 1);
      const climbDeg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(n.y, -1, 1)));
      if (climbDeg > C.MAX_CLIMB_DEG && along * this.speed < 0) this.speed *= Math.exp(-4 * dt);
    }

    // Steering eases in; the turn rate narrows with speed and is zero at a standstill
    const speedAbs = Math.abs(this.speed);
    this.steer += (steerInput - this.steer) * (1 - Math.exp(-C.STEER_SPEED * dt));
    const speedT = Math.min(speedAbs / (C.MAX_SPEED_KMH / 3.6), 1);
    const turnRate = THREE.MathUtils.lerp(C.TURN_RATE, C.TURN_RATE_AT_SPEED, speedT) * Math.min(speedAbs / 2.5, 1);
    const yawRate = -this.steer * turnRate * Math.sign(this.speed || 1);
    this.yaw += yawRate * dt;
    this.applyYaw();

    // Velocity along the ground plane; airborne keeps the physics-integrated velocity
    const v = this.body.linvel();
    const fwd = MopedController._fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    if (this.grounded) {
      const n = this.groundNormal;
      fwd.addScaledVector(n, -fwd.dot(n)).normalize();
      // A small push into the ground keeps the wheels planted over crests
      this.body.setLinvel({ x: fwd.x * this.speed, y: Math.min(fwd.y * this.speed - 0.6, v.y + 0.5), z: fwd.z * this.speed }, true);
    } else {
      // Mid-air the heading still steers the momentum a little
      const h = Math.hypot(v.x, v.z);
      this.body.setLinvel({ x: fwd.x * h * Math.sign(this.speed || 1), y: v.y, z: fwd.z * h * Math.sign(this.speed || 1) }, true);
    }

    this.speedKmh = speedAbs * 3.6;
    const targetLean = THREE.MathUtils.clamp(-yawRate * speedAbs * 0.075, -C.MAX_LEAN, C.MAX_LEAN);
    this.lean += (targetLean - this.lean) * (1 - Math.exp(-6 * dt));
    this.model.setBrakeLight(braking || (throttle < -0.05 && this.speed > 0));
  }

  /** After the physics step: walls and props scrub off speed the body could not actually carry. */
  private reconcileSpeed(): void {
    const v = this.body.linvel();
    const actual = v.x * Math.sin(this.yaw) + v.z * Math.cos(this.yaw);
    if (Math.abs(actual) + 1.2 < Math.abs(this.speed)) this.speed = Math.sign(this.speed) * (Math.abs(actual) + 1.2);
  }

  private applyYaw(): void {
    const q = MopedController._q.setFromAxisAngle(MopedController._v.set(0, 1, 0), this.yaw);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  }

  private followCamera(dt: number, camera: ThirdPersonCamera): void {
    if (this.elapsed - this.lastMouseTime < MOPED_CONFIG.CAMERA_FOLLOW_DELAY || this.speedKmh < 5 || this.speed < 0) return;
    const behindYaw = this.yaw + Math.PI;
    let delta = behindYaw - camera.targetYaw;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    camera.targetYaw += delta * (1 - Math.exp(-2.4 * dt));
  }

  /** Call once per frame AFTER physics.step(). */
  public syncVisuals(dt: number): void {
    if (this.isPlayerInside) this.reconcileSpeed();
    const t = this.body.translation();
    const fwd = MopedController._fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const targetPitch = this.grounded ? Math.asin(THREE.MathUtils.clamp(this.groundNormal.dot(fwd), -1, 1)) : this.pitch * 0.98;
    this.pitch += (targetPitch - this.pitch) * (1 - Math.exp(-10 * dt));
    if (!this.isPlayerInside) this.lean *= Math.exp(-4 * dt);

    const g = this.model.group;
    g.position.set(t.x, t.y - MOPED_CONFIG.RIDE_RADIUS, t.z);
    g.quaternion.setFromEuler(MopedController._e.set(this.pitch, this.yaw, this.lean));
    this.spin += (this.speed / MOPED_WHEEL_RADIUS) * dt;
    this.model.setRig(this.steer * 0.45 * (1 - Math.min(Math.abs(this.speed) / 14, 0.7)), this.spin);

    if (this.isPlayerInside && this.character) {
      const rider = this.character.model;
      g.updateMatrixWorld(true);
      this.model.seatAnchor.getWorldPosition(rider.group.position);
      rider.group.quaternion.copy(g.quaternion);
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

    // The on-foot body leaves the simulation; the visible model rides on the saddle
    character.collider.setEnabled(false);
    character.body.setBodyType(this.physics.rapier.RigidBodyType.KinematicPositionBased, true);
    character.body.setTranslation({ x: 0, y: -200, z: 0 }, true);
    character.model.isRiding = true;
    character.model.weaponPivot.visible = false;
    this.body.wakeUp();

    camera.targetDistance = 5.2;
    camera.heightOffset = 1.0;
  }

  private exit(character: CharacterController, camera: ThirdPersonCamera): void {
    this.isPlayerInside = false;
    this.speedKmh = 0;
    this.character = null;
    this.model.setBrakeLight(false);
    character.model.isRiding = false;
    character.model.weaponPivot.visible = true;
    character.model.setFacingAngleInstant(this.yaw);
    character.model.group.rotation.set(0, this.yaw, 0);

    // Step off to the left of the saddle
    const t = this.body.translation();
    const left = MopedController._v.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const exitPos = new THREE.Vector3(t.x + left.x * 1.0, t.y + 0.9, t.z + left.z * 1.0);

    character.body.setBodyType(this.physics.rapier.RigidBodyType.Dynamic, true);
    character.collider.setEnabled(true);
    if (character.carryAbility) character.carryAbility.enabled = true;
    character.respawn(exitPos);

    camera.targetDistance = 4.2;
    camera.heightOffset = 0.75;
  }

  public dispose(): void {
    this.physics.removeRigidBody(this.body);
    this.model.group.removeFromParent();
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
