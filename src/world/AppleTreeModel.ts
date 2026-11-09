import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { addCrownLeaves } from './CrownLeaves';
import { vegetationSettings as veg } from './VegetationSettings';

const TREE_URL = `${import.meta.env.BASE_URL}models/apple_tree.glb`;
const APPLE_URL = `${import.meta.env.BASE_URL}models/apple.glb`;

/** Apples hanging on the tree (and the blossom clusters they grow from). */
export const FRUIT_PER_TREE = 10;
/** Blossom clusters in all; the first FRUIT_PER_TREE of them set fruit. */
const BLOSSOM_CLUSTERS = 58;
/** The apple model is ~0.22 m wide; drawn a bit larger so it reads on a 6.6 m tree. */
export const APPLE_SCALE = 1.45;

/**
 * Everything the orchard draws, built once from the two models:
 * - `near` / `far`: the tree with leaf scales on its crown (like the oak and bushes) / plain crown;
 * - `blossom`: one merged mesh of small five-petal flowers in clusters over the crown, drawn
 *   instanced over every blooming tree (one draw call for the whole orchard);
 * - `apple`: the apple, centred on its middle (the physics ball's centre);
 * - `fruitSpots`: where the apples hang (local, at scale 1): the stems of the first clusters.
 */
export interface AppleModels {
  near: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  blossom: THREE.BufferGeometry;
  apple: THREE.BufferGeometry;
  /** Apple radius (m, for its collider) and half its height. */
  appleRadius: number;
  appleHalfHeight: number;
  /** Apple centres on the crown (local, at scale 1). */
  fruitSpots: THREE.Vector3[];
  /** Crown centre height, radius and height (m, at scale 1): falling leaves and petals. */
  crown: { y: number; r: number; h: number };
  /** Trunk radius near the ground (m, at scale 1). */
  trunkRadius: number;
}

let models: AppleModels | null = null;
let loading: Promise<AppleModels | null> | null = null;

export function getAppleModels(): AppleModels | null {
  return models;
}

export function loadAppleModels(): Promise<AppleModels | null> {
  if (loading) return loading;
  const loader = new GLTFLoader();
  loading = Promise.all([loader.loadAsync(TREE_URL), loader.loadAsync(APPLE_URL)])
    .then(([treeGltf, appleGltf]) => {
      const tree = firstMesh(treeGltf.scene);
      const apple = firstMesh(appleGltf.scene);
      if (!tree || !apple) throw new Error('apple models: mesh missing');
      const far = shrinkCrown(prepare(tree), CROWN_WIDTH, CROWN_HEIGHT);
      const near = veg.oakLeaves
        ? addCrownLeaves(far, {
            count: veg.oakCount, spacing: veg.oakSpacing, size: veg.oakSize, offset: veg.oakOffset,
            innerShade: veg.oakInnerShade, seed: 2024, shape: 'scale', lightFrom: 'centre',
          })
        : far.clone();
      const crown = crownOf(far);
      const { blossom, fruit } = buildBlossom(far, crown);
      const appleGeo = prepare(apple);
      appleGeo.computeBoundingBox();
      const bb = appleGeo.boundingBox!;
      const c = bb.getCenter(new THREE.Vector3());
      appleGeo.translate(-c.x, -c.y, -c.z);
      appleGeo.scale(APPLE_SCALE, APPLE_SCALE, APPLE_SCALE);
      appleGeo.computeBoundingSphere();
      const size = bb.getSize(new THREE.Vector3()).multiplyScalar(APPLE_SCALE);
      const appleRadius = Math.max(size.x, size.z) / 2;
      // Apple centres: just out of the leaf scales, half buried among them (no hanging gap below
      // the crown's underside)
      const spots = fruit.map((f) => f.p.clone().addScaledVector(f.n, veg.oakOffset + appleRadius * 0.55));
      models = {
        near, far, blossom, apple: appleGeo,
        appleRadius,
        appleHalfHeight: size.y / 2,
        fruitSpots: spots,
        crown,
        trunkRadius: trunkRadiusOf(far),
      };
      return models;
    })
    .catch((err) => {
      console.warn('[Orchard] apple models failed to load', err);
      return null;
    });
  return loading;
}

function firstMesh(root: THREE.Object3D): THREE.Mesh | null {
  root.updateMatrixWorld(true);
  let found: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  return found;
}

/** The model's crown is a bit big for its trunk: narrowed and lowered by these (about its base). */
const CROWN_WIDTH = 0.8;
const CROWN_HEIGHT = 0.86;

/** Scales the green (crown) vertices about the crown's base on the trunk axis; normals follow. */
function shrinkCrown(g: THREE.BufferGeometry, width: number, height: number): THREE.BufferGeometry {
  const P = g.getAttribute('position');
  const N = g.getAttribute('normal');
  const C = g.getAttribute('color');
  let base = Infinity;
  for (let i = 0; i < P.count; i++) if (isGreen(C, i)) base = Math.min(base, P.getY(i));
  if (!Number.isFinite(base)) return g;
  for (let i = 0; i < P.count; i++) {
    if (!isGreen(C, i)) continue;
    P.setXYZ(i, P.getX(i) * width, base + (P.getY(i) - base) * height, P.getZ(i) * width);
    // Normals of a non-uniform scale: divide by it, then renormalise
    const nx = N.getX(i) / width, ny = N.getY(i) / height, nz = N.getZ(i) / width;
    const l = Math.hypot(nx, ny, nz) || 1;
    N.setXYZ(i, nx / l, ny / l, nz / l);
  }
  P.needsUpdate = true;
  N.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

/** Position, normal and RGB vertex colour with the node transform baked in (no textures). */
function prepare(mesh: THREE.Mesh): THREE.BufferGeometry {
  const src = mesh.geometry;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.getAttribute('position').clone());
  g.setAttribute('normal', src.getAttribute('normal').clone());
  const c = src.getAttribute('color');
  const n = g.getAttribute('position').count;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = c ? c.getX(i) : 1;
    rgb[i * 3 + 1] = c ? c.getY(i) : 1;
    rgb[i * 3 + 2] = c ? c.getZ(i) : 1;
  }
  g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  if (src.index) g.setIndex(src.index.clone());
  g.applyMatrix4(mesh.matrixWorld);
  g.computeBoundingSphere();
  return g;
}

const isGreen = (C: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number): boolean =>
  C.getY(i) > C.getX(i) && C.getY(i) > C.getZ(i);

function crownOf(g: THREE.BufferGeometry): { y: number; r: number; h: number } {
  const P = g.getAttribute('position');
  const C = g.getAttribute('color');
  let y0 = Infinity, y1 = -Infinity, r = 0;
  for (let i = 0; i < P.count; i++) {
    if (!isGreen(C, i)) continue;
    y0 = Math.min(y0, P.getY(i));
    y1 = Math.max(y1, P.getY(i));
    r = Math.max(r, Math.hypot(P.getX(i), P.getZ(i)));
  }
  return Number.isFinite(y0) ? { y: (y0 + y1) / 2, r, h: y1 - y0 } : { y: 4, r: 2.5, h: 4 };
}

function trunkRadiusOf(g: THREE.BufferGeometry): number {
  const P = g.getAttribute('position');
  const C = g.getAttribute('color');
  let r = 0;
  for (let i = 0; i < P.count; i++) {
    const y = P.getY(i);
    if (!isGreen(C, i) && y > 0.6 && y < 1.6) r = Math.max(r, Math.hypot(P.getX(i), P.getZ(i)));
  }
  return r > 0 ? r : 0.4;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Petal colours (linear RGB): white rims, pink hearts, a yellow eye. */
const PETAL_RIM = new THREE.Color(1, 0.93, 0.95);
const PETAL_PINK = new THREE.Color(0.98, 0.55, 0.7);
const PETAL_EYE = new THREE.Color(0.95, 0.8, 0.3);

/**
 * Blossom clusters spread evenly over the crown's outside (a minimum spacing between them), each a
 * handful of flat five-petal flowers (a pentagon-ish fan, 6 vertices / 5 triangles) facing out of
 * the crown and lifted off it past the leaf scales. Fruit spots go to clusters on the crown's
 * sides and underside so the apples hang in sight and fall free of the crown.
 */
function buildBlossom(src: THREE.BufferGeometry, crown: { y: number; r: number; h: number }): { blossom: THREE.BufferGeometry; fruit: { p: THREE.Vector3; n: THREE.Vector3 }[] } {
  const P = src.getAttribute('position');
  const C = src.getAttribute('color');
  const index = src.index!;
  const tris: number[] = [];
  const cdf: number[] = [];
  let total = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const centre = new THREE.Vector3(0, crown.y, 0);
  for (let t = 0; t < index.count / 3; t++) {
    const i0 = index.getX(t * 3), i1 = index.getX(t * 3 + 1), i2 = index.getX(t * 3 + 2);
    if (!isGreen(C, i0) || !isGreen(C, i1) || !isGreen(C, i2)) continue;
    a.fromBufferAttribute(P, i0);
    b.fromBufferAttribute(P, i1);
    c.fromBufferAttribute(P, i2);
    const area = e1.subVectors(b, a).cross(e2.subVectors(c, a)).length() / 2;
    if (area < 1e-4) continue;
    tris.push(t);
    total += area;
    cdf.push(total);
  }

  const rand = rng(31337);
  const sample = (p: THREE.Vector3, n: THREE.Vector3): void => {
    const r = rand() * total;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const t = tris[lo];
    a.fromBufferAttribute(P, index.getX(t * 3));
    b.fromBufferAttribute(P, index.getX(t * 3 + 1));
    c.fromBufferAttribute(P, index.getX(t * 3 + 2));
    let u = rand(), w = rand();
    if (u + w > 1) { u = 1 - u; w = 1 - w; }
    p.copy(a).addScaledVector(e1.subVectors(b, a), u).addScaledVector(e2.subVectors(c, a), w);
    n.subVectors(b, a).cross(e2.subVectors(c, a)).normalize();
    const radial = e1.subVectors(p, centre).normalize();
    if (n.dot(radial) < 0) n.negate();
    n.lerp(radial, 0.4).normalize();
  };

  // Cluster centres: even spread; the fruit ones on the sides / underside, apart from each other
  const clusters: { p: THREE.Vector3; n: THREE.Vector3 }[] = [];
  const minGap = Math.sqrt(total / BLOSSOM_CLUSTERS) * 0.75;
  const fruitGap = Math.sqrt(total / FRUIT_PER_TREE) * 0.7;
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  let fruit = 0;
  for (let attempt = 0; attempt < 6000 && clusters.length < BLOSSOM_CLUSTERS; attempt++) {
    sample(p, n);
    const wantFruit = fruit < FRUIT_PER_TREE;
    if (wantFruit && (n.y > 0.35 || Math.hypot(p.x, p.z) < crown.r * 0.45)) continue;
    const gap = wantFruit ? fruitGap : minGap;
    if (clusters.some((k) => k.p.distanceToSquared(p) < gap * gap)) continue;
    clusters.push({ p: p.clone(), n: n.clone() });
    if (wantFruit) fruit++;
  }

  const pos: number[] = [], nor: number[] = [], col: number[] = [], sway: number[] = [], idx: number[] = [];
  const across = new THREE.Vector3(), up = new THREE.Vector3(), q = new THREE.Vector3(), lit = new THREE.Vector3();
  const LIFT = veg.oakOffset + veg.oakSize * 0.16 + 0.08;
  const addFlower = (at: THREE.Vector3, normal: THREE.Vector3, size: number): void => {
    across.set(0, 1, 0).cross(normal);
    if (across.lengthSq() < 1e-4) across.set(1, 0, 0);
    across.normalize();
    up.crossVectors(normal, across).normalize();
    lit.copy(at).sub(centre).normalize().lerp(normal, 0.5).normalize();
    const base = pos.length / 3;
    const tilt = rand() * Math.PI * 2;
    // Centre (raised a touch: a shallow cup), then five rim points with petal tips between notches
    pos.push(at.x + normal.x * size * 0.25, at.y + normal.y * size * 0.25, at.z + normal.z * size * 0.25);
    nor.push(lit.x, lit.y, lit.z);
    col.push(PETAL_EYE.r, PETAL_EYE.g, PETAL_EYE.b);
    sway.push(0.25);
    for (let k = 0; k < 5; k++) {
      const ang = tilt + (k / 5) * Math.PI * 2;
      const r = size * (k % 2 ? 0.92 : 1.05);
      q.copy(at).addScaledVector(across, Math.cos(ang) * r).addScaledVector(up, Math.sin(ang) * r);
      pos.push(q.x, q.y, q.z);
      nor.push(lit.x, lit.y, lit.z);
      const pink = 0.25 + rand() * 0.35;
      col.push(
        PETAL_RIM.r + (PETAL_PINK.r - PETAL_RIM.r) * pink,
        PETAL_RIM.g + (PETAL_PINK.g - PETAL_RIM.g) * pink,
        PETAL_RIM.b + (PETAL_PINK.b - PETAL_RIM.b) * pink,
      );
      sway.push(0.45);
    }
    // Front faces outwards (the foliage material is double-sided but darkens back faces)
    e1.set(pos[(base + 1) * 3] - pos[base * 3], pos[(base + 1) * 3 + 1] - pos[base * 3 + 1], pos[(base + 1) * 3 + 2] - pos[base * 3 + 2]);
    e2.set(pos[(base + 2) * 3] - pos[base * 3], pos[(base + 2) * 3 + 1] - pos[base * 3 + 1], pos[(base + 2) * 3 + 2] - pos[base * 3 + 2]);
    const out = e1.cross(e2).dot(normal) >= 0;
    for (let k = 0; k < 5; k++) {
      const i1 = base + 1 + k, i2 = base + 1 + ((k + 1) % 5);
      if (out) idx.push(base, i1, i2);
      else idx.push(base, i2, i1);
    }
  };

  const fruitAt: { p: THREE.Vector3; n: THREE.Vector3 }[] = [];
  const fp = new THREE.Vector3(), fn = new THREE.Vector3();
  clusters.forEach((k, ci) => {
    const lifted = k.p.clone().addScaledVector(k.n, LIFT);
    if (ci < FRUIT_PER_TREE) fruitAt.push({ p: k.p.clone(), n: k.n.clone() });
    // 5-8 flowers around the cluster centre, on the crown surface near it
    const count = 6 + Math.floor(rand() * 4);
    across.set(0, 1, 0).cross(k.n);
    if (across.lengthSq() < 1e-4) across.set(1, 0, 0);
    across.normalize();
    up.crossVectors(k.n, across).normalize();
    for (let f = 0; f < count; f++) {
      const ang = rand() * Math.PI * 2;
      const d = f === 0 ? 0 : 0.14 + rand() * 0.28;
      fp.copy(lifted).addScaledVector(across, Math.cos(ang) * d).addScaledVector(up, Math.sin(ang) * d);
      fn.copy(k.n).addScaledVector(across, (rand() - 0.5) * 0.6).addScaledVector(up, (rand() - 0.5) * 0.6).normalize();
      addFlower(fp.clone(), fn.clone(), 0.11 + rand() * 0.05);
    }
  });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('sway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return { blossom: g, fruit: fruitAt };
}
