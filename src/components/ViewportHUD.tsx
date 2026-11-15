import React, { useEffect, useRef, useState } from 'react';
import { slingshotHud } from '../gameplay/Slingshot';
import { CharacterTelemetry } from '../character/CharacterController';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { ZeldaOxygenWheel } from './ZeldaOxygenWheel';
import { PlayerHearts } from './PlayerHearts';

interface ViewportHUDProps {
  isWireframe: boolean;
  telemetry?: CharacterTelemetry;
  camera?: ThirdPersonCamera | null;
  maxSlope?: number;
  /** Build / paint toolbars take the top centre: the hearts step aside. */
  hideHearts?: boolean;
}

/** Seconds the hit marker shows (longer for the finishing blow). */
const HIT_MARK_MS = 220;
const KILL_MARK_MS = 420;

/**
 * Centre crosshair, shown while aiming (RMB) or drawing the slingshot. The ring closes in as the
 * band is drawn and glows warm at full draw; a hit on an enemy flashes four ticks around it (red
 * on the finishing blow). Telemetry and the slingshot's HUD state are mutated in place, so they
 * are polled once a frame and applied straight to the DOM; React re-renders only when the
 * crosshair shows or hides.
 */
const AimReticle: React.FC<{ telemetry?: CharacterTelemetry }> = ({ telemetry }) => {
  const [aiming, setAiming] = useState(false);
  const ring = useRef<HTMLDivElement>(null);
  const marks = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!telemetry) return;
    let raf = 0;
    let last = false;
    const tick = () => {
      const draw = slingshotHud.drawing ? slingshotHud.draw : 0;
      const now = !!telemetry.isAiming || slingshotHud.drawing;
      if (now !== last) setAiming((last = now));
      const r = ring.current;
      if (r) {
        const full = draw >= 1;
        // From wide open to snug; a gentle pulse once fully drawn
        const pulse = full ? 1 + Math.sin(performance.now() / 70) * 0.04 : 1;
        r.style.transform = `scale(${((slingshotHud.drawing ? 1.7 - 0.75 * draw : 1) * pulse).toFixed(3)})`;
        r.style.borderColor = full ? 'rgba(255,200,90,0.95)' : 'rgba(255,255,255,0.85)';
      }
      const m = marks.current;
      if (m) {
        const t = performance.now();
        const kill = t - slingshotHud.killAt < KILL_MARK_MS;
        const age = kill ? (t - slingshotHud.killAt) / KILL_MARK_MS : (t - slingshotHud.hitAt) / HIT_MARK_MS;
        const on = age >= 0 && age < 1;
        m.style.opacity = on ? String(1 - age * age) : '0';
        m.style.transform = `rotate(45deg) scale(${on ? (0.85 + 0.35 * age).toFixed(3) : '1'})`;
        m.style.color = kill ? '#ff5a4a' : '#ffffff';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [telemetry]);
  const tick = 'absolute bg-current rounded-full shadow-[0_0_3px_rgba(0,0,0,0.9)]';
  return (
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
      <div className={`transition-[opacity,transform] duration-150 ${aiming ? 'opacity-100 scale-100' : 'opacity-0 scale-150'}`}>
        <div className="relative w-7 h-7">
          <div
            ref={ring}
            className="absolute inset-0 rounded-full border-2 border-white/85 shadow-[0_0_3px_rgba(0,0,0,0.8),inset_0_0_3px_rgba(0,0,0,0.5)]"
          />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_3px_rgba(0,0,0,0.9)]" />
        </div>
      </div>
      {/* Hit marker: shows even without the crosshair (hip shots) */}
      <div ref={marks} className="absolute -inset-3 opacity-0" style={{ transform: 'rotate(45deg)' }}>
        <div className={`${tick} left-1/2 top-0 w-[3px] h-2 -translate-x-1/2`} />
        <div className={`${tick} left-1/2 bottom-0 w-[3px] h-2 -translate-x-1/2`} />
        <div className={`${tick} top-1/2 left-0 h-[3px] w-2 -translate-y-1/2`} />
        <div className={`${tick} top-1/2 right-0 h-[3px] w-2 -translate-y-1/2`} />
      </div>
    </div>
  );
};

export const ViewportHUD: React.FC<ViewportHUDProps> = ({ telemetry, camera, hideHearts }) => (
  <div id="viewport-tactical-hud" className="absolute inset-0 pointer-events-none select-none z-20 overflow-hidden">
    <AimReticle telemetry={telemetry} />
    {!hideHearts && <PlayerHearts />}
    <ZeldaOxygenWheel telemetry={telemetry} camera={camera} />
  </div>
);
