import React from 'react';
import { Shovel } from 'lucide-react';
import { InventoryItem, getItemEmoji } from '../inventory/types/InventoryTypes';

/**
 * Item glyph for slots and tooltips. Emoji for most items; the shovel draws a vector icon because
 * its emoji (🪏, Unicode 13) is missing from older system fonts such as Windows 10.
 */
export const ItemIcon: React.FC<{ item?: InventoryItem | null }> = ({ item }) => {
  if (item?.id === 'shovel') return <Shovel className="w-[1.1em] h-[1.1em] text-[#8b5a2b]" strokeWidth={2.4} />;
  return <>{getItemEmoji(item)}</>;
};
