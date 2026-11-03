import React from 'react';
import { CharacterTelemetry } from '../character/CharacterController';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';

interface ViewportHUDProps {
  isWireframe: boolean;
  telemetry?: CharacterTelemetry;
  camera?: ThirdPersonCamera | null;
  maxSlope?: number;
}

/** Minimal centre reticle; brighter while a tool (axe / pickaxe) is in hand. */
export const ViewportHUD: React.FC<ViewportHUDProps> = ({ telemetry }) => {
  const toolReady = telemetry?.activeWeapon === 6 || telemetry?.activeWeapon === 12;
  return (
    <div id="viewport-tactical-hud" className="absolute inset-0 pointer-events-none select-none z-20 overflow-hidden">
      <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 ${toolReady ? '' : 'opacity-50'}`}>
        <div
          className={`w-1.5 h-1.5 rounded-full ${
            toolReady ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-white shadow-[0_0_3px_rgba(0,0,0,0.9)]'
          }`}
        />
      </div>
    </div>
  );
};
