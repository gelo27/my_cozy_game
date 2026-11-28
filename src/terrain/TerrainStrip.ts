/** Squared distance to a swept centreline in the horizontal terrain plane. */
export function stripDistanceSq(x: number, z: number, ax: number, az: number, dx: number, dz: number, inverseLengthSq: number): number {
  const rx = x - ax, rz = z - az;
  const t = Math.max(0, Math.min(1, (rx * dx + rz * dz) * inverseLengthSq));
  return (rx - dx * t) ** 2 + (rz - dz * t) ** 2;
}
