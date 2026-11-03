import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Low-poly farm pickup truck. Forward is +Z, origin at the chassis centre.
 *
 * Draw-call budget: the whole body is merged into one mesh per material (4 calls) and the
 * four wheels share a single geometry pair, so the truck costs ~12 draw calls in total.
 */
export class VehicleModel {
  public readonly group = new THREE.Group();
  public readonly chassisMesh = new THREE.Group();
  /** [FL, FR, RL, RR]; each pivot steers around Y, its child spins around X. */
  public readonly wheelPivots: THREE.Group[] = [];
  private readonly wheelSpinners: THREE.Group[] = [];
  private readonly tailLightMaterial: THREE.MeshLambertMaterial;
  private readonly promptSprite: THREE.Sprite;

  private static readonly _steerQ = new THREE.Quaternion();
  private static readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(public readonly wheelRadius: number, wheelLocalPositions: THREE.Vector3[]) {
    this.group.name = 'FarmTruck';
    this.group.add(this.chassisMesh);

    const paint = new THREE.MeshLambertMaterial({ color: 0xd9534f });
    const trim = new THREE.MeshLambertMaterial({ color: 0x3b3f46 });
    const glass = new THREE.MeshLambertMaterial({ color: 0x9fc6d8 });
    const wood = new THREE.MeshLambertMaterial({ color: 0xa87444 });
    this.tailLightMaterial = new THREE.MeshLambertMaterial({ color: 0x8a1010, emissive: 0x550000 });
    const headLight = new THREE.MeshBasicMaterial({ color: 0xfff6d0 });

    const parts: Record<'paint' | 'trim' | 'glass' | 'wood', THREE.BufferGeometry[]> = {
      paint: [],
      trim: [],
      glass: [],
      wood: [],
    };
    const box = (bucket: keyof typeof parts, w: number, h: number, d: number, x: number, y: number, z: number) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);
      parts[bucket].push(g);
    };

    // Chassis & body
    box('trim', 1.7, 0.18, 4.0, 0, 0.32, 0); // frame
    box('paint', 1.8, 0.5, 1.5, 0, 0.66, 1.2); // hood
    box('paint', 1.8, 0.95, 1.25, 0, 0.88, -0.05); // cab
    box('glass', 1.62, 0.42, 0.06, 0, 1.12, 0.6); // windscreen
    box('glass', 1.84, 0.36, 0.9, 0, 1.12, -0.05); // side windows
    box('paint', 1.84, 0.08, 1.3, 0, 1.38, -0.05); // roof
    box('trim', 1.9, 0.22, 0.16, 0, 0.5, 2.0); // front bumper
    box('trim', 1.9, 0.18, 0.14, 0, 0.48, -2.02); // rear bumper
    // Truck bed: wooden floor and side boards
    box('wood', 1.7, 0.08, 1.55, 0, 0.66, -1.45);
    box('paint', 0.1, 0.38, 1.55, -0.85, 0.86, -1.45);
    box('paint', 0.1, 0.38, 1.55, 0.85, 0.86, -1.45);
    box('paint', 1.8, 0.38, 0.1, 0, 0.86, -2.2);
    // Fenders
    for (const p of wheelLocalPositions) box('trim', 0.4, 0.12, 0.95, Math.sign(p.x) * 0.82, 0.78, p.z);

    const mats = { paint, trim, glass, wood };
    for (const key of Object.keys(parts) as (keyof typeof parts)[]) {
      const merged = mergeGeometries(parts[key])!;
      parts[key].forEach((g) => g.dispose());
      this.chassisMesh.add(new THREE.Mesh(merged, mats[key]));
    }

    // Lights are emissive quads, not real lights (real SpotLights are too expensive on phones)
    const lightGeo = new THREE.PlaneGeometry(0.32, 0.16);
    for (const sx of [-0.6, 0.6]) {
      const head = new THREE.Mesh(lightGeo, headLight);
      head.position.set(sx, 0.72, 1.96);
      this.chassisMesh.add(head);
      const tail = new THREE.Mesh(lightGeo, this.tailLightMaterial);
      tail.position.set(sx, 0.86, -2.26);
      tail.rotation.y = Math.PI;
      this.chassisMesh.add(tail);
    }

    // Wheels: one tyre + one rim geometry shared by all four
    const tyreGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.3, 16);
    tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(wheelRadius * 0.55, wheelRadius * 0.55, 0.32, 8);
    rimGeo.rotateZ(Math.PI / 2);
    const tyreMat = new THREE.MeshLambertMaterial({ color: 0x24262b });
    const rimMat = new THREE.MeshLambertMaterial({ color: 0xe8e2d4 });
    for (const p of wheelLocalPositions) {
      const pivot = new THREE.Group();
      pivot.position.copy(p);
      const spinner = new THREE.Group();
      spinner.add(new THREE.Mesh(tyreGeo, tyreMat), new THREE.Mesh(rimGeo, rimMat));
      pivot.add(spinner);
      this.group.add(pivot);
      this.wheelPivots.push(pivot);
      this.wheelSpinners.push(spinner);
    }

    // "E" prompt bubble above the cab
    this.promptSprite = createPromptSprite();
    this.promptSprite.position.set(0, 2.2, 0);
    this.group.add(this.promptSprite);
  }

  public setPromptVisible(visible: boolean): void {
    this.promptSprite.visible = visible;
  }

  public setBrakeLights(isBraking: boolean): void {
    this.tailLightMaterial.emissive.setHex(isBraking ? 0xff1a1a : 0x550000);
  }

  /** suspensionY is the wheel centre height in chassis space; spin accumulates around X. */
  public setWheel(index: number, suspensionY: number, steering: number, spin: number): void {
    const pivot = this.wheelPivots[index];
    pivot.position.y = suspensionY;
    pivot.quaternion.copy(VehicleModel._steerQ.setFromAxisAngle(VehicleModel._up, steering));
    this.wheelSpinners[index].rotation.x = spin;
  }
}

let promptTexture: THREE.CanvasTexture | null = null;

/** "E" bubble (sprite = always faces the camera, no per-frame lookAt), hidden until the player is near. */
export function createPromptSprite(): THREE.Sprite {
  if (!promptTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(64, 64, 56, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#334155';
    ctx.font = 'bold 64px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('E', 64, 68);
    promptTexture = new THREE.CanvasTexture(c);
    promptTexture.colorSpace = THREE.SRGBColorSpace;
  }
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: promptTexture, depthTest: false }));
  sprite.scale.set(0.7, 0.7, 1);
  sprite.visible = false;
  sprite.renderOrder = 10;
  return sprite;
}
