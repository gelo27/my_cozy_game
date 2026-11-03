import React, { useState } from 'react';
import { CHARACTER_CONFIG } from '../config/constants';
import { 
  Sliders,
  Eye, 
  RotateCcw, 
  Compass, 
  MapPin,
  Zap, 
  ShieldCheck,
  Activity,
  Layers,
  ChevronDown,
  ChevronUp,
  X
} from 'lucide-react';
import { CharacterController } from '../character/CharacterController';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { DebugRenderer } from '../physics/DebugRenderer';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { PlaygroundZone } from './EntityHierarchy';

interface DebugPanelProps {
  controller: CharacterController | null;
  camera: ThirdPersonCamera | null;
  physics: PhysicsWorld | null;
  debugRenderer: DebugRenderer | null;
  onTeleport: (zone: PlaygroundZone) => void;
  onClose?: () => void;
}

export const DebugPanel: React.FC<DebugPanelProps> = ({
  controller,
  camera,
  physics,
  debugRenderer,
  onTeleport,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'inspector' | 'telemetry' | 'presets'>('inspector');
  const [isWireframe, setIsWireframe] = useState(false);

  // Local state for controller parameters
  const [walkSpeed, setWalkSpeed] = useState<number>(CHARACTER_CONFIG.WALK_SPEED);
  const [sprintSpeed, setSprintSpeed] = useState<number>(CHARACTER_CONFIG.SPRINT_SPEED);
  const [jumpForce, setJumpForce] = useState(7.5);
  const [jumpCutMultiplier, setJumpCutMultiplier] = useState(14.0);
  const [gravity, setGravity] = useState(physics ? physics.getGravity() : -22.0);
  const [airControl, setAirControl] = useState(0.45);
  const [maxSlope, setMaxSlope] = useState(48);
  const [camDist, setCamDist] = useState(4.2);
  const [occlusionEnabled, setOcclusionEnabled] = useState(true);
  const [antiSlideEnabled, setAntiSlideEnabled] = useState(true);
  const [steepJumpEnabled, setSteepJumpEnabled] = useState(controller ? controller.allowSteepSlopeJump : true);
  const [wallClimbEnabled, setWallClimbEnabled] = useState(controller ? controller.allowWallClimb : true);

  const handleSteepJumpToggle = (enabled: boolean) => {
    setSteepJumpEnabled(enabled);
    if (controller) {
      controller.allowSteepSlopeJump = enabled;
    }
  };

  const handleWallClimbToggle = (enabled: boolean) => {
    setWallClimbEnabled(enabled);
    if (controller) {
      controller.allowWallClimb = enabled;
    }
  };

  const toggleWireframe = () => {
    if (debugRenderer) {
      const state = debugRenderer.toggle();
      setIsWireframe(state);
    }
  };

  const handleGravityChange = (val: number) => {
    setGravity(val);
    if (physics) {
      physics.setGravity(val);
    }
  };

  const handleWalkSpeedChange = (val: number) => {
    setWalkSpeed(val);
    if (controller) controller.walkSpeed = val;
  };

  const handleSprintSpeedChange = (val: number) => {
    setSprintSpeed(val);
    if (controller) controller.sprintSpeed = val;
  };

  const handleJumpForceChange = (val: number) => {
    setJumpForce(val);
    if (controller) controller.jumpForce = val;
  };

  const handleJumpCutMultiplierChange = (val: number) => {
    setJumpCutMultiplier(val);
    if (controller) controller.jumpCutMultiplier = val;
  };

  const handleAirControlChange = (val: number) => {
    setAirControl(val);
    if (controller) controller.airControl = val;
  };

  const handleMaxSlopeChange = (val: number) => {
    setMaxSlope(val);
    if (controller) controller.maxWalkableSlope = val;
  };

  const handleCamDistChange = (val: number) => {
    setCamDist(val);
    if (camera) camera.targetDistance = val;
  };

  const tele = controller?.telemetry;

  return (
    <aside 
      id="component-inspector-panel" 
      className="w-72 md:w-80 bg-[#121212] border-l border-[#222] flex flex-col font-mono text-[11px] select-none h-full overflow-hidden shrink-0"
    >
      {/* Inspector Header */}
      <div className="px-3 py-2 bg-[#1a1a1a] text-[10px] font-bold border-b border-[#222] text-gray-400 flex justify-between items-center shrink-0">
        <span className="flex items-center gap-1.5 uppercase tracking-wider text-gray-300">
          <Sliders className="w-3 h-3 text-blue-400" />
          COMPONENT INSPECTOR
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-gray-500 font-normal">v2.1</span>
          {onClose && (
            <button onClick={onClose} className="text-gray-500 hover:text-white">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex bg-[#161616] border-b border-[#222] p-1 gap-1 shrink-0">
        <button
          onClick={() => setActiveTab('inspector')}
          className={`flex-1 py-1 px-2 text-[10px] font-bold rounded transition-colors ${
            activeTab === 'inspector'
              ? 'bg-[#262626] text-blue-400 border border-[#333]'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          TUNING
        </button>
        <button
          onClick={() => setActiveTab('telemetry')}
          className={`flex-1 py-1 px-2 text-[10px] font-bold rounded transition-colors ${
            activeTab === 'telemetry'
              ? 'bg-[#262626] text-blue-400 border border-[#333]'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          TELEMETRY
        </button>
        <button
          onClick={() => setActiveTab('presets')}
          className={`flex-1 py-1 px-2 text-[10px] font-bold rounded transition-colors ${
            activeTab === 'presets'
              ? 'bg-[#262626] text-blue-400 border border-[#333]'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          TELEPORT
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
        {/* TAB 1: INSPECTOR / TUNING */}
        {activeTab === 'inspector' && (
          <>
            {/* Movement Controller Section */}
            <section>
              <h3 className="text-[10px] font-bold text-blue-400 mb-2.5 uppercase tracking-wider flex items-center justify-between">
                <span>Movement Controller</span>
                <span className="text-[9px] text-gray-500">DYNAMIC</span>
              </h3>
              <div className="space-y-2.5">
                <div>
                  <div className="flex justify-between text-[9px] text-gray-400 mb-1">
                    <span>WALK_SPEED</span>
                    <span className="text-blue-300 font-bold">{walkSpeed.toFixed(1)} m/s</span>
                  </div>
                  <input
                    type="range"
                    min="0.2"
                    max="6.0"
                    step="0.1"
                    value={walkSpeed}
                    onChange={(e) => handleWalkSpeedChange(parseFloat(e.target.value))}
                    className="w-full h-1 bg-[#333] rounded appearance-none cursor-pointer accent-blue-500"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[9px] text-gray-400 mb-1">
                    <span>SPRINT_SPEED</span>
                    <span className="text-blue-300 font-bold">{sprintSpeed.toFixed(1)} m/s</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="12.0"
                    step="0.1"
                    value={sprintSpeed}
                    onChange={(e) => handleSprintSpeedChange(parseFloat(e.target.value))}
                    className="w-full h-1 bg-[#333] rounded appearance-none cursor-pointer accent-blue-500"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[9px] text-gray-400 mb-1">
                    <span>AIR_CONTROL_FACTOR</span>
                    <span className="text-blue-300 font-bold">{airControl.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.1"
                    max="1.0"
                    step="0.05"
                    value={airControl}
                    onChange={(e) => handleAirControlChange(parseFloat(e.target.value))}
                    className="w-full h-1 bg-[#333] rounded appearance-none cursor-pointer accent-blue-500"
                  />
                </div>

                <div className="flex items-center justify-between pt-1 text-[10px]">
                  <span className="text-gray-300">Friction & Slope Dampening</span>
                  <button
                    onClick={() => setAntiSlideEnabled(!antiSlideEnabled)}
                    className={`w-7 h-3.5 rounded-full relative transition-colors ${
                      antiSlideEnabled ? 'bg-blue-600' : 'bg-[#333]'
                    }`}
                  >
                    <div
                      className={`absolute top-0.5 w-2.5 h-2.5 bg-white rounded-full transition-transform ${
                        antiSlideEnabled ? 'right-0.5' : 'left-0.5'
                      }`}
                    />
                  </button>
                </div>

                <div className="flex items-center justify-between pt-1 border-t border-[#222] text-[10px]">
                  <div>
                    <span className="text-gray-300 font-bold block">Wall Climbing Mechanic</span>
                    <span className="text-[9px] text-gray-500">Enable/disable wall climbing & vaulting</span>
                  </div>
                  <button
                    onClick={() => handleWallClimbToggle(!wallClimbEnabled)}
                    className={`w-7 h-3.5 rounded-full relative transition-colors shrink-0 ${
                      wallClimbEnabled ? 'bg-pink-600' : 'bg-[#333]'
                    }`}
                  >
                    <div
                      className={`absolute top-0.5 w-2.5 h-2.5 bg-white rounded-full transition-transform ${
                        wallClimbEnabled ? 'right-0.5' : 'left-0.5'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </section>

            {/* Jump & Gravity Section */}
            <section className="pt-3 border-t border-[#222]">
              <h3 className="text-[10px] font-bold text-yellow-400 mb-2.5 uppercase tracking-wider flex items-center justify-between">
                <span>Jump & Vertical Impulse</span>
                <span className="text-[9px] text-yellow-500/80">COYOTE 0.16s</span>
              </h3>
              <div className="space-y-2.5">
                <div className="flex justify-between items-center text-[10px]">
                  <span className="text-gray-400">Launch Velocity</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={jumpForce}
                      step="0.2"
                      min="3.0"
                      max="16.0"
                      onChange={(e) => handleJumpForceChange(parseFloat(e.target.value) || 7.5)}
                      className="bg-[#222] border border-[#333] w-14 px-1.5 py-0.5 text-center text-white text-[10px] rounded"
                    />
                    <span className="text-gray-500 text-[9px]">m/s</span>
                  </div>
                </div>

                <div>
                  <input
                    type="range"
                    min="4.0"
                    max="15.0"
                    step="0.2"
                    value={jumpForce}
                    onChange={(e) => handleJumpForceChange(parseFloat(e.target.value))}
                    className="w-full h-1 bg-[#333] rounded appearance-none cursor-pointer accent-yellow-500"
                  />
                </div>

                {/* Jump Cut Force */}
                <div className="flex justify-between items-center text-[10px]">
                  <span className="text-gray-400">Jump Cut Force (Early Release)</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={jumpCutMultiplier}
                      step="1.0"
                      min="4.0"
                      max="30.0"
                      onChange={(e) => handleJumpCutMultiplierChange(parseFloat(e.target.value) || 14.0)}
                      className="bg-[#222] border border-[#333] w-14 px-1.5 py-0.5 text-center text-white text-[10px] rounded"
                    />
                    <span className="text-gray-500 text-[9px]">x</span>
                  </div>
                </div>

                <div>
                  <input
                    type="range"
                    min="4.0"
                    max="30.0"
                    step="1.0"
                    value={jumpCutMultiplier}
                    onChange={(e) => handleJumpCutMultiplierChange(parseFloat(e.target.value))}
                    className="w-full h-1 bg-[#333] rounded appearance-none cursor-pointer accent-amber-400"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2 text-[9px] bg-[#181818] p-2 border border-[#262626] rounded">
                  <div>
                    <span className="text-gray-500 block">COYOTE TIME:</span>
                    <span className="text-gray-300 font-bold">160 ms</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block">JUMP BUFFER:</span>
                    <span className="text-gray-300 font-bold">120 ms</span>
                  </div>
                </div>
              </div>
            </section>

            {/* Gravity Regulator Section */}
            <section className="pt-3 border-t border-[#222]">
              <h3 className="text-[10px] font-bold text-amber-400 mb-2.5 uppercase tracking-wider flex items-center justify-between">
                <span>Gravity Regulator</span>
                <span className="text-[9px] text-amber-300 font-bold">{gravity.toFixed(1)} m/s²</span>
              </h3>
              <div className="space-y-2.5">
                <div className="flex justify-between items-center text-[10px]">
                  <span className="text-gray-400">World Gravity (Y)</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={gravity}
                      step="1.0"
                      min="-60.0"
                      max="-2.0"
                      onChange={(e) => handleGravityChange(parseFloat(e.target.value) || -22.0)}
                      className="bg-[#222] border border-[#333] w-14 px-1.5 py-0.5 text-center text-white text-[10px] rounded"
                    />
                    <span className="text-gray-500 text-[9px]">m/s²</span>
                  </div>
                </div>

                <div>
                  <input
                    type="range"
                    min="-50.0"
                    max="-4.0"
                    step="0.5"
                    value={gravity}
                    onChange={(e) => handleGravityChange(parseFloat(e.target.value))}
                    className="w-full h-1 bg-[#333] rounded appearance-none cursor-pointer accent-amber-500"
                  />
                </div>

                {/* Quick Gravity Presets */}
                <div className="grid grid-cols-4 gap-1 pt-0.5">
                  <button
                    onClick={() => handleGravityChange(-5.0)}
                    className={`py-1 text-[9px] font-bold rounded border transition-colors ${
                      gravity === -5.0
                        ? 'bg-amber-950/70 border-amber-500 text-amber-300'
                        : 'bg-[#1e1e1e] border-[#333] text-gray-400 hover:text-white'
                    }`}
                  >
                    Moon
                  </button>
                  <button
                    onClick={() => handleGravityChange(-12.0)}
                    className={`py-1 text-[9px] font-bold rounded border transition-colors ${
                      gravity === -12.0
                        ? 'bg-amber-950/70 border-amber-500 text-amber-300'
                        : 'bg-[#1e1e1e] border-[#333] text-gray-400 hover:text-white'
                    }`}
                  >
                    Low
                  </button>
                  <button
                    onClick={() => handleGravityChange(-22.0)}
                    className={`py-1 text-[9px] font-bold rounded border transition-colors ${
                      gravity === -22.0
                        ? 'bg-amber-950/70 border-amber-500 text-amber-300'
                        : 'bg-[#1e1e1e] border-[#333] text-gray-400 hover:text-white'
                    }`}
                  >
                    Default
                  </button>
                  <button
                    onClick={() => handleGravityChange(-35.0)}
                    className={`py-1 text-[9px] font-bold rounded border transition-colors ${
                      gravity === -35.0
                        ? 'bg-amber-950/70 border-amber-500 text-amber-300'
                        : 'bg-[#1e1e1e] border-[#333] text-gray-400 hover:text-white'
                    }`}
                  >
                    Heavy
                  </button>
                </div>
              </div>
            </section>

            {/* Slope Physics Section */}
            <section className="pt-3 border-t border-[#222]">
              <h3 className="text-[10px] font-bold text-emerald-400 mb-2.5 uppercase tracking-wider flex items-center justify-between">
                <span>Slope & Raycast Logic</span>
                <span className="text-[9px] text-emerald-500">5-RAY ARRAY</span>
              </h3>
              <div className="space-y-2.5">
                <div>
                  <div className="flex justify-between text-[9px] text-gray-400 mb-1">
                    <span>MAX_WALKABLE_SLOPE</span>
                    <span className="text-emerald-400 font-bold">{maxSlope}°</span>
                  </div>
                  <input
                    type="range"
                    min="20"
                    max="70"
                    step="1"
                    value={maxSlope}
                    onChange={(e) => handleMaxSlopeChange(parseInt(e.target.value))}
                    className="w-full h-1 bg-[#333] rounded appearance-none cursor-pointer accent-emerald-500"
                  />
                </div>

                <div className="text-[9px] text-gray-500">
                  Slopes &gt; {maxSlope}° cause natural gravity sliding; slopes &le; {maxSlope}° trigger tangent project &amp; anti-slide compensation.
                </div>

                {/* Steep Slope Jump Toggle */}
                <div className="flex items-center justify-between pt-1 border-t border-[#222]">
                  <div>
                    <span className="text-[10px] text-gray-200 font-bold block">Steep Slope Jumping</span>
                    <span className="text-[9px] text-gray-500">Allow jump on non-walkable slopes (&gt;{maxSlope}°)</span>
                  </div>
                  <button
                    onClick={() => handleSteepJumpToggle(!steepJumpEnabled)}
                    className={`w-7 h-3.5 rounded-full relative transition-colors shrink-0 ${
                      steepJumpEnabled ? 'bg-emerald-600' : 'bg-[#333]'
                    }`}
                  >
                    <div
                      className={`absolute top-0.5 w-2.5 h-2.5 bg-white rounded-full transition-transform ${
                        steepJumpEnabled ? 'right-0.5' : 'left-0.5'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </section>

            {/* Camera System Section */}
            <section className="pt-3 border-t border-[#222]">
              <h3 className="text-[10px] font-bold text-purple-400 mb-2.5 uppercase tracking-wider flex items-center justify-between">
                <span>Camera System</span>
                <span className="text-[9px] text-purple-500">OCCLUSION RAY</span>
              </h3>
              <div className="space-y-2.5">
                <div>
                  <div className="flex justify-between text-[9px] text-gray-400 mb-1">
                    <span>TARGET_DISTANCE</span>
                    <span className="text-purple-300 font-bold">{camDist.toFixed(1)}m</span>
                  </div>
                  <input
                    type="range"
                    min="1.5"
                    max="8.0"
                    step="0.5"
                    value={camDist}
                    onChange={(e) => handleCamDistChange(parseFloat(e.target.value))}
                    className="w-full h-1 bg-[#333] rounded appearance-none cursor-pointer accent-purple-500"
                  />
                </div>

                <div className="space-y-1.5 pt-1 text-[10px]">
                  <label className="flex items-center gap-2 text-gray-300 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={occlusionEnabled} 
                      onChange={(e) => setOcclusionEnabled(e.target.checked)}
                      className="accent-purple-500 rounded" 
                    />
                    <span>Occlusion Raycast Protection</span>
                  </label>
                  <label className="flex items-center gap-2 text-gray-300 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked 
                      readOnly
                      className="accent-purple-500 rounded" 
                    />
                    <span>Spherical Pitch/Yaw Damping</span>
                  </label>
                </div>
              </div>
            </section>
          </>
        )}

        {/* TAB 2: LIVE TELEMETRY */}
        {activeTab === 'telemetry' && (
          <div className="space-y-3">
            {/* Ground State Card */}
            <div className="bg-[#181818] p-2.5 border border-[#2a2a2a] rounded space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-gray-500 text-[10px]">GROUND_STATE:</span>
                {tele?.isGrounded ? (
                  <span className="text-emerald-400 font-bold flex items-center gap-1 text-[10px]">
                    <ShieldCheck className="w-3 h-3" /> GROUNDED
                  </span>
                ) : (
                  <span className="text-amber-400 font-bold flex items-center gap-1 text-[10px]">
                    <Activity className="w-3 h-3" /> IN_AIR
                  </span>
                )}
              </div>

              <div className="flex justify-between items-center">
                <span className="text-gray-500 text-[10px]">SLOPE_ANGLE:</span>
                <span
                  className={`font-bold text-[10px] ${
                    (tele?.slopeAngleDeg ?? 0) <= maxSlope ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {(tele?.slopeAngleDeg ?? 0).toFixed(1)}° {(tele?.slopeAngleDeg ?? 0) <= maxSlope ? '(Walkable)' : '(Slide)'}
                </span>
              </div>
            </div>

            {/* Velocity Vectors */}
            <div className="bg-[#181818] p-2.5 border border-[#2a2a2a] rounded space-y-1.5 text-[10px]">
              <div className="flex justify-between">
                <span className="text-gray-500">SPEED:</span>
                <span className="text-blue-300 font-bold">{(tele?.speed ?? 0).toFixed(2)} m/s</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">VELOCITY_Y:</span>
                <span className="text-gray-200 font-bold">{(tele?.velocity.y ?? 0).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">POSITION_Y:</span>
                <span className="text-gray-200 font-bold">{(tele?.position.y ?? 0).toFixed(2)}</span>
              </div>
              <div className="flex justify-between border-t border-[#262626] pt-1">
                <span className="text-gray-500">GRAVITY_Y:</span>
                <span className="text-amber-300 font-bold">{gravity.toFixed(1)} m/s²</span>
              </div>
            </div>

            {/* Surface Normal Vector */}
            <div className="bg-[#181818] p-2.5 border border-[#2a2a2a] rounded text-[10px] space-y-1">
              <span className="text-gray-500 block">SURFACE_NORMAL:</span>
              <span className="text-gray-300 font-bold">
                [{tele?.groundNormal.x.toFixed(2)}, {tele?.groundNormal.y.toFixed(2)}, {tele?.groundNormal.z.toFixed(2)}]
              </span>
            </div>

            {/* Zelda BotW Oxygen & Stamina Telemetry Card */}
            <div className="bg-[#181818] p-2.5 border border-cyan-900/50 rounded text-[10px] space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-cyan-400 font-bold">ZELDA O₂ / STAMINA:</span>
                <span className={`font-extrabold ${
                  (tele?.oxygen ?? 100) <= 25 ? 'text-red-400 animate-pulse' : 'text-cyan-300'
                }`}>
                  {(tele?.oxygen ?? 100).toFixed(1)}% / {(tele?.maxOxygen ?? 100)}%
                </span>
              </div>
              <div className="w-full h-1.5 bg-black/80 rounded-full overflow-hidden border border-cyan-950">
                <div
                  className="h-full transition-all duration-75"
                  style={{
                    width: `${Math.max(0, Math.min(100, tele?.oxygen ?? 100))}%`,
                    backgroundColor: (tele?.oxygen ?? 100) <= 25 ? '#ff3344' : '#00ffff',
                    boxShadow: '0 0 6px #00ffff',
                  }}
                />
              </div>
              <div className="flex justify-between text-[9px] text-gray-400">
                <span>Underwater: <b className={tele?.isUnderwater ? 'text-cyan-300' : 'text-gray-500'}>{tele?.isUnderwater ? 'YES' : 'NO'}</b></span>
                <span>Drowning: <b className={tele?.isDrowning ? 'text-red-400 animate-pulse' : 'text-gray-500'}>{tele?.isDrowning ? 'ACTIVE' : 'NO'}</b></span>
              </div>
            </div>

            {/* Active Ability Chips */}
            <div>
              <span className="text-[9px] text-gray-500 uppercase block mb-1.5">Active States</span>
              <div className="flex flex-wrap gap-1">
                <span
                  className={`px-2 py-0.5 rounded text-[9px] font-bold border ${
                    tele?.isUnderwater
                      ? 'bg-cyan-950/90 text-cyan-200 border-cyan-400 shadow-[0_0_8px_rgba(0,255,255,0.4)] animate-pulse'
                      : 'bg-[#181818] text-gray-600 border-[#2a2a2a]'
                  }`}
                >
                  OXYGEN DRAIN
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[9px] font-bold border ${
                    tele?.isDrowning
                      ? 'bg-red-950/90 text-red-300 border-red-500 shadow-[0_0_10px_rgba(255,0,0,0.6)] animate-bounce'
                      : 'bg-[#181818] text-gray-600 border-[#2a2a2a]'
                  }`}
                >
                  DROWNING
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[9px] font-bold border ${
                    tele?.isSprinting
                      ? 'bg-amber-950/60 text-amber-300 border-amber-500/60'
                      : 'bg-[#181818] text-gray-600 border-[#2a2a2a]'
                  }`}
                >
                  SPRINT
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[9px] font-bold border ${
                    tele?.isCrouching
                      ? 'bg-indigo-950/60 text-indigo-300 border-indigo-500/60'
                      : 'bg-[#181818] text-gray-600 border-[#2a2a2a]'
                  }`}
                >
                  CROUCH
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[9px] font-bold border ${
                    tele?.isDashing
                      ? 'bg-rose-950/60 text-rose-300 border-rose-500/60'
                      : 'bg-[#181818] text-gray-600 border-[#2a2a2a]'
                  }`}
                >
                  DASH
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[9px] font-bold border ${
                    tele?.isSwimming
                      ? 'bg-cyan-950/90 text-cyan-300 border-cyan-500/80 animate-pulse'
                      : 'bg-[#181818] text-gray-600 border-[#2a2a2a]'
                  }`}
                >
                  SWIMMING
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[9px] font-bold border ${
                    tele?.isMantling
                      ? 'bg-amber-950/90 text-amber-300 border-amber-500/80 animate-bounce'
                      : 'bg-[#181818] text-gray-600 border-[#2a2a2a]'
                  }`}
                >
                  MANTLE
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[9px] font-bold border ${
                    tele?.isClimbing
                      ? 'bg-pink-950/90 text-pink-300 border-pink-500/80 animate-pulse'
                      : 'bg-[#181818] text-gray-600 border-[#2a2a2a]'
                  }`}
                >
                  WALL CLIMB
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[9px] font-bold border ${
                    tele?.isHoldingObject
                      ? 'bg-emerald-950/90 text-emerald-300 border-emerald-500/80 animate-pulse'
                      : 'bg-[#181818] text-gray-600 border-[#2a2a2a]'
                  }`}
                >
                  HOLDING OVERHEAD
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[9px] font-bold border ${
                    (tele?.slopeAngleDeg ?? 0) > 2.0 && (tele?.slopeAngleDeg ?? 0) <= maxSlope
                      ? 'bg-emerald-950/60 text-emerald-300 border-emerald-500/60'
                      : 'bg-[#181818] text-gray-600 border-[#2a2a2a]'
                  }`}
                >
                  ANTI_SLIDE
                </span>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: TELEPORT PRESETS */}
        {activeTab === 'presets' && (
          <div className="space-y-1.5">
            <span className="text-[9px] text-gray-500 uppercase block mb-1">Instant Teleport Targets</span>
            
            <button
              onClick={() => onTeleport('origin')}
              className="w-full flex items-center justify-between p-2 bg-[#181818] hover:bg-[#222] border border-[#2a2a2a] text-left transition-colors text-gray-300 rounded"
            >
              <span className="flex items-center gap-2">
                <MapPin className="w-3.5 h-3.5 text-blue-400" />
                <span>Arena Spawn Center</span>
              </span>
              <span className="text-[9px] text-gray-500">[0, 2, 5]</span>
            </button>
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="p-2.5 bg-[#161616] border-t border-[#222] flex items-center justify-between gap-1 shrink-0">
        <button
          onClick={toggleWireframe}
          className={`px-2 py-1 flex items-center gap-1 text-[10px] font-bold border rounded transition-colors ${
            isWireframe
              ? 'bg-blue-900/40 text-blue-300 border-blue-500'
              : 'bg-[#222] text-gray-400 border-[#333] hover:text-white'
          }`}
        >
          <Eye className="w-3 h-3" />
          <span>WIREFRAME</span>
        </button>

        <button
          onClick={() => onTeleport('origin')}
          className="px-2 py-1 bg-[#222] hover:bg-[#2c2c2c] border border-[#333] text-gray-300 hover:text-white flex items-center gap-1 text-[10px] font-bold rounded transition-colors"
        >
          <RotateCcw className="w-3 h-3 text-amber-400" />
          <span>RESET (R)</span>
        </button>
      </div>
    </aside>
  );
};
