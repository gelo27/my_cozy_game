import React, { useState } from 'react';
import {
  DEFAULT_RENDER_SETTINGS, MAX_EXPOSURE, MIN_EXPOSURE, type RenderSettings,
} from '../../config/renderSettings';
import type { GameEngine } from '../../engine/GameEngine';
import { chip, Section, Slider } from './EditorWidgets';

const TONE_MAPPING_LABELS: Record<RenderSettings['toneMapping'], string> = {
  aces: 'ACES Filmic',
  agx: 'AgX',
  neutral: 'Neutral',
  reinhard: 'Reinhard',
  linear: 'Linear',
  off: 'Вимкнено',
};

const selectClass = 'w-full rounded border border-white/10 bg-zinc-900 px-2 py-1.5 text-zinc-100 outline-none focus:border-sky-500';

export const RenderPanel: React.FC<{ engine: GameEngine }> = ({ engine }) => {
  const [settings, setSettings] = useState(() => engine.getRenderSettings());
  const update = (patch: Partial<RenderSettings>) => {
    engine.setRenderSettings(patch);
    setSettings(engine.getRenderSettings());
  };

  return (
    <Section title="Колір та експозиція">
      <label className="flex flex-col gap-1 text-zinc-400">
        Тонмапінг
        <select
          className={selectClass}
          value={settings.toneMapping}
          onChange={(event) => update({ toneMapping: event.target.value as RenderSettings['toneMapping'] })}
        >
          {Object.entries(TONE_MAPPING_LABELS).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
        </select>
      </label>
      <fieldset disabled={settings.toneMapping === 'off'} className="mt-1 min-w-0 disabled:opacity-50">
        <Slider
          label="Експозиція" value={settings.exposure} min={MIN_EXPOSURE} max={MAX_EXPOSURE} step={0.01}
          onChange={(exposure) => update({ exposure })} fmt={(value) => `${value.toFixed(2)}×`}
        />
      </fieldset>
      <label className="mt-1 flex flex-col gap-1 text-zinc-400">
        Вихідний колірний простір
        <select
          className={selectClass}
          value={settings.outputColorSpace}
          onChange={(event) => update({ outputColorSpace: event.target.value as RenderSettings['outputColorSpace'] })}
        >
          <option value="srgb">sRGB (для екрана)</option>
          <option value="linear">Linear sRGB (для перевірки)</option>
        </select>
      </label>
      <button type="button" className={`${chip(false)} mt-1 self-start`} onClick={() => update(DEFAULT_RENDER_SETTINGS)}>
        Скинути налаштування рендера
      </button>
    </Section>
  );
};
