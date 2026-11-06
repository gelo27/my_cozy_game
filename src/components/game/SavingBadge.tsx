import React, { useEffect, useState } from 'react';
import { t, useLang } from '../../i18n/i18n';

/** Minimum time the badge stays visible, so a few-millisecond save is still noticeable. */
const MIN_VISIBLE_MS = 1500;

/** "Saving game" pill at the top centre, shown while the periodic (60 s) autosave runs. */
export const SavingBadge = React.memo(function SavingBadge() {
  useLang();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let startedAt = 0;
    let hideTimer = 0;
    const onStart = () => {
      window.clearTimeout(hideTimer);
      startedAt = performance.now();
      setVisible(true);
    };
    const onEnd = () => {
      const left = Math.max(0, MIN_VISIBLE_MS - (performance.now() - startedAt));
      hideTimer = window.setTimeout(() => setVisible(false), left);
    };
    window.addEventListener('autosave-start', onStart);
    window.addEventListener('autosave-end', onEnd);
    return () => {
      window.removeEventListener('autosave-start', onStart);
      window.removeEventListener('autosave-end', onEnd);
      window.clearTimeout(hideTimer);
    };
  }, []);

  return (
    <div
      className={`absolute top-3 touch:top-2 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold bg-[#fffaf0]/90 text-[#4a3b2a] border border-[#e9dcc3] shadow-[0_6px_20px_rgba(60,40,10,0.18)] pointer-events-none transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}
    >
      <span className="inline-block w-3 h-3 rounded-full border-2 border-[#b9a27a] border-t-transparent animate-spin" />
      {t('hud.saving')}
    </div>
  );
});
