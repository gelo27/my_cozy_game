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
 * camera a few times per second; `uFakeLightCount` is 0 during the day so the loop is skipped.
 */
export const MAX_FAKE_LIGHTS = isMobileDevice() ? 6 : 12;

export const nightLightUniforms = {
  uFakeLightPos: { value: Array.from({ length: MAX_FAKE_LIGHTS }, () => new THREE.Vector4()) },
  uFakeLightColor: { value: Array.from({ length: MAX_FAKE_LIGHTS }, () => new THREE.Color(0, 0, 0)) },
  uFakeLightCount: { value: 0 },
};

interface PatchableShader {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

/** Adds the fake light loop to a lit built-in shader. Safe to call more than once. */
export function injectNightLights(shader: PatchableShader): void {
  if (shader.fragmentShader.includes('uFakeLightPos')) return;
  if (!shader.fragmentShader.includes('#include <opaque_fragment>') || !shader.vertexShader.includes('#include <project_vertex>')) return;

  Object.assign(shader.uniforms, nightLightUniforms);

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vNightWorldPos;')
    .replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vec4 nightWp = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        nightWp = instanceMatrix * nightWp;
      #endif
      vNightWorldPos = (modelMatrix * nightWp).xyz;`
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      #define MAX_FAKE_LIGHTS ${MAX_FAKE_LIGHTS}
      varying vec3 vNightWorldPos;
      uniform vec4 uFakeLightPos[MAX_FAKE_LIGHTS];
      uniform vec3 uFakeLightColor[MAX_FAKE_LIGHTS];
      uniform int uFakeLightCount;`
    )
    .replace(
      '#include <opaque_fragment>',
      `
      vec3 nightLight = vec3(0.0);
      for (int i = 0; i < MAX_FAKE_LIGHTS; i++) {
        if (i >= uFakeLightCount) break;
        vec3 toLight = uFakeLightPos[i].xyz - vNightWorldPos;
        float d = length(toLight) / uFakeLightPos[i].w;
        float att = clamp(1.0 - d * d, 0.0, 1.0);
        att *= att;
        // Wrapped Lambert keeps the pools soft and readable on the back side of objects
        vec3 lv = normalize((viewMatrix * vec4(toLight, 0.0)).xyz);
        float ndl = max(dot(normal, lv), 0.0) * 0.7 + 0.3;
        nightLight += uFakeLightColor[i] * att * ndl;
      }
      outgoingLight += diffuseColor.rgb * nightLight;
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
  private selectTimer = 0;
  private selected: LightSource[] = [];
  private time = 0;

  private readonly halos: THREE.Points;
  private readonly haloMat: THREE.ShaderMaterial;
  private readonly haloPos = new Float32Array(MAX_HALOS * 3);
  private readonly haloSize = new Float32Array(MAX_HALOS);
  private readonly haloColor = new Float32Array(MAX_HALOS * 3);
  private readonly tmp = new THREE.Vector3();

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

  /** Viewport height drives point sizes so halos keep their world size at any resolution. */
  public setViewportHeight(px: number): void {
    this.haloMat.uniforms.uScale.value = px * 0.9;
  }

  public update(dt: number, cameraPos: THREE.Vector3, playerPos: THREE.Vector3 | null): void {
    this.time += dt;
    const night = this.weather.nightFactor;

    // Bulbs: dim warm glass by day, bright at night
    this.bulbMaterials.lamp.color.setRGB(0.78 + 0.22 * night, 0.72 + 0.2 * night, 0.55 + 0.1 * night);
    const fireFlicker = 0.85 + 0.15 * Math.sin(this.time * 17) * Math.sin(this.time * 7.3);
    this.bulbMaterials.fire.color.setRGB(1, 0.5 + 0.12 * fireFlicker, 0.16);

    if (this.props.revision !== this.lastPropsRevision) {
      this.lastPropsRevision = this.props.revision;
      this.rebuildSources();
    }

    this.haloMat.uniforms.uNight.value = night;
    this.haloMat.uniforms.uTime.value = this.time;
    this.halos.visible = night > 0.02;

    const u = nightLightUniforms;
    if (night < 0.02) {
      u.uFakeLightCount.value = 0;
      return;
    }

    // Choose the nearest sources a few times per second; colours update every frame for flicker
    this.selectTimer -= dt;
    if (this.selectTimer <= 0) {
      this.selectTimer = 0.25;
      const maxFromProps = playerPos ? MAX_FAKE_LIGHTS - 1 : MAX_FAKE_LIGHTS;
      this.selected = this.sources
        .map((s) => ({ s, d: s.pos.distanceToSquared(cameraPos) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, maxFromProps)
        .map((e) => e.s);
    }

    let n = 0;
    for (const s of this.selected) {
      const flicker = s.flicker ? 0.82 + 0.18 * Math.sin(this.time * (11 + s.seed * 5) + s.seed * 20) * Math.sin(this.time * 4.7) : 1;
      u.uFakeLightPos.value[n].set(s.pos.x, s.pos.y, s.pos.z, s.range);
      u.uFakeLightColor.value[n].copy(s.color).multiplyScalar(night * flicker);
      n++;
    }
    if (playerPos && n < MAX_FAKE_LIGHTS) {
      // Soft lantern glow around the player so the night stays playable away from lamps
      this.tmp.copy(playerPos);
      u.uFakeLightPos.value[n].set(this.tmp.x, this.tmp.y + 1.4, this.tmp.z, 5.5);
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
    const geo = this.halos.geometry;
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.haloColor as THREE.BufferAttribute).needsUpdate = true;
    geo.setDrawRange(0, h);
    this.selectTimer = 0;
  }
}
