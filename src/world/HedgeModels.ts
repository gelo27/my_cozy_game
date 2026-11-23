import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { addCrownLeaves, type CrownLeafAnchor, type CrownLeafOptions } from './CrownLeaves';
import { bushLeaves } from './TreeModels';
import { vegetationSettings } from './VegetationSettings';
import { HEDGE_HEIGHT, HEDGE_TILE } from './Hedge';

export const HEDGE_DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
export const HEDGE_CORNERS = [[1, 1, 5], [1, -1, 9], [-1, 1, 6], [-1, -1, 10]] as const;
type Vertex = [number, number, number];

/** Clip the authored shapes to one quadrant, retaining the bevels in the GLB. */
function quadrant(mesh: THREE.Mesh): Vertex[] {
  const p = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.getIndex()!;
  const result: Vertex[] = [];
  for (let i = 0; i < index.count; i += 3) {
    let polygon: Vertex[] = [];
    for (let k = 0; k < 3; k++) {
      const v = index.getX(i + k);
      polygon.push([p.getX(v), p.getY(v), p.getZ(v)]);
    }
    for (const axis of [0, 2] as const) {
      const clipped: Vertex[] = [];
      for (let j = 0; j < polygon.length; j++) {
        const a = polygon[j], b = polygon[(j + 1) % polygon.length];
        if (a[axis] <= 0) clipped.push(a);
        if ((a[axis] < 0 && b[axis] > 0) || (a[axis] > 0 && b[axis] < 0)) {
          const t = a[axis] / (a[axis] - b[axis]);
          const v: Vertex = [THREE.MathUtils.lerp(a[0], b[0], t), THREE.MathUtils.lerp(a[1], b[1], t), THREE.MathUtils.lerp(a[2], b[2], t)];
          v[axis] = 0;
          clipped.push(v);
        }
      }
      polygon = clipped;
    }
    for (let j = 1; j + 1 < polygon.length; j++) result.push(polygon[0], polygon[j], polygon[j + 1]);
  }
  return result;
}

function findMesh(scene: THREE.Group, name: string): THREE.Mesh {
  const mesh = scene.getObjectByName(name) as THREE.Mesh | undefined;
  if (!mesh?.isMesh) throw new Error('Missing hedge section: ' + name);
  return mesh;
}

const flat: Vertex[] = [];
for (const y of [-1, 1]) {
  const a: Vertex = [0, y, 0], b: Vertex = [-1, y, 0], c: Vertex = [-1, y, -1], d: Vertex = [0, y, -1];
  flat.push(...(y > 0 ? [a, c, b, a, d, c] : [a, b, c, a, c, d]));
}

/** Match both open edges to the straight GLB profile when the diagonal tile is empty. */
function insideCorner(straight: Vertex[]): Vertex[] {
  const result: Vertex[] = [];
  for (const top of [true, false]) {
    const profile = new Map<number, number>();
    for (const [x, y, z] of straight) {
      if (x > -0.999 || (top ? y <= 0 : y >= 0)) continue;
      const edge = z < -0.999 ? -1 : z;
      const previous = profile.get(edge);
      if (previous === undefined || Math.abs(y) > Math.abs(previous)) profile.set(edge, y);
    }
    const points = [...profile].sort(([a], [b]) => b - a);
    for (let i = 1; i < points.length; i++) {
      const [z0, y0] = points[i - 1], [z1, y1] = points[i];
      const a: Vertex = [z0, y0, z0], b: Vertex = [-1, y0, z0];
      const c: Vertex = [-1, y1, z1], d: Vertex = [z1, y1, z1];
      const mirror = ([x, y, z]: Vertex): Vertex => [z, y, x];
      const strip = z1 === -1 ? [a, c, b] : [a, c, b, a, d, c];
      for (let j = 0; j < strip.length; j += 3) {
        const [a, b, c] = strip.slice(j, j + 3);
        result.push(...(top ? [a, b, c, mirror(a), mirror(c), mirror(b)] : [a, c, b, mirror(a), mirror(b), mirror(c)]));
      }
    }
  }
  return result;
}

let source: { corner: Vertex[]; straight: Vertex[]; inside: Vertex[] } | null = null;
let loading: Promise<boolean> | null = null;
const variants = new Map<number, THREE.BufferGeometry[]>();

export function loadHedgeShapes(): Promise<boolean> {
  return loading ??= new GLTFLoader().loadAsync(import.meta.env.BASE_URL + 'models/square_bush.glb')
    .then(({ scene }) => {
      const straight = quadrant(findMesh(scene, 'Cube006'));
      source = { corner: quadrant(findMesh(scene, 'Cube005')), straight, inside: insideCorner(straight) };
      return true;
    })
    .catch(error => {
      console.warn('[Hedge] Square bush model unavailable', error);
      loading = null;
      return false;
    });
}

export function hedgeLods(mask: number): THREE.BufferGeometry[] | null {
  if (!source) return null;
  const cached = variants.get(mask);
  if (cached) return cached;
  const positions: number[] = [];
  const half = HEDGE_TILE / 2;
  const axis = (v: number) => Math.abs(v) > 0.999 ? Math.sign(v) : v;
  // Each quadrant uses the GLB corner, the GLB straight profile or the flat interior.
  // Shared sides have no cap triangles. Their border vertices coincide with the next section.
  for (let i = 0; i < HEDGE_CORNERS.length; i++) {
    const [x, z] = HEDGE_CORNERS[i];
    const joinX = !!(mask & (x > 0 ? 1 : 2));
    const joinZ = !!(mask & (z > 0 ? 4 : 8));
    const swap = joinZ && !joinX;
    const inside = mask & (1 << (4 + i));
    const points = joinX && joinZ ? inside ? source.inside : flat : joinX || joinZ ? source.straight : source.corner;
    const flip = (x * z < 0) !== swap;
    for (let i = 0; i < points.length; i += 3) {
      for (const k of flip ? [0, 2, 1] : [0, 1, 2]) {
        const [px, py, pz] = points[i + k];
        positions.push(-x * half * axis(swap ? pz : px), (py + 1) * HEDGE_HEIGHT / 2, -z * half * axis(swap ? px : pz));
      }
    }
  }
  const triangles = new THREE.BufferGeometry();
  triangles.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const core = mergeVertices(triangles, 0.0001);
  triangles.dispose();
  core.computeVertexNormals();
  smoothOpenEdges(core, mask);
  core.computeBoundingSphere();
  const colors = new Float32Array(core.getAttribute('position').count * 3);
  const color = new THREE.Color(0x3f8a3a);
  for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i);
  core.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  core.addGroup(0, positions.length / 3, 0);
  const opts = bushLeaves();
  const near = vegetationSettings.bushLeaves ? addCrownLeaves(core, opts, hedgeLeafAnchors(core, mask, opts)) : core;
  const lods = [near, core];
  variants.set(mask, lods);
  return lods;
}

/** At a join both modules use the same bevel lighting. The normal has no component across the cut. */
function smoothOpenEdges(core: THREE.BufferGeometry, mask: number): void {
  const p = core.getAttribute('position');
  const normals = core.getAttribute('normal');
  const normal = new THREE.Vector3();
  const half = HEDGE_TILE / 2;
  const height = HEDGE_HEIGHT / 2;
  const atEdge = (value: number) => Math.abs(Math.abs(value) - half) < 0.0001;
  // The straight GLB section's bevel starts at 55% of the half extent on each axis.
  const profile = (unit: number, extent: number) =>
    Math.sign(unit) * Math.max(0, Math.abs(unit) - 0.55) / extent;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i) - height, z = p.getZ(i);
    const openX = atEdge(x) && (mask & (x > 0 ? 1 : 2));
    const openZ = atEdge(z) && (mask & (z > 0 ? 4 : 8));
    if (!openX && !openZ) continue;
    normal.set(openX ? 0 : profile(x / half, half), profile(y / height, height), openZ ? 0 : profile(z / half, half));
    if (normal.lengthSq() > 0) {
      normal.normalize();
      normals.setXYZ(i, normal.x, normal.y, normal.z);
    }
  }
}

/** A staggered grid wraps at the tile borders. Project it onto the exposed GLB surfaces. */
function hedgeLeafAnchors(core: THREE.BufferGeometry, mask: number, opts: CrownLeafOptions): CrownLeafAnchor[] {
  const anchors: CrownLeafAnchor[] = [];
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(core, material);
  const ray = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const half = HEDGE_TILE / 2;
  const columns = Math.max(1, Math.min(
    Math.round(HEDGE_TILE / opts.spacing),
    Math.floor(Math.sqrt(opts.count / (1 + 4 * HEDGE_HEIGHT / HEDGE_TILE)))
  ));
  const rows = Math.max(1, Math.floor(columns * HEDGE_HEIGHT / HEDGE_TILE));
  const step = HEDGE_TILE / columns;
  const noise = (seed: number) => ((Math.imul(seed ^ (seed >>> 13), 0x5bd1e995) >>> 0) / 4294967296);
  for (let face = 0; face <= HEDGE_DIRECTIONS.length; face++) {
    const top = face === 0;
    if (!top && (mask & (1 << (face - 1)))) continue;
    const [x, z] = top ? [0, 0] : HEDGE_DIRECTIONS[face - 1];
    const count = top ? columns : rows;
    direction.set(-x, top ? -1 : 0, -z);
    // Skip the bottom side row while keeping the other leaves at their original heights.
    for (let row = top ? 0 : 1; row < count; row++) {
      for (let col = 0; col < columns; col++) {
        const seed = opts.seed + (row + 1) * 181 + (col + 1) * 9277 + face * 1013;
        const u = (col + (row % 2 ? 0.69 : 0.31) + (noise(seed) - 0.5) * 0.22) * step - half;
        const v = (row + 0.5 + (noise(seed + 71) - 0.5) * 0.22) / count;
        if (top) origin.set(u, HEDGE_HEIGHT + 1, v * HEDGE_TILE - half);
        else origin.set(x * (half + 1) + Math.abs(z) * u, v * HEDGE_HEIGHT, z * (half + 1) + Math.abs(x) * u);
        ray.set(origin, direction);
        const hit = ray.intersectObject(mesh, false)[0];
        // Let the most directly facing projection cover each part of the bevel.
        const n = hit?.face?.normal;
        if (!n || !hit.normal) continue;
        const facing = -n.dot(direction);
        if (facing + 0.0001 < Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z))) continue;
        const { x: px, z: pz } = hit.point;
        // On a joined side, the foliage follows the hedge's centreline through the seam.
        const outward = new THREE.Vector3(
          mask & (px > 0 ? 1 : 2) ? 0 : px,
          0,
          mask & (pz > 0 ? 4 : 8) ? 0 : pz,
        );
        anchors.push({ position: hit.point, normal: hit.normal.normalize(), outward, seed });
      }
    }
  }
  material.dispose();
  return anchors;
}

export function resetHedgeLeaves(): void {
  for (const lods of variants.values()) for (const geometry of new Set(lods)) geometry.dispose();
  variants.clear();
}
