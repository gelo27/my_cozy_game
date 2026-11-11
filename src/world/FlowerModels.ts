import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { injectNightLights } from './NightLighting';
import { injectWaterline } from '../scene/WaterDetails';
import { fieldCropTime } from '../farming/WheatModel';
import { injectPickGlow } from './PickGlow';

const FLOWERS_URL = `${import.meta.env.BASE_URL}models/flowers.glb`;

/** Petal colours (sRGB): purple, cream white, golden yellow, red. Each clump takes one. */
const TULIP_COLORS = [0x9a2ec4, 0xf4e4dc, 0xf6b51e, 0xe0391d];
/**
 * Tulips in one clump: local x, z, yaw, scale and a lean (rad) away from the clump centre. One
 * clump is one prop instance, so a meadow of them stays one draw call per cell.
 */
const CLUMP: [number, number, number, number, number][] = [
  [0, 0, 0.3, 1.05, 0],
  [0.17, 0.05, 2.1, 0.92, 0.1],
  [-0.11, 0.15, 4.0, 0.88, 0.12],
  [-0.1, -0.14, 1.2, 0.97, 0.09],
  [0.11, -0.14, 5.3, 0.84, 0.13],
];
/** Model height (m) of the tulip: the spring and the wind reach full strength at the top. */
const TULIP_HEIGHT = 0.57;

/** Clumps bent by the player, pets, the moped at once (FlowerSway fills these). */
export const MAX_BENT_FLOWERS = 12;
// On globalThis so a hot-reloaded copy of this module keeps feeding the compiled material
const bendStore = globalThis as { __flowerBend?: { value: THREE.Vector4[] }; __flowerBendCount?: { value: number } };
/** Per bent clump: world x, z of its instance, then its top's world XZ offset. */
export const uFlowerBend = (bendStore.__flowerBend ??= { value: Array.from({ length: MAX_BENT_FLOWERS }, () => new THREE.Vector4()) });
export const uFlowerBendCount = (bendStore.__flowerBendCount ??= { value: 0 });

const uTulipColors = { value: TULIP_COLORS.map((hex) => new THREE.Color(hex)) };

export const TULIP_COLOR_COUNT = TULIP_COLORS.length;
const TAU = Math.PI * 2;
/**
 * Petal colour index (0 purple, 1 white, 2 yellow, 3 red) of a clump turned by `yaw`: the colour is
 * the quarter turn its yaw falls in (the shader reads the same from the instance matrix), so it
 * needs no per-instance buffer and doesn't tie the clump to any spot.
 */
export function tulipColorOfYaw(yaw: number): number {
  const turn = yaw / TAU;
  return Math.min(Math.floor((turn - Math.floor(turn)) * 4), 3);
}
/** A random yaw that shows `color`, kept off the quarter boundaries (float rounding on the GPU). */
export function tulipYawFor(color: number): number {
  return (color + 0.12 + Math.random() * 0.76) * (TAU / 4);
}

/**
 * Tulip material: vertex colours, wind sway and the push springs, all in the vertex shader. Petals
 * carry only their shading in the vertex colour; the clump's petal colour is picked from its yaw in
 * the instance matrix, so the four colours need no per-instance buffer (and survive PropSystem
 * reshuffling its instance slots).
 */
function createFlowerMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    injectNightLights(shader);
    injectWaterline(shader);
    // The clump the E prompt is about glows
    injectPickGlow(shader, 'instance');
    shader.uniforms.uTime = fieldCropTime;
    shader.uniforms.uTulipColors = uTulipColors;
    shader.uniforms.uFlowerBend = uFlowerBend;
    shader.uniforms.uFlowerBendCount = uFlowerBendCount;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform vec3 uTulipColors[4];
uniform vec4 uFlowerBend[${MAX_BENT_FLOWERS}];
uniform int uFlowerBendCount;
// x: 1 on petals (tinted), y: the tulip's wind phase
attribute vec2 aTulip;`
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
#ifdef USE_INSTANCING
  if (aTulip.x > 0.5) {
    // The clump's yaw picks the colour: which quarter turn it falls in (tulipColorOfYaw)
    vec3 ax = instanceMatrix[0].xyz;
    float turn = fract(atan(-ax.z, ax.x) / 6.2831853);
    vColor.rgb *= uTulipColors[int(min(turn * 4.0, 3.0))];
  }
#else
  if (aTulip.x > 0.5) vColor.rgb *= uTulipColors[3];
#endif`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
{
  float h = clamp(position.y / ${TULIP_HEIGHT.toFixed(3)}, 0.0, 1.3);
  float k = h * h;
  // Wind: each tulip nods on its own phase (the wheat field's clock)
  vec3 ip = instanceMatrix[3].xyz;
  float ph = aTulip.y + ip.x * 0.8 + ip.z * 0.5;
  float gust = sin(uTime * 0.6 + ip.x * 0.11 + ip.z * 0.07) * 0.5 + 0.5;
  transformed.x += sin(uTime * 2.1 + ph) * (0.025 + gust * 0.03) * k;
  transformed.z += cos(uTime * 1.7 + ph * 1.3) * 0.02 * k;
  // Push: lean away from whatever walks through the clump
  for (int i = 0; i < ${MAX_BENT_FLOWERS}; i++) {
    if (i >= uFlowerBendCount) break;
    vec4 bb = uFlowerBend[i];
    vec2 d = ip.xz - bb.xy;
    if (dot(d, d) > 0.0025) continue;
    mat3 im = mat3(instanceMatrix);
    vec3 lb = (transpose(im) * vec3(bb.z, 0.0, bb.w)) / dot(im[0], im[0]);
    transformed.xz += lb.xz * k;
    transformed.y -= dot(lb.xz, lb.xz) * 0.5 * k / ${TULIP_HEIGHT.toFixed(3)};
    break;
  }
}
#endif`
      );
  };
  mat.customProgramCacheKey = () => 'tulip-clump-3-glow2';
  return mat;
}

export const FLOWER_MATERIAL = createFlowerMaterial();

let loading: Promise<THREE.BufferGeometry | null> | null = null;

/** Loads flowers.glb once and builds the tulip clump (null if it fails: the procedural flowers stay). */
export function loadFlowerModels(): Promise<THREE.BufferGeometry | null> {
  if (loading) return loading;
  loading = new GLTFLoader()
    .loadAsync(FLOWERS_URL)
    .then((gltf) => {
      const tulip = gltf.scene.getObjectByName('tulip') as THREE.Mesh | undefined;
      if (!tulip?.isMesh) throw new Error('flowers.glb has no "tulip" mesh');
      tulip.updateWorldMatrix(true, false);
      const clump = buildClump(tulip.geometry, tulip.matrixWorld);
      gltf.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      return clump;
    })
    .catch((err) => {
      console.warn('[Flowers] flowers.glb failed to load, keeping the procedural flowers', err);
      return null;
    });
  return loading;
}

/** Red-ish vertices are petals (tinted per clump); green stems, leaves and the yellow centre keep their colour. */
function isPetal(r: number, g: number, b: number): boolean {
  return r > 0.25 && r > g * 2.5 && r > b * 2.5;
}

/**
 * The clump as one compact indexed geometry: position, normal, colour and aTulip, with the one
 * material group the props' material array expects.
 */
function buildClump(src: THREE.BufferGeometry, node: THREE.Matrix4): THREE.BufferGeometry {
  const pos = src.getAttribute('position');
  const nrm = src.getAttribute('normal');
  const col = src.getAttribute('color');
  const n = pos.count;
  const index = src.index ? Array.from(src.index.array as ArrayLike<number>) : Array.from({ length: n }, (_, i) => i);

  // Petal shading relative to the brightest petal, so tinting keeps the model's light and dark sides
  let petalMax = 0;
  for (let i = 0; i < n; i++) {
    const r = col ? col.getX(i) : 0;
    if (col && isPetal(r, col.getY(i), col.getZ(i))) petalMax = Math.max(petalMax, r);
  }

  const total = n * CLUMP.length;
  const outPos = new Float32Array(total * 3);
  const outNrm = new Float32Array(total * 3);
  const outCol = new Float32Array(total * 3);
  const outTulip = new Float32Array(total * 2);
  const outIdx = new Uint16Array(index.length * CLUMP.length);
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const q = new THREE.Quaternion();
  const lean = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const v = new THREE.Vector3();

  CLUMP.forEach(([x, z, yaw, s, tilt], t) => {
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    // Lean outward: rotate about the horizontal axis perpendicular to the offset
    const len = Math.hypot(x, z);
    if (len > 1e-4 && tilt) q.premultiply(lean.setFromAxisAngle(axis.set(z / len, 0, -x / len), tilt));
    m.compose(v.set(x, 0, z), q, new THREE.Vector3(s, s, s)).multiply(node);
    nm.getNormalMatrix(m);
    const base = t * n;
    const phase = t * 1.7;
    for (let i = 0; i < n; i++) {
      const o = (base + i) * 3;
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      outPos[o] = v.x;
      outPos[o + 1] = v.y;
      outPos[o + 2] = v.z;
      if (nrm) {
        v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
        outNrm[o] = v.x;
        outNrm[o + 1] = v.y;
        outNrm[o + 2] = v.z;
      }
      const r = col ? col.getX(i) : 0.2;
      const g = col ? col.getY(i) : 0.6;
      const b = col ? col.getZ(i) : 0.1;
      const petal = isPetal(r, g, b);
      if (petal) {
        const shade = petalMax > 0 ? r / petalMax : 1;
        outCol[o] = outCol[o + 1] = outCol[o + 2] = shade;
      } else {
        outCol[o] = r;
        outCol[o + 1] = g;
        outCol[o + 2] = b;
      }
      outTulip[(base + i) * 2] = petal ? 1 : 0;
      outTulip[(base + i) * 2 + 1] = phase;
    }
    for (let k = 0; k < index.length; k++) outIdx[t * index.length + k] = base + index[k];
  });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(outCol, 3));
  g.setAttribute('aTulip', new THREE.BufferAttribute(outTulip, 2));
  g.setIndex(new THREE.BufferAttribute(outIdx, 1));
  if (!nrm) g.computeVertexNormals();
  g.addGroup(0, outIdx.length, 0);
  g.computeBoundingSphere();
  return g;
}
