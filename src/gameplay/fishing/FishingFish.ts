import * as THREE from 'three';
import { shapeFishGeometry } from '../../entities/FishFlockSystem';
import { isMobileDevice, worldSettings } from '../../world/WorldSettings';

/** Which fish bite depends on the water: the farm pond, the far inland lakes, or the open sea. */
export type FishingWater = 'pond' | 'lake' | 'sea';

export interface FishDef {
  id: string;
  waters: FishingWater[];
  /** Spawn weight by the hour and rain (0 = never there now). */
  weight: (hour: number, rain: number) => number;
  /** 0..1: pulls harder and reels in slower. */
  difficulty: number;
  /** Body length (m). */
  size: number;
  color: number;
  /** Swims in a school (small fish) instead of alone. */
  school?: boolean;
  /** Keeps near the bed. */
  bottom?: boolean;
  /** How far it notices the bait (m). */
  sight: number;
  /** Cruising speed (m/s). */
  speed: number;
}

export const FISH: FishDef[] = [
  // Farm pond
  { id: 'fish_carp', waters: ['pond'], weight: () => 50, difficulty: 0.15, size: 0.5, color: 0x9a8440, bottom: true, sight: 3.2, speed: 0.55 },
  { id: 'fish_perch', waters: ['pond', 'lake'], weight: (h) => (h > 6 && h < 19 ? 32 : 6), difficulty: 0.3, size: 0.24, color: 0x7d9a45, school: true, sight: 3.8, speed: 0.9 },
  { id: 'fish_catfish', waters: ['pond'], weight: (h) => (h > 18 || h < 6 ? 30 : 4), difficulty: 0.6, size: 0.75, color: 0x3f3a33, bottom: true, sight: 2.6, speed: 0.45 },
  { id: 'fish_golden', waters: ['pond'], weight: (_h, rain) => 2 + rain * 8, difficulty: 0.85, size: 0.32, color: 0xffb21f, sight: 2.4, speed: 0.8 },
  // Far lakes
  { id: 'fish_trout', waters: ['lake'], weight: () => 40, difficulty: 0.3, size: 0.45, color: 0x8b9aa3, sight: 3.6, speed: 0.85 },
  { id: 'fish_pike', waters: ['lake'], weight: (h) => ((h > 5 && h < 9) || (h > 17 && h < 21) ? 30 : 10), difficulty: 0.6, size: 0.85, color: 0x5d7140, sight: 4.4, speed: 0.7 },
  { id: 'fish_sturgeon', waters: ['lake'], weight: (_h, rain) => 3 + rain * 6, difficulty: 0.9, size: 1.1, color: 0x56606a, bottom: true, sight: 2.6, speed: 0.4 },
  // Open sea
  { id: 'fish_mackerel', waters: ['sea'], weight: () => 45, difficulty: 0.25, size: 0.32, color: 0x3c7393, school: true, sight: 4.2, speed: 1.1 },
  { id: 'fish_seabass', waters: ['sea'], weight: () => 25, difficulty: 0.5, size: 0.55, color: 0x93a3ad, sight: 3.6, speed: 0.75 },
  { id: 'fish_tuna', waters: ['sea'], weight: (_h, rain) => 5 + rain * 3, difficulty: 0.85, size: 1.05, color: 0x2b4170, sight: 4.8, speed: 1.0 },
  { id: 'fish_moonfish', waters: ['sea'], weight: (h) => (h > 21 || h < 4 ? 3 : 0), difficulty: 0.95, size: 0.6, color: 0xdde8f4, sight: 3.0, speed: 0.6 },
];

/** Water depth and level at a point (level - ground; <= 0 is dry land). */
export type WaterSampler = (x: number, z: number) => { level: number; ground: number };

export type FishMood = 'swim' | 'flee' | 'curious' | 'nibble' | 'hooked';

interface School {
  def: FishDef;
  target: THREE.Vector3;
  home: THREE.Vector3;
  retarget: number;
}

export interface FishAgent {
  def: FishDef;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Facing (unit), turned smoothly towards the velocity. */
  dir: THREE.Vector3;
  home: THREE.Vector3;
  target: THREE.Vector3;
  retarget: number;
  school: School | null;
  /** Place in the school (offset from its target). */
  slot: THREE.Vector3;
  mood: FishMood;
  timer: number;
  /** No interest in the bait until this runs out. */
  cooldown: number;
  /** While curious: how long it puts up with a bait that races away. */
  patience: number;
  scale: number;
  wag: number;
  /** Fades in after spawning, out on clear. */
  alpha: number;
}

/** What the fish see of the bait. */
export interface BaitInfo {
  pos: THREE.Vector3;
  /** In the water and fishable (not in flight, nothing on it yet). */
  active: boolean;
  /** Horizontal speed (m/s): a slow bait tempts, a racing one scares. */
  speed: number;
}

export interface FishTickResult {
  /** 0..1: a fish is tasting the bait (the bobber twitches). */
  nibble: number;
  /** A fish took the bait this frame. */
  bit: FishAgent | null;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _fwd = new THREE.Vector3(0, 0, 1);
const _color = new THREE.Color();

const MAX_PER_KIND = 24;
/** Scales every kind's eyesight for the bait. */
const SIGHT_SCALE = 1.35;

/**
 * The fish of a fishing trip: a few schools of small fish and some bigger loners, spawned around
 * the cast only while the rod is out (none of this runs or draws otherwise). Each one swims in its
 * patch of water, notices a bait that is still or creeping nearby, comes to taste it and finally
 * bites. One instanced mesh per kind, the tail wag is done in the vertex shader.
 */
export class FishingFish {
  public readonly fish: FishAgent[] = [];
  private readonly schools: School[] = [];
  private readonly meshes = new Map<string, THREE.InstancedMesh>();
  private time = { value: 0 };
  /** The one fish that is after the bait (only one at a time). */
  private engaged: FishAgent | null = null;
  private readonly mobile = isMobileDevice();
  private nibbleTick = 0;

  constructor(private readonly scene: THREE.Scene, private readonly sample: WaterSampler) {}

  public get active(): boolean {
    return this.fish.length > 0;
  }

  /** Fills the water around `center` (the cast) and between it and the angler with fish. */
  public spawn(center: THREE.Vector3, angler: THREE.Vector3, water: FishingWater, rain: number): void {
    this.clear(true);
    const hour = worldSettings.timeOfDay;
    const pool = FISH.filter((f) => f.waters.includes(water));
    const loners = pool.filter((f) => !f.school);
    const schools = pool.filter((f) => f.school);
    const lonerCount = (water === 'sea' ? 5 : 4) + (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < lonerCount; i++) {
      const def = this.roll(loners, hour, rain);
      if (!def) break;
      // The first one is close to the cast, so there is always something to try for
      const at = i === 0 ? this.findSpot(center, center, def, 3.5) : this.findSpot(center, angler, def, 9);
      if (at) this.addFish(def, at, null);
    }
    const schoolCount = schools.length ? 1 + (Math.random() < 0.55 ? 1 : 0) : 0;
    for (let i = 0; i < schoolCount; i++) {
      const def = this.roll(schools, hour, rain) ?? schools[0];
      const at = this.findSpot(center, angler, def, 8);
      if (!at) continue;
      const school: School = { def, target: at.clone(), home: at.clone(), retarget: 0 };
      this.schools.push(school);
      const n = this.mobile ? 5 : 7 + Math.floor(Math.random() * 4);
      for (let k = 0; k < n; k++) {
        const p = at.clone().add(_v.set((Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 1.4));
        if (!this.wetEnough(p.x, p.z, def)) p.copy(at);
        this.addFish(def, p, school);
      }
    }
  }

  /** Removes all fish (hidden at once when `instant`, faded out otherwise). */
  public clear(instant = false): void {
    if (instant) {
      this.fish.length = 0;
      this.schools.length = 0;
      this.engaged = null;
      this.fading = false;
      for (const mesh of this.meshes.values()) {
        mesh.count = 0;
        mesh.visible = false;
      }
      return;
    }
    // Fade: everything swims off and the alpha drops in update()
    for (const f of this.fish) {
      if (f.mood !== 'hooked') f.alpha = Math.min(f.alpha, 0.999);
      f.cooldown = 1e9;
    }
    this.fading = true;
    this.engaged = null;
  }
  private fading = false;

  /** Scares the fish near a splash. */
  public scare(at: THREE.Vector3, radius: number): void {
    for (const f of this.fish) {
      if (f.mood === 'hooked') continue;
      const d = Math.hypot(f.pos.x - at.x, f.pos.z - at.z);
      if (d > radius) continue;
      f.mood = 'flee';
      f.timer = 0.9 + Math.random() * 0.8;
      _v.set(f.pos.x - at.x, 0, f.pos.z - at.z);
      if (_v.lengthSq() < 1e-4) _v.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      f.vel.copy(_v.normalize().multiplyScalar(f.def.speed * 3));
      if (f === this.engaged) this.engaged = null;
      f.cooldown = Math.max(f.cooldown, 2.5);
    }
  }

  /** Lets the hooked fish go back to swimming (the line came in empty or was cancelled). */
  public release(f: FishAgent): void {
    f.mood = 'flee';
    f.timer = 1.5;
    f.cooldown = 1e9;
    if (this.engaged === f) this.engaged = null;
  }

  /** Takes a fish out of the water for good (it went into the backpack). */
  public remove(f: FishAgent): void {
    const i = this.fish.indexOf(f);
    if (i >= 0) this.fish.splice(i, 1);
    if (this.engaged === f) this.engaged = null;
    if (!this.fish.length) this.draw(0);
  }

  /** Puts a hooked / landed fish at `pos`, its head along `dir`, thrashing by `thrash` (0..1). */
  public holdAt(f: FishAgent, pos: THREE.Vector3, dir: THREE.Vector3, thrash: number): void {
    f.pos.copy(pos);
    f.dir.copy(dir).normalize();
    f.wag += thrash * 0.25;
    f.vel.set(0, 0, 0);
  }

  public update(dt: number, bait: BaitInfo): FishTickResult {
    const res: FishTickResult = { nibble: 0, bit: null };
    if (!this.fish.length) return res;
    this.time.value += dt;

    for (const s of this.schools) {
      s.retarget -= dt;
      const dx = s.target.x - this.schoolCentre(s, _w).x;
      const dz = s.target.z - _w.z;
      if (s.retarget <= 0 || dx * dx + dz * dz < 0.5) {
        s.retarget = 3 + Math.random() * 4;
        this.pickTarget(s.home, s.def, 3.5, s.target);
      }
    }

    // Someone new may notice the bait
    if (bait.active && !this.engaged && !this.fading) {
      for (const f of this.fish) {
        if (f.mood !== 'swim' || f.cooldown > 0) continue;
        const d = f.pos.distanceTo(bait.pos);
        const sight = f.def.sight * SIGHT_SCALE;
        if (d > sight) continue;
        // A still bait is noticed slowly, a creeping one quickly, a racing one not at all
        const lure = bait.speed < 0.05 ? 0.35 : bait.speed < 1.3 ? 0.9 : 0;
        if (Math.random() < lure * dt * (1.3 - d / sight)) {
          f.mood = 'curious';
          f.patience = 1.2;
          this.engaged = f;
          break;
        }
      }
    }

    for (let i = this.fish.length - 1; i >= 0; i--) {
      const f = this.fish[i];
      f.cooldown -= dt;
      if (this.fading && f.mood !== 'hooked') {
        f.alpha -= dt * 1.5;
        if (f.alpha <= 0) {
          this.fish.splice(i, 1);
          continue;
        }
      } else if (f.alpha < 1) f.alpha = Math.min(1, f.alpha + dt * 1.2);

      if (f.mood === 'hooked') continue; // the fishing system moves it
      if (f.mood === 'curious' || f.mood === 'nibble') {
        if (!bait.active || f !== this.engaged) {
          this.loseInterest(f, 3);
        } else if (f.mood === 'curious') {
          if (bait.speed > 1.4) f.patience -= dt;
          if (f.patience <= 0) this.loseInterest(f, 5);
          else {
            // Swim up to just in front of the bait
            _v.copy(f.pos).sub(bait.pos);
            const d = _v.length();
            const reach = 0.12 + f.def.size * 0.45;
            if (d < reach) {
              f.mood = 'nibble';
              f.timer = 0.9 + Math.random() * 1.8 + f.def.difficulty;
            } else {
              _w.copy(bait.pos).addScaledVector(_v.divideScalar(d || 1), reach * 0.9);
              this.steer(f, _w, f.def.speed * (d > 1.5 ? 1.1 : 0.55), dt, 2.5);
            }
          }
        } else {
          // Nibbling: nose at the bait, little tugs; a bait yanked away ends it
          if (bait.speed > 0.7) {
            if (Math.random() < 0.4) this.loseInterest(f, 4);
            else f.mood = 'curious';
          } else {
            f.timer -= dt;
            _v.copy(f.pos).sub(bait.pos);
            const d = _v.length() || 1;
            _w.copy(bait.pos).addScaledVector(_v.divideScalar(d), 0.1 + f.def.size * 0.45);
            this.steer(f, _w, 0.6, dt, 6);
            f.dir.lerp(_v.copy(bait.pos).sub(f.pos).normalize(), Math.min(1, dt * 6)).normalize();
            this.nibbleTick += dt;
            res.nibble = Math.max(res.nibble, 0.5 + 0.5 * Math.sin(this.nibbleTick * 11) * Math.sin(this.nibbleTick * 3.3));
            if (f.timer <= 0) {
              f.mood = 'hooked';
              res.bit = f;
            }
          }
        }
      } else if (f.mood === 'flee') {
        f.timer -= dt;
        f.vel.multiplyScalar(Math.exp(-dt * 1.2));
        this.move(f, dt);
        if (f.timer <= 0) f.mood = 'swim';
      } else {
        // Swim: loners wander their patch, school fish keep their place in the school
        if (f.school) {
          _w.copy(f.school.target).add(f.slot);
          this.steer(f, _w, f.def.speed, dt, 1.6);
        } else {
          f.retarget -= dt;
          if (f.retarget <= 0 || f.pos.distanceToSquared(f.target) < 0.3) {
            f.retarget = 3 + Math.random() * 5;
            this.pickTarget(f.home, f.def, 3.5, f.target);
          }
          this.steer(f, f.target, f.def.speed * (0.6 + 0.4 * Math.sin(this.time.value * 0.7 + f.wag)), dt, 1.2);
        }
      }
    }
    if (this.fading && this.fish.length === 0) this.fading = false;
    this.draw(dt);
    return res;
  }

  public dispose(): void {
    this.clear(true);
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.meshes.clear();
  }

  // ------------------------------------------------------------------ internals

  private loseInterest(f: FishAgent, cooldown: number): void {
    f.mood = 'swim';
    f.cooldown = cooldown + Math.random() * 2;
    if (this.engaged === f) this.engaged = null;
  }

  private roll(defs: FishDef[], hour: number, rain: number): FishDef | null {
    const w = defs.map((d) => Math.max(0, d.weight(hour, rain)));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    if (!(r > 0)) return null;
    for (let i = 0; i < defs.length; i++) {
      r -= w[i];
      if (r <= 0) return defs[i];
    }
    return defs[defs.length - 1];
  }

  private minDepth(def: FishDef): number {
    return 0.3 + def.size * 0.35;
  }

  private wetEnough(x: number, z: number, def: FishDef): boolean {
    const s = this.sample(x, z);
    return s.level - s.ground > this.minDepth(def);
  }

  /** A swimming depth for the fish at (x, z). */
  private depthAt(x: number, z: number, def: FishDef, out: THREE.Vector3): void {
    const s = this.sample(x, z);
    const lo = s.ground + 0.1 + def.size * 0.2;
    const hi = Math.max(lo, s.level - 0.18 - def.size * 0.15);
    const t = def.bottom ? Math.random() * 0.3 : 0.2 + Math.random() * 0.7;
    out.y = THREE.MathUtils.lerp(lo, hi, t);
  }

  /** Somewhere wet near the cast, often between it and the angler (so reeling in passes fish). */
  private findSpot(center: THREE.Vector3, angler: THREE.Vector3, def: FishDef, radius: number): THREE.Vector3 | null {
    const out = new THREE.Vector3();
    for (let a = 0; a < 40; a++) {
      const t = Math.random() * 0.75;
      const ang = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius * (a < 20 ? 1 : 0.5);
      out.set(
        THREE.MathUtils.lerp(center.x, angler.x, t) + Math.cos(ang) * r,
        0,
        THREE.MathUtils.lerp(center.z, angler.z, t) + Math.sin(ang) * r
      );
      if (Math.hypot(out.x - angler.x, out.z - angler.z) < 2.5) continue;
      if (!this.wetEnough(out.x, out.z, def)) continue;
      this.depthAt(out.x, out.z, def, out);
      return out;
    }
    return null;
  }

  private pickTarget(home: THREE.Vector3, def: FishDef, radius: number, out: THREE.Vector3): void {
    for (let a = 0; a < 8; a++) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const x = home.x + Math.cos(ang) * r;
      const z = home.z + Math.sin(ang) * r;
      if (!this.wetEnough(x, z, def)) continue;
      out.set(x, 0, z);
      this.depthAt(x, z, def, out);
      return;
    }
    out.copy(home);
  }

  private schoolCentre(s: School, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    let n = 0;
    for (const f of this.fish) {
      if (f.school !== s || f.mood !== 'swim') continue;
      out.add(f.pos);
      n++;
    }
    return n ? out.divideScalar(n) : out.copy(s.target);
  }

  private addFish(def: FishDef, at: THREE.Vector3, school: School | null): void {
    const yaw = Math.random() * Math.PI * 2;
    const f: FishAgent = {
      def,
      pos: at.clone(),
      vel: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(def.speed * 0.5),
      dir: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)),
      home: at.clone(),
      target: at.clone(),
      retarget: Math.random() * 2,
      school,
      slot: school ? new THREE.Vector3((Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 0.35, (Math.random() - 0.5) * 1.6) : new THREE.Vector3(),
      mood: 'swim',
      timer: 0,
      cooldown: 1.5 + Math.random() * 2.5,
      patience: 1,
      scale: def.size * (0.85 + Math.random() * 0.3),
      wag: Math.random() * 10,
      alpha: 0,
    };
    this.fish.push(f);
  }

  /** Accelerates towards `target` at up to `speed`. */
  private steer(f: FishAgent, target: THREE.Vector3, speed: number, dt: number, agility: number): void {
    _v.copy(target).sub(f.pos);
    const d = _v.length();
    if (d > 1e-4) _v.multiplyScalar(Math.min(speed, d * 2) / d);
    else _v.set(0, 0, 0);
    f.vel.lerp(_v, Math.min(1, dt * agility));
    this.move(f, dt);
  }

  /** Moves by the velocity without leaving the water (it turns back at the shore and bed). */
  private move(f: FishAgent, dt: number): void {
    const nx = f.pos.x + f.vel.x * dt;
    const nz = f.pos.z + f.vel.z * dt;
    const s = this.sample(nx, nz);
    if (s.level - s.ground < this.minDepth(f.def) * 0.7) {
      // Shore ahead: turn back home
      f.vel.x = (f.home.x - f.pos.x) * 0.5;
      f.vel.z = (f.home.z - f.pos.z) * 0.5;
      f.retarget = 0;
    } else {
      f.pos.x = nx;
      f.pos.z = nz;
    }
    f.pos.y += f.vel.y * dt;
    const here = this.sample(f.pos.x, f.pos.z);
    const lo = here.ground + 0.08 + f.def.size * 0.15;
    const hi = here.level - 0.12 - f.def.size * 0.1;
    f.pos.y = THREE.MathUtils.clamp(f.pos.y, lo, Math.max(lo, hi));
    const sp = f.vel.length();
    if (sp > 0.03) {
      _w.copy(f.vel).divideScalar(sp);
      _w.y *= 0.5;
      f.dir.lerp(_w, Math.min(1, dt * 4)).normalize();
    }
    f.wag += dt * (2 + sp * 9 / Math.max(0.3, f.def.size));
  }

  private mesh(def: FishDef): THREE.InstancedMesh {
    let mesh = this.meshes.get(def.id);
    if (mesh) return mesh;
    const geo = new THREE.BoxGeometry(0.2, 0.4, 1.0, 1, 2, 6);
    shapeFishGeometry(geo, 1.0);
    if (def.id === 'fish_catfish' || def.id === 'fish_sturgeon' || def.id === 'fish_pike') geo.scale(1, 0.75, 1);
    if (def.id === 'fish_moonfish') geo.scale(0.8, 1.6, 0.8);
    const wag = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_KIND), 1);
    wag.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aWag', wag);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aWag;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
  // Tail wag: the back half swings, more towards the tip
  float tailK = clamp(-position.z - 0.05, 0.0, 1.0);
  transformed.x += sin(aWag + position.z * 4.0) * tailK * tailK * 0.55 + sin(aWag) * 0.03;`
        );
    };
    mesh = new THREE.InstancedMesh(geo, mat, MAX_PER_KIND);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 1;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_KIND * 3), 3);
    this.scene.add(mesh);
    this.meshes.set(def.id, mesh);
    return mesh;
  }

  private draw(_dt: number): void {
    for (const mesh of this.meshes.values()) mesh.count = 0;
    for (const f of this.fish) {
      const mesh = this.mesh(f.def);
      if (mesh.count >= MAX_PER_KIND) continue;
      const i = mesh.count++;
      _q.setFromUnitVectors(_fwd, f.dir);
      const sc = f.scale * Math.max(0.001, f.alpha);
      _s.set(sc, sc, sc);
      _m.compose(f.pos, _q, _s);
      mesh.setMatrixAt(i, _m);
      (mesh.geometry.getAttribute('aWag') as THREE.InstancedBufferAttribute).setX(i, f.wag);
      const shade = 0.85 + ((i * 37) % 10) * 0.03;
      _color.setHex(f.def.color).multiplyScalar(shade);
      mesh.setColorAt(i, _color);
    }
    for (const mesh of this.meshes.values()) {
      mesh.visible = mesh.count > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.geometry.getAttribute('aWag').needsUpdate = true;
    }
  }
}
