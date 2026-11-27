import * as THREE from 'three';
import { bridgeHeight, bridgeSegments, bridgeSpan, type BridgeDef } from './BridgeTypes';

type Vertex = [x: number, y: number, z: number];
type Ring = [Vertex, Vertex, Vertex, Vertex];

const WOOD_REPEAT = 1.8;

function ring(left: number, right: number, top: number, bottom: number, z: number): Ring {
  return [[left, top, z], [right, top, z], [right, bottom, z], [left, bottom, z]];
}

class WoodBuffers {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];
  public readonly tint = new THREE.Color(0xd5b290);

  private vertex(point: Vertex, u: number, v: number): void {
    this.positions.push(...point);
    this.colors.push(this.tint.r, this.tint.g, this.tint.b);
    this.uvs.push(u / WOOD_REPEAT, v / WOOD_REPEAT);
  }

  private cap(section: Ring, reverse: boolean): void {
    const start = this.positions.length / 3;
    for (const point of section) this.vertex(point, point[0], point[1]);
    if (reverse) this.indices.push(start, start + 2, start + 1, start, start + 3, start + 2);
    else this.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  /** Four hard-edged strips, each smooth along the curve. UVs follow the surface length. */
  public beam(sections: Ring[], distance: number[], deck = false): void {
    for (let side = 0; side < 4; side++) {
      const next = (side + 1) % 4;
      const start = this.positions.length / 3;
      sections.forEach((section, index) => {
        const a = section[side];
        const b = section[next];
        const across = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const along = distance[index];
        if (deck && side === 0) {
          this.vertex(a, a[0], along);
          this.vertex(b, b[0], along);
        } else {
          this.vertex(a, along, 0);
          this.vertex(b, along, across);
        }
        if (index === 0) return;
        const i = start + index * 2;
        this.indices.push(i - 2, i, i + 1, i - 2, i + 1, i - 1);
      });
    }
    this.cap(sections[0], false);
    this.cap(sections[sections.length - 1], true);
  }

  public box(left: number, right: number, top: number, bottom: number, z0: number, z1: number): void {
    this.beam([ring(left, right, top, bottom, z0), ring(left, right, top, bottom, z1)], [z0, z1]);
  }

  public geometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** Weld the physics strips and omit decorative spindles and posts from the collider. */
function addCollisionBeam(sections: Ring[], positions: number[], indices: number[]): void {
  const start = positions.length / 3;
  sections.forEach((section, index) => {
    for (const vertex of section) positions.push(...vertex);
    if (index === 0) return;
    const current = start + index * 4;
    const previous = current - 4;
    for (let side = 0; side < 4; side++) {
      const next = (side + 1) % 4;
      indices.push(previous + side, current + side, current + next, previous + side, current + next, previous + next);
    }
  });
  const end = start + 4 * (sections.length - 1);
  indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  indices.push(end, end + 2, end + 1, end, end + 3, end + 2);
}

/** Local X is across the deck, local +Z is from the first landing to the second. */
export function buildBridge(bridge: BridgeDef, withCollision: boolean, lod: 0 | 1 = 0) {
  const span = bridgeSpan(bridge.a, bridge.b);
  const detailed = lod === 0;
  const fullSegments = bridgeSegments(span);
  // Bound the error of the curved profile to about 4 cm, using the steeper eased curve.
  const coarseSegments = Math.max(1, Math.ceil(Math.PI * Math.sqrt(bridge.rise / 0.16)));
  const segments = detailed ? fullSegments : Math.min(fullSegments, coarseSegments);
  const half = bridge.width / 2;
  const { railHeight, thickness } = bridge;
  const origin = new THREE.Vector3(bridge.a.x, bridge.a.y, bridge.a.z);
  const yaw = Math.atan2(bridge.b.x - bridge.a.x, bridge.b.z - bridge.a.z);
  const wood = new WoodBuffers();
  const collisionVertices: number[] = [];
  const collisionIndices: number[] = [];
  const distance = [0];
  const heights = Array.from({ length: segments + 1 }, (_, i) => bridgeHeight(bridge, i / segments));
  for (let i = 1; i <= segments; i++) {
    distance.push(distance[i - 1] + Math.hypot(span / segments, heights[i] - heights[i - 1]));
  }
  const profile = (left: number, right: number, top: number, bottom: number) =>
    heights.map((height, i) => ring(left, right, height + top, height + bottom, span * i / segments));

  const slab = profile(-half, half, 0, -thickness);
  wood.beam(slab, distance, true);
  if (withCollision && detailed) addCollisionBeam(slab, collisionVertices, collisionIndices);

  wood.tint.setHex(0xb08b68);
  const postHalf = Math.min(0.12, bridge.width * 0.08);
  for (const side of [-1, 1]) {
    const x = side * (half - postHalf - 0.025);
    const lower = x - postHalf;
    const upper = x + postHalf;
    // Stringers sit slightly proud of the slab below the deck.
    if (detailed) {
      wood.beam(profile(x - postHalf * 1.18, x + postHalf * 1.18, -thickness * 0.55, -thickness - 0.12), distance);
    }
    if (!bridge.railings) continue;

    const handrailHalf = postHalf * 0.72;
    const handrailDepth = Math.min(0.12, railHeight * 0.18);
    const baseRailTop = railHeight * 0.21;
    wood.beam(profile(x - handrailHalf, x + handrailHalf, railHeight, railHeight - handrailDepth), distance);
    if (detailed) {
      wood.beam(profile(x - handrailHalf * 0.85, x + handrailHalf * 0.85, baseRailTop, baseRailTop - 0.065), distance);
    }
    if (withCollision && detailed) {
      addCollisionBeam(profile(x - handrailHalf, x + handrailHalf, railHeight, 0), collisionVertices, collisionIndices);
    }

    const inset = postHalf + 0.015;
    const bays = Math.ceil((span - 2 * inset) / (detailed ? 5.6 : 2.8));
    const spacing = (span - 2 * inset) / bays;
    for (let bay = 0; bay <= bays; bay++) {
      const z = inset + spacing * bay;
      const y = bridgeHeight(bridge, z / span);
      wood.box(lower, upper, y + railHeight + 0.10, y - thickness - 0.10, z - postHalf, z + postHalf);
      if (!detailed) continue;
      const capHalf = postHalf + 0.025;
      wood.box(x - capHalf, x + capHalf, y + railHeight + 0.15, y + railHeight + 0.10, z - capHalf, z + capHalf);
      const crownHalf = capHalf * 0.61;
      wood.box(x - crownHalf, x + crownHalf, y + railHeight + 0.18, y + railHeight + 0.15, z - crownHalf, z + crownHalf);

      if (bay === bays) continue;
      const divisions = Math.ceil(spacing / 0.29);
      for (let k = 1; k < divisions; k++) {
        const at = z + spacing * k / divisions;
        const height = bridgeHeight(bridge, at / span);
        const radius = postHalf * 0.35;
        wood.box(x - radius, x + radius, height + railHeight - handrailDepth * 0.45,
          height + baseRailTop - 0.025, at - radius, at + radius);
      }
    }
  }

  return {
    origin, yaw,
    geometry: wood.geometry(),
    collisionVertices,
    collisionIndices,
  };
}
