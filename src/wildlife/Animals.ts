import * as THREE from 'three';
import { Agent, Species, SpeciesTuning, WildContext, angleTo, turnToward } from './Species';
import { createAnimalMaterial } from './AnimalMaterial';
import { butterflyGeometry, fishGeometry, gullGeometry, hareGeometry, sparrowGeometry, turtleGeometry } from './AnimalGeometry';

const TAU = Math.PI * 2;
const dist2 = (ax: number, az: number, bx: number, bz: number) => (ax - bx) ** 2 + (az - bz) ** 2;

/** Dry, walkable ground at (x, z)? */
function dryGround(ctx: WildContext, x: number, z: number, margin = 0.3): number | null {
  const y = ctx.terrain.getHeight(x, z);
  if (y < ctx.water(x, z) + margin) return null;
  const t = ctx.terrain;
  const slope = Math.abs(t.getHeight(x + 1, z) - y) + Math.abs(t.getHeight(x, z + 1) - y);
  return slope > 0.9 ? null : y;
}

/** Near the island's sea coast: open sea 25 m further out from the centre (not a pond or lake). */
function nearOpenSea(ctx: WildContext, x: number, z: number): boolean {
  const r = Math.hypot(x, z);
  if (r < 90 || !Number.isNaN(ctx.river(x, z))) return false;
  const k = (r + 25) / r;
  return ctx.terrain.getHeight(x * k, z * k) < ctx.sea - 1;
}

// ======================================================================== seagulls

/**
 * Seagulls along the sea coast: soar in wide circles over the shoreline, alternating a few wing
 * beats with long glides, wander along the coast, and now and then land on the beach (wings folded)
 * until the player comes close.
 */
export class Gulls extends Species {
  constructor(parent: THREE.Object3D, tune: SpeciesTuning) {
    super('gulls', tune, gullGeometry(), createAnimalMaterial('flap', 0.45, { doubleSide: true }), parent);
  }

  private coast(ctx: WildContext, x: number, z: number): boolean {
    const y = ctx.terrain.getHeight(x, z);
    return y > ctx.sea - 5 && y < ctx.sea + 1.8 && nearOpenSea(ctx, x, z);
  }

  protected target(ctx: WildContext): number {
    return Math.round(this.tune.capacity * (1 - ctx.night * 0.8) * (1 - ctx.rain * 0.6));
  }

  protected spawn(a: Agent, x: number, z: number, ctx: WildContext): boolean {
    if (!this.coast(ctx, x, z)) return false;
    a.hx = x;
    a.hz = z;
    a.hy = ctx.sea + 7 + this.rnd() * 10;
    a.a0 = this.rnd() * TAU; // angle on the circle
    a.a1 = (6 + this.rnd() * 12) * (this.rnd() < 0.5 ? -1 : 1); // signed circle radius
    a.x = x + Math.cos(a.a0) * Math.abs(a.a1);
    a.z = z + Math.sin(a.a0) * Math.abs(a.a1);
    a.y = a.hy;
    a.scale = 0.9 + this.rnd() * 0.3;
    a.rate = 9 + this.rnd() * 2;
    a.timer = this.rnd() * 3;
    a.state = 0;
    a.speed = 6.5 + this.rnd() * 2;
    this.setColor(a, 0xffffff, 0.04);
    return true;
  }

  protected think(a: Agent, dt: number, ctx: WildContext, near: boolean): void {
    a.timer -= dt;
    if (a.state === 2) {
      // Perched on the beach: hop off when the player comes near or after a while
      a.amp = 0;
      a.gait = 1;
      a.pitch = 0;
      a.roll = 0;
      if (a.timer <= 0 || a.dist2 < 7 * 7) {
        a.state = 0;
        a.timer = 1.5;
        a.gait = 0;
      }
      return;
    }
    if (a.state === 1) {
      // Gliding down to a landing spot
      const dx = a.tx - a.x, dz = a.tz - a.z;
      const d = Math.hypot(dx, dz);
      a.yaw = turnToward(a.yaw, Math.atan2(dx, dz), 2, dt);
      const step = Math.min(d, a.speed * 0.7 * dt);
      a.x += Math.sin(a.yaw) * step;
      a.z += Math.cos(a.yaw) * step;
      a.y += (a.ty - a.y) * Math.min(1, dt * (d < 6 ? 3 : 0.8));
      a.amp = d < 3 ? 0.9 : 0.08;
      a.rate = d < 3 ? 14 : 9;
      a.roll = 0;
      a.pitch = d < 3 ? 0.3 : -0.1;
      if (d < 0.3 && Math.abs(a.y - a.ty) < 0.15) {
        a.state = 2;
        a.y = a.ty;
        a.timer = 8 + this.rnd() * 14;
      }
      return;
    }
    // Circling: angular speed from the linear speed and radius
    const R = Math.abs(a.a1);
    const dir = Math.sign(a.a1);
    a.a0 += (a.speed / R) * dt * dir;
    const cx = a.hx + Math.cos(a.a0) * R;
    const cz = a.hz + Math.sin(a.a0) * R;
    const cy = a.hy + Math.sin(ctx.time * 0.3 + a.phase) * 1.5;
    // Ease onto the circle (smooth after taking off or re-homing)
    const k = Math.min(1, dt * 1.5);
    const nx = a.x + (cx - a.x) * k;
    const nz = a.z + (cz - a.z) * k;
    if (nx !== a.x || nz !== a.z) a.yaw = Math.atan2(nx - a.x, nz - a.z);
    a.x = nx;
    a.z = nz;
    a.y += (cy - a.y) * k;
    a.roll = -0.35 * dir;
    a.pitch = 0;
    // A few beats, then a long glide
    if (a.timer <= 0) {
      a.state = 0;
      a.timer = 2 + this.rnd() * 4;
      a.gait = a.gait > 0 ? 0 : 0; // wings out while flying
      a.amp = a.amp > 0.3 ? 0.07 : 0.65;
      // Sometimes drift along the coast, or come down on the beach
      if (near && this.rnd() < 0.08) {
        for (let t = 0; t < 4; t++) {
          const ang = this.rnd() * TAU;
          const lx = a.x + Math.cos(ang) * (6 + this.rnd() * 14);
          const lz = a.z + Math.sin(ang) * (6 + this.rnd() * 14);
          const gy = ctx.terrain.getHeight(lx, lz);
          if (gy > ctx.sea + 0.1 && gy < ctx.sea + 2.5 && dist2(lx, lz, ctx.player.x, ctx.player.z) > 100) {
            a.state = 1;
            a.tx = lx;
            a.tz = lz;
            a.ty = gy + 0.08;
            return;
          }
        }
      } else if (this.rnd() < 0.3) {
        const ang = this.rnd() * TAU;
        const nhx = a.hx + Math.cos(ang) * 20, nhz = a.hz + Math.sin(ang) * 20;
        if (this.coast(ctx, nhx, nhz)) {
          a.hx = nhx;
          a.hz = nhz;
        }
      }
    }
  }
}

// ======================================================================== butterflies

const BUTTERFLY_COLORS = [0xffb347, 0xfff27a, 0x9ad0ff, 0xffffff, 0xff8fc0, 0xc8a2ff, 0xff6a3d];

/**
 * Butterflies over meadows and flower patches in daylight: flutter between random points around
 * their flower, rest with slowly opening wings, scatter when the player walks through.
 */
export class Butterflies extends Species {
  constructor(parent: THREE.Object3D, tune: SpeciesTuning) {
    super('butterflies', tune, butterflyGeometry(), createAnimalMaterial('flap', 0.06, { doubleSide: true, flat: false }), parent);
  }

  protected target(ctx: WildContext): number {
    const weather = Math.max(ctx.rain, ctx.snow);
    return Math.round(this.tune.capacity * Math.max(0, 1 - ctx.night * 2.2) * (1 - weather));
  }

  protected spawn(a: Agent, x: number, z: number, ctx: WildContext): boolean {
    const y = dryGround(ctx, x, z, 0.6);
    if (y === null || ctx.isSnow(x, z) || ctx.trees(x, z) > 8) return false;
    // Strongly prefer flowers; open meadows take some too
    if (ctx.flowers(x, z) === 0 && this.rnd() < 0.7) return false;
    a.hx = a.x = x;
    a.hz = a.z = z;
    a.hy = y;
    a.y = y + 0.5 + this.rnd();
    a.scale = 0.9 + this.rnd() * 0.5;
    a.rate = 20 + this.rnd() * 8;
    a.amp = 1.15;
    a.speed = 1 + this.rnd() * 0.6;
    a.timer = 0;
    this.setColor(a, BUTTERFLY_COLORS[(this.rnd() * BUTTERFLY_COLORS.length) | 0], 0.08);
    return true;
  }

  protected think(a: Agent, dt: number, ctx: WildContext, near: boolean): void {
    a.timer -= dt;
    const scared = a.dist2 < 2.5 * 2.5;
    if (a.state === 1) {
      // Resting on a flower, wings opening and closing slowly
      a.amp = 0.55;
      a.rate = 2.5;
      a.pitch = 0;
      if (a.timer <= 0 || scared) {
        a.state = 0;
        a.timer = 0;
        a.rate = 20 + this.rnd() * 8;
      }
      return;
    }
    if (a.timer <= 0) {
      // New waypoint around home (further and higher when spooked)
      const r = scared ? 4 : 2.5;
      a.tx = a.hx + (this.rnd() - 0.5) * 2 * r;
      a.tz = a.hz + (this.rnd() - 0.5) * 2 * r;
      const g = near ? ctx.terrain.getHeight(a.tx, a.tz) : a.hy;
      a.ty = g + (scared ? 2 + this.rnd() * 1.5 : 0.35 + this.rnd() * 1.3);
      a.timer = 1.2 + this.rnd() * 2.2;
      if (!scared && near && this.rnd() < 0.18) {
        a.ty = g + 0.25;
        a.a0 = 1; // land on arrival
      } else {
        a.a0 = 0;
      }
    }
    const dx = a.tx - a.x, dy = a.ty - a.y, dz = a.tz - a.z;
    const d = Math.hypot(dx, dz);
    a.yaw = turnToward(a.yaw, Math.atan2(dx, dz), 5, dt);
    const sp = a.speed * (scared ? 2.2 : 1);
    a.x += Math.sin(a.yaw) * Math.min(d, sp * dt);
    a.z += Math.cos(a.yaw) * Math.min(d, sp * dt);
    // Erratic bobbing on top of the climb toward the waypoint
    a.y += dy * Math.min(1, dt * 2) + Math.sin(ctx.time * 9 + a.phase) * 0.5 * dt;
    a.pitch = 0.25 + Math.sin(ctx.time * 6 + a.phase) * 0.15;
    a.amp = 1.15;
    if (a.a0 > 0 && d < 0.1 && Math.abs(dy) < 0.08) {
      a.state = 1;
      a.timer = 2 + this.rnd() * 4;
      a.a0 = 0;
    }
  }
}

// ======================================================================== hares

/**
 * Hares in and around forests: graze, sit up, hop a few metres with a bounding gait, and bolt away
 * in long zig-zag bounds when the player gets close.
 */
export class Hares extends Species {
  constructor(parent: THREE.Object3D, tune: SpeciesTuning) {
    super('hares', tune, hareGeometry(), createAnimalMaterial('walk', 0.5), parent);
  }

  protected spawn(a: Agent, x: number, z: number, ctx: WildContext): boolean {
    if (ctx.trees(x, z) < 4) return false;
    const y = dryGround(ctx, x, z, 0.4);
    if (y === null) return false;
    a.x = a.hx = x;
    a.z = a.hz = z;
    a.y = y;
    a.yaw = this.rnd() * TAU;
    a.scale = 0.9 + this.rnd() * 0.25;
    a.gait = 1;
    a.rate = 13;
    a.timer = this.rnd() * 3;
    this.setColor(a, ctx.snow > 0.5 || ctx.isSnow(x, z) ? 0xf2f0ea : 0xffffff, 0.08);
    return true;
  }

  protected think(a: Agent, dt: number, ctx: WildContext, near: boolean): void {
    a.timer -= dt;
    const p = ctx.player;
    const scared = a.dist2 < 7 * 7;
    if (scared && a.state !== 2) {
      a.state = 2;
      a.timer = 2.5 + this.rnd();
      a.yaw = Math.atan2(a.x - p.x, a.z - p.z) + (this.rnd() - 0.5) * 0.8;
    }
    if (a.state === 0) {
      // Idle: graze (head down) or sit up and look around
      a.amp = 0;
      a.pitch = Math.sin(ctx.time * 0.7 + a.phase) > 0.2 ? -0.12 : 0.08;
      if (a.timer <= 0) {
        // Pick a dry spot a few metres away, preferring to stay near home
        const ang = this.rnd() * TAU;
        const r = 2 + this.rnd() * 5;
        let tx = a.x + Math.cos(ang) * r, tz = a.z + Math.sin(ang) * r;
        if (dist2(tx, tz, a.hx, a.hz) > 15 * 15) {
          tx = a.hx + (tx - a.x) * 0.3;
          tz = a.hz + (tz - a.z) * 0.3;
        }
        if (dryGround(ctx, tx, tz, 0.4) !== null) {
          a.tx = tx;
          a.tz = tz;
          a.state = 1;
        } else {
          a.timer = 1;
        }
      }
    } else {
      const fleeing = a.state === 2;
      let heading = a.yaw;
      if (!fleeing) {
        heading = Math.atan2(a.tx - a.x, a.tz - a.z);
      } else if (this.rnd() < dt * 1.5) {
        a.yaw += (this.rnd() - 0.5) * 1.2; // zig-zag
      }
      a.yaw = turnToward(a.yaw, heading, 6, dt);
      a.speed = fleeing ? 7 : 2.4;
      const nx = a.x + Math.sin(a.yaw) * a.speed * dt;
      const nz = a.z + Math.cos(a.yaw) * a.speed * dt;
      const gy = dryGround(ctx, nx, nz, 0.3);
      if (gy === null) {
        // Water or a cliff ahead: turn around
        a.yaw += Math.PI * (0.6 + this.rnd() * 0.4);
        if (!fleeing) a.state = 0;
      } else {
        a.x = nx;
        a.z = nz;
        a.y = gy;
      }
      a.amp = fleeing ? 1.1 : 0.8;
      a.rate = fleeing ? 17 : 12;
      a.pitch = 0;
      const arrived = !fleeing && dist2(a.x, a.z, a.tx, a.tz) < 0.09;
      if (arrived || (fleeing && a.timer <= 0)) {
        a.state = 0;
        a.timer = 2 + this.rnd() * 5;
        if (fleeing) {
          a.hx = a.x;
          a.hz = a.z;
        }
      }
    }
    if (near && a.state === 0) a.y = ctx.terrain.getHeight(a.x, a.z);
  }

  protected draw(a: Agent): void {
    // Bounding: the body rises over each stride (the legs do the rest in the shader)
    const hop = a.amp > 0 ? Math.abs(Math.sin((this.clock * a.rate + a.phase) * 0.5)) * 0.12 * a.amp : 0;
    this.emit(a.x, a.y + hop, a.z, a.yaw, a.pitch, a.roll, a.scale, a.phase, a.rate, a.amp, a.gait, a.r, a.g, a.b);
  }

  public clock = 0;
}

// ======================================================================== fish schools

const FISH_PER_SCHOOL = 9;

/**
 * Fish schools in deep enough water (the sea, lakes, big rivers): each agent is a school whose
 * centre wanders between deep points (facing upstream in rivers); its fish orbit the centre on
 * fixed Lissajous offsets, so there is no per-fish steering at all. The whole school darts away
 * from the player. Sea schools are silver-blue or orange, fresh-water ones olive.
 */
export class FishSchools extends Species {
  public clock = 0;

  constructor(parent: THREE.Object3D, tune: SpeciesTuning) {
    super('fish', { ...tune, perAgent: FISH_PER_SCHOOL }, fishGeometry(), createAnimalMaterial('swim', 0.35, { flat: false }), parent);
  }

  private deep(ctx: WildContext, x: number, z: number, min = 1.3): { surface: number; bed: number } | null {
    const surface = ctx.water(x, z);
    const bed = ctx.terrain.getHeight(x, z);
    return surface - bed >= min ? { surface, bed } : null;
  }

  protected spawn(a: Agent, x: number, z: number, ctx: WildContext): boolean {
    const w = this.deep(ctx, x, z, 1.6);
    if (!w) return false;
    // Big water only: a few metres around must be water too (skips puddles and narrow creeks)
    for (const [ox, oz] of [[4, 0], [-4, 0], [0, 4], [0, -4]]) if (!this.deep(ctx, x + ox, z + oz, 0.9)) return false;
    a.x = a.tx = x;
    a.z = a.tz = z;
    a.y = a.ty = THREE.MathUtils.lerp(w.bed + 0.5, w.surface - 0.6, 0.3 + this.rnd() * 0.5);
    a.yaw = this.rnd() * TAU;
    a.speed = 1.2;
    a.scale = 0.7 + this.rnd() * 0.6;
    a.rate = 9;
    a.amp = 0.12;
    const fresh = !Number.isNaN(ctx.river(x, z));
    this.setColor(a, fresh ? 0x9aa86a : this.rnd() < 0.3 ? 0xff9a3c : 0xa9c4dc, 0.05);
    return true;
  }

  protected think(a: Agent, dt: number, ctx: WildContext): void {
    a.timer -= dt;
    const p = ctx.player;
    const scared = a.dist2 < 5 * 5 && Math.abs(p.y - a.y) < 4;
    if (scared) {
      a.yaw = turnToward(a.yaw, Math.atan2(a.x - p.x, a.z - p.z), 6, dt);
      a.speed = 4.5;
      a.timer = Math.min(a.timer, 0.5);
    } else {
      if (a.timer <= 0 || dist2(a.x, a.z, a.tx, a.tz) < 1) {
        a.timer = 4 + this.rnd() * 6;
        for (let t = 0; t < 3; t++) {
          const ang = a.yaw + (this.rnd() - 0.5) * 2.4;
          const r = 6 + this.rnd() * 10;
          const tx = a.x + Math.sin(ang) * r, tz = a.z + Math.cos(ang) * r;
          const w = this.deep(ctx, tx, tz, 1.4);
          if (w) {
            a.tx = tx;
            a.tz = tz;
            a.ty = THREE.MathUtils.lerp(w.bed + 0.5, w.surface - 0.6, 0.25 + this.rnd() * 0.6);
            break;
          }
        }
      }
      a.yaw = turnToward(a.yaw, Math.atan2(a.tx - a.x, a.tz - a.z), 1.2, dt);
      a.speed += (1.1 - a.speed) * Math.min(1, dt);
    }
    const nx = a.x + Math.sin(a.yaw) * a.speed * dt;
    const nz = a.z + Math.cos(a.yaw) * a.speed * dt;
    const w = this.deep(ctx, nx, nz, 1.0);
    if (w) {
      a.x = nx;
      a.z = nz;
      a.y += (THREE.MathUtils.clamp(a.ty, w.bed + 0.4, w.surface - 0.45) - a.y) * Math.min(1, dt * 0.8);
    } else {
      a.yaw += Math.PI * 0.75;
      a.timer = 0;
    }
    a.rate = scared ? 16 : 9;
    a.amp = scared ? 0.2 : 0.12;
  }

  protected draw(a: Agent): void {
    const t = this.clock;
    const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
    for (let i = 0; i < FISH_PER_SCHOOL; i++) {
      // School-local offset: a tight cloud that slowly churns
      const ph = a.phase + i * 2.39;
      const lx = Math.sin(t * 0.6 + ph) * 0.9 * a.scale;
      const lz = Math.cos(t * 0.45 + ph * 1.7) * 1.3 * a.scale;
      const ly = Math.sin(t * 0.8 + ph * 0.6) * 0.35;
      const wob = Math.sin(t * 1.3 + ph) * 0.25;
      this.emit(a.x + lx * c + lz * s, a.y + ly, a.z - lx * s + lz * c, a.yaw + wob, 0, 0, 0.8 + (i % 3) * 0.12, ph, a.rate, a.amp, 0, a.r, a.g, a.b);
    }
  }
}

// ======================================================================== turtles

/**
 * Sea turtles: some cruise slowly through the shallow sea paddling with their flippers, some
 * plod along the beach and pull in (stop) when the player gets close.
 */
export class Turtles extends Species {
  constructor(parent: THREE.Object3D, tune: SpeciesTuning) {
    super('turtles', tune, turtleGeometry(), createAnimalMaterial('walk', 0.8), parent);
  }

  protected spawn(a: Agent, x: number, z: number, ctx: WildContext): boolean {
    if (!nearOpenSea(ctx, x, z)) return false;
    const bed = ctx.terrain.getHeight(x, z);
    const beach = bed > ctx.sea + 0.05 && bed < ctx.sea + 0.75 && ctx.trees(x, z) === 0;
    const sea = ctx.sea - bed > 1.6 && ctx.sea - bed < 9;
    if (!beach && !sea) return false;
    a.state = beach ? 0 : 1; // 0 land, 1 swimming
    a.x = a.tx = x;
    a.z = a.tz = z;
    a.y = beach ? bed : THREE.MathUtils.lerp(bed + 0.4, ctx.sea - 0.7, this.rnd());
    a.ty = a.y;
    a.yaw = this.rnd() * TAU;
    a.scale = beach ? 0.7 + this.rnd() * 0.3 : 0.9 + this.rnd() * 0.5;
    this.setColor(a, 0xffffff, 0.1);
    return true;
  }

  protected think(a: Agent, dt: number, ctx: WildContext, near: boolean): void {
    a.timer -= dt;
    const swim = a.state === 1;
    const shy = !swim && a.dist2 < 3.5 * 3.5;
    if (a.timer <= 0) {
      a.timer = swim ? 6 + this.rnd() * 8 : 3 + this.rnd() * 5;
      a.a0 = !swim && this.rnd() < 0.4 ? 1 : 0; // land turtles rest a lot
      a.yaw += (this.rnd() - 0.5) * 1.6;
      if (swim) a.ty = THREE.MathUtils.lerp(ctx.terrain.getHeight(a.x, a.z) + 0.4, ctx.sea - 0.7, this.rnd());
    }
    const moving = !shy && a.a0 === 0;
    a.speed = moving ? (swim ? 0.9 : 0.22) : 0;
    const nx = a.x + Math.sin(a.yaw) * a.speed * dt;
    const nz = a.z + Math.cos(a.yaw) * a.speed * dt;
    const bed = ctx.terrain.getHeight(nx, nz);
    const ok = swim ? ctx.sea - bed > 1.2 && Number.isNaN(ctx.river(nx, nz)) : bed > ctx.sea + 0.02 && bed < ctx.sea + 0.9;
    if (ok) {
      a.x = nx;
      a.z = nz;
      if (swim) a.y += (THREE.MathUtils.clamp(a.ty, bed + 0.3, ctx.sea - 0.5) - a.y) * Math.min(1, dt * 0.5);
      else a.y = bed;
    } else {
      a.yaw += Math.PI * (0.5 + this.rnd() * 0.5) * Math.min(1, dt * 4);
    }
    a.amp = swim ? 1.6 : moving ? 0.9 : 0;
    a.rate = swim ? 2.2 : 3.5;
    a.gait = swim ? 1 : 0; // paddle both fronts together underwater
    a.pitch = swim ? Math.sin(ctx.time * 0.4 + a.phase) * 0.08 : 0;
    void near;
  }
}

// ======================================================================== sparrows

const SPARROWS_PER_FLOCK = 7;

/**
 * Sparrow flocks in forests: the flock pecks about on the ground (each bird hopping on its own
 * rhythm, wings folded), then the whole flock takes off together and flits to another spot among
 * the trees; walking close scatters it. One agent per flock, birds placed on fixed offsets.
 */
export class Sparrows extends Species {
  public clock = 0;

  constructor(parent: THREE.Object3D, tune: SpeciesTuning) {
    super('sparrows', { ...tune, perAgent: SPARROWS_PER_FLOCK }, sparrowGeometry(), createAnimalMaterial('flap', 0.15, { doubleSide: true }), parent);
  }

  protected target(ctx: WildContext): number {
    return Math.round(this.tune.capacity * Math.max(0, 1 - ctx.night * 1.6) * (1 - ctx.rain * 0.7));
  }

  private landing(ctx: WildContext, x: number, z: number): number | null {
    if (ctx.trees(x, z) < 3) return null;
    return dryGround(ctx, x, z, 0.4);
  }

  protected spawn(a: Agent, x: number, z: number, ctx: WildContext): boolean {
    const y = this.landing(ctx, x, z);
    if (y === null) return false;
    a.x = a.tx = x;
    a.z = a.tz = z;
    a.y = a.ty = a.hy = y;
    a.state = 0; // 0 feeding, 1 flying
    a.timer = 4 + this.rnd() * 8;
    a.yaw = this.rnd() * TAU;
    this.setColor(a, 0xffffff, 0.05);
    return true;
  }

  protected think(a: Agent, dt: number, ctx: WildContext, near: boolean): void {
    a.timer -= dt;
    const p = ctx.player;
    const startled = a.state === 0 && a.dist2 < 6 * 6;
    if (a.state === 0 && (a.timer <= 0 || startled)) {
      // Take off toward a new spot among the trees (away from the player when startled)
      for (let t = 0; t < 5; t++) {
        const ang = startled ? Math.atan2(a.x - p.x, a.z - p.z) + (this.rnd() - 0.5) * 1.4 : this.rnd() * TAU;
        const r = 10 + this.rnd() * 16;
        const tx = a.x + Math.sin(ang) * r, tz = a.z + Math.cos(ang) * r;
        const gy = near ? this.landing(ctx, tx, tz) : ctx.terrain.getHeight(tx, tz);
        if (gy === null) continue;
        a.state = 1;
        a.hx = a.x;
        a.hz = a.z;
        a.hy = a.y;
        a.tx = tx;
        a.tz = tz;
        a.ty = gy;
        a.a0 = 0; // flight progress 0..1
        a.a1 = r;
        a.yaw = Math.atan2(tx - a.x, tz - a.z);
        return;
      }
      a.timer = 3;
      return;
    }
    if (a.state === 1) {
      // Arc over the ground: progress along the chord, a bump of height in the middle
      a.a0 = Math.min(1, a.a0 + (dt * 7) / a.a1);
      const f = a.a0;
      a.x = a.hx + (a.tx - a.hx) * f;
      a.z = a.hz + (a.tz - a.hz) * f;
      a.y = a.hy + (a.ty - a.hy) * f + Math.sin(f * Math.PI) * (2.5 + a.a1 * 0.12);
      if (f >= 1) {
        a.state = 0;
        a.timer = 5 + this.rnd() * 10;
        a.y = a.ty;
      }
    }
  }

  protected draw(a: Agent): void {
    const t = this.clock;
    const flying = a.state === 1;
    const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
    for (let i = 0; i < SPARROWS_PER_FLOCK; i++) {
      const ph = a.phase + i * 1.93;
      // Spread a bit wider on the ground, bunch up in the air
      const spread = flying ? 0.9 : 1.4;
      const lx = Math.sin(ph * 3.1) * spread;
      const lz = Math.cos(ph * 2.3) * spread + (flying ? Math.sin(t * 2 + ph) * 0.3 : 0);
      let y = a.y;
      let yaw = a.yaw;
      if (flying) {
        y += Math.sin(t * 3 + ph) * 0.25 + (i % 3) * 0.2;
      } else {
        // Hop in short bursts, turning to peck around
        const burst = Math.sin(t * 0.9 + ph) > 0.3 ? 1 : 0;
        y += Math.abs(Math.sin(t * 11 + ph)) * 0.05 * burst + 0.04;
        yaw = a.yaw + Math.sin(t * 0.5 + ph * 4) * 2.5;
      }
      this.emit(a.x + lx * c + lz * s, y, a.z - lx * s + lz * c, yaw, flying ? 0.1 : 0, 0, 1, ph, flying ? 32 : 0, flying ? 1.0 : 0, flying ? 0 : 1, a.r, a.g, a.b);
    }
  }
}
