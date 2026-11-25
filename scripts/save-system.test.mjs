import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { createServer } from 'vite';

const starter = JSON.parse(await readFile(new URL('../public/worlds/default.world.json', import.meta.url), 'utf8'));
const noop = () => {};
let server;
let SaveSystem;

before(async () => {
  server = await createServer({
    configFile: false,
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, ws: false },
  });
  ({ SaveSystem } = await server.ssrLoadModule('/src/world/SaveSystem.ts'));
});

after(async () => {
  await server?.close();
});

function setup(t) {
  const slots = new Map();
  t.mock.method(console, 'warn', noop);
  t.mock.method(console, 'error', noop);
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => slots.get(key) ?? null,
      setItem: (key, value) => slots.set(key, value),
    },
  });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  });

  let player = new Vector3(10.1234, 2.5678, -6.4321);
  let props = starter.props;
  let pests = starter.authoredPests;
  let birdCount = 0;
  const storedItems = new Map([['coins', 13]]);
  const world = {
    terrain: { serialize: () => starter.terrain, deserialize: noop },
    weather: {
      weather: starter.weather,
      snowCover: 0,
      setWeather: noop,
      director: { serialize: () => starter.weatherDirector, deserialize: noop },
    },
    props: {
      serialize: () => props,
      deserialize: (value) => { props = value; },
      ensureStation: noop,
      queueForestUpgrade: noop,
      forestVersion: starter.forest,
    },
    character: { getPosition: () => player.clone(), respawn: (value) => { player = value; } },
    vehicle: { body: {
      translation: () => new Vector3(),
      rotation: () => new Quaternion(),
      setTranslation: noop,
      setRotation: noop,
      setLinvel: noop,
    } },
    moped: { getPosition: () => new Vector3(), getYaw: () => 0, place: noop },
    boat: { getPosition: () => new Vector3(), getYaw: () => 0, place: noop },
    farmingManager: { serializeFields: () => [], deserializeFields: noop },
    orchard: { serialize: () => starter.orchard, deserialize: noop },
    nursery: { serialize: () => starter.nursery, deserialize: noop },
    inventoryManager: {
      getItems: () => [...storedItems].map(([id, count]) => ({ id, count })),
      getItemCount: (id) => storedItems.get(id) ?? 0,
      addItem: (id, amount) => storedItems.set(id, (storedItems.get(id) ?? 0) + amount),
      removeItem: (id, amount) => storedItems.set(id, (storedItems.get(id) ?? 0) - amount),
      getEquippedItemId: () => null,
      equipItem: noop,
      getHotbar: () => [],
      setHotbar: noop,
      isOnHotbar: () => false,
      addToHotbar: noop,
      getCapacity: () => 16,
      setCapacity: noop,
    },
    gameplay: {
      lastSleepNight: -1,
      pets: {
        serialize: () => [],
        deserialize: (pets) => { birdCount = pets.length; },
      },
      pests: {
        serializeAuthored: () => pests,
        restoreAuthored: (value) => { pests = value; },
        clear: () => { pests = []; },
      },
    },
    rocks: { serializeAuthored: () => [], restoreAuthored: noop },
    exploration: {
      inCave: null,
      clearSiteProps: noop,
      serialize: () => starter.exploration,
      deserialize: noop,
    },
  };

  return { slots, world, saves: new SaveSystem(world), getBirdCount: () => birdCount };
}

test('loads a legacy slot and rejects invalid save data before mutating the world', (t) => {
  const { slots, world, saves } = setup(t);
  slots.set('cozyfarm.save.invalid', '{"version":99}');
  const start = world.character.getPosition();
  assert.equal(saves.load('invalid'), false);
  assert.deepEqual(world.character.getPosition(), start);

  const legacy = { ...starter, version: 2 };
  slots.set('cozyfarm.save.legacy', JSON.stringify(legacy));
  assert.equal(saves.load('legacy'), true);
  assert.deepEqual(world.character.getPosition().toArray(), [
    legacy.player[0], legacy.player[1] + 0.3, legacy.player[2],
  ]);
});

test('checks cancellation again after decoding the starter world', async (t) => {
  const { world, saves } = setup(t);
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => {
      controller.abort();
      return starter;
    },
  }));
  const start = world.character.getPosition();
  assert.equal(await saves.loadDefaultWorld(controller.signal), false);
  assert.deepEqual(world.character.getPosition(), start);
  assert.equal(await saves.loadDefaultWorld(), true);
});

test('restores player and pets after a late failure in both slot load and file import', async (t) => {
  const { slots, world, saves, getBirdCount } = setup(t);
  const raw = JSON.stringify({ ...starter, player: [4, 3, 2] });
  const start = world.character.getPosition();
  slots.set('cozyfarm.save.broken', raw);
  for (const load of [
    () => saves.load('broken'),
    () => saves.importFile(new File([raw], 'broken.world.json')),
  ]) {
    let fail = true;
    let appliedPosition;
    world.rocks.restoreAuthored = () => {
      if (!fail) return;
      fail = false;
      appliedPosition = world.character.getPosition().x;
      throw new Error('Rock reconstruction failed');
    };
    assert.equal(await load(), false);
    assert.equal(appliedPosition, 4);
    assert.deepEqual(world.character.getPosition(), start);
    assert.equal(getBirdCount(), 0);
    assert.equal(saves.needsRecovery, false);
  }
});

test('protects existing saves when rollback fails and permits writing after recovery', (t) => {
  const { slots, world, saves } = setup(t);
  const raw = JSON.stringify(starter);
  slots.set('cozyfarm.save.auto', raw);
  world.rocks.restoreAuthored = () => { throw new Error('Rock reconstruction failed'); };

  assert.equal(saves.load('auto'), false);
  assert.equal(saves.needsRecovery, true);
  assert.equal(saves.save('auto'), false);
  assert.equal(slots.get('cozyfarm.save.auto'), raw);

  world.rocks.restoreAuthored = noop;
  assert.equal(saves.load('auto'), true);
  assert.equal(saves.needsRecovery, false);
  assert.equal(saves.save('auto'), true);
});

test('reports a storage-write error without replacing the existing slot', (t) => {
  const { slots, saves } = setup(t);
  slots.set('cozyfarm.save.auto', 'previous game');
  t.mock.method(globalThis.localStorage, 'setItem', () => { throw new Error('Storage quota exceeded'); });
  assert.equal(saves.save('auto'), false);
  assert.equal(slots.get('cozyfarm.save.auto'), 'previous game');
});
