import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { COLLISION_GROUPS } from '../config/constants';
import { PropSystem, PropInstance, PROP_DEF_MAP } from '../world/PropSystem';
import { ParticleManager } from '../particles/ParticleManager';
import { audioEngine } from '../audio/AudioEngine';
import { GATHERING_CONFIG } from './GatheringConfig';
import { TREE_MATERIAL, getTreeLods } from '../world/TreeModels';
import { CUT_APEX, buildNotchedTree, splitAtCut } from '../world/TreeNotch';
import { acquireDither, releaseDither, setDitherFade } from '../world/LodDither';
import type { BushSway } from '../world/BushSway';
import type { FallingLeaves } from '../particles/FallingLeaves';

/** Placeable prop types that can be chopped with the axe. */
const CHOPPABLE = new Set(['tree_pine', 'tree_round', 'bush']);
/** Axe hits to clear a bush; a cleared bush is gone for good (removed from the saved world). */
const BUSH_HITS = 2;
/** Wood a cleared bush gives (one small log flies to the player). */
const BUSH_WOOD = 1;
/** The cleared bush jolts this long (s) before it is torn out. */
const BUSH_TEAR_DELAY = 0.3;
/** Trunk radius of a prop tree at scale 1: its collider's (the oak's trunk is much thicker than the pine's). */
function trunkRadius(type: string): number {
  if (type === 'bush') return 0.6;
  const c = PROP_DEF_MAP.get(type)?.collider;
  return c && c.kind === 'cyl' ? c.r : 0.35;
}
const FALL_SECONDS = 1.1;
/** The cut-off top lies on the ground this long after the last hit, then shrinks away (s). */
const LIE_SECONDS = 2;
/** ...and at least this long after it hits the ground (tall pines take longer to fall). */
const LIE_AFTER_LANDING = 0.8;
/** ...then dissolves (dithered, like the LOD crossfade) over this long (s). */
const VANISH_SECONDS = 0.7;
/** Wood logs that fly from the fallen tree to the player. */
const LOG_COUNT = 4;
const LOG_FLIGHT = 0.75;
const LOG_STAGGER = 0.1;
const LOG_GEOMETRY = new THREE.CylinderGeometry(0.11, 0.12, 0.55, 8);
const LOG_MATERIALS = [
  new THREE.MeshLambertMaterial({ color: 0x6b4a2b }),
  new THREE.MeshLambertMaterial({ color: 0xe0b26a }),
  new THREE.MeshLambertMaterial({ color: 0xe0b26a }),
];

interface FlyingLog {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  /** Seconds into the flight (negative = still waiting its turn). */
  t: number;
  spin: THREE.Vector3;
  wood: number;
}

/** The cut-off top as a Rapier body: a trunk cylinder plus a ball for the crown. */
interface FallBody {
  /** Origin at the cut (the hinge), no yaw. */
  body: RAPIER.RigidBody;
  /** Fixed anchor the top hinges on. */
  anchor: RAPIER.RigidBody | null;
  /** The tree's own yaw, applied to the mesh on top of the body's rotation. */
  yaw: THREE.Quaternion;
  /** Length of the top from the cut, and its crown centre (from the cut) and radius (m). */
  len: number;
  crownMid: number;
  crownR: number;
  prevTilt: number;
  landed: boolean;
  /** When it began to dissolve (s after the last hit). */
  vanishAt: number;
}

/** Average gap (s) between leaves letting go of trees near the player, and how far out (m). */
const AMBIENT_LEAF_GAP = 0.45;
const AMBIENT_LEAF_RADIUS = 22;
/** Average gap (s) between gusts that whirl leaves up near the player. */
const GUST_GAP = 50;

/** Colour of the leaves a tree sheds. */
const LEAF_COLOR: Record<string, number> = { tree_round: 0x4a8a2e, tree_pine: 0x2f6a55, bush: 0x3f8a3a };
/**
 * Hits to fell a prop tree: one fewer than the forest's, so the tree goes over on the hit that
 * shows the deep "X" (it no longer stands on a hair-thin core waiting for one more swing).
 */
const PROP_TREE_HITS = GATHERING_CONFIG.TREE_HITS - 1;

export interface PropTreeNode {
  propId: number;
  position: THREE.Vector3;
  radius: number;
  health: number;
  maxHealth: number;
  /** A bush (cleared for good) rather than a tree. */
  bush?: boolean;
}

interface TreeState {
  health: number;
  wobble: number;
  fallAxis: THREE.Vector3;
  /** Seconds into the fall animation, -1 while standing. */
  fall: number;
  felledAt: number;
  regrow: number;
  /** The stump prop placed after felling. */
  stumpId: number | null;
  /** The falling top's physics body (null without the models, which keeps the old animation). */
  physics: FallBody | null;
  /** Stand-alone tree with the notched trunk, drawn instead of the instance while it is being chopped. */
  visual: {
    group: THREE.Group;
    mesh: THREE.Mesh;
    stage: number;
    phi: number;
    /** After the last hit: the top falling about the break (null once it is gone). */
    top: THREE.Group | null;
  } | null;
}

type Pose = { axis: THREE.Vector3; angle: number; scale: number };

/** Cut stage shown after `hitsDone` hits (same steps as the forest zone's trees). */
function cutStage(hitsDone: number): number {
  return hitsDone >= 4 ? 3 : hitsDone >= 2 ? 2 : hitsDone >= 1 ? 1 : 0;
}

/**
 * Makes the decorative trees of the PropSystem (default ring forest and editor-placed ones) choppable.
 * Trees stay instanced: hits, the fall and regrowth are drawn through PropSystem.setPose, so a forest
 * costs nothing extra until a tree is touched. Wood goes straight into the backpack on the fall.
 */
export class PropTreeField {
  public onWood: ((amount: number, at: THREE.Vector3) => void) | null = null;
  /** Where the wood logs fly to (the player); without it the wood is given at once. */
  public getCollector: (() => THREE.Vector3) | null = null;
  private readonly states = new Map<number, TreeState>();
  private readonly logs: FlyingLog[] = [];
  /** Shakes bushes on a hit (the engine sets it). */
  public bushSway: BushSway | null = null;
  /** Leaves shaken off on hits and when a tree lands (the engine sets it). */
  public leaves: FallingLeaves | null = null;
  /** Leaves letting go of trees and gusts near the player (off in caves and the editor). */
  public ambientLeaves = true;
  private ambientTimer = 1;
  private gustTimer = 20;
  /** Gusts of leaves only in calm, dry weather (the engine sets it: no rain, snow or storm). */
  public gustsAllowed = true;
  private ambientX = 0;
  private ambientZ = 0;
  private ambientBest: PropInstance | null = null;
  private ambientBestD = Infinity;
  private readonly crowns = new Map<string, { y: number; r: number; h: number }>();
  /** Bushes on their last hit: seconds until they are torn out. */
  private readonly dyingBushes = new Map<number, number>();
  /** Hits left per bush being chopped. */
  private readonly bushHealth = new Map<number, number>();
  private static readonly _v = new THREE.Vector3();
  private static readonly _q = new THREE.Quaternion();
  private static readonly _up = new THREE.Vector3(0, 1, 0);
  private static readonly HIDDEN: Pose = { axis: new THREE.Vector3(1, 0, 0), angle: 0, scale: 0 };

  constructor(
    private readonly props: PropSystem,
    private readonly particles: ParticleManager | null,
    private readonly physics: PhysicsWorld | null = null,
  ) {}

  /** Nearest standing prop tree whose trunk surface is within `reach` of `point`. */
  public findNearest(point: THREE.Vector3, reach: number): PropTreeNode | null {
    let best: PropInstance | null = null;
    let bestDist = Infinity;
    this.props.forEachNear(point.x, point.z, reach + 1, (p) => {
      if (!CHOPPABLE.has(p.type)) return;
      const st = this.states.get(p.id);
      if (st && st.fall >= 0) return;
      if (this.dyingBushes.has(p.id)) return;
      // Bushes only when no tree trunk is in reach (a tree is the likelier target)
      if (p.type === 'bush' && best && best.type !== 'bush') return;
      const dy = point.y - p.position.y;
      if (dy < -2 || dy > 4) return;
      const dist = Math.hypot(point.x - p.position.x, point.z - p.position.z) - trunkRadius(p.type) * p.scale;
      const treeOverBush = best !== null && best.type === 'bush' && p.type !== 'bush';
      if (dist <= reach && (dist < bestDist || treeOverBush)) {
        best = p;
        bestDist = dist;
      }
    });
    if (!best) return null;
    const found = best as PropInstance;
    if (found.type === 'bush') {
      return {
        propId: found.id,
        position: found.position.clone(),
        radius: trunkRadius('bush') * found.scale,
        health: this.bushHealth.get(found.id) ?? BUSH_HITS,
        maxHealth: BUSH_HITS,
        bush: true,
      };
    }
    const st = this.states.get(found.id);
    return {
      propId: found.id,
      position: found.position.clone(),
      radius: trunkRadius(found.type) * found.scale,
      health: st ? st.health : PROP_TREE_HITS,
      maxHealth: PROP_TREE_HITS,
    };
  }

  /** One axe hit. Returns true when the tree fell. */
  public hit(node: PropTreeNode, direction: THREE.Vector3): boolean {
    const prop = this.props.get(node.propId);
    if (!prop) return false;
    if (prop.type === 'bush') return this.hitBush(prop, direction);
    let st = this.states.get(node.propId);
    if (!st) {
      st = { health: PROP_TREE_HITS, wobble: 0, fallAxis: new THREE.Vector3(1, 0, 0), fall: -1, felledAt: 0, regrow: 0, stumpId: null, physics: null, visual: null };
      this.states.set(node.propId, st);
    }
    if (st.fall >= 0) return false;

    // Falls away from the player: tilt axis is perpendicular to the strike direction
    st.fallAxis.set(direction.z, 0, -direction.x).normalize();
    st.health -= 1;
    st.wobble = 1;
    this.showCut(node.propId, prop, st, direction);

    const surface = PropTreeField._v.copy(prop.position).addScaledVector(direction, -node.radius).setY(prop.position.y + 1);
    this.particles?.emitWoodSplinters(surface.clone(), direction.clone().negate(), 10);
    // Every hit shakes leaves out of the crown
    const crown = this.crownOf(prop.type);
    this.shedLeaves(prop.type, prop.position.clone().setY(prop.position.y + crown.y * prop.scale), crown.r * 0.8 * prop.scale, crown.h * 0.5 * prop.scale, 14);

    if (st.health > 0) {
      audioEngine.at(surface).playWoodChopHit(false);
      return false;
    }

    st.fall = 0;
    this.props.setSolid(node.propId, false);
    this.splitVisual(prop, st);
    if (st.visual?.top) {
      // The tree's own stump stays; a stump prop under it gives the collider
      this.plantStump(prop, st, true);
      st.physics = this.makeFallBody(prop, st);
    }
    audioEngine.at(surface).playWoodChopHit(true);
    audioEngine.at(prop.position, 5).playTreeFallCreak();
    return true;
  }

  /** A bush hit: it shakes and sheds leaves; the last hit clears it for good. */
  private hitBush(prop: PropInstance, direction: THREE.Vector3): boolean {
    const left = (this.bushHealth.get(prop.id) ?? BUSH_HITS) - 1;
    const centre = prop.position.clone().setY(prop.position.y + 0.5 * prop.scale);
    // A hard jolt, a shiver and a burst of leaves thrown outwards
    this.leaves?.emit(centre, 0.55 * prop.scale, 0.45 * prop.scale, left > 0 ? 22 : 44, LEAF_COLOR.bush, left > 0 ? 1.8 : 2.8);
    this.particles?.emitTreeFoliageLeaves(centre, left > 0 ? 6 : 14);
    audioEngine.at(centre, 4).playBushChop(left <= 0);
    if (left > 0) {
      this.bushHealth.set(prop.id, left);
      this.bushSway?.kick(prop, direction, 1);
      return false;
    }
    // The last hit throws it hard over; it is torn out a moment later (seen to react first)
    this.bushHealth.delete(prop.id);
    this.bushSway?.kick(prop, direction, 1.5);
    this.dyingBushes.set(prop.id, BUSH_TEAR_DELAY);
    this.spawnLogs([centre], BUSH_WOOD, prop.position);
    return true;
  }

  private updateDyingBushes(dt: number): void {
    for (const [id, t] of this.dyingBushes) {
      if (t - dt > 0) {
        this.dyingBushes.set(id, t - dt);
        continue;
      }
      this.dyingBushes.delete(id);
      this.bushSway?.forget(id);
      const prop = this.props.get(id);
      if (!prop) continue;
      const centre = PropTreeField._v.copy(prop.position).setY(prop.position.y + 0.45 * prop.scale);
      this.particles?.emitBuildPuff(centre, true, 18);
      this.leaves?.emit(centre, 0.5 * prop.scale, 0.4 * prop.scale, 20, LEAF_COLOR.bush, 2.2);
      this.props.remove(id);
    }
  }

  /**
   * Now and then a leaf lets go of a tree near the player (cheap: a few leaves a second at most,
   * one nearby-cell lookup per drop), and once in a while a gust lifts a whirl of leaves.
   */
  private updateAmbientLeaves(dt: number): void {
    const leaves = this.leaves;
    const collector = this.getCollector?.();
    if (!leaves || !collector || !this.ambientLeaves) return;
    this.ambientTimer -= dt;
    if (this.ambientTimer <= 0) {
      this.ambientTimer = AMBIENT_LEAF_GAP * (0.4 + Math.random() * 1.2);
      // A random spot around the player, then the nearest tree there
      const a = Math.random() * Math.PI * 2;
      const d = 4 + Math.random() * AMBIENT_LEAF_RADIUS;
      const x = collector.x + Math.cos(a) * d;
      const z = collector.z + Math.sin(a) * d;
      this.ambientBest = null;
      this.ambientBestD = Infinity;
      this.ambientX = x;
      this.ambientZ = z;
      this.props.forEachNear(x, z, 6, this.ambientVisit);
      const tree = this.ambientBest as PropInstance | null;
      if (tree && !this.states.has(tree.id)) {
        const crown = this.crownOf(tree.type);
        const s = tree.scale;
        const at = PropTreeField._v.set(tree.position.x, tree.position.y + crown.y * s, tree.position.z);
        leaves.emit(at, crown.r * 0.85 * s, crown.h * 0.6 * s, 1 + (Math.random() < 0.35 ? 1 : 0), LEAF_COLOR[tree.type] ?? 0x4f8f35, 0.3);
      }
    }
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      // Uneven: sometimes two fairly close together, sometimes a long lull
      this.gustTimer = GUST_GAP * (0.35 + Math.random() * Math.random() * 2.2);
      if (!this.gustsAllowed) return;
      leaves.whirl(collector, Math.random() < 0.5 ? 0x4a8a2e : 0x6f9a3a);
    }
  }

  private readonly ambientVisit = (p: PropInstance): void => {
    if (p.type !== 'tree_round' && p.type !== 'tree_pine') return;
    const d = (p.position.x - this.ambientX) ** 2 + (p.position.z - this.ambientZ) ** 2;
    if (d < this.ambientBestD) {
      this.ambientBestD = d;
      this.ambientBest = p;
    }
  };

  /** True while a prop tree is falling, felled (stump) or not yet regrown. */
  public isDown(propId: number): boolean {
    const st = this.states.get(propId);
    return !!st && (st.fall >= 0 || st.stumpId !== null || (st.regrow > 0 && st.regrow < 1));
  }

  public update(dt: number): void {
    if (this.logs.length) this.updateLogs(dt);
    if (this.dyingBushes.size) this.updateDyingBushes(dt);
    this.updateAmbientLeaves(dt);
    if (this.states.size === 0) return;
    const now = performance.now();
    for (const [id, st] of this.states) {
      const prop = this.props.get(id);
      if (!prop) {
        // Deleted in the editor
        this.dropBody(st);
        this.dropVisual(st);
        if (st.stumpId !== null) this.props.remove(st.stumpId);
        this.states.delete(id);
        continue;
      }

      if (st.fall < 0) {
        // Standing: hit wobble, or regrowing after being felled
        if (st.wobble > 0) {
          st.wobble = Math.max(0, st.wobble - dt * 3);
          const angle = Math.sin(st.wobble * 18) * st.wobble * 0.05;
          this.pose(id, prop, st, st.wobble > 0 ? { axis: st.fallAxis, angle, scale: 1 } : null);
          if (st.wobble === 0 && st.health === PROP_TREE_HITS) {
            this.dropVisual(st);
            this.states.delete(id);
          }
        } else if (st.regrow > 0) {
          st.regrow = Math.min(1, st.regrow + dt * 0.5);
          const t = st.regrow;
          const pop = 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
          this.props.setPose(id, t < 1 ? { axis: st.fallAxis, angle: 0, scale: Math.max(0.01, pop) } : null);
          if (t >= 1) this.states.delete(id);
        }
        continue;
      }

      if (st.physics) {
        st.fall += dt;
        this.updateFallBody(prop, st, st.physics);
        if (st.fall >= st.physics.vanishAt + VANISH_SECONDS) this.finishFall(id, prop, st, now);
        continue;
      }

      if (st.fall < FALL_SECONDS && st.stumpId === null) {
        st.fall += dt;
        const t = Math.min(1, st.fall / FALL_SECONDS);
        // Accelerating topple, shrinking away in the last third so the trunk never sinks into terrain
        const angle = (Math.PI / 2) * t * t;
        const scale = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
        this.pose(id, prop, st, { axis: st.fallAxis, angle, scale });
        if (t >= 1) {
          const ownStump = !!st.visual;
          this.plantStump(prop, st, ownStump);
          const tip = prop.position.clone().add(new THREE.Vector3().crossVectors(st.fallAxis, PropTreeField._up).multiplyScalar(2.5 * prop.scale));
          tip.y = prop.position.y + 0.6;
          this.particles?.emitTreeFoliageLeaves(tip, 22);
          this.particles?.emitBuildPuff(tip, true, 16);
          this.finishFall(id, prop, st, now, [tip]);
        }
        continue;
      }

      if (now - st.felledAt >= GATHERING_CONFIG.TREE_REGROW_SECONDS * 1000) {
        if (st.stumpId !== null) this.props.remove(st.stumpId);
        this.dropVisual(st);
        st.stumpId = null;
        st.fall = -1;
        st.health = PROP_TREE_HITS;
        st.regrow = 0.001;
        this.props.setSolid(id, true);
        this.particles?.emitTreeFoliageLeaves(prop.position.clone().setY(prop.position.y + 1.5), 12);
      }
    }
  }

  /**
   * Swaps the instanced tree for a stand-alone copy whose own trunk has the cut carved in (first
   * hit), then re-carves it for the stage the hits so far reach. The notch faces the player.
   */
  private showCut(id: number, prop: PropInstance, st: TreeState, direction: THREE.Vector3): void {
    const source = getTreeLods()?.[prop.type]?.[0];
    if (!source) return;
    const stage = cutStage(PROP_TREE_HITS - st.health);
    if (st.visual && st.visual.stage === stage) return;
    if (!st.visual) {
      // Strike side in the tree's local frame (against the swing, towards the player)
      const phi = Math.atan2(-direction.x, -direction.z) - prop.rotationY;
      const mesh = new THREE.Mesh(buildNotchedTree(source, stage, phi), TREE_MATERIAL);
      const group = new THREE.Group();
      group.name = `ChoppedTree_${id}`;
      group.add(mesh);
      this.props.group.add(group);
      st.visual = { group, mesh, stage, phi, top: null };
      this.props.setPose(id, PropTreeField.HIDDEN);
      this.placeVisual(prop, st, null);
      return;
    }
    st.visual.mesh.geometry.dispose();
    st.visual.mesh.geometry = buildNotchedTree(source, stage, st.visual.phi);
    st.visual.stage = stage;
  }

  /**
   * Last hit: the stump (everything below the "X") stays where the tree stood, the top becomes its
   * own piece pivoting at the break so the fall starts from the cut.
   */
  private splitVisual(prop: PropInstance, st: TreeState): void {
    const v = st.visual;
    if (!v) return;
    const { stump, top } = splitAtCut(v.mesh.geometry);
    v.mesh.geometry.dispose();
    v.mesh.geometry = stump;
    const topMesh = new THREE.Mesh(top, TREE_MATERIAL);
    topMesh.position.y = -CUT_APEX;
    const pivot = new THREE.Group();
    pivot.name = v.group.name + '_top';
    pivot.add(topMesh);
    this.props.group.add(pivot);
    v.top = pivot;
    this.placeVisual(prop, st, null);
  }

  /** Poses the chopped copy when there is one (the instance stays hidden), else the instance. */
  private pose(id: number, prop: PropInstance, st: TreeState, pose: Pose | null): void {
    if (st.visual) this.placeVisual(prop, st, pose);
    else this.props.setPose(id, pose);
  }

  private placeVisual(prop: PropInstance, st: TreeState, pose: Pose | null): void {
    const v = st.visual!;
    if (v.top) {
      // Split: the stump stands still, the top tilts about the break
      v.group.position.copy(prop.position);
      v.group.quaternion.setFromAxisAngle(PropTreeField._up, prop.rotationY);
      v.group.scale.setScalar(prop.scale);
      v.top.position.copy(prop.position);
      v.top.position.y += CUT_APEX * prop.scale;
      v.top.quaternion.copy(v.group.quaternion);
      if (pose) v.top.quaternion.premultiply(PropTreeField._q.setFromAxisAngle(pose.axis, pose.angle));
      v.top.scale.setScalar(prop.scale * (pose ? Math.max(pose.scale, 1e-4) : 1));
      return;
    }
    const g = v.group;
    g.position.copy(prop.position);
    g.quaternion.setFromAxisAngle(PropTreeField._up, prop.rotationY);
    if (pose) g.quaternion.premultiply(PropTreeField._q.setFromAxisAngle(pose.axis, pose.angle));
    g.scale.setScalar(prop.scale * (pose ? Math.max(pose.scale, 1e-4) : 1));
  }

  private dropVisual(st: TreeState): void {
    if (!st.visual) return;
    this.dropTop(st);
    st.visual.group.removeFromParent();
    st.visual.mesh.geometry.dispose();
    st.visual = null;
  }

  private dropTop(st: TreeState): void {
    const top = st.visual?.top;
    if (!top) return;
    top.removeFromParent();
    const mesh = top.children[0] as THREE.Mesh;
    if (mesh.material !== TREE_MATERIAL) releaseDither([mesh.material as THREE.Material]);
    mesh.geometry.dispose();
    st.visual!.top = null;
  }

  /** The stump is a regular prop (collisions and lighting for free) that is never saved. */
  private plantStump(prop: PropInstance, st: TreeState, ownStump: boolean): void {
    if (st.stumpId !== null) return;
    st.stumpId = this.props.add('stump', prop.position.x, prop.position.z, prop.rotationY, prop.scale, prop.position.y, prop.grounded);
    if (st.stumpId !== null) {
      this.props.setTransient(st.stumpId);
      // Its collider stays; the look comes from the tree's own stump
      if (ownStump) this.props.setPose(st.stumpId, PropTreeField.HIDDEN);
    }
  }

  /**
   * Physics for the cut-off top, fitted to its own mesh: a cylinder as long and thick as the
   * visible trunk above the cut, and a ball filling the crown (so it lands on its crown instead of
   * sinking it into the ground). It turns on a hinge at the cut, about the axis across the swing,
   * so it can only go over away from the player and never swings back. It touches only the
   * terrain: no stumps, rocks, trees, buildings or the player.
   */
  private makeFallBody(prop: PropInstance, st: TreeState): FallBody | null {
    const phys = this.physics;
    const top = st.visual?.top;
    if (!phys?.isInitialized() || !top) return null;
    const R = phys.rapier;
    const geo = (top.children[0] as THREE.Mesh).geometry;
    const P = geo.getAttribute('position');
    const C = geo.getAttribute('color');
    const green = (i: number) => !!C && C.getY(i) > C.getX(i) && C.getY(i) > C.getZ(i);
    // Bark right above the cut gives the trunk's radius there
    let rCut = 0;
    for (let i = 0; i < P.count; i++) {
      const y = P.getY(i);
      if (!green(i) && y > CUT_APEX && y < CUT_APEX + 0.5) rCut = Math.max(rCut, Math.hypot(P.getX(i), P.getZ(i)));
    }
    if (rCut <= 0) rCut = trunkRadius(prop.type);
    // Trunk height: the highest bark near the axis (branches reaching out don't count)
    let trunkTop = CUT_APEX + 1;
    let rHigh = rCut;
    let maxY = CUT_APEX + 1;
    let crownY = Infinity;
    let crownR = 0;
    for (let i = 0; i < P.count; i++) {
      const y = P.getY(i);
      const d = Math.hypot(P.getX(i), P.getZ(i));
      maxY = Math.max(maxY, y);
      if (green(i)) {
        crownY = Math.min(crownY, y);
        crownR = Math.max(crownR, d);
      } else if (d < rCut * 1.3 && y > trunkTop) {
        trunkTop = y;
      }
    }
    for (let i = 0; i < P.count; i++) {
      const y = P.getY(i);
      if (!green(i) && y > trunkTop - 0.4 && y <= trunkTop) rHigh = Math.min(rHigh, Math.max(0.05, Math.hypot(P.getX(i), P.getZ(i))));
    }
    const sc = prop.scale;
    const trunkLen = (trunkTop - CUT_APEX) * sc;
    const trunkR = ((rCut + rHigh) / 2) * sc;
    if (!Number.isFinite(crownY)) crownY = (CUT_APEX + maxY) / 2;
    const cut = PropTreeField._v.copy(prop.position).setY(prop.position.y + CUT_APEX * sc);
    // The body has no yaw of its own (its colliders are round); the mesh adds the tree's yaw
    const body = phys.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(cut.x, cut.y, cut.z).setLinearDamping(0.05).setAngularDamping(0.05).setCcdEnabled(true)
        // A real 10 m pine takes ~3 s to go over, which reads as slow motion here: stronger
        // gravity the taller the top, so every tree falls in about the same snappy second
        .setGravityScale(THREE.MathUtils.clamp(((maxY - CUT_APEX) * sc) / 3, 1.6, 3.4)),
    );
    // A felled tree can't be picked up and carried
    body.userData = { noCarry: true };
    const groups = phys.packCollisionGroups(COLLISION_GROUPS.DYNAMIC_PROPS, COLLISION_GROUPS.TERRAIN);
    phys.world.createCollider(
      R.ColliderDesc.cylinder(trunkLen / 2, Math.max(0.06, trunkR)).setTranslation(0, trunkLen / 2, 0)
        .setDensity(500).setFriction(0.9).setRestitution(0).setCollisionGroups(groups),
      body,
    );
    const crownBall = Math.max(0.3, Math.min(crownR, (maxY - crownY) / 2) * sc * 0.8);
    const crownMid = ((crownY + maxY) / 2 - CUT_APEX) * sc;
    phys.world.createCollider(
      R.ColliderDesc.ball(crownBall).setTranslation(0, crownMid, 0).setDensity(40).setFriction(1).setRestitution(0).setCollisionGroups(groups),
      body,
    );
    const anchor = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(cut.x, cut.y, cut.z));
    const ax = st.fallAxis;
    phys.world.createImpulseJoint(R.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: ax.x, y: ax.y, z: ax.z }), anchor, body, true);
    body.setAngvel({ x: ax.x * 0.8, y: ax.y * 0.8, z: ax.z * 0.8 }, true);
    const yaw = new THREE.Quaternion().setFromAxisAngle(PropTreeField._up, prop.rotationY);
    return { body, anchor, yaw, len: (maxY - CUT_APEX) * sc, crownMid, crownR: crownR * sc, prevTilt: 0, landed: false, vanishAt: Infinity };
  }

  /** Puts the top where its body is, thuds and sheds leaves on landing, shrinks at the end. */
  private updateFallBody(prop: PropInstance, st: TreeState, f: FallBody): void {
    const top = st.visual?.top;
    if (!top) return;
    const t = f.body.translation();
    const q = f.body.rotation();
    top.quaternion.set(q.x, q.y, q.z, q.w).multiply(f.yaw);
    top.position.set(t.x, t.y, t.z);
    const up = PropTreeField._v.set(0, 1, 0).applyQuaternion(top.quaternion);
    const tilt = Math.acos(THREE.MathUtils.clamp(up.y, -1, 1));
    const stopped = tilt > 0.6 && tilt - f.prevTilt < 0.002;
    f.prevTilt = tilt;
    if (!f.landed && (stopped || st.fall > 4)) {
      f.landed = true;
      f.vanishAt = Math.max(LIE_SECONDS, st.fall + LIE_AFTER_LANDING);
      const crown = top.position.clone().addScaledVector(up, f.crownMid);
      audioEngine.at(crown, 5).playTreeImpact();
      this.shedLeaves(prop.type, crown, Math.max(1, f.crownR), 1.2, 40);
      this.particles?.emitBuildPuff(crown.setY(Math.max(crown.y - 0.8, prop.position.y)), true, 16);
    }
    top.scale.setScalar(prop.scale);
    if (st.fall > f.vanishAt) {
      // Dissolve with the LOD crossfade's screen-door dither (no shrinking into the ground)
      const mesh = top.children[0] as THREE.Mesh;
      if (mesh.material === TREE_MATERIAL) mesh.material = acquireDither(TREE_MATERIAL, true);
      setDitherFade([mesh.material as THREE.Material], Math.min(1, (st.fall - f.vanishAt) / VANISH_SECONDS));
    }
  }

  /** Leaves fluttering out of a crown, in that tree's colour. */
  private shedLeaves(type: string, centre: THREE.Vector3, radius: number, height: number, count: number): void {
    this.leaves?.emit(centre, radius, height, count, LEAF_COLOR[type] ?? 0x4f8f35);
  }

  /** Where a standing tree's crown is (from its far LOD, cached per type). */
  private crownOf(type: string): { y: number; r: number; h: number } {
    let c = this.crowns.get(type);
    if (c) return c;
    const g = getTreeLods()?.[type]?.[2];
    c = { y: 3, r: 1.5, h: 2 };
    if (g) {
      const P = g.getAttribute('position');
      const C = g.getAttribute('color');
      let y0 = Infinity, y1 = -Infinity, r = 0;
      for (let i = 0; i < P.count; i++) {
        if (!(C.getY(i) > C.getX(i) && C.getY(i) > C.getZ(i))) continue;
        y0 = Math.min(y0, P.getY(i));
        y1 = Math.max(y1, P.getY(i));
        r = Math.max(r, Math.hypot(P.getX(i), P.getZ(i)));
      }
      if (Number.isFinite(y0)) c = { y: (y0 + y1) / 2, r, h: y1 - y0 };
      this.crowns.set(type, c);
    }
    return c;
  }

  private dropBody(st: TreeState): void {
    const f = st.physics;
    if (!f) return;
    const w = this.physics?.world;
    if (w) {
      if (f.anchor) w.removeRigidBody(f.anchor);
      w.removeRigidBody(f.body);
    }
    st.physics = null;
  }

  /**
   * The top is gone: wood logs leave from along where it lay and fly to the player (the wood is
   * given as they arrive), and the regrow timer starts.
   */
  private finishFall(id: number, prop: PropInstance, st: TreeState, now: number, from?: THREE.Vector3[]): void {
    const starts: THREE.Vector3[] = from ? [...from] : [];
    const top = st.visual?.top;
    if (!from && top && st.physics) {
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(top.quaternion);
      const len = st.physics.len;
      for (let i = 0; i < LOG_COUNT; i++) {
        starts.push(top.position.clone().addScaledVector(up, len * (0.12 + 0.55 * (i / (LOG_COUNT - 1)))));
      }
      this.shedLeaves(prop.type, top.position.clone().addScaledVector(up, st.physics.crownMid), Math.max(1, st.physics.crownR), 1, 24);
    }
    this.dropBody(st);
    this.dropTop(st);
    st.felledAt = now;
    st.fall = FALL_SECONDS;
    this.props.setPose(id, { axis: st.fallAxis, angle: 0, scale: 0 });
    this.spawnLogs(starts.length ? starts : [prop.position.clone().setY(prop.position.y + 1)], GATHERING_CONFIG.TREE_WOOD_YIELD, prop.position);
  }

  private spawnLogs(starts: THREE.Vector3[], wood: number, at: THREE.Vector3): void {
    if (!this.getCollector) {
      this.onWood?.(wood, at.clone());
      return;
    }
    const n = Math.max(1, Math.min(LOG_COUNT, wood));
    const each = Math.floor(wood / n);
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(LOG_GEOMETRY, LOG_MATERIALS);
      mesh.name = 'WoodLog';
      const from = starts[i % starts.length].clone();
      from.y += 0.3;
      mesh.position.copy(from);
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      this.props.group.add(mesh);
      this.logs.push({
        mesh, from, t: -i * LOG_STAGGER,
        spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(14),
        wood: i === n - 1 ? wood - each * (n - 1) : each,
      });
    }
  }

  /** Logs fly along an arc into the player (following them as they move), spinning. */
  private updateLogs(dt: number): void {
    const to = this.getCollector?.();
    for (let i = this.logs.length - 1; i >= 0; i--) {
      const l = this.logs[i];
      l.t += dt;
      if (l.t < 0) continue;
      const k = Math.min(1, l.t / LOG_FLIGHT);
      const e = k * k * (3 - 2 * k);
      const target = PropTreeField._v.copy(to ?? l.from).setY((to ?? l.from).y + 0.9);
      const dist = l.from.distanceTo(target);
      l.mesh.position.lerpVectors(l.from, target, e);
      l.mesh.position.y += Math.sin(Math.PI * k) * (1.2 + dist * 0.25);
      l.mesh.rotation.x += l.spin.x * dt;
      l.mesh.rotation.y += l.spin.y * dt;
      l.mesh.rotation.z += l.spin.z * dt;
      l.mesh.scale.setScalar(k > 0.85 ? 1 - (k - 0.85) / 0.15 * 0.7 : Math.min(1, 0.4 + l.t * 4));
      if (k >= 1) {
        l.mesh.removeFromParent();
        this.logs.splice(i, 1);
        if (l.wood > 0) this.onWood?.(l.wood, target.clone());
      }
    }
  }
}
