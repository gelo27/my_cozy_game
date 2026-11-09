import * as THREE from 'three';
import type { PestSystem, PestEnv } from './Pests';
import { critterSounds } from './CritterSounds';
import type { ParticleManager } from '../particles/ParticleManager';

/** Pebbles in flight at once (a fixed pool: firing never allocates). */
const POOL = 8;
const SPEED = 28;
const GRAVITY = 12;
const LIFE = 2.2;
const COOLDOWN = 0.55;
/** Auto-aim reaches this far and this wide around the aim direction. */
const AIM_RANGE = 32;
const AIM_CONE = 0.45;
/** Aimed shots (RMB) land where the crosshair ray meets something, up to this far (m). */
const AIM_FAR = 45;

interface Pebble {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  active: boolean;
}

const tmpDir = new THREE.Vector3();
const tmpAim = new THREE.Vector3();
const tmpFrom = new THREE.Vector3();
const hitOut = { t: 0 };

/**
 * The player's slingshot: pebbles fly on a ballistic arc, swept each frame against pest bodies and
 * the physics world (walls, trees, rocks, terrain), so they never pass through cover either.
 * A gentle auto-aim picks the visible pest closest to where the camera looks.
 */
export class SlingshotSystem {
  private readonly pebbles: Pebble[] = [];
  private cooldown = 0;
  private next = 0;
  public env: PestEnv | null = null;

  constructor(scene: THREE.Scene, private readonly pests: PestSystem, private readonly particles?: ParticleManager) {
    const geo = new THREE.IcosahedronGeometry(0.06, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0x8d8478, flatShading: true });
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.matrixAutoUpdate = true;
      scene.add(mesh);
      this.pebbles.push({ mesh, vel: new THREE.Vector3(), life: 0, active: false });
    }
  }

  get ready(): boolean {
    return this.cooldown <= 0;
  }

  /**
   * Shoots from `from` roughly along `aim` (unit). Returns the horizontal yaw of the shot so the
   * player can turn to it, or null while reloading.
   */
  public fire(from: THREE.Vector3, aim: THREE.Vector3): number | null {
    if (this.cooldown > 0) return null;
    this.cooldown = COOLDOWN;
    const p = this.pebbles[this.next];
    this.next = (this.next + 1) % POOL;
    const target = this.pests.findAimTarget(from, aim, AIM_RANGE, AIM_CONE);
    if (target) {
      // Aim above the target by the drop over the flight time (flat arcs: close enough)
      const c = target.hitPoint(tmpAim);
      const t = c.distanceTo(from) / SPEED;
      p.vel.subVectors(c, from);
      p.vel.y += 0.5 * GRAVITY * t * t;
    } else {
      // Free shot: along the view, a touch upward so it carries
      p.vel.copy(aim);
      p.vel.y = THREE.MathUtils.clamp(p.vel.y, -0.25, 0.6) + 0.06;
    }
    p.vel.normalize().multiplyScalar(SPEED);
    return this.launch(p, from);
  }

  /**
   * Aimed shot (RMB held): the pebble flies to exactly where the crosshair ray (from the camera,
   * `eye`, along `aim`) first meets a pest or anything solid, on a ballistic arc from `from`.
   */
  public fireAimed(from: THREE.Vector3, eye: THREE.Vector3, aim: THREE.Vector3): number | null {
    if (this.cooldown > 0) return null;
    this.cooldown = COOLDOWN;
    const p = this.pebbles[this.next];
    this.next = (this.next + 1) % POOL;
    const pest = this.pests.segmentHit(eye, aim, AIM_FAR, 0.08, hitOut);
    const reach = pest ? hitOut.t : AIM_FAR;
    const wall = this.env ? this.env.sweep(eye, aim, reach) : -1;
    const target = tmpAim;
    if (pest && wall < 0) pest.hitPoint(target); // the pest's centre, not the edge the ray grazed
    else target.copy(eye).addScaledVector(aim, wall >= 0 ? wall : reach);
    // Lowest arc through the target at SPEED: tan(a) = (v^2 - sqrt(v^4 - g(g x^2 + 2 y v^2))) / (g x)
    const dx = target.x - from.x, dz = target.z - from.z;
    const x = Math.hypot(dx, dz);
    const y = target.y - from.y;
    const v2 = SPEED * SPEED;
    const disc = v2 * v2 - GRAVITY * (GRAVITY * x * x + 2 * y * v2);
    if (x < 0.05) {
      p.vel.set(0, Math.sign(y) || 1, 0);
    } else {
      // Out of reach: 45 degrees carries furthest
      const tan = disc >= 0 ? (v2 - Math.sqrt(disc)) / (GRAVITY * x) : 1;
      p.vel.set(dx / x, tan, dz / x);
    }
    p.vel.normalize().multiplyScalar(SPEED);
    return this.launch(p, from);
  }

  private launch(p: Pebble, from: THREE.Vector3): number {
    p.mesh.position.copy(from);
    p.mesh.visible = true;
    p.life = LIFE;
    p.active = true;
    critterSounds.slingshot(from);
    return Math.atan2(p.vel.x, p.vel.z);
  }

  public update(dt: number): void {
    this.cooldown -= dt;
    for (const p of this.pebbles) {
      if (!p.active) continue;
      p.life -= dt;
      p.vel.y -= GRAVITY * dt;
      const pos = p.mesh.position;
      const speed = p.vel.length();
      const len = speed * dt;
      const dir = tmpDir.copy(p.vel).divideScalar(speed || 1);
      const pest = this.pests.segmentHit(pos, dir, len, 0.06, hitOut);
      const wall = this.env ? this.env.sweep(pos, dir, len) : -1;
      if (pest && (wall < 0 || hitOut.t <= wall)) {
        pos.addScaledVector(dir, hitOut.t);
        // Knocked along the pebble's path
        this.pests.damage(pest, 1, tmpFrom.copy(pos).addScaledVector(dir, -1));
        this.retire(p);
        continue;
      }
      if (wall >= 0) {
        pos.addScaledVector(dir, wall);
        critterSounds.pebbleHit(pos);
        this.particles?.emitJumpDust(pos);
        this.retire(p);
        continue;
      }
      pos.addScaledVector(dir, len);
      p.mesh.rotation.x += dt * 14;
      if (p.life <= 0) this.retire(p);
    }
  }

  private retire(p: Pebble): void {
    p.active = false;
    p.mesh.visible = false;
  }

  public dispose(): void {
    for (const p of this.pebbles) p.mesh.removeFromParent();
    this.pebbles[0]?.mesh.geometry.dispose();
    (this.pebbles[0]?.mesh.material as THREE.Material | undefined)?.dispose();
    this.pebbles.length = 0;
  }
}
