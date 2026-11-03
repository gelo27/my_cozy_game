import * as THREE from 'three';

export interface CheckerTextureOptions {
  primaryColor?: string;
  secondaryColor?: string;
  gridLineColor?: string;
  gridLineWidth?: number;
  size?: number;
  tiles?: number;
  repeatU?: number;
  repeatV?: number;
}

export class TextureGenerator {
  private static textureCache: Map<string, THREE.CanvasTexture> = new Map();

  /**
   * Creates or retrieves a cached high-quality procedural checkerboard texture
   */
  public static createCheckerTexture(options: CheckerTextureOptions = {}): THREE.CanvasTexture {
    const isMobile = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
    const primaryColor = options.primaryColor ?? '#334155'; // Slate 700
    const secondaryColor = options.secondaryColor ?? '#1e293b'; // Slate 800
    const gridLineColor = options.gridLineColor ?? '#475569'; // Slate 600
    const gridLineWidth = options.gridLineWidth ?? 2;
    const size = options.size ?? (isMobile ? 256 : 512);
    const tiles = options.tiles ?? 8;
    const repeatU = options.repeatU ?? 1;
    const repeatV = options.repeatV ?? 1;

    const cacheKey = `${primaryColor}_${secondaryColor}_${gridLineColor}_${tiles}_${repeatU}_${repeatV}_${size}`;
    if (this.textureCache.has(cacheKey)) {
      return this.textureCache.get(cacheKey)!.clone();
    }

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    const tileSize = size / tiles;

    for (let x = 0; x < tiles; x++) {
      for (let y = 0; y < tiles; y++) {
        const isEven = (x + y) % 2 === 0;
        ctx.fillStyle = isEven ? primaryColor : secondaryColor;
        ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);

        // Subgrid / edge accents
        if (gridLineWidth > 0) {
          ctx.strokeStyle = gridLineColor;
          ctx.lineWidth = gridLineWidth;
          ctx.strokeRect(x * tileSize, y * tileSize, tileSize, tileSize);
        }
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatU, repeatV);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = isMobile ? 1 : 2;
    texture.needsUpdate = true;

    this.textureCache.set(cacheKey, texture);
    return texture;
  }

  /**
   * Creates distinct materials with thematic checker textures for different playground zones
   */
  public static createZoneMaterial(type: 'floor' | 'ramp' | 'stairs' | 'obstacle' | 'platform' | 'accent' | 'pushable'): THREE.MeshLambertMaterial {
    switch (type) {
      case 'floor':
        return new THREE.MeshLambertMaterial({
          map: this.createCheckerTexture({
            primaryColor: '#e2e8f0', // Light slate 200
            secondaryColor: '#cbd5e1', // Slate 300
            gridLineColor: '#94a3b8',
            tiles: 4,
            repeatU: 32,
            repeatV: 32,
          }),
        });

      case 'ramp':
        return new THREE.MeshLambertMaterial({
          map: this.createCheckerTexture({
            primaryColor: '#fde047', // Amber/yellow checker for slope testing
            secondaryColor: '#ca8a04',
            gridLineColor: '#a16207',
            tiles: 4,
            repeatU: 2,
            repeatV: 4,
          }),
        });

      case 'stairs':
        return new THREE.MeshLambertMaterial({
          map: this.createCheckerTexture({
            primaryColor: '#38bdf8', // Sky blue
            secondaryColor: '#0284c7',
            gridLineColor: '#0369a1',
            tiles: 2,
            repeatU: 1,
            repeatV: 1,
          }),
        });

      case 'obstacle':
        return new THREE.MeshLambertMaterial({
          map: this.createCheckerTexture({
            primaryColor: '#fb7185', // Coral/rose
            secondaryColor: '#e11d48',
            gridLineColor: '#be123c',
            tiles: 4,
            repeatU: 2,
            repeatV: 2,
          }),
        });

      case 'platform':
        return new THREE.MeshLambertMaterial({
          map: this.createCheckerTexture({
            primaryColor: '#4ade80', // Emerald green
            secondaryColor: '#16a34a',
            gridLineColor: '#15803d',
            tiles: 4,
            repeatU: 3,
            repeatV: 3,
          }),
        });

      case 'pushable':
        return new THREE.MeshLambertMaterial({
          map: this.createCheckerTexture({
            primaryColor: '#c084fc', // Purple dynamic prop
            secondaryColor: '#9333ea',
            gridLineColor: '#7e22ce',
            tiles: 2,
            repeatU: 1,
            repeatV: 1,
          }),
        });

      case 'accent':
      default:
        return new THREE.MeshLambertMaterial({
          map: this.createCheckerTexture({
            primaryColor: '#f1f5f9',
            secondaryColor: '#e2e8f0',
            gridLineColor: '#cbd5e1',
            tiles: 4,
            repeatU: 2,
            repeatV: 2,
          }),
        });
    }
  }
}
