import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { TerrainSystem } from '../world/TerrainSystem';
import { PropSystem } from '../world/PropSystem';
import { WeatherSystem } from '../world/WeatherSystem';
import { NightLighting, ExtraLight } from '../world/NightLighting';
import { getIslandSites, IslandSite, SiteKind } from '../world/IslandSites';
import { coastRadius } from '../world/IslandGenerator';
import { WORLD_HALF, worldSettings } from '../world/WorldSettings';
import { riverWorld } from '../world/rivers/RiverWorld';
import { RockField } from '../gathering/RockField';
import { RockKind } from '../gathering/GatheringConfig';
import { InventoryManager } from '../inventory/InventoryManager';
import { GameplayManager } from '../gameplay/GameplayManager';
import { CharacterController } from '../character/CharacterController';
import { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import { ParticleManager } from '../particles/ParticleManager';
import { audioEngine } from '../audio/AudioEngine';
import { t, dataName } from '../i18n/i18n';
import { buildLandmark, LandmarkAnchors } from './Landmarks';
import { STRUCTURE_MATERIALS } from './StructureBuilder';
import RAPIER from '@dimforge/rapier3d-compat';
import { CaveNetwork, CaveContentsWorld } from './cave/CaveNetwork';
import { isCaveLayout } from './cave/CaveGen';
import cavesJson from './cave/caves.json';
import { ForageField, ForageNode } from './ForageField';
import { EXPLORE_GRID } from './MapRenderer';

export type MapMarkerIcon = 'pin' | 'star' | 'home' | 'alert';

export interface MapMarker {
  id: number;
  x: number;
  z: number;
  icon: MapMarkerIcon;
}

interface Loot {
  items?: { itemId: string; amount: number }[];
  recipe?: string;
}

/** What each landmark's chest holds: a resource, a recipe or a treasure. */
const LOOT: Record<string, Loot> = {
  hut: { recipe: 'mushroom_stew', items: [{ itemId: 'tomato_seed', amount: 8 }, { itemId: 'pet_treat', amount: 3 }, { itemId: 'coins', amount: 40 }] },
  lighthouse: { recipe: 'seafood_platter', items: [{ itemId: 'coins', amount: 60 }, { itemId: 'shell', amount: 5 }] },
  ruins: { items: [{ itemId: 'coins', amount: 320 }, { itemId: 'gem_ruby', amount: 1 }, { itemId: 'gold_ore', amount: 4 }] },
  cave1: { items: [{ itemId: 'coins', amount: 160 }, { itemId: 'crystal', amount: 3 }, { itemId: 'gold_ore', amount: 2 }] },
  cave2: { items: [{ itemId: 'coins', amount: 220 }, { itemId: 'gem_ruby', amount: 1 }, { itemId: 'crystal', amount: 2 }] },
  cave3: { items: [{ itemId: 'coins', amount: 260 }, { itemId: 'gold_ore', amount: 3 }, { itemId: 'crystal', amount: 4 }] },
};

interface Chest {
  id: string;
  pos: THREE.Vector3;
  group: THREE.Group;
  body: RAPIER.RigidBody | null;
  /** Placed by the cave network (replaced whenever it is rebuilt). */
  cave: boolean;
  lid: THREE.Object3D;
  opened: boolean;
  open: number; // lid animation 0..1
}

interface CaveEntry {
  site: IslandSite;
  index: number;
}

type Action =
  | { kind: 'chest'; chest: Chest }
  | { kind: 'enterCave'; cave: CaveEntry }
  | { kind: 'exitCave'; cave: CaveEntry }
  | { kind: 'lookout'; site: IslandSite }
  | { kind: 'forage'; node: ForageNode };

export interface ExplorationSaveData {
  explored: string;
  discovered: string[];
  chests: string[];
  recipes: string[];
  markers: MapMarker[];
}

const DISCOVER_RADIUS = 30;
const REVEAL_RADIUS = 44;
const CELL = (WORLD_HALF * 2) / EXPLORE_GRID;
/**
 * The cave network lives in its own pocket of the world, far beyond the sea and the view distance:
 * cave-local x/z are island x/z (so the map knows where you are underground), shifted by this.
 */
const CAVE_ORIGIN = new THREE.Vector3(1500, 200, 0);

/**
 * Exploration layer of the island: landmarks with chests, caves (entered through a doorway that
 * fades and teleports, Valheim-style), place-bound resources (ore in the mountains, shells and sand on
 * the beaches, glowing mushrooms in caves), and the map: fog of war, discovered places, player pins.
 */
export class ExplorationManager {
  public readonly sites: IslandSite[] = getIslandSites();
  public readonly explored = new Uint8Array(EXPLORE_GRID * EXPLORE_GRID);
  public readonly discovered = new Set<string>();
  public markers: MapMarker[] = [];
  /** Id of the cave the player is in, or null outdoors. */
  public inCave: string | null = null;
  /** Bumped whenever getLights() may return something different. */
  public lightRevision = 0;
  /** Full-screen fade for doorways (the HUD animates it). */
  public fading = false;
  /** Bumped when anything the HUD / map shows changes. */
  public revision = 0;
  public prompt: { text: string; action: Action } | null = null;

  public onNotify: (text: string, type?: 'success' | 'info' | 'warning') => void = () => {};
  public onItems: (items: { itemId: string; amount: number }[]) => void = () => {};

  private readonly landmarks = new Map<string, LandmarkAnchors>();
  private chests: Chest[] = [];
  private readonly openedChestIds = new Set<string>();
  private readonly caves: CaveEntry[] = [];
  /** One network under the whole island; every cave mouth leads into it. */
  private readonly network: CaveNetwork;
  private readonly caveLights: ExtraLight[] = [];
  private caveLightKey = NaN;
  private caveHintShown = false;
  private readonly forage: ForageField;
  private readonly root = new THREE.Group();
  private revealTimer = 0;
  private promptTimer = 0;
  private transition: { t: number; swapped: boolean; run: () => void; ready: () => boolean } | null = null;
  private markerSeq = 1;
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
    private readonly terrain: TerrainSystem,
    private readonly props: PropSystem,
    private readonly rocks: RockField,
    private readonly inventory: InventoryManager,
    private readonly gameplay: GameplayManager,
    private readonly weather: WeatherSystem,
    private readonly nightLighting: NightLighting,
    particles: ParticleManager | null
  ) {
    this.root.name = 'Exploration';
    scene.add(this.root);
    this.forage = new ForageField(scene, particles);

    for (const site of this.sites) {
      const anchors = buildLandmark(site, scene, physics);
      this.landmarks.set(site.id, anchors);
      this.lightRevision++;
      if (anchors.chest && LOOT[site.id]) this.addChest(site.id, anchors.chest.pos, anchors.chest.yaw);
      if (site.kind === 'cave') {
        const index = this.caves.length;
        this.caves.push({ site, index });
      }
    }
    this.placeMountainOre();
    this.placeBeachForage();

    const coast = new Float32Array(360);
    for (let d = 0; d < 360; d++) coast[d] = coastRadius(Math.cos((d * Math.PI) / 180) * 100, Math.sin((d * Math.PI) / 180) * 100);
    this.network = new CaveNetwork(
      scene,
      physics,
      CAVE_ORIGIN,
      this.caves.map(({ site }) => ({ id: site.id, x: site.x, y: site.y, z: site.z, yaw: site.yaw, underwater: site.underwater })),
      coast,
      1337,
      // The authored layout (saved from the cave editor), or a procedural one when there is none
      isCaveLayout(cavesJson) ? cavesJson : null
    );
    this.network.onContents = (c) => this.populateCave(c);
    // A camera down in the network sees fog, not sky, at the far end of a tunnel
    this.weather.isCaveAt = (p) => this.network.contains(p);
    riverWorld.caveWater = (x, y, z) => this.network.waterLevelAt(x, y, z);
  }

  // ---------------------------------------------------------------- world dressing

  /**
   * Removes props that grew inside landmark clearings or now stand in a river's water (fresh
   * worlds and old saves alike: rivers are carved into the generated terrain, so a river added
   * later runs through forests saved before it existed).
   */
  public clearSiteProps(): void {
    const ids: number[] = [];
    for (const s of this.sites) this.props.forEachNear(s.x, s.z, s.pad + 3, (p) => ids.push(p.id));
    for (const p of this.props.list()) {
      if (p.grounded && riverWorld.depthAt(p.position.x, p.position.z) > 0.05) ids.push(p.id);
    }
    new Set(ids).forEach((id) => this.props.remove(id));
  }

  private nearSite(x: number, z: number, margin: number): boolean {
    return this.sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.pad + margin);
  }

  /** Ore veins scattered over the high mountain flanks: mostly iron and copper, a little gold. */
  private placeMountainOre(): void {
    let s = 4242;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    let placed = 0;
    for (let i = 0; i < 4000 && placed < 22; i++) {
      const x = -230 + rnd() * 330;
      const z = -230 + rnd() * 330;
      if (Math.hypot(x, z) > coastRadius(x, z) - 30 || this.nearSite(x, z, 6)) continue;
      const y = this.terrain.getHeight(x, z);
      if (y < 8) continue;
      const slope = Math.abs(this.terrain.getHeight(x + 1.5, z) - y) + Math.abs(this.terrain.getHeight(x, z + 1.5) - y);
      if (slope > 1.4 || !Number.isNaN(riverWorld.riverSurfaceAt(x, z))) continue;
      const roll = rnd();
      const kind: RockKind = y > 15 && roll < 0.3 ? 'gold' : roll < 0.12 ? 'gold' : roll < 0.55 ? 'copper' : 'iron';
      this.rocks.addRock(new THREE.Vector3(x, y - 0.15, z), kind, 0.85 + rnd() * 0.35);
      placed++;
    }
  }

  /** Shells and sand mounds strewn along the beach band of the whole coastline. */
  private placeBeachForage(): void {
    let s = 777;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const water = worldSettings.waterLevel;
    for (let deg = 0; deg < 360; deg += 3.2) {
      const a = (deg * Math.PI) / 180 + rnd() * 0.03;
      const cx = Math.cos(a), cz = Math.sin(a);
      // Walk in from the sea to the first dry sand
      for (let r = 245; r > 120; r -= 0.7) {
        const y = this.terrain.getHeight(cx * r, cz * r);
        if (y < water + 0.08) continue;
        if (y > water + 1.1 || this.nearSite(cx * r, cz * r, 2)) break;
        const rr = r - rnd() * 2;
        const x = cx * rr + (rnd() - 0.5) * 2, z = cz * rr + (rnd() - 0.5) * 2;
        const gy = this.terrain.getHeight(x, z);
        if (gy > water + 0.05 && gy > riverWorld.waterLevelAt(x, z) + 0.05) this.forage.add(rnd() < 0.62 ? 'shell' : 'sand', new THREE.Vector3(x, gy, z));
        break;
      }
    }
  }

  private addChest(id: string, pos: THREE.Vector3, yaw: number, cave = false): void {
    const group = new THREE.Group();
    group.position.copy(pos);
    group.rotation.y = yaw;
    const wood = STRUCTURE_MATERIALS.wood, band = STRUCTURE_MATERIALS.gold, dark = STRUCTURE_MATERIALS.darkWood;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.6), wood);
    base.position.y = 0.25;
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.08, 0.64), band);
    trim.position.y = 0.46;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.06, 0.66), dark);
    foot.position.y = 0.03;
    // The lid hinges at the back edge
    const lid = new THREE.Group();
    lid.position.set(0, 0.5, -0.3);
    const lidGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.9, 10, 1, false, 0, Math.PI);
    lidGeo.rotateZ(Math.PI / 2);
    lidGeo.translate(0, 0, 0.3);
    const lidMesh = new THREE.Mesh(lidGeo, wood);
    lidMesh.scale.set(1, 0.6, 1);
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.06), band);
    lock.position.set(0, 0.02, 0.6);
    lid.add(lidMesh, lock);
    group.add(base, trim, foot, lid);
    this.root.add(group);
    const { body } = this.physics.createStaticBox(pos.clone().setY(pos.y + 0.3), new THREE.Vector3(0.9, 0.6, 0.6), new THREE.Euler(0, yaw, 0));
    this.chests.push({ id, pos: pos.clone(), group, body, cave, lid, opened: false, open: 0 });
  }

  // ---------------------------------------------------------------- caves

  /**
   * The network's chests, ore and mushrooms belong to the shared systems: added when it is built,
   * and replaced when the cave editor rebuilds it.
   */
  private populateCave(c: CaveContentsWorld): void {
    const inCave = (p: THREE.Vector3) => this.network.contains(p);
    this.rocks.removeRocksWhere(inCave);
    this.forage.removeWhere((n) => inCave(n.position));
    this.chests = this.chests.filter((ch) => {
      if (!ch.cave) return true;
      if (ch.body) this.physics.removeRigidBody(ch.body);
      ch.group.removeFromParent();
      ch.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      return false;
    });
    for (const o of c.ores) this.rocks.addRock(o.pos.clone().setY(o.pos.y - 0.1), o.kind, o.kind === 'crystal' ? 0.9 : 0.8);
    for (const m of c.mushrooms) this.forage.add('mushroom', m);
    for (const ch of c.chests) {
      if (!LOOT[ch.id]) continue;
      this.addChest(ch.id, ch.pos, ch.yaw, true);
      if (this.openedChestIds.has(ch.id)) this.markChestOpened(ch.id, true);
    }
    this.caveLightKey = NaN;
    this.lightRevision++;
    this.revision++;
  }

  /** The cave network (the developer editor edits and rebuilds it). */
  public get caveNetwork(): CaveNetwork {
    return this.network;
  }

  private enterCave(cave: CaveEntry, character: CharacterController, camera: ThirdPersonCamera): void {
    // The network is generated in a worker from startup; if it is not done yet the fade waits for it
    this.startTransition(
      () => {
        const e = this.network.entrances.find((en) => en.id === cave.site.id);
        if (!e) return;
        this.network.finishColliders();
        character.respawn(e.spawn.clone().setY(e.spawn.y + 0.9));
        character.model.setFacingAngleInstant(e.yaw);
        camera.targetYaw = e.yaw + Math.PI;
        this.inCave = cave.site.id;
        this.caveLightKey = NaN;
        this.lightRevision++;
        this.gameplay.anchorOverride = this.landmarks.get(cave.site.id)?.action?.clone() ?? null;
        this.discover(cave.site);
        if (!this.caveHintShown) {
          this.caveHintShown = true;
          this.onNotify(t('explore.caveNetwork'), 'info');
        }
        this.revision++;
      },
      () => this.network.ready
    );
  }

  /** Out through any mouth of the network, onto that cave's pad on the surface. */
  private exitCave(cave: CaveEntry, character: CharacterController, camera: ThirdPersonCamera): void {
    this.startTransition(() => {
      const out = this.outsideSpot(cave);
      character.respawn(out.setY(out.y + 0.9));
      character.model.setFacingAngleInstant(cave.site.yaw);
      camera.targetYaw = cave.site.yaw + Math.PI;
      this.inCave = null;
      this.lightRevision++;
      this.gameplay.anchorOverride = null;
      this.discover(cave.site);
      this.revision++;
    });
  }

  /**
   * Moves the player to `pos` behind the doorway fade (the respawn button). From the caves this
   * also leaves the underground, exactly like walking out of a mouth.
   */
  public teleport(character: CharacterController, camera: ThirdPersonCamera, pos: THREE.Vector3, done?: () => void): void {
    this.startTransition(() => {
      character.respawn(pos);
      camera.targetYaw = character.model.group.rotation.y + Math.PI;
      if (this.inCave) {
        this.inCave = null;
        this.lightRevision++;
        this.gameplay.anchorOverride = null;
      }
      this.revision++;
      done?.();
    });
  }

  /** Just outside a cave's mouth, on the levelled pad. */
  private outsideSpot(cave: CaveEntry): THREE.Vector3 {
    const s = cave.site;
    const x = s.x + Math.sin(s.yaw) * 1.5, z = s.z + Math.cos(s.yaw) * 1.5;
    return new THREE.Vector3(x, this.terrain.getHeight(x, z), z);
  }

  /** Where the player is on the island: underground, the spot on the surface right above them. */
  public surfacePosition(playerPos: THREE.Vector3): THREE.Vector3 {
    if (!this.inCave) return playerPos.clone();
    const x = THREE.MathUtils.clamp(playerPos.x - CAVE_ORIGIN.x, -WORLD_HALF, WORLD_HALF);
    const z = THREE.MathUtils.clamp(playerPos.z - CAVE_ORIGIN.z, -WORLD_HALF, WORLD_HALF);
    return new THREE.Vector3(x, this.terrain.getHeight(x, z), z);
  }

  /** Where a save made now should resume: underground, outside the nearest cave mouth. */
  public savePosition(playerPos: THREE.Vector3): THREE.Vector3 {
    if (!this.inCave) return playerPos.clone();
    let best: CaveEntry | null = null;
    let bestD = Infinity;
    for (const c of this.caves) {
      const d = Math.hypot(c.site.x - (playerPos.x - CAVE_ORIGIN.x), c.site.z - (playerPos.z - CAVE_ORIGIN.z));
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best ? this.outsideSpot(best) : playerPos.clone();
  }

  /** `ready`: the swap waits (the screen stays dark) until it returns true. */
  private startTransition(run: () => void, ready: () => boolean = () => true): void {
    if (this.transition) return;
    this.transition = { t: 0, swapped: false, run, ready };
    this.fading = true;
    this.revision++;
    audioEngine.playBuildSelect();
  }

  // ---------------------------------------------------------------- frame

  /** `playerPos` is the player or the vehicle they ride; prompts only show on foot (`onFoot`). */
  public update(dt: number, playerPos: THREE.Vector3, onFoot: boolean): void {
    this.forage.update(dt);
    const night = Math.max(this.weather.nightFactor, this.inCave ? 1 : 0);
    for (const lm of this.landmarks.values()) lm.update?.(dt, this.inCave ? 0 : night);
    for (const c of this.chests) {
      if (c.opened && c.open < 1) {
        c.open = Math.min(1, c.open + dt * 2.2);
        c.lid.rotation.x = -c.open * 1.9;
      }
    }
    this.weather.caveFactor = this.inCave ? 1 : 0;
    this.nightLighting.forcedDark = this.inCave ? 1 : 0;
    this.network.update(dt, playerPos, !!this.inCave);
    // Cave lights come from the buckets around the player: refresh on crossing into another one
    if (this.inCave) {
      const key = this.network.lightKey(playerPos);
      if (key !== this.caveLightKey) {
        this.caveLightKey = key;
        this.caveLights.length = 0;
        this.network.lightsNear(playerPos, this.caveLights);
        this.lightRevision++;
      }
    }

    if (this.transition) {
      const tr = this.transition;
      tr.t += dt;
      // The HUD fade takes ~0.35 s; swap while the screen is black, then fade back in
      if (!tr.swapped && tr.t > 0.4) {
        if (!tr.ready()) {
          tr.t = 0.4;
          return;
        }
        tr.swapped = true;
        tr.run();
      }
      if (tr.t > 0.55 && this.fading) {
        this.fading = false;
        this.revision++;
      }
      if (tr.t > 0.95) this.transition = null;
    }

    // Fog of war and discovery, a couple of times per second
    this.revealTimer -= dt;
    if (this.revealTimer <= 0 && !this.inCave) {
      this.revealTimer = 0.4;
      this.reveal(playerPos.x, playerPos.z, REVEAL_RADIUS);
      for (const s of this.sites) {
        if (!this.discovered.has(s.id) && Math.hypot(s.x - playerPos.x, s.z - playerPos.z) < DISCOVER_RADIUS) this.discover(s);
      }
    }

    if (!onFoot) {
      this.setPrompt(null);
      return;
    }
    this.promptTimer -= dt;
    if (this.promptTimer <= 0) {
      this.promptTimer = 0.1;
      this.setPrompt(this.transition ? null : this.computePrompt(playerPos));
    }
  }

  private computePrompt(pos: THREE.Vector3): { text: string; action: Action } | null {
    const feet = this.tmp.set(pos.x, pos.y - 0.75, pos.z);
    const near = (p: THREE.Vector3, r: number) => Math.hypot(p.x - feet.x, p.z - feet.z) < r && Math.abs(p.y - feet.y) < 2.2;

    for (const c of this.chests) {
      if (!c.opened && near(c.pos, 1.9)) return { text: t('explore.openChest'), action: { kind: 'chest', chest: c } };
    }
    if (this.inCave) {
      for (const e of this.network.entrances) {
        if (!near(e.mouth, 2.2)) continue;
        const cave = this.caves.find((c) => c.site.id === e.id);
        if (cave) return { text: t('explore.exitCave'), action: { kind: 'exitCave', cave } };
      }
    }
    if (!this.inCave) {
      for (const c of this.caves) {
        const a = this.landmarks.get(c.site.id)?.action;
        if (a && near(a, 2.6)) return { text: t('explore.enterCave'), action: { kind: 'enterCave', cave: c } };
      }
      const lh = this.sites.find((s) => s.kind === 'lighthouse');
      const lhAction = lh && this.landmarks.get(lh.id)?.action;
      if (lh && lhAction && near(lhAction, 2.2)) return { text: t('explore.lookout'), action: { kind: 'lookout', site: lh } };
    }
    const node = this.forage.findNearest(feet);
    if (node) return { text: t(`explore.pick.${node.kind}`), action: { kind: 'forage', node } };
    return null;
  }

  private setPrompt(p: { text: string; action: Action } | null): void {
    if (p?.text === this.prompt?.text && p?.action.kind === this.prompt?.action.kind) {
      this.prompt = p;
      return;
    }
    this.prompt = p;
    this.revision++;
  }

  /** Runs the current prompt's action (E key / touch button). */
  public interact(character: CharacterController, camera: ThirdPersonCamera): void {
    const a = this.prompt?.action;
    if (!a || this.transition) return;
    if (a.kind === 'chest') this.openChest(a.chest);
    else if (a.kind === 'enterCave') this.enterCave(a.cave, character, camera);
    else if (a.kind === 'exitCave') this.exitCave(a.cave, character, camera);
    else if (a.kind === 'lookout') {
      this.startTransition(() => {
        this.reveal(a.site.x, a.site.z, 175);
        this.onNotify(t('explore.lookedOut'), 'success');
      });
    } else if (a.kind === 'forage') {
      const items = this.forage.take(a.node);
      items.forEach(({ itemId, amount }) => this.inventory.addItem(itemId, amount));
      this.onItems(items);
      audioEngine.playHarvest();
    }
    this.promptTimer = 0;
    this.setPrompt(null);
  }

  private openChest(chest: Chest): void {
    const loot = LOOT[chest.id];
    this.markChestOpened(chest.id, false);
    audioEngine.at(chest.pos).playHarvest();
    const items = loot.items ?? [];
    items.forEach(({ itemId, amount }) => this.inventory.addItem(itemId, amount));
    let head: string;
    if (loot.recipe && !this.gameplay.knownRecipes.has(loot.recipe)) {
      this.gameplay.knownRecipes.add(loot.recipe);
      this.gameplay.revision++;
      head = t('explore.recipeFound', { name: this.gameplay.recipeName(loot.recipe) });
    } else {
      head = t(items.some((i) => i.itemId === 'coins' && i.amount >= 150) ? 'explore.treasure' : 'explore.chestOpened');
    }
    // One toast: the HUD shows a single message at a time
    const list = items.map(({ itemId, amount }) => `+${amount} ${dataName('item', itemId, this.inventory.getItem(itemId)?.name ?? itemId)}`);
    this.onNotify([head, ...list].join('  ·  '), 'success');
  }

  private markChestOpened(id: string, instant: boolean): void {
    this.openedChestIds.add(id);
    const chest = this.chests.find((c) => c.id === id);
    if (!chest) return;
    chest.opened = true;
    if (instant) {
      chest.open = 1;
      chest.lid.rotation.x = -1.9;
    }
    this.revision++;
  }

  // ---------------------------------------------------------------- map

  private discover(site: IslandSite): void {
    if (this.discovered.has(site.id)) return;
    this.discovered.add(site.id);
    this.reveal(site.x, site.z, 30);
    this.onNotify(t('explore.discovered', { name: t(`site.${site.kind}`) }), 'info');
    this.revision++;
  }

  public reveal(x: number, z: number, radius: number): void {
    const r = Math.ceil(radius / CELL);
    const cx = Math.floor((x + WORLD_HALF) / CELL), cz = Math.floor((z + WORLD_HALF) / CELL);
    let changed = false;
    for (let j = cz - r; j <= cz + r; j++) {
      for (let i = cx - r; i <= cx + r; i++) {
        if (i < 0 || j < 0 || i >= EXPLORE_GRID || j >= EXPLORE_GRID) continue;
        const d = Math.hypot(i - cx, j - cz) * CELL;
        if (d > radius) continue;
        // Soft edge: cells near the rim are only half revealed
        const v = d > radius - CELL * 2 ? 140 : 255;
        const k = j * EXPLORE_GRID + i;
        if (this.explored[k] < v) {
          this.explored[k] = v;
          changed = true;
        }
      }
    }
    if (changed) this.revision++;
  }

  public addMarker(x: number, z: number, icon: MapMarkerIcon): void {
    if (this.markers.length >= 40) this.markers.shift();
    this.markers.push({ id: this.markerSeq++, x, z, icon });
    this.revision++;
  }

  public removeMarker(id: number): void {
    this.markers = this.markers.filter((m) => m.id !== id);
    this.revision++;
  }

  /** Landmarks for the map and compass: discovered ones by name, nearby unknown ones as "?". */
  public getMapSites(playerPos: THREE.Vector3): { id: string; kind: SiteKind; x: number; z: number; known: boolean; done: boolean }[] {
    const surface = this.surfacePosition(playerPos);
    return this.sites
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        x: s.x,
        z: s.z,
        known: this.discovered.has(s.id),
        done: !LOOT[s.id] || this.openedChestIds.has(s.id),
      }))
      .filter((s) => s.known || Math.hypot(s.x - surface.x, s.z - surface.z) < 140);
  }

  /** Extra night lights: landmark torches and the lantern room, plus the current cave's glow. */
  public getLights(): ExtraLight[] {
    const out: ExtraLight[] = [];
    if (this.inCave) {
      for (const l of this.caveLights) out.push(l);
    } else {
      for (const lm of this.landmarks.values()) out.push(...lm.lights);
    }
    return out;
  }

  // ---------------------------------------------------------------- save / load

  public serialize(): ExplorationSaveData {
    // Run-length encoded fog of war: pairs of (count, value)
    const runs: number[] = [];
    for (let i = 0; i < this.explored.length; ) {
      const v = this.explored[i];
      let n = 1;
      while (i + n < this.explored.length && this.explored[i + n] === v && n < 65535) n++;
      runs.push(n, v);
      i += n;
    }
    return {
      explored: runs.join(','),
      discovered: [...this.discovered],
      chests: [...this.openedChestIds],
      recipes: [...this.gameplay.knownRecipes],
      markers: this.markers,
    };
  }

  public deserialize(data: ExplorationSaveData | undefined): void {
    this.explored.fill(0);
    if (data?.explored) {
      const nums = data.explored.split(',').map(Number);
      let p = 0;
      for (let i = 0; i + 1 < nums.length; i += 2) {
        this.explored.fill(nums[i + 1], p, Math.min(this.explored.length, p + nums[i]));
        p += nums[i];
      }
    }
    this.discovered.clear();
    data?.discovered?.forEach((id) => this.discovered.add(id));
    data?.chests?.forEach((id) => this.markChestOpened(id, true));
    this.gameplay.knownRecipes.clear();
    data?.recipes?.forEach((id) => this.gameplay.knownRecipes.add(id));
    this.markers = data?.markers ?? [];
    this.inCave = null;
    this.lightRevision++;
    this.gameplay.anchorOverride = null;
    this.markerSeq = this.markers.reduce((m, k) => Math.max(m, k.id), 0) + 1;
    this.caveLightKey = NaN;
    this.revision++;
  }

  public dispose(): void {
    this.network.dispose();
    riverWorld.caveWater = null;
  }
}
