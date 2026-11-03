import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CHARACTER_CONFIG } from '../config/constants';
import { FarmingMeshGenerator } from '../farming/FarmingMeshGenerator';
import { buildRunClip } from './ProceduralRunClip';

export interface AnimationState {
  isGrounded: boolean;
  isMoving: boolean;
  isSprinting: boolean;
  isCrouching: boolean;
  isDashing: boolean;
  isClimbing?: boolean;
  isClimbingMoving?: boolean;
  isHoldingObject?: boolean;
  isSwimming?: boolean;
  swimDepth?: number;
  activeWeapon?: number;
  isAiming?: boolean;
  speed: number;
  verticalVelocity: number;
  velocity3D?: THREE.Vector3;
}

/** Roblox-style character exported from roblox_animation.blend (6-bone rig, clips named in CAPS). */
const MODEL_URL = '/models/roblox_character.glb';

/** Bone that holds tools in the source rig (the Axe/Pickaxe previews are parented to it). */
const TOOL_HAND_BONE = 'arm_1_left';
/** Grip point along the arm bone, matching the tool previews in Blender (bone tail - 0.1). */
const TOOL_GRIP_OFFSET = new THREE.Vector3(0, 1.25, 0);

/** Root bone whose translation keys are dropped from JUMP: the physics body already does the hop. */
const ROOT_BONE = 'body';
/** Leg bones whose meshes are sampled to measure how fast each clip moves the feet over the ground. */
const LEG_BONES = ['leg_1_right', 'leg_1_left'];
/** Ground speed fallbacks (m/s) measured on the exported clips, used if measuring fails. */
const FALLBACK_GROUND_SPEED = { WALK: 0.63, RUN: 2.9 };
/** WALK is stretched up to this playback rate before RUN takes over. */
const MAX_WALK_TIME_SCALE = 2.0;
/** Speed band (m/s) around the WALK/RUN switch so the clip does not flicker. */
const GAIT_HYSTERESIS = 0.2;
const MAX_LOCOMOTION_TIME_SCALE = 4.0;

type LocomotionClip = 'IDLE' | 'WALK' | 'RUN' | 'JUMP' | 'FALL';
type OneShotClip = 'CHOP' | 'MINE' | 'PICKUP_ONE_HAND';

const LOOPING_CLIPS: LocomotionClip[] = ['IDLE', 'WALK', 'RUN', 'FALL'];
const ONE_SHOT_CLIPS: OneShotClip[] = ['CHOP', 'MINE', 'PICKUP_ONE_HAND'];

const LOCOMOTION_FADE = 0.2;
const ONE_SHOT_FADE = 0.08;
const AXE_SWING_DURATION = 0.6;
const MINE_SWING_DURATION = 0.7;

export class CharacterModel {
  public group: THREE.Group;
  public leanVisualEntity: THREE.Group;
  public squashGroup: THREE.Group;

  // Custom Model & Materials
  private customModelGroup: THREE.Group;
  private materials: THREE.Material[] = [];

  // Three.js Animation Mixer & clip state machine
  private mixer: THREE.AnimationMixer | null = null;
  private actions: Map<string, THREE.AnimationAction> = new Map();
  private currentLocomotion: LocomotionClip | null = null;
  private oneShot: THREE.AnimationAction | null = null;
  // Ground speed (m/s) at which each clip's feet stay planted, measured once the model loads
  private walkGroundSpeed: number = FALLBACK_GROUND_SPEED.WALK;
  private runGroundSpeed: number = FALLBACK_GROUND_SPEED.RUN;

  // Weapon / tool mount attachment pivot
  public weaponPivot: THREE.Group;

  private currentFacingAngle: number = 0;

  /** Seated on a scooter: thighs forward, hands on the handlebar (layered over IDLE). */
  public isRiding = false;
  private rig: THREE.Object3D | null = null;

  // Squash & Stretch Spring Physics (Feet-anchored, Mario Odyssey style)
  public currentSquashY: number = 1.0;
  private squashVelocity: number = 0;

  public activeWeapon: number = 0;
  public weaponRecoilKick: number = 0;
  public axeSwingProgress: number = 0;
  public wateringProgress: number = 0;

  // Caustics projection callback holder
  private waterEffectsProjection: { applyProjectedCaustics: (mat: THREE.Material) => void } | null = null;

  // Shared GLTF model cache
  private static gltfCache: { scene: THREE.Group; animations: THREE.AnimationClip[] } | null = null;
  private static gltfLoadPromise: Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> | null = null;

  constructor(private tintColor: number = 0xffffff) {
    this.group = new THREE.Group();
    this.group.name = 'CozyCharacterRoot';

    this.leanVisualEntity = new THREE.Group();
    this.leanVisualEntity.name = 'leanVisualEntity';
    this.group.add(this.leanVisualEntity);

    this.squashGroup = new THREE.Group();
    this.squashGroup.name = 'squashGroup';
    this.leanVisualEntity.add(this.squashGroup);

    this.customModelGroup = new THREE.Group();
    this.customModelGroup.name = 'CozyModelContainer';
    this.squashGroup.add(this.customModelGroup);

    // Initial weapon pivot in case accessed before GLTF binds
    this.weaponPivot = new THREE.Group();
    this.weaponPivot.name = 'WeaponMountPivot';
    this.customModelGroup.add(this.weaponPivot);

    // Load or instantiate custom character
    this.setupCharacterModel();
  }

  /**
   * Preloads the custom GLTF model into static cache
   */
  public static async preload(): Promise<void> {
    if (CharacterModel.gltfCache) return;
    if (CharacterModel.gltfLoadPromise) {
      await CharacterModel.gltfLoadPromise;
      return;
    }

    const loader = new GLTFLoader();
    CharacterModel.gltfLoadPromise = new Promise((resolve, reject) => {
      loader.load(
        MODEL_URL,
        (gltf) => {
          CharacterModel.gltfCache = {
            scene: gltf.scene,
            animations: gltf.animations,
          };
          resolve(CharacterModel.gltfCache);
        },
        undefined,
        (err) => {
          console.error(`[CharacterModel] Failed to load ${MODEL_URL}:`, err);
          reject(err);
        }
      );
    });

    await CharacterModel.gltfLoadPromise;
  }

  private setupCharacterModel(): void {
    if (CharacterModel.gltfCache) {
      this.initFromGLTF(CharacterModel.gltfCache);
    } else {
      CharacterModel.preload()
        .then(() => {
          if (CharacterModel.gltfCache) {
            this.initFromGLTF(CharacterModel.gltfCache);
          }
        })
        .catch((err) => {
          console.warn('[CharacterModel] Using fallback initialization:', err);
        });
    }
  }

  private initFromGLTF(data: { scene: THREE.Group; animations: THREE.AnimationClip[] }): void {
    // Clone character scene using SkeletonUtils to ensure deep skeleton cloning
    const cloned = cloneSkeleton(data.scene) as THREE.Group;
    cloned.name = 'CozyCharacterSkinned';

    // Fit the rest pose to the game capsule height (1.50m) with feet at the capsule bottom (-0.75m)
    const targetHeight = (CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT + CHARACTER_CONFIG.CAPSULE_RADIUS) * 2;
    cloned.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(cloned);
    const modelScale = targetHeight / Math.max(0.001, bounds.max.y - bounds.min.y);

    cloned.scale.setScalar(modelScale);
    const baseFeetOffset = -(CHARACTER_CONFIG.CAPSULE_HALF_HEIGHT + CHARACTER_CONFIG.CAPSULE_RADIUS);
    cloned.position.set(0, baseFeetOffset - bounds.min.y * modelScale, 0);

    // Swap glTF PBR materials for cheap Lambert ones (keeps texture, vertex colors and tint)
    this.materials = [];
    cloned.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;

      const origMat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
      const lambertMat = new THREE.MeshLambertMaterial({
        vertexColors: !!mesh.geometry.attributes.color,
        color: this.tintColor !== 0xffffff ? this.tintColor : origMat?.color?.getHex() ?? 0xffffff,
        map: origMat?.map ?? null,
      });
      mesh.material = lambertMat;
      this.materials.push(lambertMat);
      this.waterEffectsProjection?.applyProjectedCaustics(lambertMat);
    });

    // Attach weapon pivot to the tool hand; tools are modelled in meters, so undo the model scale
    const toolHand = cloned.getObjectByName(TOOL_HAND_BONE);
    if (toolHand) {
      this.weaponPivot.parent?.remove(this.weaponPivot);
      this.weaponPivot.position.copy(TOOL_GRIP_OFFSET);
      this.weaponPivot.rotation.set(0, 0, 0);
      this.weaponPivot.scale.setScalar(1 / modelScale);
      toolHand.add(this.weaponPivot);
    }

    this.setupAnimations(cloned, data.animations);

    // Clean previous children in container and add cloned model
    while (this.customModelGroup.children.length > 0) {
      this.customModelGroup.remove(this.customModelGroup.children[0]);
    }
    this.customModelGroup.add(cloned);
    this.rig = cloned;

    // Re-equip current weapon / prop if one was already set
    if (this.activeWeapon > 0) {
      this.reapplyEquippedWeapon();
    }
  }

  private setupAnimations(root: THREE.Object3D, clips: THREE.AnimationClip[]): void {
    this.mixer = new THREE.AnimationMixer(root);
    this.actions.clear();
    this.currentLocomotion = null;
    this.oneShot = null;

    const register = (name: string, clip: THREE.AnimationClip, loop: THREE.AnimationActionLoopStyles) => {
      const action = this.mixer!.clipAction(clip);
      action.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
      // JUMP holds its airborne pose until FALL takes over
      action.clampWhenFinished = name === 'JUMP';
      this.actions.set(name, action);
    };

    // RUN is generated in code (energetic arm pump, longer stride); the Blender RUN is the fallback
    const generatedRun = buildRunClip(root);
    for (const name of LOOPING_CLIPS) {
      const clip = name === 'RUN' && generatedRun ? generatedRun.clip : THREE.AnimationClip.findByName(clips, name);
      if (clip) register(name, clip, THREE.LoopRepeat);
    }

    const jumpClip = THREE.AnimationClip.findByName(clips, 'JUMP');
    if (jumpClip) {
      const inPlace = jumpClip.clone();
      inPlace.tracks = inPlace.tracks.filter((t) => t.name !== `${ROOT_BONE}.position`);
      register('JUMP', inPlace, THREE.LoopOnce);
    }

    for (const name of ONE_SHOT_CLIPS) {
      const clip = THREE.AnimationClip.findByName(clips, name);
      if (clip) register(name, clip, THREE.LoopOnce);
    }

    // When a one-shot (chop, watering) ends, blend back into the current locomotion clip
    this.mixer.addEventListener('finished', (e) => {
      if (e.action !== this.oneShot) return;
      this.oneShot = null;
      if (this.currentLocomotion) this.playLocomotion(this.currentLocomotion, true);
    });

    this.walkGroundSpeed = this.measureGroundSpeed(root, 'WALK') ?? FALLBACK_GROUND_SPEED.WALK;
    // The generated RUN knows its exact ground speed; Blender clips are measured
    this.runGroundSpeed = generatedRun?.groundSpeed ?? this.measureGroundSpeed(root, 'RUN') ?? FALLBACK_GROUND_SPEED.RUN;

    this.playLocomotion('IDLE', true);
  }

  /**
   * Samples a looping gait clip and returns how fast (m/s, model scale) a planted foot moves backwards,
   * i.e. the movement speed at which the clip plays without foot sliding.
   * Only frames where a foot touches the ground count, so flight phases (both feet up) are ignored, and the
   * touching vertex is followed between frames, so the heel-to-toe roll of the rigid leg blocks is not
   * mistaken for movement.
   */
  private measureGroundSpeed(root: THREE.Object3D, name: LocomotionClip): number | null {
    const action = this.actions.get(name);
    if (!this.mixer || !action) return null;

    const feet = LEG_BONES.map((bone) => {
      let mesh: THREE.Mesh | null = null;
      root.getObjectByName(bone)?.traverse((o) => {
        if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
      });
      return mesh as THREE.Mesh | null;
    });
    if (feet.some((f) => !f)) return null;

    const tmp = new THREE.Vector3();
    /** Root-space y/z of every vertex of a leg mesh. */
    const vertices = (mesh: THREE.Mesh) => {
      const pos = mesh.geometry.attributes.position;
      const ys = new Float32Array(pos.count);
      const zs = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        tmp.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        ys[i] = tmp.y;
        zs[i] = tmp.z;
      }
      return { ys, zs };
    };

    const duration = action.getClip().duration;
    const steps = 240;
    const dt = duration / steps;
    action.reset().setEffectiveWeight(1).play();

    const samples: { ys: Float32Array; zs: Float32Array }[][] = [];
    for (let i = 0; i < steps; i++) {
      action.time = i * dt;
      this.mixer.update(0);
      root.updateMatrixWorld(true);
      samples.push(feet.map((mesh) => vertices(mesh!)));
    }
    action.stop();

    // root has no parent yet, so matrixWorld already includes the model scale: values are in game meters
    const groundY = Math.min(...samples.map((frame) => Math.min(...frame.map((f) => Math.min(...f.ys)))));
    const groundedEps = 0.003;

    // Track the material point touching the ground: the lowest vertex in one frame, followed into the next.
    // Summed over every frame a foot is down (cyclic sampling), that gives how fast planted feet move back.
    let distance = 0;
    let time = 0;
    for (let k = 0; k < feet.length; k++) {
      for (let i = 0; i < steps; i++) {
        const a = samples[i][k];
        const b = samples[(i + 1) % steps][k];
        let lowest = 0;
        for (let v = 1; v < a.ys.length; v++) if (a.ys[v] < a.ys[lowest]) lowest = v;
        if (a.ys[lowest] < groundY + groundedEps && b.ys[lowest] < groundY + groundedEps) {
          distance += a.zs[lowest] - b.zs[lowest];
          time += dt;
        }
      }
    }
    if (time <= 0) return null;
    const speed = distance / time;
    return speed > 0.05 ? speed : null;
  }

  private playLocomotion(name: LocomotionClip, restart: boolean = false): void {
    if (name === this.currentLocomotion && !restart) return;
    const next = this.actions.get(name);
    if (!next) return;

    const prev = this.currentLocomotion ? this.actions.get(this.currentLocomotion) : undefined;
    this.currentLocomotion = name;
    if (this.oneShot) return; // resumed when the one-shot finishes

    if (prev && prev !== next) prev.fadeOut(LOCOMOTION_FADE);
    next.reset().setEffectiveWeight(1).fadeIn(LOCOMOTION_FADE).play();
  }

  /** Plays a full-body clip once, stretched to `duration` seconds, then returns to locomotion. */
  private playOneShot(name: OneShotClip, duration: number): void {
    const action = this.actions.get(name);
    if (!action) return;

    if (this.oneShot && this.oneShot !== action) this.oneShot.fadeOut(ONE_SHOT_FADE);
    const locomotion = this.currentLocomotion ? this.actions.get(this.currentLocomotion) : undefined;
    locomotion?.fadeOut(ONE_SHOT_FADE);

    action.reset();
    action.timeScale = action.getClip().duration / duration;
    action.setEffectiveWeight(1).fadeIn(ONE_SHOT_FADE).play();
    this.oneShot = action;
  }

  private selectLocomotion(state: AnimationState): LocomotionClip {
    if (state.isSwimming || state.isClimbing) {
      return state.isMoving || state.isClimbingMoving ? 'WALK' : 'IDLE';
    }
    if (!state.isGrounded) {
      return state.verticalVelocity > 0 ? 'JUMP' : 'FALL';
    }
    if (!state.isMoving) return 'IDLE';
    return this.selectGait(state.speed);
  }

  /** WALK for slow movement, RUN once WALK would have to play faster than MAX_WALK_TIME_SCALE. */
  private selectGait(speed: number): LocomotionClip {
    const switchSpeed = this.walkGroundSpeed * MAX_WALK_TIME_SCALE;
    if (this.currentLocomotion === 'RUN') {
      return speed < switchSpeed - GAIT_HYSTERESIS ? 'WALK' : 'RUN';
    }
    return speed > switchSpeed + GAIT_HYSTERESIS ? 'RUN' : 'WALK';
  }

  public triggerJumpSquash(): void {
    // Compress Y scale down immediately before jump launch
    this.squashVelocity = -6.5;
  }

  public triggerJumpLaunch(): void {
    // Stretch Y scale upward immediately upon takeoff
    this.squashVelocity = 9.0;
  }

  public triggerLandingSquash(impactSpeed: number): void {
    const intensity = Math.min(Math.abs(impactSpeed) / 7.0, 1.8);
    this.squashVelocity = -5.5 * Math.max(0.6, intensity);
  }

  public triggerWeaponRecoil(intensity: number = 1.0): void {
    this.weaponRecoilKick = Math.min(this.weaponRecoilKick + intensity, 2.5);
  }

  public triggerAxeSwing(): void {
    this.axeSwingProgress = 1.0;
    this.playOneShot('CHOP', AXE_SWING_DURATION);
  }

  public triggerMineSwing(): void {
    this.axeSwingProgress = 1.0;
    this.playOneShot('MINE', MINE_SWING_DURATION);
  }

  public triggerWatering(duration: number = 1.1): void {
    this.wateringProgress = duration;
    this.playOneShot('PICKUP_ONE_HAND', duration);
  }

  public isActivelyPouringWater(): boolean {
    return this.activeWeapon === 10 && this.wateringProgress > 0.20 && this.wateringProgress < 0.88;
  }

  public getWateringNozzleWorldPosition(target: THREE.Vector3): boolean {
    if (this.activeWeapon !== 10) return false;
    const nozzleAnchor = this.weaponPivot.getObjectByName('NozzleAnchor');
    if (nozzleAnchor) {
      nozzleAnchor.getWorldPosition(target);
      return true;
    }
    this.weaponPivot.getWorldPosition(target);
    return true;
  }

  private equippedPropId: string | null = null;

  public equipWeapon(type: number): void {
    this.activeWeapon = type;
    this.equippedPropId = null;
    this.reapplyEquippedWeapon();
  }

  public equipToolOrProp(itemId: string | null): void {
    // Inventory notifies on every change (water level, harvest, pickups); only react to a real swap
    if (itemId === this.equippedPropId && this.weaponPivot.children.length > 0) return;
    this.equippedPropId = itemId;
    this.wateringProgress = 0;

    if (!itemId) {
      this.activeWeapon = 0;
      this.reapplyEquippedWeapon();
      return;
    }

    if (itemId === 'axe') {
      this.activeWeapon = 6;
    } else if (itemId === 'pickaxe') {
      this.activeWeapon = 12;
    } else if (itemId === 'watering_can') {
      this.activeWeapon = 10;
    } else if (itemId === 'fishing_rod') {
      this.activeWeapon = 13;
    } else if (itemId.endsWith('_seed')) {
      this.activeWeapon = 11;
    } else {
      this.activeWeapon = 0;
    }

    this.reapplyEquippedWeapon();
  }

  // Held-item meshes are built once per item and reused, so swapping tools never allocates GPU memory
  private heldItemCache = new Map<string, THREE.Object3D[]>();

  private reapplyEquippedWeapon(): void {
    // Detach (not dispose) the previous item: it stays cached for the next swap
    while (this.weaponPivot.children.length > 0) {
      this.weaponPivot.remove(this.weaponPivot.children[0]);
    }

    const cacheKey = `${this.activeWeapon}:${this.activeWeapon === 11 ? this.equippedPropId : ''}`;
    const cached = this.heldItemCache.get(cacheKey);
    if (cached) {
      for (const child of cached) this.weaponPivot.add(child);
      return;
    }
    this.buildHeldItem();
    this.heldItemCache.set(cacheKey, [...this.weaponPivot.children]);
  }

  private buildHeldItem(): void {

    if (this.activeWeapon === 6) {
      // Woodcutter's Axe
      const axeGroup = new THREE.Group();

      const handleGeo = new THREE.CylinderGeometry(0.025, 0.035, 0.85, 8);
      const handleMat = new THREE.MeshLambertMaterial({ color: 0x8b5a2b });
      const handleMesh = new THREE.Mesh(handleGeo, handleMat);
      handleMesh.position.set(0, 0.15, 0.05);
      handleMesh.rotation.x = Math.PI / 8;
      axeGroup.add(handleMesh);

      const wrapGeo = new THREE.CylinderGeometry(0.036, 0.036, 0.25, 8);
      const wrapMat = new THREE.MeshLambertMaterial({ color: 0x4a2e1b });
      const wrapMesh = new THREE.Mesh(wrapGeo, wrapMat);
      axeGroup.add(wrapMesh);

      const headMat = new THREE.MeshLambertMaterial({ color: 0x475569 });
      const headGeo = new THREE.BoxGeometry(0.07, 0.16, 0.20);
      const headMesh = new THREE.Mesh(headGeo, headMat);
      headMesh.position.set(0, 0.48, 0.18);
      axeGroup.add(headMesh);

      const bladeMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
      const bladeGeo = new THREE.ConeGeometry(0.12, 0.24, 4);
      const bladeMesh = new THREE.Mesh(bladeGeo, bladeMat);
      bladeMesh.rotation.x = -Math.PI / 2;
      bladeMesh.rotation.y = Math.PI / 4;
      bladeMesh.position.set(0, 0.48, 0.32);
      axeGroup.add(bladeMesh);

      const buttGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.08, 8);
      const buttMesh = new THREE.Mesh(buttGeo, headMat);
      buttMesh.position.set(0, -0.22, -0.07);
      axeGroup.add(buttMesh);

      this.weaponPivot.add(axeGroup);
    } else if (this.activeWeapon === 12) {
      // Pickaxe: wooden handle with a curved iron head
      const pickGroup = new THREE.Group();
      const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.032, 0.8, 8),
        new THREE.MeshLambertMaterial({ color: 0x8b5a2b })
      );
      handle.position.set(0, 0.15, 0);
      pickGroup.add(handle);

      const ironMat = new THREE.MeshLambertMaterial({ color: 0x64748b });
      const head = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.035, 6, 12, Math.PI * 0.8), ironMat);
      head.position.set(0, 0.42, 0);
      head.rotation.set(Math.PI / 2, 0, Math.PI * 0.1);
      pickGroup.add(head);

      const collar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.07), ironMat);
      collar.position.set(0, 0.55, 0);
      pickGroup.add(collar);

      this.weaponPivot.add(pickGroup);
    } else if (this.activeWeapon === 10) {
      // Heartopia Watering Can
      const can = FarmingMeshGenerator.createWateringCan();
      can.position.set(0.01, -0.06, 0.08);
      can.rotation.set(0.04, 0, 0);
      this.weaponPivot.add(can);
    } else if (this.activeWeapon === 13) {
      // Fishing rod: tapered pole held forward and up, with a reel
      const rod = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.018, 1.5, 6), new THREE.MeshLambertMaterial({ color: 0x8b5a2b }));
      pole.position.set(0, 0.55, 0.25);
      pole.rotation.x = 0.75;
      rod.add(pole);
      const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 10), new THREE.MeshLambertMaterial({ color: 0x475569 }));
      reel.rotation.z = Math.PI / 2;
      reel.position.set(0.03, 0.02, 0.0);
      rod.add(reel);
      this.weaponPivot.add(rod);
    } else if (this.activeWeapon === 11 && this.equippedPropId) {
      // Seed Pouch
      const seedPouch = new THREE.Group();
      const bagGeo = new THREE.SphereGeometry(0.08, 8, 8);
      bagGeo.scale(1, 1.2, 0.8);
      const bagMat = new THREE.MeshLambertMaterial({
        color: this.equippedPropId.includes('wheat')
          ? 0xeab308
          : this.equippedPropId.includes('carrot')
          ? 0xf97316
          : 0xef4444,
      });
      const bagMesh = new THREE.Mesh(bagGeo, bagMat);
      bagMesh.position.set(0, -0.08, 0.08);
      seedPouch.add(bagMesh);
      this.weaponPivot.add(seedPouch);
    }
  }

  /**
   * Main update loop driving character locomotion, skeletal clips, dynamic lean, and spring physics.
   */
  public updateAnimation(
    dt: number,
    state: AnimationState,
    targetMoveAngle: number | null,
    accelerationRatio: number = 0
  ): void {
    let turnDelta = 0;

    // 1. Smooth model rotation to face movement or aiming direction
    if (targetMoveAngle !== null) {
      const diff = Math.atan2(
        Math.sin(targetMoveAngle - this.currentFacingAngle),
        Math.cos(targetMoveAngle - this.currentFacingAngle)
      );
      turnDelta = diff;
      const rotationSpeed = 16.0 * dt;
      const step = diff * Math.min(1.0, rotationSpeed);
      this.currentFacingAngle += step;
      this.group.rotation.y = this.currentFacingAngle;
    }

    // 2. Squash & Stretch Harmonic Spring Dynamics (Mario Odyssey style feet-anchored bounce)
    const stiffness = CHARACTER_CONFIG.SQUASH_SPRING_STIFFNESS;
    const damping = CHARACTER_CONFIG.SQUASH_SPRING_DAMPING;

    const displacement = 1.0 - this.currentSquashY;
    const springForce = displacement * stiffness;
    const dampingForce = -this.squashVelocity * damping;
    const acceleration = springForce + dampingForce;

    this.squashVelocity += acceleration * dt;
    this.currentSquashY += this.squashVelocity * dt;
    this.currentSquashY = THREE.MathUtils.clamp(this.currentSquashY, 0.55, 1.50);

    const scaleY = this.currentSquashY;
    const scaleXZ = 1.0 / Math.sqrt(Math.max(0.2, scaleY));
    this.squashGroup.scale.set(scaleXZ, scaleY, scaleXZ);

    // 3. Dynamic Lean Effect (Pitch into acceleration/sprint/dive and banking roll into turns)
    let targetPitchLean = 0;
    if (state.isSwimming) {
      const depth = state.swimDepth !== undefined ? state.swimDepth : 0;
      const surfaceFactor = THREE.MathUtils.clamp((0.5 - depth) / 0.35, 0, 1);

      const vel = state.velocity3D;
      const vx = vel ? vel.x : 0;
      const vy = vel ? vel.y : (state.verticalVelocity || 0);
      const vz = vel ? vel.z : 0;
      const moveSpeed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const isMoving = moveSpeed > 0.15;

      let underwaterPitch = 0;
      if (isMoving) {
        const dirY = vy / Math.max(0.001, moveSpeed);
        underwaterPitch = (Math.PI / 2) - Math.asin(THREE.MathUtils.clamp(dirY, -0.999, 0.999));
      } else {
        underwaterPitch = 0.0;
      }

      const surfacePitch = isMoving ? 0.80 : 0.15;
      targetPitchLean = THREE.MathUtils.lerp(underwaterPitch, surfacePitch, surfaceFactor);
    } else if (state.isClimbing) {
      targetPitchLean = 0.15;
    } else if (state.isGrounded) {
      if (state.isDashing) {
        targetPitchLean = 0.26;
      } else if (state.isSprinting) {
        // The RUN clip already leans the torso; tilting the whole model on top lifts heels / sinks toes
        targetPitchLean = 0.05;
      } else if (state.isMoving) {
        targetPitchLean = 0;
      } else if (accelerationRatio < -0.1) {
        targetPitchLean = -0.10;
      }
    } else {
      targetPitchLean = state.verticalVelocity > 0 ? 0.08 : -0.06;
    }

    let targetRollLean = 0;
    if (!state.isClimbing && state.isMoving && Math.abs(turnDelta) > 0.02) {
      targetRollLean = THREE.MathUtils.clamp(
        -turnDelta * 0.35 * (state.isSprinting ? 1.4 : 1.0),
        -0.22,
        0.22
      );
    }

    const leanAlpha = 1.0 - Math.exp(-12.0 * dt);
    this.leanVisualEntity.rotation.x = THREE.MathUtils.lerp(
      this.leanVisualEntity.rotation.x,
      targetPitchLean,
      leanAlpha
    );
    this.leanVisualEntity.rotation.z = THREE.MathUtils.lerp(
      this.leanVisualEntity.rotation.z,
      targetRollLean,
      leanAlpha
    );

    // 4. Skeletal clip state machine & speed sync
    if (this.wateringProgress > 0) {
      this.wateringProgress = Math.max(0, this.wateringProgress - dt);
    }
    if (this.axeSwingProgress > 0) {
      this.axeSwingProgress = Math.max(0, this.axeSwingProgress - dt * 3.8);
    }
    this.weaponRecoilKick = THREE.MathUtils.lerp(this.weaponRecoilKick, 0, 1.0 - Math.exp(-22.0 * dt));

    this.playLocomotion(this.selectLocomotion(state));

    // Play gait clips exactly as fast as the body moves, so planted feet do not slide
    const currentSpeed = Math.max(0, state.speed || 0);
    const walkAction = this.actions.get('WALK');
    const runAction = this.actions.get('RUN');
    if (walkAction) {
      walkAction.timeScale = THREE.MathUtils.clamp(currentSpeed / this.walkGroundSpeed, 0.3, MAX_LOCOMOTION_TIME_SCALE);
    }
    if (runAction) {
      runAction.timeScale = THREE.MathUtils.clamp(currentSpeed / this.runGroundSpeed, 0.3, MAX_LOCOMOTION_TIME_SCALE);
    }

    if (this.mixer) {
      this.mixer.update(dt);
    }
    if (this.isRiding) this.applyRidingPose();
  }

  private static readonly _poseQ = new THREE.Quaternion();
  private static readonly _parentQ = new THREE.Quaternion();
  private static readonly _rootQ = new THREE.Quaternion();
  private static readonly _rootInv = new THREE.Quaternion();
  private static readonly _xAxis = new THREE.Vector3(1, 0, 0);

  /**
   * Rotates limb bones about the character's own sideways axis on top of whatever the mixer posed.
   * Working in model space keeps this independent of the rig's odd bone rolls.
   */
  private applyRidingPose(): void {
    if (!this.rig) return;
    this.rig.updateMatrixWorld(true);
    const rootQ = this.group.getWorldQuaternion(CharacterModel._rootQ);
    const rootInv = CharacterModel._rootInv.copy(rootQ).invert();
    const pose: [string, number][] = [
      ['leg_1_right', -1.05],
      ['leg_1_left', -1.05],
      ['arm_1_right', -1.15],
      ['arm_1_left', -1.15],
    ];
    for (const [name, angle] of pose) {
      const bone = this.rig.getObjectByName(name);
      if (!bone?.parent) continue;
      // R_world = root * R_model * root^-1; local' = parent^-1 * R_world * parent * local
      const world = CharacterModel._poseQ.setFromAxisAngle(CharacterModel._xAxis, angle).premultiply(rootQ).multiply(rootInv);
      const parentQ = bone.parent.getWorldQuaternion(CharacterModel._parentQ);
      bone.quaternion.premultiply(parentQ).premultiply(world).premultiply(parentQ.invert());
    }
  }

  public setFacingAngleInstant(angle: number): void {
    this.currentFacingAngle = angle;
    this.group.rotation.y = angle;
  }

  public applyCausticsProjection(waterEffects: { applyProjectedCaustics: (mat: THREE.Material) => void }): void {
    this.waterEffectsProjection = waterEffects;
    this.materials.forEach((m) => waterEffects.applyProjectedCaustics(m));
  }
}

// Pre-trigger background load so assets are cached immediately
CharacterModel.preload().catch(() => {});

