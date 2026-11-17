import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { BuildingManager } from '../building/BuildingManager';
import {
  BuildingPieceType,
  BuiltPiece,
  isDoorPiece,
  isDoorwayPiece,
  isFloorPiece,
  isFoundationPiece,
  isGreenhousePiece,
  isSolidWallPiece,
  isWindowPiece,
  PIECE_TRAITS,
} from '../building/types/BuildingTypes';
import { describeWallSeg, WallSeg } from '../building/continuous/WallJoints';
import { isMobileDevice } from './WorldSettings';

/**
 * Daylight inside built houses.
 *
 * There are no shadow maps, so the sun and the sky light reach every surface, walls or not, and a
 * room with the lamps off looked as bright as the yard. Every house (a cluster of touching walls)
 * gets a small top-down "interior map" baked once, cached, and copied into a world-anchored ring
 * texture around the player that every lit material samples once per pixel:
 *
 * - R: how enclosed the cell is, 0 (outdoors) .. 1 (deep inside a room); cells near windows and
 *   doorways that open to the outside are lighter, the light falling off into the room;
 * - G: the world height of the cover above (roof or upper floor);
 * - B: a sharp inside mask (the room up to the walls' inner half). R runs on into the walls so it
 *   filters smoothly, the mask keeps it off the outer faces and the ground around the house.
 *
 * A pixel is inside when its cell is enclosed and it is below the cover; its sky / sun light is then
 * scaled down (the fake night lamps are added after this, so lit rooms stay lit). The pixel is
 * looked up a little along its normal, so a wall's outer face reads the yard and its inner face the
 * room, and a roof's top reads the open sky and its underside the attic.
 *
 * Rooms come from the walls: walls, windows and doors are drawn into the grid, the outside is flood
 * filled from the edges, and what the fill does not reach is inside, if a roof or a floor covers it
 * (a fenced yard of walls stays outdoors). Glass greenhouses let the light in and are skipped.
 *
 * Cost: walking only moves the ring window (houses entering it are copied in from the cache); a
 * house is rebaked only when its own pieces change, a few milliseconds per frame until done, while
 * the old map stays on screen. Pixels outside the baked houses' box skip the texture read.
 */

const MOBILE = isMobileDevice();
/** Cell size; phones use a coarser grid (a quarter of the work, rooms look the same). */
const CELL = MOBILE ? 0.5 : 0.25;
/** Ring texture texels per side: a 96 m window around the player. */
const N = MOBILE ? 192 : 384;
/** Walk this far from the window centre before it moves (only copies, no baking). */
const RECENTER = 8;
/** Wall half thickness drawn into the grid (a little more than the 0.16 m wall, closes joints). */
const WALL_R = Math.max(0.17, CELL * 0.5 + 0.01);
/** Cells of outdoors kept around a house's walls in its map. */
const MARGIN = Math.ceil(0.75 / CELL) + 1;
/** Radius (cells) of the corner shading neighbourhood: about 0.75 m. */
const AO_R = Math.max(1, Math.round(0.75 / CELL));
/** Baking time per frame. */
const BUDGET_MS = MOBILE ? 2 : 3;
/** Baked houses kept after they leave the area (walking back needs no rebake). */
const CACHE_SPARE = 24;

export const interiorSettings = {
  enabled: true,
  /** Sky (ambient / hemisphere / environment) light left deep inside a room. */
  ambient: 0.2,
  /** Direct sun left deep inside a room. */
  sun: 0.04,
  /** How much of the darkening a well-lit spot by a window takes back (0..1). Rebake to apply. */
  windowLight: 0.55,
  /** How much less window light reaches corners and the floor along walls (0..1). Rebake to apply. */
  cornerShade: 0.75,
  /** How much of the darkening a spot right next to open sky takes back (rooms only partly
   * under a ceiling or roof). Rebake to apply. */
  skyLight: 1,
};

export const interiorUniforms = {
  uIntMap: { value: null as THREE.Texture | null },
  /** World XZ box of the baked houses inside the window: min x, min z, max x, max z. */
  uIntBox: { value: new THREE.Vector4(0, 0, 0, 0) },
  /** x: 1 / (texture size in metres), y: highest cover + margin (pixels above skip the lookup). */
  uIntA: { value: new THREE.Vector2(1 / (N * CELL), 0) },
  /** ambient level, sun level, on (0/1). */
  uIntB: { value: new THREE.Vector3(1, 1, 0) },
};

export const INTERIOR_GLSL = /* glsl */ `
#define INTERIOR_SHADE
uniform sampler2D uIntMap;
uniform vec4 uIntBox;
uniform vec2 uIntA;
uniform vec3 uIntB;`;

/**
 * After the lights: scales the sky and sun light of pixels inside a room. Leaves the pixel's
 * darkness in `intDark` (0 outdoors), which also keeps street lamps out of rooms (NightLighting).
 */
export const INTERIOR_END = /* glsl */ `
float intDark = 0.0;
if (uIntB.z > 0.5) {
  mat3 intInv = transpose(mat3(viewMatrix));
  vec3 intQ = cameraPosition + intInv * (-vViewPosition) + (intInv * normal) * 0.35;
  // Early out: only pixels over a baked house and below its highest roof read the map
  if (intQ.x > uIntBox.x && intQ.z > uIntBox.y && intQ.x < uIntBox.z && intQ.z < uIntBox.w && intQ.y < uIntA.y) {
    // World-anchored ring texture: the repeat wrap does the modulo
    vec3 intT = texture2D(uIntMap, intQ.xz * uIntA.x).rgb;
    float intK = intT.r * smoothstep(0.35, 0.75, intT.b)
      * (1.0 - smoothstep(intT.g - 0.12, intT.g + 0.02, intQ.y));
    intDark = intK;
    if (intK > 0.001) {
      float intAmb = mix(1.0, uIntB.x, intK);
      float intSun = mix(1.0, uIntB.y, intK);
      reflectedLight.indirectDiffuse *= intAmb;
      reflectedLight.indirectSpecular *= intAmb;
      reflectedLight.directDiffuse *= intSun;
      reflectedLight.directSpecular *= intSun;
    }
  }
}`;

interface PatchableShader {
  uniforms: Record<string, THREE.IUniform>;
  fragmentShader: string;
}

/** Adds the interior darkening to a lit built-in shader (called by injectNightLights). */
export function injectInteriorShade(shader: PatchableShader): void {
  const fs = shader.fragmentShader;
  if (fs.includes('uIntMap') || !fs.includes('#include <lights_fragment_end>')) return;
  Object.assign(shader.uniforms, interiorUniforms);
  shader.fragmentShader = fs
    .replace('#include <common>', `#include <common>
${INTERIOR_GLSL}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
${INTERIOR_END}`);
}

// Pending (not yet merged) walls and floors count too: they stand and show the same as merged ones;
// only placing a window or a door merges the walls it cuts, so a house without one stayed unshaded
const usable = (p: BuiltPiece): boolean => !isGreenhousePiece(p.type);
const isBlocker = (p: BuiltPiece): boolean =>
  usable(p) && (isSolidWallPiece(p.type) || isWindowPiece(p.type) || isDoorPiece(p.type) || isDoorwayPiece(p.type));
const isCover = (p: BuiltPiece): boolean =>
  usable(p) && (isFloorPiece(p.type) || isFoundationPiece(p.type) || PIECE_TRAITS[p.type]?.kind === 'roof');

/** Walls lower than this enclose no room (plinths under a porch floor, low garden walls). */
const ROOM_WALL_MIN_H = 1.5;

/**
 * The walls that can bound a room: tall ones, and short ones another wall stands on (a stack of
 * low walls makes a full one). A porch on low plinth walls under a roof stays outdoors.
 */
function roomWalls(segs: WallSeg[]): WallSeg[] {
  const key = (x: number, z: number) => `${Math.round(x * 4)},${Math.round(z * 4)}`;
  const bases = new Map<string, number[]>();
  for (const s of segs) {
    const k = key((s.p1.x + s.p2.x) / 2, (s.p1.y + s.p2.y) / 2);
    let list = bases.get(k);
    if (!list) bases.set(k, (list = []));
    list.push(s.yBase);
  }
  return segs.filter((s) => {
    if (s.yTop - s.yBase >= ROOM_WALL_MIN_H) return true;
    const list = bases.get(key((s.p1.x + s.p2.x) / 2, (s.p1.y + s.p2.y) / 2));
    return !!list && list.some((y) => Math.abs(y - s.yTop) < 0.2);
  });
}

/** Rectangle of world cells, inclusive. */
interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const overlaps = (a: Rect, b: Rect): boolean => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1;
const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b || (!!a && !!b && a.x0 === b.x0 && a.z0 === b.z0 && a.x1 === b.x1 && a.z1 === b.z1);
const intersect = (a: Rect, b: Rect): Rect | null => {
  const r = { x0: Math.max(a.x0, b.x0), z0: Math.max(a.z0, b.z0), x1: Math.min(a.x1, b.x1), z1: Math.min(a.z1, b.z1) };
  return r.x0 <= r.x1 && r.z0 <= r.z1 ? r : null;
};
const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** One house: walls that touch each other, the roofs / floors over them and its baked map. */
interface Cluster {
  key: string;
  segs: WallSeg[];
  covers: BuiltPiece[];
  /** World cells of its map (walls plus a margin) */
  rect: Rect;
  /** Half floats RGBA per cell of `rect`, null until baked */
  data: Uint16Array | null;
  maxY: number;
  cells: number;
  openings: number;
  /** Kept after the bake for re-summing the light when a door opens or closes */
  comp: Compose | null;
}

interface Opening {
  cx: number;
  cz: number;
  /** Unit normal pointing into the house */
  nx: number;
  nz: number;
  halfW: number;
  range: number;
  /** Light for the opening's size; times `openFactor` */
  base: number;
  /** A swing door: its share changes with open / closed. Null for windows and doorways. */
  door: BuiltPiece | null;
  /** Door state the light was last composed with */
  wasOpen: boolean;
  /** Share of light for windows and doorways */
  fixed: number;
  /** Light per cell (before `base`) in the box i0, j0 (local cells), bw x bh */
  i0: number;
  j0: number;
  bw: number;
  bh: number;
  field: Float32Array | null;
}

/**
 * Light a closed door still lets in, by its glass (0 = solid leaf). Open doors let in
 * DOOR_OPEN_LIGHT. Doors not listed are solid.
 */
const DOOR_GLASS: Partial<Record<BuildingPieceType, number>> = {
  [BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2]: 0.35,
  [BuildingPieceType.DOOR_GRAND_SIDELITES_2X2]: 0.4,
};
const DOOR_OPEN_LIGHT = 0.9;

const openFactor = (o: Opening): number => {
  if (!o.door) return o.fixed;
  return o.door.isOpen ? DOOR_OPEN_LIGHT : (DOOR_GLASS[o.door.type] ?? 0);
};

/**
 * Darkness per cell from the kept parts: sums the openings' light, softens it, and spreads it into
 * the walls' outer half. A few passes over the house's cells: well under a millisecond.
 */
function composeDarkness(cp: Compose): Float32Array {
  const { W, H, inside, blocked, mask, ao, skyLit, openings } = cp;
  const NN = W * H;
  const light = new Float32Array(NN);
  for (const o of openings) {
    o.wasOpen = !!o.door?.isOpen;
    const f = o.field;
    const w = o.base * openFactor(o);
    if (!f || w <= 0) continue;
    for (let bj = 0; bj < o.bh; bj++) {
      const row = (bj + o.j0) * W + o.i0;
      for (let bi = 0; bi < o.bw; bi++) light[row + bi] += w * f[bj * o.bw + bi];
    }
  }

  const k = new Float32Array(NN);
  const s = interiorSettings;
  for (let c = 0; c < NN; c++) {
    if (!inside[c]) continue;
    // Soft saturation: several windows light a room more, never as much as the yard
    const v = (1 - s.windowLight * (1 - Math.exp(-light[c] * (1 - s.cornerShade * ao[c])))) * (1 - s.skyLight * skyLit[c]);
    // Never exactly 0: 0 marks a cell as outside the house
    k[c] = Math.max(0.002, v);
  }

  // Soften: average among inside cells only (outdoor cells stay 0)
  const tmp = new Float32Array(NN);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const c = j * W + i;
      if (k[c] === 0) continue;
      let sum = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
          const v = k[jj * W + ii];
          if (v > 0) { sum += v; n++; }
        }
      }
      tmp[c] = sum / n;
    }
  }
  k.set(tmp);

  // The walls' outer half (no ceiling above it, so no darkness) takes the darkness of the inner
  // cells beside it. The texture filters between neighbouring cells, so a floor at the wall's foot
  // or a wall face in a corner read a share of the outer half and showed a light strip. The mask
  // stays 0 there, so the outside of the wall is not shaded by it.
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const c = j * W + i;
      if (!blocked[c] || k[c] > 0) continue;
      let sum = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
          const cc = jj * W + ii;
          if (mask[cc] && k[cc] > 0) { sum += k[cc]; n++; }
        }
      }
      if (n) tmp[c] = sum / n;
    }
  }
  return tmp;
}

/** What a house's darkness is made of, kept so a door opening or closing only re-sums the light. */
interface Compose {
  W: number;
  H: number;
  /** Cells inside the house (rooms and their walls) */
  inside: Uint8Array;
  blocked: Uint8Array;
  mask: Uint8Array;
  ao: Float32Array;
  skyLit: Float32Array;
  openings: Opening[];
}

export class InteriorLighting {
  public readonly texture: THREE.DataTexture;
  /** Statistics for the dev tools. */
  public readonly stats = { houses: 0, baked: 0, queued: 0, interiorCells: 0, openings: 0, lastBakeMs: 0, frameMs: 0 };

  private readonly data = new Uint16Array(N * N * 4);
  private readonly clusters = new Map<string, Cluster>();
  /** Keys found by the last discovery */
  private current = new Set<string>();
  /** Clusters copied into the ring texture, with the cells they were copied to */
  private readonly written = new Map<Cluster, Rect>();
  private readonly queue: Cluster[] = [];
  private job: { cl: Cluster; it: Generator<void, boolean>; t: number } | null = null;
  /** Window centre (world cell); NaN = not placed yet */
  private winX = NaN;
  private winZ = NaN;
  private focusY = 0;
  private seenRevision = -1;
  private checkTimer = 0;
  private dirtyTexture = false;
  private ray: RAPIER.Ray | null = null;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly buildings: BuildingManager
  ) {
    this.texture = new THREE.DataTexture(this.data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.needsUpdate = true;
    interiorUniforms.uIntMap.value = this.texture;
  }

  /** Drops every baked house (after changing `windowLight` / `cornerShade`). */
  public invalidate(): void {
    this.clusters.clear();
    this.written.clear();
    this.queue.length = 0;
    this.job = null;
    this.current = new Set();
    this.data.fill(0);
    this.dirtyTexture = true;
    this.seenRevision = -1;
    this.checkTimer = 0;
  }

  /** Call once per frame with the player (or camera, in the editor) position. */
  public update(dt: number, focus: THREE.Vector3): void {
    const u = interiorUniforms.uIntB.value;
    u.x = interiorSettings.ambient;
    u.y = interiorSettings.sun;
    if (!interiorSettings.enabled || !this.physics.world) {
      u.z = 0;
      return;
    }
    this.focusY = focus.y;

    // 1. Window follows the player: only copies from the cache
    const moved = !(Math.abs(focus.x - this.winX * CELL) < RECENTER && Math.abs(focus.z - this.winZ * CELL) < RECENTER);
    if (moved) {
      this.winX = Math.round(focus.x / CELL);
      this.winZ = Math.round(focus.z / CELL);
      this.syncWindow();
    }

    // 2. Which houses are around (when something was built, or the window moved)
    this.checkTimer -= dt;
    if (moved || (this.checkTimer <= 0 && this.seenRevision !== this.buildings.revision)) {
      this.checkTimer = 0.25;
      this.seenRevision = this.buildings.revision;
      this.discover(focus);
    }

    // 3. Bake within the frame budget
    const t0 = performance.now();
    this.runJobs(t0 + BUDGET_MS);
    this.stats.frameMs = performance.now() - t0;

    this.dropStale();
    this.checkDoors();
    if (this.dirtyTexture) {
      this.dirtyTexture = false;
      this.texture.needsUpdate = true;
      this.updateBox();
    }
    this.stats.queued = this.queue.length + (this.job ? 1 : 0);
  }

  // ------------------------------------------------------------------ houses around

  private windowRect(): Rect {
    const h = N / 2;
    return { x0: this.winX - h, z0: this.winZ - h, x1: this.winX + h - 1, z1: this.winZ + h - 1 };
  }

  /** Groups the walls around into houses and queues the ones not baked yet. */
  private discover(focus: THREE.Vector3): void {
    // A plain pass over all pieces: the spatial grid's query walks thousands of empty cells at this
    // radius (~30 ms), a distance test per piece costs a fraction of a millisecond
    const cx = this.winX * CELL, cz = this.winZ * CELL;
    const reach = N * CELL * 0.75 + 20;
    const pieces = this.buildings.getAllPieces().filter((p) => {
      const bb = p.worldBoundingBox;
      const dx = bb ? Math.max(bb.min.x - cx, 0, cx - bb.max.x) : Math.abs(p.position.x - cx);
      const dz = bb ? Math.max(bb.min.z - cz, 0, cz - bb.max.z) : Math.abs(p.position.z - cz);
      return dx * dx + dz * dz <= reach * reach;
    });
    const segs = roomWalls(pieces.filter(isBlocker).map((p) => describeWallSeg(p)));
    const covers = pieces.filter(isCover);

    // Union of walls whose ends come within 1 m of each other
    const n = segs.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    const bx = segs.map((s) => [Math.min(s.p1.x, s.p2.x) - 1, Math.min(s.p1.y, s.p2.y) - 1, Math.max(s.p1.x, s.p2.x) + 1, Math.max(s.p1.y, s.p2.y) + 1]);
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const A = bx[a], B = bx[b];
        if (A[0] <= B[2] && B[0] <= A[2] && A[1] <= B[3] && B[1] <= A[3]) parent[find(a)] = find(b);
      }
    }
    const groups = new Map<number, WallSeg[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      let g = groups.get(r);
      if (!g) groups.set(r, (g = []));
      g.push(segs[i]);
    }

    const win = this.windowRect();
    const found = new Set<string>();
    const pad = WALL_R + MARGIN * CELL;
    for (const g of groups.values()) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const s of g) {
        x0 = Math.min(x0, s.p1.x, s.p2.x);
        z0 = Math.min(z0, s.p1.y, s.p2.y);
        x1 = Math.max(x1, s.p1.x, s.p2.x);
        z1 = Math.max(z1, s.p1.y, s.p2.y);
      }
      const rect: Rect = {
        x0: Math.floor((x0 - pad) / CELL),
        z0: Math.floor((z0 - pad) / CELL),
        x1: Math.floor((x1 + pad) / CELL),
        z1: Math.floor((z1 + pad) / CELL),
      };
      if (!intersect(rect, win)) continue;
      const mine = covers.filter((p) => {
        const bb = p.worldBoundingBox;
        return !!bb && bb.max.x >= x0 && bb.min.x <= x1 && bb.max.z >= z0 && bb.min.z <= z1;
      });
      if (mine.length === 0) continue; // no roof, no floor: nothing can be inside
      const key = this.keyOf(g, mine);
      found.add(key);
      let cl = this.clusters.get(key);
      if (!cl) {
        cl = { key, segs: g, covers: mine, rect, data: null, maxY: 0, cells: 0, openings: 0, comp: null };
        this.clusters.set(key, cl);
      }
      if (!cl.data && this.job?.cl !== cl && !this.queue.includes(cl)) this.queue.push(cl);
    }
    this.current = found;

    // Nothing left to bake for houses that are gone; nearest houses first
    for (let i = this.queue.length - 1; i >= 0; i--) if (!found.has(this.queue[i].key)) this.queue.splice(i, 1);
    if (this.job && !found.has(this.job.cl.key)) {
      this.clusters.delete(this.job.cl.key);
      this.job = null;
    }
    const fx = focus.x / CELL, fz = focus.z / CELL;
    const dist = (c: Cluster) => Math.hypot((c.rect.x0 + c.rect.x1) / 2 - fx, (c.rect.z0 + c.rect.z1) / 2 - fz);
    this.queue.sort((a, b) => dist(a) - dist(b));

    // Copy in baked houses that are around but not on the texture yet
    for (const key of found) {
      const cl = this.clusters.get(key)!;
      if (cl.data && !this.written.has(cl)) this.write(cl);
    }

    // Keep a few baked houses that left, forget the rest
    let spare = 0;
    for (const [key, cl] of this.clusters) {
      if (found.has(key) || this.written.has(cl)) continue;
      if (++spare > CACHE_SPARE || !cl.data) this.clusters.delete(key);
    }

    let baked = 0;
    for (const key of found) if (this.clusters.get(key)?.data) baked++;
    this.stats.houses = found.size;
    this.stats.baked = baked;
  }

  /**
   * An outside door opened or closed: re-sum that house's light from the kept parts and copy only
   * the darkness channel again (no new bake). A handful of booleans per frame when nothing changed.
   */
  private checkDoors(): void {
    // Kept houses too, so one coming back into view is not copied in with the old light
    for (const cl of this.clusters.values()) {
      const cp = cl.comp;
      if (!cp || !cl.data) continue;
      let changed = false;
      for (const o of cp.openings) {
        if (o.door && !!o.door.isOpen !== o.wasOpen) { changed = true; break; }
      }
      if (!changed) continue;
      const k = composeDarkness(cp);
      const out = cl.data;
      const toHalf = THREE.DataUtils.toHalfFloat;
      for (let c = 0; c < k.length; c++) out[c * 4] = k[c] > 0 ? toHalf(k[c]) : 0;
      if (this.written.has(cl)) this.write(cl);
    }
  }

  /** Changes when any of the house's pieces moved, appeared or went away. */
  private keyOf(segs: WallSeg[], covers: BuiltPiece[]): string {
    const one = (p: BuiltPiece) =>
      `${p.id}:${p.type}:${p.position.x.toFixed(2)},${p.position.y.toFixed(2)},${p.position.z.toFixed(2)},${p.quaternion.y.toFixed(3)},${p.quaternion.w.toFixed(3)}`;
    const w = segs.map((s) => one(s.piece)).sort();
    const c = covers
      .map((p) => {
        const bb = p.worldBoundingBox!;
        return `${one(p)}:${bb.min.x.toFixed(2)},${bb.min.z.toFixed(2)},${bb.max.x.toFixed(2)},${bb.max.y.toFixed(2)},${bb.max.z.toFixed(2)}`;
      })
      .sort();
    return w.join('|') + '#' + c.join('|');
  }

  // ------------------------------------------------------------------ ring texture

  /** Re-clips every copied house to the moved window and copies in the ones that entered it. */
  private syncWindow(): void {
    const win = this.windowRect();
    for (const [cl, old] of Array.from(this.written)) {
      const clip = intersect(cl.rect, win);
      if (sameRect(clip, old)) continue;
      this.clear(old);
      this.written.delete(cl);
      if (clip) this.write(cl);
    }
    // Clearing may have wiped a neighbour's margin: copy every house again where it overlapped
    for (const cl of this.written.keys()) this.write(cl);
    for (const key of this.current) {
      const cl = this.clusters.get(key);
      if (cl?.data && !this.written.has(cl)) this.write(cl);
    }
  }

  /** Copies a baked house into the ring texture (the part inside the window). */
  private write(cl: Cluster): void {
    const src = cl.data;
    if (!src) return;
    const clip = intersect(cl.rect, this.windowRect());
    if (!clip) return;
    const w = cl.rect.x1 - cl.rect.x0 + 1;
    const dst = this.data;
    for (let gz = clip.z0; gz <= clip.z1; gz++) {
      const row = mod(gz, N) * N;
      for (let gx = clip.x0; gx <= clip.x1; gx++) {
        const s = ((gz - cl.rect.z0) * w + (gx - cl.rect.x0)) * 4;
        const t = (row + mod(gx, N)) * 4;
        // A neighbour's room wins over this house's outdoor margin
        if (src[s + 2] === 0 && dst[t + 2] !== 0) continue;
        dst[t] = src[s];
        dst[t + 1] = src[s + 1];
        dst[t + 2] = src[s + 2];
        dst[t + 3] = 0;
      }
    }
    this.written.set(cl, clip);
    this.dirtyTexture = true;
  }

  private clear(r: Rect): void {
    for (let gz = r.z0; gz <= r.z1; gz++) {
      const row = mod(gz, N) * N;
      for (let gx = r.x0; gx <= r.x1; gx++) this.data.fill(0, (row + mod(gx, N)) * 4, (row + mod(gx, N)) * 4 + 4);
    }
    this.dirtyTexture = true;
  }

  /** Takes a house off the texture, restoring neighbours it overlapped. */
  private unwrite(cl: Cluster): void {
    const r = this.written.get(cl);
    if (!r) return;
    this.written.delete(cl);
    this.clear(r);
    for (const [o, or] of this.written) if (overlaps(or, r)) this.write(o);
  }

  /**
   * Houses that changed keep their old map on screen until the new one is baked; one is taken off
   * once nothing being baked overlaps it (so a demolished house goes at once).
   */
  private dropStale(): void {
    for (const cl of Array.from(this.written.keys())) {
      if (this.current.has(cl.key)) continue;
      const pending = (this.job && overlaps(this.job.cl.rect, cl.rect)) || this.queue.some((q) => overlaps(q.rect, cl.rect));
      if (pending) continue;
      // Stays in the cache (a house that only left the window comes back without a rebake);
      // discovery forgets old ones past CACHE_SPARE
      this.unwrite(cl);
    }
  }

  /** The baked houses' box and highest roof, for the shader's early out. */
  private updateBox(): void {
    const box = interiorUniforms.uIntBox.value;
    const win = this.windowRect();
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y = -Infinity;
    for (const [cl, r] of this.written) {
      x0 = Math.min(x0, r.x0);
      z0 = Math.min(z0, r.z0);
      x1 = Math.max(x1, r.x1);
      z1 = Math.max(z1, r.z1);
      y = Math.max(y, cl.maxY);
    }
    const on = interiorUniforms.uIntB.value;
    if (x0 === Infinity) {
      on.z = 0;
      return;
    }
    // One cell in from the window's edge: the filter there reads texels of the far side
    x0 = Math.max(x0, win.x0 + 1);
    z0 = Math.max(z0, win.z0 + 1);
    x1 = Math.min(x1, win.x1 - 1);
    z1 = Math.min(z1, win.z1 - 1);
    box.set(x0 * CELL, z0 * CELL, (x1 + 1) * CELL, (z1 + 1) * CELL);
    interiorUniforms.uIntA.value.y = y + 0.1;
    on.z = 1;
  }

  // ------------------------------------------------------------------ baking

  private runJobs(deadline: number): void {
    while (performance.now() < deadline) {
      if (!this.job) {
        const cl = this.queue.shift();
        if (!cl) return;
        this.job = { cl, it: this.bake(cl), t: 0 };
      }
      const job = this.job;
      let done = false;
      let ok = false;
      const t0 = performance.now();
      try {
        while (performance.now() < deadline) {
          const r = job.it.next();
          if (r.done) {
            done = true;
            ok = r.value;
            break;
          }
        }
      } catch (e) {
        // A piece went away under the bake (its collider is gone): the next discovery redoes it
        console.warn('[InteriorLighting] bake aborted', e);
        done = true;
      }
      job.t += performance.now() - t0;
      if (!done) return;
      this.job = null;
      if (ok && this.current.has(job.cl.key)) {
        this.stats.lastBakeMs = job.t;
        this.stats.baked++;
        this.write(job.cl);
      } else {
        this.clusters.delete(job.cl.key);
      }
    }
  }

  /** Bakes one house's map; yields often so the work spreads over frames. */
  private *bake(cl: Cluster): Generator<void, boolean> {
    const { rect, segs } = cl;
    const W = rect.x1 - rect.x0 + 1;
    const H = rect.z1 - rect.z0 + 1;
    const NN = W * H;
    // World position of a local cell's centre
    const ox = rect.x0 * CELL, oz = rect.z0 * CELL;
    const blocked = new Uint8Array(NN);
    const outside = new Uint8Array(NN);
    const k = new Float32Array(NN);
    const tmp = new Float32Array(NN);
    const cover = new Float32Array(NN).fill(NaN);
    const mask = new Uint8Array(NN);

    // 1. Walls and openings into the grid, as thick lines.
    // 1 = wall, 2 = window / door / doorway (blocks the fill like a wall, but is not a dark wall for
    // the corner shading); a plain wall wins where they overlap
    for (const s of segs) {
      const mark = isSolidWallPiece(s.piece.type) ? 1 : 2;
      const ax = s.p1.x - ox, az = s.p1.y - oz, bx = s.p2.x - ox, bz = s.p2.y - oz;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - WALL_R) / CELL));
      const i1 = Math.min(W - 1, Math.floor((Math.max(ax, bx) + WALL_R) / CELL));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - WALL_R) / CELL));
      const j1 = Math.min(H - 1, Math.floor((Math.max(az, bz) + WALL_R) / CELL));
      const dx = bx - ax, dz = bz - az;
      const len2 = Math.max(dx * dx + dz * dz, 1e-6);
      for (let j = j0; j <= j1; j++) {
        const pz = (j + 0.5) * CELL;
        for (let i = i0; i <= i1; i++) {
          const px = (i + 0.5) * CELL;
          const t = Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / len2));
          const ex = px - (ax + dx * t), ez = pz - (az + dz * t);
          if (ex * ex + ez * ez > WALL_R * WALL_R) continue;
          const c = j * W + i;
          if (blocked[c] !== 1) blocked[c] = mark;
        }
      }
    }

    // 2. Flood fill the outdoors from the map's border
    const stack = new Int32Array(NN);
    let sp = 0;
    const seed = (c: number) => {
      if (blocked[c] || outside[c]) return;
      outside[c] = 1;
      stack[sp++] = c;
    };
    for (let i = 0; i < W; i++) {
      seed(i);
      seed((H - 1) * W + i);
    }
    for (let j = 0; j < H; j++) {
      seed(j * W);
      seed(j * W + W - 1);
    }
    while (sp > 0) {
      const c = stack[--sp];
      const i = c % W;
      if (i > 0) seed(c - 1);
      if (i < W - 1) seed(c + 1);
      if (c >= W) seed(c - W);
      if (c < NN - W) seed(c + W);
    }
    yield;

    // 3. Cover above every enclosed cell (and the walls near one): the first roof / floor a
    // downward ray meets. No cover = open to the sky. Each cover collider is cast directly (no
    // world query with a filter callback per candidate), only the few whose bounds hold the cell.
    const casters: { c: RAPIER.Collider; roof: boolean; x0: number; z0: number; x1: number; z1: number }[] = [];
    let topY = -Infinity;
    for (const p of cl.covers) {
      const bb = p.worldBoundingBox;
      if (!bb) continue;
      topY = Math.max(topY, bb.max.y);
      const roof = PIECE_TRAITS[p.type]?.kind === 'roof';
      const add = (c: RAPIER.Collider) => c.isValid() && casters.push({ c, roof, x0: bb.min.x - 0.05, z0: bb.min.z - 0.05, x1: bb.max.x + 0.05, z1: bb.max.z + 0.05 });
      const body = p.staticBody;
      if (body && body.isValid?.() !== false) {
        const nc = body.numColliders();
        for (let c = 0; c < nc; c++) add(body.collider(c));
      } else if (p.staticCollider) {
        add(p.staticCollider);
      }
    }
    if (!Number.isFinite(topY)) return false;
    const castTop = topY + 1;
    const castLen = castTop - this.focusY + 200;
    const ray = (this.ray ??= new this.physics.rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }));
    const enclosedOpen = (c: number) => !outside[c] && !blocked[c];
    // Enclosed cells open to the sky: the only thing above is the floor they stand on (walls with
    // no roof or ceiling over this part). They light the covered part next to them.
    const sky = new Uint8Array(NN);
    let cells = 0;
    let casts = 0;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const c = j * W + i;
        if (outside[c]) continue;
        if (blocked[c]) {
          // A wall cell counts when an enclosed cell is near (the whole wall thickness, so the
          // darkness filters smoothly into the walls; lone walls stay outdoors)
          let touches = false;
          for (let dj = -2; dj <= 2 && !touches; dj++) {
            for (let di = -2; di <= 2; di++) {
              const ii = i + di, jj = j + dj;
              if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
              if (enclosedOpen(jj * W + ii)) { touches = true; break; }
            }
          }
          if (!touches) continue;
        }
        // Off the cell centre by an odd amount: the centres of a grid line up exactly on a roof's
        // ridges and 45-degree valleys, where a ray can slip through the crack between triangles
        const px = ox + (i + 0.5) * CELL + 0.0137, pz = oz + (j + 0.5) * CELL + 0.0061;
        ray.origin.x = px;
        ray.origin.y = castTop;
        ray.origin.z = pz;
        let toi = Infinity, far = -Infinity, topRoof = false;
        for (const cc of casters) {
          if (px < cc.x0 || px > cc.x1 || pz < cc.z0 || pz > cc.z1) continue;
          const t = cc.c.castRay(ray, castLen, true);
          if (t < 0) continue;
          if (t < toi) { toi = t; topRoof = cc.roof; }
          if (t > far) far = t;
        }
        if (++casts % 48 === 0) {
          yield;
          // A piece removed while this bake waited frees its collider; a cast on a freed collider
          // panics inside Rapier and leaves the whole physics world unusable, so stop here (the
          // next discovery bakes the house again)
          for (const cc of casters) if (!cc.c.isValid()) return false;
        }
        if (toi === Infinity) continue;
        cover[c] = castTop - toi;
        // One level of floor (a floor on a foundation counts as one) and no roof: open sky
        if (!topRoof && far - toi < 1.2 && !blocked[c]) sky[c] = 1;
        k[c] = 1;
        cells++;
      }
    }
    cl.cells = cells;
    // Open-sky cells take the height of the nearest ceiling instead of their floor: with the floor's
    // height the shading cut off in a hard line along the opening's edge; this way the light is a
    // soft gradient from the darkness value alone
    {
      const q = new Int32Array(NN);
      let qh = 0, qt = 0;
      let anyCovered = false;
      for (let c = 0; c < NN; c++) {
        if (k[c] > 0 && !sky[c] && !blocked[c]) { q[qt++] = c; anyCovered = true; }
      }
      if (anyCovered) {
        const filled = new Uint8Array(NN);
        while (qh < qt) {
          const c = q[qh++];
          const i = c % W;
          const nb = [i > 0 ? c - 1 : -1, i < W - 1 ? c + 1 : -1, c >= W ? c - W : -1, c < NN - W ? c + W : -1];
          for (const n of nb) {
            if (n < 0 || !sky[n] || filled[n]) continue;
            filled[n] = 1;
            cover[n] = cover[c];
            q[qt++] = n;
          }
        }
      }
    }
    if (cells === 0) {
      cl.data = new Uint16Array(NN * 4);
      cl.maxY = -Infinity;
      return true;
    }
    yield;

    // 4. Daylight through windows and doorways that open to the outside
    const openings: Opening[] = [];
    for (const s of segs) {
      const p = s.piece;
      const win = isWindowPiece(p.type);
      const doorway = isDoorwayPiece(p.type);
      const door = isDoorPiece(p.type);
      if (!win && !doorway && !door) continue;
      const cx = (s.p1.x + s.p2.x) / 2, cz = (s.p1.y + s.p2.y) / 2;
      const side = (sgn: number): number => {
        // 1 = outdoors, 2 = inside, 0 = neither
        const i = Math.floor((cx + s.left.x * (0.3 + CELL) * sgn - ox) / CELL);
        const j = Math.floor((cz + s.left.y * (0.3 + CELL) * sgn - oz) / CELL);
        if (i < 0 || j < 0 || i >= W || j >= H) return 1;
        const c = j * W + i;
        if (outside[c]) return 1;
        return k[c] > 0 ? 2 : 0;
      };
      const a = side(1), b = side(-1);
      let sgn: number;
      if (a === 2 && b === 1) sgn = 1;
      else if (a === 1 && b === 2) sgn = -1;
      else continue; // between two rooms, or nowhere near one
      const width = s.halfW * 2;
      const height = s.yTop - s.yBase;
      openings.push({
        cx,
        cz,
        nx: s.left.x * sgn,
        nz: s.left.y * sgn,
        halfW: s.halfW,
        range: 2.5 + width * 1.6 + height * 0.4,
        base: Math.min(1.4, 0.55 + (width * height) / 4),
        door: door ? p : null,
        wasOpen: !!p.isOpen,
        fixed: doorway ? 1 : 0.75,
        i0: 0,
        j0: 0,
        bw: 0,
        bh: 0,
        field: null,
      });
    }
    cl.openings = openings.length;

    // Light reaches a cell along the shortest path through the rooms (a chamfer distance transform
    // from the opening, walls stop it), so it falls off around corners and through inner doors.
    // Each opening keeps its own field: opening or closing a door only re-sums them (compose)
    const D = CELL, DD = CELL * Math.SQRT2;
    for (const o of openings) {
      const i0 = Math.max(0, Math.floor((o.cx - o.range - ox) / CELL));
      const i1 = Math.min(W - 1, Math.floor((o.cx + o.range - ox) / CELL));
      const j0 = Math.max(0, Math.floor((o.cz - o.range - oz) / CELL));
      const j1 = Math.min(H - 1, Math.floor((o.cz + o.range - oz) / CELL));
      const bw = i1 - i0 + 1, bh = j1 - j0 + 1;
      if (bw <= 0 || bh <= 0) continue;
      const field = new Float32Array(bw * bh);
      o.i0 = i0;
      o.j0 = j0;
      o.bw = bw;
      o.bh = bh;
      o.field = field;
      const dist = new Float32Array(bw * bh).fill(Infinity);
      // Seeds: open cells just inside the opening
      const tx = -o.nz, tz = o.nx; // along the wall
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const c = j * W + i;
          if (blocked[c] || k[c] === 0) continue;
          const px = ox + (i + 0.5) * CELL - o.cx, pz = oz + (j + 0.5) * CELL - o.cz;
          const along = px * o.nx + pz * o.nz;
          const across = Math.abs(px * tx + pz * tz);
          if (along > 0 && along < 0.3 + CELL * 1.5 && across <= o.halfW) dist[(j - j0) * bw + (i - i0)] = Math.hypot(px, pz);
        }
      }
      const open = (bi: number, bj: number) => blocked[(bj + j0) * W + bi + i0] === 0;
      for (let pass = 0; pass < 2; pass++) {
        for (let bj = 0; bj < bh; bj++) {
          for (let bi = 0; bi < bw; bi++) {
            if (!open(bi, bj)) continue;
            const c = bj * bw + bi;
            let d = dist[c];
            if (bi > 0 && dist[c - 1] + D < d) d = dist[c - 1] + D;
            if (bj > 0) {
              if (dist[c - bw] + D < d) d = dist[c - bw] + D;
              if (bi > 0 && dist[c - bw - 1] + DD < d) d = dist[c - bw - 1] + DD;
              if (bi < bw - 1 && dist[c - bw + 1] + DD < d) d = dist[c - bw + 1] + DD;
            }
            dist[c] = d;
          }
        }
        for (let bj = bh - 1; bj >= 0; bj--) {
          for (let bi = bw - 1; bi >= 0; bi--) {
            if (!open(bi, bj)) continue;
            const c = bj * bw + bi;
            let d = dist[c];
            if (bi < bw - 1 && dist[c + 1] + D < d) d = dist[c + 1] + D;
            if (bj < bh - 1) {
              if (dist[c + bw] + D < d) d = dist[c + bw] + D;
              if (bi < bw - 1 && dist[c + bw + 1] + DD < d) d = dist[c + bw + 1] + DD;
              if (bi > 0 && dist[c + bw - 1] + DD < d) d = dist[c + bw - 1] + DD;
            }
            dist[c] = d;
          }
        }
      }
      for (let bj = 0; bj < bh; bj++) {
        for (let bi = 0; bi < bw; bi++) {
          const c = (bj + j0) * W + bi + i0;
          if (k[c] === 0) continue;
          let d = dist[bj * bw + bi];
          if (blocked[c]) {
            // A wall cell is lit on its inner face: from the nearest open cell
            for (let dj = -1; dj <= 1; dj++) {
              for (let di = -1; di <= 1; di++) {
                const ni = bi + di, nj = bj + dj;
                if (ni < 0 || nj < 0 || ni >= bw || nj >= bh || !open(ni, nj)) continue;
                d = Math.min(d, dist[nj * bw + ni] + D * 0.5);
              }
            }
          }
          if (!(d < o.range)) continue;
          const px = ox + (bi + i0 + 0.5) * CELL - o.cx, pz = oz + (bj + j0 + 0.5) * CELL - o.cz;
          const e = Math.hypot(px, pz);
          const along = px * o.nx + pz * o.nz;
          if (along < -0.3) continue; // behind the opening's wall
          const f = 1 - d / o.range;
          const facing = e > 0.01 ? Math.max(0, along / e) : 1;
          field[bj * bw + bi] = f * f * (0.45 + 0.55 * facing);
        }
      }
      yield;
    }

    // Light from the open sky over the room's uncovered part spreads in under the ceiling the same
    // way (one distance transform from every open cell), so a small ceiling over an open room is a
    // soft shade instead of a black box
    // skyLit: 1 well inside the open part, 0 deep under the ceiling, a smooth ramp across the edge
    // (from a signed distance to the edge: the open side reaches back toward the ceiling, the covered
    // side toward the sky)
    const skyLit = new Float32Array(NN);
    let anySky = false;
    for (let c = 0; c < NN; c++) if (sky[c] && k[c] > 0) { anySky = true; break; }
    if (anySky) {
      const room = (c: number) => !blocked[c] && k[c] > 0;
      const D = CELL, DD = CELL * Math.SQRT2;
      // Chamfer distance through the room's open cells from the seeded ones
      function* chamfer(dist: Float32Array): Generator<void> {
        const pass = (c: number, n: number, cost: number) => {
          if (dist[n] + cost < dist[c]) dist[c] = dist[n] + cost;
        };
        for (let it = 0; it < 2; it++) {
          for (let j = 0; j < H; j++) {
            for (let i = 0; i < W; i++) {
              const c = j * W + i;
              if (!room(c)) continue;
              if (i > 0) pass(c, c - 1, D);
              if (j > 0) {
                pass(c, c - W, D);
                if (i > 0) pass(c, c - W - 1, DD);
                if (i < W - 1) pass(c, c - W + 1, DD);
              }
            }
          }
          for (let j = H - 1; j >= 0; j--) {
            for (let i = W - 1; i >= 0; i--) {
              const c = j * W + i;
              if (!room(c)) continue;
              if (i < W - 1) pass(c, c + 1, D);
              if (j < H - 1) {
                pass(c, c + W, D);
                if (i < W - 1) pass(c, c + W + 1, DD);
                if (i > 0) pass(c, c + W - 1, DD);
              }
            }
          }
          yield;
        }
      }
      const toSky = new Float32Array(NN).fill(Infinity);
      const toCover = new Float32Array(NN).fill(Infinity);
      for (let c = 0; c < NN; c++) {
        if (!room(c)) continue;
        if (sky[c]) toSky[c] = 0;
        else toCover[c] = 0;
      }
      yield* chamfer(toSky);
      yield* chamfer(toCover);
      // Signed: > 0 under the ceiling (metres to the open part), < 0 in the open part
      const signed = (c: number) => (sky[c] ? -toCover[c] : toSky[c]);
      const lit = (s: number) => 1 - THREE.MathUtils.smoothstep(s, -1, 2.5);
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const c = j * W + i;
          if (k[c] === 0) continue;
          if (!blocked[c]) {
            skyLit[c] = lit(signed(c));
            continue;
          }
          // Wall cells: as lit as the open cells beside them
          let sum = 0, n = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const ii = i + di, jj = j + dj;
              if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
              const cc = jj * W + ii;
              if (!room(cc)) continue;
              sum += lit(signed(cc));
              n++;
            }
          }
          if (n) skyLit[c] = sum / n;
        }
      }
    }

    // Corners and the strips along walls get less of the window light (a 2D ambient occlusion:
    // the share of wall cells around)
    const ao = new Float32Array(NN);
    const inside = new Uint8Array(NN);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const c = j * W + i;
        if (k[c] === 0) continue;
        inside[c] = 1;
        let walls = 0, all = 0;
        for (let dj = -AO_R; dj <= AO_R; dj++) {
          for (let di = -AO_R; di <= AO_R; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
            const cc = jj * W + ii;
            if (outside[cc]) continue;
            all++;
            if (blocked[cc] === 1) walls++;
          }
        }
        ao[c] = THREE.MathUtils.smoothstep(walls / Math.max(all, 1), 0.08, 0.5);
      }
    }

    // Inside mask: enclosed cells plus the wall cells right next to one (the walls' inner half)
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const c = j * W + i;
        if (!inside[c]) continue;
        if (!blocked[c]) { mask[c] = 1; continue; }
        for (let dj = -1; dj <= 1 && !mask[c]; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
            const cc = jj * W + ii;
            if (!blocked[cc] && inside[cc]) { mask[c] = 1; break; }
          }
        }
      }
    }

    const comp: Compose = { W, H, inside, blocked, mask, ao, skyLit, openings };
    cl.comp = comp;
    k.set(composeDarkness(comp));
    yield;

    // A lone cell far below most of its neighbours is a ray that slipped through the roof anyway
    // (it hit the floor): take the neighbours' median instead, before the step below spreads it
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const c = j * W + i;
        const y = cover[c];
        tmp[c] = y;
        if (Number.isNaN(y)) continue;
        const around: number[] = [];
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
            const v = cover[jj * W + ii];
            if (!Number.isNaN(v)) around.push(v);
          }
        }
        if (around.length < 5) continue;
        around.sort((a, b) => a - b);
        const median = around[around.length >> 1];
        const higher = around.filter((v) => v > y + 0.5).length;
        if (higher >= around.length - 2) tmp[c] = median;
      }
    }
    cover.set(tmp);

    // Where a low roof meets a taller wall, wall cells take the lowest cover of the covered room
    // cells beside them, so the low roof's height is not lifted up the tall wall. Room cells keep
    // their own cover: pulling it down from outer wall halves or open-sky cells lit strips along walls
    tmp.set(cover);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const c = j * W + i;
        if (!blocked[c]) continue;
        let lo = Infinity;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
            const cc = jj * W + ii;
            if (blocked[cc] || !(k[cc] > 0)) continue;
            const v = cover[cc];
            if (v < lo) lo = v;
          }
        }
        if (lo < Infinity) tmp[c] = lo;
      }
    }
    cover.set(tmp);
    // ...and the outer half of the wall takes the inner half's height, for the same filtering
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const c = j * W + i;
        if (!blocked[c] || mask[c] || !(k[c] > 0)) continue;
        let lo = Infinity;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
            const cc = jj * W + ii;
            if (mask[cc] && cover[cc] < lo) lo = cover[cc];
          }
        }
        if (lo < Infinity) tmp[c] = lo;
      }
    }
    cover.set(tmp);

    // 6. Cover heights spill two cells outward, so filtering at a room's edge stays sane
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const c = j * W + i;
          tmp[c] = cover[c];
          if (!Number.isNaN(cover[c])) continue;
          if (i > 0 && !Number.isNaN(cover[c - 1])) tmp[c] = cover[c - 1];
          else if (i < W - 1 && !Number.isNaN(cover[c + 1])) tmp[c] = cover[c + 1];
          else if (j > 0 && !Number.isNaN(cover[c - W])) tmp[c] = cover[c - W];
          else if (j < H - 1 && !Number.isNaN(cover[c + W])) tmp[c] = cover[c + W];
        }
      }
      cover.set(tmp);
    }
    yield;

    // 7. Pack as half floats
    const out = new Uint16Array(NN * 4);
    const toHalf = THREE.DataUtils.toHalfFloat;
    const one = toHalf(1);
    let maxY = -Infinity;
    for (let c = 0; c < NN; c++) {
      const y = cover[c];
      if (k[c] > 0) out[c * 4] = toHalf(k[c]);
      if (!Number.isNaN(y)) {
        out[c * 4 + 1] = toHalf(y);
        if (mask[c] && y > maxY) maxY = y;
      }
      if (mask[c]) out[c * 4 + 2] = one;
    }
    cl.data = out;
    cl.maxY = maxY;
    return true;
  }
}
