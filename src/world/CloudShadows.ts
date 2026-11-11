import * as THREE from 'three';

/**
 * Fake cloud shadows: soft dark patches that drift across the whole world under the clouds.
 *
 * No extra render pass and no shadow map: every lit material (through injectNightLights) samples
 * one small tiling noise texture at its world XZ, shifted along the sun direction by its height
 * and drifting with the wind, and scales only the DIRECT sun light by it. The sky and bounce light
 * stay, so a patch reads as "the sun went behind a cloud", not as grey paint. One texture fetch
 * per pixel; the CPU only moves a few uniforms per frame.
 *
 * The patches follow the weather's cloud cover with the sky's own threshold, so a clear sky casts
 * a few small shadows and a cloudy one large ones. Under full overcast (everything in shadow) the
 * weather already dims the sun, so the patches fade out there instead of darkening twice.
 */
export interface CloudShadowSettings {
  enabled: boolean;
  /** How much of the sun a cloud takes away (0..1). */
  strength: number;
  /** Size of the cloud pattern: metres per repeat of the largest shapes. */
  size: number;
  /** Drift speed (m/s). */
  speed: number;
  /** Edge softness (noise units; larger = blurrier edges). */
  softness: number;
  /** Shift of the cover the shadows use (-0.5..0.5): more or fewer shadows than the sky shows. */
  coverBias: number;
}

export const CLOUD_SHADOW_DEFAULTS: Readonly<CloudShadowSettings> = {
  enabled: true,
  strength: 0.55,
  size: 220,
  speed: 2.5,
  softness: 0.12,
  coverBias: 0,
};

const STORAGE_KEY = 'farm.cloudShadows';

function load(): CloudShadowSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) return { ...CLOUD_SHADOW_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // ignore broken storage
  }
  return { ...CLOUD_SHADOW_DEFAULTS };
}

export const cloudShadowSettings: CloudShadowSettings = load();

export function saveCloudShadowSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cloudShadowSettings));
  } catch {
    // storage full / disabled: settings simply do not persist
  }
}

export function resetCloudShadowSettings(): void {
  Object.assign(cloudShadowSettings, CLOUD_SHADOW_DEFAULTS);
  saveCloudShadowSettings();
}

// ------------------------------------------------------------------ noise texture

const RES = 128;

/** Tileable value-noise fBm (4 octaves, the sky's weights), 0..~0.94 like the sky's fbm. */
function bakeNoise(): THREE.DataTexture {
  const data = new Uint8Array(RES * RES);
  const hash = (x: number, y: number, o: number) => {
    let h = (x * 374761393 + y * 668265263 + o * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      let v = 0;
      let a = 0.5;
      for (let o = 0; o < 4; o++) {
        const period = 4 << o; // lattice cells across the texture: whole numbers, so it tiles
        const fx = (x / RES) * period;
        const fy = (y / RES) * period;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const ux = smooth(fx - ix);
        const uy = smooth(fy - iy);
        const x0 = ix % period;
        const x1 = (ix + 1) % period;
        const y0 = iy % period;
        const y1 = (iy + 1) % period;
        const top = hash(x0, y0, o) + (hash(x1, y0, o) - hash(x0, y0, o)) * ux;
        const bot = hash(x0, y1, o) + (hash(x1, y1, o) - hash(x0, y1, o)) * ux;
        v += a * (top + (bot - top) * uy);
        a *= 0.5;
      }
      data[y * RES + x] = Math.round(Math.min(1, v) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, RES, RES, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export const cloudShadowUniforms = {
  uCsMap: { value: bakeNoise() as THREE.Texture },
  /** x = 1 / size, y..z = noise threshold (low, high), w = strength (0 = off: the sample is skipped). */
  uCsA: { value: new THREE.Vector4(1 / 220, 0.5, 0.6, 0) },
  /** xy = drift offset (texture units), zw = XZ shift per metre of height (toward the sun). */
  uCsB: { value: new THREE.Vector4() },
};

/**
 * GLSL declarations; `csShade(world)` is the share of direct sun that gets through (1 = none blocked).
 */
export const CLOUD_SHADOW_GLSL = /* glsl */ `
uniform sampler2D uCsMap;
uniform vec4 uCsA;
uniform vec4 uCsB;
float csShade(vec3 w) {
  vec2 uv = (w.xz + uCsB.zw * w.y) * uCsA.x + uCsB.xy;
  return 1.0 - uCsA.w * smoothstep(uCsA.y, uCsA.z, texture2D(uCsMap, uv).r);
}`;

/**
 * Computed before the lights (so later chunks, like the water's sun glint, can use `csSun`),
 * applied to the direct light after them.
 */
export const CLOUD_SHADOW_BEGIN = /* glsl */ `
float csSun = 1.0;
if (uCsA.w > 0.0) csSun = csShade(cameraPosition + transpose(mat3(viewMatrix)) * (-vViewPosition));
`;
export const CLOUD_SHADOW_END = /* glsl */ `
reflectedLight.directDiffuse *= csSun;
reflectedLight.directSpecular *= csSun;
`;

// ------------------------------------------------------------------ per frame

/** Cloud drift direction in world XZ: the way the sky's cloud layer moves. */
const DRIFT = new THREE.Vector2(-0.010, -0.0035).normalize();
const off = new THREE.Vector2();

/**
 * @param sunDir unit vector toward the sun
 * @param cover the weather's 0..1 cloud cover
 * @param night 0..1 night factor (no sun shadows at night)
 */
export function updateCloudShadows(dt: number, sunDir: THREE.Vector3, cover: number, night: number): void {
  const s = cloudShadowSettings;
  const u = cloudShadowUniforms;
  const size = Math.max(10, s.size);
  off.x = (off.x + (DRIFT.x * s.speed * dt) / size) % 1;
  off.y = (off.y + (DRIFT.y * s.speed * dt) / size) % 1;
  const sy = Math.max(sunDir.y, 0.25);
  u.uCsB.value.set(off.x, off.y, -sunDir.x / sy, -sunDir.z / sy);

  const c = THREE.MathUtils.clamp(cover + s.coverBias, 0, 1);
  // The sky's own threshold: dens = smoothstep(thr * 0.75, thr * 0.75 + 0.2, fbm), thr = 1 - cover
  const thr = (1 - c) * 0.75;
  const soft = Math.max(0.01, s.softness);
  u.uCsA.value.set(1 / size, thr, thr + soft, 0);
  // Fade out under full overcast (the weather dims the sun itself), at night and at sunset
  const amount = s.enabled
    ? s.strength * (1 - THREE.MathUtils.smoothstep(c, 0.78, 0.97)) * (1 - night) * THREE.MathUtils.smoothstep(sunDir.y, 0.0, 0.15)
    : 0;
  u.uCsA.value.w = amount;
}
