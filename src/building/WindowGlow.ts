import * as THREE from 'three';
import type { BuildingManager } from './BuildingManager';
import { BuiltPiece } from './types/BuildingTypes';
import { FURNITURE_LIGHTS } from './furniture/FurnitureCatalog';
import { WINDOW_GLASS_LEVELS } from './config/BuildingMaterials';

/** Lamp light reaching a pane above which it glows dimly / brightly. */
const DIM_AT = 0.06;
const BRIGHT_AT = 0.3;
/** A pane belongs to a lamp's room when it lies within this of the room box (the wall's thickness). */
const BOX_PAD = 0.4;

/** Material -> [family, level] for the window glass variants. */
const LEVEL_OF = new Map<THREE.Material, { family: THREE.Material[]; level: number }>();
for (const family of [WINDOW_GLASS_LEVELS.near, WINDOW_GLASS_LEVELS.far]) {
  family.forEach((m, level) => LEVEL_OF.set(m, { family, level }));
}

/**
 * Windows and glazed doors glow warm at night when a lamp lights the room behind them, near and far
 * (the opaque far-glass LOD too), so from afar one sees which rooms are lit.
 *
 * Cheap by design: the lamp-to-pane test runs only when something was built, moved or removed
 * (a few lamps times the panes around them), and a pane changes only its material: the lit glass
 * variants differ from the plain one in a uniform, so they share its shader programs and no draw
 * call is added. The night amount itself is one shared uniform (setGlassNight).
 */
export class WindowGlow {
  /** Statistics for the dev tools. */
  public readonly stats = { panes: 0, lit: 0, ms: 0 };

  private seenRevision = -1;
  private timer = 0;
  /** Current level per pane piece id (0 = unlit) */
  private readonly levels = new Map<string, number>();
  /** Piece types whose meshes hold window glass */
  private readonly glazed = new Map<string, boolean>();

  constructor(private readonly buildings: BuildingManager) {}

  public update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0 || this.seenRevision === this.buildings.revision) return;
    this.timer = 0.25;
    this.seenRevision = this.buildings.revision;
    const t0 = performance.now();
    this.recompute();
    this.stats.ms = performance.now() - t0;
  }

  private hasGlass(piece: BuiltPiece): boolean {
    let has = this.glazed.get(piece.type);
    if (has === undefined) {
      has = false;
      piece.meshGroup.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (has || !mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (mats.some((m) => LEVEL_OF.has(m))) has = true;
      });
      this.glazed.set(piece.type, has);
    }
    return has;
  }

  private recompute(): void {
    const pieces = this.buildings.getAllPieces();
    const panes: BuiltPiece[] = [];
    const lamps: { pos: THREE.Vector3; range: number; intensity: number; box: THREE.Box3 }[] = [];
    for (const p of pieces) {
      const light = FURNITURE_LIGHTS[p.type];
      if (light) {
        const pos = new THREE.Vector3(p.position.x, p.position.y + light.yOffset, p.position.z);
        // The lamp's room; a lamp nothing encloses lights no window
        const box = this.buildings.getLightVolume(pos, light.range);
        if (box) lamps.push({ pos, range: light.range, intensity: light.intensity, box: box.expandByScalar(BOX_PAD) });
      } else if (p.worldBoundingBox && this.hasGlass(p)) {
        panes.push(p);
      }
    }

    const centre = new THREE.Vector3();
    const alive = new Set<string>();
    let lit = 0;
    for (const p of panes) {
      alive.add(p.id);
      p.worldBoundingBox!.getCenter(centre);
      let sum = 0;
      for (const l of lamps) {
        if (!l.box.containsPoint(centre)) continue;
        const reach = l.range + 1;
        const d = l.pos.distanceTo(centre);
        if (d < reach) sum += l.intensity * (1 - d / reach);
      }
      const level = sum >= BRIGHT_AT ? 2 : sum >= DIM_AT ? 1 : 0;
      if (level) lit++;
      // Applied every time (cheap, a no-op when right): a rebuilt mesh starts with the plain glass
      if (level !== (this.levels.get(p.id) ?? 0) || level) this.apply(p, level);
      if (level) this.levels.set(p.id, level);
      else this.levels.delete(p.id);
    }
    for (const id of Array.from(this.levels.keys())) if (!alive.has(id)) this.levels.delete(id);
    this.stats.panes = panes.length;
    this.stats.lit = lit;
  }

  /** Swaps the pane's glass (near and far twins) to the variant for `level`. */
  private apply(piece: BuiltPiece, level: number): void {
    piece.meshGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) {
        let changed = false;
        // A new array: material arrays can be shared between pieces of one type
        const next = mesh.material.map((m) => {
          const e = LEVEL_OF.get(m);
          if (!e || e.level === level) return m;
          changed = true;
          return e.family[level];
        });
        if (changed) mesh.material = next;
      } else {
        const e = LEVEL_OF.get(mesh.material);
        if (e && e.level !== level) mesh.material = e.family[level];
      }
    });
  }
}
