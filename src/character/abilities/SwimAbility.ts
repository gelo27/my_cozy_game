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
import { setWaterBody, setWaterLimb } from '../../scene/WaterDetails';

/** Water shallower than this (m, surface to bed) is waded on foot; deeper is swum. */
const WADE_DEPTH_ENTER = 1.15;
const WADE_DEPTH_EXIT = 1.0;
/** Within this distance (m) below the resting height the swimmer is caught by the surface. */
const SURFACE_CAPTURE = 0.55;
const DOWN = new THREE.Vector3(0, -1, 0);
/** Body centre to the soles (capsule half height + radius, m). */
const CAPSULE_HALF_TOTAL = 0.75;
/** 1 ± amount, uniformly random: keeps repeated ripples from looking machine-made. */
const jitter = (amount: number): number => 1 + (Math.random() * 2 - 1) * amount;

export class SwimAbility implements IAbility {
  // Per-frame scratch values (this update runs every frame while swimming)
  private readonly sTarget = new THREE.Vector3();
  private readonly sMove = new THREE.Vector3();
  private readonly sLat = new THREE.Vector3();
  private readonly sLatTarget = new THREE.Vector3();
  private readonly sHead = new THREE.Vector3();
  private readonly sBubbleVel = new THREE.Vector3();
  private readonly sLin = { x: 0, y: 0, z: 0 };

  public name = 'Swim';
  public enabled = true;

  public isSwimming = false;
  public isMantling = false;
  public canMantle = false;

  private wasSwimming = false;
  private mantleTimer = 0;
  private rippleTimer = 0;
  private wadeTimer = 0;
  /** Randomised waits until the next body ring (swimming / wading). */
  private rippleNext = 0.3;
  private wadeNext = 0.5;
  /** Hand / foot tips (right arm, left arm, right leg, left leg) now and last frame. */
  private readonly limbTips = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly limbPrev = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly limbCooldown = [0, 0, 0, 0];
  /** Seconds since the limbs were last tracked (stale above a frame or two). */
  private limbAge = 1;
  private readonly sLimbVel = new THREE.Vector3();
  private bubbleTimer = 0;
  private bubblePauseTimer = 0;
  private mantleCooldown = 0;
  /** Held at the surface (floating) rather than swimming free underwater. */
  private surfaced = false;
  private bobTime = 0;
  /** Extra height while gliding along the surface (eased in and out). */
  private glideLift = 0;
  private groundFilter = 0;
  private readonly rayOrigin = new THREE.Vector3();

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
    this.limbAge += dt;
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

    // Local surface: a cave pool, the sea, or a river (only deep enough stretches are swum; shallows are waded)
    const caveLevel = riverWorld.caveLevelAt(pos.x, pos.y, pos.z);
    const inCavePool = !Number.isNaN(caveLevel);
    const level = inCavePool ? caveLevel : riverWorld.waterLevelAt(pos.x, pos.z);
    this.waterMax.y = level;
    riverWorld.flowAt(pos.x, pos.z, this.flow);
    // Shallows are waded, not swum: the player stands up wherever the water is at most about
    // waist / chest deep (hysteresis so walking along the edge does not flicker)
    const bed = pos.y <= level + 0.45 ? this.waterDepthUnder(context, pos, level, inCavePool) : Infinity;
    const shallow = bed < (this.isSwimming ? WADE_DEPTH_EXIT : WADE_DEPTH_ENTER);

    // 1. Water Bounds Check
    // Capsule height is 1.5m (center at pos.y). Enter water when center drops below water level + 0.45m.
    // Cave pools lie in their own pocket outside the sea bounds and have their own extent
    const inWaterVolume =
      (inCavePool ||
        (pos.x >= this.waterMin.x &&
          pos.x <= this.waterMax.x &&
          pos.z >= this.waterMin.z &&
          pos.z <= this.waterMax.z &&
          pos.y >= this.waterMin.y)) &&
      pos.y <= this.waterMax.y + 0.45 &&
      !shallow;

    this.isSwimming = inWaterVolume && !this.isMantling;
    if (!this.isSwimming) this.surfaced = false;
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

      const targetVel = this.sTarget.set(0, 0, 0);

      if (isMoving) {
        const moveDir = this.sMove.set(0, 0, 0)
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

      // Surface capture: once the body comes up near the surface (and the player is not diving),
      // it is held there by a stiff, critically damped spring with a gentle bob, like floating in
      // most games: swimming forward never drifts the body under, and coming up from a dive the
      // body pops up and settles instead of sinking back.
      this.bobTime += dt;
      if (context.input.crouch) this.surfaced = false;
      else if (pos.y > surfaceY - SURFACE_CAPTURE) this.surfaced = true;

      if (context.input.crouch) {
        vy = THREE.MathUtils.lerp(vy, targetVy, 1 - Math.exp(-12 * dt));
      } else if (this.surfaced) {
        const bob = Math.sin(this.bobTime * 2.1) * 0.035;
        const err = surfaceY + bob - pos.y;
        // Spring (k) + damping toward the target; jump just lifts the body a bit higher. Swimming
        // along, the body lies flat: it rides higher so the back and shoulders stay above water
        const glide = THREE.MathUtils.smoothstep(Math.hypot(vel.x, vel.z), 0.4, 2.5);
        this.glideLift += (glide * WATER_PHYSICS_CONFIG.SWIM_GLIDE_LIFT - this.glideLift) * (1 - Math.exp(-4 * dt));
        const lift = (context.input.jump ? 0.12 : 0) + this.glideLift;
        const target = (err + lift) * 9;
        vy = THREE.MathUtils.lerp(vy, THREE.MathUtils.clamp(target, -3, 3), 1 - Math.exp(-10 * dt));
      } else if (hasVerticalInput) {
        vy = THREE.MathUtils.lerp(vy, targetVy, 1 - Math.exp(-12 * dt));
      } else {
        // Underwater: neutral buoyancy with water drag
        vy *= Math.pow(0.12, dt);
      }

      // Horizontal plane interpolation
      const currentLat = this.sLat.set(vel.x, 0, vel.z);
      if (isMoving) {
        const targetLat = this.sLatTarget.set(targetVel.x, 0, targetVel.z);
        currentLat.lerp(targetLat, 1 - Math.exp(-WATER_PHYSICS_CONFIG.WATER_DRAG_HORIZONTAL * dt));
      } else {
        currentLat.multiplyScalar(Math.pow(0.1, dt));
      }
      // River current carries the swimmer downstream
      currentLat.x += this.flow.x * dt * 2.5;
      currentLat.z += this.flow.z * dt * 2.5;

      this.sLin.x = currentLat.x; this.sLin.y = vy; this.sLin.z = currentLat.z;
      context.body.setLinvel(this.sLin, true);
      context.targetVelocity.set(0, 0, 0);
      context.appliedImpulse.set(0, 0, 0);
      context.isJumping = false;

      // 6. Surface Ripples Emission while Swimming
      // (strokes leave a trail of rings behind the moving body; floating still, slow gentle rings)
      const currentSpeed = Math.sqrt(currentLat.x * currentLat.x + currentLat.z * currentLat.z);
      const atSurface = pos.y > this.waterMax.y - 0.75;
      if (atSurface && !inCavePool && this.waterEffects) {
        const moving = currentSpeed > 0.5;
        // The wave simulation follows the swimmer and its motion pushes a wake
        setWaterBody(pos.x, pos.z, currentSpeed, 0.45);
        // The hands break the surface on their own (their rings and wakes keep it from looking too even)
        this.updateLimbRipples(dt, context, this.waterMax.y, true, 0);
        this.rippleTimer += dt;
        if (this.rippleTimer >= this.rippleNext) {
          this.rippleTimer = 0;
          // Uneven on purpose: interval, place, strength and size all wander a little
          this.rippleNext = moving
            ? WATER_PHYSICS_CONFIG.SWIM_STROKE_RIPPLE_INTERVAL * (context.isSprinting ? 1.0 : 1.3) * jitter(0.25)
            : 1.3 * jitter(0.2);
          if (moving) {
            // Born at the head (a little ahead of the body), squeezed in front: a bow wave
            const ahead = 0.45 / currentSpeed;
            this.waterEffects.emitRipple(
              pos.x + currentLat.x * ahead + (Math.random() - 0.5) * 0.16,
              pos.z + currentLat.z * ahead + (Math.random() - 0.5) * 0.16,
              (context.isSprinting ? 0.8 : 0.55) * jitter(0.2),
              (context.isSprinting ? 3.4 : 2.5) * jitter(0.15),
              undefined,
              currentLat.x,
              currentLat.z
            );
          } else {
            this.waterEffects.emitRipple(pos.x, pos.z, 0.35 * jitter(0.2), 1.7 * jitter(0.15), 2.4);
          }
        }
      } else {
        this.rippleTimer = 0;
      }

      // 7. Underwater Air Bubbles Emission (Spawned from head only when moving underwater)
      const totalSpeed = Math.sqrt(
        currentLat.x * currentLat.x + currentLat.z * currentLat.z + vy * vy
      );
      // Head (mouth) well under the surface: no bubbles while floating
      const isSubmerged = pos.y + 0.65 < this.waterMax.y - 0.3 && !this.surfaced;
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
              const headPos = this.sHead.set(pos.x, pos.y + 0.65, pos.z);
              this.waterParticles.emitUnderwaterBubbles(
                headPos,
                this.sBubbleVel.set(currentLat.x, vy, currentLat.z),
                count,
                this.waterMax.y
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
      this.updateWadeRipples(dt, context, pos, vel, level, inCavePool);
    }
  }

  /**
   * Hands (swimming) or feet (wading) as their own ripple sources, at the real animated limb tips:
   * - each pushes its own small wake in the wave simulation while it moves through the surface;
   * - a hand that dips in from above drops a splash ring, and a limb sweeping fast through the
   *   water throws small rings now and then (random cooldowns, sizes and strengths),
   * so the surface no longer looks like one perfect ring train from the body.
   */
  private updateLimbRipples(dt: number, context: CharacterContext, level: number, swimming: boolean, deep: number): void {
    const model = context.model as { limbTips?(out: THREE.Vector3[]): boolean } | undefined;
    if (!this.waterEffects || !model?.limbTips || dt <= 0 || !model.limbTips(this.limbTips)) return;
    // Not called last frame (left the water, dived...): the previous tips are stale
    const valid = this.limbAge < 0.1;
    this.limbAge = 0;
    const lin = context.body.linvel();
    const bodySpeed = Math.hypot(lin.x, lin.z);
    for (let i = 0; i < 4; i++) {
      const isHand = i < 2;
      if (!swimming && isHand) continue;
      const tip = this.limbTips[i];
      const prev = this.limbPrev[i];
      const vx = valid ? (tip.x - prev.x) / dt : 0;
      const vz = valid ? (tip.z - prev.z) / dt : 0;
      const vy = valid ? (tip.y - prev.y) / dt : 0;
      const speedH = Math.hypot(vx, vz);
      this.limbCooldown[i] -= dt;
      // Swimming: only a limb at the surface stirs it. Wading: the leg always crosses the surface
      const inBand = swimming ? tip.y < level + 0.12 && tip.y > level - 0.4 : true;
      if (inBand) {
        const stir = swimming ? Math.hypot(speedH, vy) * 0.8 : speedH * (0.5 + deep * 0.6);
        setWaterLimb(i + 1, tip.x, tip.z, stir, swimming ? 0.14 : 0.16);
      }
      const v = this.sLimbVel.set(vx, 0, vz);
      if (swimming && valid && prev.y >= level && tip.y < level) {
        // A hand (or a kicking foot) dipping in: a splash ring
        this.waterEffects.emitRipple(tip.x, tip.z, 0.4 * jitter(0.25), 1.2 * jitter(0.2), undefined, v.x * 0.5, v.z * 0.5);
        this.limbCooldown[i] = 0.3 + Math.random() * 0.2;
      } else if (inBand && this.limbCooldown[i] <= 0) {
        const fast = swimming ? speedH > 1.3 : speedH > Math.max(0.9, bodySpeed * 1.15);
        if (fast) {
          const s = swimming ? 0.22 : 0.22 + deep * 0.28;
          const r = swimming ? 0.8 : 0.9 + deep * 0.8;
          this.waterEffects.emitRipple(
            tip.x + (Math.random() - 0.5) * 0.1,
            tip.z + (Math.random() - 0.5) * 0.1,
            s * jitter(0.3),
            r * jitter(0.25),
            undefined,
            v.x,
            v.z
          );
          this.limbCooldown[i] = (swimming ? 0.35 : 0.22) + Math.random() * (swimming ? 0.4 : 0.25);
        }
      }
      prev.copy(tip);
    }
  }

  /** Walking (or standing) in the shallows: rings spread from the legs, quicker the faster the stride. */
  private updateWadeRipples(
    dt: number,
    context: CharacterContext,
    pos: { x: number; y: number; z: number },
    vel: { x: number; y: number; z: number },
    level: number,
    inCavePool: boolean
  ): void {
    const feet = pos.y - CAPSULE_HALF_TOTAL;
    const depthIn = level - feet;
    // Feet covered by a few cm, and the water below the head
    if (inCavePool || !this.waterEffects || depthIn < 0.06 || depthIn > CAPSULE_HALF_TOTAL * 2 - 0.2) {
      this.wadeTimer = 0;
      return;
    }
    const speed = Math.hypot(vel.x, vel.z);
    const moving = speed > 0.4;
    const deep = Math.min(depthIn, 0.9);
    // The legs push the simulated water aside (deeper = more water moved)
    setWaterBody(pos.x, pos.z, speed * (0.3 + deep * 0.5), 0.3);
    // Each foot stirs the water where it really is, ring by ring as it swings through
    this.updateLimbRipples(dt, context, level, false, deep);
    this.wadeTimer += dt;
    if (this.wadeTimer < this.wadeNext) return;
    this.wadeTimer = 0;
    this.wadeNext = moving ? THREE.MathUtils.clamp(1.4 / speed, 0.3, 0.7) * jitter(0.25) : 1.8 * jitter(0.2);
    if (moving) {
      const ahead = 0.3 / speed;
      this.waterEffects.emitRipple(
        pos.x + vel.x * ahead + (Math.random() - 0.5) * 0.14,
        pos.z + vel.z * ahead + (Math.random() - 0.5) * 0.14,
        (0.25 + deep * 0.35) * jitter(0.2),
        (1.4 + deep * 1.1 + Math.min(speed, 6) * 0.12) * jitter(0.15),
        undefined,
        vel.x,
        vel.z
      );
    } else {
      this.waterEffects.emitRipple(pos.x, pos.z, 0.35 + deep * 0.25, 1.2 + deep * 0.6, 2.2);
    }
  }

  /**
   * Water depth (surface to bed) under the player: a ray down to the ground / seabed / dock,
   * falling back to the river bed sample. Deep water past the ray counts as very deep.
   */
  private waterDepthUnder(context: CharacterContext, pos: { x: number; y: number; z: number }, level: number, cave = false): number {
    if (!this.groundFilter) {
      this.groundFilter = context.physics.packCollisionGroups(
        COLLISION_GROUPS.CHARACTER,
        COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS
      );
    }
    // Probe from the surface (or the body, if it is lower) so ground just under the feet is found
    this.rayOrigin.set(pos.x, Math.min(pos.y, level + 0.5), pos.z);
    const hit = context.physics.castRayAndGetNormal(this.rayOrigin, DOWN, 6, context.collider, this.groundFilter);
    if (hit) return level - hit.point.y;
    if (cave) return Infinity;
    if (level > worldSettings.waterLevel + 0.01) return riverWorld.depthAt(pos.x, pos.z);
    return Infinity;
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
