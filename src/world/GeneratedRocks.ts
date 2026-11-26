import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

export const ROCK_PRESETS = {
  boulder: { label: 'Валун', width: 1.7, height: 1.15, depth: 1.45 },
  slab: { label: 'Плита', width: 2.4, height: 0.55, depth: 1.65 },
  wedge: { label: 'Клин', width: 1.5, height: 1.45, depth: 1.3 },
  pillar: { label: 'Колона', width: 1.05, height: 2.25, depth: 1.05 },
  cluster: { label: 'Група каменів', width: 2.9, height: 1.45, depth: 1.85 },
} as const;

export const ROCK_PALETTES = {
  granite: { label: 'Граніт', colors: [0x606266, 0x909093, 0xc2beb9] },
  limestone: { label: 'Вапняк', colors: [0x807263, 0xaf9c82, 0xd7c8ae] },
  slate: { label: 'Сланець', colors: [0x4d5665, 0x738294, 0xa5b4c0] },
  sandstone: { label: 'Пісковик', colors: [0x896050, 0xbc876c, 0xe4b896] },
} as const;

export interface GeneratedRockParams {
  preset: keyof typeof ROCK_PRESETS;
  palette: keyof typeof ROCK_PALETTES;
  seed: number;
  width: number;
  height: number;
  depth: number;
  sharpness: number;
  solid: boolean;
  surface?: GeneratedRockSurface;
}

export interface GeneratedRockSurface {
  moss: number;
  snow: number;
  mossHeight: number;
  snowHeight: number;
}

export const DEFAULT_ROCK_SURFACE: Readonly<GeneratedRockSurface> = { moss: 1, snow: 1, mossHeight: 0.35, snowHeight: 0.35 };

export interface GeneratedRockSave extends GeneratedRockParams {
  id: string;
  name: string;
}

export const MAX_GENERATED_ROCKS = 48;
export const isGeneratedRockType = (type: string): boolean => /^generated_rock_[1-9]\d{0,8}$/.test(type);

export function isGeneratedRockSave(value: unknown): value is GeneratedRockSave {
  if (!value || typeof value !== 'object') return false;
  const rock = value as Partial<GeneratedRockSave>;
  return typeof rock.id === 'string' && isGeneratedRockType(rock.id) &&
    typeof rock.name === 'string' && rock.name.trim().length > 0 && rock.name.length <= 48 &&
    typeof rock.preset === 'string' && Object.hasOwn(ROCK_PRESETS, rock.preset) &&
    typeof rock.palette === 'string' && Object.hasOwn(ROCK_PALETTES, rock.palette) &&
    inRange(rock.seed, 0, 0xffffffff) && Number.isInteger(rock.seed) &&
    inRange(rock.width, 0.3, 5) && inRange(rock.height, 0.2, 5) && inRange(rock.depth, 0.3, 5) &&
    inRange(rock.sharpness, 0, 1) && typeof rock.solid === 'boolean' &&
    (rock.surface === undefined || isRockSurface(rock.surface));
}

function isRockSurface(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const surface = value as Partial<GeneratedRockSurface>;
  return inRange(surface.moss, 0, 1) && inRange(surface.snow, 0, 1) &&
    inRange(surface.mossHeight, 0.05, 1.5) && inRange(surface.snowHeight, 0.05, 1.5);
}

function inRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && value >= min && value <= max;
}

export interface GeneratedRockModel {
  lods: [THREE.BufferGeometry, THREE.BufferGeometry, THREE.BufferGeometry];
  hulls: Float32Array[];
  radius: number;
}

interface RockBlock {
  near: THREE.Vector3[];
  medium: THREE.Vector3[];
  far: THREE.Vector3[];
}

function buildBlock(p: GeneratedRockParams, random: () => number, x: number, z: number, horizontal: number, height: number, yaw: number): RockBlock {
  const topScale = { boulder: 0.66, slab: 0.88, wedge: 0.33, pillar: 0.83, cluster: 0.64 }[p.preset];
  const footScale = { boulder: 0.69, slab: 0.9, wedge: 0.93, pillar: 0.81, cluster: 0.77 }[p.preset];
  const shoulder = { boulder: 0.69, slab: 0.82, wedge: 0.53, pillar: 0.79, cluster: 0.68 }[p.preset];
  const lean = (p.preset === 'wedge' ? 0.41 : 0.15) * (random() < 0.5 ? -1 : 1);
  const tilt = (p.preset === 'slab' ? 0.12 : 0.32) * (random() - 0.5);
  const foot = [], heel = [], body = [], cap = [];
  const sides = 6;
  const phase = random() * Math.PI;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const point = (u: number, y: number, v: number) => new THREE.Vector3(
    x + (u * cos + v * sin) * horizontal,
    y * height,
    z + (v * cos - u * sin) * horizontal,
  );
  for (let i = 0; i < sides; i++) {
    const a = phase + i * Math.PI * 2 / sides + (random() - 0.5) * 0.2;
    const radius = 0.84 + random() * 0.19;
    const u = Math.cos(a) * radius, v = Math.sin(a) * radius;
    foot.push(point(u * footScale, -0.045 + 0.018 * u, v * footScale));
    heel.push(point(u * footScale * 0.62 + lean * 0.15, -0.19 + (u + v) * 0.025, v * footScale * 0.60));
    body.push(point(u, shoulder + (random() - 0.5) * 0.21, v));
    cap.push(point(u * topScale + lean, 1 + u * tilt + v * tilt * 0.6, v * topScale));
  }

  const base = point(0.08 + lean * 0.29, -0.31, -0.08);

  return {
    near: [],
    medium: [...foot, ...heel, base, ...body, ...cap],
    far: [...foot.filter((_, i) => i % 2 === 0), ...body.filter((_, i) => i !== 0 && i !== 3),
      ...cap.filter((_, i) => i !== 2 && i !== 5), base],
  };
}

function facesOf(points: THREE.Vector3[]): { normal: THREE.Vector3; points: THREE.Vector3[] }[] {
  const faces: { normal: THREE.Vector3; offset: number; points: Set<THREE.Vector3> }[] = [];
  for (const face of new ConvexHull().setFromPoints(points).faces) {
    let plane = faces.find((f) => f.normal.dot(face.normal) > 0.9999999 && Math.abs(f.offset - face.constant) < 0.00001);
    if (!plane) {
      plane = { normal: face.normal, offset: face.constant, points: new Set() };
      faces.push(plane);
    }
    let edge = face.edge;
    do {
      plane.points.add(edge.head().point);
      edge = edge.next;
    } while (edge !== face.edge);
  }
  return faces.map(({ normal, points }) => {
    const vertices = [...points];
    const u = vertices[1].clone().sub(vertices[0]).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u);
    // A triangulated plane may include vertices along or inside its edges after beveling.
    // Recover its convex boundary in plane coordinates before insetting or painting it.
    const projected = vertices.map((point) => ({ point, x: point.dot(u), y: point.dot(v) }));
    projected.sort((a, b) => a.x - b.x || a.y - b.y);
    const half = (ordered: typeof projected) => {
      const result: typeof projected = [];
      for (const c of ordered) {
        while (result.length >= 2) {
          const [a, b] = [result[result.length - 2], result[result.length - 1]];
          if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 1e-10) break;
          result.pop();
        }
        result.push(c);
      }
      return result.slice(0, -1);
    };
    return { normal, points: [...half(projected), ...half(projected.reverse())].map(({ point }) => point) };
  });
}

function centroid(points: THREE.Vector3[]): THREE.Vector3 {
  const middle = new THREE.Vector3();
  for (const point of points) middle.add(point);
  return middle.divideScalar(points.length);
}

function bevelHull(points: THREE.Vector3[], inset: number): THREE.Vector3[] {
  // Keep the rounded underside. Inset the exposed faces to bevel the cap and side edges.
  const beveled = points.filter((point) => point.y < 0);
  for (const { points: ring } of facesOf(points)) {
    if (ring.every((point) => point.y < 0)) continue;
    const center = centroid(ring);
    for (const point of ring) beveled.push(point.clone().lerp(center, inset));
  }
  return beveled;
}

function smoothHullNormals(faces: ReturnType<typeof facesOf>): Map<THREE.Vector3, THREE.Vector3> {
  const normals = new Map<THREE.Vector3, THREE.Vector3>();
  const before = new THREE.Vector3(), after = new THREE.Vector3();
  for (const { normal, points } of faces) {
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      before.subVectors(points[(i + points.length - 1) % points.length], point);
      after.subVectors(points[(i + 1) % points.length], point);
      let sum = normals.get(point);
      if (!sum) normals.set(point, sum = new THREE.Vector3());
      sum.addScaledVector(normal, before.angleTo(after));
    }
  }
  for (const normal of normals.values()) normal.normalize();
  return normals;
}

function geometryOf(blocks: RockBlock[], p: GeneratedRockParams, level: number, hulls?: Float32Array[]): THREE.BufferGeometry {
  const position: number[] = [], normals: number[] = [], colors: number[] = [];
  const [dark, base, light] = ROCK_PALETTES[p.palette].colors.map((hex) => new THREE.Color(hex));
  const key = level === 0 ? 'near' : level === 1 ? 'medium' : 'far';
  for (const block of blocks) {
    const faces = facesOf(block[key]);
    if (hulls) {
      const vertices = new Set(faces.filter(({ points }) => points.length >= 3).flatMap(({ points }) => points));
      hulls.push(new Float32Array(Array.from(vertices).flatMap(({ x, y, z }) => [x, y, z])));
    }
    const smooth = smoothHullNormals(faces);
    const tint = new THREE.Color();
    for (const { points } of faces) {
      for (let i = 1; i < points.length - 1; i++) {
        for (const point of [points[0], points[i], points[i + 1]]) {
          const n = smooth.get(point)!;
          const tone = 0.47 + n.y * 0.19 + n.x * 0.05 + point.y / p.height * 0.16;
          tint.copy(dark).lerp(base, tone).lerp(light, Math.max(0, n.y) * 0.19);
          position.push(point.x, point.y, point.z);
          normals.push(n.x, n.y, n.z);
          colors.push(Math.round(tint.r * 255), Math.round(tint.g * 255), Math.round(tint.b * 255));
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Uint8BufferAttribute(colors, 3, true));
  geometry.setAttribute('aRockCover', new THREE.BufferAttribute(new Float32Array(position.length / 3 * 4), 4));
  geometry.addGroup(0, position.length / 3, 0);
  geometry.computeBoundingSphere();
  return geometry;
}

function randomRock(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function setGeneratedRockSurface(model: GeneratedRockModel, surface: Readonly<GeneratedRockSurface> = DEFAULT_ROCK_SURFACE): void {
  for (const lod of model.lods) {
    const attribute = lod.getAttribute('aRockCover');
    for (let i = 0; i < attribute.count; i++) attribute.setXYZW(i, surface.moss, surface.snow, surface.mossHeight, surface.snowHeight);
    attribute.needsUpdate = true;
  }
}

export function buildGeneratedRock(p: GeneratedRockParams): GeneratedRockModel {
  const random = randomRock(p.seed);
  const yaw = random() * Math.PI * 2;
  const blocks = p.preset === 'cluster' ? [
    buildBlock(p, random, -0.35, -0.1, 0.65, 1, yaw),
    buildBlock(p, random, 0.6, 0.16, 0.48, 0.65, yaw + 1),
    buildBlock(p, random, -0.16, 0.58, 0.35, 0.43, yaw - 1),
  ] : [buildBlock(p, random, 0, 0, 1, 1, yaw)];

  const bounds = new THREE.Box3().setFromPoints(blocks.flatMap((block) => block.medium));
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const verticalScale = p.height / bounds.max.y;
  const undersideScale = Math.min(1.25, verticalScale * 0.72);
  let radius = 0;
  for (const point of blocks.flatMap((block) => block.medium)) {
    point.x = (point.x - center.x) * p.width / size.x;
    point.y *= point.y < 0 ? undersideScale : verticalScale;
    point.z = (point.z - center.z) * p.depth / size.z;
    radius = Math.max(radius, Math.hypot(point.x, point.z));
  }
  const bevel = THREE.MathUtils.lerp(0.35, 0.08, p.sharpness);
  for (const block of blocks) block.near = bevelHull(block.medium, bevel);
  // One convex collider per LOD0 block retains all its rendered bevel and underside vertices.
  const hulls: Float32Array[] = [];
  const model: GeneratedRockModel = {
    lods: [geometryOf(blocks, p, 0, p.solid ? hulls : undefined), geometryOf(blocks, p, 1), geometryOf(blocks, p, 2)],
    hulls,
    radius,
  };
  setGeneratedRockSurface(model, p.surface);
  return model;
}
