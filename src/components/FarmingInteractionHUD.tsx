import React from 'react';
import { FarmInteractionPrompt } from '../farming/types/FarmingTypes';
import { InventoryManager } from '../inventory/InventoryManager';
import { useLang } from '../i18n/i18n';
import { ActionPrompt } from './ActionPrompt';

interface FarmingInteractionHUDProps {
  prompt: FarmInteractionPrompt | null;
  inventoryManager: InventoryManager;
  onOpenInventory: () => void;
}

export const FarmingInteractionHUD: React.FC<FarmingInteractionHUDProps> = ({ prompt }) => {
  useLang();
  const canAct = !!prompt && (prompt.canPlant || prompt.canWater || prompt.canHarvest || !!prompt.canDig);

  return (
    <>
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
