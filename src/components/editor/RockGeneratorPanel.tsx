import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Trash2 } from 'lucide-react';
import type { GameEngine } from '../../engine/GameEngine';
import { buildGeneratedRock, DEFAULT_ROCK_SURFACE, MAX_GENERATED_ROCKS, ROCK_PALETTES, ROCK_PRESETS, setGeneratedRockSurface, type GeneratedRockModel, type GeneratedRockParams, type GeneratedRockSurface } from '../../world/GeneratedRocks';
import { createGeneratedRockMaterial } from '../../world/GeneratedRockMaterial';
import { chip, Section, Slider } from './EditorWidgets';

const field = 'rounded-md border border-white/10 bg-zinc-950 px-2 py-1.5 text-zinc-100';
const nextSeed = () => Math.floor(Math.random() * 0x100000000);
const dimensions = ['width', 'height', 'depth'] as const;
const dimensionLabels = { width: 'Ширина', height: 'Висота', depth: 'Глибина' };

function presetSize(preset: GeneratedRockParams['preset']) {
  const { width, height, depth } = ROCK_PRESETS[preset];
  return { width, height, depth };
}

interface PreviewScene {
  mesh: THREE.Mesh;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  colliderGroup: THREE.Group;
  colliderMaterial: THREE.LineBasicMaterial;
  draw(): void;
}

function RockPreview({ model, lod, showCollider, surface, coverMode }: {
  model: GeneratedRockModel; lod: number; showCollider: boolean; surface?: GeneratedRockSurface; coverMode: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<PreviewScene | null>(null);
  const previousModel = useRef<GeneratedRockModel | null>(null);
  const paintPreview = useRef({ value: 0 });
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const element = canvas.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: element, alpha: true, antialias: true });
    } catch {
      setUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
    camera.position.set(3, 2.3, 4);
    const controls = new OrbitControls(camera, element);
    controls.enablePan = false;
    const material = createGeneratedRockMaterial(undefined, paintPreview.current);
    const placeholder = new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(placeholder, material);
    const colliderGroup = new THREE.Group();
    const colliderMaterial = new THREE.LineBasicMaterial({ color: 0x63dfcf, depthTest: false, transparent: true, opacity: 0.8 });
    const sun = new THREE.DirectionalLight(0xfff2e2, 2.15);
    sun.position.set(-4, 6, 3);
    scene.add(mesh, colliderGroup, sun, new THREE.HemisphereLight(0xf0f6ff, 0x9ca8ae, 1.1));
    const draw = () => renderer.render(scene, camera);
    controls.addEventListener('change', draw);
    const resize = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      renderer.setSize(element.clientWidth, element.clientHeight, false);
      camera.aspect = element.clientWidth / element.clientHeight;
      camera.updateProjectionMatrix();
      draw();
    });
    resize.observe(element);
    preview.current = { mesh, camera, controls, colliderGroup, colliderMaterial, draw };
    return () => {
      resize.disconnect();
      controls.dispose();
      placeholder.dispose();
      material.dispose();
      colliderMaterial.dispose();
      renderer.dispose();
      preview.current = null;
      previousModel.current = null;
    };
  }, []);

  useEffect(() => {
    paintPreview.current.value = coverMode;
    setGeneratedRockSurface(model, surface);
    preview.current?.draw();
  }, [model, surface, coverMode]);

  useEffect(() => {
    const view = preview.current;
    if (!view) return;
    view.mesh.geometry = model.lods[lod];
    if (previousModel.current !== model) {
      const sphere = model.lods[0].boundingSphere!;
      const direction = view.camera.position.clone().sub(view.controls.target).normalize();
      view.controls.target.copy(sphere.center);
      view.camera.position.copy(sphere.center).addScaledVector(direction, sphere.radius * 3.8);
      view.controls.minDistance = sphere.radius * 1.25;
      view.controls.maxDistance = sphere.radius * 9;
      view.controls.update();
      previousModel.current = model;
    }
    view.draw();
  }, [model, lod]);

  useEffect(() => {
    const view = preview.current;
    if (!view || !showCollider) return;
    const lines = model.hulls.map((hull) => {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i < hull.length; i += 3) points.push(new THREE.Vector3(hull[i], hull[i + 1], hull[i + 2]));
      const convex = new ConvexGeometry(points);
      const outline = new THREE.EdgesGeometry(convex, 2);
      convex.dispose();
      return new THREE.LineSegments(outline, view.colliderMaterial);
    });
    view.colliderGroup.add(...lines);
    view.draw();
    return () => {
      for (const line of lines) {
        view.colliderGroup.remove(line);
        line.geometry.dispose();
      }
      if (preview.current) view.draw();
    };
  }, [model, showCollider]);

  return unavailable ? <p className="rounded-lg bg-black/25 p-4 text-zinc-400">3D-перегляд недоступний у цьому браузері.</p> : (
    <canvas ref={canvas} aria-label="3D-перегляд каменю. Перетягніть для обертання" className="block h-44 w-full touch-none cursor-grab rounded-lg bg-gradient-to-b from-zinc-800 to-zinc-950 active:cursor-grabbing" />
  );
}

export default function RockGeneratorPanel({ engine, onPlace }: { engine: GameEngine; onPlace(id: string): void }) {
  const { props, editor } = engine.world!;
  const [{ params, model }, setDraft] = useState(() => {
    const params: GeneratedRockParams = { preset: 'boulder', palette: 'granite', seed: 1729, sharpness: 0.35, solid: true, ...presetSize('boulder') };
    return { params, model: buildGeneratedRock(params) };
  });
  const [name, setName] = useState('');
  const [lod, setLod] = useState(0);
  const [showCollider, setShowCollider] = useState(false);
  const [coverMode, setCoverMode] = useState(0);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [surfaceTarget, setSurfaceTarget] = useState<string | null>(null);
  const saved = props.serializeGeneratedRocks();
  const source = saved.find(({ id }) => id === surfaceTarget);
  const surface = params.surface ?? DEFAULT_ROCK_SURFACE;

  useEffect(() => () => model.lods.forEach((geometry) => geometry.dispose()), [model]);

  function update(patch: Partial<GeneratedRockParams>) {
    const next = { ...params, ...patch };
    setDraft({ params: next, model: buildGeneratedRock(next) });
    setSavedId(null);
  }

  function updateSurface(key: keyof GeneratedRockSurface, value: number) {
    setDraft(({ params, model }) => ({ params: { ...params, surface: { ...(params.surface ?? DEFAULT_ROCK_SURFACE), [key]: value } }, model }));
    setCoverMode(key === 'moss' || key === 'mossHeight' ? 1 : 2);
    setSavedId(null);
  }

  function applySurface(id: string) {
    const capture = () => props.captureGeneratedRock(id)?.surface;
    const restore = (surface: GeneratedRockSurface | undefined) => props.setRockSurface(id, surface);
    const before = capture();
    restore(params.surface);
    editor.recordChange('Покриття каменю', capture, restore, before);
    setSavedId(id);
  }

  function save() {
    const data = props.addGeneratedRock(name.trim() || `${ROCK_PRESETS[params.preset].label} ${saved.length + 1}`, params);
    if (!data) return;
    editor.recordChange('Збереження варіанта каменю', () => props.captureGeneratedRock(data.id), (value) => props.restoreGeneratedRock(data.id, value), null);
    setSavedId(data.id);
    setSurfaceTarget(data.id);
    setName('');
  }

  function remove(id: string) {
    if (!props.canRemoveGeneratedRock(id)) return;
    const before = props.captureGeneratedRock(id);
    props.restoreGeneratedRock(id, null);
    editor.recordChange('Видалення варіанта каменю', () => props.captureGeneratedRock(id), (value) => props.restoreGeneratedRock(id, value), before);
    if (editor.state.placeType === id) editor.set('placeType', 'rock_big');
    if (savedId === id) setSavedId(null);
  }

  return (
    <>
      <Section title="Генератор каменів">
        <RockPreview model={model} lod={lod} showCollider={showCollider && params.solid} surface={params.surface} coverMode={coverMode} />
        <div className="flex items-center gap-1" aria-label="Рівень деталізації">
          {model.lods.map((geometry, index) => (
            <button type="button" key={index} className={`${chip(lod === index)} flex-1 flex-col gap-0`} aria-pressed={lod === index} onClick={() => setLod(index)}>
              LOD{index}<span className="text-[10px] tabular-nums opacity-80">{geometry.getAttribute('position').count / 3} трик.</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1 text-zinc-400">Форма
            <select value={params.preset} className={field} onChange={(event) => {
              const preset = event.target.value as GeneratedRockParams['preset'];
              update({ preset, ...presetSize(preset) });
            }}>
              {Object.entries(ROCK_PRESETS).map(([key, entry]) => <option key={key} value={key}>{entry.label}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-zinc-400">Палітра
            <select value={params.palette} className={field} onChange={(event) => update({ palette: event.target.value as GeneratedRockParams['palette'] })}>
              {Object.entries(ROCK_PALETTES).map(([key, entry]) => <option key={key} value={key}>{entry.label}</option>)}
            </select>
          </label>
        </div>
        <div className="flex items-end gap-2">
          <label className="grid min-w-0 flex-1 gap-1 text-zinc-400">Seed
            <input type="number" min={0} max={0xffffffff} step={1} value={params.seed} className={`${field} min-w-0`} onChange={(event) => {
              const value = event.target.valueAsNumber;
              if (Number.isFinite(value)) update({ seed: THREE.MathUtils.clamp(Math.trunc(value), 0, 0xffffffff) });
            }} />
          </label>
          <button type="button" className={chip(false)} onClick={() => update({ seed: nextSeed() })}>Новий варіант</button>
        </div>
        {dimensions.map((key) => (
          <Slider key={key} label={dimensionLabels[key]} min={key === 'height' ? 0.2 : 0.3} max={5} step={0.05} value={params[key]} onChange={(value) => update({ [key]: value })} fmt={(value) => `${value.toFixed(2)} м`} />
        ))}
        <Slider label="Заокруглення граней" min={0} max={1} step={0.05} value={1 - params.sharpness} onChange={(roundness) => update({ sharpness: 1 - roundness })} fmt={(value) => `${Math.round(value * 100)}%`} />
        <div className="flex flex-wrap gap-1">
          <button type="button" className={chip(params.solid)} aria-pressed={params.solid} onClick={() => update({ solid: !params.solid })}>Колізія</button>
          <button type="button" className={`${chip(showCollider && params.solid)} disabled:opacity-40`} disabled={!params.solid} aria-pressed={showCollider && params.solid} onClick={() => setShowCollider(!showCollider)}>Контур колайдера</button>
        </div>
        <label className="grid gap-1 text-zinc-400">Назва варіанта
          <input value={name} maxLength={48} placeholder={ROCK_PRESETS[params.preset].label} onChange={(event) => { setName(event.target.value); setSavedId(null); }} className={field} />
        </label>
        {savedId && saved.some(({ id }) => id === savedId) ? (
          <button type="button" className={chip(true)} onClick={() => onPlace(savedId)}>Розмістити на карті</button>
        ) : (
          <button type="button" className={`${chip(true)} disabled:opacity-40`} disabled={saved.length >= MAX_GENERATED_ROCKS} onClick={save}>Зберегти в палітру</button>
        )}
        {saved.length >= MAX_GENERATED_ROCKS && <p className="text-zinc-400">Досягнуто ліміту {MAX_GENERATED_ROCKS} варіантів у світі.</p>}
      </Section>
      <Section title="Мох і сніг">
        <div className="flex flex-wrap gap-1" aria-label="Перегляд покриття">
          {['Чистий', 'Мох', 'Сніг'].map((label, index) => (
            <button key={label} type="button" className={chip(coverMode === index)} aria-pressed={coverMode === index} onClick={() => setCoverMode(index)}>{label}</button>
          ))}
        </div>
        <Slider label="Інтенсивність моху" min={0} max={1} step={0.05} value={surface.moss} onChange={(value) => updateSurface('moss', value)} fmt={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Висота моху" min={0.05} max={1.5} step={0.05} value={surface.mossHeight} onChange={(value) => updateSurface('mossHeight', value)} fmt={(v) => `${v.toFixed(2)} м`} />
        <Slider label="Інтенсивність снігу" min={0} max={1} step={0.05} value={surface.snow} onChange={(value) => updateSurface('snow', value)} fmt={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Висота снігу" min={0.05} max={1.5} step={0.05} value={surface.snowHeight} onChange={(value) => updateSurface('snowHeight', value)} fmt={(v) => `${v.toFixed(2)} м`} />
        {source && <button type="button" className={`${chip(false)} disabled:opacity-40`} disabled={JSON.stringify(surface) === JSON.stringify(source.surface ?? DEFAULT_ROCK_SURFACE)} onClick={() => applySurface(source.id)}>
          <span className="min-w-0 truncate">Оновити покриття «{source.name}»</span>
        </button>}
      </Section>
      {saved.length > 0 && <Section title="Палітра каменів">
        {saved.map((rock) => <div key={rock.id} className="flex items-center gap-1">
          <button type="button" className={`${chip(false)} min-w-0 flex-1 justify-start`} title={`Розмістити ${rock.name}`} onClick={() => onPlace(rock.id)}><span className="truncate">{rock.name}</span></button>
          <button type="button" className={chip(false)} title={`Відкрити ${rock.name} як чернетку`} onClick={() => { update({ ...rock, surface: rock.surface }); setSurfaceTarget(rock.id); setName(''); }}>У чернетку</button>
          <button type="button" className={`${chip(false)} px-2 disabled:opacity-30`} aria-label={`Видалити ${rock.name}`} title="Видалити варіант, якщо його немає на карті" disabled={!props.canRemoveGeneratedRock(rock.id)} onClick={() => remove(rock.id)}><Trash2 className="h-3.5 w-3.5" /></button>
        </div>)}
      </Section>}
    </>
  );
}
