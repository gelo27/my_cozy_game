/**
 * Player preferences from the pause menu (volumes, mouse), kept in localStorage.
 * Systems read the live object; `onUserSettingsChange` notifies them after every edit.
 */
export interface UserSettings {
  /** 0..1 */
  master: number;
  /** Effects, including nature ambience. */
  sfx: number;
  /** Reserved for future music; the bus already exists. */
  music: number;
  sfxOn: boolean;
  musicOn: boolean;
  /** Multiplier of the default mouse / touch look speed. */
  sensitivity: number;
  invertY: boolean;
}

const DEFAULTS: UserSettings = {
  master: 0.9,
  sfx: 1,
  music: 0.7,
  sfxOn: true,
  musicOn: true,
  sensitivity: 1,
  invertY: false,
};

const STORAGE_KEY = 'farm-user-settings';

function load(): UserSettings {
  const s = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return s;
    const data = JSON.parse(raw) as Partial<Record<keyof UserSettings, unknown>>;
    for (const k of Object.keys(DEFAULTS) as (keyof UserSettings)[]) {
      const v = data[k];
      if (typeof v === typeof DEFAULTS[k] && (typeof v !== 'number' || Number.isFinite(v))) (s as Record<string, unknown>)[k] = v;
    }
  } catch { /* storage unavailable or corrupt: defaults */ }
  return s;
}

export const userSettings: UserSettings = load();

const listeners = new Set<() => void>();

export function onUserSettingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function updateUserSettings(patch: Partial<UserSettings>): void {
  Object.assign(userSettings, patch);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userSettings));
  } catch { /* ignore */ }
  listeners.forEach((fn) => fn());
}

export function resetUserSettings(): void {
  updateUserSettings({ ...DEFAULTS });
}
