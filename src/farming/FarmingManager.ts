import * as THREE from 'three';
import { t, dataName } from '../i18n/i18n';
import { CropType, CropStage, FarmPlot, CROP_DEFINITIONS, FarmInteractionPrompt } from './types/FarmingTypes';
import { FarmingMeshGenerator, FARMING_MATERIALS } from './FarmingMeshGenerator';
import { ParticleManager } from '../particles/ParticleManager';
import { audioEngine } from '../audio/AudioEngine';

export class FarmingManager {
  private plots: Map<string, FarmPlot> = new Map();
  private scene: THREE.Scene;
  private particleManager: ParticleManager | null = null;
  private tempVec = new THREE.Vector3();
  private waterDropMaterial: THREE.SpriteMaterial | null = null;
  private animTime: number = 0;
  /** 0..1 from the weather system; rain waters thirsty crops on its own. */
  public rainIntensity = 0;
  private rainTimer = 0;

  constructor(scene: THREE.Scene, particleManager?: ParticleManager) {
    this.scene = scene;
    if (particleManager) {
      this.particleManager = particleManager;
    }
  }

  private getWaterDropMaterial(): THREE.SpriteMaterial {
    if (!this.waterDropMaterial) {
      const texture = FarmingMeshGenerator.createWaterDropTexture();
      this.waterDropMaterial = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
        depthWrite: false,
      });
    }
    return this.waterDropMaterial;
  }

  public registerPlot(
    pieceId: string,
    position: THREE.Vector3,
    meshGroup: THREE.Group,
    soilMesh: THREE.Mesh | null
  ): FarmPlot {
    // Check if already registered
    const existing = this.plots.get(pieceId);
    if (existing) return existing;

    const cropMeshGroup = new THREE.Group();
    cropMeshGroup.name = `CropContainer_${pieceId}`;
    meshGroup.add(cropMeshGroup);

    // Floating 2D billboard water drop indicator
    const waterIndicator = new THREE.Sprite(this.getWaterDropMaterial());
    waterIndicator.name = `WaterIndicator_${pieceId}`;
    waterIndicator.scale.set(0.68, 0.68, 1.0);
    waterIndicator.position.set(0, 1.35, 0);
    waterIndicator.visible = false;
    meshGroup.add(waterIndicator);

    const plot: FarmPlot = {
      id: `farm_plot_${pieceId}`,
      pieceId,
      position: position.clone(),
      meshGroup,
      soilMesh,
      crop: null,
      cropMeshGroup,
      waterIndicator,
    };

    this.plots.set(pieceId, plot);
    return plot;
  }

  public unregisterPlot(pieceId: string): void {
    const plot = this.plots.get(pieceId);
    if (!plot) return;

    if (plot.waterIndicator) {
      plot.meshGroup.remove(plot.waterIndicator);
    }

    if (plot.cropMeshGroup) {
      while (plot.cropMeshGroup.children.length > 0) {
        const child = plot.cropMeshGroup.children[0];
        plot.cropMeshGroup.remove(child);
      }
      plot.meshGroup.remove(plot.cropMeshGroup);
    }

    this.plots.delete(pieceId);
  }

  public getPlot(pieceId: string): FarmPlot | null {
    return this.plots.get(pieceId) || null;
  }

  public getAllPlots(): FarmPlot[] {
    return Array.from(this.plots.values());
  }

  /**
   * Main update loop advancing crop growth timers and handling stage transitions.
   */
  public update(dt: number): void {
    this.animTime += dt;

    // Rain waters one thirsty plot every ~0.4 s (staggered so it reads as rain soaking in)
    if (this.rainIntensity > 0.35) {
      this.rainTimer -= dt;
      if (this.rainTimer <= 0) {
        this.rainTimer = 0.4;
        for (const plot of this.plots.values()) {
          if (plot.crop && !plot.crop.isWatered && plot.crop.stage < 3) {
            plot.crop.isWatered = true;
            plot.crop.waterCount += 1;
            this.setSoilVisual(plot, true);
            break;
          }
        }
      }
    }

    let plotIndex = 0;
    for (const plot of this.plots.values()) {
      plotIndex++;
      if (plot.crop) {
        // Only grows if currently watered!
        if (plot.crop.isWatered && plot.crop.stage < 3) {
          plot.crop.growthTimer += dt;

          // Check if ready for next stage
          if (plot.crop.growthTimer >= plot.crop.stageDuration) {
            if (plot.crop.stage === 1) {
              // Advance to stage 2: plant grows bigger, but needs watering again!
              plot.crop.stage = 2;
              plot.crop.isWatered = false; // Dries out for 2nd required watering!
              plot.crop.growthTimer = 0;

              // Update visuals
              this.updateCropVisual(plot);
              this.setSoilVisual(plot, false);

              // Audio & particles
              audioEngine.at(plot.position).playHitSound();
              if (this.particleManager) {
                this.particleManager.emitBuildPuff(plot.position, true);
              }
            } else if (plot.crop.stage === 2) {
              // Advance to stage 3: Ripe, ready to harvest!
              plot.crop.stage = 3;
              plot.crop.isWatered = false;
              plot.crop.growthTimer = plot.crop.stageDuration;

              // Update visuals
              this.updateCropVisual(plot);
              this.setSoilVisual(plot, false);

              // Celebration sound & particles
              audioEngine.at(plot.position).playHarvest();
              if (this.particleManager) {
                this.particleManager.emitBuildPuff(plot.position, false);
              }
            }
          }
        }
      }

      // Update 2D water drop billboard indicator animation & visibility
      if (plot.waterIndicator) {
        const needsWater = plot.crop !== null && plot.crop.stage < 3 && !plot.crop.isWatered;
        if (needsWater) {
          plot.waterIndicator.visible = true;
          // Smooth floating sine wave bobbing
          const floatY = 1.35 + Math.sin(this.animTime * 3.5 + plotIndex * 0.8) * 0.08;
          // Smooth pulse scale
          const pulseScale = 0.68 + Math.sin(this.animTime * 4.5 + plotIndex * 0.5) * 0.05;

          plot.waterIndicator.position.y = floatY;
          plot.waterIndicator.scale.set(pulseScale, pulseScale, 1.0);
        } else {
          plot.waterIndicator.visible = false;
        }
      }
    }
  }

  /**
   * Plants seeds in an empty plot.
   */
  public plant(pieceId: string, cropType: CropType): boolean {
    const plot = this.plots.get(pieceId);
    if (!plot || plot.crop !== null) return false;

    const def = CROP_DEFINITIONS[cropType];
    plot.crop = {
      cropType,
      stage: 1,
      waterCount: 0,
      isWatered: false,
      growthTimer: 0,
      stageDuration: def.stageSeconds,
    };

    this.updateCropVisual(plot);
    this.setSoilVisual(plot, false);

    audioEngine.at(plot.position).playPlantSeed();
    if (this.particleManager) {
      this.particleManager.emitBuildPuff(plot.position, true);
    }
    return true;
  }

  /**
   * Waters a thirsty plot.
   */
  public water(pieceId: string): boolean {
    const plot = this.plots.get(pieceId);
    if (!plot || !plot.crop) return false;

    // Already watered or already ripe
    if (plot.crop.isWatered || plot.crop.stage >= 3) return false;

    plot.crop.isWatered = true;
    plot.crop.waterCount += 1;

    this.setSoilVisual(plot, true);
    audioEngine.at(plot.position).playWatering();

    // Emit gentle water droplet splash
    if (this.particleManager) {
      this.particleManager.emitSplash(plot.position, 1.2);
    }
    return true;
  }

  /**
   * Harvests a fully grown mature crop (yields 1 crate).
   */
  public harvest(pieceId: string): { cropType: CropType; crateItemId: string; bonusSeeds: number } | null {
    const plot = this.plots.get(pieceId);
    if (!plot || !plot.crop || plot.crop.stage < 3) return null;

    const cropType = plot.crop.cropType;
    const crateItemId = CROP_DEFINITIONS[cropType].crateItemId;

    // Remove crop from plot
    plot.crop = null;
    while (plot.cropMeshGroup.children.length > 0) {
      const child = plot.cropMeshGroup.children[0];
      plot.cropMeshGroup.remove(child);
    }

    this.setSoilVisual(plot, false);

    // Audio & celebratory particles
    audioEngine.at(plot.position).playHarvest();
    if (this.particleManager) {
      this.particleManager.emitSplash(plot.position, 1.8);
      this.particleManager.emitBuildPuff(plot.position, true);
    }

    // Half the harvests give 1-2 seeds back, so a farm keeps itself going
    const bonusSeeds = Math.random() < 0.5 ? 1 + Math.floor(Math.random() * 2) : 0;
    return { cropType, crateItemId, bonusSeeds };
  }

  private updateCropVisual(plot: FarmPlot): void {
    while (plot.cropMeshGroup.children.length > 0) {
      const child = plot.cropMeshGroup.children[0];
      plot.cropMeshGroup.remove(child);
    }

    if (!plot.crop) return;

    const newMesh = FarmingMeshGenerator.createCropMesh(plot.crop.cropType, plot.crop.stage);
    plot.cropMeshGroup.add(newMesh);
  }

  private setSoilVisual(plot: FarmPlot, isWatered: boolean): void {
    if (plot.soilMesh) {
      plot.soilMesh.material = isWatered ? FARMING_MATERIALS.wetSoil : FARMING_MATERIALS.drySoil;
    }
  }

  /**
   * Evaluates the nearest plot to player and generates tactical interaction prompt data.
   */
  public getNearbyInteraction(
    playerPosition: THREE.Vector3,
    equippedItemId: string | null,
    maxDistance: number = 3.2
  ): FarmInteractionPrompt | null {
    let closestPlot: FarmPlot | null = null;
    let minDist = maxDistance;

    for (const plot of this.plots.values()) {
      const dist = playerPosition.distanceTo(plot.position);
      if (dist < minDist) {
        minDist = dist;
        closestPlot = plot;
      }
    }

    if (!closestPlot) return null;

    const isWateringCan = equippedItemId === 'watering_can';
    const isSeed = equippedItemId?.endsWith('_seed');
    const cropType = closestPlot.crop?.cropType || null;
    const stage = closestPlot.crop?.stage || null;
    const waterCount = closestPlot.crop?.waterCount ?? 0;
    const isWatered = closestPlot.crop?.isWatered ?? false;

    // 1. Empty plot: can plant if holding seed
    if (!closestPlot.crop) {
      let seedCropType: CropType | null = null;
      if (equippedItemId === 'wheat_seed') seedCropType = 'wheat';
      else if (equippedItemId === 'carrot_seed') seedCropType = 'carrot';
      else if (equippedItemId === 'tomato_seed') seedCropType = 'tomato';

      return {
        plotId: closestPlot.pieceId,
        cropType: null,
        stage: null,
        waterCount: 0,
        isWatered: false,
        canPlant: seedCropType !== null,
        canWater: false,
        canHarvest: false,
        growthProgress: 0,
        actionText: seedCropType
          ? t('farm.plant', { name: dataName('item', CROP_DEFINITIONS[seedCropType].seedItemId, CROP_DEFINITIONS[seedCropType].seedNameUk) })
          : t('farm.needSeeds'),
        hintText: t('farm.plantHint'),
      };
    }

    // 2. Stage 3 (Mature): ready to harvest!
    if (stage === 3) {
      const def = CROP_DEFINITIONS[cropType!];
      return {
        plotId: closestPlot.pieceId,
        cropType,
        stage: 3,
        waterCount,
        isWatered,
        canPlant: false,
        canWater: false,
        canHarvest: true,
        growthProgress: 1.0,
        actionText: t('farm.harvest', { name: dataName('crop', def.type, def.nameUk) }),
        hintText: t('farm.harvestHint', { name: dataName('item', def.crateItemId, def.crateNameUk) }),
      };
    }

    // 3. Stage 1 or 2: growing or needs water
    const def = CROP_DEFINITIONS[cropType!];
    const progress = Math.min(1.0, closestPlot.crop.growthTimer / closestPlot.crop.stageDuration);

    if (!isWatered) {
      const waterStepText = stage === 1 ? t('farm.water1') : t('farm.water2');
      return {
        plotId: closestPlot.pieceId,
        cropType,
        stage,
        waterCount,
        isWatered: false,
        canPlant: false,
        canWater: isWateringCan,
        canHarvest: false,
        growthProgress: progress,
        actionText: isWateringCan ? t('farm.water', { step: waterStepText }) : t('farm.needCan', { step: waterStepText }),
        hintText: t('farm.dryHint'),
      };
    }

    // Currently watered and growing
    return {
      plotId: closestPlot.pieceId,
      cropType,
      stage,
      waterCount,
      isWatered: true,
      canPlant: false,
      canWater: false,
      canHarvest: false,
      growthProgress: progress,
      actionText: t('farm.growing', { stage, name: dataName('crop', def.type, def.nameUk), pct: Math.round(progress * 100) }),
      hintText: stage === 1 ? t('farm.growHint1') : t('farm.growHint2'),
    };
  }

  /** Crops keyed by plot position (piece ids can change between sessions). */
  public serializeCrops(): { x: number; z: number; crop: NonNullable<FarmPlot['crop']> }[] {
    return this.getAllPlots()
      .filter((p) => p.crop)
      .map((p) => ({ x: +p.position.x.toFixed(2), z: +p.position.z.toFixed(2), crop: { ...p.crop! } }));
  }

  public deserializeCrops(data: { x: number; z: number; crop: NonNullable<FarmPlot['crop']> }[]): void {
    for (const d of data) {
      const plot = this.getAllPlots().find((p) => Math.abs(p.position.x - d.x) < 0.1 && Math.abs(p.position.z - d.z) < 0.1);
      if (!plot) continue;
      plot.crop = { ...d.crop };
      this.updateCropVisual(plot);
      this.setSoilVisual(plot, plot.crop.isWatered);
    }
  }
}
