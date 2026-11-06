import React, { useState } from 'react';
import * as THREE from 'three';
import { Plus, Trash2, Crosshair, Save, Link2, MousePointer2, Eye, RefreshCw, Copy } from 'lucide-react';
import type { GameEngine } from '../../engine/GameEngine';
import { CAVE_ITEM_TYPES, CaveAddMode, CaveEditTool } from '../../editor/CaveEditTool';
import { CRYSTAL_COLORS, HubKind, ItemType, LayoutItem, OreKind, TunnelKind, hubWater } from '../../explore/cave/CaveGen';
import { btn, chip, Section, Slider, NumberField } from './EditorWidgets';

const danger = `${btn} gap-1.5 py-1.5 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25`;

const ITEM_LABELS: Record<ItemType, string> = {
  chest: 'Скриня', ore: 'Руда', crystal: 'Кристал', mushroom: 'Гриби', ember: 'Жар', light: 'Світло',
  stalactite: 'Сталактит', stalagmite: 'Сталагміт', pillar: 'Колона', drip: 'Крапля',
};
const HUB_LABELS: Record<HubKind, string> = { chamber: 'Камера', grand: 'Великий зал', lake: 'Озеро' };
const TUNNEL_LABELS: Record<TunnelKind, string> = { ramp: 'Схил', stairs: 'Сходи', drop: 'Уступ', sump: 'Сифон', flood: 'Затоплений' };
const BIOME_LABELS = ['Мохові гроти', 'Затоплені кристальні', 'Жаркі глибини'];
const ORES: OreKind[] = ['iron', 'copper', 'gold', 'crystal'];
const ORE_LABELS: Record<OreKind, string> = { iron: 'Залізо', copper: 'Мідь', gold: 'Золото', crystal: 'Кристал' };

/** Editor panel for the cave tool: view, adding, the selected chamber / tunnel / item, saving. */
export const CavePanel: React.FC<{ engine: GameEngine }> = ({ engine }) => {
  const editor = engine.world!.editor;
  const tool = editor.caves;
  const [status, setStatus] = useState('');
  const [seed, setSeed] = useState(1337);
  const w = tool.work;
  const stats = tool.stats;
  const hub = tool.hub, tunnel = tool.tunnel, item = tool.item;
  const sel = tool.selection;

  if (!w) return <p className="text-zinc-500">Печери ще генеруються…</p>;

  const setMode = (m: CaveAddMode) => {
    tool.addMode = tool.addMode === m ? 'none' : m;
    editor.revision++;
    setStatus('');
  };
  /** A slider drag: one undo step at the start, live values, a rebuild once it settles. */
  const live = (fn: () => void) => tool.edit(() => fn(), false);
  const begin = () => editor.pushUndo();
  const focus = () => {
    const p = tool.selectedWorldPos();
    if (p) editor.focusOn(p);
  };

  return (
    <>
      <Section
        title="Печери"
        right={
          <span className="normal-case">
            {tool.busy ? <span className="text-sky-400">перебудова…</span> : tool.unsaved ? <span className="text-amber-400">не збережено</span> : null}
          </span>
        }
      >
        <p className="text-zinc-500 tabular-nums">
          {w.hubs.length} камер · {w.tunnels.length} тунелів · {w.items.length} об’єктів
          {stats ? ` · ${tool.chunkCount} чанків · ${stats.pools} водойм` : ''}
        </p>
        <div className="grid grid-cols-2 gap-1">
          <button className={chip(false)} onClick={() => editor.flyTo(tool.overviewPosition(), -0.75, 0)} title="Камера над усією мережею печер">
            <Eye className="w-3.5 h-3.5" /> До печер
          </button>
          <button className={chip(tool.alwaysShow)} onClick={() => { tool.alwaysShow = !tool.alwaysShow; editor.revision++; }} title="Показувати всі чанки печер і з іншими інструментами">
            <Eye className="w-3.5 h-3.5" /> Завжди
          </button>
        </div>
      </Section>

      <Section title="Клік у виді печер">
        <div className="grid grid-cols-3 gap-1">
          <button className={chip(tool.addMode === 'none')} onClick={() => setMode('none')} title="Вибрати маркер (Esc)">
            <MousePointer2 className="w-3.5 h-3.5" /> Вибір
          </button>
          <button className={chip(tool.addMode === 'hub')} onClick={() => setMode('hub')} title="Нова камера де клікнете, з тунелем до вибраної / найближчої">
            <Plus className="w-3.5 h-3.5" /> Камера
          </button>
          <button className={chip(tool.addMode === 'connect')} onClick={() => setMode('connect')} title="Виберіть камеру, потім клікніть другу — між ними буде тунель">
            <Link2 className="w-3.5 h-3.5" /> Тунель
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {CAVE_ITEM_TYPES.map((t) => (
            <button key={t} className={`${chip(tool.addMode === t)} px-1`} onClick={() => setMode(t)}>
              {ITEM_LABELS[t]}
            </button>
          ))}
        </div>
        <p className="text-zinc-500">
          Маркери: камери на рівні підлоги, тунелі посередині, об’єкти кольоровими ромбами, біоми — сфери над мережею. Gizmo рухає камеру разом з її вмістом. F — показати вибране, Del — видалити.
        </p>
      </Section>

      {hub && (
        <Section title={`${HUB_LABELS[hub.kind]} ${hub.id}${hub.entrance ? ` · вхід ${hub.entrance}` : ''}`}>
          <div className="grid grid-cols-3 gap-1">
            {(['chamber', 'grand', 'lake'] as HubKind[]).map((k) => (
              <button key={k} className={`${chip(hub.kind === k)} px-1`} onClick={() => tool.edit(() => (hub.kind = k))}>
                {HUB_LABELS[k]}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-1">
            <NumberField label="X" value={hub.x} onCommit={(v) => tool.edit(() => (hub.x = v))} />
            <NumberField label="Підлога" value={hub.floor} onCommit={(v) => tool.edit(() => (hub.floor = v))} />
            <NumberField label="Z" value={hub.z} onCommit={(v) => tool.edit(() => (hub.z = v))} />
          </div>
          <Slider label="Ширина" value={hub.rx} min={3} max={30} step={0.5} onStart={begin} onChange={(v) => live(() => (hub.rx = v))} fmt={(v) => `${v} м`} />
          <Slider label="Глибина" value={hub.rz} min={3} max={30} step={0.5} onStart={begin} onChange={(v) => live(() => (hub.rz = v))} fmt={(v) => `${v} м`} />
          <Slider label="Висота" value={hub.ry} min={3} max={18} step={0.5} onStart={begin} onChange={(v) => live(() => (hub.ry = v))} fmt={(v) => `${v} м`} />
          <Slider label="Поворот" value={hub.rot} min={0} max={3.14} step={0.05} onStart={begin} onChange={(v) => live(() => (hub.rot = v))} fmt={(v) => `${Math.round((v * 180) / Math.PI)}°`} />
          <label className="flex items-center gap-2 text-zinc-300">
            <input
              type="checkbox"
              className="accent-sky-500"
              checked={!Number.isNaN(hubWater(hub))}
              onChange={(e) => tool.edit(() => (hub.water = e.target.checked ? Math.round((hub.floor - 0.35) * 100) / 100 : null))}
            />
            Вода в камері
          </label>
          {!Number.isNaN(hubWater(hub)) && (
            <Slider
              label="Рівень води"
              value={hubWater(hub)}
              min={hub.floor - 6}
              max={hub.floor + 6}
              step={0.1}
              onStart={begin}
              onChange={(v) => live(() => (hub.water = v))}
              fmt={(v) => `${(v - hub.floor).toFixed(1)} м від підлоги`}
            />
          )}
          {hub.kind === 'grand' && (
            <label className="flex flex-col gap-1">
              <span className="text-zinc-400">Галерея (уступ) біля тунелю</span>
              <select
                className="bg-black/30 border border-white/10 rounded px-1.5 py-1"
                value={hub.shelf ?? ''}
                onChange={(e) => tool.edit(() => (hub.shelf = e.target.value || null))}
              >
                <option value="">немає</option>
                {w.tunnels.filter((t) => t.a === hub.id || t.b === hub.id).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} → {t.a === hub.id ? t.b : t.a}
                  </option>
                ))}
              </select>
            </label>
          )}
        </Section>
      )}

      {tunnel && (
        <Section title={`Тунель ${tunnel.id}: ${tunnel.a} ↔ ${tunnel.b}`}>
          <div className="grid grid-cols-3 gap-1">
            {(['ramp', 'stairs', 'drop', 'sump', 'flood'] as TunnelKind[]).map((k) => (
              <button key={k} className={`${chip(tunnel.kind === k)} px-1`} onClick={() => tool.edit(() => (tunnel.kind = k))}>
                {TUNNEL_LABELS[k]}
              </button>
            ))}
          </div>
          <Slider label="Радіус" value={tunnel.radius} min={2} max={5} step={0.1} onStart={begin} onChange={(v) => live(() => (tunnel.radius = v))} fmt={(v) => `${v.toFixed(1)} м`} />
          <Slider label="Звивистість" value={tunnel.wig} min={-12} max={12} step={0.5} onStart={begin} onChange={(v) => live(() => (tunnel.wig = v))} fmt={(v) => `${v} м`} />
          <Slider label="Хвилі" value={tunnel.k} min={1} max={3} step={1} onStart={begin} onChange={(v) => live(() => (tunnel.k = v))} />
          <p className="text-zinc-500">Уступ і сифон — односторонні: ставте їх лише на тунелі, які мають обхід.</p>
        </Section>
      )}

      {item && <ItemSection item={item} tool={tool} begin={begin} live={live} />}

      {sel?.kind === 'biome' && (
        <Section title={`Біом: ${BIOME_LABELS[sel.index]}`}>
          <p className="text-zinc-500">Перетягніть центр біому — перефарбується вся мережа (повна перебудова).</p>
        </Section>
      )}

      {sel && (
        <div className="grid grid-cols-3 gap-1">
          <button className={chip(false)} onClick={focus} title="Показати (F)">
            <Crosshair className="w-3.5 h-3.5" />
          </button>
          {item && (
            <button className={chip(false)} onClick={() => tool.duplicateSelected()} title="Дублювати (Ctrl+D)">
              <Copy className="w-3.5 h-3.5" />
            </button>
          )}
          {sel.kind !== 'biome' && (
            <button className={danger} onClick={() => tool.deleteSelected()} title="Видалити (Del)">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      <Section title="Файл">
        <button
          className={`${btn} gap-1.5 py-1.5 bg-sky-600 hover:bg-sky-500 text-white font-semibold`}
          title="Записати src/explore/cave/caves.json"
          onClick={async () => {
            const r = await tool.saveToProject();
            setStatus(r === 'saved' ? 'Записано у caves.json' : r === 'downloaded' ? 'Сервер недоступний — файл завантажено' : 'Немає що зберігати');
          }}
        >
          <Save className="w-3.5 h-3.5" /> Зберегти в проєкт
        </button>
        <div className="flex gap-1 items-end">
          <div className="flex-1">
            <NumberField label="Seed" value={seed} onCommit={(v) => setSeed(Math.round(v))} />
          </div>
          <button className={`${danger} px-2`} onClick={() => tool.regenerate(seed)} title="Згенерувати нову мережу (замінить усі правки; Ctrl+Z повертає)">
            <RefreshCw className="w-3.5 h-3.5" /> Нова
          </button>
        </div>
        {(status || tool.status) && <p className="text-zinc-400">{tool.status || status}</p>}
      </Section>
    </>
  );
};

const ItemSection: React.FC<{
  item: LayoutItem;
  tool: CaveEditTool;
  begin(): void;
  live(fn: () => void): void;
}> = ({ item, tool, begin, live }) => (
  <Section title={`${ITEM_LABELS[item.t]} #${item.id}${item.hub ? ` · ${item.hub}` : ''}`}>
    <div className="grid grid-cols-3 gap-1">
      <NumberField label="X" value={item.x} onCommit={(v) => tool.edit(() => (item.x = v))} />
      <NumberField label="Y" value={item.y} onCommit={(v) => tool.edit(() => (item.y = v))} />
      <NumberField label="Z" value={item.z} onCommit={(v) => tool.edit(() => (item.z = v))} />
    </div>
    {item.t === 'chest' && (
      <>
        <div className="grid grid-cols-3 gap-1">
          {['cave1', 'cave2', 'cave3'].map((c) => (
            <button key={c} className={chip(item.chest === c)} onClick={() => tool.edit(() => (item.chest = c))}>
              {c}
            </button>
          ))}
        </div>
        <Slider label="Поворот" value={item.yaw ?? 0} min={-3.14} max={3.14} step={0.05} onStart={begin} onChange={(v) => live(() => (item.yaw = v))} fmt={(v) => `${Math.round((v * 180) / Math.PI)}°`} />
      </>
    )}
    {item.t === 'ore' && (
      <div className="grid grid-cols-2 gap-1">
        {ORES.map((o) => (
          <button key={o} className={chip(item.ore === o)} onClick={() => tool.edit(() => (item.ore = o))}>
            {ORE_LABELS[o]}
          </button>
        ))}
      </div>
    )}
    {item.t === 'crystal' && (
      <>
        <div className="grid grid-cols-4 gap-1">
          {CRYSTAL_COLORS.map((c, i) => (
            <button
              key={i}
              className={`${btn} h-6 border ${item.color === i ? 'border-white' : 'border-transparent'}`}
              style={{ background: new THREE.Color(c[0], c[1], c[2]).getStyle() }}
              onClick={() => tool.edit(() => (item.color = i))}
            />
          ))}
        </div>
        <Slider label="Розмір" value={item.size ?? 1} min={0.4} max={2.5} step={0.05} onStart={begin} onChange={(v) => live(() => (item.size = v))} fmt={(v) => v.toFixed(2)} />
      </>
    )}
    {item.t === 'mushroom' && (
      <label className="flex items-center gap-2 text-zinc-300">
        <input type="checkbox" className="accent-sky-500" checked={!!item.glow} onChange={(e) => tool.edit(() => (item.glow = e.target.checked || undefined))} />
        Світиться
      </label>
    )}
    {item.t === 'light' && (
      <>
        <Slider label="Дальність" value={item.range ?? 8} min={2} max={30} step={0.5} onStart={begin} onChange={(v) => live(() => (item.range = v))} fmt={(v) => `${v} м`} />
        <Slider label="Яскравість" value={item.intensity ?? 1} min={0.1} max={3} step={0.05} onStart={begin} onChange={(v) => live(() => (item.intensity = v))} fmt={(v) => v.toFixed(2)} />
        {(['R', 'G', 'B'] as const).map((ch, i) => (
          <Slider
            key={ch}
            label={ch}
            value={(item.rgb ?? [1, 0.85, 0.6])[i]}
            min={0}
            max={2}
            step={0.05}
            onStart={begin}
            onChange={(v) =>
              live(() => {
                const rgb = [...(item.rgb ?? [1, 0.85, 0.6])] as [number, number, number];
                rgb[i] = v;
                item.rgb = rgb;
              })
            }
            fmt={(v) => v.toFixed(2)}
          />
        ))}
        <label className="flex items-center gap-2 text-zinc-300">
          <input type="checkbox" className="accent-sky-500" checked={!!item.flicker} onChange={(e) => tool.edit(() => (item.flicker = e.target.checked || undefined))} />
          Мерехтить
        </label>
      </>
    )}
    {(item.t === 'stalactite' || item.t === 'stalagmite') && (
      <>
        <Slider label="Довжина" value={item.len ?? 1} min={0.3} max={6} step={0.05} onStart={begin} onChange={(v) => live(() => (item.len = v))} fmt={(v) => `${v.toFixed(2)} м`} />
        <Slider label="Товщина" value={item.r ?? 0.3} min={0.08} max={1.5} step={0.02} onStart={begin} onChange={(v) => live(() => (item.r = v))} fmt={(v) => `${v.toFixed(2)} м`} />
        {item.t === 'stalactite' && (
          <label className="flex items-center gap-2 text-zinc-300">
            <input type="checkbox" className="accent-sky-500" checked={!!item.drip} onChange={(e) => tool.edit(() => (item.drip = e.target.checked || undefined))} />
            Крапає
          </label>
        )}
      </>
    )}
    {item.t === 'pillar' && (
      <Slider label="Радіус" value={item.r ?? 1.5} min={0.6} max={4} step={0.05} onStart={begin} onChange={(v) => live(() => (item.r = v))} fmt={(v) => `${v.toFixed(2)} м`} />
    )}
  </Section>
);
