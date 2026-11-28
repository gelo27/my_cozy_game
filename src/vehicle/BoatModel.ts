import * as THREE from 'three';
import { createGlassMaterial } from '../scene/GlassMatcap';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createPromptSprite } from './VehicleModel';

/** Hull size in model space (forward = +Z, origin near the chine at midship). */
export const BOAT_HALF_LENGTH = 2.15;
export const BOAT_HALF_WIDTH = 0.86;

export const BOAT_CHINE_Y = -0.02;
export const BOAT_HULL_SECTIONS = Array.from({ length: 13 }, (_, index) => {
  const t = index / 12;
  const bow = Math.max(0, (t - 0.45) / 0.55);
  return {
    z: BOAT_HALF_LENGTH * (2 * t - 1),
    width: BOAT_HALF_WIDTH * (1 - 0.15 * Math.max(0, 1 - t * 5) ** 2) * (1 - bow ** 2.2),
    keel: -0.34 + bow * bow * 0.20,
    sheer: 0.41 + bow * bow * 0.20 + 0.025 * Math.max(0, 1 - t * 3),
  };
});

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

  constructor(color = 0x337f86) {
    this.group.name = 'Boat';
    const mats: Record<Bucket, THREE.Material> = {
      hull: new THREE.MeshLambertMaterial({ color: 0xf3e8d0, side: THREE.DoubleSide }),
      stripe: new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }),
      deck: new THREE.MeshLambertMaterial({ color: 0xb38553 }),
      trim: new THREE.MeshLambertMaterial({ color: 0x34474b }),
      seat: new THREE.MeshLambertMaterial({ color: 0xe9e1cf }),
      glass: createGlassMaterial({ color: 0xb4dcec, opacity: 0.4 }),
    };
    this.navLight = new THREE.MeshBasicMaterial({ color: 0x9cff9c });
    const parts: Record<Bucket, THREE.BufferGeometry[]> = { hull: [], stripe: [], deck: [], trim: [], seat: [], glass: [] };

    // Lofted hull: stations along Z, each a V section; the bow pinches to a point
    const sections = BOAT_HULL_SECTIONS.map(({ width, z, keel, sheer }) => [
      new THREE.Vector3(-width, sheer, z),
      new THREE.Vector3(-width * 0.9, BOAT_CHINE_Y, z),
      new THREE.Vector3(0, keel, z),
      new THREE.Vector3(width * 0.9, BOAT_CHINE_Y, z),
      new THREE.Vector3(width, sheer, z),
    ]);
    const outer: number[] = [];
    const stripe: number[] = [];
    const tri = (arr: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => arr.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let station = 1; station < sections.length; station++) {
      const prev = sections[station - 1];
      const cur = sections[station];
      for (let band = 0; band < 2; band++) {
        const panel = band === 0 ? stripe : outer;
        for (const side of [-1, 1]) {
          const upper = side < 0 ? band : 4 - band;
          const lower = upper - side;
          const [a, b, c, d] = [prev[upper], prev[lower], cur[lower], cur[upper]];
          // Both sides use the same diagonal in YZ, shared by the water cutout.
          if (side > 0) {
            tri(panel, a, c, b);
            tri(panel, a, d, c);
          } else {
            tri(panel, a, b, c);
            tri(panel, a, c, d);
          }
        }
      }
    }
    const stern = sections[0];
    const transom: number[] = [];
    tri(transom, stern[0], stern[4], stern[1]);
    tri(transom, stern[1], stern[4], stern[3]);
    tri(transom, stern[1], stern[3], stern[2]);

    const hullGeometry = (positions: number[]) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const indexed = mergeVertices(geometry);
      indexed.computeVertexNormals();
      geometry.dispose();
      return indexed;
    };
    parts.hull.push(hullGeometry(outer), hullGeometry(transom));
    parts.stripe.push(hullGeometry(stripe));

    // Rails trace the actual sheer, and the floor tapers inside the hull.
    for (const side of [0, 4]) {
      const rail = new THREE.CatmullRomCurve3(sections.map(section => section[side]));
      parts.deck.push(new THREE.TubeGeometry(rail, 32, 0.045, 6, false));
    }
    parts.deck.push(box(stern[4].x * 2, 0.07, 0.08, 0, stern[4].y, stern[4].z));
    const floor = new THREE.Shape();
    const floorSections = BOAT_HULL_SECTIONS.slice(1, -1);
    floor.moveTo(stern[0].x * 0.86, stern[0].z + 0.025);
    for (const section of floorSections) floor.lineTo(-section.width * 0.86, section.z);
    floor.lineTo(0, BOAT_HALF_LENGTH - 0.025);
    for (const section of floorSections.reverse()) floor.lineTo(section.width * 0.86, section.z);
    floor.lineTo(stern[4].x * 0.86, stern[4].z + 0.025);
    floor.closePath();
    const deck = new THREE.ExtrudeGeometry(floor, { depth: 0.045, bevelEnabled: false });
    deck.rotateX(Math.PI / 2).translate(0, 0.05, 0);
    parts.deck.push(deck);

    parts.seat.push(box(1.36, 0.1, 0.42, 0, 0.3, -1.25));
    parts.seat.push(box(1.14, 0.1, 0.36, 0, 0.3, 0.75));
    parts.deck.push(box(1.43, 0.06, 0.46, 0, 0.235, -1.25));
    parts.deck.push(box(1.2, 0.06, 0.41, 0, 0.235, 0.75));
    for (const x of [-0.4, 0.4]) parts.deck.push(box(0.09, 0.16, 0.28, x, 0.13, 0.75));
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
    for (const side of [-1, 1]) {
      for (const z of [-0.8, 0.5]) {
        const f = new THREE.CylinderGeometry(0.07, 0.07, 0.28, 6);
        f.translate(side * BOAT_HALF_WIDTH, 0.22, z);
        parts.seat.push(f);
        parts.trim.push(box(0.044, 0.115, 0.036, side * (BOAT_HALF_WIDTH - 0.018), 0.375, z));
      }
    }
    parts.trim.push(box(0.23, 0.15, 0.23, 0, 0.39, stern[0].z - 0.065));

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
