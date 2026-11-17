import React from 'react';
import { ChevronDown, ChevronUp, Hammer, Paintbrush, Check } from 'lucide-react';
import { t } from '../../i18n/i18n';

/**
 * Shared frame of the build and paint modes, in the HUD's look (cream panels, brown text, orange
 * accent). Laid out the way cosy builders (Heartopia, The Sims, Townscaper) do it:
 * - top: a Build | Paint switch and Done, nothing else;
 * - right: one column of round tool buttons (hotkey badges on PC);
 * - bottom: a shelf of categories and cards that folds down to a slim bar;
 * - under the crosshair: one small status line about what is aimed at;
 * - phones: a big primary button (Place / Paint) under the right thumb.
 */

export const panel = 'bg-[#fffaf0]/97 text-[#4a3b2a] border border-[#e9dcc3] shadow-[0_10px_40px_rgba(60,40,10,0.35)]';
const keyBadge =
  'absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-md bg-[#4a3b2a] text-white text-[10px] font-bold leading-[18px] text-center shadow touch:hidden';

export type BuildTab = 'build' | 'paint';

/** Top: the mode switch, an optional confirm and Done. */
export const ModeBar: React.FC<{
  tab: BuildTab;
  onTab(tab: BuildTab): void;
  onDone(): void;
  /** Green confirm with a count (unmerged walls / floors) */
  confirm?: { count: number; onClick(): void } | null;
}> = ({ tab, onTab, onDone, confirm }) => {
  const seg = (id: BuildTab, label: string, key: string, Icon: typeof Hammer) => (
    <button
      onClick={() => tab !== id && onTab(id)}
      title={`${label} (${key})`}
      className={`relative flex items-center gap-2 px-4 h-10 touch:h-9 touch:px-3 rounded-xl text-sm font-bold transition ${
        tab === id ? 'bg-amber-500 text-white shadow' : 'text-[#a08d70] hover:text-[#4a3b2a]'
      }`}
    >
      <Icon className="w-4 h-4" />
      <span>{label}</span>
      <span className={`${keyBadge} ${tab === id ? '!hidden' : ''}`}>{key}</span>
    </button>
  );
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 pointer-events-auto flex items-center gap-2 max-w-[calc(100vw-16px)]">
      <div className={`${panel} flex items-center gap-1 p-1 rounded-2xl`}>
        {seg('build', t('bui.build'), 'B', Hammer)}
        {seg('paint', t('bui.paint'), 'P', Paintbrush)}
      </div>
      {confirm && confirm.count > 0 && (
        <button
          onClick={confirm.onClick}
          title={t('build.confirmTitle')}
          className="h-12 touch:h-11 px-3 rounded-2xl bg-emerald-500 text-white font-bold text-sm flex items-center gap-1.5 shadow-[0_10px_30px_rgba(16,120,80,0.35)] border border-emerald-300 hover:bg-emerald-400 active:scale-95 transition"
        >
          <Check className="w-4 h-4" />
          <span className="touch:hidden">{t('build.confirm')}</span>
          <span className="min-w-[20px] h-5 px-1 rounded-full bg-white/25 text-xs leading-5 text-center">{confirm.count}</span>
        </button>
      )}
      <button
        onClick={onDone}
        title={`${t('bui.done')} (Esc)`}
        className={`${panel} relative h-12 touch:h-11 px-4 rounded-2xl font-bold text-sm flex items-center gap-1.5 hover:bg-amber-50 active:scale-95 transition`}
      >
        <Check className="w-4 h-4 text-amber-600" />
        <span>{t('bui.done')}</span>
        <span className={keyBadge}>Esc</span>
      </button>
    </div>
  );
};

/** Right: the column of tool buttons. */
export const ToolColumn: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="absolute right-3 top-1/2 -translate-y-1/2 touch:top-20 touch:translate-y-0 short:top-16 pointer-events-auto flex flex-col gap-2.5 touch:gap-2 short:grid short:grid-cols-2 short:gap-1.5">
    {children}
  </div>
);

export const ToolButton: React.FC<{
  label: string;
  hotkey?: string;
  active?: boolean;
  disabled?: boolean;
  tone?: 'normal' | 'danger';
  onClick(): void;
  children: React.ReactNode;
}> = ({ label, hotkey, active, disabled, tone = 'normal', onClick, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={hotkey ? `${label} (${hotkey})` : label}
    aria-label={label}
    className={`relative w-12 h-12 touch:w-11 touch:h-11 short:w-10 short:h-10 rounded-full flex items-center justify-center transition active:scale-90 disabled:opacity-40 disabled:pointer-events-none border-2 shadow-[0_6px_20px_rgba(60,40,10,0.3)] ${
      active
        ? 'bg-amber-500 border-amber-300 text-white'
        : tone === 'danger'
          ? 'bg-[#fffaf0] border-rose-300 text-rose-600 hover:bg-rose-50'
          : 'bg-[#fffaf0] border-[#e9dcc3] text-[#4a3b2a] hover:bg-amber-50'
    }`}
  >
    {children}
    {hotkey && <span className={keyBadge}>{hotkey}</span>}
  </button>
);

/** Phones: the big primary button (place / paint) under the right thumb. */
export const PrimaryAction: React.FC<{ label: string; disabled?: boolean; onPress(): void; children: React.ReactNode }> = ({
  label,
  disabled,
  onPress,
  children,
}) => (
  <button
    // Pointer down, not click: it must act at once and also work while the other thumb walks
    onPointerDown={(e) => {
      e.preventDefault();
      if (!disabled) onPress();
    }}
    aria-label={label}
    className={`hidden touch:flex absolute right-3 bottom-[156px] short:bottom-[136px] short:right-[104px] pointer-events-auto w-[72px] h-[72px] short:w-16 short:h-16 rounded-full flex-col items-center justify-center gap-0.5 text-white font-bold text-[10px] border-4 shadow-[0_10px_30px_rgba(60,40,10,0.4)] active:scale-90 transition touch-none ${
      disabled ? 'bg-stone-400 border-stone-300 opacity-70' : 'bg-amber-500 border-amber-300'
    }`}
  >
    {children}
    <span className="leading-none">{label}</span>
  </button>
);

/** Under the crosshair: what is aimed at / why it can't go here. */
export const AimStatus: React.FC<{ tone: 'ok' | 'bad' | 'info'; children: React.ReactNode }> = ({ tone, children }) => (
  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 translate-y-6 pointer-events-none">
    <div
      className={`${panel} !shadow-[0_4px_14px_rgba(60,40,10,0.25)] rounded-full px-3 py-1 text-xs font-bold whitespace-nowrap flex items-center gap-1.5 max-w-[80vw] ${
        tone === 'ok' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-600' : ''
      }`}
    >
      {children}
    </div>
  </div>
);

export const Crosshair: React.FC = () => (
  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none w-3.5 h-3.5 rounded-full border-2 border-white/90 bg-black/30 shadow-[0_0_8px_rgba(0,0,0,0.6)] flex items-center justify-center">
    <div className="w-1 h-1 rounded-full bg-white" />
  </div>
);

export interface ShelfTab {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

/**
 * Bottom: category chips and a row of cards. Folds down to the chips row alone (the world stays
 * visible); the wheel scrolls the rows sideways on PC.
 */
export const Shelf: React.FC<{
  tabs: ShelfTab[];
  active: string;
  onTab(id: string): void;
  open: boolean;
  onToggle(): void;
  /** Extra panel between the chips and the cards (roof style, dormers) */
  extra?: React.ReactNode;
  /** What the folded shelf shows next to the chips (the item in hand) */
  current?: React.ReactNode;
  children: React.ReactNode;
}> = ({ tabs, active, onTab, open, onToggle, extra, current, children }) => {
  const wheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY !== 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
  };
  return (
    <div className="absolute bottom-3 touch:bottom-2 inset-x-2 mx-auto max-w-4xl touch:max-w-none pointer-events-auto">
      <div className={`${panel} rounded-3xl touch:rounded-2xl p-2 flex flex-col gap-2`}>
        <div className="flex items-center gap-2">
          <div onWheel={wheel} className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  onTab(tab.id);
                  if (!open) onToggle();
                }}
                className={`shrink-0 h-9 touch:h-8 px-3 rounded-full text-xs font-bold flex items-center gap-1.5 transition whitespace-nowrap ${
                  active === tab.id ? 'bg-amber-500 text-white shadow' : 'bg-[#efe4cf] text-[#7a6650] hover:bg-[#e9dcc3]'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
          {!open && current}
          <button
            onClick={onToggle}
            title={open ? t('bui.hide') : t('bui.show')}
            aria-label={open ? t('bui.hide') : t('bui.show')}
            className="shrink-0 w-9 h-9 touch:w-8 touch:h-8 rounded-full bg-[#efe4cf] hover:bg-[#e9dcc3] text-[#7a6650] flex items-center justify-center transition"
          >
            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        </div>
        {open && extra}
        {open && (
          <div onWheel={wheel} className="flex items-stretch gap-2 overflow-x-auto no-scrollbar pb-0.5">
            {children}
          </div>
        )}
      </div>
    </div>
  );
};

/** A card on the shelf. */
export const ShelfCard: React.FC<{
  selected?: boolean;
  accent?: boolean;
  title: string;
  onClick(): void;
  children: React.ReactNode;
}> = ({ selected, accent, title, onClick, children }) => (
  <button
    onClick={onClick}
    title={title}
    className={`relative shrink-0 w-[84px] h-[84px] touch:w-[72px] touch:h-[72px] short:w-16 short:h-16 rounded-2xl touch:rounded-xl border-2 flex flex-col items-center justify-center overflow-hidden transition active:scale-95 ${
      selected
        ? 'border-amber-500 bg-amber-50 shadow-[0_0_0_3px_rgba(245,158,11,0.25)]'
        : accent
          ? 'border-amber-300 bg-amber-100/70 hover:bg-amber-100'
          : 'border-[#efe4cf] bg-white hover:border-[#e2d5bc]'
    }`}
  >
    {children}
  </button>
);

/** Rounded section inside the shelf (roof style, dormers). */
export const ShelfSection: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-2xl bg-[#f6eedd] px-3 py-2 text-xs flex flex-col gap-1.5">{children}</div>
);

export const Chip: React.FC<{ active?: boolean; danger?: boolean; onClick(): void; children: React.ReactNode }> = ({ active, danger, onClick, children }) => (
  <button
    onClick={onClick}
    className={`h-8 px-3 rounded-full text-xs font-bold transition whitespace-nowrap ${
      active ? 'bg-amber-500 text-white shadow' : danger ? 'bg-rose-100 text-rose-700 hover:bg-rose-200' : 'bg-white text-[#7a6650] hover:bg-amber-50 border border-[#efe4cf]'
    }`}
  >
    {children}
  </button>
);
