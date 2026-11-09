import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { injectNightLights } from './NightLighting';
import { injectWaterline } from '../scene/WaterDetails';
import { isMobileDevice } from './WorldSettings';
import type { PropInstance } from './PropSystem';

const ALGAE_URL = `${import.meta.env.BASE_URL}models/algae_chain.glb`;

/** Chain links per stalk (the editor's length slider). */
export const ALGAE_MIN_LINKS = 1;
export const ALGAE_MAX_LINKS = 40;
export const ALGAE_DEFAULT_LINKS = 8;
export const clampLinks = (n: number | undefined): number =>
  Math.round(THREE.MathUtils.clamp(n ?? ALGAE_DEFAULT_LINKS, ALGAE_MIN_LINKS, ALGAE_MAX_LINKS));

/** Cells (m) the stalks are batched in; one InstancedMesh per chain length per cell. */
const CELL = 32;
/**
 * Draw distance (m, camera to the cell's nearest edge). Underwater the fog closes in long before
 * this, so stalks never visibly pop; from the shore the water hides them too.
 */
const VIEW_DIST = isMobileDevice() ? 30 : 42;

// Physical chain: one Verlet joint per link boundary plus the tip, all in world metres
/** Upward pull of the gas-filled fronds (m/s²): what stands a stalk back up. */
const BUOYANCY = 10;
/** Water drag (1/s): how fast the swing dies out. */
const DRAG = 3.4;
/** Bending resistance (0..1 per iteration): how hard joints two apart keep their straight distance. */
const STIFFNESS = 0.08;
/** Constraint iterations per step (link lengths, stiffness, contacts). */
const ITERATIONS = 5;
/** Share of a joint's overlap with a body removed per iteration (soft: no fight with the links). */
const CONTACT_SOFTNESS = 0.35;
/** Share of a touching joint's velocity the contact takes away (no bounce off the body). */
const CONTACT_DAMP = 0.25;
/** Largest body motion (m per step) that drags the fronds (teleports and respawns don't fling them). */
const MAX_DRAG_STEP = 0.08;
/** Share of a touching body's motion the joints are dragged along with (water friction). */
const FRICTION = 0.35;
/** A joint's own thickness for contacts (m at scale 1). */
const NODE_RADIUS = 0.12;
const MAX_PUSHERS = 8;
/** Stalks simulated at once (rows of the joint texture); the rest wait at rest. */
const MAX_SIM = 64;
/** Joints per stalk at most: the root, one per link, the tip. */
const MAX_JOINTS = ALGAE_MAX_LINKS + 2;
const SUBSTEP = 1 / 60;
/** At rest this long (s) with no body touching, a stalk stops being simulated. */
const SLEEP_AFTER = 0.6;

// ------------------------------------------------------------------ geometry

interface Parts {
  chain: THREE.BufferGeometry;
  top: THREE.BufferGeometry;
  /** Link height: one link's bottom ring meets the next one's top ring. */
  linkH: number;
  /** Where the link's bottom ring sits (its local min y). */
  linkMinY: number;
}

let parts: Parts | null = null;
let loading: Promise<boolean> | null = null;
const geometryCache = new Map<number, THREE.BufferGeometry>();

/** Loads algae_chain.glb once (its "chain" link and the "top" that caps a stalk). */
export function loadAlgaeParts(): Promise<boolean> {
  if (loading) return loading;
  loading = new GLTFLoader()
    .loadAsync(ALGAE_URL)
    .then((gltf) => {
      const chain = gltf.scene.getObjectByName('chain') as THREE.Mesh | undefined;
      const top = gltf.scene.getObjectByName('top') as THREE.Mesh | undefined;
      if (!chain?.isMesh || !top?.isMesh) throw new Error('algae_chain.glb needs "chain" and "top" meshes');
      const bake = (m: THREE.Mesh) => {
        m.updateWorldMatrix(true, false);
        const g = m.geometry.clone();
        // Only the node's own transform: the scene root may carry nothing else
        g.applyMatrix4(m.matrixWorld);
        g.computeBoundingBox();
        return g;
      };
      const c = bake(chain);
      const t = bake(top);
      const box = c.boundingBox!;
      parts = { chain: c, top: t, linkH: box.max.y - box.min.y, linkMinY: box.min.y };
      uAlgLinkH.value = parts.linkH;
      uAlgTopH.value = t.boundingBox!.max.y - t.boundingBox!.min.y;
      // The model's brightest green: its colours become shades (1 = full colour) for the tint
      const ca = c.getAttribute('color');
      let ref = 0;
      if (ca) for (let i = 0; i < ca.count; i++) ref = Math.max(ref, ca.getY(i));
      if (ref > 0) uAlgShadeRef.value = ref;
      gltf.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      return true;
    })
    .catch((err) => {
      console.warn('[Algae] algae_chain.glb failed to load', err);
      return false;
    });
  return loading;
}

/** Height (m, scale 1) of a stalk of `links` links with its top; 0 before the model loads. */
export function algaeHeight(links: number): number {
  if (!parts) return 0;
  const topH = parts.top.boundingBox!.max.y - parts.top.boundingBox!.min.y;
  return links * parts.linkH + topH;
}

/**
 * One stalk as a single welded, smooth-shaded mesh: `links` chain links stacked (alternating 0° / 90°
 * around the stem; the stem ring is square so the seams still meet), the top on the
 * last one. Vertices that share a spot (link seams, the model's flat-shading splits) are welded
 * and get one averaged normal, so the stalk shades as one smooth surface. Attributes: position,
 * normal, color and aAlg (x: 0..1 up the stalk, y: the stalk's height), for the bend shader.
 */
export function algaeGeometry(links: number): THREE.BufferGeometry | null {
  if (!parts) return null;
  const n = clampLinks(links);
  const cached = geometryCache.get(n);
  if (cached) return cached;

  const pieces: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  // Links alternate 0° / 90° around the stem, so neighbours' leaves cross
  const turn = (i: number) => (i % 2) * (Math.PI / 2);
  for (let i = 0; i < n; i++) {
    q.setFromAxisAngle(yAxis, turn(i));
    m.compose(new THREE.Vector3(0, i * parts.linkH - parts.linkMinY, 0), q, one);
    pieces.push({ g: parts.chain, m: m.clone() });
  }
  q.setFromAxisAngle(yAxis, turn(n));
  m.compose(new THREE.Vector3(0, n * parts.linkH - parts.top.boundingBox!.min.y, 0), q, one);
  pieces.push({ g: parts.top, m: m.clone() });

  let vCount = 0;
  let iCount = 0;
  for (const p of pieces) {
    vCount += p.g.getAttribute('position').count;
    iCount += p.g.index ? p.g.index.count : p.g.getAttribute('position').count;
  }
  const pos = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  const v = new THREE.Vector3();
  let vo = 0;
  let io = 0;
  for (const p of pieces) {
    const pa = p.g.getAttribute('position');
    const ca = p.g.getAttribute('color');
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i).applyMatrix4(p.m);
      pos[(vo + i) * 3] = v.x;
      pos[(vo + i) * 3 + 1] = v.y;
      pos[(vo + i) * 3 + 2] = v.z;
      // getX/Y/Z denormalize the model's 16-bit colours
      col[(vo + i) * 3] = ca ? ca.getX(i) : 0.05;
      col[(vo + i) * 3 + 1] = ca ? ca.getY(i) : 0.35;
      col[(vo + i) * 3 + 2] = ca ? ca.getZ(i) : 0.05;
    }
    if (p.g.index) for (let k = 0; k < p.g.index.count; k++) idx[io + k] = vo + p.g.index.getX(k);
    else for (let k = 0; k < pa.count; k++) idx[io + k] = vo + k;
    vo += pa.count;
    io += p.g.index ? p.g.index.count : pa.count;
  }

  weldPositions(pos);

  let height = 0;
  for (let i = 0; i < vCount; i++) height = Math.max(height, pos[i * 3 + 1]);
  // Joint coordinate: 0..n along the links (one per link), n..n+1 over the top
  const chainTop = n * parts.linkH;
  const alg = new Float32Array(vCount * 2);
  for (let i = 0; i < vCount; i++) {
    const y = Math.max(0, pos[i * 3 + 1]);
    alg[i * 2] = y <= chainTop ? y / parts.linkH : n + Math.min(1, (y - chainTop) / Math.max(height - chainTop, 1e-4));
    alg[i * 2 + 1] = height;
  }

  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(smoothNormals(pos, idx), 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aAlg', new THREE.BufferAttribute(alg, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  // Drop the now identical duplicates (same spot, normal and colour)
  g = mergeVertices(g, 1e-4);
  if (g.getAttribute('position').count < 65536) g.setIndex(new THREE.BufferAttribute(Uint16Array.from(g.index!.array as Uint32Array), 1));
  g.clearGroups();
  g.addGroup(0, g.index!.count, 0);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  geometryCache.set(n, g);
  return g;
}

/** Snaps vertices closer than WELD (the seam rings, the flat-shading duplicates) onto one spot. */
const WELD = 0.003;
function weldPositions(pos: Float32Array): void {
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x}|${y}|${z}`;
  const count = pos.length / 3;
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const gx = Math.floor(x / WELD);
    const gy = Math.floor(y / WELD);
    const gz = Math.floor(z / WELD);
    let found = -1;
    for (let dz = -1; dz <= 1 && found < 0; dz++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dx = -1; dx <= 1 && found < 0; dx++) {
          const list = grid.get(key(gx + dx, gy + dy, gz + dz));
          if (!list) continue;
          for (const j of list) {
            const ex = pos[j * 3] - x;
            const ey = pos[j * 3 + 1] - y;
            const ez = pos[j * 3 + 2] - z;
            if (ex * ex + ey * ey + ez * ez < WELD * WELD) {
              found = j;
              break;
            }
          }
        }
      }
    }
    if (found >= 0) {
      pos[i * 3] = pos[found * 3];
      pos[i * 3 + 1] = pos[found * 3 + 1];
      pos[i * 3 + 2] = pos[found * 3 + 2];
      continue;
    }
    const k = key(gx, gy, gz);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
}

/** Area-weighted face normals summed per position (not per vertex), so splits shade smoothly. */
function smoothNormals(pos: Float32Array, idx: Uint32Array): Float32Array {
  const sums = new Map<string, THREE.Vector3>();
  const k = (i: number) => `${pos[i * 3]}|${pos[i * 3 + 1]}|${pos[i * 3 + 2]}`;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t];
    const i1 = idx[t + 1];
    const i2 = idx[t + 2];
    a.fromArray(pos, i0 * 3);
    b.fromArray(pos, i1 * 3);
    c.fromArray(pos, i2 * 3);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    const fn = ab.cross(ac); // length = twice the area
    for (const i of [i0, i1, i2]) {
      const key = k(i);
      const s = sums.get(key);
      if (s) s.add(fn);
      else sums.set(key, fn.clone());
    }
  }
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length / 3; i++) {
    const s = sums.get(k(i));
    if (!s || s.lengthSq() < 1e-14) {
      out[i * 3 + 1] = 1;
      continue;
    }
    const nn = s.clone().normalize();
    out[i * 3] = nn.x;
    out[i * 3 + 1] = nn.y;
    out[i * 3 + 2] = nn.z;
  }
  return out;
}

// ------------------------------------------------------------------ material

const uAlgTime = { value: 0 };
const uAlgLinkH = { value: 0.18 };
const uAlgTopH = { value: 0.3 };
/** Joint offsets (world m, from the straight rest pose) of the simulated stalks: one row each. */
const simData = new Float32Array(MAX_JOINTS * MAX_SIM * 4);
const simTexture = new THREE.DataTexture(simData, MAX_JOINTS, MAX_SIM, THREE.RGBAFormat, THREE.FloatType);
simTexture.minFilter = simTexture.magFilter = THREE.NearestFilter;
simTexture.needsUpdate = true;
const uAlgSim = { value: simTexture };

// ------------------------------------------------------------------ look (developer panel)

/** Colours (sRGB hex) and the sunlight shimmer; edited live in the developer panel. */
export interface AlgaeSettings {
  /** Colour at the root. */
  baseColor: number;
  /** Colour at the top (blended up the stalk). */
  tipColor: number;
  /** Sunlight playing over the fronds by day (0: off). */
  shimmer: number;
  shimmerSpeed: number;
  /** Size of the light pattern: higher is finer. */
  shimmerScale: number;
  shimmerColor: number;
}

export const ALGAE_DEFAULTS: Readonly<AlgaeSettings> = {
  baseColor: 0x2f9a3a,
  tipColor: 0x5cc24a,
  shimmer: 0.5,
  shimmerSpeed: 1,
  shimmerScale: 0.9,
  shimmerColor: 0xffffff,
};

const ALGAE_STORAGE_KEY = 'farm.algaeSettings.v1';

function loadAlgaeSettings(): AlgaeSettings {
  const out: AlgaeSettings = { ...ALGAE_DEFAULTS };
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(ALGAE_STORAGE_KEY) : null;
    if (raw) {
      const saved = JSON.parse(raw) as Partial<AlgaeSettings>;
      for (const k of Object.keys(ALGAE_DEFAULTS) as (keyof AlgaeSettings)[]) {
        if (typeof saved[k] === 'number' && Number.isFinite(saved[k])) out[k] = saved[k]!;
      }
    }
  } catch { /* private mode / bad JSON: defaults */ }
  return out;
}

export const algaeSettings: AlgaeSettings = loadAlgaeSettings();

const uAlgBase = { value: new THREE.Color() };
const uAlgTip = { value: new THREE.Color() };
const uAlgShadeRef = { value: 0.45 };
const uAlgShimmer = { value: 0 };
const uAlgShimmerSpeed = { value: 1 };
const uAlgShimmerScale = { value: 1 };
const uAlgShimmerColor = { value: new THREE.Color() };
/** 0 at night, in caves and under heavy cloud; 1 in full daylight (GameEngine feeds it). */
const uAlgDay = { value: 1 };

function applyAlgaeSettings(): void {
  const a = algaeSettings;
  uAlgBase.value.setHex(a.baseColor);
  uAlgTip.value.setHex(a.tipColor);
  uAlgShimmer.value = a.shimmer;
  uAlgShimmerSpeed.value = a.shimmerSpeed;
  uAlgShimmerScale.value = a.shimmerScale;
  uAlgShimmerColor.value.setHex(a.shimmerColor);
}
applyAlgaeSettings();

/** Sets one look value (applies at once) and keeps it in this browser. */
export function setAlgae<K extends keyof AlgaeSettings>(key: K, value: AlgaeSettings[K]): void {
  algaeSettings[key] = value;
  applyAlgaeSettings();
  try {
    localStorage.setItem(ALGAE_STORAGE_KEY, JSON.stringify(algaeSettings));
  } catch { /* storage unavailable */ }
}

export function resetAlgaeSettings(): void {
  Object.assign(algaeSettings, ALGAE_DEFAULTS);
  setAlgae('shimmer', ALGAE_DEFAULTS.shimmer);
}

/** How much sunlight reaches the algae now (0..1); call once per frame. */
export function setAlgaeDaylight(day: number): void {
  uAlgDay.value = day;
}

/**
 * Vertex colours plus the chain pose, all in the vertex shader. A stalk's joints are its straight
 * rest pose, a slow current sway on its own phase and, while it is simulated, its row of joint
 * offsets from the physics. The stem follows a Catmull-Rom curve through the joints and every
 * vertex is turned with the curve's tangent, so links (and their fronds) really rotate as the
 * stalk bends; normals turn with them.
 */
function createAlgaeMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    injectNightLights(shader);
    injectWaterline(shader);
    shader.uniforms.uAlgTime = uAlgTime;
    shader.uniforms.uAlgLinkH = uAlgLinkH;
    shader.uniforms.uAlgTopH = uAlgTopH;
    shader.uniforms.uAlgSim = uAlgSim;
    Object.assign(shader.uniforms, {
      uAlgBase, uAlgTip, uAlgShadeRef, uAlgShimmer, uAlgShimmerSpeed, uAlgShimmerScale, uAlgShimmerColor, uAlgDay,
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uAlgTime;
uniform float uAlgLinkH;
uniform float uAlgTopH;
uniform sampler2D uAlgSim;
// x: joint coordinate (0..links over the links, links..links+1 over the top), y: stalk height
attribute vec2 aAlg;
#ifdef USE_INSTANCING
// Row of the joint texture + 1 (0: not simulated)
attribute float aAlgRow;
// Per-stalk colours (linear): root and top, w = 1 when the stalk has its own
attribute vec4 aAlgBaseC;
attribute vec4 aAlgTipC;
#endif
uniform vec3 uAlgBase;
uniform vec3 uAlgTip;
uniform float uAlgShadeRef;
uniform float uAlgShimmer;
uniform float uAlgShimmerSpeed;
uniform float uAlgShimmerScale;
uniform float uAlgDay;
varying float vAlgShimmer;
// Offset of joint k (world axes): current sway plus the simulated offset
vec3 algJoint(int k, int last, float links, float H, vec2 cur, int row) {
  int kc = clamp(k, 0, last);
  float hk = float(kc) <= links ? float(kc) * uAlgLinkH : H;
  float e = hk / H;
  vec3 o = vec3(cur.x, 0.0, cur.y) * (e * e);
  if (row >= 0) o += texelFetch(uAlgSim, ivec2(kc, row), 0).xyz;
  return o;
}
// Rotates w by the rotation that takes +Y onto the unit vector t
vec3 algTurn(vec3 w, vec3 t) {
  if (t.y < -0.95) return w;
  vec3 v = vec3(t.z, 0.0, -t.x);
  vec3 vw = cross(v, w);
  return w + vw + cross(v, vw) / (1.0 + t.y);
}`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
vec3 algLocal = position;
vAlgShimmer = 0.0;
#ifdef USE_INSTANCING
{
  mat3 im = mat3(instanceMatrix);
  float s2 = dot(im[0], im[0]);
  float s = sqrt(s2);
  vec3 ip = instanceMatrix[3].xyz;
  float H = aAlg.y;
  float links = floor((H - uAlgTopH) / uAlgLinkH + 0.5);
  int last = int(links) + 1;
  int row = int(aAlgRow + 0.5) - 1;
  float ph = ip.x * 0.73 + ip.z * 0.41;
  vec2 cur = vec2(
    sin(uAlgTime * 0.7 + ph) + 0.25 * sin(uAlgTime * 1.3 + ph * 2.3),
    cos(uAlgTime * 0.55 + ph * 1.3)
  ) * (0.05 * H * s);
  float u = clamp(aAlg.x, 0.0, float(last));
  int k = int(min(floor(u), float(last - 1)));
  float f = u - float(k);
  vec3 p1 = algJoint(k, last, links, H, cur, row);
  vec3 p2 = algJoint(k + 1, last, links, H, cur, row);
  // Mirrored past the ends so the curve leaves the root and reaches the tip straight
  vec3 p0 = k > 0 ? algJoint(k - 1, last, links, H, cur, row) : 2.0 * p1 - p2;
  vec3 p3 = k + 1 < last ? algJoint(k + 2, last, links, H, cur, row) : 2.0 * p2 - p1;
  vec3 c1 = -p0 + p2;
  vec3 c2 = 2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3;
  vec3 c3 = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
  vec3 off = 0.5 * (2.0 * p1 + c1 * f + c2 * f * f + c3 * f * f * f);
  vec3 dOff = 0.5 * (c1 + 2.0 * c2 * f + 3.0 * c3 * f * f);
  // This span's rest length (world): a link, or the top
  float topLen = H - links * uAlgLinkH;
  float span = (float(k) < links ? uAlgLinkH : topLen) * s;
  vec3 t = normalize(vec3(0.0, span, 0.0) + dOff);
  // Rest height (local) of the stem point at this joint coordinate
  float y = u <= links ? u * uAlgLinkH : links * uAlgLinkH + (u - links) * topLen;
  // World: stem point, its curve offset, and the vertex's own part turned with the stem
  vec3 side = im * vec3(position.x, position.y - y, position.z);
  vec3 world = vec3(0.0, y * s, 0.0) + off + algTurn(side, t);
  algLocal = transpose(im) * world / s2;

  // Colour: the picked root-to-top gradient, shaded by the model's own colours
  float up = u / float(last);
  #ifdef USE_COLOR
  vec3 algBase = aAlgBaseC.w > 0.5 ? aAlgBaseC.rgb : uAlgBase;
  vec3 algTip = aAlgTipC.w > 0.5 ? aAlgTipC.rgb : uAlgTip;
  vColor.rgb = mix(algBase, algTip, smoothstep(0.0, 1.0, up)) * (color.g / uAlgShadeRef);
  #endif

  // Sunlight shimmer, per vertex: two drifting, warped wave fields crossed like caustics, plus a
  // glow running up the stalk; brighter toward the top (nearer the surface). Nothing by night.
  if (uAlgShimmer * uAlgDay > 0.001) {
    vec3 wp = ip + world;
    float tt = uAlgTime * uAlgShimmerSpeed;
    vec2 sq = wp.xz * uAlgShimmerScale;
    float sy = wp.y * uAlgShimmerScale;
    float wa = sin(sq.x * 1.3 + sy * 0.6 + tt * 0.42 + sin(sq.y * 0.9 + tt * 0.27) * 1.6);
    float wb = sin(sq.y * 1.1 - sy * 0.8 - tt * 0.35 + sin(sq.x * 0.8 - tt * 0.23) * 1.6);
    float caustic = max(wa * wb, 0.0);
    float flow = 0.5 + 0.5 * sin(u * 0.9 - tt * 0.8 + ph);
    vAlgShimmer = caustic * caustic * (0.45 + 0.55 * flow) * mix(0.45, 1.0, up) * uAlgShimmer * uAlgDay * 1.6;
  }
  objectNormal = transpose(im) * algTurn(im * objectNormal, t) / s2;
}
#endif`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
transformed = algLocal;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uAlgShimmerColor;
varying float vAlgShimmer;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
// Sunlight through the water: the frond's own colour, lighter (a brighter shade of it with a
// touch of the shimmer tint and a little white), not a pale wash over it
vec3 algLight = diffuseColor.rgb * (0.6 + 0.4 * uAlgShimmerColor) * 2.2 + uAlgShimmerColor * 0.06;
totalEmissiveRadiance += algLight * vAlgShimmer;`
      );
  };
  mat.customProgramCacheKey = () => 'algae-chain-5';
  return mat;
}

export const ALGAE_MATERIAL = createAlgaeMaterial();

// ------------------------------------------------------------------ field

interface AlgaeBatch {
  links: number;
  cx: number;
  cz: number;
  mesh: THREE.InstancedMesh;
  /** Per instance: joint-texture row + 1 (0 = not simulated). */
  row: THREE.InstancedBufferAttribute;
  /** Per instance: root colour rgb + own flag, top colour rgb + own flag (8 floats). */
  cols: THREE.InstancedInterleavedBuffer;
  recs: AlgaeRec[];
  dirty: boolean;
  minY: number;
  maxY: number;
}

interface AlgaeRec {
  prop: PropInstance;
  batch: AlgaeBatch | null;
  slot: number;
  /** Stalk height in world metres. */
  height: number;
  /** Joint-texture row while simulated, else -1. */
  sim: number;
}

/** A simulated stalk's joints (world positions now and one step ago). */
interface SimChain {
  rec: AlgaeRec;
  joints: number;
  /** Rest height of each joint above the root (world m). */
  rest: Float32Array;
  p: Float32Array;
  q: Float32Array;
  /** Joints after the step before the last one: drawn blended toward `p` between steps. */
  prev: Float32Array;
  quiet: number;
}

/**
 * Algae stalks: each a welded chain mesh shared by every stalk of that length, drawn instanced per
 * 32 m cell and length, culled beyond a short (underwater) view distance. A stalk a body touches
 * becomes a real chain: Verlet joints (one per link and the tip) kept at their link lengths,
 * lifted by buoyancy, slowed by the water, pushed and dragged by the bodies. Its joints go to the
 * GPU as one row of a small float texture until it settles; the rest only sway in the shader.
 */
export class AlgaeField {
  public readonly group = new THREE.Group();
  private readonly batches = new Map<string, AlgaeBatch>();
  private readonly recs = new Map<number, AlgaeRec>();
  private readonly chains: (SimChain | null)[] = new Array(MAX_SIM).fill(null);
  private readonly active: SimChain[] = [];
  private readonly pushers = new Float32Array(MAX_PUSHERS * 5);
  private readonly lastPushers = new Float32Array(MAX_PUSHERS * 5);
  private pusherCount = 0;
  private lastPusherCount = 0;
  /** Unstepped time (s): the chains step at a fixed rate (Verlet needs a steady step). */
  private accumulator = 0;
  private static readonly _m = new THREE.Matrix4();
  private static readonly _q = new THREE.Quaternion();
  private static readonly _s = new THREE.Vector3();
  private static readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(parent: THREE.Object3D) {
    this.group.name = 'Algae';
    parent.add(this.group);
    void loadAlgaeParts().then((ok) => {
      if (!ok) return;
      for (const r of this.recs.values()) this.attach(r);
    });
  }

  public add(prop: PropInstance): void {
    const r: AlgaeRec = { prop, batch: null, slot: -1, height: 0, sim: -1 };
    this.recs.set(prop.id, r);
    this.attach(r);
  }

  public remove(id: number): void {
    const r = this.recs.get(id);
    if (!r) return;
    this.release(r);
    this.detach(r);
    this.recs.delete(id);
  }

  /** The prop's own colours changed (or were cleared back to the panel's). */
  public recolor(prop: PropInstance): void {
    const r = this.recs.get(prop.id);
    if (r?.batch) this.writeColors(r);
  }

  /** The prop moved, turned, scaled or changed length. */
  public refresh(prop: PropInstance): void {
    const r = this.recs.get(prop.id);
    if (!r) return;
    // Its joints no longer fit: it starts again from rest
    this.release(r);
    const links = clampLinks(prop.length);
    const b = r.batch;
    if (b && b.links === links && b.cx === Math.floor(prop.position.x / CELL) && b.cz === Math.floor(prop.position.z / CELL)) {
      this.writeMatrix(r);
      return;
    }
    this.detach(r);
    this.attach(r);
  }

  public pick(raycaster: THREE.Raycaster): { id: number; point: THREE.Vector3; distance: number } | null {
    let best: { id: number; point: THREE.Vector3; distance: number } | null = null;
    for (const b of this.batches.values()) {
      if (!b.mesh.count) continue;
      const h = raycaster.intersectObject(b.mesh, false)[0];
      if (h && h.instanceId !== undefined && (!best || h.distance < best.distance)) {
        best = { id: b.recs[h.instanceId].prop.id, point: h.point.clone(), distance: h.distance };
      }
    }
    return best;
  }

  public clearPushers(): void {
    this.lastPushers.set(this.pushers);
    this.lastPusherCount = this.pusherCount;
    this.pusherCount = 0;
  }

  /**
   * A body that parts the algae: a vertical capsule from `y` (its bottom) up `height`, `radius`
   * wide. Add the same bodies in the same order every frame: their motion drags the fronds along.
   */
  public addPusher(x: number, y: number, z: number, radius: number, height: number): void {
    if (this.pusherCount >= MAX_PUSHERS) return;
    const o = this.pusherCount++ * 5;
    this.pushers[o] = x;
    this.pushers[o + 1] = y;
    this.pushers[o + 2] = z;
    this.pushers[o + 3] = radius;
    this.pushers[o + 4] = height;
  }

  /** Per frame (after the pushers): wakes touched stalks, steps the chains, culls the cells. */
  public update(dt: number, camera: THREE.Vector3): void {
    uAlgTime.value += dt;
    if (!this.recs.size) return;
    this.wakeTouched();
    if (this.active.length) {
      this.accumulator = Math.min(this.accumulator + dt, SUBSTEP * 4);
      const steps = Math.floor(this.accumulator / SUBSTEP);
      this.accumulator -= steps * SUBSTEP;
      for (let i = 0; i < steps; i++) {
        for (let c = 0; c < this.active.length; c++) {
          const ch = this.active[c];
          ch.prev.set(ch.p);
          this.step(ch, SUBSTEP, 1 / steps);
        }
      }
      // Drawn between the last two steps, so the motion is smooth at any frame rate (a frame
      // gets 0, 1 or 2 fixed steps)
      const alpha = this.accumulator / SUBSTEP;
      for (let c = this.active.length - 1; c >= 0; c--) {
        const ch = this.active[c];
        this.upload(ch, alpha);
        ch.quiet += dt;
        if (ch.quiet > SLEEP_AFTER && this.atRest(ch)) this.release(ch.rec);
      }
      simTexture.needsUpdate = true;
    }

    for (const b of this.batches.values()) {
      if (b.dirty) {
        b.row.needsUpdate = true;
        b.dirty = false;
      }
      const x0 = b.cx * CELL;
      const z0 = b.cz * CELL;
      const dx = Math.max(x0 - camera.x, 0, camera.x - x0 - CELL);
      const dz = Math.max(z0 - camera.z, 0, camera.z - z0 - CELL);
      const dy = Math.max(b.minY - camera.y, 0, camera.y - b.maxY);
      b.mesh.visible = b.recs.length > 0 && dx * dx + dz * dz + dy * dy < VIEW_DIST * VIEW_DIST;
    }
  }

  /** Starts simulating the resting stalks a pusher touches (only the pushers' cells are scanned). */
  private wakeTouched(): void {
    for (let p = 0; p < this.pusherCount; p++) {
      const o = p * 5;
      const px = this.pushers[o];
      const py0 = this.pushers[o + 1];
      const pz = this.pushers[o + 2];
      const pr = this.pushers[o + 3];
      const py1 = py0 + this.pushers[o + 4];
      const reach = pr + 1;
      const cx0 = Math.floor((px - reach) / CELL);
      const cx1 = Math.floor((px + reach) / CELL);
      const cz0 = Math.floor((pz - reach) / CELL);
      const cz1 = Math.floor((pz + reach) / CELL);
      for (const b of this.batches.values()) {
        if (b.cx < cx0 || b.cx > cx1 || b.cz < cz0 || b.cz > cz1) continue;
        if (py0 > b.maxY + pr || py1 < b.minY - pr) continue;
        for (const r of b.recs) {
          if (r.sim >= 0) continue;
          const pp = r.prop.position;
          // A resting stalk stands straight (give or take its sway): only a body on that line wakes it
          const near = pr + NODE_RADIUS * r.prop.scale + r.height * 0.1;
          const dx = pp.x - px;
          const dz = pp.z - pz;
          if (dx * dx + dz * dz > near * near) continue;
          if (py0 > pp.y + r.height + pr || py1 < pp.y - pr) continue;
          this.simulate(r);
        }
      }
    }
  }

  private simulate(r: AlgaeRec): void {
    const b = r.batch;
    if (!b || !parts) return;
    const row = this.chains.indexOf(null);
    if (row < 0) return; // every row busy: it stays at rest
    const links = b.links;
    const joints = links + 2;
    const s = r.prop.scale;
    const rest = new Float32Array(joints);
    for (let k = 0; k < joints; k++) rest[k] = k <= links ? k * parts.linkH * s : r.height;
    const p = new Float32Array(joints * 3);
    const pp = r.prop.position;
    for (let k = 0; k < joints; k++) {
      p[k * 3] = pp.x;
      p[k * 3 + 1] = pp.y + rest[k];
      p[k * 3 + 2] = pp.z;
    }
    const ch: SimChain = { rec: r, joints, rest, p, q: p.slice(), prev: p.slice(), quiet: 0 };
    this.chains[row] = ch;
    this.active.push(ch);
    r.sim = row;
    b.row.setX(r.slot, row + 1);
    b.dirty = true;
  }

  /** Stops simulating a stalk: it goes back to the shader's rest pose. */
  private release(r: AlgaeRec): void {
    if (r.sim < 0) return;
    const ch = this.chains[r.sim]!;
    this.chains[r.sim] = null;
    const i = this.active.indexOf(ch);
    if (i >= 0) {
      this.active[i] = this.active[this.active.length - 1];
      this.active.pop();
    }
    simData.fill(0, r.sim * MAX_JOINTS * 4, (r.sim + 1) * MAX_JOINTS * 4);
    simTexture.needsUpdate = true;
    r.sim = -1;
    if (r.batch) {
      r.batch.row.setX(r.slot, 0);
      r.batch.dirty = true;
    }
  }

  /**
   * One Verlet step: inertia with water drag and buoyancy; then the link lengths, straightening and
   * the bodies (pushed out of their capsules and dragged along by their motion), a few times over.
   * `share` is this step's part of the frame (the bodies' frame motion is spread over the steps).
   */
  private step(ch: SimChain, h: number, share: number): void {
    const { p, q, rest, joints } = ch;
    const root = ch.rec.prop.position;
    const keep = Math.exp(-DRAG * h);
    const lift = BUOYANCY * h * h;
    for (let k = 1; k < joints; k++) {
      const i = k * 3;
      const vx = (p[i] - q[i]) * keep;
      const vy = (p[i + 1] - q[i + 1]) * keep;
      const vz = (p[i + 2] - q[i + 2]) * keep;
      q[i] = p[i];
      q[i + 1] = p[i + 1];
      q[i + 2] = p[i + 2];
      p[i] += vx;
      p[i + 1] += vy + lift;
      p[i + 2] += vz;
    }
    const nodeR = NODE_RADIUS * ch.rec.prop.scale;
    let touched = false;
    for (let it = 0; it < ITERATIONS; it++) {
      // Bending: joints two apart keep their straight distance, both ends sharing the fix
      // (symmetric, so it only ever takes energy out; the root stays pinned)
      for (let k = 2; k < joints; k++) {
        const a = (k - 2) * 3;
        const c = k * 3;
        const len = rest[k] - rest[k - 2];
        const dx = p[c] - p[a];
        const dy = p[c + 1] - p[a + 1];
        const dz = p[c + 2] - p[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        if (d >= len) continue;
        const fix = ((d - len) / d) * STIFFNESS;
        const wa = k === 2 ? 0 : 0.5;
        const wc = 1 - wa;
        p[a] += dx * fix * wa;
        p[a + 1] += dy * fix * wa;
        p[a + 2] += dz * fix * wa;
        p[c] -= dx * fix * wc;
        p[c + 1] -= dy * fix * wc;
        p[c + 2] -= dz * fix * wc;
      }
      // Bodies
      for (let n = 0; n < this.pusherCount; n++) {
        const o = n * 5;
        const px = this.pushers[o];
        const py0 = this.pushers[o + 1];
        const pz = this.pushers[o + 2];
        const R = this.pushers[o + 3] + nodeR;
        const py1 = py0 + this.pushers[o + 4];
        // The body's motion this step (none the first frame it appears)
        const moved = n < this.lastPusherCount;
        let mx = moved ? (px - this.lastPushers[o]) * share : 0;
        let my = moved ? (py0 - this.lastPushers[o + 1]) * share : 0;
        let mz = moved ? (pz - this.lastPushers[o + 2]) * share : 0;
        const ml = Math.sqrt(mx * mx + my * my + mz * mz);
        if (ml > MAX_DRAG_STEP) {
          mx = my = mz = 0;
        }
        for (let k = 1; k < joints; k++) {
          const i = k * 3;
          const cy = Math.min(Math.max(p[i + 1], py0), py1);
          let ux = p[i] - px;
          let uy = p[i + 1] - cy;
          let uz = p[i + 2] - pz;
          const d2 = ux * ux + uy * uy + uz * uz;
          if (d2 >= R * R) continue;
          touched = true;
          let d = Math.sqrt(d2);
          const depth = R - d;
          if (d < 1e-4) {
            // Dead centre: out the way the body is going, or any side
            ux = mx || 1;
            uy = 0;
            uz = mz;
            d = Math.hypot(ux, uz);
          }
          const push = depth * CONTACT_SOFTNESS;
          p[i] += (ux / d) * push;
          p[i + 1] += (uy / d) * push;
          p[i + 2] += (uz / d) * push;
          if (it === 0) {
            // The body soaks up the joint's own swing (no bounce), and the water around it drags
            // the fronds a bit of its way
            q[i] += (p[i] - q[i]) * CONTACT_DAMP;
            q[i + 1] += (p[i + 1] - q[i + 1]) * CONTACT_DAMP;
            q[i + 2] += (p[i + 2] - q[i + 2]) * CONTACT_DAMP;
            p[i] += mx * FRICTION;
            p[i + 1] += my * FRICTION;
            p[i + 2] += mz * FRICTION;
          }
        }
      }
      // Link lengths, root pinned (the joint above it takes the whole fix)
      p[0] = root.x;
      p[1] = root.y;
      p[2] = root.z;
      for (let k = 0; k < joints - 1; k++) {
        const a = k * 3;
        const b = a + 3;
        const len = rest[k + 1] - rest[k];
        const dx = p[b] - p[a];
        const dy = p[b + 1] - p[a + 1];
        const dz = p[b + 2] - p[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const diff = (d - len) / d;
        const wa = k === 0 ? 0 : 0.5;
        const wb = 1 - wa;
        p[a] += dx * diff * wa;
        p[a + 1] += dy * diff * wa;
        p[a + 2] += dz * diff * wa;
        p[b] -= dx * diff * wb;
        p[b + 1] -= dy * diff * wb;
        p[b + 2] -= dz * diff * wb;
      }
      // Never through the seabed
      for (let k = 1; k < joints; k++) p[k * 3 + 1] = Math.max(p[k * 3 + 1], root.y + 0.03);
    }
    if (touched) ch.quiet = 0;
  }

  /** Back upright and barely moving. */
  private atRest(ch: SimChain): boolean {
    const { p, q, rest, joints } = ch;
    const root = ch.rec.prop.position;
    for (let k = 1; k < joints; k++) {
      const i = k * 3;
      // Sideways only: buoyancy keeps the links a little stretched (the drawn chain is not)
      const ox = p[i] - root.x;
      const oz = p[i + 2] - root.z;
      if (ox * ox + oz * oz > 0.005 * 0.005) return false;
      const vx = p[i] - q[i];
      const vy = p[i + 1] - q[i + 1];
      const vz = p[i + 2] - q[i + 2];
      if (vx * vx + vy * vy + vz * vz > 0.0006 * 0.0006) return false;
    }
    return true;
  }

  /**
   * Writes a chain's joint offsets (from its straight rest pose) into its texture row: blended
   * `alpha` of the way from the previous step to the last, then laid out from the root along those
   * directions at the exact link lengths. So the drawn stalk never shows the buoyancy stretch and
   * meets the shader's rest pose exactly when it goes back to sleep.
   */
  private upload(ch: SimChain, alpha: number): void {
    const { p, prev, rest, joints } = ch;
    const root = ch.rec.prop.position;
    const base = ch.rec.sim * MAX_JOINTS * 4;
    simData[base] = simData[base + 1] = simData[base + 2] = 0;
    let ax = root.x;
    let ay = root.y;
    let az = root.z;
    let lx = root.x;
    let ly = root.y;
    let lz = root.z;
    for (let k = 1; k < joints; k++) {
      const i = k * 3;
      const bx = prev[i] + (p[i] - prev[i]) * alpha;
      const by = prev[i + 1] + (p[i + 1] - prev[i + 1]) * alpha;
      const bz = prev[i + 2] + (p[i + 2] - prev[i + 2]) * alpha;
      const dx = bx - lx;
      const dy = by - ly;
      const dz = bz - lz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const len = rest[k] - rest[k - 1];
      ax += (dx / d) * len;
      ay += (dy / d) * len;
      az += (dz / d) * len;
      lx = bx;
      ly = by;
      lz = bz;
      const o = base + k * 4;
      simData[o] = ax - root.x;
      simData[o + 1] = ay - root.y - rest[k];
      simData[o + 2] = az - root.z;
    }
  }

  private attach(r: AlgaeRec): void {
    const links = clampLinks(r.prop.length);
    const geometry = algaeGeometry(links);
    if (!geometry) return; // the model is still loading: attached once it arrives
    r.height = geometry.boundingBox!.max.y * r.prop.scale;
    const cx = Math.floor(r.prop.position.x / CELL);
    const cz = Math.floor(r.prop.position.z / CELL);
    const key = `${links}|${cx}|${cz}`;
    let b = this.batches.get(key);
    if (!b) {
      b = this.makeBatch(geometry, links, cx, cz, 16);
      this.batches.set(key, b);
    }
    if (b.recs.length >= b.mesh.instanceMatrix.count) this.grow(b);
    r.batch = b;
    r.slot = b.recs.length;
    b.recs.push(r);
    b.mesh.count = b.recs.length;
    b.row.setX(r.slot, r.sim + 1);
    b.dirty = true;
    this.writeColors(r);
    this.writeMatrix(r);
  }

  private detach(r: AlgaeRec): void {
    const b = r.batch;
    if (!b) return;
    const last = b.recs.length - 1;
    if (r.slot !== last) {
      const moved = b.recs[last];
      b.recs[r.slot] = moved;
      moved.slot = r.slot;
      b.mesh.getMatrixAt(last, AlgaeField._m);
      b.mesh.setMatrixAt(r.slot, AlgaeField._m);
      b.row.setX(r.slot, moved.sim + 1);
      b.cols.array.copyWithin(r.slot * 8, last * 8, last * 8 + 8);
      b.cols.needsUpdate = true;
      b.dirty = true;
    }
    b.recs.pop();
    b.mesh.count = b.recs.length;
    b.mesh.instanceMatrix.needsUpdate = true;
    r.batch = null;
    r.slot = -1;
  }

  private static readonly _c = new THREE.Color();

  /** Writes a stalk's own colours (sRGB hex in the prop, linear on the GPU), or the "use the panel's" flag. */
  private writeColors(r: AlgaeRec): void {
    const b = r.batch!;
    const a = b.cols.array as Float32Array;
    const o = r.slot * 8;
    const own = r.prop.colors;
    if (own) {
      AlgaeField._c.setHex(own[0]).toArray(a, o);
      a[o + 3] = 1;
      AlgaeField._c.setHex(own[1]).toArray(a, o + 4);
      a[o + 7] = 1;
    } else {
      a.fill(0, o, o + 8);
    }
    b.cols.needsUpdate = true;
  }

  private makeColorBuffer(geometry: THREE.BufferGeometry, cap: number, from?: THREE.InstancedInterleavedBuffer): THREE.InstancedInterleavedBuffer {
    const cols = new THREE.InstancedInterleavedBuffer(new Float32Array(cap * 8), 8);
    cols.setUsage(THREE.DynamicDrawUsage);
    if (from) (cols.array as Float32Array).set(from.array as Float32Array);
    geometry.setAttribute('aAlgBaseC', new THREE.InterleavedBufferAttribute(cols, 4, 0));
    geometry.setAttribute('aAlgTipC', new THREE.InterleavedBufferAttribute(cols, 4, 4));
    return cols;
  }

  private makeRowAttribute(cap: number): THREE.InstancedBufferAttribute {
    const row = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    row.setUsage(THREE.DynamicDrawUsage);
    return row;
  }

  private makeBatch(geometry: THREE.BufferGeometry, links: number, cx: number, cz: number, cap: number): AlgaeBatch {
    const mesh = new THREE.InstancedMesh(geometry, [ALGAE_MATERIAL], cap);
    mesh.count = 0;
    mesh.name = `Algae_${links}_${cx}_${cz}`;
    const row = this.makeRowAttribute(cap);
    // Every cell of this length shares the stalk's buffers; only the row buffer is the mesh's own
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(geometry.attributes)) g.setAttribute(name, geometry.getAttribute(name));
    g.setIndex(geometry.index);
    for (const gr of geometry.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    g.boundingBox = geometry.boundingBox!.clone();
    g.boundingSphere = geometry.boundingSphere!.clone();
    g.setAttribute('aAlgRow', row);
    const cols = this.makeColorBuffer(g, cap);
    mesh.geometry = g;
    this.group.add(mesh);
    return { links, cx, cz, mesh, row, cols, recs: [], dirty: false, minY: Infinity, maxY: -Infinity };
  }

  private grow(b: AlgaeBatch): void {
    const old = b.mesh;
    const cap = old.instanceMatrix.count * 2;
    const mesh = new THREE.InstancedMesh(old.geometry, old.material, cap);
    mesh.name = old.name;
    mesh.visible = old.visible;
    for (let i = 0; i < old.count; i++) {
      old.getMatrixAt(i, AlgaeField._m);
      mesh.setMatrixAt(i, AlgaeField._m);
    }
    mesh.count = old.count;
    const row = this.makeRowAttribute(cap);
    (row.array as Float32Array).set(b.row.array as Float32Array);
    mesh.geometry.setAttribute('aAlgRow', row);
    b.cols = this.makeColorBuffer(mesh.geometry, cap, b.cols);
    mesh.boundingSphere = old.boundingSphere;
    this.group.remove(old);
    old.dispose();
    this.group.add(mesh);
    b.mesh = mesh;
    b.row = row;
  }

  private writeMatrix(r: AlgaeRec): void {
    const b = r.batch;
    if (!b) return;
    const p = r.prop;
    AlgaeField._q.setFromAxisAngle(AlgaeField._up, p.rotationY);
    AlgaeField._s.setScalar(p.scale);
    AlgaeField._m.compose(p.position, AlgaeField._q, AlgaeField._s);
    b.mesh.setMatrixAt(r.slot, AlgaeField._m);
    b.mesh.instanceMatrix.needsUpdate = true;
    r.height = (b.mesh.geometry.boundingBox?.max.y ?? 1) * p.scale;
    // Cell bounds for culling and picking: the cell, the stalks' heights and how far they lean
    b.minY = Math.min(b.minY, p.position.y);
    b.maxY = Math.max(b.maxY, p.position.y + r.height);
    const midY = (b.minY + b.maxY) / 2;
    const half = (b.maxY - b.minY) / 2;
    let lean = 0;
    for (const o of b.recs) lean = Math.max(lean, o.height);
    b.mesh.boundingSphere = new THREE.Sphere(
      new THREE.Vector3((b.cx + 0.5) * CELL, midY, (b.cz + 0.5) * CELL),
      Math.hypot(CELL * 0.7072 + lean, half)
    );
  }
}
