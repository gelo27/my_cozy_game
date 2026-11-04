import React, { useEffect, useRef, useState } from 'react';
import type { GameWorld } from '../../engine/GameEngine';
import { SITE_ICON, MARKER_ICON } from './WorldMap';
import { t } from '../../i18n/i18n';

const panel = 'bg-[#fffaf0]/90 text-[#4a3b2a] border border-[#e9dcc3] shadow-[0_6px_20px_rgba(60,40,10,0.18)]';
/** Half of the visible arc, in degrees. */
const HALF_FOV = 95;
const CARDINALS = [
  ['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315],
] as const;

interface Target {
  key: string;
  icon: string;
  x: number;
  z: number;
  faded: boolean;
}

/**
 * Skyrim-style compass strip. The list of targets (landmarks, the player's pins, the scooter) is
 * React state refreshed twice a second; positions on the strip are written straight to the DOM every
 * animation frame, so turning the camera never re-renders React.
 */
export const Compass: React.FC<{ world: GameWorld; heading(): number }> = ({ world, heading }) => {
  const [targets, setTargets] = useState<Target[]>([]);
  const stripRef = useRef<HTMLDivElement>(null);
  const ex = world.exploration;

  useEffect(() => {
    let lastSig = '';
    const refresh = () => {
      const player = world.character.getPosition();
      const next: Target[] = ex.getMapSites(player).map((s) => ({
        key: s.id,
        icon: s.known ? SITE_ICON[s.kind] : '❓',
        x: s.x,
        z: s.z,
        faded: s.known && s.done,
      }));
      for (const m of ex.markers) next.push({ key: `m${m.id}`, icon: MARKER_ICON[m.icon], x: m.x, z: m.z, faded: false });
      if (!world.moped.isPlayerInside) {
        const p = world.moped.getPosition();
        next.push({ key: 'moped', icon: '🛵', x: p.x, z: p.z, faded: true });
      }
      if (!world.boat.isPlayerInside) {
        const p = world.boat.getPosition();
        next.push({ key: 'boat', icon: '🚤', x: p.x, z: p.z, faded: true });
      }
      const sig = next.map((n) => `${n.key}${n.icon}${n.faded}`).join('|');
      if (sig !== lastSig) {
        lastSig = sig;
        setTargets(next);
      }
    };
    refresh();
    const id = window.setInterval(refresh, 500);
    return () => window.clearInterval(id);
  }, [world, ex]);

  useEffect(() => {
    let raf = 0;
    const place = (el: HTMLElement, bearingDeg: number, h: number) => {
      let d = bearingDeg - h;
      d = ((d + 540) % 360) - 180;
      const visible = Math.abs(d) <= HALF_FOV;
      el.style.opacity = visible ? '' : '0';
      if (visible) el.style.left = `${50 + (d / HALF_FOV) * 50}%`;
    };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const strip = stripRef.current;
      if (!strip) return;
      const h = (heading() * 180) / Math.PI;
      const player = ex.surfacePosition(world.character.getPosition());
      const ride = world.vehicle.isPlayerInside ? world.vehicle : world.moped.isPlayerInside ? world.moped : world.boat.isPlayerInside ? world.boat : null;
      if (ride) player.copy(ride.getPosition());
      for (const el of strip.querySelectorAll<HTMLElement>('[data-bearing]')) place(el, Number(el.dataset.bearing), h);
      for (const el of strip.querySelectorAll<HTMLElement>('[data-tx]')) {
        const dx = Number(el.dataset.tx) - player.x;
        const dz = Number(el.dataset.tz) - player.z;
        place(el, (Math.atan2(dx, -dz) * 180) / Math.PI, h);
        const dist = el.querySelector('span');
        if (dist) {
          const label = `${Math.round(Math.hypot(dx, dz) / 5) * 5} m`;
          if (dist.textContent !== label) dist.textContent = label;
        }
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [world, ex, heading]);

  return (
    <div className={`absolute top-16 left-1/2 -translate-x-1/2 w-[min(440px,70vw)] h-10 rounded-2xl ${panel} overflow-hidden pointer-events-none`}>
      <div ref={stripRef} className="relative w-full h-full">
        {/* Degree ticks every 15° */}
        {Array.from({ length: 24 }, (_, i) => (
          <div key={i} data-bearing={i * 15} className="absolute top-0 -translate-x-1/2 w-px h-1.5 bg-[#b9a27a]" />
        ))}
        {CARDINALS.map(([label, deg]) => (
          <div
            key={label}
            data-bearing={deg}
            className={`absolute top-1 -translate-x-1/2 font-extrabold ${label === 'N' ? 'text-rose-600 text-sm' : label.length === 1 ? 'text-sm' : 'text-[10px] text-[#8a7556]'}`}
          >
            {label}
          </div>
        ))}
        {targets.map((tg) => (
          <div
            key={tg.key}
            data-tx={tg.x}
            data-tz={tg.z}
            className={`absolute top-0.5 -translate-x-1/2 flex flex-col items-center leading-none ${tg.faded ? 'opacity-60' : ''}`}
          >
            <div className="text-base">{tg.icon}</div>
            <span className="text-[8px] font-bold text-[#8a7556] tabular-nums mt-0.5" />
          </div>
        ))}
        <div className="absolute left-1/2 bottom-0 -translate-x-1/2 w-0 h-0 border-l-[5px] border-r-[5px] border-b-[6px] border-l-transparent border-r-transparent border-b-[#4a3b2a]" />
      </div>
      {world.exploration.inCave && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#2a2420]/85 text-[#f3e6cc] text-xs font-bold">
          🕯️ {t('explore.inCave')}
        </div>
      )}
    </div>
  );
};
