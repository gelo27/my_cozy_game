import * as THREE from 'three';
import { TerrainSystem } from '../world/TerrainSystem';
import { worldSettings } from '../world/WorldSettings';
import { waterLevelAt } from '../world/rivers/RiverWorld';
import { coastRadius } from '../world/IslandGenerator';

/** Which fish bite depends on the water: the farm pond, the far inland lakes, or the open sea. */
export type FishingWater = 'pond' | 'lake' | 'sea';

export type FishingPhase = 'idle' | 'cast' | 'wait' | 'bite' | 'reel' | 'caught' | 'escaped';

export interface FishingState {
  phase: FishingPhase;
  /** Reel minigame: marker 0..1, target zone [zoneStart, zoneStart + zoneWidth]. */
  marker: number;
  zoneStart: number;
  zoneWidth: number;
  hitsNeeded: number;
  hits: number;
  lastFishId: string | null;
  water: FishingWater;
}

interface FishDef {
  id: string;
  waters: FishingWater[];
  weight: (hour: number, rain: number) => number;
  difficulty: number; // 0..1, narrows the zone and speeds the marker
}

const FISH: FishDef[] = [
  { id: 'fish_carp', waters: ['pond'], weight: () => 50, difficulty: 0.15 },
  { id: 'fish_perch', waters: ['pond', 'lake'], weight: (h) => (h > 6 && h < 19 ? 32 : 6), difficulty: 0.35 },
  { id: 'fish_catfish', waters: ['pond'], weight: (h) => (h > 18 || h < 6 ? 30 : 4), difficulty: 0.6 },
  { id: 'fish_golden', waters: ['pond'], weight: (_h, rain) => 2 + rain * 8, difficulty: 0.85 },
  // Far lakes
  { id: 'fish_trout', waters: ['lake'], weight: () => 40, difficulty: 0.3 },
  { id: 'fish_pike', waters: ['lake'], weight: (h) => ((h > 5 && h < 9) || (h > 17 && h < 21) ? 30 : 10), difficulty: 0.6 },
  { id: 'fish_sturgeon', waters: ['lake'], weight: (_h, rain) => 3 + rain * 6, difficulty: 0.9 },
  // Open sea
  { id: 'fish_mackerel', waters: ['sea'], weight: () => 45, difficulty: 0.25 },
  { id: 'fish_seabass', waters: ['sea'], weight: () => 25, difficulty: 0.5 },
  { id: 'fish_tuna', waters: ['sea'], weight: (_h, rain) => 5 + rain * 3, difficulty: 0.85 },
  { id: 'fish_moonfish', waters: ['sea'], weight: (h) => (h > 21 || h < 4 ? 3 : 0), difficulty: 0.95 },
];

/** Classifies a cast target: the sea past the coastline, lakes beyond the old farm, else the pond. */
export function waterAt(x: number, z: number): FishingWater {
  const r = Math.hypot(x, z);
  if (r > coastRadius(x, z) - 32) return 'sea';
  return r > 72 ? 'lake' : 'pond';
}

/**
 * Cast -> wait for a bite -> press in time -> reel minigame (press while the marker is inside the
 * green zone). One button for the whole loop, so it plays the same on phones and PC.
 */
export class FishingSystem {
  public readonly state: FishingState = {
    phase: 'idle',
    marker: 0,
    zoneStart: 0.4,
    zoneWidth: 0.25,
    hitsNeeded: 2,
    hits: 0,
    lastFishId: null,
    water: 'pond',
  };
  public revision = 0;

  private readonly bobber: THREE.Mesh;
  private readonly line: THREE.Line;
  private readonly bobberPos = new THREE.Vector3();
  private readonly castFrom = new THREE.Vector3();
  private timer = 0;
  private time = 0;
  private fish: FishDef = FISH[0];
  private markerSpeed = 1;

  constructor(scene: THREE.Scene, private readonly terrain: TerrainSystem) {
    this.bobber = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshLambertMaterial({ color: 0xff3b30, emissive: 0x330000 })
    );
    this.bobber.visible = false;
    scene.add(this.bobber);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xf8fafc, transparent: true, opacity: 0.8 }));
    this.line.frustumCulled = false;
    this.line.visible = false;
    scene.add(this.line);
  }

  public get busy(): boolean {
    return this.state.phase !== 'idle';
  }

  /** Water point ~5 m in front of the player, or null when there is no water there. */
  public findCastTarget(playerPos: THREE.Vector3, facing: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 | null {
    for (const d of [5, 4, 6, 3, 7]) {
      out.set(playerPos.x + facing.x * d, 0, playerPos.z + facing.z * d);
      const level = waterLevelAt(out.x, out.z);
      if (this.terrain.getHeight(out.x, out.z) < level - 0.25) {
        out.y = level;
        return out;
      }
    }
    return null;
  }

  public cast(rodTip: THREE.Vector3, target: THREE.Vector3): void {
    this.castFrom.copy(rodTip);
    this.bobberPos.copy(target);
    this.state.water = waterAt(target.x, target.z);
    this.state.phase = 'cast';
    this.timer = 0.6;
    this.bobber.visible = true;
    this.line.visible = true;
    this.touch();
  }

  /** The single action button. Returns a caught fish id when the catch completes. */
  public press(): string | null {
    const s = this.state;
    if (s.phase === 'wait' || s.phase === 'cast') {
      this.reset(); // reeled in too early
    } else if (s.phase === 'bite') {
      this.startReel();
    } else if (s.phase === 'reel') {
      if (s.marker >= s.zoneStart && s.marker <= s.zoneStart + s.zoneWidth) {
        s.hits++;
        if (s.hits >= s.hitsNeeded) {
          s.phase = 'caught';
          s.lastFishId = this.fish.id;
          this.timer = 1.6;
          this.bobber.visible = false;
          this.line.visible = false;
          this.touch();
          return this.fish.id;
        }
        // Move the zone after each successful hit
        s.zoneStart = 0.05 + Math.random() * (0.9 - s.zoneWidth);
      } else {
        this.escape();
      }
    }
    this.touch();
    return null;
  }

  public cancel(): void {
    if (this.state.phase !== 'idle') this.reset();
  }

  public update(dt: number, rodTip: THREE.Vector3, rain: number): void {
    this.time += dt;
    const s = this.state;
    if (s.phase === 'idle') return;
    this.timer -= dt;

    if (s.phase === 'cast') {
      // Arc from the rod tip to the water
      const t = 1 - Math.max(0, this.timer) / 0.6;
      this.bobber.position.lerpVectors(this.castFrom, this.bobberPos, t);
      this.bobber.position.y += Math.sin(t * Math.PI) * 2;
      if (this.timer <= 0) {
        s.phase = 'wait';
        this.timer = 2 + Math.random() * 5 * (1 - rain * 0.4);
        this.touch();
      }
    } else if (s.phase === 'wait') {
      this.bobber.position.copy(this.bobberPos);
      this.bobber.position.y += Math.sin(this.time * 2) * 0.02;
      if (this.timer <= 0) {
        s.phase = 'bite';
        this.timer = 1.1;
        this.fish = this.rollFish(rain);
        this.touch();
      }
    } else if (s.phase === 'bite') {
      this.bobber.position.copy(this.bobberPos);
      this.bobber.position.y -= 0.08 + Math.abs(Math.sin(this.time * 20)) * 0.05;
      if (this.timer <= 0) this.escape();
    } else if (s.phase === 'reel') {
      s.marker = 0.5 + 0.5 * Math.sin(this.time * this.markerSpeed);
      this.bobber.position.copy(this.bobberPos);
      this.bobber.position.x += Math.sin(this.time * 7) * 0.15;
      if (this.timer <= 0) this.escape();
    } else if ((s.phase === 'caught' || s.phase === 'escaped') && this.timer <= 0) {
      this.reset();
    }

    if (this.line.visible) {
      const a = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      a.setXYZ(0, rodTip.x, rodTip.y, rodTip.z);
      a.setXYZ(1, this.bobber.position.x, this.bobber.position.y, this.bobber.position.z);
      a.needsUpdate = true;
    }
  }

  private startReel(): void {
    const s = this.state;
    const d = this.fish.difficulty;
    s.phase = 'reel';
    s.hits = 0;
    s.hitsNeeded = d > 0.7 ? 3 : 2;
    s.zoneWidth = THREE.MathUtils.lerp(0.32, 0.14, d);
    s.zoneStart = 0.05 + Math.random() * (0.9 - s.zoneWidth);
    this.markerSpeed = THREE.MathUtils.lerp(2.2, 4.2, d);
    this.timer = 9;
  }

  private escape(): void {
    this.state.phase = 'escaped';
    this.timer = 1.2;
    this.bobber.visible = false;
    this.line.visible = false;
    this.touch();
  }

  private reset(): void {
    this.state.phase = 'idle';
    this.bobber.visible = false;
    this.line.visible = false;
    this.touch();
  }

  private rollFish(rain: number): FishDef {
    const h = worldSettings.timeOfDay;
    const water = this.state.water;
    const weights = FISH.map((f) => (f.waters.includes(water) ? f.weight(h, rain) : 0));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < FISH.length; i++) {
      r -= weights[i];
      if (r <= 0) return FISH[i];
    }
    return FISH.find((f) => f.waters.includes(water)) ?? FISH[0];
  }

  private touch(): void {
    this.revision++;
  }
}
