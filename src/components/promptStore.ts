import { useSyncExternalStore } from 'react';
import type { FarmInteractionPrompt } from '../farming/types/FarmingTypes';
import type { GatherPrompt } from '../character/abilities/GatheringAbility';
import type { GameplayPrompt } from '../gameplay/GameplayManager';

/**
 * The interaction prompts (fields, trees, rocks) live outside App's state: the engine pushes one
 * every time the player steps onto a field, off it or a growth percentage ticks, several times a
 * second while running across a farm. As App state each push re-rendered the whole HUD tree
 * (~8-15 ms in dev, a visible hitch); here only the prompt widgets subscribed to it re-render.
 */
let farm: FarmInteractionPrompt | null = null;
let gather: GatherPrompt | null = null;
/** Stations, the NPC, pets (pets follow the player, so it flips on every field edge). */
let play: GameplayPrompt | null = null;
const listeners = new Set<() => void>();

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = () => listeners.forEach((fn) => fn());

export const promptStore = {
  setFarm(p: FarmInteractionPrompt | null): void {
    if (p === farm) return;
    farm = p;
    emit();
  },
  setGather(p: GatherPrompt | null): void {
    if (p === gather) return;
    gather = p;
    emit();
  },
  setPlay(p: GameplayPrompt | null): void {
    if (p === play) return;
    play = p;
    emit();
  },
};

export const useFarmingPrompt = () => useSyncExternalStore(subscribe, () => farm);
export const useGatherPrompt = () => useSyncExternalStore(subscribe, () => gather);
export const useGameplayPrompt = () => useSyncExternalStore(subscribe, () => play);
