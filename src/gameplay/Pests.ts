import * as THREE from 'three';
import { TerrainSystem } from '../world/TerrainSystem';
import { coastRadius } from '../world/IslandGenerator';
import { ParticleManager } from '../particles/ParticleManager';
import { makeBlobShadow } from './Emotes';
import { critterSounds } from './CritterSounds';
import { worldSettings } from '../world/WorldSettings';
import { waterLevelAt, riverWorld } from '../world/rivers/RiverWorld';
import { Shark, SHARK_MIN_DEPTH, seaDepthAt } from './Shark';
import { Spider, flushSpiderLegs, insideRock } from './Spider';
import { setWaterLimb, WATER_ANIMAL_SLOTS } from '../scene/WaterDetails';
import {
  Pest, PestEnv, PestKind, PestPort, PestHabitat, OPEN_ENV, SHARED_GEOS, angleTo, isWalkable, steer, turn,
} from './PestBase';

export type { PestKind, PestEnv, PestPort, PestHabitat } from './PestBase';

const tmpA = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
const tA = new THREE.Vector3();
const sepTmp = new THREE.Vector3();

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
  public readonly habitat = 'land';

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
SHARED_GEOS.add(FIRE_GEO);

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
  private readonly spiderTmp: Spider[] = [];
  private readonly playerVel = new THREE.Vector3();
  /** Seconds without a clear view while chasing: flies closer, then gives up. */
  private lost = 0;
  private knock = 0;
  private knockDir = 0;
  public readonly hitRadius = 0.6;
  public readonly habitat = 'land';

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

/** How many of each kind the wilds keep (driven-off ones come back after a while). */
const NATURAL_COUNT: Record<PestKind, number> = { hedgehog: 5, dragon: 2, shark: 3, spider: 6 };
export const PEST_KINDS: PestKind[] = ['hedgehog', 'dragon', 'shark', 'spider'];

export const PEST_HABITAT: Record<PestKind, PestHabitat> = { hedgehog: 'land', dragon: 'land', shark: 'sea', spider: 'cave' };

/** Keeps hedgehogs and baby dragons in the wilds, sharks in the sea and spiders in the caves. */
export class PestSystem {
  public readonly pests: Pest[] = [];
  public port: PestPort | null = null;
  /** Physics queries for walls and sight lines (set once physics is up). */
  public env: PestEnv = OPEN_ENV;
  /** Whether a point lies in the cave pocket (set by the exploration layer). */
  public isCave: (p: THREE.Vector3) => boolean = () => false;
  /** Whether the caves' colliders are all built (spider spots are checked with rays against them). */
  public caveReady: () => boolean = () => false;
  /** Natural spawning and respawning (the developer panel can switch it off to test by hand). */
  public naturalSpawn = true;
  /** Bumped whenever pests come or go (the developer panel's list). */
  public revision = 0;
  private respawnTimer = 0;
  /** Floor spots in the caves spiders can be put on (chests, mushrooms, ore). */
  private caveSpots: THREE.Vector3[] = [];
  /** New cave spots arrived before the colliders: the natural spiders are put down once they are built. */
  private caveSpawnPending = false;
  private readonly lastPlayer = new THREE.Vector3();
  private readonly spiderTmp: Spider[] = [];

  constructor(private readonly scene: THREE.Scene, private readonly terrain: TerrainSystem, private readonly particles?: ParticleManager) {}

  public populate(player: THREE.Vector3): void {
    this.lastPlayer.copy(player);
    if (!this.naturalSpawn) return;
    for (const kind of PEST_KINDS) {
      let n = 0;
      for (const p of this.pests) if (p.kind === kind && !p.placed) n++;
      for (; n < NATURAL_COUNT[kind]; n++) if (!this.spawnNatural(kind, player)) break;
    }
  }

  /** The cave network was (re)built: its natural spiders move to the new floor spots. */
  public setCaveSpots(spots: THREE.Vector3[]): void {
    this.caveSpots = spots.map((p) => p.clone());
    for (let i = this.pests.length - 1; i >= 0; i--) {
      const p = this.pests[i];
      if (p.kind !== 'spider' || p.placed) continue;
      p.dispose();
      this.pests.splice(i, 1);
    }
    this.caveSpawnPending = true;
    this.revision++;
  }

  /**
   * A safe spot for a spider near the floor point `s`: in open air (not inside the rock), on a
   * floor with room around it and out of the water; sometimes up on the ceiling above it instead.
   */
  private caveSpot(s: THREE.Vector3, ceiling: boolean): { pos: THREE.Vector3; up: THREE.Vector3 } | null {
    const env = this.env;
    const o = tA.copy(s).setY(s.y + 0.6);
    if (insideRock(env, o)) return null;
    const n = new THREE.Vector3();
    const t = env.cast(o, tmpEye.set(0, -1, 0), 1.6, n);
    if (t < 0 || n.y < 0.5) return null;
    const floor = new THREE.Vector3(o.x, o.y - t, o.z);
    // Room for the legs: walls close on three sides or more is a crevice
    let walls = 0;
    const side = new THREE.Vector3();
    const from = new THREE.Vector3(floor.x, floor.y + 0.4, floor.z);
    for (let i = 0; i < 4; i++) {
      side.set(Math.cos((i * Math.PI) / 2), 0, Math.sin((i * Math.PI) / 2));
      if (env.sweep(from, side, 0.7) >= 0) walls++;
    }
    if (walls >= 3) return null;
    if (riverWorld.waterLevelAt3(from.x, from.y, from.z) > from.y) return null;
    if (ceiling) {
      const up = new THREE.Vector3();
      const tc = env.cast(from, side.set(0, 1, 0), 10, up);
      if (tc > 1.5 && up.y < -0.5) {
        const c = from.clone().setY(from.y + tc);
        if (riverWorld.waterLevelAt3(c.x, c.y - 0.4, c.z) <= c.y - 0.4) return { pos: c, up };
      }
    }
    return { pos: floor, up: n };
  }

  private create(kind: PestKind, x: number, y: number, z: number, up?: THREE.Vector3): Pest {
    const pest =
      kind === 'hedgehog' ? new Hedgehog(x, z, this.terrain)
      : kind === 'dragon' ? new BabyDragon(x, z, this.terrain, this.scene)
      : kind === 'shark' ? new Shark(x, y, z, this.terrain)
      : new Spider(x, y, z, this.terrain, this.scene, up);
    this.pests.push(pest);
    this.scene.add(pest.group);
    this.revision++;
    // Uploaded at once: in the editor the pests are not stepped, the legs still have to show
    flushSpiderLegs();
    return pest;
  }

  private spawnNatural(kind: PestKind, player: THREE.Vector3): boolean {
    for (let tries = 0; tries < 40; tries++) {
      if (kind === 'spider') {
        if (!this.caveSpots.length || !this.caveReady()) return false;
        const s = this.caveSpots[Math.floor(Math.random() * this.caveSpots.length)];
        // Not right next to the player, and not two on one spot
        if (tries < 30 && s.distanceTo(player) < 20) continue;
        if (tries < 30 && this.pests.some((p) => p.kind === 'spider' && p.position.distanceToSquared(s) < 9)) continue;
        const spot = this.caveSpot(s, Math.random() < 0.4);
        if (!spot) continue;
        this.create('spider', spot.pos.x, spot.pos.y, spot.pos.z, spot.up);
        return true;
      }
      const a = Math.random() * Math.PI * 2;
      if (kind === 'shark') {
        // Out in the open sea, beyond the shallows round the coast
        const r = coastRadius(Math.cos(a), Math.sin(a)) + 20 + Math.random() * 120;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (Math.hypot(x - player.x, z - player.z) < 45) continue;
        if (seaDepthAt(this.terrain, x, z) < SHARK_MIN_DEPTH + 1.5) continue;
        this.create('shark', x, worldSettings.waterLevel - 0.6, z);
        return true;
      }
      // Pests live out in the wilds, not on the farm itself
      const minR = kind === 'dragon' ? 70 : 40;
      const r = minR + Math.random() * 160;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x, z) > coastRadius(x, z) - 25) continue;
      if (!isWalkable(this.terrain, x, z)) continue;
      if (Math.hypot(x - player.x, z - player.z) < 35) continue;
      this.create(kind, x, 0, z);
      return true;
    }
    return false;
  }

  /**
   * Why `kind` cannot be put at `at` (a message for the developer panel), or null when it can.
   * `onIsland`: the point is on the island's heightmap (false in the caves).
   */
  public placementError(kind: PestKind, at: THREE.Vector3, onIsland: boolean, normal?: THREE.Vector3): string | null {
    if (kind === 'shark') {
      if (!onIsland || this.isCave(at)) return 'Акули живуть лише в морі';
      if (seaDepthAt(this.terrain, at.x, at.z) < SHARK_MIN_DEPTH) return `Акулі потрібне глибоке море (від ${SHARK_MIN_DEPTH} м)`;
      return null;
    }
    if (kind === 'spider') {
      if (onIsland && !this.isCave(at) && at.y < waterLevelAt(at.x, at.z) - 0.1) return 'Павуки не плавають: оберіть сушу або печеру';
      // The body (off the surface along its normal) must be out of the water too
      const n = normal ?? tmpEye.set(0, 1, 0);
      if (riverWorld.waterLevelAt3(at.x + n.x * 0.35, at.y + n.y * 0.35, at.z + n.z * 0.35) > at.y + n.y * 0.35) return 'Павуки не плавають: тут вода';
      return null;
    }
    if (!onIsland || this.isCave(at)) return 'Їжаки й дракончики живуть лише на поверхні острова';
    if (!isWalkable(this.terrain, at.x, at.z)) return 'Тут вода або край світу';
    return null;
  }

  /**
   * Puts a pest down by hand (the developer panel). Sharks go to mid-depth of the water column at
   * (x, z); spiders stand on the surface hit (cave floor or island). Null when it cannot go there.
   */
  public spawnAt(kind: PestKind, at: THREE.Vector3, onIsland: boolean, normal?: THREE.Vector3): Pest | null {
    if (this.placementError(kind, at, onIsland, normal)) return null;
    let y = at.y;
    if (kind === 'shark') y = worldSettings.waterLevel - Math.min(seaDepthAt(this.terrain, at.x, at.z) * 0.5, 4);
    const pest = this.create(kind, at.x, y, at.z, normal);
    pest.placed = true;
    return pest;
  }

  /** A pest of `kind` a few metres from the player where it can live; null if there is no such spot near. */
  public spawnNear(kind: PestKind, player: THREE.Vector3, playerInCave: boolean): Pest | null {
    if (kind === 'spider') {
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = 4 + Math.random() * 4;
        tA.set(player.x + Math.cos(a) * d, player.y + 1, player.z + Math.sin(a) * d);
        if (this.isCave(tA) && insideRock(this.env, tA)) continue;
        const n = new THREE.Vector3();
        const down = this.env.cast(tA, tmpEye.set(0, -1, 0), 4, n);
        if (down < 0) continue;
        tA.y -= down;
        if (this.placementError('spider', tA, !playerInCave, n)) continue;
        const p = this.create('spider', tA.x, tA.y, tA.z, n);
        p.placed = true;
        return p;
      }
      return null;
    }
    if (playerInCave) return null;
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = (kind === 'shark' ? 10 : 7) + Math.random() * (kind === 'shark' ? 30 : 8) + i * 0.6;
      tA.set(player.x + Math.cos(a) * d, 0, player.z + Math.sin(a) * d);
      tA.y = this.terrain.getHeight(tA.x, tA.z);
      const p = this.spawnAt(kind, tA, true);
      if (p) return p;
    }
    return null;
  }

  public remove(pest: Pest): void {
    const i = this.pests.indexOf(pest);
    if (i < 0) return;
    pest.dispose();
    this.pests.splice(i, 1);
    this.revision++;
    flushSpiderLegs();
  }

  public update(dt: number, player: THREE.Vector3, active: boolean, playerInCave: boolean): void {
    const port = this.port;
    if (!port) return;
    this.lastPlayer.copy(player);
    this.separateSpiders();
    for (let i = this.pests.length - 1; i >= 0; i--) {
      const p = this.pests[i];
      // Only the pests of the world the player is in (the surface or the caves) are simulated
      const here = this.isCave(p.position) === playerInCave;
      p.update(active && here ? dt : 0, player, port, this.env, this.particles);
      if (p.removed) {
        p.dispose();
        this.pests.splice(i, 1);
        this.revision++;
      }
    }
    flushSpiderLegs();
    this.feedSharkWakes(player);
    if (this.caveSpawnPending && this.caveReady()) {
      this.caveSpawnPending = false;
      if (this.naturalSpawn) {
        let n = 0;
        for (const p of this.pests) if (p.kind === 'spider' && !p.placed) n++;
        for (; n < NATURAL_COUNT.spider; n++) if (!this.spawnNatural('spider', player)) break;
      }
    }
    // Driven-off pests come back after a while, somewhere else
    this.respawnTimer -= dt;
    if (this.respawnTimer <= 0) {
      this.respawnTimer = 90;
      if (!this.naturalSpawn) return;
      for (const kind of PEST_KINDS) {
        let n = 0;
        for (const p of this.pests) if (p.kind === kind && !p.placed) n++;
        if (n < NATURAL_COUNT[kind] && this.spawnNatural(kind, player)) break;
      }
    }
  }

  /** Spiders whose leg spans overlap get pushed apart (a handful of spiders: pairwise is cheap). */
  private separateSpiders(): void {
    const sp = this.spiderTmp;
    sp.length = 0;
    for (const p of this.pests) if (p instanceof Spider) { p.avoid.set(0, 0, 0); sp.push(p); }
    for (let i = 0; i < sp.length; i++) {
      const a = sp[i];
      for (let j = i + 1; j < sp.length; j++) {
        const b = sp[j];
        const r = a.spacing + b.spacing;
        sepTmp.subVectors(a.position, b.position);
        const d2 = sepTmp.lengthSq();
        if (d2 >= r * r) continue;
        const d = Math.sqrt(d2);
        // Exactly on top of each other: split them along an arbitrary direction
        if (d < 1e-3) sepTmp.set(Math.cos(a.id * 2.4), 0, Math.sin(a.id * 2.4));
        else sepTmp.divideScalar(d);
        const w = (r - d) / r;
        a.avoid.addScaledVector(sepTmp, w);
        b.avoid.addScaledVector(sepTmp, -w);
      }
    }
  }

  /** Up to `max` sharks within `range` of `near`, always in the same (id) order. */
  public sharksNear(near: THREE.Vector3, range: number, max: number, out: Shark[]): Shark[] {
    out.length = 0;
    const r2 = range * range;
    for (const p of this.pests) {
      if (!(p instanceof Shark) || !p.group.visible) continue;
      if (p.position.distanceToSquared(near) > r2) continue;
      out.push(p);
    }
    if (out.length > max) {
      out.sort((a, b) => a.position.distanceToSquared(near) - b.position.distanceToSquared(near));
      out.length = max;
    }
    return out.sort((a, b) => a.id - b.id);
  }

  /** The sharks nearest the player whose fins cut the surface push the wave simulation. */
  private feedSharkWakes(player: THREE.Vector3): void {
    let a: Shark | null = null, b: Shark | null = null;
    let da = 30 * 30, db = 30 * 30;
    for (const p of this.pests) {
      if (!(p instanceof Shark) || p.wakeSpeed <= 0) continue;
      const d = p.position.distanceToSquared(player);
      if (d < da) {
        b = a; db = da;
        a = p; da = d;
      } else if (d < db) {
        b = p; db = d;
      }
    }
    for (let i = 0; i < WATER_ANIMAL_SLOTS.length; i++) {
      const s = i === 0 ? a : b;
      if (s) setWaterLimb(WATER_ANIMAL_SLOTS[i], s.wakeAt.x, s.wakeAt.z, s.wakeSpeed, 0.5);
    }
  }

  /** Highest threat (0..2) of the pests within `maxDist` of the player (for the danger music). */
  public threatLevel(player: THREE.Vector3, maxDist = 35): number {
    let level = 0;
    for (const p of this.pests) {
      const t = p.threat;
      if (t <= level || p.removed) continue;
      if (p.position.distanceToSquared(player) <= maxDist * maxDist) level = t;
    }
    return level;
  }

  /** Nearest pest to the player (for the compass / HUD warning, and no sleeping with one about). */
  public nearestThreat(player: THREE.Vector3, maxDist: number): Pest | null {
    let best: Pest | null = null;
    let bestD = maxDist;
    for (const p of this.pests) {
      const d = p.position.distanceTo(player);
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
    this.revision++;
    flushSpiderLegs();
  }
}

export type { Pest };
