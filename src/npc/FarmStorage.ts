import * as THREE from 'three';

/** Prop type of the storage chest (a station in the PropSystem). */
export const STORAGE_CHEST = 'storage_chest';
/** Where the farm's first chest stands (by the millstone and the campfire). */
export const STORAGE_CHEST_SPOT = { x: 1.2, z: 11.5 };
/** One stack in the chest holds at most this many of an item. */
export const STORAGE_STACK = 999;

/**
 * The farm's shared store. Every storage chest opens onto the same stock (like a farm cellar), so a
 * worker drops the harvest in whichever chest is nearest and the player finds it in any of them.
 * Workers bring crates, wood and stone here and take seeds and meals from here.
 */
export class FarmStorage {
  private readonly items = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  /** Bumped on every change (UI polling). */
  public revision = 0;

  constructor(
    /** Chest positions (feet level), nearest-first searches go over these. */
    private readonly chests: () => THREE.Vector3[]
  ) {}

  public count(id: string): number {
    return this.items.get(id) ?? 0;
  }

  /** Adds up to the stack limit; returns how many went in. */
  public put(id: string, n: number): number {
    if (n <= 0) return 0;
    const have = this.count(id);
    const add = Math.min(n, STORAGE_STACK - have);
    if (add <= 0) return 0;
    this.items.set(id, have + add);
    this.changed();
    return add;
  }

  public take(id: string, n: number): boolean {
    const have = this.count(id);
    if (n <= 0 || have < n) return false;
    if (have === n) this.items.delete(id);
    else this.items.set(id, have - n);
    this.changed();
    return true;
  }

  /** Stocked items, most first. */
  public list(): { itemId: string; amount: number }[] {
    return [...this.items].map(([itemId, amount]) => ({ itemId, amount })).sort((a, b) => b.amount - a.amount || a.itemId.localeCompare(b.itemId));
  }

  /** First item in `ids` that is in stock (null when none). */
  public firstOf(ids: readonly string[]): string | null {
    for (const id of ids) if (this.count(id) > 0) return id;
    return null;
  }

  public get hasChest(): boolean {
    return this.chests().length > 0;
  }

  /** Nearest chest to `from` (feet level), or null when the farm has none. */
  public nearestChest(from: THREE.Vector3): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null;
    let bestD = Infinity;
    for (const c of this.chests()) {
      const d = (c.x - from.x) ** 2 + (c.z - from.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  public subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  public serialize(): Record<string, number> {
    return Object.fromEntries(this.items);
  }

  public deserialize(data: Record<string, number> | undefined): void {
    this.items.clear();
    if (data) for (const [id, n] of Object.entries(data)) if (typeof n === 'number' && n > 0) this.items.set(id, Math.min(STORAGE_STACK, Math.floor(n)));
    this.changed();
  }

  private changed(): void {
    this.revision++;
    for (const fn of this.listeners) fn();
  }
}
