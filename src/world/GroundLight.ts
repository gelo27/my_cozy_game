import * as THREE from 'three';

/**
 * Baked night light on the ground: steady lamps (street lamps and other non-flickering lights
 * outside rooms) and the warm spill from lit windows and open doors, rendered once into a
 * texture over the island and read by the terrain and the grass with one fetch.
 *
 * The dynamic light slots (NightLighting) hold only the lamps near the view, so on the ground far
 * lamps used to fade out; baked, every lamp lights the ground at any distance, and the ground's
 * light loop skips the baked lamps (fewer lights to loop over). Rebaked only when the lamps or the
 * lit windows change; flickering fires stay dynamic everywhere.
 */

/** Texel size in metres. */
const RES = 0.5;
const GN = 1024;
const GMIN = -(GN * RES) / 2;
/** Light is stored as sqrt(v / SCALE) in 8 bits: fine steps in the dim edges of a pool. */
const SCALE = 4;

const data = new Uint8Array(GN * GN * 4);
const texture = new THREE.DataTexture(data, GN, GN, THREE.RGBAFormat, THREE.UnsignedByteType);
texture.magFilter = THREE.LinearFilter;
texture.minFilter = THREE.LinearFilter;
texture.generateMipmaps = false;
texture.needsUpdate = true;

export const groundLightUniforms = {
  uGroundLight: { value: texture },
  /** Night amount (0 by day): scales the baked light. */
  uGroundLightNight: { value: 0 },
};

/** GLSL: `groundBakedLight(worldPos)` = baked light reaching the ground there (vertex or fragment). */
export const GROUND_LIGHT_GLSL = `
      uniform sampler2D uGroundLight;
      uniform float uGroundLightNight;
      vec3 groundBakedLight(vec3 wp) {
        vec2 uv = (wp.xz - ${GMIN.toFixed(1)}) * ${(1 / (GN * RES)).toFixed(6)};
        if (uGroundLightNight <= 0.001 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec3(0.0);
        vec3 s = textureLod(uGroundLight, uv, 0.0).rgb;
        return s * s * ${SCALE.toFixed(1)} * uGroundLightNight;
      }`;

/** A steady point light baked onto the ground. */
export interface BakedLamp {
  pos: THREE.Vector3;
  range: number;
  /** Linear colour times intensity */
  color: THREE.Color;
}

/** Warm light falling out of a lit window or an open door onto the ground in front of it. */
export interface WindowSpill {
  /** Centre of the opening */
  x: number;
  y: number;
  z: number;
  /** Unit horizontal direction out of the house */
  nx: number;
  nz: number;
  range: number;
  /** Linear colour times intensity */
  r: number;
  g: number;
  b: number;
}

/** Wrapped Lambert as the dynamic lights use it (WRAP = 0.25). */
const wrap = (nl: number): number => Math.max((nl + 0.25) / 1.25, 0);

export class GroundLightBaker {
  /** Statistics for the dev tools. */
  public readonly stats = { lamps: 0, spills: 0, ms: 0 };
  private key = '';
  /** Texel rect written last time, cleared before the next bake. */
  private dirty: { x0: number; z0: number; x1: number; z1: number } | null = null;
  private heights = new Float32Array(0);

  constructor(private readonly height: (x: number, z: number) => number) {}

  /** Rebakes when the lamps or the spills differ from the last bake. */
  public bake(lamps: readonly BakedLamp[], spills: readonly WindowSpill[]): void {
    let key = '';
    for (const l of lamps) key += `${l.pos.x.toFixed(2)},${l.pos.y.toFixed(2)},${l.pos.z.toFixed(2)},${l.range.toFixed(2)},${l.color.r.toFixed(3)};`;
    key += '|';
    for (const s of spills) key += `${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)},${s.nx.toFixed(2)},${s.range.toFixed(2)},${s.r.toFixed(3)};`;
    if (key === this.key) return;
    this.key = key;

    const t0 = performance.now();
    if (this.dirty) {
      const d = this.dirty;
      for (let z = d.z0; z <= d.z1; z++) data.fill(0, (z * GN + d.x0) * 4, (z * GN + d.x1 + 1) * 4);
    }
    this.dirty = null;
    let used = 0;
    for (const l of lamps) {
      // Lamps under the ground (caves) do not light the surface above them
      if (l.pos.y < this.height(l.pos.x, l.pos.z) - 0.5) continue;
      this.splat(l.pos.x, l.pos.y, l.pos.z, l.range, l.color.r, l.color.g, l.color.b, 0, 0);
      used++;
    }
    for (const s of spills) {
      // The light source sits just outside the opening; nothing falls behind its plane (indoors)
      this.splat(s.x + s.nx * 0.3, s.y, s.z + s.nz * 0.3, s.range, s.r, s.g, s.b, s.nx, s.nz, s.x, s.z);
    }
    texture.needsUpdate = true;
    this.stats.lamps = used;
    this.stats.spills = spills.length;
    this.stats.ms = performance.now() - t0;
  }

  /**
   * Adds one light. With a direction (nx, nz) only the ground in front of the plane through
   * (px, pz) gets it, fading in over 0.6 m.
   */
  private splat(lx: number, ly: number, lz: number, range: number, r: number, g: number, b: number, nx: number, nz: number, px = 0, pz = 0): void {
    const x0 = Math.max(0, Math.floor((lx - range - GMIN) / RES));
    const x1 = Math.min(GN - 1, Math.ceil((lx + range - GMIN) / RES));
    const z0 = Math.max(0, Math.floor((lz - range - GMIN) / RES));
    const z1 = Math.min(GN - 1, Math.ceil((lz + range - GMIN) / RES));
    if (x0 > x1 || z0 > z1) return;
    const d = this.dirty;
    this.dirty = d ? { x0: Math.min(d.x0, x0), z0: Math.min(d.z0, z0), x1: Math.max(d.x1, x1), z1: Math.max(d.z1, z1) } : { x0, z0, x1, z1 };

    // Heights of the texel centres plus a one-texel border (for the normals)
    const w = x1 - x0 + 3;
    const h = z1 - z0 + 3;
    if (this.heights.length < w * h) this.heights = new Float32Array(w * h);
    const hs = this.heights;
    for (let j = 0; j < h; j++) {
      const z = GMIN + (z0 + j - 1 + 0.5) * RES;
      for (let i = 0; i < w; i++) hs[j * w + i] = this.height(GMIN + (x0 + i - 1 + 0.5) * RES, z);
    }

    const r2 = range * range;
    const directed = nx !== 0 || nz !== 0;
    for (let j = 1; j < h - 1; j++) {
      const z = GMIN + (z0 + j - 1 + 0.5) * RES;
      for (let i = 1; i < w - 1; i++) {
        const x = GMIN + (x0 + i - 1 + 0.5) * RES;
        let front = 1;
        if (directed) {
          const s = (x - px) * nx + (z - pz) * nz;
          if (s <= 0) continue;
          front = s < 0.6 ? (s / 0.6) * (s / 0.6) * (3 - (2 * s) / 0.6) : 1;
        }
        const y = hs[j * w + i];
        const tx = lx - x;
        const ty = ly - y;
        const tz = lz - z;
        const d2 = tx * tx + ty * ty + tz * tz;
        if (d2 >= r2) continue;
        let att = 1 - d2 / r2;
        att *= att;
        // Ground normal from the neighbouring heights
        const gx = (hs[j * w + i - 1] - hs[j * w + i + 1]) / (2 * RES);
        const gz = (hs[(j - 1) * w + i] - hs[(j + 1) * w + i]) / (2 * RES);
        const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
        const nl = (tx * gx + ty + tz * gz) * inv / Math.max(Math.sqrt(d2), 1e-3);
        const k = att * wrap(nl) * front;
        if (k <= 0) continue;
        const o = ((z0 + j - 1) * GN + (x0 + i - 1)) * 4;
        data[o] = enc(dec(data[o]) + r * k);
        data[o + 1] = enc(dec(data[o + 1]) + g * k);
        data[o + 2] = enc(dec(data[o + 2]) + b * k);
      }
    }
  }
}

const dec = (v: number): number => {
  const s = v / 255;
  return s * s * SCALE;
};
const enc = (v: number): number => Math.round(Math.sqrt(Math.min(1, v / SCALE)) * 255);
