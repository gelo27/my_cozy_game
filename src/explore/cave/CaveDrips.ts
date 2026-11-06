import * as THREE from 'three';
import { caveAudio } from '../../audio/CaveAudio';

const MAX_DROPS = 32;
const MAX_RINGS = 24;
const ACTIVE_RADIUS = 26;
const SOUND_RADIUS = 14;
const CELL = 16;

interface Drop {
  drip: number;
  /** 0..1 while the drop swells on the tip, then it falls. */
  grow: number;
  y: number;
  v: number;
}

interface Ring {
  x: number;
  y: number;
  z: number;
  t: number;
  water: boolean;
}

/**
 * Water dripping from stalactites: near the player each dripping tip swells a drop, lets it fall,
 * and it splashes (a ring that spreads on pools, a small one on rock) with a positional plink.
 * Fixed pools of instances, no per-frame allocation; only tips within ~26 m are simulated.
 */
export class CaveDrips {
  public readonly group = new THREE.Group();
  private readonly drops: THREE.InstancedMesh;
  private readonly rings: THREE.InstancedMesh;
  private readonly live: Drop[] = [];
  private readonly freeDrops: Drop[] = [];
  private readonly liveRings: Ring[] = [];
  private readonly freeRings: Ring[] = [];
  private readonly timers: Float32Array;
  private readonly grid = new Map<number, number[]>();
  private active: number[] = [];
  private scanTimer = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly c = new THREE.Color();

  /** `data`: x, y, z, landing y, water flag per drip, in world space. */
  constructor(private readonly data: Float32Array) {
    const n = data.length / 5;
    this.timers = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.timers[i] = Math.random() * 12;
      const key = this.key(data[i * 5], data[i * 5 + 2]);
      let l = this.grid.get(key);
      if (!l) this.grid.set(key, (l = []));
      l.push(i);
    }
    const dropGeo = new THREE.SphereGeometry(0.035, 6, 4);
    dropGeo.scale(1, 1.5, 1);
    this.drops = new THREE.InstancedMesh(dropGeo, new THREE.MeshBasicMaterial({ color: 0xcfeeff }), MAX_DROPS);
    const ringGeo = new THREE.RingGeometry(0.05, 0.08, 18);
    ringGeo.rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      MAX_RINGS
    );
    this.rings.setColorAt(0, this.c.setRGB(0, 0, 0));
    for (const mesh of [this.drops, this.rings]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
    }
    for (let i = 0; i < MAX_DROPS; i++) this.freeDrops.push({ drip: 0, grow: 0, y: 0, v: 0 });
    for (let i = 0; i < MAX_RINGS; i++) this.freeRings.push({ x: 0, y: 0, z: 0, t: 0, water: false });
  }

  private key(x: number, z: number): number {
    return Math.floor(x / CELL) * 4096 + Math.floor(z / CELL);
  }

  public update(dt: number, player: THREE.Vector3): void {
    const d = this.data;
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = 0.5;
      this.active.length = 0;
      const r = Math.ceil(ACTIVE_RADIUS / CELL);
      const cx = Math.floor(player.x / CELL), cz = Math.floor(player.z / CELL);
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          const l = this.grid.get((cx + i) * 4096 + (cz + j));
          if (!l) continue;
          for (const k of l) {
            const dx = d[k * 5] - player.x, dy = d[k * 5 + 1] - player.y, dz = d[k * 5 + 2] - player.z;
            if (dx * dx + dy * dy + dz * dz < ACTIVE_RADIUS * ACTIVE_RADIUS) this.active.push(k);
          }
        }
      }
    }

    for (const k of this.active) {
      this.timers[k] -= dt;
      if (this.timers[k] > 0) continue;
      this.timers[k] = 5 + Math.random() * 9;
      const drop = this.freeDrops.pop();
      if (!drop) continue;
      drop.drip = k;
      drop.grow = 0;
      drop.y = d[k * 5 + 1];
      drop.v = 0;
      this.live.push(drop);
    }

    // Drops: swell on the tip, then fall and splash
    let n = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const drop = this.live[i];
      const k = drop.drip;
      const x = d[k * 5], z = d[k * 5 + 2], floor = d[k * 5 + 3];
      let scale = 1;
      if (drop.grow < 1) {
        drop.grow = Math.min(1, drop.grow + dt * 1.6);
        scale = drop.grow;
      } else {
        drop.v += 9.8 * dt;
        drop.y -= drop.v * dt;
        if (drop.y <= floor) {
          const water = d[k * 5 + 4] > 0.5;
          this.splash(x, floor, z, water);
          this.p.set(x, floor, z);
          if (this.p.distanceToSquared(player) < SOUND_RADIUS * SOUND_RADIUS) caveAudio.drip(this.p, water);
          this.live.splice(i, 1);
          this.freeDrops.push(drop);
          continue;
        }
      }
      this.m.compose(this.p.set(x, drop.y - 0.04 * scale, z), this.q.identity(), this.s.setScalar(Math.max(0.01, scale)));
      this.drops.setMatrixAt(n++, this.m);
    }
    this.drops.count = n;
    if (n > 0) this.drops.instanceMatrix.needsUpdate = true;

    // Rings spread and fade
    n = 0;
    for (let i = this.liveRings.length - 1; i >= 0; i--) {
      const ring = this.liveRings[i];
      ring.t += dt / (ring.water ? 0.9 : 0.35);
      if (ring.t >= 1) {
        this.liveRings.splice(i, 1);
        this.freeRings.push(ring);
        continue;
      }
      const size = 1 + ring.t * (ring.water ? 7 : 2.5);
      this.m.compose(this.p.set(ring.x, ring.y, ring.z), this.q.identity(), this.s.set(size, 1, size));
      this.rings.setMatrixAt(n, this.m);
      const a = (1 - ring.t) * (ring.water ? 0.45 : 0.3);
      this.rings.setColorAt(n, this.c.setRGB(a * 0.8, a * 0.95, a));
      n++;
    }
    this.rings.count = n;
    if (n > 0) {
      this.rings.instanceMatrix.needsUpdate = true;
      if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
    }
  }

  private splash(x: number, y: number, z: number, water: boolean): void {
    const ring = this.freeRings.pop();
    if (!ring) return;
    ring.x = x;
    ring.y = y + 0.03;
    ring.z = z;
    ring.t = 0;
    ring.water = water;
    this.liveRings.push(ring);
  }

  /** Nothing in flight (when leaving the cave). */
  public clear(): void {
    while (this.live.length) this.freeDrops.push(this.live.pop()!);
    while (this.liveRings.length) this.freeRings.push(this.liveRings.pop()!);
    this.drops.count = 0;
    this.rings.count = 0;
    this.active.length = 0;
    this.scanTimer = 0;
  }

  public dispose(): void {
    for (const mesh of [this.drops, this.rings]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.group.removeFromParent();
  }
}
