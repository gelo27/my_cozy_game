import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { injectNightLights } from '../world/NightLighting';
import { injectWaterline } from './WaterDetails';

/**
 * Draw-call saver for small hand-built models (vehicles): the plain-coloured meshes directly under
 * one parent that never move relative to each other become ONE mesh. Each part's colour (and
 * emissive glow) is baked into its vertices, so a single shared material draws them all.
 *
 * Left as they are: meshes with a texture, transparency or a double-sided material, meshes with
 * children, and meshes whose material changes at run time (pass those in `dynamic`, e.g. brake
 * lights). Unlit MeshBasic parts (lamp glass) become fully emissive, so they look the same.
 */

/** One material for every merged model: Lambert with per-vertex colour and glow. */
const SHARED = (() => {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.customProgramCacheKey = () => 'merged-colored';
  mat.onBeforeCompile = (shader) => {
    injectNightLights(shader);
    injectWaterline(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aEmissive;\nvarying vec3 vEmissive;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmissive = aEmissive;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEmissive;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmissive;');
  };
  return mat;
})();

type Colored = THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;

function mergeable(o: THREE.Object3D, dynamic: ReadonlySet<THREE.Material>): o is THREE.Mesh<THREE.BufferGeometry, Colored> {
  if (!(o as THREE.Mesh).isMesh || o.children.length || (o as THREE.InstancedMesh).isInstancedMesh) return false;
  const m = (o as THREE.Mesh).material;
  if (Array.isArray(m) || dynamic.has(m)) return false;
  const c = m as Colored & { isMeshLambertMaterial?: boolean; isMeshBasicMaterial?: boolean };
  if (!c.isMeshLambertMaterial && !c.isMeshBasicMaterial) return false;
  return !c.map && !c.transparent && c.side === THREE.FrontSide && c.visible;
}

/** Merges the qualifying children of `parent` (2 or more) into one mesh; returns how many were merged. */
export function mergeColoredChildren(parent: THREE.Object3D, dynamic: ReadonlySet<THREE.Material> = new Set()): number {
  const meshes = parent.children.filter((o) => mergeable(o, dynamic));
  if (meshes.length < 2) return 0;
  const parts: THREE.BufferGeometry[] = [];
  for (const mesh of meshes) {
    mesh.updateMatrix();
    const src = mesh.geometry;
    const g = (src.index ? src.toNonIndexed() : src.clone()).applyMatrix4(mesh.matrix);
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const mat = mesh.material;
    const basic = (mat as THREE.MeshBasicMaterial).isMeshBasicMaterial;
    // Unlit parts: no diffuse, all of their colour as glow
    const diffuse = basic ? new THREE.Color(0, 0, 0) : mat.color;
    const glow = basic ? mat.color : (mat as THREE.MeshLambertMaterial).emissive.clone().multiplyScalar((mat as THREE.MeshLambertMaterial).emissiveIntensity);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    const emi = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = diffuse.r;
      col[i * 3 + 1] = diffuse.g;
      col[i * 3 + 2] = diffuse.b;
      emi[i * 3] = glow.r;
      emi[i * 3 + 1] = glow.g;
      emi[i * 3 + 2] = glow.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aEmissive', new THREE.BufferAttribute(emi, 3));
    parts.push(g);
  }
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  if (!merged) return 0;
  const mesh = new THREE.Mesh(merged, SHARED);
  mesh.name = `${parent.name || 'part'}_merged`;
  mesh.castShadow = meshes.some((m) => m.castShadow);
  mesh.receiveShadow = meshes.some((m) => m.receiveShadow);
  for (const m of meshes) parent.remove(m);
  parent.add(mesh);
  return meshes.length;
}

/** Same as mergeColoredChildren for several parents at once. */
export function mergeColoredGroups(parents: THREE.Object3D[], dynamic: ReadonlySet<THREE.Material> = new Set()): void {
  for (const p of parents) mergeColoredChildren(p, dynamic);
}
