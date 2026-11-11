import type { WeatherType } from './WeatherSystem';
import { worldSettings } from './WorldSettings';
import { Season, nowDay, seasonOf, seasonProgressOf } from './Seasons';

/**
 * Automatic weather: a seeded Markov chain over WeatherType with per-state durations in in-game
 * hours, plus a forecast queue (the next few states are rolled ahead, so a HUD can show "rain at 15:00").
 *
 * Pure logic, no rendering: it ticks once a second, allocates nothing per tick, and hands each new
 * state to WeatherSystem.setWeather(type, smooth = true), which eases the sky / fog / rain toward it.
 */

type Row = Partial<Record<WeatherType, number>>;

/**
 * Next-state weights per state (normalised when rolled; season and time-of-day modifiers multiply
 * them). Spring, summer and autumn share this table; snow and blizzard rows only lead out of a
 * snowy spell that started before the season changed.
 */
const TRANSITIONS: Record<WeatherType, Row> = {
  clear: { clear: 0.45, cloudy: 0.47, fog: 0.08 },
  cloudy: { clear: 0.38, cloudy: 0.2, rain: 0.34, storm: 0.06, fog: 0.02 },
  rain: { cloudy: 0.55, rain: 0.25, storm: 0.15, clear: 0.05 },
  storm: { rain: 0.75, cloudy: 0.25 },
  fog: { clear: 0.6, cloudy: 0.4 },
  snow: { cloudy: 0.6, snow: 0.2, clear: 0.2 },
  blizzard: { snow: 0.5, cloudy: 0.5 },
};

/** Winter: frosty clear days, grey overcast, snowfalls and now and then a blizzard; no rain. */
const WINTER: Record<WeatherType, Row> = {
  clear: { clear: 0.45, cloudy: 0.4, fog: 0.15 },
  cloudy: { clear: 0.3, cloudy: 0.2, snow: 0.42, blizzard: 0.05, fog: 0.03 },
  snow: { cloudy: 0.45, snow: 0.3, blizzard: 0.13, clear: 0.12 },
  blizzard: { snow: 0.7, cloudy: 0.3 },
  fog: { clear: 0.5, cloudy: 0.5 },
  rain: { cloudy: 0.7, snow: 0.3 },
  storm: { cloudy: 1 },
};

/** Per-season multipliers on the shared table (summer: sunny with thunderstorms; autumn: wet and foggy). */
const SEASON_MUL: Record<Season, Row> = {
  spring: { rain: 1.2, clear: 0.95 },
  summer: { clear: 1.3, rain: 0.75, storm: 1.4, fog: 0.6 },
  autumn: { clear: 0.8, rain: 1.25, fog: 1.7, storm: 0.6 },
  winter: {},
};

/**
 * Share of the rain that falls as snow outside winter: the first snow at the end of autumn, the
 * last at the start of spring (0 the rest of the year).
 */
function snowShare(season: Season, progress: number): number {
  if (season === 'autumn') return Math.max(0, (progress - 0.6) / 0.4) * 0.7;
  if (season === 'spring') return Math.max(0, (0.3 - progress) / 0.3) * 0.6;
  return 0;
}

/** How long each state lasts, in in-game hours [min, max]. */
const DURATION: Record<WeatherType, [number, number]> = {
  clear: [3, 8],
  cloudy: [1.5, 4],
  rain: [1, 3],
  storm: [0.5, 1.5],
  fog: [1, 2.5],
  snow: [2, 5],
  blizzard: [0.7, 2],
};

const TYPES: WeatherType[] = ['clear', 'cloudy', 'rain', 'storm', 'fog', 'snow', 'blizzard'];
/** How many states are rolled ahead. */
const FORECAST_LEN = 4;
/** Logic tick (real seconds). */
const TICK = 1;

export interface WeatherForecastEntry {
  type: WeatherType;
  /** In-game hours from now until this state begins. */
  inHours: number;
  /** Clock hour 0..24 at which it begins. */
  atHour: number;
}

export interface WeatherDirectorSave {
  rng: number;
  hoursLeft: number;
  queue: { type: WeatherType; hours: number }[];
  auto: boolean;
}

/** mulberry32: tiny, fast, good enough, and its whole state is one uint32 (easy to save). */
class Rng {
  constructor(public state: number) {}
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
}

export class WeatherDirector {
  /** Off = the weather stays as set by hand (editor / console). */
  public auto = true;

  private readonly rng: Rng;
  private current: WeatherType;
  /** In-game hours the current state still lasts. */
  private hoursLeft: number;
  /** Rolled-ahead states (type + its duration). Fixed slots, reused: no allocation per roll. */
  private readonly queue: { type: WeatherType; hours: number }[] = [];
  private acc = 0;
  private readonly weights = new Float64Array(TYPES.length);
  private readonly forecastOut: WeatherForecastEntry[] = [];

  constructor(private readonly apply: (type: WeatherType, smooth: boolean) => void, initial: WeatherType = 'clear', seed = (Math.random() * 2 ** 32) >>> 0) {
    this.rng = new Rng(seed);
    this.current = initial;
    this.hoursLeft = this.rollDuration(initial);
    for (let i = 0; i < FORECAST_LEN; i++) this.queue.push({ type: 'clear', hours: 1 });
    this.refillFrom(0, initial, worldSettings.timeOfDay + this.hoursLeft);
    for (let i = 0; i < FORECAST_LEN; i++) this.forecastOut.push({ type: 'clear', inHours: 0, atHour: 0 });
  }

  public get weather(): WeatherType {
    return this.current;
  }

  /** In-game hours until the next change. */
  public get hoursUntilChange(): number {
    return this.hoursLeft;
  }

  /** Real-time tick; `dt` is the game-scaled frame time. */
  public update(dt: number): void {
    this.acc += dt;
    if (this.acc < TICK) return;
    const step = this.acc;
    this.acc = 0;
    const sph = worldSettings.secondsPerHour;
    if (!this.auto || sph <= 0) return;
    this.hoursLeft -= step / sph;
    if (this.hoursLeft > 0) return;
    // Next state comes off the forecast; a new one is rolled at its end
    const next = this.queue[0];
    this.current = next.type;
    this.hoursLeft += next.hours;
    if (this.hoursLeft <= 0) this.hoursLeft = next.hours;
    for (let i = 0; i < FORECAST_LEN - 1; i++) {
      this.queue[i].type = this.queue[i + 1].type;
      this.queue[i].hours = this.queue[i + 1].hours;
    }
    const last = this.queue[FORECAST_LEN - 2];
    const lastStart = worldSettings.timeOfDay + this.hoursLeft + this.sumHours(FORECAST_LEN - 2);
    this.rollInto(this.queue[FORECAST_LEN - 1], last.type, lastStart + last.hours);
    this.apply(this.current, true);
  }

  /**
   * Weather set by hand (editor, console, save): it becomes the current state with a fresh
   * duration and the forecast is rolled again from it. The chain carries on from there when auto is on.
   */
  public override(type: WeatherType): void {
    this.current = type;
    this.hoursLeft = this.rollDuration(type);
    this.refillFrom(0, type, worldSettings.timeOfDay + this.hoursLeft);
  }

  /** Upcoming states (the returned array and its entries are reused: read, don't keep). */
  public forecast(): readonly WeatherForecastEntry[] {
    let at = this.hoursLeft;
    for (let i = 0; i < FORECAST_LEN; i++) {
      const o = this.forecastOut[i];
      o.type = this.queue[i].type;
      o.inHours = at;
      o.atHour = (((worldSettings.timeOfDay + at) % 24) + 24) % 24;
      at += this.queue[i].hours;
    }
    return this.forecastOut;
  }

  public serialize(): WeatherDirectorSave {
    return {
      rng: this.rng.state >>> 0,
      hoursLeft: +this.hoursLeft.toFixed(3),
      queue: this.queue.map((q) => ({ type: q.type, hours: +q.hours.toFixed(3) })),
      auto: this.auto,
    };
  }

  /** Restores the chain; `current` is the saved weather type. Missing / broken data re-rolls. */
  public deserialize(current: WeatherType, data: WeatherDirectorSave | undefined): void {
    this.current = current;
    if (!data || !Array.isArray(data.queue) || data.queue.length !== FORECAST_LEN || !(data.hoursLeft > 0)) {
      this.override(current);
      return;
    }
    this.rng.state = data.rng | 0;
    this.hoursLeft = data.hoursLeft;
    this.auto = data.auto !== false;
    for (let i = 0; i < FORECAST_LEN; i++) {
      const s = data.queue[i];
      const ok = s && TYPES.includes(s.type) && s.hours > 0;
      this.queue[i].type = ok ? s.type : 'cloudy';
      this.queue[i].hours = ok ? s.hours : 2;
    }
  }

  // ------------------------------------------------------------------ rolling

  private sumHours(n: number): number {
    let s = 0;
    for (let i = 0; i < n; i++) s += this.queue[i].hours;
    return s;
  }

  /** Re-rolls queue[from..] starting after `prev`, whose successor begins at clock hour `startHour`. */
  private refillFrom(from: number, prev: WeatherType, startHour: number): void {
    let p = prev;
    let at = startHour;
    for (let i = from; i < FORECAST_LEN; i++) {
      this.rollInto(this.queue[i], p, at);
      p = this.queue[i].type;
      at += this.queue[i].hours;
    }
  }

  private rollInto(slot: { type: WeatherType; hours: number }, prev: WeatherType, startHour: number): void {
    slot.type = this.rollNext(prev, startHour);
    slot.hours = this.rollDuration(slot.type);
  }

  private rollDuration(type: WeatherType): number {
    const [a, b] = DURATION[type];
    return this.rng.range(a, b);
  }

  /**
   * Picks the state after `prev`, starting at clock hour `hour` (fog favours mornings, storms
   * afternoons), with the weights of the season that state starts in.
   */
  private rollNext(prev: WeatherType, hour: number): WeatherType {
    const h = ((hour % 24) + 24) % 24;
    // The season when this state begins (the forecast may reach into the next one)
    let ahead = hour - worldSettings.timeOfDay;
    if (ahead < 0) ahead += 24;
    const day = nowDay() + ahead / 24;
    const season = seasonOf(Math.floor(day));
    const winter = season === 'winter';
    const row = (winter ? WINTER : TRANSITIONS)[prev];
    const mul = SEASON_MUL[season];
    const share = winter ? 0 : snowShare(season, seasonProgressOf(day));
    let total = 0;
    for (let i = 0; i < TYPES.length; i++) {
      const t = TYPES[i];
      let w = (row[t] ?? 0) * (mul[t] ?? 1);
      if (t === 'fog') w *= h >= 3 && h <= 9 ? 3 : 0.25;
      else if (t === 'storm') w *= h >= 13 && h <= 20 ? 1.6 : 0.6;
      // Outside winter snow only comes in place of rain (late autumn, early spring)
      if (!winter) {
        if (t === 'snow') w = ((row.rain ?? 0) * (mul.rain ?? 1)) * share + (prev === 'snow' ? w * share : 0);
        else if (t === 'rain') w *= 1 - share;
        else if (t === 'blizzard') w = 0;
      }
      this.weights[i] = w;
      total += w;
    }
    if (total <= 0) return 'clear';
    let r = this.rng.next() * total;
    for (let i = 0; i < TYPES.length; i++) {
      r -= this.weights[i];
      if (r <= 0 && this.weights[i] > 0) return TYPES[i];
    }
    return prev === 'clear' ? 'cloudy' : 'clear';
  }
}
