import * as THREE from 'three';
import { BuiltPiece } from '../types/BuildingTypes';
import { MODULE_SIZE } from '../config/BuildingConstants';
import { MeshBuffers } from './MeshBuffers';

/**
 * Emits merged stone foundations: 2x2 m blocks, 1 m tall, with world-aligned stone UVs and side
 * faces only where no block stands next to it.
 */

/** One stone block pair per metre */
const STONE_TILE_SIZE = 1.0;
const HEIGHT = 1.0;

const snapKey = (x: number, y: number, z: number) => `${Math.round(x * 2) / 2}_${Math.round(y * 10) / 10}_${Math.round(z * 2) / 2}`;

/** Lookup of which block positions are taken, built from the blocks around the ones being emitted */
export function foundationLookup(blocks: Iterable<BuiltPiece>): Set<string> {
  const set = new Set<string>();
  for (const p of blocks) set.add(snapKey(p.position.x, p.position.y, p.position.z));
  return set;
}

export function emitFoundation(b: MeshBuffers, piece: BuiltPiece, taken: Set<string>): void {
  const { x: px, y: py, z: pz } = piece.position;
  const h = MODULE_SIZE / 2;
  const minX = px - h, maxX = px + h, minZ = pz - h, maxZ = pz + h;
  const yTop = py + HEIGHT / 2;
  const yBase = py - HEIGHT / 2;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const tnw = V(minX, yTop, minZ), tne = V(maxX, yTop, minZ), tse = V(maxX, yTop, maxZ), tsw = V(minX, yTop, maxZ);
  const bnw = V(minX, yBase, minZ), bne = V(maxX, yBase, minZ), bse = V(maxX, yBase, maxZ), bsw = V(minX, yBase, maxZ);
  const u0 = minX / STONE_TILE_SIZE, u1 = maxX / STONE_TILE_SIZE;
  const v0 = minZ / STONE_TILE_SIZE, v1 = maxZ / STONE_TILE_SIZE;
  const H = HEIGHT / STONE_TILE_SIZE;

  b.quad(tnw, tsw, tse, tne, [u0, v0, u0, v1, u1, v1, u1, v0], new THREE.Vector3(0, 1, 0));
  b.quad(bnw, bne, bse, bsw, [u0, v0, u1, v0, u1, v1, u0, v1], new THREE.Vector3(0, -1, 0));
  const has = (dx: number, dz: number) => taken.has(snapKey(px + dx, py, pz + dz));
  if (!has(0, -MODULE_SIZE)) b.quad(bnw, tnw, tne, bne, [u0, 0, u0, H, u1, H, u1, 0], new THREE.Vector3(0, 0, -1));
  if (!has(0, MODULE_SIZE)) b.quad(bse, tse, tsw, bsw, [u1, 0, u1, H, u0, H, u0, 0], new THREE.Vector3(0, 0, 1));
  if (!has(MODULE_SIZE, 0)) b.quad(bne, tne, tse, bse, [v0, 0, v0, H, v1, H, v1, 0], new THREE.Vector3(1, 0, 0));
  if (!has(-MODULE_SIZE, 0)) b.quad(bsw, tsw, tnw, bnw, [v1, 0, v1, H, v0, H, v0, 0], new THREE.Vector3(-1, 0, 0));
}
