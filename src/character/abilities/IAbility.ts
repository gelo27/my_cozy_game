import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { MovementInput } from '../../input/InputManager';
import { ParticleManager } from '../../particles/ParticleManager';
import type { GroundAimHit } from '../../gathering/GroundAim';

export interface GroundInfo {
  isGrounded: boolean;
  distance: number;
  normal: THREE.Vector3;
  slopeAngleDeg: number;
  isWalkableSlope: boolean;
  surfaceHitPoint: THREE.Vector3;
}

export interface CharacterContext {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  physics: PhysicsWorld;
  input: MovementInput;
  ground: GroundInfo;
  cameraForward: THREE.Vector3;
  cameraRight: THREE.Vector3;
  cameraPosition: THREE.Vector3;
  cameraWorldDirection: THREE.Vector3;
  camera: any; // Using any to avoid circular import if needed, or import ThirdPersonCamera
  currentVelocity: THREE.Vector3;
  targetVelocity: THREE.Vector3;
  appliedImpulse: THREE.Vector3;
  isSprinting: boolean;
  isCrouching: boolean;
  isDashing: boolean;
  isJumping: boolean;
  isClimbing: boolean;
  isHoldingObject: boolean;
  isSwimming: boolean;
  swimDepth: number;
  oxygen: number;
  maxOxygen: number;
  oxygenRatio: number;
  isUnderwater: boolean;
  isDrowning: boolean;
  canMantle?: boolean;
  isMantling?: boolean;
  isBuildModeActive?: boolean;
  activeWeapon: number; // held tool visual: 0=none, 6=axe, 10=watering can, 11=seeds, 12=pickaxe
  isAiming: boolean;
  /**
   * RMB held with the shovel or something plantable in hand: where the crosshair meets the ground
   * (null when not aiming that way, or the ray misses the ground).
   */
  groundAim: GroundAimHit | null;
  /** RMB aiming with a ground tool (the shovel, tulips), even when the ray misses. */
  isGroundAiming: boolean;
  particleManager?: ParticleManager;
  model?: any;
  forestZone?: any;
  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  jumpForce: number;
  jumpCutMultiplier: number;
  airControl: number;
  gravity: number;
}

export interface IAbility {
  name: string;
  enabled: boolean;
  init?(context: CharacterContext): void;
  update(dt: number, context: CharacterContext): void;
  cleanup?(): void;
}
