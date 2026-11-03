import React, { useRef } from 'react';

export const btn = 'flex items-center justify-center rounded-lg transition-colors';
export const chip = (on: boolean) =>
  `${btn} gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold ${on ? 'bg-sky-500 text-white' : 'bg-white/5 text-zinc-300 hover:bg-white/10'}`;

export const Section: React.FC<{ title: string; children: React.ReactNode; right?: React.ReactNode }> = ({ title, children, right }) => (
  <div className="flex flex-col gap-1.5">
    <div className="flex items-center text-[10px] font-bold uppercase tracking-wider text-zinc-500">
      <span className="flex-1">{title}</span>
      {right}
    </div>
    {children}
  </div>
);

export const Slider: React.FC<{
  label: string; value: number; min: number; max: number; step: number; onChange(v: number): void; fmt?(v: number): string;
  /** Called once when a drag starts (e.g. to push one undo step for the whole drag). */
  onStart?(): void;
}> = ({ label, value, min, max, step, onChange, fmt, onStart }) => (
  <label className="flex flex-col gap-1">
    <span className="flex justify-between text-zinc-400">
      <span>{label}</span>
      <span className="text-zinc-200 tabular-nums">{fmt ? fmt(value) : value}</span>
    </span>
    <input type="range" min={min} max={max} step={step} value={value} onPointerDown={onStart} onKeyDown={onStart} onChange={(e) => onChange(Number(e.target.value))} className="accent-sky-500" />
  </label>
);

export const NumberField: React.FC<{ label: string; value: number; onCommit(v: number): void }> = ({ label, value, onCommit }) => {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] text-zinc-500">{label}</span>
      <input
        ref={ref}
        key={value.toFixed(3)}
        defaultValue={value.toFixed(2)}
        onKeyDown={(e) => e.key === 'Enter' && ref.current?.blur()}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && Math.abs(v - value) > 1e-4) onCommit(v);
        }}
        className="w-full bg-black/30 border border-white/10 rounded px-1.5 py-1 text-zinc-100 tabular-nums outline-none focus:border-sky-500"
      />
    </label>
  );
};
