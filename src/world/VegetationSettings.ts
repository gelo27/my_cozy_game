import { isMobileDevice } from './WorldSettings';

/**
 * Live-tweakable vegetation parameters (grass, trees, bushes). The developer panel writes here;
 * the systems read the plain values every frame, and changes that need new geometry (leaf
 * counts, grass density) bump `vegetationRevision` so the owner rebuilds once the slider rests.
 * Defaults differ per device class (phones get fewer, bigger leaves and a smaller grass patch),
 * and each class keeps its own saved copy.
 */
export interface VegetationSettings {
  // ---- grass
  grassEnabled: boolean;
  /** Side of the grass square that follows the camera (m). Rebuilds the blades. */
  grassPatch: number;
  /** Blades per side of the patch. Rebuilds the blades. */
  grassBlades: number;
  grassHeight: number;
  grassWidth: number;
  /** Multiplier on the weather's wind for the grass. */
  grassWind: number;
  /** Brightness at the blade's root / tip. */
  grassBaseShade: number;
  grassTipShade: number;
  /** Extra brightness of a blade's tip the lower it is bent (wind gusts sweep light over the field). */
  grassBendLight: number;
  /** Trampling: how hard bodies push the blades aside (0 = off), and how long they take to stand back up (s). */
  grassTrail: number;
  grassTrailRecover: number;

  // ---- trees and bushes: distances
  /** Trees are drawn up to this far (m). */
  treeViewDist: number;
  /** Near (leafy) LOD up to this far (m), per type. */
  oakNearDist: number;
  pineNearDist: number;
  bushNearDist: number;
  /** Second tree LOD up to this far (m), the simplest one beyond. */
  treeFarDist: number;
  /** Metres a cell must come back before it returns to the more detailed LOD. */
  lodHysteresis: number;
  /** Duration of the dithered crossfade between LODs (s). */
  lodFade: number;

  // ---- wind on leaves, needles and bush leaves
  leafWind: number;
  leafWindSpeed: number;

  // ---- oak leaf scales (rebuild)
  oakLeaves: boolean;
  oakCount: number;
  oakSpacing: number;
  oakSize: number;
  oakOffset: number;
  oakInnerShade: number;

  // ---- pine needle blades (rebuild)
  pineNeedles: boolean;
  /** Paws per row around the trunk. */
  pineCount: number;
  /** Vertical step between rows (m). */
  pineSpacing: number;
  /** Droop of the paws (multiple of the default). */
  pineLength: number;
  /** Paw width as a fraction of its reach. */
  pineWidth: number;
  /** How far the paws reach past the crown's outline (m). */
  pineOffset: number;
  pineInnerShade: number;
  /** Shade of the pine's own crown (the pack's green is bright). */
  pineCrownShade: number;
  /** Near pine crown from the hand-made model (public/models/pine_crown.gltf) instead of generated paws. */
  pineModelCrown: boolean;
  /** Keep the pack's crown mesh under the pine's paws (off: trunk and paws only). */
  pineKeepCrown: boolean;

  // ---- bush leaf scales (rebuild)
  bushLeaves: boolean;
  bushCount: number;
  bushSpacing: number;
  bushSize: number;
  bushOffset: number;
  bushInnerShade: number;
}

const MOBILE = isMobileDevice();

export const VEGETATION_DEFAULTS: Readonly<VegetationSettings> = {
  grassEnabled: true,
  grassPatch: MOBILE ? 36 : 56,
  grassBlades: MOBILE ? 150 : 270,
  grassHeight: MOBILE ? 0.5 : 0.46,
  grassWidth: 0.05,
  grassWind: 1,
  grassBaseShade: 0.64,
  grassTipShade: 1.18,
  grassBendLight: 0.35,
  grassTrail: 1,
  grassTrailRecover: 4,

  treeViewDist: 240,
  oakNearDist: MOBILE ? 40 : 60,
  pineNearDist: MOBILE ? 40 : 55,
  bushNearDist: MOBILE ? 25 : 35,
  treeFarDist: MOBILE ? 85 : 160,
  lodHysteresis: 8,
  lodFade: 0.45,

  leafWind: 0.035,
  leafWindSpeed: 1,

  oakLeaves: true,
  oakCount: MOBILE ? 600 : 1100,
  oakSpacing: MOBILE ? 0.46 : 0.34,
  oakSize: MOBILE ? 0.8 : 0.62,
  oakOffset: 0.07,
  oakInnerShade: 0.75,

  pineNeedles: true,
  pineCount: 6,
  pineSpacing: MOBILE ? 0.5 : 0.43,
  pineLength: 1,
  pineWidth: 0.6,
  pineOffset: 0,
  pineInnerShade: 0.6,
  pineCrownShade: 0.55,
  pineKeepCrown: false,
  pineModelCrown: true,

  bushLeaves: true,
  bushCount: MOBILE ? 120 : 240,
  bushSpacing: MOBILE ? 0.22 : 0.16,
  bushSize: MOBILE ? 0.38 : 0.3,
  bushOffset: 0.04,
  bushInnerShade: 0.75,
};

/** Settings whose change needs new leaf / needle geometry. */
export const LEAF_KEYS: (keyof VegetationSettings)[] = [
  'oakLeaves', 'oakCount', 'oakSpacing', 'oakSize', 'oakOffset', 'oakInnerShade',
  'pineNeedles', 'pineCount', 'pineSpacing', 'pineLength', 'pineWidth', 'pineOffset', 'pineInnerShade', 'pineCrownShade', 'pineKeepCrown', 'pineModelCrown',
  'bushLeaves', 'bushCount', 'bushSpacing', 'bushSize', 'bushOffset', 'bushInnerShade',
];
/** Settings whose change needs new grass blades. */
export const GRASS_GEOMETRY_KEYS: (keyof VegetationSettings)[] = ['grassPatch', 'grassBlades'];

const STORAGE_KEY = `farm.vegetationSettings.v8.${MOBILE ? 'mobile' : 'desktop'}`;

const load = (): VegetationSettings => {
  const out: Record<string, unknown> = { ...VEGETATION_DEFAULTS };
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      const saved = JSON.parse(raw) as Partial<VegetationSettings>;
      for (const k of Object.keys(VEGETATION_DEFAULTS) as (keyof VegetationSettings)[]) {
        if (typeof saved[k] === typeof VEGETATION_DEFAULTS[k]) out[k] = saved[k];
      }
    }
  } catch { /* private mode / bad JSON: use defaults */ }
  return out as unknown as VegetationSettings;
};

export const vegetationSettings: VegetationSettings = load();

/** Bumped when leaves (`leaves`) or grass blades (`grass`) need rebuilding. */
export const vegetationRevision = { leaves: 0, grass: 0 };

/** Sets one value, saves it in this browser and flags the rebuild it needs. */
export function setVegetation<K extends keyof VegetationSettings>(key: K, value: VegetationSettings[K]): void {
  if (vegetationSettings[key] === value) return;
  vegetationSettings[key] = value;
  if (LEAF_KEYS.includes(key)) vegetationRevision.leaves++;
  if (GRASS_GEOMETRY_KEYS.includes(key)) vegetationRevision.grass++;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(vegetationSettings));
  } catch { /* storage unavailable */ }
}

export function resetVegetationSettings(): void {
  for (const k of Object.keys(VEGETATION_DEFAULTS) as (keyof VegetationSettings)[]) {
    setVegetation(k, VEGETATION_DEFAULTS[k] as never);
  }
}
