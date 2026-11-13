/*
 * The player's hearts: three of them, counted in halves. Pests take half a heart (sharks and
 * dragon fire a whole one); after a while without being hit the hearts slowly refill, and a
 * night's sleep fills them all. Out of hearts the player faints and wakes up at the bed.
 * The HUD reads this object every frame (no React state), so it is a plain module singleton.
 */

export const MAX_HEARTS = 3;
/** Half-hearts in full health. */
export const MAX_HALVES = MAX_HEARTS * 2;
/** Seconds without a hit before the hearts begin to refill. */
const REGEN_DELAY = 10;
/** Seconds per half heart while refilling. */
const REGEN_STEP = 6;

class PlayerHealth {
  /** Current health in half-hearts (0..MAX_HALVES). */
  public halves = MAX_HALVES;
  /** performance.now() of the last hit / heal (the HUD shakes / pops the hearts). */
  public hurtAt = -1e9;
  public healedAt = -1e9;
  private sinceHit = 1e9;
  private regen = 0;

  /** Takes `halves` of damage; returns true when this blow empties the hearts. */
  public damage(halves: number): boolean {
    if (this.halves <= 0) return false;
    this.halves = Math.max(0, this.halves - halves);
    this.hurtAt = performance.now();
    this.sinceHit = 0;
    this.regen = 0;
    return this.halves <= 0;
  }

  public heal(halves: number): void {
    if (this.halves >= MAX_HALVES || halves <= 0) return;
    this.halves = Math.min(MAX_HALVES, this.halves + halves);
    this.healedAt = performance.now();
  }

  public refill(): void {
    this.heal(MAX_HALVES);
    this.sinceHit = 1e9;
  }

  public update(dt: number): void {
    this.sinceHit += dt;
    if (this.halves <= 0 || this.halves >= MAX_HALVES || this.sinceHit < REGEN_DELAY) return;
    this.regen += dt;
    if (this.regen >= REGEN_STEP) {
      this.regen -= REGEN_STEP;
      this.heal(1);
    }
  }
}

export const playerHealth = new PlayerHealth();
