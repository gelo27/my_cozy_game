import * as THREE from 'three';
import { isMobileDevice } from './WorldSettings';
import { PrecipitationOcclusion } from './PrecipitationOcclusion';

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
      seed[i] = Math.random();
    }
    geo.setAttribute('offset', new THREE.InstancedBufferAttribute(offset, 3));
    geo.setAttribute('seed', new THREE.InstancedBufferAttribute(seed, 1));
    geo.instanceCount = count;

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
        uWind: { value: new THREE.Vector2(1.2, 0.4) },
        uBright: { value: 1 },
        ...occUniforms(),
      },
      vertexShader: `
        attribute vec3 offset;
        attribute float seed;
        uniform float uTime, uAmount, uSnow, uBright;
        uniform vec3 uCenter;
        uniform vec2 uWind;
        varying vec2 vUv;
        varying float vFade;
        ${OCCLUSION_GLSL}
        void main() {
          if (seed > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float speed = mix(11.0, 1.2, uSnow) * (0.85 + seed * 0.3);
          float fallen = uTime * speed;
          vec2 drift = uWind * mix(1.0, 0.35, uSnow) * fallen / speed;
          vec3 p = offset;
          // World-anchored lattice (repeats every box), the camera only picks which repeat is shown
          float bottom = uCenter.y - 9.0;
          p.y = bottom + mod(offset.y - fallen - bottom, ${BOX_HEIGHT.toFixed(1)});
          p.xz += drift;
          p.x += uSnow * sin(uTime * (0.6 + seed) + seed * 40.0) * 0.5;
          p.z += uSnow * cos(uTime * (0.5 + seed * 0.8) + seed * 25.0) * 0.4;
          p.xz = mod(p.xz - uCenter.xz + ${(PRECIP_BOX / 2).toFixed(1)}, ${PRECIP_BOX.toFixed(1)}) - ${(PRECIP_BOX / 2).toFixed(1)} + uCenter.xz;

          if (p.y < roofAt(p.xz)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

          vec3 toCam = cameraPosition - p;
          float dist = length(toCam);
          vec3 world;
          if (uSnow > 0.5) {
            // Camera-facing flake, 5-8 cm up close; grows slightly with distance so it stays visible
            vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
            float s = 0.05 + seed * 0.03 + dist * 0.004;
            world = p + (right * position.x + up * (position.y - 0.5)) * s;
          } else {
            // Streak along the fall direction, turned to face the camera around that axis
            vec3 axis = normalize(vec3(uWind.x, -speed, uWind.y));
            vec3 side = normalize(cross(axis, toCam));
            float len = 0.8 + seed * 0.6;
            // Widen far streaks a little so they don't shimmer below a pixel
            float width = 0.016 + dist * 0.0018;
            world = p + side * position.x * width - axis * position.y * len;
          }
          vUv = position.xy + vec2(0.5, 0.0);
          vFade = (1.0 - smoothstep(8.0, ${(PRECIP_BOX / 2).toFixed(1)}, dist)) * smoothstep(0.4, 1.5, dist);
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
      fragmentShader: `
        uniform float uSnow, uBright;
        varying vec2 vUv;
        varying float vFade;
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
          gl_FragColor = vec4(col * uBright, a);
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
    for (let i = 0; i < splashCount; i++) sseed[i] = Math.random();
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
    if (!visible) return;
    const u = this.dropMat.uniforms;
    u.uTime.value += dt;
    u.uCenter.value.copy(cameraPos);
    u.uAmount.value = amount;
    u.uSnow.value = snow;
    u.uBright.value = brightness;
    u.uWind.value.set(0.8 + storm * 2.2, 0.3 + storm * 0.8);
    const s = this.splashMat.uniforms;
    s.uTime.value = u.uTime.value;
    s.uCenter.value.copy(cameraPos);
    s.uAmount.value = amount;
    s.uBright.value = brightness;
    s.uPixelRatio.value = pixelRatio;
  }
}
