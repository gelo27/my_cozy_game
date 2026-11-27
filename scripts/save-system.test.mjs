import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { DataUtils, Quaternion, Ray, Scene, Vector3 } from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createServer } from 'vite';

const starter = JSON.parse(await readFile(new URL('../public/worlds/default.world.json', import.meta.url), 'utf8'));
const noop = () => {};
let server;
let SaveSystem;
let generatedRockModule;
let bridgeTypes;
let buildBridge;
let BridgeEditTool;
let BridgeSystem;
let StaticShadows;
let terrainConstants;
let waterSurfaceUniforms;

before(async () => {
  server = await createServer({
    configFile: false,
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, ws: false },
  });
  ({ SaveSystem } = await server.ssrLoadModule('/src/world/SaveSystem.ts'));
  generatedRockModule = await server.ssrLoadModule('/src/world/GeneratedRocks.ts');
  bridgeTypes = await server.ssrLoadModule('/src/world/BridgeTypes.ts');
  ({ buildBridge } = await server.ssrLoadModule('/src/world/BridgeGeometry.ts'));
  ({ BridgeEditTool } = await server.ssrLoadModule('/src/editor/BridgeEditTool.ts'));
  const context = { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: noop };
  globalThis.document = {
    createElement: () => ({ getContext: () => context, toDataURL: () => '' }),
    createElementNS: () => ({ addEventListener: noop, removeEventListener: noop }),
  };
  try {
    ({ BridgeSystem } = await server.ssrLoadModule('/src/world/BridgeSystem.ts'));
    ({ StaticShadows } = await server.ssrLoadModule('/src/world/StaticShadows.ts'));
    terrainConstants = await server.ssrLoadModule('/src/world/TerrainSystem.ts');
    ({ waterSurfaceUniforms } = await server.ssrLoadModule('/src/world/WaterSurface.ts'));
  } finally {
    delete globalThis.document;
  }
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
  let bridges = [];
  let pests = starter.authoredPests;
  let birdCount = 0;
  const storedItems = new Map([['coins', 13]]);
  const world = {
    terrain: { serialize: () => starter.terrain, deserialize: noop },
    bridges: { serialize: () => bridges, deserialize: (value = []) => { bridges = value; } },
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

function testBridge() {
  return { ...bridgeTypes.BRIDGE_DEFAULTS, id: 'bridge_sample', a: { x: 3, y: 2, z: 4 }, b: { x: 7, y: 2.5, z: 10 } };
}

test('bridge swaps indexed geometry in a single mesh and keeps its collider while hidden', () => {
  const scene = new Scene();
  const body = {};
  const removed = [];
  const bridges = new BridgeSystem(scene, {
    rapier: { TriMeshFlags: { FIX_INTERNAL_EDGES: 1 } },
    createStaticTrimesh: () => ({ body, collider: {} }),
    removeRigidBody: (value) => removed.push(value),
  });
  const def = { ...testBridge(), a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 64 } };
  bridges.set(def.id, def);
  const [group] = scene.children;
  const [mesh] = group.children;
  const detail = mesh.geometry;
  assert.equal(mesh.castShadow, false);
  assert.equal(Array.isArray(mesh.material), false);
  assert.equal(detail.groups.length, 0);

  bridges.updateLod(new Vector3(0, 4, 65));
  assert.equal(mesh.geometry, detail);
  bridges.updateLod(new Vector3(70, 4, 32));
  const coarse = mesh.geometry;
  assert.equal(group.children.length, 1);
  assert.ok(coarse.index.count < detail.index.count / 4);
  assert.equal(coarse.groups.length, 0);
  assert.equal(mesh.visible, true);

  bridges.updateLod(new Vector3(200, 4, 32));
  assert.equal(mesh.visible, false);
  assert.deepEqual(removed, []);
  bridges.setVisible(def.id, false);
  bridges.updateLod(new Vector3(0, 4, 32));
  assert.equal(mesh.visible, false);
  bridges.setVisible(def.id, true);
  bridges.updateLod(new Vector3(0, 4, 32));
  assert.equal(mesh.visible, true);
  assert.equal(mesh.geometry, detail);
  bridges.dispose();
  assert.deepEqual(removed, [body]);
});

test('diagonal bridge bakes a soft deck footprint into terrain chunks and clears it on removal', () => {
  const { TERRAIN_CHUNK: size, TERRAIN_CHUNKS: chunks } = terrainConstants;
  const def = { ...testBridge(), a: { x: -8, y: 2, z: -8 }, b: { x: 12, y: 2, z: 12 }, width: 2 };
  const baked = new Map();
  const terrain = { setChunkShade: (id, data) => baked.set(id, data.slice()) };
  const bridges = { revision: 0, forEachBridge: (visit) => visit(def) };
  const shadows = new StaticShadows(terrain, { revision: 0, list: () => [] },
    { forEachStandingTree: noop }, { forEachIntact: noop }, {}, { revision: 0, getAllPieces: () => [] }, bridges);
  const shade = (x, z) => {
    const half = size * chunks / 2;
    const gx = x + half, gz = z + half;
    const chunk = Math.floor(gz / size) * chunks + Math.floor(gx / size);
    return baked.get(chunk)[(gz % size) * (size + 1) + gx % size];
  };
  const focus = new Vector3(0, 0, 0);
  const depthMap = waterSurfaceUniforms.uWsBed.value.image;
  const sampleGrid = 4 + (depthMap.width - 1) / 2;
  const waterIndex = 2 * (sampleGrid * depthMap.width + sampleGrid);
  const bedHeight = depthMap.data[waterIndex];
  for (let i = 0; i < Math.ceil(chunks * chunks / 2); i++) shadows.update(0.5, focus);
  assert.equal(shade(-4, -4), 153);
  assert.equal(shade(4, 4), 153);
  assert.ok(shade(4, 6) > 0 && shade(4, 6) < 153);
  assert.equal(shade(4, 8), 0);
  assert.equal(depthMap.data[waterIndex + 1], DataUtils.toHalfFloat(0.6));
  assert.equal(depthMap.data[waterIndex], bedHeight);

  bridges.forEachBridge = noop;
  bridges.revision++;
  for (let i = 0; i < 4; i++) shadows.update(0.5, focus);
  assert.equal(shade(-4, -4), 0);
  assert.equal(shade(4, 4), 0);
  assert.equal(depthMap.data[waterIndex + 1], 0);
});

test('bridge saves preserve the full recipe and reject duplicate IDs and invalid spans', (t) => {
  const { slots, saves, world } = setup(t);
  const bridge = { ...testBridge(), shape: 'eased', railings: false };
  slots.set('cozyfarm.save.bridges', JSON.stringify({ ...starter, bridges: [bridge] }));
  assert.equal(saves.load('bridges'), true);
  assert.equal(saves.save('bridge-roundtrip'), true);
  assert.deepEqual(JSON.parse(slots.get('cozyfarm.save.bridge-roundtrip')).bridges, [bridge]);

  for (const bridges of [[bridge, bridge], [{ ...bridge, b: bridge.a }], [{ ...bridge, rise: 12 }]]) {
    slots.set('cozyfarm.save.bad-bridges', JSON.stringify({ ...starter, bridges }));
    assert.equal(saves.load('bad-bridges'), false);
    assert.deepEqual(world.bridges.serialize(), [bridge]);
  }
  const legacySave = { ...starter };
  delete legacySave.bridges;
  slots.set('cozyfarm.save.no-bridges', JSON.stringify(legacySave));
  assert.equal(saves.load('no-bridges'), true);
  assert.deepEqual(world.bridges.serialize(), []);
});

test('bridge deck and rail collision follows its curved render mesh', async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  try {
    for (const shape of ['round', 'eased']) {
      for (const railings of [true, false]) {
        const bridge = { ...testBridge(), shape, railings };
        const built = buildBridge(bridge, true);
        const { geometry, collisionVertices, collisionIndices } = built;
        const span = bridgeTypes.bridgeSpan(bridge.a, bridge.b);
        const segments = bridgeTypes.bridgeSegments(span);
        const collider = world.createCollider(RAPIER.ColliderDesc.trimesh(
          new Float32Array(collisionVertices), new Uint32Array(collisionIndices), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
        ));
        const position = geometry.getAttribute('position');
        const normal = geometry.getAttribute('normal');
        const uv = geometry.getAttribute('uv');
        assert.equal(geometry.groups.length, 0);
        assert.equal(collisionVertices.length / 3, 4 * (segments + 1) * (railings ? 3 : 1));
        for (let i = 0; i <= segments; i++) {
          const t = i / segments;
          const z = t * span;
          const height = bridgeTypes.bridgeHeight(bridge, t);
          assert.ok(Math.abs(position.getY(i * 2) - height) < 1e-6);
          assert.ok(normal.getY(i * 2) > 0);
          assert.ok(i === 0 || uv.getY(i * 2) > uv.getY((i - 1) * 2));
          if (i === 0 || i === segments) continue;
          const down = new RAPIER.Ray({ x: 0, y: 5, z }, { x: 0, y: -1, z: 0 });
          const across = new RAPIER.Ray({ x: 0, y: height + 0.5, z }, { x: 1, y: 0, z: 0 });
          assert.ok(Math.abs(collider.castRay(down, 8, true) - (5 - height)) < 1e-5);
          assert.equal(collider.castRay(across, 3, true) > 0, railings);
        }
        const preview = buildBridge(bridge, false);
        assert.deepEqual(preview.collisionIndices, []);
        assert.deepEqual(preview.geometry.getAttribute('position').array, position.array);
        for (const mesh of [geometry, preview.geometry]) mesh.dispose();
        world.removeCollider(collider, false);
      }
    }
  } finally {
    world.free();
  }
});

test('bridge editor commits a single change after preview and restores the previous recipe on undo', () => {
  const placed = new Map();
  const changes = [];
  const bridges = {
    serialize: () => [...placed.values()],
    get: (id) => placed.get(id),
    set: (id, def) => def ? placed.set(id, def) : placed.delete(id),
  };
  const tool = new BridgeEditTool(new Scene(), bridges, noop, (...change) => changes.push(change));
  try {
    tool.pointerDown(new Vector3(0, 2, 0));
    assert.equal(tool.picking, 'b');
    tool.pointerDown(new Vector3(0, 2, 0.2));
    assert.equal(tool.canApply, false);
    tool.beginPick('b');
    tool.pointerDown(new Vector3(1, 2, 6));
    tool.setSettings({ rise: 0.8 });
    assert.equal(placed.size, 0);
    assert.equal(tool.canApply, true);
    tool.apply();
    const id = tool.selected;
    const first = placed.get(id);
    assert.equal(changes.length, 1);

    tool.setSettings({ railings: false });
    tool.setHeight('b', 2.7);
    tool.apply();
    assert.equal(changes.length, 2);
    assert.equal(placed.get(id).b.y, 2.7);
    tool.restore(id, changes[1][2]);
    assert.deepEqual(placed.get(id), first);
    tool.deleteSelected();
    assert.equal(placed.size, 0);
    tool.restore(id, changes[2][2]);
    assert.deepEqual(placed.get(id), first);
  } finally {
    tool.dispose();
  }
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
