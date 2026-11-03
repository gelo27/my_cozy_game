import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import * as YUKA from 'yuka';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { CharacterModel } from '../character/CharacterModel';
import { CHARACTER_CONFIG, COLLISION_GROUPS, AI_STEERING_CONFIG } from '../config/constants';
import { NavMeshManager } from '../navigation/NavMeshManager';

/**
 * Autonomous AI Agent Controller powered by YUKA steering behaviors
 * and integrated into Rapier3D rigid-body physics.
 * Supports NavMesh corridor pathfinding, dynamic obstacle avoidance,
 * and multi-agent separation.
 */
export class BotController {
  public body: RAPIER.RigidBody;
  public collider: RAPIER.Collider;
  public model: CharacterModel;

  public isEnemy: boolean;
  public isDead: boolean = false;
  public deathTime: number = 0;
  public isFollowingPlayer: boolean = false;

  // YUKA Vehicle & Autonomous Steering Behaviors
  public vehicle: YUKA.Vehicle;
  private followPathBehavior: YUKA.FollowPathBehavior;
  private onPathBehavior: YUKA.OnPathBehavior;
  private obstacleAvoidance: YUKA.ObstacleAvoidanceBehavior;
  private separationBehavior: YUKA.SeparationBehavior;
  private arriveBehavior: YUKA.ArriveBehavior;
  private wanderBehavior: YUKA.WanderBehavior;

  // Patrol & Path State
  private patrolWaypoints: THREE.Vector3[] = [];
  private currentPathWaypoints: THREE.Vector3[] = [];
  private currentWaypointIndex: number = 0;
  private pathIsLoop: boolean = false;
  private lastPathCalcTime: number = 0;
  private lastTargetPos: THREE.Vector3 = new THREE.Vector3(Infinity, Infinity, Infinity);

  private currentFacing: number = 0;
  public health: number = 100;

  // Debug Visualization
  private debugArrow: THREE.ArrowHelper;
  private pathLine?: THREE.LineLoop;
  private chaseLine?: THREE.Line;

  constructor(
    private physics: PhysicsWorld,
    private scene: THREE.Scene,
    spawnPos: THREE.Vector3,
    isEnemy: boolean = false,
    obstacles: YUKA.GameEntity[] = [],
    waypoints: THREE.Vector3[] = [],
    private navMeshManager?: NavMeshManager
  ) {
    this.isEnemy = isEnemy;
    this.patrolWaypoints = waypoints.map(w => w.clone());

    // Enemy is red, Peaceful NPC is emerald green
    this.model = new CharacterModel(isEnemy ? 0xff3333 : 0x22c55e);
    this.scene.add(this.model.group);

    // 1. Create Rapier Dynamic Rigid Body
    const bodyDesc = this.physics.rapier.RigidBodyDesc.dynamic()
      .setTranslation(spawnPos.x, spawnPos.y, spawnPos.z)
      .lockRotations()
      .setLinearDamping(0.2)
      .setCcdEnabled(true);

    this.body = this.physics.world.createRigidBody(bodyDesc);
    this.body.lockRotations(true, true);
    (this.body as any).userData = { bot: this };

    const colliderDesc = this.physics.rapier.ColliderDesc.capsule(
      CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT,
      CHARACTER_CONFIG.CAPSULE_RADIUS
    )
      .setMass(CHARACTER_CONFIG.MASS)
      .setFriction(0.0)
      .setRestitution(0.0);

    colliderDesc.setCollisionGroups(this.physics.packCollisionGroups(COLLISION_GROUPS.DYNAMIC_PROPS, 0xFFFF));
    this.collider = this.physics.world.createCollider(colliderDesc, this.body);

    // 2. Initialize YUKA Vehicle
    this.vehicle = new YUKA.Vehicle();
    this.vehicle.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
    this.vehicle.maxSpeed = isEnemy ? AI_STEERING_CONFIG.ENEMY_CHASE_SPEED : AI_STEERING_CONFIG.PATROL_SPEED;
    this.vehicle.mass = AI_STEERING_CONFIG.AGENT_MASS;
    this.vehicle.maxForce = AI_STEERING_CONFIG.AGENT_MAX_FORCE;
    this.vehicle.boundingRadius = AI_STEERING_CONFIG.AGENT_BOUNDING_RADIUS;

    // Enable neighborhood tracking for SeparationBehavior
    this.vehicle.updateNeighborhood = true;
    this.vehicle.neighborhoodRadius = AI_STEERING_CONFIG.NEIGHBORHOOD_RADIUS;

    // 3. Initialize Steering Behaviors
    // A) Dynamic Obstacle Avoidance (always active to avoid static + dynamic props)
    this.obstacleAvoidance = new YUKA.ObstacleAvoidanceBehavior(obstacles);
    this.obstacleAvoidance.dBoxMinLength = AI_STEERING_CONFIG.OBSTACLE_DBOX_MIN_LENGTH;
    this.obstacleAvoidance.brakingWeight = AI_STEERING_CONFIG.OBSTACLE_BRAKING_WEIGHT;
    this.obstacleAvoidance.weight = AI_STEERING_CONFIG.OBSTACLE_AVOIDANCE_WEIGHT;
    this.obstacleAvoidance.active = true;
    this.vehicle.steering.add(this.obstacleAvoidance);

    // B) Multi-Agent Separation Behavior (always active to prevent agent clustering/overlapping)
    this.separationBehavior = new YUKA.SeparationBehavior();
    this.separationBehavior.weight = AI_STEERING_CONFIG.SEPARATION_WEIGHT;
    this.separationBehavior.active = true;
    this.vehicle.steering.add(this.separationBehavior);

    // C) NavMesh Path Following Behavior
    const initialPath = new YUKA.Path();
    if (this.patrolWaypoints.length > 0) {
      initialPath.loop = true;
      for (const wp of this.patrolWaypoints) {
        initialPath.add(new YUKA.Vector3(wp.x, wp.y, wp.z));
      }
    }
    this.followPathBehavior = new YUKA.FollowPathBehavior(initialPath, AI_STEERING_CONFIG.WAYPOINT_TOLERANCE);
    this.followPathBehavior.weight = AI_STEERING_CONFIG.FOLLOW_PATH_WEIGHT;
    (this.followPathBehavior as any)._arrive.deceleration = 1.2;
    (this.followPathBehavior as any)._arrive.tolerance = 0.3;
    this.followPathBehavior.active = !isEnemy && this.patrolWaypoints.length > 0;
    this.vehicle.steering.add(this.followPathBehavior);

    // D) On-Path Corridor Constraint Behavior
    this.onPathBehavior = new YUKA.OnPathBehavior(initialPath, AI_STEERING_CONFIG.ON_PATH_RADIUS);
    this.onPathBehavior.weight = AI_STEERING_CONFIG.ON_PATH_WEIGHT;
    this.onPathBehavior.active = !isEnemy && this.patrolWaypoints.length > 0;
    this.vehicle.steering.add(this.onPathBehavior);

    // E) Smooth Arrive Behavior for close-range target approach
    this.arriveBehavior = new YUKA.ArriveBehavior(new YUKA.Vector3(), 1.8, 0.4);
    this.arriveBehavior.weight = AI_STEERING_CONFIG.ARRIVE_WEIGHT;
    this.arriveBehavior.active = false;
    this.vehicle.steering.add(this.arriveBehavior);

    // F) Wander Behavior for unaggroed territory patrolling
    this.wanderBehavior = new YUKA.WanderBehavior();
    this.wanderBehavior.weight = AI_STEERING_CONFIG.WANDER_WEIGHT;
    this.wanderBehavior.active = isEnemy;
    this.vehicle.steering.add(this.wanderBehavior);

    // 4. Debug Visualizations
    if (this.patrolWaypoints.length > 0) {
      const lineGeo = new THREE.BufferGeometry().setFromPoints(this.patrolWaypoints);
      const lineMat = new THREE.LineLoop(lineGeo, new THREE.LineBasicMaterial({ color: 0x06b6d4 }));
      this.pathLine = lineMat;
      this.pathLine.position.y = 0.2;
      this.scene.add(this.pathLine);
    }

    const chaseGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const chaseMat = new THREE.LineBasicMaterial({
      color: isEnemy ? 0xef4444 : 0x10b981,
      linewidth: 2,
    });
    this.chaseLine = new THREE.Line(chaseGeo, chaseMat);
    this.chaseLine.position.y = 0.25;
    this.chaseLine.visible = false;
    this.scene.add(this.chaseLine);

    this.debugArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      spawnPos,
      1.8,
      isEnemy ? 0xf59e0b : 0x3b82f6
    );
    this.scene.add(this.debugArrow);
  }

  /**
   * Returns current world position of the agent.
   */
  public getPosition(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  /**
   * Toggles follow mode for friendly NPCs.
   */
  public toggleFollowPlayer(): void {
    if (this.isEnemy) return;
    this.isFollowingPlayer = !this.isFollowingPlayer;
    if (!this.isFollowingPlayer && this.patrolWaypoints.length > 0) {
      this.restorePatrolPath();
    }
  }

  /**
   * Restores initial looped patrol path for NPCs.
   */
  private restorePatrolPath(): void {
    this.setNavMeshPath(this.patrolWaypoints, true);
    this.arriveBehavior.active = false;
    this.wanderBehavior.active = false;
    this.vehicle.maxSpeed = AI_STEERING_CONFIG.PATROL_SPEED;
  }

  /**
   * Sets a dynamic corridor path from NavMesh waypoints.
   */
  public setNavMeshPath(waypoints: THREE.Vector3[], loop: boolean = false): void {
    if (waypoints.length === 0) return;

    this.currentPathWaypoints = waypoints.map(w => w.clone());
    this.currentWaypointIndex = 0;
    this.pathIsLoop = loop;

    const path = new YUKA.Path();
    path.loop = loop;
    for (let i = 0; i < waypoints.length; i++) {
      path.add(new YUKA.Vector3(waypoints[i].x, waypoints[i].y, waypoints[i].z));
    }

    this.followPathBehavior.path = path;
    this.followPathBehavior.active = true;
    this.onPathBehavior.path = path;
    this.onPathBehavior.active = true;
  }

  /**
   * Phase 1 of AI update:
   * Synchronizes vehicle position & horizontal velocity from Rapier,
   * evaluates perception and updates high-level steering behaviors and NavMesh paths.
   */
  public prepareUpdate(dt: number, playerPos: THREE.Vector3): void {
    if (this.isDead) return;

    // 1. Sync YUKA vehicle from Rapier dynamic body
    const myPos = this.body.translation();
    const myVel = this.body.linvel();
    this.vehicle.position.set(myPos.x, myPos.y, myPos.z);
    this.vehicle.velocity.set(myVel.x, 0, myVel.z);

    const pos = new THREE.Vector3(myPos.x, myPos.y, myPos.z);
    const distToPlayer = pos.distanceTo(playerPos);
    const now = performance.now();

    // Ensure Obstacle Avoidance & Separation are consistently enabled for all active agents
    this.obstacleAvoidance.active = true;
    this.separationBehavior.active = true;

    if (this.isEnemy) {
      const isPlayerInCombatZone = playerPos.x <= AI_STEERING_CONFIG.COMBAT_ZONE_X_THRESHOLD;
      const shouldAggro = distToPlayer < AI_STEERING_CONFIG.AGGRO_DISTANCE || isPlayerInCombatZone;

      if (shouldAggro) {
        this.wanderBehavior.active = false;

        const hasLOS = this.navMeshManager ? this.navMeshManager.hasLineOfSight(pos, playerPos) : false;
        const verticalDelta = Math.abs(pos.y - playerPos.y);

        // Point-blank melee attack range: smoothly arrive directly at player
        if (distToPlayer <= AI_STEERING_CONFIG.ATTACK_RANGE && verticalDelta <= AI_STEERING_CONFIG.ENGAGEMENT_VERTICAL_TOLERANCE && hasLOS) {
          this.followPathBehavior.active = false;
          this.onPathBehavior.active = false;
          this.arriveBehavior.target.set(playerPos.x, playerPos.y, playerPos.z);
          this.arriveBehavior.active = true;
          this.vehicle.maxSpeed = AI_STEERING_CONFIG.ENEMY_ENGAGE_SPEED;
          this.currentPathWaypoints = [pos, playerPos];
        } else if (this.navMeshManager) {
          this.arriveBehavior.active = false;
          this.vehicle.maxSpeed = AI_STEERING_CONFIG.ENEMY_CHASE_SPEED;

          const targetMoved = this.lastTargetPos.distanceTo(playerPos) > AI_STEERING_CONFIG.TARGET_MOVE_THRESHOLD;
          const timeSinceRecalc = now - this.lastPathCalcTime;
          const pathExpired = !this.followPathBehavior.path || (this.followPathBehavior.path as any).finished();

          // Recalculate NavMesh path periodically or when target moved significantly
          if (timeSinceRecalc > AI_STEERING_CONFIG.PATH_RECALC_INTERVAL_MS || targetMoved || pathExpired) {
            this.lastPathCalcTime = now;
            this.lastTargetPos.copy(playerPos);

            const smoothedPath = this.navMeshManager.findPath(pos, playerPos);
            if (smoothedPath.length >= 2) {
              this.setNavMeshPath(smoothedPath, false);
            } else {
              this.setNavMeshPath([pos, playerPos], false);
            }
          }
        }
      } else {
        // Idle/Wander within patrol territory
        this.wanderBehavior.active = true;
        this.followPathBehavior.active = false;
        this.onPathBehavior.active = false;
        this.arriveBehavior.active = false;
        this.vehicle.maxSpeed = AI_STEERING_CONFIG.WANDER_SPEED;
        this.currentPathWaypoints = [];
      }
    } else {
      // Peaceful NPC Logic
      if (this.isFollowingPlayer) {
        this.wanderBehavior.active = false;

        if (distToPlayer > AI_STEERING_CONFIG.FOLLOW_STOP_DISTANCE) {
          this.vehicle.maxSpeed = AI_STEERING_CONFIG.FRIENDLY_FOLLOW_SPEED;
          this.arriveBehavior.active = false;

          if (this.navMeshManager) {
            const timeSinceRecalc = now - this.lastPathCalcTime;
            const targetMoved = this.lastTargetPos.distanceTo(playerPos) > AI_STEERING_CONFIG.TARGET_MOVE_THRESHOLD;
            const pathExpired = !this.followPathBehavior.path || (this.followPathBehavior.path as any).finished();

            if (timeSinceRecalc > AI_STEERING_CONFIG.PATH_RECALC_INTERVAL_MS || targetMoved || pathExpired) {
              this.lastPathCalcTime = now;
              this.lastTargetPos.copy(playerPos);

              const smoothedPath = this.navMeshManager.findPath(pos, playerPos);
              if (smoothedPath.length >= 2) {
                this.setNavMeshPath(smoothedPath, false);
              }
            }
          }
        } else {
          // Close enough to player: gently decelerate and idle
          this.followPathBehavior.active = false;
          this.onPathBehavior.active = false;
          this.arriveBehavior.active = false;
          this.vehicle.velocity.set(0, 0, 0);
          this.currentPathWaypoints = [];
        }
      } else {
        // Routine looped patrol route
        if (this.patrolWaypoints.length > 0 && !this.followPathBehavior.active) {
          this.restorePatrolPath();
        }
      }
    }
  }

  /**
   * Phase 3 of AI update:
   * Commits the computed YUKA horizontal velocity to Rapier rigid body,
   * adds vertical ascent assist on ramps/stairs, slerps facing orientation,
   * drives animation playback, and updates debug path geometry.
   */
  public postUpdate(dt: number, playerPos: THREE.Vector3): void {
    if (this.isDead) return;

    const myPos = this.body.translation();
    const pos = new THREE.Vector3(myPos.x, myPos.y, myPos.z);
    this.model.group.position.copy(pos);

    let desiredVelX = this.vehicle.velocity.x;
    let desiredVelZ = this.vehicle.velocity.z;
    const currentLinvel = this.body.linvel();

    // 1. Precise Ground Detection under bot capsule
    const botFeetY = pos.y - (CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT + CHARACTER_CONFIG.CAPSULE_RADIUS);
    const downDir = new THREE.Vector3(0, -1, 0);
    const filterGroup = this.physics.packCollisionGroups(
      COLLISION_GROUPS.DYNAMIC_PROPS,
      COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS
    );

    const hitResult = this.physics.castRayAndGetNormal(
      pos,
      downDir,
      1.15,
      this.collider,
      filterGroup
    );

    const isGrounded = hitResult != null && hitResult.normal.y > 0.35 && hitResult.hit.timeOfImpact <= 1.05;
    const groundGap = hitResult ? hitResult.hit.timeOfImpact - 0.75 : 999;

    // 2. Advance custom waypoint progression (comparing with bot's feet elevation)
    if (this.currentPathWaypoints.length > 0 && this.currentWaypointIndex < this.currentPathWaypoints.length) {
      const targetWp = this.currentPathWaypoints[this.currentWaypointIndex];
      const dist2D = Math.hypot(targetWp.x - pos.x, targetWp.z - pos.z);
      const dyFeet = Math.abs(targetWp.y - botFeetY);

      if (dist2D < AI_STEERING_CONFIG.WAYPOINT_TOLERANCE && dyFeet < 1.4) {
        this.currentWaypointIndex++;
        if (this.currentWaypointIndex >= this.currentPathWaypoints.length) {
          if (this.pathIsLoop) {
            this.currentWaypointIndex = 0;
          }
        }
      }
      if (this.followPathBehavior.path) {
        (this.followPathBehavior as any)._index = Math.min(
          this.currentWaypointIndex,
          Math.max(0, this.currentPathWaypoints.length - 1)
        );
      }
    }

    // 3. Slope-Aware Physical Locomotion
    let finalVelX = desiredVelX;
    let finalVelY = currentLinvel.y;
    let finalVelZ = desiredVelZ;
    const speedH = Math.hypot(desiredVelX, desiredVelZ);

    if (isGrounded && hitResult) {
      const normal = hitResult.normal;
      const isRampOrSlope = normal.y < 0.985;

      if (speedH > 0.15) {
        if (isRampOrSlope) {
          // Tangent projection along the exact slope surface
          // Tangent = V - (V . N) * N
          const vDotN = desiredVelX * normal.x + desiredVelZ * normal.z;
          const tanX = desiredVelX - vDotN * normal.x;
          const tanY = -vDotN * normal.y;
          const tanZ = desiredVelZ - vDotN * normal.z;
          const tanLen = Math.hypot(tanX, tanY, tanZ);

          if (tanLen > 0.001) {
            finalVelX = (tanX / tanLen) * speedH;
            finalVelY = (tanY / tanLen) * speedH;
            finalVelZ = (tanZ / tanLen) * speedH;
          }
        } else {
          finalVelX = desiredVelX;
          finalVelZ = desiredVelZ;
          finalVelY = -0.5; // gentle ground stick on flat surfaces
        }

        // Slope adhesion / ground stick:
        // When running on ramps or flat surfaces, keep the bot glued to the floor
        if (groundGap > 0.02 && groundGap < 0.3) {
          finalVelY -= Math.min(3.5, groundGap * 8.0);
        }
      } else {
        // Idle on ramp: prevent sliding down
        finalVelX = 0;
        finalVelZ = 0;
        finalVelY = 0;
      }
    } else {
      // In air / falling: allow gravity to pull agent down naturally
      finalVelY = currentLinvel.y;
    }

    // Apply combined steering velocities directly to Rapier Dynamic Rigid Body
    this.body.setLinvel({
      x: finalVelX,
      y: finalVelY,
      z: finalVelZ,
    }, true);

    // Smooth rotational facing orientation towards movement direction
    const moveSpeedH = Math.hypot(finalVelX, finalVelZ);
    if (moveSpeedH > 0.2) {
      const targetAngle = Math.atan2(finalVelX, finalVelZ);
      let diff = targetAngle - this.currentFacing;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      this.currentFacing += diff * Math.min(1.0, 10.0 * dt);
      this.model.group.rotation.y = this.currentFacing;
    }

    // Update 3D Character Model animations
    this.model.updateAnimation(
      dt,
      {
        isGrounded: isGrounded,
        isMoving: moveSpeedH > 0.15,
        isSprinting: moveSpeedH > AI_STEERING_CONFIG.PATROL_SPEED + 0.5,
        isCrouching: false,
        isDashing: false,
        speed: moveSpeedH,
        verticalVelocity: finalVelY,
      },
      null
    );

    // Update Debug Arrow (indicating current steering velocity)
    if (this.debugArrow) {
      this.debugArrow.position.copy(pos);
      if (speedH > 0.1) {
        this.debugArrow.setDirection(new THREE.Vector3(desiredVelX, 0, desiredVelZ).normalize());
        this.debugArrow.setLength(Math.min(2.5, speedH * 0.5));
        this.debugArrow.visible = true;
      } else {
        this.debugArrow.visible = false;
      }
    }

    // Update Dynamic Chase Line Visualization along active NavMesh corridor
    if (this.chaseLine) {
      if (this.followPathBehavior.active && this.currentPathWaypoints.length > 0) {
        const pts: THREE.Vector3[] = [pos.clone()];
        for (let i = this.currentWaypointIndex; i < this.currentPathWaypoints.length; i++) {
          const wp = this.currentPathWaypoints[i];
          pts.push(new THREE.Vector3(wp.x, wp.y + 0.25, wp.z));
        }
        if (pts.length >= 2) {
          this.chaseLine.visible = true;
          this.chaseLine.geometry.dispose();
          this.chaseLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
        } else {
          this.chaseLine.visible = false;
        }
      } else if (this.arriveBehavior.active) {
        this.chaseLine.visible = true;
        this.chaseLine.geometry.dispose();
        this.chaseLine.geometry = new THREE.BufferGeometry().setFromPoints([
          pos.clone(),
          new THREE.Vector3(playerPos.x, playerPos.y + 0.25, playerPos.z)
        ]);
      } else {
        this.chaseLine.visible = false;
      }
    }
  }

  /**
   * Standalone update fallback if not managed by AIAgentManager.
   */
  public update(dt: number, playerPos: THREE.Vector3): void {
    if (this.isDead) return;
    this.prepareUpdate(dt, playerPos);
    this.vehicle.update(dt);
    this.postUpdate(dt, playerPos);
  }

  public takeDamage(amount: number): void {
    if (this.isDead) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.die();
    }
  }

  public die(): void {
    this.isDead = true;
    this.deathTime = performance.now();
    this.vehicle.active = false;
    this.model.group.rotation.x = Math.PI / 2; // fall over
    this.model.group.position.y -= 1.0;

    // Remove physics colliders
    this.physics.world.removeCollider(this.collider, false);
    this.physics.world.removeRigidBody(this.body);

    if (this.debugArrow && this.debugArrow.parent) {
      this.debugArrow.parent.remove(this.debugArrow);
    }
    if (this.chaseLine) {
      this.chaseLine.visible = false;
    }
  }

  public destroy(): void {
    this.scene.remove(this.model.group);
    if (this.debugArrow && this.debugArrow.parent) {
      this.debugArrow.parent.remove(this.debugArrow);
    }
    if (this.pathLine && this.pathLine.parent) {
      this.pathLine.parent.remove(this.pathLine);
    }
    if (this.chaseLine && this.chaseLine.parent) {
      this.chaseLine.parent.remove(this.chaseLine);
    }
    if (!this.isDead) {
      this.physics.world.removeCollider(this.collider, false);
      this.physics.world.removeRigidBody(this.body);
    }
  }
}
