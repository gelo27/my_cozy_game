import { CROP_DEFINITIONS } from '../../farming/types/FarmingTypes';
import * as THREE from 'three';
import { IAbility, CharacterContext } from './IAbility';
import { FarmingManager } from '../../farming/FarmingManager';
import { InventoryManager } from '../../inventory/InventoryManager';
import { FarmInteractionPrompt, CropType } from '../../farming/types/FarmingTypes';

export class FarmingAbility implements IAbility {
  public name = 'FarmingAbility';
  public enabled = true;

  public farmingManager: FarmingManager | null = null;
  public inventoryManager: InventoryManager | null = null;
  public currentPrompt: FarmInteractionPrompt | null = null;

  public setManagers(farming: FarmingManager, inventory: InventoryManager): void {
    this.farmingManager = farming;
    this.inventoryManager = inventory;
  }

  public update(dt: number, context: CharacterContext): void {
    if (!this.enabled || !this.farmingManager || !this.inventoryManager) {
      this.currentPrompt = null;
      return;
    }

    const input = context.input as any;
    const playerPos = new THREE.Vector3(
      context.body.translation().x,
      context.body.translation().y,
      context.body.translation().z
    );

    const equippedId = this.inventoryManager.getEquippedItemId();

    // 1. Evaluate nearby farm plot interaction
    this.currentPrompt = this.farmingManager.getNearbyInteraction(playerPos, equippedId, 3.2);

    // If build mode or inventory is open, do not execute farming clicks
    const isBuildModeActive = (context as any).controller?.buildAbility?.isBuildModeActive;
    const isPaintingModeActive = (context as any).controller?.buildAbility?.isPaintingModeActive;
    if (isBuildModeActive || isPaintingModeActive || this.inventoryManager.isInventoryOpen()) {
      return;
    }

    // 2. Check for interaction trigger (E key or Left Click)
    const interactTriggered = input.interactJustPressed || (input.shootJustPressed && this.currentPrompt !== null);

    if (interactTriggered && this.currentPrompt) {
      const prompt = this.currentPrompt;

      // Face the garden plot directly when starting interaction
      const plot = this.farmingManager.getPlot(prompt.plotId);
      if (plot && context.model) {
        const dx = plot.position.x - playerPos.x;
        const dz = plot.position.z - playerPos.z;
        if (dx * dx + dz * dz > 0.001) {
          context.model.setFacingAngleInstant(Math.atan2(dx, dz));
        }
      }

      // A. Harvest mature crop
      if (prompt.canHarvest) {
        const result = this.farmingManager.harvest(prompt.plotId);
        if (result) {
          this.inventoryManager.addItem(result.crateItemId, 1);
          if (result.bonusSeeds) this.inventoryManager.addItem(CROP_DEFINITIONS[result.cropType].seedItemId, result.bonusSeeds);
          // Trigger celebration gesture
          if (context.model) {
            context.model.triggerJumpSquash();
          }
        }
        return;
      }

      // B. Water thirsty crop
      if (prompt.canWater) {
        const watered = this.farmingManager.water(prompt.plotId);
        if (watered) {
          // Trigger dedicated watering animation
          if (context.model) {
            context.model.triggerWatering(1.1);
          }
        }
        return;
      }

      // C. Plant seed in empty plot
      if (prompt.canPlant && equippedId) {
        let cropType: CropType | null = null;
        if (equippedId === 'wheat_seed') cropType = 'wheat';
        else if (equippedId === 'carrot_seed') cropType = 'carrot';
        else if (equippedId === 'tomato_seed') cropType = 'tomato';

        if (cropType && this.inventoryManager.hasItem(equippedId, 1)) {
          const planted = this.farmingManager.plant(prompt.plotId, cropType);
          if (planted) {
            this.inventoryManager.removeItem(equippedId, 1);
            // Trigger plant gesture
            if (context.model) {
              context.model.triggerJumpSquash();
            }
          }
        }
        return;
      }
    } else if (input.shootJustPressed && equippedId === 'watering_can') {
      // Freeform watering click with watering can equipped
      if (context.model) {
        context.model.triggerWatering(1.1);
      }
    }

    // 3. Emit sparkling water stream ONLY while actively pouring water from nozzle
    if (context.model && context.model.isActivelyPouringWater() && context.particleManager) {
      const nozzlePos = new THREE.Vector3();
      if (context.model.getWateringNozzleWorldPosition(nozzlePos)) {
        const facingAngle = context.model.group.rotation.y;
        const forwardDir = new THREE.Vector3(Math.sin(facingAngle), 0, Math.cos(facingAngle)).normalize();
        context.particleManager.emitWateringStream(nozzlePos, forwardDir, 3);
      }
    }
  }
}
