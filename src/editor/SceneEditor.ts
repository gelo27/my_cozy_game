import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { GameWorld } from '../engine/GameEngine';
import { BUILDING_PIECES } from '../building/config/BuildingPiecesConfig';
import { ROOF_STYLES, type RoofStyle } from '../building/ProceduralRoofSystem';
import type { BuildingPieceType } from '../building/types/BuildingTypes';
import { WORKER_ROLES, type WorkerRole } from '../npc/TaskBoard';
import { PROP_DEF_MAP, PROP_DEFS } from '../world/PropSystem';
import { ROCK_TYPES, type RockKind } from '../gathering/GatheringConfig';
import { worldSettings } from '../world/WorldSettings';
import { WEATHER_LABELS, type WeatherType } from '../world/WeatherSystem';
import { NIGHT_LIGHT_MODES, nightLightSettings, setNightLightMode, type NightLightMode } from '../world/NightLighting';
import { PEST_KINDS, type PestKind } from '../gameplay/Pests';
import { CROP_DEFINITIONS, type CropStage, type CropType } from '../farming/types/FarmingTypes';
import { FIELD_CELLS } from '../farming/FieldManager';
import { waterLevelAt } from '../world/rivers/RiverWorld';

export const sceneCategories = ['Декор', 'Будівлі', 'Грядки', 'Персонажі', 'Істоти', 'Ресурси', 'Рослинність', 'Рельєф', 'Вода', 'Світло', 'Печери', 'Ефекти'] as const;
export const MAX_FIELD_AREA_SIDE = 20;
export type FieldAreaAnchor = { x: number; z: number };

export function fieldAreaBounds(anchor: FieldAreaAnchor, point: THREE.Vector3) {
  const dx = Math.floor((point.x - anchor.x) / FIELD_CELLS);
  const dz = Math.floor((point.z - anchor.z) / FIELD_CELLS);
  const maxOffset = MAX_FIELD_AREA_SIDE - 1;
  const x = THREE.MathUtils.clamp(dx, -maxOffset, maxOffset);
  const z = THREE.MathUtils.clamp(dz, -maxOffset, maxOffset);
  return {
    gx: anchor.x + Math.min(0, x) * FIELD_CELLS,
    gz: anchor.z + Math.min(0, z) * FIELD_CELLS,
    columns: Math.abs(x) + 1,
    rows: Math.abs(z) + 1,
    tooLarge: x !== dx || z !== dz,
  };
}
type Category = typeof sceneCategories[number];
type Transform = { position: THREE.Vector3; yaw?: number; scale?: number; grounded?: boolean };
export type SceneProperty = {
  label: string;
  value: number | string;
  options?: readonly (readonly [string, string])[];
  set?: (value: string) => void;
};

export interface SceneEntry {
  id: string;
  name: string;
  category: Category;
  transform: () => Transform | null;
  move?: (value: Transform) => boolean;
  properties?: () => SceneProperty[];
  propId?: number;
  pickRadius?: number;
  pickPosition?: () => THREE.Vector3;
  canPick?: () => boolean;
  show?: (visible: boolean) => void;
  object?: THREE.Object3D;
}

export const sceneCatalog = [
  ...PROP_DEFS.map((def) => ({ id: `prop:${def.id}`, label: def.name, category: 'Декор і рослини' })),
  ...Object.values(BUILDING_PIECES).map((def) => ({ id: `piece:${def.type}`, label: def.ukrainianName, category: 'Деталі будівель' })),
  ...Object.entries(ROCK_TYPES).map(([kind, def]) => ({ id: `rock:${kind}`, label: def.name, category: 'Ресурси' })),
  { id: 'worker:new', label: 'Працівник', category: 'Персонажі' },
];

const pestNames: Record<PestKind, string> = { hedgehog: 'Їжак', dragon: 'Дракончик', shark: 'Акула', spider: 'Павук' };
sceneCatalog.push(...PEST_KINDS.map((kind) => ({ id: `pest:${kind}`, label: pestNames[kind], category: 'Істоти' })));

export class SceneEditor {
  private readonly building;
  private readonly workers;
  private readonly workersInTree = new Map<number, object>();
  private readonly petsInTree = new Set<object>();
  private revisions: number[] = [];
  private entries: SceneEntry[] = [];
  private pickables: SceneEntry[] = [];
  private readonly hit = new THREE.Vector3();
  private readonly sphere = new THREE.Sphere();

  constructor(private readonly world: GameWorld) {
    this.building = world.character.buildAbility.buildingManager!;
    this.workers = world.gameplay.workers;
  }

  public list(): readonly SceneEntry[] {
    const w = this.world;
    const workers = this.workers?.workers ?? [];
    const pets = w.gameplay.pets.pets;
    const { props, rocks } = w;
    const fields = w.farmingManager.fields;
    const next = [props.editorTopologyRevision, this.building.revision, rocks.editorRevision, w.gameplay.pests.revision,
      workers.length, pets.length, fields.editorRevision];
    if (next.every((value, i) => value === this.revisions[i]) &&
        workers.every((worker) => this.workersInTree.get(worker.slot) === worker) &&
        pets.every((pet) => this.petsInTree.has(pet))) return this.entries;
    this.revisions = next;
    this.workersInTree.clear();
    this.petsInTree.clear();
    const entries: SceneEntry[] = [];

    for (const field of fields.getAll()) {
      const { gx, gz } = field;
      entries.push({
        id: `field:${gx}:${gz}`, name: `Грядка (${gx}, ${gz})`, category: 'Грядки',
        transform: () => {
          const current = fields.fieldContaining(gx + 0.5, gz + 0.5);
          return current ? { position: current.center.clone() } : null;
        },
        properties: () => {
          const crop = fields.fieldContaining(gx + 0.5, gz + 0.5)?.crop;
          return crop ? [
            { label: 'Культура', value: CROP_DEFINITIONS[crop.cropType].nameUk },
            { label: 'Стадія росту', value: `${crop.stage}/3` },
            { label: 'Полито', value: crop.isWatered ? 'Так' : 'Ні' },
          ] : [{ label: 'Культура', value: 'Порожньо' }];
        },
      });
    }

    for (const prop of props.list()) {
      const { id, type } = prop;
      const def = PROP_DEF_MAP.get(type);
      entries.push({
        id: `prop:${id}`, name: def?.name ?? type, category: def?.category === 'nature' ? 'Рослинність' : 'Декор',
        propId: props.isEditorProp(id) ? id : undefined,
        transform: () => {
          const current = props.get(id);
          return current ? { position: current.position.clone(), yaw: current.rotationY, scale: current.scale, grounded: current.grounded } : null;
        },
        move: props.isEditorProp(id) ? ({ position, yaw, scale, grounded }) => {
          const current = props.get(id);
          if (!current) return false;
          current.grounded = grounded ?? false;
          props.setTransform(id, position, yaw ?? current.rotationY, scale ?? current.scale, current.tilt);
          return true;
        } : undefined,
        properties: () => [{ label: 'Тип об’єкта', value: type }],
        show: props.canHideInEditor(id) ? (visible) => props.setEditorHidden(id, !visible) : undefined,
      });
    }
    for (const piece of this.building.getAllPieces()) {
      const { id, type } = piece;
      entries.push({
        id: `piece:${id}`, name: BUILDING_PIECES[type].ukrainianName, category: 'Будівлі',
        transform: () => {
          const current = this.building.getPiece(id);
          return current ? { position: current.position.clone(), yaw: current.rotation.y } : null;
        },
        move: ({ position, yaw }) => this.building.setPieceTransform(id, position, yaw ?? 0),
        properties: () => {
          const current = this.building.getPiece(id);
          if (!current) return [];
          const properties: SceneProperty[] = [{ label: 'Тип деталі', value: type }, { label: 'Міцність', value: current.health }];
          if (current.roofStyle) properties.push({
            label: 'Покриття даху', value: current.roofStyle,
            options: ROOF_STYLES.map((style) => [style, style] as const),
            set: (style) => {
              const next = style as RoofStyle;
              if (!ROOF_STYLES.includes(next) || next === current.roofStyle) return;
              w.editor.trackChange('Покриття даху', () => this.building.getPiece(id)?.roofStyle,
                (value) => { if (value) this.building.setRoofStyle(id, value); });
              this.building.setRoofStyle(id, next);
            },
          });
          return properties;
        },
      });
    }
    for (const worker of workers) {
      const { slot } = worker;
      this.workersInTree.set(slot, worker);
      const current = () => this.workers?.workers.find((entry) => entry.slot === slot);
      entries.push({
        id: `worker:${slot}`, name: worker.name, category: 'Персонажі',
        transform: () => {
          const npc = current();
          return npc ? { position: npc.getFeet() } : null;
        },
        move: ({ position }) => {
          const npc = current();
          if (!npc) return false;
          npc.setEditorPosition(position);
          return true;
        },
        pickRadius: 0.55,
        pickPosition: () => current()?.getPosition() ?? worker.getPosition(),
        object: worker.model.group,
        properties: () => {
          const npc = current();
          if (!npc) return [];
          return [{
            label: 'Роль', value: npc.role, options: WORKER_ROLES.map((role) => [role, this.workers!.roleLabel(role)] as const),
            set: (role) => {
              const next = role as WorkerRole;
              if (!WORKER_ROLES.includes(next) || next === npc.role) return;
              w.editor.trackChange('Роль працівника', () => current()?.role, (value) => { if (value) current()?.setRole(value); });
              npc.setRole(next);
            },
          }, { label: 'Енергія', value: Math.round(npc.energy) }];
        },
      });
    }
    for (const [index, pet] of pets.entries()) {
      this.petsInTree.add(pet);
      entries.push(this.node(`pet:${index}`, pet.name, 'Істоти', pet.group, 0.5));
    }
    const visibleAuthorIds = new Set<number>();
    for (const pest of w.gameplay.pests.pests) {
      const authored = w.gameplay.pests.authoredId(pest);
      if (authored !== undefined) visibleAuthorIds.add(authored);
      entries.push({
        ...this.node(authored === undefined ? `wild:${pest.id}` : `pest:${authored}`, pestNames[pest.kind], 'Істоти', pest.group, pest.hitRadius),
        transform: () => {
          const spawn = authored === undefined ? undefined : w.gameplay.pests.getAuthored(authored);
          return spawn ? { position: new THREE.Vector3(...spawn.position) } : { position: pest.group.position.clone() };
        },
        move: authored === undefined || pest.kind === 'spider' ? undefined
          : ({ position }) => w.gameplay.pests.moveAuthored(authored, position),
        pickPosition: () => pest.hitPoint(new THREE.Vector3()),
        properties: () => [{ label: 'Здоров’я', value: Math.ceil(pest.health) }],
      });
    }
    for (const spawn of w.gameplay.pests.serializeAuthored()) {
      if (visibleAuthorIds.has(spawn.id)) continue;
      entries.push({
        id: `pest:${spawn.id}`, name: pestNames[spawn.kind], category: 'Істоти',
        transform: () => {
          const current = w.gameplay.pests.getAuthored(spawn.id);
          return current ? { position: new THREE.Vector3(...current.position) } : null;
        },
        properties: () => [{ label: 'Стан', value: 'Точка появи' }],
      });
    }
    for (const rock of rocks.editorNodes) {
      const current = () => rocks.byId(rock.id);
      entries.push({
        id: `rock:${rock.id}`, name: ROCK_TYPES[rock.kind].name, category: 'Ресурси',
        transform: () => {
          const node = current();
          return node ? { position: node.position.clone() } : null;
        },
        move: rocks.isAuthoredRock(rock.id) ? ({ position }) => rocks.moveAuthoredRock(rock.id, position) : undefined,
        pickRadius: rock.radius,
        canPick: () => !rock.isDepleted,
        pickPosition: () => rock.position.clone().add(new THREE.Vector3(0, rock.radius * 0.5, 0)),
        properties: () => [{ label: 'Міцність', value: rock.health }, { label: 'Стан', value: rock.isDepleted ? 'Видобуто' : 'Доступний' }],
      });
    }
    entries.push(
      { id: 'player', name: 'Гравець', category: 'Персонажі', object: w.character.model.group, pickRadius: 0.55,
        transform: () => ({ position: w.character.getPosition() }) },
      { id: 'vehicle', name: 'Пікап', category: 'Персонажі', pickRadius: 1.4,
        transform: () => ({ position: w.vehicle.getPosition() }) },
      { id: 'moped', name: 'Мопед', category: 'Персонажі', pickRadius: 0.7,
        transform: () => ({ position: w.moped.getPosition() }) },
      { id: 'boat', name: 'Човен', category: 'Персонажі', pickRadius: 1.4,
        transform: () => ({ position: w.boat.getPosition() }) },
      { id: 'terrain', name: 'Острів', category: 'Рельєф', transform: () => null,
        properties: () => [{ label: 'Версія рельєфу', value: w.terrain.revision }] },
      { ...this.node('sea', 'Море', 'Вода', w.water.mesh), properties: () => [
        this.number('Рівень води', () => worldSettings.waterLevel, (value) => { worldSettings.waterLevel = value; }, -6, 4),
      ] },
      this.node('rivers', 'Мережа річок', 'Вода', w.rivers.group),
      { ...this.node('sun', 'Сонце й небо', 'Світло', w.weather.sun), properties: () => [
        this.number('Година', () => worldSettings.timeOfDay, (value) => { worldSettings.timeOfDay = value; }, 0, 23.99),
        { label: 'Режим нічного світла', value: nightLightSettings.mode,
          options: NIGHT_LIGHT_MODES.map((mode) => [mode, mode] as const),
          set: (value) => {
            const mode = value as NightLightMode;
            if (!NIGHT_LIGHT_MODES.includes(mode) || mode === nightLightSettings.mode) return;
            w.editor.trackChange('Режим нічного світла', () => nightLightSettings.mode, setNightLightMode);
            setNightLightMode(mode);
          },
        },
        { label: 'Погода', value: w.weather.weather, options: Object.entries(WEATHER_LABELS), set: (value) => {
          if (!Object.hasOwn(WEATHER_LABELS, value) || w.weather.weather === value) return;
          w.editor.trackChange('Погода', () => ({
            type: w.weather.weather, director: w.weather.director.serialize(),
          }), (state) => {
            w.weather.setWeather(state.type);
            w.weather.director.deserialize(state.type, state.director);
          });
          w.weather.setWeather(value as WeatherType);
        } },
      ] },
      this.node('grass', 'Трав’яний покрив', 'Рослинність', w.grass.mesh),
      this.node('caves', 'Мережа печер', 'Печери', w.exploration.caveNetwork.group),
      this.node('particles', 'Частинки', 'Ефекти', w.particleManager.group),
    );
    if (w.gameplay.companion) {
      entries.push(this.node('companion', w.gameplay.companion.name, 'Персонажі', w.gameplay.companion.model.group, 0.6));
    }
    this.entries = entries;
    this.pickables = entries.filter((entry) => entry.pickRadius !== undefined);
    return entries;
  }

  private node(id: string, name: string, category: Category, object: THREE.Object3D, pickRadius?: number): SceneEntry {
    return { id, name, category, object, pickRadius, transform: () => ({ position: object.getWorldPosition(new THREE.Vector3()) }) };
  }

  private number(label: string, get: () => number, set: (value: number) => void, min: number, max: number): SceneProperty {
    return { label, value: get(), set: (input) => {
      const value = Number(input);
      if (!Number.isFinite(value) || value < min || value > max || value === get()) return;
      this.world.editor.trackChange(label, get, set);
      set(value);
    } };
  }

  public pick(raycaster: THREE.Raycaster, hidden: ReadonlySet<string>): string | null {
    const ray = raycaster.ray;
    const ground = this.world.terrain.raycast(ray, 300, this.hit);
    const field = ground ? this.world.farmingManager.fields.fieldContaining(this.hit.x, this.hit.z) : null;
    let distance = ground ? ray.origin.distanceTo(this.hit) + 0.05 : 300;
    let picked: string | null = null;
    const offer = (id: string, at: number) => {
      if (at > distance || hidden.has(id)) return;
      picked = id;
      distance = at;
    };
    const hit = this.world.props.pick(raycaster);
    if (hit) offer(`prop:${hit.id}`, hit.distance);
    const piece = this.building.findPieceUnderRay(ray.origin, ray.direction, distance);
    if (piece?.worldBoundingBox) {
      const point = ray.intersectBox(piece.worldBoundingBox, this.hit);
      if (point) offer(`piece:${piece.id}`, point.distanceTo(ray.origin));
    }
    this.list();
    for (const entry of this.pickables) {
      if (!entry.pickRadius || entry.object?.visible === false || hidden.has(entry.id) || entry.canPick?.() === false) continue;
      const center = entry.pickPosition?.() ?? entry.transform()?.position;
      if (!center) continue;
      this.sphere.set(center, entry.pickRadius);
      const point = ray.intersectSphere(this.sphere, this.hit);
      if (point) offer(entry.id, point.distanceTo(ray.origin));
    }
    return picked ?? (field ? `field:${field.gx}:${field.gz}` : ground ? 'terrain' : null);
  }

  public placeCabin(point: THREE.Vector3): { id: string } | { error: string } {
    const { terrain, physics, editor } = this.world;
    let low = Infinity;
    let high = -Infinity;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = point.x + dx, z = point.z + dz;
        const y = terrain.getHeight(x, z);
        if (!terrain.isInside(x, z) || y <= waterLevelAt(x, z) + 0.1) return { error: 'Для хатини потрібна суха ділянка.' };
        low = Math.min(low, y);
        high = Math.max(high, y);
      }
    }
    if (high - low > 0.3) return { error: 'Майданчик надто похилий. Вирівняй рельєф.' };
    if (this.world.farmingManager.fields.getAll().some(({ gx, gz }) =>
      gx < point.x + 2 && gx + FIELD_CELLS > point.x - 2 && gz < point.z + 2 && gz + FIELD_CELLS > point.z - 2)) {
      return { error: 'На майданчику є грядка.' };
    }
    const obstacle = physics.world.intersectionWithShape(
      { x: point.x, y: high + 1.8, z: point.z },
      { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Cuboid(2.1, 1.7, 2.1),
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined, undefined, undefined, (collider) => collider.shape.type !== RAPIER.ShapeType.HeightField,
    );
    if (obstacle) return { error: 'На майданчику є перешкода.' };
    const origin = new THREE.Vector3(point.x, Math.max(0.15, high), point.z);
    const pieces = this.building.spawnStarterVikingCabin(origin);
    if (!pieces.length) return { error: 'Гра відхилила розміщення деталей хатини.' };
    const template = pieces.map(({ id, type, position, quaternion, roofStyle }) => ({
      id, type, position: position.clone(), quaternion: quaternion.clone(), roofStyle,
    }));
    editor.recordChange('Створення тестової хатини', () => this.building.getPiece(template[0].id) !== null, (present) => {
      if (!present) {
        for (const piece of template) this.building.demolishPiece(piece.id);
        return;
      }
      const restored = template.flatMap(({ id, type, position, quaternion, roofStyle }) => {
        const piece = this.building.placePiece(type, position, quaternion, id, true);
        if (!piece) return [];
        if (roofStyle && piece.roofStyle !== roofStyle) this.building.setRoofStyle(id, roofStyle);
        return [piece];
      });
      this.building.continuousWallSystem.confirmPieces(restored);
    }, false);
    return { id: `piece:${template[0].id}` };
  }

  public editField(point: THREE.Vector3, action: 'dig' | 'plant' | 'water' | 'clear' | 'remove',
    cropType: CropType, stage: CropStage): { id: string | null } | { error: string } {
    const { farmingManager, editor } = this.world;
    const { fields } = farmingManager;
    const existing = fields.fieldContaining(point.x, point.z);
    if (!existing && action !== 'dig' && action !== 'plant') return { error: 'Клацни на наявну грядку.' };
    if (existing && action === 'dig') return { error: 'Тут уже є грядка.' };
    if (existing?.crop && action === 'plant') return { error: 'Ця грядка вже засіяна. Спершу очисть її.' };
    let gx: number, gz: number;
    if (existing) {
      ({ gx, gz } = existing);
    } else {
      const target = fields.resolveShovelTarget(point.x, point.z);
      if (target.kind !== 'dig' || target.reason) return { error: 'Потрібна рівна суха ділянка трави без перешкод.' };
      ({ gx, gz } = target);
    }
    const capture = () => fields.captureEditorField(gx, gz);
    const before = capture();
    const crop = action === 'plant' ? this.cropAtStage(cropType, stage) : null;
    if (!existing) {
      if (!fields.createField(gx, gz, crop)) return { error: 'Не вдалося створити грядку.' };
    } else if (action === 'water') {
      if (!farmingManager.water(existing.id)) return { error: 'Ця грядка зараз не потребує поливу.' };
    } else if (action === 'remove') {
      fields.removeField(existing.id);
    } else {
      if (action === 'clear' && !existing.crop) return { error: 'Грядка вже порожня.' };
      fields.restoreEditorField(gx, gz, { ...before!, crop });
    }
    const labels = { dig: 'Створення грядки', plant: 'Посів грядки', water: 'Полив грядки', clear: 'Очищення грядки', remove: 'Прибирання грядки' };
    editor.recordChange(labels[action], capture, (data) => fields.restoreEditorField(gx, gz, data), before);
    return { id: action === 'remove' ? null : `field:${gx}:${gz}` };
  }

  private cropAtStage(type: CropType, stage: CropStage) {
    const crop = this.world.farmingManager.newCrop(type);
    crop.stage = stage;
    if (stage === 3) crop.growthTimer = crop.stageDuration;
    return crop;
  }

  public fieldAreaAnchor(point: THREE.Vector3): FieldAreaAnchor {
    const field = this.world.farmingManager.fields.fieldContaining(point.x, point.z);
    return field
      ? { x: field.gx, z: field.gz }
      : { x: Math.round(point.x - FIELD_CELLS / 2), z: Math.round(point.z - FIELD_CELLS / 2) };
  }

  public sowFieldArea(anchor: FieldAreaAnchor, point: THREE.Vector3, cropType: CropType, stage: CropStage) {
    const area = fieldAreaBounds(anchor, point);
    if (area.tooLarge) return { error: `Обери до ${MAX_FIELD_AREA_SIDE} грядок уздовж кожної сторони.` };
    const { farmingManager: { fields }, editor } = this.world;
    const changed: { gx: number; gz: number }[] = [];
    const before: ReturnType<typeof fields.captureEditorField>[] = [];
    for (let row = 0; row < area.rows; row++) {
      for (let column = 0; column < area.columns; column++) {
        const gx = area.gx + column * FIELD_CELLS;
        const gz = area.gz + row * FIELD_CELLS;
        const existing = fields.getEditorFieldAtOrigin(gx, gz);
        if (existing?.crop || (!existing && !fields.canCreateEditorField(gx, gz))) continue;
        const previous = existing ? fields.captureEditorField(gx, gz) : null;
        const crop = this.cropAtStage(cropType, stage);
        if (existing && previous) fields.restoreEditorField(gx, gz, { ...previous, crop });
        else if (!fields.createField(gx, gz, crop)) continue;
        changed.push({ gx, gz });
        before.push(previous);
      }
    }
    if (!changed.length) return { error: 'На ділянці немає вільних грядок або придатної землі.' };
    editor.recordChange('Посів ділянки', () => changed.map(({ gx, gz }) => fields.captureEditorField(gx, gz)),
      (states) => changed.forEach(({ gx, gz }, index) => fields.restoreEditorField(gx, gz, states[index])), before);
    return { planted: changed.length, skipped: area.rows * area.columns - changed.length };
  }

  public edit(entries: readonly SceneEntry[], update: (value: Transform) => Transform): number {
    const changes = entries.flatMap((entry) => {
      const pose = entry.move && entry.transform();
      if (!pose) return [];
      const next = update(pose);
      if (next.position.toArray().some((coordinate) => !Number.isFinite(coordinate) || Math.abs(coordinate) > 3000)) return [];
      return [{ entry, next }];
    });
    if (!changes.length) return 0;
    const targets = changes.map(({ entry }) => entry);
    const snapshot = () => targets.map((entry) => entry.transform());
    const previous = snapshot();
    let count = 0;
    for (const { entry, next } of changes) {
      if (entry.move?.(next)) count++;
    }
    if (count) this.world.editor.recordChange(targets.length > 1 ? 'Переміщення групи' : 'Трансформація об’єкта', snapshot, (poses) => {
      poses.forEach((pose, i) => { if (pose) targets[i].move?.(pose); });
    }, previous);
    return count;
  }

  public canRemove(entry: SceneEntry): boolean {
    return entry.propId !== undefined || /^(piece|worker|pest):/.test(entry.id) ||
      (entry.id.startsWith('rock:') && this.world.rocks.isAuthoredRock(Number(entry.id.slice(5))));
  }

  private prepareStructure(kinds: ReadonlySet<string>, label: string, propIds: readonly number[] = []): () => void {
    const { props, editor } = this.world;
    const capture = () => ({
      props: propIds.map((id) => ({ id, data: props.captureEditorProp(id) })),
      pieces: kinds.has('piece') ? this.building.exportScene() : undefined,
      workers: kinds.has('worker') ? this.workers?.serialize() : undefined,
      rocks: kinds.has('rock') ? this.world.rocks.serializeAuthored() : undefined,
      pests: kinds.has('pest') ? this.world.gameplay.pests.serializeAuthored() : undefined,
    });
    const before = capture();
    return () => editor.recordChange(label, capture, (state) => {
      for (const { id, data } of state.props) props.restoreEditorProp(id, data);
      if (state.pieces) this.building.importScene(state.pieces);
      if (state.workers) this.workers?.deserialize(state.workers);
      if (state.rocks) this.world.rocks.restoreAuthored(state.rocks);
      if (state.pests) this.world.gameplay.pests.restoreAuthored(state.pests);
    }, before);
  }

  public remove(entries: readonly SceneEntry[]): void {
    const targets = entries.filter((entry) => this.canRemove(entry));
    if (!targets.length) return;
    const commit = this.prepareStructure(new Set(targets.map((entry) => entry.id.split(':')[0])), 'Видалення зі сцени',
      targets.flatMap((entry) => entry.propId === undefined ? [] : [entry.propId]));
    for (const { id } of targets) {
      const [kind, key] = id.split(':');
      if (kind === 'prop') this.world.props.remove(Number(key));
      if (kind === 'piece') this.building.demolishPiece(key);
      if (kind === 'rock') this.world.rocks.removeAuthoredRock(Number(key));
      if (kind === 'pest') this.world.gameplay.pests.removeAuthored(Number(key));
      if (kind === 'worker') {
        const worker = this.workers?.workers.find((entry) => entry.slot === Number(key));
        if (worker) this.workers?.remove(worker);
      }
    }
    commit();
  }

  public create(tool: string, point: THREE.Vector3, duplicate?: SceneEntry, normal?: THREE.Vector3): string | null {
    const [kind, key] = tool.split(':');
    if (!['prop', 'piece', 'worker', 'rock', 'pest'].includes(kind)) return null;
    const label = duplicate ? 'Дублювання' : 'Створення зі списку';
    if (kind === 'prop') {
      const source = duplicate?.propId !== undefined ? this.world.props.get(duplicate.propId) : undefined;
      const grounded = source?.grounded ?? true;
      const y = grounded ? this.world.terrain.getHeight(point.x, point.z) : point.y;
      const id = this.world.props.add(key, point.x, point.z, source?.rotationY, source?.scale, y, grounded,
        source?.length, source?.colors, source?.web, null, source?.tilt, source?.head);
      if (id === null) return null;
      const props = this.world.props;
      this.world.editor.recordChange(label, () => props.captureEditorProp(id), (data) => props.restoreEditorProp(id, data), null);
      return `prop:${id}`;
    }
    const commit = this.prepareStructure(new Set([kind]), label);
    if (kind === 'piece') {
      const source = duplicate ? this.building.getPiece(duplicate.id.slice(6)) : null;
      const piece = this.building.placePiece(key as BuildingPieceType, point, source?.quaternion ?? new THREE.Quaternion(), undefined, true);
      if (piece && source) this.building.copyPieceStyle(source.id, piece.id);
      if (piece) commit();
      return piece ? `piece:${piece.id}` : null;
    }
    if (kind === 'rock') {
      if (!Object.hasOwn(ROCK_TYPES, key)) return null;
      const source = duplicate ? this.world.rocks.byId(Number(duplicate.id.slice(5))) : null;
      const rock = this.world.rocks.addAuthoredRock(point, key as RockKind, source?.baseScale);
      if (rock) commit();
      return rock ? `rock:${rock.id}` : null;
    }
    if (kind === 'pest') {
      const pests = this.world.gameplay.pests;
      const existing = duplicate && pests.getAuthored(Number(duplicate.id.slice(5)));
      const up = normal ?? (existing && existing.normal ? new THREE.Vector3(...existing.normal) : undefined);
      const pest = pests.spawnAt(key as PestKind, point, !this.world.exploration.caveNetwork.contains(point), up);
      if (pest) commit();
      return pest ? `pest:${pests.authoredId(pest)}` : null;
    }
    const worker = this.workers?.spawn(point);
    if (worker) commit();
    return worker ? `worker:${worker.slot}` : null;
  }

  public duplicate(entry: SceneEntry): string | null {
    const position = entry.transform()?.position;
    if (!position) return null;
    position.x += 2;
    if (entry.propId !== undefined) {
      const prop = this.world.props.get(entry.propId);
      return prop ? this.create(`prop:${prop.type}`, position, entry) : null;
    }
    if (entry.id.startsWith('piece:')) {
      const piece = this.building.getPiece(entry.id.slice(6));
      return piece ? this.create(`piece:${piece.type}`, position, entry) : null;
    }
    if (entry.id.startsWith('worker:')) {
      const original = this.workers?.workers.find((worker) => worker.slot === Number(entry.id.slice(7)));
      const id = this.create('worker:new', position, entry);
      const copy = this.workers?.workers.find((worker) => `worker:${worker.slot}` === id);
      if (original && copy) copy.setRole(original.role);
      return id;
    }
    if (entry.id.startsWith('rock:')) {
      const rock = this.world.rocks.byId(Number(entry.id.slice(5)));
      return rock ? this.create(`rock:${rock.kind}`, position, entry) : null;
    }
    if (entry.id.startsWith('pest:')) {
      const pest = this.world.gameplay.pests.getAuthored(Number(entry.id.slice(5)));
      return pest ? this.create(`pest:${pest.kind}`, position, entry) : null;
    }
    return null;
  }
}
