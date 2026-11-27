import {
  ACESFilmicToneMapping, AgXToneMapping, LinearSRGBColorSpace, LinearToneMapping,
  NeutralToneMapping, NoToneMapping, ReinhardToneMapping, SRGBColorSpace,
} from 'three';

export const TONE_MAPPING = {
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
  reinhard: ReinhardToneMapping,
  linear: LinearToneMapping,
  off: NoToneMapping,
} as const;

export const OUTPUT_COLOR_SPACE = {
  srgb: SRGBColorSpace,
  linear: LinearSRGBColorSpace,
} as const;

export interface RenderSettings {
  toneMapping: keyof typeof TONE_MAPPING;
  exposure: number;
  outputColorSpace: keyof typeof OUTPUT_COLOR_SPACE;
}

export const DEFAULT_RENDER_SETTINGS: Readonly<RenderSettings> = {
  toneMapping: 'aces',
  exposure: 1.05,
  outputColorSpace: 'srgb',
};

export const MIN_EXPOSURE = 0.1;
export const MAX_EXPOSURE = 3;
const STORAGE_KEY = 'farm.renderSettings.v1';

export function loadRenderSettings(): RenderSettings {
  const defaults = { ...DEFAULT_RENDER_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeRenderSettings(JSON.parse(raw), defaults);
  } catch { /* Storage unavailable or corrupt. */ }
  return defaults;
}

export function normalizeRenderSettings(input: unknown, fallback: Readonly<RenderSettings>): RenderSettings {
  if (input === null || typeof input !== 'object') return { ...fallback };
  const { toneMapping, exposure, outputColorSpace } = input as Partial<Record<keyof RenderSettings, unknown>>;
  return {
    toneMapping: typeof toneMapping === 'string' && Object.hasOwn(TONE_MAPPING, toneMapping)
      ? toneMapping as RenderSettings['toneMapping'] : fallback.toneMapping,
    exposure: typeof exposure === 'number' && Number.isFinite(exposure)
      ? Math.min(MAX_EXPOSURE, Math.max(MIN_EXPOSURE, exposure)) : fallback.exposure,
    outputColorSpace: typeof outputColorSpace === 'string' && Object.hasOwn(OUTPUT_COLOR_SPACE, outputColorSpace)
      ? outputColorSpace as RenderSettings['outputColorSpace'] : fallback.outputColorSpace,
  };
}

export function saveRenderSettings(settings: Readonly<RenderSettings>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* Storage unavailable. */ }
}
