import * as THREE from 'three';
import type { PestSystem, PestEnv, Pest } from './Pests';
import { critterSounds } from './CritterSounds';
import type { ParticleManager } from '../particles/ParticleManager';

/** Pebbles in flight (or lying about) at once: a fixed pool, firing never allocates. */
const POOL = 10;
const GRAVITY = 12;
/** Launch speed from a quick tap to a full draw (m/s). */
const SPEED_MIN = 15;
const SPEED_MAX = 34;
/** Seconds of holding to reach a full draw. */
export const DRAW_TIME = 0.65;
/** Seconds after a release before the next draw can start. */
const COOLDOWN = 0.22;
/** A tap's shot strays up to this much (radians) from the aim; a full draw flies true. */
const SPREAD = 0.05;
/** Full-draw shots hit harder. */
const DAMAGE_TAP = 1;
const DAMAGE_FULL = 2;
const FULL = 0.98;
/** Seconds a pebble flies at most before it is put away. */
const FLIGHT_LIFE = 3;
/** Seconds a pebble lies on the ground after coming to rest, then it sinks out of sight. */
const REST_LIFE = 4;
const SINK_TIME = 0.4;
/** Bounces: normal and tangential speed kept, and the speed below which a pebble settles. */
const RESTITUTION = 0.38;
const FRICTION = 0.72;
const SETTLE_SPEED = 1.1;
/** A pebble still hurts after a bounce only while it is this fast. */
const HURT_SPEED = 9;
const RADIUS = 0.06;
/**
 * Aim assist. With a lock (Tab / middle mouse) every hip shot flies at the locked enemy; without
 * one it only bends towards a pest very close to the line of sight. RMB aiming gets an even
 * lighter pull, so the crosshair stays the player's.
 */
const ASSIST_RANGE = 32;
const ASSIST_CONE = 0.14;
const AIMED_ASSIST_CONE = 0.06;
/** Aimed shots (RMB) land where the crosshair ray meets something, up to this far (m). */
const AIM_FAR = 45;

interface Pebble {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  /** Seconds left in the current state. */
  life: number;
  state: 'off' | 'flying' | 'resting';
  damage: number;
  bounces: number;
}

/**
 * Shared with the HUD: how far the band is drawn (0..1) and when the last pebble hit an enemy
 * (performance.now() ms), for the crosshair. Mutated in place, polled once a frame.
 */
export const slingshotHud = { draw: 0, drawing: false, hitAt: -1e9, killAt: -1e9 };

const tmpDir = new THREE.Vector3();
const tmpAim = new THREE.Vector3();
const tmpFrom = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const tmpSide = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const hitOut = { t: 0 };

/**
 * The player's slingshot. Hold to draw the band (the longer, the faster, straighter and harder the
 * shot), release to let fly. Pebbles fly on a ballistic arc, swept each frame against pest bodies
 * and the physics world (walls, trees, rocks, terrain), then bounce, roll to a stop and lie about
 * for a few seconds.
 */
export class SlingshotSystem {
  private readonly pebbles: Pebble[] = [];
  private cooldown = 0;
  private next = 0;
  private drawT = 0;
  private drawing = false;
  private creaked = false;
  public env: PestEnv | null = null;

  constructor(scene: THREE.Scene, private readonly pests: PestSystem, private readonly particles?: ParticleManager) {
    const geo = new THREE.IcosahedronGeometry(RADIUS, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0x8d8478, flatShading: true });
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.pebbles.push({ mesh, vel: new THREE.Vector3(), life: 0, state: 'off', damage: 1, bounces: 0 });
    }
  }

  get ready(): boolean {
    return this.cooldown <= 0;
  }

  get isDrawing(): boolean {
    return this.drawing;
  }

  /** How far the band is drawn, 0 (a tap) to 1 (full). */
  get power(): number {
    return Math.min(1, this.drawT / DRAW_TIME);
  }

  /** Starts pulling the band back. False while reloading. */
  public beginDraw(): boolean {
    if (this.drawing) return true;
    if (this.cooldown > 0) return false;
    this.drawing = true;
    this.drawT = 0;
    this.creaked = false;
    critterSounds.slingDraw(DRAW_TIME);
    return true;
  }

  /** Lets the band go slack without shooting (the item was put away, the player started swimming, ...). */
  public cancelDraw(): void {
    if (this.drawing) critterSounds.slingCancel();
    this.drawing = false;
    this.drawT = 0;
  }

  /** Ends the draw; returns the power it had (the caller shoots with it). */
  private endDraw(): number {
    const p = this.power;
    this.drawing = false;
    this.drawT = 0;
    this.cooldown = COOLDOWN;
    return p;
  }

  /**
   * Hip shot from `from` roughly along `aim` (unit): at the locked enemy if there is one, else
   * with a light pull towards a pest right on the line of sight. Returns the horizontal yaw of the
   * shot so the player can turn to it.
   */
  public release(from: THREE.Vector3, aim: THREE.Vector3, locked: Pest | null): number | null {
    if (!this.drawing) return null;
    const power = this.endDraw();
    const speed = THREE.MathUtils.lerp(SPEED_MIN, SPEED_MAX, power);
    const p = this.take();
    const target = locked?.alive ? locked : this.pests.findAimTarget(from, aim, ASSIST_RANGE, ASSIST_CONE);
    if (target) {
      solveArc(from, target.hitPoint(tmpAim), speed, p.vel);
    } else {
      // Free shot: along the view, a touch upward so it carries
      p.vel.copy(aim);
      p.vel.y = THREE.MathUtils.clamp(p.vel.y, -0.25, 0.6) + 0.06;
      p.vel.normalize();
    }
    return this.launch(p, from, speed, power);
  }

  /**
   * Aimed shot (RMB held): the pebble flies to where the crosshair ray (from the camera, `eye`,
   * along `aim`) first meets a pest or anything solid, on a ballistic arc from `from`. A pest just
   * beside the crosshair pulls the shot onto itself.
   */
  public releaseAimed(from: THREE.Vector3, eye: THREE.Vector3, aim: THREE.Vector3): number | null {
    if (!this.drawing) return null;
    const power = this.endDraw();
    const speed = THREE.MathUtils.lerp(SPEED_MIN, SPEED_MAX, power);
    const p = this.take();
    const pest = this.pests.segmentHit(eye, aim, AIM_FAR, 0.08, hitOut);
    const reach = pest ? hitOut.t : AIM_FAR;
    const wall = this.env ? this.env.sweep(eye, aim, reach) : -1;
    const target = tmpAim;
    if (pest && wall < 0) {
      pest.hitPoint(target); // the pest's centre, not the edge the ray grazed
    } else {
      target.copy(eye).addScaledVector(aim, wall >= 0 ? wall : reach);
      // Light magnetism: a pest a hair off the crosshair (and no nearer than what the ray hit)
      const near = this.pests.findAimTarget(eye, aim, Math.min(ASSIST_RANGE, (wall >= 0 ? wall : reach) + 1), AIMED_ASSIST_CONE);
      if (near && this.aimedOnto(near, eye, aim)) near.hitPoint(target);
    }
    solveArc(from, target, speed, p.vel);
    return this.launch(p, from, speed, power);
  }

  /** The pest is within the aimed-assist cone in 3D too (findAimTarget only checks the heading). */
  private aimedOnto(pest: Pest, eye: THREE.Vector3, aim: THREE.Vector3): boolean {
    const c = pest.hitPoint(tmpFrom);
    const dx = c.x - eye.x, dy = c.y - eye.y, dz = c.z - eye.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    return (dx * aim.x + dy * aim.y + dz * aim.z) / d > Math.cos(AIMED_ASSIST_CONE);
  }

  private take(): Pebble {
    // Prefer a free pebble, then one lying about, the oldest flying one last
    for (let i = 0; i < POOL; i++) {
      const p = this.pebbles[(this.next + i) % POOL];
      if (p.state === 'off') {
        this.next = (this.next + i + 1) % POOL;
        return p;
      }
    }
    for (let i = 0; i < POOL; i++) {
      const p = this.pebbles[(this.next + i) % POOL];
      if (p.state === 'resting') {
        this.next = (this.next + i + 1) % POOL;
        return p;
      }
    }
    const p = this.pebbles[this.next];
    this.next = (this.next + 1) % POOL;
    return p;
  }

  /** `p.vel` holds the unit direction; a weak draw strays a little. */
  private launch(p: Pebble, from: THREE.Vector3, speed: number, power: number): number {
    const stray = SPREAD * (1 - power);
    if (stray > 0) {
      tmpSide.set(p.vel.z, 0, -p.vel.x);
      if (tmpSide.lengthSq() < 1e-6) tmpSide.set(1, 0, 0);
      tmpSide.normalize();
      tmpUp.crossVectors(tmpSide, p.vel).normalize();
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * stray;
      p.vel.addScaledVector(tmpSide, Math.cos(a) * r).addScaledVector(tmpUp, Math.sin(a) * r).normalize();
    }
    p.vel.multiplyScalar(speed);
    p.mesh.position.copy(from);
    p.mesh.scale.setScalar(1);
    p.mesh.visible = true;
    p.life = FLIGHT_LIFE;
    p.state = 'flying';
    p.bounces = 0;
    p.damage = power >= FULL ? DAMAGE_FULL : DAMAGE_TAP;
    critterSounds.slingshot(from, power);
    return Math.atan2(p.vel.x, p.vel.z);
  }

  public update(dt: number): void {
    this.cooldown -= dt;
    if (this.drawing) {
      this.drawT += dt;
      if (!this.creaked && this.drawT >= DRAW_TIME) {
        this.creaked = true;
        critterSounds.slingFull();
      }
    }
    slingshotHud.draw = this.drawing ? this.power : 0;
    slingshotHud.drawing = this.drawing;

    for (const p of this.pebbles) {
      if (p.state === 'off') continue;
      p.life -= dt;
      if (p.state === 'resting') {
        if (p.life <= 0) this.retire(p);
        else if (p.life < SINK_TIME) p.mesh.scale.setScalar(p.life / SINK_TIME);
        continue;
      }
      this.fly(p, dt);
    }
  }

  private fly(p: Pebble, dt: number): void {
    p.vel.y -= GRAVITY * dt;
    const pos = p.mesh.position;
    const speed = p.vel.length();
    const len = speed * dt;
    if (len < 1e-5) return;
    const dir = tmpDir.copy(p.vel).divideScalar(speed);
    const canHurt = p.bounces === 0 || speed > HURT_SPEED;
    const pest = canHurt ? this.pests.segmentHit(pos, dir, len, RADIUS, hitOut) : null;
    const pestT = hitOut.t;
    const wall = this.env ? this.env.cast(pos, dir, len + RADIUS, tmpN) : -1;
    if (pest && (wall < 0 || pestT <= wall)) {
      pos.addScaledVector(dir, pestT);
      // Knocked along the pebble's path
      const killed = pest.health <= p.damage;
      this.pests.damage(pest, p.damage, tmpFrom.copy(pos).addScaledVector(dir, -1), 'pebble');
      critterSounds.pebbleThwack(pos, Math.min(1, speed / SPEED_MAX));
      const now = performance.now();
      slingshotHud.hitAt = now;
      if (killed) slingshotHud.killAt = now;
      // Drops off the enemy and falls
      p.vel.set(-dir.x * 2, 2.5, -dir.z * 2);
      p.bounces++;
      return;
    }
    if (wall >= 0) {
      // Stop just short of the surface and bounce off it
      pos.addScaledVector(dir, Math.max(0, wall - RADIUS));
      const vn = p.vel.dot(tmpN);
      if (vn < 0) {
        const normalPart = tmpFrom.copy(tmpN).multiplyScalar(vn);
        p.vel.sub(normalPart).multiplyScalar(FRICTION).addScaledVector(normalPart, -RESTITUTION);
      }
      if (speed > 3) critterSounds.pebbleHit(pos, Math.min(1, speed / SPEED_MAX), tmpN.y > 0.7);
      if (p.bounces === 0) this.particles?.emitJumpDust(pos);
      p.bounces++;
      // Slow on something flat enough to lie on: it settles
      if (p.vel.length() < SETTLE_SPEED && tmpN.y > 0.6) {
        p.state = 'resting';
        p.life = REST_LIFE;
        p.vel.set(0, 0, 0);
      } else if (p.bounces > 12) {
        this.retire(p);
      }
      return;
    }
    pos.addScaledVector(dir, len);
    p.mesh.rotation.x += dt * speed * 0.6;
    p.mesh.rotation.z += dt * speed * 0.25;
    if (p.life <= 0) this.retire(p);
  }

  private retire(p: Pebble): void {
    p.state = 'off';
    p.mesh.visible = false;
  }

  public dispose(): void {
    for (const p of this.pebbles) p.mesh.removeFromParent();
    this.pebbles[0]?.mesh.geometry.dispose();
    (this.pebbles[0]?.mesh.material as THREE.Material | undefined)?.dispose();
    this.pebbles.length = 0;
  }
}

/**
 * Unit launch direction (into `out`) of the lowest arc from `from` through `target` at `speed`;
 * 45 degrees (the furthest carry) when the target is out of reach.
 */
function solveArc(from: THREE.Vector3, target: THREE.Vector3, speed: number, out: THREE.Vector3): THREE.Vector3 {
  const dx = target.x - from.x, dz = target.z - from.z;
  const x = Math.hypot(dx, dz);
  const y = target.y - from.y;
  if (x < 0.05) return out.set(0, Math.sign(y) || 1, 0);
  const v2 = speed * speed;
  // tan(a) = (v^2 - sqrt(v^4 - g(g x^2 + 2 y v^2))) / (g x)
  const disc = v2 * v2 - GRAVITY * (GRAVITY * x * x + 2 * y * v2);
  const tan = disc >= 0 ? (v2 - Math.sqrt(disc)) / (GRAVITY * x) : 1;
  return out.set(dx / x, tan, dz / x).normalize();
}
