/**
 * Authored river data (src/world/rivers/rivers.json). Rivers are part of the island's design, so
 * they live in the repository and are carved into the generated terrain; saves store only the
 * player's edits on top, so changing a river also shows up in existing worlds.
 */
export interface RiverPoint {
  x: number;
  z: number;
  /** Pinned water surface height (m). Omitted: follows the terrain, never flowing uphill. */
  y?: number;
  /** Channel width at this point (m). Omitted: the river's width. */
  w?: number;
  /** Waterfall: the surface drops this many metres right at this point (a gorge is cut below it). */
  fall?: number;
}

export interface RiverDef {
  id: string;
  name: string;
  /** Default channel width (m). */
  width: number;
  /** Depth in the middle of the channel (m). */
  depth: number;
  /** Points from the source downstream to the mouth. */
  points: RiverPoint[];
}

/** One step along the river's centre line (~1 m apart). */
export interface RiverSample {
  x: number;
  z: number;
  /** Water surface height. */
  s: number;
  /** Half width of the channel. */
  hw: number;
  depth: number;
  /** Tangent (unit, XZ) pointing downstream. */
  tx: number;
  tz: number;
  /** Distance from the source along the centre line. */
  dist: number;
  /** 0..1 white water: waterfalls and steep rapids. */
  foam: number;
  /** 0..1 surface opacity factor (fades in at the source and out into the sea). */
  alpha: number;
}

export interface WaterfallInfo {
  /** Top of the fall (lip) and the plunge point at its foot. */
  x: number;
  z: number;
  top: number;
  bottom: number;
  width: number;
  /** Downstream direction. */
  tx: number;
  tz: number;
}

export interface SampledRiver {
  def: RiverDef;
  samples: RiverSample[];
  /** Index into `samples` of every control point. */
  pointSample: number[];
  falls: WaterfallInfo[];
  /** World-space bounds of everything the river touches (channel + banks). */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}
