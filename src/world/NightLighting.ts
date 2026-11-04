import * as THREE from 'three';
import { isMobileDevice } from './WorldSettings';
import type { PropSystem } from './PropSystem';
import type { WeatherSystem } from './WeatherSystem';

/**
 * Cheap night lighting for mobile-friendly scenes.
 *
 * Real THREE.PointLights cost a lighting pass in every lit shader and force a recompile whenever their
 * number changes. Instead every lit built-in material gets a small loop over a fixed-size uniform
 * array of "fake" point lights (position + range, colour). The CPU picks the lights nearest to the
 * camera that can touch the view a few times per second and fades them in and out of the slots;
 * `uFakeLightCount` is 0 during the day so the loop is skipped.
 *
 * Positions are sent in VIEW space (transformed once per frame on the CPU), so the shader needs no
 * extra varying or per-light matrix multiply, and pixels outside a light's range skip it early.
 */
export const MAX_FAKE_LIGHTS = isMobileDevice() ? 6 : 12;

export const nightLightUniforms = {
  /** xyz = view-space position, w = range. */
  uFakeLightPos: { value: Array.from({ length: MAX_FAKE_LIGHTS }, () => new THREE.Vector4()) },
  uFakeLightColor: { value: Array.from({ length: MAX_FAKE_LIGHTS }, () => new THREE.Color(0, 0, 0)) },
  uFakeLightCount: { value: 0 },
};

interface PatchableShader {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

const LIGHT_DECL = `
      #define MAX_FAKE_LIGHTS ${MAX_FAKE_LIGHTS}
      uniform vec4 uFakeLightPos[MAX_FAKE_LIGHTS];
      uniform vec3 uFakeLightColor[MAX_FAKE_LIGHTS];
      uniform int uFakeLightCount;
      // p = view-space position, n = view-space unit normal
      vec3 fakeNightLight(vec3 p, vec3 n) {
        vec3 sum = vec3(0.0);
        for (int i = 0; i < MAX_FAKE_LIGHTS; i++) {
          if (i >= uFakeLightCount) break;
          vec3 toLight = uFakeLightPos[i].xyz - p;
          float r = uFakeLightPos[i].w;
          float d2 = dot(toLight, toLight);
          if (d2 >= r * r) continue; // out of range: skip the rest
          float att = 1.0 - d2 / (r * r);
          att *= att;
          // Wrapped Lambert keeps the pools soft and readable on the back side of objects
          float ndl = max(dot(n, toLight * inversesqrt(max(d2, 1e-4))), 0.0) * 0.7 + 0.3;
          sum += uFakeLightColor[i] * (att * ndl);
        }
        return sum;
      }`;

/**
 * Adds the fake light loop to a lit built-in shader. Safe to call more than once.
 * `perVertex` evaluates the lights per vertex instead of per pixel: only for dense meshes
 * (the 1 m terrain), where it looks the same and costs a fraction on phones.
 */
export function injectNightLights(shader: PatchableShader, opts: { perVertex?: boolean } = {}): void {
  if (shader.fragmentShader.includes('uFakeLightCount') || shader.vertexShader.includes('uFakeLightCount')) return;
  if (!shader.fragmentShader.includes('#include <opaque_fragment>') || !shader.vertexShader.includes('#include <project_vertex>')) return;

  Object.assign(shader.uniforms, nightLightUniforms);

  if (opts.perVertex) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vNightLight;${LIGHT_DECL}`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
      vNightLight = uFakeLightCount > 0 ? fakeNightLight(mvPosition.xyz, normalize(transformedNormal)) : vec3(0.0);`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNightLight;')
      .replace('#include <opaque_fragment>', 'outgoingLight += diffuseColor.rgb * vNightLight;\n#include <opaque_fragment>');
    return;
  }

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>${LIGHT_DECL}`)
    .replace(
      '#include <opaque_fragment>',
      `if (uFakeLightCount > 0) outgoingLight += diffuseColor.rgb * fakeNightLight(-vViewPosition, normal);
      #include <opaque_fragment>`
    );
}

let installed = false;

/**
 * Patches every lit built-in material through the Material prototype, so materials created later
 * (buildings, crops, furniture) get night lights without any registration. Materials that set their
 * own onBeforeCompile must call injectNightLights themselves.
 */
export function installGlobalNightLights(): void {
  if (installed) return;
  installed = true;
  const proto = THREE.Material.prototype as unknown as {
    onBeforeCompile: (this: THREE.Material, shader: PatchableShader) => void;
  };
  proto.onBeforeCompile = function (shader) {
    const m = this as THREE.Material & Record<string, unknown>;
    if (m.isMeshLambertMaterial || m.isMeshStandardMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial) {
      injectNightLights(shader);
    }
  };
}

// ------------------------------------------------------------------ light sources

/** A light provided by something other than props (e.g. lamp furniture in buildings). */
export interface ExtraLight {
  x: number;
  y: number;
  z: number;
  range: number;
  halo: number;
  /** Multiplier on the warm lamp colour (street lamps are 1). */
  intensity: number;
  /** Linear RGB instead of the warm lamp colour (glowing cave crystals). */
  color?: [number, number, number];
  /** Torch-like flicker. */
  flicker?: boolean;
}

interface LightSource {
  pos: THREE.Vector3;
  range: number;
  color: THREE.Color;
  flicker: number; // 0 = steady, 1 = campfire
  seed: number;
}

const LAMP_COLOR = new THREE.Color(1.0, 0.72, 0.38).multiplyScalar(1.7);
const FIRE_COLOR = new THREE.Color(1.0, 0.48, 0.18).multiplyScalar(2.1);
const PLAYER_COLOR = new THREE.Color(1.0, 0.78, 0.55).multiplyScalar(0.45);
const MAX_HALOS = 96;

/**
 * Feeds the fake light uniforms from lamps and campfires placed with PropSystem, draws soft additive
 * halos around them (one draw call) and switches lamp bulbs on at dusk.
 */
export class NightLighting {
  private sources: LightSource[] = [];
  private lastPropsRevision = -1;
  private extraProvider: (() => ExtraLight[]) | null = null;
  private extraRevision: (() => number) | null = null;
  private extraKey = NaN;
  private extraTimer = 0;
  private readonly glowBulbs: THREE.MeshBasicMaterial[] = [];
  private readonly glowShades: THREE.MeshLambertMaterial[] = [];
  private selectTimer = 0;
  /** Wanted sources (nearest that can reach the view), refreshed a few times per second. */
  private wanted: LightSource[] = [];
  /** Sources holding a uniform slot, with their fade weight (0..1). */
  private readonly slots: { s: LightSource; w: number }[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  /** 0..1 darkness forced regardless of the clock (inside caves): lights and the player lantern come on. */
  public forcedDark = 0;
  private time = 0;

  private readonly halos: THREE.Points;
  private readonly haloMat: THREE.ShaderMaterial;
  private readonly haloPos = new Float32Array(MAX_HALOS * 3);
  private readonly haloSize = new Float32Array(MAX_HALOS);
  private readonly haloColor = new Float32Array(MAX_HALOS * 3);
  private readonly tmp = new THREE.Vector3();
  private readonly viewPos = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private readonly props: PropSystem,
    private readonly weather: WeatherSystem,
    private readonly bulbMaterials: { lamp: THREE.MeshBasicMaterial; fire: THREE.MeshBasicMaterial }
  ) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.haloPos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.haloSize, 1));
    geo.setAttribute('haloColor', new THREE.BufferAttribute(this.haloColor, 3));
    geo.setDrawRange(0, 0);
    this.haloMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uNight: { value: 0 }, uTime: { value: 0 }, uScale: { value: 1 } },
      vertexShader: `
        attribute float size;
        attribute vec3 haloColor;
        uniform float uNight, uTime, uScale;
        varying vec3 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float pulse = 0.94 + 0.06 * sin(uTime * 7.0 + position.x * 3.1 + position.z * 1.7);
          gl_PointSize = size * pulse * uScale / -mv.z;
          vColor = haloColor * uNight;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = exp(-d * d * 4.0) * (1.0 - d);
          if (a <= 0.004) discard;
          gl_FragColor = vec4(vColor * a, 1.0);
        }`,
    });
    this.halos = new THREE.Points(geo, this.haloMat);
    this.halos.frustumCulled = false;
    this.halos.renderOrder = 10;
    scene.add(this.halos);
  }

  /**
   * Extra light sources, plus a revision counter that changes whenever they may have (checked twice
   * a second; without one the provider's positions are hashed), plus the
   * materials that should glow with them: bulbs follow the prop lamp bulbs, shades get emissive.
   */
  public setExtraLights(
    provider: () => ExtraLight[],
    glow: { bulbs?: THREE.MeshBasicMaterial[]; shades?: THREE.MeshLambertMaterial[] } = {},
    revision?: () => number
  ): void {
    this.extraProvider = provider;
    this.extraRevision = revision ?? null;
    this.glowBulbs.push(...(glow.bulbs ?? []));
    this.glowShades.push(...(glow.shades ?? []));
    this.extraTimer = 0;
  }

  /** Viewport height drives point sizes so halos keep their world size at any resolution. */
  public setViewportHeight(px: number): void {
    this.haloMat.uniforms.uScale.value = px * 0.9;
  }

  /**
   * Call after the camera has moved for this frame (light positions are sent in its view space).
   */
  public update(dt: number, camera: THREE.Camera, playerPos: THREE.Vector3 | null): void {
    this.time += dt;
    const night = Math.max(this.weather.nightFactor, this.forcedDark);

    // Bulbs: dim warm glass by day, bright at night
    this.bulbMaterials.lamp.color.setRGB(0.78 + 0.22 * night, 0.72 + 0.2 * night, 0.55 + 0.1 * night);
    const fireFlicker = 0.85 + 0.15 * Math.sin(this.time * 17) * Math.sin(this.time * 7.3);
    this.bulbMaterials.fire.color.setRGB(1, 0.5 + 0.12 * fireFlicker, 0.16);
    for (const m of this.glowBulbs) m.color.copy(this.bulbMaterials.lamp.color);
    for (const m of this.glowShades) m.emissive.setRGB(0.3 * night, 0.22 * night, 0.11 * night);

    let rebuild = false;
    if (this.props.revision !== this.lastPropsRevision) {
      this.lastPropsRevision = this.props.revision;
      rebuild = true;
    }
    this.extraTimer -= dt;
    if (this.extraProvider && this.extraTimer <= 0) {
      this.extraTimer = 0.5;
      let key: number;
      if (this.extraRevision) key = this.extraRevision();
      else {
        key = 0;
        for (const l of this.extraProvider()) key = (key * 31 + l.x * 7.13 + l.y * 3.7 + l.z * 1.31) % 1e9;
      }
      if (key !== this.extraKey) {
        this.extraKey = key;
        rebuild = true;
      }
    }
    if (rebuild) this.rebuildSources();

    this.haloMat.uniforms.uNight.value = night;
    this.haloMat.uniforms.uTime.value = this.time;
    this.halos.visible = night > 0.02;

    const u = nightLightUniforms;
    if (night < 0.02) {
      u.uFakeLightCount.value = 0;
      this.slots.length = 0;
      this.selectTimer = 0;
      return;
    }

    camera.updateMatrixWorld();
    const view = camera.matrixWorldInverse;
    const cameraPos = this.tmp.setFromMatrixPosition(camera.matrixWorld);
    const maxFromProps = playerPos ? MAX_FAKE_LIGHTS - 1 : MAX_FAKE_LIGHTS;

    // Wanted: the nearest sources whose light sphere touches the view frustum (lights behind the
    // camera would waste a slot), a few times per second
    this.selectTimer -= dt;
    if (this.selectTimer <= 0) {
      this.selectTimer = 0.25;
      this.projScreen.multiplyMatrices(camera.projectionMatrix, view);
      this.frustum.setFromProjectionMatrix(this.projScreen);
      const cand: { s: LightSource; d: number }[] = [];
      for (const src of this.sources) {
        this.sphere.center.copy(src.pos);
        this.sphere.radius = src.range;
        if (this.frustum.intersectsSphere(this.sphere)) cand.push({ s: src, d: src.pos.distanceToSquared(cameraPos) });
      }
      cand.sort((a, b) => a.d - b.d);
      this.wanted = cand.slice(0, maxFromProps).map((c) => c.s);
    }

    // Slots fade in / out instead of popping: a source that is no longer wanted fades out, and a
    // newly wanted one takes a slot as soon as one is free
    const fade = dt * 4;
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const slot = this.slots[i];
      slot.w = this.wanted.includes(slot.s) ? Math.min(1, slot.w + fade) : slot.w - fade;
      if (slot.w <= 0) this.slots.splice(i, 1);
    }
    for (const src of this.wanted) {
      if (this.slots.length >= maxFromProps) break;
      if (!this.slots.some((sl) => sl.s === src)) this.slots.push({ s: src, w: 0 });
    }

    let n = 0;
    const v = this.viewPos;
    for (const { s, w } of this.slots) {
      const flicker = s.flicker ? 0.82 + 0.18 * Math.sin(this.time * (11 + s.seed * 5) + s.seed * 20) * Math.sin(this.time * 4.7) : 1;
      v.copy(s.pos).applyMatrix4(view);
      u.uFakeLightPos.value[n].set(v.x, v.y, v.z, s.range);
      u.uFakeLightColor.value[n].copy(s.color).multiplyScalar(night * flicker * w * w * (3 - 2 * w));
      n++;
    }
    if (playerPos && n < MAX_FAKE_LIGHTS) {
      // Soft lantern glow around the player so the night stays playable away from lamps
      v.set(playerPos.x, playerPos.y + 1.4, playerPos.z).applyMatrix4(view);
      u.uFakeLightPos.value[n].set(v.x, v.y, v.z, 5.5 + this.forcedDark * 3.5);
      u.uFakeLightColor.value[n].copy(PLAYER_COLOR).multiplyScalar(night);
      n++;
    }
    u.uFakeLightCount.value = n;
  }

  private rebuildSources(): void {
    this.sources = [];
    let h = 0;
    for (const p of this.props.list()) {
      const isLamp = p.type === 'lamp';
      if (!isLamp && p.type !== 'campfire') continue;
      const yOff = (isLamp ? 2.48 : 0.6) * p.scale;
      const pos = new THREE.Vector3(p.position.x, p.position.y + yOff, p.position.z);
      this.sources.push({
        pos,
        range: (isLamp ? 9 : 7.5) * p.scale,
        color: isLamp ? LAMP_COLOR : FIRE_COLOR,
        flicker: isLamp ? 0 : 1,
        seed: Math.random(),
      });
      if (h < MAX_HALOS) {
        this.haloPos.set([pos.x, pos.y, pos.z], h * 3);
        this.haloSize[h] = (isLamp ? 2.6 : 3.4) * p.scale;
        const c = isLamp ? [1.0, 0.8, 0.5] : [1.0, 0.55, 0.22];
        this.haloColor.set(c.map((v) => v * 0.55), h * 3);
        h++;
      }
    }
    for (const l of this.extraProvider?.() ?? []) {
      const pos = new THREE.Vector3(l.x, l.y, l.z);
      const color = l.color ? new THREE.Color(...l.color) : LAMP_COLOR.clone();
      this.sources.push({ pos, range: l.range, color: color.multiplyScalar(l.intensity), flicker: l.flicker ? 1 : 0, seed: Math.random() });
      if (h < MAX_HALOS) {
        this.haloPos.set([pos.x, pos.y, pos.z], h * 3);
        this.haloSize[h] = l.halo;
        this.haloColor.set((l.color ?? [0.55, 0.44, 0.27]).map((c) => c * (l.color ? 0.45 : 1) * (0.4 + l.intensity)), h * 3);
        h++;
      }
    }
    const geo = this.halos.geometry;
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.haloColor as THREE.BufferAttribute).needsUpdate = true;
    geo.setDrawRange(0, h);
    this.selectTimer = 0;
    // Sources were recreated: keep the fade of lights that are still there (same position)
    for (const slot of this.slots) {
      const same = this.sources.find((src) => src.pos.equals(slot.s.pos));
      if (same) slot.s = same;
    }
  }
}
