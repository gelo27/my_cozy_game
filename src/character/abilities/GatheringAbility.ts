import * as THREE from 'three';
import { t, plural, dataName } from '../../i18n/i18n';
import { IAbility, CharacterContext } from './IAbility';
import { ForestZone, ForestTarget } from '../../forest/ForestZone';
import { RockField, RockNode } from '../../gathering/RockField';
import { PropTreeField, PropTreeNode } from '../../gathering/PropTreeField';
import { InventoryManager } from '../../inventory/InventoryManager';
import { GATHERING_CONFIG, GatherTool, ROCK_TYPES, RockKind } from '../../gathering/GatheringConfig';
import { audioEngine } from '../../audio/AudioEngine';
import type { PestSystem, Pest } from '../../gameplay/Pests';

/** The axe reaches a pest this far past its body (m); a bit more than a tree, they move. */
const PEST_REACH = 1.9;

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
  | { type: 'pest'; node: Pest };

/**
 * Chopping trees with the axe and mining rocks with the pickaxe (E / LMB).
 * The hit lands IMPACT_DELAY after the swing starts so it lines up with the CHOP / MINE clip.
 */
export class GatheringAbility implements IAbility {
  private readonly playerPosScratch = new THREE.Vector3();
  public name = 'GatheringAbility';
  public enabled = true;

  public currentPrompt: GatherPrompt | null = null;

  private forest: ForestZone | null = null;
  private rocks: RockField | null = null;
  private propTrees: PropTreeField | null = null;
  private inventory: InventoryManager | null = null;

  private cooldown = 0;
  /** Yaw towards the tree / rock being struck, held while the swing lasts (null otherwise). */
  public swingFacing: number | null = null;
  private pendingHit: { target: Target; direction: THREE.Vector3; delay: number } | null = null;
  /** Hedgehogs and dragons the axe can strike (wired by the engine). */
  public pests: PestSystem | null = null;
  private readonly facingScratch = new THREE.Vector3();

  public setSystems(forest: ForestZone, rocks: RockField, inventory: InventoryManager, propTrees: PropTreeField | null = null): void {
    this.forest = forest;
    this.propTrees = propTrees;
    this.rocks = rocks;
    this.inventory = inventory;
  }

  public update(dt: number, context: CharacterContext): void {
    if (!this.enabled || !this.forest || !this.rocks || !this.inventory) {
      this.currentPrompt = null;
      return;
    }

    this.cooldown = Math.max(0, this.cooldown - dt);
    this.updatePendingHit(dt);
    if (this.cooldown === 0 && !this.pendingHit) this.swingFacing = null;

    const t = context.body.translation();
    const playerPos = this.playerPosScratch.set(t.x, t.y, t.z);
    const tool = this.equippedTool();

    // Axe in hand and a pest close: the swing goes to the pest, not the tree behind it
    if (tool === 'axe' && this.pests && !context.isBuildModeActive && !this.inventory.isInventoryOpen()) {
      const yaw = context.model?.group?.rotation.y ?? 0;
      const facing = this.facingScratch.set(Math.sin(yaw), 0, Math.cos(yaw));
      const pest = this.pests.findMeleeTarget(playerPos, facing, PEST_REACH);
      if (pest) {
        this.currentPrompt = null;
        const triggered = context.input.interactJustPressed || context.input.shootJustPressed;
        if (triggered && this.cooldown <= 0 && !this.pendingHit) this.swing({ type: 'pest', node: pest }, playerPos, tool, context);
        return;
      }
    }

    const target = this.findTarget(playerPos);
    this.currentPrompt = target ? this.buildPrompt(target, tool) : null;

    if (!target || context.isBuildModeActive || this.inventory.isInventoryOpen()) return;
    const triggered = context.input.interactJustPressed || context.input.shootJustPressed;
    if (!triggered || this.cooldown > 0 || this.pendingHit) return;
    if (!tool || tool !== this.requiredTool(target)) return;
    this.swing(target, playerPos, tool, context);
  }

  /** Faces the target and starts the swing; the hit lands IMPACT_DELAY later. */
  private swing(target: Target, playerPos: THREE.Vector3, tool: GatherTool, context: CharacterContext): void {
    const targetPos = target.node.position;
    const direction = new THREE.Vector3(targetPos.x - playerPos.x, 0, targetPos.z - playerPos.z);
    if (direction.lengthSq() < 1e-4) direction.set(0, 0, 1);
    direction.normalize();
    this.swingFacing = Math.atan2(direction.x, direction.z);
    context.model?.setFacingAngleInstant(this.swingFacing);

    if (tool === 'axe') {
      context.model?.triggerAxeSwing();
      audioEngine.at(playerPos).playAxeSwing();
    } else {
      context.model?.triggerMineSwing();
    }

    this.cooldown = GATHERING_CONFIG.SWING_COOLDOWN;
    this.pendingHit = { target, direction, delay: GATHERING_CONFIG.IMPACT_DELAY };
  }

  private updatePendingHit(dt: number): void {
    if (!this.pendingHit) return;
    this.pendingHit.delay -= dt;
    if (this.pendingHit.delay > 0) return;

    const { target, direction } = this.pendingHit;
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

    if (target.type === 'rock') {
      this.rocks!.hit(target.node, direction);
      return;
    }
    if (target.type === 'propTree') {
      this.propTrees!.hit(target.node, direction);
      return;
    }

    // Strike the trunk surface facing the player, at chest height
    const node = target.node;
    const hitPoint =
      node.kind === 'tree'
        ? node.position.clone().addScaledVector(direction, -node.radius).setY(1.0)
        : node.position.clone();
    this.forest!.checkHit(hitPoint, direction, 1, true);
  }

  private findTarget(playerPos: THREE.Vector3): Target | null {
    const reach = GATHERING_CONFIG.REACH;
    const candidates: Target[] = [];
    const forestNode = this.forest!.findTarget(playerPos, reach);
    if (forestNode) candidates.push({ type: 'forest', node: forestNode });
    const propTree = this.propTrees?.findNearest(playerPos, reach);
    if (propTree) candidates.push({ type: 'propTree', node: propTree });
    const rockNode = this.rocks!.findNearest(playerPos, reach);
    if (rockNode) candidates.push({ type: 'rock', node: rockNode });

    let best: Target | null = null;
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

  private equippedTool(): GatherTool | null {
    const id = this.inventory!.getEquippedItemId();
    return id === 'axe' || id === 'pickaxe' ? id : null;
  }

  private requiredTool(target: Target): GatherTool {
    return target.type === 'rock' ? 'pickaxe' : 'axe';
  }

  private buildPrompt(target: Target, tool: GatherTool | null): GatherPrompt {
    const hasTool = tool === this.requiredTool(target);
    const { health, maxHealth } = target.node;
    const progress = 1 - health / maxHealth;

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
