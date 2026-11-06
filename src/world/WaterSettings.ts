import * as THREE from 'three';

const fromLinear = (r: number, g: number, b: number): number =>
  new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace).getHex();

/**
 * Live-tweakable sea shader parameters. The developer panel writes here, WaterSystem copies
 * them into its uniforms every frame, so there is no event plumbing to keep in sync.
 * Colours are sRGB hex numbers (converted to linear when uploaded).
 */
export interface WaterSettings {
  /** Blend the sea with what is under it (off = fully opaque, cheapest). */
  transparent: boolean;
  /** Surface opacity 0..1 when `transparent` is on (foam stays opaque). */
  opacity: number;
  shallowColor: number;
  deepColor: number;
  /** Exponent of the depth -> colour blend: higher = deep colour appears sooner. */
  depthFalloff: number;
  /** Normal-map slope strength near the camera / far away. */
  waveNear: number;
  waveFar: number;
  /** Texture tiling of the two wave layers (larger = smaller waves). */
  waveScale1: number;
  waveScale2: number;
  /** Multiplier of the wave scroll speed. */
  waveSpeed: number;
  /** Distance range (m) over which waves calm down. */
  detailStart: number;
  detailEnd: number;
  /** Fresnel sky reflection at grazing angles. */
  fresnel: number;
  /** Sun glint brightness and tightness. */
  glint: number;
  glintSharpness: number;
  /** Shore foam. */
  foamColor: number;
  foamAmount: number;
  foamLine: number;
  rippleFoam: boolean;
  rippleSpeed: number;
}

export const WATER_DEFAULTS: Readonly<WaterSettings> = {
  transparent: false,
  opacity: 0.75,
  shallowColor: fromLinear(0.05, 0.5, 0.47),
  deepColor: fromLinear(0.006, 0.11, 0.25),
  depthFalloff: 0.35,
  waveNear: 0.35,
  waveFar: 0.08,
  waveScale1: 0.045,
  waveScale2: 0.12,
  waveSpeed: 1,
  detailStart: 25,
  detailEnd: 160,
  fresnel: 0.3,
  glint: 2.2,
  glintSharpness: 260,
  foamColor: fromLinear(0.85, 0.92, 0.95),
  foamAmount: 1,
  foamLine: 0.09,
  rippleFoam: true,
  rippleSpeed: 0.22,
};

const STORAGE_KEY = 'farm.waterSettings.v1';

const load = (): WaterSettings => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      const saved = JSON.parse(raw) as Partial<WaterSettings>;
      const out: Record<string, unknown> = { ...WATER_DEFAULTS };
      for (const k of Object.keys(WATER_DEFAULTS) as (keyof WaterSettings)[]) {
        if (typeof saved[k] === typeof WATER_DEFAULTS[k]) out[k] = saved[k];
      }
      return out as unknown as WaterSettings;
    }
  } catch { /* private mode / bad JSON: use defaults */ }
  return { ...WATER_DEFAULTS };
};

export const waterSettings: WaterSettings = load();

/** Saves the current values in this browser. */
export const saveWaterSettings = (): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(waterSettings));
  } catch { /* storage unavailable */ }
};

export const resetWaterSettings = (): void => {
  Object.assign(waterSettings, WATER_DEFAULTS);
  saveWaterSettings();
};
