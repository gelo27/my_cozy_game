import React, { useState } from 'react';
import { InventoryManager } from '../inventory/InventoryManager';
import { InventoryItem, InventoryCategory, getItemEmoji } from '../inventory/types/InventoryTypes';
import { X, Sparkles, Check, Droplets, Sprout, Package, Trees, Info } from 'lucide-react';

interface HeartopiaInventoryHUDProps {
  inventoryManager: InventoryManager;
  isOpen: boolean;
  onClose: () => void;
  onEquipItem: (itemId: string | null) => void;
}

export const HeartopiaInventoryHUD: React.FC<HeartopiaInventoryHUDProps> = ({
  inventoryManager,
  isOpen,
  onClose,
  onEquipItem,
}) => {
  const [activeCategory, setActiveCategory] = useState<InventoryCategory>('all');
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);

  if (!isOpen) return null;

  const state = inventoryManager.getState();
  const equippedId = state.equippedItemId;

  const filteredItems = activeCategory === 'all'
    ? state.items
    : state.items.filter((it) => it.category === activeCategory);

  const handleSelectSlot = (item: InventoryItem) => {
    setSelectedItem(item);
  };

  const handleToggleEquip = (item: InventoryItem) => {
    if (equippedId === item.id) {
      inventoryManager.unequip();
      onEquipItem(null);
    } else {
      inventoryManager.equipItem(item.id);
      onEquipItem(item.id);
    }
  };

  const getItemCategoryIcon = (cat: InventoryItem['category']) => {
    switch (cat) {
      case 'tools':
        return <Droplets className="w-4 h-4 text-sky-400" />;
      case 'seeds':
        return <Sprout className="w-4 h-4 text-emerald-400" />;
      case 'crops':
        return <Package className="w-4 h-4 text-amber-400" />;
      case 'materials':
        return <Trees className="w-4 h-4 text-amber-700" />;
      default:
        return <Sparkles className="w-4 h-4 text-purple-400" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 pointer-events-auto select-none animate-fadeIn font-sans">
      {/* Heartopia Cozy Pastel Modal Window */}
      <div className="relative w-[700px] max-w-[95vw] bg-gradient-to-b from-[#fbf8f2] to-[#f4ebe1] rounded-3xl border-4 border-[#e2d5c3] shadow-2xl overflow-hidden text-amber-950">
        {/* Header Bar */}
        <div className="px-6 py-4 bg-gradient-to-r from-[#e8dbcc] via-[#efe4d7] to-[#e8dbcc] border-b-2 border-[#dbcbb8] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shadow-inner">
              <Sparkles className="w-5 h-5 text-amber-700" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold tracking-wide text-amber-950">
                  Рюкзак Heartopia
                </h2>
                <span className="px-2 py-0.5 text-xs font-semibold bg-amber-200/70 text-amber-800 rounded-full border border-amber-300">
                  Клавіша [Q]
                </span>
              </div>
              <p className="text-xs text-amber-800/80">
                Вибирайте лійку, насіння пшениці, моркви, помідорів та оглядайте зібрані ящики
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-amber-200/60 hover:bg-amber-300 border border-amber-300/80 flex items-center justify-center transition-all duration-150 active:scale-95 cursor-pointer"
            title="Закрити (Q або Esc)"
          >
            <X className="w-5 h-5 text-amber-900" />
          </button>
        </div>

        {/* Category Filters */}
        <div className="flex items-center gap-2 px-6 pt-3 pb-1 border-b border-[#e8ded0]">
          <button
            onClick={() => setActiveCategory('all')}
            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${
              activeCategory === 'all'
                ? 'bg-amber-600 text-white shadow-md'
                : 'bg-amber-200/50 hover:bg-amber-200/80 text-amber-900'
            }`}
          >
            Усі предмети
          </button>
          <button
            onClick={() => setActiveCategory('tools')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${
              activeCategory === 'tools'
                ? 'bg-sky-600 text-white shadow-md'
                : 'bg-amber-200/50 hover:bg-amber-200/80 text-amber-900'
            }`}
          >
            <Droplets className="w-3.5 h-3.5" />
            Інструменти
          </button>
          <button
            onClick={() => setActiveCategory('seeds')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${
              activeCategory === 'seeds'
                ? 'bg-emerald-600 text-white shadow-md'
                : 'bg-amber-200/50 hover:bg-amber-200/80 text-amber-900'
            }`}
          >
            <Sprout className="w-3.5 h-3.5" />
            Насіння
          </button>
          <button
            onClick={() => setActiveCategory('crops')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${
              activeCategory === 'crops'
                ? 'bg-amber-700 text-white shadow-md'
                : 'bg-amber-200/50 hover:bg-amber-200/80 text-amber-900'
            }`}
          >
            <Package className="w-3.5 h-3.5" />
            Ящики врожаю
          </button>
          <button
            onClick={() => setActiveCategory('materials')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${
              activeCategory === 'materials'
                ? 'bg-amber-800 text-white shadow-md'
                : 'bg-amber-200/50 hover:bg-amber-200/80 text-amber-900'
            }`}
          >
            <Trees className="w-3.5 h-3.5" />
            Матеріали
          </button>
        </div>

        {/* Content Body: Grid & Details Panel */}
        <div className="grid grid-cols-12 gap-4 p-6 min-h-[340px]">
          {/* Item Grid */}
          <div className="col-span-7 bg-[#f2e7da] rounded-2xl p-3 border border-[#ded0c0] shadow-inner overflow-y-auto max-h-[360px]">
            <div className="grid grid-cols-4 gap-2.5">
              {Array.from({ length: 16 }).map((_, idx) => {
                const item = filteredItems[idx];
                const isEquipped = item && equippedId === item.id;
                const isSelected = item && selectedItem?.id === item.id;

                return (
                  <div
                    key={idx}
                    onClick={() => item && handleSelectSlot(item)}
                    onDoubleClick={() => item && handleToggleEquip(item)}
                    className={`relative aspect-square rounded-2xl flex flex-col items-center justify-center p-2 cursor-pointer transition-all border-2 ${
                      item
                        ? isEquipped
                          ? 'bg-amber-100 border-amber-500 ring-2 ring-amber-400 shadow-md scale-95'
                          : isSelected
                          ? 'bg-white border-amber-400 shadow-md'
                          : 'bg-[#faf5ee] border-[#dbcbb8] hover:border-amber-400 hover:bg-white'
                        : 'bg-[#e9ded0]/40 border-dashed border-[#d8c8b4] cursor-default'
                    }`}
                  >
                    {item ? (
                      <>
                        <div className="text-3xl filter drop-shadow-sm transition-transform hover:scale-110">
                          {getItemEmoji(item)}
                        </div>
                        <span className="text-[10px] font-bold text-center line-clamp-1 mt-1 text-amber-900">
                          {item.name}
                        </span>

                        {/* Quantity Badge */}
                        {item.count > 1 && (
                          <div className="absolute top-1 right-1.5 px-1.5 py-0.2 bg-amber-900 text-amber-100 text-[10px] font-black rounded-full shadow-sm">
                            {item.count}
                          </div>
                        )}

                        {/* Equipped Tag */}
                        {isEquipped && (
                          <div className="absolute -bottom-1 bg-amber-600 text-white text-[9px] font-extrabold px-1.5 py-0.2 rounded-md shadow flex items-center gap-0.5">
                            <Check className="w-2.5 h-2.5 stroke-[3]" /> В руці
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-[11px] text-amber-800/30 font-bold">{idx + 1}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Details Sidebar */}
          <div className="col-span-5 bg-gradient-to-b from-[#f5ede3] to-[#ebdccf] rounded-2xl p-4 border border-[#dbcab7] flex flex-col justify-between shadow-sm">
            {selectedItem ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-14 h-14 rounded-2xl bg-white border-2 border-[#dbcbb8] flex items-center justify-center text-4xl shadow-sm">
                    {getItemEmoji(selectedItem)}
                  </div>
                  <div>
                    <h3 className="font-extrabold text-base text-amber-950">
                      {selectedItem.name}
                    </h3>
                    <div className="flex items-center gap-1 mt-0.5">
                      {getItemCategoryIcon(selectedItem.category)}
                      <span className="text-xs font-semibold text-amber-800">
                        {selectedItem.category === 'tools' && (selectedItem.id === 'watering_can' ? 'Інструмент для поливу' : 'Інструмент для збору ресурсів')}
                        {selectedItem.category === 'seeds' && 'Насіння для посадки'}
                        {selectedItem.category === 'crops' && 'Ящик зібраного врожаю'}
                        {selectedItem.category === 'materials' && 'Ресурс для будівництва'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="p-3 bg-white/70 rounded-xl border border-amber-200/80 text-xs text-amber-900 leading-relaxed">
                  {selectedItem.description}
                </div>

                <div className="bg-[#ede1d3] p-2.5 rounded-xl border border-[#d8c7b4] text-[11px] space-y-1">
                  <div className="flex justify-between text-amber-800 font-semibold">
                    <span>Кількість у рюкзаку:</span>
                    <span className="font-bold text-amber-950">{selectedItem.count} шт.</span>
                  </div>
                  <div className="flex justify-between text-amber-800 font-semibold">
                    <span>Максимум у стаку:</span>
                    <span className="font-bold text-amber-950">{selectedItem.maxStack}</span>
                  </div>
                </div>

                {selectedItem.cropType && (
                  <div className="p-2 bg-emerald-50 rounded-xl border border-emerald-200 text-[11px] text-emerald-900 flex items-center gap-2">
                    <Sprout className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>Саджається на підготовлені грядки 1х1м або 2х2м [ЛКМ / E]</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center p-4 text-amber-800/60">
                <Info className="w-8 h-8 mb-2 opacity-50 text-amber-700" />
                <p className="text-xs font-semibold">
                  Оберіть предмет у рюкзаку для огляду або візьміть у руку (Лійка або Насіння)
                </p>
              </div>
            )}

            {/* Bottom Actions */}
            <div className="pt-3 border-t border-[#d8c8b6] flex gap-2">
              {selectedItem && (selectedItem.category === 'tools' || selectedItem.category === 'seeds') ? (
                <button
                  onClick={() => handleToggleEquip(selectedItem)}
                  className={`flex-1 py-2.5 px-4 rounded-xl text-xs font-extrabold transition-all shadow-md active:scale-95 flex items-center justify-center gap-2 cursor-pointer ${
                    equippedId === selectedItem.id
                      ? 'bg-amber-200 hover:bg-amber-300 text-amber-950 border border-amber-400'
                      : 'bg-amber-600 hover:bg-amber-500 text-white border border-amber-700'
                  }`}
                >
                  {equippedId === selectedItem.id ? (
                    <>
                      <X className="w-4 h-4" /> Сховати з рук
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" /> Взяти в руку
                    </>
                  )}
                </button>
              ) : selectedItem && selectedItem.category === 'crops' ? (
                <div className="flex-1 py-2 px-3 bg-amber-200/50 rounded-xl border border-amber-300/70 text-center text-xs font-bold text-amber-900">
                  📦 1 ящик з однієї грядки зібрано!
                </div>
              ) : null}

              <button
                onClick={onClose}
                className="py-2.5 px-4 bg-[#e5d6c5] hover:bg-[#dccbbb] text-amber-950 text-xs font-bold rounded-xl border border-[#cebcab] transition-all active:scale-95 cursor-pointer"
              >
                Закрити
              </button>
            </div>
          </div>
        </div>

        {/* Footer info bar */}
        <div className="px-6 py-2.5 bg-[#ebdccf] border-t border-[#dbcbb8] flex items-center justify-between text-[11px] text-amber-800">
          <div className="flex items-center gap-4">
            <span>💡 <b>Q</b> — відкрити/закрити інвентар</span>
            <span>💧 <b>Лійка</b> — поливає суху грядку (потрібно 2 поливи)</span>
            <span>🌾 <b>Ящик</b> — збирається 1 ящик з готової грядки</span>
          </div>
          <span className="font-semibold text-amber-900">Heartopia Farming Engine v1.0</span>
        </div>
      </div>
    </div>
  );
};
