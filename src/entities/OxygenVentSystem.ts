import * as THREE from 'three';
import { audioEngine } from '../audio/AudioEngine';

interface OxygenVent {
  position: THREE.Vector3;
  radius: number;
  height: number;
  meshGroup: THREE.Group;
}

interface BubbleSpriteData {
  sprite: THREE.Sprite;
  ventIndex: number;
  baseX: number;
  baseZ: number;
  y: number;
  speed: number;
  wobbleSpeed: number;
  wobbleOffset: number;
  wobbleRadius: number;
  scale: number;
  baseScale: number;
}

const _poolCenter = new THREE.Vector3(95, -12, 0);
const SLEEP_DIST_SQ = 70 * 70;
// Beyond 34m underwater, objects are fully enveloped in deep blue fog
const FOG_CULL_DIST = 34.0;
const FOG_CULL_DIST_SQ = FOG_CULL_DIST * FOG_CULL_DIST;

export class OxygenVentSystem {
  public group: THREE.Group;
  public vents: OxygenVent[] = [];
  private ventBubbles: BubbleSpriteData[][] = [];
  private bubbleTexture: THREE.Texture;
  private bubbleMaterial: THREE.SpriteMaterial;
  private totalBubbles: number = 180; // Restored original rich bubble stream count (36 per vent)
  private soundCooldown = 0;
  private refillAuraGroup: THREE.Group;
  private auraRing: THREE.Mesh;
  private isVisible: boolean = true;
  private ventVisibilityStates: boolean[] = [];

  constructor(private scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = 'OxygenVentSystem';
    this.scene.add(this.group);

    this.bubbleTexture = this.createBubbleTexture();

    // 1. Fog-affected Bubble Material with Normal Blending & Fog Dissolve
    this.bubbleMaterial = new THREE.SpriteMaterial({
      map: this.bubbleTexture,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: THREE.NormalBlending,
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
          // Blend bubble color into the underwater fog color
          gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
          // Fade alpha smoothly as it penetrates deeper into the fog
          gl_FragColor.a *= clamp( 1.0 - smoothstep(0.25, 0.95, fogFactor), 0.0, 1.0 );
        #endif`
      );
    };

    // Refill visual aura ring around player
    this.refillAuraGroup = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(0.6, 0.85, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.auraRing = new THREE.Mesh(ringGeo, ringMat);
    this.refillAuraGroup.add(this.auraRing);
    this.scene.add(this.refillAuraGroup);

    this.initVents();
    this.initBubbleSprites();
  }

  private createBubbleTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;

    const centerX = 64;
    const centerY = 64;
    const radius = 56;

    // Translucent water bubble body
    const radialGlow = ctx.createRadialGradient(centerX, centerY, radius * 0.2, centerX, centerY, radius);
    radialGlow.addColorStop(0, 'rgba(186, 230, 253, 0.15)');
    radialGlow.addColorStop(0.65, 'rgba(125, 211, 252, 0.35)');
    radialGlow.addColorStop(0.88, 'rgba(224, 242, 254, 0.85)');
    radialGlow.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

    ctx.fillStyle = radialGlow;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fill();

    // Sharp outer rim highlight
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 3.0;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius - 2, 0, Math.PI * 2);
    ctx.stroke();

    // Main specular highlight (curved top-left gleam)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.beginPath();
    ctx.ellipse(centerX - 18, centerY - 18, 14, 8, -Math.PI / 4, 0, Math.PI * 2);
    ctx.fill();

    // Subtle bottom-right counter-reflection
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    ctx.ellipse(centerX + 16, centerY + 18, 7, 4, -Math.PI / 4, 0, Math.PI * 2);
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private initVents(): void {
    const ventPositions = [
      new THREE.Vector3(80, -24.8, -12),
      new THREE.Vector3(110, -24.8, -15),
      new THREE.Vector3(95, -24.8, 15),
      new THREE.Vector3(120, -24.8, 25),
      new THREE.Vector3(70, -24.8, 20),
    ];

    const ventStoneMat = new THREE.MeshLambertMaterial({
      color: 0x1e293b,
      flatShading: true,
    });

    const ventGlowMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.85,
    });

    ventPositions.forEach((pos) => {
      const ventGroup = new THREE.Group();
      ventGroup.position.copy(pos);

      // 1. Rocky cone crater base
      const baseGeo = new THREE.CylinderGeometry(0.8, 2.2, 1.6, 6);
      const baseMesh = new THREE.Mesh(baseGeo, ventStoneMat);
      baseMesh.position.y = 0.8;
      baseMesh.castShadow = false;
      ventGroup.add(baseMesh);

      // 2. Surrounding boulders
      for (let b = 0; b < 3; b++) {
        const angle = (b / 3) * Math.PI * 2 + 0.2;
        const bDist = 1.8;
        const rockGeo = new THREE.DodecahedronGeometry(0.6, 0);
        const rockMesh = new THREE.Mesh(rockGeo, ventStoneMat);
        rockMesh.position.set(Math.cos(angle) * bDist, 0.4, Math.sin(angle) * bDist);
        ventGroup.add(rockMesh);
      }

      // 3. Glowing vent nozzle
      const glowGeo = new THREE.CylinderGeometry(0.5, 0.2, 0.3, 6);
      const glowMesh = new THREE.Mesh(glowGeo, ventGlowMat);
      glowMesh.position.y = 1.5;
      ventGroup.add(glowMesh);

      this.group.add(ventGroup);

      this.vents.push({
        position: pos.clone(),
        radius: 2.8,
        height: 24.5,
        meshGroup: ventGroup,
      });

      this.ventVisibilityStates.push(true);
    });
  }

  private initBubbleSprites(): void {
    const bubblesPerVent = Math.floor(this.totalBubbles / this.vents.length); // 36 bubbles per vent

    this.vents.forEach((vent, ventIdx) => {
      const ventBubbleList: BubbleSpriteData[] = [];

      for (let i = 0; i < bubblesPerVent; i++) {
        const sprite = new THREE.Sprite(this.bubbleMaterial);
        const baseScale = 0.26 + Math.random() * 0.28;
        sprite.scale.set(baseScale, baseScale, 1.0);

        const initialY = -23.3 + (i / bubblesPerVent) * 22.5 + (Math.random() - 0.5) * 1.5;
        const offsetAngle = Math.random() * Math.PI * 2;
        const offsetR = Math.random() * 0.45;

        const bx = vent.position.x + Math.cos(offsetAngle) * offsetR;
        const bz = vent.position.z + Math.sin(offsetAngle) * offsetR;

        sprite.position.set(bx, initialY, bz);
        this.group.add(sprite);

        const bubbleData: BubbleSpriteData = {
          sprite,
          ventIndex: ventIdx,
          baseX: bx,
          baseZ: bz,
          y: initialY,
          speed: 1.6 + Math.random() * 1.2,
          wobbleSpeed: 2.5 + Math.random() * 3.0,
          wobbleOffset: Math.random() * Math.PI * 2,
          wobbleRadius: 0.08 + Math.random() * 0.12,
          scale: baseScale,
          baseScale,
        };

        ventBubbleList.push(bubbleData);
      }

      this.ventBubbles.push(ventBubbleList);
    });
  }

  public update(dt: number, playerPos: THREE.Vector3, onRefillOxygen?: (amount: number) => void): boolean {
    const distSq = playerPos.distanceToSquared(_poolCenter);
    if (distSq > SLEEP_DIST_SQ) {
      if (this.isVisible) {
        this.isVisible = false;
        this.group.visible = false;
      }
      return false;
    }
    if (!this.isVisible) {
      this.isVisible = true;
      this.group.visible = true;
    }

    if (this.soundCooldown > 0) {
      this.soundCooldown -= dt;
    }

    let isPlayerNearAnyVent = false;
    const time = performance.now() * 0.001;

    // Update each vent individually: if obscured by fog, pause simulation and hide bubbles
    for (let v = 0; v < this.vents.length; v++) {
      const vent = this.vents[v];
      const dx = playerPos.x - vent.position.x;
      const dz = playerPos.z - vent.position.z;
      const distSqVent = dx * dx + dz * dz;

      // Distance culling against underwater fog
      const isVisibleThroughFog = distSqVent <= FOG_CULL_DIST_SQ;

      if (!isVisibleThroughFog) {
        // Paused & hidden behind underwater fog
        if (this.ventVisibilityStates[v]) {
          this.ventVisibilityStates[v] = false;
          const bubbles = this.ventBubbles[v];
          for (let i = 0; i < bubbles.length; i++) {
            bubbles[i].sprite.visible = false;
          }
        }
        continue;
      }

      // Vent is within visible fog range -> activate and simulate
      if (!this.ventVisibilityStates[v]) {
        this.ventVisibilityStates[v] = true;
        const bubbles = this.ventBubbles[v];
        for (let i = 0; i < bubbles.length; i++) {
          bubbles[i].sprite.visible = true;
        }
      }

      // Check proximity for oxygen replenishment
      if (distSqVent < vent.radius * vent.radius && playerPos.y < 0.0 && playerPos.y > vent.position.y) {
        isPlayerNearAnyVent = true;
      }

      // Simulate rising bubbles for this active vent
      const bubbles = this.ventBubbles[v];
      for (let i = 0; i < bubbles.length; i++) {
        const b = bubbles[i];
        b.y += b.speed * dt;

        if (b.y > -0.3) {
          const offsetAngle = Math.random() * Math.PI * 2;
          const offsetR = Math.random() * 0.6;
          b.baseX = vent.position.x + Math.cos(offsetAngle) * offsetR;
          b.baseZ = vent.position.z + Math.sin(offsetAngle) * offsetR;
          b.y = vent.position.y + 1.6;
          b.speed = 1.8 + Math.random() * 1.4;
        }

        const currentWobble = Math.sin(time * b.wobbleSpeed + b.wobbleOffset) * b.wobbleRadius;
        const currentWobbleZ = Math.cos(time * (b.wobbleSpeed * 0.8) + b.wobbleOffset) * b.wobbleRadius;

        b.sprite.position.set(b.baseX + currentWobble, b.y, b.baseZ + currentWobbleZ);

        const depthRatio = Math.max(0, Math.min(1, (b.y + 24.0) / 24.0));
        let currentScale = b.baseScale * (1.0 + depthRatio * 0.6);

        // Smooth scale-fade near surface
        if (b.y > -1.5) {
          const fade = Math.max(0, (-0.3 - b.y) / 1.2);
          currentScale *= fade;
        }
        b.sprite.scale.set(currentScale, currentScale, 1.0);
      }
    }

    if (isPlayerNearAnyVent && playerPos.y < -0.2) {
      if (onRefillOxygen) {
        onRefillOxygen(180 * dt);
      }

      if (this.soundCooldown <= 0) {
        audioEngine.playOxygenReplenished();
        this.soundCooldown = 0.8;
      }

      this.refillAuraGroup.position.set(playerPos.x, playerPos.y - 0.3, playerPos.z);
      this.refillAuraGroup.rotation.y += dt * 3.0;
      const ringMat = this.auraRing.material as THREE.MeshBasicMaterial;
      ringMat.opacity = Math.min(0.85, ringMat.opacity + dt * 4.0);
      const ringScale = 1.0 + Math.sin(time * 8.0) * 0.15;
      this.auraRing.scale.set(ringScale, ringScale, ringScale);
    } else {
      const ringMat = this.auraRing.material as THREE.MeshBasicMaterial;
      if (ringMat.opacity > 0) {
        ringMat.opacity = Math.max(0, ringMat.opacity - dt * 4.0);
      }
    }

    return isPlayerNearAnyVent;
  }

  public dispose(): void {
    this.bubbleTexture.dispose();
    this.bubbleMaterial.dispose();
    this.scene.remove(this.group);
    this.scene.remove(this.refillAuraGroup);
  }
}
