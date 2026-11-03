import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { VehicleModel } from './VehicleModel';
import { InputManager } from '../input/InputManager';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { CharacterController } from '../character/CharacterController';
import { COLLISION_GROUPS } from '../config/constants';

/** Tuning for a relaxed, forgiving farm-truck feel (not a racing sim). */
export const VEHICLE_CONFIG = {
  MASS: 900,
  ENGINE_FORCE: 2600, // N per wheel, all-wheel drive so the truck climbs bumps and slopes
  REVERSE_FORCE: 1600,
  MAX_SPEED_KMH: 55,
  MAX_REVERSE_KMH: 18,
  BRAKE: 18,
  HANDBRAKE: 30,
  ROLLING_BRAKE: 8, // engine braking when no throttle
  COAST_DAMPING: 0.8, // body drag with no throttle: from 50 km/h to a stop in ~3 s
  MAX_STEER: 0.6,
  MIN_STEER_AT_SPEED: 0.3, // steer limit at top speed, keeps the truck stable
  STEER_SPEED: 8.0, // how fast the wheels turn toward the input (1/s)
  STEER_RETURN_SPEED: 10.0, // how fast they re-centre when the input is released
  WHEEL_RADIUS: 0.38,
  SUSPENSION_REST: 0.32,
  SUSPENSION_TRAVEL: 0.18,
  SUSPENSION_STIFFNESS: 75, // world gravity is -22, so springs are stiffer than a real truck
  SUSPENSION_COMPRESSION: 4.4,
  SUSPENSION_RELAXATION: 5.2,
  FRICTION_SLIP: 4.0,
  SIDE_FRICTION: 1.4,
  STUCK_SECONDS: 1.2, // throttle held without moving this long triggers a gentle nudge
  INTERACT_RADIUS: 3.2,
  CAMERA_FOLLOW_DELAY: 1.2, // seconds after the last mouse move before the camera swings behind
} as const;

// Chassis-space wheel connection points (forward = +Z). FL, FR, RL, RR
const WHEEL_CONNECTIONS = [
  new THREE.Vector3(-0.82, 0.55, 1.3),
  new THREE.Vector3(0.82, 0.55, 1.3),
  new THREE.Vector3(-0.82, 0.55, -1.25),
  new THREE.Vector3(0.82, 0.55, -1.25),
];

/**
 * Drivable truck built on Rapier's native ray-cast vehicle controller.
 * Suspension, tyre friction and steering are solved in WASM; this class only maps input to
 * wheel forces and syncs visuals, with zero per-frame allocations.
 */
export class VehicleController {
  public readonly model: VehicleModel;
  public body!: RAPIER.RigidBody;
  public collider!: RAPIER.Collider;
  public isPlayerInside = false;
  public isPlayerNear = false;
  public speedKmh = 0;

  private controller!: RAPIER.DynamicRayCastVehicleController;
  private steer = 0;
  private stuckTime = 0;
  private coasting = false;
  private wheelSpin = [0, 0, 0, 0];
  private upsideDownTime = 0;
  private lastMouseTime = -Infinity;
  private elapsed = 0;
  private readonly spawnPosition: THREE.Vector3;
  private readonly spawnYaw: number;

  private static readonly _v = new THREE.Vector3();
  private static readonly _q = new THREE.Quaternion();
  private static readonly _up = new THREE.Vector3();

  constructor(private readonly physics: PhysicsWorld, scene: THREE.Scene, spawn: THREE.Vector3, spawnYaw = 0) {
    this.spawnPosition = spawn.clone();
    this.spawnYaw = spawnYaw;
    this.model = new VehicleModel(
      VEHICLE_CONFIG.WHEEL_RADIUS,
      WHEEL_CONNECTIONS.map((p) => new THREE.Vector3(p.x, p.y - VEHICLE_CONFIG.SUSPENSION_REST, p.z))
    );
    scene.add(this.model.group);
    this.createPhysics();
    this.syncVisuals(0);
  }

  private createPhysics(): void {
    const { rapier, world } = this.physics;
    const q = VehicleController._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.spawnYaw);
    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(this.spawnPosition.x, this.spawnPosition.y, this.spawnPosition.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0.1)
        .setAngularDamping(0.6)
        .setCcdEnabled(true)
    );
    this.body.userData = { isVehicle: true, type: 'vehicle' };

    this.collider = world.createCollider(
      // Rounded edges slide over terrain crests instead of catching on them; low friction so a
      // bottomed-out chassis doesn't glue itself to the ground
      rapier.ColliderDesc.roundCuboid(0.78, 0.3, 2.0, 0.12)
        .setTranslation(0, 0.85, 0)
        // Low centre of mass keeps it planted in turns; inertia tuned for a light, responsive yaw
        .setMassProperties(
          VEHICLE_CONFIG.MASS,
          { x: 0, y: -0.45, z: 0 },
          { x: 1400, y: 1150, z: 320 },
          { x: 0, y: 0, z: 0, w: 1 }
        )
        .setFriction(0.15)
        .setCollisionGroups(
          this.physics.packCollisionGroups(
            COLLISION_GROUPS.DYNAMIC_PROPS,
            COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS | COLLISION_GROUPS.CHARACTER
          )
        ),
      this.body
    );

    this.controller = world.createVehicleController(this.body);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;
    const down = { x: 0, y: -1, z: 0 };
    const axle = { x: -1, y: 0, z: 0 };
    WHEEL_CONNECTIONS.forEach((p, i) => {
      this.controller.addWheel(p, down, axle, VEHICLE_CONFIG.SUSPENSION_REST, VEHICLE_CONFIG.WHEEL_RADIUS);
      this.controller.setWheelMaxSuspensionTravel(i, VEHICLE_CONFIG.SUSPENSION_TRAVEL);
      this.controller.setWheelSuspensionStiffness(i, VEHICLE_CONFIG.SUSPENSION_STIFFNESS);
      this.controller.setWheelSuspensionCompression(i, VEHICLE_CONFIG.SUSPENSION_COMPRESSION);
      this.controller.setWheelSuspensionRelaxation(i, VEHICLE_CONFIG.SUSPENSION_RELAXATION);
      this.controller.setWheelMaxSuspensionForce(i, VEHICLE_CONFIG.MASS * 60);
      this.controller.setWheelFrictionSlip(i, VEHICLE_CONFIG.FRICTION_SLIP);
      this.controller.setWheelSideFrictionStiffness(i, VEHICLE_CONFIG.SIDE_FRICTION);
    });
  }

  public getPosition(target = new THREE.Vector3()): THREE.Vector3 {
    const t = this.body.translation();
    return target.set(t.x, t.y, t.z);
  }

  public notifyMouseLook(): void {
    this.lastMouseTime = this.elapsed;
  }

  /**
   * Call once per frame BEFORE physics.step(). Handles enter/exit, driving and the parked state.
   * Returns true while the player is driving (the caller then skips the on-foot character update).
   */
  public update(dt: number, input: InputManager, camera: ThirdPersonCamera, character: CharacterController): boolean {
    this.elapsed += dt;
    const m = input.movement;

    if (!this.isPlayerInside) {
      // Cheap squared-distance proximity test, no allocations
      const cp = character.body.translation();
      const t = this.body.translation();
      const dx = cp.x - t.x, dy = cp.y - t.y, dz = cp.z - t.z;
      this.isPlayerNear = dx * dx + dy * dy + dz * dz < VEHICLE_CONFIG.INTERACT_RADIUS ** 2;
      this.model.setPromptVisible(this.isPlayerNear);
      if (this.isPlayerNear && m.interactJustPressed) this.enter(character, camera);
      // Parked: only simulate the suspension while the body is still settling
      if (!this.isPlayerInside) {
        if (!this.body.isSleeping()) {
          for (let i = 0; i < 4; i++) {
            this.controller.setWheelEngineForce(i, 0);
            this.controller.setWheelBrake(i, VEHICLE_CONFIG.HANDBRAKE);
          }
          this.controller.updateVehicle(dt);
        }
        return false;
      }
    } else if (m.interactJustPressed) {
      this.exit(character, camera);
      return false;
    }

    if (m.reset || this.body.translation().y < -30) {
      this.resetUpright();
    }

    this.drive(dt, m.forward, m.right, m.jump);
    this.followCamera(dt, camera);
    return true;
  }

  private drive(dt: number, throttle: number, steerInput: number, handbrake: boolean): void {
    const c = this.controller;
    const speed = c.currentVehicleSpeed(); // m/s along forward axis, negative when reversing
    this.speedKmh = Math.abs(speed) * 3.6;

    // Steering eases in and narrows with speed so the truck never snaps around
    const speedT = Math.min(this.speedKmh / VEHICLE_CONFIG.MAX_SPEED_KMH, 1);
    const maxSteer = THREE.MathUtils.lerp(VEHICLE_CONFIG.MAX_STEER, VEHICLE_CONFIG.MIN_STEER_AT_SPEED, speedT);
    const targetSteer = -steerInput * maxSteer;
    const rate = Math.abs(steerInput) < 0.05 ? VEHICLE_CONFIG.STEER_RETURN_SPEED : VEHICLE_CONFIG.STEER_SPEED;
    this.steer += (targetSteer - this.steer) * (1 - Math.exp(-rate * dt));
    c.setWheelSteering(0, this.steer);
    c.setWheelSteering(1, this.steer);

    let engine = 0;
    let brake = 0;
    if (throttle > 0.05) {
      if (speed < -0.5) brake = VEHICLE_CONFIG.BRAKE; // moving backwards: brake first
      else if (this.speedKmh < VEHICLE_CONFIG.MAX_SPEED_KMH) engine = VEHICLE_CONFIG.ENGINE_FORCE * throttle * (1 - speedT * 0.6);
    } else if (throttle < -0.05) {
      if (speed > 0.5) brake = VEHICLE_CONFIG.BRAKE;
      else if (this.speedKmh < VEHICLE_CONFIG.MAX_REVERSE_KMH) engine = VEHICLE_CONFIG.REVERSE_FORCE * throttle;
    } else {
      // Engine braking; at a crawl hold it firmly so the parked truck doesn't creep downhill
      brake = this.speedKmh < 3 ? VEHICLE_CONFIG.BRAKE : VEHICLE_CONFIG.ROLLING_BRAKE;
    }

    // Rapier's wheel brake barely slows a rolling truck, so coasting also adds body drag
    const coasting = Math.abs(throttle) <= 0.05 && !handbrake;
    if (coasting !== this.coasting) {
      this.coasting = coasting;
      this.body.setLinearDamping(coasting ? VEHICLE_CONFIG.COAST_DAMPING : 0.1);
    }

    for (let i = 0; i < 4; i++) {
      const rear = i >= 2;
      c.setWheelEngineForce(i, engine);
      c.setWheelBrake(i, handbrake && rear ? VEHICLE_CONFIG.HANDBRAKE : brake);
    }
    c.updateVehicle(dt);

    // Stuck on a ledge or a prop: throttle held but not moving -> small hop forward
    const lv = this.body.linvel();
    if (Math.abs(throttle) > 0.5 && Math.hypot(lv.x, lv.z) < 0.4 && !handbrake) {
      this.stuckTime += dt;
      if (this.stuckTime > VEHICLE_CONFIG.STUCK_SECONDS) {
        this.stuckTime = 0;
        const r0 = this.body.rotation();
        const fwd = VehicleController._v.set(0, 0, Math.sign(throttle)).applyQuaternion(VehicleController._q.set(r0.x, r0.y, r0.z, r0.w));
        const m = VEHICLE_CONFIG.MASS;
        this.body.applyImpulse({ x: fwd.x * m * 2.2, y: m * 3.2, z: fwd.z * m * 2.2 }, true);
      }
    } else {
      this.stuckTime = 0;
    }
    this.model.setBrakeLights((brake > VEHICLE_CONFIG.ROLLING_BRAKE && Math.abs(throttle) > 0.05) || handbrake);

    // Auto-right after a rollover instead of leaving the player stuck
    const r = this.body.rotation();
    const up = VehicleController._up.set(0, 1, 0).applyQuaternion(VehicleController._q.set(r.x, r.y, r.z, r.w));
    this.upsideDownTime = up.y < 0.3 ? this.upsideDownTime + dt : 0;
    if (this.upsideDownTime > 2) this.resetUpright();
  }

  private followCamera(dt: number, camera: ThirdPersonCamera): void {
    if (this.elapsed - this.lastMouseTime < VEHICLE_CONFIG.CAMERA_FOLLOW_DELAY || this.speedKmh < 6) return;
    const r = this.body.rotation();
    const fwd = VehicleController._v.set(0, 0, 1).applyQuaternion(VehicleController._q.set(r.x, r.y, r.z, r.w));
    const behindYaw = Math.atan2(fwd.x, fwd.z) + Math.PI;
    let delta = behindYaw - camera.targetYaw;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    camera.targetYaw += delta * (1 - Math.exp(-2.0 * dt));
  }

  /** Call once per frame AFTER physics.step(). */
  public syncVisuals(dt: number): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.model.group.position.set(t.x, t.y, t.z);
    this.model.group.quaternion.set(r.x, r.y, r.z, r.w);
    if (!this.controller) return;
    // Wheel spin follows the body's real forward velocity: the controller's own speed goes stale
    // while the parked truck isn't being simulated, which kept the wheels turning at rest.
    const fwd = VehicleController._v.set(0, 0, 1).applyQuaternion(VehicleController._q.set(r.x, r.y, r.z, r.w));
    const lv = this.body.linvel();
    let speed = this.body.isSleeping() ? 0 : lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    if (Math.abs(speed) < 0.05) speed = 0;
    for (let i = 0; i < 4; i++) {
      const susp = this.controller.wheelSuspensionLength(i) ?? VEHICLE_CONFIG.SUSPENSION_REST;
      this.wheelSpin[i] += (speed / VEHICLE_CONFIG.WHEEL_RADIUS) * dt;
      this.model.setWheel(i, WHEEL_CONNECTIONS[i].y - susp, this.controller.wheelSteering(i) ?? 0, this.wheelSpin[i]);
    }
  }

  public resetUpright(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    const fwd = VehicleController._v.set(0, 0, 1).applyQuaternion(VehicleController._q.set(r.x, r.y, r.z, r.w));
    const yaw = Math.atan2(fwd.x, fwd.z);
    const q = VehicleController._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const y = t.y < -30 ? this.spawnPosition.y : t.y + 1.2;
    const pos = t.y < -30 ? this.spawnPosition : VehicleController._v.set(t.x, y, t.z);
    this.body.setTranslation({ x: pos.x, y, z: pos.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.upsideDownTime = 0;
  }

  private enter(character: CharacterController, camera: ThirdPersonCamera): void {
    this.isPlayerInside = true;
    this.isPlayerNear = false;
    this.model.setPromptVisible(false);
    if (character.carryAbility?.isHolding) character.carryAbility.dropObject();
    if (character.carryAbility) character.carryAbility.enabled = false;

    // Park the on-foot body out of the simulation while driving
    character.model.group.visible = false;
    character.collider.setEnabled(false);
    character.body.setBodyType(this.physics.rapier.RigidBodyType.KinematicPositionBased, true);
    character.body.setTranslation({ x: 0, y: -200, z: 0 }, true);
    this.body.wakeUp();

    camera.targetDistance = 7.5;
    camera.heightOffset = 1.6;
  }

  private exit(character: CharacterController, camera: ThirdPersonCamera): void {
    this.isPlayerInside = false;
    this.speedKmh = 0;
    this.model.setBrakeLights(false);

    // Step out of the driver (left) door
    const t = this.body.translation();
    const r = this.body.rotation();
    const left = VehicleController._v.set(-1, 0, 0).applyQuaternion(VehicleController._q.set(r.x, r.y, r.z, r.w));
    const exitPos = new THREE.Vector3(t.x + left.x * 2.0, t.y + 1.0, t.z + left.z * 2.0);

    character.body.setBodyType(this.physics.rapier.RigidBodyType.Dynamic, true);
    character.collider.setEnabled(true);
    character.model.group.visible = true;
    if (character.carryAbility) character.carryAbility.enabled = true;
    character.respawn(exitPos);

    camera.targetDistance = 4.2;
    camera.heightOffset = 0.75;
  }

  public dispose(): void {
    this.physics.world.removeVehicleController(this.controller);
    this.physics.removeRigidBody(this.body);
    this.model.group.removeFromParent();
  }
}
