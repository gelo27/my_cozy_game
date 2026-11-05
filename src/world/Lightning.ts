import * as THREE from 'three';

/**
 * Ground lightning strikes during storms: a warning, the bolt, sparks and a scorch mark.
 *
 * 1. Warning (WARN s): blue motes rise from the spot where the bolt will land and pulse faster
 *    and faster, so the player can see it coming and step away.
 * 2. Strike: a jagged bolt from the clouds (midpoint displacement, two side branches), drawn as
 *    camera-facing ribbons — a thin white core and a wide soft glow, blue up high and warm near
 *    the ground. It flickers in three pulses and fades out within a second, drifting apart a
 *    little. A bright disc lights up the ground around the impact.
 * 3. Sparks burst out in a hemisphere and fall under gravity; a dark scorch mark that follows the
 *    ground slowly fades away.
 * Everything is additive with no depth writes, needs no bloom, and exists only while a strike
 * is alive (a few hundred vertices, rebuilt on the CPU per frame).
 */

const WARN = 2.6;
const BOLT_LIFE = 0.95;
const SPARK_COUNT = 72;
const MOTE_COUNT = 28;
const SCORCH_LIFE = 28;
const SCORCH_RADIUS = 1.6;

type HeightFn = (x: number, z: number) => number;

interface Strike {
  pos: THREE.Vector3;
  t: number; // seconds since the warning began
  struck: boolean;
  paths: THREE.Vector3[][];
  bolt: THREE.Mesh;
  glow: THREE.Mesh;
  motes: THREE.Points;
  sparks: THREE.Points;
  sparkVel: Float32Array;
  sparkLife: Float32Array;
  scorch: THREE.Mesh;
  ground: THREE.Mesh;
}

const ribbonMaterial = (core: boolean) =>
  new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aSide;
      attribute float aHeight;
      varying float vSide;
      varying float vHeight;
      void main() {
        vSide = aSide;
        vHeight = aHeight;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uI;
      varying float vSide;
      varying float vHeight;
      void main() {
        float a = 1.0 - abs(vSide);
        ${core ? 'a = smoothstep(0.0, 0.6, a);' : 'a = a * a * a;'}
        // Blue up in the clouds, warm where it hits the ground
        vec3 col = mix(vec3(1.0, 0.62, 0.38), vec3(0.55, 0.7, 1.0), smoothstep(0.0, 6.0, vHeight));
        ${core ? 'col = mix(col, vec3(1.0), 0.75);' : ''}
        gl_FragColor = vec4(col * a * uI, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });

const pointsMaterial = (color: THREE.Color, size: number) =>
  new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, uSize: { value: size }, uScale: { value: 600 } },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      uniform float uSize;
      uniform float uScale;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * uScale / max(-mv.z, 0.5);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = (1.0 - smoothstep(0.2, 1.0, d)) * vAlpha;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
  });

export class LightningStrikes {
  /** Called at the moment a bolt lands (flash, thunder). */
  public onStrike: ((pos: THREE.Vector3) => void) | null = null;

  private readonly group = new THREE.Group();
  private readonly strikes: Strike[] = [];
  private readonly scorches: { mesh: THREE.Mesh; age: number }[] = [];
  private readonly moteMat = pointsMaterial(new THREE.Color(0.55, 0.75, 2.0), 0.2);
  private readonly sparkMat = pointsMaterial(new THREE.Color(1.6, 1.1, 0.7), 0.1);
  private readonly groundMat = new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform float uI;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float a = pow(max(1.0 - d, 0.0), 2.0) * uI;
        gl_FragColor = vec4(vec3(0.75, 0.82, 1.0) * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();

  constructor(scene: THREE.Scene, private readonly heightAt: HeightFn) {
    this.group.name = 'Lightning';
    scene.add(this.group);
  }

  /** True while a warning or bolt is under way. */
  public get busy(): boolean {
    return this.strikes.length > 0;
  }

  /** Starts the warning at ground point (x, y, z); the bolt lands WARN seconds later. */
  public schedule(x: number, y: number, z: number): void {
    const pos = new THREE.Vector3(x, y, z);
    const mk = (n: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n), 1));
      return g;
    };
    const motes = new THREE.Points(mk(MOTE_COUNT), this.moteMat);
    const sparks = new THREE.Points(mk(SPARK_COUNT), this.sparkMat);
    motes.frustumCulled = sparks.frustumCulled = false;
    sparks.visible = false;

    // Mote start spots: a disc around the target, each with its own rise speed and phase
    const mp = motes.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < MOTE_COUNT; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 2.2;
      mp.setXYZ(i, x + Math.cos(a) * r, Math.random(), z + Math.sin(a) * r);
    }
    motes.userData.seed = Float32Array.from({ length: MOTE_COUNT }, () => Math.random());

    const bolt = new THREE.Mesh(new THREE.BufferGeometry(), ribbonMaterial(true));
    const glow = new THREE.Mesh(new THREE.BufferGeometry(), ribbonMaterial(false));
    bolt.frustumCulled = glow.frustumCulled = false;
    bolt.visible = glow.visible = false;
    bolt.renderOrder = glow.renderOrder = 5;

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(9, 9).rotateX(-Math.PI / 2), this.groundMat.clone());
    ground.position.set(x, y + 0.15, z);
    ground.visible = false;

    const scorch = this.buildScorch(x, z);
    scorch.visible = false;

    this.group.add(motes, sparks, bolt, glow, ground, scorch);
    this.strikes.push({
      pos,
      t: 0,
      struck: false,
      paths: this.buildPaths(pos),
      bolt,
      glow,
      motes,
      sparks,
      sparkVel: new Float32Array(SPARK_COUNT * 3),
      sparkLife: new Float32Array(SPARK_COUNT),
      scorch,
      ground,
    });
  }

  public update(dt: number, camera: THREE.Camera, viewportHeight: number): void {
    this.moteMat.uniforms.uScale.value = this.sparkMat.uniforms.uScale.value = viewportHeight * 0.9;
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.t += dt;
      this.updateMotes(s);
      if (!s.struck && s.t >= WARN) this.land(s);
      if (s.struck) {
        const bt = s.t - WARN;
        this.updateBolt(s, bt, camera);
        this.updateSparks(s, dt);
        (s.ground.material as THREE.ShaderMaterial).uniforms.uI.value = Math.max(0, 1 - bt / 0.6) * 1.4;
        if (bt > 2.2) {
          this.disposeStrike(s);
          this.strikes.splice(i, 1);
        }
      }
    }
    for (let i = this.scorches.length - 1; i >= 0; i--) {
      const sc = this.scorches[i];
      sc.age += dt;
      (sc.mesh.material as THREE.ShaderMaterial).uniforms.uFade.value = 1 - THREE.MathUtils.smoothstep(sc.age, SCORCH_LIFE * 0.5, SCORCH_LIFE);
      if (sc.age >= SCORCH_LIFE) {
        this.group.remove(sc.mesh);
        sc.mesh.geometry.dispose();
        (sc.mesh.material as THREE.Material).dispose();
        this.scorches.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------- phases

  private land(s: Strike): void {
    s.struck = true;
    s.motes.visible = false;
    s.bolt.visible = s.glow.visible = s.sparks.visible = s.ground.visible = true;
    // Sparks: a hemisphere burst from the impact
    const p = s.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < SPARK_COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = 0.25 + Math.random() * 0.75;
      const sp = 3 + Math.random() * 6;
      const h = Math.sqrt(1 - up * up);
      s.sparkVel[i * 3] = Math.cos(a) * h * sp;
      s.sparkVel[i * 3 + 1] = up * sp;
      s.sparkVel[i * 3 + 2] = Math.sin(a) * h * sp;
      s.sparkLife[i] = 0.6 + Math.random() * 1.0;
      p.setXYZ(i, s.pos.x, s.pos.y + 0.1, s.pos.z);
    }
    p.needsUpdate = true;
    // The scorch mark outlives the strike
    s.scorch.visible = true;
    this.group.remove(s.scorch);
    this.group.add(s.scorch);
    this.scorches.push({ mesh: s.scorch, age: 0 });
    this.onStrike?.(s.pos);
  }

  private updateMotes(s: Strike): void {
    if (s.struck) return;
    const k = s.t / WARN;
    const p = s.motes.geometry.getAttribute('position') as THREE.BufferAttribute;
    const al = s.motes.geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    const seed = s.motes.userData.seed as Float32Array;
    // Pulses quicken towards the strike
    const pulse = 0.55 + 0.45 * Math.sin(s.t * (5 + k * k * 22));
    for (let i = 0; i < MOTE_COUNT; i++) {
      const life = (s.t * (0.35 + seed[i] * 0.4) + seed[i]) % 1;
      p.setY(i, s.pos.y + life * 1.8);
      al.setX(i, Math.sin(life * Math.PI) * Math.min(1, s.t * 2) * pulse * (0.6 + k * 0.8));
    }
    p.needsUpdate = al.needsUpdate = true;
  }

  private updateSparks(s: Strike, dt: number): void {
    const p = s.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    const al = s.sparks.geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    const bt = s.t - WARN;
    for (let i = 0; i < SPARK_COUNT; i++) {
      const v = s.sparkVel;
      v[i * 3 + 1] -= 9.8 * dt;
      const drag = Math.exp(-dt * 1.5);
      v[i * 3] *= drag;
      v[i * 3 + 2] *= drag;
      let y = p.getY(i) + v[i * 3 + 1] * dt;
      if (y < s.pos.y + 0.03) {
        y = s.pos.y + 0.03;
        v[i * 3 + 1] *= -0.3;
      }
      p.setXYZ(i, p.getX(i) + v[i * 3] * dt, y, p.getZ(i) + v[i * 3 + 2] * dt);
      al.setX(i, Math.max(0, 1 - bt / s.sparkLife[i]) * 1.5);
    }
    p.needsUpdate = al.needsUpdate = true;
  }

  /** Three flicker pulses, the bolt thinning and drifting apart as it fades. */
  private updateBolt(s: Strike, bt: number, camera: THREE.Camera): void {
    const pulse = (t0: number, k: number) => (bt >= t0 ? Math.exp(-(bt - t0) * k) : 0);
    const I = Math.max(pulse(0, 7), pulse(0.11, 9) * 0.85, pulse(0.27, 5) * 0.7) * (1 - THREE.MathUtils.smoothstep(bt, BOLT_LIFE * 0.6, BOLT_LIFE));
    (s.bolt.material as THREE.ShaderMaterial).uniforms.uI.value = I * 2.2;
    (s.glow.material as THREE.ShaderMaterial).uniforms.uI.value = I * 1.2;
    if (bt > BOLT_LIFE) {
      s.bolt.visible = s.glow.visible = false;
      return;
    }
    const drift = 1 + (1 - Math.exp(-bt * 4)) * 0.6;
    const thin = 1 - THREE.MathUtils.smoothstep(bt, 0, BOLT_LIFE) * 0.6;
    this.writeRibbons(s.bolt.geometry, s, camera, 0.09 * thin, drift);
    this.writeRibbons(s.glow.geometry, s, camera, 0.9 * thin, drift);
  }

  // ---------------------------------------------------------------- geometry

  /** Main channel from the clouds down to the impact plus two branches. */
  private buildPaths(pos: THREE.Vector3): THREE.Vector3[][] {
    const top = new THREE.Vector3(pos.x + (Math.random() - 0.5) * 14, pos.y + 55, pos.z + (Math.random() - 0.5) * 14);
    const main = this.jagged(top, pos.clone(), 5, 7);
    const paths = [main];
    for (let b = 0; b < 2; b++) {
      const i = 4 + Math.floor(Math.random() * (main.length * 0.45));
      const from = main[i];
      const len = 6 + Math.random() * 12;
      const dir = new THREE.Vector3(Math.random() - 0.5, -0.9 - Math.random() * 0.6, Math.random() - 0.5).normalize();
      paths.push(this.jagged(from.clone(), from.clone().addScaledVector(dir, len), 3, len * 0.35));
    }
    return paths;
  }

  /** Midpoint displacement: each level halves the segments and their sideways offset. */
  private jagged(a: THREE.Vector3, b: THREE.Vector3, levels: number, amp: number): THREE.Vector3[] {
    let pts = [a, b];
    for (let l = 0; l < levels; l++) {
      const next: THREE.Vector3[] = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const m = pts[i - 1].clone().lerp(pts[i], 0.4 + Math.random() * 0.2);
        m.x += (Math.random() - 0.5) * amp;
        m.z += (Math.random() - 0.5) * amp;
        m.y += (Math.random() - 0.5) * amp * 0.3;
        next.push(m, pts[i]);
      }
      pts = next;
      amp *= 0.5;
    }
    return pts;
  }

  /** Camera-facing strips along every path (branches thinner), as plain triangles. */
  private writeRibbons(geo: THREE.BufferGeometry, s: Strike, camera: THREE.Camera, width: number, drift: number): void {
    let segs = 0;
    for (const path of s.paths) segs += path.length - 1;
    const verts = segs * 6;
    let pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos || pos.count !== verts) {
      pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
      geo.setAttribute('position', pos);
      geo.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array(verts), 1));
      geo.setAttribute('aHeight', new THREE.BufferAttribute(new Float32Array(verts), 1));
      const side = geo.getAttribute('aSide') as THREE.BufferAttribute;
      for (let q = 0; q < segs; q++) {
        const o = q * 6;
        side.setX(o, -1); side.setX(o + 1, 1); side.setX(o + 2, -1);
        side.setX(o + 3, -1); side.setX(o + 4, 1); side.setX(o + 5, 1);
      }
    }
    const hAttr = geo.getAttribute('aHeight') as THREE.BufferAttribute;
    const cam = camera.position;
    const c = s.pos;
    const P = (v: THREE.Vector3, out: THREE.Vector3) =>
      out.set(c.x + (v.x - c.x) * drift, v.y, c.z + (v.z - c.z) * drift);
    let q = 0;
    s.paths.forEach((path, pi) => {
      const w0 = pi === 0 ? width : width * 0.55;
      for (let i = 1; i < path.length; i++, q++) {
        const a = P(path[i - 1], this.tmpA);
        const b = P(path[i], this.tmpB);
        // Side vector: perpendicular to the segment and to the view direction
        const side = this.tmpC.subVectors(b, a).cross(cam.clone().sub(a)).normalize();
        const taperA = pi === 0 ? 1 : 1 - (i - 1) / (path.length - 1);
        const taperB = pi === 0 ? 1 : 1 - i / (path.length - 1);
        const wa = w0 * Math.max(taperA, 0.15), wb = w0 * Math.max(taperB, 0.15);
        const o = q * 6;
        pos.setXYZ(o, a.x - side.x * wa, a.y - side.y * wa, a.z - side.z * wa);
        pos.setXYZ(o + 1, a.x + side.x * wa, a.y + side.y * wa, a.z + side.z * wa);
        pos.setXYZ(o + 2, b.x - side.x * wb, b.y - side.y * wb, b.z - side.z * wb);
        pos.setXYZ(o + 3, b.x - side.x * wb, b.y - side.y * wb, b.z - side.z * wb);
        pos.setXYZ(o + 4, a.x + side.x * wa, a.y + side.y * wa, a.z + side.z * wa);
        pos.setXYZ(o + 5, b.x + side.x * wb, b.y + side.y * wb, b.z + side.z * wb);
        const ha = a.y - c.y, hb = b.y - c.y;
        hAttr.setX(o, ha); hAttr.setX(o + 1, ha); hAttr.setX(o + 2, hb);
        hAttr.setX(o + 3, hb); hAttr.setX(o + 4, ha); hAttr.setX(o + 5, hb);
      }
    });
    pos.needsUpdate = true;
    hAttr.needsUpdate = true;
  }

  /** A dark, ragged disc draped over the ground (a small grid following the terrain). */
  private buildScorch(x: number, z: number): THREE.Mesh {
    const R = SCORCH_RADIUS;
    const g = new THREE.PlaneGeometry(R * 2, R * 2, 8, 8).rotateX(-Math.PI / 2);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setY(i, this.heightAt(x + p.getX(i), z + p.getZ(i)) + 0.04);
    g.translate(x, 0, z);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uFade: { value: 1 }, uSeed: { value: Math.random() * 100 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform float uFade;
        uniform float uSeed;
        varying vec2 vUv;
        void main() {
          vec2 d = vUv - 0.5;
          float ang = atan(d.y, d.x);
          // Ragged rim: a few sine lobes around the circle
          float rim = 0.36 + 0.06 * sin(ang * 5.0 + uSeed) + 0.04 * sin(ang * 11.0 + uSeed * 2.3);
          float a = 1.0 - smoothstep(rim * 0.55, rim, length(d));
          gl_FragColor = vec4(vec3(0.05, 0.04, 0.035), a * 0.75 * uFade);
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = 1;
    return m;
  }

  private disposeStrike(s: Strike): void {
    for (const o of [s.bolt, s.glow, s.motes, s.sparks, s.ground]) {
      this.group.remove(o);
      o.geometry.dispose();
      if (o.material !== this.moteMat && o.material !== this.sparkMat) (o.material as THREE.Material).dispose();
    }
  }
}
