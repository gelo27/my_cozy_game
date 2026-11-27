import * as THREE from 'three';
import { injectPlayerShadow } from '../character/PlayerShadow';
import { isMobileDevice } from './WorldSettings';
import { FlameField, fireFx, type FlameSpot } from './FlameField';
import type { PropSystem } from './PropSystem';
import type { WeatherSystem } from './WeatherSystem';
import { injectWaterline } from '../scene/WaterDetails';
import { CLOUD_SHADOW_BEGIN, CLOUD_SHADOW_END, CLOUD_SHADOW_GLSL, cloudShadowUniforms } from './CloudShadows';
import { injectInteriorShade, type InteriorLighting, type InteriorRoom } from './InteriorLighting';
import { GROUND_LIGHT_GLSL, GroundLightBaker, groundLightUniforms, type BakedLamp, type WindowSpill } from './GroundLight';

/**
 * Cheap night lighting for mobile-friendly scenes.
 *
 * Real THREE.PointLights cost a lighting pass in every lit shader and force a recompile whenever their
 * number changes. Instead every lit built-in material gets a small loop over a fixed-size uniform
 * array of "fake" point lights (position + range, colour). The CPU picks the lights nearest to the
 * camera that can touch the view a few times per second and fades them in and out of the slots;
 * `uFakeLightCount` is 0 in daylight unless the player has activated a room's lamps.
 *
 * Positions are sent in VIEW space (transformed once per frame on the CPU), so the shader needs no
 * extra varying or per-light matrix multiply, and pixels outside a light's range skip it early.
 *
 * A coarse world grid (FAKE_GRID_CELL metres per cell, one texel each) holds a bit mask of the slots
 * whose light can reach the cell; a pixel reads its cell once and runs the loop only for those, so
 * pixels away from every lamp (most of the night scene) skip it entirely, and the slot count can be
 * higher than the cost of a full loop would allow. The grid is rewritten only when the slots change.
 */
export const MAX_FAKE_LIGHTS = isMobileDevice() ? 12 : 24;
/** Light grid: cells over the island, in metres; pixels outside it test every slot. */
const FAKE_GRID_CELL = 4;
const FAKE_GRID_N = 128;
const FAKE_GRID_MIN = -(FAKE_GRID_N * FAKE_GRID_CELL) / 2;
/** Grid margin on a light's range: rain and snow catch light a little farther out (Precipitation). */
const GRID_RANGE_PAD = 1.25;
/**
 * A room lamp takes a slot only while the camera or the player is within this of its room: near
 * enough to see the room lit through its windows and doors; farther, only the window glow shows.
 */
const ROOM_LAMP_NEAR = 20;

const fakeGridData = new Uint8Array(FAKE_GRID_N * FAKE_GRID_N * 4);
const fakeGridTexture = new THREE.DataTexture(fakeGridData, FAKE_GRID_N, FAKE_GRID_N, THREE.RGBAFormat, THREE.UnsignedByteType);
fakeGridTexture.magFilter = THREE.NearestFilter;
fakeGridTexture.minFilter = THREE.NearestFilter;
fakeGridTexture.generateMipmaps = false;
fakeGridTexture.needsUpdate = true;

/**
 * Options for overdrawn double-sided foliage (tree crowns, bushes, flowers, field crops): on phones
 * the lights are evaluated per vertex, since alpha-tested leaf layers run the light loop several
 * times per screen pixel; leaves are small enough that per-vertex light looks the same.
 */
export const FOLIAGE_NIGHT_LIGHTS = isMobileDevice() ? { perVertex: true, twoSided: true } : {};

/**
 * How the fake lights shade surfaces (dev panel, saved in this browser):
 * - `legacy`: Lambert lifted by a flat 0.3, so even surfaces facing away get some light;
 * - `wrap`: true wrapped Lambert, surfaces facing away from the light stay dark;
 * - `room`: `wrap` plus the light clipped to its room box (walls / floors around lamps in buildings).
 */
export type NightLightMode = 'legacy' | 'wrap' | 'room';
export const NIGHT_LIGHT_MODES: NightLightMode[] = ['legacy', 'wrap', 'room'];
const MODE_STORAGE_KEY = 'nightLightMode';

function loadMode(): NightLightMode {
  try {
    const v = localStorage.getItem(MODE_STORAGE_KEY) as NightLightMode | null;
    if (v && NIGHT_LIGHT_MODES.includes(v)) return v;
  } catch {
    // storage disabled: default
  }
  return 'room';
}

export const nightLightSettings = { mode: loadMode() };

export function setNightLightMode(mode: NightLightMode): void {
  nightLightSettings.mode = mode;
  nightLightUniforms.uFakeLightMode.value = NIGHT_LIGHT_MODES.indexOf(mode);
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // storage full / disabled: the mode simply does not persist
  }
}

export const nightLightUniforms = {
  /** xyz = view-space position, w = range. */
  uFakeLightPos: { value: Array.from({ length: MAX_FAKE_LIGHTS }, () => new THREE.Vector4()) },
  uFakeLightColor: { value: Array.from({ length: MAX_FAKE_LIGHTS }, () => new THREE.Color(0, 0, 0)) },
  uFakeLightCount: { value: 0 },
  /** Room box of each light in WORLD space: xyz = min, w = 1 when the light has a box. */
  uFakeLightBoxMin: { value: Array.from({ length: MAX_FAKE_LIGHTS }, () => new THREE.Vector4()) },
  uFakeLightBoxMax: { value: Array.from({ length: MAX_FAKE_LIGHTS }, () => new THREE.Vector3()) },
  /** Index in NIGHT_LIGHT_MODES. */
  uFakeLightMode: { value: NIGHT_LIGHT_MODES.indexOf(nightLightSettings.mode) },
  /** Per grid cell: bit i set = slot i can light it. */
  uFakeLightGrid: { value: fakeGridTexture },
  /** Slots lit everywhere regardless of the grid (the player lantern), as a bit mask. */
  uFakeLightAlways: { value: 0 },
  /** Slots whose light is baked on the ground (GroundLight): the ground skips them, as a bit mask. */
  uFakeLightBaked: { value: 0 },
};

/**
 * GLSL: `fakeLightMask(worldPos)` = bit mask of the slots that can reach this point (vertex or
 * fragment shaders, WebGL2). Shared with Precipitation.
 */
export const FAKE_LIGHT_MASK_GLSL = `
      uniform sampler2D uFakeLightGrid;
      uniform int uFakeLightAlways;
      uint fakeLightMask(vec3 wp) {
        vec2 g = (wp.xz - ${FAKE_GRID_MIN.toFixed(1)}) * ${(1 / FAKE_GRID_CELL).toFixed(4)};
        if (g.x < 0.0 || g.y < 0.0 || g.x >= ${FAKE_GRID_N.toFixed(1)} || g.y >= ${FAKE_GRID_N.toFixed(1)}) return 0xFFFFFFFFu;
        uvec4 m = uvec4(texelFetch(uFakeLightGrid, ivec2(g), 0) * 255.0 + 0.5);
        return (m.r | (m.g << 8) | (m.b << 16) | (m.a << 24)) | uint(uFakeLightAlways);
      }`;

/**
 * Low ground mist (snowfall): a pale layer within a couple of metres of the ground level around
 * the player, thickening with distance. Lives in the fog chunk of every material that gets the
 * night lights, so it costs one varying and a few ops per pixel, and nothing while uMist is 0.
 */
export const mistUniforms = {
  uMist: { value: 0 },
  /** World height of the mist's top (fades out over the 2.5 m below it). */
  uMistTop: { value: 0 },
  uMistColor: { value: new THREE.Color(1, 1, 1) },
};

/** `amount` 0..1, `topY` world height of the layer's top, `color` its tint (the fog's). */
export function setGroundMist(amount: number, topY: number, color: THREE.Color): void {
  mistUniforms.uMist.value = amount;
  mistUniforms.uMistTop.value = topY;
  mistUniforms.uMistColor.value.copy(color);
}

function injectGroundMist(shader: PatchableShader): void {
  if (!shader.vertexShader.includes('#include <fog_vertex>') || !shader.fragmentShader.includes('#include <fog_fragment>')) return;
  Object.assign(shader.uniforms, mistUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
#ifdef USE_FOG
varying float vMistY;
#endif`)
    // World height from the view-space position: the view matrix is rigid, so its inverse rotation
    // is the transpose (no extra uniform, works for instanced and batched meshes alike)
    .replace(
      '#include <fog_vertex>',
      `#include <fog_vertex>
      #ifdef USE_FOG
      vMistY = dot(viewMatrix[1].xyz, mvPosition.xyz - viewMatrix[3].xyz);
      #endif`
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
#ifdef USE_FOG
varying float vMistY;
uniform float uMist;
uniform float uMistTop;
uniform vec3 uMistColor;
#endif`)
    .replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
      if (uMist > 0.001) {
        float mistK = smoothstep(uMistTop, uMistTop - 2.5, vMistY) * smoothstep(3.0, 30.0, vFogDepth);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uMistColor, uMist * mistK * 0.6);
      }
      #endif
      #include <fog_fragment>`
    );
}

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
      uniform vec4 uFakeLightBoxMin[MAX_FAKE_LIGHTS];
      uniform vec3 uFakeLightBoxMax[MAX_FAKE_LIGHTS];
      uniform int uFakeLightMode; // 0 legacy, 1 wrap, 2 wrap + room box
      ${FAKE_LIGHT_MASK_GLSL}
      #ifdef FAKE_LIGHT_GROUND
      uniform int uFakeLightBaked;
      ${GROUND_LIGHT_GLSL}
      // The baked ground light shows even with no dynamic light in view
      #define FAKE_LIGHT_ON (uFakeLightCount > 0 || uGroundLightNight > 0.001)
      #else
      #define FAKE_LIGHT_ON (uFakeLightCount > 0)
      #endif
      // p = view-space position, n = view-space unit normal, outdoor = share of the lights without
      // a room (street lamps, campfires) reaching this pixel (less inside houses)
      vec3 fakeNightLight(vec3 p, vec3 n, float outdoor) {
        vec3 sum = vec3(0.0);
        // World position for the light grid and the room boxes: the view matrix is rigid, so its
        // inverse rotation is the transpose (once per pixel, not per light)
        vec3 q = p - viewMatrix[3].xyz;
        vec3 wp = vec3(dot(viewMatrix[0].xyz, q), dot(viewMatrix[1].xyz, q), dot(viewMatrix[2].xyz, q));
        // Only the slots whose light reaches this grid cell; none (most pixels at night) = no loop
        uint mask = fakeLightMask(wp);
        #ifdef FAKE_LIGHT_GROUND
        // The ground has the steady lamps and the window spill baked: one fetch, any distance
        sum += groundBakedLight(wp) * outdoor;
        mask &= ~uint(uFakeLightBaked);
        #endif
        if (mask == 0u) return sum;
        for (int i = 0; i < MAX_FAKE_LIGHTS; i++) {
          if (i >= uFakeLightCount) break;
          if (((mask >> uint(i)) & 1u) == 0u) continue;
          vec3 toLight = uFakeLightPos[i].xyz - p;
          float r = uFakeLightPos[i].w;
          float d2 = dot(toLight, toLight);
          if (d2 >= r * r) continue; // out of range: skip the rest
          float att = 1.0 - d2 / (r * r);
          att *= att;
          if (uFakeLightMode == 2 && uFakeLightBoxMin[i].w > 0.5) {
            // Outside the room box (past the walls' inner faces) the light fades out within 12 cm,
            // less than a wall is thick; pixels fully outside skip the shading below
            vec3 o = max(max(uFakeLightBoxMin[i].xyz - wp, wp - uFakeLightBoxMax[i]), 0.0);
            float out_ = max(o.x, max(o.y, o.z));
            if (out_ >= 0.12) continue;
            att *= 1.0 - smoothstep(0.0, 0.12, out_);
          } else {
            if (outdoor <= 0.001) continue;
            att *= outdoor;
          }
          float nl = dot(n, toLight * inversesqrt(max(d2, 1e-4)));
          #ifdef FAKE_LIGHT_TWO_SIDED
          // Per-vertex double-sided foliage: the vertex normal cannot be flipped for back faces, so
          // a leaf is lit from either side (thin leaves let the light through anyway)
          nl = abs(nl);
          #endif
          float ndl;
          if (uFakeLightMode == 0) {
            // Legacy: Lambert lifted by a flat 0.3 (back faces get light too)
            ndl = max(nl, 0.0) * 0.7 + 0.3;
          } else {
            // Wrapped Lambert: the terminator creeps a little past the equator so objects keep soft
            // pools, but surfaces facing away from the light (the outer side of a wall) stay dark
            const float WRAP = 0.25;
            ndl = max((nl + WRAP) * (1.0 / (1.0 + WRAP)), 0.0);
          }
          sum += uFakeLightColor[i] * (att * ndl);
        }
        return sum;
      }`;

/**
 * Adds the fake light loop to a lit built-in shader. Safe to call more than once.
 * `perVertex` evaluates the lights per vertex instead of per pixel: only for dense meshes
 * (the 1 m terrain) and, on phones, overdrawn foliage, where it looks the same and costs a fraction.
 * `twoSided` (per-vertex only) lights both sides of double-sided foliage.
 */
export function injectNightLights(shader: PatchableShader, opts: { perVertex?: boolean; twoSided?: boolean; ground?: boolean; playerShadow?: boolean } = {}): void {
  if (shader.fragmentShader.includes('uFakeLightCount') || shader.vertexShader.includes('uFakeLightCount')) return;
  if (!shader.fragmentShader.includes('#include <opaque_fragment>') || !shader.vertexShader.includes('#include <project_vertex>')) return;

  Object.assign(shader.uniforms, nightLightUniforms);
  if (opts.ground) Object.assign(shader.uniforms, groundLightUniforms);
  const groundDef = opts.ground ? '\n#define FAKE_LIGHT_GROUND' : '';
  injectCloudShadows(shader);
  injectGroundMist(shader);
  if (opts.playerShadow) injectPlayerShadow(shader);
  // Daylight dimmed inside houses (per-pixel materials only: the per-vertex ones are the terrain,
  // which lies under the floors, and phone foliage)
  if (!opts.perVertex) injectInteriorShade(shader);

  if (opts.perVertex) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vNightLight;${opts.twoSided ? '\n#define FAKE_LIGHT_TWO_SIDED' : ''}${groundDef}${LIGHT_DECL}`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
      vNightLight = FAKE_LIGHT_ON ? fakeNightLight(mvPosition.xyz, normalize(transformedNormal), 1.0) : vec3(0.0);`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNightLight;')
      .replace('#include <opaque_fragment>', 'outgoingLight += diffuseColor.rgb * vNightLight;\n#include <opaque_fragment>');
    return;
  }

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>${groundDef}${LIGHT_DECL}`)
    .replace(
      '#include <opaque_fragment>',
      `#ifdef INTERIOR_SHADE
      // Street lamps fade inside houses like daylight: gone deep in a room, a little by windows and doors
      float fakeOutdoor = 1.0 - intDark;
      #else
      float fakeOutdoor = 1.0;
      #endif
      if (FAKE_LIGHT_ON) outgoingLight += diffuseColor.rgb * fakeNightLight(-vViewPosition, normal, fakeOutdoor);
      #include <opaque_fragment>`
    );
}

/**
 * Cloud shadows (CloudShadows.ts) on the direct sun light. Every material that gets the night
 * lights gets these too, so the whole world sits under the same drifting patches.
 */
function injectCloudShadows(shader: PatchableShader): void {
  const fs = shader.fragmentShader;
  if (fs.includes('uCsMap') || !fs.includes('#include <lights_fragment_begin>') || !fs.includes('#include <lights_fragment_end>')) return;
  Object.assign(shader.uniforms, cloudShadowUniforms);
  shader.fragmentShader = fs
    .replace('#include <common>', `#include <common>
${CLOUD_SHADOW_GLSL}`)
    .replace('#include <lights_fragment_begin>', `${CLOUD_SHADOW_BEGIN}
#include <lights_fragment_begin>`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
${CLOUD_SHADOW_END}`);
}

let installed = false;

/**
 * Patches every lit built-in material through the Material prototype, so materials created later
 * (buildings, crops, furniture) get night lights without any registration. Materials that set their
 * own onBeforeCompile must call injectNightLights themselves. Also adds the white waterline
 * (`injectWaterline`) where objects cross the water.
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
      injectNightLights(shader, { playerShadow: true });
      injectWaterline(shader);
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
  /** World box the light stays inside (its room), for the `room` mode. */
  box?: THREE.Box3 | null;
  /** Furniture lamps can also light their house in daylight. */
  furniture?: boolean;
  /** A visible animated flame at this light (torches): base height and flame height in metres. */
  flame?: { y: number; size: number };
}

const byDistance = (a: { d: number }, b: { d: number }): number => a.d - b.d;

/** True when `p` lies within ROOM_LAMP_NEAR of the box. */
const nearBox = (b: THREE.Box3, p: THREE.Vector3): boolean =>
  p.x > b.min.x - ROOM_LAMP_NEAR && p.x < b.max.x + ROOM_LAMP_NEAR &&
  p.y > b.min.y - ROOM_LAMP_NEAR && p.y < b.max.y + ROOM_LAMP_NEAR &&
  p.z > b.min.z - ROOM_LAMP_NEAR && p.z < b.max.z + ROOM_LAMP_NEAR;

interface LightSource {
  pos: THREE.Vector3;
  range: number;
  color: THREE.Color;
  flicker: number; // 0 = steady, 1 = campfire
  seed: number;
  box: THREE.Box3 | null;
  furniture: boolean;
  /** Steady and outside any room: its light on the ground is baked (GroundLight). */
  baked: boolean;
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
  private occupancyTimer = 0;
  private occupiedRoom: InteriorRoom | null = null;
  private missedRoomSample = false;
  private readonly daySources = new Set<LightSource>();
  /** Wanted sources (nearest that can reach the view), refreshed a few times per second. */
  private readonly wanted: LightSource[] = [];
  private readonly cand: { s: LightSource; d: number }[] = [];
  private candPool: { s: LightSource; d: number }[] = [];
  /** Sources holding a uniform slot, with their fade weight (0..1). */
  private readonly slots: { s: LightSource; w: number; dayWeight: number }[] = [];
  /** Slot sources the light grid was last written for. */
  private readonly gridSlots: LightSource[] = [];
  private ground: {
    baker: GroundLightBaker;
    spills: () => readonly WindowSpill[];
    spillRevision: () => number;
    seenSpills: number;
  } | null = null;

  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  /** 0..1 darkness forced regardless of the clock (inside caves): lights and the player lantern come on. */
  public forcedDark = 0;
  /** The soft glow around the player at night. Off for now; set true to bring it back. */
  public playerLantern = false;
  private time = 0;

  private readonly halos: THREE.Points;
  private readonly haloMat: THREE.ShaderMaterial;
  private readonly haloPos = new Float32Array(MAX_HALOS * 3);
  private readonly haloSize = new Float32Array(MAX_HALOS);
  private readonly haloColor = new Float32Array(MAX_HALOS * 3);
  private readonly tmp = new THREE.Vector3();
  private readonly viewPos = new THREE.Vector3();
  /** Shader flames on campfires and torches (drawn by day too). */
  private readonly flames: FlameField;

  constructor(
    scene: THREE.Scene,
    private readonly props: PropSystem,
    private readonly weather: WeatherSystem,
    private readonly bulbMaterials: { lamp: THREE.MeshBasicMaterial; fire: THREE.MeshBasicMaterial },
    private readonly onDayLightSwitch?: (on: boolean) => void,
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
    this.flames = new FlameField(scene);
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

  /**
   * Bakes the steady lamps and the window spill onto the ground (GroundLight): `height` is the
   * terrain height, `spills` the lit windows / open doors (re-read when `spillRevision` changes).
   */
  public setGround(height: (x: number, z: number) => number, spills: () => readonly WindowSpill[], spillRevision: () => number): void {
    this.ground = { baker: new GroundLightBaker(height), spills, spillRevision, seenSpills: -1 };
    this.rebakeGround();
  }

  /** Ground bake statistics for the dev tools. */
  public get groundStats(): { lamps: number; spills: number; ms: number } | null {
    return this.ground?.baker.stats ?? null;
  }

  private rebakeGround(): void {
    const g = this.ground;
    if (!g) return;
    g.seenSpills = g.spillRevision();
    const lamps: BakedLamp[] = [];
    for (const s of this.sources) if (s.baked) lamps.push(s);
    g.baker.bake(lamps, g.spills());
  }

  /** Viewport height drives point sizes so halos keep their world size at any resolution. */
  public setViewportHeight(px: number): void {
    this.haloMat.uniforms.uScale.value = px * 0.9;
    this.flames.setViewportHeight(px);
  }

  /**
   * Call after the camera has moved for this frame (light positions are sent in its view space).
   */
  public update(dt: number, camera: THREE.Camera, playerPos: THREE.Vector3 | null, interiors: InteriorLighting): void {
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
    else if (this.ground && this.ground.spillRevision() !== this.ground.seenSpills) this.rebakeGround();
    const dayPlayer = night < 1 && this.forcedDark === 0 ? playerPos : null;
    const daySwitch = this.updateDaySources(dt, dayPlayer, interiors, rebuild);
    if (dayPlayer && night < 0.02 && daySwitch !== null) this.onDayLightSwitch?.(daySwitch);

    // Diving puts a burning player out
    if (this.weather.underwater > 0.5) fireFx.douse();
    // Weather wind on the flames, none underground
    const flameWind = (this.weather.sound.wind + this.weather.sound.breeze * 0.25) * (1 - this.weather.caveFactor);
    this.flames.update(dt, night, camera, playerPos, Math.min(1, flameWind));
    this.haloMat.uniforms.uNight.value = night;
    this.haloMat.uniforms.uTime.value = this.time;
    this.halos.visible = night > 0.02;

    const u = nightLightUniforms;
    groundLightUniforms.uGroundLightNight.value = night < 0.02 ? 0 : night;
    if (night < 0.02 && this.daySources.size === 0 && !this.slots.some((slot) => slot.dayWeight > 0)) {
      u.uFakeLightCount.value = 0;
      this.slots.length = 0;
      this.wanted.length = 0;
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
      // Candidate records are pooled: this runs 4x a second all night
      const cand = this.cand;
      let n = 0;
      for (const src of night < 0.02 ? this.daySources : this.sources) {
        // A room lamp's light stays inside its room: from afar only its windows show it (WindowGlow),
        // so it gets a slot only while the camera or the player is near enough to look in
        if (src.box && !(nearBox(src.box, cameraPos) || (playerPos !== null && nearBox(src.box, playerPos)))) continue;
        this.sphere.center.copy(src.pos);
        this.sphere.radius = src.range;
        if (this.frustum.intersectsSphere(this.sphere)) {
          const rec = this.candPool[n] ?? (this.candPool[n] = { s: src, d: 0 });
          rec.s = src;
          rec.d = src.pos.distanceToSquared(cameraPos);
          cand[n++] = rec;
        }
      }
      cand.length = n;
      cand.sort(byDistance);
      this.wanted.length = 0;
      for (let i = 0; i < n && i < maxFromProps; i++) this.wanted.push(cand[i].s);
    }

    // Slots fade in / out instead of popping: a source that is no longer wanted fades out, and a
    // newly wanted one takes a slot as soon as one is free
    const fade = dt * 4;
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const slot = this.slots[i];
      slot.w = this.wanted.includes(slot.s) ? Math.min(1, slot.w + fade) : slot.w - fade;
      slot.dayWeight = this.daySources.has(slot.s) ? Math.min(1, slot.dayWeight + fade) : Math.max(0, slot.dayWeight - fade);
      if (slot.w <= 0) this.slots.splice(i, 1);
    }
    for (const src of this.wanted) {
      if (this.slots.length >= maxFromProps) break;
      let has = false;
      for (let i = 0; i < this.slots.length; i++) if (this.slots[i].s === src) { has = true; break; }
      if (!has) this.slots.push({ s: src, w: 0, dayWeight: 0 });
    }

    let n = 0;
    let baked = 0;
    const v = this.viewPos;
    for (const { s, w, dayWeight } of this.slots) {
      if (s.baked && this.ground) baked |= 1 << n;
      const flicker = s.flicker ? 0.82 + 0.18 * Math.sin(this.time * (11 + s.seed * 5) + s.seed * 20) * Math.sin(this.time * 4.7) : 1;
      v.copy(s.pos).applyMatrix4(view);
      u.uFakeLightPos.value[n].set(v.x, v.y, v.z, s.range);
      const day = 0.7 * (1 - night) * dayWeight * dayWeight * (3 - 2 * dayWeight);
      u.uFakeLightColor.value[n].copy(s.color).multiplyScalar((night + day) * flicker * w * w * (3 - 2 * w));
      if (s.box) {
        u.uFakeLightBoxMin.value[n].set(s.box.min.x, s.box.min.y, s.box.min.z, 1);
        u.uFakeLightBoxMax.value[n].copy(s.box.max);
      } else u.uFakeLightBoxMin.value[n].w = 0;
      n++;
    }
    if (this.playerLantern && playerPos && n < MAX_FAKE_LIGHTS) {
      // Soft lantern glow around the player so the night stays playable away from lamps
      v.set(playerPos.x, playerPos.y + 1.4, playerPos.z).applyMatrix4(view);
      u.uFakeLightPos.value[n].set(v.x, v.y, v.z, 5.5 + this.forcedDark * 3.5);
      u.uFakeLightColor.value[n].copy(PLAYER_COLOR).multiplyScalar(night);
      u.uFakeLightBoxMin.value[n].w = 0;
      n++;
    }
    u.uFakeLightCount.value = n;
    u.uFakeLightBaked.value = baked;
    // The player lantern (after the prop slots) lights wherever the player goes: not in the grid
    u.uFakeLightAlways.value = n > this.slots.length ? 1 << this.slots.length : 0;
    this.updateGrid();
  }

  private updateDaySources(dt: number, playerPos: THREE.Vector3 | null, interiors: InteriorLighting, rebuild: boolean): boolean | null {
    let room = this.occupiedRoom;
    if (!playerPos) {
      room = null;
      this.occupancyTimer = 0;
      this.missedRoomSample = false;
    } else {
      this.occupancyTimer -= dt;
      if (this.occupancyTimer <= 0) {
        this.occupancyTimer = 0.1;
        const sampled = interiors.roomAt(playerPos);
        // Door frames can span an unoccupied grid cell. Wait for a second miss before dimming.
        if (sampled !== null || this.missedRoomSample) room = sampled;
        this.missedRoomSample = sampled === null;
      }
    }
    const roomChanged = room !== this.occupiedRoom;
    if (!roomChanged && !rebuild) return null;
    const hadDayLights = this.daySources.size > 0;
    this.occupiedRoom = room;
    this.daySources.clear();
    if (room) {
      for (const source of this.sources) {
        if (source.furniture && interiors.roomInHouseAt(room.houseKey, source.pos) === room) this.daySources.add(source);
      }
    }
    this.selectTimer = 0;
    const hasDayLights = this.daySources.size > 0;
    if (hasDayLights !== hadDayLights || (roomChanged && hasDayLights)) return hasDayLights;
    return null;
  }

  /** Rewrites the light grid when the slots (their sources or order) changed. */
  private updateGrid(): void {
    const slots = this.slots;
    let same = slots.length === this.gridSlots.length;
    for (let i = 0; same && i < slots.length; i++) same = slots[i].s === this.gridSlots[i];
    if (same) return;
    this.gridSlots.length = 0;
    for (const { s } of slots) this.gridSlots.push(s);

    const data = fakeGridData;
    data.fill(0);
    const N = FAKE_GRID_N;
    const inv = 1 / FAKE_GRID_CELL;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i].s;
      const r = s.range * GRID_RANGE_PAD;
      let x0 = s.pos.x - r;
      let x1 = s.pos.x + r;
      let z0 = s.pos.z - r;
      let z1 = s.pos.z + r;
      if (s.box) {
        // Room lamps: only the cells of their room (plus the 12 cm fade past its walls)
        x0 = Math.max(x0, s.box.min.x - 0.2);
        x1 = Math.min(x1, s.box.max.x + 0.2);
        z0 = Math.max(z0, s.box.min.z - 0.2);
        z1 = Math.min(z1, s.box.max.z + 0.2);
      }
      const cx0 = Math.max(0, Math.floor((x0 - FAKE_GRID_MIN) * inv));
      const cx1 = Math.min(N - 1, Math.floor((x1 - FAKE_GRID_MIN) * inv));
      const cz0 = Math.max(0, Math.floor((z0 - FAKE_GRID_MIN) * inv));
      const cz1 = Math.min(N - 1, Math.floor((z1 - FAKE_GRID_MIN) * inv));
      const byte = i >> 3;
      const bit = 1 << (i & 7);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) data[(cz * N + cx) * 4 + byte] |= bit;
      }
    }
    fakeGridTexture.needsUpdate = true;
  }

  private rebuildSources(): void {
    this.sources = [];
    const flames: FlameSpot[] = [];
    let h = 0;
    for (const p of this.props.list()) {
      const isLamp = p.type === 'lamp';
      if (!isLamp && p.type !== 'campfire') continue;
      const yOff = (isLamp ? 2.48 : 0.6) * p.scale;
      const pos = new THREE.Vector3(p.position.x, p.position.y + yOff, p.position.z);
      if (!isLamp) flames.push({ x: p.position.x, y: p.position.y + 0.1 * p.scale, z: p.position.z, size: 0.95 * p.scale });
      this.sources.push({
        pos,
        range: (isLamp ? 9 : 7.5) * p.scale,
        color: isLamp ? LAMP_COLOR : FIRE_COLOR,
        flicker: isLamp ? 0 : 1,
        seed: Math.random(),
        box: null,
        furniture: false,
        baked: isLamp,
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
      if (l.flame) flames.push({ x: l.x, y: l.flame.y, z: l.z, size: l.flame.size });
      const color = l.color ? new THREE.Color(...l.color) : LAMP_COLOR.clone();
      this.sources.push({
        pos,
        range: l.range,
        color: color.multiplyScalar(l.intensity),
        flicker: l.flicker ? 1 : 0,
        seed: Math.random(),
        box: l.box ?? null,
        furniture: l.furniture ?? false,
        baked: !l.flicker && !l.box,
      });
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
    this.flames.setSpots(flames);
    this.rebakeGround();
    this.selectTimer = 0;
    // Sources were recreated: keep the fade of lights that are still there (same position)
    for (const slot of this.slots) {
      const same = this.sources.find((src) => src.pos.equals(slot.s.pos));
      if (same) slot.s = same;
    }
  }
}
