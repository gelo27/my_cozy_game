import React, { useEffect, useState } from 'react';
import { X, Coins, Store } from 'lucide-react';
import { GameplayManager, GameplayHudState } from '../../gameplay/GameplayManager';
import { InventoryManager } from '../../inventory/InventoryManager';
import { getItemEmoji } from '../../inventory/types/InventoryTypes';
import { t, useLang, dataName } from '../../i18n/i18n';


const sheet = 'bg-[#fffaf0] text-[#4a3b2a] border border-[#e9dcc3] shadow-[0_12px_40px_rgba(60,40,10,0.3)]';

function useInventoryTick(inventory: InventoryManager): number {
  useLang();
  const [tick, setTick] = useState(0);
  useEffect(() => inventory.subscribe(() => setTick((t) => t + 1)), [inventory]);
  return tick;
}

interface PanelProps {
  hud: GameplayHudState;
  gameplay: GameplayManager;
  inventory: InventoryManager;
  onClose(): void;
}

export const Shell: React.FC<{ title: string; icon: React.ReactNode; onClose(): void; children: React.ReactNode }> = ({
  title, icon, onClose, children,
}) => (
  <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/25 pointer-events-auto font-sans" onClick={onClose}>
    <div
      className={`${sheet} rounded-3xl w-[min(94vw,520px)] max-h-[82vh] flex flex-col overflow-hidden`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 px-5 py-3 border-b border-[#e9dcc3]">
        {icon}
        <h2 className="text-base font-extrabold flex-1">{title}</h2>
        <button onClick={onClose} className="w-9 h-9 rounded-xl hover:bg-[#f3e8d2] flex items-center justify-center" title={t('common.closeEsc')}>
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="overflow-y-auto p-4 flex flex-col gap-2">{children}</div>
    </div>
  </div>
);

export const ShopPanel: React.FC<PanelProps> = ({ gameplay, inventory, onClose }) => {
  useInventoryTick(inventory);
  const [tab, setTab] = useState<'sell' | 'buy'>('sell');
  const items = inventory.getItems();
  const sellable = items.filter((i) => i.sellPrice && i.count > 0);
  const buyable = items.filter((i) => i.buyPrice);
  const coins = inventory.getItemCount('coins');
  return (
    <Shell title={t('shop.title')} icon={<Store className="w-5 h-5 text-sky-600" />} onClose={onClose}>
      <div className="flex items-center gap-2 mb-1">
        {(['sell', 'buy'] as const).map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-1.5 rounded-xl text-sm font-bold ${tab === id ? 'bg-[#4a3b2a] text-white' : 'bg-[#f3e8d2]'}`}
          >
            {id === 'sell' ? t('shop.sell') : t('shop.buy')}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 text-sm font-bold">
          <Coins className="w-4 h-4 text-yellow-500" /> {coins}
        </span>
      </div>
      {tab === 'sell' && sellable.length === 0 && (
        <div className="text-sm text-[#8a7556] text-center py-6">{t('shop.empty')}</div>
      )}
      {(tab === 'sell' ? sellable : buyable).map((item) => (
        <div key={item.id} className="rounded-2xl bg-white/80 border border-[#efe4cf] p-2.5 flex items-center gap-3">
          <span className="text-xl">{getItemEmoji(item)}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold truncate">{dataName('item', item.id, item.name)}</div>
            <div className="text-[11px] text-[#8a7556]">
              {t('shop.priceLine', { price: (tab === 'sell' ? item.sellPrice : item.buyPrice) ?? 0, n: item.count })}
            </div>
          </div>
          {tab === 'sell' ? (
            <>
              <button onClick={() => gameplay.sell(item.id, 1)} className="px-3 py-1.5 rounded-xl text-sm font-bold bg-[#f3e8d2] active:scale-95">
                1
              </button>
              <button onClick={() => gameplay.sell(item.id, item.count)} className="px-3 py-1.5 rounded-xl text-sm font-bold bg-amber-500 text-white active:scale-95">
                {t('shop.all')}
              </button>
            </>
          ) : (
            <>
              <button
                disabled={coins < item.buyPrice!}
                onClick={() => gameplay.buy(item.id, 1)}
                className="px-3 py-1.5 rounded-xl text-sm font-bold bg-sky-500 text-white disabled:bg-[#e9dcc3] active:scale-95"
              >
                +1
              </button>
              <button
                disabled={coins < item.buyPrice! * 5}
                onClick={() => gameplay.buy(item.id, 5)}
                className="px-3 py-1.5 rounded-xl text-sm font-bold bg-sky-600 text-white disabled:bg-[#e9dcc3] active:scale-95"
              >
                +5
              </button>
            </>
          )}
        </div>
      ))}
    </Shell>
  );
};
