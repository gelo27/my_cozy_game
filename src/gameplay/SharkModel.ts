import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

const SHARK_URL = `${import.meta.env.BASE_URL}models/shark.glb`;

/** The model is ~3.5 m nose to tail; drawn larger to match the shark's reach and wake. */
export const SHARK_MODEL_SCALE = 1.3;

/** Painted with vertex colours: one Lambert material for every shark. */
const SHARK_MAT = new THREE.MeshLambertMaterial({ vertexColors: true });

interface SharkAsset {
  scene: THREE.Object3D;
  clips: Record<string, THREE.AnimationClip>;
  /** Height of the dorsal fin's tip over the body's centre (m, at game scale). */
  finTop: number;
}

let asset: SharkAsset | null = null;
let loading: Promise<SharkAsset | null> | null = null;

export function getSharkAsset(): SharkAsset | null {
  return asset;
}

/** Loads the rigged shark once; resolves to null (and the sharks keep their built-in body) on failure. */
export function loadSharkModel(): Promise<SharkAsset | null> {
  if (loading) return loading;
  loading = new GLTFLoader()
    .loadAsync(SHARK_URL)
    .then((gltf) => {
      gltf.scene.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (!m.isMesh) return;
        m.material = SHARK_MAT;
        // Bones swing the tail well past the rest pose's bounds; there are only a few sharks
        m.frustumCulled = false;
        m.userData.shared = true; // clones share the geometry: Pest.dispose must leave it
      });
      const clips: Record<string, THREE.AnimationClip> = {};
      for (const c of gltf.animations) clips[c.name] = c;
      // Poses and one-shots play on top of the swim stroke: deltas from their first frame (the rest pose)
      for (const name of ['TurnLeft', 'TurnRight', 'JawOpen', 'Bite', 'Hurt']) {
        if (clips[name]) clips[name] = THREE.AnimationUtils.makeClipAdditive(clips[name].clone(), 0);
      }
      const box = new THREE.Box3().setFromObject(gltf.scene);
      asset = { scene: gltf.scene, clips, finTop: box.max.y * SHARK_MODEL_SCALE };
      return asset;
    })
    .catch((err) => {
      console.warn(`[Shark] ${SHARK_URL} failed to load, using the built-in body:`, err);
      return null;
    });
  return loading;
}

/**
 * One shark's skinned body and its animation mixer. The swim stroke (blended slow to fast by
 * speed) runs underneath; turn bends and the open jaw are additive poses weighted every frame;
 * bite and hurt are additive one-shots; death takes over the whole body.
 */
export class SharkRig {
  public readonly root: THREE.Object3D;
  public readonly finTop: number;
  private readonly mixer: THREE.AnimationMixer;
  private readonly swim: THREE.AnimationAction;
  private readonly fast: THREE.AnimationAction;
  private readonly turnL: THREE.AnimationAction | null;
  private readonly turnR: THREE.AnimationAction | null;
  private readonly jaw: THREE.AnimationAction | null;
  private readonly bite: THREE.AnimationAction | null;
  private readonly hurt: THREE.AnimationAction | null;
  private readonly death: THREE.AnimationAction | null;

  constructor(a: SharkAsset) {
    this.root = cloneSkeleton(a.scene);
    this.root.scale.setScalar(SHARK_MODEL_SCALE);
    this.finTop = a.finTop;
    this.mixer = new THREE.AnimationMixer(this.root);
    const c = a.clips;
    this.swim = this.mixer.clipAction(c.Swim);
    this.fast = this.mixer.clipAction(c.SwimFast ?? c.Swim);
    this.swim.play();
    this.fast.play().setEffectiveWeight(0);
    // A pose held at its last frame, faded in by weight
    const pose = (clip?: THREE.AnimationClip) => {
      if (!clip) return null;
      const act = this.mixer.clipAction(clip);
      act.play();
      act.time = clip.duration * 0.999;
      act.timeScale = 0;
      act.setEffectiveWeight(0);
      return act;
    };
    this.turnL = pose(c.TurnLeft);
    this.turnR = pose(c.TurnRight);
    this.jaw = pose(c.JawOpen);
    const once = (clip?: THREE.AnimationClip, clamp = false) => {
      if (!clip) return null;
      const act = this.mixer.clipAction(clip);
      act.setLoop(THREE.LoopOnce, 1);
      act.clampWhenFinished = clamp;
      return act;
    };
    this.bite = once(c.Bite);
    this.hurt = once(c.Hurt);
    this.death = once(c.Death, true);
  }

  /**
   * Swimming: `speed` in m/s, `turn` -1 (hard right) .. 1 (hard left), `jaw` 0 shut .. 1 open.
   */
  public update(dt: number, speed: number, turn: number, jaw: number): void {
    const fast = THREE.MathUtils.smoothstep(speed, 3, 8);
    this.swim.setEffectiveWeight(1 - fast);
    this.fast.setEffectiveWeight(fast);
    const rate = 0.7 + speed * 0.12;
    this.swim.timeScale = this.fast.timeScale = rate;
    this.turnL?.setEffectiveWeight(Math.max(0, turn));
    this.turnR?.setEffectiveWeight(Math.max(0, -turn));
    this.jaw?.setEffectiveWeight(jaw);
    this.mixer.update(dt);
  }

  /** Just the clips running (while dying). */
  public tick(dt: number): void {
    this.mixer.update(dt);
  }

  public playBite(): void {
    this.bite?.reset().play();
  }

  public playHurt(): void {
    this.hurt?.reset().play();
  }

  /** Rolls belly up; returns the clip's length (s). */
  public playDeath(): number {
    for (const act of [this.turnL, this.turnR, this.jaw, this.bite, this.hurt]) act?.stop();
    if (!this.death) return 0;
    this.death.reset().play();
    this.swim.crossFadeTo(this.death, 0.25, false);
    this.fast.fadeOut(0.25);
    return this.death.getClip().duration;
  }

  public dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }
}

loadSharkModel();
