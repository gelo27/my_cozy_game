import * as THREE from 'three';
import type { PestKind } from './PestBase';
import { critterSounds } from './CritterSounds';

/*
 * Feedback for the player's hits on enemies, so every blow reads and feels solid:
 *  - hit-stop: the world freezes for a few frames on impact (longer on the finishing blow),
 *  - an impact star at the hit point, a small camera kick and a shake on an axe blow,
 *  - a layered impact sound (transient crack, smack, body thump, crunch; a boom on the kill).
 * Everything here runs on real (unscaled) time, so the star and shake play through the freeze.
 */

export type HitWeapon = 'melee' | 'pebble';

/* ---------- impact star ---------- */

/** Scale of the impact star (1 was the original size). */
const STAR_SIZE = 1.7;
/** Star on a tree / rock blow: about half an enemy hit's (that one reads too big on a trunk). */
const GATHER_STAR_SIZE = 0.9;

function starTexture(): THREE.Texture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const h = s / 2;
  const glow = g.createRadialGradient(h, h, 0, h, h, h);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, s, s);
  // Four sharp rays
  g.fillStyle = '#fff';
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = i % 2 === 0 ? h * 0.98 : h * 0.14;
    g.lineTo(h + Math.cos(a) * r, h + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Burst {
  sprite: THREE.Sprite;
  life: number;
  age: number;
  size: number;
}

const STAR_POOL = 6;

class HitFeedback {
  /** Camera kick for a hit of the given strength (set by the engine). */
  public onKick: ((strength: number) => void) | null = null;
  /** Camera shake as trauma 0..1 (set by the engine): an axe blow, or the player getting hurt. */
  public onShake: ((trauma: number) => void) | null = null;

  /** Hit-stop: seconds left nearly frozen, then an ease back to full speed over `easeLen`. */
  private stop = 0;
  private ease = 0;
  private easeLen = 0;
  private easeFrom = 0.3;
  private bursts: Burst[] = [];
  private nextBurst = 0;
  private ready = false;

  /** Builds the sprite pools in `scene` (once; later calls move them to the new scene). */
  public init(scene: THREE.Scene): void {
    if (this.ready) {
      for (const b of this.bursts) scene.add(b.sprite);
      return;
    }
    this.ready = true;
    const star = starTexture();
    const mk = (map: THREE.Texture) => {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({ map, color: 0xffffff, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })
      );
      sp.renderOrder = 998;
      sp.visible = false;
      scene.add(sp);
      return sp;
    };
    for (let i = 0; i < STAR_POOL; i++) this.bursts.push({ sprite: mk(star), life: 0, age: 1, size: 1 });
  }

  /** The player struck `target` (its scene root) at `at`, from `from`. */
  public strike(at: THREE.Vector3, from: THREE.Vector3, kind: PestKind, weapon: HitWeapon, kill: boolean): void {
    const strength = (weapon === 'melee' ? 1 : 0.55) * (kill ? 1.6 : 1);
    // Micro slow-motion (like the impact of a blow in BotW): a near-freeze, then time eases back in.
    // Short on a pebble, a proper slow-mo moment on the finishing blow
    const [hold, ease, slow] = kill ? [0.09, 0.42, 0.18] : weapon === 'melee' ? [0.055, 0.16, 0.3] : [0.03, 0.08, 0.45];
    if (hold >= this.stop) {
      this.stop = hold;
      this.ease = this.easeLen = Math.max(ease, this.ease);
      this.easeFrom = slow;
    }
    this.onKick?.(strength);

    // An axe blow shakes the view: small, but it lands
    if (weapon === 'melee') this.onShake?.(kill ? 0.6 : 0.42);

    this.burst(at, STAR_SIZE * (kill ? 1.5 : 1) * (weapon === 'melee' ? 1.1 : 0.75));
    critterSounds.impact(at, kind, weapon, kill);
  }

  /** Just the impact star of an axe blow on an enemy (a tree chopped, an ore vein struck); `final` = the breaking blow. */
  public star(at: THREE.Vector3, final = false): void {
    this.burst(at, GATHER_STAR_SIZE * (final ? 1.4 : 1));
  }

  /** World time multiplier for this frame (hit-stop); call once per frame with real dt. */
  public timeScale(rawDt: number): number {
    if (this.stop > 0) {
      this.stop -= rawDt;
      return 0.04;
    }
    if (this.ease <= 0) return 1;
    this.ease -= rawDt;
    const t = 1 - Math.max(0, this.ease) / this.easeLen;
    // Smoothstep from slow to full speed
    return this.easeFrom + (1 - this.easeFrom) * t * t * (3 - 2 * t);
  }

  public update(rawDt: number): void {
    for (const b of this.bursts) {
      if (b.age >= b.life) continue;
      b.age += rawDt;
      const t = b.age / b.life;
      if (t >= 1) {
        b.sprite.visible = false;
        continue;
      }
      // Pops out fast, then shrinks away
      const s = b.size * (t < 0.25 ? t / 0.25 : 1 - (t - 0.25) * 0.6);
      b.sprite.scale.setScalar(s);
      (b.sprite.material as THREE.SpriteMaterial).opacity = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;
    }
  }

  private burst(at: THREE.Vector3, size: number): void {
    const b = this.bursts[this.nextBurst];
    if (!b) return;
    this.nextBurst = (this.nextBurst + 1) % this.bursts.length;
    b.sprite.position.copy(at);
    (b.sprite.material as THREE.SpriteMaterial).rotation = Math.random() * Math.PI;
    b.sprite.visible = true;
    b.size = size;
    b.age = 0;
    b.life = 0.2;
    b.sprite.scale.setScalar(0.01);
  }
}

export const hitFx = new HitFeedback();
