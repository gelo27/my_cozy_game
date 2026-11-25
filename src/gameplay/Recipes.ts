export interface Recipe {
  id: string;
  dishId: string;
  name: string;
  ingredients: { itemId: string; count: number }[];
  /** Base cooking time in seconds. */
  seconds: number;
  /** Found on the island (a recipe scroll or cookbook) before it can be cooked. */
  locked?: boolean;
}

export const RECIPES: Recipe[] = [
  // Wheat crate -> millstone (3 flour) -> bread: 18 coins of wheat become a 30-coin loaf
  { id: 'bread', dishId: 'dish_bread', name: 'Хліб', ingredients: [{ itemId: 'flour', count: 3 }], seconds: 3 },
  {
    id: 'salad',
    dishId: 'dish_salad',
    name: 'Овочевий салат',
    ingredients: [
      { itemId: 'crate_carrot', count: 1 },
      { itemId: 'crate_tomato', count: 1 },
    ],
    seconds: 2,
  },
  {
    id: 'soup',
    dishId: 'dish_soup',
    name: 'Овочевий суп',
    ingredients: [
      { itemId: 'crate_carrot', count: 1 },
      { itemId: 'crate_tomato', count: 1 },
      { itemId: 'crate_wheat', count: 1 },
    ],
    seconds: 4,
  },
  { id: 'grilled_fish', dishId: 'dish_grilled_fish', name: 'Риба на грилі', ingredients: [{ itemId: 'fish_any', count: 1 }], seconds: 3 },
  {
    id: 'fish_stew',
    dishId: 'dish_fish_stew',
    name: 'Рибна юшка',
    ingredients: [
      { itemId: 'fish_any', count: 2 },
      { itemId: 'crate_carrot', count: 1 },
    ],
    seconds: 5,
  },
  {
    id: 'mushroom_stew',
    dishId: 'dish_mushroom_stew',
    name: 'Грибне рагу',
    ingredients: [
      { itemId: 'cave_mushroom', count: 2 },
      { itemId: 'crate_carrot', count: 1 },
    ],
    seconds: 5,
    locked: true,
  },
  {
    id: 'seafood_platter',
    dishId: 'dish_seafood_platter',
    name: 'Морська тарілка',
    ingredients: [
      { itemId: 'fish_sea_any', count: 2 },
      { itemId: 'crate_tomato', count: 1 },
    ],
    seconds: 6,
    locked: true,
  },
];

/** Fish families accepted by wildcard recipe slots. */
export const SEA_FISH_IDS = ['fish_mackerel', 'fish_seabass', 'fish_tuna', 'fish_moonfish'];

export const FISH_IDS = [
  'fish_carp', 'fish_mackerel', 'fish_perch', 'fish_trout', 'fish_catfish', 'fish_seabass', 'fish_pike',
  'fish_golden', 'fish_tuna', 'fish_sturgeon', 'fish_moonfish',
];

export type CookingMethod = 'mix' | 'pan' | 'pot' | 'oven';

export function cookingMethod(recipe: Recipe): CookingMethod {
  if (recipe.id === 'salad') return 'mix';
  if (recipe.id === 'bread') return 'oven';
  if (recipe.id === 'grilled_fish' || recipe.id === 'seafood_platter') return 'pan';
  return 'pot';
}

export function matchesIngredient(requirement: string, itemId: string): boolean {
  if (requirement === 'fish_any') return FISH_IDS.includes(itemId);
  if (requirement === 'fish_sea_any') return SEA_FISH_IDS.includes(itemId);
  return requirement === itemId;
}

/** Match each portion only once. A partial combination can still accept more ingredients. */
export function matchesRecipe(recipe: Recipe, items: readonly string[], partial = false): boolean {
  const slots = recipe.ingredients.flatMap(({ itemId, count }) => Array<string>(count).fill(itemId));
  if (!partial && slots.length !== items.length) return false;
  // Reserve exact ingredients and more restrictive fish slots first.
  slots.sort((a, b) => Number(a === 'fish_any') - Number(b === 'fish_any')
    || Number(a === 'fish_sea_any') - Number(b === 'fish_sea_any'));
  const unused = [...items];
  for (const slot of slots) {
    const match = unused.findIndex((id) => matchesIngredient(slot, id));
    if (match >= 0) unused.splice(match, 1);
  }
  return unused.length === 0;
}

/** Seconds of the speed buff and its multiplier when a dish is eaten. */
export const DISH_BUFF: Record<string, { seconds: number; speed: number }> = {
  dish_bread: { seconds: 60, speed: 1.15 },
  dish_salad: { seconds: 90, speed: 1.2 },
  dish_soup: { seconds: 120, speed: 1.25 },
  dish_grilled_fish: { seconds: 90, speed: 1.2 },
  dish_fish_stew: { seconds: 180, speed: 1.35 },
  dish_mushroom_stew: { seconds: 150, speed: 1.3 },
  dish_seafood_platter: { seconds: 240, speed: 1.4 },
};
