import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CrownLeafOptions, addCrownLeaves } from './CrownLeaves';
import { addRingScallops } from './RingScallops';
import { loadPineCrown, trunkWithCrown } from './PineCrownModel';
import { injectNightLights } from './NightLighting';
import { injectWaterline } from '../scene/WaterDetails';
import { vegetationSettings as veg } from './VegetationSettings';

const TREES_URL = `${import.meta.env.BASE_URL}models/trees_pack.glb`;
/** Uniform scale on top of the pack's own node scale (pine ~8.3 m, oak ~7.2 m tall). */
const MODEL_SCALE: Record<string, number> = { tree_pine: 1.2, tree_round: 1.1 };
/** Mesh name prefix in the pack -> prop type. The pack spells one pine node "pin_tree_lod2". */
const TYPE_OF: Record<string, string> = { pine: 'tree_pine', pin: 'tree_pine', oak: 'tree_round' };

/** Wind clock (s) for leaves and needles; geometry without a `sway` attribute stays rigid. */
const uTreeWind = { value: 0 };
const uLeafWind = { value: veg.leafWind };
/** Weather wind 0..1 (calm .. storm) and its eased value. */
let weatherWind = 0;
let weatherWindEased = 0;
/** The weather's wind (0 calm .. 1 storm): leaves and needles sway harder and faster in it. */
export function setFoliageWeatherWind(w: number): void {
  weatherWind = Math.max(0, Math.min(1, w));
}
/**
 * Advances the leaf wind by `dt` and sets its strength: the panel's values, raised by the
 * weather's wind (eased over a few seconds, so a storm builds up and dies down).
 */
export function stepTreeWind(dt: number): void {
  weatherWindEased += (weatherWind - weatherWindEased) * (1 - Math.exp(-dt * 0.4));
  const w = weatherWindEased;
  uTreeWind.value += dt * veg.leafWindSpeed * (1 + 1.6 * w);
  uLeafWind.value = veg.leafWind * (1 + 2.2 * w);
}

/** Bushes bent by the player, pets, the moped, ... at once (BushSway fills these). */
export const MAX_BENT_BUSHES = 8;
/** Per bent bush: world x, z of its instance, then its top's world XZ offset. */
// Kept on globalThis so a hot-reloaded copy of this module (Vite HMR) shares the uniforms the
// compiled bush material already reads, instead of BushSway writing into an orphaned copy.
const bendStore = globalThis as { __bushBend?: { value: THREE.Vector4[] }; __bushBendCount?: { value: number } };
export const uBushBend = (bendStore.__bushBend ??= { value: Array.from({ length: MAX_BENT_BUSHES }, () => new THREE.Vector4()) });
export const uBushBendCount = (bendStore.__bushBendCount ??= { value: 0 });

/**
 * Foliage material: vertex colours, double-sided (the pack's crowns are open underneath, so
 * looking up from below the trunk showed straight through them) and leaf wind. The bush variant
 * also leans the few bushes something is pushing through; trees never pay for that loop.
 */
function foliageMaterial(bend: boolean): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    injectNightLights(shader);
    injectWaterline(shader);
    shader.uniforms.uTreeWind = uTreeWind;
    shader.uniforms.uLeafWind = uLeafWind;
    let head = `#include <common>
attribute float sway;
uniform float uTreeWind;
uniform float uLeafWind;`;
    let body = `#include <begin_vertex>
      {
        // Each tree (instance) and each part of the crown flutters out of phase
        float ph = position.y * 0.9 + position.x * 0.7;
        #ifdef USE_INSTANCING
          ph += dot(instanceMatrix[3].xz, vec2(0.37, 0.23));
        #endif
        float w = sin(uTreeWind * 2.1 + ph) + 0.5 * sin(uTreeWind * 3.7 + ph * 1.7);
        transformed += vec3(w, 0.35 * cos(uTreeWind * 2.9 + ph), 0.6 * w) * (uLeafWind * sway);
      }`;
    if (bend) {
      shader.uniforms.uBushBend = uBushBend;
      shader.uniforms.uBushBendCount = uBushBendCount;
      head += `
uniform vec4 uBushBend[${MAX_BENT_BUSHES}];
uniform int uBushBendCount;`;
      body += `
      #ifdef USE_INSTANCING
      for (int i = 0; i < ${MAX_BENT_BUSHES}; i++) {
        if (i >= uBushBendCount) break;
        vec4 bb = uBushBend[i];
        vec2 d = instanceMatrix[3].xz - bb.xy;
        if (dot(d, d) > 0.0025) continue;
        // World-space lean into the instance's frame (it may be rotated and scaled), more at the top
        mat3 im = mat3(instanceMatrix);
        vec3 lb = (transpose(im) * vec3(bb.z, 0.0, bb.w)) / dot(im[0], im[0]);
        float k = clamp(position.y / 1.0, 0.0, 1.3);
        k *= k;
        transformed.xz += lb.xz * k;
        transformed.y -= dot(lb.xz, lb.xz) * 0.5 * k;
        break;
      }
      #endif`;
    }
    shader.vertexShader = shader.vertexShader.replace('#include <common>', head).replace('#include <begin_vertex>', body);
  };
  mat.customProgramCacheKey = () => (bend ? 'bush-wind-bend' : 'tree-wind');
  return mat;
}

export const TREE_MATERIAL = foliageMaterial(false);
export const BUSH_MATERIAL = foliageMaterial(true);
/** The material a model type draws with. */
export const foliageMaterialOf = (type: string): THREE.Material => (type === 'bush' ? BUSH_MATERIAL : TREE_MATERIAL);
/** Leaf options from the vegetation panel; seeds keep every rebuild the same tree. */
const oakLeaves = (): CrownLeafOptions => ({
  count: veg.oakCount, spacing: veg.oakSpacing, size: veg.oakSize, offset: veg.oakOffset,
  innerShade: veg.oakInnerShade, seed: 1337, shape: 'scale', lightFrom: 'centre',
});
const pineNeedles = (): CrownLeafOptions => ({
  count: veg.pineCount, spacing: veg.pineSpacing, size: veg.pineLength, width: veg.pineWidth,
  offset: veg.pineOffset, innerShade: veg.pineInnerShade, seed: 4242, shape: 'scallop', lightFrom: 'axis',
});
const bushLeaves = (): CrownLeafOptions => ({
  count: veg.bushCount, spacing: veg.bushSpacing, size: veg.bushSize, offset: veg.bushOffset,
  innerShade: veg.bushInnerShade, seed: 777, shape: 'scale', lightFrom: 'centre',
});

/** Per prop type: LOD geometries, index 0 = nearest / most detailed. */
export type TreeLods = Record<string, THREE.BufferGeometry[]>;

let lods: TreeLods | null = null;
let loading: Promise<TreeLods | null> | null = null;
/** The pack's meshes as loaded (no crown shade, no leaves), so the panel can rebuild from them. */
let raw: TreeLods | null = null;
/** The hand-made pine crown (public/models/pine_crown.gltf), null when it failed to load. */
let pineCrown: THREE.BufferGeometry | null = null;
/** Bumped whenever `lods` is replaced (leaf rebuild). */
export let treeLodsRevision = 0;

export function getTreeLods(): TreeLods | null {
  return lods;
}

/** Loads the oak and pine (3 LODs each) from the trees pack once; the bush (2 LODs) is built here. */
export function loadTreeModels(): Promise<TreeLods | null> {
  if (loading) return loading;
  loading = Promise.all([new GLTFLoader().loadAsync(TREES_URL), loadPineCrown()])
    .then(([gltf, crown]) => {
      pineCrown = crown;
      const out: Record<string, THREE.BufferGeometry[]> = {};
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const m = /^(pine|pin|oak)_tree_lod(\d)$/i.exec(mesh.name);
        if (!m) return;
        const type = TYPE_OF[m[1].toLowerCase()];
        (out[type] ??= [])[Number(m[2]) - 1] = prepare(mesh, type);
      });
      for (const [type, list] of Object.entries(out)) {
        if (list.length !== 3 || list.some((g) => !g)) throw new Error(`trees_pack.glb: ${type} needs lod1..lod3`);
      }
      if (!out.tree_pine || !out.tree_round) throw new Error('trees_pack.glb: pine or oak missing');
      out.bush = [bushSphere(2), bushSphere(1)];
      raw = out;
      lods = buildLods(raw);
      return lods;
    })
    .catch((err) => {
      console.warn('[Trees] trees_pack.glb failed to load, keeping procedural trees', err);
      return null;
    });
  return loading;
}

/**
 * Rebuilds leaves, needles and crown shade from the vegetation settings. The old geometries are
 * disposed; callers re-read `getTreeLods()` (PropSystem swaps every cell over).
 */
export function rebuildTreeLeaves(): TreeLods | null {
  if (!raw || !lods) return lods;
  const old = lods;
  lods = buildLods(raw);
  treeLodsRevision++;
  for (const list of Object.values(old)) list.forEach((g) => g.dispose());
  return lods;
}

/**
 * Near oaks get leaf scales, near pines needle blades and near bushes small scales, over a
 * darkened crown; the farther LODs keep the plain crown. The pine's crown shade applies to all
 * its LODs.
 */
function buildLods(src: TreeLods): TreeLods {
  const out: TreeLods = {};
  const plans: [string, boolean, () => CrownLeafOptions][] = [
    ['tree_round', veg.oakLeaves, oakLeaves],
    ['tree_pine', veg.pineNeedles, pineNeedles],
    ['bush', veg.bushLeaves, bushLeaves],
  ];
  for (const [type, on, opts] of plans) {
    const shade = type === 'tree_pine' ? veg.pineCrownShade : 1;
    const list = src[type].map((g) => shadeCrown(g, shade));
    if (on) {
      const near = list[0];
      // The pine: the hand-made crown on the pack's trunk, or generated rows of paws around it
      list[0] =
        type === 'tree_pine' && veg.pineModelCrown && pineCrown
          ? trunkWithCrown(near, pineCrown)
          : type === 'tree_pine'
          ? addRingScallops(near, {
              pawsPerRow: veg.pineCount, width: veg.pineWidth, droop: veg.pineLength, overhang: veg.pineOffset,
              rowStep: veg.pineSpacing, innerShade: veg.pineInnerShade, keepCrown: veg.pineKeepCrown, seed: 4242,
            })
          : addCrownLeaves(near, opts());
      if (list[0] !== near) near.dispose();
    }
    out[type] = list;
  }
  return out;
}

/** Copy of `g` with its green (crown) vertices multiplied by `k`. */
function shadeCrown(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const out = g.clone();
  if (k === 1) return out;
  const c = out.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < c.count; i++) {
    const r = c.getX(i), gr = c.getY(i), b = c.getZ(i);
    if (gr > r && gr > b) c.setXYZ(i, r * k, gr * k, b * k);
  }
  return out;
}

const BUSH_COLOR = new THREE.Color(0x3f8a3a);
/** The bush: one slightly squashed sphere (the leaves give it its lumpy outline). */
function bushSphere(detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.62, detail);
  g.deleteAttribute('uv');
  g.scale(1.2, 0.85, 1.1);
  g.translate(0, 0.48, 0);
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set([BUSH_COLOR.r, BUSH_COLOR.g, BUSH_COLOR.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.addGroup(0, n, 0);
  g.computeBoundingSphere();
  return g;
}

/**
 * Bakes the node transform in, keeps position / normal / RGB vertex colour (the pack has no
 * textures) and adds the single material group the props' material array expects.
 */
function prepare(mesh: THREE.Mesh, type: string): THREE.BufferGeometry {
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
  const s = MODEL_SCALE[type] ?? 1;
  g.applyMatrix4(new THREE.Matrix4().makeScale(s, s, s).multiply(mesh.matrixWorld));
  g.addGroup(0, g.index ? g.index.count : n, 0);
  g.computeBoundingSphere();
  return g;
}
