import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { IslandSite } from '../world/IslandSites';
import { StructureBuilder, STRUCTURE_MATERIALS, siteToWorld } from './StructureBuilder';
import type { ExtraLight } from '../world/NightLighting';

/** What a built landmark exposes to gameplay. */
export interface LandmarkAnchors {
  /** Where its treasure chest stands, facing `chestYaw`. */
  chest?: { pos: THREE.Vector3; yaw: number };
  /** Spot the player stands at for the landmark's own action (enter the cave, climb the lighthouse). */
  action?: THREE.Vector3;
  /** Warm lights for the night lighting (torches, lantern room). */
  lights: ExtraLight[];
  /** Animated per frame (lighthouse beam). */
  update?: (dt: number, night: number) => void;
}

const SEED = (s: string) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0);

export function buildLandmark(site: IslandSite, scene: THREE.Scene, physics: PhysicsWorld): LandmarkAnchors {
  const origin = new THREE.Vector3(site.x, site.y, site.z);
  switch (site.kind) {
    case 'lighthouse':
      return buildLighthouse(site, origin, scene, physics);
    case 'ruins':
      return buildRuins(site, origin, scene, physics);
    case 'hut':
      return buildHut(site, origin, scene, physics);
    case 'cave':
      return buildCaveMouth(site, origin, scene, physics);
  }
}

// ---------------------------------------------------------------- lighthouse

function buildLighthouse(site: IslandSite, origin: THREE.Vector3, scene: THREE.Scene, physics: PhysicsWorld): LandmarkAnchors {
  const b = new StructureBuilder();
  // Stone plinth, then a tapering tower in red and white bands
  b.cylinder('darkStone', 2.9, 3.2, 1.2, 0, 0.3, 0, 12);
  const bands = 6;
  const H = 13;
  for (let i = 0; i < bands; i++) {
    const y0 = 0.9 + (i * H) / bands;
    const r0 = 2.3 - (i / bands) * 0.75;
    const r1 = 2.3 - ((i + 1) / bands) * 0.75;
    b.cylinder(i % 2 ? 'red' : 'white', r1, r0, H / bands, 0, y0 + H / bands / 2, 0, 14);
  }
  const top = 0.9 + H;
  b.cylinder('metal', 2.2, 2.0, 0.3, 0, top + 0.15, 0, 14); // gallery
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    b.box('metal', 0.06, 0.8, 0.06, Math.cos(a) * 2.05, top + 0.7, Math.sin(a) * 2.05);
  }
  b.cylinder('metal', 2.1, 2.1, 0.06, 0, top + 1.1, 0, 14, 0); // railing
  b.cylinder('glass', 1.05, 1.05, 1.6, 0, top + 1.1, 0, 10); // lantern room
  b.cylinder('red', 0.05, 1.35, 1.2, 0, top + 2.5, 0, 10); // cap
  b.box('darkWood', 1.0, 1.9, 0.12, 0, 1.85, 2.15, 0, -0.06); // door
  b.colliderCylinder(2.4, H + 2, 0, (H + 2) / 2, 0);
  // Keeper's shed beside the tower
  b.box('white', 3.0, 2.2, 2.4, 3.6, 1.1, -0.6).box('roof', 3.4, 0.2, 2.9, 3.6, 2.35, -0.6, 0, 0, 0.12);
  b.box('darkWood', 0.9, 1.6, 0.08, 3.6, 0.8, 0.62);
  b.colliderBox(3.0, 2.4, 2.4, 3.6, 1.2, -0.6);
  // A few crates and a rowing boat on the shore side
  b.box('wood', 0.7, 0.7, 0.7, -2.9, 0.35, 1.6).box('wood', 0.6, 0.6, 0.6, -3.3, 0.3, 0.7, 0.4);
  b.colliderBox(1.2, 0.7, 1.8, -3.1, 0.35, 1.2);
  b.build(scene, physics, origin, site.yaw, 'Lighthouse');

  // Rotating beam: two long additive cones, visible at night only
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const beamGeo = new THREE.ConeGeometry(2.6, 46, 16, 1, true);
  beamGeo.translate(0, -23, 0);
  beamGeo.rotateZ(Math.PI / 2);
  const beam = new THREE.Group();
  beam.position.set(site.x, site.y + top + 1.1, site.z);
  for (const s of [1, -1]) {
    const cone = new THREE.Mesh(beamGeo, beamMat);
    cone.rotation.y = s > 0 ? 0 : Math.PI;
    beam.add(cone);
  }
  scene.add(beam);

  return {
    chest: { pos: siteToWorld(origin, site.yaw, 1.9, 0, 1.4), yaw: site.yaw },
    action: siteToWorld(origin, site.yaw, 0, 0, 2.9),
    lights: [{ ...siteToWorld(origin, site.yaw, 0, top + 1.1, 0), range: 14, halo: 5, intensity: 1.4 }],
    update: (dt, night) => {
      beam.rotation.y += dt * 0.6;
      beamMat.opacity = 0.16 * night;
      beam.visible = night > 0.05;
    },
  };
}

// ---------------------------------------------------------------- ruins

function buildRuins(site: IslandSite, origin: THREE.Vector3, scene: THREE.Scene, physics: PhysicsWorld): LandmarkAnchors {
  const b = new StructureBuilder();
  const seed = SEED(site.id);
  // Cracked stone floor
  b.cylinder('stone', 6.4, 6.8, 0.6, 0, 0.05, 0, 9);
  b.cylinder('darkStone', 2.2, 2.4, 0.5, 0, 0.55, 0, 8);
  b.colliderCylinder(6.6, 0.6, 0, 0.05, 0);
  b.colliderCylinder(2.3, 0.5, 0, 0.55, 0);
  // Ring of columns, some broken, one toppled
  const heights = [4.2, 1.6, 3.4, 4.2, 0.9, 2.6, 4.2, 1.9];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const x = Math.cos(a) * 5.2, z = Math.sin(a) * 5.2;
    const h = heights[i];
    b.cylinder('stone', 0.36, 0.42, h, x, 0.35 + h / 2, z, 8);
    b.box('darkStone', 1.0, 0.25, 1.0, x, 0.47, z);
    if (h > 4) b.box('stone', 1.0, 0.3, 1.0, x, 0.35 + h + 0.15, z);
    b.colliderCylinder(0.45, h, x, 0.35 + h / 2, z);
    if (i === 4) {
      // The fallen part of this column lies on the floor outside the ring
      b.cylinder('stone', 0.36, 0.36, 2.8, x + 1.6, 0.6, z - 0.4, 8, Math.PI / 2, 0.7);
      b.colliderBox(2.8, 0.7, 0.75, x + 1.6, 0.6, z - 0.4, 0.7 + Math.PI / 2);
    }
  }
  // Mossy rubble around
  for (let i = 0; i < 9; i++) {
    const a = seed + i * 2.3;
    const r = 6.8 + (i % 3) * 0.9;
    b.rock(i % 2 ? 'moss' : 'darkStone', 0.5 + (i % 3) * 0.2, 0.35, 0.5, Math.cos(a) * r, 0.1, Math.sin(a) * r, seed + i);
  }
  // Altar steps toward the front, where the chest sits
  b.box('stone', 2.4, 0.25, 0.8, 0, 0.42, 2.7);
  b.build(scene, physics, origin, site.yaw, 'Ruins');
  return {
    chest: { pos: siteToWorld(origin, site.yaw, 0, 0.8, 0), yaw: site.yaw },
    lights: [],
  };
}

// ---------------------------------------------------------------- hut

function buildHut(site: IslandSite, origin: THREE.Vector3, scene: THREE.Scene, physics: PhysicsWorld): LandmarkAnchors {
  const b = new StructureBuilder();
  const W = 5, D = 4, H = 2.6, T = 0.22;
  // Log walls with a doorway in the front
  b.box('wood', W, H, T, 0, H / 2, -D / 2).colliderBox(W, H, T, 0, H / 2, -D / 2);
  b.box('wood', T, H, D, -W / 2, H / 2, 0).colliderBox(T, H, D, -W / 2, H / 2, 0);
  b.box('wood', T, H, D, W / 2, H / 2, 0).colliderBox(T, H, D, W / 2, H / 2, 0);
  const side = (W - 1.3) / 2;
  b.box('wood', side, H, T, -W / 2 + side / 2, H / 2, D / 2).colliderBox(side, H, T, -W / 2 + side / 2, H / 2, D / 2);
  b.box('wood', side, H, T, W / 2 - side / 2, H / 2, D / 2).colliderBox(side, H, T, W / 2 - side / 2, H / 2, D / 2);
  b.box('wood', 1.3, 0.5, T, 0, H - 0.25, D / 2);
  // Log ends sticking out at the corners
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    for (let y = 0.2; y < H; y += 0.45) b.cylinder('darkWood', 0.13, 0.13, 0.5, cx * (W / 2), y, cz * (D / 2), 6, Math.PI / 2, Math.PI / 4);
  }
  // Gable roof with a hole torn in one side; a fallen board leans on the wall
  const pitch = 0.62;
  const slope = (D / 2 + 0.4) / Math.cos(pitch);
  // Positive X-rotation dips a slab's +Z end, so the back slope tilts negative, the front positive
  const roofY = H + Math.tan(pitch) * (D / 4 + 0.2) - 0.05;
  b.box('roof', W + 0.6, 0.12, slope, 0, roofY, -(D / 4 + 0.2), 0, -pitch);
  b.box('roof', (W + 0.6) * 0.45, 0.12, slope, -(W + 0.6) * 0.275, roofY, D / 4 + 0.2, 0, pitch);
  b.box('roof', (W + 0.6) * 0.25, 0.12, slope, (W + 0.6) * 0.375, roofY, D / 4 + 0.2, 0, pitch);
  // Gable ends
  for (const sx of [-W / 2, W / 2]) {
    const gable = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(sx, H, -D / 2), new THREE.Vector3(sx, H, D / 2), new THREE.Vector3(sx, H + Math.tan(pitch) * (D / 2), 0),
    ]);
    gable.setIndex(sx < 0 ? [0, 1, 2] : [0, 2, 1]);
    b.add('wood', gable);
  }
  b.box('darkWood', 0.3, 2.2, 0.06, 1.6, 1.0, D / 2 + 0.35, 0, -0.35);
  // Floor, a table, a stool and a bookshelf with the old cookbook
  b.box('darkWood', W - 0.2, 0.08, D - 0.2, 0, 0.04, 0);
  b.box('wood', 1.2, 0.08, 0.7, -1.3, 0.8, -1.2).box('darkWood', 0.08, 0.8, 0.08, -1.8, 0.4, -1.45).box('darkWood', 0.08, 0.8, 0.08, -0.8, 0.4, -0.95);
  b.box('darkWood', 0.08, 0.8, 0.08, -1.8, 0.4, -0.95).box('darkWood', 0.08, 0.8, 0.08, -0.8, 0.4, -1.45);
  b.colliderBox(1.2, 0.85, 0.7, -1.3, 0.42, -1.2);
  b.box('darkWood', 1.2, 1.8, 0.4, 1.6, 0.9, -1.7).colliderBox(1.2, 1.8, 0.4, 1.6, 0.9, -1.7);
  for (let i = 0; i < 5; i++) b.box(i % 2 ? 'red' : 'roof', 0.16, 0.32, 0.26, 1.2 + i * 0.2, 1.36, -1.6);
  // Chimney
  b.box('darkStone', 0.7, 2.2, 0.7, -1.7, H + 0.6, -1.4);
  b.build(scene, physics, origin, site.yaw, 'Hut');
  return {
    chest: { pos: siteToWorld(origin, site.yaw, 1.2, 0, 0.3), yaw: site.yaw - Math.PI / 2 },
    lights: [],
  };
}

// ---------------------------------------------------------------- cave mouth

function buildCaveMouth(site: IslandSite, origin: THREE.Vector3, scene: THREE.Scene, physics: PhysicsWorld): LandmarkAnchors {
  const b = new StructureBuilder();
  const seed = SEED(site.id);
  // Boulders stacked into a horseshoe arch around a dark opening, set back against the slope
  const back = -1.6;
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    const x = Math.cos(a) * 2.9;
    const y = Math.sin(a) * 3.3;
    const s = 1.05 + ((seed + i) % 3) * 0.18;
    b.rock(i % 3 === 1 ? 'moss' : 'darkStone', s, s * 0.9, s * 1.1, x, y + 0.2, back, seed + i);
  }
  // Big shoulders that tie the arch into the hill
  b.rock('darkStone', 2.2, 2.6, 2.4, -4.4, 1.0, back - 0.8, seed + 20);
  b.rock('darkStone', 2.2, 2.4, 2.4, 4.4, 1.0, back - 0.8, seed + 21);
  b.rock('stone', 3.6, 1.8, 2.6, 0, 4.4, back - 1.4, seed + 22);
  b.colliderBox(2.4, 6, 3.2, -3.9, 2.5, back - 0.6).colliderBox(2.4, 6, 3.2, 3.9, 2.5, back - 0.6);
  b.colliderBox(9, 2.4, 3.6, 0, 5.2, back - 0.8);
  // The dark mouth: a void the light does not reach; a collider stops the player at it
  const mouth = new THREE.CircleGeometry(1, 20, 0, Math.PI);
  mouth.scale(2.5, 3.0, 1);
  mouth.translate(0, 0.15, back - 0.7);
  b.add('void', mouth);
  b.add('void', new THREE.PlaneGeometry(5, 0.4).translate(0, 0.0, back - 0.7));
  b.colliderBox(5.4, 4, 1, 0, 2, back - 1.4);
  // Torches either side
  for (const sx of [-1.9, 1.9]) {
    b.cylinder('darkWood', 0.05, 0.06, 1.3, sx, 0.65, back + 0.9, 6);
    b.cylinder('gold', 0.12, 0.07, 0.18, sx, 1.35, back + 0.9, 6);
  }
  b.build(scene, physics, origin, site.yaw, 'CaveMouth');
  const torch = (sx: number) => ({ ...siteToWorld(origin, site.yaw, sx, 1.5, back + 0.9), range: 7, halo: 1.4, intensity: 1.1 });
  return {
    action: siteToWorld(origin, site.yaw, 0, 0, back + 0.4),
    lights: [torch(-1.9), torch(1.9)],
  };
}

export { STRUCTURE_MATERIALS };
