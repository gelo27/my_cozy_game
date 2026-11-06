import * as THREE from 'three';
import { IAbility, CharacterContext } from './IAbility';
import { CHARACTER_CONFIG, COLLISION_GROUPS } from '../../config/constants';

/** Crouched capsule: 0.9 m instead of 1.5 m, feet where they were (the collider shifts down). */
const CROUCH_HALF_HEIGHT = 0.15;
const CROUCH_OFFSET = CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT - CROUCH_HALF_HEIGHT;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Crouch (C / Ctrl). The collider really gets lower, so the player fits through low crawlways in
 * the caves; letting go only stands up once there is headroom (otherwise they stay down).
 */
export class CrouchAbility implements IAbility {
  public name = 'Crouch';
  public enabled = true;
  private crouched = false;
  private filter = 0;
  private readonly origin = new THREE.Vector3();

  public update(_dt: number, context: CharacterContext): void {
    const wants = this.enabled && !context.isSwimming && context.input.crouch && context.ground.isGrounded;
    let crouch = wants;
    // Stay down under a low ceiling (also while sliding off a step in a crawlway)
    if (!crouch && this.crouched && this.enabled && !context.isSwimming && this.blockedAbove(context)) crouch = true;
    if (crouch !== this.crouched) this.setShape(context, crouch);
    context.isCrouching = crouch;
  }

  private blockedAbove(context: CharacterContext): boolean {
    if (!this.filter) {
      this.filter = context.physics.packCollisionGroups(COLLISION_GROUPS.CHARACTER, COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS);
    }
    const p = context.body.translation();
    const R = CHARACTER_CONFIG.CAPSULE_RADIUS * 0.8;
    // Centre and four points around the head: any hit within the standing height keeps us down
    const reach = CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT + CHARACTER_CONFIG.CAPSULE_RADIUS + 0.05 - (CROUCH_HALF_HEIGHT + CHARACTER_CONFIG.CAPSULE_RADIUS - CROUCH_OFFSET);
    for (const [dx, dz] of PROBES) {
      this.origin.set(p.x + dx * R, p.y + CROUCH_HALF_HEIGHT + CHARACTER_CONFIG.CAPSULE_RADIUS - CROUCH_OFFSET - 0.05, p.z + dz * R);
      if (context.physics.castRayAndGetNormal(this.origin, UP, reach, context.collider, this.filter)) return true;
    }
    return false;
  }

  private setShape(context: CharacterContext, crouch: boolean): void {
    this.crouched = crouch;
    const c = context.collider;
    c.setHalfHeight(crouch ? CROUCH_HALF_HEIGHT : CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT);
    c.setTranslationWrtParent({ x: 0, y: crouch ? -CROUCH_OFFSET : 0, z: 0 });
  }
}

const PROBES: [number, number][] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
