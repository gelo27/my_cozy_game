import * as THREE from 'three';
import { injectNightLights } from '../NightLighting';
import type { TerrainSystem } from '../TerrainSystem';
import { riverWorld } from './RiverWorld';
import { WATER_DETAIL_GLSL, WATER_RIPPLE_GLSL, rippleUniforms } from '../../scene/WaterDetails';
import { WATER_LIGHT_GLSL, WATER_NORMAL_GLSL, WATER_SURFACE_GLSL, waterSurfaceUniforms } from '../WaterSurface';
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
 *   The water is the sea's (WaterSurface.ts: depth colour, waves, glints, shore lines), its waves
 *   carried downstream; white streaks run down falls and rapids.
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
  private readonly uniforms = { uTime: { value: 0 }, uDay: { value: 1 } };
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

  public update(dt: number, nightFactor: number): void {
    this.uniforms.uTime.value += dt;
    this.uniforms.uDay.value = 1 - nightFactor;
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
    // Opaque (like the sea): no blending or sorting. Where the ribbon used to fade out (its ends,
    // the estuary over the sea) pixels are dropped with a screen-space dither instead. Pulled a
    // little toward the camera so it never z-fights the sea plane in the estuary.
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    // The lake and river programs differ (attributes, flow), so they must not share one
    mat.customProgramCacheKey = () => (lake ? 'water-lake' : 'water-river');
    mat.onBeforeCompile = (shader) => {
      injectNightLights(shader);
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.uniforms.uDay = this.uniforms.uDay;
      Object.assign(shader.uniforms, waterSurfaceUniforms, rippleUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec4 aRiver;
${lake ? '' : 'attribute vec2 aFlow;\nvarying vec2 vFlow;'}
varying vec4 vRiver;
varying vec2 vRiverUv;
varying vec3 vRipW;
varying vec3 vWN;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vRiver = aRiver;
vRiverUv = uv;
${lake ? '' : 'vFlow = aFlow;'}
vRipW = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWN = normalize(mat3(modelMatrix) * objectNormal);`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec4 vRiver;
varying vec2 vRiverUv;
varying vec3 vRipW;
varying vec3 vWN;
${lake ? '' : 'varying vec2 vFlow;'}
uniform float uTime;
uniform float uDay;
${NOISE_GLSL}
${WATER_DETAIL_GLSL}
${WATER_RIPPLE_GLSL}
${WATER_SURFACE_GLSL}`
        )
        .replace(
          '#include <map_fragment>',
          `// The same water as the sea (WaterSurface.ts): depth colour from the terrain heights (river
// beds are carved into the same terrain), normal-map waves, glints and shore lines
float rDepth = max(vRipW.y - wsBedY(vRipW.xz), 0.0);
float rDist = distance(vRipW, cameraPosition);
${lake
  ? 'vec2 wp = vRiverUv; // lakes: world XZ, the waves just drift like the sea\'s'
  : 'vec2 wp = vec2(vRiverUv.x, vRiverUv.y - uWsTime * 1.1); // (across, along) metres, carried downstream'}
float shade, wobble;
vec2 slope = wsWaves(wp, rDist, shade, wobble);
${lake ? '' : '// (across, along) back to world XZ\nslope = slope.x * vec2(-vFlow.y, vFlow.x) + slope.y * vFlow;'}
// Simulated waves around the player (developer toggle)
float simH;
vec2 simG;
wdSimSample(vRipW.xz, simH, simG);
slope += simG * uWdSimLook.y;
// Tilt the surface's own normal (flat water: up, like the sea; waterfall curtains lean out)
wsN = normalize(vWN + vec3(slope.x, 0.0, slope.y));
vec3 water = wsColour(rDepth, shade);

// White water: fast streaks down falls and rapids (only where foam is set)
vec2 sp = vec2(vRiverUv.x * 2.6, vRiverUv.y * 0.35 - uTime * 3.2);
float streak = rNoise(sp) * 0.65 + rNoise(sp * 2.7 + 3.1) * 0.35;
float foam = vRiver.x * smoothstep(0.32, 0.62, streak + vRiver.x * 0.25);

// Distance to the bank (m): a lake's edge distance, or the channel half width minus the offset
${lake
  ? 'float bankD = (1.0 - clamp(vRiver.z, 0.0, 1.0)) * 3.0;'
  : 'float bankD = vRiver.z > 0.12 ? abs(vRiverUv.x) * (1.0 - vRiver.z) / vRiver.z : 99.0;\n// Channel half width, so the lines from the two banks stay well apart\nfloat halfW = vRiver.z > 0.12 ? abs(vRiverUv.x) / vRiver.z : 99.0;'}
float bankAa = fwidth(bankD);
${lake
  ? 'vec2 dashP = vRiverUv;'
  : '// Dashes run along each bank and drift with the current\nvec2 dashP = vec2(vRiverUv.y - uTime * 0.25, vRiverUv.x > 0.0 ? 37.0 : 0.0);'}
water = mix(water, uWsShallow * 1.25, (1.0 - smoothstep(0.0, 1.6, max(bankD, 0.0))) * 0.3);
float shore = wsShoreLines(bankD, dashP, bankAa, 0.0, ${lake ? '99.0' : 'halfW * 0.45 - 0.3'}) * (1.0 - smoothstep(60.0, 140.0, rDist));
// Where the water touches the land: the sea's thin broken line, from the real depth
float lineD = rDepth + wobble * 0.02;
float lineBreak = smoothstep(0.3, 0.5, wdNoise(vRipW.xz * 0.9 + uWsTime * 0.04));
shore = max(shore, (1.0 - smoothstep(uWsFoam.x * 0.5, uWsFoam.x * 0.5 + fwidth(lineD) * 1.5 + 0.004, lineD)) * mix(0.35, 1.0, lineBreak));
foam = max(foam, shore * uWsShine.w);
// Ripple rings from the swimmer / wader (world space, shared with the sea)
// (derivatives first: the distance test skips the loop for far pixels)
float ripAa = length(fwidth(vRipW.xz));
float ripRings = rDist < 80.0 ? wdRipples(vRipW.xz, ripAa) * (1.0 - smoothstep(45.0, 80.0, rDist)) : 0.0;
float simAa = fwidth(simH);
ripRings = max(ripRings, wdSimCrest(simH, simAa));
// Estuary: a lighter silty plume drifts out past the shore, and a soft band of foam marks where
// the current meets the waves (the colour already matches the sea: it is the same water)
float mouth = vRiver.w;
vec2 fp = wp * 0.55;
float plume = smoothstep(0.3, 1.0, mouth) * (1.0 - smoothstep(1.4, 2.0, mouth)) * smoothstep(0.4, 0.8, rNoise(fp * 0.35 + 11.0));
water = mix(water, vec3(0.62, 0.78, 0.72), plume * 0.25);
float meet = smoothstep(0.85, 1.0, mouth) * (1.0 - smoothstep(1.0, 1.35, mouth));
foam = max(foam, meet * smoothstep(0.5, 0.8, rNoise(vec2(vRiverUv.x * 1.3, vRiverUv.y * 0.6 + uTime * 0.4) + 5.0)) * 0.6);
foam *= 1.0 - smoothstep(1.3, 1.8, mouth);
foam = clamp(max(foam, ripRings * 0.85), 0.0, 1.0);
wsFoam = foam;
diffuseColor.rgb = mix(water, uWsFoamCol, foam);
diffuseColor.a = mix(1.0, 0.96, foam) * vRiver.y;
// Over open water no bank hides the ribbon's sides: feather them out in the estuary, with a
// ragged noisy edge so the plume has no straight outline
float edgeNoise = rNoise(vec2(vRiverUv.x * 0.4, vRiverUv.y * 0.25 - uTime * 0.3)) * 0.35;
diffuseColor.a *= mix(1.0, 1.0 - smoothstep(0.35 + edgeNoise, 1.0, vRiver.z), smoothstep(0.6, 1.0, mouth));
// Opaque surface: the fade becomes a stable screen-space dither (interleaved gradient noise)
float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
// (foam used to be 96 % opaque: that still counts as solid)
float keep = min(diffuseColor.a / 0.96, 1.0);
if (keep < 0.999 && keep < ign) discard;
diffuseColor.a = 1.0;`
        )
        .replace('#include <normal_fragment_maps>', WATER_NORMAL_GLSL)
        // White water scatters light: keeps falls bright even on faces turned from the sun
        // (same scope as map_fragment, so `foam` is still in reach)
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.42, 0.46, 0.5) * foam * vRiver.x * uDay;'
        )
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${WATER_LIGHT_GLSL}`);
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
