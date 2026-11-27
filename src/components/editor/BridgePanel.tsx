import { Crosshair, Plus, Trash2 } from 'lucide-react';
import { Vector3 } from 'three';
import { CHARACTER_CONFIG } from '../../config/constants';
import type { GameEngine } from '../../engine/GameEngine';
import { BRIDGE_RANGES, MAX_BRIDGE_SPAN, MIN_BRIDGE_SPAN, bridgeMaxSlope, bridgeSpan } from '../../world/BridgeTypes';
import { chip, NumberField, Section, Slider } from './EditorWidgets';

const metres = (value: number) => `${value.toFixed(2)} м`;
const fields = [
  ['width', 'Ширина настилу'],
  ['rise', 'Підйом дуги'],
  ['thickness', 'Товщина настилу'],
  ['railHeight', 'Висота перил'],
] as const;

export function BridgePanel({ engine }: { engine: GameEngine }) {
  const editor = engine.world!.editor;
  const tool = editor.bridges;
  const draft = tool.draft;
  const list = tool.list;
  const definition = tool.definition;
  const slope = definition ? bridgeMaxSlope(definition) : null;
  const maxSlope = CHARACTER_CONFIG.MAX_WALKABLE_SLOPE_DEG;
  const selected = list.find(({ id }) => id === tool.selected);
  const focus = () => {
    const { a, b } = definition ?? selected!;
    editor.focusOn(new Vector3((a.x + b.x) / 2, (a.y + b.y) / 2 + draft.rise, (a.z + b.z) / 2));
  };

  return (
    <>
      <Section title="Дерев’яний міст">
        <div className="flex flex-wrap gap-1">
          <button type="button" className={chip(!tool.selected && !draft.a)} onClick={() => tool.select(null)}>
            <Plus size={13} /> Новий міст
          </button>
          {(definition || selected) && (
            <button type="button" className={chip(false)} onClick={focus}>
              <Crosshair size={13} /> Показати
            </button>
          )}
        </div>
        {list.length > 0 && (
          <select aria-label="Збудовані мости" value={tool.selected ?? ''} onChange={(event) => tool.select(event.target.value || null)}
            className="w-full rounded border border-white/10 bg-zinc-900 px-2 py-1.5 text-zinc-100">
            <option value="">Збудовані мости ({list.length})</option>
            {list.map(({ id, a, b }, index) => (
              <option key={id} value={id}>Міст {index + 1} · {metres(bridgeSpan(a, b))}</option>
            ))}
          </select>
        )}
        <p className="text-zinc-400" role="status">
          {tool.atLimit ? 'Досягнуто ліміту мостів для цього світу.'
            : tool.picking === 'a' ? 'Клацни на березі, щоб поставити точку A по центру входу.'
            : tool.picking === 'b' ? 'Клацни на іншому березі, щоб поставити точку B.'
            : tool.edited ? 'Перевір форму мосту та застосуй зміни.'
            : 'Вибери точку або зміни параметри мосту.'}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {(['a', 'b'] as const).map((end) => {
            const point = draft[end];
            const label = end.toUpperCase();
            return (
              <div className="flex flex-col gap-1.5" key={end}>
                <button type="button" className={`${chip(tool.picking === end)} disabled:opacity-40`}
                  disabled={tool.atLimit || (end === 'b' && !draft.a)}
                  onClick={() => tool.beginPick(end)}>
                  <span className={end === 'a' ? 'text-sky-100' : 'text-amber-300'}>{label}</span>
                  {point ? 'Переставити' : 'Поставити'}
                </button>
                {point && <NumberField label={`Висота ${label}, м`} value={point.y} onCommit={(y) => tool.setHeight(end, y)} />}
              </div>
            );
          })}
        </div>
        {draft.a && draft.b && (
          <div className="flex justify-between text-zinc-400">
            <span>Проліт {metres(tool.span)}</span>
            {slope !== null && <span className={slope > maxSlope ? 'text-amber-300' : undefined}>Ухил до {slope.toFixed(1)}°</span>}
          </div>
        )}
        {tool.spanInvalid && <p className="text-amber-300">Вибери точки на відстані {MIN_BRIDGE_SPAN}–{MAX_BRIDGE_SPAN} м.</p>}
        {slope !== null && slope > maxSlope && (
          <p className="text-amber-300">Персонаж ковзатиме на ухилі понад {maxSlope}°. Зменш підйом або збільш проліт.</p>
        )}
      </Section>
      <Section title="Форма та перила">
        <label className="flex items-center justify-between gap-2 text-zinc-400">
          Форма дуги
          <select value={draft.shape} onChange={(event) => tool.setSettings({ shape: event.target.value === 'eased' ? 'eased' : 'round' })}
            className="rounded border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-100">
            <option value="round">Класична</option>
            <option value="eased">Пологі входи</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-zinc-300">
          <input type="checkbox" checked={draft.railings} onChange={(event) => tool.setSettings({ railings: event.target.checked })}
            className="accent-sky-500" />
          Перила з обох боків
        </label>
        {fields.filter(([key]) => key !== 'railHeight' || draft.railings).map(([key, label]) => (
          <Slider key={key} label={label} value={draft[key]} {...BRIDGE_RANGES[key]} fmt={metres}
            onChange={(value) => tool.setSettings({ [key]: value })} />
        ))}
      </Section>
      <div className="flex flex-wrap gap-1">
        <button type="button" disabled={!tool.canApply} className={`${chip(tool.canApply)} disabled:opacity-40`}
          onClick={() => tool.apply()}>
          {selected ? 'Застосувати' : 'Збудувати міст'}
        </button>
        {(tool.edited || (selected && tool.picking)) && (
          <button type="button" className={chip(false)} onClick={() => tool.selected ? tool.select(tool.selected) : tool.reset()}>
            Скинути зміни
          </button>
        )}
        {selected && (
          <button type="button" className={chip(false)} onClick={() => tool.deleteSelected()}><Trash2 size={13} /> Видалити</button>
        )}
      </div>
    </>
  );
}
