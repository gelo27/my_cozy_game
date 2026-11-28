import { Vector2 } from 'three';

export type WindowProfile = 'rect' | 'arch' | 'round';

/** Counterclockwise perimeter in wall-local metres. The frame and the wall use identical chords. */
export function openingContour(style: WindowProfile, width: number, height: number, inset = 0, archRise = width / 2): Vector2[] {
  const radius = width / 2 - inset;
  const bottom = -height / 2 + inset;
  if (style === 'rect') return [
    new Vector2(-radius, bottom), new Vector2(radius, bottom),
    new Vector2(radius, -bottom), new Vector2(-radius, -bottom),
  ];
  const round = style === 'round';
  const spring = round ? 0 : height / 2 - archRise;
  const rise = round ? radius : archRise - inset;
  const points = round ? [] : [new Vector2(-radius, bottom), new Vector2(radius, bottom)];
  for (let i = 0; i < (round ? 64 : 33); i++) {
    const angle = i * Math.PI / 32;
    points.push(new Vector2(radius * Math.cos(angle), spring + rise * Math.sin(angle)));
  }
  return points;
}

export const ARCH_DOOR_JAMB = 0.075;
export const ARCH_DOOR_HINGE_X = -0.5 + ARCH_DOOR_JAMB;
export const ARCH_DOOR_LEAF_DEPTH = 0.055;

export function archedDoorContour(inset = 0, floor = -1): Vector2[] {
  const points = openingContour('arch', 1, 2, inset);
  points[0].y = points[1].y = floor;
  return points;
}

export function doorwayClearance(width: number, height: number) {
  return { halfWidth: width / 2 - (width === 2 ? 0.10 : 0.08), top: height / 2 - 0.12 };
}
