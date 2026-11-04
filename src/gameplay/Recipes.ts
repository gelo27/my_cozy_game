export interface Recipe {
  id: string;
  dishId: string;
  name: string;
  ingredients: { itemId: string; count: number }[];
  /** Any fish counts for "fish_any", any sea fish for "fish_sea_any". */
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

/** Cheapest first: cooking uses them up in this order. */
export const SEA_FISH_IDS = ['fish_mackerel', 'fish_seabass', 'fish_tuna', 'fish_moonfish'];

export const FISH_IDS = [
  'fish_carp', 'fish_mackerel', 'fish_perch', 'fish_trout', 'fish_catfish', 'fish_seabass', 'fish_pike',
  'fish_golden', 'fish_tuna', 'fish_sturgeon', 'fish_moonfish',
];

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
