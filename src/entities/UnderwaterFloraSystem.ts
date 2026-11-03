import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

export interface CoralReefLocation {
  center: THREE.Vector3;
  radius: number;
  type: 'mixed' | 'staghorn' | 'sponge' | 'plate';
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
const SLEEP_DIST_SQ = 65 * 65; // 65m radius sleep

export class UnderwaterFloraSystem {
  public group: THREE.Group;
  private kelpMesh: THREE.InstancedMesh | null = null;
  private kelpMaterial!: THREE.MeshLambertMaterial;
  private kelpUniforms = { uTime: { value: 0.0 } };
  private coralMeshes: THREE.InstancedMesh[] = [];
  public reefLocations: CoralReefLocation[] = [];
  private isMobile: boolean = false;
  private isVisible: boolean = true;

  constructor(private scene: THREE.Scene) {
    this.isMobile = isMobileDevice();
    this.group = new THREE.Group();
    this.group.name = 'UnderwaterFloraSystem';
    this.scene.add(this.group);

    this.initReefLocations();
    this.initInstancedCorals();
    this.initKelpBeds();
  }

  private initReefLocations(): void {
    this.reefLocations = [
      { center: new THREE.Vector3(75, -24.5, -20), radius: 8, type: 'mixed' },
      { center: new THREE.Vector3(115, -24.5, -18), radius: 9, type: 'staghorn' },
      { center: new THREE.Vector3(82, -24.5, 18), radius: 7, type: 'sponge' },
      { center: new THREE.Vector3(112, -24.5, 16), radius: 10, type: 'plate' },
      { center: new THREE.Vector3(95, -24.5, -30), radius: 8, type: 'mixed' },
      { center: new THREE.Vector3(95, -24.5, 32), radius: 9, type: 'mixed' },
    ];
  }

  /**
   * Ultra-high performance Instanced Coral Reefs
   * Transforms 350+ individual draw calls into just 4 batched InstancedMeshes
   */
  private initInstancedCorals(): void {
    const coralColors = [
      new THREE.Color(0xff3b81), // Vibrant Pink
      new THREE.Color(0xec4899), // Magenta Rose
      new THREE.Color(0xf97316), // Bright Orange Coral
      new THREE.Color(0x06b6d4), // Cyan Coral
      new THREE.Color(0x8b5cf6), // Purple Coral
      new THREE.Color(0xeab308), // Gold Coral
      new THREE.Color(0x10b981), // Sea Green Coral
    ];

    // Shared coral material (flat shaded, zero shadow cost)
    const coralMaterial = new THREE.MeshLambertMaterial({
      flatShading: true,
    });

    // 1. Build Base Geometries for the 4 Coral Archetypes
    // Archetype 0: Staghorn Branching Antler
    const staghornGeos: THREE.BufferGeometry[] = [];
    const mainBranchGeo = new THREE.CylinderGeometry(0.15, 0.25, 1.8, 5);
    mainBranchGeo.translate(0, 0.9, 0);
    staghornGeos.push(mainBranchGeo);

    for (let s = 0; s < 4; s++) {
      const subGeo = new THREE.CylinderGeometry(0.08, 0.12, 1.0, 4);
      subGeo.translate(0, 0.5, 0);
      subGeo.rotateZ((Math.PI / 4) * (s % 2 === 0 ? 1 : -1));
      subGeo.rotateY((s * Math.PI) / 2);
      subGeo.translate(0, 0.8 + s * 0.25, 0);
      staghornGeos.push(subGeo);
    }
    const mergedStaghorn = BufferGeometryUtils.mergeGeometries(staghornGeos);

    // Archetype 1: Tubular Sponges
    const spongeGeos: THREE.BufferGeometry[] = [];
    const tubeCount = 4;
    for (let t = 0; t < tubeCount; t++) {
      const height = 1.6 + (t % 2) * 0.6;
      const tubeGeo = new THREE.CylinderGeometry(0.2, 0.15, height, 6, 1, true);
      tubeGeo.translate(0, height / 2, 0);
      const angle = (t / tubeCount) * Math.PI * 2;
      tubeGeo.rotateX((t % 2 === 0 ? 1 : -1) * 0.12);
      tubeGeo.translate(Math.cos(angle) * 0.25, 0, Math.sin(angle) * 0.25);
      spongeGeos.push(tubeGeo);
    }
    const mergedSponge = BufferGeometryUtils.mergeGeometries(spongeGeos);

    // Archetype 2: Plate / Table Coral
    const plateGeos: THREE.BufferGeometry[] = [];
    const stemGeo = new THREE.CylinderGeometry(0.2, 0.3, 1.2, 6);
    stemGeo.translate(0, 0.6, 0);
    plateGeos.push(stemGeo);

    for (let tier = 0; tier < 2; tier++) {
      const plateRadius = 1.2 - tier * 0.35;
      const plateGeo = new THREE.CylinderGeometry(plateRadius, plateRadius * 0.85, 0.18, 7);
      plateGeo.translate(0, 0.7 + tier * 0.5, 0);
      plateGeos.push(plateGeo);
    }
    const mergedPlate = BufferGeometryUtils.mergeGeometries(plateGeos);

    // Archetype 3: Brain / Boulder Coral Mound
    const moundGeo = new THREE.DodecahedronGeometry(0.85, 1);
    moundGeo.scale(1.2, 0.75, 1.2);
    moundGeo.translate(0, 0.45, 0);

    const baseGeos = [mergedStaghorn, mergedSponge, mergedPlate, moundGeo];

    // Determine count per archetype
    const countPerReef = this.isMobile ? 10 : 18;
    const totalCorals = this.reefLocations.length * countPerReef;
    const countPerType = Math.ceil(totalCorals / 4);

    const dummy = new THREE.Object3D();
    const typeIndices = [0, 0, 0, 0];

    // Create the 4 InstancedMeshes
    for (let type = 0; type < 4; type++) {
      const instMesh = new THREE.InstancedMesh(baseGeos[type], coralMaterial, countPerType);
      instMesh.castShadow = false; // Zero shadow pass overhead
      instMesh.receiveShadow = false;
      instMesh.frustumCulled = false;
      this.group.add(instMesh);
      this.coralMeshes.push(instMesh);
    }

    // Populate coral instances across reef zones
    let currentCoralIdx = 0;
    this.reefLocations.forEach((reef) => {
      for (let i = 0; i < countPerReef; i++) {
        const type = currentCoralIdx % 4;
        const instIdx = typeIndices[type];

        if (instIdx < countPerType) {
          const angle = Math.random() * Math.PI * 2;
          const dist = (Math.random() * 0.8 + 0.1) * reef.radius;
          const posX = reef.center.x + Math.cos(angle) * dist;
          const posZ = reef.center.z + Math.sin(angle) * dist;
          const posY = -24.8;
          const scale = (0.6 + Math.random() * 0.8);

          dummy.position.set(posX, posY, posZ);
          dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
          dummy.scale.set(scale, scale, scale);
          dummy.updateMatrix();

          const instMesh = this.coralMeshes[type];
          instMesh.setMatrixAt(instIdx, dummy.matrix);

          // Assign individual vibrant color
          const color = coralColors[Math.floor(Math.random() * coralColors.length)];
          instMesh.setColorAt(instIdx, color);

          typeIndices[type]++;
        }
        currentCoralIdx++;
      }
    });

    for (const mesh of this.coralMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Instanced Kelp (Seaweed) ribbons with swaying vertex wave animation
   * Optimized: Mobile reduced count (60 vs 120), 8-segment geometry, no shadows
   */
  private initKelpBeds(): void {
    const kelpCount = this.isMobile ? 60 : 120;
    const kelpHeight = 8.5;
    const kelpWidth = 0.45;
    const segmentsY = this.isMobile ? 8 : 12;

    // Create a vertical ribbon geometry
    const baseKelpGeo = new THREE.PlaneGeometry(kelpWidth, kelpHeight, 1, segmentsY);
    // Base pivot at bottom (Y=0)
    baseKelpGeo.translate(0, kelpHeight / 2, 0);

    this.kelpMaterial = new THREE.MeshLambertMaterial({
      color: 0x10b981,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1.0,
      depthWrite: true,
      fog: true,
    });

    this.kelpMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.kelpUniforms.uTime;

      shader.vertexShader = `
        uniform float uTime;
        varying float vKelpFactor;
        ${shader.vertexShader}
      `;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        
        float kelpY = clamp(position.y / 8.5, 0.0, 1.0);
        vKelpFactor = kelpY;
        float weight = pow(kelpY, 1.4);

        #ifdef USE_INSTANCING
          float instX = instanceMatrix[3][0];
          float instZ = instanceMatrix[3][2];
        #else
          float instX = 0.0;
          float instZ = 0.0;
        #endif

        float wave1 = sin(uTime * 1.3 + position.y * 0.4 + instX * 0.3) * 0.65;
        float wave2 = cos(uTime * 1.9 + position.y * 0.8 + instZ * 0.4) * 0.3;
        float waveX = sin(uTime * 0.85 + position.y * 0.3) * 0.35;

        transformed.z += (wave1 + wave2) * weight;
        transformed.x += waveX * weight;
        `
      );

      shader.fragmentShader = `
        varying float vKelpFactor;
        ${shader.fragmentShader}
      `;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        vec3 bottomKelpColor = vec3(0.015, 0.20, 0.10); // Deep sea kelp
        vec3 topKelpColor = vec3(0.12, 0.65, 0.35);    // Emerald sea-moss
        diffuseColor.rgb = mix(bottomKelpColor, topKelpColor, vKelpFactor);
        `
      );
    };

    this.kelpMesh = new THREE.InstancedMesh(baseKelpGeo, this.kelpMaterial, kelpCount);
    this.kelpMesh.castShadow = false; // Huge GPU shadow savings
    this.kelpMesh.receiveShadow = false;
    this.kelpMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.kelpMesh.frustumCulled = false;

    const dummy = new THREE.Object3D();
    let index = 0;

    // Distribute kelp clusters around reefs
    for (const reef of this.reefLocations) {
      const bladesInBed = Math.floor(kelpCount / this.reefLocations.length);
      for (let b = 0; b < bladesInBed && index < kelpCount; b++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = (Math.random() * 0.9 + 0.2) * (reef.radius + 3.0);
        const px = reef.center.x + Math.cos(angle) * dist;
        const pz = reef.center.z + Math.sin(angle) * dist;
        const py = -24.8;

        const scaleY = 0.7 + Math.random() * 0.6;
        const scaleXZ = 0.8 + Math.random() * 0.4;

        dummy.position.set(px, py, pz);
        dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
        dummy.scale.set(scaleXZ, scaleY, scaleXZ);
        dummy.updateMatrix();

        this.kelpMesh.setMatrixAt(index, dummy.matrix);
        index++;
      }
    }

    // Fill remaining
    while (index < kelpCount) {
      const px = 60 + Math.random() * 70;
      const pz = -35 + Math.random() * 70;
      const py = -24.8;

      dummy.position.set(px, py, pz);
      dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      dummy.scale.set(1.0, 0.8 + Math.random() * 0.5, 1.0);
      dummy.updateMatrix();

      this.kelpMesh.setMatrixAt(index, dummy.matrix);
      index++;
    }

    this.kelpMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.kelpMesh);
  }

  public update(dt: number, playerPos?: THREE.Vector3): void {
    if (playerPos) {
      const distSq = playerPos.distanceToSquared(_poolCenter);
      if (distSq > SLEEP_DIST_SQ) {
        if (this.isVisible) {
          this.isVisible = false;
          this.group.visible = false;
        }
        return;
      }
      if (!this.isVisible) {
        this.isVisible = true;
        this.group.visible = true;
      }
    }

    this.kelpUniforms.uTime.value += dt;
  }

  public dispose(): void {
    if (this.kelpMesh) {
      this.kelpMesh.geometry.dispose();
      this.kelpMaterial.dispose();
    }
    for (const mesh of this.coralMeshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.scene.remove(this.group);
  }
}
