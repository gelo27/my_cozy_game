import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import type { CharacterController } from '../character/CharacterController';
import { COLLISION_GROUPS, CHARACTER_CONFIG } from '../config/constants';
import { interactionFocus } from '../gameplay/InteractionFocus';
import type { InputManager } from '../input/InputManager';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { TerrainSystem } from '../world/TerrainSystem';
import { riverWorld } from '../world/rivers/RiverWorld';
import { BulldozerModel, DOZER_BLADE_HALF_WIDTH, DOZER_BLADE_Z, DOZER_TRACK_END, DOZER_TRACK_RADIUS, DOZER_TRACK_X } from './BulldozerModel';

const MASS = 1050;
const TRAVEL_SPEED = 6.3;
const WORK_SPEED = 3.6;
const MASS_PER_CONTACT = MASS / 6;
const MAX_FORCE = 4700;
const WORK_FORCE = 5200;
const TRACK_CONTACT_END = DOZER_TRACK_END + 0.17;
const CLIMB_PROBE_Z = TRACK_CONTACT_END + 0.38;
const MIN_STROKE = 0.65;
const RECOVERY_INTERVAL = 0.22;
const LOOK_AHEAD_INTERVAL = 0.14;
const LOOK_AHEAD_Z = DOZER_BLADE_Z + 1.85;
const TERRAIN_PROBES = [1.25, 2.25, 3.25] as const;
const UP = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Quaternion();
const ZERO = new THREE.Vector3();
const EXIT_OFFSETS = [[2.1, 0], [-2.1, 0], [0, -2.4]] as const;

export type BulldozerControlState = 'off' | 'raised' | 'lowered' | 'blocked';

export class BulldozerController {
  public readonly model = new BulldozerModel();
  public readonly body: RAPIER.RigidBody;
  public readonly collider: RAPIER.Collider;
  public isPlayerInside = false;
  public speedKmh = 0;
  public onGradeStrip: ((ax: number, az: number, bx: number, bz: number, halfWidth: number) => void) | null = null;

  private readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  private readonly exclusionBox: RAPIER.Cuboid;
  private readonly exitShape: RAPIER.Capsule;
  private readonly groundGroups: number;
  private readonly obstructionGroups: number;
  private readonly fixedOnly: number;
  private readonly pos = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly bladePoint = new THREE.Vector3();
  private readonly previousBladePoint = new THREE.Vector3();
  private readonly recoveryStart = new THREE.Vector3();
  private readonly queryPoint = new THREE.Vector3();
  private readonly climbImpulse = new THREE.Vector3();
  private readonly listeners = new Set<() => void>();

  private targetHeight = 0;
  private lowered = false;
  private changed = false;
  private hasPreviousBladePoint = false;
  private timeWithoutStroke = 0;
  private lookAheadIn = 0;
  private grounded = false;
  private throttle = 0;
  private steering = 0;
  private brake = true;
  private smoothedThrottle = 0;
  private smoothedSteering = 0;
  private driveYaw: number | null = null;
  private cameraDelay = 0;
  private controlState: BulldozerControlState = 'off';

  constructor(
    private readonly physics: PhysicsWorld,
    scene: THREE.Scene,
    private readonly terrain: TerrainSystem,
    private readonly spawn: THREE.Vector3,
    private readonly spawnYaw = 0,
  ) {
    const { rapier, world } = physics;
    this.fixedOnly = rapier.QueryFilterFlags.ONLY_FIXED | rapier.QueryFilterFlags.EXCLUDE_SENSORS;
    this.groundGroups = physics.packCollisionGroups(COLLISION_GROUPS.DYNAMIC_PROPS, COLLISION_GROUPS.ENVIRONMENT);
    this.obstructionGroups = physics.packCollisionGroups(COLLISION_GROUPS.DYNAMIC_PROPS, COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS);
    this.exclusionBox = new rapier.Cuboid(1, 1.6, 1);
    this.exitShape = new rapier.Capsule(0.46, CHARACTER_CONFIG.CAPSULE_RADIUS);
    this.body = world.createRigidBody(rapier.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setRotation(this.rotation.setFromAxisAngle(UP, spawnYaw))
      .setLinearDamping(0.35).setAngularDamping(1.4).setCcdEnabled(true));
    this.body.userData = { isVehicle: true, type: 'bulldozer' };
    this.collider = world.createCollider(rapier.ColliderDesc.roundCuboid(0.96, 0.28, 1.00, 0.19)
      .setTranslation(0, 0.86, 0)
      .setMassProperties(MASS, { x: 0, y: -0.35, z: 0 }, { x: 1250, y: 1280, z: 670 }, IDENTITY)
      .setFriction(0.14).setCollisionGroups(physics.packCollisionGroups(
        COLLISION_GROUPS.DYNAMIC_PROPS, COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS | COLLISION_GROUPS.CHARACTER,
      )), this.body);
    this.vehicle = world.createVehicleController(this.body);
    this.vehicle.indexUpAxis = 1;
    this.vehicle.setIndexForwardAxis = 2;
    for (const x of [-DOZER_TRACK_X, DOZER_TRACK_X]) {
      for (const z of [-TRACK_CONTACT_END, 0, TRACK_CONTACT_END]) {
        const i = this.vehicle.numWheels();
        this.vehicle.addWheel({ x, y: 0.83, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, 0.35, DOZER_TRACK_RADIUS);
        this.vehicle.setWheelMaxSuspensionTravel(i, 0.28);
        this.vehicle.setWheelSuspensionStiffness(i, 64);
        this.vehicle.setWheelSuspensionCompression(i, 4.2);
        this.vehicle.setWheelSuspensionRelaxation(i, 5);
        this.vehicle.setWheelMaxSuspensionForce(i, MASS * 16);
        this.vehicle.setWheelFrictionSlip(i, 3.8);
        this.vehicle.setWheelSideFrictionStiffness(i, z === 0 ? 1.15 : 0.28);
      }
    }
    scene.add(this.model.group);
    this.syncVisuals(0);
  }

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  public readonly getControls = (): BulldozerControlState => this.controlState;

  private setControls(state: BulldozerControlState): void {
    if (this.controlState === state) return;
    this.controlState = state;
    for (const listener of this.listeners) listener();
  }

  public getPosition(target = new THREE.Vector3()): THREE.Vector3 {
    const p = this.body.translation();
    return target.set(p.x, p.y, p.z);
  }

  public getYaw(): number {
    const r = this.body.rotation();
    this.forward.set(0, 0, 1).applyQuaternion(this.rotation.set(r.x, r.y, r.z, r.w));
    return Math.atan2(this.forward.x, this.forward.z);
  }

  public notifyMouseLook(): void {
    this.cameraDelay = 1.3;
  }

  public update(dt: number, input: InputManager, camera: ThirdPersonCamera, character: CharacterController, canInteract: boolean): boolean {
    const m = input.movement;
    if (!this.isPlayerInside) {
      const cp = character.body.translation(), t = this.body.translation();
      const nearby = canInteract && (cp.x - t.x) ** 2 + (cp.y - t.y) ** 2 + (cp.z - t.z) ** 2 < 3.1 ** 2;
      if (nearby) interactionFocus.offer('bulldozer', t, 0.8);
      const focused = nearby && interactionFocus.allows('bulldozer');
      this.model.setPromptVisible(focused);
      if (!focused || !m.interactJustPressed) return false;
      this.enter(character, camera);
    } else if (canInteract && m.interactJustPressed) {
      this.exit(character, camera);
      return false;
    }

    const p = this.getPosition(this.pos);
    const r = this.body.rotation();
    if (p.y < riverWorld.waterLevelAt(p.x, p.z) - 2.5 || r.x * r.x + r.z * r.z > 0.56) {
      this.place();
    }
    if (canInteract && m.bladeToggleJustPressed) this.toggleBlade();
    this.brake = !canInteract || m.jump;
    this.throttle = Math.abs(m.forward) > 0.12 ? m.forward : 0;
    this.steering = Math.abs(m.right) > 0.12 ? m.right : 0;
    this.cameraDelay = Math.max(0, this.cameraDelay - dt);
    if (!this.cameraDelay && (Math.abs(this.throttle) > 0.12 || Math.abs(this.steering) > 0.12)) {
      const delta = this.getYaw() + Math.PI - camera.targetYaw;
      camera.targetYaw += Math.atan2(Math.sin(delta), Math.cos(delta)) * (1 - Math.exp(-2.4 * dt));
    }
    return true;
  }

  /** Called in the fixed-step physics loop, including unoccupied suspension while it settles. */
  public step(dt: number): void {
    if (!this.isPlayerInside && this.body.isSleeping()) return;
    const active = this.isPlayerInside && !this.brake;
    const blend = 1 - Math.exp(-8 * dt);
    this.smoothedThrottle = THREE.MathUtils.lerp(this.smoothedThrottle, active ? this.throttle : 0, blend);
    this.smoothedSteering = THREE.MathUtils.lerp(this.smoothedSteering, active ? this.steering : 0, blend);
    const drive = active && (this.throttle !== 0 || this.steering !== 0);
    const r = this.body.rotation();
    this.forward.set(0, 0, 1).applyQuaternion(this.rotation.set(r.x, r.y, r.z, r.w));
    const velocity = this.body.linvel();
    const horizontalForward = Math.hypot(this.forward.x, this.forward.z) || 1;
    const speed = (this.forward.x * velocity.x + this.forward.z * velocity.z) / horizontalForward;
    const yawSpeed = this.body.angvel().y;
    const limit = this.lowered ? WORK_SPEED : TRAVEL_SPEED;
    const maxForce = this.lowered && this.throttle > 0 ? WORK_FORCE : MAX_FORCE;
    const cruise = this.smoothedThrottle * limit * (this.smoothedThrottle < 0 ? 0.65 : 1);
    const pivotSpeed = this.lowered ? 1.95 : 2.35;
    const movingTurnSpeed = this.lowered ? 1.15 : 1.45;
    let turn = this.smoothedSteering * THREE.MathUtils.lerp(pivotSpeed, movingTurnSpeed, Math.abs(this.smoothedThrottle));
    if (active && this.throttle !== 0 && this.steering === 0) {
      const yaw = Math.atan2(this.forward.x, this.forward.z);
      this.driveYaw ??= yaw;
      const error = this.driveYaw - yaw;
      // Keep tracking straight when a shoulder pushes one track sideways.
      turn -= THREE.MathUtils.clamp(Math.atan2(Math.sin(error), Math.cos(error)) * 3, -1.5, 1.5);
    } else {
      this.driveYaw = null;
    }
    if (drive && this.body.isSleeping()) this.body.wakeUp();
    for (let side = 0; side < 2; side++) {
      const x = side * 2 - 1;
      const target = THREE.MathUtils.clamp(cruise + x * turn, -limit, limit);
      const current = speed - yawSpeed * x * DOZER_TRACK_X;
      const force = THREE.MathUtils.clamp((target - current) * MASS_PER_CONTACT * 15, -maxForce, maxForce);
      for (let i = side * 3; i < side * 3 + 3; i++) {
        this.vehicle.setWheelBrake(i, drive ? 0 : 70);
        this.vehicle.setWheelEngineForce(i, drive ? force : 0);
      }
    }
    this.vehicle.updateVehicle(dt, this.fixedOnly, this.groundGroups);
    let contacts = 0;
    for (let i = 0; i < 6; i++) if (this.vehicle.wheelIsInContact(i)) contacts++;
    this.grounded = contacts >= 2;
    if (active && Math.abs(this.throttle) > 0.18) {
      const direction = Math.sign(this.throttle) / horizontalForward;
      this.supportClimb(dt, this.forward.x * direction, this.forward.z * direction, contacts);
    }
  }

  /** Helps the tracks ride onto a nearby terrain crest when the end rays still point at its face. */
  private supportClimb(dt: number, fx: number, fz: number, contacts: number): void {
    const p = this.body.translation();
    const height = Math.max(
      this.trackTerrainHeight(p.x + fx * CLIMB_PROBE_Z, p.z + fz * CLIMB_PROBE_Z, fx, fz),
      this.trackTerrainHeight(p.x + fx * 0.65, p.z + fz * 0.65, fx, fz),
    );
    const gap = height - p.y;
    const rise = height - this.terrain.getHeight(p.x, p.z);
    if (gap > 1.35 || (gap < 0.16 && Math.abs(rise) < 0.18)) return;
    // Suspension on a bridge, floor or rock must not trigger the terrain assist.
    let terrainContact = this.hasTerrainWheelContact();
    if (!terrainContact && contacts === 0) this.physics.world.contactPairsWith(this.collider, hit => {
      terrainContact ||= BulldozerController.isTerrain(hit);
    });
    if (!terrainContact) return;
    const velocity = this.body.linvel();
    const up = gap > 0.16 ? Math.max(0, Math.min(2.45, (gap - 0.1) * 4.5) - velocity.y) : 0;
    const speed = velocity.x * fx + velocity.z * fz;
    const tractionSpeed = this.throttle > 0 ? 3.25 : 2.9;
    const push = Math.max(0, Math.min(tractionSpeed * Math.abs(this.smoothedThrottle) - speed, 18 * dt));
    if (up > 0 || push > 0) {
      this.body.applyImpulse(this.climbImpulse.set(fx * MASS * push, MASS * Math.min(up, 18 * dt), fz * MASS * push), true);
    }
  }

  private hasTerrainWheelContact(): boolean {
    for (let i = 0; i < 6; i++) {
      const hit = this.vehicle.wheelGroundObject(i);
      if (hit && BulldozerController.isTerrain(hit)) return true;
    }
    return false;
  }

  private trackTerrainHeight(x: number, z: number, fx: number, fz: number): number {
    return Math.max(
      this.terrain.getHeight(x, z),
      this.terrain.getHeight(x + fz * DOZER_TRACK_X, z - fx * DOZER_TRACK_X),
      this.terrain.getHeight(x - fz * DOZER_TRACK_X, z + fx * DOZER_TRACK_X),
    );
  }

  public syncVisuals(dt: number): void {
    const t = this.body.translation(), r = this.body.rotation();
    this.model.group.position.set(t.x, t.y, t.z);
    this.model.group.quaternion.set(r.x, r.y, r.z, r.w);
    if (dt <= 0 || (!this.isPlayerInside && this.body.isSleeping())) return;
    const v = this.body.linvel();
    const forward = this.forward.set(0, 0, 1).applyQuaternion(this.model.group.quaternion);
    const speed = v.x * forward.x + v.y * forward.y + v.z * forward.z;
    const turn = this.body.angvel().y * DOZER_TRACK_X;
    this.speedKmh = Math.abs(speed) * 3.6;
    this.model.setBlade(this.lowered, 1 - Math.exp(-10 * dt));
    if (this.grounded && Math.abs(speed) + Math.abs(turn) > 0.035) this.model.advanceTracks(speed + turn, speed - turn, dt);
    if (!this.lowered) return;
    if (this.brake || this.throttle <= 0) {
      this.hasPreviousBladePoint = false;
      this.timeWithoutStroke = 0;
      this.lookAheadIn = 0;
      return;
    }
    const yaw = Math.atan2(forward.x, forward.z);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const groundSpeed = v.x * fx + v.z * fz;
    this.bladePoint.set(t.x + fx * DOZER_BLADE_Z, t.y, t.z + fz * DOZER_BLADE_Z);
    const a = this.previousBladePoint, b = this.bladePoint;
    if (!this.hasPreviousBladePoint) {
      a.copy(b);
      this.hasPreviousBladePoint = true;
    }
    this.lookAheadIn -= dt;
    if (this.grounded && this.lookAheadIn <= 0) {
      this.lookAheadIn = LOOK_AHEAD_INTERVAL;
      const ahead = this.driveYaw ?? yaw;
      const ax = Math.sin(ahead), az = Math.cos(ahead);
      if (this.needsGradeAhead(t.x, t.z, ax, az)) {
        this.recoveryStart.set(t.x + ax * 0.6, t.y, t.z + az * 0.6);
        b.set(t.x + ax * LOOK_AHEAD_Z, t.y, t.z + az * LOOK_AHEAD_Z);
        this.grade(this.recoveryStart, b, true);
        b.set(t.x + fx * DOZER_BLADE_Z, t.y, t.z + fz * DOZER_BLADE_Z);
      }
    }
    const distance = Math.hypot(b.x - a.x, b.z - a.z);
    if (distance >= 3) a.copy(b);
    else if (this.grounded && groundSpeed > 0.12 && distance >= MIN_STROKE) {
      this.grade(a, b);
      a.copy(b);
      this.timeWithoutStroke = 0;
      return;
    }

    if (Math.abs(groundSpeed) > 0.9 || (!this.grounded && Math.abs(v.y) > 0.75)) {
      this.timeWithoutStroke = 0;
      return;
    }
    this.timeWithoutStroke += dt;
    if (this.timeWithoutStroke < RECOVERY_INTERVAL) return;
    this.timeWithoutStroke = 0;
    const groundUnderTracks = this.terrain.getHeight(t.x, t.z);
    if (t.y - groundUnderTracks > 0.85 || groundUnderTracks <= riverWorld.waterLevelAt(t.x, t.z) + 0.15) return;
    // A stalled chassis may be resting on its belly, with no wheel rays in contact.
    // Grade from under the front of the tracks to just in front of the blade.
    const recoveryYaw = this.driveYaw ?? yaw;
    const rx = Math.sin(recoveryYaw), rz = Math.cos(recoveryYaw);
    this.recoveryStart.set(t.x + rx * 0.1, t.y, t.z + rz * 0.1);
    a.copy(b);
    b.set(t.x + rx * (DOZER_BLADE_Z + 0.85), t.y, t.z + rz * (DOZER_BLADE_Z + 0.85));
    this.grade(this.recoveryStart, b, true);
  }

  private needsGradeAhead(x: number, z: number, fx: number, fz: number): boolean {
    for (const distance of TERRAIN_PROBES) {
      const px = x + fx * distance, pz = z + fz * distance;
      if (Math.abs(this.terrain.getHeight(px, pz) - this.targetHeight) > 0.22 ||
          Math.abs(this.terrain.getHeight(px + fz * DOZER_TRACK_X, pz - fx * DOZER_TRACK_X) - this.targetHeight) > 0.22 ||
          Math.abs(this.terrain.getHeight(px - fz * DOZER_TRACK_X, pz + fx * DOZER_TRACK_X) - this.targetHeight) > 0.22) return true;
    }
    return false;
  }

  private grade(a: THREE.Vector3, b: THREE.Vector3, rapid = false): void {
    // Give the tracks room on a coarse heightfield where the side slope spans a full grid cell.
    const halfWidth = DOZER_BLADE_HALF_WIDTH + (rapid ? 0.85 : 0);
    const mid = this.queryPoint.lerpVectors(a, b, 0.5);
    const ground = this.terrain.getHeight(mid.x, mid.z);
    const groundAtStart = this.terrain.getHeight(a.x, a.z);
    const groundAtBlade = this.terrain.getHeight(b.x, b.z);
    // The blade can be over a deep pit as long as the chassis is supported by the bank.
    const body = this.body.translation();
    const underTracks = this.terrain.getHeight(body.x, body.z);
    const accessible = (body.y - underTracks < 0.9 || (this.grounded && this.hasTerrainWheelContact())) &&
      underTracks > riverWorld.waterLevelAt(body.x, body.z) + 0.15 &&
      ground > riverWorld.waterLevelAt(mid.x, mid.z) + 0.15 &&
      groundAtBlade > riverWorld.waterLevelAt(b.x, b.z) + 0.15;
    const bottom = Math.min(groundAtStart, ground, groundAtBlade, this.targetHeight) - 0.65;
    const top = Math.max(groundAtStart, ground, groundAtBlade, this.targetHeight) + 2.55;
    mid.y = (bottom + top) * 0.5;
    const extents = this.exclusionBox.halfExtents;
    extents.y = (top - bottom) * 0.5;
    extents.x = halfWidth + Math.abs(b.x - a.x) * 0.5;
    extents.z = halfWidth + Math.abs(b.z - a.z) * 0.5;
    const blocked = !accessible || this.physics.world.intersectionWithShape(
      mid, IDENTITY, this.exclusionBox, this.fixedOnly, this.groundGroups,
      undefined, this.body, BulldozerController.isStructure,
    ) !== null;
    this.setControls(blocked ? 'blocked' : 'lowered');
    if (blocked) return;
    this.onGradeStrip?.(a.x, a.z, b.x, b.z, halfWidth);
    if (!this.terrain.gradeStrip(a.x, a.z, b.x, b.z, halfWidth, this.targetHeight, rapid)) return;
    this.changed = true;
    if (rapid) {
      // Commit the new track support before the next physics step.
      this.terrain.commit();
      this.changed = false;
    }
  }

  private static isStructure(collider: RAPIER.Collider): boolean {
    if ((collider as RAPIER.Collider & { userData?: { bladeClearable?: boolean } }).userData?.bladeClearable) return false;
    return !BulldozerController.isTerrain(collider);
  }

  private static isTerrain(collider: RAPIER.Collider): boolean {
    // Collision membership occupies the upper 16 bits.
    return (collider.collisionGroups() >>> 16) === (COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.TERRAIN);
  }

  private toggleBlade(): void {
    if (this.lowered) {
      this.raiseBlade();
    } else {
      const p = this.getPosition(this.pos);
      const yaw = this.getYaw(), fx = Math.sin(yaw), fz = Math.cos(yaw);
      this.targetHeight = this.terrain.getHeight(p.x - fx * 0.6, p.z - fz * 0.6);
      this.previousBladePoint.set(p.x + fx * DOZER_BLADE_Z, p.y, p.z + fz * DOZER_BLADE_Z);
      this.hasPreviousBladePoint = true;
      this.lowered = true;
      this.setControls('lowered');
    }
  }

  private raiseBlade(): void {
    this.lowered = false;
    this.hasPreviousBladePoint = false;
    this.timeWithoutStroke = 0;
    this.lookAheadIn = 0;
    this.driveYaw = null;
    if (this.changed) this.terrain.commit();
    this.changed = false;
    this.setControls(this.isPlayerInside ? 'raised' : 'off');
  }

  private enter(character: CharacterController, camera: ThirdPersonCamera): void {
    this.isPlayerInside = true;
    this.model.setPromptVisible(false);
    if (character.carryAbility) {
      character.carryAbility.dropObject();
      character.carryAbility.enabled = false;
    }
    character.model.group.visible = false;
    character.collider.setEnabled(false);
    character.body.setBodyType(this.physics.rapier.RigidBodyType.KinematicPositionBased, true);
    character.body.setTranslation({ x: 0, y: -200, z: 0 }, true);
    this.body.wakeUp();
    camera.targetDistance = 7.8;
    camera.heightOffset = 1.4;
    camera.targetYaw = this.getYaw() + Math.PI;
    this.setControls('raised');
  }

  public getExitPosition(): THREE.Vector3 {
    const p = this.getPosition(this.pos);
    const yaw = this.getYaw(), sin = Math.sin(yaw), cos = Math.cos(yaw);
    for (const [side, back] of EXIT_OFFSETS) {
      const x = p.x + cos * side + sin * back, z = p.z - sin * side + cos * back;
      const ground = this.terrain.getHeight(x, z);
      const y = Math.max(ground + 0.95, p.y + 0.75);
      this.queryPoint.set(x, y, z);
      if (ground <= riverWorld.waterLevelAt(x, z) || this.physics.world.intersectionWithShape(
        this.queryPoint, IDENTITY, this.exitShape, this.physics.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
        this.obstructionGroups, undefined, this.body,
      )) continue;
      return this.queryPoint.clone();
    }
    return this.spawn.clone().setY(this.terrain.getHeight(this.spawn.x, this.spawn.z) + 1.1).add(new THREE.Vector3(0, 0, -2.6));
  }

  public exit(character: CharacterController, camera: ThirdPersonCamera, position = this.getExitPosition()): void {
    this.isPlayerInside = false;
    this.raiseBlade();
    this.brake = true;
    character.body.setBodyType(this.physics.rapier.RigidBodyType.Dynamic, true);
    character.collider.setEnabled(true);
    character.model.group.visible = true;
    if (character.carryAbility) character.carryAbility.enabled = true;
    character.respawn(position);
    camera.targetDistance = 4.2;
    camera.heightOffset = 0.75;
  }

  public place(position?: THREE.Vector3, yaw = this.spawnYaw): void {
    const p = position ?? this.pos.copy(this.spawn).setY(this.terrain.getHeight(this.spawn.x, this.spawn.z) + 0.35);
    this.raiseBlade();
    this.body.setTranslation(p, true);
    this.body.setRotation(this.rotation.setFromAxisAngle(UP, yaw), true);
    this.body.setLinvel(ZERO, true);
    this.body.setAngvel(ZERO, true);
    this.smoothedThrottle = this.smoothedSteering = 0;
    this.grounded = false;
    this.model.setBlade(false, 1);
    this.syncVisuals(0);
  }

  public dispose(): void {
    this.physics.world.removeVehicleController(this.vehicle);
    this.physics.removeRigidBody(this.body);
    this.model.dispose();
    this.listeners.clear();
  }
}
