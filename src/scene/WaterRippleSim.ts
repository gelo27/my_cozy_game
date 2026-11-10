import * as THREE from 'three';
import { waterSettings } from '../world/WaterSettings';

/**
 * Real ripples (developer panel → «Вода» → «Хвилі від гравця» → «Симуляція»): a small height
 * field around the player, stepped on the GPU with the wave equation, so rings from strokes,
 * steps and splashes really spread, overlap, interfere and leave a wake behind a moving body.
 *
 * - Two half-float RGBA render targets (RES² texels covering `rippleSimArea` metres) ping-pong:
 *   R = height now, G = height one step ago, BA = slope (for the water normal);
 * - fixed 60 Hz steps, at most 3 per frame; the area follows the player in whole texels and the
 *   step shifts the field by the same amount, so waves stay put in the world;
 * - borders absorb waves (no reflections off the edge of the area), and the water shaders fade
 *   the field out toward the edge;
 * - idle (no drop or moving body for a while) it stops stepping and switches the shader fetch
 *   off, so swimming nowhere costs nothing. Cost when running: one 256² pass of 5 fetches per
 *   step, plus one fetch per water pixel.
 */

export const RIPPLE_SIM_RES = 256;
const RES = RIPPLE_SIM_RES;
const STEP = 1 / 60;
const MAX_STEPS = 3;
const MAX_DROPS = 8;
/** Moving pushers: 0 = the body, 1..4 = hands / feet. */
export const MAX_PUSHERS = 5;
/** Seconds with nothing disturbing the water before the simulation goes to sleep. */
const SLEEP_AFTER = 10;

/** Shared by the sea and river shaders (see WATER_RIPPLE_GLSL). */
export const rippleSimUniforms = {
  uWdSim: { value: null as THREE.Texture | null },
  /** origin x, origin z, 1 / area size, on (0/1) */
  uWdSimArea: { value: new THREE.Vector4(0, 0, 1, 0) },
  /** crest threshold, slope strength, crest whiteness */
  uWdSimLook: { value: new THREE.Vector3(0.035, 2.2, 0) },
};

const SIM_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SIM_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPrev;
uniform vec2 uShift;      // origin moved by this much (uv), sample the old field there
uniform float uTexel;     // 1 / RES
uniform float uSpeed;     // c^2 (<= 0.5 for stability)
uniform float uDamp;
uniform float uSlopeK;    // 1 / (2 * texel size in metres)
uniform vec4 uDrops[${MAX_DROPS}]; // uv x, uv y, radius (uv), depth
uniform int uDropCount;
uniform vec4 uBody[${MAX_PUSHERS}]; // uv x, uv y, radius (uv), push per step (0 = off)
varying vec2 vUv;
vec2 S(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(0.0);
  return texture2D(uPrev, uv).rg;
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
  // Absorbing border: waves die out instead of bouncing off the edge of the area
  float edge = min(min(vUv.x, vUv.y), min(1.0 - vUv.x, 1.0 - vUv.y));
  h *= mix(0.9, 1.0, smoothstep(0.0, 0.06, edge));
  gl_FragColor = vec4(h, c.r, (e - w) * uSlopeK, (n - s) * uSlopeK);
}
`;

interface Drop { x: number; z: number; r: number; depth: number }

class WaterRippleSim {
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private read = 0;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mat: THREE.ShaderMaterial;
  private readonly drops: Drop[] = [];
  private readonly dropVecs = Array.from({ length: MAX_DROPS }, () => new THREE.Vector4());
  /** World centre the area should follow (the player). */
  private cx = 0;
  private cz = 0;
  private originX = NaN;
  private originZ = NaN;
  private area = 0;
  private readonly pushers = Array.from({ length: MAX_PUSHERS }, () => ({ x: 0, z: 0, r: 0.4, speed: 0, fresh: false }));
  private readonly pusherVecs = Array.from({ length: MAX_PUSHERS }, () => new THREE.Vector4());
  private acc = 0;
  private idle = SLEEP_AFTER;
  private supported: boolean | null = null;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SIM_VERT,
      fragmentShader: SIM_FRAG,
      uniforms: {
        uPrev: { value: null },
        uShift: { value: new THREE.Vector2() },
        uTexel: { value: 1 / RES },
        uSpeed: { value: 0.18 },
        uDamp: { value: 0.985 },
        uSlopeK: { value: 1 },
        uDrops: { value: this.dropVecs },
        uDropCount: { value: 0 },
        uBody: { value: this.pusherVecs },
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

  /** A drop / splash at (x, z): `strength` 0..1, `radius` how far the ring should reach (m). */
  public addDrop(x: number, z: number, strength: number, radius: number): void {
    if (!this.active) return;
    if (this.drops.length >= MAX_DROPS) this.drops.shift();
    this.drops.push({ x, z, r: THREE.MathUtils.clamp(0.16 + radius * 0.05, 0.18, 0.45), depth: strength * 0.12 });
    this.idle = 0;
  }

  /** Per frame while the player is in the water: the area follows it and its motion makes a wake. */
  public setBody(x: number, z: number, speed: number, radius: number): void {
    this.cx = x;
    this.cz = z;
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

  public update(renderer: THREE.WebGLRenderer, dt: number): void {
    const u = rippleSimUniforms;
    if (!waterSettings.rippleSim) {
      u.uWdSimArea.value.w = 0;
      if (this.targets) this.dispose();
      for (const b of this.pushers) b.fresh = false;
      return;
    }
    if (this.supported === null) {
      this.supported = renderer.capabilities.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
      if (!this.supported) console.warn('[WaterRippleSim] half-float render targets unsupported: ripples stay analytic');
    }
    if (!this.supported) return;
    const ws = waterSettings;
    u.uWdSimLook.value.set(ws.rippleSimCrest, ws.rippleSimSlope, ws.rippleSimCrestOn ? 0.9 : 0);

    this.idle += dt;
    if (this.idle > SLEEP_AFTER) {
      // Asleep: nothing moves, so nothing to step or to draw
      u.uWdSimArea.value.w = 0;
      for (const b of this.pushers) b.fresh = false;
      this.acc = 0;
      return;
    }
    if (!this.targets || this.area !== ws.rippleSimArea) this.allocate(renderer, ws.rippleSimArea);

    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS);
    const m = this.mat.uniforms;
    m.uSpeed.value = THREE.MathUtils.clamp(ws.rippleSimSpeed, 0.02, 0.5);
    m.uDamp.value = ws.rippleSimDamping;
    const texelM = this.area / RES;
    m.uSlopeK.value = 1 / (2 * texelM);

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      // Follow the player in whole texels; the step reads the old field shifted by as much
      const ox = Math.floor((this.cx - this.area / 2) / texelM) * texelM;
      const oz = Math.floor((this.cz - this.area / 2) / texelM) * texelM;
      if (Number.isNaN(this.originX)) {
        this.originX = ox;
        this.originZ = oz;
      }
      m.uShift.value.set((ox - this.originX) / this.area, (oz - this.originZ) / this.area);
      this.originX = ox;
      this.originZ = oz;

      const n = this.drops.length;
      for (let i = 0; i < n; i++) {
        const d = this.drops[i];
        this.dropVecs[i].set((d.x - ox) / this.area, (d.z - oz) / this.area, d.r / this.area, d.depth);
      }
      m.uDropCount.value = n;
      this.drops.length = 0;
      for (let i = 0; i < MAX_PUSHERS; i++) {
        const b = this.pushers[i];
        const push = b.fresh ? Math.min(b.speed, 5) * 0.004 * ws.rippleSimWake : 0;
        this.pusherVecs[i].set((b.x - ox) / this.area, (b.z - oz) / this.area, b.r / this.area, push);
      }

      const src = this.targets![this.read];
      const dst = this.targets![1 - this.read];
      m.uPrev.value = src.texture;
      renderer.setRenderTarget(dst);
      renderer.render(this.scene, this.cam);
      this.read = 1 - this.read;
    }
    renderer.setRenderTarget(prevTarget);
    renderer.xr.enabled = prevXr;
    for (const b of this.pushers) b.fresh = false;

    u.uWdSim.value = this.targets![this.read].texture;
    u.uWdSimArea.value.set(this.originX, this.originZ, 1 / this.area, 1);
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
    const prev = renderer.getRenderTarget();
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const t of this.targets) {
      t.texture.colorSpace = THREE.NoColorSpace;
      renderer.setRenderTarget(t);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevColor, prevAlpha);
    this.area = area;
    this.originX = this.originZ = NaN;
    this.read = 0;
  }

  public dispose(): void {
    this.targets?.forEach((t) => t.dispose());
    this.targets = null;
    rippleSimUniforms.uWdSim.value = null;
    rippleSimUniforms.uWdSimArea.value.w = 0;
  }
}

export const waterRippleSim = new WaterRippleSim();
