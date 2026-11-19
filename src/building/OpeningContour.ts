import { Vector2 } from 'three';

export type WindowProfile = 'rect' | 'arch' | 'round';

/** Counterclockwise perimeter in wall-local metres. The frame and the wall use identical chords. */
export function openingContour(style: WindowProfile, width: number, height: number, inset = 0): Vector2[] {
  const radius = width / 2 - inset;
  const bottom = -height / 2 + inset;
  if (style === 'rect') return [
    new Vector2(-radius, bottom), new Vector2(radius, bottom),
    new Vector2(radius, -bottom), new Vector2(-radius, -bottom),
  ];
  const round = style === 'round';
  const spring = round ? 0 : height / 2 - width / 2;
  const points = round ? [] : [new Vector2(-radius, bottom), new Vector2(radius, bottom)];
  for (let i = 0; i < (round ? 64 : 33); i++) {
    const angle = i * Math.PI / 32;
    points.push(new Vector2(radius * Math.cos(angle), spring + radius * Math.sin(angle)));
  }
  return points;
}
