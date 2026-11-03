import * as THREE from 'three';

/**
 * Tunables for the generated run cycle. Angles in degrees; lengths are fractions of the leg length
 * (hip to sole) so the cycle fits the rig whatever its scale.
 *
 * The rig's legs are thick rigid blocks without knees. They only ever rotate about the hip and may be pulled
 * up into the torso (hidden there) — never slid forward/back or down, so they stay visually attached.
 * Stride length comes from a flight phase between steps. During stance the lowest point of the leg mesh
 * (heel or toe edge, found from its vertices) stays on the ground and moves back at a constant speed,
 * which lets CharacterModel sync playback to movement speed without foot sliding.
 */
export const RUN_CYCLE = {
  DURATION: 0.46, // seconds per full cycle (two steps)
  STANCE_FRACTION: 0.27, // part of the cycle each foot is on the ground; the rest of a step is flight
  FOOT_REACH: 0.45, // contact point travel in front of / behind the hip during stance, x leg length
  FLIGHT_HEIGHT: 0.14, // extra hip rise at the top of the flight arc, x leg length
  FOOT_LIFT: 0.26, // swing leg pulled up into the torso at mid-swing, x leg length
  SWING_CLEARANCE: 0.06, // the swinging foot never comes closer to the ground than this, x leg length
  ARM_LOWER: 76, // from the T-pose rest down towards the body
  ARM_SWING: 58, // forward/back arm pump, opposite to the same-side leg
  ARM_FORWARD_BIAS: 12, // arms carried slightly in front, like a runner
  BODY_LEAN: 11, // forward lean of the torso
  BODY_TWIST: 6, // shoulders counter-rotate against the hips
  HEAD_COUNTER_LEAN: 6, // keeps the eyes a bit more level than the torso
} as const;

const BONES = {
  body: 'body',
  head: 'head_1',
  legL: 'leg_1_left',
  legR: 'leg_1_right',
  armL: 'arm_1_left',
  armR: 'arm_1_right',
};
type BoneKey = keyof typeof BONES;
type LegKey = 'legL' | 'legR';

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const deg = THREE.MathUtils.degToRad;

/**
 * Builds a looping 'RUN' clip for the 6-bone Roblox rig. `root` must be in its rest pose
 * (a fresh clone, before any mixer touched it). Model space: +Z forward, +Y up, left arm on -X.
 * Also returns the movement speed at which the clip plays without foot sliding at 1x.
 */
export function buildRunClip(root: THREE.Object3D, name = 'RUN'): { clip: THREE.AnimationClip; groundSpeed: number } | null {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const rootQuatInv = root.getWorldQuaternion(new THREE.Quaternion()).invert();
  const rootScale = root.getWorldScale(new THREE.Vector3()).x;
  const inRoot = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoot);

  const rig = {} as Record<BoneKey, { bone: THREE.Object3D; restQuat: THREE.Quaternion; restPos: THREE.Vector3; parentQuat: THREE.Quaternion; parentScale: number }>;
  for (const [key, boneName] of Object.entries(BONES) as [BoneKey, string][]) {
    const bone = root.getObjectByName(boneName);
    if (!bone || !bone.parent) return null;
    rig[key] = {
      bone,
      restQuat: bone.quaternion.clone(),
      restPos: bone.position.clone(),
      parentQuat: rootQuatInv.clone().multiply(bone.parent.getWorldQuaternion(new THREE.Quaternion())),
      parentScale: bone.parent.getWorldScale(new THREE.Vector3()).x / rootScale,
    };
  }

  // Leg mesh vertices relative to the hip pivot (root space, rest pose)
  let legMesh: THREE.Mesh | null = null;
  rig.legL.bone.traverse((o) => {
    if (!legMesh && (o as THREE.Mesh).isMesh) legMesh = o as THREE.Mesh;
  });
  if (!legMesh) return null;
  const hipRest = { legL: inRoot(rig.legL.bone), legR: inRoot(rig.legR.bone) };
  const legVerts: THREE.Vector3[] = [];
  const attr = (legMesh as THREE.Mesh).geometry.attributes.position;
  for (let i = 0; i < attr.count; i++) {
    legVerts.push(new THREE.Vector3().fromBufferAttribute(attr, i).applyMatrix4((legMesh as THREE.Mesh).matrixWorld).applyMatrix4(toRoot).sub(hipRest.legL));
  }

  /** Lowest point of the leg when tilted by `angle` degrees about +X (negative = foot forward), relative to the hip. */
  const contact = (angle: number) => {
    const q = new THREE.Quaternion().setFromAxisAngle(X, deg(angle));
    const pts = legVerts.map((v) => v.clone().applyQuaternion(q));
    const minY = Math.min(...pts.map((p) => p.y));
    const bottom = pts.filter((p) => p.y < minY + 1e-4);
    return { y: minY, z: bottom.reduce((sum, p) => sum + p.z, 0) / bottom.length };
  };
  const rest = contact(0);
  const legLength = -rest.y;
  const c = RUN_CYCLE;
  const reach = c.FOOT_REACH * legLength;

  /** Tilt that puts the contact point `dz` in front of the hip (bisection; contact z grows as the angle drops). */
  const tiltFor = (dz: number) => {
    let lo = -75;
    let hi = 75;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (contact(mid).z > dz) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  /** Local quaternion that applies `modelRot` (model space, pivoting at the bone) on top of the rest pose. */
  const localRotation = (key: BoneKey, modelRot: THREE.Quaternion) => {
    const b = rig[key];
    return b.parentQuat.clone().invert().multiply(modelRot).multiply(b.parentQuat).multiply(b.restQuat);
  };
  /** Local position offset by a delta expressed in the parent's rest frame (model axes). */
  const localPosition = (key: BoneKey, delta: THREE.Vector3) => {
    const b = rig[key];
    return b.restPos.clone().add(delta.clone().applyQuaternion(b.parentQuat.clone().invert()).divideScalar(b.parentScale));
  };
  const rot = (axis: THREE.Vector3, degrees: number) => new THREE.Quaternion().setFromAxisAngle(axis, deg(degrees));

  const bodyPivot = inRoot(rig.body.bone);
  /** Hip position after the torso rotation (before any hip lift). */
  const hipAfter = (leg: LegKey, bodyRot: THREE.Quaternion) =>
    hipRest[leg].clone().sub(bodyPivot).applyQuaternion(bodyRot).add(bodyPivot);
  // Contact target line: centred under the leaned hip, so the reach is symmetric
  const restBodyRot = rot(X, c.BODY_LEAN);
  const contactCenterZ = { legL: hipAfter('legL', restBodyRot).z + rest.z, legR: hipAfter('legR', restBodyRot).z + rest.z };
  const groundY = hipRest.legL.y + rest.y;

  /** Leg state at phase t: stance moves the contact back linearly (u: +1 -> -1), swing brings it forward. */
  const legPhase = (t: number) => {
    const sf = c.STANCE_FRACTION;
    if (t < sf) return { stance: true, u: 1 - (2 * t) / sf, lift: 0 };
    const tau = (t - sf) / (1 - sf);
    return { stance: false, u: -Math.cos(Math.PI * tau), lift: Math.sin(Math.PI * tau) };
  };
  // The flat sole rolls heel -> toe: tilted forward it stands on the heel edge, tilted back on the toe edge,
  // and at the flip the contact jumps a whole foot depth forward. So the planted point follows two segments,
  // both moving back at the same speed: heel from +reach to the heel edge, then toe from the toe edge to -reach.
  const heelEdge = contact(-0.5).z - rest.z;
  const toeEdge = contact(0.5).z - rest.z;
  const heelRun = reach - heelEdge;
  const toeRun = toeEdge + reach;
  /** Contact offset in front of the hip line for progress u (+1 = foot forward, -1 = foot back). */
  const contactOffset = (u: number) => {
    const s = ((1 - u) / 2) * (heelRun + toeRun);
    return s <= heelRun ? reach - s : toeEdge - (s - heelRun);
  };

  /** Tilt of a leg for progress u, and the hip lift that would put its contact point on the ground. */
  const legSolve = (leg: LegKey, u: number, bodyRot: THREE.Quaternion) => {
    const hip = hipAfter(leg, bodyRot);
    const angle = tiltFor(contactCenterZ[leg] + contactOffset(u) - hip.z);
    return { angle, groundLift: groundY - (hip.y + contact(angle).y) };
  };

  // Dense keys: the stance is short and the rigid-leg contact solution is non-linear between keys
  const steps = 160;
  const times: number[] = [];
  const quats: Partial<Record<BoneKey, number[]>> = {};
  const offsets: Partial<Record<BoneKey, number[]>> = {};
  const pushQ = (key: BoneKey, q: THREE.Quaternion) => (quats[key] ??= []).push(q.x, q.y, q.z, q.w);
  const pushP = (key: BoneKey, p: THREE.Vector3) => (offsets[key] ??= []).push(p.x, p.y, p.z);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    times.push(t * c.DURATION);
    const phases = { legL: legPhase(t % 1), legR: legPhase((t + 0.5) % 1) };

    // Torso: lean forward, shoulders counter-rotate (left foot leads at t = 0)
    const twist = c.BODY_TWIST * Math.cos(2 * Math.PI * t);
    const bodyRot = rot(Y, twist).multiply(rot(X, c.BODY_LEAN));
    const bodyRotInv = bodyRot.clone().invert();
    const solved = {
      legL: legSolve('legL', phases.legL.u, bodyRot),
      legR: legSolve('legR', phases.legR.u, bodyRot),
    };

    // Hip height: follow the stance leg; in flight arc from where the last stance ended to where the next begins
    let bodyLift: number;
    const stanceLeg = (['legL', 'legR'] as const).find((leg) => phases[leg].stance);
    if (stanceLeg) {
      bodyLift = solved[stanceLeg].groundLift;
    } else {
      const sf = c.STANCE_FRACTION;
      const half = (t % 1) < 0.5;
      const [from, to] = half ? (['legL', 'legR'] as const) : (['legR', 'legL'] as const);
      const flightT = ((t % 0.5) - sf) / (0.5 - sf);
      const startLift = legSolve(from, -1, bodyRot).groundLift;
      const endLift = legSolve(to, 1, bodyRot).groundLift;
      bodyLift = THREE.MathUtils.lerp(startLift, endLift, flightT) + c.FLIGHT_HEIGHT * legLength * Math.sin(Math.PI * flightT);
    }

    pushP('body', localPosition('body', new THREE.Vector3(0, bodyLift, 0)));
    pushQ('body', localRotation('body', bodyRot));
    pushQ('head', localRotation('head', rot(X, -c.HEAD_COUNTER_LEAN).multiply(rot(Y, -twist * 0.6))));

    // Legs only rotate about the hip (torso lean/twist cancelled) and get pulled up into the torso while swinging,
    // at least far enough that the swinging foot clears the ground
    for (const leg of ['legL', 'legR'] as const) {
      const { angle } = solved[leg];
      let lift = 0;
      if (!phases[leg].stance) {
        const footY = hipAfter(leg, bodyRot).y + bodyLift + contact(angle).y;
        // Clearance fades out at lift-off and touch-down so the foot meets the ground without a jump
        const needed = (groundY + c.SWING_CLEARANCE * legLength * phases[leg].lift - footY) / Math.cos(deg(c.BODY_LEAN));
        lift = Math.max(c.FOOT_LIFT * legLength * phases[leg].lift, needed, 0);
      }
      pushQ(leg, localRotation(leg, bodyRotInv.clone().multiply(rot(X, angle))));
      pushP(leg, localPosition(leg, new THREE.Vector3(0, lift, 0)));
    }

    // Arms: lower from the T-pose (left arm points to -X), then pump opposite to the same-side leg
    const armSwing = c.ARM_SWING * Math.cos(2 * Math.PI * t);
    pushQ('armL', localRotation('armL', rot(X, armSwing - c.ARM_FORWARD_BIAS).multiply(rot(Z, c.ARM_LOWER))));
    pushQ('armR', localRotation('armR', rot(X, -armSwing - c.ARM_FORWARD_BIAS).multiply(rot(Z, -c.ARM_LOWER))));
  }

  const tracks: THREE.KeyframeTrack[] = [];
  for (const [key, values] of Object.entries(quats) as [BoneKey, number[]][]) {
    tracks.push(new THREE.QuaternionKeyframeTrack(`${rig[key].bone.name}.quaternion`, times, values));
  }
  for (const [key, values] of Object.entries(offsets) as [BoneKey, number[]][]) {
    tracks.push(new THREE.VectorKeyframeTrack(`${rig[key].bone.name}.position`, times, values));
  }
  return {
    clip: new THREE.AnimationClip(name, c.DURATION, tracks),
    // Exact speed (game m/s at 1x) at which the planted foot moves back: its contact path over the stance time
    groundSpeed: ((heelRun + toeRun) / (c.DURATION * c.STANCE_FRACTION)) * rootScale,
  };
}
