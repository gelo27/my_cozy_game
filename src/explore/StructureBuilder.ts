import * as THREE from 'three';
import type { FootSurface } from '../audio/Footsteps';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PhysicsWorld } from '../physics/PhysicsWorld';

/** Shared low-poly palette for landmarks; one material per colour keeps the draw calls few. */
export const STRUCTURE_MATERIALS = {
  stone: new THREE.MeshLambertMaterial({ color: 0xa8a294, flatShading: true }),
  darkStone: new THREE.MeshLambertMaterial({ color: 0x77736a, flatShading: true }),
  moss: new THREE.MeshLambertMaterial({ color: 0x6f8f4a, flatShading: true }),
  wood: new THREE.MeshLambertMaterial({ color: 0x8a6142 }),
  darkWood: new THREE.MeshLambertMaterial({ color: 0x5a3e2b }),
  roof: new THREE.MeshLambertMaterial({ color: 0x7a4b3a }),
  white: new THREE.MeshLambertMaterial({ color: 0xf2efe8 }),
  red: new THREE.MeshLambertMaterial({ color: 0xc8443b }),
  metal: new THREE.MeshLambertMaterial({ color: 0x3c4148 }),
  gold: new THREE.MeshLambertMaterial({ color: 0xe8b84a, emissive: 0x2a1c00 }),
  glass: new THREE.MeshLambertMaterial({ color: 0xfff1b8, emissive: 0x5a4a10 }),
  void: new THREE.MeshBasicMaterial({ color: 0x050608, fog: false }),
  crystal: new THREE.MeshBasicMaterial({ color: 0x6fd8ff }),
} as const;

export type StructureMaterial = keyof typeof STRUCTURE_MATERIALS;

/**
 * Collects geometry in a landmark's local space (forward = +Z), then merges it per material and
 * places it in the world with one transform. Box and cylinder colliders follow the same transform.
 */
export class StructureBuilder {
  /** What its walkable colliders sound like underfoot (tagged on each collider's userData). */
  public surface: FootSurface = 'stone';
  private readonly parts = new Map<StructureMaterial, THREE.BufferGeometry[]>();
  private readonly colliders: (
    | { kind: 'box'; pos: THREE.Vector3; size: THREE.Vector3; rotY: number }
    | { kind: 'cyl'; pos: THREE.Vector3; radius: number; height: number }
  )[] = [];

  add(mat: StructureMaterial, geo: THREE.BufferGeometry): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    // Merging needs the same attribute set everywhere
    g.deleteAttribute('uv');
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat)!.push(g);
    return this;
  }

  box(mat: StructureMaterial, w: number, h: number, d: number, x: number, y: number, z: number, rotY = 0, rotX = 0, rotZ = 0): this {
    const g = new THREE.BoxGeometry(w, h, d);
    g.rotateZ(rotZ);
    g.rotateX(rotX);
    g.rotateY(rotY);
    g.translate(x, y, z);
    return this.add(mat, g);
  }

  cylinder(mat: StructureMaterial, rTop: number, rBottom: number, h: number, x: number, y: number, z: number, segments = 10, rotZ = 0, rotY = 0): this {
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, segments);
    g.rotateZ(rotZ);
    g.rotateY(rotY);
    g.translate(x, y, z);
    return this.add(mat, g);
  }

  /** Jittered low-poly boulder. */
  rock(mat: StructureMaterial, sx: number, sy: number, sz: number, x: number, y: number, z: number, seed: number): this {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const n = 0.85 + 0.3 * Math.abs(Math.sin(p.getX(i) * 3.1 + seed) * Math.cos(p.getZ(i) * 2.7 - seed * 1.3));
      p.setXYZ(i, p.getX(i) * n * sx, p.getY(i) * n * sy, p.getZ(i) * n * sz);
    }
    g.rotateY(seed * 1.7);
    g.translate(x, y, z);
    return this.add(mat, g);
  }

  colliderBox(w: number, h: number, d: number, x: number, y: number, z: number, rotY = 0): this {
    this.colliders.push({ kind: 'box', pos: new THREE.Vector3(x, y, z), size: new THREE.Vector3(w, h, d), rotY });
    return this;
  }

  colliderCylinder(radius: number, height: number, x: number, y: number, z: number): this {
    this.colliders.push({ kind: 'cyl', pos: new THREE.Vector3(x, y, z), radius, height });
    return this;
  }

  /** Merges into `parent` at (origin, yaw) and creates the colliders. */
  build(parent: THREE.Object3D, physics: PhysicsWorld, origin: THREE.Vector3, yaw: number, name: string): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    group.position.copy(origin);
    group.rotation.y = yaw;
    for (const [mat, geos] of this.parts) {
      const merged = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      merged.computeVertexNormals();
      const mesh = new THREE.Mesh(merged, STRUCTURE_MATERIALS[mat]);
      mesh.name = `${name}_${mat}`;
      group.add(mesh);
    }
    parent.add(group);

    const rot = new THREE.Euler(0, yaw, 0);
    const world = new THREE.Vector3();
    for (const c of this.colliders) {
      world.copy(c.pos).applyEuler(rot).add(origin);
      const res = c.kind === 'box'
        ? physics.createStaticBox(world, c.size, new THREE.Euler(0, yaw + c.rotY, 0))
        : physics.createStaticCylinder(world, c.radius, c.height);
      (res.collider as unknown as { userData: unknown }).userData = { surface: this.surface };
    }
    return group;
  }
}

/** Local (site space) point to world, for anchors like chests and doors. */
export function siteToWorld(origin: THREE.Vector3, yaw: number, x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return out.set(origin.x + x * c + z * s, origin.y + y, origin.z - x * s + z * c);
}
