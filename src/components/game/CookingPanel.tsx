import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChefHat, RotateCcw } from 'lucide-react';
import { audioEngine } from '../../audio/AudioEngine';
import { GameplayManager } from '../../gameplay/GameplayManager';
import { cookingMethod, DISH_BUFF, matchesIngredient, matchesRecipe, RECIPES, Recipe } from '../../gameplay/Recipes';
import { InventoryManager } from '../../inventory/InventoryManager';
import { getItemEmoji } from '../../inventory/types/InventoryTypes';
import { dataName, t, useLang } from '../../i18n/i18n';
import { Shell } from './ActivityPanels';
import './CookingPanel.css';

type Round = { recipe: Recipe; ingredients: string[] };
type Result = { dishId: string; golden: boolean };
type Drag = { id: string; pointer: number; x: number; y: number };
const READY = 0.65;
const GOLDEN_END = 0.87;
const STIRS = 3;
const MAX_PORTIONS = Math.max(...RECIPES.map((recipe) => recipe.ingredients.reduce((sum, ing) => sum + ing.count, 0)));

interface Props {
  gameplay: GameplayManager;
  inventory: InventoryManager;
  onClose(): void;
}

export function CookingPanel({ gameplay, inventory, onClose }: Props) {
  useLang();
  const [, setInventoryRevision] = useState(0);
  useEffect(() => inventory.subscribe(() => setInventoryRevision((value) => value + 1)), [inventory]);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [ingredients, setIngredients] = useState<string[]>([]);
  const [round, setRound] = useState<Round | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [golden, setGolden] = useState(false);
  const [stirs, setStirs] = useState(0);
  const [error, setError] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragStart = useRef<Drag | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const progress = useRef(0);
  const inFlight = useRef<Round | null>(null);

  const recipes = RECIPES.filter((item) => gameplay.isRecipeKnown(item));
  const combination = recipe
    ? matchesRecipe(recipe, ingredients) ? recipe : null
    : recipes.find((item) => matchesRecipe(item, ingredients)) ?? null;
  const mismatch = ingredients.length > 0 && !recipe && !recipes.some((entry) => matchesRecipe(entry, ingredients, true));
  const active = round?.recipe ?? combination ?? recipe;
  const method = active ? cookingMethod(active) : 'mix';
  const stock = inventory.getItems().filter((item) =>
    item.count > 0 && (recipe ? [recipe] : recipes).some((entry) =>
      entry.ingredients.some((ing) => matchesIngredient(ing.itemId, item.id))),
  );
  const dishes = inventory.getItems().filter((item) => item.count > 0 && DISH_BUFF[item.id]);
  const itemName = (id: string) => {
    if (id === 'fish_any') return t('cook.anyFish');
    if (id === 'fish_sea_any') return t('cook.anySeaFish');
    return dataName('item', id, inventory.getItem(id)?.name ?? id);
  };
  const icon = (id: string) => id === 'flour' ? '🌾' : getItemEmoji(inventory.getItem(id));

  const finish = useCallback((job: Round, perfect: boolean) => {
    if (inFlight.current !== job) return;
    inFlight.current = null;
    setRound(null);
    setGolden(false);
    const cooked = gameplay.finishCooking(job.recipe, job.ingredients);
    setError(!cooked);
    if (cooked) {
      setResult({ dishId: job.recipe.dishId, golden: perfect });
      setIngredients([]);
    }
  }, [gameplay]);

  useEffect(() => {
    if (!round || cookingMethod(round.recipe) === 'mix') return;
    let raf = 0;
    let elapsed = 0;
    let previous = performance.now();
    let wasGolden = false;
    const duration = (round.recipe.seconds + 2) * 1000;
    const step = (time: number) => {
      // Keep the doneness window readable after returning to a backgrounded tab.
      elapsed += Math.min(80, Math.max(0, time - previous));
      previous = time;
      const value = Math.min(elapsed / duration, 1);
      progress.current = value;
      stage.current?.style.setProperty('--doneness', String(value));
      const ready = value >= READY && value <= GOLDEN_END;
      if (ready !== wasGolden) {
        wasGolden = ready;
        setGolden(ready);
        if (ready) audioEngine.playCookingSizzle(0.7);
      }
      if (value === 1) finish(round, false);
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [round, finish]);

  function clearStation(nextRecipe: Recipe | null) {
    setRecipe(nextRecipe);
    setIngredients([]);
    setResult(null);
    setError(false);
    setDrag(null);
    dragStart.current = null;
  }

  function available(itemId: string) {
    return inventory.getItemCount(itemId) - ingredients.filter((id) => id === itemId).length;
  }

  function canAdd(itemId: string) {
    return !round && ingredients.length < MAX_PORTIONS && available(itemId) > 0
      && (!recipe || matchesRecipe(recipe, [...ingredients, itemId], true));
  }

  function add(itemId: string) {
    if (!canAdd(itemId)) return;
    setResult(null);
    setError(false);
    setIngredients([...ingredients, itemId]);
    audioEngine.playAppleThud(0.35);
  }

  function release(event: React.PointerEvent<HTMLButtonElement>, itemId: string) {
    const start = dragStart.current;
    if (start?.pointer !== event.pointerId) return;
    dragStart.current = null;
    setDrag(null);
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8;
    const bounds = stage.current?.getBoundingClientRect();
    if (!moved || (bounds && event.clientX >= bounds.left && event.clientX <= bounds.right
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom)) add(itemId);
  }

  function start() {
    if (!combination || inFlight.current) return;
    const job = { recipe: combination, ingredients: [...ingredients] };
    inFlight.current = job;
    progress.current = 0;
    setStirs(0);
    setGolden(false);
    setResult(null);
    setError(false);
    setRound(job);
    stage.current?.style.setProperty('--doneness', '0');
    if (method === 'mix') audioEngine.playBuildSelect();
    else audioEngine.playCookingSizzle(1);
  }

  function stir() {
    if (!round || inFlight.current !== round) return;
    if (stirs + 1 >= STIRS) finish(round, true);
    else {
      setStirs(stirs + 1);
      audioEngine.playAppleThud(0.3);
    }
  }

  return (
    <Shell title={t('cook.title')} icon={<ChefHat className="w-5 h-5 text-orange-600" />} onClose={onClose}>
      <div className="cook-ui">
        <label className="cook-recipes">
          <span>{t('cook.recipe')}</span>
          <select disabled={!!round} value={recipe?.id ?? ''} onChange={(event) => clearStation(recipes.find((item) => item.id === event.target.value) ?? null)}>
            <option value="">{t('cook.experiment')}</option>
            {recipes.map((item) => <option key={item.id} value={item.id}>{gameplay.recipeName(item.id)}</option>)}
          </select>
        </label>

        {recipe && !round && !result && (
          <div className="cook-requirements">
            {recipe.ingredients.map(({ itemId, count }) => (
              <span key={itemId}>{itemName(itemId)} {ingredients.filter((id) => matchesIngredient(itemId, id)).length}/{count}</span>
            ))}
          </div>
        )}

        <div ref={stage} className="cook-board" data-method={method} data-hot={!!round && method !== 'mix'} data-golden={golden}>
          <div className="cook-vessel" aria-hidden="true">
            <div className="cook-vessel-inner" />
            {round && method !== 'mix' && <div className="cook-steam"><i /><i /><i /></div>}
          </div>
          <div className="cook-contents" key={round && method === 'mix' ? stirs : 'contents'}>
            {result ? <span className="cook-plated" aria-hidden="true">{icon(result.dishId)}</span> : ingredients.map((id, index) => (
              <button type="button" key={index} disabled={!!round}
                title={t('cook.remove', { name: itemName(id) })} aria-label={t('cook.remove', { name: itemName(id) })}
                className={round && method === 'mix' && stirs ? 'cook-stirred' : 'cook-portion'}
                onClick={() => setIngredients(ingredients.filter((_, position) => position !== index))}>
                {icon(id)}
              </button>
            ))}
            {!ingredients.length && !result && <span className="cook-empty">{t('cook.addHere')}</span>}
          </div>
          {round && method !== 'mix' && (
            <div className="cook-heat" aria-hidden="true"><i /><b /></div>
          )}
        </div>

        <div className="cook-action">
          {round ? method === 'mix'
            ? <button type="button" className="cook-main" onClick={stir}>{t('cook.stir', { n: stirs, total: STIRS })}</button>
            : <button type="button" className="cook-main" data-ready={golden} onClick={() => finish(round, progress.current >= READY && progress.current <= GOLDEN_END)}>
              {t(golden ? 'cook.goldenNow' : 'cook.finishHeat')}
            </button>
            : <>
              <div className="cook-hint" role="status">
                {error ? t('cook.unavailable')
                  : result ? t(result.golden ? 'cook.goldenResult' : 'cook.served', { name: itemName(result.dishId) })
                  : combination ? gameplay.recipeName(combination.id)
                  : mismatch ? t('cook.tryMix')
                  : t('cook.addHint')}
              </div>
              <button type="button" className="cook-clear" disabled={!ingredients.length && !result} onClick={() => clearStation(recipe)}
                title={t('cook.clear')} aria-label={t('cook.clear')}><RotateCcw size={17} /></button>
              <button type="button" className="cook-main" disabled={!combination} onClick={start}>
                {t(method === 'mix' ? 'cook.mix' : method === 'pan' ? 'cook.fry' : method === 'oven' ? 'cook.bake' : 'cook.simmer')}
              </button>
            </>}
        </div>

        {!round && <div className="cook-stock">
          {stock.length ? stock.map((item) => (
            <button type="button" key={item.id} disabled={!canAdd(item.id)} className="cook-ingredient"
              onPointerDown={(event) => {
                if (event.button !== 0 || dragStart.current) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                dragStart.current = { id: item.id, pointer: event.pointerId, x: event.clientX, y: event.clientY };
              }}
              onPointerMove={(event) => {
                const start = dragStart.current;
                if (start?.pointer === event.pointerId && (drag || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)) {
                  setDrag({ ...start, x: event.clientX, y: event.clientY });
                }
              }}
              onPointerUp={(event) => release(event, item.id)}
              onLostPointerCapture={() => { dragStart.current = null; setDrag(null); }}
              onClick={(event) => { if (event.detail === 0) add(item.id); }}>
              <span aria-hidden="true">{icon(item.id)}</span><span>{itemName(item.id)}</span><b>{available(item.id)}</b>
            </button>
          )) : <div className="cook-hint">{t('cook.noIngredients')}</div>}
        </div>}
        {!round && dishes.length > 0 && (
          <details className="cook-dishes">
            <summary>{t('cook.yourDishes')}</summary>
            {dishes.map((dish) => {
              const buff = DISH_BUFF[dish.id];
              return <div key={dish.id}><span>{icon(dish.id)} {itemName(dish.id)} ×{dish.count}
                <small>{t('cook.buff', { pct: Math.round((buff.speed - 1) * 100), s: buff.seconds })}</small></span>
                <button type="button" onClick={() => gameplay.eat(dish.id)}>{t('cook.eat')}</button></div>;
            })}
          </details>
        )}
        {drag && <span className="cook-drag" style={{ left: drag.x, top: drag.y }} aria-hidden="true">{icon(drag.id)}</span>}
      </div>
    </Shell>
  );
}
