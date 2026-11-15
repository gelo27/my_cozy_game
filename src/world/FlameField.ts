import * as THREE from 'three';
import { isMobileDevice } from './WorldSettings';
import { FlameSparks } from './FlameSparks';

const MOBILE = isMobileDevice();
/** Flames drawn at once (each is two instances: the outer tongue and a hotter inner core). */
const MAX_FLAMES = MOBILE ? 24 : 64;
/** Beyond this the flames fade out and are not drawn (the halo and the coals still read). */
const FAR = MOBILE ? 55 : 90;
const FADE_START = FAR * 0.7;
/** Spark pool per flame (only the share set by the `sparks` setting flies at once). */
const SPARKS_PER_FLAME = MOBILE ? 12 : 28;

/** Look of every flame, tuned live in the editor (saved in this browser). */
export interface FlameSettings {
  speed: number;
  displacement: number;
  frequency: number;
  stretch: number;
  turbulence: number;
  brightness: number;
  fresnel: number;
  /** Share of the spark pool that flies (0 = no sparks). */
  sparks: number;
  /** How high the sparks rise, relative to the flame. */
  sparkHeight: number;
  /** How hard a passing player blows the flames (0 = off). */
  playerWind: number;
  /** Metres around the player that feel the draught. */
  playerWindRadius: number;
  /** How much the weather's wind leans the flames (0 = off). */
  weatherWind: number;
  colorCore: string;
  colorMid: string;
  colorOuter: string;
}

export const FLAME_DEFAULTS: Readonly<FlameSettings> = {
  speed: 1.05,
  displacement: 0.2,
  frequency: 1.0,
  stretch: 1.5,
  turbulence: 0.35,
  brightness: 1.0,
  fresnel: 4.0,
  sparks: 0.6,
  sparkHeight: 1.0,
  playerWind: 1.0,
  playerWindRadius: 2.5,
  weatherWind: 1.0,
  colorCore: '#feea67',
  colorMid: '#ff5100',
  colorOuter: '#a80000',
};

const STORAGE_KEY = 'farm.flame1';

function load(): FlameSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) return { ...FLAME_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Private mode / bad JSON: defaults
  }
  return { ...FLAME_DEFAULTS };
}

export const flameSettings: FlameSettings = load();

/**
 * Uniforms every flame shares (the inner core derives its own from these in the shader, with the
 * same ratios as the reference except a calmer, coarser noise: displacement x0.6, frequency x0.85, stretch x0.7, brightness x1.1,
 * Fresnel x0.8, time x1.15).
 */
const flameUniforms = {
  uDisp: { value: 0 },
  uFreq: { value: 0 },
  uStretch: { value: 0 },
  uTurb: { value: 0 },
  uBright: { value: 0 },
  uFresnel: { value: 0 },
  uColorCore: { value: new THREE.Color() },
  uColorMid: { value: new THREE.Color() },
  uColorOuter: { value: new THREE.Color() },
};

function applyFlameSettings(): void {
  const f = flameSettings, u = flameUniforms;
  u.uDisp.value = f.displacement;
  u.uFreq.value = f.frequency;
  u.uStretch.value = f.stretch;
  u.uTurb.value = f.turbulence;
  u.uBright.value = f.brightness;
  u.uFresnel.value = f.fresnel;
  u.uColorCore.value.set(f.colorCore);
  u.uColorMid.value.set(f.colorMid);
  u.uColorOuter.value.set(f.colorOuter);
}
applyFlameSettings();

/**
 * Wind on flames and sparks. The flames' instance matrices only scale and move (no rotation), so
 * a world XZ offset is also a local one. `uWindPlayer`: player position + reach; `uWindPush`: the
 * smoothed draught of the player's movement (world XZ, already scaled); `uWind`: weather wind
 * direction XZ and strength.
 */
export const flameWindUniforms = {
  uWindPlayer: { value: new THREE.Vector4(0, -1e4, 0, 2.5) },
  uWindPush: { value: new THREE.Vector2() },
  uWind: { value: new THREE.Vector3(0.94, 0.35, 0) },
  /** Real seconds (the flame clock runs at the tuned speed; gusts should not). */
  uWindTime: { value: 0 },
};

/** GLSL shared by flames and sparks: the XZ bend at a flame base (world units per unit height). */
export const FLAME_WIND_GLSL = /* glsl */ `
  uniform vec4 uWindPlayer;
  uniform vec2 uWindPush;
  uniform vec3 uWind;
  uniform float uWindTime;
  // Weather: a steady lean that breathes in gusts, plus a nervous flutter in storms
  vec2 flameWeatherBend(float seed) {
    float time = uWindTime;
    float gust = 0.75 + 0.25 * sin(time * 1.3 + seed) + 0.15 * sin(time * 3.7 + seed * 2.0);
    return uWind.xy * uWind.z * gust
      + vec2(sin(time * 11.0 + seed * 5.0), cos(time * 9.0 + seed * 3.0)) * uWind.z * 0.08;
  }
  // Same base XZ -> same gusts, so a flame and its sparks sway together
  vec2 flameWindBend(vec3 base) {
    float seed = base.x * 1.7 + base.z;
    // Player: strongest right next to the fire, gone at the reach; only at about the same height
    vec2 toFlame = base.xz - uWindPlayer.xz;
    float d = length(toFlame);
    float nearP = (1.0 - smoothstep(0.3, uWindPlayer.w, d)) * (1.0 - smoothstep(1.5, 3.0, abs(base.y - uWindPlayer.y)));
    float pushLen = length(uWindPush);
    // Mostly along the movement, a little straight away from the player
    vec2 away = d > 0.01 ? toFlame / d : vec2(0.0);
    vec2 bend = (uWindPush + away * pushLen * 0.4) * nearP;
    bend += flameWeatherBend(seed);
    float len = length(bend);
    return len > 1.4 ? bend * (1.4 / len) : bend;
  }
  // A flame carried by the moving player trails behind the movement instead
  vec2 flameCarriedBend(vec3 base) {
    vec2 bend = -uWindPush * 1.6 + flameWeatherBend(base.x * 1.7 + base.z);
    float len = length(bend);
    return len > 1.4 ? bend * (1.4 / len) : bend;
  }
`;

/** Pushes the settings to the shader and stores them. */
export function saveFlameSettings(): void {
  applyFlameSettings();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(flameSettings));
  } catch {
    // Storage blocked: the change still applies for this session
  }
}

export function resetFlameSettings(): void {
  Object.assign(flameSettings, FLAME_DEFAULTS);
  saveFlameSettings();
}

/** A visible flame: base position (where it sits on the logs / in the torch cup) and height. */
export interface FlameSpot {
  x: number;
  y: number;
  z: number;
  /** Flame height in metres. */
  size: number;
}

/**
 * A short-lived or moving flame (a fireball, a fire left where it hit). Its owner may move `pos`
 * and `dir` every frame; it fades in, burns `burn` seconds, then dies out over `fadeOut`.
 */
export interface DynamicFlame {
  /** Base of the flame (bottom of the tongue), world. */
  pos: THREE.Vector3;
  /** Which way the tongue points (unit); up for a fire on the ground, backwards for a fireball. */
  dir: THREE.Vector3;
  size: number;
  /** Seconds at full strength (Infinity until the owner calls `extinguish` or sets `dead`). */
  burn: number;
  fadeOut: number;
  /** Sparks rise from it (not for a fireball: they would be left hanging behind it). */
  sparks: boolean;
  /** Wind bends it (a fireball's tongue is aimed by `dir` instead). */
  wind: boolean;
  /** Walking into it sets the player on fire. */
  ignites: boolean;
  age: number;
  /** Per-flame noise offset, so two fires never flicker alike. */
  seed: number;
  /** Set to remove it at once. */
  dead: boolean;
}

/** Fire effects other systems trigger (dragon fireballs) without holding the FlameField. */
const dynamicFlames: DynamicFlame[] = [];
const MAX_DYNAMIC = MOBILE ? 10 : 24;
/** Seconds the player keeps burning after a hit (then the flames die out over PLAYER_FADE). */
const PLAYER_BURN = 2.5;
const PLAYER_FADE = 1.5;
let playerBurn = 0;
/** Seconds since the player caught fire (fade-in; not restarted while already burning). */
let playerBurnAge = 0;
/** Dragon fire keeps hurting while it burns on the player: half a heart every DRAGON_BURN_TICK s. */
const DRAGON_BURN_TICK = 1.2;
/** A campfire is milder: half a heart on stepping in, then again every CAMPFIRE_TICK s inside it. */
const CAMPFIRE_TICK = 2.0;
/** This burn was lit (or later relit) by dragon fire. */
let dragonBurn = false;
let burnTick = 0;
/** Until the next campfire contact hurts again. */
let campfireTick = 0;

export type BurnSource = 'dragon' | 'campfire';

export const fireFx = {
  /** Starts a flame (see DynamicFlame); the returned object can be moved and extinguished. */
  spawn(opts: Partial<DynamicFlame> & { pos: THREE.Vector3; size: number }): DynamicFlame {
    const f: DynamicFlame = {
      dir: new THREE.Vector3(0, 1, 0),
      burn: 2,
      fadeOut: 1.5,
      sparks: true,
      wind: true,
      ignites: false,
      age: 0,
      seed: Math.random() * 100,
      dead: false,
      ...opts,
      pos: opts.pos.clone(),
    };
    // Over the cap the oldest flame that burns out by itself gives way
    if (dynamicFlames.length >= MAX_DYNAMIC) {
      const old = dynamicFlames.findIndex((d) => Number.isFinite(d.burn));
      dynamicFlames.splice(old >= 0 ? old : 0, 1);
    }
    dynamicFlames.push(f);
    return f;
  },
  /** Starts the fade-out now. */
  extinguish(f: DynamicFlame): void {
    f.burn = Math.min(f.burn, f.age);
  },
  /** Sets the player on fire for a few seconds (refreshed by every new hit). */
  ignitePlayer(source: BurnSource = 'dragon'): void {
    if (playerBurn <= 0) {
      playerBurnAge = 0;
      dragonBurn = false;
    }
    // The fireball's own hit already took its heart: the burn starts biting a tick later
    if (source === 'dragon' && !dragonBurn) {
      dragonBurn = true;
      burnTick = DRAGON_BURN_TICK;
    }
    playerBurn = PLAYER_BURN + PLAYER_FADE;
  },
  /** Puts the player out quickly (stepping into water); the burn stops hurting at once. */
  douse(): void {
    if (playerBurn <= 0) return;
    playerBurn = Math.min(playerBurn, 0.3);
    dragonBurn = false;
  },
  /** The player is on fire right now. */
  get playerBurning(): boolean {
    return playerBurn > 0;
  },
  /** Burning hurts: called with half-hearts of damage (the gameplay applies it). */
  onBurnDamage: null as ((halves: number) => void) | null,
  /** A dark burn mark on the ground at (x, z), radius r (wired to the lightning's scorch marks). */
  onScorch: null as ((x: number, z: number, r: number) => void) | null,
};

/** The flame on a burning player: one tongue wrapping the torso, from the waist to above the head. */
const PLAYER_FLAMES = [
  // y from the capsule centre (0.75 m above the feet): base just below the waist (~0.43 m up), ~1.35 m tall
  { side: 0, back: 0, y: -0.32, size: 1.35 },
];

const UP = new THREE.Vector3(0, 1, 0);
/** aFlame.y = core flag + wind mode: 0 world wind, 2 burning player (trails behind), 4 no wind. */
const MODE_PLAYER = 2;
const MODE_STILL = 4;

/**
 * Animated flames for campfires and torches, plus short-lived ones (fireballs, fires where they hit,
 * a burning player): one instanced, smooth sphere per flame, pushed into rising tongues by simplex
 * FBM in the vertex shader and coloured by "heat" with soft Fresnel edges in the fragment shader.
 * All flames are one draw call; the static ones near the camera are re-picked a few times per
 * second, and instances are rewritten only then or while a short-lived flame exists.
 */
export class FlameField {
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly seedAttr: THREE.InstancedBufferAttribute;
  private spots: (FlameSpot & { seed: number })[] = [];
  private selectTimer = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly camPos = new THREE.Vector3();
  private readonly camRight = new THREE.Vector3();
  private readonly camBack = new THREE.Vector3();
  private readonly mat = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly scl = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly near: { s: FlameSpot & { seed: number }; d: number }[] = [];
  /** Static flames picked at the last selection. */
  private readonly picked: (FlameSpot & { seed: number })[] = [];
  /** Flames that get sparks (static and short-lived), pooled. */
  private readonly sparkList: FlameSpot[] = [];
  private readonly sparkPool: FlameSpot[] = [];
  private dirty = false;
  /** Instances held short-lived flames last frame (rewrite once more after they are gone). */
  private hadDynamic = false;
  /** Flame clock: advances at the tuned speed, so moving the slider does not jump the phase. */
  private flameTime = 0;
  private sparkTime = 0;
  private readonly sparks: FlameSparks;
  private readonly lastPlayer = new THREE.Vector3();
  private hasLastPlayer = false;
  /** Player velocity, eased so the flames lean with a lag and settle back. */
  private readonly playerVel = new THREE.Vector2();
  private windAngle = 0;

  constructor(scene: THREE.Scene) {
    // Smooth, modest sphere: the vertex shader does the shaping, the Fresnel hides the facets
    const geo = MOBILE ? new THREE.SphereGeometry(1, 14, 10) : new THREE.SphereGeometry(1, 20, 14);
    const cap = (MAX_FLAMES + MAX_DYNAMIC + PLAYER_FLAMES.length) * 2;
    this.seedAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.seedAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aFlame', this.seedAttr);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          { uTime: { value: 0 }, uNight: { value: 0 }, uFade: { value: new THREE.Vector2(FADE_START, FAR) } },
        ]),
        // Shared by reference so the editor sliders reach the material without a rebuild
        ...flameUniforms,
        ...flameWindUniforms,
      },
      defines: { OCTAVES: MOBILE ? 2 : 3 },
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      // Premultiplied: rgb adds light, alpha decides how much of the background it covers (a little
      // by day so the fire reads against bright grass, almost nothing at night so it glows)
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.name = 'Flames';
    scene.add(this.mesh);
    this.sparks = new FlameSparks(
      scene,
      SPARKS_PER_FLAME,
      MAX_FLAMES + MAX_DYNAMIC,
      new THREE.Vector2(FADE_START, FAR),
      flameWindUniforms,
      FLAME_WIND_GLSL
    );
  }

  public setViewportHeight(px: number): void {
    this.sparks.setViewportHeight(px);
  }

  /** Replaces the flame list (call when campfires / torches change). */
  public setSpots(spots: FlameSpot[]): void {
    this.spots = spots.map((s) => ({ ...s, seed: seedOf(s.x, s.z) }));
    this.selectTimer = 0;
  }

  /**
   * `player`: the player's position (null when there is none); `weatherWind`: 0..1 wind of the
   * weather (0 underground).
   */
  public update(dt: number, night: number, camera: THREE.Camera, player: THREE.Vector3 | null, weatherWind: number): void {
    this.updateWind(dt, player, weatherWind);
    this.flameTime = (this.flameTime + dt * flameSettings.speed) % 10000;
    this.material.uniforms.uTime.value = this.flameTime;
    this.material.uniforms.uNight.value = night;
    this.sparkTime = (this.sparkTime + dt) % 10000;
    this.sparks.update(this.sparkTime, night, flameSettings.sparks, flameSettings.sparkHeight);

    camera.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);

    this.selectTimer -= dt;
    if (this.selectTimer <= 0) {
      this.selectTimer = 0.25;
      this.pickStatic(camera);
      this.dirty = true;
    }

    // Short-lived flames age every frame
    for (let k = dynamicFlames.length - 1; k >= 0; k--) {
      const f = dynamicFlames[k];
      f.age += dt;
      if (f.dead || f.age > f.burn + f.fadeOut) dynamicFlames.splice(k, 1);
    }
    if (playerBurn > 0) {
      playerBurn = Math.max(0, playerBurn - dt);
      playerBurnAge += dt;
      // Dragon fire bites until the flames are mostly out
      if (player && dragonBurn && playerBurn > PLAYER_FADE * 0.5) {
        burnTick -= dt;
        if (burnTick <= 0) {
          burnTick += DRAGON_BURN_TICK;
          fireFx.onBurnDamage?.(1);
        }
      }
    } else dragonBurn = false;
    campfireTick -= dt;
    if (player) this.catchFire(player);
    const burning = playerBurn > 0 && player !== null;
    const dynamic = dynamicFlames.length > 0 || burning;
    if (dynamic || this.hadDynamic) this.dirty = true;
    this.hadDynamic = dynamic;
    if (!this.dirty) return;
    this.dirty = false;
    this.writeInstances(burning ? player : null, camera);
  }

  /**
   * The player stepping into a fire catches fire too: a campfire (or a torch, if they ever stand in
   * one) or a fire a fireball left.
   */
  private catchFire(player: THREE.Vector3): void {
    for (const s of this.spots) {
      if (!inFlame(player, s.x, s.y, s.z, s.size)) continue;
      fireFx.ignitePlayer('campfire');
      if (campfireTick <= 0) {
        campfireTick = CAMPFIRE_TICK;
        fireFx.onBurnDamage?.(1);
      }
      return;
    }
    for (const f of dynamicFlames) {
      if (!f.ignites || f.age > f.burn + f.fadeOut * 0.5) continue;
      if (inFlame(player, f.pos.x, f.pos.y, f.pos.z, f.size)) return fireFx.ignitePlayer('dragon');
    }
  }

  /** Static flames near the camera and in view, nearest first when there are too many. */
  private pickStatic(camera: THREE.Camera): void {
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const near = this.near;
    near.length = 0;
    const far2 = FAR * FAR;
    for (const s of this.spots) {
      const dx = s.x - this.camPos.x, dy = s.y - this.camPos.y, dz = s.z - this.camPos.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > far2) continue;
      this.sphere.center.set(s.x, s.y + s.size * 0.5, s.z);
      this.sphere.radius = s.size;
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      near.push({ s, d });
    }
    if (near.length > MAX_FLAMES) near.sort((a, b) => a.d - b.d);
    this.picked.length = 0;
    for (let k = 0; k < near.length && k < MAX_FLAMES; k++) this.picked.push(near[k].s);
  }

  private writeInstances(player: THREE.Vector3 | null, camera: THREE.Camera): void {
    let i = 0;
    let nSparks = 0;
    const addSparks = (x: number, y: number, z: number, size: number) => {
      const s = this.sparkPool[nSparks] ?? (this.sparkPool[nSparks] = { x: 0, y: 0, z: 0, size: 0 });
      s.x = x;
      s.y = y;
      s.z = z;
      s.size = size;
      this.sparkList[nSparks++] = s;
    };
    for (const s of this.picked) {
      i = this.writeFlame(i, s.x, s.y, s.z, UP, s.size, s.seed, 1, 0);
      addSparks(s.x, s.y, s.z, s.size);
    }

    const far2 = FAR * FAR;
    for (const f of dynamicFlames) {
      if (f.pos.distanceToSquared(this.camPos) > far2) continue;
      const fade = Math.min(1, f.age / 0.15) * (f.age > f.burn ? Math.max(0, 1 - (f.age - f.burn) / f.fadeOut) : 1);
      if (fade <= 0.001) continue;
      // A dying flame also shrinks back down
      const size = f.size * (0.35 + 0.65 * fade);
      i = this.writeFlame(i, f.pos.x, f.pos.y, f.pos.z, f.dir, size, f.seed, fade, f.wind ? 0 : MODE_STILL);
      if (f.sparks) addSparks(f.pos.x, f.pos.y, f.pos.z, size * fade);
    }

    if (player) {
      // Sides as seen from the camera, so the fire hugs the flanks the player looks at
      this.camRight.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
      this.camBack.setFromMatrixColumn(camera.matrixWorld, 2).setY(0).normalize();
      const fade = Math.min(1, playerBurn / PLAYER_FADE) * Math.min(1, playerBurnAge / 0.15);
      for (let k = 0; k < PLAYER_FLAMES.length; k++) {
        const p = PLAYER_FLAMES[k];
        const x = player.x + this.camRight.x * p.side + this.camBack.x * p.back;
        const z = player.z + this.camRight.z * p.side + this.camBack.z * p.back;
        const size = p.size * (0.4 + 0.6 * fade);
        i = this.writeFlame(i, x, player.y + p.y, z, UP, size, 31.7 * (k + 1), fade, MODE_PLAYER);
      }
    }

    this.mesh.count = i;
    this.sparks.setFlames(this.sparkList, nSparks);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.seedAttr.needsUpdate = true;
  }

  /** Writes the outer tongue and the inner core of one flame; returns the next instance index. */
  private writeFlame(i: number, x: number, y: number, z: number, dir: THREE.Vector3, size: number, seed: number, fade: number, mode: number): number {
    const seeds = this.seedAttr.array as Float32Array;
    this.quat.setFromUnitVectors(UP, dir);
    // The unit sphere grows to ~3 tall once shaped: scale it to the wanted height, bottom on the base
    const r = size / 3.0;
    for (let core = 0; core < 2; core++) {
      const rr = core ? r * 0.65 : r;
      const lift = core ? rr * 0.92 : rr;
      this.tmp.set(x + dir.x * lift, y + dir.y * lift, z + dir.z * lift);
      this.scl.set(rr, rr, rr);
      this.mat.compose(this.tmp, this.quat, this.scl);
      this.mesh.setMatrixAt(i, this.mat);
      seeds[i * 3] = seed + core * 17.3;
      seeds[i * 3 + 1] = core + mode;
      seeds[i * 3 + 2] = fade;
      i++;
    }
    return i;
  }

  private updateWind(dt: number, player: THREE.Vector3 | null, weatherWind: number): void {
    const u = flameWindUniforms;
    const f = flameSettings;
    const vel = this.playerVel;
    if (player && dt > 0) {
      let vx = 0, vz = 0;
      if (this.hasLastPlayer) {
        vx = (player.x - this.lastPlayer.x) / dt;
        vz = (player.z - this.lastPlayer.z) / dt;
        // A teleport / respawn is not a gust
        if (vx * vx + vz * vz > 400) vx = vz = 0;
      }
      this.lastPlayer.copy(player);
      this.hasLastPlayer = true;
      // Quick to catch up, so the fire answers right away; the lag reads as air settling
      const k = 1 - Math.exp(-dt * 5);
      vel.x += (vx - vel.x) * k;
      vel.y += (vz - vel.y) * k;
      u.uWindPlayer.value.set(player.x, player.y, player.z, f.playerWindRadius);
    } else {
      this.hasLastPlayer = false;
      vel.multiplyScalar(Math.exp(-dt * 5));
      u.uWindPlayer.value.y = -1e4;
    }
    // ~5 m/s running past bends the top by about its own width
    u.uWindPush.value.copy(vel).multiplyScalar(0.17 * f.playerWind);
    // Weather wind: the rain's direction, wandering slowly; the breeze of calm weather barely shows
    this.windAngle += dt * 0.05;
    u.uWindTime.value = (u.uWindTime.value + dt) % 10000;
    const a = 0.36 + Math.sin(this.windAngle) * 0.35;
    u.uWind.value.set(Math.cos(a), Math.sin(a), (0.12 + weatherWind * 0.9) * f.weatherWind);
  }
}

/** The player (capsule centre, feet 0.75 m below) stands in a flame based at (x, y, z). */
function inFlame(player: THREE.Vector3, x: number, y: number, z: number, size: number): boolean {
  const dx = player.x - x, dz = player.z - z;
  // Within the flame's footprint (plus the capsule radius), feet between its base and top
  const reach = size * 0.35 + 0.3;
  if (dx * dx + dz * dz > reach * reach) return false;
  const feet = player.y - 0.75;
  return feet >= y - 0.6 && feet <= y + size * 0.8;
}

function seedOf(x: number, z: number): number {
  return (Math.abs(Math.sin(x * 12.99 + z * 78.23) * 43758.5) % 1) * 100;
}

const FLAME_VERT = /* glsl */ `
  attribute vec3 aFlame; // seed, isCore + 2 x wind mode, fade (0..1)
  uniform float uTime;
  uniform vec2 uFade;
  uniform float uDisp, uFreq, uStretch, uTurb;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying float vNoise;
  varying float vHeight;
  varying float vCore;
  varying float vDistFade;
  varying float vFadeI;
  #include <fog_pars_vertex>
  ${FLAME_WIND_GLSL}

  // 3D simplex noise (Ashima Arts)
  vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + 2.0 * C.xxx;
    vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
    i = mod(i, 289.0);
    vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    vec3 ns = (1.0 / 7.0) * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }

  float fbm(vec3 p, float t) {
    float v = 0.0, a = 0.5, f = 1.0;
    for (int i = 0; i < OCTAVES; i++) {
      v += a * snoise(p * f);
      p.y -= t * 0.4;
      f *= 2.1;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    float core = mod(aFlame.y, 2.0);
    float mode = floor(aFlame.y * 0.5 + 0.01);
    vFadeI = aFlame.z;
    // Core: faster, finer, calmer tongues
    float t = uTime * mix(1.0, 1.15, core) + aFlame.x;
    float freq = uFreq * mix(1.0, 0.85, core);
    float disp = uDisp * mix(1.0, 0.6, core);
    float stretch = uStretch * mix(1.0, 0.7, core);
    float turb = uTurb;

    float heightNorm = clamp((position.y + 1.0) * 0.5, 0.0, 1.0);
    vHeight = heightNorm;
    vCore = core;

    vec3 nc = position * freq;
    nc.y -= t * 1.5;
    nc.x += aFlame.x;
    float ang = heightNorm * turb * sin(t * 0.8 + position.y * 2.0);
    float s = sin(ang), c = cos(ang);
    nc.xz = mat2(c, -s, s, c) * nc.xz;
    float n = fbm(nc, t);
    vNoise = n;

    vec3 p = position;
    p.xz *= mix(1.05, 0.35, pow(heightNorm, 1.4));        // taper to a tongue
    p.y += pow(heightNorm, 1.5) * stretch * (0.6 + 0.4 * n); // heat pulls the top up
    p += normal * (n * disp * mix(0.2, 1.4, pow(heightNorm, 0.8)));

    // Wind: the top bends the most, the base stays on the logs; a bent flame also crouches
    // World wind / trailing behind the burning player / none (a fireball aims its tongue itself)
    vec2 bend = mode < 0.5 ? flameWindBend(instanceMatrix[3].xyz) : mode < 1.5 ? flameCarriedBend(instanceMatrix[3].xyz) : vec2(0.0);
    float bendK = heightNorm * heightNorm;
    p.xz += bend * bendK * 1.6;
    p.y -= length(bend) * bendK * 0.5;

    vec4 world = instanceMatrix * vec4(p, 1.0);
    vec4 mvPosition = viewMatrix * world;
    vViewPosition = -mvPosition.xyz;
    vNormal = normalize(mat3(viewMatrix) * mat3(instanceMatrix) * normal);
    vDistFade = 1.0 - smoothstep(uFade.x, uFade.y, -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FLAME_FRAG = /* glsl */ `
  uniform float uNight;
  uniform float uBright, uFresnel;
  uniform vec3 uColorCore;
  uniform vec3 uColorMid;
  uniform vec3 uColorOuter;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying float vNoise;
  varying float vHeight;
  varying float vCore;
  varying float vDistFade;
  varying float vFadeI;
  #include <fog_pars_fragment>

  void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewPosition);
    float fresnel = abs(dot(normal, viewDir));
    float edge = pow(fresnel, uFresnel * mix(1.0, 0.8, vCore));

    float heat = (vNoise * 0.5 + 0.5) * 0.65 + (1.0 - vHeight) * 0.45;
    heat *= mix(0.4, 1.2, fresnel);
    heat = clamp(heat + vCore * 0.12, 0.0, 1.0);

    vec3 color = mix(uColorOuter, uColorMid, smoothstep(0.15, 0.55, heat));
    color = mix(color, uColorCore, smoothstep(0.55, 0.9, heat));
    color *= uBright * mix(1.0, 1.1, vCore) * (1.0 + 0.35 * uNight);

    float topFade = 1.0 - smoothstep(0.55, 1.0, vHeight - vNoise * 0.25);
    float alpha = clamp(edge * topFade * 1.4, 0.0, 1.0) * vDistFade * vFadeI;
    // Two shells overlap: keep the core from blowing out the sum
    alpha *= mix(1.0, 0.7, vCore);

    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogF = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      alpha *= 1.0 - fogF;
    #endif

    gl_FragColor = vec4(color * alpha, alpha * mix(0.5, 0.08, uNight));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
