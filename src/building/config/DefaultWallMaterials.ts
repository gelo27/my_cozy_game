import * as THREE from 'three';
import { createWainscotTexture } from '../textures/WallpaperTextures';
import { createRoofLapSidingTexture } from '../ProceduralRoofSystem';

/**
 * Default look of an unpainted wall: white lap siding on the outer (+Z, "left") face, like the
 * roof gables, and white wainscoting on the inner (-Z, "right") face. Shared by the wallpaper
 * registry (continuous, confirmed walls) and the per-piece wall templates (walls not yet confirmed).
 */

/** Wallpaper ids the unpainted faces fall back to */
export const DEFAULT_OUTER_WALLPAPER_ID = 'lap_siding_white';
export const DEFAULT_INNER_WALLPAPER_ID = 'wainscot_white_wood';

/** Physical size of one texture repeat, meters (siding: 12.5 cm boards; wainscot: 1 m panel + wall above) */
export const LAP_SIDING_TILE = { width: 1.0, height: 1.0 };
export const WHITE_WAINSCOT_TILE = { width: 2.0, height: 4.0 };

const whiteWainscot = createWainscotTexture({
  upperWallColor: '#f3ede3',
  baseColor: '#f8fafc',
  slatLight: '#ffffff',
  slatDark: '#eef2f6',
  grooveColor: '#cbd5e1',
  grooveShadow: '#94a3b8',
  highlightColor: 'rgba(255, 255, 255, 0.95)',
  chairRailTop: '#ffffff',
  chairRailMid: '#e2e8f0',
  chairRailShadow: 'rgba(51, 65, 85, 0.35)',
  baseboardTop: '#ffffff',
  baseboardMid: '#f1f5f9',
  baseboardBottom: '#cbd5e1',
  grainAlpha: 0.035,
  grainColor: '#94a3b8',
});

export const WHITE_WAINSCOT_MATERIAL = new THREE.MeshLambertMaterial({
  map: whiteWainscot.texture,
});
export const WHITE_WAINSCOT_THUMBNAIL = whiteWainscot.dataUrl;

const sidingTexture = createRoofLapSidingTexture();
export const LAP_SIDING_MATERIAL = new THREE.MeshLambertMaterial({ map: sidingTexture });
export const LAP_SIDING_THUMBNAIL = (sidingTexture.image as HTMLCanvasElement).toDataURL('image/png');

/** Wall edges (top and ends): plain white, matching both faces */
export const WALL_EDGE_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xf1f1f4 });

/** A copy of `mat` whose texture repeats once per `tile` metres on geometry with UVs in metres */
function metricMaterial(mat: THREE.MeshLambertMaterial, tile: { width: number; height: number }): THREE.MeshLambertMaterial {
  const out = mat.clone();
  for (const key of ['map', 'bumpMap'] as const) {
    const tex = mat[key];
    if (!tex) continue;
    const copy = tex.clone();
    copy.wrapS = copy.wrapT = THREE.RepeatWrapping;
    copy.repeat.set(1 / tile.width, 1 / tile.height);
    copy.needsUpdate = true;
    out[key] = copy;
  }
  return out;
}

const PIECE_SIDING = metricMaterial(LAP_SIDING_MATERIAL, LAP_SIDING_TILE);
const PIECE_WAINSCOT = metricMaterial(WHITE_WAINSCOT_MATERIAL, WHITE_WAINSCOT_TILE);

/** Material arrays in BoxGeometry group order (+X, -X, +Y, -Y, +Z, -Z) */
const E = WALL_EDGE_MATERIAL;
const WALL_FACES_NORMAL: THREE.Material[] = [E, E, E, E, PIECE_SIDING, PIECE_WAINSCOT];
const WALL_FACES_FLIPPED: THREE.Material[] = [E, E, E, E, PIECE_WAINSCOT, PIECE_SIDING];

/**
 * Turns a wall BoxGeometry (width x height x thickness, centred) into the default two-sided wall:
 * front/back face UVs become metres (bottom-left = 0,0) and the returned materials put siding on
 * +Z ("left", outer by default) and wainscoting on -Z.
 */
export function applyDefaultWallFaces(geo: THREE.BoxGeometry, width: number, height: number): THREE.Material[] {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const index = geo.getIndex()!;
  for (const groupIndex of [4, 5]) {
    const group = geo.groups[groupIndex];
    const done = new Set<number>();
    for (let i = group.start; i < group.start + group.count; i++) {
      const v = index.getX(i);
      if (done.has(v)) continue;
      done.add(v);
      uv.setXY(v, uv.getX(v) * width, uv.getY(v) * height);
    }
  }
  uv.needsUpdate = true;
  return WALL_FACES_NORMAL;
}

/**
 * Swaps which side of a not-yet-confirmed wall piece shows siding, so the outer face follows the
 * building layout instead of the piece's rotation. No-op for meshes without the default wall faces.
 */
export function setWallPieceFlipped(root: THREE.Object3D, flipped: boolean): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.material === WALL_FACES_NORMAL || mesh.material === WALL_FACES_FLIPPED) {
      mesh.material = flipped ? WALL_FACES_FLIPPED : WALL_FACES_NORMAL;
    }
  });
}
