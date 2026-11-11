import * as THREE from 'three';
import type { PropSystem, PropInstance } from '../world/PropSystem';
import type { TerrainSystem } from '../world/TerrainSystem';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { ParticleManager } from '../particles/ParticleManager';
import type { BushSway } from '../world/BushSway';
import { FLOWER_MATERIAL, loadFlowerModels, tulipColorOfYaw, tulipYawFor } from '../world/FlowerModels';
import { worldSettings } from '../world/WorldSettings';
import { riverWorld } from '../world/rivers/RiverWorld';
import { COLLISION_GROUPS } from '../config/constants';
import { audioEngine } from '../audio/AudioEngine';

/** Inventory items: one per tulip colour, in the shader's colour order (purple, white, yellow, red). */
export const TULIP_ITEM_IDS = ['tulip_purple', 'tulip_white', 'tulip_yellow', 'tulip_red'] as const;
export const tulipItemIndex = (id: string | null): number => (id ? (TULIP_ITEM_IDS as readonly string[]).indexOf(id) : -1);

/** Two clumps keep at least this much room between them (m). */
const PLANT_GAP = 0.55;
/** A clump is picked by hand within this of the player's centre (m), ones in front first. */
const PICK_REACH = 1.4;

export type FlowerPlantCheck = 'ok' | 'tooClose' | 'badGround' | 'tooFar';

/**
 * Tulip clumps the player picks by hand (E) and plants again from the hotbar.
 *
 * The clumps stay ordinary 'flowers' props (one instanced draw per cell, saved with the props), so
 * planting or picking one costs one instance slot and nothing per frame. A clump's petal colour is
 * the quarter turn of its yaw (the shader reads it from the instance matrix): digging one reads its
 * yaw, planting turns the new clump into the quarter of the colour in hand, so it goes exactly where
 * the crosshair is, with no per-instance colour buffer.
 *
 * Planting goes through the crosshair (GroundAim, on whenever tulips are in hand).
 */
export class FlowerBeds {
  /** Same rule as the apple trees: fields, paths, caves (wired by the engine). */
  public isBlocked: ((x: number, z: number) => boolean) | null = null;

  private ghost: THREE.InstancedMesh | null = null;
  private readonly ghostBad = new THREE.MeshBasicMaterial({ color: 0xff6b5a, transparent: true, opacity: 0.45, depthWrite: false });
  private readonly ghostPos = new THREE.Vector3();
  private ghostCheck: FlowerPlantCheck = 'badGround';
  private ghostYaw = Math.random() * Math.PI * 2;
  private ghostScale = 0.9 + Math.random() * 0.3;
  private ghostColor = -1;
  private ghostKey = '';
  private static readonly _m = new THREE.Matrix4();
  private static readonly _q = new THREE.Quaternion();
  private static readonly _s = new THREE.Vector3();
  private static readonly _up = new THREE.Vector3(0, 1, 0);


  constructor(
    private readonly scene: THREE.Scene,
    private readonly props: PropSystem,
    private readonly terrain: TerrainSystem,
    private readonly physics: PhysicsWorld,
    private readonly particles: ParticleManager | null,
    private readonly sway: BushSway | null,
  ) {
    void loadFlowerModels().then((clump) => {
      if (!clump) return;
      const ghost = new THREE.InstancedMesh(clump, FLOWER_MATERIAL, 1);
      ghost.name = 'TulipGhost';
      ghost.visible = false;
      ghost.frustumCulled = false;
      ghost.renderOrder = 5;
      this.ghost = ghost;
      this.scene.add(ghost);
    });
  }

  // ------------------------------------------------------------------ digging

  /** The clump the player would pick: within reach, ones in front counting as closer; or null. */
  public findPickTarget(pos: THREE.Vector3, facing: THREE.Vector3): PropInstance | null {
    let best: PropInstance | null = null;
    let bestScore = Infinity;
    this.props.forEachNear(pos.x, pos.z, PICK_REACH, (p) => {
      const dx = p.position.x - pos.x, dz = p.position.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > PICK_REACH || Math.abs(p.position.y - (pos.y - 0.9)) > 1.2) return;
      const ahead = d > 1e-3 ? (dx * facing.x + dz * facing.z) / d : 1;
      const score = d * (ahead < 0 ? 2 : 1.5 - ahead * 0.5);
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }, 'flowers');
    return best;
  }

  /** Pulls the clump out; returns the inventory item it gives (null if it's gone already). */
  public pick(id: number): string | null {
    const p = this.props.get(id);
    if (!p || p.type !== 'flowers') return null;
    const color = tulipColorOfYaw(p.rotationY);
    const at = p.position.clone();
    this.sway?.forget(id);
    this.props.remove(id);
    this.particles?.emitDirtClods(at.setY(at.y + 0.1), 6);
    audioEngine.at(at).playPlantSeed();
    return TULIP_ITEM_IDS[color];
  }

  // ------------------------------------------------------------------ planting

  /**
   * Puts the ghost clump (a real one, in the colour in hand) where the crosshair meets the ground
   * and checks the spot; red when it can't go there.
   */
  public updateGhost(playerPos: THREE.Vector3, color: number, aim: { point: THREE.Vector3; inReach: boolean }): FlowerPlantCheck {
    if (color !== this.ghostColor) {
      this.ghostColor = color;
      this.ghostYaw = tulipYawFor(color);
    }
    const x = aim.point.x, z = aim.point.z;
    // The full check (props around, a physics probe) only when the spot moved 5 cm, something was
    // built / dug / planted, or twice a second for whatever else moved in
    const key = `${Math.round(x * 20)},${Math.round(z * 20)},${this.props.revision},${this.terrain.revision},${Math.floor(performance.now() / 500)}`;
    if (key !== this.ghostKey) {
      this.ghostKey = key;
      this.ghostPos.set(x, this.terrain.getHeight(x, z), z);
      this.ghostCheck = this.checkSpot(x, this.ghostPos.y, z, playerPos.y);
    }
    const check: FlowerPlantCheck = aim.inReach ? this.ghostCheck : 'tooFar';
    const g = this.ghost;
    if (g) {
      g.visible = true;
      g.material = check === 'ok' ? FLOWER_MATERIAL : this.ghostBad;
      FlowerBeds._q.setFromAxisAngle(FlowerBeds._up, this.ghostYaw);
      FlowerBeds._m.compose(this.ghostPos, FlowerBeds._q, FlowerBeds._s.setScalar(this.ghostScale));
      g.setMatrixAt(0, FlowerBeds._m);
      g.instanceMatrix.needsUpdate = true;
    }
    return check;
  }

  /** Where the ghost clump stands (valid after updateGhost). */
  public get ghostPosition(): THREE.Vector3 {
    return this.ghostPos;
  }

  public hideGhost(): void {
    if (this.ghost) this.ghost.visible = false;
  }

  /** Plants a clump at the ghost (after updateGhost said 'ok'). */
  public plantAtGhost(): boolean {
    if (this.ghostCheck !== 'ok' || this.ghostColor < 0) return false;
    const { x, z } = this.ghostPos;
    const id = this.props.add('flowers', x, z, this.ghostYaw, this.ghostScale);
    if (id === null) return false;
    this.ghostYaw = tulipYawFor(this.ghostColor);
    this.ghostScale = 0.9 + Math.random() * 0.3;
    this.ghostKey = '';
    this.particles?.emitDirtClods(this.ghostPos.clone().setY(this.ghostPos.y + 0.1), 8);
    audioEngine.at(this.ghostPos).playPlantSeed();
    return true;
  }

  private checkSpot(x: number, y: number, z: number, playerY: number): FlowerPlantCheck {
    if (!this.terrain.isInside(x, z)) return 'badGround';
    if (Math.abs(y - (playerY - 0.75)) > 1.4) return 'badGround';
    if (y < worldSettings.waterLevel + 0.1 || y < riverWorld.waterLevelAt(x, z) + 0.1) return 'badGround';
    if (this.isBlocked?.(x, z)) return 'badGround';
    let close = false;
    this.props.forEachNear(x, z, PLANT_GAP + 1, (p) => {
      if (close) return;
      const gap = p.type === 'flowers' || p.type === 'mushrooms' ? PLANT_GAP : p.type === 'rock_small' ? 0.5 * p.scale : 0;
      if (gap > 0 && (p.position.x - x) ** 2 + (p.position.z - z) ** 2 < gap * gap) close = true;
    });
    if (close) return 'tooClose';
    // Buildings, rocks, trunks, stations, fences: any collider but the terrain where the clump stands
    if (this.physics.isInitialized()) {
      const R = this.physics.rapier;
      // Built once (Rapier shapes are plain descriptions, reusable for every query)
      const hit = this.physics.world.intersectionWithShape(
        { x, y: y + 0.3, z }, { x: 0, y: 0, z: 0, w: 1 }, (this.probe ??= new R.Cylinder(0.25, 0.22)), undefined,
        this.physics.packCollisionGroups(0xffff, COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS),
        undefined, undefined,
        (c) => ((c.collisionGroups() >>> 16) & COLLISION_GROUPS.TERRAIN) === 0,
      );
      if (hit) return 'badGround';
    }
    return 'ok';
  }

  private probe: RAPIER.Cylinder | null = null;
}
