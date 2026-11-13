import * as THREE from 'three';
import { t } from '../../i18n/i18n';
import { IAbility, CharacterContext } from './IAbility';
import { FarmingManager, cropForSeed } from '../../farming/FarmingManager';
import { FIELD_CELLS, FIELD_SEED_COST, ShovelTarget } from '../../farming/FieldManager';
import { InventoryManager } from '../../inventory/InventoryManager';
import { FarmInteractionPrompt } from '../../farming/types/FarmingTypes';
import { audioEngine } from '../../audio/AudioEngine';

const SWING_TIME = 0.7;
const SWING_IMPACT = 0.38;
/** Seconds E / LMB must be held to dig or fill a field (guards against accidental presses). */
const HOLD_TIME = 0.6;

interface ShovelJob {
  kind: 'dig' | 'fill' | 'uproot';
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

  /**
   * Set by the engine: true when a station, the NPC, a find or a pet the player faces should get E
   * instead of the shovel.
   */
  public activityProbe: ((pos: THREE.Vector3) => boolean) | null = null;
  private activityTimer = 0;
  private activityNear = false;

  private shovelJob: ShovelJob | null = null;
  /** Hold-to-act: armed by a fresh press on an actionable target, cancelled on release or retarget. */
  private holdArmed = false;
  private holdKey = '';
  private holdTime = 0;
  private readonly playerPos = new THREE.Vector3();

  /** E / LMB is held on a ripe crop and the bar is filling: the player stands still. */
  public get isHarvestHolding(): boolean {
    return this.holdArmed && this.holdKey.startsWith('h');
  }
  private readonly tmpVec = new THREE.Vector3();

  /** Harvested items land in the inventory as they reach the player. */
  private readonly give = (itemId: string, amount: number): void => {
    this.inventoryManager?.addItem(itemId, amount);
  };

  public setManagers(farming: FarmingManager, inventory: InventoryManager): void {
    this.farmingManager = farming;
    this.inventoryManager = inventory;
  }

  public update(dt: number, context: CharacterContext): void {
    // Swimming / diving: tools are put away, nothing in hand can be used
    if (!this.enabled || !this.farmingManager || !this.inventoryManager || context.isSwimming) {
      this.farmingManager?.fields.showGhost(0, 0, null);
      this.shovelJob = null;
      this.resetHold();
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

    // If build mode or inventory is open, or watering / the harvest pick-up is still playing,
    // do not start anything new (the pouring stream below keeps running)
    if (blocked || context.model?.isActionLocked()) {
      this.resetHold();
      this.emitWateringStream(context);
      return;
    }

    // A. Harvest mature crop: hold E / LMB, same as digging
    if (this.currentPrompt?.canHarvest) {
      const prompt = this.currentPrompt;
      const key = `h${prompt.plotId}`;
      if (input.interactJustPressed || input.shootJustPressed) {
        this.holdArmed = true;
        this.holdKey = key;
        this.holdTime = 0;
        const target = this.farmingManager.getTargetPosition(prompt.plotId);
        if (target && context.model) {
          const dx = target.x - playerPos.x;
          const dz = target.z - playerPos.z;
          if (dx * dx + dz * dz > 0.001) context.model.setFacingAngleInstant(Math.atan2(dx, dz));
        }
      }
      if (!this.holdArmed || key !== this.holdKey || !(input.interact || input.shoot)) {
        this.resetHold();
        return;
      }
      this.holdTime += dt;
      prompt.holdProgress = Math.min(1, this.holdTime / HOLD_TIME);
      audioEngine.setHoldFill(prompt.holdProgress);
      if (this.holdTime < HOLD_TIME) return;
      this.resetHold();
      if (this.farmingManager.harvest(prompt.plotId, this.give)) context.model?.triggerPickup();
      return;
    }
    this.resetHold();

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

      // B. Water thirsty crop
      if (prompt.canWater) {
        if (this.farmingManager.water(prompt.plotId)) context.model?.triggerWatering();
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
      context.model?.triggerWatering();
    }

    this.emitWateringStream(context);
  }

  /** Sparkling water stream, only while the can is actually tipped. */
  private emitWateringStream(context: CharacterContext): void {
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

    // A nearby station, the NPC, a find or a faced pet takes E: the shovel steps aside
    this.activityTimer -= dt;
    if (this.activityTimer <= 0) {
      this.activityTimer = 0.1;
      this.activityNear = !!this.activityProbe?.(playerPos);
    }
    if (this.activityNear) {
      this.currentPrompt = null;
      fields.showGhost(0, 0, null);
      this.resetHold();
      return;
    }

    // The shovel works only where the crosshair meets the ground (aimed as soon as it is in hand),
    // within reach of the player
    const input = context.input as any;
    const aim = context.isGroundAiming ? context.groundAim : null;
    if (!context.isGroundAiming) {
      // Swimming, climbing, building: nothing to aim at
      fields.showGhost(0, 0, null);
      this.currentPrompt = null;
      this.resetHold();
      return;
    }
    if (!aim || !aim.inReach) {
      fields.showGhost(0, 0, null);
      this.currentPrompt = { ...this.tooFarPrompt() };
      this.resetHold();
      return;
    }

    // The field ghost sits under the crosshair
    const target = fields.resolveShovelTarget(aim.point.x, aim.point.z);
    const prompt = (this.currentPrompt = this.buildShovelPrompt(target));

    if (target.kind === 'dig') fields.showGhost(target.gx, target.gz, target.reason ? 'bad' : 'ok');
    else fields.showGhost(target.field.gx, target.field.gz, 'fill');

    // Hold E / LMB: a fresh press arms it, releasing or the frame moving to another spot cancels
    const actionable = canAct && !!prompt.canDig;
    const key = target.kind === 'dig' ? `d${target.gx},${target.gz}` : `f${target.field.id}`;
    if (actionable && (input.interactJustPressed || input.shootJustPressed)) {
      this.holdArmed = true;
      this.holdKey = key;
      this.holdTime = 0;
    }
    if (!actionable || !this.holdArmed || key !== this.holdKey || !(input.interact || input.shoot)) {
      this.resetHold();
      return;
    }
    this.holdTime += dt;
    prompt.holdProgress = Math.min(1, this.holdTime / HOLD_TIME);
    audioEngine.setHoldFill(prompt.holdProgress);
    if (this.holdTime < HOLD_TIME) return;
    this.resetHold();

    const gx = target.kind === 'dig' ? target.gx : target.field.gx;
    const gz = target.kind === 'dig' ? target.gz : target.field.gz;
    this.shovelJob = {
      kind: target.kind,
      gx,
      gz,
      fieldId: target.kind === 'dig' ? null : target.field.id,
      swingsLeft: target.kind === 'dig' ? 2 : 1,
      timer: 0,
      impactDone: false,
    };
    // Turn to the field for the dig (the body is free while aiming)
    const fdx = gx + FIELD_CELLS / 2 - playerPos.x, fdz = gz + FIELD_CELLS / 2 - playerPos.z;
    if (fdx * fdx + fdz * fdz > 1) context.model?.setFacingAngleInstant(Math.atan2(fdx, fdz));
    this.startSwing(context);
  }

  private resetHold(): void {
    this.holdArmed = false;
    this.holdTime = 0;
    audioEngine.setHoldFill(null);
  }

  /** The player stands on the field, so they dig the way they already face. */
  private startSwing(context: CharacterContext): void {
    const job = this.shovelJob!;
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
      // An aimed field a few metres off: the earth flies there, not at the feet
      const fcx = job.gx + FIELD_CELLS / 2, fcz = job.gz + FIELD_CELLS / 2;
      if ((fcx - t.x) ** 2 + (fcz - t.z) ** 2 > 2.25 + (FIELD_CELLS / 2) ** 2) bladePos.set(fcx, t.y - 0.9, fcz);
      context.particleManager?.emitDirtClods(bladePos, 12);
      audioEngine.at(bladePos).playShovelDig();
      job.swingsLeft--;
      if (job.swingsLeft <= 0) this.finishShovelJob();
    }

    if (job.timer >= SWING_TIME) {
      if (job.swingsLeft > 0) {
        this.startSwing(context);
      } else {
        this.shovelJob = null;
      }
    }
    if (this.shovelJob) fields.showGhost(job.gx, job.gz, job.kind === 'dig' ? 'ok' : 'fill');
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
        fields.onDug?.(field);
        farming.puffField(field, 8);
        audioEngine.at(field.center).playShovelPat(0.42);
      }
    } else if (job.kind === 'uproot' && job.fieldId) {
      farming.uproot(job.fieldId, this.give);
    } else if (job.fieldId) {
      const field = fields.get(job.fieldId);
      if (field && !field.crop) {
        farming.puffField(field, 6);
        audioEngine.at(field.center).playShovelPat(0.42);
        fields.removeField(field.id);
      }
    }
  }

  private tooFarPrompt(): FarmInteractionPrompt {
    return {
      plotId: '', isField: true, cropType: null, stage: null, waterCount: 0, isWatered: false,
      canWater: false, canPlant: false, canHarvest: false, growthProgress: 0,
      shovel: 'blocked', canDig: false, actionText: t('aim.tooFar'), hintText: '',
    };
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
        return { ...base, shovel: 'blocked', canDig: false, actionText: t(`field.reason.${target.reason}`), hintText: t(`field.reason.${target.reason}`) };
      }
      return { ...base, shovel: 'dig', canDig: true, actionText: t('field.dig'), hintText: t('field.digHint') };
    }
    if (target.kind === 'uproot') {
      const ripe = (target.field.crop?.stage ?? 0) >= 3;
      return {
        ...base,
        shovel: 'uproot',
        canDig: true,
        actionText: t(ripe ? 'field.uprootRipe' : 'field.uproot'),
        hintText: t(ripe ? 'field.uprootRipeHint' : 'field.uprootHint', { n: FIELD_SEED_COST }),
      };
    }
    return { ...base, shovel: 'fill', canDig: true, actionText: t('field.fill'), hintText: t('field.fillHint') };
  }
}
