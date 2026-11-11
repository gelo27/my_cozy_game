import * as THREE from 'three';
import { waterSettings } from '../world/WaterSettings';
import { riverWorld } from '../world/rivers/RiverWorld';

/**
 * Real ripples (developer panel → «Вода» → «Хвилі від гравця» → «Симуляція»): a small height
 * field around the player, stepped on the GPU with the wave equation, so rings from strokes,
 * steps, splashes and rain drops really spread, overlap, interfere and leave wakes.
 *
 * - Two half-float RGBA render targets (RES² texels covering `rippleSimArea` metres) ping-pong:
 *   R = height now, G = height one step ago, BA = slope (for the water normal);
 * - fixed 60 Hz steps, at most 3 per frame; the area follows the player in whole texels and the
 *   step shifts the field by the same amount, so waves stay put in the world;
 * - rain: the step shader drops its own dents (a hash per 0.5 m world cell and step decides where
 *   a drop lands), so heavy rain costs a few ALU per texel and no CPU work or extra fetches;
 * - land: a coarse grid of the area is checked for water every few frames. No water in the area
 *   (walking inland): nothing is stepped or drawn at all. On a shore, only the wet rectangle is
 *   stepped (scissor), and the step reads anything outside last step's rectangle as calm water;
 * - borders absorb waves (no reflections off the edge of the area), and the water shaders fade
 *   the field out toward the edge;
 * - idle (no drop, rain or moving body for as long as the damping takes to calm the waves) it
 *   stops stepping and switches the shader fetch off.
 * Cost when running: one pass over the wet part of RES² with 5 fetches per step, plus one fetch
 * per water pixel inside the area.
 */

export const RIPPLE_SIM_RES = 256;
const RES = RIPPLE_SIM_RES;
const STEP = 1 / 60;
const MAX_STEPS = 3;
const MAX_DROPS = 8;
/** Moving pushers: 0 = the body, 1..4 = hands / feet. */
export const MAX_PUSHERS = 5;
/** Rain: world cell (m) that gets at most one drop per step. */
const RAIN_CELL = 0.5;
/** Rain: chance per cell and step at full rain and amount 1 (≈ 300 drops/s over 16×16 m). */
const RAIN_RATE = 0.005;
/** Wet / dry probe grid over the area (samples per side) and how often it is redone (s). */
const WET_GRID = 9;
const WET_REFRESH = 0.25;
/** Water this much above the ground counts as wet (m). */
const WET_MIN_DEPTH = 0.02;

/** Shared by the sea and river shaders (see WATER_RIPPLE_GLSL). */
export const rippleSimUniforms = {
  uWdSim: { value: null as THREE.Texture | null },
  /** origin x, origin z, 1 / area size, on (0/1) */
  uWdSimArea: { value: new THREE.Vector4(0, 0, 1, 0) },
  /** crest threshold, slope strength, crest whiteness, unused */
  uWdSimLook: { value: new THREE.Vector4(0.035, 2.2, 0, 0) },
};

const SIM_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SIM_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPrev;
uniform vec2 uShift;      // origin moved by this much (uv), sample the old field there
uniform vec4 uValid;      // where the old field was stepped (uv of the old frame): min xy, max xy
uniform float uTexel;     // 1 / RES
uniform float uSpeed;     // c^2 (<= 0.5 for stability)
uniform float uDamp;
uniform float uSlopeK;    // 1 / (2 * texel size in metres)
uniform vec4 uDrops[${MAX_DROPS}]; // uv x, uv y, radius (uv), depth
uniform int uDropCount;
uniform vec4 uBody[${MAX_PUSHERS}]; // uv x, uv y, radius (uv), push per step (0 = off)
uniform vec4 uWorld;      // origin x, origin z, area (m), step counter
uniform vec3 uRainP;      // chance per cell and step, drop radius (m), drop depth
varying vec2 vUv;
vec2 S(vec2 uv) {
  if (uv.x < uValid.x || uv.y < uValid.y || uv.x > uValid.z || uv.y > uValid.w) return vec2(0.0);
  return texture2D(uPrev, uv).rg;
}
float rHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 uv = vUv + uShift;
  vec2 c = S(uv);
  float e = S(uv + vec2(uTexel, 0.0)).r;
  float w = S(uv - vec2(uTexel, 0.0)).r;
  float n = S(uv + vec2(0.0, uTexel)).r;
  float s = S(uv - vec2(0.0, uTexel)).r;
  // Wave equation (explicit): next = 2h - prev + c^2 * laplacian, then damped
  float h = (2.0 * c.r - c.g + uSpeed * (e + w + n + s - 4.0 * c.r)) * uDamp;
  // Drops: a smooth dent
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    if (i >= uDropCount) break;
    vec4 d = uDrops[i];
    float k = length(vUv - d.xy) / d.z;
    if (k < 1.0) h -= d.w * (0.5 + 0.5 * cos(3.14159265 * k));
  }
  // Moving pushers (body, hands, feet) press the water down where they are: wakes form on their own
  for (int i = 0; i < ${MAX_PUSHERS}; i++) {
    vec4 b = uBody[i];
    if (b.w == 0.0) continue;
    float kb = length(vUv - b.xy) / max(b.z, 1e-5);
    if (kb < 1.0) h -= b.w * (0.5 + 0.5 * cos(3.14159265 * kb));
  }
  // Rain: each world cell may get one drop this step, at a random spot, of random weight. A drop
  // lies well inside its cell, so only this texel's own cell has to be tested.
  if (uRainP.x > 0.0) {
    vec2 wp = uWorld.xy + vUv * uWorld.z;
    vec2 cell = floor(wp / ${RAIN_CELL.toFixed(2)});
    vec2 seed = cell + vec2(uWorld.w * 0.618, uWorld.w * 1.414);
    if (rHash(seed) < uRainP.x) {
      vec2 at = (cell + 0.2 + 0.6 * vec2(rHash(seed + 3.7), rHash(seed + 9.1))) * ${RAIN_CELL.toFixed(2)};
      float k = length(wp - at) / uRainP.y;
      if (k < 1.0) h -= uRainP.z * (0.5 + 0.8 * rHash(seed + 5.3)) * (0.5 + 0.5 * cos(3.14159265 * k));
    }
  }
  // Absorbing border: waves die out instead of bouncing off the edge of the area
  float edge = min(min(vUv.x, vUv.y), min(1.0 - vUv.x, 1.0 - vUv.y));
  h *= mix(0.9, 1.0, smoothstep(0.0, 0.06, edge));
  gl_FragColor = vec4(h, c.r, (e - w) * uSlopeK, (n - s) * uSlopeK);
}
`;

interface Drop { x: number; z: number; r: number; depth: number }

/** Ground height under a point (set by the engine: the terrain). */
type GroundFn = (x: number, z: number) => number;

class WaterRippleSim {
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private read = 0;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mat: THREE.ShaderMaterial;
  private readonly drops: Drop[] = [];
  private readonly dropVecs = Array.from({ length: MAX_DROPS }, () => new THREE.Vector4());
  /** World centre the area follows (the player, or the camera in the editor). */
  private cx = 0;
  private cz = 0;
  private originX = NaN;
  private originZ = NaN;
  private area = 0;
  private readonly pushers = Array.from({ length: MAX_PUSHERS }, () => ({ x: 0, z: 0, r: 0.4, speed: 0, fresh: false }));
  private readonly pusherVecs = Array.from({ length: MAX_PUSHERS }, () => new THREE.Vector4());
  private acc = 0;
  private idle = Infinity;
  private asleep = true;
  private stepCount = 0;
  private supported: boolean | null = null;

  private ground: GroundFn | null = null;
  /** Wet part of the area in world space (minX, minZ, maxX, maxZ); empty = no water around. */
  private wet = { minX: 0, minZ: 0, maxX: 0, maxZ: 0, any: false };
  private wetTimer = 0;
  private wetAtX = NaN;
  private wetAtZ = NaN;
  /** Where the last step wrote, in world space (the next step reads only inside it). */
  private valid = { minX: 0, minZ: 0, maxX: 0, maxZ: 0, all: true };

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SIM_VERT,
      fragmentShader: SIM_FRAG,
      uniforms: {
        uPrev: { value: null },
        uShift: { value: new THREE.Vector2() },
        uValid: { value: new THREE.Vector4(0, 0, 1, 1) },
        uTexel: { value: 1 / RES },
        uSpeed: { value: 0.18 },
        uDamp: { value: 0.985 },
        uSlopeK: { value: 1 },
        uDrops: { value: this.dropVecs },
        uDropCount: { value: 0 },
        uBody: { value: this.pusherVecs },
        uWorld: { value: new THREE.Vector4() },
        uRainP: { value: new THREE.Vector3() },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** On while the developer setting is on and the GPU can render to half floats. */
  public get active(): boolean {
    return waterSettings.rippleSim && this.supported !== false;
  }

  /** The terrain height, so the simulation knows where there is water to ripple. */
  public setGround(fn: GroundFn): void {
    this.ground = fn;
    this.wetAtX = NaN;
  }

  /** A drop / splash at (x, z): `strength` 0..1, `radius` how far the ring should reach (m). */
  public addDrop(x: number, z: number, strength: number, radius: number): void {
    if (!this.active) return;
    if (this.drops.length >= MAX_DROPS) this.drops.shift();
    this.drops.push({ x, z, r: THREE.MathUtils.clamp(0.16 + radius * 0.05, 0.18, 0.45), depth: strength * 0.12 });
    this.idle = 0;
  }

  /** Per frame while the player is in the water: its motion makes a wake. */
  public setBody(x: number, z: number, speed: number, radius: number): void {
    this.setPusher(0, x, z, speed, radius);
  }

  /**
   * Per frame for a moving part in the water (slot 1..MAX_PUSHERS-1: hands, feet): it pushes its
   * own little wake, which breaks up the body's too-regular one.
   */
  public setPusher(slot: number, x: number, z: number, speed: number, radius: number): void {
    const b = this.pushers[slot];
    if (!b) return;
    b.x = x;
    b.z = z;
    b.r = radius;
    b.speed = speed;
    b.fresh = true;
    if (speed > 0.3) this.idle = 0;
  }

  /**
   * Per frame. `rain` 0..1 (already 0 in caves / snow); `focus` = where the area should be
   * centred (the player).
   */
  public update(renderer: THREE.WebGLRenderer, dt: number, rain: number, focus: THREE.Vector3): void {
    const u = rippleSimUniforms;
    if (!waterSettings.rippleSim) {
      u.uWdSimArea.value.w = 0;
      u.uWdSimLook.value.w = 0;
      if (this.targets) this.dispose();
      this.clearPushers();
      return;
    }
    if (this.supported === null) {
      this.supported = renderer.capabilities.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
      if (!this.supported) console.warn('[WaterRippleSim] half-float render targets unsupported: ripples stay analytic');
    }
    if (!this.supported) return;
    const ws = waterSettings;
    this.cx = focus.x;
    this.cz = focus.z;
    const area = ws.rippleSimArea;
    const texelM = area / RES;
    const ox = Math.floor((this.cx - area / 2) / texelM) * texelM;
    const oz = Math.floor((this.cz - area / 2) / texelM) * texelM;

    // Is there any water in the area? (inland: the whole thing stays off)
    this.wetTimer -= dt;
    if (this.wetTimer <= 0 || Math.abs(ox - this.wetAtX) > 1 || Math.abs(oz - this.wetAtZ) > 1 || !Number.isFinite(this.wetAtX)) {
      this.probeWet(ox, oz, area);
    }
    const raining = ws.rippleSimRain && rain > 0.02 && this.wet.any;
    if (raining) this.idle = 0;
    this.idle += dt;
    // Sleep once the damping has calmed the waves to well under a percent of their height
    const damp = THREE.MathUtils.clamp(ws.rippleSimDamping, 0.9, 0.999);
    const sleepAfter = THREE.MathUtils.clamp(Math.log(0.003) / (60 * Math.log(damp)), 2, 15);
    u.uWdSimLook.value.set(ws.rippleSimCrest, ws.rippleSimSlope, ws.rippleSimCrestOn ? 0.9 : 0, 0);
    if (!this.wet.any || this.idle > sleepAfter) {
      // Asleep (calm water, or no water around at all): nothing to step or to draw
      u.uWdSimArea.value.w = 0;
      this.asleep = true;
      this.drops.length = 0;
      this.clearPushers();
      this.acc = 0;
      return;
    }
    if (!this.targets || this.area !== area) this.allocate(renderer, area);
    if (this.asleep) {
      // Waking up: whatever is left in the targets is long stale
      this.clearTargets(renderer);
      this.asleep = false;
    }

    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS);
    const m = this.mat.uniforms;
    m.uSpeed.value = THREE.MathUtils.clamp(ws.rippleSimSpeed, 0.02, 0.5);
    m.uDamp.value = damp;
    m.uSlopeK.value = 1 / (2 * texelM);
    m.uRainP.value.set(
      raining ? Math.min(rain * RAIN_RATE * ws.rippleSimRainAmount, 0.5) : 0,
      THREE.MathUtils.clamp(texelM * 1.6, 0.07, RAIN_CELL * 0.2),
      0.035 * ws.rippleSimRainStrength
    );

    // Step only the wet rectangle (in texels of the new frame), a texel of margin around it
    const wet = this.wet;
    const x0 = THREE.MathUtils.clamp(Math.floor((wet.minX - ox) / texelM) - 1, 0, RES);
    const y0 = THREE.MathUtils.clamp(Math.floor((wet.minZ - oz) / texelM) - 1, 0, RES);
    const x1 = THREE.MathUtils.clamp(Math.ceil((wet.maxX - ox) / texelM) + 1, 0, RES);
    const y1 = THREE.MathUtils.clamp(Math.ceil((wet.maxZ - oz) / texelM) + 1, 0, RES);
    const full = x0 === 0 && y0 === 0 && x1 === RES && y1 === RES;

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      if (Number.isNaN(this.originX)) {
        this.originX = ox;
        this.originZ = oz;
      }
      // Follow the player in whole texels; the step reads the old field shifted by as much
      m.uShift.value.set((ox - this.originX) / area, (oz - this.originZ) / area);
      // Read only where the last step wrote (uv of the old frame)
      const v = this.valid;
      if (v.all) m.uValid.value.set(0, 0, 1, 1);
      else m.uValid.value.set((v.minX - this.originX) / area, (v.minZ - this.originZ) / area, (v.maxX - this.originX) / area, (v.maxZ - this.originZ) / area);
      this.originX = ox;
      this.originZ = oz;
      this.stepCount = (this.stepCount + 1) % 4096;
      m.uWorld.value.set(ox, oz, area, this.stepCount);

      const n = this.drops.length;
      for (let i = 0; i < n; i++) {
        const d = this.drops[i];
        this.dropVecs[i].set((d.x - ox) / area, (d.z - oz) / area, d.r / area, d.depth);
      }
      m.uDropCount.value = n;
      this.drops.length = 0;
      for (let i = 0; i < MAX_PUSHERS; i++) {
        const b = this.pushers[i];
        const push = b.fresh ? Math.min(b.speed, 5) * 0.004 * ws.rippleSimWake : 0;
        this.pusherVecs[i].set((b.x - ox) / area, (b.z - oz) / area, b.r / area, push);
      }

      const src = this.targets![this.read];
      const dst = this.targets![1 - this.read];
      m.uPrev.value = src.texture;
      dst.scissorTest = !full;
      dst.scissor.set(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      renderer.setRenderTarget(dst);
      renderer.render(this.scene, this.cam);
      this.read = 1 - this.read;
      // What this step wrote, in world space
      v.all = full;
      v.minX = ox + x0 * texelM;
      v.minZ = oz + y0 * texelM;
      v.maxX = ox + x1 * texelM;
      v.maxZ = oz + y1 * texelM;
    }
    renderer.setRenderTarget(prevTarget);
    renderer.xr.enabled = prevXr;
    this.clearPushers();

    u.uWdSim.value = this.targets![this.read].texture;
    u.uWdSimArea.value.set(this.originX, this.originZ, 1 / area, 1);
  }

  /** Samples a grid over the area for water deeper than the ground and keeps its bounding box. */
  private probeWet(ox: number, oz: number, area: number): void {
    this.wetTimer = WET_REFRESH;
    this.wetAtX = ox;
    this.wetAtZ = oz;
    const w = this.wet;
    const ground = this.ground;
    if (!ground) {
      // No terrain to ask: treat the whole area as wet
      w.any = true;
      w.minX = ox;
      w.minZ = oz;
      w.maxX = ox + area;
      w.maxZ = oz + area;
      return;
    }
    const cell = area / (WET_GRID - 1);
    let any = false;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let j = 0; j < WET_GRID; j++) {
      const z = oz + j * cell;
      for (let i = 0; i < WET_GRID; i++) {
        const x = ox + i * cell;
        if (riverWorld.waterLevelAt(x, z) - ground(x, z) < WET_MIN_DEPTH) continue;
        any = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    w.any = any;
    // One probe cell of margin: water may reach a little past the last wet sample
    w.minX = minX - cell;
    w.minZ = minZ - cell;
    w.maxX = maxX + cell;
    w.maxZ = maxZ + cell;
  }

  private clearPushers(): void {
    for (const b of this.pushers) b.fresh = false;
  }

  private allocate(renderer: THREE.WebGLRenderer, area: number): void {
    this.dispose();
    const make = () =>
      new THREE.WebGLRenderTarget(RES, RES, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    this.targets = [make(), make()];
    for (const t of this.targets) t.texture.colorSpace = THREE.NoColorSpace;
    this.area = area;
    this.clearTargets(renderer);
  }

  /** Calm water everywhere; the next step may read the whole field. */
  private clearTargets(renderer: THREE.WebGLRenderer): void {
    if (!this.targets) return;
    const prev = renderer.getRenderTarget();
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const t of this.targets) {
      t.scissorTest = false;
      renderer.setRenderTarget(t);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevColor, prevAlpha);
    this.originX = this.originZ = NaN;
    this.valid.all = true;
    this.read = 0;
  }

  public dispose(): void {
    this.targets?.forEach((t) => t.dispose());
    this.targets = null;
    rippleSimUniforms.uWdSim.value = null;
    rippleSimUniforms.uWdSimArea.value.w = 0;
    rippleSimUniforms.uWdSimLook.value.w = 0;
  }
}

export const waterRippleSim = new WaterRippleSim();
