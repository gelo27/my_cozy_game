import * as THREE from 'three';
import { IAbility, CharacterContext } from './IAbility';
import { CHARACTER_CONFIG } from '../../config/constants';

export class DashAbility implements IAbility {
  public name = 'Dash';
  public enabled = true;

  public cooldownTimer: number = 0;
  public dashActiveTimer: number = 0;

  public update(dt: number, context: CharacterContext): void {
    if (!this.enabled) {
      context.isDashing = false;
      return;
    }

    if (this.cooldownTimer > 0) {
      this.cooldownTimer -= dt;
    }

    if (this.dashActiveTimer > 0) {
      this.dashActiveTimer -= dt;
      context.isDashing = true;
    } else {
      context.isDashing = false;
    }

    // Trigger dash
    if (context.input.dash && this.cooldownTimer <= 0) {
      this.executeDash(context);
    }
  }

  private executeDash(context: CharacterContext): void {
    const { body, cameraForward, cameraRight, input } = context;

    this.cooldownTimer = CHARACTER_CONFIG.DASH_COOLDOWN;
    this.dashActiveTimer = CHARACTER_CONFIG.DASH_DURATION;
    context.isDashing = true;
    body.setGravityScale(1.0, true);

    // Determine dash direction from movement input or forward camera facing
    const dashDir = new THREE.Vector3();
    if (Math.abs(input.forward) > 0.1 || Math.abs(input.right) > 0.1) {
      dashDir.addScaledVector(cameraForward, input.forward).addScaledVector(cameraRight, input.right);
    } else {
      dashDir.copy(cameraForward);
    }

    dashDir.y = 0;
    if (dashDir.lengthSq() < 0.001) {
      dashDir.set(0, 0, -1);
    } else {
      dashDir.normalize();
    }

    const mass = body.mass();
    const dashImpulse = dashDir.multiplyScalar(CHARACTER_CONFIG.DASH_IMPULSE * mass);

    // Give a slight upward hop if grounded to clear small steps
    if (context.ground.isGrounded) {
      dashImpulse.y = mass * 2.0;
    }

    if (Number.isFinite(dashImpulse.x) && Number.isFinite(dashImpulse.y) && Number.isFinite(dashImpulse.z)) {
      body.applyImpulse({ x: dashImpulse.x, y: dashImpulse.y, z: dashImpulse.z }, true);
      context.appliedImpulse.add(dashImpulse);
    }
  }
}
