import * as THREE from 'three';
import { userSettings } from '../config/userSettings';
import RAPIER from '@dimforge/rapier3d-compat';
import { CAMERA_CONFIG, COLLISION_GROUPS } from '../config/constants';
import { PhysicsWorld } from '../physics/PhysicsWorld';

export class ThirdPersonCamera {
  public camera: THREE.PerspectiveCamera;
  
  // Spherical orbit coordinates (targets and smoothed current values)
  public targetYaw: number = 0; // Horizontal angle (radians)
  public targetPitch: number = 0.2; // Vertical angle (radians)
  public currentYaw: number = 0;
  public currentPitch: number = 0.2;

  public targetDistance: number = CAMERA_CONFIG.DEFAULT_DISTANCE;
  public currentDistance: number = CAMERA_CONFIG.DEFAULT_DISTANCE;

  // Smoothing targets & vectors
  public targetFocusPoint = new THREE.Vector3();
  public currentFocusPoint = new THREE.Vector3();
  public currentCameraPos = new THREE.Vector3();
  public currentLookAt = new THREE.Vector3();

  // Settings
  public sensitivity: number = CAMERA_CONFIG.MOUSE_SENSITIVITY;
  public heightOffset: number = CAMERA_CONFIG.DEFAULT_HEIGHT_OFFSET;
  public minDistance: number = CAMERA_CONFIG.MIN_DISTANCE;
  public maxDistance: number = CAMERA_CONFIG.MAX_DISTANCE;
  public collisionPadding: number = CAMERA_CONFIG.OCCLUSION_OFFSET_PADDING;

  // Holding overhead side-camera offset (shifted 2 units right for visibility)
  public isHoldingObject: boolean = false;
  public isAiming: boolean = false;
  public isBuilding: boolean = false;
  public currentSideOffset: number = 0;

  // Helper getters for compatibility
  public get yaw(): number {
    return this.currentYaw;
  }
  public set yaw(val: number) {
    this.targetYaw = val;
    this.currentYaw = val;
  }

  public get pitch(): number {
    return this.currentPitch;
  }
  public set pitch(val: number) {
    this.targetPitch = val;
    this.currentPitch = val;
  }

  constructor(aspect: number = window.innerWidth / window.innerHeight) {
    this.camera = new THREE.PerspectiveCamera(CAMERA_CONFIG.FOV, aspect, 0.1, 500);
    this.camera.position.set(0, 4, 6);
    this.currentFocusPoint.set(0, 1.2, 0);
    this.currentCameraPos.copy(this.camera.position);
    this.currentLookAt.copy(this.currentFocusPoint);
  }

  public handleMouseInput(deltaX: number, deltaY: number): void {
    const k = this.sensitivity * userSettings.sensitivity;
    this.targetYaw -= deltaX * k;
    this.targetPitch += deltaY * k * (userSettings.invertY ? -1 : 1);

    // Clamp pitch to avoid gimbal lock / flipping upside down
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch, CAMERA_CONFIG.PITCH_MIN, CAMERA_CONFIG.PITCH_MAX);
  }

  public handleZoom(deltaZoom: number): void {
    this.targetDistance = THREE.MathUtils.clamp(
      this.targetDistance + deltaZoom,
      this.minDistance,
      this.maxDistance
    );
  }

  private baseFov: number = CAMERA_CONFIG.FOV;
  private targetFov: number = CAMERA_CONFIG.FOV;

  // GTA 5 Style Damped Harmonic Oscillator Recoil States
  public recoilPitchOffset: number = 0;
  public recoilPitchVelocity: number = 0;
  public recoilYawOffset: number = 0;
  public recoilYawVelocity: number = 0;
  public recoilRollOffset: number = 0;
  public recoilRollVelocity: number = 0;
  public recoilDepthOffset: number = 0;
  public recoilFovOffset: number = 0;

  /**
   * Applies realistic GTA 5 weapon recoil:
   * - In our spherical coordinate system, negative pitch kicks camera UPWARDS towards sky.
   * - Recoil spring immediately snaps upward and recovers back to baseline aim without losing crosshair target.
   * - Adds punchy lateral jitter, subtle cinematic roll wobble, depth punch, and shock FOV impulse.
   */
  public applyRecoil(
    pitchAmount: number,
    yawAmount: number = 0,
    depthAmount: number = 0,
    rollAmount: number = 0,
    fovAmount: number = 0
  ): void {
    // Upward pitch kick (negative delta in spherical orbit coords elevates the camera aim upward)
    this.recoilPitchOffset -= pitchAmount;
    this.recoilPitchVelocity -= pitchAmount * 42.0;

    // Horizontal twitch
    this.recoilYawOffset += yawAmount;
    this.recoilYawVelocity += yawAmount * 34.0;

    // Camera roll tilt
    this.recoilRollOffset += rollAmount;
    this.recoilRollVelocity += rollAmount * 28.0;

    // Depth & FOV punch
    this.recoilDepthOffset = Math.min(this.recoilDepthOffset + depthAmount, 0.6);
    this.recoilFovOffset = Math.min(this.recoilFovOffset + fovAmount, 4.0);

    // Subtle sustained spray climb (accumulates ~10% permanent climb during continuous spray)
    this.targetPitch -= pitchAmount * 0.10;
    this.targetPitch = THREE.MathUtils.clamp(
      this.targetPitch,
      CAMERA_CONFIG.PITCH_MIN,
      CAMERA_CONFIG.PITCH_MAX
    );
  }

  public setFov(fov: number): void {
    this.targetFov = fov;
  }

  /**
   * Main camera update cycle with Frame-Rate Independent Exponential Interpolation & Occlusion
   */
  public update(
    dt: number,
    characterPosition: THREE.Vector3,
    physics: PhysicsWorld,
    characterCollider?: RAPIER.Collider
  ): void {
    // 0. Update GTA 5 Damped Harmonic Oscillator Recoil Spring
    const stiffness = CAMERA_CONFIG.RECOIL_SPRING_STIFFNESS;
    const damping = CAMERA_CONFIG.RECOIL_SPRING_DAMPING;

    // Pitch Spring
    const pitchForce = -stiffness * this.recoilPitchOffset - damping * this.recoilPitchVelocity;
    this.recoilPitchVelocity += pitchForce * dt;
    this.recoilPitchOffset += this.recoilPitchVelocity * dt;

    // Yaw Spring
    const yawForce = -stiffness * this.recoilYawOffset - damping * this.recoilYawVelocity;
    this.recoilYawVelocity += yawForce * dt;
    this.recoilYawOffset += this.recoilYawVelocity * dt;

    // Roll Spring
    const rollStiffness = CAMERA_CONFIG.RECOIL_ROLL_STIFFNESS;
    const rollDamping = CAMERA_CONFIG.RECOIL_ROLL_DAMPING;
    const rollForce = -rollStiffness * this.recoilRollOffset - rollDamping * this.recoilRollVelocity;
    this.recoilRollVelocity += rollForce * dt;
    this.recoilRollOffset += this.recoilRollVelocity * dt;

    // Depth & FOV kick decay
    const depthDecayAlpha = 1.0 - Math.exp(-18.0 * dt);
    this.recoilDepthOffset = THREE.MathUtils.lerp(this.recoilDepthOffset, 0, depthDecayAlpha);
    const fovDecayAlpha = 1.0 - Math.exp(-22.0 * dt);
    this.recoilFovOffset = THREE.MathUtils.lerp(this.recoilFovOffset, 0, fovDecayAlpha);

    // 1. Smoothly interpolate base angles (Yaw & Pitch)
    const rotAlpha = 1.0 - Math.exp(-CAMERA_CONFIG.ROTATION_SMOOTH_SPEED * dt);
    
    this.currentYaw += (this.targetYaw - this.currentYaw) * rotAlpha;
    this.currentPitch += (this.targetPitch - this.currentPitch) * rotAlpha;

    // 2. Calculate desired focus point (character head/chest)
    this.targetFocusPoint.copy(characterPosition);
    this.targetFocusPoint.y += this.heightOffset;

    let targetSideOffset = 0.0;
    let targetZoomOffset = 0.0;

    if (this.isAiming) {
      targetSideOffset = 0.65;
      targetZoomOffset = -2.0; // Zoom in
      this.targetFov = 45;
    } else if (this.isBuilding) {
      // Over-the-shoulder right offset for clear building placement visibility (1.5m)
      targetSideOffset = 1.5;
      targetZoomOffset = -0.5;
      this.targetFov = CAMERA_CONFIG.FOV;
    } else {
      if (this.isHoldingObject) {
        targetSideOffset = 1.0;
      }
      this.targetFov = CAMERA_CONFIG.FOV;
    }

    const sideAlpha = 1.0 - Math.exp(-8.0 * dt);
    this.currentSideOffset = THREE.MathUtils.lerp(this.currentSideOffset, targetSideOffset, sideAlpha);

    if (Math.abs(this.currentSideOffset) > 0.001) {
      this.targetFocusPoint.addScaledVector(this.getRightVector(), this.currentSideOffset);
    }

    // Exponential smoothing for focus tracking
    const posAlpha = 1.0 - Math.exp(-CAMERA_CONFIG.POSITION_SMOOTH_SPEED * dt);
    this.currentFocusPoint.lerp(this.targetFocusPoint, posAlpha);

    // 3. Compute effective angles including dynamic recoil spring offsets
    const effectivePitch = THREE.MathUtils.clamp(
      this.currentPitch + this.recoilPitchOffset,
      CAMERA_CONFIG.PITCH_MIN,
      CAMERA_CONFIG.PITCH_MAX
    );
    const effectiveYaw = this.currentYaw + this.recoilYawOffset;

    const cosPitch = Math.cos(effectivePitch);
    const sinPitch = Math.sin(effectivePitch);
    const cosYaw = Math.cos(effectiveYaw);
    const sinYaw = Math.sin(effectiveYaw);

    const orbitOffset = new THREE.Vector3(
      sinYaw * cosPitch,
      sinPitch,
      cosYaw * cosPitch
    );
    if (orbitOffset.lengthSq() > 0.0001) {
      orbitOffset.normalize();
    } else {
      orbitOffset.set(0, 0, 1);
    }

    // 4. Raycast from character focus point to ideal camera position to prevent wall clipping
    let targetDistBase = this.targetDistance + targetZoomOffset + this.recoilDepthOffset;
    targetDistBase = THREE.MathUtils.clamp(targetDistBase, this.minDistance, this.maxDistance + 1.0);
    
    let maxAllowedDistance = targetDistBase;

    if (physics.isInitialized()) {
      const rayOrigin = this.currentFocusPoint.clone();
      const rayDir = orbitOffset;
      const queryDistance = targetDistBase;

      // Filter collision group: include environment & static geometry, exclude dynamic triggers & character
      const filterGroup = physics.packCollisionGroups(
        COLLISION_GROUPS.CAMERA_RAY,
        COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS
      );
      // Only static geometry (terrain, buildings, trees, rocks) pushes the camera in. Moving bodies — the
      // companion and pets running behind the player, animals, loose props — snapped it from 4 m to ~1 m
      // for a split second whenever they crossed the ray.
      const flags = physics.rapier.QueryFilterFlags;
      const filterFlags = flags.EXCLUDE_DYNAMIC | flags.EXCLUDE_KINEMATIC | flags.EXCLUDE_SENSORS;

      // Multi-probe raycast bundle (center ray + 4 surrounding frustum boundary rays)
      // This catches walls, low ceilings, and tight corners even when standing right against geometry
      const upVec = new THREE.Vector3(0, 1, 0);
      const rightVec = this.getRightVector();
      const frustumOffset = 0.22; //Frustum near-plane extent (meters)

      const probePoints = [
        rayOrigin,
        rayOrigin.clone().addScaledVector(upVec, frustumOffset),
        rayOrigin.clone().addScaledVector(upVec, -frustumOffset),
        rayOrigin.clone().addScaledVector(rightVec, frustumOffset),
        rayOrigin.clone().addScaledVector(rightVec, -frustumOffset),
      ];

      for (const originPoint of probePoints) {
        const hit = physics.castRay(
          originPoint,
          rayDir,
          queryDistance,
          true,
          filterFlags,
          filterGroup,
          characterCollider
        );

        if (hit && hit.timeOfImpact < queryDistance) {
          // Safe adjusted distance with padding to avoid camera near-plane geometry clipping
          const safeDist = Math.max(this.minDistance, hit.timeOfImpact - this.collisionPadding);
          maxAllowedDistance = Math.min(maxAllowedDistance, safeDist);
        }
      }
    }

    // 5. Smoothly pull in camera distance quickly on collision, lerp smoothly back out
    if (maxAllowedDistance < this.currentDistance) {
      // Immediate pull-in on collision to prevent wall clipping
      const pullInAlpha = 1.0 - Math.exp(-24 * dt);
      this.currentDistance = THREE.MathUtils.lerp(this.currentDistance, maxAllowedDistance, pullInAlpha);
    } else {
      // Smooth push-out when obstruction clears
      const pushOutAlpha = 1.0 - Math.exp(-8 * dt);
      this.currentDistance = THREE.MathUtils.lerp(this.currentDistance, maxAllowedDistance, pushOutAlpha);
    }

    // 6. Direct spherical camera placement with instant punchy depth recoil
    const effectiveDistance = Math.min(maxAllowedDistance, this.currentDistance + this.recoilDepthOffset);
    this.camera.position.copy(this.currentFocusPoint).addScaledVector(orbitOffset, effectiveDistance);
    this.camera.lookAt(this.currentFocusPoint);

    // Apply GTA 5 cinematic camera roll tilt
    this.camera.rotation.z += this.recoilRollOffset;

    // 7. Update FOV with dynamic recoil shock impulse
    const fovAlpha = 1.0 - Math.exp(-14 * dt);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, this.targetFov + this.recoilFovOffset, fovAlpha);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Returns full 3D direction vector that the camera is pointing at (includes pitch & yaw)
   */
  public getWorldDirection(): THREE.Vector3 {
    return this.camera.getWorldDirection(new THREE.Vector3()).normalize();
  }

  /**
   * Returns world position of the camera
   */
  public getPosition(): THREE.Vector3 {
    return this.camera.position.clone();
  }

  /**
   * Returns forward horizontal vector of the camera (useful for character movement direction)
   */
  public getForwardVector(): THREE.Vector3 {
    const forward = new THREE.Vector3(-Math.sin(this.currentYaw), 0, -Math.cos(this.currentYaw));
    if (forward.lengthSq() > 0.0001) {
      forward.normalize();
    } else {
      forward.set(0, 0, -1);
    }
    return forward;
  }

  /**
   * Returns right horizontal vector of the camera
   */
  public getRightVector(): THREE.Vector3 {
    const right = new THREE.Vector3(Math.cos(this.currentYaw), 0, -Math.sin(this.currentYaw));
    if (right.lengthSq() > 0.0001) {
      right.normalize();
    } else {
      right.set(1, 0, 0);
    }
    return right;
  }
}
