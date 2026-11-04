import * as THREE from 'three';
import type { TerrainSystem } from '../world/TerrainSystem';
import type { PropSystem } from '../world/PropSystem';
import type { WeatherSystem } from '../world/WeatherSystem';
import { riverWorld } from '../world/rivers/RiverWorld';
import { TerrainTileType } from '../terrain/types/TerrainTypes';
import { WORLD_HALF, isMobileDevice, worldSettings } from '../world/WorldSettings';
import { animalTime } from './AnimalMaterial';
import { Species, SpeciesTuning, WildContext } from './Species';
import { Butterflies, FishSchools, Gulls, Hares, Sparrows, Turtles } from './Animals';
import { TREE_SPOTS } from '../gathering/GatheringConfig';

const CELL = 8;
const GRID = Math.ceil((WORLD_HALF * 2) / CELL);

export interface WildlifeStats {
  ms: number;
  active: Record<string, number>;
  visible: Record<string, number>;
  drawCalls: number;
}

/**
 * Ambient wildlife around the player. Every species is ONE InstancedMesh (one draw call) animated
 * in the vertex shader; the CPU keeps a small pool of agents per species alive in a ring around
 * the player, thinks for near ones every frame and far ones round-robin, and writes only the
 * agents inside the view distance and camera frustum. Spawning (habitat sampling) is the only
 * search and stops once the frame's wildlife budget is used up. Mobile gets smaller pools,
 * shorter view distances and a sparser far update.
 */
export class WildlifeSystem {
  public readonly group = new THREE.Group();
  public readonly species: Species[] = [];
  public enabled = true;
  public readonly stats: WildlifeStats = { ms: 0, active: {}, visible: {}, drawCalls: 0 };

  private readonly mobile = isMobileDevice();
  private readonly budgetMs: number;
  private readonly stride: number;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private frame = 0;
  private time = 0;
  private spentMs = 0;

  // Habitat: trees and flower patches per 8 m cell, rebuilt when the props change
  private readonly treeGrid = new Uint8Array(GRID * GRID);
  private readonly flowerGrid = new Uint8Array(GRID * GRID);
  private habitatRevision = -1;
  private habitatTimer = 0;
  private readonly ctx: WildContext;
  private readonly hares: Hares;
  private readonly fish: FishSchools;
  private readonly sparrows: Sparrows;

  constructor(
    scene: THREE.Scene,
    private readonly terrain: TerrainSystem,
    private readonly props: PropSystem,
    private readonly weather: WeatherSystem
  ) {
    this.group.name = 'Wildlife';
    scene.add(this.group);
    const m = this.mobile;
    this.budgetMs = m ? 0.6 : 1.2;
    this.stride = m ? 6 : 4;
    const tune = (t: Omit<SpeciesTuning, 'perAgent'> & { perAgent?: number }): SpeciesTuning => ({
      perAgent: 1,
      ...t,
      capacity: m ? Math.max(2, Math.round(t.capacity * 0.5)) : t.capacity,
      viewDist: m ? t.viewDist * 0.75 : t.viewDist,
      spawnMax: m ? Math.min(t.spawnMax, t.viewDist * 0.75) : t.spawnMax,
    });
    this.species.push(
      new Gulls(this.group, tune({ capacity: 14, spawnMin: 25, spawnMax: 110, despawn: 150, viewDist: 140, nearDist: 70, radius: 0.8, triesPerFrame: 3 })),
      new Butterflies(this.group, tune({ capacity: 36, spawnMin: 6, spawnMax: 32, despawn: 42, viewDist: 32, nearDist: 22, radius: 0.15, triesPerFrame: 4 })),
      (this.hares = new Hares(this.group, tune({ capacity: 10, spawnMin: 22, spawnMax: 70, despawn: 90, viewDist: 75, nearDist: 35, radius: 0.5, triesPerFrame: 3 }))),
      (this.fish = new FishSchools(this.group, tune({ capacity: 12, spawnMin: 12, spawnMax: 55, despawn: 70, viewDist: 50, nearDist: 25, radius: 2.5, triesPerFrame: 3 }))),
      new Turtles(this.group, tune({ capacity: 8, spawnMin: 18, spawnMax: 70, despawn: 90, viewDist: 70, nearDist: 30, radius: 0.7, triesPerFrame: 2 })),
      (this.sparrows = new Sparrows(this.group, tune({ capacity: 6, spawnMin: 14, spawnMax: 55, despawn: 70, viewDist: 55, nearDist: 30, radius: 3, triesPerFrame: 3 })))
    );

    this.ctx = {
      terrain,
      sea: worldSettings.waterLevel,
      night: 0,
      rain: 0,
      snow: 0,
      player: new THREE.Vector3(),
      time: 0,
      trees: (x, z) => this.around(this.treeGrid, x, z),
      flowers: (x, z) => this.around(this.flowerGrid, x, z),
      isSnow: (x, z) => terrain.getTile(Math.floor(x), Math.floor(z)) === TerrainTileType.SNOW,
      water: (x, z) => riverWorld.waterLevelAt(x, z),
      river: (x, z) => riverWorld.riverSurfaceAt(x, z),
    };
  }

  /** Sum over the 3x3 cells (24 m square) around a point: a smooth "how foresty is it here". */
  private around(grid: Uint8Array, x: number, z: number): number {
    const ix = Math.floor((x + WORLD_HALF) / CELL), iz = Math.floor((z + WORLD_HALF) / CELL);
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) {
      const r = iz + dz;
      if (r < 0 || r >= GRID) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const c = ix + dx;
        if (c >= 0 && c < GRID) n += grid[r * GRID + c];
      }
    }
    return n;
  }

  private rebuildHabitat(): void {
    this.treeGrid.fill(0);
    this.flowerGrid.fill(0);
    const add = (grid: Uint8Array, x: number, z: number) => {
      const ix = Math.floor((x + WORLD_HALF) / CELL), iz = Math.floor((z + WORLD_HALF) / CELL);
      if (ix < 0 || iz < 0 || ix >= GRID || iz >= GRID) return;
      grid[iz * GRID + ix] = Math.min(255, grid[iz * GRID + ix] + 1);
    };
    for (const p of this.props.list()) {
      if (p.type === 'tree_pine' || p.type === 'tree_round') add(this.treeGrid, p.position.x, p.position.z);
      else if (p.type === 'flowers') add(this.flowerGrid, p.position.x, p.position.z);
    }
    // The choppable forest by the farm is not made of props
    for (const t of TREE_SPOTS) add(this.treeGrid, t.position.x, t.position.z);
    this.habitatRevision = this.props.revision;
  }

  /**
   * `focus` is the player or the vehicle they ride. `hidden` (caves, editor) despawns everything.
   */
  public update(dt: number, focus: THREE.Vector3, camera: THREE.Camera, hidden: boolean): void {
    const t0 = performance.now();
    this.frame++;
    this.time += dt;
    animalTime.value = this.time % 3600;
    if (!this.enabled || hidden) {
      for (const s of this.species) s.clear();
      this.group.visible = false;
      this.stats.ms = performance.now() - t0;
      return;
    }
    this.group.visible = true;

    this.habitatTimer -= dt;
    if (this.habitatRevision !== this.props.revision && this.habitatTimer <= 0) {
      this.rebuildHabitat();
      this.habitatTimer = 3;
    }

    const ctx = this.ctx;
    ctx.player.copy(focus);
    ctx.time = this.time;
    ctx.sea = worldSettings.waterLevel;
    ctx.night = this.weather.nightFactor;
    ctx.rain = this.weather.rainIntensity * (1 - this.weather.snowAmount);
    ctx.snow = this.weather.snowAmount;
    this.hares.clock = this.time;
    this.fish.clock = this.time;
    this.sparrows.clock = this.time;

    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    // Spawning is skipped on a frame after one that went over budget
    const allowSpawn = this.spentMs < this.budgetMs;
    let calls = 0;
    for (const s of this.species) {
      s.update(dt, ctx, this.frustum, this.frame, this.stride, allowSpawn && performance.now() - t0 < this.budgetMs);
      this.stats.active[s.name] = s.activeCount;
      this.stats.visible[s.name] = s.visibleCount;
      if (s.visibleCount > 0) calls++;
    }
    this.stats.drawCalls = calls;
    this.spentMs = performance.now() - t0;
    this.stats.ms = this.spentMs;
  }
}
