import * as THREE from 'three';

export type EmoteKind = 'alert' | 'question' | 'sweat' | 'star' | 'angry' | 'heart';

const textures = new Map<EmoteKind, THREE.Texture>();
const materials = new Map<EmoteKind, THREE.SpriteMaterial>();

function draw(kind: EmoteKind): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const bubble = (fill: string) => {
    g.fillStyle = fill;
    g.strokeStyle = '#3b2a1a';
    g.lineWidth = 4;
    g.beginPath();
    g.arc(32, 30, 24, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  };
  const glyph = (text: string, color: string, size = 38) => {
    g.font = `900 ${size}px sans-serif`;
    g.fillStyle = color;
    g.fillText(text, 32, 32);
  };
  if (kind === 'alert') {
    bubble('#ffe14d');
    glyph('!', '#d7263d');
  } else if (kind === 'question') {
    bubble('#ffffff');
    glyph('?', '#3a7bd5');
  } else if (kind === 'angry') {
    bubble('#ff7a59');
    glyph('!!', '#ffffff', 30);
  } else if (kind === 'heart') {
    glyph('❤', '#ff4d7a', 44);
  } else if (kind === 'sweat') {
    g.fillStyle = '#7cc8ff';
    g.strokeStyle = '#2a6aa3';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(32, 8);
    g.quadraticCurveTo(52, 38, 32, 54);
    g.quadraticCurveTo(12, 38, 32, 8);
    g.fill();
    g.stroke();
  } else if (kind === 'star') {
    g.fillStyle = '#ffd84a';
    g.strokeStyle = '#a36a00';
    g.lineWidth = 3;
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 11 : 26;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A shared, always-on-top sprite material for one emote (built on first use). */
export function emoteMaterial(kind: EmoteKind): THREE.SpriteMaterial {
  let m = materials.get(kind);
  if (!m) {
    let tex = textures.get(kind);
    if (!tex) textures.set(kind, (tex = draw(kind)));
    m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
    materials.set(kind, m);
  }
  return m;
}

/** One emote bubble slot above a critter: shows a kind for a while, pops in with a little bounce. */
export class EmoteBubble {
  public readonly sprite: THREE.Sprite;
  private kind: EmoteKind | null = null;
  private timer = 0;
  private age = 0;

  constructor(parent: THREE.Object3D, private readonly height: number, private readonly size = 0.42) {
    this.sprite = new THREE.Sprite(emoteMaterial('alert'));
    this.sprite.visible = false;
    this.sprite.renderOrder = 10;
    this.sprite.position.y = height;
    parent.add(this.sprite);
  }

  public show(kind: EmoteKind, seconds: number): void {
    if (this.kind !== kind) this.age = 0;
    this.kind = kind;
    this.timer = seconds;
    this.sprite.material = emoteMaterial(kind);
    this.sprite.visible = true;
  }

  public hide(): void {
    this.kind = null;
    this.timer = 0;
    this.sprite.visible = false;
  }

  public get current(): EmoteKind | null {
    return this.kind;
  }

  public update(dt: number): void {
    if (!this.kind) return;
    this.timer -= dt;
    this.age += dt;
    if (this.timer <= 0) {
      this.hide();
      return;
    }
    // Pop in: overshoot then settle
    const pop = Math.min(1, this.age * 8);
    const s = this.size * (pop < 1 ? pop * 1.25 : 1 + Math.sin(this.age * 6) * 0.04);
    this.sprite.scale.set(s, s, s);
    this.sprite.position.y = this.height + (this.kind === 'sweat' ? -this.age * 0.15 % 0.2 : Math.sin(this.age * 5) * 0.03);
  }
}

/** Blob shadow under critters (one shared texture). */
let shadowTex: THREE.Texture | null = null;
export function blobShadowMaterial(): THREE.MeshBasicMaterial {
  if (!shadowTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(0,0,0,0.45)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    shadowTex = new THREE.CanvasTexture(c);
  }
  return new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
}

const SHADOW_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
let sharedShadowMat: THREE.MeshBasicMaterial | null = null;
export function makeBlobShadow(size: number): THREE.Mesh {
  if (!sharedShadowMat) sharedShadowMat = blobShadowMaterial();
  const m = new THREE.Mesh(SHADOW_GEO, sharedShadowMat);
  m.scale.set(size, 1, size);
  m.renderOrder = 1;
  m.userData.shared = true;
  return m;
}
