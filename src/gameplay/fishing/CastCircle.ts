import * as THREE from 'three';
import type { WaterSampler } from './FishingFish';

const SEG = 64;
/** Water shallower than this does not count (the bobber would sit on the bottom). */
export const MIN_CAST_DEPTH = 0.3;

/**
 * The aiming circle on the water: where the bobber may land. Along every direction from the
 * centre it reaches only as far as the water does, so the shape hugs the shore and never covers
 * land. A soft fill plus a bright rim ribbon, laid on the water surface.
 */
export class CastCircle {
  public readonly center = new THREE.Vector3();
  public radius = 1;
  /** Reach of the water along each of the SEG directions (m). */
  private readonly reach = new Float32Array(SEG);
  private readonly fill: THREE.Mesh;
  private readonly rim: THREE.Mesh;
  private readonly fillPos: THREE.BufferAttribute;
  private readonly rimPos: THREE.BufferAttribute;
  private readonly fillMat: THREE.MeshBasicMaterial;
  private readonly rimMat: THREE.MeshBasicMaterial;

  constructor(private readonly scene: THREE.Scene, private readonly sample: WaterSampler) {
    // Fill: a fan around the centre
    const fg = new THREE.BufferGeometry();
    this.fillPos = new THREE.BufferAttribute(new Float32Array((SEG + 1) * 3), 3);
    fg.setAttribute('position', this.fillPos);
    const fi: number[] = [];
    for (let i = 0; i < SEG; i++) fi.push(0, 1 + ((i + 1) % SEG), 1 + i);
    fg.setIndex(fi);
    this.fillMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
    this.fill = new THREE.Mesh(fg, this.fillMat);

    // Rim: a strip SEG*2 vertices (inner / outer edge)
    const rg = new THREE.BufferGeometry();
    this.rimPos = new THREE.BufferAttribute(new Float32Array(SEG * 2 * 3), 3);
    rg.setAttribute('position', this.rimPos);
    const ri: number[] = [];
    for (let i = 0; i < SEG; i++) {
      const a = i * 2, b = ((i + 1) % SEG) * 2;
      ri.push(a, b, a + 1, b, b + 1, a + 1);
    }
    rg.setIndex(ri);
    this.rimMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide });
    this.rim = new THREE.Mesh(rg, this.rimMat);

    for (const mat of [this.fillMat, this.rimMat]) {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -4;
      mat.polygonOffsetUnits = -16;
    }
    for (const m of [this.fill, this.rim]) {
      m.frustumCulled = false;
      m.renderOrder = 5;
      m.visible = false;
      scene.add(m);
    }
  }

  public set visible(v: boolean) {
    this.fill.visible = v;
    this.rim.visible = v;
  }

  private wet(x: number, z: number): boolean {
    const s = this.sample(x, z);
    return s.level - s.ground > MIN_CAST_DEPTH;
  }

  /**
   * Puts the circle `dist` m from `from` along `dir` (shortened back to the nearest water when
   * that point is dry) and clips it to the water. False when there is no water that way.
   */
  public place(from: THREE.Vector3, dir: THREE.Vector3, dist: number, radius: number, minDist: number): boolean {
    let d = dist;
    for (; d >= minDist; d -= 0.4) {
      if (this.wet(from.x + dir.x * d, from.z + dir.z * d)) break;
    }
    if (d < minDist) return false;
    this.center.set(from.x + dir.x * d, 0, from.z + dir.z * d);
    this.center.y = this.sample(this.center.x, this.center.z).level;
    this.radius = radius;
    const steps = 10;
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      let r = 0;
      for (let s = 1; s <= steps; s++) {
        const rr = (s / steps) * radius;
        if (!this.wet(this.center.x + cx * rr, this.center.z + cz * rr)) break;
        r = rr;
      }
      this.reach[i] = r;
    }
    return true;
  }

  /** Redraws the shape (call after place; `pulse` animates the rim). */
  public draw(time: number): void {
    const c = this.center;
    // Above the wave crests of the water shader (its surface is displaced, opaque and writes depth)
    const lift = 0.12;
    this.fillPos.setXYZ(0, c.x, c.y + lift, c.z);
    const w = 0.14 + this.radius * 0.035 + 0.03 * Math.sin(time * 6);
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      const r = Math.max(0.05, this.reach[i]);
      const x = c.x + cx * r, z = c.z + cz * r;
      const y = this.sample(x, z).level + lift;
      this.fillPos.setXYZ(1 + i, x, y, z);
      const ri = Math.max(0, r - w);
      this.rimPos.setXYZ(i * 2, c.x + cx * ri, y, c.z + cz * ri);
      this.rimPos.setXYZ(i * 2 + 1, x, y, z);
    }
    this.fillPos.needsUpdate = true;
    this.rimPos.needsUpdate = true;
    this.rimMat.opacity = 0.8 + 0.15 * Math.sin(time * 6);
  }

  /** A random landing point inside the (clipped) circle. */
  public randomPoint(out: THREE.Vector3): THREE.Vector3 {
    for (let a = 0; a < 12; a++) {
      const i = Math.floor(Math.random() * SEG);
      const ang = (i / SEG) * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * this.reach[i] * 0.95;
      out.set(this.center.x + Math.cos(ang) * r, 0, this.center.z + Math.sin(ang) * r);
      if (this.wet(out.x, out.z)) {
        out.y = this.sample(out.x, out.z).level;
        return out;
      }
    }
    return out.copy(this.center);
  }

  public dispose(): void {
    this.scene.remove(this.fill, this.rim);
    this.fill.geometry.dispose();
    this.rim.geometry.dispose();
    this.fillMat.dispose();
    this.rimMat.dispose();
  }
}
