import * as THREE from 'three';
import * as YUKA from 'yuka';

interface FlockConfig {
  count: number;
  color: number;
  scale: number;
  center: THREE.Vector3;
  radius: number;
}

// Check if current device is mobile or tablet to scale down simulation load
const isMobileDevice = (): boolean => {
  if (typeof navigator !== 'undefined') {
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
      return true;
    }
  }
  if (typeof window !== 'undefined' && window.innerWidth < 768) {
    return true;
  }
  return false;
};

// Zero-allocation reusable helpers
const _dummy = new THREE.Object3D();
const _centerPos = new YUKA.Vector3(95, -12, 0);
const _tempDir = new YUKA.Vector3();
const _poolCenterThree = new THREE.Vector3(95, -12, 0);
const SLEEP_DISTANCE_SQ = 65 * 65; // Sleep simulation when player is > 65m away from pool

export class FishFlockSystem {
  public entityManager: YUKA.EntityManager;
  private time: YUKA.Time;
  private boids: YUKA.Vehicle[] = [];
  private meshes: THREE.InstancedMesh[] = [];
  private fleeTarget: YUKA.Vector3;
  private fleeBehavior: YUKA.FleeBehavior;
  private boidsPerMesh: { mesh: THREE.InstancedMesh; vehicles: YUKA.Vehicle[] }[] = [];
  private isVisible: boolean = true;
  private isMobile: boolean = false;
  private aiAccumulator: number = 0;

  constructor(private scene: THREE.Scene) {
    this.entityManager = new YUKA.EntityManager();
    this.time = new YUKA.Time();
    this.isMobile = isMobileDevice();
    
    // Flee target (player)
    this.fleeTarget = new YUKA.Vector3();
    this.fleeBehavior = new YUKA.FleeBehavior(this.fleeTarget, 8);
    this.fleeBehavior.weight = 5;
  }

  public createFlock(config: FlockConfig) {
    // Adaptively scale count for mobile performance while preserving visuals
    const count = this.isMobile 
      ? Math.max(4, Math.round(config.count * 0.35)) 
      : config.count;

    // Stylized fish geometry from a Box
    const geometry = new THREE.BoxGeometry(0.2 * config.scale, 0.4 * config.scale, 1.0 * config.scale, 1, 2, 4);
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);
      
      // Normalize z to -0.5..0.5 space based on length (1.0 * scale)
      const nz = z / (1.0 * config.scale);
      
      if (nz > 0.4) {
          x *= 0.1;
          y *= 0.2;
      } else if (nz > 0.1) {
          x *= 0.8;
          y *= 0.9;
      } else if (nz > -0.2) {
          x *= 1.0;
          y *= 1.0;
      } else if (nz > -0.4) {
          x *= 0.2;
          y *= 0.5;
      } else {
          x *= 0.05; // Tail is flat
          y *= 1.5;  // Tail flares out
      }
      
      pos.setXYZ(i, x, y, z);
    }
    geometry.computeVertexNormals();
    
    const material = new THREE.MeshLambertMaterial({ 
      color: config.color,
    });
    
    const instancedMesh = new THREE.InstancedMesh(geometry, material, count);
    // Disable shadow maps casting to save huge GPU overhead on mobile
    instancedMesh.castShadow = false;
    instancedMesh.receiveShadow = false;
    instancedMesh.frustumCulled = false;
    this.scene.add(instancedMesh);
    
    const vehicles: YUKA.Vehicle[] = [];
    
    const alignment = new YUKA.AlignmentBehavior();
    alignment.weight = 1;
    const cohesion = new YUKA.CohesionBehavior();
    cohesion.weight = 0.8;
    const separation = new YUKA.SeparationBehavior();
    separation.weight = 1.2;
    const wander = new YUKA.WanderBehavior();
    wander.weight = 0.5;

    // Home center attraction (corals/reefs) so fish naturally linger around their reef
    const homeTarget = new YUKA.Vector3(config.center.x, config.center.y, config.center.z);
    const seekHome = new YUKA.SeekBehavior(homeTarget);
    seekHome.weight = 0.35;

    for (let i = 0; i < count; i++) {
      const boid = new YUKA.Vehicle();
      
      const x = config.center.x + (Math.random() - 0.5) * config.radius;
      const y = config.center.y + (Math.random() - 0.5) * config.radius;
      const z = config.center.z + (Math.random() - 0.5) * config.radius;
      
      boid.position.set(x, y, z);
      boid.maxSpeed = 2 + Math.random() * 2;
      boid.maxForce = 5;
      
      boid.steering.add(alignment);
      boid.steering.add(cohesion);
      boid.steering.add(separation);
      boid.steering.add(wander);
      boid.steering.add(seekHome);
      boid.steering.add(this.fleeBehavior);
      
      boid.boundingRadius = 0.5;
      
      this.entityManager.add(boid);
      vehicles.push(boid);
      this.boids.push(boid);
    }
    
    this.boidsPerMesh.push({ mesh: instancedMesh, vehicles });
    this.meshes.push(instancedMesh);
  }

  public update(playerPos: THREE.Vector3, dt: number) {
    // 1. Proximity Culling: If player is far from the water pool, sleep simulation & hide meshes
    const distSqToPool = playerPos.distanceToSquared(_poolCenterThree);
    if (distSqToPool > SLEEP_DISTANCE_SQ) {
      if (this.isVisible) {
        this.isVisible = false;
        for (let i = 0; i < this.meshes.length; i++) {
          this.meshes[i].visible = false;
        }
      }
      return;
    }

    if (!this.isVisible) {
      this.isVisible = true;
      for (let i = 0; i < this.meshes.length; i++) {
        this.meshes[i].visible = true;
      }
    }

    // 2. Throttled AI Sub-stepping (30 FPS on mobile / 60 FPS on desktop)
    this.fleeTarget.set(playerPos.x, playerPos.y, playerPos.z);
    
    this.aiAccumulator += dt;
    const aiStepTime = this.isMobile ? 0.033 : 0.016;

    if (this.aiAccumulator >= aiStepTime) {
      this.entityManager.update(this.aiAccumulator);
      this.aiAccumulator = 0;
    }
    
    // 3. Zero-allocation matrix updates & soft water boundary bounce
    for (let g = 0; g < this.boidsPerMesh.length; g++) {
      const group = this.boidsPerMesh[g];
      const mesh = group.mesh;
      const vehicles = group.vehicles;

      for (let i = 0; i < vehicles.length; i++) {
        const boid = vehicles[i];
        
        _dummy.position.set(boid.position.x, boid.position.y, boid.position.z);
        _dummy.quaternion.set(boid.rotation.x, boid.rotation.y, boid.rotation.z, boid.rotation.w);
        _dummy.updateMatrix();
        
        mesh.setMatrixAt(i, _dummy.matrix);
        
        // Keep fish underwater constraint
        const distanceToCenter = boid.position.squaredDistanceTo(_centerPos);
        if (distanceToCenter > 1600 || boid.position.y > -2 || boid.position.y < -23) {
          _tempDir.copy(_centerPos).sub(boid.position).normalize();
          boid.velocity.add(_tempDir.multiplyScalar(0.1));
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  public dispose() {
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i];
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(m => m.dispose());
      } else {
        mesh.material.dispose();
      }
      this.scene.remove(mesh);
    }
    this.entityManager.clear();
  }
}
