import * as THREE from 'three';
import { TerrainSystem } from '../world/TerrainSystem';
import { worldSettings } from '../world/WorldSettings';
import { waterLevelAt } from '../world/rivers/RiverWorld';
import { ParticleManager } from '../particles/ParticleManager';
import { EmoteBubble, emoteMaterial } from './Emotes';
import { critterSounds } from './CritterSounds';
import { hitFx, type HitWeapon } from './HitFeedback';

/*
 * The common ground of every enemy: the world queries, what they can do to the player, and the
 * base class (health, hits, sight checks, emotes). Each kind lives in its own file.
 */

export type PestKind = 'hedgehog' | 'dragon' | 'shark' | 'spider';

/** Where a kind lives: walking the island, swimming the sea, or crawling the caves. */
export type PestHabitat = 'land' | 'sea' | 'cave';

/** Ground a pest can stand on: dry land inside the island. */
export function isWalkable(terrain: TerrainSystem, x: number, z: number): boolean {
  if (!terrain.isInside(x, z)) return false;
  const h = terrain.getHeight(x, z);
  return h > worldSettings.waterLevel + 0.15 && h > waterLevelAt(x, z) + 0.1;
}

export const STEER_OFFSETS = [0, 0.45, -0.45, 0.9, -0.9, 1.35, -1.35, 1.8, -1.8, 2.4, -2.4, Math.PI];

/**
 * The physical world as the pests see it (filled in by the gameplay layer with Rapier ray casts).
 * Terrain is walked on the heightmap; these queries add everything standing on it: walls, fences,
 * trees, rocks and props.
 */
export interface PestEnv {
  /** A solid (non-terrain) collider within `dist` of (x, y, z) along the unit direction (dx, dz). */
  blocked(x: number, y: number, z: number, dx: number, dz: number, dist: number): boolean;
  /** Nothing solid (hills included) between the two points. */
  canSee(from: THREE.Vector3, to: THREE.Vector3): boolean;
  /** Distance to the first solid hit along a unit direction, or -1 within `len`. */
  sweep(from: THREE.Vector3, dir: THREE.Vector3, len: number): number;
  /** Like sweep, and writes the surface normal of the hit into `normal` (left alone on a miss). */
  cast(from: THREE.Vector3, dir: THREE.Vector3, len: number, normal: THREE.Vector3): number;
}

/** No physics yet (or in tests): nothing blocks. */
export const OPEN_ENV: PestEnv = { blocked: () => false, canSee: () => true, sweep: () => -1, cast: () => -1 };

/** The most open direction close to `angle` (dry land, no cliff, no wall); NaN when boxed in. */
export function steer(terrain: TerrainSystem, env: PestEnv, x: number, y: number, z: number, angle: number, look: number, maxClimb = 0.9): number {
  const h0 = terrain.getHeight(x, z);
  for (const off of STEER_OFFSETS) {
    const a = angle + off;
    const dx = Math.sin(a), dz = Math.cos(a);
    const sx = x + dx * look;
    const sz = z + dz * look;
    if (!isWalkable(terrain, sx, sz)) continue;
    if (Math.abs(terrain.getHeight(sx, sz) - h0) > maxClimb) continue;
    if (env.blocked(x, y, z, dx, dz, look)) continue;
    return a;
  }
  return NaN;
}

/** What the pests can do to the player (filled in by the gameplay layer). */
export interface PestPort {
  /** Hit the player from `from` with knockback power; returns false while the player is invulnerable. */
  hurt(from: THREE.Vector3, power: number, kind: PestKind): boolean;
  /** The player beat a pest (reward, toast). */
  defeated(kind: PestKind, at: THREE.Vector3): void;
  /** The player is in the water (sharks only go after swimmers). */
  playerSwimming(): boolean;
}

/** Something a pebble or an axe can strike. */
export interface PestTarget {
  readonly kind: PestKind;
  readonly hitRadius: number;
  hitPoint(out: THREE.Vector3): THREE.Vector3;
}

const tmpB = new THREE.Vector3();
/** How often a pest re-checks whether it can see the player (s). */
export const SIGHT_INTERVAL = 0.2;

export function angleTo(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

export function turn(current: number, target: number, maxStep: number): number {
  let d = target - current;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return current + Math.max(-maxStep, Math.min(maxStep, d));
}

/** Geometries several pests share (never disposed with one of them). */
export const SHARED_GEOS = new WeakSet<THREE.BufferGeometry>();

let nextPestId = 1;

export abstract class Pest implements PestTarget {
  public readonly group = new THREE.Group();
  /** Unique per session (the developer panel lists and removes pests by it). */
  public readonly id = nextPestId++;
  public removed = false;
  /** Beaten and playing its death (seconds it lasts, 0 while alive); `removed` once it is over. */
  public dying = 0;
  /** Put down by hand in the developer editor (kept when the natural ones are re-rolled). */
  public placed = false;
  /** Where this one lives (decides when it is simulated: cave pests only while the player is underground). */
  public abstract readonly habitat: PestHabitat;
  public abstract readonly hitRadius: number;
  public health: number;
  protected time = Math.random() * 10;
  protected timer = 0;
  protected heading = Math.random() * Math.PI * 2;
  protected readonly home = new THREE.Vector3();
  protected readonly wander = new THREE.Vector3();
  protected readonly emote: EmoteBubble;
  protected readonly stars: THREE.Sprite[] = [];
  /** Last line-of-sight result (refreshed every SIGHT_INTERVAL, staggered across pests). */
  protected sees = false;
  private sightTimer = Math.random() * SIGHT_INTERVAL;
  /** 1 right after a hit, decays: a squash-and-stretch wobble (no per-pest material clones). */
  private wobble = 0;
  /** When the player last hit it (performance.now() seconds; the health bar shows for a while after). */
  public hurtAt = -1e9;
  /** Hit by the player recently: skips the calm-down and comes back angry. */
  protected provoked = false;

  constructor(
    public readonly kind: PestKind,
    x: number,
    z: number,
    protected readonly terrain: TerrainSystem,
    emoteHeight: number,
    public readonly maxHealth: number
  ) {
    this.health = maxHealth;
    this.group.position.set(x, terrain.getHeight(x, z), z);
    this.home.copy(this.group.position);
    this.wander.copy(this.group.position);
    this.emote = new EmoteBubble(this.group, emoteHeight, 0.42);
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(emoteMaterial('star'));
      s.scale.setScalar(0.2);
      s.visible = false;
      this.stars.push(s);
      this.group.add(s);
    }
  }

  get position(): THREE.Vector3 {
    return this.group.position;
  }

  protected pickWander(radius: number): void {
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * radius;
      const x = this.home.x + Math.cos(a) * r;
      const z = this.home.z + Math.sin(a) * r;
      if (isWalkable(this.terrain, x, z)) {
        this.wander.set(x, 0, z);
        return;
      }
    }
    this.wander.copy(this.home);
  }

  protected spinStars(on: boolean, y: number, r: number): void {
    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i];
      s.visible = on;
      if (!on) continue;
      const a = this.time * 5 + (i / 3) * Math.PI * 2;
      s.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }

  /** Body radius (same as hitRadius; matches the gathering nodes' shape). */
  get radius(): number {
    return this.hitRadius;
  }

  get alive(): boolean {
    return !this.removed && this.health > 0;
  }

  /** Throttled line of sight from `eye` to the player within `range` (m). */
  protected look(dt: number, eye: THREE.Vector3, player: THREE.Vector3, env: PestEnv, range: number): boolean {
    this.sightTimer -= dt;
    if (this.sightTimer > 0) return this.sees;
    this.sightTimer = SIGHT_INTERVAL;
    const dx = player.x - eye.x, dy = player.y - eye.y, dz = player.z - eye.z;
    this.sees = dx * dx + dy * dy + dz * dz < range * range && env.canSee(eye, player);
    return this.sees;
  }

  /** Struck by the player's axe or a pebble from `from`. Returns false when it was already beaten. */
  public damage(amount: number, from: THREE.Vector3, port: PestPort, particles?: ParticleManager, weapon: HitWeapon = 'melee'): boolean {
    if (!this.alive) return false;
    this.health -= amount;
    this.wobble = 1;
    this.provoked = true;
    this.hurtAt = performance.now() / 1000;
    const at = this.hitPoint(tmpB);
    // White flash, hit-stop slow-mo, impact star and sparks, the crunchy impact sound
    hitFx.strike(this, this.group, at, from, this.kind, weapon, this.health <= 0);
    critterSounds.hurt(at, this.kind);
    particles?.emitJumpDust(at);
    if (this.health <= 0) {
      const dying = this.onDefeated();
      if (dying <= 0) {
        critterSounds.poof(at);
        particles?.emitBuildPuff(at, false, 26);
      }
      port.defeated(this.kind, at);
      // A pest with a death of its own plays it out and sets `removed` itself
      if (dying > 0) this.dying = dying;
      else this.removed = true;
      return true;
    }
    this.onHurt(from);
    return true;
  }

  /** Seconds (s) of a death animation it plays before going; 0 vanishes in a puff at once. */
  protected onDefeated(): number {
    return 0;
  }

  /** Reaction to a hit that did not beat it. */
  protected abstract onHurt(from: THREE.Vector3): void;

  /** Squash-and-stretch after a hit. */
  protected applyWobble(dt: number): void {
    if (this.wobble <= 0) return;
    this.wobble = Math.max(0, this.wobble - dt * 2.6);
    // Starts squashed by the blow (held through the hit-stop), then springs back and jiggles out
    const w = this.wobble;
    const k = Math.sin((1 - w) * 24 + 1.2) * 0.3 * w * w;
    this.group.scale.set(1 + k, 1 - k, 1 + k);
  }

  /** Centre of the pest's body (for sounds and effects). */
  abstract hitPoint(out: THREE.Vector3): THREE.Vector3;
  abstract update(dt: number, player: THREE.Vector3, port: PestPort, env: PestEnv, particles?: ParticleManager): void;

  /** For the music: 0 minding its own business, 1 after the player, 2 attacking right now. */
  abstract get threat(): number;

  public dispose(): void {
    hitFx.forget(this);
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !m.userData.shared && !SHARED_GEOS.has(m.geometry)) m.geometry.dispose();
    });
  }
}
