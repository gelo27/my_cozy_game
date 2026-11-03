import React, { useState, useMemo } from 'react';
import {
  Paintbrush,
  Pipette,
  Eraser,
  PaintBucket,
  Undo2,
  Redo2,
  Sparkles,
  X,
  Check,
  HelpCircle,
  Eye,
} from 'lucide-react';
import { BuildingTelemetry } from '../building/types/BuildingTypes';
import { PaintingToolMode, WALLPAPER_UI_CATALOG, WallpaperUIItem } from '../building/WallPaintingSystem';

interface HeartopiaPaintingHUDProps {
  telemetry: BuildingTelemetry;
  onTogglePaintMode: () => void;
  onSelectWallpaper: (id: string) => void;
  onSelectTool: (tool: PaintingToolMode) => void;
  onSetGridCellSize?: (size: number) => void;
  onUndo?: () => void;
  onRedo?: () => void;
}

export const HeartopiaPaintingHUD: React.FC<HeartopiaPaintingHUDProps> = ({
  telemetry,
  onTogglePaintMode,
  onSelectWallpaper,
  onSelectTool,
  onSetGridCellSize,
  onUndo,
  onRedo,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'floor' | 'ceiling' | 'wainscot' | 'interior' | 'exterior' | 'tiles' | 'wood'>('all');
  const [showGuide, setShowGuide] = useState(false);

  const activeWallpaperId = telemetry.activeWallpaperId || 'wainscot_white_wood';
  const activeTool = (telemetry.activePaintingTool as PaintingToolMode) || 'wall';
  const hoveredFace = telemetry.hoveredCellFace;
  const hoveredCoords = telemetry.hoveredCellCoords;
  const hoveredWallpaper = telemetry.hoveredCellWallpaperName;
  const customizedCount = telemetry.customizedCellsCount ?? 0;
  const fillCount = telemetry.fillPreviewCount ?? 0;

  const filteredCatalog = useMemo(() => {
    return WALLPAPER_UI_CATALOG.filter((item) => {
      if (selectedCategory === 'all') return true;
      if (selectedCategory === 'floor') return item.category === 'floor';
      if (selectedCategory === 'ceiling') return item.category === 'ceiling';
      if (selectedCategory === 'wainscot') return item.tag === 'Вайнскотінг';
      if (selectedCategory === 'interior') return item.category === 'interior';
      if (selectedCategory === 'exterior') return item.category === 'exterior';
      if (selectedCategory === 'tiles') return item.tag === 'Плитка';
      if (selectedCategory === 'wood') return item.tag === 'Дерево' || item.category === 'floor';
      return true;
    });
  }, [selectedCategory]);

  const activeDef = useMemo(() => {
    return WALLPAPER_UI_CATALOG.find((w) => w.id === activeWallpaperId) || WALLPAPER_UI_CATALOG[0];
  }, [activeWallpaperId]);

  return (
    <div className="pointer-events-none absolute inset-0 select-none overflow-hidden font-sans z-30">
      {/* 1. Top Bar: Mode Indicator, Side Banner & Close Button */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-auto flex items-center gap-3">
        <div className="flex items-center gap-2.5 px-4 py-2 rounded-xl text-sm font-semibold tracking-wide bg-gradient-to-r from-pink-600/90 via-rose-600/90 to-amber-600/90 text-white shadow-xl shadow-pink-950/40 border border-pink-300/40 ring-2 ring-pink-400/30">
          <Paintbrush className="w-4 h-4 animate-pulse text-pink-200" />
          <span>Розфарбовування Heartopia (Стіни, Підлога, Стеля)</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-black/40 border border-white/20 text-pink-200 font-mono">
            [P]
          </span>
        </div>

        {/* Customization Counter Badge */}
        <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-stone-900/90 border border-stone-700/70 text-xs text-stone-200 shadow-md">
          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          <span>
            Кастомізовано: <strong className="text-pink-400 font-mono font-bold">{customizedCount}</strong> поверхонь
          </span>
        </div>

        {/* Guide toggle button */}
        <button
          id="btn-paint-guide-toggle"
          onClick={() => setShowGuide((prev) => !prev)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-stone-900/85 hover:bg-stone-800 border border-stone-700 text-xs text-stone-300 shadow transition-all"
          title="Як працює незалежне фарбування поверхонь з обох боків"
        >
          <HelpCircle className="w-3.5 h-3.5 text-sky-400" />
          <span className="hidden md:inline">Підказка</span>
        </button>

        {/* Exit Paint Mode Button */}
        <button
          id="btn-exit-paint-mode"
          onClick={onTogglePaintMode}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-stone-850/90 hover:bg-rose-950/90 text-stone-300 hover:text-rose-200 border border-stone-700 hover:border-rose-500/50 shadow transition-all"
          title="Вийти з режиму фарбування [Esc / P]"
        >
          <X className="w-4 h-4 text-rose-400" />
          <span>Закрити [Esc]</span>
        </button>
      </div>

      {/* 2. Top-Center Dynamic Surface Inspector Pill */}
      <div className="absolute top-18 left-1/2 -translate-x-1/2 pointer-events-none flex flex-col items-center gap-1">
        {hoveredFace ? (
          <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-stone-900/95 border border-pink-500/60 shadow-lg shadow-pink-950/40 text-xs text-stone-200 animate-in fade-in duration-150">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                hoveredFace.includes('Підлога')
                  ? 'bg-emerald-400 ring-2 ring-emerald-400/40'
                  : hoveredFace.includes('Стеля')
                  ? 'bg-purple-400 ring-2 ring-purple-400/40'
                  : hoveredFace.includes('Зовнішн')
                  ? 'bg-amber-400 ring-2 ring-amber-400/40'
                  : 'bg-pink-400 ring-2 ring-pink-400/40'
              }`}
            />
            <span className="font-bold text-white">{hoveredFace}</span>
            {hoveredCoords && (
              <>
                <span className="text-stone-500">|</span>
                <span className="text-stone-300 font-mono text-[11px]">{hoveredCoords}</span>
              </>
            )}
            <span className="text-stone-500">|</span>
            <span className="text-pink-300 font-medium">Поточне: {hoveredWallpaper}</span>
            {activeTool === 'fill' && fillCount > 0 && (
              <>
                <span className="text-stone-500">|</span>
                <span className="text-sky-300 font-semibold">Заливка: {fillCount} поверхонь</span>
              </>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3.5 py-1 rounded-full bg-stone-950/70 border border-stone-800 text-[11px] text-stone-400">
            <Eye className="w-3.5 h-3.5 text-stone-500" />
            <span>Наведіть курсор на стіну, підлогу або стелю для розфарбовування</span>
          </div>
        )}
      </div>

      {/* 3. Modal Help Guide (if toggled) */}
      {showGuide && (
        <div className="absolute top-28 left-1/2 -translate-x-1/2 pointer-events-auto w-full max-w-md p-4 rounded-2xl bg-stone-900/95 border border-pink-500/40 shadow-2xl text-xs text-stone-200 z-40">
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-bold text-pink-300 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-pink-400" />
              Механіка фарбування поверхонь Heartopia
            </h4>
            <button
              onClick={() => setShowGuide(false)}
              className="p-1 rounded-lg hover:bg-stone-800 text-stone-400 hover:text-stone-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <ul className="space-y-1.5 text-stone-300 text-[11.5px] leading-relaxed list-disc list-inside">
            <li>
              <strong className="text-amber-300">Фарбування всієї поверхні:</strong> Обирайте будь-який матеріал і клікайте — фарбується вся стіна, підлога чи стеля в один клік без поділу на клітинки чи стовпчики.
            </li>
            <li>
              <strong className="text-amber-300">Двостороннє фарбування:</strong> Стіни мають <em>Зовнішній фасад</em> та <em>Внутрішній інтер'єр</em>, а підлоги/перекриття мають <em>Верх (Підлога)</em> та <em>Низ (Стеля)</em>. Вони розфарбовуються абсолютно незалежно!
            </li>
            <li>
              <strong className="text-emerald-300">Підлоги та Паркет:</strong> Текстури дерева (ялинка, горіх, світла сосна), мармур, теракота, килими та мозаїка.
            </li>
            <li>
              <strong className="text-purple-300">Стелі та Балки:</strong> Кесонні стелі (білі/темні), рустикальні дерев'яні балки, вапняні рейки, зоряне небо та вікторіанська ліпнина.
            </li>
            <li>
              <strong className="text-sky-300">Пензель [1]:</strong> Затисніть ЛКМ і ведіть курсором — фарбується кожна поверхня під ним. Весь мазок скасовується одним Ctrl+Z.
            </li>
            <li>
              <strong className="text-sky-300">Заливка [2]:</strong> Фарбує всі зʼєднані поверхні з такою ж текстурою: усі внутрішні стіни кімнати, увесь фасад або всю підлогу кімнати. Підсвітка показує, що саме буде пофарбовано.
            </li>
            <li>
              <strong className="text-pink-300">Піпетка [3]:</strong> Клікніть на пофарбовану поверхню — її текстура стане активною, і інструмент повернеться до пензля.
            </li>
            <li>
              <strong className="text-rose-300">Стерти [4]:</strong> Повертає стандартну текстуру.
            </li>
            <li>
              <strong className="text-amber-300">Скасувати / Повторити:</strong> Ctrl+Z / Ctrl+Y (або Ctrl+Shift+Z).
            </li>
          </ul>
        </div>
      )}

      {/* 4. Bottom Heartopia Wallpaper Catalog & Tools Bar */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-auto flex flex-col items-center gap-2 w-full max-w-4xl px-3">
        {/* Top Control Bar: Tool Switcher & Active Swatch Preview */}
        <div className="flex flex-wrap items-center justify-center gap-2 w-full">
          {/* Painting Tools Pill Group */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-stone-900/90 border border-stone-700/80 shadow-lg">
            {(
              [
                { tool: 'wall', key: '1', label: 'Пензель', Icon: Paintbrush, active: 'bg-pink-600 shadow-pink-900/40 ring-pink-300', title: 'Фарбувати поверхню; затисніть ЛКМ, щоб фарбувати кілька поспіль' },
                { tool: 'fill', key: '2', label: 'Заливка', Icon: PaintBucket, active: 'bg-violet-600 shadow-violet-900/40 ring-violet-300', title: 'Залити всі зʼєднані поверхні з такою ж текстурою (кімната, фасад, підлога)' },
                { tool: 'picker', key: '3', label: 'Піпетка', Icon: Pipette, active: 'bg-sky-600 shadow-sky-900/40 ring-sky-300', title: 'Взяти текстуру з поверхні' },
                { tool: 'eraser', key: '4', label: 'Стерти', Icon: Eraser, active: 'bg-rose-700 shadow-rose-950/40 ring-rose-300', title: 'Повернути стандартну текстуру' },
              ] as const
            ).map(({ tool, key, label, Icon, active, title }) => (
              <button
                key={tool}
                id={`tool-paint-${tool}`}
                onClick={() => onSelectTool(tool)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  activeTool === tool
                    ? `${active} text-white shadow-md ring-1`
                    : 'text-stone-300 hover:bg-stone-800 hover:text-white'
                }`}
                title={`${title} [${key}]`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
                <span className="text-[9px] font-mono opacity-60">{key}</span>
              </button>
            ))}
          </div>

          {/* Undo / Redo */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-stone-900/90 border border-stone-700/80 shadow-lg">
            <button
              id="tool-paint-undo"
              onClick={onUndo}
              disabled={!telemetry.canUndoPaint}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-stone-300 hover:bg-stone-800 hover:text-white disabled:opacity-35 disabled:pointer-events-none transition-all"
              title="Скасувати [Ctrl+Z]"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              id="tool-paint-redo"
              onClick={onRedo}
              disabled={!telemetry.canRedoPaint}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-stone-300 hover:bg-stone-800 hover:text-white disabled:opacity-35 disabled:pointer-events-none transition-all"
              title="Повторити [Ctrl+Y]"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Active Wallpaper preview badge */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-stone-900/90 border border-stone-700/80 text-xs text-stone-200 shadow-lg">
            <span
              className="w-4 h-4 rounded-md border border-white/40 shadow-inner overflow-hidden relative flex-shrink-0"
              style={{ backgroundColor: activeDef.previewColor }}
            >
              {activeDef.thumbnailUrl && (
                <img
                  src={activeDef.thumbnailUrl}
                  alt={activeDef.ukrainianName}
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              )}
            </span>
            <span className="font-semibold text-white">{activeDef.ukrainianName}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-800 text-stone-400 font-mono">
              {activeDef.tag}
            </span>
          </div>
        </div>

        {/* Wallpaper Swatches Drawer Container */}
        <div className="w-full rounded-2xl bg-stone-950/90 border border-stone-750/80 shadow-2xl p-3 flex flex-col gap-2">
          {/* Category Tabs */}
          <div className="flex items-center justify-between gap-1 border-b border-stone-800 pb-2 overflow-x-auto">
            <div className="flex items-center gap-1.5">
              {[
                { id: 'all', label: 'Всі' },
                { id: 'floor', label: '🌲 Підлога' },
                { id: 'ceiling', label: '🏛️ Стеля' },
                { id: 'wainscot', label: '🌲 Вайнскотінг' },
                { id: 'interior', label: '🏠 Інтер’єр' },
                { id: 'exterior', label: '🧱 Фасад' },
                { id: 'tiles', label: '🔲 Плитка' },
                { id: 'wood', label: '🌲 Дерево' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setSelectedCategory(tab.id as any)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                    selectedCategory === tab.id
                      ? 'bg-pink-600/90 text-white shadow-sm ring-1 ring-pink-400/40'
                      : 'text-stone-400 hover:text-stone-200 hover:bg-stone-800/60'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="text-[11px] text-stone-400 hidden sm:block whitespace-nowrap">
              Клікніть для вибору • ЛКМ по стіні, підлозі або стелі для фарбування
            </div>
          </div>

          {/* Swatches Grid */}
          <div className="grid grid-cols-4 sm:grid-cols-7 md:grid-cols-8 gap-2 max-h-40 overflow-y-auto pr-1">
            {filteredCatalog.map((item: WallpaperUIItem) => {
              const isSelected = activeWallpaperId === item.id;
              return (
                <button
                  key={item.id}
                  id={`wallpaper-item-${item.id}`}
                  onClick={() => onSelectWallpaper(item.id)}
                  className={`group relative flex flex-col items-center p-1.5 rounded-xl border text-center transition-all ${
                    isSelected
                      ? 'bg-pink-950/60 border-pink-400 ring-2 ring-pink-500/50 shadow-lg shadow-pink-950/60 scale-[1.02]'
                      : 'bg-stone-900/60 hover:bg-stone-850/80 border-stone-800 hover:border-stone-600'
                  }`}
                  title={`${item.ukrainianName} — ${item.description}`}
                >
                  {/* Swatch Color & Thumbnail Preview */}
                  <div
                    className="w-full aspect-square rounded-lg border border-white/10 shadow-inner flex items-center justify-center relative overflow-hidden transition-transform group-hover:scale-105"
                    style={{ backgroundColor: item.previewColor }}
                  >
                    {item.thumbnailUrl && (
                      <img
                        src={item.thumbnailUrl}
                        alt={item.ukrainianName}
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    )}
                    {isSelected && (
                      <div className="absolute inset-0 bg-pink-500/25-[1px] flex items-center justify-center">
                        <Check className="w-5 h-5 text-white drop-shadow-md" />
                      </div>
                    )}
                  </div>

                  {/* Title & Tag */}
                  <div className="w-full mt-1.5">
                    <div className="text-[11px] font-semibold text-stone-200 truncate leading-tight">
                      {item.ukrainianName}
                    </div>
                    <div className="text-[9px] text-stone-400 truncate mt-0.5">{item.tag}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
