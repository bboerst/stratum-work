export interface Seg { key: string; x0: number; x1: number }

/** Stack weighted items left-to-right, normalised to 0..100. */
export function stack(items: { key: string; w: number }[]): Seg[] {
  const total = items.reduce((a, i) => a + i.w, 0) || 1;
  let x = 0;
  return items.map(i => { const x0 = x; x += (i.w / total) * 100; return { key: i.key, x0, x1: x }; });
}
