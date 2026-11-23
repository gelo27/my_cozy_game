import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { COLLISION_GROUPS } from '../../config/constants';
import { interactionFocus, FOCUS_TOOL } from '../../gameplay/InteractionFocus';
import { t, t as tr, plural, dataName } from '../../i18n/i18n';
import { IAbility, CharacterContext } from './IAbility';
import { ForestZone, ForestTarget } from '../../forest/ForestZone';
import { RockField, RockNode } from '../../gathering/RockField';
import { PropTreeField, PropTreeNode } from '../../gathering/PropTreeField';
import { InventoryManager } from '../../inventory/InventoryManager';
import { GATHERING_CONFIG, GatherTool, ROCK_TYPES, RockKind } from '../../gathering/GatheringConfig';
import { audioEngine } from '../../audio/AudioEngine';
import { hitFx } from '../../gameplay/HitFeedback';
import type { PestSystem, Pest } from '../../gameplay/Pests';
import { APPLE_SAPLING_ID, AppleOrchard, AppleTreeNode } from '../../gathering/AppleOrchard';
import { WebField, WEB_REACH } from '../../world/SpiderWebs';
import { FlowerBeds, tulipItemIndex } from '../../gathering/FlowerBeds';
import { TreeNursery, seedTreeType } from '../../gathering/TreeNursery';
import { HEDGE_TYPE } from '../../world/Hedge';
import type { CaveNetwork } from '../../explore/cave/CaveNetwork';
import type { NuggetMetal } from '../../explore/cave/CaveNuggets';

/** The axe reaches a pest this far past its body (m); a bit more than a tree, they move. */
const PEST_REACH = 1.9;
const DYNAMITE_ID = 'dynamite';
const DYNAMITE_FUSE = 1.35;
const DYNAMITE_RADIUS = 2.7;
const DYNAMITE_BODY_GEO = new THREE.CylinderGeometry(0.065, 0.065, 0.28, 8);
const DYNAMITE_BODY_MAT = new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.75 });
const DYNAMITE_BAND_GEO = new THREE.BoxGeometry(0.25, 0.045, 0.15);
const DYNAMITE_BAND_MAT = new THREE.MeshStandardMaterial({ color: 0xd6b36b, roughness: 0.85 });
const DYNAMITE_FUSE_GEO = new THREE.CylinderGeometry(0.012, 0.016, 0.12, 5);
const DYNAMITE_FUSE_MAT = new THREE.MeshStandardMaterial({ color: 0xe7d7a4, roughness: 0.8 });
const DYNAMITE_SPARK_GEO = new THREE.SphereGeometry(0.025, 6, 5);
const DYNAMITE_SPARK_MAT = new THREE.MeshBasicMaterial({ color: 0xffb52e });

interface ThrownDynamite {
  mesh: THREE.Group;
  body: RAPIER.RigidBody;
  position: THREE.Vector3;
  fuse: number;
  canBlastCave: boolean;
}

interface BlastPulse {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  life: number;
}

export interface GatherPrompt {
  kind: 'tree' | 'fallen' | RockKind;
  title: string;
  actionText: string;
  hintText: string;
  /** 0..1 how far the node is from breaking. */
  progress: number;
  canAct: boolean;
}

type Target =
  | { type: 'forest'; node: ForestTarget }
  | { type: 'propTree'; node: PropTreeNode }
  | { type: 'rock'; node: RockNode }
  | { type: 'pest'; node: Pest }
  | { type: 'apple'; node: AppleTreeNode }
  | { type: 'web'; node: { position: THREE.Vector3; radius: number } }
  | { type: 'cave'; node: { position: THREE.Vector3; radius: number }; normal: THREE.Vector3; nugget?: { id: string; metal: NuggetMetal } };

/** What the E / LMB prompt can be about (webs have their own). */
type FieldTarget = Exclude<Target, { type: 'web' | 'cave' }>;

/**
 * Chopping trees with the axe and mining rocks with the pickaxe (E / LMB).
 * The hit lands IMPACT_DELAY after the swing starts so it lines up with the CHOP / MINE clip.
 */
export class GatheringAbility implements IAbility {
  private readonly playerPosScratch = new THREE.Vector3();
  private readonly caveRayOrigin = new THREE.Vector3();
  private readonly caveRayDirection = new THREE.Vector3();
  public name = 'GatheringAbility';
  public enabled = true;

  public currentPrompt: GatherPrompt | null = null;
  /** Lets the viewport show the aiming reticle while the pickaxe is used underground. */
  public isCaveMining = false;

  private forest: ForestZone | null = null;
  private rocks: RockField | null = null;
  private propTrees: PropTreeField | null = null;
  private inventory: InventoryManager | null = null;

  private cooldown = 0;
  /** Yaw towards the tree / rock being struck, held while the swing lasts (null otherwise). */
  public swingFacing: number | null = null;
  private pendingHit: { target: Target; direction: THREE.Vector3; delay: number; knock?: boolean } | null = null;
  /** Player-planted apple trees (wired by the engine). */
  public orchard: AppleOrchard | null = null;
  /** Hedgehogs and dragons the axe can strike (wired by the engine). */
  public pests: PestSystem | null = null;
  /** Spider webs the axe cuts (wired by the engine). */
  public webs: WebField | null = null;
  /** Tulip clumps planted from the hotbar (wired by the engine). */
  public flowers: FlowerBeds | null = null;
  /** Pines, oaks and bushes planted from the seeds felled trees drop (wired by the engine). */
  public nursery: TreeNursery | null = null;
  public caveNetwork: CaveNetwork | null = null;
  public onNuggetCollected: ((itemId: string) => void) | null = null;
  private readonly facingScratch = new THREE.Vector3();
  private readonly throwOriginScratch = new THREE.Vector3();
  private readonly throwDirectionScratch = new THREE.Vector3();
  private readonly thrownDynamite: ThrownDynamite[] = [];
  private readonly blastPulses: BlastPulse[] = [];

  public setSystems(forest: ForestZone, rocks: RockField, inventory: InventoryManager, propTrees: PropTreeField | null = null): void {
    this.forest = forest;
    this.propTrees = propTrees;
    this.rocks = rocks;
    this.inventory = inventory;
  }

  public update(dt: number, context: CharacterContext): void {
    this.caveNetwork?.setDigHighlight(null);
    this.updateDynamite(dt, context);
    // Swimming / diving: tools are put away (a swing under way is dropped)
    if (!this.enabled || !this.forest || !this.rocks || !this.inventory || context.isSwimming) {
      this.isCaveMining = false;
      if (context.isSwimming) {
        this.pendingHit = null;
        this.swingFacing = null;
      }
      this.orchard?.hideGhost();
      this.flowers?.hideGhost();
      this.nursery?.hideGhost();
      this.currentPrompt = null;
      return;
    }

    this.cooldown = Math.max(0, this.cooldown - dt);
    this.updatePendingHit(dt);
    if (this.cooldown === 0 && !this.pendingHit) this.swingFacing = null;

    // Keep this name distinct from the imported translation helper `t()` used below for prompts.
    const bodyPosition = context.body.translation();
    const playerPos = this.playerPosScratch.set(bodyPosition.x, bodyPosition.y, bodyPosition.z);
    const tool = this.equippedTool();
    this.isCaveMining = !!this.caveNetwork?.contains(playerPos) && tool === 'pickaxe'
      && !context.isBuildModeActive && !this.inventory.isInventoryOpen();

    // Dynamite is a consumable thrown from the selected hotbar slot.
    if (this.inventory.getEquippedItemId() === DYNAMITE_ID) {
      const inCave = !!this.caveNetwork?.contains(playerPos);
      const canThrow = inCave && this.cooldown <= 0 && !context.isBuildModeActive && !this.inventory.isInventoryOpen() && !context.isSwimming
        && !context.isClimbing && !context.isHoldingObject && !context.model?.isActionLocked();
      this.currentPrompt = {
        kind: 'stone', title: t('dynamite.title'), actionText: !inCave ? t('dynamite.caveOnly') : canThrow ? t('dynamite.throw') : t('dynamite.blocked'),
        hintText: canThrow ? t('dynamite.hint') : '', progress: 0, canAct: canThrow,
      };
      if (canThrow) interactionFocus.offer('gather', null, FOCUS_TOOL);
      const throwPressed = context.input.interactJustPressed || !!context.input.shootJustReleased
        || (context.input.shootJustPressed && !context.input.isMouseDown);
      if (canThrow && interactionFocus.allows('gather') && throwPressed) {
        this.throwDynamite(playerPos, context);
      }
      return;
    }

    // Axe in hand and a pest close: the swing goes to the pest, not the tree behind it
    if (tool === 'axe' && this.pests && !context.isBuildModeActive && !this.inventory.isInventoryOpen()) {
      const yaw = context.model?.group?.rotation.y ?? 0;
      const facing = this.facingScratch.set(Math.sin(yaw), 0, Math.cos(yaw));
      const pest = this.pests.findMeleeTarget(playerPos, facing, PEST_REACH);
      if (pest) {
        this.currentPrompt = null;
        // A pest in front of the axe is a fight: it wins over whatever else is around
        interactionFocus.offer('gather', null, FOCUS_TOOL);
        const triggered = interactionFocus.allows('gather') && this.wantsSwing(context);
        if (triggered && this.cooldown <= 0 && !this.pendingHit) this.swing({ type: 'pest', node: pest }, playerPos, tool, context);
        return;
      }
    }

    // A spider web in front (or holding the player): the axe cuts it, without one there's a hint
    if (this.webs && !context.isBuildModeActive && !this.inventory.isInventoryOpen()) {
      const yaw = context.model?.group?.rotation.y ?? 0;
      const facing = this.facingScratch.set(Math.sin(yaw), 0, Math.cos(yaw));
      const web = this.webs.findMeleeTarget(playerPos, facing, WEB_REACH);
      if (web && (tool === 'axe' || this.webs.isPlayerStuck)) {
        const axe = tool === 'axe';
        this.currentPrompt = {
          kind: 'tree', title: tr('web.title'), actionText: axe ? tr('web.cut') : tr('gather.needAxe'), hintText: '', progress: 0, canAct: axe,
        };
        if (axe) interactionFocus.offer('gather', web.position, FOCUS_TOOL);
        const triggered = interactionFocus.allows('gather') && this.wantsSwing(context);
        if (axe && triggered && this.cooldown <= 0 && !this.pendingHit) {
          this.swing({ type: 'web', node: { position: web.position.clone(), radius: 0 } }, playerPos, 'axe', context);
        }
        return;
      }
    }

    // Apple sapling in hand: a ghost shows where it goes, E plants it
    if (this.orchard) {
      const planting = this.inventory.getEquippedItemId() === APPLE_SAPLING_ID && !context.isBuildModeActive && !this.inventory.isInventoryOpen();
      if (planting) {
        this.updatePlanting(playerPos, context);
        return;
      }
      this.orchard.hideGhost();
    }

    // Tulips in hand: a ghost clump of their colour shows where they go, E plants them
    if (this.flowers) {
      const color = tulipItemIndex(this.inventory.getEquippedItemId());
      if (color >= 0 && !context.isBuildModeActive && !this.inventory.isInventoryOpen()) {
        this.updateFlowerPlanting(playerPos, context, color);
        return;
      }
      this.flowers.hideGhost();
    }

    // A pine cone, an acorn or a bush cutting in hand: a ghost sapling at the crosshair, E plants it
    if (this.nursery) {
      const type = seedTreeType(this.inventory.getEquippedItemId());
      if (type && !context.isBuildModeActive && !this.inventory.isInventoryOpen()) {
        this.updateTreePlanting(playerPos, context, type);
        return;
      }
      this.nursery.hideGhost();
    }

    // In a cave, the crosshair decides what the pickaxe hits. Nearby ore nodes must not steal
    // the wall target just because their centres happen to be closer to the player.
    const aimedCaveWall = this.isCaveMining ? this.findCaveWall(context, playerPos) : null;
    const target: FieldTarget | Extract<Target, { type: 'cave' }> | null = aimedCaveWall ?? this.findTarget(playerPos);
    if (target?.type === 'cave') this.caveNetwork?.setDigHighlight(target.node.position);
    this.currentPrompt = target?.type === 'cave'
      ? { kind: 'stone', title: 'Печерна порода', actionText: tool === 'pickaxe' ? 'Прокопати' : 'Потрібна кирка', hintText: 'Копання зберігається у світі', progress: 0, canAct: tool === 'pickaxe' }
      : target ? this.buildPrompt(target, tool)
      : this.isCaveMining ? { kind: 'stone', title: 'Печерна порода', actionText: 'Підійди до стіни', hintText: '', progress: 0, canAct: false }
      : null;

    if (target?.type === 'cave' && target.nugget) {
      const item = this.inventory.getItem(`${target.nugget.metal}_ore`);
      if (item) {
        const full = item.count >= item.maxStack;
        this.currentPrompt = {
          kind: 'stone', title: dataName('item', item.id, item.name), actionText: t(full ? 'gather.oreFull' : 'gather.mine'),
          hintText: '', progress: 0, canAct: !full,
        };
      }
    }

    if (!target || context.isBuildModeActive || this.inventory.isInventoryOpen()) return;
    if (target.type === 'cave' && target.nugget && !this.currentPrompt?.canAct) return;
    if (target.type === 'propTree' && target.node.hedge && !this.currentPrompt?.canAct) return;
    // Competes with the other E targets only when this hand can do something to it
    const usable = target.type === 'apple' && tool !== 'axe' ? target.node.canKnock : !!tool && tool === this.requiredTool(target);
    if (usable) interactionFocus.offer('gather', target.node.position);
    const triggered = usable && interactionFocus.allows('gather') && this.wantsSwing(context);
    if (!triggered || this.cooldown > 0 || this.pendingHit) return;
    // A ripe apple tree is knocked with bare hands (anything but the axe, which fells it)
    if (target.type === 'apple' && tool !== 'axe') {
      if (target.node.canKnock) this.swing(target, playerPos, 'axe', context, true);
      return;
    }
    if (!tool || tool !== this.requiredTool(target)) return;
    this.swing(target, playerPos, tool, context);
  }

  private throwDynamite(playerPos: THREE.Vector3, context: CharacterContext): void {
    const inventory = this.inventory;
    const parent = context.model?.group?.parent as THREE.Object3D | null;
    if (!inventory || !parent || !inventory.removeItem(DYNAMITE_ID, 1)) return;

    const mesh = new THREE.Group();
    for (let i = -1; i <= 1; i++) {
      const stick = new THREE.Mesh(DYNAMITE_BODY_GEO, DYNAMITE_BODY_MAT);
      stick.position.set(i * 0.075, 0, 0);
      stick.rotation.z = Math.PI / 2;
      mesh.add(stick);
    }
    const band = new THREE.Mesh(DYNAMITE_BAND_GEO, DYNAMITE_BAND_MAT);
    mesh.add(band);
    const fuse = new THREE.Mesh(DYNAMITE_FUSE_GEO, DYNAMITE_FUSE_MAT);
    fuse.position.y = 0.18;
    mesh.add(fuse);
    const spark = new THREE.Mesh(DYNAMITE_SPARK_GEO, DYNAMITE_SPARK_MAT);
    spark.position.y = 0.25;
    mesh.add(spark);
    mesh.traverse((child) => { if (child instanceof THREE.Mesh) child.castShadow = false; });

    const pos = this.throwOriginScratch.copy(playerPos);
    pos.y += 0.5;
    const aim = this.throwDirectionScratch.copy(context.cameraWorldDirection);
    if (aim.lengthSq() < 1e-4) {
      const yaw = context.model?.group?.rotation.y ?? 0;
      aim.set(Math.sin(yaw), 0, Math.cos(yaw));
    }
    aim.normalize();
    pos.addScaledVector(aim, 0.35);
    const thrownPosition = pos.clone();
    const { body, collider } = context.physics.createDynamicProp(thrownPosition, 'sphere', 0.13, 0.45);
    // Let the charge hit cave walls and terrain, but not the player's own capsule or other props.
    collider.setCollisionGroups(context.physics.packCollisionGroups(COLLISION_GROUPS.DYNAMIC_PROPS, COLLISION_GROUPS.ENVIRONMENT));
    body.setLinvel({ x: aim.x * 9, y: aim.y * 9, z: aim.z * 9 }, true);
    body.setAngvel({ x: 7, y: 4, z: 8 }, true);
    parent.add(mesh);
    mesh.position.copy(thrownPosition);
    this.thrownDynamite.push({ mesh, body, position: thrownPosition, fuse: DYNAMITE_FUSE, canBlastCave: !!this.caveNetwork?.contains(playerPos) });
    this.cooldown = 0.35;
  }

  private updateDynamite(dt: number, context: CharacterContext): void {
    for (let i = this.thrownDynamite.length - 1; i >= 0; i--) {
      const item = this.thrownDynamite[i];
      item.fuse -= dt;
      const p = item.body.translation();
      const q = item.body.rotation();
      item.position.set(p.x, p.y, p.z);
      item.mesh.position.copy(item.position);
      item.mesh.quaternion.set(q.x, q.y, q.z, q.w);
      if (item.fuse <= 0) {
        this.detonate(item, context);
        context.physics.removeRigidBody(item.body);
        item.mesh.removeFromParent();
        this.thrownDynamite.splice(i, 1);
      }
    }

    for (let i = this.blastPulses.length - 1; i >= 0; i--) {
      const pulse = this.blastPulses[i];
      pulse.life -= dt;
      const age = 1 - Math.max(0, pulse.life) / 0.38;
      pulse.mesh.scale.setScalar(0.3 + age * 5.1);
      pulse.mesh.material.opacity = Math.max(0, 1 - age);
      if (pulse.life <= 0) {
        pulse.mesh.removeFromParent();
        pulse.mesh.geometry.dispose();
        pulse.mesh.material.dispose();
        this.blastPulses.splice(i, 1);
      }
    }
  }

  private detonate(item: ThrownDynamite, context: CharacterContext): void {
    const cave = this.caveNetwork;
    if (item.canBlastCave) cave?.blast(item.position, DYNAMITE_RADIUS);
    const parent = context.model?.group?.parent as THREE.Object3D | null;
    if (parent) {
      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xffa52e, transparent: true, opacity: 0.75, depthWrite: false })
      );
      pulse.position.copy(item.position);
      pulse.renderOrder = 8;
      parent.add(pulse);
      this.blastPulses.push({ mesh: pulse, life: 0.38 });
    }
    context.particleManager?.emitDirtClods(item.position, 20);
    audioEngine.at(item.position).playRockBreak();
  }

  /** Faces the target and starts the swing; the hit lands IMPACT_DELAY later. */
  private updatePlanting(playerPos: THREE.Vector3, context: CharacterContext): void {
    const orchard = this.orchard!;
    const yaw = context.model?.group?.rotation.y ?? 0;
    const check = orchard.updateGhost(playerPos, yaw);
    const ok = check === 'ok';
    this.currentPrompt = {
      kind: 'tree',
      title: t('apple.title'),
      actionText: ok ? t('apple.plant') : check === 'tooClose' ? t('apple.tooClose') : t('apple.badGround'),
      hintText: '',
      progress: 0,
      canAct: ok,
    };
    // Planting with a sapling / bulbs in hand is a deliberate tool use: it wins over targets around
    if (ok) interactionFocus.offer('gather', null, FOCUS_TOOL);
    const triggered = interactionFocus.allows('gather') && (context.input.interactJustPressed || context.input.shootJustPressed);
    if (!ok || !triggered || this.cooldown > 0 || context.model?.isActionLocked()) return;
    if (!this.inventory!.removeItem(APPLE_SAPLING_ID, 1)) return;
    if (!orchard.plantAtGhost()) {
      this.inventory!.addItem(APPLE_SAPLING_ID, 1);
      return;
    }
    context.model?.triggerPickup();
    this.cooldown = 0.6;
    // The last sapling planted: nothing left in hand
    if (this.inventory!.getItemCount(APPLE_SAPLING_ID) <= 0) {
      orchard.hideGhost();
      this.inventory!.unequip();
    }
  }

  private updateFlowerPlanting(playerPos: THREE.Vector3, context: CharacterContext, color: number): void {
    const flowers = this.flowers!;
    const itemId = this.inventory!.getEquippedItemId()!;
    // Planted only where the crosshair meets the ground (aimed as soon as they are in hand)
    const aim = context.isGroundAiming ? context.groundAim : null;
    if (!aim) {
      flowers.hideGhost();
      this.currentPrompt = context.isGroundAiming
        ? { kind: 'tree', title: t('flower.title'), actionText: t('aim.tooFar'), hintText: '', progress: 0, canAct: false }
        : null;
      return;
    }
    const check = flowers.updateGhost(playerPos, color, aim);
    const ok = check === 'ok';
    this.currentPrompt = {
      kind: 'tree',
      title: t('flower.title'),
      actionText: ok ? t('flower.plant') : check === 'tooClose' ? t('flower.tooClose') : check === 'tooFar' ? t('aim.tooFar') : t('flower.badGround'),
      hintText: '',
      progress: 0,
      canAct: ok,
    };
    // Planting with a sapling / bulbs in hand is a deliberate tool use: it wins over targets around
    if (ok) interactionFocus.offer('gather', null, FOCUS_TOOL);
    const triggered = interactionFocus.allows('gather') && (context.input.interactJustPressed || context.input.shootJustPressed);
    if (!ok || !triggered || this.cooldown > 0 || context.model?.isActionLocked()) return;
    if (!this.inventory!.removeItem(itemId, 1)) return;
    // Turn to the spot (while aiming the body is free and may face elsewhere)
    const gp = flowers.ghostPosition;
    const gdx = gp.x - playerPos.x, gdz = gp.z - playerPos.z;
    if (gdx * gdx + gdz * gdz > 0.04) context.model?.setFacingAngleInstant(Math.atan2(gdx, gdz));
    if (!flowers.plantAtGhost()) {
      this.inventory!.addItem(itemId, 1);
      return;
    }
    context.model?.triggerPickup();
    this.cooldown = 0.45;
    // The last clump planted: nothing left in hand
    if (this.inventory!.getItemCount(itemId) <= 0) {
      flowers.hideGhost();
      this.inventory!.unequip();
    }
  }

  private updateTreePlanting(playerPos: THREE.Vector3, context: CharacterContext, type: string): void {
    const nursery = this.nursery!;
    const itemId = this.inventory!.getEquippedItemId()!;
    const hedge = type === HEDGE_TYPE;
    const title = t(hedge ? 'hedge.title' : type === 'bush' ? 'sapling.bush' : type === 'tree_pine' ? 'sapling.pine' : 'sapling.oak');
    const aim = context.isGroundAiming ? context.groundAim : null;
    if (!aim) {
      nursery.hideGhost();
      this.currentPrompt = context.isGroundAiming
        ? { kind: 'tree', title, actionText: t('aim.tooFar'), hintText: '', progress: 0, canAct: false }
        : null;
      return;
    }
    const check = nursery.updateGhost(playerPos, type, aim);
    const ok = check === 'ok';
    this.currentPrompt = {
      kind: 'tree',
      title,
      actionText: ok ? t(hedge ? 'hedge.place' : 'sapling.plant') : check === 'tooClose' ? t('sapling.tooClose') : check === 'tooFar' ? t('aim.tooFar') : t('sapling.badGround'),
      hintText: '',
      progress: 0,
      canAct: ok,
    };
    // Planting with a sapling / bulbs in hand is a deliberate tool use: it wins over targets around
    if (ok) interactionFocus.offer('gather', null, FOCUS_TOOL);
    const triggered = interactionFocus.allows('gather') && (context.input.interactJustPressed || context.input.shootJustPressed);
    if (!ok || !triggered || this.cooldown > 0 || context.model?.isActionLocked()) return;
    if (!this.inventory!.removeItem(itemId, 1)) return;
    const gp = nursery.ghostPosition;
    const gdx = gp.x - playerPos.x, gdz = gp.z - playerPos.z;
    if (gdx * gdx + gdz * gdz > 0.04) context.model?.setFacingAngleInstant(Math.atan2(gdx, gdz));
    if (!nursery.plantAtGhost(type)) {
      this.inventory!.addItem(itemId, 1);
      return;
    }
    context.model?.triggerPickup();
    this.cooldown = 0.6;
    if (this.inventory!.getItemCount(itemId) <= 0) {
      nursery.hideGhost();
      this.inventory!.unequip();
    }
  }

  /**
   * E / a click swings once; holding LMB keeps swinging (each swing still waits out the cooldown).
   * Without pointer lock a held drag turns the camera, so it doesn't chop.
   */
  private wantsSwing(context: CharacterContext): boolean {
    const i = context.input;
    return i.interactJustPressed || i.shootJustPressed || (i.shoot && (!!i.isPointerLocked || !i.isDragging));
  }

  private swing(target: Target, playerPos: THREE.Vector3, tool: GatherTool, context: CharacterContext, knock = false): void {
    const targetPos = target.node.position;
    const direction = new THREE.Vector3(targetPos.x - playerPos.x, 0, targetPos.z - playerPos.z);
    if (direction.lengthSq() < 1e-4) direction.set(0, 0, 1);
    direction.normalize();
    this.swingFacing = Math.atan2(direction.x, direction.z);
    context.model?.setFacingAngleInstant(this.swingFacing);

    if (tool === 'axe') {
      context.model?.triggerAxeSwing();
      if (!knock) audioEngine.at(playerPos).playAxeSwing();
    } else {
      context.model?.triggerMineSwing();
      audioEngine.at(playerPos).playAxeSwing();
    }

    this.cooldown = GATHERING_CONFIG.SWING_COOLDOWN;
    this.pendingHit = { target, direction, delay: GATHERING_CONFIG.IMPACT_DELAY, knock };
  }

  private updatePendingHit(dt: number): void {
    if (!this.pendingHit) return;
    this.pendingHit.delay -= dt;
    if (this.pendingHit.delay > 0) return;

    const { target, direction, knock } = this.pendingHit;
    this.pendingHit = null;

    if (target.type === 'pest') {
      // Still in reach when the blade comes down? (it may have rolled or flown off)
      const pest = target.node;
      if (!this.pests || !pest.alive) return;
      const c = pest.hitPoint(this.facingScratch);
      const p = this.playerPosScratch;
      if (Math.hypot(c.x - p.x, c.z - p.z) - pest.hitRadius > PEST_REACH + 0.5 || Math.abs(c.y - p.y) > 1.7) return;
      this.pests.damage(pest, 1, p);
      return;
    }

    if (target.type === 'web') {
      this.webs?.cut(this.playerPosScratch, direction, WEB_REACH);
      return;
    }
    if (target.type === 'rock') {
      // hit() returns whether the node broke, not whether the blow landed
      const rock = target.node;
      if (rock.isDepleted) return;
      const broke = this.rocks!.hit(rock, direction);
      this.hitStar(rock, direction, rock.radius * 0.6, broke);
      return;
    }
    if (target.type === 'cave') {
      const point = target.node.position;
      if (target.nugget) {
        const item = this.inventory?.getItem(`${target.nugget.metal}_ore`);
        if (item && item.count < item.maxStack && this.caveNetwork?.nuggets.collect(target.nugget.id)) {
          this.inventory?.addItem(item.id, 1);
          this.onNuggetCollected?.(item.id);
          this.rocks?.emitCaveChips(point, target.normal);
          audioEngine.at(point).playMineHit(true);
          hitFx.star(point, true);
        }
        return;
      }
      if (this.caveNetwork?.excavate(point, target.normal)) {
        this.inventory?.addItem('stone', 1);
        this.rocks?.emitCaveChips(point, target.normal);
        audioEngine.at(point).playMineHit();
        hitFx.star(point, true);
      }
      return;
    }
    if (target.type === 'propTree') {
      const tree = target.node;
      const broke = this.propTrees!.hit(tree, direction);
      this.hitStar(tree, direction, tree.bush ? 0.5 : 1.0, broke);
      return;
    }
    if (target.type === 'apple') {
      if (knock) this.orchard?.knock(target.node.id, direction);
      else {
        const broke = this.orchard?.chop(target.node.id, direction) ?? false;
        this.hitStar(target.node, direction, 1.0, broke);
      }
      return;
    }

    // Strike the trunk surface facing the player, at chest height
    const node = target.node;
    const hitPoint =
      node.kind === 'tree'
        ? node.position.clone().addScaledVector(direction, -node.radius).setY(1.0)
        : node.position.clone();
    const res = this.forest!.checkHit(hitPoint, direction, 1, true);
    if (res?.hit) hitFx.star(res.hitPoint ?? hitPoint, res.isFatal);
  }

  /** The impact star (as on an enemy) on the side of `node` facing the swing, `height` above its base. */
  private hitStar(node: { position: THREE.Vector3; radius: number }, direction: THREE.Vector3, height: number, final: boolean): void {
    const at = node.position.clone().addScaledVector(direction, -node.radius);
    at.y = node.position.y + height;
    hitFx.star(at, final);
  }

  private findTarget(playerPos: THREE.Vector3): FieldTarget | null {
    const reach = GATHERING_CONFIG.REACH;
    const candidates: FieldTarget[] = [];
    const forestNode = this.forest!.findTarget(playerPos, reach);
    if (forestNode) candidates.push({ type: 'forest', node: forestNode });
    const propTree = this.propTrees?.findNearest(playerPos, reach);
    if (propTree) candidates.push({ type: 'propTree', node: propTree });
    const apple = this.orchard?.findNearest(playerPos, reach);
    if (apple) candidates.push({ type: 'apple', node: apple });
    const rockNode = this.rocks!.findNearest(playerPos, reach);
    if (rockNode) candidates.push({ type: 'rock', node: rockNode });

    let best: FieldTarget | null = null;
    let bestDist = Infinity;
    for (const c of candidates) {
      const d = Math.hypot(playerPos.x - c.node.position.x, playerPos.z - c.node.position.z) - c.node.radius;
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  private findCaveWall(context: CharacterContext, playerPos: THREE.Vector3): Extract<Target, { type: 'cave' }> | null {
    const cave = this.caveNetwork;
    if (!cave || !cave.ready || !cave.contains(playerPos)) return null;
    // Keep the ray origin on the player, while following the camera's full 3D look direction.
    const origin = this.caveRayOrigin.set(playerPos.x, playerPos.y + 0.35, playerPos.z);
    const direction = this.caveRayDirection.copy(context.cameraWorldDirection).normalize();
    const reach = GATHERING_CONFIG.REACH + 1.2;
    // Flying chips and other dynamic bodies should not intercept the wall aim.
    const groups = context.physics.packCollisionGroups(COLLISION_GROUPS.CHARACTER, COLLISION_GROUPS.ENVIRONMENT);
    const hit = context.physics.castRayAndGetNormal(origin, direction, reach, context.collider, groups);
    const nugget = cave.aimNugget(origin, direction, hit?.hit.timeOfImpact ?? reach);
    if (nugget && playerPos.distanceTo(nugget.position) <= reach) {
      return { type: 'cave', node: { position: nugget.position, radius: 0.15 }, normal: nugget.normal, nugget };
    }
    if (!hit || !cave.isCaveCollider(hit.hit.collider)) return null;
    if (playerPos.distanceTo(hit.point) > reach) return null;
    return { type: 'cave', node: { position: hit.point, radius: 0.15 }, normal: hit.normal };
  }

  private equippedTool(): GatherTool | null {
    const id = this.inventory!.getEquippedItemId();
    return id === 'axe' || id === 'pickaxe' ? id : null;
  }

  private requiredTool(target: Target): GatherTool {
    return target.type === 'rock' || target.type === 'cave' ? 'pickaxe' : 'axe';
  }

  /** Axe in hand: chop; otherwise knock a ripe tree, or say how far along it is. */
  private applePrompt(node: AppleTreeNode, tool: GatherTool | null): GatherPrompt {
    const title = t('apple.title');
    // Quantised so the HUD isn't re-rendered for every second of growth
    const q = (v: number) => Math.round(v * 20) / 20;
    if (tool === 'axe') {
      const { health, maxHealth } = node;
      return { kind: 'tree', title, actionText: t('gather.chop', { done: maxHealth - health, max: maxHealth }), hintText: '', progress: 1 - health / maxHealth, canAct: true };
    }
    if (node.canKnock) {
      return { kind: 'tree', title, actionText: t('apple.knock', { done: node.knocks, max: node.knocksNeeded }), hintText: '', progress: node.knocks / node.knocksNeeded, canAct: true };
    }
    const text =
      node.stage < 3 ? t('apple.growing', { stage: node.stage + 1 })
      : node.phase === 'rest' ? t('apple.resting')
      : node.phase === 'bloom' ? t('apple.blooming')
      : t('apple.ripening');
    return { kind: 'tree', title, actionText: text, hintText: '', progress: q(node.progress), canAct: false };
  }

  private buildPrompt(target: FieldTarget, tool: GatherTool | null): GatherPrompt {
    const hasTool = tool === this.requiredTool(target);
    const { health, maxHealth } = target.node;
    const progress = 1 - health / maxHealth;

    if (target.type === 'apple') return this.applePrompt(target.node, tool);
    if (target.type !== 'rock') {
      if (target.type === 'forest' && target.node.kind === 'fallen') {
        return {
          kind: 'fallen',
          title: t('gather.fallen'),
          actionText: hasTool ? t('gather.split') : t('gather.needAxe'),
          hintText: t('gather.splitHint', { n: GATHERING_CONFIG.TREE_WOOD_YIELD }),
          progress: 0,
          canAct: hasTool,
        };
      }
      if (target.type === 'propTree' && target.node.hedge) {
        const item = this.inventory?.getItem(HEDGE_TYPE);
        const full = !!item && item.count >= item.maxStack;
        return {
          kind: 'tree',
          title: t('hedge.title'),
          actionText: hasTool ? t('gather.clearBush', { done: maxHealth - health, max: maxHealth }) : t('gather.needAxe'),
          hintText: !hasTool ? t('gather.takeAxe') : t(full ? 'hedge.stackFull' : 'hedge.recover'),
          progress,
          canAct: hasTool && !full,
        };
      }
      if (target.type === 'propTree' && target.node.bush) {
        return {
          kind: 'tree',
          title: t('gather.bush'),
          actionText: hasTool ? t('gather.clearBush', { done: maxHealth - health, max: maxHealth }) : t('gather.needAxe'),
          hintText: hasTool
            ? t('gather.clearBushHint', { n: health, hits: plural(health, t('gather.hit1'), t('gather.hit2'), t('gather.hit5')) })
            : t('gather.takeAxe'),
          progress,
          canAct: hasTool,
        };
      }
      return {
        kind: 'tree',
        title: t('gather.tree'),
        actionText: hasTool ? t('gather.chop', { done: maxHealth - health, max: maxHealth }) : t('gather.needAxe'),
        hintText: hasTool
          ? t('gather.chopHint', { n: health, hits: plural(health, t('gather.hit1'), t('gather.hit2'), t('gather.hit5')) })
          : t('gather.takeAxe'),
        progress,
        canAct: hasTool,
      };
    }

    const rockType = ROCK_TYPES[target.node.kind];
    const rockName = dataName('rock', target.node.kind, rockType.name);
    return {
      kind: target.node.kind,
      title: rockName,
      actionText: hasTool
        ? t('gather.mine', { name: rockName.toLowerCase(), done: maxHealth - health, max: maxHealth })
        : t('gather.needPickaxe'),
      hintText: hasTool
        ? t('gather.mineHint', { n: health, hits: plural(health, t('gather.hit1'), t('gather.hit2'), t('gather.hit5')) })
        : t('gather.takePickaxe'),
      progress,
      canAct: hasTool,
    };
  }
}
