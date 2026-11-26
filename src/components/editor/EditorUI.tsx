import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  TreePine, TreeDeciduous, Sprout, Gem, Mountain, Flower2, Cherry, Circle, Fence, Lamp, Armchair, Box, Wheat, Droplets,
  Flame, Mailbox, Package, MousePointer2, PaintBucket, Brush, Undo2, Redo2, Play, Save, FolderOpen, Download, Upload, Trash2,
  Copy, Crosshair, Activity, Layers, Sun, ArrowUpFromLine, ArrowDownToLine, Waves, Minus, Move3d, Rotate3d, Plus, Car,
  PawPrint, User, Globe2, Terminal, Bug, Spline, Shell, Leaf, Music, Skull, Fish, X, SprayCan, Eraser, Search, Star, Clock3,
} from 'lucide-react';
import { RiverPanel } from './RiverPanel';
import { MusicPanel } from './MusicPanel';
import { CavePanel } from './CavePanel';
import { ScenePanel } from './ScenePanel';
import { btn, chip, Section, Slider, NumberField } from './EditorWidgets';
import { GameEngine, DevStats } from '../../engine/GameEngine';
import { EditorTool, isScatterable } from '../../editor/EditorController';
import { PEST_KINDS, PestKind } from '../../gameplay/Pests';
import { lockOnSettings } from '../../gameplay/LockOn';
import { PROP_DEFS, PROP_DEF_MAP, PropCategory, canTiltProp } from '../../world/PropSystem';
import { WEB_LIMITS, WebParams, webSettings, setWebSetting, resetWebSettings } from '../../world/SpiderWebs';
import { CHAIN_SPECIES, LILY_HEADS, algaeSettings, setAlgae, resetAlgaeSettings } from '../../world/AlgaeChains';
import { TerrainTileType, TILE_DEFINITIONS } from '../../terrain/types/TerrainTypes';
import { WeatherType, WEATHER_LABELS, WEATHER_PROFILES, WeatherProfiles, WeatherSound } from '../../world/WeatherSystem';
import { SEASONS, SEASON_LABELS, currentSeason } from '../../world/Seasons';
import { MAX_SEA_FLOOR_DEPTH, MIN_SEA_FLOOR_DEPTH, worldSettings } from '../../world/WorldSettings';
import { duckweed } from '../../world/Duckweed';
import { pondTint } from '../../world/PondTint';
import { BIRD_SPECIES, birdSpeciesEnabled, setBirdSpeciesEnabled } from '../../audio/AmbientAudio';
import { SaveSystem } from '../../world/SaveSystem';
import { waterSettings, WaterSettings, WATER_DEFAULTS, saveWaterSettings, resetWaterSettings } from '../../world/WaterSettings';
import { RIPPLE_SIM_RES } from '../../scene/WaterRippleSim';
import { vegetationSettings, VegetationSettings, setVegetation, resetVegetationSettings, applyVegetationPreset } from '../../world/VegetationSettings';
import { causticsSettings, applyCausticsSettings, resetCausticsSettings, CausticsSettings } from '../../scene/WaterEffects';
import { lightShaftSettings, resetLightShaftSettings, saveLightShaftSettings, LightShaftSettings } from '../../world/LightShafts';
import { cloudShadowSettings, resetCloudShadowSettings, saveCloudShadowSettings, CloudShadowSettings } from '../../world/CloudShadows';
import { NIGHT_LIGHT_MODES, NightLightMode, nightLightSettings, setNightLightMode } from '../../world/NightLighting';
import { pickGlowSettings, resetPickGlowSettings, savePickGlowSettings, PickGlowSettings } from '../../world/PickGlow';
import { flameSettings, resetFlameSettings, saveFlameSettings, FlameSettings } from '../../world/FlameField';

const ICONS: Record<string, React.ElementType> = {
  TreePine, TreeDeciduous, Sprout, Gem, Mountain, Flower2, Cherry, Circle, Fence, Lamp, Armchair, Box, Wheat, Droplets,
  Flame, Mailbox, Package, Waves, Bug,
};

function readEditorList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 12) : [];
  } catch { return []; }
}

const CATEGORY_LABELS: Record<PropCategory, string> = { nature: 'Природа', decor: 'Декор', farm: 'Ферма', stations: 'Станції', objects: 'Об’єкти' };

type Tab = 'world' | 'scene' | 'atmo' | 'water' | 'veg' | 'rocks' | 'music' | 'save' | 'debug';
const RockGeneratorPanel = React.lazy(() => import('./RockGeneratorPanel'));

interface EditorUIProps {
  engine: GameEngine;
  stats: DevStats | null;
  isWireframe: boolean;
  onToggleWireframe(): void;
  showConsole: boolean;
  onToggleConsole(): void;
  showCharacterInspector: boolean;
  onToggleCharacterInspector(): void;
  notify(text: string, type?: 'success' | 'info' | 'warn'): void;
}

/**
 * The whole developer editor in one compact dock: tools on the left rail, context panel next to
 * it, and a slim top bar. Re-renders only when the editor revision or the 3 Hz stats change.
 */
export const EditorUI: React.FC<EditorUIProps> = (props) => {
  const { engine } = props;
  const world = engine.world!;
  const editor = world.editor;
  const s = editor.state;
  const [tab, setTab] = useState<Tab>('world');
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const [navQuery, setNavQuery] = useState('');
  const [favorites, setFavorites] = useState<string[]>(() => readEditorList('farm.editor.favorites'));
  const [recent, setRecent] = useState<string[]>(() => readEditorList('farm.editor.recent'));
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!editor.hasUnsavedEdits) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editor, editor.editRevision]);

  const setTool = (t: EditorTool) => {
    editor.set('tool', t);
    setTab('world');
  };

  const tools: { id: EditorTool; icon: React.ElementType; label: string }[] = [
    { id: 'select', icon: MousePointer2, label: 'Вибір (1)' },
    { id: 'place', icon: TreePine, label: 'Об’єкти (2)' },
    { id: 'sculpt', icon: Mountain, label: 'Рельєф (3)' },
    { id: 'paint', icon: Brush, label: 'Покриття (4)' },
    { id: 'river', icon: Spline, label: 'Річки та водоспади (5)' },
    { id: 'cave', icon: Shell, label: 'Печери (6)' },
    { id: 'enemy', icon: Skull, label: 'Вороги (7)' },
    { id: 'duckweed', icon: Sprout, label: 'Ряска (8)' },
    { id: 'pondTint', icon: Droplets, label: 'Колір ставка (0)' },
    { id: 'scatter', icon: SprayCan, label: 'Пензель об’єктів (9)' },
  ];
  const tabs: { id: Tab; icon: React.ElementType; label: string }[] = [
    { id: 'rocks', icon: Gem, label: 'Генератор каменів' },
    { id: 'scene', icon: Layers, label: 'Сцена та інспектор' },
    { id: 'atmo', icon: Sun, label: 'Час, погода, вода' },
    { id: 'water', icon: Waves, label: 'Шейдер води' },
    { id: 'veg', icon: Leaf, label: 'Рослинність' },
    { id: 'music', icon: Music, label: 'Музика' },
    { id: 'save', icon: Save, label: 'Збереження' },
    { id: 'debug', icon: Activity, label: 'Дебаг' },
  ];
  const navItems = [
    ...tools.map((item) => ({ key: `tool:${item.id}`, label: item.label.replace(/ \(\d\)$/, ''), icon: item.icon })),
    ...tabs.map((item) => ({ key: `tab:${item.id}`, label: item.label, icon: item.icon })),
    ...[
      ['atmo', 'Час доби'], ['atmo', 'Пора року'], ['atmo', 'Погода'], ['atmo', 'Нічні джерела світла'],
      ['atmo', 'Голоси птахів'], ['atmo', 'Вода'], ['water', 'Параметри хвиль'], ['veg', 'Трава'],
      ['veg', 'Дерева'], ['scene', 'Швидкі перевірки'], ['scene', 'Ієрархія сцени'], ['save', 'Пресети середовища'],
      ['debug', 'Продуктивність'], ['debug', 'Сценарії перевірки'],
    ].map(([tabId, label]) => ({ key: `section:${tabId}:${label}`, label, icon: Search })),
  ];
  const selectNav = (key: string) => {
    const [kind, id, ...rest] = key.split(':');
    if (kind === 'tool') setTool(id as EditorTool);
    else if (kind === 'tab') setTab(id as Tab);
    else if (kind === 'section') {
      setTab(id as Tab);
      const title = rest.join(':');
      try { localStorage.setItem(`editor.section.${title}`, '1'); } catch { /* storage unavailable */ }
      window.dispatchEvent(new CustomEvent('editor:openSection', { detail: title }));
    }
    setRecent((old) => {
      const next = [key, ...old.filter((value) => value !== key)].slice(0, 5);
      try { localStorage.setItem('farm.editor.recent', JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
    setNavQuery('');
  };
  const toggleFavorite = (key: string) => setFavorites((old) => {
    const next = old.includes(key) ? old.filter((value) => value !== key) : [key, ...old].slice(0, 12);
    try { localStorage.setItem('farm.editor.favorites', JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });
  const navLabel = (key: string) => navItems.find((item) => item.key === key)?.label ?? key;

  return (
    <div className="absolute inset-0 pointer-events-none z-40 font-sans text-zinc-200 select-none">
      {/* Top bar */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-zinc-900/90 border border-white/10 rounded-xl px-1.5 py-1 shadow-xl pointer-events-auto">
        <span className="px-2 text-[11px] font-bold text-sky-400 tracking-wide">РЕДАКТОР</span>
        <span className={`hidden text-[10px] sm:inline ${editor.hasUnsavedEdits ? 'text-amber-300' : 'text-emerald-300'}`} title={editor.hasUnsavedEdits ? 'Є зміни після останнього збереження' : 'Зміни збережено'}>{editor.hasUnsavedEdits ? '● Не збережено' : '✓ Збережено'}</span>
        <label className="relative flex h-8 w-40 items-center gap-1.5 rounded-lg border border-white/10 bg-black/25 px-2 text-zinc-400 focus-within:border-sky-500 sm:w-52">
          <Search className="h-3.5 w-3.5 shrink-0" />
          <input value={navQuery} onChange={(e) => setNavQuery(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const match = navItems.find((item) => item.label.toLocaleLowerCase().includes(navQuery.trim().toLocaleLowerCase()));
              if (match) selectNav(match.key);
            }
            if (e.key === 'Escape') setNavQuery('');
          }} placeholder="Знайти інструмент…" aria-label="Пошук інструментів редактора" className="min-w-0 flex-1 bg-transparent text-[10px] text-zinc-100 outline-none placeholder:text-zinc-500" />
          {navQuery && <div className="absolute left-0 top-9 z-50 max-h-64 w-64 overflow-y-auto rounded-lg border border-white/10 bg-zinc-950 p-1 shadow-2xl">
            {navItems.filter((item) => item.label.toLocaleLowerCase().includes(navQuery.trim().toLocaleLowerCase())).slice(0, 8).map((item) => (
              <div key={item.key} className="flex items-center gap-1">
                <button className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-white/10" onClick={() => selectNav(item.key)}>
                  <item.icon className="h-3.5 w-3.5 shrink-0 text-sky-300" /><span className="truncate">{item.label}</span>
                </button>
                <button className={`rounded p-1 ${favorites.includes(item.key) ? 'text-amber-300' : 'text-zinc-600 hover:text-amber-300'}`} aria-label="Перемкнути обране" onClick={() => toggleFavorite(item.key)}><Star className="h-3 w-3" fill={favorites.includes(item.key) ? 'currentColor' : 'none'} /></button>
              </div>
            ))}
            {!navItems.some((item) => item.label.toLocaleLowerCase().includes(navQuery.trim().toLocaleLowerCase())) && <p className="px-2 py-2 text-xs text-zinc-500">Нічого не знайдено</p>}
          </div>}
        </label>
        <button className={`${btn} w-8 h-8 hover:bg-white/10 disabled:opacity-30`} disabled={!s.canUndo} onClick={() => editor.undo()} title="Скасувати (Ctrl+Z)">
          <Undo2 className="w-4 h-4" />
        </button>
        <button className={`${btn} w-8 h-8 hover:bg-white/10 disabled:opacity-30`} disabled={!s.canRedo} onClick={() => editor.redo()} title="Повторити (Ctrl+Y)">
          <Redo2 className="w-4 h-4" />
        </button>
        <button
          className={`${btn} w-8 h-8 hover:bg-white/10`}
          onClick={() => {
            if (SaveSystem.listSlots().some((slot) => slot.slot === 'editor') && !window.confirm('Перезаписати збереження «editor» поточним світом?')) return;
            if (!world.saves.save('editor')) { props.notify('Не вдалося зберегти світ', 'warn'); return; }
            editor.markSaved();
            props.notify('Світ збережено в слот «editor»', 'success');
          }}
          title="Швидке збереження"
        >
          <Save className="w-4 h-4" />
        </button>
        <div className="w-px h-5 bg-white/10 mx-1" />
        <button className={`${btn} gap-1.5 px-3 h-8 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold`} onClick={() => engine.setMode('play')} title="Повернутися до гри (F1)">
          <Play className="w-3.5 h-3.5 fill-white" /> Грати
        </button>
      </div>

      {/* Left rail */}
      <div className="absolute top-2 left-2 bottom-2 w-11 flex flex-col gap-1 overflow-y-auto bg-zinc-900/90 border border-white/10 rounded-xl p-1 shadow-xl pointer-events-auto [&>button]:shrink-0 [scrollbar-width:none]">
        {tools.map((t) => (
          <button
            key={t.id}
            title={t.label}
            onClick={() => selectNav(`tool:${t.id}`)}
            className={`${btn} w-9 h-9 ${tab === 'world' && s.tool === t.id ? 'bg-sky-500 text-white' : 'hover:bg-white/10'}`}
          >
            <t.icon className="w-4 h-4" />
          </button>
        ))}
        <div className="h-px bg-white/10 my-1" />
        {tabs.map((t) => (
          <button
            key={t.id}
            title={t.label}
            onClick={() => selectNav(`tab:${t.id}`)}
            className={`${btn} w-9 h-9 ${tab === t.id ? 'bg-sky-500 text-white' : 'hover:bg-white/10'}`}
          >
            <t.icon className="w-4 h-4" />
          </button>
        ))}
      </div>

      {/* Context panel */}
      <div className="absolute top-2 left-[3.4rem] w-64 sm:w-72 max-h-[calc(100%-1rem)] overflow-y-auto bg-zinc-900/90 border border-white/10 rounded-xl p-3 shadow-xl pointer-events-auto flex flex-col gap-3 text-xs">
        {favorites.length > 0 && <Section title="Обране">
          <div className="flex flex-wrap gap-1">{favorites.map((key) => <button key={key} className={chip(false)} onClick={() => selectNav(key)}><Star className="h-3 w-3 text-amber-300" fill="currentColor" />{navLabel(key)}</button>)}</div>
        </Section>}
        {recent.length > 0 && <Section title="Нещодавні інструменти">
          <div className="flex flex-wrap gap-1">{recent.map((key) => <button key={key} className={chip(false)} onClick={() => selectNav(key)}><Clock3 className="h-3 w-3 text-sky-300" />{navLabel(key)}</button>)}</div>
        </Section>}
        {tab === 'world' && <ToolPanel engine={engine} rerender={rerender} />}
        {tab === 'scene' && <ScenePanel engine={engine} notice={props.notify} openTool={setTool} inspectProp={<SelectedInspector engine={engine} detailsOnly />} />}
        {tab === 'atmo' && <AtmospherePanel engine={engine} rerender={rerender} />}
        {tab === 'water' && <WaterPanel rerender={rerender} />}
        {tab === 'veg' && <VegetationPanel rerender={rerender} />}
        {tab === 'rocks' && <React.Suspense fallback={<p className="text-zinc-400">Завантаження генератора…</p>}>
          <RockGeneratorPanel engine={engine} onPlace={(id) => {
            editor.set('placeType', id);
            setTool('place');
          }} />
        </React.Suspense>}
        {tab === 'music' && <MusicPanel />}
        {tab === 'save' && <SavePanel engine={engine} notify={props.notify} />}
        {tab === 'debug' && <DebugTab {...props} />}
      </div>

      {/* Hints */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-zinc-900/80 border border-white/10 rounded-lg px-3 py-1 text-[10px] text-zinc-400 whitespace-nowrap">
        ПКМ+рух — огляд · WASD/QE — політ · Shift — швидко · [ ] — розмір пензля · Del — видалити · Ctrl+D — копія
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ panels

const ToolPanel: React.FC<{ engine: GameEngine; rerender(): void }> = ({ engine, rerender }) => {
  const { editor, props } = engine.world!;
  const s = editor.state;
  const [category, setCategory] = useState<PropCategory>('nature');

  if (s.tool === 'select') {
    return (
      <>
        <Section title="Вибір">
          <p className="text-zinc-400 leading-relaxed">Клацніть об’єкт у світі. Гізмо: G — переміщення, R — поворот.</p>
          <div className="flex gap-1">
            <button className={chip(s.gizmoMode === 'translate')} onClick={() => editor.set('gizmoMode', 'translate')}>
              <Move3d className="w-3.5 h-3.5" /> Рух
            </button>
            <button className={chip(s.gizmoMode === 'rotate')} onClick={() => editor.set('gizmoMode', 'rotate')}>
              <Rotate3d className="w-3.5 h-3.5" /> Поворот
            </button>
          </div>
        </Section>
        <SelectedInspector engine={engine} />
      </>
    );
  }

  if (s.tool === 'place') {
    return (
      <>
        <Section title="Категорія">
          <div className="flex flex-wrap gap-1">
            {(Object.keys(CATEGORY_LABELS) as PropCategory[]).map((c) => (
              <button key={c} className={chip(category === c)} onClick={() => setCategory(c)}>
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </Section>
        <Section title="Об’єкт">
          <div className="grid grid-cols-3 gap-1">
            {(category === 'nature' ? [...PROP_DEFS.filter((d) => d.category === category),
              ...props.serializeGeneratedRocks().map(({ id }) => props.getDefinition(id)!)] : PROP_DEFS.filter((d) => d.category === category)).map((d) => {
              const Icon = ICONS[d.icon] ?? Box;
              return (
                <button
                  key={d.id}
                  onClick={() => editor.set('placeType', d.id)}
                  className={`${btn} flex-col gap-1 py-2 text-[10px] ${s.placeType === d.id ? 'bg-sky-500 text-white' : 'bg-white/5 hover:bg-white/10'}`}
                >
                  <Icon className="w-5 h-5" />
                  {d.name}
                </button>
              );
            })}
          </div>
        </Section>
        <Slider label="Масштаб" value={s.placeScale} min={0.3} max={3} step={0.05} onChange={(v) => editor.set('placeScale', v)} fmt={(v) => `${v.toFixed(2)}×`} />
        {PROP_DEF_MAP.get(s.placeType)?.chain === 'lily' && (
          <>
            <LilyHeadChips head={s.placeLilyHead} onChange={(h) => editor.set('placeLilyHead', h)} />
            <div className="flex flex-wrap gap-1">
              <button className={chip(s.placeLilyAnchor === 'surface')} onClick={() => editor.set('placeLilyAnchor', 'surface')}>
                На поверхню
              </button>
              <button className={chip(s.placeLilyAnchor === 'bottom')} onClick={() => editor.set('placeLilyAnchor', 'bottom')}>
                На дно
              </button>
            </div>
            {s.placeLilyAnchor === 'surface' && (
              <p className="text-[10px] text-zinc-500">Наведіть на воду: стебло з дна саме дотягнеться до поверхні, голівка ляже на воду.</p>
            )}
          </>
        )}
        {PROP_DEF_MAP.get(s.placeType)?.chain && !(PROP_DEF_MAP.get(s.placeType)?.chain === 'lily' && s.placeLilyAnchor === 'surface') && (
          <ChainLengthSlider
            kind={PROP_DEF_MAP.get(s.placeType)!.chain!}
            value={s.placeChainLength}
            scale={s.placeScale}
            head={s.placeLilyHead}
            onChange={(v) => editor.set('placeChainLength', v)}
          />
        )}
        {PROP_DEF_MAP.get(s.placeType)?.chain === 'algae' && (
          <AlgaeColorFields colors={s.placeAlgaeColors} onChange={(c) => editor.set('placeAlgaeColors', c)} />
        )}
        {PROP_DEF_MAP.get(s.placeType)?.web && (
          <>
            <WebFields params={s.placeWeb} onChange={(patch) => editor.set('placeWeb', { ...s.placeWeb, ...patch })} />
            <label className="flex items-center gap-2 text-zinc-300">
              <input type="checkbox" checked={s.placeWebAutoOrient} onChange={(e) => editor.set('placeWebAutoOrient', e.target.checked)} className="accent-sky-500" />
              Поперек проходу (авто-поворот)
            </label>
            <p className="text-[10px] text-zinc-500">Жовті лінії — куди зачепляться нитки.</p>
            <WebLookPanel />
          </>
        )}
        <label className="flex items-center gap-2 text-zinc-300">
          <input type="checkbox" checked={s.placeRandomize} onChange={(e) => editor.set('placeRandomize', e.target.checked)} className="accent-sky-500" />
          Випадковий поворот і розмір
        </label>
        <p className="text-zinc-500">Клік — поставити, протягнути — розсипати.</p>
      </>
    );
  }

  if (s.tool === 'river') return <RiverPanel engine={engine} />;
  if (s.tool === 'cave') return <CavePanel engine={engine} />;
  if (s.tool === 'enemy') return <EnemyPanel engine={engine} />;
  if (s.tool === 'scatter') return <ScatterPanel engine={engine} />;

  if (s.tool === 'pondTint') {
    const colors = [
      ['pondShallowColor', 'Мілина'],
      ['pondDeepColor', 'Глибина'],
      ['pondFogColor', 'Під водою'],
    ] as const;
    return (
      <Section title="Колір ставка">
        <div className="flex gap-1">
          <button className={chip(!s.pondTintErase)} onClick={() => editor.set('pondTintErase', false)}>Фарбувати</button>
          <button className={chip(s.pondTintErase)} onClick={() => editor.set('pondTintErase', true)}>Стерти</button>
        </div>
        <Slider label="Радіус" value={s.brushRadius} min={1} max={20} step={1} onChange={(v) => editor.set('brushRadius', v)} fmt={(v) => `${v} м`} />
        <Slider label="Сила" value={s.pondTintRate} min={0.1} max={4} step={0.1} onChange={(v) => editor.set('pondTintRate', v)} fmt={(v) => v.toFixed(1)} />
        <div className="grid grid-cols-3 gap-2">
          {colors.map(([key, label]) => (
            <label key={key} className="flex flex-col items-center gap-1 text-[10px] text-zinc-400">
              <input type="color" value={hexOf(waterSettings[key])} className="w-full h-7 bg-transparent border border-white/10 rounded cursor-pointer"
                onChange={(e) => {
                  waterSettings[key] = parseInt(e.target.value.slice(1), 16);
                  saveWaterSettings();
                  rerender();
                }}
              />
              {label}
            </label>
          ))}
        </div>
        <button className={`${btn} gap-1.5 py-1.5 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25`}
          onClick={() => {
            if (pondTint.bounds.x > pondTint.bounds.z) return;
            editor.trackPondTint();
            pondTint.clear();
          }}
        >
          <Trash2 className="w-3.5 h-3.5" /> Очистити маску
        </button>
      </Section>
    );
  }

  if (s.tool === 'duckweed') {
    return (
      <>
        <Section title="Ряска">
          <div className="flex gap-1">
            <button className={chip(!s.duckweedErase)} onClick={() => editor.set('duckweedErase', false)}>
              <Sprout className="w-3.5 h-3.5" /> Додати
            </button>
            <button className={chip(s.duckweedErase)} onClick={() => editor.set('duckweedErase', true)}>
              <Minus className="w-3.5 h-3.5" /> Стерти
            </button>
          </div>
        </Section>
        <Slider label="Радіус" value={s.brushRadius} min={1} max={20} step={1} onChange={(v) => editor.set('brushRadius', v)} fmt={(v) => `${v} м`} />
        <Slider label="Сила" value={s.duckweedRate} min={0.1} max={4} step={0.1} onChange={(v) => editor.set('duckweedRate', v)} fmt={(v) => v.toFixed(1)} />
        <p className="text-zinc-500">Малюється по поверхні води (море, озера, річки). Слабкий мазок дає окремі листочки, повторний ущільнює до суцільного килима.</p>
        <button
          className={`${btn} gap-1.5 py-1.5 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25`}
          onClick={() => {
            editor.pushUndo();
            duckweed.clear();
          }}
        >
          <Trash2 className="w-3.5 h-3.5" /> Прибрати всю ряску
        </button>
      </>
    );
  }

  if (s.tool === 'sculpt') {
    const kinds = [
      { id: 'raise', icon: ArrowUpFromLine, label: 'Підняти' },
      { id: 'lower', icon: ArrowDownToLine, label: 'Опустити' },
      { id: 'smooth', icon: Waves, label: 'Згладити' },
      { id: 'flatten', icon: Minus, label: 'Вирівняти' },
    ] as const;
    return (
      <>
        <Section title="Пензель рельєфу">
          <div className="grid grid-cols-2 gap-1">
            {kinds.map((k) => (
              <button key={k.id} className={chip(s.sculptKind === k.id)} onClick={() => editor.set('sculptKind', k.id)}>
                <k.icon className="w-3.5 h-3.5" /> {k.label}
              </button>
            ))}
          </div>
        </Section>
        <Slider label="Радіус" value={s.brushRadius} min={1} max={20} step={1} onChange={(v) => editor.set('brushRadius', v)} fmt={(v) => `${v} м`} />
        <Slider label="Сила" value={s.brushStrength} min={0.2} max={8} step={0.1} onChange={(v) => editor.set('brushStrength', v)} fmt={(v) => v.toFixed(1)} />
        <p className="text-zinc-500">«Вирівняти» тягне до висоти точки, з якої почали мазок.</p>
        <button
          className={`${btn} gap-1.5 py-1.5 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25`}
          onClick={() => {
            editor.pushUndo();
            engine.world!.terrain.resetFlat();
          }}
        >
          <Trash2 className="w-3.5 h-3.5" /> Скинути рельєф у площину
        </button>
      </>
    );
  }

  return (
    <>
      <Section title="Покриття">
        <div className="grid grid-cols-2 gap-1">
          {Object.values(TILE_DEFINITIONS).map((t) => (
            <button
              key={t.id}
              onClick={() => editor.set('paintTile', t.id as TerrainTileType)}
              className={`${btn} justify-start gap-2 px-2 py-1.5 text-[11px] ${s.paintTile === t.id ? 'bg-sky-500 text-white' : 'bg-white/5 hover:bg-white/10'}`}
            >
              <span className="w-3.5 h-3.5 rounded" style={{ background: t.primaryColor }} />
              {t.ukrainianName.split(' / ')[0]}
            </button>
          ))}
        </div>
      </Section>
      <div className="flex gap-1">
        <button className={chip(!s.paintFill)} onClick={() => editor.set('paintFill', false)}>
          <Brush className="w-3.5 h-3.5" /> Пензель
        </button>
        <button className={chip(s.paintFill)} onClick={() => editor.set('paintFill', true)}>
          <PaintBucket className="w-3.5 h-3.5" /> Заливка
        </button>
      </div>
      {!s.paintFill && (
        <Slider label="Радіус" value={s.brushRadius} min={1} max={20} step={1} onChange={(v) => editor.set('brushRadius', v)} fmt={(v) => `${(v / 2).toFixed(1)} м`} />
      )}
    </>
  );
};

/** Object brush (tool 9): a mix of types scattered to a density, with ground filters and erasing. */
const ScatterPanel: React.FC<{ engine: GameEngine }> = ({ engine }) => {
  const editor = engine.world!.editor;
  const s = editor.state;
  const [category, setCategory] = useState<PropCategory>('nature');
  const inCategory = PROP_DEFS.filter((d) => d.category === category && isScatterable(d.id));
  const mix = new Set(s.scatterTypes);
  const toggleType = (id: string) => editor.set('scatterTypes', mix.has(id) ? s.scatterTypes.filter((t) => t !== id) : [...s.scatterTypes, id]);
  const tiles = new Set(s.scatterTiles);
  const toggleTile = (id: TerrainTileType) => editor.set('scatterTiles', tiles.has(id) ? s.scatterTiles.filter((t) => t !== id) : [...s.scatterTiles, id]);
  const chainType = s.scatterTypes.map((t) => PROP_DEF_MAP.get(t)).find((d) => d?.chain && !(d.chain === 'lily' && s.placeLilyAnchor === 'surface'));
  const hasLily = s.scatterTypes.some((t) => PROP_DEF_MAP.get(t)?.chain === 'lily');
  const area = Math.PI * s.brushRadius * s.brushRadius;
  const perStamp = Math.max(1, Math.round((s.scatterDensity * area) / 100));

  return (
    <>
      <Section title="Режим">
        <div className="flex gap-1">
          <button className={chip(!s.scatterErase)} onClick={() => editor.set('scatterErase', false)}>
            <SprayCan className="w-3.5 h-3.5" /> Розставити
          </button>
          <button className={chip(s.scatterErase)} onClick={() => editor.set('scatterErase', true)}>
            <Eraser className="w-3.5 h-3.5" /> Стерти
          </button>
        </div>
        {s.scatterErase && (
          <label className="flex items-center gap-2 text-zinc-300">
            <input type="checkbox" checked={s.scatterEraseAll} onChange={(e) => editor.set('scatterEraseAll', e.target.checked)} className="accent-sky-500" />
            Стирати всі типи (крім станцій)
          </label>
        )}
      </Section>
      <Section
        title={`Набір пензля (${s.scatterTypes.length})`}
        right={
          s.scatterTypes.length > 0 && (
            <button className="text-[10px] normal-case tracking-normal font-semibold text-zinc-400 hover:text-zinc-200" onClick={() => editor.set('scatterTypes', [])}>
              Очистити
            </button>
          )
        }
      >
        <div className="flex flex-wrap gap-1">
          {(Object.keys(CATEGORY_LABELS) as PropCategory[])
            .filter((c) => PROP_DEFS.some((d) => d.category === c && isScatterable(d.id)))
            .map((c) => (
              <button key={c} className={chip(category === c)} onClick={() => setCategory(c)}>
                {CATEGORY_LABELS[c]}
                {PROP_DEFS.some((d) => d.category === c && mix.has(d.id)) && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
              </button>
            ))}
        </div>
        <div className="grid grid-cols-3 gap-1">
          {inCategory.map((d) => {
            const Icon = ICONS[d.icon] ?? Box;
            const on = mix.has(d.id);
            return (
              <button
                key={d.id}
                onClick={() => toggleType(d.id)}
                className={`${btn} relative flex-col gap-1 py-2 text-[10px] ${on ? 'bg-emerald-600 text-white' : 'bg-white/5 hover:bg-white/10'}`}
              >
                <Icon className="w-5 h-5" />
                {d.name}
              </button>
            );
          })}
        </div>
        <div className="flex gap-1">
          <button className={chip(false)} onClick={() => editor.set('scatterTypes', [...new Set([...s.scatterTypes, ...inCategory.map((d) => d.id)])])}>
            Усі з категорії
          </button>
        </div>
        {s.scatterTypes.length === 0 && <p className="text-[10px] text-amber-400">Оберіть хоча б один об’єкт.</p>}
      </Section>
      <Section title="Пензель">
        <Slider label="Радіус" value={s.brushRadius} min={1} max={40} step={1} onChange={(v) => editor.set('brushRadius', v)} fmt={(v) => `${v} м`} />
        <Slider
          label="Щільність"
          value={s.scatterDensity}
          min={0.2}
          max={40}
          step={0.2}
          onChange={(v) => editor.set('scatterDensity', v)}
          fmt={(v) => `${v.toFixed(1)} / 100 м² · ≈${perStamp} у колі`}
        />
        <Slider label="Відстань між об’єктами" value={s.scatterSpacing} min={0.3} max={12} step={0.1} onChange={(v) => editor.set('scatterSpacing', v)} fmt={(v) => `${v.toFixed(1)} м`} />
        <Slider label="Розмір від" value={s.scatterScaleMin} min={0.3} max={3} step={0.05} onChange={(v) => editor.set('scatterScaleMin', v)} fmt={(v) => `${v.toFixed(2)}×`} />
        <Slider label="Розмір до" value={s.scatterScaleMax} min={0.3} max={3} step={0.05} onChange={(v) => editor.set('scatterScaleMax', v)} fmt={(v) => `${v.toFixed(2)}×`} />
        <label className="flex items-center gap-2 text-zinc-300">
          <input type="checkbox" checked={s.scatterRandomRot} onChange={(e) => editor.set('scatterRandomRot', e.target.checked)} className="accent-sky-500" />
          Випадковий поворот
        </label>
        <label className="flex items-center gap-2 text-zinc-300">
          <input type="checkbox" checked={s.scatterAvoidOthers} onChange={(e) => editor.set('scatterAvoidOthers', e.target.checked)} className="accent-sky-500" />
          Не впритул до інших об’єктів
        </label>
      </Section>
      <Section title="Де ставити">
        <div className="flex gap-1">
          {(['land', 'water', 'any'] as const).map((w) => (
            <button key={w} className={chip(s.scatterWhere === w)} onClick={() => editor.set('scatterWhere', w)}>
              {w === 'land' ? 'Суша' : w === 'water' ? 'Під водою' : 'Всюди'}
            </button>
          ))}
        </div>
        <Slider label="Макс. нахил схилу" value={s.scatterMaxSlope} min={0} max={90} step={1} onChange={(v) => editor.set('scatterMaxSlope', v)} fmt={(v) => (v >= 89 ? 'будь-який' : `${v}°`)} />
        <span className="text-zinc-400">Тільки на покритті {tiles.size === 0 && <span className="text-zinc-500">(будь-якому)</span>}</span>
        <div className="grid grid-cols-2 gap-1">
          {Object.values(TILE_DEFINITIONS).map((t) => (
            <button
              key={t.id}
              onClick={() => toggleTile(t.id as TerrainTileType)}
              className={`${btn} justify-start gap-2 px-2 py-1 text-[10px] ${tiles.has(t.id as TerrainTileType) ? 'bg-sky-500 text-white' : 'bg-white/5 hover:bg-white/10'}`}
            >
              <span className="w-3 h-3 rounded" style={{ background: t.primaryColor }} />
              {t.ukrainianName.split(' / ')[0]}
            </button>
          ))}
        </div>
      </Section>
      {(chainType || hasLily) && (
        <Section title="Стебла">
          {hasLily && (
            <div className="flex flex-wrap gap-1">
              <button className={chip(s.placeLilyAnchor === 'surface')} onClick={() => editor.set('placeLilyAnchor', 'surface')}>
                Латаття на поверхню
              </button>
              <button className={chip(s.placeLilyAnchor === 'bottom')} onClick={() => editor.set('placeLilyAnchor', 'bottom')}>
                На дно
              </button>
            </div>
          )}
          {chainType?.chain && (
            <ChainLengthSlider kind={chainType.chain} value={s.placeChainLength} scale={s.scatterScaleMax} head={s.placeLilyHead} onChange={(v) => editor.set('placeChainLength', v)} />
          )}
        </Section>
      )}
      <p className="text-zinc-500 leading-relaxed">
        Тримайте ЛКМ і ведіть — пензель досипає коло до заданої щільності (на місці не накопичує). Shift — стерти, [ ] — розмір. Ctrl+Z скасовує весь мазок.
      </p>
    </>
  );
};

const SelectedInspector: React.FC<{ engine: GameEngine; detailsOnly?: boolean }> = ({ engine, detailsOnly }) => {
  const { editor, props } = engine.world!;
  const id = editor.state.selectedPropId;
  const prop = id !== null ? props.get(id) : undefined;
  if (!prop) return <p className="text-zinc-500">Нічого не вибрано.</p>;
  const def = props.getDefinition(prop.type);
  const canTilt = canTiltProp(prop.type);
  const update = (patch: { x?: number; y?: number; z?: number; rot?: number; scale?: number; tx?: number; tz?: number }) => {
    editor.trackSelectedProp();
    const p = prop.position.clone();
    if (patch.x !== undefined) p.x = patch.x;
    if (patch.y !== undefined) p.y = patch.y;
    if (patch.z !== undefined) p.z = patch.z;
    if (patch.y !== undefined) prop.grounded = false;
    const tilt: [number, number] | undefined = canTilt
      ? [
          patch.tx !== undefined ? THREE.MathUtils.degToRad(patch.tx) : prop.tilt?.[0] ?? 0,
          patch.tz !== undefined ? THREE.MathUtils.degToRad(patch.tz) : prop.tilt?.[1] ?? 0,
        ]
      : undefined;
    editor.setSelectedTransform(p, patch.rot !== undefined ? THREE.MathUtils.degToRad(patch.rot) : prop.rotationY, patch.scale ?? prop.scale, tilt);
  };
  return (
    <Section title={`Інспектор · ${def?.name ?? prop.type} #${prop.id}`}>
      {!detailsOnly && <div className="grid grid-cols-3 gap-1">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <NumberField key={axis} label={axis.toUpperCase()} value={prop.position[axis]} onCommit={(v) => update({ [axis]: v })} />
        ))}
      </div>}
      {!detailsOnly && <div className="grid grid-cols-2 gap-1">
        <NumberField label="Поворот°" value={THREE.MathUtils.radToDeg(prop.rotationY)} onCommit={(v) => update({ rot: v })} />
        <NumberField label="Масштаб" value={prop.scale} onCommit={(v) => update({ scale: Math.max(0.05, v) })} />
      </div>}
      {canTilt && (
        <div className="grid grid-cols-2 gap-1">
          <NumberField label="Нахил X°" value={THREE.MathUtils.radToDeg(prop.tilt?.[0] ?? 0)} onCommit={(v) => update({ tx: v })} />
          <NumberField label="Нахил Z°" value={THREE.MathUtils.radToDeg(prop.tilt?.[1] ?? 0)} onCommit={(v) => update({ tz: v })} />
        </div>
      )}
      <label className="flex items-center gap-2 text-zinc-300">
        <input
          type="checkbox"
          checked={prop.grounded}
          onChange={(e) => {
            editor.trackSelectedProp();
            prop.grounded = e.target.checked;
            const position = prop.position.clone();
            if (prop.grounded) position.y = engine.world!.terrain.getHeight(position.x, position.z);
            editor.setSelectedTransform(position, prop.rotationY, prop.scale, prop.tilt);
          }}
          className="accent-sky-500"
        />
        Прилипати до землі
      </label>
      {def?.chain && (
        <ChainLengthSlider
          kind={def.chain}
          value={prop.length ?? CHAIN_SPECIES[def.chain].cfg.minLinks}
          scale={prop.scale}
          head={prop.head ?? 0}
          onStart={() => editor.trackSelectedProp()}
          onChange={(v) => editor.setSelectedChainLength(v)}
        />
      )}
      {def?.chain === 'lily' && (
        <LilyHeadChips
          head={prop.head ?? 0}
          onChange={(h) => {
            editor.trackSelectedProp();
            editor.setSelectedChainHead(h);
          }}
        />
      )}
      {def?.web && prop.web && (
        <>
          <WebFields params={prop.web} onStart={() => editor.trackSelectedProp()} onChange={(patch) => editor.setSelectedWeb(patch)} />
          <p className="text-[10px] text-zinc-500">Зміна параметрів перебудовує павутину (розрізи заростають).</p>
        </>
      )}
      {def?.web && <WebLookPanel />}
      {def?.chain === 'algae' && (
        <AlgaeColorFields
          colors={prop.colors ?? null}
          onStart={() => editor.trackSelectedProp()}
          onChange={(c) => editor.setSelectedChainColors(c)}
        />
      )}
      {!detailsOnly && <div className="flex gap-1">
        <button className={`${chip(false)} flex-1`} onClick={() => editor.duplicateSelected()}>
          <Copy className="w-3.5 h-3.5" /> Копія
        </button>
        <button className={`${btn} flex-1 gap-1.5 py-1.5 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25`} onClick={() => editor.deleteSelected()}>
          <Trash2 className="w-3.5 h-3.5" /> Видалити
        </button>
      </div>}
    </Section>
  );
};

const ENEMY_INFO: Record<PestKind, { name: string; icon: React.ElementType; where: string }> = {
  hedgehog: { name: 'Їжак', icon: PawPrint, where: 'суша острова' },
  dragon: { name: 'Дракончик', icon: Flame, where: 'суша острова' },
  shark: { name: 'Акула', icon: Fish, where: 'глибоке море' },
  spider: { name: 'Павук', icon: Bug, where: 'печери (і будь-де)' },
};

/** The enemy tool: pick a kind, click the world to put one down; lists and removes the live ones. */
const EnemyPanel: React.FC<{ engine: GameEngine }> = ({ engine }) => {
  const w = engine.world!;
  const editor = w.editor;
  const pests = w.gameplay.pests;
  const s = editor.state;
  const [, force] = useState(0);
  const refresh = () => force((n) => n + 1);
  const player = w.character.getPosition();
  const counts = Object.fromEntries(PEST_KINDS.map((k) => [k, 0])) as Record<PestKind, number>;
  for (const p of pests.pests) counts[p.kind]++;
  const list = [...pests.pests].sort((a, b) => a.position.distanceToSquared(player) - b.position.distanceToSquared(player));
  return (
    <>
      <Section title="Ворог">
        <div className="grid grid-cols-2 gap-1">
          {PEST_KINDS.map((k) => {
            const info = ENEMY_INFO[k];
            const Icon = info.icon;
            return (
              <button
                key={k}
                onClick={() => editor.set('enemyKind', k)}
                className={`${btn} flex-col gap-0.5 py-2 text-[11px] ${s.enemyKind === k ? 'bg-sky-500 text-white' : 'bg-white/5 hover:bg-white/10'}`}
              >
                <Icon className="w-5 h-5" />
                {info.name}
                <span className={`text-[9px] ${s.enemyKind === k ? 'text-sky-100' : 'text-zinc-500'}`}>{info.where}</span>
              </button>
            );
          })}
        </div>
        <p className="text-zinc-400 leading-relaxed">
          Клік у світі — поставити. Зелене коло — тут може жити, червоне — ні. У редакторі вороги стоять, оживають у грі (F1).
        </p>
        <button
          className={`${btn} gap-1.5 py-1.5 bg-white/5 hover:bg-white/10`}
          onClick={() => {
            const before = pests.serializeAuthored();
            const p = pests.spawnNear(s.enemyKind, w.character.getPosition(), !!w.exploration.inCave);
            if (p) {
              editor.recordChange('Розміщення істоти', () => pests.serializeAuthored(), (data) => pests.restoreAuthored(data), before);
              editor.focusOn(p.position);
            }
            else w.editor.onNotify(`Поруч із гравцем немає місця для: ${ENEMY_INFO[s.enemyKind].name}`, 'warning');
            refresh();
          }}
        >
          <User className="w-3.5 h-3.5" /> Поставити біля гравця
        </button>
      </Section>
      <Section title="Природний спавн">
        <label className="flex items-center gap-2 text-zinc-300">
          <input
            type="checkbox"
            checked={pests.naturalSpawn}
            onChange={(e) => {
              pests.naturalSpawn = e.target.checked;
              refresh();
            }}
            className="accent-sky-500"
          />
          Вороги з’являються самі
        </label>
        <button
          className={`${btn} gap-1.5 py-1.5 bg-white/5 hover:bg-white/10 disabled:opacity-30`}
          disabled={!pests.naturalSpawn}
          onClick={() => {
            pests.populate(w.character.getPosition());
            refresh();
          }}
        >
          <Plus className="w-3.5 h-3.5" /> Доповнити до норми
        </button>
      </Section>
      <Section title={`У світі (${pests.pests.length})`}>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-zinc-400">
          {PEST_KINDS.map((k) => (
            <span key={k}>
              {ENEMY_INFO[k].name}: <span className="text-zinc-200 tabular-nums">{counts[k]}</span>
            </span>
          ))}
        </div>
        <div className="flex flex-col max-h-64 overflow-y-auto">
          {list.slice(0, 150).map((p) => {
            const Icon = ENEMY_INFO[p.kind].icon;
            return (
              <div key={p.id} className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-white/10">
                <button className="flex items-center gap-2 flex-1 text-left" onClick={() => editor.focusOn(p.position)} title="Показати">
                  <Icon className="w-3.5 h-3.5 text-rose-400" />
                  {ENEMY_INFO[p.kind].name}
                  <span className="text-zinc-500 tabular-nums">#{p.id}</span>
                  {p.placed && <span className="text-sky-400 text-[9px]">вручну</span>}
                  <span className="ml-auto text-zinc-500 tabular-nums">{Math.round(p.position.distanceTo(player))} м</span>
                </button>
                <button
                  className="text-zinc-500 hover:text-rose-400"
                  title="Прибрати"
                  onClick={() => {
                    const id = pests.authoredId(p);
                    if (id === undefined) {
                      pests.remove(p);
                    } else {
                      editor.trackChange('Видалення істоти', () => pests.serializeAuthored(), (data) => pests.restoreAuthored(data));
                      pests.removeAuthored(id);
                    }
                    refresh();
                  }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          className={`${btn} gap-1.5 py-1.5 bg-rose-600/80 hover:bg-rose-500 text-white disabled:opacity-30`}
          disabled={!pests.pests.length}
          onClick={() => {
            pests.clear();
            refresh();
          }}
        >
          <Trash2 className="w-3.5 h-3.5" /> Прибрати всіх
        </button>
      </Section>
    </>
  );
};

const SOUND_ROWS: { key: keyof WeatherSound; label: string; max: number }[] = [
  { key: 'rain', label: 'Дощ', max: 2 },
  { key: 'wind', label: 'Вітер', max: 1.5 },
  { key: 'thunder', label: 'Грім', max: 2 },
  { key: 'birds', label: 'Птахи (у лісі)', max: 1.5 },
  { key: 'birdRate', label: 'Частота співу птахів', max: 3 },
  { key: 'insects', label: 'Цвіркуни вночі', max: 1.5 },
  { key: 'breeze', label: 'Легкий вітерець', max: 1.5 },
  { key: 'fog', label: 'Шум туману', max: 2 },
];

const PRECIP_LABELS: Record<'none' | 'rain' | 'snow', string> = { none: 'Нема', rain: 'Дощ', snow: 'Сніг' };

const ColorRow: React.FC<{ label: string; value: THREE.Color; onChange(hex: number): void; onStart?(): void }> = ({ label, value, onChange, onStart }) => (
  <label className="flex items-center justify-between text-zinc-400">
    <span>{label}</span>
    <span className="flex items-center gap-2">
      <span className="text-zinc-200 tabular-nums">#{value.getHexString()}</span>
      <input
        type="color"
        value={`#${value.getHexString()}`}
        onPointerDown={onStart}
        onChange={(e) => onChange(parseInt(e.target.value.slice(1), 16))}
        className="w-8 h-6 bg-transparent border border-white/10 rounded cursor-pointer"
      />
    </span>
  </label>
);

/** Live editor for every parameter of one weather type; edits apply instantly and persist in localStorage. */
const WeatherTuner: React.FC<{ type: WeatherType; rerender(): void }> = ({ type: current, rerender }) => {
  const [type, setType] = useState<WeatherType>(current);
  const p = WEATHER_PROFILES[type];
  const edit = (fn: () => void) => {
    fn();
    WeatherProfiles.save();
    rerender();
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <Section
      title={`Налаштування: ${WEATHER_LABELS[type]}`}
      right={
        <button className="text-sky-400 hover:text-sky-300 normal-case" onClick={() => edit(() => WeatherProfiles.reset(type))}>
          скинути
        </button>
      }
    >
      <div className="grid grid-cols-3 gap-1">
        {(Object.keys(WEATHER_LABELS) as WeatherType[]).map((t) => (
          <button key={t} className={chip(type === t)} onClick={() => setType(t)}>
            {WEATHER_LABELS[t]}
          </button>
        ))}
      </div>
      {type !== current && <p className="text-amber-400">Зараз активна інша погода — зміни видно після її вибору вище.</p>}
      <Slider label="Світло сонця" value={p.light} min={0} max={1.5} step={0.01} onChange={(v) => edit(() => (p.light = v))} fmt={pct} />
      <Slider label="Густина туману" value={p.fog} min={0} max={0.12} step={0.0005} onChange={(v) => edit(() => (p.fog = v))} fmt={(v) => v.toFixed(4)} />
      <ColorRow label="Тон неба" value={p.tint} onChange={(h) => edit(() => p.tint.setHex(h))} />
      <ColorRow label="Колір серпанку" value={p.haze} onChange={(h) => edit(() => p.haze.setHex(h))} />
      <Slider label="Сила серпанку" value={p.hazeMix} min={0} max={1} step={0.01} onChange={(v) => edit(() => (p.hazeMix = v))} fmt={pct} />
      <Slider label="Хмарність" value={p.cover} min={0} max={1} step={0.01} onChange={(v) => edit(() => (p.cover = v))} fmt={pct} />
      <Slider label="Темрява хмар" value={p.dark} min={0} max={1} step={0.01} onChange={(v) => edit(() => (p.dark = v))} fmt={pct} />
      <div className="grid grid-cols-3 gap-1">
        {(['none', 'rain', 'snow'] as const).map((k) => (
          <button key={k} className={chip(p.precipitation === k)} onClick={() => edit(() => (p.precipitation = k))}>
            {PRECIP_LABELS[k]}
          </button>
        ))}
      </div>
      <Slider label="Інтенсивність опадів" value={p.amount} min={0} max={1} step={0.01} onChange={(v) => edit(() => (p.amount = v))} fmt={pct} />
      <p className="text-zinc-500 uppercase tracking-wide pt-1">Звуки</p>
      {SOUND_ROWS.map((r) => (
        <Slider
          key={r.key}
          label={r.label}
          value={p.sound[r.key]}
          min={0}
          max={r.max}
          step={0.01}
          onChange={(v) => edit(() => (p.sound[r.key] = v))}
          fmt={r.key === 'birdRate' ? (v) => `×${v.toFixed(2)}` : pct}
        />
      ))}
      {type !== 'storm' && p.sound.thunder > 0 && <p className="text-zinc-500">Грім лунає лише після блискавок (тільки гроза).</p>}
      <div className="flex gap-1">
        <button className={`${chip(false)} flex-1`} onClick={() => edit(() => WeatherProfiles.resetAll())}>
          Скинути все
        </button>
        <button
          className={`${chip(false)} flex-1`}
          onClick={() => navigator.clipboard?.writeText(JSON.stringify(Object.fromEntries(Object.entries(WEATHER_PROFILES).map(([k, v]) => [k, { ...v, tint: `#${v.tint.getHexString()}`, haze: `#${v.haze.getHexString()}` }])), null, 2))}
        >
          Копіювати JSON
        </button>
      </div>
    </Section>
  );
};

/** Listen to each bird voice and switch off the ones that should not sing in the forests. */
const BirdVoices: React.FC<{ engine: GameEngine; rerender(): void }> = ({ engine, rerender }) => (
  <Section title="Голоси птахів">
    {BIRD_SPECIES.map((b, i) => (
      <div key={b.id} className="flex items-center gap-2">
        <button
          className={`${chip(false)} w-8 shrink-0`}
          title="Прослухати"
          onClick={() => engine.ambient.previewBird(i)}
        >
          ▶
        </button>
        <span className={`flex-1 ${birdSpeciesEnabled[i] ? 'text-zinc-200' : 'text-zinc-500 line-through'}`}>{b.label}</span>
        <button
          className={chip(birdSpeciesEnabled[i])}
          onClick={() => {
            setBirdSpeciesEnabled(i, !birdSpeciesEnabled[i]);
            rerender();
          }}
        >
          {birdSpeciesEnabled[i] ? 'увімк.' : 'вимк.'}
        </button>
      </div>
    ))}
    {!birdSpeciesEnabled.some(Boolean) && <p className="text-amber-400">Усі голоси вимкнені — у лісі буде тихо.</p>}
  </Section>
);

const AtmospherePanel: React.FC<{ engine: GameEngine; rerender(): void }> = ({ engine, rerender }) => {
  const w = engine.world!;
  const appliedDepth = -w.terrain.seaFloorY;
  const [seaFloorDepth, setSeaFloorDepth] = useState(appliedDepth);
  useEffect(() => setSeaFloorDepth(appliedDepth), [appliedDepth]);
  const set = (fn: () => void) => {
    fn();
    rerender();
  };
  return (
    <>
      <Section title="Час доби">
        <Slider
          label="Година"
          value={worldSettings.timeOfDay}
          min={0}
          max={23.99}
          step={0.05}
          onChange={(v) => set(() => (worldSettings.timeOfDay = v))}
          fmt={() => w.weather.getClockLabel()}
        />
        <Slider
          label="Секунд на годину"
          value={worldSettings.secondsPerHour}
          min={0}
          max={180}
          step={5}
          onChange={(v) => set(() => (worldSettings.secondsPerHour = v))}
          fmt={(v) => (v === 0 ? 'стоїть' : `${v} с`)}
        />
      </Section>
      <Section title="Пора року">
        <div className="grid grid-cols-4 gap-1">
          {SEASONS.map((s) => (
            <button
              key={s}
              className={chip(currentSeason() === s)}
              onClick={() => set(() => (worldSettings.season = s))}
            >
              {SEASON_LABELS[s]}
            </button>
          ))}
        </div>
        <Slider
          label="Сніг на землі"
          value={w.weather.snowCover}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => set(() => (w.weather.snowCover = v))}
          fmt={(v) => `${Math.round(v * 100)}%`}
        />
      </Section>
      <Section title="Погода">
        <div className="grid grid-cols-3 gap-1">
          {(Object.keys(WEATHER_LABELS) as WeatherType[]).map((t) => (
            <button key={t} className={chip(w.weather.weather === t)} onClick={() => set(() => w.weather.setWeather(t))}>
              {WEATHER_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            className={chip(w.weather.director.auto)}
            onClick={() => set(() => (w.weather.director.auto = !w.weather.director.auto))}
          >
            Авто: {w.weather.director.auto ? 'увімк.' : 'вимк.'}
          </button>
          <span className="text-xs opacity-70">
            зміна через {w.weather.director.hoursUntilChange.toFixed(1)} год
          </span>
        </div>
        {w.weather.director.auto && (
          <div className="mt-1 text-xs opacity-80">
            Прогноз:{' '}
            {w.weather.director
              .forecast()
              .map((f) => `${String(Math.floor(f.atHour)).padStart(2, '0')}:${String(Math.floor((f.atHour % 1) * 60)).padStart(2, '0')} ${WEATHER_LABELS[f.type]}`)
              .join(' → ')}
          </div>
        )}
      </Section>
      <WeatherTuner type={w.weather.weather} rerender={rerender} />
      <CloudShadowTuner rerender={rerender} />
      <NightLightModeTuner rerender={rerender} />
      <BirdVoices engine={engine} rerender={rerender} />
      <Section title="Вода">
        <Slider
          label="Рівень води"
          value={worldSettings.waterLevel}
          min={-6}
          max={4}
          step={0.05}
          onChange={(v) => set(() => (worldSettings.waterLevel = v))}
          fmt={(v) => `${v.toFixed(2)} м`}
        />
        <Slider
          label="Глибина морського дна від Y = 0"
          value={seaFloorDepth}
          min={MIN_SEA_FLOOR_DEPTH}
          max={MAX_SEA_FLOOR_DEPTH}
          step={1}
          onChange={setSeaFloorDepth}
          fmt={(depth) => `${depth} м`}
        />
        <button
          type="button"
          className={`${chip(false)} disabled:opacity-40`}
          disabled={seaFloorDepth === appliedDepth}
          onClick={() => set(() => {
            w.editor.trackChange('Глибина морського дна', () => -w.terrain.seaFloorY, (depth) => w.terrain.setSeaFloorDepth(depth));
            w.terrain.setSeaFloorDepth(seaFloorDepth);
          })}
        >
          Застосувати глибину
        </button>
      </Section>
      <CausticsTuner rerender={rerender} />
      <LightShaftTuner rerender={rerender} />
      <PickGlowTuner rerender={rerender} />
      <FlameTuner rerender={rerender} />
    </>
  );
};

const NIGHT_LIGHT_MODE_LABELS: Record<NightLightMode, { label: string; hint: string }> = {
  legacy: { label: 'Старий', hint: 'Ламберт + 0.3: світло падає і на зворотний бік стін' },
  wrap: { label: 'Wrap', hint: 'Поверхні, повернуті від лампи, лишаються темними' },
  room: { label: 'Wrap + кімната', hint: 'Як Wrap, і світло ламп у будівлях обрізане коробкою кімнати' },
};

/** Shading mode of the lamps / campfires / cave lights (saved in this browser). */
const NightLightModeTuner: React.FC<{ rerender(): void }> = ({ rerender }) => {
  const mode = nightLightSettings.mode;
  return (
    <Section title="Нічні джерела світла">
      <div className="grid grid-cols-3 gap-1">
        {NIGHT_LIGHT_MODES.map((m) => (
          <button key={m} className={chip(mode === m)} onClick={() => (setNightLightMode(m), rerender())}>
            {NIGHT_LIGHT_MODE_LABELS[m].label}
          </button>
        ))}
      </div>
      <div className="mt-1 text-xs opacity-70">{NIGHT_LIGHT_MODE_LABELS[mode].hint}</div>
    </Section>
  );
};

/** Fake cloud shadows drifting over the world (saved in this browser). */
const CloudShadowTuner: React.FC<{ rerender(): void }> = ({ rerender }) => {
  const c = cloudShadowSettings;
  const set = <K extends keyof CloudShadowSettings>(k: K, v: CloudShadowSettings[K]) => {
    c[k] = v;
    saveCloudShadowSettings();
    rerender();
  };
  const sliders: { k: Exclude<keyof CloudShadowSettings, 'enabled'>; label: string; min: number; max: number; step: number; fmt(v: number): string }[] = [
    { k: 'strength', label: 'Сила тіні', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
    { k: 'size', label: 'Розмір хмар', min: 40, max: 600, step: 10, fmt: (v) => `${v} м` },
    { k: 'speed', label: 'Швидкість руху', min: 0, max: 15, step: 0.1, fmt: (v) => `${v.toFixed(1)} м/с` },
    { k: 'softness', label: 'Мʼякість країв', min: 0.01, max: 0.4, step: 0.01, fmt: (v) => v.toFixed(2) },
    { k: 'coverBias', label: 'Більше / менше тіней, ніж хмар у небі', min: -0.5, max: 0.5, step: 0.01, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2) },
  ];
  return (
    <Section title="Тіні від хмар">
      <label className="flex items-center gap-2 text-zinc-400">
        <input type="checkbox" checked={c.enabled} onChange={(e) => set('enabled', e.target.checked)} className="accent-sky-500" />
        Тіні від хмар на землі (залежать від хмарності погоди)
      </label>
      {sliders.map((s) => (
        <Slider key={s.k} label={s.label} value={c[s.k]} min={s.min} max={s.max} step={s.step} fmt={s.fmt} onChange={(v) => set(s.k, v)} />
      ))}
      <button className={chip(false)} onClick={() => (resetCloudShadowSettings(), rerender())}>
        Скинути
      </button>
    </Section>
  );
};

type FlameColorKey = 'colorCore' | 'colorMid' | 'colorOuter';

/** Shader flames of campfires and torches (saved in this browser; applies to every flame at once). */
const FlameTuner: React.FC<{ rerender(): void }> = ({ rerender }) => {
  const c = flameSettings;
  const set = <K extends keyof FlameSettings>(k: K, v: FlameSettings[K]) => {
    c[k] = v;
    saveFlameSettings();
    rerender();
  };
  const f2 = (v: number) => v.toFixed(2);
  const sliders: { k: Exclude<keyof FlameSettings, FlameColorKey>; label: string; min: number; max: number; step: number }[] = [
    { k: 'speed', label: 'Швидкість горіння', min: 0.1, max: 5, step: 0.05 },
    { k: 'displacement', label: 'Сила язиків полумʼя', min: 0, max: 1.2, step: 0.01 },
    { k: 'frequency', label: 'Деталізація (частота шуму)', min: 0.5, max: 6, step: 0.1 },
    { k: 'stretch', label: 'Висота язиків (тяга)', min: 0, max: 2, step: 0.05 },
    { k: 'turbulence', label: 'Турбулентність', min: 0, max: 3, step: 0.05 },
    { k: 'brightness', label: 'Температура (яскравість)', min: 0.5, max: 2.5, step: 0.05 },
    { k: 'fresnel', label: 'Мʼякість країв (Fresnel)', min: 0.5, max: 5, step: 0.1 },
    { k: 'sparks', label: 'Іскри (кількість)', min: 0, max: 1, step: 0.05 },
    { k: 'sparkHeight', label: 'Висота іскор', min: 0.3, max: 3, step: 0.05 },
    { k: 'playerWind', label: 'Вітер від гравця (сила)', min: 0, max: 3, step: 0.05 },
    { k: 'playerWindRadius', label: 'Вітер від гравця (радіус, м)', min: 0.5, max: 6, step: 0.1 },
    { k: 'weatherWind', label: 'Погодний вітер (сила)', min: 0, max: 3, step: 0.05 },
  ];
  const colors: { k: FlameColorKey; label: string }[] = [
    { k: 'colorCore', label: 'Ядро' },
    { k: 'colorMid', label: 'Полумʼя' },
    { k: 'colorOuter', label: 'Край' },
  ];
  return (
    <Section title="Полумʼя (багаття, факели)">
      {sliders.map((s) => (
        <Slider key={s.k} label={s.label} value={c[s.k]} min={s.min} max={s.max} step={s.step} fmt={f2} onChange={(v) => set(s.k, v)} />
      ))}
      <div className="grid grid-cols-3 gap-1">
        {colors.map((s) => (
          <label key={s.k} className="flex flex-col items-center gap-1 rounded-lg bg-white/5 p-1.5 text-[10px] text-zinc-400">
            <input type="color" value={c[s.k]} onChange={(e) => set(s.k, e.target.value)} className="h-6 w-8 cursor-pointer bg-transparent" />
            {s.label}
          </label>
        ))}
      </div>
      <button className={chip(false)} onClick={() => (resetFlameSettings(), rerender())}>
        Скинути до стандартних
      </button>
    </Section>
  );
};

/** Glow of the things that can be picked up near the player (saved in this browser). */
const PickGlowTuner: React.FC<{ rerender(): void }> = ({ rerender }) => {
  const c = pickGlowSettings;
  const set = <K extends keyof PickGlowSettings>(k: K, v: PickGlowSettings[K]) => {
    c[k] = v;
    savePickGlowSettings();
    rerender();
  };
  const sliders: { k: Exclude<keyof PickGlowSettings, 'enabled'>; label: string; min: number; max: number; step: number; fmt(v: number): string }[] = [
    { k: 'strength', label: 'До білого на піку', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
    { k: 'speed', label: 'Блимань за секунду', min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
    { k: 'rim', label: 'Яскравіше по краях (контур)', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  ];
  return (
    <Section title="Підсвітка того, що можна підібрати">
      <label className="flex items-center gap-2 text-zinc-400">
        <input type="checkbox" checked={c.enabled} onChange={(e) => set('enabled', e.target.checked)} className="accent-sky-500" />
        Світиться те, про що зараз підказка в HUD (тюльпани, стигла грядка)
      </label>
      {sliders.map((s) => (
        <Slider key={s.k} label={s.label} value={c[s.k]} min={s.min} max={s.max} step={s.step} fmt={s.fmt} onChange={(v) => set(s.k, v)} />
      ))}
      <button className={chip(false)} onClick={() => (resetPickGlowSettings(), rerender())}>
        Скинути
      </button>
    </Section>
  );
};

/** Underwater light shafts (saved in this browser). */
const LightShaftTuner: React.FC<{ rerender(): void }> = ({ rerender }) => {
  const c = lightShaftSettings;
  const set = <K extends keyof LightShaftSettings>(k: K, v: LightShaftSettings[K]) => {
    c[k] = v;
    saveLightShaftSettings();
    rerender();
  };
  const sliders: { k: Exclude<keyof LightShaftSettings, 'enabled'>; label: string; min: number; max: number; step: number; fmt(v: number): string }[] = [
    { k: 'strength', label: 'Яскравість', min: 0, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
    { k: 'count', label: 'Променів одночасно', min: 1, max: 32, step: 1, fmt: (v) => String(v) },
    { k: 'width', label: 'Ширина', min: 0.2, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)} м` },
    { k: 'length', label: 'Довжина', min: 3, max: 30, step: 0.5, fmt: (v) => `${v.toFixed(1)} м` },
    { k: 'radius', label: 'Радіус навколо камери', min: 5, max: 40, step: 1, fmt: (v) => `${v} м` },
    { k: 'flicker', label: 'Швидкість мерехтіння', min: 0, max: 4, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
    { k: 'life', label: 'Тривалість променя', min: 1, max: 15, step: 0.5, fmt: (v) => `${v.toFixed(1)} с` },
  ];
  return (
    <Section title="Промені світла під водою">
      <label className="flex items-center gap-2 text-zinc-400">
        <input type="checkbox" checked={c.enabled} onChange={(e) => set('enabled', e.target.checked)} className="accent-sky-500" />
        Промені від сонця під водою (на телефонах — удвічі менше)
      </label>
      {sliders.map((s) => (
        <Slider key={s.k} label={s.label} value={c[s.k]} min={s.min} max={s.max} step={s.step} fmt={s.fmt} onChange={(v) => set(s.k, v)} />
      ))}
      <button className={chip(false)} onClick={() => (resetLightShaftSettings(), rerender())}>
        Скинути
      </button>
    </Section>
  );
};

/** Live look of the underwater caustics (saved in this browser). */
const CausticsTuner: React.FC<{ rerender(): void }> = ({ rerender }) => {
  const c = causticsSettings;
  const set = <K extends keyof CausticsSettings>(k: K, v: CausticsSettings[K]) => {
    c[k] = v;
    applyCausticsSettings();
    rerender();
  };
  const sliders: { k: Exclude<keyof CausticsSettings, 'alwaysOn'>; label: string; min: number; max: number; step: number; fmt(v: number): string }[] = [
    { k: 'intensity', label: 'Яскравість', min: 0, max: 5, step: 0.05, fmt: (v) => v.toFixed(2) },
    { k: 'scale', label: 'Щільність візерунка', min: 0.03, max: 0.5, step: 0.01, fmt: (v) => `${(1 / v).toFixed(1)} м на повтор` },
    { k: 'speed', label: 'Швидкість', min: 0, max: 4, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
    { k: 'contrast', label: 'Різкість ліній', min: 0.5, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) },
    { k: 'aberration', label: 'Хроматична аберація', min: 0, max: 12, step: 0.5, fmt: (v) => (v === 0 ? 'вимк.' : `${v} текс.`) },
    { k: 'depthFalloff', label: 'Згасання з глибиною', min: 0, max: 0.5, step: 0.01, fmt: (v) => `${v.toFixed(2)} / м` },
    { k: 'maxDistance', label: 'Дальність', min: 10, max: 120, step: 1, fmt: (v) => `${v} м` },
  ];
  return (
    <Section title="Каустика">
      {sliders.map((s) => (
        <Slider key={s.k} label={s.label} value={c[s.k]} min={s.min} max={s.max} step={s.step} fmt={s.fmt} onChange={(v) => set(s.k, v)} />
      ))}
      <label className="flex items-center gap-2 text-zinc-400">
        <input type="checkbox" checked={c.alwaysOn} onChange={(e) => set('alwaysOn', e.target.checked)} className="accent-sky-500" />
        Показувати й з камерою над водою
      </label>
      <button className={chip(false)} onClick={() => (resetCausticsSettings(), rerender())}>
        Скинути
      </button>
    </Section>
  );
};

const hexOf = (n: number) => '#' + n.toString(16).padStart(6, '0');

type WaterNum = { [K in keyof WaterSettings]: WaterSettings[K] extends number ? K : never }[keyof WaterSettings];
interface WaterSlider { k: WaterNum; label: string; min: number; max: number; step: number; fmt?(v: number): string }

const WATER_GROUPS: { title: string; sliders: WaterSlider[] }[] = [
  {
    title: 'Глибина',
    sliders: [{ k: 'depthFalloff', label: 'Швидкість потемніння', min: 0.02, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) }],
  },
  {
    title: 'Хвилі',
    sliders: [
      { k: 'waveNear', label: 'Нахил поблизу', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
      { k: 'waveFar', label: 'Нахил удалині', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
      { k: 'waveScale1', label: 'Великі хвилі (щільність)', min: 0.005, max: 0.3, step: 0.005, fmt: (v) => `${(1 / v).toFixed(0)} м на повтор` },
      { k: 'waveScale2', label: 'Дрібні хвилі (щільність)', min: 0.02, max: 0.6, step: 0.005, fmt: (v) => `${(1 / v).toFixed(1)} м на повтор` },
      { k: 'waveSpeed', label: 'Швидкість', min: 0, max: 8, step: 0.1, fmt: (v) => `×${v.toFixed(1)}` },
      { k: 'detailStart', label: 'Спокій від', min: 0, max: 300, step: 5, fmt: (v) => `${v} м` },
      { k: 'detailEnd', label: 'Повний спокій на', min: 10, max: 500, step: 5, fmt: (v) => `${v} м` },
    ],
  },
  {
    title: 'Відблиски',
    sliders: [
      { k: 'fresnel', label: 'Дзеркальність неба', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
      { k: 'glint', label: 'Блик сонця', min: 0, max: 8, step: 0.1, fmt: (v) => v.toFixed(1) },
      { k: 'glintSharpness', label: 'Гострота блику', min: 8, max: 1000, step: 1, fmt: (v) => v.toFixed(0) },
    ],
  },
  {
    title: 'Іскри на воді',
    sliders: [
      { k: 'sparkle', label: 'Яскравість іскор', min: 0, max: 20, step: 0.1, fmt: (v) => (v > 0 ? v.toFixed(1) : 'вимк.') },
      { k: 'sparkleDensity', label: 'Частота іскор', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
      { k: 'sparkleSize', label: 'Розмір грані', min: 0.04, max: 0.6, step: 0.01, fmt: (v) => `${Math.round(v * 100)} см` },
      { k: 'sparkleSpread', label: 'Ширина доріжки', min: 0.05, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
      { k: 'sparkleStars', label: 'Зірочки (яскравість)', min: 0, max: 15, step: 0.1, fmt: (v) => (v > 0 ? v.toFixed(1) : 'вимк.') },
      { k: 'sparkleStarSize', label: 'Розмір зірочок', min: 4, max: 64, step: 1, fmt: (v) => `${v} px` },
      { k: 'sparkleStarDensity', label: 'Частота зірочок', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
    ],
  },
  {
    title: 'Піна',
    sliders: [
      { k: 'foamAmount', label: 'Кількість', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
      { k: 'foamLine', label: 'Лінія берега', min: 0.01, max: 0.6, step: 0.01, fmt: (v) => `${v.toFixed(2)} м` },
      { k: 'rippleSpeed', label: 'Швидкість ліній біля берега', min: 0, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
      { k: 'shoreLineCount', label: 'Ліній одночасно', min: 1, max: 4, step: 1, fmt: (v) => String(v) },
      { k: 'shoreLineWidth', label: 'Товщина ліній', min: 0.01, max: 0.15, step: 0.005, fmt: (v) => `${Math.round(v * 200)} см` },
      { k: 'shoreLineReach', label: 'Відстань від берега', min: 0.5, max: 7, step: 0.1, fmt: (v) => `${v.toFixed(1)} м` },
      { k: 'shoreLineDash', label: 'Щільність штрихів', min: 0.05, max: 2, step: 0.05, fmt: (v) => `${(1 / v).toFixed(1)} м` },
      { k: 'shoreLineGap', label: 'Розриви', min: 0, max: 0.9, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
    ],
  },
];

const RIPPLE_SIM_SLIDERS: WaterSlider[] = [
  { k: 'rippleSimArea', label: 'Розмір області', min: 8, max: 64, step: 1, fmt: (v) => `${v} м (${((v / RIPPLE_SIM_RES) * 100).toFixed(1)} см/тексель)` },
  { k: 'rippleSimSpeed', label: 'Швидкість хвиль', min: 0.03, max: 0.5, step: 0.01, fmt: (v) => v.toFixed(2) },
  { k: 'rippleSimDamping', label: 'Затухання', min: 0.95, max: 0.998, step: 0.001, fmt: (v) => v.toFixed(3) },
  { k: 'rippleSimCrest', label: 'Поріг білого гребеня', min: 0.002, max: 0.08, step: 0.001, fmt: (v) => v.toFixed(3) },
  { k: 'rippleSimSlope', label: 'Нахил (блиск)', min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
  { k: 'rippleSimWake', label: 'Слід за тілом', min: 0, max: 4, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
];

const RIPPLE_SIM_RAIN_SLIDERS: WaterSlider[] = [
  { k: 'rippleSimRainAmount', label: 'Кількість крапель', min: 0.1, max: 4, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
  { k: 'rippleSimRainStrength', label: 'Сила крапель', min: 0.1, max: 4, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
];

/** Live look of the sea shader (saved in this browser). */
const WaterPanel: React.FC<{ rerender(): void }> = ({ rerender }) => {
  const w = waterSettings;
  const set = <K extends keyof WaterSettings>(k: K, v: WaterSettings[K]) => {
    w[k] = v;
    saveWaterSettings();
    rerender();
  };
  const colors = [
    ['shallowColor', 'Мілко'],
    ['deepColor', 'Глибоко'],
    ['foamColor', 'Піна'],
  ] as const;
  return (
    <>
      <Section title="Прозорість">
        <label className="flex items-center gap-2 text-zinc-400">
          <input type="checkbox" checked={w.transparent} onChange={(e) => set('transparent', e.target.checked)} className="accent-sky-500" />
          Прозора вода (вимк. = суцільна, швидше)
        </label>
        <div className={w.transparent ? '' : 'opacity-40 pointer-events-none'}>
          <Slider label="Непрозорість" value={w.opacity} min={0.05} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set('opacity', v)} />
        </div>
      </Section>
      <Section title="Кольори">
        <div className="grid grid-cols-3 gap-2">
          {colors.map(([k, label]) => (
            <label key={k} className="flex flex-col items-center gap-1 text-[10px] text-zinc-400">
              <input
                type="color"
                value={hexOf(w[k])}
                onChange={(e) => set(k, parseInt(e.target.value.slice(1), 16))}
                className="w-full h-7 bg-transparent border border-white/10 rounded cursor-pointer"
              />
              {label}
            </label>
          ))}
        </div>
      </Section>
      {WATER_GROUPS.map((g) => (
        <Section key={g.title} title={g.title}>
          {g.sliders.map((s) => (
            <Slider key={s.k} label={s.label} value={w[s.k]} min={s.min} max={s.max} step={s.step} fmt={s.fmt} onChange={(v) => set(s.k, v)} />
          ))}
          {g.title === 'Піна' && (
            <label className="flex items-center gap-2 text-zinc-400">
              <input type="checkbox" checked={w.rippleFoam} onChange={(e) => set('rippleFoam', e.target.checked)} className="accent-sky-500" />
              Лінії, що наближаються до берега (море, річки, озера)
            </label>
          )}
        </Section>
      ))}
      <Section title="Хвилі від гравця">
        <div className="flex gap-1">
          <button className={chip(!w.rippleSim)} onClick={() => set('rippleSim', false)}>
            Кола (шейдер)
          </button>
          <button className={chip(w.rippleSim)} onClick={() => set('rippleSim', true)}>
            Симуляція
          </button>
        </div>
        <p className="text-[10px] text-zinc-500">
          {w.rippleSim
            ? `Справжні хвилі на GPU: ${RIPPLE_SIM_RES}² текселів на ${w.rippleSimArea} м навколо гравця, засинає, коли вода спокійна`
            : 'Аналітичні кола: найдешевше, рахуються лише видимі'}
        </p>
        <div className={w.rippleSim ? '' : 'opacity-40 pointer-events-none'}>
          <label className="flex items-center gap-2 text-zinc-400">
            <input type="checkbox" checked={w.rippleSimCrestOn} onChange={(e) => set('rippleSimCrestOn', e.target.checked)} className="accent-sky-500" />
            Білий гребінь (вимк. = хвилі видно лише за світлом і бликами)
          </label>
          {RIPPLE_SIM_SLIDERS.filter((s) => w.rippleSimCrestOn || s.k !== 'rippleSimCrest').map((s) => (
            <Slider key={s.k} label={s.label} value={w[s.k]} min={s.min} max={s.max} step={s.step} fmt={s.fmt} onChange={(v) => set(s.k, v)} />
          ))}
          <label className="flex items-center gap-2 text-zinc-400">
            <input type="checkbox" checked={w.rippleSimRain} onChange={(e) => set('rippleSimRain', e.target.checked)} className="accent-sky-500" />
            Краплі дощу на воді (лише в області симуляції біля гравця)
          </label>
          {w.rippleSimRain &&
            RIPPLE_SIM_RAIN_SLIDERS.map((s) => (
              <Slider key={s.k} label={s.label} value={w[s.k]} min={s.min} max={s.max} step={s.step} fmt={s.fmt} onChange={(v) => set(s.k, v)} />
            ))}
        </div>
      </Section>
      <button className={chip(false)} onClick={() => (resetWaterSettings(), rerender())}>
        Скинути
      </button>
    </>
  );
};

type VegNum = { [K in keyof VegetationSettings]: VegetationSettings[K] extends number ? K : never }[keyof VegetationSettings];
type VegBool = { [K in keyof VegetationSettings]: VegetationSettings[K] extends boolean ? K : never }[keyof VegetationSettings];
interface VegSlider { k: VegNum; label: string; min: number; max: number; step: number; fmt?(v: number): string }
const fm = (v: number) => `${v.toFixed(v < 1 ? 2 : 0)} м`;
const f2 = (v: number) => v.toFixed(2);
const f0 = (v: number) => v.toFixed(0);
const REBUILD_NOTE = 'Перебудова через мить після зміни';

const VEG_GROUPS: { title: string; toggle?: [VegBool, string]; note?: string; sliders: VegSlider[] }[] = [
  {
    title: 'Трава',
    toggle: ['grassEnabled', 'Показувати траву'],
    sliders: [
      { k: 'grassPatch', label: 'Розмір ділянки навколо камери', min: 16, max: 120, step: 1, fmt: fm },
      { k: 'grassBlades', label: 'Травинок на сторону (щільність)', min: 40, max: 400, step: 5, fmt: (v) => `${v} (${Math.round((v * v) / 1000)} тис.)` },
      { k: 'grassHeight', label: 'Висота', min: 0.1, max: 1.5, step: 0.01, fmt: fm },
      { k: 'grassWidth', label: 'Ширина', min: 0.01, max: 0.2, step: 0.005, fmt: (v) => `${v.toFixed(3)} м` },
      { k: 'grassWind', label: 'Вітер', min: 0, max: 3, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
      { k: 'grassBaseShade', label: 'Яскравість біля коріння', min: 0.2, max: 1.5, step: 0.01, fmt: f2 },
      { k: 'grassTipShade', label: 'Яскравість кінчиків', min: 0.4, max: 2, step: 0.01, fmt: f2 },
      { k: 'grassTrail', label: 'Слід у траві (сила)', min: 0, max: 2, step: 0.05, fmt: (v) => (v === 0 ? 'вимк.' : `×${v.toFixed(2)}`) },
      { k: 'grassTrailRecover', label: 'Трава піднімається за', min: 0.5, max: 15, step: 0.5, fmt: (v) => `${v.toFixed(1)} с` },
      { k: 'grassBendLight', label: 'Світліше, чим нижче прогнулась', min: 0, max: 1.5, step: 0.01, fmt: (v) => (v === 0 ? 'вимк.' : `+${Math.round(v * 100)}%`) },
    ],
  },
  {
    title: 'Відстані дерев і кущів',
    sliders: [
      { k: 'treeViewDist', label: 'Дерева видно до', min: 60, max: 500, step: 5, fmt: fm },
      { k: 'oakNearDist', label: 'Дуб: листя (LOD 1) до', min: 10, max: 200, step: 1, fmt: fm },
      { k: 'pineNearDist', label: 'Ялина: лапи (LOD 1) до', min: 10, max: 200, step: 1, fmt: fm },
      { k: 'bushNearDist', label: 'Кущ: листя (LOD 1) до', min: 5, max: 130, step: 1, fmt: fm },
      { k: 'treeFarDist', label: 'Дерева: LOD 2 до', min: 30, max: 300, step: 1, fmt: fm },
      { k: 'lodHysteresis', label: 'Запас від мерехтіння LOD', min: 0, max: 30, step: 1, fmt: fm },
      { k: 'lodFade', label: 'Плавність переходу LOD', min: 0.05, max: 2, step: 0.05, fmt: (v) => `${v.toFixed(2)} с` },
    ],
  },
  {
    title: 'Вітер у листі',
    sliders: [
      { k: 'leafWind', label: 'Сила', min: 0, max: 0.15, step: 0.005, fmt: (v) => v.toFixed(3) },
      { k: 'leafWindSpeed', label: 'Швидкість', min: 0, max: 4, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
    ],
  },
  {
    title: 'Дуб — листя',
    toggle: ['oakLeaves', 'Листя на ближньому LOD'],
    note: REBUILD_NOTE,
    sliders: [
      { k: 'oakCount', label: 'Максимум листків', min: 100, max: 3000, step: 50, fmt: f0 },
      { k: 'oakSpacing', label: 'Відстань між листками', min: 0.1, max: 1, step: 0.01, fmt: fm },
      { k: 'oakSize', label: 'Розмір листка', min: 0.2, max: 1.5, step: 0.01, fmt: fm },
      { k: 'oakOffset', label: 'Відступ від крони', min: 0, max: 0.3, step: 0.005, fmt: fm },
      { k: 'oakInnerShade', label: 'Тінь усередині крони', min: 0.2, max: 1.2, step: 0.01, fmt: f2 },
    ],
  },
  {
    title: 'Ялина — лапи',
    toggle: ['pineNeedles', 'Лапи на ближньому LOD'],
    note: REBUILD_NOTE,
    sliders: [
      { k: 'pineCount', label: 'Лап у ряду', min: 3, max: 12, step: 1, fmt: (v: number) => String(v) },
      { k: 'pineSpacing', label: 'Крок між рядами лап', min: 0.2, max: 1.2, step: 0.01, fmt: fm },
      { k: 'pineLength', label: 'Провисання лап', min: 0.3, max: 2, step: 0.01, fmt: f2 },
      { k: 'pineWidth', label: 'Ширина лапи (від довжини)', min: 0.2, max: 1.2, step: 0.01, fmt: f2 },
      { k: 'pineOffset', label: 'Виступ за крону', min: -0.5, max: 1, step: 0.01, fmt: fm },
      { k: 'pineInnerShade', label: 'Тінь усередині крони', min: 0.2, max: 1.2, step: 0.01, fmt: f2 },
      { k: 'pineCrownShade', label: 'Тон крони (всі LOD)', min: 0.2, max: 1.2, step: 0.01, fmt: f2 },
    ],
  },
  {
    title: 'Ялина — крона з моделі',
    toggle: ['pineModelCrown', 'Крона з pine_crown.gltf (зроблена в Blender)'],
    note: 'Вимкнено: лапи генеруються за повзунками «Ялина — лапи»',
    sliders: [],
  },
  {
    title: 'Ялина — крона',
    toggle: ['pineKeepCrown', 'Залишити крону моделі під лапами'],
    note: 'Вимкнено: тільки стовбур і ряди лап',
    sliders: [],
  },
  {
    title: 'Кущ — листя',
    toggle: ['bushLeaves', 'Листя на ближньому LOD'],
    note: REBUILD_NOTE,
    sliders: [
      { k: 'bushCount', label: 'Максимум листків', min: 20, max: 800, step: 10, fmt: f0 },
      { k: 'bushSpacing', label: 'Відстань між листками', min: 0.05, max: 0.6, step: 0.01, fmt: fm },
      { k: 'bushSize', label: 'Розмір листка', min: 0.1, max: 1, step: 0.01, fmt: fm },
      { k: 'bushOffset', label: 'Відступ від кулі', min: 0, max: 0.2, step: 0.005, fmt: fm },
      { k: 'bushInnerShade', label: 'Тінь усередині', min: 0.2, max: 1.2, step: 0.01, fmt: f2 },
    ],
  },
];

/** Live vegetation parameters for the whole map (saved in this browser, per device class). */
const VegetationPanel: React.FC<{ rerender(): void }> = ({ rerender }) => {
  const v = vegetationSettings;
  return (
    <>
      {VEG_GROUPS.map((g) => (
        <Section key={g.title} title={g.title}>
          {g.toggle && (
            <label className="flex items-center gap-2 text-zinc-400">
              <input type="checkbox" checked={v[g.toggle[0]]} onChange={(e) => (setVegetation(g.toggle![0], e.target.checked), rerender())} className="accent-sky-500" />
              {g.toggle[1]}
            </label>
          )}
          {g.note && <p className="text-[10px] text-zinc-500">{g.note}</p>}
          <div className={`flex flex-col gap-1.5 ${g.toggle && !v[g.toggle[0]] ? 'opacity-40 pointer-events-none' : ''}`}>
            {g.sliders.map((s) => (
              <Slider key={s.k} label={s.label} value={v[s.k]} min={s.min} max={s.max} step={s.step} fmt={s.fmt} onChange={(x) => (setVegetation(s.k, x), rerender())} />
            ))}
          </div>
        </Section>
      ))}
      <button className={chip(false)} onClick={() => (resetVegetationSettings(), rerender())}>
        Скинути до типових
      </button>
      <AlgaePanel rerender={rerender} />
    </>
  );
};

/** Links in a chain plant (algae, water lily) with the height they make at this scale. */
const ChainLengthSlider: React.FC<{
  kind: keyof typeof CHAIN_SPECIES;
  value: number;
  scale: number;
  head: number;
  onChange(v: number): void;
  onStart?(): void;
}> = ({ kind, value, scale, head, onChange, onStart }) => {
  const sp = CHAIN_SPECIES[kind];
  return (
    <Slider
      label="Довжина ланцюжка"
      value={sp.clampLinks(value)}
      min={sp.cfg.minLinks}
      max={sp.cfg.maxLinks}
      step={1}
      onStart={onStart}
      onChange={onChange}
      fmt={(v) => `${v} ланок · ${(sp.height(v, head) * scale).toFixed(2)} м`}
    />
  );
};

/** Water lily: what caps the stem (a leaf or a flower). */
const LilyHeadChips: React.FC<{ head: number; onChange(h: number): void }> = ({ head, onChange }) => (
  <div className="flex flex-wrap items-center gap-1">
    <span className="text-zinc-400 text-[11px] mr-1">Верхівка:</span>
    {LILY_HEADS.map((label, i) => (
      <button key={label} className={chip(head === i)} onClick={() => onChange(i)}>
        {label}
      </button>
    ))}
  </div>
);

/**
 * One stalk's colours: off = it follows the panel's algae colours, on = its own root and top
 * colours (starting from the panel's).
 */
const AlgaeColorFields: React.FC<{ colors: [number, number] | null; onChange(c: [number, number] | null): void; onStart?(): void }> = ({
  colors, onChange, onStart,
}) => (
  <div className="flex flex-col gap-1.5">
    <label className="flex items-center gap-2 text-zinc-300">
      <input
        type="checkbox"
        checked={!!colors}
        onChange={(e) => {
          onStart?.();
          onChange(e.target.checked ? [algaeSettings.baseColor, algaeSettings.tipColor] : null);
        }}
        className="accent-sky-500"
      />
      Свій колір водорості
    </label>
    {colors ? (
      <>
        <ColorRow label="Колір біля дна" value={new THREE.Color(colors[0])} onStart={onStart} onChange={(hex) => onChange([hex, colors[1]])} />
        <ColorRow label="Колір верхівки" value={new THREE.Color(colors[1])} onStart={onStart} onChange={(hex) => onChange([colors[0], hex])} />
      </>
    ) : (
      <p className="text-[10px] text-zinc-500">Бере загальні кольори з вкладки «Рослинність → Водорості».</p>
    )}
  </div>
);

/** One web's shape: size, threads, strength. */
const WebFields: React.FC<{ params: WebParams; onChange(patch: Partial<WebParams>): void; onStart?(): void }> = ({ params, onChange, onStart }) => {
  const L = WEB_LIMITS;
  return (
    <Section title="Павутина">
      <Slider label="Ширина" value={params.w} min={L.w[0]} max={L.w[1]} step={0.1} onStart={onStart} fmt={(v) => `${v.toFixed(1)} м`} onChange={(v) => onChange({ w: v })} />
      <Slider label="Висота" value={params.h} min={L.h[0]} max={L.h[1]} step={0.1} onStart={onStart} fmt={(v) => `${v.toFixed(1)} м`} onChange={(v) => onChange({ h: v })} />
      <Slider label="Радіальні нитки" value={params.radials} min={L.radials[0]} max={L.radials[1]} step={1} onStart={onStart} fmt={(v) => `${v}`} onChange={(v) => onChange({ radials: v })} />
      <Slider label="Витки спіралі" value={params.rings} min={L.rings[0]} max={L.rings[1]} step={1} onStart={onStart} fmt={(v) => `${v}`} onChange={(v) => onChange({ rings: v })} />
      <Slider label="Міцність" value={params.strength} min={L.strength[0]} max={L.strength[1]} step={0.05} onStart={onStart} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => onChange({ strength: v })} />
      <p className="text-[10px] text-zinc-500">Нитки чіпляються за найближчі стіни в площині павутини (де стін нема — за край прямокутника).</p>
    </Section>
  );
};

/** All webs' look and feel (live, kept in this browser). */
const WebLookPanel: React.FC = () => {
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);
  const ws = webSettings;
  return (
    <Section title="Усі павутини">
      <ColorRow label="Колір ниток" value={new THREE.Color(ws.color)} onChange={(hex) => (setWebSetting('color', hex), rerender())} />
      <Slider label="Непрозорість" value={ws.opacity} min={0.1} max={1} step={0.05} fmt={(v) => v.toFixed(2)} onChange={(v) => (setWebSetting('opacity', v), rerender())} />
      <Slider label="Товщина нитки" value={ws.thickness} min={1} max={20} step={0.5} fmt={(v) => `${v.toFixed(1)} мм`} onChange={(v) => (setWebSetting('thickness', v), rerender())} />
      <Slider label="Утримання гравця" value={ws.hold} min={0.05} max={3} step={0.05} fmt={(v) => v.toFixed(2)} onChange={(v) => (setWebSetting('hold', v), rerender())} />
      <Slider label="Розрив спіралі (розтяг)" value={ws.breakStretch} min={1.1} max={4} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => (setWebSetting('breakStretch', v), rerender())} />
      <Slider label="Провисання (гравітація)" value={ws.gravity} min={0} max={9.8} step={0.1} fmt={(v) => `${v.toFixed(1)} м/с²`} onChange={(v) => (setWebSetting('gravity', v), rerender())} />
      <Slider label="Дальність видимості" value={ws.viewDistance} min={10} max={150} step={5} fmt={(v) => `${v} м`} onChange={(v) => (setWebSetting('viewDistance', v), rerender())} />
      <p className="text-[10px] text-zinc-500">Далі за цю відстань нитки не малюються (стовпи рамки — удвічі далі). Майже повністю розірвана павутина зникає через 10 с.</p>
      <p className="text-[10px] text-zinc-500">Менше «утримання» — гравець застрягає раніше. Сокира розрізає нитки, шматки без кріплення падають.</p>
      <button className={chip(false)} onClick={() => (resetWebSettings(), rerender())}>
        Скинути павутини
      </button>
    </Section>
  );
};

/** Algae look: root-to-top colours and the daylight shimmer (live, kept in this browser). */
const AlgaePanel: React.FC<{ rerender(): void }> = ({ rerender }) => {
  const a = algaeSettings;
  return (
    <Section title="Водорості">
      <ColorRow label="Колір біля дна" value={new THREE.Color(a.baseColor)} onChange={(hex) => (setAlgae('baseColor', hex), rerender())} />
      <ColorRow label="Колір верхівки" value={new THREE.Color(a.tipColor)} onChange={(hex) => (setAlgae('tipColor', hex), rerender())} />
      <p className="text-[10px] text-zinc-500">Вдень по водоростях біжать відблиски сонця — світліший відтінок їхнього ж кольору (вночі й у печерах їх нема, під дощем слабшають).</p>
      <ColorRow label="Відтінок відблисків" value={new THREE.Color(a.shimmerColor)} onChange={(hex) => (setAlgae('shimmerColor', hex), rerender())} />
      <Slider label="Сила відблисків" value={a.shimmer} min={0} max={2} step={0.05} fmt={(v) => v.toFixed(2)} onChange={(v) => (setAlgae('shimmer', v), rerender())} />
      <Slider label="Швидкість" value={a.shimmerSpeed} min={0} max={3} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => (setAlgae('shimmerSpeed', v), rerender())} />
      <Slider label="Дрібність візерунка" value={a.shimmerScale} min={0.2} max={3} step={0.05} fmt={(v) => v.toFixed(2)} onChange={(v) => (setAlgae('shimmerScale', v), rerender())} />
      <button className={chip(false)} onClick={() => (resetAlgaeSettings(), rerender())}>
        Скинути водорості
      </button>
    </Section>
  );
};

const SavePanel: React.FC<{ engine: GameEngine; notify: EditorUIProps['notify'] }> = ({ engine, notify }) => {
  const w = engine.world!;
  const editor = w.editor;
  const [slots, setSlots] = useState(() => SaveSystem.listSlots());
  const [name, setName] = useState('level1');
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => setSlots(SaveSystem.listSlots());
  return (
    <>
      <EnvironmentPresets engine={engine} notify={notify} />
      <Section title="Новий слот">
        <div className="flex gap-1">
          <input value={name} onChange={(e) => setName(e.target.value.replace(/[^\w-]/g, ''))} className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded px-2 py-1 outline-none focus:border-sky-500" />
          <button
            className={chip(true)}
            onClick={() => {
              if (!name) return;
              if (slots.some((slot) => slot.slot === name) && !window.confirm(`Перезаписати збереження «${name}»?`)) return;
              const ok = w.saves.save(name);
              if (ok) editor.markSaved();
              notify(ok ? `Збережено «${name}»` : 'Не вдалося зберегти', ok ? 'success' : 'warn');
              refresh();
            }}
          >
            <Plus className="w-3.5 h-3.5" /> Зберегти
          </button>
        </div>
      </Section>
      <Section title="Слоти">
        {slots.length === 0 && <p className="text-zinc-500">Немає збережень.</p>}
        {slots.map((s) => (
          <div key={s.slot} className="flex items-center gap-1 bg-white/5 rounded-lg px-2 py-1">
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{s.slot}</div>
              <div className="text-[10px] text-zinc-500">
                {s.savedAt ? new Date(s.savedAt).toLocaleString() : '—'} · {s.sizeKb} КБ
              </div>
            </div>
            <button className={`${btn} w-7 h-7 hover:bg-white/10`} title="Замінити поточний світ цим збереженням" onClick={() => {
              if (!window.confirm(`Завантажити «${s.slot}» і замінити поточний світ?`)) return;
              const ok = w.saves.load(s.slot);
              if (ok) editor.markSaved();
              notify(ok ? `Завантажено «${s.slot}»` : 'Несумісне збереження', ok ? 'success' : 'warn');
            }}>
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
            <button className={`${btn} w-7 h-7 hover:bg-white/10`} title="Перезаписати" onClick={() => {
              if (!window.confirm(`Перезаписати збереження «${s.slot}» поточним світом?`)) return;
              const ok = w.saves.save(s.slot);
              if (ok) editor.markSaved();
              notify(ok ? `Збережено «${s.slot}»` : 'Не вдалося зберегти', ok ? 'success' : 'warn');
              refresh();
            }}>
              <Save className="w-3.5 h-3.5" />
            </button>
            <button className={`${btn} w-7 h-7 hover:bg-rose-500/20 text-rose-300`} title="Видалити" onClick={() => {
              if (window.confirm(`Видалити збереження «${s.slot}»?`)) { SaveSystem.delete(s.slot); refresh(); }
            }}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </Section>
      <Section title="Файл">
        <div className="flex gap-1">
          <button className={`${chip(false)} flex-1`} onClick={() => w.saves.exportFile(name || 'world')}>
            <Download className="w-3.5 h-3.5" /> Експорт
          </button>
          <button className={`${chip(false)} flex-1`} onClick={() => fileRef.current?.click()}>
            <Upload className="w-3.5 h-3.5" /> Імпорт
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                if (!window.confirm('Імпортувати файл і замінити поточний світ?')) { e.target.value = ''; return; }
                const ok = await w.saves.importFile(f);
                if (ok) editor.markSaved();
                notify(ok ? 'Світ імпортовано' : 'Файл не підходить', ok ? 'success' : 'warn');
              }
              e.target.value = '';
            }}
          />
        </div>
      </Section>
      <button
        className={`${btn} gap-1.5 py-1.5 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25`}
        onClick={() => {
          if (!window.confirm('Видалити автозбереження? Після перезавантаження буде створено новий світ.')) return;
          SaveSystem.delete('auto');
          notify('Автозбереження видалено — після перезавантаження буде новий світ', 'warn');
          refresh();
        }}
      >
        <Globe2 className="w-3.5 h-3.5" /> Почати новий світ
      </button>
    </>
  );
};

type EnvironmentPreset = {
  name: string;
  savedAt: number;
  timeOfDay: number;
  season: string;
  secondsPerHour: number;
  waterLevel: number;
  weather: WeatherType;
  weatherAuto: boolean;
  nightLightMode: NightLightMode;
  weatherProfiles: Record<string, Record<string, unknown>>;
  water: WaterSettings;
  vegetation: VegetationSettings;
};

const ENVIRONMENT_PRESETS_KEY = 'farm.editor.environment-presets.v1';

const EnvironmentPresets: React.FC<{ engine: GameEngine; notify: EditorUIProps['notify'] }> = ({ engine, notify }) => {
  const [name, setName] = useState('Мій пресет');
  const [presets, setPresets] = useState<EnvironmentPreset[]>(() => {
    try {
      const data: unknown = JSON.parse(localStorage.getItem(ENVIRONMENT_PRESETS_KEY) ?? '[]');
      return Array.isArray(data) ? data.filter((p) => p && typeof p.name === 'string' && p.water && p.vegetation && p.weatherProfiles).slice(0, 20) : [];
    } catch { return []; }
  });
  const persist = (next: EnvironmentPreset[]) => {
    setPresets(next);
    try { localStorage.setItem(ENVIRONMENT_PRESETS_KEY, JSON.stringify(next)); } catch { notify('Не вдалося зберегти пресет у браузері', 'warn'); }
  };
  const capture = () => {
    const profiles: EnvironmentPreset['weatherProfiles'] = {};
    for (const [key, profile] of Object.entries(WEATHER_PROFILES)) {
      profiles[key] = { ...profile, tint: profile.tint.getHex(), haze: profile.haze.getHex(), sound: { ...profile.sound } };
    }
    return {
      name: name.trim().slice(0, 40) || 'Пресет', savedAt: Date.now(), timeOfDay: worldSettings.timeOfDay,
      season: worldSettings.season, secondsPerHour: worldSettings.secondsPerHour, waterLevel: worldSettings.waterLevel,
      weather: engine.world!.weather.weather, weatherAuto: engine.world!.weather.director.auto, nightLightMode: nightLightSettings.mode,
      weatherProfiles: profiles, water: { ...waterSettings }, vegetation: { ...vegetationSettings },
    } satisfies EnvironmentPreset;
  };
  const apply = (preset: EnvironmentPreset) => {
    if (!window.confirm(`Застосувати пресет «${preset.name}»? Поточні параметри середовища буде замінено.`)) return;
    const w = engine.world!;
    worldSettings.timeOfDay = Number.isFinite(preset.timeOfDay) ? THREE.MathUtils.clamp(preset.timeOfDay, 0, 23.99) : worldSettings.timeOfDay;
    worldSettings.season = (['spring', 'summer', 'autumn', 'winter'].includes(preset.season) ? preset.season : worldSettings.season) as typeof worldSettings.season;
    worldSettings.secondsPerHour = Number.isFinite(preset.secondsPerHour) ? THREE.MathUtils.clamp(preset.secondsPerHour, 0, 180) : worldSettings.secondsPerHour;
    worldSettings.waterLevel = Number.isFinite(preset.waterLevel) ? THREE.MathUtils.clamp(preset.waterLevel, -6, 4) : worldSettings.waterLevel;
    if (preset.weather in WEATHER_LABELS) w.weather.setWeather(preset.weather);
    w.weather.director.auto = preset.weatherAuto !== false;
    for (const [key, saved] of Object.entries(preset.weatherProfiles)) {
      const profile = WEATHER_PROFILES[key as WeatherType];
      if (!profile || !saved || typeof saved !== 'object') continue;
      for (const field of ['light', 'fog', 'amount', 'cover', 'dark', 'hazeMix'] as const) {
        const value = saved[field];
        if (typeof value === 'number' && Number.isFinite(value)) profile[field] = value;
      }
      if (typeof saved.tint === 'number') profile.tint.setHex(saved.tint);
      if (typeof saved.haze === 'number') profile.haze.setHex(saved.haze);
      if (saved.precipitation === 'none' || saved.precipitation === 'rain' || saved.precipitation === 'snow') profile.precipitation = saved.precipitation;
      if (saved.sound && typeof saved.sound === 'object') {
        for (const soundKey of Object.keys(profile.sound) as (keyof WeatherSound)[]) {
          const value = (saved.sound as Partial<WeatherSound>)[soundKey];
          if (typeof value === 'number' && Number.isFinite(value)) profile.sound[soundKey] = value;
        }
      }
    }
    WeatherProfiles.save();
    for (const key of Object.keys(WATER_DEFAULTS) as (keyof WaterSettings)[]) {
      const value = preset.water[key];
      if (typeof value === typeof WATER_DEFAULTS[key]) waterSettings[key] = value as never;
    }
    saveWaterSettings();
    applyVegetationPreset(preset.vegetation);
    if (NIGHT_LIGHT_MODES.includes(preset.nightLightMode)) setNightLightMode(preset.nightLightMode);
    notify(`Застосовано пресет «${preset.name}»`, 'success');
  };
  return <Section title="Пресети середовища">
    <div className="flex gap-1">
      <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 outline-none focus:border-sky-500" aria-label="Назва пресета" />
      <button className={chip(true)} title="Зберегти час, сезон, погоду, світло, воду й рослинність" onClick={() => persist([capture(), ...presets].slice(0, 20))}><Save className="h-3.5 w-3.5" /></button>
    </div>
    <p className="text-[10px] text-zinc-500">До 20 наборів: час, сезон, профілі погоди, світло, вода й рослинність.</p>
    <button className={chip(false)} onClick={() => {
      if (!window.confirm('Відновити стандартні параметри часу, погоди, світла, води й рослинності?')) return;
      const w = engine.world!;
      worldSettings.timeOfDay = 9;
      worldSettings.season = 'spring';
      worldSettings.secondsPerHour = 60;
      worldSettings.waterLevel = -0.6;
      w.weather.setWeather('clear');
      w.weather.director.auto = true;
      WeatherProfiles.resetAll();
      resetWaterSettings();
      resetVegetationSettings();
      setNightLightMode('room');
      notify('Стандартні параметри середовища відновлено', 'success');
    }}>Відновити стандартні параметри</button>
    {presets.map((preset, i) => <div key={`${preset.name}-${preset.savedAt}`} className="flex items-center gap-1 rounded-lg bg-white/5 px-2 py-1">
      <button className="min-w-0 flex-1 truncate text-left font-semibold hover:text-sky-300" onClick={() => apply(preset)} title="Застосувати пресет">{preset.name}</button>
      <button className={`${btn} h-7 w-7 text-rose-300 hover:bg-rose-500/20`} aria-label={`Видалити пресет ${preset.name}`} onClick={() => persist(presets.filter((_, n) => n !== i))}><Trash2 className="h-3.5 w-3.5" /></button>
    </div>)}
    {presets.length === 0 && <p className="text-zinc-500">Збережених наборів поки немає.</p>}
  </Section>;
};

const DebugTab: React.FC<EditorUIProps> = ({ engine, stats, isWireframe, onToggleWireframe, showConsole, onToggleConsole, showCharacterInspector, onToggleCharacterInspector, notify }) => {
  const [, force] = useState(0);
  const [frameHistory, setFrameHistory] = useState<number[]>([]);
  const currentFrameMs = stats?.frameMs;
  useEffect(() => {
    if (currentFrameMs === undefined) return;
    setFrameHistory((values) => [...values, currentFrameMs].slice(-48));
  }, [currentFrameMs]);
  const w = engine.world!;
  const row = (label: string, value: string, warn = false) => (
    <div className="flex justify-between">
      <span className="text-zinc-400">{label}</span>
      <span className={`tabular-nums font-semibold ${warn ? 'text-amber-400' : 'text-zinc-100'}`}>{value}</span>
    </div>
  );
  return (
    <>
      <Section title="Продуктивність">
        {stats ? (
          <div className="flex flex-col gap-0.5">
            {row('FPS', stats.fps.toFixed(0), stats.fps < 50)}
            {row('Кадр (середнє)', `${stats.frameMs.toFixed(2)} мс`, stats.frameMs > 16.7)}
            {row('Кадр (p95)', `${stats.frameMsP95.toFixed(2)} мс`, stats.frameMsP95 > 20)}
            {row('Фізика', `${stats.physicsMs.toFixed(2)} мс`, stats.physicsMs > 4)}
            {row('Тіла / колайдери', `${stats.physicsBodies ?? '—'} / ${stats.physicsColliders ?? '—'}`)}
            {row('Draw calls', String(stats.drawCalls), stats.drawCalls > 250)}
            {row('Трикутники', stats.triangles.toLocaleString())}
            {row('Геометрії', String(stats.geometries), stats.geometries > 600)}
            {row('Текстури', String(stats.textures))}
            {row('Шейдери', String(stats.programs))}
            {row('JS heap', stats.heapMb !== null ? `${stats.heapMb.toFixed(0)} МБ` : 'браузер не надає')}
            {row('Об’єкти / деталі будов', `${stats.props} / ${stats.pieces}`)}
            {row('Чанки печер', String(stats.caveChunks))}
            {row('Печера', stats.caveBuilding ? 'генерується' : stats.caveCollidersReady ? 'готова' : 'колайдери готуються', stats.caveBuilding || !stats.caveCollidersReady)}
            {row('Шейдери при запуску', stats.shaderPrewarmMs > 0 ? `${stats.shaderPrewarmMs.toFixed(0)} мс · ${stats.shaderPrewarmPrograms}` : 'ще не готові', stats.shaderPrewarmMs === 0)}
          </div>
        ) : (
          <p className="text-zinc-500">Збір…</p>
        )}
        {frameHistory.length > 1 && <div className="rounded bg-black/20 p-1" aria-label="Графік часу кадру">
          <svg viewBox="0 0 192 48" className="h-12 w-full" role="img" aria-label="Час кадру, мілісекунди">
            <path d="M0 16H192 M0 32H192" stroke="rgba(255,255,255,.12)" strokeWidth="1" />
            <polyline fill="none" stroke="#38bdf8" strokeWidth="2" vectorEffect="non-scaling-stroke" points={frameHistory.map((v, i) => `${i * (192 / (frameHistory.length - 1))},${46 - Math.min(v, 50) / 50 * 44}`).join(' ')} />
          </svg>
          <div className="flex justify-between text-[9px] text-zinc-500"><span>0 мс</span><span>50 мс · останні 14 с</span></div>
        </div>}
      </Section>
      <Section title="Візуалізація">
        <button className={chip(isWireframe)} onClick={onToggleWireframe}>
          <Bug className="w-3.5 h-3.5" /> Колайдери фізики (H)
        </button>
        <button className={chip(showCharacterInspector)} onClick={onToggleCharacterInspector}>
          <User className="w-3.5 h-3.5" /> Інспектор персонажа
        </button>
        <button className={chip(showConsole)} onClick={onToggleConsole}>
          <Terminal className="w-3.5 h-3.5" /> Консоль подій
        </button>
      </Section>
      <Section title="Симуляція">
        <Slider
          label="Швидкість часу"
          value={worldSettings.timeScale}
          min={0}
          max={3}
          step={0.1}
          onChange={(v) => {
            worldSettings.timeScale = v;
            force((n) => n + 1);
          }}
          fmt={(v) => (v === 0 ? 'пауза' : `${v.toFixed(1)}×`)}
        />
        <p className="text-zinc-500">Консоль: window.dev — tp(x,z), give(id,n), time(h), weather(t), spawn(type,x,z), save(), load().</p>
      </Section>
      <Section title="Сценарії перевірки">
        <p className="text-zinc-500">Переміщення використовує ігровий fade; натисни E біля входу, щоб перевірити звичайну взаємодію.</p>
        <div className="grid grid-cols-2 gap-1">
          {w.exploration.sites.map((site) => <button key={site.id} className={chip(false)} onClick={() => {
            if (engine.devTeleportToSite(site.id)) notify(`Переміщено до ${site.id}${site.underwater ? ' · підводна зона' : ''}`, 'info');
            else notify('Не вдалося перемістити гравця', 'warn');
          }}>{site.kind === 'cave' ? `Вхід ${site.id}` : site.kind === 'lighthouse' ? 'Маяк' : site.kind === 'ruins' ? 'Руїни' : 'Хатина'}</button>)}
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button className={chip(false)} onClick={() => {
            if (w.exploration.debugCaveTransition('enter', 'cave1', w.character, engine.camera)) notify('Перевірка входу в печеру запущена', 'info');
            else notify('Вхід недоступний: перевір, чи гравець уже в печері', 'warn');
          }}>Перевірити вхід</button>
          <button className={chip(false)} disabled={!w.exploration.inCave} onClick={() => {
            const id = w.exploration.inCave;
            if (id && w.exploration.debugCaveTransition('exit', id, w.character, engine.camera)) notify('Перевірка виходу з печери запущена', 'info');
          }}>Перевірити вихід</button>
        </div>
      </Section>
      <Section title="Останні зміни">
        <div className="flex items-center justify-between text-[10px]">
          <span className={w.editor.hasUnsavedEdits ? 'text-amber-300' : 'text-emerald-300'}>{w.editor.hasUnsavedEdits ? 'Є незбережені зміни' : 'Світ збережено'}</span>
          <span className="text-zinc-500">{w.editor.recentActions.length}/20</span>
        </div>
        {w.editor.recentActions.slice(0, 8).map((action, i) => <div key={`${action.at}-${i}`} className="flex justify-between gap-2 text-[10px]">
          <span className="truncate text-zinc-300">{action.label}</span><span className="shrink-0 text-zinc-600">{new Date(action.at).toLocaleTimeString()}</span>
        </div>)}
        {w.editor.recentActions.length === 0 && <p className="text-zinc-500">Історія дій з’явиться після першої зміни світу.</p>}
      </Section>
      <Section title="Гравець">
        <button
          className={chip(false)}
          onClick={() => {
            const cam = engine.camera.camera.position;
            const t = engine.world!.terrain;
            engine.world!.character.respawn(new THREE.Vector3(cam.x, t.getHeight(cam.x, cam.z) + 1.5, cam.z));
          }}
        >
          <Crosshair className="w-3.5 h-3.5" /> Перенести гравця під камеру
        </button>
        <button
          className={chip(lockOnSettings.enabled)}
          onClick={() => {
            lockOnSettings.set(!lockOnSettings.enabled);
            force((n) => n + 1);
          }}
        >
          <Crosshair className="w-3.5 h-3.5" /> Прив’язка камери до ворога: {lockOnSettings.enabled ? 'увімк.' : 'вимк.'}
        </button>
        <button
          className={chip(lockOnSettings.enabled && lockOnSettings.auto)}
          disabled={!lockOnSettings.enabled}
          onClick={() => {
            lockOnSettings.setAuto(!lockOnSettings.auto);
            force((n) => n + 1);
          }}
        >
          <Crosshair className="w-3.5 h-3.5" /> Автоприв’язка: {lockOnSettings.auto ? 'увімк.' : 'вимк.'}
        </button>
        <p className="text-zinc-500">
          Автоприв’язка: ворог ближче 8 м захоплюється сам; камера відпускає його, коли він переможений або ви відбігли далі 13 м.
        </p>
        <p className="text-zinc-500">
          Tab або середня кнопка миші — захопити ворога перед камерою чи відпустити. Різкий рух мишею вбік — наступний ворог з того боку.
        </p>
      </Section>
    </>
  );
};
