import * as THREE from 'three';
import { FOG_SCALE, isMobileDevice, worldSettings } from './WorldSettings';
import { PrecipitationOcclusion } from './PrecipitationOcclusion';
import { Precipitation, PRECIP_BOX } from './Precipitation';
import { SkyDome, SkyParams } from './SkyDome';
import { riverWorld } from './rivers/RiverWorld';
import { WeatherDirector } from './WeatherDirector';
import { currentSeason } from './Seasons';

export type WeatherType = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog' | 'snow' | 'blizzard';

export const WEATHER_LABELS: Record<WeatherType, string> = {
  clear: 'Ясно',
  cloudy: 'Хмарно',
  rain: 'Дощ',
  storm: 'Гроза',
  fog: 'Туман',
  snow: 'Сніг',
  blizzard: 'Буран',
};

export interface WeatherProfile {
  light: number; // sun intensity multiplier
  fog: number; // fog density
  tint: THREE.Color; // sky tint multiplier
  precipitation: 'none' | 'rain' | 'snow';
  amount: number; // 0..1 share of particles visible
  cover: number; // 0..1 cloud cover
  dark: number; // 0..1 how grey the clouds are
  haze: THREE.Color; // colour of the haze that replaces the horizon / fog colour
  hazeMix: number; // 0..1 how strongly the haze replaces it (0 = off)
  sound: WeatherSound;
}

/** Ambient sound mix of one weather type (all 0..~1.5 multipliers, edited in the developer panel). */
export interface WeatherSound {
  rain: number; // loudness of rain (scaled by precipitation)
  wind: number; // storm / snow wind
  thunder: number; // thunder after lightning (only storms flash)
  birds: number; // daytime birdsong in forests
  birdRate: number; // how often the birds sing (1 = default pauses)
  insects: number; // night crickets
  breeze: number; // soft breeze and leaf rustle
  fog: number; // quiet muffled hush of foggy weather
}

export const WEATHER_SOUND_KEYS = ['rain', 'wind', 'thunder', 'birds', 'birdRate', 'insects', 'breeze', 'fog'] as const;

const snd = (rain: number, wind: number, thunder: number, birds: number, birdRate: number, insects: number, breeze: number, fog = 0): WeatherSound => ({
  rain, wind, thunder, birds, birdRate, insects, breeze, fog,
});

const mk = (
  light: number, fog: number, tint: number, precipitation: WeatherProfile['precipitation'],
  amount: number, cover: number, dark: number, haze: number, hazeMix: number, sound: WeatherSound,
): WeatherProfile => ({
  light, fog, tint: new THREE.Color(tint), precipitation, amount, cover, dark, haze: new THREE.Color(haze), hazeMix, sound,
});

const makeDefaults = (): Record<WeatherType, WeatherProfile> => ({
  //                                                                      rain wind thun birds rate insects breeze
  clear: mk(1, 0.0155, 0xffffff, 'none', 0, 0.25, 0.5, 0x1aa7ff, 0.75, snd(1, 0, 0, 0.9, 1, 1, 1)),
  cloudy: mk(0.65, 0.02, 0xeff1f3, 'none', 0, 0.68, 0.25, 0x42adff, 0.5, snd(1, 0, 0, 0.6, 0.7, 1, 1)),
  rain: mk(0.5, 0.0305, 0xdadfe7, 'rain', 0.5, 0.88, 0.6, 0xffffff, 0, snd(1, 0.25, 0, 0, 0.5, 0, 0)),
  storm: mk(0.2, 0.05, 0x8b93a2, 'rain', 1, 1, 1, 0xffffff, 0, snd(1, 0.9, 1, 0, 0.5, 0, 0)),
  fog: mk(0.6, 0.045, 0xf3f3f3, 'none', 0, 1, 0, 0xffffff, 0, snd(1, 0, 0, 0, 0.5, 0, 0, 1)),
  snow: mk(0.7, 0.03, 0xa9e5fe, 'snow', 0.8, 1, 0.35, 0x71d4fe, 1, snd(1, 0.6, 0, 0, 0.5, 0, 0)),
  // Whiteout: dense pale haze, dim flat light, wind-driven snow and a howling wind
  blizzard: mk(0.35, 0.085, 0xc9d6e6, 'snow', 1, 1, 0.75, 0xdde6f0, 1, snd(1, 1.3, 0, 0, 0.5, 0, 0)),
});

/** Live, editable weather profiles (the developer panel mutates these; the weather eases toward them). */
export const WEATHER_PROFILES: Record<WeatherType, WeatherProfile> = makeDefaults();
const PROFILES = WEATHER_PROFILES;

const STORAGE_KEY = 'farm-weather-profiles';
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export const WeatherProfiles = {
  reset(type: WeatherType): void {
    const d = makeDefaults()[type];
    const t = PROFILES[type];
    Object.assign(t, d, { tint: t.tint.copy(d.tint), haze: t.haze.copy(d.haze), sound: Object.assign(t.sound, d.sound) });
    WeatherProfiles.save();
  },
  resetAll(): void {
    (Object.keys(PROFILES) as WeatherType[]).forEach((k) => WeatherProfiles.reset(k));
  },
  save(): void {
    try {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(PROFILES) as WeatherType[]) {
        const p = PROFILES[k];
        out[k] = { ...p, tint: p.tint.getHex(), haze: p.haze.getHex(), sound: { ...p.sound } };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch { /* storage unavailable */ }
  },
  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      const d = makeDefaults();
      for (const k of Object.keys(PROFILES) as WeatherType[]) {
        const s = data[k];
        if (!s) continue;
        const p = PROFILES[k];
        p.light = num(s.light, d[k].light);
        p.fog = num(s.fog, d[k].fog);
        p.amount = num(s.amount, d[k].amount);
        p.cover = num(s.cover, d[k].cover);
        p.dark = num(s.dark, d[k].dark);
        p.hazeMix = num(s.hazeMix, d[k].hazeMix);
        if (s.precipitation === 'none' || s.precipitation === 'rain' || s.precipitation === 'snow') p.precipitation = s.precipitation;
        if (typeof s.tint === 'number') p.tint.setHex(s.tint);
        if (typeof s.haze === 'number') p.haze.setHex(s.haze);
        const ss = s.sound ?? {};
        for (const key of WEATHER_SOUND_KEYS) p.sound[key] = num(ss[key], d[k].sound[key]);
      }
    } catch { /* corrupt data: keep defaults */ }
  },
};
WeatherProfiles.load();

const SUNRISE = 6;
const SUNSET = 19.5;

/** Zenith (top of the sky) colours keyed by hour. */
const ZENITH_KEYS: [number, number][] = [
  [0, 0x040814],
  [5, 0x0c1530],
  [6.5, 0x4a6aa8],
  [8, 0x5aa6e0],
  [12, 0x4f9fe0],
  [17.5, 0x5aa0d8],
  [19.3, 0x3a5a98],
  [20.6, 0x0e1638],
  [24, 0x040814],
];

/** Horizon / fog colours keyed by hour, blended linearly. */
const SKY_KEYS: [number, number][] = [
  [0, 0x0b1430],
  [5, 0x1d2a52],
  [6.5, 0xf2a98a],
  [8, 0xbfe3f5],
  [12, 0xd9f0fb],
  [17.5, 0xc8e4f2],
  [19.3, 0xf0a07a],
  [20.6, 0x2a3466],
  [24, 0x0b1430],
];

/**
 * Day/night cycle, sky, fog and weather.
 *
 * Rain and snow live in Precipitation (GPU-animated, roof-aware through PrecipitationOcclusion).
 */
export class WeatherSystem {
  /** Side of the precipitation box that follows the camera (m). */
  public static readonly PRECIP_BOX = PRECIP_BOX;
  private static readonly MOBILE = isMobileDevice();
  public weather: WeatherType = 'clear';
  /** Automatic weather (Markov chain + forecast). `director.auto = false` keeps the weather fixed. */
  public readonly director = new WeatherDirector((type) => this.applyAuto(type), 'clear');
  /** Smoothed 0..1, readable by gameplay (e.g. rain waters crops). */
  public rainIntensity = 0;

  public readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly precipitation: Precipitation;
  private occlusion: PrecipitationOcclusion | null = null;
  private snowMix = 0;
  /**
   * 0..1 how much snow lies on the open ground: builds up over ~1.5 game hours of heavy snow,
   * melts over ~3 hours after (faster in sunshine, much faster in rain). Read by the terrain,
   * grass, footsteps and the ambience; costs one uniform each.
   */
  public snowCover = 0;
  /** True while lying snow is melting (meltwater soaks the fields like rain). */
  public melting = false;
  /** 0..1 eased blizzard share (the wind howls instead of the snow's hush). */
  public blizzardMix = 0;
  /** Called when a storm lightning flash starts (thunder sound). */
  public onLightning: (() => void) | null = null;
  /**
   * Asked on some storm flashes to land a bolt near the player instead; returns false when it
   * cannot (indoors, in a cave, under water), and the flash happens far away as usual.
   */
  public onGroundStrike: (() => boolean) | null = null;
  private readonly fog: THREE.FogExp2;
  private readonly sky = new THREE.Color();
  private current = { light: 1, fog: 0.0155, amount: 0, cover: 0.25, dark: 0, hazeMix: 0, tint: new THREE.Color(1, 1, 1), haze: new THREE.Color(1, 1, 1) };
  /** Sound mix eased toward the current weather's profile (read by the ambience every frame). */
  public readonly sound: WeatherSound = { ...PROFILES.clear.sound };
  /** 0 by day, 1 at full night; drives night lighting. */
  public nightFactor = 0;
  /** Target 0..1 for being underground: sunlight, sky light and precipitation fade out, fog turns black. */
  public caveFactor = 0;
  private caveMix = 0;
  /** Whether a point lies in the cave network (wired by the exploration); the sky there is fog. */
  public isCaveAt: ((p: THREE.Vector3) => boolean) | null = null;
  private skyFlat = 0;
  /** 0..1, how far the camera is under the sea, a river or a lake (fog and sky turn to water). */
  public underwater = 0;
  /** Depth of the water above the camera (m), 0 above water. */
  private underDepth = 0;
  public readonly sunDir = new THREE.Vector3(0, 1, 0);
  public readonly moonDir = new THREE.Vector3(0, -1, 0);
  private readonly skyDome: SkyDome;
  private readonly skyParams: SkyParams = {
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    sunDir: this.sunDir,
    moonDir: this.moonDir,
    sunColor: new THREE.Color(),
    cloudLit: new THREE.Color(),
    cloudShade: new THREE.Color(),
    cover: 0.3,
    day: 1,
    night: 0,
    flash: 0,
    moonCloud: 1,
    rainbow: 0,
  };
  /** 1 right after a real rain, fading to 0 over about a game hour: a rainbow can show while it lasts. */
  private rainMemory = 0;
  /** Whether this rain gets a rainbow at all (rolled once per rain, so it isn't after every shower). */
  private rainbowRoll = false;
  private rainbow = 0;
  /** The current change is an automatic one (slow, phased) rather than set by hand. */
  private smooth = false;
  /** 0..1 eased storm share (wind on the drops). */
  private stormMix = 0;
  /** Dry-weather roof-map refresh throttle (s): the night ambience only needs the cell overhead. */
  private occTimer = 0;
  private lightningTimer = 4;
  private flash = 0;
  private static readonly _c = new THREE.Color();
  private static readonly _c2 = new THREE.Color();
  private static readonly GROUND = new THREE.Color(0x4a5a3a);
  private static readonly SNOW_GROUND = new THREE.Color(0xc4d0e2);

  constructor(private readonly scene: THREE.Scene) {
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.hemi = new THREE.HemisphereLight(0xe0f2fe, 0x4a5a3a, 0.55);
    this.sun = new THREE.DirectionalLight(0xfffaed, 1.3);
    this.sun.castShadow = false;
    scene.add(this.ambient, this.hemi, this.sun, this.sun.target);

    this.fog = new THREE.FogExp2(0xd9f0fb, 0.006);
    scene.fog = this.fog;
    scene.background = this.sky;
    this.skyDome = new SkyDome(scene);

    this.precipitation = new Precipitation(scene);
  }

  /** Enables the raycast roof map so rain and snow stop at roofs and big static colliders. */
  public setOcclusion(occ: PrecipitationOcclusion): void {
    this.occlusion = occ;
    this.precipitation.setOcclusion(occ);
  }

  /** True when a roof or another large static collider covers `pos` (only tracked while it rains). */
  /** A lightning flash right now (a bolt that landed nearby). */
  public flashNow(strength = 1): void {
    this.flash = Math.max(this.flash, strength);
  }

  public isSheltered(pos: THREE.Vector3): boolean {
    const h = this.occlusion?.heightAt(pos.x, pos.z);
    return h !== null && h !== undefined && h > pos.y + 1.2;
  }

  /** 0..1 how much snow (vs rain) is falling. */
  /** 0..1 eased cloud cover (what the sky shows now). */
  public get cloudCover(): number {
    return this.current.cover;
  }

  private updateSnowCover(dt: number): void {
    const hourSec = worldSettings.secondsPerHour > 0 ? worldSettings.secondsPerHour : 60;
    const falling = this.snowMix * this.current.amount;
    this.melting = false;
    if (falling > 0.05) {
      this.snowCover = Math.min(1, this.snowCover + (dt / (hourSec * 1.5)) * Math.min(1, falling / 0.8));
    } else if (this.snowCover > 0) {
      const rain = this.current.amount * (1 - this.snowMix);
      // Bright sun only counts by day under a thin sky
      const sun = this.current.light * (1 - this.nightFactor) * (1 - this.current.cover * 0.6);
      // Melt per game hour: winter keeps its snow (a sunny noon only nibbles at it), spring thaws
      // it over a day or two, the first snow of autumn and a summer freak fall go within hours
      let perHour: number;
      switch (currentSeason()) {
        case 'winter': perHour = sun * 0.02; break;
        case 'spring': perHour = 0.025 + sun * 0.08 + rain * 0.8; break;
        case 'autumn': perHour = 0.25 + sun * 0.4 + rain * 2; break;
        default: perHour = 0.6 + sun + rain * 3;
      }
      this.snowCover = Math.max(0, this.snowCover - (dt * perHour) / hourSec);
      this.melting = perHour > 0.02 && this.snowCover > 0.02;
    }
  }

  public get snowAmount(): number {
    return this.snowMix * this.current.amount;
  }

  /**
   * Weather set by hand (editor, console, save load): ~3 s transition, and the automatic chain
   * carries on from this state with a fresh duration.
   */
  /** Dev: acts as if a rain just ended and rolled a rainbow (shows once the sky clears by day). */
  public devRainbow(): void {
    this.rainMemory = 1;
    this.rainbowRoll = true;
    this.setWeather('clear');
  }

  public setWeather(type: WeatherType): void {
    this.weather = type;
    this.smooth = false;
    this.director.override(type);
  }

  /** Automatic change from the director: the sky eases over about a minute, clouds gather before the rain. */
  private applyAuto(type: WeatherType): void {
    this.weather = type;
    this.smooth = true;
  }

  /** Readable clock string "HH:MM". */
  public getClockLabel(): string {
    const h = Math.floor(worldSettings.timeOfDay);
    const m = Math.floor((worldSettings.timeOfDay - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  public isNight(): boolean {
    return worldSettings.timeOfDay < SUNRISE || worldSettings.timeOfDay > SUNSET + 0.7;
  }

  public update(dt: number, cameraPos: THREE.Vector3): void {
    // Clock
    if (worldSettings.secondsPerHour > 0) {
      const next = worldSettings.timeOfDay + dt / worldSettings.secondsPerHour;
      if (next >= 24) worldSettings.day++;
      worldSettings.timeOfDay = next % 24;
    }
    const t = worldSettings.timeOfDay;
    this.director.update(dt);

    // Ease weather parameters toward the target profile: ~3 s by hand, ~1 min for automatic changes,
    // with each group on its own pace (clouds first, fog slowest)
    const p = PROFILES[this.weather];
    const cur = this.current;
    const s = this.smooth;
    const kSky = 1 - Math.exp(-dt * (s ? 0.07 : 0.8));
    const kFog = 1 - Math.exp(-dt * (s ? 0.04 : 0.8));
    const kRain = 1 - Math.exp(-dt * (s ? 0.06 : 0.8));
    const kCloud = 1 - Math.exp(-dt * (s ? 0.09 : 0.8));
    // Phases: precipitation waits until the clouds have gathered (gate), and while it is still
    // falling the clouds can't thin out below a rain sky
    const gate = p.amount > 0 ? THREE.MathUtils.clamp((cur.cover - p.cover * 0.6) / (p.cover * 0.3 + 1e-3), 0, 1) : 1;
    const wet = Math.min(1, cur.amount * 4);
    const coverTarget = Math.max(p.cover, wet * 0.88);
    const darkTarget = Math.max(p.dark, wet * 0.6);
    cur.cover += (coverTarget - cur.cover) * kCloud;
    cur.dark += (darkTarget - cur.dark) * kCloud;
    cur.light += (Math.min(p.light, 1 - wet * 0.5) - cur.light) * kSky;
    cur.fog += (p.fog - cur.fog) * kFog;
    cur.amount += (p.amount * gate - cur.amount) * kRain;
    cur.tint.lerp(p.tint, kSky);
    cur.haze.lerp(p.haze, kSky);
    cur.hazeMix += (p.hazeMix - cur.hazeMix) * kSky;
    const sounds = this.sound;
    for (let i = 0; i < WEATHER_SOUND_KEYS.length; i++) {
      const key = WEATHER_SOUND_KEYS[i];
      sounds[key] += (p.sound[key] - sounds[key]) * kSky;
    }
    // Rain turns to snow (and back) gradually instead of in one frame
    if (p.precipitation !== 'none') this.snowMix += ((p.precipitation === 'snow' ? 1 : 0) - this.snowMix) * (1 - Math.exp(-dt * (s ? 0.15 : 2)));
    this.stormMix += ((this.weather === 'storm' || this.weather === 'blizzard' ? 1 : 0) - this.stormMix) * kCloud;
    this.blizzardMix += ((this.weather === 'blizzard' ? 1 : 0) - this.blizzardMix) * kCloud;
    this.rainIntensity = cur.amount * (1 - this.snowMix * 0.8);
    this.updateSnowCover(dt);

    // Sun path: rises in the east at 6, sets in the west at 19:30; the night half is the remaining
    // 10.5 h, so phase runs 0..PI over the day and PI..2PI over the night. The moon sits opposite.
    const dayPhase =
      t >= SUNRISE && t <= SUNSET
        ? ((t - SUNRISE) / (SUNSET - SUNRISE)) * Math.PI
        : Math.PI + ((((t - SUNSET) % 24) + 24) % 24 / (24 - (SUNSET - SUNRISE))) * Math.PI;
    const elevation = Math.sin(dayPhase);
    // Wide ranges so dusk and dawn last ~2 game hours instead of snapping past
    const daylight = THREE.MathUtils.smoothstep(elevation, -0.25, 0.3);
    this.nightFactor = 1 - THREE.MathUtils.smoothstep(elevation, -0.3, 0.15);
    this.sunDir.set(Math.cos(dayPhase), elevation, 0.35).normalize();
    this.moonDir.set(-Math.cos(dayPhase), -elevation, -0.35).normalize();
    const warm = 1 - THREE.MathUtils.smoothstep(elevation, 0.1, 0.5);

    // Lightning flashes during storms
    // (only once the storm clouds have built up, so an automatic storm doesn't flash out of a blue sky)
    if (this.weather === 'storm' && cur.dark > 0.8) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        // Long, uneven gaps; now and then a second strike follows close behind the first
        this.lightningTimer = Math.random() < 0.15 ? 1.5 + Math.random() * 3 : 10 + Math.random() * Math.random() * 40;
        if (!(Math.random() < 0.35 && this.onGroundStrike?.())) {
          this.flash = 1;
          this.onLightning?.();
        }
      }
    }
    this.flash = Math.max(0, this.flash - dt * 3);

    // One directional light: the sun by day, cool moonlight by night. Both fade to zero at the
    // handover point (sun just below the horizon), so the 180° flip of direction and the colour
    // change happen while the light is dark and can't be seen; ambient and hemi carry the dusk.
    const HANDOVER = -0.04;
    const sunK = THREE.MathUtils.smoothstep(elevation, HANDOVER, 0.25);
    const moonK = 1 - THREE.MathUtils.smoothstep(elevation, -0.3, HANDOVER);
    const moonUp = elevation < HANDOVER;
    const lightDir = moonUp ? this.moonDir : this.sunDir;
    this.sun.position.copy(cameraPos).addScaledVector(lightDir, 70);
    this.sun.target.position.copy(cameraPos);
    if (moonUp) {
      this.sun.color.setRGB(0.6, 0.7, 1.0);
      this.sun.intensity = 0.45 * moonK * (0.4 + cur.light * 0.6) + this.flash * 2;
    } else {
      this.sun.color.setRGB(1, 1 - warm * 0.3, 1 - warm * 0.55);
      this.sun.intensity = 1.35 * sunK * cur.light + this.flash * 2;
    }
    this.ambient.intensity = 0.24 + 0.38 * daylight * (0.6 + cur.light * 0.4) + this.flash;
    this.hemi.intensity = 0.2 + 0.4 * daylight;
    // Sky colour of the hemi light: night blue 0x6a7ab8 -> day 0xe0f2fe, blended
    const hk = THREE.MathUtils.smoothstep(daylight, 0.05, 0.6);
    this.hemi.color.setRGB(0.416 + (0.878 - 0.416) * hk, 0.478 + (0.949 - 0.478) * hk, 0.722 + (0.996 - 0.722) * hk, THREE.SRGBColorSpace);
    // Snow: a colder, flatter light while it falls (weaker cool sun, more soft fill, a greyer
    // sky light), and a white ground that bounces light back up under everything
    const snowing = this.snowMix * Math.min(1, cur.amount * 2);
    if (snowing > 0.001) {
      this.sun.color.lerp(WeatherSystem._c.setRGB(0.82, 0.9, 1), snowing * 0.5);
      this.sun.intensity *= 1 - snowing * 0.25;
      this.ambient.intensity += 0.1 * snowing * daylight;
      this.hemi.color.lerp(WeatherSystem._c.setRGB(0.8, 0.84, 0.9), snowing * 0.45);
    }
    this.hemi.groundColor.copy(WeatherSystem.GROUND).lerp(WeatherSystem.SNOW_GROUND, this.snowCover * 0.85);
    this.ambient.intensity += 0.05 * this.snowCover * daylight;

    // Sky = time-of-day key colour x weather tint; fog matches the horizon
    this.sampleKeys(SKY_KEYS, t, this.sky).multiply(cur.tint);
    if (this.flash > 0) this.sky.lerp(WeatherSystem._c.setRGB(1, 1, 1), this.flash * 0.5);
    // Weather haze: tints the horizon and fog together (darker at night)
    if (cur.hazeMix > 0.001) {
      this.sky.lerp(WeatherSystem._c.copy(cur.haze).multiplyScalar(daylight * 0.8 + 0.2), cur.hazeMix);
    }
    this.fog.color.copy(this.sky);
    this.fog.density = cur.fog * FOG_SCALE;

    // Sky dome
    const sp = this.skyParams;
    sp.horizon.copy(this.sky);
    this.sampleKeys(ZENITH_KEYS, t, sp.zenith).multiply(cur.tint);
    // Overcast skies flatten toward the horizon colour
    sp.zenith.lerp(sp.horizon, cur.dark * 0.6);
    sp.sunColor.setRGB(1, 0.92 - warm * 0.35, 0.8 - warm * 0.55).multiplyScalar(cur.light * 0.6 + 0.4);
    // Clouds: white by day, sunset-tinted, blue-grey under the moon, darker with bad weather
    const dayCloud = WeatherSystem._c.setRGB(1, 1 - warm * 0.25, 1 - warm * 0.4);
    // Night clouds sit just above the night sky: dim blue-grey, so they read as dark shapes, not glowing
    const nightCloud = WeatherSystem._c2.setRGB(0.085, 0.1, 0.145);
    // Ease toward the day colour only once real daylight returns (dusk clouds go dark early)
    const cloudDay = THREE.MathUtils.smoothstep(daylight, 0.05, 0.75);
    sp.cloudLit.copy(nightCloud).lerp(dayCloud, cloudDay).multiplyScalar(1 - cur.dark * 0.45);
    sp.cloudShade.copy(sp.cloudLit).multiplyScalar(0.62 - cur.dark * 0.2);
    sp.cover = cur.cover;
    sp.day = daylight;
    sp.night = this.nightFactor * (1 - cur.cover * 0.7);
    sp.flash = this.flash;
    // A thick overcast hides the moon: full moonlit edges on clear nights, about half when cloudy,
    // a faint hint in rain and almost nothing in a storm
    sp.moonCloud = (1 - THREE.MathUtils.smoothstep(cur.cover, 0.3, 1) * 0.85) * (1 - this.stormMix * 0.5);
    // Rainbow: the rain has (almost) stopped, the sun shines through thinning clouds, no fog or snow
    const rainNow = cur.amount * (1 - this.snowMix);
    if (rainNow > 0.25) {
      if (this.rainMemory < 0.5) this.rainbowRoll = Math.random() < 0.6;
      this.rainMemory = 1;
    } else if (this.rainMemory > 0) {
      const hourSec = worldSettings.secondsPerHour > 0 ? worldSettings.secondsPerHour : 60;
      this.rainMemory = Math.max(0, this.rainMemory - dt / hourSec);
    }
    const rainbowTarget = this.rainbowRoll
      ? Math.min(1, this.rainMemory * 1.5) *
        (1 - THREE.MathUtils.smoothstep(rainNow, 0.03, 0.2)) *
        (1 - THREE.MathUtils.smoothstep(cur.cover, 0.6, 0.85)) *
        (1 - THREE.MathUtils.smoothstep(cur.fog, 0.035, 0.06)) *
        THREE.MathUtils.smoothstep(daylight, 0.3, 0.7) *
        (1 - this.stormMix) * (1 - this.caveMix)
      : 0;
    this.rainbow += (rainbowTarget - this.rainbow) * (1 - Math.exp(-dt * 0.3));
    sp.rainbow = this.rainbow > 0.002 ? this.rainbow : 0;
    this.skyDome.update(dt, cameraPos, sp);

    // Precipitation
    // (in a blizzard's bright whiteout by day the flakes stay white instead of greying out)
    const bright = (0.3 + daylight * 0.7) * (0.55 + cur.light * 0.45) + this.flash + this.blizzardMix * daylight * 0.4;
    this.caveMix += (this.caveFactor - this.caveMix) * (1 - Math.exp(-dt * 4));
    if (this.caveMix > 0.001) this.applyCave(this.caveMix);
    // Under water: a dense blue-green fog (darker deeper down and at night), and the sky behind
    // it turns the same colour, so nothing above the surface shows through the water
    const surface = riverWorld.waterLevelAt3(cameraPos.x, cameraPos.y, cameraPos.z);
    const below = surface - cameraPos.y;
    this.underDepth = Math.max(0, below);
    this.underwater += ((below > 0.02 ? 1 : 0) - this.underwater) * (1 - Math.exp(-dt * 25));
    if (this.underwater > 0.001) this.applyUnderwater(this.underwater, daylight);
    this.skyDome.mesh.visible = this.underwater < 0.5;
    // In a cave the sky seen down a long tunnel is just the fog: no sky gradient, sun or clouds
    // (also when only the camera is down there: the editor's fly camera, the doorway fade)
    const camInCave = this.isCaveAt?.(cameraPos) ? 1 : 0;
    this.skyFlat += (Math.max(camInCave, this.caveFactor) - this.skyFlat) * (1 - Math.exp(-dt * 4));
    const flat = Math.max(camInCave, Math.min(1, this.skyFlat * 1.25));
    this.skyDome.setFlat(this.fog.color, flat > 0.001 ? flat : 0);
    // Phones: heavy rain is mostly overdraw of transparent drops, so the densest share is capped
    const amount = cur.amount * (1 - this.caveMix) * (WeatherSystem.MOBILE ? 0.75 : 1);
    this.precipitation.update(dt, cameraPos, amount, this.snowMix, bright, this.stormMix, Math.min(window.devicePixelRatio || 1, 1.5), worldSettings.waterLevel);
    // Roof map: every frame while something falls; in dry nights the ambience only needs the
    // cell overhead, so it refreshes twice a second
    if (this.precipitation.active) {
      this.occlusion?.update(cameraPos);
      this.occTimer = 0;
    } else if (this.nightFactor > 0.05) {
      this.occTimer -= dt;
      if (this.occTimer <= 0) {
        this.occTimer = 0.5;
        this.occlusion?.update(cameraPos);
      }
    }
  }

  private applyUnderwater(k: number, daylight: number): void {
    const deep = Math.min(1, this.underDepth / 12);
    const light = (0.25 + daylight * 0.75) * (1 - deep * 0.55) * (1 - this.caveMix);
    const c = WeatherSystem._c.setRGB(0.06, 0.32, 0.38).multiplyScalar(light);
    this.fog.color.lerp(c, k);
    this.fog.density += (0.075 + deep * 0.03 - this.fog.density) * k;
    this.sky.lerp(c, k);
  }

  /** Underground: no sun or sky, a faint cold ambient, and a black fog that swallows far tunnels. */
  private applyCave(k: number): void {
    this.sun.intensity *= 1 - k;
    this.ambient.intensity += (0.07 - this.ambient.intensity) * k;
    this.hemi.intensity += (0.04 - this.hemi.intensity) * k;
    this.fog.color.lerp(WeatherSystem._c.setRGB(0.012, 0.014, 0.02), k);
    this.fog.density += (0.05 - this.fog.density) * k;
  }

  private sampleKeys(keys: [number, number][], hour: number, out: THREE.Color): THREE.Color {
    for (let i = 0; i < keys.length - 1; i++) {
      // Indexed, not destructured: array destructuring allocates an iterator (called many times a frame)
      const k0 = keys[i], k1 = keys[i + 1];
      const h0 = k0[0], c0 = k0[1], h1 = k1[0], c1 = k1[1];
      if (hour >= h0 && hour <= h1) {
        const f = (hour - h0) / (h1 - h0);
        return out.copy(WeatherSystem._c.setHex(c0)).lerp(WeatherSystem._c2.setHex(c1), f);
      }
    }
    return out.setHex(keys[0][1]);
  }
}
