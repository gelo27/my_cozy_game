/**
 * Island-wide cave network generator. Pure maths with no three.js, so it runs in a Web Worker
 * (caveWorker.ts) and the few hundred milliseconds of field sampling never block a frame.
 *
 * Layout: ~18 chambers spread under the whole island (Poisson disk), joined by a minimum spanning
 * tree of tunnels (always walkable both ways) plus a few extra loop tunnels. Only loop tunnels get
 * one-way features (a 2.6 m drop, a flooded sump), so there is always a dry way back. Every surface
 * entrance opens into the same network: walk in at one cave mouth, out at another.
 *
 * Rock is a signed distance field (negative = air): tapered capsules along each tunnel with a
 * floor profile (ramps, stairs, cliffs, dips), ellipsoid chambers, lake basins, and rock added back
 * on top (shelves for an upper gallery, ramps up to it, pillars). Smooth union blends everything;
 * 3D value noise roughens the walls (weaker on floors and in crawlways so they stay passable).
 *
 * Meshing is Surface Nets per 12.8 m chunk (only chunks near a tunnel are sampled). Normals come
 * from the field gradient, so chunk seams are invisible; per-vertex ambient occlusion is sampled
 * from the field too. Stalactites / stalagmites are cones merged into the chunk meshes.
 */

export type Vec3 = [number, number, number];
export type OreKind = 'iron' | 'copper' | 'gold' | 'crystal';

export interface CaveEntranceIn {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Direction the surface mouth faces (out of the hill), atan2(x, z). */
  yaw: number;
}

export interface CaveGenInput {
  seed: number;
  entrances: CaveEntranceIn[];
  /** Coast radius per degree (360 values): the network stays under dry land. */
  coast: Float32Array;
}

export interface CaveChunk {
  /** Bounding sphere centre and radius (cave-local). */
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  positions: Float32Array;
  normals: Float32Array;
  /** RGB = biome weights (moss, crystal, ember), A = ambient occlusion. */
  data: Uint8Array;
  indices: Uint16Array;
  /** The first N indices are rock and stalagmites (collide); the rest are stalactites (render only). */
  colliderIndexCount: number;
}

/** Still water: a level and a 1 m mask of the columns it covers. */
export interface CavePool {
  level: number;
  minX: number;
  minZ: number;
  minY: number;
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
  /** Inner end of the tunnel, where the lit way out is. */
  mouth: Vec3;
  spawn: Vec3;
  /** Facing into the cave. */
  yaw: number;
  /** Centre of the daylight disc on the end wall. */
  glow: Vec3;
  torches: Vec3[];
}

export interface CaveGenOutput {
  chunks: CaveChunk[];
  pools: CavePool[];
  /** Water surfaces, non-indexed triangles (xyz). */
  water: Float32Array;
  entrances: CaveEntranceOut[];
  chests: { id: string; pos: Vec3; yaw: number }[];
  ores: { pos: Vec3; kind: OreKind }[];
  mushrooms: Vec3[];
  crystals: { pos: Vec3; color: number; size: number }[];
  embers: Vec3[];
  /** Dripping stalactite tips: x, y, z, landing y, 1 if it lands in water (5 floats each). */
  drips: Float32Array;
  lights: CaveLight[];
  stats: { ms: number; meshMs: number; sampled: number; chunks: number; triangles: number; hubs: number; tunnels: number };
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

/** Crystal colours (index into this from CaveGenOutput.crystals). */
export const CRYSTAL_COLORS: Vec3[] = [
  [0.35, 0.62, 1.0], // blue
  [0.72, 0.42, 1.0], // violet
  [0.3, 0.95, 0.72], // teal (moss caves)
  [1.0, 0.62, 0.25], // amber (ember caves)
];

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

// ------------------------------------------------------------------ biomes

let biomeAngle = 0;

/** Weights of the three biomes (moss, crystal, ember) at a point; they blend over ~40 m. */
function biomeWeights(x: number, z: number, out: Float32Array): Float32Array {
  const wx = x + noise2(x * 0.011 + 7, z * 0.011) * 45;
  const wz = z + noise2(x * 0.011, z * 0.011 - 3) * 45;
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const a = biomeAngle + (i * Math.PI * 2) / 3;
    const dx = wx - Math.cos(a) * 105, dz = wz - Math.sin(a) * 105;
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

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

interface AirPrim extends Box {
  amp: number;
  stamp: number;
  d(x: number, y: number, z: number): number;
}

interface RockPrim extends Box {
  stamp: number;
  d(x: number, y: number, z: number): number;
}

type ProfileKind = 'ramp' | 'stairs' | 'drop' | 'sump' | 'crawl';

/** Floor height along a tunnel, t = 0..1 from end A to end B. */
class Profile {
  public steps = 1;
  public readonly drop = 2.6;
  public readonly dip = 6.5;
  constructor(public kind: ProfileKind, public ya: number, public yb: number, public len: number, private readonly phase: number) {
    if (kind === 'stairs') this.steps = Math.max(2, Math.ceil(Math.abs(yb - ya) / 0.45));
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
      case 'sump': {
        let y = ya + (yb - ya) * t;
        if (t > 0.3 && t < 0.7) {
          const s = Math.sin((Math.PI * (t - 0.3)) / 0.4);
          y -= this.dip * s * s;
        }
        return y;
      }
      default:
        return ya + (yb - ya) * t + Math.sin(t * Math.PI * 2 + this.phase) * Math.sin(t * Math.PI) * 0.45;
    }
  }
}

/** A tapered capsule along a tunnel piece with a flat floor following the profile. */
class Seg implements AirPrim {
  minX = 0; maxX = 0; minY = 0; maxY = 0; minZ = 0; maxZ = 0;
  stamp = 0;
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
    private readonly prof: Profile,
    private readonly t0: number,
    private readonly t1: number,
    public amp: number,
    private readonly ceil = 0,
    private readonly capA = false,
    private readonly capB = false
  ) {
    // Floor along the piece, tabulated (the profile is trigonometry; the field reads it a lot).
    // Stay on this piece's side of a cliff: never read the profile at the exact break
    const span = t1 - t0;
    for (let i = 0; i <= FLOOR_STEPS; i++) this.floors[i] = prof.at(t0 + span * (0.0005 + (i / FLOOR_STEPS) * 0.999));
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
    this.minY = Math.min(floorA, floorB) - 2.5;
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
    if (this.ceil > 0) {
      const c = y - floorY - this.ceil;
      if (c > d) d = c;
    }
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

class PrimIndex {
  private readonly air: AirPrim[][] = Array.from({ length: IDX_N * IDX_N }, () => []);
  private readonly rock: RockPrim[][] = Array.from({ length: IDX_N * IDX_N }, () => []);
  private stamp = 1;

  public add(p: AirPrim | RockPrim, isRock: boolean): void {
    const i0 = this.ci(p.minX), i1 = this.ci(p.maxX), j0 = this.ci(p.minZ), j1 = this.ci(p.maxZ);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (isRock) this.rock[j * IDX_N + i].push(p as RockPrim);
      else this.air[j * IDX_N + i].push(p as AirPrim);
    }
  }

  private ci(v: number): number {
    return Math.max(0, Math.min(IDX_N - 1, Math.floor((v - IDX_MIN) / IDX_CELL)));
  }

  /** Primitives whose boxes overlap a box (no duplicates). */
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
  }

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

// ------------------------------------------------------------------ graph

type HubKind = 'chamber' | 'grand' | 'lake';

interface Hub {
  x: number;
  z: number;
  floor: number;
  rx: number;
  ry: number;
  rz: number;
  rot: number;
  kind: HubKind;
  biome: number;
  fixed: boolean;
  /** Gallery shelf: direction (unit, xz) of the tunnel that arrives up on it. */
  shelf: { dx: number; dz: number; edge: Edge } | null;
  edges: Edge[];
  entrance: CaveEntranceIn | null;
  treasure: string | null;
  keepOut: { x: number; z: number; r: number }[];
}

interface Edge {
  a: Hub;
  b: Hub;
  loop: boolean;
  entrance: boolean;
  kind: ProfileKind;
  radius: number;
  prof: Profile | null;
  /** Polyline: t, x, z, floor at even arc steps (filled when building prims). */
  pts: { t: number; x: number; z: number; f: number }[];
}

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

/** Where an edge leaves a hub: its centre, or the gallery shelf for the edge that arrives up there. */
function edgeEnd(h: Hub, e: Edge): { x: number; z: number; y: number } {
  if (h.shelf && h.shelf.edge === e) {
    const R = h.rx;
    // Shelf frame: v along the shelf direction, u across (see Slab)
    const ux = h.shelf.dz, uz = -h.shelf.dx;
    const u = R * 0.3, v = R * 0.84;
    return { x: h.x + ux * u + h.shelf.dx * v, z: h.z + uz * u + h.shelf.dz * v, y: h.floor + SHELF_H };
  }
  return { x: h.x, z: h.z, y: h.floor };
}

// ------------------------------------------------------------------ generator

export function generateCaveNetwork(input: CaveGenInput): CaveGenOutput {
  const t0 = performance.now();
  const rnd = mulberry(input.seed * 7919 + 17);
  biomeAngle = rnd() * Math.PI * 2;
  const coastAt = (x: number, z: number) => {
    let deg = Math.round((Math.atan2(z, x) * 180) / Math.PI);
    if (deg < 0) deg += 360;
    return input.coast[deg % 360];
  };

  // ---- entrances: a short porch tunnel inward from each mouth to its first junction
  const hubs: Hub[] = [];
  const edges: Edge[] = [];
  const entranceInfo: { e: CaveEntranceIn; inx: number; inz: number; mouthY: number; hub: Hub }[] = [];
  for (const e of input.entrances) {
    const inx = -Math.sin(e.yaw), inz = -Math.cos(e.yaw);
    const mouthY = e.y - 0.2;
    const hub: Hub = {
      x: e.x + inx * 16,
      z: e.z + inz * 16,
      floor: mouthY - 2.5,
      rx: 4.5, ry: 4.5, rz: 4.5, rot: 0,
      kind: 'chamber',
      biome: dominantBiome(e.x, e.z),
      fixed: true,
      shelf: null,
      edges: [],
      entrance: e,
      treasure: null,
      keepOut: [],
    };
    hubs.push(hub);
    entranceInfo.push({ e, inx, inz, mouthY, hub });
  }

  // ---- chambers: Poisson disk under the island, clear of the entrance porches
  const chambers: Hub[] = [];
  for (let i = 0; i < 6000 && chambers.length < 18; i++) {
    const x = (rnd() * 2 - 1) * 215, z = (rnd() * 2 - 1) * 215;
    if (Math.hypot(x, z) > coastAt(x, z) - 42) continue;
    if (chambers.some((h) => Math.hypot(h.x - x, h.z - z) < 54)) continue;
    if (hubs.some((h) => Math.hypot(h.x - x, h.z - z) < 32)) continue;
    const biome = dominantBiome(x, z);
    biomeWeights(x, z, _bw);
    const floor = -10 + noise2(x * 0.012 + 3, z * 0.012) * 7 - _bw[2] * 12 + _bw[0] * 4;
    const s = 8 + rnd() * 5;
    chambers.push({
      x, z, floor,
      rx: s, ry: 5.5 + rnd() * 2.5, rz: s * (0.7 + rnd() * 0.5), rot: rnd() * Math.PI,
      kind: 'chamber', biome, fixed: false, shelf: null, edges: [], entrance: null, treasure: null, keepOut: [],
    });
  }
  // A few grand halls (tall, round, with a gallery) and lake chambers
  const order = chambers.map((_, i) => i).sort(() => rnd() - 0.5);
  order.slice(0, 3).forEach((i) => {
    const h = chambers[i];
    h.kind = 'grand';
    h.rx = h.rz = 16 + rnd() * 3;
    h.ry = 10.5 + rnd() * 1.5;
  });
  order.slice(3, 5).forEach((i) => {
    const h = chambers[i];
    h.kind = 'lake';
    h.rx = 12 + rnd() * 3;
    h.rz = h.rx * (0.8 + rnd() * 0.25);
    h.ry = 7 + rnd() * 2;
  });
  hubs.push(...chambers);

  const addEdge = (a: Hub, b: Hub, loop: boolean, entrance: boolean): Edge => {
    const e: Edge = { a, b, loop, entrance, kind: 'ramp', radius: 2.6 + rnd() * 0.6, prof: null, pts: [] };
    edges.push(e);
    a.edges.push(e);
    b.edges.push(e);
    return e;
  };
  const crosses = (a: Hub, b: Hub) =>
    edges.some((e) => e.a !== a && e.b !== a && e.a !== b && e.b !== b && segIntersect(a.x, a.z, b.x, b.z, e.a.x, e.a.z, e.b.x, e.b.z));
  const clearOfHubs = (a: Hub, b: Hub) =>
    hubs.every((h) => h === a || h === b || pointSegDist(h.x, h.z, a.x, a.z, b.x, b.z) > Math.max(h.rx, h.rz) + 7);

  // Minimum spanning tree over the chambers (Prim)
  const inTree = new Set<Hub>([chambers[0]]);
  while (inTree.size < chambers.length) {
    let best: [Hub, Hub] | null = null;
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
    addEdge(best[0], best[1], false, false);
    inTree.add(best[1]);
  }
  // Loops: short extra links that cross nothing and pass no other chamber
  const pairs: [Hub, Hub, number][] = [];
  for (let i = 0; i < chambers.length; i++) {
    for (let j = i + 1; j < chambers.length; j++) {
      const a = chambers[i], b = chambers[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 95 && !a.edges.some((e) => e.a === b || e.b === b)) pairs.push([a, b, d]);
    }
  }
  pairs.sort((p, q) => p[2] - q[2]);
  let loops = 0;
  for (const [a, b] of pairs) {
    if (loops >= 7) break;
    if (crosses(a, b) || !clearOfHubs(a, b)) continue;
    addEdge(a, b, true, false);
    loops++;
  }
  // Each entrance joins the nearest chamber it can reach without crossing a tunnel
  for (const info of entranceInfo) {
    const sorted = [...chambers].sort((p, q) => Math.hypot(p.x - info.hub.x, p.z - info.hub.z) - Math.hypot(q.x - info.hub.x, q.z - info.hub.z));
    const target = sorted.slice(0, 4).find((c) => !crosses(info.hub, c) && clearOfHubs(info.hub, c)) ?? sorted[0];
    addEdge(info.hub, target, false, true);
  }

  // ---- galleries: a grand hall's shelf faces one tunnel; the others must arrive well away from it
  for (const h of chambers) {
    if (h.kind !== 'grand') continue;
    const dirs = h.edges.map((e) => {
      const o = e.a === h ? e.b : e.a;
      const l = Math.hypot(o.x - h.x, o.z - h.z) || 1;
      return { e, dx: (o.x - h.x) / l, dz: (o.z - h.z) / l };
    });
    for (const cand of dirs) {
      if (cand.e.entrance) continue;
      const ok = dirs.every((o) => o === cand || o.dx * cand.dx + o.dz * cand.dz < Math.cos((75 * Math.PI) / 180));
      if (ok) {
        h.shelf = { dx: cand.dx, dz: cand.dz, edge: cand.e };
        break;
      }
    }
  }

  // ---- heights: keep every tunnel walkable (slope <= 0.38) by relaxing the free chamber floors
  const endY = (h: Hub, e: Edge) => (h.shelf && h.shelf.edge === e ? h.floor + SHELF_H : h.floor);
  for (let it = 0; it < 80; it++) {
    for (const e of edges) {
      const len = Math.hypot(e.a.x - e.b.x, e.a.z - e.b.z);
      const diff = endY(e.a, e) - endY(e.b, e);
      const lim = 0.38 * len;
      if (Math.abs(diff) <= lim) continue;
      const excess = (Math.abs(diff) - lim) * Math.sign(diff);
      if (!e.a.fixed && !e.b.fixed) {
        e.a.floor -= excess / 2;
        e.b.floor += excess / 2;
      } else if (!e.a.fixed) e.a.floor -= excess;
      else if (!e.b.fixed) e.b.floor += excess;
    }
  }
  for (const h of chambers) h.floor = Math.max(-45, Math.min(18, h.floor));

  // ---- tunnel kinds: one-way features only on loops, so the tree always leads back
  const loopEdges = edges.filter((e) => e.loop).sort(() => rnd() - 0.5);
  const treeEdges = edges.filter((e) => !e.loop && !e.entrance).sort(() => rnd() - 0.5);
  const slope = (e: Edge) => Math.abs(endY(e.a, e) - endY(e.b, e)) / Math.max(1, Math.hypot(e.a.x - e.b.x, e.a.z - e.b.z));
  const free = (e: Edge) => !(e.a.shelf?.edge === e || e.b.shelf?.edge === e);
  let sumps = 0, drops = 0, crawls = 0;
  for (const e of loopEdges) {
    const len = Math.hypot(e.a.x - e.b.x, e.a.z - e.b.z);
    if (!free(e) || len < 34) continue;
    if (sumps < 2 && e.a.kind !== 'lake' && e.b.kind !== 'lake') {
      e.kind = 'sump';
      sumps++;
    } else if (drops < 3) {
      e.kind = 'drop';
      drops++;
    } else if (crawls < 1) {
      e.kind = 'crawl';
      crawls++;
    }
  }
  for (const e of treeEdges) {
    const len = Math.hypot(e.a.x - e.b.x, e.a.z - e.b.z);
    if (crawls < 3 && len > 30 && slope(e) < 0.2 && free(e)) {
      e.kind = 'crawl';
      crawls++;
    }
  }
  for (const e of edges) {
    if (e.kind === 'ramp' && slope(e) > 0.15) e.kind = 'stairs';
  }

  // ---- build primitives
  const index = new PrimIndex();
  const addAir = (p: AirPrim) => index.add(p, false);
  const addRock = (p: RockPrim) => index.add(p, true);
  const pools: { level: number; minX: number; maxX: number; minZ: number; maxZ: number; minY: number }[] = [];
  /** Tunnel pieces for decoration: centre, floor, radius, whether to keep the middle clear. */
  const tunnelSpots: { x: number; z: number; f: number; r: number; dx: number; dz: number; plain: boolean }[] = [];

  for (const e of edges) {
    const A = edgeEnd(e.a, e), B = edgeEnd(e.b, e);
    const len = Math.hypot(B.x - A.x, B.z - A.z);
    const prof = new Profile(e.kind, A.y, B.y, len, rnd() * 6);
    e.prof = prof;
    const ux = (B.x - A.x) / len, uz = (B.z - A.z) / len;
    const px = -uz, pz = ux;
    const wig = Math.min(7, len * 0.12) * (rnd() < 0.5 ? -1 : 1);
    const k = 1 + Math.floor(rnd() * 2), ph = rnd() * 6;
    const P = (t: number) => {
      const off = wig * Math.sin(Math.PI * t) * Math.sin(Math.PI * t * k + ph) * (e.kind === 'sump' ? 0.3 : 1);
      return { x: A.x + (B.x - A.x) * t + px * off, z: A.z + (B.z - A.z) * t + pz * off };
    };
    // Break points: even ~7 m pieces, plus the exact ends of special sections
    const n = Math.max(3, Math.ceil(len / 7));
    const ts = new Set<number>();
    for (let i = 0; i <= n; i++) ts.add(i / n);
    let c0 = -1, c1 = -1;
    if (e.kind === 'drop') ts.add(0.5);
    if (e.kind === 'crawl') {
      c0 = 0.5 - 3.6 / len;
      c1 = 0.5 + 3.6 / len;
      ts.add(c0);
      ts.add(c1);
    }
    // No even break right next to a cliff or a crawlway: the flat-capped piece there must be long
    // enough that the round end of the piece before it cannot poke past the cut
    const forced = e.kind === 'drop' ? [0.5] : e.kind === 'crawl' ? [c0, c1] : [];
    const near = 3.5 / len;
    const list = [...ts]
      .filter((t) => forced.includes(t) || t === 0 || t === 1 || forced.every((ft) => Math.abs(t - ft) > near))
      .sort((p, q) => p - q)
      .filter((t, i, arr) => i === 0 || t - arr[i - 1] > 0.015 || forced.includes(t));
    const inCrawl = (t: number) => c0 >= 0 && t >= c0 - 1e-6 && t <= c1 + 1e-6;
    const radiusAt = (t: number) => {
      let r = e.radius;
      if (e.kind === 'sump' && t > 0.25 && t < 0.75) r = 2.3;
      // Flare where the tunnel meets a chamber
      if (t < 0.06 || t > 0.94) r *= 1.12;
      return r;
    };
    for (let i = 0; i + 1 < list.length; i++) {
      const ta = list[i], tb = list[i + 1];
      const pa = P(ta), pb = P(tb);
      const span = tb - ta;
      const fa = prof.at(ta + span * 0.0005), fb = prof.at(tb - span * 0.0005);
      const mid = (ta + tb) / 2;
      const crawl = inCrawl(mid);
      const ra = crawl ? 1.7 : radiusAt(ta), rb = crawl ? 1.7 : radiusAt(tb);
      // Flat ends: the low side of a cliff, and the walls around a crawlway's hole
      const capA = (e.kind === 'drop' && ta === 0.5 && prof.ya >= prof.yb) || (!crawl && c1 >= 0 && Math.abs(ta - c1) < 1e-9);
      const capB = (e.kind === 'drop' && tb === 0.5 && prof.ya < prof.yb) || (!crawl && c0 >= 0 && Math.abs(tb - c0) < 1e-9);
      addAir(new Seg(pa.x, fa, pa.z, pb.x, fb, pb.z, ra, rb, prof, ta, tb, crawl ? 0.12 : e.kind === 'sump' ? 0.6 : 0.8, crawl ? 1.25 : 0, capA, capB));
      e.pts.push({ t: ta, x: pa.x, z: pa.z, f: fa });
      if (!crawl && mid > 0.12 && mid < 0.88) {
        const l = Math.hypot(pb.x - pa.x, pb.z - pa.z) || 1;
        tunnelSpots.push({
          x: (pa.x + pb.x) / 2,
          z: (pa.z + pb.z) / 2,
          f: prof.at(mid),
          r: (ra + rb) / 2,
          dx: (pb.x - pa.x) / l,
          dz: (pb.z - pa.z) / l,
          plain: e.kind !== 'sump' || mid < 0.25 || mid > 0.75,
        });
      }
    }
    const last = P(1);
    e.pts.push({ t: 1, x: last.x, z: last.z, f: prof.at(0.9995) });
    if (e.kind === 'sump') {
      // Still water fills the dip up to just below where the floor starts to fall
      const level = Math.min(prof.at(0.3), prof.at(0.7)) - 0.2;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let t = 0.2; t <= 0.8; t += 0.02) {
        const p = P(t);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
      pools.push({ level, minX: minX - 4, maxX: maxX + 4, minZ: minZ - 4, maxZ: maxZ + 4, minY: level - prof.dip - 3 });
    }
  }

  // Entrance porches: a calm-walled tunnel ending in a flat wall where the daylight disc hangs
  const entrancesOut: CaveEntranceOut[] = [];
  for (const info of entranceInfo) {
    const { e, inx, inz, mouthY, hub } = info;
    const prof = new Profile('ramp', mouthY, hub.floor, 16, 0);
    const mx = e.x, mz = e.z;
    const p5x = mx + inx * 5, p5z = mz + inz * 5;
    addAir(new Seg(mx, mouthY, mz, p5x, prof.at(5 / 16), p5z, 2.6, 2.7, prof, 0, 5 / 16, 0.22, 0, true, false));
    addAir(new Seg(p5x, prof.at(5 / 16), p5z, hub.x, hub.floor, hub.z, 2.7, 3.0, prof, 5 / 16, 1, 0.7));
    addAir(new Ellipsoid(hub.x, hub.floor + 2.2, hub.z, 5, 4.2, 5, 0, hub.floor, 0.8));
    const sx = mx + inx * 2.8, sz = mz + inz * 2.8;
    const tx = mx + inx * 3.4, tz = mz + inz * 3.4;
    entrancesOut.push({
      id: e.id,
      mouth: [mx + inx * 0.9, mouthY, mz + inz * 0.9],
      spawn: [sx, prof.at(2.8 / 16), sz],
      yaw: Math.atan2(inx, inz),
      glow: [mx + inx * 0.28, mouthY + 1.55, mz + inz * 0.28],
      torches: [-1.9, 1.9].map((s): Vec3 => [tx - inz * s, prof.at(3.4 / 16), tz + inx * s]),
    });
    hub.keepOut.push({ x: mx + inx * 3, z: mz + inz * 3, r: 4 });
  }

  // Chambers, lake basins, galleries and pillars
  for (const h of chambers) {
    const amp = h.kind === 'grand' ? 1.25 : 1.1;
    addAir(new Ellipsoid(h.x, h.floor + h.ry * 0.45, h.z, h.rx, h.ry, h.rz, h.rot, h.floor, amp));
    // Corridors where tunnels arrive stay free of stalagmites and ore
    h.keepOut.push({ x: h.x, z: h.z, r: 3 });
    for (const e of h.edges) {
      const end = edgeEnd(h, e);
      const o = e.a === h ? e.b : e.a;
      const l = Math.hypot(o.x - end.x, o.z - end.z) || 1;
      for (let d = 0; d < Math.max(h.rx, h.rz) + 4; d += 2.5) h.keepOut.push({ x: end.x + ((o.x - end.x) / l) * d, z: end.z + ((o.z - end.z) / l) * d, r: 2.6 });
    }
    if (h.kind === 'lake') {
      addAir(new Ellipsoid(h.x, h.floor - 0.3, h.z, h.rx * 0.62, 3.4, h.rz * 0.62, h.rot, NaN, 0.5));
      const r = Math.max(h.rx, h.rz) * 0.7;
      pools.push({ level: h.floor - 0.35, minX: h.x - r - 2, maxX: h.x + r + 2, minZ: h.z - r - 2, maxZ: h.z + r + 2, minY: h.floor - 5 });
    }
    if (h.kind === 'grand' && h.shelf) {
      const R = h.rx;
      const ux = h.shelf.dz, uz = -h.shelf.dx;
      // Slab's (ux, uz) is the across axis; v is derived as (-uz, ux) = the shelf direction
      addRock(new Slab(h.x, h.z, ux, uz, -0.02 * R, 0.64 * R, 0.5 * R, 1.35 * R, h.floor, SHELF_H, false));
      addRock(new Slab(h.x, h.z, ux, uz, -0.52 * R, -0.02 * R, 0.66 * R, 1.35 * R, h.floor, SHELF_H, true));
      // Keep the ramp and the shelf clear of stalagmites
      for (let u = -0.5; u <= 0.6; u += 0.12) h.keepOut.push({ x: h.x + ux * u * R + h.shelf.dx * 0.85 * R, z: h.z + uz * u * R + h.shelf.dz * 0.85 * R, r: 0.3 * R });
    }
    if (h.kind === 'grand') {
      for (let i = 0, placed = 0; i < 20 && placed < 2; i++) {
        const a = rnd() * Math.PI * 2, d = h.rx * (0.3 + rnd() * 0.3);
        const x = h.x + Math.cos(a) * d, z = h.z + Math.sin(a) * d;
        if (h.shelf && Math.cos(a) * h.shelf.dx + Math.sin(a) * h.shelf.dz > -0.2) continue;
        if (h.keepOut.some((k) => Math.hypot(k.x - x, k.z - z) < k.r + 2.5)) continue;
        addRock(new Pillar(x, z, 1.3 + rnd() * 0.6, h.floor));
        h.keepOut.push({ x, z, r: 3 });
        placed++;
      }
    }
  }

  // ---- field queries for placing things
  const qa: AirPrim[] = [], qr: RockPrim[] = [];
  const at = (x: number, y: number, z: number) => field(x, y, z, index.airAt(x, z), index.rockAt(x, z));
  /** Floor below an air point (null when the point is in rock or there is no floor within 16 m). */
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
  const poolAt = (x: number, y: number, z: number) =>
    pools.find((p) => x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ && y < p.level + 0.15 && y > p.minY - 1);
  const keptOut = (h: Hub | null, x: number, z: number, extra = 0) => !!h && h.keepOut.some((k) => Math.hypot(k.x - x, k.z - z) < k.r + extra);

  // ---- contents
  const ores: CaveGenOutput['ores'] = [];
  const mushrooms: Vec3[] = [];
  const crystals: CaveGenOutput['crystals'] = [];
  const embers: Vec3[] = [];
  const lights: CaveLight[] = [];
  const chests: CaveGenOutput['chests'] = [];
  const cones: { x: number; y: number; z: number; up: boolean; len: number; r: number; bx: number; bz: number }[] = [];
  const drips: number[] = [];
  const ORE: OreKind[][] = [['iron', 'copper', 'iron', 'gold'], ['crystal', 'gold', 'crystal', 'iron'], ['gold', 'iron', 'copper', 'gold']];

  const localPoint = (h: Hub, a: number, frac: number) => {
    const lx = Math.cos(a) * h.rx * frac, lz = Math.sin(a) * h.rz * frac;
    const c = Math.cos(h.rot), s = Math.sin(h.rot);
    return { x: h.x + lx * c - lz * s, z: h.z + lx * s + lz * c };
  };
  const scatter = (h: Hub, count: number, f0: number, f1: number, clear: number, each: (x: number, y: number, z: number, i: number) => boolean | void) => {
    let placed = 0;
    for (let i = 0; i < count * 8 && placed < count; i++) {
      const p = localPoint(h, rnd() * Math.PI * 2, f0 + rnd() * (f1 - f0));
      if (keptOut(h, p.x, p.z)) continue;
      const y = spot(p.x, h.floor, p.z, clear);
      if (y === null || poolAt(p.x, y, p.z)) continue;
      if (each(p.x, y, p.z, placed) !== false) placed++;
    }
  };

  // Treasure: the three chambers farthest from any entrance, preferring different biomes
  const far = [...chambers].sort((p, q) => {
    const dp = Math.min(...entranceInfo.map((i) => Math.hypot(i.hub.x - p.x, i.hub.z - p.z)));
    const dq = Math.min(...entranceInfo.map((i) => Math.hypot(i.hub.x - q.x, i.hub.z - q.z)));
    return dq - dp;
  });
  const treasureIds = ['cave1', 'cave2', 'cave3'];
  const usedBiomes = new Set<number>();
  for (const pass of [0, 1]) {
    for (const h of far) {
      if (chests.length >= treasureIds.length) break;
      if (h.treasure || (pass === 0 && usedBiomes.has(h.biome))) continue;
      let pos: Vec3 | null = null;
      let yaw = 0;
      if (h.shelf) {
        // On the gallery: the reward for finding the way up
        const R = h.rx, ux = h.shelf.dz, uz = -h.shelf.dx;
        const x = h.x + ux * 0.46 * R + h.shelf.dx * 0.78 * R, z = h.z + uz * 0.46 * R + h.shelf.dz * 0.78 * R;
        const y = floorBelow(x, h.floor + SHELF_H + 1.5, z);
        if (y !== null && y > h.floor + SHELF_H - 0.6) {
          pos = [x, y, z];
          yaw = Math.atan2(-h.shelf.dx, -h.shelf.dz);
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
      h.treasure = treasureIds[chests.length];
      chests.push({ id: h.treasure, pos, yaw });
      h.keepOut.push({ x: pos[0], z: pos[2], r: 2 });
      usedBiomes.add(h.biome);
    }
  }

  for (const h of chambers) {
    const b = h.biome;
    const area = h.rx * h.rz;
    scatter(h, h.kind === 'grand' ? 4 : 3, 0.5, 0.82, 1.8, (x, y, z, i) => {
      ores.push({ pos: [x, y, z], kind: ORE[b][i % 4] });
      h.keepOut.push({ x, z, r: 1.6 });
    });
    if (b === 1) {
      scatter(h, 6 + Math.floor(rnd() * 4), 0.6, 0.95, 1.2, (x, y, z) => {
        const color = rnd() < 0.5 ? 0 : 1;
        crystals.push({ pos: [x, y, z], color, size: 0.9 + rnd() * 0.9 });
        const c = CRYSTAL_COLORS[color];
        lights.push({ x, y: y + 0.8, z, range: 7, halo: 1.3, intensity: 1.1, color: [c[0] * 1.4, c[1] * 1.4, c[2] * 1.4] });
      });
    } else {
      scatter(h, 1 + Math.floor(rnd() * 2), 0.6, 0.95, 1.2, (x, y, z) => {
        const color = b === 0 ? 2 : 3;
        crystals.push({ pos: [x, y, z], color, size: 0.7 + rnd() * 0.5 });
        const c = CRYSTAL_COLORS[color];
        lights.push({ x, y: y + 0.7, z, range: 6, halo: 1.0, intensity: 0.9, color: [c[0] * 1.3, c[1] * 1.3, c[2] * 1.3] });
      });
    }
    if (b === 0) {
      // Glowing mushroom patches: a few clusters around one soft light
      scatter(h, 3 + Math.floor(rnd() * 3), 0.35, 0.85, 1.4, (x, y, z) => {
        let n = 0;
        for (let k = 0; k < 6 && n < 3; k++) {
          const mx = x + (rnd() - 0.5) * 2.2, mz = z + (rnd() - 0.5) * 2.2;
          const my = spot(mx, y, mz, 1.2);
          if (my === null || keptOut(h, mx, mz)) continue;
          mushrooms.push([mx, my, mz]);
          n++;
        }
        if (n === 0) return false;
        lights.push({ x, y: y + 0.5, z, range: 4.5, halo: 0.8, intensity: 0.8, color: [0.35, 0.95, 0.9] });
      });
    }
    if (b === 2) {
      scatter(h, 3 + Math.floor(rnd() * 3), 0.3, 0.9, 1.4, (x, y, z) => {
        embers.push([x, y, z]);
        lights.push({ x, y: y + 0.6, z, range: 6.5, halo: 1.4, intensity: 1.2, color: [1.6, 0.55, 0.15], flicker: true });
        h.keepOut.push({ x, z, r: 1.4 });
      });
    }
    // A faint biome glow fills big halls so their size reads in the dark
    if (h.kind !== 'chamber') {
      const tint: Vec3 = b === 0 ? [0.25, 0.5, 0.45] : b === 1 ? [0.3, 0.38, 0.7] : [0.6, 0.3, 0.15];
      lights.push({ x: h.x, y: h.floor + h.ry * 0.9, z: h.z, range: Math.max(h.rx, h.rz) * 1.3, halo: 0, intensity: 0.35, color: tint });
    }

    // Stalactites from the ceiling, many with a stalagmite growing up under them
    const nCones = Math.round(area / (b === 1 ? 7 : b === 2 ? 14 : 10));
    for (let i = 0; i < nCones * 2 && cones.length < 2600; i++) {
      const p = localPoint(h, rnd() * Math.PI * 2, Math.sqrt(rnd()) * 0.92);
      const fy = floorBelow(p.x, h.floor + 2, p.z);
      if (fy === null) continue;
      const cy = ceilingAbove(p.x, fy + 0.5, p.z);
      if (cy === null) continue;
      const height = cy - fy;
      if (height < 3.2) continue;
      const slender = b === 1 ? 0.12 : 0.18;
      let len = Math.min(height * (0.12 + rnd() * 0.25), 3.8);
      if (height - len < 2.6) len = height - 2.6; // never down into a walker's head
      if (len < 0.5) continue;
      const r = len * slender * (0.8 + rnd() * 0.5) + 0.08;
      cones.push({ x: p.x, y: cy + 0.25, z: p.z, up: false, len: len + 0.25, r, bx: (rnd() - 0.5) * 0.15, bz: (rnd() - 0.5) * 0.15 });
      const water = poolAt(p.x, fy, p.z);
      if (rnd() < 0.35) drips.push(p.x, cy - len, p.z, water ? water.level : fy, water ? 1 : 0);
      if (!water && rnd() < 0.45 && !keptOut(h, p.x, p.z, 0.8)) {
        const ml = Math.min(height - len - 1.2, 0.5 + rnd() * 1.6);
        if (ml > 0.35) cones.push({ x: p.x + (rnd() - 0.5) * 0.3, y: fy - 0.25, z: p.z + (rnd() - 0.5) * 0.3, up: true, len: ml + 0.25, r: ml * 0.32 + 0.12, bx: 0, bz: 0 });
      }
    }
    if (h.kind === 'lake') {
      // Drops into the lake from the ceiling
      for (let i = 0; i < 6; i++) {
        const p = localPoint(h, rnd() * Math.PI * 2, rnd() * 0.5);
        const pool = poolAt(p.x, h.floor - 0.5, p.z);
        const cy = ceilingAbove(p.x, h.floor + 0.5, p.z);
        if (pool && cy !== null) drips.push(p.x, cy - 0.05, p.z, pool.level, 1);
      }
    }
  }

  // Tunnels: a few cones along the walls, and the odd mushroom / ember / crystal
  for (const s of tunnelSpots) {
    const b = dominantBiome(s.x, s.z);
    if (rnd() < 0.55) {
      const cy = ceilingAbove(s.x, s.f + 1, s.z);
      if (cy !== null && cy - s.f > 3.3) {
        const len = Math.min(cy - s.f - 2.5, 0.6 + rnd() * 1.2);
        if (len > 0.4) {
          const ox = (rnd() - 0.5) * s.r * 0.8, x = s.x - s.dz * ox, z = s.z + s.dx * ox;
          const cy2 = ceilingAbove(x, s.f + 1, z);
          if (cy2 !== null && cy2 - s.f > len + 2.5) {
            cones.push({ x, y: cy2 + 0.25, z, up: false, len: len + 0.25, r: len * 0.17 + 0.08, bx: 0, bz: 0 });
            const pool = poolAt(x, s.f, z);
            if (rnd() < 0.4) drips.push(x, cy2 - len, z, pool ? pool.level : s.f, pool ? 1 : 0);
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
    if (roll < 0.3) cones.push({ x, y: y - 0.25, z, up: true, len: 0.6 + rnd() * 0.9, r: 0.25 + rnd() * 0.15, bx: 0, bz: 0 });
    else if (roll < 0.45 && b === 0 && mushrooms.length < 120) {
      mushrooms.push([x, y, z]);
      lights.push({ x, y: y + 0.5, z, range: 3.8, halo: 0.6, intensity: 0.7, color: [0.35, 0.95, 0.9] });
    } else if (roll < 0.45 && b === 2) {
      embers.push([x, y, z]);
      lights.push({ x, y: y + 0.5, z, range: 5, halo: 1, intensity: 1, color: [1.6, 0.55, 0.15], flicker: true });
    } else if (roll < 0.45) {
      const color = rnd() < 0.5 ? 0 : 1;
      crystals.push({ pos: [x, y, z], color, size: 0.6 + rnd() * 0.4 });
      const c = CRYSTAL_COLORS[color];
      lights.push({ x, y: y + 0.6, z, range: 5.5, halo: 0.9, intensity: 0.9, color: [c[0] * 1.3, c[1] * 1.3, c[2] * 1.3] });
    }
  }
  for (const en of entrancesOut) {
    for (const t of en.torches) lights.push({ x: t[0], y: t[1] + 1.5, z: t[2], range: 8, halo: 1.6, intensity: 1.2, flicker: true });
    const inx = Math.sin(en.yaw), inz = Math.cos(en.yaw);
    lights.push({ x: en.glow[0] + inx * 1.2, y: en.glow[1], z: en.glow[2] + inz * 1.2, range: 8, halo: 0, intensity: 0.9, color: [0.75, 0.85, 1.0] });
  }

  // ---- meshing
  const tMesh = performance.now();
  let sampled = 0;
  const conesByChunk = new Map<number, typeof cones>();
  for (const c of cones) {
    const ci = Math.floor((c.x - G0X) / CELL / C), cj = Math.floor((c.y - G0Y) / CELL / C), ck = Math.floor((c.z - G0Z) / CELL / C);
    const key = (ck * 64 + cj) * 64 + ci;
    let l = conesByChunk.get(key);
    if (!l) conesByChunk.set(key, (l = []));
    l.push(c);
  }

  const chunks: CaveChunk[] = [];
  let triangles = 0;
  const f = new Float32Array(S * S * S);
  const cellVert = new Int32Array((C + 2) * (C + 2) * (C + 2));
  const box: Box = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  const ncx = Math.ceil((NPX - 1) / C), ncy = Math.ceil((NPY - 1) / C), ncz = Math.ceil((NPZ - 1) / C);
  const fi = (i: number, j: number, k: number) => (k * S + j) * S + i;
  const v8 = new Float32Array(8);

  for (let cz = 0; cz < ncz; cz++) {
    for (let cy = 0; cy < ncy; cy++) {
      for (let cx = 0; cx < ncx; cx++) {
        const x0 = cx * C - 2, y0 = cy * C - 2, z0 = cz * C - 2;
        box.minX = G0X + x0 * CELL - 3;
        box.maxX = G0X + (x0 + S - 1) * CELL + 3;
        box.minY = G0Y + y0 * CELL - 3;
        box.maxY = G0Y + (y0 + S - 1) * CELL + 3;
        box.minZ = G0Z + z0 * CELL - 3;
        box.maxZ = G0Z + (z0 + S - 1) * CELL + 3;
        index.query(box, qa, qr);
        if (qa.length === 0) continue;
        // Coarse look first (5^3 points, no noise): a chunk whose every point is far from air is solid
        let nearAir = false;
        for (let k = 0; k <= 4 && !nearAir; k++) {
          for (let j = 0; j <= 4 && !nearAir; j++) {
            for (let i = 0; i <= 4 && !nearAir; i++) {
              const s = (S - 1) / 4;
              if (rawAir(G0X + (x0 + i * s) * CELL, G0Y + (y0 + j * s) * CELL, G0Z + (z0 + k * s) * CELL, qa) < COARSE_SKIP) nearAir = true;
            }
          }
        }
        if (!nearAir) continue;
        sampled++;

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
        if (!neg || !pos) continue;

        // Surface Nets vertices for cells 1..C+1 (local), normals from the field gradient
        const positions: number[] = [];
        const normals: number[] = [];
        const data: number[] = [];
        cellVert.fill(-1);
        const cvi = (i: number, j: number, k: number) => ((k - 1) * (C + 2) + (j - 1)) * (C + 2) + (i - 1);
        for (let k = 1; k <= C + 1; k++) {
          for (let j = 1; j <= C + 1; j++) {
            for (let i = 1, base = fi(1, j, k); i <= C + 1; i++, base++) {
              // Quick reject: the cell's corners all on one side
              const f0 = f[base];
              const below = f0 < 0;
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
                const a = EDGE_A[e], b = EDGE_B[e];
                if (v8[a] < 0 === v8[b] < 0) continue;
                const t = v8[a] / (v8[a] - v8[b]);
                sx += CX[a] + (CX[b] - CX[a]) * t;
                sy += CY[a] + (CY[b] - CY[a]) * t;
                sz += CZ[a] + (CZ[b] - CZ[a]) * t;
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
                const v = field(px + nx * dist, py + ny * dist, pz + nz * dist, qa, qr);
                occ += (Math.max(0, dist - Math.max(0, -v)) / dist) * AO_W[a];
              }
              biomeWeights(px, pz, _bw);
              data.push(_bw[0] * 255, _bw[1] * 255, _bw[2] * 255, Math.max(0.2, 1 - occ * 0.85) * 255);
            }
          }
        }

        // One quad per sign-changing grid edge owned by this chunk, facing the air
        const indices: number[] = [];
        const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
          if (a < 0 || b < 0 || c < 0 || d < 0) return;
          if (flip) indices.push(a, b, c, a, c, d);
          else indices.push(a, c, b, a, d, c);
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
        if (indices.length === 0) continue;

        // Cones whose base lies in this chunk: stalagmites collide, stalactites only render
        const key = (cz * 64 + cy) * 64 + cx;
        const list = conesByChunk.get(key) ?? [];
        const hanging: number[] = [];
        for (const c of list) addCone(c, positions, normals, data, c.up ? indices : hanging);
        const colliderIndexCount = indices.length;
        for (const i of hanging) indices.push(i);
        if (positions.length / 3 > 65535) continue; // cannot happen at this chunk size; stay safe

        let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
        for (let p = 0; p < positions.length; p += 3) {
          bx0 = Math.min(bx0, positions[p]);
          bx1 = Math.max(bx1, positions[p]);
          by0 = Math.min(by0, positions[p + 1]);
          by1 = Math.max(by1, positions[p + 1]);
          bz0 = Math.min(bz0, positions[p + 2]);
          bz1 = Math.max(bz1, positions[p + 2]);
        }
        triangles += indices.length / 3;
        chunks.push({
          cx: (bx0 + bx1) / 2,
          cy: (by0 + by1) / 2,
          cz: (bz0 + bz1) / 2,
          radius: Math.hypot(bx1 - bx0, by1 - by0, bz1 - bz0) / 2,
          positions: new Float32Array(positions),
          normals: new Float32Array(normals),
          data: new Uint8Array(data),
          indices: new Uint16Array(indices),
          colliderIndexCount,
        });
      }
    }
  }

  // ---- water: surfaces where the level is in air, masks of every column the water reaches
  const meshMs = performance.now() - tMesh;
  const outPools: CavePool[] = [];
  const water: number[] = [];
  for (const p of pools) {
    const minX = Math.floor(p.minX), minZ = Math.floor(p.minZ);
    const w = Math.ceil(p.maxX) - minX, h = Math.ceil(p.maxZ) - minZ;
    const mask = new Uint8Array(w * h);
    let any = false;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = minX + i + 0.5, z = minZ + j + 0.5;
        const cand = index.airAt(x, z);
        if (cand.length === 0) continue;
        const rk = index.rockAt(x, z);
        const surf =
          field(x, p.level, z, cand, rk) < 0.25 ||
          field(x - 0.5, p.level, z - 0.5, cand, rk) < 0 ||
          field(x + 0.5, p.level, z - 0.5, cand, rk) < 0 ||
          field(x - 0.5, p.level, z + 0.5, cand, rk) < 0 ||
          field(x + 0.5, p.level, z + 0.5, cand, rk) < 0;
        let wet = surf;
        for (let y = p.level - 0.4; !wet && y > p.minY; y -= 0.9) wet = field(x, y, z, cand, rk) < 0;
        if (!wet) continue;
        mask[j * w + i] = 1;
        any = true;
        if (surf) {
          const x0 = minX + i, z0 = minZ + j, y = p.level;
          water.push(x0, y, z0, x0, y, z0 + 1, x0 + 1, y, z0 + 1, x0, y, z0, x0 + 1, y, z0 + 1, x0 + 1, y, z0);
        }
      }
    }
    if (any) outPools.push({ level: p.level, minX, minZ, minY: p.minY, w, h, mask });
  }

  return {
    chunks,
    pools: outPools,
    water: new Float32Array(water),
    entrances: entrancesOut,
    chests,
    ores,
    mushrooms,
    crystals,
    embers,
    drips: new Float32Array(drips),
    lights,
    stats: { ms: Math.round(performance.now() - t0), meshMs: Math.round(meshMs), sampled, chunks: chunks.length, triangles, hubs: chambers.length, tunnels: edges.length },
  };
}

/** A tapered, slightly bent cone hanging from the ceiling (or growing from the floor). */
function addCone(
  c: { x: number; y: number; z: number; up: boolean; len: number; r: number; bx: number; bz: number },
  positions: number[],
  normals: number[],
  data: number[],
  indices: number[]
): void {
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
