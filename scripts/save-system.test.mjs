import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Quaternion, Ray, Vector3 } from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createServer } from 'vite';

const starter = JSON.parse(await readFile(new URL('../public/worlds/default.world.json', import.meta.url), 'utf8'));
const noop = () => {};
let server;
let SaveSystem;
let generatedRockModule;

before(async () => {
  server = await createServer({
    configFile: false,
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, ws: false },
  });
  ({ SaveSystem } = await server.ssrLoadModule('/src/world/SaveSystem.ts'));
  generatedRockModule = await server.ssrLoadModule('/src/world/GeneratedRocks.ts');
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
  let generatedRocks = [];
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
      serializeGeneratedRocks: () => generatedRocks,
      deserialize: (value, rocks = []) => { props = value; generatedRocks = rocks; },
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

const rockVariant = {
  id: 'generated_rock_1', name: 'Test rock', preset: 'cluster', palette: 'slate',
  seed: 3121, width: 2, height: 1.45, depth: 1.7, sharpness: 0.45, solid: true,
};

test('round-trips generated rock recipes and placements, and rejects dangling and invalid recipes', (t) => {
  const { slots, saves } = setup(t);
  const placement = { type: rockVariant.id, p: [2, 10, 3], r: 1.1, s: 0.8, g: false };
  const configured = { ...rockVariant, surface: { moss: 0, snow: 0.65, mossHeight: 0.2, snowHeight: 0.8 } };
  const props = starter.props.filter(({ type }) => !generatedRockModule.isGeneratedRockType(type));
  const data = { ...starter, generatedRocks: [configured], props: [...props, placement] };
  slots.set('cozyfarm.save.generated', JSON.stringify(data));
  assert.equal(saves.load('generated'), true);
  assert.equal(saves.save('roundtrip'), true);
  const roundtrip = JSON.parse(slots.get('cozyfarm.save.roundtrip'));
  assert.deepEqual(roundtrip.generatedRocks, [configured]);
  assert.deepEqual(roundtrip.props.at(-1), placement);

  for (const recipes of [undefined, [], [rockVariant, rockVariant], [{ ...rockVariant, width: 0 }], [{ ...rockVariant, preset: 'constructor' }], [{ ...configured, surface: { ...configured.surface, snowHeight: 2 } }]]) {
    slots.set('cozyfarm.save.invalid-rock', JSON.stringify({ ...data, generatedRocks: recipes }));
    assert.equal(saves.load('invalid-rock'), false);
  }
  slots.set('cozyfarm.save.old-rock', JSON.stringify({ ...data, generatedRocks: [rockVariant] }));
  assert.equal(saves.load('old-rock'), true);
});

test('generates reproducible rock LODs with decreasing triangle counts and valid Rapier hulls', async () => {
  const { buildGeneratedRock, ROCK_PRESETS, setGeneratedRockSurface } = generatedRockModule;
  await RAPIER.init();
  const point = new Vector3();
  const edge = new Vector3();
  const other = new Vector3();
  const normal = new Vector3();
  for (const preset of Object.keys(ROCK_PRESETS)) {
    for (const seed of [0, 1729, 3121, 0xffffffff]) {
      const params = { ...rockVariant, preset, seed };
      const model = buildGeneratedRock(params);
      const replica = buildGeneratedRock(params);
      const counts = model.lods.map((geometry) => geometry.getAttribute('position').count / 3);
      assert.ok(counts[0] > counts[1] && counts[1] > counts[2] && counts[2] > 0, `${preset}/${seed}: ${counts}`);
      for (const [i, geometry] of model.lods.entries()) {
        const position = geometry.getAttribute('position');
        const normals = geometry.getAttribute('normal');
        assert.deepEqual(position.array, replica.lods[i].getAttribute('position').array);
        assert.equal(geometry.getAttribute('color').normalized, true);
        const sharedNormals = new Map();
        const edges = new Map();
        let curvedUnderside = false;
        for (let v = 0; v < position.count; v++) {
          const key = point.fromBufferAttribute(position, v).toArray().join(',');
          normal.fromBufferAttribute(normals, v);
          assert.ok(Math.abs(normal.lengthSq() - 1) < 1e-6);
          const previous = sharedNormals.get(key);
          if (previous) assert.ok(normal.distanceToSquared(previous) < 1e-12, `${preset}/${seed}/LOD${i}: shading seam`);
          else sharedNormals.set(key, normal.clone());
        }
        for (let v = 0; v < position.count; v += 3) {
          point.fromBufferAttribute(position, v);
          edge.fromBufferAttribute(position, v + 1).sub(point);
          other.fromBufferAttribute(position, v + 2).sub(point);
          normal.fromBufferAttribute(normals, v);
          assert.ok(edge.cross(other).dot(normal) > 0, `${preset}/${seed}/LOD${i}: triangle ${v / 3}`);
          if (edge.y < 0 && position.getY(v) < 0 && position.getY(v + 1) < 0 && position.getY(v + 2) < 0 &&
              Math.hypot(edge.x, edge.z) > Math.abs(edge.y) * 0.08) curvedUnderside = true;
          const corners = [v, v + 1, v + 2].map((index) => point.fromBufferAttribute(position, index).toArray().join(','));
          for (let j = 0; j < 3; j++) {
            const a = corners[j], b = corners[(j + 1) % 3];
            const key = a < b ? `${a};${b}` : `${b};${a}`;
            const directions = edges.get(key) ?? [];
            directions.push(a < b);
            edges.set(key, directions);
          }
        }
        assert.ok([...edges.values()].every(([a, b, extra]) => b !== undefined && a !== b && extra === undefined),
          `${preset}/${seed}/LOD${i}: open or non-manifold mesh edge`);
        assert.ok(curvedUnderside, `${preset}/${seed}/LOD${i}: missing sloped underside`);
      }
      assert.equal(model.hulls.length, preset === 'cluster' ? 3 : 1);
      assert.ok(model.hulls.every((hull) => RAPIER.ColliderDesc.convexHull(hull)));
      const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
      try {
        const colliders = model.hulls.map((hull) => world.createCollider(RAPIER.ColliderDesc.convexHull(hull)));
        const p = model.lods[0].getAttribute('position');
        const ray = new Ray(), hit = new Vector3();
        for (let i = 0; i < 18; i++) {
          const a = i * 2.399963;
          ray.origin.set(5 * Math.cos(a), 5 * (i / 8.5 - 1), 5 * Math.sin(a));
          ray.direction.set(0, params.height * 0.34, 0).sub(ray.origin).normalize();
          let visible = Infinity;
          for (let v = 0; v < p.count; v += 3) {
            point.fromBufferAttribute(p, v);
            edge.fromBufferAttribute(p, v + 1);
            other.fromBufferAttribute(p, v + 2);
            if (ray.intersectTriangle(point, edge, other, true, hit)) visible = Math.min(visible, hit.distanceTo(ray.origin));
          }
          const cast = new RAPIER.Ray(ray.origin, ray.direction);
          const physical = Math.min(...colliders.map((hull) => {
            const distance = hull.castRay(cast, 20, true);
            return distance < 0 ? Infinity : distance;
          }));
          assert.ok(physical === visible || Math.abs(physical - visible) < 0.002, `${preset}/${seed}: collider/LOD0 ray ${i} (${physical} vs ${visible})`);
        }
      } finally {
        world.free();
      }
      setGeneratedRockSurface(model, { moss: 0.25, snow: 0, mossHeight: 0.5, snowHeight: 1.25 });
      for (const lod of model.lods) assert.deepEqual([...lod.getAttribute('aRockCover').array.slice(0, 4)], [0.25, 0, 0.5, 1.25]);
    }
  }
  assert.deepEqual(buildGeneratedRock({ ...rockVariant, solid: false }).hulls, []);
});
