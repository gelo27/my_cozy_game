import * as THREE from 'three';

export type CropType = 'wheat' | 'carrot' | 'tomato' | 'strawberry' | 'cabbage' | 'corn' | 'eggplant' | 'pumpkin';

/** Every crop, in shop / inventory order. */
export const CROP_TYPES: CropType[] = ['wheat', 'carrot', 'tomato', 'strawberry', 'cabbage', 'corn', 'eggplant', 'pumpkin'];

export type CropStage = 1 | 2 | 3;

export interface CropDefinition {
  type: CropType;
  nameUk: string;
  seedNameUk: string;
  crateNameUk: string;
  seedItemId: string;
  crateItemId: string;
  color: string;
  stageSeconds: number; // Duration in seconds per stage once watered
  description: string;
}

export const CROP_DEFINITIONS: Record<CropType, CropDefinition> = {
  wheat: {
    type: 'wheat',
    nameUk: 'Пшениця',
    seedNameUk: 'Насіння пшениці',
    crateNameUk: 'Ящик пшениці',
    seedItemId: 'wheat_seed',
    crateItemId: 'crate_wheat',
    color: '#eab308',
    stageSeconds: 10,
    description: 'Золотисті колоски пшениці. Вимагає 2 поливи для повного дозрівання.',
  },
  carrot: {
    type: 'carrot',
    nameUk: 'Морква',
    seedNameUk: 'Насіння моркви',
    crateNameUk: 'Ящик моркви',
    seedItemId: 'carrot_seed',
    crateItemId: 'crate_carrot',
    color: '#f97316',
    stageSeconds: 10,
    description: 'Солодка помаранчева морква з пухнастим бадиллям. Потребує 2 поливи.',
  },
  tomato: {
    type: 'tomato',
    nameUk: 'Помідори',
    seedNameUk: 'Насіння помідорів',
    crateNameUk: 'Ящик помідорів',
    seedItemId: 'tomato_seed',
    crateItemId: 'crate_tomato',
    color: '#ef4444',
    stageSeconds: 12,
    description: 'Соковиті червоні томати на підв’язаному кущі. Потребує 2 поливи.',
  },
  strawberry: {
    type: 'strawberry',
    nameUk: 'Полуниця',
    seedNameUk: 'Насіння полуниці',
    crateNameUk: 'Ящик полуниці',
    seedItemId: 'strawberry_seed',
    crateItemId: 'crate_strawberry',
    color: '#e11d48',
    stageSeconds: 12,
    description: 'Низькі кущики з солодкими ягодами. Потребує 2 поливи.',
  },
  cabbage: {
    type: 'cabbage',
    nameUk: 'Капуста',
    seedNameUk: 'Насіння капусти',
    crateNameUk: 'Ящик капусти',
    seedItemId: 'cabbage_seed',
    crateItemId: 'crate_cabbage',
    color: '#4ade80',
    stageSeconds: 11,
    description: 'Тугі хрусткі качани. Потребує 2 поливи.',
  },
  corn: {
    type: 'corn',
    nameUk: 'Кукурудза',
    seedNameUk: 'Насіння кукурудзи',
    crateNameUk: 'Ящик кукурудзи',
    seedItemId: 'corn_seed',
    crateItemId: 'crate_corn',
    color: '#facc15',
    stageSeconds: 14,
    description: 'Високі стебла із золотими качанами. Потребує 2 поливи.',
  },
  eggplant: {
    type: 'eggplant',
    nameUk: 'Баклажани',
    seedNameUk: 'Насіння баклажанів',
    crateNameUk: 'Ящик баклажанів',
    seedItemId: 'eggplant_seed',
    crateItemId: 'crate_eggplant',
    color: '#7c3aed',
    stageSeconds: 14,
    description: 'Розлогий кущ із глянцевими фіолетовими плодами. Потребує 2 поливи.',
  },
  pumpkin: {
    type: 'pumpkin',
    nameUk: 'Гарбуз',
    seedNameUk: 'Насіння гарбуза',
    crateNameUk: 'Ящик гарбузів',
    seedItemId: 'pumpkin_seed',
    crateItemId: 'crate_pumpkin',
    color: '#f97316',
    stageSeconds: 16,
    description: 'Великі помаранчеві гарбузи. Ростуть довго, зате дорогі. Потребує 2 поливи.',
  },
};

export interface CropState {
  cropType: CropType;
  stage: CropStage;
  waterCount: number; // 0, 1, or 2
  isWatered: boolean; // currently moist
  growthTimer: number; // progress in seconds towards next stage
  stageDuration: number;
}

export interface FarmInteractionPrompt {
  plotId: string;
  cropType: CropType | null;
  stage: CropStage | null;
  waterCount: number;
  isWatered: boolean;
  canWater: boolean;
  canPlant: boolean;
  canHarvest: boolean;
  growthProgress: number; // 0 to 1
  /** Always true: crops grow only on shovel-dug fields. */
  isField?: boolean;
  /** Set while the shovel is in hand: dig a new field, fill an empty one back in, or blocked. */
  shovel?: 'dig' | 'fill' | 'blocked';
  /** The shovel can act right now. */
  canDig?: boolean;
  /** 0..1 while E / LMB is being held to dig or fill. */
  holdProgress?: number;
  actionText: string;
  hintText: string;
}
