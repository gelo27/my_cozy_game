import React, { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  TreePine, TreeDeciduous, Sprout, Gem, Mountain, Flower2, Cherry, Circle, Fence, Lamp, Armchair, Box, Wheat, Droplets,
  Flame, Mailbox, MousePointer2, PaintBucket, Brush, Undo2, Redo2, Play, Save, FolderOpen, Download, Upload, Trash2,
  Copy, Crosshair, Activity, Layers, Sun, ArrowUpFromLine, ArrowDownToLine, Waves, Minus, Move3d, Rotate3d, Plus, Car,
  PawPrint, User, Globe2, Terminal, Bug, Spline,
} from 'lucide-react';
import { RiverPanel } from './RiverPanel';
import { btn, chip, Section, Slider, NumberField } from './EditorWidgets';
import { GameEngine, DevStats } from '../../engine/GameEngine';
import { EditorTool } from '../../editor/EditorController';
import { PROP_DEFS, PropCategory } from '../../world/PropSystem';
import { TerrainTileType, TILE_DEFINITIONS } from '../../terrain/types/TerrainTypes';
import { WeatherType, WEATHER_LABELS, WEATHER_PROFILES, WeatherProfiles, WeatherSound } from '../../world/WeatherSystem';
import { worldSettings } from '../../world/WorldSettings';
import { BIRD_SPECIES, birdSpeciesEnabled, setBirdSpeciesEnabled } from '../../audio/AmbientAudio';
import { SaveSystem } from '../../world/SaveSystem';

const ICONS: Record<string, React.ElementType> = {
  TreePine, TreeDeciduous, Sprout, Gem, Mountain, Flower2, Cherry, Circle, Fence, Lamp, Armchair, Box, Wheat, Droplets,
  Flame, Mailbox,
};

const CATEGORY_LABELS: Record<PropCategory, string> = { nature: 'Природа', decor: 'Декор', farm: 'Ферма', stations: 'Станції' };

type Tab = 'world' | 'scene' | 'atmo' | 'save' | 'debug';

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
  ];
  const tabs: { id: Tab; icon: React.ElementType; label: string }[] = [
    { id: 'scene', icon: Layers, label: 'Сцена та інспектор' },
    { id: 'atmo', icon: Sun, label: 'Час, погода, вода' },
    { id: 'save', icon: Save, label: 'Збереження' },
    { id: 'debug', icon: Activity, label: 'Дебаг' },
  ];

  return (
    <div className="absolute inset-0 pointer-events-none z-40 font-sans text-zinc-200 select-none">
      {/* Top bar */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-zinc-900/90 border border-white/10 rounded-xl px-1.5 py-1 shadow-xl pointer-events-auto">
        <span className="px-2 text-[11px] font-bold text-sky-400 tracking-wide">РЕДАКТОР</span>
        <button className={`${btn} w-8 h-8 hover:bg-white/10 disabled:opacity-30`} disabled={!s.canUndo} onClick={() => editor.undo()} title="Скасувати (Ctrl+Z)">
          <Undo2 className="w-4 h-4" />
        </button>
        <button className={`${btn} w-8 h-8 hover:bg-white/10 disabled:opacity-30`} disabled={!s.canRedo} onClick={() => editor.redo()} title="Повторити (Ctrl+Y)">
          <Redo2 className="w-4 h-4" />
        </button>
        <button
          className={`${btn} w-8 h-8 hover:bg-white/10`}
          onClick={() => {
            world.saves.save('editor');
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
      <div className="absolute top-2 left-2 bottom-2 w-11 flex flex-col gap-1 bg-zinc-900/90 border border-white/10 rounded-xl p-1 shadow-xl pointer-events-auto">
        {tools.map((t) => (
          <button
            key={t.id}
            title={t.label}
            onClick={() => setTool(t.id)}
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
            onClick={() => setTab(t.id)}
            className={`${btn} w-9 h-9 ${tab === t.id ? 'bg-sky-500 text-white' : 'hover:bg-white/10'}`}
          >
            <t.icon className="w-4 h-4" />
          </button>
        ))}
      </div>

      {/* Context panel */}
      <div className="absolute top-2 left-[3.4rem] w-64 max-h-[calc(100%-1rem)] overflow-y-auto bg-zinc-900/90 border border-white/10 rounded-xl p-3 shadow-xl pointer-events-auto flex flex-col gap-3 text-xs">
        {tab === 'world' && <ToolPanel engine={engine} />}
        {tab === 'scene' && <ScenePanel engine={engine} rerender={rerender} />}
        {tab === 'atmo' && <AtmospherePanel engine={engine} rerender={rerender} />}
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

const ToolPanel: React.FC<{ engine: GameEngine }> = ({ engine }) => {
  const editor = engine.world!.editor;
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
            {PROP_DEFS.filter((d) => d.category === category).map((d) => {
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
        <label className="flex items-center gap-2 text-zinc-300">
          <input type="checkbox" checked={s.placeRandomize} onChange={(e) => editor.set('placeRandomize', e.target.checked)} className="accent-sky-500" />
          Випадковий поворот і розмір
        </label>
        <p className="text-zinc-500">Клік — поставити, протягнути — розсипати.</p>
      </>
    );
  }

  if (s.tool === 'river') return <RiverPanel engine={engine} />;

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

const SelectedInspector: React.FC<{ engine: GameEngine }> = ({ engine }) => {
  const { editor, props } = engine.world!;
  const id = editor.state.selectedPropId;
  const prop = id !== null ? props.get(id) : undefined;
  if (!prop) return <p className="text-zinc-500">Нічого не вибрано.</p>;
  const def = PROP_DEFS.find((d) => d.id === prop.type);
  const update = (patch: { x?: number; y?: number; z?: number; rot?: number; scale?: number }) => {
    const p = prop.position.clone();
    if (patch.x !== undefined) p.x = patch.x;
    if (patch.y !== undefined) p.y = patch.y;
    if (patch.z !== undefined) p.z = patch.z;
    if (patch.y !== undefined) prop.grounded = false;
    editor.setSelectedTransform(p, patch.rot !== undefined ? THREE.MathUtils.degToRad(patch.rot) : prop.rotationY, patch.scale ?? prop.scale);
  };
  return (
    <Section title={`Інспектор · ${def?.name ?? prop.type} #${prop.id}`}>
      <div className="grid grid-cols-3 gap-1">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <NumberField key={axis} label={axis.toUpperCase()} value={prop.position[axis]} onCommit={(v) => update({ [axis]: v })} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1">
        <NumberField label="Поворот°" value={THREE.MathUtils.radToDeg(prop.rotationY)} onCommit={(v) => update({ rot: v })} />
        <NumberField label="Масштаб" value={prop.scale} onCommit={(v) => update({ scale: Math.max(0.05, v) })} />
      </div>
      <label className="flex items-center gap-2 text-zinc-300">
        <input
          type="checkbox"
          checked={prop.grounded}
          onChange={(e) => {
            prop.grounded = e.target.checked;
            if (prop.grounded) update({ y: engine.world!.terrain.getHeight(prop.position.x, prop.position.z) });
            prop.grounded = e.target.checked;
          }}
          className="accent-sky-500"
        />
        Прилипати до землі
      </label>
      <div className="flex gap-1">
        <button className={`${chip(false)} flex-1`} onClick={() => editor.duplicateSelected()}>
          <Copy className="w-3.5 h-3.5" /> Копія
        </button>
        <button className={`${btn} flex-1 gap-1.5 py-1.5 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25`} onClick={() => editor.deleteSelected()}>
          <Trash2 className="w-3.5 h-3.5" /> Видалити
        </button>
      </div>
    </Section>
  );
};

const ScenePanel: React.FC<{ engine: GameEngine; rerender(): void }> = ({ engine }) => {
  const w = engine.world!;
  const [filter, setFilter] = useState('');
  const list = useMemo(() => w.props.list(), [w.props.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = useMemo(() => new Map(PROP_DEFS.map((d) => [d.id, d.name])), []);
  const filtered = list.filter((p) => !filter || (names.get(p.type) ?? p.type).toLowerCase().includes(filter.toLowerCase()));
  const focus = (pos: THREE.Vector3) => w.editor.focusOn(pos);
  const entity = (icon: React.ElementType, label: string, pos: THREE.Vector3) => {
    const Icon = icon;
    return (
      <button key={label} className={`${btn} justify-start gap-2 px-2 py-1 hover:bg-white/10`} onClick={() => focus(pos)}>
        <Icon className="w-3.5 h-3.5 text-sky-400" /> {label}
        <Crosshair className="w-3 h-3 ml-auto text-zinc-500" />
      </button>
    );
  };
  return (
    <>
      <Section title="Сутності">
        {entity(User, 'Гравець', w.character.getPosition())}
        {entity(Car, 'Пікап', w.vehicle.getPosition())}
        {w.gameplay.pets.pets.map((p) => entity(PawPrint, p.name, p.group.position))}
      </Section>
      <Section title={`Об’єкти (${list.length})`}>
        <input
          placeholder="Пошук…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="bg-black/30 border border-white/10 rounded px-2 py-1 outline-none focus:border-sky-500"
        />
        <div className="flex flex-col max-h-64 overflow-y-auto">
          {filtered.slice(0, 200).map((p) => (
            <button
              key={p.id}
              onClick={() => {
                w.editor.set('tool', 'select');
                w.editor.select(p.id);
                focus(p.position);
              }}
              className={`${btn} justify-start gap-2 px-2 py-1 ${w.editor.state.selectedPropId === p.id ? 'bg-sky-500/30' : 'hover:bg-white/10'}`}
            >
              <span className="text-zinc-500 tabular-nums w-8 text-left">#{p.id}</span>
              {names.get(p.type) ?? p.type}
            </button>
          ))}
        </div>
      </Section>
      <SelectedInspector engine={engine} />
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
];

const PRECIP_LABELS: Record<'none' | 'rain' | 'snow', string> = { none: 'Нема', rain: 'Дощ', snow: 'Сніг' };

const ColorRow: React.FC<{ label: string; value: THREE.Color; onChange(hex: number): void }> = ({ label, value, onChange }) => (
  <label className="flex items-center justify-between text-zinc-400">
    <span>{label}</span>
    <span className="flex items-center gap-2">
      <span className="text-zinc-200 tabular-nums">#{value.getHexString()}</span>
      <input
        type="color"
        value={`#${value.getHexString()}`}
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
      <Section title="Погода">
        <div className="grid grid-cols-3 gap-1">
          {(Object.keys(WEATHER_LABELS) as WeatherType[]).map((t) => (
            <button key={t} className={chip(w.weather.weather === t)} onClick={() => set(() => w.weather.setWeather(t))}>
              {WEATHER_LABELS[t]}
            </button>
          ))}
        </div>
      </Section>
      <WeatherTuner type={w.weather.weather} rerender={rerender} />
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
      </Section>
    </>
  );
};

const SavePanel: React.FC<{ engine: GameEngine; notify: EditorUIProps['notify'] }> = ({ engine, notify }) => {
  const w = engine.world!;
  const [slots, setSlots] = useState(() => SaveSystem.listSlots());
  const [name, setName] = useState('level1');
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => setSlots(SaveSystem.listSlots());
  return (
    <>
      <Section title="Новий слот">
        <div className="flex gap-1">
          <input value={name} onChange={(e) => setName(e.target.value.replace(/[^\w-]/g, ''))} className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded px-2 py-1 outline-none focus:border-sky-500" />
          <button
            className={chip(true)}
            onClick={() => {
              if (!name) return;
              notify(w.saves.save(name) ? `Збережено «${name}»` : 'Не вдалося зберегти', 'success');
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
            <button className={`${btn} w-7 h-7 hover:bg-white/10`} title="Завантажити" onClick={() => notify(w.saves.load(s.slot) ? `Завантажено «${s.slot}»` : 'Несумісне збереження', 'info')}>
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
            <button className={`${btn} w-7 h-7 hover:bg-white/10`} title="Перезаписати" onClick={() => (w.saves.save(s.slot), refresh())}>
              <Save className="w-3.5 h-3.5" />
            </button>
            <button className={`${btn} w-7 h-7 hover:bg-rose-500/20 text-rose-300`} title="Видалити" onClick={() => (SaveSystem.delete(s.slot), refresh())}>
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
              if (f) notify((await w.saves.importFile(f)) ? 'Світ імпортовано' : 'Файл не підходить', 'info');
              e.target.value = '';
            }}
          />
        </div>
      </Section>
      <button
        className={`${btn} gap-1.5 py-1.5 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25`}
        onClick={() => {
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

const DebugTab: React.FC<EditorUIProps> = ({ engine, stats, isWireframe, onToggleWireframe, showConsole, onToggleConsole, showCharacterInspector, onToggleCharacterInspector }) => {
  const [, force] = useState(0);
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
            {row('Кадр (CPU)', `${stats.frameMs.toFixed(2)} мс`, stats.frameMs > 10)}
            {row('Фізика', `${stats.physicsMs.toFixed(2)} мс`, stats.physicsMs > 4)}
            {row('Draw calls', String(stats.drawCalls), stats.drawCalls > 250)}
            {row('Трикутники', stats.triangles.toLocaleString())}
            {row('Геометрії', String(stats.geometries), stats.geometries > 600)}
            {row('Текстури', String(stats.textures))}
            {row('Шейдери', String(stats.programs))}
            {stats.heapMb !== null && row('JS heap', `${stats.heapMb.toFixed(0)} МБ`)}
            {row('Об’єкти / деталі будов', `${stats.props} / ${stats.pieces}`)}
          </div>
        ) : (
          <p className="text-zinc-500">Збір…</p>
        )}
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
      </Section>
    </>
  );
};
