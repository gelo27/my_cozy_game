import { worldSettings } from '../world/WorldSettings';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BUOYANCY_CONFIG, WATER_FOG_CONFIG, WATER_PHYSICS_CONFIG, PHYSICS_CONFIG } from '../config/constants';
import { WaterEffects } from '../scene/WaterEffects';
import { WaterParticleSystem } from '../particles/WaterParticleSystem';

export interface BuoyantObject {
  id: string;
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  dimensions: THREE.Vector3; // x=width, y=height, z=depth (or radius)
  shape: 'box' | 'sphere' | 'cylinder';
  mass: number;
  wasSubmerged: boolean;
  previousVy: number;
}

export class BuoyancySystem {
  private objects: BuoyantObject[] = [];
  private time: number = 0;
  public waterEffects: WaterEffects | null = null;
  public waterParticles: WaterParticleSystem | null = null;

  constructor(waterEffects?: WaterEffects, waterParticles?: WaterParticleSystem) {
    if (waterEffects) this.waterEffects = waterEffects;
    if (waterParticles) this.waterParticles = waterParticles;
  }

  /**
   * Registers a dynamic physics body into the Archimedes buoyancy simulation
   */
  public registerBuoyantObject(
    body: RAPIER.RigidBody,
    mesh: THREE.Mesh,
    dimensions: THREE.Vector3,
    shape: 'box' | 'sphere' | 'cylinder' = 'box',
    mass: number = 10.0
  ): void {
    const id = THREE.MathUtils.generateUUID();
    this.objects.push({
      id,
      body,
      mesh,
      dimensions,
      shape,
      mass,
      wasSubmerged: false,
      previousVy: 0,
    });
  }

  public removeBuoyantObject(body: RAPIER.RigidBody): void {
    this.objects = this.objects.filter((obj) => obj.body !== body);
  }

  /**
   * Calculates dynamic water surface height at any (x, z) location including sinusoidal waves
   */
  public getWaterHeightAt(x: number, z: number): number {
    const wave =
      Math.sin(
        this.time * BUOYANCY_CONFIG.WAVE_FREQUENCY +
          x * BUOYANCY_CONFIG.WAVE_SPATIAL_SCALE +
          z * BUOYANCY_CONFIG.WAVE_SPATIAL_SCALE
      ) * BUOYANCY_CONFIG.WAVE_AMPLITUDE;
    return worldSettings.waterLevel + wave;
  }

  /**
   * Update step for buoyancy physics forces and wave dynamics
   */
  public update(dt: number): void {
    this.time += dt;
    const gravityMagnitude = Math.abs(PHYSICS_CONFIG.GRAVITY);

    for (let i = 0; i < this.objects.length; i++) {
      const item = this.objects[i];
      if (!item.body || !item.body.isValid()) continue;

      const pos = item.body.translation();
      const vel = item.body.linvel();
      const currentVy = vel.y;

      // Check if object is inside water volume horizontally
      const isInWaterBounds =
        pos.x >= WATER_FOG_CONFIG.BOUNDS_MIN_X - 1.0 &&
        pos.x <= WATER_FOG_CONFIG.BOUNDS_MAX_X + 1.0 &&
        pos.z >= WATER_FOG_CONFIG.BOUNDS_MIN_Z - 1.0 &&
        pos.z <= WATER_FOG_CONFIG.BOUNDS_MAX_Z + 1.0;

      if (!isInWaterBounds) {
        item.wasSubmerged = false;
        item.previousVy = currentVy;
        continue;
      }

      const totalHeight = item.dimensions.y;
      const halfHeight = totalHeight / 2;
      const bottomY = pos.y - halfHeight;
      const waterY = this.getWaterHeightAt(pos.x, pos.z);

      // Submerged depth
      const submergedDepth = Math.max(0, Math.min(totalHeight, waterY - bottomY));
      const submergedRatio = submergedDepth / totalHeight;

      if (submergedRatio > 0.01) {
        // Object just entered water with vertical impact speed -> Trigger Splash & Ripples
        if (!item.wasSubmerged && item.previousVy < -1.2) {
          const impactSpeed = Math.abs(item.previousVy);
          if (this.waterParticles) {
            this.waterParticles.emitWaterSplash(new THREE.Vector3(pos.x, waterY, pos.z), impactSpeed);
          }
          if (this.waterEffects) {
            this.waterEffects.emitRipple(pos.x, pos.z, impactSpeed * 0.45, 3.2);
          }
        }
        item.wasSubmerged = true;

        // 1. Archimedes Buoyant Upward Force
        // F = mass * g * submergedRatio * BUOYANCY_FORCE_SCALE
        const buoyantForce = item.mass * gravityMagnitude * submergedRatio * BUOYANCY_CONFIG.BUOYANCY_FORCE_SCALE;

        // 2. Vertical Water Resistance / Oscillation Damping
        const verticalDragForce = -vel.y * item.mass * BUOYANCY_CONFIG.VERTICAL_DAMPING * submergedRatio;

        // 3. Horizontal Linear Water Drag
        const horizDragX = -vel.x * item.mass * BUOYANCY_CONFIG.WATER_LINEAR_DRAG * submergedRatio;
        const horizDragZ = -vel.z * item.mass * BUOYANCY_CONFIG.WATER_LINEAR_DRAG * submergedRatio;

        // 4. Wave Torque / Pitch-Roll Stabilizer (prevents capsizing while bobbing)
        const angVel = item.body.angvel();
        const angDragX = -angVel.x * item.mass * BUOYANCY_CONFIG.WATER_ANGULAR_DRAG * dt * 0.5;
        const angDragY = -angVel.y * item.mass * BUOYANCY_CONFIG.WATER_ANGULAR_DRAG * dt * 0.5;
        const angDragZ = -angVel.z * item.mass * BUOYANCY_CONFIG.WATER_ANGULAR_DRAG * dt * 0.5;

        // Apply impulse to physics body
        const totalImpulseY = (buoyantForce + verticalDragForce) * dt;
        const totalImpulseX = horizDragX * dt;
        const totalImpulseZ = horizDragZ * dt;

        item.body.applyImpulse({ x: totalImpulseX, y: totalImpulseY, z: totalImpulseZ }, true);
        item.body.applyTorqueImpulse({ x: angDragX, y: angDragY, z: angDragZ }, true);

        // Gentle surface ripple when floating body moves horizontally
        const horizSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
        if (horizSpeed > 0.6 && Math.random() < 0.08 && this.waterEffects) {
          this.waterEffects.emitRipple(pos.x, pos.z, 0.4, 2.0);
        }
      } else {
        item.wasSubmerged = false;
      }

      item.previousVy = currentVy;
    }
  }
}
