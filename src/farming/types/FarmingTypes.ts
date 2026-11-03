import * as THREE from 'three';

export type CropType = 'wheat' | 'carrot' | 'tomato';

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
};

export interface CropState {
  cropType: CropType;
  stage: CropStage;
  waterCount: number; // 0, 1, or 2
  isWatered: boolean; // currently moist
  growthTimer: number; // progress in seconds towards next stage
  stageDuration: number;
}

export interface FarmPlot {
  id: string;
  pieceId: string;
  position: THREE.Vector3;
  meshGroup: THREE.Group;
  soilMesh: THREE.Mesh | null;
  crop: CropState | null;
  cropMeshGroup: THREE.Group;
  waterIndicator?: THREE.Sprite;
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
  actionText: string;
  hintText: string;
}
