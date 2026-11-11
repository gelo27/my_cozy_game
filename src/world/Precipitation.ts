import * as THREE from 'three';
import { isMobileDevice } from './WorldSettings';
import { PrecipitationOcclusion } from './PrecipitationOcclusion';
import { MAX_FAKE_LIGHTS, nightLightUniforms } from './NightLighting';

/** Side of the box of drops that follows the camera (m). */
export const PRECIP_BOX = 40;
const BOX_HEIGHT = 26;
const SPLASH_RADIUS = 14;

const OCCLUSION_GLSL = `
  uniform sampler2D uOcc;
  uniform float uOccCell, uOccN, uOccOn, uWaterY;
  // Highest surface that stops a drop: roofs / ground from the roof map, or the water plane
  float roofAt(vec2 xz) {
    if (uOccOn < 0.5) return uWaterY;
    vec2 cell = floor(xz / uOccCell);
    return max(texture2D(uOcc, (mod(cell, uOccN) + 0.5) / uOccN).r, uWaterY);
  }
`;

/**
 * Rain and snow, fully animated on the GPU (the CPU only sets uniforms).
 *
 * - Drops are instanced quads in a world-anchored lattice: their world position depends only on
 *   time, and the camera merely chooses which repeat of the lattice is drawn. So walking, jumping
 *   or driving never drags the rain along with the player.
 * - Rain is a thin motion-blurred streak stretched along the fall direction (wind slant included);
 *   snow is a small soft flake that sways.
 * - Drops below the roof map (PrecipitationOcclusion) are collapsed to a degenerate vertex: no
 *   fill cost and no rain indoors.
 * - Splashes: a small pool of sprites that each pick a random roof-map cell every cycle and play a
 *   short crown burst on its surface (ground, roofs, big props).
 */
export class Precipitation {
  private readonly drops: THREE.Mesh;
  private readonly dropMat: THREE.ShaderMaterial;
  private readonly splashes: THREE.Points;
  private readonly splashMat: THREE.ShaderMaterial;
  private readonly dropCount: number;
  private readonly splashCount: number;

  constructor(scene: THREE.Scene) {
    const mobile = isMobileDevice();
    const occUniforms = () => ({
      uOcc: { value: null as THREE.Texture | null },
      uOccCell: { value: 1 },
      uOccN: { value: 1 },
      uOccOn: { value: 0 },
      uWaterY: { value: -1e4 },
    });

    // ---------------------------------------------------------------- drops
    const count = mobile ? 1800 : 5000;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    const offset = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      offset[i * 3] = Math.random() * PRECIP_BOX;
      offset[i * 3 + 1] = Math.random() * BOX_HEIGHT;
      offset[i * 3 + 2] = Math.random() * PRECIP_BOX;
      // Ascending (stratified) seeds: the shader hides drops with seed > amount, so the visible ones
      // are always the first instances and the draw call can skip the rest (instanceCount below)
      seed[i] = (i + Math.random()) / count;
    }
    geo.setAttribute('offset', new THREE.InstancedBufferAttribute(offset, 3));
    geo.setAttribute('seed', new THREE.InstancedBufferAttribute(seed, 1));
    geo.instanceCount = count;
    this.dropCount = count;

    this.dropMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide, // streak orientation flips with the view, so its winding does too
      forceSinglePass: true, // single quads: no back/front ordering to preserve
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uAmount: { value: 0 },
        uSnow: { value: 0 },
        uStorm: { value: 0 },
        uWind: { value: new THREE.Vector2(1.2, 0.4) },
        // Integrated on the CPU (distance fallen at base speed, sideways drift), so a change of
        // speed or wind (rain to snow, a blizzard rising) eases in instead of jolting every flake
        uFall: { value: 0 },
        uSpeed: { value: 11 },
        uDrift: { value: new THREE.Vector2() },
        uSwirlT: { value: 0 },
        uBright: { value: 1 },
        ...occUniforms(),
        // Lamps and campfires (NightLighting): flakes and drops near them catch the light
        uFakeLightPos: nightLightUniforms.uFakeLightPos,
        uFakeLightColor: nightLightUniforms.uFakeLightColor,
        uFakeLightCount: nightLightUniforms.uFakeLightCount,
      },
      vertexShader: `
        attribute vec3 offset;
        attribute float seed;
        uniform float uTime, uAmount, uSnow, uBright, uStorm;
        uniform vec3 uCenter;
        uniform vec2 uWind;
        uniform float uFall, uSpeed, uSwirlT;
        uniform vec2 uDrift;
        #define MAX_FAKE_LIGHTS ${MAX_FAKE_LIGHTS}
        uniform vec4 uFakeLightPos[MAX_FAKE_LIGHTS];
        uniform vec3 uFakeLightColor[MAX_FAKE_LIGHTS];
        uniform int uFakeLightCount;
        varying vec2 vUv;
        varying float vFade;
        varying vec3 vLit;
        ${OCCLUSION_GLSL}
        void main() {
          if (seed > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float speedK = 0.85 + seed * 0.3;
          float speed = uSpeed * speedK;
          float fallen = uFall * speedK;
          vec2 drift = uDrift;
          vec3 p = offset;
          // World-anchored lattice (repeats every box), the camera only picks which repeat is shown
          float bottom = uCenter.y - 9.0;
          p.y = bottom + mod(offset.y - fallen - bottom, ${BOX_HEIGHT.toFixed(1)});
          p.xz += drift;
          float swirl = 1.0 + uStorm * 1.5;
          p.x += uSnow * sin(uSwirlT * (0.6 + seed) + seed * 40.0) * 0.5 * swirl;
          p.z += uSnow * cos(uSwirlT * (0.5 + seed * 0.8) + seed * 25.0) * 0.4 * swirl;
          p.xz = mod(p.xz - uCenter.xz + ${(PRECIP_BOX / 2).toFixed(1)}, ${PRECIP_BOX.toFixed(1)}) - ${(PRECIP_BOX / 2).toFixed(1)} + uCenter.xz;

          vec3 toCam = cameraPosition - p;
          float dist = length(toCam);
          // Fully faded drops (box corners past the fade radius, and ones right at the lens whose
          // quads would cover much of the screen) are collapsed instead of rasterised and discarded
          vFade = (1.0 - smoothstep(8.0, ${(PRECIP_BOX / 2).toFixed(1)}, dist)) * smoothstep(0.4, 1.5, dist);
          if (vFade < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

          // Off-screen drops skip the roof-map fetch and the rest of the work. Conservative: the drop
          // is culled only when both ends of its streak lie beyond the same frustum side.
          vec3 axis = normalize(vec3(uWind.x, -speed, uWind.y));
          float len = 0.8 + seed * 0.6;
          vec4 c0 = projectionMatrix * viewMatrix * vec4(p, 1.0);
          vec4 c1 = uSnow > 0.5 ? c0 : projectionMatrix * viewMatrix * vec4(p - axis * len, 1.0);
          const float M = 0.3; // clip-space margin for streak width / flake size
          if ((c0.w < 0.0 && c1.w < 0.0) ||
              (c0.x > c0.w + M && c1.x > c1.w + M) || (c0.x < -c0.w - M && c1.x < -c1.w - M) ||
              (c0.y > c0.w + M && c1.y > c1.w + M) || (c0.y < -c0.w - M && c1.y < -c1.w - M)) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
          }

          if (p.y < roofAt(p.xz)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

          vec3 world;
          if (uSnow > 0.5) {
            // Camera-facing flake, 5-8 cm up close; grows slightly with distance so it stays visible
            vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
            float s = 0.05 + seed * 0.03 + dist * 0.004;
            world = p + (right * position.x + up * (position.y - 0.5)) * s;
          } else {
            // Streak along the fall direction, turned to face the camera around that axis
            vec3 side = normalize(cross(axis, toCam));
            // Widen far streaks a little so they don't shimmer below a pixel
            float width = 0.016 + dist * 0.0018;
            world = p + side * position.x * width - axis * position.y * len;
          }
          vUv = position.xy + vec2(0.5, 0.0);
          vec4 mv = viewMatrix * vec4(world, 1.0);
          // Lamp light on the flake: no facing (a flake scatters every way), a soft falloff that
          // reaches a bit past the lamp's ground pool so a glowing cone of snow hangs around it
          vLit = vec3(0.0);
          for (int i = 0; i < MAX_FAKE_LIGHTS; i++) {
            if (i >= uFakeLightCount) break;
            vec3 tl = uFakeLightPos[i].xyz - mv.xyz;
            float r = uFakeLightPos[i].w * 1.2;
            float d2 = dot(tl, tl);
            if (d2 >= r * r) continue;
            float att = 1.0 - d2 / (r * r);
            vLit += uFakeLightColor[i] * (att * att);
          }
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uSnow, uBright;
        varying vec2 vUv;
        varying float vFade;
        varying vec3 vLit;
        void main() {
          float a;
          vec3 col;
          if (uSnow > 0.5) {
            vec2 d = vUv - 0.5;
            a = (1.0 - smoothstep(0.15, 0.5, length(d))) * 0.95;
            col = vec3(1.0);
          } else {
            // Thin core, brighter leading end
            a = (1.0 - abs(vUv.x - 0.5) * 2.0) * mix(1.0, 0.3, vUv.y) * 0.6;
            col = vec3(0.78, 0.86, 0.95);
          }
          a *= vFade;
          if (a < 0.01) discard;
          // Lit flakes also show more (a dim one turns into a bright speck in the lamp's glow)
          vec3 lit = vLit * mix(0.9, 2.2, uSnow);
          gl_FragColor = vec4(col * uBright + lit, min(1.0, a * (1.0 + dot(lit, vec3(0.3)))));
        }`,
    });
    this.drops = new THREE.Mesh(geo, this.dropMat);
    this.drops.frustumCulled = false;
    this.drops.visible = false;
    this.drops.renderOrder = 5;
    scene.add(this.drops);

    // ---------------------------------------------------------------- splashes
    const splashCount = mobile ? 110 : 320;
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(splashCount * 3), 3));
    const sseed = new Float32Array(splashCount);
    this.splashCount = splashCount;
    for (let i = 0; i < splashCount; i++) sseed[i] = (i + Math.random()) / splashCount;
    sgeo.setAttribute('seed', new THREE.BufferAttribute(sseed, 1));
    this.splashMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uAmount: { value: 0 },
        uBright: { value: 1 },
        uSize: { value: mobile ? 1.0 : 1.2 },
        uPixelRatio: { value: 1 },
        ...occUniforms(),
      },
      vertexShader: `
        attribute float seed;
        uniform float uTime, uAmount, uSize, uPixelRatio;
        uniform vec3 uCenter;
        varying float vPhase;
        ${OCCLUSION_GLSL}
        float h(float n) { return fract(sin(n) * 43758.5453); }
        void main() {
          float cycle = uTime * (1.4 + seed * 1.2) + seed * 17.0;
          float idx = floor(cycle);
          vPhase = fract(cycle) * 2.5; // the burst lives in the first 40% of the cycle
          if (seed > uAmount || vPhase > 1.0 || uOccOn < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          // New random spot each cycle, near the centre of a roof-map cell so it sits on that surface
          vec2 r = vec2(h(idx * 12.9898 + seed * 78.233), h(idx * 39.3468 + seed * 11.135)) * 2.0 - 1.0;
          vec2 cell = floor((uCenter.xz + r * ${SPLASH_RADIUS.toFixed(1)}) / uOccCell);
          vec2 jitter = vec2(h(idx + seed * 3.1), h(idx * 1.7 + seed)) - 0.5;
          vec2 xz = (cell + 0.5 + jitter * 0.35) * uOccCell;
          float y = roofAt(xz);
          if (y < -1000.0 || abs(y - uCenter.y) > 20.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vec4 mv = viewMatrix * vec4(xz.x, y + 0.04, xz.y, 1.0);
          gl_PointSize = uSize * uPixelRatio * 140.0 / max(-mv.z, 0.5);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uBright;
        varying float vPhase;
        void main() {
          // Crown seen from the side: droplets thrown up along an expanding arc, a flat ring on the
          // surface and a small rebound drop in the middle early on
          vec2 d = gl_PointCoord - vec2(0.5, 0.78);
          d.y = -d.y;
          float t = vPhase;
          float ringR = 0.1 + t * 0.32;
          float ground = 1.0 - smoothstep(0.0, 0.08, abs(length(d * vec2(1.0, 3.2)) - ringR));
          float ang = atan(d.y, d.x);
          float arcH = sin(t * 3.14159) * 0.28;
          vec2 arc = vec2(cos(ang), sin(ang)) * vec2(ringR, arcH);
          float drops = d.y > 0.0 ? (1.0 - smoothstep(0.035, 0.07, length(d - arc))) * step(0.5, fract(ang * 1.9)) : 0.0;
          float rebound = (1.0 - smoothstep(0.04, 0.08, length(d - vec2(0.0, sin(t * 3.14159) * 0.35)))) * step(t, 0.6);
          float a = max(max(ground * 0.8, drops), rebound) * (1.0 - t * t);
          if (a < 0.02) discard;
          gl_FragColor = vec4(vec3(0.9, 0.95, 1.0) * uBright, a);
        }`,
    });
    this.splashes = new THREE.Points(sgeo, this.splashMat);
    this.splashes.frustumCulled = false;
    this.splashes.visible = false;
    this.splashes.renderOrder = 5;
    scene.add(this.splashes);
  }

  public setOcclusion(occ: PrecipitationOcclusion): void {
    for (const m of [this.dropMat, this.splashMat]) {
      const u = m.uniforms;
      u.uOcc.value = occ.texture;
      u.uOccCell.value = occ.cellSize;
      u.uOccN.value = occ.size;
      u.uOccOn.value = 1;
    }
  }

  /** Whether anything is falling (used to skip the roof-map raycasts in dry weather). */
  public get active(): boolean {
    return this.drops.visible;
  }

  public update(dt: number, cameraPos: THREE.Vector3, amount: number, snow: number, brightness: number, storm: number, pixelRatio: number, waterY: number): void {
    this.dropMat.uniforms.uWaterY.value = waterY;
    this.splashMat.uniforms.uWaterY.value = waterY;
    const visible = amount > 0.02;
    this.drops.visible = visible;
    this.splashes.visible = visible && snow < 0.5;
    if (!visible) {
      // Nobody sees the lattice now: restart the fall clocks so they never grow past float precision
      this.dropMat.uniforms.uFall.value = 0;
      this.dropMat.uniforms.uSwirlT.value = 0;
      return;
    }
    // Only the instances that can be visible at this amount are drawn (seeds ascend with the index)
    (this.drops.geometry as THREE.InstancedBufferGeometry).instanceCount = Math.min(this.dropCount, Math.ceil(this.dropCount * amount) + 1);
    this.splashes.geometry.setDrawRange(0, Math.min(this.splashCount, Math.ceil(this.splashCount * amount) + 1));
    const u = this.dropMat.uniforms;
    u.uTime.value += dt;
    u.uCenter.value.copy(cameraPos);
    u.uAmount.value = amount;
    u.uSnow.value = snow;
    u.uBright.value = brightness;
    u.uWind.value.set(0.8 + storm * 2.2, 0.3 + storm * 0.8);
    u.uStorm.value = storm;
    // A blizzard (snow + storm wind) drives the flakes faster and almost sideways
    const speed = 11 + (1.2 * (1 + storm * 1.8) - 11) * snow;
    const side = 1 + (0.35 + storm * 1.4 - 1) * snow;
    u.uSpeed.value = speed;
    u.uFall.value += speed * dt;
    u.uSwirlT.value += dt * (1 + storm * 1.5);
    const B = PRECIP_BOX;
    u.uDrift.value.set((u.uDrift.value.x + u.uWind.value.x * side * dt) % B, (u.uDrift.value.y + u.uWind.value.y * side * dt) % B);
    const s = this.splashMat.uniforms;
    s.uTime.value = u.uTime.value;
    s.uCenter.value.copy(cameraPos);
    s.uAmount.value = amount;
    s.uBright.value = brightness;
    s.uPixelRatio.value = pixelRatio;
  }
}
