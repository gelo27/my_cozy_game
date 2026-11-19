import * as THREE from 'three';

/** Default physical size of a square 128px wallpaper repeat on walls. */
export const DEFAULT_WALL_TILE_SIZE = 2.0;
/** Wainscot textures are composites: 1m panel at the bottom, painted wall above, 4m tall in total. */
export const WAINSCOT_TILE_HEIGHT = 4.0;
export const WAINSCOT_PANEL_HEIGHT = 1.0;

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
  dataUrl: string;
} {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);


  // 1. Base Fill
  ctx.fillStyle = options.baseColor;
  ctx.fillRect(0, 0, 512, 512);


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


  // 6. Compose the real wall: panel squeezed into the bottom metre, painted wall above it.
  // Keep the logical 512px drawing grid; the canvas context downsamples it to 128px on output.
  const pxPerMeter = 512 / DEFAULT_WALL_TILE_SIZE;
  const fullH = WAINSCOT_TILE_HEIGHT * pxPerMeter;
  const panelH = WAINSCOT_PANEL_HEIGHT * pxPerMeter;
  const upperColor = options.upperWallColor ?? '#f2ece1';

  const wall = document.createElement('canvas');
  wall.width = 128;
  wall.height = fullH / 4;
  const wctx = wall.getContext('2d')!;
  wctx.scale(0.25, 0.25);
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
  wctx.drawImage(canvas, 0, 0, 128, 128, 0, fullH - panelH, 512, panelH);


  const texture = new THREE.CanvasTexture(wall);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping; // taller walls just continue the paint colour
  texture.colorSpace = THREE.SRGBColorSpace;


  // Thumbnail: the bottom 2m of the wall, so the swatch shows the panel under painted wall
  const thumb = document.createElement('canvas');
  thumb.width = 256;
  thumb.height = 256;
  thumb.getContext('2d')!.drawImage(wall, 0, fullH / 4 - 128, 128, 128, 0, 0, 256, 256);

  return { texture, dataUrl: thumb.toDataURL('image/png') };
}

export function createFloralWallpaperTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

export function createMintBeadboardTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

export function createPinkGinghamTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

export function createGoldDamaskTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

export function createTerracottaBrickTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

export function createSubwayTileTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

export function createSageBotanicalTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

export function createLavenderStarsTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

/** Small, hand-drawn cottage patterns with a compact square repeat for true-to-life wall scale. */
export function createCozyWallpaperTexture(
  style: 'tiny_fruit' | 'tulip_sprig' | 'gingham_blue' | 'mushroom',
): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const bg: Record<typeof style, string> = {
    tiny_fruit: '#fff7e8', tulip_sprig: '#f8f3e7', gingham_blue: '#edf5f7', mushroom: '#f4eee2',
  };
  ctx.fillStyle = bg[style];
  ctx.fillRect(0, 0, 256, 256);

  if (style === 'gingham_blue') {
    const size = 32;
    for (let y = 0; y < 256; y += size) for (let x = 0; x < 256; x += size) {
      ctx.fillStyle = ((x / size + y / size) % 2) ? 'rgba(111,164,184,.24)' : 'rgba(111,164,184,.08)';
      ctx.fillRect(x, y, size, size);
    }
    ctx.strokeStyle = 'rgba(255,255,255,.48)';
    ctx.lineWidth = 2;
    for (let p = 0; p <= 256; p += size) { ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 256); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(256, p); ctx.stroke(); }
  } else {
    for (let y = 32; y < 256; y += 64) for (let x = 32; x < 256; x += 64) {
      ctx.save(); ctx.translate(x + ((y / 64) % 2) * 16, y);
      if (style === 'tiny_fruit') {
        ctx.strokeStyle = '#7f9a69'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(0, 2); ctx.stroke();
        ctx.fillStyle = '#e77a63'; ctx.beginPath(); ctx.arc(-6, 7, 7, 0, Math.PI * 2); ctx.arc(6, 7, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f3cf78'; ctx.beginPath(); ctx.arc(0, 7, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#8daa72'; ctx.beginPath(); ctx.ellipse(5, -5, 7, 3, -.5, 0, Math.PI * 2); ctx.fill();
      } else if (style === 'tulip_sprig') {
        ctx.strokeStyle = '#79956c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 18); ctx.quadraticCurveTo(-2, 0, 0, -10); ctx.stroke();
        ctx.fillStyle = '#8eaa78'; ctx.beginPath(); ctx.ellipse(-7, 8, 8, 3, -.6, 0, Math.PI * 2); ctx.ellipse(7, 2, 8, 3, .6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#df8990'; ctx.beginPath(); ctx.moveTo(-8, -8); ctx.quadraticCurveTo(-10, -19, -4, -14); ctx.quadraticCurveTo(0, -22, 4, -14); ctx.quadraticCurveTo(10, -19, 8, -8); ctx.quadraticCurveTo(0, -1, -8, -8); ctx.fill();
      } else {
        ctx.fillStyle = '#9a7055'; ctx.beginPath(); ctx.ellipse(0, 1, 15, 9, 0, Math.PI, Math.PI * 2); ctx.lineTo(7, 17); ctx.quadraticCurveTo(0, 20, -7, 17); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#f4dfb7'; ctx.fillRect(-5, 4, 10, 12);
        ctx.fillStyle = '#f1d8a6'; ctx.beginPath(); ctx.arc(-6, -3, 2, 0, Math.PI * 2); ctx.arc(5, -6, 2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#8ca879'; ctx.beginPath(); ctx.ellipse(14, 13, 7, 3, -.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

export function createOakPlanksTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

export function createCobblestoneTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

export function createSkyCloudsTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

export function createCreamStuccoTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

export function createScandiGeoTexture(): { texture: THREE.CanvasTexture; dataUrl: string } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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
