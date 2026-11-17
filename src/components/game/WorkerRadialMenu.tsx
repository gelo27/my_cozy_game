import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, Droplet, Wheat, Sprout, Axe, Pickaxe, Coffee, Zap, Utensils, X } from 'lucide-react';
import { GameplayManager } from '../../gameplay/GameplayManager';
import { WORKER_ROLES, WorkerRole } from '../../npc/TaskBoard';
import { t, useLang } from '../../i18n/i18n';
import { TKey } from '../../i18n/en';

const ROLE_ICON: Record<WorkerRole, React.ElementType> = {
  all: Sparkles,
  water: Droplet,
  harvest: Wheat,
  plant: Sprout,
  chop: Axe,
  mine: Pickaxe,
  off: Coffee,
};
const ROLE_LABEL: Record<WorkerRole, TKey> = {
  all: 'workers.role.all',
  water: 'workers.role.water',
  harvest: 'workers.role.harvest',
  plant: 'workers.role.plant',
  chop: 'workers.role.chop',
  mine: 'workers.role.mine',
  off: 'workers.role.off',
};

/** The menu closes when the player walks this far from where it was opened (m). */
const CLOSE_DIST = 3;
const N = WORKER_ROLES.length;
const STEP = (Math.PI * 2) / N;

/** SVG path of one ring sector (angles from 12 o'clock, clockwise). */
function sectorPath(i: number, rIn: number, rOut: number, gap: number): string {
  const a0 = i * STEP - STEP / 2 + gap;
  const a1 = i * STEP + STEP / 2 - gap;
  const p = (r: number, a: number) => `${(Math.sin(a) * r).toFixed(2)} ${(-Math.cos(a) * r).toFixed(2)}`;
  return `M ${p(rOut, a0)} A ${rOut} ${rOut} 0 0 1 ${p(rOut, a1)} L ${p(rIn, a1)} A ${rIn} ${rIn} 0 0 0 ${p(rIn, a0)} Z`;
}

interface Snap {
  name: string;
  role: WorkerRole;
  energy: number;
  food: number;
  doing: string;
}

/**
 * Radial job menu for a farmhand (E next to one). Works the same with a mouse and a finger:
 * point / drag towards a sector and click / release, or tap it; 1-7 pick by number; a tap
 * outside the ring, the centre button, right click or Esc closes it.
 */
export const WorkerRadialMenu: React.FC<{ gameplay: GameplayManager }> = ({ gameplay }) => {
  useLang();
  const ringRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pressed = useRef(false);

  const read = (): Snap | null => {
    const w = gameplay.menuWorker;
    const crew = gameplay.workers;
    if (!w || !crew) return null;
    return { name: w.name, role: w.role, energy: Math.round(w.energy), food: Math.round(w.food), doing: crew.doingText(w) };
  };
  const [snap, setSnap] = useState(read);

  const close = () => gameplay.openPanel(null);
  const pick = (i: number) => {
    const w = gameplay.menuWorker;
    if (w) gameplay.setWorkerRole(w, WORKER_ROLES[i]);
  };

  // Live worker stats; closes once the worker is gone or the player walks off (the worker itself
  // keeps going about its job, so its own distance doesn't count)
  useEffect(() => {
    const openedAt = gameplay.playerPosition.clone();
    const id = window.setInterval(() => {
      const w = gameplay.menuWorker;
      if (!w || !gameplay.workers?.byId(w.id) || gameplay.playerPosition.distanceTo(openedAt) > CLOSE_DIST) {
        close();
        return;
      }
      setSnap(read());
    }, 250);
    return () => window.clearInterval(id);
  }, [gameplay]); // eslint-disable-line react-hooks/exhaustive-deps

  // 1-7 pick a job (the hotbar leaves the number keys alone while a panel is open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= N && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        pick(n - 1);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [gameplay]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Sector under the pointer: by direction from the centre, beyond a small dead zone. */
  const sectorAt = (x: number, y: number): { i: number | null; outside: boolean } => {
    const el = ringRef.current;
    if (!el) return { i: null, outside: true };
    const r = el.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    const outer = r.width / 2;
    if (d < outer * 0.3) return { i: null, outside: false };
    if (d > outer * 1.25) return { i: null, outside: true };
    let a = Math.atan2(dx, -dy);
    if (a < 0) a += Math.PI * 2;
    return { i: Math.round(a / STEP) % N, outside: false };
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    pressed.current = true;
    setHover(sectorAt(e.clientX, e.clientY).i);
  };
  const onMove = (e: React.PointerEvent) => {
    // A finger only aims while it is down; a mouse aims all the time
    if (e.pointerType !== 'mouse' && !pressed.current) return;
    setHover(sectorAt(e.clientX, e.clientY).i);
  };
  const onUp = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    const wasPressed = pressed.current;
    pressed.current = false;
    if (!wasPressed) return;
    const s = sectorAt(e.clientX, e.clientY);
    if (s.i !== null) pick(s.i);
    else if (s.outside) close();
    if (e.pointerType !== 'mouse') setHover(null);
  };

  if (!snap) return null;

  const current = WORKER_ROLES.indexOf(snap.role);
  const shown = hover ?? current;
  const R_OUT = 100;
  const R_IN = 44;

  return (
    <div
      className="absolute inset-0 z-[42] flex flex-col items-center justify-center bg-black/25 select-none touch-none pointer-events-auto"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => setHover(null)}
      onPointerCancel={() => {
        pressed.current = false;
        setHover(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div ref={ringRef} className="relative w-[min(82vw,340px)] aspect-square">
        <svg viewBox="-110 -110 220 220" className="absolute inset-0 w-full h-full drop-shadow-[0_8px_24px_rgba(60,40,10,0.35)]">
          {WORKER_ROLES.map((r, i) => {
            const hot = i === hover;
            const on = i === current;
            return (
              <path
                key={r}
                d={sectorPath(i, R_IN, hot ? R_OUT + 6 : R_OUT, 0.025)}
                className="transition-[fill] duration-100"
                fill={hot ? '#4a3b2a' : on ? '#e8d4ad' : 'rgba(255,250,240,0.95)'}
                stroke={on ? '#b0812f' : '#e9dcc3'}
                strokeWidth={on ? 2 : 1}
              />
            );
          })}
        </svg>

        {/* Icons + labels on the sectors */}
        {WORKER_ROLES.map((r, i) => {
          const Icon = ROLE_ICON[r];
          const a = i * STEP;
          const rr = ((R_IN + R_OUT) / 2 / 220) * 100; // % of the box
          const hot = i === hover;
          return (
            <div
              key={r}
              className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-0.5 pointer-events-none transition-transform duration-100 ${
                hot ? 'text-white scale-110' : 'text-[#4a3b2a]'
              }`}
              style={{ left: `${50 + Math.sin(a) * rr}%`, top: `${50 - Math.cos(a) * rr}%` }}
            >
              <Icon className="w-6 h-6 sm:w-7 sm:h-7" />
              <span className="text-[11px] sm:text-xs font-bold leading-none whitespace-nowrap">{t(ROLE_LABEL[r])}</span>
              <span className={`text-[9px] font-black leading-none hidden [@media(hover:hover)]:block ${hot ? 'text-white/70' : 'text-[#a08a68]'}`}>{i + 1}</span>
            </div>
          );
        })}

        {/* Centre: who, what they do now; tapping it closes the menu */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => {
            e.stopPropagation();
            pressed.current = false;
            close();
          }}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[38%] aspect-square rounded-full bg-[#fffaf0] border-2 border-[#e9dcc3] flex flex-col items-center justify-center gap-0.5 px-2 text-[#4a3b2a] shadow-inner active:scale-95 transition"
          aria-label="close"
        >
          <span className="text-[13px] sm:text-sm font-extrabold leading-tight truncate max-w-full">{snap.name}</span>
          <span className="text-[10px] font-bold text-amber-700 leading-tight truncate max-w-full">{t(ROLE_LABEL[WORKER_ROLES[shown]])}</span>
          <span className="flex items-center gap-1.5 text-[10px] font-semibold text-[#8a7556] tabular-nums">
            <span className="flex items-center gap-0.5" title={t('workers.energy')}>
              <Zap className="w-3 h-3" />
              {snap.energy}
            </span>
            <span className="flex items-center gap-0.5" title={t('workers.food')}>
              <Utensils className="w-3 h-3" />
              {snap.food}
            </span>
          </span>
          <X className="w-3 h-3 text-[#a08a68] mt-0.5" />
        </button>
      </div>

      <div className="mt-4 max-w-[90vw] px-3 py-1.5 rounded-full bg-[#fffaf0]/95 border border-[#e9dcc3] text-[11px] sm:text-xs font-semibold text-[#8a7556] text-center pointer-events-none">
        {snap.doing} · {t('workers.menuHint')}
      </div>
    </div>
  );
};
