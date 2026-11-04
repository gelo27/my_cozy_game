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
  /** Channel depth at this point (m). Omitted: the river's depth, scaled with the width. */
  d?: number;
  /** Waterfall: the surface drops this many metres right at this point (a gorge is cut below it). */
  fall?: number;
  /** How far the falling water arcs out from the lip, 0 = a flat sheet (default 0.6). */
  bulge?: number;
}

export interface RiverDef {
  id: string;
  name: string;
  /**
   * 'lake': the points are a closed outline and the water is flat (a pond or lake that rivers can
   * flow into, out of or through). Omitted: a river running from the first point to the last.
   */
  kind?: 'lake';
  /** Lakes: pinned water level (m). Omitted: just below the lowest ground on the shore. */
  level?: number;
  /** Default channel width (m). */
  width: number;
  /** Depth in the middle of the channel (m). */
  depth: number;
  /**
   * Raise low embankments where the water runs above the surrounding ground (default true).
   * Off: the banks are only ever cut down, never built up.
   */
  levees?: boolean;
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
  /**
   * Estuary: 0 upstream, rising to 1 where the river meets the sea (or a lake), then 1..2 over
   * the first 10 m past the shoreline.
   */
  mouth: number;
}

export interface WaterfallInfo {
  /** Where the falling water lands (centre of the plunge). */
  x: number;
  z: number;
  /** Sample indices of the lip and of the foot of the drop. */
  start: number;
  end: number;
  /** Horizontal distance the water arcs out from the lip before landing (m). */
  travel: number;
  top: number;
  bottom: number;
  width: number;
  /** Downstream direction. */
  tx: number;
  tz: number;
}

/** A lake's flat water: its level and shoreline (closed, ~1 m apart). */
export interface LakeShape {
  level: number;
  xs: Float32Array;
  zs: Float32Array;
}

export interface SampledRiver {
  def: RiverDef;
  /** Set for lakes (`def.kind === 'lake'`); then `samples` is the shoreline. */
  lake?: LakeShape;
  /** River this one branches off (its source lies in that river's channel). */
  branchOf?: string;
  /** River this one flows into (its end lies in that river's channel). */
  flowsInto?: string;
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
