import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { IAbility, CharacterContext } from './IAbility';
import { CARRY_CONFIG, COLLISION_GROUPS } from '../../config/constants';

export class CarryAbility implements IAbility {
  public name: string = 'Carry';
  public enabled: boolean = true;
  
  public isHolding: boolean = false;
  public heldBody: RAPIER.RigidBody | null = null;

  private savedCollisionGroups: number | null = null;
  public getFacingDirection?: () => THREE.Vector3;
  public getFacingAngle?: () => number;

  public onPickUp?: (body: RAPIER.RigidBody) => void;
  public onThrow?: (body: RAPIER.RigidBody) => void;
  public onDrop?: () => void;

  public update(dt: number, context: CharacterContext): void {
    if (!this.enabled) return;

    // Check for pickup or throw trigger
    if (context.input.interactJustPressed) {
      if (this.isHolding) {
        this.throwObject(context);
      } else {
        this.pickUp(context);
      }
    }

    // Safety check: if held body becomes invalid, clean up
    if (this.isHolding && this.heldBody) {
      try {
        if (!this.heldBody.isValid()) {
          this.dropObject(context);
          return;
        }

        // Update held object position & rotation smoothly following character with ceiling/wall collision protection
        const charPos = context.body.translation();
        let qy = 0;
        let qw = 1;
        if (this.getFacingAngle) {
          const angle = this.getFacingAngle();
          if (Number.isFinite(angle)) {
            const halfAngle = angle * 0.5;
            qy = Math.sin(halfAngle);
            qw = Math.cos(halfAngle);
          }
        }

        if (
          Number.isFinite(charPos.x) &&
          Number.isFinite(charPos.y) &&
          Number.isFinite(charPos.z) &&
          Number.isFinite(qy) &&
          Number.isFinite(qw)
        ) {
          // Check ceiling obstruction above character head to prevent object from penetrating low ceilings/tunnels
          let targetHoldY = charPos.y + CARRY_CONFIG.HOLD_HEIGHT_OFFSET;
          const headOrigin = new THREE.Vector3(charPos.x, charPos.y + 0.6, charPos.z);
          const upDir = new THREE.Vector3(0, 1, 0);
          const maxCheckHeight = CARRY_CONFIG.HOLD_HEIGHT_OFFSET - 0.6 + 0.3; // check up to hold top

          const envFilter = context.physics.packCollisionGroups(
            COLLISION_GROUPS.DYNAMIC_PROPS,
            COLLISION_GROUPS.ENVIRONMENT
          );

          const ceilingHit = context.physics.castRay(
            headOrigin,
            upDir,
            maxCheckHeight,
            true,
            undefined,
            envFilter,
            context.collider
          );

          if (ceilingHit) {
            // Ceiling detected above head - clamp hold height to sit right below the ceiling surface
            const clearance = ceilingHit.timeOfImpact;
            if (clearance < 0.45) {
              // Severely squished under low ceiling -> drop object safely
              this.dropObject(context);
              return;
            }
            targetHoldY = headOrigin.y + clearance - 0.35;
          }

          this.heldBody.setNextKinematicTranslation({
            x: charPos.x,
            y: targetHoldY,
            z: charPos.z,
          });
          this.heldBody.setNextKinematicRotation({ x: 0, y: qy, z: 0, w: qw });
        }
      } catch {
        this.dropObject(context);
      }
    }
  }

  public pickUp(context: CharacterContext): boolean {
    if (!this.enabled || this.isHolding) return false;

    const charPos = context.body.translation();
    const origin = new THREE.Vector3(charPos.x, charPos.y, charPos.z);

    const targetBody = context.physics.findNearestDynamicBody(
      origin,
      CARRY_CONFIG.PICKUP_RADIUS,
      context.body
    );

    if (!targetBody || !targetBody.isValid()) return false;
    if ((targetBody as any).isVehicle || (targetBody.userData as any)?.isVehicle) return false;

    try {
      // Calculate current facing quaternion for character
      let qy = 0;
      let qw = 1;
      if (this.getFacingAngle) {
        const angle = this.getFacingAngle();
        const halfAngle = angle * 0.5;
        qy = Math.sin(halfAngle);
        qw = Math.cos(halfAngle);
      }

      // 1. Modify collider collision group on target body so it doesn't collide with character or environment while held
      if (targetBody.numColliders() > 0) {
        const collider = targetBody.collider(0);
        this.savedCollisionGroups = collider.collisionGroups();
        const ignoreCharFilter = context.physics.packCollisionGroups(
          COLLISION_GROUPS.DYNAMIC_PROPS,
          COLLISION_GROUPS.ENVIRONMENT
        );
        collider.setCollisionGroups(ignoreCharFilter);
      }

      // 2. Switch body type to KinematicPositionBased while held
      targetBody.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);

      // 3. Set initial translation and rotation
      const headPos = {
        x: charPos.x,
        y: charPos.y + CARRY_CONFIG.HOLD_HEIGHT_OFFSET,
        z: charPos.z,
      };
      targetBody.setTranslation(headPos, true);
      targetBody.setRotation({ x: 0, y: qy, z: 0, w: qw }, true);
      targetBody.wakeUp();

      this.heldBody = targetBody;
      this.isHolding = true;

      if (this.onPickUp) {
        this.onPickUp(targetBody);
      }

      return true;
    } catch (err) {
      console.warn('[CarryAbility] Failed to pick up object:', err);
      this.dropObject(context);
      return false;
    }
  }

  public throwObject(context: CharacterContext): boolean {
    if (!this.isHolding || !this.heldBody) return false;

    const bodyToThrow = this.heldBody;

    try {
      // 1. Restore body type to Dynamic
      if (bodyToThrow.isValid()) {
        bodyToThrow.setBodyType(RAPIER.RigidBodyType.Dynamic, true);

        // 2. Restore original collision groups
        if (bodyToThrow.numColliders() > 0 && this.savedCollisionGroups !== null) {
          bodyToThrow.collider(0).setCollisionGroups(this.savedCollisionGroups);
          this.savedCollisionGroups = null;
        }

        // 3. Calculate throw vector using character facing direction
        let facingDir = new THREE.Vector3(0, 0, 1);
        if (this.getFacingDirection) {
          facingDir = this.getFacingDirection();
        } else if (context.cameraForward) {
          facingDir = context.cameraForward.clone();
          facingDir.y = 0;
          facingDir.normalize();
        }

        const throwDir = new THREE.Vector3(
          facingDir.x,
          CARRY_CONFIG.THROW_UPWARD_ANGLE,
          facingDir.z
        ).normalize();

        // 4. Set velocity / impulse to thrown body
        const speed = CARRY_CONFIG.THROW_FORCE;
        const charVel = context.body.linvel();
        bodyToThrow.setLinvel(
          {
            x: charVel.x + throwDir.x * speed,
            y: Math.max(0, charVel.y) + throwDir.y * speed,
            z: charVel.z + throwDir.z * speed,
          },
          true
        );

        bodyToThrow.setAngvel(
          {
            x: (Math.random() - 0.5) * 12,
            y: (Math.random() - 0.5) * 12,
            z: (Math.random() - 0.5) * 12,
          },
          true
        );

        bodyToThrow.wakeUp();
      }

      this.isHolding = false;
      this.heldBody = null;

      if (this.onThrow) {
        this.onThrow(bodyToThrow);
      }

      return true;
    } catch (err) {
      console.warn('[CarryAbility] Failed to throw object:', err);
      this.dropObject(context);
      return false;
    }
  }

  public dropObject(context?: CharacterContext): void {
    if (!this.isHolding && !this.heldBody) return;

    try {
      if (this.heldBody && this.heldBody.isValid()) {
        this.heldBody.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        if (this.heldBody.numColliders() > 0 && this.savedCollisionGroups !== null) {
          this.heldBody.collider(0).setCollisionGroups(this.savedCollisionGroups);
        }
        this.heldBody.wakeUp();
      }
    } catch {
      // Ignore
    }

    this.heldBody = null;
    this.isHolding = false;
    this.savedCollisionGroups = null;

    if (this.onDrop) {
      this.onDrop();
    }
  }

  public cleanup(): void {
    this.dropObject();
  }
}
