import React, { useEffect, useRef, useState } from 'react';
import type { GameWorld } from '../../engine/GameEngine';
import { SITE_ICON, MARKER_ICON } from './WorldMap';
import { t, useLang } from '../../i18n/i18n';

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
// Memoized: its props never change, so the HUD pushes that re-render App don't rebuild the strip
export const Compass = React.memo(function Compass({ world, heading, inCave }: { world: GameWorld; heading(): number; inCave: boolean }) {
  useLang();
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
    const strip = stripRef.current;
    if (!strip) return;
    // Elements and their numbers are read once per target list, not queried every frame
    interface Slot { el: HTMLElement; bearing: number; tx: number; tz: number; dist: HTMLElement | null; left: string; shown: boolean; label: string }
    const slot = (el: HTMLElement): Slot => ({
      el,
      bearing: Number(el.dataset.bearing ?? 0),
      tx: Number(el.dataset.tx ?? 0),
      tz: Number(el.dataset.tz ?? 0),
      dist: el.querySelector('span'),
      left: el.style.left,
      shown: el.style.opacity !== '0',
      label: '',
    });
    const ticks = Array.from(strip.querySelectorAll<HTMLElement>('[data-bearing]'), slot);
    const marks = Array.from(strip.querySelectorAll<HTMLElement>('[data-tx]'), slot);
    // Style writes only when a value changes: an idle camera costs no style recalculation
    const place = (s: Slot, bearingDeg: number, h: number) => {
      let d = bearingDeg - h;
      d = ((d + 540) % 360) - 180;
      const visible = Math.abs(d) <= HALF_FOV;
      if (visible !== s.shown) {
        s.shown = visible;
        s.el.style.opacity = visible ? '' : '0';
      }
      if (!visible) return;
      const left = `${(50 + (d / HALF_FOV) * 50).toFixed(1)}%`;
      if (left !== s.left) {
        s.left = left;
        s.el.style.left = left;
      }
    };
    let raf = 0;
    let lastH = NaN, lastX = NaN, lastZ = NaN;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const h = (heading() * 180) / Math.PI;
      const ride = world.vehicle.isPlayerInside ? world.vehicle : world.moped.isPlayerInside ? world.moped : world.boat.isPlayerInside ? world.boat : null;
      // surfacePosition allocates a clone, so it's used only in a cave (where it returns the entrance)
      const p = ride ? ride.getPosition() : ex.inCave ? ex.surfacePosition(world.character.getPosition()) : world.character.getPosition();
      if (Math.abs(h - lastH) < 0.05 && Math.abs(p.x - lastX) < 0.05 && Math.abs(p.z - lastZ) < 0.05) return;
      lastH = h; lastX = p.x; lastZ = p.z;
      for (const s of ticks) place(s, s.bearing, h);
      for (const s of marks) {
        const dx = s.tx - p.x;
        const dz = s.tz - p.z;
        place(s, (Math.atan2(dx, -dz) * 180) / Math.PI, h);
        if (s.dist) {
          const label = `${Math.round(Math.hypot(dx, dz) / 5) * 5} m`;
          if (label !== s.label) {
            s.label = label;
            s.dist.textContent = label;
          }
        }
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [world, ex, heading, targets]);

  return (
    <div className={`absolute top-16 left-1/2 -translate-x-1/2 w-[min(440px,70vw)] h-10 rounded-2xl touch:top-12 touch:h-8 touch:w-[min(360px,50vw)] touch:rounded-xl ${panel} overflow-hidden pointer-events-none`}>
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
      {inCave && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#2a2420]/85 text-[#f3e6cc] text-xs font-bold">
          🕯️ {t('explore.inCave')}
        </div>
      )}
    </div>
  );
});
