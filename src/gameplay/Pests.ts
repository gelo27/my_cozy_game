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

/** The most open direction close to `angle` (dry land, no cliff); NaN when boxed in. */
function steer(terrain: TerrainSystem, x: number, z: number, angle: number, look: number, maxClimb = 0.9): number {
  const h0 = terrain.getHeight(x, z);
  for (const off of STEER_OFFSETS) {
    const a = angle + off;
    const sx = x + Math.sin(a) * look;
    const sz = z + Math.cos(a) * look;
    if (!isWalkable(terrain, sx, sz)) continue;
    if (Math.abs(terrain.getHeight(sx, sz) - h0) > maxClimb) continue;
    return a;
  }
  return NaN;
}

/** What the pests can do to the player (filled in by the gameplay layer). */
export interface PestPort {
  /** Hit the player from `from` with knockback power; returns false while the player is invulnerable. */
  hurt(from: THREE.Vector3, power: number, kind: PestKind): boolean;
}

const tmpA = new THREE.Vector3();

function angleTo(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function turn(current: number, target: number, maxStep: number): number {
  let d = target - current;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return current + Math.max(-maxStep, Math.min(maxStep, d));
}

abstract class Pest {
  public readonly group = new THREE.Group();
  public removed = false;
  protected time = Math.random() * 10;
  protected timer = 0;
  protected heading = Math.random() * Math.PI * 2;
  protected readonly home = new THREE.Vector3();
  protected readonly wander = new THREE.Vector3();
  protected readonly emote: EmoteBubble;
  protected readonly stars: THREE.Sprite[] = [];

  constructor(public readonly kind: PestKind, x: number, z: number, protected readonly terrain: TerrainSystem, emoteHeight: number) {
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

  /** Centre of the pest's body (for sounds and effects). */
  abstract hitPoint(out: THREE.Vector3): THREE.Vector3;
  abstract update(dt: number, player: THREE.Vector3, port: PestPort, particles?: ParticleManager): void;

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

  constructor(x: number, z: number, terrain: TerrainSystem) {
    super('hedgehog', x, z, terrain, 1.0);
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

  public update(dt: number, player: THREE.Vector3, port: PestPort, particles?: ParticleManager): void {
    const pos = this.position;
    const dist = Math.hypot(player.x - pos.x, player.z - pos.z);
    this.group.visible = dist < 110;
    if (dist > 80 && this.state !== 'roll') return;
    this.time += dt;
    this.timer -= dt;
    this.emote.update(dt);
    let speed = 0;
    let wantCurl = 0;

    switch (this.state) {
      case 'wander': {
        if (dist < 11 && Math.abs(player.y - pos.y) < 3) {
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
        // Gently homes in on the player; accelerates down the line
        this.heading = turn(this.heading, angleTo(pos, player), dt * 0.9);
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
          this.state = 'calm';
          this.timer = 3.5;
          this.home.copy(pos);
          this.pickWander(6);
        }
        break;
      case 'calm':
        // Does not get angry again right away
        if (this.timer <= 0) this.state = 'wander';
        break;
    }

    // Movement on the heightmap (bounces off water and cliffs)
    if (speed > 0) {
      const nx = pos.x + Math.sin(this.heading) * speed * dt;
      const nz = pos.z + Math.cos(this.heading) * speed * dt;
      if (isWalkable(this.terrain, nx, nz) && Math.abs(this.terrain.getHeight(nx, nz) - this.terrain.getHeight(pos.x, pos.z)) < 0.6) {
        pos.x = nx;
        pos.z = nz;
      } else if (this.state === 'roll') {
        this.heading += Math.PI;
        this.endRoll();
      } else {
        const a = steer(this.terrain, pos.x, pos.z, this.heading, 1, 0.6);
        if (!Number.isNaN(a)) this.heading = a;
        else this.pickWander(6);
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
  }

  private endRoll(): void {
    this.state = 'dazed';
    this.timer = 2.2;
    this.rollSpeed = 0;
  }
}

// ------------------------------------------------------------------ baby dragon

type DragonState = 'patrol' | 'aggro' | 'inhale' | 'rest';

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

  constructor(x: number, z: number, terrain: TerrainSystem, private readonly scene: THREE.Scene) {
    super('dragon', x, z, terrain, 1.55);
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

  public update(dt: number, player: THREE.Vector3, port: PestPort, particles?: ParticleManager): void {
    const pos = this.position;
    const dist = Math.hypot(player.x - pos.x, player.z - pos.z);
    this.updateFireballs(dt, player, port, particles);
    this.group.visible = dist < 140;
    if (dist > 100 && !this.fireballs.length) return;
    this.time += dt;
    this.timer -= dt;
    this.emote.update(dt);

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
        if (dist < 22) {
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

    // Flight
    if (speed > 0) {
      const nx = pos.x + Math.sin(moveDir) * speed * dt;
      const nz = pos.z + Math.cos(moveDir) * speed * dt;
      if (this.terrain.isInside(nx, nz) && Math.hypot(nx, nz) < coastRadius(nx, nz) - 10) {
        pos.x = nx;
        pos.z = nz;
      } else {
        this.strafe *= -1;
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

  private updateFireballs(dt: number, player: THREE.Vector3, port: PestPort, particles?: ParticleManager): void {
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const f = this.fireballs[i];
      f.life -= dt;
      f.mesh.position.addScaledVector(f.vel, dt);
      f.mesh.rotation.y += dt * 9;
      f.mesh.children[1].scale.setScalar(0.22 + Math.sin(this.time * 30 + i) * 0.04);
      const p = f.mesh.position;
      const hitPlayer = p.distanceTo(tmpA.copy(player)) < 0.95;
      const ground = this.terrain.getHeight(p.x, p.z);
      if (hitPlayer || p.y <= ground + 0.1 || f.life <= 0) {
        this.explode(p, particles);
        // Splash damage near the impact
        if (hitPlayer || Math.hypot(player.x - p.x, player.z - p.z) < 1.5) port.hurt(p, 7, 'dragon');
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
      p.update(active ? dt : 0, player, port, this.particles);
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

  public clear(): void {
    for (const p of this.pests) p.dispose();
    this.pests.length = 0;
  }
}
