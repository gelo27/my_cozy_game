import * as THREE from 'three';
import { NavPolygon, NavPortal } from './NavTypes';
import { CustomNavMesh } from './CustomNavMesh';

class MinHeap<T> {
  private heap: { item: T; priority: number }[] = [];

  public push(item: T, priority: number): void {
    this.heap.push({ item, priority });
    this.bubbleUp(this.heap.length - 1);
  }

  public pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0].item;
    const bottom = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this.sinkDown(0);
    }
    return top;
  }

  public isEmpty(): boolean {
    return this.heap.length === 0;
  }

  private bubbleUp(index: number): void {
    const element = this.heap[index];
    while (index > 0) {
      const parentIdx = (index - 1) >> 1;
      const parent = this.heap[parentIdx];
      if (element.priority >= parent.priority) break;
      this.heap[index] = parent;
      index = parentIdx;
    }
    this.heap[index] = element;
  }

  private sinkDown(index: number): void {
    const length = this.heap.length;
    const element = this.heap[index];

    while (true) {
      const leftChildIdx = (index << 1) + 1;
      const rightChildIdx = leftChildIdx + 1;
      let swapIdx = -1;
      let minPriority = element.priority;

      if (leftChildIdx < length) {
        if (this.heap[leftChildIdx].priority < minPriority) {
          minPriority = this.heap[leftChildIdx].priority;
          swapIdx = leftChildIdx;
        }
      }

      if (rightChildIdx < length) {
        if (this.heap[rightChildIdx].priority < minPriority) {
          swapIdx = rightChildIdx;
        }
      }

      if (swapIdx === -1) break;
      this.heap[index] = this.heap[swapIdx];
      index = swapIdx;
    }

    this.heap[index] = element;
  }
}

export class AStarPathfinder {
  /**
   * Finds the optimal polygon corridor connecting startPoly to endPoly using A*.
   */
  public static findCorridor(
    navMesh: CustomNavMesh,
    startPoly: NavPolygon,
    endPoly: NavPolygon,
    startPos: THREE.Vector3,
    endPos: THREE.Vector3
  ): NavPolygon[] {
    if (startPoly.id === endPoly.id) {
      return [startPoly];
    }

    const openSet = new MinHeap<NavPolygon>();
    const gScore = new Map<number, number>();
    const cameFrom = new Map<number, NavPolygon>();
    const visited = new Set<number>();

    gScore.set(startPoly.id, 0);

    const initialH = startPos.distanceTo(endPos) + Math.abs(startPos.y - endPos.y) * 0.5;
    openSet.push(startPoly, initialH);

    let closestPolyToGoal = startPoly;
    let minHeuristic = initialH;

    while (!openSet.isEmpty()) {
      const current = openSet.pop()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);

      // Reached goal polygon!
      if (current.id === endPoly.id) {
        return this.reconstructPath(cameFrom, current);
      }

      const currentG = gScore.get(current.id)!;

      for (let i = 0; i < current.portals.length; i++) {
        const portal = current.portals[i];
        const neighborId = portal.toPolyId;

        if (visited.has(neighborId)) continue;

        const neighbor = navMesh.getPolygon(neighborId);
        if (!neighbor) continue;

        const tentativeG = currentG + portal.cost;
        const previousG = gScore.get(neighborId) ?? Infinity;

        if (tentativeG < previousG) {
          cameFrom.set(neighborId, current);
          gScore.set(neighborId, tentativeG);

          const h = portal.midpoint.distanceTo(endPos) + Math.abs(portal.midpoint.y - endPos.y) * 0.5;
          const f = tentativeG + h;

          if (h < minHeuristic) {
            minHeuristic = h;
            closestPolyToGoal = neighbor;
          }

          openSet.push(neighbor, f);
        }
      }
    }

    // Fallback: if destination not completely reachable, return corridor to the closest reachable polygon
    return this.reconstructPath(cameFrom, closestPolyToGoal);
  }

  private static reconstructPath(
    cameFrom: Map<number, NavPolygon>,
    endPoly: NavPolygon
  ): NavPolygon[] {
    const path: NavPolygon[] = [endPoly];
    let curr = endPoly;

    while (cameFrom.has(curr.id)) {
      curr = cameFrom.get(curr.id)!;
      path.unshift(curr);
    }

    return path;
  }
}
