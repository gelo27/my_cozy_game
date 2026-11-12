import * as THREE from 'three';
import { FarmingManager } from '../farming/FarmingManager';
import { FIELD_SEED_COST } from '../farming/FieldManager';
import { CROP_DEFINITIONS, CROP_TYPES, CropType } from '../farming/types/FarmingTypes';
import type { PropTreeField } from '../gathering/PropTreeField';
import type { RockField } from '../gathering/RockField';
import type { AppleOrchard } from '../gathering/AppleOrchard';

export type TaskKind = 'water' | 'harvest' | 'plant' | 'chop' | 'mine';
export const TASK_KINDS: TaskKind[] = ['harvest', 'water', 'plant', 'chop', 'mine'];

/** What a worker agrees to do: everything, one kind of job, or nothing (a day off). */
export type WorkerRole = 'all' | TaskKind | 'off';
export const WORKER_ROLES: WorkerRole[] = ['all', 'water', 'harvest', 'plant', 'chop', 'mine', 'off'];

export type Items = { itemId: string; amount: number }[];

export interface FarmTask {
  key: string;
  kind: TaskKind;
  /** Field jobs. */
  fieldId?: string;
  /** Tree prop id / rock id / apple tree id. */
  targetId?: number;
  /** A harvest job at an apple tree (shake the apples down, pick them up) rather than a field. */
  apple?: boolean;
  /** Field centre, trunk or rock centre (ground). */
  pos: THREE.Vector3;
  /** Where to stand for it (ground; the field centre for field jobs). */
  stand: THREE.Vector3;
  /** Close enough to work on it (m, to `pos`). */
  reach: number;
}

/** The farm storage workers take seeds and meals from and bring the yield to. */
export interface FarmStore {
  count(itemId: string): number;
  take(itemId: string, n: number): boolean;
  /** A worker unloads at a chest. */
  put(items: Items): void;
  /** Is there a chest to unload at (without one the yield goes to the player's backpack)? */
  readonly hasChest: boolean;
}

/** Jobs farther than this from the worker are left alone (m). */
const MAX_TASK_DIST = 90;
/** Field scan interval (s): crops change slowly. */
const SCAN_INTERVAL = 1;
/** Trees and rocks are looked for less often (s). */
const NATURE_SCAN_INTERVAL = 5;
/** A job a worker could not reach stays off its list this long (s). */
const SKIP_TIME = 30;
/** Harvest first (ripe crops wait), then water, then sow; wood and stone only when the farm is tended. */
const PRIORITY: Record<TaskKind, number> = { harvest: 0, water: 8, plant: 16, chop: 30, mine: 30 };
/** Workers fell and mine until the store holds this much (the player takes some out: they go on). */
export const STOCK_TARGET = { wood: 60, stone: 40 };
/** Trees this close to the farm centre are the player's garden: never felled (m). */
const TREE_MIN_R = 30;
const TREE_MAX_R = 62;
const ROCK_MAX_R = 70;
/** Trees / rocks offered at once (nearest to the farm first). */
const MAX_TREES = 2;
const MAX_ROCKS = 3;
/** Apples that rolled up to this far from their tree are walked to and picked up (m). */
const APPLE_SEARCH_R = 12;

/**
 * Farm jobs generated from the world's state: a ripe crop is a harvest job, a dry one a watering
 * job, an empty bed a sowing job while the store has seeds, and while the store is short of wood or
 * stone the nearest forest trees and quarry rocks become felling / mining jobs. Each job is claimed
 * by one worker at a time; doing it re-checks that it is still needed (the player may have done it).
 */
export class TaskBoard {
  private tasks = new Map<string, FarmTask>();
  /** Job key -> id of the worker on it. */
  private claims = new Map<string, number>();
  /** "workerId|key" -> time until the worker tries that job again. */
  private skips = new Map<string, number>();
  private scanTimer = 0;
  private natureTimer = 0;
  private time = 0;
  /** Current felling / mining jobs (rebuilt by the nature scan). */
  private natureTasks: FarmTask[] = [];

  public trees: PropTreeField | null = null;
  public rocks: RockField | null = null;
  public orchard: AppleOrchard | null = null;

  constructor(
    private readonly farming: FarmingManager,
    public readonly store: FarmStore,
    /** True while rain waters the fields by itself. */
    private readonly raining: () => boolean,
    /** Middle of the farm (trees near it are left standing). */
    private readonly farmCenter: () => THREE.Vector3
  ) {}

  public update(dt: number): void {
    this.time += dt;
    this.natureTimer -= dt;
    if (this.natureTimer <= 0) {
      this.natureTimer = NATURE_SCAN_INTERVAL;
      this.scanNature();
    }
    this.scanTimer -= dt;
    if (this.scanTimer > 0) return;
    this.scanTimer = SCAN_INTERVAL;
    this.scan();
  }

  /** Jobs open right now, by kind (for status lines). */
  public counts(): Record<TaskKind, number> {
    const c: Record<TaskKind, number> = { water: 0, harvest: 0, plant: 0, chop: 0, mine: 0 };
    for (const t of this.tasks.values()) c[t.kind]++;
    return c;
  }

  /** Best open job for a worker at `from` with `role`, claimed for it; null when none. */
  public claim(workerId: number, role: WorkerRole, from: THREE.Vector3): FarmTask | null {
    if (role === 'off') return null;
    let best: FarmTask | null = null;
    let bestScore = Infinity;
    for (const t of this.tasks.values()) {
      if (role !== 'all' && t.kind !== role) continue;
      if (this.claims.has(t.key)) continue;
      const skip = this.skips.get(`${workerId}|${t.key}`);
      if (skip !== undefined && skip > this.time) continue;
      const d = Math.hypot(t.pos.x - from.x, t.pos.z - from.z);
      if (d > MAX_TASK_DIST) continue;
      // Metres-equivalent: a nearby sowing can beat a far harvest
      const score = d + PRIORITY[t.kind];
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (best) this.claims.set(best.key, workerId);
    return best;
  }

  /** Gives a job back; `unreachable` keeps this worker from picking it again for a while. */
  public release(task: FarmTask, workerId: number, unreachable = false): void {
    if (this.claims.get(task.key) === workerId) this.claims.delete(task.key);
    if (unreachable) this.skips.set(`${workerId}|${task.key}`, this.time + SKIP_TIME);
  }

  /** Still worth doing (checked while walking there). */
  public isValid(task: FarmTask): boolean {
    if (task.apple) return !!this.orchard && this.orchard.knockState(task.targetId!) !== 'done';
    if (task.kind === 'chop') return !!this.trees?.nodeOf(task.targetId!);
    if (task.kind === 'mine') return !!this.rocks?.byId(task.targetId!) && !this.rocks!.byId(task.targetId!)!.isDepleted;
    return this.needed(task.kind, task.fieldId!);
  }

  /** Seeds for a sowing job, taken from the store (the crop with the most seed); null when out. */
  public takeSeeds(): { itemId: string; amount: number } | null {
    const crop = this.seedToSow();
    if (!crop) return null;
    const itemId = CROP_DEFINITIONS[crop].seedItemId;
    return this.store.take(itemId, FIELD_SEED_COST) ? { itemId, amount: FIELD_SEED_COST } : null;
  }

  /**
   * Does a field job on the spot. Returns false when it was no longer needed (or the seeds didn't
   * fit); the harvest is pushed into `got` (the worker carries it to a chest).
   */
  public complete(task: FarmTask, workerId: number, seeds: { itemId: string; amount: number } | null, got: Items): boolean {
    this.release(task, workerId);
    this.tasks.delete(task.key);
    const id = task.fieldId!;
    const f = this.farming.fields.get(id);
    if (!f) return false;
    switch (task.kind) {
      case 'water':
        if (!this.needed('water', id)) return false;
        return this.farming.water(id);
      case 'harvest': {
        if (!this.needed('harvest', id)) return false;
        const res = this.farming.harvest(id, (itemId, amount) => got.push({ itemId, amount }), false);
        // One entry per item (the field hands crates over one by one)
        const merged = new Map<string, number>();
        for (const g of got.splice(0)) merged.set(g.itemId, (merged.get(g.itemId) ?? 0) + g.amount);
        for (const [itemId, amount] of merged) got.push({ itemId, amount });
        return !!res;
      }
      case 'plant': {
        if (f.crop || !seeds) return false;
        const crop = CROP_TYPES.find((c) => CROP_DEFINITIONS[c].seedItemId === seeds.itemId);
        return !!crop && this.farming.plant(id, crop);
      }
      default:
        return false;
    }
  }

  /**
   * One axe / pickaxe blow at a tree or rock from `dir` (worker to target). Returns 'felled' on the
   * last blow (the yield comes to `sink`: at once for a rock, when the top is gone for a tree),
   * 'hit' otherwise, 'gone' when there is nothing left to hit.
   */
  public strike(task: FarmTask, dir: THREE.Vector3, sink: (items: Items) => void): 'hit' | 'felled' | 'gone' {
    if (task.apple) {
      // A knock on the trunk; 'felled' once no apples hang any more (they are on the ground)
      const o = this.orchard;
      if (!o) return 'gone';
      const st = o.knockState(task.targetId!);
      if (st === 'knock') o.knock(task.targetId!, dir);
      return o.knockState(task.targetId!) === 'done' ? 'felled' : 'hit';
    }
    if (task.kind === 'chop') {
      const node = this.trees?.nodeOf(task.targetId!);
      if (!node) return 'gone';
      return this.trees!.hit(node, dir, sink) ? 'felled' : 'hit';
    }
    const rock = this.rocks?.byId(task.targetId!);
    if (!rock || rock.isDepleted) return 'gone';
    return this.rocks!.hit(rock, dir, sink) ? 'felled' : 'hit';
  }

  /** Apples from the last knock are still falling (wait before the next one). */
  public applesFalling(task: FarmTask): boolean {
    return !!task.apple && this.orchard?.knockState(task.targetId!) === 'wait';
  }

  /**
   * Picks up the apples lying within `radius` of `at` (where the worker stands): they hop to `to`
   * and reach `sink` one by one. Returns how many started on their way.
   */
  public gatherApples(at: THREE.Vector3, radius: number, to: () => THREE.Vector3, sink: (items: Items) => void): number {
    return this.orchard?.gatherFallen(at, radius, to, (n) => sink([{ itemId: 'apple', amount: n }])) ?? 0;
  }

  /** The nearest apple still lying around an apple tree job (they roll a fair way); null when none. */
  public nearestApple(task: FarmTask, from: THREE.Vector3): THREE.Vector3 | null {
    return this.orchard?.nearestFallen(task.pos, APPLE_SEARCH_R, from) ?? null;
  }

  /** A felling / mining job is over (the worker carries the yield away). */
  public finish(task: FarmTask, workerId: number): void {
    this.release(task, workerId);
    this.tasks.delete(task.key);
    this.natureTasks = this.natureTasks.filter((t) => t.key !== task.key);
  }

  private needed(kind: TaskKind, fieldId: string): boolean {
    const f = this.farming.fields.get(fieldId);
    if (!f) return false;
    const c = f.crop;
    if (kind === 'harvest') return !!c && c.stage >= 3;
    if (kind === 'water') return !!c && c.stage < 3 && !c.isWatered && !(this.raining() && !this.farming.fields.isSheltered(f));
    if (kind === 'plant') return !c && this.store.hasChest && this.seedToSow() !== null;
    return false;
  }

  /** The crop the store has the most seed for (enough for one field), or null. */
  private seedToSow(): CropType | null {
    let best: CropType | null = null;
    let most = FIELD_SEED_COST - 1;
    for (const c of CROP_TYPES) {
      const n = this.store.count(CROP_DEFINITIONS[c].seedItemId);
      if (n > most) {
        most = n;
        best = c;
      }
    }
    return best;
  }

  private scan(): void {
    const live = new Set<string>();
    for (const f of this.farming.fields.getAll()) {
      for (const kind of ['harvest', 'water', 'plant'] as const) {
        if (!this.needed(kind, f.id)) continue;
        const key = `${kind}:${f.id}`;
        live.add(key);
        if (!this.tasks.has(key)) this.tasks.set(key, { key, kind, fieldId: f.id, pos: f.center.clone(), stand: f.center.clone(), reach: 1.3 });
      }
    }
    // Ripe apple trees: harvest jobs too
    this.orchard?.forEachRipe((id, pos, r) => {
      const key = `harvest:apple:${id}`;
      live.add(key);
      if (this.tasks.has(key)) return;
      const c = this.farmCenter();
      const away = new THREE.Vector3(c.x - pos.x, 0, c.z - pos.z);
      if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
      away.normalize();
      this.tasks.set(key, { key, kind: 'harvest', apple: true, targetId: id, pos: pos.clone(), stand: pos.clone().addScaledVector(away, r + 0.8), reach: r + 1.3 });
    });
    for (const t of this.natureTasks) {
      if (!this.isValid(t)) continue;
      live.add(t.key);
      if (!this.tasks.has(t.key)) this.tasks.set(t.key, t);
    }
    for (const key of this.tasks.keys()) if (!live.has(key)) this.tasks.delete(key);
    // A claimed job that disappeared stays claimed until its worker notices (isValid) and lets go
    for (const [k, until] of this.skips) if (until <= this.time) this.skips.delete(k);
  }

  /** Nearest trees / rocks to the farm while the store is short of wood / stone. */
  private scanNature(): void {
    const c = this.farmCenter();
    const claimed = this.natureTasks.filter((t) => this.claims.has(t.key) && this.isValid(t));
    const next: FarmTask[] = [...claimed];
    const have = new Set(claimed.map((t) => t.key));
    const add = (kind: 'chop' | 'mine', cands: { id: number; pos: THREE.Vector3; r: number; d: number }[], max: number) => {
      cands.sort((a, b) => a.d - b.d);
      let n = claimed.filter((t) => t.kind === kind).length;
      for (const k of cands) {
        if (n >= max) break;
        const key = `${kind}:${k.id}`;
        if (have.has(key)) continue;
        // Stand on the farm side of it, just off the trunk / rock
        const away = new THREE.Vector3(c.x - k.pos.x, 0, c.z - k.pos.z);
        if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
        away.normalize();
        const stand = k.pos.clone().addScaledVector(away, k.r + 0.75);
        next.push({ key, kind, targetId: k.id, pos: k.pos.clone(), stand, reach: k.r + 1.25 });
        have.add(key);
        n++;
      }
    };
    if (this.trees && this.store.count('wood') < STOCK_TARGET.wood) {
      const cands: { id: number; pos: THREE.Vector3; r: number; d: number }[] = [];
      this.trees.forEachStandingTree(c.x, c.z, TREE_MIN_R, TREE_MAX_R, (id, pos, r) => {
        // Not on the beach / in the water, not up a cliff
        if (Math.abs(pos.y - c.y) > 6) return;
        cands.push({ id, pos, r, d: Math.hypot(pos.x - c.x, pos.z - c.z) });
      });
      add('chop', cands, MAX_TREES);
    }
    if (this.rocks && this.store.count('stone') < STOCK_TARGET.stone) {
      const cands: { id: number; pos: THREE.Vector3; r: number; d: number }[] = [];
      this.rocks.forEachIntactNear(c.x, c.z, ROCK_MAX_R, (rock) => {
        if (Math.abs(rock.position.y - c.y) > 6) return;
        cands.push({ id: rock.id, pos: rock.position, r: rock.radius, d: Math.hypot(rock.position.x - c.x, rock.position.z - c.z) });
      });
      add('mine', cands, MAX_ROCKS);
    }
    this.natureTasks = next;
  }
}
