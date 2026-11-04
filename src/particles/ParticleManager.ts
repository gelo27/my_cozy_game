import * as THREE from 'three';
import { CHARACTER_CONFIG } from '../config/constants';

interface Particle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  scale: number;
  initialScale: number;
  maxLife: number;
  life: number;
  active: boolean;
  color: THREE.Color;
}

const DIRT_COLORS = [new THREE.Color('#5b3a1e'), new THREE.Color('#7a4f2a'), new THREE.Color('#3e2714'), new THREE.Color('#8d6239')];

export class ParticleManager {
  public group: THREE.Group;
  private maxParticles = CHARACTER_CONFIG.PARTICLE_MAX_COUNT;
  private particles: Particle[] = [];
  private instancedMesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private baseColor = new THREE.Color('#ffffff'); // Pure white 3D sphere cloud puff
  private sprintColor = new THREE.Color('#ffffff'); // Pure white energetic cloud puff

  // Walk/Sprint emission timer
  private dustTimer: number = 0;

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = 'ParticleSystem_Dust';

    // Real 3D Sphere geometry for the player's dust particles
    // 8x8 segments (64 vertices) for high-performance rendering on mobile & desktop
    const geometry = new THREE.SphereGeometry(1.0, 8, 8);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: false,
      depthWrite: true,
    });

    this.instancedMesh = new THREE.InstancedMesh(geometry, material, this.maxParticles);
    this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.instancedMesh.frustumCulled = false; // Prevent frustum culling from hiding particles when camera rotates
    this.instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(this.maxParticles * 3),
      3
    );
    this.instancedMesh.count = 0;
    this.group.add(this.instancedMesh);

    scene.add(this.group);

    // Preallocate particle pool
    for (let i = 0; i < this.maxParticles; i++) {
      this.particles.push({
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        scale: 0.1,
        initialScale: 0.1,
        maxLife: 0.4,
        life: 0,
        active: false,
        color: new THREE.Color(this.baseColor),
      });
    }
  }

  private spawnParticle(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    scale: number,
    lifetime: number,
    color: THREE.Color
  ): void {
    // 1. Priority: Find an inactive particle
    let p = this.particles.find((item) => !item.active);

    // 2. Fallback: Recycle particle closest to death (smallest remaining life)
    if (!p) {
      let minLife = Infinity;
      let oldestIndex = 0;
      for (let i = 0; i < this.particles.length; i++) {
        if (this.particles[i].life < minLife) {
          minLife = this.particles[i].life;
          oldestIndex = i;
        }
      }
      p = this.particles[oldestIndex];
    }

    p.position.set(x, y, z);
    p.velocity.set(vx, vy, vz);
    p.scale = scale;
    p.initialScale = scale;
    p.maxLife = lifetime;
    p.life = lifetime;
    p.active = true;
    p.color.copy(color);
  }

  /**
   * Emits dust when walking or sprinting on the ground
   */
  public updateLocomotionDust(
    dt: number,
    feetPosition: THREE.Vector3,
    movementVelocity: THREE.Vector3,
    isGrounded: boolean,
    isSprinting: boolean
  ): void {
    if (!isSprinting) {
      this.dustTimer = 0;
      return;
    }

    const interval = CHARACTER_CONFIG.DUST_SPRINT_INTERVAL;

    if (!isGrounded) {
      // Keep timer primed to the interval so that we emit immediately on landing
      this.dustTimer = interval;
      return;
    }

    const horizontalSpeed = Math.sqrt(
      movementVelocity.x * movementVelocity.x + movementVelocity.z * movementVelocity.z
    );

    if (horizontalSpeed < 0.5) {
      // Keep timer primed to the interval so that we emit immediately on starting movement
      this.dustTimer = interval;
      return;
    }

    this.dustTimer += dt;
    if (this.dustTimer >= interval) {
      this.dustTimer = 0;
      this.emitDust(feetPosition, movementVelocity, isSprinting);
    }
  }

  /**
   * Emit individual 3D white sphere dust puff behind the feet
   */
  public emitDust(feetPosition: THREE.Vector3, moveVel: THREE.Vector3, isSprinting: boolean): void {
    const count = isSprinting ? 2 : 1;
    const color = isSprinting ? this.sprintColor : this.baseColor;
    const baseScale = isSprinting ? 0.22 : 0.15;

    for (let i = 0; i < count; i++) {
      // Offset slightly behind the character's movement direction
      const randomOffset = (Math.random() - 0.5) * 0.2;
      const x = feetPosition.x - moveVel.x * 0.04 + randomOffset;
      const y = feetPosition.y + 0.06 + Math.random() * 0.06;
      const z = feetPosition.z - moveVel.z * 0.04 + (Math.random() - 0.5) * 0.2;

      const vx = -moveVel.x * 0.12 + (Math.random() - 0.5) * 0.6;
      const vy = 0.3 + Math.random() * 0.1;
      const vz = -moveVel.z * 0.12 + (Math.random() - 0.5) * 0.6;

      // Long sustained lifetime (1.0 to 1.4 seconds)
      const lifetime = 0.1 + Math.random() * 0.1;
      this.spawnParticle(x, y, z, vx, vy, vz, baseScale * (0.85 + Math.random() * 0.3), lifetime, color);
    }
  }

  /**
   * Emit ring of 3D white spheres when jumping off the ground
   */
  public emitJumpDust(feetPosition: THREE.Vector3): void {
    const count = CHARACTER_CONFIG.DUST_JUMP_COUNT;
    const color = this.sprintColor;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const speed = 1.6 + Math.random() * 1.0;
      const vx = Math.cos(angle) * speed;
      const vz = Math.sin(angle) * speed;
      const vy = 0.5 + Math.random() * 0.6;

      const x = feetPosition.x + Math.cos(angle) * 0.15;
      const y = feetPosition.y + 0.08;
      const z = feetPosition.z + Math.sin(angle) * 0.15;

      // Sustained lifetime (1.1 to 1.5 seconds)
      const lifetime = 0.3 + Math.random() * 0.2;
      const scale = 0.25 * (0.85 + Math.random() * 0.3); // max 0.30m
      this.spawnParticle(x, y, z, vx, vy, vz, scale, lifetime, color);
    }
  }

  /**
   * Emit radial burst of 3D white spheres upon landing on the ground
   */
  public emitLandDust(feetPosition: THREE.Vector3, impactSpeed: number): void {
    const intensity = Math.min(Math.abs(impactSpeed) / 7.0, 2.0);
    const count = Math.round(CHARACTER_CONFIG.DUST_LAND_COUNT * Math.max(0.7, intensity));
    const color = this.baseColor;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const speed = (1.4 + Math.random() * 1.6) * Math.max(0.7, intensity);
      const vx = Math.cos(angle) * speed;
      const vz = Math.sin(angle) * speed;
      const vy = 0.4 + Math.random() * 0.7;

      const x = feetPosition.x + Math.cos(angle) * 0.18;
      const y = feetPosition.y + 0.08;
      const z = feetPosition.z + Math.sin(angle) * 0.18;

      // Long sustained lifetime (1.2 to 1.6 seconds)
      const lifetime = 0.3 + Math.random() * 0.2;
      // Max radius up to 0.35m (size of character's head)
      const scale = 0.28 * Math.min(1.25, Math.max(0.8, intensity)) * (0.85 + Math.random() * 0.3);
      this.spawnParticle(x, y, z, vx, vy, vz, scale, lifetime, color);
    }
  }

  public emitSplash(position: THREE.Vector3, count: number = 14): void {
    const waterColor = new THREE.Color('#38bdf8');
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.6 + Math.random() * 1.6;
      const vx = Math.cos(angle) * speed;
      const vz = Math.sin(angle) * speed;
      const vy = 1.0 + Math.random() * 2.2;
      const scale = 0.08 + Math.random() * 0.08;
      const lifetime = 0.25 + Math.random() * 0.25;
      this.spawnParticle(position.x, position.y + 0.15, position.z, vx, vy, vz, scale, lifetime, waterColor);
    }
  }

  /**
   * Continuous sparkling water stream sprinkling down from the watering can
   */
  public emitWateringStream(nozzlePos: THREE.Vector3, forwardDir: THREE.Vector3, count: number = 4): void {
    const waterColors = [
      new THREE.Color('#38bdf8'), // Sky Cyan
      new THREE.Color('#7dd3fc'), // Light blue
      new THREE.Color('#e0f2fe'), // White sparkle
    ];

    for (let i = 0; i < count; i++) {
      const spread = 0.25;
      const speed = 1.4 + Math.random() * 0.8;
      const vx = forwardDir.x * speed + (Math.random() - 0.5) * spread;
      const vy = -1.2 - Math.random() * 1.4; // Arc downward towards soil
      const vz = forwardDir.z * speed + (Math.random() - 0.5) * spread;

      const scale = 0.06 + Math.random() * 0.04;
      const lifetime = 0.40 + Math.random() * 0.20;
      const color = waterColors[Math.floor(Math.random() * waterColors.length)];

      this.spawnParticle(
        nozzlePos.x + (Math.random() - 0.5) * 0.04,
        nozzlePos.y + (Math.random() - 0.5) * 0.04,
        nozzlePos.z + (Math.random() - 0.5) * 0.04,
        vx,
        vy,
        vz,
        scale,
        lifetime,
        color
      );
    }
  }

  /** Pink / red puffs rising up, used for petting animals. */
  public emitHearts(position: THREE.Vector3, count: number = 8): void {
    const colors = [new THREE.Color('#ff6fa5'), new THREE.Color('#ff3d71'), new THREE.Color('#ffd1e3')];
    for (let i = 0; i < count; i++) {
      this.spawnParticle(
        position.x + (Math.random() - 0.5) * 0.5,
        position.y + Math.random() * 0.3,
        position.z + (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5,
        1.2 + Math.random() * 0.8,
        (Math.random() - 0.5) * 0.5,
        0.07 + Math.random() * 0.05,
        0.7 + Math.random() * 0.4,
        colors[i % colors.length]
      );
    }
  }

  /**
   * Wood splinters and chips flying off a tree trunk
   */
  public emitWoodSplinters(hitPoint: THREE.Vector3, normal: THREE.Vector3, count: number = 20): void {
    const woodColors = [
      new THREE.Color('#8B5A2B'), // Warm oak
      new THREE.Color('#D2B48C'), // Tan wood interior
      new THREE.Color('#CD853F'), // Peru amber
      new THREE.Color('#5C4033'), // Dark bark brown
      new THREE.Color('#F4A460'), // Sandy wood chip
    ];

    for (let i = 0; i < count; i++) {
      const spread = 4.2;
      const vx = normal.x * 3.0 + (Math.random() - 0.5) * spread;
      const vy = 1.2 + Math.random() * 2.6;
      const vz = normal.z * 3.0 + (Math.random() - 0.5) * spread;
      const scale = 0.05 + Math.random() * 0.07;
      const lifetime = 0.35 + Math.random() * 0.35;
      const color = woodColors[Math.floor(Math.random() * woodColors.length)];
      this.spawnParticle(
        hitPoint.x + normal.x * 0.06,
        hitPoint.y + normal.y * 0.06,
        hitPoint.z + normal.z * 0.06,
        vx, vy, vz,
        scale,
        lifetime,
        color
      );
    }
  }

  /**
   * Leaves drifting down from the canopy when a tree is hit or falls
   */
  public emitTreeFoliageLeaves(position: THREE.Vector3, count: number = 16): void {
    const leafColors = [
      new THREE.Color('#2f7d32'),
      new THREE.Color('#43a047'),
      new THREE.Color('#7cb342'),
      new THREE.Color('#c0ca33'),
    ];

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 2.2;
      const speed = 0.4 + Math.random() * 0.9;
      const vx = Math.cos(angle) * speed;
      const vy = 0.2 + Math.random() * 0.8;
      const vz = Math.sin(angle) * speed;
      const scale = 0.07 + Math.random() * 0.06;
      const lifetime = 0.8 + Math.random() * 0.7;
      const color = leafColors[Math.floor(Math.random() * leafColors.length)];
      this.spawnParticle(
        position.x + Math.cos(angle) * radius,
        position.y + 1.5 + Math.random() * 2.5,
        position.z + Math.sin(angle) * radius,
        vx, vy, vz,
        scale,
        lifetime,
        color
      );
    }
  }

  /**
   * Update particle simulation step
   */
  public update(dt: number): void {


    let activeCount = 0;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }

      // Progress normalized (1 at birth, 0 at death)
      const progress = p.life / p.maxLife;
      const age = 1.0 - progress; // 0 at birth, 1 at death

      // Soft air drag + gentle thermal rise
      p.velocity.x *= Math.max(0, 1 - 2.8 * dt);
      p.velocity.z *= Math.max(0, 1 - 2.8 * dt);
      p.velocity.y += 0.25 * dt;

      p.position.x += p.velocity.x * dt;
      p.position.y += p.velocity.y * dt;
      p.position.z += p.velocity.z * dt;

      // Smooth, long-sustained visibility scale curve:
      // Phase 1 (0 to 12% age): Quick pop-in expansion (0.2 -> 1.0)
      // Phase 2 (12% to 75% age): Sustained full 3D sphere visibility (1.0 -> 0.85)
      // Phase 3 (75% to 100% age): Smooth fade shrinkage at the very end of life (0.85 -> 0.0)
      let scaleMult = 1.0;
      if (age < 0.12) {
        scaleMult = THREE.MathUtils.lerp(0.2, 1.0, age / 0.12);
      } else if (age < 0.75) {
        scaleMult = THREE.MathUtils.lerp(1.0, 0.85, (age - 0.12) / 0.63);
      } else {
        scaleMult = THREE.MathUtils.lerp(0.85, 0.0, (age - 0.75) / 0.25);
      }

      const currentScale = Math.max(0.001, p.initialScale * scaleMult);

      this.dummy.position.copy(p.position);
      this.dummy.scale.set(currentScale, currentScale, currentScale);
      this.dummy.rotation.x += dt * 1.0;
      this.dummy.rotation.y += dt * 1.5;
      this.dummy.updateMatrix();

      this.instancedMesh.setMatrixAt(activeCount, this.dummy.matrix);
      this.instancedMesh.setColorAt(activeCount, p.color);
      activeCount++;
    }

    this.instancedMesh.count = activeCount;
    if (activeCount > 0) {
      this.instancedMesh.instanceMatrix.needsUpdate = true;
      if (this.instancedMesh.instanceColor) {
        this.instancedMesh.instanceColor.needsUpdate = true;
      }
    }
  }

  public dispose(): void {
    if (this.instancedMesh) {
      this.instancedMesh.geometry.dispose();
      if (Array.isArray(this.instancedMesh.material)) {
        this.instancedMesh.material.forEach((m) => m.dispose());
      } else {
        this.instancedMesh.material.dispose();
      }
      this.group.remove(this.instancedMesh);
    }
  }

  /** Clods of soil thrown up by the shovel or when sowing a field. */
  public emitDirtClods(position: THREE.Vector3, count: number = 10): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.6 + Math.random() * 1.4;
      this.spawnParticle(
        position.x + (Math.random() - 0.5) * 0.3,
        position.y + 0.08,
        position.z + (Math.random() - 0.5) * 0.3,
        Math.cos(angle) * speed,
        1.6 + Math.random() * 1.8,
        Math.sin(angle) * speed,
        0.09 + Math.random() * 0.09,
        0.45 + Math.random() * 0.3,
        DIRT_COLORS[(Math.random() * DIRT_COLORS.length) | 0]
      );
    }
  }

  /**
   * Radial dust and sawdust cloud when placing or deconstructing building components
   */
  public emitBuildPuff(position: THREE.Vector3, isWood: boolean = true, count: number = 18): void {
    const colors = isWood
      ? [new THREE.Color('#8B5A2B'), new THREE.Color('#D2B48C'), new THREE.Color('#fcd34d'), new THREE.Color('#e2e8f0')]
      : [new THREE.Color('#64748b'), new THREE.Color('#94a3b8'), new THREE.Color('#cbd5e1'), new THREE.Color('#ffffff')];

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const speed = 1.4 + Math.random() * 1.8;
      const vx = Math.cos(angle) * speed;
      const vz = Math.sin(angle) * speed;
      const vy = 0.6 + Math.random() * 1.4;

      const scale = 0.18 * (0.7 + Math.random() * 0.6);
      const lifetime = 0.35 + Math.random() * 0.25;
      const color = colors[Math.floor(Math.random() * colors.length)];

      this.spawnParticle(
        position.x + (Math.random() - 0.5) * 0.4,
        position.y + 0.1,
        position.z + (Math.random() - 0.5) * 0.4,
        vx,
        vy,
        vz,
        scale,
        lifetime,
        color
      );
    }
  }
}

