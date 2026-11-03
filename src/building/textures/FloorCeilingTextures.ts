import * as THREE from 'three';

export interface GeneratedTextureResult {
  texture: THREE.CanvasTexture;
  bumpMap?: THREE.CanvasTexture;
  dataUrl: string;
}

/**
 * 1. Herringbone Parquet (Паркет ялинка)
 * High-detail parquet slats arranged in 90-degree interlocking herringbone pattern.
 */
export function createHerringboneParquetTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 512;
  bumpCanvas.height = 512;
  const bctx = bumpCanvas.getContext('2d')!;

  ctx.fillStyle = '#b6834d';
  ctx.fillRect(0, 0, 512, 512);
  bctx.fillStyle = '#808080';
  bctx.fillRect(0, 0, 512, 512);

  const slatW = 32;
  const slatL = 96;

  // Draw herringbone blocks in a repeat grid
  for (let y = -96; y <= 512 + 96; y += 96) {
    for (let x = -96; x <= 512 + 96; x += 192) {
      const offsetX = ((y / 96) % 2 === 0) ? 0 : 96;
      const px = x + offsetX;

      // Group 1: vertical slat
      ctx.save();
      ctx.translate(px, y);
      const grad1 = ctx.createLinearGradient(0, 0, slatW, 0);
      grad1.addColorStop(0, '#cca06c');
      grad1.addColorStop(0.5, '#ba8b55');
      grad1.addColorStop(1, '#9e703c');
      ctx.fillStyle = grad1;
      ctx.fillRect(1, 1, slatW - 2, slatL - 2);

      // Slat micro wood grains
      ctx.fillStyle = 'rgba(80, 50, 20, 0.15)';
      ctx.fillRect(6, 2, 2, slatL - 4);
      ctx.fillRect(18, 2, 1, slatL - 4);

      // Bevel & border
      ctx.strokeStyle = '#5a3818';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(0.5, 0.5, slatW - 1, slatL - 1);
      ctx.restore();

      // Bump
      bctx.fillStyle = '#e0e0e0';
      bctx.fillRect(px + 2, y + 2, slatW - 4, slatL - 4);
      bctx.strokeStyle = '#202020';
      bctx.lineWidth = 2;
      bctx.strokeRect(px + 0.5, y + 0.5, slatW - 1, slatL - 1);

      // Group 2: horizontal slat next to it
      const hx = px + slatW;
      const hy = y + slatL - slatW;
      ctx.save();
      ctx.translate(hx, hy);
      const grad2 = ctx.createLinearGradient(0, 0, 0, slatW);
      grad2.addColorStop(0, '#cca06c');
      grad2.addColorStop(0.5, '#b3824c');
      grad2.addColorStop(1, '#966734');
      ctx.fillStyle = grad2;
      ctx.fillRect(1, 1, slatL - 2, slatW - 2);

      // Horizontal wood grain
      ctx.fillStyle = 'rgba(80, 50, 20, 0.15)';
      ctx.fillRect(2, 6, slatL - 4, 2);
      ctx.fillRect(2, 18, slatL - 4, 1);

      ctx.strokeStyle = '#5a3818';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(0.5, 0.5, slatL - 1, slatW - 1);
      ctx.restore();

      bctx.fillStyle = '#e0e0e0';
      bctx.fillRect(hx + 2, hy + 2, slatL - 4, slatW - 4);
      bctx.strokeStyle = '#202020';
      bctx.lineWidth = 2;
      bctx.strokeRect(hx + 0.5, hy + 0.5, slatL - 1, slatW - 1);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;

  return { texture, bumpMap, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 2. Dark Walnut Floor Planks (Темні горіхові дошки)
 */
export function createDarkWalnutFloorTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 512;
  bumpCanvas.height = 512;
  const bctx = bumpCanvas.getContext('2d')!;

  ctx.fillStyle = '#301f14';
  ctx.fillRect(0, 0, 512, 512);
  bctx.fillStyle = '#808080';
  bctx.fillRect(0, 0, 512, 512);

  const plankH = 64;
  for (let y = 0; y < 512; y += plankH) {
    const grad = ctx.createLinearGradient(0, y, 0, y + plankH);
    grad.addColorStop(0, '#4a3222');
    grad.addColorStop(0.1, '#412c1e');
    grad.addColorStop(0.85, '#352317');
    grad.addColorStop(1, '#24160d');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y + 1, 512, plankH - 2);

    // Subtle dark wood knotting and grain fibers
    ctx.fillStyle = 'rgba(20, 10, 5, 0.25)';
    for (let k = 0; k < 6; k++) {
      ctx.fillRect(0, y + 8 + k * 9, 512, 2);
    }

    // Staggered plank butt joints
    const jointX = ((y / plankH) * 170) % 512;
    ctx.fillStyle = '#180c06';
    ctx.fillRect(jointX, y, 3, plankH);

    // Brass screw / nail dots near joints
    ctx.fillStyle = '#bfa15f';
    ctx.beginPath();
    ctx.arc(jointX - 8, y + 16, 2, 0, Math.PI * 2);
    ctx.arc(jointX - 8, y + plankH - 16, 2, 0, Math.PI * 2);
    ctx.arc(jointX + 11, y + 16, 2, 0, Math.PI * 2);
    ctx.arc(jointX + 11, y + plankH - 16, 2, 0, Math.PI * 2);
    ctx.fill();

    // Groove
    ctx.fillStyle = '#140a05';
    ctx.fillRect(0, y + plankH - 2, 512, 2);

    // Bump
    bctx.fillStyle = '#e8e8e8';
    bctx.fillRect(0, y + 2, 512, plankH - 4);
    bctx.fillStyle = '#101010';
    bctx.fillRect(0, y + plankH - 2, 512, 2);
    bctx.fillRect(jointX, y, 3, plankH);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;

  return { texture, bumpMap, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 3. Light Nordic Pine Floor (Світла скандинавська сосна)
 */
export function createLightPineFloorTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#ecdac3';
  ctx.fillRect(0, 0, 512, 512);

  const plankW = 64;
  for (let x = 0; x < 512; x += plankW) {
    const grad = ctx.createLinearGradient(x, 0, x + plankW, 0);
    grad.addColorStop(0, '#f9ede0');
    grad.addColorStop(0.15, '#ecdac3');
    grad.addColorStop(0.85, '#e0caa9');
    grad.addColorStop(1, '#c5ad8a');
    ctx.fillStyle = grad;
    ctx.fillRect(x + 1, 0, plankW - 2, 512);

    // Pine grain waves
    ctx.fillStyle = 'rgba(150, 110, 70, 0.1)';
    for (let g = 0; g < 5; g++) {
      ctx.fillRect(x + 6 + g * 10, 0, 2, 512);
    }

    // Soft pine knots
    const knotY = ((x / plankW) * 140 + 60) % 450;
    ctx.fillStyle = '#a6825c';
    ctx.beginPath();
    ctx.ellipse(x + 32, knotY, 8, 14, 0.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#bfa585';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, 0, plankW - 1, 512);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 4. Marble Checker Floor Tiles (Мармурова чорно-біла шахова плитка)
 */
export function createCheckerMarbleFloorTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#1e1e24';
  ctx.fillRect(0, 0, 512, 512);

  const tileSize = 128;
  for (let y = 0; y < 512; y += tileSize) {
    for (let x = 0; x < 512; x += tileSize) {
      const isWhite = ((x / tileSize) + (y / tileSize)) % 2 === 0;

      if (isWhite) {
        // White Carrara Marble
        const grad = ctx.createLinearGradient(x, y, x + tileSize, y + tileSize);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.5, '#f4f4f6');
        grad.addColorStop(1, '#e5e7eb');
        ctx.fillStyle = grad;
        ctx.fillRect(x + 2, y + 2, tileSize - 4, tileSize - 4);

        // Grey marble veins
        ctx.strokeStyle = 'rgba(160, 165, 175, 0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + 10, y + 20);
        ctx.bezierCurveTo(x + 40, y + 70, x + 80, y + 40, x + 110, y + 100);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(180, 185, 195, 0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 30, y + 110);
        ctx.lineTo(x + 90, y + 20);
        ctx.stroke();
      } else {
        // Black Marquina Marble
        const grad = ctx.createLinearGradient(x, y, x + tileSize, y + tileSize);
        grad.addColorStop(0, '#2d2d35');
        grad.addColorStop(0.5, '#1e1e24');
        grad.addColorStop(1, '#111116');
        ctx.fillStyle = grad;
        ctx.fillRect(x + 2, y + 2, tileSize - 4, tileSize - 4);

        // White marble veins on dark
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + 20, y + 15);
        ctx.bezierCurveTo(x + 60, y + 45, x + 50, y + 90, x + 105, y + 115);
        ctx.stroke();
      }

      // Tile grout joint
      ctx.strokeStyle = '#4b5563';
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 1.5, y + 1.5, tileSize - 3, tileSize - 3);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 5. Terracotta Cotto Floor Tiles (Теракотова плитка)
 */
export function createTerracottaCottoFloorTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#b25332';
  ctx.fillRect(0, 0, 512, 512);

  const tileSize = 128;
  const colors = ['#c85e3a', '#b85230', '#d66a46', '#a64727'];

  for (let y = 0; y < 512; y += tileSize) {
    for (let x = 0; x < 512; x += tileSize) {
      const colIdx = ((x / tileSize) * 3 + (y / tileSize) * 7) % colors.length;
      ctx.fillStyle = colors[colIdx];
      ctx.beginPath();
      ctx.roundRect(x + 4, y + 4, tileSize - 8, tileSize - 8, 4);
      ctx.fill();

      // Soft terracotta clay gradient
      const radial = ctx.createRadialGradient(x + 64, y + 64, 10, x + 64, y + 64, 60);
      radial.addColorStop(0, 'rgba(255, 180, 140, 0.25)');
      radial.addColorStop(1, 'rgba(60, 20, 10, 0.2)');
      ctx.fillStyle = radial;
      ctx.beginPath();
      ctx.roundRect(x + 4, y + 4, tileSize - 8, tileSize - 8, 4);
      ctx.fill();

      // Mortar joint
      ctx.strokeStyle = '#ddc4a8';
      ctx.lineWidth = 6;
      ctx.strokeRect(x + 3, y + 3, tileSize - 6, tileSize - 6);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 6. Royal Baroque Carpet (Королівський палацовий килим)
 */
export function createRoyalCarpetFloorTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Deep burgundy base
  ctx.fillStyle = '#6b1124';
  ctx.fillRect(0, 0, 512, 512);

  // Outer gold filigree frame
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 12;
  ctx.strokeRect(16, 16, 480, 480);

  ctx.strokeStyle = '#fef08a';
  ctx.lineWidth = 2;
  ctx.strokeRect(26, 26, 460, 460);

  // Center medallion
  ctx.fillStyle = '#83182e';
  ctx.beginPath();
  ctx.arc(256, 256, 140, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(256, 256, 140, 0, Math.PI * 2);
  ctx.stroke();

  // 8-point gold rosette center
  ctx.fillStyle = '#d4af37';
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4;
    const px = 256 + Math.cos(angle) * 70;
    const py = 256 + Math.sin(angle) * 70;
    ctx.beginPath();
    ctx.arc(px, py, 14, 0, Math.PI * 2);
    ctx.fill();
  }

  // Corner motifs
  const corners = [
    { x: 50, y: 50 },
    { x: 462, y: 50 },
    { x: 50, y: 462 },
    { x: 462, y: 462 },
  ];
  for (const c of corners) {
    ctx.fillStyle = '#d4af37';
    ctx.beginPath();
    ctx.arc(c.x, c.y, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#6b1124';
    ctx.beginPath();
    ctx.arc(c.x, c.y, 12, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 7. Rustic Flagstone Floor (Кам'яні плити)
 */
export function createFlagstonePaversFloorTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#52525b';
  ctx.fillRect(0, 0, 512, 512);

  const colors = ['#71717a', '#78716c', '#a1a1aa', '#57534e', '#64748b'];
  const grid = 64;

  for (let y = 0; y < 512; y += grid) {
    for (let x = 0; x < 512; x += grid) {
      const shiftX = ((y / grid) % 2) * 24;
      const px = x + shiftX;
      const c = colors[(x * 5 + y * 11) % colors.length];

      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.roundRect(px + 2, y + 2, grid - 4, grid - 4, 8);
      ctx.fill();

      // Highlight bevel
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Deep mortar
      ctx.strokeStyle = '#27272a';
      ctx.lineWidth = 3;
      ctx.strokeRect(px + 0.5, y + 0.5, grid - 1, grid - 1);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 8. Moroccan Mosaic Floor (Марокканська мозаїка)
 */
export function createMoroccanMosaicFloorTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, 512, 512);

  const step = 128;
  for (let y = 0; y < 512; y += step) {
    for (let x = 0; x < 512; x += step) {
      const cx = x + step / 2;
      const cy = y + step / 2;

      // Outer teal square
      ctx.fillStyle = '#0284c7';
      ctx.beginPath();
      ctx.moveTo(cx, y + 8);
      ctx.lineTo(x + step - 8, cy);
      ctx.lineTo(cx, y + step - 8);
      ctx.lineTo(x + 8, cy);
      ctx.closePath();
      ctx.fill();

      // Inner turquoise diamond
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(cx, cy, 32, 0, Math.PI * 2);
      ctx.fill();

      // Center gold star
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(cx, cy, 14, 0, Math.PI * 2);
      ctx.fill();

      // Corner navy dots
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(x + 8, y + 8, 8, 0, Math.PI * 2);
      ctx.arc(x + step - 8, y + 8, 8, 0, Math.PI * 2);
      ctx.arc(x + 8, y + step - 8, 8, 0, Math.PI * 2);
      ctx.arc(x + step - 8, y + step - 8, 8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

// =========================================================================
// CEILING TEXTURES (СТЕЛЬОВІ ТЕКСТУРИ)
// =========================================================================

/**
 * 9. Classic Dark Wood Coffered Ceiling (Кесонна стеля темний дуб)
 */
export function createDarkWoodCofferedCeilingTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 512;
  bumpCanvas.height = 512;
  const bctx = bumpCanvas.getContext('2d')!;

  ctx.fillStyle = '#3f2514';
  ctx.fillRect(0, 0, 512, 512);
  bctx.fillStyle = '#808080';
  bctx.fillRect(0, 0, 512, 512);

  const boxSize = 256;
  const frameW = 36;

  for (let y = 0; y < 512; y += boxSize) {
    for (let x = 0; x < 512; x += boxSize) {
      // Raised beam border
      const beamGrad = ctx.createLinearGradient(x, y, x + boxSize, y + boxSize);
      beamGrad.addColorStop(0, '#58361e');
      beamGrad.addColorStop(0.5, '#482c18');
      beamGrad.addColorStop(1, '#321c0e');
      ctx.fillStyle = beamGrad;
      ctx.fillRect(x, y, boxSize, boxSize);

      // Recessed interior square
      const inX = x + frameW;
      const inY = y + frameW;
      const inSize = boxSize - frameW * 2;

      // Deep recessed panel gradient (ambient occlusion shadow at top-left)
      const shadowGrad = ctx.createLinearGradient(inX, inY, inX + inSize, inY + inSize);
      shadowGrad.addColorStop(0, '#1c0f07');
      shadowGrad.addColorStop(0.3, '#2a170b');
      shadowGrad.addColorStop(0.7, '#3d2312');
      shadowGrad.addColorStop(1, '#53311a');
      ctx.fillStyle = shadowGrad;
      ctx.fillRect(inX, inY, inSize, inSize);

      // Inner molded stepped bevel
      ctx.strokeStyle = '#6f4528';
      ctx.lineWidth = 3;
      ctx.strokeRect(inX + 8, inY + 8, inSize - 16, inSize - 16);

      // Center decorative rosette / medallion
      const cx = inX + inSize / 2;
      const cy = inY + inSize / 2;
      ctx.fillStyle = '#653e23';
      ctx.beginPath();
      ctx.arc(cx, cy, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#8f5c36';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Bump map
      bctx.fillStyle = '#ffffff'; // high beams
      bctx.fillRect(x, y, boxSize, boxSize);
      bctx.fillStyle = '#202020'; // sunken center
      bctx.fillRect(inX, inY, inSize, inSize);
      bctx.fillStyle = '#707070'; // rosette
      bctx.beginPath();
      bctx.arc(cx, cy, 24, 0, Math.PI * 2);
      bctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;

  return { texture, bumpMap, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 10. White Coffered Plaster Ceiling (Біла кесонна стеля з ліпниною)
 */
export function createWhiteCofferedCeilingTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, 512, 512);

  const boxSize = 256;
  const frameW = 32;

  for (let y = 0; y < 512; y += boxSize) {
    for (let x = 0; x < 512; x += boxSize) {
      // Outer white beam
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, boxSize, boxSize);

      // Recessed box
      const inX = x + frameW;
      const inY = y + frameW;
      const inSize = boxSize - frameW * 2;

      const shadowGrad = ctx.createLinearGradient(inX, inY, inX + inSize, inY + inSize);
      shadowGrad.addColorStop(0, '#cbd5e1');
      shadowGrad.addColorStop(0.25, '#e2e8f0');
      shadowGrad.addColorStop(0.85, '#f1f5f9');
      shadowGrad.addColorStop(1, '#ffffff');
      ctx.fillStyle = shadowGrad;
      ctx.fillRect(inX, inY, inSize, inSize);

      // Inner molding step
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2;
      ctx.strokeRect(inX + 10, inY + 10, inSize - 20, inSize - 20);

      // Center delicate flower relief
      const cx = inX + inSize / 2;
      const cy = inY + inSize / 2;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 11. Rustic Oak Beams on Stucco (Балки з масиву дуба на білій штукатурці)
 */
export function createRusticOakBeamsCeilingTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = 512;
  bumpCanvas.height = 512;
  const bctx = bumpCanvas.getContext('2d')!;

  // Warm cream stucco base
  ctx.fillStyle = '#fbf9f5';
  ctx.fillRect(0, 0, 512, 512);
  bctx.fillStyle = '#707070';
  bctx.fillRect(0, 0, 512, 512);

  // Stucco grain
  ctx.fillStyle = 'rgba(180, 170, 155, 0.15)';
  for (let i = 0; i < 400; i++) {
    const rx = (i * 137) % 512;
    const ry = (i * 269) % 512;
    ctx.fillRect(rx, ry, 3, 3);
  }

  // 2 Massive solid oak timber beams running horizontally
  const beamPositions = [96, 352];
  const beamH = 64;

  for (const by of beamPositions) {
    // Ambient drop shadow beneath the beam
    const dropShadow = ctx.createLinearGradient(0, by + beamH, 0, by + beamH + 24);
    dropShadow.addColorStop(0, 'rgba(40, 25, 15, 0.45)');
    dropShadow.addColorStop(1, 'rgba(40, 25, 15, 0)');
    ctx.fillStyle = dropShadow;
    ctx.fillRect(0, by + beamH, 512, 24);

    // Beam wood body
    const beamGrad = ctx.createLinearGradient(0, by, 0, by + beamH);
    beamGrad.addColorStop(0, '#a5794d');
    beamGrad.addColorStop(0.2, '#91653c');
    beamGrad.addColorStop(0.8, '#784e27');
    beamGrad.addColorStop(1, '#533114');
    ctx.fillStyle = beamGrad;
    ctx.fillRect(0, by, 512, beamH);

    // Deep wood splits & grain fibers
    ctx.fillStyle = 'rgba(45, 25, 10, 0.4)';
    ctx.fillRect(0, by + 12, 512, 2);
    ctx.fillRect(0, by + 34, 512, 3);
    ctx.fillRect(0, by + 48, 512, 2);

    // Wrought iron straps / bolts
    for (let bx = 64; bx < 512; bx += 192) {
      ctx.fillStyle = '#1e1b18';
      ctx.fillRect(bx, by - 4, 16, beamH + 8);
      ctx.fillStyle = '#e5e7eb';
      ctx.beginPath();
      ctx.arc(bx + 8, by + 16, 3, 0, Math.PI * 2);
      ctx.arc(bx + 8, by + beamH - 16, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Bump map for high beam relief
    bctx.fillStyle = '#ffffff';
    bctx.fillRect(0, by, 512, beamH);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;

  return { texture, bumpMap, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 12. White Beaded Ceiling Planks (Біла стельова вагонка)
 */
export function createWhiteBeadedPlanksCeilingTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, 512, 512);

  const plankW = 32;
  for (let x = 0; x < 512; x += plankW) {
    const grad = ctx.createLinearGradient(x, 0, x + plankW, 0);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.15, '#f8fafc');
    grad.addColorStop(0.85, '#eef2f6');
    grad.addColorStop(1, '#cbd5e1');
    ctx.fillStyle = grad;
    ctx.fillRect(x + 1, 0, plankW - 2, 512);

    // Center micro bead
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + plankW / 2 - 1, 0, 2, 512);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + plankW / 2 - 1.5, 0, 3, 512);

    // Joint groove
    ctx.fillStyle = '#94a3b8';
    ctx.fillRect(x + plankW - 2, 0, 2, 512);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 13. Celestial Starry Night Sky Ceiling (Казкове зоряне небо)
 */
export function createCelestialStarryCeilingTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Deep indigo galaxy gradient
  const bgGrad = ctx.createRadialGradient(256, 256, 40, 256, 256, 320);
  bgGrad.addColorStop(0, '#2e1065');
  bgGrad.addColorStop(0.5, '#1e1b4b');
  bgGrad.addColorStop(1, '#09071f');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, 512, 512);

  // Soft purple/gold nebula clouds
  const nebula = ctx.createRadialGradient(180, 200, 10, 180, 200, 160);
  nebula.addColorStop(0, 'rgba(236, 72, 153, 0.25)');
  nebula.addColorStop(1, 'rgba(236, 72, 153, 0)');
  ctx.fillStyle = nebula;
  ctx.fillRect(0, 0, 512, 512);

  // Glowing Golden Moon in center
  ctx.fillStyle = '#fef08a';
  ctx.beginPath();
  ctx.arc(256, 256, 32, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#2e1065';
  ctx.beginPath();
  ctx.arc(270, 246, 28, 0, Math.PI * 2);
  ctx.fill();

  // Golden Constellations & 8-point stars
  const stars = [
    { x: 80, y: 80, s: 18 },
    { x: 420, y: 100, s: 22 },
    { x: 100, y: 400, s: 16 },
    { x: 400, y: 420, s: 20 },
    { x: 160, y: 280, s: 12 },
    { x: 360, y: 220, s: 14 },
    { x: 256, y: 90, s: 16 },
    { x: 256, y: 430, s: 16 },
  ];

  ctx.fillStyle = '#fef08a';
  for (const st of stars) {
    ctx.beginPath();
    ctx.moveTo(st.x, st.y - st.s);
    ctx.quadraticCurveTo(st.x, st.y, st.x + st.s, st.y);
    ctx.quadraticCurveTo(st.x, st.y, st.x, st.y + st.s);
    ctx.quadraticCurveTo(st.x, st.y, st.x - st.s, st.y);
    ctx.quadraticCurveTo(st.x, st.y, st.x, st.y - st.s);
    ctx.fill();
  }

  // Constellation connecting lines
  ctx.strokeStyle = 'rgba(254, 240, 138, 0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(80, 80);
  ctx.lineTo(256, 90);
  ctx.lineTo(420, 100);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(100, 400);
  ctx.lineTo(256, 430);
  ctx.lineTo(400, 420);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 14. Victorian Plaster Rosette Ceiling (Вікторіанська розетка)
 */
export function createVictorianPlasterRosetteCeilingTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#faf8f5';
  ctx.fillRect(0, 0, 512, 512);

  // Large center circular medallion
  const cx = 256;
  const cy = 256;

  // Concentric plaster rings with soft shadows
  const rings = [210, 170, 130, 90, 50];
  for (const r of rings) {
    ctx.strokeStyle = '#e7e3dc';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 12 Petals around the center
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#d6d0c4';
  ctx.lineWidth = 2;
  for (let i = 0; i < 12; i++) {
    const angle = (i * Math.PI) / 6;
    const px = cx + Math.cos(angle) * 70;
    const py = cy + Math.sin(angle) * 70;
    ctx.beginPath();
    ctx.ellipse(px, py, 18, 10, angle, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Center button
  ctx.fillStyle = '#f3efe8';
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#c8bfb0';
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  return { texture, dataUrl: canvas.toDataURL('image/png') };
}
