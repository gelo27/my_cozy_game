import * as THREE from 'three';
import { riverWorld } from './rivers/RiverWorld';
import { SEA_FLOOR_Y, WORLD_SIZE } from './WorldSettings';
import { waterSettings } from './WaterSettings';
import { DUCKWEED_GLSL, duckweedUniforms } from './Duckweed';
import { pondTint } from './PondTint';
import { onUserSettingsChange, userSettings } from '../config/userSettings';
import { BOAT_CHINE_Y, BOAT_HALF_LENGTH, BOAT_HALF_WIDTH, BOAT_HULL_SECTIONS } from '../vehicle/BoatModel';

/**
 * The one water look, shared by the sea (WaterSystem) and the rivers / lakes (RiverSystem):
 * - colour by real depth: the terrain heights are kept in a half-float texture, so every water
 *   pixel (sea, river or lake: river beds are carved into the same terrain) knows how far down
 *   the bed is: turquoise shallows, deep blue further out;
 * - waves: two scrolling samples of a normal map tilt the surface normal, which drives the
 *   diffuse light, a sharp sun glint and a Fresnel sky reflection at grazing angles; the detail
 *   calms down with distance. Rivers sample it in their own (across, along) metres, scrolled
 *   downstream, and turn the slope back into world space with the flow direction;
 * - shore lines: thin white strokes parallel to the shore that drift in, thin out and vanish,
 *   cut into tapered dashes (both ends narrow to nothing). They are drawn at a distance from the
 *   shore in metres: for the sea from a distance-to-shore texture built from the terrain, for a
 *   river from its bank distance (an attribute), so they hug the coastline evenly whatever the
 *   slope of the bed;
 * - from below (camera under water) the surface is a dim ceiling with a bright Snell's window.
 */

const HALF = WORLD_SIZE / 2;
const V = WORLD_SIZE + 1;
/** Shore distance texture covers 0..SHORE_RANGE metres (bytes, linear filtered). */
const SHORE_RANGE = 8;
const LITE_WAVE_START = 24;
const LITE_WAVE_END = 42;
const BOAT_MASK_RADIUS = Math.hypot(BOAT_HALF_LENGTH, BOAT_HALF_WIDTH, 0.65);

export const waterSurfaceUniforms = {
  uWsBoatBounds: { value: new THREE.Vector3() },
  uWsBoatInverse: { value: new THREE.Matrix4() },
  uWsBoatSections: { value: BOAT_HULL_SECTIONS.map(({ width, keel, sheer }) => new THREE.Vector3(width, keel, sheer)) },
  uWsLite: { value: Number(userSettings.graphicsQuality === 'performance') },
  uWsTime: { value: 0 },
  uEstuary: { value: riverWorld.estuary },
  uWsNormals: { value: null as THREE.Texture | null },
  /** Terrain heights (m, half float), one texel per terrain vertex. */
  uWsBed: { value: null as THREE.Texture | null },
  uWsSeaFloorY: { value: SEA_FLOOR_Y },
  /** Distance to the nearest shore (0..1 = 0..SHORE_RANGE m), for the sea's shore lines. */
  uWsShore: { value: null as THREE.Texture | null },
  uWsShallow: { value: new THREE.Color() },
  uWsDeep: { value: new THREE.Color() },
  uWsPondMask: { value: pondTint.texture },
  uWsPondBounds: { value: pondTint.bounds },
  uWsPondShallow: { value: new THREE.Color() },
  uWsPondDeep: { value: new THREE.Color() },
  uWsFoamCol: { value: new THREE.Color() },
  /** x depthFalloff, y waveNear, z waveFar, w waveSpeed */
  uWsWaveA: { value: new THREE.Vector4() },
  /** x scale1, y scale2, z detailStart, w detailEnd */
  uWsWaveB: { value: new THREE.Vector4() },
  /** x fresnel, y glint, z glintSharpness, w foamAmount */
  uWsShine: { value: new THREE.Vector4() },
  /** x waterline (m of depth), y shore lines on (0/1), z cycles per second */
  uWsFoam: { value: new THREE.Vector3() },
  /** x line count, y half width (m), z reach (m), w dash density (1/m) */
  uWsShoreA: { value: new THREE.Vector4() },
  /** x gap 0..1 */
  uWsShoreB: { value: new THREE.Vector4() },
  /** Sparkles: x brightness (0 = off), y slope tolerance, z facets per metre, w slope spread */
  uWsSparkle: { value: new THREE.Vector4() },
  ...duckweedUniforms,
};

/** Track the rendered hull, including its bob, pitch and roll. */
export function setWaterBoatHull(hull: THREE.Object3D | null): void {
  const { uWsBoatBounds, uWsBoatInverse } = waterSurfaceUniforms;
  if (!hull?.visible || !hull.parent?.visible) {
    uWsBoatBounds.value.z = 0;
    return;
  }
  hull.updateWorldMatrix(true, false);
  const { elements } = hull.matrixWorld;
  uWsBoatBounds.value.set(elements[12], elements[14], BOAT_MASK_RADIUS);
  uWsBoatInverse.value.copy(hull.matrixWorld).invert();
}

onUserSettingsChange(() => {
  waterSurfaceUniforms.uWsLite.value = Number(userSettings.graphicsQuality === 'performance');
});

const normals = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}water_normals.jpg`);
normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
normals.colorSpace = THREE.NoColorSpace;
normals.anisotropy = 4;
waterSurfaceUniforms.uWsNormals.value = normals;

/** Per frame: the clock, and the developer-panel settings into the uniforms. */
export function updateWaterSurface(dt: number): void {
  const u = waterSurfaceUniforms;
  const ws = waterSettings;
  u.uWsTime.value += dt;
  u.uWsShallow.value.set(ws.shallowColor);
  u.uWsPondShallow.value.set(ws.pondShallowColor);
  u.uWsPondDeep.value.set(ws.pondDeepColor);
  u.uWsDeep.value.set(ws.deepColor);
  u.uWsFoamCol.value.set(ws.foamColor);
  u.uWsWaveA.value.set(ws.depthFalloff, ws.waveNear, ws.waveFar, ws.waveSpeed);
  u.uWsWaveB.value.set(ws.waveScale1, ws.waveScale2, ws.detailStart, Math.max(ws.detailEnd, ws.detailStart + 1));
  u.uWsShine.value.set(ws.fresnel, ws.glint, ws.glintSharpness, ws.foamAmount);
  u.uWsFoam.value.set(ws.foamLine, ws.rippleFoam ? 1 : 0, ws.rippleSpeed);
  u.uWsShoreA.value.set(Math.round(ws.shoreLineCount), ws.shoreLineWidth, ws.shoreLineReach, ws.shoreLineDash);
  u.uWsShoreB.value.set(ws.shoreLineGap, 0, 0, 0);
  u.uWsSparkle.value.set(ws.sparkle, Math.max(ws.sparkleDensity, 1e-3), 1 / Math.max(ws.sparkleSize, 0.02), Math.max(ws.sparkleSpread, 0.01));
}

/**
 * Bed height and wave slope (GLSL, safe in a vertex shader too: no derivatives). Needs uWsTime,
 * uWsNormals, uWsBed, uWsWaveA, uWsWaveB declared before it.
 */
export const WATER_SHARED_GLSL = /* glsl */ `
/** Terrain texture uv of a world point, and 1 inside the island / 0 outside. */
vec2 wsBedUv(vec2 xz) { return (xz + ${(HALF + 0.5).toFixed(1)}) / ${V.toFixed(1)}; }
float wsInIsland(vec2 xz) { return step(abs(xz.x), ${HALF.toFixed(1)}) * step(abs(xz.y), ${HALF.toFixed(1)}); }
/** Height of the bed under a point (outside the island: the flat sea floor). */
float wsBedY(vec2 xz) { return mix(uWsSeaFloorY, texture2D(uWsBed, wsBedUv(xz)).r, wsInIsland(xz)); }
/**
 * Wave slope at p (in the frame p is measured in), calmer with camera distance; shade = a little
 * light / dark from the waves, wob = a small wobble for edges.
 */
vec2 wsWaves(vec2 p, float dist, out float shade, out float wob) {
  float detail = 1.0 - smoothstep(uWsWaveB.z, uWsWaveB.w, dist);
  vec3 n1 = texture2D(uWsNormals, p * uWsWaveB.x + uWsTime * uWsWaveA.w * vec2(0.011, 0.007)).xyz * 2.0 - 1.0;
  vec3 n2 = n1;
  #ifdef WATER_SURFACE_FRAGMENT
  if (uWsLite > 0.5) {
    // Compute derivatives before branching so mip selection stays defined at the LOD boundary.
    vec2 uv = p * uWsWaveB.y + uWsTime * uWsWaveA.w * vec2(-0.015, 0.010);
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    float layerMix = 1.0 - smoothstep(${LITE_WAVE_START.toFixed(1)}, ${LITE_WAVE_END.toFixed(1)}, dist);
    if (layerMix > 0.0) n2 = mix(n1, textureGrad(uWsNormals, uv, dx, dy).xyz * 2.0 - 1.0, layerMix);
  } else
  #endif
  {
    n2 = texture2D(uWsNormals, p * uWsWaveB.y + uWsTime * uWsWaveA.w * vec2(-0.015, 0.010)).xyz * 2.0 - 1.0;
  }
  shade = 0.94 + (n1.z + n2.z) * 0.04;
  wob = (n1.x + n2.y) * 0.6;
  return (n1.xy * 0.6 + n2.xy * 0.4) * mix(uWsWaveA.z, uWsWaveA.y, detail);
}
float wsHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
/**
 * One sparkle facet of the cell id of a world grid. need = the extra slope the water there would
 * need to mirror the light into the eye: 0 in the middle of the glint, growing away from it.
 * Facets within spread of it can catch the light (a jittered edge, so the path is no hard
 * ellipse); a share of them (density, fewer toward the edge) flash at a time. Every facet
 * re-rolls a few times a second, each in its own rhythm, and flashes up and down within a roll.
 * Returns 0..1, and the facet's spot inside the cell (cell units) in spot.
 */
float wsSparkleFacet(vec2 id, vec2 need, float density, float spread, float rate, out vec2 spot) {
  float h = wsHash(id);
  float c = uWsTime * rate * (0.6 + h * 0.8) + h * 9.0;
  vec2 e = id + floor(c) * vec2(17.13, 31.71);
  spot = (vec2(wsHash(e + 11.9), wsHash(e + 23.1)) - 0.5) * 0.6;
  vec2 s = (vec2(wsHash(e + 41.7), wsHash(e + 57.3)) - 0.5) * spread * 0.6;
  float k = max(0.0, 1.0 - length(need - s) / spread);
  return step(wsHash(e), density * k) * k * sin(3.14159265 * fract(c));
}
`;

/** Shared by the water surfaces and the sea's sparkle sprites. */
export const WATER_BOAT_GLSL = /* glsl */ `
uniform vec3 uWsBoatBounds; // world xz and enclosing radius (0 = disabled)
uniform mat4 uWsBoatInverse;
uniform vec3 uWsBoatSections[${BOAT_HULL_SECTIONS.length}];

float wsBoatPanelWidth(float y, float t, vec2 lowerA, vec2 upperA, vec2 lowerB, vec2 upperB) {
  vec2 lower = mix(lowerA, lowerB, t);
  vec2 upper = mix(upperA, upperB, t);
  vec2 diagonal = mix(upperA, lowerB, t);
  // Match the two triangles of the model panel. Each pair holds height and half-width.
  if (y <= diagonal.x) return mix(lower.y, diagonal.y, (y - lower.x) / max(diagonal.x - lower.x, 0.00001));
  return mix(diagonal.y, upper.y, (y - diagonal.x) / max(upper.x - diagonal.x, 0.00001));
}

bool wsInsideBoat(vec3 worldPosition) {
  vec2 offset = abs(worldPosition.xz - uWsBoatBounds.xy);
  if (max(offset.x, offset.y) >= uWsBoatBounds.z) return false;
  vec3 p = (uWsBoatInverse * vec4(worldPosition, 1.0)).xyz;
  const float hullHalfLength = ${BOAT_HALF_LENGTH.toFixed(3)};
  if (abs(p.z) >= hullHalfLength || abs(p.x) >= ${BOAT_HALF_WIDTH.toFixed(3)}) return false;
  float station = (p.z + hullHalfLength) * ${((BOAT_HULL_SECTIONS.length - 1) / (2 * BOAT_HALF_LENGTH)).toFixed(9)};
  int i = min(int(station), ${BOAT_HULL_SECTIONS.length - 2});
  float t = station - float(i);
  vec3 a = uWsBoatSections[i], b = uWsBoatSections[i + 1];
  vec2 yLimits = mix(a.yz, b.yz, t);
  if (p.y <= yLimits.x || p.y >= yLimits.y) return false;
  const float chineY = ${BOAT_CHINE_Y.toFixed(3)};
  vec2 chineA = vec2(chineY, a.x * 0.9), chineB = vec2(chineY, b.x * 0.9);
  float width = p.y < chineY
    ? wsBoatPanelWidth(p.y, t, vec2(a.y, 0.0), chineA, vec2(b.y, 0.0), chineB)
    : wsBoatPanelWidth(p.y, t, chineA, vec2(a.z, a.x), chineB, vec2(b.z, b.x));
  return abs(p.x) < width;
}
`;

/**
 * Declarations and helpers (fragment shader, after #include <common>; needs WATER_DETAIL_GLSL
 * for wdNoise). Globals wsN / wsFoam are filled in map_fragment and read by the lighting.
 */
export const WATER_SURFACE_GLSL = /* glsl */ `
${WATER_BOAT_GLSL}
uniform float uWsLite;
uniform float uWsTime;
uniform sampler2D uWsNormals;
uniform sampler2D uWsBed;
uniform float uWsSeaFloorY;
uniform sampler2D uWsShore;
uniform vec3 uWsShallow;
uniform vec3 uWsDeep;
uniform sampler2D uWsPondMask;
uniform vec4 uWsPondBounds;
uniform vec3 uWsPondShallow;
uniform vec3 uWsPondDeep;
uniform vec3 uWsFoamCol;
uniform vec4 uWsWaveA;
uniform vec4 uWsWaveB;
uniform vec4 uWsShine;
uniform vec3 uWsFoam;
uniform vec4 uWsShoreA;
uniform vec4 uWsShoreB;
uniform vec4 uWsSparkle;
vec3 wsN;
float wsFoam;
#define WATER_SURFACE_FRAGMENT
${WATER_SHARED_GLSL}
#undef WATER_SURFACE_FRAGMENT
uniform sampler2D uEstuary;
vec2 wsCurrentWaves(vec2 xz, vec2 current, float dist, out float shade, out float wobble) {
// Two offset phases let the current bend without stretching the waves over time.
if (uWsLite > 0.5) {
  current *= 1.0 - smoothstep(${LITE_WAVE_START.toFixed(1)}, ${LITE_WAVE_END.toFixed(1)}, dist);
}
float phase = fract(uWsTime * 0.2);
vec2 slope = wsWaves(xz - current * (phase * 5.0), dist, shade, wobble);
if (dot(current, current) > 0.000001) {
  float shadeB, wobbleB;
  vec2 other = wsWaves(xz - current * (fract(phase + 0.5) * 5.0), dist, shadeB, wobbleB);
  float blend = abs(2.0 * phase - 1.0);
  slope = mix(slope, other, blend);
  shade = mix(shade, shadeB, blend);
  wobble = mix(wobble, wobbleB, blend);
}
  return slope;
}
float wsPondTint(vec2 xz) {
  if (any(lessThan(xz, uWsPondBounds.xy)) || any(greaterThan(xz, uWsPondBounds.zw))) return 0.0;
  return textureLod(uWsPondMask, xz / ${WORLD_SIZE.toFixed(1)} + 0.5, 0.0).r;
}

vec3 wsColour(float depth, float shade, vec3 shallow, float pond) {
  return mix(shallow, mix(uWsDeep, uWsPondDeep, pond), 1.0 - exp(-depth * uWsWaveA.x)) * shade;
}
/**
 * Shore lines at d metres from the shore. dashP = where along the shore (world xz, or metres
 * along a river bank), aa = fwidth(d). Each line is born at the reach, drifts in, grows and thins
 * to nothing; it is cut into dashes whose width eases to zero at both ends. reachMax caps how far
 * out lines are born (a narrow river: well short of the middle). No derivatives inside.
 */
float wsShoreLines(float d, vec2 dashP, float aa, float seed, float reachMax) {
  float reach = min(uWsShoreA.z, reachMax);
  if (uWsFoam.y < 0.5 || reach < 0.05 || d > reach + 0.6) return 0.0;
  aa = max(aa, 1e-4);
  float v = 0.0;
  for (int k = 0; k < 4; k++) {
    if (float(k) >= uWsShoreA.x) break;
    float c = uWsTime * uWsFoam.z * 0.5 + float(k) / uWsShoreA.x;
    float ph = fract(c);
    float gen = floor(c) + seed + float(k) * 7.31;
    // A gentle meander, so the line is not a perfect offset of the shore
    float wob = (wdNoise(dashP * 0.35 + gen * 3.1) - 0.5) * 0.3;
    float lineD = 0.3 + reach * (1.0 - ph) + wob * min(1.0, reach);
    float life = sin(3.14159265 * ph);
    float n = wdNoise(dashP * uWsShoreA.w + vec2(gen * 13.7, gen * 5.3));
    float taper = smoothstep(uWsShoreB.x, uWsShoreB.x + 0.25, n);
    float hw = uWsShoreA.y * life * taper;
    float dd = abs(d - lineD);
    v = max(v, (1.0 - smoothstep(hw, hw + aa, dd)) * min(1.0, 2.0 * hw / aa));
  }
  // Lines thinner than a pixel far away: fade instead of flicker
  return v * (1.0 - smoothstep(0.06, 0.2, aa));
}

// The line touching land has solid foam coverage and an antialiased outer edge.
float wsWaterline(float depth) {
  float edge = uWsFoam.x * 0.5;
  return 1.0 - smoothstep(edge, edge + fwidth(depth) * 1.5 + 0.004, depth);
}
${DUCKWEED_GLSL}
`;

/** Shared shading on both sides of the mesh boundary in a tidal mouth. */
export const SEA_SURFACE_GLSL = /* glsl */ `
vec4 wsSeaSurface(vec3 vSeaW, vec2 current, float opacity, float pond) {
// Depth to the bed under this pixel (outside the island: the flat sea bed)
float inIsland = wsInIsland(vSeaW.xz);
float seaDepth = max(vSeaW.y - wsBedY(vSeaW.xz), 0.0);
float seaDist = distance(vSeaW, cameraPosition);
float shade, wobble;
vec2 slope = wsCurrentWaves(vSeaW.xz, current, seaDist, shade, wobble);
// Simulated waves around the player (developer toggle): they tilt the surface, so they catch the sun
float simH;
vec2 simG;
wdSimSample(vSeaW.xz, simH, simG);
slope += simG * uWdSimLook.y;
wsN = normalize(vec3(slope.x, 1.0, slope.y));
vec3 shallow = mix(uWsShallow, uWsPondShallow, pond);
vec3 seaCol = wsColour(seaDepth, shade, shallow, pond);

// Shore: distance to the nearest land (m) from the shore field; a light band along the shore,
// and the thin dashed lines that drift in toward it
float shoreD = mix(${SHORE_RANGE.toFixed(1)}, texture2D(uWsShore, wsBedUv(vSeaW.xz)).r * ${SHORE_RANGE.toFixed(1)}, inIsland);
float shoreAa = fwidth(shoreD);
seaCol = mix(seaCol, shallow * 1.25, (1.0 - smoothstep(0.0, 1.6, shoreD)) * 0.3 * inIsland);
wsFoam = wsShoreLines(shoreD, vSeaW.xz, shoreAa, 0.0, 99.0) * (1.0 - smoothstep(60.0, 140.0, seaDist));
wsFoam = max(wsFoam, wsWaterline(seaDepth));
wsFoam *= inIsland * uWsShine.w;
// Ripple rings from the swimmer, wading legs and splashes
// (derivatives first: the distance test below skips the loop for far pixels)
float seaRipAa = length(fwidth(vSeaW.xz));
float seaSimAa = fwidth(simH);
float seaRip = seaDist < 80.0 ? wdRipples(vSeaW.xz, seaRipAa) * (1.0 - smoothstep(45.0, 80.0, seaDist)) : 0.0;
wsFoam = clamp(max(wsFoam, max(seaRip * 0.9, wdSimCrest(simH, seaSimAa))), 0.0, 1.0);
// Duckweed painted on the water (Duckweed.ts): fronds over the water, foam and rings hidden under
// them, the surface calmed; from below the light shines through them (WATER_LIGHT_GLSL)
wsDuckweed(vSeaW.xz, seaDist, slope * 0.03);
wsFoam *= 1.0 - wsWeed;
seaCol = mix(seaCol, gl_FrontFacing ? wsWeedCol : wsWeedCol * 0.6, wsWeed);
wsN = normalize(mix(wsN, vec3(0.0, 1.0, 0.0), wsWeed * 0.8));
return vec4(mix(seaCol, uWsFoamCol, wsFoam), max(opacity, max(wsFoam, wsWeed)));
}
`;

/** The surface normal (world wsN) into the view space normal; flipped for the underside. */
export const WATER_NORMAL_GLSL = /* glsl */ `
normal = normalize((viewMatrix * vec4(gl_FrontFacing ? wsN : -wsN, 0.0)).xyz);`;

/** Added after #include <lights_fragment_end>: sky reflection, sun glint, the view from below. */
export const WATER_LIGHT_GLSL = /* glsl */ `
vec3 wsV = normalize(vViewPosition);
float wsNV = clamp(dot(normal, wsV), 0.0, 1.0);
vec3 wsSky = ambientLightColor;
#if NUM_HEMI_LIGHTS > 0
wsSky += hemisphereLights[0].skyColor;
#endif
#if NUM_DIR_LIGHTS > 0
// Uniform branch keeps derivatives valid without evaluating the sparkle grid in Performance.
if (uWsLite < 0.5 && uWsSparkle.x > 0.0) {
  mat3 wsV2W = transpose(mat3(viewMatrix));
  vec2 wsSpG = (cameraPosition + wsV2W * (-vViewPosition)).xz * uWsSparkle.z;
  vec2 wsSpDx = dFdx(wsSpG);
  vec2 wsSpDy = dFdy(wsSpG);
  float wsSpPx = sqrt(abs(wsSpDx.x * wsSpDy.y - wsSpDx.y * wsSpDy.x));
  float wsSpFade = 1.0 - smoothstep(0.5, 1.4, wsSpPx);
  float wsBare = 1.0 - max(wsFoam, wsWeed);
  if (gl_FrontFacing && wsSpFade > 0.0 && wsBare > 0.01) {
    vec3 wsHw = wsV2W * normalize(directionalLights[0].direction + wsV);
    if (wsHw.y > 0.05) {
      vec2 need = wsHw.xz / wsHw.y - wsN.xz / max(wsN.y, 0.05);
      vec2 spot;
      float f = wsSparkleFacet(floor(wsSpG), need, uWsSparkle.y, uWsSparkle.w, 3.0, spot);
      float r = clamp(wsSpPx * 2.2, 0.03, 0.45);
      float m = 1.0 - smoothstep(r * 0.35, r, length(fract(wsSpG) - 0.5 - spot));
      totalEmissiveRadiance += directionalLights[0].color * csSun * (f * m * wsSpFade * uWsSparkle.x * wsBare);
    }
  }
}
#endif
if (gl_FrontFacing) {
  // Fresnel: grazing angles mirror the sky
  float fres = 0.02 + uWsShine.x * pow(1.0 - wsNV, 5.0);
  float wsBare = 1.0 - max(wsFoam, wsWeed);
  totalEmissiveRadiance += wsSky * vec3(0.55, 0.75, 0.95) * fres * wsBare;
  #if NUM_DIR_LIGHTS > 0
  // Sun glint: a sharp highlight plus a soft sheen around it
  float nh = max(dot(normal, normalize(directionalLights[0].direction + wsV)), 0.0);
  float glint = pow(nh, uWsShine.z) * uWsShine.y;
  if (uWsLite < 0.5) glint += pow(nh, 48.0) * 0.12;
  totalEmissiveRadiance += directionalLights[0].color * csSun * glint * wsBare;
  // Duckweed fronds are waxy: a soft, broad sheen instead of the water's glint
  totalEmissiveRadiance += directionalLights[0].color * csSun * pow(nh, 20.0) * 0.06 * wsWeed;
  #endif
} else {
  // From below: a dim ceiling, with the bright Snell's window straight overhead
  float window = smoothstep(0.55, 0.9, wsNV);
  totalEmissiveRadiance += wsSky * vec3(0.12, 0.45, 0.55) * (0.15 + window * 0.9) * (1.0 - wsWeed * 0.55);
  // Duckweed seen from below: the thin fronds let the light through and glow green, brightest
  // inside the window where the sky and the sun are
  totalEmissiveRadiance += wsSky * wsWeedCol * wsWeed * (0.35 + window * 0.6);
  #if NUM_DIR_LIGHTS > 0
  totalEmissiveRadiance += directionalLights[0].color * csSun * wsWeedCol * vec3(1.1, 1.2, 0.75) * wsWeed * (0.25 + window * 0.55);
  #endif
}`;

// ---------------------------------------------------------------- bed and shore textures

const bedData = new Uint16Array(V * V);
const bedTex = new THREE.DataTexture(bedData, V, V, THREE.RedFormat, THREE.HalfFloatType);
bedTex.magFilter = bedTex.minFilter = THREE.LinearFilter;
bedTex.colorSpace = THREE.NoColorSpace;
bedTex.unpackAlignment = 2;
bedData.fill(THREE.DataUtils.toHalfFloat(SEA_FLOOR_Y));
bedTex.needsUpdate = true;
waterSurfaceUniforms.uWsBed.value = bedTex;

const shoreData = new Uint8Array(V * V).fill(255);
const shoreTex = new THREE.DataTexture(shoreData, V, V, THREE.RedFormat, THREE.UnsignedByteType);
shoreTex.magFilter = shoreTex.minFilter = THREE.LinearFilter;
shoreTex.colorSpace = THREE.NoColorSpace;
shoreTex.unpackAlignment = 1; // 513-byte rows
shoreTex.needsUpdate = true;
waterSurfaceUniforms.uWsShore.value = shoreTex;

/** SHORE_RANGE in metres, for the shader's decode. */
export const WATER_SHORE_RANGE = SHORE_RANGE;

// Scratch for the distance transform
const INF = 1e20;
const grid = new Float64Array(V * V);
const f1 = new Float64Array(V);
const d1 = new Float64Array(V);
const vIdx = new Int32Array(V);
const zB = new Float64Array(V + 1);
const blurA = new Float32Array(V * V);

/** Felzenszwalb & Huttenlocher 1D squared distance transform of f (length n) into d. */
function edt1d(f: Float64Array, d: Float64Array, n: number): void {
  let k = 0;
  vIdx[0] = 0;
  zB[0] = -INF;
  zB[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[vIdx[k]] + vIdx[k] * vIdx[k])) / (2 * q - 2 * vIdx[k]);
    while (s <= zB[k]) {
      k--;
      s = ((f[q] + q * q) - (f[vIdx[k]] + vIdx[k] * vIdx[k])) / (2 * q - 2 * vIdx[k]);
    }
    k++;
    vIdx[k] = q;
    zB[k] = s;
    zB[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (zB[k + 1] < q) k++;
    const dq = q - vIdx[k];
    d[q] = dq * dq + f[vIdx[k]];
  }
}

/**
 * New terrain heights (one per terrain vertex, 1 m apart) and sea level: re-uploads the bed
 * heights and rebuilds the distance-to-shore field (exact Euclidean distance transform from the
 * land vertices, made smooth with two small blurs so the shore lines follow flowing curves
 * instead of the 1 m grid). A few milliseconds; done only when the terrain or the level changes.
 */
export function setWaterTerrain(heights: Float32Array | number[], seaLevel: number): void {
  const n = V * V;
  for (let i = 0; i < n; i++) {
    bedData[i] = THREE.DataUtils.toHalfFloat(heights[i]);
    grid[i] = heights[i] >= seaLevel ? 0 : INF;
  }
  bedTex.needsUpdate = true;
  // Columns, then rows
  for (let x = 0; x < V; x++) {
    for (let y = 0; y < V; y++) f1[y] = grid[y * V + x];
    edt1d(f1, d1, V);
    for (let y = 0; y < V; y++) grid[y * V + x] = d1[y];
  }
  for (let y = 0; y < V; y++) {
    const row = y * V;
    for (let x = 0; x < V; x++) f1[x] = grid[row + x];
    edt1d(f1, d1, V);
    for (let x = 0; x < V; x++) grid[row + x] = d1[x];
  }
  // Distance in metres; the shore itself lies about half a cell short of the nearest land vertex
  const field = blurA;
  for (let i = 0; i < n; i++) field[i] = Math.min(SHORE_RANGE, Math.max(0, Math.sqrt(grid[i]) - 0.5));
  // Two 3×3 box blurs (separable) round off the grid's staircase
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < V; y++) {
      const row = y * V;
      let prev = field[row];
      for (let x = 0; x < V; x++) {
        const cur = field[row + x];
        const next = x + 1 < V ? field[row + x + 1] : cur;
        field[row + x] = (prev + cur + next) / 3;
        prev = cur;
      }
    }
    for (let x = 0; x < V; x++) {
      let prev = field[x];
      for (let y = 0; y < V; y++) {
        const i = y * V + x;
        const cur = field[i];
        const next = y + 1 < V ? field[i + V] : cur;
        field[i] = (prev + cur + next) / 3;
        prev = cur;
      }
    }
  }
  for (let i = 0; i < n; i++) shoreData[i] = Math.round((field[i] / SHORE_RANGE) * 255);
  shoreTex.needsUpdate = true;
}
