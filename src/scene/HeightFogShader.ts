import * as THREE from 'three';
import { WATER_FOG_CONFIG } from '../config/constants';

export interface HeightFogBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

export class HeightFogManager {
  private static instance: HeightFogManager | null = null;
  private isPatched: boolean = false;
  private enabled: boolean = WATER_FOG_CONFIG.ENABLE_HEIGHT_SHADER;

  // Shared uniforms across all Three.js built-in materials
  public uniforms: {
    uHeightFogMinY: { value: number };
    uHeightFogMaxY: { value: number };
    uHeightFogBounds: { value: THREE.Vector4 };
    uHeightFogStrength: { value: number };
    uHeightFogIsWaterBounded: { value: number };
  } = {
    uHeightFogMinY: { value: WATER_FOG_CONFIG.HEIGHT_MIN_Y },
    uHeightFogMaxY: { value: WATER_FOG_CONFIG.HEIGHT_MAX_Y },
    uHeightFogBounds: {
      value: new THREE.Vector4(
        WATER_FOG_CONFIG.BOUNDS_MIN_X,
        WATER_FOG_CONFIG.BOUNDS_MAX_X,
        WATER_FOG_CONFIG.BOUNDS_MIN_Z,
        WATER_FOG_CONFIG.BOUNDS_MAX_Z
      ),
    },
    uHeightFogStrength: { value: WATER_FOG_CONFIG.ENABLE_HEIGHT_SHADER ? 1.0 : 0.0 }, // 1.0 = height & horizontal water fog active (above water), 0.0 = simple uniform fog (underwater or disabled)
    uHeightFogIsWaterBounded: { value: WATER_FOG_CONFIG.IS_WATER_BOUNDED ? 1.0 : 0.0 }, // 1.0 = bounded to water body, 0.0 = entire height level
  };

  private currentStrength: number = WATER_FOG_CONFIG.ENABLE_HEIGHT_SHADER ? 1.0 : 0.0;
  private targetStrength: number = WATER_FOG_CONFIG.ENABLE_HEIGHT_SHADER ? 1.0 : 0.0;

  public static getInstance(): HeightFogManager {
    if (!HeightFogManager.instance) {
      HeightFogManager.instance = new HeightFogManager();
    }
    return HeightFogManager.instance;
  }

  private constructor() {
    this.installShaderPatches();
  }

  /**
   * Patches Three.js ShaderChunk and ShaderLib to support height-based and horizontally-bounded fog
   * as outlined in https://woodenraft.games/blog/height-fog-implementation-three-js
   */
  public installShaderPatches(): void {
    if (this.isPatched) return;
    this.isPatched = true;

    // 1. Inject uniforms into Three.js UniformsLib and ShaderLib for all built-in materials
    Object.assign(THREE.UniformsLib.fog, this.uniforms);
    for (const key in THREE.ShaderLib) {
      const shader = (THREE.ShaderLib as any)[key];
      if (shader && shader.uniforms) {
        Object.assign(shader.uniforms, this.uniforms);
      }
    }

    // 2. Vertex shader pars: declare vWorldPosition
    THREE.ShaderChunk.fog_pars_vertex = `${THREE.ShaderChunk.fog_pars_vertex}
#ifdef USE_FOG
  varying vec3 vWorldPosition;
#endif
`;

    // 3. Vertex shader: compute worldPosition for all meshes
    THREE.ShaderChunk.fog_vertex = `${THREE.ShaderChunk.fog_vertex}
#ifdef USE_FOG
  vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif
`;

    // 4. Sprite vertex shader fix (sprites do not define 'transformed')
    if (THREE.ShaderLib.sprite && THREE.ShaderLib.sprite.vertexShader) {
      THREE.ShaderLib.sprite.vertexShader = THREE.ShaderLib.sprite.vertexShader.replace(
        '#include <fog_vertex>',
        `
        #ifdef USE_FOG
          vFogDepth = - mvPosition.z;
          vWorldPosition = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #endif
        `
      );
    }

    // 5. Fragment shader pars: declare uniforms and varying vWorldPosition
    THREE.ShaderChunk.fog_pars_fragment = `${THREE.ShaderChunk.fog_pars_fragment}
#ifdef USE_FOG
  varying vec3 vWorldPosition;

  uniform float uHeightFogMinY;
  uniform float uHeightFogMaxY;
  uniform vec4 uHeightFogBounds;
  uniform float uHeightFogStrength;
  uniform float uHeightFogIsWaterBounded;
#endif
`;

    // 6. Fragment shader: replace standard fog mix with Height + Bounded Water Fog calculations
    const FOG_APPLIED_LINE = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );';
    const customFogFragment = `
  // 1. Height factor: fog is densest near uHeightFogMinY (water surface) and smoothly fades out at uHeightFogMaxY
  float hFactorWorld = smoothstep( uHeightFogMaxY, uHeightFogMinY, vWorldPosition.y );
  float hFactorCam = smoothstep( uHeightFogMaxY, uHeightFogMinY, cameraPosition.y );
  float heightFogMod = max( hFactorWorld, hFactorCam );

  // 2. Horizontal water body bounds factor (with soft edge blending)
  float hMargin = ${WATER_FOG_CONFIG.FADE_MARGIN.toFixed(1)};
  float boundX = smoothstep( uHeightFogBounds.x - hMargin, uHeightFogBounds.x + hMargin, vWorldPosition.x ) *
                 smoothstep( uHeightFogBounds.y + hMargin, uHeightFogBounds.y - hMargin, vWorldPosition.x );
  float boundZ = smoothstep( uHeightFogBounds.z - hMargin, uHeightFogBounds.z + hMargin, vWorldPosition.z ) *
                 smoothstep( uHeightFogBounds.w + hMargin, uHeightFogBounds.w - hMargin, vWorldPosition.z );
  float horizontalMod = mix( 1.0, clamp( boundX * boundZ, 0.0, 1.0 ), uHeightFogIsWaterBounded );

  // Combined height + horizontal bounds factor
  float heightFogFactor = heightFogMod * horizontalMod;

  // When uHeightFogStrength is 1.0 (above water): modulate distance fogFactor by height & bounds.
  // When uHeightFogStrength is 0.0 (underwater or disabled): use standard uniform distance fogFactor!
  float finalFogFactor = mix( fogFactor, fogFactor * heightFogFactor, uHeightFogStrength );

  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, finalFogFactor );
`;

    if (THREE.ShaderChunk.fog_fragment.includes(FOG_APPLIED_LINE)) {
      THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace(
        FOG_APPLIED_LINE,
        customFogFragment
      );
    }
  }

  /**
   * Sets the 3D bounding box for the horizontal water fog
   */
  public setBounds(bounds: HeightFogBounds): void {
    this.uniforms.uHeightFogBounds.value.set(bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ);
    this.uniforms.uHeightFogMinY.value = bounds.minY;
    this.uniforms.uHeightFogMaxY.value = bounds.maxY;
  }

  /**
   * Toggles whether the fog is constrained within water bounds or covers the full scene horizontally
   */
  public setIsWaterBounded(bounded: boolean): void {
    this.uniforms.uHeightFogIsWaterBounded.value = bounded ? 1.0 : 0.0;
  }

  /**
   * Enables or disables the vertical height shader logic
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.currentStrength = 0.0;
      this.targetStrength = 0.0;
      this.uniforms.uHeightFogStrength.value = 0.0;
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Updates transition between above-water height fog (strength = 1) and underwater/disabled simple fog (strength = 0)
   */
  public update(dt: number, isCameraUnderwater: boolean): void {
    if (!this.enabled || !WATER_FOG_CONFIG.ENABLE_HEIGHT_SHADER) {
      this.targetStrength = 0.0;
    } else {
      this.targetStrength = isCameraUnderwater ? 0.0 : 1.0;
    }

    const lerpRate = 1 - Math.exp(-8 * dt);
    this.currentStrength = THREE.MathUtils.lerp(this.currentStrength, this.targetStrength, lerpRate);
    this.uniforms.uHeightFogStrength.value = this.currentStrength;
  }

  public getStrength(): number {
    return this.currentStrength;
  }
}

export const heightFogManager = HeightFogManager.getInstance();
