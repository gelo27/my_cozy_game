import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type NuggetMetal = 'gold' | 'silver';

export interface CaveNuggetSave {
  x: number;
  y: number;
  z: number;
  normal: [number, number, number];
  metal: NuggetMetal;
  collected: boolean;
}

interface Nugget {
  save: CaveNuggetSave;
  cut: THREE.Vector3;
  inward: THREE.Vector3;
  surface: THREE.Vector3 | null;
  normal: THREE.Vector3;
  resolved: boolean;
}

const CELL = 3;
const VIEW_DISTANCE = 24;
const MAX_CLUSTERS = 24;
const PIECES = [[0, 0, 0.76, -0.45], [-0.36, 0.16, 0.46, 0.9], [0.37, -0.22, 0.51, 0.36]] as const;
const SURFACE_OFFSET = 0.12;
const TARGET_RADIUS = 0.73;
const COLORS = { gold: new THREE.Color(0xffac28), silver: new THREE.Color(0xcbdcf5) };
const FRONT = new THREE.Vector3(0, 0, 1);

function createNuggetGeometry(): THREE.BufferGeometry {
  const sphere = new THREE.IcosahedronGeometry(1, 3);
  sphere.deleteAttribute('normal');
  sphere.deleteAttribute('uv');
  const geometry = mergeVertices(sphere);
  sphere.dispose();
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const broad = Math.sin(3.7 * x + 1.8 * y) * Math.cos(3.4 * z - 1.7 * y);
    const dents = Math.sin(8 * x + 3 * z) * Math.cos(7 * y - 4 * z);
    const radius = 0.5 + broad * 0.078 + dents * 0.016;
    position.setXYZ(i, (x + 0.13 * y * y) * radius, y * radius * 0.82, z * radius);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Neutral metal reflections in view space. RGB holds the shading, alpha the white highlights. */
function createNuggetMatcap(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const x = (col + 0.5) * 2 / size - 1;
      const y = (row + 0.5) * 2 / size - 1;
      const radius = Math.min(1, Math.hypot(x, y));
      const z = Math.sqrt(1 - radius * radius);
      const sky = THREE.MathUtils.smoothstep(y + 0.21 * x + 0.18 * z, -0.14, 0.17);
      const bounce = THREE.MathUtils.smoothstep(-y - 0.2 * x, 0.18, 0.95);
      const rim = THREE.MathUtils.smoothstep(radius, 0.83, 1) * (0.45 + 0.55 * sky);
      const key = Math.max(0, -0.42 * x + 0.65 * y + 0.63 * z);
      const fill = Math.max(0, 0.76 * x - 0.27 * y + 0.59 * z);
      const value = Math.min(1, 0.085 + 0.40 * sky + 0.19 * bounce + 0.30 * rim + key ** 8 * 0.18);
      const highlight = Math.min(1, key ** 42 * 0.9 + fill ** 30 * 0.45 + rim * 0.16);
      const index = (row * size + col) * 4;
      data[index] = data[index + 1] = data[index + 2] = Math.round(value * 255);
      data[index + 3] = Math.round(highlight * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function cellKey(x: number, y: number, z: number): string {
  return `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
}

/** Stable deposits in rock-space cells, revealed when the pickaxe first opens one. */
export function caveNuggetMetal(seed: number, x: number, y: number, z: number): NuggetMetal | null {
  let hash = Math.imul(Math.floor(x / CELL), 0x1b873593)
    ^ Math.imul(Math.floor(y / CELL), 0x9e3779b1)
    ^ Math.imul(Math.floor(z / CELL), 0x85ebca77) ^ seed;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  const roll = ((hash ^ (hash >>> 16)) >>> 0) / 0x100000000;
  return roll < 0.10 ? 'gold' : roll < 0.31 ? 'silver' : null;
}

export class CaveNuggets {
  private readonly records = new Map<string, Nugget>();
  private readonly visible: Nugget[] = [];
  private readonly transform = new THREE.Object3D();
  private readonly targetOffset = new THREE.Vector3();
  private readonly time = { value: 0 };
  private mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshMatcapMaterial> | null = null;
  private dirty = true;

  constructor(private readonly group: THREE.Group, private readonly seed: number) {}

  private insert(save: CaveNuggetSave): void {
    const { x, y, z } = save;
    this.records.set(cellKey(x, y, z), {
      save, cut: new THREE.Vector3(x, y, z), inward: new THREE.Vector3().fromArray(save.normal).normalize().negate(),
      surface: null, normal: new THREE.Vector3(), resolved: false,
    });
  }

  public discover(cut: THREE.Vector3, normal: THREE.Vector3): void {
    const { x, y, z } = cut;
    const metal = caveNuggetMetal(this.seed, x, y, z);
    if (!metal || this.records.has(cellKey(x, y, z))) return;
    this.insert({ x, y, z, normal: normal.toArray(), metal, collected: false });
    this.dirty = true;
  }

  public serialize(): CaveNuggetSave[] {
    return [...this.records.values()].map(n => ({ ...n.save, normal: [...n.save.normal] }));
  }

  public restore(data: CaveNuggetSave[]): void {
    this.records.clear();
    this.visible.length = 0;
    if (this.mesh) this.mesh.count = 0;
    for (const save of data) this.insert({ ...save, normal: [...save.normal] });
    this.dirty = true;
  }

  public invalidateSurfaces(): void {
    for (const nugget of this.records.values()) nugget.resolved = false;
    this.dirty = true;
  }

  public target(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) {
    let distance = maxDistance;
    let target: Nugget | null = null;
    for (const nugget of this.visible) {
      if (nugget.save.collected || !nugget.surface) continue;
      const offset = this.targetOffset.copy(nugget.surface).sub(origin).addScaledVector(nugget.normal, SURFACE_OFFSET);
      if (offset.dot(nugget.normal) >= 0) continue;
      const alongRay = offset.dot(direction);
      const halfChordSquared = TARGET_RADIUS ** 2 - (offset.lengthSq() - alongRay ** 2);
      if (halfChordSquared < 0) continue;
      const halfChord = Math.sqrt(halfChordSquared);
      const entry = Math.max(0, alongRay - halfChord);
      if (alongRay + halfChord < 0 || entry > distance) continue;
      distance = entry;
      target = nugget;
    }
    return target && target.surface && {
      id: cellKey(target.save.x, target.save.y, target.save.z), metal: target.save.metal,
      position: target.surface.clone().addScaledVector(target.normal, SURFACE_OFFSET), normal: target.normal.clone(),
    };
  }

  public collect(id: string): boolean {
    const nugget = this.records.get(id);
    if (!nugget || nugget.save.collected) return false;
    nugget.save.collected = true;
    this.dirty = true;
    return true;
  }

  public updateClock(time: number): void { this.time.value = time; }

  public refresh(
    player: THREE.Vector3,
    resolve: (cut: THREE.Vector3, direction: THREE.Vector3) => { position: THREE.Vector3; normal: THREE.Vector3 } | null,
  ): void {
    const nearby: Nugget[] = [];
    let queriesLeft = 8;
    let changed = this.dirty;
    for (const nugget of this.records.values()) {
      if (nugget.save.collected || nugget.cut.distanceToSquared(player) > VIEW_DISTANCE ** 2) continue;
      if (!nugget.resolved && queriesLeft > 0) {
        queriesLeft--;
        const hit = resolve(nugget.cut, nugget.inward);
        nugget.resolved = true;
        nugget.surface = hit?.position ?? null;
        if (hit) nugget.normal.copy(hit.normal);
        changed = true;
      }
      if (nugget.surface) nearby.push(nugget);
    }
    if (nearby.length > MAX_CLUSTERS) {
      nearby.sort((a, b) => a.cut.distanceToSquared(player) - b.cut.distanceToSquared(player));
      nearby.length = MAX_CLUSTERS;
    }
    if (!changed && nearby.length === this.visible.length && nearby.every((n, i) => n === this.visible[i])) return;
    this.visible.length = 0;
    this.visible.push(...nearby);
    this.dirty = false;
    if (nearby.length) this.mesh ??= this.createMesh();
    const mesh = this.mesh;
    if (!mesh) return;
    let index = 0;
    for (const nugget of nearby) {
      const tr = this.transform;
      for (const [x, y, size, angle] of PIECES) {
        tr.quaternion.setFromUnitVectors(FRONT, nugget.normal);
        tr.position.set(x, y, SURFACE_OFFSET).applyQuaternion(tr.quaternion).add(nugget.surface!);
        tr.rotateZ(angle);
        tr.scale.set(size, size, size * 0.75);
        tr.updateMatrix();
        mesh.setMatrixAt(index, tr.matrix);
        mesh.setColorAt(index++, COLORS[nugget.save.metal]);
      }
    }
    mesh.count = index;
    mesh.visible = index > 0;
    if (!index) return;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
  }

  private createMesh(): THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshMatcapMaterial> {
    const material = new THREE.MeshMatcapMaterial({ matcap: createNuggetMatcap() });
    material.onBeforeCompile = shader => {
      shader.uniforms.uNuggetTime = this.time;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNuggetTime;')
        .replace('vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;', `
          float shimmer = 0.88 + 0.12 * sin(uNuggetTime * 2.2 + uv.x * 7.0);
          vec3 outgoingLight = diffuseColor.rgb * (matcapColor.rgb + 0.045)
                             + mix(diffuseColor.rgb, vec3(1.0), 0.65) * matcapColor.a * shimmer;`);
    };
    const mesh = new THREE.InstancedMesh(createNuggetGeometry(), material, MAX_CLUSTERS * PIECES.length);
    mesh.name = 'CaveNuggets';
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(mesh);
    return mesh;
  }

  public dispose(): void {
    this.mesh?.removeFromParent();
    this.mesh?.dispose();
    this.mesh?.geometry.dispose();
    this.mesh?.material.matcap?.dispose();
    this.mesh?.material.dispose();
  }
}
