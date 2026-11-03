import * as THREE from 'three';
import { NavPolygon, NavPortal } from './NavTypes';
import { NavGeometry } from './NavGeometry';

interface PortalEdge {
  left: THREE.Vector3;
  right: THREE.Vector3;
}

export class FunnelPathSmoother {
  /**
   * Generates a smooth, shortest continuous 3D path through a polygon corridor
   * using the Simple, Sturdy Funnel Algorithm (SSFA / String Pulling),
   * with full 3D slope, stair, and multi-tier elevation awareness.
   */
  public static smoothCorridor(
    corridor: NavPolygon[],
    startPos: THREE.Vector3,
    endPos: THREE.Vector3,
    agentRadius: number = 0.35,
    isDirectLineWalkable?: (p1: THREE.Vector3, p2: THREE.Vector3, radius: number) => boolean
  ): THREE.Vector3[] {
    if (corridor.length === 0) {
      return [startPos.clone(), endPos.clone()];
    }

    if (corridor.length === 1) {
      return [startPos.clone(), endPos.clone()];
    }

    // Check if the corridor contains any slope transitions or ramps
    const hasSlopes = this.corridorHasSlopes(corridor);

    let rawPath: THREE.Vector3[];
    if (!hasSlopes) {
      // Entire corridor is on the same flat horizontal plane: run direct 2D String Pulling
      rawPath = this.smoothCoplanarCorridor(corridor, startPos, endPos, agentRadius);
    } else {
      // Corridor traverses ramps/stairs or multi-tier elevations:
      // Deconstruct corridor into planar runs and ramp transitions
      rawPath = this.smooth3DCorridorWithSlopes(corridor, startPos, endPos, agentRadius);
    }

    // Optional Analytical Line-of-Sight Shortcut pass (strictly constrained to same elevation)
    if (isDirectLineWalkable && rawPath.length > 2) {
      return this.raycastShortcut(rawPath, isDirectLineWalkable, agentRadius);
    }

    return rawPath;
  }

  /**
   * Determines if the corridor involves ramps, stairs, or elevation boundaries
   */
  private static corridorHasSlopes(corridor: NavPolygon[]): boolean {
    for (let i = 0; i < corridor.length; i++) {
      if (corridor[i].normal.y < 0.98) return true;
      if (i < corridor.length - 1) {
        if (Math.abs(corridor[i].centroid.y - corridor[i + 1].centroid.y) > 0.15) {
          return true;
        }
        if (corridor[i].normal.dot(corridor[i + 1].normal) < 0.98) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * String Pulling for coplanar horizontal polygon chains
   */
  private static smoothCoplanarCorridor(
    corridor: NavPolygon[],
    startPos: THREE.Vector3,
    endPos: THREE.Vector3,
    agentRadius: number
  ): THREE.Vector3[] {
    const portals = this.extractPortals(corridor, agentRadius);
    portals.push({ left: endPos.clone(), right: endPos.clone() });
    return this.stringPull(portals, startPos, endPos);
  }

  /**
   * 3D corridor smoothing with guaranteed ramp and stair surface conformation
   */
  private static smooth3DCorridorWithSlopes(
    corridor: NavPolygon[],
    startPos: THREE.Vector3,
    endPos: THREE.Vector3,
    agentRadius: number
  ): THREE.Vector3[] {
    const waypoints: THREE.Vector3[] = [startPos.clone()];
    let currentPos = startPos.clone();

    // Group corridor into segments separated by slope/incline transitions
    let segStart = 0;

    for (let i = 0; i < corridor.length - 1; i++) {
      const fromPoly = corridor[i];
      const toPoly = corridor[i + 1];

      const isTransition =
        fromPoly.normal.y < 0.98 ||
        toPoly.normal.y < 0.98 ||
        Math.abs(fromPoly.centroid.y - toPoly.centroid.y) > 0.15 ||
        fromPoly.normal.dot(toPoly.normal) < 0.98;

      if (isTransition) {
        // 1. Process any preceding coplanar section before this transition
        if (i > segStart) {
          const subCorridor = corridor.slice(segStart, i + 1);
          const portalToNext = this.getPortalBetween(fromPoly, toPoly);
          const targetPos = portalToNext ? portalToNext.midpoint : toPoly.centroid;
          const subPortals = this.extractPortals(subCorridor, agentRadius);
          subPortals.push({ left: targetPos.clone(), right: targetPos.clone() });
          const subPath = this.stringPull(subPortals, currentPos, targetPos);

          for (let p = 1; p < subPath.length - 1; p++) {
            waypoints.push(subPath[p]);
          }
          currentPos.copy(subPath[subPath.length - 1]);
        }

        // 2. Compute the exact 3D crossing point on this slope boundary portal
        const portal = this.getPortalBetween(fromPoly, toPoly);
        if (portal) {
          const nextTarget = i + 2 < corridor.length ? corridor[i + 2].centroid : endPos;
          const crossing = this.computePortalCrossing(portal.left, portal.right, currentPos, nextTarget, agentRadius);

          // Avoid duplicating near-identical waypoints
          if (crossing.distanceTo(waypoints[waypoints.length - 1]) > 0.25) {
            waypoints.push(crossing);
            currentPos.copy(crossing);
          }
        }

        // 3. If toPoly is an inclined ramp polygon, insert intermediate ramp point for smooth ascent
        if (toPoly.normal.y < 0.98) {
          const exitPortal = i + 2 < corridor.length ? this.getPortalBetween(toPoly, corridor[i + 2]) : null;
          const exitTarget = exitPortal ? exitPortal.midpoint : toPoly.centroid;

          if (currentPos.distanceTo(exitTarget) > 2.8) {
            const rampMid = new THREE.Vector3().copy(currentPos).add(exitTarget).multiplyScalar(0.5);
            // Project onto ramp plane to ensure exact surface altitude
            NavGeometry.projectPointToPlane(rampMid, toPoly.normal, toPoly.planeD, rampMid);
            waypoints.push(rampMid);
            currentPos.copy(rampMid);
          }
        }

        segStart = i + 1;
      }
    }

    // 4. Process final remaining coplanar section up to endPos
    if (segStart < corridor.length) {
      const finalSubCorridor = corridor.slice(segStart);
      if (finalSubCorridor.length > 1) {
        const subPortals = this.extractPortals(finalSubCorridor, agentRadius);
        subPortals.push({ left: endPos.clone(), right: endPos.clone() });
        const subPath = this.stringPull(subPortals, currentPos, endPos);
        for (let p = 1; p < subPath.length; p++) {
          if (subPath[p].distanceTo(waypoints[waypoints.length - 1]) > 0.2) {
            waypoints.push(subPath[p]);
          }
        }
      } else {
        if (endPos.distanceTo(waypoints[waypoints.length - 1]) > 0.2) {
          waypoints.push(endPos.clone());
        }
      }
    } else {
      if (endPos.distanceTo(waypoints[waypoints.length - 1]) > 0.2) {
        waypoints.push(endPos.clone());
      }
    }

    return waypoints;
  }

  /**
   * Extracts portal edges contracted by agent clearance radius
   */
  private static extractPortals(corridor: NavPolygon[], agentRadius: number): PortalEdge[] {
    const portals: PortalEdge[] = [];

    for (let i = 0; i < corridor.length - 1; i++) {
      const fromPoly = corridor[i];
      const toPoly = corridor[i + 1];

      let portal = this.getPortalBetween(fromPoly, toPoly);
      if (!portal) {
        const mid = new THREE.Vector3().copy(fromPoly.centroid).add(toPoly.centroid).multiplyScalar(0.5);
        portals.push({ left: mid.clone(), right: mid.clone() });
        continue;
      }

      const left = portal.left.clone();
      const right = portal.right.clone();
      const edgeVec = new THREE.Vector3().subVectors(right, left);
      const width = edgeVec.length();

      if (width > agentRadius * 2.2) {
        edgeVec.normalize();
        left.addScaledVector(edgeVec, agentRadius);
        right.addScaledVector(edgeVec, -agentRadius);
      } else {
        const mid = new THREE.Vector3().copy(left).add(right).multiplyScalar(0.5);
        left.copy(mid);
        right.copy(mid);
      }

      portals.push({ left, right });
    }

    return portals;
  }

  private static getPortalBetween(fromPoly: NavPolygon, toPoly: NavPolygon): NavPortal | undefined {
    return fromPoly.portals.find(p => p.toPolyId === toPoly.id);
  }

  /**
   * Computes optimal 3D crossing point along a portal segment
   */
  private static computePortalCrossing(
    left: THREE.Vector3,
    right: THREE.Vector3,
    fromPos: THREE.Vector3,
    toPos: THREE.Vector3,
    agentRadius: number
  ): THREE.Vector3 {
    const edgeDir = new THREE.Vector3().subVectors(right, left);
    const edgeLen = edgeDir.length();
    const l = left.clone();
    const r = right.clone();

    if (edgeLen > agentRadius * 2.2) {
      edgeDir.normalize();
      l.addScaledVector(edgeDir, agentRadius);
      r.addScaledVector(edgeDir, -agentRadius);
    } else {
      return new THREE.Vector3().copy(left).add(right).multiplyScalar(0.5);
    }

    // Intersect 2D line [fromPos, toPos] with [l, r] in XZ
    const d1x = toPos.x - fromPos.x;
    const d1z = toPos.z - fromPos.z;
    const d2x = r.x - l.x;
    const d2z = r.z - l.z;

    const cross = d1x * d2z - d1z * d2x;
    if (Math.abs(cross) > 1e-5) {
      const dx = l.x - fromPos.x;
      const dz = l.z - fromPos.z;
      const t = (dx * d1z - dz * d1x) / cross;
      const clampedT = Math.max(0, Math.min(1, t));
      return new THREE.Vector3().copy(l).addScaledVector(new THREE.Vector3().subVectors(r, l), clampedT);
    }

    // Default to midpoint if collinear or parallel
    return new THREE.Vector3().copy(l).add(r).multiplyScalar(0.5);
  }

  /**
   * Standard Simple, Sturdy Funnel Algorithm (SSFA) on portal list
   */
  private static stringPull(portals: PortalEdge[], startPos: THREE.Vector3, endPos: THREE.Vector3): THREE.Vector3[] {
    if (portals.length === 0) return [startPos.clone(), endPos.clone()];

    const path: THREE.Vector3[] = [startPos.clone()];

    let apex = startPos.clone();
    let left = portals[0].left.clone();
    let right = portals[0].right.clone();
    let leftIndex = 0;
    let rightIndex = 0;

    let i = 1;
    while (i < portals.length) {
      const nextLeft = portals[i].left;
      const nextRight = portals[i].right;

      // 1. Process Right vertex
      const rx = right.x - apex.x;
      const rz = right.z - apex.z;
      const nrx = nextRight.x - apex.x;
      const nrz = nextRight.z - apex.z;

      // Does nextRight tighten the funnel? (turns left / CCW from current right)
      if (NavGeometry.turn(rx, rz, nrx, nrz) >= 0) {
        // Does nextRight cross over left? (turns left / CCW from current left)
        const lx = left.x - apex.x;
        const lz = left.z - apex.z;
        if (NavGeometry.turn(lx, lz, nrx, nrz) > 0) {
          // Pivot on left!
          apex.copy(left);
          path.push(apex.clone());

          const apexIndex = leftIndex;
          leftIndex = apexIndex + 1;
          rightIndex = apexIndex + 1;

          if (leftIndex < portals.length) {
            left.copy(portals[leftIndex].left);
            right.copy(portals[rightIndex].right);
            i = leftIndex + 1;
            continue;
          } else {
            break;
          }
        } else {
          right.copy(nextRight);
          rightIndex = i;
        }
      }

      // 2. Process Left vertex
      const lx2 = left.x - apex.x;
      const lz2 = left.z - apex.z;
      const nlx = nextLeft.x - apex.x;
      const nlz = nextLeft.z - apex.z;

      // Does nextLeft tighten the funnel? (turns right / CW from current left)
      if (NavGeometry.turn(lx2, lz2, nlx, nlz) <= 0) {
        // Does nextLeft cross over right? (turns right / CW from current right)
        const rx2 = right.x - apex.x;
        const rz2 = right.z - apex.z;
        if (NavGeometry.turn(rx2, rz2, nlx, nlz) < 0) {
          // Pivot on right!
          apex.copy(right);
          path.push(apex.clone());

          const apexIndex = rightIndex;
          leftIndex = apexIndex + 1;
          rightIndex = apexIndex + 1;

          if (rightIndex < portals.length) {
            left.copy(portals[leftIndex].left);
            right.copy(portals[rightIndex].right);
            i = rightIndex + 1;
            continue;
          } else {
            break;
          }
        } else {
          left.copy(nextLeft);
          leftIndex = i;
        }
      }

      i++;
    }

    path.push(endPos.clone());
    return path;
  }

  /**
   * Raycast Shortcut Pruning: skips redundant intermediate waypoints
   * STRICTLY on the same elevation level to avoid cutting across stairs/ramps.
   */
  private static raycastShortcut(
    path: THREE.Vector3[],
    isDirectLineWalkable: (p1: THREE.Vector3, p2: THREE.Vector3, radius: number) => boolean,
    agentRadius: number
  ): THREE.Vector3[] {
    if (path.length <= 2) return path;

    const pruned: THREE.Vector3[] = [path[0]];
    let currentIdx = 0;

    while (currentIdx < path.length - 1) {
      let furthestIdx = currentIdx + 1;

      for (let testIdx = path.length - 1; testIdx > currentIdx + 1; testIdx--) {
        // Never shortcut across different elevation tiers or ramps
        if (Math.abs(path[currentIdx].y - path[testIdx].y) > 0.15) {
          continue;
        }

        if (isDirectLineWalkable(path[currentIdx], path[testIdx], agentRadius)) {
          furthestIdx = testIdx;
          break;
        }
      }

      pruned.push(path[furthestIdx]);
      currentIdx = furthestIdx;
    }

    return pruned;
  }
}
