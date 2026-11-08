import * as THREE from 'three';

const MAX_LEAVES = 200;
const GRAVITY = 1.1;
/** Gusts carrying a stream of leaves that can be in the air at once. */
const MAX_WHIRLS = 3;
/** Leaves a gust picks up, the gap (s) between them along the stream, and how long it carries them. */
const WHIRL_LEAVES = 20;
const WHIRL_SPACING = 0.07;
const WHIRL_LIFE = 4.2;
/** Gust speed along its path (m/s). */
const WHIRL_SPEED = 4.5;
/** Seconds a leaf lies on the ground before it is gone. */
const REST_SECONDS = 1.6;

interface Leaf {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  rot: THREE.Euler;
  /** Flutter phase and rate. */
  phase: number;
  rate: number;
  life: number;
  maxLife: number;
  size: number;
  /** Ground height under the leaf (taken where it started; it drifts only a little). */
  floor: number;
  /** Lying on the ground. */
  resting: boolean;
  /** Whirl slot carrying the leaf (-1: free) and that whirl's generation when it was caught. */
  whirl: number;
  gen: number;
  /** In a gust: its delay behind the head (s), and the phase and radius of its curl around the path. */
  orbitA: number;
  orbitR: number;
  orbitH: number;
}

/**
 * A gust: a ribbon of leaves following one path through the air, low over the ground, rising,
 * curling through a vertical loop (sometimes two) and flying on, every leaf a moment behind the
 * one before.
 */
interface Whirl {
  /** Start of the path (on the ground) and its heading (XZ) and side vectors. */
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  side: THREE.Vector3;
  /** Cruise height above the ground, loop start / length (s), loop radius, second loop on. */
  height: number;
  loopAt: number;
  loopTime: number;
  loopR: number;
  twoLoops: boolean;
  phase: number;
  age: number;
  /** Bumped on every reuse, so leaves of an older whirl in the slot let go. */
  gen: number;
  alive: boolean;
}

/**
 * Leaves in the air: shaken off a crown by the axe, letting go of a tree now and then, or caught
 * up by a gust and whirled round before they drift down. One instanced mesh of small two-sided
 * leaf quads (a single draw call, a fixed pool, no allocation per frame). They sway side to side
 * as they fall, drift with a slowly turning breeze, settle flat on the ground and fade.
 */
export class FallingLeaves {
  private readonly mesh: THREE.InstancedMesh;
  private readonly leaves: Leaf[] = [];
  private readonly whirls: Whirl[] = [];
  /** Live leaves are the first `live` entries (compacted by swapping). */
  private live = 0;
  private windAngle = Math.random() * Math.PI * 2;
  private time = 0;
  private static readonly _m = new THREE.Matrix4();
  private static readonly _q = new THREE.Quaternion();
  private static readonly _s = new THREE.Vector3();
  private static readonly _c = new THREE.Color();
  private static readonly _base = new THREE.Color();
  private static readonly _v = new THREE.Vector3();

  constructor(scene: THREE.Scene, private readonly groundAt: ((x: number, z: number) => number) | null = null) {
    // A pointed leaf: 4 vertices, 2 triangles
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.5, 0.32, 0, 0, 0, 0, 0.5, -0.32, 0, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(g, mat, MAX_LEAVES);
    this.mesh.name = 'FallingLeaves';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    for (let i = 0; i < MAX_LEAVES; i++) {
      this.leaves.push({
        pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), rot: new THREE.Euler(),
        phase: 0, rate: 0, life: 0, maxLife: 1, size: 0.1, floor: -Infinity, resting: false,
        whirl: -1, gen: 0, orbitA: 0, orbitR: 0, orbitH: 0,
      });
    }
    for (let i = 0; i < MAX_WHIRLS; i++) {
      this.whirls.push({
        pos: new THREE.Vector3(), dir: new THREE.Vector3(), side: new THREE.Vector3(),
        height: 1.5, loopAt: 1, loopTime: 1, loopR: 1, twoLoops: false, phase: 0, age: 0, gen: 0, alive: false,
      });
    }
    scene.add(this.mesh);
  }

  /**
   * `count` leaves from random spots in a crown: a disc of `radius` around `centre`, `height`
   * tall, in the crown's colour (varied a little per leaf). `burst` scales how hard they are
   * thrown outwards (1: shaken loose, 0.3: a leaf just letting go).
   */
  public emit(centre: THREE.Vector3, radius: number, height: number, count: number, color: THREE.ColorRepresentation, burst = 1): void {
    const base = FallingLeaves._base.set(color);
    for (let n = 0; n < count; n++) {
      const i = this.take();
      const l = this.leaves[i];
      const a = Math.random() * Math.PI * 2;
      const r = radius * Math.sqrt(Math.random());
      l.pos.set(centre.x + Math.cos(a) * r, centre.y + (Math.random() - 0.5) * height, centre.z + Math.sin(a) * r);
      const out = 0.6 * burst * (0.6 + Math.random() * 0.8);
      l.vel.set(Math.cos(a) * out, (0.3 + Math.random() * 0.6) * Math.min(1.5, burst), Math.sin(a) * out);
      this.start(l, base, i);
      // Long enough to reach the ground from the crown at the leaf's slow fall
      const drop = Number.isFinite(l.floor) ? l.pos.y - l.floor : 2;
      l.maxLife = l.life = Math.min(12, Math.max(2.5, drop / 0.7 + 1)) + Math.random();
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * A gust sweeps a stream of leaves past `near` (the player): it starts upwind, picks the leaves
   * up off the ground one after another and carries them along a path with a loop in it.
   */
  public whirl(near: THREE.Vector3, color: THREE.ColorRepresentation): void {
    let slot = -1;
    for (let i = 0; i < MAX_WHIRLS; i++) if (!this.whirls[i].alive) slot = i;
    if (slot < 0) return;
    const w = this.whirls[slot];
    w.alive = true;
    w.age = 0;
    w.gen++;
    // Along the breeze, give or take, passing a few metres to one side of the player
    const a = this.windAngle + (Math.random() - 0.5) * 0.8;
    w.dir.set(Math.cos(a), 0, Math.sin(a));
    w.side.set(-w.dir.z, 0, w.dir.x);
    const off = (Math.random() < 0.5 ? -1 : 1) * (7 + Math.random() * 9);
    w.pos.copy(near).addScaledVector(w.dir, -(14 + Math.random() * 10)).addScaledVector(w.side, off);
    w.height = 1.1 + Math.random() * 1.2;
    w.loopAt = 1.2 + Math.random() * 1.0;
    w.loopTime = 0.9 + Math.random() * 0.4;
    w.loopR = 0.9 + Math.random() * 0.6;
    w.twoLoops = Math.random() < 0.3;
    w.phase = Math.random() * 6.28;
    const base = FallingLeaves._base.set(color);
    for (let n = 0; n < WHIRL_LEAVES; n++) {
      const i = this.take();
      const l = this.leaves[i];
      l.orbitH = n * WHIRL_SPACING * (0.85 + Math.random() * 0.3);
      l.orbitA = Math.random() * Math.PI * 2;
      l.orbitR = 0.08 + Math.random() * 0.3;
      l.vel.set(0, 0, 0);
      this.whirlPoint(w, -l.orbitH, l.pos);
      // Some yellowed leaves among the green ones
      const k = Math.random();
      this.start(l, k < 0.3 ? FallingLeaves._c.setRGB(base.r * 1.6, base.g * 1.1, base.b * 0.5) : base, i);
      l.whirl = slot;
      l.gen = w.gen;
      l.maxLife = l.life = WHIRL_LIFE + l.orbitH + 3 + Math.random() * 2;
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Point of gust `w`'s path `t` seconds after it set off (before 0: still lying where it will be
   * picked up). Straight on at WHIRL_SPEED, lifting off the ground at first; in a loop the stream
   * goes up, back over itself and down again while still creeping forward, like a curl of wind.
   */
  private whirlPoint(w: Whirl, t: number, out: THREE.Vector3): THREE.Vector3 {
    const tc = Math.max(0, t);
    let s = 0;
    let h = 0;
    const loops = w.twoLoops ? 2 : 1;
    const loopEnd = w.loopAt + w.loopTime * loops;
    if (tc < w.loopAt) {
      s = WHIRL_SPEED * tc;
    } else if (tc < loopEnd) {
      const lt = tc - w.loopAt;
      const th = ((lt / w.loopTime) % 1) * Math.PI * 2;
      s = WHIRL_SPEED * w.loopAt + w.loopR * Math.sin(th) + WHIRL_SPEED * 0.3 * lt;
      h = w.loopR * (1 - Math.cos(th));
    } else {
      s = WHIRL_SPEED * (w.loopAt + 0.3 * w.loopTime * loops) + WHIRL_SPEED * (tc - loopEnd);
    }
    // Lift off the ground over the first half second, and wander a little
    const lift = Math.min(1, tc / 0.5);
    const cruise = 0.15 + (w.height - 0.15) * lift * lift * (3 - 2 * lift);
    const wander = Math.sin(tc * 1.7 + w.phase) * 0.6;
    out.copy(w.pos).addScaledVector(w.dir, s).addScaledVector(w.side, wander);
    const ground = this.groundAt ? this.groundAt(out.x, out.z) : w.pos.y;
    out.y = ground + (t < 0 ? 0.04 : cruise + h + Math.sin(tc * 2.3 + w.phase) * 0.2 * lift);
    return out;
  }

  public update(dt: number): void {
    this.time += dt;
    // The breeze turns slowly
    this.windAngle += dt * 0.03;
    const windX = Math.cos(this.windAngle) * 0.3;
    const windZ = Math.sin(this.windAngle) * 0.3;
    for (let i = 0; i < MAX_WHIRLS; i++) {
      const w = this.whirls[i];
      if (!w.alive) continue;
      w.age += dt;
      // Alive until its last leaf has been let go
      if (w.age >= WHIRL_LIFE + WHIRL_LEAVES * WHIRL_SPACING * 1.2) w.alive = false;
    }
    if (this.live === 0) {
      this.mesh.count = 0;
      return;
    }
    const m = FallingLeaves._m;
    for (let i = this.live - 1; i >= 0; i--) {
      const l = this.leaves[i];
      l.life -= dt;
      if (l.life <= 0) {
        this.swap(i, this.live - 1);
        this.live--;
        continue;
      }
      if (l.whirl >= 0) {
        const w = this.whirls[l.whirl];
        if (w.alive && w.gen === l.gen && w.age - l.orbitH < WHIRL_LIFE) {
          this.orbit(l, w, dt);
        } else {
          // Out of the gust: it flies on the way it was going and flutters down
          const t = Math.max(0, w.age - l.orbitH);
          this.whirlPoint(w, t - 0.05, FallingLeaves._v);
          l.vel.subVectors(l.pos, FallingLeaves._v).multiplyScalar(0.5 / 0.05);
          l.vel.y = Math.min(l.vel.y, 0.5);
          l.floor = this.groundAt ? this.groundAt(l.pos.x, l.pos.z) : l.floor;
          l.whirl = -1;
        }
      } else if (!l.resting) {
        this.fall(l, dt, windX, windZ);
      }
      const fade = Math.min(1, l.life / 0.5);
      m.compose(l.pos, FallingLeaves._q.setFromEuler(l.rot), FallingLeaves._s.setScalar(l.size * fade));
      this.mesh.setMatrixAt(i, m);
    }
    this.mesh.count = this.live;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Swaying descent with drag; lands flat on the ground and rests a moment. */
  private fall(l: Leaf, dt: number, windX: number, windZ: number): void {
    l.vel.y -= GRAVITY * dt;
    const drag = Math.exp(-dt * 2.2);
    l.vel.multiplyScalar(drag);
    l.vel.y = Math.max(l.vel.y, -0.9);
    const age = l.maxLife - l.life;
    const sway = Math.sin(l.phase + age * l.rate);
    l.pos.x += (l.vel.x + sway * 0.5 + windX) * dt;
    l.pos.y += l.vel.y * dt;
    l.pos.z += (l.vel.z + Math.cos(l.phase * 1.3 + age * l.rate) * 0.3 + windZ) * dt;
    l.rot.x += l.spin.x * dt;
    l.rot.y += l.spin.y * dt;
    l.rot.z += l.spin.z * dt + sway * 0.02;
    if (l.pos.y <= l.floor + 0.03) {
      l.pos.y = l.floor + 0.03;
      l.resting = true;
      l.rot.set((Math.random() - 0.5) * 0.3, l.rot.y, (Math.random() - 0.5) * 0.3);
      l.life = Math.min(l.life, REST_SECONDS);
    }
  }

  /** Along the gust's path, its delay behind the head, curling around the path as it goes. */
  private orbit(l: Leaf, w: Whirl, dt: number): void {
    const t = w.age - l.orbitH;
    this.whirlPoint(w, t, l.pos);
    if (t > 0) {
      const a = l.orbitA + t * 5;
      l.pos.addScaledVector(w.side, Math.cos(a) * l.orbitR);
      l.pos.y += Math.sin(a) * l.orbitR;
      l.rot.x += l.spin.x * dt * 1.5;
      l.rot.y += l.spin.y * dt;
      l.rot.z += l.spin.z * dt * 1.5;
    }
  }

  /** A free pool slot (the oldest leaf gives way when the pool is full). */
  private take(): number {
    if (this.live >= MAX_LEAVES) {
      this.swap(0, this.live - 1);
      this.live--;
    }
    return this.live++;
  }

  /** Common start for a new leaf in slot `i`, coloured around `base`. */
  private start(l: Leaf, base: THREE.Color, i: number): void {
    l.spin.set((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 5);
    l.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    l.phase = Math.random() * 6.28;
    l.rate = 2.5 + Math.random() * 2;
    l.size = 0.13 + Math.random() * 0.08;
    l.resting = false;
    l.whirl = -1;
    l.floor = this.groundAt ? this.groundAt(l.pos.x, l.pos.z) : -Infinity;
    const k = 0.8 + Math.random() * 0.4;
    this.mesh.setColorAt(i, FallingLeaves._c.setRGB(base.r * k, base.g * k, base.b * k));
  }

  private swap(a: number, b: number): void {
    if (a === b) return;
    const t = this.leaves[a];
    this.leaves[a] = this.leaves[b];
    this.leaves[b] = t;
    const c = this.mesh.instanceColor;
    if (c) {
      for (let k = 0; k < 3; k++) {
        const v = c.getComponent(a, k);
        c.setComponent(a, k, c.getComponent(b, k));
        c.setComponent(b, k, v);
      }
      c.needsUpdate = true;
    }
  }
}
