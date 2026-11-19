import { t, useLang, getLang, localName, dataName } from '../i18n/i18n';
import type { TKey } from '../i18n/en';
import React, { useState, useMemo } from 'react';
import { Paintbrush, Pipette, Eraser, PaintBucket, Undo2, Redo2, X, Check, HelpCircle } from 'lucide-react';
import { BuildingTelemetry } from '../building/types/BuildingTypes';
import { PaintingToolMode, WALLPAPER_UI_CATALOG, WallpaperUIItem } from '../building/WallPaintingSystem';
import { AimStatus, Crosshair, ModeBar, PrimaryAction, Shelf, ShelfCard, ToolButton, ToolColumn, panel } from './buildui/BuildUI';

const GUIDE_KEYS = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'] as const;

type PaintCategory = 'all' | 'floor' | 'ceiling' | 'wainscot' | 'interior' | 'exterior' | 'tiles' | 'wood';

const CATEGORIES: { id: PaintCategory; label: TKey; emoji: string }[] = [
  { id: 'all', label: 'paint.cat.all', emoji: '' },
  { id: 'floor', label: 'paint.cat.floor', emoji: '🪵' },
  { id: 'ceiling', label: 'paint.cat.ceiling', emoji: '🏛️' },
  { id: 'wainscot', label: 'paint.cat.wainscot', emoji: '🌲' },
  { id: 'interior', label: 'paint.cat.interior', emoji: '🏠' },
  { id: 'exterior', label: 'paint.cat.exterior', emoji: '🧱' },
  { id: 'tiles', label: 'paint.cat.tiles', emoji: '🔲' },
  { id: 'wood', label: 'paint.cat.wood', emoji: '🌳' },
];

const TOOLS = [
  { tool: 'wall', key: '1', label: 'paint.brush', Icon: Paintbrush },
  { tool: 'fill', key: '2', label: 'paint.fill', Icon: PaintBucket },
  { tool: 'picker', key: '3', label: 'paint.picker', Icon: Pipette },
  { tool: 'eraser', key: '4', label: 'paint.eraser', Icon: Eraser },
] as const;

const FACE_DOT: Record<string, string> = {
  floor: 'bg-emerald-500',
  ceiling: 'bg-purple-500',
  outer: 'bg-amber-500',
};

interface HeartopiaPaintingHUDProps {
  telemetry: BuildingTelemetry;
  onTogglePaintMode: () => void;
  /** Leaves painting for the build mode (the Build tab) */
  onSwitchToBuild: () => void;
  onSelectWallpaper: (id: string) => void;
  onSelectTool: (tool: PaintingToolMode) => void;
  /** Paints at the crosshair (the phones' big button) */
  onApply: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
}

/** Painting walls, floors and ceilings: the build mode's frame (BuildUI) with swatches on the shelf. */
export const HeartopiaPaintingHUD: React.FC<HeartopiaPaintingHUDProps> = ({
  telemetry,
  onTogglePaintMode,
  onSwitchToBuild,
  onSelectWallpaper,
  onSelectTool,
  onApply,
  onUndo,
  onRedo,
}) => {
  useLang();
  const [category, setCategory] = useState<PaintCategory>('all');
  const [open, setOpen] = useState(true);
  const [showGuide, setShowGuide] = useState(false);

  const activeWallpaperId = telemetry.activeWallpaperId || 'wainscot_white_wood';
  const activeTool = (telemetry.activePaintingTool as PaintingToolMode) || 'wall';
  const hoveredFace = telemetry.hoveredCellFace;
  const fillCount = telemetry.fillPreviewCount ?? 0;

  const catalog = useMemo(
    () =>
      WALLPAPER_UI_CATALOG.filter((item) => {
        if (category === 'all') return true;
        if (category === 'floor' || category === 'ceiling' || category === 'interior' || category === 'exterior') return item.category === category;
        if (category === 'wainscot') return item.tag === 'Вайнскотінг';
        if (category === 'tiles') return item.tag === 'Плитка';
        if (category === 'wood') return item.tag === 'Дерево' || item.category === 'floor';
        return true;
      }),
    [category]
  );
  const activeDef = useMemo(() => WALLPAPER_UI_CATALOG.find((w) => w.id === activeWallpaperId) || WALLPAPER_UI_CATALOG[0], [activeWallpaperId]);

  const swatch = (item: WallpaperUIItem, cls: string) => (
    <span className={`block overflow-hidden ${cls}`} style={{ backgroundColor: item.previewColor }}>
      {item.thumbnailUrl && (
        <img
          src={item.thumbnailUrl}
          alt=""
          className={`w-full h-full object-cover ${item.id.startsWith('lap_siding_') ? 'mix-blend-multiply' : ''}`}
          referrerPolicy="no-referrer"
          draggable={false}
        />
      )}
    </span>
  );

  return (
    <div className="pointer-events-none absolute inset-0 select-none overflow-hidden z-30">
      <ModeBar tab="paint" onTab={(tab) => tab === 'build' && onSwitchToBuild()} onDone={onTogglePaintMode} />

      {showGuide && (
        <div className={`${panel} absolute top-20 inset-x-2 mx-auto max-w-md pointer-events-auto max-h-[50vh] overflow-y-auto rounded-3xl p-4 text-xs z-40`}>
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-bold text-sm">{t('paint.guideHeader')}</h4>
            <button onClick={() => setShowGuide(false)} className="w-8 h-8 rounded-full bg-[#efe4cf] hover:bg-[#e9dcc3] flex items-center justify-center" aria-label={t('bui.hide')}>
              <X className="w-4 h-4" />
            </button>
          </div>
          <ul className="space-y-1.5 leading-relaxed">
            {GUIDE_KEYS.map((k) => (
              <li key={k}>
                <strong className="text-amber-700">{t(`paint.${k}.title` as TKey)}</strong> {t(`paint.${k}.text` as TKey)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Crosshair />
      <AimStatus tone="info">
        {hoveredFace ? (
          <>
            <span className={`w-2.5 h-2.5 rounded-full ${FACE_DOT[telemetry.hoveredCellFaceKind ?? ''] ?? 'bg-pink-500'}`} />
            <span className="truncate">
              {hoveredFace}
              {activeTool === 'fill' && fillCount > 0 ? ` · ${t('paint.fillCount', { n: fillCount })}` : ''}
            </span>
          </>
        ) : (
          <span className="truncate">{t('bui.aimSurface')}</span>
        )}
      </AimStatus>

      <ToolColumn>
        {TOOLS.map(({ tool, key, label, Icon }) => (
          <ToolButton key={tool} label={t(label)} hotkey={key} active={activeTool === tool} onClick={() => onSelectTool(tool)}>
            <Icon className="w-5 h-5" />
          </ToolButton>
        ))}
        <ToolButton label={t('bui.undo')} hotkey="Ctrl+Z" disabled={!telemetry.canUndoPaint} onClick={() => onUndo?.()}>
          <Undo2 className="w-5 h-5" />
        </ToolButton>
        <ToolButton label={t('bui.redo')} disabled={!telemetry.canRedoPaint} onClick={() => onRedo?.()}>
          <Redo2 className="w-5 h-5" />
        </ToolButton>
        <ToolButton label={t('bui.help')} active={showGuide} onClick={() => setShowGuide((v) => !v)}>
          <HelpCircle className="w-5 h-5" />
        </ToolButton>
      </ToolColumn>

      <PrimaryAction label={t(TOOLS.find((x) => x.tool === activeTool)?.label ?? 'bui.apply')} disabled={!hoveredFace} onPress={onApply}>
        {React.createElement(TOOLS.find((x) => x.tool === activeTool)?.Icon ?? Paintbrush, { className: 'w-7 h-7' })}
      </PrimaryAction>

      <Shelf
        tabs={CATEGORIES.map((c) => ({ id: c.id, label: `${c.emoji ? c.emoji + ' ' : ''}${t(c.label)}` }))}
        active={category}
        onTab={(id) => setCategory(id as PaintCategory)}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        current={
          <span className="shrink-0 hidden sm:flex items-center gap-2 h-9 pl-1 pr-3 rounded-full bg-amber-100 text-xs font-bold text-[#7a5a35] max-w-[14rem]">
            {swatch(activeDef, 'w-7 h-7 rounded-full shrink-0')}
            <span className="truncate">{localName(activeDef)}</span>
          </span>
        }
      >
        {catalog.map((item) => {
          const selected = item.id === activeWallpaperId;
          return (
            <ShelfCard
              key={item.id}
              selected={selected}
              title={getLang() === 'uk' ? `${item.ukrainianName} — ${item.description}` : item.name}
              onClick={() => onSelectWallpaper(item.id)}
            >
              {swatch(item, 'absolute inset-0')}
              <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 bg-[#fffaf0]/90 text-[9px] font-bold leading-tight truncate text-[#4a3b2a]">
                {localName(item)}
              </span>
              <span className="absolute top-1 left-1 px-1 rounded bg-[#fffaf0]/85 text-[8px] font-bold text-[#a08d70] truncate max-w-[90%]">
                {dataName('tag', item.tag, item.tag)}
              </span>
              {selected && (
                <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-amber-500 text-white flex items-center justify-center shadow">
                  <Check className="w-3.5 h-3.5" />
                </span>
              )}
            </ShelfCard>
          );
        })}
      </Shelf>
    </div>
  );
};
