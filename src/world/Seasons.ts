import { worldSettings } from './WorldSettings';

/**
 * Seasons. The season is a fixed world setting (`worldSettings.season`): days pass, the season
 * does not change by itself. It is changed by hand (editor, `dev.season`) and kept in the save.
 */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export const SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'];

export const SEASON_LABELS: Record<Season, string> = {
  spring: 'Весна',
  summer: 'Літо',
  autumn: 'Осінь',
  winter: 'Зима',
};

/** The season right now. */
export function currentSeason(): Season {
  return worldSettings.season;
}

/** Now as a fractional day (day counter + time of day). */
export function nowDay(): number {
  return worldSettings.day + worldSettings.timeOfDay / 24;
}

/**
 * Season of a save from before seasons were fixed: they used to follow the day counter, 7 days
 * each from spring on day 0. Such a save keeps the season it was in.
 */
export function legacySeasonOf(day: number): Season {
  return SEASONS[(((Math.floor(day / 7) % 4) + 4) % 4)];
}
