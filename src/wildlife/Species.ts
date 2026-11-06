import * as THREE from 'three';
import type { TerrainSystem } from '../world/TerrainSystem';

/** What every species reads from the world each frame. */
export interface WildContext {
  terrain: TerrainSystem;
  sea: number;
  /** 0 = day, 1 = night. */
  night: number;
  rain: number;
  snow: number;
  /** Player (or the vehicle they ride) position. */
  player: THREE.Vector3;
  time: number;
  /** Trees / flower patches in the 8 m habitat cell around (x, z). */
  trees(x: number, z: number): number;
  flowers(x: number, z: number): number;
  isSnow(x: number, z: number): boolean;
  /** Water surface (sea, lake or river) and river surface (NaN outside rivers). */
  water(x: number, z: number): number;
  river(x: number, z: number): number;
}

/** One animal (or one school, for fish). Plain numbers, pooled: no allocation after start-up. */
export interface Agent {
  active: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  scale: number;
  speed: number;
  state: number;
  timer: number;
  /** Home / target point. */
  hx: number;
  hy: number;
  hz: number;
  tx: number;
  ty: number;
  tz: number;
  phase: number;
  rate: number;
  amp: number;
  gait: number;
  r: number;
  g: number;
  b: number;
  /** Species scratch values. */
  a0: number;
  a1: number;
  /** Seconds of simulation owed to a far, round-robin-updated agent. */
  owed: number;
  dist2: number;
}

export interface SpeciesTuning {
  capacity: number;
  /** Instances drawn per agent (fish schools > 1). */
  perAgent: number;
  spawnMin: number;
  spawnMax: number;
  /** Beyond this (from the player) the agent is released. */
  despawn: number;
  /** Beyond this it is not drawn. */
  viewDist: number;
  /** Within this it updates every frame; beyond, every `farStride` frames with the owed time. */
  nearDist: number;
  /** Bounding sphere radius for frustum culling. */
  radius: number;
  /** Spawn attempts allowed per frame. */
  triesPerFrame: number;
}

const _sphere = new THREE.Sphere();
const _col = new THREE.Color();

/**
 * Base for an instanced animal species: a fixed pool of agents spawned in a ring around the
 * player where the habitat allows, released when far; near agents think every frame, far ones
 * round-robin; only agents inside the view distance and the camera frustum are written to the
 * instance buffers (compacted, so the GPU draws exactly the visible count).
 */
export abstract class Species {
  public readonly mesh: THREE.InstancedMesh;
  public readonly agents: Agent[] = [];
  public activeCount = 0;
  public visibleCount = 0;
  private readonly anim: THREE.InstancedBufferAttribute;
  private readonly animArr: Float32Array;
  private readonly matArr: Float32Array;
  private readonly colArr: Float32Array;
  private cursor = 0;
  protected readonly rnd = Math.random;

  constructor(
    public readonly name: string,
    public readonly tune: SpeciesTuning,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    parent: THREE.Object3D
  ) {
    const max = tune.capacity * tune.perAgent;
    this.mesh = new THREE.InstancedMesh(geometry, material, max);
    this.mesh.name = `Wildlife_${name}`;
    this.mesh.frustumCulled = false; // culled per animal below
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.matArr = this.mesh.instanceMatrix.array as Float32Array;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.colArr = this.mesh.instanceColor.array as Float32Array;
    this.animArr = new Float32Array(max * 4);
    this.anim = new THREE.InstancedBufferAttribute(this.animArr, 4);
    this.anim.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aAnim', this.anim);
    parent.add(this.mesh);
    for (let i = 0; i < tune.capacity; i++) this.agents.push(newAgent());
  }

  /** How many agents the habitat wants right now (time of day, weather). */
  protected target(_ctx: WildContext): number {
    return this.tune.capacity;
  }

  /** Initialise `a` at (x, z) if the habitat fits; false to reject the spot. */
  protected abstract spawn(a: Agent, x: number, z: number, ctx: WildContext): boolean;

  /** Behaviour. `near` = close to the player (full detail). */
  protected abstract think(a: Agent, dt: number, ctx: WildContext, near: boolean): void;

  /** Writes the agent's instance(s) via `emit`. Default: one instance at the agent. */
  protected draw(a: Agent): void {
    this.emit(a.x, a.y, a.z, a.yaw, a.pitch, a.roll, a.scale, a.phase, a.rate, a.amp, a.gait, a.r, a.g, a.b);
  }

  /** Frame update. Returns the spawn attempts used (for the shared budget). */
  private freeAgent(): Agent | undefined {
    for (const a of this.agents) if (!a.active) return a;
    return undefined;
  }

  public update(dt: number, ctx: WildContext, frustum: THREE.Frustum | null, frame: number, stride: number, allowSpawn: boolean): void {
    const T = this.tune;
    const p = ctx.player;
    const want = Math.min(this.target(ctx), T.capacity);
    let active = 0;
    // Release far agents, and surplus ones out of sight (e.g. butterflies at dusk)
    for (const a of this.agents) {
      if (!a.active) continue;
      const dx = a.x - p.x, dz = a.z - p.z;
      a.dist2 = dx * dx + dz * dz;
      if (a.dist2 > T.despawn * T.despawn) {
        a.active = false;
        continue;
      }
      active++;
    }
    if (active > want) {
      for (const a of this.agents) {
        if (active <= want) break;
        if (a.active && (!frustum || !frustum.intersectsSphere(_sphere.set(_v.set(a.x, a.y, a.z), T.radius)) || a.dist2 > T.viewDist * T.viewDist)) {
          a.active = false;
          active--;
        }
      }
    }
    // Spawn a few per frame in a ring around the player
    if (allowSpawn && active < want) {
      for (let t = 0; t < T.triesPerFrame && active < want; t++) {
        const slot = this.freeAgent();
        if (!slot) break;
        const ang = this.rnd() * Math.PI * 2;
        const r = T.spawnMin + Math.sqrt(this.rnd()) * (T.spawnMax - T.spawnMin);
        const x = p.x + Math.cos(ang) * r, z = p.z + Math.sin(ang) * r;
        resetAgent(slot);
        if (this.spawn(slot, x, z, ctx)) {
          slot.active = true;
          slot.dist2 = r * r;
          active++;
        }
      }
    }
    this.activeCount = active;

    // Think: near every frame, far in a round-robin
    const near2 = T.nearDist * T.nearDist;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.active) continue;
      if (a.dist2 < near2) {
        if (a.owed > 0) {
          this.think(a, Math.min(a.owed, 0.5), ctx, true);
          a.owed = 0;
        }
        this.think(a, dt, ctx, true);
      } else {
        a.owed += dt;
        if ((i + frame) % stride === 0) {
          this.think(a, Math.min(a.owed, 0.5), ctx, false);
          a.owed = 0;
        }
      }
    }

    // Draw: view distance + frustum, compacted
    this.cursor = 0;
    const view2 = T.viewDist * T.viewDist;
    for (const a of this.agents) {
      if (!a.active || a.dist2 > view2) continue;
      if (frustum && !frustum.intersectsSphere(_sphere.set(_v.set(a.x, a.y, a.z), T.radius))) continue;
      this.draw(a);
    }
    this.visibleCount = this.cursor;
    this.mesh.count = this.cursor;
    this.mesh.visible = this.cursor > 0;
    if (this.cursor > 0) {
      const n = this.cursor;
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, n * 16);
      im.needsUpdate = true;
      const ic = this.mesh.instanceColor!;
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, n * 3);
      ic.needsUpdate = true;
      this.anim.clearUpdateRanges();
      this.anim.addUpdateRange(0, n * 4);
      this.anim.needsUpdate = true;
    }
  }

  /** Appends one instance: transform (yaw, then pitch nose-up, then roll), animation and colour. */
  protected emit(x: number, y: number, z: number, yaw: number, pitch: number, roll: number, s: number, phase: number, rate: number, amp: number, w: number, r: number, g: number, b: number): void {
    const i = this.cursor++;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cx = Math.cos(-pitch), sx = Math.sin(-pitch);
    const cz = Math.cos(roll), sz = Math.sin(roll);
    const m = this.matArr;
    const o = i * 16;
    // R = Ry * Rx * Rz, column-major, scaled
    m[o] = (cy * cz + sy * sx * sz) * s;
    m[o + 1] = cx * sz * s;
    m[o + 2] = (-sy * cz + cy * sx * sz) * s;
    m[o + 3] = 0;
    m[o + 4] = (-cy * sz + sy * sx * cz) * s;
    m[o + 5] = cx * cz * s;
    m[o + 6] = (sy * sz + cy * sx * cz) * s;
    m[o + 7] = 0;
    m[o + 8] = sy * cx * s;
    m[o + 9] = -sx * s;
    m[o + 10] = cy * cx * s;
    m[o + 11] = 0;
    m[o + 12] = x;
    m[o + 13] = y;
    m[o + 14] = z;
    m[o + 15] = 1;
    const k = i * 4;
    this.animArr[k] = phase;
    this.animArr[k + 1] = rate;
    this.animArr[k + 2] = amp;
    this.animArr[k + 3] = w;
    const c = i * 3;
    this.colArr[c] = r;
    this.colArr[c + 1] = g;
    this.colArr[c + 2] = b;
  }

  protected setColor(a: Agent, hex: number, jitter = 0.06): void {
    _col.setHex(hex);
    const j = 1 + (this.rnd() - 0.5) * 2 * jitter;
    a.r = _col.r * j;
    a.g = _col.g * j;
    a.b = _col.b * j;
  }

  public clear(): void {
    for (const a of this.agents) a.active = false;
    this.mesh.count = 0;
  }
}

const _v = new THREE.Vector3();

function newAgent(): Agent {
  return resetAgent({} as Agent);
}

function resetAgent(a: Agent): Agent {
  a.active = false;
  a.x = a.y = a.z = 0;
  a.yaw = a.pitch = a.roll = 0;
  a.scale = 1;
  a.speed = 0;
  a.state = 0;
  a.timer = 0;
  a.hx = a.hy = a.hz = 0;
  a.tx = a.ty = a.tz = 0;
  a.phase = Math.random() * 100;
  a.rate = 1;
  a.amp = 0;
  a.gait = 0;
  a.r = a.g = a.b = 1;
  a.a0 = a.a1 = 0;
  a.owed = 0;
  a.dist2 = 0;
  return a;
}

/** Shortest signed angle from a to b. */
export function angleTo(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/** Turns `from` toward `to` by at most `rate * dt`. */
export function turnToward(from: number, to: number, rate: number, dt: number): number {
  const d = angleTo(from, to);
  const m = rate * dt;
  return from + (d > m ? m : d < -m ? -m : d);
}
