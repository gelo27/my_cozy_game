import React from 'react';
import { FarmInteractionPrompt } from '../farming/types/FarmingTypes';
import { InventoryManager } from '../inventory/InventoryManager';
import { t, useLang, dataName } from '../i18n/i18n';
import { ItemIcon } from './ItemIcon';
import { ActionPrompt } from './ActionPrompt';

interface FarmingInteractionHUDProps {
  prompt: FarmInteractionPrompt | null;
  inventoryManager: InventoryManager;
  onOpenInventory: () => void;
}

export const FarmingInteractionHUD: React.FC<FarmingInteractionHUDProps> = ({
  prompt,
  inventoryManager,
  onOpenInventory,
}) => {
  useLang();
  const equippedItem = inventoryManager.getEquippedItem();
  const canAct = !!prompt && (prompt.canPlant || prompt.canWater || prompt.canHarvest || !!prompt.canDig);

  return (
    <>
      {/* Quick In-Hand Status (Heartopia Cozy Bottom-Right Widget) */}
      <div className="fixed bottom-6 right-6 z-40 hidden lg:flex flex-col items-end gap-2 pointer-events-auto select-none">
        <button
          onClick={onOpenInventory}
          className="group flex items-center gap-3 px-4 py-2.5 bg-gradient-to-r from-[#fefbf6] to-[#f4ebe1] hover:from-white hover:to-[#faefe4] text-amber-950 rounded-2xl border-2 border-[#dfd0be] shadow-lg transition-all duration-200 active:scale-95 cursor-pointer"
        >
          <div className="relative w-10 h-10 rounded-xl bg-amber-100 border border-amber-300 flex items-center justify-center text-2xl shadow-inner group-hover:scale-105 transition-transform">
            <ItemIcon item={equippedItem} />
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

      {/* Center plot interaction prompt: key + short action */}
      {prompt && (
        <ActionPrompt
          text={prompt.actionText}
          canAct={canAct}
          hold={!!prompt.shovel || prompt.canHarvest}
          holdProgress={prompt.holdProgress ?? 0}
        />
      )}
    </>
  );
};
