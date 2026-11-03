import { worldSettings } from '../../world/WorldSettings';
import * as THREE from 'three';
import { IAbility, CharacterContext } from './IAbility';
import { OXYGEN_CONFIG, WATER_PHYSICS_CONFIG } from '../../config/constants';
import { audioEngine } from '../../audio/AudioEngine';
import { WaterParticleSystem } from '../../particles/WaterParticleSystem';

export class OxygenAbility implements IAbility {
  public name = 'Oxygen';
  public enabled = true;

  public currentOxygen: number = OXYGEN_CONFIG.MAX_OXYGEN;
  public maxOxygen: number = OXYGEN_CONFIG.MAX_OXYGEN;
  
  public isUnderwater: boolean = false;
  public isDrowning: boolean = false;
  public justRefilled: boolean = false;
  public refillFlashTimer: number = 0;

  public waterParticles: WaterParticleSystem | null = null;

  private warningPulseTimer: number = 0;
  private drownBubbleTimer: number = 0;
  private wasUnderwater: boolean = false;
  private hadLowOxygen: boolean = false;

  public reset(): void {
    this.currentOxygen = this.maxOxygen;
    this.isUnderwater = false;
    this.isDrowning = false;
    this.warningPulseTimer = 0;
    this.drownBubbleTimer = 0;
    this.wasUnderwater = false;
    this.hadLowOxygen = false;
  }

  /**
   * Replenishes oxygen from an external source such as underwater vents
   */
  public addOxygen(amount: number): void {
    const prev = this.currentOxygen;
    this.currentOxygen = Math.min(this.maxOxygen, this.currentOxygen + amount);
    if (this.currentOxygen > OXYGEN_CONFIG.WARNING_THRESHOLD) {
      this.hadLowOxygen = false;
      this.isDrowning = false;
    }
    if (prev < this.maxOxygen && this.currentOxygen >= this.maxOxygen) {
      this.justRefilled = true;
      this.refillFlashTimer = OXYGEN_CONFIG.FULL_RECOVERY_FLASH_DURATION;
      audioEngine.playOxygenReplenished();
    }
  }

  public update(dt: number, context: CharacterContext): void {
    if (!this.enabled) {
      this.currentOxygen = this.maxOxygen;
      context.oxygen = this.maxOxygen;
      context.maxOxygen = this.maxOxygen;
      context.oxygenRatio = 1.0;
      context.isUnderwater = false;
      context.isDrowning = false;
      return;
    }

    const pos = context.body.translation();
    const vel = context.body.linvel();
    
    // Head position is approx 0.45m above capsule center
    const headY = pos.y + 0.45;
    
    // Check if character's head is submerged under water surface
    const isSubmerged = context.isSwimming && (headY < worldSettings.waterLevel - 0.05 || context.swimDepth > 0.15);
    this.isUnderwater = isSubmerged;
    context.isUnderwater = this.isUnderwater;

    if (this.isUnderwater) {
      // 1. DEPLETION LOGIC
      // Faster depletion if sprinting or dashing
      const isFastMovement = context.isSprinting || context.isDashing || Math.sqrt(vel.x * vel.x + vel.z * vel.z) > 4.0;
      const rate = isFastMovement ? OXYGEN_CONFIG.SPRINT_DEPLETION_RATE : OXYGEN_CONFIG.BASE_DEPLETION_RATE;
      
      this.currentOxygen = Math.max(0, this.currentOxygen - rate * dt);

      if (this.currentOxygen <= OXYGEN_CONFIG.WARNING_THRESHOLD) {
        this.hadLowOxygen = true;
      }

      // Warning Audio Pulses
      if (this.currentOxygen > 0 && this.currentOxygen <= OXYGEN_CONFIG.WARNING_THRESHOLD) {
        const isCritical = this.currentOxygen <= OXYGEN_CONFIG.CRITICAL_THRESHOLD;
        const pulseInterval = isCritical ? 0.45 : 0.85;

        this.warningPulseTimer += dt;
        if (this.warningPulseTimer >= pulseInterval) {
          this.warningPulseTimer = 0;
          audioEngine.playOxygenPulse(isCritical);
        }
      } else {
        this.warningPulseTimer = 0;
      }

      // Drowning condition: Oxygen reached 0
      if (this.currentOxygen <= 0.01) {
        this.isDrowning = true;
        this.drownBubbleTimer += dt;

        // Emit panic bubbles from head
        if (this.drownBubbleTimer >= OXYGEN_CONFIG.DROWNING_BUBBLE_INTERVAL) {
          this.drownBubbleTimer = 0;
          if (this.waterParticles) {
            this.waterParticles.emitUnderwaterBubbles(
              new THREE.Vector3(pos.x, pos.y + 0.65, pos.z),
              new THREE.Vector3(vel.x * 0.3, 1.2, vel.z * 0.3),
              2
            );
          }
        }

        // Slight upward buoyancy struggle impulse when drowning
        if (vel.y < -0.5) {
          context.body.setLinvel({ x: vel.x * 0.95, y: -0.2, z: vel.z * 0.95 }, true);
        }
      } else {
        this.isDrowning = false;
      }

    } else {
      // 2. RECOVERY LOGIC (Surfaced or on land)
      this.isDrowning = false;
      this.warningPulseTimer = 0;

      // Surfaced breath sound if player was underwater with low oxygen
      if (this.wasUnderwater && this.hadLowOxygen) {
        audioEngine.playSurfacingBreath();
        this.hadLowOxygen = false;
      }

      // Fast replenishment
      if (this.currentOxygen < this.maxOxygen) {
        const prevOxygen = this.currentOxygen;
        this.currentOxygen = Math.min(this.maxOxygen, this.currentOxygen + OXYGEN_CONFIG.RECOVERY_RATE * dt);

        // Reached 100% full recovery
        if (prevOxygen < this.maxOxygen && this.currentOxygen >= this.maxOxygen) {
          this.justRefilled = true;
          this.refillFlashTimer = OXYGEN_CONFIG.FULL_RECOVERY_FLASH_DURATION;
          audioEngine.playOxygenReplenished();
        }
      }
    }

    if (this.refillFlashTimer > 0) {
      this.refillFlashTimer -= dt;
      if (this.refillFlashTimer <= 0) {
        this.justRefilled = false;
      }
    }

    this.wasUnderwater = this.isUnderwater;

    // Update Context
    context.oxygen = this.currentOxygen;
    context.maxOxygen = this.maxOxygen;
    context.oxygenRatio = this.currentOxygen / this.maxOxygen;
    context.isDrowning = this.isDrowning;
  }
}
