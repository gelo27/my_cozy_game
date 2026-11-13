import * as THREE from 'three';
import { TerrainSystem } from '../world/TerrainSystem';
import { ParticleManager } from '../particles/ParticleManager';
import { riverWorld } from '../world/rivers/RiverWorld';
import { Pest, PestEnv, PestPort } from './PestBase';
import { SpiderVoice, playSpiderVoice, prewarmSpiderVoices } from './SpiderVoices';

// ------------------------------------------------------------------ leg batch

/** Segments per spider: 8 legs × (femur + tibia). */
const SEGS = 16;
/** Spiders the batch holds before it grows. */
const START_BLOCKS = 16;

/**
 * Every spider's legs in one instanced mesh (one draw call for all of them). Each spider owns a
 * block of 16 instances; segment matrices are written straight into the instance buffer (no
 * Object3D per bone, no quaternions), and a hidden spider's block is collapsed to zero once.
 */
class SpiderLegBatch {
  public mesh: THREE.InstancedMesh;
  private readonly free: number[] = [];
  private used = 0;
  private dirty = false;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.Material;

  constructor(public readonly scene: THREE.Scene) {
    // Unit segment along +Y from the origin, tapering to half its width at the far end
    this.geometry = new THREE.CylinderGeometry(0.5, 1, 1, 5, 1);
    this.geometry.translate(0, 0.5, 0);
    this.material = new THREE.MeshLambertMaterial({ color: 0x2b1e18 });
    this.mesh = this.makeMesh(START_BLOCKS);
  }

  private makeMesh(blocks: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, blocks * SEGS);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    (mesh.instanceMatrix.array as Float32Array).fill(0);
    mesh.count = 0;
    // Instances span the whole cave pocket and the island: the per-mesh bounding sphere is useless
    mesh.frustumCulled = false;
    mesh.name = 'SpiderLegs';
    this.scene.add(mesh);
    return mesh;
  }

  public alloc(): number {
    const block = this.free.length ? this.free.pop()! : this.used++;
    const cap = this.mesh.instanceMatrix.count / SEGS;
    if (block >= cap) {
      // Grow: copy the old matrices into a mesh twice the size
      const old = this.mesh;
      const next = this.makeMesh(cap * 2);
      (next.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
      old.removeFromParent();
      old.dispose();
      this.mesh = next;
    }
    this.mesh.count = Math.max(this.mesh.count, (block + 1) * SEGS);
    return block;
  }

  public release(block: number): void {
    this.hide(block);
    this.free.push(block);
  }

  public hide(block: number): void {
    (this.mesh.instanceMatrix.array as Float32Array).fill(0, block * SEGS * 16, (block + 1) * SEGS * 16);
    this.dirty = true;
  }

  /** Writes the segment from `a` to `b` with the given base thickness (world space). */
  public segment(block: number, i: number, a: THREE.Vector3, b: THREE.Vector3, thick: number): void {
    const te = this.mesh.instanceMatrix.array as Float32Array;
    const o = (block * SEGS + i) * 16;
    const yx = b.x - a.x, yy = b.y - a.y, yz = b.z - a.z;
    const len = Math.sqrt(yx * yx + yy * yy + yz * yz) || 1e-4;
    // Any two axes perpendicular to the segment (its cross-section is round enough)
    let px = yz, py = 0, pz = -yx;
    let pl = Math.sqrt(px * px + pz * pz);
    if (pl < 1e-4 * len) {
      px = 0;
      py = -yz;
      pz = yy;
      pl = Math.sqrt(py * py + pz * pz) || 1;
    }
    const k = thick / pl;
    px *= k; py *= k; pz *= k;
    // Third axis: first × (segment / len), at the same thickness (a right-handed basis, so the
    // faces keep their winding)
    const qx = (py * yz - pz * yy) / len, qy = (pz * yx - px * yz) / len, qz = (px * yy - py * yx) / len;
    te[o] = px; te[o + 1] = py; te[o + 2] = pz; te[o + 3] = 0;
    te[o + 4] = yx; te[o + 5] = yy; te[o + 6] = yz; te[o + 7] = 0;
    te[o + 8] = qx; te[o + 9] = qy; te[o + 10] = qz; te[o + 11] = 0;
    te[o + 12] = a.x; te[o + 13] = a.y; te[o + 14] = a.z; te[o + 15] = 1;
    this.dirty = true;
  }

  /** Uploads the changed matrices (once a frame, however many spiders moved). */
  public flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  public get empty(): boolean {
    return this.free.length === this.used;
  }

  public dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

let batch: SpiderLegBatch | null = null;

function legBatch(scene: THREE.Scene): SpiderLegBatch {
  if (!batch || batch.scene !== scene) {
    batch?.dispose();
    batch = new SpiderLegBatch(scene);
  }
  return batch;
}

/** Uploads every spider's leg matrices (the pest system calls it once per frame). */
export function flushSpiderLegs(): void {
  batch?.flush();
}

// ------------------------------------------------------------------ spider

type SpiderState = 'lurk' | 'wander' | 'alert' | 'chase' | 'leap' | 'recover' | 'dazed';

const SPIDER_MATS = {
  body: new THREE.MeshLambertMaterial({ color: 0x3a2a20 }),
  abdomen: new THREE.MeshLambertMaterial({ color: 0x2e211b }),
  mark: new THREE.MeshLambertMaterial({ color: 0xb8892c }),
  fang: new THREE.MeshLambertMaterial({ color: 0x14100d }),
  // Glowing eyes: unlit, so they shine in the dark of the caves
  eye: new THREE.MeshBasicMaterial({ color: 0xff3b2f }),
};

/** Body height of the cephalothorax above the surface (m, before scale). */
const RIDE = 0.36;
const FEMUR = 0.46;
const TIBIA = 0.6;
/** Pair 0 is the front pair. Hip and resting foot offsets per pair (right side; left mirrors x). */
const HIP_Z = [0.16, 0.08, -0.0, -0.08];
const REST_X = [0.52, 0.72, 0.72, 0.56];
const REST_Z = [0.72, 0.3, -0.18, -0.6];
const LEG_LEN = [1.08, 1, 1, 1.08];
/** Foot further than this (× scale) from where it wants to stand starts a step. */
const STEP_DIST = 0.3;
/** Detail levels by distance from the player (m). */
const LOD_FULL = 28;
const LOD_SIM = 70;
/** Gravity while leaping / falling (m/s²). */
const GRAVITY = 16;

interface Leg {
  side: number;
  pair: number;
  /** Tetrapod gait: legs of one group step together, the other group holds the body. */
  group: number;
  hip: THREE.Vector3;
  rest: THREE.Vector3;
  femur: number;
  tibia: number;
  foot: THREE.Vector3;
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** 0..1 while the foot is in the air; -1 planted. */
  t: number;
}

const tA = new THREE.Vector3();
const tB = new THREE.Vector3();
const tC = new THREE.Vector3();
const tN = new THREE.Vector3();
const tHip = new THREE.Vector3();
const tKnee = new THREE.Vector3();
const tFoot = new THREE.Vector3();
const tUp = new THREE.Vector3();
const tRight = new THREE.Vector3();
const tOrigin = new THREE.Vector3();
const tDir = new THREE.Vector3();
const tAvoid = new THREE.Vector3();
const tWet = new THREE.Vector3();
const tFwd = new THREE.Vector3();
const tPrevUp = new THREE.Vector3();
const tFace = new THREE.Vector3();
const tMat = new THREE.Matrix4();
const tQuat = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/** Water surface over a point (a cave pool, a river or the sea). */
function waterAbove(p: THREE.Vector3): number {
  return riverWorld.waterLevelAt3(p.x, p.y, p.z);
}

/** `v` made perpendicular to the unit `n` and normalised; false when it lies along `n`. */
function tangent(v: THREE.Vector3, n: THREE.Vector3): boolean {
  v.addScaledVector(n, -v.dot(n));
  const l = v.length();
  if (l < 1e-4) return false;
  v.divideScalar(l);
  return true;
}

/**
 * Whether a point lies inside the rock of the caves: a ray straight up from open air crosses the
 * cave's shell an odd number of times before it leaves the pocket, from inside the rock an even
 * number. (Rapier reports every hit's normal facing the ray, so the normal cannot tell.)
 */
export function insideRock(env: PestEnv, p: THREE.Vector3, reach = 80): boolean {
  tOrigin.copy(p);
  let crossings = 0;
  let left = reach;
  for (let i = 0; i < 16 && left > 0; i++) {
    const t = env.sweep(tOrigin, UP, left);
    if (t < 0) break;
    crossings++;
    tOrigin.y += t + 0.02;
    left -= t + 0.02;
  }
  return crossings % 2 === 0 && crossings > 0;
}

/**
 * A cave spider that walks on any rock: floors, walls and ceilings. It lurks with its red eyes
 * glowing and chitters now and then, shrieks when it spots the player, scuttles after them over
 * whatever surface is in the way, pounces from a few metres and drops on them from the ceiling.
 *
 * Movement: the spider has its own "up" (the surface normal under it). Each frame it steps along
 * its forward direction in the surface's plane, then snaps back onto the rock with one ray along
 * its -up. A wall ahead (one forward ray) turns it up onto that wall; when the rock ends under it
 * (a ledge) one ray back under the edge finds the face beyond and it wraps over. It never steps
 * into water.
 *
 * Legs: each foot stays planted on the rock until the body has carried its rest spot too far
 * away, then steps (in two alternating groups of four) to a spot found with a ray; a two-bone IK
 * puts the knee high above it. All the legs of all the spiders are one instanced mesh.
 */
export class Spider extends Pest {
  public readonly habitat = 'cave';
  public readonly hitRadius: number;
  private state: SpiderState = 'lurk';
  private readonly scale: number;
  /** Leg-span radius other spiders keep out of. */
  public get spacing(): number { return 0.85 * this.scale; }
  private readonly body = new THREE.Group();
  private readonly fangs: THREE.Mesh[] = [];
  private readonly legs: Leg[] = [];
  private readonly block: number;
  private readonly batch: SpiderLegBatch;
  private legsHidden = false;
  /** Surface normal under the spider (its up), and its heading in that surface's plane. */
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly fwd = new THREE.Vector3(0, 0, 1);
  private readonly upTarget = new THREE.Vector3(0, 1, 0);
  /** Not yet put onto the rock under it (first update with physics). */
  private settled = false;
  private speed = 0;
  /** Velocity: of the walk (legs lead by it), or of the flight while leaping / falling. */
  private readonly vel = new THREE.Vector3();
  /** Push away from overlapping spiders, filled each frame by the pest system. */
  public readonly avoid = new THREE.Vector3();
  private airTime = 0;
  private rear = 0;
  private bite = 0;
  private cooldown = 0;
  private lost = 0;
  private stuck = 0;
  private bob = 0;
  private voiceTimer = 3 + Math.random() * 6;
  private stepSoundTimer = 0;
  /** Seconds a step takes at the current speed (also how far ahead a foot lands). */
  private stepTime = 0.2;
  /** Per leg, this frame: squared distance a planted foot trails its home (-1 when not planted). */
  private readonly far = new Float32Array(8);

  constructor(x: number, y: number, z: number, terrain: TerrainSystem, scene: THREE.Scene, up?: THREE.Vector3, scale = 0.85 + Math.random() * 0.35) {
    super('spider', x, z, terrain, 0.9 * scale, 3);
    this.scale = scale;
    this.hitRadius = 0.5 * scale;
    this.position.y = y;
    this.home.copy(this.position);
    this.wander.copy(this.position);
    if (up && up.lengthSq() > 0.5) this.up.copy(up).normalize();
    this.upTarget.copy(this.up);
    // Any heading in the surface's plane
    const a = Math.random() * Math.PI * 2;
    this.fwd.set(Math.sin(a), 0, Math.cos(a));
    if (!tangent(this.fwd, this.up)) {
      this.fwd.set(1, 0, 0);
      tangent(this.fwd, this.up);
    }
    this.buildBody();
    this.batch = legBatch(scene);
    this.block = this.batch.alloc();
    const s = scale;
    for (let i = 0; i < 8; i++) {
      const side = i < 4 ? -1 : 1;
      const pair = i % 4;
      this.legs.push({
        side,
        pair,
        group: (pair + (side > 0 ? 1 : 0)) % 2,
        hip: new THREE.Vector3(side * 0.12 * s, RIDE * s + 0.02 * s, HIP_Z[pair] * s),
        rest: new THREE.Vector3(side * REST_X[pair] * s, 0, REST_Z[pair] * s),
        femur: FEMUR * LEG_LEN[pair] * s,
        tibia: TIBIA * LEG_LEN[pair] * s,
        foot: new THREE.Vector3(),
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        t: -1,
      });
    }
    this.orient(1);
    this.plantAll(null);
    this.drawLegs();
  }

  private buildBody(): void {
    const s = this.scale;
    const sphere = new THREE.SphereGeometry(1, 12, 9);
    const add = (mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(sphere, mat);
      m.scale.set(sx * s, sy * s, sz * s);
      m.position.set(x * s, y * s, z * s);
      m.userData.shared = true;
      this.body.add(m);
      return m;
    };
    add(SPIDER_MATS.body, 0.2, 0.13, 0.24, 0, RIDE, 0.08);
    const abdomen = add(SPIDER_MATS.abdomen, 0.3, 0.25, 0.36, 0, RIDE + 0.1, -0.4);
    abdomen.rotation.x = 0.25;
    add(SPIDER_MATS.mark, 0.11, 0.04, 0.2, 0, RIDE + 0.33, -0.38).rotation.x = 0.3;
    add(SPIDER_MATS.mark, 0.06, 0.03, 0.06, 0.12, RIDE + 0.27, -0.2);
    add(SPIDER_MATS.mark, 0.06, 0.03, 0.06, -0.12, RIDE + 0.27, -0.2);
    // Eight eyes in two rows on the front of the head
    for (const [ex, ey, ez, r] of [[0.05, 0.08, 0.29, 0.035], [0.11, 0.06, 0.26, 0.025], [0.035, 0.12, 0.25, 0.022], [0.09, 0.11, 0.23, 0.018]]) {
      add(SPIDER_MATS.eye, r, r, r, ex, RIDE + ey, ez);
      add(SPIDER_MATS.eye, r, r, r, -ex, RIDE + ey, ez);
    }
    const fangGeo = new THREE.ConeGeometry(0.035 * s, 0.14 * s, 5);
    fangGeo.translate(0, -0.07 * s, 0);
    for (const sx of [-1, 1]) {
      const f = new THREE.Mesh(fangGeo, SPIDER_MATS.fang);
      f.userData.shared = sx > 0;
      f.position.set(sx * 0.05 * s, (RIDE - 0.04) * s, 0.3 * s);
      this.fangs.push(f);
      this.body.add(f);
    }
    this.group.add(this.body);
  }

  /** Centre of the body (it rides above the surface along its up). */
  public hitPoint(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).addScaledVector(this.up, RIDE * this.scale + this.body.position.y);
  }

  get threat(): number {
    return this.state === 'leap' || (this.state === 'chase' && this.bite > 0) ? 2 : this.state === 'chase' || this.state === 'alert' ? 1 : 0;
  }

  protected onHurt(from: THREE.Vector3): void {
    this.emote.show('angry', 0.8);
    this.playVoice('attack');
    // Knocked off a wall or the ceiling: it falls; on the floor it is shoved back and dazed
    tA.subVectors(this.position, from);
    if (this.up.y < 0.5) {
      this.vel.copy(tA.setY(0).normalize().multiplyScalar(2));
      this.startFlight();
      return;
    }
    if (tangent(tA, this.up)) this.vel.copy(tA).multiplyScalar(4);
    this.state = 'dazed';
    this.timer = 0.9;
    // No pounce the moment the daze wears off (it used to leap straight back through the player)
    this.cooldown = Math.max(this.cooldown, 1.7);
  }

  // ---------------------------------------------------------------- surfaces

  /** Ground (any rock) along -up under `p`: writes the point into `out`, the normal into tN. */
  private snap(env: PestEnv, p: THREE.Vector3, up: THREE.Vector3, above: number, below: number, out: THREE.Vector3): boolean {
    tOrigin.copy(p).addScaledVector(up, above);
    tDir.copy(up).negate();
    const t = env.cast(tOrigin, tDir, above + below, tN);
    if (t >= 0) {
      out.copy(tOrigin).addScaledVector(tDir, t);
      return true;
    }
    // No physics there (yet): the island's heightmap is the ground for an upright spider
    if (up.y > 0.7 && this.terrain.isInside(p.x, p.z)) {
      const h = this.terrain.getHeight(p.x, p.z);
      if (Math.abs(h - p.y) < above + below) {
        out.set(p.x, h, p.z);
        tN.set(0, 1, 0);
        return true;
      }
    }
    return false;
  }

  /** The body at `p` on a surface with normal `n` would be under water. */
  private wet(p: THREE.Vector3, n: THREE.Vector3): boolean {
    tWet.copy(p).addScaledVector(n, RIDE * this.scale);
    return waterAbove(tWet) > tWet.y;
  }

  /** Cosine between the heading and the way to `target`, in the surface plane (1 straight ahead, -1 behind). */
  private facing(target: THREE.Vector3): number {
    tFace.subVectors(target, this.position);
    return tangent(tFace, this.up) ? this.fwd.dot(tFace) : 1;
  }

  /** Turns the heading towards `dir` (world) within the surface plane, at most `rate`·dt. */
  private steer(dir: THREE.Vector3, rate: number, dt: number): void {
    tA.copy(dir);
    if (!tangent(tA, this.up)) return;
    tB.crossVectors(this.fwd, tA);
    const ang = Math.atan2(tB.dot(this.up), this.fwd.dot(tA));
    const step = THREE.MathUtils.clamp(ang, -rate * dt, rate * dt);
    this.fwd.applyAxisAngle(this.up, step);
    tangent(this.fwd, this.up);
  }

  /**
   * One step of `step` metres along the heading over the rock: onto a wall ahead, over a ledge,
   * never into water. Returns false when the way is closed (the spider stays put).
   */
  private crawl(env: PestEnv, step: number): boolean {
    const s = this.scale;
    const pos = this.position;
    // 1. A wall ahead at body height: climb onto it (inner corner)
    tOrigin.copy(pos).addScaledVector(this.up, 0.25 * s);
    const t = env.cast(tOrigin, this.fwd, 0.38 * s + step, tN);
    if (t >= 0 && tN.dot(this.up) < 0.6) {
      tC.copy(tOrigin).addScaledVector(this.fwd, t);
      if (this.wet(tC, tN)) return false;
      const oldUp = tA.copy(this.up);
      pos.copy(tC);
      this.up.copy(tN);
      this.upTarget.copy(tN);
      // Up the wall: the old up becomes the way forward
      this.fwd.copy(oldUp);
      if (!tangent(this.fwd, this.up)) this.fwd.copy(tB.set(0, 1, 0)), tangent(this.fwd, this.up);
      return true;
    }
    // 2. Along the surface, then back onto the rock under the new spot
    tB.copy(pos).addScaledVector(this.fwd, step);
    if (this.snap(env, tB, this.up, 0.45 * s, 0.6 * s, tC) && tN.dot(this.up) > 0.2) {
      if (this.wet(tC, tN)) return false;
      pos.copy(tC);
      this.upTarget.copy(tN);
      return true;
    }
    // 3. The rock ends: wrap over the edge onto the face beyond it (outer corner)
    tOrigin.copy(tB).addScaledVector(this.up, -0.18 * s);
    tDir.copy(this.fwd).negate();
    const t3 = env.cast(tOrigin, tDir, 0.6 * s + step, tN);
    if (t3 >= 0 && tN.dot(this.fwd) > 0.4) {
      tC.copy(tOrigin).addScaledVector(tDir, t3);
      if (this.wet(tC, tN)) return false;
      const oldUp = tA.copy(this.up);
      pos.copy(tC);
      this.up.copy(tN);
      this.upTarget.copy(tN);
      // Down over the edge: forward is the old down
      this.fwd.copy(oldUp).negate();
      if (!tangent(this.fwd, this.up)) this.fwd.set(1, 0, 0), tangent(this.fwd, this.up);
      return true;
    }
    return false;
  }

  /** Group transform from up / forward (eased so turning a corner is not a snap). */
  private orient(k: number): void {
    tRight.crossVectors(this.up, this.fwd).normalize();
    tUp.crossVectors(this.fwd, tRight);
    tMat.makeBasis(tRight, tUp, this.fwd);
    tQuat.setFromRotationMatrix(tMat);
    if (k >= 1) this.group.quaternion.copy(tQuat);
    else this.group.quaternion.slerp(tQuat, k);
  }

  /** Off the rock: leaping or falling under gravity until it hits something. */
  private startFlight(): void {
    this.state = 'leap';
    this.airTime = 0;
  }

  private fly(dt: number, env: PestEnv, player: THREE.Vector3, port: PestPort, particles?: ParticleManager): void {
    const s = this.scale;
    const pos = this.position;
    this.airTime += dt;
    this.vel.y -= GRAVITY * dt;
    const sp = this.vel.length();
    const len = sp * dt;
    // Swept from the body's centre: the first rock in the way is where it lands
    this.hitPoint(tOrigin);
    tDir.copy(this.vel).divideScalar(sp || 1);
    const t = sp > 1e-3 ? env.cast(tOrigin, tDir, len + RIDE * s, tN) : -1;
    if (tOrigin.distanceTo(tB.copy(player).setY(player.y - 0.3)) < 1.0 + 0.3 * s) {
      if (this.bite <= 0 && port.hurt(pos, 7, 'spider')) this.bite = 1;
      // Bounces off the player's body (whether the bite landed or not): never flies through them
      tC.set(tOrigin.x - player.x, 0, tOrigin.z - player.z);
      const l = tC.length();
      if (l > 1e-3) {
        tC.divideScalar(l);
        const into = this.vel.x * tC.x + this.vel.z * tC.z;
        if (into < 1.5) {
          this.vel.x += tC.x * (1.5 - into);
          this.vel.z += tC.z * (1.5 - into);
        }
      }
    }
    if (t >= 0) {
      tC.copy(tOrigin).addScaledVector(tDir, t);
      pos.copy(tC);
      this.up.copy(tN);
      this.upTarget.copy(tN);
      this.fwd.copy(this.vel);
      if (!tangent(this.fwd, this.up)) this.fwd.set(1, 0, 0), tangent(this.fwd, this.up);
      this.vel.set(0, 0, 0);
      this.state = 'recover';
      this.timer = 0.5;
      this.orient(1);
      this.plantAll(env);
      particles?.emitJumpDust(pos);
      this.playVoice('step');
      return;
    }
    pos.addScaledVector(this.vel, dt);
    // Turns upright in the air (it lands on its feet)
    this.up.lerp(UP, Math.min(1, dt * 3)).normalize();
    tangent(this.fwd, this.up) || (this.fwd.set(1, 0, 0), tangent(this.fwd, this.up));
    if (this.airTime > 4 || waterAbove(pos) > pos.y) {
      // Lost (fell through a gap or into water): back home, on its feet
      pos.copy(this.home);
      this.up.set(0, 1, 0);
      this.upTarget.copy(this.up);
      this.vel.set(0, 0, 0);
      tangent(this.fwd, this.up) || this.fwd.set(0, 0, 1);
      this.settled = false;
      this.state = 'lurk';
      this.timer = 2;
      this.orient(1);
      this.plantAll(null);
    }
  }

  // ---------------------------------------------------------------- legs

  /** Where a leg's foot wants to stand: its rest spot under the body (world), led by the motion. */
  private homeOf(leg: Leg, out: THREE.Vector3): THREE.Vector3 {
    out.copy(leg.rest).applyMatrix4(this.group.matrix);
    // Aimed 1.5 steps' travel ahead: the body moves one step's worth while the foot is in the air,
    // so it lands half a step ahead of its rest spot and is half a step behind when it lifts again
    return out.addScaledVector(this.vel, this.stepTime * 1.5);
  }

  /** Where a foot aimed at `home` really lands: on a wall the hip reaches first, else on the rock under it. */
  private foothold(env: PestEnv, leg: Leg, home: THREE.Vector3, out: THREE.Vector3): void {
    const s = this.scale;
    const e = this.group.matrix.elements;
    tUp.set(e[4], e[5], e[6]).normalize();
    // From the body towards the foot: a wall in between takes the foot (corners, tunnels)
    this.hitPoint(tOrigin);
    tDir.subVectors(home, tOrigin);
    const d = tDir.length();
    tDir.divideScalar(d || 1);
    const t = env.cast(tOrigin, tDir, d, tN);
    if (t >= 0) {
      out.copy(tOrigin).addScaledVector(tDir, t);
      return;
    }
    tC.copy(home);
    if (this.snap(env, tC, tUp, 0.6 * s, 0.9 * s, out)) return;
    out.copy(home);
  }

  /** Puts every foot on its rest spot (spawn, landing): rays when `env` is given. */
  private plantAll(env: PestEnv | null): void {
    this.group.updateMatrix();
    for (const leg of this.legs) {
      this.homeOf(leg, tFoot);
      if (env) this.foothold(env, leg, tFoot, leg.foot);
      else leg.foot.copy(tFoot);
      leg.t = -1;
    }
  }

  private updateLegs(dt: number, env: PestEnv, full: boolean): void {
    this.group.updateMatrix();
    const s = this.scale;
    // Feet still in the air after this frame's update (one that lands now frees its group at once)
    const stepping = [0, 0];
    const airborne = this.state === 'leap';
    // Faster steps when running (a frantic scuttle), slower when strolling; the stride grows too
    const stepTime = (this.stepTime = THREE.MathUtils.clamp(0.2 - this.speed * 0.02, 0.085, 0.2));
    // A foot trails its home by two steps' travel when its turn comes (one in the air, one standing)
    const limit = Math.max(STEP_DIST * s, this.speed * stepTime * 1.7);
    const need = [0, 0];
    const e = this.group.matrix.elements;
    tUp.set(e[4], e[5], e[6]).normalize();

    for (let i = 0; i < 8; i++) {
      const leg = this.legs[i];
      this.far[i] = -1;
      if (airborne) {
        // Legs spread and reaching forward in the air, ready to grab the rock
        tA.copy(leg.rest).multiplyScalar(0.75);
        tA.y = RIDE * s * 0.3;
        tA.z += 0.12 * s;
        leg.foot.lerp(tA.applyMatrix4(this.group.matrix), Math.min(1, dt * 18));
        leg.t = -1;
        continue;
      }
      // The front pair reared up: held in the air, waving
      if (leg.pair === 0 && this.rear > 0.05) {
        tB.set(leg.side * 0.28 * s, RIDE * s * 2.1 + Math.sin(this.time * 14 + leg.side) * 0.05 * s, 0.62 * s).applyMatrix4(this.group.matrix);
        leg.foot.lerpVectors(leg.t >= 0 ? leg.to : leg.foot, tB, this.rear);
        if (this.rear > 0.9) leg.t = -1;
        if (this.rear > 0.5) continue;
      }
      if (leg.t >= 0) {
        leg.t = Math.min(1, leg.t + dt / stepTime);
        const k = leg.t * leg.t * (3 - 2 * leg.t);
        leg.foot.lerpVectors(leg.from, leg.to, k);
        leg.foot.addScaledVector(tUp, Math.sin(leg.t * Math.PI) * 0.16 * s);
        if (leg.t >= 1) {
          leg.t = -1;
          leg.foot.copy(leg.to);
          if (full) this.stepSound();
        } else stepping[leg.group]++;
        continue;
      }
      // Planted: how far it trails where it wants to stand (the group decides below whether to step)
      const home = this.homeOf(leg, tA);
      let far2 = home.distanceToSquared(leg.foot);
      // Out of the leg's reach (the body turned a corner or dropped): step at once
      tHip.copy(leg.hip).applyMatrix4(this.group.matrix);
      const reach = leg.femur + leg.tibia;
      if (tHip.distanceToSquared(leg.foot) > reach * reach) far2 = Math.max(far2, limit * limit * 4);
      this.far[i] = far2;
      if (far2 > need[leg.group]) need[leg.group] = far2;
    }

    // Tetrapod gait: a group of four lifts together, and only while the other four stand. The
    // group trailing further goes first; a leg dragged far behind steps whatever the gait says.
    const lim2 = limit * limit;
    const g = need[0] >= need[1] ? 0 : 1;
    for (const grp of [g, 1 - g]) {
      const go = need[grp] > lim2 && stepping[1 - grp] === 0;
      for (let i = 0; i < 8; i++) {
        const leg = this.legs[i];
        const far2 = this.far[i];
        if (leg.group !== grp || far2 < 0) continue;
        // The whole group goes (a foot left behind would fall out of phase and trail two cycles)
        if (!(go && far2 > 0.0025) && far2 < lim2 * 3.6) continue;
        this.startStep(leg, env, full);
        stepping[grp]++;
      }
    }
  }

  /** Lifts a foot towards its home: rays find the rock where it lands (far ones follow the body's plane). */
  private startStep(leg: Leg, env: PestEnv, full: boolean): void {
    const home = this.homeOf(leg, tFoot);
    leg.from.copy(leg.foot);
    if (full) this.foothold(env, leg, home, leg.to);
    else leg.to.copy(home);
    leg.t = 0;
  }

  /** Two-bone IK per leg (knee bent up and out, like a spider's), written to the shared batch. */
  private drawLegs(): void {
    this.group.updateMatrix();
    const m = this.group.matrix;
    const e = m.elements;
    tUp.set(e[4], e[5], e[6]).normalize();
    tRight.set(e[0], e[1], e[2]).normalize();
    const s = this.scale;
    let i = 0;
    for (const leg of this.legs) {
      tHip.copy(leg.hip).applyMatrix4(m).addScaledVector(tUp, this.body.position.y);
      tFoot.copy(leg.foot);
      const L1 = leg.femur, L2 = leg.tibia;
      tA.subVectors(tFoot, tHip);
      let d = tA.length();
      if (d < 1e-4) {
        tA.copy(tUp).negate();
        d = 1e-4;
      }
      tA.divideScalar(d);
      // An overstretched leg reaches straight out; the foot stays where it is drawn
      const reach = Math.min(d, (L1 + L2) * 0.999);
      if (d > reach) tFoot.copy(tHip).addScaledVector(tA, reach);
      const a = (L1 * L1 - L2 * L2 + reach * reach) / (2 * reach);
      const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      // Pole: the body's up, tilted outwards to the leg's own side
      tB.copy(tRight).multiplyScalar(leg.side * 0.5).add(tUp);
      tB.addScaledVector(tA, -tB.dot(tA));
      if (tB.lengthSq() < 1e-6) tB.copy(tUp);
      tB.normalize();
      tKnee.copy(tHip).addScaledVector(tA, a).addScaledVector(tB, h);
      this.batch.segment(this.block, i++, tHip, tKnee, 0.042 * s);
      this.batch.segment(this.block, i++, tKnee, tFoot, 0.034 * s);
    }
    this.legsHidden = false;
  }

  // ---------------------------------------------------------------- voice

  private playVoice(kind: SpiderVoice): void {
    playSpiderVoice(kind, this.position, this.scale, kind === 'step' ? 0.7 : 1);
  }

  private stepSound(): void {
    if (this.stepSoundTimer > 0) return;
    this.stepSoundTimer = 0.11;
    this.playVoice('step');
  }

  // ---------------------------------------------------------------- frame

  public update(dt: number, player: THREE.Vector3, port: PestPort, env: PestEnv, particles?: ParticleManager): void {
    const pos = this.position;
    const dx = player.x - pos.x, dz = player.z - pos.z;
    const dy = player.y - pos.y;
    const flat = Math.hypot(dx, dz);
    const dist = Math.hypot(flat, dy);
    const visible = dist < LOD_SIM;
    this.group.visible = visible;
    if (!visible) {
      if (!this.legsHidden) {
        this.batch.hide(this.block);
        this.legsHidden = true;
      }
      return;
    }
    if (dt <= 0) {
      if (this.legsHidden) this.drawLegs();
      return;
    }
    const full = dist < LOD_FULL;
    const s = this.scale;
    if (full) prewarmSpiderVoices();
    // First update with physics: onto the rock it was put on
    if (!this.settled) {
      this.settled = true;
      if (this.snap(env, pos, this.up, 0.5 * s, 1.5 * s, tC)) {
        pos.copy(tC);
        this.up.copy(tN);
        this.upTarget.copy(tN);
        tangent(this.fwd, this.up) || (this.fwd.set(1, 0, 0), tangent(this.fwd, this.up));
        this.orient(1);
        this.plantAll(env);
      }
    }
    this.time += dt;
    this.timer -= dt;
    this.cooldown -= dt;
    this.stepSoundTimer -= dt;
    this.voiceTimer -= dt;
    this.emote.update(dt);
    const eye = this.hitPoint(tA);
    const sees = dist < 16 && this.look(dt, eye, player, env, 16);
    let want = 0;
    let wantRear = 0;
    let turnRate = 4;
    const toPlayer = tB.subVectors(player, pos);

    switch (this.state) {
      case 'lurk':
        if (sees && dist < 11) {
          this.toAlert();
          break;
        }
        if (this.timer <= 0) {
          // Off for a stroll: often up the nearest wall (towards the ceiling), else around home
          if (Math.random() > 0.5 || !this.pickClimb(env)) this.pickWander(6);
          this.state = 'wander';
          this.timer = 10;
        } else if (Math.random() < dt * 0.4) {
          // A twitch: turns a little where it sits
          this.fwd.applyAxisAngle(this.up, (Math.random() - 0.5) * 0.8);
        }
        this.guardVoice(dist);
        break;
      case 'wander': {
        if (sees && dist < 11) {
          this.toAlert();
          break;
        }
        tC.subVectors(this.wander, pos);
        if (tC.lengthSq() < 0.8 || this.timer <= 0) {
          this.state = 'lurk';
          this.timer = 2 + Math.random() * 5;
          break;
        }
        this.steer(tC, 3, dt);
        want = 1.3;
        this.guardVoice(dist);
        break;
      }
      case 'alert':
        // Rears up and shrieks
        this.steer(toPlayer, 8, dt);
        wantRear = 1;
        if (this.timer <= 0) {
          this.state = 'chase';
          this.lost = 0;
        }
        break;
      case 'chase': {
        this.lost = sees ? 0 : this.lost + dt;
        if (this.lost > 6 || dist > 26) {
          this.state = 'wander';
          this.home.copy(pos);
          this.pickWander(5);
          this.timer = 8;
          this.emote.show('question', 1);
          break;
        }
        this.steer(toPlayer, 7, dt);
        turnRate = 7;
        want = dist > 1.0 * s + 0.5 ? 4.6 : 0;
        const body = this.hitPoint(tC);
        const reach = body.distanceTo(tA.copy(player).setY(player.y - 0.3));
        // The fangs are at the front: it bites or pounces only once it faces the player (close
        // up it stands and turns on the spot first)
        const ahead = this.facing(player);
        if (this.bite <= 0 && this.cooldown <= 0 && reach < 1.3 && ahead > 0.75) {
          // Bite
          this.bite = 1;
          this.cooldown = 1.3;
          this.playVoice('attack');
          port.hurt(pos, 6, 'spider');
        } else if (this.up.y < -0.6 && flat < 1.8 && dy < -1 && dy > -9 && this.cooldown <= 0) {
          // Right above the player on the ceiling: lets go and drops on them
          this.vel.set(dx, 0, dz).multiplyScalar(0.8);
          this.cooldown = 2.5;
          this.startFlight();
          this.playVoice('attack');
        } else if (sees && this.cooldown <= 0 && this.up.y > 0.4 && dist > 2.6 && dist < 6 && Math.abs(dy) < 1.8 && ahead > 0.85) {
          // Pounce: lands just in front of the player (its legs reach them), not on top of them
          const hs = Math.min(9, Math.max(0, flat - (0.8 + 0.4 * s)) / 0.5);
          this.vel.set((dx / flat) * hs, 4.2 + dy * 1.5, (dz / flat) * hs);
          this.cooldown = 2.2;
          this.startFlight();
          this.playVoice('attack');
        }
        break;
      }
      case 'leap':
        break;
      case 'recover':
        this.steer(toPlayer, 6, dt);
        if (this.timer <= 0) this.state = 'chase';
        break;
      case 'dazed':
        this.spinStars(true, (RIDE + 0.45) * s, 0.25);
        if (this.timer <= 0) {
          this.spinStars(false, 0, 0);
          this.provoked = false;
          this.state = 'chase';
          this.lost = 0;
        }
        break;
    }

    if (this.state === 'leap') {
      this.fly(dt, env, player, port, particles);
      this.speed = 0;
    } else {
      // Crawling over the rock (a shove after a hit slides it along the surface)
      this.speed += (want - this.speed) * Math.min(1, dt * 8);
      let sp = this.speed;
      if (this.state === 'dazed' && this.vel.lengthSq() > 0.01) {
        tC.copy(this.vel);
        if (tangent(tC, this.up)) this.fwd.lerp(tC, 0.3), tangent(this.fwd, this.up);
        sp = this.vel.length();
        this.vel.multiplyScalar(Math.exp(-dt * 6));
      }
      this.vel.set(0, 0, 0);
      if (sp > 0.05) {
        if (this.crawl(env, sp * dt)) {
          this.vel.copy(this.fwd).multiplyScalar(sp);
          this.stuck = Math.max(0, this.stuck - 1);
        } else {
          // Feels sideways along the obstacle
          this.fwd.applyAxisAngle(this.up, (this.stuck & 1 ? 1 : -1) * Math.min(1.2, turnRate * dt * 2));
          if (++this.stuck > 50) {
            this.stuck = 0;
            if (this.state === 'wander') {
              this.state = 'lurk';
              this.timer = 1 + Math.random() * 2;
            }
          }
        }
      }
      // Crowding: veer around and slide away from spiders whose legs overlap this one's
      if (this.avoid.lengthSq() > 1e-4) {
        tAvoid.copy(this.avoid);
        const push = Math.min(1, tAvoid.length());
        if (tangent(tAvoid, this.up)) {
          if (sp > 0.05) this.fwd.addScaledVector(tAvoid, Math.min(1, dt * 6 * push)), tangent(this.fwd, this.up);
          tFwd.copy(this.fwd);
          tPrevUp.copy(this.up);
          this.fwd.copy(tAvoid);
          const moved = this.crawl(env, Math.min(0.5, push * 2.2 * s) * dt);
          // Kept the new heading if the shove carried it round a corner
          if (!moved || tPrevUp.equals(this.up)) this.fwd.copy(tFwd);
          tangent(this.fwd, this.up) || (this.fwd.set(1, 0, 0), tangent(this.fwd, this.up));
        }
      }
      // Up follows the rock's normal smoothly (the mesh's triangles are faceted)
      this.up.lerp(this.upTarget, Math.min(1, dt * 10)).normalize();
      tangent(this.fwd, this.up) || (this.fwd.set(1, 0, 0), tangent(this.fwd, this.up));
    }
    // The player's body is solid to a crawling spider: shoved out of it, never walks through
    if (this.state !== 'leap' && this.up.y > 0.5 && Math.abs(player.y - 0.9 - this.position.y) < 1.4) {
      const minR = 0.6 * this.scale + 0.3;
      const ox = this.position.x - player.x, oz = this.position.z - player.z;
      const d = Math.hypot(ox, oz);
      if (d < minR) {
        const k = d > 1e-3 ? (minR - d) / d : 0;
        this.position.x += d > 1e-3 ? ox * k : this.fwd.x * -minR;
        this.position.z += d > 1e-3 ? oz * k : this.fwd.z * -minR;
      }
    }
    this.orient(this.state === 'leap' ? Math.min(1, dt * 5) : Math.min(1, dt * 14));

    this.rear += (wantRear - this.rear) * Math.min(1, dt * 7);
    // Body bobs a little with each step, rears up on its back legs; fangs work when biting
    let air = 0;
    for (const leg of this.legs) if (leg.t >= 0) air++;
    this.bob += ((air ? 0.025 * s : 0) - this.bob) * Math.min(1, dt * 10);
    this.body.position.y = this.bob + this.rear * 0.12 * s;
    this.body.rotation.x = -this.rear * 0.55;
    this.bite = Math.max(0, this.bite - dt * 3);
    const f = Math.sin(this.bite * Math.PI) * 0.7 + (this.state === 'alert' ? Math.abs(Math.sin(this.time * 18)) * 0.3 : 0);
    this.fangs[0].rotation.set(-0.3 - f, 0, -0.25 - f * 0.5);
    this.fangs[1].rotation.set(-0.3 - f, 0, 0.25 + f * 0.5);
    this.emote.sprite.position.set(0, 0.9 * s, 0);
    this.applyWobble(dt);

    this.updateLegs(dt, env, full);
    this.drawLegs();
  }

  private toAlert(): void {
    this.state = 'alert';
    this.timer = 0.8;
    this.emote.show('alert', 0.9);
    this.playVoice('scream');
  }

  /** Now and then, while on guard and the player is within earshot: a dry chitter. */
  private guardVoice(dist: number): void {
    if (this.voiceTimer > 0) return;
    this.voiceTimer = 5 + Math.random() * 7;
    if (dist < 22) this.playVoice('idle');
  }

  /** A spot up on the nearest wall around (8 rays across the surface): the crawl climbs to it. */
  private pickClimb(env: PestEnv): boolean {
    const from = this.hitPoint(tOrigin.clone());
    let best = Infinity;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      tDir.set(Math.cos(a), 0, Math.sin(a));
      if (!tangent(tDir, this.up)) continue;
      const t = env.cast(from, tDir, 9, tN);
      if (t < 0.6 || t > best || Math.abs(tN.dot(this.up)) > 0.6) continue;
      best = t;
      this.wander.copy(from).addScaledVector(tDir, t).addScaledVector(UP, 2.5 + Math.random() * 4);
    }
    return best < Infinity;
  }

  protected pickWander(radius: number): void {
    // Any spot near home, often up on the walls and the ceiling: the crawl climbs to it
    const a = Math.random() * Math.PI * 2;
    const r = 1.5 + Math.random() * radius;
    const lift = Math.random() < 0.45 ? 3 + Math.random() * 5 : Math.random() * 1.5 - 1;
    this.wander.set(this.home.x + Math.cos(a) * r, this.home.y + lift, this.home.z + Math.sin(a) * r);
  }

  public dispose(): void {
    this.batch.release(this.block);
    super.dispose();
    if (batch === this.batch && this.batch.empty) {
      this.batch.dispose();
      batch = null;
    }
  }
}
