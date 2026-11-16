import * as THREE from 'three';
import {
  BuildingPieceType,
  BuiltPiece,
  isFloorPiece,
  isFoundationPiece,
  isFurniturePiece,
  isGreenhousePiece,
  isSolidWallPiece,
} from './types/BuildingTypes';
import { glassLodOf } from './config/BuildingMaterials';
import { GLASS_DITHER_FAR, GLASS_DITHER_NEAR } from '../scene/GlassMatcap';
import { TEX_LAYER_ATTRIBUTE, TextureArraySlot, textureArraySlot } from './TextureArrayMaterials';

/** Chunk edge length, m (same grid as the baked walls, so a house usually sits in few chunks) */
const CHUNK = 16;
/** Furniture, chandeliers and lamps are not drawn beyond this distance (m) from the chunk */
export const INTERIOR_DRAW_DISTANCE = 45;
/** A "live" piece (being dragged / previewed) rejoins the batch after this long without changes, s */
const LIVE_TIMEOUT = 1.2;

type GlassLod = 'near' | 'far' | null;

interface Source {
  mesh: THREE.Mesh;
  /** Range in the index (or vertex list when not indexed) */
  start: number;
  count: number;
  /** The material the range is drawn with on the piece */
  material: THREE.Material;
  /** Its texture-array stand-in, when the bucket draws with one */
  slot: TextureArraySlot | null;
}

interface Bucket {
  material: THREE.Material;
  interior: boolean;
  /** Draws with a texture-array material: sources carry a layer and a colour per vertex */
  array: boolean;
  sources: Source[];
}

interface BatchMesh {
  mesh: THREE.Mesh;
  lod: GlassLod;
  interior: boolean;
}

/** Pieces drawn by the batch: everything except baked walls / floors / foundations and greenhouses. */
export function isBatchablePiece(type: BuildingPieceType): boolean {
  return !isSolidWallPiece(type) && !isFloorPiece(type) && !isFoundationPiece(type) && !isGreenhousePiece(type);
}

const chunkKeyOf = (p: THREE.Vector3) => `${Math.floor(p.x / CHUNK)},${Math.floor(p.z / CHUNK)}`;

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();

/**
 * Static batching for the per-piece meshes of houses: windows, doors, roofs, stairs, railings,
 * corner stones and furniture. Their triangles are merged per 16 m chunk and per material, so a
 * chunk costs one draw call per material in it instead of 2-4 per piece.
 *
 * - Edits only mark the chunk dirty; `flush` (once per frame) rebuilds just those chunks from the
 *   pieces' own (hidden) meshes, which stay the source of truth: doors swing them, roofs reshape
 *   them, the window glow swaps their glass. The batch copies whatever they show.
 * - "Live" pieces (a roof while its arrows are dragged or a dormer is previewed on it) are drawn on
 *   their own until they settle, so a drag does not rebuild a chunk every frame.
 * - `updateView` hides what would draw nothing: the blended glass beyond the dither range, its
 *   opaque twin up close, and furniture of chunks far away.
 */
export class StaticPieceBatch {
  public readonly stats = { chunks: 0, meshes: 0, lastBuildMs: 0 };

  private readonly root = new THREE.Group();
  private readonly chunks = new Map<string, BatchMesh[]>();
  private readonly dirty = new Set<string>();
  /** Chunk each batched piece was last baked into */
  private readonly pieceChunk = new Map<string, string>();
  /** Live piece id -> seconds left before it rejoins the batch */
  private readonly live = new Map<string, number>();

  constructor(parent: THREE.Object3D) {
    this.root.name = 'StaticPieceBatch';
    this.root.matrixAutoUpdate = false;
    parent.add(this.root);
  }

  /** The piece was added, or what it shows changed (moved, turned, opened, re-skinned, reshaped). */
  public markPiece(piece: BuiltPiece): void {
    if (!isBatchablePiece(piece.type)) return;
    // Already drawn on its own while live: nothing baked shows it
    if (this.live.has(piece.id) && !this.pieceChunk.has(piece.id)) return;
    this.dirty.add(chunkKeyOf(piece.position));
    const old = this.pieceChunk.get(piece.id);
    if (old) this.dirty.add(old);
  }

  public removePiece(piece: BuiltPiece): void {
    if (!isBatchablePiece(piece.type)) return;
    this.markPiece(piece);
    this.pieceChunk.delete(piece.id);
    this.live.delete(piece.id);
  }

  /** Live: drawn as its own mesh while it keeps changing; off rejoins the batch right away. */
  public setLive(piece: BuiltPiece, live: boolean): void {
    if (!isBatchablePiece(piece.type)) return;
    if (live) {
      const was = this.live.has(piece.id);
      this.live.set(piece.id, LIVE_TIMEOUT);
      if (!was) this.markPiece(piece);
    } else if (this.live.delete(piece.id)) {
      this.markPiece(piece);
    }
  }

  /** Rebuilds dirty chunks; live pieces that stopped changing rejoin the batch. */
  public flush(dt: number, pieces: Map<string, BuiltPiece>): void {
    for (const [id, left] of this.live) {
      const t = left - dt;
      if (t > 0) {
        this.live.set(id, t);
        continue;
      }
      this.live.delete(id);
      const p = pieces.get(id);
      if (p) this.markPiece(p);
    }
    if (this.dirty.size === 0) return;
    const t0 = performance.now();

    const members = new Map<string, BuiltPiece[]>();
    for (const key of this.dirty) members.set(key, []);
    for (const piece of pieces.values()) {
      if (!isBatchablePiece(piece.type)) continue;
      const key = chunkKeyOf(piece.position);
      const list = members.get(key);
      if (!list) continue;
      if (this.live.has(piece.id)) {
        piece.meshGroup.visible = true;
        this.pieceChunk.delete(piece.id);
      } else {
        piece.meshGroup.visible = false;
        this.pieceChunk.set(piece.id, key);
        list.push(piece);
      }
    }
    this.dirty.clear();

    this.root.updateMatrixWorld(true);
    _inv.copy(this.root.matrixWorld).invert();
    for (const [key, list] of members) this.buildChunk(key, list);

    let meshes = 0;
    for (const c of this.chunks.values()) meshes += c.length;
    this.stats.chunks = this.chunks.size;
    this.stats.meshes = meshes;
    this.stats.lastBuildMs = performance.now() - t0;
  }

  /** Per frame: hides the glass half that would only discard and the furniture of far chunks. */
  public updateView(cameraPos: THREE.Vector3): void {
    for (const chunk of this.chunks.values()) {
      for (const b of chunk) {
        if (!b.lod && !b.interior) continue;
        const box = b.mesh.geometry.boundingBox!;
        const minD = box.distanceToPoint(cameraPos);
        let visible = true;
        if (b.interior && minD > INTERIOR_DRAW_DISTANCE) visible = false;
        else if (b.lod === 'near') visible = minD < GLASS_DITHER_FAR;
        else if (b.lod === 'far') visible = farthestDistance(box, cameraPos) > GLASS_DITHER_NEAR;
        b.mesh.visible = visible;
      }
    }
  }

  /** Shows every chunk mesh (for a GPU warm-up draw; the next updateView hides what it should). */
  public revealAll(): void {
    for (const chunk of this.chunks.values()) for (const b of chunk) b.mesh.visible = true;
  }

  public dispose(): void {
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
    this.pieceChunk.clear();
    this.live.clear();
    this.dirty.clear();
    this.root.parent?.remove(this.root);
  }

  private buildChunk(key: string, pieces: BuiltPiece[]): void {
    const old = this.chunks.get(key);
    if (old) this.disposeChunk(old);
    this.chunks.delete(key);
    if (pieces.length === 0) return;

    const buckets = new Map<string, Bucket>();
    for (const piece of pieces) {
      const interior = isFurniturePiece(piece.type);
      piece.meshGroup.updateMatrixWorld(true);
      collectSources(piece.meshGroup, (mesh, material, start, count) => {
        // Plain textured materials share one texture-array material (one draw for all of them)
        const slot = textureArraySlot(material);
        const drawWith = slot ? slot.material : material;
        const id = `${drawWith.uuid}|${interior ? 'i' : 's'}`;
        let b = buckets.get(id);
        if (!b) {
          b = { material: drawWith, interior, array: !!slot, sources: [] };
          buckets.set(id, b);
        }
        b.sources.push({ mesh, start, count, material, slot });
      });
    }

    const out: BatchMesh[] = [];
    for (const b of buckets.values()) {
      const geo = mergeSources(b.sources, b.array);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, b.material);
      const first = b.sources[0].mesh;
      mesh.name = `StaticPieceBatch_${key}_${b.interior ? 'interior' : 'shell'}`;
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = first.castShadow;
      mesh.receiveShadow = first.receiveShadow;
      mesh.renderOrder = first.renderOrder;
      this.root.add(mesh);
      out.push({ mesh, lod: glassLodOf(b.material), interior: b.interior });
    }
    if (out.length) this.chunks.set(key, out);
  }

  private disposeChunk(chunk: BatchMesh[]): void {
    for (const b of chunk) {
      b.mesh.geometry.dispose();
      this.root.remove(b.mesh);
    }
  }
}

function farthestDistance(box: THREE.Box3, p: THREE.Vector3): number {
  const dx = Math.max(Math.abs(p.x - box.min.x), Math.abs(p.x - box.max.x));
  const dy = Math.max(Math.abs(p.y - box.min.y), Math.abs(p.y - box.max.y));
  const dz = Math.max(Math.abs(p.z - box.min.z), Math.abs(p.z - box.max.z));
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Every drawn triangle range of the meshes under `root` (the root itself may be hidden: the batch
 * hides it), with the material it is drawn with. Hidden sub-objects and invisible materials skip.
 */
function collectSources(
  root: THREE.Object3D,
  emit: (mesh: THREE.Mesh, material: THREE.Material, start: number, count: number) => void
): void {
  const visit = (o: THREE.Object3D) => {
    if (o !== root && !o.visible) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !(mesh as unknown as THREE.InstancedMesh).isInstancedMesh) {
      const geo = mesh.geometry;
      const total = geo.index ? geo.index.count : geo.getAttribute('position').count;
      const drawStart = Math.max(0, geo.drawRange.start);
      const drawEnd = Math.min(total, drawStart + geo.drawRange.count);
      if (Array.isArray(mesh.material)) {
        for (const g of geo.groups) {
          const mat = mesh.material[g.materialIndex ?? 0];
          if (!mat || !mat.visible) continue;
          const start = Math.max(g.start, drawStart);
          const end = Math.min(g.start + g.count, drawEnd);
          if (end - start >= 3) emit(mesh, mat, start, end - start);
        }
      } else if (mesh.material.visible && drawEnd - drawStart >= 3) {
        emit(mesh, mesh.material, drawStart, drawEnd - drawStart);
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
}

/**
 * One indexed geometry (batch-root space) holding the given triangle ranges. For a texture-array
 * bucket every vertex also gets its source's layer and its material colour (times the source's
 * vertex colour, when that material used one).
 */
function mergeSources(sources: Source[], array: boolean): THREE.BufferGeometry | null {
  // Attribute layout: every attribute any source has; missing ones are filled with defaults
  const layout = new Map<string, number>();
  for (const s of sources) {
    for (const [name, attr] of Object.entries(s.mesh.geometry.attributes)) {
      if (array && name === 'color') continue;
      if (!layout.has(name)) layout.set(name, attr.itemSize);
    }
  }
  if (!layout.has('position')) return null;
  const colors: number[] = [];
  const layers: number[] = [];
  const names = [...layout.keys()];
  const data: Record<string, number[]> = {};
  for (const n of names) data[n] = [];
  const index: number[] = [];
  let vertexCount = 0;

  for (const s of sources) {
    const geo = s.mesh.geometry;
    const idx = geo.index;
    const pos = geo.getAttribute('position');
    _m.multiplyMatrices(_inv, s.mesh.matrixWorld);
    _nm.getNormalMatrix(_m);
    const flip = _m.determinant() < 0;
    const remap = new Int32Array(pos.count).fill(-1);
    const attrs = names.map((n) => geo.getAttribute(n) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined);
    const slot = s.slot;
    const srcColor = slot && s.material.vertexColors ? (geo.getAttribute('color') as THREE.BufferAttribute | undefined) : undefined;

    const vertex = (vi: number): number => {
      let r = remap[vi];
      if (r >= 0) return r;
      r = remap[vi] = vertexCount++;
      if (array) {
        const c = slot!.color;
        if (srcColor) colors.push(c.r * srcColor.getX(vi), c.g * srcColor.getY(vi), c.b * srcColor.getZ(vi));
        else colors.push(c.r, c.g, c.b);
        layers.push(slot!.layer);
      }
      for (let a = 0; a < names.length; a++) {
        const name = names[a];
        const size = layout.get(name)!;
        const attr = attrs[a];
        const arr = data[name];
        if (!attr) {
          const fill = name === 'color' ? 1 : 0;
          for (let c = 0; c < size; c++) arr.push(fill);
        } else if (name === 'position') {
          _v.fromBufferAttribute(attr, vi).applyMatrix4(_m);
          arr.push(_v.x, _v.y, _v.z);
        } else if (name === 'normal') {
          _v.fromBufferAttribute(attr, vi).applyMatrix3(_nm).normalize();
          arr.push(_v.x, _v.y, _v.z);
        } else if (name === 'tangent') {
          _v.set(attr.getX(vi), attr.getY(vi), attr.getZ(vi)).transformDirection(_m);
          arr.push(_v.x, _v.y, _v.z, (attr.itemSize > 3 ? attr.getW(vi) : 1) * (flip ? -1 : 1));
        } else {
          for (let c = 0; c < size; c++) arr.push(c < attr.itemSize ? attr.getComponent(vi, c) : 0);
        }
      }
      return r;
    };

    const end = s.start + s.count - 2;
    for (let i = s.start; i < end; i += 3) {
      const a = vertex(idx ? idx.getX(i) : i);
      const b = vertex(idx ? idx.getX(i + 1) : i + 1);
      const c = vertex(idx ? idx.getX(i + 2) : i + 2);
      if (flip) index.push(a, c, b);
      else index.push(a, b, c);
    }
  }
  if (index.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  for (const n of names) geo.setAttribute(n, new THREE.Float32BufferAttribute(data[n], layout.get(n)!));
  if (array) {
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute(TEX_LAYER_ATTRIBUTE, new THREE.Float32BufferAttribute(layers, 1));
  }
  geo.setIndex(index);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
