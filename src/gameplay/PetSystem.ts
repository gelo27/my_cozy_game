import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TerrainSystem } from '../world/TerrainSystem';
import { worldSettings } from '../world/WorldSettings';
import { ParticleManager } from '../particles/ParticleManager';

export type PetKind = 'cat' | 'dog';

export interface PetSaveData {
  kind: PetKind;
  name: string;
  affection: number;
  p: [number, number];
}

interface PetLook {
  body: number;
  accent: number;
  scale: number;
  ears: 'pointy' | 'floppy';
}

const LOOKS: Record<PetKind, PetLook> = {
  cat: { body: 0xf0a35e, accent: 0xfff3e0, scale: 0.75, ears: 'pointy' },
  dog: { body: 0xc8925a, accent: 0x6d4c33, scale: 1, ears: 'floppy' },
};

type PetMode = 'idle' | 'follow' | 'wander' | 'sit' | 'happy';

/**
 * A companion animal: merged low-poly body + 4 legs and a tail animated procedurally.
 * No physics body (it walks on the heightmap), and it updates at a reduced rate when far away.
 */
export class Pet {
  public readonly group = new THREE.Group();
  public affection = 20;
  public mode: PetMode = 'idle';
  private readonly legs: THREE.Mesh[] = [];
  private readonly tail: THREE.Mesh;
  private readonly head: THREE.Group;
  private heading = 0;
  private speed = 0;
  private walkPhase = 0;
  private modeTimer = 0;
  private happyTimer = 0;
  private wanderTarget = new THREE.Vector3();
  private lastPetAt = -Infinity;
  private farAccum = 0;

  constructor(public readonly kind: PetKind, public name: string, spawn: THREE.Vector3) {
    const look = LOOKS[kind];
    const body = new THREE.MeshLambertMaterial({ color: look.body });
    const accent = new THREE.MeshLambertMaterial({ color: look.accent });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2b2b2b });

    const torso = new THREE.BoxGeometry(0.34, 0.3, 0.6);
    torso.translate(0, 0.38, 0);
    const belly = new THREE.BoxGeometry(0.28, 0.08, 0.5);
    belly.translate(0, 0.24, 0);
    this.group.add(new THREE.Mesh(torso, body), new THREE.Mesh(belly, accent));

    this.head = new THREE.Group();
    this.head.position.set(0, 0.58, 0.34);
    const skull = new THREE.BoxGeometry(0.3, 0.26, 0.28);
    const earGeos: THREE.BufferGeometry[] = [];
    for (const sx of [-0.1, 0.1]) {
      const ear = look.ears === 'pointy' ? new THREE.ConeGeometry(0.06, 0.13, 4) : new THREE.BoxGeometry(0.07, 0.16, 0.05);
      ear.translate(sx * (look.ears === 'pointy' ? 1 : 1.6), look.ears === 'pointy' ? 0.18 : 0.04, 0);
      earGeos.push(ear.index ? ear.toNonIndexed() : ear);
    }
    const snout = new THREE.BoxGeometry(0.16, 0.12, 0.12);
    snout.translate(0, -0.05, 0.17);
    this.head.add(
      new THREE.Mesh(skull, body),
      new THREE.Mesh(mergeGeometries(earGeos.map((g) => (g.deleteAttribute('uv'), g)))!, look.ears === 'pointy' ? body : accent),
      new THREE.Mesh(snout, accent)
    );
    const eyeGeo = new THREE.BoxGeometry(0.04, 0.05, 0.02);
    for (const sx of [-0.07, 0.07]) {
      const eye = new THREE.Mesh(eyeGeo, dark);
      eye.position.set(sx, 0.04, 0.145);
      this.head.add(eye);
    }
    this.group.add(this.head);

    const legGeo = new THREE.BoxGeometry(0.09, 0.26, 0.09);
    legGeo.translate(0, -0.13, 0);
    for (const [x, z] of [[-0.11, 0.2], [0.11, 0.2], [-0.11, -0.2], [0.11, -0.2]]) {
      const leg = new THREE.Mesh(legGeo, body);
      leg.position.set(x, 0.26, z);
      this.legs.push(leg);
      this.group.add(leg);
    }
    const tailGeo = new THREE.BoxGeometry(0.06, 0.06, kind === 'cat' ? 0.42 : 0.26);
    tailGeo.translate(0, 0, -(kind === 'cat' ? 0.21 : 0.13));
    this.tail = new THREE.Mesh(tailGeo, kind === 'cat' ? body : accent);
    this.tail.position.set(0, 0.46, -0.3);
    this.group.add(this.tail);

    this.group.scale.setScalar(look.scale);
    this.group.position.copy(spawn);
    this.wanderTarget.copy(spawn);
  }

  public canPet(now: number): boolean {
    return now - this.lastPetAt > 1.2;
  }

  public pet(now: number, particles?: ParticleManager): void {
    this.lastPetAt = now;
    this.affection = Math.min(100, this.affection + 3);
    this.mode = 'happy';
    this.happyTimer = 1.4;
    particles?.emitHearts(this.group.position.clone().add(new THREE.Vector3(0, 0.8, 0)));
  }

  public feed(particles?: ParticleManager): void {
    this.affection = Math.min(100, this.affection + 15);
    this.mode = 'happy';
    this.happyTimer = 2.2;
    particles?.emitHearts(this.group.position.clone().add(new THREE.Vector3(0, 0.8, 0)), 16);
  }

  public update(dt: number, player: THREE.Vector3, playerMoving: boolean, terrain: TerrainSystem, time: number): void {
    const pos = this.group.position;
    const dx = player.x - pos.x;
    const dz = player.z - pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Far away pets tick at ~10 Hz
    if (dist > 30) {
      this.farAccum += dt;
      if (this.farAccum < 0.1) return;
      dt = this.farAccum;
      this.farAccum = 0;
    }

    this.modeTimer -= dt;
    let target: THREE.Vector3 | null = null;
    let targetSpeed = 0;

    if (this.mode === 'happy') {
      this.happyTimer -= dt;
      if (this.happyTimer <= 0) this.mode = 'idle';
    } else if (dist > 4.5) {
      this.mode = 'follow';
    } else if (this.mode === 'follow' && dist < 2.2) {
      this.mode = playerMoving ? 'idle' : 'sit';
      this.modeTimer = 3 + Math.random() * 4;
    } else if (this.modeTimer <= 0 && this.mode !== 'follow') {
      // Pick a nearby spot around the player to sniff, or sit down
      if (Math.random() < 0.55) {
        this.mode = 'wander';
        const a = Math.random() * Math.PI * 2;
        this.wanderTarget.set(player.x + Math.cos(a) * 3, 0, player.z + Math.sin(a) * 3);
      } else {
        this.mode = 'sit';
      }
      this.modeTimer = 3 + Math.random() * 5;
    }

    if (this.mode === 'follow') {
      target = player;
      targetSpeed = dist > 10 ? 7 : 4.2;
      if (dist > 40) {
        // Lost: teleport just behind the player
        pos.set(player.x - 2, 0, player.z - 2);
      }
    } else if (this.mode === 'wander') {
      target = this.wanderTarget;
      targetSpeed = 1.3;
      if (Math.hypot(this.wanderTarget.x - pos.x, this.wanderTarget.z - pos.z) < 0.4) {
        this.mode = 'idle';
        this.modeTimer = 2 + Math.random() * 3;
      }
    }

    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 5);
    if (target && this.speed > 0.05) {
      const tx = target.x - pos.x;
      const tz = target.z - pos.z;
      const desired = Math.atan2(tx, tz);
      let d = desired - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * Math.min(1, dt * 8);
      const nx = pos.x + Math.sin(this.heading) * this.speed * dt;
      const nz = pos.z + Math.cos(this.heading) * this.speed * dt;
      // Pets do not swim: stop at the shoreline
      if (terrain.getHeight(nx, nz) > worldSettings.waterLevel + 0.05) {
        pos.x = nx;
        pos.z = nz;
      } else {
        this.mode = 'idle';
        this.speed = 0;
      }
    } else if (this.mode !== 'happy' && dist < 6) {
      // Look at the player while idle
      const desired = Math.atan2(dx, dz);
      let d = desired - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * Math.min(1, dt * 2);
    }

    pos.y = terrain.getHeight(pos.x, pos.z);
    this.group.rotation.y = this.heading;

    // Procedural animation
    const moving = this.speed > 0.3;
    this.walkPhase += dt * (moving ? this.speed * 3.2 : 0);
    const swing = moving ? Math.sin(this.walkPhase) * 0.6 : 0;
    this.legs[0].rotation.x = swing;
    this.legs[3].rotation.x = swing;
    this.legs[1].rotation.x = -swing;
    this.legs[2].rotation.x = -swing;
    const sit = this.mode === 'sit';
    this.legs[2].rotation.x = sit ? -1.2 : this.legs[2].rotation.x;
    this.legs[3].rotation.x = sit ? -1.2 : this.legs[3].rotation.x;
    this.group.children[0].rotation.x = sit ? -0.35 : 0;
    const wag = this.mode === 'happy' ? 18 : this.kind === 'dog' ? 7 : 2;
    this.tail.rotation.y = Math.sin(time * wag) * (this.mode === 'happy' ? 0.8 : 0.35);
    this.tail.rotation.x = this.kind === 'cat' ? -0.6 : -0.3;
    const bounce = this.mode === 'happy' ? Math.abs(Math.sin(time * 9)) * 0.12 : moving ? Math.abs(Math.sin(this.walkPhase)) * 0.03 : 0;
    this.group.position.y += bounce;
    this.head.rotation.x = sit ? 0.2 : Math.sin(time * 1.3) * 0.05;
  }
}

/** Owns the player's pets. */
export class PetSystem {
  public readonly pets: Pet[] = [];
  private time = 0;

  constructor(private readonly scene: THREE.Scene, private readonly terrain: TerrainSystem, private readonly particles?: ParticleManager) {}

  public spawnDefaults(near: THREE.Vector3): void {
    this.add('cat', 'Мурчик', new THREE.Vector3(near.x + 2, 0, near.z + 1));
    this.add('dog', 'Бублик', new THREE.Vector3(near.x - 2, 0, near.z + 1.5));
  }

  public add(kind: PetKind, name: string, pos: THREE.Vector3): Pet {
    const pet = new Pet(kind, name, pos);
    this.pets.push(pet);
    this.scene.add(pet.group);
    return pet;
  }

  public clear(): void {
    for (const p of this.pets) p.group.removeFromParent();
    this.pets.length = 0;
  }

  public nearest(pos: THREE.Vector3, maxDist: number): Pet | null {
    let best: Pet | null = null;
    let bestD = maxDist;
    for (const p of this.pets) {
      const d = p.group.position.distanceTo(pos);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  public petNearest(pos: THREE.Vector3): Pet | null {
    const pet = this.nearest(pos, 2.2);
    if (pet && pet.canPet(this.time)) pet.pet(this.time, this.particles);
    return pet;
  }

  public feed(pet: Pet): void {
    pet.feed(this.particles);
  }

  public update(dt: number, player: THREE.Vector3, playerMoving: boolean): void {
    this.time += dt;
    for (const p of this.pets) p.update(dt, player, playerMoving, this.terrain, this.time);
  }

  public serialize(): PetSaveData[] {
    return this.pets.map((p) => ({
      kind: p.kind,
      name: p.name,
      affection: Math.round(p.affection),
      p: [+p.group.position.x.toFixed(2), +p.group.position.z.toFixed(2)],
    }));
  }

  public deserialize(data: PetSaveData[]): void {
    this.clear();
    for (const d of data) {
      const pet = this.add(d.kind, d.name, new THREE.Vector3(d.p[0], 0, d.p[1]));
      pet.affection = d.affection;
    }
  }
}
