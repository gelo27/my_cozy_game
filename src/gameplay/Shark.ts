import * as THREE from 'three';
import { TerrainSystem } from '../world/TerrainSystem';
import { SEA_BED_TOP, WORLD_LIMIT, worldSettings } from '../world/WorldSettings';
import { waterLevelAt } from '../world/rivers/RiverWorld';
import { ParticleManager } from '../particles/ParticleManager';
import { critterSounds } from './CritterSounds';
import { emitWaterRipple } from '../scene/WaterDetails';
import { Pest, PestEnv, PestPort, angleTo, turn } from './PestBase';
import { SharkRig, getSharkAsset } from './SharkModel';

/** Open water a shark needs under it (m from the surface to the bed). */
export const SHARK_MIN_DEPTH = 2.4;

/** Sea bed height: the heightmap over the island's square, the flat open-sea bed beyond it. */
export function seaBedAt(terrain: TerrainSystem, x: number, z: number): number {
  return terrain.isInside(x, z) ? terrain.getHeight(x, z) : SEA_BED_TOP;
}

/** Depth of the sea at (x, z), or -1 where it is not the sea (dry land, a river, past the world's walls). */
export function seaDepthAt(terrain: TerrainSystem, x: number, z: number): number {
  const lim = WORLD_LIMIT - 15;
  if (Math.abs(x) > lim || Math.abs(z) > lim) return -1;
  const level = worldSettings.waterLevel;
  // Rivers and lakes have their own surface: sharks keep to the sea
  if (terrain.isInside(x, z) && Math.abs(waterLevelAt(x, z) - level) > 0.05) return -1;
  return level - seaBedAt(terrain, x, z);
}

type SharkState = 'cruise' | 'circle' | 'charge' | 'retreat';

const SHARK_MATS = {
  back: new THREE.MeshLambertMaterial({ color: 0x627789 }),
  belly: new THREE.MeshLambertMaterial({ color: 0xe6e2d8 }),
  fin: new THREE.MeshLambertMaterial({ color: 0x55697a, side: THREE.DoubleSide }),
  dark: new THREE.MeshBasicMaterial({ color: 0x101418 }),
  mouth: new THREE.MeshBasicMaterial({ color: 0x6e1d24, side: THREE.DoubleSide }),
  teeth: new THREE.MeshLambertMaterial({ color: 0xfbf8ee }),
};

/** Fin outline in the body's side plane: `u` runs back along the body, `v` up. */
function finGeometry(points: [number, number][]): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const g = new THREE.ShapeGeometry(shape);
  g.rotateY(Math.PI / 2); // (u, v) -> (z = -u, y = v)
  return g;
}

const tmpDir = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const SWIM_OFFSETS = [0, 0.5, -0.5, 1.1, -1.1, 1.8, -1.8, Math.PI];
/** Body capsules (distance along the body, radius) of the built-in body and of the rigged model. */
const BODY_CAPSULES = [[1.1, 0.55], [-0.2, 0.6], [-1.5, 0.42]];
const RIG_CAPSULES = [[0.95, 0.5], [-0.5, 0.55], [-1.9, 0.38]];
/** Sinking after the death roll (m/s) and how long it sinks before it is gone (s). */
const DEAD_SINK = 0.5;
const DEAD_SINK_TIME = 1.6;

/**
 * A reef shark. It cruises the open sea with its fin cutting the surface; once the player swims
 * within reach it circles them, tighter each lap, then rushes in to bite and swims off to circle
 * again. It never leaves deep water, so the shallows and the land are safe.
 */
export class Shark extends Pest {
  public readonly hitRadius = 0.9;
  public readonly habitat = 'sea';
  private state: SharkState = 'cruise';
  private pitch = 0;
  private roll = 0;
  private speed = 2;
  private phase = Math.random() * 10;
  private orbit = 0;
  private orbitR = 9;
  private orbitDir = Math.random() < 0.5 ? 1 : -1;
  private jawOpen = 0;
  private charged = 0;
  private bit = false;
  private lostWater = 0;
  private knock = 0;
  private readonly knockDir = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly body = new THREE.Group();
  private readonly rear = new THREE.Group();
  private readonly tail = new THREE.Group();
  private readonly jaw = new THREE.Group();
  private readonly fins: THREE.Object3D[] = [];
  /** Cutting the surface this frame: the fin's spot and the speed of its wake (0 under water). */
  public readonly wakeAt = new THREE.Vector3();
  public wakeSpeed = 0;
  private rippleTimer = 0;
  private bowTimer = 0;
  /** The rigged model once it has loaded (until then the built-in body swims). */
  private rig: SharkRig | null = null;
  /** Turn bend fed to the rig: -1 hard right .. 1 hard left. */
  private bend = 0;
  private biteBoost = 0;
  private dieTime = 0;

  constructor(x: number, y: number, z: number, terrain: TerrainSystem) {
    super('shark', x, z, terrain, 1.6, 6);
    this.position.y = y;
    this.home.copy(this.position);
    this.wander.copy(this.position);
    this.buildModel();
    this.group.rotation.order = 'YXZ';
    this.attachRig();
    this.pickSeaWander(30);
  }

  /** Swaps the built-in body for the rigged model when it is loaded. */
  private attachRig(): void {
    const a = getSharkAsset();
    if (!a || this.rig) return;
    this.rig = new SharkRig(a);
    this.group.remove(this.body);
    this.group.add(this.rig.root);
  }

  /** Dorsal fin tip over the body's centre (m). */
  private get finTop(): number {
    return this.rig ? this.rig.finTop : 1.3;
  }

  private buildModel(): void {
    const sphere = new THREE.SphereGeometry(1, 16, 12);
    const add = (parent: THREE.Object3D, mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(sphere, mat);
      m.scale.set(sx, sy, sz);
      m.position.set(x, y, z);
      m.userData.shared = true;
      parent.add(m);
      return m;
    };
    // Torso and head (the shark faces +Z)
    add(this.body, SHARK_MATS.back, 0.55, 0.58, 1.35, 0, 0.02, 0.35);
    add(this.body, SHARK_MATS.belly, 0.5, 0.42, 1.25, 0, -0.16, 0.38);
    add(this.body, SHARK_MATS.back, 0.4, 0.34, 0.75, 0, 0.04, 1.25);
    add(this.body, SHARK_MATS.belly, 0.36, 0.22, 0.62, 0, -0.1, 1.28);
    for (const sx of [-1, 1]) {
      const eye = add(this.body, SHARK_MATS.dark, 0.06, 0.06, 0.06, sx * 0.3, 0.12, 1.42);
      eye.rotation.y = sx * 0.3;
      for (let i = 0; i < 3; i++) {
        const gill = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.26, 0.03), SHARK_MATS.dark);
        gill.position.set(sx * 0.47, 0.0, 0.92 - i * 0.12);
        gill.rotation.z = sx * 0.12;
        this.body.add(gill);
      }
    }
    // Upper teeth under the snout, and the jaw that drops open for a bite
    const toothGeo = new THREE.ConeGeometry(0.035, 0.09, 4);
    for (let i = 0; i < 7; i++) {
      const a = (i / 6 - 0.5) * 2.2;
      const t = new THREE.Mesh(toothGeo, SHARK_MATS.teeth);
      t.position.set(Math.sin(a) * 0.24, -0.2, 1.38 + Math.cos(a) * 0.18);
      t.rotation.x = Math.PI;
      t.userData.shared = true;
      this.body.add(t);
    }
    this.jaw.position.set(0, -0.2, 1.05);
    const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.3, 12, 0, Math.PI), SHARK_MATS.mouth);
    mouth.rotation.x = -Math.PI / 2;
    mouth.rotation.z = -Math.PI / 2;
    mouth.scale.set(1.4, 1, 1);
    mouth.position.set(0, 0.0, 0.2);
    this.jaw.add(mouth);
    add(this.jaw, SHARK_MATS.belly, 0.3, 0.08, 0.42, 0, -0.06, 0.2);
    for (let i = 0; i < 6; i++) {
      const a = (i / 5 - 0.5) * 2;
      const t = new THREE.Mesh(toothGeo, SHARK_MATS.teeth);
      t.position.set(Math.sin(a) * 0.22, 0.03, 0.2 + Math.cos(a) * 0.2);
      t.userData.shared = true;
      this.jaw.add(t);
    }
    this.body.add(this.jaw);
    // Dorsal fin (it cuts the surface while cruising) and the pectorals
    const dorsal = new THREE.Mesh(finGeometry([[-0.25, 0.3], [0.45, 1.25], [0.62, 1.2], [0.5, 0.95], [0.55, 0.3]]), SHARK_MATS.fin);
    dorsal.position.set(0, 0.25, 0.4);
    this.body.add(dorsal);
    const pectGeo = new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(0, 0.25), new THREE.Vector2(0.95, -0.35), new THREE.Vector2(0.85, -0.5), new THREE.Vector2(0, -0.2)]));
    pectGeo.rotateX(-Math.PI / 2);
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.42, -0.25, 0.7);
      const fin = new THREE.Mesh(pectGeo, SHARK_MATS.fin);
      fin.userData.shared = sx > 0;
      fin.scale.x = sx;
      fin.rotation.z = -sx * 0.35;
      pivot.add(fin);
      this.fins.push(pivot);
      this.body.add(pivot);
    }
    // Rear body bends behind the dorsal fin, the tail behind it again (an S-curve while swimming)
    this.rear.position.set(0, 0, -0.75);
    add(this.rear, SHARK_MATS.back, 0.4, 0.44, 1.0, 0, 0.04, -0.55);
    add(this.rear, SHARK_MATS.belly, 0.34, 0.3, 0.9, 0, -0.1, -0.5);
    add(this.rear, SHARK_MATS.back, 0.2, 0.22, 0.5, 0, 0.05, -1.45);
    const second = new THREE.Mesh(finGeometry([[0, 0], [0.25, 0.32], [0.35, 0.3], [0.35, 0]]), SHARK_MATS.fin);
    second.position.set(0, 0.32, -1.0);
    this.rear.add(second);
    for (const sx of [-1, 1]) {
      const pelvic = new THREE.Mesh(pectGeo, SHARK_MATS.fin);
      pelvic.userData.shared = true;
      pelvic.scale.set(sx * 0.4, 1, 0.4);
      pelvic.position.set(sx * 0.25, -0.3, -0.7);
      pelvic.rotation.z = -sx * 0.4;
      this.rear.add(pelvic);
    }
    this.tail.position.set(0, 0.05, -1.75);
    const caudal = new THREE.Mesh(finGeometry([[-0.1, 0.05], [0.55, 1.0], [0.72, 0.98], [0.45, 0.15], [0.42, -0.1], [0.6, -0.55], [0.48, -0.58], [-0.1, -0.08]]), SHARK_MATS.fin);
    this.tail.add(caudal);
    this.rear.add(this.tail);
    this.body.add(this.rear);
    this.group.add(this.body);
  }

  public dispose(): void {
    this.rig?.dispose();
    super.dispose();
  }

  public hitPoint(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position);
  }

  /**
   * The body as three upright capsules (head, middle, tail) for things it pushes through, like
   * the algae: `add(x, bottomY, z, radius, height)` in that order every frame.
   */
  public bodyCapsules(add: (x: number, y: number, z: number, r: number, h: number) => void): void {
    const p = this.position;
    const c = Math.cos(this.pitch);
    const dx = Math.sin(this.heading) * c, dy = Math.sin(this.pitch), dz = Math.cos(this.heading) * c;
    const tail = this.tail.rotation.y + this.rear.rotation.y;
    const caps = this.rig ? RIG_CAPSULES : BODY_CAPSULES;
    for (const [along, r] of caps) {
      // The tail end swings with the stroke
      const sway = along < 0 ? Math.sin(tail) * -along * 0.6 : 0;
      add(p.x + dx * along + dz * sway, p.y + dy * along - 0.55, p.z + dz * along - dx * sway, r, 1.1);
    }
  }

  get threat(): number {
    if (this.dying > 0) return 0;
    return this.state === 'charge' ? 2 : this.state === 'circle' ? 1 : 0;
  }

  protected onHurt(from: THREE.Vector3): void {
    // A smack on the nose: it veers off, then comes back circling
    this.knockDir.subVectors(this.position, from).setY(0);
    if (this.knockDir.lengthSq() < 1e-4) this.knockDir.set(Math.sin(this.heading), 0, Math.cos(this.heading)).negate();
    this.knockDir.normalize();
    this.knock = 4;
    this.state = 'retreat';
    this.timer = 2.5;
    this.emote.show('angry', 1);
    this.rig?.playHurt();
  }

  protected onDefeated(): number {
    this.wakeSpeed = 0;
    this.dieTime = 0;
    const roll = this.rig ? this.rig.playDeath() : 1.2;
    return roll + DEAD_SINK_TIME;
  }

  /** Belly up, drifting to a stop, then sinking away in a puff. */
  private updateDying(dt: number, particles?: ParticleManager): void {
    const pos = this.position;
    this.dieTime += dt;
    this.speed *= Math.exp(-dt * 1.5);
    const sx = Math.sin(this.heading), sz = Math.cos(this.heading);
    if (seaDepthAt(this.terrain, pos.x + sx * 2, pos.z + sz * 2) >= SHARK_MIN_DEPTH) {
      pos.x += sx * this.speed * dt;
      pos.z += sz * this.speed * dt;
    }
    const sinkFrom = this.dying - DEAD_SINK_TIME;
    if (this.dieTime > sinkFrom) {
      const bed = worldSettings.waterLevel - Math.max(0, seaDepthAt(this.terrain, pos.x, pos.z)) + 0.7;
      pos.y = Math.max(bed, pos.y - DEAD_SINK * dt);
    }
    this.pitch *= Math.exp(-dt * 3);
    // The rig's death clip rolls it over; the built-in body rolls as a whole
    const wantRoll = this.rig ? 0 : Math.PI * Math.min(1, this.dieTime / sinkFrom);
    this.roll += (wantRoll - this.roll) * Math.min(1, dt * 4);
    this.group.rotation.set(-this.pitch, this.heading, this.roll);
    this.rig?.tick(dt);
    this.emote.update(dt);
    this.applyWobble(dt);
    if (this.dieTime >= this.dying) {
      const at = this.hitPoint(tmpP);
      critterSounds.poof(at);
      particles?.emitBuildPuff(at, false, 26);
      this.removed = true;
    }
  }

  /** Surface / bed limits of the body centre at (x, z). */
  private depthRange(x: number, z: number, out: { top: number; bottom: number }): boolean {
    const depth = seaDepthAt(this.terrain, x, z);
    if (depth < SHARK_MIN_DEPTH) return false;
    out.top = worldSettings.waterLevel - 0.45;
    out.bottom = worldSettings.waterLevel - depth + 0.9;
    return true;
  }

  private pickSeaWander(radius: number): void {
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 6 + Math.random() * radius;
      const x = this.home.x + Math.cos(a) * r;
      const z = this.home.z + Math.sin(a) * r;
      if (seaDepthAt(this.terrain, x, z) >= SHARK_MIN_DEPTH + 0.5) {
        this.wander.set(x, worldSettings.waterLevel - 0.55, z);
        return;
      }
    }
    this.wander.copy(this.home);
  }

  public update(dt: number, player: THREE.Vector3, port: PestPort, env: PestEnv, particles?: ParticleManager): void {
    const pos = this.position;
    const dx = player.x - pos.x, dz = player.z - pos.z;
    const dist = Math.hypot(dx, dz);
    this.group.visible = dist < 120;
    this.wakeSpeed = 0;
    if (!this.rig) this.attachRig();
    if (this.dying > 0) {
      if (dt > 0) this.updateDying(dt, particles);
      return;
    }
    if (dist > 90 && this.state === 'cruise') return;
    if (dt <= 0) return;
    this.time += dt;
    this.timer -= dt;
    this.emote.update(dt);
    const dist3 = Math.hypot(dist, player.y - pos.y);
    const swimming = port.playerSwimming();
    const sees = dist3 < 28 && this.look(dt, pos, player, env, 28);
    const lim = { top: 0, bottom: 0 };
    let want = 2.2;
    let turnRate = 1.6;
    let jaw = 0;

    // Interest only while the player is in the sea
    if (this.state !== 'cruise') {
      this.lostWater = swimming ? 0 : this.lostWater + dt;
      if (this.lostWater > 2.5 || dist > 40) {
        this.state = 'cruise';
        this.home.copy(pos);
        this.pickSeaWander(25);
      }
    }

    switch (this.state) {
      case 'cruise': {
        if (swimming && (sees || this.provoked) && dist3 < 22) {
          this.provoked = false;
          this.state = 'circle';
          this.orbit = Math.atan2(pos.x - player.x, pos.z - player.z);
          this.orbitR = Math.min(10, Math.max(7, dist));
          this.timer = 4 + Math.random() * 3;
          this.emote.show('alert', 1);
          critterSounds.sharkSurge(pos);
          break;
        }
        if ((this.wander.x - pos.x) ** 2 + (this.wander.z - pos.z) ** 2 < 6) this.pickSeaWander(30);
        this.target.copy(this.wander);
        break;
      }
      case 'circle': {
        // Laps around the player, closing in, at their depth
        this.orbitR = Math.max(4.5, this.orbitR - dt * 0.6);
        this.orbit += (dt * 4.2 * this.orbitDir) / this.orbitR;
        this.target.set(player.x + Math.sin(this.orbit) * this.orbitR, player.y - 0.3, player.z + Math.cos(this.orbit) * this.orbitR);
        want = 4.2;
        turnRate = 2.4;
        if (this.timer <= 0 && sees) {
          this.state = 'charge';
          this.charged = 0;
          this.bit = false;
          this.emote.show('angry', 0.9);
          critterSounds.sharkSurge(pos);
        }
        break;
      }
      case 'charge': {
        this.charged += dt;
        this.target.set(player.x, player.y - 0.1, player.z);
        want = 10;
        turnRate = this.charged < 0.6 ? 3.2 : 1.4;
        jaw = 1;
        if (!this.bit && dist3 < 1.75) {
          this.bit = true;
          this.rig?.playBite();
          this.biteBoost = 1;
          critterSounds.sharkBite(pos);
          if (port.hurt(pos, 9, 'shark')) particles?.emitBuildPuff(tmpP.copy(pos).lerp(player, 0.5), false, 10);
          // A bite at the surface throws up a splash ring
          if (pos.y > worldSettings.waterLevel - 1.6) {
            emitWaterRipple(pos.x, pos.z, 1, 4.5);
            emitWaterRipple(pos.x, pos.z, 0.8, 2.2, 1.1);
          }
          this.state = 'retreat';
          this.timer = 2.5 + Math.random();
        } else if (this.charged > 2.4) {
          this.state = 'retreat';
          this.timer = 1.5;
        }
        break;
      }
      case 'retreat': {
        // Swims off, then turns back for another round of circling
        const a = angleTo(player, pos);
        this.target.set(pos.x + Math.sin(a) * 10, player.y, pos.z + Math.cos(a) * 10);
        want = 5;
        turnRate = 2.2;
        if (this.timer <= 0) {
          this.state = 'circle';
          this.orbit = Math.atan2(pos.x - player.x, pos.z - player.z);
          this.orbitR = Math.max(7, Math.min(11, dist));
          this.orbitDir = Math.random() < 0.5 ? 1 : -1;
          this.timer = 3 + Math.random() * 3;
        }
        break;
      }
    }

    // Steering towards the target: yaw and pitch turn at a limited rate
    const prevYaw = this.heading;
    this.speed += (want - this.speed) * Math.min(1, dt * (want > this.speed ? 1.8 : 1.2));
    const tdx = this.target.x - pos.x, tdz = this.target.z - pos.z;
    this.heading = turn(this.heading, Math.atan2(tdx, tdz), dt * turnRate);
    const flat = Math.max(0.5, Math.hypot(tdx, tdz));
    const wantPitch = THREE.MathUtils.clamp(Math.atan2(this.target.y - pos.y, flat), -0.6, 0.6);
    this.pitch += (wantPitch - this.pitch) * Math.min(1, dt * 2.5);

    // Move, staying in deep sea water and out of the pier's piles
    let step = this.speed * dt;
    let yaw = this.heading;
    if (this.knock > 0.05) {
      yaw = Math.atan2(this.knockDir.x, this.knockDir.z);
      step = Math.max(step, this.knock * dt);
      this.knock *= Math.exp(-dt * 3);
    }
    let moved = false;
    for (const off of SWIM_OFFSETS) {
      const a = yaw + off * this.orbitDir;
      const sx = Math.sin(a), sz = Math.cos(a);
      const nx = pos.x + sx * step * Math.cos(this.pitch);
      const nz = pos.z + sz * step * Math.cos(this.pitch);
      // Looks a body length ahead so it turns before the shallows, not in them
      if (!this.depthRange(pos.x + sx * 2.5, pos.z + sz * 2.5, lim) || !this.depthRange(nx, nz, lim)) continue;
      if (env.blocked(pos.x, pos.y, pos.z, sx, sz, this.hitRadius + step + 0.5)) continue;
      pos.x = nx;
      pos.z = nz;
      if (off !== 0) this.heading = turn(this.heading, a, dt * 4);
      moved = true;
      break;
    }
    if (!moved) {
      this.heading += dt * 2 * this.orbitDir;
      this.speed *= 0.9;
      this.knock = 0;
      if (this.state === 'charge') {
        this.state = 'retreat';
        this.timer = 1.5;
      }
    }
    pos.y += Math.sin(this.pitch) * step;
    if (this.depthRange(pos.x, pos.z, lim)) pos.y = THREE.MathUtils.clamp(pos.y, lim.bottom, lim.top);

    // Pose: banks into turns, body and tail sweep in an S that quickens with speed
    let yawRate = this.heading - prevYaw;
    yawRate = Math.atan2(Math.sin(yawRate), Math.cos(yawRate)) / dt;
    this.roll += (THREE.MathUtils.clamp(-yawRate * 0.35, -0.6, 0.6) - this.roll) * Math.min(1, dt * 3);
    this.group.rotation.set(-this.pitch, this.heading, this.roll);
    this.phase += dt * (2.2 + this.speed * 0.9);
    const amp = 0.12 + Math.min(0.12, this.speed * 0.012);
    this.body.rotation.y = Math.sin(this.phase + 1.2) * amp * 0.25;
    this.rear.rotation.y = Math.sin(this.phase) * amp;
    this.tail.rotation.y = Math.sin(this.phase - 1.1) * amp * 2.6;
    this.fins[0].rotation.x = this.fins[1].rotation.x = Math.sin(this.phase * 0.5) * 0.08 + this.pitch * 0.6;
    // The bite clip snaps the jaw itself: the held-open pose lets go fast as it starts
    this.biteBoost = Math.max(0, this.biteBoost - dt * 2);
    if (this.biteBoost > 0) jaw = 0;
    this.jawOpen += (jaw - this.jawOpen) * Math.min(1, dt * (this.biteBoost > 0 ? 25 : 10));
    this.jaw.rotation.x = this.jawOpen * 0.55;
    // Heading climbing = turning left (towards +X while facing +Z)
    this.bend += (THREE.MathUtils.clamp(yawRate / 1.6, -1, 1) - this.bend) * Math.min(1, dt * 4);
    this.rig?.update(dt, this.speed, this.bend, this.jawOpen);
    this.emote.sprite.position.set(0, 1.6, 0);
    this.applyWobble(dt);
    this.surfaceWake(dt);
  }

  /**
   * Near the surface the fin (and the back, when it is right up) cuts the water: rings spread from
   * it, squeezed ahead and stretched behind by its motion, and the wave simulation gets a pusher.
   */
  private surfaceWake(dt: number): void {
    const pos = this.position;
    const sea = worldSettings.waterLevel;
    // The fin reaches `finTop` above the body's centre, the back ~0.42 of that
    const finDepth = sea - (pos.y + this.finTop);
    this.wakeSpeed = 0;
    if (finDepth > 0 || this.speed < 0.3) return;
    const sx = Math.sin(this.heading), sz = Math.cos(this.heading);
    this.wakeAt.set(pos.x + sx * 0.5, sea, pos.z + sz * 0.5);
    this.wakeSpeed = this.speed;
    const vx = sx * this.speed, vz = sz * this.speed;
    this.rippleTimer -= dt;
    if (this.rippleTimer <= 0) {
      this.rippleTimer = THREE.MathUtils.clamp(0.5 - this.speed * 0.04, 0.12, 0.4);
      emitWaterRipple(this.wakeAt.x, this.wakeAt.z, Math.min(1, 0.3 + this.speed * 0.06), 1.1 + this.speed * 0.2, undefined, vx, vz);
    }
    // The back breaking the surface: a broad bow wave off the head
    const backOut = pos.y + this.finTop * 0.42 > sea - 0.1;
    this.bowTimer -= dt;
    if (backOut && this.bowTimer <= 0 && this.speed > 1.5) {
      this.bowTimer = 0.35;
      emitWaterRipple(pos.x + sx * 1.4, pos.z + sz * 1.4, Math.min(1, 0.35 + this.speed * 0.05), 2.2 + this.speed * 0.25, undefined, vx, vz);
    }
  }
}
