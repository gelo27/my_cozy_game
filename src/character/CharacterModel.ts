import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CHARACTER_CONFIG } from '../config/constants';
import { FarmingMeshGenerator } from '../farming/FarmingMeshGenerator';

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

/** Blocky character (6-bone rig, clips named in CAPS: locomotion, jump phases, swimming, tool use). */
const MODEL_URL = `${import.meta.env.BASE_URL}models/character.glb`;

/** Bone that holds tools in the source rig (the Axe/Pickaxe previews are parented to it). */
const TOOL_HAND_BONE = 'arm_1_left';
/** Grip point along the arm bone, matching the tool previews in Blender (bone tail - 0.1). */
const TOOL_GRIP_OFFSET = new THREE.Vector3(0, 1.25, 0);

/** Leg bones whose meshes are sampled to measure how fast each clip moves the feet over the ground. */
const LEG_BONES = ['leg_1_right', 'leg_1_left'];
/** Ground speed fallbacks (m/s) measured on the exported clips, used if measuring fails. */
const FALLBACK_GROUND_SPEED = { WALK: 0.63, RUN: 2.9 };
/** WALK is stretched up to this playback rate before RUN takes over. */
const MAX_WALK_TIME_SCALE = 2.0;
/** Speed band (m/s) around the WALK/RUN switch so the clip does not flicker. */
const GAIT_HYSTERESIS = 0.2;
const MAX_LOCOMOTION_TIME_SCALE = 4.0;
/**
 * The RUN clip has a short stride, so matching the feet exactly makes jogging / sprinting look frantic.
 * Above this playback rate only RUN_RATE_ABOVE_KNEE of the extra speed goes into cadence (feet slide a little).
 */
const RUN_RATE_KNEE = 1.3;
const RUN_RATE_ABOVE_KNEE = 0.45;

type LocomotionClip =
  | 'IDLE' | 'WALK' | 'RUN' | 'JUMP_AIR' | 'FALL'
  | 'SWIM_IDLE' | 'SWIM_SURFACE' | 'SWIM_UNDERWATER';
type OneShotClip = 'CHOP' | 'MINE' | 'WATER' | 'JUMP_START' | 'LAND' | 'PICKUP_ONE_HAND';

const LOOPING_CLIPS: LocomotionClip[] = ['IDLE', 'WALK', 'RUN', 'JUMP_AIR', 'FALL', 'SWIM_IDLE', 'SWIM_SURFACE', 'SWIM_UNDERWATER'];
const ONE_SHOT_CLIPS: OneShotClip[] = ['CHOP', 'MINE', 'WATER', 'JUMP_START', 'LAND', 'PICKUP_ONE_HAND'];
/** Older exports lack some clips: play the closest one instead. */
const CLIP_FALLBACKS: Partial<Record<LocomotionClip | OneShotClip, string>> = {
  JUMP_AIR: 'FALL',
  SWIM_IDLE: 'IDLE',
  SWIM_SURFACE: 'WALK',
  SWIM_UNDERWATER: 'WALK',
  WATER: 'PICKUP_ONE_HAND',
};

const LOCOMOTION_FADE = 0.2;
const SWIM_FADE = 0.35;
const ONE_SHOT_FADE = 0.08;
const AXE_SWING_DURATION = 0.6;
const MINE_SWING_DURATION = 0.7;
/** JUMP_START skips its crouch (physics already launched the body) and plays the push-off at 1x. */
const JUMP_START_SKIP = 0.12;
const LAND_DURATION = 0.5;
/** LAND opens with the arms raised (the JUMP_AIR pose), so it needs a softer blend in. */
const LAND_FADE = 0.15;
/** A jump keeps the arms-up JUMP_AIR pose; FALL only takes over when dropping this fast (m/s, long falls). */
const JUMP_TO_FALL_SPEED = -9;
/** Leaving the ground without jumping keeps the ground clip this long, so bumps and slopes do not flash FALL. */
const FALL_DELAY = 0.25;
/** Default watering clip length (s); the WATER clip is ~3.2s at 1x. */
const WATERING_DURATION = 2.0;
/** One-hand pick-up after a harvest (the clip is ~1.9 s at 1x; a little brisker reads better). */
const PICKUP_DURATION = 1.3;
/** Part of the WATER clip (fraction of its length) where the can is tipped and water flows. */
const WATER_POUR_WINDOW: [number, number] = [0.2, 0.8];
/** Speed (m/s) at which the swim stroke clips play at 1x. */
const SWIM_CLIP_SPEED = 2.5;
/** Within this depth (m) of the surface the character swims on top of the water. */
const SURFACE_SWIM_DEPTH = 0.5;
/** Body pitch (rad) while swimming on the surface: legs lower, head up. */
const SURFACE_SWIM_PITCH = -0.32;

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
  /** Clip times (s) where a foot touches down, per gait clip (measured from the clip itself). */
  private readonly footPlants = new Map<LocomotionClip, number[]>();
  private gaitClip: LocomotionClip | null = null;
  private gaitTime = 0;
  /** Called when a foot touches the ground while walking/running; intensity ~0.35 sneak, 0.6 walk, 1 run. */
  public onFootstep: ((intensity: number) => void) | null = null;
  // Ground speed (m/s) at which each clip's feet stay planted, measured once the model loads
  private walkGroundSpeed: number = FALLBACK_GROUND_SPEED.WALK;
  private runGroundSpeed: number = FALLBACK_GROUND_SPEED.RUN;

  // Weapon / tool mount attachment pivot
  public weaponPivot: THREE.Group;

  private currentFacingAngle: number = 0;

  /** Seated on a scooter: thighs forward, hands on the handlebar (layered over IDLE). */
  public isRiding = false;
  private rig: THREE.Object3D | null = null;
  private bodyPartCache: { bone: THREE.Object3D; min: THREE.Vector3; max: THREE.Vector3 }[] | null = null;

  /**
   * The rig's rigid parts (body, head, arms, legs): each bone with the box (in its own space) of
   * the meshes it carries, held tools left out. Null until the model has loaded.
   */
  public bodyParts(): { bone: THREE.Object3D; min: THREE.Vector3; max: THREE.Vector3 }[] | null {
    if (!this.rig) return null;
    if (this.bodyPartCache) return this.bodyPartCache;
    this.rig.updateMatrixWorld(true);
    const parts: { bone: THREE.Object3D; min: THREE.Vector3; max: THREE.Vector3 }[] = [];
    const toBone = new THREE.Matrix4();
    const box = new THREE.Box3();
    const piece = new THREE.Box3();
    for (const name of ['body', 'head_1', 'arm_1_right', 'arm_1_left', 'leg_1_right', 'leg_1_left']) {
      const bone = this.rig.getObjectByName(name);
      if (!bone) continue;
      const inv = bone.matrixWorld.clone().invert();
      box.makeEmpty();
      const visit = (o: THREE.Object3D) => {
        for (const child of o.children) {
          // Other parts and the tool in hand are not this part
          if ((child as THREE.Bone).isBone || child === this.weaponPivot) continue;
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh) {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            box.union(piece.copy(mesh.geometry.boundingBox!).applyMatrix4(toBone.multiplyMatrices(inv, mesh.matrixWorld)));
          }
          visit(child);
        }
      };
      visit(bone);
      if (!box.isEmpty()) parts.push({ bone, min: box.min.clone(), max: box.max.clone() });
    }
    this.bodyPartCache = parts;
    return parts;
  }

  private limbTipCache: { bone: THREE.Object3D; tip: THREE.Vector3 }[] | null = null;

  /**
   * World positions of the ends of the limbs as animated last frame (hands and feet), in the order
   * right arm, left arm, right leg, left leg, written into `out` (4 vectors). The tip is the far end
   * of each part's box along its long axis. False until the model has loaded.
   */
  public limbTips(out: THREE.Vector3[]): boolean {
    if (!this.limbTipCache) {
      const parts = this.bodyParts();
      if (!parts) return false;
      const tips: { bone: THREE.Object3D; tip: THREE.Vector3 }[] = [];
      for (const name of ['arm_1_right', 'arm_1_left', 'leg_1_right', 'leg_1_left']) {
        const p = parts.find((q) => q.bone.name === name);
        if (!p) return false;
        const size = p.max.clone().sub(p.min);
        const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
        const tip = p.min.clone().add(p.max).multiplyScalar(0.5);
        tip[axis] = Math.abs(p.max[axis]) > Math.abs(p.min[axis]) ? p.max[axis] : p.min[axis];
        tips.push({ bone: p.bone, tip });
      }
      this.limbTipCache = tips;
    }
    for (let i = 0; i < 4; i++) out[i].copy(this.limbTipCache[i].tip).applyMatrix4(this.limbTipCache[i].bone.matrixWorld);
    return true;
  }

  // Squash & Stretch Spring Physics (Feet-anchored, Mario Odyssey style)
  public currentSquashY: number = 1.0;
  private squashVelocity: number = 0;

  public activeWeapon: number = 0;
  public weaponRecoilKick: number = 0;
  public axeSwingProgress: number = 0;
  public wateringProgress: number = 0;
  private wateringDuration: number = WATERING_DURATION;
  private swimAtSurface = true;
  /** Set by a jump, cleared on touching ground: picks JUMP_AIR over FALL while airborne. */
  private airborneFromJump = false;
  private airborneTime = 0;

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
    this.bodyPartCache = null;

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

    const register = (name: LocomotionClip | OneShotClip, loop: THREE.AnimationActionLoopStyles) => {
      const fallback = CLIP_FALLBACKS[name];
      const clip = THREE.AnimationClip.findByName(clips, name) ?? (fallback ? THREE.AnimationClip.findByName(clips, fallback) : null);
      if (!clip) return;
      // A fallback clip gets its own copy so timeScale / loop settings do not clash with the original
      const own = clip.name === name ? clip : clip.clone();
      own.name = name;
      const action = this.mixer!.clipAction(own);
      action.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
      // One-shots hold their last frame so they can cross-fade back into locomotion instead of
      // vanishing at once (which briefly blends the rig towards its bind pose)
      action.clampWhenFinished = loop === THREE.LoopOnce;
      this.actions.set(name, action);
    };

    for (const name of LOOPING_CLIPS) register(name, THREE.LoopRepeat);
    for (const name of ONE_SHOT_CLIPS) register(name, THREE.LoopOnce);

    // When a one-shot (chop, watering) ends, blend back into the current locomotion clip
    this.mixer.addEventListener('finished', (e) => {
      if (e.action === this.oneShot) this.cancelOneShot();
    });

    this.walkGroundSpeed = this.measureGroundSpeed(root, 'WALK') ?? FALLBACK_GROUND_SPEED.WALK;
    this.runGroundSpeed = this.measureGroundSpeed(root, 'RUN') ?? FALLBACK_GROUND_SPEED.RUN;

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

    // Footstep moments: the frames where a foot comes down onto the ground (for the step sounds)
    const plants: number[] = [];
    for (let k = 0; k < feet.length; k++) {
      // Per-foot ground level: a clip whose feet bottom out at slightly different heights would
      // otherwise never register the higher foot, leaving one step sound per stride instead of two
      const mins = samples.map((frame) => Math.min(...frame[k].ys));
      const footGround = Math.min(...mins);
      const low = mins.map((m) => m < footGround + 0.012);
      for (let i = 0; i < steps; i++) if (low[i] && !low[(i - 1 + steps) % steps]) plants.push(i * dt);
    }
    // The heel-to-toe roll touches down several times per step: keep the first touch of each step
    plants.sort((x, y) => x - y);
    const minGap = duration * 0.2;
    const merged: number[] = [];
    for (const p of plants) if (!merged.length || p - merged[merged.length - 1] >= minGap) merged.push(p);
    if (merged.length > 1 && merged[0] + duration - merged[merged.length - 1] < minGap) merged.pop();
    this.footPlants.set(name, merged.length ? merged : [0, duration / 2]);

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

    // Rolling between the upright and lying-flat swim poses needs a longer blend
    const swimBlend = name.startsWith('SWIM') || !!prev?.getClip().name.startsWith('SWIM');
    const fade = swimBlend ? SWIM_FADE : LOCOMOTION_FADE;
    if (prev && prev !== next) prev.fadeOut(fade);
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
  }

  /** Stops the playing one-shot early and blends back into locomotion. */
  private cancelOneShot(): void {
    if (!this.oneShot) return;
    this.oneShot.fadeOut(LOCOMOTION_FADE);
    this.oneShot = null;
    const name = this.currentLocomotion;
    if (name) {
      this.currentLocomotion = null;
      this.playLocomotion(name, true);
    }
  }

  private isPlayingOneShot(name: OneShotClip): boolean {
    return !!this.oneShot && this.oneShot === this.actions.get(name);
  }

  /** Plays a full-body clip once, stretched to `duration` seconds, then returns to locomotion. */
  private playOneShot(name: OneShotClip, duration: number, startAt = 0, fade = ONE_SHOT_FADE): void {
    const action = this.actions.get(name);
    if (!action) return;

    if (this.oneShot && this.oneShot !== action) this.oneShot.fadeOut(fade);
    const locomotion = this.currentLocomotion ? this.actions.get(this.currentLocomotion) : undefined;
    locomotion?.fadeOut(fade);

    action.reset();
    action.time = startAt;
    action.timeScale = (action.getClip().duration - startAt) / duration;
    action.setEffectiveWeight(1).fadeIn(fade).play();
    this.oneShot = action;
  }

  private selectLocomotion(state: AnimationState): LocomotionClip {
    if (state.isSwimming) {
      // Hysteresis so bobbing at the surface does not flip between the two strokes
      const depth = state.swimDepth ?? 0;
      if (this.swimAtSurface ? depth > SURFACE_SWIM_DEPTH + 0.15 : depth < SURFACE_SWIM_DEPTH - 0.1) {
        this.swimAtSurface = !this.swimAtSurface;
      }
      if (!state.isMoving) return 'SWIM_IDLE';
      return this.swimAtSurface ? 'SWIM_SURFACE' : 'SWIM_UNDERWATER';
    }
    this.swimAtSurface = true;
    if (state.isClimbing) {
      return state.isClimbingMoving ? 'WALK' : 'IDLE';
    }
    if (!state.isGrounded) {
      if (this.airborneFromJump) return state.verticalVelocity < JUMP_TO_FALL_SPEED ? 'FALL' : 'JUMP_AIR';
      if (state.verticalVelocity > 0) return 'JUMP_AIR';
      const onGroundClip = this.currentLocomotion === 'IDLE' || this.currentLocomotion === 'WALK' || this.currentLocomotion === 'RUN';
      if (onGroundClip && this.airborneTime < FALL_DELAY) return this.currentLocomotion!;
      return 'FALL';
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
    // Push-off pose that ends in the JUMP_AIR pose; never cuts into a tool swing
    this.airborneFromJump = true;
    if (!this.oneShot || this.isPlayingOneShot('LAND')) {
      const clip = this.actions.get('JUMP_START')?.getClip();
      if (clip) {
        const skip = Math.min(JUMP_START_SKIP, clip.duration * 0.5);
        this.playOneShot('JUMP_START', clip.duration - skip, skip);
      }
    }
  }

  /** Recovery crouch after a real fall; skipped when landing on the move (and cancelled as soon as you move). */
  public triggerLand(impactSpeed: number, horizontalSpeed: number): void {
    if (impactSpeed > -3.0 || horizontalSpeed > 1.0) return;
    if (this.oneShot && !this.isPlayingOneShot('JUMP_START')) return;
    this.playOneShot('LAND', LAND_DURATION, 0, LAND_FADE);
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

  public triggerWatering(duration: number = WATERING_DURATION): void {
    this.wateringProgress = duration;
    this.wateringDuration = duration;
    this.playOneShot('WATER', duration);
  }

  /** Bends down and picks the harvest up with one hand. */
  public triggerPickup(): void {
    this.playOneShot('PICKUP_ONE_HAND', PICKUP_DURATION);
  }

  /** True while an action that roots the player plays (watering, the harvest pick-up). */
  public isActionLocked(): boolean {
    // Chopping and mining root the player too, until the swing clip has played out
    return (
      this.isPlayingOneShot('WATER') ||
      this.isPlayingOneShot('PICKUP_ONE_HAND') ||
      this.isPlayingOneShot('CHOP') ||
      this.isPlayingOneShot('MINE')
    );
  }

  public isActivelyPouringWater(): boolean {
    if (this.activeWeapon !== 10 || this.wateringProgress <= 0) return false;
    const played = 1 - this.wateringProgress / this.wateringDuration;
    return played > WATER_POUR_WINDOW[0] && played < WATER_POUR_WINDOW[1];
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
    } else if (itemId === 'shovel') {
      this.activeWeapon = 14;
    } else if (itemId === 'watering_can') {
      this.activeWeapon = 10;
    } else if (itemId === 'fishing_rod') {
      this.activeWeapon = 13;
    } else if (itemId === 'slingshot') {
      this.activeWeapon = 15;

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
    } else if (this.activeWeapon === 14) {
      // Shovel: long wooden shaft, D-grip on top, rounded steel spade blade below the hand
      const shovel = new THREE.Group();
      const wood = new THREE.MeshLambertMaterial({ color: 0x8b5a2b });
      const steel = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 1.0, 8), wood);
      shaft.position.set(0, 0.12, 0);
      shovel.add(shaft);
      const grip = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.016, 6, 12), wood);
      grip.position.set(0, -0.42, 0);
      shovel.add(grip);
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.1, 8), steel);
      collar.position.set(0, 0.64, 0);
      shovel.add(collar);
      // Blade at the far (+y) end, like the axe / pickaxe heads, so the MINE swing drives it into the soil
      const bladeGeo = new THREE.SphereGeometry(0.13, 10, 8);
      bladeGeo.scale(1, 1.45, 0.18);
      const blade = new THREE.Mesh(bladeGeo, steel);
      blade.position.set(0, 0.84, 0.0);
      shovel.add(blade);
      this.weaponPivot.add(shovel);
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
    } else if (this.activeWeapon === 15) {
      // Slingshot: a forked hazel stick with a leather band (shared geometry is tiny, built once and cached)
      const sling = new THREE.Group();
      const wood = new THREE.MeshLambertMaterial({ color: 0x8b5a2b });
      const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.2, 6), wood);
      grip.position.set(0, 0.05, 0.06);
      sling.add(grip);
      const armGeo = new THREE.CylinderGeometry(0.016, 0.02, 0.15, 6);
      for (const sx of [-1, 1]) {
        const arm = new THREE.Mesh(armGeo, wood);
        arm.position.set(sx * 0.045, 0.2, 0.06);
        arm.rotation.z = -sx * 0.5;
        sling.add(arm);
      }
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.018, 0.012), new THREE.MeshLambertMaterial({ color: 0x5b3a1e }));
      band.position.set(0, 0.27, 0.06);
      sling.add(band);
      this.weaponPivot.add(sling);
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

      // The stroke clips already lie flat; underwater, tilt them to follow the swim direction
      let underwaterPitch = 0;
      if (isMoving) {
        const dirY = vy / Math.max(0.001, moveSpeed);
        underwaterPitch = -Math.asin(THREE.MathUtils.clamp(dirY, -0.999, 0.999));
      }
      // Swimming along the surface: hips sink and the head rises (negative pitch = head up); upright when idle
      const surfacePitch = isMoving ? SURFACE_SWIM_PITCH : 0;
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
    // Slingshot shot: the fork snaps forward and settles back
    if (this.activeWeapon === 15) this.weaponPivot.rotation.x = -this.weaponRecoilKick * 0.35;
    else if (this.weaponPivot.rotation.x !== 0) this.weaponPivot.rotation.x = 0;

    // Full-body one-shots that no longer fit once the situation changes
    if (this.isPlayingOneShot('LAND') && (state.isMoving || !state.isGrounded || state.isSwimming)) this.cancelOneShot();
    if (this.isPlayingOneShot('JUMP_START') && state.isSwimming) this.cancelOneShot();
    if (this.isPlayingOneShot('WATER') && state.isSwimming) {
      this.cancelOneShot();
      this.wateringProgress = 0;
    }

    if (state.isGrounded || state.isSwimming || state.isClimbing) {
      this.airborneTime = 0;
      // Ignore the first frames after takeoff, when the ground probe may still touch
      if (!this.isPlayingOneShot('JUMP_START')) this.airborneFromJump = false;
    } else {
      this.airborneTime += dt;
    }
    this.playLocomotion(this.selectLocomotion(state));

    // Play gait clips exactly as fast as the body moves, so planted feet do not slide
    const currentSpeed = Math.max(0, state.speed || 0);
    const walkAction = this.actions.get('WALK');
    const runAction = this.actions.get('RUN');
    if (walkAction) {
      walkAction.timeScale = THREE.MathUtils.clamp(currentSpeed / this.walkGroundSpeed, 0.3, MAX_LOCOMOTION_TIME_SCALE);
    }
    if (runAction) {
      const footLocked = currentSpeed / this.runGroundSpeed;
      const rate = footLocked <= RUN_RATE_KNEE ? footLocked : RUN_RATE_KNEE + (footLocked - RUN_RATE_KNEE) * RUN_RATE_ABOVE_KNEE;
      runAction.timeScale = THREE.MathUtils.clamp(rate, 0.3, MAX_LOCOMOTION_TIME_SCALE);
    }
    if (state.isSwimming) {
      const swimSpeed = state.velocity3D ? state.velocity3D.length() : currentSpeed;
      const strokeScale = THREE.MathUtils.clamp(swimSpeed / SWIM_CLIP_SPEED, 0.7, 1.8);
      for (const name of ['SWIM_SURFACE', 'SWIM_UNDERWATER'] as const) {
        const a = this.actions.get(name);
        if (a) a.timeScale = strokeScale;
      }
    }

    // The mixer only writes a bone when the clip's value changed since its last write, so the
    // riding offset of the previous frame must be undone first, or it is applied twice (arms flip up)
    this.restoreRidingPose();
    if (this.mixer) {
      this.mixer.update(dt);
    }
    this.detectFootsteps(state);
    if (this.isRiding) this.applyRidingPose();
  }

  /** Fires onFootstep each time the playing gait clip passes one of its foot-plant moments. */
  private detectFootsteps(state: AnimationState): void {
    const clip = this.currentLocomotion;
    const walking = (clip === 'WALK' || clip === 'RUN') && !this.oneShot && !this.isRiding &&
      state.isGrounded && !state.isSwimming && !state.isClimbing;
    const action = walking ? this.actions.get(clip!) : undefined;
    if (!action || !this.onFootstep) {
      this.gaitClip = null;
      return;
    }
    // Fire slightly ahead of the visual contact to cover audio output latency and the sound's own
    // attack, so the step is heard when the foot lands, not after it
    const d0 = action.getClip().duration;
    const t = (action.time + 0.06 * action.timeScale + d0) % d0;
    if (this.gaitClip === clip) {
      const prev = this.gaitTime;
      const d = action.getClip().duration;
      const plants = this.footPlants.get(clip!) ?? [0, d / 2];
      {
        for (const p of plants) {
          const crossed = prev <= t ? p > prev && p <= t : p > prev || p <= t; // the clip looped
          if (crossed) this.onFootstep(state.isCrouching ? 0.35 : clip === 'RUN' ? 1 : 0.6);
        }
      }
    }
    this.gaitClip = clip;
    this.gaitTime = t;
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
  /** Bones' mixer pose before the riding offset was layered on (restored before the next mixer update). */
  private readonly ridingBase = new Map<THREE.Object3D, THREE.Quaternion>();

  private readonly ridingBaseCache = new Map<THREE.Object3D, THREE.Quaternion>();
  private newBase(bone: THREE.Object3D): THREE.Quaternion {
    const q = new THREE.Quaternion();
    this.ridingBaseCache.set(bone, q);
    return q;
  }

  private restoreRidingPose(): void {
    for (const [bone, q] of this.ridingBase) bone.quaternion.copy(q);
    this.ridingBase.clear();
  }

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
      this.ridingBase.set(bone, (this.ridingBaseCache.get(bone) ?? this.newBase(bone)).copy(bone.quaternion));
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

