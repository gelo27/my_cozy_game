import * as THREE from 'three';
import { BuiltPiece, isGlassRoofPiece, isProceduralRoofPiece, isSolidWallPiece } from './types/BuildingTypes';
import { describeWallSeg } from './continuous/WallJoints';
import type { WallPaintingSystem } from './WallPaintingSystem';
import { DEFAULT_ROOF_STYLE, PROCEDURAL_ROOF_MATERIALS, getRoofShingleMaterial } from './ProceduralRoofSystem';

/**
 * Materials of a procedural roof: its own shingle style, white trim, and frontons / attic walls in
 * the outer finish of the wall they stand on (lap siding when there is none).
 */

type Near = (center: THREE.Vector3, radius: number) => BuiltPiece[];

const ON_LINE = 0.12;
const HEIGHT_MATCH = 0.15;

/** Wall centre lines (local, y = 0) the frontons / attic walls stand on */
function atticLines(roof: BuiltPiece): Array<[THREE.Vector3, THREE.Vector3]> {
  const c = roof.roofConfig;
  if (!c) return [];
  const V = (x: number, z: number) => new THREE.Vector3(x, 0, z);
  if (c.roofType === 'gable') return [[V(c.minX, c.minZ), V(c.maxX, c.minZ)], [V(c.minX, c.maxZ), V(c.maxX, c.maxZ)]];
  if (c.roofType === 'shed') {
    return [[V(c.minX, c.maxZ), V(c.maxX, c.maxZ)], [V(c.minX, c.minZ), V(c.minX, c.maxZ)], [V(c.maxX, c.minZ), V(c.maxX, c.maxZ)]];
  }
  return [];
}

/** A solid wall whose top meets the roof base along one of its attic lines */
export function findAtticWall(roof: BuiltPiece, near: Near): BuiltPiece | null {
  for (const [la, lb] of atticLines(roof)) {
    const a = la.applyQuaternion(roof.quaternion).add(roof.position);
    const b = lb.applyQuaternion(roof.quaternion).add(roof.position);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dir = new THREE.Vector2(b.x - a.x, b.z - a.z);
    const half = dir.length() / 2;
    if (half < 1e-3) continue;
    dir.divideScalar(half * 2);
    for (const p of near(mid, half + 2)) {
      if (!isSolidWallPiece(p.type)) continue;
      const seg = describeWallSeg(p);
      if (Math.abs(seg.yTop - roof.position.y) > HEIGHT_MATCH) continue;
      if (Math.abs(seg.dir.dot(dir)) < 0.98) continue;
      const dx = p.position.x - mid.x, dz = p.position.z - mid.z;
      if (Math.abs(dx * -dir.y + dz * dir.x) > ON_LINE) continue;
      if (Math.abs(dx * dir.x + dz * dir.y) > half + 0.1) continue;
      return p;
    }
  }
  return null;
}

/** The roof's own mesh (glass roofs have far-glass twins, procedural shingle roofs just one) */
function roofMesh(roof: BuiltPiece): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  roof.meshGroup.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  return found;
}

/**
 * Applies the roof's style and the attic finish. Attic UVs come out of the generator in metres;
 * they are scaled to the wall finish's tile size, remembered so repeated calls stay exact.
 */
export function dressRoof(roof: BuiltPiece, paint: WallPaintingSystem, near: Near): void {
  if (!isProceduralRoofPiece(roof.type) || isGlassRoofPiece(roof.type)) return;
  const mesh = roofMesh(roof);
  if (!mesh) return;

  let attic: THREE.Material = PROCEDURAL_ROOF_MATERIALS.gableWall;
  let tile = { width: 1, height: 1 };
  const wall = findAtticWall(roof, near);
  if (wall) {
    const side = paint.isOuterFace(wall.id, 'left') ? 'left' : 'right';
    const wallpaper = paint.getFaceWallpaper(wall.id, side);
    attic = paint.getAllMaterials()[paint.getMaterialIndex(wallpaper)] ?? attic;
    tile = paint.getTileSize(wallpaper);
  }

  const shingle = getRoofShingleMaterial(roof.roofStyle ?? DEFAULT_ROOF_STYLE);
  const current = mesh.material as THREE.Material[];
  if (!Array.isArray(current) || current[0] !== shingle || current[1] !== PROCEDURAL_ROOF_MATERIALS.woodTrim || current[2] !== attic) {
    mesh.material = [shingle, PROCEDURAL_ROOF_MATERIALS.woodTrim, attic];
  }

  const prev = (mesh.userData.atticTile as { width: number; height: number } | undefined) ?? { width: 1, height: 1 };
  if (prev.width === tile.width && prev.height === tile.height) return;
  const group = mesh.geometry.groups.find((g) => g.materialIndex === 2);
  const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (group && uv) {
    const su = prev.width / tile.width, sv = prev.height / tile.height;
    for (let i = group.start; i < group.start + group.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    uv.needsUpdate = true;
  }
  mesh.userData.atticTile = { ...tile };
}

/** Marks a freshly generated roof geometry as having metre UVs again */
export function resetRoofAtticTile(roof: BuiltPiece): void {
  const mesh = roofMesh(roof);
  if (mesh) mesh.userData.atticTile = { width: 1, height: 1 };
}
