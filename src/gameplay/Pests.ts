import * as THREE from 'three';
import { TerrainSystem } from '../world/TerrainSystem';
import { coastRadius } from '../world/IslandGenerator';
import { worldSettings } from '../world/WorldSettings';
import { waterLevelAt } from '../world/rivers/RiverWorld';
import { ParticleManager } from '../particles/ParticleManager';
import { EmoteBubble, emoteMaterial, makeBlobShadow } from './Emotes';
import { critterSounds } from './CritterSounds';

export type PestKind = 'hedgehog' | 'dragon';

/** Ground a pest can stand on: dry land inside the island. */
function isWalkable(terrain: TerrainSystem, x: number, z: number): boolean {
  if (!terrain.isInside(x, z)) return false;
  const h = terrain.getHeight(x, z);
  return h > worldSettings.waterLevel + 0.15 && h > waterLevelAt(x, z) + 0.1;
}

const STEER_OFFSETS = [0, 0.45, -0.45, 0.9, -0.9, 1.35, -1.35, 1.8, -1.8, 2.4, -2.4, Math.PI];

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
}

/** No physics yet (or in tests): nothing blocks. */
const OPEN_ENV: PestEnv = { blocked: () => false, canSee: () => true, sweep: () => -1 };

/** The most open direction close to `angle` (dry land, no cliff, no wall); NaN when boxed in. */
function steer(terrain: TerrainSystem, env: PestEnv, x: number, y: number, z: number, angle: number, look: number, maxClimb = 0.9): number {
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
}

/** Something a pebble or an axe can strike. */
export interface PestTarget {
  readonly kind: PestKind;
  readonly hitRadius: number;
  hitPoint(out: THREE.Vector3): THREE.Vector3;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
/** How often a pest re-checks whether it can see the player (s). */
const SIGHT_INTERVAL = 0.2;

function angleTo(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function turn(current: number, target: number, maxStep: number): number {
  let d = target - current;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return current + Math.max(-maxStep, Math.min(maxStep, d));
}

abstract class Pest implements PestTarget {
  public readonly group = new THREE.Group();
  public removed = false;
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
  public damage(amount: number, from: THREE.Vector3, port: PestPort, particles?: ParticleManager): boolean {
    if (!this.alive) return false;
    this.health -= amount;
    this.wobble = 1;
    this.provoked = true;
    const at = this.hitPoint(tmpB);
    critterSounds.hurt(at, this.kind);
    particles?.emitJumpDust(at);
    if (this.health <= 0) {
      critterSounds.poof(at);
      particles?.emitBuildPuff(at, false, 26);
      port.defeated(this.kind, at);
      this.removed = true;
      return true;
    }
    this.onHurt(from);
    return true;
  }

  /** Reaction to a hit that did not beat it. */
  protected abstract onHurt(from: THREE.Vector3): void;

  /** Squash-and-stretch after a hit. */
  protected applyWobble(dt: number): void {
    if (this.wobble <= 0) return;
    this.wobble = Math.max(0, this.wobble - dt * 3);
    const k = Math.sin(this.wobble * 22) * 0.18 * this.wobble;
    this.group.scale.set(1 + k, 1 - k, 1 + k);
  }

  /** Centre of the pest's body (for sounds and effects). */
  abstract hitPoint(out: THREE.Vector3): THREE.Vector3;
  abstract update(dt: number, player: THREE.Vector3, port: PestPort, env: PestEnv, particles?: ParticleManager): void;

  /** For the music: 0 minding its own business, 1 after the player, 2 attacking right now. */
  abstract get threat(): number;

  public dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !m.userData.shared && m.geometry !== FIRE_GEO) m.geometry.dispose();
    });
  }
}

// ------------------------------------------------------------------ hedgehog

type HedgeState = 'wander' | 'angry' | 'curl' | 'roll' | 'dazed' | 'calm';

const HEDGE_MATS = {
  spikes: new THREE.MeshLambertMaterial({ color: 0x5a3d26, flatShading: true }),
  tips: new THREE.MeshLambertMaterial({ color: 0xd8c3a0, flatShading: true }),
  face: new THREE.MeshLambertMaterial({ color: 0xe9cfa6 }),
  dark: new THREE.MeshBasicMaterial({ color: 0x1b1b1b }),
  white: new THREE.MeshBasicMaterial({ color: 0xffffff }),
};

/**
 * A grumpy hedgehog. When it sees the player it stamps, curls into a spiky ball and rolls at them.
 * Dodge the ball: after a roll it lies dazed for a moment, then calms down before it can charge again.
 */
export class Hedgehog extends Pest {
  private state: HedgeState = 'wander';

  get threat(): number {
    return this.state === 'curl' || this.state === 'roll' ? 2 : this.state === 'angry' ? 1 : 0;
  }
  private readonly walker = new THREE.Group();
  private readonly ball = new THREE.Group();
  private readonly legs: THREE.Mesh[] = [];
  private readonly shadow: THREE.Mesh;
  private rollSpeed = 0;
  private rolled = 0;
  private curl = 0;
  private rumble = 0;
  private bounceV = 0;
  private hopY = 0;
  /** Knocked back by a hit: slides this fast (m/s) along knockDir, decaying. */
  private knock = 0;
  private knockDir = 0;
  /** Bumps into walls in a row while wandering: gives up on that wander target. */
  private stuck = 0;
  public readonly hitRadius = 0.45;

  constructor(x: number, z: number, terrain: TerrainSystem) {
    super('hedgehog', x, z, terrain, 1.0, 3);
    // Walking hedgehog: a spiky dome, a pointy face, four stubby legs
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 8, 0, Math.PI * 2, 0, Math.PI / 1.7), HEDGE_MATS.spikes);
    dome.scale.set(1, 0.85, 1.25);
    dome.position.y = 0.16;
    this.walker.add(dome);
    const spikeGeo = new THREE.ConeGeometry(0.045, 0.2, 4);
    for (let i = 0; i < 26; i++) {
      const u = (i * 0.618) % 1;
      const v = 0.15 + ((i * 0.382) % 1) * 0.65;
      const theta = u * Math.PI * 2;
      const phi = v * (Math.PI / 2);
      const dir = new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta) * 1.25);
      if (dir.z > 0.9) continue; // keep the face clear
      const sp = new THREE.Mesh(spikeGeo, i % 4 ? HEDGE_MATS.spikes : HEDGE_MATS.tips);
      sp.position.copy(dir).multiplyScalar(0.3).add(new THREE.Vector3(0, 0.16, 0));
      sp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      sp.rotateX(-0.5);
      this.walker.add(sp);
    }
    const face = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.32, 8), HEDGE_MATS.face);
    face.rotation.x = Math.PI / 2;
    face.position.set(0, 0.17, 0.42);
    this.walker.add(face);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 5), HEDGE_MATS.dark);
    nose.position.set(0, 0.17, 0.58);
    this.walker.add(nose);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), HEDGE_MATS.dark);
      eye.position.set(sx * 0.08, 0.25, 0.4);
      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.012, 4, 3), HEDGE_MATS.white);
      glint.position.set(0.01, 0.015, 0.028);
      eye.add(glint);
      // Angry brow
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.018, 0.02), HEDGE_MATS.dark);
      brow.position.set(sx * 0.08, 0.3, 0.41);
      brow.rotation.z = sx * 0.4;
      this.walker.add(eye, brow);
    }
    for (const [x, z] of [[-0.17, 0.18], [0.17, 0.18], [-0.17, -0.18], [0.17, -0.18]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.08), HEDGE_MATS.face);
      leg.position.set(x, 0.06, z);
      this.legs.push(leg);
      this.walker.add(leg);
    }
    this.group.add(this.walker);

    // Rolled up: a spiky ball
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), HEDGE_MATS.spikes);
    this.ball.add(core);
    const ico = new THREE.IcosahedronGeometry(1, 1);
    const pos = ico.getAttribute('position');
    const seen = new Set<string>();
    for (let i = 0; i < pos.count; i++) {
      const d = new THREE.Vector3().fromBufferAttribute(pos, i).normalize();
      const key = d.toArray().map((n) => n.toFixed(2)).join();
      if (seen.has(key)) continue;
      seen.add(key);
      const sp = new THREE.Mesh(spikeGeo, seen.size % 3 ? HEDGE_MATS.spikes : HEDGE_MATS.tips);
      sp.position.copy(d).multiplyScalar(0.33);
      sp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
      this.ball.add(sp);
    }
    this.ball.position.y = 0.36;
    this.ball.visible = false;
    this.group.add(this.ball);

    this.shadow = makeBlobShadow(0.9);
    this.shadow.position.y = 0.03;
    this.group.add(this.shadow);
    this.pickWander(8);
  }

  public hitPoint(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).setY(this.position.y + 0.3);
  }

  protected onHurt(from: THREE.Vector3): void {
    // Tumbles away from the blow and lies dazed; comes back angry once it shakes it off
    this.knockDir = Math.atan2(this.position.x - from.x, this.position.z - from.z);
    this.knock = 5;
    this.bounceV = 3.2;
    this.state = 'dazed';
    this.timer = 1.4;
    this.rollSpeed = 0;
    this.emote.show('angry', 0.8);
  }

  public update(dt: number, player: THREE.Vector3, port: PestPort, env: PestEnv, particles?: ParticleManager): void {
    const pos = this.position;
    const dist = Math.hypot(player.x - pos.x, player.z - pos.z);
    this.group.visible = dist < 110;
    if (dist > 80 && this.state !== 'roll') return;
    this.time += dt;
    this.timer -= dt;
    this.emote.update(dt);
    let speed = 0;
    let wantCurl = 0;
    // Eyes a little above the snout: low bumps of the ground don't hide the player
    const sees = dist < 24 && this.look(dt, tmpEye.copy(pos).setY(pos.y + 0.6), player, env, 24);

    switch (this.state) {
      case 'wander': {
        if (dist < 11 && Math.abs(player.y - pos.y) < 3 && sees) {
          this.state = 'angry';
          this.timer = 0.75;
          this.emote.show('angry', 0.9);
          critterSounds.huff(pos);
          break;
        }
        const dx = this.wander.x - pos.x;
        const dz = this.wander.z - pos.z;
        if (this.timer > 0) break;
        if (dx * dx + dz * dz < 0.2) {
          this.timer = 1 + Math.random() * 3;
          this.pickWander(8);
        } else {
          this.heading = turn(this.heading, Math.atan2(dx, dz), dt * 4);
          speed = 0.9;
        }
        break;
      }
      case 'angry':
        // Stamps its feet and glares
        this.heading = turn(this.heading, angleTo(pos, player), dt * 10);
        this.hopY = Math.abs(Math.sin(this.time * 20)) * 0.05;
        if (this.timer <= 0) {
          this.state = 'curl';
          this.timer = 0.35;
        }
        break;
      case 'curl':
        wantCurl = 1;
        this.heading = turn(this.heading, angleTo(pos, player), dt * 6);
        if (this.timer <= 0) {
          this.state = 'roll';
          this.rollSpeed = 2;
          this.rolled = 0;
          this.bounceV = 2.5;
        }
        break;
      case 'roll': {
        wantCurl = 1;
        // Gently homes in on the player while it can see them; accelerates down the line
        if (sees) this.heading = turn(this.heading, angleTo(pos, player), dt * 0.9);
        this.rollSpeed = Math.min(10, this.rollSpeed + dt * 9);
        speed = this.rollSpeed;
        this.rolled += speed * dt;
        this.rumble -= dt;
        if (this.rumble <= 0) {
          this.rumble = 0.2;
          critterSounds.roll(pos);
          particles?.emitJumpDust(pos);
        }
        // Hit the player
        if (dist < 0.95 && Math.abs(player.y - 0.9 - pos.y) < 1.2) {
          if (port.hurt(pos, 9, 'hedgehog')) {
            this.heading += Math.PI;
            this.rollSpeed = 3;
            this.bounceV = 3;
          }
          this.endRoll();
        } else if (this.rolled > 22) {
          this.endRoll();
        }
        break;
      }
      case 'dazed':
        this.spinStars(true, 0.65, 0.3);
        if (this.timer <= 0) {
          this.spinStars(false, 0, 0);
          this.home.copy(pos);
          if (this.provoked && sees && dist < 16) {
            // Hit by the player: no calming down, it charges right back
            this.provoked = false;
            this.state = 'angry';
            this.timer = 0.6;
            this.emote.show('angry', 0.9);
            critterSounds.huff(pos);
          } else {
            this.state = 'calm';
            this.timer = 3.5;
            this.pickWander(6);
          }
        }
        break;
      case 'calm':
        // Does not get angry again right away
        if (this.timer <= 0) this.state = 'wander';
        break;
    }

    // Knockback slide after a hit (stops at walls and water)
    if (this.knock > 0.05) {
      const step = this.knock * dt;
      const kx = Math.sin(this.knockDir), kz = Math.cos(this.knockDir);
      const nx = pos.x + kx * step, nz = pos.z + kz * step;
      if (isWalkable(this.terrain, nx, nz) && !env.blocked(pos.x, pos.y + 0.35, pos.z, kx, kz, this.hitRadius + step)) {
        pos.x = nx;
        pos.z = nz;
      } else this.knock = 0;
      this.knock *= Math.exp(-dt * 5);
    }

    // Movement on the heightmap (bounces off water and cliffs) and around solid colliders
    if (speed > 0) {
      const step = speed * dt;
      const dx = Math.sin(this.heading), dz = Math.cos(this.heading);
      const nx = pos.x + dx * step;
      const nz = pos.z + dz * step;
      const ground = isWalkable(this.terrain, nx, nz) && Math.abs(this.terrain.getHeight(nx, nz) - this.terrain.getHeight(pos.x, pos.z)) < 0.6;
      // Ray at belly height, reaching the body's radius past this frame's step: no tunnelling at full roll speed
      const solid = ground && env.blocked(pos.x, pos.y + 0.35, pos.z, dx, dz, this.hitRadius + step);
      if (ground && !solid) {
        pos.x = nx;
        pos.z = nz;
        this.stuck = Math.max(0, this.stuck - 1);
      } else if (this.state === 'roll') {
        // Bonks off the wall / water's edge and lies dazed
        this.heading += Math.PI;
        if (solid) critterSounds.pebbleHit(pos);
        this.endRoll();
      } else {
        const a = steer(this.terrain, env, pos.x, pos.y + 0.35, pos.z, this.heading, 1, 0.6);
        if (!Number.isNaN(a) && ++this.stuck < 25) this.heading = a;
        else {
          this.stuck = 0;
          this.pickWander(6);
        }
      }
    }
    this.bounceV -= 14 * dt;
    this.hopY = Math.max(this.state === 'angry' ? this.hopY : 0, this.hopY + this.bounceV * dt);
    if (this.hopY <= 0) {
      this.hopY = 0;
      if (this.state === 'roll' && this.bounceV < -2) this.bounceV = Math.abs(this.bounceV) * 0.35;
      else this.bounceV = 0;
    }
    pos.y = this.terrain.getHeight(pos.x, pos.z) + this.hopY;
    this.shadow.position.y = -this.hopY + 0.03;

    // Curl transition: the walker squashes into the ball
    this.curl += (wantCurl - this.curl) * Math.min(1, dt * 14);
    this.walker.visible = this.curl < 0.5;
    this.ball.visible = this.curl >= 0.5;
    this.walker.scale.set(1, 1 - this.curl * 0.6, 1);
    this.group.rotation.y = this.heading;
    if (this.ball.visible) this.ball.rotation.x += (speed / 0.36) * dt;
    else this.ball.rotation.x = 0;
    const walk = speed > 0 && this.walker.visible ? Math.sin(this.time * speed * 12) * 0.5 : 0;
    this.legs[0].rotation.x = walk;
    this.legs[3].rotation.x = walk;
    this.legs[1].rotation.x = -walk;
    this.legs[2].rotation.x = -walk;
    this.applyWobble(dt);
  }

  private endRoll(): void {
    this.state = 'dazed';
    this.timer = 2.2;
    this.rollSpeed = 0;
  }
}

// ------------------------------------------------------------------ baby dragon

type DragonState = 'patrol' | 'aggro' | 'inhale' | 'rest';
/** Headings a flying dragon tries, relative to where it wants to go (towards its strafe side first). */
const FLY_OFFSETS = [0, 0.7, -0.7, 1.4, -1.4];

const DRAGON_MATS = {
  body: new THREE.MeshLambertMaterial({ color: 0x6cc24a }),
  belly: new THREE.MeshLambertMaterial({ color: 0xf3e3a1 }),
  wing: new THREE.MeshLambertMaterial({ color: 0xf0a33a, side: THREE.DoubleSide }),
  horn: new THREE.MeshLambertMaterial({ color: 0xfff3d6 }),
  dark: new THREE.MeshBasicMaterial({ color: 0x1b1b1b }),
  white: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  mouth: new THREE.MeshBasicMaterial({ color: 0x7a1f1f }),
};

const FIRE_CORE = new THREE.MeshBasicMaterial({ color: 0xfff1a8 });
const FIRE_SHELL = new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
const FIRE_GEO = new THREE.IcosahedronGeometry(1, 1);

interface Fireball {
  mesh: THREE.Group;
  vel: THREE.Vector3;
  life: number;
}

interface Burst {
  mesh: THREE.Mesh;
  age: number;
}

/**
 * A chubby little dragon that flaps around its nest. Once it spots the player it keeps its
 * distance, puffs up and spits fireballs at where the player is heading. After a volley it sinks
 * low to catch its breath before the next one.
 */
export class BabyDragon extends Pest {
  private state: DragonState = 'patrol';

  get threat(): number {
    return this.state === 'inhale' ? 2 : this.state === 'aggro' ? 1 : 0;
  }
  private readonly body = new THREE.Group();
  private readonly wings: THREE.Object3D[] = [];
  private readonly jaw: THREE.Mesh;
  private readonly glow: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  private altitude = 2.8;
  private shots = 0;
  private strafe = Math.random() < 0.5 ? 1 : -1;
  private flapTimer = 0;
  private puff = 0;
  private readonly fireballs: Fireball[] = [];
  private readonly bursts: Burst[] = [];
  private readonly lastPlayer = new THREE.Vector3();
  private readonly playerVel = new THREE.Vector3();
  /** Seconds without a clear view while chasing: flies closer, then gives up. */
  private lost = 0;
  private knock = 0;
  private knockDir = 0;
  public readonly hitRadius = 0.6;

  constructor(x: number, z: number, terrain: TerrainSystem, private readonly scene: THREE.Scene) {
    super('dragon', x, z, terrain, 1.55, 4);
    // Round belly-heavy body
    const torso = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), DRAGON_MATS.body);
    torso.scale.set(1, 1.05, 0.95);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 8), DRAGON_MATS.belly);
    belly.scale.set(0.95, 1, 0.5);
    belly.position.set(0, -0.06, 0.24);
    this.body.add(torso, belly);
    // Big head on top
    const head = new THREE.Group();
    head.position.set(0, 0.5, 0.12);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), DRAGON_MATS.body);
    skull.scale.set(1, 0.92, 1);
    const snout = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), DRAGON_MATS.body);
    snout.scale.set(1.05, 0.7, 1);
    snout.position.set(0, -0.05, 0.24);
    for (const sx of [-1, 1]) {
      const nostril = new THREE.Mesh(new THREE.SphereGeometry(0.022, 5, 4), DRAGON_MATS.dark);
      nostril.position.set(sx * 0.06, 0.02, 0.43);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), DRAGON_MATS.white);
      eye.position.set(sx * 0.13, 0.1, 0.22);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), DRAGON_MATS.dark);
      pupil.position.set(0, 0, 0.05);
      eye.add(pupil);
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 6), DRAGON_MATS.horn);
      horn.position.set(sx * 0.14, 0.27, -0.06);
      horn.rotation.set(-0.35, 0, -sx * 0.3);
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 4), DRAGON_MATS.wing);
      ear.position.set(sx * 0.27, 0.1, -0.05);
      ear.rotation.z = -sx * 1.1;
      head.add(nostril, eye, horn, ear);
    }
    this.jaw = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), DRAGON_MATS.mouth);
    this.jaw.position.set(0, -0.1, 0.27);
    this.jaw.scale.set(1, 0.3, 1.1);
    this.glow = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), FIRE_SHELL);
    this.glow.position.set(0, -0.08, 0.36);
    this.glow.visible = false;
    head.add(skull, snout, this.jaw, this.glow);
    this.body.add(head);
    // Back ridge
    for (let i = 0; i < 3; i++) {
      const fin = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 4), DRAGON_MATS.wing);
      fin.position.set(0, 0.36 - i * 0.16, -0.32 - i * 0.04);
      fin.rotation.x = -0.6 - i * 0.2;
      this.body.add(fin);
    }
    // Stubby arms and dangling feet
    for (const sx of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.12, 3, 6), DRAGON_MATS.body);
      arm.position.set(sx * 0.3, 0.02, 0.26);
      arm.rotation.set(0.9, 0, sx * 0.5);
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), DRAGON_MATS.belly);
      foot.scale.set(1, 0.7, 1.3);
      foot.position.set(sx * 0.2, -0.42, 0.08);
      this.body.add(arm, foot);
    }
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.55, 8), DRAGON_MATS.body);
    tail.rotation.x = -Math.PI / 2 - 0.5;
    tail.position.set(0, -0.2, -0.5);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.15, 3), DRAGON_MATS.wing);
    tip.position.set(0, -0.32, 0);
    tip.rotation.x = Math.PI;
    tail.add(tip);
    this.body.add(tail);
    // Little bat wings
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.25, 0.25, -0.15);
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(0.55, 0.3);
      shape.lineTo(0.62, -0.05);
      shape.quadraticCurveTo(0.45, -0.02, 0.4, -0.15);
      shape.quadraticCurveTo(0.25, -0.05, 0.18, -0.2);
      shape.quadraticCurveTo(0.08, -0.08, 0, -0.1);
      const g = new THREE.ShapeGeometry(shape);
      g.rotateX(-Math.PI / 2);
      if (sx < 0) g.scale(-1, 1, 1);
      const wing = new THREE.Mesh(g, DRAGON_MATS.wing);
      pivot.add(wing);
      this.wings.push(pivot);
      this.body.add(pivot);
    }
    this.group.add(this.body);
    this.shadow = makeBlobShadow(1.1);
    this.group.add(this.shadow);
    this.pickWander(10);
  }

  public hitPoint(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).setY(this.position.y + this.altitude);
  }

  protected onHurt(from: THREE.Vector3): void {
    // Knocked back and up; it turns on the player at once
    this.knockDir = Math.atan2(this.position.x - from.x, this.position.z - from.z);
    this.knock = 4;
    this.altitude += 0.5;
    this.emote.show('angry', 1);
    if (this.state === 'patrol' || this.state === 'rest') {
      this.state = 'aggro';
      this.timer = 0.8;
    } else if (this.state === 'inhale') {
      // The hit knocks the breath out of it
      this.glow.visible = false;
      this.state = 'aggro';
      this.timer = 1.2;
    }
  }

  public update(dt: number, player: THREE.Vector3, port: PestPort, env: PestEnv, particles?: ParticleManager): void {
    const pos = this.position;
    const dist = Math.hypot(player.x - pos.x, player.z - pos.z);
    this.updateFireballs(dt, player, port, env, particles);
    this.group.visible = dist < 140;
    if (dist > 100 && !this.fireballs.length) return;
    this.time += dt;
    this.timer -= dt;
    this.emote.update(dt);
    const sees = dist < 36 && this.look(dt, this.hitPoint(tmpEye), player, env, 36);

    // Track the player's motion to lead the shots
    if (dt > 0) {
      tmpA.subVectors(player, this.lastPlayer).divideScalar(dt);
      if (tmpA.lengthSq() < 400) this.playerVel.lerp(tmpA, Math.min(1, dt * 4));
    }
    this.lastPlayer.copy(player);

    let wantAlt = 2.8;
    let speed = 0;
    let face = this.heading;
    let moveDir = this.heading;
    let wantPuff = 0;
    const toPlayer = angleTo(pos, player);

    switch (this.state) {
      case 'patrol': {
        if (dist < 22 && (sees || this.provoked)) {
          this.provoked = false;
          this.lost = 0;
          this.state = 'aggro';
          this.timer = 1.2;
          this.emote.show('alert', 1);
          critterSounds.fireball(pos);
          break;
        }
        const dx = this.wander.x - pos.x;
        const dz = this.wander.z - pos.z;
        if (dx * dx + dz * dz < 0.5) this.pickWander(10);
        face = moveDir = Math.atan2(dx, dz);
        speed = 2.2;
        break;
      }
      case 'aggro': {
        face = toPlayer;
        this.lost = sees ? 0 : this.lost + dt;
        if (!sees) {
          // Lost sight (a wall, a tree, a hill): fly closer to look around it, then give up
          moveDir = toPlayer + (Math.PI / 4) * this.strafe;
          speed = dist > 5 ? 3.2 : 1.5;
          if (this.lost > 7 || dist > 34) {
            this.state = 'patrol';
            this.pickWander(10);
          }
          break;
        }
        // Keep 8-12 m away and circle the player
        const want = dist < 8 ? toPlayer + Math.PI : dist > 12 ? toPlayer : toPlayer + (Math.PI / 2) * this.strafe;
        moveDir = want;
        speed = dist > 12 || dist < 8 ? 3.6 : 2.4;
        if (Math.random() < dt * 0.2) this.strafe *= -1;
        if (dist > 34) {
          this.state = 'patrol';
          this.pickWander(10);
        } else if (this.timer <= 0) {
          this.state = 'inhale';
          this.timer = 0.65;
        }
        break;
      }
      case 'inhale':
        face = toPlayer;
        wantPuff = 1;
        this.glow.visible = true;
        if (this.timer <= 0) {
          this.glow.visible = false;
          // Only spits with a clear line (fresh check: the player may have just ducked behind cover)
          if (!env.canSee(this.hitPoint(tmpEye), player)) {
            this.sees = false;
            this.state = 'aggro';
            this.timer = 0.6;
            break;
          }
          this.shoot(player);
          this.shots++;
          if (this.shots >= 3) {
            // Out of breath: sinks low and pants
            this.shots = 0;
            this.state = 'rest';
            this.timer = 3.2;
            this.emote.show('sweat', 3);
          } else {
            this.state = 'aggro';
            this.timer = 1.4 + Math.random() * 0.8;
          }
        }
        break;
      case 'rest':
        wantAlt = 1.15;
        face = toPlayer;
        if (this.timer <= 0) {
          this.state = 'aggro';
          this.timer = 1;
        }
        break;
    }

    // Flight: around walls and trunks at body height (tries a few headings before turning back)
    if (this.knock > 0.05) {
      moveDir = this.knockDir;
      speed = Math.max(speed, this.knock);
      this.knock *= Math.exp(-dt * 4);
    }
    if (speed > 0) {
      const step = speed * dt;
      const bodyY = pos.y + this.altitude;
      let moved = false;
      for (const off of FLY_OFFSETS) {
        const a = moveDir + off * this.strafe;
        const dx = Math.sin(a), dz = Math.cos(a);
        const nx = pos.x + dx * step;
        const nz = pos.z + dz * step;
        if (!this.terrain.isInside(nx, nz) || Math.hypot(nx, nz) > coastRadius(nx, nz) - 10) continue;
        if (env.blocked(pos.x, bodyY, pos.z, dx, dz, this.hitRadius + step)) continue;
        pos.x = nx;
        pos.z = nz;
        moved = true;
        break;
      }
      if (!moved) {
        this.strafe *= -1;
        this.knock = 0;
      }
    }
    this.heading = turn(this.heading, face, dt * 5);
    this.altitude += (wantAlt - this.altitude) * Math.min(1, dt * 2.5);
    const ground = this.terrain.getHeight(pos.x, pos.z);
    pos.y = ground;
    const bob = Math.sin(this.time * 3) * 0.12;
    this.body.position.y = this.altitude + bob;
    this.shadow.position.y = 0.03;
    this.shadow.scale.setScalar(1.3 - Math.min(0.8, this.altitude * 0.15));
    this.group.rotation.y = this.heading;
    this.emote.sprite.position.y = this.altitude + 1.0;

    // Wings beat fast; slower and lazier while resting
    const rate = this.state === 'rest' ? 9 : 16;
    const flap = Math.sin(this.time * rate);
    this.wings[0].rotation.z = flap * 0.9 + 0.2;
    this.wings[1].rotation.z = -flap * 0.9 - 0.2;
    this.flapTimer -= dt;
    if (this.flapTimer <= 0 && dist < 20) {
      this.flapTimer = (Math.PI * 2) / rate;
      critterSounds.wingFlap(this.hitPoint(tmpA));
    }
    this.body.rotation.z = speed > 0 ? Math.sin(this.time * 2) * 0.1 : 0;
    this.body.rotation.x = speed > 3 ? 0.25 : 0;
    // Puffs up before spitting fire, mouth opens
    this.puff += (wantPuff - this.puff) * Math.min(1, dt * 8);
    const s = 1 + this.puff * 0.18;
    this.body.scale.set(s, s, s);
    this.jaw.scale.y = 0.3 + this.puff * 0.7 + (this.state === 'rest' ? Math.abs(Math.sin(this.time * 8)) * 0.4 : 0);
    if (this.glow.visible) this.glow.scale.setScalar(0.6 + this.puff * 0.8 + Math.sin(this.time * 40) * 0.15);
    this.applyWobble(dt);
  }

  private shoot(player: THREE.Vector3): void {
    const from = new THREE.Vector3(0, this.altitude + 0.45, 0.45).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.heading).add(this.position);
    // Aim at the feet, leading a moving player a little
    const target = player.clone().addScaledVector(this.playerVel, 0.55);
    target.y = player.y - 0.8;
    const speed = 12;
    const vel = target.sub(from);
    const t = vel.length() / speed;
    vel.divideScalar(Math.max(0.1, t));
    const mesh = new THREE.Group();
    const core = new THREE.Mesh(FIRE_GEO, FIRE_CORE);
    core.scale.setScalar(0.13);
    const shell = new THREE.Mesh(FIRE_GEO, FIRE_SHELL);
    shell.scale.setScalar(0.24);
    mesh.add(core, shell);
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.fireballs.push({ mesh, vel, life: 3 });
    critterSounds.fireball(from);
  }

  private updateFireballs(dt: number, player: THREE.Vector3, port: PestPort, env: PestEnv, particles?: ParticleManager): void {
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const f = this.fireballs[i];
      f.life -= dt;
      const p = f.mesh.position;
      // Swept against walls, trees and rocks: a fireball bursts on the first thing in its way
      const len = f.vel.length() * dt;
      const dir = tmpA.copy(f.vel).divideScalar(Math.max(1e-6, f.vel.length()));
      const wall = len > 0 ? env.sweep(p, dir, len + 0.2) : -1;
      if (wall >= 0) p.addScaledVector(dir, Math.max(0, wall - 0.25));
      else p.addScaledVector(f.vel, dt);
      f.mesh.rotation.y += dt * 9;
      f.mesh.children[1].scale.setScalar(0.22 + Math.sin(this.time * 30 + i) * 0.04);
      const hitPlayer = p.distanceTo(player) < 0.95;
      const ground = this.terrain.getHeight(p.x, p.z);
      if (hitPlayer || wall >= 0 || p.y <= ground + 0.1 || f.life <= 0) {
        this.explode(p, particles);
        // Splash damage near the impact, but not through the wall it burst on
        if (hitPlayer || (Math.hypot(player.x - p.x, player.z - p.z) < 1.5 && env.canSee(p, player))) port.hurt(p, 7, 'dragon');
        f.mesh.removeFromParent();
        this.fireballs.splice(i, 1);
      } else if (Math.random() < dt * 20) {
        particles?.emitJumpDust(p);
      }
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.age += dt;
      const k = b.age / 0.4;
      b.mesh.scale.setScalar(0.3 + k * 1.4);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - k));
      if (k >= 1) {
        b.mesh.removeFromParent();
        (b.mesh.material as THREE.Material).dispose();
        this.bursts.splice(i, 1);
      }
    }
  }

  private explode(p: THREE.Vector3, particles?: ParticleManager): void {
    const mat = FIRE_SHELL.clone();
    const mesh = new THREE.Mesh(FIRE_GEO, mat);
    mesh.position.copy(p);
    this.scene.add(mesh);
    this.bursts.push({ mesh, age: 0 });
    particles?.emitBuildPuff(p, false, 14);
    critterSounds.explode(p);
  }

  private disposeFire(): void {
    for (const f of this.fireballs) f.mesh.removeFromParent();
    this.fireballs.length = 0;
  }

  public dispose(): void {
    this.disposeFire();
    for (const b of this.bursts) b.mesh.removeFromParent();
    this.bursts.length = 0;
    super.dispose();
  }
}

// ------------------------------------------------------------------ system

const HEDGEHOGS = 5;
const DRAGONS = 2;

/** Keeps a few hedgehogs and baby dragons out in the wilds, away from the farm. */
export class PestSystem {
  public readonly pests: Pest[] = [];
  public port: PestPort | null = null;
  /** Physics queries for walls and sight lines (set once physics is up). */
  public env: PestEnv = OPEN_ENV;
  private respawnTimer = 0;

  constructor(private readonly scene: THREE.Scene, private readonly terrain: TerrainSystem, private readonly particles?: ParticleManager) {}

  public populate(player: THREE.Vector3): void {
    for (let i = 0; i < HEDGEHOGS; i++) this.spawn('hedgehog', player);
    for (let i = 0; i < DRAGONS; i++) this.spawn('dragon', player);
  }

  private spawn(kind: PestKind, player: THREE.Vector3): boolean {
    // Pests live out in the wilds, not on the farm itself
    const minR = kind === 'dragon' ? 70 : 40;
    for (let tries = 0; tries < 40; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = minR + Math.random() * 160;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x, z) > coastRadius(x, z) - 25) continue;
      if (!isWalkable(this.terrain, x, z)) continue;
      if (Math.hypot(x - player.x, z - player.z) < 35) continue;
      const pest = kind === 'hedgehog' ? new Hedgehog(x, z, this.terrain) : new BabyDragon(x, z, this.terrain, this.scene);
      this.pests.push(pest);
      this.scene.add(pest.group);
      return true;
    }
    return false;
  }

  public update(dt: number, player: THREE.Vector3, active: boolean): void {
    const port = this.port;
    if (!port) return;
    for (let i = this.pests.length - 1; i >= 0; i--) {
      const p = this.pests[i];
      p.update(active ? dt : 0, player, port, this.env, this.particles);
      if (p.removed) {
        p.dispose();
        this.pests.splice(i, 1);
      }
    }
    // Driven-off pests come back after a while, somewhere else
    this.respawnTimer -= dt;
    if (this.respawnTimer <= 0) {
      this.respawnTimer = 90;
      const hedge = this.pests.filter((p) => p.kind === 'hedgehog').length;
      const drag = this.pests.length - hedge;
      if (hedge < HEDGEHOGS) this.spawn('hedgehog', player);
      else if (drag < DRAGONS) this.spawn('dragon', player);
    }
  }

  /** Highest threat (0..2) of the pests within `maxDist` of the player (for the danger music). */
  public threatLevel(player: THREE.Vector3, maxDist = 35): number {
    let level = 0;
    for (const p of this.pests) {
      const t = p.threat;
      if (t <= level || p.removed) continue;
      const dx = p.position.x - player.x, dz = p.position.z - player.z;
      if (dx * dx + dz * dz <= maxDist * maxDist) level = t;
    }
    return level;
  }

  /** Nearest pest that is after the player (for the compass / HUD warning). */
  public nearestThreat(player: THREE.Vector3, maxDist: number): Pest | null {
    let best: Pest | null = null;
    let bestD = maxDist;
    for (const p of this.pests) {
      const d = Math.hypot(p.position.x - player.x, p.position.z - player.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** A pest within an axe's reach of the player (body centre at `pos`), in front of them first. */
  public findMeleeTarget(pos: THREE.Vector3, facing: THREE.Vector3, reach: number): Pest | null {
    let best: Pest | null = null;
    let bestScore = Infinity;
    for (const p of this.pests) {
      if (!p.alive || !p.group.visible) continue;
      const c = p.hitPoint(tmpA);
      // A dragon is only in reach when it sinks low to rest
      if (Math.abs(c.y - pos.y) > 1.5) continue;
      const dx = c.x - pos.x, dz = c.z - pos.z;
      const d = Math.hypot(dx, dz) - p.hitRadius;
      if (d > reach) continue;
      const front = d > 0.01 ? (dx * facing.x + dz * facing.z) / (d + p.hitRadius) : 1;
      if (front < -0.2) continue;
      const score = d - front;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  /**
   * Auto-aim for the slingshot: the visible pest closest to the aim direction, within `maxDist`
   * and `maxAngle` (radians) of it, with a clear line from `from`.
   */
  public findAimTarget(from: THREE.Vector3, aim: THREE.Vector3, maxDist: number, maxAngle: number): Pest | null {
    const ax = aim.x, az = aim.z;
    const al = Math.hypot(ax, az) || 1;
    const cosMax = Math.cos(maxAngle);
    let best: Pest | null = null;
    let bestCos = cosMax;
    for (const p of this.pests) {
      if (!p.alive || !p.group.visible) continue;
      const c = p.hitPoint(tmpA);
      const dx = c.x - from.x, dz = c.z - from.z;
      const d = Math.hypot(dx, dz);
      if (d > maxDist || d < 0.01) continue;
      const cos = (dx * ax + dz * az) / (d * al);
      if (cos <= bestCos) continue;
      if (!this.env.canSee(from, c)) continue;
      bestCos = cos;
      best = p;
    }
    return best;
  }

  /**
   * First pest whose body the segment from `from` along the unit `dir` passes through within `len`;
   * returns its distance along the segment in `out.t`.
   */
  public segmentHit(from: THREE.Vector3, dir: THREE.Vector3, len: number, pad: number, out: { t: number }): Pest | null {
    let best: Pest | null = null;
    let bestT = len;
    for (const p of this.pests) {
      if (!p.alive || !p.group.visible) continue;
      const c = p.hitPoint(tmpA);
      const ox = c.x - from.x, oy = c.y - from.y, oz = c.z - from.z;
      const along = ox * dir.x + oy * dir.y + oz * dir.z;
      const r = p.hitRadius + pad;
      if (along < -r || along > bestT + r) continue;
      const perp2 = ox * ox + oy * oy + oz * oz - along * along;
      if (perp2 > r * r) continue;
      const t = Math.max(0, along - Math.sqrt(Math.max(0, r * r - perp2)));
      if (t > bestT) continue;
      bestT = t;
      best = p;
    }
    out.t = bestT;
    return best;
  }

  /** Hits a pest for the player (axe, pebble). */
  public damage(pest: Pest, amount: number, from: THREE.Vector3): boolean {
    return !!this.port && pest.damage(amount, from, this.port, this.particles);
  }

  public clear(): void {
    for (const p of this.pests) p.dispose();
    this.pests.length = 0;
  }
}

export type { Pest };
