import { CROP_DEFINITIONS } from '../../farming/types/FarmingTypes';
import * as THREE from 'three';
import { t } from '../../i18n/i18n';
import { IAbility, CharacterContext } from './IAbility';
import { FarmingManager, cropForSeed } from '../../farming/FarmingManager';
import { FIELD_CELLS, ShovelTarget } from '../../farming/FieldManager';
import { InventoryManager } from '../../inventory/InventoryManager';
import { FarmInteractionPrompt } from '../../farming/types/FarmingTypes';
import { audioEngine } from '../../audio/AudioEngine';

/** How far ahead of the player the field preview is centred (metres). */
const SHOVEL_REACH = FIELD_CELLS / 2 + 1.0;
const SWING_TIME = 0.7;
const SWING_IMPACT = 0.38;

interface ShovelJob {
  kind: 'dig' | 'fill';
  gx: number;
  gz: number;
  fieldId: string | null;
  swingsLeft: number;
  timer: number;
  impactDone: boolean;
}

export class FarmingAbility implements IAbility {
  public name = 'FarmingAbility';
  public enabled = true;

  public farmingManager: FarmingManager | null = null;
  public inventoryManager: InventoryManager | null = null;
  public currentPrompt: FarmInteractionPrompt | null = null;

  private shovelJob: ShovelJob | null = null;
  private readonly playerPos = new THREE.Vector3();
  private readonly tmpVec = new THREE.Vector3();

  public setManagers(farming: FarmingManager, inventory: InventoryManager): void {
    this.farmingManager = farming;
    this.inventoryManager = inventory;
  }

  public update(dt: number, context: CharacterContext): void {
    if (!this.enabled || !this.farmingManager || !this.inventoryManager) {
      this.farmingManager?.fields.showGhost(0, 0, null);
      this.shovelJob = null;
      this.currentPrompt = null;
      return;
    }

    const input = context.input as any;
    const tr = context.body.translation();
    const playerPos = this.playerPos.set(tr.x, tr.y, tr.z);
    const equippedId = this.inventoryManager.getEquippedItemId();

    const isBuildModeActive = (context as any).controller?.buildAbility?.isBuildModeActive || context.isBuildModeActive;
    const isPaintingModeActive = (context as any).controller?.buildAbility?.isPaintingModeActive;
    const blocked = isBuildModeActive || isPaintingModeActive || this.inventoryManager.isInventoryOpen();

    // Shovel: preview, dig and fill fields
    if (equippedId === 'shovel' || this.shovelJob) {
      this.updateShovel(dt, context, playerPos, !blocked && equippedId === 'shovel');
      return;
    }
    this.farmingManager.fields.showGhost(0, 0, null);

    // 1. Evaluate nearby farm plot / field interaction
    const seedCount = equippedId ? this.inventoryManager.getItemCount(equippedId) : 0;
    this.currentPrompt = this.farmingManager.getNearbyInteraction(playerPos, equippedId, 3.2, seedCount);

    // If build mode or inventory is open, do not execute farming clicks
    if (blocked) return;

    // 2. Check for interaction trigger (E key or Left Click)
    const interactTriggered = input.interactJustPressed || (input.shootJustPressed && this.currentPrompt !== null);

    if (interactTriggered && this.currentPrompt) {
      const prompt = this.currentPrompt;

      // Face the plot / field when starting interaction
      const target = this.farmingManager.getTargetPosition(prompt.plotId);
      if (target && context.model) {
        const dx = target.x - playerPos.x;
        const dz = target.z - playerPos.z;
        if (dx * dx + dz * dz > 0.001) {
          context.model.setFacingAngleInstant(Math.atan2(dx, dz));
        }
      }

      // A. Harvest mature crop
      if (prompt.canHarvest) {
        const result = this.farmingManager.harvest(prompt.plotId);
        if (result) {
          this.inventoryManager.addItem(result.crateItemId, result.crates);
          if (result.bonusSeeds) this.inventoryManager.addItem(CROP_DEFINITIONS[result.cropType].seedItemId, result.bonusSeeds);
          context.model?.triggerJumpSquash();
        }
        return;
      }

      // B. Water thirsty crop
      if (prompt.canWater) {
        if (this.farmingManager.water(prompt.plotId)) context.model?.triggerWatering(1.1);
        return;
      }

      // C. Plant seeds in an empty plot / field
      if (prompt.canPlant && equippedId) {
        const cropType = cropForSeed(equippedId);
        const cost = this.farmingManager.getSeedCost(prompt.plotId);
        if (cropType && this.inventoryManager.hasItem(equippedId, cost)) {
          if (this.farmingManager.plant(prompt.plotId, cropType)) {
            this.inventoryManager.removeItem(equippedId, cost);
            context.model?.triggerJumpSquash();
          }
        }
        return;
      }
    } else if (input.shootJustPressed && equippedId === 'watering_can') {
      // Freeform watering click with watering can equipped
      context.model?.triggerWatering(1.1);
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

  // ---------------------------------------------------------------- shovel

  private updateShovel(dt: number, context: CharacterContext, playerPos: THREE.Vector3, canAct: boolean): void {
    const farming = this.farmingManager!;
    const fields = farming.fields;

    if (this.shovelJob) {
      this.advanceShovelJob(dt, context);
      return;
    }

    // Preview the field in front of the character
    const facing = context.model?.group.rotation.y ?? 0;
    const cx = playerPos.x + Math.sin(facing) * SHOVEL_REACH;
    const cz = playerPos.z + Math.cos(facing) * SHOVEL_REACH;
    const target = fields.resolveShovelTarget(cx, cz);
    this.currentPrompt = this.buildShovelPrompt(target);

    if (target.kind === 'dig') fields.showGhost(target.gx, target.gz, target.reason ? 'bad' : 'ok');
    else fields.showGhost(target.field.gx, target.field.gz, target.kind === 'fill' ? 'fill' : 'bad');

    if (!canAct || !this.currentPrompt.canDig) return;
    const input = context.input as any;
    if (!input.interactJustPressed && !input.shootJustPressed) return;

    const gx = target.kind === 'dig' ? target.gx : target.field.gx;
    const gz = target.kind === 'dig' ? target.gz : target.field.gz;
    this.shovelJob = {
      kind: target.kind === 'dig' ? 'dig' : 'fill',
      gx,
      gz,
      fieldId: target.kind === 'fill' ? target.field.id : null,
      swingsLeft: target.kind === 'dig' ? 2 : 1,
      timer: 0,
      impactDone: false,
    };
    this.startSwing(context, playerPos);
  }

  private startSwing(context: CharacterContext, playerPos: THREE.Vector3): void {
    const job = this.shovelJob!;
    const dx = job.gx + FIELD_CELLS / 2 - playerPos.x;
    const dz = job.gz + FIELD_CELLS / 2 - playerPos.z;
    if (dx * dx + dz * dz > 0.01) context.model?.setFacingAngleInstant(Math.atan2(dx, dz));
    context.model?.triggerMineSwing();
    job.timer = 0;
    job.impactDone = false;
  }

  private advanceShovelJob(dt: number, context: CharacterContext): void {
    const job = this.shovelJob!;
    const farming = this.farmingManager!;
    const fields = farming.fields;
    job.timer += dt;

    // Shovel bites into the ground: clods where the blade lands, the field fills in under the ghost
    if (!job.impactDone && job.timer >= SWING_IMPACT) {
      job.impactDone = true;
      const t = context.body.translation();
      const facing = context.model?.group.rotation.y ?? 0;
      const bladePos = this.tmpVec.set(t.x + Math.sin(facing) * 0.9, t.y - 0.9, t.z + Math.cos(facing) * 0.9);
      context.particleManager?.emitDirtClods(bladePos, 12);
      audioEngine.at(bladePos).playPlantSeed();
      job.swingsLeft--;
      if (job.swingsLeft <= 0) this.finishShovelJob();
    }

    if (job.timer >= SWING_TIME) {
      if (job.swingsLeft > 0) {
        const t = context.body.translation();
        this.startSwing(context, this.tmpVec.set(t.x, t.y, t.z));
      } else {
        this.shovelJob = null;
      }
    }
    if (this.shovelJob) fields.showGhost(job.gx, job.gz, job.kind === 'fill' ? 'fill' : 'ok');
  }

  private finishShovelJob(): void {
    const job = this.shovelJob!;
    const farming = this.farmingManager!;
    const fields = farming.fields;
    if (job.kind === 'dig') {
      // Re-check: something may have moved in during the swings
      const target = fields.resolveShovelTarget(job.gx + FIELD_CELLS / 2, job.gz + FIELD_CELLS / 2);
      if (target.kind !== 'dig' || target.reason || target.gx !== job.gx || target.gz !== job.gz) return;
      const field = fields.createField(job.gx, job.gz);
      if (field) {
        farming.puffField(field, 8);
        audioEngine.at(field.center).playBuildPlace(true);
      }
    } else if (job.fieldId) {
      const field = fields.get(job.fieldId);
      if (field && !field.crop) {
        farming.puffField(field, 6);
        audioEngine.at(field.center).playBuildPlace(true);
        fields.removeField(field.id);
      }
    }
  }

  private buildShovelPrompt(target: ShovelTarget): FarmInteractionPrompt {
    const base: FarmInteractionPrompt = {
      plotId: target.kind === 'dig' ? '' : target.field.id,
      isField: true,
      cropType: target.kind === 'dig' ? null : target.field.crop?.cropType ?? null,
      stage: null,
      waterCount: 0,
      isWatered: false,
      canWater: false,
      canPlant: false,
      canHarvest: false,
      growthProgress: 0,
      actionText: '',
      hintText: '',
    };
    if (target.kind === 'dig') {
      if (target.reason) {
        return { ...base, shovel: 'blocked', canDig: false, actionText: t('field.cantDig'), hintText: t(`field.reason.${target.reason}`) };
      }
      return { ...base, shovel: 'dig', canDig: true, actionText: t('field.dig'), hintText: t('field.digHint') };
    }
    if (target.kind === 'busy') {
      return { ...base, shovel: 'blocked', canDig: false, actionText: t('field.busy'), hintText: t('field.busyHint') };
    }
    return { ...base, shovel: 'fill', canDig: true, actionText: t('field.fill'), hintText: t('field.fillHint') };
  }
}
