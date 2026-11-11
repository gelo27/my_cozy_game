import * as THREE from 'three';
import { BuildingPieceType, BuiltPiece, isGreenhousePiece } from './types/BuildingTypes';
import { BUILDING_MATERIALS, GREENHOUSE_GLASS_FAR } from './config/BuildingPiecesConfig';

/** World is cut into CHUNK x CHUNK metre cells; each cell with greenhouse pieces gets its own batch. */
const CHUNK = 32;

interface ChunkMeshes {
  frame: THREE.Mesh;
  glassNear: THREE.Mesh;
  glassFar: THREE.Mesh;
}

interface Buffers {
  framePos: number[];
  frameNor: number[];
  glassPos: number[];
  glassNor: number[];
}

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();

/**
 * Static batching for greenhouse pieces. Every glass wall, doorway and glass roof is merged per
 * 32m chunk into three meshes: the wooden frame (opaque), the far glass (opaque, dithered in) and
 * the near glass (blended, dithered out). A whole greenhouse is then 3 draw calls instead of ~2-3
 * per piece, regardless of how many panels it has.
 *
 * Not batched (drawn as their own piece meshes): doors, whose leaf swings, and "live" pieces that
 * are being edited right now (a roof while its resize arrows are dragged).
 */
export class GreenhouseBatch {
  private readonly root = new THREE.Group();
  private readonly chunks = new Map<string, ChunkMeshes>();

  constructor(parent: THREE.Object3D) {
    this.root.name = 'GreenhouseBatch';
    parent.add(this.root);
  }

  /** Rebuilds all chunk batches from scratch (a few thousand vertices: cheap, done only on change). */
  public rebuild(pieces: Iterable<BuiltPiece>, isLive: (id: string) => boolean): void {
    const buffers = new Map<string, Buffers>();
    this.root.updateMatrixWorld(true);
    _inv.copy(this.root.matrixWorld).invert();

    for (const piece of pieces) {
      if (!isGreenhousePiece(piece.type)) continue;
      const batched = piece.type !== BuildingPieceType.GLASS_DOOR_1X3 && !isLive(piece.id);
      piece.meshGroup.visible = !batched;
      if (!batched) continue;

      const key = `${Math.floor(piece.position.x / CHUNK)},${Math.floor(piece.position.z / CHUNK)}`;
      let buf = buffers.get(key);
      if (!buf) {
        buf = { framePos: [], frameNor: [], glassPos: [], glassNor: [] };
        buffers.set(key, buf);
      }
      piece.meshGroup.updateMatrixWorld(true);
      piece.meshGroup.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || mesh.name === 'farGlassTwin' || !Array.isArray(mesh.material)) return;
        this.appendMesh(mesh, buf!);
      });
    }

    // Drop chunks that no longer have pieces, (re)fill the rest
    for (const [key, meshes] of this.chunks) {
      if (!buffers.has(key)) {
        this.disposeChunk(meshes);
        this.chunks.delete(key);
      }
    }
    for (const [key, buf] of buffers) {
      let meshes = this.chunks.get(key);
      if (!meshes) {
        meshes = {
          frame: new THREE.Mesh(new THREE.BufferGeometry(), BUILDING_MATERIALS.greenhouseFrame),
          glassFar: new THREE.Mesh(new THREE.BufferGeometry(), GREENHOUSE_GLASS_FAR),
          glassNear: new THREE.Mesh(new THREE.BufferGeometry(), BUILDING_MATERIALS.greenhouseGlass),
        };
        meshes.frame.name = `GreenhouseFrame_${key}`;
        meshes.glassFar.name = `GreenhouseGlassFar_${key}`;
        meshes.glassNear.name = `GreenhouseGlassNear_${key}`;
        for (const m of [meshes.frame, meshes.glassFar, meshes.glassNear]) {
          m.matrixAutoUpdate = false;
          this.root.add(m);
        }
        this.chunks.set(key, meshes);
      }
      this.fill(meshes.frame, buf.framePos, buf.frameNor);
      const glass = this.fill(meshes.glassNear, buf.glassPos, buf.glassNor);
      // Far and near glass draw the very same triangles: share one geometry
      if (meshes.glassFar.geometry !== glass) {
        meshes.glassFar.geometry.dispose();
        meshes.glassFar.geometry = glass;
      }
    }
  }

  /** Number of chunk batches (each is 3 draw calls). */
  public get chunkCount(): number {
    return this.chunks.size;
  }

  public dispose(): void {
    for (const meshes of this.chunks.values()) this.disposeChunk(meshes);
    this.chunks.clear();
    this.root.parent?.remove(this.root);
  }

  /** Splits a piece mesh by material group into frame / glass triangles, in batch-root space. */
  private appendMesh(mesh: THREE.Mesh, buf: Buffers): void {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
    const index = geo.getIndex();
    const mats = mesh.material as THREE.Material[];
    _m.multiplyMatrices(_inv, mesh.matrixWorld);
    _nm.getNormalMatrix(_m);

    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: index ? index.count : pos.count, materialIndex: 0 }];
    for (const g of groups) {
      const mat = mats[g.materialIndex ?? 0];
      const isGlass = mat === BUILDING_MATERIALS.greenhouseGlass;
      if (!isGlass && mat !== BUILDING_MATERIALS.greenhouseFrame) continue;
      const outPos = isGlass ? buf.glassPos : buf.framePos;
      const outNor = isGlass ? buf.glassNor : buf.frameNor;
      const end = g.start + g.count;
      for (let i = g.start; i < end; i++) {
        const vi = index ? index.getX(i) : i;
        _v.fromBufferAttribute(pos, vi).applyMatrix4(_m);
        outPos.push(_v.x, _v.y, _v.z);
        _v.fromBufferAttribute(nor, vi).applyMatrix3(_nm).normalize();
        outNor.push(_v.x, _v.y, _v.z);
      }
    }
  }

  private fill(mesh: THREE.Mesh, pos: number[], nor: number[]): THREE.BufferGeometry {
    const old = mesh.geometry;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    mesh.geometry = geo;
    mesh.visible = pos.length > 0;
    old.dispose();
    return geo;
  }

  private disposeChunk(meshes: ChunkMeshes): void {
    const geos = new Set([meshes.frame.geometry, meshes.glassNear.geometry, meshes.glassFar.geometry]);
    geos.forEach((g) => g.dispose());
    this.root.remove(meshes.frame, meshes.glassNear, meshes.glassFar);
  }
}
