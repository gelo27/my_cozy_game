import React, { useEffect, useState } from 'react';
import {
  Backpack, Hammer, Map as MapIcon, Bike, Sun, Moon, Cloud, CloudRain, CloudLightning, CloudFog, Snowflake, Coins, Zap, Settings2, Heart,
} from 'lucide-react';
import { GameplayHudState } from '../../gameplay/GameplayManager';
import { InventoryManager } from '../../inventory/InventoryManager';
import { getItemEmoji, InventoryItem } from '../../inventory/types/InventoryTypes';
import { WeatherType, WEATHER_LABELS } from '../../world/WeatherSystem';
import { t, useLang, setLang, dataName, Lang } from '../../i18n/i18n';
import { ItemIcon } from '../ItemIcon';

const WEATHER_ICON: Record<WeatherType, React.ElementType> = {
  clear: Sun,
  cloudy: Cloud,
  rain: CloudRain,
  storm: CloudLightning,
  fog: CloudFog,
  snow: Snowflake,
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
  onAction(action: 'fish' | 'pet' | 'cook' | 'shop' | 'npc' | 'explore' | 'treat'): void;
}

/** Hotbar shows what the player can hold; 1-8 keys or a tap equips. */
function useHotbar(inventory: InventoryManager): { items: InventoryItem[]; equipped: string | null } {
  const [state, setState] = useState(() => inventory.getState());
  useEffect(() => inventory.subscribe((s) => setState({ ...s })), [inventory]);
  const items = state.items.filter((i) => i.isEquippable && i.count > 0).slice(0, 8);
  return { items, equipped: state.equippedItemId };
}

export const GameHUD: React.FC<GameHUDProps> = ({
  hud, inventory, hidden, devToolsEnabled, onOpenBackpack, onToggleBuild, onOpenEditor, onOpenMap, onCallMoped, onAction,
}) => {
  const { items, equipped } = useHotbar(inventory);
  const lang = useLang();

  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const n = Number(e.key);
      if (n >= 1 && n <= items.length && !e.ctrlKey) inventory.equipItem(items[n - 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden, items, inventory]);

  if (hidden || !hud) return null;
  const WeatherIcon = hud.isNight && hud.weather === 'clear' ? Moon : WEATHER_ICON[hud.weather];

  return (
    <div className="absolute inset-0 pointer-events-none select-none z-30 font-sans">
      {/* Top-left: clock, weather, coins, active buff */}
      <div className="absolute top-3 left-3 flex flex-wrap items-center gap-2">
        <div className={`${panel} rounded-2xl px-3 py-1.5 flex items-center gap-2`}>
          <WeatherIcon className="w-4 h-4 text-amber-600" />
          <span className="text-sm font-bold tabular-nums">{hud.clock}</span>
          <span className="text-xs text-[#8a7556] hidden sm:inline">{dataName('weather', hud.weather, WEATHER_LABELS[hud.weather])}</span>
        </div>
        <div className={`${panel} rounded-2xl px-3 py-1.5 flex items-center gap-1.5`}>
          <Coins className="w-4 h-4 text-yellow-500" />
          <span className="text-sm font-bold tabular-nums">{hud.coins}</span>
        </div>
        {hud.buff && (
          <div className={`${panel} rounded-2xl px-3 py-1.5 flex items-center gap-1.5`}>
            <Zap className="w-4 h-4 text-emerald-600" />
            <span className="text-xs font-semibold">{t('hud.seconds', { n: hud.buff.secondsLeft })}</span>
          </div>
        )}
      </div>

      {/* Top-right: the few menus a player needs */}
      <div className="absolute top-3 right-3 flex items-center gap-2 pointer-events-auto">
        {hud.pets.length > 0 && (
          <div className={`${panel} rounded-2xl px-3 py-1.5 hidden md:flex items-center gap-2`}>
            {hud.pets.map((p) => (
              <span key={p.name} className="flex items-center gap-1 text-xs font-semibold">
                {p.kind === 'cat' ? '🐱' : '🐶'} <Heart className="w-3 h-3 text-rose-500 fill-rose-400" />
                {p.affection}
              </span>
            ))}
          </div>
        )}
        <button
          onClick={() => setLang(lang === 'en' ? 'uk' : ('en' as Lang))}
          title={t('hud.language')}
          className={`${panel} rounded-2xl h-11 px-3 text-xs font-extrabold hover:bg-amber-50 active:scale-95 transition`}
        >
          {lang === 'en' ? 'EN' : 'UA'}
        </button>
        <HudButton label={t('hud.map')} hotkey="M" onClick={onOpenMap}>
          <MapIcon className="w-5 h-5" />
        </HudButton>
        <HudButton label={t('hud.callMoped')} hotkey="V" onClick={onCallMoped}>
          <Bike className="w-5 h-5" />
        </HudButton>
        <HudButton label={t('hud.backpack')} hotkey="Q" onClick={onOpenBackpack}>
          <Backpack className="w-5 h-5" />
        </HudButton>
        <HudButton label={t('hud.build')} hotkey="B" onClick={onToggleBuild}>
          <Hammer className="w-5 h-5" />
        </HudButton>
        {devToolsEnabled && (
          <HudButton label={t('hud.editor')} hotkey="F1" onClick={onOpenEditor}>
            <Settings2 className="w-5 h-5" />
          </HudButton>
        )}
      </div>

      {/* Interaction prompt */}
      {hud.prompt && !hud.fishing && (
        <div className="absolute bottom-60 sm:bottom-28 left-1/2 -translate-x-1/2 flex gap-2 pointer-events-auto">
          <PromptButton keyLabel={hud.prompt.key} text={hud.prompt.text} onClick={() => onAction(hud.prompt!.action)} />
          {hud.prompt.secondary && (
            <PromptButton
              keyLabel={hud.prompt.secondary.key}
              text={hud.prompt.secondary.text}
              onClick={() => onAction('treat')}
            />
          )}
        </div>
      )}

      {hud.fishing && <FishingWidget hud={hud} onPress={() => onAction('fish')} />}

      {/* Hotbar */}
      {items.length > 0 && (
        <div className={`absolute bottom-3 left-1/2 -translate-x-1/2 ${panel} rounded-2xl p-1.5 flex gap-1.5 pointer-events-auto`}>
          {items.map((item, i) => (
            <button
              key={item.id}
              onClick={() => inventory.equipItem(item.id)}
              title={dataName('item', item.id, item.name)}
              className={`relative w-11 h-11 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center text-xl transition-all ${
                equipped === item.id
                  ? 'bg-amber-200 ring-2 ring-amber-500 scale-105'
                  : 'bg-white/70 hover:bg-amber-50'
              }`}
            >
              <ItemIcon item={item} />
              <span className="absolute top-0.5 left-1 text-[9px] font-bold text-[#a08a68] hidden sm:block">{i + 1}</span>
              {item.maxStack > 1 && (
                <span className="absolute bottom-0 right-1 text-[10px] font-bold text-[#4a3b2a]">{item.count}</span>
              )}
            </button>
          ))}
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
    className={`${panel} rounded-2xl w-11 h-11 flex items-center justify-center hover:bg-amber-50 active:scale-95 transition`}
  >
    {children}
  </button>
);

const PromptButton: React.FC<{ keyLabel: string; text: string; onClick(): void }> = ({ keyLabel, text, onClick }) => (
  <button
    onClick={onClick}
    className={`${panel} rounded-2xl pl-1.5 pr-4 py-1.5 flex items-center gap-2 text-sm font-semibold hover:bg-amber-50 active:scale-95 transition`}
  >
    <span className="w-7 h-7 rounded-lg bg-[#4a3b2a] text-white flex items-center justify-center text-xs font-bold">
      {keyLabel}
    </span>
    {text}
  </button>
);

const FishingWidget: React.FC<{ hud: GameplayHudState; onPress(): void }> = ({ hud, onPress }) => {
  const f = hud.fishing!;
  const text: Record<string, string> = {
    cast: t('fishing.cast'),
    wait: t('fishing.wait'),
    bite: t('fishing.bite'),
    reel: t('fishing.reel', { hits: f.hits, need: f.hitsNeeded }),
    caught: t('fishing.caught'),
    escaped: t('fishing.escaped'),
  };
  const urgent = f.phase === 'bite' || f.phase === 'reel';
  return (
    <div className="absolute bottom-60 sm:bottom-24 left-1/2 -translate-x-1/2 w-[min(90vw,340px)] pointer-events-auto">
      <button
        onClick={onPress}
        className={`${panel} w-full rounded-2xl px-4 py-3 flex flex-col items-center gap-2 active:scale-[0.98] transition ${
          urgent ? 'ring-2 ring-amber-400' : ''
        }`}
      >
        <span className={`text-sm font-bold ${f.phase === 'bite' ? 'text-rose-600 animate-pulse' : ''}`}>{text[f.phase]}</span>
        {f.phase === 'reel' && <ReelBar marker={f.marker} zoneStart={f.zoneStart} zoneWidth={f.zoneWidth} />}
        <span className="text-[11px] text-[#8a7556]">{t('fishing.hint')}</span>
      </button>
    </div>
  );
};

/** Marker position comes from the HUD push (~10 Hz) and is animated locally for smoothness. */
const ReelBar: React.FC<{ marker: number; zoneStart: number; zoneWidth: number }> = ({ marker, zoneStart, zoneWidth }) => (
  <div className="relative w-full h-4 rounded-full bg-[#e9dcc3] overflow-hidden">
    <div
      className="absolute top-0 bottom-0 bg-emerald-400/90"
      style={{ left: `${zoneStart * 100}%`, width: `${zoneWidth * 100}%` }}
    />
    <div
      className="absolute top-[-2px] bottom-[-2px] w-1.5 rounded bg-[#4a3b2a] transition-[left] duration-75 ease-linear"
      style={{ left: `calc(${marker * 100}% - 3px)` }}
    />
  </div>
);
