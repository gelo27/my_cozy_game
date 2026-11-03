import * as THREE from 'three';
import type { SampledRiver } from './RiverTypes';

/** Vertices across the ribbon. Rivers are flat across, so a few are plenty. */
const ACROSS = 5;
/** The ribbon reaches this far past the channel edge, under the banks, so no gap shows. */
const OVERLAP = 0.6;

/**
 * Water ribbon along a river's samples: flat across the channel at the surface height, following
 * every drop (a waterfall is just a steep stretch of the same ribbon).
 * Attributes: `uv` = (metres across from the centre, metres along from the source) for flow
 * scrolling; `aRiver` = (foam, alpha, 0..1 across) for white water, fades and bank foam.
 */
export function buildRiverGeometry(river: SampledRiver): THREE.BufferGeometry | null {
  const S = river.samples;
  if (S.length < 2) return null;
  const count = S.length * ACROSS;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const attr = new Float32Array(count * 3);
  let v = 0;
  for (let k = 0; k < S.length; k++) {
    const q = S[k];
    // Left of the flow direction
    const nx = -q.tz, nz = q.tx;
    const half = q.hw + OVERLAP;
    for (let c = 0; c < ACROSS; c++) {
      const u = (c / (ACROSS - 1)) * 2 - 1;
      pos[v * 3] = q.x + nx * u * half;
      pos[v * 3 + 1] = q.s;
      pos[v * 3 + 2] = q.z + nz * u * half;
      uv[v * 2] = u * half;
      uv[v * 2 + 1] = q.dist;
      attr[v * 3] = q.foam;
      attr[v * 3 + 1] = q.alpha;
      attr[v * 3 + 2] = Math.abs(u) * (half / Math.max(0.3, q.hw));
      v++;
    }
  }
  const index: number[] = [];
  for (let k = 0; k < S.length - 1; k++) {
    for (let c = 0; c < ACROSS - 1; c++) {
      const a = k * ACROSS + c;
      const b = a + ACROSS;
      // Counter-clockwise seen from above (normals up)
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aRiver', new THREE.BufferAttribute(attr, 3));
  geo.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}
