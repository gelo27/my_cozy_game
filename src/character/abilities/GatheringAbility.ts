import * as THREE from 'three';
import { t, plural, dataName } from '../../i18n/i18n';
import { IAbility, CharacterContext } from './IAbility';
import { ForestZone, ForestTarget } from '../../forest/ForestZone';
import { RockField, RockNode } from '../../gathering/RockField';
import { PropTreeField, PropTreeNode } from '../../gathering/PropTreeField';
import { InventoryManager } from '../../inventory/InventoryManager';
import { GATHERING_CONFIG, GatherTool, ROCK_TYPES } from '../../gathering/GatheringConfig';
import { audioEngine } from '../../audio/AudioEngine';

export interface GatherPrompt {
  kind: 'tree' | 'fallen' | 'stone' | 'iron';
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
  | { type: 'rock'; node: RockNode };

/**
 * Chopping trees with the axe and mining rocks with the pickaxe (E / LMB).
 * The hit lands IMPACT_DELAY after the swing starts so it lines up with the CHOP / MINE clip.
 */
export class GatheringAbility implements IAbility {
  public name = 'GatheringAbility';
  public enabled = true;

  public currentPrompt: GatherPrompt | null = null;

  private forest: ForestZone | null = null;
  private rocks: RockField | null = null;
  private propTrees: PropTreeField | null = null;
  private inventory: InventoryManager | null = null;

  private cooldown = 0;
  private pendingHit: { target: Target; direction: THREE.Vector3; delay: number } | null = null;

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

    const t = context.body.translation();
    const playerPos = new THREE.Vector3(t.x, t.y, t.z);
    const target = this.findTarget(playerPos);
    const tool = this.equippedTool();
    this.currentPrompt = target ? this.buildPrompt(target, tool) : null;

    if (!target || context.isBuildModeActive || this.inventory.isInventoryOpen()) return;
    const triggered = context.input.interactJustPressed || context.input.shootJustPressed;
    if (!triggered || this.cooldown > 0 || this.pendingHit) return;
    if (tool !== this.requiredTool(target)) return;

    // Face the target and swing
    const targetPos = target.node.position;
    const direction = new THREE.Vector3(targetPos.x - playerPos.x, 0, targetPos.z - playerPos.z);
    if (direction.lengthSq() < 1e-4) direction.set(0, 0, 1);
    direction.normalize();
    context.model?.setFacingAngleInstant(Math.atan2(direction.x, direction.z));

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
