export type InventoryCategory = 'tools' | 'seeds' | 'crops' | 'food' | 'materials' | 'all';

export interface InventoryItem {
  id: string;
  name: string;
  category: 'tools' | 'seeds' | 'crops' | 'food' | 'materials';
  /** Coins received when sold at the mailbox shop (0 = cannot be sold). */
  sellPrice?: number;
  /** Coins to buy one at the shop (undefined = not sold there). */
  buyPrice?: number;
  count: number;
  maxStack: number;
  iconName: string;
  color: string;
  description: string;
  isEquippable: boolean;
  cropType?: 'wheat' | 'carrot' | 'tomato';
}

export interface InventoryState {
  items: InventoryItem[];
  equippedItemId: string | null;
  isOpen: boolean;
}

export const DEFAULT_INVENTORY_ITEMS: InventoryItem[] = [
  // Tools
  {
    id: 'watering_can',
    name: 'Лійка садівника',
    category: 'tools',
    count: 1,
    maxStack: 1,
    iconName: 'Droplets',
    color: '#38bdf8',
    description: 'Мила лійка в стилі Heartopia. Дозволяє поливати сухі грядки, щоб паростки росли.',
    isEquippable: true,
  },
  {
    id: 'axe',
    name: 'Сокира',
    category: 'tools',
    count: 1,
    maxStack: 1,
    iconName: 'Axe',
    color: '#a16207',
    description: 'Надійна сокира лісоруба. П’ять ударів валять дерево, ще один розколює стовбур на дрова.',
    isEquippable: true,
  },
  {
    id: 'pickaxe',
    name: 'Кайло',
    category: 'tools',
    count: 1,
    maxStack: 1,
    iconName: 'Pickaxe',
    color: '#64748b',
    description: 'Кайло для каменоломні. Розбиває брили на камінь і видобуває залізну руду.',
    isEquippable: true,
  },
  {
    id: 'shovel',
    name: 'Лопата',
    category: 'tools',
    count: 1,
    maxStack: 1,
    iconName: 'Shovel',
    color: '#8b5a2b',
    description: 'Міцна лопата. Викопує поле 4×4 м на траві для 25 рослин; засипає порожнє поле назад.',
    isEquippable: true,
  },
  // Seeds
  {
    id: 'wheat_seed',
    name: 'Насіння пшениці',
    category: 'seeds',
    count: 20,
    maxStack: 99,
    iconName: 'Sprout',
    color: '#eab308',
    description: 'Добірне насіння золотистої пшениці. Посадіть у пусту грядку.',
    isEquippable: true,
    buyPrice: 4,
    cropType: 'wheat',
  },
  {
    id: 'carrot_seed',
    name: 'Насіння моркви',
    category: 'seeds',
    count: 20,
    maxStack: 99,
    iconName: 'Carrot',
    color: '#f97316',
    description: 'Насіння соковитої моркви. Потребує двох поливів для дозрівання.',
    isEquippable: true,
    buyPrice: 6,
    cropType: 'carrot',
  },
  {
    id: 'tomato_seed',
    name: 'Насіння помідорів',
    category: 'seeds',
    count: 20,
    maxStack: 99,
    iconName: 'Apple',
    color: '#ef4444',
    description: 'Насіння томатів. Виростає у високий підв’язаний кущ із солодкими томатами.',
    isEquippable: true,
    buyPrice: 8,
    cropType: 'tomato',
  },
  // Harvest Crates
  {
    id: 'crate_wheat',
    name: 'Ящик пшениці',
    category: 'crops',
    count: 0,
    maxStack: 99,
    iconName: 'Package',
    color: '#ca8a04',
    description: 'Дерев’яний ящик, повний добірної стиглої пшениці. Зібрано з грядки.',
    isEquippable: false,
    sellPrice: 18,
  },
  {
    id: 'crate_carrot',
    name: 'Ящик моркви',
    category: 'crops',
    count: 0,
    maxStack: 99,
    iconName: 'Package',
    color: '#ea580c',
    description: 'Ящик свіжої хрусткої моркви, щойно з грядки.',
    isEquippable: false,
    sellPrice: 26,
  },
  {
    id: 'crate_tomato',
    name: 'Ящик помідорів',
    category: 'crops',
    count: 0,
    maxStack: 99,
    iconName: 'Package',
    color: '#dc2626',
    description: 'Ящик дозрілих соковитих томатів вищого ґатунку.',
    isEquippable: false,
    sellPrice: 34,
  },
  // Materials for building
  {
    id: 'wood',
    name: 'Деревина',
    category: 'materials',
    count: 120,
    maxStack: 999,
    iconName: 'Trees',
    color: '#b45309',
    description: 'Будівельна деревина для зведення огорож, стін, терас та грядок.',
    isEquippable: false,
    sellPrice: 1,
  },
  {
    id: 'stone',
    name: 'Камінь',
    category: 'materials',
    count: 80,
    maxStack: 999,
    iconName: 'Box',
    color: '#64748b',
    description: 'Міцний камінь для фундаментів та бордюрів.',
    isEquippable: false,
    sellPrice: 1,
  },
  {
    id: 'iron_ore',
    name: 'Залізна руда',
    category: 'materials',
    count: 0,
    maxStack: 999,
    iconName: 'Gem',
    color: '#c2703d',
    description: 'Руда з рудими прожилками. Видобувається кайлом з брил біля каменоломні.',
    isEquippable: false,
    sellPrice: 6,
  },
  ...mat('copper_ore', 'Мідна руда', 'Gem', '#b87333', 'Зеленкувато-мідна руда з гірських схилів.', 8),
  ...mat('gold_ore', 'Золота руда', 'Gem', '#e8b84a', 'Рідкісна руда з золотими жилками. Трапляється високо в горах і глибоко в печерах.', 25),
  ...mat('crystal', 'Кристал', 'Gem', '#9b7bff', 'Світний печерний кристал. Цінується в крамниці.', 40),
  ...mat('gem_ruby', 'Рубін', 'Gem', '#e0115f', 'Старовинний самоцвіт зі скарбу.', 250),
  ...mat('sand', 'Пісок', 'Box', '#e6d3a3', 'Чистий морський пісок з пляжу.', 1),
  ...mat('shell', 'Мушля', 'Shell', '#f4c7b8', 'Перламутрова мушля, викинута хвилею на берег.', 6),
  ...mat('pearl', 'Перлина', 'Gem', '#f5f1e6', 'Рідкісна перлина, знайдена в мушлі.', 150),
  {
    id: 'cave_mushroom',
    name: 'Печерний гриб',
    category: 'food',
    count: 0,
    maxStack: 99,
    iconName: 'Sprout',
    color: '#7dd3fc',
    description: 'Блакитний гриб, що світиться в темряві печер. Інгредієнт для рагу.',
    isEquippable: false,
    sellPrice: 10,
  },
  // Fishing, cooking, pets & economy
  {
    id: 'fishing_rod',
    name: 'Вудка',
    category: 'tools',
    count: 1,
    maxStack: 1,
    iconName: 'Fish',
    color: '#0ea5e9',
    description: 'Підійдіть до води, візьміть вудку і натисніть ЛКМ / E, щоб закинути. Тисніть, коли поплавок смикнеться!',
    isEquippable: true,
  },
  ...fish('fish_carp', 'Короп', '#a3a35c', 'Звичайна ставкова риба. Клює будь-коли.', 12),
  ...fish('fish_perch', 'Окунь', '#5c8a3a', 'Смугастий окунь, активний вдень.', 18),
  ...fish('fish_catfish', 'Сом', '#5b4a3a', 'Великий нічний сом. Ловиться ввечері та вночі.', 40),
  ...fish('fish_golden', 'Золота рибка', '#f5b301', 'Рідкісна! Частіше трапляється в дощ.', 120),
  ...fish('fish_trout', 'Форель', '#9fb7a0', 'Плямиста форель з далеких лісових озер.', 30),
  ...fish('fish_pike', 'Щука', '#6d7f4a', 'Хижа щука далеких озер. Клює вранці та ввечері.', 55),
  ...fish('fish_sturgeon', 'Осетер', '#8a8f99', 'Рідкісний озерний велетень. Частіше в дощ.', 160),
  ...fish('fish_mackerel', 'Скумбрія', '#4a7fa8', 'Смугаста морська риба. Ловиться з берега моря.', 22),
  ...fish('fish_seabass', 'Морський окунь', '#7d8fa3', 'Сріблястий морський окунь.', 45),
  ...fish('fish_tuna', 'Тунець', '#2f4f7a', 'Рідкісний! Великий морський тунець.', 140),
  ...fish('fish_moonfish', 'Риба-місяць', '#c9d6e8', 'Легендарна риба, що підіймається до берега лише вночі.', 300),
  ...food('dish_bread', 'Хліб', '#d9a35b', 'Пухкий домашній хліб.', 30),
  ...food('dish_salad', 'Овочевий салат', '#4caf50', 'Свіжий салат з моркви та томатів.', 45),
  ...food('dish_soup', 'Овочевий суп', '#ff9800', 'Гарячий суп, що зігріває в дощ.', 60),
  ...food('dish_grilled_fish', 'Риба на грилі', '#c8763a', 'Ароматна риба з багаття.', 35),
  ...food('dish_fish_stew', 'Рибна юшка', '#e0a040', 'Навариста юшка з риби та овочів.', 95),
  ...food('dish_mushroom_stew', 'Грибне рагу', '#7aa0b8', 'Рагу з печерних грибів за рецептом з покинутої хатини.', 80),
  ...food('dish_seafood_platter', 'Морська тарілка', '#3f8fb0', 'Страва доглядача маяка з морської риби.', 120),
  {
    id: 'pet_treat',
    name: 'Ласощі для тварин',
    category: 'food',
    count: 3,
    maxStack: 99,
    iconName: 'Bone',
    color: '#d97706',
    description: 'Пригостіть кота чи песика, щоб підняти їхню прихильність.',
    isEquippable: false,
    buyPrice: 8,
  },
  {
    id: 'coins',
    name: 'Монети',
    category: 'materials',
    count: 50,
    maxStack: 999999,
    iconName: 'Coins',
    color: '#facc15',
    description: 'Заробляйте, продаючи врожай, рибу та страви в поштовій скриньці.',
    isEquippable: false,
  },
];

function fish(id: string, name: string, color: string, description: string, sellPrice: number): InventoryItem[] {
  return [{ id, name, category: 'food', count: 0, maxStack: 99, iconName: 'Fish', color, description, isEquippable: false, sellPrice }];
}

function mat(id: string, name: string, iconName: string, color: string, description: string, sellPrice: number): InventoryItem[] {
  return [{ id, name, category: 'materials', count: 0, maxStack: 999, iconName, color, description, isEquippable: false, sellPrice }];
}

function food(id: string, name: string, color: string, description: string, sellPrice: number): InventoryItem[] {
  return [{ id, name, category: 'food', count: 0, maxStack: 99, iconName: 'Soup', color, description, isEquippable: false, sellPrice }];
}

export function getItemEmoji(item?: InventoryItem | null): string {
  if (!item) return '🎒';
  if (item.id === 'watering_can') return '💧';
  if (item.id === 'axe') return '🪓';
  if (item.id === 'pickaxe') return '⛏️';
  if (item.id === 'shovel') return '🪏';
  if (item.id === 'iron_ore') return '🔶';
  if (item.id === 'copper_ore') return '🟤';
  if (item.id === 'gold_ore') return '🟡';
  if (item.id === 'crystal') return '🔮';
  if (item.id === 'gem_ruby') return '💎';
  if (item.id === 'sand') return '⏳';
  if (item.id === 'shell') return '🐚';
  if (item.id === 'pearl') return '⚪';
  if (item.id === 'cave_mushroom') return '🍄';
  if (item.id === 'fish_moonfish') return '🐡';
  if (item.id === 'fish_tuna' || item.id === 'fish_sturgeon') return '🐠';
  if (item.id === 'wheat_seed') return '🌾';
  if (item.id === 'carrot_seed') return '🥕';
  if (item.id === 'tomato_seed') return '🍅';
  if (item.id === 'crate_wheat') return '📦';
  if (item.id === 'crate_carrot') return '📦';
  if (item.id === 'crate_tomato') return '📦';
  if (item.id === 'wood') return '🌲';
  if (item.id === 'stone') return '⛰️';
  if (item.id === 'fishing_rod') return '🎣';
  if (item.id === 'fish_golden') return '🐠';
  if (item.id.startsWith('fish_')) return '🐟';
  if (item.id === 'dish_bread') return '🍞';
  if (item.id === 'dish_salad') return '🥗';
  if (item.id === 'dish_soup') return '🍲';
  if (item.id === 'dish_grilled_fish') return '🍢';
  if (item.id === 'dish_fish_stew') return '🥘';
  if (item.id === 'dish_mushroom_stew') return '🍛';
  if (item.id === 'dish_seafood_platter') return '🍱';
  if (item.id === 'pet_treat') return '🦴';
  if (item.id === 'coins') return '💰';
  return '✨';
}
