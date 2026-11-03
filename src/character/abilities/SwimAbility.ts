import { worldSettings } from '../../world/WorldSettings';
import { riverWorld } from '../../world/rivers/RiverWorld';
import * as THREE from 'three';
import { IAbility, CharacterContext } from './IAbility';
import {
  WATER_PHYSICS_CONFIG,
  WATER_FOG_CONFIG,
  WATER_MANTLE_CONFIG,
  COLLISION_GROUPS,
} from '../../config/constants';
import { WaterEffects } from '../../scene/WaterEffects';
import { WaterParticleSystem } from '../../particles/WaterParticleSystem';

export class SwimAbility implements IAbility {
  public name = 'Swim';
  public enabled = true;

  public isSwimming = false;
  public isMantling = false;
  public canMantle = false;

  private wasSwimming = false;
  private mantleTimer = 0;
  private rippleTimer = 0;
  private bubbleTimer = 0;
  private bubblePauseTimer = 0;
  private mantleCooldown = 0;

  // Water boundaries
  private waterMin = new THREE.Vector3(
    WATER_FOG_CONFIG.BOUNDS_MIN_X,
    -28,
    WATER_FOG_CONFIG.BOUNDS_MIN_Z
  );
  private waterMax = new THREE.Vector3(
    WATER_FOG_CONFIG.BOUNDS_MAX_X,
    worldSettings.waterLevel,
    WATER_FOG_CONFIG.BOUNDS_MAX_Z
  );

  public waterEffects: WaterEffects | null = null;
  public waterParticles: WaterParticleSystem | null = null;

  private readonly flow = { x: 0, z: 0 };

  // Ledge cache
  private detectedLedgeNormal = new THREE.Vector3();
  private detectedLedgeTopY = 0;

  public update(dt: number, context: CharacterContext): void {
    if (this.mantleCooldown > 0) {
      this.mantleCooldown -= dt;
    }

    if (!this.enabled) {
      if (this.isSwimming) {
        context.body.setGravityScale(1, true);
      }
      this.isSwimming = false;
      context.isSwimming = false;
      context.canMantle = false;
      context.isMantling = false;
      return;
    }

    const pos = context.body.translation();
    const vel = context.body.linvel();

    // Local surface: the sea, or a river (only deep enough stretches are swum; shallows are waded)
    const level = riverWorld.waterLevelAt(pos.x, pos.z);
    this.waterMax.y = level;
    const shallowRiver = level > worldSettings.waterLevel + 0.01 && riverWorld.depthAt(pos.x, pos.z) < 0.95;
    riverWorld.flowAt(pos.x, pos.z, this.flow);

    // 1. Water Bounds Check
    // Capsule height is 1.5m (center at pos.y). Enter water when center drops below water level + 0.45m.
    const inWaterVolume =
      pos.x >= this.waterMin.x &&
      pos.x <= this.waterMax.x &&
      pos.z >= this.waterMin.z &&
      pos.z <= this.waterMax.z &&
      pos.y >= this.waterMin.y &&
      pos.y <= this.waterMax.y + 0.45 &&
      !shallowRiver;

    this.isSwimming = inWaterVolume && !this.isMantling;
    context.isSwimming = this.isSwimming;

    // Water Depth (distance from surface to head)
    const headY = pos.y + 0.4;
    const depth = Math.max(0, this.waterMax.y - headY);
    context.swimDepth = depth;

    // 2. Water Entry Impact Splash
    if (this.isSwimming && !this.wasSwimming) {
      const impactSpeed = Math.abs(vel.y);
      if (impactSpeed >= WATER_PHYSICS_CONFIG.ENTRY_SPLASH_VELOCITY_MIN) {
        if (this.waterParticles) {
          this.waterParticles.emitWaterSplash(
            new THREE.Vector3(pos.x, this.waterMax.y, pos.z),
            impactSpeed
          );
        }
        if (this.waterEffects) {
          this.waterEffects.emitRippleBurst(pos.x, pos.z, impactSpeed * 0.4);
        }
      }
    }
    this.wasSwimming = this.isSwimming;

    // 3. Active Mantle In Progress
    if (this.isMantling) {
      this.mantleTimer -= dt;
      context.isMantling = true;
      context.canMantle = false;
      if (this.mantleTimer <= 0) {
        this.isMantling = false;
        context.isMantling = false;
        context.body.setGravityScale(1, true);
        this.mantleCooldown = WATER_MANTLE_CONFIG.MANTLE_COOLDOWN;
      }
      return;
    }

    // 4. Ledge Mantle Detection & Execution
    if (this.isSwimming) {
      const ledgeCheck = this.detectLedge(context);
      this.canMantle = ledgeCheck.canMantle && this.mantleCooldown <= 0;
      context.canMantle = this.canMantle;

      if (this.canMantle) {
        this.detectedLedgeNormal.copy(ledgeCheck.normal);
        this.detectedLedgeTopY = ledgeCheck.topY;

        // Trigger Mantle if player presses Jump (Space) or moves aggressively forward into ledge
        if (context.input.jump || context.input.forward > 0.6) {
          this.executeWaterMantle(context);
          return;
        }
      }
    } else {
      this.canMantle = false;
      context.canMantle = false;
    }

    // 5. Swim Physics Locomotion
    if (this.isSwimming) {
      context.body.setGravityScale(0, true);

      let vy = vel.y;
      const moveMag = Math.sqrt(
        context.input.forward * context.input.forward +
          context.input.right * context.input.right
      );
      const isMoving = moveMag > 0.01;

      // Base swimming speed
      const speedMultiplier = context.isSprinting
        ? WATER_PHYSICS_CONFIG.SWIM_SPRINT_SPEED_RATIO
        : WATER_PHYSICS_CONFIG.SWIM_WALK_SPEED_RATIO;
      const swimSpeed = WATER_PHYSICS_CONFIG.SWIM_BASE_SPEED * speedMultiplier;

      let targetVel = new THREE.Vector3(0, 0, 0);

      if (isMoving) {
        const moveDir = new THREE.Vector3()
          .addScaledVector(context.cameraForward, context.input.forward)
          .addScaledVector(context.cameraRight, context.input.right)
          .normalize();

        targetVel.copy(moveDir).multiplyScalar(swimSpeed);
      }

      // Vertical swimming logic
      let hasVerticalInput = false;
      let targetVy = 0;
      const verticalSpeed = WATER_PHYSICS_CONFIG.SWIM_VERTICAL_SPEED;
      const surfaceY = this.waterMax.y - WATER_PHYSICS_CONFIG.SWIM_SURFACE_OFFSET;

      if (context.input.crouch) {
        targetVy = -verticalSpeed;
        hasVerticalInput = true;
      } else if (context.input.jump) {
        targetVy = verticalSpeed;
        hasVerticalInput = true;
      }

      if (hasVerticalInput) {
        if (targetVy > 0 && pos.y >= surfaceY) {
          // Smoothly dampen upward swimming near surface so character rests naturally
          const overSurface = pos.y - surfaceY;
          targetVy *= Math.max(0, 1 - overSurface / 0.25);
        }
        vy = THREE.MathUtils.lerp(vy, targetVy, 1 - Math.exp(-12 * dt));
      } else if (isMoving) {
        // If moving, camera pitch influences vy, but cap upward movement near surface
        let moveVy = targetVel.y;
        if (pos.y >= surfaceY && moveVy > 0) {
          const overSurface = pos.y - surfaceY;
          moveVy *= Math.max(0, 1 - overSurface / 0.25);
        }
        vy = THREE.MathUtils.lerp(vy, moveVy, 1 - Math.exp(-8 * dt));
      } else {
        // Idle treading water
        if (depth < 0.35) {
          // Near surface: gently stabilize around surfaceY
          const diffY = surfaceY - pos.y;
          vy = THREE.MathUtils.lerp(vy, diffY * 3.5, 1 - Math.exp(-7 * dt));
        } else {
          // Deep underwater idle drag
          vy *= Math.pow(0.12, dt);
        }
      }

      // Horizontal plane interpolation
      const currentLat = new THREE.Vector3(vel.x, 0, vel.z);
      if (isMoving) {
        const targetLat = new THREE.Vector3(targetVel.x, 0, targetVel.z);
        currentLat.lerp(targetLat, 1 - Math.exp(-WATER_PHYSICS_CONFIG.WATER_DRAG_HORIZONTAL * dt));
      } else {
        currentLat.multiplyScalar(Math.pow(0.1, dt));
      }
      // River current carries the swimmer downstream
      currentLat.x += this.flow.x * dt * 2.5;
      currentLat.z += this.flow.z * dt * 2.5;

      context.body.setLinvel({ x: currentLat.x, y: vy, z: currentLat.z }, true);
      context.targetVelocity.set(0, 0, 0);
      context.appliedImpulse.set(0, 0, 0);
      context.isJumping = false;

      // 6. Surface Ripples Emission while Swimming
      const currentSpeed = Math.sqrt(currentLat.x * currentLat.x + currentLat.z * currentLat.z);
      if (currentSpeed > 0.5 && pos.y > this.waterMax.y - 0.75) {
        this.rippleTimer += dt;
        if (this.rippleTimer >= WATER_PHYSICS_CONFIG.SWIM_STROKE_RIPPLE_INTERVAL) {
          this.rippleTimer = 0;
          if (this.waterEffects) {
            this.waterEffects.emitRipple(
              pos.x,
              pos.z,
              context.isSprinting ? 0.85 : 0.55,
              context.isSprinting ? 3.8 : 2.6
            );
          }
        }
      } else {
        this.rippleTimer = 0;
      }

      // 7. Underwater Air Bubbles Emission (Spawned from head only when moving underwater)
      const totalSpeed = Math.sqrt(
        currentLat.x * currentLat.x + currentLat.z * currentLat.z + vy * vy
      );
      const isSubmerged = pos.y < this.waterMax.y - 0.25;
      const isMovingUnderwater = totalSpeed > 0.45 || context.isDashing;

      if (isSubmerged && isMovingUnderwater) {
        this.bubbleTimer += dt;
        
        if (this.bubblePauseTimer > 0) {
          this.bubblePauseTimer -= dt;
          this.bubbleTimer = 0;
        } else {
          const emitThreshold = context.isDashing ? 0.08 : (0.4 + Math.random() * 0.9);
          if (this.bubbleTimer >= emitThreshold) {
            this.bubbleTimer = 0;
            
            // Random count between 1 and 4
            const count = context.isDashing ? (2 + Math.floor(Math.random() * 3)) : (1 + Math.floor(Math.random() * 4));
            
            if (this.waterParticles) {
              const headPos = new THREE.Vector3(pos.x, pos.y + 0.65, pos.z);
              this.waterParticles.emitUnderwaterBubbles(
                headPos,
                new THREE.Vector3(currentLat.x, vy, currentLat.z),
                count
              );
            }

            // Introduce occasional natural silence/pause (1.2 to 3.5 seconds)
            if (!context.isDashing && Math.random() < 0.65) {
              this.bubblePauseTimer = 1.2 + Math.random() * 2.3;
            }
          }
        }
      } else {
        this.bubbleTimer = 0;
        this.bubblePauseTimer = 0;
      }
    } else {
      context.body.setGravityScale(1, true);
    }
  }

  /**
   * Raycast check to detect climbable dock/pier ledge in front of the swimmer
   */
  private detectLedge(context: CharacterContext): {
    canMantle: boolean;
    normal: THREE.Vector3;
    topY: number;
  } {
    const { body, collider, physics, cameraForward, cameraRight, input } = context;
    const charPos = body.translation();

    // Determine forward probe vector
    let forwardDir = new THREE.Vector3();
    if (Math.abs(input.forward) > 0.01 || Math.abs(input.right) > 0.01) {
      forwardDir
        .addScaledVector(cameraForward, input.forward)
        .addScaledVector(cameraRight, input.right);
      forwardDir.y = 0;
      if (forwardDir.lengthSq() > 0.001) forwardDir.normalize();
    }
    if (forwardDir.lengthSq() < 0.001) {
      forwardDir.copy(cameraForward);
      forwardDir.y = 0;
      if (forwardDir.lengthSq() > 0.001) forwardDir.normalize();
    }

    const envFilter = physics.packCollisionGroups(
      COLLISION_GROUPS.DYNAMIC_PROPS,
      COLLISION_GROUPS.ENVIRONMENT
    );

    // 1. Raycast forward at chest level to find vertical dock wall
    const rayOrigin = new THREE.Vector3(charPos.x, charPos.y + 0.35, charPos.z);
    const wallHit = physics.castRayAndGetNormal(
      rayOrigin,
      forwardDir,
      WATER_MANTLE_CONFIG.DETECTION_DISTANCE,
      collider,
      envFilter
    );

    if (!wallHit || Math.abs(wallHit.normal.y) > 0.4) {
      return { canMantle: false, normal: new THREE.Vector3(), topY: 0 };
    }

    // 2. Raycast down from above the dock to find top deck landing surface
    const inwardDir = wallHit.normal.clone().negate();
    inwardDir.y = 0;
    if (inwardDir.lengthSq() > 0.001) inwardDir.normalize();

    const topRayOrigin = new THREE.Vector3(
      wallHit.point.x + inwardDir.x * 0.35,
      charPos.y + 2.4,
      wallHit.point.z + inwardDir.z * 0.35
    );
    const downDir = new THREE.Vector3(0, -1, 0);

    const ledgeHit = physics.castRayAndGetNormal(topRayOrigin, downDir, 3.5, collider, envFilter);

    if (ledgeHit && ledgeHit.normal.y > 0.5) {
      const topY = ledgeHit.point.y;
      const heightAboveWater = topY - this.waterMax.y;

      // Ledge must be between MIN and MAX reach
      if (
        heightAboveWater >= WATER_MANTLE_CONFIG.MIN_LEDGE_HEIGHT - 0.2 &&
        heightAboveWater <= WATER_MANTLE_CONFIG.MAX_LEDGE_HEIGHT
      ) {
        return {
          canMantle: true,
          normal: wallHit.normal,
          topY,
        };
      }
    }

    return { canMantle: false, normal: new THREE.Vector3(), topY: 0 };
  }

  /**
   * Executes smooth Water Mantle / Ledge Grab onto the platform deck
   */
  private executeWaterMantle(context: CharacterContext): void {
    const { body } = context;
    const charPos = body.translation();

    this.isMantling = true;
    this.isSwimming = false;
    context.isMantling = true;
    context.isSwimming = false;
    this.mantleTimer = 0.35; // 350ms mantle boost phase

    body.setGravityScale(0, true);

    const inwardDir = this.detectedLedgeNormal.clone().negate();
    inwardDir.y = 0;
    if (inwardDir.lengthSq() > 0.001) inwardDir.normalize();

    // Position player slightly above the ledge lip to prevent clipping
    const safeY = Math.max(charPos.y + 0.4, this.detectedLedgeTopY + 0.35);
    body.setTranslation(
      {
        x: charPos.x + inwardDir.x * 0.15,
        y: safeY,
        z: charPos.z + inwardDir.z * 0.15,
      },
      true
    );

    // Apply upward and forward mantle impulse
    const launchUp = WATER_MANTLE_CONFIG.MANTLE_LAUNCH_UPWARD;
    const launchForward = WATER_MANTLE_CONFIG.MANTLE_LAUNCH_FORWARD;

    body.setLinvel(
      {
        x: inwardDir.x * launchForward,
        y: launchUp,
        z: inwardDir.z * launchForward,
      },
      true
    );

    // Splash and ripple feedback at the mantle edge
    if (this.waterParticles) {
      this.waterParticles.emitWaterSplash(
        new THREE.Vector3(charPos.x, this.waterMax.y, charPos.z),
        4.0
      );
    }
    if (this.waterEffects) {
      this.waterEffects.emitRippleBurst(charPos.x, charPos.z, 0.9);
    }
  }
}
