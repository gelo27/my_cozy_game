import * as THREE from 'three';
import { isMobileDevice, worldSettings } from './WorldSettings';

export type WeatherType = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog' | 'snow';

export const WEATHER_LABELS: Record<WeatherType, string> = {
  clear: 'Ясно',
  cloudy: 'Хмарно',
  rain: 'Дощ',
  storm: 'Гроза',
  fog: 'Туман',
  snow: 'Сніг',
};

interface WeatherProfile {
  light: number; // sun intensity multiplier
  fog: number; // fog density
  tint: THREE.Color; // sky tint multiplier
  precipitation: 'none' | 'rain' | 'snow';
  amount: number; // 0..1 share of particles visible
}

const PROFILES: Record<WeatherType, WeatherProfile> = {
  clear: { light: 1, fog: 0.006, tint: new THREE.Color(1, 1, 1), precipitation: 'none', amount: 0 },
  cloudy: { light: 0.65, fog: 0.009, tint: new THREE.Color(0.86, 0.88, 0.9), precipitation: 'none', amount: 0 },
  rain: { light: 0.5, fog: 0.014, tint: new THREE.Color(0.7, 0.74, 0.8), precipitation: 'rain', amount: 0.7 },
  storm: { light: 0.32, fog: 0.02, tint: new THREE.Color(0.5, 0.54, 0.62), precipitation: 'rain', amount: 1 },
  fog: { light: 0.6, fog: 0.045, tint: new THREE.Color(0.9, 0.9, 0.9), precipitation: 'none', amount: 0 },
  snow: { light: 0.7, fog: 0.016, tint: new THREE.Color(0.92, 0.95, 1), precipitation: 'snow', amount: 0.8 },
};

/** Sky colours keyed by hour, blended linearly. */
const SKY_KEYS: [number, number][] = [
  [0, 0x0b1430],
  [5, 0x1d2a52],
  [6.5, 0xf2a98a],
  [8, 0xbfe3f5],
  [12, 0xd9f0fb],
  [17, 0xc8e4f2],
  [18.8, 0xf0a07a],
  [20, 0x2a3466],
  [24, 0x0b1430],
];

/**
 * Day/night cycle, sky, fog and weather.
 *
 * Precipitation is a single THREE.Points cloud around the camera whose motion is computed in the
 * vertex shader from time, so the CPU only updates two uniforms per frame regardless of drop count.
 */
export class WeatherSystem {
  public weather: WeatherType = 'clear';
  /** Smoothed 0..1, readable by gameplay (e.g. rain waters crops). */
  public rainIntensity = 0;

  public readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly precip: THREE.Points;
  private readonly precipMat: THREE.ShaderMaterial;
  private readonly fog: THREE.FogExp2;
  private readonly sky = new THREE.Color();
  private current = { light: 1, fog: 0.006, amount: 0, tint: new THREE.Color(1, 1, 1) };
  private lightningTimer = 4;
  private flash = 0;
  private static readonly _c = new THREE.Color();
  private static readonly _c2 = new THREE.Color();

  constructor(private readonly scene: THREE.Scene) {
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.hemi = new THREE.HemisphereLight(0xe0f2fe, 0x4a5a3a, 0.55);
    this.sun = new THREE.DirectionalLight(0xfffaed, 1.3);
    this.sun.castShadow = false;
    scene.add(this.ambient, this.hemi, this.sun, this.sun.target);

    this.fog = new THREE.FogExp2(0xd9f0fb, 0.006);
    scene.fog = this.fog;
    scene.background = this.sky;

    const count = isMobileDevice() ? 900 : 2600;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = Math.random() * 40 - 20;
      pos[i * 3 + 1] = Math.random() * 24;
      pos[i * 3 + 2] = Math.random() * 40 - 20;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.precipMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uAmount: { value: 0 },
        uSnow: { value: 0 },
        uSize: { value: isMobileDevice() ? 2.0 : 2.6 },
      },
      vertexShader: `
        attribute float seed;
        uniform float uTime, uAmount, uSnow, uSize;
        uniform vec3 uCenter;
        varying float vAlpha;
        void main() {
          float speed = mix(16.0, 1.6, uSnow);
          vec3 p = position;
          p.y = mod(p.y - uTime * speed * (0.8 + seed * 0.4), 24.0);
          p.x += uSnow * sin(uTime * 0.9 + seed * 20.0) * 0.6;
          // Wrap the 40 m box around the camera so drops never run out
          p.xz = mod(p.xz - uCenter.xz + 20.0, 40.0) - 20.0 + uCenter.xz;
          p.y += uCenter.y - 8.0;
          vAlpha = step(seed, uAmount);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = uSize * mix(1.0, 1.8, uSnow) * (30.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uSnow;
        varying float vAlpha;
        void main() {
          if (vAlpha < 0.5) discard;
          vec2 d = gl_PointCoord - 0.5;
          float a = uSnow > 0.5
            ? smoothstep(0.5, 0.2, length(d))
            : smoothstep(0.12, 0.0, abs(d.x)) * smoothstep(0.5, 0.1, abs(d.y));
          if (a < 0.05) discard;
          gl_FragColor = vec4(uSnow > 0.5 ? vec3(1.0) : vec3(0.75, 0.85, 0.95), a * (uSnow > 0.5 ? 0.9 : 0.55));
        }`,
    });
    this.precip = new THREE.Points(geo, this.precipMat);
    this.precip.frustumCulled = false;
    this.precip.visible = false;
    scene.add(this.precip);
  }

  public setWeather(type: WeatherType): void {
    this.weather = type;
  }

  /** Readable clock string "HH:MM". */
  public getClockLabel(): string {
    const h = Math.floor(worldSettings.timeOfDay);
    const m = Math.floor((worldSettings.timeOfDay - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  public isNight(): boolean {
    return worldSettings.timeOfDay < 6 || worldSettings.timeOfDay > 20;
  }

  public update(dt: number, cameraPos: THREE.Vector3): void {
    // Clock
    if (worldSettings.secondsPerHour > 0) {
      worldSettings.timeOfDay = (worldSettings.timeOfDay + dt / worldSettings.secondsPerHour) % 24;
    }
    const t = worldSettings.timeOfDay;

    // Ease weather parameters toward the target profile (~3 s transition)
    const p = PROFILES[this.weather];
    const k = 1 - Math.exp(-dt * 0.8);
    const cur = this.current;
    cur.light += (p.light - cur.light) * k;
    cur.fog += (p.fog - cur.fog) * k;
    cur.amount += (p.amount - cur.amount) * k;
    cur.tint.lerp(p.tint, k);
    this.rainIntensity = p.precipitation === 'rain' ? cur.amount : cur.amount * 0.2;

    // Sun path: rises in the east at 6, sets in the west at 18
    const dayPhase = ((t - 6) / 12) * Math.PI;
    const elevation = Math.sin(dayPhase);
    const daylight = THREE.MathUtils.smoothstep(elevation, -0.15, 0.25);
    this.sun.position.set(cameraPos.x + Math.cos(dayPhase) * 60, cameraPos.y + Math.max(elevation, 0.15) * 80, cameraPos.z + 25);
    this.sun.target.position.copy(cameraPos);
    const warm = 1 - THREE.MathUtils.smoothstep(elevation, 0.1, 0.5);
    this.sun.color.setRGB(1, 1 - warm * 0.3, 1 - warm * 0.55);

    // Lightning flashes during storms
    if (this.weather === 'storm') {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.flash = 1;
        this.lightningTimer = 5 + Math.random() * 9;
      }
    }
    this.flash = Math.max(0, this.flash - dt * 3);

    this.sun.intensity = 1.35 * daylight * cur.light + this.flash * 2;
    this.ambient.intensity = 0.22 + 0.4 * daylight * (0.6 + cur.light * 0.4) + this.flash;
    this.hemi.intensity = 0.15 + 0.45 * daylight;
    this.hemi.color.setHex(daylight > 0.3 ? 0xe0f2fe : 0x5a6aa0);

    // Sky = time-of-day key colour x weather tint; fog matches the horizon
    this.sampleSky(t, this.sky).multiply(cur.tint);
    if (this.flash > 0) this.sky.lerp(WeatherSystem._c.setRGB(1, 1, 1), this.flash * 0.5);
    this.fog.color.copy(this.sky);
    this.fog.density = cur.fog;

    // Precipitation
    const u = this.precipMat.uniforms;
    u.uTime.value += dt;
    u.uCenter.value.copy(cameraPos);
    u.uAmount.value = cur.amount;
    u.uSnow.value = p.precipitation === 'snow' ? 1 : p.precipitation === 'rain' ? 0 : u.uSnow.value;
    this.precip.visible = cur.amount > 0.02;
  }

  private sampleSky(hour: number, out: THREE.Color): THREE.Color {
    for (let i = 0; i < SKY_KEYS.length - 1; i++) {
      const [h0, c0] = SKY_KEYS[i];
      const [h1, c1] = SKY_KEYS[i + 1];
      if (hour >= h0 && hour <= h1) {
        const f = (hour - h0) / (h1 - h0);
        return out.copy(WeatherSystem._c.setHex(c0)).lerp(WeatherSystem._c2.setHex(c1), f);
      }
    }
    return out.setHex(SKY_KEYS[0][1]);
  }
}
