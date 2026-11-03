import * as THREE from 'three';

// Check if mobile device
const isMobileDevice = (): boolean => {
  if (typeof navigator !== 'undefined') {
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
      return true;
    }
  }
  if (typeof window !== 'undefined' && window.innerWidth < 768) {
    return true;
  }
  return false;
};

export class MarineSnowSystem {
  public group: THREE.Group;
  private points: THREE.Points | null = null;
  private material!: THREE.ShaderMaterial;
  private count: number;
  private isMobile: boolean;
  private isUnderwaterActive: boolean = false;
  private maxRadius: number = 25.0;
  private maxRadiusSq: number = 25.0 * 25.0; // 625

  // Water volume bounds
  private minX = 50.0;
  private maxX = 140.0;
  private minY = -24.5;
  private maxY = -0.1;
  private minZ = -45.0;
  private maxZ = 45.0;

  // Throttle CPU positions update
  private updateAccumulator: number = 0;

  constructor(private scene: THREE.Scene) {
    this.isMobile = isMobileDevice();
    // 200 on mobile, 400 on desktop (concentrated inside 25m radius gives higher visual density while saving 70-85% performance)
    this.count = this.isMobile ? 200 : 400;

    this.group = new THREE.Group();
    this.group.name = 'MarineSnowSystem';
    this.scene.add(this.group);

    this.initParticles();
  }

  private initParticles(): void {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(this.count * 3);
    const randomScales = new Float32Array(this.count);
    const twinkleOffsets = new Float32Array(this.count);

    // Initial default positions (scattered in water center)
    const initCenter = new THREE.Vector3(95, -12, 0);
    for (let i = 0; i < this.count; i++) {
      this.scatterParticle(positions, i, initCenter);
      randomScales[i] = 0.6 + Math.random() * 1.8;
      twinkleOffsets[i] = Math.random() * Math.PI * 2;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(randomScales, 1));
    geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkleOffsets, 1));

    // Custom Shader for soft glowing plankton discs with bioluminescent twinkle, drift & 25m spherical radius fade
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uPlayerPos: { value: new THREE.Vector3(95, -12, 0) },
        uMaxRadius: { value: this.maxRadius },
        uColor1: { value: new THREE.Color(0xa5f3fc) }, // Soft bioluminescent ice cyan
        uColor2: { value: new THREE.Color(0x6ee7b7) }, // Plankton emerald glow
        uColor3: { value: new THREE.Color(0xffffff) }, // Crystalline marine snow white
      },
      vertexShader: `
        uniform float uTime;
        uniform vec3 uPlayerPos;
        uniform float uMaxRadius;
        attribute float aScale;
        attribute float aTwinkle;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec3 pos = position;

          // Gentle fluid drifting & wave currents
          float driftY = sin(uTime * 0.35 + aTwinkle) * 0.4;
          float driftX = sin(uTime * 0.25 + pos.y * 0.2 + aTwinkle) * 0.6;
          float driftZ = cos(uTime * 0.3 + pos.x * 0.2 + aTwinkle) * 0.6;

          pos.x += driftX;
          pos.y += driftY;
          pos.z += driftZ;

          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          
          // Perspective size attenuation
          gl_PointSize = (aScale * 36.0) / -mvPosition.z;
          gl_Position = projectionMatrix * mvPosition;

          // Distance fade: Smoothly fade out at edge of 25m radius around player
          float distToPlayer = distance(pos, uPlayerPos);
          float distFade = clamp(1.0 - (distToPlayer / uMaxRadius), 0.0, 1.0);

          // Bioluminescent twinkle factor
          float twinkle = sin(uTime * 2.2 + aTwinkle * 3.0) * 0.5 + 0.5;
          vAlpha = (0.35 + twinkle * 0.55) * distFade;

          // Plankton color variations
          if (aScale > 1.6) {
            vColor = vec3(0.65, 0.95, 1.0); // Cyan
          } else if (aScale > 1.1) {
            vColor = vec3(0.45, 0.9, 0.72); // Emerald
          } else {
            vColor = vec3(0.85, 0.92, 0.98); // Marine snow
          }
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          if (vAlpha < 0.01) discard;

          // Circular particle with soft radial falloff (glow disc)
          vec2 coord = gl_PointCoord - vec2(0.5);
          float dist = length(coord);
          if (dist > 0.5) discard;

          float intensity = pow(1.0 - (dist * 2.0), 1.6);
          gl_FragColor = vec4(vColor, intensity * vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false; // Initially hidden until player enters water
    this.group.add(this.points);
  }

  /**
   * Helper to spawn/re-wrap a single particle inside a 25m radius around target
   */
  private scatterParticle(positions: Float32Array, index: number, origin: THREE.Vector3): void {
    const idx = index * 3;
    
    // Uniform random point inside sphere of radius maxRadius (25)
    const u = Math.random();
    const r = this.maxRadius * Math.cbrt(u);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    let x = origin.x + r * Math.sin(phi) * Math.cos(theta);
    let y = origin.y + r * Math.sin(phi) * Math.sin(theta);
    let z = origin.z + r * Math.cos(phi);

    // Clamp strictly within water pool physical bounds
    x = Math.max(this.minX + 0.5, Math.min(this.maxX - 0.5, x));
    y = Math.max(this.minY + 0.5, Math.min(this.maxY - 0.2, y));
    z = Math.max(this.minZ + 0.5, Math.min(this.maxZ - 0.5, z));

    positions[idx + 0] = x;
    positions[idx + 1] = y;
    positions[idx + 2] = z;
  }

  /**
   * Checks if given coordinates are within underwater zone
   */
  private isPlayerUnderwater(pos: THREE.Vector3): boolean {
    return (
      pos.x >= this.minX && pos.x <= this.maxX &&
      pos.z >= this.minZ && pos.z <= this.maxZ &&
      pos.y <= 0.2
    );
  }

  public update(dt: number, playerPos?: THREE.Vector3): void {
    if (!this.points || !playerPos) return;

    const underwater = this.isPlayerUnderwater(playerPos);

    // If player is NOT underwater: hide plankton completely and do 0 processing
    if (!underwater) {
      if (this.isUnderwaterActive) {
        this.isUnderwaterActive = false;
        this.points.visible = false;
      }
      return;
    }

    // Player IS underwater:
    if (!this.isUnderwaterActive) {
      this.isUnderwaterActive = true;
      this.points.visible = true;

      // Re-center all particles around player within 25 radius
      const positions = this.points.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < this.count; i++) {
        this.scatterParticle(positions, i, playerPos);
      }
      this.points.geometry.attributes.position.needsUpdate = true;
    }

    if (this.material) {
      this.material.uniforms.uTime.value += dt;
      this.material.uniforms.uPlayerPos.value.set(playerPos.x, playerPos.y, playerPos.z);
    }

    // Throttle CPU position wrapping to 30Hz on mobile (0.033s) or 60Hz on desktop
    this.updateAccumulator += dt;
    const stepInterval = this.isMobile ? 0.033 : 0.016;
    if (this.updateAccumulator < stepInterval) return;

    const delta = this.updateAccumulator;
    this.updateAccumulator = 0;

    const positions = this.points.geometry.attributes.position.array as Float32Array;
    let needsBufferUpdate = false;

    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;
      const px = positions[idx + 0];
      const py = positions[idx + 1];
      const pz = positions[idx + 2];

      // Slight vertical downward drift
      positions[idx + 1] -= delta * 0.08;

      // Check distance squared to player
      const dx = px - playerPos.x;
      const dy = positions[idx + 1] - playerPos.y;
      const dz = pz - playerPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      // If particle exited 25m radius or water volume bounds, re-wrap it near the player
      if (
        distSq > this.maxRadiusSq ||
        positions[idx + 1] < this.minY ||
        positions[idx + 1] > this.maxY ||
        px < this.minX || px > this.maxX ||
        pz < this.minZ || pz > this.maxZ
      ) {
        this.scatterParticle(positions, i, playerPos);
        needsBufferUpdate = true;
      }
    }

    if (needsBufferUpdate) {
      this.points.geometry.attributes.position.needsUpdate = true;
    }
  }

  public dispose(): void {
    if (this.points) {
      this.points.geometry.dispose();
      this.material.dispose();
    }
    this.scene.remove(this.group);
  }
}

