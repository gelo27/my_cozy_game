import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Hand tools with a model of their own (both share one handle in the source file). */
export type ToolModelId = 'axe' | 'pickaxe';

const TOOL_URLS: Record<ToolModelId, string> = {
  axe: `${import.meta.env.BASE_URL}models/axe.glb`,
  pickaxe: `${import.meta.env.BASE_URL}models/pickaxe.glb`,
};

/** Metres per model unit: the axe (30.8 units nose to handle end) comes out 0.8 m long. */
const TOOL_SCALE = 0.8 / 30.8;
/**
 * Where the fist closes on the handle, in the models' own units: a bit past the middle of the bare
 * handle, leaving a good stub behind the fist (the models run along Z, head at -Z, handle end at
 * +Z ≈ 17.3; the handle's core is at x ≈ 2.3).
 */
const GRIP_POINT = new THREE.Vector3(2.3, 0, 10.5);
/**
 * Model axes in the weapon pivot's frame (on the hand: +X is forward with the arm hanging,
 * +Y runs down the arm, +Z across): the handle (-Z) sticks out forward from the fist, the axe's
 * blade and the pickaxe's shorter pick (-X) face down, the head's flat (+Y) faces sideways.
 */
const GRIP_BASIS = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(-1, 0, 0)
);

const templates = new Map<ToolModelId, THREE.Object3D>();
const loading = new Map<ToolModelId, Promise<THREE.Object3D | null>>();
let toolMat: THREE.MeshLambertMaterial | null = null;

export function loadToolModel(id: ToolModelId): Promise<THREE.Object3D | null> {
  const pending = loading.get(id);
  if (pending) return pending;
  const url = TOOL_URLS[id];
  const p = new GLTFLoader()
    .loadAsync(url)
    .then((gltf) => {
      toolMat ??= new THREE.MeshLambertMaterial({ vertexColors: true });
      const model = new THREE.Group();
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        // Grip point to the origin, then turn and size it for the hand
        geo.translate(-GRIP_POINT.x, -GRIP_POINT.y, -GRIP_POINT.z);
        geo.applyMatrix4(GRIP_BASIS);
        geo.scale(TOOL_SCALE, TOOL_SCALE, TOOL_SCALE);
        geo.computeBoundingSphere();
        const m = new THREE.Mesh(geo, toolMat);
        m.castShadow = false;
        m.receiveShadow = false;
        model.add(m);
      });
      templates.set(id, model);
      return model;
    })
    .catch((err) => {
      console.warn(`[Tools] ${url} failed to load, using the built-in ${id}:`, err);
      return null;
    });
  loading.set(id, p);
  return p;
}

/**
 * A new tool for the hand (shares the geometry and material), or null until its model has loaded.
 * Its origin is the grip; turning it about Z tips the head down along the arm.
 */
export function createTool(id: ToolModelId): THREE.Object3D | null {
  return templates.get(id)?.clone() ?? null;
}

loadToolModel('axe');
loadToolModel('pickaxe');
