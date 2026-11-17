import * as THREE from 'three';
import type { BuildingManager } from './BuildingManager';
import { BuiltPiece, isSwingDoorPiece } from './types/BuildingTypes';
import { FURNITURE_LIGHTS } from './furniture/FurnitureCatalog';
import { WINDOW_GLASS_LEVELS } from './config/BuildingMaterials';
import type { WindowSpill } from '../world/GroundLight';

/** Lamp light reaching a pane above which it glows dimly / brightly. */
const DIM_AT = 0.06;
const BRIGHT_AT = 0.3;
/** A pane belongs to a lamp's room when it lies within this of the room box (the wall's thickness). */
const BOX_PAD = 0.4;
/** Warm room light falling out onto the ground: colour, and strength / reach per glow level. */
const SPILL_COLOR = new THREE.Color(1.0, 0.62, 0.26);
const SPILL = [
  { k: 0, range: 0 },
  { k: 0.28, range: 3.5 },
  { k: 0.55, range: 4.5 },
];
/** An open door lets out more than a window. */
const DOOR_SPILL = { k: 0.8, range: 5.5 };

/** Material -> [family, level] for the window glass variants. */
const LEVEL_OF = new Map<THREE.Material, { family: THREE.Material[]; level: number }>();
for (const family of [WINDOW_GLASS_LEVELS.near, WINDOW_GLASS_LEVELS.far]) {
  family.forEach((m, level) => LEVEL_OF.set(m, { family, level }));
}

interface Lamp {
  pos: THREE.Vector3;
  range: number;
  intensity: number;
  box: THREE.Box3;
}

/** An opening of a lit room: where it is, which way is out, how lit. */
interface LitOpening {
  piece: BuiltPiece;
  level: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  door: boolean;
  glazed: boolean;
}

/**
 * Windows and glazed doors glow warm at night when a lamp lights the room behind them, near and far
 * (the opaque far-glass LOD too), so from afar one sees which rooms are lit. The same openings
 * (and open doors of lit rooms) throw a warm patch of light on the ground outside: `spills`, baked
 * into the ground light (GroundLight) whenever `spillRevision` changes.
 *
 * Cheap by design: the lamp-to-pane test runs only when something was built, moved or removed
 * (a few lamps times the panes around them), and a pane changes only its material: the lit glass
 * variants differ from the plain one in a uniform, so they share its shader programs and no draw
 * call is added. The night amount itself is one shared uniform (setGlassNight). Doors are polled
 * for open / closed a few times a second (a handful of flags).
 */
export class WindowGlow {
  /** Statistics for the dev tools. */
  public readonly stats = { panes: 0, lit: 0, ms: 0 };
  /** Light falling out of lit windows and open doors (read when spillRevision changes). */
  public spills: WindowSpill[] = [];
  public spillRevision = 0;

  private seenRevision = -1;
  private timer = 0;
  /** Current level per pane piece id (0 = unlit) */
  private readonly levels = new Map<string, number>();
  /** Piece types whose meshes hold window glass */
  private readonly glazed = new Map<string, boolean>();
  private lit: LitOpening[] = [];
  /** Open state of the lit doors when the spills were last built */
  private doorKey = '';

  constructor(private readonly buildings: BuildingManager) {}

  public update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    if (this.seenRevision !== this.buildings.revision) {
      this.seenRevision = this.buildings.revision;
      const t0 = performance.now();
      this.recompute();
      this.stats.ms = performance.now() - t0;
      this.rebuildSpills();
      return;
    }
    if (this.doorKeyNow() !== this.doorKey) this.rebuildSpills();
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
    const openings: { piece: BuiltPiece; glazed: boolean; door: boolean }[] = [];
    const lamps: Lamp[] = [];
    for (const p of pieces) {
      const light = FURNITURE_LIGHTS[p.type];
      if (light) {
        const pos = new THREE.Vector3(p.position.x, p.position.y + light.yOffset, p.position.z);
        // The lamp's room; a lamp nothing encloses lights no window
        const box = this.buildings.getLightVolume(pos, light.range);
        if (box) lamps.push({ pos, range: light.range, intensity: light.intensity, box: box.expandByScalar(BOX_PAD) });
      } else if (p.worldBoundingBox) {
        const glazed = this.hasGlass(p);
        const door = isSwingDoorPiece(p.type);
        if (glazed || door) openings.push({ piece: p, glazed, door });
      }
    }

    const centre = new THREE.Vector3();
    const size = new THREE.Vector3();
    const alive = new Set<string>();
    const lit: LitOpening[] = [];
    let panes = 0;
    let litPanes = 0;
    for (const { piece: p, glazed, door } of openings) {
      p.worldBoundingBox!.getCenter(centre);
      let sum = 0;
      let best: Lamp | null = null;
      let bestK = 0;
      for (const l of lamps) {
        if (!l.box.containsPoint(centre)) continue;
        const reach = l.range + 1;
        const d = l.pos.distanceTo(centre);
        if (d >= reach) continue;
        const k = l.intensity * (1 - d / reach);
        sum += k;
        if (k > bestK) {
          bestK = k;
          best = l;
        }
      }
      const level = sum >= BRIGHT_AT ? 2 : sum >= DIM_AT ? 1 : 0;
      if (glazed) {
        panes++;
        alive.add(p.id);
        if (level) litPanes++;
        // Applied every time (cheap, a no-op when right): a rebuilt mesh starts with the plain glass
        // The building batch draws a copy of the piece's meshes: rebuild its chunk when the glass changed
        if ((level !== (this.levels.get(p.id) ?? 0) || level) && this.apply(p, level)) this.buildings.markPieceVisualChanged(p);
        if (level) this.levels.set(p.id, level);
        else this.levels.delete(p.id);
      }
      if (!level || !best) continue;
      // Out of the house: across the opening's thin side, away from the lit room's centre
      p.worldBoundingBox!.getSize(size);
      const room = best.box.getCenter(new THREE.Vector3());
      let nx = 0;
      let nz = 0;
      if (size.x < size.z) nx = centre.x >= room.x ? 1 : -1;
      else nz = centre.z >= room.z ? 1 : -1;
      lit.push({ piece: p, level, x: centre.x, y: centre.y, z: centre.z, nx, nz, door, glazed });
    }
    for (const id of Array.from(this.levels.keys())) if (!alive.has(id)) this.levels.delete(id);
    this.lit = lit;
    this.stats.panes = panes;
    this.stats.lit = litPanes;
  }

  private doorKeyNow(): string {
    let key = '';
    for (const o of this.lit) if (o.door) key += o.piece.isOpen ? '1' : '0';
    return key;
  }

  private rebuildSpills(): void {
    this.doorKey = this.doorKeyNow();
    const spills: WindowSpill[] = [];
    for (const o of this.lit) {
      // An open door lets the room's light out; a closed one only through its glass
      const s = o.door && o.piece.isOpen ? DOOR_SPILL : o.glazed ? SPILL[o.level] : null;
      if (!s || s.k <= 0) continue;
      const k = o.door && o.piece.isOpen ? s.k * (o.level === 2 ? 1 : 0.6) : s.k;
      spills.push({
        x: o.x,
        y: o.y,
        z: o.z,
        nx: o.nx,
        nz: o.nz,
        range: s.range,
        r: SPILL_COLOR.r * k,
        g: SPILL_COLOR.g * k,
        b: SPILL_COLOR.b * k,
      });
    }
    this.spills = spills;
    this.spillRevision++;
  }

  /** Swaps the pane's glass (near and far twins) to the variant for `level`; true when any changed. */
  private apply(piece: BuiltPiece, level: number): boolean {
    let any = false;
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
        if (changed) {
          mesh.material = next;
          any = true;
        }
      } else {
        const e = LEVEL_OF.get(mesh.material);
        if (e && e.level !== level) {
          mesh.material = e.family[level];
          any = true;
        }
      }
    });
    return any;
  }
}
