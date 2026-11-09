import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { COLLISION_GROUPS } from '../config/constants';
import { TerrainSystem } from '../world/TerrainSystem';
import { worldSettings } from '../world/WorldSettings';
import { riverWorld } from '../world/rivers/RiverWorld';
import { TREE_MATERIAL } from '../world/TreeModels';
import { vegetationSettings as veg } from '../world/VegetationSettings';
import { AppleModels, FRUIT_PER_TREE, getAppleModels, loadAppleModels } from '../world/AppleTreeModel';
import type { PropSystem } from '../world/PropSystem';
import type { ParticleManager } from '../particles/ParticleManager';
import type { FallingLeaves } from '../particles/FallingLeaves';
import { audioEngine } from '../audio/AudioEngine';
import { TREE_FADE_RANGE, acquireDistanceDither } from '../world/LodDither';
import { PROP_TREE_HITS, type PropTreeField } from './PropTreeField';

export const APPLE_SAPLING_ID = 'apple_sapling';
export const APPLE_ID = 'apple';

/** Tree size per growth stage: sapling, young, half-grown, grown. */
const STAGE_SCALE = [0.28, 0.5, 0.75, 1];
/** Seconds each growing stage lasts before the next one. */
const STAGE_SECONDS = [90, 120, 150];
const GROWN = 3;
/** Grown tree's yearly round (s): resting in leaf, in bloom, apples ripening; ripe apples wait. */
const REST_SECONDS = 45;
const BLOOM_SECONDS = 60;
const FRUIT_SECONDS = 75;
/** Wood a felled tree gives per stage (a sapling comes out in one hit and gives itself back). */
const WOOD = [0, 2, 4, 6];
/** Knocks on the trunk that shake the ripe apples down (2 or 3, rolled per crop). */
const KNOCKS_MIN = 2;
/** Gaps (m) a new tree keeps: to other apple trees, to forest trees, to bushes. */
const GAP_APPLE = 3.2;
const GAP_TREE = 2.4;
const GAP_BUSH = 1.0;
/** Where the sapling goes: this far in front of the player. */
const PLANT_AHEAD = 1.7;
/** Lying apples: at most this many (the oldest go first), each for this long (s), then gone at once. */
const MAX_LOOSE = 90;
const LOOSE_LIFETIME = 60;
/** A dropped apple can be picked up this long after it left the tree (s): it is seen to fall. */
const PICKUP_DELAY = 0.55;
/** Pick-up reach around the player's body centre (horizontal m) and how long the hop takes (s). */
const PICKUP_RADIUS = 0.95;
const PICKUP_FLIGHT = 0.22;
/** Trees farther than this from the camera draw the plain crown; blossom and fruit stop at these. */
const nearDist = (): number => veg.oakNearDist;
/** Blossom and hanging apples are drawn only this close to the camera (m); hysteresis on top. */
const DETAIL_VIEW = 45;
const DETAIL_HYSTERESIS = 4;

type Phase = 'rest' | 'bloom' | 'fruit' | 'ripe';
const PHASES: Phase[] = ['rest', 'bloom', 'fruit', 'ripe'];

interface AppleTree {
  id: number;
  pos: THREE.Vector3;
  rotY: number;
  stage: number;
  /** Seconds into the current growing stage. */
  growT: number;
  phase: Phase;
  phaseT: number;
  knocksNeeded: number;
  knocks: number;
  /** Felling id in PropTreeField (0 until the first axe hit). */
  extId: number;
  /** Hit with the axe: the notched copy is drawn instead (no more growing, blossom or fruit). */
  cut: boolean;
  /** Bit i set: apple i still hangs. */
  hanging: number;
  /** Drawn size: the stage's (switches at once). */
  shown: number;
  /** Close enough for its blossom / apples to be drawn. */
  detail: boolean;
  /** Within the trees' view distance. */
  inView: boolean;
  wobble: number;
  wobbleAmp: number;
  axis: THREE.Vector3;
  /** 0 once felled (PropTreeField drops the top and stump), -1 while standing. */
  fall: number;
  /** Apples about to let go after the last knock: seconds left per apple index. */
  drops: { i: number; t: number }[];
  body: RAPIER.RigidBody | null;
  bodyStage: number;
  /** Near LOD (leaf scales) this frame. */
  near: boolean;
  dist: number;
}

interface LooseApple {
  body: RAPIER.RigidBody | null;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  age: number;
  prevVy: number;
  /** Seconds into the hop to the player, -1 while lying. */
  fly: number;
  from: THREE.Vector3;
  /** Close enough to the camera to be drawn. */
  vis: boolean;
}

export interface AppleTreeNode {
  id: number;
  position: THREE.Vector3;
  radius: number;
  /** Axe hits left / to fell. */
  health: number;
  maxHealth: number;
  stage: number;
  phase: Phase;
  /** 0..1 of the current growing stage or phase. */
  progress: number;
  canKnock: boolean;
  knocks: number;
  knocksNeeded: number;
}

export interface OrchardSaveData {
  /** Per tree: x, z, rotY, stage, growT, phase index, phaseT, knocksNeeded, hanging mask. */
  t: number[][];
  /** Lying apples: x, y, z, seconds they have lain. */
  a?: number[][];
}

export type PlantCheck = 'ok' | 'tooClose' | 'badGround';

/**
 * Apple trees the player plants anywhere on open ground. Each grows through three stages to a full
 * tree, then goes round and round: in leaf, in bloom (a blossom mesh over the crown), apples
 * ripening where the blossom was, ripe apples waiting to be knocked down. A few knocks on the trunk
 * drop them as Rapier balls that bounce and roll; walking over one picks it up. The axe fells the
 * tree.
 *
 * Cost: the whole orchard is four instanced meshes (near trees, far trees, blossom, hanging fruit)
 * plus one for the apples on the ground, rewritten only when something changes; a tree has one
 * fixed trunk collider, and apples are bodies only from the moment they fall until picked up.
 */
export class AppleOrchard {
  private readonly group = new THREE.Group();
  private readonly trees: AppleTree[] = [];
  private readonly loose: LooseApple[] = [];
  private nextId = 1;
  /** Bumped when trees are added, removed or change stage (shadows key on it). */
  public revision = 0;

  private models: AppleModels | null = null;
  private nearMesh: THREE.InstancedMesh | null = null;
  private farMesh: THREE.InstancedMesh | null = null;
  private blossomMesh: THREE.InstancedMesh | null = null;
  private fruitMesh: THREE.InstancedMesh | null = null;
  private looseMesh: THREE.InstancedMesh | null = null;
  private capacity = 0;
  private treesDirty = true;
  private fruitDirty = true;
  private looseDirty = true;
  private lodTimer = 0;
  private groundTimer = 0;
  private terrainRevision = -1;
  private readonly camera = new THREE.Vector3(1e9, 0, 0);

  private ghost: THREE.Mesh | null = null;
  private readonly ghostOk = new THREE.MeshBasicMaterial({ color: 0x7ee07e, transparent: true, opacity: 0.5, depthWrite: false });
  private readonly ghostBad = new THREE.MeshBasicMaterial({ color: 0xff6b5a, transparent: true, opacity: 0.5, depthWrite: false });
  private readonly ghostPos = new THREE.Vector3();
  private ghostCheck: PlantCheck = 'badGround';
  private ghostYaw = 0;

  /** Apples picked up but not reported yet (several in one go make one toast). */
  private pendingApples = 0;
  private pendingTimer = 0;
  private thuds = 0;

  /** Falling leaves and petals (the engine sets it). */
  public leaves: FallingLeaves | null = null;
  /** Forest props, to keep saplings out of their crowns. */
  public props: PropSystem | null = null;
  /** True where nothing may be planted (fields, caves); the engine sets it. */
  public isBlocked: ((x: number, z: number) => boolean) | null = null;
  /** Fells grown trees exactly like the forest's (notch, falling top, logs); the engine sets it. */
  public feller: PropTreeField | null = null;
  /** Items into the backpack (apples, a sapling back). */
  public onItems: ((items: { itemId: string; amount: number }[]) => void) | null = null;

  private static readonly _m = new THREE.Matrix4();
  private static readonly _m2 = new THREE.Matrix4();
  private static readonly _q = new THREE.Quaternion();
  private static readonly _q2 = new THREE.Quaternion();
  private static readonly _v = new THREE.Vector3();
  private static readonly _v2 = new THREE.Vector3();
  private static readonly _s = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(
    scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
    private readonly terrain: TerrainSystem,
    private readonly particles: ParticleManager | null,
  ) {
    this.group.name = 'AppleOrchard';
    scene.add(this.group);
    void loadAppleModels().then((m) => {
      if (!m) return;
      this.models = m;
      this.ensureCapacity(Math.max(8, this.trees.length));
      this.looseMesh = new THREE.InstancedMesh(m.apple, TREE_MATERIAL, MAX_LOOSE);
      this.looseMesh.name = 'LooseApples';
      this.looseMesh.frustumCulled = false;
      this.looseMesh.count = 0;
      this.group.add(this.looseMesh);
      const ghost = new THREE.Mesh(m.far, this.ghostOk);
      ghost.name = 'AppleSaplingGhost';
      ghost.visible = false;
      ghost.renderOrder = 5;
      this.group.add(ghost);
      this.ghost = ghost;
      for (const t of this.trees) this.syncBody(t);
      this.treesDirty = this.fruitDirty = this.looseDirty = true;
    });
  }

  // ------------------------------------------------------------------ planting

  /**
   * Places the sapling ghost in front of the player and checks the spot: open, fairly flat ground
   * above water, off fields and paths, clear of buildings, rocks and other trees.
   */
  public updateGhost(playerPos: THREE.Vector3, yaw: number): PlantCheck {
    const x = playerPos.x + Math.sin(yaw) * PLANT_AHEAD;
    const z = playerPos.z + Math.cos(yaw) * PLANT_AHEAD;
    const y = this.terrain.getHeight(x, z);
    this.ghostPos.set(x, y, z);
    this.ghostCheck = this.checkSpot(x, y, z, playerPos.y);
    if (this.ghost) {
      this.ghost.visible = true;
      this.ghost.position.copy(this.ghostPos);
      this.ghost.rotation.y = this.ghostYaw;
      this.ghost.scale.setScalar(STAGE_SCALE[0]);
      this.ghost.material = this.ghostCheck === 'ok' ? this.ghostOk : this.ghostBad;
    }
    return this.ghostCheck;
  }

  public hideGhost(): void {
    if (this.ghost) this.ghost.visible = false;
  }

  /** Plants a sapling at the ghost (after updateGhost said 'ok'). */
  public plantAtGhost(): boolean {
    if (this.ghostCheck !== 'ok' || !this.models) return false;
    const t = this.addTree(this.ghostPos.x, this.ghostPos.z, this.ghostYaw, 0, 0, 'rest', 0, 0, 0);
    this.ghostYaw = Math.random() * Math.PI * 2;
    this.particles?.emitDirtClods(this.ghostPos.clone(), 10);
    audioEngine.at(this.ghostPos).playPlantSeed();
    return true;
  }

  private checkSpot(x: number, y: number, z: number, playerY: number): PlantCheck {
    if (!this.terrain.isInside(x, z)) return 'badGround';
    if (Math.abs(y - (playerY - 0.75)) > 1.6) return 'badGround';
    if (y < worldSettings.waterLevel + 0.25 || y < riverWorld.waterLevelAt(x, z) + 0.25) return 'badGround';
    // Fairly flat: the ground around the trunk within half a metre up or down
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      if (Math.abs(this.terrain.getHeight(x + Math.cos(a) * 0.8, z + Math.sin(a) * 0.8) - y) > 0.5) return 'badGround';
    }
    if (this.isBlocked?.(x, z)) return 'badGround';
    for (const t of this.trees) {
      if ((t.pos.x - x) ** 2 + (t.pos.z - z) ** 2 < GAP_APPLE * GAP_APPLE) return 'tooClose';
    }
    let close = false;
    this.props?.forEachNear(x, z, GAP_TREE + 0.5, (p) => {
      const gap = p.type === 'tree_pine' || p.type === 'tree_round' ? GAP_TREE * p.scale : p.type === 'bush' || p.type === 'stump' ? GAP_BUSH * p.scale : 0;
      if (gap > 0 && (p.position.x - x) ** 2 + (p.position.z - z) ** 2 < gap * gap) close = true;
    });
    if (close) return 'tooClose';
    // Buildings, rocks, stations, fences...: any collider but the terrain where the trunk would stand
    if (this.physics.isInitialized()) {
      const R = this.physics.rapier;
      const shape = new R.Cylinder(1, 0.5);
      const hit = this.physics.world.intersectionWithShape(
        { x, y: y + 1.25, z }, { x: 0, y: 0, z: 0, w: 1 }, shape, undefined,
        this.physics.packCollisionGroups(0xffff, COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS),
        undefined, undefined,
        (c) => ((c.collisionGroups() >>> 16) & COLLISION_GROUPS.TERRAIN) === 0,
      );
      if (hit) return 'badGround';
    }
    return 'ok';
  }

  // ------------------------------------------------------------------ trees

  private addTree(x: number, z: number, rotY: number, stage: number, growT: number, phase: Phase, phaseT: number, knocksNeeded: number, hanging: number): AppleTree {
    const t: AppleTree = {
      id: this.nextId++,
      pos: new THREE.Vector3(x, this.terrain.getHeight(x, z), z),
      rotY, stage, growT, phase, phaseT,
      knocksNeeded: knocksNeeded || this.rollKnocks(),
      knocks: 0, extId: 0, cut: false, hanging,
      shown: STAGE_SCALE[stage], detail: false, inView: true,
      wobble: 0, wobbleAmp: 0, axis: new THREE.Vector3(1, 0, 0),
      fall: -1, drops: [], body: null, bodyStage: -1, near: true, dist: 0,
    };
    this.trees.push(t);
    this.ensureCapacity(this.trees.length);
    this.syncBody(t);
    this.treesDirty = this.fruitDirty = true;
    this.revision++;
    return t;
  }

  private rollKnocks(): number {
    return KNOCKS_MIN + (Math.random() < 0.5 ? 1 : 0);
  }

  private removeTree(t: AppleTree): void {
    const i = this.trees.indexOf(t);
    if (i >= 0) this.trees.splice(i, 1);
    if (t.extId) this.feller?.unregisterExternal(t.extId);
    t.extId = 0;
    this.dropBody(t);
    this.treesDirty = this.fruitDirty = true;
    this.revision++;
  }

  /** The trunk's fixed cylinder, fitted to the stage (a fresh sapling has none). */
  private syncBody(t: AppleTree): void {
    const want = t.fall >= 0 || !this.models || !this.physics.isInitialized() ? -1 : t.stage;
    if (want === t.bodyStage) return;
    this.dropBody(t);
    if (want < 1) return;
    const s = STAGE_SCALE[want];
    const h = 2.4 * s;
    const pos = new THREE.Vector3(t.pos.x, t.pos.y + h / 2, t.pos.z);
    const res = this.physics.createStaticCylinder(pos, this.models!.trunkRadius * 0.85 * s, h);
    (res.collider as unknown as { userData: unknown }).userData = { surface: 'wood' };
    t.body = res.body;
    t.bodyStage = want;
  }

  private dropBody(t: AppleTree): void {
    if (t.body) this.physics.removeRigidBody(t.body);
    t.body = null;
    t.bodyStage = -1;
  }

  /** Nearest standing apple tree whose trunk is within `reach` of `point`. */
  public findNearest(point: THREE.Vector3, reach: number): AppleTreeNode | null {
    let best: AppleTree | null = null;
    let bestD = Infinity;
    const tr = this.models?.trunkRadius ?? 0.4;
    for (const t of this.trees) {
      if (t.fall >= 0) continue;
      const dy = point.y - t.pos.y;
      if (dy < -2 || dy > 4) continue;
      const d = Math.hypot(point.x - t.pos.x, point.z - t.pos.z) - tr * STAGE_SCALE[t.stage];
      if (d <= reach && d < bestD) {
        bestD = d;
        best = t;
      }
    }
    if (!best) return null;
    const b = best as AppleTree;
    const hits = b.stage === 0 ? { health: 1, max: 1 } : b.extId && this.feller ? this.feller.externalHealth(b.extId) : { health: PROP_TREE_HITS, max: PROP_TREE_HITS };
    const grown = b.stage === GROWN;
    const progress = grown
      ? b.phase === 'rest' ? b.phaseT / REST_SECONDS : b.phase === 'bloom' ? b.phaseT / BLOOM_SECONDS : b.phase === 'fruit' ? b.phaseT / FRUIT_SECONDS : 1
      : b.growT / STAGE_SECONDS[b.stage];
    return {
      id: b.id,
      position: b.pos,
      radius: tr * STAGE_SCALE[b.stage],
      health: hits.health,
      maxHealth: hits.max,
      stage: b.stage,
      phase: b.phase,
      progress: Math.min(1, progress),
      canKnock: grown && !b.cut && b.phase === 'ripe' && b.hanging !== 0 && b.drops.length === 0,
      knocks: b.knocks,
      knocksNeeded: b.knocksNeeded,
    };
  }

  private byId(id: number): AppleTree | null {
    for (const t of this.trees) if (t.id === id) return t;
    return null;
  }

  /** A knock on the trunk; the last one shakes every ripe apple down. Returns true on the last. */
  public knock(id: number, direction: THREE.Vector3): boolean {
    const t = this.byId(id);
    if (!t || t.fall >= 0 || t.cut || t.stage !== GROWN || t.phase !== 'ripe' || !t.hanging || t.drops.length) return false;
    t.knocks++;
    this.shake(t, direction, 0.03);
    const at = PropAt.trunk(t, direction, this.models?.trunkRadius ?? 0.4);
    audioEngine.at(at, 3).playWoodChopHit(false);
    audioEngine.at(at, 4).playBushRustle(0.8);
    const last = t.knocks >= t.knocksNeeded;
    const left = t.knocksNeeded - t.knocks + 1;
    let hanging = 0;
    for (let i = 0; i < FRUIT_PER_TREE; i++) if (t.hanging & (1 << i)) hanging++;
    this.shakeDown(t, 0.05, 0.45, last ? hanging : Math.ceil(hanging / left));
    this.shedLeaves(t, last ? 22 : 8, last ? 1.4 : 0.8);
    return last;
  }

  /**
   * One axe hit. A sapling comes out at once; a bigger tree is felled by PropTreeField exactly like
   * the forest's trees (notch deepening with each hit, the top going over on its hinge, logs flying
   * to the player), and its stump goes with the fallen top. Returns true when it falls.
   */
  public chop(id: number, direction: THREE.Vector3): boolean {
    const t = this.byId(id);
    if (!t || t.fall >= 0) return false;
    if (t.stage === 0) {
      // A sapling just comes out of the ground and goes back into the backpack
      const at = PropAt.trunk(t, direction, this.models?.trunkRadius ?? 0.4);
      audioEngine.at(at).playWoodChopHit(true);
      this.shedLeaves(t, 10, 1);
      this.onItems?.([{ itemId: APPLE_SAPLING_ID, amount: 1 }]);
      this.removeTree(t);
      return true;
    }
    const feller = this.feller, m = this.models;
    if (!feller || !m) return false;
    if (!t.extId) {
      t.extId = feller.registerExternal({
        prop: { id: 0, type: 'apple_tree', position: t.pos, rotationY: t.rotY, scale: STAGE_SCALE[t.stage], grounded: true },
        source: m.near,
        trunkRadius: m.trunkRadius,
        crown: m.crown,
        wood: WOOD[t.stage],
        leafColor: 0x4a8a2e,
        onHide: () => {
          t.cut = true;
          this.treesDirty = this.fruitDirty = true;
        },
        onFell: () => {
          t.fall = 0;
          this.syncBody(t);
          this.revision++;
        },
        onGone: () => {
          t.extId = 0;
          this.removeTree(t);
        },
      });
      // The first blow shakes the tree: ripe apples drop, the blossom scatters, green fruit is lost
      if (t.phase === 'bloom' || t.phase === 'fruit') this.shedPetals(t, 40);
      if (t.phase === 'ripe' && t.hanging) this.shakeDown(t, 0, 0.3);
      else {
        t.hanging = 0;
        t.drops.length = 0;
      }
      t.wobble = 0;
      t.shown = STAGE_SCALE[t.stage];
      this.treesDirty = this.fruitDirty = true;
    }
    return feller.hitExternal(t.extId, direction);
  }

  private shake(t: AppleTree, direction: THREE.Vector3, amp: number): void {
    t.axis.set(direction.z, 0, -direction.x).normalize();
    t.wobble = 1;
    t.wobbleAmp = amp;
    this.treesDirty = this.fruitDirty = true;
  }

  /** `count` random hanging apples (all by default) let go, one after another over `spread` seconds. */
  private shakeDown(t: AppleTree, delay: number, spread: number, count = FRUIT_PER_TREE): void {
    const free: number[] = [];
    for (let i = 0; i < FRUIT_PER_TREE; i++) {
      if ((t.hanging & (1 << i)) && !t.drops.some((d) => d.i === i)) free.push(i);
    }
    for (let k = 0; k < count && free.length; k++) {
      const i = free.splice(Math.floor(Math.random() * free.length), 1)[0];
      t.drops.push({ i, t: delay + Math.random() * spread });
    }
  }

  // ------------------------------------------------------------------ update

  public update(dt: number, player: THREE.Vector3, camera: THREE.Vector3): void {
    this.camera.copy(camera);
    if (this.terrain.revision !== this.terrainRevision) {
      // Terrain edited (editor): keep trees on the ground, a moment after the edits stop
      this.groundTimer -= dt;
      if (this.groundTimer <= 0) {
        this.groundTimer = 0.5;
        this.terrainRevision = this.terrain.revision;
        for (const t of this.trees) {
          const y = this.terrain.getHeight(t.pos.x, t.pos.z);
          if (Math.abs(y - t.pos.y) > 1e-3) {
            t.pos.y = y;
            this.dropBody(t);
            this.syncBody(t);
            this.treesDirty = this.fruitDirty = true;
          }
        }
      }
    }

    for (let i = this.trees.length - 1; i >= 0; i--) this.updateTree(this.trees[i], dt);
    this.updateLod(dt);

    if (this.treesDirty) this.writeTrees();
    if (this.fruitDirty) this.writeFruit();
    if (this.loose.length || this.looseDirty) this.updateLoose(dt, player);

    if (this.pendingApples > 0) {
      this.pendingTimer -= dt;
      if (this.pendingTimer <= 0) {
        this.onItems?.([{ itemId: APPLE_ID, amount: this.pendingApples }]);
        this.pendingApples = 0;
      }
    }
    this.thuds = Math.max(0, this.thuds - dt * 30);
  }

  private updateTree(t: AppleTree, dt: number): void {
    if (t.wobble > 0) {
      t.wobble = Math.max(0, t.wobble - dt * 3);
      this.treesDirty = this.fruitDirty = true;
    }
    if (t.drops.length) this.updateDrops(t, dt);

    // Hit with the axe: frozen as it is until it falls
    if (t.cut || t.fall >= 0) return;
    this.advance(t, dt, false);
  }

  /** Growth and the yearly round by `dt` seconds; `silent` skips the effects (fast-forward). */
  private advance(t: AppleTree, dt: number, silent: boolean): void {
    let left = dt;
    for (let guard = 0; guard < 16 && left > 0; guard++) {
      if (t.stage < GROWN) {
        const need = STAGE_SECONDS[t.stage] - t.growT;
        if (left < need) {
          t.growT += left;
          return;
        }
        left -= need;
        t.growT = 0;
        t.stage++;
        // The next stage at once (a puff of leaves hides the swap)
        t.shown = STAGE_SCALE[t.stage];
        if (!silent) {
          this.shedLeaves(t, 14, 1);
          this.particles?.emitTreeFoliageLeaves(t.pos.clone().setY(t.pos.y + 3 * STAGE_SCALE[t.stage]), 10);
        }
        this.syncBody(t);
        this.treesDirty = this.fruitDirty = true;
        this.revision++;
        continue;
      }
      if (t.phase === 'ripe') return;
      const len = t.phase === 'rest' ? REST_SECONDS : t.phase === 'bloom' ? BLOOM_SECONDS : FRUIT_SECONDS;
      const need = len - t.phaseT;
      if (left < need) {
        t.phaseT += left;
        return;
      }
      left -= need;
      t.phaseT = 0;
      if (t.phase === 'rest') {
        t.phase = 'bloom';
        if (!silent) this.shedPetals(t, 8);
      } else if (t.phase === 'bloom') {
        // The fruit ripens unseen under the blossom, which stays until the apples can be picked
        t.phase = 'fruit';
        t.hanging = 0;
      } else {
        // The petals fall and the ripe apples appear where the blossom was
        t.phase = 'ripe';
        if (!silent) this.shedPetals(t, 36);
        t.hanging = (1 << FRUIT_PER_TREE) - 1;
        t.knocks = 0;
        t.knocksNeeded = this.rollKnocks();
      }
      this.fruitDirty = true;
    }
  }

  /** Sleeping skips hours: every tree grows on without effects. */
  public fastForward(seconds: number): void {
    for (const t of this.trees) if (t.fall < 0 && !t.cut) this.advance(t, seconds, true);
    this.treesDirty = this.fruitDirty = true;
  }

  private updateDrops(t: AppleTree, dt: number): void {
    const m = this.models;
    for (let k = t.drops.length - 1; k >= 0; k--) {
      const d = t.drops[k];
      d.t -= dt;
      if (d.t > 0) continue;
      t.drops.splice(k, 1);
      t.hanging &= ~(1 << d.i);
      this.fruitDirty = true;
      if (m) {
        const at = this.fruitWorld(t, d.i, AppleOrchard._v2, AppleOrchard._q2);
        // Outwards from the trunk, a little, with a random spin
        const out = AppleOrchard._v.set(at.x - t.pos.x, 0, at.z - t.pos.z).normalize().multiplyScalar(0.4 + Math.random() * 0.6);
        this.spawnLoose(at, AppleOrchard._q2, out.x + (Math.random() - 0.5) * 0.4, -0.2 - Math.random() * 0.6, out.z + (Math.random() - 0.5) * 0.4);
      }
    }
    if (!t.drops.length && !t.hanging && t.phase === 'ripe') {
      // Picked clean: the tree rests and blooms again
      t.phase = 'rest';
      t.phaseT = 0;
      t.knocks = 0;
    }
  }

  private shedLeaves(t: AppleTree, count: number, burst: number): void {
    const c = this.models?.crown ?? { y: 4, r: 2.5, h: 4 };
    const s = t.shown;
    this.leaves?.emit(AppleOrchard._v.set(t.pos.x, t.pos.y + c.y * s, t.pos.z), c.r * 0.8 * s, c.h * 0.5 * s, count, 0x4a8a2e, burst);
  }

  private shedPetals(t: AppleTree, count: number): void {
    const c = this.models?.crown ?? { y: 4, r: 2.5, h: 4 };
    const s = t.shown;
    this.leaves?.emit(AppleOrchard._v.set(t.pos.x, t.pos.y + c.y * s, t.pos.z), c.r * 0.9 * s, c.h * 0.5 * s, count, 0xf7d0dc, 0.6);
  }

  // ------------------------------------------------------------------ drawing

  private ensureCapacity(n: number): void {
    const m = this.models;
    if (!m || n <= this.capacity) return;
    const cap = Math.max(8, 1 << Math.ceil(Math.log2(n)));
    for (const mesh of [this.nearMesh, this.farMesh, this.blossomMesh, this.fruitMesh]) {
      if (mesh) {
        mesh.removeFromParent();
        mesh.dispose();
      }
    }
    const make = (g: THREE.BufferGeometry, count: number, name: string): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(g, TREE_MATERIAL, count);
      mesh.name = name;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      return mesh;
    };
    this.nearMesh = make(m.near, cap, 'AppleTreesNear');
    this.farMesh = make(m.far, cap, 'AppleTreesFar');
    // Far crowns dissolve at the view's edge with the forest's distance dither, never pop
    this.farMesh.material = acquireDistanceDither(TREE_MATERIAL, TREE_FADE_RANGE);
    this.blossomMesh = make(m.blossom, cap, 'AppleBlossom');
    this.fruitMesh = make(m.apple, cap * FRUIT_PER_TREE, 'AppleFruit');
    this.capacity = cap;
    this.treesDirty = this.fruitDirty = true;
  }

  /** Re-picks near / far crowns a few times a second (and after the camera moved). */
  private updateLod(dt: number): void {
    this.lodTimer -= dt;
    if (this.lodTimer > 0) return;
    this.lodTimer = 0.25;
    const nd = nearDist();
    const r = TREE_FADE_RANGE.value;
    const viewEnd = r.y + (r.y - r.x) * 0.15 + 1;
    for (const t of this.trees) {
      t.dist = Math.hypot(t.pos.x - this.camera.x, t.pos.z - this.camera.z);
      const near = t.dist < (t.near ? nd + 4 : nd);
      const shown = t.dist < viewEnd;
      if (shown !== t.inView) {
        t.inView = shown;
        this.treesDirty = true;
      }
      if (near !== t.near) {
        t.near = near;
        this.treesDirty = true;
      }
      const detail = t.dist < (t.detail ? DETAIL_VIEW + DETAIL_HYSTERESIS : DETAIL_VIEW);
      if (detail !== t.detail) {
        t.detail = detail;
        this.fruitDirty = true;
      }
    }
  }

  private treeQuat(t: AppleTree, out: THREE.Quaternion): THREE.Quaternion {
    out.setFromAxisAngle(AppleOrchard.UP, t.rotY);
    const angle = t.wobble > 0 ? Math.sin(t.wobble * 18) * t.wobble * t.wobbleAmp : 0;
    if (angle !== 0) out.premultiply(AppleOrchard._q2.setFromAxisAngle(t.axis, angle));
    return out;
  }

  private treeScale(t: AppleTree): number {
    return t.shown;
  }

  private treeMatrix(t: AppleTree, out: THREE.Matrix4): THREE.Matrix4 {
    const q = this.treeQuat(t, AppleOrchard._q);
    return out.compose(t.pos, q, AppleOrchard._s.setScalar(this.treeScale(t)));
  }

  private writeTrees(): void {
    this.treesDirty = false;
    const near = this.nearMesh, far = this.farMesh;
    if (!near || !far) return;
    let n = 0, f = 0;
    const m = AppleOrchard._m;
    // Past the fade band (plus the shader's per-tree jitter) a tree is fully dissolved
    const r = TREE_FADE_RANGE.value;
    const viewEnd = r.y + (r.y - r.x) * 0.15 + 1;
    for (const t of this.trees) {
      if (t.cut || t.dist > viewEnd) continue;
      this.treeMatrix(t, m);
      if (t.near) near.setMatrixAt(n++, m);
      else far.setMatrixAt(f++, m);
    }
    near.count = n;
    far.count = f;
    near.instanceMatrix.needsUpdate = true;
    far.instanceMatrix.needsUpdate = true;
    near.computeBoundingSphere();
    far.computeBoundingSphere();
  }

  /** Apple `i` of tree `t`: world position (centre) and rotation; returns `outPos`. */
  private fruitWorld(t: AppleTree, i: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion, treeMatrix?: THREE.Matrix4): THREE.Vector3 {
    const m = this.models!;
    const spot = m.fruitSpots[i % m.fruitSpots.length];
    const tm = treeMatrix ?? this.treeMatrix(t, AppleOrchard._m2);
    outPos.copy(spot).applyMatrix4(tm);
    outQuat.setFromAxisAngle(AppleOrchard.UP, t.rotY + i * 2.4);
    return outPos;
  }

  /**
   * Blossom and hanging apples of the trees near the camera. Rewritten only when something changes
   * (a phase switch, a knock, an apple dropping, a tree crossing DETAIL_VIEW), never every frame.
   */
  private writeFruit(): void {
    this.fruitDirty = false;
    const bm = this.blossomMesh, fm = this.fruitMesh, m = this.models;
    if (!bm || !fm || !m) return;
    let b = 0, f = 0;
    const tm = AppleOrchard._m2;
    const mat = AppleOrchard._m;
    for (const t of this.trees) {
      if (t.stage !== GROWN || !t.detail || t.cut) continue;
      // In flower from bloom until the apples are ripe
      const bloom = t.phase === 'bloom' || t.phase === 'fruit';
      if (!bloom && !t.hanging) continue;
      this.treeMatrix(t, tm);
      if (bloom) bm.setMatrixAt(b++, tm);
      if (!t.hanging) continue;
      const s = this.treeScale(t);
      for (let i = 0; i < FRUIT_PER_TREE; i++) {
        if (!(t.hanging & (1 << i))) continue;
        const pos = this.fruitWorld(t, i, AppleOrchard._v, AppleOrchard._q2, tm);
        mat.compose(pos, AppleOrchard._q2, AppleOrchard._s.setScalar(s));
        fm.setMatrixAt(f++, mat);
      }
    }
    bm.count = b;
    fm.count = f;
    bm.instanceMatrix.needsUpdate = true;
    fm.instanceMatrix.needsUpdate = true;
    if (b) bm.computeBoundingSphere();
    if (f) fm.computeBoundingSphere();
  }

  // ------------------------------------------------------------------ apples on the ground

  private spawnLoose(pos: THREE.Vector3, quat: THREE.Quaternion, vx: number, vy: number, vz: number, sleeping = false, age = 0): void {
    const m = this.models;
    if (!m || !this.physics.isInitialized()) return;
    if (this.loose.length >= MAX_LOOSE) this.removeLoose(0);
    const R = this.physics.rapier;
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
      .setLinvel(vx, vy, vz)
      .setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 })
      .setLinearDamping(0.25)
      .setAngularDamping(2.2)
      .setCcdEnabled(true);
    if (sleeping) desc.setSleeping(true);
    const body = this.physics.world.createRigidBody(desc);
    body.userData = { noCarry: true };
    this.physics.world.createCollider(
      R.ColliderDesc.ball(m.appleRadius * 0.92)
        .setDensity(750)
        .setFriction(0.85)
        .setRestitution(0.32)
        .setCollisionGroups(this.physics.packCollisionGroups(
          COLLISION_GROUPS.DYNAMIC_PROPS,
          COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.TERRAIN | COLLISION_GROUPS.DYNAMIC_PROPS,
        )),
      body,
    );
    this.loose.push({ body, pos: pos.clone(), quat: quat.clone(), age, prevVy: vy, fly: -1, from: new THREE.Vector3(), vis: false });
    this.looseDirty = true;
  }

  private removeLoose(i: number): void {
    const a = this.loose[i];
    if (a.body) this.physics.removeRigidBody(a.body);
    this.loose.splice(i, 1);
    this.looseDirty = true;
  }

  private updateLoose(dt: number, player: THREE.Vector3): void {
    const mesh = this.looseMesh;
    let changed = this.looseDirty;
    const cam = this.camera;
    const view2 = DETAIL_VIEW * DETAIL_VIEW;
    for (let i = this.loose.length - 1; i >= 0; i--) {
      const a = this.loose[i];
      a.age += dt;
      // Far apples aren't drawn (checked against the camera, like the ones on the trees)
      const vis = (a.pos.x - cam.x) ** 2 + (a.pos.z - cam.z) ** 2 < view2;
      if (vis !== a.vis) {
        a.vis = vis;
        changed = true;
      }
      if (a.fly >= 0) {
        // Hopping into the player
        a.fly += dt;
        const k = Math.min(1, a.fly / PICKUP_FLIGHT);
        a.pos.lerpVectors(a.from, AppleOrchard._v.set(player.x, player.y + 0.2, player.z), k * k);
        a.pos.y += Math.sin(Math.PI * k) * 0.35;
        changed = true;
        if (k >= 1) {
          this.loose.splice(i, 1);
          this.pendingApples++;
          this.pendingTimer = 0.5;
          audioEngine.at(player).playApplePickup();
        }
        continue;
      }
      const body = a.body!;
      if (!body.isSleeping()) {
        const p = body.translation();
        const r = body.rotation();
        a.pos.set(p.x, p.y, p.z);
        a.quat.set(r.x, r.y, r.z, r.w);
        const vy = body.linvel().y;
        // Bounced: the falling speed was knocked out of it this step
        if (a.prevVy < -1.6 && vy > a.prevVy + 1.2 && this.thuds < 6) {
          this.thuds++;
          audioEngine.at(a.pos, 3).playAppleThud(Math.min(1, -a.prevVy / 9));
        }
        a.prevVy = vy;
        changed = true;
        if (p.y < -60) {
          this.removeLoose(i);
          continue;
        }
      }
      if (a.age > LOOSE_LIFETIME) {
        this.removeLoose(i);
        continue;
      }
      // Walked over: it hops into the backpack
      if (a.age > PICKUP_DELAY) {
        const dx = a.pos.x - player.x, dz = a.pos.z - player.z, dy = a.pos.y - player.y;
        if (dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS && dy > -1.3 && dy < 1.0) {
          this.physics.removeRigidBody(body);
          a.body = null;
          a.fly = 0;
          a.from.copy(a.pos);
          changed = true;
        }
      }
    }
    this.looseDirty = false;
    if (!mesh || !changed) return;
    const m = AppleOrchard._m;
    let n = 0;
    for (let i = 0; i < this.loose.length; i++) {
      const a = this.loose[i];
      if (!a.vis) continue;
      const s = a.fly >= 0 ? 1 - 0.6 * Math.min(1, a.fly / PICKUP_FLIGHT) : 1;
      mesh.setMatrixAt(n++, m.compose(a.pos, a.quat, AppleOrchard._s.setScalar(s)));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ save

  public serialize(): OrchardSaveData {
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return {
      t: this.trees.filter((t) => t.fall < 0).map((t) => [
        r2(t.pos.x), r2(t.pos.z), r2(t.rotY), t.stage, Math.round(t.growT), PHASES.indexOf(t.phase), Math.round(t.phaseT), t.knocksNeeded,
        // Apples in mid-drop are saved as fallen (they are on the ground list below)
        t.hanging & ~t.drops.reduce((mask, d) => mask | (1 << d.i), 0),
      ]),
      a: this.loose.filter((a) => a.body).map((a) => [r2(a.pos.x), r2(a.pos.y), r2(a.pos.z), Math.round(a.age)]),
    };
  }

  public deserialize(data: OrchardSaveData | undefined): void {
    this.clear();
    if (!data) return;
    for (const r of data.t ?? []) {
      const [x, z, rotY, stage, growT, phase, phaseT, knocks, hanging] = r;
      const st = THREE.MathUtils.clamp(stage | 0, 0, GROWN);
      const ph = PHASES[phase] ?? 'rest';
      const t = this.addTree(x, z, rotY, st, growT, ph, phaseT, knocks, hanging);
      if (ph === 'ripe' && !t.hanging) t.phase = 'rest';
      // Older saves hung green apples while ripening: they show only when ripe now
      if (ph === 'fruit') t.hanging = 0;
    }
    for (const [x, y, z, age] of data.a ?? []) {
      if ((age ?? 0) >= LOOSE_LIFETIME) continue;
      this.spawnLoose(new THREE.Vector3(x, y + 0.02, z), new THREE.Quaternion(), 0, 0, 0, true, Math.max(PICKUP_DELAY, age ?? 0));
    }
  }

  public clear(): void {
    for (const t of this.trees) {
      if (t.extId) this.feller?.unregisterExternal(t.extId);
      this.dropBody(t);
    }
    this.trees.length = 0;
    while (this.loose.length) this.removeLoose(this.loose.length - 1);
    this.treesDirty = this.fruitDirty = this.looseDirty = true;
    this.revision++;
  }

  /** Shadow discs for the static shadows (crown radius scaled with the tree). */
  public forEachCanopy(fn: (x: number, z: number, r: number) => void): void {
    for (const t of this.trees) if (t.fall < 0) fn(t.pos.x, t.pos.z, 2.2 * STAGE_SCALE[t.stage]);
  }

  /** Developer shortcut: every tree grown, `phase` (default ripe) reached. */
  public devGrow(phase: Phase = 'ripe'): void {
    for (const t of this.trees) {
      if (t.fall >= 0 || t.cut) continue;
      t.stage = GROWN;
      t.growT = 0;
      t.shown = STAGE_SCALE[GROWN];
      t.phase = phase;
      t.phaseT = 0;
      t.knocks = 0;
      t.hanging = phase === 'ripe' ? (1 << FRUIT_PER_TREE) - 1 : 0;
      this.syncBody(t);
    }
    this.treesDirty = this.fruitDirty = true;
    this.revision++;
  }

  public get treeCount(): number {
    return this.trees.length;
  }

  public get looseCount(): number {
    return this.loose.length;
  }
}

/** Where a strike on the trunk lands: its surface facing the player, at chest height. */
const PropAt = {
  _v: new THREE.Vector3(),
  trunk(t: AppleTree, direction: THREE.Vector3, trunkRadius: number): THREE.Vector3 {
    const s = STAGE_SCALE[t.stage];
    return PropAt._v.copy(t.pos).addScaledVector(direction, -trunkRadius * s).setY(t.pos.y + Math.min(1.1, 2 * s));
  },
};
