import { useSyncExternalStore } from 'react';
import { en, TKey } from './en';
import { uk } from './uk';
import { EN_NAMES } from './names';

export type Lang = 'en' | 'uk';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'EN' },
  { id: 'uk', label: 'UA' },
];

const STORAGE_KEY = 'cozyfarm.lang';
const DICTS: Record<Lang, Record<TKey, string>> = { en, uk };

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'uk') return saved;
  } catch {
    // storage blocked (private mode, sandboxed iframe): fall through to the browser language
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'en';
  return nav.startsWith('uk') ? 'uk' : 'en';
}

let current: Lang = detectLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // not persisted; the choice still applies for this session
  }
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  listeners.forEach((fn) => fn());
}

export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-renders the calling component when the language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(onLangChange, getLang, getLang);
}

/** Translate a UI string. `{name}` placeholders are filled from `params`. */
export function t(key: TKey, params?: Record<string, string | number>): string {
  const s = DICTS[current][key] ?? en[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? '')) : s;
}

/** Ukrainian plural form: 1 удар, 2 удари, 5 ударів. English: one / other. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (current === 'en') return n === 1 ? one : many;
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Name for data that carries both an English `name` and a `ukrainianName` (building pieces, wallpapers). */
export function localName(def: { name: string; ukrainianName?: string } | null | undefined): string {
  if (!def) return '';
  return current === 'uk' && def.ukrainianName ? def.ukrainianName : def.name;
}

type NameKind = keyof typeof EN_NAMES;

/**
 * Name of a game entity whose source data is in Ukrainian (items, recipes, crops, props).
 * Ukrainian returns the data's own text; English looks up EN_NAMES by id.
 */
export function dataName(kind: NameKind, id: string, ukrainian: string): string {
  if (current === 'uk') return ukrainian;
  const table = EN_NAMES[kind] as Record<string, string>;
  return table[id] ?? ukrainian;
}

/** Item description; English descriptions live next to the names as `<id>.desc`. */
export function itemDesc(id: string, ukrainian: string): string {
  if (current === 'uk') return ukrainian;
  return (EN_NAMES.itemDesc as Record<string, string>)[id] ?? '';
}

/** Building badges like "2x2м (Пройм)" → "2x2m (Opening)". */
export function localizeBadge(s: string): string {
  if (current === 'uk') return s;
  let out = s;
  for (const [ua, eng] of BADGE_WORDS) out = out.replace(ua, eng);
  // Units last: metres, and the Cyrillic "х" often typed as a multiplication sign
  return out.replace(/(\d)\s*м/g, '$1m').replace(/(\d)[хХ](\d)/g, '$1x$2');
}

const BADGE_WORDS: [string, string][] = [
  ['Пройм', 'Opening'],
  ['Одинарні', 'Single'],
  ['Двостулкові', 'Double'],
  ['Парадні', 'Grand'],
  ['Шейкер', 'Shaker'],
  ['Котеджні', 'Cottage'],
  ['Колоніальні', 'Colonial'],
  ['В:', 'H:'],
  ['2-похилий', 'Gable'],
  ['4-похилий', 'Hip'],
  ['1-похилий', 'Shed'],
  ['Чекер', 'Checker'],
  ['Русти', 'Rustic'],
  ['Прямі', 'Straight'],
  ['Вхід', 'Entry'],
  ['Двері', 'Door'],
  ['Білий', 'White'],
  ['Сходи', 'Stairs'],
  ['Стілець', 'Chair'],
  ['Мʼяке', 'Soft'],
  ['3 шухляди', '3 drawers'],
];

if (typeof document !== 'undefined') document.documentElement.lang = current;
