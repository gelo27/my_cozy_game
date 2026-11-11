import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { GridNavigator } from '../navigation/GridNavigator';
import { DoorControl, NPCAgent, NPC_WALK } from './NPCAgent';
import { FarmTask, TaskBoard, TaskKind, WorkerRole } from './TaskBoard';

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

/** Daily schedule (in-game hours). */
export const WORKER_SCHEDULE = {
  /** Wakes from here, if rested enough. */
  wake: 6,
  /** Works between these hours. */
  workFrom: 7,
  workUntil: 18,
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
const LEISURE_SPEED = 2.0;
/** Gives up walking to bed after this long (s): teleports when unseen, otherwise sleeps on the spot. */
const ROUTE_GIVE_UP = 40;
/** Drops a work / leisure spot it could not reach in this long (s). */
const SPOT_GIVE_UP = 15;
/** Walking to a farm job may take longer than to a spot in the yard (s). */
const TASK_GIVE_UP = 45;
/** Close enough to a field's centre to work on it (fields are 3 x 3 m). */
const TASK_REACH = 1.3;
/** How long each job takes on the spot (s). */
const TASK_TIME: Record<TaskKind, number> = { water: 2.6, harvest: 1.8, plant: 2.4 };
/** Gives up after standing this long without a route (s). */
const NO_ROUTE_GIVE_UP = 3;

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

/**
 * A farmhand with needs and a daily routine. Energy drains while awake (faster at work) and comes
 * back in bed; nights are spent in the assigned bed (or on the ground without one), an exhausted
 * worker naps during the day. Decisions run every THINK_INTERVAL, not per frame.
 *
 * Stage one: "work" walks between spots in the work area and stoops there; real farm jobs come
 * from a task board later.
 */
export class WorkerNPC extends NPCAgent {
  public energy: number;
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
  /** The job it is walking to or doing. */
  public task: FarmTask | null = null;
  /** Bed key it had in a loaded save (claimed on the next bed assignment). */
  public preferredBed: string | null = null;
  /** Name / colour slot (set by WorkerManager). */
  public slot = 0;
  /** Jobs finished since it was hired. */
  public jobsDone = 0;

  /** Daytime nap (wakes at NAP_UNTIL instead of with the morning). */
  private napping = false;
  private target: THREE.Vector3 | null = null;
  private targetSpeed = NPC_WALK;
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
  /** Seconds left of doing the job on the spot (0 = walking / idle). */
  private doing = 0;
  private readonly zzz: THREE.Sprite;
  private zzzPhase = Math.random() * 10;

  private static readonly _p = new THREE.Vector3();

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
    // Trips stay inside the yard; a long search would only mean the spot is unreachable
    this.planNodes = 900;
    this.home = spawn.clone();
    this.workCenter = spawn.clone();
    this.energy = 70 + Math.random() * 25;
    this.thinkTimer = stagger * THINK_INTERVAL;
    this.model.group.rotation.order = 'YXZ';
    this.zzz = new THREE.Sprite(new THREE.SpriteMaterial({ map: getZzzTexture(), depthWrite: false, transparent: true }));
    this.zzz.scale.setScalar(0.55);
    this.zzz.visible = false;
    scene.add(this.zzz);
  }

  public get asleep(): boolean {
    return this.activity === 'sleep';
  }

  /**
   * `dt` may be several frames at once (far workers update less often); `hours` is the in-game
   * time that passed in it.
   */
  public update(dt: number, player: THREE.Vector3, hour: number, hours: number): void {
    const rate = ENERGY_RATE[this.activity] * (this.activity === 'sleep' && !this.sleepingInBed ? GROUND_SLEEP : 1);
    this.energy = THREE.MathUtils.clamp(this.energy + rate * hours, 0, 100);

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer += THINK_INTERVAL;
      if (this.thinkTimer < 0) this.thinkTimer = THINK_INTERVAL;
      this.think(hour);
    }

    if (this.activity === 'sleep') {
      this.updateSleeping(dt);
      return;
    }

    const feet = this.getFeet(WorkerNPC._p);
    let goal: THREE.Vector3 | null = null;
    if (this.target) {
      const d = Math.hypot(this.target.x - feet.x, this.target.z - feet.z);
      const reach = this.task ? TASK_REACH : 0.5;
      const arrived = d < reach || (this.pathDone && d < 2.5 && this.stuckTime > 0.3);
      this.routeTime += dt;
      // Standing with no route left while still far: there is no way there
      this.noRouteTime = this.pathDone && !arrived && this.speed < 0.1 ? this.noRouteTime + dt : 0;
      const hopeless = this.noRouteTime > NO_ROUTE_GIVE_UP;
      if (this.activity !== 'toBed' && (hopeless || this.routeTime > (this.task ? TASK_GIVE_UP : SPOT_GIVE_UP))) {
        // No way there (water, walls): forget it, the next think picks another spot / job
        if (this.task) this.dropTask(true);
        this.target = null;
        this.dwell = 0;
      } else if (this.activity === 'toBed') {
        if (arrived || hopeless || this.routeTime > ROUTE_GIVE_UP) {
          const seen = Math.hypot(player.x - feet.x, player.z - feet.z) < 25;
          if (!arrived && !seen) this.placeAt(this.target);
          this.fallAsleep(arrived || !seen);
          return;
        }
        goal = this.target;
      } else if (arrived) {
        this.target = null;
        if (this.task) this.startTask(this.task);
      } else {
        goal = this.target;
      }
    } else if (this.task && this.doing > 0) {
      this.doing -= dt;
      if (this.doing <= 0) this.finishTask();
      this.drive(dt, null, 0, player, this.task?.pos ?? null);
      return;
    } else if (this.dwell > 0) {
      this.dwell -= dt;
      if (this.activity === 'work') {
        this.stoopTimer -= dt;
        if (this.stoopTimer <= 0) {
          this.stoopTimer = 2.2 + Math.random() * 1.5;
          this.model.triggerPickup();
        }
      }
    }
    this.drive(dt, goal, this.targetSpeed, player);
  }

  /** Picks the activity for the hour and the current energy. */
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
      this.napping = !night;
      this.goToBed();
      return;
    }
    const workHours = hour >= s.workFrom && hour < s.workUntil && this.role !== 'off';
    const want: WorkerActivity = workHours ? (this.energy >= TIRED ? 'work' : 'rest') : 'leisure';
    if (want !== this.activity) {
      this.dropTask();
      this.activity = want;
      this.target = null;
      this.dwell = 0;
    }
    if (this.task) {
      // The player (or the rain) did it meanwhile, or the field is gone
      if (this.doing <= 0 && this.board && !this.board.isValid(this.task)) {
        this.dropTask();
        this.target = null;
      }
      return;
    }
    // Also while pottering about: a job that turns up takes over from wandering
    if (this.activity === 'work' && this.board) {
      const task = this.board.claim(this.id, this.role, this.getFeet(WorkerNPC._p));
      if (task) {
        this.goToTask(task);
        return;
      }
    }
    if (!this.target && this.dwell <= 0) this.pickSpot();
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
    this.target = new THREE.Vector3(spot.x, spot.y, spot.z);
    this.targetSpeed = work ? NPC_WALK : LEISURE_SPEED;
    this.routeTime = 0;
    this.noRouteTime = 0;
    this.dwell = work ? 4 + Math.random() * 5 : this.activity === 'rest' ? 8 + Math.random() * 8 : 3 + Math.random() * 7;
    this.stoopTimer = 0.4;
  }

  private goToTask(task: FarmTask): void {
    this.task = task;
    this.dwell = 0;
    const spot = this.nav.snap(task.pos.x, task.pos.z, task.pos.y);
    this.target = spot ? new THREE.Vector3(spot.x, spot.y, spot.z) : task.pos.clone();
    this.targetSpeed = NPC_WALK;
    this.routeTime = 0;
    this.noRouteTime = 0;
  }

  private startTask(task: FarmTask): void {
    this.doing = TASK_TIME[task.kind];
    if (task.kind === 'water') {
      this.model.equipToolOrProp('watering_can');
      this.model.triggerWatering(this.doing);
    } else {
      this.model.triggerPickup();
    }
  }

  private finishTask(): void {
    const task = this.task;
    this.doing = 0;
    this.task = null;
    if (task?.kind === 'water') this.model.equipToolOrProp(null);
    if (task && this.board?.complete(task, this.id)) this.jobsDone++;
    // A short breath before the next job
    this.dwell = 0.6 + Math.random() * 0.6;
    this.stoopTimer = Infinity;
  }

  /** Lets go of the current job (`unreachable`: don't pick it again for a while). */
  private dropTask(unreachable = false): void {
    if (!this.task) return;
    if (this.doing > 0 && this.task.kind === 'water') this.model.equipToolOrProp(null);
    this.board?.release(this.task, this.id, unreachable);
    this.task = null;
    this.doing = 0;
  }

  /** Changes which jobs it takes; drops the current one if it no longer fits. */
  public setRole(role: WorkerRole): void {
    this.role = role;
    if (this.task && role !== 'all' && role !== this.task.kind) {
      this.dropTask();
      this.target = null;
    }
  }

  private goToBed(): void {
    this.activity = 'toBed';
    this.routeTime = 0;
    this.noRouteTime = 0;
    this.dwell = 0;
    const p = this.bed?.stand ?? this.home;
    this.target = new THREE.Vector3(p.x, p.y, p.z);
    this.targetSpeed = NPC_WALK;
    this.clearPath();
  }

  /** Lies down: in the bed when it reached it (`inBed`), otherwise where it stands. */
  private fallAsleep(inBed: boolean): void {
    this.activity = 'sleep';
    this.target = null;
    this.speed = 0;
    this.clearPath();
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
    if (this.activity !== 'sleep') {
      if (this.bed) this.placeAt(this.bed.stand);
      else this.placeAt(this.home);
      this.fallAsleep(true);
    }
    this.energy = Math.min(100, this.energy + ENERGY_RATE.sleep * (this.sleepingInBed ? 1 : GROUND_SLEEP) * hours);
    this.thinkTimer = 0;
    this.think(hour);
  }

  /** A loaded save had it asleep: lies down on the spot until its bed is found (setBed). */
  public restoreAsleep(): void {
    this.dropTask();
    this.fallAsleep(false);
    this.bedOnLoad = true;
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

  public dispose(): void {
    this.dropTask();
    this.scene.remove(this.model.group, this.zzz);
    this.zzz.material.dispose();
    this.disposeBody();
    this.setDebug(false);
  }
}
