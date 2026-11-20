import * as THREE from 'three';
import { worldSettings } from './WorldSettings';
import { waterSettings } from './WaterSettings';
import { WATER_SHARED_GLSL, waterSurfaceUniforms } from './WaterSurface';
import { DUCKWEED_CORE_GLSL, duckweedCoreUniforms } from './Duckweed';
import { CLOUD_SHADOW_GLSL, cloudShadowUniforms } from './CloudShadows';

/**
 * Star-shaped sun sparkles over the sea (the camera-lens "diffraction stars" of a sunlit lake).
 *
 * One draw call of GL points, no CPU work per point: a fixed grid of GRID x GRID points on the
 * water plane, snapped to the camera, each jittered inside its cell. The vertex shader decides
 * everything: it samples the same waves as the water, asks whether the point's random facet
 * mirrors the sun into the eye (the same test as the shader sparkles, with a tighter tolerance,
 * so stars are the rare brightest ones) and twinkles it. A point that does not flash gets size 0
 * and is pushed out of the clip volume, so only the few live stars cost any fragments.
 * Additive, depth tested (land, boats and the player hide them), no depth write.
 */
const GRID = 96;
/** Metres between grid points: the sparkle field reaches GRID * SPACING / 2 around the camera. */
const SPACING = 0.8;

const uniforms = {
  ...waterSurfaceUniforms,
  ...duckweedCoreUniforms,
  ...cloudShadowUniforms,
  /** Grid origin (cells), water level */
  uSpOrigin: { value: new THREE.Vector3() },
  /** Toward the light (unit, world) */
  uSpLightDir: { value: new THREE.Vector3(0, 1, 0) },
  /** Light colour × intensity × star brightness */
  uSpLightCol: { value: new THREE.Color() },
  /** x slope tolerance, y slope spread, z star size (px), w fog density */
  uSpA: { value: new THREE.Vector4() },
  /** Drawing buffer height (px) */
  uSpViewH: { value: 1080 },
};

const VERT = /* glsl */ `
uniform float uWsTime;
uniform sampler2D uWsNormals;
uniform sampler2D uWsBed;
uniform sampler2D uEstuary;
uniform vec4 uWsWaveA;
uniform vec4 uWsWaveB;
${WATER_SHARED_GLSL}
${DUCKWEED_CORE_GLSL}
${CLOUD_SHADOW_GLSL}
uniform vec3 uSpOrigin;
uniform vec3 uSpLightDir;
uniform vec3 uSpLightCol;
uniform vec4 uSpA;
uniform float uSpViewH;
varying vec3 vSpCol;

void main() {
  vec2 id = uSpOrigin.xy + position.xz;
  vec2 jit = vec2(wsHash(id + 0.71), wsHash(id + 3.37));
  vec2 xz = (id + jit) * ${SPACING.toFixed(2)};
  vec3 wp = vec3(xz.x, uSpOrigin.z, xz.y);
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  float reach = ${((GRID * SPACING) / 2).toFixed(1)};

  float f = 0.0;
  vec2 spot;
  // Only open water: deep enough, no duckweed, inside the sparkle field
  float depth = uSpOrigin.z - wsBedY(wp.xz);
  float inlandCover = wsInIsland(xz) * texture2D(uEstuary, wsBedUv(xz)).a;
  if (inlandCover < 0.5 && depth > 0.05 && dist < reach && wsWeedMask(wp.xz) < 0.1) {
    float shade, wob;
    vec2 slope = wsWaves(wp.xz, dist, shade, wob);
    vec3 h = normalize(uSpLightDir + toCam / dist);
    if (h.y > 0.05) {
      vec2 need = h.xz / h.y - slope;
      f = wsSparkleFacet(id, need, uSpA.x, uSpA.y, 2.2, spot);
    }
  }
  float fog = uSpA.w * dist;
  f *= exp(-fog * fog) * (1.0 - smoothstep(reach * 0.7, reach, dist));
  if (uCsA.w > 0.0) f *= csShade(wp);

  gl_PointSize = uSpA.z * sqrt(f);
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  // The sprite has one depth, but the water under its lower half on screen is nearer: drawn at
  // the point's own depth that half would sink into the water. Pull it toward the eye along its
  // own view ray (same spot on screen) only as far as the water seen at its bottom edge: the
  // ray dropping alpha below the horizon meets the plane at H / sin(alpha), the bottom edge
  // ray halfAng lower. Anything in front of that (a pier, a boat) still hides the star.
  float camH = max(cameraPosition.y - uSpOrigin.z, 0.01);
  float alpha = asin(clamp(camH / dist, 0.0, 1.0));
  float halfAng = gl_PointSize / (projectionMatrix[1][1] * uSpViewH);
  mv.xyz *= 0.98 * sin(alpha) / sin(min(alpha + halfAng, 1.5));
  gl_Position = projectionMatrix * mv;
  vSpCol = uSpLightCol * f;
  // Dark points cost nothing: out of the clip volume
  if (gl_PointSize < 1.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */ `
varying vec3 vSpCol;
/** A ray along x: thin across, fading toward its tip. */
float spRay(float along, float across, float len) {
  float t = max(0.0, 1.0 - abs(along) / len);
  return t * t * exp(-abs(across) * 34.0);
}
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  float d1 = (uv.x + uv.y) * 0.7071;
  float d2 = (uv.x - uv.y) * 0.7071;
  float star = spRay(uv.x, uv.y, 1.0) + spRay(uv.y, uv.x, 1.0)
    + 0.35 * (spRay(d1, d2, 0.55) + spRay(d2, d1, 0.55))
    + exp(-r2 * 70.0) * 2.0 + exp(-r2 * 14.0) * 0.25;
  gl_FragColor = vec4(vSpCol * star, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class WaterSparkles {
  public readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly bufSize = new THREE.Vector2();

  constructor(scene: THREE.Scene) {
    const pos = new Float32Array(GRID * GRID * 3);
    let i = 0;
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        pos[i++] = x - GRID / 2;
        pos[i++] = 0;
        pos[i++] = z - GRID / 2;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'WaterSparkles';
    this.points.frustumCulled = false;
    // After the water and the opaque world, with the other glows
    this.points.renderOrder = 5;
    // Star size in pixels at 1080p, scaled to the real drawing buffer
    this.points.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(this.bufSize);
      uniforms.uSpA.value.z = waterSettings.sparkleStarSize * (this.bufSize.y / 1080);
      uniforms.uSpViewH.value = Math.max(this.bufSize.y, 1);
    };
    scene.add(this.points);
  }

  /**
   * @param camera camera position (the grid follows it)
   * @param light the sun / moon directional light
   * @param fogDensity the scene's FogExp2 density
   * @param allowed 0 in caves / under water
   */
  public update(camera: THREE.Vector3, light: THREE.DirectionalLight, fogDensity: number, allowed: boolean): void {
    const ws = waterSettings;
    const level = worldSettings.waterLevel;
    const on = allowed && ws.sparkleStars > 0 && light.intensity > 0.01 && camera.y > level;
    this.points.visible = on;
    if (!on) return;
    const u = uniforms;
    u.uSpOrigin.value.set(Math.floor(camera.x / SPACING), Math.floor(camera.z / SPACING), level);
    u.uSpLightDir.value.subVectors(light.position, light.target.position).normalize();
    u.uSpLightCol.value.copy(light.color).multiplyScalar(light.intensity * ws.sparkleStars);
    u.uSpA.value.x = Math.max(ws.sparkleStarDensity, 1e-3);
    u.uSpA.value.y = Math.max(ws.sparkleSpread, 0.01);
    u.uSpA.value.w = fogDensity;
  }
}
