import React, { useEffect, useState } from 'react';
import {
  Backpack, Hammer, Map as MapIcon, Bike, Users, Sun, Moon, Cloud, CloudRain, CloudLightning, CloudFog, Snowflake, Wind, Coins, Zap, Settings2, Pause, Fish, ChevronUp, ChevronDown,
} from 'lucide-react';
import { GameplayHudState, GameplayPrompt } from '../../gameplay/GameplayManager';
import { InventoryManager } from '../../inventory/InventoryManager';
import { getItemEmoji, InventoryItem } from '../../inventory/types/InventoryTypes';
import { WeatherType, WEATHER_LABELS } from '../../world/WeatherSystem';
import { SEASON_LABELS } from '../../world/Seasons';
import { t, dataName } from '../../i18n/i18n';
import { worldSettings } from '../../world/WorldSettings';
import { ItemIcon } from '../ItemIcon';
import { useGameplayPrompt } from '../promptStore';

const WEATHER_ICON: Record<WeatherType, React.ElementType> = {
  clear: Sun,
  cloudy: Cloud,
  rain: CloudRain,
  storm: CloudLightning,
  fog: CloudFog,
  snow: Snowflake,
  blizzard: Wind,
};

const panel = 'bg-[#fffaf0]/95 text-[#4a3b2a] border border-[#e9dcc3] shadow-[0_6px_20px_rgba(60,40,10,0.18)]';

interface GameHUDProps {
  hud: GameplayHudState | null;
  inventory: InventoryManager;
  hidden: boolean; // build / paint mode take over the screen
  devToolsEnabled: boolean;
  onOpenBackpack(): void;
  onToggleBuild(): void;
  onOpenEditor(): void;
  onOpenMap(): void;
  onCallMoped(): void;
  onPause(): void;
  /** Farmhands panel (absent when there is no crew system). */
  onOpenWorkers?(): void;
  onAction(action: GameplayPrompt['action'] | 'treat'): void;
  /** The fishing button is held / released (hold to cast and to reel). */
  onFishHold(down: boolean): void;
  /** Raises (-1) / lowers (+1) the hook one step. */
  onFishDepth(steps: number): void;
}

/**
 * The in-game clock ticks every real second (a game hour is 60 s). It reads the time itself instead of
 * riding on the HUD state, so the minute change no longer re-renders the whole HUD tree each second.
 */
const clockText = (): string => {
  const h = Math.floor(worldSettings.timeOfDay);
  const m = Math.floor((worldSettings.timeOfDay - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
const ClockLabel: React.FC = () => {
  const [text, setText] = useState(clockText);
  useEffect(() => {
    const id = window.setInterval(() => setText(clockText()), 500);
    return () => window.clearInterval(id);
  }, []);
  return <span className="text-sm font-bold tabular-nums">{text}</span>;
};

/** Hotbar shows the 8 slots the player filled in the backpack; 1-8 keys or a tap equips. */
function useHotbar(inventory: InventoryManager): { slots: (InventoryItem | null)[]; equipped: string | null } {
  const [state, setState] = useState(() => inventory.getState());
  useEffect(() => inventory.subscribe((s) => setState({ ...s })), [inventory]);
  const slots = state.hotbar.map((id) => (id ? state.items.find((i) => i.id === id && i.count > 0) ?? null : null));
  return { slots, equipped: state.equippedItemId };
}

export const GameHUD: React.FC<GameHUDProps> = ({
  hud, inventory, hidden, devToolsEnabled, onOpenBackpack, onToggleBuild, onOpenEditor, onOpenMap, onCallMoped, onPause, onOpenWorkers, onAction, onFishHold, onFishDepth,
}) => {
  const { slots, equipped } = useHotbar(inventory);

  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (inventory.isInventoryOpen()) return;
      const n = Number(e.key);
      const item = n >= 1 && n <= slots.length && !e.ctrlKey ? slots[n - 1] : null;
      if (item?.isEquippable) inventory.equipItem(item.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden, slots, inventory]);

  if (hidden || !hud) return null;
  const WeatherIcon = hud.isNight && hud.weather === 'clear' ? Moon : WEATHER_ICON[hud.weather];

  return (
    <div className="absolute inset-0 pointer-events-none select-none z-30 font-sans">
      {/* Top-left: clock, weather, coins, active buff (kept clear of the hearts at the top centre) */}
      <div className="absolute top-3 left-3 max-w-[calc(50%-64px)] flex flex-wrap items-center gap-2 touch:top-2 touch:left-2 touch:gap-1.5 max-sm:flex-col max-sm:items-start">
        <div className={`${panel} rounded-2xl px-3 py-1.5 touch:px-2.5 touch:py-1 flex items-center gap-2`}>
          <WeatherIcon className="w-4 h-4 text-amber-600" />
          <ClockLabel />
          <span className="text-xs text-[#8a7556] hidden sm:inline">{dataName('weather', hud.weather, WEATHER_LABELS[hud.weather])}</span>
          <span className="text-xs text-[#8a7556] hidden sm:inline">· {dataName('season', hud.season, SEASON_LABELS[hud.season])} {hud.seasonDay}</span>
        </div>
        <div className={`${panel} rounded-2xl px-3 py-1.5 touch:px-2.5 touch:py-1 flex items-center gap-1.5`}>
          <Coins className="w-4 h-4 text-yellow-500" />
          <span className="text-sm font-bold tabular-nums">{hud.coins}</span>
        </div>
        {hud.buff && (
          <div className={`${panel} rounded-2xl px-3 py-1.5 touch:px-2.5 touch:py-1 flex items-center gap-1.5`}>
            <Zap className="w-4 h-4 text-emerald-600" />
            <span className="text-xs font-semibold">{t('hud.seconds', { n: hud.buff.secondsLeft })}</span>
          </div>
        )}
      </div>

      {/* Top-right: the few menus a player needs */}
      <div className="absolute top-3 right-3 max-w-[calc(50%-64px)] flex flex-wrap justify-end items-center gap-2 pointer-events-auto touch:top-2 touch:right-2 touch:gap-1.5 max-sm:flex-col max-sm:flex-nowrap max-sm:items-end">
        <HudButton label={t('hud.map')} hotkey="M" onClick={onOpenMap}>
          <MapIcon className="w-5 h-5" />
        </HudButton>
        <HudButton label={t('hud.callMoped')} hotkey="V" onClick={onCallMoped}>
          <Bike className="w-5 h-5" />
        </HudButton>
        <HudButton label={t('hud.backpack')} hotkey="Q" onClick={onOpenBackpack}>
          <Backpack className="w-5 h-5" />
        </HudButton>
        {onOpenWorkers && (
          <HudButton label={t('hud.workers')} hotkey="J" onClick={onOpenWorkers}>
            <Users className="w-5 h-5" />
          </HudButton>
        )}
        <HudButton label={t('hud.build')} hotkey="B" onClick={onToggleBuild}>
          <Hammer className="w-5 h-5" />
        </HudButton>
        {devToolsEnabled && (
          <HudButton label={t('hud.editor')} hotkey="F1" onClick={onOpenEditor}>
            <Settings2 className="w-5 h-5" />
          </HudButton>
        )}
        <HudButton label={t('hud.pause')} hotkey="Esc" onClick={onPause}>
          <Pause className="w-5 h-5" />
        </HudButton>
      </div>

      {/* Interaction prompt (re-renders on its own, see promptStore) */}
      {!hud.fishing && <GameplayPromptButtons onAction={onAction} onFishHold={onFishHold} />}

      {hud.fishing && <FishingWidget hud={hud} onHold={onFishHold} onDepth={onFishDepth} />}

      {/* Hotbar */}
      {slots.some(Boolean) && (
        <div className={`absolute bottom-3 left-1/2 -translate-x-1/2 ${panel} rounded-2xl p-1.5 flex gap-1.5 pointer-events-auto touch:bottom-2 touch:p-1 touch:gap-1 touch:rounded-xl`}>
          {slots.map((item, i) =>
            item ? (
              <button
                key={i}
                onClick={() => item.isEquippable && inventory.equipItem(item.id)}
                title={dataName('item', item.id, item.name)}
                className={`relative w-11 h-11 sm:w-12 sm:h-12 touch:w-9 touch:h-9 touch:text-lg rounded-xl touch:rounded-lg flex items-center justify-center text-xl transition-all ${
                  equipped === item.id
                    ? 'bg-amber-200 ring-2 ring-amber-500 scale-105'
                    : 'bg-white/70 hover:bg-amber-50'
                }`}
              >
                <ItemIcon item={item} />
                <span className="absolute top-0.5 left-1 text-[9px] font-bold text-[#a08a68] hidden sm:block touch:hidden">{i + 1}</span>
                {item.maxStack > 1 && (
                  <span className="absolute bottom-0 right-1 text-[10px] touch:text-[9px] touch:right-0.5 font-bold text-[#4a3b2a]">{item.count}</span>
                )}
              </button>
            ) : (
              <div
                key={i}
                className="relative w-11 h-11 sm:w-12 sm:h-12 touch:w-9 touch:h-9 rounded-xl touch:rounded-lg bg-[#e9ded0]/40 border border-dashed border-[#d8c8b4]"
              >
                <span className="absolute top-0.5 left-1 text-[9px] font-bold text-[#a08a68]/60 hidden sm:block touch:hidden">{i + 1}</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
};

const HudButton: React.FC<{ label: string; hotkey: string; onClick(): void; children: React.ReactNode }> = ({
  label, hotkey, onClick, children,
}) => (
  <button
    onClick={onClick}
    title={`${label} (${hotkey})`}
    className={`${panel} rounded-2xl w-11 h-11 touch:w-9 touch:h-9 touch:rounded-xl touch:[&_svg]:w-4 touch:[&_svg]:h-4 flex items-center justify-center hover:bg-amber-50 active:scale-95 transition`}
  >
    {children}
  </button>
);

/** The E (and G) prompt of stations, the NPC and pets; subscribed to promptStore on its own. */
const GameplayPromptButtons: React.FC<{ onAction: GameHUDProps['onAction']; onFishHold: GameHUDProps['onFishHold'] }> = ({ onAction, onFishHold }) => {
  const prompt = useGameplayPrompt();
  if (!prompt) return null;
  return (
    <div className="absolute bottom-60 sm:bottom-28 touch:sm:bottom-16 left-1/2 -translate-x-1/2 flex gap-2 pointer-events-auto">
      <PromptButton
        keyLabel={prompt.key}
        text={prompt.text}
        onClick={() => onAction(prompt.action)}
        onPointerDown={prompt.action === 'fish' ? () => holdFish(onFishHold) : undefined}
      />
      {prompt.secondary && (
        <PromptButton keyLabel={prompt.secondary.key} text={prompt.secondary.text} onClick={() => onAction('treat')} />
      )}
    </div>
  );
};

const PromptButton: React.FC<{ keyLabel: string; text: string; onClick(): void; onPointerDown?(): void }> = ({ keyLabel, text, onClick, onPointerDown }) => (
  <button
    onClick={onClick}
    onPointerDown={onPointerDown}
    className={`${panel} rounded-2xl pl-1.5 pr-4 py-1.5 flex items-center gap-2 text-sm font-semibold hover:bg-amber-50 active:scale-95 transition`}
  >
    <span className="w-7 h-7 rounded-lg bg-[#4a3b2a] text-white flex items-center justify-center text-xs font-bold">
      {keyLabel}
    </span>
    {text}
  </button>
);

/** Hold-to-fish: down on the button, up anywhere (the button may unmount while held). */
function holdFish(onHold: (down: boolean) => void): void {
  onHold(true);
  const up = () => {
    onHold(false);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/** Phones / tablets (html.touch-ui is set in main.tsx). */
const isTouchUi = () => document.documentElement.classList.contains('touch-ui');

const FishingWidget: React.FC<{ hud: GameplayHudState; onHold(down: boolean): void; onDepth(steps: number): void }> = ({ hud, onHold, onDepth }) => {
  const f = hud.fishing!;
  const touch = isTouchUi();
  // The touch action buttons step aside for the reel button while fishing
  useEffect(() => {
    document.documentElement.dataset.fishing = '1';
    return () => {
      delete document.documentElement.dataset.fishing;
    };
  }, []);
  const text: Record<string, string> = {
    aim: f.canCast ? t('fishing.aim', { pct: Math.round(f.power * 100) }) : t('fishing.noWater'),
    flight: t('fishing.cast'),
    wait: f.snagged ? t(touch ? 'fishing.snagTouch' : 'fishing.snag') : f.nibble ? t('fishing.nibble') : f.reeling ? t('fishing.reeling') : t(touch ? 'fishing.waitTouch' : 'fishing.wait'),
    hooked: t(touch ? 'fishing.biteTouch' : 'fishing.bite'),
    caught: t('fishing.caught'),
  };
  const urgent = f.phase === 'hooked' || f.nibble || f.snagged;
  const canDepth = f.phase === 'wait' && !f.snagged;
  const press = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    holdFish(onHold);
  };

  const info = (
    <>
      <span className={`${touch ? 'text-xs' : 'text-sm'} font-bold text-center ${f.phase === 'hooked' ? 'text-rose-600 animate-pulse' : ''}`}>{text[f.phase]}</span>
      {f.snagged && (
        <div className="relative w-full h-3 rounded-full bg-[#e9dcc3] overflow-hidden">
          <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-lime-500 to-emerald-600" style={{ width: `${f.snagProgress * 100}%` }} />
        </div>
      )}
      {f.phase === 'hooked' && (
        <div className="w-full flex flex-col gap-1">
          <div className="relative w-full h-3 rounded-full bg-[#e9dcc3] overflow-hidden">
            {/* Green (safe) to red (about to break free) */}
            <div
              className="absolute inset-y-0 left-0 transition-[width] duration-100"
              style={{ width: `${f.escape * 100}%`, background: `hsl(${Math.round(120 * (1 - f.escape))}, 75%, 45%)` }}
            />
          </div>
          <span className="text-[10px] text-[#8a7556] self-start">{t('fishing.escapeMeter')}</span>
        </div>
      )}
      {f.phase === 'aim' && (
        <div className="relative w-full h-3 rounded-full bg-[#e9dcc3] overflow-hidden">
          <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-sky-400 to-emerald-400" style={{ width: `${f.power * 100}%` }} />
        </div>
      )}
      {canDepth && <span className="text-xs font-semibold text-[#5b4a33]">{t(touch ? 'fishing.depthTouch' : 'fishing.depth', { m: f.depth.toFixed(1) })}</span>}
    </>
  );

  if (touch) {
    const round = 'rounded-full border-2 shadow-[0_4px_14px_rgba(60,40,10,0.3)] flex items-center justify-center touch-none select-none active:scale-90 transition-transform';
    const depthBtn = (steps: number, Icon: typeof ChevronUp) => (
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDepth(steps);
        }}
        onTouchStart={(e) => e.stopPropagation()}
        className={`${round} w-12 h-12 bg-[#fffaf0]/95 text-[#4a3b2a] border-[#e9dcc3]`}
      >
        <Icon className="w-6 h-6" />
      </button>
    );
    return (
      <>
        {/* Status up top, out of the thumbs' way; touches go through it to the camera */}
        <div className={`${panel} absolute top-24 left-1/2 -translate-x-1/2 w-[min(70vw,280px)] rounded-2xl px-3 py-2 flex flex-col items-center gap-1.5 pointer-events-none ${urgent ? 'ring-2 ring-amber-400' : ''}`}>
          {info}
        </div>
        {/* Right thumb: the reel (hold = charge / reel, quick taps = work a snagged hook loose) */}
        <div className="pointer-events-auto absolute bottom-20 right-3 short:bottom-3 short:right-2 flex items-end gap-2 z-30">
          {canDepth && (
            <div className="flex flex-col gap-2 mb-1">
              {depthBtn(-1, ChevronUp)}
              {depthBtn(1, ChevronDown)}
            </div>
          )}
          <button
            onPointerDown={press}
            onContextMenu={(e) => e.preventDefault()}
            // Not a camera drag: the touch stays on the button
            onTouchStart={(e) => e.stopPropagation()}
            className={`${round} w-24 h-24 short:w-20 short:h-20 ${
              f.snagged ? 'bg-lime-500 border-lime-300 animate-pulse' : f.phase === 'hooked' ? 'bg-rose-500 border-rose-300' : 'bg-amber-500 border-amber-300'
            } text-white ${f.reeling ? 'scale-95' : ''}`}
          >
            <Fish className="w-10 h-10" />
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="absolute bottom-60 sm:bottom-24 touch:sm:bottom-16 left-1/2 -translate-x-1/2 w-[min(90vw,340px)] pointer-events-auto">
      <button
        onPointerDown={press}
        className={`${panel} w-full rounded-2xl px-4 py-3 flex flex-col items-center gap-2 select-none touch-none ${urgent ? 'ring-2 ring-amber-400' : ''}`}
      >
        {info}
        <span className="text-[11px] text-[#8a7556]">{t('fishing.hint')}</span>
      </button>
    </div>
  );
};
