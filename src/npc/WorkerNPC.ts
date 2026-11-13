import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { GridNavigator } from '../navigation/GridNavigator';
import { audioEngine } from '../audio/AudioEngine';
import { DoorControl, NPCAgent } from './NPCAgent';
import { FarmTask, Items, TaskBoard, TaskKind, WorkerRole } from './TaskBoard';

/** A sleeping place: where the body lies and the walkable spot beside it to walk up to. */
export interface BedSpot {
  /** Bed piece id + slot (a double bed has two). */
  key: string;
  /** Middle of the lying body (the model's origin, world). */
  lie: THREE.Vector3;
  /** Yaw so the head points at the headboard. */
  yaw: number;
  /** Walkable ground next to the bed (feet level). */
  stand: { x: number; y: number; z: number };
}

export type WorkerActivity = 'work' | 'rest' | 'leisure' | 'toBed' | 'sleep';

/** A trip to a chest: seeds for a sowing job, unloading the yield, or a meal. */
export type WorkerErrand = 'fetch' | 'deliver' | 'eat';

/** Daily schedule (in-game hours). */
export const WORKER_SCHEDULE = {
  /** Wakes from here, if rested enough. */
  wake: 6,
  /** Works between these hours: from getting up to bedtime (no free time; a day off is the role). */
  workFrom: 6,
  workUntil: 21,
  /** Goes to bed from here. */
  sleep: 21,
};

/** Energy change per in-game hour (energy is 0..100). */
const ENERGY_RATE: Record<WorkerActivity, number> = {
  work: -6,
  rest: -1,
  leisure: -2.5,
  toBed: -2,
  sleep: 13,
};
/** Satiety change per in-game hour (0..100): a full worker gets hungry after a working day. */
const HUNGER_RATE: Record<WorkerActivity, number> = {
  work: -6,
  rest: -3,
  leisure: -3,
  toBed: -2,
  sleep: -1.5,
};
/** How filling each dish is (satiety points). */
export const DISH_FOOD: Record<string, number> = {
  dish_bread: 35,
  dish_grilled_fish: 45,
  dish_salad: 45,
  dish_soup: 60,
  dish_mushroom_stew: 65,
  dish_fish_stew: 70,
  dish_seafood_platter: 80,
};
/** Cheapest first: a worker eats what it finds in this order. */
export const DISH_ORDER = Object.keys(DISH_FOOD);
/** Goes for a meal below this (and has a second dish while still below it)... */
export const HUNGRY = 40;
/** ...and works at half speed below this. */
export const STARVING = 15;

/** Sleeping on the ground restores this share of a bed's rate. */
const GROUND_SLEEP = 0.6;
/** Below this it drops everything and goes for a nap... */
const EXHAUSTED = 12;
/** ...which lasts until this much is back. */
const NAP_UNTIL = 60;
/** Mornings: wakes only with at least this much (otherwise sleeps in). */
const WAKE_MIN = 50;
/** Stops working below this and rests instead. */
const TIRED = 25;

const THINK_INTERVAL = 0.5;
/** The idle clip plays this long after lying down, then the pose holds (s). */
const SLEEP_POSE_BLEND = 0.5;
const WORK_RADIUS = 7;
const LEISURE_RADIUS = 4.5;
/** Walking speeds (m/s): an unhurried farm pace, a stroll in free time. */
const WORK_SPEED = 2.8;
const LEISURE_SPEED = 2.0;
/** Gives up walking to bed after this long (s): teleports when unseen, otherwise sleeps on the spot. */
const ROUTE_GIVE_UP = 40;
/** Feet this close in height to a trip's standing spot are on its floor (an upper storey is ~2 m up). */
const SAME_FLOOR = 1.0;
/** Drops a work / leisure spot it could not reach in this long (s). */
const SPOT_GIVE_UP = 15;
/** Walking to a farm job or a chest may take longer than to a spot in the yard (s). */
const TASK_GIVE_UP = 60;
/** How long each field job takes on the spot (s, at full speed). */
const TASK_TIME: Record<'water' | 'harvest' | 'plant', number> = { water: 6, harvest: 5, plant: 7 };
/** Between axe / pickaxe blows (s, at full speed). */
const SWING_INTERVAL = 2.2;
/** The blow lands this long after the swing starts (matches the CHOP / MINE clips). */
const IMPACT_DELAY = 0.3;
/**
 * Apples: the first pick-up once they landed (s); stops looking for more after this long (s) when
 * none is left in reach; picks up what lies this close around it (m).
 */
const APPLE_FIRST_SWEEP = 1.6;
const APPLE_SETTLE = 3.5;
const APPLE_GATHER_MAX = 40;
const APPLE_REACH = 2;
/** A felled tree's wood comes when its top is gone; waits for it at most this long (s). */
const YIELD_WAIT = 15;
/** Unloading / taking seeds at a chest (s); one meal (s). */
const CHEST_TIME = 1.6;
const MEAL_TIME = 4;
/** Close enough to a chest to use it (m, to its centre). */
const CHEST_REACH = 1.8;
/** Gives up after standing this long without a route (s). */
const NO_ROUTE_GIVE_UP = 3;
/** Name tags show within this distance of the player (m). */
const TAG_DIST = 28;

/** Tag icon per task / errand / activity (free time: just the name). */
const TASK_ICON: Record<TaskKind, string> = { water: '💧', harvest: '🌾', plant: '🌱', chop: '🪓', mine: '⛏️' };
const ERRAND_ICON: Record<WorkerErrand, string> = { fetch: '🌱', deliver: '📦', eat: '🍲' };
const ACTIVITY_ICON: Record<WorkerActivity, string> = { work: '🧺', rest: '☕', leisure: '', toBed: '🌙', sleep: '💤' };

let zzzTexture: THREE.CanvasTexture | null = null;
function getZzzTexture(): THREE.CanvasTexture {
  if (zzzTexture) return zzzTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.font = 'bold 30px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(30,40,70,0.85)';
  g.fillStyle = '#ffffff';
  g.strokeText('z', 22, 42);
  g.fillText('z', 22, 42);
  g.font = 'bold 22px sans-serif';
  g.strokeText('z', 44, 20);
  g.fillText('z', 44, 20);
  zzzTexture = new THREE.CanvasTexture(c);
  zzzTexture.colorSpace = THREE.SRGBColorSpace;
  return zzzTexture;
}

/** Walkable spot next to each chest ("x,z" of the chest), shared by the crew; cleared with the nav cache. */
export const CHEST_STANDS = new Map<string, THREE.Vector3 | null>();

/** What a worker carries in its arms (one shared box, tinted by the load). */
const CARRY_GEO = new THREE.BoxGeometry(0.42, 0.3, 0.32);
const CARRY_MAT = {
  crate: new THREE.MeshLambertMaterial({ color: 0xb98a52 }),
  wood: new THREE.MeshLambertMaterial({ color: 0x7a5232 }),
  stone: new THREE.MeshLambertMaterial({ color: 0x8f8a84 }),
  seeds: new THREE.MeshLambertMaterial({ color: 0xd8c08a }),
};

/** Filled rounded rectangle (plain one on browsers without `roundRect`, older phones). */
function pill(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
  g.fill();
}

/** Name tag: a small sprite above the head, redrawn only when its text changes. */
class NameTag {
  public readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private text = '';

  constructor(private readonly name: string, private readonly tint: number) {
    this.canvas.width = 256;
    this.canvas.height = 64;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, depthWrite: false, transparent: true }));
    this.sprite.scale.set(2, 0.5, 1);
    this.sprite.renderOrder = 5;
  }

  public set(icon: string, hungry: boolean): void {
    const text = `${icon}|${hungry ? 1 : 0}`;
    if (text === this.text) return;
    this.text = text;
    const g = this.canvas.getContext('2d')!;
    g.clearRect(0, 0, 256, 64);
    g.font = 'bold 26px sans-serif';
    const label = `${icon ? `${icon} ` : ''}${this.name}${hungry ? ' 🍽️' : ''}`;
    const w = Math.min(248, g.measureText(label).width + 30);
    const x = (256 - w) / 2;
    g.fillStyle = 'rgba(40,30,20,0.62)';
    pill(g, x, 12, w, 42, 21);
    // A stripe of the worker's colour (the same as its dot in the panel)
    g.fillStyle = `#${this.tint.toString(16).padStart(6, '0')}`;
    pill(g, x + 10, 47, w - 20, 4, 2);
    g.fillStyle = hungry ? '#ffd0c0' : '#fffaf0';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 128, 32, 240);
    this.texture.needsUpdate = true;
  }

  public dispose(): void {
    this.texture.dispose();
    this.sprite.material.dispose();
  }
}

/**
 * A farmhand with needs and a daily routine. Energy drains while awake (faster at work) and comes
 * back in bed; satiety drains all day and comes back with a meal from the storage chest (hungry
 * workers work slower). In work hours it takes jobs from the board: field jobs on the spot, trees
 * and rocks blow by blow; seeds come from a chest and the yield goes back to one. Decisions run
 * every THINK_INTERVAL, not per frame.
 */
export class WorkerNPC extends NPCAgent {
  public energy: number;
  /** Satiety 0..100. */
  public food = 80 + Math.random() * 20;
  public activity: WorkerActivity = 'leisure';
  /** Where it lives without a bed, and the centre of its free time (feet level). */
  public readonly home: THREE.Vector3;
  /** Centre of the work area (feet level). */
  public workCenter: THREE.Vector3;
  /** Assigned by WorkerManager; null sleeps on the ground at home. */
  public bed: BedSpot | null = null;
  /** Which jobs it takes from the board. */
  public role: WorkerRole = 'all';
  /** Shared job list (set by WorkerManager); without it work is just pottering around the yard. */
  public board: TaskBoard | null = null;
  /** Nearest storage chest (set by WorkerManager). */
  public findChest: ((from: THREE.Vector3) => THREE.Vector3 | null) | null = null;
  /** Hungry with nothing to eat in the chests (WorkerManager tells the player). */
  public onNoFood: (() => void) | null = null;
  /** The job it is walking to or doing. */
  public task: FarmTask | null = null;
  /** Trip to a chest under way. */
  public errand: WorkerErrand | null = null;
  /** The yield it is taking to a chest. */
  public carry: Items = [];
  /** Seeds taken for the sowing job. */
  public seeds: { itemId: string; amount: number } | null = null;
  /** Bed key it had in a loaded save (claimed on the next bed assignment). */
  public preferredBed: string | null = null;
  /** Name / colour slot (set by WorkerManager). */
  public slot = 0;
  /** Jobs finished since it was hired. */
  public jobsDone = 0;

  /** Daytime nap (wakes at NAP_UNTIL instead of with the morning). */
  private napping = false;
  private target: THREE.Vector3 | null = null;
  /** What `target` is for: arrival is measured to this point (a field, trunk or chest centre). */
  private aim: THREE.Vector3 | null = null;
  private reach = 0.5;
  private targetSpeed = WORK_SPEED;
  /** Seconds to stay at the reached target before picking the next. */
  private dwell = 0;
  private stoopTimer = 0;
  private routeTime = 0;
  private noRouteTime = 0;
  private thinkTimer: number;
  private sleepingInBed = false;
  /** Restored asleep from a save, waiting for its bed. */
  private bedOnLoad = false;
  /** Seconds of the idle clip played since lying down (then the pose is frozen). */
  private sleepPoseTime = 0;
  /** Seconds left of doing the job / errand on the spot (0 = walking / idle). */
  private doing = 0;
  /** Trees / rocks: next blow in (s), the blow landing in (s), waiting for the felled tree's wood (s). */
  private swingTimer = 0;
  private impactIn = -1;
  private yieldWait = -1;
  /** Apple tree: picking up the fallen apples (s since it began, -1 when not) and the next sweep in (s). */
  private gatherT = -1;
  private gatherTick = 0;
  /** Meals eaten this visit to the chest. */
  private meals = 0;
  private readonly zzz: THREE.Sprite;
  private zzzPhase = Math.random() * 10;
  private readonly tag: NameTag;
  private readonly carryMesh: THREE.Mesh;

  private static readonly _p = new THREE.Vector3();
  private static readonly _d = new THREE.Vector3();

  constructor(
    physics: PhysicsWorld,
    scene: THREE.Scene,
    nav: GridNavigator,
    spawn: THREE.Vector3,
    name: string,
    doors: DoorControl | null,
    color: number,
    /** 0..1: spreads the thinking of a crowd over different frames. */
    stagger: number,
    /** Unique id (job claims). */
    public readonly id: number
  ) {
    super(physics, scene, nav, spawn, name, doors, color);
    // Trips stay around the farm; a long search would only mean the spot is unreachable. Long
    // walks (to the forest) are planned in small, spaced-out pieces: no frame spikes on phones
    this.planNodes = 1000;
    this.planSamples = 60;
    this.partialRetry = 0.3;
    this.home = spawn.clone();
    this.workCenter = spawn.clone();
    this.energy = 70 + Math.random() * 25;
    this.thinkTimer = stagger * THINK_INTERVAL;
    this.model.group.rotation.order = 'YXZ';
    this.zzz = new THREE.Sprite(new THREE.SpriteMaterial({ map: getZzzTexture(), depthWrite: false, transparent: true }));
    this.zzz.scale.setScalar(0.55);
    this.zzz.visible = false;
    this.tag = new NameTag(name, color);
    this.tag.sprite.visible = false;
    this.carryMesh = new THREE.Mesh(CARRY_GEO, CARRY_MAT.crate);
    this.carryMesh.position.set(0, -0.02, 0.34);
    this.carryMesh.visible = false;
    this.model.group.add(this.carryMesh);
    scene.add(this.zzz, this.tag.sprite);
  }

  public get asleep(): boolean {
    return this.activity === 'sleep';
  }

  /** Work speed: hungry workers are slower (1 fed, 0.75 hungry, 0.5 starving). */
  public get pace(): number {
    return this.food < STARVING ? 0.5 : this.food < HUNGRY ? 0.75 : 1;
  }

  /**
   * `dt` may be several frames at once (far workers update less often); `hours` is the in-game
   * time that passed in it.
   */
  public update(dt: number, player: THREE.Vector3, hour: number, hours: number): void {
    const rate = ENERGY_RATE[this.activity] * (this.activity === 'sleep' && !this.sleepingInBed ? GROUND_SLEEP : 1);
    this.energy = THREE.MathUtils.clamp(this.energy + rate * hours, 0, 100);
    this.food = THREE.MathUtils.clamp(this.food + HUNGER_RATE[this.activity] * hours, 0, 100);

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer += THINK_INTERVAL;
      if (this.thinkTimer < 0) this.thinkTimer = THINK_INTERVAL;
      this.think(hour);
    }

    if (this.activity === 'sleep') {
      this.tag.sprite.visible = false;
      this.updateSleeping(dt);
      return;
    }
    this.updateTag(player);

    const feet = this.getFeet(WorkerNPC._p);
    let goal: THREE.Vector3 | null = null;
    // Finishes bending down / pouring / swinging before it walks off (no pick-up on the move)
    if (this.target && this.model.isActionLocked()) {
      this.drive(dt, null, 0, player);
      return;
    }
    if (this.target) {
      const aim = this.aim ?? this.target;
      // Height matters too: standing right under a bed upstairs is not being at it. Checked against
      // the target (a standing spot on the floor), not the aim (a chest, a crop: not at feet level)
      const sameFloor = Math.abs(this.target.y - feet.y) < SAME_FLOOR;
      const d = sameFloor ? Math.hypot(aim.x - feet.x, aim.z - feet.z) : Infinity;
      // Stuck close by also counts, unless a wall stands in between (it would sleep / work through it)
      const arrived =
        d < this.reach || (this.pathDone && d < this.reach + 1.2 && this.stuckTime > 0.3 && this.lineClear(feet, this.target));
      this.routeTime += dt;
      // Standing with no route left while still far: there is no way there
      this.noRouteTime = this.pathDone && !arrived && this.speed < 0.1 ? this.noRouteTime + dt : 0;
      const hopeless = this.noRouteTime > NO_ROUTE_GIVE_UP;
      const longTrip = this.task || this.errand;
      if (this.activity !== 'toBed' && (hopeless || this.routeTime > (longTrip ? TASK_GIVE_UP : SPOT_GIVE_UP))) {
        // No way there (water, walls): forget it, the next think picks another spot / job
        this.giveUpTrip();
      } else if (this.activity === 'toBed') {
        if (arrived || hopeless || this.routeTime > ROUTE_GIVE_UP) {
          const seen = Math.hypot(player.x - feet.x, player.z - feet.z) < 25;
          if (!arrived && !seen) this.placeAt(this.target);
          this.fallAsleep(arrived || !seen);
          return;
        }
        goal = this.target;
      } else if (arrived) {
        // Brakes to a stop first: the job / chest animation never starts while still sliding
        if (this.speed > 0.3) {
          this.drive(dt, null, 0, player);
          return;
        }
        this.target = null;
        this.aim = null;
        if (this.errand) this.startErrand();
        else if (this.gatherT >= 0) this.gatherTick = 0.2; // at a rolled-away apple: pick it up
        else if (this.task) this.startTask(this.task);
      } else {
        goal = this.target;
      }
    } else if (this.doing > 0 || this.impactIn >= 0 || this.yieldWait >= 0) {
      this.updateDoing(dt);
      const look = this.task && !this.errand ? this.task.pos : null;
      this.drive(dt, null, 0, player, look);
      return;
    } else if (this.dwell > 0) {
      this.dwell -= dt;
      if (this.activity === 'work' && !this.task) {
        this.stoopTimer -= dt;
        if (this.stoopTimer <= 0 && this.dwell > 1.5) {
          this.stoopTimer = 3 + Math.random() * 2;
          this.model.triggerPickup();
        }
      }
    }
    this.drive(dt, goal, this.targetSpeed * (this.task || this.errand ? 0.85 + 0.15 * this.pace : 1), player);
  }

  private updateTag(player: THREE.Vector3): void {
    const g = this.model.group.position;
    const near = Math.hypot(g.x - player.x, g.z - player.z) < TAG_DIST;
    this.tag.sprite.visible = near;
    if (!near) return;
    this.tag.sprite.position.set(g.x, g.y + 1.2, g.z);
    const icon = this.errand
      ? ERRAND_ICON[this.errand]
      : this.task && this.activity === 'work'
        ? this.task.apple ? '🍎' : TASK_ICON[this.task.kind]
        : ACTIVITY_ICON[this.activity];
    this.tag.set(icon, this.food < HUNGRY);
  }

  /** Picks the activity for the hour and the current energy and hunger. */
  private think(hour: number): void {
    const s = WORKER_SCHEDULE;
    const night = hour >= s.sleep || hour < s.wake;
    if (this.activity === 'sleep') {
      if (!night && this.energy >= (this.napping ? NAP_UNTIL : WAKE_MIN)) this.wakeUp();
      return;
    }
    if (this.activity === 'toBed') return;
    if (night || this.energy < EXHAUSTED) {
      this.dropTask();
      this.endErrand();
      this.napping = !night;
      this.goToBed();
      return;
    }
    const workHours = hour >= s.workFrom && hour < s.workUntil && this.role !== 'off';
    const want: WorkerActivity = workHours ? (this.energy >= TIRED ? 'work' : 'rest') : 'leisure';
    if (want !== this.activity) {
      if (want !== 'work') this.dropTask();
      this.activity = want;
      if (!this.errand) {
        this.target = null;
        this.dwell = 0;
      }
    }
    if (this.busy) return;

    // Hungry: a meal from the chest comes first (anything carried goes in on the same trip)
    if (this.food < HUNGRY && !this.task) {
      if (this.board && this.findChest && DISH_ORDER.some((d) => this.board!.store.count(d) > 0)) {
        if (this.goToChest('eat')) return;
      } else {
        this.onNoFood?.();
      }
    }
    // Arms full: to the chest
    if (this.carry.length && !this.task) {
      this.goToChest('deliver');
      return;
    }

    if (this.task) {
      // The player (or the rain) did it meanwhile, or the field / tree is gone
      if (this.board && !this.board.isValid(this.task)) {
        this.dropTask();
        this.target = null;
      }
      return;
    }
    // Also while pottering about: a job that turns up takes over from wandering
    if (this.activity === 'work' && this.board) {
      const task = this.board.claim(this.id, this.role, this.getFeet(WorkerNPC._p));
      if (task) {
        this.task = task;
        this.dwell = 0;
        // Seeds first, from the chest
        if (task.kind === 'plant' && !this.seeds) {
          if (!this.goToChest('fetch')) this.dropTask(true);
        } else {
          this.walkToTask(task);
        }
        return;
      }
    }
    if (!this.target && this.dwell <= 0) this.pickSpot();
  }

  /** In the middle of something on the spot or on the way to a chest. */
  private get busy(): boolean {
    return this.errand !== null || this.doing > 0 || this.impactIn >= 0 || this.yieldWait >= 0;
  }

  /** Next place to walk to within the activity's area. */
  private pickSpot(): void {
    const work = this.activity === 'work';
    const centre = work ? this.workCenter : this.home;
    const r = work ? WORK_RADIUS : this.activity === 'rest' ? 2 : LEISURE_RADIUS;
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * r;
    const spot = this.nav.snap(centre.x + Math.cos(a) * d, centre.z + Math.sin(a) * d, centre.y);
    // Not walkable, or the top of a bed / table / well: try again on the next think
    if (!spot || Math.abs(spot.y - centre.y) > 0.6) return;
    this.setTrip(new THREE.Vector3(spot.x, spot.y, spot.z), null, 0.5, work ? WORK_SPEED : LEISURE_SPEED);
    this.dwell = work ? 5 + Math.random() * 5 : this.activity === 'rest' ? 8 + Math.random() * 8 : 3 + Math.random() * 7;
    this.stoopTimer = 0.6;
  }

  private setTrip(target: THREE.Vector3, aim: THREE.Vector3 | null, reach: number, speed = WORK_SPEED): void {
    this.target = target;
    this.aim = aim;
    this.reach = reach;
    this.targetSpeed = speed;
    this.routeTime = 0;
    this.noRouteTime = 0;
  }

  private walkToTask(task: FarmTask): void {
    const spot = this.nav.snap(task.stand.x, task.stand.z, task.stand.y) ?? this.nav.nearestWalkable(task.stand, 3);
    const target = spot ? new THREE.Vector3(spot.x, spot.y, spot.z) : task.stand.clone();
    this.setTrip(target, task.pos, task.reach);
  }

  /** Starts a trip to the nearest chest; false when the farm has none. */
  private goToChest(errand: WorkerErrand): boolean {
    const chest = this.findChest?.(this.getFeet(WorkerNPC._p));
    if (!chest) {
      // No chest: the yield goes straight to the player's backpack
      if (errand === 'deliver') this.unload();
      return false;
    }
    this.errand = errand;
    this.meals = 0;
    this.dwell = 0;
    // Where to stand by it: found once per chest (a ground search is too slow to repeat every trip)
    const key = `${chest.x.toFixed(1)},${chest.z.toFixed(1)}`;
    let stand = CHEST_STANDS.get(key);
    if (stand === undefined) {
      const spot = this.nav.nearestWalkable(chest, 3);
      stand = spot ? new THREE.Vector3(spot.x, spot.y, spot.z) : null;
      CHEST_STANDS.set(key, stand);
    }
    this.setTrip(stand ? stand.clone() : chest.clone(), chest.clone(), CHEST_REACH);
    return true;
  }

  /** Arrived at the chest. */
  private startErrand(): void {
    this.model.triggerPickup();
    if (this.errand === 'eat') {
      const dish = this.board ? DISH_ORDER.find((d) => this.board!.store.count(d) > 0) : undefined;
      if (!dish || !this.board!.store.take(dish, 1)) {
        this.endErrand();
        return;
      }
      this.pendingMeal = dish;
      this.doing = MEAL_TIME;
    } else {
      this.doing = CHEST_TIME;
    }
    // Anything carried goes in right away (whatever the trip was for)
    this.unload();
  }

  private pendingMeal: string | null = null;

  /** Done at the chest. */
  private finishErrand(): void {
    const errand = this.errand;
    if (errand === 'eat' && this.pendingMeal) {
      this.food = Math.min(100, this.food + (DISH_FOOD[this.pendingMeal] ?? 30));
      this.pendingMeal = null;
      this.meals++;
      // Still hungry after a small dish: one more, if there is one (the others need theirs too)
      const more = this.food < HUNGRY && this.meals < 3 && this.board ? DISH_ORDER.find((d) => this.board!.store.count(d) > 0) : undefined;
      if (more && this.board!.store.take(more, 1)) {
        this.pendingMeal = more;
        this.doing = MEAL_TIME;
        this.model.triggerPickup();
        return;
      }
    }
    this.errand = null;
    if (errand === 'fetch' && this.task) {
      this.seeds = this.board?.takeSeeds() ?? null;
      if (this.seeds) {
        this.showCarry();
        this.walkToTask(this.task);
      } else {
        this.dropTask();
      }
      return;
    }
    this.dwell = 1 + Math.random();
  }

  private endErrand(): void {
    if (this.errand === 'eat' && this.pendingMeal) {
      // Interrupted mid-meal: it was eaten anyway
      this.food = Math.min(100, this.food + (DISH_FOOD[this.pendingMeal] ?? 30));
      this.pendingMeal = null;
    }
    if (this.errand) {
      this.errand = null;
      this.doing = 0;
      this.target = null;
      this.aim = null;
    }
  }

  /** Puts what it carries into the store (the backpack without a chest). */
  private unload(): void {
    if (this.carry.length && this.board) this.board.store.put(this.carry);
    this.carry = [];
    this.showCarry();
  }

  /** The trip failed (no way there): the job or the errand is dropped. */
  private giveUpTrip(): void {
    if (this.task && this.gatherT >= 0) {
      // An apple it could not get to: the job ends with what it has picked up
      this.target = null;
      this.aim = null;
      this.finishNatureTask(this.task);
      return;
    }
    if (this.errand) {
      // Can't reach the chest: hand over what it carries anyway, and try again later
      if (this.errand === 'deliver') this.unload();
      this.errand = null;
      if (this.task) this.dropTask(true);
    } else if (this.task) {
      this.dropTask(true);
    }
    this.target = null;
    this.aim = null;
    this.dwell = 0;
  }

  private startTask(task: FarmTask): void {
    if (task.kind === 'chop' || task.kind === 'mine' || task.apple) {
      // An apple tree is shaken with bare hands (a shove at the trunk), no tool
      this.model.equipToolOrProp(task.apple ? null : task.kind === 'mine' ? 'pickaxe' : 'axe');
      this.swingTimer = 0.4;
      this.doing = 1;
      return;
    }
    this.doing = TASK_TIME[task.kind] / this.pace;
    if (task.kind === 'water') {
      this.model.equipToolOrProp('watering_can');
      this.model.triggerWatering(Math.min(this.doing, 6));
    } else {
      this.model.triggerPickup();
    }
  }

  /** Doing the job / errand on the spot. */
  private updateDoing(dt: number): void {
    if (this.errand) {
      this.doing -= dt;
      if (this.doing <= 0) {
        this.doing = 0;
        this.finishErrand();
      }
      return;
    }
    const task = this.task;
    if (!task) {
      this.doing = 0;
      this.impactIn = -1;
      this.yieldWait = -1;
      this.gatherT = -1;
      return;
    }
    if (task.kind === 'chop' || task.kind === 'mine' || task.apple) {
      this.updateSwinging(dt, task);
      return;
    }
    this.doing -= dt;
    // Planting: bend down now and then
    if (task.kind === 'plant' && this.doing > 1 && (this.doing % 2.5) < dt) this.model.triggerPickup();
    if (this.doing <= 0) this.finishTask();
  }

  /** Adds to what it carries (one entry per item). */
  private addCarry(items: Items): void {
    for (const it of items) {
      const have = this.carry.find((c) => c.itemId === it.itemId);
      if (have) have.amount += it.amount;
      else this.carry.push({ ...it });
    }
    if (this.carry.length) this.showCarry();
  }

  private updateSwinging(dt: number, task: FarmTask): void {
    if (this.gatherT >= 0) {
      // The apples are down: picks up what lies in reach, then walks to the ones that rolled away
      this.gatherT += dt;
      this.gatherTick -= dt;
      if (this.gatherTick > 0) return;
      this.gatherTick = 1.1;
      const board = this.board;
      if (!board) return this.finishNatureTask(task);
      const feet = this.getFeet(WorkerNPC._p);
      const n = board.gatherApples(feet, APPLE_REACH, () => this.model.group.position, (items) => this.addCarry(items));
      if (n) {
        this.model.triggerPickup();
        return;
      }
      const next = this.gatherT < APPLE_GATHER_MAX ? board.nearestApple(task, feet) : null;
      if (next) {
        const spot = this.nav.snap(next.x, next.z, next.y);
        this.setTrip(spot ? new THREE.Vector3(spot.x, spot.y, spot.z) : next.clone(), next, APPLE_REACH * 0.7);
        return;
      }
      // Nothing left in sight once they had time to roll to a stop: done
      if (this.gatherT > APPLE_SETTLE) this.finishNatureTask(task);
      return;
    }
    if (this.yieldWait >= 0) {
      // The tree is down: wait for its top to settle (the wood comes through the sink)
      this.yieldWait -= dt;
      if (this.yieldWait < 0 || this.carry.length) this.finishNatureTask(task);
      return;
    }
    if (this.impactIn >= 0) {
      this.impactIn -= dt;
      if (this.impactIn >= 0) return;
      const feet = this.getFeet(WorkerNPC._p);
      const dir = WorkerNPC._d.set(task.pos.x - feet.x, 0, task.pos.z - feet.z);
      if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
      dir.normalize();
      const res = this.board?.strike(task, dir.clone(), (items) => this.addCarry(items)) ?? 'gone';
      if (res === 'gone') {
        this.finishNatureTask(task);
      } else if (res === 'felled' && task.apple) {
        this.jobsDone++;
        this.model.equipToolOrProp(null);
        this.gatherT = 0;
        this.gatherTick = APPLE_FIRST_SWEEP;
      } else if (res === 'felled') {
        this.jobsDone++;
        if (task.kind === 'chop' && !this.carry.length) this.yieldWait = YIELD_WAIT;
        else this.finishNatureTask(task);
      }
      return;
    }
    this.swingTimer -= dt;
    if (this.swingTimer > 0) return;
    if (this.board?.applesFalling(task)) {
      this.swingTimer = 0.3;
      return;
    }
    this.swingTimer = SWING_INTERVAL / this.pace;
    const feet = this.getFeet(WorkerNPC._p);
    this.model.setFacingAngleInstant(Math.atan2(task.pos.x - feet.x, task.pos.z - feet.z));
    if (task.kind === 'chop') this.model.triggerAxeSwing();
    else this.model.triggerMineSwing();
    if (!task.apple) audioEngine.at(feet).playAxeSwing();
    this.impactIn = IMPACT_DELAY;
  }

  private finishNatureTask(task: FarmTask): void {
    this.board?.finish(task, this.id);
    this.task = null;
    this.doing = 0;
    this.impactIn = -1;
    this.yieldWait = -1;
    this.gatherT = -1;
    this.model.equipToolOrProp(null);
    this.showCarry();
    this.dwell = 0.8 + Math.random();
    this.stoopTimer = Infinity;
  }

  private finishTask(): void {
    const task = this.task;
    this.doing = 0;
    this.task = null;
    if (task?.kind === 'water') this.model.equipToolOrProp(null);
    if (task && this.board) {
      const got: Items = [];
      const ok = this.board.complete(task, this.id, this.seeds, got);
      if (ok) {
        this.jobsDone++;
        if (task.kind === 'plant') this.seeds = null;
      }
      this.carry.push(...got);
      // Seeds it did not sow go back with the next unload
      if (this.seeds) {
        this.carry.push(this.seeds);
        this.seeds = null;
      }
    }
    this.showCarry();
    // A short breath before the next job
    this.dwell = 2 + Math.random() * 2;
    this.stoopTimer = Infinity;
  }

  /** Lets go of the current job (`unreachable`: don't pick it again for a while). */
  private dropTask(unreachable = false): void {
    if (this.seeds) {
      this.carry.push(this.seeds);
      this.seeds = null;
    }
    if (this.errand === 'fetch') {
      this.errand = null;
      this.target = null;
      this.aim = null;
    }
    if (!this.task) {
      this.showCarry();
      return;
    }
    const kind = this.task.kind;
    if (kind === 'water' || kind === 'chop' || kind === 'mine' || this.task.apple) this.model.equipToolOrProp(null);
    this.gatherT = -1;
    // A felled tree still drops its wood into the worker's arms when its top lands
    this.board?.release(this.task, this.id, unreachable);
    this.task = null;
    this.doing = 0;
    this.impactIn = -1;
    this.yieldWait = -1;
    this.showCarry();
  }

  /** The box in its arms while it carries something. */
  private showCarry(): void {
    const load = this.carry[0]?.itemId ?? this.seeds?.itemId;
    this.carryMesh.visible = !!load && !this.asleep;
    if (!load) return;
    this.carryMesh.material = load === 'wood' ? CARRY_MAT.wood : load === 'stone' || load.endsWith('_ore') ? CARRY_MAT.stone : load.endsWith('_seed') || load.endsWith('_seeds') ? CARRY_MAT.seeds : CARRY_MAT.crate;
  }

  /** Changes which jobs it takes; drops the current one if it no longer fits. */
  public setRole(role: WorkerRole): void {
    this.role = role;
    if (this.task && role !== 'all' && role !== this.task.kind) {
      this.dropTask();
      this.target = null;
      this.aim = null;
    }
  }

  private goToBed(): void {
    this.activity = 'toBed';
    // The day's yield is dropped off on the way (no carrying it to bed)
    this.unload();
    this.dwell = 0;
    const p = this.bed?.stand ?? this.home;
    this.setTrip(new THREE.Vector3(p.x, p.y, p.z), null, 0.5);
    this.clearPath();
  }

  /** Lies down: in the bed when it reached it (`inBed`), otherwise where it stands. */
  private fallAsleep(inBed: boolean): void {
    this.activity = 'sleep';
    this.target = null;
    this.aim = null;
    this.speed = 0;
    this.clearPath();
    this.carryMesh.visible = false;
    this.sleepingInBed = inBed && !!this.bed;
    // The capsule would block the bed and the player walking past a sleeper on the floor
    this.collider.setEnabled(false);
    const g = this.model.group;
    if (this.sleepingInBed && this.bed) {
      g.position.copy(this.bed.lie);
      this.model.setFacingAngleInstant(this.bed.yaw);
    } else {
      const f = this.getFeet(WorkerNPC._p);
      g.position.set(f.x, f.y + 0.14, f.z);
    }
    g.rotation.x = -Math.PI / 2;
    this.zzz.visible = true;
    this.tag.sprite.visible = false;
    this.sleepPoseTime = 0;
  }

  private wakeUp(): void {
    this.bedOnLoad = false;
    this.activity = 'leisure';
    this.napping = false;
    this.collider.setEnabled(true);
    this.model.group.rotation.x = 0;
    this.zzz.visible = false;
    if (this.sleepingInBed && this.bed) this.placeAt(this.bed.stand);
    this.sleepingInBed = false;
    this.target = null;
    this.dwell = 1 + Math.random() * 2;
  }

  private updateSleeping(dt: number): void {
    const g = this.model.group;
    // Head end of the lying body: the model's up axis now points along the yaw
    const yaw = this.sleepingInBed && this.bed ? this.bed.yaw : g.rotation.y;
    this.zzzPhase += dt;
    const rise = (this.zzzPhase * 0.35) % 1;
    this.zzz.position.set(g.position.x - Math.sin(yaw) * 0.7, g.position.y + 0.45 + rise * 0.6, g.position.z - Math.cos(yaw) * 0.7);
    this.zzz.material.opacity = Math.sin(rise * Math.PI);
    // Blend into the idle pose, then hold it still (a sleeper doesn't sway)
    if (this.sleepPoseTime < SLEEP_POSE_BLEND) {
      this.sleepPoseTime += dt;
      this.animate(dt, 0, this.sleepingInBed && this.bed ? this.bed.yaw : null);
    }
  }

  /**
   * The player slept `hours`: the worker spends them in bed (if it is the night) and gets the
   * energy back.
   */
  public fastForward(hours: number, hour: number): void {
    this.dropTask();
    this.endErrand();
    this.unload();
    if (this.activity !== 'sleep') {
      if (this.bed) this.placeAt(this.bed.stand);
      else this.placeAt(this.home);
      this.fallAsleep(true);
    }
    this.energy = Math.min(100, this.energy + ENERGY_RATE.sleep * (this.sleepingInBed ? 1 : GROUND_SLEEP) * hours);
    this.food = Math.max(0, this.food + HUNGER_RATE.sleep * hours);
    this.thinkTimer = 0;
    this.think(hour);
  }

  /** A loaded save had it asleep: lies down on the spot until its bed is found (setBed). */
  public restoreAsleep(): void {
    this.dropTask();
    this.fallAsleep(false);
    this.bedOnLoad = true;
  }

  /** A loaded save: what it was carrying. */
  public restoreCarry(items: Items): void {
    this.carry = items.filter((i) => i && typeof i.itemId === 'string' && i.amount > 0);
    this.showCarry();
  }

  /** The bed was removed or reassigned: wake up if lying in it. */
  public setBed(bed: BedSpot | null): void {
    if (this.bed?.key === bed?.key) return;
    if (bed && this.bedOnLoad && this.activity === 'sleep' && !this.sleepingInBed) {
      // Restored from a save: straight into its bed
      this.bedOnLoad = false;
      this.bed = bed;
      this.collider.setEnabled(true);
      this.placeAt(bed.stand);
      this.fallAsleep(true);
      return;
    }
    // Wake from the old bed first (it steps out beside that one)
    if (this.activity === 'sleep' && this.sleepingInBed) this.wakeUp();
    this.bed = bed;
    if (this.activity === 'toBed') this.goToBed();
  }

  /** Leaving the farm: what it carries goes into the store. */
  public dispose(): void {
    this.dropTask();
    this.endErrand();
    this.unload();
    this.scene.remove(this.model.group, this.zzz, this.tag.sprite);
    this.zzz.material.dispose();
    this.tag.dispose();
    this.disposeBody();
    this.setDebug(false);
  }
}
