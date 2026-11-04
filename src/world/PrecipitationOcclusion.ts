import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { isMobileDevice } from './WorldSettings';
import { riverWorld } from './rivers/RiverWorld';

/** Height reported for columns with nothing above the drops. */
const OPEN_SKY = -1e4;
/** Colliders thinner than this (posts, lamps, fences, trunks) don't shelter from rain. */
const MIN_SHELTER_HALF_SIZE = 0.6;

/**
 * Roof map for rain and snow: a world-anchored grid of "highest static surface" heights around the
 * camera, filled by downward Rapier raycasts and sampled in the precipitation vertex shader, so drops
 * vanish under roofs, floors and big props instead of falling through houses.
 *
 * The grid is a ring buffer (texel = world cell mod N), so walking only re-casts the cells that
 * enter the window. A small round-robin refresh picks up newly built or demolished pieces.
 * Only fixed colliders count (character, vehicle and loose props never block the sky); river and
 * lake surfaces count as well.
 */
export class PrecipitationOcclusion {
  public readonly texture: THREE.DataTexture;
  public readonly cellSize: number;
  public readonly size: number;

  private readonly heights: Float32Array;
  /** World cell held by each texel, packed; NaN = never cast. */
  private readonly keysX: Float32Array;
  private readonly keysZ: Float32Array;
  private readonly castBudget: number;
  private readonly refreshBudget: number;
  private refreshCursor = 0;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly shelterCache = new Map<number, boolean>();
  private readonly isShelter = (c: RAPIER.Collider): boolean => {
    let v = this.shelterCache.get(c.handle);
    if (v === undefined) {
      v = PrecipitationOcclusion.isLarge(c);
      if (this.shelterCache.size > 4096) this.shelterCache.clear();
      this.shelterCache.set(c.handle, v);
    }
    return v;
  };

  constructor(private readonly physics: PhysicsWorld, boxSize: number) {
    const mobile = isMobileDevice();
    this.size = 32;
    this.cellSize = boxSize / this.size;
    this.castBudget = mobile ? 40 : 120;
    this.refreshBudget = mobile ? 6 : 20;
    const n = this.size * this.size;
    this.heights = new Float32Array(n).fill(OPEN_SKY);
    this.keysX = new Float32Array(n).fill(NaN);
    this.keysZ = new Float32Array(n).fill(NaN);
    this.texture = new THREE.DataTexture(this.heights, this.size, this.size, THREE.RedFormat, THREE.FloatType);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.needsUpdate = true;
  }

  /** Re-cast cells that scrolled into view (plus a few old ones). Call only while it's raining. */
  public update(center: THREE.Vector3): void {
    const world = this.physics.world;
    if (!world) return;
    const N = this.size;
    const cs = this.cellSize;
    const half = N / 2;
    const ccx = Math.floor(center.x / cs);
    const ccz = Math.floor(center.z / cs);
    const top = center.y + 30;
    let budget = this.castBudget;
    let dirty = false;

    // Cells that entered the window: nearest rings first, so the area around the player fills instantly
    for (let r = 0; r <= half && budget > 0; r++) {
      for (let dz = -r; dz <= r && budget > 0; dz++) {
        const edge = dz === -r || dz === r;
        for (let dx = -r; dx <= r && budget > 0; dx += edge ? 1 : 2 * r || 1) {
          const cx = ccx + dx;
          const cz = ccz + dz;
          if (dx < -half || dx >= half || dz < -half || dz >= half) continue;
          const i = this.texel(cx, cz);
          if (this.keysX[i] === cx && this.keysZ[i] === cz) continue;
          this.cast(i, cx, cz, top, world);
          budget--;
          dirty = true;
        }
      }
    }

    // Round-robin refresh of valid cells for building changes
    for (let k = 0; k < this.refreshBudget; k++) {
      const i = this.refreshCursor;
      this.refreshCursor = (this.refreshCursor + 1) % (N * N);
      const cx = this.keysX[i];
      const cz = this.keysZ[i];
      if (Number.isNaN(cx)) continue;
      this.cast(i, cx, cz, top, world);
      dirty = true;
    }

    if (dirty) this.texture.needsUpdate = true;
  }

  /** Height of the shelter above (x, z), or null when that cell isn't mapped yet. */
  public heightAt(x: number, z: number): number | null {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    const i = this.texel(cx, cz);
    return this.keysX[i] === cx && this.keysZ[i] === cz ? this.heights[i] : null;
  }

  private texel(cx: number, cz: number): number {
    const N = this.size;
    return (((cz % N) + N) % N) * N + (((cx % N) + N) % N);
  }

  private cast(i: number, cx: number, cz: number, top: number, world: RAPIER.World): void {
    const cs = this.cellSize;
    this.ray.origin.x = (cx + 0.5) * cs;
    this.ray.origin.y = top;
    this.ray.origin.z = (cz + 0.5) * cs;
    const flags =
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    let h = OPEN_SKY;
    try {
      const hit = world.castRay(this.ray, 80, true, flags, undefined, undefined, undefined, this.isShelter);
      if (hit) h = top - hit.timeOfImpact;
    } catch {
      // world mid-rebuild: leave the column open
    }
    // Rivers and lakes are not colliders: drops and flakes stop on their surface too
    const water = riverWorld.riverSurfaceAt(this.ray.origin.x, this.ray.origin.z);
    if (water > h) h = water;
    this.heights[i] = h;
    this.keysX[i] = cx;
    this.keysZ[i] = cz;
  }

  private static isLarge(c: RAPIER.Collider): boolean {
    switch (c.shapeType()) {
      case RAPIER.ShapeType.Cuboid:
      case RAPIER.ShapeType.RoundCuboid: {
        const e = c.halfExtents();
        return Math.max(e.x, e.z) >= MIN_SHELTER_HALF_SIZE;
      }
      case RAPIER.ShapeType.Cylinder:
      case RAPIER.ShapeType.RoundCylinder:
      case RAPIER.ShapeType.Ball:
      case RAPIER.ShapeType.Capsule:
      case RAPIER.ShapeType.Cone:
        return c.radius() >= MIN_SHELTER_HALF_SIZE;
      default:
        // Terrain heightfield, merged building trimeshes, convex hulls
        return true;
    }
  }
}
