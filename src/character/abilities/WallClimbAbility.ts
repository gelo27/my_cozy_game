import * as THREE from 'three';
import { IAbility, CharacterContext } from './IAbility';
import { COLLISION_GROUPS, CHARACTER_CONFIG, WALL_CLIMB_CONFIG } from '../../config/constants';

export class WallClimbAbility implements IAbility {
  public name = 'WallClimb';
  public enabled: boolean = CHARACTER_CONFIG.ENABLE_WALL_CLIMB && WALL_CLIMB_CONFIG.ENABLE_WALL_CLIMB;

  public isClimbing: boolean = false;
  public wallNormal = new THREE.Vector3();
  private wallHitPoint = new THREE.Vector3();
  private topLedgeY: number = 0;
  private vaultCooldown: number = 0;
  private climbDuration: number = 0;

  // Temp vectors
  private forwardVec = new THREE.Vector3();
  private wallTangentRight = new THREE.Vector3();

  public update(dt: number, context: CharacterContext): void {
    if (this.vaultCooldown > 0) {
      this.vaultCooldown -= dt;
    }

    if (!this.enabled) {
      if (this.isClimbing) {
        context.body.setGravityScale(1, true);
        this.exitClimb(context);
      }
      context.isClimbing = false;
      return;
    }

    const { body, input, ground } = context;
    const charPos = body.translation();

    // 1. Currently climbing
    if (this.isClimbing) {
      context.isClimbing = true;
      this.climbDuration += dt;

      // Enforce zero gravity scale for capsule while climbing
      body.setGravityScale(0, true);

      // Drop off wall if crouching, holding back, or touching the ground
      if (input.crouch || (input.forward < -0.5 && !input.jump) || ground.isGrounded) {
        this.exitClimb(context);
        this.vaultCooldown = 0.35;
        return;
      }

      const feetY = charPos.y - 0.75; // Feet height
      const chestY = charPos.y + 0.1;

      // Re-verify wall presence
      const wallCheck = this.detectWall(context);
      if (!wallCheck.isWallDetected) {
        // Wall face is lost. Check if we are actually hanging on a valid top ledge directly above/in front
        const ledgeCheck = this.checkTopLedgeAtPos(context);
        if (ledgeCheck.hasLedge) {
          this.topLedgeY = ledgeCheck.topLedgeY;
          if (input.jump) {
            this.executeTopVault(context);
            return;
          }
          if (input.forward >= -0.1) {
            body.setTranslation({ x: charPos.x, y: this.topLedgeY - 0.4, z: charPos.z }, true);
          }
        } else {
          // No wall and no top ledge at this horizontal position -> player moved off side or bottom edge of wall!
          this.exitClimb(context);
          this.vaultCooldown = 0.25;
          return;
        }
      } else {
        this.wallNormal.copy(wallCheck.normal);
        this.topLedgeY = wallCheck.topLedgeY;
      }

      const nearTopLedge = chestY >= this.topLedgeY - 0.35 || feetY >= this.topLedgeY - 0.85;

      // If near top ledge, the player HANGS and must press JUMP to vault over onto the platform!
      if (nearTopLedge) {
        if (input.jump) {
          this.executeTopVault(context);
          return;
        }

        // Snap height only if not actively trying to climb down
        if (input.forward >= -0.1) {
          if (charPos.y > this.topLedgeY - 0.4) {
            body.setTranslation({ x: charPos.x, y: this.topLedgeY - 0.4, z: charPos.z }, true);
          }
        }
      }

      // Compute Wall Tangent Vector (Right relative to camera facing wall)
      this.computeWallTangent(context);

      // Vertical climb motion
      let targetVelY = 0;
      if (nearTopLedge) {
        // Hanging on ledge - cannot climb higher, must press Space to vault!
        targetVelY = 0;
        if (input.forward < -0.1) {
          targetVelY = -WALL_CLIMB_CONFIG.CLIMB_SPEED_DOWN; // Climb DOWN from ledge
        }
      } else {
        if (input.forward > 0.1) {
          targetVelY = WALL_CLIMB_CONFIG.CLIMB_SPEED_UP; // Climb UP
        } else if (input.forward < -0.1) {
          targetVelY = -WALL_CLIMB_CONFIG.CLIMB_SPEED_DOWN; // Climb DOWN
        } else {
          targetVelY = 0; // Hold position
        }
      }

      // Horizontal climb motion (Left / Right along wall face)
      const climbSpeedHorizontal = WALL_CLIMB_CONFIG.CLIMB_SPEED_HORIZONTAL;
      const horizVel = this.wallTangentRight.clone().multiplyScalar(input.right * climbSpeedHorizontal);

      // Push slightly into wall surface to stay attached
      const pushForce = 0.8;
      const pushX = -this.wallNormal.x * pushForce;
      const pushZ = -this.wallNormal.z * pushForce;

      body.setLinvel(
        {
          x: horizVel.x + pushX,
          y: targetVelY,
          z: horizVel.z + pushZ,
        },
        true
      );

      // Disable gravity during climb
      context.appliedImpulse.set(0, 0, 0);
      return;
    }

    // 2. Not currently climbing -> Check entry condition
    context.isClimbing = false;

    if (this.vaultCooldown > 0 || context.isCrouching || context.isHoldingObject || ground.isGrounded) {
      return;
    }

    // Must be pushing forward or jumping towards wall
    const isPushing = input.forward > 0.1 || (input.jump && !ground.isGrounded);
    if (!isPushing) {
      return;
    }

    const wallInfo = this.detectWall(context);
    if (wallInfo.isWallDetected && wallInfo.distance < WALL_CLIMB_CONFIG.DETECTION_DISTANCE) {
      // Grab wall and start climbing!
      this.isClimbing = true;
      context.isClimbing = true;
      this.climbDuration = 0;
      this.wallNormal.copy(wallInfo.normal);
      this.wallHitPoint.copy(wallInfo.hitPoint);
      this.topLedgeY = wallInfo.topLedgeY;

      body.setGravityScale(0, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  /**
   * Computes horizontal wall tangent vector aligned with camera view
   */
  private computeWallTangent(context: CharacterContext): void {
    const { cameraRight } = context;

    // wallNormal points OUT from wall surface.
    // Right tangent along wall face = UP x wallNormal
    this.wallTangentRight.crossVectors(new THREE.Vector3(0, 1, 0), this.wallNormal).normalize();

    // Align wallTangentRight direction with camera right vector so D = Right, A = Left
    if (this.wallTangentRight.dot(cameraRight) < 0) {
      this.wallTangentRight.negate();
    }
  }

  /**
   * Raycast wall & top ledge detector
   */
  private detectWall(context: CharacterContext): {
    isWallDetected: boolean;
    normal: THREE.Vector3;
    hitPoint: THREE.Vector3;
    distance: number;
    topLedgeY: number;
  } {
    const { body, collider, physics, cameraForward, cameraRight, input } = context;
    const charPos = body.translation();

    let rayDir = new THREE.Vector3();

    if (this.isClimbing && this.wallNormal.lengthSq() > 0.1) {
      // While climbing, raycast directly towards wall surface (-wallNormal)
      rayDir.copy(this.wallNormal).negate();
    } else {
      // Entry mode: determine character forward movement vector
      if (Math.abs(input.forward) > 0.01 || Math.abs(input.right) > 0.01) {
        rayDir.addScaledVector(cameraForward, input.forward).addScaledVector(cameraRight, input.right);
        rayDir.y = 0;
        if (rayDir.lengthSq() > 0.001) rayDir.normalize();
      }
      if (rayDir.lengthSq() < 0.001) {
        rayDir.copy(cameraForward);
        rayDir.y = 0;
        if (rayDir.lengthSq() > 0.001) rayDir.normalize();
      }
    }

    const envFilter = physics.packCollisionGroups(
      COLLISION_GROUPS.DYNAMIC_PROPS,
      COLLISION_GROUPS.ENVIRONMENT
    );

    const chestOrigin = new THREE.Vector3(charPos.x, charPos.y + 0.5, charPos.z);
    const hipOrigin = new THREE.Vector3(charPos.x, charPos.y + 0.1, charPos.z);
    const maxDist = this.isClimbing ? 1.20 : 0.85;

    const chestHit = physics.castRayAndGetNormal(chestOrigin, rayDir, maxDist, collider, envFilter);
    const hipHit = physics.castRayAndGetNormal(hipOrigin, rayDir, maxDist, collider, envFilter);

    const hit = chestHit || hipHit;

    if (!hit) {
      return {
        isWallDetected: false,
        normal: new THREE.Vector3(),
        hitPoint: new THREE.Vector3(),
        distance: Infinity,
        topLedgeY: 0,
      };
    }

    // Must be a vertical wall (normal.y near 0)
    if (Math.abs(hit.normal.y) > 0.35) {
      return {
        isWallDetected: false,
        normal: new THREE.Vector3(),
        hitPoint: new THREE.Vector3(),
        distance: Infinity,
        topLedgeY: 0,
      };
    }

    // Probe top ledge height by raycasting down 0.28m inside the wall
    const inwardPoint = hit.point.clone().addScaledVector(hit.normal, -0.28);
    const topRayOrigin = new THREE.Vector3(inwardPoint.x, charPos.y + 4.5, inwardPoint.z);
    const downDir = new THREE.Vector3(0, -1, 0);

    const ledgeHit = physics.castRayAndGetNormal(topRayOrigin, downDir, 6.0, collider, envFilter);

    let topLedgeY = charPos.y + 2.0;
    if (ledgeHit) {
      topLedgeY = ledgeHit.point.y;
    }

    return {
      isWallDetected: true,
      normal: hit.normal,
      hitPoint: hit.point,
      distance: hit.hit.timeOfImpact,
      topLedgeY,
    };
  }

  /**
   * Final Vault / Jump onto top of wall platform
   */
  private executeTopVault(context: CharacterContext): void {
    const { body } = context;
    const charPos = body.translation();

    this.isClimbing = false;
    context.isClimbing = false;
    body.setGravityScale(1, true);
    
    // Disable wall detection for 0.95 seconds so the character can complete the physics flight
    // arc and land safely on top of the platform without immediately re-grabbing the wall.
    this.vaultCooldown = 0.95;

    // Direction pointing inward past wall face onto platform top
    const inwardDir = this.wallNormal.clone().negate();
    inwardDir.y = 0;
    if (inwardDir.lengthSq() > 0.001) inwardDir.normalize();

    // Position the character with a clean buffer offset away from the wall's vertical face (0.25m),
    // and elevate the starting center Y to pull-up level (this.topLedgeY + 0.35m) so the capsule's bottom
    // is aligned with the hands hanging. This guarantees the capsule's collider never clips the lip.
    const safeStartPos = {
      x: charPos.x + this.wallNormal.x * 0.25,
      y: this.topLedgeY + 0.35,
      z: charPos.z + this.wallNormal.z * 0.25,
    };

    body.setTranslation(safeStartPos, true);

    // Apply high upward and forward physics velocities to complete a beautiful, natural flight arc.
    // An upward velocity of 7.5 m/s provides a clean vault height lift to clear any platform thickness.
    const forwardSpeed = 2.5;
    const upwardVel = 7.5;

    body.setLinvel(
      {
        x: inwardDir.x * forwardSpeed,
        y: upwardVel,
        z: inwardDir.z * forwardSpeed,
      },
      true
    );

    context.appliedImpulse.set(0, upwardVel * body.mass(), 0);
  }

  /**
   * Wall Jump off wall (backwards/upwards)
   */
  private executeWallJump(context: CharacterContext): void {
    const { body } = context;

    this.isClimbing = false;
    context.isClimbing = false;
    body.setGravityScale(1, true);
    this.vaultCooldown = 0.4;

    const launchY = 6.8;
    const launchBack = this.wallNormal.clone().multiplyScalar(4.8);

    body.setLinvel(
      {
        x: launchBack.x,
        y: launchY,
        z: launchBack.z,
      },
      true
    );

    context.appliedImpulse.set(0, launchY * body.mass(), 0);
  }

  /**
   * Verifies if a valid top ledge surface actually exists directly in front/above at the character's current position.
   */
  private checkTopLedgeAtPos(context: CharacterContext): { hasLedge: boolean; topLedgeY: number } {
    const { body, collider, physics } = context;
    const charPos = body.translation();
    const envFilter = physics.packCollisionGroups(
      COLLISION_GROUPS.DYNAMIC_PROPS,
      COLLISION_GROUPS.ENVIRONMENT
    );

    const inwardDir = this.wallNormal.clone().negate();
    inwardDir.y = 0;
    if (inwardDir.lengthSq() > 0.001) {
      inwardDir.normalize();
    } else {
      return { hasLedge: false, topLedgeY: 0 };
    }

    // Cast ray down from 0.25m inward from character position, slightly above chest level
    const rayOrigin = new THREE.Vector3(
      charPos.x + inwardDir.x * 0.25,
      charPos.y + 1.2,
      charPos.z + inwardDir.z * 0.25
    );
    const downDir = new THREE.Vector3(0, -1, 0);

    const hit = physics.castRayAndGetNormal(rayOrigin, downDir, 2.5, collider, envFilter);
    if (hit && hit.normal.y > 0.5) {
      const ledgeY = hit.point.y;
      // Verify the ledge surface is near upper body level (between charPos.y - 0.2 and charPos.y + 1.2)
      if (ledgeY >= charPos.y - 0.2 && ledgeY <= charPos.y + 1.2) {
        return { hasLedge: true, topLedgeY: ledgeY };
      }
    }

    return { hasLedge: false, topLedgeY: 0 };
  }

  private exitClimb(context: CharacterContext): void {
    context.body.setGravityScale(1, true);
    this.isClimbing = false;
    context.isClimbing = false;
  }
}
