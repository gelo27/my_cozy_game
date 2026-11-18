import * as THREE from 'three';
import {
  BuiltPiece,
  BuildingPieceType,
  getWallSize,
  isFloorPiece,
  isFoundationPiece,
  isSolidWallPiece,
  isWindowOrDoorPiece,
} from './types/BuildingTypes';
import { BUILDING_MATERIALS } from './config/BuildingPiecesConfig';
import { FLOOR_THICKNESS, WALL_THICKNESS } from './config/BuildingConstants';
import type { WallPaintingSystem, WallFaceSide } from './WallPaintingSystem';
import { FaceStyle, MeshBuffers, PaintableMesh } from './continuous/MeshBuffers';
import { describeWallSeg, solveWall, summarizeWall, SolvedSegmentCorners, WallSeg } from './continuous/WallJoints';
import { emitWall, findWallOpenings } from './continuous/WallGeometry';
import { boxObstacle, createWallObstacle, emitFloor, floorObstacle, slabCoversWallTop, WallObstacle } from './continuous/FloorGeometry';
import { emitFoundation, foundationLookup } from './continuous/FoundationGeometry';

export type { SolvedSegmentCorners } from './continuous/WallJoints';

/**
 * Bakes confirmed walls, floors and foundations into seamless merged meshes (mitred corners, holes
 * for windows and doors, floors trimmed to the walls), split into square chunks of the world.
 *
 * - Pieces start unconfirmed (their own per-piece mesh). Only `confirm` (the confirm buttons, or
 *   painting that piece, or a window/door cut into that wall) bakes them; rebuilding for any other
 *   reason never bakes pending pieces behind the player's back.
 * - An edit only marks the chunks around the piece dirty; `flush` (once per frame) rebuilds just
 *   those. Chunks also let the renderer skip buildings off screen.
 * - Painting only re-skins the painted faces of their chunk mesh: no geometry is rebuilt.
 */

type Layer = 'walls' | 'floors' | 'foundations';
const LAYERS: Layer[] = ['walls', 'floors', 'foundations'];

/** Chunk edge length, m */
const CHUNK_SIZE = 16;
/** A change reaches this far (m) from the piece's centre: neighbours' corners, holes, floor cuts */
const DIRTY_RADIUS = 3;
/** Neighbour search radius around a wall's centre, beyond its half width */
const NEIGHBOUR_MARGIN = 2.5;

export interface PieceSource {
  getPieces(): Map<string, BuiltPiece>;
  /** Pieces whose bounds come within `radius` of `center` */
  near(center: THREE.Vector3, radius: number): BuiltPiece[];
}

function layerOf(type: BuildingPieceType): Layer | null {
  if (isSolidWallPiece(type)) return 'walls';
  if (isFloorPiece(type)) return 'floors';
  if (isFoundationPiece(type)) return 'foundations';
  return null;
}

/** Layers whose meshes a change of this piece type can alter */
function layersAffectedBy(type: BuildingPieceType): Layer[] {
  if (isSolidWallPiece(type) || isWindowOrDoorPiece(type)) return ['walls', 'floors'];
  // A floor can lie over wall tops, which then leave out their top edge
  if (isFloorPiece(type)) return ['walls', 'floors'];
  if (isFoundationPiece(type)) return ['foundations'];
  return [];
}

const chunkKeyOf = (x: number, z: number) => `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;

const WALL_SIDES: WallFaceSide[] = ['left', 'right'];
const FLOOR_SIDES: WallFaceSide[] = ['top', 'bottom'];

export class ContinuousWallSystem {
  public readonly lastSolvedCorners = new Map<string, SolvedSegmentCorners>();

  private readonly chunks: Record<Layer, Map<string, PaintableMesh>> = { walls: new Map(), floors: new Map(), foundations: new Map() };
  private readonly dirty: Record<Layer, Set<string>> = { walls: new Set(), floors: new Set(), foundations: new Set() };
  private readonly unconfirmed: Record<Layer, Set<string>> = { walls: new Set(), floors: new Set(), foundations: new Set() };
  /** Wall ids last baked into each wall chunk (to drop their solved corners on rebuild) */
  private readonly chunkWallIds = new Map<string, string[]>();
  /** Pieces whose painted faces must be re-skinned at the next flush */
  private readonly pendingRestyle = new Set<string>();

  constructor(
    private readonly sceneGroup: THREE.Group,
    private readonly paint: WallPaintingSystem,
    private readonly source: PieceSource
  ) {}

  // ------------------------------------------------------------------ queries

  public getWallMeshes(): THREE.Mesh[] {
    return Array.from(this.chunks.walls.values(), (c) => c.mesh);
  }

  public getFloorMeshes(): THREE.Mesh[] {
    return Array.from(this.chunks.floors.values(), (c) => c.mesh);
  }

  public getLastSolvedCorners(): Map<string, SolvedSegmentCorners> {
    return this.lastSolvedCorners;
  }

  /** Painted face (`pieceId:side`) under a raycast hit on one of the merged meshes, if any. */
  public faceKeyFromHit(hit: THREE.Intersection): string | null {
    const paintable = hit.object.userData.paintable as PaintableMesh | undefined;
    return paintable ? paintable.faceKeyAt(hit.faceIndex) : null;
  }

  public isConfirmablePiece(type: BuildingPieceType): boolean {
    return layerOf(type) !== null;
  }

  public getUnconfirmedWallCount(): number {
    return this.unconfirmed.walls.size;
  }

  public getUnconfirmedFloorCount(): number {
    return this.unconfirmed.floors.size;
  }

  public getUnconfirmedFoundationCount(): number {
    return this.unconfirmed.foundations.size;
  }

  // ------------------------------------------------------------------ edits

  /** A piece was placed. Walls, floors and foundations start unconfirmed. */
  public registerPiece(piece: BuiltPiece): void {
    const layer = layerOf(piece.type);
    if (layer) {
      this.unconfirmed[layer].add(piece.id);
      piece.isConfirmed = false;
    } else if (isWindowOrDoorPiece(piece.type)) {
      piece.isConfirmed = true;
      piece.meshGroup.visible = true;
      // The hole is cut in the baked wall mesh, so the walls it goes through are baked now
      for (const wall of this.wallsCutBy(piece)) if (!wall.isConfirmed) this.confirmPiece(wall);
    }
    this.markDirty(piece);
  }

  /** A piece is about to be removed. */
  public unregisterPiece(piece: BuiltPiece): void {
    for (const layer of LAYERS) this.unconfirmed[layer].delete(piece.id);
    this.lastSolvedCorners.delete(piece.id);
    this.markDirty(piece);
  }

  /** A piece moved or turned. */
  public pieceChanged(piece: BuiltPiece): void {
    if (isWindowOrDoorPiece(piece.type)) {
      for (const wall of this.wallsCutBy(piece)) if (!wall.isConfirmed) this.confirmPiece(wall);
    }
    this.markDirty(piece);
  }

  public invalidatePieceArea(piece: BuiltPiece): void {
    this.markDirty(piece);
  }

  /** Bakes every pending piece of `layer` (or all layers). True when that layer has any pieces. */
  public confirm(layer: Layer | 'all'): boolean {
    const layers = layer === 'all' ? LAYERS : [layer];
    const pieces = this.source.getPieces();
    for (const l of layers) {
      for (const id of Array.from(this.unconfirmed[l])) {
        const p = pieces.get(id);
        if (p) this.confirmPiece(p);
        else this.unconfirmed[l].delete(id);
      }
    }
    this.flush();
    for (const p of pieces.values()) {
      const l = layerOf(p.type);
      if (l && layers.includes(l)) return true;
    }
    return false;
  }

  /** Bake a newly placed template without confirming other construction in progress. */
  public confirmPieces(pieces: readonly BuiltPiece[]): void {
    for (const piece of pieces) if (!piece.isConfirmed) this.confirmPiece(piece);
    this.flush();
  }

  /** Paint changed on these pieces' faces. Pending pieces get baked (their paint shows on the baked mesh). */
  public repaint(pieceIds: Iterable<string>): void {
    const pieces = this.source.getPieces();
    for (const id of pieceIds) {
      const p = pieces.get(id);
      if (!p || !layerOf(p.type)) continue;
      if (!p.isConfirmed) this.confirmPiece(p);
      else this.pendingRestyle.add(id);
    }
  }

  /** Re-skins every baked face (after paint was loaded or cleared in bulk). */
  public repaintAll(): void {
    for (const layer of ['walls', 'floors'] as const) {
      for (const chunk of this.chunks[layer].values()) chunk.restyle(null, this.resolveStyle);
    }
    this.pendingRestyle.clear();
  }

  /** Rebuilds dirty chunks and re-skins repainted faces. Cheap when nothing changed. */
  public flush(): void {
    if (LAYERS.some((l) => this.dirty[l].size > 0)) this.rebuildDirtyChunks();
    if (this.pendingRestyle.size > 0) this.applyRestyle();
  }

  public dispose(): void {
    for (const layer of LAYERS) {
      for (const chunk of this.chunks[layer].values()) chunk.dispose();
      this.chunks[layer].clear();
      this.dirty[layer].clear();
      this.unconfirmed[layer].clear();
    }
    this.chunkWallIds.clear();
    this.lastSolvedCorners.clear();
    this.pendingRestyle.clear();
  }

  // ------------------------------------------------------------------ internals

  private confirmPiece(piece: BuiltPiece): void {
    const layer = layerOf(piece.type);
    if (!layer) return;
    this.unconfirmed[layer].delete(piece.id);
    piece.isConfirmed = true;
    this.markDirty(piece);
  }

  private wallsCutBy(opening: BuiltPiece): BuiltPiece[] {
    const [w] = getWallSize(opening.type);
    return this.source
      .near(opening.position, w / 2 + NEIGHBOUR_MARGIN)
      .filter((p) => isSolidWallPiece(p.type) && findWallOpenings(p, [opening]).length > 0);
  }

  private markDirty(piece: BuiltPiece): void {
    const layers = layersAffectedBy(piece.type);
    if (layers.length === 0) return;
    const { x, z } = piece.position;
    const r = DIRTY_RADIUS;
    for (let cx = Math.floor((x - r) / CHUNK_SIZE); cx <= Math.floor((x + r) / CHUNK_SIZE); cx++) {
      for (let cz = Math.floor((z - r) / CHUNK_SIZE); cz <= Math.floor((z + r) / CHUNK_SIZE); cz++) {
        for (const l of layers) this.dirty[l].add(`${cx},${cz}`);
      }
    }
  }

  private readonly resolveStyle = (key: string): FaceStyle => {
    const cut = key.lastIndexOf(':');
    const wallpaperId = this.paint.getFaceWallpaper(key.slice(0, cut), key.slice(cut + 1) as WallFaceSide);
    return { materialIndex: this.paint.getMaterialIndex(wallpaperId), tile: this.paint.getTileSize(wallpaperId) };
  };

  private rebuildDirtyChunks(): void {
    // One pass over all pieces: the confirmed members of every dirty chunk
    const members: Record<Layer, Map<string, BuiltPiece[]>> = { walls: new Map(), floors: new Map(), foundations: new Map() };
    for (const l of LAYERS) for (const key of this.dirty[l]) members[l].set(key, []);
    for (const p of this.source.getPieces().values()) {
      const l = layerOf(p.type);
      if (!l || !p.isConfirmed) continue;
      const list = members[l].get(chunkKeyOf(p.position.x, p.position.z));
      if (list) list.push(p);
    }
    for (const l of LAYERS) this.dirty[l].clear();

    // Walls first: floors are cut to the freshly solved wall corners
    const segCache = new Map<string, WallSeg>();
    for (const [key, walls] of members.walls) this.rebuildWallChunk(key, walls, segCache);
    for (const [key, floors] of members.floors) this.rebuildFloorChunk(key, floors);
    for (const [key, blocks] of members.foundations) this.rebuildFoundationChunk(key, blocks);
  }

  private replaceChunk(layer: Layer, key: string, buffers: MeshBuffers | null, materials: THREE.Material | THREE.Material[], paintable: boolean): void {
    this.chunks[layer].get(key)?.dispose();
    this.chunks[layer].delete(key);
    if (!buffers || buffers.isEmpty()) return;
    const chunk = new PaintableMesh(buffers, materials, `ContinuousWallSystem_${layer}_${key}`, paintable ? this.resolveStyle : null);
    chunk.mesh.userData.paintable = chunk;
    this.sceneGroup.add(chunk.mesh);
    this.chunks[layer].set(key, chunk);
  }

  private segOf(piece: BuiltPiece, cache: Map<string, WallSeg>): WallSeg {
    let seg = cache.get(piece.id);
    if (!seg) cache.set(piece.id, (seg = describeWallSeg(piece)));
    return seg;
  }

  private rebuildWallChunk(key: string, walls: BuiltPiece[], segCache: Map<string, WallSeg>): void {
    for (const id of this.chunkWallIds.get(key) ?? []) this.lastSolvedCorners.delete(id);
    this.chunkWallIds.set(key, walls.map((w) => w.id));
    if (walls.length === 0) {
      this.chunkWallIds.delete(key);
      this.replaceChunk('walls', key, null, [], true);
      return;
    }
    const b = new MeshBuffers();
    const style = {
      edge: this.paint.getWallEdgeMaterialIndex(),
      faceKey: (id: string, side: 'left' | 'right') => this.paint.getCellKey(id, side),
    };
    for (const wall of walls) {
      const seg = this.segOf(wall, segCache);
      const around = this.source.near(wall.position, seg.halfW + NEIGHBOUR_MARGIN);
      const neighbours = around.filter((p) => p.isConfirmed && isSolidWallPiece(p.type)).map((p) => this.segOf(p, segCache));
      const openings = findWallOpenings(wall, around.filter((p) => isWindowOrDoorPiece(p.type)));
      // Floor slabs lying over this wall's top hide it (the floor of the storey above runs on over it)
      const covers = around
        .filter((p) => isFloorPiece(p.type) && slabCoversWallTop(p.position.y - FLOOR_THICKNESS / 2, p.position.y + FLOOR_THICKNESS / 2, seg.yTop))
        .map(floorObstacle);
      const solved = solveWall(seg, neighbours);
      this.lastSolvedCorners.set(wall.id, summarizeWall(solved));
      emitWall(b, solved, openings, style, covers);
      wall.meshGroup.visible = false;
    }
    this.replaceChunk('walls', key, b, this.paint.getAllMaterials(), true);
  }

  private rebuildFloorChunk(key: string, floors: BuiltPiece[]): void {
    if (floors.length === 0) {
      this.replaceChunk('floors', key, null, [], true);
      return;
    }
    const b = new MeshBuffers();
    const style = { edge: 0, faceKey: (id: string, side: 'top' | 'bottom') => this.paint.getCellKey(id, side) };
    for (const floor of floors) {
      const around = this.source.near(floor.position, DIRTY_RADIUS + 0.5);
      const walls: WallObstacle[] = [];
      const neighbourFloors: BuiltPiece[] = [];
      for (const p of around) {
        if (isFloorPiece(p.type)) {
          if (p.isConfirmed) neighbourFloors.push(p);
          continue;
        }
        const solidWall = isSolidWallPiece(p.type);
        if (!solidWall && !isWindowOrDoorPiece(p.type)) continue;
        const solved = solidWall && p.isConfirmed ? this.lastSolvedCorners.get(p.id) : undefined;
        if (solved) {
          walls.push(createWallObstacle(solved.startLeft, solved.startRight, solved.endLeft, solved.endRight, solved.yBase, solved.yTop));
        } else {
          const [w, h] = getWallSize(p.type);
          walls.push(boxObstacle(p, w, h, WALL_THICKNESS));
        }
      }
      emitFloor(b, floor, neighbourFloors, walls, style);
      floor.meshGroup.visible = false;
    }
    this.replaceChunk('floors', key, b, this.paint.getAllMaterials(), true);
  }

  private rebuildFoundationChunk(key: string, blocks: BuiltPiece[]): void {
    if (blocks.length === 0) {
      this.replaceChunk('foundations', key, null, [], false);
      return;
    }
    const b = new MeshBuffers();
    const taken = foundationLookup(
      blocks.flatMap((blk) => this.source.near(blk.position, 2.5).filter((p) => p.isConfirmed && isFoundationPiece(p.type)))
    );
    b.beginGroup();
    for (const blk of blocks) {
      emitFoundation(b, blk, taken);
      blk.meshGroup.visible = false;
    }
    b.endGroup(null, 0);
    this.replaceChunk('foundations', key, b, BUILDING_MATERIALS.stone, false);
  }

  private applyRestyle(): void {
    const pieces = this.source.getPieces();
    const byChunk: Record<'walls' | 'floors', Map<string, Set<string>>> = { walls: new Map(), floors: new Map() };
    for (const id of this.pendingRestyle) {
      const p = pieces.get(id);
      const l = p && layerOf(p.type);
      if (!p || (l !== 'walls' && l !== 'floors')) continue;
      const key = chunkKeyOf(p.position.x, p.position.z);
      let keys = byChunk[l].get(key);
      if (!keys) byChunk[l].set(key, (keys = new Set()));
      for (const side of l === 'walls' ? WALL_SIDES : FLOOR_SIDES) keys.add(this.paint.getCellKey(id, side));
    }
    this.pendingRestyle.clear();
    for (const l of ['walls', 'floors'] as const) {
      for (const [key, keys] of byChunk[l]) this.chunks[l].get(key)?.restyle(keys, this.resolveStyle);
    }
  }
}
