import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { ParticleManager } from '../particles/ParticleManager';
import { audioEngine } from '../audio/AudioEngine';
import { GATHERING_CONFIG, ROCK_TYPES, RockKind, rollDrop } from './GatheringConfig';

export interface RockNode {
  id: number;
  kind: RockKind;
  position: THREE.Vector3;
  radius: number;
  maxHealth: number;
  health: number;
  group: THREE.Group;
  baseScale: number;
  body: RAPIER.RigidBody | null;
  isDepleted: boolean;
  regrowAt: number;
  // Visual hit shake & regrow pop-in
  shake: number;
  growProgress: number;
}

/**
 * Mineable boulders (stone) and ore rocks (iron + stone).
 * Each pickaxe hit chips the rock smaller; the last hit breaks it and drops resources.
 * Broken rocks grow back after ROCK_REGROW_SECONDS.
 */
export class RockField {
  public group: THREE.Group;
  /** Called with the dropped items when a rock breaks. */
  public onMined: ((drops: { itemId: string; amount: number }[], at: THREE.Vector3) => void) | null = null;

  private rocks: RockNode[] = [];
  private stoneMaterial = new THREE.MeshLambertMaterial({ color: 0x8b8f96, flatShading: true });
  private darkStoneMaterial = new THREE.MeshLambertMaterial({ color: 0x6b6f76, flatShading: true });
  private oreMaterials: Partial<Record<RockKind, THREE.Material>> = {
    iron: new THREE.MeshLambertMaterial({ color: 0xc2703d, flatShading: true }),
    copper: new THREE.MeshLambertMaterial({ color: 0x4fa88a, flatShading: true }),
    gold: new THREE.MeshLambertMaterial({ color: 0xf2c14e, emissive: 0x3a2800, flatShading: true }),
    crystal: new THREE.MeshLambertMaterial({ color: 0xb69bff, emissive: 0x3a2a80, flatShading: true }),
  };

  constructor(
    private physics: PhysicsWorld,
    scene: THREE.Scene,
    private particleManager: ParticleManager | null,
    spots: { position: THREE.Vector3; kind: RockKind; scale: number }[]
  ) {
    this.group = new THREE.Group();
    this.group.name = 'RockField';
    scene.add(this.group);

    spots.forEach((spot, i) => this.createRock(i, spot.position, spot.kind, spot.scale));
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
      }

      if (rock.shake > 0) {
        rock.shake = Math.max(0, rock.shake - dt * 6);
        const s = rock.shake * 0.06;
        rock.group.position.set(
          rock.position.x + (Math.random() - 0.5) * s,
          rock.position.y,
          rock.position.z + (Math.random() - 0.5) * s
        );
      }
    }
  }

  /** Adds a rock at a world position (y = ground height), e.g. ore veins in the mountains and caves. */
  public addRock(position: THREE.Vector3, kind: RockKind, scale = 1): void {
    this.createRock(this.rocks.length, position, kind, scale);
  }

  private createRock(id: number, position: THREE.Vector3, kind: RockKind, scale: number): void {
    const group = new THREE.Group();
    group.name = `Rock_${kind}_${id}`;
    group.position.copy(position);

    // Low-poly boulder: jittered icosahedron squashed onto the ground
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = 0.82 + 0.3 * Math.abs(Math.sin(v.x * 3.1 + id) * Math.cos(v.z * 2.7 - id));
      v.multiplyScalar(n);
      v.y = v.y * 0.62 + 0.42;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();

    const body = new THREE.Mesh(geo, id % 2 === 0 ? this.stoneMaterial : this.darkStoneMaterial);
    body.rotation.y = id * 1.3;
    if (kind === 'crystal') body.scale.set(0.7, 0.45, 0.7);
    group.add(body);

    const oreMat = this.oreMaterials[kind];
    if (kind === 'crystal') {
      // A cluster of tall glowing prisms
      const prism = new THREE.CylinderGeometry(0, 0.16, 1, 5);
      prism.translate(0, 0.5, 0);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + id;
        const shard = new THREE.Mesh(prism, oreMat);
        const r = i === 0 ? 0 : 0.35;
        shard.position.set(Math.cos(a) * r, 0.2, Math.sin(a) * r);
        shard.rotation.set(Math.sin(a) * (r ? 0.45 : 0), 0, Math.cos(a) * (r ? 0.45 : 0));
        shard.scale.set(1, i === 0 ? 1.5 : 0.8 + (i % 3) * 0.25, 1);
        group.add(shard);
      }
    } else if (oreMat) {
      // Ore nuggets poking out of the surface
      const nuggetGeo = new THREE.OctahedronGeometry(0.2, 0);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + id;
        const nugget = new THREE.Mesh(nuggetGeo, oreMat);
        nugget.position.set(Math.cos(a) * 0.78, 0.45 + (i % 3) * 0.22, Math.sin(a) * 0.78);
        nugget.rotation.set(a, a * 0.7, 0);
        nugget.scale.setScalar(0.8 + (i % 2) * 0.5);
        group.add(nugget);
      }
    }

    group.scale.setScalar(scale);
    this.group.add(group);

    const radius = 0.95 * scale;
    const rock: RockNode = {
      id,
      kind,
      position: position.clone(),
      radius,
      maxHealth: ROCK_TYPES[kind].hits,
      health: ROCK_TYPES[kind].hits,
      group,
      baseScale: scale,
      body: null,
      isDepleted: false,
      regrowAt: 0,
      shake: 0,
      growProgress: 1,
    };
    this.addCollider(rock);
    this.rocks.push(rock);
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
    rock.group.visible = false;
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
    rock.group.visible = true;
    rock.group.position.copy(rock.position);
    rock.growProgress = 0;
    rock.group.scale.setScalar(0.01);
    this.addCollider(rock);
  }
}
