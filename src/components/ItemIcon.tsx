import React from 'react';
import { Shovel } from 'lucide-react';
import { InventoryItem, getItemEmoji } from '../inventory/types/InventoryTypes';

/**
 * Item glyph for slots and tooltips. Emoji for most items; the shovel draws a vector icon because
 * its emoji (🪏, Unicode 13) is missing from older system fonts such as Windows 10.
 */
export const ItemIcon: React.FC<{ item?: InventoryItem | null }> = ({ item }) => {
  if (item?.id === 'shovel') return <Shovel className="w-[1.1em] h-[1.1em] text-[#8b5a2b]" strokeWidth={2.4} />;
  // Pine cone: there is no emoji for it (🌲 is already the wood), so a small drawn one
  if (item?.id === 'pine_cone') {
    return (
      <svg viewBox="0 0 24 24" className="w-[1.1em] h-[1.1em]" aria-hidden>
        <path d="M12 2c1.2 0 2 .8 2 1.6V4" stroke="#4f7a32" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        <path d="M12 4c4 0 6.5 5 6.5 9.5S15.5 22 12 22s-6.5-4-6.5-8.5S8 4 12 4z" fill="#8a5a2e" />
        <path d="M7 10.5l5 3 5-3M6.2 14.5l5.8 3 5.8-3M8.5 7.5l3.5 2 3.5-2" stroke="#d9a35e" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
      </svg>
    );
  }
  // Tulips: one emoji for all four, the petal colour as a dot in the corner
  if (item?.id.startsWith('tulip_')) {
    return (
      <span className="relative inline-block leading-none">
        🌷
        <span
          className="absolute -bottom-[0.05em] -right-[0.15em] w-[0.42em] h-[0.42em] rounded-full border border-white/80 shadow-sm"
          style={{ background: item.color }}
        />
      </span>
    );
  }
  return <>{getItemEmoji(item)}</>;
};
