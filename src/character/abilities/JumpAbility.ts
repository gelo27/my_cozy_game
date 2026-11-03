import { IAbility, CharacterContext } from './IAbility';
import { CHARACTER_CONFIG } from '../../config/constants';

export class JumpAbility implements IAbility {
  public name = 'Jump';
  public enabled = true;

  private coyoteTimer: number = 0;
  private jumpBufferTimer: number = 0;
  public isJumping: boolean = false;
  private jumpCooldownTimer: number = 0;

  // Callback hook for particles
  public onJumpTriggered?: () => void;

  public allowSteepSlopeJump: boolean = CHARACTER_CONFIG.ALLOW_STEEP_SLOPE_JUMP;

  public update(dt: number, context: CharacterContext): void {
    if (!this.enabled || context.isClimbing || context.isSwimming) return;

    const { input, ground, body } = context;

    // 1. Update Coyote timer
    const isSlopeValid = ground.isWalkableSlope || (ground.isGrounded && this.allowSteepSlopeJump);

    if (ground.isGrounded && isSlopeValid && !this.isJumping) {
      this.coyoteTimer = CHARACTER_CONFIG.COYOTE_TIME;
    } else {
      this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);
    }

    // 2. Update Jump Buffer timer
    if (input.jumpJustPressed) {
      this.jumpBufferTimer = CHARACTER_CONFIG.JUMP_BUFFER_TIME;
    } else {
      this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
    }

    if (this.jumpCooldownTimer > 0) {
      this.jumpCooldownTimer -= dt;
    }

    // 3. Jump Cut Force (Variable Jump Height):
    // If player releases jump button while still ascending, rapidly damp upward velocity
    const linvel = body.linvel();
    if (this.isJumping && !input.jump && linvel.y > 0) {
      const cutDamping = Math.exp(-context.jumpCutMultiplier * dt);
      const newY = linvel.y * cutDamping;
      if (Number.isFinite(linvel.x) && Number.isFinite(newY) && Number.isFinite(linvel.z)) {
        body.setLinvel({ x: linvel.x, y: newY, z: linvel.z }, true);
      }
    }

    // Reset jumping state when apex is reached and moving downward or grounded
    if (this.isJumping && linvel.y <= 0 && ground.isGrounded && this.jumpCooldownTimer <= 0) {
      this.isJumping = false;
    }

    // 4. Execute Jump when conditions are met
    const canJump = (this.coyoteTimer > 0) && (this.jumpBufferTimer > 0) && (this.jumpCooldownTimer <= 0);

    if (canJump) {
      this.executeJump(context);
    }

    context.isJumping = this.isJumping;
  }

  private executeJump(context: CharacterContext): void {
    const { body, ground } = context;

    // Reset timers
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.jumpCooldownTimer = 0.12; // Prevent multi-trigger in adjacent frames
    this.isJumping = true;

    // Ensure gravity is active for jump arc
    body.setGravityScale(1.0, true);

    // Set clean, responsive vertical & steep-slope launch velocity
    const currentVel = body.linvel();
    let launchY = context.jumpForce;
    let pushX = 0;
    let pushZ = 0;

    if (ground.isGrounded && !ground.isWalkableSlope && this.allowSteepSlopeJump) {
      // Launch off steep slope normal to pop player off wall/slope cleanly
      const norm = ground.normal;
      pushX = norm.x * context.jumpForce * 0.6;
      pushZ = norm.z * context.jumpForce * 0.6;
      launchY = Math.max(context.jumpForce * 0.85, norm.y * context.jumpForce + 3.0);
    }

    if (
      Number.isFinite(currentVel.x) &&
      Number.isFinite(launchY) &&
      Number.isFinite(currentVel.z)
    ) {
      body.setLinvel({ x: currentVel.x + pushX, y: launchY, z: currentVel.z + pushZ }, true);
      context.appliedImpulse.y += launchY * body.mass();
    }
    context.isJumping = true;

    if (this.onJumpTriggered) {
      this.onJumpTriggered();
    }
  }
}
