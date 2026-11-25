import * as THREE from 'three';

export interface GeneratedTextureResult {
  texture: THREE.CanvasTexture;
  dataUrl: string;
}

/**
 * 9. Classic Dark Wood Coffered Ceiling (Кесонна стеля темний дуб)
 */
export function createDarkWoodCofferedCeilingTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);


  ctx.fillStyle = '#3f2514';
  ctx.fillRect(0, 0, 512, 512);

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

    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;


  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 10. White Coffered Plaster Ceiling (Біла кесонна стеля з ліпниною)
 */
export function createWhiteCofferedCeilingTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);


  // Warm cream stucco base
  ctx.fillStyle = '#fbf9f5';
  ctx.fillRect(0, 0, 512, 512);

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

  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;


  return { texture, dataUrl: canvas.toDataURL('image/png') };
}

/**
 * 12. White Beaded Ceiling Planks (Біла стельова вагонка)
 */
export function createWhiteBeadedPlanksCeilingTexture(): GeneratedTextureResult {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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
