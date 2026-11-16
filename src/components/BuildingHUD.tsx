import { t, useLang, localName, localizeBadge } from '../i18n/i18n';
import type { TKey } from '../i18n/en';
import React, { useState, useMemo, useRef } from 'react';
import {
  LayoutGrid,
  Square,
  Box,
  Columns,
  Columns2,
  AppWindow,
  DoorOpen,
  DoorClosed,
  TrendingUp,
  Home,
  MoveVertical,
  Grid2X2,
  Layers,
  Hammer,
  RotateCw,
  Magnet,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Wrench,
  Trees,
  Check,
  Paintbrush,
  Fence,
  Download,
  Upload,
  ChevronLeft,
  ChevronRight,
  Sprout,
  Armchair,
  Sofa,
  BedSingle,
  BedDouble,
  Table2,
  Archive,
  LampDesk,
  Library,
  Lamp,
  LampCeiling,
  Warehouse,
} from 'lucide-react';
import { BuildingPieceType, BuildingTelemetry, DormerAction, HouseRoofKind, PieceCategory } from '../building/types/BuildingTypes';
import { DORMER_STYLES } from '../building/RoofDormers';
import { BUILDING_PIECES } from '../building/config/BuildingPiecesConfig';
import { DEFAULT_ROOF_STYLE, RoofStyle } from '../building/ProceduralRoofSystem';
import { InputManager } from '../input/InputManager';

interface BuildingHUDProps {
  telemetry: BuildingTelemetry;
  inputManager?: InputManager;
  onToggleBuildMode: () => void;
  onTogglePaintMode?: () => void;
  onSelectPiece: (type: BuildingPieceType) => void;
  onRotatePiece: () => void;
  onToggleSnap: () => void;
  onDemolish: () => void;
  onPlace: () => void;
  onConfirmWalls: () => void;
  onConfirmFloors?: () => void;
  onConfirmFoundations?: () => void;
  onConfirmAll?: () => void;
  /** Restyles the selected roof and sets the style for new ones */
  onSetRoofStyle?: (style: RoofStyle) => void;
  /** One roof over the whole house of the selected / aimed wall */
  onRoofWholeHouse?: () => void;
  /** Picks the whole-house roof tool: the next wall clicked gets that roof over its house */
  onSelectHouseRoofTool?: (kind: HouseRoofKind) => void;
  /** Dormer panel of the selected roof */
  onDormerAction?: (action: DormerAction) => void;
  onFillOutline?: () => void;
}

/** Whole-house roofs in the roofs shelf (orange): pick one, then click a wall of the house */
const HOUSE_ROOF_ITEMS: Array<{ kind: HouseRoofKind; name: TKey; icon: React.ReactNode }> = [
  { kind: 'gable', name: 'build.houseRoof.gable', icon: <Home className="w-5 h-5" /> },
  { kind: 'hip', name: 'build.houseRoof.hip', icon: <Box className="w-5 h-5" /> },
];

interface PieceItemConfig {
  type: BuildingPieceType;
  category: PieceCategory;
  slot?: number;
  icon: React.ReactNode;
  dimBadge: string;
}

const ROOF_STYLE_BUTTONS: Array<{ style: RoofStyle; label: string; active: string }> = [
  { style: 'barkwood', label: '🌲 Barkwood', active: 'bg-amber-900 text-white border-amber-400 ring-1 ring-amber-500 shadow-sm' },
  { style: 'sunrise', label: '🌅 Sunrise', active: 'bg-amber-700 text-white border-amber-300 ring-1 ring-amber-400 shadow-sm' },
  { style: 'mission', label: '🏮 Mission', active: 'bg-rose-700 text-white border-rose-300 ring-1 ring-rose-400 shadow-sm' },
  { style: 'blue_slate', label: '🔷 Slate', active: 'bg-sky-600 text-white border-sky-300 ring-1 ring-sky-400 shadow-sm' },
];

const PIECE_ITEMS: PieceItemConfig[] = [
  // Floors
  {
    type: BuildingPieceType.WOOD_FLOOR_2X2,
    category: PieceCategory.FLOORS,
    slot: 1,
    icon: <Square className="w-5 h-5" />,
    dimBadge: '2x2м',
  },
  {
    type: BuildingPieceType.STONE_FOUNDATION_2X2,
    category: PieceCategory.FLOORS,
    slot: 2,
    icon: <Box className="w-5 h-5" />,
    dimBadge: '2x2м',
  },

  // Walls
  {
    type: BuildingPieceType.WOOD_WALL_2X3,
    category: PieceCategory.WALLS,
    slot: 1,
    icon: <Columns2 className="w-5 h-5" />,
    dimBadge: '2x3м',
  },
  {
    type: BuildingPieceType.WOOD_WALL_2X1,
    category: PieceCategory.WALLS,
    slot: 2,
    icon: <Columns2 className="w-5 h-5" />,
    dimBadge: '2x1м',
  },

  // Windows
  {
    type: BuildingPieceType.WOOD_WALL_WINDOW_1X2,
    category: PieceCategory.WINDOWS,
    slot: 1,
    icon: <AppWindow className="w-5 h-5" />,
    dimBadge: '1x2м',
  },
  {
    type: BuildingPieceType.WOOD_WALL_WINDOW_1X1_5,
    category: PieceCategory.WINDOWS,
    slot: 2,
    icon: <AppWindow className="w-5 h-5" />,
    dimBadge: '1x1.5м',
  },
  {
    type: BuildingPieceType.WOOD_WALL_WINDOW_2X2,
    category: PieceCategory.WINDOWS,
    slot: 3,
    icon: <AppWindow className="w-5 h-5" />,
    dimBadge: '2x2м',
  },

  // Doors & Doorways
  {
    type: BuildingPieceType.WOOD_WALL_DOORWAY_2X2,
    category: PieceCategory.DOORS,
    slot: 1,
    icon: <DoorOpen className="w-5 h-5 text-amber-400" />,
    dimBadge: '2x2м (Пройм)',
  },
  {
    type: BuildingPieceType.WOOD_WALL_DOORWAY_1X2,
    category: PieceCategory.DOORS,
    slot: 2,
    icon: <DoorOpen className="w-5 h-5 text-amber-400" />,
    dimBadge: '1x2м (Пройм)',
  },
  {
    type: BuildingPieceType.WOOD_DOOR_SINGLE,
    category: PieceCategory.DOORS,
    slot: 3,
    icon: <DoorOpen className="w-5 h-5 text-amber-300" />,
    dimBadge: '1x2м (Одинарні)',
  },
  {
    type: BuildingPieceType.WOOD_DOOR_DOUBLE,
    category: PieceCategory.DOORS,
    slot: 4,
    icon: <DoorOpen className="w-5 h-5 text-amber-300" />,
    dimBadge: '2x2м (Двостулкові)',
  },
  {
    type: BuildingPieceType.DOOR_GRAND_SIDELITES_2X2,
    category: PieceCategory.DOORS,
    slot: 5,
    icon: <DoorOpen className="w-5 h-5 text-rose-400" />,
    dimBadge: '2x2м (Парадні)',
  },
  {
    type: BuildingPieceType.DOOR_WHITE_2PANEL_1X2,
    category: PieceCategory.DOORS,
    slot: 6,
    icon: <DoorClosed className="w-5 h-5 text-slate-100" />,
    dimBadge: '1x2м (Шейкер)',
  },
  {
    type: BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2,
    category: PieceCategory.DOORS,
    slot: 7,
    icon: <DoorClosed className="w-5 h-5 text-emerald-400" />,
    dimBadge: '1x2м (Котеджні)',
  },
  {
    type: BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2,
    category: PieceCategory.DOORS,
    slot: 8,
    icon: <DoorClosed className="w-5 h-5 text-amber-200" />,
    dimBadge: '1x2м (Колоніальні)',
  },

  // Stairs
  {
    type: BuildingPieceType.WOOD_STAIRS_2X2,
    category: PieceCategory.STAIRS,
    slot: 1,
    icon: <TrendingUp className="w-5 h-5" />,
    dimBadge: '2x2м (В: 2м)',
  },
  {
    type: BuildingPieceType.WOOD_STAIRS_2X1,
    category: PieceCategory.STAIRS,
    slot: 2,
    icon: <TrendingUp className="w-5 h-5" />,
    dimBadge: '2x1м (В: 1м)',
  },
  {
    type: BuildingPieceType.WOOD_STAIRS_2X3,
    category: PieceCategory.STAIRS,
    slot: 3,
    icon: <TrendingUp className="w-5 h-5" />,
    dimBadge: '2x3м (В: 3м)',
  },

  // Roofs (Sims 4 Procedural System - Gable, Hip & Shed)
  {
    type: BuildingPieceType.ROOF_GABLE_2X2,
    category: PieceCategory.ROOFS,
    slot: 1,
    icon: <Home className="w-5 h-5" />,
    dimBadge: '2-похилий',
  },
  {
    type: BuildingPieceType.ROOF_HIP_2X2,
    category: PieceCategory.ROOFS,
    slot: 2,
    icon: <Box className="w-5 h-5" />,
    dimBadge: '4-похилий',
  },
  {
    type: BuildingPieceType.ROOF_SHED_2X2,
    category: PieceCategory.ROOFS,
    slot: 3,
    icon: <Home className="w-5 h-5" />,
    dimBadge: '1-похилий',
  },
  {
    type: BuildingPieceType.ROOF_GAMBREL_2X2,
    category: PieceCategory.ROOFS,
    slot: 4,
    icon: <Home className="w-5 h-5" />,
    dimBadge: 'Ламаний',
  },
  {
    type: BuildingPieceType.ROOF_MANSARD_2X2,
    category: PieceCategory.ROOFS,
    slot: 5,
    icon: <Box className="w-5 h-5" />,
    dimBadge: 'Мансардний',
  },

  // Pillars
  {
    type: BuildingPieceType.WOOD_POLE_2M,
    category: PieceCategory.PILLARS,
    icon: <MoveVertical className="w-5 h-5" />,
    dimBadge: '0.2x2м',
  },
  {
    type: BuildingPieceType.CHECKER_PILLAR_1M,
    category: PieceCategory.PILLARS,
    icon: <Box className="w-5 h-5" />,
    dimBadge: '0.4x1м (Чекер)',
  },
  {
    type: BuildingPieceType.CORNER_RUSTICATED_QUOIN_1M,
    category: PieceCategory.PILLARS,
    icon: <Grid2X2 className="w-5 h-5" />,
    dimBadge: '0.4x1м (Русти)',
  },

  // Railings & Fences
  {
    type: BuildingPieceType.WOOD_RAILING_2M,
    category: PieceCategory.RAILINGS,
    slot: 1,
    icon: <Fence className="w-5 h-5" />,
    dimBadge: '2х1м (Прямі)',
  },
  {
    type: BuildingPieceType.WOOD_RAILING_1M,
    category: PieceCategory.RAILINGS,
    slot: 2,
    icon: <Fence className="w-4 h-4" />,
    dimBadge: '1х1м (Прямі)',
  },
  {
    type: BuildingPieceType.WHITE_DECORATIVE_FENCE_1M,
    category: PieceCategory.RAILINGS,
    slot: 3,
    icon: <Fence className="w-5 h-5 text-amber-100" />,
    dimBadge: '1х1м (Білий)',
  },
  {
    type: BuildingPieceType.WOOD_STAIR_RAILING_2X2,
    category: PieceCategory.RAILINGS,
    slot: 4,
    icon: <TrendingUp className="w-5 h-5" />,
    dimBadge: '2х2м (Сходи)',
  },

  // Greenhouse (glasshouse)
  {
    type: BuildingPieceType.GLASS_WALL_2X3,
    category: PieceCategory.GREENHOUSE,
    slot: 1,
    icon: <Columns2 className="w-5 h-5 text-cyan-200" />,
    dimBadge: '2x3м',
  },
  {
    type: BuildingPieceType.GLASS_WALL_1X3,
    category: PieceCategory.GREENHOUSE,
    slot: 2,
    icon: <Columns className="w-5 h-5 text-cyan-200" />,
    dimBadge: '1x3м',
  },
  {
    type: BuildingPieceType.GLASS_DOORWAY_1X3,
    category: PieceCategory.GREENHOUSE,
    slot: 3,
    icon: <DoorOpen className="w-5 h-5 text-cyan-200" />,
    dimBadge: 'Вхід',
  },
  {
    type: BuildingPieceType.GLASS_DOOR_1X3,
    category: PieceCategory.GREENHOUSE,
    slot: 4,
    icon: <DoorClosed className="w-5 h-5 text-cyan-200" />,
    dimBadge: 'Двері',
  },
  {
    type: BuildingPieceType.GLASS_ROOF_GABLE_2X2,
    category: PieceCategory.GREENHOUSE,
    slot: 5,
    icon: <Home className="w-5 h-5 text-cyan-200" />,
    dimBadge: '2-похилий',
  },
  {
    type: BuildingPieceType.GLASS_ROOF_SHED_2X2,
    category: PieceCategory.GREENHOUSE,
    slot: 6,
    icon: <Home className="w-5 h-5 text-cyan-200" />,
    dimBadge: '1-похилий',
  },

  // Furniture
  { type: BuildingPieceType.FURN_DINING_TABLE, category: PieceCategory.FURNITURE, icon: <Table2 className="w-5 h-5" />, dimBadge: '1.6×0.9м' },
  { type: BuildingPieceType.FURN_COFFEE_TABLE, category: PieceCategory.FURNITURE, icon: <Table2 className="w-4 h-4" />, dimBadge: '1.0×0.6м' },
  { type: BuildingPieceType.FURN_WOOD_CHAIR, category: PieceCategory.FURNITURE, icon: <Armchair className="w-4 h-4" />, dimBadge: 'Стілець' },
  { type: BuildingPieceType.FURN_ARMCHAIR, category: PieceCategory.FURNITURE, icon: <Armchair className="w-5 h-5" />, dimBadge: 'Мʼяке' },
  { type: BuildingPieceType.FURN_SOFA, category: PieceCategory.FURNITURE, icon: <Sofa className="w-5 h-5" />, dimBadge: '2.0м' },
  { type: BuildingPieceType.FURN_BED_SINGLE, category: PieceCategory.FURNITURE, icon: <BedSingle className="w-5 h-5" />, dimBadge: '1×2м' },
  { type: BuildingPieceType.FURN_BED_DOUBLE, category: PieceCategory.FURNITURE, icon: <BedDouble className="w-5 h-5" />, dimBadge: '1.6×2м' },
  { type: BuildingPieceType.FURN_WARDROBE, category: PieceCategory.FURNITURE, icon: <Archive className="w-5 h-5" />, dimBadge: '1.2×2м' },
  { type: BuildingPieceType.FURN_DRESSER, category: PieceCategory.FURNITURE, icon: <Archive className="w-4 h-4" />, dimBadge: '3 шухляди' },
  { type: BuildingPieceType.FURN_NIGHTSTAND, category: PieceCategory.FURNITURE, icon: <LampDesk className="w-5 h-5" />, dimBadge: '0.5м' },
  { type: BuildingPieceType.FURN_BOOKSHELF, category: PieceCategory.FURNITURE, icon: <Library className="w-5 h-5" />, dimBadge: '1×1.8м' },
  { type: BuildingPieceType.FURN_CHANDELIER, category: PieceCategory.FURNITURE, icon: <LampCeiling className="w-5 h-5" />, dimBadge: '0.7м' },
  { type: BuildingPieceType.FURN_TABLE_LAMP, category: PieceCategory.FURNITURE, icon: <Lamp className="w-5 h-5" />, dimBadge: '0.3м' },
];

const CATEGORY_TABS: { id: PieceCategory | 'ALL'; name: string; icon: React.ReactNode }[] = [
  { id: 'ALL', name: 'build.cat.all', icon: <LayoutGrid className="w-3.5 h-3.5" /> },
  { id: PieceCategory.FLOORS, name: 'build.cat.floors', icon: <Square className="w-3.5 h-3.5" /> },
  { id: PieceCategory.WALLS, name: 'build.cat.walls', icon: <Columns className="w-3.5 h-3.5" /> },
  { id: PieceCategory.WINDOWS, name: 'build.cat.windows', icon: <AppWindow className="w-3.5 h-3.5" /> },
  { id: PieceCategory.DOORS, name: 'build.cat.doors', icon: <DoorOpen className="w-3.5 h-3.5" /> },
  { id: PieceCategory.STAIRS, name: 'build.cat.stairs', icon: <TrendingUp className="w-3.5 h-3.5" /> },
  { id: PieceCategory.RAILINGS, name: 'build.cat.railings', icon: <Fence className="w-3.5 h-3.5" /> },
  { id: PieceCategory.ROOFS, name: 'build.cat.roofs', icon: <Home className="w-3.5 h-3.5" /> },
  { id: PieceCategory.PILLARS, name: 'build.cat.pillars', icon: <MoveVertical className="w-3.5 h-3.5" /> },
  { id: PieceCategory.GREENHOUSE, name: 'build.cat.greenhouse', icon: <Warehouse className="w-3.5 h-3.5" /> },
  { id: PieceCategory.FURNITURE, name: 'build.cat.furniture', icon: <Sofa className="w-3.5 h-3.5" /> },
];

export const BuildingHUD: React.FC<BuildingHUDProps> = ({
  telemetry,
  onToggleBuildMode,
  onTogglePaintMode,
  onSelectPiece,
  onRotatePiece,
  onToggleSnap,
  onDemolish,
  onPlace,
  onConfirmWalls,
  onConfirmFloors,
  onConfirmFoundations,
  onConfirmAll,
  onSetRoofStyle,
  onRoofWholeHouse,
  onSelectHouseRoofTool,
  onDormerAction,
  onFillOutline,
}) => {
  useLang();
  const {
    isBuildModeActive,
    selectedPieceType,
    isSnapped,
    snappingEnabled,
    isValidPlacement,
    totalPiecesBuilt,
    aimingAtPieceId,
  } = telemetry;

  const [activeCategory, setActiveCategory] = useState<PieceCategory | 'ALL'>('ALL');
  const roofStyle = telemetry.currentRoofStyle ?? DEFAULT_ROOF_STYLE;
  const categoryScrollRef = useRef<HTMLDivElement>(null);

  const scrollCategories = (direction: 'left' | 'right') => {
    if (categoryScrollRef.current) {
      const scrollAmount = direction === 'left' ? -220 : 220;
      categoryScrollRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };


  // Filter pieces by active category
  const filteredPieces = useMemo(() => {
    if (activeCategory === 'ALL') {
      return PIECE_ITEMS;
    }
    return PIECE_ITEMS.filter((item) => item.category === activeCategory);
  }, [activeCategory]);

  return (
    <div className="pointer-events-none absolute inset-0 select-none overflow-hidden font-sans z-30">
      {/* Top Center: Always-accessible Hammer Toggle Button & Action Buttons */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-auto flex items-center gap-2.5 max-w-[96vw] overflow-x-auto py-1 px-1">
        <button
          id="btn-toggle-build-mode"
          onClick={onToggleBuildMode}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold tracking-wide transition-all shadow-lg border ${
            isBuildModeActive
              ? 'bg-amber-600/90 hover:bg-amber-500 text-white border-amber-300/60 ring-2 ring-amber-400/40'
              : 'bg-stone-900/80 hover:bg-stone-800 text-stone-200 border-stone-700/60'
          }`}
          title={t('build.modeTitle')}
        >
          <Hammer className={`w-4 h-4 ${isBuildModeActive ? 'animate-bounce' : 'text-amber-400'}`} />
          <span>{isBuildModeActive ? t('build.mode') : t('build.modeKey')}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-black/40 border border-white/10 text-amber-200 hidden md:inline">
            [B]
          </span>
        </button>

        {/* Heartopia Green Confirmation Button (Single button for all separate regenerations) */}
        {(() => {
          const totalUnconfirmed =
            (telemetry.unconfirmedWallsCount ?? 0) +
            (telemetry.unconfirmedFloorsCount ?? 0) +
            (telemetry.unconfirmedFoundationsCount ?? 0);
          return (
            <button
              id="btn-confirm-walls"
              onClick={onConfirmAll || onConfirmWalls}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold tracking-wide transition-all shadow-lg border active:scale-95 ${
                totalUnconfirmed > 0
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-300 ring-2 ring-emerald-400/50 shadow-emerald-950/60 animate-pulse'
                  : 'bg-emerald-700/90 hover:bg-emerald-600 text-emerald-100 border-emerald-500/60 shadow-emerald-950/40'
              }`}
              title={t('build.confirmTitle')}
            >
              <Check className="w-4 h-4 text-emerald-100" />
              <span>{t('build.confirm')}</span>
              {totalUnconfirmed > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-emerald-950 border border-emerald-400/60 text-emerald-200 font-mono font-bold">
                  {totalUnconfirmed}
                </span>
              )}
            </button>
          );
        })()}

        {/* Heartopia Painting / Wallpaper Mode Toggle Button */}
        {onTogglePaintMode && (
          <button
            id="btn-toggle-paint-mode"
            onClick={onTogglePaintMode}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold tracking-wide transition-all shadow-lg border ${
              telemetry.isPaintingModeActive
                ? 'bg-gradient-to-r from-pink-600 to-rose-600 text-white border-pink-300 ring-2 ring-pink-400/50 shadow-pink-950/60'
                : 'bg-stone-900/80 hover:bg-stone-800 text-stone-200 border-stone-700/60 hover:text-pink-300'
            }`}
            title={t('build.paintTitle')}
          >
            <Paintbrush className={`w-4 h-4 ${telemetry.isPaintingModeActive ? 'animate-pulse text-white' : 'text-pink-400'}`} />
            <span>{t('build.paint')}</span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-black/40 border border-white/10 text-pink-200 font-mono hidden md:inline">
              [P]
            </span>
          </button>
        )}

        {isBuildModeActive && (
          <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-stone-900/85 border border-stone-700 text-xs text-stone-300 shadow whitespace-nowrap">
            <Wrench className="w-3.5 h-3.5 text-stone-400" />
            <span>
              {t('build.objects')} <strong className="text-amber-400">{totalPiecesBuilt}</strong>
            </span>
          </div>
        )}
      </div>

      {/* Build Mode Active UI Overlay */}
      {isBuildModeActive && (
        <>
          {/* Aim Crosshair Snap Feedback in Center */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none flex flex-col items-center z-10">
            {/* Subtle, beautiful minimalist crosshair circle for precise center-of-screen aiming */}
            <div className="w-3.5 h-3.5 rounded-full border-2 border-white/80 bg-black/40 shadow-[0_0_8px_rgba(0,0,0,0.6)] flex items-center justify-center">
              <div className="w-1 h-1 rounded-full bg-white/90"></div>
            </div>
          </div>

          {/* Bottom Heartopia-Style Tabbed Building Panel */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-auto flex flex-col items-center gap-2 w-full max-w-4xl px-3">
            {/* Top Quick Action Bar: Magnet toggle, 45° rotate, status pill, and demolish target prompt */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {/* Snap status toggle */}
              <button
                id="btn-toggle-snap"
                onClick={onToggleSnap}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all shadow border ${
                  snappingEnabled
                    ? 'bg-emerald-950/85 border-emerald-500/50 text-emerald-300 hover:bg-emerald-900/80'
                    : 'bg-stone-850/85 border-stone-600/50 text-stone-300 hover:bg-stone-700'
                }`}
                title={t('build.snapTitle')}
              >
                <Magnet className="w-3.5 h-3.5 text-current" />
                <span>{snappingEnabled ? t('build.snapOn') : t('build.snapOff')}</span>
              </button>

              {/* Grid 0.5m badge */}
              <div
                id="badge-grid-step"
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-mono font-medium bg-sky-950/80 border border-sky-500/40 text-sky-300 shadow"
                title={t('build.gridTitle')}
              >
                <LayoutGrid className="w-3.5 h-3.5 text-sky-400" />
                <span>{t('build.grid')}</span>
              </div>

              {/* Rotate piece button */}
              <button
                id="btn-rotate-piece"
                onClick={onRotatePiece}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-stone-850/85 hover:bg-stone-750 border border-stone-600/50 text-stone-200 transition shadow"
                title={t('build.rotateTitle')}
              >
                <RotateCw className="w-3.5 h-3.5 text-amber-400" />
                <span>{t('build.rotate')}</span>
              </button>

              {/* Placement status pill */}
              {selectedPieceType ? (
                <div
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium border ${
                    isValidPlacement
                      ? 'bg-emerald-950/70 border-emerald-500/50 text-emerald-300'
                      : 'bg-rose-950/70 border-rose-500/50 text-rose-300'
                  }`}
                >
                  {isValidPlacement ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{t('build.ready')}</span>
                      <span className="text-emerald-400/70">· {t('build.keepHint')}</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="w-3.5 h-3.5" />
                      <span>{telemetry.placementReason || t('build.blocked')}</span>
                    </>
                  )}
                </div>
              ) : telemetry.selectedWallId ? (
                <div className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-sky-950/85 border border-sky-400/60 text-sky-200 shadow-md">
                  <span className="inline-block w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
                  <span>{t('build.active')}</span>
                </div>
              ) : null}

              {/* Aiming at piece demolish prompt relocated here */}
              {aimingAtPieceId && (
                <div className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-rose-950/85 border border-rose-400/60 text-rose-200 shadow-md animate-pulse">
                  <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                  <span>{t('build.demolishHint')}</span>
                </div>
              )}
            </div>

            {/* Heartopia-Themed Main Dock Container */}
            <div className="w-full bg-stone-950/90 border border-stone-700/60 rounded-2xl shadow-2xl p-2.5 flex flex-col gap-2 ring-1 ring-white/10">
              {/* Category Tabs Strip with Scroll Controls */}
              <div className="relative flex items-center border-b border-stone-800/80 pb-1.5 px-1">
                {/* Scroll Left Button */}
                <button
                  type="button"
                  onClick={() => scrollCategories('left')}
                  className="absolute left-0 z-10 p-1 bg-stone-900/95 hover:bg-stone-800 border border-stone-700/80 rounded-lg text-stone-300 shadow-md transition-all flex items-center justify-center -ml-1 sm:-ml-2"
                  title={t('build.scrollLeft')}
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>

                {/* Categories Scrollable Container */}
                <div
                  ref={categoryScrollRef}
                  onWheel={(e) => {
                    if (e.deltaY !== 0) {
                      e.preventDefault();
                      e.currentTarget.scrollLeft += e.deltaY;
                    }
                  }}
                  className="flex items-center gap-1 overflow-x-auto no-scrollbar px-6 sm:px-8 py-0.5 w-full scroll-smooth"
                >
                  {CATEGORY_TABS.map((tab) => {
                    const isActive = activeCategory === tab.id;
                    const count =
                      tab.id === 'ALL'
                        ? PIECE_ITEMS.length
                        : PIECE_ITEMS.filter((p) => p.category === tab.id).length;

                    return (
                      <button
                        key={tab.id}
                        id={`tab-category-${tab.id.toLowerCase()}`}
                        onClick={() => setActiveCategory(tab.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all whitespace-nowrap border shrink-0 ${
                          isActive
                            ? 'bg-amber-600/30 border-amber-400/80 text-amber-200 shadow-sm ring-1 ring-amber-400/40'
                            : 'bg-stone-900/60 border-transparent text-stone-400 hover:bg-stone-800/60 hover:text-stone-200'
                        }`}
                      >
                        <span className={isActive ? 'text-amber-400' : 'text-stone-400'}>
                          {tab.icon}
                        </span>
                        <span>{t(tab.name as TKey)}</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                            isActive
                              ? 'bg-amber-500/30 text-amber-200'
                              : 'bg-stone-800 text-stone-500'
                          }`}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Scroll Right Button */}
                <button
                  type="button"
                  onClick={() => scrollCategories('right')}
                  className="absolute right-0 z-10 p-1 bg-stone-900/95 hover:bg-stone-800 border border-stone-700/80 rounded-lg text-stone-300 shadow-md transition-all flex items-center justify-center -mr-1 sm:-mr-2"
                  title={t('build.scrollRight')}
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Walls on every outer edge of the selected / aimed floor */}
              {telemetry.fillKind && onFillOutline && (
                <button
                  id="btn-fill-outline"
                  onClick={onFillOutline}
                  title={t(telemetry.fillKind === 'walls' ? 'build.floorWallsTitle' : 'build.fill.ceilingTitle')}
                  className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border bg-amber-600/90 hover:bg-amber-500 text-white border-amber-400/60 transition-all"
                >
                  <Home className="w-3.5 h-3.5" />
                  <span>{t(telemetry.fillKind === 'walls' ? 'build.floorWalls' : 'build.fill.ceiling')}</span>
                  <span className="text-amber-100/70 font-normal">[K]</span>
                </button>
              )}

              {/* One roof over the whole house of the selected / aimed wall */}
              {telemetry.canRoofHouse && onRoofWholeHouse && (
                <button
                  id="btn-roof-whole-house"
                  onClick={onRoofWholeHouse}
                  title={t('build.houseRoofTitle')}
                  className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border bg-amber-600/90 hover:bg-amber-500 text-white border-amber-400/60 transition-all"
                >
                  <Home className="w-3.5 h-3.5" />
                  <span>{t('build.houseRoof')}</span>
                  <span className="text-amber-100/70 font-normal">[U]</span>
                </button>
              )}

              {/* Sims 4 Style Architectural Roof Texture Selector */}
              {(activeCategory === PieceCategory.ROOFS || (selectedPieceType && selectedPieceType.startsWith('ROOF_')) || telemetry.isRoofSelected) && (
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-stone-900/90 rounded-xl border border-amber-500/30 text-xs">
                  <span className="text-amber-300 font-semibold flex items-center gap-1.5">
                    <Home className="w-3.5 h-3.5 text-amber-400" />
                    <span>{t('build.roofTexture')}</span>
                  </span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {ROOF_STYLE_BUTTONS.map((b) => (
                      <button
                        key={b.style}
                        id={`btn-roof-style-${b.style.replace('_', '-')}`}
                        onClick={() => onSetRoofStyle?.(b.style)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
                          roofStyle === b.style ? b.active : 'bg-stone-800/80 text-stone-300 border-stone-700 hover:bg-stone-700'
                        }`}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Dormers of the selected roof: tool, style and size (no hotkeys, all here) */}
              {telemetry.dormer && onDormerAction && (() => {
                const d = telemetry.dormer;
                const chip = 'px-2.5 py-1 rounded-lg text-xs font-medium border transition-all';
                const idle = 'bg-stone-800/80 text-stone-300 border-stone-700 hover:bg-stone-700';
                const stepper = (label: TKey, value: number, kind: 'width' | 'height') => (
                  <div className="flex items-center gap-1">
                    <span className="text-stone-400">{t(label)}</span>
                    <button id={`btn-dormer-${kind}-down`} onClick={() => onDormerAction({ kind, delta: -1 })} className={`${chip} ${idle} px-2`}>−</button>
                    <span className="min-w-[3.2rem] text-center text-stone-100 tabular-nums">{t('build.dormer.metres', { v: value.toFixed(1) })}</span>
                    <button id={`btn-dormer-${kind}-up`} onClick={() => onDormerAction({ kind, delta: 1 })} className={`${chip} ${idle} px-2`}>+</button>
                  </div>
                );
                const hint = d.hint ?? (d.editing ? t('build.dormer.editing') : d.count > 0 && !d.tool ? t('build.dormer.clickToEdit') : null);
                return (
                  <div id="dormer-panel" className="flex flex-col gap-1.5 px-3 py-2 bg-stone-900/90 rounded-xl border border-amber-500/30 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-amber-300 font-semibold flex items-center gap-1.5">
                        <AppWindow className="w-3.5 h-3.5 text-amber-400" />
                        <span>{t('build.dormer.title')}{d.count > 0 ? ` · ${d.count}` : ''}</span>
                      </span>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                          id="btn-dormer-tool"
                          onClick={() => onDormerAction({ kind: 'tool' })}
                          className={`${chip} ${d.tool ? 'bg-amber-600 text-white border-amber-300 ring-1 ring-amber-400' : 'bg-amber-600/80 hover:bg-amber-500 text-white border-amber-400/60'}`}
                        >
                          {t(d.tool ? 'build.dormer.stop' : 'build.dormer.place')}
                        </button>
                        {d.editing && (
                          <>
                            <button id="btn-dormer-delete" onClick={() => onDormerAction({ kind: 'delete' })} className={`${chip} bg-rose-800/80 hover:bg-rose-700 text-white border-rose-500/60`}>
                              {t('build.dormer.delete')}
                            </button>
                            <button id="btn-dormer-done" onClick={() => onDormerAction({ kind: 'done' })} className={`${chip} ${idle}`}>
                              {t('build.dormer.done')}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {DORMER_STYLES.map((style) => (
                        <button
                          key={style}
                          id={`btn-dormer-style-${style}`}
                          onClick={() => onDormerAction({ kind: 'style', style })}
                          className={`${chip} ${d.style === style ? 'bg-amber-700 text-white border-amber-300 ring-1 ring-amber-400 shadow-sm' : idle}`}
                        >
                          {t(`build.dormer.style.${style}` as TKey)}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {stepper('build.dormer.width', d.width, 'width')}
                      {stepper('build.dormer.height', d.height, 'height')}
                    </div>
                    {hint && <div className="text-stone-400">{hint}</div>}
                  </div>
                );
              })()}

              {/* Modular Pieces Horizontal Shelf / Carousel */}
              <div className="flex items-center gap-2 overflow-x-auto py-1 px-1 no-scrollbar">
                {filteredPieces.map((item) => {
                  const def = BUILDING_PIECES[item.type];
                  const isSelected = selectedPieceType === item.type;

                  return (
                    <button
                      key={item.type}
                      id={`btn-piece-${item.type}`}
                      onClick={() => onSelectPiece(item.type)}
                      className={`group relative flex flex-col items-center justify-between min-w-[82px] max-w-[90px] h-[82px] p-1.5 rounded-xl transition-all border text-left shrink-0 ${
                        isSelected
                          ? 'bg-amber-500/25 border-amber-400 ring-2 ring-amber-500/40 shadow-lg scale-102'
                          : 'bg-stone-900/70 border-stone-800 text-stone-400 hover:bg-stone-800 hover:border-stone-700 hover:text-stone-200'
                      }`}
                      title={localName(def)}
                    >
                      {/* Slot Shortcut Badge */}
                      {item.slot !== undefined && (
                        <span className="absolute top-1 left-1.5 text-[10px] font-bold text-stone-500 group-hover:text-stone-300">
                          [{item.slot}]
                        </span>
                      )}

                      {/* Dimension tag */}
                      <span className="absolute top-1 right-1 text-[9px] font-mono text-stone-400 bg-black/40 px-1 rounded">
                        {localizeBadge(item.dimBadge)}
                      </span>

                      {/* Icon */}
                      <div
                        className={`mt-3.5 transition-transform group-hover:scale-110 ${
                          isSelected ? 'text-amber-300' : 'text-stone-300'
                        }`}
                      >
                        {item.icon}
                      </div>

                      {/* Name & Cost footer */}
                      <div className="w-full flex items-center justify-between gap-1 text-[9px] font-medium leading-none">
                        <span className="truncate max-w-[50px] text-stone-200">
                          {localName(def).split(' ')[0]}
                        </span>
                        <span className="text-amber-400/90 font-mono text-[9px] flex items-center gap-0.5">
                          🌲{def?.woodCost}
                        </span>
                      </div>
                    </button>
                  );
                })}

                {/* Whole-house roofs: pick, then click a wall of the house */}
                {onSelectHouseRoofTool && (activeCategory === 'ALL' || activeCategory === PieceCategory.ROOFS) &&
                  HOUSE_ROOF_ITEMS.map((item) => {
                    const isSelected = telemetry.houseRoofTool === item.kind;
                    return (
                      <button
                        key={`house-roof-${item.kind}`}
                        id={`btn-house-roof-${item.kind}`}
                        onClick={() => onSelectHouseRoofTool(item.kind)}
                        title={t('build.houseRoof.toolTitle')}
                        className={`group relative flex flex-col items-center justify-between min-w-[82px] max-w-[90px] h-[82px] p-1.5 rounded-xl transition-all border text-left shrink-0 ${
                          isSelected
                            ? 'bg-amber-500 border-amber-200 ring-2 ring-amber-300/70 shadow-lg scale-102'
                            : 'bg-amber-600/85 border-amber-400/70 hover:bg-amber-500'
                        }`}
                      >
                        <span className="absolute top-1 right-1 text-[9px] font-mono text-amber-50 bg-black/30 px-1 rounded">
                          {t('build.houseRoof.badge')}
                        </span>
                        <div className="mt-3.5 text-white transition-transform group-hover:scale-110">{item.icon}</div>
                        <div className="w-full text-center text-[9px] font-semibold leading-none text-white truncate">
                          {t(item.name)}
                        </div>
                      </button>
                    );
                  })}
              </div>


            </div>
          </div>

          {/* Mobile Touch Action Floating Pad */}
          <div className="md:hidden absolute right-4 bottom-32 pointer-events-auto flex flex-col gap-2">
            <button
              onClick={onConfirmWalls}
              className="w-13 h-13 rounded-full bg-emerald-600 border border-emerald-300 text-white flex items-center justify-center shadow-xl active:scale-90"
              title={t('build.confirmWalls')}
            >
              <Check className="w-6 h-6" />
            </button>

            <button
              onClick={onPlace}
              disabled={!isValidPlacement}
              className={`w-13 h-13 rounded-full flex items-center justify-center text-white shadow-xl transition-transform active:scale-90 border ${
                isValidPlacement
                  ? 'bg-emerald-600 border-emerald-300'
                  : 'bg-stone-700/60 border-stone-600 text-stone-500 cursor-not-allowed'
              }`}
              title={t('build.place')}
            >
              <Hammer className="w-6 h-6" />
            </button>

            <button
              onClick={onRotatePiece}
              className="w-11 h-11 rounded-full bg-stone-800/90 border border-stone-600 text-amber-300 flex items-center justify-center shadow-lg active:scale-90"
              title={t('build.rotateShort')}
            >
              <RotateCw className="w-5 h-5" />
            </button>

            <button
              onClick={onToggleSnap}
              className={`w-11 h-11 rounded-full border flex items-center justify-center shadow-lg active:scale-90 ${
                snappingEnabled
                  ? 'bg-emerald-900/90 border-emerald-400 text-emerald-300'
                  : 'bg-stone-800/90 border-stone-600 text-stone-400'
              }`}
              title={t('build.snap')}
            >
              <Magnet className="w-5 h-5" />
            </button>

            {aimingAtPieceId && (
              <button
                onClick={onDemolish}
                className="w-11 h-11 rounded-full bg-rose-900/90 border border-rose-400 text-rose-300 flex items-center justify-center shadow-lg active:scale-90 animate-pulse"
                title={t('build.demolish')}
              >
                <Trash2 className="w-5 h-5" />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};
