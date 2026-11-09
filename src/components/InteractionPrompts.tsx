import React from 'react';
import { InventoryManager } from '../inventory/InventoryManager';
import { FarmingInteractionHUD } from './FarmingInteractionHUD';
import { GatherPromptHUD } from './GatherPromptHUD';
import { useFarmingPrompt, useGatherPrompt } from './promptStore';

/** Field and gathering prompts; re-renders on its own when a prompt changes (see promptStore). */
export const InteractionPrompts: React.FC<{ inventoryManager: InventoryManager; onOpenInventory: () => void }> = ({
  inventoryManager,
  onOpenInventory,
}) => {
  const farmingPrompt = useFarmingPrompt();
  const gatherPrompt = useGatherPrompt();
  return (
    <>
      <FarmingInteractionHUD prompt={farmingPrompt} inventoryManager={inventoryManager} onOpenInventory={onOpenInventory} />
      {gatherPrompt && !farmingPrompt && <GatherPromptHUD prompt={gatherPrompt} />}
    </>
  );
};
