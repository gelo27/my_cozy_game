import * as THREE from 'three';
import { DEFAULT_FLOOR_MATERIAL } from '../building/config/DefaultFloorMaterials';
import { COLLISION_GROUPS } from '../config/constants';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { buildBridge, sampleBridgeSupports, type BridgeSupport } from './BridgeGeometry';
import type { TerrainSystem } from './TerrainSystem';
import { isMobileDevice } from './WorldSettings';
import type { BridgeDef } from './BridgeTypes';

type Body = ReturnType<PhysicsWorld['createStaticTrimesh']>['body'];
type BridgeMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
type BridgeLod = 0 | 1 | 2; // 2 is beyond draw distance.

const MOBILE = isMobileDevice();
const DETAIL_RANGE = MOBILE ? 30 : 40;
const DRAW_RANGE = MOBILE ? 135 : 180;
const HYSTERESIS = 4;

interface PlacedBridge {
  def: BridgeDef;
  mesh: BridgeMesh;
  body: Body;
  geometry: [THREE.BufferGeometry, THREE.BufferGeometry];
  supports: readonly BridgeSupport[];
  inverseSpanSquared: number;
  editorVisible: boolean;
  lod: BridgeLod;
}

export class BridgeSystem {
  private readonly group = new THREE.Group();
  private readonly bridges = new Map<string, PlacedBridge>();
  private terrainRevision: number;
  private nextSupportRefresh = 0;
  public revision = 0;
  private readonly material = new THREE.MeshLambertMaterial({
    map: DEFAULT_FLOOR_MATERIAL.map,
    vertexColors: true,
  });

  constructor(scene: THREE.Scene, private readonly physics: PhysicsWorld,
    private readonly terrain: Pick<TerrainSystem, 'getHeight' | 'revision'>) {
    this.terrainRevision = terrain.revision;
    this.group.name = 'WoodenBridges';
    scene.add(this.group);
  }

  public get(id: string): BridgeDef | undefined {
    return this.bridges.get(id)?.def;
  }

  public serialize(): BridgeDef[] {
    return Array.from(this.bridges.values(), ({ def }) => def);
  }

  public forEachBridge(visit: (def: BridgeDef) => void): void {
    for (const { def } of this.bridges.values()) visit(def);
  }

  public deserialize(defs: BridgeDef[] = []): void {
    const incoming = new Set(defs.map(({ id }) => id));
    for (const id of this.bridges.keys()) if (!incoming.has(id)) this.set(id);
    for (const def of defs) this.set(def.id, def);
  }

  public set(id: string, def?: BridgeDef): void {
    const previous = this.bridges.get(id);
    if (def === previous?.def) return;
    if (def) {
      this.replace(id, def, this.sampleSupports(def));
    } else if (previous) {
      this.bridges.delete(id);
      this.releasePlaced(previous);
    }
    this.revision++;
  }

  private sampleSupports(def: BridgeDef): BridgeSupport[] {
    return sampleBridgeSupports(def, (x, z) => this.terrain.getHeight(x, z));
  }

  private replace(id: string, def: BridgeDef, supports: readonly BridgeSupport[]): void {
    const previous = this.bridges.get(id);
    const built = buildBridge(def, true, 0, supports);
    const coarse = buildBridge(def, false, 1, supports).geometry;
    const positions = built.collisionVertices;
    const sin = Math.sin(built.yaw);
    const cos = Math.cos(built.yaw);
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const z = positions[i + 2];
      positions[i] = x * cos + z * sin;
      positions[i + 2] = z * cos - x * sin;
    }
    let collision: ReturnType<PhysicsWorld['createStaticTrimesh']>;
    try {
      collision = this.physics.createStaticTrimesh(
        built.origin, new Float32Array(positions), new Uint32Array(built.collisionIndices),
        COLLISION_GROUPS.ENVIRONMENT, this.physics.rapier.TriMeshFlags.FIX_INTERNAL_EDGES,
      );
    } catch (error) {
      built.geometry.dispose();
      coarse.dispose();
      throw error;
    }
    (collision.collider as typeof collision.collider & { userData?: { surface: 'wood' } }).userData = { surface: 'wood' };

    const mesh = this.createMesh(built);
    mesh.name = def.id;
    const lod = previous?.lod ?? 0;
    const editorVisible = previous?.editorVisible ?? true;
    mesh.visible = editorVisible && lod !== 2;
    if (lod === 1) mesh.geometry = coarse;
    this.group.add(mesh);
    this.bridges.set(id, {
      def, mesh, body: collision.body,
      geometry: [built.geometry, coarse],
      supports,
      inverseSpanSquared: 1 / ((def.b.x - def.a.x) ** 2 + (def.b.z - def.a.z) ** 2),
      editorVisible, lod,
    });
    if (previous) this.releasePlaced(previous);
  }

  private releasePlaced(bridge: PlacedBridge): void {
    bridge.mesh.removeFromParent();
    for (const geometry of bridge.geometry) geometry.dispose();
    this.physics.removeRigidBody(bridge.body);
  }

  private refreshSupports(): void {
    if (this.terrainRevision === this.terrain.revision) return;
    const now = performance.now();
    if (now < this.nextSupportRefresh) return;
    this.nextSupportRefresh = now + 250;
    this.terrainRevision = this.terrain.revision;
    for (const [id, { def, supports }] of this.bridges) {
      if (!supports.length) continue;
      const updated = this.sampleSupports(def);
      if (updated.some(({ bottoms }, i) => bottoms.some((y, side) => Math.abs(y - supports[i].bottoms[side]) > 0.01))) {
        this.replace(id, def, updated);
      }
    }
  }

  public updateLod(camera: THREE.Vector3): void {
    this.refreshSupports();
    for (const bridge of this.bridges.values()) {
      if (!bridge.editorVisible) continue;
      const { a, b } = bridge.def;
      const dx = b.x - a.x, dz = b.z - a.z;
      const x = camera.x - a.x, z = camera.z - a.z;
      // Measure to the span so a long bridge stays detailed at either landing.
      const t = Math.max(0, Math.min(1, (x * dx + z * dz) * bridge.inverseSpanSquared));
      const distanceSquared = (x - t * dx) ** 2 + (z - t * dz) ** 2;
      const drawRange = DRAW_RANGE - (bridge.lod === 2 ? HYSTERESIS : 0);
      const detailRange = DETAIL_RANGE - (bridge.lod === 0 ? 0 : HYSTERESIS);
      const lod = distanceSquared > drawRange ** 2 ? 2 : distanceSquared > detailRange ** 2 ? 1 : 0;
      if (lod === bridge.lod) continue;
      bridge.lod = lod;
      bridge.mesh.visible = lod !== 2;
      if (lod !== 2) bridge.mesh.geometry = bridge.geometry[lod];
    }
  }

  public setVisible(id: string, visible: boolean): void {
    const bridge = this.bridges.get(id);
    if (!bridge) return;
    bridge.editorVisible = visible;
    bridge.mesh.visible = visible && bridge.lod !== 2;
  }

  public preview(def: BridgeDef): BridgeMesh {
    return this.createMesh(buildBridge(def, false, 0, this.sampleSupports(def)));
  }

  private createMesh(built: ReturnType<typeof buildBridge>): BridgeMesh {
    const mesh = new THREE.Mesh(built.geometry, this.material);
    mesh.position.copy(built.origin);
    mesh.rotation.y = built.yaw;
    mesh.receiveShadow = true;
    return mesh;
  }

  public releaseMesh(mesh: BridgeMesh): void {
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }

  public dispose(): void {
    this.deserialize();
    this.group.removeFromParent();
    this.material.dispose();
  }
}
