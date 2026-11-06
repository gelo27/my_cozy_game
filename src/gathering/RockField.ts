import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { ParticleManager } from '../particles/ParticleManager';
import { audioEngine } from '../audio/AudioEngine';
import { GATHERING_CONFIG, ROCK_TYPES, RockKind, rollDrop } from './GatheringConfig';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
  /** This rock's instance and geometry in the shared batch (and its vertex count). */
  instanceId: number;
  geometryId: number;
  vertices: number;
  baseScale: number;
  body: RAPIER.RigidBody | null;
  isDepleted: boolean;
  regrowAt: number;
  // Visual hit shake & regrow pop-in
  shake: number;
  growProgress: number;
}

/** Diffuse colours of the stone bodies and the ore, and how much the ore glows. */
const STONE = new THREE.Color(0x8b8f96);
const DARK_STONE = new THREE.Color(0x6b6f76);
const ORE: Partial<Record<RockKind, { color: THREE.Color; glow: number }>> = {
  iron: { color: new THREE.Color(0xc2703d), glow: 0 },
  copper: { color: new THREE.Color(0x4fa88a), glow: 0 },
  gold: { color: new THREE.Color(0xf2c14e), glow: 0.05 },
  crystal: { color: new THREE.Color(0xb69bff), glow: 0.16 },
};

/**
 * Mineable boulders (stone) and ore rocks (iron + stone).
 * Each pickaxe hit chips the rock smaller; the last hit breaks it and drops resources.
 * Broken rocks grow back after ROCK_REGROW_SECONDS.
 *
 * Rendering: every rock (its boulder and ore nuggets / crystal shards merged into one geometry,
 * coloured per vertex) is an instance of ONE BatchedMesh: a single draw call for all of them,
 * with per-rock frustum culling, hiding and transforms. The ore's glow is a vertex attribute.
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
    this.vertexCapacity = instances * 420;
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

    spots.forEach((spot) => this.createRock(this.nextId++, spot.position, spot.kind, spot.scale));
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
    this.particleManager?.emitBuildPuff(surface, false, 14);
    if (rock.kind !== 'stone') this.particleManager?.emitBuildPuff(surface, true, 6);

    if (rock.health > 0) {
      audioEngine.at(surface).playBuildPlace(false);
      // Chip the rock smaller with every hit
      const remaining = rock.health / rock.maxHealth;
      rock.group.scale.setScalar(rock.baseScale * (0.7 + 0.3 * remaining));
      this.syncRock(rock);
      return false;
    }

    this.breakRock(rock);
    return true;
  }

  public update(dt: number): void {
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

  /** Adds a rock at a world position (y = ground height), e.g. ore veins in the mountains and caves. */
  public addRock(position: THREE.Vector3, kind: RockKind, scale = 1): void {
    this.createRock(this.nextId++, position, kind, scale);
  }

  /** Removes every rock the test matches (the cave editor rebuilds the cave ore). */
  public removeRocksWhere(test: (pos: THREE.Vector3) => boolean): void {
    let removed = 0;
    this.rocks = this.rocks.filter((rock) => {
      if (!test(rock.position)) return true;
      if (rock.body) this.physics.removeRigidBody(rock.body);
      rock.body = null;
      this.batch.deleteInstance(rock.instanceId);
      this.batch.deleteGeometry(rock.geometryId);
      this.verticesUsed -= rock.vertices;
      removed++;
      return false;
    });
    if (removed) this.batch.optimize();
  }

  private createRock(id: number, position: THREE.Vector3, kind: RockKind, scale: number): void {
    const group = new THREE.Object3D();
    group.name = `Rock_${kind}_${id}`;
    group.position.copy(position);
    group.scale.setScalar(scale);

    const geo = this.buildRockGeometry(id, kind);
    const verts = geo.getAttribute('position').count;
    if (this.verticesUsed + verts > this.vertexCapacity) {
      this.vertexCapacity = Math.max(this.vertexCapacity * 2, this.verticesUsed + verts);
      this.batch.setGeometrySize(this.vertexCapacity, 0);
    }
    if (this.batch.instanceCount >= this.batch.maxInstanceCount) this.batch.setInstanceCount(this.batch.maxInstanceCount * 2);
    const geometryId = this.batch.addGeometry(geo);
    this.verticesUsed += verts;
    geo.dispose();
    const instanceId = this.batch.addInstance(geometryId);

    const radius = 0.95 * scale;
    const rock: RockNode = {
      id,
      kind,
      position: position.clone(),
      radius,
      maxHealth: ROCK_TYPES[kind].hits,
      health: ROCK_TYPES[kind].hits,
      group,
      instanceId,
      geometryId,
      vertices: verts,
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

  /** One rock as a single non-indexed geometry: the boulder plus its ore, coloured per vertex. */
  private buildRockGeometry(id: number, kind: RockKind): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const add = (g: THREE.BufferGeometry, matrix: THREE.Matrix4, color: THREE.Color, glow: number) => {
      const part = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(matrix);
      part.deleteAttribute('uv');
      const n = part.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
      part.setAttribute('color', new THREE.BufferAttribute(col, 3));
      part.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
      parts.push(part);
    };

    // Low-poly boulder: jittered icosahedron squashed onto the ground
    const body = new THREE.IcosahedronGeometry(1, 1);
    const pos = body.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = 0.82 + 0.3 * Math.abs(Math.sin(v.x * 3.1 + id) * Math.cos(v.z * 2.7 - id));
      v.multiplyScalar(n);
      v.y = v.y * 0.62 + 0.42;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    body.computeVertexNormals();
    q.setFromEuler(e.set(0, id * 1.3, 0));
    const bs = kind === 'crystal' ? new THREE.Vector3(0.7, 0.45, 0.7) : new THREE.Vector3(1, 1, 1);
    add(body, m.compose(new THREE.Vector3(), q, bs), id % 2 === 0 ? STONE : DARK_STONE, 0);
    body.dispose();

    const ore = ORE[kind];
    if (kind === 'crystal' && ore) {
      // A cluster of tall glowing prisms
      const prism = new THREE.CylinderGeometry(0, 0.16, 1, 5);
      prism.translate(0, 0.5, 0);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + id;
        const r = i === 0 ? 0 : 0.35;
        q.setFromEuler(e.set(Math.sin(a) * (r ? 0.45 : 0), 0, Math.cos(a) * (r ? 0.45 : 0)));
        m.compose(new THREE.Vector3(Math.cos(a) * r, 0.2, Math.sin(a) * r), q, new THREE.Vector3(1, i === 0 ? 1.5 : 0.8 + (i % 3) * 0.25, 1));
        add(prism, m, ore.color, ore.glow);
      }
      prism.dispose();
    } else if (ore) {
      // Ore nuggets poking out of the surface
      const nugget = new THREE.OctahedronGeometry(0.2, 0);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + id;
        q.setFromEuler(e.set(a, a * 0.7, 0));
        m.compose(new THREE.Vector3(Math.cos(a) * 0.78, 0.45 + (i % 3) * 0.22, Math.sin(a) * 0.78), q, new THREE.Vector3().setScalar(0.8 + (i % 2) * 0.5));
        add(nugget, m, ore.color, ore.glow);
      }
      nugget.dispose();
    }
    const merged = mergeGeometries(parts)!;
    for (const p of parts) p.dispose();
    return merged;
  }

  private addCollider(rock: RockNode): void {
    const height = 1.1 * rock.baseScale;
    const res = this.physics.createStaticCylinder(
      new THREE.Vector3(rock.position.x, rock.position.y + height / 2, rock.position.z),
      rock.radius * 0.85,
      height
    );
    (res.collider as unknown as { userData: unknown }).userData = { surface: 'stone' };
    rock.body = res.body;
  }

  private breakRock(rock: RockNode): void {
    rock.isDepleted = true;
    this.syncRock(rock);
    rock.regrowAt = performance.now() + GATHERING_CONFIG.ROCK_REGROW_SECONDS * 1000;
    if (rock.body) {
      this.physics.removeRigidBody(rock.body);
      rock.body = null;
    }

    audioEngine.at(rock.position, 4).playBuildDemolish();
    const center = rock.position.clone().setY(rock.position.y + 0.4);
    this.particleManager?.emitBuildPuff(center, false, 36);
    this.particleManager?.emitLandDust(center, 6);

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
