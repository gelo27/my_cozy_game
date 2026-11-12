import * as THREE from 'three';
import { Season, currentSeason, dayOfSeason } from '../world/Seasons';
import type { FlowerBeds } from '../gathering/FlowerBeds';
import type { PropInstance } from '../world/PropSystem';
import { CharacterController } from '../character/CharacterController';
import { InventoryManager } from '../inventory/InventoryManager';
import { InputManager } from '../input/InputManager';
import { PropSystem } from '../world/PropSystem';
import { WeatherSystem, WeatherType } from '../world/WeatherSystem';
import { FishingSystem, FishingState } from './FishingSystem';
import { PetSystem, Pet } from './PetSystem';
import type RAPIER from '@dimforge/rapier3d-compat';
import { PestSystem, PestKind, PestEnv } from './Pests';
import { SlingshotSystem } from './Slingshot';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { COLLISION_GROUPS } from '../config/constants';
import { BuildingPieceType, BuiltPiece } from '../building/types/BuildingTypes';
import { worldSettings } from '../world/WorldSettings';
import { critterSounds } from './CritterSounds';
import { RECIPES, FISH_IDS, SEA_FISH_IDS, DISH_BUFF, Recipe } from './Recipes';
import { audioEngine } from '../audio/AudioEngine';
import { CompanionNPC } from '../npc/CompanionNPC';
import { MAX_WORKERS, WORKER_HIRE_COST, WorkerManager } from '../npc/WorkerManager';
import { CROP_DEFINITIONS, CROP_TYPES } from '../farming/types/FarmingTypes';
import { DISH_ORDER, WorkerNPC } from '../npc/WorkerNPC';
import { FarmStorage, STORAGE_CHEST } from '../npc/FarmStorage';
import { t, dataName, getLang } from '../i18n/i18n';

/** Flour from one crate of wheat at the millstone (3 flour bake one loaf). */
const FLOUR_PER_CRATE = 3;

export type GameplayPanel = 'cook' | 'shop' | 'workers' | 'storage' | null;

/** Coins a pest knocks out of the player's pockets per hit. */
const HIT_COIN_LOSS = 5;
/** Coins for beating a pest. */
const PEST_REWARD: Record<PestKind, number> = { hedgehog: 6, dragon: 15, shark: 20, spider: 8 };
const PEST_HIT_MSG = { hedgehog: 'pest.hitHedgehog', dragon: 'pest.hitDragon', shark: 'pest.hitShark', spider: 'pest.hitSpider' } as const;
const PEST_DEFEAT_MSG = { hedgehog: 'pest.defeatedHedgehog', dragon: 'pest.defeatedDragon', shark: 'pest.defeatedShark', spider: 'pest.defeatedSpider' } as const;

/** Beds take sleepers from SLEEP_FROM in the evening until SLEEP_UNTIL in the morning. */
const SLEEP_FROM = 18;
const SLEEP_UNTIL = 5;
const SLEEP_HOURS = 8;
/** Sleep sequence (s): the screen goes dark, the clock jumps at SLEEP_SWAP, the morning fades in from SLEEP_FADE_IN. */
const SLEEP_SWAP = 0.7;
const SLEEP_FADE_IN = 2.4;
const SLEEP_END = 2.9;
/** A bed is in reach this far from its centre (m, horizontal). */
const BED_REACH = 1.9;

function isBed(piece: BuiltPiece): boolean {
  return piece.type === BuildingPieceType.FURN_BED_SINGLE || piece.type === BuildingPieceType.FURN_BED_DOUBLE;
}

/** Wraps an hour to 0..24 and formats it "HH:MM". */
function clockLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export interface GameplayPrompt {
  text: string;
  key: string;
  action: 'fish' | 'pet' | 'cook' | 'shop' | 'storage' | 'npc' | 'worker' | 'explore' | 'mill' | 'sleep' | 'flowers';
  secondary?: { text: string; key: string; action: 'treat' };
}

export interface GameplayHudState {
  fishing: FishingState | null;
  panel: GameplayPanel;
  cooking: { recipeId: string; progress: number } | null;
  buff: { label: string; secondsLeft: number } | null;
  weather: WeatherType;
  season: Season;
  /** 1-based day within the season. */
  seasonDay: number;
  isNight: boolean;
  coins: number;
  pets: { name: string; kind: string; affection: number }[];
  /** Doorway fade (caves, lighthouse) and whether the player is underground. */
  fading: boolean;
  inCave: boolean;
  /** Asleep in a bed (the HUD shows the night overlay). */
  sleeping: boolean;
  /** Where the pause menu's respawn button takes the player. */
  respawnAt: 'bed' | 'spawn';
}

/** The exploration layer as gameplay sees it: its E-prompt and doorway state. */
export interface ExplorePort {
  prompt: { text: string } | null;
  fading: boolean;
  inCave: string | null;
  interact(): void;
}

/**
 * Glue for the cosy-life activities: fishing, pets, cooking, the mailbox shop and food buffs.
 * Owns one-button interaction routing so the E key / touch button always does the obvious thing.
 */
export class GameplayManager {
  public panel: GameplayPanel = null;
  public prompt: GameplayPrompt | null = null;
  public readonly fishing: FishingSystem;
  public readonly pets: PetSystem;
  public readonly pests: PestSystem;
  public readonly slingshot: SlingshotSystem;
  public companion: CompanionNPC | null = null;
  public workers: WorkerManager | null = null;
  /** The storage chests' shared stock (workers' seeds, meals and yield). */
  public storage: FarmStorage | null = null;
  /** The farmhand the current 'worker' prompt is about. */
  private promptWorker: WorkerNPC | null = null;
  public explore: ExplorePort | null = null;
  /** Tulip clumps picked by hand with E (wired by the engine). */
  public flowers: FlowerBeds | null = null;
  /** The clump the current E prompt would pick (for its glow), null when the prompt is about something else. */
  public flowerTarget: PropInstance | null = null;
  /** Pets and the companion wait here instead of following (the cave mouth while the player is inside). */
  public anchorOverride: THREE.Vector3 | null = null;
  /** Bumped on any change the HUD should show immediately. */
  public revision = 0;

  private cookingJob: { recipe: Recipe; remaining: number } | null = null;
  private buff: { dishId: string; remaining: number; speed: number } | null = null;
  private baseSpeeds: { walk: number; sprint: number } | null = null;
  private promptTimer = 0;
  private readonly rodTip = new THREE.Vector3();
  private readonly castTarget = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private lastPlayerPos = new THREE.Vector3();
  private invulnerable = 0;
  private readonly aimTmp = new THREE.Vector3();
  private readonly eyeTmp = new THREE.Vector3();
  private readonly muzzle = new THREE.Vector3();

  /** Bed the player last slept in (they respawn beside it), or null for the starting point. */
  public respawnBed: THREE.Vector3 | null = null;
  /** Night (see nightIndex) of the last sleep: one sleep per night. */
  public lastSleepNight = -1;
  private sleep: { t: number; swapped: boolean; night: number; bed: THREE.Vector3 } | null = null;
  /** Bed in reach (refreshed with the prompt), for the sleep action. */
  private bedInReach: BuiltPiece | null = null;
  /** Where the slingshot aims (the camera's view); defaults to the way the player faces. */
  public aim: (out: THREE.Vector3) => THREE.Vector3 = (out) => out.copy(this.character.getFacingDirection());
  /** Where the view (crosshair) ray starts: the camera position. */
  public eye: (out: THREE.Vector3) => THREE.Vector3 = (out) => out.copy(this.character.getPosition());
  /** Runs the rest of the world forward by `seconds` of game time (crops, weather) while the player sleeps. */
  public onTimeSkip: (seconds: number) => void = () => {};
  /** After waking (autosave). */
  public onWake: () => void = () => {};

  public onNotify: (text: string, type?: 'success' | 'info' | 'warning') => void = () => {};

  constructor(
    scene: THREE.Scene,
    private readonly character: CharacterController,
    private readonly inventory: InventoryManager,
    private readonly props: PropSystem,
    private readonly weather: WeatherSystem,
    terrain: ConstructorParameters<typeof FishingSystem>[1],
    private readonly particles?: ConstructorParameters<typeof PetSystem>[2]
  ) {
    this.fishing = new FishingSystem(scene, terrain);
    this.pets = new PetSystem(scene, terrain, particles);
    this.pests = new PestSystem(scene, terrain, particles);
    this.pests.port = {
      hurt: (from, power, kind) => this.hurtPlayer(from, power, kind),
      defeated: (kind) => {
        const n = PEST_REWARD[kind];
        this.inventory.addItem('coins', n);
        this.onNotify(t(PEST_DEFEAT_MSG[kind], { n }), 'success');
        this.revision++;
      },
      playerSwimming: () => !!this.character.swimAbility?.isSwimming,
    };
    this.slingshot = new SlingshotSystem(scene, this.pests, particles);
  }

  /**
   * Physics queries for the pests and pebbles. One reused ray; dynamic bodies (the player, pets,
   * vehicles, loose props) and sensors are ignored, so only the static world blocks.
   */
  public attachPhysics(physics: PhysicsWorld): void {
    const R = physics.rapier;
    const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const flags = R.QueryFilterFlags.EXCLUDE_SENSORS | R.QueryFilterFlags.EXCLUDE_DYNAMIC;
    const groups = physics.packCollisionGroups(0xffff, COLLISION_GROUPS.ENVIRONMENT);
    // Walking pests follow the heightmap themselves: for them only things standing on it count
    const notTerrain = (c: RAPIER.Collider) => ((c.collisionGroups() >>> 16) & COLLISION_GROUPS.TERRAIN) === 0;
    const cast = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, len: number, terrain: boolean): number => {
      if (!physics.isInitialized() || !(len > 1e-4)) return -1;
      ray.origin.x = ox;
      ray.origin.y = oy;
      ray.origin.z = oz;
      ray.dir.x = dx;
      ray.dir.y = dy;
      ray.dir.z = dz;
      try {
        const hit = physics.world.castRay(ray, len, true, flags, groups, undefined, undefined, terrain ? undefined : notTerrain);
        return hit ? hit.timeOfImpact : -1;
      } catch {
        return -1;
      }
    };
    const castNormal = (from: THREE.Vector3, dir: THREE.Vector3, len: number, normal: THREE.Vector3): number => {
      if (!physics.isInitialized() || !(len > 1e-4)) return -1;
      ray.origin.x = from.x;
      ray.origin.y = from.y;
      ray.origin.z = from.z;
      ray.dir.x = dir.x;
      ray.dir.y = dir.y;
      ray.dir.z = dir.z;
      try {
        const hit = physics.world.castRayAndGetNormal(ray, len, true, flags, groups);
        if (!hit) return -1;
        normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        return hit.timeOfImpact;
      } catch {
        return -1;
      }
    };
    const env: PestEnv = {
      cast: castNormal,
      blocked: (x, y, z, dx, dz, dist) => cast(x, y, z, dx, 0, dz, dist, false) >= 0,
      canSee: (from, to) => {
        const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 0.35) return true;
        // Stops just short of the target, so whatever it stands against does not count
        return cast(from.x, from.y, from.z, dx / d, dy / d, dz / d, d - 0.3, true) < 0;
      },
      sweep: (from, dir, len) => cast(from.x, from.y, from.z, dir.x, dir.y, dir.z, len, true),
    };
    this.pests.env = env;
    this.slingshot.env = env;
  }

  // ---------------------------------------------------------------- sleep & respawn

  /** Index of the current night: an evening and the early morning after it share one. */
  private nightIndex(): number {
    return worldSettings.timeOfDay >= SLEEP_FROM ? worldSettings.day : worldSettings.day - 1;
  }

  private canSleepNow(): boolean {
    const h = worldSettings.timeOfDay;
    return h >= SLEEP_FROM || h < SLEEP_UNTIL;
  }

  public get sleeping(): boolean {
    return !!this.sleep;
  }

  private findBedNear(pos: THREE.Vector3, reach: number): BuiltPiece | null {
    const bm = this.character.buildAbility?.buildingManager;
    if (!bm) return null;
    let best: BuiltPiece | null = null;
    let bestD = reach;
    for (const piece of bm.getPiecesNear(pos, reach + 1.5)) {
      if (!isBed(piece) || Math.abs(piece.position.y - pos.y) > 2.2) continue;
      const d = Math.hypot(piece.position.x - pos.x, piece.position.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = piece;
      }
    }
    return best;
  }

  private trySleep(): void {
    const bed = this.bedInReach ?? this.findBedNear(this.character.getPosition(), BED_REACH);
    if (!bed || this.sleep) return;
    if (!this.canSleepNow()) {
      this.onNotify(t('sleep.tooEarly'), 'info');
      return;
    }
    if (this.lastSleepNight === this.nightIndex()) {
      this.onNotify(t('sleep.already'), 'info');
      return;
    }
    if (this.pests.nearestThreat(this.character.getPosition(), 14)) {
      this.onNotify(t('sleep.unsafe'), 'warning');
      return;
    }
    if (this.fishing.busy) this.fishing.cancel();
    this.sleep = { t: 0, swapped: false, night: this.nightIndex(), bed: bed.position.clone() };
    this.setPrompt(null);
    audioEngine.playBuildSelect();
    this.revision++;
  }

  private updateSleep(dt: number): void {
    const s = this.sleep;
    if (!s) return;
    const before = s.t;
    s.t += dt;
    if (!s.swapped && s.t >= SLEEP_SWAP) {
      // Behind the dark screen: the clock jumps SLEEP_HOURS and the world catches up
      s.swapped = true;
      const next = worldSettings.timeOfDay + SLEEP_HOURS;
      if (next >= 24) worldSettings.day++;
      worldSettings.timeOfDay = next % 24;
      const seconds = SLEEP_HOURS * Math.max(0, worldSettings.secondsPerHour);
      if (seconds > 0) {
        this.onTimeSkip(seconds);
        this.updateCooking(seconds);
        this.updateBuff(seconds);
      }
      this.lastSleepNight = s.night;
      this.respawnBed = s.bed;
      this.revision++;
    }
    if (before < SLEEP_FADE_IN && s.t >= SLEEP_FADE_IN) this.revision++;
    if (s.t >= SLEEP_END) {
      this.sleep = null;
      this.invulnerable = 1;
      this.onNotify(t('sleep.woke', { time: clockLabel(worldSettings.timeOfDay) }), 'success');
      this.revision++;
      this.onWake();
    }
  }

  /** Where the pause menu's respawn button takes the player: onto their bed while it still stands. */
  public respawnTarget(fallback: THREE.Vector3): { pos: THREE.Vector3; atBed: boolean } {
    if (this.respawnBed) {
      const bed = this.findBedNear(this.respawnBed, 0.6);
      if (bed) return { pos: bed.position.clone().setY(bed.position.y + 1.4), atBed: true };
    }
    return { pos: fallback.clone(), atBed: false };
  }

  // ---------------------------------------------------------------- pests

  /** A rolling hedgehog or a fireball hit: knockback, a short stun and a few lost coins. */
  private hurtPlayer(from: THREE.Vector3, power: number, kind: PestKind): boolean {
    if (this.invulnerable > 0 || this.sleep) return false;
    this.invulnerable = 1.6;
    const pos = this.character.getPosition();
    this.tmp.set(pos.x - from.x, 0, pos.z - from.z);
    if (this.tmp.lengthSq() < 1e-4) this.tmp.copy(this.character.getFacingDirection()).negate();
    this.character.knockback(this.tmp, power, 0.55);
    critterSounds.ouch();
    const lost = Math.min(HIT_COIN_LOSS, this.inventory.getItemCount('coins'));
    if (lost > 0) this.inventory.removeItem('coins', lost);
    this.onNotify(t(PEST_HIT_MSG[kind], { n: lost }), 'warning');
    this.revision++;
    return true;
  }

  // ---------------------------------------------------------------- frame

  public update(dt: number, input: InputManager, isDriving: boolean, keysG: boolean): void {
    const pos = this.character.getPosition();
    const moving = pos.distanceToSquared(this.lastPlayerPos) > 0.0004;
    this.lastPlayerPos.copy(pos);
    const anchor = this.anchorOverride ?? pos;
    this.pets.update(dt, anchor, moving && !this.anchorOverride);
    this.companion?.update(dt, anchor);
    this.workers?.update(dt, pos);
    this.updateBuff(dt);
    this.updateCooking(dt);
    this.invulnerable -= dt;
    this.updateSleep(dt);
    this.pests.update(dt, pos, !isDriving && !this.sleep, !!this.explore?.inCave);
    this.slingshot.update(dt);
    if (this.sleep) return;

    // Rod tip ~ above the right hand, in front of the player
    const facing = this.character.getFacingDirection();
    this.rodTip.copy(pos).addScaledVector(facing, 0.9);
    this.rodTip.y += 1.9;
    this.fishing.update(dt, this.rodTip, this.weather.rainIntensity);

    if (isDriving || this.panel) {
      this.setPrompt(null);
      this.flowerTarget = null;
      if (this.fishing.busy) this.fishing.cancel();
      return;
    }

    // Moving away cancels a cast
    if (this.fishing.busy && moving && this.fishing.state.phase !== 'reel' && this.fishing.state.phase !== 'caught') {
      if (this.fishing.state.phase !== 'escaped') this.fishing.cancel();
    }

    this.promptTimer -= dt;
    if (this.promptTimer <= 0) {
      this.promptTimer = 0.1;
      this.setPrompt(this.computePrompt(pos, facing));
    }

    const m = input.movement;
    const ownedByOthers = !!(this.character.farmingAbility?.currentPrompt || this.character.gatheringAbility?.currentPrompt);
    // Swimming / diving: whatever is in hand is put away and can't be used
    const swimming = this.character.telemetry.isSwimming;
    if (swimming && this.fishing.busy && this.fishing.state.phase !== 'escaped') this.fishing.cancel();
    const equipped = swimming ? null : this.inventory.getEquippedItemId();
    const hasRod = equipped === 'fishing_rod';
    const pressed = m.interactJustPressed || (hasRod && m.shootJustPressed);

    // Slingshot: LMB / the touch tool button always shoots; E shoots when nothing here wants it
    if (equipped === 'slingshot' && !this.inventory.isInventoryOpen() && !this.character.buildAbility?.isBuildModeActive) {
      if (m.shootJustPressed || (m.interactJustPressed && !this.prompt && !ownedByOthers)) {
        this.shootSlingshot(pos);
        return;
      }
    }

    if (this.fishing.busy && pressed) {
      this.pressFishing();
      return;
    }
    if (keysG && this.prompt?.secondary) this.runAction('treat');
    if (pressed && this.prompt && !ownedByOthers) this.runAction(this.prompt.action);
  }

  /**
   * Whether something here should take E from the shovel: stations, the NPC, finds, or a pet the
   * player is facing up close. Pets sit around the player all the time, so a pet merely nearby
   * must not stop digging.
   */
  public hasActivityForShovel(pos: THREE.Vector3): boolean {
    if (this.fishing.busy || this.panel) return false;
    const facing = this.character.getFacingDirection();
    const p = this.computePrompt(pos, facing, true);
    if (!p) return false;
    if (p.action !== 'pet') return true;
    const pet = this.pets.nearest(pos, 1.7);
    if (!pet) return false;
    const dx = pet.group.position.x - pos.x;
    const dz = pet.group.position.z - pos.z;
    const len = Math.hypot(dx, dz) || 1;
    return (dx * facing.x + dz * facing.z) / len > 0.35;
  }

  private computePrompt(pos: THREE.Vector3, facing: THREE.Vector3, ignoreTools = false): GameplayPrompt | null {
    // The shovel's probe (ignoreTools) asks without changing what the HUD shows
    if (!ignoreTools) this.flowerTarget = null;
    if (this.fishing.busy) return null;
    if (!ignoreTools && (this.character.farmingAbility?.currentPrompt || this.character.gatheringAbility?.currentPrompt)) return null;

    // Chests, cave doorways and beach finds come first: they sit at fixed spots
    if (this.explore?.prompt) return { text: this.explore.prompt.text, key: 'E', action: 'explore' };

    // A bed: sleep through the night (once a night, evenings and early mornings only)
    this.bedInReach = this.findBedNear(pos, BED_REACH);
    if (this.bedInReach) {
      const text = !this.canSleepNow()
        ? t('sleep.tooEarly')
        : this.lastSleepNight === this.nightIndex()
          ? t('sleep.already')
          : t('sleep.go', { time: clockLabel(worldSettings.timeOfDay + SLEEP_HOURS) });
      return { text, key: 'E', action: 'sleep' };
    }

    // Fixed stations win over pets: pets follow the player and would otherwise hijack every prompt
    if (!this.character.telemetry.isSwimming && this.inventory.getEquippedItemId() === 'fishing_rod' && this.fishing.findCastTarget(pos, facing, this.castTarget)) {
      return { text: t('play.cast'), key: 'E', action: 'fish' };
    }
    if (this.storage && this.props.findNearest(STORAGE_CHEST, pos, 2.2)) return { text: t('storage.open'), key: 'E', action: 'storage' };
    if (this.props.findNearest('campfire', pos, 2.6)) return { text: t('play.cook'), key: 'E', action: 'cook' };
    if (this.props.findNearest('mailbox', pos, 2.4)) return { text: t('play.shop'), key: 'E', action: 'shop' };
    if (this.props.findNearest('millstone', pos, 2.4)) {
      const crates = this.inventory.getItemCount('crate_wheat');
      return { text: crates > 0 ? t('play.mill', { n: FLOUR_PER_CRATE, have: crates }) : t('play.millNeed'), key: 'E', action: 'mill' };
    }

    const npc = this.companion;
    if (npc && npc.getPosition(this.tmp).distanceTo(pos) < 2.6) {
      return { text: t(npc.following ? 'npc.stay' : 'npc.follow', { name: npc.name }), key: 'E', action: 'npc' };
    }
    const worker = this.workers?.nearest(pos, 2.4);
    if (worker) {
      if (!ignoreTools) this.promptWorker = worker;
      return { text: t('worker.talk', { name: worker.name }), key: 'E', action: 'worker' };
    }

    // Tulips stand still: they come before the pets, who follow the player everywhere
    const clump = this.flowers?.findPickTarget(pos, facing);
    if (clump) {
      if (!ignoreTools) this.flowerTarget = clump;
      return { text: t('flower.pick'), key: 'E', action: 'flowers' };
    }

    const pet = this.pets.nearest(pos, 2.2);
    if (pet) {
      const hasTreat = this.inventory.hasItem('pet_treat');
      return {
        text: t('play.pet', { name: pet.name }),
        key: 'E',
        action: 'pet',
        secondary: hasTreat ? { text: t('play.treat'), key: 'G', action: 'treat' } : undefined,
      };
    }
    return null;
  }

  private setPrompt(p: GameplayPrompt | null): void {
    const a = this.prompt;
    if (a?.text === p?.text && a?.secondary?.text === p?.secondary?.text) return;
    // No revision bump: the prompt reaches the HUD on its own channel (promptStore), so it flipping
    // on every field edge doesn't push the whole HUD state into App
    this.prompt = p;
  }

  /** Also used by the on-screen buttons. */
  public runAction(action: GameplayPrompt['action'] | 'treat'): void {
    const pos = this.character.getPosition();
    if (action === 'fish' && this.fishing.busy) {
      this.pressFishing();
    } else if (action === 'fish') {
      const facing = this.character.getFacingDirection();
      if (this.fishing.findCastTarget(pos, facing, this.castTarget)) {
        this.fishing.cast(this.rodTip, this.castTarget);
        audioEngine.playBuildSelect();
      }
    } else if (action === 'explore') {
      this.explore?.interact();
      this.promptTimer = 0;
    } else if (action === 'npc' && this.companion) {
      const following = this.companion.toggleFollow();
      audioEngine.at(this.companion.getPosition()).playBuildSelect();
      this.onNotify(t(following ? 'npc.following' : 'npc.waiting', { name: this.companion.name }), 'info');
      this.promptTimer = 0;
    } else if (action === 'worker') {
      const w = this.promptWorker ?? this.workers?.nearest(pos, 2.4);
      if (w && this.workers) {
        const role = this.workers.cycleRole(w);
        audioEngine.at(w.getPosition()).playBuildSelect();
        this.onNotify(t('worker.roleSet', { name: w.name, role: this.workers.roleLabel(role), energy: Math.round(w.energy) }), 'info');
      }
      this.promptTimer = 0;
    } else if (action === 'pet') {
      this.pets.petNearest(pos);
    } else if (action === 'treat') {
      const pet: Pet | null = this.pets.nearest(pos, 2.2);
      if (pet && this.inventory.removeItem('pet_treat', 1)) {
        this.pets.feed(pet);
        this.onNotify(t('play.petHappy', { name: pet.name, n: Math.round(pet.affection) }), 'success');
      }
    } else if (action === 'cook' || action === 'shop' || action === 'storage') {
      this.openPanel(action);
    } else if (action === 'mill') {
      this.grindFlour(pos);
    } else if (action === 'sleep') {
      this.trySleep();
    } else if (action === 'flowers') {
      this.pickFlowers(pos);
    }
    this.revision++;
  }

  /** Pulls up the tulip clump in reach (bare hands) and puts it in the backpack. */
  private pickFlowers(pos: THREE.Vector3): void {
    const clump = this.flowers?.findPickTarget(pos, this.character.getFacingDirection());
    if (!clump || this.character.model?.isActionLocked()) return;
    const dx = clump.position.x - pos.x, dz = clump.position.z - pos.z;
    if (dx * dx + dz * dz > 1e-3) this.character.model?.setFacingAngleInstant(Math.atan2(dx, dz));
    const item = this.flowers!.pick(clump.id);
    if (!item) return;
    this.inventory.addItem(item, 1);
    this.character.model?.triggerPickup();
    this.promptTimer = 0;
  }

  private shootSlingshot(pos: THREE.Vector3): void {
    if (!this.slingshot.ready) return;
    // From the hand, chest high, a little in front of the body
    const aim = this.aim(this.aimTmp).normalize();
    this.muzzle.copy(pos).addScaledVector(this.character.getFacingDirection(), 0.35);
    this.muzzle.y += 0.45;
    // RMB aiming: straight to the crosshair; otherwise a gentle auto-aim at the nearest visible pest
    const yaw = this.character.telemetry.isAiming
      ? this.slingshot.fireAimed(this.muzzle, this.eye(this.eyeTmp), aim)
      : this.slingshot.fire(this.muzzle, aim);
    if (yaw === null) return;
    this.character.model?.setFacingAngleInstant(yaw);
    this.character.model?.triggerWeaponRecoil(1.4);
  }

  /** Millstone: one crate of wheat -> FLOUR_PER_CRATE flour, with a puff of flour dust. */
  private grindFlour(pos: THREE.Vector3): void {
    const mill = this.props.findNearest('millstone', pos, 2.4);
    if (!mill) return;
    if (!this.inventory.removeItem('crate_wheat', 1)) {
      this.onNotify(t('play.millNeed'), 'info');
      return;
    }
    this.inventory.addItem('flour', FLOUR_PER_CRATE);
    audioEngine.at(mill.position).playBuildPlace(false);
    this.particles?.emitBuildPuff(this.tmp.copy(mill.position).setY(mill.position.y + 0.7), false, 22);
    this.character.model?.triggerJumpSquash();
    this.onNotify(t('play.milled', { n: FLOUR_PER_CRATE, name: dataName('item', 'flour', 'Борошно') }), 'success');
    this.promptTimer = 0;
  }

  private pressFishing(): void {
    const fishId = this.fishing.press();
    if (fishId) {
      this.inventory.addItem(fishId, 1);
      const item = this.inventory.getItem(fishId);
      audioEngine.playHarvest();
      this.onNotify(t('play.caught', { name: dataName('item', fishId, item?.name ?? fishId) }), 'success');
    }
    this.revision++;
  }

  public recipeName(recipeId: string): string {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    return dataName('recipe', recipeId, recipe?.name ?? recipeId);
  }

  // ---------------------------------------------------------------- farmhands

  /** Hires a farmhand for WORKER_HIRE_COST coins; it turns up next to the player. */
  public hireWorker(): boolean {
    const crew = this.workers;
    if (!crew) return false;
    if (crew.workers.length >= MAX_WORKERS) {
      this.onNotify(t('worker.full', { n: MAX_WORKERS }), 'warning');
      return false;
    }
    if (this.inventory.getItemCount('coins') < WORKER_HIRE_COST) {
      this.onNotify(t('worker.noCoins', { n: WORKER_HIRE_COST }), 'warning');
      return false;
    }
    const pos = this.character.getPosition();
    const facing = this.character.getFacingDirection();
    const w = crew.spawn(this.tmp.set(pos.x + facing.x * 2, 0, pos.z + facing.z * 2));
    if (!w) return false;
    this.inventory.removeItem('coins', WORKER_HIRE_COST);
    audioEngine.playBuildSelect();
    this.onNotify(t('worker.hired', { name: w.name }), 'success');
    this.revision++;
    return true;
  }

  /** Lets a farmhand go (no refund). */
  public dismissWorker(id: number): void {
    const w = this.workers?.byId(id);
    if (!w || !this.workers) return;
    if (this.promptWorker === w) this.promptWorker = null;
    this.workers.remove(w);
    this.onNotify(t('worker.dismissed', { name: w.name }), 'info');
    this.revision++;
  }

  // ---------------------------------------------------------------- storage chest

  /** Backpack -> chest (up to `n`); returns how many went in. */
  public storeItem(itemId: string, n: number): number {
    const st = this.storage;
    if (!st) return 0;
    const have = this.inventory.getItemCount(itemId);
    const moved = st.put(itemId, Math.min(n, have));
    if (moved > 0) this.inventory.removeItem(itemId, moved);
    return moved;
  }

  /** Chest -> backpack (up to `n`, as much as the stack in the backpack holds). */
  public takeItem(itemId: string, n: number): number {
    const st = this.storage;
    const item = this.inventory.getItem(itemId);
    if (!st || !item) return 0;
    const room = item.maxStack - item.count;
    const moved = Math.min(n, st.count(itemId), room);
    if (moved <= 0) return 0;
    st.take(itemId, moved);
    this.inventory.addItem(itemId, moved);
    return moved;
  }

  /** Everything the workers use from the backpack into the chest: cooked dishes and crop seeds. */
  public storeForWorkers(): number {
    let n = 0;
    for (const id of [...DISH_ORDER, ...CROP_TYPES.map((c) => CROP_DEFINITIONS[c].seedItemId)]) {
      const have = this.inventory.getItemCount(id);
      if (have > 0) n += this.storeItem(id, have);
    }
    return n;
  }

  /** Everything the workers brought (crops, wood, stone...) into the backpack. */
  public takeYield(): number {
    let n = 0;
    for (const { itemId, amount } of this.storage?.list() ?? []) {
      const cat = this.inventory.getItem(itemId)?.category;
      if (cat === 'crops' || cat === 'materials') n += this.takeItem(itemId, amount);
    }
    return n;
  }

  public openPanel(panel: GameplayPanel): void {
    this.panel = panel;
    this.revision++;
  }

  // ---------------------------------------------------------------- cooking

  /** Recipes found on the island (locked ones start unknown). */
  public readonly knownRecipes = new Set<string>();

  public isRecipeKnown(recipe: Recipe): boolean {
    return !recipe.locked || this.knownRecipes.has(recipe.id);
  }

  public countIngredient(itemId: string): number {
    if (itemId === 'fish_any') return FISH_IDS.reduce((s, id) => s + this.inventory.getItemCount(id), 0);
    if (itemId === 'fish_sea_any') return SEA_FISH_IDS.reduce((s, id) => s + this.inventory.getItemCount(id), 0);
    return this.inventory.getItemCount(itemId);
  }

  public canCook(recipe: Recipe): boolean {
    return !this.cookingJob && this.isRecipeKnown(recipe) && recipe.ingredients.every((i) => this.countIngredient(i.itemId) >= i.count);
  }

  public cook(recipeId: string): void {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (!recipe || !this.canCook(recipe)) return;
    for (const ing of recipe.ingredients) {
      if (ing.itemId === 'fish_any' || ing.itemId === 'fish_sea_any') {
        let left = ing.count;
        // Use the cheapest fish first
        for (const id of ing.itemId === 'fish_any' ? FISH_IDS : SEA_FISH_IDS) {
          while (left > 0 && this.inventory.removeItem(id, 1)) left--;
        }
      } else {
        this.inventory.removeItem(ing.itemId, ing.count);
      }
    }
    this.cookingJob = { recipe, remaining: recipe.seconds };
    audioEngine.playBuildSelect();
    this.revision++;
  }

  private updateCooking(dt: number): void {
    if (!this.cookingJob) return;
    this.cookingJob.remaining -= dt;
    if (this.cookingJob.remaining <= 0) {
      const { recipe } = this.cookingJob;
      this.cookingJob = null;
      this.inventory.addItem(recipe.dishId, 1);
      audioEngine.playHarvest();
      this.onNotify(t('play.cooked', { name: dataName('recipe', recipe.id, recipe.name) }), 'success');
    }
    this.revision++;
  }

  // ---------------------------------------------------------------- food buff

  public eat(dishId: string): void {
    const buff = DISH_BUFF[dishId];
    if (!buff || !this.inventory.removeItem(dishId, 1)) return;
    if (!this.baseSpeeds) this.baseSpeeds = { walk: this.character.walkSpeed, sprint: this.character.sprintSpeed };
    this.buff = { dishId, remaining: buff.seconds, speed: buff.speed };
    this.character.walkSpeed = this.baseSpeeds.walk * buff.speed;
    this.character.sprintSpeed = this.baseSpeeds.sprint * buff.speed;
    this.onNotify(t('play.ate', { pct: Math.round((buff.speed - 1) * 100), s: buff.seconds }), 'success');
    this.revision++;
  }

  private updateBuff(dt: number): void {
    if (!this.buff) return;
    this.buff.remaining -= dt;
    if (this.buff.remaining <= 0 && this.baseSpeeds) {
      this.character.walkSpeed = this.baseSpeeds.walk;
      this.character.sprintSpeed = this.baseSpeeds.sprint;
      this.buff = null;
      this.revision++;
    }
  }

  // ---------------------------------------------------------------- shop

  public sell(itemId: string, amount: number): void {
    const item = this.inventory.getItem(itemId);
    if (!item?.sellPrice) return;
    const n = Math.min(amount, item.count);
    if (n <= 0 || !this.inventory.removeItem(itemId, n)) return;
    this.inventory.addItem('coins', n * item.sellPrice);
    audioEngine.playHarvest();
    this.revision++;
  }

  public buy(itemId: string, amount: number): void {
    const item = this.inventory.getItem(itemId);
    if (!item?.buyPrice) return;
    const cost = item.buyPrice * amount;
    if (!this.inventory.removeItem('coins', cost)) {
      this.onNotify(t('play.noCoins'), 'warning');
      return;
    }
    this.inventory.addItem(itemId, amount);
    audioEngine.playBuildSelect();
    this.revision++;
  }

  // ---------------------------------------------------------------- HUD

  public getHudState(): GameplayHudState {
    const f = this.fishing.state;
    return {
      // No prompt here: it reaches the HUD through promptStore (it changes on every field edge)
      fishing: f.phase === 'idle' ? null : { ...f },
      panel: this.panel,
      cooking: this.cookingJob
        ? { recipeId: this.cookingJob.recipe.id, progress: 1 - this.cookingJob.remaining / this.cookingJob.recipe.seconds }
        : null,
      buff: this.buff
        ? { label: dataName('item', this.buff.dishId, this.inventory.getItem(this.buff.dishId)?.name ?? ''), secondsLeft: Math.ceil(this.buff.remaining) }
        : null,
      weather: this.weather.weather,
      season: currentSeason(),
      seasonDay: dayOfSeason(),
      isNight: this.weather.isNight(),
      coins: this.inventory.getItemCount('coins'),
      pets: this.pets.pets.map((p) => ({ name: p.name, kind: p.kind, affection: Math.round(p.affection) })),
      fading: !!this.explore?.fading || this.sleepDark,
      inCave: !!this.explore?.inCave,
      sleeping: this.sleepDark,
      respawnAt: this.respawnTarget(this.tmp).atBed ? 'bed' : 'spawn',
    };
  }

  /** The night overlay is up (asleep, before the morning fades in). */
  private get sleepDark(): boolean {
    return !!this.sleep && this.sleep.t < SLEEP_FADE_IN;
  }

  public get hudKey(): string {
    // Cheap change detector for throttled HUD pushes
    return `${this.revision}|${this.fishing.revision}|${this.explore?.fading}|${this.explore?.inCave}|${this.weather.weather}|${getLang()}|${this.sleepDark}`;
  }

  public dispose(): void {
    this.slingshot.dispose();
    this.tmp.set(0, 0, 0);
  }
}
