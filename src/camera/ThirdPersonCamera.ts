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
  // Scratch results of the getters below and of the per-frame collision probes (no garbage per frame)
  private readonly _worldDir = new THREE.Vector3();
  private readonly _posOut = new THREE.Vector3();
  private readonly _fwdOut = new THREE.Vector3();
  private readonly _rightOut = new THREE.Vector3();
  private readonly _orbit = new THREE.Vector3();
  private readonly _probe = new THREE.Vector3();
  private readonly _right2 = new THREE.Vector3();
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
  /** Locked-on enemy to keep in frame (set every frame by the engine; null when free). */
  public lockAt: THREE.Vector3 | null = null;
  /**
   * A scripted view (fishing): the camera blends smoothly from its orbit into it and back out.
   * Read every frame, so it may move.
   */
  public shot: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;
  private shotBlend = 0;
  /**
   * Water surface at a camera point (NaN = no water there). While the player is not under water
   * the orbit camera rides on this surface instead of dipping below it.
   */
  public waterSurface: ((x: number, y: number, z: number) => number) | null = null;
  /** The player has dived: the camera may follow them under (set every frame by the engine). */
  public allowUnderwater = false;
  /** 1 = the camera is kept above the water, 0 = free to go under; eased so diving / surfacing glide. */
  private waterGate = 1;
  /** How far above the surface the camera stays, so the near plane never cuts the waterline. */
  private readonly waterMargin = 0.35;
  /** Where the orbit camera itself is and looks (before any scripted view): a shot can end on it. */
  public readonly orbitPos = new THREE.Vector3();
  public readonly orbitLook = new THREE.Vector3();
  private readonly shotPos = new THREE.Vector3();
  private readonly shotLook = new THREE.Vector3();
  private readonly _orbitQ = new THREE.Quaternion();
  private readonly _shotQ = new THREE.Quaternion();
  private readonly _shotM = new THREE.Matrix4();
  private lockShift = 0;
  /** Extra camera distance while locked (keeps the player clear of the lens, frames a far enemy). */
  private lockPull = 0;

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

  /** The yaw turn (rad) a horizontal mouse move of `deltaX` px would give. */
  public yawFromMouse(deltaX: number): number {
    return -deltaX * this.sensitivity * userSettings.sensitivity;
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

    // 0b. Target lock: swing round behind the player so the enemy stays in front of both
    const lock = this.lockAt;
    let lockDx = 0;
    let lockDz = 0;
    if (lock) {
      lockDx = lock.x - characterPosition.x;
      lockDz = lock.z - characterPosition.z;
      const flat = Math.hypot(lockDx, lockDz);
      const k = 1.0 - Math.exp(-7 * dt);
      if (flat > 0.6) {
        const want = Math.atan2(-lockDx, -lockDz);
        const d = Math.atan2(Math.sin(want - this.targetYaw), Math.cos(want - this.targetYaw));
        this.targetYaw += d * k;
      }
      // Look down at an enemy below, up at one above; mouse Y still nudges it
      const dy = lock.y - (characterPosition.y + this.heightOffset);
      const wantPitch = THREE.MathUtils.clamp(0.3 - Math.atan2(dy, Math.max(flat, 2.5)) * 0.7, -0.35, 0.9);
      this.targetPitch += (wantPitch - this.targetPitch) * (1.0 - Math.exp(-2.5 * dt));
    }

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
      } else if (lock) {
        // Over the shoulder, so a close enemy isn't hidden behind the player's back
        targetSideOffset = 0.75;
      }
      this.targetFov = CAMERA_CONFIG.FOV;
    }

    const sideAlpha = 1.0 - Math.exp(-8.0 * dt);
    this.currentSideOffset = THREE.MathUtils.lerp(this.currentSideOffset, targetSideOffset, sideAlpha);

    if (Math.abs(this.currentSideOffset) > 0.001) {
      this.targetFocusPoint.addScaledVector(this.getRightVector(), this.currentSideOffset);
    }
    // Locked: frame a point between the player and the enemy (at most 2.5 m towards it)
    const lockFlat = Math.hypot(lockDx, lockDz);
    // Less of a slide for a far enemy: the player (who matters more then) stays near mid-frame
    const lockShift = lock ? Math.min(2.5, lockFlat * 0.3) * THREE.MathUtils.clamp(1 - (lockFlat - 7) * 0.1, 0.35, 1) : 0;
    this.lockShift += (lockShift - this.lockShift) * (1.0 - Math.exp(-5 * dt));
    // The focus slides towards the enemy, so the camera backs off as much (the player keeps their
    // usual distance from the lens) and a bit more as the enemy gets farther, to frame them both
    const lockPull = lock ? lockShift + THREE.MathUtils.clamp((lockFlat - 5) * 0.2, 0, 2.5) : 0;
    this.lockPull += (lockPull - this.lockPull) * (1.0 - Math.exp(-4 * dt));
    if (this.lockShift > 0.01 && (lockDx !== 0 || lockDz !== 0)) {
      const l = Math.hypot(lockDx, lockDz);
      this.targetFocusPoint.x += (lockDx / l) * this.lockShift;
      this.targetFocusPoint.z += (lockDz / l) * this.lockShift;
    }

    // Exponential smoothing for focus tracking
    const posAlpha = 1.0 - Math.exp(-CAMERA_CONFIG.POSITION_SMOOTH_SPEED * dt);
    this.currentFocusPoint.lerp(this.targetFocusPoint, posAlpha);

    // 3. Compute effective angles including dynamic recoil spring offsets
    let effectivePitch = THREE.MathUtils.clamp(
      this.currentPitch + this.recoilPitchOffset,
      CAMERA_CONFIG.PITCH_MIN,
      CAMERA_CONFIG.PITCH_MAX
    );
    const effectiveYaw = this.currentYaw + this.recoilYawOffset;

    // 3b. The water surface is a soft floor until the player dives: the orbit may not tip below it,
    // so the camera glides along the surface at its usual distance (the pitch the mouse asked for
    // comes back as soon as the camera is free again, or the player dives)
    this.waterGate += ((this.allowUnderwater ? 0 : 1) - this.waterGate) * (1.0 - Math.exp(-(this.allowUnderwater ? 5 : 3) * dt));
    // Mirrored under water: the surface becomes a ceiling, so a diver's camera never pops out of it
    if (this.waterSurface) {
      const f = this.currentFocusPoint;
      const d = THREE.MathUtils.clamp(this.targetDistance + this.lockPull, this.minDistance, this.maxDistance + 1.0);
      const reach = d * Math.cos(effectivePitch);
      const sx = f.x + Math.sin(effectiveYaw) * reach;
      const sz = f.z + Math.cos(effectiveYaw) * reach;
      const surf = this.waterSurface(sx, f.y, sz);
      if (!Number.isNaN(surf)) {
        const g = this.waterGate;
        if (g > 0.001) {
          const floor = Math.asin(THREE.MathUtils.clamp((surf + this.waterMargin - f.y) / d, -1, 1));
          if (floor > effectivePitch) effectivePitch += (Math.min(floor, CAMERA_CONFIG.PITCH_MAX) - effectivePitch) * g;
        }
        if (g < 0.999) {
          const ceil = Math.asin(THREE.MathUtils.clamp((surf - this.waterMargin - f.y) / d, -1, 1));
          if (ceil < effectivePitch) effectivePitch += (Math.max(ceil, CAMERA_CONFIG.PITCH_MIN) - effectivePitch) * (1 - g);
        }
      }
    }

    const cosPitch = Math.cos(effectivePitch);
    const sinPitch = Math.sin(effectivePitch);
    const cosYaw = Math.cos(effectiveYaw);
    const sinYaw = Math.sin(effectiveYaw);

    const orbitOffset = this._orbit.set(
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
    targetDistBase = THREE.MathUtils.clamp(targetDistBase, this.minDistance, this.maxDistance + 1.0) + this.lockPull;
    
    let maxAllowedDistance = targetDistBase;

    if (physics.isInitialized()) {
      const rayOrigin = this.currentFocusPoint;
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
      const rightVec = this._right2.copy(this.getRightVector());
      const frustumOffset = 0.22; //Frustum near-plane extent (meters)
      const probe = this._probe;

      for (let pi = 0; pi < 5; pi++) {
        probe.copy(rayOrigin);
        if (pi === 1) probe.y += frustumOffset;
        else if (pi === 2) probe.y -= frustumOffset;
        else if (pi === 3) probe.addScaledVector(rightVec, frustumOffset);
        else if (pi === 4) probe.addScaledVector(rightVec, -frustumOffset);
        const hit = physics.castRay(
          probe,
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
    // 6a. Safety: never through the surface (waves, a pulled-in boom) — above it until the player
    // dives, below it while they are under
    if (this.waterSurface) {
      const p = this.camera.position;
      const surf = this.waterSurface(p.x, p.y, p.z);
      if (!Number.isNaN(surf)) {
        const g = this.waterGate;
        if (p.y < surf + this.waterMargin) p.y += (surf + this.waterMargin - p.y) * g;
        if (p.y > surf - this.waterMargin) p.y += (surf - this.waterMargin - p.y) * (1 - g);
      }
    }
    this.camera.lookAt(this.currentFocusPoint);
    this.orbitPos.copy(this.camera.position);
    this.orbitLook.copy(this.currentFocusPoint);

    // 6b. Scripted view: ease in (and back out) over about a second
    if (this.shot) {
      this.shotPos.copy(this.shot.pos);
      this.shotLook.copy(this.shot.look);
    }
    this.shotBlend += ((this.shot ? 1 : 0) - this.shotBlend) * (1.0 - Math.exp(-2.6 * dt));
    if (this.shotBlend < 0.001) this.shotBlend = 0;
    if (this.shotBlend > 0) {
      const b = this.shotBlend;
      const w = b * b * (3 - 2 * b);
      // Orientations are slerped, not the look points: lerping those can carry the look point
      // through the camera and flip the view round
      this._orbitQ.copy(this.camera.quaternion);
      this._shotM.lookAt(this.shotPos, this.shotLook, this.camera.up);
      this._shotQ.setFromRotationMatrix(this._shotM);
      this.camera.position.lerp(this.shotPos, w);
      this.camera.quaternion.slerpQuaternions(this._orbitQ, this._shotQ, w);
    }

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
    // Shared scratch vector: valid until the next call (callers copy / clone to keep it)
    return this.camera.getWorldDirection(this._worldDir).normalize();
  }

  /**
   * Returns world position of the camera
   */
  public getPosition(): THREE.Vector3 {
    return this._posOut.copy(this.camera.position);
  }

  /**
   * Returns forward horizontal vector of the camera (useful for character movement direction)
   */
  public getForwardVector(): THREE.Vector3 {
    const forward = this._fwdOut.set(-Math.sin(this.currentYaw), 0, -Math.cos(this.currentYaw));
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
    const right = this._rightOut.set(Math.cos(this.currentYaw), 0, -Math.sin(this.currentYaw));
    if (right.lengthSq() > 0.0001) {
      right.normalize();
    } else {
      right.set(1, 0, 0);
    }
    return right;
  }
}
