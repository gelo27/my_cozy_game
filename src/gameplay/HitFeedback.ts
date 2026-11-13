import * as THREE from 'three';
import type { PestKind } from './PestBase';
import { critterSounds } from './CritterSounds';

/*
 * Feedback for the player's hits on enemies, so every blow reads and feels solid:
 *  - the enemy flashes white (its own materials, swapped for a moment for copies that mix to white),
 *  - hit-stop: the world freezes for a few frames on impact (longer on the finishing blow),
 *  - an impact star and sparks at the hit point, a small camera kick,
 *  - a layered impact sound (transient crack, smack, body thump, crunch; a boom on the kill).
 * Everything here runs on real (unscaled) time, so the flash and sparks play through the freeze.
 */

export type HitWeapon = 'melee' | 'pebble';

/** Seconds the flash stays fully white, then fades. */
const FLASH_HOLD = 0.06;
const FLASH_FADE = 0.12;

interface FlashEntry {
  mesh: THREE.Mesh;
  original: THREE.Material | THREE.Material[];
  flash: THREE.Material | THREE.Material[];
}

/** A target's white flash: lazily made copies of its materials sharing one uniform. */
class Flash {
  public readonly u = { value: 0 };
  public t = 1e9;
  public on = false;
  private readonly entries = new Map<THREE.Mesh, FlashEntry>();

  constructor(private readonly root: THREE.Object3D) {}

  public trigger(): void {
    // Meshes can come later (a rigged model that loads async): pick up any new ones
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (o as unknown as THREE.Sprite).isSprite || o.userData.noFlash || this.entries.has(m)) return;
      const src = m.material;
      const make = (mat: THREE.Material) => flashMaterial(mat, this.u);
      this.entries.set(m, { mesh: m, original: src, flash: Array.isArray(src) ? src.map(make) : make(src) });
    });
    this.t = 0;
    this.u.value = 1;
    if (this.on) return;
    this.on = true;
    for (const e of this.entries.values()) {
      // The pest may have swapped a material since the copies were made: follow it
      if (e.mesh.material !== e.original && e.mesh.material !== e.flash) {
        disposeFlash(e.flash);
        e.original = e.mesh.material;
        e.flash = Array.isArray(e.original) ? e.original.map((x) => flashMaterial(x, this.u)) : flashMaterial(e.original, this.u);
      }
      e.mesh.material = e.flash;
    }
  }

  /** Returns false once the flash is over (materials restored). */
  public update(dt: number): boolean {
    if (!this.on) return false;
    this.t += dt;
    this.u.value = this.t < FLASH_HOLD ? 1 : Math.max(0, 1 - (this.t - FLASH_HOLD) / FLASH_FADE);
    if (this.u.value > 0) return true;
    this.restore();
    return false;
  }

  public restore(): void {
    this.on = false;
    for (const e of this.entries.values()) if (e.mesh.material === e.flash) e.mesh.material = e.original;
  }

  public dispose(): void {
    this.restore();
    for (const e of this.entries.values()) disposeFlash(e.flash);
    this.entries.clear();
  }
}

function disposeFlash(m: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(m)) m.forEach((x) => x.dispose());
  else m.dispose();
}

/** A copy of `src` whose final colour mixes to white by `u.value` (its own shader hooks kept). */
function flashMaterial(src: THREE.Material, u: { value: number }): THREE.Material {
  if ((src as THREE.RawShaderMaterial).isRawShaderMaterial) return src;
  const m = src.clone();
  const prev = src.onBeforeCompile;
  const prevKey = src.customProgramCacheKey.bind(src);
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.uniforms.uHitFlash = u;
    const fs = shader.fragmentShader;
    const end = fs.lastIndexOf('}');
    shader.fragmentShader =
      'uniform float uHitFlash;\n' + fs.slice(0, end) + '  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), uHitFlash);\n' + fs.slice(end);
  };
  m.customProgramCacheKey = () => prevKey() + '|hitflash';
  return m;
}

/* ---------- impact star and sparks ---------- */

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

function dotTexture(): THREE.Texture {
  const s = 32;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,250,220,0.9)');
  grad.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
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

interface Spark {
  sprite: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  age: number;
}

const STAR_POOL = 6;
const SPARK_POOL = 40;

class HitFeedback {
  /** Camera kick for a hit of the given strength (set by the engine). */
  public onKick: ((strength: number) => void) | null = null;

  private readonly flashes = new Map<object, Flash>();
  /** Hit-stop: seconds left nearly frozen, then an ease back to full speed over `easeLen`. */
  private stop = 0;
  private ease = 0;
  private easeLen = 0;
  private easeFrom = 0.3;
  private bursts: Burst[] = [];
  private sparks: Spark[] = [];
  private nextBurst = 0;
  private nextSpark = 0;
  private ready = false;

  /** Builds the sprite pools in `scene` (once; later calls move them to the new scene). */
  public init(scene: THREE.Scene): void {
    if (this.ready) {
      for (const b of this.bursts) scene.add(b.sprite);
      for (const s of this.sparks) scene.add(s.sprite);
      return;
    }
    this.ready = true;
    const star = starTexture();
    const dot = dotTexture();
    const mk = (map: THREE.Texture) => {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({ map, color: 0xffffff, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })
      );
      sp.renderOrder = 998;
      sp.visible = false;
      sp.userData.noFlash = true;
      scene.add(sp);
      return sp;
    };
    for (let i = 0; i < STAR_POOL; i++) this.bursts.push({ sprite: mk(star), life: 0, age: 1, size: 1 });
    for (let i = 0; i < SPARK_POOL; i++) this.sparks.push({ sprite: mk(dot), vel: new THREE.Vector3(), life: 0, age: 1 });
  }

  /** The player struck `target` (its scene root) at `at`, from `from`. */
  public strike(target: object, root: THREE.Object3D, at: THREE.Vector3, from: THREE.Vector3, kind: PestKind, weapon: HitWeapon, kill: boolean): void {
    let f = this.flashes.get(target);
    if (!f) this.flashes.set(target, (f = new Flash(root)));
    f.trigger();

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

    this.burst(at, (kill ? 1.5 : 1) * (weapon === 'melee' ? 1.1 : 0.75));
    // Sparks fly away from the blow, fanned out
    const dx = at.x - from.x, dz = at.z - from.z;
    const l = Math.hypot(dx, dz) || 1;
    const n = kill ? 14 : weapon === 'melee' ? 8 : 5;
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(dx / l, dz / l) + (Math.random() - 0.5) * 2.4;
      const sp = 3 + Math.random() * 4 * strength;
      this.spark(at, Math.sin(a) * sp, 1.5 + Math.random() * 3.5, Math.cos(a) * sp);
    }
    critterSounds.impact(at, kind, weapon, kill);
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
    for (const [k, f] of this.flashes) if (!f.update(rawDt) && !f.on && (k as { removed?: boolean }).removed) this.forget(k);
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
    for (const s of this.sparks) {
      if (s.age >= s.life) continue;
      s.age += rawDt;
      if (s.age >= s.life) {
        s.sprite.visible = false;
        continue;
      }
      s.vel.y -= 14 * rawDt;
      s.vel.multiplyScalar(Math.exp(-3 * rawDt));
      s.sprite.position.addScaledVector(s.vel, rawDt);
      const k = 1 - s.age / s.life;
      s.sprite.scale.setScalar(0.07 + 0.09 * k);
      (s.sprite.material as THREE.SpriteMaterial).opacity = k;
    }
  }

  /** Drops a target's flash copies (it is gone). */
  public forget(target: object): void {
    const f = this.flashes.get(target);
    if (!f) return;
    f.dispose();
    this.flashes.delete(target);
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
    b.life = 0.16;
    b.sprite.scale.setScalar(0.01);
  }

  private spark(at: THREE.Vector3, vx: number, vy: number, vz: number): void {
    const s = this.sparks[this.nextSpark];
    if (!s) return;
    this.nextSpark = (this.nextSpark + 1) % this.sparks.length;
    s.sprite.position.copy(at);
    s.vel.set(vx, vy, vz);
    s.sprite.visible = true;
    s.age = 0;
    s.life = 0.22 + Math.random() * 0.18;
  }
}

export const hitFx = new HitFeedback();
