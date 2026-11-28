import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { GameWorld } from '../../engine/GameEngine';
import type { MapMarkerIcon } from '../../explore/ExplorationManager';
import { renderTerrainMap, EXPLORE_GRID } from '../../explore/MapRenderer';
import { renderMapRoofs } from '../../explore/MapRoofs';
import { renderMapTrees } from '../../explore/MapTrees';
import { bindMapViewport, type MapViewport } from '../../explore/MapViewport';
import type { SiteKind } from '../../world/IslandSites';
import { WORLD_SIZE, WORLD_HALF, worldSettings } from '../../world/WorldSettings';
import { riverWorld } from '../../world/rivers/RiverWorld';
import { t } from '../../i18n/i18n';
import { MARKER_ICON } from './mapMarkerIcons';

export const SITE_ICON: Record<SiteKind, string> = { lighthouse: '🗼', ruins: '🏛️', hut: '🛖', cave: '🕳️' };

const panel = 'bg-[#fffaf0]/95 text-[#4a3b2a] border border-[#e9dcc3] shadow-[0_6px_20px_rgba(60,40,10,0.18)]';

interface MapLayers {
  terrain?: { canvas: HTMLCanvasElement; heights: number; tiles: number; rivers: number; sea: number };
  trees?: { canvas: HTMLCanvasElement; props: number; forest: number; orchard: number };
  roofs?: { canvas: HTMLCanvasElement; buildings: GameWorld['character']['buildAbility']['buildingManager']; revision: number; heights: number };
}

/** Static map layers survive closing the map and are released with the world. */
const mapCache = new WeakMap<GameWorld, MapLayers>();

function drawMapLayers(ctx: CanvasRenderingContext2D, world: GameWorld, size: number, layers: MapLayers): void {
  const { terrain, props, forest, orchard } = world;
  const buildings = world.character.buildAbility?.buildingManager;
  const sea = worldSettings.waterLevel;
  const rivers = riverWorld.revision;
  if (layers.terrain?.heights !== terrain.revision || layers.terrain.tiles !== terrain.tileRevision ||
      layers.terrain.rivers !== rivers || layers.terrain.sea !== sea) {
    layers.terrain = {
      canvas: renderTerrainMap(terrain), heights: terrain.revision, tiles: terrain.tileRevision, rivers, sea,
    };
  }
  if (layers.trees?.props !== props.treeMapRevision || layers.trees.forest !== forest.canopyRevision ||
      layers.trees.orchard !== orchard.revision || layers.trees.canvas.width !== size) {
    layers.trees = {
      canvas: renderMapTrees(world, size, layers.trees?.canvas),
      props: props.treeMapRevision, forest: forest.canopyRevision, orchard: orchard.revision,
    };
  }
  if (buildings && (layers.roofs?.buildings !== buildings || layers.roofs.revision !== buildings.roofMapRevision ||
      layers.roofs.heights !== terrain.revision || layers.roofs.canvas.width !== size)) {
    layers.roofs = {
      canvas: renderMapRoofs(buildings.pieces.values(), terrain, size, layers.roofs?.canvas),
      buildings, revision: buildings.roofMapRevision, heights: terrain.revision,
    };
  }

  ctx.drawImage(layers.terrain.canvas, 0, 0, size, size);
  ctx.drawImage(layers.trees.canvas, 0, 0);
  if (buildings && layers.roofs) ctx.drawImage(layers.roofs.canvas, 0, 0);
}

/** Parchment fog over unexplored land, painted from the 128x128 exploration mask. */
function renderFog(explored: Uint8Array): { canvas: HTMLCanvasElement; percent: number } {
  const c = document.createElement('canvas');
  c.width = c.height = EXPLORE_GRID;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(EXPLORE_GRID, EXPLORE_GRID);
  let sum = 0;
  for (let i = 0; i < explored.length; i++) {
    const n = ((i * 2654435761) >>> 24) / 255; // paper grain
    img.data[i * 4] = 226 + n * 14;
    img.data[i * 4 + 1] = 212 + n * 12;
    img.data[i * 4 + 2] = 178 + n * 10;
    img.data[i * 4 + 3] = 255 - explored[i];
    sum += explored[i];
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, percent: Math.round(sum / (explored.length * 255) * 100) };
}

/** `heading` is the camera's compass bearing in radians (0 = north, clockwise). */
export const WorldMap: React.FC<{ world: GameWorld; heading(): number; onClose(): void }> = ({ world, heading, onClose }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<MapViewport>({ zoom: 1, x: 0, y: 0 });
  const iconRef = useRef<MapMarkerIcon>('pin');
  const [icon, setIcon] = useState<MapMarkerIcon>('pin');
  const [explored, setExplored] = useState(0);
  const ex = world.exploration;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const view = viewRef.current;
    const layers = mapCache.get(world) ?? {};
    mapCache.set(world, layers);
    let fog = renderFog(ex.explored);
    let fogRevision = ex.revision;
    setExplored(fog.percent);
    const draw = () => {
      const S = canvas.width;
      const k = S / WORLD_SIZE;
      const { zoom, x, y } = view;
      if (ex.revision !== fogRevision) {
        fog = renderFog(ex.explored);
        fogRevision = ex.revision;
        setExplored(fog.percent);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.save();
      ctx.transform(zoom, 0, 0, zoom, x * S, y * S);
      drawMapLayers(ctx, world, S, layers);
      ctx.drawImage(fog.canvas, 0, 0, S, S);
      // Grid every 64 m, like a surveyor's map
      ctx.strokeStyle = 'rgba(90,70,40,0.12)';
      ctx.lineWidth = 1 / zoom;
      for (let g = 64; g < WORLD_SIZE; g += 64) {
        ctx.beginPath();
        ctx.moveTo(g * k, 0);
        ctx.lineTo(g * k, S);
        ctx.moveTo(0, g * k);
        ctx.lineTo(S, g * k);
        ctx.stroke();
      }
      ctx.restore();
      const px = (worldX: number) => (worldX + WORLD_HALF) * k * zoom + x * S;
      const py = (worldZ: number) => (worldZ + WORLD_HALF) * k * zoom + y * S;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const player = ex.surfacePosition(world.character.getPosition());
      const ride = world.vehicle.isPlayerInside ? world.vehicle : world.moped.isPlayerInside ? world.moped : world.boat.isPlayerInside ? world.boat : null;
      if (ride) player.copy(ride.getPosition());

      for (const s of ex.getMapSites(player)) {
        ctx.globalAlpha = s.known && s.done ? 0.6 : 1;
        ctx.font = `${Math.round(S * 0.042)}px sans-serif`;
        ctx.fillText(s.known ? SITE_ICON[s.kind] : '❓', px(s.x), py(s.z));
        if (s.known) {
          ctx.font = `bold ${Math.round(S * 0.022)}px sans-serif`;
          ctx.fillStyle = '#4a3b2a';
          ctx.fillText(t(`site.${s.kind}`) + (s.done ? ` (${t('map.done')})` : ''), px(s.x), py(s.z) + S * 0.035);
        }
      }
      ctx.globalAlpha = 1;
      ctx.font = `${Math.round(S * 0.036)}px sans-serif`;
      for (const m of ex.markers) ctx.fillText(MARKER_ICON[m.icon], px(m.x), py(m.z) - S * 0.012);

      // The scooter, then the player arrow pointing where the camera looks
      const mp = world.moped.getPosition();
      if (!world.moped.isPlayerInside) {
        ctx.font = `${Math.round(S * 0.03)}px sans-serif`;
        ctx.fillText('🛵', px(mp.x), py(mp.z));
      }
      if (!world.boat.isPlayerInside) {
        const bp = world.boat.getPosition();
        ctx.fillText('🚤', px(bp.x), py(bp.z));
      }
      ctx.save();
      ctx.translate(px(player.x), py(player.z));
      ctx.rotate(heading());
      ctx.beginPath();
      ctx.moveTo(0, -S * 0.022);
      ctx.lineTo(S * 0.014, S * 0.014);
      ctx.lineTo(0, S * 0.006);
      ctx.lineTo(-S * 0.014, S * 0.014);
      ctx.closePath();
      ctx.fillStyle = '#e11d48';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Compass rose
      ctx.font = `bold ${Math.round(S * 0.03)}px serif`;
      ctx.fillStyle = '#7a5c33';
      ctx.fillText('N', S - S * 0.05, S * 0.05);
      ctx.beginPath();
      ctx.moveTo(S - S * 0.05, S * 0.075);
      ctx.lineTo(S - S * 0.05, S * 0.13);
      ctx.strokeStyle = '#7a5c33';
      ctx.stroke();

    };
    let frame = 0;
    const redraw = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    };
    const unbind = bindMapViewport(canvas, view, redraw, (point) => {
      const x = point.x * WORLD_SIZE - WORLD_HALF;
      const z = point.y * WORLD_SIZE - WORLD_HALF;
      const hit = ex.markers.find((m) => Math.hypot(m.x - x, m.z - z) < 7 / view.zoom);
      if (hit) ex.removeMarker(hit.id);
      else ex.addMarker(x, z, iconRef.current);
    });
    draw();
    const id = window.setInterval(redraw, 250);
    return () => {
      unbind();
      window.clearInterval(id);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [world, ex, heading]);

  return (
    <div className="absolute inset-0 z-40 bg-black/40 flex items-center justify-center pointer-events-auto p-3" onClick={onClose}>
      <div className={`${panel} rounded-3xl p-3 sm:p-4 flex flex-col gap-2 max-h-full`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <div className="text-base font-extrabold">🗺️ {t('map.title')}</div>
          <div className="text-xs font-semibold text-[#8a7556]">{t('map.explored', { pct: explored })}</div>
          <button onClick={onClose} className="w-8 h-8 rounded-xl hover:bg-amber-50 flex items-center justify-center" title={t('common.closeEsc')}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <canvas
          ref={canvasRef}
          width={1024}
          height={1024}
          className="rounded-2xl border-2 border-[#d9c7a3] cursor-crosshair touch-none bg-[#e2d4b2]"
          style={{ width: 'min(78vh, 88vw)', height: 'min(78vh, 88vw)' }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1.5">
            {(Object.keys(MARKER_ICON) as MapMarkerIcon[]).map((k) => (
              <button
                key={k}
                onClick={() => {
                  iconRef.current = k;
                  setIcon(k);
                }}
                title={t(`map.icon.${k}`)}
                className={`w-9 h-9 rounded-xl text-lg transition ${icon === k ? 'bg-amber-200 ring-2 ring-amber-500' : 'bg-white/70 hover:bg-amber-50'}`}
              >
                {MARKER_ICON[k]}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-[#8a7556] max-w-[60ch]">{t('map.hint')}</div>
        </div>
      </div>
    </div>
  );
};
