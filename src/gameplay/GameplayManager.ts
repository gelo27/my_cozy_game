import * as THREE from 'three';
import { CharacterController } from '../character/CharacterController';
import { InventoryManager } from '../inventory/InventoryManager';
import { InputManager } from '../input/InputManager';
import { PropSystem } from '../world/PropSystem';
import { WeatherSystem, WeatherType } from '../world/WeatherSystem';
import { FishingSystem, FishingState } from './FishingSystem';
import { PetSystem, Pet } from './PetSystem';
import { PestSystem, PestKind } from './Pests';
import { critterSounds } from './CritterSounds';
import { RECIPES, FISH_IDS, SEA_FISH_IDS, DISH_BUFF, Recipe } from './Recipes';
import { audioEngine } from '../audio/AudioEngine';
import { CompanionNPC } from '../npc/CompanionNPC';
import { t, dataName, getLang } from '../i18n/i18n';

/** Flour from one crate of wheat at the millstone (3 flour bake one loaf). */
const FLOUR_PER_CRATE = 3;

export type GameplayPanel = 'cook' | 'shop' | null;

/** Coins a pest knocks out of the player's pockets per hit. */
const HIT_COIN_LOSS = 5;

export interface GameplayPrompt {
  text: string;
  key: string;
  action: 'fish' | 'pet' | 'cook' | 'shop' | 'npc' | 'explore' | 'mill';
  secondary?: { text: string; key: string; action: 'treat' };
}

export interface GameplayHudState {
  prompt: GameplayPrompt | null;
  fishing: FishingState | null;
  panel: GameplayPanel;
  cooking: { recipeId: string; progress: number } | null;
  buff: { label: string; secondsLeft: number } | null;
  weather: WeatherType;
  isNight: boolean;
  coins: number;
  pets: { name: string; kind: string; affection: number }[];
  /** Doorway fade (caves, lighthouse) and whether the player is underground. */
  fading: boolean;
  inCave: boolean;
}

/** The exploration layer as gameplay sees it: its E-prompt and doorway state. */
export interface ExplorePort {
  prompt: { text: string } | null;
  fading: boolean;
  inCave: string | null;
  interact(): void;
}

/**
 * Glue for the cosy-life activities: fishing, pets, cooking, the mailbox shop and food buffs.
 * Owns one-button interaction routing so the E key / touch button always does the obvious thing.
 */
export class GameplayManager {
  public panel: GameplayPanel = null;
  public prompt: GameplayPrompt | null = null;
  public readonly fishing: FishingSystem;
  public readonly pets: PetSystem;
  public readonly pests: PestSystem;
  public companion: CompanionNPC | null = null;
  public explore: ExplorePort | null = null;
  /** Pets and the companion wait here instead of following (the cave mouth while the player is inside). */
  public anchorOverride: THREE.Vector3 | null = null;
  /** Bumped on any change the HUD should show immediately. */
  public revision = 0;

  private cookingJob: { recipe: Recipe; remaining: number } | null = null;
  private buff: { dishId: string; remaining: number; speed: number } | null = null;
  private baseSpeeds: { walk: number; sprint: number } | null = null;
  private promptTimer = 0;
  private readonly rodTip = new THREE.Vector3();
  private readonly castTarget = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private lastPlayerPos = new THREE.Vector3();
  private invulnerable = 0;

  public onNotify: (text: string, type?: 'success' | 'info' | 'warning') => void = () => {};

  constructor(
    scene: THREE.Scene,
    private readonly character: CharacterController,
    private readonly inventory: InventoryManager,
    private readonly props: PropSystem,
    private readonly weather: WeatherSystem,
    terrain: ConstructorParameters<typeof FishingSystem>[1],
    private readonly particles?: ConstructorParameters<typeof PetSystem>[2]
  ) {
    this.fishing = new FishingSystem(scene, terrain);
    this.pets = new PetSystem(scene, terrain, particles);
    this.pests = new PestSystem(scene, terrain, particles);
    this.pests.port = {
      hurt: (from, power, kind) => this.hurtPlayer(from, power, kind),
    };
  }

  // ---------------------------------------------------------------- pests

  /** A rolling hedgehog or a fireball hit: knockback, a short stun and a few lost coins. */
  private hurtPlayer(from: THREE.Vector3, power: number, kind: PestKind): boolean {
    if (this.invulnerable > 0) return false;
    this.invulnerable = 1.6;
    const pos = this.character.getPosition();
    this.tmp.set(pos.x - from.x, 0, pos.z - from.z);
    if (this.tmp.lengthSq() < 1e-4) this.tmp.copy(this.character.getFacingDirection()).negate();
    this.character.knockback(this.tmp, power, 0.55);
    critterSounds.ouch();
    const lost = Math.min(HIT_COIN_LOSS, this.inventory.getItemCount('coins'));
    if (lost > 0) this.inventory.removeItem('coins', lost);
    this.onNotify(t(kind === 'hedgehog' ? 'pest.hitHedgehog' : 'pest.hitDragon', { n: lost }), 'warning');
    this.revision++;
    return true;
  }

  // ---------------------------------------------------------------- frame

  public update(dt: number, input: InputManager, isDriving: boolean, keysG: boolean): void {
    const pos = this.character.getPosition();
    const moving = pos.distanceToSquared(this.lastPlayerPos) > 0.0004;
    this.lastPlayerPos.copy(pos);
    const anchor = this.anchorOverride ?? pos;
    this.pets.update(dt, anchor, moving && !this.anchorOverride);
    this.companion?.update(dt, anchor);
    this.updateBuff(dt);
    this.updateCooking(dt);
    this.invulnerable -= dt;
    this.pests.update(dt, pos, !this.explore?.inCave && !isDriving);

    // Rod tip ~ above the right hand, in front of the player
    const facing = this.character.getFacingDirection();
    this.rodTip.copy(pos).addScaledVector(facing, 0.9);
    this.rodTip.y += 1.9;
    this.fishing.update(dt, this.rodTip, this.weather.rainIntensity);

    if (isDriving || this.panel) {
      this.setPrompt(null);
      if (this.fishing.busy) this.fishing.cancel();
      return;
    }

    // Moving away cancels a cast
    if (this.fishing.busy && moving && this.fishing.state.phase !== 'reel' && this.fishing.state.phase !== 'caught') {
      if (this.fishing.state.phase !== 'escaped') this.fishing.cancel();
    }

    this.promptTimer -= dt;
    if (this.promptTimer <= 0) {
      this.promptTimer = 0.1;
      this.setPrompt(this.computePrompt(pos, facing));
    }

    const m = input.movement;
    const ownedByOthers = !!(this.character.farmingAbility?.currentPrompt || this.character.gatheringAbility?.currentPrompt);
    const hasRod = this.inventory.getEquippedItemId() === 'fishing_rod';
    const pressed = m.interactJustPressed || (hasRod && m.shootJustPressed);

    if (this.fishing.busy && pressed) {
      this.pressFishing();
      return;
    }
    if (keysG && this.prompt?.secondary) this.runAction('treat');
    if (pressed && this.prompt && !ownedByOthers) this.runAction(this.prompt.action);
  }

  /**
   * Whether something here should take E from the shovel: stations, the NPC, finds, or a pet the
   * player is facing up close. Pets sit around the player all the time, so a pet merely nearby
   * must not stop digging.
   */
  public hasActivityForShovel(pos: THREE.Vector3): boolean {
    if (this.fishing.busy || this.panel) return false;
    const facing = this.character.getFacingDirection();
    const p = this.computePrompt(pos, facing, true);
    if (!p) return false;
    if (p.action !== 'pet') return true;
    const pet = this.pets.nearest(pos, 1.7);
    if (!pet) return false;
    const dx = pet.group.position.x - pos.x;
    const dz = pet.group.position.z - pos.z;
    const len = Math.hypot(dx, dz) || 1;
    return (dx * facing.x + dz * facing.z) / len > 0.35;
  }

  private computePrompt(pos: THREE.Vector3, facing: THREE.Vector3, ignoreTools = false): GameplayPrompt | null {
    if (this.fishing.busy) return null;
    if (!ignoreTools && (this.character.farmingAbility?.currentPrompt || this.character.gatheringAbility?.currentPrompt)) return null;

    // Chests, cave doorways and beach finds come first: they sit at fixed spots
    if (this.explore?.prompt) return { text: this.explore.prompt.text, key: 'E', action: 'explore' };

    // Fixed stations win over pets: pets follow the player and would otherwise hijack every prompt
    if (this.inventory.getEquippedItemId() === 'fishing_rod' && this.fishing.findCastTarget(pos, facing, this.castTarget)) {
      return { text: t('play.cast'), key: 'E', action: 'fish' };
    }
    if (this.props.findNearest('campfire', pos, 2.6)) return { text: t('play.cook'), key: 'E', action: 'cook' };
    if (this.props.findNearest('mailbox', pos, 2.4)) return { text: t('play.shop'), key: 'E', action: 'shop' };
    if (this.props.findNearest('millstone', pos, 2.4)) {
      const crates = this.inventory.getItemCount('crate_wheat');
      return { text: crates > 0 ? t('play.mill', { n: FLOUR_PER_CRATE, have: crates }) : t('play.millNeed'), key: 'E', action: 'mill' };
    }

    const npc = this.companion;
    if (npc && npc.getPosition(this.tmp).distanceTo(pos) < 2.6) {
      return { text: t(npc.following ? 'npc.stay' : 'npc.follow', { name: npc.name }), key: 'E', action: 'npc' };
    }

    const pet = this.pets.nearest(pos, 2.2);
    if (pet) {
      const hasTreat = this.inventory.hasItem('pet_treat');
      return {
        text: t('play.pet', { name: pet.name }),
        key: 'E',
        action: 'pet',
        secondary: hasTreat ? { text: t('play.treat'), key: 'G', action: 'treat' } : undefined,
      };
    }
    return null;
  }

  private setPrompt(p: GameplayPrompt | null): void {
    const a = this.prompt;
    if (a?.text === p?.text && a?.secondary?.text === p?.secondary?.text) return;
    this.prompt = p;
    this.revision++;
  }

  /** Also used by the on-screen buttons. */
  public runAction(action: GameplayPrompt['action'] | 'treat'): void {
    const pos = this.character.getPosition();
    if (action === 'fish' && this.fishing.busy) {
      this.pressFishing();
    } else if (action === 'fish') {
      const facing = this.character.getFacingDirection();
      if (this.fishing.findCastTarget(pos, facing, this.castTarget)) {
        this.fishing.cast(this.rodTip, this.castTarget);
        audioEngine.playBuildSelect();
      }
    } else if (action === 'explore') {
      this.explore?.interact();
      this.promptTimer = 0;
    } else if (action === 'npc' && this.companion) {
      const following = this.companion.toggleFollow();
      audioEngine.at(this.companion.getPosition()).playBuildSelect();
      this.onNotify(t(following ? 'npc.following' : 'npc.waiting', { name: this.companion.name }), 'info');
      this.promptTimer = 0;
    } else if (action === 'pet') {
      this.pets.petNearest(pos);
    } else if (action === 'treat') {
      const pet: Pet | null = this.pets.nearest(pos, 2.2);
      if (pet && this.inventory.removeItem('pet_treat', 1)) {
        this.pets.feed(pet);
        this.onNotify(t('play.petHappy', { name: pet.name, n: Math.round(pet.affection) }), 'success');
      }
    } else if (action === 'cook' || action === 'shop') {
      this.openPanel(action);
    } else if (action === 'mill') {
      this.grindFlour(pos);
    }
    this.revision++;
  }

  /** Millstone: one crate of wheat -> FLOUR_PER_CRATE flour, with a puff of flour dust. */
  private grindFlour(pos: THREE.Vector3): void {
    const mill = this.props.findNearest('millstone', pos, 2.4);
    if (!mill) return;
    if (!this.inventory.removeItem('crate_wheat', 1)) {
      this.onNotify(t('play.millNeed'), 'info');
      return;
    }
    this.inventory.addItem('flour', FLOUR_PER_CRATE);
    audioEngine.at(mill.position).playBuildPlace(false);
    this.particles?.emitBuildPuff(this.tmp.copy(mill.position).setY(mill.position.y + 0.7), false, 22);
    this.character.model?.triggerJumpSquash();
    this.onNotify(t('play.milled', { n: FLOUR_PER_CRATE, name: dataName('item', 'flour', 'Борошно') }), 'success');
    this.promptTimer = 0;
  }

  private pressFishing(): void {
    const fishId = this.fishing.press();
    if (fishId) {
      this.inventory.addItem(fishId, 1);
      const item = this.inventory.getItem(fishId);
      audioEngine.playHarvest();
      this.onNotify(t('play.caught', { name: dataName('item', fishId, item?.name ?? fishId) }), 'success');
    }
    this.revision++;
  }

  public recipeName(recipeId: string): string {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    return dataName('recipe', recipeId, recipe?.name ?? recipeId);
  }

  public openPanel(panel: GameplayPanel): void {
    this.panel = panel;
    this.revision++;
  }

  // ---------------------------------------------------------------- cooking

  /** Recipes found on the island (locked ones start unknown). */
  public readonly knownRecipes = new Set<string>();

  public isRecipeKnown(recipe: Recipe): boolean {
    return !recipe.locked || this.knownRecipes.has(recipe.id);
  }

  public countIngredient(itemId: string): number {
    if (itemId === 'fish_any') return FISH_IDS.reduce((s, id) => s + this.inventory.getItemCount(id), 0);
    if (itemId === 'fish_sea_any') return SEA_FISH_IDS.reduce((s, id) => s + this.inventory.getItemCount(id), 0);
    return this.inventory.getItemCount(itemId);
  }

  public canCook(recipe: Recipe): boolean {
    return !this.cookingJob && this.isRecipeKnown(recipe) && recipe.ingredients.every((i) => this.countIngredient(i.itemId) >= i.count);
  }

  public cook(recipeId: string): void {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (!recipe || !this.canCook(recipe)) return;
    for (const ing of recipe.ingredients) {
      if (ing.itemId === 'fish_any' || ing.itemId === 'fish_sea_any') {
        let left = ing.count;
        // Use the cheapest fish first
        for (const id of ing.itemId === 'fish_any' ? FISH_IDS : SEA_FISH_IDS) {
          while (left > 0 && this.inventory.removeItem(id, 1)) left--;
        }
      } else {
        this.inventory.removeItem(ing.itemId, ing.count);
      }
    }
    this.cookingJob = { recipe, remaining: recipe.seconds };
    audioEngine.playBuildSelect();
    this.revision++;
  }

  private updateCooking(dt: number): void {
    if (!this.cookingJob) return;
    this.cookingJob.remaining -= dt;
    if (this.cookingJob.remaining <= 0) {
      const { recipe } = this.cookingJob;
      this.cookingJob = null;
      this.inventory.addItem(recipe.dishId, 1);
      audioEngine.playHarvest();
      this.onNotify(t('play.cooked', { name: dataName('recipe', recipe.id, recipe.name) }), 'success');
    }
    this.revision++;
  }

  // ---------------------------------------------------------------- food buff

  public eat(dishId: string): void {
    const buff = DISH_BUFF[dishId];
    if (!buff || !this.inventory.removeItem(dishId, 1)) return;
    if (!this.baseSpeeds) this.baseSpeeds = { walk: this.character.walkSpeed, sprint: this.character.sprintSpeed };
    this.buff = { dishId, remaining: buff.seconds, speed: buff.speed };
    this.character.walkSpeed = this.baseSpeeds.walk * buff.speed;
    this.character.sprintSpeed = this.baseSpeeds.sprint * buff.speed;
    this.onNotify(t('play.ate', { pct: Math.round((buff.speed - 1) * 100), s: buff.seconds }), 'success');
    this.revision++;
  }

  private updateBuff(dt: number): void {
    if (!this.buff) return;
    this.buff.remaining -= dt;
    if (this.buff.remaining <= 0 && this.baseSpeeds) {
      this.character.walkSpeed = this.baseSpeeds.walk;
      this.character.sprintSpeed = this.baseSpeeds.sprint;
      this.buff = null;
      this.revision++;
    }
  }

  // ---------------------------------------------------------------- shop

  public sell(itemId: string, amount: number): void {
    const item = this.inventory.getItem(itemId);
    if (!item?.sellPrice) return;
    const n = Math.min(amount, item.count);
    if (n <= 0 || !this.inventory.removeItem(itemId, n)) return;
    this.inventory.addItem('coins', n * item.sellPrice);
    audioEngine.playHarvest();
    this.revision++;
  }

  public buy(itemId: string, amount: number): void {
    const item = this.inventory.getItem(itemId);
    if (!item?.buyPrice) return;
    const cost = item.buyPrice * amount;
    if (!this.inventory.removeItem('coins', cost)) {
      this.onNotify(t('play.noCoins'), 'warning');
      return;
    }
    this.inventory.addItem(itemId, amount);
    audioEngine.playBuildSelect();
    this.revision++;
  }

  // ---------------------------------------------------------------- HUD

  public getHudState(): GameplayHudState {
    const f = this.fishing.state;
    return {
      prompt: this.prompt,
      fishing: f.phase === 'idle' ? null : { ...f },
      panel: this.panel,
      cooking: this.cookingJob
        ? { recipeId: this.cookingJob.recipe.id, progress: 1 - this.cookingJob.remaining / this.cookingJob.recipe.seconds }
        : null,
      buff: this.buff
        ? { label: dataName('item', this.buff.dishId, this.inventory.getItem(this.buff.dishId)?.name ?? ''), secondsLeft: Math.ceil(this.buff.remaining) }
        : null,
      weather: this.weather.weather,
      isNight: this.weather.isNight(),
      coins: this.inventory.getItemCount('coins'),
      pets: this.pets.pets.map((p) => ({ name: p.name, kind: p.kind, affection: Math.round(p.affection) })),
      fading: !!this.explore?.fading,
      inCave: !!this.explore?.inCave,
    };
  }

  public get hudKey(): string {
    // Cheap change detector for throttled HUD pushes
    return `${this.revision}|${this.fishing.revision}|${this.explore?.fading}|${this.explore?.inCave}|${this.weather.weather}|${getLang()}`;
  }

  public dispose(): void {
    this.tmp.set(0, 0, 0);
  }
}
