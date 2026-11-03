import * as THREE from 'three';
import { PropSystem, PropInstance } from '../world/PropSystem';
import { ParticleManager } from '../particles/ParticleManager';
import { audioEngine } from '../audio/AudioEngine';
import { GATHERING_CONFIG } from './GatheringConfig';

/** Placeable prop types that can be chopped with the axe. */
const CHOPPABLE = new Set(['tree_pine', 'tree_round']);
/** Trunk radius of the prop trees at scale 1 (matches their colliders). */
const TRUNK_RADIUS = 0.35;
const FALL_SECONDS = 1.1;

export interface PropTreeNode {
  propId: number;
  position: THREE.Vector3;
  radius: number;
  health: number;
  maxHealth: number;
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
}

/**
 * Makes the decorative trees of the PropSystem (default ring forest and editor-placed ones) choppable.
 * Trees stay instanced: hits, the fall and regrowth are drawn through PropSystem.setPose, so a forest
 * costs nothing extra until a tree is touched. Wood goes straight into the backpack on the fall.
 */
export class PropTreeField {
  public onWood: ((amount: number, at: THREE.Vector3) => void) | null = null;
  private readonly states = new Map<number, TreeState>();
  private static readonly _v = new THREE.Vector3();

  constructor(private readonly props: PropSystem, private readonly particles: ParticleManager | null) {}

  /** Nearest standing prop tree whose trunk surface is within `reach` of `point`. */
  public findNearest(point: THREE.Vector3, reach: number): PropTreeNode | null {
    let best: PropInstance | null = null;
    let bestDist = Infinity;
    for (const p of this.props.list()) {
      if (!CHOPPABLE.has(p.type)) continue;
      const st = this.states.get(p.id);
      if (st && st.fall >= 0) continue;
      const dy = point.y - p.position.y;
      if (dy < -2 || dy > 4) continue;
      const dist = Math.hypot(point.x - p.position.x, point.z - p.position.z) - TRUNK_RADIUS * p.scale;
      if (dist <= reach && dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    if (!best) return null;
    const st = this.states.get(best.id);
    return {
      propId: best.id,
      position: best.position.clone(),
      radius: TRUNK_RADIUS * best.scale,
      health: st ? st.health : GATHERING_CONFIG.TREE_HITS,
      maxHealth: GATHERING_CONFIG.TREE_HITS,
    };
  }

  /** One axe hit. Returns true when the tree fell. */
  public hit(node: PropTreeNode, direction: THREE.Vector3): boolean {
    const prop = this.props.get(node.propId);
    if (!prop) return false;
    let st = this.states.get(node.propId);
    if (!st) {
      st = { health: GATHERING_CONFIG.TREE_HITS, wobble: 0, fallAxis: new THREE.Vector3(1, 0, 0), fall: -1, felledAt: 0, regrow: 0, stumpId: null };
      this.states.set(node.propId, st);
    }
    if (st.fall >= 0) return false;

    // Falls away from the player: tilt axis is perpendicular to the strike direction
    st.fallAxis.set(direction.z, 0, -direction.x).normalize();
    st.health -= 1;
    st.wobble = 1;

    const surface = PropTreeField._v.copy(prop.position).addScaledVector(direction, -node.radius).setY(prop.position.y + 1);
    this.particles?.emitWoodSplinters(surface.clone(), direction.clone().negate(), 10);
    this.particles?.emitTreeFoliageLeaves(prop.position.clone().setY(prop.position.y + 2.6 * prop.scale), 5);

    if (st.health > 0) {
      audioEngine.playWoodChopHit(false);
      return false;
    }

    st.fall = 0;
    this.props.setSolid(node.propId, false);
    audioEngine.playWoodChopHit(true);
    audioEngine.playTreeFallCreak();
    return true;
  }

  public update(dt: number): void {
    if (this.states.size === 0) return;
    const now = performance.now();
    for (const [id, st] of this.states) {
      const prop = this.props.get(id);
      if (!prop) {
        // Deleted in the editor
        if (st.stumpId !== null) this.props.remove(st.stumpId);
        this.states.delete(id);
        continue;
      }

      if (st.fall < 0) {
        // Standing: hit wobble, or regrowing after being felled
        if (st.wobble > 0) {
          st.wobble = Math.max(0, st.wobble - dt * 3);
          const angle = Math.sin(st.wobble * 18) * st.wobble * 0.05;
          this.props.setPose(id, st.wobble > 0 ? { axis: st.fallAxis, angle, scale: 1 } : null);
          if (st.wobble === 0 && st.health === GATHERING_CONFIG.TREE_HITS) this.states.delete(id);
        } else if (st.regrow > 0) {
          st.regrow = Math.min(1, st.regrow + dt * 0.5);
          const t = st.regrow;
          const pop = 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
          this.props.setPose(id, t < 1 ? { axis: st.fallAxis, angle: 0, scale: Math.max(0.01, pop) } : null);
          if (t >= 1) this.states.delete(id);
        }
        continue;
      }

      if (st.fall < FALL_SECONDS) {
        st.fall += dt;
        const t = Math.min(1, st.fall / FALL_SECONDS);
        // Accelerating topple, shrinking away in the last third so the trunk never sinks into terrain
        const angle = (Math.PI / 2) * t * t;
        const scale = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
        this.props.setPose(id, { axis: st.fallAxis, angle, scale });
        if (t >= 1) this.onFelled(id, prop, st, now);
        continue;
      }

      if (now - st.felledAt >= GATHERING_CONFIG.TREE_REGROW_SECONDS * 1000) {
        if (st.stumpId !== null) this.props.remove(st.stumpId);
        st.stumpId = null;
        st.fall = -1;
        st.health = GATHERING_CONFIG.TREE_HITS;
        st.regrow = 0.001;
        this.props.setSolid(id, true);
        this.particles?.emitTreeFoliageLeaves(prop.position.clone().setY(prop.position.y + 1.5), 12);
      }
    }
  }

  private onFelled(id: number, prop: PropInstance, st: TreeState, now: number): void {
    st.felledAt = now;
    this.props.setPose(id, { axis: st.fallAxis, angle: 0, scale: 0 });
    const tip = prop.position.clone().add(new THREE.Vector3().crossVectors(st.fallAxis, new THREE.Vector3(0, 1, 0)).multiplyScalar(2.5 * prop.scale));
    tip.y = prop.position.y + 0.6;
    this.particles?.emitTreeFoliageLeaves(tip, 22);
    this.particles?.emitBuildPuff(tip, true, 16);
    // The stump is a regular prop (collisions and lighting for free) that is never saved
    st.stumpId = this.props.add('stump', prop.position.x, prop.position.z, prop.rotationY, prop.scale, prop.position.y, prop.grounded);
    if (st.stumpId !== null) this.props.setTransient(st.stumpId);
    this.onWood?.(GATHERING_CONFIG.TREE_WOOD_YIELD, prop.position.clone());
  }
}
