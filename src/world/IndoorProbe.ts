import RAPIER from '@dimforge/rapier3d-compat';
import type { Vector3 } from 'three';
import { PIECE_TRAITS, type BuildingPieceType } from '../building/types/BuildingTypes';

const SAMPLE_INTERVAL = 0.1;
const COVER_REACH = 10;
const WALL_REACH = 16;
const MAX_OPEN_DIRECTIONS = 2;
const WALL_DIRECTIONS = Array.from({ length: 12 }, (_, i) => {
  const angle = i * Math.PI / 6;
  return { x: Math.cos(angle), z: Math.sin(angle) };
});

function pieceKind(collider: RAPIER.Collider) {
  const data = collider.parent()?.userData as { pieceType?: BuildingPieceType } | undefined;
  return data?.pieceType ? PIECE_TRAITS[data.pieceType]?.kind : undefined;
}

function isCover(collider: RAPIER.Collider): boolean {
  const kind = pieceKind(collider);
  return kind === 'roof' || kind === 'floor' || kind === 'foundation';
}

function isBoundary(collider: RAPIER.Collider): boolean {
  const kind = pieceKind(collider);
  return kind === 'wall' || kind === 'window' || kind === 'door' || kind === 'doorway';
}

/** Samples the enclosing building geometry around the player's capsule centre. */
export class IndoorProbe {
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  private world: RAPIER.World | null = null;
  private remaining = 0;
  private indoors = false;

  public sample(world: RAPIER.World, position: Vector3, dt: number): boolean {
    this.remaining -= dt;
    if (world === this.world && this.remaining > 0) {
      // Refresh immediately on teleports, even if the next periodic sample is still pending.
      const dx = position.x - this.ray.origin.x;
      const dy = position.y - this.ray.origin.y;
      const dz = position.z - this.ray.origin.z;
      if (dx * dx + dy * dy + dz * dz < 4) return this.indoors;
    }

    this.world = world;
    this.remaining = SAMPLE_INTERVAL;
    this.indoors = this.cast(world, position);
    return this.indoors;
  }

  private cast(world: RAPIER.World, position: Vector3): boolean {
    const ray = this.ray;
    ray.origin.x = position.x;
    ray.origin.y = position.y;
    ray.origin.z = position.z;
    ray.dir.x = 0;
    ray.dir.y = 1;
    ray.dir.z = 0;

    const flags = RAPIER.QueryFilterFlags.ONLY_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    const cover = world.castRay(ray, COVER_REACH, true, flags, undefined, undefined, undefined, isCover);
    if (!cover || cover.timeOfImpact < 0.05) return false;

    ray.dir.y = 0;
    let openDirections = 0;
    let firstOpen = false;
    let previousOpen = false;
    for (let i = 0; i < WALL_DIRECTIONS.length; i++) {
      const direction = WALL_DIRECTIONS[i];
      ray.dir.x = direction.x;
      ray.dir.z = direction.z;
      const open = !world.castRay(ray, WALL_REACH, true, flags, undefined, undefined, undefined, isBoundary);
      // Isolated misses allow narrow openings. Consecutive misses indicate an open side.
      if (open && (previousOpen || ++openDirections > MAX_OPEN_DIRECTIONS)) return false;
      if (i === 0) firstOpen = open;
      previousOpen = open;
    }
    return !(firstOpen && previousOpen);
  }
}
