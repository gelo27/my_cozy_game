import React, { useEffect, useState } from 'react';
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

/**
 * Centre crosshair, shown only while aiming the slingshot (RMB). Telemetry is mutated in place,
 * so the flag is polled once a frame and React re-renders only when it flips.
 */
const AimReticle: React.FC<{ telemetry?: CharacterTelemetry }> = ({ telemetry }) => {
  const [aiming, setAiming] = useState(false);
  useEffect(() => {
    if (!telemetry) return;
    let raf = 0;
    let last = false;
    const tick = () => {
      const now = !!telemetry.isAiming;
      if (now !== last) setAiming((last = now));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [telemetry]);
  return (
    <div
      className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 transition-[opacity,transform] duration-150 ${
        aiming ? 'opacity-100 scale-100' : 'opacity-0 scale-150'
      }`}
    >
      <div className="relative w-7 h-7">
        <div className="absolute inset-0 rounded-full border-2 border-white/85 shadow-[0_0_3px_rgba(0,0,0,0.8),inset_0_0_3px_rgba(0,0,0,0.5)]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_3px_rgba(0,0,0,0.9)]" />
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
