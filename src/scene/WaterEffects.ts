import * as THREE from 'three';
import { WATER_EFFECTS_CONFIG, WATER_PHYSICS_CONFIG, WATER_FOG_CONFIG } from '../config/constants';

interface Ripple {
  x: number;
  z: number;
  y: number;
  radius: number;
  maxRadius: number;
  strength: number;
  maxLife: number;
  life: number;
  active: boolean;
}

/**
 * Procedural fallback caustics texture generator (active until Caustic_Free.jpg loads or as backup)
 */
export class CausticsCookieGenerator {
  public canvas: HTMLCanvasElement | null = null;
  public ctx: CanvasRenderingContext2D | null = null;
  public texture: THREE.CanvasTexture | null = null;
  private width = 256;
  private height = 256;
  private imgData: ImageData | null = null;
  private buffer: Uint32Array | null = null;
  private isDisposed = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.imgData = this.ctx.createImageData(this.width, this.height);
    this.buffer = new Uint32Array(this.imgData.data.buffer);

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.repeat.set(4, 4);
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.update(0);
  }

  public update(time: number): void {
    if (this.isDisposed || !this.buffer || !this.ctx || !this.imgData || !this.texture) return;

    const w = this.width;
    const h = this.height;
    const buf = this.buffer;
    const t = time * 1.2;

    for (let y = 0; y < h; y++) {
      const ny = (y / h) * 6.28318;
      const rowOffset = y * w;
      for (let x = 0; x < w; x++) {
        const nx = (x / w) * 6.28318;

        const p1x = nx * 1.7 + Math.sin(t * 0.85 + ny * 1.8) * 0.45;
        const p1y = ny * 1.7 + Math.cos(t * 0.95 + nx * 1.8) * 0.45;
        const p2x = nx * 2.5 - Math.cos(t * 1.15 + ny * 2.3) * 0.35;
        const p2y = ny * 2.5 - Math.sin(t * 1.25 + nx * 2.3) * 0.35;

        const c1 = Math.sin(p1x * 2.8 + t) * Math.cos(p1y * 2.8 - t);
        const c2 = Math.cos(p2x * 3.4 - t * 1.2) * Math.sin(p2y * 3.4 + t * 1.2);

        let val = (c1 + c2) * 0.5 + 0.5;
        val = Math.pow(val, 3.8) * 3.0;
        if (val > 1.0) val = 1.0;
        else if (val < 0.0) val = 0.0;

        const r = Math.floor(val * 190);
        const g = Math.floor(val * 240);
        const b = Math.floor(val * 255);
        const a = 255;

        buf[rowOffset + x] = (a << 24) | (b << 16) | (g << 8) | r;
      }
    }

    this.ctx.putImageData(this.imgData, 0, 0);
    this.texture.needsUpdate = true;
  }

  public dispose(): void {
    this.isDisposed = true;
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
    this.canvas = null;
    this.ctx = null;
    this.imgData = null;
    this.buffer = null;
  }
}

export class WaterEffects {
  public group: THREE.Group;

  // Caustics Textures & State
  public causticsTexture: THREE.Texture;
  private fallbackGenerator: CausticsCookieGenerator | null = null;
  private isStaticTextureLoaded = false;
  private totalTime = 0;

  // Shared uniforms for custom shaders and material hooks
  public causticsUniforms: { [uniform: string]: THREE.IUniform };

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = 'WaterEffects_System';
    scene.add(this.group);

    // 1. Initialize Fallback Generator & Load Caustic_Free.jpg Texture
    this.fallbackGenerator = new CausticsCookieGenerator();
    this.causticsTexture = this.fallbackGenerator.texture!;

    this.causticsUniforms = {
      uCausticsTime: { value: 0 },
      uCausticsMap: { value: this.causticsTexture },
      uCausticsIntensity: { value: WATER_EFFECTS_CONFIG.CAUSTICS_INTENSITY },
      uCausticsCameraPos: { value: new THREE.Vector3(0, 10, 0) },
    };

    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
      '/Caustic_Free.jpg',
      (loadedTex) => {
        loadedTex.wrapS = THREE.RepeatWrapping;
        loadedTex.wrapT = THREE.RepeatWrapping;
        loadedTex.repeat.set(3, 3);
        loadedTex.generateMipmaps = true;
        loadedTex.minFilter = THREE.LinearMipmapLinearFilter;
        loadedTex.magFilter = THREE.LinearFilter;
        loadedTex.colorSpace = THREE.SRGBColorSpace;
        loadedTex.needsUpdate = true;

        this.causticsTexture = loadedTex;
        this.isStaticTextureLoaded = true;

        if (this.causticsUniforms.uCausticsMap) {
          this.causticsUniforms.uCausticsMap.value = loadedTex;
        }

        // Deallocate CPU Canvas generator since static texture is active
        if (this.fallbackGenerator) {
          this.fallbackGenerator.dispose();
          this.fallbackGenerator = null;
        }
      },
      undefined,
      (err) => {
        console.warn('[WaterEffects] Caustic_Free.jpg load notice, procedural fallback remains active:', err);
      }
    );
  }

  /**
   * Injects world-space caustics light projection into any standard material.
   * Optimizations included:
   * - Fast multi-tier Early Exits (Normal direction, Surface level, Camera radius, Volume AABB)
   * - Single-pass 3-sample Chromatic Aberration texture fetch (50% reduction in texture samples)
   * - Smooth distance fading into water fog to eliminate pop-in
   * - Smooth normal weighting (horizontal top surfaces full caustics, undercuts/walls 0)
   */
  public applyProjectedCaustics(material: THREE.Material): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uCausticsTime = this.causticsUniforms.uCausticsTime;
      shader.uniforms.uCausticsMap = this.causticsUniforms.uCausticsMap;
      shader.uniforms.uCausticsIntensity = this.causticsUniforms.uCausticsIntensity;
      shader.uniforms.uCausticsCameraPos = this.causticsUniforms.uCausticsCameraPos;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `
        #include <common>
        varying vec3 vWorldPosCaustics;
        varying vec3 vWorldNormalCaustics;
        `
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `
        #include <worldpos_vertex>
        vWorldPosCaustics = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWorldNormalCaustics = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `
        #include <common>
        varying vec3 vWorldPosCaustics;
        varying vec3 vWorldNormalCaustics;
        uniform float uCausticsTime;
        uniform sampler2D uCausticsMap;
        uniform float uCausticsIntensity;
        uniform vec3 uCausticsCameraPos;

        // High-performance caustics calculation with early exits, camera distance cull & chromatic aberration
        vec3 calculateProjectedCaustics(vec3 worldPos, vec3 worldNormal) {
          // 1. FAST EARLY EXIT: Normal orientation check
          // If surface normal points downward or is steep vertical, exit immediately
          if (worldNormal.y <= 0.04) {
            return vec3(0.0);
          }

          // 2. FAST EARLY EXIT: Surface height check (no caustics in the air above water)
          if (worldPos.y > ${WATER_PHYSICS_CONFIG.SURFACE_Y.toFixed(1)}) {
            return vec3(0.0);
          }

          // 3. FAST EARLY EXIT: Camera Proximity Radius
          float camDist = distance(worldPos, uCausticsCameraPos);
          if (camDist > ${WATER_EFFECTS_CONFIG.CAUSTICS_MAX_DISTANCE.toFixed(1)}) {
            return vec3(0.0);
          }

          // 4. FAST EARLY EXIT: Water pool AABB boundaries
          if (
            worldPos.x < ${WATER_FOG_CONFIG.BOUNDS_MIN_X.toFixed(1)} ||
            worldPos.x > ${WATER_FOG_CONFIG.BOUNDS_MAX_X.toFixed(1)} ||
            worldPos.z < ${WATER_FOG_CONFIG.BOUNDS_MIN_Z.toFixed(1)} ||
            worldPos.z > ${WATER_FOG_CONFIG.BOUNDS_MAX_Z.toFixed(1)}
          ) {
            return vec3(0.0);
          }

          // Normal weight curve for upward facing faces
          float normalWeight = smoothstep(0.04, 0.75, worldNormal.y);

          // Camera distance smooth fade out
          float distFade = 1.0 - smoothstep(
            ${WATER_EFFECTS_CONFIG.CAUSTICS_FADE_START.toFixed(1)},
            ${WATER_EFFECTS_CONFIG.CAUSTICS_MAX_DISTANCE.toFixed(1)},
            camDist
          );

          // Depth attenuation through water column
          float depth = clamp((${WATER_PHYSICS_CONFIG.SURFACE_Y.toFixed(1)} - worldPos.y) / 22.0, 0.0, 1.0);
          float depthFade = (1.0 - depth * 0.55);

          // Animated world-space UV coordinates (XZ planar projection)
          vec2 baseUV = worldPos.xz * 0.12;
          float t = uCausticsTime * 0.85;

          // Wave turbulence perturbation
          vec2 waveDistort = vec2(
            sin(t * 1.1 + baseUV.y * 3.8) * 0.038,
            cos(t * 1.2 + baseUV.x * 3.8) * 0.038
          );
          vec2 uv = baseUV * 1.55 + vec2(t * 0.03, t * 0.02) + waveDistort;

          // Optimized Chromatic Aberration (3-sample fetch: R, G, B with dispersion shift)
          vec2 dispDir = vec2(0.819, 0.573); // Pre-normalized (cos 35deg, sin 35deg)
          float aberrationSpread = 0.015;

          float r = texture2D(uCausticsMap, uv - dispDir * aberrationSpread).r;
          float g = texture2D(uCausticsMap, uv).g;
          float b = texture2D(uCausticsMap, uv + dispDir * aberrationSpread).b;

          vec3 causticsRGB = vec3(r, g, b);

          // High contrast power curve & crystalline cyan sunlight tint
          causticsRGB = pow(causticsRGB, vec3(1.6)) * 3.3;
          causticsRGB *= vec3(0.9, 1.15, 1.3);

          return causticsRGB * (depthFade * normalWeight * distFade * uCausticsIntensity);
        }
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        #include <dithering_fragment>
        vec3 projectedCaustics = calculateProjectedCaustics(vWorldPosCaustics, vWorldNormalCaustics);
        gl_FragColor.rgb += projectedCaustics;
        `
      );
    };

    material.needsUpdate = true;
  }

  /**
   * Surface ripples mesh circles removed per user request
   */
  public emitRipple(
    _x: number,
    _z: number,
    _strength: number = 1.0,
    _maxRadius: number = 3.5,
    _customDuration?: number
  ): void {
    // Surface mesh circles removed
  }

  /**
   * Surface ripple pulse pair removed per user request
   */
  public emitRippleBurst(_x: number, _z: number, _intensity: number = 1.0): void {
    // Surface mesh circles removed
  }

  /**
   * Update animation loop for caustics time and camera position uniforms
   */
  public update(dt: number, cameraPos?: THREE.Vector3): void {
    this.totalTime += dt;

    // 1. Update Caustics Time & Camera Position Uniforms
    this.causticsUniforms.uCausticsTime.value = this.totalTime;
    if (cameraPos) {
      (this.causticsUniforms.uCausticsCameraPos.value as THREE.Vector3).copy(cameraPos);
    }

    // 2. Update procedural generator only if static texture is not yet loaded
    if (!this.isStaticTextureLoaded && this.fallbackGenerator) {
      this.fallbackGenerator.update(this.totalTime);
    }
  }

  public dispose(): void {
    if (this.fallbackGenerator) {
      this.fallbackGenerator.dispose();
      this.fallbackGenerator = null;
    }
  }
}
