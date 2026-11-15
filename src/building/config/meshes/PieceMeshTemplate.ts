import * as THREE from 'three';

export interface PieceMeshTemplate {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  boundingBox: THREE.Box3;
}
