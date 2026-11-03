import React from 'react';
import { FarmInteractionPrompt } from '../farming/types/FarmingTypes';
import { InventoryManager } from '../inventory/InventoryManager';
import { getItemEmoji } from '../inventory/types/InventoryTypes';
import { t, useLang, dataName } from '../i18n/i18n';
import { Droplets, Sprout, Package, Sparkles, Clock, AlertCircle } from 'lucide-react';

interface FarmingInteractionHUDProps {
  prompt: FarmInteractionPrompt | null;
  inventoryManager: InventoryManager;
  onOpenInventory: () => void;
}

type PromptAction = 'plant' | 'water' | 'harvest' | 'wait' | 'none';

const getPromptAction = (prompt: FarmInteractionPrompt): PromptAction => {
  if (prompt.canHarvest) return 'harvest';
  if (prompt.canPlant) return 'plant';
  // A dry plot shows the water icon even without a watering can equipped
  if (prompt.canWater || (prompt.cropType && !prompt.isWatered)) return 'water';
  if (prompt.cropType) return 'wait';
  return 'none';
};

export const FarmingInteractionHUD: React.FC<FarmingInteractionHUDProps> = ({
  prompt,
  inventoryManager,
  onOpenInventory,
}) => {
  useLang();
  const state = inventoryManager.getState();
  const equippedItem = inventoryManager.getEquippedItem();
  const action = prompt ? getPromptAction(prompt) : 'none';
  const canAct = !!prompt && (prompt.canPlant || prompt.canWater || prompt.canHarvest);

  return (
    <>
      {/* Quick In-Hand Status (Heartopia Cozy Bottom-Right Widget) */}
      <div className="fixed bottom-6 right-6 z-40 hidden lg:flex flex-col items-end gap-2 pointer-events-auto select-none">
        <button
          onClick={onOpenInventory}
          className="group flex items-center gap-3 px-4 py-2.5 bg-gradient-to-r from-[#fefbf6] to-[#f4ebe1] hover:from-white hover:to-[#faefe4] text-amber-950 rounded-2xl border-2 border-[#dfd0be] shadow-lg transition-all duration-200 active:scale-95 cursor-pointer"
        >
          <div className="relative w-10 h-10 rounded-xl bg-amber-100 border border-amber-300 flex items-center justify-center text-2xl shadow-inner group-hover:scale-105 transition-transform">
            {getItemEmoji(equippedItem)}
            <span className="absolute -top-1 -right-1 px-1 bg-amber-700 text-[9px] font-black text-white rounded-full">
              Q
            </span>
          </div>

          <div className="text-left">
            <div className="text-[10px] font-extrabold uppercase tracking-wider text-amber-700">
              {t('farm.inHands')}
            </div>
            <div className="text-sm font-black text-amber-950 flex items-center gap-1.5">
              {equippedItem ? dataName('item', equippedItem.id, equippedItem.name) : t('farm.emptyHands')}
              {equippedItem && equippedItem.count > 1 && (
                <span className="text-xs font-bold text-amber-600">x{equippedItem.count}</span>
              )}
            </div>
          </div>
        </button>
      </div>

      {/* Center Plot Proximity Interaction Tooltip */}
      {prompt && (
        <div className="fixed bottom-60 sm:bottom-24 left-1/2 -translate-x-1/2 z-40 pointer-events-none select-none animate-bounce-short">
          <div className="flex items-center gap-3 px-5 py-3 bg-[#2d1c10]/90 rounded-2xl border-2 border-amber-400/80 shadow-2xl text-white">
            {/* Status Icon */}
            <div className="w-10 h-10 rounded-xl bg-amber-500/30 border border-amber-400/50 flex items-center justify-center shrink-0">
              {action === 'water' && <Droplets className="w-5 h-5 text-sky-300 animate-pulse" />}
              {action === 'plant' && <Sprout className="w-5 h-5 text-emerald-300" />}
              {action === 'harvest' && <Package className="w-5 h-5 text-amber-300 animate-bounce" />}
              {action === 'wait' && <Clock className="w-5 h-5 text-amber-400" />}
              {action === 'none' && <AlertCircle className="w-5 h-5 text-amber-400" />}
            </div>

            <div className="flex flex-col">
              <span className="text-xs font-semibold text-amber-200">{t('farm.plot')}</span>
              <span className="text-sm font-extrabold text-amber-50 tracking-wide">
                {prompt.actionText}
              </span>
              <span className="text-[11px] text-amber-200/80 max-w-xs">{prompt.hintText}</span>
            </div>

            {/* Quick action button hint */}
            {canAct && (
              <div className="ml-2 px-2.5 py-1 bg-amber-500 text-amber-950 font-black text-xs rounded-lg shadow-sm">
                {t('common.actKeys')}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
