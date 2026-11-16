import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { injectNightLights } from './NightLighting';
import { injectWaterline } from '../scene/WaterDetails';
import { isMobileDevice, worldSettings } from './WorldSettings';
import { riverWorld } from './rivers/RiverWorld';
import type { PropInstance } from './PropSystem';

/**
 * Underwater chain plants: algae stalks and water lilies. Both are chains of links from a small
 * glb (one link mesh plus a head that caps the chain), drawn instanced and bent in the vertex
 * shader, simulated as Verlet chains while something touches them. A species sets the model,
 * the physics (lilies are stiffer and float their head on the surface) and how it is drawn.
 */
export type ChainKind = 'algae' | 'lily';

interface SpeciesConfig {
  kind: ChainKind;
  url: string;
  /** Node of the chain link (stacked from y = 0 up). */
  link: string;
  /** Nodes that can cap the chain (the prop's `head` picks one). */
  heads: string[];
  minLinks: number;
  maxLinks: number;
  defaultLinks: number;
  /** Upward pull of the plant in water (m/s²): what stands it back up. */
  buoyancy: number;
  /** Water drag (1/s): how fast the swing dies out. */
  drag: number;
  /** Bending resistance (0..1 per iteration): how hard joints two apart keep their straight distance. */
  stiffness: number;
  /**
   * Rides on the water: no joint rises past the local surface (the sea or a river), the head is
   * buoyed harder and stays upright, so a stem longer than the depth lays its head flat on top.
   */
  floats: boolean;
  /** The head is turned as one rigid piece (the joint at its base to its tip), never bent. */
  rigidHead: boolean;
  /**
   * Every plant keeps its own joint-texture row, posed once at rest (needed when the rest pose is
   * not simply upright: a floating lily). Otherwise rows are only lent to the moving stalks.
   */
  keepRows: boolean;
  /** Rows of the joint texture (plants posed / simulated at once). */
  rows: number;
  /** Slow current sway (share of the plant's height). */
  sway: number;
  /** Draw distance (m, camera to the cell's nearest edge). */
  viewDist: number;
  /** Colours from the developer panel's root-to-top gradient (else the model's own). */
  gradient: boolean;
}

const ALGAE_CONFIG: SpeciesConfig = {
  kind: 'algae',
  url: `${import.meta.env.BASE_URL}models/algae_chain.glb`,
  link: 'chain',
  heads: ['top'],
  minLinks: 1,
  maxLinks: 40,
  defaultLinks: 8,
  buoyancy: 10,
  drag: 3.4,
  stiffness: 0.08,
  floats: false,
  rigidHead: false,
  keepRows: false,
  rows: 64,
  sway: 0.05,
  // Underwater the fog closes in long before this, so stalks never visibly pop; from the shore
  // the water hides them too
  viewDist: isMobileDevice() ? 30 : 42,
  gradient: true,
};

const LILY_CONFIG: SpeciesConfig = {
  kind: 'lily',
  url: `${import.meta.env.BASE_URL}models/water_lily.glb`,
  link: 'Plane',
  heads: ['Circle', 'Plane.004'],
  minLinks: 1,
  maxLinks: 24,
  defaultLinks: 3,
  buoyancy: 6,
  drag: 4.5,
  // Much stiffer than algae: the stem keeps its line and swings back as a whole
  stiffness: 0.45,
  floats: true,
  rigidHead: true,
  keepRows: true,
  rows: 512,
  sway: 0.012,
  // Seen on the surface from the shore, so much farther than the algae
  viewDist: isMobileDevice() ? 60 : 90,
  gradient: false,
};

/** Lily heads (the prop's `head`): 0 = leaf, 1 = flower. */
export const LILY_HEADS = ['Листок', 'Цвіт'] as const;

/** Cells (m) the plants are batched in; one InstancedMesh per chain length and head per cell. */
const CELL = 32;

// Physical chain: one Verlet joint per link boundary plus the tip, all in world metres
/** Constraint iterations per step (link lengths, stiffness, contacts). */
const ITERATIONS = 5;
/** Share of a joint's overlap with a body removed per iteration (soft: no fight with the links). */
const CONTACT_SOFTNESS = 0.35;
/** Share of a touching joint's velocity the contact takes away (no bounce off the body). */
const CONTACT_DAMP = 0.25;
/** Largest body motion (m per step) that drags the plants (teleports and respawns don't fling them). */
const MAX_DRAG_STEP = 0.08;
/** Share of a touching body's motion the joints are dragged along with (water friction). */
const FRICTION = 0.35;
/** A joint's own thickness for contacts (m at scale 1). */
const NODE_RADIUS = 0.12;
const MAX_PUSHERS = 8;
/** Plants stepped at once; the rest wait (at rest, or in their settled pose). */
const MAX_ACTIVE = 64;
const SUBSTEP = 1 / 60;
/** At rest this long (s) with no body touching, a plant stops being simulated. */
const SLEEP_AFTER = 0.6;
/** Floating heads: how far (m at scale 1) the head's base sits under the surface. */
const FLOAT_SINK = 0.04;
/** Floating heads: extra buoyancy of the head (times the stem's). */
const HEAD_LIFT = 2.5;
/**
 * Heads: share per iteration of the way the tip and the base are pulled back into line (the tip
 * above the base). Weak under water, so the head tilts with the stem; firmer floating, so a leaf
 * pushed over rights itself and lies back on the water.
 */
const HEAD_UPRIGHT = 0.04;
const HEAD_UPRIGHT_FLOAT = 0.25;
/** Heads: how hard the head lines up with the stem's last link (share of the stem's stiffness). */
const HEAD_FOLLOW = 0.25;
/** Heads repelling each other: chunk size (m) of the head grid (wider than any two heads). */
const HEAD_CELL = 4;
/** Share of two heads' overlap removed per iteration (soft, so they drift apart). */
const HEAD_REPEL = 0.2;
/** Overlap (m) of a moving head with a resting one that wakes the resting one. */
const HEAD_WAKE_OVERLAP = 0.03;
/** Bodies passed to the head shader (the pushers that bend leaf edges and petals). */
const MAX_SHADER_PUSHERS = 4;
/** Steps a kept-row plant is settled with when placed (6 s of simulated water). */
const SETTLE_STEPS = 180;
/** Settling step (s): coarser than the live one, it only has to find where the plant comes to rest. */
const SETTLE_DT = 1 / 30;
/** Settling never stops before this many steps (a fresh pose starts out still). */
const SETTLE_MIN = 30;
/** Time (ms) per frame spent settling newly placed plants. */
const SETTLE_BUDGET_MS = 2;
/** Joint motion (m per step) below which a plant counts as at rest. */
const REST_SPEED = 0.0006;

// ------------------------------------------------------------------ shared uniforms

const uAlgTime = { value: 0 };

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

/** How much sunlight reaches the underwater plants now (0..1); call once per frame. */
export function setAlgaeDaylight(day: number): void {
  uAlgDay.value = day;
}

// ------------------------------------------------------------------ species (model + look)

interface Parts {
  chain: THREE.BufferGeometry;
  heads: THREE.BufferGeometry[];
  /** Link height: one link's bottom ring meets the next one's top ring. */
  linkH: number;
  /** Where the link's bottom ring sits (its local min y). */
  linkMinY: number;
  /** Widest reach of each head around the stem (m at scale 1), for picking and contacts. */
  headR: number[];
}

/** GLTFLoader drops the characters three's property paths reserve ("Plane.004" → "Plane004"). */
function findMesh(root: THREE.Object3D, name: string): THREE.Mesh | undefined {
  const o = root.getObjectByName(name) ?? root.getObjectByName(name.replace(/[[\].:/]/g, ''));
  return (o as THREE.Mesh | undefined)?.isMesh ? (o as THREE.Mesh) : undefined;
}

export class ChainSpecies {
  public parts: Parts | null = null;
  private loading: Promise<boolean> | null = null;
  private readonly cache = new Map<string, THREE.BufferGeometry>();
  /** Joints per plant at most: the root, one per link, the tip. */
  public readonly maxJoints: number;
  /** Texels per row (the joints). */
  public readonly width: number;
  /** Bodies near the heads this frame for the head shader: x, z, radius, bottom y; and their height. */
  public readonly uPush = { value: Array.from({ length: MAX_SHADER_PUSHERS }, () => new THREE.Vector4()) };
  public readonly uPushH = { value: new Array<number>(MAX_SHADER_PUSHERS).fill(0) };
  public readonly uPushCount = { value: 0 };
  /** Joint offsets (world m, from the straight rest pose): one row per posed / simulated plant. */
  public readonly simData: Float32Array;
  public readonly simTexture: THREE.DataTexture;
  public readonly uLinkH = { value: 0.18 };
  public readonly uSim: { value: THREE.DataTexture };
  public readonly uSway: { value: number };
  public readonly material: THREE.MeshLambertMaterial;

  constructor(public readonly cfg: SpeciesConfig) {
    this.maxJoints = cfg.maxLinks + 2;
    this.width = this.maxJoints;
    this.simData = new Float32Array(this.width * cfg.rows * 4);
    this.simTexture = new THREE.DataTexture(this.simData, this.width, cfg.rows, THREE.RGBAFormat, THREE.FloatType);
    this.simTexture.minFilter = this.simTexture.magFilter = THREE.NearestFilter;
    this.simTexture.needsUpdate = true;
    this.dirtyRows = new Uint8Array(cfg.rows);
    this.uSim = { value: this.simTexture };
    this.uSway = { value: cfg.sway };
    this.material = createChainMaterial(this);
  }

  /** Rows queued for the GPU since its last upload (each queued once). */
  private readonly dirtyRows: Uint8Array;
  private dirtyCount = 0;

  /**
   * Queues one row of the joint texture for the GPU: only the rows that changed are sent (a
   * moving plant's), not the whole texture.
   */
  public markRow(row: number): void {
    if (row < 0) return;
    const tex = this.simTexture;
    // three clears the ranges once it has uploaded them: start counting afresh
    if (this.dirtyCount && tex.updateRanges.length === 0) {
      this.dirtyRows.fill(0);
      this.dirtyCount = 0;
    }
    if (!this.dirtyRows[row]) {
      this.dirtyRows[row] = 1;
      this.dirtyCount++;
      tex.addUpdateRange(row * this.width * 4, this.width * 4);
    }
    tex.needsUpdate = true;
  }

  public clampLinks(n: number | undefined): number {
    return Math.round(THREE.MathUtils.clamp(n ?? this.cfg.defaultLinks, this.cfg.minLinks, this.cfg.maxLinks));
  }

  public clampHead(h: number | undefined): number {
    return Math.round(THREE.MathUtils.clamp(h ?? 0, 0, this.cfg.heads.length - 1));
  }

  /** Loads the model once (its link and the heads that cap a chain). */
  public load(): Promise<boolean> {
    if (this.loading) return this.loading;
    const cfg = this.cfg;
    this.loading = new GLTFLoader()
      .loadAsync(cfg.url)
      .then((gltf) => {
        const chain = findMesh(gltf.scene, cfg.link);
        const heads = cfg.heads.map((n) => findMesh(gltf.scene, n));
        if (!chain || heads.some((h) => !h)) throw new Error(`${cfg.url} needs "${cfg.link}" and ${cfg.heads.map((h) => `"${h}"`).join(', ')} meshes`);
        const bake = (m: THREE.Mesh) => {
          m.updateWorldMatrix(true, false);
          const g = m.geometry.clone();
          // Only the node's own transform: the scene root may carry nothing else
          g.applyMatrix4(m.matrixWorld);
          g.computeBoundingBox();
          return g;
        };
        const c = bake(chain);
        const hs = heads.map((h) => bake(h!));
        const box = c.boundingBox!;
        const headR = hs.map((g) => {
          const b = g.boundingBox!;
          return Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z, NODE_RADIUS);
        });
        this.parts = { chain: c, heads: hs, linkH: box.max.y - box.min.y, linkMinY: box.min.y, headR };
        this.uLinkH.value = this.parts.linkH;
        if (cfg.gradient) {
          // The model's brightest green: its colours become shades (1 = full colour) for the tint
          const ca = c.getAttribute('color');
          let ref = 0;
          if (ca) for (let i = 0; i < ca.count; i++) ref = Math.max(ref, ca.getY(i));
          if (ref > 0) uAlgShadeRef.value = ref;
        }
        gltf.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
        return true;
      })
      .catch((err) => {
        console.warn(`[Chains] ${cfg.url} failed to load`, err);
        return false;
      });
    return this.loading;
  }

  /** Height (m, scale 1) of a plant of `links` links with its head; 0 before the model loads. */
  public height(links: number, head = 0): number {
    if (!this.parts) return 0;
    const b = this.parts.heads[this.clampHead(head)].boundingBox!;
    return this.clampLinks(links) * this.parts.linkH + (b.max.y - b.min.y);
  }

  /**
   * One plant as a single welded, smooth-shaded mesh: `links` chain links stacked (alternating 0° /
   * 90° around the stem; the stem ring is square so the seams still meet), the head on the last
   * one. Vertices that share a spot (link seams, the model's flat-shading splits) are welded and
   * get one averaged normal, so the plant shades as one smooth surface. Attributes: position,
   * normal, color and aAlg (x: joint coordinate up the chain, y: the height, z: the link count,
   * w: the head's radius for the head shader, 0 for a bendy head).
   */
  public geometry(links: number, head = 0): THREE.BufferGeometry | null {
    const parts = this.parts;
    if (!parts) return null;
    const n = this.clampLinks(links);
    const hi = this.clampHead(head);
    const key = `${n}|${hi}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const top = parts.heads[hi];

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
    m.compose(new THREE.Vector3(0, n * parts.linkH - top.boundingBox!.min.y, 0), q, one);
    pieces.push({ g: top, m: m.clone() });

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
    // Joint coordinate: 0..n along the links (one per link), n..n+1 over the head
    const chainTop = n * parts.linkH;
    const rimR = this.cfg.rigidHead ? parts.headR[hi] : 0;
    const alg = new Float32Array(vCount * 4);
    for (let i = 0; i < vCount; i++) {
      const y = Math.max(0, pos[i * 3 + 1]);
      alg[i * 4] = y <= chainTop ? y / parts.linkH : n + Math.min(1, (y - chainTop) / Math.max(height - chainTop, 1e-4));
      alg[i * 4 + 1] = height;
      alg[i * 4 + 2] = n;
      alg[i * 4 + 3] = rimR;
    }

    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(smoothNormals(pos, idx), 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aAlg', new THREE.BufferAttribute(alg, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    // Drop the now identical duplicates (same spot, normal and colour)
    g = mergeVertices(g, 1e-4);
    if (g.getAttribute('position').count < 65536) g.setIndex(new THREE.BufferAttribute(Uint16Array.from(g.index!.array as Uint32Array), 1));
    g.clearGroups();
    g.addGroup(0, g.index!.count, 0);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.cache.set(key, g);
    return g;
  }
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

/**
 * Vertex colours plus the chain pose, all in the vertex shader. A plant's joints are its straight
 * rest pose, a slow current sway on its own phase and, while it has a texture row, its row of
 * joint offsets from the physics. The stem follows a Catmull-Rom curve through the joints and
 * every vertex is turned with the curve's tangent, so links (and their fronds) really rotate as
 * the stem bends; normals turn with them. A rigid head turns as one piece from its base joint.
 * The daylight shimmer is cut off at the local water surface (nothing above the water glints).
 */
function createChainMaterial(sp: ChainSpecies): THREE.MeshLambertMaterial {
  const cfg = sp.cfg;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    injectNightLights(shader);
    injectWaterline(shader);
    const waterline = shader.fragmentShader.includes('vWaterlineH');
    const defines =
      (cfg.gradient ? '#define ALG_GRADIENT\n' : '') +
      (cfg.rigidHead ? '#define ALG_RIGID_HEAD\n' : '') +
      (waterline ? '#define ALG_WATERLINE\n' : '') +
      (cfg.rigidHead ? `#define ALG_HEAD_DEFORM\n#define ALG_PUSHERS ${MAX_SHADER_PUSHERS}\n` : '');
    shader.uniforms.uAlgTime = uAlgTime;
    shader.uniforms.uAlgLinkH = sp.uLinkH;
    shader.uniforms.uAlgSim = sp.uSim;
    shader.uniforms.uAlgSway = sp.uSway;
    shader.uniforms.uAlgPush = sp.uPush;
    shader.uniforms.uAlgPushH = sp.uPushH;
    shader.uniforms.uAlgPushCount = sp.uPushCount;
    Object.assign(shader.uniforms, {
      uAlgBase, uAlgTip, uAlgShadeRef, uAlgShimmer, uAlgShimmerSpeed, uAlgShimmerScale, uAlgShimmerColor, uAlgDay,
    });
    shader.vertexShader = defines + shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uAlgTime;
uniform float uAlgLinkH;
uniform float uAlgSway;
uniform sampler2D uAlgSim;
// x: joint coordinate (0..links over the links, links..links+1 over the head), y: height, z: links,
// w: the head's radius (local)
attribute vec4 aAlg;
#ifdef ALG_HEAD_DEFORM
uniform vec4 uAlgPush[ALG_PUSHERS];
uniform float uAlgPushH[ALG_PUSHERS];
uniform int uAlgPushCount;
#endif
#ifdef USE_INSTANCING
// Row of the joint texture + 1 (0: no row, drawn upright)
attribute float aAlgRow;
#ifdef ALG_GRADIENT
// Per-stalk colours (linear): root and top, w = 1 when the stalk has its own
attribute vec4 aAlgBaseC;
attribute vec4 aAlgTipC;
#endif
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
  float links = aAlg.z;
  int last = int(links + 0.5) + 1;
  int row = int(aAlgRow + 0.5) - 1;
  float ph = ip.x * 0.73 + ip.z * 0.41;
  vec2 cur = vec2(
    sin(uAlgTime * 0.7 + ph) + 0.25 * sin(uAlgTime * 1.3 + ph * 2.3),
    cos(uAlgTime * 0.55 + ph * 1.3)
  ) * (uAlgSway * H * s);
  float u = clamp(aAlg.x, 0.0, float(last));
  // The head's rest length (local)
  float topLen = H - links * uAlgLinkH;
  vec3 world;
  vec3 t;
  #ifdef ALG_RIGID_HEAD
  if (u >= links - 0.001) {
    // The head: one rigid piece on its base joint, turned towards its tip
    vec3 hb = algJoint(last - 1, last, links, H, cur, row);
    vec3 ht = algJoint(last, last, links, H, cur, row);
    t = normalize(vec3(0.0, topLen * s, 0.0) + ht - hb);
    float yb = links * uAlgLinkH;
    vec3 hl = vec3(position.x, position.y - yb, position.z);
    world = vec3(0.0, yb * s, 0.0) + hb + algTurn(im * hl, t);
    #ifdef ALG_HEAD_DEFORM
    // Deformed like the flowers, in the shader: the farther out a vertex lies (leaf edge, petal
    // tips), the more it rocks with the water, ripples, and gives way to a body pressing it
    float headR = aAlg.w;
    if (headR > 0.0) {
      float wgt = pow(clamp(length(hl.xz) / headR, 0.0, 1.4), 1.5);
      float hr = headR * s;
      vec3 wq = ip + world;
      float hph = ip.x * 1.31 + ip.z * 0.77;
      vec3 d = vec3(0.0);
      // Rocking: the whole head tips a little to and fro (a tilt, linear across it)
      vec3 hw = im * hl;
      d.y += (hw.x * sin(uAlgTime * 1.1 + hph) + hw.z * cos(uAlgTime * 0.9 + hph * 1.7)) * 0.05;
      // Ripples running over it
      d.y += sin(wq.x * 2.3 + uAlgTime * 1.6) * cos(wq.z * 1.9 - uAlgTime * 1.2) * 0.07 * hr;
      // Bodies: the near edge bends away and is pressed down
      for (int i = 0; i < ALG_PUSHERS; i++) {
        if (i >= uAlgPushCount) break;
        vec4 pb = uAlgPush[i];
        if (wq.y < pb.w - 0.3 || wq.y > pb.w + uAlgPushH[i] + 0.3) continue;
        vec2 dv = wq.xz - pb.xy;
        float dist = length(dv);
        float f = 1.0 - smoothstep(pb.z * 0.5, pb.z + hr * 0.5, dist);
        if (f <= 0.0) continue;
        d.xz += dv / max(dist, 1e-3) * f * hr * 0.3;
        d.y -= f * hr * 0.35;
      }
      world += wgt * d;
    }
    #endif
  } else
  #endif
  {
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
    // This span's rest length (world): a link, or the head
    float span = (float(k) < links ? uAlgLinkH : topLen) * s;
    t = normalize(vec3(0.0, span, 0.0) + dOff);
    // Rest height (local) of the stem point at this joint coordinate
    float y = u <= links ? u * uAlgLinkH : links * uAlgLinkH + (u - links) * topLen;
    // World: stem point, its curve offset, and the vertex's own part turned with the stem
    vec3 side = im * vec3(position.x, position.y - y, position.z);
    world = vec3(0.0, y * s, 0.0) + off + algTurn(side, t);
  }
  algLocal = transpose(im) * world / s2;

  float up = u / float(last);
  #if defined(USE_COLOR) && defined(ALG_GRADIENT)
  // Colour: the picked root-to-top gradient, shaded by the model's own colours
  vec3 algBase = aAlgBaseC.w > 0.5 ? aAlgBaseC.rgb : uAlgBase;
  vec3 algTip = aAlgTipC.w > 0.5 ? aAlgTipC.rgb : uAlgTip;
  vColor.rgb = mix(algBase, algTip, smoothstep(0.0, 1.0, up)) * (color.g / uAlgShadeRef);
  #endif

  // Sunlight shimmer, per vertex: two drifting, warped wave fields crossed like caustics, plus a
  // glow running up the stem; brighter toward the top (nearer the surface). Nothing by night.
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
    shader.fragmentShader = defines + shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uAlgShimmerColor;
varying float vAlgShimmer;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
// Sunlight through the water: the plant's own colour, lighter (a brighter shade of it with a
// touch of the shimmer tint and a little white), not a pale wash over it. Only under the water:
// cut per pixel at the local surface, so a leaf lying on top or a stem above it never glints.
float algUnder = 1.0;
#ifdef ALG_WATERLINE
algUnder = 1.0 - smoothstep(-0.03, 0.02, vWaterlineH);
#endif
vec3 algLight = diffuseColor.rgb * (0.6 + 0.4 * uAlgShimmerColor) * 2.2 + uAlgShimmerColor * 0.06;
totalEmissiveRadiance += algLight * vAlgShimmer * algUnder;`
      );
  };
  mat.customProgramCacheKey = () => `chain-${cfg.kind}-7`;
  return mat;
}

// ------------------------------------------------------------------ species instances

export const ALGAE = new ChainSpecies(ALGAE_CONFIG);
export const LILY = new ChainSpecies(LILY_CONFIG);
export const CHAIN_SPECIES: Readonly<Record<ChainKind, ChainSpecies>> = { algae: ALGAE, lily: LILY };

/** Chain links per algae stalk (the editor's length slider). */
export const ALGAE_MIN_LINKS = ALGAE_CONFIG.minLinks;
export const ALGAE_MAX_LINKS = ALGAE_CONFIG.maxLinks;
export const ALGAE_DEFAULT_LINKS = ALGAE_CONFIG.defaultLinks;
export const clampLinks = (n: number | undefined): number => ALGAE.clampLinks(n);
export const loadAlgaeParts = (): Promise<boolean> => ALGAE.load();
export const algaeHeight = (links: number): number => ALGAE.height(links);
export const algaeGeometry = (links: number): THREE.BufferGeometry | null => ALGAE.geometry(links);
export const ALGAE_MATERIAL = ALGAE.material;

// ------------------------------------------------------------------ field

interface ChainBatch {
  links: number;
  head: number;
  cx: number;
  cz: number;
  mesh: THREE.InstancedMesh;
  /** Per instance: joint-texture row + 1 (0 = no row). */
  row: THREE.InstancedBufferAttribute;
  /** Per instance: root colour rgb + own flag, top colour rgb + own flag (8 floats). */
  cols: THREE.InstancedInterleavedBuffer;
  recs: ChainRec[];
  dirty: boolean;
  minY: number;
  maxY: number;
}

interface ChainRec {
  prop: PropInstance;
  batch: ChainBatch | null;
  slot: number;
  /** Plant height in world metres. */
  height: number;
  /** Joint-texture row while it has one, else -1. */
  sim: number;
}

/** A posed / simulated plant's joints (world positions now and one step ago). */
interface SimChain {
  rec: ChainRec;
  joints: number;
  /** Rest height of each joint above the root (world m). */
  rest: Float32Array;
  p: Float32Array;
  q: Float32Array;
  /** Joints after the step before the last one: drawn blended toward `p` between steps. */
  prev: Float32Array;
  quiet: number;
  /** Floating plants: highest a joint may rise (the local surface less the head's sink); else Infinity. */
  ceiling: number;
  /** Contact radius of the stem joints and of the head's joints (world m). */
  nodeR: number;
  headR: number;
  /** Being stepped (in `active`). */
  stepping: boolean;
  /** Heads repelling each other: the head's whole radius (world m; 0 for algae). */
  repelR: number;
  /** The head-grid chunk it is filed in (-1 when not). */
  cell: number;
  /** Other plants' heads near this one (found once per frame for the steps). */
  near: SimChain[];
}

/**
 * Chain plants of one species: each a welded chain mesh shared by every plant of that length and
 * head, drawn instanced per 32 m cell, culled beyond the species' view distance. A plant a body
 * touches becomes a real chain: Verlet joints (one per link and the tip) kept at their link
 * lengths, lifted by buoyancy, slowed by the water, pushed and dragged by the bodies (a floating
 * species also kept under the surface, its head buoyed up and upright). Its joints go to the GPU
 * as one row of a small float texture; algae give the row back once they settle upright, lilies
 * keep theirs with the pose they settled in.
 */
export class ChainField {
  public readonly group = new THREE.Group();
  private readonly cfg: SpeciesConfig;
  private readonly batches = new Map<string, ChainBatch>();
  private readonly recs = new Map<number, ChainRec>();
  private readonly chains: (SimChain | null)[];
  private readonly active: SimChain[] = [];
  private readonly pushers = new Float32Array(MAX_PUSHERS * 5);
  private readonly lastPushers = new Float32Array(MAX_PUSHERS * 5);
  private pusherCount = 0;
  /** A joint held by a fishing hook (grab): pulled towards (x, y, z). */
  private held: { rec: ChainRec; joint: number; x: number; y: number; z: number; pull: number } | null = null;
  /** The held joint where it is DRAWN (link lengths exact, before the current sway), set in upload. */
  private readonly heldDrawn = new THREE.Vector3();
  private heldDrawnOk = false;
  private lastPusherCount = 0;
  /** Unstepped time (s): the chains step at a fixed rate (Verlet needs a steady step). */
  private accumulator = 0;
  /** Water the kept poses were settled for (re-settled when the sea or a river changes). */
  private riverRev = -1;
  private seaLevel = NaN;
  private warnedRows = false;
  /** Kept-row plants waiting to be settled (drawn in their start pose meanwhile). */
  private readonly settling = new Set<ChainRec>();
  /** Floating heads by chunk (HEAD_CELL m), so a head only checks the heads around it. */
  private readonly headGrid = new Map<number, Set<SimChain>>();
  /** Resting plants a moving head bumped this frame (woken after the steps). */
  private readonly toWake = new Set<ChainRec>();
  private static readonly _m = new THREE.Matrix4();
  private static readonly _q = new THREE.Quaternion();
  private static readonly _s = new THREE.Vector3();
  private static readonly _v = new THREE.Vector3();
  private static readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(parent: THREE.Object3D, public readonly species: ChainSpecies) {
    this.cfg = species.cfg;
    this.chains = new Array(this.cfg.rows).fill(null);
    this.group.name = this.cfg.kind === 'algae' ? 'Algae' : 'WaterLilies';
    parent.add(this.group);
    void species.load().then((ok) => {
      if (!ok) return;
      for (const r of this.recs.values()) this.attach(r);
    });
  }

  public add(prop: PropInstance): void {
    const r: ChainRec = { prop, batch: null, slot: -1, height: 0, sim: -1 };
    this.recs.set(prop.id, r);
    this.attach(r);
  }

  public remove(id: number): void {
    const r = this.recs.get(id);
    if (!r) return;
    this.free(r);
    this.detach(r);
    this.recs.delete(id);
  }

  /** The prop's own colours changed (or were cleared back to the panel's). */
  public recolor(prop: PropInstance): void {
    const r = this.recs.get(prop.id);
    if (r?.batch) this.writeColors(r);
  }

  /** The prop moved, turned, scaled, changed length or head. */
  public refresh(prop: PropInstance): void {
    const r = this.recs.get(prop.id);
    if (!r) return;
    // Its joints no longer fit: it starts again from rest
    this.free(r);
    const links = this.species.clampLinks(prop.length);
    const head = this.species.clampHead(prop.head);
    const b = r.batch;
    if (b && b.links === links && b.head === head && b.cx === Math.floor(prop.position.x / CELL) && b.cz === Math.floor(prop.position.z / CELL)) {
      this.writeMatrix(r);
      if (this.cfg.keepRows) this.settle(r);
      return;
    }
    this.detach(r);
    this.attach(r);
  }

  public pick(raycaster: THREE.Raycaster): { id: number; point: THREE.Vector3; distance: number } | null {
    let best: { id: number; point: THREE.Vector3; distance: number } | null = null;
    if (this.cfg.keepRows) {
      // Kept poses are not upright (a lily lies on the water): pick by the drawn head
      const parts = this.species.parts;
      if (!parts) return null;
      const sphere = new THREE.Sphere();
      const hit = ChainField._v;
      for (const r of this.recs.values()) {
        if (!r.batch || !this.drawnHead(r, sphere.center)) continue;
        sphere.radius = parts.headR[r.batch.head] * r.prop.scale;
        if (!raycaster.ray.intersectSphere(sphere, hit)) continue;
        const d = raycaster.ray.origin.distanceTo(hit);
        if (d < raycaster.near || d > raycaster.far) continue;
        if (!best || d < best.distance) best = { id: r.prop.id, point: hit.clone(), distance: d };
      }
      return best;
    }
    for (const b of this.batches.values()) {
      if (!b.mesh.count) continue;
      const h = raycaster.intersectObject(b.mesh, false)[0];
      if (h && h.instanceId !== undefined && (!best || h.distance < best.distance)) {
        best = { id: b.recs[h.instanceId].prop.id, point: h.point.clone(), distance: h.distance };
      }
    }
    return best;
  }

  /** How far (world XZ, y = 0) a plant's head lies from its root now; false when unknown. */
  public headOffset(id: number, out: THREE.Vector3): boolean {
    const r = this.recs.get(id);
    if (!r) return false;
    this.settleNow(r); // where it comes to rest, not its start pose
    if (!this.drawnHead(r, out)) return false;
    out.sub(r.prop.position).setY(0);
    return true;
  }

  /** Where a plant's head base is drawn now (its texture row, else upright); false while it loads. */
  private drawnHead(r: ChainRec, out: THREE.Vector3): boolean {
    const b = r.batch;
    const parts = this.species.parts;
    if (!b || !parts) return false;
    const pp = r.prop.position;
    out.set(pp.x, pp.y + b.links * parts.linkH * r.prop.scale, pp.z);
    if (r.sim >= 0) {
      const o = (r.sim * this.species.width + b.links) * 4;
      const d = this.species.simData;
      out.x += d[o];
      out.y += d[o + 1];
      out.z += d[o + 2];
    }
    return true;
  }

  /**
   * Hooks a stalk: the joint nearest to (x, y, z) within `radius` (m) becomes held, so a line
   * can pull it (setGrabTarget) and read where it really is (grabPoint). The stalk is simulated
   * while held and bends towards the pull, its root staying put. False when no joint is in reach.
   */
  public grab(x: number, y: number, z: number, radius: number, out: THREE.Vector3): boolean {
    this.releaseGrab();
    const parts = this.species.parts;
    let best = radius * radius;
    let hit: ChainRec | null = null;
    let joint = 0;
    for (const r of this.recs.values()) {
      const pp = r.prop.position;
      const hx = pp.x - x, hz = pp.z - z;
      // Cheap reject: the whole stalk is far away
      const reach = radius + r.height;
      if (hx * hx + hz * hz > reach * reach || y < pp.y - radius || y > pp.y + r.height + radius) continue;
      const ch = r.sim >= 0 ? this.chains[r.sim] : null;
      const links = r.batch?.links ?? 0;
      const joints = ch ? ch.joints : links + 2;
      for (let k = 1; k < joints; k++) {
        let jx = pp.x, jy: number, jz = pp.z;
        if (ch) {
          jx = ch.p[k * 3];
          jy = ch.p[k * 3 + 1];
          jz = ch.p[k * 3 + 2];
        } else {
          jy = pp.y + (parts && k <= links ? k * parts.linkH * r.prop.scale : r.height);
        }
        const dx = jx - x, dy = jy - y, dz = jz - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) {
          best = d2;
          hit = r;
          joint = k;
          out.set(jx, jy, jz);
        }
      }
    }
    if (!hit) return false;
    this.wake(hit);
    const ch = hit.sim >= 0 ? this.chains[hit.sim] : null;
    if (!ch || !ch.stepping) return false; // no free simulation slot
    joint = Math.min(joint, ch.joints - 1);
    this.held = { rec: hit, joint, x: out.x, y: out.y, z: out.z, pull: 0 };
    this.heldDrawnOk = false;
    return true;
  }

  /**
   * Where the held joint is pulled to and how hard (0..1 of the way per constraint pass). The
   * links keep their lengths, so the stalk bends and tautens towards it rather than stretching.
   */
  public setGrabTarget(x: number, y: number, z: number, pull: number): void {
    const h = this.held;
    if (!h) return;
    h.x = x;
    h.y = y;
    h.z = z;
    h.pull = THREE.MathUtils.clamp(pull, 0, 1);
  }

  /** The held joint's position now; false once nothing is held (the stalk went away). */
  public grabPoint(out: THREE.Vector3): boolean {
    const h = this.held;
    if (!h || h.rec.sim < 0 || !this.recs.has(h.rec.prop.id)) {
      this.held = null;
      return false;
    }
    const ch = this.chains[h.rec.sim]!;
    if (this.heldDrawnOk) out.copy(this.heldDrawn);
    else {
      const i = h.joint * 3;
      out.set(ch.p[i], ch.p[i + 1], ch.p[i + 2]);
    }
    // Plus the slow current sway the shader adds (same formula), so the point sits on the stalk
    // exactly as it is seen
    const r = h.rec;
    const pp = r.prop.position;
    const t = uAlgTime.value;
    const ph = pp.x * 0.73 + pp.z * 0.41;
    const amp = this.cfg.sway * r.height;
    const e = r.height > 0 ? ch.rest[Math.min(h.joint, ch.joints - 1)] / r.height : 1;
    const e2 = e * e;
    out.x += (Math.sin(t * 0.7 + ph) + 0.25 * Math.sin(t * 1.3 + ph * 2.3)) * amp * e2;
    out.z += Math.cos(t * 0.55 + ph * 1.3) * amp * e2;
    return true;
  }

  /** Lets the held stalk go: it swings back up on its own. */
  public releaseGrab(): void {
    this.held = null;
    this.heldDrawnOk = false;
  }

  public clearPushers(): void {
    this.lastPushers.set(this.pushers);
    this.lastPusherCount = this.pusherCount;
    this.pusherCount = 0;
  }

  /**
   * A body that parts the plants: a vertical capsule from `y` (its bottom) up `height`, `radius`
   * wide. Add the same bodies in the same order every frame: their motion drags the plants along.
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

  /** Per frame (after the pushers): wakes touched plants, steps the chains, culls the cells. */
  public update(dt: number, camera: THREE.Vector3): void {
    if (this.cfg.kind === 'algae') uAlgTime.value += dt; // one clock for every species
    if (!this.recs.size) return;
    if (this.cfg.keepRows) this.checkWater();
    this.wakeTouched();
    if (this.settling.size) this.settleQueued();
    if (this.cfg.rigidHead) this.feedHeadShader();
    if (this.active.length) {
      this.accumulator = Math.min(this.accumulator + dt, SUBSTEP * 4);
      const steps = Math.floor(this.accumulator / SUBSTEP);
      this.accumulator -= steps * SUBSTEP;
      // The heads near each moving one, once for this frame's steps
      for (let c = 0; c < this.active.length; c++) this.findNear(this.active[c]);
      for (let i = 0; i < steps; i++) {
        for (let c = 0; c < this.active.length; c++) {
          const ch = this.active[c];
          ch.prev.set(ch.p);
          this.step(ch, SUBSTEP, 1 / steps, true);
        }
      }
      for (let c = 0; c < this.active.length; c++) this.fileHead(this.active[c]);
      // Resting neighbours a moving head bumped into move their half too
      if (this.toWake.size) {
        for (const r of this.toWake) this.wake(r);
        this.toWake.clear();
      }
      // Drawn between the last two steps, so the motion is smooth at any frame rate (a frame
      // gets 0, 1 or 2 fixed steps)
      const alpha = this.accumulator / SUBSTEP;
      for (let c = this.active.length - 1; c >= 0; c--) {
        const ch = this.active[c];
        this.upload(ch, alpha);
        ch.quiet += dt;
        if (ch.quiet > SLEEP_AFTER && this.held?.rec !== ch.rec && this.atRest(ch)) this.sleep(ch);
      }
    }

    const view = this.cfg.viewDist;
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
      b.mesh.visible = b.recs.length > 0 && dx * dx + dz * dz + dy * dy < view * view;
    }
  }

  /** The sea or a river changed height: the floating plants settle anew on the new surface. */
  private checkWater(): void {
    const sea = worldSettings.waterLevel;
    if (riverWorld.revision === this.riverRev && sea === this.seaLevel) return;
    this.riverRev = riverWorld.revision;
    this.seaLevel = sea;
    // Only the plants whose surface really moved
    for (const r of this.recs.values()) {
      if (!r.batch || r.sim < 0) continue;
      const ch = this.chains[r.sim];
      const now = this.ceilingFor(r);
      if (ch && Math.abs(now - ch.ceiling) < 0.01) continue;
      this.settle(r);
    }
  }

  /** Starts simulating the plants a pusher touches (only the pushers' cells are scanned). */
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
          const ch = r.sim >= 0 ? this.chains[r.sim] : null;
          if (ch?.stepping) continue;
          const pp = r.prop.position;
          if (ch) {
            // A kept pose: any joint inside the body (the head counts with its whole width)
            if (this.touchesPose(ch, px, py0, py1, pz, pr)) this.wake(r);
            continue;
          }
          // A resting stalk stands straight (give or take its sway): only a body on that line wakes it
          const near = pr + NODE_RADIUS * r.prop.scale + r.height * 0.1;
          const dx = pp.x - px;
          const dz = pp.z - pz;
          if (dx * dx + dz * dz > near * near) continue;
          if (py0 > pp.y + r.height + pr || py1 < pp.y - pr) continue;
          this.wake(r);
        }
      }
    }
  }

  private touchesPose(ch: SimChain, px: number, py0: number, py1: number, pz: number, pr: number): boolean {
    const { p, joints } = ch;
    const base = joints - 2;
    for (let k = 1; k < joints; k++) {
      const i = k * 3;
      const R = pr + (k >= base ? ch.headR : ch.nodeR) + 0.05;
      const cy = Math.min(Math.max(p[i + 1], py0), py1);
      const dx = p[i] - px;
      const dy = p[i + 1] - cy;
      const dz = p[i + 2] - pz;
      if (dx * dx + dy * dy + dz * dz < R * R) return true;
    }
    return false;
  }

  /** The surface a floating plant's joints stay under (Infinity for algae or on dry ground). */
  private ceilingFor(r: ChainRec): number {
    if (!this.cfg.floats) return Infinity;
    const pp = r.prop.position;
    const w = riverWorld.waterLevelAt(pp.x, pp.z) - FLOAT_SINK * r.prop.scale;
    return w > pp.y + 0.05 ? w : Infinity;
  }

  /**
   * A fresh chain for a plant: upright, or for a floating plant whose stem is longer than the
   * water is deep, up to the surface and then along it (the way its yaw faces) with the head flat
   * on top; the physics then curls it into a natural arc.
   */
  private makeChain(r: ChainRec): SimChain {
    const b = r.batch!;
    const parts = this.species.parts!;
    const links = b.links;
    const joints = links + 2;
    const s = r.prop.scale;
    const rest = new Float32Array(joints);
    for (let k = 0; k < joints; k++) rest[k] = k <= links ? k * parts.linkH * s : r.height;
    const ceiling = this.ceilingFor(r);
    const pp = r.prop.position;
    const depth = ceiling - pp.y;
    const hx = Math.cos(r.prop.rotationY);
    const hz = -Math.sin(r.prop.rotationY);
    const p = new Float32Array(joints * 3);
    for (let k = 0; k < joints; k++) {
      let l = rest[k];
      if (this.cfg.rigidHead && k === joints - 1) {
        // The tip right above the head's base
        p[k * 3] = p[(k - 1) * 3];
        p[k * 3 + 1] = p[(k - 1) * 3 + 1] + (rest[k] - rest[k - 1]);
        p[k * 3 + 2] = p[(k - 1) * 3 + 2];
        continue;
      }
      const along = Math.max(0, l - depth);
      l = Math.min(l, depth);
      p[k * 3] = pp.x + hx * along;
      p[k * 3 + 1] = pp.y + l;
      p[k * 3 + 2] = pp.z + hz * along;
    }
    const nodeR = NODE_RADIUS * s;
    const headR = this.cfg.rigidHead ? parts.headR[b.head] * s : nodeR;
    return {
      rec: r, joints, rest, p, q: p.slice(), prev: p.slice(), quiet: 0, ceiling, nodeR, headR, stepping: false,
      repelR: this.cfg.rigidHead ? headR : 0, cell: -1, near: [],
    };
  }

  /** Starts stepping a plant (gives it a row first when it has none). */
  private wake(r: ChainRec): void {
    if (!r.batch || !this.species.parts) return;
    if (this.active.length >= MAX_ACTIVE) return; // every slot busy: it stays as it is
    let ch = r.sim >= 0 ? this.chains[r.sim] : null;
    if (!ch) {
      if (this.cfg.keepRows) return; // no row to draw it with (warned at placing)
      const row = this.chains.indexOf(null);
      if (row < 0) return;
      ch = this.makeChain(r);
      this.chains[row] = ch;
      r.sim = row;
      r.batch.row.setX(r.slot, row + 1);
      r.batch.dirty = true;
    }
    if (ch.stepping) return;
    // Touched before it settled: the live physics takes it from here
    this.settling.delete(r);
    ch.stepping = true;
    ch.quiet = 0;
    ch.prev.set(ch.p);
    this.active.push(ch);
  }

  /** Stops stepping a settled plant: algae go back to the shader's rest pose, lilies keep theirs. */
  private sleep(ch: SimChain): void {
    if (!this.cfg.keepRows) {
      this.free(ch.rec);
      return;
    }
    this.unstep(ch);
    // Drawn exactly where it came to rest
    ch.prev.set(ch.p);
    ch.q.set(ch.p);
    this.upload(ch, 1);
  }

  private unstep(ch: SimChain): void {
    if (!ch.stepping) return;
    ch.stepping = false;
    const i = this.active.indexOf(ch);
    if (i >= 0) {
      this.active[i] = this.active[this.active.length - 1];
      this.active.pop();
    }
  }

  /** Takes a plant's row away: it is drawn upright from the shader's rest pose. */
  private free(r: ChainRec): void {
    this.settling.delete(r);
    if (r.sim < 0) return;
    if (this.held?.rec === r) this.held = null;
    const ch = this.chains[r.sim];
    if (ch) {
      this.unstep(ch);
      this.unfileHead(ch);
    }
    this.chains[r.sim] = null;
    const mj = this.species.width;
    this.species.simData.fill(0, r.sim * mj * 4, (r.sim + 1) * mj * 4);
    this.species.markRow(r.sim);
    r.sim = -1;
    if (r.batch) {
      r.batch.row.setX(r.slot, 0);
      r.batch.dirty = true;
    }
  }

  /**
   * Kept-row species: poses a plant once where it comes to rest in still water (stepped a few
   * seconds with no bodies around), so it is drawn floating / bent from the start and only needs
   * simulating again when something touches it.
   */
  private settle(r: ChainRec): void {
    if (!r.batch || !this.species.parts) return;
    let row = r.sim;
    if (row >= 0) {
      const old = this.chains[row];
      if (old) {
        this.unstep(old);
        this.unfileHead(old);
      }
    } else {
      row = this.chains.indexOf(null);
      if (row < 0) {
        if (!this.warnedRows) console.warn(`[Chains] more than ${this.cfg.rows} ${this.cfg.kind} plants: the rest are drawn upright`);
        this.warnedRows = true;
        return;
      }
    }
    const ch = this.makeChain(r);
    this.chains[row] = ch;
    r.sim = row;
    // Drawn at once in its start pose (up to the surface, the head flat on it: nothing pokes out),
    // then settled from a queue a few plants per frame, so a world full of lilies loads without
    // a hitch
    this.upload(ch, 1);
    this.fileHead(ch);
    r.batch.row.setX(r.slot, row + 1);
    r.batch.dirty = true;
    this.settling.add(r);
  }

  // ---------------------------------------------------------------- heads apart (chunks)

  private static headKey(x: number, z: number): number {
    return (Math.floor(x / HEAD_CELL) + 32768) * 65536 + (Math.floor(z / HEAD_CELL) + 32768);
  }

  /** Files a head in the chunk its base lies in (moved on when it drifts into another). */
  private fileHead(ch: SimChain): void {
    if (!ch.repelR) return;
    const bi = (ch.joints - 2) * 3;
    const key = ChainField.headKey(ch.p[bi], ch.p[bi + 2]);
    if (ch.cell === key) return;
    this.unfileHead(ch);
    let set = this.headGrid.get(key);
    if (!set) this.headGrid.set(key, (set = new Set()));
    set.add(ch);
    ch.cell = key;
  }

  private unfileHead(ch: SimChain): void {
    if (ch.cell < 0) return;
    const set = this.headGrid.get(ch.cell);
    if (set) {
      set.delete(ch);
      if (!set.size) this.headGrid.delete(ch.cell);
    }
    ch.cell = -1;
  }

  /** The heads that may touch this one: from its chunk and the eight around it only. */
  private findNear(ch: SimChain): void {
    ch.near.length = 0;
    if (!ch.repelR) return;
    const bi = (ch.joints - 2) * 3;
    const x = ch.p[bi];
    const z = ch.p[bi + 2];
    const cx = Math.floor(x / HEAD_CELL);
    const cz = Math.floor(z / HEAD_CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const set = this.headGrid.get((cx + dx + 32768) * 65536 + (cz + dz + 32768));
        if (!set) continue;
        for (const o of set) {
          if (o === ch) continue;
          const oi = (o.joints - 2) * 3;
          const R = ch.repelR + o.repelR + 0.5;
          const ex = o.p[oi] - x;
          const ez = o.p[oi + 2] - z;
          if (ex * ex + ez * ez < R * R) ch.near.push(o);
        }
      }
    }
  }

  /** Passes the bodies to the head shader (leaf edges and petals bend away from them). */
  private feedHeadShader(): void {
    const sp = this.species;
    const n = Math.min(this.pusherCount, MAX_SHADER_PUSHERS);
    for (let i = 0; i < n; i++) {
      const o = i * 5;
      sp.uPush.value[i].set(this.pushers[o], this.pushers[o + 2], this.pushers[o + 3], this.pushers[o + 1]);
      sp.uPushH.value[i] = this.pushers[o + 4];
    }
    sp.uPushCount.value = n;
  }

  /** Settles a queued plant now: stepped until it comes to rest, at most a few seconds' worth. */
  private settleNow(r: ChainRec): void {
    if (!this.settling.delete(r) || r.sim < 0) return;
    const ch = this.chains[r.sim];
    if (!ch || ch.stepping) return;
    // Kept off the heads already there (they stay put: only this one moves)
    this.findNear(ch);
    for (let i = 1; i <= SETTLE_STEPS; i++) {
      this.step(ch, SETTLE_DT, 1, false);
      if (i >= SETTLE_MIN && i % 10 === 0 && this.atRest(ch, REST_SPEED * 3)) break;
    }
    ch.q.set(ch.p);
    ch.prev.set(ch.p);
    this.upload(ch, 1);
    this.fileHead(ch);
    // Settled one at a time, crowded heads may still overlap where their neighbours moved since:
    // the live physics sorts them out (they drift apart, then sleep)
    if (ch.repelR) {
      this.findNear(ch);
      const bi = (ch.joints - 2) * 3;
      for (const o of ch.near) {
        const oi = (o.joints - 2) * 3;
        const d = Math.hypot(ch.p[bi] - o.p[oi], ch.p[bi + 2] - o.p[oi + 2]);
        if (ch.repelR + o.repelR - d > HEAD_WAKE_OVERLAP) {
          this.wake(r);
          this.wake(o.rec);
        }
      }
    }
  }

  /** Works through the settle queue for up to SETTLE_BUDGET_MS. */
  private settleQueued(): void {
    const t0 = performance.now();
    for (const r of this.settling) {
      this.settleNow(r);
      if (performance.now() - t0 > SETTLE_BUDGET_MS) break;
    }
  }

  /**
   * One Verlet step: inertia with water drag and buoyancy; then the link lengths, straightening and
   * the bodies (pushed out of their capsules and dragged along by their motion), a few times over.
   * `share` is this step's part of the frame (the bodies' frame motion is spread over the steps).
   * Floating plants also stay under the surface, their head upright on its base.
   */
  private step(ch: SimChain, h: number, share: number, bodies: boolean): void {
    const { p, q, rest, joints } = ch;
    const cfg = this.cfg;
    const root = ch.rec.prop.position;
    const keep = Math.exp(-cfg.drag * h);
    const lift = cfg.buoyancy * h * h;
    const base = joints - 2;
    const ceiling = ch.ceiling;
    for (let k = 1; k < joints; k++) {
      const i = k * 3;
      const vx = (p[i] - q[i]) * keep;
      const vy = (p[i + 1] - q[i + 1]) * keep;
      const vz = (p[i + 2] - q[i + 2]) * keep;
      q[i] = p[i];
      q[i + 1] = p[i + 1];
      q[i + 2] = p[i + 2];
      p[i] += vx;
      p[i + 1] += vy + (cfg.floats && k >= base ? lift * HEAD_LIFT : lift);
      p[i + 2] += vz;
    }
    const pushers = bodies ? this.pusherCount : 0;
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
        // A head lines up with the stem only loosely (it tilts on the water)
        const fix = ((d - len) / d) * cfg.stiffness * (cfg.rigidHead && k === joints - 1 ? HEAD_FOLLOW : 1);
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
      for (let n = 0; n < pushers; n++) {
        const o = n * 5;
        const px = this.pushers[o];
        const py0 = this.pushers[o + 1];
        const pz = this.pushers[o + 2];
        const pr = this.pushers[o + 3];
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
          const R = pr + (k >= base ? ch.headR : ch.nodeR);
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
            // the plant a bit of its way
            q[i] += (p[i] - q[i]) * CONTACT_DAMP;
            q[i + 1] += (p[i + 1] - q[i + 1]) * CONTACT_DAMP;
            q[i + 2] += (p[i + 2] - q[i + 2]) * CONTACT_DAMP;
            p[i] += mx * FRICTION;
            p[i + 1] += my * FRICTION;
            p[i + 2] += mz * FRICTION;
          }
        }
      }
      // Other heads: pushed apart (each plant moves its own half; a resting neighbour is woken
      // to move its half too)
      if (ch.near.length) {
        const bi = base * 3;
        for (const o of ch.near) {
          const oi = (o.joints - 2) * 3;
          const dx = p[bi] - o.p[oi];
          const dz = p[bi + 2] - o.p[oi + 2];
          const R = ch.repelR + o.repelR;
          const d2 = dx * dx + dz * dz;
          if (d2 >= R * R || Math.abs(p[bi + 1] - o.p[oi + 1]) > R) continue;
          const d = Math.sqrt(d2) || 1e-4;
          const push = ((R - d) * HEAD_REPEL * 0.5) / d;
          const ux = d2 > 1e-8 ? dx * push : push;
          const uz = d2 > 1e-8 ? dz * push : 0;
          // The whole head moves (base and tip)
          p[bi] += ux;
          p[bi + 2] += uz;
          p[bi + 3] += ux;
          p[bi + 5] += uz;
          // Not a "touch": crowded heads rest pressed together once they stop moving (only the
          // speed decides when they sleep). A resting neighbour wakes only for a real overlap.
          if (bodies && !o.stepping && R - d > HEAD_WAKE_OVERLAP) this.toWake.add(o.rec);
        }
      }
      // A hook holding a joint pulls it (soft, so the links below win and the stalk bends)
      const held = this.held;
      if (bodies && held && held.rec === ch.rec && held.pull > 0) {
        const i = held.joint * 3;
        p[i] += (held.x - p[i]) * held.pull;
        p[i + 1] += (held.y - p[i + 1]) * held.pull;
        p[i + 2] += (held.z - p[i + 2]) * held.pull;
        touched = true;
      }
      // A rigid head rights itself: its tip back above its base, both ends sharing the fix (one
      // sided it would push the whole plant round and round)
      if (cfg.rigidHead) {
        const a = base * 3;
        const c = a + 3;
        const len = rest[base + 1] - rest[base];
        const k = (p[a + 1] >= ceiling - 0.01 ? HEAD_UPRIGHT_FLOAT : HEAD_UPRIGHT) * 0.5;
        const ex = (p[a] - p[c]) * k;
        const ey = (p[a + 1] + len - p[c + 1]) * k;
        const ez = (p[a + 2] - p[c + 2]) * k;
        p[c] += ex;
        p[c + 1] += ey;
        p[c + 2] += ez;
        p[a] -= ex;
        p[a + 1] -= ey;
        p[a + 2] -= ez;
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
      // Never through the bottom, and a floating plant never out of the water (its head's base
      // rides right at the surface; the tip stands above it)
      const tipTop = ceiling + (rest[joints - 1] - rest[base]);
      for (let k = 1; k < joints; k++) {
        const i = k * 3 + 1;
        p[i] = Math.max(p[i], root.y + 0.03);
        if (k <= base && p[i] > ceiling) p[i] = ceiling;
        else if (k > base && cfg.floats && p[i] > tipTop) p[i] = tipTop;
      }
    }
    if (touched) ch.quiet = 0;
  }

  /** Settled: back upright (algae) or simply still (a kept pose), and barely moving. */
  private atRest(ch: SimChain, speed = REST_SPEED): boolean {
    const v2 = speed * speed;
    const { p, q, joints } = ch;
    const root = ch.rec.prop.position;
    const upright = !this.cfg.keepRows;
    for (let k = 1; k < joints; k++) {
      const i = k * 3;
      if (upright) {
        // Sideways only: buoyancy keeps the links a little stretched (the drawn chain is not)
        const ox = p[i] - root.x;
        const oz = p[i + 2] - root.z;
        if (ox * ox + oz * oz > 0.005 * 0.005) return false;
      }
      const vx = p[i] - q[i];
      const vy = p[i + 1] - q[i + 1];
      const vz = p[i + 2] - q[i + 2];
      if (vx * vx + vy * vy + vz * vz > v2) return false;
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
    const simData = this.species.simData;
    const root = ch.rec.prop.position;
    const base = ch.rec.sim * this.species.width * 4;
    simData[base] = simData[base + 1] = simData[base + 2] = 0;
    const heldJoint = this.held?.rec === ch.rec ? this.held.joint : -1;
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
      if (k === heldJoint) {
        this.heldDrawn.set(ax, ay, az);
        this.heldDrawnOk = true;
      }
      const o = base + k * 4;
      simData[o] = ax - root.x;
      simData[o + 1] = ay - root.y - rest[k];
      simData[o + 2] = az - root.z;
    }
    this.species.markRow(ch.rec.sim);
  }

  private attach(r: ChainRec): void {
    const sp = this.species;
    const links = sp.clampLinks(r.prop.length);
    const head = sp.clampHead(r.prop.head);
    const geometry = sp.geometry(links, head);
    if (!geometry) return; // the model is still loading: attached once it arrives
    r.height = geometry.boundingBox!.max.y * r.prop.scale;
    const cx = Math.floor(r.prop.position.x / CELL);
    const cz = Math.floor(r.prop.position.z / CELL);
    const key = `${links}|${head}|${cx}|${cz}`;
    let b = this.batches.get(key);
    if (!b) {
      b = this.makeBatch(geometry, links, head, cx, cz, 16);
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
    if (this.cfg.keepRows) this.settle(r);
  }

  private detach(r: ChainRec): void {
    const b = r.batch;
    if (!b) return;
    const last = b.recs.length - 1;
    if (r.slot !== last) {
      const moved = b.recs[last];
      b.recs[r.slot] = moved;
      moved.slot = r.slot;
      b.mesh.getMatrixAt(last, ChainField._m);
      b.mesh.setMatrixAt(r.slot, ChainField._m);
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
  private writeColors(r: ChainRec): void {
    const b = r.batch!;
    const a = b.cols.array as Float32Array;
    const o = r.slot * 8;
    const own = r.prop.colors;
    if (own) {
      ChainField._c.setHex(own[0]).toArray(a, o);
      a[o + 3] = 1;
      ChainField._c.setHex(own[1]).toArray(a, o + 4);
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

  private makeBatch(geometry: THREE.BufferGeometry, links: number, head: number, cx: number, cz: number, cap: number): ChainBatch {
    const mesh = new THREE.InstancedMesh(geometry, [this.species.material], cap);
    mesh.count = 0;
    mesh.name = `${this.group.name}_${links}_${head}_${cx}_${cz}`;
    const row = this.makeRowAttribute(cap);
    // Every cell of this length shares the plant's buffers; only the row buffer is the mesh's own
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
    return { links, head, cx, cz, mesh, row, cols, recs: [], dirty: false, minY: Infinity, maxY: -Infinity };
  }

  private grow(b: ChainBatch): void {
    const old = b.mesh;
    const cap = old.instanceMatrix.count * 2;
    const mesh = new THREE.InstancedMesh(old.geometry, old.material, cap);
    mesh.name = old.name;
    mesh.visible = old.visible;
    for (let i = 0; i < old.count; i++) {
      old.getMatrixAt(i, ChainField._m);
      mesh.setMatrixAt(i, ChainField._m);
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

  private writeMatrix(r: ChainRec): void {
    const b = r.batch;
    if (!b) return;
    const p = r.prop;
    ChainField._q.setFromAxisAngle(ChainField._up, p.rotationY);
    ChainField._s.setScalar(p.scale);
    ChainField._m.compose(p.position, ChainField._q, ChainField._s);
    b.mesh.setMatrixAt(r.slot, ChainField._m);
    b.mesh.instanceMatrix.needsUpdate = true;
    r.height = (b.mesh.geometry.boundingBox?.max.y ?? 1) * p.scale;
    // Cell bounds for culling and picking: the cell, the plants' heights and how far they lean
    // (a lily's head may lie a whole stem away from its root)
    b.minY = Math.min(b.minY, p.position.y);
    b.maxY = Math.max(b.maxY, p.position.y + r.height);
    const midY = (b.minY + b.maxY) / 2;
    const half = (b.maxY - b.minY) / 2;
    let lean = 0;
    for (const o of b.recs) lean = Math.max(lean, o.height + (this.species.parts?.headR[b.head] ?? 0) * o.prop.scale);
    b.mesh.boundingSphere = new THREE.Sphere(
      new THREE.Vector3((b.cx + 0.5) * CELL, midY, (b.cz + 0.5) * CELL),
      Math.hypot(CELL * 0.7072 + lean, half)
    );
  }
}

/** The algae field (the fishing hook snags on it). */
export type AlgaeField = ChainField;
