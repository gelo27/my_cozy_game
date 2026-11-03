import React from 'react';
import { Upload } from 'lucide-react';
import { ToastMessage } from '../hooks/useToast';

export const ToastPill: React.FC<{ toast: ToastMessage }> = ({ toast }) => (
  <div
    className={`fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl text-xs font-semibold shadow-2xl border animate-in fade-in slide-in-from-top-2 duration-200 flex items-center gap-2 pointer-events-none ${
      toast.type === 'success'
        ? 'bg-emerald-950/90 text-emerald-200 border-emerald-500/60 shadow-emerald-950/50'
        : toast.type === 'warn'
        ? 'bg-amber-950/90 text-amber-200 border-amber-500/60 shadow-amber-950/50'
        : 'bg-stone-900/90 text-cyan-200 border-cyan-500/60 shadow-black/50'
    }`}
  >
    <span>{toast.text}</span>
  </div>
);

export const JsonDropOverlay: React.FC = () => (
  <div className="absolute inset-0 bg-indigo-950/70 border-4 border-dashed border-indigo-400/80 z-50 flex flex-col items-center justify-center text-white pointer-events-none">
    <Upload className="w-12 h-12 text-indigo-300 animate-bounce mb-3" />
    <h3 className="text-lg font-bold text-indigo-100">Відпустіть JSON файл для імпорту сцени</h3>
    <p className="text-xs text-indigo-300 mt-1">Автоматично відновить геометрію деталей, позиції, шпалери та дахи</p>
  </div>
);

export const LoadingOverlay: React.FC = () => (
  <div className="absolute inset-0 bg-[#0c0c0c]/90 flex flex-col items-center justify-center text-white z-50 p-6">
    <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-3" />
    <h2 className="text-xs font-bold tracking-widest uppercase text-blue-400">
      INITIALIZING RAPIER 3D PHYSICS PIPELINE...
    </h2>
    <p className="text-[10px] text-gray-500 mt-1">
      Constructing ECS entities, static colliders, and dynamic player capsule
    </p>
  </div>
);

export const ErrorOverlay: React.FC<{ message: string }> = ({ message }) => (
  <div className="absolute inset-0 bg-[#0c0c0c]/95 flex flex-col items-center justify-center text-rose-400 z-50 p-6 text-center">
    <h2 className="text-xs font-bold uppercase tracking-widest mb-2">Physics Pipeline Error</h2>
    <p className="text-[11px] max-w-md text-gray-400 font-mono">{message}</p>
  </div>
);

/** Subtle studio checker pattern behind the 3D canvas. */
export const CheckerBackground: React.FC = () => (
  <div
    className="absolute inset-0 opacity-15 pointer-events-none"
    style={{
      backgroundImage: `linear-gradient(45deg, #333 25%, transparent 25%), linear-gradient(-45deg, #333 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #333 75%), linear-gradient(-45deg, transparent 75%, #333 75%)`,
      backgroundSize: '32px 32px',
      backgroundPosition: '0 0, 0 16px, 16px -16px, -16px 0px',
    }}
  />
);
