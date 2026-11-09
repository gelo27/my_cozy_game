import type { CropType } from '../../farming/types/FarmingTypes';

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
  cropType?: CropType;
}

export interface InventoryState {
  items: InventoryItem[];
  equippedItemId: string | null;
  isOpen: boolean;
  hotbar: (string | null)[];
  capacity: number;
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
    description: 'Мила лійка в стилі Heartopia. Дозволяє поливати сухі поля, щоб паростки росли.',
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
    description: 'Міцна лопата. Викопує поле 3×3 м на траві, викопує те, що на ньому росте, засипає порожнє поле назад.',
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
    description: 'Добірне насіння золотистої пшениці. Посійте на викопане поле.',
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
  {
    id: 'strawberry_seed',
    name: 'Насіння полуниці',
    category: 'seeds',
    count: 10,
    maxStack: 99,
    iconName: 'Cherry',
    color: '#e11d48',
    description: 'Насіння солодкої полуниці. Низькі кущики з ягодами.',
    isEquippable: true,
    buyPrice: 9,
    cropType: 'strawberry',
  },
  {
    id: 'cabbage_seed',
    name: 'Насіння капусти',
    category: 'seeds',
    count: 10,
    maxStack: 99,
    iconName: 'Leaf',
    color: '#4ade80',
    description: 'Насіння капусти. Виростають тугі хрусткі качани.',
    isEquippable: true,
    buyPrice: 7,
    cropType: 'cabbage',
  },
  {
    id: 'corn_seed',
    name: 'Насіння кукурудзи',
    category: 'seeds',
    count: 10,
    maxStack: 99,
    iconName: 'Wheat',
    color: '#facc15',
    description: 'Насіння кукурудзи. Високі стебла із золотими качанами.',
    isEquippable: true,
    buyPrice: 10,
    cropType: 'corn',
  },
  {
    id: 'sunflower_seed',
    name: 'Насіння соняшника',
    category: 'seeds',
    count: 10,
    maxStack: 99,
    iconName: 'Flower2',
    color: '#f59e0b',
    description: 'Насіння соняшника. Високі стебла з великими золотими кошиками.',
    isEquippable: true,
    buyPrice: 10,
    cropType: 'sunflower',
  },
  {
    id: 'eggplant_seed',
    name: 'Насіння баклажанів',
    category: 'seeds',
    count: 10,
    maxStack: 99,
    iconName: 'Sprout',
    color: '#7c3aed',
    description: 'Насіння баклажанів. Розлогий кущ із фіолетовими плодами.',
    isEquippable: true,
    buyPrice: 11,
    cropType: 'eggplant',
  },
  {
    id: 'pumpkin_seed',
    name: 'Насіння гарбуза',
    category: 'seeds',
    count: 10,
    maxStack: 99,
    iconName: 'Sprout',
    color: '#f97316',
    description: 'Насіння гарбуза. Росте довго, зате врожай найдорожчий.',
    isEquippable: true,
    buyPrice: 12,
    cropType: 'pumpkin',
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
    description: 'Дерев’яний ящик, повний добірної стиглої пшениці. Зібрано з поля.',
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
    description: 'Ящик свіжої хрусткої моркви, щойно з поля.',
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
  {
    id: 'crate_strawberry',
    name: 'Ящик полуниці',
    category: 'crops',
    count: 0,
    maxStack: 99,
    iconName: 'Package',
    color: '#be123c',
    description: 'Ящик стиглої запашної полуниці.',
    isEquippable: false,
    sellPrice: 38,
  },
  {
    id: 'crate_cabbage',
    name: 'Ящик капусти',
    category: 'crops',
    count: 0,
    maxStack: 99,
    iconName: 'Package',
    color: '#16a34a',
    description: 'Ящик хрустких капустяних качанів.',
    isEquippable: false,
    sellPrice: 30,
  },
  {
    id: 'crate_corn',
    name: 'Ящик кукурудзи',
    category: 'crops',
    count: 0,
    maxStack: 99,
    iconName: 'Package',
    color: '#ca8a04',
    description: 'Ящик солодких золотих качанів кукурудзи.',
    isEquippable: false,
    sellPrice: 42,
  },
  {
    id: 'crate_sunflower',
    name: 'Ящик соняшників',
    category: 'crops',
    count: 0,
    maxStack: 99,
    iconName: 'Package',
    color: '#d97706',
    description: 'Ящик золотих соняшникових кошиків, повних насіння.',
    isEquippable: false,
    sellPrice: 44,
  },
  {
    id: 'crate_eggplant',
    name: 'Ящик баклажанів',
    category: 'crops',
    count: 0,
    maxStack: 99,
    iconName: 'Package',
    color: '#6d28d9',
    description: 'Ящик глянцевих фіолетових баклажанів.',
    isEquippable: false,
    sellPrice: 46,
  },
  {
    id: 'crate_pumpkin',
    name: 'Ящик гарбузів',
    category: 'crops',
    count: 0,
    maxStack: 99,
    iconName: 'Package',
    color: '#ea580c',
    description: 'Ящик великих помаранчевих гарбузів.',
    isEquippable: false,
    sellPrice: 52,
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
    description: 'Будівельна деревина для зведення огорож, стін і терас.',
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
  {
    id: 'slingshot',
    name: 'Рогатка',
    category: 'tools',
    count: 1,
    maxStack: 1,
    iconName: 'Target',
    color: '#b45309',
    description: 'Міцна дерев’яна рогатка. ЛКМ / E — постріл камінцем у найближчого шкідника в полі зору: три влучання проганяють їжака, чотири — дракончика.',
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
  {
    id: 'flour',
    name: 'Борошно',
    category: 'crops',
    count: 0,
    maxStack: 99,
    iconName: 'Wheat',
    color: '#f5ead0',
    description: 'Біле пшеничне борошно, змелене на жорнах. З нього печуть хліб на багатті.',
    isEquippable: false,
    sellPrice: 7,
  },
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
  if (item.id === 'strawberry_seed') return '🍓';
  if (item.id === 'cabbage_seed') return '🥬';
  if (item.id === 'corn_seed') return '🌽';
  if (item.id === 'sunflower_seed') return '🌻';
  if (item.id === 'eggplant_seed') return '🍆';
  if (item.id === 'pumpkin_seed') return '🎃';
  if (item.id.startsWith('crate_')) return '📦';
  if (item.id === 'crate_wheat') return '📦';
  if (item.id === 'crate_carrot') return '📦';
  if (item.id === 'crate_tomato') return '📦';
  if (item.id === 'wood') return '🌲';
  if (item.id === 'stone') return '⛰️';
  if (item.id === 'fishing_rod') return '🎣';
  if (item.id === 'slingshot') return '🪃';
  if (item.id === 'fish_golden') return '🐠';
  if (item.id.startsWith('fish_')) return '🐟';
  if (item.id === 'dish_bread') return '🍞';
  if (item.id === 'flour') return '🥣';
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
