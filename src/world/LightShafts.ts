import * as THREE from 'three';
import { isMobileDevice, worldSettings } from './WorldSettings';
import { riverWorld } from './rivers/RiverWorld';
import { causticsUniforms } from '../scene/WaterEffects';
import { waterSurfaceUniforms } from './WaterSurface';
import { SEA_FLOOR_Y, WORLD_SIZE } from './WorldSettings';

/**
 * Fake underwater god rays: a handful of long, thin, additive ribbons that slant down from the
 * surface along the refracted sun, live a few seconds each (fading in and out) and flicker with the
 * caustics pattern where they enter the water, so they pulse in step with the light on the bed.
 *
 * One instanced draw call; each ribbon turns about its own axis to face the camera (in the vertex
 * shader). No depth writes and no sorting; the depth test lets terrain and rocks hide them, and
 * they fade out toward the bed (the water's bed-height texture). The only real cost is overdraw of
 * a few thin transparent strips, and only while the camera is under water.
 */
export interface LightShaftSettings {
  enabled: boolean;
  /** Overall brightness. */
  strength: number;
  /** Ribbons alive at once. */
  count: number;
  /** Ribbon width (m). */
  width: number;
  /** Ribbon length below the surface (m). */
  length: number;
  /** Radius around the camera they appear in (m). */
  radius: number;
  /** Flicker speed (×). */
  flicker: number;
  /** Seconds a ribbon lives (fade in, hold, fade out). */
  life: number;
}

export const LIGHT_SHAFT_DEFAULTS: Readonly<LightShaftSettings> = {
  enabled: true,
  strength: 0.9,
  count: 14,
  width: 1.6,
  length: 12,
  radius: 16,
  flicker: 1,
  life: 6,
};

const MOBILE = isMobileDevice();
/** Hard cap on ribbons (the instanced buffer size); phones draw at most half the setting. */
export const MAX_SHAFTS = 32;
const STORAGE_KEY = 'farm.lightShafts';

function load(): LightShaftSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) return { ...LIGHT_SHAFT_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // ignore broken storage
  }
  return { ...LIGHT_SHAFT_DEFAULTS };
}

export const lightShaftSettings: LightShaftSettings = load();

export function saveLightShaftSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lightShaftSettings));
  } catch {
    // storage full / disabled
  }
}

export function resetLightShaftSettings(): void {
  Object.assign(lightShaftSettings, LIGHT_SHAFT_DEFAULTS);
  saveLightShaftSettings();
}

interface Shaft {
  x: number;
  y: number;
  z: number;
  /** Seconds lived / to live (0 = free slot). */
  t: number;
  life: number;
  seed: number;
  /** Width and length multipliers (each ribbon a little different). */
  w: number;
  l: number;
}

const HALF = WORLD_SIZE / 2;
const V = WORLD_SIZE + 1;

/** What the engine knows about the light this frame. */
export interface ShaftLight {
  /** Unit vector toward the sun. */
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  /** 0..1: 1 = camera fully under water. */
  underwater: number;
  night: number;
  cover: number;
  /** 0..1: 1 = in a cave (no sun). */
  cave: number;
}

export class LightShafts {
  private readonly mesh: THREE.InstancedMesh;
  /** Per ribbon: top x, y, z, seed. */
  private readonly aTop: THREE.InstancedBufferAttribute;
  /** Per ribbon: width, length, alpha, unused. */
  private readonly aSize: THREE.InstancedBufferAttribute;
  private readonly shafts: Shaft[] = [];
  private readonly uniforms = {
    uLsDir: { value: new THREE.Vector3(0, -1, 0) },
    uLsColor: { value: new THREE.Color() },
    uLsFlicker: { value: 1 },
  };
  private static readonly _v = new THREE.Vector3();
  private static readonly _f = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    // A unit ribbon: x across (-0.5..0.5), y along (0 at the surface .. 1 at the far end)
    const base = new THREE.PlaneGeometry(1, 1, 1, 1);
    base.translate(0, -0.5, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    this.aTop = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHAFTS * 4), 4);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHAFTS * 4), 4);
    this.aTop.setUsage(THREE.DynamicDrawUsage);
    this.aSize.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTop', this.aTop);
    geo.setAttribute('aSize', this.aSize);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.uniforms,
        uCausticsMap: causticsUniforms.uCausticsMap,
        uCausticsTime: causticsUniforms.uCausticsTime,
        uCausticsParams: causticsUniforms.uCausticsParams,
        uWsBed: waterSurfaceUniforms.uWsBed,
      },
      vertexShader: /* glsl */ `
        attribute vec4 aTop;
        attribute vec4 aSize;
        uniform vec3 uLsDir;
        varying vec2 vUv;
        varying vec3 vW;
        varying vec4 vTop;
        varying float vAlpha;
        void main() {
          // Along the refracted sun; across: perpendicular to both the axis and the view
          float along = -position.y * aSize.y;
          vec3 axisP = aTop.xyz + uLsDir * along;
          vec3 toCam = cameraPosition - axisP;
          vec3 side = cross(uLsDir, toCam);
          float sl = length(side);
          side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
          // Wider toward the far end, like light spreading
          float wid = aSize.x * (0.7 + 0.6 * -position.y);
          vec3 w = axisP + side * position.x * wid;
          vUv = vec2(position.x * 2.0, -position.y);
          vW = w;
          vTop = aTop;
          vAlpha = aSize.z;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uLsColor;
        uniform float uLsFlicker;
        uniform sampler2D uCausticsMap;
        uniform sampler2D uWsBed;
        uniform float uCausticsTime;
        uniform vec4 uCausticsParams;
        varying vec2 vUv;
        varying vec3 vW;
        varying vec4 vTop;
        varying float vAlpha;
        void main() {
          // Soft across (no hard ribbon edges), fading in just under the surface and out with length
          // (a soft hump, no bright core: light in water, not a neon tube)
          float across = 1.0 - abs(vUv.x);
          across = across * across * 0.6 + across * 0.4 * across * (3.0 - 2.0 * across) * across;
          float along = smoothstep(0.0, 0.08, vUv.y) * pow(1.0 - vUv.y, 1.6);
          // Gone into the bed: fade over the last metre above it
          vec2 bedUv = (vW.xz + ${(HALF + 0.5).toFixed(1)}) / ${V.toFixed(1)};
          float inIsland = step(abs(vW.x), ${HALF.toFixed(1)}) * step(abs(vW.z), ${HALF.toFixed(1)});
          float bedY = mix(${SEA_FLOOR_Y.toFixed(2)}, texture2D(uWsBed, bedUv).r, inIsland);
          float bed = smoothstep(bedY, bedY + 1.2, vW.y);
          // Close to the eye a ribbon would fill the screen: fade it out there
          float dc = distance(vW, cameraPosition);
          float near = smoothstep(0.8, 3.0, dc);
          // Flicker with the caustics where the ribbon enters the water (a slightly blurred tap)
          float t = uCausticsTime * uCausticsParams.z * uLsFlicker;
          vec2 cuv = vTop.xz * uCausticsParams.y * 0.35 + vec2(t * 0.022, t * 0.014) + vec2(vUv.x * 0.05, vTop.w);
          float fl = 0.45 + 1.1 * texture2D(uCausticsMap, cuv, 2.0).g;
          // A slow, uneven beat along each ribbon so it does not read as a flat stripe
          fl *= 0.75 + 0.25 * sin(vUv.y * 5.0 - t * 1.3 + vTop.w * 6.28);
          float a = across * along * bed * near * fl * vAlpha;
          if (a < 0.002) discard;
          gl_FragColor = vec4(uLsColor * a, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_SHAFTS);
    this.mesh.name = 'UnderwaterLightShafts';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    // After the other transparent things under water (bubbles, snow): it only adds light
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
    for (let i = 0; i < MAX_SHAFTS; i++) this.shafts.push({ x: 0, y: 0, z: 0, t: 0, life: 0, seed: 0, w: 1, l: 1 });
  }

  public update(dt: number, camera: THREE.Camera, light: ShaftLight): void {
    const s = lightShaftSettings;
    const sun = light.sunDir;
    const sunUp = THREE.MathUtils.smoothstep(sun.y, 0.02, 0.25);
    const amount = s.enabled
      ? s.strength * light.underwater * (1 - light.night) * sunUp * (1 - light.cover * 0.75) * (1 - light.cave)
      : 0;
    if (amount < 0.003) {
      if (this.mesh.visible) {
        this.mesh.visible = false;
        for (const sh of this.shafts) sh.t = sh.life = 0;
      }
      return;
    }
    this.mesh.visible = true;

    // Refracted sun direction (Snell, water 1.33): steeper under water than in the air
    const sy = Math.max(sun.y, 0.15);
    const eta = 1 / 1.33;
    const k = 1 - eta * eta * (1 - sy * sy);
    // t = eta * i + (eta * cos - sqrt(k)) * up, i = -sun: the horizontal part shrinks by eta
    this.uniforms.uLsDir.value.set(-sun.x * eta, -Math.sqrt(Math.max(k, 0)), -sun.z * eta).normalize();
    // Watery blue-green, a little of the sun's own tint, dimmer when the sun is low
    this.uniforms.uLsColor.value.setRGB(0.55, 0.85, 0.9).lerp(light.sunColor, 0.25).multiplyScalar(amount);
    this.uniforms.uLsFlicker.value = s.flicker;

    // Spawn / age the ribbons
    const want = Math.min(MAX_SHAFTS, Math.round(MOBILE ? s.count * 0.5 : s.count));
    const cam = camera.position;
    const fwd = camera.getWorldDirection(LightShafts._f);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    for (let i = 0; i < MAX_SHAFTS; i++) {
      const sh = this.shafts[i];
      if (sh.life > 0) {
        sh.t += dt;
        // Too far from the camera now (it swam on): let it go early
        const far = Math.hypot(sh.x - cam.x, sh.z - cam.z) > s.radius * 1.4;
        if (sh.t >= sh.life || i >= want || far) {
          if (far && sh.t < sh.life - 1) sh.t = sh.life - 1;
          if (sh.t >= sh.life || i >= want) sh.life = sh.t = 0;
        }
      }
      if (sh.life <= 0 && i < want) this.spawn(sh, cam, fwd, s, i);
    }

    let n = 0;
    const top = this.aTop.array as Float32Array;
    const size = this.aSize.array as Float32Array;
    for (const sh of this.shafts) {
      if (sh.life <= 0) continue;
      const p = sh.t / sh.life;
      // Fade in and out over a second each (or a third of a short life)
      const edge = Math.min(1, sh.life / 3);
      const a = Math.min(1, sh.t / edge, (sh.life - sh.t) / edge) * (0.6 + 0.4 * Math.sin(p * Math.PI));
      top[n * 4] = sh.x;
      top[n * 4 + 1] = sh.y;
      top[n * 4 + 2] = sh.z;
      top[n * 4 + 3] = sh.seed;
      size[n * 4] = s.width * sh.w;
      size[n * 4 + 1] = s.length * sh.l;
      size[n * 4 + 2] = Math.max(0, a);
      n++;
    }
    this.mesh.count = n;
    this.aTop.needsUpdate = true;
    this.aSize.needsUpdate = true;
  }

  /** A new ribbon somewhere around the camera, mostly in front of it, where the water is deep enough. */
  private spawn(sh: Shaft, cam: THREE.Vector3, fwd: THREE.Vector3, s: LightShaftSettings, i: number): void {
    for (let tries = 0; tries < 6; tries++) {
      // Mostly ahead (a 200° fan), at 2 m .. radius
      const ang = Math.atan2(fwd.x, fwd.z) + (Math.random() - 0.5) * Math.PI * 1.1;
      const r = 2 + Math.sqrt(Math.random()) * Math.max(1, s.radius - 2);
      const x = cam.x + Math.sin(ang) * r;
      const z = cam.z + Math.cos(ang) * r;
      const surface = Math.max(worldSettings.waterLevel, riverWorld.waterLevelAt(x, z));
      // Only the camera's own water (not a river high above the sea it dives in)
      if (surface < cam.y) continue;
      sh.x = x;
      sh.z = z;
      sh.y = surface - 0.05;
      sh.life = s.life * (0.7 + Math.random() * 0.6);
      sh.t = 0;
      sh.seed = Math.random();
      sh.w = 0.6 + Math.random() * 0.8;
      sh.l = 0.7 + Math.random() * 0.5;
      if (i % 3 === 1) sh.life *= 0.6;
      return;
    }
  }
}
