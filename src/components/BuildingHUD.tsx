import { t, useLang, localName } from '../i18n/i18n';
import type { TKey } from '../i18n/en';
import React, { useState, useMemo } from 'react';
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
  Hammer,
  RotateCw,
  Magnet,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Fence,
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
  Landmark,
} from 'lucide-react';
import { BuildingPieceType, BuildingTelemetry, DormerAction, HouseRoofKind, PieceCategory } from '../building/types/BuildingTypes';
import { DORMER_STYLES } from '../building/RoofDormers';
import { BUILDING_PIECES } from '../building/config/BuildingPiecesConfig';
import { DEFAULT_ROOF_STYLE, ROOF_STYLES, RoofStyle } from '../building/ProceduralRoofSystem';
import { InputManager } from '../input/InputManager';
import { AimStatus, Chip, Crosshair, ModeBar, PrimaryAction, Shelf, ShelfCard, ShelfSection, ToolButton, ToolColumn } from './buildui/BuildUI';

const WindowGlyph: React.FC<{ shape: 'single' | 'arch' | 'palladian' | 'round' | 'bay' }> = ({ shape }) => (
  <svg viewBox="0 0 32 32" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {shape === 'bay' ? <path d="M3 6l7-5h12l7 5M3 6l6 3h14l6-3v19l-6 3H9l-6-3zM9 9v19M23 9v19M3 14l6 3h14l6-3" /> :
      shape === 'round' ? <><circle cx="16" cy="16" r="10" /><path d="M6 16h20M16 6v20M9 9l14 14M23 9 9 23" /></> :
      shape === 'arch' || shape === 'palladian' ? <><path d="M5 27V14a11 11 0 0 1 22 0v13M5 27h22" />
        {shape === 'palladian' && <><path d="M16 5v22M7 16h18M16 16 9 8M16 16l7-8" /></>}</> :
        <><rect x="6" y="4" width="20" height="24" rx="1" /><path d="M6 16h20" /></>}
  </svg>
);

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
  /** Picks the whole-house roof tool: the next wall clicked gets that roof over its house */
  onSelectHouseRoofTool?: (kind: HouseRoofKind) => void;
  /** Dormer panel of the selected roof */
  onDormerAction?: (action: DormerAction) => void;
}

/** Whole-house roofs in the roofs shelf (orange): pick one, then click a wall of the house */
const HOUSE_ROOF_ITEMS: Array<{ kind: HouseRoofKind; name: TKey; icon: React.ReactNode }> = [
  { kind: 'gable', name: 'build.houseRoof.gable', icon: <Home className="w-5 h-5" /> },
  { kind: 'hip', name: 'build.houseRoof.hip', icon: <Box className="w-5 h-5" /> },
  { kind: 'gambrel', name: 'build.houseRoof.gambrel', icon: <Warehouse className="w-5 h-5" /> },
  { kind: 'mansard', name: 'build.houseRoof.mansard', icon: <Landmark className="w-5 h-5" /> },
];

interface PieceItemConfig {
  type: BuildingPieceType;
  category: PieceCategory;
  slot?: number;
  icon: React.ReactNode;
  dimBadge: string;
}

const ROOF_SWATCHES: Record<RoofStyle, string> = {
  barkwood: '#543929', sunrise: '#96623a', mission: '#a04d2f', blue_slate: '#4f6270',
  scalloped_clay: '#587662', standing_seam: '#445e5e', thatch: '#9f7c44',
};

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
  {
    type: BuildingPieceType.WOOD_WALL_WINDOW_SINGLE_HUNG,
    category: PieceCategory.WINDOWS,
    slot: 4,
    icon: <WindowGlyph shape="single" />,
    dimBadge: '1x2м · підвісне',
  },
  {
    type: BuildingPieceType.WOOD_WALL_WINDOW_ARCH,
    category: PieceCategory.WINDOWS,
    slot: 5,
    icon: <WindowGlyph shape="arch" />,
    dimBadge: '1x2м · арка',
  },
  {
    type: BuildingPieceType.WOOD_WALL_WINDOW_PALLADIAN,
    category: PieceCategory.WINDOWS,
    slot: 6,
    icon: <WindowGlyph shape="palladian" />,
    dimBadge: '1x2м · палладіанське',
  },
  {
    type: BuildingPieceType.WOOD_WALL_WINDOW_ROUND,
    category: PieceCategory.WINDOWS,
    slot: 7,
    icon: <WindowGlyph shape="round" />,
    dimBadge: '1x1м · кругле',
  },

  {
    type: BuildingPieceType.WOOD_WALL_WINDOW_BAY,
    category: PieceCategory.WINDOWS,
    slot: 8,
    icon: <WindowGlyph shape="bay" />,
    dimBadge: '2,5×1,5 м',
  },

  // Doors & Doorways
  {
    type: BuildingPieceType.WOOD_WALL_DOORWAY_2X2,
    category: PieceCategory.DOORS,
    slot: 1,
    icon: <DoorOpen className="w-5 h-5" />,
    dimBadge: '2x2м (Пройм)',
  },
  {
    type: BuildingPieceType.WOOD_WALL_DOORWAY_1X2,
    category: PieceCategory.DOORS,
    slot: 2,
    icon: <DoorOpen className="w-5 h-5" />,
    dimBadge: '1x2м (Пройм)',
  },
  {
    type: BuildingPieceType.WOOD_DOOR_SINGLE,
    category: PieceCategory.DOORS,
    slot: 3,
    icon: <DoorOpen className="w-5 h-5" />,
    dimBadge: '1x2м (Одинарні)',
  },
  {
    type: BuildingPieceType.WOOD_DOOR_DOUBLE,
    category: PieceCategory.DOORS,
    slot: 4,
    icon: <DoorOpen className="w-5 h-5" />,
    dimBadge: '2x2м (Двостулкові)',
  },
  {
    type: BuildingPieceType.DOOR_GRAND_SIDELITES_2X2,
    category: PieceCategory.DOORS,
    slot: 5,
    icon: <DoorOpen className="w-5 h-5" />,
    dimBadge: '2x2м (Парадні)',
  },
  {
    type: BuildingPieceType.DOOR_WHITE_2PANEL_1X2,
    category: PieceCategory.DOORS,
    slot: 6,
    icon: <DoorClosed className="w-5 h-5" />,
    dimBadge: '1x2м (Шейкер)',
  },
  {
    type: BuildingPieceType.DOOR_COTTAGE_WINDOW_1X2,
    category: PieceCategory.DOORS,
    slot: 7,
    icon: <DoorClosed className="w-5 h-5" />,
    dimBadge: '1x2м (Котеджні)',
  },
  {
    type: BuildingPieceType.DOOR_COLONIAL_6PANEL_1X2,
    category: PieceCategory.DOORS,
    slot: 8,
    icon: <DoorClosed className="w-5 h-5" />,
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
    icon: <Fence className="w-5 h-5" />,
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
    icon: <Columns2 className="w-5 h-5" />,
    dimBadge: '2x3м',
  },
  {
    type: BuildingPieceType.GLASS_WALL_1X3,
    category: PieceCategory.GREENHOUSE,
    slot: 2,
    icon: <Columns className="w-5 h-5" />,
    dimBadge: '1x3м',
  },
  {
    type: BuildingPieceType.GLASS_DOORWAY_1X3,
    category: PieceCategory.GREENHOUSE,
    slot: 3,
    icon: <DoorOpen className="w-5 h-5" />,
    dimBadge: 'Вхід',
  },
  {
    type: BuildingPieceType.GLASS_DOOR_1X3,
    category: PieceCategory.GREENHOUSE,
    slot: 4,
    icon: <DoorClosed className="w-5 h-5" />,
    dimBadge: 'Двері',
  },
  {
    type: BuildingPieceType.GLASS_ROOF_GABLE_2X2,
    category: PieceCategory.GREENHOUSE,
    slot: 5,
    icon: <Home className="w-5 h-5" />,
    dimBadge: '2-похилий',
  },
  {
    type: BuildingPieceType.GLASS_ROOF_SHED_2X2,
    category: PieceCategory.GREENHOUSE,
    slot: 6,
    icon: <Home className="w-5 h-5" />,
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


const CARD_LABEL = 'text-[9px] font-bold leading-[1.15] text-center px-1 w-full line-clamp-2 break-words';

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
  onConfirmAll,
  onSetRoofStyle,
  onSelectHouseRoofTool,
  onDormerAction,
}) => {
  useLang();
  const { selectedPieceType, snappingEnabled, isValidPlacement, aimingAtPieceId } = telemetry;
  const [activeCategory, setActiveCategory] = useState<PieceCategory | 'ALL'>('ALL');
  const [open, setOpen] = useState(true);
  const roofStyle = telemetry.currentRoofStyle ?? DEFAULT_ROOF_STYLE;
  const touch = typeof document !== 'undefined' && document.documentElement.classList.contains('touch-ui');

  const filteredPieces = useMemo(
    () => (activeCategory === 'ALL' ? PIECE_ITEMS : PIECE_ITEMS.filter((item) => item.category === activeCategory)),
    [activeCategory]
  );
  const unconfirmed =
    (telemetry.unconfirmedWallsCount ?? 0) + (telemetry.unconfirmedFloorsCount ?? 0) + (telemetry.unconfirmedFoundationsCount ?? 0);
  const inHand = !!selectedPieceType || !!telemetry.houseRoofTool || !!telemetry.dormer?.tool;
  const selectedItem = PIECE_ITEMS.find((i) => i.type === selectedPieceType);

  // One line under the crosshair about what is aimed at
  let status: { tone: 'ok' | 'bad' | 'info'; text: string; icon?: React.ReactNode };
  if (telemetry.houseRoofTool) status = { tone: 'info', text: t('bui.houseRoof'), icon: <Home className="w-3.5 h-3.5" /> };
  else if (selectedPieceType)
    status = isValidPlacement
      ? { tone: 'ok', text: t('bui.ready'), icon: <CheckCircle2 className="w-3.5 h-3.5" /> }
      : { tone: 'bad', text: telemetry.placementReason || t('build.blocked'), icon: <AlertCircle className="w-3.5 h-3.5" /> };
  else if (telemetry.selectedWallId) status = { tone: 'info', text: t('bui.selected') };
  else if (aimingAtPieceId) status = { tone: 'bad', text: t(touch ? 'bui.targetTouch' : 'bui.target'), icon: <Trash2 className="w-3.5 h-3.5" /> };
  else status = { tone: 'info', text: t('bui.pickPiece') };

  const showRoofStyles =
    activeCategory === PieceCategory.ROOFS || (!!selectedPieceType && selectedPieceType.startsWith('ROOF_')) || !!telemetry.isRoofSelected;

  const sectionTitle = 'font-bold text-[#a08d70] uppercase tracking-wider text-[10px] mr-1';
  const extra = (
    <>
      {showRoofStyles && onSetRoofStyle && (
        <ShelfSection>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={sectionTitle}>{t('build.roofTexture')}</span>
            {ROOF_STYLES.map((style) => (
              <Chip key={style} active={roofStyle === style} onClick={() => onSetRoofStyle(style)}>
                <span className="inline-block h-2.5 w-2.5 mr-1.5 rounded-sm" style={{ backgroundColor: ROOF_SWATCHES[style] }} aria-hidden="true" />
                {t(`build.roofStyle.${style}`)}
              </Chip>
            ))}
          </div>
        </ShelfSection>
      )}
      {telemetry.dormer &&
        onDormerAction &&
        (() => {
          const d = telemetry.dormer;
          const hint = d.hint ?? (d.editing ? t('build.dormer.editing') : d.count > 0 && !d.tool ? t('build.dormer.clickToEdit') : null);
          const stepper = (label: TKey, value: number, kind: 'width' | 'height') => (
            <div className="flex items-center gap-1">
              <span className="text-[#a08d70] font-bold">{t(label)}</span>
              <Chip onClick={() => onDormerAction({ kind, delta: -1 })}>−</Chip>
              <span className="min-w-[3.2rem] text-center font-bold tabular-nums">{t('build.dormer.metres', { v: value.toFixed(1) })}</span>
              <Chip onClick={() => onDormerAction({ kind, delta: 1 })}>+</Chip>
            </div>
          );
          return (
            <ShelfSection>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className={sectionTitle}>
                  {t('build.dormer.title')}
                  {d.count > 0 ? ` · ${d.count}` : ''}
                </span>
                <Chip active={d.tool} onClick={() => onDormerAction({ kind: 'tool' })}>
                  {t(d.tool ? 'build.dormer.stop' : 'build.dormer.place')}
                </Chip>
                {d.editing && (
                  <>
                    <Chip danger onClick={() => onDormerAction({ kind: 'delete' })}>
                      {t('build.dormer.delete')}
                    </Chip>
                    <Chip onClick={() => onDormerAction({ kind: 'done' })}>{t('build.dormer.done')}</Chip>
                  </>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {DORMER_STYLES.map((style) => (
                  <Chip key={style} active={d.style === style} onClick={() => onDormerAction({ kind: 'style', style })}>
                    {t(`build.dormer.style.${style}` as TKey)}
                  </Chip>
                ))}
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {stepper('build.dormer.width', d.width, 'width')}
                {stepper('build.dormer.height', d.height, 'height')}
              </div>
              {hint && <div className="text-[#a08d70]">{hint}</div>}
            </ShelfSection>
          );
        })()}
    </>
  );

  return (
    <div className="pointer-events-none absolute inset-0 select-none overflow-hidden z-30">
      <ModeBar
        tab="build"
        onTab={(tab) => tab === 'paint' && onTogglePaintMode?.()}
        onDone={onToggleBuildMode}
        confirm={{ count: unconfirmed, onClick: onConfirmAll || onConfirmWalls }}
      />

      <Crosshair />
      <AimStatus tone={status.tone}>
        {status.icon}
        <span className="truncate">{status.text}</span>
      </AimStatus>

      <ToolColumn>
        <ToolButton label={t('bui.rotate')} hotkey="R" onClick={onRotatePiece}>
          <RotateCw className="w-5 h-5" />
        </ToolButton>
        <ToolButton label={t('bui.snap')} hotkey="V" active={snappingEnabled} onClick={onToggleSnap}>
          <Magnet className="w-5 h-5" />
        </ToolButton>
        <ToolButton label={t('bui.demolish')} hotkey="X" tone="danger" disabled={!aimingAtPieceId} onClick={onDemolish}>
          <Trash2 className="w-5 h-5" />
        </ToolButton>
      </ToolColumn>

      <PrimaryAction label={t('bui.place')} disabled={!inHand || (!!selectedPieceType && !isValidPlacement)} onPress={onPlace}>
        <Hammer className="w-7 h-7" />
      </PrimaryAction>

      <Shelf
        tabs={CATEGORY_TABS.map((tab) => ({ id: tab.id, label: t(tab.name as TKey), icon: tab.icon }))}
        active={activeCategory}
        onTab={(id) => setActiveCategory(id as PieceCategory | 'ALL')}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        extra={extra}
        current={
          selectedItem && (
            <span className="shrink-0 hidden sm:flex items-center gap-1.5 h-9 px-3 rounded-full bg-amber-100 text-xs font-bold text-[#7a5a35] [&_svg]:w-4 [&_svg]:h-4">
              {selectedItem.icon}
              <span className="truncate max-w-[12rem]">{localName(BUILDING_PIECES[selectedItem.type])}</span>
            </span>
          )
        }
      >
        {filteredPieces.map((item) => {
          const def = BUILDING_PIECES[item.type];
          return (
            <ShelfCard key={item.type} selected={selectedPieceType === item.type} title={localName(def)} onClick={() => onSelectPiece(item.type)}>
              <span className="absolute top-1 right-1.5 text-[9px] font-bold text-[#a08d70]">🌲{def?.woodCost}</span>
              <span className="text-[#7a5a35] [&_svg]:w-6 [&_svg]:h-6 touch:[&_svg]:w-5 touch:[&_svg]:h-5 mt-2">{item.icon}</span>
              <span className={`${CARD_LABEL} mt-0.5 text-[#4a3b2a]`}>{localName(def)}</span>
            </ShelfCard>
          );
        })}
        {onSelectHouseRoofTool &&
          (activeCategory === 'ALL' || activeCategory === PieceCategory.ROOFS) &&
          HOUSE_ROOF_ITEMS.map((item) => (
            <ShelfCard
              key={`house-roof-${item.kind}`}
              accent
              selected={telemetry.houseRoofTool === item.kind}
              title={t('build.houseRoof.toolTitle')}
              onClick={() => onSelectHouseRoofTool(item.kind)}
            >
              <span className="absolute top-1 right-1.5 text-[9px] font-bold text-amber-700">{t('build.houseRoof.badge')}</span>
              <span className="text-amber-700 [&_svg]:w-6 [&_svg]:h-6 touch:[&_svg]:w-5 touch:[&_svg]:h-5 mt-2">{item.icon}</span>
              <span className={`${CARD_LABEL} mt-0.5 text-[#4a3b2a]`}>{t(item.name)}</span>
            </ShelfCard>
          ))}
      </Shelf>
    </div>
  );
};
