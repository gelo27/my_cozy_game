import * as THREE from 'three';

/**
 * Shared matcap glass for everything glazed in the world: building windows and doors, greenhouse
 * panels and roofs, car windows, the boat windscreen.
 *
 * - One matcap, drawn once on a canvas: the view-space normal sphere reflects a soft blue sky above
 *   and green grass below (deliberately low contrast), brightens towards the rim (Fresnel) and has a
 *   narrow highlight upper-left. No per-light shading work at all.
 * - Matcap is unlit, so a shared daylight factor (setGlassLight, driven by the weather each frame)
 *   scales it: glass never glows at night or in caves.
 * - Transparent glass gets thicker at grazing angles (Fresnel alpha).
 * - Optional screen-door dither LOD (building glass): a blended "near" material and an opaque "far"
 *   twin on the same geometry swap pixels between GLASS_DITHER_NEAR and GLASS_DITHER_FAR metres.
 */

export const GLASS_DITHER_NEAR = 16;
export const GLASS_DITHER_FAR = 30;

function createGlassMatcap(): THREE.Texture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  // Low contrast on purpose: sky and grass differ in hue more than in brightness
  const sky = [0.7, 0.83, 0.95];
  const horizon = [0.78, 0.86, 0.88];
  const grass = [0.6, 0.72, 0.55];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = ((x + 0.5) / S) * 2 - 1;
      const ny = 1 - ((y + 0.5) / S) * 2; // canvas y down -> normal y up
      const r2 = Math.min(1, nx * nx + ny * ny);
      const nz = Math.sqrt(1 - r2);
      // Reflected environment: sky above the horizon, grass below, a soft band between
      const up = THREE.MathUtils.smoothstep(ny, -0.35, 0.45);
      const c = [0, 1, 2].map((i) =>
        up > 0.5 ? horizon[i] + (sky[i] - horizon[i]) * (up - 0.5) * 2 : grass[i] + (horizon[i] - grass[i]) * up * 2
      );
      // Facing the viewer glass reflects little: slightly darker centre, brighter grazing rim
      const k = 0.84 + 0.24 * Math.pow(1 - nz, 3);
      // Narrow highlight from the upper-left sky
      const hx = nx + 0.38;
      const hy = ny - 0.46;
      const d2 = hx * hx + hy * hy;
      const spec = Math.exp(-d2 / 0.012) * 0.45 + Math.exp(-d2 / 0.08) * 0.08;
      const o = (y * S + x) * 4;
      for (let i = 0; i < 3; i++) img.data[o + i] = Math.round(255 * Math.min(1, c[i] * k + spec));
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export const GLASS_MATCAP = createGlassMatcap();

/** Shared by every glass shader: matcap glass is unlit, so the scene's daylight scales it here. */
const GLASS_LIGHT = { value: 1 };

/** Brightness of all glass (1 = full day). Called every frame from the weather. */
export function setGlassLight(light: number): void {
  GLASS_LIGHT.value = light;
}

export type GlassDither = 'near' | 'far' | 'none';

/** Hooks daylight, Fresnel alpha (transparent glass) and optionally the near/far dither into a matcap material. */
export function installGlassShader(mat: THREE.MeshMatcapMaterial, dither: GlassDither = 'none'): void {
  const fresnel = mat.transparent;
  mat.customProgramCacheKey = () => `glass-${dither}-${fresnel ? 'f' : 'o'}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlassLight = GLASS_LIGHT;
    let pars = 'uniform float uGlassLight;';
    if (dither !== 'none') {
      shader.uniforms.uGlassNear = { value: GLASS_DITHER_NEAR };
      shader.uniforms.uGlassFar = { value: GLASS_DITHER_FAR };
      pars += `
uniform float uGlassNear;
uniform float uGlassFar;
float glassBayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int k = i.x + i.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[k]) + 0.5) / 16.0;
}`;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
{
  float glassFar = smoothstep(uGlassNear, uGlassFar, length(vViewPosition));
  bool farPixel = glassBayer4(gl_FragCoord.xy) < glassFar;
  if (farPixel != ${dither === 'far' ? 'true' : 'false'}) discard;
}`
      );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${pars}`)
      // Flat panes have one normal, so a pure normal matcap would paint them one flat colour.
      // Look the sky/grass gradient up by the reflected view ray's world height instead: every
      // pane shows sky above and grass below, roofs mostly sky. The horizon is lowered (+0.3) so
      // the third-person camera, which looks down at panes, still sees sky in their upper part.
      .replace(
        'vec4 matcapColor = texture2D( matcap, uv );',
        `vec3 glassR = inverseTransformDirection(reflect(-viewDir, normal), viewMatrix);
		vec4 matcapColor = texture2D( matcap, vec2(uv.x, 0.5 + 0.495 * clamp((glassR.y + 0.3) * 3.0, -1.0, 1.0)) );`
      )
      .replace(
      '#include <opaque_fragment>',
      `outgoingLight *= uGlassLight;
${fresnel ? '// Grazing angles reflect more and let less through: thicker towards the rim\ndiffuseColor.a = mix(diffuseColor.a, min(1.0, diffuseColor.a * 2.6), pow(min(1.0, length(uv - 0.5) * 2.0), 3.0));' : ''}
#include <opaque_fragment>`
    );
  };
}

/** A matcap glass material (transparent when `opacity` is given) with daylight + Fresnel installed. */
export function createGlassMaterial(params: {
  color: THREE.ColorRepresentation;
  opacity?: number;
  side?: THREE.Side;
  dither?: GlassDither;
}): THREE.MeshMatcapMaterial {
  const transparent = params.opacity !== undefined;
  const mat = new THREE.MeshMatcapMaterial({
    matcap: GLASS_MATCAP,
    color: params.color,
    transparent,
    opacity: params.opacity ?? 1,
    depthWrite: !transparent,
    side: params.side ?? THREE.FrontSide,
  });
  installGlassShader(mat, params.dither);
  return mat;
}
