import React, { useState, useEffect, useRef } from 'react';
import { 
  Terminal, 
  Layers, 
  Sliders, 
  RotateCcw, 
  Eye, 
  Maximize2, 
  Minimize2,
  Cpu,
  Activity,
  Compass,
  Download,
  Upload
} from 'lucide-react';

interface EngineHeaderProps {
  fps: number;
  physicsTimeMs: number;
  isWireframe: boolean;
  onToggleWireframe: () => void;
  onResetSim: () => void;
  showHierarchy: boolean;
  setShowHierarchy: (val: boolean | ((prev: boolean) => boolean)) => void;
  showInspector: boolean;
  setShowInspector: (val: boolean | ((prev: boolean) => boolean)) => void;
  showConsole: boolean;
  setShowConsole: (val: boolean | ((prev: boolean) => boolean)) => void;
  onExportJSON?: () => void;
  onImportJSON?: (file: File) => void;
}

export const EngineHeader: React.FC<EngineHeaderProps> = ({
  fps,
  physicsTimeMs,
  isWireframe,
  onToggleWireframe,
  onResetSim,
  showHierarchy,
  setShowHierarchy,
  showInspector,
  setShowInspector,
  showConsole,
  setShowConsole,
  onExportJSON,
  onImportJSON,
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.().catch(() => {});
      setIsFullscreen(false);
    }
  };

  const handleTriggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onImportJSON) {
      onImportJSON(file);
      e.target.value = '';
    }
  };

  return (
    <header id="engine-header" className="flex items-center justify-between px-3 py-1.5 bg-[#141414] border-b border-[#262626] text-[#e0e0e0] select-none text-[11px] font-mono z-30 shrink-0">
      {/* Hidden File Input for JSON Scene Import */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".json,application/json"
        className="hidden"
      />

      {/* Left side spacer / branding removed as requested */}
      <div className="flex items-center gap-2">
        {onExportJSON && (
          <button
            id="header-export-json"
            onClick={onExportJSON}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#222] hover:bg-cyan-950/70 text-cyan-300 border border-[#333] hover:border-cyan-500/50 transition-colors text-[10px]"
            title="Експорт поточної конфігурації сцени у файл JSON"
          >
            <Download className="w-3 h-3 text-cyan-400" />
            <span className="hidden sm:inline">Експорт JSON</span>
          </button>
        )}

        {onImportJSON && (
          <button
            id="header-import-json"
            onClick={handleTriggerFileInput}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#222] hover:bg-indigo-950/70 text-indigo-300 border border-[#333] hover:border-indigo-500/50 transition-colors text-[10px]"
            title="Імпортувати та відновити будівлю з файлу JSON"
          >
            <Upload className="w-3 h-3 text-indigo-400" />
            <span className="hidden sm:inline">Імпорт JSON</span>
          </button>
        )}
      </div>

      {/* Center/Right Status Telemetry */}
      <div className="flex items-center gap-2 sm:gap-4 text-[10px] text-gray-400">
        <div className="hidden lg:flex items-center gap-1.5 bg-[#1a1a1a] px-2 py-0.5 border border-[#2a2a2a] rounded">
          <Activity className="w-3 h-3 text-emerald-400" />
          <span>FPS:</span>
          <span className="text-emerald-400 font-bold">{fps.toFixed(0)}</span>
        </div>

        <div className="hidden xl:flex items-center gap-1.5 bg-[#1a1a1a] px-2 py-0.5 border border-[#2a2a2a] rounded">
          <Cpu className="w-3 h-3 text-blue-400" />
          <span>STEP:</span>
          <span className="text-blue-300 font-bold">{physicsTimeMs.toFixed(1)}ms</span>
        </div>

        <div className="hidden sm:inline-block text-gray-500">
          SCENE: <span className="text-gray-300">Testing_Ground_01</span>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5">
          <button
            id="header-wireframe-btn"
            onClick={onToggleWireframe}
            className={`px-2 py-1 flex items-center gap-1 text-[10px] border transition-colors ${
              isWireframe
                ? 'bg-blue-900/40 text-blue-300 border-blue-500'
                : 'bg-[#222] border-[#333] hover:bg-[#2e2e2e] text-gray-300'
            }`}
            title="Toggle Rapier Collider Wireframe (H)"
          >
            <Eye className="w-3 h-3" />
            <span className="hidden sm:inline">WIREFRAME</span>
          </button>

          <button
            id="header-reset-btn"
            onClick={onResetSim}
            className="px-2 py-1 bg-[#222] border border-[#333] hover:bg-[#2e2e2e] text-gray-300 hover:text-white flex items-center gap-1 text-[10px] transition-colors"
            title="Reset Character Position (R)"
          >
            <RotateCcw className="w-3 h-3 text-amber-400" />
            <span>RESET</span>
          </button>

          {/* Panel toggles */}
          <div className="h-4 w-[1px] bg-[#333] mx-1" />

          <button
            onClick={() => setShowHierarchy(prev => !prev)}
            className={`p-1 border transition-colors ${
              showHierarchy
                ? 'bg-[#333] text-blue-400 border-blue-500/50'
                : 'bg-[#1e1e1e] text-gray-500 border-[#2e2e2e] hover:text-gray-300'
            }`}
            title="Toggle Entity Hierarchy Panel"
          >
            <Layers className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => setShowInspector(prev => !prev)}
            className={`p-1 border transition-colors ${
              showInspector
                ? 'bg-[#333] text-blue-400 border-blue-500/50'
                : 'bg-[#1e1e1e] text-gray-500 border-[#2e2e2e] hover:text-gray-300'
            }`}
            title="Toggle Component Inspector Panel"
          >
            <Sliders className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => setShowConsole(prev => !prev)}
            className={`p-1 border transition-colors ${
              showConsole
                ? 'bg-[#333] text-emerald-400 border-emerald-500/50'
                : 'bg-[#1e1e1e] text-gray-500 border-[#2e2e2e] hover:text-gray-300'
            }`}
            title="Toggle Console Output Panel"
          >
            <Terminal className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={toggleFullscreen}
            className="p-1 bg-[#1e1e1e] border border-[#2e2e2e] text-gray-400 hover:text-white"
            title="Toggle Fullscreen"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    </header>
  );
};
