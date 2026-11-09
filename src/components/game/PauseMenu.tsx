import React, { useEffect, useState } from 'react';
import { Play, Save, Volume2, VolumeX, RotateCcw, Maximize, Minimize, BedDouble, Flag } from 'lucide-react';
import { userSettings, updateUserSettings, onUserSettingsChange, resetUserSettings, UserSettings } from '../../config/userSettings';
import { t, useLang, setLang, LANGS } from '../../i18n/i18n';
import { TKey } from '../../i18n/en';

const panel = 'bg-[#fffaf0]/97 text-[#4a3b2a] border border-[#e9dcc3] shadow-[0_10px_40px_rgba(60,40,10,0.35)]';

function useUserSettings(): UserSettings {
  const [, tick] = useState(0);
  useEffect(() => onUserSettingsChange(() => tick((n) => n + 1)), []);
  return userSettings;
}

type VolumeKey = 'sfx' | 'music';
const CHANNELS: { key: VolumeKey; on: 'sfxOn' | 'musicOn'; label: TKey }[] = [
  { key: 'sfx', on: 'sfxOn', label: 'pause.sfx' },
  { key: 'music', on: 'musicOn', label: 'pause.music' },
];

const Range: React.FC<{ value: number; min?: number; max?: number; step?: number; disabled?: boolean; onChange(v: number): void }> = ({
  value, min = 0, max = 1, step = 0.01, disabled, onChange,
}) => (
  <input
    type="range"
    min={min}
    max={max}
    step={step}
    value={value}
    disabled={disabled}
    onChange={(e) => onChange(Number(e.target.value))}
    className="flex-1 min-w-0 accent-amber-600 disabled:opacity-40"
  />
);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center gap-3 min-h-9">
    <span className="w-28 shrink-0 text-sm font-semibold">{label}</span>
    {children}
  </div>
);

const Toggle: React.FC<{ on: boolean; label: string; onClick(): void }> = ({ on, label, onClick }) => (
  <button
    onClick={onClick}
    title={label}
    aria-pressed={on}
    className={`w-9 h-9 shrink-0 rounded-xl flex items-center justify-center border transition active:scale-95 ${
      on ? 'bg-white border-[#e9dcc3] text-amber-700' : 'bg-[#efe4cf] border-transparent text-[#a08d70]'
    }`}
  >
    {on ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
  </button>
);

/** Tracks whether the page is in full screen (the user can also leave it with Esc / the system back gesture). */
function useFullscreen(): [boolean, () => void] {
  const [on, setOn] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  };
  return [on, toggle];
}

/** Pause overlay: resume, save, respawn, sound mixer and a couple of control options. */
export const PauseMenu: React.FC<{ onResume(): void; onSave(): void; onRespawn(): void; respawnAt: 'bed' | 'spawn' }> = ({
  onResume,
  onSave,
  onRespawn,
  respawnAt,
}) => {
  const s = useUserSettings();
  const lang = useLang();
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const canFullscreen = typeof document.documentElement.requestFullscreen === 'function';

  return (
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/35 backdrop-blur-[2px] px-4" onClick={onResume}>
      <div
        className={`${panel} w-full max-w-sm rounded-3xl p-5 max-h-[90dvh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-extrabold text-center mb-4">{t('pause.title')}</h2>

        <div className="grid grid-cols-2 gap-2 mb-5">
          <button
            onClick={onResume}
            className="col-span-2 h-11 rounded-2xl bg-amber-500 hover:bg-amber-400 text-white font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition"
          >
            <Play className="w-4 h-4 fill-white" /> {t('pause.resume')}
          </button>
          <button
            onClick={onSave}
            className="col-span-2 h-10 rounded-2xl bg-white border border-[#e9dcc3] hover:bg-amber-50 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition"
          >
            <Save className="w-4 h-4" /> {t('pause.save')}
          </button>
          {/* Unstuck / go home: the bed slept in last, or the starting point */}
          <button
            onClick={onRespawn}
            className="col-span-2 h-10 rounded-2xl bg-white border border-[#e9dcc3] hover:bg-amber-50 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition"
          >
            {respawnAt === 'bed' ? <BedDouble className="w-4 h-4" /> : <Flag className="w-4 h-4" />}
            {t(respawnAt === 'bed' ? 'pause.respawnBed' : 'pause.respawnSpawn')}
          </button>
          {/* Temporary: full-screen toggle (handy on phones, where the browser bars eat the screen) */}
          {canFullscreen && (
            <button
              onClick={toggleFullscreen}
              className="col-span-2 h-10 rounded-2xl bg-white border border-[#e9dcc3] hover:bg-amber-50 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition"
            >
              {fullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
              {t(fullscreen ? 'pause.exitFullscreen' : 'pause.fullscreen')}
            </button>
          )}
        </div>

        <p className="text-[11px] font-bold uppercase tracking-wider text-[#a08d70] mb-1">{t('pause.sound')}</p>
        <div className="space-y-1 mb-4">
          <Row label={t('pause.master')}>
            <Range value={s.master} onChange={(v) => updateUserSettings({ master: v })} />
            <span className="w-10 text-right text-xs tabular-nums">{pct(s.master)}</span>
          </Row>
          {CHANNELS.map((c) => (
            <Row key={c.key} label={t(c.label)}>
              <Toggle on={s[c.on]} label={t(c.label)} onClick={() => updateUserSettings({ [c.on]: !s[c.on] })} />
              <Range value={s[c.key]} disabled={!s[c.on]} onChange={(v) => updateUserSettings({ [c.key]: v })} />
              <span className="w-10 text-right text-xs tabular-nums">{s[c.on] ? pct(s[c.key]) : '—'}</span>
            </Row>
          ))}
        </div>

        <p className="text-[11px] font-bold uppercase tracking-wider text-[#a08d70] mb-1">{t('pause.controls')}</p>
        <div className="space-y-1 mb-4">
          <Row label={t('pause.sensitivity')}>
            <Range value={s.sensitivity} min={0.3} max={2.5} step={0.05} onChange={(v) => updateUserSettings({ sensitivity: v })} />
            <span className="w-10 text-right text-xs tabular-nums">×{s.sensitivity.toFixed(1)}</span>
          </Row>
          <Row label={t('pause.invertY')}>
            <button
              onClick={() => updateUserSettings({ invertY: !s.invertY })}
              aria-pressed={s.invertY}
              className={`ml-auto w-12 h-7 rounded-full p-0.5 transition ${s.invertY ? 'bg-amber-500' : 'bg-[#e2d5bc]'}`}
            >
              <span className={`block w-6 h-6 rounded-full bg-white shadow transition-transform ${s.invertY ? 'translate-x-5' : ''}`} />
            </button>
          </Row>
          <Row label={t('hud.language')}>
            <div className="ml-auto flex gap-1">
              {LANGS.map((l) => (
                <button
                  key={l.id}
                  onClick={() => setLang(l.id)}
                  className={`h-8 px-3 rounded-xl text-xs font-extrabold border transition ${
                    lang === l.id ? 'bg-amber-500 text-white border-amber-500' : 'bg-white border-[#e9dcc3] hover:bg-amber-50'
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </Row>
        </div>

        <div className="flex items-center justify-between text-xs text-[#a08d70]">
          <span>{t('pause.hint')}</span>
          <button onClick={resetUserSettings} className="flex items-center gap-1 hover:text-amber-700">
            <RotateCcw className="w-3 h-3" /> {t('pause.reset')}
          </button>
        </div>
      </div>
    </div>
  );
};
