import * as THREE from 'three';
import type { Pest } from './PestBase';
import type { PestSystem } from './Pests';

/*
 * Minimal enemy health bars (in the spirit of BotW): a thin bar over an enemy that shows up when it
 * is hit or targeted and fades out a few seconds after the last blow. The red fill drops at once;
 * a pale "damage" strip behind it catches up a moment later, so every hit reads at a glance.
 * Same size on screen near or far, drawn over everything.
 */

/** Seconds after the last hit the bar stays up (it always shows on the locked target). */
const SHOW_FOR = 4;
/** Bar width on screen, as metres per metre of camera distance. */
const SCREEN_SIZE = 0.085;

const unit = new THREE.PlaneGeometry(1, 1);
/** Left-anchored plane: scale.x is the fill fraction. */
const fromLeft = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0);
const tmp = new THREE.Vector3();

interface Bar {
  group: THREE.Group;
  back: THREE.MeshBasicMaterial;
  lagMat: THREE.MeshBasicMaterial;
  fillMat: THREE.MeshBasicMaterial;
  lag: THREE.Mesh;
  fill: THREE.Mesh;
  /** Shown fraction of the pale strip (catches up with the health). */
  lagFrac: number;
  /** Pause before the strip starts to shrink (s). */
  lagHold: number;
  lastHealth: number;
  opacity: number;
}

function mat(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, fog: false });
}

export class EnemyHealthBars {
  private readonly bars = new Map<Pest, Bar>();
  private readonly seen = new Set<Pest>();
  private time = 0;

  constructor(private readonly scene: THREE.Scene, private readonly pests: PestSystem) {}

  public update(rawDt: number, camera: THREE.Camera, locked: Pest | null): void {
    this.time += rawDt;
    const now = performance.now() / 1000;
    this.seen.clear();
    for (const p of this.pests.pests) {
      this.seen.add(p);
      const want = p.alive && p.group.visible && (p === locked || now - p.hurtAt < SHOW_FOR);
      let bar = this.bars.get(p);
      if (!want && !bar) continue;
      if (!bar) this.bars.set(p, (bar = this.make(p)));
      this.step(bar, p, want, rawDt, camera);
    }
    // Bars of enemies that are gone (or faded out)
    for (const [p, bar] of this.bars) {
      // Gone from the world (taken out of the list without `removed`, too), or faded out
      if (p.removed || !this.seen.has(p) || (bar.opacity <= 0 && p !== locked)) this.drop(p, bar);
    }
  }

  /** Height above the enemy's body centre where its bar sits (the lock arrow goes above it). */
  public static offset(p: Pest): number {
    return p.hitRadius + 0.42;
  }

  public dispose(): void {
    for (const [p, bar] of this.bars) this.drop(p, bar);
  }

  private make(p: Pest): Bar {
    const group = new THREE.Group();
    const back = mat(0x101014, 0.6);
    const lagMat = mat(0xfff1c4, 0.9);
    const fillMat = mat(0xe8443a, 1);
    const bg = new THREE.Mesh(unit, back);
    bg.scale.set(1.06, 0.13, 1);
    const lag = new THREE.Mesh(fromLeft, lagMat);
    const fill = new THREE.Mesh(fromLeft, fillMat);
    for (const m of [lag, fill]) {
      m.position.x = -0.5;
      m.scale.y = 0.07;
    }
    lag.position.z = 0.001;
    fill.position.z = 0.002;
    bg.renderOrder = 996;
    lag.renderOrder = 997;
    fill.renderOrder = 998;
    group.add(bg, lag, fill);
    group.visible = false;
    this.scene.add(group);
    const frac = Math.max(0, p.health / p.maxHealth);
    return { group, back, lagMat, fillMat, lag, fill, lagFrac: frac, lagHold: 0, lastHealth: p.health, opacity: 0 };
  }

  private step(bar: Bar, p: Pest, want: boolean, dt: number, camera: THREE.Camera): void {
    bar.opacity = Math.max(0, Math.min(1, bar.opacity + (want ? 6 : -2.5) * dt));
    bar.group.visible = bar.opacity > 0.01;
    if (!bar.group.visible) return;
    const frac = Math.max(0, p.health / p.maxHealth);
    if (p.health < bar.lastHealth) bar.lagHold = 0.45;
    bar.lastHealth = p.health;
    if (bar.lagHold > 0) bar.lagHold -= dt;
    else bar.lagFrac += (frac - bar.lagFrac) * Math.min(1, dt * 5);
    if (bar.lagFrac < frac) bar.lagFrac = frac;
    bar.fill.scale.x = Math.max(1e-3, frac);
    bar.lag.scale.x = Math.max(1e-3, bar.lagFrac);
    bar.back.opacity = 0.6 * bar.opacity;
    bar.lagMat.opacity = 0.9 * bar.opacity;
    bar.fillMat.opacity = bar.opacity;

    const c = p.hitPoint(tmp);
    bar.group.position.set(c.x, c.y + EnemyHealthBars.offset(p), c.z);
    bar.group.quaternion.copy(camera.quaternion);
    const d = camera.position.distanceTo(bar.group.position);
    // Right at the lens it would smear across the screen
    if (d < 1.2) {
      bar.group.visible = false;
      return;
    }
    bar.group.scale.setScalar(THREE.MathUtils.clamp(d * SCREEN_SIZE, 0.35, 4));
  }

  private drop(p: Pest, bar: Bar): void {
    bar.group.removeFromParent();
    bar.back.dispose();
    bar.lagMat.dispose();
    bar.fillMat.dispose();
    this.bars.delete(p);
  }
}
