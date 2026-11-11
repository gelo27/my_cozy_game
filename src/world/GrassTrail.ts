import * as THREE from 'three';

/**
 * Trampled grass: a small push field around the player, so blades bend away from the feet (and
 * paws and wheels) and straighten back up slowly, leaving a fading trail behind.
 *
 * A 64 x 64 grid of 0.5 m cells (32 m across) that wraps around the world (toroidal, like the
 * grass patch itself): a cell's slot is its world cell index modulo 64, so nothing has to shift
 * when the player walks on. The shader samples it once per blade tip with repeat wrapping, and
 * only inside the window around the focus, so old trails from 32 m away never show up again.
 *
 * Per frame on the CPU: the pushers are stamped (a few cells each), the field decays, and while
 * anything is still bent the 16 KB texture is re-sent. When nothing is bent: no work at all.
 *
 * Blue channel: footprints in fallen snow (the terrain reads it). They fill back in slowly, so
 * while only they are left the texture goes up a few times a second instead of every frame.
 */
export const TRAIL_RES = 64;
export const TRAIL_CELL = 0.5;
export const TRAIL_SIZE = TRAIL_RES * TRAIL_CELL;
/** Half the window the shader uses (a cell short of the grid, so the wrap never shows). */
export const TRAIL_HALF = TRAIL_SIZE * 0.5 - TRAIL_CELL * 2;

const MAX_PUSHERS = 12;

export class GrassTrail {
  public readonly texture: THREE.DataTexture;
  /** Window centre (world XZ) for the shader. */
  public readonly center = new THREE.Vector2();

  private readonly bytes = new Uint8Array(TRAIL_RES * TRAIL_RES * 4);
  private readonly vx = new Float32Array(TRAIL_RES * TRAIL_RES);
  private readonly vz = new Float32Array(TRAIL_RES * TRAIL_RES);
  /** Footprint depth 0..1 per cell (blue channel). */
  private readonly pr = new Float32Array(TRAIL_RES * TRAIL_RES);
  private printsLeft = false;
  private printUpload = 0;
  /** World cell each slot was last written for (x, z), to drop slots that left the window. */
  private readonly ownX = new Int32Array(TRAIL_RES * TRAIL_RES);
  private readonly ownZ = new Int32Array(TRAIL_RES * TRAIL_RES);
  private readonly pushers = new Float32Array(MAX_PUSHERS * 3);
  private pusherCount = 0;
  private active = false;
  private focusCX = 1e9;
  private focusCZ = 1e9;

  constructor() {
    this.bytes.fill(128);
    for (let i = 2; i < this.bytes.length; i += 4) this.bytes[i] = 0;
    this.texture = new THREE.DataTexture(this.bytes, TRAIL_RES, TRAIL_RES, THREE.RGBAFormat);
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
  }

  public clearPushers(): void {
    this.pusherCount = 0;
  }

  /** A body standing on the grass at (x, z), parting it within `radius` m. */
  public addPusher(x: number, z: number, radius: number): void {
    if (this.pusherCount >= MAX_PUSHERS) return;
    const o = this.pusherCount++ * 3;
    this.pushers[o] = x;
    this.pushers[o + 1] = z;
    this.pushers[o + 2] = radius;
  }

  /**
   * @param focus where the window sits (the player)
   * @param recover seconds for a bent blade to come most of the way back up
   * @param printFill seconds for a footprint in the snow to fill most of the way back in
   */
  public update(dt: number, focus: THREE.Vector3, recover: number, printFill = 600): void {
    const R = TRAIL_RES;
    const fcx = Math.floor(focus.x / TRAIL_CELL);
    const fcz = Math.floor(focus.z / TRAIL_CELL);
    this.center.set(focus.x, focus.z);
    if (!this.active && !this.pusherCount && !this.printsLeft) {
      this.focusCX = fcx;
      this.focusCZ = fcz;
      return;
    }
    const vx = this.vx, vz = this.vz, pr = this.pr;
    // Moved to another cell: forget slots whose world cell left the window
    if (fcx !== this.focusCX || fcz !== this.focusCZ) {
      this.focusCX = fcx;
      this.focusCZ = fcz;
      const lim = R / 2 - 1;
      for (let i = 0; i < R * R; i++) {
        if ((vx[i] !== 0 || vz[i] !== 0 || pr[i] !== 0) && (Math.abs(this.ownX[i] - fcx) > lim || Math.abs(this.ownZ[i] - fcz) > lim)) {
          vx[i] = vz[i] = pr[i] = 0;
        }
      }
    }

    // Straighten back up (exponential: most of the way in `recover` seconds)
    const k = Math.exp((-dt * 2.3) / Math.max(0.2, recover));
    let any = false;
    // Footprints fill in with fresh snow
    let prints = false;
    if (this.printsLeft) {
      const kp = Math.exp((-dt * 2.3) / Math.max(1, printFill));
      for (let i = 0; i < R * R; i++) {
        if (pr[i] === 0) continue;
        pr[i] *= kp;
        if (pr[i] < 0.02) pr[i] = 0;
        else prints = true;
      }
    }
    for (let i = 0; i < R * R; i++) {
      if (vx[i] === 0 && vz[i] === 0) continue;
      vx[i] *= k;
      vz[i] *= k;
      if (vx[i] * vx[i] + vz[i] * vz[i] < 1e-4) vx[i] = vz[i] = 0;
      else any = true;
    }

    // Stamp the pushers: blades within the radius lean away from the centre, flat right under it
    for (let p = 0; p < this.pusherCount; p++) {
      const px = this.pushers[p * 3], pz = this.pushers[p * 3 + 1], r = this.pushers[p * 3 + 2];
      if (Math.abs(px - focus.x) > TRAIL_HALF || Math.abs(pz - focus.z) > TRAIL_HALF) continue;
      const c0x = Math.floor((px - r) / TRAIL_CELL), c1x = Math.floor((px + r) / TRAIL_CELL);
      const c0z = Math.floor((pz - r) / TRAIL_CELL), c1z = Math.floor((pz + r) / TRAIL_CELL);
      for (let cz = c0z; cz <= c1z; cz++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const wx = (cx + 0.5) * TRAIL_CELL - px;
          const wz = (cz + 0.5) * TRAIL_CELL - pz;
          const d = Math.hypot(wx, wz);
          if (d >= r) continue;
          const t = 1 - d / r;
          const f = t * t * (3 - 2 * t);
          // Outward; right at the centre any direction will do (it is flattened anyway)
          const nx = d > 1e-3 ? wx / d : 1, nz = d > 1e-3 ? wz / d : 0;
          const i = (((cz % R) + R) % R) * R + (((cx % R) + R) % R);
          const cur = vx[i] * vx[i] + vz[i] * vz[i];
          // Footprint: only under the body itself, not the whole push radius
          const pf = Math.min(1, Math.max(0, 1.4 - (d / r) * 1.8));
          if (this.ownX[i] !== cx || this.ownZ[i] !== cz) {
            vx[i] = nx * f;
            vz[i] = nz * f;
            pr[i] = pf;
            this.ownX[i] = cx;
            this.ownZ[i] = cz;
          } else {
            if (f * f > cur) {
              vx[i] = nx * f;
              vz[i] = nz * f;
            }
            if (pf > pr[i]) pr[i] = pf;
          }
          if (pf > 0) prints = true;
          any = true;
        }
      }
    }

    // Bending blades upload every frame; slowly filling footprints alone a few times a second
    this.printUpload -= dt;
    if (any || this.active || (this.printsLeft && this.printUpload <= 0)) {
      this.printUpload = 0.25;
      const b = this.bytes;
      for (let i = 0; i < R * R; i++) {
        b[i * 4] = 128 + Math.round(vx[i] * 127);
        b[i * 4 + 1] = 128 + Math.round(vz[i] * 127);
        b[i * 4 + 2] = Math.round(pr[i] * 255);
      }
      this.texture.needsUpdate = true;
    }
    this.active = any;
    this.printsLeft = prints;
  }
}
