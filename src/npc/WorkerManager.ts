import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { GridNavigator } from '../navigation/GridNavigator';
import { BuiltPiece, BuildingPieceType } from '../building/types/BuildingTypes';
import { worldSettings } from '../world/WorldSettings';
import { t } from '../i18n/i18n';
import { TKey } from '../i18n/en';
import { DoorControl } from './NPCAgent';
import { BedSpot, WorkerActivity, WorkerNPC } from './WorkerNPC';
import { TaskBoard, WORKER_ROLES, WorkerRole } from './TaskBoard';

export const MAX_WORKERS = 10;
/** Coins a new farmhand costs to hire (the first ones come with the farm). */
export const WORKER_HIRE_COST = 40;

/** A farmhand in a world save. */
export interface WorkerSaveData {
  /** Name / colour slot. */
  slot: number;
  role: WorkerRole;
  energy: number;
  jobsDone: number;
  /** Feet position. */
  pos: [number, number, number];
  home: [number, number, number];
  asleep: boolean;
  /** Bed it slept in ("pieceId:slot"); it gets the same one back while it stands. */
  bed: string | null;
}

/** One row of the workers panel. */
export interface WorkerView {
  id: number;
  name: string;
  tint: number;
  energy: number;
  role: WorkerRole;
  activity: WorkerActivity;
  /** What it is doing, ready to show ("watering a field"). */
  doing: string;
  jobsDone: number;
  hasBed: boolean;
}

/** Workers within this distance of the player update every frame; farther ones less often (m). */
const LOD_NEAR = 30;
const LOD_MID = 60;
/** Bed list refresh (s): beds are built and removed rarely. */
const BED_REFRESH = 4;

const TINTS = [0xffd9b0, 0xc8f0c0, 0xf0c8e0, 0xc0d8ff, 0xfff0a0, 0xe0c8ff, 0xb8f0f0, 0xffc8c0, 0xd8d8d8, 0xf8e0c8];

/** Width of the mattress (m) and the sleeping slots across it, per bed type. */
const BED_SLOTS: Partial<Record<BuildingPieceType, { width: number; slots: number[] }>> = {
  [BuildingPieceType.FURN_BED_SINGLE]: { width: 1.0, slots: [0] },
  [BuildingPieceType.FURN_BED_DOUBLE]: { width: 1.6, slots: [-0.4, 0.4] },
};
/**
 * Lying body: the model's origin is the middle of the 1.5 m body, so it goes this far from the bed
 * centre toward the footboard (+Z; the head ~0.55 m from it then rests on the pillow at -0.75), at
 * this height above the piece origin (m). Furniture origins sit at the middle of their box: beds
 * are 1 m tall, so the floor is 0.5 m below it and the blanket ~0.58 m above the floor.
 */
const LIE_CENTER_Z = -0.15;
const LIE_HEIGHT = 0.2;
const BED_HALF_HEIGHT = 0.5;

/**
 * The farmhands: spawning (up to MAX_WORKERS), bed assignment, and what keeps a crowd cheap on
 * phones — at most one path search per frame between them, staggered thinking, and far workers
 * stepping every 2nd / 4th frame with the summed time.
 */
export class WorkerManager {
  public readonly workers: WorkerNPC[] = [];

  private plannedThisFrame = false;
  private nextId = 0;
  private frame = 0;
  private bedTimer = 0;
  /** When a save was loaded: beds are looked for often for a while after it. */
  private loadedAt = -Infinity;
  /** Frames until the navigation cache is dropped after a load (physics queries only see new colliders after a step). */
  private navResetIn = 0;
  /** Time not yet simulated, per worker (LOD). */
  private pending: number[] = [];
  private spotCache = new Map<string, BedSpot>();
  private readonly gate = (): boolean => {
    if (this.plannedThisFrame) return false;
    this.plannedThisFrame = true;
    return true;
  };

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
    private readonly nav: GridNavigator,
    private readonly doors: DoorControl | null,
    private readonly getPieces: () => BuiltPiece[],
    private readonly groundHeight: (x: number, z: number) => number,
    /** Farm jobs; null keeps workers pottering around the work area. */
    public readonly board: TaskBoard | null,
    /** Default work area centre (the fields). */
    public workCenter: THREE.Vector3
  ) {}

  /** A new worker near `pos` (ground level); null at the cap. */
  public spawn(pos: THREE.Vector3, slot?: number): WorkerNPC | null {
    if (this.workers.length >= MAX_WORKERS) return null;
    // First free name / colour slot (names stay unique after someone leaves)
    const used = new Set(this.workers.map((x) => x.slot));
    let i = slot !== undefined && !used.has(slot) ? slot : 0;
    while (used.has(i)) i++;
    const p = pos.clone();
    p.y = this.groundHeight(p.x, p.z);
    const spot = this.nav.snap(p.x, p.z, p.y);
    if (spot) p.set(spot.x, spot.y, spot.z);
    const w = new WorkerNPC(this.physics, this.scene, this.nav, p, t(`worker.name${i}` as TKey), this.doors, TINTS[i % TINTS.length], i / MAX_WORKERS, this.nextId++);
    w.slot = i;
    w.workCenter = this.workCenter.clone();
    w.board = this.board;
    w.planGate = this.gate;
    this.workers.push(w);
    this.pending.push(0);
    this.bedTimer = 0;
    return w;
  }

  public remove(w: WorkerNPC): void {
    const i = this.workers.indexOf(w);
    if (i < 0) return;
    w.dispose();
    this.workers.splice(i, 1);
    this.pending.splice(i, 1);
    this.bedTimer = 0;
  }

  public update(dt: number, player: THREE.Vector3): void {
    this.plannedThisFrame = false;
    this.frame++;
    this.board?.update(dt);
    if (this.navResetIn > 0 && --this.navResetIn === 0) {
      this.nav.reset();
      this.spotCache.clear();
      this.bedTimer = 0;
    }
    this.bedTimer -= dt;
    if (this.bedTimer <= 0) {
      this.bedTimer = performance.now() - this.loadedAt < 10000 ? 0.5 : BED_REFRESH;
      this.assignBeds();
    }
    const hour = worldSettings.timeOfDay;
    const sph = worldSettings.secondsPerHour;
    for (let i = 0; i < this.workers.length; i++) {
      const w = this.workers[i];
      this.pending[i] += dt;
      const p = w.model.group.position;
      const d = Math.hypot(p.x - player.x, p.z - player.z);
      // Sleepers barely change: step them rarely wherever they are
      const stride = w.asleep ? (d < LOD_NEAR ? 2 : 6) : d < LOD_NEAR ? 1 : d < LOD_MID ? 2 : 4;
      if ((this.frame + i) % stride !== 0) continue;
      // Long gaps (tab in background) must not launch anyone through walls
      const step = Math.min(this.pending[i], 0.25);
      this.pending[i] = 0;
      w.update(step, player, hour, sph > 0 ? step / sph : 0);
    }
  }

  /** The player slept: everyone spends the hours in bed. */
  public fastForward(seconds: number): void {
    const sph = worldSettings.secondsPerHour;
    if (sph <= 0) return;
    this.assignBeds();
    for (const w of this.workers) w.fastForward(seconds / sph, worldSettings.timeOfDay);
  }

  public nearest(pos: THREE.Vector3, reach: number): WorkerNPC | null {
    let best: WorkerNPC | null = null;
    let bestD = reach;
    for (const w of this.workers) {
      const p = w.model.group.position;
      const d = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (d < bestD && Math.abs(p.y - pos.y) < 2.5) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  public serialize(): WorkerSaveData[] {
    const r = (v: number) => +v.toFixed(2);
    return this.workers.map((w) => {
      const f = w.getFeet();
      return {
        slot: w.slot,
        role: w.role,
        energy: r(w.energy),
        jobsDone: w.jobsDone,
        pos: [r(f.x), r(f.y), r(f.z)],
        home: [r(w.home.x), r(w.home.y), r(w.home.z)],
        asleep: w.asleep,
        bed: w.bed?.key ?? null,
      };
    });
  }

  /** Replaces the crew with the saved one (buildings must be loaded first, for the beds). */
  public deserialize(data: WorkerSaveData[]): void {
    for (const w of [...this.workers]) this.remove(w);
    const sleepers: WorkerNPC[] = [];
    for (const d of data.slice(0, MAX_WORKERS)) {
      const w = this.spawn(new THREE.Vector3(...d.pos), d.slot);
      if (!w) continue;
      if (d.asleep) sleepers.push(w);
      w.home.set(...d.home);
      w.energy = THREE.MathUtils.clamp(d.energy, 0, 100);
      w.jobsDone = d.jobsDone ?? 0;
      w.setRole(WORKER_ROLES.includes(d.role) ? d.role : 'all');
      w.preferredBed = d.bed;
    }
    // Sleepers lie down where they were saved and move into their bed as soon as it is found
    // (no walk there in the dark after loading)
    for (const w of sleepers) w.restoreAsleep();
    this.assignBeds();
    this.bedTimer = 0.5;
    this.loadedAt = performance.now();
    this.navResetIn = 3;
  }

  /** Rows for the workers panel. */
  public snapshot(): WorkerView[] {
    return this.workers.map((w) => ({
      id: w.id,
      name: w.name,
      tint: TINTS[w.slot % TINTS.length],
      energy: Math.round(w.energy),
      role: w.role,
      activity: w.activity,
      doing: w.task && w.activity === 'work' ? t(TASK_KEY[w.task.kind]) : t(ACTIVITY_KEY[w.activity]),
      jobsDone: w.jobsDone,
      hasBed: !!w.bed,
    }));
  }

  public byId(id: number): WorkerNPC | null {
    return this.workers.find((w) => w.id === id) ?? null;
  }

  /** "Petro · watering only · energy 72% · watering" */
  public status(w: WorkerNPC): string {
    const activity = w.task && w.activity === 'work' ? t(TASK_KEY[w.task.kind]) : t(ACTIVITY_KEY[w.activity]);
    return t('worker.status', { name: w.name, role: t(ROLE_KEY[w.role]), energy: Math.round(w.energy), activity });
  }

  /** Next role in the list (talking to a worker); returns it. */
  public cycleRole(w: WorkerNPC): WorkerRole {
    const role = WORKER_ROLES[(WORKER_ROLES.indexOf(w.role) + 1) % WORKER_ROLES.length];
    w.setRole(role);
    return role;
  }

  public roleLabel(role: WorkerRole): string {
    return t(ROLE_KEY[role]);
  }

  public setDebug(on: boolean): void {
    for (const w of this.workers) w.setDebug(on);
  }

  // ---------------------------------------------------------------- beds

  /** Keeps workers in the beds they have while those stand; gives free ones to the rest, nearest first. */
  private assignBeds(): void {
    const spots: BedSpot[] = [];
    const live = new Set<string>();
    for (const piece of this.getPieces()) {
      const cfg = BED_SLOTS[piece.type];
      if (!cfg || piece.isConfirmed === false) continue;
      for (let s = 0; s < cfg.slots.length; s++) {
        const key = `${piece.id}:${s}`;
        live.add(key);
        let spot = this.spotCache.get(key);
        if (!spot || spot.lie.distanceToSquared(this.lieOf(piece, cfg.slots[s])) > 0.01) {
          spot = this.makeSpot(piece, key, cfg.width, cfg.slots[s]) ?? undefined;
          if (spot) this.spotCache.set(key, spot);
        }
        if (spot) spots.push(spot);
      }
    }
    for (const k of this.spotCache.keys()) if (!live.has(k)) this.spotCache.delete(k);

    const taken = new Set<string>();
    for (const w of this.workers) {
      if (w.bed && live.has(w.bed.key)) taken.add(w.bed.key);
      else if (w.bed) w.setBed(null);
    }
    // A loaded worker gets the bed it had back
    for (const w of this.workers) {
      const want = w.preferredBed;
      if (!want) continue;
      if (w.bed) {
        w.preferredBed = null;
        continue;
      }
      // Kept until that bed turns up (a loading world builds its pieces over a few frames)
      const spot = spots.find((s) => s.key === want);
      if (spot && !taken.has(spot.key)) {
        w.preferredBed = null;
        taken.add(spot.key);
        w.setBed(spot);
      }
    }
    for (const w of this.workers) {
      if (w.bed || w.preferredBed) continue;
      let best: BedSpot | null = null;
      let bestD = Infinity;
      for (const s of spots) {
        if (taken.has(s.key)) continue;
        const d = s.lie.distanceToSquared(w.home);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best) {
        taken.add(best.key);
        w.setBed(best);
      }
    }
  }

  private lieOf(piece: BuiltPiece, slotX: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(slotX, LIE_HEIGHT, LIE_CENTER_Z).applyQuaternion(piece.quaternion).add(piece.position);
  }

  private makeSpot(piece: BuiltPiece, key: string, width: number, slotX: number): BedSpot | null {
    const head = new THREE.Vector3(0, 0, -1).applyQuaternion(piece.quaternion);
    const yaw = Math.atan2(-head.x, -head.z);
    // Step out on the side of the slot (either side for a single bed), by the middle of the bed
    const side = slotX < 0 ? -1 : 1;
    let stand = null;
    for (const sx of [side, -side]) {
      const p = new THREE.Vector3(sx * (width / 2 + 0.45), 0, 0.2).applyQuaternion(piece.quaternion).add(piece.position);
      p.y = piece.position.y - BED_HALF_HEIGHT;
      stand = this.nav.snap(p.x, p.z, p.y) ?? this.nav.nearestWalkable(p, 4);
      // Not on the bed's own floor (the top of a well or a table next to it): try the other side
      if (stand && Math.abs(stand.y - p.y) > 0.35) stand = null;
      if (stand) break;
    }
    if (!stand) return null;
    return { key, lie: this.lieOf(piece, slotX), yaw, stand };
  }
}

const ACTIVITY_KEY: Record<WorkerActivity, TKey> = {
  work: 'worker.act.work',
  rest: 'worker.act.rest',
  leisure: 'worker.act.leisure',
  toBed: 'worker.act.toBed',
  sleep: 'worker.act.sleep',
};

const ROLE_KEY: Record<WorkerRole, TKey> = {
  all: 'worker.role.all',
  water: 'worker.role.water',
  harvest: 'worker.role.harvest',
  plant: 'worker.role.plant',
  off: 'worker.role.off',
};

const TASK_KEY: Record<'water' | 'harvest' | 'plant', TKey> = {
  water: 'worker.task.water',
  harvest: 'worker.task.harvest',
  plant: 'worker.task.plant',
};
