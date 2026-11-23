import * as THREE from 'three';

const SIDES = 48;
const CROWN_TIME = 0.42;
const FOAM_TIME = 0.66;
const ECHO_DELAY = 0.09;

function makeRibbon(crown: boolean): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const rows = crown ? 3 : 2;
  const base = new THREE.Color(crown ? '#76c6df' : '#acf0fa');
  const foam = new THREE.Color('#f4fdff');
  for (let i = 0; i < SIDES; i++) {
    const a = i / SIDES * Math.PI * 2;
    const tooth = Math.pow(0.5 + 0.5 * Math.cos(a * 8 + 0.6 * Math.sin(a * 3)), 2);
    const irregularity = Math.sin(a * 3 + 0.7) * 0.08 + Math.sin(a * 5) * 0.05;
    for (let row = 0; row < rows; row++) {
      const tip = row === 2;
      const radius = crown
        ? (row === 0 ? 0.53 : tip ? 0.86 + tooth * 0.19 : 0.72 + tooth * 0.08) + irregularity
        : 1 + irregularity * 0.55 - (row === 0 ? 0.04 + tooth * 0.08 : 0);
      const y = crown ? (row === 0 ? -0.045 : (0.22 + tooth * 0.78) * (tip ? 1 : 0.66)) : 0;
      positions.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
      const color = row === 0 ? base : foam;
      colors.push(color.r, color.g, color.b);
    }
    const next = ((i + 1) % SIDES) * rows;
    for (let row = 0; row < rows - 1; row++) {
      const v = i * rows + row;
      const n = next + row;
      indices.push(v, n, v + 1, v + 1, n, n + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

class SplashBurst {
  readonly group = new THREE.Group();
  private readonly crown: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private readonly ring: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private readonly echo: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private age = 0;
  private strength = 0;

  constructor(crown: THREE.BufferGeometry, ring: THREE.BufferGeometry) {
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      forceSinglePass: true,
      depthWrite: false,
    });
    this.crown = new THREE.Mesh(crown, material);
    this.ring = new THREE.Mesh(ring, material.clone());
    this.echo = new THREE.Mesh(ring, material.clone());
    this.ring.position.y = 0.045;
    this.echo.position.y = 0.05;
    this.echo.rotation.y = 0.8;
    this.group.name = 'WaterEntrySplash';
    this.group.renderOrder = 2;
    this.group.visible = false;
    this.group.add(this.crown, this.ring, this.echo);
  }

  get active(): boolean {
    return this.group.visible;
  }

  start(surface: THREE.Vector3, strength: number): void {
    this.age = 0;
    this.strength = strength;
    this.group.position.copy(surface);
    this.group.rotation.y = Math.random() * Math.PI * 2;
    this.group.visible = true;
    this.update(0);
  }

  update(dt: number): void {
    if (!this.active) return;
    this.age += dt;
    if (this.age >= FOAM_TIME + ECHO_DELAY) {
      this.group.visible = false;
      return;
    }
    const power = this.strength;
    const spread = 0.65 + power * 0.55;
    const t = Math.min(1, this.age / CROWN_TIME);
    const rise = THREE.MathUtils.smoothstep(t, 0, 0.22);
    const fall = 1 - THREE.MathUtils.smoothstep(t, 0.22, 1);
    this.crown.visible = t < 1;
    this.crown.scale.set((0.52 + t * 0.78) * spread, (0.07 + rise * fall) * (0.42 + power * 1.55), (0.52 + t * 0.78) * spread);
    this.crown.material.opacity = 0.96 * (1 - THREE.MathUtils.smoothstep(t, 0.45, 1));

    this.updateRing(this.ring, this.age / FOAM_TIME, 0.43 * spread, 2.3 * spread, 0.94);
    this.updateRing(this.echo, (this.age - ECHO_DELAY) / FOAM_TIME, 0.3 * spread, 1.65 * spread, 0.59);
  }

  private updateRing(mesh: typeof this.ring, t: number, startRadius: number, endRadius: number, opacity: number): void {
    mesh.visible = t >= 0 && t < 1;
    if (!mesh.visible) return;
    const radius = THREE.MathUtils.lerp(startRadius, endRadius, 1 - (1 - t) ** 2);
    mesh.scale.set(radius, 1, radius);
    mesh.material.opacity = opacity * (1 - THREE.MathUtils.smoothstep(t, 0.28, 1));
  }

  dispose(): void {
    this.crown.material.dispose();
    this.ring.material.dispose();
    this.echo.material.dispose();
    this.group.removeFromParent();
  }
}

/** Short-lived cel-style water sheets and foam, with no spawned textures or meshes per entry. */
export class WaterEntrySplash {
  private readonly crown = makeRibbon(true);
  private readonly ring = makeRibbon(false);
  private readonly bursts: SplashBurst[];
  private next = 0;

  constructor(parent: THREE.Group) {
    this.bursts = Array.from({ length: 2 }, () => {
      const burst = new SplashBurst(this.crown, this.ring);
      parent.add(burst.group);
      return burst;
    });
  }

  emit(surface: THREE.Vector3, strength: number): void {
    this.bursts[this.next].start(surface, strength);
    this.next = (this.next + 1) % this.bursts.length;
  }

  update(dt: number): void {
    for (const burst of this.bursts) burst.update(dt);
  }

  dispose(): void {
    for (const burst of this.bursts) burst.dispose();
    this.crown.dispose();
    this.ring.dispose();
  }
}
