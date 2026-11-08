/**
 * Exports the near-LOD pine (trunk + ring paws, as the game builds it) to .gltf files Blender can
 * import (File > Import > glTF 2.0). Vertex colours go to COLOR_0.
 *
 *   npx esbuild scripts/export-pine.ts --bundle --platform=node --format=esm --outfile=scripts/.export-pine.mjs
 *   node scripts/.export-pine.mjs
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { addRingScallops, RingScallopOptions } from '../src/world/RingScallops';

const PACK = 'public/models/trees_pack.glb';
const OUT_DIR = 'exports';
/** Same as the game: TreeModels MODEL_SCALE and the desktop vegetation defaults. */
const MODEL_SCALE = 1.2;
const CROWN_SHADE = 0.55;
const PAWS: RingScallopOptions = {
  pawsPerRow: 6, width: 0.6, droop: 1, overhang: 0, rowStep: 0.43, innerShade: 0.6, keepCrown: false, seed: 4242,
};

async function loadPine(): Promise<THREE.BufferGeometry> {
  const buf = readFileSync(PACK);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new GLTFLoader().parseAsync(ab, '');
  gltf.scene.updateMatrixWorld(true);
  let mesh: THREE.Mesh | null = null;
  gltf.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && /^(pine|pin)_tree_lod1$/i.test(o.name)) mesh = o as THREE.Mesh;
  });
  if (!mesh) throw new Error('pine_tree_lod1 not found');
  const m = mesh as THREE.Mesh;
  // As TreeModels.prepare: position / normal / colour, node transform and model scale baked in
  const src = m.geometry;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.getAttribute('position').clone());
  g.setAttribute('normal', src.getAttribute('normal').clone());
  const c = src.getAttribute('color');
  const n = g.getAttribute('position').count;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = c ? c.getX(i) : 1, gr = c ? c.getY(i) : 1, b = c ? c.getZ(i) : 1;
    // As TreeModels.shadeCrown: the crown's green darkened
    const k = gr > r && gr > b ? CROWN_SHADE : 1;
    rgb.set([r * k, gr * k, b * k], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  if (src.index) g.setIndex(src.index.clone());
  g.applyMatrix4(new THREE.Matrix4().makeScale(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE).multiply(m.matrixWorld));
  return g;
}

/** A self-contained .gltf (buffer embedded as base64): one mesh, vertex colours, double-sided. */
function toGltf(g: THREE.BufferGeometry, name: string): string {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const col = g.getAttribute('color');
  const n = pos.count;
  const index = g.index!;
  const parts: { data: Float32Array | Uint32Array; type: string; comp: number; target: number }[] = [
    { data: Float32Array.from({ length: n * 3 }, (_, i) => pos.array[i] as number), type: 'VEC3', comp: 5126, target: 34962 },
    { data: Float32Array.from({ length: n * 3 }, (_, i) => nor.array[i] as number), type: 'VEC3', comp: 5126, target: 34962 },
    { data: Float32Array.from({ length: n * 3 }, (_, i) => col.array[i] as number), type: 'VEC3', comp: 5126, target: 34962 },
    { data: Uint32Array.from(index.array as ArrayLike<number>), type: 'SCALAR', comp: 5125, target: 34963 },
  ];
  // Normals must be unit length in glTF
  const nv = parts[1].data as Float32Array;
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(nv[i * 3], nv[i * 3 + 1], nv[i * 3 + 2]) || 1;
    nv[i * 3] /= l;
    nv[i * 3 + 1] /= l;
    nv[i * 3 + 2] /= l;
  }
  let offset = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const chunks: Buffer[] = [];
  parts.forEach((p, k) => {
    const bytes = Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: p.target });
    const acc: Record<string, unknown> = { bufferView: k, componentType: p.comp, count: p.data.length / (p.type === 'VEC3' ? 3 : 1), type: p.type };
    if (k === 0) {
      g.computeBoundingBox();
      const b = g.boundingBox!;
      acc.min = [b.min.x, b.min.y, b.min.z];
      acc.max = [b.max.x, b.max.y, b.max.z];
    }
    accessors.push(acc);
    chunks.push(bytes);
    offset += bytes.length;
  });
  const all = Buffer.concat(chunks);
  return JSON.stringify(
    {
      asset: { version: '2.0', generator: 'farm-game export-pine' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name, mesh: 0 }],
      meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
      materials: [{ name: 'Pine', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
      buffers: [{ byteLength: all.length, uri: `data:application/octet-stream;base64,${all.toString('base64')}` }],
      bufferViews,
      accessors,
    },
    null,
    1,
  );
}

const pine = await loadPine();
mkdirSync(OUT_DIR, { recursive: true });
for (const file of ['pine_umbrella.gltf']) {
  const g = addRingScallops(pine, PAWS);
  writeFileSync(`${OUT_DIR}/${file}`, toGltf(g, file.replace('.gltf', '')));
  console.log(`${OUT_DIR}/${file}: ${g.getAttribute('position').count} vertices, ${g.index!.count / 3} triangles`);
}
