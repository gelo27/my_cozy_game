import { Material, type MeshLambertMaterial, type WebGLProgramParametersWithUniforms } from 'three';
import { onUserSettingsChange, userSettings } from '../config/userSettings';

// Keep one material per batch. The renderer caches both programs by their defines,
// and the same setting also applies to pooled LOD materials.
const trackedMaterials = new WeakSet<Material>();
const materialRefs = new Set<WeakRef<Material>>();
let quality = userSettings.graphicsQuality;

function setQualityDefine(material: Material): void {
  const defines = material.defines ??= {};
  if (quality === 'performance') defines.QUALITY_VERTEX_LIGHTING = 1;
  else delete defines.QUALITY_VERTEX_LIGHTING;
  material.needsUpdate = true;
}

onUserSettingsChange(() => {
  if (quality === userSettings.graphicsQuality) return;
  quality = userSettings.graphicsQuality;
  for (const ref of materialRefs) {
    const material = ref.deref();
    if (material) setQualityDefine(material);
    else materialRefs.delete(ref);
  }
});

function track(material: Material): void {
  trackedMaterials.add(material);
  materialRefs.add(new WeakRef(material));
  setQualityDefine(material);
}

export function inheritVertexLightingQuality(base: Material, clone: Material): void {
  if (trackedMaterials.has(base)) track(clone);
}

/**
 * Keep Lambert as the material interface so the world effects can share the same
 * shader hooks. In performance mode the surface colour is multiplied by interpolated
 * sun/moon and ambient light, bypassing the standard per-pixel lighting path.
 */
export function withVertexLightingQuality<T extends MeshLambertMaterial>(material: T, groundNormal = false): T {
  const compile = Object.hasOwn(material, 'onBeforeCompile') ? material.onBeforeCompile : undefined;
  material.onBeforeCompile = function (shader, renderer) {
    // The default hook is installed by the world after some shared materials are created.
    (compile ?? Material.prototype.onBeforeCompile).call(this, shader, renderer);
    if (quality === 'performance') useVertexLighting(shader, groundNormal);
  };
  track(material);
  return material;
}

function useVertexLighting(shader: WebGLProgramParametersWithUniforms, groundNormal: boolean): void {
  const varyings = 'varying vec3 vVertexDirect;\nvarying vec3 vVertexAmbient;';
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
#include <lights_pars_begin>
${varyings}`)
    .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
{
  vec3 n = ${groundNormal ? 'normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0))' : 'normalize(transformedNormal)'};
  vVertexAmbient = ambientLightColor;
  vVertexDirect = vec3(0.0);
  #if NUM_HEMI_LIGHTS > 0
    vVertexAmbient += getHemisphereLightIrradiance(hemisphereLights[0], n);
  #endif
  #if NUM_DIR_LIGHTS > 0
    float sunDot = dot(n, directionalLights[0].direction);
    ${groundNormal ? '' : `#ifdef DOUBLE_SIDED
      sunDot = abs(sunDot);
    #endif`}
    vVertexDirect = max(0.0, sunDot) * directionalLights[0].color;
  #endif
  vVertexDirect *= RECIPROCAL_PI;
  vVertexAmbient *= RECIPROCAL_PI;
}`);

  // Replace only Three's lighting chunks. The game's cloud shadows, grass shading,
  // local lights, snow, waterline and fog continue to operate on the result.
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
${varyings}`)
    .replace('#include <lights_lambert_fragment>', '')
    .replace('#include <lights_fragment_begin>', '')
    .replace('#include <lights_fragment_maps>', '')
    .replace('#include <lights_fragment_end>', `
reflectedLight.directDiffuse = diffuseColor.rgb * vVertexDirect;
reflectedLight.indirectDiffuse = diffuseColor.rgb * vVertexAmbient;`);
}
