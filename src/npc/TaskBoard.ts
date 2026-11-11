import * as THREE from 'three';
import { FarmingManager } from '../farming/FarmingManager';
import { FIELD_SEED_COST } from '../farming/FieldManager';
import { CROP_DEFINITIONS, CROP_TYPES, CropType } from '../farming/types/FarmingTypes';

export type TaskKind = 'water' | 'harvest' | 'plant';
export const TASK_KINDS: TaskKind[] = ['harvest', 'water', 'plant'];

/** What a worker agrees to do: everything, one kind of job, or nothing (a day off). */
export type WorkerRole = 'all' | TaskKind | 'off';
export const WORKER_ROLES: WorkerRole[] = ['all', 'water', 'harvest', 'plant', 'off'];

export interface FarmTask {
  key: string;
  kind: TaskKind;
  fieldId: string;
  /** Field centre (ground). */
  pos: THREE.Vector3;
}

/** The farm storage workers take seeds from and bring crates to (the player's inventory for now). */
export interface FarmStore {
  count(itemId: string): number;
  take(itemId: string, n: number): boolean;
  /** Items a worker brought in (shown like any gathered resources). */
  give(items: { itemId: string; amount: number }[]): void;
}

/** Jobs farther than this from the worker are left alone (m). */
const MAX_TASK_DIST = 90;
/** Field scan interval (s): crops change slowly. */
const SCAN_INTERVAL = 1;
/** A job a worker could not reach stays off its list this long (s). */
const SKIP_TIME = 30;
/** Harvest first (ripe crops wait), then water (growth is slow while dry), then sow. */
const PRIORITY: Record<TaskKind, number> = { harvest: 0, water: 8, plant: 16 };

/**
 * Farm jobs generated from the fields' state: a ripe crop is a harvest job, a dry one a watering
 * job, an empty bed a sowing job while the store has seeds. Each job is claimed by one worker at a
 * time; doing it re-checks that it is still needed (the player may have done it meanwhile).
 */
export class TaskBoard {
  private tasks = new Map<string, FarmTask>();
  /** Job key -> id of the worker on it. */
  private claims = new Map<string, number>();
  /** "workerId|key" -> time until the worker tries that job again. */
  private skips = new Map<string, number>();
  private scanTimer = 0;
  private time = 0;

  constructor(
    private readonly farming: FarmingManager,
    private readonly store: FarmStore,
    /** True while rain waters the fields by itself. */
    private readonly raining: () => boolean
  ) {}

  public update(dt: number): void {
    this.time += dt;
    this.scanTimer -= dt;
    if (this.scanTimer > 0) return;
    this.scanTimer = SCAN_INTERVAL;
    this.scan();
  }

  /** Jobs open right now, by kind (for status lines). */
  public counts(): Record<TaskKind, number> {
    const c: Record<TaskKind, number> = { water: 0, harvest: 0, plant: 0 };
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
    return this.needed(task.kind, task.fieldId);
  }

  /** Does the job; false when it was no longer needed or the seeds ran out. */
  public complete(task: FarmTask, workerId: number): boolean {
    this.release(task, workerId);
    this.tasks.delete(task.key);
    if (!this.needed(task.kind, task.fieldId)) return false;
    const id = task.fieldId;
    switch (task.kind) {
      case 'water':
        return this.farming.water(id);
      case 'harvest': {
        const got: { itemId: string; amount: number }[] = [];
        const res = this.farming.harvest(id, (itemId, amount) => got.push({ itemId, amount }), false);
        // One entry per item (the field hands crates over one by one)
        const merged = new Map<string, number>();
        for (const g of got) merged.set(g.itemId, (merged.get(g.itemId) ?? 0) + g.amount);
        if (res && merged.size) this.store.give([...merged].map(([itemId, amount]) => ({ itemId, amount })));
        return !!res;
      }
      case 'plant': {
        const crop = this.seedToSow();
        if (!crop || !this.store.take(CROP_DEFINITIONS[crop].seedItemId, FIELD_SEED_COST)) return false;
        return this.farming.plant(id, crop);
      }
    }
  }

  private needed(kind: TaskKind, fieldId: string): boolean {
    const f = this.farming.fields.get(fieldId);
    if (!f) return false;
    const c = f.crop;
    if (kind === 'harvest') return !!c && c.stage >= 3;
    if (kind === 'water') return !!c && c.stage < 3 && !c.isWatered && !(this.raining() && !this.farming.fields.isSheltered(f));
    return !c && this.seedToSow() !== null;
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
      for (const kind of TASK_KINDS) {
        if (!this.needed(kind, f.id)) continue;
        const key = `${kind}:${f.id}`;
        live.add(key);
        if (!this.tasks.has(key)) this.tasks.set(key, { key, kind, fieldId: f.id, pos: f.center.clone() });
      }
    }
    for (const key of this.tasks.keys()) if (!live.has(key)) this.tasks.delete(key);
    // A claimed job that disappeared stays claimed until its worker notices (isValid) and lets go
    for (const [k, until] of this.skips) if (until <= this.time) this.skips.delete(k);
  }
}
