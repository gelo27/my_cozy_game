import * as THREE from 'three';
import type { Pest } from './PestBase';
import type { PestSystem } from './Pests';
import { EnemyHealthBars } from './EnemyHealthBars';

/*
 * Target lock for fights (Z-targeting): Tab or the middle mouse button locks onto the enemy in
 * front of the camera. While locked the camera keeps the player and the enemy in frame, the player
 * faces it and A/D circle around it; a quick mouse flick left or right moves the lock to the next
 * enemy on that side. The lock lets go when the enemy dies (or jumps to the next one close by),
 * runs too far, or stays out of sight. Developers can switch the whole feature off.
 */

const STORAGE_KEY = 'farm-lock-on';
const AUTO_KEY = 'farm-lock-on-auto';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== '0';
  } catch {
    return true;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // Private window: the switch lasts for this session only
  }
}

/** Developer switches, kept in localStorage. */
export const lockOnSettings = {
  enabled: readFlag(STORAGE_KEY),
  /** Lock by itself onto an enemy that comes close, and let go once the player gets away. */
  auto: readFlag(AUTO_KEY),
  set(on: boolean): void {
    this.enabled = on;
    writeFlag(STORAGE_KEY, on);
  },
  setAuto(on: boolean): void {
    this.auto = on;
    writeFlag(AUTO_KEY, on);
  },
};

/** Lock reach on pressing (m). */
const PICK_RANGE = 20;
/** The lock breaks past this distance (m). */
const KEEP_RANGE = 26;
/** Out of sight this long (s) breaks the lock. */
const LOST_SIGHT = 1.5;
/** After a kill the lock jumps to another enemy this close (m). */
const RETARGET_RANGE = 12;
/** Automatic mode: an enemy this close (m) gets locked by itself… */
const AUTO_RANGE = 8;
/** …and the lock lets go once the player is this far from it (m). */
const AUTO_RELEASE = 13;
/** Mouse travel (px) of a flick that switches targets. */
const FLICK_PX = 70;

const tmp = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
const tmpHit = new THREE.Vector3();

/** A red, slightly rounded arrow pointing down, with a dark rim so it reads on any background. */
function arrowTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(s * 0.14, s * 0.16);
  g.lineTo(s * 0.86, s * 0.16);
  g.lineTo(s * 0.5, s * 0.86);
  g.closePath();
  g.lineWidth = s * 0.1;
  g.strokeStyle = 'rgba(40,0,0,0.75)';
  g.stroke();
  g.fillStyle = '#ff3b30';
  g.fill();
  // Light catching the upper edge
  g.beginPath();
  g.moveTo(s * 0.22, s * 0.21);
  g.lineTo(s * 0.78, s * 0.21);
  g.lineTo(s * 0.72, s * 0.31);
  g.lineTo(s * 0.28, s * 0.31);
  g.closePath();
  g.fillStyle = 'rgba(255,190,180,0.8)';
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class LockOnSystem {
  public target: Pest | null = null;
  /** Smoothed point the camera frames (glides when the lock switches). */
  public readonly aim = new THREE.Vector3();
  private lost = 0;
  private flickX = 0;
  private flickCooldown = 0;
  private sightTimer = 0;
  private time = 0;
  private pop = 0;
  /** The current lock was taken automatically (it lets go sooner). */
  private auto = false;
  /** Enemy the player let go of by hand: not locked again by itself until the player gets away from it. */
  private dismissed: Pest | null = null;
  private autoTimer = 0;
  /** Red arrow over the locked enemy (a sprite: the same size on screen at any distance). */
  private readonly marker: THREE.Sprite;

  constructor(scene: THREE.Scene, private readonly pests: PestSystem) {
    // A bobbing arrow over the locked enemy, drawn on top so grass and walls never hide it
    this.marker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: arrowTexture(), depthTest: false, depthWrite: false, fog: false, transparent: true, sizeAttenuation: false })
    );
    this.marker.center.set(0.5, 0);
    this.marker.scale.set(0.034, 0.034, 1);
    this.marker.renderOrder = 999;
    this.marker.visible = false;
    scene.add(this.marker);
  }

  get locked(): boolean {
    return this.target !== null;
  }

  /** Lock onto the best enemy in view, or let go when already locked. */
  public toggle(player: THREE.Vector3, camForward: THREE.Vector3): void {
    if (this.target) {
      // Let go by hand: the automatic mode leaves this one alone while it stays close
      this.dismissed = this.target;
      this.release();
      return;
    }
    const p = this.pick(player, camForward, PICK_RANGE, null);
    if (p) {
      this.dismissed = null;
      this.lockOn(p);
      this.auto = false;
    }
  }

  /** Mouse (or touch) look while locked: a fast sideways flick switches targets. */
  public flick(dx: number, player: THREE.Vector3, camRight: THREE.Vector3): void {
    if (!this.target || this.flickCooldown > 0) return;
    this.flickX += dx;
    if (Math.abs(this.flickX) < FLICK_PX) return;
    const side = Math.sign(this.flickX);
    this.flickX = 0;
    this.flickCooldown = 0.35;
    const next = this.pickSide(player, camRight, side);
    if (next) this.lockOn(next, false);
  }

  /** Per frame: keeps the lock valid and moves the marker. `allowed` false lets go (driving, building, …). */
  public update(dt: number, player: THREE.Vector3, camForward: THREE.Vector3, allowed: boolean): void {
    this.time += dt;
    this.flickCooldown = Math.max(0, this.flickCooldown - dt);
    this.flickX *= Math.exp(-8 * dt);
    if (!lockOnSettings.enabled || !allowed) this.release();

    const t = this.target;
    if (t) {
      if (!t.alive || t.removed || !t.group.visible || !this.pests.pests.includes(t)) {
        // Beaten: carry on with the next enemy close by, like a fight with several of them
        const next = t.alive ? null : this.pick(player, camForward, this.auto ? AUTO_RANGE : RETARGET_RANGE, t);
        if (next) this.lockOn(next, false);
        else this.release();
      } else {
        const c = t.hitPoint(tmpHit);
        // An automatic lock lets go as soon as the player breaks away
        if (c.distanceTo(player) > (this.auto ? AUTO_RELEASE : KEEP_RANGE)) this.release();
        else {
          this.sightTimer -= dt;
          if (this.sightTimer <= 0) {
            this.sightTimer = 0.2;
            this.lost = this.canSee(player, c) ? 0 : this.lost + 0.2;
            if (this.lost >= LOST_SIGHT) this.release();
          }
        }
      }
    }

    this.updateAuto(player, camForward, allowed);

    const cur = this.target;
    if (!cur) {
      this.marker.visible = false;
      return;
    }
    const c = cur.hitPoint(tmpHit);
    this.aim.lerp(c, 1 - Math.exp(-12 * dt));
    this.marker.visible = true;
    // Above the health bar, bobbing; a quick pop when it lands on a new target
    const camDist = Math.max(1, c.distanceTo(player) + 4);
    const bob = (Math.sin(this.time * 6) * 0.5 + 0.5) * 0.012 * camDist;
    this.marker.position.set(c.x, c.y + EnemyHealthBars.offset(cur) + 0.012 * camDist + bob, c.z);
    this.pop = Math.max(0, this.pop - dt * 5);
    const sz = 0.034 * (1 + this.pop * 0.6);
    this.marker.scale.set(sz, sz, 1);
  }

  /** Facing (yaw, radians) from the player to the target, or null. */
  public facingFrom(player: THREE.Vector3): number | null {
    if (!this.target) return null;
    const dx = this.aim.x - player.x, dz = this.aim.z - player.z;
    if (dx * dx + dz * dz < 0.04) return null;
    return Math.atan2(dx, dz);
  }

  /** Automatic mode: lock onto an enemy that comes close (unless the player let go of it by hand). */
  private updateAuto(player: THREE.Vector3, camForward: THREE.Vector3, allowed: boolean): void {
    const d = this.dismissed;
    if (d && (!d.alive || d.removed || !this.pests.pests.includes(d) || d.hitPoint(tmp).distanceTo(player) > AUTO_RELEASE)) {
      this.dismissed = null;
    }
    if (this.target || !allowed || !lockOnSettings.enabled || !lockOnSettings.auto) return;
    // A few checks a second are plenty (each candidate costs a sight ray)
    this.autoTimer -= 1;
    if (this.autoTimer > 0) return;
    this.autoTimer = 6;
    const p = this.pick(player, camForward, AUTO_RANGE, this.dismissed);
    if (p) {
      this.lockOn(p);
      this.auto = true;
    }
  }

  public release(): void {
    this.target = null;
    this.auto = false;
    this.lost = 0;
    this.flickX = 0;
    this.marker.visible = false;
  }

  public dispose(): void {
    this.marker.removeFromParent();
    this.marker.material.map?.dispose();
    this.marker.material.dispose();
  }

  private lockOn(p: Pest, snap = true): void {
    const had = this.target;
    this.target = p;
    this.pop = 1;
    this.lost = 0;
    this.sightTimer = 0.2;
    if (snap || !had) p.hitPoint(this.aim);
  }

  private canSee(player: THREE.Vector3, at: THREE.Vector3): boolean {
    return this.pests.env.canSee(tmpEye.copy(player).setY(player.y + 0.6), at);
  }

  /** Nearest enemy in front of the camera (distance weighted by how far off-centre it is). */
  private pick(player: THREE.Vector3, camForward: THREE.Vector3, range: number, skip: Pest | null): Pest | null {
    let best: Pest | null = null;
    let bestScore = Infinity;
    for (const p of this.pests.pests) {
      if (p === skip || !p.alive || p.removed || !p.group.visible) continue;
      const c = p.hitPoint(tmp);
      const dx = c.x - player.x, dz = c.z - player.z;
      const d = Math.hypot(dx, dz, c.y - player.y);
      if (d > range) continue;
      const h = Math.hypot(dx, dz) || 1;
      const front = (dx * camForward.x + dz * camForward.z) / h;
      // Behind the camera only when it is right next to the player
      if (front < -0.3 && d > 4) continue;
      const score = d * (2.2 - front);
      if (score >= bestScore) continue;
      if (!this.canSee(player, p.hitPoint(tmp))) continue;
      bestScore = score;
      best = p;
    }
    return best;
  }

  /** The enemy closest in angle to the current one on the given side (+1 right, -1 left). */
  private pickSide(player: THREE.Vector3, camRight: THREE.Vector3, side: number): Pest | null {
    const cur = this.target!;
    const c0 = cur.hitPoint(tmp);
    const a0 = Math.atan2(c0.x - player.x, c0.z - player.z);
    // Screen right as a yaw sign: turning towards camRight
    const rightSign = Math.sign(Math.sin(Math.atan2(camRight.x, camRight.z) - a0)) || 1;
    let best: Pest | null = null;
    let bestOff = Infinity;
    for (const p of this.pests.pests) {
      if (p === cur || !p.alive || p.removed || !p.group.visible) continue;
      const c = p.hitPoint(tmpHit);
      if (c.distanceTo(player) > PICK_RANGE) continue;
      let off = Math.atan2(c.x - player.x, c.z - player.z) - a0;
      off = Math.atan2(Math.sin(off), Math.cos(off));
      if (Math.sign(off) * rightSign !== side) continue;
      const abs = Math.abs(off);
      if (abs >= bestOff) continue;
      if (!this.canSee(player, c)) continue;
      bestOff = abs;
      best = p;
    }
    return best;
  }
}
