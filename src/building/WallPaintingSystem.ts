import { t } from '../i18n/i18n';
import * as THREE from 'three';
import { BuiltPiece, BuildingPieceType } from './types/BuildingTypes';
import { SolvedSegmentCorners } from './ContinuousWallSystem';
import { WALL_THICKNESS } from './config/BuildingPiecesConfig';
import {
  createHerringboneParquetTexture,
  createDarkWalnutFloorTexture,
  createLightPineFloorTexture,
  createCheckerMarbleFloorTexture,
  createTerracottaCottoFloorTexture,
  createRoyalCarpetFloorTexture,
  createFlagstonePaversFloorTexture,
  createMoroccanMosaicFloorTexture,
  createDarkWoodCofferedCeilingTexture,
  createWhiteCofferedCeilingTexture,
  createRusticOakBeamsCeilingTexture,
  createWhiteBeadedPlanksCeilingTexture,
  createCelestialStarryCeilingTexture,
  createVictorianPlasterRosetteCeilingTexture,
} from './textures/FloorCeilingTextures';

export type WallFaceSide = 'left' | 'right' | 'top' | 'bottom';
export type PaintingToolMode = 'wall' | 'fill' | 'picker' | 'eraser';

/** Which continuous meshes a paint change touched, so only those get rebuilt. */
export interface PaintChangeScope {
  walls: boolean;
  floors: boolean;
}

interface PaintChange {
  key: string;
  before: string | undefined;
  after: string | undefined;
}

const MAX_UNDO_STEPS = 100;
const MAX_FILL_FACES = 256;
const FILL_POINT_EPS = 0.03;

export interface WallpaperDef {
  id: string;
  name: string;
  ukrainianName: string;
  category: 'interior' | 'exterior' | 'floor' | 'ceiling' | 'all';
  previewColor: string;
  description: string;
  materialIndex: number;
  material: THREE.MeshLambertMaterial;
  thumbnailUrl: string;
  /** Physical size (meters) one texture repeat covers on a wall; V=0 is the floor line. */
  tileWidth: number;
  tileHeight: number;
}

/** Default physical size of a square 512px wallpaper repeat on walls. */
const DEFAULT_WALL_TILE_SIZE = 2.0;
/** Wainscot textures are composites: 1m panel at the bottom, painted wall above, 4m tall in total. */
const WAINSCOT_TILE_HEIGHT = 4.0;
const WAINSCOT_PANEL_HEIGHT = 1.0;

export interface WallCellCoord {
  pieceId: string;
  faceSide: WallFaceSide;
  col: number;
  row: number;
}

export interface WallCellHitInfo extends WallCellCoord {
  worldCenter: THREE.Vector3;
  worldNormal: THREE.Vector3;
  corners: THREE.Vector3[];
  width: number;
  height: number;
  numCols: number;
  numRows: number;
  currentWallpaperId: string;
  faceLabel: string;
  faceKind: 'outer' | 'inner' | 'floor' | 'ceiling';
}

/**
 * Procedural texture helpers for Heartopia stylized wallpapers and facades.
 */
export interface WainscotTextureOptions {
  /** Paint colour of the wall above the chair rail */
  upperWallColor?: string;
  baseColor: string;
  slatLight: string;
  slatDark: string;
  grooveColor: string;
  grooveShadow: string;
  highlightColor: string;
  chairRailTop: string;
  chairRailMid: string;
  chairRailShadow: string;
  baseboardTop: string;
  baseboardMid: string;
  baseboardBottom: string;
  grainAlpha: number;
  grainColor: string;
  roughness?: number;
  metalness?: number;
}

export function createWainscotTexture(options: WainscotTextureOptions): {
  texture: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  dataUrl: string;
} {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 512;
  bumpCanvas.height = 512;
  const bctx = bumpCanvas.getContext('2d')!;

  // 1. Base Fill
  ctx.fillStyle = options.baseColor;
  ctx.fillRect(0, 0, 512, 512);

  bctx.fillStyle = '#808080'; // Neutral bump
  bctx.fillRect(0, 0, 512, 512);

  // 2. Vertical Beadboard Slats (16 slats of 32px each across 512px)
  const slatWidth = 32;
  const totalSlats = 16;
  const topMoldingH = 46;
  const bottomMoldingH = 46;
  const slatsY = topMoldingH;
  const slatsH = 512 - topMoldingH - bottomMoldingH;

  for (let i = 0; i < totalSlats; i++) {
    const x = i * slatWidth;

    // Slat horizontal cushion gradient
    const slatGrad = ctx.createLinearGradient(x, 0, x + slatWidth, 0);
    slatGrad.addColorStop(0, options.highlightColor);
    slatGrad.addColorStop(0.12, options.slatLight);
    slatGrad.addColorStop(0.55, options.baseColor);
    slatGrad.addColorStop(0.9, options.slatDark);
    slatGrad.addColorStop(1, options.grooveColor);
    ctx.fillStyle = slatGrad;
    ctx.fillRect(x, slatsY, slatWidth, slatsH);

    // Bump for slat (convex cushion)
    const bumpGrad = bctx.createLinearGradient(x, 0, x + slatWidth, 0);
    bumpGrad.addColorStop(0, '#c0c0c0');
    bumpGrad.addColorStop(0.5, '#e0e0e0');
    bumpGrad.addColorStop(0.9, '#a0a0a0');
    bumpGrad.addColorStop(1, '#202020'); // deep groove
    bctx.fillStyle = bumpGrad;
    bctx.fillRect(x, slatsY, slatWidth, slatsH);

    // Left micro-bevel highlight line
    ctx.strokeStyle = options.highlightColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, slatsY);
    ctx.lineTo(x + 0.5, slatsY + slatsH);
    ctx.stroke();

    // Right recessed V-groove shadow line
    ctx.strokeStyle = options.grooveShadow;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + slatWidth - 0.75, slatsY);
    ctx.lineTo(x + slatWidth - 0.75, slatsY + slatsH);
    ctx.stroke();

    // Micro bead line in center of each slat
    const beadGrad = ctx.createLinearGradient(x + 14, 0, x + 18, 0);
    beadGrad.addColorStop(0, options.grooveColor);
    beadGrad.addColorStop(0.5, options.highlightColor);
    beadGrad.addColorStop(1, options.grooveShadow);
    ctx.fillStyle = beadGrad;
    ctx.fillRect(x + 15, slatsY, 2, slatsH);

    // Bump for bead
    bctx.fillStyle = '#ffffff';
    bctx.fillRect(x + 15.5, slatsY, 1, slatsH);
  }

  // 3. Natural Wood Grain over the slats
  if (options.grainAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = options.grainAlpha;
    ctx.strokeStyle = options.grainColor;
    ctx.lineWidth = 1;
    for (let g = 0; g < 160; g++) {
      const gx = Math.random() * 512;
      const len = 30 + Math.random() * 110;
      const gy = slatsY + Math.random() * (slatsH - len);
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.bezierCurveTo(
        gx + (Math.random() - 0.5) * 4,
        gy + len * 0.33,
        gx + (Math.random() - 0.5) * 4,
        gy + len * 0.66,
        gx,
        gy + len
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  // 4. Top Chair Rail Molding (y = 0 to 46)
  const capGrad = ctx.createLinearGradient(0, 0, 0, 8);
  capGrad.addColorStop(0, '#ffffff');
  capGrad.addColorStop(1, options.chairRailTop);
  ctx.fillStyle = capGrad;
  ctx.fillRect(0, 0, 512, 8);

  const railGrad = ctx.createLinearGradient(0, 8, 0, 34);
  railGrad.addColorStop(0, options.chairRailTop);
  railGrad.addColorStop(0.3, options.highlightColor);
  railGrad.addColorStop(0.7, options.chairRailMid);
  railGrad.addColorStop(1, options.chairRailShadow);
  ctx.fillStyle = railGrad;
  ctx.fillRect(0, 8, 512, 26);

  ctx.strokeStyle = options.highlightColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 33);
  ctx.lineTo(512, 33);
  ctx.stroke();

  ctx.strokeStyle = options.grooveShadow;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 35);
  ctx.lineTo(512, 35);
  ctx.stroke();

  const dropShadowGrad = ctx.createLinearGradient(0, 36, 0, 46);
  dropShadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0.45)');
  dropShadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
  ctx.fillStyle = dropShadowGrad;
  ctx.fillRect(0, 36, 512, 10);

  const railBump = bctx.createLinearGradient(0, 0, 0, 46);
  railBump.addColorStop(0, '#f0f0f0');
  railBump.addColorStop(0.2, '#ffffff');
  railBump.addColorStop(0.75, '#e8e8e8');
  railBump.addColorStop(0.78, '#101010');
  railBump.addColorStop(1, '#808080');
  bctx.fillStyle = railBump;
  bctx.fillRect(0, 0, 512, 46);

  // 5. Bottom Baseboard Molding (y = 466 to 512)
  const baseStartY = 512 - bottomMoldingH;
  const baseBevelGrad = ctx.createLinearGradient(0, baseStartY, 0, baseStartY + 10);
  baseBevelGrad.addColorStop(0, options.highlightColor);
  baseBevelGrad.addColorStop(0.4, options.baseboardTop);
  baseBevelGrad.addColorStop(1, options.baseboardMid);
  ctx.fillStyle = baseBevelGrad;
  ctx.fillRect(0, baseStartY, 512, 10);

  const baseFaceGrad = ctx.createLinearGradient(0, baseStartY + 10, 0, 504);
  baseFaceGrad.addColorStop(0, options.baseboardTop);
  baseFaceGrad.addColorStop(0.5, options.baseboardMid);
  baseFaceGrad.addColorStop(1, options.baseboardBottom);
  ctx.fillStyle = baseFaceGrad;
  ctx.fillRect(0, baseStartY + 10, 512, 28);

  const shoeGrad = ctx.createLinearGradient(0, 504, 0, 512);
  shoeGrad.addColorStop(0, options.baseboardMid);
  shoeGrad.addColorStop(0.5, options.baseboardBottom);
  shoeGrad.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
  ctx.fillStyle = shoeGrad;
  ctx.fillRect(0, 504, 512, 8);

  const baseBump = bctx.createLinearGradient(0, baseStartY, 0, 512);
  baseBump.addColorStop(0, '#d0d0d0');
  baseBump.addColorStop(0.2, '#f0f0f0');
  baseBump.addColorStop(0.85, '#e0e0e0');
  baseBump.addColorStop(1, '#202020');
  bctx.fillStyle = baseBump;
  bctx.fillRect(0, baseStartY, 512, bottomMoldingH);

  // 6. Compose the real wall: panel squeezed into the bottom metre, painted wall above it.
  // 256px per metre in both directions keeps the texture's proportions true on any wall.
  const pxPerMeter = 512 / DEFAULT_WALL_TILE_SIZE;
  const fullH = WAINSCOT_TILE_HEIGHT * pxPerMeter;
  const panelH = WAINSCOT_PANEL_HEIGHT * pxPerMeter;
  const upperColor = options.upperWallColor ?? '#f2ece1';

  const wall = document.createElement('canvas');
  wall.width = 512;
  wall.height = fullH;
  const wctx = wall.getContext('2d')!;
  wctx.fillStyle = upperColor;
  wctx.fillRect(0, 0, 512, fullH - panelH);
  // Soft plaster mottling so the painted part does not look flat
  wctx.save();
  for (let i = 0; i < 900; i++) {
    wctx.globalAlpha = 0.025 + Math.random() * 0.03;
    wctx.fillStyle = Math.random() < 0.5 ? '#ffffff' : '#8a7f70';
    const r = 2 + Math.random() * 7;
    wctx.beginPath();
    wctx.arc(Math.random() * 512, Math.random() * (fullH - panelH), r, 0, Math.PI * 2);
    wctx.fill();
  }
  wctx.restore();
  wctx.drawImage(canvas, 0, fullH - panelH, 512, panelH);

  const wallBump = document.createElement('canvas');
  wallBump.width = 512;
  wallBump.height = fullH;
  const wbctx = wallBump.getContext('2d')!;
  wbctx.fillStyle = '#808080';
  wbctx.fillRect(0, 0, 512, fullH - panelH);
  wbctx.drawImage(bumpCanvas, 0, fullH - panelH, 512, panelH);

  const texture = new THREE.CanvasTexture(wall);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping; // taller walls just continue the paint colour
  texture.colorSpace = THREE.SRGBColorSpace;

  const bumpMap = new THREE.CanvasTexture(wallBump);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.ClampToEdgeWrapping;

  // Thumbnail: the bottom 2m of the wall, so the swatch shows the panel under painted wall
  const thumb = document.createElement('canvas');
  thumb.width = 256;
  thumb.height = 256;
  thumb.getContext('2d')!.drawImage(wall, 0, fullH - 512, 512, 512, 0, 0, 256, 256);

  return { texture, bumpMap, dataUrl: thumb.toDataURL('image/png') };
}

function createFloralWallpaperTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Warm ivory background
  ctx.fillStyle = '#faf6ee';
  ctx.fillRect(0, 0, 512, 512);

  // Subtle linen fabric texture
  ctx.fillStyle = 'rgba(230, 222, 210, 0.35)';
  for (let y = 0; y < 512; y += 4) {
    ctx.fillRect(0, y, 512, 1);
  }
  for (let x = 0; x < 512; x += 4) {
    ctx.fillRect(x, 0, 1, 512);
  }

  // Draw cute Heartopia cottagecore floral clusters
  const clusters = [
    { x: 128, y: 128 },
    { x: 384, y: 128 },
    { x: 256, y: 256 },
    { x: 128, y: 384 },
    { x: 384, y: 384 },
    { x: 0, y: 256 },
    { x: 512, y: 256 },
    { x: 256, y: 0 },
    { x: 256, y: 512 },
  ];

  for (const c of clusters) {
    // Sage green leaf stems
    ctx.strokeStyle = '#84a98c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(c.x - 12, c.y + 6, 16, 0.4, 2.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c.x + 12, c.y - 6, 16, 3.5, 5.3);
    ctx.stroke();

    // Leaves
    ctx.fillStyle = '#95d5b2';
    ctx.beginPath();
    ctx.ellipse(c.x - 22, c.y + 14, 10, 5, Math.PI / 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(c.x + 22, c.y - 14, 10, 5, -Math.PI / 4, 0, Math.PI * 2);
    ctx.fill();

    // 5-Petal Rosebuds
    for (let p = 0; p < 5; p++) {
      const angle = (p * Math.PI * 2) / 5;
      const px = c.x + Math.cos(angle) * 14;
      const py = c.y + Math.sin(angle) * 14;
      ctx.fillStyle = '#ffb4a2';
      ctx.beginPath();
      ctx.arc(px, py, 11, 0, Math.PI * 2);
      ctx.fill();
    }

    // Inner blossom core
    ctx.fillStyle = '#e5989b';
    ctx.beginPath();
    ctx.arc(c.x, c.y, 10, 0, Math.PI * 2);
    ctx.fill();

    // Center pollen dot
    ctx.fillStyle = '#ffcdb2';
    ctx.beginPath();
    ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

function createMintBeadboardTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#d8e2dc';
  ctx.fillRect(0, 0, 512, 512);

  // Vertical wood beadboard slats (32px each)
  const slatW = 32;
  for (let x = 0; x < 512; x += slatW) {
    // Slat body gradient
    const grad = ctx.createLinearGradient(x, 0, x + slatW, 0);
    grad.addColorStop(0, '#ebf2ee');
    grad.addColorStop(0.15, '#dbe5df');
    grad.addColorStop(0.85, '#d4ded8');
    grad.addColorStop(1, '#c5d2cb');
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, slatW - 2, 512);

    // Deep grooved shadow line
    ctx.fillStyle = '#a8b9af';
    ctx.fillRect(x + slatW - 2, 0, 2, 512);

    // Subtle bead highlight
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + 2, 0, 1, 512);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

function createPinkGinghamTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const tileSize = 64;
  ctx.fillStyle = '#fff0f3';
  ctx.fillRect(0, 0, 512, 512);

  for (let y = 0; y < 512; y += tileSize) {
    for (let x = 0; x < 512; x += tileSize) {
      const ix = (x / tileSize) % 2;
      const iy = (y / tileSize) % 2;
      if (ix === 1 && iy === 1) {
        ctx.fillStyle = '#ff758f'; // darkest overlap
      } else if (ix === 1 || iy === 1) {
        ctx.fillStyle = '#ffb3c1'; // medium tint
      } else {
        ctx.fillStyle = '#fff0f3'; // white/light
      }
      ctx.fillRect(x, y, tileSize, tileSize);
    }
  }

  // Crosshatch fabric lines
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
  for (let i = 0; i < 512; i += 8) {
    ctx.fillRect(0, i, 512, 2);
    ctx.fillRect(i, 0, 2, 512);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

function createGoldDamaskTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Champagne parchment background
  ctx.fillStyle = '#f8f5ee';
  ctx.fillRect(0, 0, 512, 512);

  // Baroque Damask motifs
  const points = [
    { x: 256, y: 256 },
    { x: 0, y: 0 },
    { x: 512, y: 0 },
    { x: 0, y: 512 },
    { x: 512, y: 512 },
  ];

  for (const p of points) {
    ctx.strokeStyle = '#d4af37';
    ctx.fillStyle = 'rgba(212, 175, 55, 0.22)';
    ctx.lineWidth = 4;

    // Center jewel
    ctx.beginPath();
    ctx.arc(p.x, p.y, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Top and bottom acanthus leaf scrolls
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - 50, 18, 40, 0, 0, Math.PI * 2);
    ctx.ellipse(p.x, p.y + 50, 18, 40, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Left and right curls
    ctx.beginPath();
    ctx.ellipse(p.x - 50, p.y, 40, 18, 0, 0, Math.PI * 2);
    ctx.ellipse(p.x + 50, p.y, 40, 18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

function createTerracottaBrickTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Mortar background
  ctx.fillStyle = '#dfd7cc';
  ctx.fillRect(0, 0, 512, 512);

  const brickW = 128;
  const brickH = 64;
  const mortar = 6;

  const colors = ['#c85a32', '#ba4e28', '#d66a42', '#b34622'];

  let row = 0;
  for (let y = 0; y < 512; y += brickH) {
    const shift = (row % 2) * (brickW / 2);
    for (let x = -brickW; x < 512 + brickW; x += brickW) {
      const bx = x + shift;
      const c = colors[Math.abs(row * 7 + Math.floor(x / brickW)) % colors.length];
      ctx.fillStyle = c;
      ctx.fillRect(bx + mortar / 2, y + mortar / 2, brickW - mortar, brickH - mortar);

      // Brick surface shading and bevel
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fillRect(bx + mortar / 2, y + mortar / 2, brickW - mortar, 4);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.fillRect(bx + mortar / 2, y + brickH - mortar / 2 - 4, brickW - mortar, 4);
    }
    row++;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

function createSubwayTileTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Dark grey grout
  ctx.fillStyle = '#3a3d40';
  ctx.fillRect(0, 0, 512, 512);

  const tileW = 128;
  const tileH = 64;
  const grout = 4;

  let row = 0;
  for (let y = 0; y < 512; y += tileH) {
    const shift = (row % 2) * (tileW / 2);
    for (let x = -tileW; x < 512 + tileW; x += tileW) {
      const tx = x + shift;
      const tw = tileW - grout;
      const th = tileH - grout;
      const px = tx + grout / 2;
      const py = y + grout / 2;

      // Crisp ceramic white tile body
      ctx.fillStyle = '#f8f9fa';
      ctx.fillRect(px, py, tw, th);

      // Bevel 3D highlight
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px, py, tw, 3);
      ctx.fillRect(px, py, 3, th);

      // Bevel 3D shadow
      ctx.fillStyle = '#dcdfe3';
      ctx.fillRect(px, py + th - 3, tw, 3);
      ctx.fillRect(px + tw - 3, py, 3, th);
    }
    row++;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

function createSageBotanicalTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#7a9e7e';
  ctx.fillRect(0, 0, 512, 512);

  // Botanical ferns and leaf silhouettes
  ctx.fillStyle = '#edf6f0';
  for (let y = 64; y < 512; y += 128) {
    for (let x = 64; x < 512; x += 128) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((x + y) * 0.05);

      // Central stem
      ctx.fillRect(-2, -50, 4, 100);

      // Leaves
      for (let l = -40; l <= 40; l += 16) {
        ctx.beginPath();
        ctx.ellipse(-14, l, 12, 5, -0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(14, l, 12, 5, 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

function createLavenderStarsTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#dcd3f0';
  ctx.fillRect(0, 0, 512, 512);

  // Twinkling stars and sparkles
  const stars = [
    { x: 100, y: 100, s: 20 },
    { x: 256, y: 150, s: 14 },
    { x: 400, y: 80, s: 22 },
    { x: 180, y: 320, s: 18 },
    { x: 360, y: 380, s: 24 },
    { x: 80, y: 450, s: 16 },
    { x: 480, y: 260, s: 16 },
    { x: 30, y: 220, s: 12 },
  ];

  ctx.fillStyle = '#ffffff';
  for (const st of stars) {
    // 4-point star
    ctx.beginPath();
    ctx.moveTo(st.x, st.y - st.s);
    ctx.quadraticCurveTo(st.x, st.y, st.x + st.s, st.y);
    ctx.quadraticCurveTo(st.x, st.y, st.x, st.y + st.s);
    ctx.quadraticCurveTo(st.x, st.y, st.x - st.s, st.y);
    ctx.quadraticCurveTo(st.x, st.y, st.x, st.y - st.s);
    ctx.fill();

    // Mini gold center
    ctx.fillStyle = '#fef08a';
    ctx.beginPath();
    ctx.arc(st.x, st.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

function createOakPlanksTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#ab8460';
  ctx.fillRect(0, 0, 512, 512);

  const plankW = 64;
  for (let x = 0; x < 512; x += plankW) {
    const grad = ctx.createLinearGradient(x, 0, x + plankW, 0);
    grad.addColorStop(0, '#c49a72');
    grad.addColorStop(0.5, '#ab8460');
    grad.addColorStop(1, '#8f6544');
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, plankW - 2, 512);

    // Wood seams
    ctx.fillStyle = '#5c3a21';
    ctx.fillRect(x + plankW - 2, 0, 2, 512);

    // Subtle grain lines
    ctx.fillStyle = 'rgba(74, 46, 24, 0.15)';
    for (let g = 0; g < 4; g++) {
      ctx.fillRect(x + 10 + g * 12, 0, 2, 512);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

function createCobblestoneTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#6b705c';
  ctx.fillRect(0, 0, 512, 512);

  const colors = ['#a5a58d', '#b7b7a4', '#ddbea9', '#cb997e'];
  for (let y = 32; y < 512; y += 64) {
    const shift = (Math.floor(y / 64) % 2) * 48;
    for (let x = 32; x < 512 + 48; x += 96) {
      const px = x + shift - 24;
      ctx.fillStyle = colors[(x * 3 + y * 7) % colors.length];
      ctx.beginPath();
      ctx.roundRect(px, y - 24, 84, 48, 16);
      ctx.fill();

      // Pebble highlight
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

function createSkyCloudsTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#90e0ef';
  ctx.fillRect(0, 0, 512, 512);

  // Stylized Heartopia puffy clouds
  const cloudCenters = [
    { x: 128, y: 120 },
    { x: 384, y: 160 },
    { x: 200, y: 350 },
    { x: 440, y: 420 },
    { x: 20, y: 440 },
  ];

  ctx.fillStyle = '#ffffff';
  for (const c of cloudCenters) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, 28, 0, Math.PI * 2);
    ctx.arc(c.x + 24, c.y - 12, 22, 0, Math.PI * 2);
    ctx.arc(c.x + 48, c.y, 26, 0, Math.PI * 2);
    ctx.arc(c.x + 24, c.y + 10, 20, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

function createCreamStuccoTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#f8f6f0';
  ctx.fillRect(0, 0, 512, 512);

  // Soft stucco plaster trowel grain
  ctx.fillStyle = 'rgba(215, 208, 195, 0.4)';
  for (let i = 0; i < 400; i++) {
    const rx = Math.random() * 512;
    const ry = Math.random() * 512;
    const rw = 20 + Math.random() * 40;
    const rh = 6 + Math.random() * 12;
    ctx.beginPath();
    ctx.ellipse(rx, ry, rw, rh, Math.random() * 0.6 - 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

function createScandiGeoTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#f4f1de';
  ctx.fillRect(0, 0, 512, 512);

  const colors = ['#e07a5f', '#3d405b', '#81b29a', '#f2cc8f'];
  const step = 64;

  for (let y = 0; y < 512; y += step) {
    for (let x = 0; x < 512; x += step) {
      const idx = (Math.floor(x / step) + Math.floor(y / step)) % colors.length;
      ctx.fillStyle = colors[idx];
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + step, y);
      ctx.lineTo(x, y + step);
      ctx.closePath();
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * Main WallPaintingSystem (Heartopia Wall Customization Engine)
 * Handles tile-by-tile wallpaper & facade painting independently for front (exterior) and back (interior) faces.
 */
export class WallPaintingSystem {
  public wallpapers: WallpaperDef[] = [];
  public wallpaperMap: Map<string, WallpaperDef> = new Map();
  private materialList: THREE.MeshLambertMaterial[] = [];

  // Key: `${pieceId}:${faceSide}` => wallpaperId (absent = 'default')
  private paintedCells: Map<string, string> = new Map();

  private undoStack: PaintChange[][] = [];
  private redoStack: PaintChange[][] = [];
  private activeStroke: PaintChange[] | null = null;

  // Bumped on every paint change; invalidates the cached fill region
  private paintVersion = 0;
  private fillCache: {
    key: string;
    solvedCorners: Map<string, SolvedSegmentCorners>;
    faces: WallCellHitInfo[];
  } | null = null;

  // Translucent overlay showing every face the fill tool would paint
  private fillPreviewMesh: THREE.Mesh;
  private fillPreviewMaterial: THREE.MeshBasicMaterial;
  private fillPreviewFaces: WallCellHitInfo[] | null = null;

  // Hover visual reticle
  private hoverGroup: THREE.Group;
  private hoverFrameLines: THREE.LineSegments;
  private hoverFillMesh: THREE.Mesh;
  private hoverFillMaterial: THREE.MeshBasicMaterial;

  public activeToolMode: PaintingToolMode = 'wall';
  public activeWallpaperId: string = 'wainscot_white_wood';
  public gridCellSize: number = 1.0;

  constructor(scene: THREE.Group, defaultWallCheckerMaterial: THREE.MeshLambertMaterial) {
    this.initWallpapers(defaultWallCheckerMaterial);

    // Build 3D Hover Reticle for exact cell highlighting
    this.hoverGroup = new THREE.Group();
    this.hoverGroup.name = 'WallPainting_HoverReticle';
    this.hoverGroup.visible = false;

    // Outer framing box
    const frameGeo = new THREE.BufferGeometry();
    const framePositions = new Float32Array([
      -0.5, -0.5, 0,  0.5, -0.5, 0,
       0.5, -0.5, 0,  0.5,  0.5, 0,
       0.5,  0.5, 0, -0.5,  0.5, 0,
      -0.5,  0.5, 0, -0.5, -0.5, 0,
    ]);
    frameGeo.setAttribute('position', new THREE.BufferAttribute(framePositions, 3));
    const frameMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      linewidth: 3,
      depthTest: false,
    });
    this.hoverFrameLines = new THREE.LineSegments(frameGeo, frameMat);
    this.hoverGroup.add(this.hoverFrameLines);

    // Translucent preview fill
    const fillGeo = new THREE.PlaneGeometry(1, 1);
    this.hoverFillMaterial = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.hoverFillMesh = new THREE.Mesh(fillGeo, this.hoverFillMaterial);
    this.hoverGroup.add(this.hoverFillMesh);

    scene.add(this.hoverGroup);

    this.fillPreviewMaterial = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.fillPreviewMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.fillPreviewMaterial);
    this.fillPreviewMesh.name = 'WallPainting_FillPreview';
    this.fillPreviewMesh.visible = false;
    this.fillPreviewMesh.frustumCulled = false;
    scene.add(this.fillPreviewMesh);
  }

  private initWallpapers(defaultMat: THREE.MeshLambertMaterial): void {
    // 0: Default Checker Wall
    this.registerWallpaper({
      id: 'default',
      name: 'Classic Checker',
      ukrainianName: 'Базовий чекер',
      category: 'all',
      previewColor: '#475569',
      description: 'Стандартне базове оздоблення стіни',
      material: defaultMat,
      thumbnailUrl: '',
    });

    // Wainscoting Variant 1: White Wood (як на картинці - референс)
    const wainscotWhite = createWainscotTexture({
      upperWallColor: '#f3ede3',
      baseColor: '#f8fafc',
      slatLight: '#ffffff',
      slatDark: '#eef2f6',
      grooveColor: '#cbd5e1',
      grooveShadow: '#94a3b8',
      highlightColor: 'rgba(255, 255, 255, 0.95)',
      chairRailTop: '#ffffff',
      chairRailMid: '#e2e8f0',
      chairRailShadow: 'rgba(51, 65, 85, 0.35)',
      baseboardTop: '#ffffff',
      baseboardMid: '#f1f5f9',
      baseboardBottom: '#cbd5e1',
      grainAlpha: 0.035,
      grainColor: '#94a3b8',
      });
    this.registerWallpaper({
      id: 'wainscot_white_wood',
      name: 'White Wood Wainscot',
      ukrainianName: 'Білий дерев’яний (як на фото)',
      category: 'interior',
      previewColor: '#f8fafc',
      description: 'Класичні білі вертикальні дерев’яні рейки з верхнім різьбленим карнизом рейлу та плінтусом',
      material: new THREE.MeshLambertMaterial({
        map: wainscotWhite.texture,
        bumpMap: wainscotWhite.bumpMap,
        bumpScale: 0.035,
        }),
      thumbnailUrl: wainscotWhite.dataUrl,
    });

    // Wainscoting Variant 2: Natural Oak (Натуральний дуб)
    const wainscotOak = createWainscotTexture({
      upperWallColor: '#f0e6d4',
      baseColor: '#be9264',
      slatLight: '#cf9e6e',
      slatDark: '#a8794d',
      grooveColor: '#5c391b',
      grooveShadow: '#3d240e',
      highlightColor: 'rgba(255, 230, 200, 0.4)',
      chairRailTop: '#d5a878',
      chairRailMid: '#b68453',
      chairRailShadow: 'rgba(40, 20, 10, 0.45)',
      baseboardTop: '#c89665',
      baseboardMid: '#a47344',
      baseboardBottom: '#4d2e14',
      grainAlpha: 0.16,
      grainColor: '#4d2b12',
      });
    this.registerWallpaper({
      id: 'wainscot_natural_oak',
      name: 'Natural Oak Wainscot',
      ukrainianName: 'Натуральний дуб',
      category: 'interior',
      previewColor: '#be9264',
      description: 'Теплі вертикальні рейки з масиву золотого дуба з виразною текстурою волокон та фасками',
      material: new THREE.MeshLambertMaterial({
        map: wainscotOak.texture,
        bumpMap: wainscotOak.bumpMap,
        bumpScale: 0.04,
        }),
      thumbnailUrl: wainscotOak.dataUrl,
    });

    // Wainscoting Variant 3: Sage Heritage (Шавлієвий вікторіанський)
    const wainscotSage = createWainscotTexture({
      upperWallColor: '#eef0e4',
      baseColor: '#798d80',
      slatLight: '#8c9f92',
      slatDark: '#677a6d',
      grooveColor: '#45554a',
      grooveShadow: '#2f3c33',
      highlightColor: 'rgba(235, 245, 238, 0.45)',
      chairRailTop: '#92a698',
      chairRailMid: '#718476',
      chairRailShadow: 'rgba(35, 48, 40, 0.4)',
      baseboardTop: '#899d90',
      baseboardMid: '#697c6f',
      baseboardBottom: '#3d4b41',
      grainAlpha: 0.05,
      grainColor: '#36433a',
      });
    this.registerWallpaper({
      id: 'wainscot_sage_green',
      name: 'Sage Heritage Wainscot',
      ukrainianName: 'Шавлієвий вікторіанський',
      category: 'interior',
      previewColor: '#798d80',
      description: 'Елегантний англійський заміський вайнскотінг заспокійливого оливково-шавлієвого відтінку',
      material: new THREE.MeshLambertMaterial({
        map: wainscotSage.texture,
        bumpMap: wainscotSage.bumpMap,
        bumpScale: 0.035,
        }),
      thumbnailUrl: wainscotSage.dataUrl,
    });

    // Wainscoting Variant 4: Navy Coastal (Морський індиго)
    const wainscotNavy = createWainscotTexture({
      upperWallColor: '#e8edf1',
      baseColor: '#253443',
      slatLight: '#324558',
      slatDark: '#1c2834',
      grooveColor: '#101820',
      grooveShadow: '#090e13',
      highlightColor: 'rgba(180, 210, 240, 0.35)',
      chairRailTop: '#3a4e63',
      chairRailMid: '#243241',
      chairRailShadow: 'rgba(8, 12, 16, 0.55)',
      baseboardTop: '#314456',
      baseboardMid: '#1e2936',
      baseboardBottom: '#0e151c',
      grainAlpha: 0.05,
      grainColor: '#101820',
      });
    this.registerWallpaper({
      id: 'wainscot_navy_slate',
      name: 'Navy Coastal Wainscot',
      ukrainianName: 'Морський індиго',
      category: 'interior',
      previewColor: '#253443',
      description: 'Глибокі темно-сині рельєфні дерев’яні панелі у стилі Хемптонс з вишуканими світлотінями',
      material: new THREE.MeshLambertMaterial({
        map: wainscotNavy.texture,
        bumpMap: wainscotNavy.bumpMap,
        bumpScale: 0.04,
        }),
      thumbnailUrl: wainscotNavy.dataUrl,
    });

    // Wainscoting Variant 5: Dark Walnut (Темний горіх)
    const wainscotWalnut = createWainscotTexture({
      upperWallColor: '#ece2d0',
      baseColor: '#3d2516',
      slatLight: '#523420',
      slatDark: '#2c1a0e',
      grooveColor: '#170c06',
      grooveShadow: '#0a0503',
      highlightColor: 'rgba(255, 210, 180, 0.25)',
      chairRailTop: '#5a3821',
      chairRailMid: '#382113',
      chairRailShadow: 'rgba(15, 8, 4, 0.55)',
      baseboardTop: '#4e2f1b',
      baseboardMid: '#2e1b0f',
      baseboardBottom: '#140a05',
      grainAlpha: 0.15,
      grainColor: '#180d07',
      });
    this.registerWallpaper({
      id: 'wainscot_dark_walnut',
      name: 'Dark Walnut Wainscot',
      ukrainianName: 'Темний горіх',
      category: 'interior',
      previewColor: '#3d2516',
      description: 'Розкішне темне горіхове дерево зі скульптурним карнизом і глибокими тіньовими стиками',
      material: new THREE.MeshLambertMaterial({
        map: wainscotWalnut.texture,
        bumpMap: wainscotWalnut.bumpMap,
        bumpScale: 0.04,
        }),
      thumbnailUrl: wainscotWalnut.dataUrl,
    });

    // 1: Floral Cottage (Heartopia Interior)
    const floral = createFloralWallpaperTexture();
    this.registerWallpaper({
      id: 'floral_cottage',
      name: 'Floral Cottage',
      ukrainianName: 'Квітковий котедж',
      category: 'interior',
      previewColor: '#ffb4a2',
      description: 'Затишні ніжні трояндочки на теплому кремовому тлі',
      material: new THREE.MeshLambertMaterial({ map: floral.texture, }),
      thumbnailUrl: floral.dataUrl,
    });

    // 2: Mint Beadboard
    const mint = createMintBeadboardTexture();
    this.registerWallpaper({
      id: 'mint_beadboard',
      name: 'Mint Beadboard',
      ukrainianName: "М'ятна вагонка",
      category: 'interior',
      previewColor: '#d8e2dc',
      description: "Пастельні вертикальні дерев'яні рейки з фаскою",
      material: new THREE.MeshLambertMaterial({ map: mint.texture, }),
      thumbnailUrl: mint.dataUrl,
    });

    // 3: Pink Gingham
    const gingham = createPinkGinghamTexture();
    this.registerWallpaper({
      id: 'pink_gingham',
      name: 'Pink Gingham',
      ukrainianName: 'Рожевий гінгем',
      category: 'interior',
      previewColor: '#ff758f',
      description: 'Чарівна пастельна клітинка текстильного плетіння',
      material: new THREE.MeshLambertMaterial({ map: gingham.texture, }),
      thumbnailUrl: gingham.dataUrl,
    });

    // 4: Gold Damask
    const damask = createGoldDamaskTexture();
    this.registerWallpaper({
      id: 'gold_damask',
      name: 'Vintage Damask',
      ukrainianName: 'Вінтажний дамаск',
      category: 'interior',
      previewColor: '#d4af37',
      description: 'Вишуканий золотистий бароковий орнамент',
      material: new THREE.MeshLambertMaterial({ map: damask.texture, }),
      thumbnailUrl: damask.dataUrl,
    });

    // 5: Sage Botanical
    const botanical = createSageBotanicalTexture();
    this.registerWallpaper({
      id: 'sage_botanical',
      name: 'Sage Botanical',
      ukrainianName: 'Шавлія ботаніка',
      category: 'interior',
      previewColor: '#7a9e7e',
      description: 'Заспокійливе оливково-шавлієве тло з листям папороті',
      material: new THREE.MeshLambertMaterial({ map: botanical.texture, }),
      thumbnailUrl: botanical.dataUrl,
    });

    // 6: Lavender Stars
    const lavender = createLavenderStarsTexture();
    this.registerWallpaper({
      id: 'lavender_stars',
      name: 'Lavender Stars',
      ukrainianName: 'Лавандові зорі',
      category: 'interior',
      previewColor: '#c8b6ff',
      description: 'Казковий пастельний зоряний візерунок Heartopia',
      material: new THREE.MeshLambertMaterial({ map: lavender.texture, }),
      thumbnailUrl: lavender.dataUrl,
    });

    // 7: Sky Clouds
    const clouds = createSkyCloudsTexture();
    this.registerWallpaper({
      id: 'sky_clouds',
      name: 'Sky Clouds',
      ukrainianName: 'Ніжні хмаринки',
      category: 'interior',
      previewColor: '#90e0ef',
      description: 'Небесно-блакитне тло з милими білими хмаринками',
      material: new THREE.MeshLambertMaterial({ map: clouds.texture, }),
      thumbnailUrl: clouds.dataUrl,
    });

    // 8: Scandi Geo
    const scandi = createScandiGeoTexture();
    this.registerWallpaper({
      id: 'scandi_geo',
      name: 'Scandi Geo',
      ukrainianName: 'Скандинавський гео',
      category: 'interior',
      previewColor: '#e07a5f',
      description: 'Сучасні пастельні геометричні фігури',
      material: new THREE.MeshLambertMaterial({ map: scandi.texture, }),
      thumbnailUrl: scandi.dataUrl,
    });

    // 9: Terracotta Brick (Exterior Facade)
    const brick = createTerracottaBrickTexture();
    this.registerWallpaper({
      id: 'terracotta_brick',
      name: 'Terracotta Brick',
      ukrainianName: 'Теракотова цегла',
      category: 'exterior',
      previewColor: '#ba4e28',
      description: 'Затишний фасад із теракотової цегли зі швом',
      material: new THREE.MeshLambertMaterial({ map: brick.texture, }),
      thumbnailUrl: brick.dataUrl,
    });

    // 10: White Subway Tile
    const subway = createSubwayTileTexture();
    this.registerWallpaper({
      id: 'subway_tile',
      name: 'White Subway Tile',
      ukrainianName: 'Біла плитка сабвей',
      category: 'all',
      previewColor: '#f8f9fa',
      description: 'Глянцева керамічна плитка зі скошеними фасками',
      material: new THREE.MeshLambertMaterial({ map: subway.texture, }),
      thumbnailUrl: subway.dataUrl,
    });

    // 11: Oak Planks
    const oak = createOakPlanksTexture();
    this.registerWallpaper({
      id: 'oak_planks',
      name: 'Oak Facade Planks',
      ukrainianName: 'Теплий фасадний дуб',
      category: 'exterior',
      previewColor: '#ab8460',
      description: 'Натуральне фасадне дерево з вертикальними стиками',
      material: new THREE.MeshLambertMaterial({ map: oak.texture, }),
      thumbnailUrl: oak.dataUrl,
    });

    // 12: Cobblestone
    const cobble = createCobblestoneTexture();
    this.registerWallpaper({
      id: 'cobblestone',
      name: 'Cottage Cobblestone',
      ukrainianName: 'Англійський камінь',
      category: 'exterior',
      previewColor: '#a5a58d',
      description: 'Рустикальна кладка з округлого річкового каменю',
      material: new THREE.MeshLambertMaterial({ map: cobble.texture, }),
      thumbnailUrl: cobble.dataUrl,
    });

    // 13: Cream Stucco
    const stucco = createCreamStuccoTexture();
    this.registerWallpaper({
      id: 'cream_stucco',
      name: 'Cream Stucco',
      ukrainianName: 'Кремова штукатурка',
      category: 'exterior',
      previewColor: '#f8f6f0',
      description: 'Стильна архітектурна штукатурка з мінеральною крихтою',
      material: new THREE.MeshLambertMaterial({ map: stucco.texture, }),
      thumbnailUrl: stucco.dataUrl,
    });

    // =========================================================================
    // FLOOR TEXTURES REGISTRATION (ТЕКСТУРИ ПІДЛОГИ)
    // =========================================================================

    // Floor 1: Herringbone Parquet
    const herringbone = createHerringboneParquetTexture();
    this.registerWallpaper({
      id: 'floor_herringbone_parquet',
      name: 'Herringbone Parquet',
      ukrainianName: 'Паркет ялинка',
      category: 'floor',
      previewColor: '#b6834d',
      description: 'Класичний паркет ялинкою з натурального золотистого дуба з виразними фасками',
      material: new THREE.MeshLambertMaterial({
        map: herringbone.texture,
        bumpMap: herringbone.bumpMap,
        bumpScale: 0.03,
        }),
      thumbnailUrl: herringbone.dataUrl,
    });

    // Floor 2: Dark Walnut Floor Planks
    const darkWalnutFloor = createDarkWalnutFloorTexture();
    this.registerWallpaper({
      id: 'floor_dark_walnut',
      name: 'Dark Walnut Planks',
      ukrainianName: 'Темний горіх (дошки)',
      category: 'floor',
      previewColor: '#301f14',
      description: 'Широкі масивні дошки темного шляхетного горіха з латунними цвяхами',
      material: new THREE.MeshLambertMaterial({
        map: darkWalnutFloor.texture,
        bumpMap: darkWalnutFloor.bumpMap,
        bumpScale: 0.035,
        }),
      thumbnailUrl: darkWalnutFloor.dataUrl,
    });

    // Floor 3: Light Nordic Pine Floor
    const lightPine = createLightPineFloorTexture();
    this.registerWallpaper({
      id: 'floor_light_pine',
      name: 'Light Nordic Pine',
      ukrainianName: 'Скандинавська сосна',
      category: 'floor',
      previewColor: '#ecdac3',
      description: 'Світлі скандинавські соснові мостини з м’яким теплим візерунком волокон',
      material: new THREE.MeshLambertMaterial({
        map: lightPine.texture,
        }),
      thumbnailUrl: lightPine.dataUrl,
    });

    // Floor 4: Marble Checker Floor Tiles
    const marbleChecker = createCheckerMarbleFloorTexture();
    this.registerWallpaper({
      id: 'floor_checker_marble',
      name: 'Carrara & Marquina Marble',
      ukrainianName: 'Мармурова шахова плитка',
      category: 'floor',
      previewColor: '#1e1e24',
      description: 'Розкішна чорно-біла шахова мармурова підлога з делікатними прожилками',
      material: new THREE.MeshLambertMaterial({
        map: marbleChecker.texture,
        }),
      thumbnailUrl: marbleChecker.dataUrl,
    });

    // Floor 5: Terracotta Cotto Tiles
    const terracottaCotto = createTerracottaCottoFloorTexture();
    this.registerWallpaper({
      id: 'floor_terracotta_cotto',
      name: 'Terracotta Cotto Tiles',
      ukrainianName: 'Теракотова котто плитка',
      category: 'floor',
      previewColor: '#b25332',
      description: 'Тепла середземноморська теракота ручної роботи зі світлими швами',
      material: new THREE.MeshLambertMaterial({
        map: terracottaCotto.texture,
        }),
      thumbnailUrl: terracottaCotto.dataUrl,
    });

    // Floor 6: Royal Baroque Carpet
    const royalCarpet = createRoyalCarpetFloorTexture();
    this.registerWallpaper({
      id: 'floor_royal_carpet',
      name: 'Royal Baroque Carpet',
      ukrainianName: 'Палацовий килим',
      category: 'floor',
      previewColor: '#6b1124',
      description: 'Оксамитовий бордово-золотий палацовий килим із центральним медальйоном',
      material: new THREE.MeshLambertMaterial({
        map: royalCarpet.texture,
        }),
      thumbnailUrl: royalCarpet.dataUrl,
    });

    // Floor 7: Flagstone Pavers
    const flagstone = createFlagstonePaversFloorTexture();
    this.registerWallpaper({
      id: 'floor_rustic_flagstone',
      name: 'Rustic Flagstone',
      ukrainianName: 'Кам’яні плити',
      category: 'floor',
      previewColor: '#52525b',
      description: 'Натуральні кам’яні плити для тераси, передпокою або саду',
      material: new THREE.MeshLambertMaterial({
        map: flagstone.texture,
        }),
      thumbnailUrl: flagstone.dataUrl,
    });

    // Floor 8: Moroccan Mosaic
    const moroccanMosaic = createMoroccanMosaicFloorTexture();
    this.registerWallpaper({
      id: 'floor_moroccan_mosaic',
      name: 'Moroccan Mosaic',
      ukrainianName: 'Марокканська мозаїка',
      category: 'floor',
      previewColor: '#0284c7',
      description: 'Яскравий східний мозаїчний візерунок у бірюзових та теракотових тонах',
      material: new THREE.MeshLambertMaterial({
        map: moroccanMosaic.texture,
        }),
      thumbnailUrl: moroccanMosaic.dataUrl,
    });

    // =========================================================================
    // CEILING TEXTURES REGISTRATION (ТЕКСТУРИ СТЕЛІ)
    // =========================================================================

    // Ceiling 1: Dark Wood Coffered
    const darkCoffered = createDarkWoodCofferedCeilingTexture();
    this.registerWallpaper({
      id: 'ceiling_dark_coffered',
      name: 'Dark Wood Coffered Ceiling',
      ukrainianName: 'Кесонна стеля (темний дуб)',
      category: 'ceiling',
      previewColor: '#3f2514',
      description: 'Аристократична дерев’яна кесонна стеля з глибокими нішами та розетками',
      material: new THREE.MeshLambertMaterial({
        map: darkCoffered.texture,
        bumpMap: darkCoffered.bumpMap,
        bumpScale: 0.04,
        }),
      thumbnailUrl: darkCoffered.dataUrl,
    });

    // Ceiling 2: White Plaster Coffered
    const whiteCoffered = createWhiteCofferedCeilingTexture();
    this.registerWallpaper({
      id: 'ceiling_white_coffered',
      name: 'White Plaster Coffered Ceiling',
      ukrainianName: 'Біла кесонна стеля',
      category: 'ceiling',
      previewColor: '#f8fafc',
      description: 'Елегантна біла гіпсова кесонна стеля зі скульптурною ліпниною',
      material: new THREE.MeshLambertMaterial({
        map: whiteCoffered.texture,
        }),
      thumbnailUrl: whiteCoffered.dataUrl,
    });

    // Ceiling 3: Rustic Oak Beams
    const rusticBeams = createRusticOakBeamsCeilingTexture();
    this.registerWallpaper({
      id: 'ceiling_rustic_beams',
      name: 'Rustic Oak Beams on Stucco',
      ukrainianName: 'Дубові балки на штукатурці',
      category: 'ceiling',
      previewColor: '#fbf9f5',
      description: 'Масивні відкриті дубові балки з кованими накладками на білій штукатурці',
      material: new THREE.MeshLambertMaterial({
        map: rusticBeams.texture,
        bumpMap: rusticBeams.bumpMap,
        bumpScale: 0.045,
        }),
      thumbnailUrl: rusticBeams.dataUrl,
    });

    // Ceiling 4: White Beaded Ceiling Planks
    const whiteBeadedCeiling = createWhiteBeadedPlanksCeilingTexture();
    this.registerWallpaper({
      id: 'ceiling_white_beaded',
      name: 'White Beaded Planks',
      ukrainianName: 'Біла стельова вагонка',
      category: 'ceiling',
      previewColor: '#f8fafc',
      description: 'Свіжа котеджна біла вагонка з тонкими акуратними фасками',
      material: new THREE.MeshLambertMaterial({
        map: whiteBeadedCeiling.texture,
        }),
      thumbnailUrl: whiteBeadedCeiling.dataUrl,
    });

    // Ceiling 5: Celestial Starry Night Sky
    const celestial = createCelestialStarryCeilingTexture();
    this.registerWallpaper({
      id: 'ceiling_celestial_stars',
      name: 'Celestial Starry Sky',
      ukrainianName: 'Казкове зоряне небо',
      category: 'ceiling',
      previewColor: '#1e1b4b',
      description: 'Нічне індиго-небо з золотим місяцем, сузір’ями та мерехтливими зорями',
      material: new THREE.MeshLambertMaterial({
        map: celestial.texture,
        }),
      thumbnailUrl: celestial.dataUrl,
    });

    // Ceiling 6: Victorian Plaster Rosette
    const victorianRosette = createVictorianPlasterRosetteCeilingTexture();
    this.registerWallpaper({
      id: 'ceiling_victorian_rosette',
      name: 'Victorian Plaster Rosette',
      ukrainianName: 'Вікторіанська розетка',
      category: 'ceiling',
      previewColor: '#faf8f5',
      description: 'Вишукана гіпсова стельова розетка з пелюстками та концентричними молдингами',
      material: new THREE.MeshLambertMaterial({
        map: victorianRosette.texture,
        }),
      thumbnailUrl: victorianRosette.dataUrl,
    });

    // Populate thumbnails into WALLPAPER_UI_CATALOG
    for (const item of WALLPAPER_UI_CATALOG) {
      const def = this.wallpaperMap.get(item.id);
      if (def && def.thumbnailUrl) {
        item.thumbnailUrl = def.thumbnailUrl;
      }
    }
  }

  private registerWallpaper(
    def: Omit<WallpaperDef, 'materialIndex' | 'tileWidth' | 'tileHeight'> & Partial<Pick<WallpaperDef, 'tileWidth' | 'tileHeight'>>
  ): void {
    const index = this.materialList.length;
    const fullDef: WallpaperDef = {
      ...def,
      tileWidth: def.tileWidth ?? DEFAULT_WALL_TILE_SIZE,
      tileHeight: def.tileHeight ?? (def.id.startsWith('wainscot_') ? WAINSCOT_TILE_HEIGHT : DEFAULT_WALL_TILE_SIZE),
      materialIndex: index,
    };
    // Walls use world-space U coordinates, so every wallpaper must tile horizontally
    for (const tex of [def.material.map, def.material.bumpMap]) {
      if (tex && tex.wrapS !== THREE.RepeatWrapping) {
        tex.wrapS = THREE.RepeatWrapping;
        tex.needsUpdate = true;
      }
    }
    this.wallpapers.push(fullDef);
    this.wallpaperMap.set(def.id, fullDef);
    this.materialList.push(def.material);
  }

  public getAllMaterials(): THREE.Material[] {
    return this.materialList;
  }

  public getTileSize(wallpaperId?: string): { width: number; height: number } {
    const def = wallpaperId ? this.wallpaperMap.get(wallpaperId) : undefined;
    return def
      ? { width: def.tileWidth, height: def.tileHeight }
      : { width: DEFAULT_WALL_TILE_SIZE, height: DEFAULT_WALL_TILE_SIZE };
  }

  public getMaterialIndex(wallpaperId?: string): number {
    if (!wallpaperId) return 0;
    const def = this.wallpaperMap.get(wallpaperId);
    return def ? def.materialIndex : 0;
  }

  public setGridCellSize(size: number): void {
    this.gridCellSize = Math.max(0.25, Math.min(2.0, size));
  }

  public getCellKey(pieceId: string, faceSide: WallFaceSide): string {
    return `${pieceId}:${faceSide}`;
  }

  public getCellWallpaper(pieceId: string, faceSide: WallFaceSide, _col: number = 0, _row: number = 0): string {
    return this.paintedCells.get(`${pieceId}:${faceSide}`) ?? 'default';
  }

  /**
   * Applies a batch of face paint changes ('default' erases). Inside a stroke the changes are
   * accumulated into one undo step; otherwise each call is its own step.
   * Returns which meshes need rebuilding, or null when nothing actually changed.
   */
  public applyFaceChanges(
    changes: Array<{ pieceId: string; faceSide: WallFaceSide; wallpaperId: string }>
  ): PaintChangeScope | null {
    const applied: PaintChange[] = [];
    for (const c of changes) {
      const key = this.getCellKey(c.pieceId, c.faceSide);
      const before = this.paintedCells.get(key);
      const after = c.wallpaperId === 'default' ? undefined : c.wallpaperId;
      if (before === after) continue;
      this.writeKey(key, after);
      applied.push({ key, before, after });
    }
    if (applied.length === 0) return null;

    if (this.activeStroke) {
      this.activeStroke.push(...applied);
    } else {
      this.pushUndo(applied);
    }
    return WallPaintingSystem.scopeOf(applied);
  }

  public beginStroke(): void {
    this.endStroke();
    this.activeStroke = [];
  }

  public endStroke(): void {
    if (this.activeStroke && this.activeStroke.length > 0) {
      this.pushUndo(this.activeStroke);
    }
    this.activeStroke = null;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0 || (this.activeStroke?.length ?? 0) > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Reverts the last paint step. Changes on demolished pieces are skipped. */
  public undo(isPieceAlive: (pieceId: string) => boolean): PaintChangeScope | null {
    this.endStroke();
    const step = this.undoStack.pop();
    if (!step) return null;
    for (let i = step.length - 1; i >= 0; i--) {
      const c = step[i];
      if (isPieceAlive(WallPaintingSystem.pieceIdOf(c.key))) this.writeKey(c.key, c.before);
    }
    this.redoStack.push(step);
    return WallPaintingSystem.scopeOf(step);
  }

  public redo(isPieceAlive: (pieceId: string) => boolean): PaintChangeScope | null {
    this.endStroke();
    const step = this.redoStack.pop();
    if (!step) return null;
    for (const c of step) {
      if (isPieceAlive(WallPaintingSystem.pieceIdOf(c.key))) this.writeKey(c.key, c.after);
    }
    this.undoStack.push(step);
    return WallPaintingSystem.scopeOf(step);
  }

  /** Drops all paint for a demolished piece so it does not linger in saves. */
  public removePiece(pieceId: string): void {
    const prefix = `${pieceId}:`;
    for (const k of Array.from(this.paintedCells.keys())) {
      if (k.startsWith(prefix)) this.paintedCells.delete(k);
    }
    this.paintVersion++;
  }

  public clearAllCustomizations(): void {
    this.paintedCells.clear();
    this.resetHistory();
  }

  public exportPaintedCells(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, wallpaperId] of this.paintedCells.entries()) {
      result[key] = wallpaperId;
    }
    return result;
  }

  public importPaintedCells(data: Record<string, string>): void {
    this.paintedCells.clear();
    this.resetHistory();
    if (!data || typeof data !== 'object') return;
    for (const [rawKey, wallpaperId] of Object.entries(data)) {
      if (typeof wallpaperId !== 'string' || wallpaperId.length === 0 || wallpaperId === 'default') continue;
      // Older saves stored per-cell keys `${pieceId}:${face}:${col}:${row}`; collapse them to whole faces
      const parts = rawKey.split(':');
      const key = parts.length >= 4 ? `${parts[0]}:${parts[1]}` : rawKey;
      if (!this.paintedCells.has(key)) this.paintedCells.set(key, wallpaperId);
    }
  }

  public getCustomizationCount(): number {
    return this.paintedCells.size;
  }

  private writeKey(key: string, wallpaperId: string | undefined): void {
    if (wallpaperId === undefined) {
      this.paintedCells.delete(key);
    } else {
      this.paintedCells.set(key, wallpaperId);
    }
    this.paintVersion++;
  }

  private pushUndo(step: PaintChange[]): void {
    this.undoStack.push(step);
    if (this.undoStack.length > MAX_UNDO_STEPS) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private resetHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.activeStroke = null;
    this.paintVersion++;
  }

  private static pieceIdOf(key: string): string {
    return key.slice(0, key.lastIndexOf(':'));
  }

  private static scopeOf(changes: PaintChange[]): PaintChangeScope {
    const scope: PaintChangeScope = { walls: false, floors: false };
    for (const c of changes) {
      const side = c.key.slice(c.key.lastIndexOf(':') + 1);
      if (side === 'top' || side === 'bottom') scope.floors = true;
      else scope.walls = true;
    }
    return scope;
  }

  /**
   * Copies all wallpaper choices from sourcePieceId to targetPieceId.
   */
  public copyPieceStyle(sourcePieceId: string, targetPieceId: string): boolean {
    let copied = false;
    const prefix = `${sourcePieceId}:`;
    const entriesToSet: [string, string][] = [];
    for (const [key, wallpaperId] of this.paintedCells.entries()) {
      if (key.startsWith(prefix)) {
        const rest = key.substring(prefix.length);
        const newKey = `${targetPieceId}:${rest}`;
        entriesToSet.push([newKey, wallpaperId]);
        copied = true;
      }
    }
    for (const [newKey, wallpaperId] of entriesToSet) {
      this.paintedCells.set(newKey, wallpaperId);
    }
    if (copied) this.paintVersion++;
    return copied;
  }

  /**
   * Raycasts against continuous wall mesh and continuous floor mesh to target either:
   * 1. Wall exterior/interior face ('left' | 'right')
   * 2. Floor top surface ('top') or Ceiling bottom surface ('bottom')
   */
  public getHoveredCellInfo(
    raycaster: THREE.Raycaster,
    continuousWallMesh: THREE.Mesh | null,
    continuousFloorMesh: THREE.Mesh | null,
    pieces: Map<string, BuiltPiece>,
    solvedCorners: Map<string, SolvedSegmentCorners>
  ): WallCellHitInfo | null {
    const wallHits = continuousWallMesh ? raycaster.intersectObject(continuousWallMesh, false) : [];
    const floorHits = continuousFloorMesh ? raycaster.intersectObject(continuousFloorMesh, false) : [];

    // Also check unconfirmed floor meshes if continuous floor mesh is empty/building
    let unconfirmedFloorHits: THREE.Intersection[] = [];
    if (floorHits.length === 0) {
      const unconfirmedFloorObjects: THREE.Object3D[] = [];
      for (const p of pieces.values()) {
        if (
          (p.type === BuildingPieceType.WOOD_FLOOR_2X2 || p.type === BuildingPieceType.WOOD_FLOOR_1X1) &&
          p.meshGroup.visible
        ) {
          unconfirmedFloorObjects.push(p.meshGroup);
        }
      }
      if (unconfirmedFloorObjects.length > 0) {
        unconfirmedFloorHits = raycaster.intersectObjects(unconfirmedFloorObjects, true);
      }
    }

    const allHits: Array<{ hit: THREE.Intersection; type: 'wall' | 'floor' }> = [
      ...wallHits.map((h) => ({ hit: h, type: 'wall' as const })),
      ...floorHits.map((h) => ({ hit: h, type: 'floor' as const })),
      ...unconfirmedFloorHits.map((h) => ({ hit: h, type: 'floor' as const })),
    ];

    if (allHits.length === 0) return null;

    allHits.sort((a, b) => a.hit.distance - b.hit.distance);
    const closest = allHits[0];

    // ==========================================
    // 1. FLOOR & CEILING RAYCASTING LOGIC
    // ==========================================
    if (closest.type === 'floor') {
      const hit = closest.hit;
      const hitPoint = hit.point;

      // Determine face normal (top vs bottom)
      let isTop = true;
      if (hit.face) {
        const n = hit.face.normal.clone();
        if (hit.object) {
          n.applyQuaternion(hit.object.getWorldQuaternion(new THREE.Quaternion()));
        }
        isTop = n.y >= -0.05;
      } else {
        isTop = true;
      }

      const faceSide: WallFaceSide = isTop ? 'top' : 'bottom';

      // Find the best matching floor piece
      let bestFloorPiece: BuiltPiece | null = null;
      let minFloorDist = Infinity;

      for (const piece of pieces.values()) {
        if (
          piece.type !== BuildingPieceType.WOOD_FLOOR_2X2 &&
          piece.type !== BuildingPieceType.WOOD_FLOOR_1X1
        ) {
          continue;
        }

        const is1x1 = piece.type === BuildingPieceType.WOOD_FLOOR_1X1;
        const halfW = is1x1 ? 0.5 : 1.0;
        const halfL = is1x1 ? 0.5 : 1.0;

        // Height check (floor piece height thickness is ~0.06m)
        if (Math.abs(piece.position.y - hitPoint.y) > 0.45) continue;

        // Local coordinates relative to piece
        const floorRight = new THREE.Vector3(1, 0, 0).applyQuaternion(piece.quaternion);
        const floorForward = new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion);
        const fR = new THREE.Vector2(floorRight.x, floorRight.z).normalize();
        const fF = new THREE.Vector2(floorForward.x, floorForward.z).normalize();

        const dx = hitPoint.x - piece.position.x;
        const dz = hitPoint.z - piece.position.z;
        const lx = dx * fR.x + dz * fR.y;
        const lz = dx * fF.x + dz * fF.y;

        if (Math.abs(lx) <= halfW + 0.15 && Math.abs(lz) <= halfL + 0.15) {
          const dist = Math.hypot(lx, lz);
          if (dist < minFloorDist) {
            minFloorDist = dist;
            bestFloorPiece = piece;
          }
        }
      }

      if (!bestFloorPiece) return null;

      return this.buildFloorFaceInfo(bestFloorPiece, isTop);
    }

    // ==========================================
    // 2. WALL RAYCASTING LOGIC
    // ==========================================
    if (!continuousWallMesh || solvedCorners.size === 0) return null;

    const hit = closest.hit;
    const hitPoint = hit.point;
    const hitNormal = hit.face ? hit.face.normal.clone().applyQuaternion(continuousWallMesh.quaternion).normalize() : new THREE.Vector3(0, 0, 1);

    // Find the matching wall segment based on height and horizontal distance to segment baseline
    let bestPieceId: string | null = null;
    let bestCorners: SolvedSegmentCorners | null = null;
    let minDistance = Infinity;

    for (const [pieceId, corners] of solvedCorners.entries()) {
      if (hitPoint.y < corners.yBase - 0.1 || hitPoint.y > corners.yTop + 0.1) {
        continue;
      }

      // Centerline between Left and Right
      const midStartX = (corners.startLeft.x + corners.startRight.x) * 0.5;
      const midStartZ = (corners.startLeft.y + corners.startRight.y) * 0.5;
      const midEndX = (corners.endLeft.x + corners.endRight.x) * 0.5;
      const midEndZ = (corners.endLeft.y + corners.endRight.y) * 0.5;

      const segDx = midEndX - midStartX;
      const segDz = midEndZ - midStartZ;
      const segLenSq = segDx * segDx + segDz * segDz;
      if (segLenSq < 1e-4) continue;

      const t = Math.max(0, Math.min(1, ((hitPoint.x - midStartX) * segDx + (hitPoint.z - midStartZ) * segDz) / segLenSq));
      const projX = midStartX + t * segDx;
      const projZ = midStartZ + t * segDz;
      const dist = Math.hypot(hitPoint.x - projX, hitPoint.z - projZ);

      if (dist < minDistance && dist <= WALL_THICKNESS * 2.5) {
        minDistance = dist;
        bestPieceId = pieceId;
        bestCorners = corners;
      }
    }

    if (!bestPieceId || !bestCorners) return null;

    const { normL, normR } = WallPaintingSystem.getWallFaceNormals(bestCorners);
    const isLeft = hitNormal.dot(normL) >= hitNormal.dot(normR);
    return this.buildWallFaceInfo(bestPieceId, bestCorners, isLeft);
  }

  private static getWallFaceNormals(corners: SolvedSegmentCorners): { normL: THREE.Vector3; normR: THREE.Vector3 } {
    const dirL = new THREE.Vector3(corners.endLeft.x - corners.startLeft.x, 0, corners.endLeft.y - corners.startLeft.y).normalize();
    const dirR = new THREE.Vector3(corners.startRight.x - corners.endRight.x, 0, corners.startRight.y - corners.endRight.y).normalize();
    return {
      normL: new THREE.Vector3(-dirL.z, 0, dirL.x),
      normR: new THREE.Vector3(-dirR.z, 0, dirR.x),
    };
  }

  /** Full description (bounds, normal, current wallpaper) of one side of a solved wall segment. */
  private buildWallFaceInfo(pieceId: string, c: SolvedSegmentCorners, isLeft: boolean): WallCellHitInfo {
    const { yBase, yTop } = c;
    const a = isLeft ? c.startLeft : c.endRight;
    const b = isLeft ? c.endLeft : c.startRight;
    const corners = [
      new THREE.Vector3(a.x, yBase, a.y),
      new THREE.Vector3(b.x, yBase, b.y),
      new THREE.Vector3(b.x, yTop, b.y),
      new THREE.Vector3(a.x, yTop, a.y),
    ];
    const { normL, normR } = WallPaintingSystem.getWallFaceNormals(c);
    const faceSide: WallFaceSide = isLeft ? 'left' : 'right';
    return {
      pieceId,
      faceSide,
      col: 0,
      row: 0,
      worldCenter: corners[0].clone().add(corners[1]).add(corners[2]).add(corners[3]).multiplyScalar(0.25),
      worldNormal: isLeft ? normL : normR,
      corners,
      width: Math.hypot(b.x - a.x, b.y - a.y),
      height: yTop - yBase,
      numCols: 1,
      numRows: 1,
      currentWallpaperId: this.getCellWallpaper(pieceId, faceSide),
      faceLabel: isLeft ? t('paint.faceOuter') : t('paint.faceInner'),
      faceKind: isLeft ? 'outer' : 'inner',
    };
  }

  private static isFloorPieceType(type: BuildingPieceType): boolean {
    return type === BuildingPieceType.WOOD_FLOOR_2X2 || type === BuildingPieceType.WOOD_FLOOR_1X1;
  }

  private static floorHalfSize(piece: BuiltPiece): number {
    return piece.type === BuildingPieceType.WOOD_FLOOR_1X1 ? 0.5 : 1.0;
  }

  /** Full description of the top (floor) or bottom (ceiling) surface of a floor slab. */
  private buildFloorFaceInfo(piece: BuiltPiece, isTop: boolean): WallCellHitInfo {
    const half = WallPaintingSystem.floorHalfSize(piece);
    const halfThickness = 0.03;
    const surfaceY = piece.position.y + (isTop ? halfThickness : -halfThickness);
    const fRight = new THREE.Vector3(1, 0, 0).applyQuaternion(piece.quaternion);
    const fForward = new THREE.Vector3(0, 0, 1).applyQuaternion(piece.quaternion);
    const center = new THREE.Vector3(piece.position.x, surfaceY, piece.position.z);
    const corner = (sx: number, sz: number) =>
      center.clone().addScaledVector(fRight, sx * half).addScaledVector(fForward, sz * half);
    const faceSide: WallFaceSide = isTop ? 'top' : 'bottom';
    return {
      pieceId: piece.id,
      faceSide,
      col: 0,
      row: 0,
      worldCenter: center,
      worldNormal: new THREE.Vector3(0, isTop ? 1 : -1, 0),
      corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
      width: half * 2,
      height: half * 2,
      numCols: 1,
      numRows: 1,
      currentWallpaperId: this.getCellWallpaper(piece.id, faceSide),
      faceLabel: isTop ? t('paint.faceFloor') : t('paint.faceCeiling'),
      faceKind: isTop ? 'floor' : 'ceiling',
    };
  }

  /**
   * Bucket-fill region starting at `start`: every connected face of the same kind that currently
   * has the same wallpaper. Walls connect through shared mitered corner points (so an interior
   * fill wraps around the room but never jumps to the facade), floors connect edge-to-edge
   * unless a wall stands on the shared edge. Result is cached until paint or geometry changes.
   */
  public collectFillFaces(
    start: WallCellHitInfo,
    pieces: Map<string, BuiltPiece>,
    solvedCorners: Map<string, SolvedSegmentCorners>
  ): WallCellHitInfo[] {
    const cacheKey = `${start.pieceId}:${start.faceSide}:${this.paintVersion}:${pieces.size}`;
    if (this.fillCache && this.fillCache.key === cacheKey && this.fillCache.solvedCorners === solvedCorners) {
      return this.fillCache.faces;
    }

    const faces =
      start.faceSide === 'top' || start.faceSide === 'bottom'
        ? this.collectFloorFill(start, pieces, solvedCorners)
        : this.collectWallFill(start, solvedCorners);

    this.fillCache = { key: cacheKey, solvedCorners, faces };
    return faces;
  }

  private collectWallFill(start: WallCellHitInfo, solvedCorners: Map<string, SolvedSegmentCorners>): WallCellHitInfo[] {
    interface FaceNode {
      pieceId: string;
      isLeft: boolean;
      a: THREE.Vector2;
      b: THREE.Vector2;
      yBase: number;
      yTop: number;
    }
    const target = start.currentWallpaperId;
    const nodes: FaceNode[] = [];
    let startNode: FaceNode | null = null;
    for (const [pieceId, c] of solvedCorners.entries()) {
      for (const isLeft of [true, false]) {
        const side: WallFaceSide = isLeft ? 'left' : 'right';
        if (this.getCellWallpaper(pieceId, side) !== target) continue;
        const node: FaceNode = {
          pieceId,
          isLeft,
          a: isLeft ? c.startLeft : c.startRight,
          b: isLeft ? c.endLeft : c.endRight,
          yBase: c.yBase,
          yTop: c.yTop,
        };
        nodes.push(node);
        if (pieceId === start.pieceId && side === start.faceSide) startNode = node;
      }
    }
    if (!startNode) return [start];

    const near = (p: THREE.Vector2, q: THREE.Vector2) =>
      Math.abs(p.x - q.x) < FILL_POINT_EPS && Math.abs(p.y - q.y) < FILL_POINT_EPS;
    const visited = new Set<FaceNode>([startNode]);
    const queue: FaceNode[] = [startNode];
    while (queue.length > 0 && visited.size < MAX_FILL_FACES) {
      const cur = queue.shift()!;
      for (const n of nodes) {
        if (visited.has(n)) continue;
        // Must overlap vertically (only touching = a different storey or a stacked row)
        if (Math.min(cur.yTop, n.yTop) - Math.max(cur.yBase, n.yBase) < 0.05) continue;
        if (near(cur.a, n.a) || near(cur.a, n.b) || near(cur.b, n.a) || near(cur.b, n.b)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }

    const result: WallCellHitInfo[] = [];
    for (const n of visited) {
      result.push(this.buildWallFaceInfo(n.pieceId, solvedCorners.get(n.pieceId)!, n.isLeft));
    }
    return result;
  }

  private collectFloorFill(
    start: WallCellHitInfo,
    pieces: Map<string, BuiltPiece>,
    solvedCorners: Map<string, SolvedSegmentCorners>
  ): WallCellHitInfo[] {
    const startPiece = pieces.get(start.pieceId);
    if (!startPiece) return [start];
    const target = start.currentWallpaperId;
    const isTop = start.faceSide === 'top';

    const candidates: BuiltPiece[] = [];
    for (const p of pieces.values()) {
      if (!WallPaintingSystem.isFloorPieceType(p.type)) continue;
      if (Math.abs(p.position.y - startPiece.position.y) > 0.05) continue;
      if (this.getCellWallpaper(p.id, start.faceSide) !== target) continue;
      candidates.push(p);
    }

    // Wall segments standing on (or hanging under) this floor level split rooms
    const floorY = startPiece.position.y;
    const blockers: SolvedSegmentCorners[] = [];
    for (const c of solvedCorners.values()) {
      if (floorY > c.yBase - 0.5 && floorY < c.yTop + 0.5) blockers.push(c);
    }
    const edgeBlocked = (mx: number, mz: number): boolean => {
      for (const c of blockers) {
        const sx = (c.startLeft.x + c.startRight.x) * 0.5;
        const sz = (c.startLeft.y + c.startRight.y) * 0.5;
        const ex = (c.endLeft.x + c.endRight.x) * 0.5;
        const ez = (c.endLeft.y + c.endRight.y) * 0.5;
        const dx = ex - sx;
        const dz = ez - sz;
        const lenSq = dx * dx + dz * dz;
        if (lenSq < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((mx - sx) * dx + (mz - sz) * dz) / lenSq));
        if (Math.hypot(mx - (sx + t * dx), mz - (sz + t * dz)) < WALL_THICKNESS * 0.75 + 0.05) return true;
      }
      return false;
    };

    const visited = new Set<BuiltPiece>([startPiece]);
    const queue: BuiltPiece[] = [startPiece];
    while (queue.length > 0 && visited.size < MAX_FILL_FACES) {
      const cur = queue.shift()!;
      const hc = WallPaintingSystem.floorHalfSize(cur);
      for (const n of candidates) {
        if (visited.has(n)) continue;
        const hn = WallPaintingSystem.floorHalfSize(n);
        const overlapX = Math.min(cur.position.x + hc, n.position.x + hn) - Math.max(cur.position.x - hc, n.position.x - hn);
        const overlapZ = Math.min(cur.position.z + hc, n.position.z + hn) - Math.max(cur.position.z - hc, n.position.z - hn);
        // Edge-adjacent: touching along one axis while sharing a real edge along the other
        const touchX = Math.abs(overlapX) < 0.05 && overlapZ > 0.05;
        const touchZ = Math.abs(overlapZ) < 0.05 && overlapX > 0.05;
        if (!touchX && !touchZ) continue;
        let mx: number;
        let mz: number;
        if (touchX) {
          mx = cur.position.x < n.position.x ? cur.position.x + hc : cur.position.x - hc;
          mz = (Math.max(cur.position.z - hc, n.position.z - hn) + Math.min(cur.position.z + hc, n.position.z + hn)) * 0.5;
        } else {
          mz = cur.position.z < n.position.z ? cur.position.z + hc : cur.position.z - hc;
          mx = (Math.max(cur.position.x - hc, n.position.x - hn) + Math.min(cur.position.x + hc, n.position.x + hn)) * 0.5;
        }
        if (edgeBlocked(mx, mz)) continue;
        visited.add(n);
        queue.push(n);
      }
    }

    return Array.from(visited, (p) => this.buildFloorFaceInfo(p, isTop));
  }

  /** Shows a translucent overlay over every face the fill tool would paint (null hides it). */
  public updateFillPreview(faces: WallCellHitInfo[] | null, activeWallpaperId: string): void {
    if (!faces || faces.length === 0) {
      this.fillPreviewMesh.visible = false;
      this.fillPreviewFaces = null;
      return;
    }
    const activeDef = this.wallpaperMap.get(activeWallpaperId);
    if (activeDef) this.fillPreviewMaterial.color.set(activeDef.previewColor);
    this.fillPreviewMesh.visible = true;
    if (faces === this.fillPreviewFaces) return;
    this.fillPreviewFaces = faces;

    const positions = new Float32Array(faces.length * 12);
    const indices: number[] = [];
    faces.forEach((f, i) => {
      const off = f.worldNormal.clone().multiplyScalar(0.004);
      f.corners.forEach((c, k) => {
        positions[i * 12 + k * 3] = c.x + off.x;
        positions[i * 12 + k * 3 + 1] = c.y + off.y;
        positions[i * 12 + k * 3 + 2] = c.z + off.z;
      });
      const v = i * 4;
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    this.fillPreviewMesh.geometry.dispose();
    this.fillPreviewMesh.geometry = geo;
  }

  /**
   * Updates 3D hover highlight mesh to hug the targeted cell with preview color
   */
  public updateHoverHighlight(hitInfo: WallCellHitInfo | null, activeWallpaperId: string): void {
    if (!hitInfo) {
      this.hoverGroup.visible = false;
      return;
    }

    this.hoverGroup.visible = true;

    const { worldCenter, worldNormal, width, height } = hitInfo;
    const activeDef = this.wallpaperMap.get(activeWallpaperId);

    // Position highlight slightly outward along face normal to eliminate z-fighting
    const offset = worldNormal.clone().multiplyScalar(0.003);
    this.hoverGroup.position.copy(worldCenter).add(offset);

    // Align orientation with cell face normal (safely handling vertical floor/ceiling normals)
    const rotMat = new THREE.Matrix4();
    let up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(worldNormal.y) > 0.9) {
      up = new THREE.Vector3(0, 0, 1);
    }
    const right = new THREE.Vector3().crossVectors(up, worldNormal).normalize();
    const trueUp = new THREE.Vector3().crossVectors(worldNormal, right).normalize();
    rotMat.makeBasis(right, trueUp, worldNormal);
    this.hoverGroup.quaternion.setFromRotationMatrix(rotMat);

    // Scale frame and fill to cell dimensions
    this.hoverFrameLines.scale.set(width, height, 1);
    this.hoverFillMesh.scale.set(width, height, 1);

    // Preview tint
    if (activeDef) {
      this.hoverFillMaterial.color.set(activeDef.previewColor);
    }
  }

  public setHoverVisible(visible: boolean): void {
    this.hoverGroup.visible = visible;
    if (!visible) this.updateFillPreview(null, this.activeWallpaperId);
  }

  public getWallpapers(): WallpaperDef[] {
    return this.wallpapers;
  }

  public dispose(): void {
    if (this.hoverGroup.parent) {
      this.hoverGroup.parent.remove(this.hoverGroup);
    }
    if (this.fillPreviewMesh.parent) {
      this.fillPreviewMesh.parent.remove(this.fillPreviewMesh);
    }
    this.fillPreviewMesh.geometry.dispose();
    this.fillPreviewMaterial.dispose();
  }
}

export interface WallpaperUIItem {
  id: string;
  name: string;
  ukrainianName: string;
  category: 'interior' | 'exterior' | 'floor' | 'ceiling' | 'all';
  previewColor: string;
  description: string;
  tag: string;
  thumbnailUrl?: string;
}

export const WALLPAPER_UI_CATALOG: WallpaperUIItem[] = [
  // --- FLOOR CATEGORY (ПІДЛОГА) ---
  {
    id: 'floor_herringbone_parquet',
    name: 'Herringbone Parquet',
    ukrainianName: 'Паркет ялинка',
    category: 'floor',
    previewColor: '#b6834d',
    description: 'Класичний паркет ялинкою з натурального золотистого дуба з виразними фасками',
    tag: 'Паркет',
  },
  {
    id: 'floor_dark_walnut',
    name: 'Dark Walnut Planks',
    ukrainianName: 'Темний горіх (дошки)',
    category: 'floor',
    previewColor: '#301f14',
    description: 'Широкі масивні дошки темного шляхетного горіха з латунними цвяхами',
    tag: 'Дерево',
  },
  {
    id: 'floor_light_pine',
    name: 'Light Nordic Pine',
    ukrainianName: 'Скандинавська сосна',
    category: 'floor',
    previewColor: '#ecdac3',
    description: 'Світлі скандинавські соснові мостини з м’яким теплим візерунком волокон',
    tag: 'Дерево',
  },
  {
    id: 'floor_checker_marble',
    name: 'Carrara & Marquina Marble',
    ukrainianName: 'Мармурова шахова плитка',
    category: 'floor',
    previewColor: '#1e1e24',
    description: 'Розкішна чорно-біла шахова мармурова підлога з делікатними прожилками',
    tag: 'Мармур',
  },
  {
    id: 'floor_terracotta_cotto',
    name: 'Terracotta Cotto Tiles',
    ukrainianName: 'Теракотова котто плитка',
    category: 'floor',
    previewColor: '#b25332',
    description: 'Тепла середземноморська теракота ручної роботи зі світлими швами',
    tag: 'Теракота',
  },
  {
    id: 'floor_royal_carpet',
    name: 'Royal Baroque Carpet',
    ukrainianName: 'Палацовий килим',
    category: 'floor',
    previewColor: '#6b1124',
    description: 'Оксамитовий бордово-золотий палацовий килим із центральним медальйоном',
    tag: 'Килим',
  },
  {
    id: 'floor_rustic_flagstone',
    name: 'Rustic Flagstone',
    ukrainianName: 'Кам’яні плити',
    category: 'floor',
    previewColor: '#52525b',
    description: 'Натуральні кам’яні плити для тераси, передпокою або саду',
    tag: 'Камінь',
  },
  {
    id: 'floor_moroccan_mosaic',
    name: 'Moroccan Mosaic',
    ukrainianName: 'Марокканська мозаїка',
    category: 'floor',
    previewColor: '#0284c7',
    description: 'Яскравий східний мозаїчний візерунок у бірюзових та теракотових тонах',
    tag: 'Плитка',
  },

  // --- CEILING CATEGORY (СТЕЛЯ) ---
  {
    id: 'ceiling_dark_coffered',
    name: 'Dark Wood Coffered Ceiling',
    ukrainianName: 'Кесонна стеля (темний дуб)',
    category: 'ceiling',
    previewColor: '#3f2514',
    description: 'Аристократична дерев’яна кесонна стеля з глибокими нішами та розетками',
    tag: 'Кесони',
  },
  {
    id: 'ceiling_white_coffered',
    name: 'White Plaster Coffered Ceiling',
    ukrainianName: 'Біла кесонна стеля',
    category: 'ceiling',
    previewColor: '#f8fafc',
    description: 'Елегантна біла гіпсова кесонна стеля зі скульптурною ліпниною',
    tag: 'Ліпнина',
  },
  {
    id: 'ceiling_rustic_beams',
    name: 'Rustic Oak Beams on Stucco',
    ukrainianName: 'Дубові балки на штукатурці',
    category: 'ceiling',
    previewColor: '#fbf9f5',
    description: 'Масивні відкриті дубові балки з кованими накладками на білій штукатурці',
    tag: 'Балки',
  },
  {
    id: 'ceiling_white_beaded',
    name: 'White Beaded Planks',
    ukrainianName: 'Біла стельова вагонка',
    category: 'ceiling',
    previewColor: '#f8fafc',
    description: 'Свіжа котеджна біла вагонка з тонкими акуратними фасками',
    tag: 'Вагонка',
  },
  {
    id: 'ceiling_celestial_stars',
    name: 'Celestial Starry Sky',
    ukrainianName: 'Казкове зоряне небо',
    category: 'ceiling',
    previewColor: '#1e1b4b',
    description: 'Нічне індиго-небо з золотим місяцем, сузір’ями та мерехтливими зорями',
    tag: 'Зорі',
  },
  {
    id: 'ceiling_victorian_rosette',
    name: 'Victorian Plaster Rosette',
    ukrainianName: 'Вікторіанська розетка',
    category: 'ceiling',
    previewColor: '#faf8f5',
    description: 'Вишукана гіпсова стельова розетка з пелюстками та концентричними молдингами',
    tag: 'Ліпнина',
  },

  // --- WAINSCOT & INTERIOR WALLPAPERS ---
  {
    id: 'wainscot_white_wood',
    name: 'White Wood Wainscot',
    ukrainianName: 'Білий дерев’яний (як на фото)',
    category: 'interior',
    previewColor: '#f8fafc',
    description: 'Класичні білі вертикальні дерев’яні рейки з верхнім різьбленим карнизом рейлу та плінтусом',
    tag: 'Вайнскотінг',
  },
  {
    id: 'wainscot_natural_oak',
    name: 'Natural Oak Wainscot',
    ukrainianName: 'Натуральний дуб',
    category: 'interior',
    previewColor: '#be9264',
    description: 'Теплі вертикальні рейки з масиву золотого дуба з виразною текстурою волокон та фасками',
    tag: 'Вайнскотінг',
  },
  {
    id: 'wainscot_sage_green',
    name: 'Sage Heritage Wainscot',
    ukrainianName: 'Шавлієвий вікторіанський',
    category: 'interior',
    previewColor: '#798d80',
    description: 'Елегантний англійський заміський вайнскотінг заспокійливого оливково-шавлієвого відтінку',
    tag: 'Вайнскотінг',
  },
  {
    id: 'wainscot_navy_slate',
    name: 'Navy Coastal Wainscot',
    ukrainianName: 'Морський індиго',
    category: 'interior',
    previewColor: '#253443',
    description: 'Глибокі темно-сині рельєфні дерев’яні панелі у стилі Хемптонс з вишуканими світлотінями',
    tag: 'Вайнскотінг',
  },
  {
    id: 'wainscot_dark_walnut',
    name: 'Dark Walnut Wainscot',
    ukrainianName: 'Темний горіх',
    category: 'interior',
    previewColor: '#3d2516',
    description: 'Розкішне темне горіхове дерево зі скульптурним карнизом і глибокими тіньовими стиками',
    tag: 'Вайнскотінг',
  },
  {
    id: 'floral_cottage',
    name: 'Floral Cottage',
    ukrainianName: 'Квітковий котедж',
    category: 'interior',
    previewColor: '#ffb4a2',
    description: 'Затишні ніжні трояндочки на теплому кремовому тлі',
    tag: 'Шпалери',
  },
  {
    id: 'mint_beadboard',
    name: 'Mint Beadboard',
    ukrainianName: "М'ятна вагонка",
    category: 'interior',
    previewColor: '#d8e2dc',
    description: "Пастельні вертикальні дерев'яні рейки з фаскою",
    tag: 'Дерево',
  },
  {
    id: 'pink_gingham',
    name: 'Pink Gingham',
    ukrainianName: 'Рожевий гінгем',
    category: 'interior',
    previewColor: '#ff758f',
    description: 'Чарівна пастельна клітинка текстильного плетіння',
    tag: 'Шпалери',
  },
  {
    id: 'gold_damask',
    name: 'Vintage Damask',
    ukrainianName: 'Вінтажний дамаск',
    category: 'interior',
    previewColor: '#d4af37',
    description: 'Вишуканий золотистий бароковий орнамент',
    tag: 'Люкс',
  },
  {
    id: 'sage_botanical',
    name: 'Sage Botanical',
    ukrainianName: 'Шавлія ботаніка',
    category: 'interior',
    previewColor: '#7a9e7e',
    description: 'Заспокійливе оливково-шавлієве тло з листям папороті',
    tag: 'Шпалери',
  },
  {
    id: 'lavender_stars',
    name: 'Lavender Stars',
    ukrainianName: 'Лавандові зорі',
    category: 'interior',
    previewColor: '#c8b6ff',
    description: 'Казковий пастельний зоряний візерунок Heartopia',
    tag: 'Шпалери',
  },
  {
    id: 'sky_clouds',
    name: 'Sky Clouds',
    ukrainianName: 'Ніжні хмаринки',
    category: 'interior',
    previewColor: '#90e0ef',
    description: 'Небесно-блакитне тло з милими білими хмаринками',
    tag: 'Казка',
  },
  {
    id: 'scandi_geo',
    name: 'Scandi Geo',
    ukrainianName: 'Скандинавський гео',
    category: 'interior',
    previewColor: '#e07a5f',
    description: 'Сучасні пастельні геометричні фігури',
    tag: 'Модерн',
  },
  {
    id: 'subway_tile',
    name: 'White Subway Tile',
    ukrainianName: 'Біла плитка сабвей',
    category: 'all',
    previewColor: '#f8f9fa',
    description: 'Глянцева керамічна плитка зі скошеними фасками',
    tag: 'Плитка',
  },
  {
    id: 'terracotta_brick',
    name: 'Terracotta Brick',
    ukrainianName: 'Теракотова цегла',
    category: 'exterior',
    previewColor: '#ba4e28',
    description: 'Затишний фасад із теракотової цегли зі швом',
    tag: 'Фасад',
  },
  {
    id: 'oak_planks',
    name: 'Oak Facade Planks',
    ukrainianName: 'Теплий фасадний дуб',
    category: 'exterior',
    previewColor: '#ab8460',
    description: "Натуральне фасадне дерево з вертикальними стиками",
    tag: 'Фасад',
  },
  {
    id: 'cobblestone',
    name: 'Cottage Cobblestone',
    ukrainianName: 'Англійський камінь',
    category: 'exterior',
    previewColor: '#a5a58d',
    description: 'Рустикальна кладка з округлого річкового каменю',
    tag: 'Фасад',
  },
  {
    id: 'cream_stucco',
    name: 'Cream Stucco',
    ukrainianName: 'Кремова штукатурка',
    category: 'exterior',
    previewColor: '#f8f6f0',
    description: 'Стильна архітектурна штукатурка з мінеральною крихтою',
    tag: 'Фасад',
  },
  {
    id: 'default',
    name: 'Classic Wall',
    ukrainianName: 'Базовий чекер',
    category: 'all',
    previewColor: '#64748b',
    description: 'Стандартна поверхня стіни',
    tag: 'Базова',
  },
];
