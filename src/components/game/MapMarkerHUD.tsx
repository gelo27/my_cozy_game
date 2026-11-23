import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { ChevronUp } from 'lucide-react';
import { Vector3, type PerspectiveCamera } from 'three';
import type { GameWorld } from '../../engine/GameEngine';
import { t, useLang } from '../../i18n/i18n';
import { riverWorld } from '../../world/rivers/RiverWorld';
import { MARKER_ICON } from './mapMarkerIcons';

interface Props {
  world: GameWorld;
  camera: PerspectiveCamera;
}

export const MapMarkerHUD: React.FC<Props> = ({ world, camera }) => {
  const exploration = world.exploration;
  const markers = useSyncExternalStore(exploration.subscribeMarkers, exploration.getMarkers);
  const layer = useRef<HTMLDivElement>(null);
  const lang = useLang();

  useEffect(() => {
    const container = layer.current;
    if (!container || markers.length === 0) return;

    const elements = container.querySelectorAll<HTMLDivElement>('[data-map-marker]');
    const entries = markers.map((marker, i) => ({
      x: marker.x,
      z: marker.z,
      y: Math.max(world.terrain.getHeight(marker.x, marker.z), riverWorld.waterLevelAt(marker.x, marker.z)) + 1.5,
      element: elements[i],
      arrow: elements[i].querySelector<HTMLElement>('[data-marker-arrow]')!,
      label: elements[i].querySelector<HTMLElement>('[data-marker-distance]')!,
      distanceSquared: 0,
      meters: -1,
    }));
    const view = new Vector3();
    const placed: { x: number; y: number }[] = entries.map(() => ({ x: 0, y: 0 }));
    const distanceText = new Intl.NumberFormat(lang, { style: 'unit', unit: 'meter', maximumFractionDigits: 0 });
    let width = container.clientWidth;
    let height = container.clientHeight;
    const observer = new ResizeObserver(([{ contentRect }]) => {
      width = contentRect.width;
      height = contentRect.height;
    });
    observer.observe(container);

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!width || !height) return;

      const ride = world.vehicle.isPlayerInside ? world.vehicle : world.moped.isPlayerInside ? world.moped : world.boat.isPlayerInside ? world.boat : null;
      const player = ride ? ride.getPosition() : world.character.getPosition();
      const halfWidth = width / 2;
      const halfHeight = height / 2;
      const edgeX = Math.max(1, halfWidth - 48);
      const edgeTop = Math.max(1, halfHeight - 58);
      const edgeBottom = Math.max(1, halfHeight - 82);
      const projection = camera.projectionMatrix.elements;

      for (const entry of entries) {
        entry.distanceSquared = (entry.x - player.x) ** 2 + (entry.z - player.z) ** 2;
      }
      // When pins overlap, give the nearest one the space.
      entries.sort((a, b) => a.distanceSquared - b.distanceSquared);
      let count = 0;
      for (const entry of entries) {
        view.set(entry.x, entry.y, entry.z).applyMatrix4(camera.matrixWorldInverse);
        const depth = -view.z;
        const dx = view.x * projection[0] * halfWidth;
        let dy = -view.y * projection[5] * halfHeight;
        // Past the camera plane, carry the pin toward the lower edge without mirroring it.
        if (depth <= 0) dy -= depth * height;
        const edgeDepth = Math.max(Math.abs(dx) / edgeX, dy < 0 ? -dy / edgeTop : dy / edgeBottom);
        const offscreen = depth <= camera.near || edgeDepth > depth;
        // A target directly on the camera axis has no screen direction. Point down if it's behind.
        if (offscreen && edgeDepth === 0) dy = edgeBottom;
        const scale = offscreen ? edgeDepth || 1 : depth;
        const x = Math.round(halfWidth + dx / scale);
        const y = Math.round(halfHeight + dy / scale);

        let overlaps = false;
        for (let i = 0; i < count; i++) {
          if (Math.abs(placed[i].x - x) < 52 && Math.abs(placed[i].y - y) < 44) {
            overlaps = true;
            break;
          }
        }
        entry.element.hidden = overlaps;
        if (overlaps) continue;
        placed[count].x = x;
        placed[count++].y = y;

        entry.element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
        entry.arrow.hidden = !offscreen;
        if (offscreen) entry.arrow.style.transform = `rotate(${Math.atan2(dx, -dy)}rad)`;
        const meters = Math.round(Math.sqrt(entry.distanceSquared));
        if (meters !== entry.meters) {
          entry.meters = meters;
          entry.label.textContent = distanceText.format(meters);
        }
      }
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [camera, lang, markers, world]);

  if (!markers.length) return null;
  return (
    <div ref={layer} className="absolute inset-0 overflow-hidden" data-map-marker-hud>
      {markers.map(({ id, icon }) => (
        <div key={id} hidden data-map-marker className="absolute left-0 top-0">
          <div className="flex flex-col items-center gap-0.5">
            <span className="grid h-8 w-8 place-items-center rounded-full border border-[#e9dcc3] bg-[#fffaf0]/95 text-base shadow-md">
              <span role="img" aria-label={t(`map.icon.${icon}`)}>{MARKER_ICON[icon]}</span>
            </span>
            <span data-marker-distance className="whitespace-nowrap rounded-full bg-[#352b20]/90 px-1.5 text-[11px] font-bold tabular-nums leading-4 text-white" />
          </div>
          <span data-marker-arrow hidden aria-hidden="true" className="absolute -right-2 -top-1 rounded-full bg-[#4a3b2a] text-[#fffaf0]">
            <ChevronUp size={15} strokeWidth={3} />
          </span>
        </div>
      ))}
    </div>
  );
};
