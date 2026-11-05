import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { StructureBuilder, siteToWorld } from '../explore/StructureBuilder';
import type { IslandSite } from './IslandSites';
import type { TerrainSystem } from './TerrainSystem';
import { worldSettings } from './WorldSettings';

export interface PierInfo {
  /** Where the boat is moored (on the water surface) and its heading. */
  boatSpawn: THREE.Vector3;
  boatYaw: number;
  /** Deck top height. */
  deckY: number;
  /** Pier start/end in world space (for the map and wildlife spawn rules). */
  start: THREE.Vector3;
  end: THREE.Vector3;
}

const DECK_W = 2.4;
const DECK_T = 0.22;
const HEAD_W = 6.4; // T-head across the end
const HEAD_D = 4.2;

/**
 * Wooden jetty from the lighthouse headland straight out to sea (site-local +Z faces the sea).
 * It starts where the shore drops below deck height and runs until the water is deep enough
 * for the boat, ending in a T-head. Planks, posts and bollards merge into two meshes;
 * the deck and posts get static colliders so the player can walk it and the boat bumps into it.
 */
export function buildLighthousePier(site: IslandSite, terrain: TerrainSystem, scene: THREE.Scene, physics: PhysicsWorld): PierInfo {
  const sea = worldSettings.waterLevel;
  const deckY = sea + 0.95;
  const origin = new THREE.Vector3(site.x, 0, site.z);
  const tmp = new THREE.Vector3();
  const groundAt = (lz: number, lx = 0) => {
    siteToWorld(origin, site.yaw, lx, 0, lz, tmp);
    return terrain.getHeight(tmp.x, tmp.z);
  };

  // Start: first spot past the lighthouse plinth where the ground is at or below the deck
  let z0 = 4;
  while (z0 < 60 && groundAt(z0) > deckY - 0.05) z0 += 0.5;
  // End: water at least 2.2 m deep, plus room for the boat alongside
  let z1 = z0 + 8;
  while (z1 < z0 + 46 && groundAt(z1) > sea - 2.2) z1 += 1;
  z1 = Math.min(z0 + 52, z1 + 7);

  const b = new StructureBuilder();
  b.surface = 'wood';
  const len = z1 - z0;
  // Planks across the deck, alternating tone, with thin gaps between them
  const plank = 0.42;
  let i = 0;
  for (let z = z0; z < z1 - 0.01; z += plank + 0.04, i++) {
    const w = DECK_W + (i % 3 === 0 ? 0.08 : 0) - (i % 5 === 2 ? 0.1 : 0);
    b.box(i % 2 ? 'wood' : 'darkWood', w, DECK_T, Math.min(plank, z1 - z), 0, deckY - DECK_T / 2, z + plank / 2);
  }
  // Stringers under the planks
  for (const x of [-DECK_W / 2 + 0.15, DECK_W / 2 - 0.15]) b.box('darkWood', 0.16, 0.2, len, x, deckY - DECK_T - 0.1, z0 + len / 2);
  b.colliderBox(DECK_W, 0.4, len, 0, deckY - 0.2, z0 + len / 2);

  // T-head
  const hz = z1 + HEAD_D / 2;
  for (let x = -HEAD_W / 2; x < HEAD_W / 2 - 0.01; x += plank + 0.04, i++) {
    b.box(i % 2 ? 'wood' : 'darkWood', Math.min(plank, HEAD_W / 2 - x), DECK_T, HEAD_D, x + plank / 2, deckY - DECK_T / 2, hz);
  }
  b.colliderBox(HEAD_W, 0.4, HEAD_D, 0, deckY - 0.2, hz);

  // Posts down to the sea bed every 3 m on both sides (+ the T-head corners)
  const post = (x: number, z: number) => {
    const bottom = Math.min(groundAt(z, x), deckY - 0.5) - 0.3;
    const h = deckY + 0.35 - bottom;
    b.cylinder('darkWood', 0.13, 0.15, h, x, bottom + h / 2, z, 6);
    if (bottom < sea + 0.4) b.colliderCylinder(0.16, h, x, bottom + h / 2, z);
  };
  for (let z = z0 + 0.5; z < z1; z += 3) {
    post(-DECK_W / 2 - 0.05, z);
    post(DECK_W / 2 + 0.05, z);
  }
  for (const x of [-HEAD_W / 2, HEAD_W / 2]) for (const z of [z1 + 0.2, z1 + HEAD_D - 0.2]) post(x, z);
  // Bollards for mooring, a lantern post on the head
  for (const z of [z1 - 9, z1 - 3]) b.cylinder('metal', 0.1, 0.13, 0.32, DECK_W / 2 - 0.25, deckY + 0.16, z, 6);
  b.cylinder('darkWood', 0.07, 0.08, 2.2, -HEAD_W / 2 + 0.4, deckY + 1.1, z1 + HEAD_D - 0.4, 6);
  b.box('glass', 0.26, 0.34, 0.26, -HEAD_W / 2 + 0.4, deckY + 2.3, z1 + HEAD_D - 0.4);
  b.box('metal', 0.34, 0.06, 0.34, -HEAD_W / 2 + 0.4, deckY + 2.5, z1 + HEAD_D - 0.4);
  // A coil of rope and a crate for flavour
  b.cylinder('roof', 0.32, 0.32, 0.12, -0.6, deckY + 0.06, z1 + 1.3, 10);
  b.box('wood', 0.6, 0.55, 0.6, 2.2, deckY + 0.28, z1 + 2.4, 0.3);
  b.colliderBox(0.6, 0.55, 0.6, 2.2, deckY + 0.28, z1 + 2.4, 0.3);

  b.build(scene, physics, origin, site.yaw, 'LighthousePier');

  // The boat lies alongside the pier's right side, bow to the sea
  const boatSpawn = siteToWorld(origin, site.yaw, DECK_W / 2 + 1.35, sea, z1 - 6);
  return {
    boatSpawn,
    boatYaw: site.yaw,
    deckY,
    start: siteToWorld(origin, site.yaw, 0, deckY, z0),
    end: siteToWorld(origin, site.yaw, 0, deckY, z1 + HEAD_D),
  };
}
