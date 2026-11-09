import * as THREE from 'three';
import type { CropType } from './types/FarmingTypes';

/** Seconds one crate takes to reach the player, and the gap between crates leaving. */
const FLIGHT = 0.75;
const STAGGER = 0.1;

/** Produce colour on top of each crop's crate. */
const PRODUCE_COLOR: Record<CropType, number> = {
  wheat: 0xe8c45a,
  carrot: 0xf28a2e,
  tomato: 0xe0402f,
  strawberry: 0xe8334f,
  cabbage: 0x8fd16a,
  corn: 0xf5d33f,
  sunflower: 0xf2b51f,
  eggplant: 0x7b3fa0,
  pumpkin: 0xf0952a,
};

const CRATE_GEOMETRY = new THREE.BoxGeometry(0.42, 0.28, 0.32);
const PRODUCE_GEOMETRY = new THREE.SphereGeometry(0.17, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.15, 0.6, 0.9);
const SACK_GEOMETRY = new THREE.SphereGeometry(0.15, 10, 8).scale(1, 1.15, 1);
const CRATE_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xb07a45 });
const SACK_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xc9a46c });
const produceMaterials = new Map<CropType, THREE.MeshLambertMaterial>();

function produceMaterial(type: CropType): THREE.MeshLambertMaterial {
  let m = produceMaterials.get(type);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color: PRODUCE_COLOR[type] });
    produceMaterials.set(type, m);
  }
  return m;
}

export interface FlightItem {
  /** Inventory item given when this piece lands. */
  itemId: string;
  amount: number;
  /** What flies: a crate of produce or a small seed sack. */
  look: 'crate' | 'seeds';
  cropType: CropType;
}

interface Flying {
  mesh: THREE.Object3D;
  from: THREE.Vector3;
  t: number;
  spin: THREE.Vector3;
  items: FlightItem[];
  give: (itemId: string, amount: number) => void;
}

/** Harvested crates (and seed sacks) fly along an arc into the player, like logs from a felled tree. */
export class HarvestFlight {
  private readonly group = new THREE.Group();
  private readonly flying: Flying[] = [];
  private static readonly _v = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.group.name = 'HarvestFlights';
    scene.add(this.group);
  }

  private buildMesh(item: FlightItem): THREE.Object3D {
    if (item.look === 'seeds') return new THREE.Mesh(SACK_GEOMETRY, SACK_MATERIAL);
    const crate = new THREE.Group();
    crate.add(new THREE.Mesh(CRATE_GEOMETRY, CRATE_MATERIAL));
    const produce = new THREE.Mesh(PRODUCE_GEOMETRY, produceMaterial(item.cropType));
    produce.position.y = 0.13;
    crate.add(produce);
    return crate;
  }

  /**
   * Launches one piece per entry from around `center` (a field `spread` m wide). Each piece's items
   * are handed to `give` as it lands; `extra` items ride along with the last piece.
   */
  public launch(
    center: THREE.Vector3,
    spread: number,
    pieces: FlightItem[],
    give: (itemId: string, amount: number) => void,
    extra: FlightItem[] = []
  ): void {
    pieces.forEach((piece, i) => {
      const mesh = this.buildMesh(piece);
      const from = new THREE.Vector3(
        center.x + (Math.random() - 0.5) * spread,
        center.y + 0.35,
        center.z + (Math.random() - 0.5) * spread
      );
      mesh.position.copy(from);
      mesh.rotation.set(Math.random() * 0.6, Math.random() * Math.PI * 2, Math.random() * 0.6);
      mesh.scale.setScalar(0.4);
      this.group.add(mesh);
      this.flying.push({
        mesh,
        from,
        t: -i * STAGGER,
        spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(9),
        items: i === pieces.length - 1 ? [piece, ...extra] : [piece],
        give,
      });
    });
  }

  /** Pieces home in on the player (following them as they move), spinning, and shrink as they land. */
  public update(dt: number, collector: THREE.Vector3 | null): void {
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i];
      f.t += dt;
      if (f.t < 0) continue;
      const k = Math.min(1, f.t / FLIGHT);
      const e = k * k * (3 - 2 * k);
      const to = collector ?? f.from;
      const target = HarvestFlight._v.copy(to).setY(to.y + 0.9);
      const dist = f.from.distanceTo(target);
      f.mesh.position.lerpVectors(f.from, target, e);
      f.mesh.position.y += Math.sin(Math.PI * k) * (1.1 + dist * 0.25);
      f.mesh.rotation.x += f.spin.x * dt;
      f.mesh.rotation.y += f.spin.y * dt;
      f.mesh.rotation.z += f.spin.z * dt;
      f.mesh.scale.setScalar(k > 0.85 ? 1 - ((k - 0.85) / 0.15) * 0.7 : Math.min(1, 0.4 + f.t * 4));
      if (k >= 1) {
        f.mesh.removeFromParent();
        this.flying.splice(i, 1);
        for (const it of f.items) if (it.amount > 0) f.give(it.itemId, it.amount);
      }
    }
  }
}
