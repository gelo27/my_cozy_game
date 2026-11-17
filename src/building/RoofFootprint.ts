import * as THREE from 'three';
import type { BuiltPiece } from './types/BuildingTypes';

export interface GroundRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const tmp = new THREE.Vector3();

/**
 * A house roof's outline (its `footprint`, right-angled) as world XZ rectangles, each grown by
 * `pad` (the eave overhang). An L-, U- or H-shaped house covers its wings only, not the yards
 * between them that its bounding box would take in. Null for roofs without an outline.
 */
export function houseRoofRects(piece: BuiltPiece, pad: number): GroundRect[] | null {
  const fp = piece.roofConfig?.footprint;
  if (!fp || fp.length < 4) return null;
  // Vertical slabs between the outline's distinct x; in each, the z spans inside the outline
  const xs = Array.from(new Set(fp.map((p) => p[0]))).sort((a, b) => a - b);
  const out: GroundRect[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const xa = xs[i], xb = xs[i + 1];
    const xm = (xa + xb) / 2;
    const zs: number[] = [];
    for (let a = 0, b = fp.length - 1; a < fp.length; b = a++) {
      const [x1, z1] = fp[b], [x2, z2] = fp[a];
      if (Math.abs(z1 - z2) > 1e-6) continue; // edges along X only cross a vertical line
      if ((x1 < xm) !== (x2 < xm)) zs.push(z1);
    }
    zs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < zs.length; k += 2) {
      const r: GroundRect = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
      for (const x of [xa - pad, xb + pad]) {
        for (const z of [zs[k] - pad, zs[k + 1] + pad]) {
          tmp.set(x, 0, z).applyQuaternion(piece.quaternion).add(piece.position);
          r.x0 = Math.min(r.x0, tmp.x);
          r.z0 = Math.min(r.z0, tmp.z);
          r.x1 = Math.max(r.x1, tmp.x);
          r.z1 = Math.max(r.z1, tmp.z);
        }
      }
      out.push(r);
    }
  }
  return out.length ? out : null;
}
