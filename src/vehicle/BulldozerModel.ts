import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createGlassMaterial } from '../scene/GlassMatcap';
import { mergeColoredChildren } from '../scene/MergeColored';
import { createPromptSprite } from './VehicleModel';

export const DOZER_TRACK_X = 0.96;
export const DOZER_TRACK_RADIUS = 0.43;
export const DOZER_TRACK_Y = 0.46;
export const DOZER_TRACK_END = 0.96;
export const DOZER_BLADE_HALF_WIDTH = 1.85;
export const DOZER_BLADE_Z = 1.92;
const TREAD_REPEAT = Math.round((4 * DOZER_TRACK_END + 2 * Math.PI * DOZER_TRACK_RADIUS) / 0.27);
const REPEATS_PER_METRE = TREAD_REPEAT / (4 * DOZER_TRACK_END + 2 * Math.PI * DOZER_TRACK_RADIUS);

/** A closed belt with one UV seam, continuous distance along the tread and solid sidewalls. */
export function makeDozerBelt(): THREE.BufferGeometry {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const steps = 12;
  const ring = 8;
  const width = 0.52;
  for (let side = 0; side < 2; side++) {
    for (let step = 0; step <= steps; step++) {
      const a = (side - 0.5 + step / steps) * Math.PI;
      const y = Math.sin(a), z = Math.cos(a);
      const end = side === 0 ? DOZER_TRACK_END : -DOZER_TRACK_END;
      const u = (step / steps * Math.PI * DOZER_TRACK_RADIUS +
        side * (Math.PI * DOZER_TRACK_RADIUS + 2 * DOZER_TRACK_END)) * REPEATS_PER_METRE;
      const vertex = (x: number, radius: number, v: number) => {
        positions.push(x, DOZER_TRACK_Y + y * radius, end + z * radius);
        uvs.push(u, v);
      };
      const r = DOZER_TRACK_RADIUS;
      vertex(-width / 2, r, 0.18); vertex(width / 2, r, 0.82);
      vertex(width / 2, r, 0.96); vertex(width / 2, r - 0.085, 0.96);
      vertex(width / 2, r - 0.085, 0.96); vertex(-width / 2, r - 0.085, 0.96);
      vertex(-width / 2, r - 0.085, 0.96); vertex(-width / 2, r, 0.96);
    }
  }
  // Duplicate the front-bottom cross-section for the bottom straight and the UV wrap.
  positions.push(...positions.slice(0, ring * 3));
  for (let i = 0; i < ring; i++) uvs.push(TREAD_REPEAT, uvs[i * 2 + 1]);
  for (let start = 0; start < positions.length / 3 - ring; start += ring) {
    for (let i = start; i < start + ring; i += 2) {
      indices.push(i, i + 1, i + ring, i + 1, i + ring + 1, i + ring);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  // The first and last vertices occupy the same point but have different U coordinates.
  const normals = geo.getAttribute('normal');
  const normal = new THREE.Vector3();
  for (let i = 0; i < ring; i++) {
    const j = normals.count - ring + i;
    normal.set(normals.getX(i) + normals.getX(j), normals.getY(i) + normals.getY(j),
      normals.getZ(i) + normals.getZ(j)).normalize();
    normals.setXYZ(i, normal.x, normal.y, normal.z);
    normals.setXYZ(j, normal.x, normal.y, normal.z);
  }
  return geo;
}

function treadTexture(): THREE.DataTexture {
  const width = 32, height = 32;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const shoulder = y < 8 || y > 23;
      const phase = (x + Math.abs(y - 15) / 3) % width;
      const shade = y > 28 ? 35 : phase < 7 ? 27 : phase < 10 ? 84 : shoulder ? 50 : 66;
      const i = (y * width + x) * 4;
      pixels.set([shade - 4, shade, shade + 3, 255], i);
    }
  }
  const map = new THREE.DataTexture(pixels, width, height);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  return map;
}

export class BulldozerModel {
  public readonly group = new THREE.Group();
  private readonly frame = new THREE.Group();
  private readonly blade = new THREE.Group();
  private readonly belt = makeDozerBelt();
  private readonly maps = [treadTexture(), treadTexture()];
  private readonly trackMaterials = this.maps.map(map => new THREE.MeshLambertMaterial({ map }));
  private readonly glass = createGlassMaterial({ color: 0x91b4b7 });
  private readonly prompt = createPromptSprite();

  constructor() {
    this.group.name = 'Bulldozer';
    this.frame.name = 'BulldozerChassis';
    this.blade.name = 'BulldozerBlade';
    this.group.add(this.frame, this.blade, this.prompt);
    this.prompt.position.set(0, 2.85, -0.3);
    this.blade.position.set(0, 0.46, 0.76);

    const ochre = new THREE.MeshLambertMaterial({ color: 0xd19b45 });
    const cream = new THREE.MeshLambertMaterial({ color: 0xf4e5bf });
    const slate = new THREE.MeshLambertMaterial({ color: 0x344b64 });
    const rubber = new THREE.MeshLambertMaterial({ color: 0x333e42 });
    const steel = new THREE.MeshLambertMaterial({ color: 0xa6b4b3 });
    const lights = new THREE.MeshBasicMaterial({ color: 0xffe5ae });

    const add = (parent: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const box = (parent: THREE.Group, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) =>
      add(parent, new THREE.BoxGeometry(w, h, d), mat, x, y, z);
    const bevel = (parent: THREE.Group, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, radius: number) => {
      const a = w / 2 - radius, b = h / 2 - radius;
      const shape = new THREE.Shape().moveTo(-a, -b).lineTo(a, -b).lineTo(a, b).lineTo(-a, b).closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: d - radius * 2, bevelSize: radius,
        bevelThickness: radius, bevelSegments: 2, steps: 1, curveSegments: 1 });
      geo.translate(0, 0, radius - d / 2);
      return add(parent, geo, mat, x, y, z);
    };

    bevel(this.frame, slate, 1.55, 0.43, 2.75, 0, 0.69, -0.02, 0.08);
    bevel(this.frame, ochre, 1.48, 0.7, 1.43, 0, 1.05, 0.59, 0.13);
    bevel(this.frame, slate, 0.72, 0.42, 0.12, 0, 1.04, 1.29, 0.035);
    for (let i = -2; i <= 2; i++) box(this.frame, steel, 0.026, 0.27, 0.022, i * 0.12, 1.04, 1.352);
    bevel(this.frame, cream, 1.5, 1.25, 1.17, 0, 1.5, -0.64, 0.1);
    bevel(this.frame, cream, 1.66, 0.19, 1.39, 0, 2.15, -0.65, 0.055);
    const cabGlass = new THREE.Group();
    this.frame.add(cabGlass);
    bevel(cabGlass, this.glass, 1.27, 0.55, 0.064, 0, 1.73, -0.058, 0.025);
    bevel(cabGlass, this.glass, 1.16, 0.47, 0.064, 0, 1.74, -1.223, 0.025);

    for (let i = 0; i < 2; i++) {
      const side = i * 2 - 1;
      const track = add(this.group, this.belt, this.trackMaterials[i], side * DOZER_TRACK_X, 0, 0);
      track.name = side < 0 ? 'RightTrack' : 'LeftTrack';
      bevel(this.frame, ochre, 0.56, 0.17, 2.15, side * DOZER_TRACK_X, 0.97, -0.26, 0.065);
      bevel(cabGlass, this.glass, 0.066, 0.54, 0.85, side * 0.743, 1.73, -0.65, 0.025);
      box(this.frame, slate, 0.045, 0.037, 0.19, side * 0.762, 1.33, -0.37);
      bevel(this.frame, lights, 0.23, 0.15, 0.12, side * 0.55, 1.14, 1.29, 0.032);
      for (const z of [-DOZER_TRACK_END, -0.33, 0.33, DOZER_TRACK_END]) {
        const end = Math.abs(z) === DOZER_TRACK_END;
        const wheel = new THREE.CylinderGeometry(end ? 0.35 : 0.25, end ? 0.35 : 0.25, 0.42, end ? 14 : 10);
        wheel.rotateZ(Math.PI / 2);
        add(this.frame, wheel, rubber, side * DOZER_TRACK_X, end ? DOZER_TRACK_Y : DOZER_TRACK_Y - 0.10, z);
        const hub = new THREE.CylinderGeometry(end ? 0.235 : 0.145, end ? 0.235 : 0.145, 0.084, 12);
        hub.rotateZ(Math.PI / 2);
        add(this.frame, hub, end ? ochre : steel, side * 1.19, end ? DOZER_TRACK_Y : DOZER_TRACK_Y - 0.10, z);
      }
      const arm = box(this.blade, ochre, 0.16, 0.17, 1.08, side * 1.16, -0.035, 0.47);
      arm.rotation.x = 0.13;
      box(this.blade, slate, 0.14, 0.47, 0.34, side * 1.72, 0.05, 1.06).rotation.x = -0.26;
    }
    const windowParts = cabGlass.children as THREE.Mesh<THREE.BufferGeometry>[];
    const windowGeometries = windowParts.map(part => part.geometry.translate(part.position.x, part.position.y, part.position.z));
    const windows = mergeGeometries(windowGeometries)!;
    cabGlass.clear();
    windowGeometries.forEach(geometry => geometry.dispose());
    add(cabGlass, windows, this.glass, 0, 0, 0).castShadow = false;

    const profile = new THREE.Shape().moveTo(-1.10, -0.35).lineTo(-1.17, -0.26)
      .quadraticCurveTo(-0.76, 0.10, -1.0, 0.49).lineTo(-0.88, 0.53)
      .quadraticCurveTo(-0.62, 0.10, -0.97, -0.33).closePath();
    const blade = new THREE.ExtrudeGeometry(profile, { depth: DOZER_BLADE_HALF_WIDTH * 2 - 0.18,
      bevelSize: 0.045, bevelThickness: 0.045, bevelSegments: 2, curveSegments: 8 });
    blade.rotateY(Math.PI / 2);
    add(this.blade, blade, slate, -DOZER_BLADE_HALF_WIDTH + 0.09, 0, 0);
    bevel(this.blade, steel, 3.58, 0.10, 0.19, 0, -0.3, 1.11, 0.035);
    const original = [...this.frame.children, ...this.blade.children].filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
    mergeColoredChildren(this.frame);
    mergeColoredChildren(this.blade);
    for (const mesh of original) if (!mesh.parent) mesh.geometry.dispose();
    for (const material of [ochre, cream, slate, rubber, steel, lights]) material.dispose();
    this.setBlade(false, 1);
  }

  public setBlade(lowered: boolean, blend: number): void {
    this.blade.rotation.x = THREE.MathUtils.lerp(this.blade.rotation.x, lowered ? 0.04 : -0.38, blend);
  }

  public advanceTracks(right: number, left: number, dt: number): void {
    this.maps[0].offset.x = THREE.MathUtils.euclideanModulo(this.maps[0].offset.x + right * dt * REPEATS_PER_METRE, 1);
    this.maps[1].offset.x = THREE.MathUtils.euclideanModulo(this.maps[1].offset.x + left * dt * REPEATS_PER_METRE, 1);
  }

  public setPromptVisible(visible: boolean): void {
    this.prompt.visible = visible;
  }

  public dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    this.group.traverse(o => { if (o instanceof THREE.Mesh) geometries.add(o.geometry); });
    for (const geo of geometries) geo.dispose();
    for (const mat of this.trackMaterials) mat.dispose();
    for (const map of this.maps) map.dispose();
    this.glass.dispose();
    this.prompt.material.dispose();
    this.group.removeFromParent();
  }
}
