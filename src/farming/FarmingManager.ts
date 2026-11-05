import * as THREE from 'three';
import { t, dataName } from '../i18n/i18n';
import { CropType, CropState, FarmPlot, CROP_DEFINITIONS, FarmInteractionPrompt } from './types/FarmingTypes';
import { FarmingMeshGenerator, FARMING_MATERIALS } from './FarmingMeshGenerator';
import { ParticleManager } from '../particles/ParticleManager';
import { audioEngine } from '../audio/AudioEngine';
import { FieldManager, FarmField, FieldSaveData, FIELD_CELLS, FIELD_CRATE_YIELD, FIELD_SEED_COST } from './FieldManager';
import { fieldCropTime } from './WheatModel';
import type { TerrainSystem } from '../world/TerrainSystem';
import type { PhysicsWorld } from '../physics/PhysicsWorld';

const SEED_TO_CROP: Record<string, CropType> = { wheat_seed: 'wheat', carrot_seed: 'carrot', tomato_seed: 'tomato' };

/** Crop type a seed item grows into (null for anything else). */
export function cropForSeed(itemId: string | null | undefined): CropType | null {
  return (itemId && SEED_TO_CROP[itemId]) || null;
}

/** Growth speed of a dry crop relative to a watered one. */
const UNWATERED_GROWTH_SPEED = 0.3;

const isFieldId = (id: string) => id.startsWith('field_');

export interface HarvestResult {
  cropType: CropType;
  crateItemId: string;
  crates: number;
  bonusSeeds: number;
}

export class FarmingManager {
  private plots: Map<string, FarmPlot> = new Map();
  private scene: THREE.Scene;
  private particleManager: ParticleManager | null = null;
  private tempVec = new THREE.Vector3();
  private waterDropMaterial: THREE.SpriteMaterial | null = null;
  private animTime: number = 0;
  /** 0..1 from the weather system; rain waters thirsty crops on its own. */
  public rainIntensity = 0;
  private rainWasOn = false;
  /** Big shovel-dug fields (instanced crops on terrain soil). */
  public readonly fields: FieldManager;

  constructor(scene: THREE.Scene, particleManager?: ParticleManager) {
    this.scene = scene;
    if (particleManager) {
      this.particleManager = particleManager;
    }
    this.fields = new FieldManager(scene, () => this.getWaterDropMaterial());
    // Garden beds have no static collider to block a field: keep fields clear of them explicitly
    this.fields.isAreaReserved = (minX, minZ, maxX, maxZ) => {
      for (const plot of this.plots.values()) {
        const p = plot.position;
        if (p.x + 1.1 > minX && p.x - 1.1 < maxX && p.z + 1.1 > minZ && p.z - 1.1 < maxZ) return true;
      }
      return false;
    };
  }

  public setWorld(terrain: TerrainSystem, physics: PhysicsWorld): void {
    this.fields.setWorld(terrain, physics);
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
   * Advances a watered crop. Returns the stage it just reached (2 or 3) or 0 when nothing changed.
   * Each stage dries the soil again, so a crop needs one watering per stage.
   */
  private advanceCrop(crop: CropState, dt: number): 0 | 2 | 3 {
    if (crop.stage >= 3) return 0;
    // Crops ripen on their own; water makes them grow much faster
    crop.growthTimer += dt * (crop.isWatered ? 1 : UNWATERED_GROWTH_SPEED);
    if (crop.growthTimer < crop.stageDuration) return 0;
    crop.isWatered = false;
    if (crop.stage === 1) {
      crop.stage = 2;
      crop.growthTimer = 0;
      return 2;
    }
    crop.stage = 3;
    crop.growthTimer = crop.stageDuration;
    return 3;
  }

  /**
   * Main update loop advancing crop growth timers and handling stage transitions.
   */
  public update(dt: number): void {
    this.animTime += dt;
    fieldCropTime.value = this.animTime;

    // Rain replaces manual watering: every plot and field is soaked, exactly as if watered by hand
    const raining = this.rainIntensity > 0.35;
    this.fields.rainWet = raining;
    if (raining) {
      for (const plot of this.plots.values()) {
        if (plot.crop && !plot.crop.isWatered && plot.crop.stage < 3) {
          plot.crop.isWatered = true;
          plot.crop.waterCount += 1;
        }
        // Wet soil look even for empty beds
        this.setSoilVisual(plot, true);
      }
      for (const field of this.fields.getAll()) {
        if (field.crop && !field.crop.isWatered && field.crop.stage < 3) {
          field.crop.isWatered = true;
          field.crop.waterCount += 1;
        }
      }
      this.rainWasOn = true;
    } else if (this.rainWasOn) {
      this.rainWasOn = false;
      for (const plot of this.plots.values()) this.setSoilVisual(plot, plot.crop?.isWatered ?? false);
    }

    let plotIndex = 0;
    for (const plot of this.plots.values()) {
      plotIndex++;
      if (plot.crop) {
        const reached = this.advanceCrop(plot.crop, dt);
        if (reached) {
          this.updateCropVisual(plot);
          this.setSoilVisual(plot, false);
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

    for (const field of this.fields.getAll()) {
      if (!field.crop) continue;
      const reached = this.advanceCrop(field.crop, dt);
      if (reached) {
        this.fields.markCropsDirty();
      }
    }
    this.fields.update(dt, this.animTime);
  }

  /** Seeds one planting takes on this plot or field. */
  public getSeedCost(id: string): number {
    return isFieldId(id) ? FIELD_SEED_COST : 1;
  }

  /** Ground position of a plot or field (for facing it). */
  public getTargetPosition(id: string): THREE.Vector3 | null {
    if (isFieldId(id)) return this.fields.get(id)?.center ?? null;
    return this.plots.get(id)?.position ?? null;
  }

  /**
   * Plants seeds in an empty plot or field.
   */
  public plant(pieceId: string, cropType: CropType): boolean {
    if (isFieldId(pieceId)) return this.plantField(pieceId, cropType);
    const plot = this.plots.get(pieceId);
    if (!plot || plot.crop !== null) return false;

    plot.crop = this.newCrop(cropType);

    this.updateCropVisual(plot);
    this.setSoilVisual(plot, false);

    audioEngine.at(plot.position).playPlantSeed();
    if (this.particleManager) {
      this.particleManager.emitBuildPuff(plot.position, true);
    }
    return true;
  }

  /**
   * Waters a thirsty plot or field.
   */
  public water(pieceId: string): boolean {
    if (isFieldId(pieceId)) return this.waterField(pieceId);
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
   * Harvests a fully grown crop (a bed yields 1 crate, a field several).
   */
  public harvest(pieceId: string): HarvestResult | null {
    if (isFieldId(pieceId)) return this.harvestField(pieceId);
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
    return { cropType, crateItemId, crates: 1, bonusSeeds };
  }

  private newCrop(cropType: CropType): CropState {
    return {
      cropType,
      stage: 1,
      waterCount: 0,
      isWatered: false,
      growthTimer: 0,
      stageDuration: CROP_DEFINITIONS[cropType].stageSeconds,
    };
  }

  // ---------------------------------------------------------------- fields

  /** Sprinkles soil clods across a field (digging, sowing, harvesting). */
  public puffField(field: { gx: number; gz: number; center: THREE.Vector3 }, count = 5): void {
    if (!this.particleManager) return;
    for (let i = 0; i < count; i++) {
      this.tempVec.set(
        field.gx + 0.6 + Math.random() * (FIELD_CELLS - 1.2),
        field.center.y,
        field.gz + 0.6 + Math.random() * (FIELD_CELLS - 1.2)
      );
      this.particleManager.emitDirtClods(this.tempVec, 6);
    }
  }

  private plantField(id: string, cropType: CropType): boolean {
    const field = this.fields.get(id);
    if (!field || field.crop) return false;
    field.crop = this.newCrop(cropType);
    this.fields.markCropsDirty();
    audioEngine.at(field.center).playPlantSeed();
    this.puffField(field);
    return true;
  }

  private waterField(id: string): boolean {
    const field = this.fields.get(id);
    if (!field?.crop || field.crop.isWatered || field.crop.stage >= 3) return false;
    field.crop.isWatered = true;
    field.crop.waterCount += 1;
    audioEngine.at(field.center).playWatering();
    if (this.particleManager) {
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        this.particleManager.emitSplash(this.tempVec.set(field.center.x + ox, field.center.y, field.center.z + oz), 6);
      }
    }
    return true;
  }

  private harvestField(id: string): HarvestResult | null {
    const field: FarmField | null = this.fields.get(id);
    if (!field?.crop || field.crop.stage < 3) return null;
    const cropType = field.crop.cropType;
    field.crop = null;
    this.fields.markCropsDirty();
    audioEngine.at(field.center).playHarvest();
    this.puffField(field, 6);
    this.particleManager?.emitBuildPuff(field.center, true, 24);
    // A field always returns some seed (2-4), so it can be sown again
    const bonusSeeds = 2 + Math.floor(Math.random() * 3);
    return { cropType, crateItemId: CROP_DEFINITIONS[cropType].crateItemId, crates: FIELD_CRATE_YIELD, bonusSeeds };
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
   * Evaluates the nearest plot or field to the player and builds the interaction prompt.
   * `seedCount` is how many of the equipped seeds the player has (a field takes several).
   */
  public getNearbyInteraction(
    playerPosition: THREE.Vector3,
    equippedItemId: string | null,
    maxDistance: number = 3.2,
    seedCount: number = Infinity
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

    // Fields are measured to their edge, so standing on (or right beside) one targets it.
    // A bed's edge is ~1 m from its centre: compare like with like.
    const nearField = this.fields.nearest(playerPosition.x, playerPosition.z, 1.4);
    if (nearField && (!closestPlot || nearField.dist < minDist - 1)) {
      return this.buildPrompt(nearField.field.id, nearField.field.crop, equippedItemId, true, seedCount);
    }
    if (!closestPlot) return null;
    return this.buildPrompt(closestPlot.pieceId, closestPlot.crop, equippedItemId, false, seedCount);
  }

  private buildPrompt(
    id: string,
    crop: CropState | null,
    equippedItemId: string | null,
    isField: boolean,
    seedCount: number
  ): FarmInteractionPrompt {
    const isWateringCan = equippedItemId === 'watering_can';
    const cropType = crop?.cropType || null;
    const stage = crop?.stage || null;
    const waterCount = crop?.waterCount ?? 0;
    const isWatered = crop?.isWatered ?? false;
    const base = { plotId: id, isField, cropType, stage, waterCount, isWatered, canPlant: false, canWater: false, canHarvest: false };

    // 1. Empty: can plant if holding (enough) seeds
    if (!crop) {
      const seedCropType = cropForSeed(equippedItemId);
      const cost = isField ? FIELD_SEED_COST : 1;
      const enough = seedCount >= cost;
      let actionText = t('farm.needSeeds');
      if (seedCropType) {
        const def = CROP_DEFINITIONS[seedCropType];
        const name = dataName('item', def.seedItemId, def.seedNameUk);
        actionText = !enough
          ? t('field.notEnoughSeeds', { n: cost, have: seedCount })
          : isField
            ? t('field.sow', { name, n: cost })
            : t('farm.plant', { name });
      }
      return {
        ...base,
        canPlant: seedCropType !== null && enough,
        growthProgress: 0,
        actionText,
        hintText: isField ? t('field.sowHint', { n: cost, crates: FIELD_CRATE_YIELD }) : t('farm.plantHint'),
      };
    }

    const def = CROP_DEFINITIONS[cropType!];

    // 2. Stage 3 (Mature): ready to harvest!
    if (stage === 3) {
      const crateName = dataName('item', def.crateItemId, def.crateNameUk);
      return {
        ...base,
        canHarvest: true,
        growthProgress: 1.0,
        actionText: t('farm.harvest', { name: dataName('crop', def.type, def.nameUk) }),
        hintText: isField
          ? t('field.harvestHint', { n: FIELD_CRATE_YIELD, name: crateName })
          : t('farm.harvestHint', { name: crateName }),
      };
    }

    // 3. Stage 1 or 2: growing or needs water
    const progress = Math.min(1.0, crop.growthTimer / crop.stageDuration);

    if (!isWatered) {
      const waterStepText = stage === 1 ? t('farm.water1') : t('farm.water2');
      return {
        ...base,
        canWater: isWateringCan,
        growthProgress: progress,
        actionText: isWateringCan
          ? t(isField ? 'field.water' : 'farm.water', { step: waterStepText })
          : t('farm.needCan', { step: waterStepText }),
        hintText: t('farm.dryHint'),
      };
    }

    // Currently watered and growing
    return {
      ...base,
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

  public serializeFields(): FieldSaveData[] {
    return this.fields.serialize();
  }

  public deserializeFields(data: FieldSaveData[]): void {
    this.fields.deserialize(data);
  }
}
