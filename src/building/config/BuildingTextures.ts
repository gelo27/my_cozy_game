import * as THREE from 'three';

// Procedural texture generator for stylized Norse wood and stone
export function createNorseWoodTexture(): THREE.CanvasTexture {
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

export function createChiseledStoneTexture(): THREE.CanvasTexture {
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

export function createThatchRoofTexture(): THREE.CanvasTexture {
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

