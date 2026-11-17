import * as THREE from 'three';

/** Every system that acts on the interact button (E / the touch button / a click on a target). */
export type InteractKind =
  | 'door'
  | 'carry'
  | 'farm'
  | 'gather'
  | 'play'
  | 'truck'
  | 'moped'
  | 'boat';

/** Extra weight for targets that must win whenever they are offered (an object in hand, a tool's aim). */
export const FOCUS_HELD = 100;
export const FOCUS_TOOL = 1.5;

/** Facing away costs up to this many metres: of two targets at one distance, the one ahead wins. */
const FACING_WEIGHT = 1.2;
/** The current focus keeps it until another target is this much (metres) better: no flicker between two. */
const STICKY = 0.35;

interface Offer {
  kind: InteractKind;
  x: number;
  y: number;
  z: number;
  bias: number;
}

/**
 * One target for the interact button at a time, as in most games: every system that has something
 * to do on E offers it each frame (where it is, plus a bias), the focus picks the best (the nearest,
 * favouring what the player faces) at the end of the frame, and on the next frame only the winner may
 * act on a press and show its prompt. Without it a door next to a field opened the door and watered
 * the field on one press.
 *
 * Offers of frame N decide frame N+1: systems run at different points of the frame (vehicles before
 * the character, the gameplay stations after), so the decision can't wait for all of them mid-frame.
 */
class InteractionFocusImpl {
  private offers: Offer[] = [];
  private pool: Offer[] = [];
  /** The winner of the last resolve (null: nothing to interact with) */
  public current: InteractKind | null = null;

  /** Offers a target for this frame. `bias` (metres) favours it over plain distance. */
  public offer(kind: InteractKind, pos: { x: number; y: number; z: number } | null, bias = 0): void {
    const o = this.pool.pop() ?? { kind, x: 0, y: 0, z: 0, bias: 0 };
    o.kind = kind;
    o.x = pos ? pos.x : NaN;
    o.y = pos ? pos.y : NaN;
    o.z = pos ? pos.z : NaN;
    o.bias = bias;
    this.offers.push(o);
  }

  /** May this system act on the interact button (and show its prompt) this frame? */
  public allows(kind: InteractKind): boolean {
    return this.current === kind;
  }

  /** Picks the focus for the next frame from this frame's offers. Once per frame, at its end. */
  public resolve(player: THREE.Vector3, facing: THREE.Vector3): void {
    let best: InteractKind | null = null;
    let bestScore = Infinity;
    const fl = Math.hypot(facing.x, facing.z) || 1;
    for (const o of this.offers) {
      let score: number;
      if (Number.isNaN(o.x)) {
        // No place (aimed tools): as if right at the player's feet
        score = 0;
      } else {
        const dx = o.x - player.x;
        const dz = o.z - player.z;
        const d = Math.hypot(dx, dz);
        const dot = d > 1e-3 ? (dx * facing.x + dz * facing.z) / (d * fl) : 1;
        score = d + (1 - dot) * 0.5 * FACING_WEIGHT;
      }
      score -= o.bias;
      if (o.kind === this.current) score -= STICKY;
      if (score < bestScore) {
        bestScore = score;
        best = o.kind;
      }
    }
    this.current = best;
    for (const o of this.offers) this.pool.push(o);
    this.offers.length = 0;
  }

  /** Nobody may act (editor, driving, menus): drops the focus. */
  public clear(): void {
    this.current = null;
    for (const o of this.offers) this.pool.push(o);
    this.offers.length = 0;
  }
}

export const interactionFocus = new InteractionFocusImpl();
