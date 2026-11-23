import * as THREE from 'three';
import { isMobileDevice, WORLD_HALF, WORLD_SIZE, worldSettings } from '../world/WorldSettings';
import { riverWorld } from '../world/rivers/RiverWorld';

/** Small suspended flecks in a world-aligned volume that wraps around the camera on the GPU. */
export class UnderwaterParticles {
  private readonly uniforms = {
    uTime: { value: 0 },
    uRadius: { value: 0 },
    uPointScale: { value: 0 },
    uMaxSize: { value: 0 },
    uVisibility: { value: 0 },
    uSea: { value: 0 },
    uCaveSurface: { value: 0 },
    uInCave: { value: false },
    uRiver: { value: riverWorld.texture },
  };
  private readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  constructor(scene: THREE.Scene) {
    const mobile = isMobileDevice();
    const count = mobile ? 220 : 420;
    this.uniforms.uRadius.value = mobile ? 9 : 11;
    this.uniforms.uMaxSize.value = mobile ? 4.5 : 7;

    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(seeds, 3));

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uTime, uRadius, uPointScale, uMaxSize, uVisibility, uSea, uCaveSurface;
        uniform bool uInCave;
        uniform sampler2D uRiver;
        varying float vAlpha;

        float waterSurface(vec2 xz) {
          if (uInCave) return uCaveSurface;
          if (max(abs(xz.x), abs(xz.y)) > ${WORLD_HALF.toFixed(1)}) return uSea;
          vec2 uv = (xz + ${(WORLD_HALF + 0.5).toFixed(1)}) / ${(WORLD_SIZE + 1).toFixed(1)};
          vec2 river = texture2D(uRiver, uv).rg;
          return river.g > 0.5 ? max(river.r, uSea) : uSea;
        }

        void main() {
          float seed = fract(dot(position, vec3(17.1, 61.7, 33.9)));
          vec3 drift = uTime * vec3(0.16, (seed - 0.5) * 0.075, 0.07);
          drift.xz += sin(uTime * 0.55 + position.xy * 6.283) * 0.18;
          float span = 2.0 * uRadius;
          vec3 offset = mod(position * span + drift - cameraPosition + uRadius, span) - uRadius;
          float range = length(offset);
          vec3 world = cameraPosition + offset;
          vec4 view = viewMatrix * vec4(world, 1.0);
          float depth = -view.z;
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          gl_PointSize = 1.0;
          vAlpha = 0.0;
          if (depth < 0.25 || range >= uRadius) return;
          float submerged = waterSurface(world.xz) - world.y;
          if (submerged < 0.06) return;

          float size = mix(0.026, 0.061, seed * seed) * uPointScale / depth;
          gl_PointSize = clamp(size, 1.0, uMaxSize);
          gl_Position = projectionMatrix * view;
          vAlpha = uVisibility * mix(0.19, 0.49, seed)
            * smoothstep(0.28, 1.1, depth)
            * (1.0 - smoothstep(uRadius * 0.54, uRadius, range))
            * smoothstep(0.06, 0.36, submerged)
            * min(size, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;

        void main() {
          vec2 p = (gl_PointCoord - 0.5) * vec2(2.0, 2.4);
          float alpha = (1.0 - smoothstep(0.05, 1.0, dot(p, p))) * vAlpha;
          gl_FragColor = vec4(0.48, 0.70, 0.66, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.name = 'UnderwaterParticles';
    this.points.frustumCulled = false; // Static seed positions are not the drawn world positions.
    this.points.visible = false;
    scene.add(this.points);
  }

  public update(
    dt: number,
    camera: THREE.PerspectiveCamera,
    surfaceY: number,
    inCave: boolean,
    night: number,
    bufferHeight: number,
  ): void {
    const depth = surfaceY - camera.position.y;
    this.points.visible = depth > 0.02;
    if (!this.points.visible) return;

    const u = this.uniforms;
    u.uTime.value += dt;
    u.uPointScale.value = bufferHeight * camera.projectionMatrix.elements[5] * 0.5;
    u.uVisibility.value = THREE.MathUtils.smoothstep(depth, 0.02, 0.35) * (inCave ? 0.5 : 1 - night * 0.65);
    u.uSea.value = worldSettings.waterLevel;
    u.uCaveSurface.value = surfaceY;
    u.uInCave.value = inCave;
  }

  public dispose(): void {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
