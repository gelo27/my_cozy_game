/**
 * Island-wide cave network generator. Pure maths with no three.js, so it runs in a Web Worker
 * (caveWorker.ts) and the field sampling never blocks a frame.
 *
 * Two stages:
 *
 * 1. Layout (`CaveLayout`, plain JSON, editable in the developer editor and saved to caves.json):
 *    chambers ("hubs"), tunnels between them, three biome centres and every item (chests, ore,
 *    crystals, mushrooms, ember vents, lights, stalactites, stalagmites, pillars, drips). A fresh
 *    layout is planned procedurally: ~18 chambers spread under the island (Poisson disk), a minimum
 *    spanning tree of tunnels plus loop tunnels; only loops get one-way features (a 2.6 m drop, a
 *    fully flooded sump), so there is always a way back.
 *
 * 2. Build: the layout becomes a signed distance field (negative = air): tapered capsules along each
 *    tunnel with a floor profile (ramps, stairs, cliffs, flooded dips), ellipsoid chambers, lake
 *    basins, rock added back (gallery shelves, ramps, pillars). Smooth union blends it; 3D value noise
 *    roughens the walls. Meshing is Surface Nets per 12.8 m chunk; water is a flood fill from each
 *    pool's seed, its surface clipped to the rock. A rebuild can be limited to the chunks a layout
 *    edit touched (`dirty` boxes), which keeps editing live.
 *
 * Every entrance on the island opens into the same network: walk in at one mouth, out at another.
 * An underwater entrance (on the sea bed) leads through a flooded tunnel up into a lake chamber.
 */

export type Vec3 = [number, number, number];
export type OreKind = 'iron' | 'copper' | 'gold' | 'crystal';

export interface CaveEntranceIn {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Direction the surface mouth faces (out of the hill / out to sea), atan2(x, z). */
  yaw: number;
  /** On the sea bed: the way in is a flooded tunnel that rises into a lake. */
  underwater?: boolean;
}

export interface CaveGenInput {
  seed: number;
  entrances: CaveEntranceIn[];
  /** Coast radius per degree (360 values): the network stays under dry land. */
  coast: Float32Array;
}

// ------------------------------------------------------------------ layout (editable JSON)

export type HubKind = 'chamber' | 'grand' | 'lake';
export type TunnelKind = 'ramp' | 'stairs' | 'drop' | 'sump' | 'flood';
export type ItemType = 'chest' | 'ore' | 'crystal' | 'mushroom' | 'ember' | 'light' | 'stalactite' | 'stalagmite' | 'pillar' | 'drip';

export interface LayoutHub {
  id: string;
  x: number;
  z: number;
  /** Floor height (cave-local y). */
  floor: number;
  rx: number;
  ry: number;
  rz: number;
  rot: number;
  kind: HubKind;
  /** Grand hall: the gallery shelf faces this tunnel (which arrives up on it). */
  shelf?: string | null;
  /** Water surface height: a basin and a lake (lake halls default to just below the floor). */
  water?: number | null;
  /** The porch chamber of this surface entrance. */
  entrance?: string;
}

export interface LayoutTunnel {
  id: string;
  a: string;
  b: string;
  kind: TunnelKind;
  radius: number;
  /** Sideways wiggle amplitude (m), its waves and phase, and the floor wobble phase. */
  wig: number;
  k: number;
  ph: number;
  phase: number;
  /** Loop tunnel (not in the spanning tree): may hold one-way features. */
  loop?: boolean;
}

export interface LayoutItem {
  id: number;
  t: ItemType;
  x: number;
  y: number;
  z: number;
  /** The chamber it belongs to (moves with it in the editor). */
  hub?: string;
  /** Chest: which loot table ('cave1'..). */
  chest?: string;
  yaw?: number;
  ore?: OreKind;
  /** Crystal: CRYSTAL_COLORS index. */
  color?: number;
  size?: number;
  /** Cones: length and base radius; stalactite tips bend by (bx, bz) per metre; pillar radius. */
  len?: number;
  r?: number;
  bx?: number;
  bz?: number;
  /** Stalactite: water drips from its tip. */
  drip?: boolean;
  /** Mushroom patches: whether this cluster carries the patch's glow. */
  glow?: boolean;
  /** Light items. */
  rgb?: Vec3;
  range?: number;
  intensity?: number;
  flicker?: boolean;
}

export interface CaveLayout {
  version: 1;
  seed: number;
  /** Biome centres (cave-local x/z): moss grotto, flooded crystal caverns, ember depths. */
  biomes: { x: number; z: number }[];
  hubs: LayoutHub[];
  tunnels: LayoutTunnel[];
  items: LayoutItem[];
  nextItem: number;
}

export interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface CaveGenRequest extends CaveGenInput {
  /** Build this layout instead of planning a fresh one. */
  layout?: CaveLayout | null;
  /** Only re-mesh chunks touching these boxes (null: everything). */
  dirty?: Box[] | null;
}

// ------------------------------------------------------------------ output

export interface CaveChunk {
  /** Grid key of the chunk (stable between rebuilds). */
  key: number;
  /** Bounding sphere centre and radius (cave-local). */
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  positions: Float32Array;
  normals: Float32Array;
  /** RGB = biome weights (moss, crystal, ember), A = ambient occlusion. */
  data: Uint8Array;
  /** 0 = dry; otherwise depth below the nearest water surface (see WET_*). */
  wet: Uint8Array;
  indices: Uint16Array;
  /** The first N indices are rock and stalagmites (collide); the rest are stalactites (render only). */
  colliderIndexCount: number;
}

/** Still water: a level and a mask of the columns it fills (`cell` m squares). */
export interface CavePool {
  level: number;
  minX: number;
  minZ: number;
  minY: number;
  cell: number;
  w: number;
  h: number;
  mask: Uint8Array;
}

export interface CaveLight {
  x: number;
  y: number;
  z: number;
  range: number;
  halo: number;
  intensity: number;
  color?: Vec3;
  flicker?: boolean;
}

export interface CaveEntranceOut {
  id: string;
  /** Inner end of the tunnel, where the way out is (feet height). */
  mouth: Vec3;
  spawn: Vec3;
  /** Facing into the cave. */
  yaw: number;
  /** Centre of the daylight disc on the end wall. */
  glow: Vec3;
  torches: Vec3[];
  underwater: boolean;
}

export interface CaveGenOutput {
  layout: CaveLayout;
  /** Chunk keys that were re-meshed (their old meshes go); null after a full build. */
  remeshed: number[] | null;
  chunks: CaveChunk[];
  pools: CavePool[];
  /** Water surfaces, non-indexed triangles (xyz), and the biome weights at each vertex (rgb). */
  water: Float32Array;
  waterBiome: Uint8Array;
  entrances: CaveEntranceOut[];
  chests: { id: string; pos: Vec3; yaw: number }[];
  ores: { pos: Vec3; kind: OreKind }[];
  mushrooms: Vec3[];
  crystals: { pos: Vec3; color: number; size: number }[];
  embers: Vec3[];
  /** Dripping tips: x, y, z, landing y, 1 if it lands in water (5 floats each). */
  drips: Float32Array;
  lights: CaveLight[];
  stats: { ms: number; meshMs: number; sampled: number; chunks: number; triangles: number; hubs: number; tunnels: number; pools: number };
}

// ------------------------------------------------------------------ constants

const CELL = 0.8;
const C = 16; // cells per chunk side
const S = C + 4; // samples per chunk side (2 before, 2 after for gradients)
const G0X = -244;
const G0Y = -72;
const G0Z = -244;
const NPX = 611;
const NPY = 135;
const NPZ = 611;
const SMOOTH_K = 1.5;
/** Field values beyond this are deep rock: noise cannot flip their sign, so it is skipped. */
const FAR = 3.2;
const SHELF_H = 4;
const FLOOR_STEPS = 24;
/**
 * A chunk is solid when every coarse point (3.8 m apart) is farther than this from air: the field
 * changes by at most ~1.5 per metre, noise adds 1.7, the smooth union 0.4.
 */
const COARSE_SKIP = 7.6;
/** Surface Nets cube: corner offsets and the 12 edges. */
const CX = [0, 1, 0, 1, 0, 1, 0, 1];
const CY = [0, 0, 1, 1, 0, 0, 1, 1];
const CZ = [0, 0, 0, 0, 1, 1, 1, 1];
const OFF = CX.map((x, c) => x + CY[c] * S + CZ[c] * S * S);
const EDGE_A = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3];
const EDGE_B = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];
const AO_DIST = [0.6, 1.4, 2.8];
const AO_W = [0.5, 0.3, 0.2];
/** Water grid (flood fill and surface), m. */
const WCELL = 0.5;
/** The surface reaches this far into the rock (field units) so no gap shows along the walls. */
const WATER_EDGE = 0.2;
/** Wet attribute: value = 1 + (depth + WET_ABOVE) / WET_RANGE * 254. */
export const WET_ABOVE = 0.7;
export const WET_RANGE = 12;

/** Crystal colours (index into this from CaveGenOutput.crystals). */
export const CRYSTAL_COLORS: Vec3[] = [
  [0.35, 0.62, 1.0], // blue
  [0.72, 0.42, 1.0], // violet
  [0.3, 0.95, 0.72], // teal (moss caves)
  [1.0, 0.62, 0.25], // amber (ember caves)
];

export function chunkKey(ci: number, cj: number, ck: number): number {
  return (ck * 64 + cj) * 64 + ci;
}

// ------------------------------------------------------------------ noise & rng

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const a = hash3(ix, iy, iz), b = hash3(ix + 1, iy, iz);
  const c = hash3(ix, iy + 1, iz), d = hash3(ix + 1, iy + 1, iz);
  const e = hash3(ix, iy, iz + 1), f = hash3(ix + 1, iy, iz + 1);
  const g = hash3(ix, iy + 1, iz + 1), h = hash3(ix + 1, iy + 1, iz + 1);
  const x1 = a + (b - a) * fx, x2 = c + (d - c) * fx, x3 = e + (f - e) * fx, x4 = g + (h - g) * fx;
  const y1 = x1 + (x2 - x1) * fy, y2 = x3 + (x4 - x3) * fy;
  return (y1 + (y2 - y1) * fz) * 2 - 1;
}

function noise2(x: number, z: number): number {
  return noise3(x, 0.5, z);
}

function rockNoise(x: number, y: number, z: number): number {
  return (
    noise3(x * 0.11, y * 0.16, z * 0.11) * 0.6 +
    noise3(x * 0.33 + 5.2, y * 0.45, z * 0.33) * 0.45 +
    noise3(x * 0.95, y * 1.1, z * 0.95 + 3.1) * 0.18
  );
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
const r2 = (v: number) => Math.round(v * 100) / 100;

// ------------------------------------------------------------------ biomes

/** Biome centres of the layout being built (set before any field or weight query). */
let gBiomes: { x: number; z: number }[] = [];

/** Weights of the three biomes (moss, crystal, ember) at a point; they blend over ~40 m. */
export function biomeWeights(x: number, z: number, out: Float32Array, biomes = gBiomes): Float32Array {
  const wx = x + noise2(x * 0.011 + 7, z * 0.011) * 45;
  const wz = z + noise2(x * 0.011, z * 0.011 - 3) * 45;
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const b = biomes[i];
    const dx = wx - b.x, dz = wz - b.z;
    const d2 = (dx * dx + dz * dz) / (100 * 100);
    const w = Math.exp(-d2 * 2.2);
    out[i] = w;
    sum += w;
  }
  for (let i = 0; i < 3; i++) out[i] /= sum || 1;
  return out;
}

const _bw = new Float32Array(3);
function dominantBiome(x: number, z: number): number {
  biomeWeights(x, z, _bw);
  return _bw[0] >= _bw[1] && _bw[0] >= _bw[2] ? 0 : _bw[1] >= _bw[2] ? 1 : 2;
}

// ------------------------------------------------------------------ primitives

/** Set by the last air primitive evaluated: how much the floor (not the wall) decides it (0..1). */
let gFloorW = 0;

interface AirPrim extends Box {
  amp: number;
  stamp: number;
  /** Creation order: the smooth union is order dependent, so every query sorts by it. */
  uid: number;
  d(x: number, y: number, z: number): number;
}

interface RockPrim extends Box {
  stamp: number;
  uid: number;
  d(x: number, y: number, z: number): number;
}

/** Floor height along a tunnel, t = 0..1 from end A to end B. */
class Profile {
  public steps = 1;
  public readonly drop = 2.6;
  /** Flooded dip: depth and where along the tunnel it lies. */
  public dip = 0;
  public w0 = 0;
  public w1 = 0;
  constructor(public kind: TunnelKind, public ya: number, public yb: number, public len: number, private readonly phase: number) {
    if (kind === 'stairs') this.steps = Math.max(2, Math.ceil(Math.abs(yb - ya) / 0.45));
    if (kind === 'sump') {
      this.dip = 6.5;
      this.w0 = 0.3;
      this.w1 = 0.7;
    } else if (kind === 'flood') {
      this.dip = 2.3;
      this.w0 = 0.2;
      this.w1 = 0.8;
    }
  }

  public at(t: number): number {
    const { ya, yb } = this;
    switch (this.kind) {
      case 'stairs': {
        const u = t * this.steps;
        const k = Math.min(this.steps - 1, Math.floor(u));
        const rise = smooth01((u - k - 0.7) / 0.3);
        return ya + ((yb - ya) * (k + rise)) / this.steps;
      }
      case 'drop':
        // The cliff faces downhill: walk the high half, fall to the low one
        if (ya >= yb) return t <= 0.5 ? ya + (yb + this.drop - ya) * (t / 0.5) : yb;
        return t <= 0.5 ? ya : ya + this.drop + (yb - ya - this.drop) * ((t - 0.5) / 0.5);
      case 'sump':
      case 'flood': {
        let y = ya + (yb - ya) * t;
        if (t > this.w0 && t < this.w1) {
          const s = Math.sin((Math.PI * (t - this.w0)) / (this.w1 - this.w0));
          y -= this.dip * s * s;
        }
        return y;
      }
      default:
        return ya + (yb - ya) * t + Math.sin(t * Math.PI * 2 + this.phase) * Math.sin(t * Math.PI) * 0.45;
    }
  }

  /** Still water in the dip: up to just below where the floor starts to fall. */
  public waterLevel(): number {
    return Math.min(this.at(this.w0), this.at(this.w1)) - (this.kind === 'sump' ? 0.2 : 0.3);
  }
}

/** A tapered capsule along a tunnel piece with a flat floor following the profile. */
class Seg implements AirPrim {
  minX = 0; maxX = 0; minY = 0; maxY = 0; minZ = 0; maxZ = 0;
  stamp = 0;
  uid = 0;
  private readonly dx: number;
  private readonly dy: number;
  private readonly dz: number;
  private readonly len2: number;
  private readonly len: number;
  private readonly ay: number;
  private readonly floors = new Float32Array(FLOOR_STEPS + 1);
  constructor(
    private readonly ax: number,
    floorA: number,
    private readonly az: number,
    bx: number,
    floorB: number,
    bz: number,
    private readonly ra: number,
    private readonly rb: number,
    prof: Profile,
    t0: number,
    t1: number,
    public amp: number,
    private readonly capA = false,
    private readonly capB = false
  ) {
    // Floor along the piece, tabulated (the profile is trigonometry; the field reads it a lot).
    // Stay on this piece's side of a cliff: never read the profile at the exact break
    const span = t1 - t0;
    let lowest = Infinity;
    for (let i = 0; i <= FLOOR_STEPS; i++) {
      const y = prof.at(t0 + span * (0.0005 + (i / FLOOR_STEPS) * 0.999));
      this.floors[i] = y;
      if (y < lowest) lowest = y;
    }
    this.ay = floorA + ra * 0.45;
    const by = floorB + rb * 0.45;
    this.dx = bx - ax;
    this.dy = by - this.ay;
    this.dz = bz - az;
    this.len2 = this.dx * this.dx + this.dy * this.dy + this.dz * this.dz || 1e-6;
    this.len = Math.sqrt(this.len2);
    const r = Math.max(ra, rb) + 2;
    this.minX = Math.min(ax, bx) - r;
    this.maxX = Math.max(ax, bx) + r;
    this.minZ = Math.min(az, bz) - r;
    this.maxZ = Math.max(az, bz) + r;
    this.minY = Math.min(floorA, floorB, lowest) - 2.5;
    this.maxY = Math.max(floorA, floorB) + r * 1.8 + 1;
  }

  public d(x: number, y: number, z: number): number {
    const t = ((x - this.ax) * this.dx + (y - this.ay) * this.dy + (z - this.az) * this.dz) / this.len2;
    const tc = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = this.ax + this.dx * tc - x, py = this.ay + this.dy * tc - y, pz = this.az + this.dz * tc - z;
    const r = this.ra + (this.rb - this.ra) * tc;
    const cap = Math.sqrt(px * px + py * py * 1.35 + pz * pz) - r;
    const u = tc * FLOOR_STEPS;
    const k = u >= FLOOR_STEPS ? FLOOR_STEPS - 1 : u | 0;
    const floorY = this.floors[k] + (this.floors[k + 1] - this.floors[k]) * (u - k);
    const fl = floorY - y;
    let d = cap > fl ? cap : fl;
    gFloorW = clamp01((fl - cap + 0.8) / 1.6);
    if (this.capA) {
      const s = -t * this.len;
      if (s > d) d = s;
    }
    if (this.capB) {
      const s = (t - 1) * this.len;
      if (s > d) d = s;
    }
    return d;
  }
}

/** Ellipsoid room (rotated about Y) with a flat floor; also a basin without one. */
class Ellipsoid implements AirPrim {
  minX = 0; maxX = 0; minY = 0; maxY = 0; minZ = 0; maxZ = 0;
  stamp = 0;
  uid = 0;
  private readonly cos: number;
  private readonly sin: number;
  constructor(
    private readonly cx: number,
    private readonly cy: number,
    private readonly cz: number,
    private readonly rx: number,
    private readonly ry: number,
    private readonly rz: number,
    rot: number,
    private readonly floor: number,
    public amp: number
  ) {
    this.cos = Math.cos(rot);
    this.sin = Math.sin(rot);
    const r = Math.max(rx, rz) + 2;
    this.minX = cx - r;
    this.maxX = cx + r;
    this.minZ = cz - r;
    this.maxZ = cz + r;
    this.minY = cy - ry - 2;
    this.maxY = cy + ry + 2;
  }

  public d(x: number, y: number, z: number): number {
    const ox = x - this.cx, oz = z - this.cz;
    const lx = ox * this.cos + oz * this.sin;
    const lz = -ox * this.sin + oz * this.cos;
    const ly = y - this.cy;
    const qx = lx / this.rx, qy = ly / this.ry, qz = lz / this.rz;
    const k0 = Math.sqrt(qx * qx + qy * qy + qz * qz);
    const k1 = Math.sqrt((qx / this.rx) ** 2 + (qy / this.ry) ** 2 + (qz / this.rz) ** 2);
    const e = k1 < 1e-6 ? -Math.min(this.rx, this.ry, this.rz) : (k0 * (k0 - 1)) / k1;
    if (Number.isNaN(this.floor)) {
      gFloorW = 0.6;
      return e;
    }
    const fl = this.floor - y;
    gFloorW = clamp01((fl - e + 0.8) / 1.6);
    return e > fl ? e : fl;
  }
}

/** Rock block in a chamber's frame (u across, v outward): a gallery shelf or a stepped ramp up to it. */
class Slab implements RockPrim {
  minX = 0; maxX = 0; minY = -1e9; maxY = 0; minZ = 0; maxZ = 0;
  stamp = 0;
  uid = 0;
  constructor(
    private readonly cx: number,
    private readonly cz: number,
    private readonly ux: number,
    private readonly uz: number,
    private readonly u0: number,
    private readonly u1: number,
    private readonly v0: number,
    private readonly v1: number,
    private readonly floor: number,
    private readonly height: number,
    /** Ramp: the top climbs in steps from u0 (floor) to u1 (full height). */
    private readonly ramp: boolean
  ) {
    const r = Math.max(Math.abs(u0), Math.abs(u1), Math.abs(v0), Math.abs(v1)) + 1;
    this.minX = cx - r;
    this.maxX = cx + r;
    this.minZ = cz - r;
    this.maxZ = cz + r;
    this.minY = floor - 3;
    this.maxY = floor + height + 1;
  }

  public d(x: number, y: number, z: number): number {
    const ox = x - this.cx, oz = z - this.cz;
    const u = ox * this.ux + oz * this.uz;
    const v = ox * -this.uz + oz * this.ux; // v points along the shelf direction
    const du = Math.max(this.u0 - u, u - this.u1);
    const dv = Math.max(this.v0 - v, v - this.v1);
    let top = this.floor + this.height;
    if (this.ramp) {
      // Steps of ~0.45 m, each a flat tread: walkable, and every riser is an easy hop
      const steps = Math.ceil(this.height / 0.45);
      const k = Math.min(steps - 1, Math.floor(clamp01((u - this.u0) / (this.u1 - this.u0)) * steps));
      top = this.floor + (this.height * (k + 1)) / steps;
    }
    return Math.max(du, dv, y - top);
  }
}

/** A stone column from floor to ceiling. */
class Pillar implements RockPrim {
  minX = 0; maxX = 0; minY = -1e9; maxY = 1e9; minZ = 0; maxZ = 0;
  stamp = 0;
  uid = 0;
  constructor(private readonly x: number, private readonly z: number, private readonly r: number, private readonly floor: number) {
    this.minX = x - r - 2;
    this.maxX = x + r + 2;
    this.minZ = z - r - 2;
    this.maxZ = z + r + 2;
    this.minY = floor - 2;
    this.maxY = floor + 25;
  }

  public d(x: number, y: number, z: number): number {
    // Waisted in the middle, flaring into the floor and ceiling like a joined stalactite
    const h = y - this.floor;
    const waist = 1 - 0.35 * Math.exp(-((h - 4) * (h - 4)) / 10);
    return Math.hypot(x - this.x, z - this.z) - this.r * waist;
  }
}

// ------------------------------------------------------------------ spatial index

const IDX_CELL = 16;
const IDX_N = 34;
const IDX_MIN = -272;

const byUid = (a: { uid: number }, b: { uid: number }) => a.uid - b.uid;

class PrimIndex {
  private readonly air: AirPrim[][] = Array.from({ length: IDX_N * IDX_N }, () => []);
  private readonly rock: RockPrim[][] = Array.from({ length: IDX_N * IDX_N }, () => []);
  private stamp = 1;
  private nextUid = 1;

  public add(p: AirPrim | RockPrim, isRock: boolean): void {
    p.uid = this.nextUid++;
    const i0 = this.ci(p.minX), i1 = this.ci(p.maxX), j0 = this.ci(p.minZ), j1 = this.ci(p.maxZ);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (isRock) this.rock[j * IDX_N + i].push(p as RockPrim);
      else this.air[j * IDX_N + i].push(p as AirPrim);
    }
  }

  private ci(v: number): number {
    return Math.max(0, Math.min(IDX_N - 1, Math.floor((v - IDX_MIN) / IDX_CELL)));
  }

  /** Primitives whose boxes overlap a box (no duplicates), in creation order. */
  public query(b: Box, air: AirPrim[], rock: RockPrim[]): void {
    air.length = 0;
    rock.length = 0;
    const s = ++this.stamp;
    const i0 = this.ci(b.minX), i1 = this.ci(b.maxX), j0 = this.ci(b.minZ), j1 = this.ci(b.maxZ);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      for (const p of this.air[j * IDX_N + i]) {
        if (p.stamp === s || !overlaps(p, b)) continue;
        p.stamp = s;
        air.push(p);
      }
      for (const p of this.rock[j * IDX_N + i]) {
        if (p.stamp === s || !overlaps(p, b)) continue;
        p.stamp = s;
        rock.push(p);
      }
    }
    // Same order for every chunk, or shared border samples differ by float rounding and the
    // meshes of neighbouring chunks no longer meet exactly (visible seams)
    if (air.length > 1) air.sort(byUid);
    if (rock.length > 1) rock.sort(byUid);
  }

  /** Candidates at one column (already in creation order: they were pushed in it). */
  public airAt(x: number, z: number): AirPrim[] {
    return this.air[this.ci(z) * IDX_N + this.ci(x)];
  }

  public rockAt(x: number, z: number): RockPrim[] {
    return this.rock[this.ci(z) * IDX_N + this.ci(x)];
  }
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

/** Distance to the nearest air piece, without noise or blending (for skipping solid chunks). */
function rawAir(x: number, y: number, z: number, air: AirPrim[]): number {
  let d = 1e9;
  for (let i = 0; i < air.length; i++) {
    const p = air[i];
    if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY || z < p.minZ || z > p.maxZ) continue;
    const v = p.d(x, y, z);
    if (v < d) d = v;
  }
  return d;
}

/** The signed distance field from a candidate list. */
function field(x: number, y: number, z: number, air: AirPrim[], rock: RockPrim[]): number {
  let d = 1e9;
  let amp = 1;
  for (let i = 0; i < air.length; i++) {
    const p = air[i];
    // Outside its box a piece is at least ~2 m away: it cannot change the union or the blend
    if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY || z < p.minZ || z > p.maxZ) continue;
    const v = p.d(x, y, z);
    const pa = p.amp * (1 - 0.7 * gFloorW);
    if (d >= 1e8) {
      d = v;
      amp = pa;
      continue;
    }
    // Smooth union that also blends the noise strength, so no creases where pieces meet
    const h = clamp01(0.5 + (0.5 * (d - v)) / SMOOTH_K);
    d = d + (v - d) * h - SMOOTH_K * h * (1 - h);
    amp = amp + (pa - amp) * h;
  }
  if (d > FAR) return d;
  d += rockNoise(x, y, z) * amp;
  for (let i = 0; i < rock.length; i++) {
    const p = rock[i];
    if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY || z < p.minZ || z > p.maxZ) continue;
    const r = -p.d(x, y, z);
    if (r > d) d = r;
  }
  return d;
}

// ------------------------------------------------------------------ layout geometry helpers

function segIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function pointSegDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const t = clamp01(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1));
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}

/** Water surface of a hub, or NaN when it has none. */
export function hubWater(h: LayoutHub): number {
  if (h.water !== undefined && h.water !== null) return h.water;
  return h.kind === 'lake' ? h.floor - 0.35 : NaN;
}

/** Shelf directions of the grand halls in the layout being built (toward the shelf tunnel's far end). */
const shelfDirs = new Map<string, { dx: number; dz: number }>();
function shelfDir(h: LayoutHub): { dx: number; dz: number } {
  return shelfDirs.get(h.id) ?? { dx: 1, dz: 0 };
}

function computeShelfDirs(hubs: Map<string, LayoutHub>, tunnels: LayoutTunnel[]): void {
  shelfDirs.clear();
  for (const t of tunnels) {
    for (const [hid, oid] of [[t.a, t.b], [t.b, t.a]]) {
      const h = hubs.get(hid), o = hubs.get(oid);
      if (!h || !o || h.kind !== 'grand' || h.shelf !== t.id) continue;
      const l = Math.hypot(o.x - h.x, o.z - h.z) || 1;
      shelfDirs.set(h.id, { dx: (o.x - h.x) / l, dz: (o.z - h.z) / l });
    }
  }
}

/** Where a tunnel leaves a hub: its centre, or the gallery shelf for the tunnel that arrives up there. */
export function tunnelEnd(h: LayoutHub, tunnelId: string): { x: number; z: number; y: number } {
  if (h.kind === 'grand' && h.shelf === tunnelId && shelfDirs.has(h.id)) {
    const sd = shelfDir(h);
    const R = h.rx;
    // Shelf frame: v along the shelf direction, u across (see Slab)
    const ux = sd.dz, uz = -sd.dx;
    const u = R * 0.3, v = R * 0.84;
    return { x: h.x + ux * u + sd.dx * v, z: h.z + uz * u + sd.dz * v, y: h.floor + SHELF_H };
  }
  return { x: h.x, z: h.z, y: h.floor };
}

/** Ends of a tunnel and its centre-line (call prepareLayoutGeometry for the layout first). */
export function tunnelGeometry(
  hubs: Map<string, LayoutHub>,
  t: LayoutTunnel
): { A: { x: number; y: number; z: number }; B: { x: number; y: number; z: number }; len: number; P(u: number): { x: number; z: number } } | null {
  const ha = hubs.get(t.a), hb = hubs.get(t.b);
  if (!ha || !hb || ha === hb) return null;
  const A = tunnelEnd(ha, t.id), B = tunnelEnd(hb, t.id);
  const len = Math.max(1, Math.hypot(B.x - A.x, B.z - A.z));
  const ux = (B.x - A.x) / len, uz = (B.z - A.z) / len;
  const px = -uz, pz = ux;
  const wig = Math.max(-len * 0.15, Math.min(len * 0.15, t.wig));
  const damp = t.kind === 'sump' ? 0.3 : 1;
  const P = (u: number) => {
    const off = wig * Math.sin(Math.PI * u) * Math.sin(Math.PI * u * t.k + t.ph) * damp;
    return { x: A.x + (B.x - A.x) * u + px * off, z: A.z + (B.z - A.z) * u + pz * off };
  };
  return { A, B, len, P };
}

/** Sets up the shelves and biomes of a layout for tunnelGeometry / biomeWeights; returns hubs by id. */
export function prepareLayoutGeometry(layout: CaveLayout): Map<string, LayoutHub> {
  const hubs = new Map(layout.hubs.map((h) => [h.id, h]));
  computeShelfDirs(hubs, layout.tunnels);
  gBiomes = layout.biomes;
  return hubs;
}

// ------------------------------------------------------------------ planning

function entranceInward(e: CaveEntranceIn): { inx: number; inz: number; mouthY: number } {
  return { inx: -Math.sin(e.yaw), inz: -Math.cos(e.yaw), mouthY: e.y - 0.2 };
}

/** The porch chamber of a surface entrance: a small room, or a lake for an underwater one. */
function entranceHub(e: CaveEntranceIn): LayoutHub {
  const { inx, inz, mouthY } = entranceInward(e);
  if (e.underwater) {
    const water = mouthY + 6;
    return {
      id: `entry-${e.id}`,
      x: r2(e.x + inx * 24),
      z: r2(e.z + inz * 24),
      floor: r2(water + 0.35),
      rx: 11, ry: 7, rz: 9,
      rot: r2(Math.atan2(inz, inx)),
      kind: 'lake',
      water: r2(water),
      entrance: e.id,
    };
  }
  return { id: `entry-${e.id}`, x: r2(e.x + inx * 16), z: r2(e.z + inz * 16), floor: r2(mouthY - 2.5), rx: 5, ry: 4.6, rz: 5, rot: 0, kind: 'chamber', entrance: e.id };
}

function newTunnel(id: string, a: LayoutHub, b: LayoutHub, rnd: () => number, loop = false): LayoutTunnel {
  const len = Math.hypot(a.x - b.x, a.z - b.z);
  return {
    id,
    a: a.id,
    b: b.id,
    kind: 'ramp',
    radius: r2(2.6 + rnd() * 0.6),
    wig: r2(Math.min(7, len * 0.12) * (rnd() < 0.5 ? -1 : 1)),
    k: 1 + Math.floor(rnd() * 2),
    ph: r2(rnd() * 6),
    phase: r2(rnd() * 6),
    loop: loop || undefined,
  };
}

/** `prefix` + one more than the highest number already used with it. */
export function nextLayoutId(prefix: string, list: { id: string }[]): string {
  let n = 0;
  for (const o of list) {
    const m = o.id.startsWith(prefix) ? Number(o.id.slice(prefix.length)) : NaN;
    if (Number.isFinite(m)) n = Math.max(n, m);
  }
  return `${prefix}${n + 1}`;
}

/** A tunnel between two hubs with procedural wiggle (the editor's "connect"). */
export function makeTunnel(layout: CaveLayout, a: LayoutHub, b: LayoutHub): LayoutTunnel {
  const rnd = mulberry(layout.tunnels.length * 977 + layout.seed);
  const t = newTunnel(nextLayoutId('t', layout.tunnels), a, b, rnd);
  const slope = Math.abs(a.floor - b.floor) / Math.max(1, Math.hypot(a.x - b.x, a.z - b.z));
  if (slope > 0.15) t.kind = 'stairs';
  return t;
}

/** Gives every surface entrance a porch chamber joined to the nearest chamber (new or edited layouts). */
function ensureEntrances(layout: CaveLayout, input: CaveGenInput, rnd: () => number): void {
  for (const e of input.entrances) {
    if (layout.hubs.some((h) => h.entrance === e.id)) continue;
    const hub = entranceHub(e);
    const others = layout.hubs.filter((h) => !h.entrance);
    layout.hubs.push(hub);
    if (!others.length) continue;
    const byId = new Map(layout.hubs.map((h) => [h.id, h]));
    const crosses = (a: LayoutHub, b: LayoutHub) =>
      layout.tunnels.some((t) => {
        const ta = byId.get(t.a), tb = byId.get(t.b);
        return !!ta && !!tb && ta !== a && tb !== a && ta !== b && tb !== b && segIntersect(a.x, a.z, b.x, b.z, ta.x, ta.z, tb.x, tb.z);
      });
    const sorted = others.sort((p, q) => Math.hypot(p.x - hub.x, p.z - hub.z) - Math.hypot(q.x - hub.x, q.z - hub.z));
    const target = sorted.slice(0, 4).find((c) => !crosses(hub, c)) ?? sorted[0];
    layout.tunnels.push(newTunnel(nextLayoutId('t', layout.tunnels), hub, target, rnd));
  }
}

/** A fresh procedural layout (structure and pillars; the rest of the items come after building). */
export function planCaveLayout(input: CaveGenInput): CaveLayout {
  const rnd = mulberry(input.seed * 7919 + 17);
  const coastAt = (x: number, z: number) => {
    let deg = Math.round((Math.atan2(z, x) * 180) / Math.PI);
    if (deg < 0) deg += 360;
    return input.coast[deg % 360];
  };

  // Biomes face the entrances: moss behind the first, the flooded crystal caverns behind the third
  // (the underwater one), ember depths behind the second
  const base = rnd() * Math.PI * 2;
  const biomes = [0, 2, 1].map((ei, b) => {
    const e = input.entrances[ei];
    const a = e ? Math.atan2(e.z, e.x) : base + (b * Math.PI * 2) / 3;
    return { x: r2(Math.cos(a) * 105), z: r2(Math.sin(a) * 105) };
  });
  gBiomes = biomes;

  const hubs: LayoutHub[] = input.entrances.map(entranceHub);
  const entryHubs = [...hubs];

  // Chambers: Poisson disk under the island, clear of the entrance porches
  const chambers: LayoutHub[] = [];
  for (let i = 0; i < 6000 && chambers.length < 18; i++) {
    const x = (rnd() * 2 - 1) * 215, z = (rnd() * 2 - 1) * 215;
    if (Math.hypot(x, z) > coastAt(x, z) - 42) continue;
    if (chambers.some((h) => Math.hypot(h.x - x, h.z - z) < 54)) continue;
    if (entryHubs.some((h) => Math.hypot(h.x - x, h.z - z) < Math.max(h.rx, h.rz) + 30)) continue;
    biomeWeights(x, z, _bw);
    const floor = -10 + noise2(x * 0.012 + 3, z * 0.012) * 7 - _bw[2] * 12 + _bw[0] * 4;
    const s = 8 + rnd() * 5;
    chambers.push({
      id: `h${chambers.length + 1}`,
      x: r2(x), z: r2(z), floor,
      rx: r2(s), ry: r2(5.5 + rnd() * 2.5), rz: r2(s * (0.7 + rnd() * 0.5)), rot: r2(rnd() * Math.PI),
      kind: 'chamber',
    });
  }
  // A few grand halls (tall, round, with a gallery) and lake chambers; the flooded crystal caverns
  // get many more lakes, and their grand halls a lake in the middle
  const order = chambers.map((_, i) => i).sort(() => rnd() - 0.5);
  order.slice(0, 3).forEach((i) => {
    const h = chambers[i];
    h.kind = 'grand';
    h.rx = h.rz = r2(16 + rnd() * 3);
    h.ry = r2(10.5 + rnd() * 1.5);
  });
  const makeLake = (h: LayoutHub) => {
    h.kind = 'lake';
    h.rx = r2(12 + rnd() * 3);
    h.rz = r2(h.rx * (0.8 + rnd() * 0.25));
    h.ry = r2(7 + rnd() * 2);
  };
  order.slice(3, 5).forEach((i) => makeLake(chambers[i]));
  const wetGrand = new Set<LayoutHub>();
  for (const h of chambers) {
    biomeWeights(h.x, h.z, _bw);
    if (_bw[1] < 0.5) continue;
    if (h.kind === 'chamber' && rnd() < 0.6) makeLake(h);
    else if (h.kind === 'grand') wetGrand.add(h);
  }
  hubs.push(...chambers);

  const tunnels: LayoutTunnel[] = [];
  const adj = new Map<string, LayoutTunnel[]>(hubs.map((h) => [h.id, []]));
  const byId = new Map(hubs.map((h) => [h.id, h]));
  const addTunnel = (a: LayoutHub, b: LayoutHub, loop: boolean) => {
    const t = newTunnel(`t${tunnels.length + 1}`, a, b, rnd, loop);
    tunnels.push(t);
    adj.get(a.id)!.push(t);
    adj.get(b.id)!.push(t);
    return t;
  };
  const other = (t: LayoutTunnel, h: LayoutHub) => byId.get(t.a === h.id ? t.b : t.a)!;
  const crosses = (a: LayoutHub, b: LayoutHub) =>
    tunnels.some((t) => {
      const ta = byId.get(t.a)!, tb = byId.get(t.b)!;
      return ta !== a && tb !== a && ta !== b && tb !== b && segIntersect(a.x, a.z, b.x, b.z, ta.x, ta.z, tb.x, tb.z);
    });
  const clearOfHubs = (a: LayoutHub, b: LayoutHub) =>
    hubs.every((h) => h === a || h === b || pointSegDist(h.x, h.z, a.x, a.z, b.x, b.z) > Math.max(h.rx, h.rz) + 7);

  // Minimum spanning tree over the chambers (Prim)
  if (chambers.length) {
    const inTree = new Set<LayoutHub>([chambers[0]]);
    while (inTree.size < chambers.length) {
      let best: [LayoutHub, LayoutHub] | null = null;
      let bestD = Infinity;
      for (const a of inTree) {
        for (const b of chambers) {
          if (inTree.has(b)) continue;
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d < bestD) {
            bestD = d;
            best = [a, b];
          }
        }
      }
      if (!best) break;
      addTunnel(best[0], best[1], false);
      inTree.add(best[1]);
    }
  }
  // Loops: short extra links that cross nothing and pass no other chamber
  const pairs: [LayoutHub, LayoutHub, number][] = [];
  for (let i = 0; i < chambers.length; i++) {
    for (let j = i + 1; j < chambers.length; j++) {
      const a = chambers[i], b = chambers[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 95 && !adj.get(a.id)!.some((t) => other(t, a) === b)) pairs.push([a, b, d]);
    }
  }
  pairs.sort((p, q) => p[2] - q[2]);
  let loops = 0;
  for (const [a, b] of pairs) {
    if (loops >= 7) break;
    if (crosses(a, b) || !clearOfHubs(a, b)) continue;
    addTunnel(a, b, true);
    loops++;
  }
  // Each entrance joins the nearest chamber it can reach without crossing a tunnel
  const entryTunnels = new Set<LayoutTunnel>();
  for (const eh of entryHubs) {
    if (!chambers.length) break;
    const sorted = [...chambers].sort((p, q) => Math.hypot(p.x - eh.x, p.z - eh.z) - Math.hypot(q.x - eh.x, q.z - eh.z));
    const target = sorted.slice(0, 4).find((c) => !crosses(eh, c) && clearOfHubs(eh, c)) ?? sorted[0];
    entryTunnels.add(addTunnel(eh, target, false));
  }

  // Galleries: a grand hall's shelf faces one tunnel; the others must arrive well away from it
  for (const h of chambers) {
    if (h.kind !== 'grand') continue;
    const dirs = adj.get(h.id)!.map((t) => {
      const o = other(t, h);
      const l = Math.hypot(o.x - h.x, o.z - h.z) || 1;
      return { t, dx: (o.x - h.x) / l, dz: (o.z - h.z) / l };
    });
    for (const cand of dirs) {
      if (entryTunnels.has(cand.t)) continue;
      if (dirs.every((o) => o === cand || o.dx * cand.dx + o.dz * cand.dz < Math.cos((75 * Math.PI) / 180))) {
        h.shelf = cand.t.id;
        break;
      }
    }
  }
  computeShelfDirs(byId, tunnels);

  // Heights: keep every tunnel walkable (slope <= 0.38) by relaxing the free chamber floors
  const endY = (h: LayoutHub, t: LayoutTunnel) => tunnelEnd(h, t.id).y;
  for (let it = 0; it < 80; it++) {
    for (const t of tunnels) {
      const a = byId.get(t.a)!, b = byId.get(t.b)!;
      const len = Math.hypot(a.x - b.x, a.z - b.z);
      const diff = endY(a, t) - endY(b, t);
      const lim = 0.38 * len;
      if (Math.abs(diff) <= lim) continue;
      const excess = (Math.abs(diff) - lim) * Math.sign(diff);
      const fa = !!a.entrance, fb = !!b.entrance;
      if (!fa && !fb) {
        a.floor -= excess / 2;
        b.floor += excess / 2;
      } else if (!fa) a.floor -= excess;
      else if (!fb) b.floor += excess;
    }
  }
  for (const h of chambers) {
    h.floor = r2(Math.max(-45, Math.min(18, h.floor)));
    if (wetGrand.has(h)) h.water = r2(h.floor - 0.35);
  }

  // Tunnel kinds: one-way features only on loops, so the tree always leads back. The flooded
  // caverns' tree tunnels dip into deep water you swim across (both ways)
  const lenOf = (t: LayoutTunnel) => Math.hypot(byId.get(t.a)!.x - byId.get(t.b)!.x, byId.get(t.a)!.z - byId.get(t.b)!.z);
  const slope = (t: LayoutTunnel) => Math.abs(endY(byId.get(t.a)!, t) - endY(byId.get(t.b)!, t)) / Math.max(1, lenOf(t));
  const free = (t: LayoutTunnel) => byId.get(t.a)!.shelf !== t.id && byId.get(t.b)!.shelf !== t.id;
  const wetness = (t: LayoutTunnel) => {
    const a = byId.get(t.a)!, b = byId.get(t.b)!;
    return biomeWeights((a.x + b.x) / 2, (a.z + b.z) / 2, _bw)[1];
  };
  const loopTunnels = tunnels.filter((t) => t.loop).sort((p, q) => wetness(q) - wetness(p) + (rnd() - 0.5) * 0.3);
  let sumps = 0, drops = 0, floods = 0;
  for (const t of loopTunnels) {
    if (!free(t) || lenOf(t) < 34) continue;
    const a = byId.get(t.a)!, b = byId.get(t.b)!;
    if (sumps < 3 && a.kind !== 'lake' && b.kind !== 'lake' && (sumps < 1 || wetness(t) > 0.45)) {
      t.kind = 'sump';
      sumps++;
    } else if (drops < 3 && wetness(t) < 0.5) {
      t.kind = 'drop';
      drops++;
    }
  }
  for (const t of tunnels) {
    if (t.kind !== 'ramp' || entryTunnels.has(t) || !free(t)) continue;
    if (floods < 6 && wetness(t) > 0.5 && lenOf(t) > 26 && slope(t) < 0.2) {
      t.kind = 'flood';
      floods++;
    }
  }
  for (const t of tunnels) if (t.kind === 'ramp' && slope(t) > 0.15) t.kind = 'stairs';

  for (const h of hubs) h.floor = r2(h.floor);
  const layout: CaveLayout = { version: 1, seed: input.seed, biomes, hubs, tunnels, items: [], nextItem: 1 };

  // Pillars in the grand halls (rock, so they are part of the layout's geometry from the start)
  for (const h of chambers) {
    if (h.kind !== 'grand') continue;
    const keep = hubKeepOut(h, layout, byId);
    for (let i = 0, placed = 0; i < 20 && placed < 2; i++) {
      const a = rnd() * Math.PI * 2, d = h.rx * (0.3 + rnd() * 0.3);
      const x = h.x + Math.cos(a) * d, z = h.z + Math.sin(a) * d;
      if (h.shelf) {
        const sd = shelfDir(h);
        if (Math.cos(a) * sd.dx + Math.sin(a) * sd.dz > -0.2) continue;
      }
      if (!Number.isNaN(hubWater(h)) && d < h.rx * 0.7) continue;
      if (keep.some((k) => Math.hypot(k.x - x, k.z - z) < k.r + 2.5)) continue;
      layout.items.push({ id: layout.nextItem++, t: 'pillar', x: r2(x), y: h.floor, z: r2(z), r: r2(1.3 + rnd() * 0.6), hub: h.id });
      keep.push({ x, z, r: 3 });
      placed++;
    }
  }
  return layout;
}

/** Spots inside a hub to keep clear: its centre and the corridors where tunnels arrive. */
function hubKeepOut(h: LayoutHub, layout: CaveLayout, hubs: Map<string, LayoutHub>): { x: number; z: number; r: number }[] {
  const keep = [{ x: h.x, z: h.z, r: 3 }];
  for (const t of layout.tunnels) {
    if (t.a !== h.id && t.b !== h.id) continue;
    const o = hubs.get(t.a === h.id ? t.b : t.a);
    if (!o) continue;
    const end = tunnelEnd(h, t.id);
    const l = Math.hypot(o.x - end.x, o.z - end.z) || 1;
    for (let d = 0; d < Math.max(h.rx, h.rz) + 4; d += 2.5) keep.push({ x: end.x + ((o.x - end.x) / l) * d, z: end.z + ((o.z - end.z) / l) * d, r: 2.6 });
  }
  if (h.kind === 'grand' && h.shelf) {
    const sd = shelfDir(h);
    const R = h.rx, ux = sd.dz, uz = -sd.dx;
    for (let u = -0.5; u <= 0.6; u += 0.12) keep.push({ x: h.x + ux * u * R + sd.dx * 0.85 * R, z: h.z + uz * u * R + sd.dz * 0.85 * R, r: 0.3 * R });
  }
  return keep;
}

// ------------------------------------------------------------------ building the field

interface PoolDef {
  level: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  seed: Vec3;
}

interface Built {
  hubs: Map<string, LayoutHub>;
  index: PrimIndex;
  poolDefs: PoolDef[];
  entrances: CaveEntranceOut[];
  tunnelSpots: { x: number; z: number; f: number; r: number; dx: number; dz: number; plain: boolean }[];
  at(x: number, y: number, z: number): number;
}

function buildField(layout: CaveLayout, input: CaveGenInput): Built {
  const hubs = prepareLayoutGeometry(layout);
  const index = new PrimIndex();
  const addAir = (p: AirPrim) => index.add(p, false);
  const addRock = (p: RockPrim) => index.add(p, true);
  const poolDefs: PoolDef[] = [];
  const tunnelSpots: Built['tunnelSpots'] = [];

  // Tunnels
  for (const t of layout.tunnels) {
    const g = tunnelGeometry(hubs, t);
    if (!g) continue;
    const { A, B, len, P } = g;
    const prof = new Profile(t.kind, A.y, B.y, len, t.phase);
    // Break points: even ~7 m pieces, plus the exact cliff of a drop
    const n = Math.max(3, Math.ceil(len / 7));
    const ts = new Set<number>();
    for (let i = 0; i <= n; i++) ts.add(i / n);
    if (t.kind === 'drop') ts.add(0.5);
    // No even break right next to a cliff: the flat-capped piece there must be long enough that the
    // round end of the piece before it cannot poke past the cut
    const near = 3.5 / len;
    const list = [...ts]
      .filter((u) => t.kind !== 'drop' || u === 0.5 || u === 0 || u === 1 || Math.abs(u - 0.5) > near)
      .sort((p, q) => p - q)
      .filter((u, i, arr) => i === 0 || u - arr[i - 1] > 0.015 || u === 0.5);
    const radiusAt = (u: number) => {
      let r = t.radius;
      if (t.kind === 'sump' && u > 0.25 && u < 0.75) r = 2.3;
      if (t.kind === 'flood' && u > prof.w0 && u < prof.w1) r = t.radius + 0.3;
      // Flare where the tunnel meets a chamber
      if (u < 0.06 || u > 0.94) r *= 1.12;
      return r;
    };
    for (let i = 0; i + 1 < list.length; i++) {
      const ta = list[i], tb = list[i + 1];
      const pa = P(ta), pb = P(tb);
      const span = tb - ta;
      const fa = prof.at(ta + span * 0.0005), fb = prof.at(tb - span * 0.0005);
      const mid = (ta + tb) / 2;
      const ra = radiusAt(ta), rb = radiusAt(tb);
      // Flat end on the low side of a cliff
      const capA = t.kind === 'drop' && ta === 0.5 && prof.ya >= prof.yb;
      const capB = t.kind === 'drop' && tb === 0.5 && prof.ya < prof.yb;
      const amp = t.kind === 'sump' ? 0.6 : t.kind === 'flood' ? 0.7 : 0.8;
      addAir(new Seg(pa.x, fa, pa.z, pb.x, fb, pb.z, ra, rb, prof, ta, tb, amp, capA, capB));
      if (mid > 0.12 && mid < 0.88) {
        const l = Math.hypot(pb.x - pa.x, pb.z - pa.z) || 1;
        tunnelSpots.push({
          x: (pa.x + pb.x) / 2,
          z: (pa.z + pb.z) / 2,
          f: prof.at(mid),
          r: (ra + rb) / 2,
          dx: (pb.x - pa.x) / l,
          dz: (pb.z - pa.z) / l,
          plain: prof.dip === 0 || mid < prof.w0 - 0.05 || mid > prof.w1 + 0.05,
        });
      }
    }
    if (prof.dip > 0) {
      const level = prof.waterLevel();
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let u = prof.w0 - 0.1; u <= prof.w1 + 0.1; u += 0.02) {
        const p = P(u);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
      const s = P(0.5);
      poolDefs.push({ level, minX: minX - 5, maxX: maxX + 5, minZ: minZ - 5, maxZ: maxZ + 5, minY: level - prof.dip - 4, seed: [s.x, prof.at(0.5) + 0.6, s.z] });
    }
  }

  // Entrance porches: a calm-walled tunnel ending in a flat wall where the daylight disc hangs.
  // Under the sea, a flooded tunnel rises from the sea-bed mouth into the porch lake
  const entrances: CaveEntranceOut[] = [];
  for (const e of input.entrances) {
    const hub = layout.hubs.find((h) => h.entrance === e.id);
    if (!hub) continue;
    const { inx, inz, mouthY } = entranceInward(e);
    const mx = e.x, mz = e.z;
    if (e.underwater) {
      const level = Number.isNaN(hubWater(hub)) ? hub.floor - 0.35 : hubWater(hub);
      const dl = Math.hypot(hub.x - mx, hub.z - mz) || 1;
      const dx = (hub.x - mx) / dl, dz = (hub.z - mz) / dl;
      const reach = Math.max(8, dl - Math.min(hub.rx, hub.rz) * 0.35);
      const tx = mx + dx * reach, tz = mz + dz * reach, ty = level - 3.2;
      const prof = new Profile('ramp', mouthY, ty, reach, 0);
      const k = Math.min(0.4, 6 / reach);
      const p6x = mx + inx * 6, p6z = mz + inz * 6;
      addAir(new Seg(mx, mouthY, mz, p6x, prof.at(k), p6z, 2.4, 2.5, prof, 0, k, 0.25, true, false));
      addAir(new Seg(p6x, prof.at(k), p6z, tx, ty, tz, 2.5, 2.8, prof, k, 1, 0.6));
      entrances.push({
        id: e.id,
        mouth: [mx + inx * 0.9, mouthY, mz + inz * 0.9],
        spawn: [tx + dx * 2, level - 0.6, tz + dz * 2],
        yaw: Math.atan2(dx, dz),
        glow: [mx + inx * 0.28, mouthY + 1.4, mz + inz * 0.28],
        torches: [],
        underwater: true,
      });
      continue;
    }
    const dl = Math.max(6, Math.hypot(hub.x - mx, hub.z - mz));
    const prof = new Profile('ramp', mouthY, hub.floor, dl, 0);
    const k = 5 / dl;
    const p5x = mx + inx * 5, p5z = mz + inz * 5;
    addAir(new Seg(mx, mouthY, mz, p5x, prof.at(k), p5z, 2.6, 2.7, prof, 0, k, 0.22, true, false));
    addAir(new Seg(p5x, prof.at(k), p5z, hub.x, hub.floor, hub.z, 2.7, 3.0, prof, k, 1, 0.7));
    const sx = mx + inx * 2.8, sz = mz + inz * 2.8;
    const tx = mx + inx * 3.4, tz = mz + inz * 3.4;
    entrances.push({
      id: e.id,
      mouth: [mx + inx * 0.9, mouthY, mz + inz * 0.9],
      spawn: [sx, prof.at(2.8 / dl), sz],
      yaw: Math.atan2(inx, inz),
      glow: [mx + inx * 0.28, mouthY + 1.55, mz + inz * 0.28],
      torches: [-1.9, 1.9].map((s): Vec3 => [tx - inz * s, prof.at(3.4 / dl), tz + inx * s]),
      underwater: false,
    });
  }

  // Chambers, lake basins and galleries
  for (const h of layout.hubs) {
    const amp = h.entrance && h.kind !== 'lake' ? 0.8 : h.kind === 'grand' ? 1.25 : 1.1;
    addAir(new Ellipsoid(h.x, h.floor + h.ry * 0.45, h.z, h.rx, h.ry, h.rz, h.rot, h.floor, amp));
    const level = hubWater(h);
    if (!Number.isNaN(level)) {
      // A basin under the floor (deeper if the water stands higher), and the lake that fills it
      const depth = Math.max(3.4, h.floor - level + 3.1);
      addAir(new Ellipsoid(h.x, h.floor - 0.3, h.z, h.rx * 0.62, depth, h.rz * 0.62, h.rot, NaN, 0.5));
      const r = Math.max(h.rx, h.rz) + 3;
      poolDefs.push({ level, minX: h.x - r, maxX: h.x + r, minZ: h.z - r, maxZ: h.z + r, minY: h.floor - depth - 2, seed: [h.x, Math.min(level - 1, h.floor - 1.2), h.z] });
    }
    if (h.kind === 'grand' && h.shelf && shelfDirs.has(h.id)) {
      const sd = shelfDir(h);
      const R = h.rx;
      const ux = sd.dz, uz = -sd.dx;
      // Slab's (ux, uz) is the across axis; v is derived as (-uz, ux) = the shelf direction
      addRock(new Slab(h.x, h.z, ux, uz, -0.02 * R, 0.64 * R, 0.5 * R, 1.35 * R, h.floor, SHELF_H, false));
      addRock(new Slab(h.x, h.z, ux, uz, -0.52 * R, -0.02 * R, 0.66 * R, 1.35 * R, h.floor, SHELF_H, true));
    }
  }
  for (const it of layout.items) if (it.t === 'pillar') addRock(new Pillar(it.x, it.z, it.r ?? 1.5, it.y));

  const at = (x: number, y: number, z: number) => field(x, y, z, index.airAt(x, z), index.rockAt(x, z));
  return { hubs, index, poolDefs, entrances, tunnelSpots, at };
}

// ------------------------------------------------------------------ water

interface WaterResult {
  pools: CavePool[];
  water: number[];
  waterBiome: number[];
  /** Same pools with the mask grown by 2 cells (to find wet rock along the shores). */
  wetPools: CavePool[];
}

/**
 * Each pool floods from its seed through connected air below its level (6-neighbour flood fill on a
 * 0.5 m grid). The surface is drawn only over the flooded columns, each square clipped to the rock
 * along the walls: no water poking through walls or appearing in an unrelated passage nearby.
 */
function buildWater(b: Built): WaterResult {
  const pools: CavePool[] = [];
  const wetPools: CavePool[] = [];
  const water: number[] = [];
  const waterBiome: number[] = [];
  const poly: number[] = [];
  const tmp: number[] = [];
  const xs = [0, 0, 0, 0], zs = [0, 0, 0, 0], vals = [0, 0, 0, 0];
  for (const p of b.poolDefs) {
    const minX = Math.floor(p.minX), minZ = Math.floor(p.minZ);
    const w = Math.ceil((p.maxX - minX) / WCELL), h = Math.ceil((p.maxZ - minZ) / WCELL);
    const K = Math.max(1, Math.ceil((p.level - p.minY) / WCELL));
    if (w <= 0 || h <= 0 || w * h * K > 4_000_000) continue;
    const plane = w * h;
    const state = new Uint8Array(plane * K); // 0 unknown, 1 air (flooded), 2 rock
    const isAir = (i: number, j: number, k: number) => b.at(minX + (i + 0.5) * WCELL, p.level - 0.25 - k * WCELL, minZ + (j + 0.5) * WCELL) < -0.02;
    // Seed: the nearest air voxel around the seed point
    let seed = -1;
    const si = Math.floor((p.seed[0] - minX) / WCELL), sj = Math.floor((p.seed[2] - minZ) / WCELL);
    const sk = Math.max(0, Math.min(K - 1, Math.round((p.level - 0.25 - p.seed[1]) / WCELL)));
    for (let r = 0; r <= 4 && seed < 0; r++) {
      for (let dk = -r; dk <= r && seed < 0; dk++) for (let dj = -r; dj <= r && seed < 0; dj++) for (let di = -r; di <= r && seed < 0; di++) {
        const i = si + di, j = sj + dj, k = sk + dk;
        if (i < 0 || j < 0 || k < 0 || i >= w || j >= h || k >= K) continue;
        if (isAir(i, j, k)) seed = (k * h + j) * w + i;
      }
    }
    if (seed < 0) continue;
    const queue = new Int32Array(Math.min(plane * K, 2_000_000));
    let qh = 0, qt = 0;
    state[seed] = 1;
    queue[qt++] = seed;
    let maxK = 0;
    while (qh < qt) {
      const v = queue[qh++];
      const i = v % w, j = Math.floor(v / w) % h, k = Math.floor(v / plane);
      if (k > maxK) maxK = k;
      for (let n = 0; n < 6; n++) {
        const ni = i + (n === 0 ? 1 : n === 1 ? -1 : 0);
        const nj = j + (n === 2 ? 1 : n === 3 ? -1 : 0);
        const nk = k + (n === 4 ? 1 : n === 5 ? -1 : 0);
        if (ni < 0 || nj < 0 || nk < 0 || ni >= w || nj >= h || nk >= K) continue;
        const v2 = (nk * h + nj) * w + ni;
        if (state[v2]) continue;
        if (isAir(ni, nj, nk)) {
          state[v2] = 1;
          if (qt < queue.length) queue[qt++] = v2;
        } else state[v2] = 2;
      }
    }
    // Columns the water fills, and the top layer (the surface)
    const mask = new Uint8Array(plane);
    const top = new Uint8Array(plane);
    for (let k = 0; k < K; k++) {
      for (let c = 0; c < plane; c++) {
        if (state[k * plane + c] !== 1) continue;
        mask[c] = 1;
        if (k === 0) top[c] = 1;
      }
    }
    const pool: CavePool = { level: p.level, minX, minZ, minY: p.level - 0.5 - maxK * WCELL, cell: WCELL, w, h, mask };
    pools.push(pool);
    // Shore mask: grown by two cells
    const grown = new Uint8Array(plane);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if (!mask[j * w + i]) continue;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const a = i + di, c = j + dj;
        if (a >= 0 && c >= 0 && a < w && c < h) grown[c * w + a] = 1;
      }
    }
    wetPools.push({ ...pool, mask: grown });

    // Surface: corner values at the level, each square clipped to where the field is (almost) air
    const corner = new Float32Array((w + 1) * (h + 1)).fill(NaN);
    const cv = (i: number, j: number) => {
      const k = j * (w + 1) + i;
      if (Number.isNaN(corner[k])) corner[k] = b.at(minX + i * WCELL, p.level, minZ + j * WCELL) - WATER_EDGE;
      return corner[k];
    };
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const c = j * w + i;
        const lit = top[c] || (i > 0 && top[c - 1]) || (i < w - 1 && top[c + 1]) || (j > 0 && top[c - w]) || (j < h - 1 && top[c + w]);
        if (!lit) continue;
        // Corners counter-clockwise seen from above: (i,j) (i,j+1) (i+1,j+1) (i+1,j)
        xs[0] = i; zs[0] = j; xs[1] = i; zs[1] = j + 1; xs[2] = i + 1; zs[2] = j + 1; xs[3] = i + 1; zs[3] = j;
        for (let q = 0; q < 4; q++) vals[q] = cv(xs[q], zs[q]);
        if (vals[0] >= 0 && vals[1] >= 0 && vals[2] >= 0 && vals[3] >= 0) continue;
        poly.length = 0;
        for (let e = 0; e < 4; e++) {
          const n = (e + 1) % 4;
          const va = vals[e], vb = vals[n];
          if (va < 0) poly.push(xs[e], zs[e]);
          if (va < 0 !== vb < 0) {
            const t = va / (va - vb);
            poly.push(xs[e] + (xs[n] - xs[e]) * t, zs[e] + (zs[n] - zs[e]) * t);
          }
        }
        if (poly.length < 6) continue;
        tmp.length = 0;
        for (let q = 0; q < poly.length; q += 2) tmp.push(minX + poly[q] * WCELL, minZ + poly[q + 1] * WCELL);
        for (let q = 2; q + 2 < tmp.length; q += 2) {
          for (const v of [0, q, q + 2]) {
            const x = tmp[v], z = tmp[v + 1];
            water.push(x, p.level, z);
            biomeWeights(x, z, _bw);
            waterBiome.push(_bw[0] * 255, _bw[1] * 255, _bw[2] * 255);
          }
        }
      }
    }
  }
  return { pools, water, waterBiome, wetPools };
}

function poolLookup(pools: CavePool[], x: number, y: number, z: number, above = 0.15): CavePool | null {
  for (const p of pools) {
    if (y > p.level + above || y < p.minY - 1) continue;
    const i = Math.floor((x - p.minX) / p.cell), j = Math.floor((z - p.minZ) / p.cell);
    if (i < 0 || j < 0 || i >= p.w || j >= p.h || !p.mask[j * p.w + i]) continue;
    return p;
  }
  return null;
}

// ------------------------------------------------------------------ items (procedural population)

const ORE: OreKind[][] = [['iron', 'copper', 'iron', 'gold'], ['crystal', 'gold', 'crystal', 'iron'], ['gold', 'iron', 'copper', 'gold']];

function populate(layout: CaveLayout, b: Built, pools: CavePool[], rnd: () => number): void {
  const { at } = b;
  const add = (it: Omit<LayoutItem, 'id'>) => {
    const item = { id: layout.nextItem++, ...it } as LayoutItem;
    item.x = r2(item.x);
    item.y = r2(item.y);
    item.z = r2(item.z);
    layout.items.push(item);
    return item;
  };
  /** Floor below an air point (null when the point is in rock or there is no floor within 19 m). */
  const floorBelow = (x: number, y: number, z: number): number | null => {
    if (at(x, y, z) > 0) return null;
    let yy = y;
    for (let i = 0; i < 160; i++) {
      const ny = yy - 0.12;
      if (at(x, ny, z) > 0) {
        let lo = ny, hi = yy;
        for (let k = 0; k < 5; k++) {
          const m = (lo + hi) / 2;
          if (at(x, m, z) > 0) lo = m;
          else hi = m;
        }
        return hi;
      }
      yy = ny;
    }
    return null;
  };
  const ceilingAbove = (x: number, y: number, z: number): number | null => {
    let yy = y;
    for (let i = 0; i < 100; i++) {
      const ny = yy + 0.2;
      if (at(x, ny, z) > 0) {
        let lo = yy, hi = ny;
        for (let k = 0; k < 5; k++) {
          const m = (lo + hi) / 2;
          if (at(x, m, z) > 0) hi = m;
          else lo = m;
        }
        return lo;
      }
      yy = ny;
    }
    return null;
  };
  /** A flat-enough floor spot with headroom, or null. */
  const spot = (x: number, yHint: number, z: number, clear = 1.8): number | null => {
    const y = floorBelow(x, yHint + 2.2, z);
    if (y === null || Math.abs(y - yHint) > 3.5) return null;
    if (at(x, y + clear, z) > -0.2) return null;
    const y1 = floorBelow(x + 0.5, y + 1, z), y2 = floorBelow(x, y + 1, z + 0.5);
    if (y1 === null || y2 === null || Math.abs(y1 - y) > 0.35 || Math.abs(y2 - y) > 0.35) return null;
    return y;
  };
  const poolAt = (x: number, y: number, z: number) => poolLookup(pools, x, y, z);
  const keep = new Map<string, { x: number; z: number; r: number }[]>();
  for (const h of layout.hubs) keep.set(h.id, hubKeepOut(h, layout, b.hubs));
  for (const it of layout.items) if (it.t === 'pillar' && it.hub) keep.get(it.hub)?.push({ x: it.x, z: it.z, r: 3 });
  const keptOut = (h: LayoutHub, x: number, z: number, extra = 0) => keep.get(h.id)!.some((k) => Math.hypot(k.x - x, k.z - z) < k.r + extra);
  const localPoint = (h: LayoutHub, a: number, frac: number) => {
    const lx = Math.cos(a) * h.rx * frac, lz = Math.sin(a) * h.rz * frac;
    const c = Math.cos(h.rot), s = Math.sin(h.rot);
    return { x: h.x + lx * c - lz * s, z: h.z + lx * s + lz * c };
  };
  const scatter = (h: LayoutHub, count: number, f0: number, f1: number, clear: number, each: (x: number, y: number, z: number, i: number) => boolean | void) => {
    let placed = 0;
    for (let i = 0; i < count * 8 && placed < count; i++) {
      const p = localPoint(h, rnd() * Math.PI * 2, f0 + rnd() * (f1 - f0));
      if (keptOut(h, p.x, p.z)) continue;
      const y = spot(p.x, h.floor, p.z, clear);
      if (y === null || poolAt(p.x, y, p.z)) continue;
      if (each(p.x, y, p.z, placed) !== false) placed++;
    }
  };

  const chambers = layout.hubs.filter((h) => !h.entrance);
  const entryHubs = layout.hubs.filter((h) => h.entrance);
  // Treasure: the three chambers farthest from any entrance, preferring different biomes
  const distToEntry = (h: LayoutHub) => (entryHubs.length ? Math.min(...entryHubs.map((e) => Math.hypot(e.x - h.x, e.z - h.z))) : 0);
  const far = [...chambers].sort((p, q) => distToEntry(q) - distToEntry(p));
  const treasureIds = ['cave1', 'cave2', 'cave3'];
  const usedBiomes = new Set<number>();
  const hasChest = new Set<string>();
  let chests = 0;
  for (const pass of [0, 1]) {
    for (const h of far) {
      if (chests >= treasureIds.length) break;
      const biome = dominantBiome(h.x, h.z);
      if (hasChest.has(h.id) || (pass === 0 && usedBiomes.has(biome))) continue;
      let pos: Vec3 | null = null;
      let yaw = 0;
      if (h.kind === 'grand' && h.shelf && shelfDirs.has(h.id)) {
        // On the gallery: the reward for finding the way up
        const sd = shelfDir(h);
        const R = h.rx, ux = sd.dz, uz = -sd.dx;
        const x = h.x + ux * 0.46 * R + sd.dx * 0.78 * R, z = h.z + uz * 0.46 * R + sd.dz * 0.78 * R;
        const y = floorBelow(x, h.floor + SHELF_H + 1.5, z);
        if (y !== null && y > h.floor + SHELF_H - 0.6) {
          pos = [x, y, z];
          yaw = Math.atan2(-sd.dx, -sd.dz);
        }
      }
      for (let i = 0; !pos && i < 30; i++) {
        const a = rnd() * Math.PI * 2;
        const p = localPoint(h, a, 0.55 + rnd() * 0.2);
        if (keptOut(h, p.x, p.z, 0.5)) continue;
        const y = spot(p.x, h.floor, p.z, 1.6);
        if (y === null || poolAt(p.x, y, p.z)) continue;
        pos = [p.x, y, p.z];
        yaw = Math.atan2(h.x - p.x, h.z - p.z);
      }
      if (!pos) continue;
      add({ t: 'chest', x: pos[0], y: pos[1], z: pos[2], yaw: r2(yaw), chest: treasureIds[chests], hub: h.id });
      chests++;
      hasChest.add(h.id);
      keep.get(h.id)!.push({ x: pos[0], z: pos[2], r: 2 });
      usedBiomes.add(biome);
    }
  }

  let cones = 0;
  // Content in every chamber, and in the lake you surface in after the underwater way in
  for (const h of [...chambers, ...entryHubs.filter((e) => e.kind === 'lake')]) {
    const bio = dominantBiome(h.x, h.z);
    const area = h.rx * h.rz;
    const hub = h.id;
    const level = hubWater(h);
    if (!h.entrance) {
      scatter(h, h.kind === 'grand' ? 4 : 3, 0.5, 0.82, 1.8, (x, y, z, i) => {
        add({ t: 'ore', x, y, z, ore: ORE[bio][i % 4], hub });
        keep.get(h.id)!.push({ x, z, r: 1.6 });
      });
    }
    if (bio === 1) {
      scatter(h, 6 + Math.floor(rnd() * 4), 0.6, 0.95, 1.2, (x, y, z) => {
        add({ t: 'crystal', x, y, z, color: rnd() < 0.5 ? 0 : 1, size: r2(0.9 + rnd() * 0.9), hub });
      });
    } else {
      scatter(h, 1 + Math.floor(rnd() * 2), 0.6, 0.95, 1.2, (x, y, z) => {
        add({ t: 'crystal', x, y, z, color: bio === 0 ? 2 : 3, size: r2(0.7 + rnd() * 0.5), hub });
      });
    }
    if (bio === 0) {
      // Glowing mushroom patches: a few clusters around one soft light
      scatter(h, 3 + Math.floor(rnd() * 3), 0.35, 0.85, 1.4, (x, y, z) => {
        let n = 0;
        for (let k = 0; k < 6 && n < 3; k++) {
          const mx = x + (rnd() - 0.5) * 2.2, mz = z + (rnd() - 0.5) * 2.2;
          const my = spot(mx, y, mz, 1.2);
          if (my === null || keptOut(h, mx, mz)) continue;
          add({ t: 'mushroom', x: mx, y: my, z: mz, glow: n === 0 || undefined, hub });
          n++;
        }
        if (n === 0) return false;
      });
    }
    if (bio === 2) {
      scatter(h, 3 + Math.floor(rnd() * 3), 0.3, 0.9, 1.4, (x, y, z) => {
        add({ t: 'ember', x, y, z, hub });
        keep.get(h.id)!.push({ x, z, r: 1.4 });
      });
    }

    // Stalactites from the ceiling, many with a stalagmite growing up under them; the flooded caverns
    // drip a lot more
    const nCones = Math.round(area / (bio === 1 ? 7 : bio === 2 ? 14 : 10));
    const dripChance = bio === 1 ? 0.3 : 0.15;
    const lookFrom = Number.isNaN(level) ? h.floor + 2 : Math.max(h.floor, level) + 2;
    for (let i = 0; i < nCones * 2 && cones < 2600; i++) {
      const p = localPoint(h, rnd() * Math.PI * 2, Math.sqrt(rnd()) * 0.92);
      const fy = floorBelow(p.x, lookFrom, p.z);
      if (fy === null) continue;
      const cy = ceilingAbove(p.x, fy + 0.5, p.z);
      if (cy === null) continue;
      const water = poolAt(p.x, fy, p.z);
      const ground = water ? Math.max(fy, water.level) : fy;
      const height = cy - ground;
      if (height < 3.2) continue;
      const slender = bio === 1 ? 0.12 : 0.18;
      let len = Math.min(height * (0.12 + rnd() * 0.25), 3.8);
      if (height - len < 2.6) len = height - 2.6; // never down into a walker's (or swimmer's) head
      if (len < 0.5) continue;
      const r = len * slender * (0.8 + rnd() * 0.5) + 0.08;
      add({ t: 'stalactite', x: p.x, y: cy + 0.25, z: p.z, len: r2(len + 0.25), r: r2(r), bx: r2((rnd() - 0.5) * 0.15), bz: r2((rnd() - 0.5) * 0.15), drip: rnd() < dripChance || undefined, hub });
      cones++;
      if (!water && rnd() < 0.45 && !keptOut(h, p.x, p.z, 0.8)) {
        const ml = Math.min(height - len - 1.2, 0.5 + rnd() * 1.6);
        if (ml > 0.35) {
          add({ t: 'stalagmite', x: p.x + (rnd() - 0.5) * 0.3, y: fy - 0.25, z: p.z + (rnd() - 0.5) * 0.3, len: r2(ml + 0.25), r: r2(ml * 0.32 + 0.12), hub });
          cones++;
        }
      }
    }
    if (!Number.isNaN(level)) {
      // Drops into the lake from the ceiling
      for (let i = 0; i < (bio === 1 ? 5 : 3); i++) {
        const p = localPoint(h, rnd() * Math.PI * 2, rnd() * 0.5);
        const pool = poolAt(p.x, level - 0.5, p.z);
        const cy = ceilingAbove(p.x, level + 0.5, p.z);
        if (pool && cy !== null) add({ t: 'drip', x: p.x, y: cy - 0.05, z: p.z, hub });
      }
    }
  }

  // Tunnels: a few cones along the walls, and the odd mushroom / ember / crystal
  for (const s of b.tunnelSpots) {
    const bio = dominantBiome(s.x, s.z);
    if (rnd() < (bio === 1 ? 0.7 : 0.55)) {
      const cy = ceilingAbove(s.x, s.f + 1, s.z);
      if (cy !== null && cy - s.f > 3.3) {
        const len = Math.min(cy - s.f - 2.5, 0.6 + rnd() * 1.2);
        if (len > 0.4) {
          const ox = (rnd() - 0.5) * s.r * 0.8, x = s.x - s.dz * ox, z = s.z + s.dx * ox;
          const cy2 = ceilingAbove(x, s.f + 1, z);
          if (cy2 !== null && cy2 - s.f > len + 2.5) {
            add({ t: 'stalactite', x, y: cy2 + 0.25, z, len: r2(len + 0.25), r: r2(len * 0.17 + 0.08), bx: 0, bz: 0, drip: rnd() < (bio === 1 ? 0.25 : 0.15) || undefined });
          }
        }
      }
    }
    if (!s.plain) continue;
    const side = rnd() < 0.5 ? -1 : 1;
    const x = s.x - s.dz * side * s.r * 0.72, z = s.z + s.dx * side * s.r * 0.72;
    const y = spot(x, s.f, z, 1.2);
    if (y === null || poolAt(x, y, z)) continue;
    const roll = rnd();
    if (roll < 0.3) add({ t: 'stalagmite', x, y: y - 0.25, z, len: r2(0.6 + rnd() * 0.9), r: r2(0.25 + rnd() * 0.15) });
    else if (roll < 0.45 && bio === 0) add({ t: 'mushroom', x, y, z, glow: true });
    else if (roll < 0.45 && bio === 2) add({ t: 'ember', x, y, z });
    else if (roll < 0.45) add({ t: 'crystal', x, y, z, color: rnd() < 0.5 ? 0 : 1, size: r2(0.6 + rnd() * 0.4) });
  }
}

// ------------------------------------------------------------------ deriving contents from items

interface Cone {
  x: number;
  y: number;
  z: number;
  up: boolean;
  len: number;
  r: number;
  bx: number;
  bz: number;
}

/** The stalactites and stalagmites of a layout (meshed into the rock chunks). */
function layoutCones(layout: CaveLayout): Cone[] {
  const cones: Cone[] = [];
  for (const it of layout.items) {
    if (it.t !== 'stalactite' && it.t !== 'stalagmite') continue;
    cones.push({ x: it.x, y: it.y, z: it.z, up: it.t === 'stalagmite', len: it.len ?? 1, r: it.r ?? 0.3, bx: it.bx ?? 0, bz: it.bz ?? 0 });
  }
  return cones;
}

function deriveContents(layout: CaveLayout, b: Built, pools: CavePool[]) {
  const ores: CaveGenOutput['ores'] = [];
  const mushrooms: Vec3[] = [];
  const crystals: CaveGenOutput['crystals'] = [];
  const embers: Vec3[] = [];
  const lights: CaveLight[] = [];
  const chests: CaveGenOutput['chests'] = [];
  const drips: number[] = [];
  const landing = (x: number, y: number, z: number): [number, number] => {
    // First rock or water below the tip
    for (let yy = y - 0.15; yy > y - 30; yy -= 0.2) {
      const pool = poolLookup(pools, x, yy, z, 0);
      if (pool && yy <= pool.level) return [pool.level, 1];
      if (b.at(x, yy, z) > 0) return [yy + 0.1, 0];
    }
    return [y - 30, 0];
  };
  for (const it of layout.items) {
    switch (it.t) {
      case 'chest':
        chests.push({ id: it.chest ?? 'cave1', pos: [it.x, it.y, it.z], yaw: it.yaw ?? 0 });
        break;
      case 'ore':
        ores.push({ pos: [it.x, it.y, it.z], kind: it.ore ?? 'iron' });
        break;
      case 'mushroom':
        mushrooms.push([it.x, it.y, it.z]);
        if (it.glow) lights.push({ x: it.x, y: it.y + 0.5, z: it.z, range: 4.5, halo: 0.8, intensity: 0.8, color: [0.35, 0.95, 0.9] });
        break;
      case 'crystal': {
        const color = it.color ?? 0;
        const size = it.size ?? 1;
        crystals.push({ pos: [it.x, it.y, it.z], color, size });
        const c = CRYSTAL_COLORS[color] ?? CRYSTAL_COLORS[0];
        const k = color <= 1 ? 1.4 : 1.3;
        lights.push({ x: it.x, y: it.y + 0.4 + size * 0.3, z: it.z, range: 3.5 + size * 3, halo: 0.6 + size * 0.5, intensity: 0.85 + size * 0.15, color: [c[0] * k, c[1] * k, c[2] * k] });
        break;
      }
      case 'ember':
        embers.push([it.x, it.y, it.z]);
        lights.push({ x: it.x, y: it.y + 0.6, z: it.z, range: 6.5, halo: 1.4, intensity: 1.2, color: [1.6, 0.55, 0.15], flicker: true });
        break;
      case 'light':
        lights.push({ x: it.x, y: it.y, z: it.z, range: it.range ?? 8, halo: 0.6, intensity: it.intensity ?? 1, color: it.rgb ?? [1, 0.85, 0.6], flicker: it.flicker });
        break;
      case 'stalactite':
      case 'stalagmite': {
        const len = it.len ?? 1;
        if (it.t === 'stalactite' && it.drip) {
          const tx = it.x + (it.bx ?? 0) * len, ty = it.y - len, tz = it.z + (it.bz ?? 0) * len;
          const [ly, inWater] = landing(tx, ty, tz);
          drips.push(tx, ty, tz, ly, inWater);
        }
        break;
      }
      case 'drip': {
        const [ly, inWater] = landing(it.x, it.y, it.z);
        drips.push(it.x, it.y, it.z, ly, inWater);
        break;
      }
      default:
        break;
    }
  }
  // A faint biome glow fills big halls so their size reads in the dark
  for (const h of layout.hubs) {
    if (h.kind === 'chamber') continue;
    biomeWeights(h.x, h.z, _bw);
    const tint: Vec3 = [0.25 * _bw[0] + 0.25 * _bw[1] + 0.6 * _bw[2], 0.5 * _bw[0] + 0.55 * _bw[1] + 0.3 * _bw[2], 0.45 * _bw[0] + 0.8 * _bw[1] + 0.15 * _bw[2]];
    const wet = _bw[1] > 0.5 && !Number.isNaN(hubWater(h));
    lights.push({ x: h.x, y: h.floor + h.ry * 0.9, z: h.z, range: Math.max(h.rx, h.rz) * 1.3, halo: 0, intensity: wet ? 0.5 : 0.35, color: tint });
  }
  for (const en of b.entrances) {
    for (const t of en.torches) lights.push({ x: t[0], y: t[1] + 1.5, z: t[2], range: 8, halo: 1.6, intensity: 1.2, flicker: true });
    const inx = Math.sin(en.yaw), inz = Math.cos(en.yaw);
    lights.push({
      x: en.glow[0] + inx * 1.2,
      y: en.glow[1],
      z: en.glow[2] + inz * 1.2,
      range: en.underwater ? 10 : 8,
      halo: 0,
      intensity: 0.9,
      color: en.underwater ? [0.3, 0.75, 0.9] : [0.75, 0.85, 1.0],
    });
  }
  return { ores, mushrooms, crystals, embers, lights, chests, drips };
}

// ------------------------------------------------------------------ meshing

const NCX = Math.ceil((NPX - 1) / C), NCY = Math.ceil((NPY - 1) / C), NCZ = Math.ceil((NPZ - 1) / C);

/** The field box a chunk samples (its cells plus 2 on each side), padded for the candidate query. */
function chunkBox(cx: number, cy: number, cz: number, box: Box): Box {
  const x0 = cx * C - 2, y0 = cy * C - 2, z0 = cz * C - 2;
  box.minX = G0X + x0 * CELL - 3;
  box.maxX = G0X + (x0 + S - 1) * CELL + 3;
  box.minY = G0Y + y0 * CELL - 3;
  box.maxY = G0Y + (y0 + S - 1) * CELL + 3;
  box.minZ = G0Z + z0 * CELL - 3;
  box.maxZ = G0Z + (z0 + S - 1) * CELL + 3;
  return box;
}

/** Distance from the nearest entrance spawn to a chunk's centre (for ordering the work). */
export function chunkEntranceDistance(key: number, spawns: Vec3[]): number {
  const cx = key % 64, cy = Math.floor(key / 64) % 64, cz = Math.floor(key / 4096);
  const mx = G0X + (cx + 0.5) * C * CELL, my = G0Y + (cy + 0.5) * C * CELL, mz = G0Z + (cz + 0.5) * C * CELL;
  let d = Infinity;
  for (const p of spawns) d = Math.min(d, Math.hypot(p[0] - mx, (p[1] - my) * 1.5, p[2] - mz));
  return d;
}

/**
 * The chunks worth meshing (near air), nearest to an entrance first, and with `dirty` the chunks
 * that must go without a replacement (now solid). Cheap: no noise, 125 raw samples per chunk.
 */
function listChunks(b: Built, dirty: Box[] | null): { mesh: number[]; clear: number[] } {
  const qa: AirPrim[] = [], qr: RockPrim[] = [];
  const box: Box = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  const mesh: { key: number; d: number }[] = [];
  const clear: number[] = [];
  const spawns = b.entrances.map((e) => e.spawn);
  const s = (S - 1) / 4;
  for (let cz = 0; cz < NCZ; cz++) {
    for (let cy = 0; cy < NCY; cy++) {
      for (let cx = 0; cx < NCX; cx++) {
        chunkBox(cx, cy, cz, box);
        if (dirty && !dirty.some((d) => overlaps(d, box))) continue;
        const key = chunkKey(cx, cy, cz);
        b.index.query(box, qa, qr);
        let nearAir = false;
        const x0 = cx * C - 2, y0 = cy * C - 2, z0 = cz * C - 2;
        for (let k = 0; k <= 4 && !nearAir && qa.length; k++) {
          for (let j = 0; j <= 4 && !nearAir; j++) {
            for (let i = 0; i <= 4 && !nearAir; i++) {
              if (rawAir(G0X + (x0 + i * s) * CELL, G0Y + (y0 + j * s) * CELL, G0Z + (z0 + k * s) * CELL, qa) < COARSE_SKIP) nearAir = true;
            }
          }
        }
        if (!nearAir) {
          if (dirty) clear.push(key);
          continue;
        }
        mesh.push({ key, d: chunkEntranceDistance(key, spawns) });
      }
    }
  }
  mesh.sort((p, q) => p.d - q.d);
  return { mesh: mesh.map((m) => m.key), clear };
}

/** Scratch buffers for meshing one chunk after another. */
class Mesher {
  private readonly qa: AirPrim[] = [];
  private readonly qr: RockPrim[] = [];
  private readonly f = new Float32Array(S * S * S);
  private readonly cellVert = new Int32Array((C + 2) * (C + 2) * (C + 2));
  private readonly box: Box = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  private readonly v8 = new Float32Array(8);
  private readonly conesByChunk = new Map<number, Cone[]>();

  constructor(private readonly b: Built, cones: Cone[], private readonly wetPools: CavePool[]) {
    for (const c of cones) {
      const key = chunkKey(Math.floor((c.x - G0X) / CELL / C), Math.floor((c.y - G0Y) / CELL / C), Math.floor((c.z - G0Z) / CELL / C));
      let l = this.conesByChunk.get(key);
      if (!l) this.conesByChunk.set(key, (l = []));
      l.push(c);
    }
  }

  private wetAt(x: number, y: number, z: number): number {
    const p = poolLookup(this.wetPools, x, y, z, WET_ABOVE);
    if (!p) return 0;
    return 1 + Math.round(clamp01((p.level - y + WET_ABOVE) / WET_RANGE) * 254);
  }

  /** Surface Nets mesh of one chunk, or null when it holds no surface. */
  public mesh(key: number): CaveChunk | null {
    const { f, cellVert, v8, qa, qr } = this;
    const cx = key % 64, cy = Math.floor(key / 64) % 64, cz = Math.floor(key / 4096);
    const x0 = cx * C - 2, y0 = cy * C - 2, z0 = cz * C - 2;
    this.b.index.query(chunkBox(cx, cy, cz, this.box), qa, qr);
    if (qa.length === 0) return null;
    const fi = (i: number, j: number, k: number) => (k * S + j) * S + i;

    let neg = false, pos = false;
    for (let k = 0, n = 0; k < S; k++) {
      const z = G0Z + (z0 + k) * CELL;
      for (let j = 0; j < S; j++) {
        const y = G0Y + (y0 + j) * CELL;
        for (let i = 0; i < S; i++, n++) {
          const v = field(G0X + (x0 + i) * CELL, y, z, qa, qr);
          f[n] = v;
          if (v < 0) neg = true;
          else pos = true;
        }
      }
    }
    if (!neg || !pos) return null;

    // A lattice value: from this chunk's samples, or (just beyond them) the exact field at the same
    // lattice point, so neighbouring chunks agree on every value they share
    const lat = (gi: number, gj: number, gk: number): number => {
      const i = gi - x0, j = gj - y0, k = gk - z0;
      if (i >= 0 && j >= 0 && k >= 0 && i < S && j < S && k < S) return f[fi(i, j, k)];
      return field(G0X + gi * CELL, G0Y + gj * CELL, G0Z + gk * CELL, qa, qr);
    };
    /** Trilinear field from the lattice (ambient occlusion: no fresh noise per sample). */
    const fieldAt = (x: number, y: number, z: number): number => {
      const u = (x - G0X) / CELL, v = (y - G0Y) / CELL, w = (z - G0Z) / CELL;
      const i = Math.floor(u), j = Math.floor(v), k = Math.floor(w);
      const tx = u - i, ty = v - j, tz = w - k;
      const c000 = lat(i, j, k), c100 = lat(i + 1, j, k), c010 = lat(i, j + 1, k), c110 = lat(i + 1, j + 1, k);
      const c001 = lat(i, j, k + 1), c101 = lat(i + 1, j, k + 1), c011 = lat(i, j + 1, k + 1), c111 = lat(i + 1, j + 1, k + 1);
      const a = c000 + (c100 - c000) * tx, bq = c010 + (c110 - c010) * tx;
      const c = c001 + (c101 - c001) * tx, d = c011 + (c111 - c011) * tx;
      const e = a + (bq - a) * ty, g = c + (d - c) * ty;
      return e + (g - e) * tz;
    };

    // Surface Nets vertices for cells 1..C+1 (local), normals from the field gradient
    const positions: number[] = [];
    const normals: number[] = [];
    const data: number[] = [];
    const wet: number[] = [];
    cellVert.fill(-1);
    const cvi = (i: number, j: number, k: number) => ((k - 1) * (C + 2) + (j - 1)) * (C + 2) + (i - 1);
    for (let k = 1; k <= C + 1; k++) {
      for (let j = 1; j <= C + 1; j++) {
        for (let i = 1, base = fi(1, j, k); i <= C + 1; i++, base++) {
          // Quick reject: the cell's corners all on one side
          const below = f[base] < 0;
          let mixed = false;
          for (let c = 1; c < 8; c++) {
            if (f[base + OFF[c]] < 0 !== below) {
              mixed = true;
              break;
            }
          }
          if (!mixed) continue;
          for (let c = 0; c < 8; c++) v8[c] = f[base + OFF[c]];
          let sx = 0, sy = 0, sz = 0, n = 0;
          for (let e = 0; e < 12; e++) {
            const a = EDGE_A[e], bb = EDGE_B[e];
            if (v8[a] < 0 === v8[bb] < 0) continue;
            const t = v8[a] / (v8[a] - v8[bb]);
            sx += CX[a] + (CX[bb] - CX[a]) * t;
            sy += CY[a] + (CY[bb] - CY[a]) * t;
            sz += CZ[a] + (CZ[bb] - CZ[a]) * t;
            n++;
          }
          sx /= n;
          sy /= n;
          sz /= n;
          // Trilinear blend of the corner gradients (central differences on the grid)
          let gx = 0, gy = 0, gz = 0;
          for (let c = 0; c < 8; c++) {
            const q = base + OFF[c];
            const w = (CX[c] ? sx : 1 - sx) * (CY[c] ? sy : 1 - sy) * (CZ[c] ? sz : 1 - sz);
            gx += (f[q + 1] - f[q - 1]) * w;
            gy += (f[q + S] - f[q - S]) * w;
            gz += (f[q + S * S] - f[q - S * S]) * w;
          }
          const gl = Math.hypot(gx, gy, gz) || 1;
          const nx = -gx / gl, ny = -gy / gl, nz = -gz / gl;
          const px = G0X + (x0 + i + sx) * CELL, py = G0Y + (y0 + j + sy) * CELL, pz = G0Z + (z0 + k + sz) * CELL;
          cellVert[cvi(i, j, k)] = positions.length / 3;
          positions.push(px, py, pz);
          normals.push(nx, ny, nz);
          // Ambient occlusion: how much rock crowds the space off the surface
          let occ = 0;
          for (let a = 0; a < 3; a++) {
            const dist = AO_DIST[a];
            const v = fieldAt(px + nx * dist, py + ny * dist, pz + nz * dist);
            occ += (Math.max(0, dist - Math.max(0, -v)) / dist) * AO_W[a];
          }
          biomeWeights(px, pz, _bw);
          data.push(_bw[0] * 255, _bw[1] * 255, _bw[2] * 255, Math.max(0.2, 1 - occ * 0.85) * 255);
          wet.push(this.wetAt(px, py, pz));
        }
      }
    }

    // One quad per sign-changing grid edge owned by this chunk, facing the air
    const indices: number[] = [];
    const quad = (a: number, bq: number, c: number, d: number, flip: boolean) => {
      if (a < 0 || bq < 0 || c < 0 || d < 0) return;
      if (flip) indices.push(a, bq, c, a, c, d);
      else indices.push(a, c, bq, a, d, c);
    };
    const cv = (i: number, j: number, k: number) => cellVert[cvi(i, j, k)];
    for (let k = 2; k < C + 2; k++) {
      for (let j = 2; j < C + 2; j++) {
        for (let i = 2; i < C + 2; i++) {
          const inside = f[fi(i, j, k)] < 0;
          if (inside !== f[fi(i + 1, j, k)] < 0) quad(cv(i, j - 1, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i, j - 1, k), !inside);
          if (inside !== f[fi(i, j + 1, k)] < 0) quad(cv(i - 1, j, k - 1), cv(i - 1, j, k), cv(i, j, k), cv(i, j, k - 1), !inside);
          if (inside !== f[fi(i, j, k + 1)] < 0) quad(cv(i - 1, j - 1, k), cv(i, j - 1, k), cv(i, j, k), cv(i - 1, j, k), !inside);
        }
      }
    }
    if (indices.length === 0) return null;

    // Cones whose base lies in this chunk: stalagmites collide, stalactites only render
    const hanging: number[] = [];
    for (const c of this.conesByChunk.get(key) ?? []) {
      const before = positions.length / 3;
      addCone(c, positions, normals, data, c.up ? indices : hanging);
      const w = this.wetAt(c.x, c.up ? c.y + 0.3 : c.y - c.len, c.z);
      for (let v = before; v < positions.length / 3; v++) wet.push(w);
    }
    const colliderIndexCount = indices.length;
    for (const i of hanging) indices.push(i);
    if (positions.length / 3 > 65535) return null; // cannot happen at this chunk size; stay safe

    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
    for (let p = 0; p < positions.length; p += 3) {
      bx0 = Math.min(bx0, positions[p]);
      bx1 = Math.max(bx1, positions[p]);
      by0 = Math.min(by0, positions[p + 1]);
      by1 = Math.max(by1, positions[p + 1]);
      bz0 = Math.min(bz0, positions[p + 2]);
      bz1 = Math.max(bz1, positions[p + 2]);
    }
    return {
      key,
      cx: (bx0 + bx1) / 2,
      cy: (by0 + by1) / 2,
      cz: (bz0 + bz1) / 2,
      radius: Math.hypot(bx1 - bx0, by1 - by0, bz1 - bz0) / 2,
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      data: new Uint8Array(data),
      wet: new Uint8Array(wet),
      indices: new Uint16Array(indices),
      colliderIndexCount,
    };
  }
}

/** A tapered, slightly bent cone hanging from the ceiling (or growing from the floor). */
function addCone(c: Cone, positions: number[], normals: number[], data: number[], indices: number[]): void {
  const SIDES = 7, RINGS = 4;
  const base = positions.length / 3;
  const dir = c.up ? 1 : -1;
  biomeWeights(c.x, c.z, _bw);
  const b0 = _bw[0] * 255, b1 = _bw[1] * 255, b2 = _bw[2] * 255;
  const phase = c.x * 3.1 + c.z * 1.7;
  for (let k = 0; k < RINGS; k++) {
    const s = k / RINGS;
    const rr = c.r * Math.pow(1 - s, 1.25) * (1 + 0.12 * Math.sin(s * 9 + phase));
    const y = c.y + dir * c.len * s;
    const ox = c.bx * s * s * c.len, oz = c.bz * s * s * c.len;
    const slopeY = (dir * c.r * 1.25 * Math.pow(Math.max(1e-3, 1 - s), 0.25)) / c.len;
    for (let a = 0; a < SIDES; a++) {
      const ang = (a / SIDES) * Math.PI * 2 + phase;
      const cx = Math.cos(ang), sz = Math.sin(ang);
      positions.push(c.x + ox + cx * rr, y, c.z + oz + sz * rr);
      const nl = Math.hypot(1, slopeY);
      normals.push(cx / nl, slopeY / nl, sz / nl);
      data.push(b0, b1, b2, (0.55 + 0.4 * s) * 255);
    }
  }
  const tip = positions.length / 3;
  positions.push(c.x + c.bx * c.len, c.y + dir * c.len, c.z + c.bz * c.len);
  normals.push(0, dir, 0);
  data.push(b0, b1, b2, 245);
  for (let k = 0; k < RINGS; k++) {
    for (let a = 0; a < SIDES; a++) {
      const a1 = (a + 1) % SIDES;
      const v00 = base + k * SIDES + a, v01 = base + k * SIDES + a1;
      if (k === RINGS - 1) {
        if (c.up) indices.push(v00, tip, v01);
        else indices.push(v00, v01, tip);
        continue;
      }
      const v10 = base + (k + 1) * SIDES + a, v11 = base + (k + 1) * SIDES + a1;
      if (c.up) indices.push(v00, v10, v11, v00, v11, v01);
      else indices.push(v00, v11, v10, v00, v01, v11);
    }
  }
}

// ------------------------------------------------------------------ editing support

/** Rough space a hub's rock and water take up. */
export function hubBox(h: LayoutHub): Box {
  const r = Math.max(h.rx, h.rz) + 5;
  const lvl = hubWater(h);
  const low = Number.isNaN(lvl) ? h.floor - 6 : Math.min(h.floor, lvl) - 9;
  return { minX: h.x - r, maxX: h.x + r, minY: low, maxY: h.floor + h.ry + 5, minZ: h.z - r, maxZ: h.z + r };
}

function tunnelBox(hubs: Map<string, LayoutHub>, t: LayoutTunnel): Box | null {
  const g = tunnelGeometry(hubs, t);
  if (!g) return null;
  const pad = t.radius + Math.abs(t.wig) + 6;
  return {
    minX: Math.min(g.A.x, g.B.x) - pad,
    maxX: Math.max(g.A.x, g.B.x) + pad,
    minY: Math.min(g.A.y, g.B.y) - 11,
    maxY: Math.max(g.A.y, g.B.y) + 10,
    minZ: Math.min(g.A.z, g.B.z) - pad,
    maxZ: Math.max(g.A.z, g.B.z) + pad,
  };
}

/** The part of the rock an item shapes (null for items that are not rock). */
export function itemBox(it: LayoutItem): Box | null {
  if (it.t === 'pillar') {
    const r = (it.r ?? 1.5) + 4;
    return { minX: it.x - r, maxX: it.x + r, minY: it.y - 3, maxY: it.y + 26, minZ: it.z - r, maxZ: it.z + r };
  }
  if (it.t === 'stalactite' || it.t === 'stalagmite') {
    const len = it.len ?? 1, r = (it.r ?? 0.3) + len * 0.2 + 1.5;
    const y0 = it.t === 'stalactite' ? it.y - len - 1 : it.y - 1;
    const y1 = it.t === 'stalactite' ? it.y + 1 : it.y + len + 1;
    return { minX: it.x - r, maxX: it.x + r, minY: y0, maxY: y1, minZ: it.z - r, maxZ: it.z + r };
  }
  return null;
}

function tunnelSig(hubs: Map<string, LayoutHub>, t: LayoutTunnel): string {
  return JSON.stringify(t) + JSON.stringify(hubs.get(t.a)) + JSON.stringify(hubs.get(t.b));
}

/**
 * Where two layouts differ in rock or water (the chunks to re-mesh). null: everything (the biomes
 * moved, which recolours every vertex).
 */
export function layoutDirtyBoxes(prev: CaveLayout, next: CaveLayout, entrances: CaveEntranceIn[]): Box[] | null {
  if (JSON.stringify(prev.biomes) !== JSON.stringify(next.biomes)) return null;
  const boxes: Box[] = [];
  const porch = (h: LayoutHub) => {
    const e = entrances.find((en) => en.id === h.entrance);
    if (!e) return;
    boxes.push({
      minX: Math.min(e.x, h.x) - h.rx - 6,
      maxX: Math.max(e.x, h.x) + h.rx + 6,
      minY: Math.min(e.y, h.floor) - 10,
      maxY: Math.max(e.y, h.floor) + 10,
      minZ: Math.min(e.z, h.z) - h.rz - 6,
      maxZ: Math.max(e.z, h.z) + h.rz + 6,
    });
  };
  // Previous geometry first (tunnel ends depend on the shelves of that layout)
  const ph = prepareLayoutGeometry(prev);
  const prevHubs = new Map(prev.hubs.map((h) => [h.id, { s: JSON.stringify(h), h }]));
  const prevTunnels = new Map(prev.tunnels.map((t) => [t.id, { s: tunnelSig(ph, t), box: tunnelBox(ph, t) }]));
  const nh = prepareLayoutGeometry(next);
  const seen = new Set<string>();
  for (const h of next.hubs) {
    seen.add(h.id);
    const p = prevHubs.get(h.id);
    if (p && p.s === JSON.stringify(h)) continue;
    boxes.push(hubBox(h));
    if (p) boxes.push(hubBox(p.h));
    if (h.entrance) {
      porch(h);
      if (p) porch(p.h);
    }
  }
  for (const h of prev.hubs) {
    if (seen.has(h.id)) continue;
    boxes.push(hubBox(h));
    if (h.entrance) porch(h);
  }
  const seenT = new Set<string>();
  for (const t of next.tunnels) {
    seenT.add(t.id);
    const p = prevTunnels.get(t.id);
    if (p && p.s === tunnelSig(nh, t)) continue;
    const nb = tunnelBox(nh, t);
    if (nb) boxes.push(nb);
    if (p?.box) boxes.push(p.box);
  }
  for (const [id, p] of prevTunnels) if (!seenT.has(id) && p.box) boxes.push(p.box);
  const prevItems = new Map(prev.items.map((i) => [i.id, i]));
  const nextIds = new Set<number>();
  for (const it of next.items) {
    nextIds.add(it.id);
    const p = prevItems.get(it.id);
    if (p && JSON.stringify(p) === JSON.stringify(it)) continue;
    const nb = itemBox(it);
    if (nb) boxes.push(nb);
    const pb = p ? itemBox(p) : null;
    if (pb) boxes.push(pb);
  }
  for (const [id, it] of prevItems) {
    if (nextIds.has(id)) continue;
    const pb = itemBox(it);
    if (pb) boxes.push(pb);
  }
  return boxes;
}

/** A layout read from caves.json is used only if it looks like one. */
export function isCaveLayout(v: unknown): v is CaveLayout {
  const l = v as CaveLayout;
  return !!l && l.version === 1 && Array.isArray(l.hubs) && Array.isArray(l.tunnels) && Array.isArray(l.items) && Array.isArray(l.biomes) && l.biomes.length === 3;
}

// ------------------------------------------------------------------ entry points

/**
 * Stage 1 of a build: everything but the rock meshes (layout, water, contents, lights) and the list
 * of chunks to mesh, nearest to an entrance first. Stage 2 (meshCaveChunks) can then run in several
 * workers at once, each on a slice of that list.
 */
export interface CavePlan extends Omit<CaveGenOutput, 'chunks' | 'remeshed'> {
  /** Chunks to mesh, entrance-near first. */
  meshKeys: number[];
  /** Chunks that must go without a replacement (partial rebuild); null: a full build (drop all). */
  clearKeys: number[] | null;
  /** Same pools with the mask grown along the shores (for the wet attribute). */
  wetPools: CavePool[];
}

export interface CaveMeshJob {
  /** Null when this worker already holds the layout of `rev`. */
  layout: CaveLayout | null;
  entrances: CaveEntranceIn[];
  wetPools: CavePool[];
  keys: number[];
  /** Same value for every slice of one build: the worker reuses its field between them. */
  rev: number;
}

export interface CaveMeshResult {
  keys: number[];
  chunks: CaveChunk[];
  triangles: number;
  ms: number;
}

export function planCaveNetwork(req: CaveGenRequest): CavePlan {
  const t0 = performance.now();
  const fresh = !isCaveLayout(req.layout);
  const layout: CaveLayout = fresh ? planCaveLayout(req) : (req.layout as CaveLayout);
  ensureEntrances(layout, req, mulberry(req.seed * 31 + 7));
  const built = buildField(layout, req);
  const wr = buildWater(built);
  if (fresh) populate(layout, built, wr.pools, mulberry(req.seed * 7919 + 101));
  const contents = deriveContents(layout, built, wr.pools);
  const dirty = fresh ? null : (req.dirty ?? null);
  const list = listChunks(built, dirty);
  return {
    layout,
    meshKeys: list.mesh,
    clearKeys: dirty ? list.clear : null,
    wetPools: wr.wetPools,
    pools: wr.pools,
    water: new Float32Array(wr.water),
    waterBiome: new Uint8Array(wr.waterBiome),
    entrances: built.entrances,
    chests: contents.chests,
    ores: contents.ores,
    mushrooms: contents.mushrooms,
    crystals: contents.crystals,
    embers: contents.embers,
    drips: new Float32Array(contents.drips),
    lights: contents.lights,
    stats: {
      ms: Math.round(performance.now() - t0),
      meshMs: 0,
      sampled: list.mesh.length,
      chunks: 0,
      triangles: 0,
      hubs: layout.hubs.filter((h) => !h.entrance).length,
      tunnels: layout.tunnels.length,
      pools: wr.pools.length,
    },
  };
}

let meshCache: { rev: number; mesher: Mesher; biomes: { x: number; z: number }[] } | null = null;

/** Stage 2: the rock meshes of some chunks of a planned layout. */
export function meshCaveChunks(job: CaveMeshJob): CaveMeshResult {
  const t0 = performance.now();
  if (!meshCache || meshCache.rev !== job.rev) {
    if (!job.layout) throw new Error('cave mesh job without its layout');
    const built = buildField(job.layout, { seed: job.layout.seed, entrances: job.entrances, coast: new Float32Array(0) });
    meshCache = { rev: job.rev, mesher: new Mesher(built, layoutCones(job.layout), job.wetPools), biomes: job.layout.biomes };
  }
  gBiomes = meshCache.biomes;
  const chunks: CaveChunk[] = [];
  let triangles = 0;
  for (const key of job.keys) {
    const c = meshCache.mesher.mesh(key);
    if (!c) continue;
    chunks.push(c);
    triangles += (c.indices.length / 3) | 0;
  }
  return { keys: job.keys, chunks, triangles, ms: Math.round(performance.now() - t0) };
}

/** Both stages in one go (no workers: tests, and the fallback when workers fail). */
export function generateCaveNetwork(req: CaveGenRequest): CaveGenOutput {
  const t0 = performance.now();
  const plan = planCaveNetwork(req);
  const tMesh = performance.now();
  const mesh = meshCaveChunks({ layout: plan.layout, entrances: req.entrances, wetPools: plan.wetPools, keys: plan.meshKeys, rev: -1 - Math.random() });
  const meshMs = performance.now() - tMesh;
  const remeshed = plan.clearKeys ? [...plan.clearKeys, ...plan.meshKeys] : null;
  const { meshKeys: _k, clearKeys: _c, wetPools: _w, ...rest } = plan;
  return {
    ...rest,
    remeshed,
    chunks: mesh.chunks,
    stats: { ...plan.stats, ms: Math.round(performance.now() - t0), meshMs: Math.round(meshMs), chunks: mesh.chunks.length, triangles: mesh.triangles },
  };
}
