import * as THREE from 'three';
import { TerrainSystem } from '../world/TerrainSystem';
import { waterLevelAt } from '../world/rivers/RiverWorld';
import { coastRadius } from '../world/IslandGenerator';
import { emitWaterRipple } from '../scene/WaterDetails';
import { waterRippleSim } from '../scene/WaterRippleSim';
import type { ParticleManager } from '../particles/ParticleManager';
import { FishingFish, FishAgent, FishingWater, WaterSampler } from './fishing/FishingFish';
import { FishingLine } from './fishing/FishingLine';
import { CastCircle, MIN_CAST_DEPTH } from './fishing/CastCircle';
import type { AlgaeField } from '../world/AlgaeChains';
import { fishingSounds } from '../audio/FishingSounds';
import { audioEngine } from '../audio/AudioEngine';

export type { FishingWater };

/**
 * aim: the button is held, the circle on the water grows farther with the charge.
 * flight: the bobber flies to a random point inside the circle.
 * wait: it floats; holding the button reels it (and the bait under it) towards the angler.
 * hooked: a fish took the bait; reeling it all the way in lands it.
 * caught: the fish dangles from the rod for a moment.
 */
export type FishingPhase = 'idle' | 'aim' | 'flight' | 'wait' | 'hooked' | 'caught';

export interface FishingState {
  phase: FishingPhase;
  /** Cast charge 0..1 while aiming. */
  power: number;
  /** While aiming: the circle found water. */
  canCast: boolean;
  /** A fish is tasting the bait. */
  nibble: boolean;
  reeling: boolean;
  /** The hook caught on algae; snagProgress 0..1 is how far it has been worked loose. */
  snagged: boolean;
  snagProgress: number;
  /** A hooked fish working itself off the hook: 0 just bitten .. 1 gone. */
  escape: number;
  /** How deep the hook hangs under the float (m), set with the mouse wheel. */
  depth: number;
  water: FishingWater;
  lastFishId: string | null;
}

export interface FishingInput {
  /** The angler's feet. */
  player: THREE.Vector3;
  rodTip: THREE.Vector3;
  /** Where the cast goes (horizontal, unit). */
  aimDir: THREE.Vector3;
  /** The cast / reel button is held. */
  hold: boolean;
  /** The button went down this frame (quick clicks work a snagged hook loose). */
  tap: boolean;
  rain: number;
}

export type FishingEvent =
  | { type: 'caught'; fishId: string }
  | { type: 'noWater' }
  | { type: 'cast' }
  | { type: 'bite' }
  /** The hook caught on algae (`lostFish`: the fish on it tore free). */
  | { type: 'snag'; lostFish: boolean }
  | { type: 'unsnag' }
  /** The hooked fish worked itself off the hook before it was landed. */
  | { type: 'escape' };

/** Classifies a cast target: the sea past the coastline, lakes beyond the old farm, else the pond. */
export function waterAt(x: number, z: number): FishingWater {
  const r = Math.hypot(x, z);
  if (r > coastRadius(x, z) - 32) return 'sea';
  return r > 72 ? 'lake' : 'pond';
}

const MIN_DIST = 3;
/** Hook depth under the float (the leader's length): wheel steps, limits, and the gap kept off the bed. */
const DEPTH_MIN = 0.2;
const DEPTH_MAX = 2.4;
const DEPTH_STEP = 0.15;
const DEPTH_BED_GAP = 0.15;
const MAX_DIST = 17;
/** Seconds of holding to a full cast. */
const CHARGE_TIME = 1.4;
/** Reeling starts slow and speeds up the longer the button is held. */
const REEL_SPEED_MIN = 1.6;
const REEL_SPEED_MAX = 6.0;
/** Seconds of holding to full reel speed. */
const REEL_RAMP = 1.8;
/** Chance per algae check (every SNAG_CHECK s while the hook passes a stalk) that it catches. */
const SNAG_CHANCE = 0.35;
const SNAG_CHECK = 0.12;
/** Quick clicks it takes to tear a snagged hook free (random in this range). */
const SNAG_CLICKS_MIN = 5;
const SNAG_CLICKS_MAX = 9;
/** How fast the loosening is lost between clicks (progress per second). */
const SNAG_DECAY = 0.12;
/** How close (m) the hook must pass to a joint of a stalk to catch on it. */
const SNAG_REACH = 0.3;
/** A fish takes the hook over this long (s): the leader and the fish glide into place. */
const BITE_BLEND = 0.55;
/** The reeled bobber is in when this close to the angler (m, horizontal). */
const LANDED_DIST = 1.8;
/** Wave-simulation slot for the bobber's wake (slots 1..4 are the swimmer's limbs, unused on shore). */
const RIPPLE_SLOT = 4;
/** Camera swing from above the water to the underwater view after landing (s). */
const DIVE_TIME = 2.1;
const CAUGHT_TIME = 2.1;
/** The camera's swing from under the water back to the usual view after a catch. */
const RISE_TIME = 1.9;

const UP = new THREE.Vector3(0, 1, 0);

/** The camera view the fishing asks for (the third-person camera blends into it). */
export interface CameraShot {
  pos: THREE.Vector3;
  look: THREE.Vector3;
}

export class FishingSystem {
  public readonly state: FishingState = {
    phase: 'idle',
    power: 0,
    canCast: false,
    nibble: false,
    reeling: false,
    snagged: false,
    snagProgress: 0,
    escape: 0,
    depth: 0.8,
    water: 'pond',
    lastFishId: null,
  };
  public revision = 0;
  /** The view the camera should take now, null = the usual third-person camera. */
  public cameraShot: CameraShot | null = null;
  /** Where the wave simulation should be centred while the bobber is out (null = the player). */
  public rippleFocus: THREE.Vector3 | null = null;
  /**
   * The usual camera's own view (wired by the engine every frame): the rise after a catch ends
   * exactly on it, so handing the camera back has nothing left to swing.
   */
  public exitView: CameraShot | null = null;
  /** A yaw for the usual camera to take at once (set on a catch, cleared by the engine). */
  public cameraYawRequest: number | null = null;
  /** The algae the hook can snag on (wired by the gameplay manager). */
  public algae: AlgaeField | null = null;
  /** The hook's point, while it is in the water, for the algae to feel (null otherwise). */
  public algaeTouch: THREE.Vector3 | null = null;

  private readonly sample: WaterSampler;
  private readonly fish: FishingFish;
  private readonly line: FishingLine;
  private readonly circle: CastCircle;

  private readonly bobber = new THREE.Vector3();
  private readonly prevBobber = new THREE.Vector3();
  private readonly flightFrom = new THREE.Vector3();
  private readonly flightTo = new THREE.Vector3();
  private readonly castDir = new THREE.Vector3(0, 0, 1);
  private readonly hookPin = new THREE.Vector3();
  private flightT = 0;
  private flightDur = 1;
  private arcH = 2;
  private castDist = 5;
  private lineLen = 5;
  private leaderLen = 0.6;
  /** The depth the player asked for (kept between casts); the leader eases to it, never past the bed. */
  private depthWanted = 0.8;
  private chargeT = 0;
  private time = 0;
  private needRelease = false;
  private hooked: FishAgent | null = null;
  private baitSpeed = 0;
  private caughtT = 0;
  private rippleT = 0;

  // Camera
  private readonly shot: CameraShot = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  private readonly divePos = new THREE.Vector3();
  private readonly diveLook = new THREE.Vector3();
  private readonly diveFrom = new THREE.Vector3();
  private readonly diveFromLook = new THREE.Vector3();
  private diveT = 1;
  /** Underwater orbit around the float: smoothed angle, distance and height. */
  private orbitYaw = 0;
  private orbitDist = 3.4;
  private orbitY = 0;
  /** Side picked automatically (shallow water), and the player's own turn of the view. */
  private autoYaw = 0;
  private userYaw = 0;
  private userTurned = false;
  private riseT = 0;
  /** Hooked fish: its body centre and heading, and how much it is being reeled (0..1, smoothed). */
  private readonly fishBody = new THREE.Vector3();
  private readonly fishHeading = new THREE.Vector3(0, 0, 1);
  private reelW = 0;
  /** How long the reel has been held without a break (s): the reel speeds up with it. */
  private reelHoldT = 0;
  private snagCheckT = 0;
  /** No new snag for this long after one was torn free (s). */
  private snagCooldown = 0;
  private snagNeed = 6;
  /** 0..1: how hard the last clicks yanked the snag (decays). */
  private snagTug = 0;
  /** Where the held joint was when the hook caught (the stalk is pulled from there). */
  private readonly snagRest = new THREE.Vector3();
  /** The bite's glide: 0..1, and the hook and the fish where the bite started. */
  private biteT = 1;
  private readonly biteFromHook = new THREE.Vector3();
  private readonly biteFromBody = new THREE.Vector3();
  private readonly snagPoint = new THREE.Vector3();
  private readonly algaePoint = new THREE.Vector3();
  private readonly riseFrom = new THREE.Vector3();
  private readonly riseLookFrom = new THREE.Vector3();
  /** Which way round the angler the camera swings after a catch (+1 / -1). */
  private riseSide = 1;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly tmp3 = new THREE.Vector3();

  constructor(scene: THREE.Scene, terrain: TerrainSystem, private readonly particles?: ParticleManager) {
    const s = { level: 0, ground: 0 };
    // One shared result: every caller reads it straight away
    this.sample = (x, z) => {
      s.level = waterLevelAt(x, z);
      s.ground = terrain.getHeight(x, z);
      return s;
    };
    this.fish = new FishingFish(scene, this.sample);
    this.line = new FishingLine(scene, this.sample);
    this.circle = new CastCircle(scene, this.sample);
  }

  public get busy(): boolean {
    return this.state.phase !== 'idle';
  }

  /** Is there water to cast to in direction `dir` from `pos`? */
  public canAim(pos: THREE.Vector3, dir: THREE.Vector3): boolean {
    for (let d = MIN_DIST * 0.7; d <= MAX_DIST; d += 0.5) {
      const s = this.sample(pos.x + dir.x * d, pos.z + dir.z * d);
      if (s.level - s.ground > MIN_CAST_DEPTH) return true;
    }
    return false;
  }

  /** Starts charging a cast (the button went down). */
  public beginAim(): void {
    if (this.state.phase !== 'idle') return;
    this.state.phase = 'aim';
    this.state.power = 0;
    this.state.canCast = false;
    this.chargeT = 0;
    this.touch();
  }

  public cancel(): void {
    if (this.state.phase !== 'idle') this.reset();
  }

  public update(dt: number, inp: FishingInput): FishingEvent | null {
    this.time += dt;
    const s = this.state;
    if (!inp.hold) this.needRelease = false;
    let event: FishingEvent | null = null;

    switch (s.phase) {
      case 'idle':
        break;
      case 'aim': {
        this.chargeT += dt;
        const t = Math.min(1, this.chargeT / CHARGE_TIME);
        s.power = 1 - (1 - t) * (1 - t);
        const dist = THREE.MathUtils.lerp(MIN_DIST, MAX_DIST, s.power);
        this.castDir.copy(inp.aimDir).setY(0).normalize();
        const ok = this.circle.place(inp.player, this.castDir, dist, 0.5 + dist * 0.12, MIN_DIST * 0.7);
        if (ok !== s.canCast) {
          s.canCast = ok;
          this.touch();
        }
        this.circle.visible = ok;
        if (ok) this.circle.draw(this.time);
        if (!inp.hold) {
          this.circle.visible = false;
          if (ok) {
            this.startFlight(inp);
            event = { type: 'cast' };
          } else {
            this.reset();
            event = { type: 'noWater' };
          }
        }
        break;
      }
      case 'flight': {
        this.flightT += dt;
        const t = Math.min(1, this.flightT / this.flightDur);
        this.prevBobber.copy(this.bobber);
        this.bobber.lerpVectors(this.flightFrom, this.flightTo, t);
        this.bobber.y += 4 * t * (1 - t) * this.arcH;
        // The line pays out behind the bobber
        this.lineLen = Math.max(this.lineLen, inp.rodTip.distanceTo(this.bobber) * 1.04);
        this.line.setLength(this.lineLen);
        // The spool spinning free while the line pays out (rate follows the line speed)
        if (dt > 0) fishingSounds.spool(inp.rodTip, this.bobber.distanceTo(this.prevBobber) / dt);
        if (t >= 1) this.land(inp);
        break;
      }
      case 'wait':
      case 'hooked':
        event = this.updateFloat(dt, inp);
        break;
      case 'caught': {
        this.caughtT += dt;
        // Lifted out of the water to hang under the rod tip
        const k = 1 - Math.exp(-dt * 5);
        this.tmp.copy(inp.rodTip).addScaledVector(UP, -0.4).addScaledVector(this.castDir, -0.1);
        this.bobber.lerp(this.tmp, k);
        this.lineLen = Math.max(0.3, inp.rodTip.distanceTo(this.bobber) * 1.02);
        this.line.setLength(this.lineLen);
        this.line.setLeaderLength(0.4);
        if (this.hooked) {
          const f = this.hooked;
          // Swings round to hang head up from the hook (eased from how it was swimming)
          this.tmp2.set(Math.sin(this.time * 9) * 0.25, 1, Math.cos(this.time * 7) * 0.2).normalize();
          this.fishHeading.lerp(this.tmp2, 1 - Math.exp(-dt * 7)).normalize();
          this.tmp.copy(this.line.hookPos).addScaledVector(this.fishHeading, -f.scale * 0.48);
          this.fish.holdAt(f, this.tmp, this.fishHeading, 1);
        }
        if (this.caughtT >= CAUGHT_TIME) this.reset();
        break;
      }
    }

    // Fish: only while a trip is on (or fading out after it)
    if (this.fish.active) {
      const res = this.fish.update(dt, {
        pos: this.line.hookPos,
        active: s.phase === 'wait' && !s.snagged,
        speed: this.baitSpeed,
      });
      const nib = res.nibble > 0.05;
      if (nib !== s.nibble) {
        s.nibble = nib;
        this.touch();
      }
      if (s.phase === 'wait' && res.nibble > 0.8 && this.rippleT <= 0) {
        // Little tugs ring the water around the float
        emitWaterRipple(this.bobber.x, this.bobber.z, 0.35, 0.9);
        fishingSounds.play('plip', this.bobber, 0.45);
        this.rippleT = 0.35;
      }
      this.nibble = res.nibble;
      if (res.bit && s.phase === 'wait') {
        this.hooked = res.bit;
        this.fishBody.copy(res.bit.pos);
        this.fishHeading.set(res.bit.dir.x, 0, res.bit.dir.z);
        if (this.fishHeading.lengthSq() < 1e-4) this.fishHeading.set(0, 0, 1);
        this.fishHeading.normalize();
        this.reelW = 0;
        // No jump: the hook and the fish glide from where they are into the taut pose
        this.biteT = 0;
        this.biteFromHook.copy(this.line.hookPos);
        this.biteFromBody.copy(res.bit.pos);
        s.escape = 0;
        fishingSounds.play('bite', this.bobber, 1);
        s.phase = 'hooked';
        emitWaterRipple(this.bobber.x, this.bobber.z, 0.9, 1.8);
        this.particles?.emitSplash(this.bobber, 8);
        event = { type: 'bite' };
        this.touch();
      }
    }

    if (s.phase === 'flight' || s.phase === 'wait' || s.phase === 'hooked' || s.phase === 'caught') {
      let pin: THREE.Vector3 | null = null;
      if (s.phase === 'hooked' && this.hooked) {
        this.reelW += ((s.reeling ? 1 : 0) - this.reelW) * (1 - Math.exp(-dt * 4));
        this.awayDir(inp.player, this.tmp);
        this.tmp2.set(-this.tmp.z, 0, this.tmp.x);
        this.steerFish(dt);
        pin = this.fishPin(this.hookPin);
        if (this.biteT < 1) {
          this.biteT = Math.min(1, this.biteT + dt / BITE_BLEND);
          const e = this.biteT * this.biteT * (3 - 2 * this.biteT);
          pin.lerpVectors(this.biteFromHook, pin, e);
        }
      } else if (s.snagged) {
        // The hook sits on a joint of the stalk; the line pulls that joint towards the float, and
        // every click yanks it harder, so the stalk bends and tautens
        if (!this.algae || !this.algae.grabPoint(this.snagPoint)) {
          event = this.unsnag();
        } else {
          const toFloat = this.tmp.copy(this.bobber);
          toFloat.y -= 0.1;
          toFloat.sub(this.snagRest);
          const len = toFloat.length() || 1;
          toFloat.divideScalar(len);
          const reach = Math.min(len, 0.2 + this.snagTug * 0.9 + s.snagProgress * 0.25);
          this.tmp2.copy(this.snagRest).addScaledVector(toFloat, reach);
          this.algae.setGrabTarget(this.tmp2.x, this.tmp2.y, this.tmp2.z, 0.06 + this.snagTug * 0.3);
          pin = this.hookPin.copy(this.snagPoint);
        }
      }
      // The float tips over with the pull: the reel's speed, more with a fish fighting on it
      const pullT = s.snagged ? 0.45 + this.snagTug * 0.55 : s.phase === 'hooked' ? (s.reeling ? 0.95 : 0.55) : s.reeling ? Math.min(0.8, this.baitSpeed / 5) : 0;
      this.line.pull += (pullT - this.line.pull) * (1 - Math.exp(-dt * 5));
      this.line.update(dt, inp.rodTip, this.bobber, pin, s.phase === 'wait' || s.phase === 'hooked');
      if (s.phase === 'hooked' && this.hooked) this.placeFish();
    }
    // The hook parts the fronds it passes (not while it hangs on one: the snag pulls that)
    this.algaeTouch = (s.phase === 'wait' || s.phase === 'hooked') && !s.snagged ? this.line.hookPos : null;

    this.updateCamera(dt, inp);
    this.updateWater(dt);
    return event;
  }

  public dispose(): void {
    this.fish.dispose();
    this.line.dispose();
    this.circle.dispose();
  }

  // ------------------------------------------------------------------ phases

  private nibble = 0;

  private startFlight(inp: FishingInput): void {
    const s = this.state;
    this.circle.randomPoint(this.flightTo);
    this.flightFrom.copy(inp.rodTip);
    this.bobber.copy(inp.rodTip);
    this.prevBobber.copy(this.bobber);
    this.castDist = Math.hypot(this.flightTo.x - inp.player.x, this.flightTo.z - inp.player.z);
    this.flightDur = 0.55 + this.castDist * 0.04;
    this.arcH = 0.8 + this.castDist * 0.22;
    this.flightT = 0;
    this.lineLen = 0.3;
    this.line.reset(inp.rodTip, this.bobber, 0.3);
    fishingSounds.play('cast', inp.rodTip, 0.55 + s.power * 0.45, 1.1 - s.power * 0.2);
    this.line.visible = true;
    s.water = waterAt(this.flightTo.x, this.flightTo.z);
    s.phase = 'flight';
    s.nibble = false;
    s.reeling = false;
    this.hooked = null;
    this.needRelease = true;
    // The fish are there before the camera dives
    this.fish.spawn(this.flightTo, inp.player, s.water, inp.rain);
    // Camera: from behind the angler, following the bobber
    this.flightCamera(inp, this.shot.pos);
    this.shot.look.copy(inp.rodTip);
    this.cameraShot = this.shot;
    this.diveT = 1;
    this.touch();
  }

  private land(inp: FishingInput): void {
    const s = this.state;
    const w = this.sample(this.bobber.x, this.bobber.z);
    this.bobber.y = w.level;
    const depth = w.level - w.ground;
    // The hook sinks to the depth the player chose (no deeper than the water allows)
    this.leaderLen = Math.min(0.3, this.depthLimit(depth));
    this.line.setLeaderLength(this.leaderLen);
    s.depth = Math.min(this.depthWanted, this.depthLimit(depth));
    this.lineLen = inp.rodTip.distanceTo(this.bobber) * 1.08;
    this.line.setLength(this.lineLen);
    // Splash: a ring on the water (a dent in the wave simulation), droplets, fish scatter
    emitWaterRipple(this.bobber.x, this.bobber.z, 1, 2.4);
    this.particles?.emitSplash(this.bobber, 12);
    fishingSounds.play('splash', this.bobber, 0.9);
    this.fish.scare(this.bobber, 2.2);
    s.phase = 'wait';
    // The camera swings round and dips under the surface beyond the float
    this.diveFrom.copy(this.shot.pos);
    this.diveFromLook.copy(this.shot.look);
    this.diveT = 0;
    this.autoYaw = 0;
    this.userYaw = 0;
    this.userTurned = false;
    this.updateOrbit(0, inp.player, true);
    this.touch();
  }

  /** Float on the water: bobbing, nibbles, the fish's pull, and reeling in. */
  private updateFloat(dt: number, inp: FishingInput): FishingEvent | null {
    const s = this.state;
    const reeling = inp.hold && !this.needRelease;
    if (reeling !== s.reeling) {
      s.reeling = reeling;
      this.touch();
    }
    this.prevBobber.copy(this.bobber);
    const dx = inp.player.x - this.bobber.x;
    const dz = inp.player.z - this.bobber.z;
    const dist = Math.hypot(dx, dz) || 1;
    const tx = dx / dist, tz = dz / dist;
    const diff = this.hooked?.def.difficulty ?? 0;
    this.reelHoldT = reeling ? this.reelHoldT + dt : 0;
    this.snagCooldown -= dt;

    if (s.snagged) {
      // Snagged: quick clicks yank the hook (each one a tug on the stalk); between them it settles back
      this.snagTug = Math.max(0, this.snagTug - dt * 2.4);
      if (inp.tap) {
        s.snagProgress = Math.min(1, s.snagProgress + 1 / this.snagNeed);
        this.snagTug = Math.min(1, this.snagTug + 0.6);
        fishingSounds.play('snagTug', this.line.hookPos, 0.6, 0.9 + s.snagProgress * 0.25);
        emitWaterRipple(this.bobber.x, this.bobber.z, 0.35, 0.8);
        this.touch();
      } else {
        s.snagProgress = Math.max(0, s.snagProgress - dt * SNAG_DECAY);
      }
      this.reelHoldT = 0;
      // The rod pulls against the snag: each tug drags the float towards the angler until the
      // leader runs taut from its keel down to the stalk, and under the water a little; between
      // tugs the weed draws it back over the snag. The main line stays tight to the rod.
      const T = this.snagTug;
      const a = this.snagRest;
      const ax = inp.player.x - a.x, az = inp.player.z - a.z;
      const al = Math.hypot(ax, az) || 1;
      const w0 = this.sample(this.bobber.x, this.bobber.z);
      const ty = w0.level - (0.02 + T * 0.13);
      const dy = ty - 0.1 - a.y; // keel above the stalk
      const reach = this.leaderLen * (0.55 + 0.42 * T);
      const h = Math.sqrt(Math.max(0, reach * reach - dy * dy));
      const bx = a.x + (ax / al) * h, bz = a.z + (az / al) * h;
      const kk = 1 - Math.exp(-dt * (T > 0.05 ? 14 : 4));
      this.bobber.x += (bx - this.bobber.x) * kk;
      this.bobber.z += (bz - this.bobber.z) * kk;
      this.bobber.y += (ty - this.bobber.y) * (1 - Math.exp(-dt * 16));
      this.baitSpeed = 0;
      this.lineLen = inp.rodTip.distanceTo(this.bobber) * (1.005 + (1 - T) * 0.02);
      this.line.setLength(this.lineLen);
      if (s.snagProgress >= 1) return this.unsnag();
      return null;
    }

    {
      const wd = this.sample(this.bobber.x, this.bobber.z);
      const limit = this.depthLimit(wd.level - wd.ground);
      const want = Math.min(this.depthWanted, limit);
      if (Math.abs(want - s.depth) > 0.02) {
        s.depth = want;
        this.touch();
      }
      // Line paid out / wound in at a steady pace, so the hook visibly sinks or rises
      const dl = want - this.leaderLen;
      if (Math.abs(dl) > 1e-3) {
        this.leaderLen += Math.sign(dl) * Math.min(Math.abs(dl), dt * 1.2);
        this.line.setLeaderLength(this.leaderLen);
      }
    }

    if (this.hooked) {
      // The fish works at the hook all the time: the bigger it is the faster it gets loose; a
      // fish being reeled has less room to fight, a slack line lets it shake free quickly
      const def = this.hooked.def;
      const rate = (0.1 + def.size * 0.22 + def.difficulty * 0.06) * (reeling ? 0.45 : 1.5);
      const before = s.escape;
      s.escape = Math.min(1, s.escape + rate * dt);
      if (Math.floor(before * 20) !== Math.floor(s.escape * 20)) this.touch();
      if (s.escape >= 1) return this.escapeFish();
    }

    if (reeling) {
      // Speeds up the longer the reel is held
      const ramp = Math.min(1, this.reelHoldT / REEL_RAMP);
      const base = THREE.MathUtils.lerp(REEL_SPEED_MIN, REEL_SPEED_MAX, ramp * ramp * (3 - 2 * ramp));
      const speed = this.hooked ? base * (1 - 0.5 * diff) : base;
      const step = speed * dt;
      fishingSounds.reel(inp.rodTip, speed);
      const nx = this.bobber.x + tx * step + (this.hooked ? -tz * Math.sin(this.time * 2.3) * 0.5 * dt : 0);
      const nz = this.bobber.z + tz * step + (this.hooked ? tx * Math.sin(this.time * 2.3) * 0.5 * dt : 0);
      const w = this.sample(nx, nz);
      if (dist - step < LANDED_DIST || w.level - w.ground < 0.12) return this.retrieve();
      this.bobber.x = nx;
      this.bobber.z = nz;
    } else if (this.hooked) {
      // The fish tows the float the way it swims (the leader is taut between them)
      const pull = 0.35 + diff * 0.55;
      const hx = this.fishHeading.x, hz = this.fishHeading.z;
      const nx = this.bobber.x + hx * pull * dt;
      const nz = this.bobber.z + hz * pull * dt;
      const w = this.sample(nx, nz);
      if (w.level - w.ground > MIN_CAST_DEPTH && dist < MAX_DIST + 4) {
        this.bobber.x = nx;
        this.bobber.z = nz;
      }
    }

    const w = this.sample(this.bobber.x, this.bobber.z);
    let y = w.level + Math.sin(this.time * 2.1) * 0.012 + Math.sin(this.time * 3.4 + 1) * 0.006;
    if (this.hooked) y = w.level - 0.1 + Math.sin(this.time * 13) * 0.03;
    else y -= this.nibble * 0.045;
    // Eased, so the float is pulled under rather than snapping there
    this.bobber.y += (y - this.bobber.y) * (1 - Math.exp(-dt * 14));

    const moved = Math.hypot(this.bobber.x - this.prevBobber.x, this.bobber.z - this.prevBobber.z) / Math.max(dt, 1e-4);
    this.baitSpeed += (moved - this.baitSpeed) * Math.min(1, dt * 8);

    // A hook dragged past algae may catch on a stalk
    this.snagCheckT -= dt;
    if (this.algae && this.snagCheckT <= 0 && this.snagCooldown <= 0 && this.baitSpeed > 0.25) {
      this.snagCheckT = SNAG_CHECK;
      const h = this.line.hookPos;
      if (this.algae.grab(h.x, h.y, h.z, SNAG_REACH, this.algaePoint)) {
        if (Math.random() < SNAG_CHANCE) return this.snag();
        this.algae.releaseGrab();
      }
    }

    // Line: tight while reeling, slack lying on the water otherwise, pays out to a running fish
    const straight = inp.rodTip.distanceTo(this.bobber);
    if (reeling) this.lineLen = Math.min(this.lineLen, straight * 1.03 + 0.05);
    this.lineLen = Math.max(this.lineLen, straight * 1.01);
    this.line.setLength(this.lineLen);
    return null;
  }

  /** The float reached the angler: a fish on it is landed, an empty hook just comes out. */
  private retrieve(): FishingEvent | null {
    const s = this.state;
    if (!this.hooked) {
      this.reset();
      return null;
    }
    s.phase = 'caught';
    s.reeling = false;
    s.lastFishId = this.hooked.def.id;
    this.caughtT = 0;
    emitWaterRipple(this.bobber.x, this.bobber.z, 0.8, 1.5);
    this.particles?.emitSplash(this.bobber, 10);
    fishingSounds.play('catch', this.bobber, 1);
    this.riseFrom.copy(this.shot.pos);
    this.riseLookFrom.copy(this.shot.look);
    // The usual camera turns (hidden under the shot) to stand behind the angler facing the water
    this.cameraYawRequest = Math.atan2(-this.castDir.x, -this.castDir.z);
    this.riseT = 0;
    this.rippleFocus = null;
    this.touch();
    return { type: 'caught', fishId: this.hooked.def.id };
  }

  private reset(): void {
    const s = this.state;
    const landed = s.phase === 'caught';
    s.phase = 'idle';
    s.power = 0;
    s.canCast = false;
    s.nibble = false;
    s.reeling = false;
    s.snagged = false;
    s.snagProgress = 0;
    s.escape = 0;
    this.algaeTouch = null;
    this.algae?.releaseGrab();
    this.circle.visible = false;
    this.line.visible = false;
    this.cameraShot = null;
    this.rippleFocus = null;
    if (this.hooked) {
      if (landed) this.fish.remove(this.hooked);
      else this.fish.release(this.hooked);
      this.hooked = null;
    }
    this.fish.clear(false);
    this.baitSpeed = 0;
    this.nibble = 0;
    this.touch();
  }

  // ------------------------------------------------------------------ water

  /** The bobber in the wave simulation: a wake while it moves, small rings while it bobs. */
  private updateWater(dt: number): void {
    const p = this.state.phase;
    this.rippleT -= dt;
    if (p !== 'wait' && p !== 'hooked' && p !== 'flight') return;
    this.rippleFocus = this.bobber;
    if (p === 'flight') return;
    const b = this.bobber;
    if (waterRippleSim.active) waterRippleSim.setPusher(RIPPLE_SLOT, b.x, b.z, this.hooked ? Math.max(this.baitSpeed, 1.2) : this.baitSpeed, this.hooked ? 0.22 : 0.1);
    if (this.rippleT <= 0) {
      if (this.hooked) {
        // The fish thrashing under the float
        emitWaterRipple(b.x + (Math.random() - 0.5) * 0.4, b.z + (Math.random() - 0.5) * 0.4, 0.55, 1.3);
        if (Math.random() < 0.35) {
          this.particles?.emitSplash(b, 4);
          fishingSounds.play('thrash', this.line.hookPos, 0.5, 0.85 + Math.random() * 0.35);
        }
        this.rippleT = 0.22 + Math.random() * 0.15;
      } else if (this.baitSpeed > 0.3) {
        // Rings trailing the reeled float
        emitWaterRipple(b.x, b.z, 0.25, 0.7, undefined, (b.x - this.prevBobber.x) / Math.max(dt, 1e-4), (b.z - this.prevBobber.z) / Math.max(dt, 1e-4));
        this.rippleT = 0.18;
      } else {
        // Gentle rings from the bobbing float
        emitWaterRipple(b.x, b.z, 0.12, 0.55);
        this.rippleT = 1.6 + Math.random() * 0.8;
      }
    }
  }

  // ------------------------------------------------------------------ camera

  private awayDir(player: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.set(this.bobber.x - player.x, 0, this.bobber.z - player.z);
    if (out.lengthSq() < 0.01) out.copy(this.castDir);
    return out.normalize();
  }

  /** Behind the angler's shoulder, drifting forward with the flight. */
  private flightCamera(inp: FishingInput, out: THREE.Vector3): THREE.Vector3 {
    const d = this.castDir;
    const t = Math.min(1, this.flightT / this.flightDur);
    return out
      .copy(inp.player)
      .addScaledVector(d, -3.0 + t * this.castDist * 0.3)
      .add(this.tmp3.set(-d.z * 0.7, 2.6 + t * 0.6, d.x * 0.7));
  }

  /** Shortest signed angle from a to b. */
  private static angleTo(a: number, b: number): number {
    return Math.atan2(Math.sin(b - a), Math.cos(b - a));
  }

  /**
   * Where the camera would be at orbit angle `yaw` around the float (`yaw` = direction from the
   * float to the camera). Underwater at the first distance with enough depth; above the water
   * (or the bank) when it is too shallow all the way in. Returns false for the above-water case.
   */
  private orbitSpot(yaw: number, out: THREE.Vector3): boolean {
    const b = this.bobber;
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    for (const d of [3.4, 2.6, 1.8]) {
      const mid = this.sample(b.x + dx * d * 0.5, b.z + dz * d * 0.5);
      if (mid.level - mid.ground < 0.35) continue;
      const w = this.sample(b.x + dx * d, b.z + dz * d);
      const depth = w.level - w.ground;
      if (depth < 0.7) continue;
      out.set(d, w.level - Math.min(0.55, depth * 0.45), 0);
      return true;
    }
    const w = this.sample(b.x + dx * 3, b.z + dz * 3);
    out.set(3, Math.max(w.level, w.ground) + 0.8, 0);
    return false;
  }

  /** Turns the underwater view around the float by `angle` (rad, same sense as the orbit camera's yaw). */
  public rotateView(angle: number): void {
    if (this.state.phase !== 'wait' && this.state.phase !== 'hooked') return;
    this.userYaw += angle;
    this.userTurned = true;
  }

  /**
   * Mouse wheel while the float waits: raises / lowers the hook (`steps` > 0 = deeper), within
   * DEPTH_MIN..DEPTH_MAX and never into the bed. Returns true when the wheel was used here.
   */
  public adjustDepth(steps: number): boolean {
    const s = this.state;
    if (s.phase !== 'wait' && s.phase !== 'hooked') return false;
    if (s.phase === 'hooked' || s.snagged) return true; // taken, but the leader is busy
    const w = this.sample(this.bobber.x, this.bobber.z);
    const limit = this.depthLimit(w.level - w.ground);
    const next = THREE.MathUtils.clamp(Math.min(this.depthWanted, limit) + steps * DEPTH_STEP, DEPTH_MIN, limit);
    if (Math.abs(next - s.depth) < 1e-3) return true;
    // A couple of spool ticks: line let out or wound back
    fishingSounds.play('spool', this.bobber, 0.35, next > s.depth ? 0.9 : 1.1);
    fishingSounds.play('spool', this.bobber, 0.3, next > s.depth ? 0.88 : 1.12, (audioEngine.context?.currentTime ?? 0) + 0.05);
    this.depthWanted = next;
    s.depth = next;
    this.touch();
    return true;
  }

  /** The deepest the hook may hang in water `depth` deep. */
  private depthLimit(depth: number): number {
    return THREE.MathUtils.clamp(depth - DEPTH_BED_GAP, DEPTH_MIN, DEPTH_MAX);
  }

  /** The underwater camera takes the mouse while the float is in the water. */
  public get wantsLook(): boolean {
    return this.state.phase === 'wait' || this.state.phase === 'hooked';
  }

  /**
   * The underwater view orbits the float: a little below the surface beyond it, looking back
   * towards the angler and slightly up. The orbit angle (not the position) is smoothed, so a
   * change of side swings the camera round the float instead of through it.
   */
  private updateOrbit(dt: number, player: THREE.Vector3, snap: boolean): void {
    const away = this.awayDir(player, this.tmp);
    const awayYaw = Math.atan2(away.x, away.z);
    // Until the player turns it, keep to a side deep enough to dive (sticky, nearest to the last)
    if (!this.userTurned && !this.orbitSpot(awayYaw + this.autoYaw, this.tmp2)) {
      let best = this.autoYaw;
      let bestCost = Infinity;
      for (let a = -1.6; a <= 1.6; a += 0.2) {
        const cost = Math.abs(a - this.autoYaw) + Math.abs(a) * 0.5;
        if (cost < bestCost && this.orbitSpot(awayYaw + a, this.tmp2)) {
          best = a;
          bestCost = cost;
        }
      }
      this.autoYaw = best;
    }
    const target = awayYaw + this.autoYaw + this.userYaw;
    if (snap) this.orbitYaw = target;
    else this.orbitYaw += FishingSystem.angleTo(this.orbitYaw, target) * (1 - Math.exp(-dt * 3.5));

    this.orbitSpot(this.orbitYaw, this.tmp2);
    const k = snap ? 1 : 1 - Math.exp(-dt * 3);
    this.orbitDist += (this.tmp2.x - this.orbitDist) * k;
    this.orbitY += (this.tmp2.y - this.orbitY) * k;

    const b = this.bobber;
    const dx = Math.sin(this.orbitYaw), dz = Math.cos(this.orbitYaw);
    const px = b.x + dx * this.orbitDist, pz = b.z + dz * this.orbitDist;
    const ground = this.sample(px, pz).ground;
    // A deep hook takes the camera down with it, so the bait (and the fish around it) stay in
    // view; the leader length is already eased, so this sinks and rises smoothly
    const drop = Math.max(0, this.leaderLen - 0.45) * 0.8;
    this.divePos.set(px, Math.max(this.orbitY - drop, ground + 0.25), pz);
    const lvl = this.sample(b.x, b.z).level;
    this.diveLook.set(b.x - dx * 1.8, lvl - 0.04 - drop * 0.9, b.z - dz * 1.8);
  }

  /**
   * After a catch: up out of the water and back to the usual camera behind the angler. The eyes
   * follow the fish being lifted, then settle on the usual camera's own look point, so when the
   * shot is let go the view is already exactly where the normal camera is.
   */
  private updateRise(dt: number, inp: FishingInput): void {
    if (this.riseT === 0) {
      // Keep going round on the side of the cast line the underwater camera already sits on
      const castYaw = Math.atan2(this.castDir.x, this.castDir.z);
      const camYaw = Math.atan2(this.riseFrom.x - inp.player.x, this.riseFrom.z - inp.player.z);
      this.riseSide = FishingSystem.angleTo(castYaw, camYaw) >= 0 ? 1 : -1;
    }
    this.riseT = Math.min(1, this.riseT + dt / RISE_TIME);
    const t = this.riseT;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const d = this.castDir;
    const end = this.exitView;
    const p3 = end ? this.tmp2.copy(end.pos) : this.tmp2.copy(inp.player).addScaledVector(d, -3.2).add(this.tmp3.set(-d.z * 0.6, 2.4, d.x * 0.6));
    const p0 = this.riseFrom;
    // Swing round the angler (never over or through them): the bearing and the distance from the
    // angler are blended, so the camera keeps facing in towards the fish and the angler all the way
    const c = inp.player;
    const a0 = Math.atan2(p0.x - c.x, p0.z - c.z);
    const a3 = Math.atan2(p3.x - c.x, p3.z - c.z);
    let da = FishingSystem.angleTo(a0, a3);
    // A half turn goes round the side the underwater camera was already on
    if (Math.abs(da) > 2.8) da = Math.abs(da) * (this.riseSide || 1);
    const a = a0 + da * e;
    const r0 = Math.hypot(p0.x - c.x, p0.z - c.z);
    const r3 = Math.hypot(p3.x - c.x, p3.z - c.z);
    const r = Math.max(2.5, r0 + (r3 - r0) * e + Math.sin(Math.PI * e) * 0.8);
    // Up out of the water early, a little arc above, then down onto the usual height
    const ey = 1 - Math.pow(1 - t, 2.5);
    const y = p0.y + (p3.y - p0.y) * ey + Math.sin(Math.PI * t) * 1.2;
    this.shot.pos.set(c.x + Math.sin(a) * r, y, c.z + Math.cos(a) * r);
    // Look: from the underwater framing to the fish coming up, then onto the usual look point
    const fishLook = this.tmp3.copy(this.riseLookFrom).lerp(this.bobber, Math.min(1, t * 3));
    const endLook = end ? end.look : inp.player;
    const w = Math.max(0, (e - 0.35) / 0.65);
    this.shot.look.copy(fishLook).lerp(endLook, w * w * (3 - 2 * w));
  }

  private updateCamera(dt: number, inp: FishingInput): void {
    const p = this.state.phase;
    if (p === 'flight') {
      this.flightCamera(inp, this.tmp2);
      this.shot.pos.lerp(this.tmp2, 1 - Math.exp(-dt * 3));
      this.shot.look.lerp(this.bobber, 1 - Math.exp(-dt * 7));
      return;
    }
    if (p === 'caught') {
      this.updateRise(dt, inp);
      return;
    }
    if (p !== 'wait' && p !== 'hooked') return;
    this.updateOrbit(dt, inp.player, false);
    if (this.diveT < 1) {
      this.diveT = Math.min(1, this.diveT + dt / DIVE_TIME);
      const t = this.diveT;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      // Cubic Bezier: up and over the water, then down past the surface beyond the float
      const p0 = this.diveFrom, p3 = this.divePos;
      const p1 = this.tmp2.copy(p0).addScaledVector(this.castDir, this.castDist * 0.45).addScaledVector(UP, 1.2);
      const p2 = this.tmp3.copy(p3).addScaledVector(UP, 1.5);
      const u = 1 - e;
      this.shot.pos
        .copy(p0).multiplyScalar(u * u * u)
        .addScaledVector(p1, 3 * u * u * e)
        .addScaledVector(p2, 3 * u * e * e)
        .addScaledVector(p3, e * e * e);
      // Eyes on the float the whole way, settling on the final framing at the end
      this.tmp2.copy(this.bobber).lerp(this.diveLook, e * e);
      this.shot.look.lerp(this.tmp2, 1 - Math.exp(-dt * 6));
    } else {
      // The orbit is smoothed already: follow it closely
      this.shot.pos.lerp(this.divePos, 1 - Math.exp(-dt * 10));
      this.shot.look.lerp(this.diveLook, 1 - Math.exp(-dt * 8));
    }
  }

  /** The hook catches on a stalk; a fish on it tears free and swims off. */
  private snag(): FishingEvent {
    const s = this.state;
    s.snagged = true;
    s.snagProgress = 0;
    s.nibble = false;
    this.snagNeed = SNAG_CLICKS_MIN + Math.floor(Math.random() * (SNAG_CLICKS_MAX - SNAG_CLICKS_MIN + 1));
    this.snagTug = 0;
    // Hooked onto the joint itself (the algae holds it from now on)
    this.snagRest.copy(this.algaePoint);
    this.snagPoint.copy(this.algaePoint);
    fishingSounds.play('snagTug', this.algaePoint, 0.5, 0.85);
    const lost = !!this.hooked;
    if (this.hooked) {
      this.fish.release(this.hooked);
      this.hooked = null;
      s.phase = 'wait';
    }
    // The reel stops dead: the next pull has to be a fresh, long one
    this.needRelease = true;
    s.reeling = false;
    emitWaterRipple(this.bobber.x, this.bobber.z, 0.6, 1.2);
    this.touch();
    return { type: 'snag', lostFish: lost };
  }

  /** The fish shook the hook: it swims off, the empty float stays out to be reeled in. */
  private escapeFish(): FishingEvent {
    const s = this.state;
    if (this.hooked) this.fish.release(this.hooked);
    this.hooked = null;
    s.phase = 'wait';
    s.escape = 0;
    s.reeling = false;
    this.needRelease = true;
    fishingSounds.play('snagFree', this.line.hookPos, 0.8, 0.8);
    emitWaterRipple(this.bobber.x, this.bobber.z, 0.8, 1.5);
    this.particles?.emitSplash(this.bobber, 6);
    this.touch();
    return { type: 'escape' };
  }

  private unsnag(): FishingEvent {
    const s = this.state;
    s.snagged = false;
    s.snagProgress = 0;
    this.snagCooldown = 1.5;
    this.reelHoldT = 0;
    this.snagTug = 0;
    this.algae?.releaseGrab();
    fishingSounds.play('snagFree', this.line.hookPos, 0.9);
    emitWaterRipple(this.bobber.x, this.bobber.z, 0.7, 1.4);
    this.particles?.emitSplash(this.bobber, 5);
    this.touch();
    return { type: 'unsnag' };
  }

  /**
   * The hooked fish's heading (where its mouth points). Reeled in, the line pulls the mouth
   * towards the angler and the body trails behind (head first along the pull); left alone, it
   * turns and swims off. tmp = away from the angler, tmp2 = its side (set by the caller).
   */
  private steerFish(dt: number): void {
    const thrash = Math.sin(this.time * 9) * 0.55 + Math.sin(this.time * 3.1) * 0.3;
    const want = this.tmp3
      .copy(this.tmp)
      .multiplyScalar(1 - 2 * this.reelW)
      .addScaledVector(this.tmp2, thrash * THREE.MathUtils.lerp(1, 0.45, this.reelW));
    if (want.x * want.x + want.z * want.z > 1e-4) {
      // Turn by the angle (a vector lerp through a half turn would collapse and snap)
      const yaw = Math.atan2(this.fishHeading.x, this.fishHeading.z);
      const next = yaw + FishingSystem.angleTo(yaw, Math.atan2(want.x, want.z)) * (1 - Math.exp(-dt * 6));
      this.fishHeading.set(Math.sin(next), 0, Math.cos(next));
    }
  }

  /**
   * Where the fish holds the hook: at the full length of the leader from the float, so the
   * leader is pulled taut. Swimming off, the fish is out ahead along its heading and deep; reeled
   * in, it hangs behind the float (away from the angler), towed a little shallower.
   */
  private fishPin(out: THREE.Vector3): THREE.Vector3 {
    const dir = this.tmp3
      .copy(this.fishHeading)
      .multiplyScalar(1 - this.reelW)
      .addScaledVector(this.tmp, this.reelW);
    dir.y = 0;
    if (dir.lengthSq() < 1e-4) dir.copy(this.tmp);
    dir.normalize();
    const down = THREE.MathUtils.lerp(0.75, 0.4, this.reelW);
    const L = this.leaderLen * 0.99;
    out.copy(this.bobber);
    out.y -= 0.1; // the float's keel, where the leader starts
    out.addScaledVector(dir, Math.cos(down) * L);
    out.y -= Math.sin(down) * L;
    const g = this.sample(out.x, out.z).ground + 0.12;
    if (out.y < g) out.y = g;
    return out;
  }

  /** The hooked fish hangs by its mouth on the hook, its body behind it along its heading. */
  private placeFish(): void {
    const f = this.hooked!;
    this.fishBody.copy(this.line.hookPos).addScaledVector(this.fishHeading, -f.scale * 0.48);
    if (this.biteT < 1) {
      const e = this.biteT * this.biteT * (3 - 2 * this.biteT);
      this.fishBody.lerpVectors(this.biteFromBody, this.fishBody, e);
    }
    this.fish.holdAt(f, this.fishBody, this.fishHeading, 1);
  }

  private touch(): void {
    this.revision++;
  }
}
