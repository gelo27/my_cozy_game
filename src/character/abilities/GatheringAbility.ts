import * as THREE from 'three';
import { IAbility, CharacterContext } from './IAbility';
import { ForestZone, ForestTarget } from '../../forest/ForestZone';
import { RockField, RockNode } from '../../gathering/RockField';
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

type Target = { type: 'forest'; node: ForestTarget } | { type: 'rock'; node: RockNode };

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
  private inventory: InventoryManager | null = null;

  private cooldown = 0;
  private pendingHit: { target: Target; direction: THREE.Vector3; delay: number } | null = null;

  public setSystems(forest: ForestZone, rocks: RockField, inventory: InventoryManager): void {
    this.forest = forest;
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
      audioEngine.playAxeSwing();
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
    const forestNode = this.forest!.findTarget(playerPos, reach);
    const rockNode = this.rocks!.findNearest(playerPos, reach);
    if (!forestNode && !rockNode) return null;
    if (!rockNode) return { type: 'forest', node: forestNode! };
    if (!forestNode) return { type: 'rock', node: rockNode };

    const dForest = playerPos.distanceTo(forestNode.position) - forestNode.radius;
    const dRock = playerPos.distanceTo(rockNode.position) - rockNode.radius;
    return dForest <= dRock ? { type: 'forest', node: forestNode } : { type: 'rock', node: rockNode };
  }

  private equippedTool(): GatherTool | null {
    const id = this.inventory!.getEquippedItemId();
    return id === 'axe' || id === 'pickaxe' ? id : null;
  }

  private requiredTool(target: Target): GatherTool {
    return target.type === 'forest' ? 'axe' : 'pickaxe';
  }

  private buildPrompt(target: Target, tool: GatherTool | null): GatherPrompt {
    const hasTool = tool === this.requiredTool(target);
    const { health, maxHealth } = target.node;
    const progress = 1 - health / maxHealth;

    if (target.type === 'forest') {
      if (target.node.kind === 'fallen') {
        return {
          kind: 'fallen',
          title: 'Повалене дерево',
          actionText: hasTool ? 'Розколоти на дрова' : 'Потрібна сокира [Q]',
          hintText: `Один удар сокирою — і ${GATHERING_CONFIG.TREE_WOOD_YIELD} деревини у рюкзаку.`,
          progress: 0,
          canAct: hasTool,
        };
      }
      return {
        kind: 'tree',
        title: 'Дерево',
        actionText: hasTool ? `Рубати дерево (${maxHealth - health}/${maxHealth})` : 'Потрібна сокира [Q]',
        hintText: hasTool
          ? `Ще ${health} ${health === 1 ? 'удар' : health < 5 ? 'удари' : 'ударів'} до падіння. Не стійте з того боку, куди воно впаде!`
          : 'Відкрийте рюкзак [Q] і візьміть сокиру в руки.',
        progress,
        canAct: hasTool,
      };
    }

    const rockType = ROCK_TYPES[target.node.kind];
    return {
      kind: target.node.kind,
      title: rockType.name,
      actionText: hasTool ? `Добувати: ${rockType.name.toLowerCase()} (${maxHealth - health}/${maxHealth})` : 'Потрібне кайло [Q]',
      hintText: hasTool
        ? `Ще ${health} ${health === 1 ? 'удар' : health < 5 ? 'удари' : 'ударів'} кайлом. Брила відновиться згодом.`
        : 'Відкрийте рюкзак [Q] і візьміть кайло в руки.',
      progress,
      canAct: hasTool,
    };
  }
}
