import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { withVertexLightingQuality } from './VertexLightingQuality';

export const COUCH_GRASS_MATERIAL = withVertexLightingQuality(new THREE.MeshLambertMaterial({
  color: 0x709448,
  vertexColors: true,
  side: THREE.DoubleSide,
}));

let loading: Promise<THREE.BufferGeometry | null> | undefined;

/** Keep the authored scale and vertex colours, with a centred pivot at ground level. */
export function loadCouchGrassModel(): Promise<THREE.BufferGeometry | null> {
  return loading ??= new GLTFLoader()
    .loadAsync(`${import.meta.env.BASE_URL}models/couch_grass.glb`)
    .then(({ scene }) => {
      const mesh = scene.children.find((object): object is THREE.Mesh => (object as THREE.Mesh).isMesh);
      if (!mesh) throw new Error('couch_grass.glb has no mesh');
      mesh.updateWorldMatrix(true, false);

      const geometry = mesh.geometry.applyMatrix4(mesh.matrixWorld);
      geometry.deleteAttribute('uv');
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox!;
      const center = bounds.getCenter(new THREE.Vector3());
      geometry.translate(-center.x, -bounds.min.y, -center.z);
      geometry.clearGroups();
      geometry.addGroup(0, geometry.index?.count ?? geometry.getAttribute('position').count, 0);
      geometry.computeBoundingSphere();
      return geometry;
    })
    .catch((error) => {
      console.warn('[Couch grass] Could not load couch_grass.glb', error);
      return null;
    });
}
