import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { COLLISION_GROUPS } from '../config/constants';
import { riverWorld } from '../world/rivers/RiverWorld';
import type { CharacterModel } from './CharacterModel';

/*
 * The player's ragdoll: the blocky rig is six rigid parts (torso, head, two arms, two legs), so each
 * part becomes one Rapier body - a ball for the head, boxes for the rest - and the bones follow the
 * bodies exactly (no skinning to fake). Limbs hang on spherical joints at the shoulders, hips and
 * neck; Rapier's JS API has no angular limits for those, so a small swing-twist limiter keeps every
 * joint inside a human range (a knee-less leg swings far forward but barely back, an arm can't spin
 * round its own axis, the head nods but doesn't turn backwards) by correcting the bodies' relative
 * angular velocity before each step. Built only when the player faints and removed on respawn:
 * six bodies and five joints, asleep once they come to rest.
 */

type PartKind = 'torso' | 'head' | 'arm' | 'leg';

/** Joint range in degrees: flexion (limb tip forward +), abduction (tip away from the body +), twist. */
interface JointRange {
  flex: [number, number];
  abduct: [number, number];
  twist: [number, number];
}

const RANGES: Record<Exclude<PartKind, 'torso'>, JointRange> = {
  // No knee: the whole leg swings far forward (sitting, kicking) but only a little back
  leg: { flex: [-30, 100], abduct: [-12, 45], twist: [-30, 30] },
  // From hanging at the side: up over the head forwards and sideways, little behind or across
  arm: { flex: [-55, 170], abduct: [-15, 160], twist: [-70, 70] },
  head: { flex: [-45, 55], abduct: [-35, 35], twist: [-70, 70] },
};

/** Density (kg/m^3 of collider volume, scaled): the torso carries most of the weight. */
const DENSITY: Record<PartKind, number> = { torso: 1.0, head: 0.8, arm: 0.6, leg: 0.8 };
/** Colliders are a touch smaller than the meshes so neighbouring parts don't start inside each other. */
const SHRINK = 0.92;
/** Fraction of a limit violation removed per second (velocity bias). */
const LIMIT_BIAS = 12;
/** Spin (rad/s) the whole body starts with so it falls over instead of landing on its feet. */
const TOPPLE_SPIN = 2.4;
/** Degrees past a limit that are tolerated without pushing back. */
const LIMIT_DEADBAND = 1.5;
/** After this long (s) the body settles: damping rises so it comes to rest (and sleeps) sooner. */
const SETTLE_AFTER = 1.5;
const SETTLE_ANGULAR_DAMPING = 4;
/** Cap on the corrective angular speed (rad/s) so a large violation doesn't fling a limb. */
const MAX_CORRECTION = 14;
/** Degrees past a limit before the limb is snapped back onto it (below, only the velocity fix acts). */
const PROJECT_SLACK = 4;
/** Angular speed (rad/s) under which a limb counts as resting (no snapping onto the limit). */
const SETTLED_ANGVEL = 0.8;
/** Joint friction: relative spin between neighbouring parts decays at this rate (1/s). */
const JOINT_DAMPING = 2.5;
/** Water: upward force per submerged mass (in g) and the drag it adds. */
const BUOYANCY = 1.15;
const WATER_DRAG = 2.5;

interface Part {
  kind: PartKind;
  bone: THREE.Object3D;
  body: RAPIER.RigidBody;
  /** Body frame -> bone frame (constant, includes the model scale). */
  offset: THREE.Matrix4;
  /** Half the collider's height, for the water test. */
  halfHeight: number;
  mass: number;
  inWater: boolean;
  saved: { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 };
}

interface Joint {
  parent: Part;
  child: Part;
  range: JointRange;
  /** Neutral child orientation relative to the parent body. */
  restRel: THREE.Quaternion;
  /** Child-local axes: twist (along the limb), flex (sideways hinge), abduct (third). */
  twist: THREE.Vector3;
  flexAxis: THREE.Vector3;
  abductAxis: THREE.Vector3;
  flexSign: number;
  abductSign: number;
  /** The joint's pivot in each body's frame. */
  anchorP: THREE.Vector3;
  anchorC: THREE.Vector3;
}

const DEG = Math.PI / 180;
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _s = new THREE.Vector3();
const _wP = new THREE.Vector3();
const _wC = new THREE.Vector3();
const _n = new THREE.Vector3();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

function kindOf(name: string): PartKind {
  if (name === 'body') return 'torso';
  if (name.startsWith('head')) return 'head';
  if (name.startsWith('arm')) return 'arm';
  return 'leg';
}

export class Ragdoll {
  private parts: Part[] = [];
  private joints: Joint[] = [];
  /** Set to {} to read each joint's [flex, abduct, twist] in degrees (console tuning). */
  public debug: Record<string, number[]> | null = null;
  private age = 0;
  private readonly tipDir = new THREE.Vector3();

  constructor(private readonly physics: PhysicsWorld) {}

  public get active(): boolean {
    return this.parts.length > 0;
  }

  /**
   * Swaps the animated model for physics bodies in its current pose, all moving at `velocity`
   * (plus a little spin so a standing body topples). False if the model isn't loaded yet.
   */
  public start(model: CharacterModel, velocity: THREE.Vector3): boolean {
    if (this.active || !this.physics.isInitialized()) return false;
    this.age = 0;
    const src = model.bodyParts();
    const torsoSrc = src?.find((p) => p.bone.name === 'body');
    if (!src || !torsoSrc || !torsoSrc.bone.parent) return false;
    const R = this.physics.rapier;
    const world = this.physics.world;
    model.group.updateMatrixWorld(true);
    const groups = this.physics.packCollisionGroups(
      // Membership "character": everything the player stands on collides with the parts too.
      // The filter leaves out the parts themselves (the joint limits keep limbs out of the torso)
      COLLISION_GROUPS.CHARACTER,
      COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.DYNAMIC_PROPS
    );

    for (const s of src) {
      const kind = kindOf(s.bone.name);
      const boneWorld = s.bone.matrixWorld;
      const scale = _s.setFromMatrixScale(boneWorld);
      const center = _v.copy(s.min).add(s.max).multiplyScalar(0.5).applyMatrix4(boneWorld);
      const rot = s.bone.getWorldQuaternion(new THREE.Quaternion());
      const half = _v2.copy(s.max).sub(s.min).multiplyScalar(0.5).multiply(scale).multiplyScalar(SHRINK);
      const bodyDesc = R.RigidBodyDesc.dynamic()
        .setTranslation(center.x, center.y, center.z)
        .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
        .setLinvel(velocity.x, velocity.y, velocity.z)
        .setLinearDamping(0.12)
        .setAngularDamping(0.8)
        .setCcdEnabled(true);
      const body = world.createRigidBody(bodyDesc);
      const collider = (kind === 'head'
        ? R.ColliderDesc.ball((half.x + half.y + half.z) / 3)
        : R.ColliderDesc.cuboid(half.x, half.y, half.z))
        .setDensity(DENSITY[kind])
        .setFriction(0.85)
        .setRestitution(0.05)
        .setCollisionGroups(groups);
      world.createCollider(collider, body);
      const offset = new THREE.Matrix4().compose(center, rot, _v3.set(1, 1, 1)).invert().multiply(boneWorld);
      this.parts.push({
        kind,
        bone: s.bone,
        body,
        offset,
        halfHeight: Math.max(half.x, half.y, half.z),
        mass: body.mass(),
        inWater: false,
        saved: { p: s.bone.position.clone(), q: s.bone.quaternion.clone(), s: s.bone.scale.clone() },
      });
    }
    const torso = this.parts.find((p) => p.kind === 'torso')!;

    // Neutral pose in the character's own frame (+Z forward, +X sideways): the rig's rest pose is a
    // T-pose, so the arms' neutral is hanging down; legs and head stand as in the rest pose
    const groupInv = model.group.getWorldQuaternion(new THREE.Quaternion()).invert();
    const rigParentQ = model.rigRestParentQuaternion(new THREE.Quaternion());
    const restQ = (name: string, out: THREE.Quaternion) =>
      out.copy(groupInv).multiply(rigParentQ).multiply(model.partRest(name)!.q);
    const restPos = (name: string, out: THREE.Vector3) => out.copy(model.partRest(name)!.p).applyQuaternion(rigParentQ).applyQuaternion(groupInv);
    const torsoRestQ = restQ('body', new THREE.Quaternion());
    const torsoRestPos = restPos('body', new THREE.Vector3());

    for (const child of this.parts) {
      if (child === torso || !model.partRest(child.bone.name)) continue;
      const kind = child.kind as Exclude<PartKind, 'torso'>;
      const s = src.find((p) => p.bone.name === child.bone.name)!;
      // Twist axis: from the pivot (bone origin) to the middle of the part, in the bone's frame
      const twist = s.min.clone().add(s.max).multiplyScalar(0.5).normalize();
      const childRestQ = restQ(child.bone.name, new THREE.Quaternion());
      const restTip = twist.clone().applyQuaternion(childRestQ);
      const outward = restPos(child.bone.name, new THREE.Vector3()).sub(torsoRestPos);
      const out = new THREE.Vector3(Math.sign(outward.x) || 1, 0, 0);
      const neutralTip = kind === 'arm' ? new THREE.Vector3(out.x * 0.3, -1, 0.05).normalize() : restTip.clone();
      const neutralQ = new THREE.Quaternion().setFromUnitVectors(restTip, neutralTip).multiply(childRestQ);
      const restRel = torsoRestQ.clone().invert().multiply(neutralQ);

      const invN = neutralQ.clone().invert();
      const flexAxis = X.clone().applyQuaternion(invN);
      flexAxis.addScaledVector(twist, -flexAxis.dot(twist)).normalize();
      const abductAxis = new THREE.Vector3().crossVectors(twist, flexAxis).normalize();
      // Which way round each axis moves the tip forward / outward (in the character's frame)
      const flexG = flexAxis.clone().applyQuaternion(neutralQ);
      const abdG = abductAxis.clone().applyQuaternion(neutralQ);
      const flexSign = Math.sign(_v.crossVectors(flexG, neutralTip).dot(Z)) || 1;
      const abductSign = kind === 'head' ? 1 : Math.sign(_v.crossVectors(abdG, neutralTip).dot(out)) || 1;

      // Spherical joint at the pivot (shoulder, hip, neck), from the current pose
      const pivot = child.bone.getWorldPosition(new THREE.Vector3());
      const a1 = this.toLocal(torso.body, pivot, new THREE.Vector3());
      const a2 = this.toLocal(child.body, pivot, new THREE.Vector3());
      this.joints.push({
        parent: torso, child, range: RANGES[kind], restRel, twist, flexAxis, abductAxis, flexSign, abductSign, anchorP: a1, anchorC: a2,
      });
      const j = world.createImpulseJoint(R.JointData.spherical(a1, a2), torso.body, child.body, true);
      j.setContactsEnabled(false);
    }

    // Topple: limbs on spherical joints (and no knees) can land and stay standing, so the whole body
    // starts turning over as one piece about a horizontal axis, the way it was moving or backwards
    const facing = _v.set(0, 0, 1).applyQuaternion(model.group.getWorldQuaternion(_q));
    this.tipDir.set(velocity.x, 0, velocity.z);
    if (this.tipDir.lengthSq() < 0.25) this.tipDir.copy(facing).multiplyScalar(-1);
    this.tipDir.normalize();
    const spin = _v2.crossVectors(Y, this.tipDir).multiplyScalar(TOPPLE_SPIN);
    spin.y = (Math.random() - 0.5) * 0.6;
    const tc = torso.body.translation();
    for (const p of this.parts) {
      const t = p.body.translation();
      // Rigid rotation: v = v0 + w x r
      const lin = _v3.set(t.x - tc.x, t.y - tc.y, t.z - tc.z).cross(spin).negate().add(velocity);
      p.body.setLinvel({ x: lin.x, y: lin.y, z: lin.z }, true);
      p.body.setAngvel({ x: spin.x, y: spin.y, z: spin.z }, true);
    }
    return true;
  }

  /** Torso centre (where the camera should look). */
  public torsoPosition(out: THREE.Vector3): THREE.Vector3 {
    const t = this.parts.find((p) => p.kind === 'torso')?.body.translation();
    return t ? out.set(t.x, t.y, t.z) : out;
  }

  /** Joint limits, water, then the bones copy the bodies. Call once a frame after the physics step. */
  public update(dt: number): void {
    if (!this.active) return;
    const before = this.age;
    this.age += dt;
    if (before < SETTLE_AFTER && this.age >= SETTLE_AFTER) {
      for (const p of this.parts) {
        p.body.setAngularDamping(SETTLE_ANGULAR_DAMPING);
        p.body.setLinearDamping(0.6);
      }
    }
    if (dt > 0) {
      this.noStanding(dt);
      for (let it = 0; it < 2; it++) for (const j of this.joints) this.limit(j, dt);
      this.water();
    }
    this.syncBones();
  }

  /**
   * A fainted body doesn't stay on its feet: while the torso is still upright after the first
   * moments, it is tipped over (harder the longer it stands) in the topple direction.
   */
  private noStanding(dt: number): void {
    if (this.age < 0.35 || this.age > 6) return;
    const torso = this.parts[0];
    if (torso.body.isSleeping() && this.age > 3) return;
    const r = torso.body.rotation();
    const up = _v.set(0, 1, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
    if (up.y < 0.75) return;
    // Lean further the way it already leans, else the topple direction
    const lean = _v2.set(up.x, 0, up.z);
    if (lean.lengthSq() > 0.01) lean.normalize();
    else lean.copy(this.tipDir);
    const axis = _v3.crossVectors(Y, lean);
    // Angular acceleration about the tipping axis (~7 rad/s^2), the legs follow through the hips
    const dw = TOPPLE_SPIN * 3 * dt;
    const w = torso.body.angvel();
    torso.body.setAngvel({ x: w.x + axis.x * dw, y: w.y, z: w.z + axis.z * dw }, true);
  }

  /** Removes the bodies and gives the bones back to the animation. */
  public stop(): void {
    if (!this.active) return;
    const world = this.physics.world;
    for (const p of this.parts) {
      try {
        world.removeRigidBody(p.body); // also drops its collider and joints
      } catch {
        // already gone with the world
      }
      p.bone.position.copy(p.saved.p);
      p.bone.quaternion.copy(p.saved.q);
      p.bone.scale.copy(p.saved.s);
    }
    this.parts = [];
    this.joints = [];
  }

  private toLocal(body: RAPIER.RigidBody, world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const t = body.translation();
    const r = body.rotation();
    return out.copy(world).sub(_n.set(t.x, t.y, t.z)).applyQuaternion(_q3.set(r.x, r.y, r.z, r.w).invert());
  }

  /** Velocity-level swing-twist limit for one joint. */
  private limit(j: Joint, dt: number): void {
    const P = j.parent.body;
    const C = j.child.body;
    if (P.isSleeping() && C.isSleeping()) return;
    const rp = P.rotation();
    const rc = C.rotation();
    const qP = _q.set(rp.x, rp.y, rp.z, rp.w);
    const qC = _q2.set(rc.x, rc.y, rc.z, rc.w);
    // Deviation from neutral, in the child's frame: child = parent * restRel * d
    const d = _q3.copy(qP).invert().multiply(qC).premultiply(_m2Quat.copy(j.restRel).invert());
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    // Twist about the limb's axis, the rest is swing
    const proj = d.x * j.twist.x + d.y * j.twist.y + d.z * j.twist.z;
    const twistAngle = 2 * Math.atan2(proj, d.w);
    const tw = _twQ.set(j.twist.x * proj, j.twist.y * proj, j.twist.z * proj, d.w);
    if (tw.lengthSq() < 1e-12) tw.identity();
    else tw.normalize();
    const sw = d.multiply(tw.invert());
    if (sw.w < 0) sw.set(-sw.x, -sw.y, -sw.z, -sw.w);
    const sinHalf = Math.sqrt(sw.x * sw.x + sw.y * sw.y + sw.z * sw.z);
    const swingAngle = 2 * Math.atan2(sinHalf, sw.w);
    const k = sinHalf > 1e-6 ? swingAngle / sinHalf : 2;
    _v.set(sw.x * k, sw.y * k, sw.z * k); // swing rotation vector (child frame)
    const flex = _v.dot(j.flexAxis) * j.flexSign;
    const abduct = _v.dot(j.abductAxis) * j.abductSign;

    const r = j.range;
    const eFlex = clampErr(flex, r.flex[0] * DEG, r.flex[1] * DEG);
    const eAbd = clampErr(abduct, r.abduct[0] * DEG, r.abduct[1] * DEG);
    const eTw = clampErr(twistAngle, r.twist[0] * DEG, r.twist[1] * DEG);

    const av = P.angvel();
    const cv = C.angvel();
    _wP.set(av.x, av.y, av.z);
    _wC.set(cv.x, cv.y, cv.z);
    const mP = j.parent.mass, mC = j.child.mass;
    const wc = mP / (mP + mC), wp = mC / (mP + mC);
    let changed = false;
    let corrected = false;
    // Swing is measured in the joint's neutral frame (parent * restRel), twist about the limb itself
    const qN = _qN.copy(qP).multiply(j.restRel);
    const solve = (axisLocal: THREE.Vector3, err: number, frame: THREE.Quaternion) => {
      if (err === 0) return;
      // Axis to world; the error's sign is relative to that axis
      _n.copy(axisLocal).applyQuaternion(frame);
      const rel = _v2.subVectors(_wC, _wP).dot(_n);
      // Just past the limit only stop it going further (no push back): a limb resting on its limit
      // under gravity then lies still instead of buzzing between the two
      const over = Math.abs(err) - LIMIT_DEADBAND * DEG;
      const target = over > 0 ? THREE.MathUtils.clamp(Math.sign(err) * over * LIMIT_BIAS, -MAX_CORRECTION, MAX_CORRECTION) : 0;
      // Only push back towards the range (never hold the limb against it)
      if ((err > 0 && rel >= target) || (err < 0 && rel <= target)) return;
      const delta = target - rel;
      _wC.addScaledVector(_n, delta * wc);
      _wP.addScaledVector(_n, -delta * wp);
      changed = corrected = true;
    };
    solve(j.flexAxis, eFlex * j.flexSign, qN);
    solve(j.abductAxis, eAbd * j.abductSign, qN);
    solve(j.twist, eTw, qC);
    if (this.debug) this.debug[j.child.bone.name] = [flex / DEG, abduct / DEG, twistAngle / DEG].map((v) => Math.round(v));

    // Joint friction: muscles and ligaments damp the swinging
    const damp = Math.min(1, JOINT_DAMPING * dt);
    _v3.subVectors(_wC, _wP).multiplyScalar(damp);
    // (only while it visibly swings, so the bodies can still fall asleep)
    if (_v3.lengthSq() > 1e-4 * damp * damp) {
      _wC.addScaledVector(_v3, -wc);
      _wP.addScaledVector(_v3, wp);
      changed = true;
    }
    if (changed) {
      C.setAngvel({ x: _wC.x, y: _wC.y, z: _wC.z }, corrected);
      P.setAngvel({ x: _wP.x, y: _wP.y, z: _wP.z }, corrected);
    }

    // Hard stop: a blow (or the landing) can carry a limb past the range faster than the velocity
    // fix catches it, so beyond PROJECT_SLACK the child is turned back onto the limit about the pivot
    // (only for a limb on the move: one lying on its limit under its own weight is left to the
    // velocity fix, else each snap and the ground's push back keep it from ever coming to rest)
    const slack = PROJECT_SLACK * DEG;
    const lv = C.linvel();
    const moving = _wC.lengthSq() > SETTLED_ANGVEL * SETTLED_ANGVEL || lv.x * lv.x + lv.y * lv.y + lv.z * lv.z > 0.09;
    if (moving && (Math.abs(eFlex) > slack || Math.abs(eAbd) > slack || Math.abs(eTw) > slack)) {
      const f = (flex + eFlex) * j.flexSign;
      const a = (abduct + eAbd) * j.abductSign;
      const swingVec = _v.copy(j.flexAxis).multiplyScalar(f).addScaledVector(j.abductAxis, a);
      const ang = swingVec.length();
      const swing = ang > 1e-8 ? _swQ.setFromAxisAngle(swingVec.divideScalar(ang), ang) : _swQ.identity();
      const twistQ = _twQ.setFromAxisAngle(j.twist, twistAngle + eTw);
      // child = parent * restRel * swing * twist
      const qNew = qN.multiply(swing).multiply(twistQ);
      const t = P.translation();
      const pivot = _v2.copy(j.anchorP).applyQuaternion(qP).add(_v3.set(t.x, t.y, t.z));
      const pos = pivot.sub(_v3.copy(j.anchorC).applyQuaternion(qNew));
      C.setRotation({ x: qNew.x, y: qNew.y, z: qNew.z, w: qNew.w }, true);
      C.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    }
  }

  /** Parts in water float and slow down (a fainted swimmer doesn't sink like a stone). */
  private water(): void {
    const g = Math.abs(this.physics.getGravity());
    for (const p of this.parts) {
      const t = p.body.translation();
      const cave = riverWorld.caveLevelAt(t.x, t.y, t.z);
      const level = Number.isNaN(cave) ? riverWorld.waterLevelAt(t.x, t.z) : cave;
      const depth = level - (t.y - p.halfHeight);
      if (depth <= 0) {
        if (p.inWater) p.body.resetForces(false);
        p.inWater = false;
        continue;
      }
      p.inWater = true;
      const sub = Math.min(1, depth / (2 * p.halfHeight));
      p.body.resetForces(false);
      p.body.addForce({ x: 0, y: p.mass * g * BUOYANCY * sub, z: 0 }, true);
      const lv = p.body.linvel();
      const drag = -WATER_DRAG * sub * p.mass;
      p.body.addForce({ x: lv.x * drag, y: lv.y * drag, z: lv.z * drag }, true);
    }
  }

  /** Bone world = body * offset; written as local transforms, parents (torso) first. */
  private syncBones(): void {
    for (const p of this.parts) {
      const parent = p.bone.parent;
      if (!parent) continue;
      if (p.kind === 'torso') parent.updateWorldMatrix(true, false);
      const t = p.body.translation();
      const r = p.body.rotation();
      _m.compose(_v.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _v2.set(1, 1, 1)).multiply(p.offset);
      _m2.copy(parent.matrixWorld).invert().multiply(_m);
      _m2.decompose(p.bone.position, p.bone.quaternion, p.bone.scale);
      p.bone.updateMatrix();
      p.bone.matrixWorld.multiplyMatrices(parent.matrixWorld, p.bone.matrix);
    }
  }
}

const _m2Quat = new THREE.Quaternion();
const _twQ = new THREE.Quaternion();
const _qN = new THREE.Quaternion();
const _swQ = new THREE.Quaternion();

/** How far (rad) `v` must move to get back inside [lo, hi]: 0 inside, + below, - above. */
function clampErr(v: number, lo: number, hi: number): number {
  return v < lo ? lo - v : v > hi ? hi - v : 0;
}
