import * as THREE from 'three';
import { injectNightLights } from '../NightLighting';
import type { TerrainSystem } from '../TerrainSystem';
import { riverWorld } from './RiverWorld';
import { buildLakeGeometry, buildRiverGeometry } from './RiverMesh';
import type { RiverDef, RiverSample, WaterfallInfo } from './RiverTypes';

/** Foam spheres churning on a waterfall's landing line, at most. */
const SPLASH_MAX = 42;
/** A river is heard this far from its bank, a waterfall this far from where it lands (m). */
export const RIVER_EARSHOT = 22;
export const FALL_EARSHOT = 60;
/** Spatial hash cell for the river sound query (m). */
const SOUND_CELL = 16;

interface SoundSeg {
  a: RiverSample;
  b: RiverSample;
}

/** A waterfall's sound: fixed where the water lands. */
export interface FallSound {
  id: string;
  position: THREE.Vector3;
  loud: number;
}

const NOISE_GLSL = /* glsl */ `
float rHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rHash(i), rHash(i + vec2(1, 0)), f.x), mix(rHash(i + vec2(0, 1)), rHash(i + vec2(1, 1)), f.x), f.y);
}`;

/**
 * Renders the rivers and lakes and keeps the terrain in step with them.
 * - Each river is cut into ~64 m ribbon pieces and each lake is one mesh; they share two
 *   materials, so pieces off screen or past the camera's far plane are culled and cost nothing.
 *   Flowing ripples scroll downstream, bank foam laps the edges, white streaks run down falls and
 *   rapids, and rain rings dot the surface while it rains.
 * - Every waterfall has a ring of churning 3D foam spheres where the water lands, animated
 *   entirely in the vertex shader (no per-frame CPU work) and culled on its own.
 * - Sound: a spatial hash of the river segments finds the nearest point on any river centre line
 *   in a few dozen checks; waterfalls are fixed sound sources.
 * - Editing a river re-samples it, regenerates only the terrain rectangle it covers, and rebuilds
 *   just the meshes of the rivers that changed.
 */
export class RiverSystem {
  public readonly group = new THREE.Group();
  private readonly material: THREE.MeshLambertMaterial;
  private readonly lakeMaterial: THREE.MeshLambertMaterial;
  private readonly meshes = new Map<string, THREE.Object3D[]>();
  private readonly splashMaterial: THREE.MeshLambertMaterial;
  private readonly splashSphere = new THREE.IcosahedronGeometry(1, 1);
  private readonly uniforms = { uTime: { value: 0 }, uDay: { value: 1 }, uRain: { value: 0 } };
  private readonly soundGrid = new Map<number, SoundSeg[]>();
  private fallSounds: FallSound[] = [];

  constructor(scene: THREE.Scene, private readonly terrain: TerrainSystem) {
    this.group.name = 'Rivers';
    scene.add(this.group);
    this.material = this.createMaterial(false);
    this.lakeMaterial = this.createMaterial(true);
    this.splashMaterial = this.createSplashMaterial();
    this.rebuildAll();
  }

  // ---------------------------------------------------------------- editing API

  /** Call after changing a river's def in place: re-carves its area and rebuilds its mesh. */
  public updateRiver(id: string, applyToLive = true): void {
    this.terrain.refreshRivers(riverWorld.invalidate(id), applyToLive);
    // Branches and tributaries attached to it were re-sampled too
    for (const changed of riverWorld.lastChanged) this.rebuildMesh(changed);
    this.rebuildSound();
  }

  public addRiver(def: RiverDef): void {
    riverWorld.defs = [...riverWorld.defs, def];
    this.updateRiver(def.id);
  }

  public removeRiver(id: string): void {
    this.terrain.refreshRivers(riverWorld.remove(id));
    this.disposeMesh(id);
    for (const changed of riverWorld.lastChanged) this.rebuildMesh(changed);
    this.rebuildSound();
  }

  /** Swaps every river (undo / reload). Only the generated base moves unless `applyToLive`. */
  public replaceAll(defs: RiverDef[], applyToLive: boolean): void {
    this.terrain.refreshRivers(riverWorld.replaceAll(defs), applyToLive);
    this.rebuildAll();
  }

  public rebuildAll(): void {
    for (const id of [...this.meshes.keys()]) this.disposeMesh(id);
    for (const def of riverWorld.defs) this.rebuildMesh(def.id);
    this.rebuildSound();
  }

  // ---------------------------------------------------------------- frame

  /** `rain` 0..1 draws rain rings on the water. */
  public update(dt: number, nightFactor: number, rain = 0): void {
    this.uniforms.uTime.value += dt;
    this.uniforms.uDay.value = 1 - nightFactor;
    this.uniforms.uRain.value = rain;
    this.splashMaterial.emissive.setScalar(0.42 * (1 - nightFactor * 0.85));
  }

  /**
   * The nearest point on any river's centre line within earshot (a smooth, continuous position:
   * walking along the bank slides the sound with you instead of hopping between sample points).
   * Returns its loudness 0..1 before distance falloff, or 0 when no river is near.
   */
  public riverSound(listener: THREE.Vector3, out: THREE.Vector3): number {
    let best = 0;
    let bestLoud = 0;
    const cx = Math.floor(listener.x / SOUND_CELL), cz = Math.floor(listener.z / SOUND_CELL);
    const r = Math.ceil(RIVER_EARSHOT / SOUND_CELL);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const segs = this.soundGrid.get(cellKey(cx + dx, cz + dz));
        if (!segs) continue;
        for (const { a, b } of segs) {
          const ex = b.x - a.x, ez = b.z - a.z;
          const t = Math.max(0, Math.min(1, ((listener.x - a.x) * ex + (listener.z - a.z) * ez) / Math.max(1e-6, ex * ex + ez * ez)));
          const px = a.x + ex * t, pz = a.z + ez * t;
          const hw = a.hw + (b.hw - a.hw) * t;
          const d = Math.max(0, Math.hypot(px - listener.x, pz - listener.z) - hw);
          if (d > RIVER_EARSHOT) continue;
          const foam = a.foam + (b.foam - a.foam) * t;
          const alpha = a.alpha + (b.alpha - a.alpha) * t;
          const loud = Math.min(0.75, 0.22 + hw * 0.05 + foam * 0.35) * alpha;
          const score = loud * (1 - d / RIVER_EARSHOT);
          if (score > best) {
            best = score;
            bestLoud = loud;
            out.set(px, a.s + (b.s - a.s) * t, pz);
          }
        }
      }
    }
    return bestLoud;
  }

  /** Waterfalls within earshot, loudest first (at most `max`). Their positions never move. */
  public fallsNear(listener: THREE.Vector3, max: number, out: FallSound[]): FallSound[] {
    out.length = 0;
    for (const f of this.fallSounds) {
      const d = Math.hypot(f.position.x - listener.x, f.position.z - listener.z);
      if (d < FALL_EARSHOT) out.push(f);
    }
    const score = (f: FallSound) => f.loud * (1 - Math.hypot(f.position.x - listener.x, f.position.z - listener.z) / FALL_EARSHOT);
    out.sort((a, b) => score(b) - score(a));
    if (out.length > max) out.length = max;
    return out;
  }

  // ---------------------------------------------------------------- building

  private rebuildMesh(id: string): void {
    this.disposeMesh(id);
    const river = riverWorld.get(id);
    if (!river) return;
    const objs: THREE.Object3D[] = [];
    if (river.def.kind === 'lake') {
      const geo = buildLakeGeometry(river);
      if (geo) objs.push(this.waterMesh(geo, this.lakeMaterial, `Lake_${id}`));
    } else {
      buildRiverGeometry(river).forEach((geo, i) => objs.push(this.waterMesh(geo, this.material, `River_${id}_${i}`)));
      for (const f of river.falls) objs.push(...this.buildFallEffects(f));
    }
    for (const o of objs) this.group.add(o);
    this.meshes.set(id, objs);
  }

  private waterMesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  private disposeMesh(id: string): void {
    const objs = this.meshes.get(id);
    if (!objs) return;
    for (const o of objs) {
      this.group.remove(o);
      (o as THREE.Mesh).geometry.dispose();
    }
    this.meshes.delete(id);
  }

  /**
   * A waterfall's churning foam: 3D spheres strung along the landing line that swell up out of
   * the water and sink back, hiding the seam between the falling curtain and the pool. One draw
   * call, culled with the fall.
   */
  private buildFallEffects(f: WaterfallInfo): THREE.Object3D[] {
    let rnd = Math.floor(Math.abs(f.x * 73.1 + f.z * 19.7)) + 12345;
    const r = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
    const drop = f.top - f.bottom;
    const nx = -f.tz, nz = f.tx;

    // Foam spheres
    const m = Math.min(SPLASH_MAX, Math.round(f.width * 2 + drop * 1.5) + 6);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = this.splashSphere.index;
    geo.setAttribute('position', this.splashSphere.getAttribute('position'));
    geo.setAttribute('normal', this.splashSphere.getAttribute('normal'));
    const base = new Float32Array(m * 3);
    const sd = new Float32Array(m * 4);
    const big = 0.8 + Math.min(drop, 8) * 0.09;
    for (let i = 0; i < m; i++) {
      const across = ((i + r() * 0.8) / m - 0.5) * f.width * 1.1;
      const along = (r() - 0.35) * 1.4;
      base.set([f.x + nx * across + f.tx * along, f.bottom - 0.05, f.z + nz * across + f.tz * along], i * 3);
      // seed, speed, radius, direction
      sd.set([r(), r(), (0.32 + r() * 0.5) * big, r()], i * 4);
    }
    geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(base, 3));
    geo.setAttribute('aSplash', new THREE.InstancedBufferAttribute(sd, 4));
    geo.instanceCount = m;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(f.x, f.bottom, f.z), f.width * 0.6 + 4);
    const foam = new THREE.Mesh(geo, this.splashMaterial);
    foam.name = 'WaterfallFoam';
    foam.renderOrder = 1;
    foam.matrixAutoUpdate = false;
    return [foam];
  }

  /** Segments of every river into the sound hash, and the waterfalls' fixed sources. */
  private rebuildSound(): void {
    this.soundGrid.clear();
    this.fallSounds = [];
    for (const river of riverWorld.all()) {
      if (river.def.kind === 'lake') continue;
      const S = river.samples;
      for (let k = 0; k + 1 < S.length; k += 2) {
        const a = S[k], b = S[Math.min(S.length - 1, k + 2)];
        if (a.alpha < 0.05 && b.alpha < 0.05) continue;
        const pad = Math.max(a.hw, b.hw);
        const x0 = Math.floor((Math.min(a.x, b.x) - pad) / SOUND_CELL), x1 = Math.floor((Math.max(a.x, b.x) + pad) / SOUND_CELL);
        const z0 = Math.floor((Math.min(a.z, b.z) - pad) / SOUND_CELL), z1 = Math.floor((Math.max(a.z, b.z) + pad) / SOUND_CELL);
        for (let cz = z0; cz <= z1; cz++) {
          for (let cx = x0; cx <= x1; cx++) {
            const key = cellKey(cx, cz);
            let list = this.soundGrid.get(key);
            if (!list) this.soundGrid.set(key, (list = []));
            list.push({ a, b });
          }
        }
      }
      river.falls.forEach((f, i) => {
        this.fallSounds.push({
          id: `${river.def.id}#${i}`,
          position: new THREE.Vector3(f.x, (f.top + f.bottom) / 2, f.z),
          loud: Math.min(1, 0.45 + (f.top - f.bottom) * 0.06 + f.width * 0.03),
        });
      });
    }
  }

  // ---------------------------------------------------------------- materials

  private createMaterial(lake: boolean): THREE.MeshLambertMaterial {
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
      shader.uniforms.uRain = this.uniforms.uRain;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aRiver;\nvarying vec4 vRiver;\nvarying vec2 vRiverUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRiver = aRiver;\nvRiverUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec4 vRiver;\nvarying vec2 vRiverUv;\nuniform float uTime;\nuniform float uDay;\nuniform float uRain;\n${NOISE_GLSL}`)
        .replace(
          '#include <map_fragment>',
          `// Calm flow: stretched ripples drifting downstream (lakes: slow, round ripples that barely move)
${lake ? 'vec2 fp = vRiverUv * 0.55 + vec2(uTime * 0.05, uTime * 0.03);' : 'vec2 fp = vec2(vRiverUv.x, vRiverUv.y - uTime * 1.3);'}
float rip = rNoise(fp * vec2(0.9, ${lake ? '0.9' : '0.45'})) * 0.6 + rNoise(fp * vec2(2.3, ${lake ? '2.3' : '1.1'}) + 7.0) * 0.4;
// White water: fast vertical streaks (only weighted in where foam is set, so speeds never shear)
vec2 sp = vec2(vRiverUv.x * 2.6, vRiverUv.y * 0.35 - uTime * 3.2);
float streak = rNoise(sp) * 0.65 + rNoise(sp * 2.7 + 3.1) * 0.35;
float foam = vRiver.x * smoothstep(0.32, 0.62, streak + vRiver.x * 0.25);
// Lacy foam where the water laps against the banks
foam = max(foam, smoothstep(0.82, 1.05, vRiver.z) * smoothstep(0.35, 0.75, rip) * 0.7);
vec3 water = mix(diffuseColor.rgb, vec3(0.78, 0.93, 0.98), smoothstep(0.55, 0.85, rip) * 0.35);
water *= 0.93 + rip * 0.1;
// Rain: small rings spreading where drops hit, one per 0.6 m cell at a random spot and phase
if (uRain > 0.01) {
  vec2 rp = vRiverUv * 1.7;
  vec2 ci = floor(rp);
  float ph = fract(uTime * 1.4 + rHash(ci) * 7.0);
  vec2 c = vec2(rHash(ci + 3.1), rHash(ci + 7.7)) * 0.6 + 0.2;
  float ring = 1.0 - smoothstep(0.0, 0.06, abs(length(fract(rp) - c) - ph * 0.42));
  water += vec3(0.16) * ring * (1.0 - ph) * step(rHash(ci + 1.3), uRain * 0.8);
}
// Estuary: the colour turns into the sea's, a lighter silty plume drifts out past the shore, and
// a soft band of foam marks where the current meets the waves
float mouth = vRiver.w;
float est = min(mouth, 1.0);
float plume = smoothstep(0.3, 1.0, mouth) * (1.0 - smoothstep(1.4, 2.0, mouth)) * smoothstep(0.4, 0.8, rNoise(fp * 0.35 + 11.0));
water = mix(water, vec3(0.25, 0.65, 0.79), est * 0.6);
water = mix(water, vec3(0.62, 0.78, 0.72), plume * 0.35);
float meet = smoothstep(0.85, 1.0, mouth) * (1.0 - smoothstep(1.0, 1.35, mouth));
foam = max(foam, meet * smoothstep(0.5, 0.8, rNoise(vec2(vRiverUv.x * 1.3, vRiverUv.y * 0.6 + uTime * 0.4) + 5.0)) * 0.6);
foam *= 1.0 - smoothstep(1.3, 1.8, mouth);
diffuseColor.rgb = mix(water, vec3(0.94, 0.97, 1.0), foam);
diffuseColor.a = mix(diffuseColor.a, 0.96, foam) * vRiver.y;
// Over open water no bank hides the ribbon's sides: feather them out in the estuary, with a
// ragged noisy edge so the plume has no straight outline
float edgeNoise = rNoise(vec2(vRiverUv.x * 0.4, vRiverUv.y * 0.25 - uTime * 0.3)) * 0.35;
diffuseColor.a *= mix(1.0, 1.0 - smoothstep(0.35 + edgeNoise, 1.0, vRiver.z), smoothstep(0.6, 1.0, mouth));`
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

  /** Lit foam spheres; the vertex shader animates each instance (bob up, swell, drift, sink). */
  private createSplashMaterial(): THREE.MeshLambertMaterial {
    const mat = new THREE.MeshLambertMaterial({ color: 0xeef6fb, emissive: 0x6b6b6b });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aBase;\nattribute vec4 aSplash;\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `float life = fract(uTime * (0.5 + aSplash.y * 0.45) + aSplash.x);
float ang = aSplash.w * 6.2832;
float swell = sin(life * 3.1416);
vec3 centre = aBase;
centre.xz += vec2(cos(ang), sin(ang)) * life * (0.5 + aSplash.z * 0.6);
centre.y += swell * aSplash.z * 0.55 - (1.0 - swell) * aSplash.z * 0.6;
vec3 transformed = position * aSplash.z * (0.3 + 0.7 * swell) + centre;`
        );
    };
    return mat;
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096);
}
