import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PART } from './AnimalMaterial';
import { shapeFishGeometry } from '../entities/FishFlockSystem';

/**
 * Low-poly animal meshes, each merged into ONE geometry (one draw call per species) with per-vertex
 * colour, a body-part tag (`aPart`) and the part's hip height (`aHip`) for the vertex animation.
 * Forward = +Z, origin on the ground (walkers) or at the centre of mass (flyers, swimmers).
 */
class Builder {
  private readonly parts: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, color: number, part = 0, hip = 0): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.deleteAttribute('uv');
    g.computeVertexNormals();
    const n = g.attributes.position.count;
    const c = new THREE.Color(color);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(col, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
    g.setAttribute('aHip', new THREE.BufferAttribute(new Float32Array(n).fill(hip), 1));
    this.parts.push(g);
    return this;
  }

  box(color: number, w: number, h: number, d: number, x: number, y: number, z: number, part = 0, hip = 0, rx = 0, ry = 0, rz = 0): this {
    const g = new THREE.BoxGeometry(w, h, d);
    g.rotateX(rx);
    g.rotateY(ry);
    g.rotateZ(rz);
    g.translate(x, y, z);
    return this.add(g, color, part, hip);
  }

  blob(color: number, sx: number, sy: number, sz: number, x: number, y: number, z: number, part = 0, hip = 0, detail = 0): this {
    const g = new THREE.IcosahedronGeometry(1, detail);
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    return this.add(g, color, part, hip);
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts)!;
    this.parts.forEach((p) => p.dispose());
    g.computeBoundingSphere();
    return g;
  }
}

/** Seagull, ~0.45 m long, ~1.1 m wingspan, wings level (aPart 1/2 flap about the body). */
export function gullGeometry(): THREE.BufferGeometry {
  const white = 0xf6f6f2, grey = 0xaeb6bf, dark = 0x2c2f33, beak = 0xf1b531;
  const b = new Builder()
    .blob(white, 0.09, 0.08, 0.22, 0, 0, 0)
    .blob(white, 0.065, 0.065, 0.07, 0, 0.05, 0.2)
    .box(beak, 0.025, 0.025, 0.08, 0, 0.04, 0.29)
    .box(grey, 0.12, 0.02, 0.1, 0, 0.01, -0.22); // tail
  for (const side of [-1, 1]) {
    const part = side < 0 ? PART.WING_L : PART.WING_R;
    // Inner wing grey, outer wing with a black tip, swept back a little
    b.box(grey, 0.3, 0.018, 0.15, side * 0.2, 0.02, 0.0, part, 0, 0, side * 0.12);
    b.box(grey, 0.2, 0.016, 0.11, side * 0.43, 0.02, -0.04, part, 0, 0, side * 0.3);
    b.box(dark, 0.09, 0.017, 0.08, side * 0.56, 0.02, -0.08, part, 0, 0, side * 0.35);
  }
  return b.build();
}

/** Butterfly, ~0.12 m wingspan: body plus two two-lobed wings (instance colour tints the wings). */
export function butterflyGeometry(): THREE.BufferGeometry {
  const b = new Builder().box(0x2a2320, 0.012, 0.012, 0.06, 0, 0, 0);
  for (const side of [-1, 1]) {
    const part = side < 0 ? PART.WING_L : PART.WING_R;
    const fore = new THREE.CircleGeometry(0.035, 6);
    fore.rotateX(-Math.PI / 2);
    fore.scale(1, 1, 0.8);
    fore.translate(side * 0.034, 0, 0.014);
    b.add(fore, 0xffffff, part);
    const hind = new THREE.CircleGeometry(0.026, 5);
    hind.rotateX(-Math.PI / 2);
    hind.translate(side * 0.026, 0, -0.018);
    b.add(hind, 0xe8e0d0, part);
    const spot = new THREE.CircleGeometry(0.01, 5);
    spot.rotateX(-Math.PI / 2);
    spot.translate(side * 0.045, 0.001, 0.02);
    b.add(spot, 0x221a14, part);
  }
  return b.build();
}

/** Hare, ~0.5 m long, sitting height ~0.35 m; long hind legs, tall ears, white tail. */
export function hareGeometry(): THREE.BufferGeometry {
  const fur = 0x9a7a58, belly = 0xd9c6a8, dark = 0x3a2a20;
  const b = new Builder()
    .blob(fur, 0.12, 0.12, 0.2, 0, 0.24, -0.02)
    .blob(belly, 0.09, 0.08, 0.14, 0, 0.19, 0.0)
    .blob(fur, 0.075, 0.075, 0.09, 0, 0.34, 0.18, PART.HEAD)
    .box(fur, 0.035, 0.17, 0.02, -0.03, 0.47, 0.15, PART.HEAD, 0, -0.25, 0, 0.12)
    .box(fur, 0.035, 0.17, 0.02, 0.03, 0.47, 0.15, PART.HEAD, 0, -0.25, 0, -0.12)
    .box(dark, 0.02, 0.06, 0.012, -0.03, 0.54, 0.13, PART.HEAD, 0, -0.25, 0, 0.12)
    .box(dark, 0.02, 0.06, 0.012, 0.03, 0.54, 0.13, PART.HEAD, 0, -0.25, 0, -0.12)
    .box(dark, 0.02, 0.02, 0.02, 0, 0.33, 0.27, PART.HEAD)
    .blob(0xf5f2ec, 0.045, 0.045, 0.04, 0, 0.27, -0.22, PART.TAIL);
  // Front legs short and thin, hind legs long (bound gait)
  b.box(fur, 0.035, 0.18, 0.04, -0.05, 0.09, 0.12, PART.LEG_FL, 0.18);
  b.box(fur, 0.035, 0.18, 0.04, 0.05, 0.09, 0.12, PART.LEG_FR, 0.18);
  b.box(fur, 0.05, 0.16, 0.16, -0.08, 0.08, -0.1, PART.LEG_BL, 0.16);
  b.box(fur, 0.05, 0.16, 0.16, 0.08, 0.08, -0.1, PART.LEG_BR, 0.16);
  return b.build();
}

/** Fish, reusing the tapered-box body of the reef fish (FishFlockSystem); ~0.35 m. */
export function fishGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(0.07, 0.14, 0.35, 1, 2, 4);
  shapeFishGeometry(geo, 0.35);
  const b = new Builder().add(geo, 0xffffff);
  b.box(0x1a1a1a, 0.075, 0.02, 0.02, 0, 0.02, 0.11); // eyes
  return b.build();
}

/** Turtle, ~0.8 m: domed shell, scute ring, head and four flippers. */
export function turtleGeometry(): THREE.BufferGeometry {
  const shell = 0x5d6b3a, scute = 0x7b6a3c, skin = 0x9aa36a, belly = 0xd8c98f;
  const b = new Builder()
    .blob(shell, 0.34, 0.15, 0.42, 0, 0.17, 0, 0, 0, 1)
    .blob(scute, 0.2, 0.08, 0.26, 0, 0.27, 0)
    .box(belly, 0.56, 0.06, 0.7, 0, 0.08, 0)
    .blob(skin, 0.09, 0.08, 0.12, 0, 0.14, 0.47, PART.HEAD)
    .box(0x1a1a1a, 0.13, 0.02, 0.02, 0, 0.17, 0.53, PART.HEAD)
    .box(skin, 0.06, 0.04, 0.12, 0, 0.1, -0.44, PART.TAIL);
  // Flippers: front pair longer, swept; legs swing about their hip at y = 0.14
  b.box(skin, 0.22, 0.05, 0.1, -0.33, 0.07, 0.26, PART.LEG_FL, 0.16, 0, -0.4);
  b.box(skin, 0.22, 0.05, 0.1, 0.33, 0.07, 0.26, PART.LEG_FR, 0.16, 0, 0.4);
  b.box(skin, 0.14, 0.05, 0.09, -0.26, 0.07, -0.3, PART.LEG_BL, 0.16, 0, 0.5);
  b.box(skin, 0.14, 0.05, 0.09, 0.26, 0.07, -0.3, PART.LEG_BR, 0.16, 0, -0.5);
  return b.build();
}
