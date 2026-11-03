import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PHYSICS_CONFIG, COLLISION_GROUPS } from '../config/constants';

// Thread-safe WASM loader lock
let rapierInitPromise: Promise<void> | null = null;

export class PhysicsWorld {
  public world!: RAPIER.World;
  public rapier!: typeof RAPIER;
  private initialized: boolean = false;
  private currentGravityY: number = PHYSICS_CONFIG.GRAVITY;

  public async init(): Promise<void> {
    if (this.initialized) return;
    
    if (!rapierInitPromise) {
      rapierInitPromise = RAPIER.init();
    }
    await rapierInitPromise;
    
    this.rapier = RAPIER;
    const gravity = new RAPIER.Vector3(0, this.currentGravityY, 0);
    this.world = new RAPIER.World(gravity);
    this.initialized = true;
  }

  public isInitialized(): boolean {
    return this.initialized && !!this.world;
  }

  public setGravity(y: number): void {
    if (!Number.isFinite(y)) return;
    this.currentGravityY = y;
    if (this.world) {
      this.world.gravity = { x: 0, y: y, z: 0 };
    }
  }

  public getGravity(): number {
    return this.currentGravityY;
  }

  public dispose(): void {
    this.initialized = false;
    if (this.world) {
      try {
        this.world.free();
      } catch {
        // Ignore if already freed
      }
      this.world = undefined as any;
    }
  }

  public step(dt: number): void {
    if (!this.world || !this.initialized) return;
    try {
      // Sub-stepping for rock-solid stability and prevent tunneling
      const timestep = Math.min(Math.max(dt, 0.001), 0.05);
      if (!Number.isFinite(timestep)) return;
      this.world.timestep = timestep;
      this.world.step();
    } catch (err) {
      console.warn('[PhysicsWorld] Step error:', err);
    }
  }

  public createStaticBox(
    position: THREE.Vector3,
    size: THREE.Vector3,
    rotation: THREE.Euler = new THREE.Euler(),
    group: number = COLLISION_GROUPS.ENVIRONMENT
  ): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    const bodyDesc = this.rapier.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z);
    const quat = new THREE.Quaternion().setFromEuler(rotation);
    bodyDesc.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });

    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = this.rapier.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
      .setFriction(0.6)
      .setRestitution(0.0)
      .setCollisionGroups(this.packCollisionGroups(group, 0xffff));

    const collider = this.world.createCollider(colliderDesc, body);
    return { body, collider };
  }

  public createStaticCylinder(
    position: THREE.Vector3,
    radius: number,
    height: number,
    rotation: THREE.Euler = new THREE.Euler(),
    group: number = COLLISION_GROUPS.ENVIRONMENT
  ): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    const bodyDesc = this.rapier.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z);
    const quat = new THREE.Quaternion().setFromEuler(rotation);
    bodyDesc.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });

    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = this.rapier.ColliderDesc.cylinder(height / 2, radius)
      .setFriction(0.6)
      .setRestitution(0.0)
      .setCollisionGroups(this.packCollisionGroups(group, 0xffff));

    const collider = this.world.createCollider(colliderDesc, body);
    return { body, collider };
  }

  public removeRigidBody(body: RAPIER.RigidBody): void {
    if (!this.world || !this.initialized || !body) return;
    try {
      if (body.isValid()) {
        this.world.removeRigidBody(body);
      }
    } catch (err) {
      console.warn('[PhysicsWorld] removeRigidBody error:', err);
    }
  }

  public removeCollider(collider: RAPIER.Collider): void {
    if (!this.world || !this.initialized || !collider) return;
    try {
      if (collider.isValid()) {
        this.world.removeCollider(collider, true);
      }
    } catch (err) {
      console.warn('[PhysicsWorld] removeCollider error:', err);
    }
  }

  public createStaticTrimesh(
    position: THREE.Vector3,
    vertices: Float32Array,
    indices: Uint32Array,
    group: number = COLLISION_GROUPS.ENVIRONMENT
  ): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    // Safely copy Float32Array and Uint32Array to guarantee they are fresh, non-pooled views 
    // starting at byte offset 0 in WebAssembly memory.
    const cleanVertices = new Float32Array(vertices);
    const cleanIndices = new Uint32Array(indices);

    const bodyDesc = this.rapier.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z);
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = this.rapier.ColliderDesc.trimesh(cleanVertices, cleanIndices)
      .setFriction(0.6)
      .setCollisionGroups(this.packCollisionGroups(group, 0xffff));

    const collider = this.world.createCollider(colliderDesc, body);
    return { body, collider };
  }

  public createDynamicProp(
    position: THREE.Vector3,
    type: 'box' | 'sphere' | 'cylinder',
    size: THREE.Vector3 | number | { radius: number; height: number },
    mass: number = 15.0
  ): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    const bodyDesc = this.rapier.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setLinearDamping(0.3)
      .setAngularDamping(0.5);

    const body = this.world.createRigidBody(bodyDesc);
    let colliderDesc: RAPIER.ColliderDesc;

    if (type === 'sphere') {
      const radius = typeof size === 'number' ? size : (size as THREE.Vector3).x;
      colliderDesc = this.rapier.ColliderDesc.ball(radius);
    } else if (type === 'cylinder') {
      const cyl = size as { radius: number; height: number };
      const r = typeof cyl.radius === 'number' ? cyl.radius : 0.5;
      const h = typeof cyl.height === 'number' ? cyl.height : 1.0;
      colliderDesc = this.rapier.ColliderDesc.cylinder(h / 2, r);
    } else {
      const s = size as THREE.Vector3;
      colliderDesc = this.rapier.ColliderDesc.cuboid(s.x / 2, s.y / 2, s.z / 2);
    }

    colliderDesc.setMass(mass).setFriction(0.5).setRestitution(0.3)
      .setCollisionGroups(this.packCollisionGroups(COLLISION_GROUPS.DYNAMIC_PROPS, 0xffff));

    const collider = this.world.createCollider(colliderDesc, body);
    return { body, collider };
  }

  /**
   * Finds the nearest dynamic rigid body to a given origin point within maxRadius
   */
  public findNearestDynamicBody(
    origin: THREE.Vector3,
    maxRadius: number,
    excludeBody?: RAPIER.RigidBody
  ): RAPIER.RigidBody | null {
    if (!this.world || !this.initialized) return null;

    let nearestBody: RAPIER.RigidBody | null = null;
    let minDistanceSq = maxRadius * maxRadius;
    const excludeHandle = (excludeBody && typeof excludeBody.handle === 'number') ? excludeBody.handle : -1;

    try {
      this.world.forEachRigidBody((body: RAPIER.RigidBody) => {
        try {
          if (!body || !body.isValid() || !body.isDynamic()) return;
          if ((body as any).isVehicle || (body.userData as any)?.isVehicle) return;
          if (excludeHandle !== -1 && body.handle === excludeHandle) {
            return;
          }

          const pos = body.translation();
          if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;

          const dx = pos.x - origin.x;
          const dy = pos.y - origin.y;
          const dz = pos.z - origin.z;
          const distSq = dx * dx + dy * dy + dz * dz;

          if (distSq < minDistanceSq) {
            minDistanceSq = distSq;
            nearestBody = body;
          }
        } catch {
          // Safe guard per body handle
        }
      });
    } catch (err) {
      console.warn('[PhysicsWorld] findNearestDynamicBody error:', err);
    }

    return nearestBody;
  }

  /**
   * Helper to pack 16-bit membership and 16-bit filter into 32-bit Rapier collision groups
   */
  public packCollisionGroups(membership: number, filter: number): number {
    return ((membership & 0xffff) << 16) | (filter & 0xffff);
  }

  /**
   * Casts a single ray against the physics world
   */
  public castRay(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxToi: number,
    solid: boolean = true,
    filterFlags?: number,
    filterGroups?: number,
    excludeCollider?: RAPIER.Collider
  ): RAPIER.RayColliderHit | null {
    if (!this.world || !this.initialized) return null;

    if (
      !Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.z) ||
      !Number.isFinite(direction.x) || !Number.isFinite(direction.y) || !Number.isFinite(direction.z) ||
      direction.lengthSq() < 0.000001
    ) {
      return null;
    }

    let validExcludeCollider: RAPIER.Collider | undefined = excludeCollider;
    if (validExcludeCollider) {
      try {
        if (!validExcludeCollider.isValid() || typeof validExcludeCollider.handle !== 'number') {
          validExcludeCollider = undefined;
        }
      } catch {
        validExcludeCollider = undefined;
      }
    }

    try {
      const ray = new this.rapier.Ray(
        { x: origin.x, y: origin.y, z: origin.z },
        { x: direction.x, y: direction.y, z: direction.z }
      );

      return this.world.castRay(
        ray,
        maxToi,
        solid,
        filterFlags,
        filterGroups,
        validExcludeCollider
      );
    } catch {
      return null;
    }
  }

  /**
   * Casts a ray and also computes the normal at the hit point
   */
  public castRayAndGetNormal(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxToi: number,
    excludeCollider?: RAPIER.Collider,
    filterGroups?: number
  ): { hit: RAPIER.RayColliderHit; normal: THREE.Vector3; point: THREE.Vector3 } | null {
    if (!this.world || !this.initialized) return null;

    if (
      !Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.z) ||
      !Number.isFinite(direction.x) || !Number.isFinite(direction.y) || !Number.isFinite(direction.z) ||
      direction.lengthSq() < 0.000001
    ) {
      return null;
    }

    let validExcludeCollider: RAPIER.Collider | undefined = excludeCollider;
    if (validExcludeCollider) {
      try {
        if (!validExcludeCollider.isValid() || typeof validExcludeCollider.handle !== 'number') {
          validExcludeCollider = undefined;
        }
      } catch {
        validExcludeCollider = undefined;
      }
    }

    try {
      const ray = new this.rapier.Ray(
        { x: origin.x, y: origin.y, z: origin.z },
        { x: direction.x, y: direction.y, z: direction.z }
      );

      const hit = this.world.castRayAndGetNormal(
        ray,
        maxToi,
        true,
        undefined,
        filterGroups,
        validExcludeCollider
      );

      if (!hit || !hit.normal) return null;
      if (!Number.isFinite(hit.normal.x) || !Number.isFinite(hit.normal.y) || !Number.isFinite(hit.normal.z)) return null;

      const point = new THREE.Vector3(
        origin.x + direction.x * hit.timeOfImpact,
        origin.y + direction.y * hit.timeOfImpact,
        origin.z + direction.z * hit.timeOfImpact
      );

      const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
      if (normal.lengthSq() > 0.000001) {
        normal.normalize();
      } else {
        normal.set(0, 1, 0);
      }

      return { hit, normal, point };
    } catch {
      return null;
    }
  }
}
