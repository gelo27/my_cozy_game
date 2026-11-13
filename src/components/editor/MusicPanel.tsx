import React, { useEffect, useState } from 'react';
import { music, type TimeSlot } from '../../audio/music/MusicDirector';
import { WEATHER_LABELS, type WeatherType } from '../../world/WeatherSystem';
import { chip, Section } from './EditorWidgets';

const MODE_LABELS: Record<string, string> = { ambient: 'Звичайна', cave: 'Печера', danger: 'Небезпека', sleep: 'Сон' };
const SPACE_LABELS: Record<string, string> = { room: 'Кімната', hall: 'Зала', field: 'Відкрите поле', cave: 'Печера' };
const SLOT_LABELS: Record<TimeSlot, string> = { day: 'День', evening: 'Вечір', night: 'Ніч' };
const KIND_LABELS: Record<string, string> = { track: 'Треки', loop: 'Тривога' };
const PLACE_LABELS = { cave: 'Печера', danger: 'Помітили', attack: 'Атака' } as const;

const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Developer panel for the soundtrack: what plays and why, forced states, every song on demand. */
export const MusicPanel: React.FC = () => {
  // Live numbers (voices, time left): refresh twice a second while the panel is open
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, []);
  const info = music.debugInfo();
  const o = music.override;
  const songs = music.debugSongs();
  const refresh = () => tick((n) => n + 1);

  if (!info.ready) {
    return (
      <Section title="Музика">
        <p className="text-zinc-400">Звук ще не запущено: браузер вмикає аудіо лише після першого кліку чи натискання клавіші в грі.</p>
      </Section>
    );
  }

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-2">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-200 text-right tabular-nums">{value}</span>
    </div>
  );
  const v = info.voices;

  return (
    <>
      <Section title="Зараз">
        {row('Режим', MODE_LABELS[info.mode] ?? info.mode)}
        {row('Час доби / погода', `${info.slot ? SLOT_LABELS[info.slot] : '—'} · ${info.weather ? WEATHER_LABELS[info.weather as WeatherType] ?? info.weather : '—'}`)}
        {row('Трек', info.track ? `${songs.find((s) => s.id === info.track!.id)?.title ?? info.track.id} · ще ${time(info.track.left)}` : '—')}
        {info.mode === 'ambient' && !info.track && row('Тиша ще', `${info.silence} с`)}
        {row('Простір', info.space ? SPACE_LABELS[info.space] ?? info.space : '—')}
        {info.danger &&
          row(
            'Тривога',
            info.danger.attack ? 'атака' : info.danger.chase ? 'погоня' : `загубили слід · ще ${info.danger.hold} с`
          )}
        {v && row('Голоси (зараз / пік / ліміт)', `${v.now} / ${v.peak} / ${v.limit}`)}
        {v && row('Обрізано лімітом', v.stolen)}
        {row('Семпли в RAM', `${info.sampleKB} КБ`)}
        {row('Синтез', `${info.renderMs} мс · ${info.renderedOn === 'worker' ? 'Worker' : info.renderedOn === 'main' ? 'головний потік' : '—'}`)}
        <div className="flex gap-1 pt-1">
          <button className={`${chip(false)} flex-1`} onClick={() => (music.debugSkipSilence(), refresh())}>
            Без паузи
          </button>
          <button className={`${chip(false)} flex-1`} onClick={() => (music.debugStop(), refresh())}>
            Зупинити
          </button>
        </div>
      </Section>

      <Section title="Примусовий стан">
        <p className="text-zinc-500">Директор поводиться так, ніби у світі саме це. «Авто» повертає справжній стан.</p>
        <div className="flex flex-wrap gap-1">
          <button className={chip(o.slot === null)} onClick={() => ((o.slot = null), refresh())}>Авто</button>
          {(Object.keys(SLOT_LABELS) as TimeSlot[]).map((k) => (
            <button key={k} className={chip(o.slot === k)} onClick={() => ((o.slot = k), refresh())}>
              {SLOT_LABELS[k]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button className={chip(o.weather === null)} onClick={() => ((o.weather = null), refresh())}>Авто</button>
          {(Object.keys(WEATHER_LABELS) as WeatherType[]).map((k) => (
            <button key={k} className={chip(o.weather === k)} onClick={() => ((o.weather = k), refresh())}>
              {WEATHER_LABELS[k]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button className={chip(o.place === null)} onClick={() => ((o.place = null), refresh())}>Авто</button>
          {(Object.keys(PLACE_LABELS) as (keyof typeof PLACE_LABELS)[]).map((k) => (
            <button key={k} className={chip(o.place === k)} onClick={() => ((o.place = k), refresh())}>
              {PLACE_LABELS[k]}
            </button>
          ))}
        </div>
      </Section>

      {(['track', 'loop'] as const).map((kind) => {
        const list = songs.filter((s) => s.kind === kind);
        if (!list.length) return null;
        return (
          <Section key={kind} title={`${KIND_LABELS[kind]} (${list.length})`}>
            {list.map((s) => (
              <div key={s.id} className="flex items-center gap-2">
                <button className={`${chip(false)} w-8 shrink-0`} title="Зіграти зараз" onClick={() => (music.debugPlay(s.id), refresh())}>
                  ▶
                </button>
                <div className="flex-1 min-w-0">
                  <div className={`truncate ${info.track?.id === s.id || (s.kind === 'loop' && !!info.danger) ? 'text-sky-300' : 'text-zinc-200'}`}>{s.title}</div>
                  <div className="text-[10px] text-zinc-500 truncate">
                    {time(s.seconds)} · {s.mood.join(', ') || 'без тегів'}
                  </div>
                </div>
              </div>
            ))}
          </Section>
        );
      })}

      <Section title="Ліміт голосів">
        <div className="flex gap-1">
          {[16, 24, 40].map((n) => (
            <button key={n} className={`${chip(v?.limit === n)} flex-1`} onClick={() => (music.setVoiceLimit(n), refresh())}>
              {n}
            </button>
          ))}
        </div>
        <p className="text-zinc-500">24 — телефон, 40 — ПК. Менший ліміт обрізає хвости нот, які затухають.</p>
      </Section>
    </>
  );
};
