import * as THREE from 'three';

/** Inventory item ids of the gathering tools. */
export type GatherTool = 'axe' | 'pickaxe';

export type RockKind = 'stone' | 'iron' | 'copper' | 'gold' | 'crystal';

export interface ResourceDrop {
  itemId: string;
  min: number;
  max: number;
}

export const GATHERING_CONFIG = {
  // Extra distance (m) beyond a node's radius at which the player can hit it
  REACH: 1.4,
  // Seconds between swings
  SWING_COOLDOWN: 0.8,
  // Delay from swing start to the moment the tool connects (matches CHOP / MINE clips)
  IMPACT_DELAY: 0.3,
  // Clip lengths for the swing one-shots
  AXE_SWING_DURATION: 0.6,
  PICKAXE_SWING_DURATION: 0.7,

  TREE_HITS: 5,
  TREE_WOOD_YIELD: 6,
  TREE_REGROW_SECONDS: 120,
  ROCK_REGROW_SECONDS: 90,
} as const;

export const ROCK_TYPES: Record<RockKind, { name: string; hits: number; drops: ResourceDrop[] }> = {
  stone: {
    name: 'Камінь',
    hits: 4,
    drops: [{ itemId: 'stone', min: 3, max: 5 }],
  },
  iron: {
    name: 'Залізна руда',
    hits: 6,
    drops: [
      { itemId: 'iron_ore', min: 2, max: 3 },
      { itemId: 'stone', min: 1, max: 2 },
    ],
  },
  copper: {
    name: 'Мідна руда',
    hits: 6,
    drops: [
      { itemId: 'copper_ore', min: 2, max: 4 },
      { itemId: 'stone', min: 1, max: 2 },
    ],
  },
  gold: {
    name: 'Золота руда',
    hits: 8,
    drops: [
      { itemId: 'gold_ore', min: 1, max: 3 },
      { itemId: 'stone', min: 1, max: 2 },
    ],
  },
  crystal: {
    name: 'Кристал',
    hits: 5,
    drops: [{ itemId: 'crystal', min: 1, max: 2 }],
  },
};

/** The old cone-tree grove is gone (the pack's pines and oaks are the choppable trees now). */
export const TREE_SPOTS: { position: THREE.Vector3; scale: number }[] = [];

/** Quarry east of the spawn. */
export const ROCK_SPOTS: { position: THREE.Vector3; kind: RockKind; scale: number }[] = [
  { position: new THREE.Vector3(13, 0, -5), kind: 'stone', scale: 1.0 },
  { position: new THREE.Vector3(17, 0, -1), kind: 'stone', scale: 0.85 },
  { position: new THREE.Vector3(16, 0, -10), kind: 'stone', scale: 1.15 },
  { position: new THREE.Vector3(21, 0, -6), kind: 'iron', scale: 1.0 },
  { position: new THREE.Vector3(22, 0, -13), kind: 'stone', scale: 0.95 },
  { position: new THREE.Vector3(26, 0, -9), kind: 'iron', scale: 1.1 },
];

export const rollDrop = (drop: ResourceDrop): number =>
  drop.min + Math.floor(Math.random() * (drop.max - drop.min + 1));
