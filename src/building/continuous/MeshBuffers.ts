import * as THREE from 'three';

/**
 * Growable vertex/index buffers for the merged building meshes, plus the bookkeeping that lets a
 * finished mesh be re-skinned (wallpaper changed) without recomputing any geometry.
 *
 * Paintable faces are emitted with UVs in metres and a face key (`pieceId:side`); `PaintableMesh`
 * turns those into the wallpaper's own tile scale and material, and can redo just that later.
 */

/** A run of triangles that share one material (and, if paintable, one face key). */
export interface FaceGroup {
  /** Offset into the raw (unmerged) index list */
  start: number;
  count: number;
  /** Vertex range the group's triangles use (for UV rescaling) */
  vStart: number;
  vCount: number;
  /** Painted face this group belongs to, or null for fixed trim (edges, jambs, caps) */
  key: string | null;
  /** UVs follow the wallpaper's tile size (walls); floors keep their fixed checker UVs */
  tiled: boolean;
  materialIndex: number;
}

export interface FaceStyle {
  materialIndex: number;
  tile: { width: number; height: number };
}

export type FaceStyleResolver = (key: string) => FaceStyle;

export class MeshBuffers {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];
  groups: FaceGroup[] = [];
  private markIndex = 0;
  private markVertex = 0;

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  /** Starts a group: everything emitted until `endGroup` belongs to it. */
  beginGroup(): void {
    this.markIndex = this.indices.length;
    this.markVertex = this.vertexCount;
  }

  endGroup(key: string | null, materialIndex: number, tiled = false): void {
    const count = this.indices.length - this.markIndex;
    if (count <= 0) return;
    this.groups.push({
      start: this.markIndex,
      count,
      vStart: this.markVertex,
      vCount: this.vertexCount - this.markVertex,
      key,
      tiled,
      materialIndex,
    });
  }

  /** Quad p1-p2-p3-p4 (counter-clockwise seen from the front), uv as [u1,v1,…,u4,v4]. */
  quad(p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, p4: THREE.Vector3, uv: ArrayLike<number>, normal?: THREE.Vector3): void {
    let nx: number, ny: number, nz: number;
    if (normal) {
      nx = normal.x; ny = normal.y; nz = normal.z;
    } else {
      const ax = p2.x - p1.x, ay = p2.y - p1.y, az = p2.z - p1.z;
      const bx = p4.x - p1.x, by = p4.y - p1.y, bz = p4.z - p1.z;
      nx = ay * bz - az * by; ny = az * bx - ax * bz; nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
    }
    const v = this.vertexCount;
    this.positions.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z, p4.x, p4.y, p4.z);
    for (let i = 0; i < 4; i++) this.normals.push(nx, ny, nz);
    for (let i = 0; i < 8; i++) this.uvs.push(uv[i]);
    this.indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }

  /** Horizontal convex polygon (x,z points) at height y, fanned from the first point. */
  polygon(points: THREE.Vector2[], y: number, up: boolean, uvScale: number): void {
    if (points.length < 3) return;
    const v = this.vertexCount;
    for (const p of points) {
      this.positions.push(p.x, y, p.y);
      this.normals.push(0, up ? 1 : -1, 0);
      this.uvs.push(p.x / uvScale, p.y / uvScale);
    }
    for (let i = 1; i < points.length - 1; i++) {
      // Points run counter-clockwise in (x, z); seen from above (+Y) that is clockwise, so flip for up
      if (up) this.indices.push(v, v + i + 1, v + i);
      else this.indices.push(v, v + i, v + i + 1);
    }
  }

  isEmpty(): boolean {
    return this.positions.length === 0;
  }
}

/**
 * A merged mesh whose painted faces can be re-skinned in place: materials and wallpaper tile scale
 * change, the vertex positions never do. Triangles are drawn sorted by material (one draw call per
 * wallpaper in use), and `faceKeyAt` maps a raycast hit back to the painted face.
 */
export class PaintableMesh {
  readonly mesh: THREE.Mesh;
  private readonly groups: FaceGroup[];
  private readonly rawIndices: Uint32Array;
  /** Metre UVs of tiled faces, parallel to the uv attribute */
  private readonly meterUVs: Float32Array;
  /** Face key of each drawn triangle, in draw order */
  private triKeys: Array<string | null> = [];
  /** Face keys present in this mesh */
  readonly keys = new Set<string>();

  constructor(buffers: MeshBuffers, materials: THREE.Material | THREE.Material[], name: string, resolve: FaceStyleResolver | null) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buffers.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(buffers.normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(buffers.uvs, 2));
    this.groups = buffers.groups;
    this.rawIndices = new Uint32Array(buffers.indices);
    this.meterUVs = new Float32Array(buffers.uvs);
    for (const g of this.groups) if (g.key) this.keys.add(g.key);

    this.mesh = new THREE.Mesh(geo, materials);
    this.mesh.name = name;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.restyle(null, resolve);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
  }

  /** Painted face hit by triangle `faceIndex` of a raycast against this mesh. */
  faceKeyAt(faceIndex: number | undefined | null): string | null {
    if (faceIndex === undefined || faceIndex === null) return null;
    return this.triKeys[faceIndex] ?? null;
  }

  /**
   * Re-reads material and tile size for the faces in `keys` (all faces when null) and redraws.
   * Returns false when none of `keys` is in this mesh.
   */
  restyle(keys: Set<string> | null, resolve: FaceStyleResolver | null): boolean {
    const geo = this.mesh.geometry;
    const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute;
    const uv = uvAttr.array as Float32Array;
    let touched = false;
    if (resolve) {
      for (const g of this.groups) {
        if (!g.key || (keys && !keys.has(g.key))) continue;
        touched = true;
        const style = resolve(g.key);
        g.materialIndex = style.materialIndex;
        if (!g.tiled) continue;
        const sx = 1 / style.tile.width;
        const sy = 1 / style.tile.height;
        for (let i = g.vStart * 2, end = (g.vStart + g.vCount) * 2; i < end; i += 2) {
          uv[i] = this.meterUVs[i] * sx;
          uv[i + 1] = this.meterUVs[i + 1] * sy;
        }
      }
    }
    if (!touched && keys) return false;
    uvAttr.needsUpdate = true;
    this.mergeGroups();
    return true;
  }

  /** Rebuilds the draw order: triangles sorted by material, one geometry group per material. */
  private mergeGroups(): void {
    const geo = this.mesh.geometry;
    const byMaterial = new Map<number, FaceGroup[]>();
    for (const g of this.groups) {
      let list = byMaterial.get(g.materialIndex);
      if (!list) byMaterial.set(g.materialIndex, (list = []));
      list.push(g);
    }
    const total = this.groups.reduce((n, g) => n + g.count, 0);
    const merged = new Uint32Array(total);
    const triKeys: Array<string | null> = new Array(total / 3);
    geo.clearGroups();
    let at = 0;
    for (const materialIndex of Array.from(byMaterial.keys()).sort((a, b) => a - b)) {
      const start = at;
      for (const g of byMaterial.get(materialIndex)!) {
        merged.set(this.rawIndices.subarray(g.start, g.start + g.count), at);
        for (let t = 0; t < g.count / 3; t++) triKeys[at / 3 + t] = g.key;
        at += g.count;
      }
      geo.addGroup(start, at - start, materialIndex);
    }
    geo.setIndex(new THREE.BufferAttribute(merged, 1));
    this.triKeys = triKeys;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}
