import * as THREE from 'three';

export type RoofType = 'gable' | 'hip' | 'shed';

export interface ProceduralRoofConfig {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  roofType: RoofType;

  // Constraints & dimensions
  minSize?: number;
  minHeight?: number;
  maxHeight?: number;
  snapSize?: number;

  // Overhangs & fascia parameters (Sims 4 architectural styling)
  overhang?: number;
  eaveOverhang?: number;
  gableOverhang?: number;
  ridgeOverhang?: number;
  fasciaDepth?: number;

  // Texture scale
  uvScale?: number;
}

export const DEFAULT_ROOF_CONFIG: ProceduralRoofConfig = {
  minX: -1.0,
  maxX: 1.0,
  minZ: -1.0,
  maxZ: 1.0,
  height: 0.85,
  roofType: 'gable',
  minSize: 0.2,
  minHeight: 0.1,
  maxHeight: 5.0,
  snapSize: 0.5,
  overhang: 0.22,
  eaveOverhang: 0.25,
  gableOverhang: 0.30,
  ridgeOverhang: 0.22,
  fasciaDepth: 0.135,
  uvScale: 1.0,
};

export interface RoofBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  groups: Array<{ start: number; count: number; materialIndex: number }>;
}

export interface RoofParams {
  width: number;
  length: number;
  pitchHeight: number;
  overhang: number;
  thickness: number;
  hasFrontons?: boolean;
}

export type RoofStyle = 'barkwood' | 'sunrise' | 'mission' | 'blue_slate' | 'terracotta' | 'wood_shingles';

// =========================================================================
// PROCEDURAL SIMS 4 SHINGLE TEXTURE GENERATORS
// 100% SEAMLESS, TILEABLE SHINGLE COURSES (NO RIDGE STRIPES ON SLOPES!)
// The ridge cap (коньок) is generated ONLY as dedicated 3D apex geometry!
// =========================================================================

export function createSims4ShingleTexture(
  primaryColor: string,
  secondaryColor: string,
  highlightColor: string,
  shadowColor: string
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Base background fill
  ctx.fillStyle = secondaryColor;
  ctx.fillRect(0, 0, 512, 512);

  const rows = 8;
  const cols = 8;
  const rowH = 512 / rows; // exactly 64px per course for perfect power-of-2 tiling
  const colW = 512 / cols; // exactly 64px per shingle

  for (let r = 0; r < rows; r++) {
    const y = r * rowH;
    const isOdd = r % 2 === 1;
    const xOffset = isOdd ? colW / 2 : 0;

    for (let c = -1; c <= cols + 1; c++) {
      const x = c * colW + xOffset;
      const shingleW = colW - 2;
      const shingleH = rowH + 2;

      // Realistic shingle depth gradient (lip highlight to body shadow)
      const grad = ctx.createLinearGradient(x, y, x, y + shingleH);
      grad.addColorStop(0.0, highlightColor);
      grad.addColorStop(0.15, primaryColor);
      grad.addColorStop(0.82, secondaryColor);
      grad.addColorStop(1.0, shadowColor);

      ctx.fillStyle = grad;
      ctx.fillRect(x + 1, y, shingleW, shingleH);

      // Top fine bevel highlight
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.fillRect(x + 1, y, shingleW, 2);

      // Bottom crisp horizontal overlap drop shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
      ctx.fillRect(x, y + rowH - 3, colW, 4);

      // Vertical separation groove between shingles
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(x, y, 1.5, rowH);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.fillRect(x + 1.5, y, 1.0, rowH);
    }
  }

  // Subtle organic wood/slate noise for Sims 4 finish
  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
  for (let i = 0; i < 700; i++) {
    const rx = Math.random() * 512;
    const ry = Math.random() * 512;
    ctx.fillRect(rx, ry, 1 + Math.random() * 2, 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Sims 4 Barkwood: Deep rich dark chocolate brown wood shingles
export function createBarkwoodShingleTexture(): THREE.CanvasTexture {
  return createSims4ShingleTexture('#382519', '#291a11', '#4e3626', '#160d07');
}

// Sims 4 Sunrise: Warm golden chestnut/cedar wood shingles
export function createSunriseShingleTexture(): THREE.CanvasTexture {
  return createSims4ShingleTexture('#7c4825', '#5d3316', '#985b32', '#3a1c09');
}

// Sims 4 Mission: Mediterranean terracotta clay shingle tile
export function createMissionTileTexture(): THREE.CanvasTexture {
  return createSims4ShingleTexture('#8e3d20', '#6f2c14', '#ad4f2c', '#431508');
}

// Sims 4 Blue Slate: Elegant grey-blue architectural slate
export function createBlueSlateTexture(): THREE.CanvasTexture {
  return createSims4ShingleTexture('#3b4e60', '#273542', '#526b83', '#16212b');
}

export function createTerracottaTileTexture(): THREE.CanvasTexture {
  return createMissionTileTexture();
}

// =========================================================================
// WHITE ARCHITECTURAL WOOD TRIM & ATTIC SIDING TEXTURE (Sims 4 Style)
// Clean crisp white satin paint finish with horizontal lap siding for frontons
// =========================================================================

export function createSims4WhiteTrimTexture(): THREE.CanvasTexture {
  // One seamless repeat = 1m x 1m of painted white trim board (fascia, rake, soffit)
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#f6f6f9';
  ctx.fillRect(0, 0, 512, 512);

  // Faint horizontal brush / grain streaks that tile seamlessly
  for (let i = 0; i < 220; i++) {
    const y = Math.random() * 512;
    const x = Math.random() * 512;
    const len = 40 + Math.random() * 160;
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(0, 0, 0, 0.025)' : 'rgba(255, 255, 255, 0.5)';
    ctx.fillRect(x, y, len, 1);
    if (x + len > 512) ctx.fillRect(x - 512, y, len, 1);
  }

  // Board seams every 25cm so long trims read as separate boards
  for (let y = 0; y < 512; y += 128) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.10)';
    ctx.fillRect(0, y, 512, 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillRect(0, y + 2, 512, 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Seamless white lap siding for gable / attic fronton walls: 1m repeat, 12.5cm boards. */
export function createRoofLapSidingTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const boardH = 64;
  for (let y = 0; y < 512; y += boardH) {
    const boardGrad = ctx.createLinearGradient(0, y, 0, y + boardH);
    boardGrad.addColorStop(0.0, '#ffffff');
    boardGrad.addColorStop(0.7, '#f3f3f7');
    boardGrad.addColorStop(1.0, '#e3e3ea');
    ctx.fillStyle = boardGrad;
    ctx.fillRect(0, y, 512, boardH);

    // Lap shadow under each board and a highlighted lower lip
    ctx.fillStyle = 'rgba(0, 0, 0, 0.24)';
    ctx.fillRect(0, y + boardH - 4, 512, 4);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.fillRect(0, y, 512, 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export const PROCEDURAL_ROOF_MATERIALS = {
  heartopiaShingle: new THREE.MeshLambertMaterial({
    map: createBarkwoodShingleTexture(),
  }),
  woodTrim: new THREE.MeshLambertMaterial({
    map: createSims4WhiteTrimTexture(),
    color: new THREE.Color(0xffffff),
  }),
  terracotta: new THREE.MeshLambertMaterial({
    map: createTerracottaTileTexture(),
  }),
  slate: new THREE.MeshLambertMaterial({
    map: createBlueSlateTexture(),
  }),
  gableWall: new THREE.MeshLambertMaterial({
    map: createRoofLapSidingTexture(),
    color: new THREE.Color(0xffffff),
  }),
};

/**
 * Procedural Roof Geometry Generator (Sims 4 Style)
 * - Material 0: Roof Shingle & Dedicated Ridge Cap (коньок)
 * - Material 1: White Wood Trim (Fascia, Rake boards, Soffits, and White Horizontal Lap Siding)
 *
 * Distinctive Sims 4 features:
 * 1. Dedicated Ridge Cap (коньок) that exists ONLY on the apex ridge!
 * 2. Clean, solid white wooden fascia & rake boards with realistic thickness.
 * 3. Fronton attic walls with architectural white lap siding.
 * 4. 100% mathematically correct geometry with zero holes, zero drooping sheets.
 */
export class ProceduralRoofGenerator {
  public static generateBuffers(config: Partial<ProceduralRoofConfig>): RoofBuffers {
    const fullConfig: ProceduralRoofConfig = { ...DEFAULT_ROOF_CONFIG, ...config };
    const {
      minX, maxX, minZ, maxZ, height,
      roofType,
      overhang = 0.22,
      fasciaDepth = 0.12,
      uvScale = 1.0,
    } = fullConfig;

    const eaveO = fullConfig.eaveOverhang ?? overhang;
    const gableO = fullConfig.gableOverhang ?? overhang;

    const midX = (minX + maxX) / 2;
    const midZ = (minZ + maxZ) / 2;

    // Arrays separated by material index:
    // p0, n0, u0 -> Material 0 (Roof Shingles & Ridge Cap)
    // p1, n1, u1 -> Material 1 (White Wood Trim: Fascia, Soffit, Rake, Attic Siding)
    // p2, n2, u2 -> Material 2 (White Lap Siding: gable / attic fronton walls)
    const p0: number[] = [], n0: number[] = [], u0: number[] = [];
    const p1: number[] = [], n1: number[] = [], u1: number[] = [];
    const p2: number[] = [], n2: number[] = [], u2: number[] = [];
    const buckets = [
      { p: p0, n: n0, u: u0 },
      { p: p1, n: n1, u: u1 },
      { p: p2, n: n2, u: u2 },
    ];

    // Face-planar UVs in meters: U runs horizontally along the face, V runs up the face and is
    // measured from y=0, so shingle courses and siding boards line up across every slope and
    // keep true proportions (hand-authored UVs skewed trapezoids and stretched hip faces).
    const _t = new THREE.Vector3();
    const _b = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);
    const planarUV = (faceNormal: THREE.Vector3, pts: THREE.Vector3[]): Array<{ u: number; v: number }> | null => {
      if (Math.abs(faceNormal.y) > 0.985) {
        // Horizontal faces (soffits, attic ceilings): straight top-down projection
        return pts.map((q) => ({ u: q.x * uvScale, v: q.z * uvScale }));
      }
      _t.crossVectors(UP, faceNormal);
      if (_t.lengthSq() < 1e-8) return null;
      _t.normalize();
      _b.crossVectors(faceNormal, _t).normalize();
      if (_b.y < 0) _b.negate();
      const rise = _b.y; // vertical metres per metre along the face
      return pts.map((q) => ({
        u: q.dot(_t) * uvScale,
        v: (rise > 1e-3 ? q.y / rise : q.dot(_b)) * uvScale,
      }));
    };

    const addTriangle = (
      v1: THREE.Vector3,
      v2: THREE.Vector3,
      v3: THREE.Vector3,
      uv1: { u: number; v: number },
      uv2: { u: number; v: number },
      uv3: { u: number; v: number },
      matIndex: 0 | 1 | 2,
      customNormal?: THREE.Vector3
    ) => {
      const { p, n, u } = buckets[matIndex];

      const edge1 = new THREE.Vector3().subVectors(v2, v1);
      const edge2 = new THREE.Vector3().subVectors(v3, v1);
      const faceNormal = new THREE.Vector3().crossVectors(edge1, edge2);
      if (faceNormal.lengthSq() < 1e-12) return; // degenerate sliver
      faceNormal.normalize();
      const norm = customNormal ?? faceNormal;

      const planar = planarUV(faceNormal, [v1, v2, v3]);
      const [a, b, c] = planar ?? [uv1, uv2, uv3];

      p.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z, v3.x, v3.y, v3.z);
      n.push(norm.x, norm.y, norm.z, norm.x, norm.y, norm.z, norm.x, norm.y, norm.z);
      u.push(a.u, a.v, b.u, b.v, c.u, c.v);
    };

    const addQuad = (
      v1: THREE.Vector3,
      v2: THREE.Vector3,
      v3: THREE.Vector3,
      v4: THREE.Vector3,
      uv1: { u: number; v: number },
      uv2: { u: number; v: number },
      uv3: { u: number; v: number },
      uv4: { u: number; v: number },
      matIndex: 0 | 1 | 2,
      customNormal?: THREE.Vector3
    ) => {
      addTriangle(v1, v2, v3, uv1, uv2, uv3, matIndex, customNormal);
      addTriangle(v1, v3, v4, uv1, uv3, uv4, matIndex, customNormal);
    };

    if (roofType === 'shed') {
      // =========================================================================
      // 1. SHED ROOF (ОДНОСХИЛИЙ ДАХ)
      // =========================================================================
      const lowZ = minZ - eaveO;
      const highZ = maxZ + eaveO;
      const leftX = minX - gableO;
      const rightX = maxX + gableO;

      const slopeRun = highZ - lowZ;
      const slopeLen = Math.sqrt(slopeRun * slopeRun + height * height);
      const roofWidth = rightX - leftX;

      // Top Roof Slope (Group 0: Shingles)
      const topLowLeft = new THREE.Vector3(leftX, 0, lowZ);
      const topLowRight = new THREE.Vector3(rightX, 0, lowZ);
      const topHighRight = new THREE.Vector3(rightX, height, highZ);
      const topHighLeft = new THREE.Vector3(leftX, height, highZ);

      addQuad(
        topLowLeft, topLowRight, topHighRight, topHighLeft,
        { u: 0, v: 0 },
        { u: roofWidth * uvScale, v: 0 },
        { u: roofWidth * uvScale, v: slopeLen * uvScale },
        { u: 0, v: slopeLen * uvScale },
        0
      );

      // Dedicated Top Ridge Flashing / Cap Strip (Group 0)
      const capW = 0.22;
      const capH = 0.035;
      const cHighLeft = new THREE.Vector3(leftX, height + capH, highZ);
      const cHighRight = new THREE.Vector3(rightX, height + capH, highZ);
      const cFrontLeft = new THREE.Vector3(leftX, height - (capW / slopeRun) * height + capH, highZ - capW);
      const cFrontRight = new THREE.Vector3(rightX, height - (capW / slopeRun) * height + capH, highZ - capW);
      addQuad(
        cFrontLeft, cFrontRight, cHighRight, cHighLeft,
        { u: 0, v: 0 }, { u: roofWidth * uvScale, v: 0 },
        { u: roofWidth * uvScale, v: 1.0 }, { u: 0, v: 1.0 },
        0
      );

      // Underside Soffit (Group 1: White Trim)
      const botLowLeft = new THREE.Vector3(leftX, -fasciaDepth, lowZ);
      const botLowRight = new THREE.Vector3(rightX, -fasciaDepth, lowZ);
      const botHighRight = new THREE.Vector3(rightX, height - fasciaDepth, highZ);
      const botHighLeft = new THREE.Vector3(leftX, height - fasciaDepth, highZ);

      addQuad(
        botHighLeft, botHighRight, botLowRight, botLowLeft,
        { u: 0, v: 0.25 }, { u: roofWidth * uvScale, v: 0.25 },
        { u: roofWidth * uvScale, v: 0 }, { u: 0, v: 0 },
        1
      );

      // Perimeter White Fascia Boards (Group 1: White Trim)
      // Low Eave Fascia
      addQuad(botLowLeft, botLowRight, topLowRight, topLowLeft, { u: 0, v: 0 }, { u: roofWidth * uvScale, v: 0 }, { u: roofWidth * uvScale, v: 0.25 }, { u: 0, v: 0.25 }, 1);
      // High Ridge Fascia
      addQuad(topHighLeft, topHighRight, botHighRight, botHighLeft, { u: 0, v: 0 }, { u: roofWidth * uvScale, v: 0 }, { u: roofWidth * uvScale, v: 0.25 }, { u: 0, v: 0.25 }, 1);
      // Left Rake Fascia
      addQuad(topLowLeft, topHighLeft, botHighLeft, botLowLeft, { u: 0, v: 0 }, { u: slopeLen * uvScale, v: 0 }, { u: slopeLen * uvScale, v: 0.25 }, { u: 0, v: 0.25 }, 1);
      // Right Rake Fascia
      addQuad(topHighRight, topLowRight, botLowRight, botHighRight, { u: 0, v: 0 }, { u: slopeLen * uvScale, v: 0 }, { u: slopeLen * uvScale, v: 0.25 }, { u: 0, v: 0.25 }, 1);

      // Attic Walls in White Lap Siding (Group 1: White Trim, V: 0.5..1.0)
      const wallLowLeft = new THREE.Vector3(minX, 0, minZ);
      const wallHighLeft = new THREE.Vector3(minX, height, maxZ);
      const wallBaseHighLeft = new THREE.Vector3(minX, 0, maxZ);
      addTriangle(
        wallLowLeft, wallHighLeft, wallBaseHighLeft,
        { u: minZ * uvScale, v: 0.5 },
        { u: maxZ * uvScale, v: 0.5 + height * 0.4 },
        { u: maxZ * uvScale, v: 0.5 },
        2
      );

      const wallLowRight = new THREE.Vector3(maxX, 0, minZ);
      const wallHighRight = new THREE.Vector3(maxX, height, maxZ);
      const wallBaseHighRight = new THREE.Vector3(maxX, 0, maxZ);
      addTriangle(
        wallLowRight, wallBaseHighRight, wallHighRight,
        { u: minZ * uvScale, v: 0.5 },
        { u: maxZ * uvScale, v: 0.5 },
        { u: maxZ * uvScale, v: 0.5 + height * 0.4 },
        2
      );

      // Rear Wall
      addQuad(
        wallBaseHighLeft, wallBaseHighRight, wallHighRight, wallHighLeft,
        { u: minX * uvScale, v: 0.5 }, { u: maxX * uvScale, v: 0.5 },
        { u: maxX * uvScale, v: 0.5 + height * 0.4 }, { u: minX * uvScale, v: 0.5 + height * 0.4 },
        2
      );

    } else if (roofType === 'hip') {
      // =========================================================================
      // 2. HIP ROOF (ВАЛЬМОВИЙ ДАХ)
      // 4 clean sloped planes meeting seamlessly with white trim & hip ridge caps
      // =========================================================================
      const leftX = minX - eaveO;
      const rightX = maxX + eaveO;
      const frontZ = minZ - eaveO;
      const backZ = maxZ + eaveO;

      const width = maxX - minX;
      const length = maxZ - minZ;
      const inset = Math.min(width, length) / 2;
      const isZAxis = length > width;
      const isSquare = Math.abs(length - width) < 0.001;

      let rF: THREE.Vector3;
      let rB: THREE.Vector3;

      if (isSquare) {
        rF = new THREE.Vector3(midX, height, midZ);
        rB = new THREE.Vector3(midX, height, midZ);
      } else if (isZAxis) {
        rF = new THREE.Vector3(midX, height, minZ + inset);
        rB = new THREE.Vector3(midX, height, maxZ - inset);
      } else {
        rF = new THREE.Vector3(minX + inset, height, midZ);
        rB = new THREE.Vector3(maxX - inset, height, midZ);
      }

      // 4 Top Outer Corners
      const cLF = new THREE.Vector3(leftX, 0, frontZ);
      const cRF = new THREE.Vector3(rightX, 0, frontZ);
      const cRB = new THREE.Vector3(rightX, 0, backZ);
      const cLB = new THREE.Vector3(leftX, 0, backZ);

      // Group 0: Top Roof Slopes (Seamless Shingles)
      if (isSquare) {
        // Square Hip Roof: 4 Triangles meeting at central apex
        addTriangle(
          cRF, cLF, rF,
          { u: (rightX - leftX) * uvScale, v: 0 }, { u: 0, v: 0 }, { u: ((rightX - leftX) / 2) * uvScale, v: height * 1.3 * uvScale },
          0
        );
        addTriangle(
          cLB, cRB, rF,
          { u: (rightX - leftX) * uvScale, v: 0 }, { u: 0, v: 0 }, { u: ((rightX - leftX) / 2) * uvScale, v: height * 1.3 * uvScale },
          0
        );
        addTriangle(
          cLF, cLB, rF,
          { u: (backZ - frontZ) * uvScale, v: 0 }, { u: 0, v: 0 }, { u: ((backZ - frontZ) / 2) * uvScale, v: height * 1.3 * uvScale },
          0
        );
        addTriangle(
          cRB, cRF, rF,
          { u: (backZ - frontZ) * uvScale, v: 0 }, { u: 0, v: 0 }, { u: ((backZ - frontZ) / 2) * uvScale, v: height * 1.3 * uvScale },
          0
        );
      } else if (isZAxis) {
        // Long along Z (length > width)
        addTriangle(
          cRF, cLF, rF,
          { u: (rightX - leftX) * uvScale, v: 0 }, { u: 0, v: 0 }, { u: ((rightX - leftX) / 2) * uvScale, v: height * 1.3 * uvScale },
          0
        );
        addTriangle(
          cLB, cRB, rB,
          { u: (rightX - leftX) * uvScale, v: 0 }, { u: 0, v: 0 }, { u: ((rightX - leftX) / 2) * uvScale, v: height * 1.3 * uvScale },
          0
        );
        addQuad(
          cLF, cLB, rB, rF,
          { u: 0, v: 0 }, { u: (backZ - frontZ) * uvScale, v: 0 },
          { u: ((backZ - frontZ) - inset) * uvScale, v: height * 1.3 * uvScale }, { u: inset * uvScale, v: height * 1.3 * uvScale },
          0
        );
        addQuad(
          cRB, cRF, rF, rB,
          { u: 0, v: 0 }, { u: (backZ - frontZ) * uvScale, v: 0 },
          { u: ((backZ - frontZ) - inset) * uvScale, v: height * 1.3 * uvScale }, { u: inset * uvScale, v: height * 1.3 * uvScale },
          0
        );
      } else {
        // Wide along X (width > length)
        addQuad(
          cRF, cLF, rF, rB,
          { u: 0, v: 0 }, { u: (rightX - leftX) * uvScale, v: 0 },
          { u: ((rightX - leftX) - inset) * uvScale, v: height * 1.3 * uvScale }, { u: inset * uvScale, v: height * 1.3 * uvScale },
          0
        );
        addQuad(
          cLB, cRB, rB, rF,
          { u: 0, v: 0 }, { u: (rightX - leftX) * uvScale, v: 0 },
          { u: ((rightX - leftX) - inset) * uvScale, v: height * 1.3 * uvScale }, { u: inset * uvScale, v: height * 1.3 * uvScale },
          0
        );
        addTriangle(
          cLF, cLB, rF,
          { u: (backZ - frontZ) * uvScale, v: 0 }, { u: 0, v: 0 }, { u: ((backZ - frontZ) / 2) * uvScale, v: height * 1.3 * uvScale },
          0
        );
        addTriangle(
          cRB, cRF, rB,
          { u: (backZ - frontZ) * uvScale, v: 0 }, { u: 0, v: 0 }, { u: ((backZ - frontZ) / 2) * uvScale, v: height * 1.3 * uvScale },
          0
        );
      }

      // Dedicated Ridge Cap (коньок) on central ridge (Group 0)
      if (!isSquare) {
        const capW = 0.14;
        const capH = 0.035;
        const rF_high = new THREE.Vector3(rF.x, rF.y + capH, rF.z);
        const rB_high = new THREE.Vector3(rB.x, rB.y + capH, rB.z);

        if (isZAxis) {
          const rcL_F = new THREE.Vector3(rF.x - capW, rF.y, rF.z);
          const rcR_F = new THREE.Vector3(rF.x + capW, rF.y, rF.z);
          const rcL_B = new THREE.Vector3(rB.x - capW, rB.y, rB.z);
          const rcR_B = new THREE.Vector3(rB.x + capW, rB.y, rB.z);
          addQuad(rcL_F, rcL_B, rB_high, rF_high, { u: 0, v: 0 }, { u: 0, v: 1.0 }, { u: 0.5, v: 1.0 }, { u: 0.5, v: 0 }, 0);
          addQuad(rcR_B, rcR_F, rF_high, rB_high, { u: 1.0, v: 1.0 }, { u: 1.0, v: 0 }, { u: 0.5, v: 0 }, { u: 0.5, v: 1.0 }, 0);
        } else {
          const rcF_L = new THREE.Vector3(rF.x, rF.y, rF.z - capW);
          const rcB_L = new THREE.Vector3(rF.x, rF.y, rF.z + capW);
          const rcF_R = new THREE.Vector3(rB.x, rB.y, rB.z - capW);
          const rcB_R = new THREE.Vector3(rB.x, rB.y, rB.z + capW);
          addQuad(rcF_R, rcF_L, rF_high, rB_high, { u: 0, v: 1.0 }, { u: 0, v: 0 }, { u: 0.5, v: 0 }, { u: 0.5, v: 1.0 }, 0);
          addQuad(rcB_L, rcB_R, rB_high, rF_high, { u: 1.0, v: 0 }, { u: 1.0, v: 1.0 }, { u: 0.5, v: 1.0 }, { u: 0.5, v: 0 }, 0);
        }
      }

      // 4 Underside Soffit Panels under eave overhang (Group 1: White Trim)
      const bLF = new THREE.Vector3(leftX, -fasciaDepth, frontZ);
      const bRF = new THREE.Vector3(rightX, -fasciaDepth, frontZ);
      const bRB = new THREE.Vector3(rightX, -fasciaDepth, backZ);
      const bLB = new THREE.Vector3(leftX, -fasciaDepth, backZ);

      const wallFL = new THREE.Vector3(minX, -fasciaDepth, minZ);
      const wallFR = new THREE.Vector3(maxX, -fasciaDepth, minZ);
      const wallBR = new THREE.Vector3(maxX, -fasciaDepth, maxZ);
      const wallBL = new THREE.Vector3(minX, -fasciaDepth, maxZ);

      if (eaveO > 0.001) {
        addQuad(bLF, bRF, wallFR, wallFL, { u: 0, v: 0 }, { u: (rightX - leftX) * uvScale, v: 0 }, { u: (maxX - minX) * uvScale, v: eaveO * uvScale }, { u: 0, v: eaveO * uvScale }, 1);
        addQuad(bRF, bRB, wallBR, wallFR, { u: 0, v: 0 }, { u: (backZ - frontZ) * uvScale, v: 0 }, { u: (maxZ - minZ) * uvScale, v: eaveO * uvScale }, { u: 0, v: eaveO * uvScale }, 1);
        addQuad(bRB, bLB, wallBL, wallBR, { u: 0, v: 0 }, { u: (rightX - leftX) * uvScale, v: 0 }, { u: (maxX - minX) * uvScale, v: eaveO * uvScale }, { u: 0, v: eaveO * uvScale }, 1);
        addQuad(bLB, bLF, wallFL, wallBL, { u: 0, v: 0 }, { u: (backZ - frontZ) * uvScale, v: 0 }, { u: (maxZ - minZ) * uvScale, v: eaveO * uvScale }, { u: 0, v: eaveO * uvScale }, 1);
      }

      // Perimeter White Fascia Boards (Group 1: White Trim)
      addQuad(bRF, bLF, cLF, cRF, { u: (rightX - leftX) * uvScale, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0.25 }, { u: (rightX - leftX) * uvScale, v: 0.25 }, 1);
      addQuad(bRB, bRF, cRF, cRB, { u: (backZ - frontZ) * uvScale, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0.25 }, { u: (backZ - frontZ) * uvScale, v: 0.25 }, 1);
      addQuad(bLB, bRB, cRB, cLB, { u: (rightX - leftX) * uvScale, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0.25 }, { u: (rightX - leftX) * uvScale, v: 0.25 }, 1);
      addQuad(bLF, bLB, cLB, cLF, { u: (backZ - frontZ) * uvScale, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0.25 }, { u: (backZ - frontZ) * uvScale, v: 0.25 }, 1);

      // Attic Ceiling Base Plate (Facing -Y)
      const baseFL = new THREE.Vector3(minX, 0, minZ);
      const baseFR = new THREE.Vector3(maxX, 0, minZ);
      const baseBL = new THREE.Vector3(minX, 0, maxZ);
      const baseBR = new THREE.Vector3(maxX, 0, maxZ);
      addQuad(baseBL, baseFL, baseFR, baseBR, { u: 0, v: (maxZ - minZ) * uvScale }, { u: 0, v: 0 }, { u: (maxX - minX) * uvScale, v: 0 }, { u: (maxX - minX) * uvScale, v: (maxZ - minZ) * uvScale }, 1);

    } else {
      // =========================================================================
      // 3. GABLE ROOF (ДВОСХИЛИЙ ДАХ) - AUTHENTIC BLENDER / SIMS 4 TOPOLOGY
      // Red: Roof Shingle Slopes (Group 0)
      // Blue: Ridge Cap / Apex (Group 0)
      // Green: White Wood Trim - Fascia, Rake boards, Soffits, Attic Walls (Group 1)
      // =========================================================================
      const leftX = minX - eaveO;
      const rightX = maxX + eaveO;
      const frontZ = minZ - gableO; // facing -Z
      const backZ = maxZ + gableO;  // facing +Z

      const halfSpan = (maxX - minX) / 2 + eaveO;
      const roofLen = backZ - frontZ;

      // 1. Metric Ridge Cap dimensions (Коньок: фіксований радіус 0.14 м)
      const RIDGE_CAP_RADIUS = 0.14;
      const capHalfW = Math.min(RIDGE_CAP_RADIUS, halfSpan * 0.35);

      // 2. Pitch angle & trigonometric slope calculations (Кут нахилу α)
      const alpha = Math.atan2(height, halfSpan);
      const sinAlpha = Math.sin(alpha);
      const cosAlpha = Math.cos(alpha);
      const tanAlpha = Math.tan(alpha);

      // Ridge drop follows the exact roof slope line
      const capDropY = capHalfW * tanAlpha;
      const capSlopeLen = capHalfW / cosAlpha;

      // Main shingle slope length
      const slopeRun = halfSpan - capHalfW;
      const shingleSlopeLen = slopeRun / cosAlpha;

      // 3. Metric Fascia board (Лобова дошка: фіксована перпендикулярна товщина)
      const FASCIA_HEIGHT = fullConfig.fasciaDepth ?? 0.15;
      const T_board = FASCIA_HEIGHT; // Perpendicular board thickness

      // 10 cross-section points on Front (frontZ) and Back (backZ)
      // Top Outer Roof Profile
      const TL_F = new THREE.Vector3(leftX, 0, frontZ);
      const RL_F = new THREE.Vector3(midX - capHalfW, height - capDropY, frontZ);
      const A_F  = new THREE.Vector3(midX, height, frontZ);
      const RR_F = new THREE.Vector3(midX + capHalfW, height - capDropY, frontZ);
      const TR_F = new THREE.Vector3(rightX, 0, frontZ);

      const TL_B = new THREE.Vector3(leftX, 0, backZ);
      const RL_B = new THREE.Vector3(midX - capHalfW, height - capDropY, backZ);
      const A_B  = new THREE.Vector3(midX, height, backZ);
      const RR_B = new THREE.Vector3(midX + capHalfW, height - capDropY, backZ);
      const TR_B = new THREE.Vector3(rightX, 0, backZ);

      // Bottom Inner Trim & Soffit Profile (perpendicular offset T_board matching roof1.gltf)
      const BL_F  = new THREE.Vector3(leftX + T_board * sinAlpha, -T_board * cosAlpha, frontZ);
      const URL_F = new THREE.Vector3(midX - capHalfW + T_board * sinAlpha, height - capDropY - T_board * cosAlpha, frontZ);
      const UA_F  = new THREE.Vector3(midX, height - T_board / cosAlpha, frontZ);
      const URR_F = new THREE.Vector3(midX + capHalfW - T_board * sinAlpha, height - capDropY - T_board * cosAlpha, frontZ);
      const BR_F  = new THREE.Vector3(rightX - T_board * sinAlpha, -T_board * cosAlpha, frontZ);

      const BL_B  = new THREE.Vector3(leftX + T_board * sinAlpha, -T_board * cosAlpha, backZ);
      const URL_B = new THREE.Vector3(midX - capHalfW + T_board * sinAlpha, height - capDropY - T_board * cosAlpha, backZ);
      const UA_B  = new THREE.Vector3(midX, height - T_board / cosAlpha, backZ);
      const URR_B = new THREE.Vector3(midX + capHalfW - T_board * sinAlpha, height - capDropY - T_board * cosAlpha, backZ);
      const BR_B  = new THREE.Vector3(rightX - T_board * sinAlpha, -T_board * cosAlpha, backZ);

      // -----------------------------------------------------------------------
      // RED: ROOF SHINGLE SLOPES (GROUP 0) - WORLD-SPACE UV
      // -----------------------------------------------------------------------

      // Left Slope (facing -X, +Y: outward/upward)
      addTriangle(
        TL_F, TL_B, RL_B,
        { u: 0, v: 0 }, { u: roofLen * uvScale, v: 0 }, { u: roofLen * uvScale, v: shingleSlopeLen * uvScale },
        0
      );
      addTriangle(
        TL_F, RL_B, RL_F,
        { u: 0, v: 0 }, { u: roofLen * uvScale, v: shingleSlopeLen * uvScale }, { u: 0, v: shingleSlopeLen * uvScale },
        0
      );

      // Right Slope (facing +X, +Y: outward/upward)
      addTriangle(
        TR_B, TR_F, RR_F,
        { u: 0, v: 0 }, { u: roofLen * uvScale, v: 0 }, { u: roofLen * uvScale, v: shingleSlopeLen * uvScale },
        0
      );
      addTriangle(
        TR_B, RR_F, RR_B,
        { u: 0, v: 0 }, { u: roofLen * uvScale, v: shingleSlopeLen * uvScale }, { u: 0, v: shingleSlopeLen * uvScale },
        0
      );

      // -----------------------------------------------------------------------
      // BLUE: DEDICATED RIDGE CAP / GREBIN (GROUP 0) - WORLD-SPACE UV
      // -----------------------------------------------------------------------
      const capV0 = shingleSlopeLen * uvScale;
      const capV1 = (shingleSlopeLen + capSlopeLen) * uvScale;

      // Left Cap Slope (facing -X, +Y)
      addTriangle(
        RL_F, RL_B, A_B,
        { u: 0, v: capV0 }, { u: roofLen * uvScale, v: capV0 }, { u: roofLen * uvScale, v: capV1 },
        0
      );
      addTriangle(
        RL_F, A_B, A_F,
        { u: 0, v: capV0 }, { u: roofLen * uvScale, v: capV1 }, { u: 0, v: capV1 },
        0
      );

      // Right Cap Slope (facing +X, +Y)
      addTriangle(
        A_F, A_B, RR_B,
        { u: 0, v: capV1 }, { u: roofLen * uvScale, v: capV1 }, { u: roofLen * uvScale, v: capV0 },
        0
      );
      addTriangle(
        A_F, RR_B, RR_F,
        { u: 0, v: capV1 }, { u: roofLen * uvScale, v: capV0 }, { u: 0, v: capV0 },
        0
      );

      // -----------------------------------------------------------------------
      // GREEN: WHITE ARCHITECTURAL WOOD TRIM (GROUP 1) - WORLD-SPACE UV
      // Fascia, Soffits, Rake Boards, Attic Floor & Attic Frontons
      // -----------------------------------------------------------------------

      // 1. Eave Fascia Boards (Vertical / Outer edge)
      // Left Fascia (facing -X)
      addTriangle(
        TL_F, BL_F, BL_B,
        { u: 0, v: T_board * uvScale }, { u: 0, v: 0 }, { u: roofLen * uvScale, v: 0 },
        1
      );
      addTriangle(
        TL_F, BL_B, TL_B,
        { u: 0, v: T_board * uvScale }, { u: roofLen * uvScale, v: 0 }, { u: roofLen * uvScale, v: T_board * uvScale },
        1
      );

      // Right Fascia (facing +X)
      addTriangle(
        TR_B, BR_B, BR_F,
        { u: 0, v: T_board * uvScale }, { u: 0, v: 0 }, { u: roofLen * uvScale, v: 0 },
        1
      );
      addTriangle(
        TR_B, BR_F, TR_F,
        { u: 0, v: T_board * uvScale }, { u: roofLen * uvScale, v: 0 }, { u: roofLen * uvScale, v: T_board * uvScale },
        1
      );

      // 2. Underside Soffit Panels (facing inwards/downwards)
      // Left Outer Soffit
      addTriangle(
        BL_F, URL_F, URL_B,
        { u: 0, v: 0 }, { u: 0, v: shingleSlopeLen * uvScale }, { u: roofLen * uvScale, v: shingleSlopeLen * uvScale },
        1
      );
      addTriangle(
        BL_F, URL_B, BL_B,
        { u: 0, v: 0 }, { u: roofLen * uvScale, v: shingleSlopeLen * uvScale }, { u: roofLen * uvScale, v: 0 },
        1
      );

      // Right Outer Soffit
      addTriangle(
        BR_F, BR_B, URR_B,
        { u: 0, v: 0 }, { u: roofLen * uvScale, v: 0 }, { u: roofLen * uvScale, v: shingleSlopeLen * uvScale },
        1
      );
      addTriangle(
        BR_F, URR_B, URR_F,
        { u: 0, v: 0 }, { u: roofLen * uvScale, v: shingleSlopeLen * uvScale }, { u: 0, v: shingleSlopeLen * uvScale },
        1
      );

      // Under-Cap Ridge Left Soffit
      addTriangle(
        URL_F, UA_F, UA_B,
        { u: 0, v: shingleSlopeLen * uvScale }, { u: 0, v: (shingleSlopeLen + capSlopeLen) * uvScale }, { u: roofLen * uvScale, v: (shingleSlopeLen + capSlopeLen) * uvScale },
        1
      );
      addTriangle(
        URL_F, UA_B, URL_B,
        { u: 0, v: shingleSlopeLen * uvScale }, { u: roofLen * uvScale, v: (shingleSlopeLen + capSlopeLen) * uvScale }, { u: roofLen * uvScale, v: shingleSlopeLen * uvScale },
        1
      );

      // Under-Cap Ridge Right Soffit
      addTriangle(
        URR_F, URR_B, UA_B,
        { u: 0, v: shingleSlopeLen * uvScale }, { u: roofLen * uvScale, v: shingleSlopeLen * uvScale }, { u: roofLen * uvScale, v: (shingleSlopeLen + capSlopeLen) * uvScale },
        1
      );
      addTriangle(
        URR_F, UA_B, UA_F,
        { u: 0, v: shingleSlopeLen * uvScale }, { u: roofLen * uvScale, v: (shingleSlopeLen + capSlopeLen) * uvScale }, { u: 0, v: (shingleSlopeLen + capSlopeLen) * uvScale },
        1
      );

      // 3. Front Rake Trim (Facing -Z) - World-Space UV
      const uvRake = (p: THREE.Vector3) => ({
        u: (p.x - leftX) * uvScale,
        v: (p.y + T_board) * uvScale,
      });

      // Left outer rake (facing -Z)
      addTriangle(RL_F, BL_F, TL_F, uvRake(RL_F), uvRake(BL_F), uvRake(TL_F), 1);
      addTriangle(RL_F, URL_F, BL_F, uvRake(RL_F), uvRake(URL_F), uvRake(BL_F), 1);
      // Left apex rake (facing -Z)
      addTriangle(A_F, URL_F, RL_F, uvRake(A_F), uvRake(URL_F), uvRake(RL_F), 1);
      addTriangle(A_F, UA_F, URL_F, uvRake(A_F), uvRake(UA_F), uvRake(URL_F), 1);

      // Right outer rake (facing -Z)
      addTriangle(TR_F, URR_F, RR_F, uvRake(TR_F), uvRake(URR_F), uvRake(RR_F), 1);
      addTriangle(TR_F, BR_F, URR_F, uvRake(TR_F), uvRake(BR_F), uvRake(URR_F), 1);
      // Right apex rake (facing -Z)
      addTriangle(RR_F, URR_F, UA_F, uvRake(RR_F), uvRake(URR_F), uvRake(UA_F), 1);
      addTriangle(RR_F, UA_F, A_F, uvRake(RR_F), uvRake(UA_F), uvRake(A_F), 1);

      // 4. Back Rake Trim (Facing +Z) - World-Space UV
      // Left outer rake (facing +Z)
      addTriangle(TL_B, URL_B, RL_B, uvRake(TL_B), uvRake(URL_B), uvRake(RL_B), 1);
      addTriangle(TL_B, BL_B, URL_B, uvRake(TL_B), uvRake(BL_B), uvRake(URL_B), 1);
      // Left apex rake (facing +Z)
      addTriangle(RL_B, UA_B, A_B, uvRake(RL_B), uvRake(UA_B), uvRake(A_B), 1);
      addTriangle(RL_B, URL_B, UA_B, uvRake(RL_B), uvRake(URL_B), uvRake(UA_B), 1);

      // Right outer rake (facing +Z)
      addTriangle(RR_B, BR_B, TR_B, uvRake(RR_B), uvRake(BR_B), uvRake(TR_B), 1);
      addTriangle(RR_B, URR_B, BR_B, uvRake(RR_B), uvRake(URR_B), uvRake(BR_B), 1);
      // Right apex rake (facing +Z)
      addTriangle(A_B, URR_B, RR_B, uvRake(A_B), uvRake(URR_B), uvRake(RR_B), 1);
      addTriangle(A_B, UA_B, URR_B, uvRake(A_B), uvRake(UA_B), uvRake(URR_B), 1);

      // 5. Attic Ceiling Base Plate (Facing -Y) - World-Space UV
      const baseFL = new THREE.Vector3(minX, 0, minZ);
      const baseFR = new THREE.Vector3(maxX, 0, minZ);
      const baseBL = new THREE.Vector3(minX, 0, maxZ);
      const baseBR = new THREE.Vector3(maxX, 0, maxZ);
      addTriangle(
        baseBL, baseFR, baseBR,
        { u: 0, v: 0 }, { u: (maxX - minX) * uvScale, v: (maxZ - minZ) * uvScale }, { u: (maxX - minX) * uvScale, v: 0 },
        1
      );
      addTriangle(
        baseBL, baseFL, baseFR,
        { u: 0, v: 0 }, { u: 0, v: (maxZ - minZ) * uvScale }, { u: (maxX - minX) * uvScale, v: (maxZ - minZ) * uvScale },
        1
      );

      // 6. Attic Fronton Walls (White Horizontal Lap Siding) - World-Space UV
      // Front Attic Wall (facing -Z)
      const wallFrontApex = new THREE.Vector3(midX, height, minZ);
      addTriangle(
        baseFL, wallFrontApex, baseFR,
        { u: 0, v: 0 },
        { u: (midX - minX) * uvScale, v: height * uvScale },
        { u: (maxX - minX) * uvScale, v: 0 },
        2
      );

      // Back Attic Wall (facing +Z)
      const wallBackApex = new THREE.Vector3(midX, height, maxZ);
      addTriangle(
        baseBR, wallBackApex, baseBL,
        { u: 0, v: 0 },
        { u: (midX - minX) * uvScale, v: height * uvScale },
        { u: (maxX - minX) * uvScale, v: 0 },
        2
      );
    }

    // Combine buffers and generate multi-material groups
    const positions = new Float32Array([...p0, ...p1, ...p2]);
    const normals = new Float32Array([...n0, ...n1, ...n2]);
    const uvs = new Float32Array([...u0, ...u1, ...u2]);

    const count0 = p0.length / 3;
    const count1 = p1.length / 3;
    const count2 = p2.length / 3;

    const indices = new Uint32Array(count0 + count1 + count2);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = i;
    }

    const groups = [
      { start: 0, count: count0, materialIndex: 0 },
      { start: count0, count: count1, materialIndex: 1 },
      { start: count0 + count1, count: count2, materialIndex: 2 },
    ];

    return {
      positions,
      normals,
      uvs,
      indices,
      groups,
    };
  }

  /**
   * Generates ultra-lightweight collision geometry buffers for Rapier Physics.
   */
  public static generateColliderBuffers(config: Partial<ProceduralRoofConfig>): {
    positions: Float32Array;
    indices: Uint32Array;
  } {
    const fullConfig: ProceduralRoofConfig = { ...DEFAULT_ROOF_CONFIG, ...config };
    const { minX, maxX, minZ, maxZ, height, roofType } = fullConfig;

    const midX = (minX + maxX) / 2;
    const p: number[] = [];

    const addTri = (
      v1: { x: number; y: number; z: number },
      v2: { x: number; y: number; z: number },
      v3: { x: number; y: number; z: number }
    ) => {
      p.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z, v3.x, v3.y, v3.z);
      p.push(v1.x, v1.y, v1.z, v3.x, v3.y, v3.z, v2.x, v2.y, v2.z);
    };

    if (roofType === 'shed') {
      const vLowLeft = { x: minX, y: 0, z: minZ };
      const vLowRight = { x: maxX, y: 0, z: minZ };
      const vHighRight = { x: maxX, y: height, z: maxZ };
      const vHighLeft = { x: minX, y: height, z: maxZ };

      // Slope ramp
      addTri(vLowLeft, vLowRight, vHighRight);
      addTri(vLowLeft, vHighRight, vHighLeft);

      // Side triangular walls
      const vBaseHighLeft = { x: minX, y: 0, z: maxZ };
      const vBaseHighRight = { x: maxX, y: 0, z: maxZ };
      addTri(vLowLeft, vHighLeft, vBaseHighLeft);
      addTri(vLowRight, vBaseHighRight, vHighRight);
      // Rear wall
      addTri(vBaseHighLeft, vBaseHighRight, vHighRight);
      addTri(vBaseHighLeft, vHighRight, vHighLeft);

    } else if (roofType === 'hip') {
      const width = maxX - minX;
      const length = maxZ - minZ;
      const midZ = (minZ + maxZ) / 2;
      const inset = Math.min(width, length) / 2;

      let rF: { x: number; y: number; z: number };
      let rB: { x: number; y: number; z: number };

      if (length >= width) {
        rF = { x: midX, y: height, z: minZ + inset };
        rB = { x: midX, y: height, z: maxZ - inset };
      } else {
        rF = { x: minX + inset, y: height, z: midZ };
        rB = { x: maxX - inset, y: height, z: midZ };
      }

      const vLF = { x: minX, y: 0, z: minZ };
      const vRF = { x: maxX, y: 0, z: minZ };
      const vRB = { x: maxX, y: 0, z: maxZ };
      const vLB = { x: minX, y: 0, z: maxZ };

      // 4 slopes
      addTri(vRF, vLF, rF);
      addTri(vLB, vRB, rB);
      addTri(vLF, vLB, rB); addTri(vLF, rB, rF);
      addTri(vRB, vRF, rF); addTri(vRB, rF, rB);

    } else {
      // Gable Roof
      const gF = { x: midX, y: height, z: minZ };
      const gB = { x: midX, y: height, z: maxZ };

      const vLF = { x: minX, y: 0, z: minZ };
      const vRF = { x: maxX, y: 0, z: minZ };
      const vRB = { x: maxX, y: 0, z: maxZ };
      const vLB = { x: minX, y: 0, z: maxZ };

      // Slopes
      addTri(vLF, gB, gF);
      addTri(vLF, vLB, gB);
      addTri(vRF, gF, gB);
      addTri(vRF, gB, vRB);

      // Fronton walls
      addTri(vLF, gF, vRF);
      addTri(vLB, vRB, gB);
    }

    const indices = new Uint32Array(p.length / 3);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = i;
    }

    return {
      positions: new Float32Array(p),
      indices,
    };
  }

  public static createBufferGeometry(config: Partial<ProceduralRoofConfig>): THREE.BufferGeometry {
    const buffers = this.generateBuffers(config);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(buffers.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));

    // Multi-material groups for roof shingles vs white wood trim
    geometry.clearGroups();
    buffers.groups.forEach((g) => {
      geometry.addGroup(g.start, g.count, g.materialIndex);
    });

    return geometry;
  }

  public static updateBufferGeometry(
    geometry: THREE.BufferGeometry,
    config: Partial<ProceduralRoofConfig>
  ): THREE.BufferGeometry {
    const buffers = this.generateBuffers(config);
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;

    if (!posAttr || posAttr.count !== buffers.positions.length / 3) {
      geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(buffers.uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
    } else {
      (posAttr.array as Float32Array).set(buffers.positions);
      posAttr.needsUpdate = true;

      const normAttr = geometry.getAttribute('normal') as THREE.BufferAttribute;
      (normAttr.array as Float32Array).set(buffers.normals);
      normAttr.needsUpdate = true;

      const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute;
      (uvAttr.array as Float32Array).set(buffers.uvs);
      uvAttr.needsUpdate = true;

      if (geometry.index) {
        (geometry.index.array as Uint32Array).set(buffers.indices);
        geometry.index.needsUpdate = true;
      }
    }

    // Always update multi-material group offsets
    geometry.clearGroups();
    buffers.groups.forEach((g) => {
      geometry.addGroup(g.start, g.count, g.materialIndex);
    });

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/**
 * ProceduralRoofSystem facade providing backward compatibility for building presets
 * and style management
 */
export class ProceduralRoofSystem {
  public static roofMaterial: THREE.MeshLambertMaterial = PROCEDURAL_ROOF_MATERIALS.heartopiaShingle;
  public static trimMaterial: THREE.MeshLambertMaterial = PROCEDURAL_ROOF_MATERIALS.woodTrim;

  public static applyRoofTextureStyle(style: RoofStyle): void {
    let tex: THREE.CanvasTexture;
    if (style === 'barkwood' || style === 'wood_shingles') {
      tex = createBarkwoodShingleTexture();
    } else if (style === 'sunrise') {
      tex = createSunriseShingleTexture();
    } else if (style === 'mission' || style === 'terracotta') {
      tex = createMissionTileTexture();
    } else if (style === 'blue_slate') {
      tex = createBlueSlateTexture();
    } else {
      tex = createBarkwoodShingleTexture();
    }

    if (this.roofMaterial) {
      this.roofMaterial.map = tex;
      this.roofMaterial.needsUpdate = true;
    }

    if (this.trimMaterial) {
      // Always ensure crisp white architectural trim
      this.trimMaterial.color.setHex(0xffffff);
      this.trimMaterial.needsUpdate = true;
    }
  }

  public static buildGableRoofGeometry(params: RoofParams): THREE.BufferGeometry {
    const halfW = params.width / 2;
    const halfL = params.length / 2;
    return ProceduralRoofGenerator.createBufferGeometry({
      minX: -halfW,
      maxX: halfW,
      minZ: -halfL,
      maxZ: halfL,
      height: params.pitchHeight,
      roofType: 'gable',
      overhang: params.overhang,
    });
  }

  public static buildHipRoofGeometry(params: RoofParams): THREE.BufferGeometry {
    const halfW = params.width / 2;
    const halfL = params.length / 2;
    return ProceduralRoofGenerator.createBufferGeometry({
      minX: -halfW,
      maxX: halfW,
      minZ: -halfL,
      maxZ: halfL,
      height: params.pitchHeight,
      roofType: 'hip',
      overhang: params.overhang,
    });
  }

  public static buildShedRoofGeometry(params: RoofParams): THREE.BufferGeometry {
    const halfW = params.width / 2;
    const halfL = params.length / 2;
    return ProceduralRoofGenerator.createBufferGeometry({
      minX: -halfW,
      maxX: halfW,
      minZ: -halfL,
      maxZ: halfL,
      height: params.pitchHeight,
      roofType: 'shed',
      overhang: params.overhang,
    });
  }
}
