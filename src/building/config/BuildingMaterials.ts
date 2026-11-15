import * as THREE from 'three';
import { createNorseWoodTexture, createChiseledStoneTexture, createThatchRoofTexture, createCheckerWallTexture, createCheckerFloorTexture, createCheckerWindowTexture, createCheckerPillarTexture, createRusticatedQuoinTexture, createWhitePaintedWoodTexture, createMahoganyWoodTexture, createCharcoalWoodTexture, createCreamWoodTexture } from './BuildingTextures';
import { createGlassMaterial } from '../../scene/GlassMatcap';
import { PROCEDURAL_ROOF_MATERIALS } from '../ProceduralRoofSystem';

// Cached shared materials
export const BUILDING_MATERIALS = {
  whiteWood: new THREE.MeshLambertMaterial({
    map: createWhitePaintedWoodTexture(),
    color: 0xffffff,
    }),
  woodWhiteDoor: new THREE.MeshLambertMaterial({
    map: createWhitePaintedWoodTexture(),
    color: 0xffffff,
    }),
  woodMahogany: new THREE.MeshLambertMaterial({
    map: createMahoganyWoodTexture(),
    }),
  woodCharcoal: new THREE.MeshLambertMaterial({
    map: createCharcoalWoodTexture(),
    }),
  woodCream: new THREE.MeshLambertMaterial({
    map: createCreamWoodTexture(),
    }),
  brassHardware: new THREE.MeshLambertMaterial({
    color: 0xd4af37,
    }),
  bronzeHardware: new THREE.MeshLambertMaterial({
    color: 0x242426,
    }),
  whiteWoodPost: new THREE.MeshLambertMaterial({
    map: createWhitePaintedWoodTexture(),
    color: 0xf8fafc,
    }),
  fenceHardware: new THREE.MeshLambertMaterial({
    color: 0x94a3b8,
    }),
  rusticatedStone: new THREE.MeshLambertMaterial({
    map: createRusticatedQuoinTexture(),
    }),
  pillarChecker: new THREE.MeshLambertMaterial({
    map: createCheckerPillarTexture(),
    }),
  wallChecker: new THREE.MeshLambertMaterial({
    map: createCheckerWallTexture(),
    }),
  floorChecker: new THREE.MeshLambertMaterial({
    map: createCheckerFloorTexture(),
    }),
  windowChecker: new THREE.MeshLambertMaterial({
    map: createCheckerWindowTexture(),
    }),
  // Glass is matcap-shaded (no per-light work): see createGlassMatcap / setGlassLight
  windowGlass: createGlassMaterial({ color: 0xa9cff5, opacity: 0.5, dither: 'near' }),
  wood: new THREE.MeshLambertMaterial({
    map: createNorseWoodTexture(),
    }),
  woodDark: new THREE.MeshLambertMaterial({
    color: 0x4a2e18,
    }),
  stone: new THREE.MeshLambertMaterial({
    map: createChiseledStoneTexture(),
    }),
  roof: new THREE.MeshLambertMaterial({
    map: createThatchRoofTexture(),
    }),
  // Greenhouse: oak glazing frame + clear glass (double-sided so it reads from inside)
  greenhouseFrame: new THREE.MeshLambertMaterial({
    color: 0x9a6a3e, // warm oak: the greenhouse is timber-framed
  }),
  greenhouseGlass: createGlassMaterial({ color: 0xe4f5f6, opacity: 0.32, side: THREE.DoubleSide, dither: 'near' }),
  roofHeartopia: PROCEDURAL_ROOF_MATERIALS.heartopiaShingle,
  roofTrim: PROCEDURAL_ROOF_MATERIALS.woodTrim,
  roofGableWall: PROCEDURAL_ROOF_MATERIALS.gableWall,
  roofTerracotta: PROCEDURAL_ROOF_MATERIALS.terracotta,
  roofSlate: PROCEDURAL_ROOF_MATERIALS.slate,
  // Ghost preview materials
  ghostValid: new THREE.MeshLambertMaterial({
    color: 0x22c55e, // Emerald green
    transparent: true,
    opacity: 0.55,
    emissive: 0x15803d,
    emissiveIntensity: 0.4,
    depthWrite: false,
  }),
  ghostInvalid: new THREE.MeshLambertMaterial({
    color: 0xef4444, // Red
    transparent: true,
    opacity: 0.55,
    emissive: 0xb91c1c,
    emissiveIntensity: 0.4,
    depthWrite: false,
  }),
  ghostWarning: new THREE.MeshLambertMaterial({
    color: 0xf59e0b, // Amber
    transparent: true,
    opacity: 0.55,
    emissive: 0xd97706,
    emissiveIntensity: 0.35,
    depthWrite: false,
  }),
  socketMarker: new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.85,
    wireframe: false,
  }),
};

/**
 * Glass LOD for every glazed building piece (windows, glazed doors, greenhouse panels and roofs),
 * split over two complementary materials drawn on the same glass geometry:
 * - the near material (transparent pass): clear, alpha-blended glass up close;
 * - its far twin (opaque pass, writes depth): solid glass colour far away.
 * Between GLASS_DITHER_NEAR and GLASS_DITHER_FAR metres a 4x4 Bayer screen-door pattern hands
 * pixels from one to the other, so the switch never pops. Beyond the far distance the blended
 * material discards everything: distant glass costs no blending/overdraw and sorts correctly.
 */
/** Greenhouse glass from afar: the reflection over the green interior, opaque. */
export const GREENHOUSE_GLASS_FAR = createGlassMaterial({ color: 0xc4dcd8, side: THREE.DoubleSide, dither: 'far' });
/** Window / door glass seen from afar: the blue-grey the tinted pane reads as over a dark room. */
export const WINDOW_GLASS_FAR = createGlassMaterial({ color: 0x93b4cc, dither: 'far' });

/** Warm lamp light seen through a pane at night, full strength (the levels scale it). */
const ROOM_GLOW = new THREE.Color(1.0, 0.62, 0.26);

/**
 * Window / door glass by how lit the room behind it is: [unlit, dim, bright]. The lit ones differ
 * only in a uniform, so they share the unlit glass's shader programs; a pane swaps material only
 * when its room's light changes (see WindowGlow).
 */
export const WINDOW_GLASS_LEVELS = {
  near: [
    BUILDING_MATERIALS.windowGlass,
    createGlassMaterial({ color: 0xa9cff5, opacity: 0.5, dither: 'near', glow: ROOM_GLOW.clone().multiplyScalar(0.3) }),
    createGlassMaterial({ color: 0xa9cff5, opacity: 0.5, dither: 'near', glow: ROOM_GLOW.clone().multiplyScalar(0.6) }),
  ],
  far: [
    WINDOW_GLASS_FAR,
    createGlassMaterial({ color: 0x93b4cc, dither: 'far', glow: ROOM_GLOW.clone().multiplyScalar(0.3) }),
    createGlassMaterial({ color: 0x93b4cc, dither: 'far', glow: ROOM_GLOW.clone().multiplyScalar(0.6) }),
  ],
};

/** Near (blended) glass material -> its opaque far twin. */
const FAR_GLASS = new Map<THREE.Material, THREE.Material>([
  [BUILDING_MATERIALS.greenhouseGlass, GREENHOUSE_GLASS_FAR],
  [BUILDING_MATERIALS.windowGlass, WINDOW_GLASS_FAR],
]);

/** Skips a geometry group (three.js does not draw groups whose material is invisible). */
const SKIP_GROUP = new THREE.MeshBasicMaterial({ visible: false });

/**
 * Gives every mesh that uses a near glass material a twin on the same geometry that draws only
 * the glass groups with the far (opaque) material. Twins share geometry, so roof resizes that swap
 * `geometry` must update all meshes of the piece. No-op for pieces without glass.
 */
export function addFarGlassTwins(root: THREE.Object3D): void {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.name === 'farGlassTwin') return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (mats.some((x) => FAR_GLASS.has(x))) meshes.push(m);
  });
  for (const m of meshes) {
    const twinMat = Array.isArray(m.material)
      ? m.material.map((x) => FAR_GLASS.get(x) ?? SKIP_GROUP)
      : FAR_GLASS.get(m.material)!;
    const twin = new THREE.Mesh(m.geometry, twinMat);
    twin.name = 'farGlassTwin';
    twin.position.copy(m.position);
    twin.quaternion.copy(m.quaternion);
    twin.scale.copy(m.scale);
    twin.matrixAutoUpdate = m.matrixAutoUpdate;
    twin.updateMatrix();
    m.parent!.add(twin);
  }
}

