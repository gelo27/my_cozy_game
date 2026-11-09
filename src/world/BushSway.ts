import * as THREE from 'three';
import { PropInstance, PropSystem } from './PropSystem';
import { uBushBend, uBushBendCount } from './TreeModels';
import { uFlowerBend, uFlowerBendCount } from './FlowerModels';
import { audioEngine } from '../audio/AudioEngine';

/** Spring stiffness and damping (underdamped: a couple of wobbles). */
const SPRING_K = 60;
const SPRING_DAMP = 5;
const MAX_PUSHERS = 16;

/** What one sway system parts: a prop type, how far it reaches and the shader uniforms it feeds. */
export interface SwayOptions {
  type: string;
  /** Reach around the prop's centre at scale 1 (m). */
  radius: number;
  /** Top offset (m) at full push. */
  maxBend: number;
  /** Per bent prop: world x, z of its instance, then its top's world XZ offset. */
  bend: { value: THREE.Vector4[] };
  bendCount: { value: number };
  /** Rustle sounds while something moves through it. */
  rustle: boolean;
}

/** Tulip clumps: a small reach, a light lean like the field corn, no rustle (meadows are full of them). */
export const FLOWER_SWAY_OPTIONS: SwayOptions = {
  type: 'flowers', radius: 0.38, maxBend: 0.2, bend: uFlowerBend, bendCount: uFlowerBendCount, rustle: false,
};

const BUSH_OPTIONS: SwayOptions = {
  type: 'bush', radius: 0.72, maxBend: 0.32, bend: uBushBend, bendCount: uBushBendCount, rustle: true,
};
/** A bush rustles at most this often (s), and only when the push on it changes this fast (m/s). */
const RUSTLE_GAP = 0.3;
const RUSTLE_SPEED = 0.35;

interface Bent {
  prop: PropInstance;
  bend: THREE.Vector2;
  vel: THREE.Vector2;
  target: THREE.Vector2;
  lastTarget: THREE.Vector2;
  /** Seconds since its last rustle. */
  quiet: number;
  /** Axe shiver: a fast small shake on top of the spring, fading out. */
  shiver: number;
  shiverT: number;
  touched: boolean;
}

/**
 * Bushes (and, with FLOWER_SWAY_OPTIONS, tulip clumps) lean away from the player, pets and the moped and spring back (like the field wheat),
 * and shake when the axe hits them. Only bushes a pusher touches are simulated (at most
 * as many as the uniform array holds); the lean goes to the material as that small array, so the bush
 * instances, their buffers and every other bush cost nothing extra. Rustles play as a pusher moves
 * through a bush.
 */
export class BushSway {
  private readonly pushers = new Float32Array(MAX_PUSHERS * 4);
  private pusherCount = 0;
  /** Simulated bushes; entries are recycled through `pool`, so the frame loop allocates nothing. */
  private readonly bent: Bent[] = [];
  private readonly pool: Bent[] = [];
  // Scratch for the forEachNear callback (made once)
  private px = 0;
  private pz = 0;
  private pr = 0;
  private readonly visit = (p: PropInstance) => this.touch(p);

  private readonly max: number;

  constructor(private readonly props: PropSystem, private readonly opts: SwayOptions = BUSH_OPTIONS) {
    this.max = opts.bend.value.length;
  }

  /** Call once per frame before update(), then addPusher() for each body that parts the bushes. */
  public clearPushers(): void {
    this.pusherCount = 0;
  }

  public addPusher(x: number, y: number, z: number, radius: number): void {
    if (this.pusherCount >= MAX_PUSHERS) return;
    const o = this.pusherCount++ * 4;
    this.pushers[o] = x;
    this.pushers[o + 1] = y;
    this.pushers[o + 2] = z;
    this.pushers[o + 3] = radius;
  }

  /** An axe hit: the bush jolts away along `direction` (XZ) and wobbles back. */
  public kick(prop: PropInstance, direction: THREE.Vector3, strength = 1): void {
    const b = this.get(prop);
    if (!b) return;
    b.vel.x += direction.x * 6.5 * strength;
    b.vel.y += direction.z * 6.5 * strength;
    b.shiver = 0.09 * strength;
    b.shiverT = 0;
  }

  /** Stops simulating a bush (it was chopped or removed). */
  public forget(propId: number): void {
    for (let i = this.bent.length - 1; i >= 0; i--) {
      if (this.bent[i].prop.id === propId) this.release(i);
    }
  }

  public update(dt: number): void {
    for (let i = 0; i < this.bent.length; i++) {
      const b = this.bent[i];
      b.lastTarget.copy(b.target);
      b.target.set(0, 0);
      b.touched = false;
    }
    for (let p = 0; p < this.pusherCount; p++) {
      const o = p * 4;
      this.px = this.pushers[o];
      this.pz = this.pushers[o + 2];
      this.pr = this.pushers[o + 3];
      this.py = this.pushers[o + 1];
      this.props.forEachNear(this.px, this.pz, this.pr + this.opts.radius * 1.5, this.visit, this.opts.type);
    }

    const h = Math.min(dt, 1 / 30);
    let n = 0;
    for (let i = this.bent.length - 1; i >= 0; i--) {
      const b = this.bent[i];
      const t = b.target;
      const tl = t.length();
      const maxBend = this.opts.maxBend;
      if (tl > maxBend) t.multiplyScalar(maxBend / tl);
      b.vel.x += (SPRING_K * (t.x - b.bend.x) - SPRING_DAMP * b.vel.x) * h;
      b.vel.y += (SPRING_K * (t.y - b.bend.y) - SPRING_DAMP * b.vel.y) * h;
      b.bend.x += b.vel.x * h;
      b.bend.y += b.vel.y * h;
      // Rustle while something moves through it
      b.quiet += dt;
      if (this.opts.rustle && b.touched && dt > 0) {
        const speed = Math.hypot(t.x - b.lastTarget.x, t.y - b.lastTarget.y) / dt;
        if (speed > RUSTLE_SPEED && b.quiet > RUSTLE_GAP) {
          b.quiet = 0;
          audioEngine.at(b.prop.position, 4).playBushRustle(Math.min(1, speed / 2.5));
        }
      }
      if (b.shiver > 0) {
        b.shiverT += dt;
        b.shiver = Math.max(0, b.shiver - dt * 0.16);
      }
      const settled = b.shiver === 0 && !b.touched && Math.abs(b.bend.x) + Math.abs(b.bend.y) < 0.002 && Math.abs(b.vel.x) + Math.abs(b.vel.y) < 0.01;
      if (settled) {
        this.release(i);
        continue;
      }
    }
    for (let i = 0; i < this.bent.length && n < this.max; i++, n++) {
      const b = this.bent[i];
      // The shiver sways the top in a quick figure-of-eight
      const sx = b.shiver * Math.sin(b.shiverT * 38);
      const sz = b.shiver * Math.sin(b.shiverT * 29 + 1.3);
      this.opts.bend.value[n].set(b.prop.position.x, b.prop.position.z, b.bend.x + sx, b.bend.y + sz);
    }
    this.opts.bendCount.value = n;
  }

  private py = 0;

  private touch(p: PropInstance): void {
    const dy = this.py - p.position.y;
    if (dy < -1.5 || dy > 2.2) return;
    const dx = p.position.x - this.px;
    const dz = p.position.z - this.pz;
    const r = this.pr + this.opts.radius * p.scale;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) return;
    const b = this.get(p);
    if (!b) return;
    const d = Math.sqrt(d2);
    const f = 1 - d / r;
    const push = this.opts.maxBend * f * (2 - f);
    if (d > 1e-3) b.target.x += (dx / d) * push, b.target.y += (dz / d) * push;
    else b.target.x += push;
    if (this.opts.rustle && !b.touched && b.lastTarget.lengthSq() === 0 && b.quiet > RUSTLE_GAP) {
      // First contact always rustles a little
      b.quiet = 0;
      audioEngine.at(p.position, 4).playBushRustle(0.5);
    }
    b.touched = true;
  }

  /** The simulated entry for a bush, starting one if there is room. */
  private get(p: PropInstance): Bent | null {
    for (let i = 0; i < this.bent.length; i++) if (this.bent[i].prop === p) return this.bent[i];
    if (this.bent.length >= this.max) return null;
    const b = this.pool.pop() ?? {
      prop: p, bend: new THREE.Vector2(), vel: new THREE.Vector2(), target: new THREE.Vector2(), lastTarget: new THREE.Vector2(), quiet: 0, touched: false, shiver: 0, shiverT: 0,
    };
    b.prop = p;
    b.bend.set(0, 0);
    b.vel.set(0, 0);
    b.target.set(0, 0);
    b.lastTarget.set(0, 0);
    b.quiet = RUSTLE_GAP + 1;
    b.touched = false;
    b.shiver = 0;
    this.bent.push(b);
    return b;
  }

  private release(i: number): void {
    const b = this.bent[i];
    this.bent[i] = this.bent[this.bent.length - 1];
    this.bent.pop();
    this.pool.push(b);
  }
}
