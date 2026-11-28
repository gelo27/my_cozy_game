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
let BulldozerController;
let interactionFocus;
let createBulldozerClearing;
let FarmingManager;
let PropTreeField;
let FlowerBeds;

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
    ({ BulldozerController } = await server.ssrLoadModule('/src/vehicle/BulldozerController.ts'));
    ({ interactionFocus } = await server.ssrLoadModule('/src/gameplay/InteractionFocus.ts'));
    ({ createBulldozerClearing } = await server.ssrLoadModule('/src/vehicle/BulldozerClearing.ts'));
    ({ FarmingManager } = await server.ssrLoadModule('/src/farming/FarmingManager.ts'));
    ({ PropTreeField } = await server.ssrLoadModule('/src/gathering/PropTreeField.ts'));
    ({ FlowerBeds } = await server.ssrLoadModule('/src/gathering/FlowerBeds.ts'));
  } finally {
    delete globalThis.document;
  }
});

after(async () => {
  await server?.close();
});

test('blade grades across a chunk edge, softens its sides and skips an unchanged pass', () => {
  const terrain = Object.create(terrainConstants.TerrainSystem.prototype);
  const size = starter.terrain.size;
  terrain.heights = new Float32Array((size + 1) ** 2).fill(30);
  const edits = [];
  terrain.markHeightsDirty = (...rect) => edits.push(rect);
  const at = (x, z) => terrain.heights[(z + size / 2) * (size + 1) + x + size / 2];
  assert.equal(terrain.gradeStrip(-1, 64, 1, 64, 1.85, 30), false);
  assert.equal(terrain.gradeStrip(-1, 64, 1, 64, 1.85, 29.75), true);
  assert.equal(at(0, 64), 29.75);
  assert.ok(at(0, 65) > 29.75 && at(0, 65) < 30);
  assert.equal(at(0, 66), 30);
  const [[x0, z0, x1, z1]] = edits;
  assert.ok(x0 < size / 2 && x1 > size / 2 && z0 < size / 2 + 64 && z1 > size / 2 + 64);
});

test('a graded strip collects plants and field resources once and exposes dirt only in its path', () => {
  const terrain = Object.create(terrainConstants.TerrainSystem.prototype);
  const size = starter.terrain.size;
  terrain.heights = new Float32Array((size + 1) ** 2).fill(30);
  terrain.tiles = new Uint8Array(size ** 2);
  const textureUpdates = [];
  terrain.markSplatDirty = (...bounds) => textureUpdates.push(bounds);
  const makePlant = (id, type, x, z) => ({ id, type, position: new Vector3(x, 30, z), grounded: true, rotationY: 0 });
  const outside = makePlant(4, 'tree_pine', 3, 66);
  const plants = new Map([
    [1, makePlant(1, 'tree_pine', 0, 64)],
    [2, makePlant(2, 'bush', 1, 65)],
    [3, makePlant(3, 'flowers', 2, 64)],
    [5, makePlant(5, 'couch_grass', 3, 64)],
    [outside.id, outside],
  ]);
  const props = {
    forEachNear: (_x, _z, _r, visit) => plants.forEach(visit),
    get: id => plants.get(id),
    remove: id => plants.delete(id),
  };
  const propTrees = new PropTreeField(props, null);
  const flowers = Object.assign(Object.create(FlowerBeds.prototype), { props });
  const field = { id: 'crop', gx: 2, gz: 64, center: new Vector3(3.5, 30, 65.5), crop: { cropType: 'wheat', stage: 1 } };
  const other = { id: 'next', gx: 1, gz: 66, center: new Vector3(2.5, 30, 67.5), crop: null };
  const fields = new Map([[field.id, field], [other.id, other]]);
  const farming = Object.assign(Object.create(FarmingManager.prototype), {
    fields: {
      forEachInBounds: (_x0, _z0, _x1, _z1, visit) => fields.forEach(visit),
      removeField: id => {
        const removed = fields.delete(id);
        terrain.tiles[(64 + size / 2) * size + 2 + size / 2] = 0;
        return removed;
      },
    },
  });
  const rewards = [];
  const clear = createBulldozerClearing({
    terrain, props, propTrees, flowers, farming,
    orchard: { clearForGrading: noop }, nursery: { clearForGrading: noop },
    collect: items => rewards.push(items),
  });
  const pavingIndex = (64 + size / 2) * size + 1 + size / 2;
  terrain.tiles[pavingIndex] = 3;
  clear(0, 64, 4, 64, 1.85);
  clear(0, 64, 4, 64, 1.85);
  assert.deepEqual([...plants.keys()], [outside.id]);
  assert.deepEqual([...fields.keys()], [other.id]);
  assert.equal(rewards.length, 1);
  const loot = Object.fromEntries(rewards[0].map(({ itemId, amount }) => [itemId, amount]));
  assert.ok(loot.wood > 1);
  assert.equal(loot.pine_cone, 1);
  assert.equal(loot.bush_sapling, 1);
  assert.equal(loot.tulip_purple, 1);
  assert.equal(loot.wheat_seed, 3);
  assert.equal(terrain.getTile(2, 64), 1);
  assert.equal(terrain.getTile(1, 64), 3);
  assert.equal(terrain.getTile(3, 66), 0);
  assert.equal(textureUpdates.length, 1);
});

test('raycast bulldozer pivots, protects structures and clears a tall ridge before reaching it', async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -22, z: 0 });
  const packCollisionGroups = (membership, filter) => (membership << 16) | filter;
  const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(70, 1, 70).setTranslation(0, 29, 0)
    .setCollisionGroups(packCollisionGroups(0x21, 0xffff)), floor);
  let grades = 0;
  let commits = 0;
  const terrain = {
    getHeight: () => 30,
    gradeStrip: () => { grades++; return true; },
    commit: () => { commits++; },
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const canvas = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop, beginPath: noop, arc: noop, fill: noop, fillText: noop,
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { createElement: () => ({ getContext: () => canvas }) },
  });
  let dozer;
  try {
    const physics = { rapier: RAPIER, world, packCollisionGroups, removeRigidBody: body => world.removeRigidBody(body) };
    dozer = new BulldozerController(physics, new Scene(), terrain, new Vector3(0, 30.35, 0));
    const camera = { targetYaw: 0 };
    const character = {
      body: { translation: () => ({ x: 0, y: 31, z: 1.8 }), setBodyType: noop, setTranslation: noop },
      collider: { setEnabled: noop }, model: { group: { visible: true } }, respawn: noop,
    };
    const movement = { forward: 0, right: 0, jump: false, interactJustPressed: false, bladeToggleJustPressed: false };
    const tick = (count, afterTick = noop) => {
      for (let i = 0; i < count; i++) {
        dozer.update(1 / 60, { movement }, camera, character, true);
        movement.interactJustPressed = movement.bladeToggleJustPressed = false;
        dozer.step(1 / 60);
        world.step();
        dozer.syncVisuals(1 / 60);
        afterTick(i);
      }
    };
    tick(45);
    interactionFocus.resolve(new Vector3(0, 31, 1.8), new Vector3(0, 0, -1));
    movement.interactJustPressed = true;
    tick(1);
    assert.equal(dozer.getControls(), 'raised');
    movement.right = 1;
    tick(50);
    assert.ok(dozer.getYaw() < -0.65, `expected a quick right pivot, yaw=${dozer.getYaw()}`);
    assert.ok(Math.hypot(dozer.getPosition().x, dozer.getPosition().z) < 0.4);
    dozer.place(new Vector3(0, 30.12, 0));
    movement.right = 0;
    movement.forward = 1;
    tick(50);
    assert.ok(dozer.getPosition().z > 1, `expected forward movement, z=${dozer.getPosition().z}`);
    assert.equal(grades, 0);
    const treeZ = dozer.getPosition().z + 2.45;
    const tree = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const trunk = world.createCollider(RAPIER.ColliderDesc.cylinder(0.9, 0.26).setTranslation(0, 30.9, treeZ), tree);
    trunk.userData = { bladeClearable: true };
    let clearedTrunk = false;
    dozer.onGradeStrip = (_ax, az, _bx, bz, halfWidth) => {
      if (clearedTrunk || treeZ > Math.max(az, bz) + halfWidth || treeZ < Math.min(az, bz) - halfWidth) return;
      world.removeRigidBody(tree);
      clearedTrunk = true;
    };
    movement.bladeToggleJustPressed = true;
    tick(60);
    assert.ok(grades > 0, 'expected forward grading');
    assert.equal(clearedTrunk, true, 'a tree collider should allow blade clearing');
    dozer.onGradeStrip = null;
    const wall = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(RAPIER.ColliderDesc.cuboid(3, 1, 0.3).setTranslation(0, 31, dozer.getPosition().z + 4), wall);
    tick(105);
    assert.equal(dozer.getControls(), 'blocked');
    movement.bladeToggleJustPressed = true;
    movement.jump = true;
    tick(35);
    assert.equal(dozer.getControls(), 'raised');
    assert.equal(commits, 1);
    assert.ok(dozer.speedKmh < 0.5);
    movement.interactJustPressed = true;
    tick(1);
    assert.equal(dozer.getControls(), 'off');
    assert.equal(character.model.group.visible, true);

    // A 3.6 m ridge with a steep face starts just ahead of the lowered blade.
    world.removeRigidBody(floor);
    world.removeRigidBody(wall);
    const land = Object.create(terrainConstants.TerrainSystem.prototype);
    const size = starter.terrain.size;
    const index = (x, z) => (z + size / 2) * (size + 1) + x + size / 2;
    land.heights = new Float32Array((size + 1) ** 2).fill(30);
    for (let x = -5; x <= 5; x++) {
      for (let z = 3; z <= 5; z++) land.heights[index(x, z)] = 33.6;
    }
    let dirty = false;
    let ridgeCollider;
    let aheadCuts = 0;
    land.markHeightsDirty = () => { dirty = true; };
    const rebuildRidge = () => {
      if (ridgeCollider) world.removeCollider(ridgeCollider, false);
      const heights = new Float32Array(25 ** 2);
      for (let x = 0; x <= 24; x++) {
        for (let z = 0; z <= 24; z++) heights[x * 25 + z] = land.heights[index(x - 12, z - 12)];
      }
      ridgeCollider = world.createCollider(RAPIER.ColliderDesc.heightfield(24, 24, heights, { x: 24, y: 1, z: 24 })
        .setCollisionGroups(packCollisionGroups(0x21, 0xffff)));
      dirty = false;
    };
    rebuildRidge();
    terrain.getHeight = land.getHeight.bind(land);
    terrain.gradeStrip = (...args) => {
      const changed = land.gradeStrip(...args);
      if (changed && args[6]) aheadCuts++;
      return changed;
    };
    terrain.commit = () => { if (dirty) rebuildRidge(); };
    dozer.place(new Vector3(0, 30.35, 0.7));
    movement.forward = 0;
    movement.jump = false;
    tick(55);
    interactionFocus.resolve(new Vector3(0, 31, 1.8), new Vector3(0, 0, -1));
    movement.interactJustPressed = true;
    tick(1);
    assert.equal(dozer.getControls(), 'raised');
    movement.bladeToggleJustPressed = true;
    tick(30);
    assert.equal(aheadCuts, 0, 'an idle blade should leave the ridge alone');
    const startZ = dozer.getPosition().z;
    movement.forward = 1;
    tick(5);
    assert.ok(aheadCuts > 0, 'the blade should cut at the start of the approach');
    assert.ok(dozer.getPosition().z - startZ < 0.25, 'the chassis should still be on the approach');
    assert.ok(land.getHeight(0, 3) < 30.15, 'the face should already be cut down');
    assert.equal(dirty, false, 'the new heightfield should already be available to physics');
    let slowestOnRidge = Infinity;
    const updateRidge = i => {
      if (dirty && i % 15 === 14) rebuildRidge();
      const z = dozer.getPosition().z;
      if (z > 2.1 && z < 5.5) slowestOnRidge = Math.min(slowestOnRidge, dozer.body.linvel().z);
    };
    tick(160, updateRidge);
    assert.ok(land.getHeight(0, 4) < 30.3, 'the centre of the ridge should be graded to the approach height');
    assert.ok(dozer.getPosition().z > 5.5, `the dozer should keep moving past the ridge, z=${dozer.getPosition().z}`);
    assert.ok(Number.isFinite(slowestOnRidge) && slowestOnRidge > 0.5, `the chassis stalled on the ridge, speed=${slowestOnRidge}`);
    assert.ok(dozer.body.linvel().z > 3.15, 'the lowered blade should allow the faster working speed');

    // The same preview should fill a deep dry pit before the front tracks lose support.
    land.heights.fill(30);
    for (let x = -5; x <= 5; x++) {
      for (let z = 3; z <= 7; z++) land.heights[index(x, z)] = 25;
    }
    rebuildRidge();
    dozer.place(new Vector3(0, 30.35, 0.7));
    movement.forward = 0;
    tick(45);
    movement.bladeToggleJustPressed = true;
    movement.forward = 1;
    tick(5);
    assert.ok(land.getHeight(0, 3) > 28.95, 'rapid grading should add four metres before the tracks enter the pit');
    assert.equal(dirty, false, 'the filled heightfield should be available to physics immediately');
    let lowestInPit = Infinity;
    tick(190, i => {
      if (dirty && i % 15 === 14) rebuildRidge();
      const position = dozer.getPosition();
      if (position.z > 2.1 && position.z < 8) lowestInPit = Math.min(lowestInPit, position.y);
      if (position.z > 8.8) movement.forward = 0;
    });
    assert.ok(dozer.getPosition().z > 8, 'the dozer should drive across the pit on the fill');
    assert.ok(Number.isFinite(lowestInPit) && lowestInPit > 29.5, `the chassis dropped into the fill, y=${lowestInPit}`);
    assert.ok(land.getHeight(0, 6) > 29.7, 'successive stamps should bring the pit to the working level');

    land.heights.fill(30);
    rebuildRidge();
    dozer.place(new Vector3(0, 30.35, -5));
    movement.forward = 1;
    tick(85);
    assert.ok(dozer.body.linvel().z > 5.6, 'the raised blade should allow the faster travel speed');

    // The tracks should carry it through uneven ground with the blade raised, in either direction.
    land.heights.fill(30);
    for (let x = -4; x <= 4; x++) {
      land.heights[index(x, 2)] = 30.7;
      land.heights[index(x, 4)] = 30.96;
      land.heights[index(x, 6)] = x > 0 ? 30.86 : 30.5;
      land.heights[index(x, 7)] = 30.32;
    }
    rebuildRidge();
    dozer.place(new Vector3(0, 30.35, -0.2));
    movement.forward = 0;
    tick(40);
    const previousCuts = aheadCuts;
    assert.equal(dozer.getControls(), 'raised');
    movement.forward = 1;
    tick(215, () => { if (dozer.getPosition().z > 8.6) movement.forward = 0; });
    const forwardEnd = dozer.getPosition().z;
    assert.ok(forwardEnd > 7.8, JSON.stringify({
      position: dozer.getPosition(), yaw: dozer.getYaw(), velocity: dozer.body.linvel(),
      rotation: dozer.body.rotation(), contacts: Array.from({ length: 6 }, (_, i) => dozer.vehicle.wheelIsInContact(i)),
    }));
    movement.forward = -1;
    tick(340);
    assert.ok(dozer.getPosition().z < 1, `the raised dozer got stuck reversing, z=${dozer.getPosition().z}, speed=${dozer.body.linvel().z}`);
    assert.equal(aheadCuts, previousCuts);
    assert.ok(land.getHeight(0, 4) > 30.9);
  } finally {
    interactionFocus.clear();
    dozer?.dispose();
    world.free();
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else delete globalThis.document;
  }
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
    bulldozer: { getPosition: () => new Vector3(), getYaw: () => 0, place: noop },
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
  }, { revision: 0, getHeight: () => 0 });
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

test('bridge supports reach uneven ground in both LODs and share the bridge collider', async () => {
  await RAPIER.init();
  const scene = new Scene();
  const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  let collider;
  let lift = 0;
  const terrain = { revision: 0, getHeight: (x) => (x < 0 ? -3 : -1) + lift };
  const bridges = new BridgeSystem(scene, {
    rapier: RAPIER,
    createStaticTrimesh: (origin, vertices, indices, _group, flags) => {
      const body = physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(origin.x, origin.y, origin.z));
      collider = physics.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices, flags), body);
      return { body, collider };
    },
    removeRigidBody: (body) => physics.removeRigidBody(body),
  }, terrain);
  const def = { ...testBridge(), a: { x: 0, y: 4, z: 0 }, b: { x: 0, y: 4, z: 12 }, supportCount: 2, railings: false };
  try {
    bridges.set(def.id, def);
    const group = scene.children[0];
    const mesh = group.children[0];
    const lowest = (geometry) => {
      geometry.computeBoundingBox();
      return geometry.boundingBox.min.y + def.a.y;
    };
    const preview = bridges.preview(def);
    assert.deepEqual(preview.geometry.attributes.position.array, mesh.geometry.attributes.position.array);
    bridges.releaseMesh(preview);
    assert.ok(Math.abs(lowest(mesh.geometry) - (-3.15)) < 1e-5);
    const sideRay = (z) => new RAPIER.Ray({ x: -2, y: 0, z }, { x: 1, y: 0, z: 0 });
    assert.ok(collider.castRay(sideRay(4), 4, true) > 0);
    assert.ok(collider.castRay(sideRay(8), 4, true) > 0);
    assert.equal(collider.castRay(sideRay(6), 4, true), -1);

    const camera = new Vector3(70, 4, 6);
    bridges.updateLod(camera);
    assert.equal(group.children.length, 1);
    assert.equal(group.children[0], mesh);
    assert.ok(Math.abs(lowest(mesh.geometry) - (-3.15)) < 1e-5);
    lift = 1;
    terrain.revision++;
    bridges.updateLod(camera);
    assert.equal(group.children.length, 1);
    assert.ok(Math.abs(lowest(group.children[0].geometry) - (-2.15)) < 1e-5);
    assert.equal(physics.colliders.len(), 1);
  } finally {
    bridges.dispose();
    physics.free();
  }
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
  const bridge = { ...testBridge(), shape: 'eased', railings: false, supportCount: 3 };
  slots.set('cozyfarm.save.bridges', JSON.stringify({ ...starter, bridges: [bridge] }));
  assert.equal(saves.load('bridges'), true);
  assert.equal(saves.save('bridge-roundtrip'), true);
  assert.deepEqual(JSON.parse(slots.get('cozyfarm.save.bridge-roundtrip')).bridges, [bridge]);

  for (const bridges of [[bridge, bridge], [{ ...bridge, b: bridge.a }], [{ ...bridge, rise: 12 }],
    ...[-1, 1.5, 9, '2'].map((supportCount) => [{ ...bridge, supportCount }])]) {
    slots.set('cozyfarm.save.bad-bridges', JSON.stringify({ ...starter, bridges }));
    assert.equal(saves.load('bad-bridges'), false);
    assert.deepEqual(world.bridges.serialize(), [bridge]);
  }
  const { supportCount: _supportCount, ...oldBridge } = bridge;
  slots.set('cozyfarm.save.old-bridge', JSON.stringify({ ...starter, bridges: [oldBridge] }));
  assert.equal(saves.load('old-bridge'), true);
  assert.deepEqual(world.bridges.serialize(), [oldBridge]);
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
