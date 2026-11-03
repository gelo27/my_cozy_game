import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';

/**
 * Pathfinding for agents in an open, player-buildable world.
 *
 * A pre-baked navmesh would go stale the moment the player builds a wall, so the walkable space is
 * a lazily sampled 2.5D grid built straight from the physics world:
 * - a cell (0.5 m) is sampled only when a search touches it: one downward ray finds the floor (terrain,
 *   building floor, stair step) and one box overlap checks there is body-sized headroom (no wall, tree,
 *   fence, closed door). Results are cached and the cache is dropped when the world revision changes
 *   (building placed/removed/door toggled, props moved), so new houses are respected instantly;
 * - cells are keyed by the floor level they were sampled from, so ground and upper floors coexist;
 * - neighbours connect only within a step height (stairs work, cliffs and walls don't), with no
 *   corner cutting.
 *
 * Search, cheapest first (most open-world requests never reach A*):
 * 1. straight line: walk the segment through the grid; if clear, the path is just the target;
 * 2. A* (octile heuristic, binary heap) inside a window around start and goal, with a node budget.
 *    If the budget runs out the path to the node closest to the goal is returned (partial path),
 *    and the agent re-plans from there;
 * 3. string pulling: waypoints are dropped while the line of sight between neighbours is clear, so
 *    agents walk straight lines instead of grid zigzags.
 *
 * Doors: a 0.84 m doorway is narrower than two grid cells, so cell centres rarely fit through it. Cells
 * inside a door opening are tested on the doorway's centre line with the door's own colliders
 * ignored, which makes doorways walkable whether the door is open or closed. After smoothing, every
 * crossing gets a waypoint in front of and behind the door (tagged with the door) so agents walk
 * straight through the middle and know which door to open.
 *
 * Cost control: cached cells are free, only new physics samples cost (~30 us each). Each findPath
 * call may take at most `sampleBudget` new samples; when it runs out the search returns the best
 * partial path and flags `lastPartial`, the agent starts walking and re-plans a moment later with
 * a warmer cache. So a cold search around a big house is spread over a few frames, never a spike.
 */

export interface NavConfig {
  cell: number;
  /** Clearance box half-width (agent radius, slightly less so 1 m doorways fit). */
  radius: number;
  height: number;
  maxStepUp: number;
  maxDrop: number;
  /** Lowest walkable floor (e.g. the water surface for agents that don't swim). */
  minFloorY: () => number;
  /** Door openings, re-read when the revision changes. */
  doors?: () => NavDoor[];
}

export interface NavDoor {
  id: string;
  /** Floor centre of the opening. */
  x: number;
  y: number;
  z: number;
  /** Horizontal normal of the door plane. */
  nx: number;
  nz: number;
  /** Clear half-width between the jambs. */
  half: number;
  /** Body holding the frame and leaf colliders (ignored when testing doorway cells). */
  body: RAPIER.RigidBody | null;
}

/** A path waypoint; `door` is set on the points just before and after a doorway. */
export type PathPoint = THREE.Vector3 & { door?: NavDoor };

interface Cell {
  walkable: boolean;
  y: number;
}

interface Node {
  key: number;
  cx: number;
  cz: number;
  y: number;
  g: number;
  f: number;
  parent: Node | null;
  closed: boolean;
  heapIndex: number;
}

const SQRT2 = Math.SQRT2;
const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

export class GridNavigator {
  private cells = new Map<number, Cell>();
  private revision = -1;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly box: RAPIER.Cuboid;
  private readonly identity = { x: 0, y: 0, z: 0, w: 1 };
  private readonly flags =
    RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
  /** Raw physics queries done (for profiling). */
  public samples = 0;
  /** True when the last findPath stopped early (budget) and returned a partial path. */
  public lastPartial = false;
  private sampleLimit = Infinity;
  private doors: NavDoor[] = [];

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly getRevision: () => number,
    public readonly cfg: NavConfig
  ) {
    // Starts above step height so stairs and kerbs don't count as obstacles
    this.box = new RAPIER.Cuboid(cfg.radius, (cfg.height - cfg.maxStepUp) / 2, cfg.radius);
  }

  /** Forget cells around a point (e.g. when an agent got stuck on something the cache missed). */
  public invalidateAround(p: THREE.Vector3, radius: number): void {
    const r = Math.ceil(radius / this.cfg.cell);
    const cx = this.toCell(p.x);
    const cz = this.toCell(p.z);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let lv = -3; lv <= 3; lv++) this.cells.delete(this.key(cx + dx, cz + dz, this.level(p.y) + lv));
      }
    }
  }

  /**
   * Path from `start` to `goal` as world points (the first point is the next waypoint, the last is
   * the goal or the closest reachable point). Empty when no progress is possible.
   */
  public findPath(start: THREE.Vector3, goal: THREE.Vector3, maxNodes = 2500, sampleBudget = 160): PathPoint[] {
    this.checkRevision();
    this.lastPartial = false;
    this.sampleLimit = this.samples + sampleBudget;
    try {
      return this.plan(start, goal, maxNodes);
    } finally {
      this.sampleLimit = Infinity;
    }
  }

  private plan(start: THREE.Vector3, goal: THREE.Vector3, maxNodes: number): PathPoint[] {
    const path = this.planRaw(start, goal, maxNodes);
    return this.doors.length ? this.throughDoors(start, path) : path;
  }

  /** Inserts centred waypoints at every doorway the path crosses. */
  private throughDoors(start: THREE.Vector3, path: PathPoint[]): PathPoint[] {
    const out: PathPoint[] = [];
    let ax = start.x, az = start.z, ay = start.y;
    for (const p of path) {
      for (const d of this.doors) {
        if (Math.abs(d.y - ay) > 1.5 && Math.abs(d.y - p.y) > 1.5) continue;
        const sa = (ax - d.x) * d.nx + (az - d.z) * d.nz;
        const sb = (p.x - d.x) * d.nx + (p.z - d.z) * d.nz;
        if (sa * sb >= 0) continue;
        // Where the segment crosses the door plane, measured along the door
        const t = sa / (sa - sb);
        const lx = ax + (p.x - ax) * t - d.x, lz = az + (p.z - az) * t - d.z;
        if (Math.abs(lx * d.nz - lz * d.nx) > d.half + 0.6) continue;
        const side = Math.sign(sa);
        const before: PathPoint = new THREE.Vector3(d.x + d.nx * 0.7 * side, d.y, d.z + d.nz * 0.7 * side);
        const after: PathPoint = new THREE.Vector3(d.x - d.nx * 0.7 * side, d.y, d.z - d.nz * 0.7 * side);
        before.door = after.door = d;
        out.push(before, after);
      }
      out.push(p);
      ax = p.x;
      az = p.z;
      ay = p.y;
    }
    return out;
  }

  private planRaw(start: THREE.Vector3, goal: THREE.Vector3, maxNodes: number): PathPoint[] {
    const s = this.snap(start.x, start.z, start.y);
    if (!s) {
      // Pressed against a wall: the agent's own cell fails the clearance test, step off it first
      const free = this.nearestWalkable(start, 2);
      if (!free) return [];
      const off = new THREE.Vector3(free.x, free.y, free.z) as PathPoint;
      return [off, ...this.planRaw(off, goal, maxNodes)];
    }
    let g = this.snap(goal.x, goal.z, goal.y);
    if (!g) g = this.nearestWalkable(goal);
    if (!g) return [];

    // 1. Straight line (the common case in open terrain)
    if (this.lineWalkable(start.x, start.z, s.y, g.x, g.z)) return [new THREE.Vector3(g.x, g.y, g.z) as PathPoint];

    // 2. A*
    const nodes = this.astar(s, g, maxNodes);
    if (nodes.length === 0) return [];

    // 3. String pulling
    const pts = nodes.map((n) => new THREE.Vector3(this.toWorld(n.cx), n.y, this.toWorld(n.cz)));
    const out: THREE.Vector3[] = [];
    let ax = start.x, az = start.z, ay = s.y;
    let i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      // Smoothing checks only cells A* already sampled, so it never spends extra queries
      while (j > i && !this.lineWalkable(ax, az, ay, pts[j].x, pts[j].z, true)) j--;
      out.push(pts[j]);
      ax = pts[j].x;
      az = pts[j].z;
      ay = pts[j].y;
      i = j + 1;
    }
    return out;
  }

  /** Walkable floor at (x, z) for an agent standing near height y, or null. */
  public snap(x: number, z: number, y: number): { x: number; z: number; y: number } | null {
    const cx = this.toCell(x);
    const cz = this.toCell(z);
    const c = this.sample(cx, cz, y);
    return c.walkable ? { x, z, y: c.y } : null;
  }

  /** Closest walkable cell in growing rings around p (for unreachable goals). */
  public nearestWalkable(p: THREE.Vector3, maxRing = 6): { x: number; z: number; y: number } | null {
    const cx = this.toCell(p.x);
    const cz = this.toCell(p.z);
    for (let r = 1; r <= maxRing; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const c = this.sample(cx + dx, cz + dz, p.y);
          if (c.walkable) return { x: this.toWorld(cx + dx), z: this.toWorld(cz + dz), y: c.y };
        }
      }
    }
    return null;
  }

  /** True when an agent can walk the straight segment (floor everywhere, no walls, small steps only). */
  public lineWalkable(ax: number, az: number, ay: number, bx: number, bz: number, cachedOnly = false): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const step = this.cfg.cell * 0.5;
    const n = Math.max(1, Math.ceil(len / step));
    let y = ay;
    let lastCx = NaN, lastCz = NaN;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const cx = this.toCell(ax + dx * t);
      const cz = this.toCell(az + dz * t);
      if (cx === lastCx && cz === lastCz) continue;
      // Moving diagonally between cells: both side cells must be open too (no clipping corners)
      if (!Number.isNaN(lastCx) && cx !== lastCx && cz !== lastCz) {
        if (!this.passable(this.sample(cx, lastCz, y, cachedOnly), y) || !this.passable(this.sample(lastCx, cz, y, cachedOnly), y)) return false;
      }
      const c = this.sample(cx, cz, y, cachedOnly);
      if (!this.passable(c, y)) return false;
      y = c.y;
      lastCx = cx;
      lastCz = cz;
    }
    return true;
  }

  // ------------------------------------------------------------------ A*

  private astar(s: { x: number; z: number; y: number }, g: { x: number; z: number; y: number }, maxNodes: number): Node[] {
    const gcx = this.toCell(g.x);
    const gcz = this.toCell(g.z);
    const scx = this.toCell(s.x);
    const scz = this.toCell(s.z);
    // Search window: the bounding box of start/goal plus a margin to walk around buildings
    const margin = 40;
    const minX = Math.min(scx, gcx) - margin, maxX = Math.max(scx, gcx) + margin;
    const minZ = Math.min(scz, gcz) - margin, maxZ = Math.max(scz, gcz) + margin;

    const nodes = new Map<number, Node>();
    const heap: Node[] = [];
    const h = (cx: number, cz: number) => {
      const dx = Math.abs(cx - gcx), dz = Math.abs(cz - gcz);
      return (dx + dz + (SQRT2 - 2) * Math.min(dx, dz)) * 1.001; // octile, tie-break toward goal
    };
    const start: Node = { key: this.key(scx, scz, this.level(s.y)), cx: scx, cz: scz, y: s.y, g: 0, f: h(scx, scz), parent: null, closed: false, heapIndex: -1 };
    nodes.set(start.key, start);
    this.push(heap, start);
    let best = start;
    let bestH = start.f;
    let expanded = 0;

    while (heap.length > 0) {
      const cur = this.pop(heap);
      cur.closed = true;
      if (cur.cx === gcx && cur.cz === gcz && Math.abs(cur.y - g.y) < 1.2) return this.unwind(cur);
      const ch = cur.f - cur.g;
      if (ch < bestH) {
        bestH = ch;
        best = cur;
      }
      if (++expanded > maxNodes || this.samples >= this.sampleLimit) {
        this.lastPartial = true;
        break;
      }

      for (const [dx, dz, cost] of DIRS) {
        const nx = cur.cx + dx, nz = cur.cz + dz;
        if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) continue;
        const c = this.sample(nx, nz, cur.y);
        if (!this.passable(c, cur.y)) continue;
        if (dx !== 0 && dz !== 0) {
          if (!this.passable(this.sample(cur.cx + dx, cur.cz, cur.y), cur.y)) continue;
          if (!this.passable(this.sample(cur.cx, cur.cz + dz, cur.y), cur.y)) continue;
        }
        const key = this.key(nx, nz, this.level(c.y));
        // Slight penalty for climbing keeps paths on flat ground when it's equally short
        const ng = cur.g + cost + Math.abs(c.y - cur.y) * 0.5;
        let n = nodes.get(key);
        if (!n) {
          n = { key, cx: nx, cz: nz, y: c.y, g: ng, f: ng + h(nx, nz), parent: cur, closed: false, heapIndex: -1 };
          nodes.set(key, n);
          this.push(heap, n);
        } else if (!n.closed && ng < n.g) {
          n.g = ng;
          n.f = ng + h(nx, nz);
          n.parent = cur;
          this.up(heap, n.heapIndex);
        }
      }
    }
    // Budget spent or goal unreachable: go as close as we got
    return best === start ? [] : this.unwind(best);
  }

  private unwind(n: Node): Node[] {
    const out: Node[] = [];
    for (let c: Node | null = n; c && c.parent; c = c.parent) out.push(c);
    return out.reverse();
  }

  private push(heap: Node[], n: Node): void {
    n.heapIndex = heap.length;
    heap.push(n);
    this.up(heap, n.heapIndex);
  }

  private pop(heap: Node[]): Node {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      last.heapIndex = 0;
      this.down(heap, 0);
    }
    return top;
  }

  private up(heap: Node[], i: number): void {
    const n = heap[i];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].f <= n.f) break;
      heap[i] = heap[p];
      heap[i].heapIndex = i;
      i = p;
    }
    heap[i] = n;
    n.heapIndex = i;
  }

  private down(heap: Node[], i: number): void {
    const n = heap[i];
    const len = heap.length;
    for (;;) {
      const l = i * 2 + 1;
      if (l >= len) break;
      const r = l + 1;
      const c = r < len && heap[r].f < heap[l].f ? r : l;
      if (heap[c].f >= n.f) break;
      heap[i] = heap[c];
      heap[i].heapIndex = i;
      i = c;
    }
    heap[i] = n;
    n.heapIndex = i;
  }

  // ------------------------------------------------------------------ sampling

  private passable(c: Cell, fromY: number): boolean {
    if (!c.walkable) return false;
    const dy = c.y - fromY;
    return dy <= this.cfg.maxStepUp && dy >= -this.cfg.maxDrop;
  }

  private static readonly UNKNOWN: Cell = { walkable: false, y: 0 };

  private sample(cx: number, cz: number, refY: number, cachedOnly = false): Cell {
    const key = this.key(cx, cz, this.level(refY));
    let c = this.cells.get(key);
    if (c) return c;
    if (cachedOnly) return GridNavigator.UNKNOWN;
    c = this.query(this.toWorld(cx), this.toWorld(cz), refY);
    this.cells.set(key, c);
    return c;
  }

  private query(x: number, z: number, refY: number): Cell {
    const world = this.physics.world;
    if (!world) return { walkable: false, y: refY };
    this.samples++;
    // Inside a doorway: test on its centre line, ignoring the door's own frame and leaf
    let exclude: RAPIER.RigidBody | undefined;
    for (const d of this.doors) {
      if (Math.abs(refY - d.y) > 1.5) continue;
      const rx = x - d.x, rz = z - d.z;
      const across = rx * d.nx + rz * d.nz;
      const along = rx * d.nz - rz * d.nx;
      if (Math.abs(across) > 0.6 || Math.abs(along) > d.half) continue;
      const lim = Math.max(0, d.half - this.cfg.radius - 0.02);
      const a = Math.max(-lim, Math.min(lim, along));
      x = d.x + d.nz * a + d.nx * across;
      z = d.z - d.nx * a + d.nz * across;
      exclude = d.body ?? undefined;
      break;
    }
    const top = refY + this.cfg.maxStepUp + 0.6;
    this.ray.origin.x = x;
    this.ray.origin.y = top;
    this.ray.origin.z = z;
    const hit = world.castRay(this.ray, this.cfg.maxStepUp + 0.6 + this.cfg.maxDrop + 3, true, this.flags, undefined, undefined, exclude);
    if (!hit) return { walkable: false, y: refY };
    const y = top - hit.timeOfImpact;
    // Started inside something (wall, trunk): not a floor
    if (hit.timeOfImpact < 0.01 || y < this.cfg.minFloorY()) return { walkable: false, y };
    const half = (this.cfg.height - this.cfg.maxStepUp) / 2;
    const blocker = world.intersectionWithShape(
      { x, y: y + this.cfg.maxStepUp + half, z },
      this.identity,
      this.box,
      this.flags,
      undefined,
      undefined,
      exclude
    );
    return { walkable: !blocker, y };
  }

  private checkRevision(): void {
    const r = this.getRevision();
    if (r !== this.revision || this.cells.size > 60000) {
      this.revision = r;
      this.cells.clear();
      this.doors = this.cfg.doors?.() ?? [];
    }
  }

  private toCell(v: number): number {
    return Math.floor(v / this.cfg.cell);
  }

  private toWorld(c: number): number {
    return (c + 0.5) * this.cfg.cell;
  }

  /** Floor level bucket so stacked floors (ground / upper storey) get separate cells. */
  private level(y: number): number {
    return Math.round(y) + 512;
  }

  private key(cx: number, cz: number, level: number): number {
    return (((cx + 32768) & 0xffff) * 65536 + ((cz + 32768) & 0xffff)) * 1024 + (level & 1023);
  }
}
