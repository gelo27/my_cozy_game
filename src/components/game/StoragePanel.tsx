import React, { useEffect, useReducer, useState } from 'react';
import { Package, Backpack, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { GameplayManager } from '../../gameplay/GameplayManager';
import { InventoryManager } from '../../inventory/InventoryManager';
import { InventoryItem } from '../../inventory/types/InventoryTypes';
import { t, useLang, dataName } from '../../i18n/i18n';
import { ItemIcon } from '../ItemIcon';
import { Shell } from './ActivityPanels';

/** Items that never go in the chest: tools (they live on the hotbar) and coins. */
const storable = (it: InventoryItem | null): it is InventoryItem => !!it && it.category !== 'tools' && it.id !== 'coins';

/** Re-renders on every backpack or chest change. */
function useStorageTick(gameplay: GameplayManager, inventory: InventoryManager): void {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => inventory.subscribe(() => tick()), [inventory]);
  useEffect(() => gameplay.storage?.subscribe(() => tick()), [gameplay]);
}

const Tile: React.FC<{ item: InventoryItem; count: number; onClick(): void }> = ({ item, count, onClick }) => (
  <button
    onClick={onClick}
    title={dataName('item', item.id, item.name)}
    className="relative aspect-square rounded-xl bg-white/80 border border-[#efe4cf] hover:bg-[#fff6e6] active:scale-95 transition flex items-center justify-center text-2xl"
  >
    <ItemIcon item={item} />
    <span className="absolute bottom-0.5 right-1 text-[10px] font-bold tabular-nums text-[#4a3b2a]">{count}</span>
  </button>
);

/**
 * The storage chest: its shared stock on top, the backpack below. A tap moves the whole stack (or
 * one at a time); two buttons do the usual chores: food and seeds in for the workers, their yield out.
 */
export const StoragePanel: React.FC<{ gameplay: GameplayManager; inventory: InventoryManager; onClose(): void }> = ({ gameplay, inventory, onClose }) => {
  useLang();
  useStorageTick(gameplay, inventory);
  const [one, setOne] = useState(false);
  const stock = gameplay.storage?.list() ?? [];
  const chestItems = stock.map((s) => ({ item: inventory.getItem(s.itemId), count: s.amount })).filter((r): r is { item: InventoryItem; count: number } => storable(r.item));
  const packItems = inventory.getItems().filter((it) => it.count > 0 && storable(it));

  return (
    <Shell title={t('storage.title')} icon={<Package className="w-5 h-5 text-amber-700" />} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => gameplay.storeForWorkers()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-600 text-white active:scale-95 transition"
        >
          <ArrowDownToLine className="w-4 h-4" />
          {t('storage.putFood')}
        </button>
        <button
          onClick={() => gameplay.takeYield()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-[#4a3b2a] text-white active:scale-95 transition"
        >
          <ArrowUpFromLine className="w-4 h-4" />
          {t('storage.takeYield')}
        </button>
        <div className="ml-auto flex rounded-xl bg-[#f3e8d2] p-0.5 text-[11px] font-bold">
          {[false, true].map((v) => (
            <button key={String(v)} onClick={() => setOne(v)} className={`px-2.5 py-1 rounded-lg transition ${one === v ? 'bg-white shadow-sm' : 'text-[#8a7556]'}`}>
              {v ? t('storage.one') : t('storage.all')}
            </button>
          ))}
        </div>
      </div>

      <Section icon={<Package className="w-4 h-4" />} title={t('storage.chest')} empty={!chestItems.length}>
        {chestItems.map(({ item, count }) => (
          <Tile key={item.id} item={item} count={count} onClick={() => gameplay.takeItem(item.id, one ? 1 : count)} />
        ))}
      </Section>
      <Section icon={<Backpack className="w-4 h-4" />} title={t('storage.backpack')} empty={!packItems.length}>
        {packItems.map((item) => (
          <Tile key={item.id} item={item} count={item.count} onClick={() => gameplay.storeItem(item.id, one ? 1 : item.count)} />
        ))}
      </Section>
      <div className="text-[11px] text-[#8a7556] text-center leading-snug mt-1">{t('storage.hint')}</div>
    </Shell>
  );
};

const Section: React.FC<{ icon: React.ReactNode; title: string; empty: boolean; children: React.ReactNode }> = ({ icon, title, empty, children }) => (
  <div className="flex flex-col gap-1.5 mt-1">
    <div className="flex items-center gap-1.5 text-xs font-extrabold text-[#6b5638]">
      {icon}
      {title}
    </div>
    {empty ? (
      <div className="text-xs text-[#a08a68] text-center py-3 rounded-xl bg-white/50">{t('storage.empty')}</div>
    ) : (
      <div className="grid grid-cols-6 sm:grid-cols-8 gap-1.5">{children}</div>
    )}
  </div>
);
