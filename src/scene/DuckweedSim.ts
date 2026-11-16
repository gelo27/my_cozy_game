import * as THREE from 'three';
import { duckweed, duckweedUniforms } from '../world/Duckweed';

/**
 * Duckweed pushed aside: a small field around the player, stepped on the GPU, that says how far
 * the duckweed at each point has been moved and how much of it has been cleared away.
 *
 * - One pair of half-float RGBA targets (RES² texels over AREA metres) ping-pong:
 *   RG = displacement D (m): the shader draws the duckweed of (p - D) at p, so the fronds slide
 *   with the drag and drift back as D relaxes; B = clearance 0..1: an open patch of water;
 *   A = pile 0..1: the cover crowded together around an opening;
 * - pushers (the body, hands and feet, a shark, the bobber, the boat) clear a disc around them,
 *   crowd the cover into a rim around it and drag it along with their motion. There is no
 *   radial push: drawing (p - D) with D pointing out of a disc magnifies the cover around it
 *   (a ring of radius r shows the ring of radius r - |D|), which smears the fronds into
 *   concentric streaks; the opening and the rim give the pushed-aside look instead;
 * - every step D and B relax toward zero and blur a little, so an opening closes from its rim
 *   inward and the fronds float back over a few seconds;
 * - the area follows the focus in whole texels and the step reads the old field shifted by as
 *   much (like WaterRippleSim);
 * - it runs only while duckweed lies in the area and something stirs or the field is still
 *   settling; otherwise nothing is stepped and the water shader skips the fetch.
 * Cost when running: one 30 Hz pass over 128² with 5 fetches, one fetch per duckweed pixel.
 */

const RES = 128;
const AREA = 24;
const TEXEL_M = AREA / RES;
const STEP = 1 / 30;
const MAX_STEPS = 2;
/** Pusher slots: 0 body, 1..4 hands / feet, 5..6 sharks, 7 bobber, 8 boat. */
export const DUCKWEED_PUSHERS = 9;
export const DUCKWEED_BOBBER_SLOT = 7;
export const DUCKWEED_BOAT_SLOT = 8;
/** How long the field takes to settle back (s, time constants of D and of the clearance). */
const RELAX_D = 4.5;
const RELAX_C = 7;
/** Longest push (m). */
const MAX_D = 0.6;
/** Stays awake this long after the last push (the field is back to ~1 % by then). */
const SETTLE = RELAX_C * 4.6;
/** How often the area is checked for duckweed (s). */
const PROBE_EVERY = 0.3;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPrev;
uniform vec2 uShift;   // origin moved by this much (uv)
uniform float uTexel;
uniform vec2 uRelax;   // per step: D, clearance
uniform float uDt;
uniform float uMaxD;
uniform vec4 uPush[${DUCKWEED_PUSHERS}];  // uv x, uv y, radius (m), hold 0..1 (0 = off)
uniform vec4 uVel[${DUCKWEED_PUSHERS}];   // velocity (m/s) x, z, strength, unused
varying vec2 vUv;
vec4 S(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(uPrev, uv);
}
void main() {
  vec2 uv = vUv + uShift;
  vec4 c = S(uv);
  vec4 avg = (S(uv + vec2(uTexel, 0.0)) + S(uv - vec2(uTexel, 0.0)) + S(uv + vec2(0.0, uTexel)) + S(uv - vec2(0.0, uTexel))) * 0.25;
  // A little blur (soft shapes; an opening closes from its rim), then the slow return
  c = mix(c, avg, 0.2);
  vec2 d = c.xy * uRelax.x;
  float clr = c.z * uRelax.y;
  float pile = c.w * uRelax.y;
  for (int i = 0; i < ${DUCKWEED_PUSHERS}; i++) {
    vec4 p = uPush[i];
    if (p.w <= 0.0) continue;
    vec2 rel = (vUv - p.xy) * ${AREA.toFixed(1)};
    float r = length(rel);
    float R = p.z;
    // Cleared disc: fully open inside the radius, soft edge out to 1.4x
    float inner = 1.0 - smoothstep(R * 0.75, R * 1.4, r);
    clr = max(clr, inner * p.w);
    // The cover it pushed aside crowds into a rim just outside the opening
    float rim = smoothstep(R * 0.9, R * 1.35, r) * (1.0 - smoothstep(R * 1.5, R * 2.4, r));
    pile = max(pile, rim * p.w);
    // Dragged along with the motion (smoothly over a wide disc: no stretching)
    float ring = 1.0 - smoothstep(R * 0.5, R * 3.5, r);
    d += uVel[i].xy * 0.9 * uVel[i].z * ring * uDt;
  }
  float len = length(d);
  if (len > uMaxD) d *= uMaxD / len;
  // The edge of the area fades out (no hard line where the field ends)
  float edge = min(min(vUv.x, vUv.y), min(1.0 - vUv.x, 1.0 - vUv.y));
  float keep = smoothstep(0.0, 0.08, edge);
  gl_FragColor = vec4(d * keep, clamp(clr, 0.0, 1.0) * keep, clamp(pile, 0.0, 1.0) * keep);
}
`;

interface Pusher { x: number; z: number; r: number; hold: number; speed: number; vx: number; vz: number; lx: number; lz: number; fresh: boolean; seen: boolean }

class DuckweedSim {
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private read = 0;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mat: THREE.ShaderMaterial;
  private readonly pushers: Pusher[] = Array.from({ length: DUCKWEED_PUSHERS }, () => ({
    x: 0, z: 0, r: 0.5, hold: 0, speed: 0, vx: 0, vz: 0, lx: 0, lz: 0, fresh: false, seen: false,
  }));
  private readonly pushVecs = Array.from({ length: DUCKWEED_PUSHERS }, () => new THREE.Vector4());
  private readonly velVecs = Array.from({ length: DUCKWEED_PUSHERS }, () => new THREE.Vector4());
  private originX = NaN;
  private originZ = NaN;
  private acc = 0;
  /** Seconds since the last push (asleep past SETTLE). */
  private quiet = Infinity;
  private asleep = true;
  private supported: boolean | null = null;
  private probeTimer = 0;
  private probeX = NaN;
  private probeZ = NaN;
  private probeRev = -1;
  private hasWeed = false;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uPrev: { value: null },
        uShift: { value: new THREE.Vector2() },
        uTexel: { value: 1 / RES },
        uRelax: { value: new THREE.Vector2(1, 1) },
        uDt: { value: STEP },
        uMaxD: { value: MAX_D },
        uPush: { value: this.pushVecs },
        uVel: { value: this.velVecs },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /**
   * Per frame for something in the water (slot: see DUCKWEED_PUSHERS). `radius` = the opening it
   * keeps around itself (m); `hold` 0..1 = how much it clears while standing still (the body: 1,
   * a hand: 0, it only clears while it moves). Its velocity comes from its own track.
   */
  public setPusher(slot: number, x: number, z: number, radius: number, hold = 1): void {
    const p = this.pushers[slot];
    if (!p) return;
    p.x = x;
    p.z = z;
    p.r = radius;
    p.hold = hold;
    p.fresh = true;
  }

  /** Per frame (after the pushers were set). `focus` = where the area is centred (the player). */
  public update(renderer: THREE.WebGLRenderer, dt: number, focus: THREE.Vector3): void {
    const u = duckweedUniforms.uWsWeedSimArea.value;
    if (this.supported === null) {
      this.supported = renderer.capabilities.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
    }
    const ox = Math.floor((focus.x - AREA / 2) / TEXEL_M) * TEXEL_M;
    const oz = Math.floor((focus.z - AREA / 2) / TEXEL_M) * TEXEL_M;

    // Velocities from each pusher's own track; a pusher that stopped reporting is gone
    let stirring = false;
    for (const p of this.pushers) {
      if (!p.fresh) {
        p.seen = false;
        p.speed = 0;
        continue;
      }
      if (p.seen && dt > 1e-4) {
        const k = Math.min(1, dt * 12);
        p.vx += ((p.x - p.lx) / dt - p.vx) * k;
        p.vz += ((p.z - p.lz) / dt - p.vz) * k;
      } else {
        p.vx = p.vz = 0;
      }
      p.lx = p.x;
      p.lz = p.z;
      p.seen = true;
      p.speed = Math.hypot(p.vx, p.vz);
      if (p.hold > 0 || p.speed > 0.15) stirring = true;
    }

    this.probeTimer -= dt;
    if (this.probeTimer <= 0 || Math.abs(ox - this.probeX) > 2 || Math.abs(oz - this.probeZ) > 2 || this.probeRev !== duckweed.revision) {
      this.probe(ox, oz);
    }
    this.quiet = stirring && this.hasWeed ? 0 : this.quiet + dt;

    if (!this.supported || !this.hasWeed || this.quiet > SETTLE) {
      u.w = 0;
      this.asleep = true;
      this.acc = 0;
      this.endFrame();
      return;
    }
    if (!this.targets) this.allocate();
    if (this.asleep) {
      this.clearTargets(renderer);
      this.asleep = false;
    }

    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS);
    const m = this.mat.uniforms;
    m.uRelax.value.set(Math.exp(-STEP / RELAX_D), Math.exp(-STEP / RELAX_C));
    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      if (Number.isNaN(this.originX)) {
        this.originX = ox;
        this.originZ = oz;
      }
      m.uShift.value.set((ox - this.originX) / AREA, (oz - this.originZ) / AREA);
      this.originX = ox;
      this.originZ = oz;
      for (let i = 0; i < DUCKWEED_PUSHERS; i++) {
        const p = this.pushers[i];
        // Clears while moving (up to full at a brisk swim), or always by its hold
        const amount = p.fresh ? Math.max(p.hold, Math.min(1, p.speed / 1.2)) : 0;
        this.pushVecs[i].set((p.x - ox) / AREA, (p.z - oz) / AREA, p.r, amount);
        // Limit the drag speed, so a dash doesn't fling the cover across the pond
        const s = Math.min(p.speed, 4);
        const k = p.speed > 1e-3 ? s / p.speed : 0;
        this.velVecs[i].set(p.vx * k, p.vz * k, amount > 0 ? 1 : 0, 0);
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
    this.endFrame();

    duckweedUniforms.uWsWeedSim.value = this.targets![this.read].texture;
    u.set(this.originX, this.originZ, 1 / AREA, 1);
  }

  private endFrame(): void {
    for (const p of this.pushers) p.fresh = false;
  }

  /** Any duckweed in the area (plus a margin, the field reaches a little past its pushers)? */
  private probe(ox: number, oz: number): void {
    this.probeTimer = PROBE_EVERY;
    this.probeX = ox;
    this.probeZ = oz;
    this.probeRev = duckweed.revision;
    this.hasWeed = duckweed.anyIn(ox, oz, ox + AREA, oz + AREA);
  }

  private allocate(): void {
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
  }

  private clearTargets(renderer: THREE.WebGLRenderer): void {
    if (!this.targets) return;
    const prev = renderer.getRenderTarget();
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const t of this.targets) {
      renderer.setRenderTarget(t);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevColor, prevAlpha);
    this.originX = this.originZ = NaN;
    this.read = 0;
  }
}

export const duckweedSim = new DuckweedSim();
