import { InventoryItem, InventoryState, DEFAULT_INVENTORY_ITEMS } from './types/InventoryTypes';
import { audioEngine } from '../audio/AudioEngine';

export class InventoryManager {
  private items: Map<string, InventoryItem> = new Map();
  private equippedItemId: string | null = 'watering_can'; // Default start with Watering Can equipped!
  private isOpen: boolean = false;
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
    this.notify();
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
