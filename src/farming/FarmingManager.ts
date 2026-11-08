import * as THREE from 'three';
import { t, dataName } from '../i18n/i18n';
import { CropType, CropState, CROP_DEFINITIONS, CROP_TYPES, FarmInteractionPrompt } from './types/FarmingTypes';
import { FarmingMeshGenerator } from './FarmingMeshGenerator';
import { ParticleManager } from '../particles/ParticleManager';
import { audioEngine } from '../audio/AudioEngine';
import { FieldManager, FarmField, FieldSaveData, FIELD_CELLS, FIELD_CRATE_YIELD, FIELD_SEED_COST } from './FieldManager';
import { fieldCropTime } from './WheatModel';
import type { TerrainSystem } from '../world/TerrainSystem';
import type { PhysicsWorld } from '../physics/PhysicsWorld';

const SEED_TO_CROP: Record<string, CropType> = Object.fromEntries(CROP_TYPES.map((c) => [CROP_DEFINITIONS[c].seedItemId, c]));

/** Crop type a seed item grows into (null for anything else). */
export function cropForSeed(itemId: string | null | undefined): CropType | null {
  return (itemId && SEED_TO_CROP[itemId]) || null;
}

/** Growth speed of a dry crop relative to a watered one. */
const UNWATERED_GROWTH_SPEED = 0.3;

export interface HarvestResult {
  cropType: CropType;
  crateItemId: string;
  crates: number;
  bonusSeeds: number;
}

/**
 * Farming on shovel-dug fields: sowing, watering, growth and harvest. The fields themselves
 * (terrain soil, instanced crops, springs) live in FieldManager.
 */
export class FarmingManager {
  private particleManager: ParticleManager | null = null;
  private tempVec = new THREE.Vector3();
  private waterDropMaterial: THREE.SpriteMaterial | null = null;
  private animTime: number = 0;
  /** 0..1 from the weather system; rain waters thirsty crops on its own. */
  public rainIntensity = 0;
  /** Shovel-dug fields (instanced crops on terrain soil). */
  public readonly fields: FieldManager;

  constructor(scene: THREE.Scene, particleManager?: ParticleManager) {
    if (particleManager) this.particleManager = particleManager;
    this.fields = new FieldManager(scene, () => this.getWaterDropMaterial());
  }

  public setWorld(terrain: TerrainSystem, physics: PhysicsWorld): void {
    this.fields.setWorld(terrain, physics);
  }

  private getWaterDropMaterial(): THREE.SpriteMaterial {
    if (!this.waterDropMaterial) {
      this.waterDropMaterial = new THREE.SpriteMaterial({
        map: FarmingMeshGenerator.createWaterDropTexture(),
        transparent: true,
        depthTest: true,
        depthWrite: false,
      });
    }
    return this.waterDropMaterial;
  }

  /**
   * Advances a crop. Returns the stage it just reached (2 or 3) or 0 when nothing changed.
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

  public update(dt: number): void {
    this.animTime += dt;
    fieldCropTime.value = this.animTime;

    // Rain replaces manual watering: every field is soaked, exactly as if watered by hand
    const raining = this.rainIntensity > 0.35;
    this.fields.rainWet = raining;
    for (const field of this.fields.getAll()) {
      const crop = field.crop;
      if (!crop) continue;
      if (raining && !crop.isWatered && crop.stage < 3) {
        crop.isWatered = true;
        crop.waterCount += 1;
      }
      if (this.advanceCrop(crop, dt)) this.fields.markCropsDirty();
    }
    this.fields.update(dt, this.animTime);
  }

  /** Seeds one sowing takes. */
  public getSeedCost(_id: string): number {
    return FIELD_SEED_COST;
  }

  /** Ground position of a field (for facing it). */
  public getTargetPosition(id: string): THREE.Vector3 | null {
    return this.fields.get(id)?.center ?? null;
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

  /** Sows an empty field. */
  public plant(id: string, cropType: CropType): boolean {
    const field = this.fields.get(id);
    if (!field || field.crop) return false;
    field.crop = this.newCrop(cropType);
    this.fields.markCropsDirty();
    audioEngine.at(field.center).playPlantSeed();
    this.puffField(field);
    return true;
  }

  /** Waters a thirsty field. */
  public water(id: string): boolean {
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

  /** Harvests a ripe field: several crates and some seed back. */
  public harvest(id: string): HarvestResult | null {
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

  /**
   * Builds the interaction prompt for the field the player stands on or beside.
   * `seedCount` is how many of the equipped seeds the player has (a field takes several).
   */
  public getNearbyInteraction(
    playerPosition: THREE.Vector3,
    equippedItemId: string | null,
    _maxDistance: number = 3.2,
    seedCount: number = Infinity
  ): FarmInteractionPrompt | null {
    // Fields are measured to their edge, so standing on (or right beside) one targets it
    const near = this.fields.nearest(playerPosition.x, playerPosition.z, 1.4);
    return near ? this.buildPrompt(near.field.id, near.field.crop, equippedItemId, seedCount) : null;
  }

  private buildPrompt(id: string, crop: CropState | null, equippedItemId: string | null, seedCount: number): FarmInteractionPrompt {
    const isWateringCan = equippedItemId === 'watering_can';
    const cropType = crop?.cropType || null;
    const stage = crop?.stage || null;
    const waterCount = crop?.waterCount ?? 0;
    const isWatered = crop?.isWatered ?? false;
    const base = { plotId: id, isField: true, cropType, stage, waterCount, isWatered, canPlant: false, canWater: false, canHarvest: false };

    // 1. Empty: can sow if holding enough seeds
    if (!crop) {
      const seedCropType = cropForSeed(equippedItemId);
      const cost = FIELD_SEED_COST;
      const enough = seedCount >= cost;
      let actionText = t('farm.needSeeds');
      if (seedCropType) {
        const def = CROP_DEFINITIONS[seedCropType];
        const name = dataName('item', def.seedItemId, def.seedNameUk);
        actionText = enough ? t('field.sow', { name, n: cost }) : t('field.notEnoughSeeds', { n: cost, have: seedCount });
      }
      return {
        ...base,
        canPlant: seedCropType !== null && enough,
        growthProgress: 0,
        actionText,
        hintText: t('field.sowHint', { n: cost, crates: FIELD_CRATE_YIELD }),
      };
    }

    const def = CROP_DEFINITIONS[cropType!];

    // 2. Ripe: ready to harvest
    if (stage === 3) {
      return {
        ...base,
        canHarvest: true,
        growthProgress: 1.0,
        actionText: t('farm.harvest', { name: dataName('crop', def.type, def.nameUk) }),
        hintText: t('field.harvestHint', { n: FIELD_CRATE_YIELD, name: dataName('item', def.crateItemId, def.crateNameUk) }),
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
        actionText: isWateringCan ? t('field.water', { step: waterStepText }) : t('farm.needCan', { step: waterStepText }),
        hintText: t('farm.dryHint'),
      };
    }

    return {
      ...base,
      growthProgress: progress,
      actionText: t('farm.growing', { stage, name: dataName('crop', def.type, def.nameUk), pct: Math.round(progress * 100) }),
      hintText: stage === 1 ? t('farm.growHint1') : t('farm.growHint2'),
    };
  }

  public serializeFields(): FieldSaveData[] {
    return this.fields.serialize();
  }

  public deserializeFields(data: FieldSaveData[]): void {
    this.fields.deserialize(data);
  }
}
