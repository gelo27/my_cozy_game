import React, { useState, useEffect, useRef } from 'react';
import { Terminal, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

export interface ConsoleLogEntry {
  id: string;
  time: string;
  type: 'info' | 'warn' | 'event' | 'camera' | 'physics';
  message: string;
}

interface ConsoleFooterProps {
  logs: ConsoleLogEntry[];
  onClearLogs: () => void;
  isExpanded: boolean;
  setIsExpanded: (val: boolean | ((prev: boolean) => boolean)) => void;
}

export const ConsoleFooter: React.FC<ConsoleFooterProps> = ({
  logs,
  onClearLogs,
  isExpanded,
  setIsExpanded,
}) => {
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of logs on new entry
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const getColorClass = (type: ConsoleLogEntry['type']) => {
    switch (type) {
      case 'info':
        return 'text-emerald-400';
      case 'warn':
        return 'text-amber-400';
      case 'event':
        return 'text-blue-400';
      case 'camera':
        return 'text-purple-400';
      case 'physics':
        return 'text-gray-300';
      default:
        return 'text-gray-400';
    }
  };

  return (
    <footer 
      id="engine-console-footer" 
      className={`bg-[#0a0a0a] border-t border-[#222] font-mono text-[10px] select-none flex flex-col shrink-0 transition-all duration-150 ${
        isExpanded ? 'h-32 md:h-36' : 'h-7'
      }`}
    >
      {/* Console Title Bar */}
      <div className="flex justify-between items-center px-3 py-1 bg-[#121212] border-b border-[#222] text-gray-400 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="w-3 h-3 text-emerald-400" />
          <span className="font-bold text-gray-300">CONSOLE_OUTPUT</span>
          <span className="text-[9px] text-gray-500">// Rapier 3D Physics Pipeline</span>
        </div>

        <div className="flex items-center gap-3 text-[9px]">
          <span className="text-gray-500">
            TOTAL: <span className="text-gray-300">{logs.length}</span> events
          </span>

          <button
            onClick={onClearLogs}
            className="hover:text-gray-200 text-gray-500 flex items-center gap-1 transition-colors"
            title="Clear Log Console"
          >
            <Trash2 className="w-2.5 h-2.5" />
            <span className="hidden sm:inline">CLEAR</span>
          </button>

          <button
            onClick={() => setIsExpanded(prev => !prev)}
            className="text-gray-400 hover:text-white p-0.5"
            title={isExpanded ? 'Collapse Console' : 'Expand Console'}
          >
            {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Log Feed */}
      {isExpanded && (
        <div 
          ref={logContainerRef} 
          className="flex-1 overflow-y-auto px-3 py-1.5 space-y-0.5 leading-relaxed selection:bg-blue-900"
        >
          {logs.length === 0 ? (
            <div className="text-gray-600 italic py-2">No active console output. Step physics simulation to stream telemetry.</div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="flex items-start gap-2">
                <span className="text-gray-600 select-none shrink-0">[{log.time}]</span>
                <span className={`${getColorClass(log.type)} break-all`}>
                  {log.message}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </footer>
  );
};
