import * as THREE from 'three';

/**
 * A cheap "looking down a tunnel" shader for the flat cave mouths (the dark opening outside and
 * the disc of daylight on the porch's end wall inside).
 *
 * Layered parallax: a few virtual cross-sections of a tunnel sit behind the plane at increasing
 * depth. The view vector is taken into the plane's frame per vertex (it is affine in the position,
 * so the interpolation stays exact), and every layer is just `p - shift * depth`: one noise fetch,
 * one smoothstep for the rock rim and one for the floor. The layers are composited front to back
 * with soft edges (softer the deeper they are) and the loop stops once the pixel is covered.
 *
 * The plane's frame comes from its normal and world up, so the meshes need no tangents: only
 * `position`, `normal` and `uv` (uv 0..1 across the disc, centre at 0.5).
 */

/** Virtual depth slices; 7 reads as a continuous tunnel with the soft edges. */
const LAYERS = 7;

interface PortalPalette {
  /** Rock right behind the opening. */
  near: THREE.Color;
  /** Rock at the far end of the slices. */
  far: THREE.Color;
  /** What is past the last slice: darkness outside, daylight inside. */
  deep: THREE.Color;
}

export interface CavePortalOptions {
  /** Half the width and height of the plane in metres (uv 0..1 spans twice this). */
  half: [number, number];
  /** Depth of the last slice behind the plane, metres. */
  depth: number;
  /** Floor height in the plane's -1..1 coordinates (0 = the bottom edge of a half disc). */
  floor: number;
  /** Tunnel centre drift per unit depth (-1..1 coordinates): down (+) or up (-) the ramp. */
  slope: number;
  /** Sideways bend of the tunnel at the far end. */
  bend: number;
  /** How much the cross-section narrows at the far end (0..1). */
  taper: number;
  /** Brightening of `deep` toward the middle (daylight glare). */
  glow: number;
  /**
   * Blend into the real rock around the plane: the outer `edge` of the radius fades out, and the
   * slices nearer than `nearFade` (of the depth) are see-through, so the cave's own lit wall shows
   * there instead of a painted rim. Omit for an opaque plane.
   */
  blend?: { edge: number; nearFade: number };
  day: PortalPalette;
  night: PortalPalette;
}

let noiseTex: THREE.DataTexture | null = null;

/** 64² tileable value noise, a few octaves, in the red channel. */
function noiseTexture(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const N = 64;
  const lattice = (period: number, seed: number) => {
    const g = new Float32Array(period * period);
    let s = seed;
    for (let i = 0; i < g.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      g[i] = s / 4294967296;
    }
    return g;
  };
  const data = new Uint8Array(N * N);
  const octaves = [
    { p: 4, w: 0.5, g: lattice(4, 11) },
    { p: 8, w: 0.3, g: lattice(8, 23) },
    { p: 16, w: 0.2, g: lattice(16, 37) },
  ];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let v = 0;
      for (const o of octaves) {
        const fx = (x / N) * o.p, fy = (y / N) * o.p;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        let tx = fx - ix, ty = fy - iy;
        tx = tx * tx * (3 - 2 * tx);
        ty = ty * ty * (3 - 2 * ty);
        const at = (i: number, j: number) => o.g[(j % o.p) * o.p + (i % o.p)];
        const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * tx;
        const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * tx;
        v += (a + (b - a) * ty) * o.w;
      }
      data[y * N + x] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  noiseTex = tex;
  return tex;
}

const shared = {
  uTime: { value: 0 },
};

const portals: { mat: THREE.ShaderMaterial; opts: CavePortalOptions }[] = [];

const vertexShader = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  varying vec2 vP;
  varying vec3 vView;
  void main() {
    vec3 transformed = position;
    vec4 wp = modelMatrix * vec4(transformed, 1.0);
    vec3 n = normalize(mat3(modelMatrix) * normal);
    // Vertical planes only: across = up x normal, along = up
    vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), n));
    vec3 b = cross(n, t);
    vec3 v = cameraPosition - wp.xyz;
    vView = vec3(dot(v, t), dot(v, b), dot(v, n));
    vP = uv * 2.0 - 1.0;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #define LAYERS ${LAYERS}
  #include <common>
  #include <fog_pars_fragment>
  uniform sampler2D uNoise;
  uniform float uTime;
  uniform vec2 uHalf;
  uniform float uDepth;
  uniform float uFloor;
  uniform float uSlope;
  uniform float uBend;
  uniform float uTaper;
  uniform float uGlow;
  uniform vec3 uNear;
  uniform vec3 uFar;
  uniform vec3 uDeep;
  uniform vec2 uBlend;
  varying vec2 vP;
  varying vec3 vView;

  void main() {
    // Shift of the -1..1 coordinates per metre of depth; grazing views are capped so the slices
    // slide softly instead of smearing
    float vz = max(vView.z, 0.35 * length(vView));
    vec2 shift = (vView.xy / vz) / uHalf;
    vec3 col = vec3(0.0);
    float cover = 0.0;
    float alpha = 0.0;
    vec2 e = vP;
    float drift = uTime * 0.006;
    for (int i = 0; i < LAYERS; i++) {
      float t = (float(i) + 1.0) / float(LAYERS);
      vec2 q = vP - shift * (t * uDepth);
      vec2 c = vec2(uBend * t * t, -uSlope * t);
      e = (q - c) / (1.0 - uTaper * t);
      float n = texture2D(uNoise, q * vec2(0.55, 0.8) + vec2(t * 0.37 + drift, t * 0.71)).r;
      float soft = 0.06 + 0.16 * t;
      float rim = smoothstep(1.0 - soft, 1.0 + soft, length(e) + (n - 0.5) * 0.3);
      float flo = smoothstep(uFloor + soft, uFloor - soft, e.y + (n - 0.5) * 0.12);
      float m = max(rim, flo);
      vec3 rock = mix(uNear, uFar, t) * (0.7 + 0.6 * n) * mix(1.0, 0.8, flo);
      #ifdef BLEND_EDGE
        // Near slices let the real wall through; they still hide what lies behind them
        float o = smoothstep(0.0, uBlend.y, t);
      #else
        float o = 1.0;
      #endif
      col += (1.0 - cover) * m * o * rock;
      alpha += (1.0 - cover) * m * o;
      cover += (1.0 - cover) * m;
      if (cover > 0.985) break;
    }
    vec3 deep = uDeep * (1.0 + uGlow * (1.0 - clamp(length(e), 0.0, 1.0)));
    col += (1.0 - cover) * deep;
    alpha += 1.0 - cover;
    #ifdef BLEND_EDGE
      alpha *= 1.0 - smoothstep(1.0 - uBlend.x, 1.0, length(vP));
      gl_FragColor = vec4(col / max(alpha, 1e-4), alpha);
    #else
      gl_FragColor = vec4(col, 1.0);
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createCavePortalMaterial(opts: CavePortalOptions): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      // Shared (not cloned): the height-fog patch keeps its uniforms live in UniformsLib.fog
      ...THREE.UniformsLib.fog,
      uNoise: { value: noiseTexture() },
      uTime: shared.uTime,
      uHalf: { value: new THREE.Vector2(...opts.half) },
      uDepth: { value: opts.depth },
      uFloor: { value: opts.floor },
      uSlope: { value: opts.slope },
      uBend: { value: opts.bend },
      uTaper: { value: opts.taper },
      uGlow: { value: opts.glow },
      uNear: { value: opts.day.near.clone() },
      uFar: { value: opts.day.far.clone() },
      uDeep: { value: opts.day.deep.clone() },
      uBlend: { value: new THREE.Vector2(opts.blend?.edge ?? 0, opts.blend?.nearFade ?? 0) },
    },
    defines: opts.blend ? { BLEND_EDGE: '' } : {},
    vertexShader,
    fragmentShader,
    fog: true,
    transparent: !!opts.blend,
    depthWrite: !opts.blend,
  });
  const entry = { mat, opts };
  portals.push(entry);
  const dispose = mat.dispose.bind(mat);
  mat.dispose = () => {
    const i = portals.indexOf(entry);
    if (i >= 0) portals.splice(i, 1);
    dispose();
  };
  return mat;
}

/** Per frame: drift and the day/night palette of every portal. */
export function updateCavePortals(dt: number, night: number): void {
  shared.uTime.value += dt;
  for (const { mat, opts } of portals) {
    const u = mat.uniforms;
    (u.uNear.value as THREE.Color).copy(opts.day.near).lerp(opts.night.near, night);
    (u.uFar.value as THREE.Color).copy(opts.day.far).lerp(opts.night.far, night);
    (u.uDeep.value as THREE.Color).copy(opts.day.deep).lerp(opts.night.deep, night);
  }
}

const lin = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const hex = (h: number) => new THREE.Color(h);

/** The dark opening of a hillside mouth, seen from outside: lit rock fading into black. */
export const LAND_MOUTH_PORTAL = (): CavePortalOptions => ({
  half: [2.5, 3.0],
  depth: 7,
  floor: 0.0,
  slope: 0.35,
  bend: 0.25,
  taper: 0.15,
  glow: 0,
  // By night the torches either side warm the first metres of rock
  day: { near: lin(0.05, 0.047, 0.04), far: lin(0.004, 0.004, 0.0045), deep: lin(0.0012, 0.0013, 0.0016) },
  night: { near: lin(0.07, 0.035, 0.014), far: lin(0.002, 0.0015, 0.0012), deep: lin(0.0008, 0.0008, 0.001) },
});

/** The sea-bed hole: blue-green water swallowing the rock. */
export const SEA_MOUTH_PORTAL = (): CavePortalOptions => ({
  half: [2.6, 3.0],
  depth: 7,
  floor: 0.0,
  slope: 0.25,
  bend: -0.2,
  taper: 0.15,
  glow: 0,
  day: { near: lin(0.02, 0.055, 0.06), far: lin(0.003, 0.009, 0.012), deep: lin(0.0015, 0.004, 0.006) },
  night: { near: lin(0.006, 0.015, 0.02), far: lin(0.001, 0.003, 0.004), deep: lin(0.0006, 0.0015, 0.002) },
});

/** Inside, on the porch's end wall: dark rock opening onto daylight (the tunnel climbs out). */
export const LAND_DAYLIGHT_PORTAL = (): CavePortalOptions => ({
  half: [1.7, 1.955],
  depth: 5,
  floor: -0.72,
  slope: -0.2,
  bend: 0.2,
  taper: 0.1,
  glow: 0.5,
  blend: { edge: 0.35, nearFade: 0.45 },
  // Rock lit like the porch walls around the disc, brighter toward the light
  day: { near: lin(0.12, 0.12, 0.125), far: lin(0.45, 0.47, 0.5), deep: hex(0xdff3ff) },
  night: { near: lin(0.012, 0.013, 0.017), far: lin(0.03, 0.035, 0.05), deep: lin(0.05, 0.07, 0.12) },
});

/** Inside, the lake porch of a sea-bed way in: sea light at the end of the flooded tunnel. */
export const SEA_DAYLIGHT_PORTAL = (): CavePortalOptions => ({
  half: [1.7, 1.955],
  depth: 5,
  floor: -0.79,
  slope: -0.2,
  bend: -0.2,
  taper: 0.1,
  glow: 0.4,
  blend: { edge: 0.35, nearFade: 0.45 },
  day: { near: lin(0.03, 0.09, 0.12), far: lin(0.06, 0.2, 0.27), deep: hex(0x5fc4e6) },
  night: { near: lin(0.002, 0.005, 0.007), far: lin(0.006, 0.02, 0.03), deep: lin(0.01, 0.04, 0.06) },
});
