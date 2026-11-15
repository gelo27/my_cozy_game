import * as THREE from 'three';

/**
 * Sparks rising from the flames: a fixed pool of points (a few per flame), all moved by the vertex
 * shader from time and per-spark random numbers, so nothing is simulated on the CPU. Each spark
 * loops: it is born in the upper half of the flame, shoots up decelerating as it cools, sways in the
 * hot air and dies out; every loop takes a new random path. One draw call for every fire.
 */
export class FlameSparks {
  private readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly origin: THREE.BufferAttribute;
  private readonly flameSize: THREE.BufferAttribute;

  /** `wind` / `windGlsl`: the flames' shared wind uniforms and their bend function. */
  constructor(
    scene: THREE.Scene,
    private readonly perFlame: number,
    maxFlames: number,
    fade: THREE.Vector2,
    wind: Record<string, THREE.IUniform>,
    windGlsl: string
  ) {
    const count = perFlame * maxFlames;
    const geo = new THREE.BufferGeometry();
    this.origin = new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.flameSize = new THREE.BufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
    const rand = new Float32Array(count * 4);
    for (let i = 0; i < rand.length; i++) rand[i] = Math.random();
    geo.setAttribute('position', this.origin);
    geo.setAttribute('aFlameSize', this.flameSize);
    geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
    geo.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uTime: { value: 0 },
            uScale: { value: 800 },
            uAmount: { value: 0.6 },
            uHeight: { value: 1 },
            uNight: { value: 0 },
            uFade: { value: fade.clone() },
          },
        ]),
        // Shared by reference with the flames
        ...wind,
      },
      vertexShader: SPARK_VERT.replace('#include <wind>', windGlsl),
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      // Premultiplied like the flames: pure glow at night, partly covering the background by day so
      // the sparks still read against bright sky and snow
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.name = 'FlameSparks';
    scene.add(this.points);
  }

  public setViewportHeight(px: number): void {
    this.material.uniforms.uScale.value = px * 0.87;
  }

  /** Writes the flames that get sparks (base position and flame height); `n` of them. */
  public setFlames(flames: readonly { x: number; y: number; z: number; size: number }[], n: number): void {
    const o = this.origin.array as Float32Array;
    const sz = this.flameSize.array as Float32Array;
    let i = 0;
    for (let k = 0; k < n; k++) {
      const f = flames[k];
      for (let j = 0; j < this.perFlame; j++, i++) {
        o[i * 3] = f.x;
        o[i * 3 + 1] = f.y;
        o[i * 3 + 2] = f.z;
        sz[i] = f.size;
      }
    }
    this.points.geometry.setDrawRange(0, i);
    this.origin.needsUpdate = true;
    this.flameSize.needsUpdate = true;
  }

  public update(time: number, night: number, amount: number, height: number): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uNight.value = night;
    u.uAmount.value = amount;
    u.uHeight.value = height;
    this.points.visible = amount > 0.001 && this.points.geometry.drawRange.count > 0;
  }
}

const SPARK_VERT = /* glsl */ `
  attribute float aFlameSize;
  attribute vec4 aRand;
  uniform float uTime, uScale, uAmount, uHeight;
  uniform vec2 uFade;
  varying float vAlpha;
  varying float vLife;
  #include <fog_pars_vertex>
  #include <wind>

  float hash(float n) { return fract(sin(n) * 43758.5453); }

  void main() {
    float s = aFlameSize;
    // Each spark loops with its own period; a new cycle picks a new path
    float period = mix(1.0, 2.2, aRand.y);
    float cycleT = uTime / period + aRand.x * 7.0;
    float cyc = floor(cycleT);
    float life = fract(cycleT);
    float h1 = hash(cyc * 12.9898 + aRand.z * 78.233);
    float h2 = hash(cyc * 39.346 + aRand.w * 11.135);
    float h3 = hash(cyc * 73.156 + aRand.x * 52.235);

    // Only a share of the pool lives this cycle (the amount slider); the rest is parked off screen
    if (h3 > uAmount) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      vLife = 1.0;
      return;
    }

    // Born inside the upper part of the flame
    float ang = h1 * 6.2832;
    float rad = sqrt(h2) * s * 0.22;
    vec3 p = position + vec3(cos(ang) * rad, s * mix(0.35, 0.7, h2), sin(ang) * rad);

    // Shoots up and slows down as it cools
    float rise = s * uHeight * mix(1.3, 2.6, h1);
    float up = 1.0 - (1.0 - life) * (1.0 - life);
    p.y += rise * up;
    // Sways in the hot air, wider the higher it gets, and drifts out a little from the centre
    float sway = s * 0.3 * life;
    p.x += sin(life * 7.0 + h1 * 40.0 + uTime * 1.3) * sway + cos(ang) * s * 0.25 * up;
    p.z += cos(life * 6.0 + h2 * 40.0 + uTime * 1.1) * sway + sin(ang) * s * 0.25 * up;
    // Carried off by the same wind that bends the flame, more the higher they get
    vec2 bend = flameWindBend(position);
    p.xz += bend * s * (up * 2.2 + life * 0.6);

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    float depth = max(-mvPosition.z, 0.05);
    // World size shrinks as it burns out; points below ~1.5 px fade instead of shimmering
    float worldSize = 0.06 * mix(0.6, 1.4, aRand.w) * sqrt(s) * (1.0 - 0.5 * life);
    float px = worldSize * uScale / depth;
    float tiny = clamp(px / 1.5, 0.0, 1.0);
    // Right in front of the camera a spark would become a huge disc: cap it and fade it out
    float huge = 1.0 - smoothstep(14.0, 28.0, px);
    gl_PointSize = clamp(px, 1.5, 28.0);

    float twinkle = 0.65 + 0.35 * sin(uTime * (18.0 + 14.0 * aRand.z) + aRand.x * 60.0);
    float distFade = 1.0 - smoothstep(uFade.x, uFade.y, depth);
    vAlpha = smoothstep(0.0, 0.06, life) * pow(1.0 - life, 1.4) * twinkle * tiny * huge * distFade;
    vLife = life;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const SPARK_FRAG = /* glsl */ `
  uniform float uNight;
  varying float vAlpha;
  varying float vLife;
  #include <fog_pars_fragment>

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = 1.0 - smoothstep(0.2, 1.0, d);
    a *= a * vAlpha;
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        a *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
      #endif
    #endif
    if (a < 0.003) discard;
    // White-yellow when born, orange, then deep red as it cools
    vec3 hot = vec3(1.0, 0.9, 0.55);
    vec3 warm = vec3(1.0, 0.45, 0.08);
    vec3 cool = vec3(0.8, 0.12, 0.02);
    vec3 col = mix(hot, warm, smoothstep(0.0, 0.35, vLife));
    col = mix(col, cool, smoothstep(0.45, 1.0, vLife));
    col *= mix(1.6, 3.0, uNight);
    gl_FragColor = vec4(col * a, a * mix(0.85, 0.1, uNight));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
