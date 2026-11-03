import * as THREE from 'three';
import * as YUKA from 'yuka';

const _poolCenter = new THREE.Vector3(95, -12, 0);
const SLEEP_DIST_SQ = 65 * 65;

interface TurtleState {
  group: THREE.Group;
  flippers: THREE.Mesh[]; // 0: FL, 1: FR, 2: BL, 3: BR
  head: THREE.Mesh;
  vehicle: YUKA.Vehicle;
  swimCycle: number;
}

function syncRenderComponent(entity: YUKA.GameEntity, renderComponent: THREE.Group) {
  renderComponent.matrix.copy(entity.worldMatrix as any);
}

export class TurtleSystem {
  private turtles: TurtleState[] = [];
  public group: THREE.Group;
  private isVisible: boolean = true;
  private entityManager: YUKA.EntityManager;

  constructor(private scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = 'TurtleSystem';
    this.scene.add(this.group);

    this.entityManager = new YUKA.EntityManager();

    // Create 2 turtles with different paths and slight scale variations
    const path1 = this.createCircularPath(95, -10, 0, 25, 25, 8, false);
    this.turtles.push(this.createTurtle(new THREE.Vector3(95, -10, 25), 1.0, path1, 1.5));

    const path2 = this.createCircularPath(95, -14, 0, 18, 18, 8, true);
    this.turtles.push(this.createTurtle(new THREE.Vector3(95, -14, -18), 0.85, path2, 1.2));
  }

  private createCircularPath(centerX: number, centerY: number, centerZ: number, radiusX: number, radiusZ: number, points: number, reverse: boolean = false): YUKA.Path {
    const path = new YUKA.Path();
    path.loop = true;
    for (let i = 0; i < points; i++) {
      let angle = (i / points) * Math.PI * 2;
      if (reverse) angle = -angle;
      // Add a little Y variation to make swimming more natural
      const y = centerY + Math.sin(angle * 2) * 2;
      path.add(new YUKA.Vector3(centerX + Math.cos(angle) * radiusX, y, centerZ + Math.sin(angle) * radiusZ));
    }
    return path;
  }

  private createTurtle(startPos: THREE.Vector3, scaleModifier: number, path: YUKA.Path, speed: number): TurtleState {
    const turtleGroup = new THREE.Group();
    // Note: Yuka handles rotation and position via matrix sync, so we must set matrixAutoUpdate to false
    turtleGroup.matrixAutoUpdate = false;
    
    // Create an inner group for the mesh to scale it properly without affecting Yuka's matrix
    const meshGroup = new THREE.Group();
    meshGroup.scale.set(scaleModifier, scaleModifier, scaleModifier);
    turtleGroup.add(meshGroup);

    // Materials - Low Poly flat shading
    const shellMat = new THREE.MeshLambertMaterial({ color: 0x3d5229, flatShading: true });
    const skinMat = new THREE.MeshLambertMaterial({ color: 0x5a6b41, flatShading: true });
    const bellyMat = new THREE.MeshLambertMaterial({ color: 0xbaa875, flatShading: true });

    // Shell (Carapace)
    const shellGeo = new THREE.DodecahedronGeometry(1.2, 0);
    const shell = new THREE.Mesh(shellGeo, shellMat);
    shell.scale.set(1, 0.4, 1.2);
    shell.position.y = 0.2;
    shell.castShadow = false;
    shell.receiveShadow = false;
    meshGroup.add(shell);

    // Belly (Plastron)
    const bellyGeo = new THREE.DodecahedronGeometry(1.15, 0);
    const belly = new THREE.Mesh(bellyGeo, bellyMat);
    belly.scale.set(1, 0.3, 1.15);
    belly.position.y = 0.05;
    belly.castShadow = false;
    belly.receiveShadow = false;
    meshGroup.add(belly);

    // Head (Facing +Z because Yuka's default forward vector is +Z)
    const headGeo = new THREE.BoxGeometry(0.5, 0.4, 0.6);
    const head = new THREE.Mesh(headGeo, skinMat);
    // Moved head to +1.3 (Z) instead of -1.3
    head.position.set(0, 0.2, 1.3);
    head.castShadow = false;
    meshGroup.add(head);

    // Flippers
    const flippers: THREE.Mesh[] = [];
    const createFlipper = (isFront: boolean, isLeft: boolean) => {
      const width = isFront ? 1.4 : 0.8;
      const length = isFront ? 0.6 : 0.5;
      
      const geo = new THREE.BoxGeometry(width, 0.1, length);
      geo.translate((width / 2) * (isLeft ? 1 : -1), 0, 0);
      
      const flipper = new THREE.Mesh(geo, skinMat);
      flipper.castShadow = false;
      flipper.receiveShadow = false;
      
      const xPos = isLeft ? 0.8 : -0.8;
      // Front is now +Z, back is -Z
      const zPos = isFront ? 0.7 : -1.0; 
      
      flipper.position.set(xPos, 0.1, zPos);
      
      if (isFront) {
        flipper.rotation.y = isLeft ? -0.3 : 0.3;
      } else {
        flipper.rotation.y = isLeft ? 0.2 : -0.2;
      }
      
      meshGroup.add(flipper);
      return flipper;
    };

    flippers.push(createFlipper(true, true));   // FL (0)
    flippers.push(createFlipper(true, false));  // FR (1)
    flippers.push(createFlipper(false, true));  // BL (2)
    flippers.push(createFlipper(false, false)); // BR (3)

    this.group.add(turtleGroup);

    // Setup YUKA Vehicle
    const vehicle = new YUKA.Vehicle();
    vehicle.position.set(startPos.x, startPos.y, startPos.z);
    vehicle.maxSpeed = speed;
    
    // Add path following behavior
    const followPathBehavior = new YUKA.FollowPathBehavior(path, 0.5);
    vehicle.steering.add(followPathBehavior);
    
    // Smooth out rotation
    vehicle.smoother = new YUKA.Smoother(20);
    
    // Sync Three.js rendering with Yuka
    vehicle.setRenderComponent(turtleGroup, syncRenderComponent);

    this.entityManager.add(vehicle);

    return {
      group: turtleGroup,
      flippers,
      head,
      vehicle,
      swimCycle: Math.random() * Math.PI * 2,
    };
  }

  public update(dt: number, playerPos?: THREE.Vector3) {
    if (playerPos) {
      const distSq = playerPos.distanceToSquared(_poolCenter);
      if (distSq > SLEEP_DIST_SQ) {
        if (this.isVisible) {
          this.isVisible = false;
          this.group.visible = false;
        }
        return; // Pause simulation
      }
      if (!this.isVisible) {
        this.isVisible = true;
        this.group.visible = true;
      }
    }

    // Step the YUKA entity manager to update vehicle positions/rotations along the path
    this.entityManager.update(dt);

    for (const turtle of this.turtles) {
      // Animate Flippers and Head based on current velocity
      const speed = turtle.vehicle.velocity.length();
      
      // If moving, flap flippers. If slow/stopped, glide.
      // We scale the animation speed slightly by actual movement speed
      turtle.swimCycle += dt * (2.0 + speed); 
      
      const rawFlap = Math.sin(turtle.swimCycle);
      const flapActive = Math.max(0, rawFlap);
      
      // Front flippers (powerful sweeps)
      turtle.flippers[0].rotation.z = -flapActive * 0.6; // FL
      turtle.flippers[1].rotation.z = flapActive * 0.6; // FR
      
      // Back flippers (gentle stabilizing, slightly out of phase)
      const backFlap = Math.sin(turtle.swimCycle - 1.0);
      turtle.flippers[2].rotation.z = -backFlap * 0.2; // BL
      turtle.flippers[3].rotation.z = backFlap * 0.2; // BR

      // Head gently looks around and bobs slightly
      turtle.head.rotation.y = Math.sin(turtle.swimCycle * 0.4) * 0.15;
      turtle.head.rotation.x = Math.sin(turtle.swimCycle * 0.2) * 0.1;
    }
  }

  public dispose(): void {
    this.turtles.forEach((t) => {
      t.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
      this.entityManager.remove(t.vehicle);
    });
    this.entityManager.clear();
    this.scene.remove(this.group);
  }
}

