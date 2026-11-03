import { IAbility, CharacterContext } from './IAbility';

export class SprintAbility implements IAbility {
  public name = 'Sprint';
  public enabled = true;

  public update(_dt: number, context: CharacterContext): void {
    if (!this.enabled || context.isSwimming) {
      context.isSprinting = false;
      return;
    }

    // Sprint when holding sprint key and moving, if not crouching
    const isMoving = context.targetVelocity.lengthSq() > 0.1 || Math.abs(context.input.forward) > 0.1 || Math.abs(context.input.right) > 0.1;
    context.isSprinting = context.input.sprint && isMoving && !context.isCrouching && !context.isHoldingObject;
  }
}
