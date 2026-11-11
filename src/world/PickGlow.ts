import * as THREE from 'three';

/**
 * The thing the HUD prompt is about right now (the tulip clump E would pick, the ripe field E would
 * harvest) pulses toward white, brightest along its silhouette (a fresnel rim), so the player sees
 * exactly what they'll act on, whatever its own colour.
 *
 * No extra meshes, passes or draw calls: the materials those things already draw with get a few
 * shader lines (injectPickGlow). Each kind has one target uniform; the vertex shader compares its
 * instance's position with it (one test, no loop) and the fragment shader blends the lit colour
 * toward white by the pulse, more where the surface turns away from the view. The target fades in when the prompt appears and out when it
 * goes; with no target (or the effect off) the shaders skip it.
 */
export interface PickGlowSettings {
  enabled: boolean;
  /** How far toward white the target goes at the top of a pulse, on its rim (0..1). */
  strength: number;
  /** Pulses per second. */
  speed: number;
  /** How much the rim outshines the middle (0 = evenly white, 1 = only the silhouette). */
  rim: number;
}

export const PICK_GLOW_DEFAULTS: Readonly<PickGlowSettings> = {
  enabled: true,
  strength: 0.9,
  speed: 0.8,
  rim: 1,
};

const STORAGE_KEY = 'farm.pickGlow3';

function load(): PickGlowSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      const { enabled, strength, speed, rim } = { ...PICK_GLOW_DEFAULTS, ...JSON.parse(raw) };
      return { enabled, strength, speed, rim };
    }
  } catch {
    // ignore broken storage
  }
  return { ...PICK_GLOW_DEFAULTS };
}

export const pickGlowSettings: PickGlowSettings = load();

export function savePickGlowSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pickGlowSettings));
  } catch {
    // storage full / disabled: settings simply do not persist
  }
}

export function resetPickGlowSettings(): void {
  Object.assign(pickGlowSettings, PICK_GLOW_DEFAULTS);
  savePickGlowSettings();
}

/** 'instance': one instance (a tulip clump) by its position; 'area': every instance in a square (a field). */
export type PickGlowMode = 'instance' | 'area';

// On globalThis so a hot-reloaded copy of this module keeps feeding the compiled materials
const store = globalThis as {
  __pickGlowTargets?: Record<PickGlowMode, { value: THREE.Vector4 }>;
  __pickGlowTime?: { value: number };
  __pickGlowRim?: { value: number };
};
/** Per kind: target XZ, half size of the square (area) / match tolerance (instance), glow amount (0 = none). */
const uTargets = (store.__pickGlowTargets ??= { instance: { value: new THREE.Vector4() }, area: { value: new THREE.Vector4() } });
/** Pulse phase (rad). */
const uPickTime = (store.__pickGlowTime ??= { value: 0 });
/** Share of the whitening kept in the middle of the object (1 - rim). */
const uPickRim = (store.__pickGlowRim ??= { value: 0 });

/** Adds the glow to an instanced Lambert / Phong / Standard material's shader (call in onBeforeCompile). */
export function injectPickGlow(shader: THREE.WebGLProgramParametersWithUniforms, mode: PickGlowMode): void {
  shader.uniforms.uPickTarget = uTargets[mode];
  shader.uniforms.uPickTime = uPickTime;
  shader.uniforms.uPickRim = uPickRim;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
uniform vec4 uPickTarget;
varying float vPickGlow;`)
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vPickGlow = 0.0;
#ifdef USE_INSTANCING
  if (uPickTarget.w > 0.0) {
    vec2 pgQ = abs(instanceMatrix[3].xz - uPickTarget.xy);
    if (max(pgQ.x, pgQ.y) < uPickTarget.z) vPickGlow = uPickTarget.w;
  }
#endif`
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform float uPickTime;
uniform float uPickRim;
varying float vPickGlow;`)
    .replace(
      '#include <opaque_fragment>',
      `if (vPickGlow > 0.001) {
  float pgPulse = 0.5 + 0.5 * sin(uPickTime);
  // Fresnel: 1 where the surface turns edge-on to the view (the silhouette), 0 facing it
  // (a wide band: the low-poly petals and leaves seldom turn fully edge-on)
  float pgRim = smoothstep(0.1, 0.7, 1.0 - abs(dot(normalize(normal), normalize(vViewPosition))));
  float pgK = vPickGlow * mix(0.2, 1.0, pgPulse * pgPulse) * mix(uPickRim, 1.0, pgRim);
  outgoingLight = mix(outgoingLight, vec3(1.0), clamp(pgK, 0.0, 1.0));
}
#include <opaque_fragment>`
    );
}

/** What a prompt is about: a single instance at (x, z), or a square of half size `half`. */
export interface PickGlowTarget {
  x: number;
  z: number;
  half: number;
}

/** Instance positions match this closely (m): they are the same numbers the instance was placed with. */
const INSTANCE_MATCH = 0.05;
/** Fade in / out time (s). */
const FADE = 0.2;

const state: Record<PickGlowMode, { amount: number; x: number; z: number; half: number; has: boolean }> = {
  instance: { amount: 0, x: 0, z: 0, half: 0, has: false },
  area: { amount: 0, x: 0, z: 0, half: 0, has: false },
};

function step(mode: PickGlowMode, target: PickGlowTarget | null, dt: number, strength: number): void {
  const s = state[mode];
  if (target) {
    const half = mode === 'instance' ? INSTANCE_MATCH : target.half;
    // Another object: the glow starts over on it
    if (!s.has || Math.abs(target.x - s.x) > 1e-3 || Math.abs(target.z - s.z) > 1e-3) s.amount = 0;
    s.x = target.x;
    s.z = target.z;
    s.half = half;
    s.has = true;
    s.amount = Math.min(1, s.amount + dt / FADE);
  } else {
    s.amount = Math.max(0, s.amount - dt / FADE);
    if (s.amount === 0) s.has = false;
  }
  uTargets[mode].value.set(s.x, s.z, s.half, s.amount * strength);
}

/**
 * Per frame, with what the HUD prompt is about: the tulip clump to pick and the ripe field to
 * harvest (null when there is none).
 */
export function updatePickGlow(dt: number, clump: PickGlowTarget | null, field: PickGlowTarget | null): void {
  const s = pickGlowSettings;
  const on = s.enabled && s.strength > 0;
  uPickTime.value = (uPickTime.value + dt * s.speed * Math.PI * 2) % (Math.PI * 2000);
  uPickRim.value = 1 - THREE.MathUtils.clamp(s.rim, 0, 1);
  step('instance', on ? clump : null, dt, s.strength);
  step('area', on ? field : null, dt, s.strength);
}
