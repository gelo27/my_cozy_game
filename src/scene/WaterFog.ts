import * as THREE from 'three';

export interface WaterFogBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

const isMobileDevice = (): boolean => {
  if (typeof navigator !== 'undefined') {
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
      return true;
    }
  }
  if (typeof window !== 'undefined' && window.innerWidth < 768) {
    return true;
  }
  return false;
};

const _poolCenter = new THREE.Vector3(95, -12, 0);
const SLEEP_DIST_SQ = 65 * 65;

export class WaterFog {
  public group: THREE.Group;
  public mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private isVisibleState: boolean = true;

  constructor(private bounds: WaterFogBounds) {
    this.group = new THREE.Group();

    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxZ - bounds.minZ;
    const height = bounds.maxY - bounds.minY;

    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    const centerY = bounds.minY + height / 2;

    const geometry = new THREE.BoxGeometry(width, height, depth, 1, 1, 1);
    const isMobile = isMobileDevice();

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uFogColor: { value: new THREE.Color(0xdbeafe) },
        uFogOpacity: { value: 0.65 },
        uBoundsMin: { value: new THREE.Vector3(bounds.minX, bounds.minY, bounds.minZ) },
        uBoundsMax: { value: new THREE.Vector3(bounds.maxX, bounds.maxY, bounds.maxZ) },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uFogColor;
        uniform float uFogOpacity;
        uniform vec3 uBoundsMin;
        uniform vec3 uBoundsMax;
        varying vec3 vWorldPosition;

        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        void main() {
          float normalizedY = clamp((vWorldPosition.y - uBoundsMin.y) / (uBoundsMax.y - uBoundsMin.y), 0.0, 1.0);
          float verticalFade = (1.0 - normalizedY) * smoothstep(0.0, 0.08, normalizedY);

          float margin = 5.0;
          float edgeX = smoothstep(uBoundsMin.x, uBoundsMin.x + margin, vWorldPosition.x) *
                        smoothstep(uBoundsMax.x, uBoundsMax.x - margin, vWorldPosition.x);
          float edgeZ = smoothstep(uBoundsMin.z, uBoundsMin.z + margin, vWorldPosition.z) *
                        smoothstep(uBoundsMax.z, uBoundsMax.z - margin, vWorldPosition.z);

          vec2 uv = vWorldPosition.xz * 0.06;
          vec2 drift = vec2(uTime * 0.04, uTime * 0.02);

          ${isMobile ? `
            float noiseVal = noise(uv + drift);
          ` : `
            float n1 = noise(uv + drift);
            float n2 = noise(uv * 2.0 - drift * 0.8);
            float noiseVal = mix(n1, n2, 0.5);
          `}

          float alpha = uFogOpacity * verticalFade * edgeX * edgeZ * (0.4 + 0.6 * noiseVal);
          gl_FragColor = vec4(uFogColor, alpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.set(centerX, centerY, centerZ);
    this.mesh.renderOrder = 2;
    this.group.add(this.mesh);
  }

  public update(dt: number, playerPos?: THREE.Vector3): void {
    if (playerPos) {
      const distSq = playerPos.distanceToSquared(_poolCenter);
      if (distSq > SLEEP_DIST_SQ) {
        if (this.isVisibleState) {
          this.isVisibleState = false;
          this.group.visible = false;
        }
        return;
      }
      if (!this.isVisibleState) {
        this.isVisibleState = true;
        this.group.visible = true;
      }
    }

    if (this.material.uniforms.uTime) {
      this.material.uniforms.uTime.value += dt;
    }
  }

  public setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  public isVisible(): boolean {
    return this.group.visible;
  }

  public dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
