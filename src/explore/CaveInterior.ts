import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { valueNoise } from '../world/IslandGenerator';

/** A point on the cave's centre line: floor height, tunnel radius and what fills the spot. */
interface CaveNode {
  x: number;
  floor: number;
  z: number;
  r: number;
  role: 'entrance' | 'tunnel' | 'chamber' | 'ore' | 'grotto' | 'treasure';
}

/** Gameplay anchors inside a generated cave, in world space. */
export interface CaveLayout {
  /** Where the player appears, and the lit way out behind them. */
  spawn: THREE.Vector3;
  spawnYaw: number;
  exit: THREE.Vector3;
  chest: { pos: THREE.Vector3; yaw: number };
  ores: { pos: THREE.Vector3; kind: 'iron' | 'gold' | 'crystal' }[];
  mushrooms: THREE.Vector3[];
  crystals: { pos: THREE.Vector3; color: THREE.Color }[];
  torches: THREE.Vector3[];
}

const CELL = 0.7;

/**
 * Procedural cave built once, the first time the player walks in (Valheim-style: the inside lives
 * in its own pocket of the world, far above the sea, and the doorway teleports).
 *
 * The rock is a signed distance field: tunnels are tapered capsules between centre-line nodes with
 * flat floors, chambers are wide nodes, and value noise roughens the walls. Surface Nets turns the
 * field into a smooth indexed mesh (no lookup tables), which doubles as the trimesh collider.
 */
export class CaveInterior {
  public readonly group = new THREE.Group();
  public readonly layout: CaveLayout;
  private readonly nodes: CaveNode[] = [];
  private readonly segments: [CaveNode, CaveNode][] = [];
  private rnd: () => number;

  constructor(
    public readonly id: string,
    private readonly origin: THREE.Vector3,
    seed: number,
    scene: THREE.Scene,
    physics: PhysicsWorld
  ) {
    let s = seed * 7919 + 13;
    this.rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    this.group.name = `Cave_${id}`;
    this.planLayout();
    const geo = this.buildMesh();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.position.copy(origin);
    this.group.add(mesh);
    scene.add(this.group);

    const pos = geo.attributes.position.array as Float32Array;
    physics.createStaticTrimesh(origin, pos, geo.index!.array as Uint32Array);
    this.layout = this.placeContents();
  }

  // ---------------------------------------------------------------- layout

  private planLayout(): void {
    const r = this.rnd;
    const N = (x: number, floor: number, z: number, rad: number, role: CaveNode['role']): CaveNode => {
      const n = { x, floor, z, r: rad, role };
      this.nodes.push(n);
      return n;
    };
    const side = r() < 0.5 ? 1 : -1;
    const n0 = N(0, 0, 0, 2.6, 'entrance');
    const n1 = N((r() - 0.5) * 5, -0.8, 11, 2.9, 'tunnel');
    const n2 = N((r() - 0.5) * 8, -2.4, 23, 6.5, 'chamber');
    const n3 = N(n2.x + side * (3 + r() * 3), -3.2, 35, 3.0, 'tunnel');
    const n4 = N(n3.x - side * (2 + r() * 3), -4.6, 46, 3.3, 'tunnel');
    const n5 = N(n4.x + (r() - 0.5) * 6, -5.4, 59, 7.5, 'treasure');
    const b1 = N(n2.x - side * 15, -1.6, n2.z + 5, 4.2, 'ore');
    const b2 = N(n4.x - side * 13, -5.2, n4.z + 3, 4.0, 'grotto');
    this.segments.push([n0, n1], [n1, n2], [n2, n3], [n3, n4], [n4, n5], [n2, b1], [n4, b2]);
  }

  /** Signed distance to rock (negative = open air), in cave-local metres. */
  private field(x: number, y: number, z: number): number {
    let best = Infinity;
    for (const [a, b] of this.segments) {
      // Tunnel axis runs at a third of the radius above the floor, so ceilings are high and floors flat
      const ax = a.x, ay = a.floor + a.r * 0.45, az = a.z;
      const bx = b.x, by = b.floor + b.r * 0.45, bz = b.z;
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const len2 = dx * dx + dy * dy + dz * dz;
      let t = ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t - x, py = ay + dy * t - y, pz = az + dz * t - z;
      // Wide chambers bulge at their node instead of tapering linearly along the whole segment
      const ra = a.r, rb = b.r;
      const rad = t < 0.5 ? ra + (Math.min(ra, rb) - ra) * Math.min(1, t * 3) : rb + (Math.min(ra, rb) - rb) * Math.min(1, (1 - t) * 3);
      // Flatten the vertical axis a little: caves are wider than they are tall
      const cap = Math.sqrt(px * px + py * py * 1.35 + pz * pz) - rad;
      const floorY = a.floor + (b.floor - a.floor) * t;
      const d = Math.max(cap, floorY - y);
      if (d < best) best = d;
    }
    const wall = valueNoise(x * 0.35 + 11, z * 0.35 + y * 0.6) * 0.7 + valueNoise(x * 0.9 - y * 0.7, z * 0.9 + 5) * 0.25;
    return best + wall;
  }

  // ---------------------------------------------------------------- meshing

  private buildMesh(): THREE.BufferGeometry {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x - n.r - 3);
      maxX = Math.max(maxX, n.x + n.r + 3);
      minY = Math.min(minY, n.floor - 3);
      maxY = Math.max(maxY, n.floor + n.r * 1.6 + 3);
      minZ = Math.min(minZ, n.z - n.r - 3);
      maxZ = Math.max(maxZ, n.z + n.r + 3);
    }
    const nx = Math.ceil((maxX - minX) / CELL) + 1;
    const ny = Math.ceil((maxY - minY) / CELL) + 1;
    const nz = Math.ceil((maxZ - minZ) / CELL) + 1;
    const idx = (i: number, j: number, k: number) => (k * ny + j) * nx + i;

    const f = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          // The grid border is always rock so the mesh is closed
          const border = i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1;
          f[idx(i, j, k)] = border ? 1 : this.field(minX + i * CELL, minY + j * CELL, minZ + k * CELL);
        }
      }
    }

    // Surface Nets: one vertex per sign-changing cell, at the mean of its edge crossings
    const cellVert = new Int32Array(nx * ny * nz).fill(-1);
    const positions: number[] = [];
    const corners = [
      [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
      [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
    ];
    const edges = [
      [0, 1], [2, 3], [4, 5], [6, 7],
      [0, 2], [1, 3], [4, 6], [5, 7],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const v = new Float32Array(8);
    for (let k = 0; k < nz - 1; k++) {
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          let mask = 0;
          for (let c = 0; c < 8; c++) {
            v[c] = f[idx(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
            if (v[c] < 0) mask |= 1 << c;
          }
          if (mask === 0 || mask === 255) continue;
          let sx = 0, sy = 0, sz = 0, n = 0;
          for (const [a, b] of edges) {
            if (v[a] < 0 === v[b] < 0) continue;
            const t = v[a] / (v[a] - v[b]);
            sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
            sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
            sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
            n++;
          }
          cellVert[idx(i, j, k)] = positions.length / 3;
          positions.push(minX + (i + sx / n) * CELL, minY + (j + sy / n) * CELL, minZ + (k + sz / n) * CELL);
        }
      }
    }

    // One quad per sign-changing grid edge, joining the four cells around it, facing the air
    const indices: number[] = [];
    const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      if (flip) indices.push(a, b, c, a, c, d);
      else indices.push(a, c, b, a, d, c);
    };
    for (let k = 1; k < nz - 1; k++) {
      for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const f0 = f[idx(i, j, k)];
          const inside = f0 < 0;
          if (inside !== f[idx(i + 1, j, k)] < 0) {
            quad(cellVert[idx(i, j - 1, k - 1)], cellVert[idx(i, j, k - 1)], cellVert[idx(i, j, k)], cellVert[idx(i, j - 1, k)], !inside);
          }
          if (inside !== f[idx(i, j + 1, k)] < 0) {
            quad(cellVert[idx(i - 1, j, k - 1)], cellVert[idx(i - 1, j, k)], cellVert[idx(i, j, k)], cellVert[idx(i, j, k - 1)], !inside);
          }
          if (inside !== f[idx(i, j, k + 1)] < 0) {
            quad(cellVert[idx(i - 1, j - 1, k)], cellVert[idx(i, j - 1, k)], cellVert[idx(i, j, k)], cellVert[idx(i - 1, j, k)], !inside);
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
    geo.computeVertexNormals();

    // Colour: earthy floors, cool grey walls, mineral streaks
    const nrm = geo.attributes.normal;
    const col = new Float32Array(positions.length);
    const c = new THREE.Color();
    const floorC = new THREE.Color(0x6b5a48), wallC = new THREE.Color(0x5a5f68), streak = new THREE.Color(0x8a6a50);
    for (let p = 0; p < positions.length / 3; p++) {
      const x = positions[p * 3], y = positions[p * 3 + 1], z = positions[p * 3 + 2];
      const up = nrm.getY(p);
      c.copy(wallC).lerp(floorC, THREE.MathUtils.smoothstep(up, 0.4, 0.85));
      const band = valueNoise(x * 0.15 + y * 0.9, z * 0.15) * 0.5 + 0.5;
      if (band > 0.72) c.lerp(streak, (band - 0.72) * 2.5);
      c.multiplyScalar(0.8 + valueNoise(x * 1.7, z * 1.7 + y) * 0.15);
      col[p * 3] = c.r;
      col[p * 3 + 1] = c.g;
      col[p * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    return geo;
  }

  // ---------------------------------------------------------------- contents

  /** Highest open-air point above the floor near (x, z), scanning the analytic field downward. */
  private floorAt(x: number, z: number, fromY: number): number | null {
    for (let y = fromY; y > fromY - 12; y -= 0.1) {
      if (this.field(x, y, z) > 0) return this.field(x, y + 0.1, z) < 0 ? y + 0.1 : null;
    }
    return null;
  }

  private toWorld(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, z).add(this.origin);
  }

  /** A floor spot `dist` from a node centre in direction `a`, or null when it hits a wall. */
  private spot(n: CaveNode, a: number, dist: number, clearance = 1.5): THREE.Vector3 | null {
    const x = n.x + Math.cos(a) * dist;
    const z = n.z + Math.sin(a) * dist;
    const y = this.floorAt(x, z, n.floor + 2.5);
    if (y === null || this.field(x, y + clearance, z) > -0.2) return null;
    return this.toWorld(x, y, z);
  }

  private placeContents(): CaveLayout {
    const r = this.rnd;
    const byRole = (role: CaveNode['role']) => this.nodes.filter((n) => n.role === role);
    const entrance = byRole('entrance')[0];
    const ores: CaveLayout['ores'] = [];
    const mushrooms: THREE.Vector3[] = [];
    const crystals: CaveLayout['crystals'] = [];
    const torches: THREE.Vector3[] = [];

    const ring = (n: CaveNode, count: number, frac: number, each: (p: THREE.Vector3, i: number) => void) => {
      let placed = 0;
      for (let i = 0; i < count * 4 && placed < count; i++) {
        const p = this.spot(n, r() * Math.PI * 2, n.r * (frac + r() * 0.25));
        if (p) each(p, placed++);
      }
    };

    const blue = new THREE.Color(0.35, 0.6, 1.0), violet = new THREE.Color(0.7, 0.4, 1.0), teal = new THREE.Color(0.3, 0.95, 0.8);
    for (const n of byRole('chamber')) {
      ring(n, 3, 0.45, (p, i) => ores.push({ pos: p, kind: i === 0 && r() < 0.6 ? 'gold' : 'iron' }));
      ring(n, 3, 0.55, (p, i) => crystals.push({ pos: p, color: i % 2 ? violet : blue }));
    }
    for (const n of byRole('ore')) {
      ring(n, 4, 0.3, (p, i) => ores.push({ pos: p, kind: i === 0 ? 'gold' : i === 1 ? 'crystal' : 'iron' }));
      ring(n, 2, 0.6, (p) => crystals.push({ pos: p, color: blue }));
    }
    for (const n of byRole('grotto')) {
      ring(n, 7, 0.2, (p) => mushrooms.push(p));
      ring(n, 2, 0.5, (p) => crystals.push({ pos: p, color: teal }));
    }
    for (const n of byRole('tunnel')) ring(n, 1, 0.2, (p) => (r() < 0.5 ? mushrooms.push(p) : crystals.push({ pos: p, color: teal })));
    const t = byRole('treasure')[0];
    ring(t, 2, 0.55, (p) => ores.push({ pos: p, kind: 'crystal' }));
    ring(t, 4, 0.6, (p, i) => crystals.push({ pos: p, color: i % 2 ? violet : blue }));

    // Torches just inside the entrance
    for (const sx of [-1.6, 1.6]) {
      const p = this.spot(entrance, Math.atan2(2, sx), Math.hypot(sx, 2), 1.2);
      if (p) torches.push(p);
    }

    // The chest stands at the far side of the treasure chamber, facing back the way you came
    const chestPos = this.spot(t, Math.PI / 2, t.r * 0.35) ?? this.toWorld(t.x, this.floorAt(t.x, t.z, t.floor + 2) ?? t.floor, t.z);
    const spawnY = this.floorAt(entrance.x, entrance.z + 1.5, entrance.floor + 2) ?? entrance.floor;
    const exitY = this.floorAt(entrance.x, entrance.z - 1.2, entrance.floor + 2) ?? entrance.floor;
    return {
      spawn: this.toWorld(entrance.x, spawnY, entrance.z + 1.5),
      spawnYaw: 0,
      exit: this.toWorld(entrance.x, exitY, entrance.z - 1.2),
      chest: { pos: chestPos, yaw: Math.PI },
      ores,
      mushrooms,
      crystals,
      torches,
    };
  }
}
