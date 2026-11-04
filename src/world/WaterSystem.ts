import { injectNightLights } from './NightLighting';
import * as THREE from 'three';
import { SEA_BED_TOP, worldSettings } from './WorldSettings';

/** The sea planes follow the camera and reach past the far plane, so the ocean meets the horizon. */
const OCEAN_SIZE = 1200;

/**
 * One water plane at `worldSettings.waterLevel` (lakes on the island and the open sea around it),
 * plus a plain sea-bed plane under it. Both follow the camera, so the sea is endless to the eye.
 * Waves are a cheap vertex-free colour/specular ripple in the fragment shader (1 draw call).
 */
export class WaterSystem {
  public readonly mesh: THREE.Mesh;
  private readonly seabed: THREE.Mesh;
  private readonly uniforms = { uTime: { value: 0 } };

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({
      color: 0x3fa7c9,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      // Seen from below when diving: the underside of the surface must show too
      side: THREE.DoubleSide,
    });
    mat.onBeforeCompile = (shader) => {
      injectNightLights(shader);
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWaterXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWaterXZ;\nuniform float uTime;')
        .replace(
          '#include <map_fragment>',
          `float w1 = sin(vWaterXZ.x * 0.9 + uTime * 1.3) * sin(vWaterXZ.y * 0.7 - uTime * 1.1);
float w2 = sin((vWaterXZ.x + vWaterXZ.y) * 1.7 - uTime * 2.1);
float ripple = w1 * 0.5 + w2 * 0.25;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.93, 0.98), smoothstep(0.45, 0.75, ripple) * 0.45);
diffuseColor.rgb *= 0.92 + ripple * 0.08;`
        );
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'Water';
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    const bedGeo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, 1, 1);
    bedGeo.rotateX(-Math.PI / 2);
    this.seabed = new THREE.Mesh(bedGeo, new THREE.MeshLambertMaterial({ color: 0x8c8466 }));
    this.seabed.name = 'SeaBed';
    this.seabed.position.y = SEA_BED_TOP;
    this.seabed.frustumCulled = false;
    scene.add(this.seabed);
  }

  public update(dt: number, camera?: THREE.Vector3): void {
    this.uniforms.uTime.value += dt;
    this.mesh.position.y = worldSettings.waterLevel;
    if (camera) {
      this.mesh.position.x = this.seabed.position.x = camera.x;
      this.mesh.position.z = this.seabed.position.z = camera.z;
    }
  }
}
