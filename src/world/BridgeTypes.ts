import { WORLD_HALF } from './WorldSettings';

export const MAX_BRIDGES = 128;
export const MIN_BRIDGE_SPAN = 1;
export const MAX_BRIDGE_SPAN = 64;
export const MAX_BRIDGE_SUPPORTS = 8;
export const BRIDGE_LANDING_LIFT = 0.025;

export interface BridgePoint {
  x: number;
  y: number;
  z: number;
}

export interface BridgeSettings {
  width: number;
  rise: number;
  thickness: number;
  railHeight: number;
  railings: boolean;
  shape: 'round' | 'eased';
  /** Number of support pairs along the span. Older saves omit this. */
  supportCount?: number;
}

export interface BridgeDef extends BridgeSettings {
  id: string;
  a: BridgePoint;
  b: BridgePoint;
}

export const BRIDGE_DEFAULTS: Readonly<BridgeSettings> = {
  width: 1.9,
  rise: 0.55,
  thickness: 0.18,
  railHeight: 0.9,
  railings: true,
  shape: 'round',
  supportCount: 0,
};

export const BRIDGE_RANGES = {
  width: { min: 0.9, max: 8, step: 0.05 },
  rise: { min: 0, max: 8, step: 0.05 },
  thickness: { min: 0.1, max: 0.6, step: 0.01 },
  railHeight: { min: 0.5, max: 1.6, step: 0.05 },
} satisfies Record<string, { min: number; max: number; step: number }>;

export function bridgeSpan(a: BridgePoint, b: BridgePoint): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

export function bridgeHeight(bridge: BridgeDef, t: number): number {
  const arch = bridge.shape === 'eased' ? Math.sin(Math.PI * t) ** 2 : 4 * t * (1 - t);
  return (bridge.b.y - bridge.a.y) * t + bridge.rise * arch;
}

export function bridgeSegments(span: number): number {
  return Math.max(8, Math.min(96, Math.ceil(span / 0.45)));
}

export function bridgeMaxSlope(bridge: BridgeDef): number {
  const span = bridgeSpan(bridge.a, bridge.b);
  const sections = bridgeSegments(span);
  let max = 0;
  let previous = 0;
  for (let i = 1; i <= sections; i++) {
    const height = bridgeHeight(bridge, i / sections);
    max = Math.max(max, Math.abs(height - previous));
    previous = height;
  }
  return Math.atan(max * sections / span) * 180 / Math.PI;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && value >= min && value <= max;
}

function isPoint(value: unknown): value is BridgePoint {
  return isRecord(value) && inRange(value.x, -WORLD_HALF, WORLD_HALF) &&
    inRange(value.z, -WORLD_HALF, WORLD_HALF) && inRange(value.y, -256, 256);
}

export function isBridgeDef(value: unknown): value is BridgeDef {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^bridge_[\w-]{1,48}$/.test(value.id) ||
      !isPoint(value.a) || !isPoint(value.b) || typeof value.railings !== 'boolean' ||
      (value.shape !== 'round' && value.shape !== 'eased')) return false;
  const count = value.supportCount;
  return (count === undefined || (inRange(count, 0, MAX_BRIDGE_SUPPORTS) && Number.isInteger(count))) &&
    inRange(bridgeSpan(value.a, value.b), MIN_BRIDGE_SPAN, MAX_BRIDGE_SPAN) &&
    Object.entries(BRIDGE_RANGES).every(([key, { min, max }]) => inRange(value[key], min, max));
}

export function isBridgeSave(value: unknown): value is BridgeDef[] {
  if (!Array.isArray(value) || value.length > MAX_BRIDGES) return false;
  const ids = new Set<string>();
  for (const bridge of value) {
    if (!isBridgeDef(bridge) || ids.has(bridge.id)) return false;
    ids.add(bridge.id);
  }
  return true;
}
