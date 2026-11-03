import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BuildingPieceDef, BuildingPieceType, PieceCategory } from '../types/BuildingTypes';

/**
 * Placeable cozy furniture (Heartopia style): every piece is a procedural mesh built from a few
 * boxes/cylinders, merged into ONE geometry with one group per material (a handful of draw calls),
 * pivot at the centre of its bounding box like every other building piece.
 */

export const FURNITURE_TYPES: BuildingPieceType[] = [
  BuildingPieceType.FURN_DINING_TABLE,
  BuildingPieceType.FURN_COFFEE_TABLE,
  BuildingPieceType.FURN_WOOD_CHAIR,
  BuildingPieceType.FURN_ARMCHAIR,
  BuildingPieceType.FURN_SOFA,
  BuildingPieceType.FURN_BED_SINGLE,
  BuildingPieceType.FURN_BED_DOUBLE,
  BuildingPieceType.FURN_WARDROBE,
  BuildingPieceType.FURN_DRESSER,
  BuildingPieceType.FURN_NIGHTSTAND,
  BuildingPieceType.FURN_BOOKSHELF,
  BuildingPieceType.FURN_CHANDELIER,
  BuildingPieceType.FURN_TABLE_LAMP,
];

/** Furniture that hangs from a ceiling instead of standing on a surface. */
export function isCeilingFurniture(type: BuildingPieceType): boolean {
  return type === BuildingPieceType.FURN_CHANDELIER;
}

/**
 * Light emitted by lamp furniture, relative to the piece pivot (bounding-box centre).
 * Read by the night lighting.
 */
export const FURNITURE_LIGHTS: Partial<Record<BuildingPieceType, { yOffset: number; range: number; halo: number; intensity: number }>> = {
  [BuildingPieceType.FURN_CHANDELIER]: { yOffset: 0.02, range: 6.5, halo: 1.4, intensity: 0.45 },
  [BuildingPieceType.FURN_TABLE_LAMP]: { yOffset: 0.08, range: 3.5, halo: 0.8, intensity: 0.32 },
};

const FURNITURE_SET = new Set(FURNITURE_TYPES);

export function isFurniturePiece(type: BuildingPieceType): boolean {
  return FURNITURE_SET.has(type);
}

/** Placement grid step for furniture when snapping is on (meters). */
export const FURNITURE_GRID_STEP = 0.25;

// ---------------------------------------------------------------------------
// Materials (shared by all furniture instances)
// ---------------------------------------------------------------------------

function makeCanvasTexture(draw: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Light wood grain running along U, tiling seamlessly. Tinted by material colour. */
const woodGrainTexture = makeCanvasTexture((ctx, size) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 70; i++) {
    const y = Math.random() * size;
    ctx.strokeStyle = `rgba(90, 55, 25, ${0.05 + Math.random() * 0.08})`;
    ctx.lineWidth = 1 + Math.random() * 1.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= size; x += 32) {
      ctx.lineTo(x, y + Math.sin((x / size) * Math.PI * 2 + i) * 2);
    }
    ctx.stroke();
  }
});

/** Soft woven fabric. */
const fabricTexture = makeCanvasTexture((ctx, size) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y += 4) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.035)';
    ctx.fillRect(0, y, size, 2);
  }
  for (let x = 0; x < size; x += 4) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.025)';
    ctx.fillRect(x, 0, 2, size);
  }
});

const wood = (color: string) => new THREE.MeshLambertMaterial({ color, map: woodGrainTexture });
const fabric = (color: string) => new THREE.MeshLambertMaterial({ color, map: fabricTexture });
const plain = (color: string) => new THREE.MeshLambertMaterial({ color });

export const FURNITURE_MATERIALS = {
  oak: wood('#d2a679'),
  walnut: wood('#8a5a3b'),
  paintedWhite: wood('#f4efe6'),
  sage: fabric('#9cb894'),
  cream: fabric('#efe4cf'),
  rose: fabric('#e0a596'),
  linen: fabric('#fbf8f2'),
  blanketBlue: fabric('#93b5d8'),
  blanketPink: fabric('#f0b8c4'),
  brass: plain('#c9a24a'),
  bookRed: plain('#c0574b'),
  bookBlue: plain('#5878a8'),
  bookGreen: plain('#6f9a62'),
  bookYellow: plain('#e0b85a'),
  candle: plain('#f6efdc'),
  /** Lamp shade fabric; the night lighting raises its emissive after dusk. */
  shade: new THREE.MeshLambertMaterial({ color: '#f3e3c4', map: fabricTexture, side: THREE.DoubleSide, emissive: '#000000' }),
  /** Bulbs and candle flames; the night lighting brightens them after dusk. */
  bulb: new THREE.MeshBasicMaterial({ color: '#f5e2b8' }),
};

// ---------------------------------------------------------------------------
// Builder: collects parts per material, merges them into one grouped geometry
// ---------------------------------------------------------------------------

/** Texture repeats per meter on furniture surfaces. */
const TEXEL_DENSITY = 1.5;

class FurnitureBuilder {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();

  private add(mat: THREE.Material, geo: THREE.BufferGeometry): void {
    const list = this.parts.get(mat) ?? [];
    list.push(geo.index ? geo.toNonIndexed() : geo);
    this.parts.set(mat, list);
  }

  /** Box resting with its bottom at y (floor = 0), centred on x/z. */
  box(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): this {
    const geo = new THREE.BoxGeometry(w, h, d);
    // Scale UVs to the face's real size so wood grain is never stretched (faces: +x,-x,+y,-y,+z,-z)
    const faceDims: Array<[number, number]> = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let f = 0; f < 6; f++) {
      const [fu, fv] = faceDims[f];
      for (let k = 0; k < 4; k++) {
        const i = f * 4 + k;
        uv.setXY(i, uv.getX(i) * fu * TEXEL_DENSITY, uv.getY(i) * fv * TEXEL_DENSITY);
      }
    }
    geo.translate(x, y + h / 2, z);
    this.add(mat, geo);
    return this;
  }

  /** Soft rounded box (cushions, mattresses), bottom at y. */
  soft(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, radius = 0.05): this {
    const r = Math.min(radius, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
    const geo = new RoundedBoxGeometry(w, h, d, 2, r);
    geo.translate(x, y + h / 2, z);
    this.add(mat, geo);
    return this;
  }

  /** Vertical cylinder (legs, knobs), bottom at y. */
  cyl(mat: THREE.Material, radius: number, h: number, x: number, y: number, z: number, radiusTop = radius): this {
    const geo = new THREE.CylinderGeometry(radiusTop, radius, h, 10);
    geo.translate(x, y + h / 2, z);
    this.add(mat, geo);
    return this;
  }

  /** Any prepared geometry (already positioned in piece space). */
  part(mat: THREE.Material, geo: THREE.BufferGeometry): this {
    this.add(mat, geo);
    return this;
  }

  /** Sphere centred at (x, y, z). */
  ball(mat: THREE.Material, radius: number, x: number, y: number, z: number): this {
    const geo = new THREE.SphereGeometry(radius, 10, 8);
    geo.translate(x, y, z);
    this.add(mat, geo);
    return this;
  }

  /** Small knob sticking out of a front face (+Z) at height y. */
  knob(mat: THREE.Material, x: number, y: number, z: number, radius = 0.025): this {
    const geo = new THREE.SphereGeometry(radius, 8, 6);
    geo.translate(x, y, z);
    this.add(mat, geo);
    return this;
  }

  build(): { geometry: THREE.BufferGeometry; materials: THREE.Material[]; boundingBox: THREE.Box3 } {
    const materials: THREE.Material[] = [];
    const perMaterial: THREE.BufferGeometry[] = [];
    for (const [mat, geos] of this.parts) {
      materials.push(mat);
      perMaterial.push(geos.length === 1 ? geos[0] : mergeGeometries(geos, false)!);
    }
    const geometry = mergeGeometries(perMaterial, true)!;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // Pivot at the bounding box centre (matches every other building piece)
    const center = box.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -center.y, -center.z);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { geometry, materials, boundingBox: geometry.boundingBox!.clone() };
  }
}

// ---------------------------------------------------------------------------
// Furniture models. Front of every piece faces +Z (towards the player at yaw 0).
// ---------------------------------------------------------------------------

const M = FURNITURE_MATERIALS;

function legs4(b: FurnitureBuilder, mat: THREE.Material, w: number, d: number, h: number, inset: number, size: number): void {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box(mat, size, h, size, sx * (w / 2 - inset), 0, sz * (d / 2 - inset));
    }
  }
}

function buildDiningTable(): FurnitureBuilder {
  const b = new FurnitureBuilder();
  const w = 1.6, d = 0.9, h = 0.76, top = 0.05;
  b.box(M.oak, w, top, d, 0, h - top, 0);
  // Apron under the tabletop
  b.box(M.walnut, w - 0.14, 0.08, 0.03, 0, h - top - 0.08, d / 2 - 0.07);
  b.box(M.walnut, w - 0.14, 0.08, 0.03, 0, h - top - 0.08, -(d / 2 - 0.07));
  b.box(M.walnut, 0.03, 0.08, d - 0.14, w / 2 - 0.07, h - top - 0.08, 0);
  b.box(M.walnut, 0.03, 0.08, d - 0.14, -(w / 2 - 0.07), h - top - 0.08, 0);
  legs4(b, M.walnut, w, d, h - top, 0.07, 0.07);
  return b;
}

function buildCoffeeTable(): FurnitureBuilder {
  const b = new FurnitureBuilder();
  const w = 1.0, d = 0.6, h = 0.42;
  b.box(M.oak, w, 0.05, d, 0, h - 0.05, 0);
  b.box(M.oak, w - 0.12, 0.03, d - 0.12, 0, 0.1, 0); // lower shelf
  legs4(b, M.walnut, w, d, h - 0.05, 0.05, 0.05);
  return b;
}

function buildWoodChair(): FurnitureBuilder {
  const b = new FurnitureBuilder();
  const w = 0.46, d = 0.48, seatH = 0.45;
  b.box(M.oak, w, 0.04, d, 0, seatH - 0.04, 0);
  legs4(b, M.walnut, w, d, seatH - 0.04, 0.03, 0.045);
  // Back posts and slats (back is on -Z)
  const backZ = -(d / 2 - 0.03);
  b.box(M.walnut, 0.045, 0.48, 0.045, -(w / 2 - 0.03), seatH, backZ);
  b.box(M.walnut, 0.045, 0.48, 0.045, w / 2 - 0.03, seatH, backZ);
  b.box(M.oak, w - 0.02, 0.09, 0.025, 0, seatH + 0.37, backZ);
  for (const sx of [-0.1, 0, 0.1]) b.box(M.oak, 0.04, 0.3, 0.02, sx, seatH + 0.07, backZ);
  b.soft(M.sage, w - 0.08, 0.04, d - 0.1, 0, seatH, 0.01, 0.02);
  return b;
}

function buildArmchair(): FurnitureBuilder {
  const b = new FurnitureBuilder();
  const w = 0.9, d = 0.85;
  legs4(b, M.walnut, w, d, 0.1, 0.08, 0.05);
  b.soft(M.rose, w, 0.3, d, 0, 0.1, 0, 0.06); // base
  b.soft(M.cream, w - 0.32, 0.14, d - 0.2, 0, 0.36, 0.06, 0.05); // seat cushion
  b.soft(M.rose, w, 0.5, 0.2, 0, 0.36, -(d / 2 - 0.1), 0.07); // back
  b.soft(M.rose, 0.16, 0.26, d - 0.1, -(w / 2 - 0.08), 0.36, 0.03, 0.06); // arms
  b.soft(M.rose, 0.16, 0.26, d - 0.1, w / 2 - 0.08, 0.36, 0.03, 0.06);
  return b;
}

function buildSofa(): FurnitureBuilder {
  const b = new FurnitureBuilder();
  const w = 2.0, d = 0.9;
  legs4(b, M.walnut, w, d, 0.1, 0.1, 0.05);
  b.soft(M.sage, w, 0.28, d, 0, 0.1, 0, 0.06);
  for (const sx of [-0.535, 0, 0.535]) b.soft(M.sage, 0.52, 0.14, d - 0.26, sx, 0.34, 0.07, 0.05);
  b.soft(M.sage, w, 0.5, 0.22, 0, 0.34, -(d / 2 - 0.11), 0.07);
  b.soft(M.sage, 0.2, 0.28, d - 0.08, -(w / 2 - 0.1), 0.34, 0.02, 0.07);
  b.soft(M.sage, 0.2, 0.28, d - 0.08, w / 2 - 0.1, 0.34, 0.02, 0.07);
  // Two throw pillows
  b.soft(M.cream, 0.36, 0.3, 0.12, -0.55, 0.46, -(d / 2 - 0.3), 0.06);
  b.soft(M.rose, 0.36, 0.3, 0.12, 0.55, 0.46, -(d / 2 - 0.3), 0.06);
  return b;
}

function buildBed(width: number, blanket: THREE.Material): FurnitureBuilder {
  const b = new FurnitureBuilder();
  const len = 2.1;
  const frameH = 0.32;
  // Headboard at -Z, footboard at +Z
  b.box(M.oak, width + 0.08, 1.0, 0.07, 0, 0, -(len / 2));
  b.box(M.oak, width + 0.08, 0.5, 0.06, 0, 0, len / 2);
  b.box(M.walnut, width, 0.18, len - 0.1, 0, 0.12, 0); // frame rails
  legs4(b, M.walnut, width, len - 0.1, 0.14, 0.04, 0.07);
  b.soft(M.linen, width - 0.04, 0.2, len - 0.14, 0, frameH, 0, 0.05); // mattress
  // Blanket covering the lower two thirds, folded edge
  b.soft(blanket, width + 0.02, 0.06, len * 0.62, 0, frameH + 0.17, len * 0.17, 0.03);
  b.soft(M.linen, width + 0.02, 0.07, 0.14, 0, frameH + 0.18, len * 0.17 - len * 0.31 + 0.07, 0.03);
  // Pillows
  const pillows = width > 1.2 ? [-width / 4, width / 4] : [0];
  for (const px of pillows) b.soft(M.linen, Math.min(0.6, width - 0.2), 0.14, 0.38, px, frameH + 0.2, -(len / 2 - 0.3), 0.06);
  return b;
}

function buildWardrobe(): FurnitureBuilder {
  const b = new FurnitureBuilder();
  const w = 1.2, h = 2.0, d = 0.6;
  b.box(M.paintedWhite, w, h - 0.1, d, 0, 0.1, 0);
  b.box(M.oak, w + 0.06, 0.06, d + 0.04, 0, h - 0.04, 0); // crown
  b.box(M.oak, w, 0.1, d - 0.04, 0, 0, -0.02); // plinth
  // Two doors with recessed panels and brass handles
  for (const sx of [-1, 1]) {
    const cx = sx * w / 4;
    b.box(M.paintedWhite, w / 2 - 0.04, h - 0.26, 0.02, cx, 0.18, d / 2);
    b.box(M.oak, w / 2 - 0.16, 0.7, 0.012, cx, 0.32, d / 2 + 0.018);
    b.box(M.oak, w / 2 - 0.16, 0.7, 0.012, cx, 1.12, d / 2 + 0.018);
    b.cyl(M.brass, 0.012, 0.22, sx * 0.05, 0.95, d / 2 + 0.04);
  }
  return b;
}

function buildDresser(): FurnitureBuilder {
  const b = new FurnitureBuilder();
  const w = 1.2, h = 0.85, d = 0.5;
  b.box(M.walnut, w, h - 0.1, d, 0, 0.1, 0);
  b.box(M.oak, w + 0.04, 0.04, d + 0.03, 0, h - 0.04, 0);
  legs4(b, M.walnut, w, d, 0.1, 0.05, 0.06);
  for (let row = 0; row < 3; row++) {
    const y = 0.14 + row * 0.22;
    b.box(M.oak, w - 0.08, 0.18, 0.02, 0, y, d / 2);
    b.knob(M.brass, -0.25, y + 0.09, d / 2 + 0.025);
    b.knob(M.brass, 0.25, y + 0.09, d / 2 + 0.025);
  }
  return b;
}

function buildNightstand(): FurnitureBuilder {
  const b = new FurnitureBuilder();
  const w = 0.5, h = 0.55, d = 0.42;
  b.box(M.paintedWhite, w, h - 0.08, d, 0, 0.08, 0);
  b.box(M.oak, w + 0.03, 0.03, d + 0.02, 0, h - 0.03, 0);
  legs4(b, M.oak, w, d, 0.08, 0.04, 0.04);
  b.box(M.paintedWhite, w - 0.06, 0.16, 0.02, 0, h - 0.24, d / 2);
  b.knob(M.brass, 0, h - 0.16, d / 2 + 0.025);
  // Open shelf cut-out look
  b.box(M.oak, w - 0.06, 0.02, d - 0.04, 0, 0.2, 0.012);
  return b;
}

function buildBookshelf(): FurnitureBuilder {
  const b = new FurnitureBuilder();
  const w = 1.0, h = 1.8, d = 0.35, t = 0.03;
  b.box(M.oak, t, h, d, -(w / 2 - t / 2), 0, 0);
  b.box(M.oak, t, h, d, w / 2 - t / 2, 0, 0);
  b.box(M.oak, w, t, d, 0, h - t, 0);
  b.box(M.walnut, w - 2 * t, h - t, 0.015, 0, 0, -(d / 2 - 0.008)); // back panel
  const books = [M.bookRed, M.bookBlue, M.bookGreen, M.bookYellow, M.paintedWhite];
  const shelfYs = [0, 0.44, 0.88, 1.32];
  shelfYs.forEach((sy, s) => {
    b.box(M.oak, w - 2 * t, t, d - 0.02, 0, sy, 0.01);
    // A row of books with varied sizes (deterministic per shelf)
    let x = -(w / 2 - t) + 0.03;
    let i = s * 3;
    while (x < w / 2 - t - 0.12) {
      const bw = 0.04 + ((i * 37) % 5) * 0.012;
      const bh = 0.24 + ((i * 53) % 4) * 0.035;
      if ((i + s) % 7 === 6) {
        x += 0.08; // small gap
      } else {
        b.box(books[i % books.length], bw, bh, d - 0.1, x + bw / 2, sy + t, 0.02);
        x += bw + 0.004;
      }
      i++;
    }
  });
  return b;
}

function buildChandelier(): FurnitureBuilder {
  const b = new FurnitureBuilder();
  const top = 0.5;
  b.cyl(M.brass, 0.09, 0.04, 0, top - 0.04, 0, 0.07); // ceiling canopy
  b.cyl(M.brass, 0.012, 0.3, 0, top - 0.34, 0); // chain rod
  b.cyl(M.brass, 0.05, 0.16, 0, 0.0, 0, 0.065); // hub
  b.ball(M.brass, 0.035, 0, 0.0, 0); // finial
  const arms = 6;
  const reach = 0.3;
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2;
    const cx = Math.cos(a) * reach;
    const cz = Math.sin(a) * reach;
    // Gently curved arm: a thin box from the hub to the cup, tilted up
    const arm = new THREE.BoxGeometry(reach, 0.02, 0.02);
    arm.translate(reach / 2, 0, 0);
    arm.rotateZ(0.18);
    arm.rotateY(-a);
    arm.translate(0, 0.06, 0);
    b.part(M.brass, arm);
    const cupY = 0.06 + Math.sin(0.18) * reach;
    b.cyl(M.brass, 0.03, 0.03, cx, cupY, cz, 0.04);
    b.cyl(M.candle, 0.016, 0.09, cx, cupY + 0.03, cz);
    b.ball(M.bulb, 0.022, cx, cupY + 0.14, cz);
  }
  return b;
}

function buildTableLamp(): FurnitureBuilder {
  const b = new FurnitureBuilder();
  b.cyl(M.walnut, 0.09, 0.03, 0, 0, 0, 0.08); // base
  b.cyl(M.brass, 0.014, 0.27, 0, 0.03, 0); // stem
  b.ball(M.bulb, 0.04, 0, 0.31, 0);
  // Open drum shade
  const shade = new THREE.CylinderGeometry(0.1, 0.16, 0.2, 18, 1, true);
  shade.translate(0, 0.36, 0);
  b.part(M.shade, shade);
  b.cyl(M.brass, 0.1, 0.006, 0, 0.455, 0); // top rim
  return b;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface FurnitureSpec {
  type: BuildingPieceType;
  name: string;
  ukrainianName: string;
  size: [number, number, number];
  iconName: string;
  description: string;
  build: () => FurnitureBuilder;
}

const SPECS: FurnitureSpec[] = [
  { type: BuildingPieceType.FURN_DINING_TABLE, name: 'Dining Table', ukrainianName: 'Обідній стіл', size: [1.6, 0.76, 0.9], iconName: 'Table2', description: 'Дубовий обідній стіл на 4–6 місць.', build: buildDiningTable },
  { type: BuildingPieceType.FURN_COFFEE_TABLE, name: 'Coffee Table', ukrainianName: 'Журнальний столик', size: [1.0, 0.42, 0.6], iconName: 'Table2', description: 'Низький столик з полицею для вітальні.', build: buildCoffeeTable },
  { type: BuildingPieceType.FURN_WOOD_CHAIR, name: 'Wooden Chair', ukrainianName: 'Дерев’яне крісло', size: [0.46, 0.93, 0.48], iconName: 'Armchair', description: 'Дерев’яний стілець з рейковою спинкою та подушкою.', build: buildWoodChair },
  { type: BuildingPieceType.FURN_ARMCHAIR, name: 'Armchair', ukrainianName: 'Велике крісло', size: [0.9, 0.86, 0.85], iconName: 'Armchair', description: 'Мʼяке велике крісло з підлокітниками.', build: buildArmchair },
  { type: BuildingPieceType.FURN_SOFA, name: 'Sofa', ukrainianName: 'Диван', size: [2.0, 0.84, 0.9], iconName: 'Sofa', description: 'Тримісний шавлієвий диван з подушками.', build: buildSofa },
  { type: BuildingPieceType.FURN_BED_SINGLE, name: 'Single Bed', ukrainianName: 'Ліжко односпальне', size: [1.08, 1.0, 2.17], iconName: 'BedSingle', description: 'Односпальне дерев’яне ліжко з ковдрою.', build: () => buildBed(1.0, M.blanketBlue) },
  { type: BuildingPieceType.FURN_BED_DOUBLE, name: 'Double Bed', ukrainianName: 'Ліжко двоспальне', size: [1.68, 1.0, 2.17], iconName: 'BedDouble', description: 'Двоспальне ліжко з двома подушками.', build: () => buildBed(1.6, M.blanketPink) },
  { type: BuildingPieceType.FURN_WARDROBE, name: 'Wardrobe', ukrainianName: 'Шафа', size: [1.26, 2.0, 0.66], iconName: 'Archive', description: 'Висока двостулкова шафа для одягу.', build: buildWardrobe },
  { type: BuildingPieceType.FURN_DRESSER, name: 'Dresser', ukrainianName: 'Комод', size: [1.24, 0.85, 0.55], iconName: 'Archive', description: 'Горіховий комод з трьома шухлядами.', build: buildDresser },
  { type: BuildingPieceType.FURN_NIGHTSTAND, name: 'Nightstand', ukrainianName: 'Приліжкова тумба', size: [0.53, 0.55, 0.47], iconName: 'LampDesk', description: 'Маленька тумба з шухлядою біля ліжка.', build: buildNightstand },
  { type: BuildingPieceType.FURN_CHANDELIER, name: 'Chandelier', ukrainianName: 'Люстра', size: [0.68, 0.5, 0.68], iconName: 'LampCeiling', description: 'Латунна люстра на шість свічок. Вішається на стелю й світить уночі.', build: buildChandelier },
  { type: BuildingPieceType.FURN_TABLE_LAMP, name: 'Table Lamp', ukrainianName: 'Настільна лампа', size: [0.32, 0.46, 0.32], iconName: 'Lamp', description: 'Лампа з тканинним абажуром. Ставиться на стіл, тумбу чи підлогу й світить уночі.', build: buildTableLamp },
  { type: BuildingPieceType.FURN_BOOKSHELF, name: 'Bookshelf', ukrainianName: 'Книжкова шафа', size: [1.0, 1.8, 0.35], iconName: 'Library', description: 'Відкрита полиця з кольоровими книжками.', build: buildBookshelf },
];

const SPEC_BY_TYPE = new Map(SPECS.map((s) => [s.type, s]));

export function buildFurnitureTemplate(type: BuildingPieceType): {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  boundingBox: THREE.Box3;
} {
  const spec = SPEC_BY_TYPE.get(type);
  if (!spec) throw new Error(`Unknown furniture type ${type}`);
  return spec.build().build();
}

export const FURNITURE_PIECE_DEFS = Object.fromEntries(
  SPECS.map((s): [BuildingPieceType, BuildingPieceDef] => [
    s.type,
    {
      type: s.type,
      name: s.name,
      ukrainianName: s.ukrainianName,
      category: PieceCategory.FURNITURE,
      dimensions: new THREE.Vector3(...s.size),
      sockets: [],
      woodCost: 3,
      stoneCost: 0,
      maxHealth: 100,
      iconName: s.iconName,
      description: s.description,
    },
  ])
) as Record<BuildingPieceType, BuildingPieceDef>;
