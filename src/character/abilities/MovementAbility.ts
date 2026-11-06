import * as THREE from 'three';
import { IAbility, CharacterContext } from './IAbility';
import { CHARACTER_CONFIG } from '../../config/constants';

export class MovementAbility implements IAbility {
  public name = 'Movement';
  public enabled = true;

  private tempDir = new THREE.Vector3();
  private tempTangent = new THREE.Vector3();
  // Scratch values: this runs every frame, so nothing here may allocate
  private readonly vCur = new THREE.Vector3();
  private readonly vH = new THREE.Vector3();
  private readonly vDelta = new THREE.Vector3();
  private readonly hCur = new THREE.Vector2();
  private readonly hTarget = new THREE.Vector2();
  private readonly hDelta = new THREE.Vector2();
  private readonly imp = { x: 0, y: 0, z: 0 };

  public update(dt: number, context: CharacterContext): void {
    if (!this.enabled || context.isClimbing || context.isSwimming) return;

    const { input, ground, cameraForward, cameraRight, currentVelocity, body } = context;

    // 1. Calculate camera-relative desired movement vector
    this.tempDir.set(0, 0, 0);
    if (Math.abs(input.forward) > 0.001 || Math.abs(input.right) > 0.001) {
      this.tempDir
        .addScaledVector(cameraForward, input.forward)
        .addScaledVector(cameraRight, input.right);
      
      // Zero out vertical component and normalize
      this.tempDir.y = 0;
      if (this.tempDir.lengthSq() > 0.001) {
        this.tempDir.normalize();
      }
    }

    const hasInput = this.tempDir.lengthSq() > 0.001;

    // 2. Determine target base speed
    let targetSpeed = context.walkSpeed;
    if (context.isCrouching) {
      targetSpeed = context.crouchSpeed;
    } else if (context.isSprinting) {
      targetSpeed = context.sprintSpeed;
    }

    // 3. Grounded vs Airborne movement
    const isJumping = context.isJumping;

    if (ground.isGrounded && ground.isWalkableSlope && !isJumping) {
      // --- GROUNDED ON WALKABLE SURFACE (AND NOT CURRENTLY JUMPING UPWARD) ---
      if (hasInput) {
        body.setGravityScale(1.0, true);

        // Project movement direction onto the surface plane so running up/down slopes is smooth
        this.tempTangent.copy(this.tempDir);
        // Tangent = Dir - (Dir . Normal) * Normal
        const dot = this.tempTangent.dot(ground.normal);
        this.tempTangent.addScaledVector(ground.normal, -dot);
        if (this.tempTangent.lengthSq() > 0.0001) {
          this.tempTangent.normalize();
        } else {
          this.tempTangent.copy(this.tempDir);
        }

        context.targetVelocity.copy(this.tempTangent).multiplyScalar(targetSpeed);

        // Smooth acceleration curve from standstill (acceleration) & turning skid response
        const currentVel = this.vCur.set(currentVelocity.x, currentVelocity.y, currentVelocity.z);
        const currentHVel = this.vH.set(currentVelocity.x, 0, currentVelocity.z);
        const currentHSpeed = currentHVel.length();

        let accelRate: number = CHARACTER_CONFIG.GROUND_ACCELERATION;
        if (currentHSpeed < 0.5) {
          // Ramp acceleration up smoothly from standstill
          accelRate = CHARACTER_CONFIG.INITIAL_ACCELERATION;
        } else if (currentHVel.lengthSq() > 0.1 && context.targetVelocity.lengthSq() > 0.1) {
          // Check if turning sharply / reversing direction
          const hLen = currentHVel.length();
          if (hLen > 0.0001) {
            const normHVel = currentHVel.multiplyScalar(1 / hLen);
            const dirDot = normHVel.dot(this.tempTangent);
            if (dirDot < -0.2) {
              // Reversing direction - apply strong turning/skid acceleration rate
              accelRate = CHARACTER_CONFIG.TURNING_DECELERATION;
            }
          }
        }

        const deltaVel = this.vDelta.subVectors(context.targetVelocity, currentVel);
        // Limit max velocity change per frame
        const maxDelta = accelRate * dt;
        const dLen = deltaVel.length();
        if (dLen > maxDelta) {
          if (dLen > 0.0001) {
            deltaVel.multiplyScalar(maxDelta / dLen);
          }
        }

        // Apply impulse (mass * deltaVel)
        const mass = body.mass();
        const impulse = deltaVel.multiplyScalar(mass);
        if (Number.isFinite(impulse.x) && Number.isFinite(impulse.y) && Number.isFinite(impulse.z)) {
          this.imp.x = impulse.x; this.imp.y = impulse.y; this.imp.z = impulse.z;
          body.applyImpulse(this.imp as any, true);
          context.appliedImpulse.add(impulse);
        }
      } else {
        // --- NO INPUT: BRAKING & SLOPE ANTI-SLIDE ---
        const currentVel = this.vCur.set(currentVelocity.x, currentVelocity.y, currentVelocity.z);
        const currentSpeed = currentVel.length();

        // Immediately disable gravity drift on walkable slopes so gravity cannot pull the character downhill
        body.setGravityScale(0.0, true);

        if (currentSpeed > CHARACTER_CONFIG.SLOPE_MIN_VELOCITY_THRESHOLD) {
          const decel = Math.min(currentSpeed, CHARACTER_CONFIG.GROUND_DECELERATION * 1.5 * dt);
          const deltaV = this.vDelta.copy(currentVel).multiplyScalar(-decel / currentSpeed);

          const mass = body.mass();
          const brakeImpulse = deltaV.multiplyScalar(mass);
          if (Number.isFinite(brakeImpulse.x) && Number.isFinite(brakeImpulse.y) && Number.isFinite(brakeImpulse.z)) {
            this.imp.x = brakeImpulse.x; this.imp.y = brakeImpulse.y; this.imp.z = brakeImpulse.z;
            body.applyImpulse(this.imp, true);
          }

          // If remaining speed after this frame will be minimal, instantly lock to zero
          if (currentSpeed - decel < CHARACTER_CONFIG.SLOPE_MIN_VELOCITY_THRESHOLD) {
            body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            body.resetForces(true);
          }
        } else {
          // Completely stationary on walkable ground: lock in place
          body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          body.resetForces(true);
        }

        context.targetVelocity.set(0, 0, 0);
      }
    } else if (ground.isGrounded && !ground.isWalkableSlope && !isJumping) {
      // --- STEEP SLOPE: Let gravity slide character naturally with partial steering ---
      body.setGravityScale(1.0, true);
      if (hasInput) {
        const mass = body.mass();
        const airPush = this.vDelta.copy(this.tempDir).multiplyScalar(CHARACTER_CONFIG.AIR_ACCELERATION * 0.4 * dt * mass);
        if (Number.isFinite(airPush.x) && Number.isFinite(airPush.z)) {
          this.imp.x = airPush.x; this.imp.y = 0; this.imp.z = airPush.z;
          body.applyImpulse(this.imp, true);
        }
      }
    } else {
      // --- AIRBORNE OR ASCENDING IN JUMP ---
      body.setGravityScale(1.0, true);
      if (hasInput) {
        // Air control: steer horizontal velocity towards target direction
        const currentHVel = this.hCur.set(currentVelocity.x, currentVelocity.z);
        const targetHVel = this.hTarget.set(this.tempDir.x * targetSpeed, this.tempDir.z * targetSpeed);

        const deltaH = this.hDelta.subVectors(targetHVel, currentHVel);
        const maxAirDelta = CHARACTER_CONFIG.AIR_ACCELERATION * context.airControl * dt;

        const dhLen = deltaH.length();
        if (dhLen > maxAirDelta) {
          if (dhLen > 0.0001) {
            deltaH.multiplyScalar(maxAirDelta / dhLen);
          }
        }

        const mass = body.mass();
        const ax = deltaH.x * mass, az = deltaH.y * mass;
        if (Number.isFinite(ax) && Number.isFinite(az)) {
          this.imp.x = ax; this.imp.y = 0; this.imp.z = az;
          body.applyImpulse(this.imp, true);
        }
      } else {
        // Gentle horizontal air drag only
        const currentHVel = this.hCur.set(currentVelocity.x, currentVelocity.z);
        const chLen = currentHVel.length();
        if (chLen > 0.1) {
          const airDecel = Math.min(chLen, CHARACTER_CONFIG.AIR_DECELERATION * dt);
          currentHVel.multiplyScalar(-airDecel / chLen);
          const mass = body.mass();
          if (Number.isFinite(currentHVel.x) && Number.isFinite(currentHVel.y)) {
            this.imp.x = currentHVel.x * mass; this.imp.y = 0; this.imp.z = currentHVel.y * mass;
            body.applyImpulse(this.imp, true);
          }
        }
      }
    }
  }
}
