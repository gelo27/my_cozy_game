import { worldSettings } from '../world/WorldSettings';
import * as THREE from 'three';
import { WATER_EFFECTS_CONFIG, WATER_PHYSICS_CONFIG } from '../config/constants';

interface SplashParticle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  scale: number;
  initialScale: number;
  maxLife: number;
  life: number;
  active: boolean;
  color: THREE.Color;
}

interface PlayerSpriteBubble {
  sprite: THREE.Sprite;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  wobbleSpeed: number;
  wobbleOffset: number;
  wobbleRadius: number;
  scale: number;
  baseScale: number;
  maxLife: number;
  life: number;
  active: boolean;
  /** Surface the bubble rises to (sea or river level where it was released). */
  surfaceY: number;
  material: THREE.SpriteMaterial;
}

export class WaterParticleSystem {
  public group: THREE.Group;

  // 1. Splash Particles (Droplets & spray beads)
  private splashParticles: SplashParticle[] = [];
  private splashInstancedMesh: THREE.InstancedMesh;
  private maxSplash = WATER_EFFECTS_CONFIG.MAX_SPLASH_PARTICLES;

  // 2. 2D Sprite Underwater Bubbles (Spawned from player head)
  private bubbleSprites: PlayerSpriteBubble[] = [];
  private bubbleTexture: THREE.Texture;
  private bubbleMaterial: THREE.SpriteMaterial;
  private maxBubbles = 60;

  private dummy = new THREE.Object3D();
  private splashColor = new THREE.Color('#e0f2fe'); // Crystalline ice-cyan white

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = 'WaterParticleSystem';
    scene.add(this.group);

    // Splash Mesh Setup (Small 3D spheres)
    const splashGeo = new THREE.SphereGeometry(1.0, 6, 6);
    const splashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
    });
    this.splashInstancedMesh = new THREE.InstancedMesh(splashGeo, splashMat, this.maxSplash);
    this.splashInstancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.splashInstancedMesh.frustumCulled = false;
    this.splashInstancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(this.maxSplash * 3),
      3
    );
    this.splashInstancedMesh.count = 0;
    this.group.add(this.splashInstancedMesh);

    // Splash particle pool
    for (let i = 0; i < this.maxSplash; i++) {
      this.splashParticles.push({
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        scale: 0.7,
        initialScale: 0.7,
        maxLife: 0.6,
        life: 0,
        active: false,
        color: new THREE.Color(this.splashColor),
      });
    }

    // 2. 2D Sprite Bubble Texture & Material Setup with underwater fog integration
    this.bubbleTexture = this.createBubbleTexture();
    this.bubbleMaterial = new THREE.SpriteMaterial({
      map: this.bubbleTexture,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: THREE.NormalBlending,
      opacity: 1.0,
    });

    this.bubbleMaterial.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
          #ifdef FOG_EXP2
            float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
          #else
            float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
          #endif
          gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
          gl_FragColor.a *= clamp( 1.0 - smoothstep(0.25, 0.95, fogFactor), 0.0, 1.0 );
        #endif`
      );
    };

    // Each bubble fades on its own, so each gets its own material (same shader program: the
    // clones share the compiled program, only the opacity uniform differs)
    for (let i = 0; i < this.maxBubbles; i++) {
      const material = this.bubbleMaterial.clone();
      material.onBeforeCompile = this.bubbleMaterial.onBeforeCompile;
      material.customProgramCacheKey = () => 'player-bubble';
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.scale.set(0.05, 0.05, 1.0);
      this.group.add(sprite);

      this.bubbleSprites.push({
        sprite,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        wobbleSpeed: 4.0,
        wobbleOffset: Math.random() * Math.PI * 2,
        wobbleRadius: 0.03 + Math.random() * 0.04,
        scale: 0.2,
        baseScale: 0.2,
        maxLife: 1.4,
        life: 0,
        active: false,
        surfaceY: worldSettings.waterLevel,
        material,
      });
    }
  }

  /**
   * Generates a crisp, glossy 2D sprite texture for underwater bubbles
   */
  private createBubbleTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;

    const centerX = 64;
    const centerY = 64;
    const radius = 56;

    // Outer subtle cyan glow
    const radialGlow = ctx.createRadialGradient(centerX, centerY, radius * 0.4, centerX, centerY, radius);
    radialGlow.addColorStop(0, 'rgba(56, 189, 248, 0.05)');
    radialGlow.addColorStop(0.7, 'rgba(186, 230, 253, 0.35)');
    radialGlow.addColorStop(0.9, 'rgba(224, 242, 254, 0.9)');
    radialGlow.addColorStop(1, 'rgba(14, 165, 233, 0.0)');

    ctx.fillStyle = radialGlow;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fill();

    // Sharp outer rim highlight
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius - 2, 0, Math.PI * 2);
    ctx.stroke();

    // Primary glossy specular highlight reflection
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.beginPath();
    ctx.ellipse(centerX - 18, centerY - 18, 14, 8, -Math.PI / 4, 0, Math.PI * 2);
    ctx.fill();

    // Secondary subtle rim reflection
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    ctx.ellipse(centerX + 16, centerY + 18, 7, 4, -Math.PI / 4, 0, Math.PI * 2);
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Spawns a multi-droplet vertical splash fountain & radial crown when hitting water from height
   */
  public emitWaterSplash(position: THREE.Vector3, impactSpeed: number): void {
    // Callers only splash where there is water (the sea, rivers, cave pools far outside the sea box)

    const intensity = Math.min(Math.abs(impactSpeed) / 8.0, 2.5);
    const count = Math.min(36, Math.round(14 * Math.max(0.6, intensity)));
    const surfaceY = worldSettings.waterLevel;

    // 1. Upward fountain central burst
    const centralCount = Math.round(count * 0.45);
    for (let i = 0; i < centralCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const horizSpeed = (0.8 + Math.random() * 1.5) * intensity;
      const vx = Math.cos(angle) * horizSpeed;
      const vz = Math.sin(angle) * horizSpeed;
      const vy = (3.5 + Math.random() * 4.5) * Math.max(0.7, intensity);

      const x = position.x + (Math.random() - 0.5) * 0.3;
      const y = surfaceY + 0.1 + Math.random() * 0.1;
      const z = position.z + (Math.random() - 0.5) * 0.3;

      const lifetime = 0.45 + Math.random() * 0.35;
      const scale = (0.12 + Math.random() * 0.12) * Math.min(1.6, intensity);

      this.spawnSplashParticle(x, y, z, vx, vy, vz, scale, lifetime, this.splashColor);
    }

    // 2. Expanding radial spray crown
    const crownCount = count - centralCount;
    for (let i = 0; i < crownCount; i++) {
      const angle = (i / crownCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
      const horizSpeed = (2.2 + Math.random() * 2.8) * Math.max(0.7, intensity);
      const vx = Math.cos(angle) * horizSpeed;
      const vz = Math.sin(angle) * horizSpeed;
      const vy = (1.5 + Math.random() * 2.5) * Math.max(0.6, intensity);

      const x = position.x + Math.cos(angle) * 0.25;
      const y = surfaceY + 0.08;
      const z = position.z + Math.sin(angle) * 0.25;

      const lifetime = 0.35 + Math.random() * 0.3;
      const scale = (0.09 + Math.random() * 0.08) * Math.min(1.4, intensity);

      this.spawnSplashParticle(x, y, z, vx, vy, vz, scale, lifetime, this.splashColor);
    }
  }

  private spawnSplashParticle(
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
    let p = this.splashParticles.find((item) => !item.active);
    if (!p) {
      let minLife = Infinity;
      let oldestIdx = 0;
      for (let i = 0; i < this.splashParticles.length; i++) {
        if (this.splashParticles[i].life < minLife) {
          minLife = this.splashParticles[i].life;
          oldestIdx = i;
        }
      }
      p = this.splashParticles[oldestIdx];
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
   * Spawns rising 2D sprite air bubbles from the player's head when moving underwater
   */
  public emitUnderwaterBubbles(
    headPosition: THREE.Vector3,
    velocity: THREE.Vector3,
    count: number = 2,
    surfaceY: number = worldSettings.waterLevel
  ): void {
    // Only spawn below the water surface (callers emit only in water: sea, rivers or cave pools)
    if (headPosition.y > surfaceY - 0.25) return;

    for (let i = 0; i < count; i++) {
      let b = this.bubbleSprites.find((item) => !item.active);
      if (!b) {
        let minLife = Infinity;
        let oldestIdx = 0;
        for (let j = 0; j < this.bubbleSprites.length; j++) {
          if (this.bubbleSprites[j].life < minLife) {
            minLife = this.bubbleSprites[j].life;
            oldestIdx = j;
          }
        }
        b = this.bubbleSprites[oldestIdx];
      }

      // Spawn around mouth/head with natural organic jitter
      const jitterX = (Math.random() - 0.5) * 0.35;
      const jitterY = (Math.random() - 0.5) * 0.2;
      const jitterZ = (Math.random() - 0.5) * 0.35;

      // Small natural bubbles (0.035m - 0.075m)
      const baseScale = 0.15 + Math.random() * 0.05;

      const vx = -velocity.x * 0.12 + (Math.random() - 0.5) * 0.2;
      const vy = 1.3 + Math.random() * 0.7; // Upward buoyant rise velocity
      const vz = -velocity.z * 0.12 + (Math.random() - 0.5) * 0.2;

      b.position.set(headPosition.x + jitterX, Math.min(headPosition.y + jitterY, surfaceY - 0.2), headPosition.z + jitterZ);
      b.surfaceY = surfaceY;
      b.velocity.set(vx, vy, vz);
      b.baseScale = baseScale;
      b.scale = baseScale;
      b.wobbleSpeed = 3.5 + Math.random() * 3.5;
      b.wobbleOffset = Math.random() * Math.PI * 2;
      b.wobbleRadius = 0.025 + Math.random() * 0.035;
      b.maxLife = 1.2 + Math.random() * 0.6;
      b.life = b.maxLife;
      b.active = true;

      b.sprite.position.copy(b.position);
      b.sprite.scale.set(baseScale, baseScale, 1.0);
      b.material.opacity = 0;
      b.sprite.visible = true;
    }
  }

  /**
   * Update particle simulation loops
   */
  public update(dt: number): void {
    // 1. Update Splash Particles (Gravity curve: g = -14.0 m/s^2)
    let activeSplash = 0;
    const gravityY = -14.0;

    for (let i = 0; i < this.splashParticles.length; i++) {
      const p = this.splashParticles[i];
      if (!p.active) continue;

      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }

      p.velocity.y += gravityY * dt;
      p.position.x += p.velocity.x * dt;
      p.position.y += p.velocity.y * dt;
      p.position.z += p.velocity.z * dt;

      // Shrink / pop upon reaching surface on way down
      if (p.position.y < worldSettings.waterLevel - 0.1 && p.velocity.y < 0) {
        p.active = false;
        continue;
      }

      const progress = p.life / p.maxLife;
      const currentScale = Math.max(0.001, p.initialScale * Math.sin(progress * Math.PI));

      this.dummy.position.copy(p.position);
      this.dummy.scale.set(currentScale, currentScale, currentScale);
      this.dummy.updateMatrix();

      this.splashInstancedMesh.setMatrixAt(activeSplash, this.dummy.matrix);
      this.splashInstancedMesh.setColorAt(activeSplash, p.color);
      activeSplash++;
    }

    this.splashInstancedMesh.count = activeSplash;
    if (activeSplash > 0) {
      this.splashInstancedMesh.instanceMatrix.needsUpdate = true;
      if (this.splashInstancedMesh.instanceColor) {
        this.splashInstancedMesh.instanceColor.needsUpdate = true;
      }
    }

    // 2. Update Underwater 2D Sprite Bubbles (Rising buoyant sprites with gentle wobble)
    const time = performance.now() * 0.001;
    for (let i = 0; i < this.bubbleSprites.length; i++) {
      const b = this.bubbleSprites[i];
      if (!b.active) {
        b.sprite.visible = false;
        continue;
      }

      b.life -= dt;
      if (b.life <= 0) {
        b.active = false;
        b.sprite.visible = false;
        continue;
      }

      // Buoyant rise and wobble
      const wobbleX = Math.sin(time * b.wobbleSpeed + b.wobbleOffset) * b.wobbleRadius;
      const wobbleZ = Math.cos(time * (b.wobbleSpeed * 0.8) + b.wobbleOffset) * b.wobbleRadius;

      b.position.x += b.velocity.x * dt;
      b.position.y += b.velocity.y * dt;
      b.position.z += b.velocity.z * dt;

      // Pop just below the surface (the water mesh's waves dip lower than the rest level)
      if (b.position.y >= b.surfaceY - 0.12) {
        b.active = false;
        b.sprite.visible = false;
        continue;
      }

      b.sprite.position.set(b.position.x + wobbleX, b.position.y, b.position.z + wobbleZ);

      // Scale expands slightly as it rises
      const lifeRatio = b.life / b.maxLife;
      const currentScale = b.baseScale * (1.0 + (1.0 - lifeRatio) * 0.35);
      b.sprite.scale.set(currentScale, currentScale, 1.0);

      // Quick fade in, fade out at the end of life and over the last half metre to the surface
      let opacity = 0.85 * Math.min(1, (b.maxLife - b.life) / 0.08);
      if (lifeRatio < 0.3) opacity *= lifeRatio / 0.3;
      const toSurface = b.surfaceY - 0.12 - b.position.y;
      if (toSurface < 0.5) opacity *= Math.max(0, toSurface / 0.5);
      b.material.opacity = opacity;
      b.sprite.visible = opacity > 0.01;
    }
  }

  public dispose(): void {
    if (this.splashInstancedMesh) {
      this.splashInstancedMesh.geometry.dispose();
      (this.splashInstancedMesh.material as THREE.Material).dispose();
      this.group.remove(this.splashInstancedMesh);
    }
    if (this.bubbleTexture) {
      this.bubbleTexture.dispose();
    }
    if (this.bubbleMaterial) {
      this.bubbleMaterial.dispose();
    }
    for (const b of this.bubbleSprites) {
      b.material.dispose();
      this.group.remove(b.sprite);
    }
    this.bubbleSprites = [];
  }
}
