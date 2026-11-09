import { InventoryItem, InventoryState, DEFAULT_INVENTORY_ITEMS } from './types/InventoryTypes';
import { audioEngine } from '../audio/AudioEngine';

/** Hotbar slots under the backpack grid (keys 1-8). */
export const HOTBAR_SIZE = 8;
/** Backpack grid: 8 columns; slots past the current capacity are shown locked (room for upgrades). */
export const BACKPACK_COLUMNS = 8;
export const BACKPACK_MAX_SLOTS = 32;
export const BACKPACK_START_CAPACITY = 16;
const DEFAULT_HOTBAR = ['watering_can', 'axe', 'pickaxe', 'shovel', 'fishing_rod', 'slingshot'];

export class InventoryManager {
  private items: Map<string, InventoryItem> = new Map();
  private equippedItemId: string | null = 'watering_can'; // Default start with Watering Can equipped!
  private isOpen: boolean = false;
  /** Item ids placed on the hotbar; an item on the hotbar is not shown in the backpack grid. */
  private hotbar: (string | null)[] = new Array(HOTBAR_SIZE).fill(null);
  private capacity = BACKPACK_START_CAPACITY;
  private listeners: Set<(state: InventoryState) => void> = new Set();

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.items.clear();
    for (const item of DEFAULT_INVENTORY_ITEMS) {
      this.items.set(item.id, { ...item });
    }
    this.equippedItemId = 'watering_can';
    this.hotbar = new Array(HOTBAR_SIZE).fill(null);
    DEFAULT_HOTBAR.filter((id) => (this.items.get(id)?.count ?? 0) > 0)
      .slice(0, HOTBAR_SIZE)
      .forEach((id, i) => (this.hotbar[i] = id));
    this.capacity = BACKPACK_START_CAPACITY;
    this.notify();
  }

  // ---- Hotbar ----

  public getHotbar(): (string | null)[] {
    return [...this.hotbar];
  }

  /** Restores hotbar slots from a save (unknown ids are dropped). */
  public setHotbar(slots: (string | null)[]): void {
    this.hotbar = new Array(HOTBAR_SIZE).fill(null);
    const seen = new Set<string>();
    slots.slice(0, HOTBAR_SIZE).forEach((id, i) => {
      if (id && this.items.has(id) && !seen.has(id)) {
        this.hotbar[i] = id;
        seen.add(id);
      }
    });
    this.pruneHotbar();
    this.keepEquippedOnHotbar();
    this.notify();
  }

  public isOnHotbar(id: string): boolean {
    return this.hotbar.includes(id);
  }

  /**
   * Puts an item into a hotbar slot. Dragging from another hotbar slot swaps the two;
   * an item coming from the backpack pushes the slot's old item back into the backpack.
   */
  public setHotbarSlot(index: number, id: string): void {
    if (index < 0 || index >= HOTBAR_SIZE || (this.items.get(id)?.count ?? 0) <= 0) return;
    const from = this.hotbar.indexOf(id);
    if (from === index) return;
    if (from >= 0) this.hotbar[from] = this.hotbar[index];
    this.hotbar[index] = id;
    audioEngine.playBuildSelect();
    this.keepEquippedOnHotbar();
    this.notify();
  }

  /** Right click in the backpack: the first free hotbar slot. Returns false when the hotbar is full. */
  public addToHotbar(id: string): boolean {
    if (this.isOnHotbar(id) || (this.items.get(id)?.count ?? 0) <= 0) return false;
    const free = this.hotbar.indexOf(null);
    if (free < 0) return false;
    this.hotbar[free] = id;
    audioEngine.playBuildSelect();
    this.notify();
    return true;
  }

  /** Sends a hotbar item back into the backpack. */
  public removeFromHotbar(id: string): void {
    const i = this.hotbar.indexOf(id);
    if (i < 0) return;
    this.hotbar[i] = null;
    audioEngine.playBuildSelect();
    this.keepEquippedOnHotbar();
    this.notify();
  }

  /**
   * Only hotbar items can be held: when the held item leaves the hotbar,
   * the first equippable hotbar item goes into the hand instead (or nothing).
   */
  private keepEquippedOnHotbar(): void {
    if (!this.equippedItemId || this.hotbar.includes(this.equippedItemId)) return;
    this.equippedItemId =
      this.hotbar.find((id) => {
        const item = id ? this.items.get(id) : undefined;
        return !!item && item.isEquippable && item.count > 0;
      }) ?? null;
  }

  // ---- Backpack capacity ----

  public getCapacity(): number {
    return this.capacity;
  }

  public setCapacity(n: number): void {
    this.capacity = Math.max(BACKPACK_START_CAPACITY, Math.min(BACKPACK_MAX_SLOTS, Math.floor(n)));
    this.notify();
  }

  /** Items shown in the backpack grid (owned, not coins, not on the hotbar). */
  public getBackpackItems(): InventoryItem[] {
    return this.getItems().filter((it) => it.count > 0 && it.id !== 'coins' && !this.hotbar.includes(it.id));
  }

  /** Used-up items leave the hotbar so the slot frees up. */
  private pruneHotbar(): void {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const id = this.hotbar[i];
      if (id && (this.items.get(id)?.count ?? 0) <= 0) this.hotbar[i] = null;
    }
  }

  public getItems(): InventoryItem[] {
    return Array.from(this.items.values());
  }

  public getItem(id: string): InventoryItem | null {
    return this.items.get(id) || null;
  }

  public getItemCount(id: string): number {
    return this.items.get(id)?.count ?? 0;
  }

  public hasItem(id: string, count: number = 1): boolean {
    return (this.items.get(id)?.count ?? 0) >= count;
  }

  public addItem(id: string, amount: number = 1): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.count = Math.min(item.maxStack, item.count + amount);
    this.notify();
    return true;
  }

  public removeItem(id: string, amount: number = 1): boolean {
    const item = this.items.get(id);
    if (!item || item.count < amount) return false;
    item.count -= amount;
    if (item.count <= 0 && this.equippedItemId === id) {
      this.equippedItemId = null;
    }
    this.pruneHotbar();
    this.notify();
    return true;
  }

  public equipItem(id: string | null): void {
    if (id === this.equippedItemId) {
      // Toggle off / unequip
      this.equippedItemId = null;
      audioEngine.playBuildSelect();
    } else if (id === null) {
      this.equippedItemId = null;
      audioEngine.playBuildSelect();
    } else {
      const item = this.items.get(id);
      if (item && item.isEquippable && item.count > 0) {
        this.equippedItemId = id;
        audioEngine.playBuildSelect();
      }
    }
    this.notify();
  }

  public unequip(): void {
    this.equipItem(null);
  }

  public getEquippedItemId(): string | null {
    return this.equippedItemId;
  }

  public getEquippedItem(): InventoryItem | null {
    if (!this.equippedItemId) return null;
    return this.items.get(this.equippedItemId) || null;
  }

  public toggleOpen(): boolean {
    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      audioEngine.playBuildSelect();
    } else {
      audioEngine.playBuildSelect();
    }
    this.notify();
    return this.isOpen;
  }

  public setOpen(open: boolean): void {
    if (this.isOpen !== open) {
      this.isOpen = open;
      this.notify();
    }
  }

  public isInventoryOpen(): boolean {
    return this.isOpen;
  }

  public getState(): InventoryState {
    return {
      items: this.getItems(),
      equippedItemId: this.equippedItemId,
      isOpen: this.isOpen,
      hotbar: [...this.hotbar],
      capacity: this.capacity,
    };
  }

  public subscribe(listener: (state: InventoryState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
