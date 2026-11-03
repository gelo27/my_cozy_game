import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import * as YUKA from 'yuka';
import { BotController } from '../entities/BotController';
import { AI_STEERING_CONFIG } from '../config/constants';

export interface DynamicObstacleRef {
  entity: YUKA.GameEntity;
  body: RAPIER.RigidBody;
  radius: number;
}

/**
 * Senior Game AI Agent Coordinator & Spatial Neighborhood Manager.
 * Orchestrates multi-agent flocking/separation, dynamic obstacle tracking,
 * and two-phase YUKA-to-Rapier steering integration.
 */
export class AIAgentManager {
  public entityManager: YUKA.EntityManager;
  public bots: BotController[] = [];
  
  // Shared obstacles array referenced by all bots' ObstacleAvoidanceBehavior
  public allObstacles: YUKA.GameEntity[] = [];
  public dynamicObstacles: DynamicObstacleRef[] = [];
  
  // Dynamic player entity used for agent-to-player avoidance
  public playerEntity: YUKA.GameEntity;

  constructor() {
    this.entityManager = new YUKA.EntityManager();

    // Initialize player representation for avoidance
    this.playerEntity = new YUKA.GameEntity();
    this.playerEntity.boundingRadius = 0.55;
    this.playerEntity.position.set(0, -999, 0);
    this.allObstacles.push(this.playerEntity);
  }

  /**
   * Registers a bot into the YUKA EntityManager and sets up neighborhood tracking.
   */
  public registerBot(bot: BotController): void {
    if (!this.bots.includes(bot)) {
      this.bots.push(bot);
      this.entityManager.add(bot.vehicle);
    }
  }

  /**
   * Unregisters a bot from the manager and removes its vehicle from YUKA.
   */
  public unregisterBot(bot: BotController): void {
    const index = this.bots.indexOf(bot);
    if (index !== -1) {
      this.bots.splice(index, 1);
      this.entityManager.remove(bot.vehicle);
    }
  }

  /**
   * Adds a static obstacle with a specific bounding radius.
   */
  public addStaticObstacle(position: THREE.Vector3, boundingRadius: number): YUKA.GameEntity {
    const obs = new YUKA.GameEntity();
    obs.position.set(position.x, position.y, position.z);
    obs.boundingRadius = boundingRadius;
    this.allObstacles.push(obs);
    return obs;
  }

  /**
   * Registers a dynamic physics prop (e.g. pushable crate, rolling bowling ball)
   * whose position is synchronized with Rapier each frame.
   */
  public registerDynamicObstacle(body: RAPIER.RigidBody, boundingRadius: number): YUKA.GameEntity {
    const entity = new YUKA.GameEntity();
    const t = body.translation();
    entity.position.set(t.x, t.y, t.z);
    entity.boundingRadius = boundingRadius;

    this.allObstacles.push(entity);
    this.dynamicObstacles.push({ entity, body, radius: boundingRadius });
    return entity;
  }

  /**
   * Synchronizes dynamic physics props into the shared obstacles list.
   */
  private syncDynamicObstacles(playerPos?: THREE.Vector3): void {
    if (playerPos) {
      this.playerEntity.position.set(playerPos.x, playerPos.y, playerPos.z);
    }

    for (let i = 0; i < this.dynamicObstacles.length; i++) {
      const item = this.dynamicObstacles[i];
      try {
        if (!item.body || !item.body.isValid()) continue;
        const trans = item.body.translation();
        item.entity.position.set(trans.x, trans.y, trans.z);
      } catch {
        // Safe guard against body destruction during transitions
      }
    }
  }

  /**
   * Main multi-agent update loop:
   * Phase 1: Sync positions from Rapier and prepare high-level goals/paths.
   * Phase 2: YUKA EntityManager updates spatial neighborhoods and executes steering pipeline.
   * Phase 3: Apply resulting horizontal velocities to Rapier, handle vertical ramp assist,
   *          slerp facing rotation, and update animations/visualizers.
   */
  public update(
    dt: number,
    playerPos: THREE.Vector3,
    interactJustPressed?: boolean
  ): void {
    // 1. Sync dynamic obstacles and player entity
    this.syncDynamicObstacles(playerPos);

    // 2. Phase 1: Prepare each active bot
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      if (bot.isDead) continue;
      bot.prepareUpdate(dt, playerPos);
    }

    // 3. Phase 2: YUKA EntityManager step (updates neighborhood & computes steering force)
    this.entityManager.update(dt);

    // 4. Phase 3: Post-update each active bot (commit to Rapier, vertical assist, animations)
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      if (bot.isDead) continue;
      bot.postUpdate(dt, playerPos);
    }

    // 5. Friendly NPC interaction toggle (Press [E] to toggle follow/patrol)
    if (interactJustPressed) {
      let closestNPC: BotController | null = null;
      let closestDist = Infinity;

      for (let i = 0; i < this.bots.length; i++) {
        const bot = this.bots[i];
        if (!bot.isEnemy && !bot.isDead) {
          const dist = bot.getPosition().distanceTo(playerPos);
          if (dist < 8.0 && dist < closestDist) {
            closestDist = dist;
            closestNPC = bot;
          }
        }
      }

      if (closestNPC) {
        closestNPC.toggleFollowPlayer();
      }
    }
  }

  /**
   * Cleanup all entities and references.
   */
  public destroy(): void {
    this.entityManager.clear();
    this.bots = [];
    this.allObstacles = [];
    this.dynamicObstacles = [];
  }
}
