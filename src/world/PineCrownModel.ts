import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * The near pine's crown as modelled by hand (exported from Blender): rows of scalloped paws from
 * the trunk and the merged tuft on top. It is authored in the game's own pine space (the pack's
 * pine with its node transform and MODEL_SCALE baked in), so it is used as it is, no fitting.
 * Only the green (crown) triangles are taken; a trunk in the file is ignored, the pack's trunk
 * stays (the axe's notch is carved into it).
 */
const PINE_CROWN_URL = `${import.meta.env.BASE_URL}models/pine_crown.gltf`;

const isGreen = (r: number, g: number, b: number): boolean => g > r && g > b;

let loading: Promise<THREE.BufferGeometry | null> | null = null;

/** The crown geometry (position, normal, RGB colour, sway, index), or null when the file is missing. */
export function loadPineCrown(): Promise<THREE.BufferGeometry | null> {
  loading ??= new GLTFLoader()
    .loadAsync(PINE_CROWN_URL)
    .then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const pos: number[] = [];
      const nor: number[] = [];
      const col: number[] = [];
      const idx: number[] = [];
      const v = new THREE.Vector3();
      const nm = new THREE.Matrix3();
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry;
        const P = g.getAttribute('position');
        const N = g.getAttribute('normal');
        const C = g.getAttribute('color');
        if (!P || !C) return;
        nm.getNormalMatrix(mesh.matrixWorld);
        const base = pos.length / 3;
        for (let i = 0; i < P.count; i++) {
          v.fromBufferAttribute(P, i).applyMatrix4(mesh.matrixWorld);
          pos.push(v.x, v.y, v.z);
          if (N) v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
          else v.set(0, 1, 0);
          nor.push(v.x, v.y, v.z);
          // getX/Y/Z de-normalise the file's 16-bit colours
          col.push(C.getX(i), C.getY(i), C.getZ(i));
        }
        const I = g.index;
        const tris = I ? I.count / 3 : P.count / 3;
        for (let t = 0; t < tris; t++) {
          const a = I ? I.getX(t * 3) : t * 3;
          const b = I ? I.getX(t * 3 + 1) : t * 3 + 1;
          const c = I ? I.getX(t * 3 + 2) : t * 3 + 2;
          const green = [a, b, c].every((k) => isGreen(C.getX(k), C.getY(k), C.getZ(k)));
          if (green) idx.push(base + a, base + b, base + c);
        }
      });
      if (!idx.length) throw new Error('pine_crown.gltf: no green crown triangles');
      return withSway(pos, nor, col, idx);
    })
    .catch((err) => {
      console.warn('[Trees] pine_crown.gltf failed to load, using the generated pine paws', err);
      return null;
    });
  return loading;
}

/**
 * Wind weight per vertex: nothing at the trunk, full at a paw's rim. A paw's rim is the far end of
 * its own connected piece, so short paws at the top sway as fully at their tips as long ones.
 */
function withSway(pos: number[], nor: number[], col: number[], idx: number[]): THREE.BufferGeometry {
  const n = pos.length / 3;
  // Connected pieces (one per paw, one for the tuft) through shared vertices
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let t = 0; t < idx.length; t += 3) {
    parent[find(idx[t + 1])] = find(idx[t]);
    parent[find(idx[t + 2])] = find(idx[t]);
  }
  const radius = (i: number) => Math.hypot(pos[i * 3], pos[i * 3 + 2]);
  const reach = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    reach[r] = Math.max(reach[r], radius(i));
  }
  const sway = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = radius(i) / Math.max(0.05, reach[find(i)]);
    sway[i] = Math.pow(Math.min(1, f), 1.5);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('sway', new THREE.BufferAttribute(sway, 1));
  g.setIndex(idx);
  return g;
}

/** `src`'s trunk (its non-green triangles; the crown dropped) with `crown` in place of its crown. */
export function trunkWithCrown(src: THREE.BufferGeometry, crown: THREE.BufferGeometry): THREE.BufferGeometry {
  const P = src.getAttribute('position');
  const N = src.getAttribute('normal');
  const C = src.getAttribute('color');
  const I = src.index;
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const sway: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < P.count; i++) {
    pos.push(P.getX(i), P.getY(i), P.getZ(i));
    nor.push(N.getX(i), N.getY(i), N.getZ(i));
    col.push(C.getX(i), C.getY(i), C.getZ(i));
    sway.push(0);
  }
  const tris = I ? I.count / 3 : P.count / 3;
  for (let t = 0; t < tris; t++) {
    const k = [0, 1, 2].map((e) => (I ? I.getX(t * 3 + e) : t * 3 + e));
    if (k.every((i) => isGreen(C.getX(i), C.getY(i), C.getZ(i)))) continue;
    idx.push(k[0], k[1], k[2]);
  }
  const base = P.count;
  const cp = crown.getAttribute('position');
  const cn = crown.getAttribute('normal');
  const cc = crown.getAttribute('color');
  const cs = crown.getAttribute('sway');
  for (let i = 0; i < cp.count; i++) {
    pos.push(cp.getX(i), cp.getY(i), cp.getZ(i));
    nor.push(cn.getX(i), cn.getY(i), cn.getZ(i));
    col.push(cc.getX(i), cc.getY(i), cc.getZ(i));
    sway.push(cs.getX(i));
  }
  const ci = crown.index!;
  for (let k = 0; k < ci.count; k++) idx.push(base + ci.getX(k));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('sway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx);
  g.addGroup(0, idx.length, 0);
  g.computeBoundingSphere();
  return g;
}
