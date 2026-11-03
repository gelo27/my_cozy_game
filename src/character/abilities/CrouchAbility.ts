import { IAbility, CharacterContext } from './IAbility';

export class CrouchAbility implements IAbility {
  public name = 'Crouch';
  public enabled = true;

  public update(_dt: number, context: CharacterContext): void {
    if (!this.enabled || context.isSwimming) {
      context.isCrouching = false;
      return;
    }
    if (false) {
      context.isCrouching = false;
      return;
    }

    context.isCrouching = context.input.crouch && context.ground.isGrounded;
  }
}
