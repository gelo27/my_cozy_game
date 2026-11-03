import * as THREE from 'three';
import { WORLD_SIZE, worldSettings } from './WorldSettings';

/**
 * One water plane over the whole world at `worldSettings.waterLevel`.
 * Waves are a cheap vertex-free colour/specular ripple in the fragment shader (1 draw call).
 */
export class WaterSystem {
  public readonly mesh: THREE.Mesh;
  private readonly uniforms = { uTime: { value: 0 } };

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(WORLD_SIZE + 40, WORLD_SIZE + 40, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({
      color: 0x3fa7c9,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    mat.onBeforeCompile = (shader) => {
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
    scene.add(this.mesh);
  }

  public update(dt: number): void {
    this.uniforms.uTime.value += dt;
    this.mesh.position.y = worldSettings.waterLevel;
  }
}
