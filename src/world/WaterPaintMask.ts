import * as THREE from 'three';
import { WORLD_SIZE } from './WorldSettings';

const HALF = WORLD_SIZE / 2;

export class WaterPaintMask {
  /** One byte per cell, row z, column x (cell (0,0) at the world's -x, -z corner). */
  public readonly data: Uint8Array;
  private readonly cell: number;
  private readonly rowBounds: Int32Array | null;
  public readonly texture: THREE.DataTexture;
  /** Bumped on every change (save cache). */
  public revision = 0;
  private dirtyZ0 = Infinity;
  private dirtyZ1 = -1;
  private fullPending = false;
  /** A whole upload is waiting for the renderer (cleared once it has gone). */
  private wholeQueued = false;
  private saveCache: { revision: number; text: string | undefined } | null = null;

  /** min XZ, max XZ in metres, padded for linear filtering. Empty when min > max. */
  public readonly bounds = new THREE.Vector4(1, 1, 0, 0);

  constructor(private readonly resolution: number, trackBounds = false) {
    this.data = new Uint8Array(resolution * resolution);
    this.cell = WORLD_SIZE / resolution;
    this.rowBounds = trackBounds ? new Int32Array(resolution * 2).fill(-1) : null;
    const tex = new THREE.DataTexture(this.data, resolution, resolution, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    tex.onUpdate = () => {
      this.wholeQueued = false;
    };
    this.wholeQueued = true;
    this.texture = tex;
  }

  /** Any painted cells inside the world rectangle (x0, z0)-(x1, z1)? */
  public anyIn(x0: number, z0: number, x1: number, z1: number): boolean {
    const ix0 = Math.max(0, Math.floor((x0 + HALF) / this.cell));
    const iz0 = Math.max(0, Math.floor((z0 + HALF) / this.cell));
    const ix1 = Math.min(this.resolution - 1, Math.floor((x1 + HALF) / this.cell));
    const iz1 = Math.min(this.resolution - 1, Math.floor((z1 + HALF) / this.cell));
    for (let iz = iz0; iz <= iz1; iz++) {
      const row = iz * this.resolution;
      for (let ix = ix0; ix <= ix1; ix++) if (this.data[row + ix]) return true;
    }
    return false;
  }

  /** Density 0..1 at a world point (nearest cell). */
  public densityAt(x: number, z: number): number {
    const ix = Math.floor((x + HALF) / this.cell);
    const iz = Math.floor((z + HALF) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.resolution || iz >= this.resolution) return 0;
    return this.data[iz * this.resolution + ix] / 255;
  }

  /**
   * Brush: grows (or with erase, clears) the cover inside `radius` m with a soft edge; `rate` is
   * how much of a full carpet the centre gains per second.
   */
  public paint(x: number, z: number, radius: number, rate: number, dt: number, erase: boolean): void {
    const step = rate * dt * 255;
    const cx = (x + HALF) / this.cell - 0.5;
    const cz = (z + HALF) / this.cell - 0.5;
    const rc = radius / this.cell;
    const radiusSq = rc * rc;
    if (step <= 0 || radiusSq <= 0) return;
    // The outermost cells stay empty: the texture clamps to them outside the island
    const x0 = Math.max(1, Math.floor(cx - rc));
    const x1 = Math.min(this.resolution - 2, Math.ceil(cx + rc));
    const z0 = Math.max(1, Math.floor(cz - rc));
    const z1 = Math.min(this.resolution - 2, Math.ceil(cz + rc));
    if (x0 > x1 || z0 > z1) return;
    let changed = false;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const d2 = ((ix - cx) ** 2 + (iz - cz) ** 2) / radiusSq;
        if (d2 >= 1) continue;
        const k = 1 - d2;
        const w = k * k;
        const i = iz * this.resolution + ix;
        const old = this.data[i];
        const nv = erase ? Math.max(0, Math.floor(old - step * w * 1.5)) : Math.min(255, Math.ceil(old + step * w));
        if (nv !== old) {
          this.data[i] = nv;
          changed = true;
        }
      }
    }
    if (!changed) return;
    this.dirtyZ0 = Math.min(this.dirtyZ0, z0);
    this.dirtyZ1 = Math.max(this.dirtyZ1, z1);
    this.revision++;
    this.refreshBounds(z0, z1);
    this.upload();
  }

  public clear(): void {
    this.data.fill(0);
    this.markAll();
  }

  /** Copy of the cells (editor undo). */
  public snapshot(): Uint8Array {
    return this.data.slice();
  }

  public restore(cells: Uint8Array): void {
    this.data.set(cells);
    this.markAll();
  }

  /** Base64 RLE of the cells, undefined for an empty mask. */
  public serialize(): string | undefined {
    if (this.saveCache?.revision === this.revision) return this.saveCache.text;
    let text: string | undefined;
    if (this.rowBounds ? this.bounds.x <= this.bounds.z : this.data.some((v) => v !== 0)) {
      // Runs of (value byte, count u16 little endian)
      const out: number[] = [];
      let i = 0;
      while (i < this.data.length) {
        const v = this.data[i];
        let n = 1;
        while (i + n < this.data.length && this.data[i + n] === v && n < 65535) n++;
        out.push(v, n & 255, n >> 8);
        i += n;
      }
      const bytes = new Uint8Array(out);
      let s = '';
      for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
      text = btoa(s);
    }
    this.saveCache = { revision: this.revision, text };
    return text;
  }

  /** From a save. Missing data clears the mask. */
  public deserialize(text: string | undefined): void {
    this.data.fill(0);
    if (text) {
      try {
        const s = atob(text);
        let k = 0;
        for (let i = 0; i + 2 < s.length && k < this.data.length; i += 3) {
          const n = s.charCodeAt(i + 1) | (s.charCodeAt(i + 2) << 8);
          this.data.fill(s.charCodeAt(i), k, Math.min(this.data.length, k + n));
          k += n;
        }
      } catch {
        this.data.fill(0);
      }
    }
    this.markAll();
  }

  /** Same bilinear interpolation and cell centres as the GPU texture. */
  public sample(x: number, z: number): number {
    const { x: minX, y: minZ, z: maxX, w: maxZ } = this.bounds;
    if (x < minX || x > maxX || z < minZ || z > maxZ) return 0;
    const limit = this.resolution - 1;
    const gx = THREE.MathUtils.clamp((x + HALF) / this.cell - 0.5, 0, limit);
    const gz = THREE.MathUtils.clamp((z + HALF) / this.cell - 0.5, 0, limit);
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const nextX = Math.min(limit, ix + 1), nextZ = Math.min(limit, iz + 1);
    const row = iz * this.resolution, nextRow = nextZ * this.resolution;
    const top = THREE.MathUtils.lerp(this.data[row + ix], this.data[row + nextX], gx - ix);
    const bottom = THREE.MathUtils.lerp(this.data[nextRow + ix], this.data[nextRow + nextX], gx - ix);
    return THREE.MathUtils.lerp(top, bottom, gz - iz) / 255;
  }

  private refreshBounds(z0: number, z1: number): void {
    const rows = this.rowBounds;
    if (!rows) return;
    const size = this.resolution;
    for (let z = z0; z <= z1; z++) {
      const start = z * size;
      let left = 0;
      while (left < size && !this.data[start + left]) left++;
      let right = size - 1;
      while (right > left && !this.data[start + right]) right--;
      rows[z * 2] = left < size ? left : -1;
      rows[z * 2 + 1] = right;
    }
    let minX = size, minZ = size, maxX = -1, maxZ = -1;
    for (let z = 0; z < size; z++) {
      const left = rows[z * 2];
      if (left < 0) continue;
      minX = Math.min(minX, left);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, rows[z * 2 + 1]);
      maxZ = z;
    }
    this.bounds.set((minX - 0.5) * this.cell - HALF, (minZ - 0.5) * this.cell - HALF,
      (maxX + 1.5) * this.cell - HALF, (maxZ + 1.5) * this.cell - HALF);
  }

  private markAll(): void {
    this.refreshBounds(0, this.resolution - 1);
    this.fullPending = true;
    this.revision++;
    this.upload();
  }

  /**
   * Only the touched rows go to the GPU (one range per row: three.js uploads each range as a
   * single row); a load or undo goes whole. Ranges pile up until the next upload, and a whole
   * upload still waiting wins over rows added after it.
   */
  private upload(): void {
    const tex = this.texture;
    if (this.fullPending || this.wholeQueued) {
      tex.clearUpdateRanges();
      this.wholeQueued = true;
    } else if (this.dirtyZ1 >= this.dirtyZ0) {
      // three.js reads texture update ranges with a stride of 4 components even for R8 (see
      // TerrainSystem.uploadSplat): give them x4 so they map back to texels
      for (let z = this.dirtyZ0; z <= this.dirtyZ1; z++) tex.addUpdateRange(z * this.resolution * 4, this.resolution * 4);
    }
    this.fullPending = false;
    this.dirtyZ0 = Infinity;
    this.dirtyZ1 = -1;
    tex.needsUpdate = true;
  }
}

