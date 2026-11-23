import * as THREE from 'three';
import { unpatchedShaderHooks } from './BuildCutaway';

/**
 * Texture-array stand-ins for the plain textured Lambert materials of buildings (wood, shingles,
 * siding, wallpapers, fabric...). Every such texture is copied once into a layer of a shared
 * `DataArrayTexture`, and one material samples it by a per-vertex layer index, with the original
 * material colour carried in the vertex colour. A merged chunk then draws all those materials in
 * one call instead of one per material: draw calls and, more importantly, shader / uniform
 * switches go down.
 *
 * Only materials that this can reproduce exactly are taken: opaque MeshLambertMaterial with at most
 * a colour map (repeating across, repeating or clamped vertically, no UV transform), black emissive
 * and no shader patch of its own. Everything else (glass, lamp shades that glow at night) keeps
 * drawing with its own material. A texture redrawn later (its `version` moved on) is copied again.
 * Textures of one size share an array (512x512, 256x256; taller ones are squeezed square).
 */

/**
 * Vertex attribute holding the layer: -1 no texture; layer + CLAMP_T_FLAG for a texture clamped
 * vertically (the array itself repeats, the shader clamps v the way CLAMP_TO_EDGE would).
 */
export const TEX_LAYER_ATTRIBUTE = 'texLayer';
const CLAMP_T_FLAG = 1024;

/** Layer sides are powers of two in this range (textures are resampled to the nearest). */
const MIN_SIZE = 64;
const MAX_SIZE = 1024;

export interface TextureArraySlot {
  /** The shared array material to draw with */
  material: THREE.MeshLambertMaterial;
  /** Layer of the texture, -1 for an untextured material */
  layer: number;
  /** The original material's colour (linear), multiplied into the vertex colour */
  color: THREE.Color;
}

interface Pool {
  width: number;
  height: number;
  colorSpace: string;
  capacity: number;
  count: number;
  data: Uint8Array;
  /** Shared by every material of this pool, so a regrown array reaches all their programs */
  uniform: { value: THREE.DataArrayTexture };
  layers: Map<THREE.Texture, { layer: number; version: number }>;
  materials: Map<string, THREE.MeshLambertMaterial>;
  dummyMap: THREE.DataTexture;
}

const pools = new Map<string, Pool>();
/** Pool untextured materials join (any pool works: they skip the texture read) */
let defaultPoolKey: string | null = null;

/** Materials that must keep their own draw (the night lighting changes them at run time). */
const keepOwn = new WeakSet<THREE.Material>();

export function keepOwnMaterial(...materials: THREE.Material[]): void {
  for (const m of materials) keepOwn.add(m);
}

const _canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;

const pow2 = (n: number) => THREE.MathUtils.clamp(Math.pow(2, Math.round(Math.log2(n))), MIN_SIZE, MAX_SIZE);

/**
 * Layers are square, at the texture's shorter side: a tall texture (the 512x1024 wainscots) is
 * squeezed into the same array as the 512x512 ones instead of needing an array (and a draw) of its own.
 */
function layerSize(tex: THREE.Texture): { width: number; height: number } | null {
  const img = tex.image as { width?: number; height?: number } | undefined;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!w || !h) return null;
  const side = pow2(Math.min(w, h));
  return { width: side, height: side };
}

function isPlainMap(tex: THREE.Texture): boolean {
  return (
    tex.wrapS === THREE.RepeatWrapping &&
    (tex.wrapT === THREE.RepeatWrapping || tex.wrapT === THREE.ClampToEdgeWrapping) &&
    tex.channel === 0 &&
    tex.offset.x === 0 &&
    tex.offset.y === 0 &&
    tex.repeat.x === 1 &&
    tex.repeat.y === 1 &&
    tex.rotation === 0 &&
    !(tex as THREE.Texture & { isDataArrayTexture?: boolean }).isDataArrayTexture &&
    !(tex as THREE.Texture & { isCompressedTexture?: boolean }).isCompressedTexture &&
    !!tex.image &&
    typeof (tex.image as { width?: number }).width === 'number'
  );
}

function isMergeable(m: THREE.Material): m is THREE.MeshLambertMaterial {
  const l = m as THREE.MeshLambertMaterial;
  if (!l.isMeshLambertMaterial || keepOwn.has(m) || isArrayMaterial(m)) return false;
  if (l.transparent || l.opacity !== 1 || l.alphaTest > 0 || l.alphaHash || l.wireframe || l.flatShading) return false;
  if (l.alphaMap || l.bumpMap || l.normalMap || l.displacementMap || l.emissiveMap || l.lightMap || l.aoMap || l.specularMap || l.envMap) return false;
  if (l.emissive.r || l.emissive.g || l.emissive.b) return false;
  if (!l.visible || !l.depthTest || !l.depthWrite || !l.colorWrite || l.polygonOffset || l.blending !== THREE.NormalBlending) return false;
  if (l.clippingPlanes && l.clippingPlanes.length) return false;
  // Its own shader patch would be lost (the cutaway's, wrapped around it, is fine)
  const own = unpatchedShaderHooks(m);
  if (own.compile !== THREE.Material.prototype.onBeforeCompile) return false;
  if (own.key !== THREE.Material.prototype.customProgramCacheKey) return false;
  if (l.map && !isPlainMap(l.map)) return false;
  return true;
}

const arrayMaterials = new WeakSet<THREE.Material>();
export function isArrayMaterial(m: THREE.Material): boolean {
  return arrayMaterials.has(m);
}

/** Starting layer count: regrowing re-uploads the whole array (a hitch), so start with some room */
const INITIAL_LAYERS = 8;

function createPool(width: number, height: number, colorSpace: string): Pool {
  const capacity = INITIAL_LAYERS;
  const data = new Uint8Array(width * height * 4 * capacity);
  const dummyMap = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  dummyMap.colorSpace = colorSpace as THREE.ColorSpace;
  dummyMap.needsUpdate = true;
  const pool: Pool = {
    width,
    height,
    colorSpace,
    capacity,
    count: 0,
    data,
    uniform: { value: makeArrayTexture(data, width, height, capacity, colorSpace) },
    layers: new Map(),
    materials: new Map(),
    dummyMap,
  };
  return pool;
}

function makeArrayTexture(data: Uint8Array, width: number, height: number, depth: number, colorSpace: string): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(data, width, height, depth);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = colorSpace as THREE.ColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Copies `tex` into `layer` of the pool (resampled, flipped the way the GPU upload would). */
function writeLayer(pool: Pool, layer: number, tex: THREE.Texture): boolean {
  if (!_canvas) return false;
  const { width, height } = pool;
  if (_canvas.width !== width || _canvas.height !== height) {
    _canvas.width = width;
    _canvas.height = height;
  }
  const ctx = _canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  // Row 0 of a data texture is v = 0, which an image uploaded with flipY shows at its bottom
  if (tex.flipY) ctx.setTransform(1, 0, 0, -1, 0, height);
  try {
    ctx.drawImage(tex.image as CanvasImageSource, 0, 0, width, height);
  } catch {
    return false;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const px = ctx.getImageData(0, 0, width, height).data;
  pool.data.set(px, layer * width * height * 4);
  return true;
}

function grow(pool: Pool): void {
  const capacity = pool.capacity * 2;
  const data = new Uint8Array(pool.width * pool.height * 4 * capacity);
  data.set(pool.data);
  pool.data = data;
  pool.capacity = capacity;
  const old = pool.uniform.value;
  pool.uniform.value = makeArrayTexture(data, pool.width, pool.height, capacity, pool.colorSpace);
  // Per-layer uploads queued before the first upload would leave the copied layers out: list them all
  for (let i = 0; i < pool.count; i++) pool.uniform.value.addLayerUpdate(i);
  old.dispose();
}

/** Uploads just that layer (a regrown array uploads whole anyway). */
function uploadLayer(pool: Pool, layer: number): void {
  const tex = pool.uniform.value;
  tex.addLayerUpdate(layer);
  tex.needsUpdate = true;
}

function layerOf(pool: Pool, tex: THREE.Texture): number | null {
  const known = pool.layers.get(tex);
  if (known) {
    if (known.version !== tex.version) {
      if (!writeLayer(pool, known.layer, tex)) return null;
      known.version = tex.version;
      uploadLayer(pool, known.layer);
    }
    return known.layer;
  }
  if (pool.count === pool.capacity) grow(pool);
  const layer = pool.count;
  if (!writeLayer(pool, layer, tex)) return null;
  pool.count++;
  pool.layers.set(tex, { layer, version: tex.version });
  uploadLayer(pool, layer);
  return layer;
}

function poolMaterial(pool: Pool, side: THREE.Side, skipInteriorShade: boolean): THREE.MeshLambertMaterial {
  const key = `${side}|${skipInteriorShade}`;
  let mat = pool.materials.get(key);
  if (mat) return mat;
  mat = new THREE.MeshLambertMaterial({ map: pool.dummyMap, vertexColors: true, side });
  if (skipInteriorShade) mat.defines = { SKIP_INTERIOR_SHADE: 1 };
  const size = `${pool.width}x${pool.height}`;
  mat.name = `BuildingTextureArray_${size}`;
  const uniform = pool.uniform;
  // CLAMP_TO_EDGE keeps v within half a texel of the edges
  const halfTexel = (0.5 / pool.height).toFixed(7);
  mat.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
    // The global night-light / waterline patch every lit material gets
    THREE.Material.prototype.onBeforeCompile.call(this, shader, renderer);
    shader.uniforms.uTexLayers = uniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float ${TEX_LAYER_ATTRIBUTE};\nflat varying float vTexLayer;`)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTexLayer = texLayer;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform highp sampler2DArray uTexLayers;\nflat varying float vTexLayer;')
      .replace(
        '#include <map_fragment>',
        `if (vTexLayer >= 0.0) {
  float texL = vTexLayer;
  vec2 texUv = vMapUv;
  if (texL >= ${CLAMP_T_FLAG.toFixed(1)}) {
    texL -= ${CLAMP_T_FLAG.toFixed(1)};
    texUv.y = clamp(texUv.y, ${halfTexel}, 1.0 - ${halfTexel});
  }
  diffuseColor *= texture(uTexLayers, vec3(texUv, texL));
}`
      );
  };
  // The half-texel constant differs per array size
  mat.customProgramCacheKey = () => `building-texture-array-${size}`;
  arrayMaterials.add(mat);
  pool.materials.set(key, mat);
  return mat;
}

function getPool(width: number, height: number, colorSpace: string): Pool {
  const key = `${width}x${height}|${colorSpace}`;
  let pool = pools.get(key);
  if (!pool) {
    pool = createPool(width, height, colorSpace);
    pools.set(key, pool);
  }
  if (!defaultPoolKey || (width === 512 && height === 512 && colorSpace === THREE.SRGBColorSpace)) defaultPoolKey = key;
  return pool;
}

/**
 * The array material, layer and colour to draw `m` with, or null when `m` must keep its own
 * material. Copies the texture into its layer the first time.
 */
export function textureArraySlot(m: THREE.Material): TextureArraySlot | null {
  if (!isMergeable(m)) return null;
  let pool: Pool;
  let layer = -1;
  if (m.map) {
    const size = layerSize(m.map);
    if (!size) return null;
    pool = getPool(size.width, size.height, m.map.colorSpace);
    const l = layerOf(pool, m.map);
    if (l === null) return null;
    layer = m.map.wrapT === THREE.ClampToEdgeWrapping ? l + CLAMP_T_FLAG : l;
  } else {
    pool = defaultPoolKey ? pools.get(defaultPoolKey)! : getPool(512, 512, THREE.SRGBColorSpace);
  }
  const skipInteriorShade = m.defines?.SKIP_INTERIOR_SHADE === 1;
  return { material: poolMaterial(pool, m.side, skipInteriorShade), layer, color: m.color };
}

/** Diagnostics: layers and memory of the arrays. */
export function textureArrayStats(): { pools: number; layers: number; mb: number } {
  let layers = 0;
  let bytes = 0;
  for (const p of pools.values()) {
    layers += p.count;
    bytes += p.data.byteLength * 1.33;
  }
  return { pools: pools.size, layers, mb: Math.round(bytes / 1048576) };
}
