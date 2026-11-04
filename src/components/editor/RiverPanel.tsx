import React, { useState } from 'react';
import * as THREE from 'three';
import { Plus, Trash2, Crosshair, Save, ClipboardCopy, Spline, Droplet, GitBranch, Waves } from 'lucide-react';
import type { GameEngine } from '../../engine/GameEngine';
import { riverWorld } from '../../world/rivers/RiverWorld';
import { DEFAULT_BULGE } from '../../world/rivers/RiverSpline';
import { btn, chip, Section, Slider, NumberField } from './EditorWidgets';

const danger = `${btn} gap-1.5 py-1.5 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25`;

/** Editor panel for the river tool: river list, river settings, the selected point, saving. */
export const RiverPanel: React.FC<{ engine: GameEngine }> = ({ engine }) => {
  const editor = engine.world!.editor;
  const tool = editor.rivers;
  const river = tool.river;
  const point = tool.point;
  const [status, setStatus] = useState('');
  const sampled = river ? riverWorld.get(river.id) : undefined;

  const focusRiver = (id: string) => {
    const s = riverWorld.get(id);
    const q = s?.samples[Math.floor(s.samples.length / 2)];
    const p = s?.def.points[0];
    if (q) editor.focusOn(new THREE.Vector3(q.x, q.s, q.z));
    else if (p) editor.focusOn(new THREE.Vector3(p.x, engine.world!.terrain.getHeight(p.x, p.z), p.z));
    tool.select(id, tool.selectedRiver === id ? tool.selectedPoint : -1);
  };

  return (
    <>
      <Section title={`Річки (${riverWorld.defs.length})`} right={tool.unsaved ? <span className="normal-case text-amber-400">не збережено</span> : null}>
        <div className="flex flex-col max-h-40 overflow-y-auto">
          {riverWorld.defs.map((d) => {
            const s = riverWorld.get(d.id);
            return (
              <div key={d.id} className={`flex items-center rounded-lg ${d.id === tool.selectedRiver ? 'bg-sky-500/30' : 'hover:bg-white/10'}`}>
                <button className={`${btn} flex-1 justify-start gap-2 px-2 py-1 min-w-0`} onClick={() => tool.select(d.id)}>
                  {d.kind === 'lake' ? <Waves className="w-3.5 h-3.5 text-cyan-300 shrink-0" /> : <Spline className="w-3.5 h-3.5 text-sky-400 shrink-0" />}
                  <span className="truncate">{d.name}</span>
                  <span className="ml-auto text-[10px] text-zinc-500 tabular-nums shrink-0">
                    {d.points.length} т.{s?.falls.length ? ` · ${s.falls.length} вод.` : ''}
                  </span>
                </button>
                <button className={`${btn} w-6 h-6 hover:bg-white/10`} title="Показати" onClick={() => focusRiver(d.id)}>
                  <Crosshair className="w-3 h-3 text-zinc-400" />
                </button>
              </div>
            );
          })}
          {riverWorld.defs.length === 0 && <p className="text-zinc-500">Ще немає річок. Клацніть по землі, щоб почати.</p>}
        </div>
        <div className="flex gap-1">
          <button className={`${chip(false)} flex-1`} onClick={() => tool.newRiver('river')}>
            <Plus className="w-3.5 h-3.5" /> Річка
          </button>
          <button className={`${chip(false)} flex-1`} onClick={() => tool.newRiver('stream')}>
            <Plus className="w-3.5 h-3.5" /> Струмок
          </button>
          <button className={`${chip(false)} flex-1`} onClick={() => tool.newRiver('lake')} title="Замкнений контур з рівною водою; клікніть по землі, щоб поставити">
            <Plus className="w-3.5 h-3.5" /> Озеро
          </button>
        </div>
      </Section>

      {river && (
        <Section title={tool.isLake ? 'Параметри озера' : 'Параметри річки'}>
          <input
            key={river.id}
            defaultValue={river.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== river.name && tool.setRiver({ name: e.target.value.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="bg-black/30 border border-white/10 rounded px-2 py-1 outline-none focus:border-sky-500"
          />
          {!tool.isLake && (
            <Slider label="Ширина" value={river.width} min={0.8} max={20} step={0.1} onStart={() => tool.beginEdit()} onChange={(v) => tool.setRiver({ width: v }, false)} fmt={(v) => `${v.toFixed(1)} м`} />
          )}
          {tool.isLake && (
            <>
              <label className="flex items-center gap-2 text-zinc-300">
                <input
                  type="checkbox"
                  checked={river.level === undefined}
                  onChange={(e) => tool.setRiver({ level: e.target.checked ? undefined : Math.round((sampled?.lake?.level ?? 0) * 100) / 100 })}
                  className="accent-sky-500"
                />
                Рівень води — авто (нижче найнижчого берега)
              </label>
              {river.level !== undefined ? (
                <Slider label="Рівень води" value={river.level} min={0} max={60} step={0.05} onStart={() => tool.beginEdit()} onChange={(v) => tool.setRiver({ level: v }, false)} fmt={(v) => `${v.toFixed(2)} м`} />
              ) : (
                <p className="text-zinc-500 tabular-nums">Рівень: {(sampled?.lake?.level ?? 0).toFixed(2)} м</p>
              )}
            </>
          )}
          <Slider label="Глибина" value={river.depth} min={0.2} max={tool.isLake ? 8 : 4} step={0.05} onStart={() => tool.beginEdit()} onChange={(v) => tool.setRiver({ depth: v }, false)} fmt={(v) => `${v.toFixed(2)} м`} />
          <label className="flex items-start gap-2 text-zinc-300" title="Невисокі вали там, де вода тече вище навколишньої землі">
            <input
              type="checkbox"
              checked={river.levees !== false}
              onChange={(e) => tool.setRiver({ levees: e.target.checked })}
              className="accent-sky-500 mt-0.5"
            />
            <span>
              Насипи вздовж берегів
              <span className="block text-[10px] text-zinc-500">Вимкнено: береги лише врізаються в рельєф, нічого не насипається.</span>
            </span>
          </label>
          {(sampled?.branchOf || sampled?.flowsInto) && (
            <p className="text-sky-300">
              {sampled.branchOf && <>Гілка від: {riverWorld.defs.find((d) => d.id === sampled.branchOf)?.name}. </>}
              {sampled.flowsInto && <>Впадає в: {riverWorld.defs.find((d) => d.id === sampled.flowsInto)?.name}.</>}
            </p>
          )}
          {sampled && sampled.samples.length > 1 && !tool.isLake && (
            <p className="text-zinc-500 tabular-nums">
              Довжина {sampled.samples[sampled.samples.length - 1].dist.toFixed(0)} м · перепад{' '}
              {(sampled.samples[0].s - sampled.samples[sampled.samples.length - 1].s).toFixed(1)} м
              {sampled.falls.length ? ` · водоспадів: ${sampled.falls.length}` : ''}
            </p>
          )}
          <button className={danger} onClick={() => tool.deleteRiver(river.id)}>
            <Trash2 className="w-3.5 h-3.5" /> {tool.isLake ? 'Видалити озеро' : 'Видалити річку'}
          </button>
        </Section>
      )}

      {river && point && (
        <Section title={`Точка ${tool.selectedPoint + 1} з ${river.points.length}`}>
          <div className="grid grid-cols-2 gap-1">
            <NumberField label="X" value={point.x} onCommit={(v) => tool.setPoint({ x: v })} />
            <NumberField label="Z" value={point.z} onCommit={(v) => tool.setPoint({ z: v })} />
          </div>
          {!tool.isLake && (<>
          <label className="flex items-center gap-2 text-zinc-300">
            <input
              type="checkbox"
              checked={point.y === undefined}
              onChange={(e) => tool.setPoint({ y: e.target.checked ? undefined : Math.round((tool.pointSurface() ?? 0) * 100) / 100 })}
              className="accent-sky-500"
            />
            Рівень води — авто (за рельєфом)
          </label>
          {point.y !== undefined ? (
            <NumberField label="Рівень води Y (закріплено)" value={point.y} onCommit={(v) => tool.setPoint({ y: v })} />
          ) : (
            <p className="text-zinc-500 tabular-nums">Поверхня тут: {(tool.pointSurface() ?? 0).toFixed(2)} м</p>
          )}
          <label className="flex items-center gap-2 text-zinc-300">
            <input
              type="checkbox"
              checked={point.w !== undefined}
              onChange={(e) => tool.setPoint({ w: e.target.checked ? river.width : undefined })}
              className="accent-sky-500"
            />
            Своя ширина в цій точці
          </label>
          {point.w !== undefined && (
            <Slider label="Ширина" value={point.w} min={0.6} max={30} step={0.1} onStart={() => tool.beginEdit()} onChange={(v) => tool.setPoint({ w: v }, false)} fmt={(v) => `${v.toFixed(1)} м`} />
          )}
          <label className="flex items-center gap-2 text-zinc-300">
            <input
              type="checkbox"
              checked={point.d !== undefined}
              onChange={(e) => tool.setPoint({ d: e.target.checked ? river.depth : undefined })}
              className="accent-sky-500"
            />
            Своя глибина в цій точці
          </label>
          {point.d !== undefined && (
            <Slider label="Глибина" value={point.d} min={0.1} max={6} step={0.05} onStart={() => tool.beginEdit()} onChange={(v) => tool.setPoint({ d: v }, false)} fmt={(v) => `${v.toFixed(2)} м`} />
          )}
          <Slider
            label="Водоспад: перепад"
            value={point.fall ?? 0}
            min={0}
            max={16}
            step={0.5}
            onStart={() => tool.beginEdit()}
            onChange={(v) => tool.setPoint({ fall: v || undefined }, false)}
            fmt={(v) => (v ? `${v.toFixed(1)} м` : 'немає')}
          />
          {!!point.fall && (
            <Slider
              label="Опуклість водоспаду"
              value={point.bulge ?? DEFAULT_BULGE}
              min={0}
              max={2.5}
              step={0.05}
              onStart={() => tool.beginEdit()}
              onChange={(v) => tool.setPoint({ bulge: v }, false)}
              fmt={(v) => (v < 0.05 ? 'пласка стіна' : `${v.toFixed(2)}`)}
            />
          )}
          {tool.selectedPoint === 0 && <p className="text-zinc-500">Перша точка — витік; водоспад тут не діє.</p>}
          <button className={`${chip(false)} justify-center`} onClick={() => tool.newBranch()} title="Нова річка, що відходить від цієї точки">
            <GitBranch className="w-3.5 h-3.5" /> Гілка від цієї точки
          </button>
          </>)}
          <button className={danger} onClick={() => tool.deletePoint()}>
            <Trash2 className="w-3.5 h-3.5" /> Видалити точку (Del)
          </button>
        </Section>
      )}

      <Section title="Проєкт">
        <div className="flex gap-1">
          <button
            className={`${chip(tool.unsaved)} flex-1`}
            title="Записати src/world/rivers/rivers.json"
            onClick={async () => setStatus((await tool.saveToProject()) === 'saved' ? 'Записано у rivers.json' : 'Сервер недоступний — файл завантажено')}
          >
            <Save className="w-3.5 h-3.5" /> Зберегти в проєкт
          </button>
          <button
            className={chip(false)}
            title="Копіювати JSON"
            onClick={async () => {
              await navigator.clipboard?.writeText(tool.toJson());
              setStatus('JSON скопійовано');
            }}
          >
            <ClipboardCopy className="w-3.5 h-3.5" />
          </button>
        </div>
        {status && <p className="text-emerald-400">{status}</p>}
      </Section>

      <div className="flex flex-col gap-0.5 text-[10px] text-zinc-500 leading-relaxed">
        <span className="flex items-center gap-1 text-zinc-400"><Droplet className="w-3 h-3" /> Як малювати</span>
        <span>Клік по землі — нова точка в кінці (або перед першою, якщо вона вибрана).</span>
        <span>Shift+клік — вставити точку в найближчий відрізок.</span>
        <span>Клік по маркеру — вибрати; гізмо XZ — рух, стрілка Y — закріпити рівень води.</span>
        <span>Гілки: «Гілка від цієї точки», далі кліками. Закінчіть річку в руслі іншої — вона в неї впаде.</span>
        <span>Озеро: «+ Озеро», клік по землі ставить контур; клік біля краю додає точку. Річка, що входить в озеро чи проходить крізь нього, бере його рівень.</span>
        <span>Вода ніколи не тече вгору: на підйомі русло врізається в рельєф. «Водоспад» опускає воду на перепад і прорізає ущелину нижче.</span>
        <span>Esc — зняти вибір точки · Del — видалити точку · Ctrl+Z — скасувати.</span>
      </div>
    </>
  );
};
