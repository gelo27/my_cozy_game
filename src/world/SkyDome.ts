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
        uTime: { value: 0 },
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
        uniform float uCover, uDay, uNight, uFlash, uTime;
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

        void main() {
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
              float tw = 0.55 + 0.45 * sin(uTime * (1.5 + hs * 40.0) + hs * 90.0);
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
            col = mix(col, cc, dens * 0.93);
          }

          col += vec3(0.75, 0.8, 1.0) * uFlash * 0.55;
          // Below the horizon: plain horizon colour (matches the fog)
          col = mix(uHorizon, col, smoothstep(-0.04, 0.02, h));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
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
  }
}
