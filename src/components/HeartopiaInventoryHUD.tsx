import React, { useEffect, useRef, useState } from 'react';
import {
  InventoryManager,
  HOTBAR_SIZE,
  BACKPACK_COLUMNS,
  BACKPACK_MAX_SLOTS,
} from '../inventory/InventoryManager';
import { InventoryItem } from '../inventory/types/InventoryTypes';
import { X, Lock } from 'lucide-react';
import { t, useLang, dataName, itemDesc } from '../i18n/i18n';
import { ItemIcon } from './ItemIcon';

interface HeartopiaInventoryHUDProps {
  inventoryManager: InventoryManager;
  isOpen: boolean;
  onClose: () => void;
  onEquipItem: (itemId: string | null) => void;
}

/** What is being dragged: an item id and where it was picked up. */
interface DragPayload {
  id: string;
  from: 'grid' | 'hotbar';
}
/** Pointer travel (px) before a press turns into a drag. */
const DRAG_THRESHOLD = 6;

/** Drop target under the pointer: a hotbar slot index, the backpack grid, or nothing. */
const targetAt = (x: number, y: number): number | 'grid' | null => {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const slot = el?.closest<HTMLElement>('[data-hotbar-slot]');
  if (slot) return Number(slot.dataset.hotbarSlot);
  return el?.closest('[data-backpack-grid]') ? 'grid' : null;
};

const CELL = 'relative w-16 h-16 rounded-2xl flex flex-col items-center justify-center p-1.5 transition-all border-2';

export const HeartopiaInventoryHUD: React.FC<HeartopiaInventoryHUDProps> = ({
  inventoryManager,
  isOpen,
  onClose,
  onEquipItem,
}) => {
  const [state, setState] = useState(() => inventoryManager.getState());
  const [dropTarget, setDropTarget] = useState<number | 'grid' | null>(null);
  const [drag, setDrag] = useState<{ item: InventoryItem; x: number; y: number } | null>(null);
  const press = useRef<{ payload: DragPayload; item: InventoryItem; x: number; y: number; dragging: boolean } | null>(null);
  /** Set when a drag just ended so the click that follows pointerup is ignored. */
  const suppressClick = useRef(false);
  useEffect(() => inventoryManager.subscribe((s) => setState({ ...s })), [inventoryManager]);

  // Pointer-driven drag and drop (works with mouse and touch alike)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
      p.dragging = true;
      setDrag({ item: p.item, x: e.clientX, y: e.clientY });
      setDropTarget(targetAt(e.clientX, e.clientY));
    };
    const onUp = (e: PointerEvent) => {
      const p = press.current;
      press.current = null;
      if (!p?.dragging) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      setDrag(null);
      setDropTarget(null);
      const target = targetAt(e.clientX, e.clientY);
      if (typeof target === 'number') inventoryManager.setHotbarSlot(target, p.payload.id);
      else if (target === 'grid' && p.payload.from === 'hotbar') inventoryManager.removeFromHotbar(p.payload.id);
    };
    const onCancel = () => {
      press.current = null;
      setDrag(null);
      setDropTarget(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [inventoryManager]);
  useLang();

  if (!isOpen) return null;

  const equippedId = state.equippedItemId;
  const gridItems = inventoryManager.getBackpackItems();
  // Never hide owned items, even past the current capacity
  const activeSlots = Math.min(BACKPACK_MAX_SLOTS, Math.max(state.capacity, gridItems.length));
  const hotbarItems = state.hotbar.map((id) =>
    id ? state.items.find((i) => i.id === id && i.count > 0) ?? null : null,
  );

  const toggleEquip = (item: InventoryItem) => {
    if (!item.isEquippable) return;
    if (equippedId === item.id) {
      inventoryManager.unequip();
      onEquipItem(null);
    } else {
      inventoryManager.equipItem(item.id);
      onEquipItem(item.id);
    }
  };

  const startPress = (e: React.PointerEvent, item: InventoryItem, from: DragPayload['from']) => {
    if (e.button !== 0) return;
    e.preventDefault();
    press.current = { payload: { id: item.id, from }, item, x: e.clientX, y: e.clientY, dragging: false };
  };

  const tooltip = (item: InventoryItem) =>
    `${dataName('item', item.id, item.name)}\n${itemDesc(item.id, item.description)}`;

  const renderItem = (item: InventoryItem) => (
    <>
      <div className="text-4xl filter drop-shadow-sm pointer-events-none">
        <ItemIcon item={item} />
      </div>
      {item.count > 1 && (
        <div
          className="absolute bottom-0.5 right-1.5 text-sm font-black leading-none text-white pointer-events-none"
          style={{
            WebkitTextStroke: '3px #000',
            paintOrder: 'stroke fill',
          }}
        >
          {item.count}
        </div>
      )}
    </>
  );

  const itemCellClass = (item: InventoryItem) =>
    equippedId === item.id
      ? 'bg-amber-100 border-amber-500 ring-2 ring-amber-400 shadow-md'
      : 'bg-[#faf5ee] border-[#dbcbb8] hover:border-amber-400 hover:bg-white';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 pointer-events-auto select-none animate-fadeIn font-sans"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="relative max-w-[95vw] bg-gradient-to-b from-[#fbf8f2] to-[#f4ebe1] rounded-3xl border-4 border-[#e2d5c3] shadow-2xl overflow-hidden text-amber-950">
        {/* Header */}
        <div className="px-6 py-3 bg-gradient-to-r from-[#e8dbcc] via-[#efe4d7] to-[#e8dbcc] border-b-2 border-[#dbcbb8] flex items-center justify-between">
          <h2 className="text-xl font-bold tracking-wide text-amber-950">{t('inv.title')}</h2>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-red-500 hover:bg-red-600 border border-red-700 shadow-md flex items-center justify-center transition-all duration-150 active:scale-95 cursor-pointer"
            title={t('inv.closeTitle')}
          >
            <X className="w-5 h-5 text-white stroke-[3]" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4 overflow-x-auto">
          {/* Backpack grid: drop a hotbar item here to put it back */}
          <div
            className={`bg-[#f2e7da] rounded-2xl p-3 border shadow-inner transition-colors ${
              dropTarget === 'grid' ? 'border-amber-500 bg-[#f6ecdf]' : 'border-[#ded0c0]'
            }`}
            data-backpack-grid
          >
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${BACKPACK_COLUMNS}, 4rem)` }}>
              {Array.from({ length: BACKPACK_MAX_SLOTS }).map((_, idx) => {
                const item = gridItems[idx];
                if (idx >= activeSlots) {
                  return (
                    <div key={idx} className={`${CELL} bg-[#e2d6c7]/50 border-[#d8c8b4]/60`}>
                      <Lock className="w-4 h-4 text-amber-900/20" />
                    </div>
                  );
                }
                if (!item) {
                  return <div key={idx} className={`${CELL} bg-[#e9ded0]/40 border-dashed border-[#d8c8b4]`} />;
                }
                return (
                  <div
                    key={item.id}
                    onPointerDown={(e) => startPress(e, item, 'grid')}
                    onDoubleClick={() => {
                      // Only hotbar items are held: double click moves it there first, then equips
                      if (item.isEquippable && inventoryManager.addToHotbar(item.id)) toggleEquip(item);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      inventoryManager.addToHotbar(item.id);
                    }}
                    title={tooltip(item)}
                    style={drag?.item.id === item.id ? { opacity: 0.35 } : undefined}
                    className={`${CELL} cursor-grab touch-none ${itemCellClass(item)}`}
                  >
                    {renderItem(item)}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Hotbar: drag items in, right click sends one back to the backpack */}
          <div className="bg-[#ebdccf] rounded-2xl p-3 border-2 border-[#d8c7b4] shadow-sm">
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${HOTBAR_SIZE}, 4rem)` }}>
              {hotbarItems.map((item, idx) => {
                const isTarget = dropTarget === idx;
                return (
                  <div
                    key={idx}
                    data-hotbar-slot={idx}
                    onPointerDown={(e) => item && startPress(e, item, 'hotbar')}
                    onClick={() => item && !suppressClick.current && toggleEquip(item)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (item) inventoryManager.removeFromHotbar(item.id);
                    }}
                    title={item ? tooltip(item) : undefined}
                    className={`${CELL} ${
                      isTarget
                        ? 'bg-amber-50 border-amber-500 ring-2 ring-amber-300'
                        : item
                        ? `cursor-pointer touch-none ${itemCellClass(item)}`
                        : 'bg-[#e9ded0]/50 border-dashed border-[#cdbba5]'
                    }`}
                  >
                    <span className="absolute top-0.5 left-1.5 text-[9px] font-bold text-[#a08a68] pointer-events-none">
                      {idx + 1}
                    </span>
                    {item && renderItem(item)}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Item following the pointer while dragging */}
      {drag && (
        <div
          className="fixed z-[60] w-16 h-16 rounded-2xl bg-white/90 border-2 border-amber-400 shadow-xl flex items-center justify-center text-3xl pointer-events-none"
          style={{ left: drag.x - 32, top: drag.y - 32 }}
        >
          <ItemIcon item={drag.item} />
        </div>
      )}
    </div>
  );
};
