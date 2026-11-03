import React from 'react';
import { Axe, Pickaxe, TreePine, Gem } from 'lucide-react';
import { GatherPrompt } from '../character/abilities/GatheringAbility';
import { t } from '../i18n/i18n';

interface GatherPromptHUDProps {
  prompt: GatherPrompt;
}

/** Tooltip shown next to a tree, fallen trunk or rock: what the tool will do and how many hits are left. */
export const GatherPromptHUD: React.FC<GatherPromptHUDProps> = ({ prompt }) => {
  const isForest = prompt.kind === 'tree' || prompt.kind === 'fallen';
  const ToolIcon = isForest ? Axe : Pickaxe;
  const NodeIcon = isForest ? TreePine : Gem;

  return (
    <div className="fixed bottom-60 sm:bottom-24 left-1/2 -translate-x-1/2 z-40 pointer-events-none select-none">
      <div className="flex items-center gap-3 px-5 py-3 bg-[#2d1c10]/90 rounded-2xl border-2 border-amber-400/80 shadow-2xl text-white">
        <div className="w-10 h-10 rounded-xl bg-amber-500/30 border border-amber-400/50 flex items-center justify-center shrink-0">
          {prompt.canAct ? (
            <ToolIcon className="w-5 h-5 text-amber-200" />
          ) : (
            <NodeIcon className={`w-5 h-5 ${prompt.kind === 'iron' ? 'text-orange-300' : 'text-emerald-300'}`} />
          )}
        </div>

        <div className="flex flex-col">
          <span className="text-xs font-semibold text-amber-200">{prompt.title}</span>
          <span className="text-sm font-extrabold text-amber-50 tracking-wide">{prompt.actionText}</span>
          <span className="text-[11px] text-amber-200/80 max-w-xs">{prompt.hintText}</span>
          {prompt.progress > 0 && (
            <div className="mt-1.5 h-1.5 w-48 rounded-full bg-black/40 overflow-hidden">
              <div className="h-full bg-amber-400 transition-all duration-200" style={{ width: `${prompt.progress * 100}%` }} />
            </div>
          )}
        </div>

        {prompt.canAct && (
          <div className="ml-2 px-2.5 py-1 bg-amber-500 text-amber-950 font-black text-xs rounded-lg shadow-sm">
            {t('common.actKeys')}
          </div>
        )}
      </div>
    </div>
  );
};
