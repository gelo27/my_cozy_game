import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createPromptSprite } from './VehicleModel';

export const MOPED_WHEEL_RADIUS = 0.25;
/** Wheel centres in model space (forward = +Z, origin on the ground between the wheels). */
const FRONT_WHEEL = new THREE.Vector3(0, MOPED_WHEEL_RADIUS, 0.66);
const REAR_WHEEL = new THREE.Vector3(0, MOPED_WHEEL_RADIUS, -0.62);
/** Steering column pivot: handlebar, headlight, fork, front fender and wheel turn around it. */
const STEER_PIVOT = new THREE.Vector3(0, 0.5, 0.52);

type Bucket = 'paint' | 'cream' | 'trim' | 'chrome' | 'seat';

/**
 * Vintage step-through scooter (Vespa-like): rounded rear cowl, leg shield, small wheels, round
 * headlight on the handlebar. Origin on the ground between the wheels, forward = +Z.
 *
 * The fixed body is merged into one mesh per material; the steering group is merged the same way,
 * so the whole scooter costs about a dozen draw calls.
 */
export class MopedModel {
  public readonly group = new THREE.Group();
  /** Where the rider's model origin goes (the character model is centred 0.75 m above its feet). */
  public readonly seatAnchor = new THREE.Object3D();
  private readonly steerPivot = new THREE.Group();
  private readonly frontSpinner = new THREE.Group();
  private readonly rearSpinner = new THREE.Group();
  private readonly tailLight: THREE.MeshLambertMaterial;
  private readonly headLight: THREE.MeshBasicMaterial;
  private readonly promptSprite: THREE.Sprite;

  constructor(color = 0x8fd3bd) {
    this.group.name = 'Moped';
    const mats: Record<Bucket, THREE.Material> = {
      paint: new THREE.MeshLambertMaterial({ color }),
      cream: new THREE.MeshLambertMaterial({ color: 0xf3ead6 }),
      trim: new THREE.MeshLambertMaterial({ color: 0x33363c }),
      chrome: new THREE.MeshLambertMaterial({ color: 0xd9dee4, emissive: 0x1a1d22 }),
      seat: new THREE.MeshLambertMaterial({ color: 0x6b4630 }),
    };
    this.tailLight = new THREE.MeshLambertMaterial({ color: 0x8a1010, emissive: 0x550000 });
    this.headLight = new THREE.MeshBasicMaterial({ color: 0xfff3c4 });

    const body = MopedModel.buckets();
    const steer = MopedModel.buckets();
    const add = (b: Record<Bucket, THREE.BufferGeometry[]>, bucket: Bucket, g: THREE.BufferGeometry) => b[bucket].push(g);

    // Rear cowl: the iconic rounded "bubble" over the engine, with a cream side stripe
    add(body, 'paint', ellipsoid(0.27, 0.24, 0.5, 0, 0.5, -0.4));
    add(body, 'cream', ellipsoid(0.275, 0.05, 0.42, 0, 0.46, -0.42));
    // Floorboard and the tunnel joining the leg shield to the cowl
    add(body, 'trim', box(0.34, 0.05, 0.62, 0, 0.29, 0.08));
    add(body, 'paint', box(0.36, 0.08, 0.64, 0, 0.24, 0.08));
    // Leg shield: a shallow curved panel leaning back
    const shield = new THREE.SphereGeometry(1, 20, 12, Math.PI * 0.22, Math.PI * 0.56, Math.PI * 0.18, Math.PI * 0.64);
    shield.scale(0.24, 0.5, 0.16);
    shield.rotateX(-0.22);
    shield.rotateY(Math.PI);
    shield.translate(0, 0.66, 0.36);
    add(body, 'paint', shield);
    add(body, 'paint', box(0.3, 0.5, 0.05, 0, 0.55, 0.4, -0.22));
    // Saddle, rear rack, tail light housing, exhaust
    const seat = new THREE.CapsuleGeometry(0.13, 0.42, 4, 10);
    seat.rotateX(Math.PI / 2);
    seat.scale(1, 0.55, 1);
    seat.translate(0, 0.79, -0.3);
    add(body, 'seat', seat);
    add(body, 'chrome', box(0.26, 0.025, 0.24, 0, 0.8, -0.72));
    add(body, 'chrome', box(0.02, 0.1, 0.02, -0.12, 0.75, -0.82));
    add(body, 'chrome', box(0.02, 0.1, 0.02, 0.12, 0.75, -0.82));
    add(body, 'trim', box(0.12, 0.08, 0.06, 0, 0.62, -0.88));
    const pipe = new THREE.CylinderGeometry(0.045, 0.05, 0.42, 8);
    pipe.rotateX(Math.PI / 2);
    pipe.translate(0.17, 0.26, -0.62);
    add(body, 'chrome', pipe);
    // Kickstand nub and side mudguard over the rear wheel
    add(body, 'trim', box(0.2, 0.05, 0.18, 0, 0.42, -0.62));

    // Steering group (built around the pivot)
    const p = STEER_PIVOT;
    const col = new THREE.CylinderGeometry(0.035, 0.035, 0.62, 8);
    col.rotateX(-0.22);
    col.translate(0, 0.78 - p.y, 0.44 - p.z);
    add(steer, 'trim', col);
    const bar = new THREE.CapsuleGeometry(0.03, 0.56, 2, 8);
    bar.rotateZ(Math.PI / 2);
    bar.translate(0, 1.07 - p.y, 0.36 - p.z);
    add(steer, 'chrome', bar);
    for (const sx of [-0.31, 0.31]) {
      const grip = new THREE.CylinderGeometry(0.035, 0.035, 0.11, 8);
      grip.rotateZ(Math.PI / 2);
      grip.translate(sx, 1.07 - p.y, 0.36 - p.z);
      add(steer, 'trim', grip);
      // Mirrors on stalks
      add(steer, 'chrome', box(0.015, 0.16, 0.015, sx * 0.75, 1.15 - p.y, 0.35 - p.z));
      add(steer, 'chrome', ellipsoid(0.05, 0.035, 0.015, sx * 0.75, 1.24 - p.y, 0.35 - p.z));
    }
    // Handlebar cowl with the round headlight
    add(steer, 'paint', ellipsoid(0.17, 0.08, 0.12, 0, 1.06 - p.y, 0.4 - p.z));
    const lampRim = new THREE.CylinderGeometry(0.085, 0.085, 0.05, 16);
    lampRim.rotateX(Math.PI / 2);
    lampRim.translate(0, 1.07 - p.y, 0.5 - p.z);
    add(steer, 'chrome', lampRim);
    // Fork and the rounded front fender
    add(steer, 'trim', box(0.05, 0.3, 0.05, 0.08, 0.38 - p.y, 0.62 - p.z, -0.2));
    add(steer, 'paint', ellipsoid(0.12, 0.12, 0.3, 0, 0.47 - p.y, 0.68 - p.z));

    this.mergeInto(this.group, body, mats);
    this.steerPivot.position.copy(p);
    this.group.add(this.steerPivot);
    this.mergeInto(this.steerPivot, steer, mats);

    const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.07, 16), this.headLight);
    lamp.position.set(0, 1.07 - p.y, 0.53 - p.z);
    this.steerPivot.add(lamp);
    const tail = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.05), this.tailLight);
    tail.position.set(0, 0.62, -0.915);
    tail.rotation.y = Math.PI;
    this.group.add(tail);

    // Wheels: tyre + cream whitewall hub, shared geometry
    const tyreGeo = new THREE.TorusGeometry(MOPED_WHEEL_RADIUS - 0.055, 0.055, 8, 18);
    tyreGeo.rotateY(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.1, 12);
    hubGeo.rotateZ(Math.PI / 2);
    for (const [spinner, pos, parent] of [
      [this.frontSpinner, FRONT_WHEEL.clone().sub(p), this.steerPivot],
      [this.rearSpinner, REAR_WHEEL, this.group],
    ] as const) {
      spinner.position.copy(pos);
      spinner.add(new THREE.Mesh(tyreGeo, mats.trim), new THREE.Mesh(hubGeo, mats.cream));
      parent.add(spinner);
    }

    this.seatAnchor.position.set(0, 0.96, -0.24);
    this.group.add(this.seatAnchor);

    this.promptSprite = createPromptSprite();
    this.promptSprite.position.set(0, 1.6, 0);
    this.group.add(this.promptSprite);
  }

  private static buckets(): Record<Bucket, THREE.BufferGeometry[]> {
    return { paint: [], cream: [], trim: [], chrome: [], seat: [] };
  }

  private mergeInto(parent: THREE.Object3D, parts: Record<Bucket, THREE.BufferGeometry[]>, mats: Record<Bucket, THREE.Material>): void {
    for (const key of Object.keys(parts) as Bucket[]) {
      if (!parts[key].length) continue;
      // Mixed indexed / non-indexed inputs cannot be merged, so normalise them all
      const geos = parts[key].map((g) => (g.index ? g.toNonIndexed() : g));
      const merged = mergeGeometries(geos)!;
      parts[key].forEach((g) => g.dispose());
      parent.add(new THREE.Mesh(merged, mats[key]));
    }
  }

  public setPromptVisible(visible: boolean): void {
    this.promptSprite.visible = visible;
  }

  public setBrakeLight(on: boolean): void {
    this.tailLight.emissive.setHex(on ? 0xff1a1a : 0x550000);
  }

  /** Steering angle of the handlebar (rad) and accumulated wheel spin (rad). */
  public setRig(steer: number, spin: number): void {
    this.steerPivot.rotation.y = steer;
    this.frontSpinner.rotation.x = spin;
    this.rearSpinner.rotation.x = spin;
  }
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return g;
}

function ellipsoid(rx: number, ry: number, rz: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 16, 10);
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  return g;
}
