import * as THREE from 'three';
import { isMobileDevice } from './WorldSettings';

export interface SkyParams {
  zenith: THREE.Color;
  horizon: THREE.Color;
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  sunColor: THREE.Color;
  cloudLit: THREE.Color;
  cloudShade: THREE.Color;
  /** 0..1 share of the sky covered by clouds. */
  cover: number;
  day: number;
  night: number;
  flash: number;
  /** 0..1 how much moonlight reaches the clouds (low under thick overcast, rain and storms). */
  moonCloud: number;
  /** 0..1 strength of the rainbow opposite the sun (after a daytime rain), 0 skips it entirely. */
  rainbow: number;
}

/**
 * Procedural sky in a single draw call: gradient, sun, moon, twinkling stars and drifting fBm clouds.
 *
 * Drawn first with depth test/write off, so it costs exactly one pass over the visible sky pixels and
 * nothing behind geometry. Everything is analytic — no textures. Cloud octaves drop on mobile.
 */
export class SkyDome {
  public readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene) {
    const octaves = isMobileDevice() ? 3 : 4;
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uSunColor: { value: new THREE.Color() },
        uCloudLit: { value: new THREE.Color() },
        uCloudShade: { value: new THREE.Color() },
        uCover: { value: 0.3 },
        uDay: { value: 1 },
        uNight: { value: 0 },
        uFlash: { value: 0 },
        uMoonCloud: { value: 1 },
        uRainbow: { value: 0 },
        uMeteorA: { value: new THREE.Vector3(0, 1, 0) },
        uMeteorB: { value: new THREE.Vector3(0, 1, 0) },
        uMeteorT: { value: 0 },
        uMeteorAmp: { value: 0 },
        uTime: { value: 0 },
        uFlatColor: { value: new THREE.Color() },
        uFlat: { value: 0 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        #define CLOUD_OCTAVES ${octaves}
        uniform vec3 uZenith, uHorizon, uSunDir, uMoonDir, uSunColor, uCloudLit, uCloudShade;
        uniform float uCover, uDay, uNight, uFlash, uMoonCloud, uTime, uRainbow;
        // Shooting star: path from uMeteorA to uMeteorB (unit dirs), uMeteorT = 0..1 progress
        uniform vec3 uMeteorA, uMeteorB;
        uniform float uMeteorT, uMeteorAmp;
        // Underground / under water: the whole sky turns this colour (the fog's), no sun or clouds
        uniform vec3 uFlatColor;
        uniform float uFlat;
        varying vec3 vDir;

        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        float hash13(vec3 p3) {
          p3 = fract(p3 * 0.1031);
          p3 += dot(p3, p3.zyx + 31.32);
          return fract((p3.x + p3.y) * p3.z);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
                     mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < CLOUD_OCTAVES; i++) {
            v += a * vnoise(p);
            p = p * 2.07 + vec2(17.1, 9.3);
            a *= 0.5;
          }
          return v;
        }

        // t: 0 = violet (inner edge), 1 = red (outer edge)
        vec3 spectrum(float t) {
          float hue = (1.0 - t) * 0.78;
          return clamp(abs(mod(hue * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
        }

        void main() {
          if (uFlat > 0.999) {
            // Fully underground: just the fog colour (skips the clouds and stars), converted the way
            // three's fog lands on the walls: output colour space, no tone mapping
            gl_FragColor = vec4(uFlatColor, 1.0);
            #include <colorspace_fragment>
            return;
          }
          vec3 d = normalize(vDir);
          float h = d.y;

          // Gradient: horizon colour equals the fog colour, so terrain melts into the sky
          vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));

          // Stars (hash per 3D cell on a sphere), twinkling, fade toward the horizon
          if (uNight > 0.01 && h > 0.0) {
            vec3 sp = d * 160.0;
            vec3 cell = floor(sp);
            float hs = hash13(cell);
            if (hs > 0.975) {
              vec3 c = cell + 0.5 + (vec3(hash13(cell + 1.7), hash13(cell + 3.1), hash13(cell + 5.9)) - 0.5) * 0.5;
              float star = smoothstep(0.42, 0.0, length(sp - c));
              // Slow, gentle twinkle: each star gets its own rate of 0.4..1.6 rad/s from a separate hash
              float rate = 0.4 + hash13(cell + 7.3) * 1.2;
              float tw = 0.7 + 0.3 * sin(uTime * rate + hs * 90.0);
              vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), hash13(cell + 9.2));
              col += tint * star * tw * uNight * smoothstep(0.02, 0.3, h) * (0.6 + (hs - 0.975) * 40.0);
            }
          }

          // Moon: disc with soft craters + cool glow
          float md = dot(d, uMoonDir);
          if (uNight > 0.01) {
            col += vec3(0.55, 0.65, 1.0) * (pow(max(md, 0.0), 300.0) * 0.35 + pow(max(md, 0.0), 16.0) * 0.07) * uNight;
            float disc = smoothstep(0.99945, 0.99962, md);
            if (disc > 0.0) {
              vec3 mu = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0001)));
              vec3 mv = cross(mu, uMoonDir);
              vec2 mp = vec2(dot(d, mu), dot(d, mv)) * 160.0;
              float craters = vnoise(mp * 1.3) * 0.6 + vnoise(mp * 3.1) * 0.4;
              vec3 moonCol = vec3(0.93, 0.94, 1.0) * (0.78 + 0.22 * smoothstep(0.3, 0.7, craters));
              col = mix(col, moonCol, disc * uNight);
            }
          }

          // Shooting star: a short bright streak whose head runs along the path, tail fading out
          // behind it. Drawn before the clouds, so a cloud in front hides it.
          if (uMeteorAmp > 0.001 && h > 0.0) {
            vec3 head = normalize(mix(uMeteorA, uMeteorB, uMeteorT));
            vec3 tail = normalize(mix(uMeteorA, uMeteorB, max(uMeteorT - 0.3, 0.0)));
            vec3 pa = d - tail, ba = head - tail;
            float seg = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
            float dist = length(pa - ba * seg);
            float core = smoothstep(0.0022, 0.0, dist) + smoothstep(0.009, 0.0, dist) * 0.25;
            col += vec3(0.85, 0.92, 1.0) * core * seg * seg * uMeteorAmp * 1.4;
          }

          // Sun: disc + wide warm glow (warmth comes from uSunColor near sunrise/sunset)
          float sd = dot(d, uSunDir);
          float sdp = max(sd, 0.0);
          col += uSunColor * (pow(sdp, 900.0) * 1.5 + pow(sdp, 64.0) * 0.35 + pow(sdp, 6.0) * 0.12) * uDay;
          col = mix(col, vec3(1.0, 0.98, 0.9), smoothstep(0.99955, 0.9997, sd) * uDay);

          // Clouds: a flat layer projected onto the dome, one fBm per pixel
          if (h > 0.0 && uCover > 0.01) {
            vec2 uv = d.xz / (h + 0.18) * 1.5 + vec2(uTime * 0.010, uTime * 0.0035);
            float n = fbm(uv);
            float thr = 1.0 - uCover;
            float dens = smoothstep(thr * 0.75, thr * 0.75 + 0.2, n);
            dens *= smoothstep(0.0, 0.16, h);
            // Fake volume: the two largest octaves sampled a step toward the sun. Where density grows
            // toward the sun the pixel sits on the shadowed side of a puff.
            vec2 toSun = normalize(uSunDir.xz + 1e-4) * 0.12;
            float n2 = vnoise(uv + toSun) * 0.5 + vnoise((uv + toSun) * 2.07 + vec2(17.1, 9.3)) * 0.25;
            float n1 = vnoise(uv) * 0.5 + vnoise(uv * 2.07 + vec2(17.1, 9.3)) * 0.25;
            float lit = clamp(0.6 - (n2 - n1) * 6.0, 0.0, 1.0);
            vec3 cc = mix(uCloudShade, uCloudLit, lit * (1.0 - smoothstep(0.6, 1.0, dens) * 0.35));
            // Thin edges facing the sun get a silver lining
            cc += uSunColor * pow(sdp, 10.0) * (1.0 - dens) * 0.6 * uDay;
            // Moonlight: clouds near the moon glow cool silver, thin edges brightest
            float mdp = max(md, 0.0);
            float moonGlow = pow(mdp, 14.0) * 0.32 + pow(mdp, 90.0) * 0.55;
            float moonUp = smoothstep(-0.05, 0.12, uMoonDir.y) * (1.0 - uDay) * uMoonCloud;
            cc += vec3(0.62, 0.68, 0.85) * moonGlow * moonUp * (0.35 + (1.0 - dens) * 0.65);
            // Opaque once the cloud has some body, so stars and the moon glow don't shine through;
            // only the thin wispy edges stay see-through
            col = mix(col, cc, clamp(dens * 1.6, 0.0, 1.0));
          }

          // Rainbow: one wide, soft-edged arc around the antisolar point (~39.5-44 deg), violet inside,
          // red outside, with a faint glow inside it. A high sun pushes the arc below the horizon by
          // itself. Skipped while uRainbow is 0.
          if (uRainbow > 0.001 && h > -0.02) {
            float ang = acos(clamp(-dot(d, uSunDir), -1.0, 1.0));
            float t1 = (ang - 0.69) / 0.08;
            // Soft bell across the band instead of hard edges
            float b1 = smoothstep(0.0, 0.4, t1) * smoothstep(1.0, 0.6, t1);
            // Saturate: pull the colours away from their grey so the bands stay distinct
            vec3 sc = spectrum(clamp((t1 - 0.15) / 0.62, 0.0, 1.0));
            sc = clamp(mix(vec3(dot(sc, vec3(0.299, 0.587, 0.114))), sc, 1.9), 0.0, 1.0);
            float inside = smoothstep(0.7, 0.45, ang) * 0.035;
            // Uneven brightness along the arc (seamless: noise over the horizontal direction)
            float broken = 0.6 + 0.4 * vnoise(normalize(d.xz + 1e-4) * 2.2 + vec2(uTime * 0.015, 3.7));
            float fade = smoothstep(-0.02, 0.12, h) * uRainbow;
            // Dim the sky under the band a little, then add the colour: pure adding washes out on a
            // bright blue sky, this keeps red, green and violet readable
            float k = b1 * broken * fade;
            col = col * (1.0 - k * 0.3) + sc * k * 0.5 + vec3(inside) * fade;
          }

          col += vec3(0.75, 0.8, 1.0) * uFlash * 0.55;
          // Below the horizon: plain horizon colour (matches the fog)
          col = mix(uHorizon, col, smoothstep(-0.04, 0.02, h));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          gl_FragColor.rgb = mix(gl_FragColor.rgb, linearToOutputTexel(vec4(uFlatColor, 1.0)).rgb, uFlat);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.material);
    this.mesh.name = 'SkyDome';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = true;
    scene.add(this.mesh);
  }

  public update(dt: number, cameraPos: THREE.Vector3, p: SkyParams): void {
    this.mesh.position.copy(cameraPos);
    const u = this.material.uniforms;
    u.uTime.value += dt;
    u.uZenith.value.copy(p.zenith);
    u.uHorizon.value.copy(p.horizon);
    u.uSunDir.value.copy(p.sunDir);
    u.uMoonDir.value.copy(p.moonDir);
    u.uSunColor.value.copy(p.sunColor);
    u.uCloudLit.value.copy(p.cloudLit);
    u.uCloudShade.value.copy(p.cloudShade);
    u.uCover.value = p.cover;
    u.uDay.value = p.day;
    u.uNight.value = p.night;
    u.uFlash.value = p.flash;
    u.uMoonCloud.value = p.moonCloud;
    u.uRainbow.value = p.rainbow;
    this.updateMeteor(dt, p);
  }

  /**
   * Blends the whole sky toward one colour (k 0..1): in a cave the far end of a long tunnel shows
   * the fog colour instead of a bright sky with clouds.
   */
  public setFlat(color: THREE.Color, k: number): void {
    const u = this.material.uniforms;
    (u.uFlatColor.value as THREE.Color).copy(color);
    u.uFlat.value = THREE.MathUtils.clamp(k, 0, 1);
  }

  // Shooting stars: only on clear, dark nights; one at a time, every 6..25 s
  private meteorWait = 6 + Math.random() * 12;
  private meteorAge = -1;
  private meteorDur = 1;
  private meteorAmp = 1;

  private updateMeteor(dt: number, p: SkyParams): void {
    const u = this.material.uniforms;
    const clearNight = p.day < 0.08 && p.cover < 0.45 && p.night > 0.35 && p.flash === 0;
    if (this.meteorAge < 0) {
      u.uMeteorAmp.value = 0;
      if (!clearNight) return;
      this.meteorWait -= dt;
      if (this.meteorWait > 0) return;
      this.meteorWait = 6 + Math.random() * 19;
      // Start somewhere high in the sky, then fall mostly downward along a random heading
      const az = Math.random() * Math.PI * 2;
      const el = 0.45 + Math.random() * 0.6;
      const a = (u.uMeteorA.value as THREE.Vector3).set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
      const side = SkyDome._tmp.set(-a.z, 0, a.x).normalize();
      const down = SkyDome._tmp2.crossVectors(side, a).normalize(); // tangent pointing toward the horizon
      if (down.y > 0) down.negate();
      const sway = (Math.random() - 0.5) * 1.6;
      const len = 0.25 + Math.random() * 0.25;
      (u.uMeteorB.value as THREE.Vector3).copy(a).addScaledVector(down, len).addScaledVector(side, len * sway).normalize();
      this.meteorAge = 0;
      this.meteorDur = 0.55 + Math.random() * 0.6;
      this.meteorAmp = 0.6 + Math.random() * 0.6;
    }
    this.meteorAge += dt;
    const t = this.meteorAge / this.meteorDur;
    if (t >= 1) {
      this.meteorAge = -1;
      u.uMeteorAmp.value = 0;
      return;
    }
    u.uMeteorT.value = t;
    // Quick flare-up, then burns out; also fades if the night stops being clear
    const env = Math.min(1, t * 6) * (1 - t * t);
    u.uMeteorAmp.value = env * this.meteorAmp * (clearNight ? 1 : 0.3);
  }

  private static readonly _tmp = new THREE.Vector3();
  private static readonly _tmp2 = new THREE.Vector3();
}
