import * as THREE from 'three';
import { emitRoof, roofColliderTriangles, solveRoofShape } from './RoofGeometry';
import type { RoofDormer } from './RoofDormers';
import {
  createBarkwoodShingleTexture, createSunriseShingleTexture, createMissionTileTexture,
  createBlueSlateTexture, createScallopedRoofTexture, createStandingSeamRoofTexture, createStrawRoofTexture,
} from './textures/RoofTextures';

export type RoofType = 'gable' | 'hip' | 'shed' | 'gambrel' | 'mansard';

export interface ProceduralRoofConfig {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  roofType: RoofType;
  /**
   * House roof: closed loop of wall centre lines (x, z) in local space, every edge along X or Z.
   * The roof follows it as one hip roof (valleys at inner corners); min/max are its bounds.
   */
  footprint?: Array<[number, number]>;
  /** Dormers standing on the roof's slopes */
  dormers?: RoofDormer[];

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

// =========================================================================
// WHITE ARCHITECTURAL WOOD TRIM & ATTIC SIDING TEXTURE (Sims 4 Style)
// Clean crisp white satin paint finish with horizontal lap siding for frontons
// =========================================================================

export function createSims4WhiteTrimTexture(): THREE.CanvasTexture {
  // One seamless repeat = 1m x 1m of painted white trim board (fascia, rake, soffit)
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(0.25, 0.25);

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

// =========================================================================
// ROOF STYLES: one cached shingle material per style, chosen per roof
// =========================================================================

export const ROOF_STYLES = ['barkwood', 'sunrise', 'mission', 'blue_slate', 'scalloped_clay', 'standing_seam', 'thatch'] as const;
export type RoofStyle = (typeof ROOF_STYLES)[number];
export const DEFAULT_ROOF_STYLE: RoofStyle = 'barkwood';

/** Accepts the older scene-wide style names saved before roofs were styled one by one */
export function normalizeRoofStyle(style: unknown): RoofStyle {
  if (style === 'terracotta') return 'mission';
  if (style === 'wood_shingles') return 'barkwood';
  return (ROOF_STYLES as readonly unknown[]).includes(style) ? (style as RoofStyle) : DEFAULT_ROOF_STYLE;
}

const SHINGLE_TEXTURES: Record<RoofStyle, () => THREE.CanvasTexture> = {
  barkwood: createBarkwoodShingleTexture,
  sunrise: createSunriseShingleTexture,
  mission: createMissionTileTexture,
  blue_slate: createBlueSlateTexture,
  scalloped_clay: createScallopedRoofTexture,
  standing_seam: createStandingSeamRoofTexture,
  thatch: createStrawRoofTexture,
};

const shingleMaterials = new Map<RoofStyle, THREE.MeshLambertMaterial>();

export function createRoofSurfaceMaterial(params: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial(params);
  material.defines = { SKIP_INTERIOR_SHADE: 1 };
  return material;
}

export function getRoofShingleMaterial(style: RoofStyle): THREE.MeshLambertMaterial {
  let mat = shingleMaterials.get(style);
  if (!mat) {
    mat = createRoofSurfaceMaterial({ map: SHINGLE_TEXTURES[style]() });
    mat.name = `RoofShingle_${style}`;
    shingleMaterials.set(style, mat);
  }
  return mat;
}

export const PROCEDURAL_ROOF_MATERIALS = {
  heartopiaShingle: getRoofShingleMaterial('barkwood'),
  woodTrim: createRoofSurfaceMaterial({
    map: createSims4WhiteTrimTexture(),
    color: new THREE.Color(0xffffff),
  }),
  terracotta: getRoofShingleMaterial('mission'),
  slate: getRoofShingleMaterial('blue_slate'),
  gableWall: new THREE.MeshLambertMaterial({
    map: createRoofLapSidingTexture(),
    color: new THREE.Color(0xffffff),
  }),
};

/**
 * Procedural roof geometry (shape in RoofGeometry):
 * - Material 0: shingles and raised ridge / hip caps
 * - Material 1: white trim (fascia, rake boards, underside, attic ceiling)
 * - Material 2: frontons and attic walls (follow the outer finish of the wall below)
 * - Material 3: dormer window glass (opaque)
 */
export class ProceduralRoofGenerator {
  public static generateBuffers(config: Partial<ProceduralRoofConfig>): RoofBuffers {
    const cfg: ProceduralRoofConfig = { ...DEFAULT_ROOF_CONFIG, ...config };
    const buckets = emitRoof(solveRoofShape(cfg), cfg.uvScale ?? 1);

    const counts = buckets.map((bk) => bk.p.length / 3);
    const total = counts.reduce((a, c) => a + c, 0);
    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const uvs = new Float32Array(total * 2);
    let v = 0;
    for (const bk of buckets) {
      positions.set(bk.p, v * 3);
      normals.set(bk.n, v * 3);
      uvs.set(bk.u, v * 2);
      v += bk.p.length / 3;
    }
    const indices = new Uint32Array(total);
    for (let i = 0; i < total; i++) indices[i] = i;

    return {
      positions,
      normals,
      uvs,
      indices,
      groups: [
        { start: 0, count: counts[0], materialIndex: 0 },
        { start: counts[0], count: counts[1], materialIndex: 1 },
        { start: counts[0] + counts[1], count: counts[2], materialIndex: 2 },
        { start: counts[0] + counts[1] + counts[2], count: counts[3], materialIndex: 3 },
      ],
    };
  }

  /** Collision mesh: the same top surface that is drawn (overhang included) plus the attic walls */
  public static generateColliderBuffers(config: Partial<ProceduralRoofConfig>): {
    positions: Float32Array;
    indices: Uint32Array;
  } {
    const cfg: ProceduralRoofConfig = { ...DEFAULT_ROOF_CONFIG, ...config };
    const positions = new Float32Array(roofColliderTriangles(solveRoofShape(cfg)));
    const indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    return { positions, indices };
  }

  public static createBufferGeometry(config: Partial<ProceduralRoofConfig>): THREE.BufferGeometry {
    const buffers = this.generateBuffers(config);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(buffers.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
    for (const g of buffers.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  public static updateBufferGeometry(
    geometry: THREE.BufferGeometry,
    config: Partial<ProceduralRoofConfig>
  ): THREE.BufferGeometry {
    const buffers = this.generateBuffers(config);
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;

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
    }

    geometry.clearGroups();
    for (const g of buffers.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}
