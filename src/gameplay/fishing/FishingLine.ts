import * as THREE from 'three';
import type { WaterSampler } from './FishingFish';

/** Nodes of the line from the rod tip to the bobber, and of the leader from the bobber to the hook. */
const MAIN_N = 22;
const LEADER_N = 8;
const ITER = 10;

/**
 * The fishing line as two Verlet strings (like the spider webs: string constraints pull, never
 * push): the main line from the rod tip to the bobber sags in the air and floats on the water,
 * the leader hangs from the bobber down to the baited hook and trails behind it underwater.
 */
export class FishingLine {
  public readonly bobber: THREE.Group;
  public readonly hook: THREE.Group;
  /** Where the hook (bait) is now. */
  public readonly hookPos = new THREE.Vector3();

  private readonly main = new Float32Array((MAIN_N + 1) * 3);
  private readonly mainPrev = new Float32Array((MAIN_N + 1) * 3);
  private readonly leader = new Float32Array((LEADER_N + 1) * 3);
  private readonly leaderPrev = new Float32Array((LEADER_N + 1) * 3);
  private readonly mainLine: THREE.Line;
  private readonly leaderLine: THREE.Line;
  /** Length of one segment (m). */
  private mainSeg = 0.3;
  private leaderSeg = 0.1;
  private readonly bobberTilt = new THREE.Quaternion();
  /** 0..1 how hard the line pulls the float along (set by the fishing system): tilts it over. */
  public pull = 0;

  constructor(private readonly scene: THREE.Scene, private readonly sample: WaterSampler) {
    const mat = new THREE.LineBasicMaterial({ color: 0xf1f5f9, transparent: true, opacity: 0.85 });
    const mk = (n: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n + 1) * 3), 3));
      const l = new THREE.Line(g, mat);
      l.frustumCulled = false;
      l.visible = false;
      scene.add(l);
      return l;
    };
    this.mainLine = mk(MAIN_N);
    this.leaderLine = mk(LEADER_N);

    // Classic float: red cap, white belly, a thin antenna
    this.bobber = new THREE.Group();
    const red = new THREE.MeshLambertMaterial({ color: 0xff3b30, emissive: 0x3a0705 });
    const white = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), red);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), white);
    belly.scale.y = 1.5;
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.12, 5), red);
    stick.position.y = 0.09;
    const keel = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.006, 0.07, 5), white);
    keel.position.y = -0.1;
    this.bobber.add(cap, belly, stick, keel);
    this.bobber.visible = false;
    scene.add(this.bobber);

    // Hook with a worm on it
    this.hook = new THREE.Group();
    const steel = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });
    const bend = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.003, 4, 10, Math.PI * 1.3), steel);
    bend.rotation.z = Math.PI * 0.85;
    bend.position.y = -0.03;
    const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.05, 4), steel);
    shank.position.set(0.018, -0.01, 0);
    const worm = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.045, 3, 6), new THREE.MeshLambertMaterial({ color: 0xd9777f }));
    worm.rotation.z = 0.6;
    worm.position.set(-0.008, -0.035, 0);
    this.hook.add(bend, shank, worm);
    this.hook.visible = false;
    scene.add(this.hook);
  }

  public set visible(v: boolean) {
    this.mainLine.visible = v;
    this.leaderLine.visible = v;
    this.bobber.visible = v;
    this.hook.visible = v;
  }

  /** Lays the line out straight from `tip` to `bobber`, the leader hanging below it. */
  public reset(tip: THREE.Vector3, bobber: THREE.Vector3, leaderLen: number): void {
    this.pull = 0;
    for (let i = 0; i <= MAIN_N; i++) {
      const t = i / MAIN_N;
      const k = i * 3;
      this.main[k] = this.mainPrev[k] = THREE.MathUtils.lerp(tip.x, bobber.x, t);
      this.main[k + 1] = this.mainPrev[k + 1] = THREE.MathUtils.lerp(tip.y, bobber.y, t);
      this.main[k + 2] = this.mainPrev[k + 2] = THREE.MathUtils.lerp(tip.z, bobber.z, t);
    }
    this.setLeaderLength(leaderLen);
    for (let i = 0; i <= LEADER_N; i++) {
      const k = i * 3;
      this.leader[k] = this.leaderPrev[k] = bobber.x;
      this.leader[k + 1] = this.leaderPrev[k + 1] = bobber.y - 0.02 - i * 0.02;
      this.leader[k + 2] = this.leaderPrev[k + 2] = bobber.z;
    }
    this.mainSeg = tip.distanceTo(bobber) / MAIN_N;
  }

  public setLength(total: number): void {
    this.mainSeg = Math.max(0.02, total / MAIN_N);
  }

  public setLeaderLength(len: number): void {
    this.leaderSeg = Math.max(0.01, len / LEADER_N);
  }

  /**
   * Steps the strings. The ends are pinned to the rod tip and the bobber; the hook is pinned to
   * `hookPin` while a fish holds it or it hangs out of the water, free otherwise. `bobberUp` is how
   * far the bobber's body sticks out of the water (the leader starts at its keel).
   */
  public update(dt: number, tip: THREE.Vector3, bobber: THREE.Vector3, hookPin: THREE.Vector3 | null, floating: boolean): void {
    const h = Math.min(dt, 1 / 30) / 2;
    for (let sub = 0; sub < 2; sub++) {
      // The main line is light and floats; the leader carries the hook and the bait and sinks fast
      this.integrate(this.main, this.mainPrev, MAIN_N, h, 9.8, 1.5, 0.86, true);
      this.integrate(this.leader, this.leaderPrev, LEADER_N, h, 9.8, 8.5, 0.95, false);
      for (let it = 0; it < ITER; it++) {
        this.pin(this.main, 0, tip);
        this.pin(this.main, MAIN_N, bobber);
        this.solve(this.main, MAIN_N, this.mainSeg);
        this.pin(this.leader, 0, bobber, -0.1);
        if (hookPin) this.pin(this.leader, LEADER_N, hookPin);
        this.solve(this.leader, LEADER_N, this.leaderSeg);
      }
      this.pin(this.main, 0, tip);
      this.pin(this.main, MAIN_N, bobber);
      this.pin(this.leader, 0, bobber, -0.1);
      if (hookPin) this.pin(this.leader, LEADER_N, hookPin);
    }

    // Draw
    (this.mainLine.geometry.getAttribute('position') as THREE.BufferAttribute).copyArray(this.main).needsUpdate = true;
    (this.leaderLine.geometry.getAttribute('position') as THREE.BufferAttribute).copyArray(this.leader).needsUpdate = true;
    this.bobber.position.copy(bobber);
    // The float leans a little towards the pull of the line, and lies down when out of the water
    const k = MAIN_N * 3;
    const lx = this.main[k - 3] - bobber.x;
    const lz = this.main[k - 1] - bobber.z;
    const len = Math.hypot(lx, lz) || 1;
    // Reeled (or towed by a fish) the line drags the float's top over and the leader holds its keel
    // back, so it tips towards the angler the harder it is pulled
    const lean = floating ? 0.18 + this.pull * 0.85 : 1.1;
    this.bobberTilt.setFromAxisAngle(_axis.set(lz / len, 0, -lx / len), lean);
    this.bobber.quaternion.slerp(this.bobberTilt, Math.min(1, dt * 8));

    const e = LEADER_N * 3;
    this.hookPos.set(this.leader[e], this.leader[e + 1], this.leader[e + 2]);
    this.hook.position.copy(this.hookPos);
    const ex = this.leader[e - 3] - this.hookPos.x;
    const ey = this.leader[e - 2] - this.hookPos.y;
    const ez = this.leader[e - 1] - this.hookPos.z;
    const el = Math.hypot(ex, ey, ez) || 1;
    this.hook.quaternion.setFromUnitVectors(UP, _axis.set(ex / el, ey / el, ez / el));
  }

  public dispose(): void {
    for (const o of [this.mainLine, this.leaderLine, this.bobber, this.hook]) this.scene.remove(o);
    this.mainLine.geometry.dispose();
    this.leaderLine.geometry.dispose();
  }

  // ------------------------------------------------------------------ Verlet

  private integrate(p: Float32Array, prev: Float32Array, n: number, h: number, g: number, gWater: number, dampWater: number, floats: boolean): void {
    for (let i = 1; i <= n; i++) {
      const k = i * 3;
      const x = p[k], y = p[k + 1], z = p[k + 2];
      const s = this.sample(x, z);
      const wet = s.level - s.ground > 0.02;
      const under = wet && y < s.level;
      // Water drags much more than air
      const damp = under ? dampWater : 0.985;
      const grav = under ? gWater : g;
      p[k] = x + (x - prev[k]) * damp;
      p[k + 1] = y + (y - prev[k + 1]) * damp - grav * h * h;
      p[k + 2] = z + (z - prev[k + 2]) * damp;
      prev[k] = x;
      prev[k + 1] = y;
      prev[k + 2] = z;
      // The main line floats on the surface; nothing goes into the ground
      if (floats && wet && p[k + 1] < s.level + 0.005) {
        p[k + 1] = s.level + 0.005;
        prev[k + 1] = p[k + 1];
      }
      const floor = s.ground + 0.02;
      if (p[k + 1] < floor) {
        p[k + 1] = floor;
        prev[k + 1] = floor;
      }
    }
  }

  private pin(p: Float32Array, i: number, at: THREE.Vector3, dy = 0): void {
    const k = i * 3;
    p[k] = at.x;
    p[k + 1] = at.y + dy;
    p[k + 2] = at.z;
  }

  /** String constraints: a segment longer than `rest` pulls its ends together; a shorter one sags. */
  private solve(p: Float32Array, n: number, rest: number): void {
    for (let i = 0; i < n; i++) {
      const a = i * 3, b = a + 3;
      const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d <= rest || d < 1e-6) continue;
      const diff = (d - rest) / d;
      // The pinned first node does not move
      const wa = i === 0 ? 0 : 0.5;
      const wb = i === 0 ? 1 : 0.5;
      p[a] += dx * diff * wa;
      p[a + 1] += dy * diff * wa;
      p[a + 2] += dz * diff * wa;
      p[b] -= dx * diff * wb;
      p[b + 1] -= dy * diff * wb;
      p[b + 2] -= dz * diff * wb;
    }
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const _axis = new THREE.Vector3();
