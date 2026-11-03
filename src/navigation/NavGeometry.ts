import * as THREE from 'three';
import { NavPolygon } from './NavTypes';

/**
 * High-performance 3D/2D geometry utilities for custom NavMesh calculations.
 * Avoids heap allocations in hot loops where possible.
 */
export class NavGeometry {
  private static readonly EPSILON = 1e-5;

  /**
   * Signed 2D turn of vector b relative to vector a in top-down XZ view (looking down from +Y).
   * Y component of cross product: (az * bx - ax * bz).
   * Positive if turning from a to b is Counter-Clockwise (Left turn).
   * Negative if turning from a to b is Clockwise (Right turn).
   * Zero if collinear.
   */
  public static turn(ax: number, az: number, bx: number, bz: number): number {
    return az * bx - ax * bz;
  }

  /**
   * 2D Cross Product (in XZ plane)
   * Positive if b is to the left of a (CCW), negative if to the right (CW)
   */
  public static cross2D(ax: number, az: number, bx: number, bz: number): number {
    return ax * bz - az * bx;
  }

  /**
   * Determines if vector (vx, vz) is to the left of / CCW from (ux, uz)
   */
  public static isLeftOrCollinear2D(ux: number, uz: number, vx: number, vz: number): boolean {
    return (ux * vz - uz * vx) >= -NavGeometry.EPSILON;
  }

  public static isRightOrCollinear2D(ux: number, uz: number, vx: number, vz: number): boolean {
    return (ux * vz - uz * vx) <= NavGeometry.EPSILON;
  }

  /**
   * Tests if point (px, pz) is inside a convex 2D polygon defined by vertices in CCW or CW order.
   */
  public static pointInConvexPolygon2D(px: number, pz: number, vertices: THREE.Vector3[]): boolean {
    const len = vertices.length;
    if (len < 3) return false;

    let hasPositive = false;
    let hasNegative = false;

    for (let i = 0; i < len; i++) {
      const p1 = vertices[i];
      const p2 = vertices[(i + 1) % len];

      const cross = (px - p1.x) * (p2.z - p1.z) - (pz - p1.z) * (p2.x - p1.x);

      if (cross > NavGeometry.EPSILON) {
        hasPositive = true;
      } else if (cross < -NavGeometry.EPSILON) {
        hasNegative = true;
      }

      if (hasPositive && hasNegative) {
        return false;
      }
    }

    return true;
  }

  /**
   * Projects point p onto a 3D plane defined by normal and planeD (normal.dot(P) + planeD = 0)
   */
  public static projectPointToPlane(
    p: THREE.Vector3,
    normal: THREE.Vector3,
    planeD: number,
    out: THREE.Vector3
  ): THREE.Vector3 {
    const dist = p.dot(normal) + planeD;
    out.copy(p).addScaledVector(normal, -dist);
    return out;
  }

  /**
   * Calculates the closest point on 3D segment [a, b] to query point p.
   */
  public static closestPointOnSegment3D(
    p: THREE.Vector3,
    a: THREE.Vector3,
    b: THREE.Vector3,
    out: THREE.Vector3
  ): THREE.Vector3 {
    const abX = b.x - a.x;
    const abY = b.y - a.y;
    const abZ = b.z - a.z;

    const abLenSq = abX * abX + abY * abY + abZ * abZ;
    if (abLenSq < NavGeometry.EPSILON) {
      out.copy(a);
      return out;
    }

    const apX = p.x - a.x;
    const apY = p.y - a.y;
    const apZ = p.z - a.z;

    let t = (apX * abX + apY * abY + apZ * abZ) / abLenSq;
    t = Math.max(0, Math.min(1, t));

    out.set(a.x + abX * t, a.y + abY * t, a.z + abZ * t);
    return out;
  }

  /**
   * Finds the closest point within or on the boundary of a convex NavPolygon.
   */
  public static closestPointOnPolygon3D(
    p: THREE.Vector3,
    poly: NavPolygon,
    out: THREE.Vector3
  ): THREE.Vector3 {
    // 1. Project p onto polygon plane
    this.projectPointToPlane(p, poly.normal, poly.planeD, out);

    // 2. If projected point is inside 2D footprint, projection is the closest point
    if (this.pointInConvexPolygon2D(out.x, out.z, poly.vertices)) {
      return out;
    }

    // 3. Otherwise, clamp to the closest boundary edge
    let minDistanceSq = Infinity;
    const tempPt = new THREE.Vector3();
    const len = poly.vertices.length;

    for (let i = 0; i < len; i++) {
      const v0 = poly.vertices[i];
      const v1 = poly.vertices[(i + 1) % len];
      this.closestPointOnSegment3D(p, v0, v1, tempPt);
      const dSq = p.distanceToSquared(tempPt);
      if (dSq < minDistanceSq) {
        minDistanceSq = dSq;
        out.copy(tempPt);
      }
    }

    return out;
  }

  /**
   * Tests if two directed 3D segments [a1, a2] and [b1, b2] share a collinear overlapping interval.
   * Shared edges of adjacent polygons have opposite traversal directions.
   * Returns the overlap interval endpoints in the direction of [a1, a2], or null if no valid overlap.
   */
  public static findSegmentOverlap3D(
    a1: THREE.Vector3,
    a2: THREE.Vector3,
    b1: THREE.Vector3,
    b2: THREE.Vector3,
    maxDistance: number = 0.12,
    minOverlap: number = 0.15
  ): { p1: THREE.Vector3; p2: THREE.Vector3 } | null {
    const dirA = new THREE.Vector3().subVectors(a2, a1);
    const lenA = dirA.length();
    if (lenA < NavGeometry.EPSILON) return null;
    dirA.divideScalar(lenA);

    const dirB = new THREE.Vector3().subVectors(b2, b1);
    const lenB = dirB.length();
    if (lenB < NavGeometry.EPSILON) return null;
    dirB.divideScalar(lenB);

    // Edges must be nearly anti-parallel (dot product near -1) or parallel
    const dot = dirA.dot(dirB);
    if (Math.abs(dot) < 0.85) return null;

    // Check distance of b1 and b2 to segment A
    const closestB1 = new THREE.Vector3();
    const closestB2 = new THREE.Vector3();
    this.closestPointOnSegment3D(b1, a1, a2, closestB1);
    this.closestPointOnSegment3D(b2, a1, a2, closestB2);

    if (b1.distanceTo(closestB1) > maxDistance || b2.distanceTo(closestB2) > maxDistance) {
      return null;
    }

    // Project b1 and b2 onto line A in terms of scalar parameter t in [0, lenA]
    const tB1 = new THREE.Vector3().subVectors(b1, a1).dot(dirA);
    const tB2 = new THREE.Vector3().subVectors(b2, a1).dot(dirA);

    const minTB = Math.min(tB1, tB2);
    const maxTB = Math.max(tB1, tB2);

    const startT = Math.max(0, minTB);
    const endT = Math.min(lenA, maxTB);

    const overlapLength = endT - startT;
    if (overlapLength < minOverlap) return null;

    // Order points along a1 -> a2 direction
    // If dot < 0, b1 was near end and b2 was near start
    const p1 = new THREE.Vector3().copy(a1).addScaledVector(dirA, startT);
    const p2 = new THREE.Vector3().copy(a1).addScaledVector(dirA, endT);

    return { p1, p2 };
  }
}
