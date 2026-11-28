import type { GameWorld } from '../engine/GameEngine';
import { WORLD_HALF, WORLD_SIZE } from '../world/WorldSettings';

const STAMP_SIZE = 48;
const CENTER = STAMP_SIZE / 2;
const CROWN_RADIUS = 18;
const TREE_STYLES = {
  tree_pine: { radius: 1.8, light: '#79a25a', mid: '#427547', dark: '#284d38' },
  tree_round: { radius: 2.9, light: '#9eb965', mid: '#638d49', dark: '#355635' },
  tree_maple: { radius: 2.5, light: '#babe70', mid: '#7b9649', dark: '#4b6035' },
  tree_birch: { radius: 1.7, light: '#b5c779', mid: '#7c9d56', dark: '#45643a' },
  apple: { radius: 2.2, light: '#9cb86a', mid: '#5d8949', dark: '#365933' },
};
type TreeKind = keyof typeof TREE_STYLES;
const stamps = new Map<TreeKind, HTMLCanvasElement>();

function canopyStamp(kind: TreeKind): HTMLCanvasElement {
  const cached = stamps.get(kind);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = STAMP_SIZE;
  const ctx = canvas.getContext('2d')!;
  const { light, mid, dark } = TREE_STYLES[kind];
  const pine = kind === 'tree_pine';
  const shadow = ctx.createRadialGradient(CENTER + 3, CENTER + 4, 7, CENTER + 3, CENTER + 4, 20);
  shadow.addColorStop(0, 'rgba(29,46,31,0.46)');
  shadow.addColorStop(1, 'rgba(29,46,31,0)');
  ctx.fillStyle = shadow;
  ctx.fillRect(0, 0, STAMP_SIZE, STAMP_SIZE);

  const tiers = pine ? [1, 0.69, 0.43] : [1];
  for (const tier of tiers) {
    const radius = CROWN_RADIUS * tier;
    const center = CENTER - (1 - tier) * 3;
    const lighting = ctx.createRadialGradient(center - radius * 0.35, center - radius * 0.4, 0, center, center, radius);
    lighting.addColorStop(0, light);
    lighting.addColorStop(0.59, mid);
    lighting.addColorStop(1, dark);
    ctx.beginPath();
    const sides = pine ? 12 : 48;
    for (let i = 0; i < sides; i++) {
      const angle = i * Math.PI * 2 / sides + tier * 0.25;
      const edge = pine ? (i % 2 === 0 ? 1 : 0.79) : 0.93 + Math.cos(angle * 6) * 0.07;
      const x = center + Math.cos(angle) * radius * edge;
      const y = center + Math.sin(angle) * radius * edge;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = lighting;
    ctx.fill();
  }

  stamps.set(kind, canvas);
  return canvas;
}

/** Draws a static top-down canopy layer from tree positions and a handful of shared 2D stamps. */
export function renderMapTrees(
  world: Pick<GameWorld, 'props' | 'propTrees' | 'forest' | 'orchard'>,
  size: number,
  reuse?: HTMLCanvasElement,
): HTMLCanvasElement {
  const canvas = reuse ?? document.createElement('canvas');
  if (canvas.width !== size || canvas.height !== size) canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  const scale = size / WORLD_SIZE;
  const trees: { kind: TreeKind; x: number; z: number; radius: number }[] = [];
  const add = (kind: TreeKind, x: number, z: number, radius: number) => {
    if (radius * scale >= 0.65) trees.push({ kind, x, z, radius });
  };
  for (const prop of world.props.list()) {
    if (!Object.prototype.hasOwnProperty.call(TREE_STYLES, prop.type) || world.propTrees.isDown(prop.id)) continue;
    const kind = prop.type as TreeKind;
    add(kind, prop.position.x, prop.position.z, TREE_STYLES[kind].radius * prop.scale);
  }
  world.forest.forEachCanopy((x, z, radius) => add('tree_pine', x, z, radius));
  world.orchard.forEachCanopy((x, z, radius) => add('apple', x, z, radius));
  trees.sort((a, b) => a.z - b.z);
  for (const { kind, x, z, radius } of trees) {
    const width = STAMP_SIZE * radius * scale / CROWN_RADIUS;
    ctx.drawImage(canopyStamp(kind), (x + WORLD_HALF) * scale - width / 2, (z + WORLD_HALF) * scale - width / 2, width, width);
  }
  return canvas;
}
