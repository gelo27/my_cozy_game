import React from 'react';
import { GatherPrompt } from '../character/abilities/GatheringAbility';
import { ActionPrompt } from './ActionPrompt';

interface GatherPromptHUDProps {
  prompt: GatherPrompt;
}

/** Prompt next to a tree, fallen trunk or rock: the key and what it does. */
export const GatherPromptHUD: React.FC<GatherPromptHUDProps> = ({ prompt }) => (
  <ActionPrompt text={prompt.actionText} canAct={prompt.canAct} progress={prompt.progress} />
);
