import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ParticleManager } from '../particles/ParticleManager';

export type ForageKind = 'shell' | 'sand' | 'mushroom';

export interface ForageNode {
  kind: ForageKind;
  position: THREE.Vector3;
  index: number;
  taken: boolean;
  regrowAt: number;
  yaw: number;
}

const REGROW_SECONDS: Record<ForageKind, number> = { shell: 240, sand: 150, mushroom: 300 };
const MAX_PER_KIND = 160;

/**
 * Things picked up by hand with E: seashells and sand mounds along the beaches, glowing mushrooms in
 * caves. Each kind is one InstancedMesh; a picked node shrinks to nothing and regrows later.
 */
export class ForageField {
  public readonly nodes: ForageNode[] = [];
  private readonly meshes: Record<ForageKind, THREE.InstancedMesh>;
  private readonly counts: Record<ForageKind, number> = { shell: 0, sand: 0, mushroom: 0 };
  private elapsed = 0;
  private static readonly _m = new THREE.Matrix4();
  private static readonly _q = new THREE.Quaternion();
  private static readonly _s = new THREE.Vector3();
  private static readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene, private readonly particles: ParticleManager | null) {
    // Seashell: a ribbed fan
    const shell = new THREE.SphereGeometry(0.16, 8, 4, 0, Math.PI, 0, Math.PI / 2);
    shell.scale(1, 0.5, 1.1);
    shell.rotateY(Math.PI / 2);
    // Sand: a soft mound
    const sand = new THREE.SphereGeometry(0.45, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    sand.scale(1, 0.4, 0.85);
    // Mushroom cluster: three stems with glowing caps (vertex colours tell stem from cap)
    const parts: THREE.BufferGeometry[] = [];
    const stemColor = new THREE.Color(0xdfe8f0), capColor = new THREE.Color(0x5fd8ff);
    for (const [x, z, s] of [[0, 0, 1], [0.16, 0.1, 0.7], [-0.12, 0.14, 0.55]]) {
      const stem = new THREE.CylinderGeometry(0.035 * s, 0.05 * s, 0.26 * s, 6).translate(x, 0.13 * s, z);
      const cap = new THREE.SphereGeometry(0.12 * s, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(x, 0.24 * s, z);
      for (const [g, c] of [[stem, stemColor], [cap, capColor]] as const) {
        const ng = g.toNonIndexed();
        ng.deleteAttribute('uv');
        const col = new Float32Array(ng.attributes.position.count * 3);
        for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
        ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
        parts.push(ng);
      }
    }
    const mushroom = mergeGeometries(parts)!;

    const make = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string) => {
      const mesh = new THREE.InstancedMesh(geo, mat, MAX_PER_KIND);
      mesh.name = name;
      mesh.count = 0;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    };
    this.meshes = {
      shell: make(shell, new THREE.MeshLambertMaterial({ color: 0xf6d2c4, emissive: 0x2a1a14 }), 'ForageShells'),
      sand: make(sand, new THREE.MeshLambertMaterial({ color: 0xe9d8a6 }), 'ForageSand'),
      mushroom: make(mushroom, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0c3a52 }), 'ForageMushrooms'),
    };
  }

  public add(kind: ForageKind, position: THREE.Vector3, yaw = Math.random() * Math.PI * 2): void {
    if (this.counts[kind] >= MAX_PER_KIND) return;
    const node: ForageNode = { kind, position: position.clone(), index: this.counts[kind]++, taken: false, regrowAt: 0, yaw };
    this.nodes.push(node);
    this.meshes[kind].count = this.counts[kind];
    this.writeMatrix(node, 1);
  }

  public findNearest(pos: THREE.Vector3, reach = 1.7): ForageNode | null {
    let best: ForageNode | null = null;
    let bestD = reach * reach;
    for (const n of this.nodes) {
      if (n.taken || Math.abs(n.position.y - pos.y) > 2.2) continue;
      const d = (n.position.x - pos.x) ** 2 + (n.position.z - pos.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /** Picks a node up and returns what it gave. */
  public take(node: ForageNode): { itemId: string; amount: number }[] {
    if (node.taken) return [];
    node.taken = true;
    node.regrowAt = this.elapsed + REGROW_SECONDS[node.kind];
    this.writeMatrix(node, 0);
    this.particles?.emitBuildPuff(node.position.clone().setY(node.position.y + 0.15), node.kind !== 'sand', 10);
    if (node.kind === 'shell') return Math.random() < 0.05 ? [{ itemId: 'shell', amount: 1 }, { itemId: 'pearl', amount: 1 }] : [{ itemId: 'shell', amount: 1 }];
    if (node.kind === 'sand') return [{ itemId: 'sand', amount: 2 + Math.floor(Math.random() * 3) }];
    return [{ itemId: 'cave_mushroom', amount: 1 + (Math.random() < 0.35 ? 1 : 0) }];
  }

  public update(dt: number): void {
    this.elapsed += dt;
    for (const n of this.nodes) {
      if (n.taken && this.elapsed >= n.regrowAt) {
        n.taken = false;
        this.writeMatrix(n, 1);
      }
    }
  }

  private writeMatrix(node: ForageNode, scale: number): void {
    const m = ForageField._m.compose(
      node.position,
      ForageField._q.setFromAxisAngle(ForageField._up, node.yaw),
      ForageField._s.setScalar(scale * (node.kind === 'sand' ? 1 : 1.2))
    );
    const mesh = this.meshes[node.kind];
    mesh.setMatrixAt(node.index, m);
    mesh.instanceMatrix.needsUpdate = true;
  }
}
