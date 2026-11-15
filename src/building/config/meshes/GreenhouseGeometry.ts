import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BUILDING_MATERIALS } from '../BuildingMaterials';
import type { PieceMeshTemplate } from './PieceMeshTemplate';

/**
 * Greenhouse wall panel: wooden glazing frame (sill, head, jambs, mullions, a low kick rail and
 * a transom rail) around one thin pane of glass. With `doorway`, the lower 2.4m is an open
 * walk-through and only the transom above it is glazed.
 */
export function buildGreenhouseWallGeometry(width: number, height: number, doorway = false): PieceMeshTemplate {
  const bar = 0.06;
  const depth = 0.08;
  const halfW = width / 2;
  const halfH = height / 2;
  const frame: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, 0);
    frame.push(g);
  };
  const pane = (w: number, h: number, x: number, y: number) => {
    const g = new THREE.BoxGeometry(w, h, 0.012);
    g.translate(x, y, 0);
    glass.push(g);
  };

  // Jambs and head
  box(bar, height, depth, -halfW + bar / 2, 0);
  box(bar, height, depth, halfW - bar / 2, 0);
  box(width, bar, depth, 0, halfH - bar / 2);

  const transomY = -halfH + 2.4; // top of the walk-through height
  box(width - bar * 2, bar * 0.8, depth * 0.9, 0, transomY);

  if (doorway) {
    // Glazed transom above the opening
    pane(width - bar * 2, halfH - transomY - bar * 1.2, 0, (transomY + halfH - bar) / 2);
  } else {
    // Sill, low kick rail, and vertical mullions every 0.5m
    box(width, bar * 1.4, depth * 1.1, 0, -halfH + bar * 0.7);
    box(width - bar * 2, bar * 0.8, depth * 0.9, 0, -halfH + 0.45);
    const bays = Math.max(1, Math.round(width / 0.5));
    for (let i = 1; i < bays; i++) {
      box(bar * 0.6, height - bar * 2, depth * 0.8, -halfW + (i * width) / bays, 0);
    }
    pane(width - bar * 2, height - bar * 2.4, 0, bar * 0.2);
  }

  const mergedFrame = mergeGeometries(frame)!;
  const mergedGlass = mergeGeometries(glass)!;
  frame.forEach((g) => g.dispose());
  glass.forEach((g) => g.dispose());
  const geometry = mergeGeometries([mergedFrame, mergedGlass], true)!;
  mergedFrame.dispose();
  mergedGlass.dispose();
  return {
    geometry,
    materials: [BUILDING_MATERIALS.greenhouseFrame, BUILDING_MATERIALS.greenhouseGlass],
    boundingBox: new THREE.Box3(),
  };
}

/** Greenhouse door leaf: 0.86 x 2.24m, centred on the origin, hinge side at -X. */
export const GH_LEAF_W = 0.86;
export const GH_LEAF_H = 2.24;
export const GH_LEAF_Y = -0.355; // leaf centre in the 3m panel (bottom of the leaf ~1cm above the sill)
export const GH_HINGE_X = -0.43;

interface GreenhouseParts {
  frame: THREE.BufferGeometry[];
  glass: THREE.BufferGeometry[];
  hardware: THREE.BufferGeometry[];
}

export function pushBox(list: THREE.BufferGeometry[], w: number, h: number, d: number, x: number, y: number, z = 0): void {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  list.push(g);
}

/** Leaf parts (frame stiles/rails, solid kick panel, glazing, lever handles), offset by (ox, oy). */
export function greenhouseDoorLeafParts(parts: GreenhouseParts, ox: number, oy: number): void {
  const w = GH_LEAF_W;
  const h = GH_LEAF_H;
  const st = 0.06; // stile / rail width
  const d = 0.05;
  const bottom = oy - h / 2;
  const top = oy + h / 2;
  pushBox(parts.frame, st, h, d, ox - w / 2 + st / 2, oy);
  pushBox(parts.frame, st, h, d, ox + w / 2 - st / 2, oy);
  pushBox(parts.frame, w - st * 2, st, d, ox, top - st / 2);
  // Solid kick panel at the bottom, then a lock rail
  const kickH = 0.38;
  pushBox(parts.frame, w - st * 2, kickH, d * 0.7, ox, bottom + kickH / 2);
  const lockY = bottom + 0.95;
  pushBox(parts.frame, w - st * 2, st * 0.8, d, ox, lockY);
  // Glazing: lower pane between kick panel and lock rail, upper pane above, a thin glazing bar in the upper pane
  const lowH = lockY - (bottom + kickH) - st * 0.4;
  pushBox(parts.glass, w - st * 2, lowH, 0.012, ox, bottom + kickH + lowH / 2);
  const upB = lockY + st * 0.4;
  const upT = top - st;
  pushBox(parts.glass, w - st * 2, upT - upB, 0.012, ox, (upB + upT) / 2);
  pushBox(parts.frame, 0.03, upT - upB, d * 0.6, ox, (upB + upT) / 2);
  // Lever handles on both faces, away from the hinge
  for (const z of [-1, 1]) {
    pushBox(parts.hardware, 0.035, 0.09, 0.03, ox + w / 2 - 0.1, lockY, z * (d / 2 + 0.015));
    pushBox(parts.hardware, 0.12, 0.022, 0.022, ox + w / 2 - 0.14, lockY + 0.02, z * (d / 2 + 0.04));
  }
  // Hinges on the hinge stile
  for (const y of [bottom + 0.3, top - 0.3]) {
    pushBox(parts.hardware, 0.03, 0.1, d + 0.01, ox - w / 2 + 0.005, y);
  }
}

/** Static greenhouse door frame: jambs, head, transom rail + transom glass, threshold. */
export function greenhouseDoorFrameParts(parts: GreenhouseParts): void {
  const bar = 0.06;
  const depth = 0.08;
  pushBox(parts.frame, bar, 3.0, depth, -0.5 + bar / 2, 0);
  pushBox(parts.frame, bar, 3.0, depth, 0.5 - bar / 2, 0);
  pushBox(parts.frame, 1.0, bar, depth, 0, 1.5 - bar / 2);
  const openTop = GH_LEAF_Y + GH_LEAF_H / 2 + 0.01;
  pushBox(parts.frame, 1.0 - bar * 2, bar, depth, 0, openTop + bar / 2);
  pushBox(parts.frame, 1.0 - bar * 2, 0.02, depth * 1.2, 0, -1.5 + 0.01);
  const tB = openTop + bar;
  const tT = 1.5 - bar;
  pushBox(parts.glass, 1.0 - bar * 2, tT - tB, 0.012, 0, (tB + tT) / 2);
  pushBox(parts.frame, 0.035, tT - tB, depth * 0.7, 0, (tB + tT) / 2);
}

export function mergeGreenhouseParts(parts: GreenhouseParts): PieceMeshTemplate {
  const lists = [parts.frame, parts.glass, parts.hardware];
  const merged = lists.map((l) => mergeGeometries(l)!);
  lists.forEach((l) => l.forEach((g) => g.dispose()));
  const geometry = mergeGeometries(merged, true)!;
  merged.forEach((g) => g.dispose());
  return {
    geometry,
    materials: [BUILDING_MATERIALS.greenhouseFrame, BUILDING_MATERIALS.greenhouseGlass, BUILDING_MATERIALS.brassHardware],
    boundingBox: new THREE.Box3(),
  };
}

const newParts = (): GreenhouseParts => ({ frame: [], glass: [], hardware: [] });

/** Whole closed door in one geometry (ghost preview, bounds). */
export function buildGreenhouseDoorGeometry(): PieceMeshTemplate {
  const parts = newParts();
  greenhouseDoorFrameParts(parts);
  greenhouseDoorLeafParts(parts, 0, GH_LEAF_Y);
  return mergeGreenhouseParts(parts);
}

export function buildGreenhouseDoorFrame(): PieceMeshTemplate {
  const parts = newParts();
  greenhouseDoorFrameParts(parts);
  // Hardware list must not be empty for the merge: a strike plate on the latch jamb
  pushBox(parts.hardware, 0.02, 0.14, 0.09, 0.44, GH_LEAF_Y - GH_LEAF_H / 2 + 0.95);
  return mergeGreenhouseParts(parts);
}

/** Leaf centred on its own origin (placed under the hinge pivot). */
export function buildGreenhouseDoorLeaf(): PieceMeshTemplate {
  const parts = newParts();
  greenhouseDoorLeafParts(parts, 0, 0);
  return mergeGreenhouseParts(parts);
}

