import * as THREE from 'three';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { TerrainSystem } from './TerrainSystem';
import type { PropInstance } from './PropSystem';
import { isMobileDevice } from './WorldSettings';
import { audioEngine } from '../audio/AudioEngine';

/**
 * Spider webs (for the caves, where the spiders live): a graph of threads (radials from a hub to
 * the anchors, a spiral across them) simulated with Verlet + string constraints (they pull, never
 * push). The player sticks to the threads they touch and stretches the web; its pull along the
 * web's normal holds them back (CharacterController.restraint). The axe cuts the threads its slash
 * plane crosses; pieces no longer tied to an anchor fall and fade. Webs sleep while nothing
 * touches them.
 *
 * Drawing: every web's nodes live in one float texture (a few rows per web) and every thread of
 * every web is one quad of a single mesh: one draw call, and a moving web uploads only its rows.
 */

// ------------------------------------------------------------------ params

/** One web's shape (saved with the prop). Sizes in metres at scale 1. */
export interface WebParams {
  /** Frame width / height (the web fills it). */
  w: number;
  h: number;
  /** Threads from the hub to the walls. */
  radials: number;
  /** Turns of the spiral. */
  rings: number;
  /** How hard the web holds and how much it stretches before the spiral snaps (1 = normal). */
  strength: number;
}

export const WEB_DEFAULTS: Readonly<WebParams> = { w: 2.2, h: 2.4, radials: 14, rings: 10, strength: 1 };
export const WEB_LIMITS = {
  w: [0.8, 6],
  h: [0.8, 5],
  radials: [6, 28],
  rings: [3, 20],
  strength: [0.2, 3],
} as const;

export function clampWeb(p?: Partial<WebParams> | null): WebParams {
  const num = (k: keyof typeof WEB_LIMITS, round = false) => {
    const v = p?.[k];
    const n = typeof v === 'number' && Number.isFinite(v) ? v : WEB_DEFAULTS[k];
    const c = THREE.MathUtils.clamp(n, WEB_LIMITS[k][0], WEB_LIMITS[k][1]);
    return round ? Math.round(c) : c;
  };
  return {
    w: num('w'),
    h: num('h'),
    radials: num('radials', true),
    rings: num('rings', true),
    strength: num('strength'),
  };
}

/** A web's orientation: yaw, then the tilts about its own right (x) and normal (z) axes. */
export function webQuaternion(rotationY: number, tilt: readonly [number, number] | undefined, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromEuler(webEuler.set(tilt?.[0] ?? 0, rotationY, tilt?.[1] ?? 0, 'YXZ'));
}
const webEuler = new THREE.Euler();

// ------------------------------------------------------------------ look & feel (developer panel)

export interface WebSettings {
  /** Thread colour (sRGB hex). */
  color: number;
  opacity: number;
  /** Thread thickness (mm); far threads stay at least a pixel wide and fade instead. */
  thickness: number;
  /** Pull (a tenth of the summed strain along the normal) at which the player can push no further. */
  hold: number;
  /** Stretch (length / rest) at which a spiral thread snaps; radials take 1.8× more. */
  breakStretch: number;
  /** Gravity on the threads (m/s²): how much slack ones sag. */
  gravity: number;
  /** Threads are drawn up to this far from the camera (m), fading out over the last few metres. */
  viewDistance: number;
}

export const WEB_SETTINGS_DEFAULTS: Readonly<WebSettings> = {
  color: 0xe9eef2,
  opacity: 0.8,
  thickness: 6,
  hold: 0.55,
  breakStretch: 1.9,
  gravity: 1.5,
  viewDistance: isMobileDevice() ? 30 : 45,
};

const STORAGE_KEY = 'farm.webSettings.v1';

function loadSettings(): WebSettings {
  const out: WebSettings = { ...WEB_SETTINGS_DEFAULTS };
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      const saved = JSON.parse(raw) as Partial<WebSettings>;
      for (const k of Object.keys(WEB_SETTINGS_DEFAULTS) as (keyof WebSettings)[]) {
        if (typeof saved[k] === 'number' && Number.isFinite(saved[k])) out[k] = saved[k]!;
      }
    }
  } catch { /* private mode / bad JSON: defaults */ }
  return out;
}

export const webSettings: WebSettings = loadSettings();

export function setWebSetting<K extends keyof WebSettings>(key: K, value: WebSettings[K]): void {
  webSettings[key] = value;
  applySettings();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(webSettings));
  } catch { /* not kept */ }
}

export function resetWebSettings(): void {
  Object.assign(webSettings, WEB_SETTINGS_DEFAULTS);
  applySettings();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* nothing kept */ }
}

// ------------------------------------------------------------------ simulation constants

const SUBSTEP = 1 / 60;
const MAX_SUBSTEPS = 3;
/** Constraint iterations per substep while the player is caught / while the web only settles. */
const ITERATIONS = 6;
const ITERATIONS_IDLE = 3;
/** Rest length / built length: the threads are under a little tension at rest. */
const PRETENSION_RADIAL = 0.97;
const PRETENSION_SPIRAL = 0.985;
/** Longest segment (m): threads are split so the capsule can't slip between two nodes. */
const SEGMENT = 0.2;
/** Player capsule: half the straight part, radius (+ a thread's grab margin). */
const CAPSULE_HALF = 0.45;
const CAPSULE_R = 0.3 + 0.04;
/** Backed out this far (m, capsule centre from the web plane, entry side): the web lets go. */
const RELEASE_DIST = 0.48;
/** Pull back (m/s per unit of pull past `hold`): the stretched web shoves the player out. */
const PULLBACK = 9;
/** Raw pull → the units of `hold` (a player sunk ~0.5 m into a default web pulls about 0.5). */
const PULL_SCALE = 0.1;
/** Share of the speed lost backing out of a web that still clings. */
const CLING = 0.35;
const MAX_PULLBACK = 3;
/** A player jump of more than this per frame (respawn, teleport) tears free of every web. */
const TELEPORT = 1.2;
/** Settled for this long with nothing touching: the web stops being simulated. */
const SLEEP_AFTER = 0.8;
/** Cut threads fade over this long (s) once nothing ties them to an anchor. */
const FADE_TIME = 1.6;
/**
 * Less than this share of the threads still whole, or the hub cut loose with less than
 * TORN_SHARE_NO_HUB left (only stubs on the frame): the web counts as torn down…
 */
const TORN_SHARE = 0.2;
const TORN_SHARE_NO_HUB = 0.4;
/** …and after this long (s) its last threads fade away (it's back after a reload). */
const TORN_REMOVE_AFTER = 10;
/** Half the axe's slash (m along the blade line) and its reach in front of the player. */
const SLASH_HALF = 1.0;
export const WEB_REACH = 1.8;

/** A thread sticks this far (m) off a body part's surface. */
const BODY_MARGIN = 0.03;
/** Body parts tracked at most (the rig has 6). */
const MAX_PARTS = 8;
/** `stuck` value of a node held by the capsule (no rig yet); 2 + k = held by body part k. */
const STUCK_CAPSULE = 1;

/** Grid cells (m) the webs are filed in by their centre; queries pad by the largest web. */
const CELL = 16;
const MAX_BOUND = 14;
/** Node texture width (texels); a web takes whole rows. */
const TEX_W = 512;

/** A rigid part of the player's body: a bone and the box (in its space) of what it carries. */
export interface WebBodyPart {
  bone: THREE.Object3D;
  min: THREE.Vector3;
  max: THREE.Vector3;
}

/** The player's body for the webs to stick to. */
export interface WebBody {
  /** Its parts, or null while the model loads (the capsule stands in). */
  parts(): WebBodyPart[] | null;
  /** Brings the bones' world matrices up to this frame's pose. */
  pose(): void;
}

const K_RADIAL = 0;
const K_SPIRAL = 1;

// ------------------------------------------------------------------ material

const uColor = { value: new THREE.Color() };
const uOpacity = { value: 1 };
const uWidth = { value: 0.0025 };
const uPixel = { value: 0.001 };
const uLight = { value: 1 };
const uView = { value: 45 };
const uNodes: { value: THREE.Texture | null } = { value: null };

function applySettings(): void {
  uColor.value.setHex(webSettings.color);
  uOpacity.value = webSettings.opacity;
  uWidth.value = webSettings.thickness / 1000;
  uView.value = webSettings.viewDistance;
}
applySettings();

/** Daylight on the threads (1 day, low at night / in caves). */
export function setWebLight(light: number): void {
  uLight.value = 0.25 + 0.75 * THREE.MathUtils.clamp(light, 0, 1);
}

let material: THREE.ShaderMaterial | null = null;

/**
 * Camera-facing ribbons, one quad per thread: each vertex names its own end and the other one
 * (texels of the node texture); the vertex shader fetches both, turns the ribbon to the camera,
 * keeps it a pixel wide when far and fades it out at the view distance.
 */
function webMaterial(): THREE.ShaderMaterial {
  if (material) return material;
  material = new THREE.ShaderMaterial({
    defines: { TEX_W },
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uColor, uOpacity, uWidth, uPixel, uLight, uView, uNodes,
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      uniform highp sampler2D uNodes;
      attribute vec2 aNodes;
      attribute float aSide;
      attribute float aAlpha;
      uniform float uWidth;
      uniform float uPixel;
      uniform float uView;
      varying float vAlpha;
      vec3 node(float i) {
        int k = int(i + 0.5);
        return texelFetch(uNodes, ivec2(k % TEX_W, k / TEX_W), 0).xyz;
      }
      void main() {
        vec3 a = node(aNodes.x);
        float vis = aAlpha * clamp((uView - distance(a, cameraPosition)) * 0.25, 0.0, 1.0);
        if (vis < 0.004) {
          // Gone, cut or out of range: off screen
          vAlpha = 0.0;
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        vec3 b = node(aNodes.y);
        vec4 mvA = viewMatrix * vec4(a, 1.0);
        vec4 mvB = viewMatrix * vec4(b, 1.0);
        vec3 dir = mvB.xyz - mvA.xyz;
        vec3 side = cross(dir, mvA.xyz);
        float sl = length(side);
        side = sl > 1e-8 ? side / sl : vec3(1.0, 0.0, 0.0);
        float pix = -mvA.z * uPixel * 2.0;
        float w = max(uWidth, pix);
        vAlpha = vis * clamp(uWidth / w, 0.25, 1.0);
        vec4 mvPosition = vec4(mvA.xyz + side * (w * 0.5 * aSide), 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uLight;
      varying float vAlpha;
      void main() {
        if (vAlpha < 0.01) discard;
        gl_FragColor = vec4(uColor * uLight, vAlpha * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return material;
}


// ------------------------------------------------------------------ topology

/** Built web in the prop's local frame (x right, y up from the base, z along the normal). */
interface Topology {
  /** x, y, z per node. */
  nodes: number[];
  pinned: boolean[];
  /** a, b per link. */
  links: number[];
  kinds: number[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type AnchorFn = (hx: number, hy: number, dx: number, dy: number, dist: number, r: number) => [number, number, number] | null;

/**
 * `anchor(hx, hy, dx, dy, dist, r)`: where radial `r` leaving the hub along (dx, dy) ends, given
 * the frame edge `dist` away (local point, or null for the frame edge itself).
 */
function buildTopology(p: WebParams, scale: number, seed: number, anchor?: AnchorFn): Topology {
  const rnd = mulberry32(seed * 9973 + 17);
  const jit = (a: number) => (rnd() * 2 - 1) * a;
  const w = p.w * scale, h = p.h * scale;
  const xmin = -w / 2, xmax = w / 2;
  const ymin = 0.03, ymax = h;
  const nodes: number[] = [];
  const pinned: boolean[] = [];
  const links: number[] = [];
  const kinds: number[] = [];
  const node = (x: number, y: number, z: number, pin = false) => {
    nodes.push(x, y, z);
    pinned.push(pin);
    return pinned.length - 1;
  };
  /** Links a to b, split into segments no longer than SEGMENT. */
  const thread = (a: number, b: number, kind: number) => {
    const ax = nodes[a * 3], ay = nodes[a * 3 + 1], az = nodes[a * 3 + 2];
    const bx = nodes[b * 3], by = nodes[b * 3 + 1], bz = nodes[b * 3 + 2];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / SEGMENT));
    let prev = a;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const mid = node(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
      links.push(prev, mid);
      kinds.push(kind);
      prev = mid;
    }
    links.push(prev, b);
    kinds.push(kind);
  };

  const hx = jit(w * 0.05), hy = h * (0.55 + jit(0.04));
  const hub = node(hx, hy, 0);
  const R = p.radials, K = p.rings;
  const ring: number[][] = [];
  for (let r = 0; r < R; r++) {
    const th = ((r + jit(0.28)) / R) * Math.PI * 2;
    const dx = Math.cos(th), dy = Math.sin(th);
    let dist = Infinity;
    if (dx > 1e-6) dist = Math.min(dist, (xmax - hx) / dx);
    if (dx < -1e-6) dist = Math.min(dist, (xmin - hx) / dx);
    if (dy > 1e-6) dist = Math.min(dist, (ymax - hy) / dy);
    if (dy < -1e-6) dist = Math.min(dist, (ymin - hy) / dy);
    const hit = anchor?.(hx, hy, dx, dy, dist, r) ?? null;
    const ax = hit ? hit[0] : hx + dx * dist;
    const ay = hit ? hit[1] : hy + dy * dist;
    const az = hit ? hit[2] : 0;
    const a = node(ax, ay, az, true);
    const list: number[] = [];
    let prev = hub;
    for (let k = 0; k < K; k++) {
      const f = (K === 1 ? 0.5 : 0.1 + (0.8 * k) / (K - 1)) * (1 + jit(0.03));
      const n = node(hx + (ax - hx) * f, hy + (ay - hy) * f, az * f);
      thread(prev, n, K_RADIAL);
      list.push(n);
      prev = n;
    }
    thread(prev, a, K_RADIAL);
    ring.push(list);
  }
  for (let k = 0; k < K; k++) {
    for (let r = 0; r < R; r++) thread(ring[r][k], ring[(r + 1) % R][k], K_SPIRAL);
  }
  return { nodes, pinned, links, kinds };
}

/** Seeded by where a web stands (ids change between sessions), so a reload rebuilds the same web. */
function webSeed(x: number, z: number): number {
  return (Math.round(x * 10) * 73856093) ^ (Math.round(z * 10) * 19349663);
}

const previewCache = new Map<string, THREE.BufferGeometry>();

/** Flat ribbons for the editor's placement ghost (the prop's scale is applied by the ghost). */
export function webPreviewGeometry(params: WebParams): THREE.BufferGeometry {
  const key = JSON.stringify(params);
  const hit = previewCache.get(key);
  if (hit) return hit;
  const topo = buildTopology(params, 1, 1);
  const pos: number[] = [];
  const idx: number[] = [];
  const half = 0.008;
  for (let c = 0; c < topo.kinds.length; c++) {
    const a = topo.links[c * 2] * 3, b = topo.links[c * 2 + 1] * 3;
    const ax = topo.nodes[a], ay = topo.nodes[a + 1], bx = topo.nodes[b], by = topo.nodes[b + 1];
    let nx = -(by - ay), ny = bx - ax;
    const l = Math.hypot(nx, ny) || 1;
    nx = (nx / l) * half;
    ny = (ny / l) * half;
    const base = pos.length / 3;
    pos.push(ax - nx, ay - ny, 0, ax + nx, ay + ny, 0, bx - nx, by - ny, 0, bx + nx, by + ny, 0);
    idx.push(base, base + 1, base + 3, base, base + 3, base + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  previewCache.set(key, geo);
  return geo;
}

// ------------------------------------------------------------------ one web

class Web {
  params: WebParams;
  readonly origin = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly right = new THREE.Vector3();
  readonly up = new THREE.Vector3();
  readonly normal = new THREE.Vector3();
  readonly center = new THREE.Vector3();
  boundRadius = 1;
  /** Grid cell it's filed in (NaN: not filed). */
  cell = NaN;

  n = 0;
  pos = new Float32Array(0);
  prev = new Float32Array(0);
  inv = new Float32Array(0);
  stuck = new Uint8Array(0);
  off = new Float32Array(0);
  loose = new Uint8Array(0);
  /** Floor under each node, found once when it comes loose. */
  ground = new Float32Array(0);
  m = 0;
  la = new Int32Array(0);
  lb = new Int32Array(0);
  rest = new Float32Array(0);
  kind = new Uint8Array(0);
  alive = new Uint8Array(0);
  fade = new Float32Array(0);
  /** Links of each node (CSR) for the connectivity pass after a cut, and its reused scratch. */
  adjStart = new Int32Array(0);
  adj = new Int32Array(0);
  seen = new Uint8Array(0);
  queue = new Int32Array(0);

  /** Where it sits in the shared buffers: first texture row and first link (-1: not laid out). */
  row = -1;
  link = -1;

  awake = true;
  calm = 0;
  acc = 0;
  stuckCount = 0;
  entrySide = 0;
  fading = 0;
  /** Pull on the player along the normal (signed, already × strength). */
  pullN = 0;
  topoDirty = false;
  nodesDirty = true;
  alphaDirty = true;
  /** Frameless web whose rays found nothing yet (the cave colliders still building): tried again. */
  needsAnchor = false;
  anchorRetry = 0;
  /** Seconds since the web was torn down (-1: still standing). */
  tornFor = -1;
  /** Its last threads are fading out; once gone the simulation is dropped. */
  dying = false;
  gone = false;

  constructor(public prop: PropInstance) {
    this.params = clampWeb(prop.web);
  }
}

// ------------------------------------------------------------------ the field

/** Every web in the world (props with a `web` def live here instead of the instanced batches). */
export class WebField {
  private readonly webs = new Map<number, Web>();
  private readonly grid = new Map<number, Set<Web>>();
  /** Webs that need a look every frame: awake, torn (timer running), waiting for anchors. */
  private readonly active = new Set<Web>();
  /** Webs holding the player. */
  private readonly holding = new Set<Web>();
  private readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private texture: THREE.DataTexture | null = null;
  private alphaAttr: THREE.BufferAttribute | null = null;
  private layoutDirty = false;
  /** Frame the node texture was rewritten whole (row ranges would upload only part of it). */
  private fullUploadFrame = -1;

  private player: THREE.Vector3 | null = null;
  private readonly playerPos = new THREE.Vector3();
  private readonly lastPlayer = new THREE.Vector3();
  private hasLastPlayer = false;
  private slashTilt = 1;
  private viewportHeight = 1080;
  private snapIn = 0;
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly target = { position: new THREE.Vector3(), radius: 0 };
  private readonly scratch: Web[] = [];
  /** A frameless web found (and stored in its prop) where its threads anchor: the save changed. */
  public onAnchors: (() => void) | null = null;
  private body: WebBody | null = null;
  /** Posed body parts this frame: world matrices, their inverses, boxes and margins (part space). */
  private partCount = 0;
  private posedFrame = -1;
  private frameNo = 0;
  private readonly partM = new Float32Array(16 * MAX_PARTS);
  private readonly partInv = new Float32Array(16 * MAX_PARTS);
  private readonly partBox = new Float32Array(6 * MAX_PARTS);
  private readonly partMargin = new Float32Array(MAX_PARTS);
  private readonly m4 = new THREE.Matrix4();
  /** Whether every collider a web could anchor to exists yet (wired to the cave network's build). */
  public collidersReady: () => boolean = () => true;

  constructor(parent: THREE.Object3D, private readonly physics: PhysicsWorld, private readonly terrain: TerrainSystem) {
    this.group.name = 'SpiderWebs';
    parent.add(this.group);
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), webMaterial());
    this.mesh.name = 'SpiderWebThreads';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.group.add(this.mesh);
  }

  // ---------------------------------------------------------------- props

  public add(prop: PropInstance): void {
    this.remove(prop.id);
    const web = new Web(prop);
    this.webs.set(prop.id, web);
    this.build(web);
  }

  public remove(id: number): void {
    const web = this.webs.get(id);
    if (!web) return;
    this.teardown(web);
    this.webs.delete(id);
    this.layoutDirty = true;
  }

  /** The prop moved or its params changed: rebuilt whole (cuts are healed). */
  public refresh(prop: PropInstance): void {
    const web = this.webs.get(prop.id);
    if (!web) return this.add(prop);
    web.prop = prop;
    web.params = clampWeb(prop.web);
    this.teardown(web);
    this.build(web);
  }

  public get count(): number {
    return this.webs.size;
  }

  public setViewportHeight(px: number): void {
    this.viewportHeight = Math.max(1, px);
  }

  private teardown(web: Web): void {
    if (!Number.isNaN(web.cell)) {
      this.grid.get(web.cell)?.delete(web);
      web.cell = NaN;
    }
    this.active.delete(web);
    this.holding.delete(web);
    web.row = web.link = -1;
    this.layoutDirty = true;
  }

  private wake(web: Web): void {
    web.awake = true;
    web.calm = 0;
    this.active.add(web);
  }

  /** A torn-down web's threads are gone: frees the simulation (back after a reload). */
  private dropThreads(web: Web): void {
    this.release(web);
    web.gone = true;
    web.awake = false;
    web.n = web.m = 0;
    web.pos = web.prev = web.inv = web.off = web.ground = new Float32Array(0);
    web.stuck = web.loose = web.kind = web.alive = web.seen = new Uint8Array(0);
    web.la = web.lb = web.adjStart = web.adj = web.queue = new Int32Array(0);
    web.rest = web.fade = new Float32Array(0);
    this.active.delete(web);
    this.layoutDirty = true;
  }

  // ---------------------------------------------------------------- grid

  private cellKey(x: number, z: number): number {
    return (Math.floor(x / CELL) + 32768) * 65536 + (Math.floor(z / CELL) + 32768);
  }

  /** Webs whose centre may lie within `r` (+ the largest web) of (x, z), into `this.scratch`. */
  private near(x: number, z: number, r: number): Web[] {
    const out = this.scratch;
    out.length = 0;
    const reach = r + MAX_BOUND;
    const x0 = Math.floor((x - reach) / CELL), x1 = Math.floor((x + reach) / CELL);
    const z0 = Math.floor((z - reach) / CELL), z1 = Math.floor((z + reach) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const set = this.grid.get((cx + 32768) * 65536 + (cz + 32768));
        if (set) for (const w of set) out.push(w);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- build

  /** Local frame of a web standing at `origin` turned by `quat`. */
  private static axes(quat: THREE.Quaternion, right: THREE.Vector3, up: THREE.Vector3, normal: THREE.Vector3): void {
    right.set(1, 0, 0).applyQuaternion(quat);
    up.set(0, 1, 0).applyQuaternion(quat);
    normal.set(0, 0, 1).applyQuaternion(quat);
  }

  /**
   * Rays from the hub along each radial (in the web's plane) to whatever collider they meet, up
   * to 1.8× the frame edge. `found` gets every radial's end (hit or frame edge) in local space.
   */
  private anchorRays(origin: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, found: number[], hits: { n: number }): AnchorFn {
    const o = this.v1, d = this.v2;
    return (hx, hy, dx, dy, dist) => {
      o.copy(origin).addScaledVector(right, hx).addScaledVector(up, hy);
      d.copy(right).multiplyScalar(dx).addScaledVector(up, dy).normalize();
      const hit = this.physics.castRay(o, d, dist * 1.8);
      const t = hit && hit.timeOfImpact >= 0.15 ? hit.timeOfImpact - 0.01 : -1;
      if (t > 0) hits.n++;
      const a: [number, number, number] = t > 0 ? [hx + dx * t, hy + dy * t, 0] : [hx + dx * dist, hy + dy * dist, 0];
      found.push(+a[0].toFixed(3), +a[1].toFixed(3), 0);
      return t > 0 ? a : null;
    };
  }

  /**
   * Editor preview: the radials (hub → where each would anchor) of a frameless web placed at
   * `origin`, as line-segment end points in world space (6 numbers per radial).
   */
  public previewAnchors(origin: THREE.Vector3, rotationY: number, tilt: [number, number] | undefined, params: WebParams, scale: number): number[] {
    if (!this.physics.isInitialized()) return [];
    const q = webQuaternion(rotationY, tilt, new THREE.Quaternion());
    const right = new THREE.Vector3(), up = new THREE.Vector3(), normal = new THREE.Vector3();
    WebField.axes(q, right, up, normal);
    const found: number[] = [];
    const topo = buildTopology(params, scale, webSeed(origin.x, origin.z), this.anchorRays(origin, right, up, found, { n: 0 }));
    const out: number[] = [];
    const world = (x: number, y: number, z: number) => {
      const p = this.v3.copy(origin).addScaledVector(right, x).addScaledVector(up, y).addScaledVector(normal, z);
      out.push(p.x, p.y, p.z);
    };
    for (let i = 0; i < topo.pinned.length; i++) {
      if (!topo.pinned[i]) continue;
      world(topo.nodes[0], topo.nodes[1], topo.nodes[2]);
      world(topo.nodes[i * 3], topo.nodes[i * 3 + 1], topo.nodes[i * 3 + 2]);
    }
    return out;
  }

  private build(web: Web): void {
    const { prop, params } = web;
    const s = prop.scale;
    web.origin.copy(prop.position);
    webQuaternion(prop.rotationY, prop.tilt, web.quat);
    WebField.axes(web.quat, web.right, web.up, web.normal);
    const W = params.w * s, H = params.h * s;
    web.center.copy(web.origin).addScaledVector(web.up, H / 2);
    web.boundRadius = Math.hypot(W, H) / 2 + 0.3;

    // Each radial runs on until it meets a collider (a cave wall), up to 1.8× the web's rectangle.
    // Where they landed is saved with the prop: on a reload the cave colliders aren't built yet
    let anchorFn: AnchorFn | undefined;
    web.needsAnchor = false;
    const saved = prop.webAnchors?.length === params.radials * 3 ? prop.webAnchors : null;
    const found: number[] = [];
    const hits = { n: 0 };
    if (saved) {
      anchorFn = (_hx, _hy, _dx, _dy, _dist, r) => [saved[r * 3], saved[r * 3 + 1], saved[r * 3 + 2]];
    } else if (this.physics.isInitialized() && this.collidersReady()) {
      anchorFn = this.anchorRays(web.origin, web.right, web.up, found, hits);
    }
    const topo = buildTopology(params, s, webSeed(prop.position.x, prop.position.z), anchorFn);
    if (!saved) {
      if (hits.n > 0) {
        prop.webAnchors = found;
        this.onAnchors?.();
      } else {
        web.needsAnchor = true;
        web.anchorRetry = 1;
      }
    }

    const n = topo.pinned.length, m = topo.kinds.length;
    web.n = n;
    web.m = m;
    web.pos = new Float32Array(n * 3);
    web.prev = new Float32Array(n * 3);
    web.inv = new Float32Array(n);
    web.stuck = new Uint8Array(n);
    web.off = new Float32Array(n * 3);
    web.loose = new Uint8Array(n);
    web.ground = new Float32Array(n);
    web.seen = new Uint8Array(n);
    web.queue = new Int32Array(n);
    const { right, up, normal, origin } = web;
    for (let i = 0; i < n; i++) {
      const x = topo.nodes[i * 3], y = topo.nodes[i * 3 + 1], z = topo.nodes[i * 3 + 2];
      const o = i * 3;
      web.pos[o] = origin.x + right.x * x + up.x * y + normal.x * z;
      web.pos[o + 1] = origin.y + right.y * x + up.y * y + normal.y * z;
      web.pos[o + 2] = origin.z + right.z * x + up.z * y + normal.z * z;
      web.inv[i] = topo.pinned[i] ? 0 : 1;
    }
    web.prev.set(web.pos);
    web.la = new Int32Array(m);
    web.lb = new Int32Array(m);
    web.rest = new Float32Array(m);
    web.kind = new Uint8Array(m);
    web.alive = new Uint8Array(m).fill(1);
    web.fade = new Float32Array(m).fill(1);
    const degree = new Int32Array(n + 1);
    for (let c = 0; c < m; c++) {
      const a = topo.links[c * 2], b = topo.links[c * 2 + 1];
      web.la[c] = a;
      web.lb[c] = b;
      web.kind[c] = topo.kinds[c];
      const d = Math.hypot(web.pos[b * 3] - web.pos[a * 3], web.pos[b * 3 + 1] - web.pos[a * 3 + 1], web.pos[b * 3 + 2] - web.pos[a * 3 + 2]);
      web.rest[c] = d * (topo.kinds[c] === K_SPIRAL ? PRETENSION_SPIRAL : PRETENSION_RADIAL);
      degree[a + 1]++;
      degree[b + 1]++;
    }
    for (let i = 0; i < n; i++) degree[i + 1] += degree[i];
    web.adjStart = degree;
    web.adj = new Int32Array(m * 2);
    const fill = degree.slice(0, n);
    for (let c = 0; c < m; c++) {
      web.adj[fill[web.la[c]]++] = c;
      web.adj[fill[web.lb[c]]++] = c;
    }
    web.stuckCount = 0;
    web.entrySide = 0;
    web.fading = 0;
    web.pullN = 0;
    web.nodesDirty = true;
    web.alphaDirty = true;
    web.tornFor = -1;
    web.dying = false;
    web.gone = false;


    web.cell = this.cellKey(web.center.x, web.center.z);
    let set = this.grid.get(web.cell);
    if (!set) this.grid.set(web.cell, (set = new Set()));
    set.add(web);
    this.layoutDirty = true;
    this.wake(web);
  }

  // ---------------------------------------------------------------- shared buffers

  /** Lays every web out in the node texture and the thread mesh (after webs come or go). */
  private rebuildLayout(): void {
    this.layoutDirty = false;
    let rows = 0, links = 0;
    for (const web of this.webs.values()) {
      if (web.gone || !web.n) {
        web.row = web.link = -1;
        continue;
      }
      web.row = rows;
      web.link = links;
      rows += Math.ceil(web.n / TEX_W);
      links += web.m;
    }

    // Node texture: grown to the next power of two in rows
    const height = Math.max(1, THREE.MathUtils.ceilPowerOfTwo(Math.max(1, rows)));
    if (!this.texture || this.texture.image.height !== height) {
      this.texture?.dispose();
      const tex = new THREE.DataTexture(new Float32Array(TEX_W * height * 4), TEX_W, height, THREE.RGBAFormat, THREE.FloatType);
      tex.minFilter = tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      this.texture = tex;
      uNodes.value = tex;
    }
    for (const web of this.webs.values()) if (web.row >= 0) this.writeNodes(web, false);
    this.texture.clearUpdateRanges();
    this.texture.needsUpdate = true;
    this.fullUploadFrame = this.frameNo;

    // Threads: 4 vertices per link (both ends twice), all webs in one mesh
    const nodes = new Float32Array(links * 8);
    const side = new Float32Array(links * 4);
    const alpha = new Float32Array(links * 4);
    const index = new Uint32Array(links * 6);
    for (const web of this.webs.values()) {
      if (web.link < 0) continue;
      const base = web.row * TEX_W;
      for (let c = 0; c < web.m; c++) {
        const l = web.link + c;
        const v = l * 4;
        const A = base + web.la[c], B = base + web.lb[c];
        nodes.set([A, B, A, B, B, A, B, A], v * 2);
        // The far end's side flips in the shader (its direction points back), so its signs are swapped
        side[v] = -1; side[v + 1] = 1; side[v + 2] = 1; side[v + 3] = -1;
        index.set([v, v + 1, v + 3, v, v + 3, v + 2], l * 6);
      }
      web.alphaDirty = false;
      for (let c = 0; c < web.m; c++) {
        const al = web.alive[c] ? web.fade[c] : 0;
        const v = (web.link + c) * 4;
        alpha[v] = alpha[v + 1] = alpha[v + 2] = alpha[v + 3] = al;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aNodes', new THREE.BufferAttribute(nodes, 2));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    this.alphaAttr = new THREE.BufferAttribute(alpha, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
  }

  /** Copies a web's nodes into its texture rows (and queues those rows for upload). */
  private writeNodes(web: Web, upload = true): void {
    const tex = this.texture;
    if (!tex || web.row < 0) return;
    web.nodesDirty = false;
    const data = tex.image.data as Float32Array;
    const base = web.row * TEX_W * 4;
    const { pos, n } = web;
    for (let i = 0; i < n; i++) {
      const o = base + i * 4, p = i * 3;
      data[o] = pos[p];
      data[o + 1] = pos[p + 1];
      data[o + 2] = pos[p + 2];
      data[o + 3] = 1;
    }
    if (!upload || this.fullUploadFrame === this.frameNo) return;
    // One range per row (an upload range must stay within a row)
    for (let r = 0; r * TEX_W < n; r++) {
      tex.addUpdateRange(base + r * TEX_W * 4, Math.min(TEX_W, n - r * TEX_W) * 4);
    }
    tex.needsUpdate = true;
  }

  private writeAlpha(web: Web): void {
    const attr = this.alphaAttr;
    if (!attr || web.link < 0) return;
    web.alphaDirty = false;
    const A = attr.array as Float32Array;
    for (let c = 0; c < web.m; c++) {
      const al = web.alive[c] ? web.fade[c] : 0;
      const v = (web.link + c) * 4;
      A[v] = A[v + 1] = A[v + 2] = A[v + 3] = al;
    }
    attr.addUpdateRange(web.link * 4, web.m * 4);
    attr.needsUpdate = true;
  }

  // ---------------------------------------------------------------- player

  /** The player's capsule centre this frame, or null (editing, driving, asleep): webs let go. */
  public setPlayer(p: { x: number; y: number; z: number } | null): void {
    if (!p) {
      this.releaseAll();
      this.player = null;
      this.hasLastPlayer = false;
      return;
    }
    this.playerPos.set(p.x, p.y, p.z);
    if (this.hasLastPlayer && this.playerPos.distanceTo(this.lastPlayer) > TELEPORT) this.releaseAll();
    this.lastPlayer.copy(this.playerPos);
    this.hasLastPlayer = true;
    this.player = this.playerPos;
  }

  private releaseAll(): void {
    if (!this.holding.size) return;
    for (const web of [...this.holding]) this.release(web);
  }

  /** The player's rig: threads stick to its arms, legs, head and body instead of the capsule. */
  public setBody(body: WebBody | null): void {
    this.body = body;
  }

  /** Once a frame (only when a web needs it): the body parts' matrices for this pose. */
  private poseBody(): void {
    if (this.posedFrame === this.frameNo) return;
    this.posedFrame = this.frameNo;
    const parts = this.body?.parts();
    this.partCount = 0;
    if (!parts?.length) return;
    this.body!.pose();
    const count = Math.min(parts.length, MAX_PARTS);
    for (let k = 0; k < count; k++) {
      const part = parts[k];
      const mw = part.bone.matrixWorld;
      this.partM.set(mw.elements, k * 16);
      this.partInv.set(this.m4.copy(mw).invert().elements, k * 16);
      this.partBox[k * 6] = part.min.x; this.partBox[k * 6 + 1] = part.min.y; this.partBox[k * 6 + 2] = part.min.z;
      this.partBox[k * 6 + 3] = part.max.x; this.partBox[k * 6 + 4] = part.max.y; this.partBox[k * 6 + 5] = part.max.z;
      this.partMargin[k] = BODY_MARGIN / Math.max(1e-4, mw.getMaxScaleOnAxis());
    }
    this.partCount = count;
  }

  public get isPlayerStuck(): boolean {
    return this.holding.size > 0;
  }

  /**
   * Holds the player back: going deeper, the speed into each clinging web is cut down as its pull
   * nears `hold` (gone at it) and past it the web shoves them back out; backing out only drags
   * (the web lets go once they're clear). Returns true if `vel` changed.
   */
  public restrain(vel: THREE.Vector3): boolean {
    if (!this.holding.size) return false;
    const hold = Math.max(0.01, webSettings.hold);
    for (const web of this.holding) {
      // Into the web: away from the side the player came from
      const ix = -web.normal.x * web.entrySide, iz = -web.normal.z * web.entrySide;
      const pull = Math.max(0, web.pullN * web.entrySide);
      const into = vel.x * ix + vel.z * iz;
      const cut = into > 0 ? into * Math.min(1, pull / hold) : into * CLING;
      vel.x -= ix * cut;
      vel.z -= iz * cut;
      if (pull > hold) {
        const back = Math.min(MAX_PULLBACK, (pull - hold) * PULLBACK);
        vel.x -= ix * back;
        vel.z -= iz * back;
      }
    }
    return true;
  }

  private release(web: Web): void {
    this.holding.delete(web);
    if (!web.stuckCount) return;
    for (let i = 0; i < web.n; i++) {
      if (!web.stuck[i]) continue;
      web.stuck[i] = 0;
      const o = i * 3;
      web.prev[o] = web.pos[o];
      web.prev[o + 1] = web.pos[o + 1];
      web.prev[o + 2] = web.pos[o + 2];
    }
    web.stuckCount = 0;
    web.entrySide = 0;
    web.pullN = 0;
    if (!web.gone) this.wake(web);
  }

  /** Signed distance of a point from the web's plane. */
  private static side(web: Web, x: number, y: number, z: number): number {
    return (x - web.origin.x) * web.normal.x + (y - web.origin.y) * web.normal.y + (z - web.origin.z) * web.normal.z;
  }

  // ---------------------------------------------------------------- axe

  /** A web in the axe's reach in front of the player (or the one holding them), as a swing target. */
  public findMeleeTarget(playerPos: THREE.Vector3, facing: THREE.Vector3, reach = WEB_REACH): { position: THREE.Vector3; radius: number } | null {
    let best: Web | null = null;
    let bestD = Infinity;
    for (const web of this.near(playerPos.x, playerPos.z, reach)) {
      if (web.gone) continue;
      const rx = playerPos.x - web.origin.x, ry = playerPos.y - web.origin.y, rz = playerPos.z - web.origin.z;
      const lz = rx * web.normal.x + ry * web.normal.y + rz * web.normal.z;
      const lx = rx * web.right.x + ry * web.right.y + rz * web.right.z;
      const ly = rx * web.up.x + ry * web.up.y + rz * web.up.z;
      const W = web.params.w * web.prop.scale, H = web.params.h * web.prop.scale;
      if (Math.abs(lz) > reach || Math.abs(lx) > W / 2 + 0.3 || ly < -1.2 || ly > H + 0.8) continue;
      // Facing it (or already caught in it)
      const toward = -Math.sign(lz) * (facing.x * web.normal.x + facing.z * web.normal.z);
      if (web.stuckCount === 0 && toward < 0.25) continue;
      if (!this.hasThreadsNear(web, playerPos, reach + 0.5)) continue;
      const d = Math.abs(lz);
      if (d < bestD) {
        bestD = d;
        best = web;
      }
    }
    if (!best) return null;
    const W = best.params.w * best.prop.scale, H = best.params.h * best.prop.scale;
    const rx = playerPos.x - best.origin.x, ry = playerPos.y + 0.2 - best.origin.y, rz = playerPos.z - best.origin.z;
    const lx = THREE.MathUtils.clamp(rx * best.right.x + ry * best.right.y + rz * best.right.z, -W / 2, W / 2);
    const ly = THREE.MathUtils.clamp(rx * best.up.x + ry * best.up.y + rz * best.up.z, 0.3, H - 0.2);
    this.target.position.copy(best.origin).addScaledVector(best.right, lx).addScaledVector(best.up, ly);
    return this.target;
  }

  private hasThreadsNear(web: Web, p: THREE.Vector3, r: number): boolean {
    const r2 = r * r;
    for (let c = 0; c < web.m; c++) {
      if (!web.alive[c] || web.fade[c] < 1) continue;
      const o = web.la[c] * 3;
      const dx = web.pos[o] - p.x, dy = web.pos[o + 1] - p.y, dz = web.pos[o + 2] - p.z;
      if (dx * dx + dy * dy + dz * dz < r2) return true;
    }
    return false;
  }

  /**
   * An axe slash from the player's chest along `dir` (horizontal): a tilted blade plane (the tilt
   * alternates swing to swing) cuts every thread crossing it within reach. Returns threads cut.
   */
  public cut(playerPos: THREE.Vector3, dir: THREE.Vector3, reach = WEB_REACH): number {
    const d = this.v1.set(dir.x, 0, dir.z);
    if (d.lengthSq() < 1e-6) return 0;
    d.normalize();
    this.slashTilt = -this.slashTilt;
    const tilt = this.slashTilt * 0.6;
    // Blade line: across the swing, tilted up; the plane holds the swing and the blade line
    const sx = -d.z * Math.cos(tilt), sy = Math.sin(tilt), sz = d.x * Math.cos(tilt);
    let nx = d.y * sz - d.z * sy, ny = d.z * sx - d.x * sz, nz = d.x * sy - d.y * sx;
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl; ny /= nl; nz /= nl;
    const px = playerPos.x, py = playerPos.y + 0.15, pz = playerPos.z;
    let total = 0;
    for (const web of this.near(px, pz, reach)) {
      if (web.gone || Math.hypot(web.center.x - px, web.center.z - pz) > web.boundRadius + reach + 0.5) continue;
      let cut = 0;
      for (let c = 0; c < web.m; c++) {
        if (!web.alive[c]) continue;
        const a = web.la[c] * 3, b = web.lb[c] * 3;
        const da = (web.pos[a] - px) * nx + (web.pos[a + 1] - py) * ny + (web.pos[a + 2] - pz) * nz;
        const db = (web.pos[b] - px) * nx + (web.pos[b + 1] - py) * ny + (web.pos[b + 2] - pz) * nz;
        if (da * db > 0) continue;
        const t = da === db ? 0.5 : da / (da - db);
        const xx = web.pos[a] + (web.pos[b] - web.pos[a]) * t - px;
        const xy = web.pos[a + 1] + (web.pos[b + 1] - web.pos[a + 1]) * t - py;
        const xz = web.pos[a + 2] + (web.pos[b + 2] - web.pos[a + 2]) * t - pz;
        const fwd = xx * d.x + xz * d.z;
        const along = xx * sx + xy * sy + xz * sz;
        if (fwd < -0.3 || fwd > reach || Math.abs(along) > SLASH_HALF) continue;
        web.alive[c] = 0;
        cut++;
        // The cut ends whip on with the blade
        for (const o of [a, b]) {
          if (web.inv[o / 3] === 0) continue;
          web.pos[o] += d.x * 0.04;
          web.pos[o + 2] += d.z * 0.04;
        }
      }
      if (cut) {
        this.release(web);
        web.topoDirty = true;
        web.alphaDirty = true;
        this.wake(web);
        total += cut;
      }
    }
    if (total) audioEngine.at(playerPos, 4).playWebCut(Math.min(1, total / 14));
    return total;
  }

  // ---------------------------------------------------------------- editor

  public pick(raycaster: THREE.Raycaster): { id: number; point: THREE.Vector3; distance: number } | null {
    let best: { id: number; point: THREE.Vector3; distance: number } | null = null;
    const ro = raycaster.ray.origin, rd = raycaster.ray.direction;
    for (const web of this.webs.values()) {
      const nrm = web.normal;
      const denom = rd.dot(nrm);
      if (Math.abs(denom) < 1e-5) continue;
      const t = this.v1.copy(web.origin).sub(ro).dot(nrm) / denom;
      if (t < 0 || (best && t >= best.distance)) continue;
      const hit = this.v2.copy(ro).addScaledVector(rd, t);
      const rel = this.v3.copy(hit).sub(web.origin);
      const lx = rel.dot(web.right), ly = rel.dot(web.up);
      const W = web.params.w * web.prop.scale, H = web.params.h * web.prop.scale;
      if (Math.abs(lx) > W / 2 + 0.1 || ly < -0.1 || ly > H + 0.15) continue;
      best = { id: web.prop.id, point: hit.clone(), distance: t };
    }
    return best;
  }

  // ---------------------------------------------------------------- frame

  public update(dt: number, camera: THREE.PerspectiveCamera): void {
    uPixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / this.viewportHeight;
    this.frameNo++;
    this.snapIn = Math.max(0, this.snapIn - dt);
    if (this.layoutDirty) this.rebuildLayout();
    const p = this.player;
    const cam = camera.position;
    const view = webSettings.viewDistance;

    // Woken by the player close by
    if (p) {
      for (const web of this.near(p.x, p.z, 2)) {
        if (!web.gone && !web.awake && Math.hypot(p.x - web.center.x, p.z - web.center.z) < web.boundRadius + 1) this.wake(web);
      }
    }
    // Drawn only while some web is in range of the camera (the shader fades each one out)
    let visible = false;
    for (const web of this.near(cam.x, cam.z, view)) {
      if (!web.gone && cam.distanceTo(web.center) - web.boundRadius < view) {
        visible = true;
        break;
      }
    }
    this.mesh.visible = visible;

    for (const web of this.active) {
      const camDist = Math.max(0, cam.distanceTo(web.center) - web.boundRadius);
      const shown = camDist < view;

      // Torn down: after a while the last threads fade, then the web is dropped
      if (web.tornFor >= 0 && !web.dying) {
        web.tornFor += dt;
        if (web.tornFor > TORN_REMOVE_AFTER) this.fadeAll(web);
      }
      if (web.dying && !web.fading) {
        this.dropThreads(web);
        continue;
      }
      // Nothing to hold on to yet (the colliders around it may still be building): try again now and then
      if (web.needsAnchor && shown) {
        web.anchorRetry -= dt;
        if (web.anchorRetry <= 0) {
          this.refresh(web.prop);
          continue;
        }
      }
      if (web.stuckCount && p) {
        if (WebField.side(web, p.x, p.y, p.z) * web.entrySide > RELEASE_DIST) this.release(web);
      }
      if (web.topoDirty) this.reconnect(web);
      if (!web.awake) {
        if (web.tornFor < 0 && !web.needsAnchor) this.active.delete(web);
        continue;
      }
      // Out of sight and nothing going on: nothing to simulate
      if (!shown && !web.stuckCount && !web.fading) continue;

      web.acc = Math.min(web.acc + dt, SUBSTEP * MAX_SUBSTEPS);
      let steps = 0;
      while (web.acc >= SUBSTEP) {
        web.acc -= SUBSTEP;
        this.step(web, p);
        steps++;
      }
      if (web.fading) this.fadeLinks(web, dt);
      if (steps) web.nodesDirty = true;
      if (web.nodesDirty) this.writeNodes(web);
      if (web.alphaDirty) this.writeAlpha(web);

      // Settled and untouched: sleep
      let moving = false;
      for (let i = 0; i < web.n * 3 && !moving; i++) moving = Math.abs(web.pos[i] - web.prev[i]) > 2e-4;
      if (!moving && !web.stuckCount && !web.fading) {
        web.calm += dt;
        if (web.calm > SLEEP_AFTER) web.awake = false;
      } else web.calm = 0;
    }
  }

  private step(web: Web, p: THREE.Vector3 | null): void {
    const { pos, prev, inv, stuck, off, loose, ground, n } = web;
    const g = webSettings.gravity * SUBSTEP * SUBSTEP;
    const gl = 9.8 * SUBSTEP * SUBSTEP;
    if (p) this.poseBody();
    const M = this.partM;
    for (let i = 0; i < n; i++) {
      if (inv[i] === 0) continue;
      const o = i * 3;
      if (stuck[i] && p) {
        const k = stuck[i] - 2;
        if (k >= 0 && k < this.partCount) {
          // Carried by its body part: part space -> world
          const e = k * 16, x = off[o], y = off[o + 1], z = off[o + 2];
          pos[o] = prev[o] = M[e] * x + M[e + 4] * y + M[e + 8] * z + M[e + 12];
          pos[o + 1] = prev[o + 1] = M[e + 1] * x + M[e + 5] * y + M[e + 9] * z + M[e + 13];
          pos[o + 2] = prev[o + 2] = M[e + 2] * x + M[e + 6] * y + M[e + 10] * z + M[e + 14];
        } else {
          pos[o] = prev[o] = p.x + off[o];
          pos[o + 1] = prev[o + 1] = p.y + off[o + 1];
          pos[o + 2] = prev[o + 2] = p.z + off[o + 2];
        }
        continue;
      }
      const damp = loose[i] ? 0.99 : 0.965;
      const vx = (pos[o] - prev[o]) * damp, vy = (pos[o + 1] - prev[o + 1]) * damp, vz = (pos[o + 2] - prev[o + 2]) * damp;
      prev[o] = pos[o];
      prev[o + 1] = pos[o + 1];
      prev[o + 2] = pos[o + 2];
      pos[o] += vx;
      pos[o + 1] += vy - (loose[i] ? gl : g);
      pos[o + 2] += vz;
      if (loose[i] && pos[o + 1] < ground[i]) {
        pos[o + 1] = ground[i];
        prev[o] = pos[o] - vx * 0.3;
        prev[o + 2] = pos[o + 2] - vz * 0.3;
      }
    }

    // Threads: strings, they only pull (fewer passes while nobody is caught)
    const { la, lb, rest, kind, alive, m } = web;
    const iterations = web.stuckCount ? ITERATIONS : ITERATIONS_IDLE;
    for (let it = 0; it < iterations; it++) {
      for (let c = 0; c < m; c++) {
        if (!alive[c]) continue;
        const a = la[c], b = lb[c];
        const wa = stuck[a] ? 0 : inv[a], wb = stuck[b] ? 0 : inv[b];
        const w = wa + wb;
        if (w === 0) continue;
        const ao = a * 3, bo = b * 3;
        const dx = pos[bo] - pos[ao], dy = pos[bo + 1] - pos[ao + 1], dz = pos[bo + 2] - pos[ao + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const r = rest[c];
        if (d <= r) continue;
        const k = ((d - r) / (d * w)) * (kind[c] === K_SPIRAL ? 0.9 : 1);
        pos[ao] += dx * k * wa; pos[ao + 1] += dy * k * wa; pos[ao + 2] += dz * k * wa;
        pos[bo] -= dx * k * wb; pos[bo + 1] -= dy * k * wb; pos[bo + 2] -= dz * k * wb;
      }
    }

    // The player's body: threads touching an arm, a leg, the head or the body stick to that part
    // (to the capsule until the model has loaded)
    if (p) {
      const r2 = CAPSULE_R * CAPSULE_R;
      const parts = this.partCount;
      const I = this.partInv, B = this.partBox;
      const wasHeld = web.stuckCount > 0;
      for (let i = 0; i < n; i++) {
        if (inv[i] === 0 || stuck[i] || loose[i]) continue;
        const o = i * 3;
        const wx = pos[o], wy = pos[o + 1], wz = pos[o + 2];
        let hold = 0;
        if (parts) {
          // Out of arm's reach of the player: no part can touch it
          const dx = wx - p.x, dy = wy - p.y, dz = wz - p.z;
          if (dx * dx + dz * dz > 1.2 || dy * dy > 1.0) continue;
          for (let k = 0; k < parts && !hold; k++) {
            const e = k * 16, b = k * 6, mg = this.partMargin[k];
            const lx = I[e] * wx + I[e + 4] * wy + I[e + 8] * wz + I[e + 12];
            const ly = I[e + 1] * wx + I[e + 5] * wy + I[e + 9] * wz + I[e + 13];
            const lz = I[e + 2] * wx + I[e + 6] * wy + I[e + 10] * wz + I[e + 14];
            const x0 = B[b] - mg, y0 = B[b + 1] - mg, z0 = B[b + 2] - mg;
            const x1 = B[b + 3] + mg, y1 = B[b + 4] + mg, z1 = B[b + 5] + mg;
            if (lx < x0 || lx > x1 || ly < y0 || ly > y1 || lz < z0 || lz > z1) continue;
            // Laid on the nearest face of the (padded) part, so the thread wraps it instead of sinking in
            let fx = x0, fy = ly, fz = lz, best = lx - x0;
            if (x1 - lx < best) { best = x1 - lx; fx = x1; fy = ly; fz = lz; }
            if (ly - y0 < best) { best = ly - y0; fx = lx; fy = y0; fz = lz; }
            if (y1 - ly < best) { best = y1 - ly; fx = lx; fy = y1; fz = lz; }
            if (lz - z0 < best) { best = lz - z0; fx = lx; fy = ly; fz = z0; }
            if (z1 - lz < best) { fx = lx; fy = ly; fz = z1; }
            off[o] = fx;
            off[o + 1] = fy;
            off[o + 2] = fz;
            hold = 2 + k;
          }
        } else {
          const cy = THREE.MathUtils.clamp(wy, p.y - CAPSULE_HALF, p.y + CAPSULE_HALF);
          const dx = wx - p.x, dy = wy - cy, dz = wz - p.z;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          off[o] = wx - p.x;
          off[o + 1] = wy - p.y;
          off[o + 2] = wz - p.z;
          hold = STUCK_CAPSULE;
        }
        if (!hold) continue;
        if (!web.stuckCount) web.entrySide = WebField.side(web, p.x, p.y, p.z) >= 0 ? 1 : -1;
        stuck[i] = hold;
        web.stuckCount++;
      }
      if (!wasHeld && web.stuckCount) this.holding.add(web);
    }

    // Overstretched threads snap; the pull of the ones holding the player
    const strength = web.params.strength;
    const snapSpiral = webSettings.breakStretch * Math.sqrt(strength);
    const snapRadial = snapSpiral * 1.8;
    const nrm = web.normal;
    let pull = 0;
    let snapped = -1;
    for (let c = 0; c < m; c++) {
      if (!alive[c]) continue;
      const a = la[c], b = lb[c];
      const ao = a * 3, bo = b * 3;
      const dx = pos[bo] - pos[ao], dy = pos[bo + 1] - pos[ao + 1], dz = pos[bo + 2] - pos[ao + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const ratio = d / rest[c];
      if (ratio > (kind[c] === K_SPIRAL ? snapSpiral : snapRadial)) {
        alive[c] = 0;
        web.topoDirty = true;
        web.alphaDirty = true;
        snapped = ao;
        continue;
      }
      if (!stuck[a] === !stuck[b] || ratio <= 1) continue;
      // From the stuck end towards the free one, along the web's normal
      const sign = stuck[a] ? 1 : -1;
      const along = ((dx * nrm.x + dy * nrm.y + dz * nrm.z) / d) * sign;
      pull += along * (ratio - 1) * (kind[c] === K_SPIRAL ? 0.5 : 1);
    }
    web.pullN = web.stuckCount ? pull * strength * PULL_SCALE : 0;
    if (snapped >= 0 && this.snapIn <= 0) {
      this.snapIn = 0.07;
      audioEngine.at(this.v3.set(pos[snapped], pos[snapped + 1], pos[snapped + 2]), 3).playWebSnap(0.6 + Math.random() * 0.4);
    }
  }

  /** The floor under a point (the cave floor or the terrain), found once when a node comes loose. */
  private groundBelow(x: number, y: number, z: number): number {
    const o = this.v1.set(x, y + 0.05, z);
    const hit = this.physics.castRay(o, this.v2.set(0, -1, 0), 40);
    if (hit) return o.y - hit.timeOfImpact + 0.01;
    const t = this.terrain.getHeight(x, z) + 0.01;
    return t <= y ? t : y - 40;
  }

  /** After a cut or a snap: whatever no longer reaches an anchor falls and fades. */
  private reconnect(web: Web): void {
    web.topoDirty = false;
    this.wake(web);
    const { n, inv, alive, la, lb, adj, adjStart, loose, stuck, seen, queue } = web;
    seen.fill(0);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) {
      if (inv[i] === 0) {
        seen[i] = 1;
        queue[tail++] = i;
      }
    }
    while (head < tail) {
      const i = queue[head++];
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const c = adj[k];
        if (!alive[c]) continue;
        const j = la[c] === i ? lb[c] : la[c];
        if (!seen[j]) {
          seen[j] = 1;
          queue[tail++] = j;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (seen[i] || loose[i]) continue;
      loose[i] = 1;
      web.ground[i] = this.groundBelow(web.pos[i * 3], web.pos[i * 3 + 1], web.pos[i * 3 + 2]);
      if (stuck[i]) {
        stuck[i] = 0;
        web.stuckCount--;
      }
    }
    if (!web.stuckCount) this.holding.delete(web);
    for (let c = 0; c < web.m; c++) {
      if (alive[c] && web.fade[c] >= 1 && (loose[la[c]] || loose[lb[c]])) {
        web.fade[c] = 0.999;
        web.fading++;
      }
    }
    // Hardly anything left whole: torn down (removed TORN_REMOVE_AFTER later)
    if (web.tornFor < 0) {
      let whole = 0;
      for (let c = 0; c < web.m; c++) if (alive[c] && web.fade[c] >= 1) whole++;
      // Node 0 is the hub
      if (whole < web.m * TORN_SHARE || (loose[0] && whole < web.m * TORN_SHARE_NO_HUB)) web.tornFor = 0;
    }
    web.alphaDirty = true;
  }

  /** Starts fading every thread still standing (a torn-down web going away). */
  private fadeAll(web: Web): void {
    web.dying = true;
    this.release(web);
    this.wake(web);
    for (let c = 0; c < web.m; c++) {
      if (web.alive[c] && web.fade[c] >= 1) {
        web.fade[c] = 0.999;
        web.fading++;
      }
    }
    web.alphaDirty = true;
  }

  private fadeLinks(web: Web, dt: number): void {
    const step = dt / FADE_TIME;
    // Recounted: a fading thread can also be cut or snap on the way
    let fading = 0;
    for (let c = 0; c < web.m; c++) {
      if (!web.alive[c] || web.fade[c] >= 1) continue;
      web.fade[c] -= step;
      if (web.fade[c] <= 0) {
        web.fade[c] = 0;
        web.alive[c] = 0;
      } else fading++;
    }
    web.fading = fading;
    web.alphaDirty = true;
  }

  public dispose(): void {
    for (const web of this.webs.values()) this.teardown(web);
    this.webs.clear();
    this.mesh.geometry.dispose();
    this.texture?.dispose();
    this.group.removeFromParent();
  }
}
