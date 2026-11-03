import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CropType, CropStage } from './types/FarmingTypes';

// Reusable materials for farming elements
export const FARMING_MATERIALS = {
  woodBorder: new THREE.MeshLambertMaterial({
    color: 0x7c4a27,
  }),
  woodPeg: new THREE.MeshLambertMaterial({
    color: 0x543217,
  }),
  drySoil: new THREE.MeshLambertMaterial({
    color: 0x6e4324,
  }),
  wetSoil: new THREE.MeshLambertMaterial({
    color: 0x2e190d,
  }),
  sproutGreen: new THREE.MeshLambertMaterial({
    color: 0x65a30d,
  }),
  leafGreen: new THREE.MeshLambertMaterial({
    color: 0x22c55e,
  }),
  darkLeafGreen: new THREE.MeshLambertMaterial({
    color: 0x15803d,
  }),
  wheatGold: new THREE.MeshLambertMaterial({
    color: 0xeab308,
  }),
  wheatAmber: new THREE.MeshLambertMaterial({
    color: 0xca8a04,
  }),
  carrotOrange: new THREE.MeshLambertMaterial({
    color: 0xf97316,
  }),
  carrotRipe: new THREE.MeshLambertMaterial({
    color: 0xea580c,
  }),
  tomatoGreen: new THREE.MeshLambertMaterial({
    color: 0x84cc16,
  }),
  tomatoRed: new THREE.MeshLambertMaterial({
    color: 0xef4444,
  }),
  tomatoYellowFlower: new THREE.MeshLambertMaterial({
    color: 0xfde047,
  }),
  stakeWood: new THREE.MeshLambertMaterial({
    color: 0x92613b,
  }),
  crateWood: new THREE.MeshLambertMaterial({
    color: 0x9a6438,
  }),
  wateringCanBody: new THREE.MeshLambertMaterial({
    color: 0x38bdf8, // Heartopia sky cyan
  }),
  wateringCanTrim: new THREE.MeshLambertMaterial({
    color: 0xf8fafc, // White accent
  }),
};

// 4 quadrant section centers for the 2x2m farm plot
const QUADRANT_CENTERS: [number, number][] = [
  [-0.46, -0.46], // Top-Left (NW)
  [0.46, -0.46],  // Top-Right (NE)
  [-0.46, 0.46],  // Bottom-Left (SW)
  [0.46, 0.46],   // Bottom-Right (SE)
];

export class FarmingMeshGenerator {
  /**
   * Generates the 3D farm bed planter structure with wooden timber perimeter,
   * 4-section cross divider grid, and 4 tilled soil quadrant mounds.
   */
  public static createFarmPlotBed(size: number = 2.0): {
    group: THREE.Group;
    soilMesh: THREE.Mesh;
  } {
    const group = new THREE.Group();
    group.name = `FarmPlotBed_${size}m`;

    const half = size / 2.0;
    const borderHeight = 0.22;
    const borderThick = 0.08;
    const rimY = borderHeight / 2.0;

    // 1. Wooden Perimeter Beams (4 outer borders)
    const woodGeos: THREE.BufferGeometry[] = [];

    // Front & Back beams
    const beamFB = new THREE.BoxGeometry(size, borderHeight, borderThick);
    const frontBeam = beamFB.clone().translate(0, rimY, half - borderThick / 2.0);
    const backBeam = beamFB.clone().translate(0, rimY, -half + borderThick / 2.0);
    beamFB.dispose();
    woodGeos.push(frontBeam, backBeam);

    // Left & Right beams (inner span)
    const sideLen = size - borderThick * 2;
    const beamLR = new THREE.BoxGeometry(borderThick, borderHeight, sideLen);
    const leftBeam = beamLR.clone().translate(-half + borderThick / 2.0, rimY, 0);
    const rightBeam = beamLR.clone().translate(half - borderThick / 2.0, rimY, 0);
    beamLR.dispose();
    woodGeos.push(leftBeam, rightBeam);

    // 4 Corner Joint Pegs
    const pegGeo = new THREE.CylinderGeometry(0.022, 0.022, borderHeight + 0.04, 6);
    for (const cx of [-half + borderThick / 2, half - borderThick / 2]) {
      for (const cz of [-half + borderThick / 2, half - borderThick / 2]) {
        const p = pegGeo.clone().translate(cx, rimY + 0.01, cz);
        woodGeos.push(p);
      }
    }

    // 2. Interior 4-Section Cross Divider Beams (for 2x2 partitioned bed)
    if (size >= 1.5) {
      const dividerThick = 0.06;
      const dividerH = borderHeight * 0.88;
      const dividerY = dividerH / 2.0;

      // Center divider dividing Left & Right (along Z)
      const dividerZ = new THREE.BoxGeometry(dividerThick, dividerH, sideLen);
      dividerZ.translate(0, dividerY, 0);
      woodGeos.push(dividerZ);

      // Center divider dividing Front & Back (along X)
      const dividerX = new THREE.BoxGeometry(sideLen, dividerH, dividerThick);
      dividerX.translate(0, dividerY, 0);
      woodGeos.push(dividerX);

      // Center intersection bracket peg
      const centerPeg = pegGeo.clone().translate(0, rimY + 0.005, 0);
      woodGeos.push(centerPeg);
    }
    pegGeo.dispose();

    const mergedWood = mergeGeometries(woodGeos, true)!;
    woodGeos.forEach((g) => g.dispose());
    const borderMesh = new THREE.Mesh(mergedWood, FARMING_MATERIALS.woodBorder);

    group.add(borderMesh);

    // 3. Tilled Soil Surface with Furrow Ridges in each 4 Quadrants
    const soilHeight = 0.16;
    const soilGeos: THREE.BufferGeometry[] = [];

    if (size >= 1.5) {
      // 4 distinct quadrant soil beds
      const quadSpan = (size - borderThick * 2 - 0.06) / 2.0 - 0.01;
      const quadCenterDist = half - borderThick - quadSpan / 2.0;

      const quadPositions: [number, number][] = [
        [-quadCenterDist, -quadCenterDist],
        [quadCenterDist, -quadCenterDist],
        [-quadCenterDist, quadCenterDist],
        [quadCenterDist, quadCenterDist],
      ];

      for (const [qx, qz] of quadPositions) {
        // Base soil mound for quadrant
        const quadSoil = new THREE.BoxGeometry(quadSpan, soilHeight, quadSpan);
        quadSoil.translate(qx, soilHeight / 2.0, qz);
        soilGeos.push(quadSoil);

        // 2 longitudinal furrow ridges in this quadrant
        for (const fxOffset of [-quadSpan * 0.22, quadSpan * 0.22]) {
          const ridge = new THREE.CylinderGeometry(0.025, 0.04, quadSpan * 0.94, 6);
          ridge.rotateX(Math.PI / 2);
          ridge.translate(qx + fxOffset, soilHeight + 0.012, qz);
          soilGeos.push(ridge);
        }
      }
    } else {
      // Fallback single bed
      const soilWidth = size - borderThick * 2 - 0.02;
      const soilLength = size - borderThick * 2 - 0.02;
      const baseSoil = new THREE.BoxGeometry(soilWidth, soilHeight, soilLength);
      baseSoil.translate(0, soilHeight / 2.0, 0);
      soilGeos.push(baseSoil);

      for (let i = -1; i <= 1; i++) {
        const ridge = new THREE.CylinderGeometry(0.03, 0.045, soilLength * 0.96, 6);
        ridge.rotateX(Math.PI / 2);
        ridge.translate(i * (soilWidth / 3.5), soilHeight + 0.015, 0);
        soilGeos.push(ridge);
      }
    }

    const mergedSoil = mergeGeometries(soilGeos, true)!;
    soilGeos.forEach((g) => g.dispose());

    const soilMesh = new THREE.Mesh(mergedSoil, FARMING_MATERIALS.drySoil.clone());
    soilMesh.name = 'SoilBedMesh';

    group.add(soilMesh);

    return { group, soilMesh };
  }

  /**
   * Generates 3D crops for wheat, carrot, and tomato across all 4 sections simultaneously.
   */
  private static cropTemplates = new Map<string, THREE.Group>();

  public static createCropMesh(cropType: CropType, stage: CropStage): THREE.Group {
    // Every plot shares one geometry set per crop stage; clones only copy transforms, so removing
    // a crop from a plot needs no dispose and growth / harvest never allocates GPU memory
    const key = `${cropType}:${stage}`;
    let template = this.cropTemplates.get(key);
    if (!template) {
      template = this.buildCropMesh(cropType, stage);
      this.cropTemplates.set(key, template);
    }
    return template.clone();
  }

  private static buildCropMesh(cropType: CropType, stage: CropStage): THREE.Group {
    const cropGroup = new THREE.Group();
    cropGroup.name = `Crop_${cropType}_Stage${stage}_4Sections`;

    switch (cropType) {
      case 'wheat':
        this.buildWheatStage(cropGroup, stage);
        break;
      case 'carrot':
        this.buildCarrotStage(cropGroup, stage);
        break;
      case 'tomato':
        this.buildTomatoStage(cropGroup, stage);
        break;
    }

    return cropGroup;
  }

  // =========================================================================
  // 1. WHEAT (ПШЕНИЦЯ) - 4 SECTIONS ACROSS 3 STAGES
  // =========================================================================
  private static buildWheatStage(group: THREE.Group, stage: CropStage): void {
    const soilY = 0.18; // base of crop on top of tilled mound

    if (stage === 1) {
      // Stage 1: Delicate fresh green shoots across all 4 quadrants
      const sproutGeos: THREE.BufferGeometry[] = [];
      const offsets = [
        [-0.12, -0.1], [0.12, -0.1],
        [0, 0],
        [-0.1, 0.12], [0.1, 0.12]
      ];

      for (const [qx, qz] of QUADRANT_CENTERS) {
        for (const [ox, oz] of offsets) {
          const px = qx + ox;
          const pz = qz + oz;
          for (let b = 0; b < 3; b++) {
            const blade = new THREE.ConeGeometry(0.012, 0.11, 4);
            const angle = (b * Math.PI * 2) / 3 + ((px + pz) % 0.4);
            blade.rotateZ(0.22);
            blade.rotateY(angle);
            blade.translate(px, soilY + 0.055, pz);
            sproutGeos.push(blade);
          }
        }
      }

      const merged = mergeGeometries(sproutGeos)!;
      sproutGeos.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(merged, FARMING_MATERIALS.sproutGreen);

      group.add(mesh);
    } else if (stage === 2) {
      // Stage 2: Dense green stalks with young nascent ears in all 4 quadrants
      const stalkGeos: THREE.BufferGeometry[] = [];
      const earGeos: THREE.BufferGeometry[] = [];

      const offsets = [
        [-0.14, -0.14], [0, -0.14], [0.14, -0.14],
        [-0.14, 0], [0, 0], [0.14, 0],
        [-0.14, 0.14], [0, 0.14], [0.14, 0.14]
      ];

      for (const [qx, qz] of QUADRANT_CENTERS) {
        for (const [ox, oz] of offsets) {
          const px = qx + ox;
          const pz = qz + oz;

          // Stalk
          const stalk = new THREE.CylinderGeometry(0.007, 0.011, 0.30, 5);
          stalk.translate(px, soilY + 0.15, pz);
          stalkGeos.push(stalk);

          // Young green ear
          const ear = new THREE.CylinderGeometry(0.018, 0.016, 0.09, 6);
          ear.translate(px, soilY + 0.32, pz);
          earGeos.push(ear);
        }
      }

      const mergedStalks = mergeGeometries(stalkGeos)!;
      stalkGeos.forEach((g) => g.dispose());
      group.add(new THREE.Mesh(mergedStalks, FARMING_MATERIALS.leafGreen));

      const mergedEars = mergeGeometries(earGeos)!;
      earGeos.forEach((g) => g.dispose());
      group.add(new THREE.Mesh(mergedEars, FARMING_MATERIALS.sproutGreen));
    } else {
      // Stage 3: Magnificent waving golden ripe wheat across all 4 quadrants
      const goldGeos: THREE.BufferGeometry[] = [];
      const amberGeos: THREE.BufferGeometry[] = [];

      const offsets = [
        [-0.15, -0.15], [0, -0.16], [0.15, -0.15],
        [-0.16, 0], [0, 0], [0.16, 0],
        [-0.15, 0.15], [0, 0.16], [0.15, 0.15],
        [-0.08, -0.08], [0.08, 0.08]
      ];

      for (const [qx, qz] of QUADRANT_CENTERS) {
        for (const [ox, oz] of offsets) {
          const px = qx + ox;
          const pz = qz + oz;

          const h = 0.52 + ((Math.abs(px * 13 + pz * 7)) % 0.08);
          const lean = ((Math.sin(px * 10 + pz * 10)) * 0.10);

          // Tall stalk
          const stalk = new THREE.CylinderGeometry(0.008, 0.013, h, 5);
          stalk.rotateZ(lean);
          stalk.translate(px, soilY + h / 2, pz);
          goldGeos.push(stalk);

          // Plump textured grain head
          const ear = new THREE.CylinderGeometry(0.024, 0.020, 0.15, 6);
          ear.rotateZ(lean * 1.5);
          ear.translate(px + lean * h * 0.3, soilY + h + 0.06, pz);
          amberGeos.push(ear);

          // Awn whiskers / bristles
          const awn = new THREE.ConeGeometry(0.004, 0.07, 3);
          awn.rotateZ(lean * 1.8);
          awn.translate(px + lean * h * 0.35, soilY + h + 0.16, pz);
          goldGeos.push(awn);
        }
      }

      const mergedGold = mergeGeometries(goldGeos)!;
      goldGeos.forEach((g) => g.dispose());
      const goldMesh = new THREE.Mesh(mergedGold, FARMING_MATERIALS.wheatGold);

      group.add(goldMesh);

      const mergedAmber = mergeGeometries(amberGeos)!;
      amberGeos.forEach((g) => g.dispose());
      const amberMesh = new THREE.Mesh(mergedAmber, FARMING_MATERIALS.wheatAmber);

      group.add(amberMesh);
    }
  }

  // =========================================================================
  // 2. CARROT (МОРКВА) - 4 SECTIONS ACROSS 3 STAGES
  // =========================================================================
  private static buildCarrotStage(group: THREE.Group, stage: CropStage): void {
    const soilY = 0.18;
    const offsets = [
      [-0.13, -0.12], [0.13, -0.12],
      [0.0, 0.0],
      [-0.12, 0.13], [0.12, 0.13]
    ];

    if (stage === 1) {
      // Stage 1: Leafy carrot shoots in all 4 quadrants
      const greens: THREE.BufferGeometry[] = [];
      for (const [qx, qz] of QUADRANT_CENTERS) {
        for (const [ox, oz] of offsets) {
          const px = qx + ox;
          const pz = qz + oz;
          for (let a = 0; a < 4; a++) {
            const frond = new THREE.BoxGeometry(0.014, 0.09, 0.014);
            frond.rotateZ(0.28);
            frond.rotateY((a * Math.PI) / 2);
            frond.translate(px, soilY + 0.045, pz);
            greens.push(frond);
          }
        }
      }
      const merged = mergeGeometries(greens)!;
      greens.forEach((g) => g.dispose());
      group.add(new THREE.Mesh(merged, FARMING_MATERIALS.sproutGreen));
    } else if (stage === 2) {
      // Stage 2: Bushier foliage with orange crown peeking out in all 4 quadrants
      const greens: THREE.BufferGeometry[] = [];
      const orange: THREE.BufferGeometry[] = [];

      for (const [qx, qz] of QUADRANT_CENTERS) {
        for (const [ox, oz] of offsets) {
          const px = qx + ox;
          const pz = qz + oz;

          // Orange top crown
          const crown = new THREE.CylinderGeometry(0.034, 0.022, 0.045, 7);
          crown.translate(px, soilY + 0.02, pz);
          orange.push(crown);

          // Fronds
          for (let f = 0; f < 5; f++) {
            const frond = new THREE.CylinderGeometry(0.005, 0.010, 0.20, 4);
            frond.rotateZ(0.26);
            frond.rotateY((f * Math.PI * 2) / 5);
            frond.translate(px, soilY + 0.11, pz);
            greens.push(frond);
          }
        }
      }

      const mergedGreens = mergeGeometries(greens)!;
      greens.forEach((g) => g.dispose());
      group.add(new THREE.Mesh(mergedGreens, FARMING_MATERIALS.leafGreen));

      const mergedOrange = mergeGeometries(orange)!;
      orange.forEach((g) => g.dispose());
      group.add(new THREE.Mesh(mergedOrange, FARMING_MATERIALS.carrotOrange));
    } else {
      // Stage 3: Plump thick ripe carrots emerging from soil in all 4 quadrants
      const greens: THREE.BufferGeometry[] = [];
      const carrots: THREE.BufferGeometry[] = [];

      for (const [qx, qz] of QUADRANT_CENTERS) {
        for (const [ox, oz] of offsets) {
          const px = qx + ox;
          const pz = qz + oz;

          // Carrot cone root
          const carrotBody = new THREE.ConeGeometry(0.048, 0.15, 8);
          carrotBody.rotateX(Math.PI);
          carrotBody.translate(px, soilY + 0.05, pz);
          carrots.push(carrotBody);

          // Rounded carrot shoulder
          const shoulder = new THREE.SphereGeometry(0.048, 7, 5, 0, Math.PI * 2, 0, Math.PI / 2);
          shoulder.translate(px, soilY + 0.05, pz);
          carrots.push(shoulder);

          // Bushy green tops
          for (let f = 0; f < 6; f++) {
            const stem = new THREE.CylinderGeometry(0.007, 0.013, 0.28, 5);
            stem.rotateZ(0.24 + (f % 2) * 0.08);
            stem.rotateY((f * Math.PI * 2) / 6);
            stem.translate(px, soilY + 0.18, pz);
            greens.push(stem);

            const tuft = new THREE.SphereGeometry(0.04, 5, 4);
            tuft.translate(
              px + Math.sin((f * Math.PI * 2) / 6) * 0.07,
              soilY + 0.30,
              pz + Math.cos((f * Math.PI * 2) / 6) * 0.07
            );
            greens.push(tuft);
          }
        }
      }

      const mergedCarrots = mergeGeometries(carrots)!;
      carrots.forEach((g) => g.dispose());
      const carrotMesh = new THREE.Mesh(mergedCarrots, FARMING_MATERIALS.carrotRipe);

      group.add(carrotMesh);

      const mergedGreens = mergeGeometries(greens)!;
      greens.forEach((g) => g.dispose());
      const greensMesh = new THREE.Mesh(mergedGreens, FARMING_MATERIALS.darkLeafGreen);

      group.add(greensMesh);
    }
  }

  // =========================================================================
  // 3. TOMATO (ПОМІДОРИ) - 4 SECTIONS ACROSS 3 STAGES
  // =========================================================================
  private static buildTomatoStage(group: THREE.Group, stage: CropStage): void {
    const soilY = 0.18;

    if (stage === 1) {
      // Stage 1: Young tomato seedling in each of the 4 quadrants
      const geos: THREE.BufferGeometry[] = [];

      for (const [qx, qz] of QUADRANT_CENTERS) {
        const stem = new THREE.CylinderGeometry(0.010, 0.014, 0.15, 6);
        stem.translate(qx, soilY + 0.075, qz);
        geos.push(stem);

        for (let i = 0; i < 4; i++) {
          const leaf = new THREE.BoxGeometry(0.045, 0.007, 0.08);
          leaf.rotateZ(0.28);
          leaf.rotateY((i * Math.PI) / 2);
          leaf.translate(qx, soilY + 0.11, qz);
          geos.push(leaf);
        }
      }

      const merged = mergeGeometries(geos)!;
      geos.forEach((g) => g.dispose());
      group.add(new THREE.Mesh(merged, FARMING_MATERIALS.leafGreen));
    } else if (stage === 2) {
      // Stage 2: Staked vine with yellow flowers and small green tomatoes in all 4 quadrants
      const woodGeos: THREE.BufferGeometry[] = [];
      const foliageGeos: THREE.BufferGeometry[] = [];
      const flowerGeos: THREE.BufferGeometry[] = [];
      const greenTomatoes: THREE.BufferGeometry[] = [];

      for (const [qx, qz] of QUADRANT_CENTERS) {
        // Wooden stake
        const stake = new THREE.CylinderGeometry(0.016, 0.018, 0.54, 6);
        stake.translate(qx - 0.05, soilY + 0.26, qz);
        woodGeos.push(stake);

        // Climbing vine stem
        const vine = new THREE.CylinderGeometry(0.014, 0.018, 0.42, 6);
        vine.rotateZ(0.08);
        vine.translate(qx, soilY + 0.20, qz);
        foliageGeos.push(vine);

        // Branch clusters
        for (let b = 0; b < 5; b++) {
          const by = soilY + 0.11 + b * 0.05;
          const branch = new THREE.BoxGeometry(0.07, 0.010, 0.14);
          branch.rotateY((b * Math.PI * 2) / 3);
          branch.translate(qx, by, qz);
          foliageGeos.push(branch);

          const leafBall = new THREE.SphereGeometry(0.055, 5, 4);
          leafBall.translate(
            qx + Math.cos((b * Math.PI * 2) / 3) * 0.12,
            by + 0.02,
            qz + Math.sin((b * Math.PI * 2) / 3) * 0.12
          );
          foliageGeos.push(leafBall);
        }

        // Yellow blossoms
        for (let f = 0; f < 2; f++) {
          const blossom = new THREE.ConeGeometry(0.02, 0.025, 5);
          blossom.rotateX(Math.PI / 2);
          blossom.translate(
            qx + 0.10 * Math.cos((f * Math.PI * 2) / 2),
            soilY + 0.28,
            qz + 0.10 * Math.sin((f * Math.PI * 2) / 2)
          );
          flowerGeos.push(blossom);
        }

        // Small green tomatoes
        for (let t = 0; t < 2; t++) {
          const tom = new THREE.SphereGeometry(0.03, 6, 6);
          tom.translate(
            qx + 0.08 * Math.cos(t * 2.5),
            soilY + 0.20,
            qz + 0.08 * Math.sin(t * 2.5)
          );
          greenTomatoes.push(tom);
        }
      }

      group.add(new THREE.Mesh(mergeGeometries(woodGeos)!, FARMING_MATERIALS.stakeWood));
      group.add(new THREE.Mesh(mergeGeometries(foliageGeos)!, FARMING_MATERIALS.darkLeafGreen));
      group.add(new THREE.Mesh(mergeGeometries(flowerGeos)!, FARMING_MATERIALS.tomatoYellowFlower));
      group.add(new THREE.Mesh(mergeGeometries(greenTomatoes)!, FARMING_MATERIALS.tomatoGreen));
    } else {
      // Stage 3: Full tall staked tomato vines loaded with ripe red tomatoes across all 4 quadrants!
      const woodGeos: THREE.BufferGeometry[] = [];
      const foliageGeos: THREE.BufferGeometry[] = [];
      const redTomatoes: THREE.BufferGeometry[] = [];
      const calyxGeos: THREE.BufferGeometry[] = [];

      for (const [qx, qz] of QUADRANT_CENTERS) {
        // Tall wooden stake
        const stake = new THREE.CylinderGeometry(0.018, 0.022, 0.72, 6);
        stake.translate(qx - 0.06, soilY + 0.35, qz);
        woodGeos.push(stake);

        // Vine stem
        const vine = new THREE.CylinderGeometry(0.018, 0.024, 0.65, 6);
        vine.translate(qx, soilY + 0.32, qz);
        foliageGeos.push(vine);

        // Bushy canopy spheres
        for (let b = 0; b < 6; b++) {
          const by = soilY + 0.14 + b * 0.07;
          const angle = (b * Math.PI * 2) / 3.0;
          const leafSphere = new THREE.SphereGeometry(0.085, 6, 5);
          leafSphere.translate(
            qx + Math.cos(angle) * 0.13,
            by,
            qz + Math.sin(angle) * 0.13
          );
          foliageGeos.push(leafSphere);
        }

        // Top leafy crown
        const topCrown = new THREE.SphereGeometry(0.12, 6, 5);
        topCrown.translate(qx, soilY + 0.66, qz);
        foliageGeos.push(topCrown);

        // Bright red ripe tomatoes per quadrant
        const tomOffsets = [
          [0.12, 0.20, 0.05, 0.046],
          [-0.11, 0.26, 0.09, 0.048],
          [-0.12, 0.33, -0.08, 0.044],
          [0.07, 0.40, -0.11, 0.046],
          [0.11, 0.46, -0.04, 0.042],
        ];

        for (const [tx, ty, tz, rad] of tomOffsets) {
          const tomatoGeo = new THREE.SphereGeometry(rad, 7, 7);
          tomatoGeo.translate(qx + tx, soilY + ty, qz + tz);
          redTomatoes.push(tomatoGeo);

          const calyx = new THREE.ConeGeometry(rad * 0.75, 0.018, 5);
          calyx.translate(qx + tx, soilY + ty + rad * 0.88, qz + tz);
          calyxGeos.push(calyx);
        }
      }

      group.add(new THREE.Mesh(mergeGeometries(woodGeos)!, FARMING_MATERIALS.stakeWood));
      const foliageMesh = new THREE.Mesh(mergeGeometries(foliageGeos)!, FARMING_MATERIALS.darkLeafGreen);

      group.add(foliageMesh);

      const redMesh = new THREE.Mesh(mergeGeometries(redTomatoes)!, FARMING_MATERIALS.tomatoRed);

      group.add(redMesh);

      group.add(new THREE.Mesh(mergeGeometries(calyxGeos)!, FARMING_MATERIALS.leafGreen));
    }
  }

  /**
   * Generates a stylized Heartopia watering can mesh (carried in character's hand).
   */
  public static createWateringCan(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'HeartopiaWateringCan';

    const bodyGeos: THREE.BufferGeometry[] = [];
    const trimGeos: THREE.BufferGeometry[] = [];

    const s = 0.85;

    // 1. Can body (rounded cylinder)
    const body = new THREE.CylinderGeometry(0.08 * s, 0.095 * s, 0.18 * s, 12);
    body.translate(0, -0.05 * s, 0.08 * s);
    bodyGeos.push(body);

    // Bottom rim
    const bottomRim = new THREE.TorusGeometry(0.095 * s, 0.01 * s, 6, 12);
    bottomRim.rotateX(Math.PI / 2);
    bottomRim.translate(0, -0.14 * s, 0.08 * s);
    trimGeos.push(bottomRim);

    // Top rim
    const topRim = new THREE.TorusGeometry(0.08 * s, 0.01 * s, 6, 12);
    topRim.rotateX(Math.PI / 2);
    topRim.translate(0, 0.04 * s, 0.08 * s);
    trimGeos.push(topRim);

    // 2. Arch handle (grip in palm at 0, 0, 0)
    const handle = new THREE.TorusGeometry(0.10 * s, 0.014 * s, 6, 12, Math.PI);
    handle.rotateY(Math.PI / 2);
    handle.translate(0, 0.02 * s, 0);
    trimGeos.push(handle);

    // 3. Spout (pointing forward +Z and up +Y)
    const spout = new THREE.CylinderGeometry(0.016 * s, 0.026 * s, 0.20 * s, 8);
    spout.rotateX(Math.PI / 3.8);
    spout.translate(0, 0.01 * s, 0.18 * s);
    bodyGeos.push(spout);

    // 4. Sprinkler Rosette Head (rose)
    const rose = new THREE.CylinderGeometry(0.042 * s, 0.016 * s, 0.035 * s, 10);
    rose.rotateX(Math.PI / 3.8);
    rose.translate(0, 0.08 * s, 0.26 * s);
    trimGeos.push(rose);

    const mergedBody = mergeGeometries(bodyGeos)!;
    bodyGeos.forEach((g) => g.dispose());
    const bodyMesh = new THREE.Mesh(mergedBody, FARMING_MATERIALS.wateringCanBody);

    group.add(bodyMesh);

    const mergedTrim = mergeGeometries(trimGeos)!;
    trimGeos.forEach((g) => g.dispose());
    const trimMesh = new THREE.Mesh(mergedTrim, FARMING_MATERIALS.wateringCanTrim);

    group.add(trimMesh);

    // Anchor positioned directly at nozzle tip for accurate particle emission
    const nozzleAnchor = new THREE.Object3D();
    nozzleAnchor.name = 'NozzleAnchor';
    nozzleAnchor.position.set(0, 0.09 * s, 0.28 * s);
    group.add(nozzleAnchor);

    return group;
  }

  /**
   * Generates a harvest crate packed with the harvested crop resource.
   */
  public static createHarvestCrate(cropType: CropType): THREE.Group {
    const group = new THREE.Group();
    group.name = `HarvestCrate_${cropType}`;

    const crateGeos: THREE.BufferGeometry[] = [];
    const cw = 0.45;
    const ch = 0.28;
    const cd = 0.35;
    const th = 0.024;

    // Bottom board
    const bot = new THREE.BoxGeometry(cw, th, cd);
    bot.translate(0, th / 2, 0);
    crateGeos.push(bot);

    // 4 Corner vertical posts
    const postGeo = new THREE.BoxGeometry(0.04, ch, 0.04);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = postGeo.clone().translate((cw / 2 - 0.02) * sx, ch / 2, (cd / 2 - 0.02) * sz);
        crateGeos.push(post);
      }
    }
    postGeo.dispose();

    // Side slats (2 slats on each of 4 sides)
    for (const slatY of [ch * 0.32, ch * 0.75]) {
      const longSlat = new THREE.BoxGeometry(cw, 0.06, th);
      crateGeos.push(longSlat.clone().translate(0, slatY, cd / 2 - th / 2));
      crateGeos.push(longSlat.clone().translate(0, slatY, -cd / 2 + th / 2));
      longSlat.dispose();

      const shortSlat = new THREE.BoxGeometry(th, 0.06, cd - th * 2);
      crateGeos.push(shortSlat.clone().translate(cw / 2 - th / 2, slatY, 0));
      crateGeos.push(shortSlat.clone().translate(-cw / 2 + th / 2, slatY, 0));
      shortSlat.dispose();
    }

    const mergedCrate = mergeGeometries(crateGeos)!;
    crateGeos.forEach((g) => g.dispose());
    const crateMesh = new THREE.Mesh(mergedCrate, FARMING_MATERIALS.crateWood);

    group.add(crateMesh);

    // Contents filler inside crate
    let fillerMat = FARMING_MATERIALS.wheatGold;
    if (cropType === 'carrot') fillerMat = FARMING_MATERIALS.carrotRipe;
    if (cropType === 'tomato') fillerMat = FARMING_MATERIALS.tomatoRed;

    const fillGeo = new THREE.BoxGeometry(cw - 0.06, 0.18, cd - 0.06);
    fillGeo.translate(0, ch * 0.65, 0);
    const fillMesh = new THREE.Mesh(fillGeo, fillerMat);
    group.add(fillMesh);

    return group;
  }

  /**
   * Generates a procedural 2D Water Droplet CanvasTexture for floating billboard plot indicators.
   */
  public static createWaterDropTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      // 1. Soft radial glow (cyan aura)
      const glowGrad = ctx.createRadialGradient(64, 68, 0, 64, 68, 56);
      glowGrad.addColorStop(0, 'rgba(56, 189, 248, 0.50)');
      glowGrad.addColorStop(0.5, 'rgba(14, 165, 233, 0.22)');
      glowGrad.addColorStop(1.0, 'rgba(14, 165, 233, 0.0)');

      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(64, 68, 56, 0, Math.PI * 2);
      ctx.fill();

      // 2. Soft shadow under drop
      ctx.shadowColor = 'rgba(2, 132, 199, 0.65)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;

      // 3. Teardrop path
      ctx.beginPath();
      ctx.moveTo(64, 18);
      ctx.bezierCurveTo(74, 38, 96, 60, 96, 78);
      ctx.arc(64, 78, 32, 0, Math.PI, false);
      ctx.bezierCurveTo(32, 60, 54, 38, 64, 18);
      ctx.closePath();

      // Drop gradient fill
      const dropGrad = ctx.createLinearGradient(64, 18, 64, 110);
      dropGrad.addColorStop(0, '#f0f9ff'); // Top ice cyan sheen
      dropGrad.addColorStop(0.28, '#38bdf8'); // Sky cyan
      dropGrad.addColorStop(0.72, '#0284c7'); // Ocean blue
      dropGrad.addColorStop(1.0, '#0369a1'); // Deep base blue

      ctx.fillStyle = dropGrad;
      ctx.fill();

      ctx.shadowColor = 'transparent';

      // Crisp white border
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // 4. Glossy curved highlight reflection
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(54, 54, 7, 18, -Math.PI / 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fill();
      ctx.restore();

      // 5. Specular dot highlight
      ctx.beginPath();
      ctx.arc(74, 82, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }
}
