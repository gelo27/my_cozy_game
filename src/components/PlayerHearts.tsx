import React, { useEffect, useState } from 'react';
import { playerHealth, MAX_HEARTS } from '../gameplay/PlayerHealth';

/*
 * Three hearts at the top centre of the HUD. Each heart is full, half or empty; a hit shakes the
 * row and flashes the lost heart, a heal pops it back in, and on the last heart it beats.
 * The health object is polled once a frame and React re-renders only when something changes.
 */

const HEART = 'M12 21.2 C11.7 21.2 11.4 21.1 11.2 20.9 C6.1 16.4 2 12.8 2 8.6 C2 5.5 4.4 3.1 7.4 3.1 C9.2 3.1 10.9 4 12 5.4 C13.1 4 14.8 3.1 16.6 3.1 C19.6 3.1 22 5.5 22 8.6 C22 12.8 17.9 16.4 12.8 20.9 C12.6 21.1 12.3 21.2 12 21.2 Z';

const CSS = `
@keyframes ph-shake { 0%,100% { transform: translateX(0) } 20% { transform: translateX(-5px) } 40% { transform: translateX(4px) } 60% { transform: translateX(-3px) } 80% { transform: translateX(2px) } }
@keyframes ph-hit { 0% { transform: scale(1.35); filter: brightness(3) } 100% { transform: scale(1); filter: none } }
@keyframes ph-pop { 0% { transform: scale(0.6) } 60% { transform: scale(1.25) } 100% { transform: scale(1) } }
@keyframes ph-beat { 0%,100% { transform: scale(1) } 12% { transform: scale(1.18) } 24% { transform: scale(1) } 36% { transform: scale(1.12) } }
`;

/** fill: 0 empty, 1 half, 2 full. */
const Heart: React.FC<{ fill: number; anim: string; id: number }> = ({ fill, anim, id }) => (
  <svg
    width="30"
    height="30"
    viewBox="0 0 24 24"
    style={{ animation: anim, overflow: 'visible', filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,0.55))' }}
  >
    <defs>
      <clipPath id={`ph-half-${id}`}>
        <rect x="0" y="0" width="12" height="24" />
      </clipPath>
    </defs>
    {/* Empty socket */}
    <path d={HEART} fill="rgba(30,10,14,0.55)" stroke="#2a0d12" strokeWidth="1.6" strokeLinejoin="round" />
    {fill > 0 && (
      <g clipPath={fill === 1 ? `url(#ph-half-${id})` : undefined}>
        <path d={HEART} fill="#ff4b5c" />
        {/* Shine */}
        <path d="M6.2 6.2 C5 6.9 4.5 8.1 4.7 9.4" fill="none" stroke="rgba(255,235,238,0.85)" strokeWidth="1.7" strokeLinecap="round" />
      </g>
    )}
    <path d={HEART} fill="none" stroke="#2a0d12" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

export const PlayerHearts: React.FC = () => {
  const [state, setState] = useState({ halves: playerHealth.halves, hurtAt: playerHealth.hurtAt, healedAt: playerHealth.healedAt, prev: playerHealth.halves });

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      setState((s) =>
        s.halves === playerHealth.halves && s.hurtAt === playerHealth.hurtAt && s.healedAt === playerHealth.healedAt
          ? s
          : { halves: playerHealth.halves, hurtAt: playerHealth.hurtAt, healedAt: playerHealth.healedAt, prev: s.halves }
      );
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const { halves, hurtAt, healedAt, prev } = state;
  const hurt = hurtAt >= healedAt;
  const low = halves > 0 && halves <= 2;
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 flex gap-1">
      <style>{CSS}</style>
      {/* Keyed by the hit time so the shake replays on every blow */}
      <div key={hurtAt} className="flex gap-1" style={{ animation: hurtAt > 0 ? 'ph-shake 0.32s ease-out' : undefined }}>
        {Array.from({ length: MAX_HEARTS }, (_, i) => {
          const fill = Math.max(0, Math.min(2, halves - i * 2));
          const before = Math.max(0, Math.min(2, prev - i * 2));
          const changed = fill !== before;
          let anim = '';
          if (changed && hurt) anim = 'ph-hit 0.35s ease-out';
          else if (changed) anim = 'ph-pop 0.35s ease-out';
          // The last heart left beats
          else if (low && i === Math.ceil(halves / 2) - 1) anim = 'ph-beat 1.1s ease-in-out infinite';
          return <Heart key={`${i}-${changed ? (hurt ? hurtAt : healedAt) : 0}`} fill={fill} anim={anim} id={i} />;
        })}
      </div>
    </div>
  );
};
