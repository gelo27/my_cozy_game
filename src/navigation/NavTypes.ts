import * as THREE from 'three';

export interface NavAABB {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface NavPortal {
  fromPolyId: number;
  toPolyId: number;
  left: THREE.Vector3;    // Left boundary vertex from perspective of traveling fromPoly -> toPoly
  right: THREE.Vector3;   // Right boundary vertex
  midpoint: THREE.Vector3;
  width: number;
  cost: number;
}

export interface NavPolygon {
  id: number;
  vertices: THREE.Vector3[];
  centroid: THREE.Vector3;
  normal: THREE.Vector3;
  planeD: number;         // ax + by + cz + planeD = 0
  aabb: NavAABB;
  portals: NavPortal[];
}

export interface PathfindingResult {
  path: THREE.Vector3[];
  success: boolean;
  corridorPolygons: number[];
}
