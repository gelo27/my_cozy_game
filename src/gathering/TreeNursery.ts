import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PropSystem } from '../world/PropSystem';
import type { TerrainSystem } from '../world/TerrainSystem';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { ParticleManager } from '../particles/ParticleManager';
import { foliageMaterialOf, getTreeLods, treeLodsRevision } from '../world/TreeModels';
import { worldSettings } from '../world/WorldSettings';
import { riverWorld } from '../world/rivers/RiverWorld';
import { COLLISION_GROUPS } from '../config/constants';
import { audioEngine } from '../audio/AudioEngine';

/** What a felled tree / cleared bush drops, and the prop it grows back into once planted. */
export const SEED_OF_TREE: Record<string, string> = {
  tree_pine: 'pine_cone',
  tree_round: 'acorn',
  bush: 'bush_sapling',
};
const TREE_OF_SEED: Record<string, string> = {
  pine_cone: 'tree_pine',
  acorn: 'tree_round',
  bush_sapling: 'bush',
};
/** The prop type a seed item grows into (null for anything else). */
export const seedTreeType = (itemId: string | null): string | null => (itemId ? TREE_OF_SEED[itemId] ?? null : null);

/** Seconds from planting to a full-size tree / bush. */
const GROW_SECONDS: Record<string, number> = { tree_pine: 360, tree_round: 360, bush: 150 };
/** Size of a fresh sapling, as a part of the grown one. */
const START_SCALE = 0.12;
/** Room kept free around a planted one (m): to other trees and bushes, and to other saplings. */
const ROOM: Record<string, number> = { tree_pine: 2.2, tree_round: 2.4, bush: 0.9 };
/** A grown tree only takes its trunk collider when the player isn't standing right there (m). */
const PLAYER_CLEAR = 1.1;

export type TreePlantCheck = 'ok' | 'tooClose' | 'badGround' | 'tooFar';

interface Sapling {
  type: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  /** Scale of the grown prop. */
  scale: number;
  /** Seconds grown so far. */
  age: number;
  mesh: THREE.Mesh | null;
  /** Drawn scale last written to the mesh. */
  shown: number;
}

/** Per sapling: type, x, z, rotY, scale, age (s). */
export type NurserySaveData = [string, number, number, number, number, number][];

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Pines, oaks and bushes the player plants from the cones, acorns and bush cuttings a felled tree
 * drops. A sapling is its own small mesh (the tree's model, scaled) that grows over a few minutes
 * without a collider; once grown it becomes an ordinary prop (instanced, saved with the props,
 * choppable again). Planting goes through the crosshair, like the tulips.
 */
export class TreeNursery {
  /** Same rule as the apple trees and the tulips: fields, caves (wired by the engine). */
  public isBlocked: ((x: number, z: number) => boolean) | null = null;
  /** Changes whenever a sapling is planted, grows up or the list is reloaded (for the save). */
  public revision = 0;

  private readonly saplings: Sapling[] = [];
  private readonly group = new THREE.Group();
  private ghost: THREE.Mesh | null = null;
  private ghostType = '';
  private readonly ghostBad = new THREE.MeshBasicMaterial({ color: 0xff6b5a, transparent: true, opacity: 0.45, depthWrite: false });
  private readonly ghostPos = new THREE.Vector3();
  private ghostCheck: TreePlantCheck = 'badGround';
  private ghostYaw = Math.random() * Math.PI * 2;
  private ghostScale = 0.9 + Math.random() * 0.25;
  private ghostKey = '';
  private lodsRevision = -1;
  private probe: RAPIER.Cylinder | null = null;

  constructor(
    scene: THREE.Scene,
    private readonly props: PropSystem,
    private readonly terrain: TerrainSystem,
    private readonly physics: PhysicsWorld,
    private readonly particles: ParticleManager | null,
  ) {
    this.group.name = 'TreeSaplings';
    scene.add(this.group);
  }

  // ------------------------------------------------------------------ planting

  /** Shows a ghost sapling where the crosshair meets the ground and checks the spot. */
  public updateGhost(playerPos: THREE.Vector3, type: string, aim: { point: THREE.Vector3; inReach: boolean }): TreePlantCheck {
    const x = aim.point.x, z = aim.point.z;
    const key = `${type},${Math.round(x * 20)},${Math.round(z * 20)},${this.props.revision},${this.terrain.revision},${this.revision},${Math.floor(performance.now() / 500)}`;
    if (key !== this.ghostKey) {
      this.ghostKey = key;
      this.ghostPos.set(x, this.terrain.getHeight(x, z), z);
      this.ghostCheck = this.checkSpot(type, x, this.ghostPos.y, z, playerPos.y);
    }
    const check: TreePlantCheck = aim.inReach ? this.ghostCheck : 'tooFar';
    const ghost = this.ghostMesh(type);
    if (ghost) {
      ghost.visible = true;
      ghost.material = check === 'ok' ? foliageMaterialOf(type) : this.ghostBad;
      ghost.position.copy(this.ghostPos);
      ghost.rotation.y = this.ghostYaw;
      // A bit bigger than a fresh sapling so it reads at a glance
      ghost.scale.setScalar(this.ghostScale * START_SCALE * 2);
    }
    return check;
  }

  public get ghostPosition(): THREE.Vector3 {
    return this.ghostPos;
  }

  public hideGhost(): void {
    if (this.ghost) this.ghost.visible = false;
  }

  /** Plants a sapling at the ghost (after updateGhost said 'ok'). */
  public plantAtGhost(type: string): boolean {
    if (this.ghostCheck !== 'ok' || !GROW_SECONDS[type]) return false;
    const { x, y, z } = this.ghostPos;
    this.addSapling(type, x, y, z, this.ghostYaw, this.ghostScale, 0);
    this.ghostYaw = Math.random() * Math.PI * 2;
    this.ghostScale = 0.9 + Math.random() * 0.25;
    this.ghostKey = '';
    this.particles?.emitDirtClods(this.ghostPos.clone().setY(y + 0.1), 8);
    audioEngine.at(this.ghostPos).playPlantSeed();
    return true;
  }

  private ghostMesh(type: string): THREE.Mesh | null {
    const geo = this.geometryOf(type);
    if (!geo) return null;
    if (!this.ghost) {
      this.ghost = new THREE.Mesh(geo, foliageMaterialOf(type));
      this.ghost.name = 'SaplingGhost';
      this.ghost.renderOrder = 5;
      this.ghost.castShadow = false;
      this.group.add(this.ghost);
    }
    if (this.ghostType !== type || this.ghost.geometry !== geo) {
      this.ghostType = type;
      this.ghost.geometry = geo;
    }
    return this.ghost;
  }

  private checkSpot(type: string, x: number, y: number, z: number, playerY: number): TreePlantCheck {
    if (!this.terrain.isInside(x, z)) return 'badGround';
    if (Math.abs(y - (playerY - 0.75)) > 1.4) return 'badGround';
    if (y < worldSettings.waterLevel + 0.15 || y < riverWorld.waterLevelAt(x, z) + 0.15) return 'badGround';
    if (this.isBlocked?.(x, z)) return 'badGround';
    const room = ROOM[type] ?? 1;
    let close = false;
    this.props.forEachNear(x, z, room + 2.5, (p) => {
      if (close) return;
      const other = ROOM[p.type];
      if (other === undefined) return;
      // The bigger of the two keeps its room (a bush may stand nearer a bush than a tree)
      const gap = Math.max(room, other) * Math.min(1, 0.6 + 0.4 * p.scale);
      if ((p.position.x - x) ** 2 + (p.position.z - z) ** 2 < gap * gap) close = true;
    });
    if (!close) {
      for (const s of this.saplings) {
        const gap = Math.max(room, ROOM[s.type] ?? 1);
        if ((s.x - x) ** 2 + (s.z - z) ** 2 < gap * gap) { close = true; break; }
      }
    }
    if (close) return 'tooClose';
    // Buildings, rocks, trunks, stations, fences: any collider but the terrain
    if (this.physics.isInitialized()) {
      const R = this.physics.rapier;
      const hit = this.physics.world.intersectionWithShape(
        { x, y: y + 0.4, z }, { x: 0, y: 0, z: 0, w: 1 }, (this.probe ??= new R.Cylinder(0.3, 0.35)), undefined,
        this.physics.packCollisionGroups(0xffff, COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS),
        undefined, undefined,
        (c) => ((c.collisionGroups() >>> 16) & COLLISION_GROUPS.TERRAIN) === 0,
      );
      if (hit) return 'badGround';
    }
    return 'ok';
  }

  // ------------------------------------------------------------------ growing

  private geometryOf(type: string): THREE.BufferGeometry | null {
    const lods = getTreeLods()?.[type];
    if (!lods) return null;
    // The middle LOD: a sapling is small, the most detailed mesh would be wasted on it
    return lods[Math.min(1, lods.length - 1)] ?? lods[0] ?? null;
  }

  private addSapling(type: string, x: number, y: number, z: number, rotY: number, scale: number, age: number): void {
    this.saplings.push({ type, x, y, z, rotY, scale, age, mesh: null, shown: -1 });
    this.revision++;
  }

  public update(dt: number, player: THREE.Vector3): void {
    if (this.saplings.length === 0) return;
    // Leaves rebuilt from the vegetation panel: the old geometries are gone, take the new ones
    if (this.lodsRevision !== treeLodsRevision) {
      this.lodsRevision = treeLodsRevision;
      for (const s of this.saplings) {
        const geo = this.geometryOf(s.type);
        if (s.mesh && geo) s.mesh.geometry = geo;
      }
    }
    for (let i = this.saplings.length - 1; i >= 0; i--) {
      const s = this.saplings[i];
      const total = GROW_SECONDS[s.type] ?? 300;
      s.age = Math.min(total, s.age + dt);
      if (s.age >= total) {
        // Grown: becomes a regular prop, once the player is out of the way of its trunk
        if ((player.x - s.x) ** 2 + (player.z - s.z) ** 2 < PLAYER_CLEAR * PLAYER_CLEAR) {
          this.draw(s, 1);
          continue;
        }
        this.grow(i);
        continue;
      }
      // Eased: quick at first, slowing down as it nears full size
      const k = s.age / total;
      this.draw(s, START_SCALE + (1 - START_SCALE) * (1 - (1 - k) * (1 - k)));
    }
  }

  private draw(s: Sapling, part: number): void {
    if (!s.mesh) {
      const geo = this.geometryOf(s.type);
      if (!geo) return;
      s.mesh = new THREE.Mesh(geo, foliageMaterialOf(s.type));
      s.mesh.name = `Sapling_${s.type}`;
      s.mesh.position.set(s.x, s.y, s.z);
      s.mesh.rotation.y = s.rotY;
      s.mesh.castShadow = true;
      s.mesh.receiveShadow = true;
      this.group.add(s.mesh);
    }
    const scale = s.scale * part;
    if (Math.abs(scale - s.shown) < 0.002) return;
    s.shown = scale;
    s.mesh.scale.setScalar(scale);
  }

  private grow(index: number): void {
    const s = this.saplings[index];
    this.saplings.splice(index, 1);
    s.mesh?.removeFromParent();
    this.props.add(s.type, s.x, s.z, s.rotY, s.scale);
    this.particles?.emitTreeFoliageLeaves(new THREE.Vector3(s.x, s.y + 1.2, s.z), 10);
    this.revision++;
  }

  /** Sleeping skips hours: the saplings grow on. */
  public fastForward(seconds: number): void {
    for (const s of this.saplings) s.age = Math.min(GROW_SECONDS[s.type] ?? 300, s.age + seconds);
  }

  /** Developer shortcut: every sapling grown at once. */
  public devGrow(): void {
    for (const s of this.saplings) s.age = GROW_SECONDS[s.type] ?? 300;
  }

  public get saplingCount(): number {
    return this.saplings.length;
  }

  // ------------------------------------------------------------------ save

  public serialize(): NurserySaveData {
    return this.saplings.map((s) => [s.type, r2(s.x), r2(s.z), r2(s.rotY), r2(s.scale), Math.round(s.age)]);
  }

  public deserialize(data: NurserySaveData | undefined): void {
    this.clear();
    if (!Array.isArray(data)) return;
    for (const row of data) {
      if (!Array.isArray(row)) continue;
      const [type, x, z, rotY, scale, age] = row;
      if (!GROW_SECONDS[type] || ![x, z, rotY, scale, age].every(Number.isFinite)) continue;
      this.addSapling(type, x, this.terrain.getHeight(x, z), z, rotY, scale, Math.max(0, age));
    }
  }

  public clear(): void {
    for (const s of this.saplings) s.mesh?.removeFromParent();
    this.saplings.length = 0;
    this.revision++;
  }
}
