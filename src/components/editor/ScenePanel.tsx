import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { GameEngine } from '../../engine/GameEngine';
import type { EditorTool } from '../../editor/EditorController';
import { SceneEditor, sceneCatalog, sceneCategories, fieldAreaBounds, MAX_FIELD_AREA_SIDE, type FieldAreaAnchor, type SceneEntry } from '../../editor/SceneEditor';
import { btn, chip, NumberField, Section } from './EditorWidgets';
import { CROP_DEFINITIONS, CROP_TYPES, type CropStage, type CropType } from '../../farming/types/FarmingTypes';
import { FIELD_CELLS } from '../../farming/FieldManager';

const fieldClass = 'min-w-0 rounded border border-white/10 bg-black/30 px-2 py-1 text-zinc-100 outline-none focus:border-sky-500';
const PAGE_SIZE = 30;
const axes = ['x', 'y', 'z'] as const;
const toolById: Partial<Record<string, EditorTool>> = { terrain: 'sculpt', rivers: 'river', caves: 'cave' };
const fieldActions = [
  ['dig', 'Зробити грядку'], ['plant', 'Посіяти'], ['water', 'Полити'],
  ['clear', 'Очистити посів'], ['remove', 'Прибрати грядку'],
] as const;
type FieldAction = typeof fieldActions[number][0];
type QuickTool = 'cabin' | 'sowArea' | FieldAction;

interface Props {
  engine: GameEngine;
  notice: (text: string, type?: 'success' | 'info' | 'warn') => void;
  openTool: (tool: EditorTool) => void;
  inspectProp: React.ReactNode;
}

export const ScenePanel: React.FC<Props> = ({ engine, notice, openTool, inspectProp }) => {
  const world = engine.world!;
  const { editor } = world;
  const bridge = useMemo(() => new SceneEditor(world), [world]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hidden, setHidden] = useState(new Set<string>());
  const [locked, setLocked] = useState(new Set<string>());
  const [catalog, setCatalog] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogPage, setCatalogPage] = useState(0);
  const [offset, setOffset] = useState(() => new THREE.Vector3());
  const [pending, setPending] = useState<string | null>(null);
  const [quickTool, setQuickTool] = useState<QuickTool | null>(null);
  const [cropType, setCropType] = useState<CropType>('wheat');
  const [cropStage, setCropStage] = useState<CropStage>(1);
  const [fieldAnchor, setFieldAnchor] = useState<FieldAreaAnchor | null>(null);
  const [fieldAreaLabel, setFieldAreaLabel] = useState('');
  const [technical, setTechnical] = useState(false);
  const entries = bridge.list();
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const groups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const groups = new Map<string, SceneEntry[]>();
    for (const entry of entries) {
      if (category && category !== entry.category) continue;
      if (normalized && !`${entry.name} ${entry.id} ${entry.category}`.toLocaleLowerCase().includes(normalized)) continue;
      const group = groups.get(entry.category);
      if (group) group.push(entry);
      else groups.set(entry.category, [entry]);
    }
    return sceneCategories.flatMap((name) => (groups.get(name) ?? []).map((entry, index) => ({ entry, heading: index === 0 })));
  }, [entries, category, query]);
  const selected = selectedIds.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
  const primary = selected.length === 1 ? selected[0] : undefined;
  const pose = primary?.transform();
  const hideCleanup = useRef(new Map<string, NonNullable<SceneEntry['show']>>());
  useEffect(() => () => {
    hideCleanup.current.forEach((show) => show(true));
    hideCleanup.current.clear();
    editor.select(null);
  }, [world]);

  useEffect(() => {
    if (!fieldAnchor || quickTool !== 'sowArea') return;
    const scene = engine.getEditorScene();
    const positions = new THREE.BufferAttribute(new Float32Array(MAX_FIELD_AREA_SIDE * 4 * 3), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry().setAttribute('position', positions);
    const material = new THREE.LineBasicMaterial({ color: 0x5eead4, depthTest: false, depthWrite: false });
    const outline = new THREE.LineLoop(geometry, material);
    outline.name = 'Контур ділянки';
    outline.visible = false;
    outline.frustumCulled = false;
    outline.renderOrder = 30;
    scene.add(outline);
    let previous: ReturnType<typeof fieldAreaBounds> | null = null;
    editor.sceneHover = (point) => {
      outline.visible = point !== null;
      if (!point) return;
      const area = fieldAreaBounds(fieldAnchor, point);
      if (previous && area.gx === previous.gx && area.gz === previous.gz && area.columns === previous.columns &&
          area.rows === previous.rows && area.tooLarge === previous.tooLarge) return;
      previous = area;
      const { gx, gz, columns, rows, tooLarge } = area;
      const right = gx + columns * FIELD_CELLS;
      const back = gz + rows * FIELD_CELLS;
      let index = 0;
      const vertex = (x: number, z: number) => positions.setXYZ(index++, x, world.terrain.getHeight(x, z) + 0.15, z);
      for (let i = 0; i < columns; i++) vertex(gx + i * FIELD_CELLS, gz);
      for (let i = 0; i < rows; i++) vertex(right, gz + i * FIELD_CELLS);
      for (let i = 0; i < columns; i++) vertex(right - i * FIELD_CELLS, back);
      for (let i = 0; i < rows; i++) vertex(gx, back - i * FIELD_CELLS);
      geometry.setDrawRange(0, index);
      positions.needsUpdate = true;
      material.color.setHex(tooLarge ? 0xf87171 : 0x5eead4);
      setFieldAreaLabel(tooLarge ? `Максимум ${MAX_FIELD_AREA_SIDE} × ${MAX_FIELD_AREA_SIDE} за раз`
        : `${columns} × ${rows} · до ${columns * rows} грядок`);
    };
    return () => {
      editor.sceneHover = null;
      scene.remove(outline);
      geometry.dispose();
      material.dispose();
    };
  }, [editor, engine, fieldAnchor, quickTool, world]);

  useEffect(() => {
    if (quickTool !== 'sowArea') return;
    const cancel = (event: KeyboardEvent) => {
      if (event.code !== 'Escape') return;
      setFieldAnchor(null);
      setFieldAreaLabel('');
      if (!fieldAnchor) setQuickTool(null);
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [fieldAnchor, quickTool]);

  const attach = (entry?: SceneEntry, activeLocks = locked) => {
    if (!entry || activeLocks.has(entry.id) || hidden.has(entry.id)) {
      editor.select(null);
      return;
    }
    if (entry.propId !== undefined) {
      editor.select(entry.propId);
      return;
    }
    const initial = entry.transform();
    if (!initial || !entry.move) {
      editor.select(null);
      return;
    }
    const select = (position: THREE.Vector3, yaw?: number) => editor.selectSceneTransform(position, yaw, (next, angle, mode) => {
      const current = entry.transform();
      if (!current) return;
      if (mode === 'translate' ? !current.position.equals(next) : Math.abs((current.yaw ?? 0) - angle) > 1e-6) {
        if (!bridge.edit([entry], (before) => mode === 'translate'
          ? { ...before, position: next } : { ...before, yaw: angle })) notice('Трансформацію відхилено', 'warn');
      }
      const after = entry.transform();
      if (after) select(after.position, after.yaw);
    });
    select(initial.position, initial.yaw);
  };

  const choose = (id: string | null, additive: boolean) => {
    editor.set('tool', 'select');
    const next = id === null ? [] : additive
      ? selectedIds.includes(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id]
      : [id];
    setSelectedIds(next);
    const entry = next.length === 1 ? bridge.list().find((item) => item.id === next[0]) : undefined;
    attach(entry);
  };

  const editable = selected.filter((entry) => !locked.has(entry.id));
  const remove = () => {
    const targets = editable.filter((entry) => bridge.canRemove(entry));
    if (!targets.length || !window.confirm(`Видалити зі сцени: ${targets.length}?`)) return;
    bridge.remove(targets);
    choose(null, false);
  };
  const duplicate = () => {
    if (!primary || locked.has(primary.id)) return;
    const id = bridge.duplicate(primary);
    if (id) choose(id, false);
    else notice('Не вдалося дублювати об’єкт у цій точці', 'warn');
  };
  const createAt = (raycaster: THREE.Raycaster) => {
    if (!pending) return;
    const point = new THREE.Vector3();
    const ray = raycaster.ray;
    const ground = world.terrain.raycast(ray, 300, point);
    const cave = pending === 'pest:spider' ? world.physics.castRayAndGetNormal(ray.origin, ray.direction, 300) : null;
    let normal: THREE.Vector3 | undefined;
    if (cave) {
      const distance = cave.hit.timeOfImpact;
      if (!ground || distance < ray.origin.distanceTo(point)) {
        if (world.exploration.caveNetwork.contains(cave.point)) {
          point.copy(cave.point);
          normal = cave.normal;
        }
      }
    }
    if (!ground && !normal) {
      notice('Вкажи придатну поверхню для об’єкта', 'warn');
      return;
    }
    const id = bridge.create(pending, point, undefined, normal);
    if (!id) {
      notice('Об’єкт не можна створити в цій точці або досягнуто ліміту', 'warn');
      return;
    }
    setPending(null);
    choose(id, false);
  };

  const applyQuickTool = (raycaster: THREE.Raycaster, tool: QuickTool) => {
    const point = new THREE.Vector3();
    if (!world.terrain.raycast(raycaster.ray, 300, point)) {
      notice('Клацни поверхню острова.', 'warn');
      return;
    }
    if (tool === 'sowArea') {
      if (!fieldAnchor) {
        setFieldAnchor(bridge.fieldAreaAnchor(point));
        return;
      }
      const result = bridge.sowFieldArea(fieldAnchor, point, cropType, cropStage);
      if ('error' in result) {
        notice(result.error, 'warn');
        return;
      }
      const skipped = result.skipped ? ` · пропущені місця: ${result.skipped}` : '';
      notice(`Засіяно грядок: ${result.planted}${skipped}`, 'success');
      setFieldAnchor(null);
      setFieldAreaLabel('');
      return;
    }
    const result = tool === 'cabin' ? bridge.placeCabin(point) : bridge.editField(point, tool, cropType, cropStage);
    if ('error' in result) notice(result.error, 'warn');
    else {
      editor.select(null);
      setSelectedIds(result.id ? [result.id] : []);
    }
  };

  useEffect(() => {
    editor.scenePicking = (ray, additive) => {
      if (quickTool) applyQuickTool(ray, quickTool);
      else if (pending) createAt(ray);
      else choose(bridge.pick(ray, hidden), additive);
    };
    editor.sceneShortcut = (action) => action === 'delete' ? remove() : duplicate();
    editor.sceneSelectionRefresh = () => {
      const entry = selectedIds.length === 1 ? bridge.list().find((item) => item.id === selectedIds[0]) : undefined;
      if (!quickTool) attach(entry);
    };
    return () => {
      editor.scenePicking = null;
      editor.sceneShortcut = null;
      editor.sceneSelectionRefresh = null;
    };
  });

  const safeEdit = (update: (value: NonNullable<typeof pose>) => NonNullable<typeof pose>) => {
    if (bridge.edit(editable, update) < editable.filter((entry) => entry.move).length) {
      notice('Частину вибраних об’єктів не можна перемістити сюди', 'warn');
    }
    if (primary) attach(primary);
  };
  const changeLock = (entry: SceneEntry) => {
    const next = new Set(locked);
    if (next.has(entry.id)) next.delete(entry.id);
    else next.add(entry.id);
    setLocked(next);
    if (next.has(entry.id)) editor.select(null);
    else if (!hidden.has(entry.id)) attach(entry, next);
  };
  const changeVisibility = (entry: SceneEntry) => {
    if (!entry.show) return;
    const next = new Set(hidden);
    const wasHidden = next.delete(entry.id);
    if (wasHidden) hideCleanup.current.delete(entry.id);
    else {
      next.add(entry.id);
      hideCleanup.current.set(entry.id, entry.show);
    }
    entry.show(wasHidden);
    setHidden(next);
    if (entry.propId !== undefined) editor.select(wasHidden && !locked.has(entry.id) ? entry.propId : null);
  };
  const availableCatalog = useMemo(() => {
    if (!catalog) return [];
    const term = catalogQuery.trim().toLocaleLowerCase();
    return sceneCatalog.filter((item) => `${item.label} ${item.id} ${item.category}`.toLocaleLowerCase().includes(term));
  }, [catalog, catalogQuery]);
  const first = Math.min(page, Math.max(0, Math.ceil(groups.length / PAGE_SIZE) - 1));
  const armQuickTool = (tool: QuickTool) => {
    editor.set('tool', 'select');
    editor.select(null);
    setSelectedIds([]);
    setPending(null);
    setFieldAnchor(null);
    setFieldAreaLabel('');
    setQuickTool((current) => current === tool ? null : tool);
  };

  return <>
    <Section title="Швидкі перевірки">
      <button className={chip(quickTool === 'cabin')} aria-pressed={quickTool === 'cabin'} onClick={() => armQuickTool('cabin')}>Звести тестову хатину</button>
      <div className="grid grid-cols-2 gap-1">
        <select className={fieldClass} value={cropType} aria-label="Культура" onChange={(event) => setCropType(event.target.value as CropType)}>
          {CROP_TYPES.map((type) => <option key={type} className="bg-zinc-900" value={type}>{CROP_DEFINITIONS[type].nameUk}</option>)}
        </select>
        <select className={fieldClass} value={cropStage} aria-label="Стадія посіву" onChange={(event) => setCropStage(Number(event.target.value) as CropStage)}>
          <option className="bg-zinc-900" value={1}>Паростки</option>
          <option className="bg-zinc-900" value={2}>Росте</option>
          <option className="bg-zinc-900" value={3}>Стигле</option>
        </select>
      </div>
      <div className="flex flex-wrap gap-1">
        <button className={chip(quickTool === 'sowArea')} aria-pressed={quickTool === 'sowArea'}
          onClick={() => armQuickTool('sowArea')}>Засіяти ділянку</button>
        {fieldActions.map(([action, label]) => <button className={chip(quickTool === action)} key={action}
          aria-pressed={quickTool === action} onClick={() => armQuickTool(action)}>{label}</button>)}
      </div>
      {quickTool && <div className="flex items-center gap-1 text-sky-300">
        <span className="flex-1">{quickTool === 'sowArea'
          ? fieldAnchor ? `Клацни протилежний кут. ${fieldAreaLabel}` : 'Клацни перший кут ділянки.'
          : 'Клацай у світі, щоб застосувати інструмент.'}</span>
        <button className={chip(false)} onClick={() => {
          setQuickTool(null);
          setFieldAnchor(null);
          setFieldAreaLabel('');
          attach(primary);
        }}>Завершити</button>
      </div>}
    </Section>
    <Section title="Ієрархія сцени">
      <input className={fieldClass} value={query} placeholder="Назва, ID або категорія" aria-label="Пошук у сцені"
        onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
      <select className={fieldClass} value={category} aria-label="Категорія сцени" onChange={(event) => { setCategory(event.target.value); setPage(0); }}>
        <option className="bg-zinc-900" value="">Усі категорії</option>
        {sceneCategories.map((name) => <option className="bg-zinc-900" key={name}>{name}</option>)}
      </select>
      <p className="text-zinc-400">Клік у сцені або списку вибирає об’єкт. Shift додає до вибору, подвійний клік у списку наближає камеру.</p>
      <div className="max-h-52 overflow-auto">
        {groups.slice(first * PAGE_SIZE, (first + 1) * PAGE_SIZE).map(({ entry, heading }, index) => (
          <div key={entry.id}>
            {(heading || index === 0) && <div className="sticky top-0 bg-zinc-900 px-2 py-1 text-[10px] font-semibold text-zinc-400">{entry.category}</div>}
            <button type="button" aria-pressed={selectedIds.includes(entry.id)} title={entry.id}
              className={`${btn} w-full justify-start gap-1 px-2 py-1 text-left ${selectedIds.includes(entry.id) ? 'bg-sky-500/30' : 'hover:bg-white/10'}`}
              onClick={(event) => choose(entry.id, event.shiftKey)} onDoubleClick={() => {
                const position = entry.transform()?.position;
                if (position) editor.focusOn(position);
              }}>
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {hidden.has(entry.id) && <span className="text-[10px] text-zinc-400">приховано</span>}
              {locked.has(entry.id) && <span className="text-[10px] text-amber-300">замок</span>}
            </button>
          </div>
        ))}
        {!groups.length && <p className="px-2 py-1 text-zinc-400">Нічого не знайдено</p>}
      </div>
      <Paging page={first} count={groups.length} setPage={setPage} />
    </Section>
    {selected.length > 0 && <Section title={primary?.name ?? `Вибрано: ${selected.length}`}>
      <div className="flex flex-wrap gap-1">
        {pose && <button className={chip(false)} onClick={() => editor.focusOn(pose.position)}>Камера до об’єкта</button>}
        {primary && toolById[primary.id] && <button className={chip(false)} onClick={() => openTool(toolById[primary.id]!)}>Відкрити інструмент</button>}
        {primary?.move && <button className={chip(locked.has(primary.id))} onClick={() => changeLock(primary)}>{locked.has(primary.id) ? 'Розблокувати' : 'Заблокувати'}</button>}
        {primary?.show && <button className={chip(hidden.has(primary.id))} onClick={() => changeVisibility(primary)}>{hidden.has(primary.id) ? 'Показати' : 'Приховати'}</button>}
        {primary && editable.length > 0 && bridge.canRemove(primary) && <button className={chip(false)} onClick={duplicate}>Дублювати</button>}
        {editable.some((entry) => bridge.canRemove(entry)) && <button className={chip(false)} onClick={remove}>Видалити</button>}
      </div>
      {primary && pose && <div className="grid grid-cols-3 gap-1">
        {axes.map((axis) => primary.move && editable.length ? <NumberField key={axis} label={axis.toUpperCase()} value={pose.position[axis]}
          onCommit={(value) => safeEdit((before) => {
            before.position[axis] = value;
            if (before.grounded !== undefined && axis === 'y') before.grounded = false;
            if (before.grounded) before.position.y = world.terrain.getHeight(before.position.x, before.position.z);
            return before;
          })} /> : <span key={axis}>{axis.toUpperCase()} {pose.position[axis].toFixed(2)}</span>)}
        {primary.move && editable.length > 0 && pose.yaw !== undefined && <NumberField label="Поворот °" value={THREE.MathUtils.radToDeg(pose.yaw)}
          onCommit={(value) => safeEdit((before) => ({ ...before, yaw: THREE.MathUtils.degToRad(value) }))} />}
        {primary.move && editable.length > 0 && pose.scale !== undefined && <NumberField label="Масштаб" value={pose.scale}
          onCommit={(value) => safeEdit((before) => ({ ...before, scale: THREE.MathUtils.clamp(value, 0.1, 10) }))} />}
      </div>}
      {selected.length > 1 && editable.some((entry) => entry.move) && <>
        <div className="grid grid-cols-3 gap-1">
          {axes.map((axis) => <NumberField key={axis} label={`Δ${axis.toUpperCase()}`} value={offset[axis]} onCommit={(value) => {
            const next = offset.clone();
            next[axis] = value;
            setOffset(next);
          }} />)}
        </div>
        <button className={chip(true)} onClick={() => {
          if (!offset.lengthSq()) return;
          safeEdit((before) => {
            before.position.add(offset);
            if (before.grounded && offset.y === 0) before.position.y = world.terrain.getHeight(before.position.x, before.position.z);
            else if (before.grounded !== undefined) before.grounded = false;
            return before;
          });
          setOffset(new THREE.Vector3());
        }}>Перемістити вибрані</button>
      </>}
      {primary?.properties?.().map((property) => <div key={property.label} className="grid grid-cols-2 items-center gap-1">
        <span className="text-zinc-400">{property.label}</span>
        {property.set && editable.length && property.options ? <select className={fieldClass} aria-label={property.label} value={property.value}
          onChange={(event) => property.set?.(event.target.value)}>
          {property.options.map(([value, label]) => <option className="bg-zinc-900" key={value} value={value}>{label}</option>)}
        </select> : property.set && editable.length && typeof property.value === 'number' ? <NumberField label={property.label} value={property.value}
          onCommit={(value) => property.set?.(String(value))} /> : <span>{property.value}</span>}
      </div>)}
      {primary?.propId !== undefined && primary.id === `prop:${editor.state.selectedPropId}` && inspectProp}
    </Section>}
    <button className={chip(catalog)} aria-expanded={catalog} onClick={() => setCatalog(!catalog)}>Каталог створення</button>
    {catalog && <Section title="Додати об’єкт">
      <input className={fieldClass} value={catalogQuery} placeholder="Знайти в каталозі" aria-label="Пошук у каталозі"
        onChange={(event) => { setCatalogQuery(event.target.value); setCatalogPage(0); }} />
      {pending && <div className="flex items-center gap-1 text-sky-300">
        <span className="flex-1">Клацни поверхню у сцені.</span>
        <button className={chip(false)} onClick={() => setPending(null)}>Скасувати</button>
      </div>}
      <div className="max-h-40 overflow-auto">
        {availableCatalog.slice(catalogPage * PAGE_SIZE, (catalogPage + 1) * PAGE_SIZE).map((item) =>
          <button key={item.id} className={`${btn} w-full justify-between gap-2 px-1 py-1 text-left hover:bg-white/10`} aria-pressed={pending === item.id}
            onClick={() => { editor.set('tool', 'select'); setQuickTool(null); setPending(item.id); }}>
            <span className="truncate">{item.label}</span><span className="shrink-0 text-[9px] text-zinc-400">{item.category}</span>
          </button>)}
      </div>
      <Paging page={catalogPage} count={availableCatalog.length} setPage={setCatalogPage} />
    </Section>}
    <button className={chip(technical)} aria-expanded={technical} onClick={() => setTechnical(!technical)}>Вузли Three.js</button>
    {technical && <TechnicalTree root={engine.getEditorScene()} />}
  </>;
};

function Paging({ page, count, setPage }: { page: number; count: number; setPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  return <div className="flex items-center justify-between gap-1 text-zinc-400">
    <span>{count} · {page + 1}/{pages}</span>
    <div className="flex gap-1">
      <button className={chip(false)} disabled={page === 0} aria-label="Попередня сторінка" onClick={() => setPage(page - 1)}>‹</button>
      <button className={chip(false)} disabled={page + 1 >= pages} aria-label="Наступна сторінка" onClick={() => setPage(page + 1)}>›</button>
    </div>
  </div>;
}

function TechnicalTree({ root }: { root: THREE.Scene }) {
  const [path, setPath] = useState<THREE.Object3D[]>([root]);
  const [page, setPage] = useState(0);
  const detached = path.findIndex((node, index) => index > 0 && node.parent !== path[index - 1]);
  const activePath = detached < 0 ? path : path.slice(0, detached);
  const node = activePath.at(-1) ?? root;
  const first = Math.min(page, Math.max(0, Math.ceil(node.children.length / PAGE_SIZE) - 1));
  return <Section title="Технічні вузли">
    <div className="flex items-center gap-1">
      {activePath.length > 1 && <button className={chip(false)} onClick={() => { setPath(activePath.slice(0, -1)); setPage(0); }}>Вгору</button>}
      <span className="truncate">{node.name || node.type} · {node.visible ? 'видимий' : 'прихований'}</span>
    </div>
    {node !== root && <div className="text-zinc-400">
      {node.type} · #{node.id} · XYZ {node.position.toArray().map((value) => value.toFixed(1)).join(' / ')}
    </div>}
    <div className="max-h-40 overflow-auto">
      {node.children.slice(first * PAGE_SIZE, (first + 1) * PAGE_SIZE).map((child) =>
        <button key={child.id} className={`${btn} w-full justify-start px-1 py-1 text-left hover:bg-white/10`}
          onClick={() => { setPath([...activePath, child]); setPage(0); }}>
          <span className="truncate">{child.name || child.type} · {child.children.length}</span>
        </button>)}
    </div>
    <Paging page={first} count={node.children.length} setPage={setPage} />
  </Section>;
}
