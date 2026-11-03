import React, { useEffect, useState } from 'react';
import { X, Coins, ChefHat, Store } from 'lucide-react';
import { GameplayManager, GameplayHudState } from '../../gameplay/GameplayManager';
import { RECIPES, DISH_BUFF } from '../../gameplay/Recipes';
import { InventoryManager } from '../../inventory/InventoryManager';
import { getItemEmoji } from '../../inventory/types/InventoryTypes';

const sheet = 'bg-[#fffaf0] text-[#4a3b2a] border border-[#e9dcc3] shadow-[0_12px_40px_rgba(60,40,10,0.3)]';

function useInventoryTick(inventory: InventoryManager): number {
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

const Shell: React.FC<{ title: string; icon: React.ReactNode; onClose(): void; children: React.ReactNode }> = ({
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
        <button onClick={onClose} className="w-9 h-9 rounded-xl hover:bg-[#f3e8d2] flex items-center justify-center" title="Закрити (Esc)">
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="overflow-y-auto p-4 flex flex-col gap-2">{children}</div>
    </div>
  </div>
);

export const CookingPanel: React.FC<PanelProps> = ({ hud, gameplay, inventory, onClose }) => {
  useInventoryTick(inventory);
  const dishes = inventory.getItems().filter((i) => i.id.startsWith('dish_') && i.count > 0);
  return (
    <Shell title="Багаття — готування" icon={<ChefHat className="w-5 h-5 text-orange-600" />} onClose={onClose}>
      {hud.cooking && (
        <div className="rounded-2xl bg-orange-50 border border-orange-200 p-3">
          <div className="text-sm font-semibold mb-1.5">
            Готується: {RECIPES.find((r) => r.id === hud.cooking!.recipeId)?.name}
          </div>
          <div className="h-2.5 rounded-full bg-orange-100 overflow-hidden">
            <div className="h-full bg-orange-400 transition-[width] duration-300" style={{ width: `${hud.cooking.progress * 100}%` }} />
          </div>
        </div>
      )}
      {RECIPES.map((r) => {
        const ok = gameplay.canCook(r);
        const dish = inventory.getItem(r.dishId);
        return (
          <div key={r.id} className="rounded-2xl bg-white/80 border border-[#efe4cf] p-3 flex items-center gap-3">
            <span className="text-2xl">{getItemEmoji(dish)}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold">{r.name}</div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {r.ingredients.map((ing) => {
                  const have = gameplay.countIngredient(ing.itemId);
                  const name = ing.itemId === 'fish_any' ? 'Риба' : inventory.getItem(ing.itemId)?.name ?? ing.itemId;
                  return (
                    <span
                      key={ing.itemId}
                      className={`text-[11px] px-2 py-0.5 rounded-full ${
                        have >= ing.count ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-700'
                      }`}
                    >
                      {name} {have}/{ing.count}
                    </span>
                  );
                })}
              </div>
            </div>
            <button
              disabled={!ok}
              onClick={() => gameplay.cook(r.id)}
              className="px-4 py-2 rounded-xl text-sm font-bold bg-orange-500 text-white disabled:bg-[#e9dcc3] disabled:text-[#a08a68] active:scale-95 transition"
            >
              Готувати
            </button>
          </div>
        );
      })}
      {dishes.length > 0 && (
        <>
          <div className="text-xs font-bold text-[#8a7556] mt-2">Ваші страви — з'їжте для прискорення</div>
          {dishes.map((d) => (
            <div key={d.id} className="rounded-2xl bg-white/80 border border-[#efe4cf] p-2.5 flex items-center gap-3">
              <span className="text-xl">{getItemEmoji(d)}</span>
              <span className="flex-1 text-sm font-semibold">
                {d.name} ×{d.count}
                <span className="text-[11px] text-[#8a7556] ml-2">
                  +{Math.round((DISH_BUFF[d.id].speed - 1) * 100)}% швидкості, {DISH_BUFF[d.id].seconds}с
                </span>
              </span>
              <button onClick={() => gameplay.eat(d.id)} className="px-3 py-1.5 rounded-xl text-sm font-bold bg-emerald-500 text-white active:scale-95">
                З'їсти
              </button>
            </div>
          ))}
        </>
      )}
    </Shell>
  );
};

export const ShopPanel: React.FC<PanelProps> = ({ gameplay, inventory, onClose }) => {
  useInventoryTick(inventory);
  const [tab, setTab] = useState<'sell' | 'buy'>('sell');
  const items = inventory.getItems();
  const sellable = items.filter((i) => i.sellPrice && i.count > 0);
  const buyable = items.filter((i) => i.buyPrice);
  const coins = inventory.getItemCount('coins');
  return (
    <Shell title="Поштова скринька — магазин" icon={<Store className="w-5 h-5 text-sky-600" />} onClose={onClose}>
      <div className="flex items-center gap-2 mb-1">
        {(['sell', 'buy'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-xl text-sm font-bold ${tab === t ? 'bg-[#4a3b2a] text-white' : 'bg-[#f3e8d2]'}`}
          >
            {t === 'sell' ? 'Продати' : 'Купити'}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 text-sm font-bold">
          <Coins className="w-4 h-4 text-yellow-500" /> {coins}
        </span>
      </div>
      {tab === 'sell' && sellable.length === 0 && (
        <div className="text-sm text-[#8a7556] text-center py-6">Немає що продати. Зберіть урожай, наловіть риби або приготуйте страву!</div>
      )}
      {(tab === 'sell' ? sellable : buyable).map((item) => (
        <div key={item.id} className="rounded-2xl bg-white/80 border border-[#efe4cf] p-2.5 flex items-center gap-3">
          <span className="text-xl">{getItemEmoji(item)}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold truncate">{item.name}</div>
            <div className="text-[11px] text-[#8a7556]">
              {tab === 'sell' ? `${item.sellPrice} 💰 · є ${item.count}` : `${item.buyPrice} 💰 · є ${item.count}`}
            </div>
          </div>
          {tab === 'sell' ? (
            <>
              <button onClick={() => gameplay.sell(item.id, 1)} className="px-3 py-1.5 rounded-xl text-sm font-bold bg-[#f3e8d2] active:scale-95">
                1
              </button>
              <button onClick={() => gameplay.sell(item.id, item.count)} className="px-3 py-1.5 rounded-xl text-sm font-bold bg-amber-500 text-white active:scale-95">
                Усе
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
