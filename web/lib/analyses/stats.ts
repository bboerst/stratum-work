export function wilson(k: number, n: number, z = 1.959964) {
  if (n <= 0) return { p: 0, lo: 0, hi: 0 };
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}
export function bits(k: number, n: number): number {
  if (n <= 0 || k <= 0) return 0;
  return Math.max(0, -Math.log2(k / n));
}
export function effectiveNumber(shares: number[]): number {
  const s = shares.reduce((a, x) => a + x * x, 0);
  return s > 0 ? 1 / s : 0;
}
export function fewestControllingMajority(shares: number[]): number {
  const sorted = [...shares].sort((a, b) => b - a);
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) { acc += sorted[i]; if (acc > 0.5) return i + 1; }
  return sorted.length;
}
