import React from 'react';
import { Mouse } from 'lucide-react';

/** Circumference of the hold ring around the key cap (r = 20). */
const HOLD_RING = 2 * Math.PI * 20;

interface ActionPromptProps {
  /** Short verb phrase: what pressing the key does. */
  text: string;
  /** Whether the action is available right now (shows the E / LMB keys). */
  canAct: boolean;
  /** Hold-to-act: draws a fill ring around the key cap. */
  hold?: boolean;
  holdProgress?: number;
  /** Optional 0..1 work progress (e.g. hits on a tree), drawn as a thin bar under the text. */
  progress?: number;
}

/** A trailing "[Q]" in a message becomes a key cap instead of bracket text. */
const splitKey = (text: string): { text: string; key: string | null } => {
  const m = text.match(/^(.*?)\s*\[(\w)\]\s*$/);
  return m ? { text: m[1], key: m[2] } : { text, key: null };
};

const KeyCap: React.FC<{ label: string; muted?: boolean }> = ({ label, muted }) => (
  <span
    className={`w-8 h-8 rounded-lg flex items-center justify-center font-black text-sm shadow-[inset_0_-3px_0_rgba(0,0,0,0.25)] ${
      muted ? 'bg-amber-100/20 text-amber-50' : 'bg-amber-50 text-amber-950'
    }`}
  >
    {label}
  </span>
);

/** Minimal game-style interaction prompt: [key] + what it does. */
export const ActionPrompt: React.FC<ActionPromptProps> = ({ text, canAct, hold, holdProgress = 0, progress = 0 }) => {
  const { text: label, key } = splitKey(text);

  return (
    <div className="fixed bottom-60 sm:bottom-24 touch:sm:bottom-16 left-1/2 -translate-x-1/2 z-40 pointer-events-none select-none">
      <div className="flex items-center gap-2.5 pl-1.5 pr-4 py-1.5 bg-black/60 backdrop-blur-sm rounded-xl shadow-lg text-white">
        {canAct ? (
          <span className="flex items-center gap-1">
            <span className="relative">
              {hold && (
                <svg className="absolute -inset-1 w-10 h-10 -rotate-90" viewBox="0 0 44 44">
                  <circle
                    cx="22"
                    cy="22"
                    r="20"
                    fill="none"
                    stroke="#fbbf24"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray={HOLD_RING}
                    strokeDashoffset={HOLD_RING * (1 - holdProgress)}
                    style={{ transition: 'stroke-dashoffset 80ms linear' }}
                  />
                </svg>
              )}
              <KeyCap label="E" />
            </span>
            <Mouse className="w-4 h-4 text-amber-100/70 touch:hidden" />
          </span>
        ) : key ? (
          <KeyCap label={key} muted />
        ) : (
          <span className="w-1.5" />
        )}

        <div className="flex flex-col">
          <span className={`text-sm font-bold whitespace-nowrap ${canAct ? 'text-white' : 'text-amber-100/80'}`}>{label}</span>
          {progress > 0 && (
            <div className="mt-1 h-1 w-full min-w-24 rounded-full bg-white/15 overflow-hidden">
              <div className="h-full bg-amber-400 transition-all duration-200" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
