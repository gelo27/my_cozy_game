import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { ParticleManager } from '../particles/ParticleManager';
import { audioEngine } from '../audio/AudioEngine';
import { GATHERING_CONFIG, ROCK_TYPES, RockKind, rollDrop } from './GatheringConfig';
import { buildChipGeometry, buildRockVariant, rockColors, ROCK_RADIUS, ROCK_VARIANTS, RockVariant } from '../world/RockModels';
import { isMobileDevice } from '../world/WorldSettings';
import { COLLISION_GROUPS } from '../config/constants';
import { injectNightLights } from '../world/NightLighting';
import { injectWaterline } from '../scene/WaterDetails';

export interface RockNode {
  id: number;
  kind: RockKind;
  position: THREE.Vector3;
  radius: number;
  maxHealth: number;
  health: number;
  /** Transform holder (not in the scene): its matrix is copied into the batch. */
  group: THREE.Object3D;
  /** This rock's instance in the shared batch, its shape and the LOD it is drawn at. */
  instanceId: number;
  variant: VariantEntry;
  level: number;
  baseScale: number;
  body: RAPIER.RigidBody | null;
  isDepleted: boolean;
  regrowAt: number;
  // Visual hit shake & regrow pop-in
  shake: number;
  growProgress: number;
}

/** A rock shape and its three LODs' geometry ids in the batch. */
interface VariantEntry {
  shape: RockVariant;
  ids: number[];
}

/** Camera distances (m) where a rock steps down to LOD1 and LOD2, and the hysteresis around them. */
const LOD_DISTS = isMobileDevice() ? [16, 40] : [22, 55];
const LOD_HYST = 3;
/** How often (s) rocks re-pick their LOD, and how far (m) the camera must move for it. */
const LOD_PASS_SECONDS = 0.2;
const LOD_PASS_MOVE = 1;

/** Flying stone chips: at most this many at once (the oldest goes first), how long they lie, how fast they vanish (s). */
const CHIP_MAX = isMobileDevice() ? 32 : 64;
const CHIP_LIFE_HIT = 2.2;
const CHIP_LIFE_BREAK = 3.6;
const CHIP_SHRINK = 0.5;

/** A stone chip knocked off by the pickaxe: a small Rapier body touching only the ground and walls. */
interface Chip {
  body: RAPIER.RigidBody;
  size: THREE.Vector3;
  color: THREE.Color;
  age: number;
  life: number;
  /** Last pose read from the body (kept while it sleeps: no Rapier calls, no garbage). */
  pos: THREE.Vector3;
  rot: THREE.Quaternion;
}

/** Stable 0..1 from a position (the same rock gets the same shape, turn and tint every load). */
function hash2(x: number, z: number, salt: number): number {
  const h = Math.sin(Math.round(x * 4) * 127.1 + Math.round(z * 4) * 311.7 + salt * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Mineable boulders (stone) and ore rocks (iron + stone).
 * Each pickaxe hit chips the rock smaller; the last hit breaks it and drops resources.
 * Broken rocks grow back after ROCK_REGROW_SECONDS.
 *
 * Rendering: a few procedural shapes per kind (RockModels: chunky faceted blocks, 3 LODs each)
 * live in ONE BatchedMesh; every rock is an instance of one shape (turned and tinted per rock) at
 * the LOD its camera distance asks for: a single draw call for all of them, with per-rock frustum
 * culling. The ore's glow is a vertex attribute.
 */
export class RockField {
  public group: THREE.Group;
  /** Called with the dropped items when a rock breaks. */
  public onMined: ((drops: { itemId: string; amount: number }[], at: THREE.Vector3) => void) | null = null;

  private rocks: RockNode[] = [];
  private nextId = 0;
  private batch: THREE.BatchedMesh;
  private vertexCapacity = 0;
  private verticesUsed = 0;
  private readonly variants = new Map<RockKind, VariantEntry[]>();
  private readonly eye = new THREE.Vector3(0, 1e6, 0);
  private readonly lastPassEye = new THREE.Vector3(0, 1e6, 0);
  private lodTimer = 0;
  private static readonly _tint = new THREE.Color();
  private readonly chips: Chip[] = [];
  private readonly chipMesh: THREE.InstancedMesh;
  /** Chip slots moved (spawn / removal): their colours are rewritten once. */
  private chipColorsDirty = false;
  private static readonly _m = new THREE.Matrix4();
  private static readonly _p = new THREE.Vector3();
  private static readonly _q = new THREE.Quaternion();
  private static readonly _s = new THREE.Vector3();

  constructor(
    private physics: PhysicsWorld,
    scene: THREE.Scene,
    private particleManager: ParticleManager | null,
    spots: { position: THREE.Vector3; kind: RockKind; scale: number }[]
  ) {
    this.group = new THREE.Group();
    this.group.name = 'RockField';
    scene.add(this.group);

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    mat.customProgramCacheKey = () => 'rock-batch';
    mat.onBeforeCompile = (shader) => {
      injectNightLights(shader);
      injectWaterline(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vGlow;');
    };
    const instances = Math.max(64, spots.length + 32);
    this.vertexCapacity = 40000;
    this.batch = new THREE.BatchedMesh(instances, this.vertexCapacity, 0, mat);
    this.batch.name = 'Rocks';
    // three r185 bug: WebGLRenderer.setProgram checks `object.colorTexture`, but BatchedMesh keeps it
    // in `_colorsTexture`. `undefined !== null` made it re-resolve the shader program (getParameters,
    // a fresh object of ~80 fields) on every draw: steady garbage for the GC. Alias the field.
    const batch = this.batch;
    Object.defineProperty(batch, 'colorTexture', {
      get: () => (batch as unknown as { _colorsTexture: THREE.DataTexture | null })._colorsTexture,
    });
    // Culled per rock inside the batch; its own bounds would need recomputing on every change
    this.batch.frustumCulled = false;
    this.group.add(this.batch);

    const chipMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    chipMat.customProgramCacheKey = () => 'rock-chips';
    chipMat.onBeforeCompile = (shader) => injectNightLights(shader);
    this.chipMesh = new THREE.InstancedMesh(buildChipGeometry(), chipMat, CHIP_MAX);
    this.chipMesh.name = 'RockChips';
    this.chipMesh.count = 0;
    this.chipMesh.frustumCulled = false;
    this.chipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chipMesh.setColorAt(0, RockField._tint.setRGB(1, 1, 1));
    this.group.add(this.chipMesh);

    spots.forEach((spot) => this.createRock(this.nextId++, spot.position, spot.kind, spot.scale));
    this.prebuildVariants();
  }

  /**
   * Builds the remaining kinds' shapes in idle time, one kind per idle slot, so the first ore of
   * a kind (entering a cave, say) doesn't build its hulls mid-play (a visible hitch on phones).
   */
  private prebuildVariants(): void {
    const pending = (Object.keys(ROCK_VARIANTS) as RockKind[]).filter((k) => !this.variants.has(k));
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const next = (): void => {
      const kind = pending.shift();
      if (!kind) return;
      this.variantsOf(kind);
      schedule();
    };
    const schedule = (): void => {
      if (!pending.length) return;
      if (idle) idle(next, { timeout: 4000 });
      else setTimeout(next, 200);
    };
    schedule();
  }

  /** Intact rocks (for baked ground shadows). */
  public forEachIntact(fn: (pos: THREE.Vector3, radius: number) => void): void {
    for (const r of this.rocks) if (!r.isDepleted) fn(r.position, r.radius);
  }

  /** Nearest intact rock whose surface is within `reach` of `point` (horizontal distance). */
  public findNearest(point: THREE.Vector3, reach: number): RockNode | null {
    let best: RockNode | null = null;
    let bestDist = Infinity;
    for (const rock of this.rocks) {
      if (rock.isDepleted || Math.abs(point.y - rock.position.y) > 3) continue;
      const dist = Math.hypot(point.x - rock.position.x, point.z - rock.position.z) - rock.radius;
      if (dist <= reach && dist < bestDist) {
        best = rock;
        bestDist = dist;
      }
    }
    return best;
  }

  /** Applies one pickaxe hit. Returns true when the rock broke. */
  public hit(rock: RockNode, strikeDirection: THREE.Vector3): boolean {
    if (rock.isDepleted) return false;
    rock.health -= 1;
    rock.shake = 1;

    const surface = rock.position
      .clone()
      .addScaledVector(strikeDirection.clone().setY(0).normalize(), -rock.radius * 0.8)
      .setY(rock.position.y + rock.radius * 0.6);
    // Chips burst off the struck face (on the rock's real outline, a little inside it), mostly up
    // and sideways so they don't fly into the player
    const away = RockField._p.copy(strikeDirection).setY(0).normalize().negate();
    const side = new THREE.Vector3(-away.z, 0, away.x);
    const colors = rockColors(rock.kind);
    const from = this.faceToward(rock, away);
    const n = colors.ore ? 6 : 5;
    for (let i = 0; i < n; i++) {
      const vel = away.clone().multiplyScalar(0.5 + Math.random() * 1.3)
        .addScaledVector(side, (Math.random() - 0.5) * 4.5)
        .setY(3.2 + Math.random() * 3.3);
      const ore = colors.ore && i < 2;
      this.spawnChip(from, vel, (0.1 + Math.random() * 0.08) * rock.baseScale, ore ? colors.ore! : colors.stone, CHIP_LIFE_HIT, true);
    }

    if (rock.health > 0) {
      audioEngine.at(surface).playMineHit(rock.kind === 'crystal');
      // Chip the rock smaller with every hit
      const remaining = rock.health / rock.maxHealth;
      rock.group.scale.setScalar(rock.baseScale * (0.7 + 0.3 * remaining));
      this.syncRock(rock);
      return false;
    }

    this.breakRock(rock);
    return true;
  }

  /** `eye`: the camera position (rocks pick their LOD from it). */
  public update(dt: number, eye?: THREE.Vector3): void {
    if (eye) this.updateLods(dt, eye);
    if (this.chips.length || this.chipMesh.count) this.updateChips(dt);
    const now = performance.now();
    for (const rock of this.rocks) {
      if (rock.isDepleted) {
        if (now >= rock.regrowAt) this.regrowRock(rock);
        continue;
      }

      if (rock.growProgress < 1) {
        rock.growProgress = Math.min(1, rock.growProgress + dt * 1.5);
        // Ease-out-back pop-in
        const t = rock.growProgress;
        const pop = 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
        rock.group.scale.setScalar(rock.baseScale * Math.max(0.01, pop));
        this.syncRock(rock);
      }

      if (rock.shake > 0) {
        rock.shake = Math.max(0, rock.shake - dt * 6);
        const s = rock.shake * 0.06;
        rock.group.position.set(
          rock.position.x + (Math.random() - 0.5) * s,
          rock.position.y,
          rock.position.z + (Math.random() - 0.5) * s
        );
        this.syncRock(rock);
      }
    }
  }

  /**
   * A point on the rock's face turned towards `dir` (horizontal, unit), at about half its height:
   * a ray against its own collider lands just outside the surface (a chip spawned inside the
   * collider would be shoved out with a jolt); without one, how far the coarse hull reaches.
   */
  private faceToward(rock: RockNode, dir: THREE.Vector3): THREE.Vector3 {
    const s = rock.group.scale.x;
    const h = rock.variant.shape.height * s;
    const y = rock.position.y + h * 0.45;
    const col = rock.body?.numColliders() ? rock.body.collider(0) : null;
    if (col) {
      const start = rock.radius * 1.5 + 0.5;
      const ray = new this.physics.rapier.Ray(
        { x: rock.position.x + dir.x * start, y, z: rock.position.z + dir.z * start },
        { x: -dir.x, y: 0, z: -dir.z }
      );
      const toi = col.castRay(ray, start, true);
      if (toi >= 0) return new THREE.Vector3(rock.position.x + dir.x * (start - toi + 0.06), y, rock.position.z + dir.z * (start - toi + 0.06));
    }
    const hull = rock.variant.shape.hull;
    const yaw = rock.group.rotation.y;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    let reach = 0;
    for (let i = 0; i < hull.length; i += 3) {
      const x = hull[i], z = hull[i + 2];
      // Only the hull's middle band counts (the base flares wider than the face that is hit)
      if (hull[i + 1] * s < h * 0.15 || hull[i + 1] * s > h * 0.9) continue;
      reach = Math.max(reach, (x * c + z * sn) * dir.x + (-x * sn + z * c) * dir.z);
    }
    if (reach <= 0) reach = ROCK_RADIUS * 0.6;
    return rock.position.clone().addScaledVector(dir, reach * s * 0.8).setY(rock.position.y + h * 0.45);
  }

  /**
   * The broken rock falls apart: chunks fill its volume and tumble outwards (ore-coloured pieces
   * among them), then lie a moment and shrink away.
   */
  private crumble(rock: RockNode): void {
    const colors = rockColors(rock.kind);
    const s = rock.group.scale.x;
    const h = rock.variant.shape.height * s;
    const count = colors.ore ? 14 : 11;
    const at = new THREE.Vector3();
    const vel = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * rock.radius * 0.6;
      at.set(rock.position.x + Math.cos(a) * r, rock.position.y + 0.12 + Math.random() * h * 0.65, rock.position.z + Math.sin(a) * r);
      const out = 1.2 + Math.random() * 2.6;
      vel.set(Math.cos(a) * out, 1.5 + Math.random() * 4, Math.sin(a) * out);
      const ore = colors.ore && i % 3 === 0;
      this.spawnChip(at, vel, (0.22 + Math.random() * 0.2) * s, ore ? colors.ore! : colors.stone, CHIP_LIFE_BREAK + Math.random() * 0.8);
    }
  }

  /** `ccd`: small fast chips only (the slower crumbled chunks don't tunnel through the ground). */
  private spawnChip(at: THREE.Vector3, vel: THREE.Vector3, size: number, color: THREE.Color, life: number, ccd = false): void {
    if (!this.physics.isInitialized()) return;
    if (this.chips.length >= CHIP_MAX) this.dropChip(0);
    const R = this.physics.rapier;
    const body = this.physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(at.x, at.y, at.z)
        .setRotation(RockField._q.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6)))
        .setLinvel(vel.x, vel.y, vel.z)
        .setAngvel({ x: (Math.random() - 0.5) * 16, y: (Math.random() - 0.5) * 16, z: (Math.random() - 0.5) * 16 })
        .setLinearDamping(0.1)
        .setAngularDamping(0.9)
        .setCcdEnabled(ccd)
    );
    body.userData = { noCarry: true };
    const dim = new THREE.Vector3(size * (0.8 + Math.random() * 0.5), size * (0.7 + Math.random() * 0.4), size * (0.8 + Math.random() * 0.5));
    // Only the ground and the static world: chips pass through each other, the player and props
    this.physics.world.createCollider(
      R.ColliderDesc.cuboid(dim.x * 0.42, dim.y * 0.32, dim.z * 0.38)
        .setDensity(2600)
        .setFriction(0.9)
        .setRestitution(0.2)
        .setCollisionGroups(this.physics.packCollisionGroups(COLLISION_GROUPS.DYNAMIC_PROPS, COLLISION_GROUPS.ENVIRONMENT | COLLISION_GROUPS.TERRAIN)),
      body
    );
    const k = 0.88 + Math.random() * 0.24;
    this.chips.push({ body, size: dim, color: color.clone().multiplyScalar(k), age: 0, life, pos: at.clone(), rot: RockField._q.clone() });
    this.chipColorsDirty = true;
  }

  private dropChip(i: number): void {
    this.physics.removeRigidBody(this.chips[i].body);
    this.chips.splice(i, 1);
    this.chipColorsDirty = true;
  }

  /** Chips follow their bodies, pop in, lie a while, then shrink away. */
  private updateChips(dt: number): void {
    const mesh = this.chipMesh;
    for (let i = this.chips.length - 1; i >= 0; i--) {
      const c = this.chips[i];
      c.age += dt;
      if (c.age > c.life + CHIP_SHRINK || c.pos.y < -200) this.dropChip(i);
    }
    for (let i = 0; i < this.chips.length; i++) {
      const c = this.chips[i];
      // A chip at rest sleeps: keep its last pose (Rapier's getters allocate a fresh object each call)
      if (!c.body.isSleeping()) {
        const t = c.body.translation();
        const r = c.body.rotation();
        c.pos.set(t.x, t.y, t.z);
        c.rot.set(r.x, r.y, r.z, r.w);
      }
      const k = c.age > c.life ? 1 - (c.age - c.life) / CHIP_SHRINK : Math.min(1, 0.4 + c.age * 10);
      RockField._m.compose(c.pos, c.rot, RockField._s.copy(c.size).multiplyScalar(Math.max(0.001, k)));
      mesh.setMatrixAt(i, RockField._m);
      if (this.chipColorsDirty) mesh.setColorAt(i, c.color);
    }
    mesh.count = this.chips.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (this.chipColorsDirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.chipColorsDirty = false;
  }

  /** Adds a rock at a world position (y = ground height), e.g. ore veins in the mountains and caves. */
  public addRock(position: THREE.Vector3, kind: RockKind, scale = 1): void {
    this.createRock(this.nextId++, position, kind, scale);
  }

  /** Removes every rock the test matches (the cave editor rebuilds the cave ore). */
  public removeRocksWhere(test: (pos: THREE.Vector3) => boolean): void {
    this.rocks = this.rocks.filter((rock) => {
      if (!test(rock.position)) return true;
      if (rock.body) this.physics.removeRigidBody(rock.body);
      rock.body = null;
      this.batch.deleteInstance(rock.instanceId);
      return false;
    });
  }

  /** Every LOD_PASS_SECONDS (once the camera moved): each rock takes the LOD its distance asks for. */
  private updateLods(dt: number, eye: THREE.Vector3): void {
    this.eye.copy(eye);
    this.lodTimer -= dt;
    if (this.lodTimer > 0 || eye.distanceToSquared(this.lastPassEye) < LOD_PASS_MOVE * LOD_PASS_MOVE) return;
    this.lodTimer = LOD_PASS_SECONDS;
    this.lastPassEye.copy(eye);
    for (const rock of this.rocks) this.pickLod(rock);
  }

  private pickLod(rock: RockNode): void {
    const d = Math.sqrt(rock.position.distanceToSquared(this.eye));
    let level = rock.level;
    // Step only once past a boundary by the hysteresis (no flicker at the edge)
    while (level < 2 && d > LOD_DISTS[level] + LOD_HYST) level++;
    while (level > 0 && d < LOD_DISTS[level - 1] - LOD_HYST) level--;
    if (level === rock.level) return;
    rock.level = level;
    this.batch.setGeometryIdAt(rock.instanceId, rock.variant.ids[level]);
  }

  /** The kind's shapes, built and added to the batch the first time a rock of that kind appears. */
  private variantsOf(kind: RockKind): VariantEntry[] {
    let list = this.variants.get(kind);
    if (list) return list;
    list = [];
    for (let i = 0; i < ROCK_VARIANTS[kind]; i++) {
      const shape = buildRockVariant(kind, i);
      const ids = shape.lods.map((geo) => {
        const verts = geo.getAttribute('position').count;
        if (this.verticesUsed + verts > this.vertexCapacity) {
          this.vertexCapacity = Math.max(this.vertexCapacity * 2, this.verticesUsed + verts);
          this.batch.setGeometrySize(this.vertexCapacity, 0);
        }
        this.verticesUsed += verts;
        const id = this.batch.addGeometry(geo);
        geo.dispose();
        return id;
      });
      list.push({ shape, ids });
    }
    this.variants.set(kind, list);
    return list;
  }

  private createRock(id: number, position: THREE.Vector3, kind: RockKind, scale: number): void {
    const group = new THREE.Object3D();
    group.name = `Rock_${kind}_${id}`;
    group.position.copy(position);
    group.rotation.y = hash2(position.x, position.z, 2) * Math.PI * 2;
    group.scale.setScalar(scale);

    const list = this.variantsOf(kind);
    const variant = list[Math.floor(hash2(position.x, position.z, 1) * list.length) % list.length];
    if (this.batch.instanceCount >= this.batch.maxInstanceCount) this.batch.setInstanceCount(this.batch.maxInstanceCount * 2);
    const d = Math.sqrt(position.distanceToSquared(this.eye));
    const level = d < LOD_DISTS[0] ? 0 : d < LOD_DISTS[1] ? 1 : 2;
    const instanceId = this.batch.addInstance(variant.ids[level]);
    // A slight per-rock tint (lighter / darker, a touch warmer or cooler)
    const k = 0.9 + hash2(position.x, position.z, 3) * 0.18;
    const warm = (hash2(position.x, position.z, 4) - 0.5) * 0.06;
    this.batch.setColorAt(instanceId, RockField._tint.setRGB(k * (1 + warm), k, k * (1 - warm)));

    const rock: RockNode = {
      id,
      kind,
      position: position.clone(),
      radius: ROCK_RADIUS * scale,
      maxHealth: ROCK_TYPES[kind].hits,
      health: ROCK_TYPES[kind].hits,
      group,
      instanceId,
      variant,
      level,
      baseScale: scale,
      body: null,
      isDepleted: false,
      regrowAt: 0,
      shake: 0,
      growProgress: 1,
    };
    this.syncRock(rock);
    this.addCollider(rock);
    this.rocks.push(rock);
  }

  /** Copies the rock's transform and visibility into the batch. */
  private syncRock(rock: RockNode): void {
    rock.group.updateMatrix();
    this.batch.setMatrixAt(rock.instanceId, rock.group.matrix);
    this.batch.setVisibleAt(rock.instanceId, !rock.isDepleted);
  }

  /** A convex hull fitted to the rock's coarse LOD (a cylinder if Rapier can't build it). */
  private addCollider(rock: RockNode): void {
    const R = this.physics.rapier;
    const s = rock.baseScale;
    const desc = R.ColliderDesc.convexHull(rock.variant.shape.hull.map((v) => v * s));
    if (!desc) {
      const height = rock.variant.shape.height * s;
      const res = this.physics.createStaticCylinder(
        new THREE.Vector3(rock.position.x, rock.position.y + height / 2, rock.position.z),
        rock.radius * 0.85,
        height
      );
      (res.collider as unknown as { userData: unknown }).userData = { surface: 'stone' };
      rock.body = res.body;
      return;
    }
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rock.group.rotation.y);
    const body = this.physics.world.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(rock.position.x, rock.position.y, rock.position.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
    );
    const collider = this.physics.world.createCollider(
      desc.setFriction(0.6).setRestitution(0).setCollisionGroups(this.physics.packCollisionGroups(COLLISION_GROUPS.ENVIRONMENT, 0xffff)),
      body
    );
    (collider as unknown as { userData: unknown }).userData = { surface: 'stone' };
    rock.body = body;
  }

  private breakRock(rock: RockNode): void {
    rock.isDepleted = true;
    this.syncRock(rock);
    rock.regrowAt = performance.now() + GATHERING_CONFIG.ROCK_REGROW_SECONDS * 1000;
    if (rock.body) {
      this.physics.removeRigidBody(rock.body);
      rock.body = null;
    }

    audioEngine.at(rock.position, 4).playRockBreak();
    this.crumble(rock);

    const drops = ROCK_TYPES[rock.kind].drops.map((drop) => ({ itemId: drop.itemId, amount: rollDrop(drop) }));
    this.onMined?.(drops, rock.position.clone());
  }

  private regrowRock(rock: RockNode): void {
    rock.isDepleted = false;
    rock.health = rock.maxHealth;
    rock.group.position.copy(rock.position);
    rock.growProgress = 0;
    rock.group.scale.setScalar(0.01);
    this.syncRock(rock);
    this.addCollider(rock);
  }
}
