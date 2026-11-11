import { worldSettings } from './WorldSettings';

/**
 * Seasons, derived from the day counter (no state of their own, so saves and sleeping just work):
 * day 0 is the first day of spring, each season lasts `worldSettings.daysPerSeason` days.
 */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export const SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'];

export const SEASON_LABELS: Record<Season, string> = {
  spring: 'Весна',
  summer: 'Літо',
  autumn: 'Осінь',
  winter: 'Зима',
};

/** Season of a given day (a fractional day counts the time of day too). */
export function seasonOf(day: number): Season {
  const len = Math.max(1, worldSettings.daysPerSeason);
  return SEASONS[(((Math.floor(day / len) % 4) + 4) % 4)];
}

/** The season right now. */
export function currentSeason(): Season {
  return seasonOf(worldSettings.day);
}

/** 0..1 how far into its season a (fractional) day is. */
export function seasonProgressOf(day: number): number {
  const len = Math.max(1, worldSettings.daysPerSeason);
  return (((day % len) + len) % len) / len;
}

/** Now as a fractional day (day counter + time of day). */
export function nowDay(): number {
  return worldSettings.day + worldSettings.timeOfDay / 24;
}

/** 0..1 how far into the current season we are (time of day included). */
export function seasonProgress(): number {
  return seasonProgressOf(nowDay());
}

/** 1-based day within the current season (for the HUD: "Зима, день 3"). */
export function dayOfSeason(): number {
  const len = Math.max(1, worldSettings.daysPerSeason);
  return ((((worldSettings.day % len) + len) % len) | 0) + 1;
}

/** First day of a season in the current year (dev: jump straight to winter). */
export function firstDayOf(season: Season): number {
  const len = Math.max(1, worldSettings.daysPerSeason);
  const year = Math.floor(worldSettings.day / (len * 4));
  return year * len * 4 + SEASONS.indexOf(season) * len;
}
