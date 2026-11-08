import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CropStage, CropType } from './types/FarmingTypes';
import { createFieldCropMaterial } from './WheatModel';

const PACK_URL = `${import.meta.env.BASE_URL}models/plants_pack.glb`;

/** Proximity-push springs for a crop on the fields (like the wheat). */
export interface CropPushSpec {
  /** Tip offset (m, world) at full push. */
  maxBend: number;
}

interface CropModelSpec {
  /** Node name in plants_pack.glb. */
  node: string;
  /** Stage 1 is a leaves-only sprout (fruit triangles dropped); otherwise the whole model shrunk. */
  sproutLeavesOnly: boolean;
  /** Linear-RGB colour fruit, flowers and cobs take while unripe (stage 2, and stage 1 when kept). */
  unripe: [number, number, number];
  unripeMix: number;
  /** Wind bend relative to the wheat's, for the mature height. */
  sway: number;
  push: CropPushSpec | null;
  /** Field layout: rows x rows plants, `spacing` m apart, at `scale`. */
  field: { rows: number; spacing: number; scale: number };
}

/** Crops drawn from the plant pack (wheat has its own model). */
const SPECS: Partial<Record<CropType, CropModelSpec>> = {
  tomato: {
    node: 'tomato',
    sproutLeavesOnly: true,
    unripe: [0.22, 0.5, 0.05],
    unripeMix: 0.85,
    sway: 0.7,
    push: { maxBend: 0.3 },
    field: { rows: 4, spacing: 0.9, scale: 1.25 },
  },
  strawberry: {
    node: 'strawberry',
    sproutLeavesOnly: true,
    unripe: [0.55, 0.7, 0.35],
    unripeMix: 0.8,
    sway: 0.6,
    push: { maxBend: 0.2 },
    field: { rows: 5, spacing: 0.7, scale: 1.15 },
  },
  corn: {
    node: 'corn',
    sproutLeavesOnly: true,
    unripe: [0.3, 0.55, 0.08],
    unripeMix: 0.92,
    sway: 0.75,
    push: { maxBend: 0.42 },
    field: { rows: 5, spacing: 0.7, scale: 1.3 },
  },
  eggplant: {
    node: 'eggplant',
    sproutLeavesOnly: true,
    unripe: [0.3, 0.12, 0.45],
    unripeMix: 0.55,
    sway: 0.6,
    push: { maxBend: 0.3 },
    field: { rows: 4, spacing: 0.92, scale: 1.2 },
  },
  carrot: {
    node: 'carrot',
    sproutLeavesOnly: false,
    unripe: [1, 0.3, 0],
    unripeMix: 0,
    sway: 0.55,
    push: null,
    field: { rows: 6, spacing: 0.6, scale: 1.3 },
  },
  cabbage: {
    node: 'cabbage',
    sproutLeavesOnly: false,
    unripe: [0.2, 0.6, 0.05],
    unripeMix: 0,
    sway: 0.12,
    push: null,
    field: { rows: 5, spacing: 0.7, scale: 1.5 },
  },
  pumpkin: {
    node: 'pumpkin',
    sproutLeavesOnly: false,
    unripe: [0.35, 0.55, 0.06],
    unripeMix: 0.9,
    sway: 0.08,
    push: null,
    field: { rows: 4, spacing: 0.92, scale: 1.5 },
  },
};

/** Stage size relative to the mature model: [height, width]. */
const STAGE_SCALE: Record<CropStage, [number, number]> = { 1: [0.4, 0.6], 2: [0.74, 0.86], 3: [1, 1] };

export interface CropModel {
  /** Single plant per stage, at model scale (fields place these as instances). */
  stages: Record<CropStage, THREE.BufferGeometry>;
  material: THREE.MeshLambertMaterial;
  push: CropPushSpec | null;
  field: CropModelSpec['field'];
}

const models = new Map<CropType, CropModel>();
let loading: Promise<void> | null = null;

/** The crop's pack model once loaded (null for wheat, or before / if the pack fails to load). */
export function getCropModel(type: CropType): CropModel | null {
  return models.get(type) ?? null;
}

/** Loads plants_pack.glb once and derives every crop's three growth stages. */
export function loadCropModels(): Promise<void> {
  if (loading) return loading;
  loading = new GLTFLoader()
    .loadAsync(PACK_URL)
    .then((gltf) => {
      for (const [type, spec] of Object.entries(SPECS) as [CropType, CropModelSpec][]) {
        const node = gltf.scene.getObjectByName(spec.node) as THREE.Mesh | undefined;
        if (!node?.isMesh) {
          console.warn(`[Crops] plants_pack.glb has no "${spec.node}" mesh`);
          continue;
        }
        node.updateWorldMatrix(true, false);
        const source = node.geometry.clone().applyMatrix4(node.matrixWorld);
        const stages = {
          1: buildStage(source, spec, 1),
          2: buildStage(source, spec, 2),
          3: buildStage(source, spec, 3),
        } as Record<CropStage, THREE.BufferGeometry>;
        source.dispose();
        const height = stages[3].boundingBox!.max.y;
        // Normalise the wind so a crop's tip moves `sway` times the wheat tip's (wheat is 0.8 m)
        const sway = spec.sway * (0.8 / height) ** 2;
        models.set(type, {
          stages,
          material: createFieldCropMaterial(sway, height),
          push: spec.push,
          field: spec.field,
        });
      }
      gltf.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    })
    .catch((err) => console.warn('[Crops] plants_pack.glb failed to load, its crops stay invisible', err));
  return loading;
}

/** Leaves and stems: clearly green. Everything else is fruit, flowers, cobs or roots. */
function isLeaf(r: number, g: number, b: number): boolean {
  return g > r * 1.25 && g > b * 1.25;
}

/**
 * One growth stage as a compact indexed geometry with position, normal and RGB colour only: the
 * same attribute layout as the wheat, so every crop shares its shader program.
 *  - Stage 3: the model as authored.
 *  - Stage 2: smaller, fruit tinted unripe (shading kept).
 *  - Stage 1: a small sprout; leaves only for crops whose fruit hangs on the plant.
 */
function buildStage(source: THREE.BufferGeometry, spec: CropModelSpec, stage: CropStage): THREE.BufferGeometry {
  const pos = source.getAttribute('position');
  const nrm = source.getAttribute('normal');
  const col = source.getAttribute('color');
  const count = pos.count;
  const index = source.index ? (source.index.array as ArrayLike<number>) : Array.from({ length: count }, (_, i) => i);

  const leaf = new Uint8Array(count);
  let fruitMax = 0;
  for (let i = 0; i < count; i++) {
    const r = col ? col.getX(i) : 0;
    const g = col ? col.getY(i) : 1;
    const b = col ? col.getZ(i) : 0;
    leaf[i] = isLeaf(r, g, b) ? 1 : 0;
    if (!leaf[i]) fruitMax = Math.max(fruitMax, r, g, b);
  }

  // Triangles to keep, and a remap so the dropped fruit's vertices leave the buffer too
  const dropFruit = stage === 1 && spec.sproutLeavesOnly;
  const remap = new Int32Array(count).fill(-1);
  const tris: number[] = [];
  let used = 0;
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    if (dropFruit && !(leaf[a] && leaf[b] && leaf[c])) continue;
    for (const v of [a, b, c]) {
      if (remap[v] < 0) remap[v] = used++;
      tris.push(remap[v]);
    }
  }

  const [sy, sxz] = STAGE_SCALE[stage];
  const outPos = new Float32Array(used * 3);
  const outNrm = new Float32Array(used * 3);
  const outCol = new Float32Array(used * 3);
  const [ur, ug, ub] = spec.unripe;
  const mix = stage === 3 ? 0 : spec.unripeMix;
  for (let i = 0; i < count; i++) {
    const o = remap[i];
    if (o < 0) continue;
    outPos[o * 3] = pos.getX(i) * sxz;
    outPos[o * 3 + 1] = pos.getY(i) * sy;
    outPos[o * 3 + 2] = pos.getZ(i) * sxz;
    if (nrm) {
      outNrm[o * 3] = nrm.getX(i);
      outNrm[o * 3 + 1] = nrm.getY(i);
      outNrm[o * 3 + 2] = nrm.getZ(i);
    }
    let r = col ? col.getX(i) : 0.2;
    let g = col ? col.getY(i) : 0.5;
    let b = col ? col.getZ(i) : 0.1;
    if (!leaf[i] && mix > 0) {
      // Unripe colour at the vertex's own brightness, so the fruit keeps its facet shading
      const shade = fruitMax > 0 ? Math.max(r, g, b) / fruitMax : 1;
      r += (ur * shade - r) * mix;
      g += (ug * shade - g) * mix;
      b += (ub * shade - b) * mix;
    } else if (stage === 1) {
      // Fresh sprouts read a little lighter than the mature leaves
      r = r * 1.1 + 0.02;
      g = g * 1.12 + 0.03;
    }
    outCol[o * 3] = r;
    outCol[o * 3 + 1] = g;
    outCol[o * 3 + 2] = b;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(outCol, 3));
  g.setIndex(used > 65535 ? new THREE.Uint32BufferAttribute(tris, 1) : new THREE.Uint16BufferAttribute(tris, 1));
  if (!nrm) g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
