import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { CharacterModel, AnimationState } from './CharacterModel';
import { InputManager } from '../input/InputManager';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { CHARACTER_CONFIG, COLLISION_GROUPS } from '../config/constants';
import { IAbility, CharacterContext, GroundInfo } from './abilities/IAbility';
import { MovementAbility } from './abilities/MovementAbility';
import { JumpAbility } from './abilities/JumpAbility';
import { SprintAbility } from './abilities/SprintAbility';
import { CrouchAbility } from './abilities/CrouchAbility';
import { DashAbility } from './abilities/DashAbility';
import { CarryAbility } from './abilities/CarryAbility';
import { WallClimbAbility } from './abilities/WallClimbAbility';
import { SwimAbility } from './abilities/SwimAbility';
import { OxygenAbility } from './abilities/OxygenAbility';
import { BuildAbility } from './abilities/BuildAbility';
import { FarmingAbility } from './abilities/FarmingAbility';
import { GatheringAbility } from './abilities/GatheringAbility';
import { ForestZone } from '../forest/ForestZone';
import { PropTreeField } from '../gathering/PropTreeField';
import { RockField } from '../gathering/RockField';
import { BuildingManager } from '../building/BuildingManager';
import { PreviewGhostRenderer } from '../building/PreviewGhostRenderer';
import { WallSelectionSystem } from '../building/WallSelectionSystem';
import { ParticleManager } from '../particles/ParticleManager';
import { WaterEffects } from '../scene/WaterEffects';
import { WaterParticleSystem } from '../particles/WaterParticleSystem';
import { FarmingManager } from '../farming/FarmingManager';
import { InventoryManager } from '../inventory/InventoryManager';

export interface CharacterTelemetry {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  speed: number;
  appliedImpulse: THREE.Vector3;
  targetVelocity: THREE.Vector3;
  groundNormal: THREE.Vector3;
  slopeAngleDeg: 0 | number;
  isGrounded: boolean;
  isWalkableSlope: boolean;
  isSprinting: boolean;
  isCrouching: boolean;
  isDashing: boolean;
  isClimbing: boolean;
  isHoldingObject: boolean;
  isAiming: boolean;
  isSwimming: boolean;
  swimDepth: number;
  oxygen: number;
  maxOxygen: number;
  oxygenRatio: number;
  isUnderwater: boolean;
  isDrowning: boolean;
  justRefilled: boolean;
  activeWeapon: number;
  canMantle: boolean;
  isMantling: boolean;
  coyoteTimeActive: boolean;
  isBuildModeActive: boolean;
  selectedBuildingPiece: string;
}

export interface GroundRayDebugInfo {
  id: string;
  name: string;
  origin: THREE.Vector3;
  target: THREE.Vector3;
  hitPoint: THREE.Vector3 | null;
  hitNormal: THREE.Vector3 | null;
  isHit: boolean;
  distance: number;
}

const DOWN_DIR = new THREE.Vector3(0, -1, 0);
const PROBE_OFFSETS = [
  { id: 'center', name: 'Center Ray', dx: 0, dz: 0 },
  { id: 'front', name: 'Front Ray', dx: 1, dz: 0 },
  { id: 'back', name: 'Back Ray', dx: -1, dz: 0 },
  { id: 'left', name: 'Left Ray', dx: 0, dz: 1 },
  { id: 'right', name: 'Right Ray', dx: 0, dz: -1 },
];

export class CharacterController {
  public body!: RAPIER.RigidBody;
  public collider!: RAPIER.Collider;
  public model: CharacterModel;
  public spawnPosition: THREE.Vector3;
  public particleManager: ParticleManager | null = null;

  // Abilities container (modular architecture)
  public abilities: IAbility[] = [];
  public swimAbility!: SwimAbility;
  public oxygenAbility!: OxygenAbility;
  private jumpAbility!: JumpAbility;
  public carryAbility!: CarryAbility;
  public wallClimbAbility!: WallClimbAbility;

  // Ground detection state & 5 Raycast visualizer info
  public groundInfo: GroundInfo = {
    isGrounded: false,
    distance: 0,
    normal: new THREE.Vector3(0, 1, 0),
    slopeAngleDeg: 0,
    isWalkableSlope: true,
    surfaceHitPoint: new THREE.Vector3(),
  };

  public groundRaysDebug: GroundRayDebugInfo[] = [];

  private wasGrounded: boolean = false;
  /** Collider under the feet from the last ground probe (null in the air). */
  public groundCollider: RAPIER.Collider | null = null;
  /**
   * Step sounds: called on every foot plant (intensity ~0.35..1) and on landing (intensity > 1),
   * with the point on the ground and the collider it belongs to.
   */
  public onFootstep: ((intensity: number, point: THREE.Vector3, collider: RAPIER.Collider | null) => void) | null = null;
  private previousYVelocity: number = 0;

  // Real-time tweakable parameters
  public walkSpeed: number = CHARACTER_CONFIG.WALK_SPEED;
  public sprintSpeed: number = CHARACTER_CONFIG.SPRINT_SPEED;
  public crouchSpeed: number = CHARACTER_CONFIG.CROUCH_SPEED;
  public jumpForce: number = CHARACTER_CONFIG.JUMP_IMPULSE;
  public jumpCutMultiplier: number = CHARACTER_CONFIG.JUMP_CUT_MULTIPLIER;
  public airControl: number = CHARACTER_CONFIG.AIR_CONTROL_FACTOR;
  public maxWalkableSlope: number = CHARACTER_CONFIG.MAX_WALKABLE_SLOPE_DEG;

  public get allowSteepSlopeJump(): boolean {
    return this.jumpAbility.allowSteepSlopeJump;
  }
  public set allowSteepSlopeJump(val: boolean) {
    this.jumpAbility.allowSteepSlopeJump = val;
  }

  public get allowWallClimb(): boolean {
    return this.wallClimbAbility ? this.wallClimbAbility.enabled : true;
  }
  public set allowWallClimb(val: boolean) {
    if (this.wallClimbAbility) {
      this.wallClimbAbility.enabled = val;
    }
  }

  // Telemetry for Debug Panel
  public telemetry: CharacterTelemetry = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    speed: 0,
    appliedImpulse: new THREE.Vector3(),
    targetVelocity: new THREE.Vector3(),
    groundNormal: new THREE.Vector3(0, 1, 0),
    slopeAngleDeg: 0,
    isGrounded: false,
    isWalkableSlope: true,
    isSprinting: false,
    isCrouching: false,
    isDashing: false,
    isClimbing: false,
    isHoldingObject: false,
    activeWeapon: 0,
    isAiming: false,
    isSwimming: false,
    swimDepth: 0,
    oxygen: 100,
    maxOxygen: 100,
    oxygenRatio: 1.0,
    isUnderwater: false,
    isDrowning: false,
    justRefilled: false,
    canMantle: false,
    isMantling: false,
    coyoteTimeActive: false,
    isBuildModeActive: false,
    selectedBuildingPiece: '',
  };

  private tempVelocity = new THREE.Vector3();
  private tempImpulse = new THREE.Vector3();
  private tempTargetVelocity = new THREE.Vector3();
  public forestZone: any = null;
  private equippedInventoryItem: string | null = null;
  public buildAbility!: BuildAbility;
  public farmingAbility!: FarmingAbility;
  public gatheringAbility!: GatheringAbility;

  constructor(
    private physics: PhysicsWorld,
    private scene: THREE.Scene,
    spawnPos: THREE.Vector3 = new THREE.Vector3(0, 3, 0),
    particleManager?: ParticleManager
  ) {
    this.spawnPosition = spawnPos.clone();
    this.model = new CharacterModel();
    this.model.onFootstep = (intensity) => this.onFootstep?.(intensity, this.groundInfo.surfaceHitPoint, this.groundCollider);
    this.scene.add(this.model.group);
    if (particleManager) {
      this.particleManager = particleManager;
    }

    this.createPhysicsBody(spawnPos);
    this.initAbilities();
  }

  private createPhysicsBody(pos: THREE.Vector3): void {
    // Create Rapier Dynamic Rigid Body
    const bodyDesc = this.physics.rapier.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      // Lock rotations so character remains vertical (does not topple like a physics ragdoll)
      .lockRotations()
      .setLinearDamping(0.2)
      .setAngularDamping(0.0)
      .setCcdEnabled(true); // Continuous collision detection to prevent tunneling

    this.body = this.physics.world.createRigidBody(bodyDesc);
    this.body.lockRotations(true, true);

    // Create Capsule Collider (Half-height = 0.45m, Radius = 0.30m -> Total height 1.50m)
    const colliderDesc = this.physics.rapier.ColliderDesc.capsule(
      CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT,
      CHARACTER_CONFIG.CAPSULE_RADIUS
    )
      .setMass(CHARACTER_CONFIG.MASS)
      .setFriction(0.0) // We control friction via impulse damping
      .setRestitution(0.0)
      .setCollisionGroups(
        this.physics.packCollisionGroups(
          COLLISION_GROUPS.CHARACTER,
          COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS | COLLISION_GROUPS.TRIGGERS
        )
      );

    this.collider = this.physics.world.createCollider(colliderDesc, this.body);
  }

  private initAbilities(): void {
    this.swimAbility = new SwimAbility();
    this.abilities.push(this.swimAbility);

    this.oxygenAbility = new OxygenAbility();
    this.abilities.push(this.oxygenAbility);

    this.abilities.push(new SprintAbility());
    this.abilities.push(new CrouchAbility());
    this.abilities.push(new DashAbility());
    this.abilities.push(new MovementAbility());

    this.carryAbility = new CarryAbility();
    this.carryAbility.getFacingDirection = () => this.getFacingDirection();
    this.carryAbility.getFacingAngle = () => this.getFacingAngle();
    this.abilities.push(this.carryAbility);

    this.wallClimbAbility = new WallClimbAbility();
    this.abilities.push(this.wallClimbAbility);

    this.jumpAbility = new JumpAbility();
    this.jumpAbility.onJumpTriggered = () => {
      this.model.triggerJumpLaunch();
      if (this.particleManager && CHARACTER_CONFIG.FOOT_DUST_ENABLED) {
        this.particleManager.emitJumpDust(this.getFeetPosition());
      }
    };
    this.abilities.push(this.jumpAbility);

    this.buildAbility = new BuildAbility();
    this.abilities.push(this.buildAbility);

    this.farmingAbility = new FarmingAbility();
    this.abilities.push(this.farmingAbility);

    this.gatheringAbility = new GatheringAbility();
    this.abilities.push(this.gatheringAbility);
  }

  public setFarmingSystems(farming: FarmingManager, inventory: InventoryManager): void {
    if (this.farmingAbility) {
      this.farmingAbility.setManagers(farming, inventory);
    }
    this.equippedInventoryItem = inventory.getEquippedItemId();
    if (this.equippedInventoryItem) {
      this.model.equipToolOrProp(this.equippedInventoryItem);
    }
    // Automatically update character model's in-hand item when equipped tool/seed changes
    inventory.subscribe((state) => {
      this.equippedInventoryItem = state.equippedItemId;
      this.model.equipToolOrProp(state.equippedItemId);
    });
  }

  public setGatheringSystems(forest: ForestZone, rocks: RockField, inventory: InventoryManager, propTrees: PropTreeField | null = null): void {
    this.gatheringAbility.setSystems(forest, rocks, inventory, propTrees);
    // The weapon-slot axe [6] chops the same trees
    this.setForestZone(forest);
  }

  public setBuildingSystems(manager: BuildingManager, ghostRenderer: PreviewGhostRenderer, wallSelectionSystem?: WallSelectionSystem): void {
    if (this.buildAbility) {
      this.buildAbility.setBuildingSystems(manager, ghostRenderer, wallSelectionSystem);
    }
  }

  public setWaterSystems(waterEffects: WaterEffects, waterParticles: WaterParticleSystem): void {
    if (this.swimAbility) {
      this.swimAbility.waterEffects = waterEffects;
      this.swimAbility.waterParticles = waterParticles;
    }
    if (this.oxygenAbility) {
      this.oxygenAbility.waterParticles = waterParticles;
    }
    this.model.applyCausticsProjection(waterEffects);
  }

  public setForestZone(forestZone: any): void {
    this.forestZone = forestZone;
  }

  public getFacingDirection(): THREE.Vector3 {
    const angle = this.model.group.rotation.y;
    return new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle)).normalize();
  }

  public getFacingAngle(): number {
    return this.model.group.rotation.y;
  }

  public getFeetPosition(): THREE.Vector3 {
    if (!this.body || !this.body.isValid() || !this.physics.isInitialized()) {
      return this.spawnPosition.clone();
    }
    try {
      const t = this.body.translation();
      return new THREE.Vector3(t.x, t.y - 0.75, t.z);
    } catch {
      return this.spawnPosition.clone();
    }
  }

  /**
   * Multi-raycast ground detection:
   * Probes central point and 4 cardinal offsets around the capsule perimeter (5 rays total)
   */
  private updateGroundDetection(): void {
    const translation = this.body.translation();
    const linvel = this.body.linvel();
    if (
      !translation ||
      !Number.isFinite(translation.x) ||
      !Number.isFinite(translation.y) ||
      !Number.isFinite(translation.z)
    ) {
      return;
    }
    const centerOrigin = new THREE.Vector3(translation.x, translation.y, translation.z);

    const radius = CHARACTER_CONFIG.GROUND_RAY_OFFSET_RADIUS;
    const rayLength = CHARACTER_CONFIG.GROUND_RAY_LENGTH;

    // Filter group: only hit environment and static/dynamic surfaces, exclude character
    const filterGroup = this.physics.packCollisionGroups(
      COLLISION_GROUPS.CHARACTER,
      COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS
    );

    let hitsCount = 0;
    let minDistance = Infinity;
    const avgNormal = new THREE.Vector3(0, 0, 0);
    const closestPoint = new THREE.Vector3();
    let closestCollider: RAPIER.Collider | null = null;
    this.groundRaysDebug = [];

    // Only skip ground check if character is actively launching upward in a jump
    if (this.jumpAbility.isJumping && linvel.y > 1.2) {
      this.groundInfo = {
        isGrounded: false,
        distance: Infinity,
        normal: new THREE.Vector3(0, 1, 0),
        slopeAngleDeg: 0,
        isWalkableSlope: true,
        surfaceHitPoint: new THREE.Vector3(),
      };
      
      // Still populate ray debug origins and targets for wireframe rendering
      for (const probe of PROBE_OFFSETS) {
        const probeOrigin = new THREE.Vector3(
          centerOrigin.x + probe.dx * radius,
          centerOrigin.y,
          centerOrigin.z + probe.dz * radius
        );
        const probeTarget = new THREE.Vector3(probeOrigin.x, probeOrigin.y - rayLength, probeOrigin.z);
        this.groundRaysDebug.push({
          id: probe.id,
          name: probe.name,
          origin: probeOrigin,
          target: probeTarget,
          hitPoint: null,
          hitNormal: null,
          isHit: false,
          distance: Infinity,
        });
      }
      return;
    }

    for (const probe of PROBE_OFFSETS) {
      const probeOrigin = new THREE.Vector3(
        centerOrigin.x + probe.dx * radius,
        centerOrigin.y,
        centerOrigin.z + probe.dz * radius
      );
      const probeTarget = new THREE.Vector3(probeOrigin.x, probeOrigin.y - rayLength, probeOrigin.z);

      const hitResult = this.physics.castRayAndGetNormal(
        probeOrigin,
        DOWN_DIR,
        rayLength,
        this.collider,
        filterGroup
      );

      const isWalkableHit = hitResult && hitResult.normal.y > 0.35;

      if (isWalkableHit && hitResult) {
        hitsCount++;
        avgNormal.add(hitResult.normal);
        if (hitResult.hit.timeOfImpact < minDistance) {
          minDistance = hitResult.hit.timeOfImpact;
          closestPoint.copy(hitResult.point);
          closestCollider = hitResult.hit.collider;
        }

        this.groundRaysDebug.push({
          id: probe.id,
          name: probe.name,
          origin: probeOrigin,
          target: probeTarget,
          hitPoint: hitResult.point,
          hitNormal: hitResult.normal,
          isHit: true,
          distance: hitResult.hit.timeOfImpact,
        });
      } else {
        this.groundRaysDebug.push({
          id: probe.id,
          name: probe.name,
          origin: probeOrigin,
          target: probeTarget,
          hitPoint: null,
          hitNormal: null,
          isHit: false,
          distance: Infinity,
        });
      }
    }

    if (hitsCount > 0) {
      if (avgNormal.lengthSq() > 0.001) {
        avgNormal.normalize();
      } else {
        avgNormal.set(0, 1, 0);
      }
      
      // Calculate angle with global up vector (0, 1, 0)
      const dotUp = THREE.MathUtils.clamp(avgNormal.dot(new THREE.Vector3(0, 1, 0)), -1, 1);
      const slopeAngleRad = Math.acos(dotUp);
      const slopeAngleDeg = THREE.MathUtils.radToDeg(slopeAngleRad);

      const isWalkable = slopeAngleDeg <= this.maxWalkableSlope;

      this.groundInfo = {
        isGrounded: true,
        distance: minDistance,
        normal: avgNormal,
        slopeAngleDeg,
        isWalkableSlope: isWalkable,
        surfaceHitPoint: closestPoint,
      };
      this.groundCollider = closestCollider;
    } else {
      this.groundInfo = {
        isGrounded: false,
        distance: Infinity,
        normal: new THREE.Vector3(0, 1, 0),
        slopeAngleDeg: 0,
        isWalkableSlope: true,
        surfaceHitPoint: new THREE.Vector3(),
      };
    }
  }

  /**
   * Main per-frame update loop
   */
  public update(dt: number, input: InputManager, camera: ThirdPersonCamera): void {
    if (!this.body || !this.body.isValid() || !this.physics.isInitialized()) return;

    try {
      // 1. Respawn / Reset check
      if (input.movement.reset || this.body.translation().y < -50.0) {
        this.respawn();
        return;
      }

      // 2. Perform ground raycasts
      this.updateGroundDetection();

      // 3. Read current velocity from Rapier body
      const linvel = this.body.linvel();
      this.tempVelocity.set(linvel.x, linvel.y, linvel.z);
      this.tempImpulse.set(0, 0, 0);
      this.tempTargetVelocity.set(0, 0, 0);

      // Check for landing impact to trigger particles and Squash & Stretch
      if (!this.wasGrounded && this.groundInfo.isGrounded) {
        this.model.triggerLandingSquash(this.previousYVelocity);
        this.model.triggerLand(this.previousYVelocity, Math.hypot(linvel.x, linvel.z));
        // Landing thud on the surface: harder falls are louder
        if (this.previousYVelocity < -2.5) {
          this.onFootstep?.(Math.min(1.6, 0.7 + -this.previousYVelocity * 0.08), this.groundInfo.surfaceHitPoint, this.groundCollider);
        }
        if (Math.abs(this.previousYVelocity) > 1.2 && this.particleManager && CHARACTER_CONFIG.FOOT_DUST_ENABLED) {
          this.particleManager.emitLandDust(this.getFeetPosition(), this.previousYVelocity);
        }
      }
      this.wasGrounded = this.groundInfo.isGrounded;
      this.previousYVelocity = linvel.y;

      const cameraForward = camera.getForwardVector();
      const cameraRight = camera.getRightVector();
      const cameraPosition = camera.getPosition();
      const cameraWorldDirection = camera.getWorldDirection();

      // 4. Build Context and execute modular abilities
      const context: CharacterContext = {
        body: this.body,
        collider: this.collider,
        physics: this.physics,
        input: input.movement,
        ground: this.groundInfo,
        cameraForward,
        cameraRight,
        cameraPosition,
        cameraWorldDirection,
        camera,
        currentVelocity: this.tempVelocity,
        targetVelocity: this.tempTargetVelocity,
        appliedImpulse: this.tempImpulse,
        isSprinting: false,
        isCrouching: false,
        isDashing: false,
        isJumping: this.jumpAbility.isJumping,
        isClimbing: this.wallClimbAbility ? this.wallClimbAbility.isClimbing : false,
        isHoldingObject: this.carryAbility ? this.carryAbility.isHolding : false,
        isSwimming: false,
        swimDepth: 0,
        oxygen: this.oxygenAbility ? this.oxygenAbility.currentOxygen : 100,
        maxOxygen: this.oxygenAbility ? this.oxygenAbility.maxOxygen : 100,
        oxygenRatio: this.oxygenAbility ? this.oxygenAbility.currentOxygen / this.oxygenAbility.maxOxygen : 1.0,
        isUnderwater: this.oxygenAbility ? this.oxygenAbility.isUnderwater : false,
        isDrowning: this.oxygenAbility ? this.oxygenAbility.isDrowning : false,
        canMantle: this.swimAbility ? this.swimAbility.canMantle : false,
        isMantling: this.swimAbility ? this.swimAbility.isMantling : false,
        isBuildModeActive: this.buildAbility ? this.buildAbility.isBuildModeActive : false,
        activeWeapon: this.model.activeWeapon,
        isAiming: false,
        particleManager: this.particleManager,
        model: this.model,
        forestZone: this.forestZone,
        walkSpeed: this.walkSpeed,
        sprintSpeed: this.sprintSpeed,
        crouchSpeed: this.crouchSpeed,
        jumpForce: this.jumpForce,
        jumpCutMultiplier: this.jumpCutMultiplier,
        airControl: this.airControl,
        gravity: this.physics.getGravity(),
      };

      for (const ability of this.abilities) {
        ability.update(dt, context);
      }

      // 5. Update Locomotion Dust Particles
      if (this.particleManager && CHARACTER_CONFIG.FOOT_DUST_ENABLED) {
        this.particleManager.updateLocomotionDust(
          dt,
          this.getFeetPosition(),
          this.tempVelocity,
          this.groundInfo.isGrounded,
          context.isSprinting
        );
      }

      // 6. Synchronize 3D visual mannequin model & Lean Effect
      const trans = this.body.translation();
      this.model.group.position.set(trans.x, trans.y, trans.z);

      // Compute target facing rotation angle based on movement or input
      let targetFacingAngle: number | null = null;
      const isMovingInput = Math.abs(input.movement.forward) > 0.01 || Math.abs(input.movement.right) > 0.01;

      if (context.isClimbing && this.wallClimbAbility) {
        const wallNorm = this.wallClimbAbility.wallNormal;
        if (wallNorm.lengthSq() > 0.001) {
          targetFacingAngle = Math.atan2(-wallNorm.x, -wallNorm.z);
        }
      } else if (this.model.activeWeapon === 6 && this.model.axeSwingProgress > 0) {
        // Face where the camera looks while swinging the axe
        targetFacingAngle = Math.atan2(cameraForward.x, cameraForward.z);
      } else if (isMovingInput) {
        // Naturally face the movement direction when walking/running (in normal mode, build mode, and paint mode)
        const moveDir = new THREE.Vector3()
          .addScaledVector(cameraForward, input.movement.forward)
          .addScaledVector(cameraRight, input.movement.right);
        targetFacingAngle = Math.atan2(moveDir.x, moveDir.z);
      } else if (context.isSwimming && (linvel.x * linvel.x + linvel.z * linvel.z) > 0.02) {
        targetFacingAngle = Math.atan2(linvel.x, linvel.z);
      }

      const horizontalSpeed = Math.sqrt(linvel.x * linvel.x + linvel.z * linvel.z);
      const isClimbingMoving = context.isClimbing && (Math.abs(input.movement.forward) > 0.05 || Math.abs(input.movement.right) > 0.05);

      camera.isAiming = context.isAiming;
      camera.isBuilding = this.buildAbility ? this.buildAbility.isBuildModeActive : false;

      const animState: AnimationState = {
        isGrounded: this.groundInfo.isGrounded,
        isMoving: context.isSwimming
          ? (horizontalSpeed > 0.15 || Math.abs(linvel.y) > 0.15)
          : horizontalSpeed > 0.25,
        isSprinting: context.isSprinting,
        isCrouching: context.isCrouching,
        isDashing: context.isDashing,
        isClimbing: context.isClimbing,
        isClimbingMoving: isClimbingMoving,
        isHoldingObject: this.carryAbility.isHolding,
        isSwimming: context.isSwimming,
        swimDepth: context.swimDepth,
        activeWeapon: this.model.activeWeapon,
        isAiming: context.isAiming,
        speed: horizontalSpeed,
        verticalVelocity: linvel.y,
        velocity3D: this.tempVelocity,
      };

      this.model.updateAnimation(dt, animState, targetFacingAngle);

      // 7. Update Telemetry
      this.telemetry.position.set(trans.x, trans.y, trans.z);
      this.telemetry.velocity.copy(this.tempVelocity);
      this.telemetry.speed = horizontalSpeed;
      this.telemetry.appliedImpulse.copy(this.tempImpulse);
      this.telemetry.targetVelocity.copy(this.tempTargetVelocity);
      this.telemetry.groundNormal.copy(this.groundInfo.normal);
      this.telemetry.slopeAngleDeg = this.groundInfo.slopeAngleDeg;
      this.telemetry.isGrounded = this.groundInfo.isGrounded;
      this.telemetry.isWalkableSlope = this.groundInfo.isWalkableSlope;
      this.telemetry.isSprinting = context.isSprinting;
      this.telemetry.isCrouching = context.isCrouching;
      this.telemetry.isDashing = context.isDashing;
      this.telemetry.isClimbing = context.isClimbing;
      this.telemetry.isHoldingObject = this.carryAbility.isHolding;
      this.telemetry.activeWeapon = this.model.activeWeapon;
      this.telemetry.isAiming = context.isAiming;
      this.telemetry.isSwimming = context.isSwimming;
      this.telemetry.swimDepth = context.swimDepth;
      this.telemetry.oxygen = context.oxygen;
      this.telemetry.maxOxygen = context.maxOxygen;
      this.telemetry.oxygenRatio = context.oxygenRatio;
      this.telemetry.isUnderwater = context.isUnderwater;
      this.telemetry.isDrowning = context.isDrowning;
      this.telemetry.justRefilled = this.oxygenAbility ? this.oxygenAbility.justRefilled : false;
      this.telemetry.canMantle = this.swimAbility ? this.swimAbility.canMantle : false;
      this.telemetry.isMantling = this.swimAbility ? this.swimAbility.isMantling : false;
      this.telemetry.isBuildModeActive = this.buildAbility ? this.buildAbility.isBuildModeActive : false;
      this.telemetry.selectedBuildingPiece = this.buildAbility ? this.buildAbility.getTelemetry().selectedPieceName : '';
    } catch (err) {
      console.warn('[CharacterController] update error:', err);
    }
  }

  public respawn(customPos?: THREE.Vector3): void {
    if (!this.body || !this.physics.isInitialized()) return;
    try {
      if (this.carryAbility) {
        this.carryAbility.dropObject();
      }
      if (this.oxygenAbility) {
        this.oxygenAbility.reset();
      }
      const p = customPos || this.spawnPosition;
      if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
        this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
        this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        this.body.setGravityScale(1.0, true);
        this.model.group.position.set(p.x, p.y, p.z);
      }
    } catch (err) {
      console.warn('[CharacterController] respawn error:', err);
    }
  }

  public getPosition(): THREE.Vector3 {
    if (!this.body || !this.physics.isInitialized()) {
      return this.spawnPosition.clone();
    }
    try {
      const t = this.body.translation();
      return new THREE.Vector3(t.x, t.y, t.z);
    } catch {
      return this.spawnPosition.clone();
    }
  }
}
