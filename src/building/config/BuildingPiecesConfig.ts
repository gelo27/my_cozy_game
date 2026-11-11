import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FURNITURE_PIECE_DEFS, buildFurnitureTemplate, isFurniturePiece } from '../furniture/FurnitureCatalog';
import { BuildingPieceDef, BuildingPieceType, BuiltPiece, PieceCategory, SocketType, isGlassRoofPiece, shapeOf } from '../types/BuildingTypes';
import { PROCEDURAL_ROOF_MATERIALS, ProceduralRoofSystem, ProceduralRoofGenerator } from '../ProceduralRoofSystem';
import { GreenhouseRoofGenerator } from '../GreenhouseRoofGenerator';
import type { ProceduralRoofConfig } from '../ProceduralRoofSystem';
import { BUILDING_CONFIG } from '../../config/constants';
import { createGlassMaterial } from '../../scene/GlassMatcap';

// Procedural texture generator for stylized Norse wood and stone
function createNorseWoodTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Warm rich Scandinavian wood base
  ctx.fillStyle = '#6e4726';
  ctx.fillRect(0, 0, 512, 512);

  // Planks horizontal bands
  const plankHeight = 512 / 8;
  for (let i = 0; i < 8; i++) {
    const y = i * plankHeight;
    // Plank shade variation
    const brightness = 0.9 + Math.random() * 0.2;
    ctx.fillStyle = `rgba(${Math.floor(130 * brightness)}, ${Math.floor(82 * brightness)}, ${Math.floor(45 * brightness)}, 0.4)`;
    ctx.fillRect(0, y, 512, plankHeight - 3);

    // Dark seam between planks
    ctx.fillStyle = '#26170c';
    ctx.fillRect(0, y + plankHeight - 3, 512, 3);

    // Subtle grain lines
    ctx.strokeStyle = 'rgba(40, 22, 10, 0.25)';
    ctx.lineWidth = 1;
    for (let g = 0; g < 6; g++) {
      const gy = y + Math.random() * (plankHeight - 4);
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.bezierCurveTo(150, gy + (Math.random() - 0.5) * 6, 350, gy + (Math.random() - 0.5) * 6, 512, gy);
      ctx.stroke();
    }
  }

  // Wood knots
  for (let k = 0; k < 5; k++) {
    const kx = Math.random() * 512;
    const ky = Math.random() * 512;
    const rad = 4 + Math.random() * 6;
    ctx.fillStyle = '#2d190d';
    ctx.beginPath();
    ctx.ellipse(kx, ky, rad * 1.5, rad, Math.random(), 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createChiseledStoneTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Granite base
  ctx.fillStyle = '#5c636a';
  ctx.fillRect(0, 0, 512, 512);

  // Stone brick masonry pattern (4 rows x 4 cols staggered)
  const rows = 4;
  const cols = 2;
  const rowH = 512 / rows;
  const colW = 512 / cols;

  for (let r = 0; r < rows; r++) {
    const offsetX = (r % 2 === 0) ? 0 : colW / 2;
    for (let c = -1; c <= cols + 1; c++) {
      const x = c * colW + offsetX;
      const y = r * rowH;
      const b = 0.85 + Math.random() * 0.3;
      ctx.fillStyle = `rgba(${Math.floor(100 * b)}, ${Math.floor(106 * b)}, ${Math.floor(112 * b)}, 0.45)`;
      ctx.fillRect(x + 2, y + 2, colW - 4, rowH - 4);

      // Deep mortar groove
      ctx.strokeStyle = '#2b2f33';
      ctx.lineWidth = 4;
      ctx.strokeRect(x + 2, y + 2, colW - 4, rowH - 4);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createThatchRoofTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#7a633a'; // Viking thatch reed/straw
  ctx.fillRect(0, 0, 512, 512);

  const layers = 16;
  const layerH = 512 / layers;
  for (let i = 0; i < layers; i++) {
    const y = i * layerH;
    ctx.fillStyle = (i % 2 === 0) ? '#8c7243' : '#6b5430';
    ctx.fillRect(0, y, 512, layerH);

    ctx.strokeStyle = '#4a381f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y + layerH);
    ctx.lineTo(512, y + layerH);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createCheckerWallTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const gridSize = 8; // 8x8 squares -> 64px per square
  const tileSize = 512 / gridSize;

  // Heartopia cozy stylized checker palette: porcelain white and soft slate pastel
  const colorA = '#f8fafc'; // Crisp porcelain cream
  const colorB = '#94a3b8'; // Soft slate / sage pastel
  const borderColor = 'rgba(71, 85, 105, 0.4)'; // Clean subtle tile border

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const isEven = (x + y) % 2 === 0;
      ctx.fillStyle = isEven ? colorA : colorB;
      ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);

      // Clean tile edge
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x * tileSize + 0.75, y * tileSize + 0.75, tileSize - 1.5, tileSize - 1.5);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createCheckerFloorTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const gridSize = 8; // 8x8 squares -> 64px per square
  const tileSize = 512 / gridSize;

  // Heartopia warm Scandinavian parquet palette: golden oak & light beech
  const colorA = '#e2ba86'; // Warm sunlit beech parquet
  const colorB = '#ba8b57'; // Rich warm oak parquet
  const borderColor = 'rgba(120, 75, 35, 0.45)'; // Subtle parquet wood seam

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const isEven = (x + y) % 2 === 0;
      ctx.fillStyle = isEven ? colorA : colorB;
      ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);

      // Parquet plank sub-grain
      ctx.fillStyle = isEven ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)';
      ctx.fillRect(x * tileSize + 2, y * tileSize + 2, tileSize - 4, tileSize / 2 - 2);

      // Clean tile edge
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x * tileSize + 0.75, y * tileSize + 0.75, tileSize - 1.5, tileSize - 1.5);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createCheckerWindowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const gridSize = 8;
  const tileSize = 512 / gridSize;

  // Warm honey terracotta and ivory vanilla checker for windows
  const colorA = '#fffbeb'; // Sunlit ivory / warm cream
  const colorB = '#d97706'; // Warm amber terracotta
  const borderColor = 'rgba(180, 83, 9, 0.45)'; // Amber frame seam

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const isEven = (x + y) % 2 === 0;
      ctx.fillStyle = isEven ? colorA : colorB;
      ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);

      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x * tileSize + 0.75, y * tileSize + 0.75, tileSize - 1.5, tileSize - 1.5);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createCheckerPillarTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const gridSize = 8;
  const tileSize = 512 / gridSize;

  // High-contrast clean checkerboard palette: crisp white & deep charcoal navy
  const colorA = '#f8fafc'; // Porcelain white
  const colorB = '#1e293b'; // Deep slate navy
  const borderColor = 'rgba(15, 23, 42, 0.5)';

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const isEven = (x + y) % 2 === 0;
      ctx.fillStyle = isEven ? colorA : colorB;
      ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);

      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 2.0;
      ctx.strokeRect(x * tileSize + 1, y * tileSize + 1, tileSize - 2, tileSize - 2);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createRusticatedQuoinTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Warm classical limestone / cream sandstone base
  ctx.fillStyle = '#e2d9cc';
  ctx.fillRect(0, 0, 512, 512);

  // 4 horizontal rustication courses (blocks)
  const courses = 4;
  const courseH = 512 / courses;

  for (let c = 0; c < courses; c++) {
    const y = c * courseH;

    // Subtle stone shade variation
    const brightness = 0.94 + (c % 2) * 0.06;
    ctx.fillStyle = `rgba(${Math.floor(226 * brightness)}, ${Math.floor(217 * brightness)}, ${Math.floor(204 * brightness)}, 1.0)`;
    ctx.fillRect(0, y + 4, 512, courseH - 8);

    // Deep V-groove seam (рустовий шов)
    ctx.fillStyle = '#5c5447';
    ctx.fillRect(0, y, 512, 4);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, y + 4, 512, 2);

    // Subtle chiseled stone stipple texture
    ctx.fillStyle = 'rgba(70, 60, 50, 0.08)';
    for (let i = 0; i < 150; i++) {
      const rx = (i * 37) % 512;
      const ry = y + 4 + ((i * 13) % (courseH - 8));
      ctx.fillRect(rx, ry, 2, 2);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createWhitePaintedWoodTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Soft warm clean white base (cottage enamel)
  ctx.fillStyle = '#fbfcfe';
  ctx.fillRect(0, 0, 512, 512);

  // Subtle fine vertical wood grain with light paint striae
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 512;
    const w = 1 + Math.random() * 2.5;
    const alpha = 0.025 + Math.random() * 0.04;
    ctx.fillStyle = `rgba(148, 163, 184, ${alpha})`;
    ctx.fillRect(x, 0, w, 512);
  }

  // Soft edge vignette gradient across horizontal span to give depth
  const grad = ctx.createLinearGradient(0, 0, 512, 0);
  grad.addColorStop(0, 'rgba(226, 232, 240, 0.25)');
  grad.addColorStop(0.15, 'rgba(255, 255, 255, 0.5)');
  grad.addColorStop(0.85, 'rgba(255, 255, 255, 0.5)');
  grad.addColorStop(1, 'rgba(226, 232, 240, 0.25)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createMahoganyWoodTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Deep rich mahogany wood base
  ctx.fillStyle = '#451a11';
  ctx.fillRect(0, 0, 512, 512);

  // Subtle ribbon grain streaks
  for (let x = 0; x < 512; x += 16) {
    const darkness = 0.90 + Math.random() * 0.20;
    ctx.fillStyle = `rgba(${Math.floor(75 * darkness)}, ${Math.floor(28 * darkness)}, ${Math.floor(18 * darkness)}, 0.45)`;
    ctx.fillRect(x, 0, 14, 512);
  }

  // Fine vertical wood grain fibers
  ctx.strokeStyle = 'rgba(25, 9, 6, 0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 40; i++) {
    const gx = Math.random() * 512;
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.bezierCurveTo(gx + (Math.random() - 0.5) * 8, 170, gx + (Math.random() - 0.5) * 8, 340, gx, 512);
    ctx.stroke();
  }

  // Subtle satin finish sheen
  const grad = ctx.createLinearGradient(0, 0, 512, 0);
  grad.addColorStop(0, 'rgba(255, 200, 180, 0.05)');
  grad.addColorStop(0.5, 'rgba(255, 220, 200, 0.12)');
  grad.addColorStop(1, 'rgba(255, 200, 180, 0.05)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createCharcoalWoodTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Deep graphite slate charcoal base
  ctx.fillStyle = '#2c333a';
  ctx.fillRect(0, 0, 512, 512);

  // Painted enamel vertical wood pores
  ctx.strokeStyle = 'rgba(20, 24, 28, 0.4)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 35; i++) {
    const gx = Math.random() * 512;
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx + (Math.random() - 0.5) * 4, 512);
    ctx.stroke();
  }

  // Soft satin highlight
  const grad = ctx.createLinearGradient(0, 0, 512, 0);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.02)');
  grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.08)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0.02)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createCreamWoodTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Warm colonial ivory cream base
  ctx.fillStyle = '#f5eee1';
  ctx.fillRect(0, 0, 512, 512);

  // Soft warm grain lines
  ctx.strokeStyle = 'rgba(195, 180, 160, 0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 30; i++) {
    const gx = Math.random() * 512;
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx + (Math.random() - 0.5) * 5, 512);
    ctx.stroke();
  }

  // Eggshell sheen gradient
  const grad = ctx.createLinearGradient(0, 0, 512, 0);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.15)');
  grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.40)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0.15)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

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

// Wire up dynamic material updates for ProceduralRoofSystem
ProceduralRoofSystem.roofMaterial = BUILDING_MATERIALS.roofHeartopia;

// Unit size: 2 meters modular system (Valheim standard)
export const MODULE_SIZE = 2.0;
export const HALF_SIZE = MODULE_SIZE / 2.0; // 1.0m
export const WALL_THICKNESS = 0.16;
export const FLOOR_THICKNESS = 0.12;

export const BUILDING_PIECES: Record<BuildingPieceType, BuildingPieceDef> = {
  ...FURNITURE_PIECE_DEFS,
  [BuildingPieceType.WOOD_FLOOR_2X2]: {
    type: BuildingPieceType.WOOD_FLOOR_2X2,
    name: 'Wood Floor 2x2m',
    ukrainianName: 'Дерев’яна підлога 2х2м',
    category: PieceCategory.FLOORS,
    dimensions: new THREE.Vector3(MODULE_SIZE, FLOOR_THICKNESS, MODULE_SIZE),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'Square',
    description: 'Плаский дерев’яний настил для підлоги або стелі. Має 4 сокети з боків та сокети під колони.',
    sockets: [
      {
        id: 'north',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      {
        id: 'south',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      {
        id: 'east',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      {
        id: 'west',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      // Corner pillar sockets
      {
        id: 'corner_ne',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.PILLAR_BOTTOM],
      },
      {
        id: 'corner_nw',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.PILLAR_BOTTOM],
      },
      {
        id: 'corner_se',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.PILLAR_BOTTOM],
      },
      {
        id: 'corner_sw',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.PILLAR_BOTTOM],
      },
    ],
  },

  [BuildingPieceType.WOOD_FLOOR_1X1]: {
    type: BuildingPieceType.WOOD_FLOOR_1X1,
    name: 'Wood Floor 1x1m',
    ukrainianName: 'Дерев’яна підлога 1х1м',
    category: PieceCategory.FLOORS,
    dimensions: new THREE.Vector3(1.0, FLOOR_THICKNESS, 1.0),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'Square',
    description: 'Компактний плаский дерев’яний настил 1х1м для підлоги або стелі.',
    sockets: [
      {
        id: 'north',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0, 0.5),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      {
        id: 'south',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0, -0.5),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      {
        id: 'east',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
      {
        id: 'west',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.STAIRS_BOTTOM, SocketType.STAIRS_TOP],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_2X3]: {
    type: BuildingPieceType.WOOD_WALL_2X3,
    name: 'Wood Wall 2x3m',
    ukrainianName: 'Дерев’яна стіна 2х3м',
    category: PieceCategory.WALLS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 3.0, WALL_THICKNESS),
    woodCost: 3,
    stoneCost: 0,
    maxHealth: 150,
    iconName: 'Columns2',
    description: 'Широка висока дерев’яна стіна 2х3м для створення високих поверхів та просторих залів.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -1.5, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, 1.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-1.0, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(1.0, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_1X3]: {
    type: BuildingPieceType.WOOD_WALL_1X3,
    name: 'Wood Wall 1x3m',
    ukrainianName: 'Дерев’яна стіна 1х3м',
    category: PieceCategory.WALLS,
    dimensions: new THREE.Vector3(1.0, 3.0, WALL_THICKNESS),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 120,
    iconName: 'Columns',
    description: 'Висока вертикальна дерев’яна стіна 1х3м для високих стель та фасадів.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -1.5, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, 1.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_1X2]: {
    type: BuildingPieceType.WOOD_WALL_1X2,
    name: 'Wood Wall 1x2m',
    ukrainianName: 'Дерев’яна стіна 1х2м',
    category: PieceCategory.WALLS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'Columns2',
    description: 'Вузька вертикальна дерев’яна стіна шириною 1 метр для точного планування приміщень.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_2X1]: {
    type: BuildingPieceType.WOOD_WALL_2X1,
    name: 'Wood Wall 2x1m',
    ukrainianName: 'Напівстіна 2х1м',
    category: PieceCategory.WALLS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 1.0, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 70,
    iconName: 'Columns2',
    description: 'Коротка дерев’яна напівстіна 2х1м для огорож, перил, мансардних скосів та низьких прибудов.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.5, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, 0.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_1X1]: {
    type: BuildingPieceType.WOOD_WALL_1X1,
    name: 'Wood Wall 1x1m',
    ukrainianName: 'Стіна 1х1м',
    category: PieceCategory.WALLS,
    dimensions: new THREE.Vector3(1.0, 1.0, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 60,
    iconName: 'Square',
    description: 'Компактний модуль дерев’яної стіни 1х1м для детального планування та завершення стін.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.5, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, 0.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_DOORWAY_2X2]: {
    type: BuildingPieceType.WOOD_WALL_DOORWAY_2X2,
    name: 'Wood Wall with Doorway 2x2m',
    ukrainianName: 'Стіновий пройм 2х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(MODULE_SIZE, MODULE_SIZE, WALL_THICKNESS),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'DoorOpen',
    description: 'Дверна стінова коробка 2х2м під двостулкові двері з декоративною лиштвою.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_DOORWAY_1X2]: {
    type: BuildingPieceType.WOOD_WALL_DOORWAY_1X2,
    name: 'Wood Wall with Doorway 1x2m',
    ukrainianName: 'Стіновий пройм 1х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'DoorOpen',
    description: 'Дверна стінова коробка 1х2м під одинарні двері з дерев’яним фрамужним лутком.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_DOOR_SINGLE]: {
    type: BuildingPieceType.WOOD_DOOR_SINGLE,
    name: 'Wood Door Single 1x2m',
    ukrainianName: 'Одинарні двері 1х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, 0.08),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'DoorOpen',
    description: 'Одинарні дерев’яні двері 1х2м з кованими петлями, металевою ручкою та механізмом обертання.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_DOOR_DOUBLE]: {
    type: BuildingPieceType.WOOD_DOOR_DOUBLE,
    name: 'Wood Door Double 2x2m',
    ukrainianName: 'Двостулкові двері 2х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(MODULE_SIZE, MODULE_SIZE, 0.08),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'DoorOpen',
    description: 'Двостулкові дерев’яні парадні двері 2х2м із зустрічним відкриттям стей та масивними засувами.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.DOOR_GRAND_SIDELITES_2X2]: {
    type: BuildingPieceType.DOOR_GRAND_SIDELITES_2X2,
    name: 'Grand Entry Door with Sidelites 2x2m',
    ukrainianName: 'Парадні двері з бічним склінням 2х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(MODULE_SIZE, MODULE_SIZE, 0.08),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 120,
    iconName: 'DoorOpen',
    description: 'Розкішні вхідні двері з масиву червоного дерева з декоративними філенками, бічними вікнами-фрамугами та темною бронзовою ручкою.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.DOOR_WHITE_2PANEL_1X2]: {
    type: BuildingPieceType.DOOR_WHITE_2PANEL_1X2,
    name: 'White 2-Panel Shaker Door 1x2m',
    ukrainianName: 'Білі двері 2-панельні 1х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, 0.08),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'DoorClosed',
    description: 'Елегантні білі міжкімнатні двері в стилі шейкер з двома втопленими панелями та витонченою золотистою ручкою.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2]: {
    type: BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2,
    name: 'Cottage Door with 4-Pane Window 1x2m',
    ukrainianName: 'Котеджні двері з вікном 1х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, 0.08),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 85,
    iconName: 'DoorClosed',
    description: 'Графітові двері у стилі кантрі з 4-секційним віконним склінням зверху, фільонкою знизу та золотистою нажимною ручкою.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2]: {
    type: BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2,
    name: 'Colonial 6-Panel Door 1x2m',
    ukrainianName: 'Колоніальні двері 6-панельні 1х2м',
    category: PieceCategory.DOORS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, 0.08),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'DoorClosed',
    description: 'Класичні кремові двері з шістьма рельєфними фільонками та круглою золотистою ручкою-кнобом.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_WINDOW_1X2]: {
    type: BuildingPieceType.WOOD_WALL_WINDOW_1X2,
    name: 'Wood Wall with Window 1x2m',
    ukrainianName: 'Стіна з вікном 1х2м',
    category: PieceCategory.WINDOWS,
    dimensions: new THREE.Vector3(1.0, MODULE_SIZE, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'AppWindow',
    description: 'Вузька дерев’яна стіна 1х2м з віконним отвором та обрамленням для природного освітлення.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_WINDOW_1X1_5]: {
    type: BuildingPieceType.WOOD_WALL_WINDOW_1X1_5,
    name: 'Wood Wall with Window 1x1.5m',
    ukrainianName: 'Вікно 1х1.5м',
    category: PieceCategory.WINDOWS,
    dimensions: new THREE.Vector3(1.0, 1.5, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'AppWindow',
    description: 'Компактне вікно 1х1.5м з рамою та склінням для встановлення у стіни.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.75, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, 0.75, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_WINDOW_2X2]: {
    type: BuildingPieceType.WOOD_WALL_WINDOW_2X2,
    name: 'Wood Wall with Window 2x2m',
    ukrainianName: 'Стіна з вікном 2х2м',
    category: PieceCategory.WINDOWS,
    dimensions: new THREE.Vector3(MODULE_SIZE, MODULE_SIZE, WALL_THICKNESS),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'AppWindow',
    description: 'Стандартна дерев’яна стіна 2х2м з великим віконним отвором, підвіконням та перекладиною.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_WALL_WINDOW_2X4]: {
    type: BuildingPieceType.WOOD_WALL_WINDOW_2X4,
    name: 'Wood Wall with Window 2x4m',
    ukrainianName: 'Висока стіна з вікном 2х4м',
    category: PieceCategory.WINDOWS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 4.0, WALL_THICKNESS),
    woodCost: 4,
    stoneCost: 0,
    maxHealth: 180,
    iconName: 'AppWindow',
    description: 'Висока стіна 2х4м з великим ошатним вікном для панорамного освітлення великих приміщень.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -2.0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'top',
        type: SocketType.WALL_TOP,
        localPosition: new THREE.Vector3(0, 2.0, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_BOTTOM, SocketType.ROOF_EAVE, SocketType.FLOOR_EDGE],
      },
      {
        id: 'left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_STAIRS_2X2]: {
    type: BuildingPieceType.WOOD_STAIRS_2X2,
    name: 'Wood Stairs 2x2m',
    ukrainianName: 'Дерев’яні сходи 2х2м',
    category: PieceCategory.STAIRS,
    dimensions: new THREE.Vector3(MODULE_SIZE, MODULE_SIZE, MODULE_SIZE),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'TrendingUp',
    description: 'Зручні сходи з 5 сходинками для підйому на наступний поверх або дах (2м висоти).',
    isWalkableSlope: true,
    sockets: [
      {
        id: 'bottom',
        type: SocketType.STAIRS_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.STAIRS_TOP],
      },
      {
        id: 'top',
        type: SocketType.STAIRS_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.STAIRS_BOTTOM],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_STAIRS_2X1]: {
    type: BuildingPieceType.WOOD_STAIRS_2X1,
    name: 'Wood Stairs 2x1m',
    ukrainianName: 'Дерев’яні сходи 2х1м',
    category: PieceCategory.STAIRS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 1.0, MODULE_SIZE),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'TrendingUp',
    description: 'Компактні сходи висотою в 1 одиницю (1м) для терас, переходів між фундаментами та півповерхів.',
    isWalkableSlope: true,
    sockets: [
      {
        id: 'bottom',
        type: SocketType.STAIRS_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.5, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.STAIRS_TOP],
      },
      {
        id: 'top',
        type: SocketType.STAIRS_TOP,
        localPosition: new THREE.Vector3(0, 0.5, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.STAIRS_BOTTOM],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_STAIRS_2X3]: {
    type: BuildingPieceType.WOOD_STAIRS_2X3,
    name: 'Wood Stairs 2x3m',
    ukrainianName: 'Дерев’яні сходи 2х3м (висота 3м)',
    category: PieceCategory.STAIRS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 3.0, 3.0),
    woodCost: 3,
    stoneCost: 0,
    maxHealth: 120,
    iconName: 'TrendingUp',
    description: 'Високі сходи висотою в 3 одиниці (3м) з комфортним 45° кутом нахилу як у сходів 2х2м.',
    isWalkableSlope: true,
    sockets: [
      {
        id: 'bottom',
        type: SocketType.STAIRS_BOTTOM,
        localPosition: new THREE.Vector3(0, -1.5, -1.5),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.STAIRS_TOP],
      },
      {
        id: 'top',
        type: SocketType.STAIRS_TOP,
        localPosition: new THREE.Vector3(0, 1.5, 1.5),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.STAIRS_BOTTOM],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_ROOF_26]: {
    type: BuildingPieceType.WOOD_ROOF_26,
    name: 'Wood Roof 26°',
    ukrainianName: 'Дах зі стріхою 26°',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.9, MODULE_SIZE),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'Home',
    description: 'Пологий скандинавський дах зі стріхою (26 градусів) для затишних хатин та залів.',
    sockets: [
      {
        id: 'eave',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, -0.45, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.ROOF_RIDGE],
      },
      {
        id: 'ridge',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.45, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, -1),
        compatibleWith: [SocketType.ROOF_RIDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  // =========================================================================
  // HEARTOPIA PROCEDURAL ROOF PIECES (2-Pitched Gable & 4-Pitched Hipped)
  // =========================================================================
  [BuildingPieceType.ROOF_GABLE_2X2]: {
    type: BuildingPieceType.ROOF_GABLE_2X2,
    name: 'Gable Roof',
    ukrainianName: 'Двосхилий дах',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, MODULE_SIZE),
    woodCost: 4,
    stoneCost: 0,
    maxHealth: 150,
    iconName: 'Home',
    description: 'Процедурний двосхилий дах Heartopia з налаштовуваними розмірами, схилами, карнизами та коньком.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_front',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
      {
        id: 'ridge_back',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
    ],
  },

  [BuildingPieceType.ROOF_GABLE_2X4]: {
    type: BuildingPieceType.ROOF_GABLE_2X4,
    name: 'Gable Roof 2x4m',
    ukrainianName: 'Двосхилий дах 2х4м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, 4.0),
    woodCost: 6,
    stoneCost: 0,
    maxHealth: 200,
    iconName: 'Home',
    description: 'Видовжений двосхилий 2-похилий дах Heartopia для стандартних прямокутних кімнат та будинків.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_front',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, -2.0),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
      {
        id: 'ridge_back',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, 2.0),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
    ],
  },

  [BuildingPieceType.ROOF_GABLE_4X4]: {
    type: BuildingPieceType.ROOF_GABLE_4X4,
    name: 'Gable Roof 4x4m',
    ukrainianName: 'Великий двосхилий дах 4х4м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(4.0, 1.6, 4.0),
    woodCost: 10,
    stoneCost: 0,
    maxHealth: 300,
    iconName: 'Home',
    description: 'Масивний двосхилий 2-похилий дах Heartopia для перекриття двоповерхових залів та котеджів 4х4м.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-2.0, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(2.0, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_front',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 1.6, -2.0),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
      {
        id: 'ridge_back',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 1.6, 2.0),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.ROOF_RIDGE],
      },
    ],
  },

  [BuildingPieceType.ROOF_HIP_2X2]: {
    type: BuildingPieceType.ROOF_HIP_2X2,
    name: 'Hipped Roof',
    ukrainianName: 'Вальмовий дах',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, MODULE_SIZE),
    woodCost: 5,
    stoneCost: 0,
    maxHealth: 160,
    iconName: 'Shield',
    description: 'Процедурний 4-схилий вальмовий дах Heartopia з автоматичною орієнтацією конька та крокв.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_north',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_south',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_west',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_east',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.ROOF_HIP_2X4]: {
    type: BuildingPieceType.ROOF_HIP_2X4,
    name: 'Hipped Roof 2x4m',
    ukrainianName: 'Вальмовий 4-похилий дах 2х4м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, 4.0),
    woodCost: 7,
    stoneCost: 0,
    maxHealth: 220,
    iconName: 'Shield',
    description: 'Вальмовий чотирисхилий дах Heartopia для подовжених будинків з двома трапеціями та двома вальмами.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_north',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -2.0),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_south',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, 2.0),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_west',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_east',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.ROOF_HIP_4X4]: {
    type: BuildingPieceType.ROOF_HIP_4X4,
    name: 'Hipped Roof 4x4m',
    ukrainianName: 'Великий вальмовий дах 4х4м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(4.0, 1.6, 4.0),
    woodCost: 12,
    stoneCost: 0,
    maxHealth: 320,
    iconName: 'Shield',
    description: 'Величний 4-похилий шатровий дах Heartopia для вілл та маєтків 4х4м з виразним карнизом.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_north',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -2.0),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_south',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, 2.0),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_west',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-2.0, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_east',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(2.0, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  // 1-PITCHED SHED ROOFS (ОДНОСХИЛИЙ ДАХ)
  [BuildingPieceType.ROOF_SHED_2X2]: {
    type: BuildingPieceType.ROOF_SHED_2X2,
    name: 'Shed Roof 2x2m',
    ukrainianName: 'Односхилий дах 2х2м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, MODULE_SIZE),
    woodCost: 4,
    stoneCost: 0,
    maxHealth: 150,
    iconName: 'Home',
    description: 'Сучасний односхилий дах у стилі Sims 4 для веранд, прибудов та сучасних котеджів 2х2м з текстурованими коньками та карнизами.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_low',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_high',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_RIDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0.425, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0.425, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.ROOF_SHED_2X4]: {
    type: BuildingPieceType.ROOF_SHED_2X4,
    name: 'Shed Roof 2x4m',
    ukrainianName: 'Односхилий дах 2х4м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, 4.0),
    woodCost: 7,
    stoneCost: 0,
    maxHealth: 220,
    iconName: 'Home',
    description: 'Подовжений односхилий дах 2х4м для великих терас, гаражів та навісів.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_low',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -2.0),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_high',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 0.85, 2.0),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_RIDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0.425, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0.425, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.ROOF_SHED_4X4]: {
    type: BuildingPieceType.ROOF_SHED_4X4,
    name: 'Shed Roof 4x4m',
    ukrainianName: 'Великий односхилий дах 4х4м',
    category: PieceCategory.ROOFS,
    dimensions: new THREE.Vector3(4.0, 1.6, 4.0),
    woodCost: 12,
    stoneCost: 0,
    maxHealth: 320,
    iconName: 'Home',
    description: 'Масивний односхилий дах 4х4м для архітектурних студій, вілл та сучасних просторів.',
    sockets: [
      {
        id: 'bottom_center',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE],
      },
      {
        id: 'eave_low',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(0, 0, -2.0),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'ridge_high',
        type: SocketType.ROOF_RIDGE,
        localPosition: new THREE.Vector3(0, 1.6, 2.0),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_RIDGE],
      },
      {
        id: 'eave_left',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(-2.0, 0.8, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
      {
        id: 'eave_right',
        type: SocketType.ROOF_EAVE,
        localPosition: new THREE.Vector3(2.0, 0.8, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_TOP, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.WOOD_POLE_2M]: {
    type: BuildingPieceType.WOOD_POLE_2M,
    name: 'Wood Pole 2m',
    ukrainianName: 'Кругла колона 2м',
    category: PieceCategory.PILLARS,
    dimensions: new THREE.Vector3(0.24, MODULE_SIZE, 0.24),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 120,
    iconName: 'MinusVertical',
    description: 'Опорна вертикальна балка / колона для підтримки навісів, балконів та перекриттів.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(0, -HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.PILLAR_TOP],
      },
      {
        id: 'top',
        type: SocketType.PILLAR_TOP,
        localPosition: new THREE.Vector3(0, HALF_SIZE, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.PILLAR_BOTTOM, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.CHECKER_PILLAR_1M]: {
    type: BuildingPieceType.CHECKER_PILLAR_1M,
    name: 'Square Checker Pillar 1m',
    ukrainianName: 'Квадратна опора 1м (Чекер)',
    category: PieceCategory.PILLARS,
    dimensions: new THREE.Vector3(0.4, 1.0, 0.4),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 150,
    iconName: 'Box',
    description: 'Квадратна опора висотою 1м із контрастною текстурою-чекером та можливістю дублювання вгору/вниз.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.5, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.PILLAR_TOP],
      },
      {
        id: 'top',
        type: SocketType.PILLAR_TOP,
        localPosition: new THREE.Vector3(0, 0.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.PILLAR_BOTTOM, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.CORNER_RUSTICATED_QUOIN_1M]: {
    type: BuildingPieceType.CORNER_RUSTICATED_QUOIN_1M,
    name: 'Corner Rusticated Quoin 1m',
    ukrainianName: 'Кутовий фасадний босаж (Русти) 1м',
    category: PieceCategory.PILLARS,
    dimensions: new THREE.Vector3(0.4, 1.0, 0.4),
    woodCost: 0,
    stoneCost: 2,
    maxHealth: 200,
    iconName: 'Box',
    description: 'Декоративний кутовий фасадний блок (русти/босаж) висотою 1м із рельефними кам’яними блоками.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.PILLAR_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.5, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.PILLAR_TOP],
      },
      {
        id: 'top',
        type: SocketType.PILLAR_TOP,
        localPosition: new THREE.Vector3(0, 0.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.PILLAR_BOTTOM, SocketType.FLOOR_EDGE, SocketType.ROOF_EAVE],
      },
    ],
  },

  [BuildingPieceType.STONE_FOUNDATION_2X2]: {
    type: BuildingPieceType.STONE_FOUNDATION_2X2,
    name: 'Stone Foundation 2x2m',
    ukrainianName: 'Кам’яний фундамент 2х2м',
    category: PieceCategory.FLOORS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 1.0, MODULE_SIZE),
    woodCost: 0,
    stoneCost: 4,
    maxHealth: 250,
    iconName: 'Box',
    description: 'Міцний кам’яний блок фундаменту для вирівнювання рельєфу та стійкості конструкцій.',
    sockets: [
      {
        id: 'top',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0.5, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_BOTTOM, SocketType.PILLAR_BOTTOM],
      },
      {
        id: 'side_n',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0, HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, 1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE],
      },
      {
        id: 'side_s',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(0, 0, -HALF_SIZE),
        localNormal: new THREE.Vector3(0, 0, -1),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE],
      },
      {
        id: 'side_e',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE],
      },
      {
        id: 'side_w',
        type: SocketType.FLOOR_EDGE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.FLOOR_EDGE],
      },
    ],
  },

  // =========================================================================
  // RAILINGS & BALUSTRADES (WOOD_RAILING_2M, WOOD_RAILING_1M, WOOD_STAIR_RAILING_2X2)
  // =========================================================================
  [BuildingPieceType.WOOD_RAILING_2M]: {
    type: BuildingPieceType.WOOD_RAILING_2M,
    name: 'Wood Railing 2m',
    ukrainianName: 'Дерев’яні перила 2м',
    category: PieceCategory.RAILINGS,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.95, 0.12),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 80,
    iconName: 'Fence',
    description: 'Прямі перила заввишки ~0.95м для відкритих терас, балконів та веранд. Запобігають падінню персонажа.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.475, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(HALF_SIZE, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_RAILING_1M]: {
    type: BuildingPieceType.WOOD_RAILING_1M,
    name: 'Wood Railing 1m',
    ukrainianName: 'Дерев’яні перила 1м',
    category: PieceCategory.RAILINGS,
    dimensions: new THREE.Vector3(1.0, 0.95, 0.12),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 60,
    iconName: 'Fence',
    description: 'Короткі прямі перила заввишки ~0.95м для кутів, вузьких секцій або балконів. Запобігають падінню персонажа.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.475, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WOOD_STAIR_RAILING_2X2]: {
    type: BuildingPieceType.WOOD_STAIR_RAILING_2X2,
    name: 'Wood Stair Railing 2x2m',
    ukrainianName: 'Похилі сходові перила 2х2м',
    category: PieceCategory.RAILINGS,
    dimensions: new THREE.Vector3(0.12, MODULE_SIZE, MODULE_SIZE),
    woodCost: 2,
    stoneCost: 0,
    maxHealth: 100,
    iconName: 'TrendingUp',
    description: 'Похилі перила під кутом 45° для захисту країв сходових маршів 2х2м. Кріпляться до сокетів сходів side_left або side_right.',
    sockets: [
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  [BuildingPieceType.WHITE_DECORATIVE_FENCE_1M]: {
    type: BuildingPieceType.WHITE_DECORATIVE_FENCE_1M,
    name: 'White Decorative Fence 1x1',
    ukrainianName: 'Декоративний білий заборчик 1х1',
    category: PieceCategory.RAILINGS,
    dimensions: new THREE.Vector3(1.0, 0.95, 0.12),
    woodCost: 1,
    stoneCost: 0,
    maxHealth: 70,
    iconName: 'Fence',
    description: 'Ошатний білий декоративний парканчик 1х1м з фігурними штахетниками та пірамідальними навершями стовпчиків. Чудово пасує для огорожі подвір’я, клумб, садів та відкритих зон відпочинку.',
    sockets: [
      {
        id: 'bottom',
        type: SocketType.WALL_BOTTOM,
        localPosition: new THREE.Vector3(0, -0.475, 0),
        localNormal: new THREE.Vector3(0, -1, 0),
        localUp: new THREE.Vector3(0, 0, 1),
        compatibleWith: [SocketType.FLOOR_EDGE, SocketType.WALL_TOP],
      },
      {
        id: 'side_left',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(-0.5, 0, 0),
        localNormal: new THREE.Vector3(-1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
      {
        id: 'side_right',
        type: SocketType.WALL_SIDE,
        localPosition: new THREE.Vector3(0.5, 0, 0),
        localNormal: new THREE.Vector3(1, 0, 0),
        localUp: new THREE.Vector3(0, 1, 0),
        compatibleWith: [SocketType.WALL_SIDE],
      },
    ],
  },

  // ===========================================================================
  // GREENHOUSE (glasshouse). Sockets are copied from the wooden twin after this table.
  // ===========================================================================
  [BuildingPieceType.GLASS_WALL_2X3]: {
    type: BuildingPieceType.GLASS_WALL_2X3,
    name: 'Glass Wall 2x3m',
    ukrainianName: 'Скляна стіна 2х3м',
    category: PieceCategory.GREENHOUSE,
    dimensions: new THREE.Vector3(MODULE_SIZE, 3.0, WALL_THICKNESS),
    woodCost: 2,
    stoneCost: 1,
    maxHealth: 80,
    iconName: 'PanelsTopLeft',
    description: 'Скляна панель теплиці 2х3м у білій рамі: пропускає світло, захищає від дощу та снігу.',
    sockets: [],
  },

  [BuildingPieceType.GLASS_WALL_1X3]: {
    type: BuildingPieceType.GLASS_WALL_1X3,
    name: 'Glass Wall 1x3m',
    ukrainianName: 'Скляна стіна 1х3м',
    category: PieceCategory.GREENHOUSE,
    dimensions: new THREE.Vector3(1.0, 3.0, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 1,
    maxHealth: 60,
    iconName: 'PanelsTopLeft',
    description: 'Вузька скляна панель теплиці 1х3м.',
    sockets: [],
  },

  [BuildingPieceType.GLASS_DOORWAY_1X3]: {
    type: BuildingPieceType.GLASS_DOORWAY_1X3,
    name: 'Glass Doorway 1x3m',
    ukrainianName: 'Скляний вхід 1х3м',
    category: PieceCategory.GREENHOUSE,
    dimensions: new THREE.Vector3(1.0, 3.0, WALL_THICKNESS),
    woodCost: 1,
    stoneCost: 1,
    maxHealth: 60,
    iconName: 'DoorOpen',
    description: 'Вхід у теплицю: рама зі скляною фрамугою над прохідним отвором.',
    sockets: [],
  },

  [BuildingPieceType.GLASS_DOOR_1X3]: {
    type: BuildingPieceType.GLASS_DOOR_1X3,
    name: 'Glass Door 1x3m',
    ukrainianName: 'Скляні двері 1х3м',
    category: PieceCategory.GREENHOUSE,
    dimensions: new THREE.Vector3(1.0, 3.0, WALL_THICKNESS),
    woodCost: 2,
    stoneCost: 1,
    maxHealth: 70,
    iconName: 'DoorClosed',
    description: 'Засклені двері теплиці зі стулкою, що відчиняється, та скляною фрамугою над нею.',
    sockets: [],
  },

  [BuildingPieceType.GLASS_ROOF_GABLE_2X2]: {
    type: BuildingPieceType.GLASS_ROOF_GABLE_2X2,
    name: 'Glass Gable Roof',
    ukrainianName: 'Скляний двосхилий дах',
    category: PieceCategory.GREENHOUSE,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, MODULE_SIZE),
    woodCost: 2,
    stoneCost: 2,
    maxHealth: 120,
    iconName: 'Home',
    description: 'Засклений двосхилий дах теплиці; розтягується стрілками як звичайний дах.',
    sockets: [],
  },

  [BuildingPieceType.GLASS_ROOF_SHED_2X2]: {
    type: BuildingPieceType.GLASS_ROOF_SHED_2X2,
    name: 'Glass Lean-to Roof',
    ukrainianName: 'Скляний односхилий дах',
    category: PieceCategory.GREENHOUSE,
    dimensions: new THREE.Vector3(MODULE_SIZE, 0.85, MODULE_SIZE),
    woodCost: 2,
    stoneCost: 2,
    maxHealth: 120,
    iconName: 'Home',
    description: 'Засклений односхилий дах для прибудованої до стіни теплиці.',
    sockets: [],
  },
};

// Glass pieces snap exactly like their wooden twins
for (const def of Object.values(BUILDING_PIECES)) {
  const twin = shapeOf(def.type);
  if (twin !== def.type) def.sockets = BUILDING_PIECES[twin].sockets;
}

/**
 * Greenhouse wall panel: wooden glazing frame (sill, head, jambs, mullions, a low kick rail and
 * a transom rail) around one thin pane of glass. With `doorway`, the lower 2.4m is an open
 * walk-through and only the transom above it is glazed.
 */
function buildGreenhouseWallGeometry(width: number, height: number, doorway = false): PieceMeshTemplate {
  const bar = 0.06;
  const depth = 0.08;
  const halfW = width / 2;
  const halfH = height / 2;
  const frame: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, 0);
    frame.push(g);
  };
  const pane = (w: number, h: number, x: number, y: number) => {
    const g = new THREE.BoxGeometry(w, h, 0.012);
    g.translate(x, y, 0);
    glass.push(g);
  };

  // Jambs and head
  box(bar, height, depth, -halfW + bar / 2, 0);
  box(bar, height, depth, halfW - bar / 2, 0);
  box(width, bar, depth, 0, halfH - bar / 2);

  const transomY = -halfH + 2.4; // top of the walk-through height
  box(width - bar * 2, bar * 0.8, depth * 0.9, 0, transomY);

  if (doorway) {
    // Glazed transom above the opening
    pane(width - bar * 2, halfH - transomY - bar * 1.2, 0, (transomY + halfH - bar) / 2);
  } else {
    // Sill, low kick rail, and vertical mullions every 0.5m
    box(width, bar * 1.4, depth * 1.1, 0, -halfH + bar * 0.7);
    box(width - bar * 2, bar * 0.8, depth * 0.9, 0, -halfH + 0.45);
    const bays = Math.max(1, Math.round(width / 0.5));
    for (let i = 1; i < bays; i++) {
      box(bar * 0.6, height - bar * 2, depth * 0.8, -halfW + (i * width) / bays, 0);
    }
    pane(width - bar * 2, height - bar * 2.4, 0, bar * 0.2);
  }

  const mergedFrame = mergeGeometries(frame)!;
  const mergedGlass = mergeGeometries(glass)!;
  frame.forEach((g) => g.dispose());
  glass.forEach((g) => g.dispose());
  const geometry = mergeGeometries([mergedFrame, mergedGlass], true)!;
  mergedFrame.dispose();
  mergedGlass.dispose();
  return {
    geometry,
    materials: [BUILDING_MATERIALS.greenhouseFrame, BUILDING_MATERIALS.greenhouseGlass],
    boundingBox: new THREE.Box3(),
  };
}

/** Greenhouse door leaf: 0.86 x 2.24m, centred on the origin, hinge side at -X. */
const GH_LEAF_W = 0.86;
const GH_LEAF_H = 2.24;
const GH_LEAF_Y = -0.355; // leaf centre in the 3m panel (bottom of the leaf ~1cm above the sill)
const GH_HINGE_X = -0.43;

interface GreenhouseParts {
  frame: THREE.BufferGeometry[];
  glass: THREE.BufferGeometry[];
  hardware: THREE.BufferGeometry[];
}

function pushBox(list: THREE.BufferGeometry[], w: number, h: number, d: number, x: number, y: number, z = 0): void {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  list.push(g);
}

/** Leaf parts (frame stiles/rails, solid kick panel, glazing, lever handles), offset by (ox, oy). */
function greenhouseDoorLeafParts(parts: GreenhouseParts, ox: number, oy: number): void {
  const w = GH_LEAF_W;
  const h = GH_LEAF_H;
  const st = 0.06; // stile / rail width
  const d = 0.05;
  const bottom = oy - h / 2;
  const top = oy + h / 2;
  pushBox(parts.frame, st, h, d, ox - w / 2 + st / 2, oy);
  pushBox(parts.frame, st, h, d, ox + w / 2 - st / 2, oy);
  pushBox(parts.frame, w - st * 2, st, d, ox, top - st / 2);
  // Solid kick panel at the bottom, then a lock rail
  const kickH = 0.38;
  pushBox(parts.frame, w - st * 2, kickH, d * 0.7, ox, bottom + kickH / 2);
  const lockY = bottom + 0.95;
  pushBox(parts.frame, w - st * 2, st * 0.8, d, ox, lockY);
  // Glazing: lower pane between kick panel and lock rail, upper pane above, a thin glazing bar in the upper pane
  const lowH = lockY - (bottom + kickH) - st * 0.4;
  pushBox(parts.glass, w - st * 2, lowH, 0.012, ox, bottom + kickH + lowH / 2);
  const upB = lockY + st * 0.4;
  const upT = top - st;
  pushBox(parts.glass, w - st * 2, upT - upB, 0.012, ox, (upB + upT) / 2);
  pushBox(parts.frame, 0.03, upT - upB, d * 0.6, ox, (upB + upT) / 2);
  // Lever handles on both faces, away from the hinge
  for (const z of [-1, 1]) {
    pushBox(parts.hardware, 0.035, 0.09, 0.03, ox + w / 2 - 0.1, lockY, z * (d / 2 + 0.015));
    pushBox(parts.hardware, 0.12, 0.022, 0.022, ox + w / 2 - 0.14, lockY + 0.02, z * (d / 2 + 0.04));
  }
  // Hinges on the hinge stile
  for (const y of [bottom + 0.3, top - 0.3]) {
    pushBox(parts.hardware, 0.03, 0.1, d + 0.01, ox - w / 2 + 0.005, y);
  }
}

/** Static greenhouse door frame: jambs, head, transom rail + transom glass, threshold. */
function greenhouseDoorFrameParts(parts: GreenhouseParts): void {
  const bar = 0.06;
  const depth = 0.08;
  pushBox(parts.frame, bar, 3.0, depth, -0.5 + bar / 2, 0);
  pushBox(parts.frame, bar, 3.0, depth, 0.5 - bar / 2, 0);
  pushBox(parts.frame, 1.0, bar, depth, 0, 1.5 - bar / 2);
  const openTop = GH_LEAF_Y + GH_LEAF_H / 2 + 0.01;
  pushBox(parts.frame, 1.0 - bar * 2, bar, depth, 0, openTop + bar / 2);
  pushBox(parts.frame, 1.0 - bar * 2, 0.02, depth * 1.2, 0, -1.5 + 0.01);
  const tB = openTop + bar;
  const tT = 1.5 - bar;
  pushBox(parts.glass, 1.0 - bar * 2, tT - tB, 0.012, 0, (tB + tT) / 2);
  pushBox(parts.frame, 0.035, tT - tB, depth * 0.7, 0, (tB + tT) / 2);
}

function mergeGreenhouseParts(parts: GreenhouseParts): PieceMeshTemplate {
  const lists = [parts.frame, parts.glass, parts.hardware];
  const merged = lists.map((l) => mergeGeometries(l)!);
  lists.forEach((l) => l.forEach((g) => g.dispose()));
  const geometry = mergeGeometries(merged, true)!;
  merged.forEach((g) => g.dispose());
  return {
    geometry,
    materials: [BUILDING_MATERIALS.greenhouseFrame, BUILDING_MATERIALS.greenhouseGlass, BUILDING_MATERIALS.brassHardware],
    boundingBox: new THREE.Box3(),
  };
}

const newParts = (): GreenhouseParts => ({ frame: [], glass: [], hardware: [] });

/** Whole closed door in one geometry (ghost preview, bounds). */
function buildGreenhouseDoorGeometry(): PieceMeshTemplate {
  const parts = newParts();
  greenhouseDoorFrameParts(parts);
  greenhouseDoorLeafParts(parts, 0, GH_LEAF_Y);
  return mergeGreenhouseParts(parts);
}

function buildGreenhouseDoorFrame(): PieceMeshTemplate {
  const parts = newParts();
  greenhouseDoorFrameParts(parts);
  // Hardware list must not be empty for the merge: a strike plate on the latch jamb
  pushBox(parts.hardware, 0.02, 0.14, 0.09, 0.44, GH_LEAF_Y - GH_LEAF_H / 2 + 0.95);
  return mergeGreenhouseParts(parts);
}

/** Leaf centred on its own origin (placed under the hinge pivot). */
function buildGreenhouseDoorLeaf(): PieceMeshTemplate {
  const parts = newParts();
  greenhouseDoorLeafParts(parts, 0, 0);
  return mergeGreenhouseParts(parts);
}

let ghDoorFrameTpl: PieceMeshTemplate | null = null;
let ghDoorLeafTpl: PieceMeshTemplate | null = null;

export interface PieceMeshTemplate {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  boundingBox: THREE.Box3;
}

const TEMPLATE_CACHE = new Map<BuildingPieceType, PieceMeshTemplate>();

/**
 * Builds and caches optimized merged geometries with multi-material groups for each piece type.
 * Ensures that 250+ building pieces share the exact same GPU vertex buffers and only require
 * 1 single Mesh per placed element instead of 5-8 sub-meshes, saving thousands of draw calls.
 */
export function getPieceMeshTemplate(type: BuildingPieceType): PieceMeshTemplate {
  const cached = TEMPLATE_CACHE.get(type);
  if (cached) return cached;

  const template = isFurniturePiece(type) ? buildFurnitureTemplate(type) : buildTemplateForPiece(type);
  template.geometry.computeBoundingBox();
  template.boundingBox = template.geometry.boundingBox!.clone();
  TEMPLATE_CACHE.set(type, template);
  return template;
}

/**
 * Builds stylized separate window geometry with larger outer frame,
 * smaller inner frame, cross-braces, translucent glass, and warm honey checker texture.
 */
function buildWindowPieceGeometry(width: number, height: number): PieceMeshTemplate {
  // 1. Larger outer frame (рамка зовнішня більша)
  const outerBorder = 0.12;
  const outerThickness = 0.16; // slightly thicker than wall (0.12)

  const outerTop = new THREE.BoxGeometry(width, outerBorder, outerThickness);
  outerTop.translate(0, height / 2 - outerBorder / 2, 0);

  const outerBottom = new THREE.BoxGeometry(width, outerBorder, outerThickness);
  outerBottom.translate(0, -height / 2 + outerBorder / 2, 0);

  const outerHeight = Math.max(0.1, height - outerBorder * 2);
  const outerLeft = new THREE.BoxGeometry(outerBorder, outerHeight, outerThickness);
  outerLeft.translate(-width / 2 + outerBorder / 2, 0, 0);

  const outerRight = new THREE.BoxGeometry(outerBorder, outerHeight, outerThickness);
  outerRight.translate(width / 2 - outerBorder / 2, 0, 0);

  // 2. Smaller inner frame (рамка внутрішня менша)
  const innerMargin = outerBorder;
  const innerOpeningW = width - innerMargin * 2;
  const innerOpeningH = height - innerMargin * 2;
  const innerBorder = 0.05;
  const innerThickness = 0.13;

  const innerTop = new THREE.BoxGeometry(innerOpeningW, innerBorder, innerThickness);
  innerTop.translate(0, innerOpeningH / 2 - innerBorder / 2, 0);

  const innerBottom = new THREE.BoxGeometry(innerOpeningW, innerBorder, innerThickness);
  innerBottom.translate(0, -innerOpeningH / 2 + innerBorder / 2, 0);

  const innerMidH = Math.max(0.05, innerOpeningH - innerBorder * 2);
  const innerLeft = new THREE.BoxGeometry(innerBorder, innerMidH, innerThickness);
  innerLeft.translate(-innerOpeningW / 2 + innerBorder / 2, 0, 0);

  const innerRight = new THREE.BoxGeometry(innerBorder, innerMidH, innerThickness);
  innerRight.translate(innerOpeningW / 2 - innerBorder / 2, 0, 0);

  // 3. Cross-bracing / crossbars (з перехрестями)
  const crossThickness = 0.11;
  const crossWidth = 0.04;
  const crossHoriz = new THREE.BoxGeometry(innerOpeningW - innerBorder * 2, crossWidth, crossThickness);
  const crossVert = new THREE.BoxGeometry(crossWidth, innerOpeningH - innerBorder * 2, crossThickness);

  // Merge all frame parts together using the windowChecker material (different color checker!)
  const frameParts = [
    outerTop, outerBottom, outerLeft, outerRight,
    innerTop, innerBottom, innerLeft, innerRight,
    crossHoriz, crossVert,
  ];
  const mergedFrame = mergeGeometries(frameParts)!;
  for (const p of frameParts) {
    p.dispose();
  }

  // 4. Glass pane in center
  const glassW = Math.max(0.1, innerOpeningW - innerBorder * 2);
  const glassH = Math.max(0.1, innerOpeningH - innerBorder * 2);
  const glassGeo = new THREE.BoxGeometry(glassW, glassH, 0.02);

  // Combined geometry with material groups:
  // group 0 = windowChecker material (outer/inner frames + cross)
  // group 1 = windowGlass material (center translucent pane)
  const finalGeo = mergeGeometries([mergedFrame, glassGeo], true)!;
  mergedFrame.dispose();
  glassGeo.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.windowChecker, BUILDING_MATERIALS.windowGlass],
    boundingBox: new THREE.Box3(),
  };
}

function buildOuterDoorFrameGeometry(width: number, height: number): PieceMeshTemplate {
  const topHeaderH = 0.12;
  const jambW = width === 2.0 ? 0.10 : 0.08;
  const openingW = width - jambW * 2;
  const openingH = height - topHeaderH;
  const frameDepth = WALL_THICKNESS;
  const trimDepth = WALL_THICKNESS + 0.04;
  const trimW = 0.05;

  // 1. Core door frame posts (top header, left jamb, right jamb) - woodDark material
  const topHeader = new THREE.BoxGeometry(width, topHeaderH, frameDepth);
  topHeader.translate(0, height / 2 - topHeaderH / 2, 0);

  const leftJamb = new THREE.BoxGeometry(jambW, openingH, frameDepth);
  leftJamb.translate(-width / 2 + jambW / 2, -height / 2 + openingH / 2, 0);

  const rightJamb = new THREE.BoxGeometry(jambW, openingH, frameDepth);
  rightJamb.translate(width / 2 - jambW / 2, -height / 2 + openingH / 2, 0);

  const mergedJambs = mergeGeometries([topHeader, leftJamb, rightJamb])!;
  topHeader.dispose(); leftJamb.dispose(); rightJamb.dispose();

  // 2. Decorative outer casing / trim (рамка зверху, зліва, справа)
  const topTrim = new THREE.BoxGeometry(openingW + trimW * 2, trimW, trimDepth);
  topTrim.translate(0, -height / 2 + openingH - trimW / 2, 0);

  const leftTrim = new THREE.BoxGeometry(trimW, openingH, trimDepth);
  leftTrim.translate(-openingW / 2 - trimW / 2, -height / 2 + openingH / 2, 0);

  const rightTrim = new THREE.BoxGeometry(trimW, openingH, trimDepth);
  rightTrim.translate(openingW / 2 + trimW / 2, -height / 2 + openingH / 2, 0);

  const mergedTrim = mergeGeometries([topTrim, leftTrim, rightTrim])!;
  topTrim.dispose(); leftTrim.dispose(); rightTrim.dispose();

  const finalGeo = mergeGeometries([mergedJambs, mergedTrim], true)!;
  mergedJambs.dispose(); mergedTrim.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodDark, BUILDING_MATERIALS.woodDark],
    boundingBox: new THREE.Box3(),
  };
}

function buildDoorwayWallGeometry(width: number, height: number): PieceMeshTemplate {
  const topHeaderH = 0.12;
  const jambW = width === 2.0 ? 0.10 : 0.08;
  const openingW = width - jambW * 2;
  const openingH = height - topHeaderH;

  // 1. Main wall body lintel & posts (wallChecker material)
  const lintelGeo = new THREE.BoxGeometry(width, topHeaderH, WALL_THICKNESS);
  lintelGeo.translate(0, height / 2 - topHeaderH / 2, 0);

  const leftPostGeo = new THREE.BoxGeometry(jambW, openingH, WALL_THICKNESS);
  leftPostGeo.translate(-width / 2 + jambW / 2, -height / 2 + openingH / 2, 0);

  const rightPostGeo = new THREE.BoxGeometry(jambW, openingH, WALL_THICKNESS);
  rightPostGeo.translate(width / 2 - jambW / 2, -height / 2 + openingH / 2, 0);

  const mergedWallBody = mergeGeometries([lintelGeo, leftPostGeo, rightPostGeo])!;
  lintelGeo.dispose(); leftPostGeo.dispose(); rightPostGeo.dispose();

  // 2. Door frame trim (зверху, зліва, справа) - woodDark material
  const trimThickness = WALL_THICKNESS + 0.04;
  const trimBorder = 0.05;

  const topTrim = new THREE.BoxGeometry(openingW + trimBorder * 2, trimBorder, trimThickness);
  topTrim.translate(0, -height / 2 + openingH - trimBorder / 2, 0);

  const leftTrim = new THREE.BoxGeometry(trimBorder, openingH, trimThickness);
  leftTrim.translate(-openingW / 2 - trimBorder / 2, -height / 2 + openingH / 2, 0);

  const rightTrim = new THREE.BoxGeometry(trimBorder, openingH, trimThickness);
  rightTrim.translate(openingW / 2 + trimBorder / 2, -height / 2 + openingH / 2, 0);

  const mergedTrim = mergeGeometries([topTrim, leftTrim, rightTrim])!;
  topTrim.dispose(); leftTrim.dispose(); rightTrim.dispose();

  const finalGeo = mergeGeometries([mergedWallBody, mergedTrim], true)!;
  mergedWallBody.dispose(); mergedTrim.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.wallChecker, BUILDING_MATERIALS.woodDark],
    boundingBox: new THREE.Box3(),
  };
}

function buildSingleDoorGeometry(): PieceMeshTemplate {
  const width = 0.84;
  const height = 1.88;
  const thickness = 0.06;

  // 1. Door panel leaf (wood material)
  const leafGeo = new THREE.BoxGeometry(width, height, thickness);

  // 2. Border & cross bracing (woodDark material)
  const borderW = 0.06;
  const topB = new THREE.BoxGeometry(width, borderW, thickness + 0.015);
  topB.translate(0, height / 2 - borderW / 2, 0);

  const botB = new THREE.BoxGeometry(width, borderW, thickness + 0.015);
  botB.translate(0, -height / 2 + borderW / 2, 0);

  const midB = new THREE.BoxGeometry(width, borderW, thickness + 0.015);
  midB.translate(0, 0, 0);

  const leftB = new THREE.BoxGeometry(borderW, height, thickness + 0.015);
  leftB.translate(-width / 2 + borderW / 2, 0, 0);

  const rightB = new THREE.BoxGeometry(borderW, height, thickness + 0.015);
  rightB.translate(width / 2 - borderW / 2, 0, 0);

  const mergedFrame = mergeGeometries([topB, botB, midB, leftB, rightB])!;
  topB.dispose(); botB.dispose(); midB.dispose(); leftB.dispose(); rightB.dispose();

  // 3. Handles & hinges (iron / woodDark material)
  const handleGeo = new THREE.BoxGeometry(0.04, 0.14, 0.12);
  handleGeo.translate(width / 2 - 0.10, 0, 0);

  const topHinge = new THREE.BoxGeometry(0.03, 0.1, 0.08);
  topHinge.translate(-width / 2 + 0.01, height * 0.3, 0);

  const botHinge = new THREE.BoxGeometry(0.03, 0.1, 0.08);
  botHinge.translate(-width / 2 + 0.01, -height * 0.3, 0);

  const mergedIron = mergeGeometries([handleGeo, topHinge, botHinge])!;
  handleGeo.dispose(); topHinge.dispose(); botHinge.dispose();

  const finalGeo = mergeGeometries([leafGeo, mergedFrame, mergedIron], true)!;
  leafGeo.dispose(); mergedFrame.dispose(); mergedIron.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark, BUILDING_MATERIALS.woodDark],
    boundingBox: new THREE.Box3(),
  };
}

function buildDoubleDoorGeometry(): PieceMeshTemplate {
  const leafW = 0.90;

  const singleTpl = buildSingleDoorGeometry();

  const leftGeo = singleTpl.geometry.clone();
  leftGeo.translate(-leafW / 2 - 0.005, 0, 0);

  const rightGeo = singleTpl.geometry.clone();
  rightGeo.rotateY(Math.PI);
  rightGeo.translate(leafW / 2 + 0.005, 0, 0);

  const merged = mergeGeometries([leftGeo, rightGeo], true)!;
  leftGeo.dispose();
  rightGeo.dispose();

  return {
    geometry: merged,
    materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark, BUILDING_MATERIALS.woodDark],
    boundingBox: new THREE.Box3(),
  };
}

// -------------------------------------------------------------------------------------------------
// NEW DOOR GENERATORS (GRAND ENTRY WITH SIDELITES, WHITE SHAKER, COTTAGE WINDOW, COLONIAL 6-PANEL)
// -------------------------------------------------------------------------------------------------

/**
 * 1. Grand Entry Door 2x2m: Stationary frame with left & right sidelites (window glazing & kick panels)
 */
function buildGrandSideliteDoorFrameGeometry(): PieceMeshTemplate {
  const woodGeos: THREE.BufferGeometry[] = [];
  const glassGeos: THREE.BufferGeometry[] = [];

  const width = MODULE_SIZE; // 2.0m
  const height = MODULE_SIZE; // 2.0m
  const frameD = WALL_THICKNESS; // 0.20m
  const trimD = WALL_THICKNESS + 0.04;

  // Header beam across top
  const headerH = 0.12;
  const header = new THREE.BoxGeometry(width, headerH, frameD);
  header.translate(0, height / 2 - headerH / 2, 0);
  woodGeos.push(header);

  // Bottom threshold / sill
  const threshH = 0.04;
  const thresh = new THREE.BoxGeometry(width, threshH, frameD + 0.02);
  thresh.translate(0, -height / 2 + threshH / 2, 0);
  woodGeos.push(thresh);

  const innerH = height - headerH - threshH; // 1.84m
  const innerCenterY = -height / 2 + threshH + innerH / 2; // -0.04m

  // Outer jamb posts (left at -0.97, right at +0.97)
  const outerPostW = 0.06;
  const leftOuterPost = new THREE.BoxGeometry(outerPostW, innerH, frameD);
  leftOuterPost.translate(-width / 2 + outerPostW / 2, innerCenterY, 0);
  woodGeos.push(leftOuterPost);

  const rightOuterPost = new THREE.BoxGeometry(outerPostW, innerH, frameD);
  rightOuterPost.translate(width / 2 - outerPostW / 2, innerCenterY, 0);
  woodGeos.push(rightOuterPost);

  // Inner vertical mullion posts dividing sidelites from center door opening (center door opening width = 0.88m)
  const mullionW = 0.06;
  const mullionX = 0.44 + mullionW / 2; // 0.47m
  const leftMullion = new THREE.BoxGeometry(mullionW, innerH, frameD);
  leftMullion.translate(-mullionX, innerCenterY, 0);
  woodGeos.push(leftMullion);

  const rightMullion = new THREE.BoxGeometry(mullionW, innerH, frameD);
  rightMullion.translate(mullionX, innerCenterY, 0);
  woodGeos.push(rightMullion);

  // Sidelite openings: from x = -0.94 to -0.44 (width 0.50m, center -0.69m) and x = +0.44 to +0.94
  const sideliteW = 0.50;
  const sideliteCenterX = 0.69;

  for (const sx of [-sideliteCenterX, sideliteCenterX]) {
    // Solid wood bottom kick panel
    const kickH = 0.36;
    const kickY = -height / 2 + threshH + kickH / 2;
    const kick = new THREE.BoxGeometry(sideliteW - 0.02, kickH, frameD * 0.7);
    kick.translate(sx, kickY, 0);
    woodGeos.push(kick);

    // Decorative molding around kick panel
    const kickTrim = new THREE.BoxGeometry(sideliteW - 0.06, kickH - 0.06, frameD * 0.76);
    kickTrim.translate(sx, kickY, 0);
    woodGeos.push(kickTrim);

    // Translucent glass pane for sidelite window
    const glassH = innerH - kickH - 0.02; // ~1.46m
    const glassY = -height / 2 + threshH + kickH + glassH / 2;
    const glass = new THREE.BoxGeometry(sideliteW - 0.04, glassH, 0.012);
    glass.translate(sx, glassY, 0);
    glassGeos.push(glass);

    // 4 horizontal wooden muntin dividing bars across glass
    const muntinH = 0.025;
    const muntinD = 0.035;
    const barSpacing = glassH / 5;
    for (let b = 1; b <= 4; b++) {
      const by = glassY - glassH / 2 + b * barSpacing;
      const muntin = new THREE.BoxGeometry(sideliteW - 0.04, muntinH, muntinD);
      muntin.translate(sx, by, 0);
      woodGeos.push(muntin);
    }
  }

  // Exterior & interior decorative casing trim around frame
  const trimW = 0.06;
  const topTrim = new THREE.BoxGeometry(width + 0.08, trimW, trimD);
  topTrim.translate(0, height / 2 - headerH + trimW / 2, 0);
  woodGeos.push(topTrim);

  const leftTrim = new THREE.BoxGeometry(trimW, height, trimD);
  leftTrim.translate(-width / 2 + trimW / 2, 0, 0);
  woodGeos.push(leftTrim);

  const rightTrim = new THREE.BoxGeometry(trimW, height, trimD);
  rightTrim.translate(width / 2 - trimW / 2, 0, 0);
  woodGeos.push(rightTrim);

  const mergedWood = mergeGeometries(woodGeos)!;
  woodGeos.forEach((g) => g.dispose());

  const mergedGlass = mergeGeometries(glassGeos)!;
  glassGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWood, mergedGlass], true)!;
  mergedWood.dispose();
  mergedGlass.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodMahogany, BUILDING_MATERIALS.windowGlass],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 1b. Grand Mahogany Center Door Leaf (8 molded recessed panels with rich dark bronze pull hardware)
 */
function buildGrandMahoganyDoorLeaf(): PieceMeshTemplate {
  const woodGeos: THREE.BufferGeometry[] = [];
  const hardwareGeos: THREE.BufferGeometry[] = [];

  const width = 0.88;
  const height = 1.84;
  const thickness = 0.055;

  // Main door leaf slab core
  const core = new THREE.BoxGeometry(width, height, thickness * 0.7);
  woodGeos.push(core);

  // Outer stiles & rails framing
  const stileW = 0.10;
  const railH = 0.12;

  // Perimeter bevel frame
  const leftStile = new THREE.BoxGeometry(stileW, height, thickness);
  leftStile.translate(-width / 2 + stileW / 2, 0, 0);
  woodGeos.push(leftStile);

  const rightStile = new THREE.BoxGeometry(stileW, height, thickness);
  rightStile.translate(width / 2 - stileW / 2, 0, 0);
  woodGeos.push(rightStile);

  const topRail = new THREE.BoxGeometry(width - stileW * 2, railH, thickness);
  topRail.translate(0, height / 2 - railH / 2, 0);
  woodGeos.push(topRail);

  const botRail = new THREE.BoxGeometry(width - stileW * 2, railH * 1.3, thickness);
  botRail.translate(0, -height / 2 + (railH * 1.3) / 2, 0);
  woodGeos.push(botRail);

  // Center vertical mullion stile
  const midMullionW = 0.06;
  const midMullion = new THREE.BoxGeometry(midMullionW, height - railH * 2.3, thickness);
  midMullion.translate(0, -railH * 0.15, 0);
  woodGeos.push(midMullion);

  // 8 Recessed Panels (2 columns x 4 rows):
  // Left column center: -0.19, Right column center: +0.19
  const panelW = (width - stileW * 2 - midMullionW) / 2 - 0.01; // ~0.30m
  const colX = [-0.185, 0.185];

  const rowSpecs = [
    { y: 0.60, h: 0.22 },  // Row 1: small top panel
    { y: 0.20, h: 0.48 },  // Row 2: tall vertical panel
    { y: -0.20, h: 0.22 }, // Row 3: small middle panel
    { y: -0.56, h: 0.38 }, // Row 4: medium bottom panel
  ];

  for (const rx of colX) {
    for (const spec of rowSpecs) {
      // Recessed field
      const field = new THREE.BoxGeometry(panelW, spec.h, thickness * 0.82);
      field.translate(rx, spec.y, 0);
      woodGeos.push(field);

      // Molded raised bevel border
      const border = new THREE.BoxGeometry(panelW - 0.03, spec.h - 0.03, thickness * 0.95);
      border.translate(rx, spec.y, 0);
      woodGeos.push(border);
    }
  }

  // Cross horizontal rails separating rows
  const crossH = 0.05;
  for (let r = 0; r < rowSpecs.length - 1; r++) {
    const cy = (rowSpecs[r].y - rowSpecs[r].h / 2 + rowSpecs[r + 1].y + rowSpecs[r + 1].h / 2) / 2;
    const crossRail = new THREE.BoxGeometry(width - stileW * 2, crossH, thickness);
    crossRail.translate(0, cy, 0);
    woodGeos.push(crossRail);
  }

  // Dark Bronze Hardware:
  // Long vertical backplate escutcheon on right stile (front & back)
  const plateW = 0.032;
  const plateH = 0.36;
  const plateD = 0.075;
  const plate = new THREE.BoxGeometry(plateW, plateH, plateD);
  plate.translate(width / 2 - stileW / 2, -0.05, 0);
  hardwareGeos.push(plate);

  // Curved pull handle front
  const pullFront = new THREE.BoxGeometry(0.018, 0.24, 0.04);
  pullFront.translate(width / 2 - stileW / 2, -0.05, 0.055);
  hardwareGeos.push(pullFront);

  // Curved pull handle back
  const pullBack = new THREE.BoxGeometry(0.018, 0.24, 0.04);
  pullBack.translate(width / 2 - stileW / 2, -0.05, -0.055);
  hardwareGeos.push(pullBack);

  // Hinges on left edge (3 heavy-duty bronze cylinders)
  for (const hy of [-0.60, 0.0, 0.60]) {
    const hinge = new THREE.CylinderGeometry(0.012, 0.012, 0.09, 10);
    hinge.translate(-width / 2 + 0.005, hy, 0);
    hardwareGeos.push(hinge);
  }

  const mergedWood = mergeGeometries(woodGeos)!;
  woodGeos.forEach((g) => g.dispose());

  const mergedHardware = mergeGeometries(hardwareGeos)!;
  hardwareGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWood, mergedHardware], true)!;
  mergedWood.dispose();
  mergedHardware.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodMahogany, BUILDING_MATERIALS.bronzeHardware],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 2. White 2-Panel Shaker Door Frame (1x2m) with prominent architectural Architrave Casing
 */
function buildWhite2PanelDoorFrameGeometry(): PieceMeshTemplate {
  const width = 1.0;
  const height = MODULE_SIZE; // 2.0m
  const frameD = WALL_THICKNESS;
  const casingD = WALL_THICKNESS + 0.046; // Extends 23mm on front & back beyond wall plane for clear architectural relief

  const headerH = 0.12;
  const jambW = 0.08;
  const openingW = width - jambW * 2; // 0.84m
  const openingH = height - headerH;  // 1.88m

  const geos: THREE.BufferGeometry[] = [];

  // 1. Inner Frame Core (Jambs & Header flush with wall depth)
  const header = new THREE.BoxGeometry(width, headerH, frameD);
  header.translate(0, height / 2 - headerH / 2, 0);
  geos.push(header);

  const leftJamb = new THREE.BoxGeometry(jambW, openingH, frameD);
  leftJamb.translate(-width / 2 + jambW / 2, -height / 2 + openingH / 2, 0);
  geos.push(leftJamb);

  const rightJamb = new THREE.BoxGeometry(jambW, openingH, frameD);
  rightJamb.translate(width / 2 - jambW / 2, -height / 2 + openingH / 2, 0);
  geos.push(rightJamb);

  // Inner door stop bead (притворна планка)
  const stopD = 0.03;
  const stopW = 0.02;
  const topStop = new THREE.BoxGeometry(openingW, stopW, stopD);
  topStop.translate(0, -height / 2 + openingH - stopW / 2, 0);
  geos.push(topStop);

  const leftStop = new THREE.BoxGeometry(stopW, openingH, stopD);
  leftStop.translate(-openingW / 2 + stopW / 2, -height / 2 + openingH / 2, 0);
  geos.push(leftStop);

  const rightStop = new THREE.BoxGeometry(stopW, openingH, stopD);
  rightStop.translate(openingW / 2 - stopW / 2, -height / 2 + openingH / 2, 0);
  geos.push(rightStop);

  // 2. ARCHITRAVE CASINGS (Top, Left, Right surrounding doorway on both faces)
  const casingW = 0.08;
  const plinthH = 0.22;
  const plinthW = 0.088;
  const plinthD = casingD + 0.016;

  // --- A. Left Architrave Casing Leg (Зліва) ---
  // Main vertical casing leg (from plinth top to header bottom)
  const legH = openingH - plinthH;
  const legCenterY = -height / 2 + plinthH + legH / 2;
  const leftCasingX = -openingW / 2 - casingW / 2;

  const leftCasing = new THREE.BoxGeometry(casingW, legH, casingD);
  leftCasing.translate(leftCasingX, legCenterY, 0);
  geos.push(leftCasing);

  // Stepped outer relief band on left leg
  const leftRelief = new THREE.BoxGeometry(0.024, legH, casingD + 0.008);
  leftRelief.translate(leftCasingX - (casingW / 2 - 0.012), legCenterY, 0);
  geos.push(leftRelief);

  // Left Plinth Block at floor level (Опорний плінт)
  const leftPlinth = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
  leftPlinth.translate(-openingW / 2 - plinthW / 2 + 0.004, -height / 2 + plinthH / 2, 0);
  geos.push(leftPlinth);

  // --- B. Right Architrave Casing Leg (Справа) ---
  const rightCasingX = openingW / 2 + casingW / 2;

  const rightCasing = new THREE.BoxGeometry(casingW, legH, casingD);
  rightCasing.translate(rightCasingX, legCenterY, 0);
  geos.push(rightCasing);

  // Stepped outer relief band on right leg
  const rightRelief = new THREE.BoxGeometry(0.024, legH, casingD + 0.008);
  rightRelief.translate(rightCasingX + (casingW / 2 - 0.012), legCenterY, 0);
  geos.push(rightRelief);

  // Right Plinth Block at floor level (Опорний плінт)
  const rightPlinth = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
  rightPlinth.translate(openingW / 2 + plinthW / 2 - 0.004, -height / 2 + plinthH / 2, 0);
  geos.push(rightPlinth);

  // --- C. Top Architrave Header / Entablature (Зверху) ---
  const headerFriezeH = 0.085;
  const headerFriezeY = -height / 2 + openingH + headerFriezeH / 2;
  const headerFriezeW = openingW + casingW * 2 + 0.02; // 1.02m

  // Lower fillet bead strip below header
  const headerBead = new THREE.BoxGeometry(headerFriezeW + 0.01, 0.014, casingD + 0.012);
  headerBead.translate(0, -height / 2 + openingH + 0.007, 0);
  geos.push(headerBead);

  // Main header frieze board
  const topHeaderCasing = new THREE.BoxGeometry(headerFriezeW, headerFriezeH, casingD);
  topHeaderCasing.translate(0, headerFriezeY, 0);
  geos.push(topHeaderCasing);

  // Stepped crown cap cornice molding (Верхній карнизний козирок)
  const crownH = 0.026;
  const crownW = headerFriezeW + 0.05;
  const crownD = casingD + 0.026;
  const crownY = -height / 2 + openingH + headerFriezeH + crownH / 2;
  const topCrown = new THREE.BoxGeometry(crownW, crownH, crownD);
  topCrown.translate(0, crownY, 0);
  geos.push(topCrown);

  // Overhanging top crown fillet
  const topFillet = new THREE.BoxGeometry(crownW + 0.02, 0.012, crownD + 0.012);
  topFillet.translate(0, crownY + crownH / 2 + 0.006, 0);
  geos.push(topFillet);

  // --- D. Ground Threshold Sill (Поріг) ---
  const threshH = 0.02;
  const threshW = openingW + 0.02;
  const threshD = frameD + 0.02;
  const thresh = new THREE.BoxGeometry(threshW, threshH, threshD);
  thresh.translate(0, -height / 2 + threshH / 2, 0);
  geos.push(thresh);

  const finalGeo = mergeGeometries(geos)!;
  geos.forEach((g) => g.dispose());
  if (finalGeo.groups.length === 0 && finalGeo.index) {
    finalGeo.addGroup(0, finalGeo.index.count, 0);
  }

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodWhiteDoor],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 2b. White 2-Panel Shaker Door Leaf (with polished brass round knob)
 */
function buildWhite2PanelDoorLeaf(): PieceMeshTemplate {
  const whiteGeos: THREE.BufferGeometry[] = [];
  const brassGeos: THREE.BufferGeometry[] = [];

  const width = 0.84;
  const height = 1.88;
  const thickness = 0.048;

  const stileW = 0.10;
  const panelW = width - stileW * 2; // 0.64m

  // 1. Stiles (Left & Right)
  const leftStile = new THREE.BoxGeometry(stileW, height, thickness);
  leftStile.translate(-width / 2 + stileW / 2, 0, 0);
  whiteGeos.push(leftStile);

  const rightStile = new THREE.BoxGeometry(stileW, height, thickness);
  rightStile.translate(width / 2 - stileW / 2, 0, 0);
  whiteGeos.push(rightStile);

  // 2. Rails
  const topRailH = 0.12;
  const topRail = new THREE.BoxGeometry(panelW, topRailH, thickness);
  topRail.translate(0, height / 2 - topRailH / 2, 0);
  whiteGeos.push(topRail);

  const botRailH = 0.18;
  const botRail = new THREE.BoxGeometry(panelW, botRailH, thickness);
  botRail.translate(0, -height / 2 + botRailH / 2, 0);
  whiteGeos.push(botRail);

  const midRailH = 0.14;
  const midRailY = -0.08;
  const midRail = new THREE.BoxGeometry(panelW, midRailH, thickness);
  midRail.translate(0, midRailY, 0);
  whiteGeos.push(midRail);

  // 3. Panels (Upper tall shaker panel & Lower shaker panel)
  // Upper panel
  const topPanelH = height / 2 - topRailH - (midRailY + midRailH / 2); // 0.83m
  const topPanelY = (height / 2 - topRailH + midRailY + midRailH / 2) / 2; // 0.405m
  const topPanel = new THREE.BoxGeometry(panelW, topPanelH, thickness * 0.50);
  topPanel.translate(0, topPanelY, 0);
  whiteGeos.push(topPanel);

  const topPanelBevel = new THREE.BoxGeometry(panelW - 0.05, topPanelH - 0.05, thickness * 0.85);
  topPanelBevel.translate(0, topPanelY, 0);
  whiteGeos.push(topPanelBevel);

  // Lower panel
  const botPanelH = midRailY - midRailH / 2 - (-height / 2 + botRailH); // 0.61m
  const botPanelY = (midRailY - midRailH / 2 + (-height / 2 + botRailH)) / 2; // -0.455m
  const botPanel = new THREE.BoxGeometry(panelW, botPanelH, thickness * 0.50);
  botPanel.translate(0, botPanelY, 0);
  whiteGeos.push(botPanel);

  const botPanelBevel = new THREE.BoxGeometry(panelW - 0.05, botPanelH - 0.05, thickness * 0.85);
  botPanelBevel.translate(0, botPanelY, 0);
  whiteGeos.push(botPanelBevel);

  // 4. Polished Brass Hardware: round knob & rosette on front & back
  const knobX = width / 2 - 0.085;
  const knobY = midRailY;

  // Rosette disks
  const rosetteFront = new THREE.CylinderGeometry(0.026, 0.026, 0.006, 12);
  rosetteFront.rotateX(Math.PI / 2);
  rosetteFront.translate(knobX, knobY, thickness / 2 + 0.003);
  brassGeos.push(rosetteFront);

  const rosetteBack = new THREE.CylinderGeometry(0.026, 0.026, 0.006, 12);
  rosetteBack.rotateX(Math.PI / 2);
  rosetteBack.translate(knobX, knobY, -thickness / 2 - 0.003);
  brassGeos.push(rosetteBack);

  // Round spherical knobs
  const knobFront = new THREE.SphereGeometry(0.024, 10, 8);
  knobFront.translate(knobX, knobY, thickness / 2 + 0.028);
  brassGeos.push(knobFront);

  const knobBack = new THREE.SphereGeometry(0.024, 10, 8);
  knobBack.translate(knobX, knobY, -thickness / 2 - 0.028);
  brassGeos.push(knobBack);

  // Brass hinges on left edge
  for (const hy of [-0.55, 0.55]) {
    const hinge = new THREE.CylinderGeometry(0.009, 0.009, 0.08, 8);
    hinge.translate(-width / 2 + 0.004, hy, 0);
    brassGeos.push(hinge);
  }

  const mergedWhite = mergeGeometries(whiteGeos)!;
  whiteGeos.forEach((g) => g.dispose());

  const mergedBrass = mergeGeometries(brassGeos)!;
  brassGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWhite, mergedBrass], true)!;
  mergedWhite.dispose();
  mergedBrass.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodWhiteDoor, BUILDING_MATERIALS.brassHardware],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 3. Cottage / Farmhouse Door Frame (1x2m) in dark charcoal finish with robust timber Architrave Casing
 */
function buildCottageWindowDoorFrameGeometry(): PieceMeshTemplate {
  const width = 1.0;
  const height = MODULE_SIZE;
  const frameD = WALL_THICKNESS;
  const casingD = WALL_THICKNESS + 0.048; // Robust craftsman timber projection

  const headerH = 0.12;
  const jambW = 0.08;
  const openingW = width - jambW * 2;
  const openingH = height - headerH;

  const geos: THREE.BufferGeometry[] = [];

  // 1. Inner Core Frame (Jambs & Header)
  const header = new THREE.BoxGeometry(width, headerH, frameD);
  header.translate(0, height / 2 - headerH / 2, 0);
  geos.push(header);

  const leftJamb = new THREE.BoxGeometry(jambW, openingH, frameD);
  leftJamb.translate(-width / 2 + jambW / 2, -height / 2 + openingH / 2, 0);
  geos.push(leftJamb);

  const rightJamb = new THREE.BoxGeometry(jambW, openingH, frameD);
  rightJamb.translate(width / 2 - jambW / 2, -height / 2 + openingH / 2, 0);
  geos.push(rightJamb);

  // Door stop bead
  const stopD = 0.032;
  const stopW = 0.022;
  const topStop = new THREE.BoxGeometry(openingW, stopW, stopD);
  topStop.translate(0, -height / 2 + openingH - stopW / 2, 0);
  geos.push(topStop);

  const leftStop = new THREE.BoxGeometry(stopW, openingH, stopD);
  leftStop.translate(-openingW / 2 + stopW / 2, -height / 2 + openingH / 2, 0);
  geos.push(leftStop);

  const rightStop = new THREE.BoxGeometry(stopW, openingH, stopD);
  rightStop.translate(openingW / 2 - stopW / 2, -height / 2 + openingH / 2, 0);
  geos.push(rightStop);

  // 2. ARCHITRAVE CASINGS (Top, Left, Right surrounding doorway)
  const casingW = 0.085;
  const plinthH = 0.24;
  const plinthW = 0.092;
  const plinthD = casingD + 0.018;

  // --- A. Left Architrave Casing Leg (Зліва) ---
  const legH = openingH - plinthH;
  const legCenterY = -height / 2 + plinthH + legH / 2;
  const leftCasingX = -openingW / 2 - casingW / 2;

  const leftCasing = new THREE.BoxGeometry(casingW, legH, casingD);
  leftCasing.translate(leftCasingX, legCenterY, 0);
  geos.push(leftCasing);

  // Chamfered craftsman inner band on left leg
  const leftBand = new THREE.BoxGeometry(0.028, legH, casingD + 0.008);
  leftBand.translate(leftCasingX + (casingW / 2 - 0.014), legCenterY, 0);
  geos.push(leftBand);

  // Left Plinth Block (Опорний плінт)
  const leftPlinth = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
  leftPlinth.translate(-openingW / 2 - plinthW / 2 + 0.003, -height / 2 + plinthH / 2, 0);
  geos.push(leftPlinth);

  // --- B. Right Architrave Casing Leg (Справа) ---
  const rightCasingX = openingW / 2 + casingW / 2;

  const rightCasing = new THREE.BoxGeometry(casingW, legH, casingD);
  rightCasing.translate(rightCasingX, legCenterY, 0);
  geos.push(rightCasing);

  // Chamfered craftsman inner band on right leg
  const rightBand = new THREE.BoxGeometry(0.028, legH, casingD + 0.008);
  rightBand.translate(rightCasingX - (casingW / 2 - 0.014), legCenterY, 0);
  geos.push(rightBand);

  // Right Plinth Block (Опорний плінт)
  const rightPlinth = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
  rightPlinth.translate(openingW / 2 + plinthW / 2 - 0.003, -height / 2 + plinthH / 2, 0);
  geos.push(rightPlinth);

  // --- C. Top Architrave Header Beam (Зверху) ---
  const headerLintelH = 0.095;
  const headerLintelY = -height / 2 + openingH + headerLintelH / 2;
  const headerLintelW = openingW + casingW * 2 + 0.03; // 1.04m

  // Lower support astragal bead
  const headerAstragal = new THREE.BoxGeometry(headerLintelW + 0.015, 0.016, casingD + 0.014);
  headerAstragal.translate(0, -height / 2 + openingH + 0.008, 0);
  geos.push(headerAstragal);

  // Main thick timber lintel header
  const topHeaderCasing = new THREE.BoxGeometry(headerLintelW, headerLintelH, casingD);
  topHeaderCasing.translate(0, headerLintelY, 0);
  geos.push(topHeaderCasing);

  // Overhanging timber cap ledge (Масивний карнизний козирок)
  const crownH = 0.028;
  const crownW = headerLintelW + 0.06;
  const crownD = casingD + 0.028;
  const crownY = -height / 2 + openingH + headerLintelH + crownH / 2;
  const topCrown = new THREE.BoxGeometry(crownW, crownH, crownD);
  topCrown.translate(0, crownY, 0);
  geos.push(topCrown);

  // Top drip edge
  const topEdge = new THREE.BoxGeometry(crownW + 0.02, 0.012, crownD + 0.012);
  topEdge.translate(0, crownY + crownH / 2 + 0.006, 0);
  geos.push(topEdge);

  // --- D. Threshold Sill (Поріг) ---
  const threshH = 0.024;
  const threshW = openingW + 0.02;
  const threshD = frameD + 0.025;
  const thresh = new THREE.BoxGeometry(threshW, threshH, threshD);
  thresh.translate(0, -height / 2 + threshH / 2, 0);
  geos.push(thresh);

  const finalGeo = mergeGeometries(geos)!;
  geos.forEach((g) => g.dispose());
  if (finalGeo.groups.length === 0 && finalGeo.index) {
    finalGeo.addGroup(0, finalGeo.index.count, 0);
  }

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodCharcoal],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 3b. Cottage Door Leaf (Upper 4-pane window, lower panel, brass lever handle)
 */
function buildCottageWindowDoorLeaf(): PieceMeshTemplate {
  const woodGeos: THREE.BufferGeometry[] = [];
  const glassGeos: THREE.BufferGeometry[] = [];
  const brassGeos: THREE.BufferGeometry[] = [];

  const width = 0.84;
  const height = 1.88;
  const thickness = 0.052;

  const stileW = 0.10;
  const panelW = width - stileW * 2; // 0.64m

  // Left & Right Stiles
  const leftStile = new THREE.BoxGeometry(stileW, height, thickness);
  leftStile.translate(-width / 2 + stileW / 2, 0, 0);
  woodGeos.push(leftStile);

  const rightStile = new THREE.BoxGeometry(stileW, height, thickness);
  rightStile.translate(width / 2 - stileW / 2, 0, 0);
  woodGeos.push(rightStile);

  // Top, Mid, Bottom Rails
  const topRailH = 0.12;
  const topRail = new THREE.BoxGeometry(panelW, topRailH, thickness);
  topRail.translate(0, height / 2 - topRailH / 2, 0);
  woodGeos.push(topRail);

  const botRailH = 0.18;
  const botRail = new THREE.BoxGeometry(panelW, botRailH, thickness);
  botRail.translate(0, -height / 2 + botRailH / 2, 0);
  woodGeos.push(botRail);

  const midRailH = 0.14;
  const midRailY = -0.08;
  const midRail = new THREE.BoxGeometry(panelW, midRailH, thickness);
  midRail.translate(0, midRailY, 0);
  woodGeos.push(midRail);

  // Upper Window Section (4-pane window)
  const winH = height / 2 - topRailH - (midRailY + midRailH / 2); // 0.83m
  const winY = (height / 2 - topRailH + midRailY + midRailH / 2) / 2; // 0.405m

  // Translucent window glass
  const glass = new THREE.BoxGeometry(panelW - 0.02, winH - 0.02, 0.012);
  glass.translate(0, winY, 0);
  glassGeos.push(glass);

  // Muntin bars dividing window into 4 equal panes (cross grid)
  const muntinW = 0.024;
  const vertMuntin = new THREE.BoxGeometry(muntinW, winH - 0.02, 0.032);
  vertMuntin.translate(0, winY, 0);
  woodGeos.push(vertMuntin);

  const horizMuntin = new THREE.BoxGeometry(panelW - 0.02, muntinW, 0.032);
  horizMuntin.translate(0, winY, 0);
  woodGeos.push(horizMuntin);

  // Lower Section: Recessed Panel with cottage style field
  const botPanelH = midRailY - midRailH / 2 - (-height / 2 + botRailH); // 0.61m
  const botPanelY = (midRailY - midRailH / 2 + (-height / 2 + botRailH)) / 2; // -0.455m

  const botPanel = new THREE.BoxGeometry(panelW, botPanelH, thickness * 0.50);
  botPanel.translate(0, botPanelY, 0);
  woodGeos.push(botPanel);

  const botPanelMolding = new THREE.BoxGeometry(panelW - 0.05, botPanelH - 0.05, thickness * 0.80);
  botPanelMolding.translate(0, botPanelY, 0);
  woodGeos.push(botPanelMolding);

  // Brass Lever Handle Hardware
  const handleX = width / 2 - 0.085;
  const handleY = midRailY;

  // Rectangular backplate
  const backplate = new THREE.BoxGeometry(0.032, 0.16, 0.068);
  backplate.translate(handleX, handleY, 0);
  brassGeos.push(backplate);

  // Horizontal brass lever handle (front & back)
  const leverFront = new THREE.BoxGeometry(0.10, 0.018, 0.018);
  leverFront.translate(handleX - 0.035, handleY + 0.025, thickness / 2 + 0.025);
  brassGeos.push(leverFront);

  const leverBack = new THREE.BoxGeometry(0.10, 0.018, 0.018);
  leverBack.translate(handleX - 0.035, handleY + 0.025, -thickness / 2 - 0.025);
  brassGeos.push(leverBack);

  // Brass hinges on left edge
  for (const hy of [-0.55, 0.55]) {
    const hinge = new THREE.CylinderGeometry(0.009, 0.009, 0.08, 8);
    hinge.translate(-width / 2 + 0.004, hy, 0);
    brassGeos.push(hinge);
  }

  const mergedWood = mergeGeometries(woodGeos)!;
  woodGeos.forEach((g) => g.dispose());

  const mergedGlass = mergeGeometries(glassGeos)!;
  glassGeos.forEach((g) => g.dispose());

  const mergedBrass = mergeGeometries(brassGeos)!;
  brassGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWood, mergedGlass, mergedBrass], true)!;
  mergedWood.dispose();
  mergedGlass.dispose();
  mergedBrass.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodCharcoal, BUILDING_MATERIALS.windowGlass, BUILDING_MATERIALS.brassHardware],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 4. Colonial 6-Panel Door Frame (1x2m) in warm cream / ivory wood with Classical Georgian Architrave Casing
 */
function buildColonial6PanelDoorFrameGeometry(): PieceMeshTemplate {
  const width = 1.0;
  const height = MODULE_SIZE;
  const frameD = WALL_THICKNESS;
  const casingD = WALL_THICKNESS + 0.050; // Deep classical relief

  const headerH = 0.12;
  const jambW = 0.08;
  const openingW = width - jambW * 2;
  const openingH = height - headerH;

  const geos: THREE.BufferGeometry[] = [];

  // 1. Inner Core Frame (Jambs & Header)
  const header = new THREE.BoxGeometry(width, headerH, frameD);
  header.translate(0, height / 2 - headerH / 2, 0);
  geos.push(header);

  const leftJamb = new THREE.BoxGeometry(jambW, openingH, frameD);
  leftJamb.translate(-width / 2 + jambW / 2, -height / 2 + openingH / 2, 0);
  geos.push(leftJamb);

  const rightJamb = new THREE.BoxGeometry(jambW, openingH, frameD);
  rightJamb.translate(width / 2 - jambW / 2, -height / 2 + openingH / 2, 0);
  geos.push(rightJamb);

  // Door stop bead
  const stopD = 0.03;
  const stopW = 0.02;
  const topStop = new THREE.BoxGeometry(openingW, stopW, stopD);
  topStop.translate(0, -height / 2 + openingH - stopW / 2, 0);
  geos.push(topStop);

  const leftStop = new THREE.BoxGeometry(stopW, openingH, stopD);
  leftStop.translate(-openingW / 2 + stopW / 2, -height / 2 + openingH / 2, 0);
  geos.push(leftStop);

  const rightStop = new THREE.BoxGeometry(stopW, openingH, stopD);
  rightStop.translate(openingW / 2 - stopW / 2, -height / 2 + openingH / 2, 0);
  geos.push(rightStop);

  // 2. CLASSICAL ARCHITRAVE CASINGS (Top, Left, Right surrounding doorway)
  const casingW = 0.085;
  const plinthH = 0.25;
  const plinthW = 0.092;
  const plinthD = casingD + 0.020;

  // --- A. Left Architrave Casing Leg (Зліва - Fluted Pilaster Style) ---
  const legH = openingH - plinthH;
  const legCenterY = -height / 2 + plinthH + legH / 2;
  const leftCasingX = -openingW / 2 - casingW / 2;

  const leftCasing = new THREE.BoxGeometry(casingW, legH, casingD);
  leftCasing.translate(leftCasingX, legCenterY, 0);
  geos.push(leftCasing);

  // Double flute / stepped reed profiles on left leg
  for (const offset of [-0.022, 0.022]) {
    const reed = new THREE.BoxGeometry(0.016, legH - 0.02, casingD + 0.010);
    reed.translate(leftCasingX + offset, legCenterY, 0);
    geos.push(reed);
  }

  // Left Classical Plinth Block (Опорний плінт)
  const leftPlinth = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
  leftPlinth.translate(-openingW / 2 - plinthW / 2 + 0.003, -height / 2 + plinthH / 2, 0);
  geos.push(leftPlinth);

  // --- B. Right Architrave Casing Leg (Справа - Fluted Pilaster Style) ---
  const rightCasingX = openingW / 2 + casingW / 2;

  const rightCasing = new THREE.BoxGeometry(casingW, legH, casingD);
  rightCasing.translate(rightCasingX, legCenterY, 0);
  geos.push(rightCasing);

  // Double flute / stepped reed profiles on right leg
  for (const offset of [-0.022, 0.022]) {
    const reed = new THREE.BoxGeometry(0.016, legH - 0.02, casingD + 0.010);
    reed.translate(rightCasingX + offset, legCenterY, 0);
    geos.push(reed);
  }

  // Right Classical Plinth Block (Опорний плінт)
  const rightPlinth = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
  rightPlinth.translate(openingW / 2 + plinthW / 2 - 0.003, -height / 2 + plinthH / 2, 0);
  geos.push(rightPlinth);

  // --- C. Classical Corner Rosette Blocks (Кутові розетки / капітелі) ---
  const rosetteSize = 0.088;
  const rosetteD = casingD + 0.014;
  const rosetteY = -height / 2 + openingH + rosetteSize / 2;

  const leftRosette = new THREE.BoxGeometry(rosetteSize, rosetteSize, rosetteD);
  leftRosette.translate(leftCasingX, rosetteY, 0);
  geos.push(leftRosette);

  const rightRosette = new THREE.BoxGeometry(rosetteSize, rosetteSize, rosetteD);
  rightRosette.translate(rightCasingX, rosetteY, 0);
  geos.push(rightRosette);

  // --- D. Top Architrave Header / Classical Entablature (Зверху) ---
  const headerFriezeH = 0.088;
  const headerFriezeY = rosetteY;
  const headerFriezeW = openingW; // Spanning between corner rosette blocks

  const headerFrieze = new THREE.BoxGeometry(headerFriezeW, headerFriezeH, casingD);
  headerFrieze.translate(0, headerFriezeY, 0);
  geos.push(headerFrieze);

  // Stepped architrave lower bead
  const lowerBead = new THREE.BoxGeometry(width + 0.04, 0.016, casingD + 0.012);
  lowerBead.translate(0, -height / 2 + openingH + 0.008, 0);
  geos.push(lowerBead);

  // Classical Cyma Crown Cornice (Класичний карниз з виступом)
  const crownH = 0.032;
  const crownW = width + 0.08;
  const crownD = casingD + 0.032;
  const crownY = rosetteY + rosetteSize / 2 + crownH / 2;
  const topCrown = new THREE.BoxGeometry(crownW, crownH, crownD);
  topCrown.translate(0, crownY, 0);
  geos.push(topCrown);

  // Top entablature cap ledge
  const topCap = new THREE.BoxGeometry(crownW + 0.024, 0.014, crownD + 0.014);
  topCap.translate(0, crownY + crownH / 2 + 0.007, 0);
  geos.push(topCap);

  // --- E. Threshold Sill (Поріг) ---
  const threshH = 0.02;
  const threshW = openingW + 0.02;
  const threshD = frameD + 0.02;
  const thresh = new THREE.BoxGeometry(threshW, threshH, threshD);
  thresh.translate(0, -height / 2 + threshH / 2, 0);
  geos.push(thresh);

  const finalGeo = mergeGeometries(geos)!;
  geos.forEach((g) => g.dispose());
  if (finalGeo.groups.length === 0 && finalGeo.index) {
    finalGeo.addGroup(0, finalGeo.index.count, 0);
  }

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodCream],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 4b. Colonial 6-Panel Door Leaf (3 rows x 2 columns of raised panels, brass knob)
 * Mathematically aligned with stiles, vertical mullion, 4 horizontal rails, and 6 raised panels.
 */
function buildColonial6PanelDoorLeaf(): PieceMeshTemplate {
  const creamGeos: THREE.BufferGeometry[] = [];
  const brassGeos: THREE.BufferGeometry[] = [];

  const width = 0.84;
  const height = 1.88;
  const thickness = 0.048;

  const stileW = 0.10;
  const midMullionW = 0.08;
  const panelW = (width - stileW * 2 - midMullionW) / 2; // 0.28m
  const colX = [-0.18, 0.18]; // Left column center -0.18, Right column center +0.18

  // Outer Stiles
  const leftStile = new THREE.BoxGeometry(stileW, height, thickness);
  leftStile.translate(-width / 2 + stileW / 2, 0, 0);
  creamGeos.push(leftStile);

  const rightStile = new THREE.BoxGeometry(stileW, height, thickness);
  rightStile.translate(width / 2 - stileW / 2, 0, 0);
  creamGeos.push(rightStile);

  // Rails spanning between outer stiles (width = 0.64m)
  const innerW = width - stileW * 2; // 0.64m

  const topRailH = 0.12;
  const topRail = new THREE.BoxGeometry(innerW, topRailH, thickness);
  topRail.translate(0, height / 2 - topRailH / 2, 0); // Y: 0.82 to 0.94, center 0.88
  creamGeos.push(topRail);

  const botRailH = 0.20;
  const botRail = new THREE.BoxGeometry(innerW, botRailH, thickness);
  botRail.translate(0, -height / 2 + botRailH / 2, 0); // Y: -0.94 to -0.74, center -0.84
  creamGeos.push(botRail);

  // Intermediate Cross Rail (between Tier 1 and Tier 2)
  const rail1H = 0.07;
  const rail1Y = 0.44; // Y: 0.405 to 0.475
  const rail1 = new THREE.BoxGeometry(innerW, rail1H, thickness);
  rail1.translate(0, rail1Y, 0);
  creamGeos.push(rail1);

  // Lock Rail (between Tier 2 and Tier 3)
  const lockRailH = 0.12;
  const lockRailY = -0.10; // Y: -0.16 to -0.04
  const lockRail = new THREE.BoxGeometry(innerW, lockRailH, thickness);
  lockRail.translate(0, lockRailY, 0);
  creamGeos.push(lockRail);

  // Center vertical mullion (between top rail and bottom rail)
  const mullionH = (height / 2 - topRailH) - (-height / 2 + botRailH); // 0.82 - (-0.74) = 1.56m
  const mullionY = ((height / 2 - topRailH) + (-height / 2 + botRailH)) / 2; // 0.04m
  const centerMullion = new THREE.BoxGeometry(midMullionW, mullionH, thickness);
  centerMullion.translate(0, mullionY, 0);
  creamGeos.push(centerMullion);

  // 6 Panels in 3 Tiers (mathematically fitted flush between rails and mullion)
  const panelSpecs = [
    { y: 0.6475, h: 0.345 }, // Tier 1 (top): Y from 0.475 to 0.82
    { y: 0.1825, h: 0.445 }, // Tier 2 (middle): Y from -0.04 to 0.405
    { y: -0.450, h: 0.580 }, // Tier 3 (bottom): Y from -0.74 to -0.16
  ];

  for (const cx of colX) {
    for (const spec of panelSpecs) {
      // Recessed field
      const groove = new THREE.BoxGeometry(panelW, spec.h, thickness * 0.55);
      groove.translate(cx, spec.y, 0);
      creamGeos.push(groove);

      // Raised center bevel field with classic colonial ovolo profile
      const raisedField = new THREE.BoxGeometry(panelW - 0.04, spec.h - 0.04, thickness * 0.92);
      raisedField.translate(cx, spec.y, 0);
      creamGeos.push(raisedField);
    }
  }

  // Polished Brass Round Knob & Rosettes
  const knobX = width / 2 - 0.085;
  const knobY = lockRailY; // Centered on the lock rail

  const rosetteFront = new THREE.CylinderGeometry(0.026, 0.026, 0.006, 12);
  rosetteFront.rotateX(Math.PI / 2);
  rosetteFront.translate(knobX, knobY, thickness / 2 + 0.003);
  brassGeos.push(rosetteFront);

  const rosetteBack = new THREE.CylinderGeometry(0.026, 0.026, 0.006, 12);
  rosetteBack.rotateX(Math.PI / 2);
  rosetteBack.translate(knobX, knobY, -thickness / 2 - 0.003);
  brassGeos.push(rosetteBack);

  const knobFront = new THREE.SphereGeometry(0.024, 10, 8);
  knobFront.translate(knobX, knobY, thickness / 2 + 0.028);
  brassGeos.push(knobFront);

  const knobBack = new THREE.SphereGeometry(0.024, 10, 8);
  knobBack.translate(knobX, knobY, -thickness / 2 - 0.028);
  brassGeos.push(knobBack);

  // Brass hinges on left edge
  for (const hy of [-0.55, 0.55]) {
    const hinge = new THREE.CylinderGeometry(0.009, 0.009, 0.08, 8);
    hinge.translate(-width / 2 + 0.004, hy, 0);
    brassGeos.push(hinge);
  }

  const mergedCream = mergeGeometries(creamGeos)!;
  creamGeos.forEach((g) => g.dispose());

  const mergedBrass = mergeGeometries(brassGeos)!;
  brassGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedCream, mergedBrass], true)!;
  mergedCream.dispose();
  mergedBrass.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodCream, BUILDING_MATERIALS.brassHardware],
    boundingBox: new THREE.Box3(),
  };
}

function buildTemplateForPiece(type: BuildingPieceType): PieceMeshTemplate {
  switch (type) {
    case BuildingPieceType.GLASS_WALL_2X3:
      return buildGreenhouseWallGeometry(MODULE_SIZE, 3.0);
    case BuildingPieceType.GLASS_WALL_1X3:
      return buildGreenhouseWallGeometry(1.0, 3.0);
    case BuildingPieceType.GLASS_DOORWAY_1X3:
      return buildGreenhouseWallGeometry(1.0, 3.0, true);
    case BuildingPieceType.GLASS_DOOR_1X3:
      return buildGreenhouseDoorGeometry();
    case BuildingPieceType.GLASS_ROOF_GABLE_2X2:
    case BuildingPieceType.GLASS_ROOF_SHED_2X2: {
      // Real glasshouse roof mesh: [glass, wooden glazing frame]
      const geo = createRoofGeometry(type, getDefaultRoofConfig(type));
      return {
        geometry: geo,
        materials: [BUILDING_MATERIALS.greenhouseGlass, BUILDING_MATERIALS.greenhouseFrame],
        boundingBox: new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute),
      };
    }

    case BuildingPieceType.DOOR_GRAND_SIDELITES_2X2: {
      const outerFrameTpl = buildGrandSideliteDoorFrameGeometry();
      const leafTpl = buildGrandMahoganyDoorLeaf();

      const leafGeo = leafTpl.geometry.clone();
      leafGeo.translate(0, -0.04, 0);

      const mergedGeo = mergeGeometries([outerFrameTpl.geometry.clone(), leafGeo], true)!;
      leafGeo.dispose();

      return {
        geometry: mergedGeo,
        materials: [
          BUILDING_MATERIALS.woodMahogany,
          BUILDING_MATERIALS.windowGlass,
          BUILDING_MATERIALS.woodMahogany,
          BUILDING_MATERIALS.bronzeHardware,
        ],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.DOOR_WHITE_2PANEL_1X2: {
      const outerFrameTpl = buildWhite2PanelDoorFrameGeometry();
      const leafTpl = buildWhite2PanelDoorLeaf();

      const leafGeo = leafTpl.geometry.clone();
      leafGeo.translate(0, -0.06, 0);

      const mergedGeo = mergeGeometries([outerFrameTpl.geometry.clone(), leafGeo], true)!;
      leafGeo.dispose();

      return {
        geometry: mergedGeo,
        materials: [BUILDING_MATERIALS.woodWhiteDoor, BUILDING_MATERIALS.woodWhiteDoor, BUILDING_MATERIALS.brassHardware],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2: {
      const outerFrameTpl = buildCottageWindowDoorFrameGeometry();
      const leafTpl = buildCottageWindowDoorLeaf();

      const leafGeo = leafTpl.geometry.clone();
      leafGeo.translate(0, -0.06, 0);

      const mergedGeo = mergeGeometries([outerFrameTpl.geometry.clone(), leafGeo], true)!;
      leafGeo.dispose();

      return {
        geometry: mergedGeo,
        materials: [
          BUILDING_MATERIALS.woodCharcoal,
          BUILDING_MATERIALS.woodCharcoal,
          BUILDING_MATERIALS.windowGlass,
          BUILDING_MATERIALS.brassHardware,
        ],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2: {
      const outerFrameTpl = buildColonial6PanelDoorFrameGeometry();
      const leafTpl = buildColonial6PanelDoorLeaf();

      const leafGeo = leafTpl.geometry.clone();
      leafGeo.translate(0, -0.06, 0);

      const mergedGeo = mergeGeometries([outerFrameTpl.geometry.clone(), leafGeo], true)!;
      leafGeo.dispose();

      return {
        geometry: mergedGeo,
        materials: [BUILDING_MATERIALS.woodCream, BUILDING_MATERIALS.woodCream, BUILDING_MATERIALS.brassHardware],
        boundingBox: new THREE.Box3(),
      };
    }
    case BuildingPieceType.WOOD_WALL_DOORWAY_2X2: {
      return buildDoorwayWallGeometry(MODULE_SIZE, MODULE_SIZE);
    }

    case BuildingPieceType.WOOD_WALL_DOORWAY_1X2: {
      return buildDoorwayWallGeometry(1.0, MODULE_SIZE);
    }

    case BuildingPieceType.WOOD_DOOR_SINGLE: {
      const outerFrameTpl = buildOuterDoorFrameGeometry(1.0, MODULE_SIZE);
      const leafTpl = buildSingleDoorGeometry();

      const leafGeo = leafTpl.geometry.clone();
      leafGeo.translate(0, -0.06, 0);

      const mergedGeo = mergeGeometries([outerFrameTpl.geometry.clone(), leafGeo], true)!;
      leafGeo.dispose();

      return {
        geometry: mergedGeo,
        materials: [BUILDING_MATERIALS.woodDark, BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_DOOR_DOUBLE: {
      const outerFrameTpl = buildOuterDoorFrameGeometry(MODULE_SIZE, MODULE_SIZE);
      const doubleLeafTpl = buildDoubleDoorGeometry();

      const leavesGeo = doubleLeafTpl.geometry.clone();
      leavesGeo.translate(0, -0.06, 0);

      const mergedGeo = mergeGeometries([outerFrameTpl.geometry.clone(), leavesGeo], true)!;
      leavesGeo.dispose();

      return {
        geometry: mergedGeo,
        materials: [BUILDING_MATERIALS.woodDark, BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
        boundingBox: new THREE.Box3(),
      };
    }
    case BuildingPieceType.WOOD_FLOOR_2X2: {
      // Clean, simple floor slab geometry with checker parquet texture
      const floorGeo = new THREE.BoxGeometry(MODULE_SIZE, FLOOR_THICKNESS, MODULE_SIZE);
      return {
        geometry: floorGeo,
        materials: [BUILDING_MATERIALS.floorChecker],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_FLOOR_1X1: {
      const floorGeo = new THREE.BoxGeometry(1.0, FLOOR_THICKNESS, 1.0);
      return {
        geometry: floorGeo,
        materials: [BUILDING_MATERIALS.floorChecker],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_WALL_2X3: {
      const wallGeo = new THREE.BoxGeometry(MODULE_SIZE, 3.0, WALL_THICKNESS);
      return {
        geometry: wallGeo,
        materials: [BUILDING_MATERIALS.wallChecker],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_WALL_1X3: {
      // Simple clean wall geometry with checker texture (Heartopia style)
      const wallGeo = new THREE.BoxGeometry(1.0, 3.0, WALL_THICKNESS);
      return {
        geometry: wallGeo,
        materials: [BUILDING_MATERIALS.wallChecker],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_WALL_1X2: {
      const width = 1.0;
      const wallGeo = new THREE.BoxGeometry(width, MODULE_SIZE, WALL_THICKNESS);
      return {
        geometry: wallGeo,
        materials: [BUILDING_MATERIALS.wallChecker],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_WALL_2X1: {
      const height = 1.0;
      const width = MODULE_SIZE;
      const wallGeo = new THREE.BoxGeometry(width, height, WALL_THICKNESS);
      return {
        geometry: wallGeo,
        materials: [BUILDING_MATERIALS.wallChecker],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_WALL_1X1: {
      const wallGeo = new THREE.BoxGeometry(1.0, 1.0, WALL_THICKNESS);
      return {
        geometry: wallGeo,
        materials: [BUILDING_MATERIALS.wallChecker],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_WALL_WINDOW_2X2: {
      return buildWindowPieceGeometry(MODULE_SIZE, MODULE_SIZE);
    }

    case BuildingPieceType.WOOD_WALL_WINDOW_2X4: {
      return buildWindowPieceGeometry(MODULE_SIZE, 4.0);
    }

    case BuildingPieceType.WOOD_WALL_WINDOW_1X2: {
      return buildWindowPieceGeometry(1.0, MODULE_SIZE);
    }

    case BuildingPieceType.WOOD_WALL_WINDOW_1X1_5: {
      return buildWindowPieceGeometry(1.0, 1.5);
    }

    case BuildingPieceType.WOOD_STAIRS_2X2: {
      const stepCount = 5;
      const stepH = MODULE_SIZE / stepCount;
      const stepD = MODULE_SIZE / stepCount;
      const stairWidth = MODULE_SIZE - 0.20;

      // 1. Wood steps
      const stepGeos: THREE.BufferGeometry[] = [];
      for (let i = 0; i < stepCount; i++) {
        const step = new THREE.BoxGeometry(stairWidth, stepH, stepD * 1.05);
        const y = -HALF_SIZE + (i + 0.5) * stepH;
        const z = -HALF_SIZE + (i + 0.5) * stepD;
        step.translate(0, y, z);
        stepGeos.push(step);
      }
      const mergedWood = mergeGeometries(stepGeos)!;
      stepGeos.forEach((g) => g.dispose());

      // 2. Dark wood stringers
      const stringerLength = Math.sqrt(2) * MODULE_SIZE;
      const stGeo = new THREE.BoxGeometry(0.12, 0.28, stringerLength);

      const stLeft = stGeo.clone();
      stLeft.rotateX(-Math.PI / 4);
      stLeft.translate(-HALF_SIZE + 0.06, 0, 0);

      const stRight = stGeo.clone();
      stRight.rotateX(-Math.PI / 4);
      stRight.translate(HALF_SIZE - 0.06, 0, 0);
      stGeo.dispose();

      const mergedDark = mergeGeometries([stLeft, stRight])!;
      stLeft.dispose();
      stRight.dispose();

      const finalGeo = mergeGeometries([mergedWood, mergedDark], true)!;
      mergedWood.dispose();
      mergedDark.dispose();

      return {
        geometry: finalGeo,
        materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_STAIRS_2X1: {
      const stepCount = 3;
      const stairH = 1.0;
      const stepH = stairH / stepCount;
      const stepD = MODULE_SIZE / stepCount;
      const stairWidth = MODULE_SIZE - 0.20;

      // 1. Wood steps (height = 1.0, centered from -0.5 to +0.5)
      const stepGeos: THREE.BufferGeometry[] = [];
      for (let i = 0; i < stepCount; i++) {
        const step = new THREE.BoxGeometry(stairWidth, stepH, stepD * 1.05);
        const y = -0.5 + (i + 0.5) * stepH;
        const z = -HALF_SIZE + (i + 0.5) * stepD;
        step.translate(0, y, z);
        stepGeos.push(step);
      }
      const mergedWood = mergeGeometries(stepGeos)!;
      stepGeos.forEach((g) => g.dispose());

      // 2. Dark wood stringers (slope = atan2(1, 2) ≈ 26.56°)
      const stringerLength = Math.sqrt(MODULE_SIZE * MODULE_SIZE + stairH * stairH);
      const stairAngle = Math.atan2(stairH, MODULE_SIZE);
      const stGeo = new THREE.BoxGeometry(0.12, 0.22, stringerLength);

      const stLeft = stGeo.clone();
      stLeft.rotateX(-stairAngle);
      stLeft.translate(-HALF_SIZE + 0.06, 0, 0);

      const stRight = stGeo.clone();
      stRight.rotateX(-stairAngle);
      stRight.translate(HALF_SIZE - 0.06, 0, 0);
      stGeo.dispose();

      const mergedDark = mergeGeometries([stLeft, stRight])!;
      stLeft.dispose();
      stRight.dispose();

      const finalGeo = mergeGeometries([mergedWood, mergedDark], true)!;
      mergedWood.dispose();
      mergedDark.dispose();

      return {
        geometry: finalGeo,
        materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_STAIRS_2X3: {
      const stepCount = 8;
      const stairH = 3.0;
      const stairL = 3.0;
      const stepH = stairH / stepCount; // 0.375m
      const stepD = stairL / stepCount; // 0.375m -> 45 degree slope matching 2x2
      const stairWidth = MODULE_SIZE - 0.20;

      // 1. Wood steps (height = 3.0, centered from -1.5 to +1.5; depth = 3.0, centered from -1.5 to +1.5)
      const stepGeos: THREE.BufferGeometry[] = [];
      for (let i = 0; i < stepCount; i++) {
        const step = new THREE.BoxGeometry(stairWidth, stepH, stepD * 1.05);
        const y = -1.5 + (i + 0.5) * stepH;
        const z = -1.5 + (i + 0.5) * stepD;
        step.translate(0, y, z);
        stepGeos.push(step);
      }
      const mergedWood = mergeGeometries(stepGeos)!;
      stepGeos.forEach((g) => g.dispose());

      // 2. Dark wood stringers (slope = 45° -> rotateX(-Math.PI / 4))
      const stringerLength = Math.sqrt(stairL * stairL + stairH * stairH);
      const stGeo = new THREE.BoxGeometry(0.12, 0.32, stringerLength);

      const stLeft = stGeo.clone();
      stLeft.rotateX(-Math.PI / 4);
      stLeft.translate(-HALF_SIZE + 0.06, 0, 0);

      const stRight = stGeo.clone();
      stRight.rotateX(-Math.PI / 4);
      stRight.translate(HALF_SIZE - 0.06, 0, 0);
      stGeo.dispose();

      const mergedDark = mergeGeometries([stLeft, stRight])!;
      stLeft.dispose();
      stRight.dispose();

      const finalGeo = mergeGeometries([mergedWood, mergedDark], true)!;
      mergedWood.dispose();
      mergedDark.dispose();

      return {
        geometry: finalGeo,
        materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_ROOF_26: {
      const roofAngle = Math.atan2(0.9, MODULE_SIZE);
      const roofPlaneLen = Math.sqrt(MODULE_SIZE * MODULE_SIZE + 0.9 * 0.9);

      // 1. Thatch roof plane
      const roofGeo = new THREE.BoxGeometry(MODULE_SIZE, 0.12, roofPlaneLen);
      roofGeo.rotateX(-roofAngle);

      // 2. Dark wood rafters, ridge, and eave
      const rafterGeo = new THREE.BoxGeometry(0.14, 0.16, roofPlaneLen);

      const r1 = rafterGeo.clone();
      r1.rotateX(-roofAngle);
      r1.translate(-HALF_SIZE + 0.1, -0.06, 0);

      const r2 = rafterGeo.clone();
      r2.rotateX(-roofAngle);
      r2.translate(HALF_SIZE - 0.1, -0.06, 0);
      rafterGeo.dispose();

      const ridge = new THREE.BoxGeometry(MODULE_SIZE, 0.14, 0.14);
      ridge.translate(0, 0.45, HALF_SIZE);

      const eave = new THREE.BoxGeometry(MODULE_SIZE, 0.14, 0.12);
      eave.translate(0, -0.45, -HALF_SIZE);

      const mergedDark = mergeGeometries([r1, r2, ridge, eave])!;
      r1.dispose();
      r2.dispose();
      ridge.dispose();
      eave.dispose();

      const finalGeo = mergeGeometries([roofGeo, mergedDark], true)!;
      roofGeo.dispose();
      mergedDark.dispose();

      return {
        geometry: finalGeo,
        materials: [BUILDING_MATERIALS.roof, BUILDING_MATERIALS.woodDark],
        boundingBox: new THREE.Box3(),
      };
    }

    // =========================================================================
    // 2-PITCHED GABLE, HIP & 1-PITCHED SHED ROOFS (SIMS 4 PROCEDURAL)
    // =========================================================================
    case BuildingPieceType.ROOF_GABLE_2X2:
    case BuildingPieceType.ROOF_GABLE_2X4:
    case BuildingPieceType.ROOF_GABLE_4X4:
    case BuildingPieceType.ROOF_HIP_2X2:
    case BuildingPieceType.ROOF_HIP_2X4:
    case BuildingPieceType.ROOF_HIP_4X4:
    case BuildingPieceType.ROOF_SHED_2X2:
    case BuildingPieceType.ROOF_SHED_2X4:
    case BuildingPieceType.ROOF_SHED_4X4: {
      const geo = ProceduralRoofGenerator.createBufferGeometry(getDefaultRoofConfig(type));
      return {
        geometry: geo,
        materials: [BUILDING_MATERIALS.roofHeartopia, BUILDING_MATERIALS.roofTrim, BUILDING_MATERIALS.roofGableWall],
        boundingBox: new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute),
      };
    }

    case BuildingPieceType.WOOD_POLE_2M: {
      const poleGeo = new THREE.CylinderGeometry(0.12, 0.12, MODULE_SIZE, 8);
      return {
        geometry: poleGeo,
        materials: [BUILDING_MATERIALS.wood],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.CHECKER_PILLAR_1M: {
      const pillarGeo = new THREE.BoxGeometry(0.4, 1.0, 0.4);
      return {
        geometry: pillarGeo,
        materials: [BUILDING_MATERIALS.pillarChecker],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.CORNER_RUSTICATED_QUOIN_1M: {
      const geoms: THREE.BufferGeometry[] = [];
      const courseH = 0.23;
      const gap = 0.02;
      const reliefT = 0.04; // 4cm subtle facade relief (does not excessively protrude)
      const wallHalfT = WALL_THICKNESS / 2.0; // 0.08m - outer wall boundary

      for (let i = 0; i < 4; i++) {
        const yCenter = -0.375 + i * (courseH + gap);
        const isXLong = i % 2 === 0;

        // Alternating wing lengths along the corner facades
        const lenX = isXLong ? 0.28 : 0.15;
        const lenZ = isXLong ? 0.15 : 0.28;

        // Wing along X facade (hugs exterior face Z in [wallHalfT, wallHalfT + reliefT])
        const boxX = new THREE.BoxGeometry(lenX, courseH, reliefT);
        boxX.translate((wallHalfT + reliefT) - lenX / 2.0, yCenter, wallHalfT + reliefT / 2.0);
        geoms.push(boxX);

        // Wing along Z facade (hugs exterior face X in [wallHalfT, wallHalfT + reliefT])
        const boxZ = new THREE.BoxGeometry(reliefT, courseH, lenZ);
        boxZ.translate(wallHalfT + reliefT / 2.0, yCenter, wallHalfT - lenZ / 2.0);
        geoms.push(boxZ);
      }

      const merged = mergeGeometries(geoms, false);
      return {
        geometry: merged || new THREE.BoxGeometry(0.3, 1.0, 0.3),
        materials: [BUILDING_MATERIALS.rusticatedStone],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.STONE_FOUNDATION_2X2: {
      const stoneGeo = new THREE.BoxGeometry(MODULE_SIZE, 1.0, MODULE_SIZE);
      return {
        geometry: stoneGeo,
        materials: [BUILDING_MATERIALS.stone],
        boundingBox: new THREE.Box3(),
      };
    }

    case BuildingPieceType.WOOD_RAILING_2M: {
      return buildStraightRailingGeometry(MODULE_SIZE, 0.95);
    }

    case BuildingPieceType.WOOD_RAILING_1M: {
      return buildStraightRailingGeometry(1.0, 0.95);
    }

    case BuildingPieceType.WOOD_STAIR_RAILING_2X2: {
      return buildStairRailingGeometry();
    }

    case BuildingPieceType.WHITE_DECORATIVE_FENCE_1M: {
      return buildWhiteDecorativeFenceGeometry();
    }
  }
}

/**
 * Builds stylized straight wood railing geometry with end/center newel posts,
 * top handrail, bottom rail, and vertical baluster pickets.
 */
function buildStraightRailingGeometry(width: number, height: number = 0.95): PieceMeshTemplate {
  const woodGeos: THREE.BufferGeometry[] = [];
  const darkGeos: THREE.BufferGeometry[] = [];

  const postThickness = 0.08;
  const postHalfW = width / 2.0 - postThickness / 2.0;

  // 1. End posts (newel posts)
  const postLeft = new THREE.BoxGeometry(postThickness, height, postThickness);
  postLeft.translate(-postHalfW, 0, 0);
  darkGeos.push(postLeft);

  const postRight = new THREE.BoxGeometry(postThickness, height, postThickness);
  postRight.translate(postHalfW, 0, 0);
  darkGeos.push(postRight);

  // Decorative post caps
  const capGeoL = new THREE.BoxGeometry(postThickness * 1.25, 0.03, postThickness * 1.25);
  capGeoL.translate(-postHalfW, height / 2.0 + 0.015, 0);
  darkGeos.push(capGeoL);

  const capGeoR = new THREE.BoxGeometry(postThickness * 1.25, 0.03, postThickness * 1.25);
  capGeoR.translate(postHalfW, height / 2.0 + 0.015, 0);
  darkGeos.push(capGeoR);

  // Center post if 2m railing
  if (width >= 1.5) {
    const postMid = new THREE.BoxGeometry(postThickness, height, postThickness);
    darkGeos.push(postMid);
    const capMid = new THREE.BoxGeometry(postThickness * 1.25, 0.03, postThickness * 1.25);
    capMid.translate(0, height / 2.0 + 0.015, 0);
    darkGeos.push(capMid);
  }

  // 2. Top handrail (поручень - profiled dark wood)
  const handrailH = 0.06;
  const handrailD = 0.10;
  const topHandrail = new THREE.BoxGeometry(width, handrailH, handrailD);
  topHandrail.translate(0, height / 2.0 - handrailH / 2.0, 0);
  darkGeos.push(topHandrail);

  // 3. Bottom rail (нижня балка - slightly raised off floor)
  const bottomRailH = 0.04;
  const bottomRailD = 0.06;
  const bottomRailY = -height / 2.0 + 0.08;
  const bottomRail = new THREE.BoxGeometry(width - 0.02, bottomRailH, bottomRailD);
  bottomRail.translate(0, bottomRailY, 0);
  woodGeos.push(bottomRail);

  // 4. Vertical balusters (балясини)
  const balusterH = (height / 2.0 - handrailH) - (bottomRailY + bottomRailH / 2.0);
  const balusterY = bottomRailY + bottomRailH / 2.0 + balusterH / 2.0;
  const balusterThick = 0.035;

  if (width >= 1.5) {
    // 3 balusters on left span, 3 on right span
    const halfSpan = width / 2.0 - postThickness;
    const subStep = halfSpan / 4.0;
    for (let i = 1; i <= 3; i++) {
      const bL = new THREE.BoxGeometry(balusterThick, balusterH, balusterThick);
      bL.translate(-postThickness / 2.0 - i * subStep, balusterY, 0);
      woodGeos.push(bL);

      const bR = new THREE.BoxGeometry(balusterThick, balusterH, balusterThick);
      bR.translate(postThickness / 2.0 + i * subStep, balusterY, 0);
      woodGeos.push(bR);
    }
  } else {
    // 3 balusters evenly spaced on 1m railing
    const span = width - postThickness * 2;
    const subStep = span / 4.0;
    for (let i = 1; i <= 3; i++) {
      const bx = -postHalfW + i * subStep;
      const b = new THREE.BoxGeometry(balusterThick, balusterH, balusterThick);
      b.translate(bx, balusterY, 0);
      woodGeos.push(b);
    }
  }

  const mergedWood = mergeGeometries(woodGeos)!;
  woodGeos.forEach((g) => g.dispose());

  const mergedDark = mergeGeometries(darkGeos)!;
  darkGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWood, mergedDark], true)!;
  mergedWood.dispose();
  mergedDark.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * Builds stylized 45-degree sloped stair railing geometry for WOOD_STAIRS_2X2.
 * Mounts flush to stair sockets side_left and side_right.
 */
function buildStairRailingGeometry(): PieceMeshTemplate {
  const woodGeos: THREE.BufferGeometry[] = [];
  const darkGeos: THREE.BufferGeometry[] = [];

  const slopeLength = Math.sqrt(2) * MODULE_SIZE; // 2.828m
  const postThickness = 0.08;

  // 1. Bottom newel post at landing foot (z = -HALF_SIZE = -1.0, y goes from -1.0 to 0.0)
  const postBot = new THREE.BoxGeometry(postThickness, 1.0, postThickness);
  postBot.translate(0, -0.5, -HALF_SIZE);
  darkGeos.push(postBot);

  const capBot = new THREE.BoxGeometry(postThickness * 1.25, 0.03, postThickness * 1.25);
  capBot.translate(0, 0.015, -HALF_SIZE);
  darkGeos.push(capBot);

  // 2. Top newel post at top landing (z = HALF_SIZE = 1.0, y goes from 1.0 to 2.0)
  const postTop = new THREE.BoxGeometry(postThickness, 1.0, postThickness);
  postTop.translate(0, 1.5, HALF_SIZE);
  darkGeos.push(postTop);

  const capTop = new THREE.BoxGeometry(postThickness * 1.25, 0.03, postThickness * 1.25);
  capTop.translate(0, 2.015, HALF_SIZE);
  darkGeos.push(capTop);

  // 3. Middle newel post at half-flight (z = 0, y goes from 0.0 to 1.0)
  const postMid = new THREE.BoxGeometry(postThickness, 1.0, postThickness);
  postMid.translate(0, 0.5, 0);
  darkGeos.push(postMid);

  const capMid = new THREE.BoxGeometry(postThickness * 1.25, 0.03, postThickness * 1.25);
  capMid.translate(0, 1.015, 0);
  darkGeos.push(capMid);

  // 4. Slanted top handrail (angle = -45 deg, connecting post tops from y=0 to y=2)
  const handrailH = 0.06;
  const handrailD = 0.10;
  const handrail = new THREE.BoxGeometry(handrailD, handrailH, slopeLength * 1.02);
  handrail.rotateX(-Math.PI / 4);
  handrail.translate(0, 1.0 - handrailH / 2.0, 0);
  darkGeos.push(handrail);

  // 5. Slanted bottom rail (parallel to handrail, ~0.25 above step line)
  const botRailH = 0.04;
  const botRailD = 0.06;
  const botRail = new THREE.BoxGeometry(botRailD, botRailH, slopeLength * 1.02);
  botRail.rotateX(-Math.PI / 4);
  botRail.translate(0, 0.25, 0);
  woodGeos.push(botRail);

  // 6. Vertical balusters for steps (5 steps along the run)
  const balusterThick = 0.035;
  const stepCount = 5;
  const stepD = MODULE_SIZE / stepCount; // 0.4m

  for (let i = 0; i < stepCount; i++) {
    // Skip i = 2 because middle post is at z = 0
    if (i === 2) continue;
    const z = -HALF_SIZE + (i + 0.5) * stepD;
    const stepCenterY = z; // on 45-degree slope, y = z
    const balusterBotY = stepCenterY + 0.25 + botRailH / 2.0;
    const balusterTopY = stepCenterY + 1.0 - handrailH;
    const bH = balusterTopY - balusterBotY;

    const baluster = new THREE.BoxGeometry(balusterThick, bH, balusterThick);
    baluster.translate(0, balusterBotY + bH / 2.0, z);
    woodGeos.push(baluster);
  }

  const mergedWood = mergeGeometries(woodGeos)!;
  woodGeos.forEach((g) => g.dispose());

  const mergedDark = mergeGeometries(darkGeos)!;
  darkGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWood, mergedDark], true)!;
  mergedWood.dispose();
  mergedDark.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * Builds a charming stylized white decorative picket fence 1x1m (Heartopia / Animal Crossing aesthetic)
 * with end newel posts with 4-sided pyramid diamond caps, bottom base plinths,
 * horizontal cross rails, and 4 vertical pickets with pointed spearhead triangular tips and rivet accents.
 */
function buildWhiteDecorativeFenceGeometry(): PieceMeshTemplate {
  const whiteGeos: THREE.BufferGeometry[] = [];
  const postGeos: THREE.BufferGeometry[] = [];
  const hardwareGeos: THREE.BufferGeometry[] = [];

  const postThickness = 0.08;
  const postHalfW = 0.5 - postThickness / 2.0; // 0.46m

  // 1. Two main end newel posts (Left at -0.46, Right at +0.46)
  for (const px of [-postHalfW, postHalfW]) {
    // Post shaft (height 0.92, from y = -0.475 to y = 0.445)
    const shaft = new THREE.BoxGeometry(postThickness, 0.92, postThickness);
    shaft.translate(px, -0.015, 0);
    postGeos.push(shaft);

    // Base plinth / foot trim
    const base = new THREE.BoxGeometry(postThickness * 1.2, 0.04, postThickness * 1.2);
    base.translate(px, -0.455, 0);
    postGeos.push(base);

    // Neck collar band
    const collar = new THREE.BoxGeometry(postThickness * 1.15, 0.02, postThickness * 1.15);
    collar.translate(px, 0.40, 0);
    postGeos.push(collar);

    // Cap base molding
    const capBase = new THREE.BoxGeometry(postThickness * 1.3, 0.025, postThickness * 1.3);
    capBase.translate(px, 0.445, 0);
    postGeos.push(capBase);

    // Pyramid diamond finial cap atop post (4-sided pyramid)
    const capTop = new THREE.CylinderGeometry(0, postThickness * 0.92, 0.07, 4);
    capTop.rotateY(Math.PI / 4); // Align pyramid faces squarely with post sides
    capTop.translate(px, 0.49, 0);
    postGeos.push(capTop);
  }

  // 2. Horizontal support crossrails (spanning between inner faces of posts, length ~0.84m)
  const railLength = 1.0 - postThickness * 2; // 0.84m
  const railH = 0.04;
  const railD = 0.034;
  const railZ = -0.014;

  const topRail = new THREE.BoxGeometry(railLength, railH, railD);
  topRail.translate(0, 0.18, railZ);
  whiteGeos.push(topRail);

  const botRail = new THREE.BoxGeometry(railLength, railH, railD);
  botRail.translate(0, -0.22, railZ);
  whiteGeos.push(botRail);

  // 3. Four vertical pickets with pointed spearhead tips (fully indexed BufferGeometries)
  const picketX = [-0.315, -0.105, 0.105, 0.315];
  const pw = 0.072;
  const pd = 0.022;
  const bodyH = 0.64;
  const tipH = 0.07; // Pointed spearhead tip

  for (const px of picketX) {
    // Picket body shaft (from y = -0.355 to y = 0.285)
    const body = new THREE.BoxGeometry(pw, bodyH, pd);
    body.translate(px, -0.035, 0.012);
    whiteGeos.push(body);

    // Spearhead 4-sided pointed tip atop picket
    const tip = new THREE.CylinderGeometry(0, pw / Math.SQRT2, tipH, 4);
    tip.rotateY(Math.PI / 4);
    tip.scale(1, 1, pd / pw);
    tip.translate(px, 0.285 + tipH / 2, 0.012);
    whiteGeos.push(tip);

    // Decorative bolt rivets at rail intersections
    for (const py of [0.18, -0.22]) {
      const bolt = new THREE.CylinderGeometry(0.005, 0.005, 0.004, 8);
      bolt.rotateX(Math.PI / 2);
      bolt.translate(px, py, 0.025);
      hardwareGeos.push(bolt);
    }
  }

  const mergedWhite = mergeGeometries(whiteGeos)!;
  whiteGeos.forEach((g) => g.dispose());

  const mergedPost = mergeGeometries(postGeos)!;
  postGeos.forEach((g) => g.dispose());

  const mergedHardware = mergeGeometries(hardwareGeos)!;
  hardwareGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWhite, mergedPost, mergedHardware], true)!;
  mergedWhite.dispose();
  mergedPost.dispose();
  mergedHardware.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.whiteWood, BUILDING_MATERIALS.whiteWoodPost, BUILDING_MATERIALS.fenceHardware],
    boundingBox: new THREE.Box3(),
  };
}

// Builder to create 3D Groups for each piece type (1 consolidated mesh per piece)
export function createPieceMeshGroup(
  type: BuildingPieceType,
  isGhost: boolean = false,
  ghostMaterial?: THREE.Material
): THREE.Group {
  const group = new THREE.Group();
  group.name = `BuildingPiece_${type}`;

  const template = getPieceMeshTemplate(type);

  // If this is a real placed door, assemble interactive hinge pivot groups with static outer frame (top, left, right)
  if (!isGhost && type === BuildingPieceType.WOOD_DOOR_SINGLE) {
    const frameTpl = buildOuterDoorFrameGeometry(1.0, MODULE_SIZE);
    const frameMesh = new THREE.Mesh(
      frameTpl.geometry,
      frameTpl.materials.length === 1 ? frameTpl.materials[0] : frameTpl.materials
    );


    group.add(frameMesh);

    const singleTemplate = buildSingleDoorGeometry();
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'doorPivot';
    pivotGroup.position.set(-0.42, 0, 0); // Hinge pivot at left jamb inner edge

    const leafMesh = new THREE.Mesh(
      singleTemplate.geometry,
      singleTemplate.materials.length === 1 ? singleTemplate.materials[0] : singleTemplate.materials
    );
    leafMesh.position.set(0.42, -0.06, 0); // Offset leaf center so it fits inside 0.84x1.88 opening


    pivotGroup.add(leafMesh);
    group.add(pivotGroup);
    return group;
  }

  if (!isGhost && type === BuildingPieceType.GLASS_DOOR_1X3) {
    // Shared cached geometry: frame stays put, the leaf swings on a hinge pivot (toggleDoor)
    ghDoorFrameTpl ??= buildGreenhouseDoorFrame();
    ghDoorLeafTpl ??= buildGreenhouseDoorLeaf();
    group.add(new THREE.Mesh(ghDoorFrameTpl.geometry, ghDoorFrameTpl.materials));
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'doorPivot';
    pivotGroup.position.set(GH_HINGE_X, 0, 0);
    const leafMesh = new THREE.Mesh(ghDoorLeafTpl.geometry, ghDoorLeafTpl.materials);
    leafMesh.position.set(-GH_HINGE_X, GH_LEAF_Y, 0);
    pivotGroup.add(leafMesh);
    group.add(pivotGroup);
    return group;
  }

  if (!isGhost && type === BuildingPieceType.WOOD_DOOR_DOUBLE) {
    const frameTpl = buildOuterDoorFrameGeometry(MODULE_SIZE, MODULE_SIZE);
    const frameMesh = new THREE.Mesh(
      frameTpl.geometry,
      frameTpl.materials.length === 1 ? frameTpl.materials[0] : frameTpl.materials
    );


    group.add(frameMesh);

    const singleTemplate = buildSingleDoorGeometry();

    // Left leaf hinge pivot
    const leftPivot = new THREE.Group();
    leftPivot.name = 'doorPivotLeft';
    leftPivot.position.set(-0.90, 0, 0);

    const leftMesh = new THREE.Mesh(
      singleTemplate.geometry,
      singleTemplate.materials.length === 1 ? singleTemplate.materials[0] : singleTemplate.materials
    );
    leftMesh.position.set(0.45, -0.06, 0);


    leftPivot.add(leftMesh);
    group.add(leftPivot);

    // Right leaf hinge pivot
    const rightPivot = new THREE.Group();
    rightPivot.name = 'doorPivotRight';
    rightPivot.position.set(0.90, 0, 0);

    const rightGeo = singleTemplate.geometry.clone();
    rightGeo.rotateY(Math.PI);
    const rightMesh = new THREE.Mesh(
      rightGeo,
      singleTemplate.materials.length === 1 ? singleTemplate.materials[0] : singleTemplate.materials
    );
    rightMesh.position.set(-0.45, -0.06, 0);


    rightPivot.add(rightMesh);
    group.add(rightPivot);

    return group;
  }

  if (!isGhost && type === BuildingPieceType.DOOR_GRAND_SIDELITES_2X2) {
    const frameTpl = buildGrandSideliteDoorFrameGeometry();
    const frameMesh = new THREE.Mesh(
      frameTpl.geometry,
      frameTpl.materials.length === 1 ? frameTpl.materials[0] : frameTpl.materials
    );


    group.add(frameMesh);

    const leafTpl = buildGrandMahoganyDoorLeaf();
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'doorPivot';
    pivotGroup.position.set(-0.44, 0, 0); // Hinge pivot at left mullion post edge of center doorway

    const leafMesh = new THREE.Mesh(
      leafTpl.geometry,
      leafTpl.materials.length === 1 ? leafTpl.materials[0] : leafTpl.materials
    );
    leafMesh.position.set(0.44, -0.04, 0);


    pivotGroup.add(leafMesh);
    group.add(pivotGroup);
    return group;
  }

  if (!isGhost && type === BuildingPieceType.DOOR_WHITE_2PANEL_1X2) {
    const frameTpl = buildWhite2PanelDoorFrameGeometry();
    const frameMesh = new THREE.Mesh(
      frameTpl.geometry,
      frameTpl.materials.length === 1 ? frameTpl.materials[0] : frameTpl.materials
    );


    group.add(frameMesh);

    const leafTpl = buildWhite2PanelDoorLeaf();
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'doorPivot';
    pivotGroup.position.set(-0.42, 0, 0);

    const leafMesh = new THREE.Mesh(
      leafTpl.geometry,
      leafTpl.materials.length === 1 ? leafTpl.materials[0] : leafTpl.materials
    );
    leafMesh.position.set(0.42, -0.06, 0);


    pivotGroup.add(leafMesh);
    group.add(pivotGroup);
    return group;
  }

  if (!isGhost && type === BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2) {
    const frameTpl = buildCottageWindowDoorFrameGeometry();
    const frameMesh = new THREE.Mesh(
      frameTpl.geometry,
      frameTpl.materials.length === 1 ? frameTpl.materials[0] : frameTpl.materials
    );


    group.add(frameMesh);

    const leafTpl = buildCottageWindowDoorLeaf();
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'doorPivot';
    pivotGroup.position.set(-0.42, 0, 0);

    const leafMesh = new THREE.Mesh(
      leafTpl.geometry,
      leafTpl.materials.length === 1 ? leafTpl.materials[0] : leafTpl.materials
    );
    leafMesh.position.set(0.42, -0.06, 0);


    pivotGroup.add(leafMesh);
    group.add(pivotGroup);
    return group;
  }

  if (!isGhost && type === BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2) {
    const frameTpl = buildColonial6PanelDoorFrameGeometry();
    const frameMesh = new THREE.Mesh(
      frameTpl.geometry,
      frameTpl.materials.length === 1 ? frameTpl.materials[0] : frameTpl.materials
    );


    group.add(frameMesh);

    const leafTpl = buildColonial6PanelDoorLeaf();
    const pivotGroup = new THREE.Group();
    pivotGroup.name = 'doorPivot';
    pivotGroup.position.set(-0.42, 0, 0);

    const leafMesh = new THREE.Mesh(
      leafTpl.geometry,
      leafTpl.materials.length === 1 ? leafTpl.materials[0] : leafTpl.materials
    );
    leafMesh.position.set(0.42, -0.06, 0);


    pivotGroup.add(leafMesh);
    group.add(pivotGroup);
    return group;
  }

  const mat = isGhost
    ? (ghostMaterial || BUILDING_MATERIALS.ghostValid)
    : (template.materials.length === 1 ? template.materials[0] : template.materials);

  const isRoof = isProceduralRoofPiece(type);
  // CRITICAL: Procedural roofs MUST have their own unique BufferGeometry instance per piece!
  // Sharing template.geometry causes procedural deformation of one roof to mutate all instances in the scene.
  const geometry = isRoof ? createRoofGeometry(type, getDefaultRoofConfig(type)) : template.geometry;

  const mesh = new THREE.Mesh(geometry, mat);


  group.add(mesh);
  return group;
}

/** Fresh per-piece roof geometry: glass roofs use the greenhouse generator, the rest the shingle one. */
export function createRoofGeometry(type: BuildingPieceType, config: Partial<ProceduralRoofConfig>): THREE.BufferGeometry {
  return isGlassRoofPiece(type)
    ? GreenhouseRoofGenerator.createGeometry(config)
    : ProceduralRoofGenerator.createBufferGeometry(config);
}

export function isProceduralRoofPiece(type: BuildingPieceType): boolean {
  if (isGlassRoofPiece(type)) return true;
  return [
    BuildingPieceType.ROOF_GABLE_2X2,
    BuildingPieceType.ROOF_GABLE_2X4,
    BuildingPieceType.ROOF_GABLE_4X4,
    BuildingPieceType.ROOF_HIP_2X2,
    BuildingPieceType.ROOF_HIP_2X4,
    BuildingPieceType.ROOF_HIP_4X4,
    BuildingPieceType.ROOF_SHED_2X2,
    BuildingPieceType.ROOF_SHED_2X4,
    BuildingPieceType.ROOF_SHED_4X4,
  ].includes(type);
}

export function getDefaultRoofConfig(type: BuildingPieceType) {
  let roofType: 'gable' | 'hip' | 'shed' = 'gable';
  if (type.includes('HIP')) roofType = 'hip';
  else if (type.includes('SHED')) roofType = 'shed';

  switch (shapeOf(type)) {
    case BuildingPieceType.ROOF_GABLE_2X2:
    case BuildingPieceType.ROOF_HIP_2X2:
    case BuildingPieceType.ROOF_SHED_2X2:
      return {
        minX: -1.0,
        maxX: 1.0,
        minZ: -1.0,
        maxZ: 1.0,
        height: 0.85,
        roofType,
        minSize: 0.2,
        minHeight: 0.1,
        maxHeight: 5.0,
        snapSize: 0.5,
      };
    case BuildingPieceType.ROOF_GABLE_2X4:
    case BuildingPieceType.ROOF_HIP_2X4:
    case BuildingPieceType.ROOF_SHED_2X4:
      return {
        minX: -1.0,
        maxX: 1.0,
        minZ: -2.0,
        maxZ: 2.0,
        height: 0.85,
        roofType,
        minSize: 0.2,
        minHeight: 0.1,
        maxHeight: 5.0,
        snapSize: 0.5,
      };
    case BuildingPieceType.ROOF_GABLE_4X4:
    case BuildingPieceType.ROOF_HIP_4X4:
    case BuildingPieceType.ROOF_SHED_4X4:
      return {
        minX: -2.0,
        maxX: 2.0,
        minZ: -2.0,
        maxZ: 2.0,
        height: 1.6,
        roofType,
        minSize: 0.2,
        minHeight: 0.1,
        maxHeight: 5.0,
        snapSize: 0.5,
      };
    default:
      return {
        minX: -1.0,
        maxX: 1.0,
        minZ: -1.0,
        maxZ: 1.0,
        height: 0.85,
        roofType,
        minSize: 0.2,
        minHeight: 0.1,
        maxHeight: 5.0,
        snapSize: 0.5,
      };
  }
}

/**
 * Calculates the half-height extent (along world Y) for any building piece taking rotation into account.
 */
export function getPieceHalfExtentY(
  type: BuildingPieceType,
  quaternion?: THREE.Quaternion,
  piece?: BuiltPiece
): number {
  if (piece && piece.roofConfig) {
    // For procedural roofs, pivot is at the base plane and height extends upward
    return 0;
  }
  const pieceDef = BUILDING_PIECES[type];
  const dim = pieceDef ? pieceDef.dimensions : new THREE.Vector3(2.0, 2.0, 2.0);
  if (!quaternion) {
    return dim.y * 0.5;
  }
  const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  const localY = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  const localZ = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
  return (
    (dim.x * 0.5) * Math.abs(localX.y) +
    (dim.y * 0.5) * Math.abs(localY.y) +
    (dim.z * 0.5) * Math.abs(localZ.y)
  );
}

/**
 * Validates if a piece at the target position and orientation would penetrate or be located
 * below the construction platform surface (Y = 0).
 */
export function isPieceBelowSurface(
  type: BuildingPieceType,
  position: THREE.Vector3,
  quaternion?: THREE.Quaternion,
  piece?: BuiltPiece
): boolean {
  if (piece && piece.roofConfig) {
    return position.y < BUILDING_CONFIG.GROUND_SURFACE_Y + BUILDING_CONFIG.MIN_SURFACE_TOLERANCE;
  }
  const halfExtentY = getPieceHalfExtentY(type, quaternion, piece);
  const bottomY = position.y - halfExtentY;
  const pieceDef = BUILDING_PIECES[type];
  const maxGroundSink = pieceDef?.category === PieceCategory.FLOORS
    ? pieceDef.dimensions.y * BUILDING_CONFIG.GROUND_FLOOR_SINK_PERCENT
    : 0;
  return bottomY < BUILDING_CONFIG.GROUND_SURFACE_Y - maxGroundSink + BUILDING_CONFIG.MIN_SURFACE_TOLERANCE;
}
