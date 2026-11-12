import React, { useEffect, useState } from 'react';
import { Users, Coins, Droplet, Wheat, Sprout, Sparkles, Coffee, BedDouble, UserPlus, Axe, Pickaxe, Zap, Utensils } from 'lucide-react';
import { GameplayManager } from '../../gameplay/GameplayManager';
import { InventoryManager } from '../../inventory/InventoryManager';
import { MAX_WORKERS, WORKER_HIRE_COST, WorkerView } from '../../npc/WorkerManager';
import { STOCK_TARGET, TASK_KINDS, TaskKind, WORKER_ROLES, WorkerRole } from '../../npc/TaskBoard';
import { t, useLang } from '../../i18n/i18n';
import { TKey } from '../../i18n/en';
import { Shell } from './ActivityPanels';

const ROLE_ICON: Record<WorkerRole, React.ElementType> = {
  all: Sparkles,
  water: Droplet,
  harvest: Wheat,
  plant: Sprout,
  chop: Axe,
  mine: Pickaxe,
  off: Coffee,
};
const ROLE_SHORT: Record<WorkerRole, TKey> = {
  all: 'workers.role.all',
  water: 'workers.role.water',
  harvest: 'workers.role.harvest',
  plant: 'workers.role.plant',
  chop: 'workers.role.chop',
  mine: 'workers.role.mine',
  off: 'workers.role.off',
};
const JOB_ICON: Record<TaskKind, React.ElementType> = { harvest: Wheat, water: Droplet, plant: Sprout, chop: Axe, mine: Pickaxe };

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** Rows are polled from the simulation twice a second while the panel is open (no HUD pushes). */
interface CrewState {
  rows: WorkerView[];
  jobs: Record<TaskKind, number>;
}

function useWorkers(gameplay: GameplayManager): CrewState & { refresh(): void } {
  const read = (): CrewState => ({
    rows: gameplay.workers?.snapshot() ?? [],
    jobs: gameplay.workers?.board?.counts() ?? { harvest: 0, water: 0, plant: 0, chop: 0, mine: 0 },
  });
  const [state, setState] = useState(read);
  useEffect(() => {
    const id = window.setInterval(() => setState(read()), 500);
    return () => window.clearInterval(id);
  }, [gameplay]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, refresh: () => setState(read()) };
}

function useCoins(inventory: InventoryManager): number {
  const [coins, setCoins] = useState(() => inventory.getItemCount('coins'));
  useEffect(() => inventory.subscribe(() => setCoins(inventory.getItemCount('coins'))), [inventory]);
  return coins;
}

/** A small labelled bar: energy or satiety (green, amber below 50, rose below 25). */
const Meter: React.FC<{ icon: React.ElementType; value: number; title: string }> = ({ icon: Icon, value, title }) => (
  <div className="flex items-center gap-1 flex-1 max-w-[150px] min-w-0" title={title}>
    <Icon className="w-3 h-3 shrink-0 text-[#8a7556]" />
    <div className="h-2 flex-1 rounded-full bg-[#efe4cf] overflow-hidden">
      <div
        className={`h-full transition-[width] duration-500 ${value < 25 ? 'bg-rose-400' : value < 50 ? 'bg-amber-400' : 'bg-emerald-500'}`}
        style={{ width: `${value}%` }}
      />
    </div>
    <span className="text-[10px] font-semibold tabular-nums w-7 text-right">{value}%</span>
  </div>
);

export const WorkersPanel: React.FC<{ gameplay: GameplayManager; inventory: InventoryManager; onClose(): void }> = ({ gameplay, inventory, onClose }) => {
  useLang();
  const data = useWorkers(gameplay);
  const { rows, jobs } = data;
  const coins = useCoins(inventory);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const full = rows.length >= MAX_WORKERS;

  const setRole = (id: number, role: WorkerRole) => {
    gameplay.workers?.byId(id)?.setRole(role);
    data.refresh();
  };

  return (
    <Shell title={t('workers.title')} icon={<Users className="w-5 h-5 text-emerald-700" />} onClose={onClose}>
      {/* Crew size, open jobs, hiring */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-extrabold tabular-nums">
          {rows.length}/{MAX_WORKERS}
        </span>
        <span className="text-[11px] text-[#8a7556]">{t('workers.jobs')}:</span>
        {TASK_KINDS.map((k) => {
          const Icon = JOB_ICON[k];
          return (
            <span key={k} className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-[#f3e8d2]">
              <Icon className="w-3.5 h-3.5" /> {jobs[k]}
            </span>
          );
        })}
        <button
          disabled={full || coins < WORKER_HIRE_COST}
          onClick={() => {
            gameplay.hireWorker();
            data.refresh();
          }}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-bold bg-emerald-600 text-white disabled:bg-[#e9dcc3] disabled:text-[#a08a68] active:scale-95 transition"
        >
          <UserPlus className="w-4 h-4" />
          {t('workers.hire')}
          <span className="flex items-center gap-0.5 text-xs opacity-90">
            <Coins className="w-3.5 h-3.5" />
            {WORKER_HIRE_COST}
          </span>
        </button>
      </div>

      {rows.length === 0 && <div className="text-sm text-[#8a7556] text-center py-6">{t('workers.empty')}</div>}

      {rows.map((w) => (
        <div key={w.id} className="rounded-2xl bg-white/80 border border-[#efe4cf] p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <span className="w-3.5 h-3.5 rounded-full border border-black/10 shrink-0" style={{ background: hex(w.tint) }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-bold truncate">{w.name}</span>
                <span className="text-[11px] text-[#8a7556] truncate">{w.doing}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <Meter icon={Zap} value={w.energy} title={t('workers.energy')} />
                <Meter icon={Utensils} value={w.food} title={t('workers.food')} />
                <span className="text-[11px] text-[#8a7556] hidden sm:inline whitespace-nowrap">{t('workers.done', { n: w.jobsDone })}</span>
                {!w.hasBed && (
                  <span className="flex items-center gap-0.5 text-[11px] text-rose-600" title={t('workers.noBed')}>
                    <BedDouble className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{t('workers.noBed')}</span>
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={() => {
                if (confirmId === w.id) {
                  gameplay.dismissWorker(w.id);
                  setConfirmId(null);
                  data.refresh();
                } else {
                  setConfirmId(w.id);
                }
              }}
              onBlur={() => setConfirmId((c) => (c === w.id ? null : c))}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold shrink-0 active:scale-95 transition ${
                confirmId === w.id ? 'bg-rose-500 text-white' : 'bg-[#f3e8d2] text-[#8a7556] hover:bg-rose-100'
              }`}
            >
              {confirmId === w.id ? t('workers.confirm') : t('workers.dismiss')}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {WORKER_ROLES.map((r) => {
              const Icon = ROLE_ICON[r];
              const on = w.role === r;
              return (
                <button
                  key={r}
                  onClick={() => setRole(w.id, r)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold transition active:scale-95 ${
                    on ? 'bg-[#4a3b2a] text-white' : 'bg-[#f3e8d2] hover:bg-[#ecdfc4]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {t(ROLE_SHORT[r])}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="text-[11px] text-[#8a7556] text-center leading-snug mt-1">{t('workers.hint', { wood: STOCK_TARGET.wood, stone: STOCK_TARGET.stone })}</div>
    </Shell>
  );
};
