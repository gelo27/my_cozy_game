import * as THREE from 'three';
import { createGlassMaterial } from '../scene/GlassMatcap';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createPromptSprite } from './VehicleModel';

/** Hull size in model space (forward = +Z, origin on the waterline at mid-ship). */
export const BOAT_HALF_LENGTH = 2.15;
export const BOAT_HALF_WIDTH = 0.86;

type Bucket = 'hull' | 'stripe' | 'deck' | 'trim' | 'seat' | 'glass';

/**
 * Small open motorboat: lofted V-hull with flared topsides, a wooden floor, two bench seats,
 * a centre console with windscreen and an outboard motor that turns with the tiller.
 * Fixed parts merge into one mesh per material (≈6 draw calls) plus the motor (2).
 */
export class BoatModel {
  public readonly group = new THREE.Group();
  /** Rocks and pitches on the water; the rider and motor sit inside it. */
  public readonly hull = new THREE.Group();
  /** Where the rider's model origin goes (character origin is 0.75 m above its feet). */
  public readonly seatAnchor = new THREE.Object3D();
  private readonly motor = new THREE.Group();
  private readonly prop = new THREE.Group();
  private readonly promptSprite: THREE.Sprite;
  private readonly navLight: THREE.MeshBasicMaterial;

  constructor(color = 0x2f6f9f) {
    this.group.name = 'Boat';
    const mats: Record<Bucket, THREE.Material> = {
      hull: new THREE.MeshLambertMaterial({ color: 0xf4f1ea, flatShading: true, side: THREE.DoubleSide }),
      stripe: new THREE.MeshLambertMaterial({ color, flatShading: true, side: THREE.DoubleSide }),
      deck: new THREE.MeshLambertMaterial({ color: 0xa8774c }),
      trim: new THREE.MeshLambertMaterial({ color: 0x30343a }),
      seat: new THREE.MeshLambertMaterial({ color: 0xe9e1cf }),
      glass: createGlassMaterial({ color: 0xb4dcec, opacity: 0.4 }),
    };
    this.navLight = new THREE.MeshBasicMaterial({ color: 0x9cff9c });
    const parts: Record<Bucket, THREE.BufferGeometry[]> = { hull: [], stripe: [], deck: [], trim: [], seat: [], glass: [] };

    // Lofted hull: stations along Z, each a V section; the bow pinches to a point
    const stations = 9;
    const section = (t: number) => {
      // t: 0 = stern, 1 = bow
      const z = -BOAT_HALF_LENGTH + t * BOAT_HALF_LENGTH * 2;
      const bowT = Math.max(0, (t - 0.55) / 0.45);
      const w = BOAT_HALF_WIDTH * (1 - bowT * bowT * 0.97) * (t < 0.08 ? 0.92 : 1);
      const keel = -0.32 + bowT * 0.14; // the forefoot rises toward the bow
      const sheer = 0.42 + bowT * bowT * 0.22; // the bow lifts
      return [
        new THREE.Vector3(-w, sheer, z),
        new THREE.Vector3(-w * 0.9, -0.02, z),
        new THREE.Vector3(0, keel, z),
        new THREE.Vector3(w * 0.9, -0.02, z),
        new THREE.Vector3(w, sheer, z),
      ];
    };
    const outer: number[] = [];
    const stripe: number[] = [];
    const tri = (arr: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => arr.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    let prev = section(0);
    for (let s = 1; s <= stations; s++) {
      const cur = section(s / stations);
      for (let k = 0; k < 4; k++) {
        // Upper panels carry the painted stripe, the bottom stays white
        const arr = k === 0 || k === 3 ? stripe : outer;
        const [a, b2, c, d] = [prev[k], prev[k + 1], cur[k + 1], cur[k]];
        // Outward winding: left side and right side mirror each other
        if (k < 2) {
          tri(arr, a, c, b2);
          tri(arr, a, d, c);
        } else {
          tri(arr, a, b2, c);
          tri(arr, a, c, d);
        }
      }
      prev = cur;
    }
    // Transom (flat stern)
    const st = section(0);
    tri(outer, st[0], st[1], st[4]);
    tri(outer, st[1], st[3], st[4]);
    tri(outer, st[1], st[2], st[3]);
    const hullGeo = (pos: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      return g;
    };
    parts.hull.push(hullGeo(outer));
    parts.stripe.push(hullGeo(stripe));
    // Gunwale rails, floor, seats, console
    parts.trim.push(box(0.06, 0.06, BOAT_HALF_LENGTH * 1.55, -BOAT_HALF_WIDTH + 0.02, 0.45, -0.25));
    parts.trim.push(box(0.06, 0.06, BOAT_HALF_LENGTH * 1.55, BOAT_HALF_WIDTH - 0.02, 0.45, -0.25));
    parts.deck.push(box(BOAT_HALF_WIDTH * 1.5, 0.05, BOAT_HALF_LENGTH * 1.55, 0, 0.02, -0.2));
    parts.seat.push(box(BOAT_HALF_WIDTH * 1.7, 0.1, 0.42, 0, 0.3, -1.25));
    parts.seat.push(box(BOAT_HALF_WIDTH * 1.65, 0.1, 0.36, 0, 0.3, 0.75));
    parts.deck.push(box(0.5, 0.3, 0.42, 0, 0.12, -1.25));
    parts.stripe.push(box(0.52, 0.62, 0.42, 0.2, 0.33, -0.1)); // console
    parts.trim.push(box(0.42, 0.06, 0.3, 0.2, 0.66, -0.05));
    const wheel = new THREE.TorusGeometry(0.11, 0.022, 5, 10);
    wheel.rotateX(-0.9);
    wheel.translate(0.2, 0.72, -0.28);
    parts.trim.push(wheel);
    const screen = new THREE.PlaneGeometry(0.6, 0.32);
    screen.rotateX(-0.45);
    screen.translate(0.2, 0.82, 0.06);
    parts.glass.push(screen);
    // Bow cleat and fender bumpers along the sides
    parts.trim.push(box(0.16, 0.04, 0.05, 0, 0.66, BOAT_HALF_LENGTH - 0.12));
    for (const x of [-1, 1]) {
      for (const z of [-0.8, 0.5]) {
        const f = new THREE.CylinderGeometry(0.07, 0.07, 0.28, 6);
        f.translate(x * (BOAT_HALF_WIDTH + 0.05), 0.2, z);
        parts.seat.push(f);
      }
    }

    for (const key of Object.keys(parts) as Bucket[]) {
      const geos = parts[key].map((g) => (g.index ? g.toNonIndexed() : g));
      for (const g of geos) {
        g.deleteAttribute('uv');
        if (!g.attributes.normal) g.computeVertexNormals();
      }
      const merged = mergeGeometries(geos)!;
      geos.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(merged, mats[key]);
      if (key === 'glass') mesh.renderOrder = 2;
      this.hull.add(mesh);
    }

    // Outboard motor on the transom, pivots for steering
    const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.38, 0.36), mats.trim);
    cowl.position.set(0, 0.62, -0.2);
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.7, 0.12), mats.trim);
    shaft.position.set(0, 0.15, -0.16);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.08, 0.37), mats.stripe);
    cap.position.set(0, 0.84, -0.2);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 0.05), mats.trim);
    this.prop.add(blade);
    this.prop.position.set(0, -0.18, -0.24);
    this.motor.add(cowl, shaft, cap, this.prop);
    this.motor.position.set(0, 0, -BOAT_HALF_LENGTH + 0.02);
    this.hull.add(this.motor);
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 4), this.navLight);
    light.position.set(0, 0.72, BOAT_HALF_LENGTH - 0.05);
    this.hull.add(light);

    // Driver sits on the rear bench, a little off-centre toward the console
    this.seatAnchor.position.set(0.15, 0.36 + 0.75 - 0.42, -1.2);
    this.hull.add(this.seatAnchor);
    this.group.add(this.hull);

    this.promptSprite = createPromptSprite();
    this.promptSprite.position.set(0, 2.0, 0);
    this.promptSprite.visible = false;
    this.group.add(this.promptSprite);
  }

  public setPromptVisible(visible: boolean): void {
    this.promptSprite.visible = visible;
  }

  /** Tiller angle (rad), propeller spin (rad), and the bow light (night). */
  public setRig(steer: number, spin: number, night: number): void {
    this.motor.rotation.y = -steer * 0.5;
    this.prop.rotation.z = spin;
    this.navLight.color.setRGB(0.35 + 0.65 * night, 1, 0.35 + 0.3 * night);
  }
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}
