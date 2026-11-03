import * as THREE from 'three';
import { injectNightLights } from '../NightLighting';
import type { TerrainSystem } from '../TerrainSystem';
import { riverWorld } from './RiverWorld';
import { buildRiverGeometry } from './RiverMesh';
import type { RiverDef } from './RiverTypes';

/** Mist particles per metre of waterfall drop x width, capped per fall. */
const MIST_DENSITY = 2.2;
const MIST_MAX = 160;

const NOISE_GLSL = /* glsl */ `
float rHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rHash(i), rHash(i + vec2(1, 0)), f.x), mix(rHash(i + vec2(0, 1)), rHash(i + vec2(1, 1)), f.x), f.y);
}`;

/**
 * Renders the rivers and keeps the terrain in step with them.
 * - One ribbon mesh per river (frustum culled), all sharing one material: flowing ripples that
 *   scroll downstream, bank foam, and fast white streaks on waterfalls and rapids.
 * - One `Points` cloud for the mist at the foot of every waterfall, animated entirely in the
 *   vertex shader (no per-frame CPU work).
 * - Editing a river re-samples it, regenerates only the terrain rectangle it covers, and rebuilds
 *   just that ribbon.
 */
export class RiverSystem {
  public readonly group = new THREE.Group();
  private readonly material: THREE.MeshLambertMaterial;
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly mistMaterial: THREE.ShaderMaterial;
  private mist: THREE.Points | null = null;
  private readonly uniforms = { uTime: { value: 0 }, uDay: { value: 1 } };

  constructor(scene: THREE.Scene, private readonly terrain: TerrainSystem) {
    this.group.name = 'Rivers';
    scene.add(this.group);
    this.material = this.createMaterial();
    this.mistMaterial = this.createMistMaterial();
    this.rebuildAll();
  }

  // ---------------------------------------------------------------- editing API

  /** Call after changing a river's def in place: re-carves its area and rebuilds its mesh. */
  public updateRiver(id: string, applyToLive = true): void {
    this.terrain.refreshRivers(riverWorld.invalidate(id), applyToLive);
    this.rebuildMesh(id);
    this.rebuildMist();
  }

  public addRiver(def: RiverDef): void {
    riverWorld.defs = [...riverWorld.defs, def];
    this.updateRiver(def.id);
  }

  public removeRiver(id: string): void {
    this.terrain.refreshRivers(riverWorld.remove(id));
    this.disposeMesh(id);
    this.rebuildMist();
  }

  /** Swaps every river (undo / reload). Only the generated base moves unless `applyToLive`. */
  public replaceAll(defs: RiverDef[], applyToLive: boolean): void {
    this.terrain.refreshRivers(riverWorld.replaceAll(defs), applyToLive);
    this.rebuildAll();
  }

  public rebuildAll(): void {
    for (const id of [...this.meshes.keys()]) this.disposeMesh(id);
    for (const def of riverWorld.defs) this.rebuildMesh(def.id);
    this.rebuildMist();
  }

  // ---------------------------------------------------------------- frame

  public update(dt: number, nightFactor: number): void {
    this.uniforms.uTime.value += dt;
    this.mistMaterial.uniforms.uTime.value = this.uniforms.uTime.value;
    this.mistMaterial.uniforms.uBright.value = 1 - nightFactor * 0.8;
    this.uniforms.uDay.value = 1 - nightFactor;
  }

  /**
   * The loudest water near the listener for the ambience: the nearest waterfall within earshot,
   * otherwise the nearest stretch of river. `loud` is 0..1 before distance falloff.
   */
  public soundSource(listener: THREE.Vector3, out: THREE.Vector3): { loud: number; fall: boolean } | null {
    let best: { score: number; loud: number; fall: boolean } | null = null;
    for (const river of riverWorld.all()) {
      for (const f of river.falls) {
        const d = Math.hypot(f.x - listener.x, f.z - listener.z);
        const loud = Math.min(1, 0.45 + (f.top - f.bottom) * 0.06 + f.width * 0.03);
        const score = loud * (1 - d / 55);
        if (d < 55 && (!best || score > best.score)) {
          best = { score, loud, fall: true };
          out.set(f.x, (f.top + f.bottom) / 2, f.z);
        }
      }
      if (river.minX > listener.x + 20 || river.maxX < listener.x - 20 || river.minZ > listener.z + 20 || river.maxZ < listener.z - 20) continue;
      const S = river.samples;
      for (let k = 0; k < S.length; k += 2) {
        const q = S[k];
        const d = Math.hypot(q.x - listener.x, q.z - listener.z) - q.hw;
        if (d > 20) continue;
        const loud = Math.min(0.7, 0.2 + q.hw * 0.05 + q.foam * 0.3) * q.alpha;
        const score = loud * (1 - Math.max(0, d) / 20);
        if (!best || score > best.score) {
          best = { score, loud, fall: false };
          out.set(q.x, q.s, q.z);
        }
      }
    }
    return best && best.score > 0 ? { loud: best.loud, fall: best.fall } : null;
  }

  // ---------------------------------------------------------------- building

  private rebuildMesh(id: string): void {
    this.disposeMesh(id);
    const river = riverWorld.get(id);
    if (!river) return;
    const geo = buildRiverGeometry(river);
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `River_${id}`;
    mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    this.meshes.set(id, mesh);
    this.group.add(mesh);
  }

  private disposeMesh(id: string): void {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    this.group.remove(mesh);
    mesh.geometry.dispose();
    this.meshes.delete(id);
  }

  private rebuildMist(): void {
    if (this.mist) {
      this.group.remove(this.mist);
      this.mist.geometry.dispose();
      this.mist = null;
    }
    const pos: number[] = [];
    const seed: number[] = [];
    let rnd = 12345;
    const r = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
    for (const river of riverWorld.all()) {
      for (const f of river.falls) {
        const drop = f.top - f.bottom;
        const n = Math.min(MIST_MAX, Math.round(drop * f.width * MIST_DENSITY) + 12);
        for (let i = 0; i < n; i++) {
          // Spread across the plunge pool, a little downstream of the curtain
          const across = (r() - 0.5) * f.width;
          const along = r() * 2.2 - 0.4;
          pos.push(f.x - f.tz * across + f.tx * along, f.bottom, f.z + f.tx * across + f.tz * along);
          seed.push(r(), r(), drop, r());
        }
      }
    }
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 4));
    geo.computeBoundingSphere();
    if (geo.boundingSphere) geo.boundingSphere.radius += 8;
    this.mist = new THREE.Points(geo, this.mistMaterial);
    this.mist.name = 'WaterfallMist';
    this.mist.renderOrder = 3;
    this.group.add(this.mist);
  }

  // ---------------------------------------------------------------- materials

  private createMaterial(): THREE.MeshLambertMaterial {
    const mat = new THREE.MeshLambertMaterial({
      color: 0x3a9fc0,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mat.onBeforeCompile = (shader) => {
      injectNightLights(shader);
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.uniforms.uDay = this.uniforms.uDay;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aRiver;\nvarying vec3 vRiver;\nvarying vec2 vRiverUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRiver = aRiver;\nvRiverUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vRiver;\nvarying vec2 vRiverUv;\nuniform float uTime;\nuniform float uDay;\n${NOISE_GLSL}`)
        .replace(
          '#include <map_fragment>',
          `// Calm flow: stretched ripples drifting downstream
vec2 fp = vec2(vRiverUv.x, vRiverUv.y - uTime * 1.3);
float rip = rNoise(fp * vec2(0.9, 0.45)) * 0.6 + rNoise(fp * vec2(2.3, 1.1) + 7.0) * 0.4;
// White water: fast vertical streaks (only weighted in where foam is set, so speeds never shear)
vec2 sp = vec2(vRiverUv.x * 2.6, vRiverUv.y * 0.35 - uTime * 3.2);
float streak = rNoise(sp) * 0.65 + rNoise(sp * 2.7 + 3.1) * 0.35;
float foam = vRiver.x * smoothstep(0.32, 0.62, streak + vRiver.x * 0.25);
// Lacy foam where the water laps against the banks
foam = max(foam, smoothstep(0.82, 1.05, vRiver.z) * smoothstep(0.35, 0.75, rip) * 0.7);
vec3 water = mix(diffuseColor.rgb, vec3(0.78, 0.93, 0.98), smoothstep(0.55, 0.85, rip) * 0.35);
water *= 0.93 + rip * 0.1;
diffuseColor.rgb = mix(water, vec3(0.94, 0.97, 1.0), foam);
diffuseColor.a = mix(diffuseColor.a, 0.96, foam) * vRiver.y;`
        )
        // White water scatters light: keeps falls bright even on faces turned from the sun
        // (same scope as map_fragment, so `foam` is still in reach)
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.42, 0.46, 0.5) * foam * vRiver.x * uDay;'
        );
    };
    return mat;
  }

  private createMistMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uBright: { value: 1 } }]),
      vertexShader: /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  // Each puff rises, swells and drifts out from the plunge point, then starts over
  float life = fract(uTime * (0.22 + aSeed.y * 0.18) + aSeed.x);
  float drop = aSeed.z;
  float ang = aSeed.w * 6.2832;
  vec3 p = position;
  p.xz += vec2(cos(ang), sin(ang)) * life * (0.8 + drop * 0.12);
  p.y += life * (0.6 + drop * 0.35) + 0.15;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = (90.0 + drop * 14.0) * (0.45 + life * 0.8) / max(1.0, -mvPosition.z);
  vAlpha = sin(life * 3.1416) * 0.32;
  #include <fog_vertex>
}`,
      fragmentShader: /* glsl */ `
uniform float uBright;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.2, 1.0, d)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.92, 0.96, 1.0) * uBright, a);
  #include <fog_fragment>
}`,
    });
  }
}
