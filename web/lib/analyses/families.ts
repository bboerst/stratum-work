import { pairKey, type PairEvidence } from './evidence/types';

export interface Family { id: string; label: string; members: string[]; weight: number }

/** Connected components of pools joined by pair evidence >= thresholdBits. */
export function templateFamilies(pairs: Map<string, PairEvidence>, pools: string[], weights: Map<string, number>, thresholdBits = 16): Family[] {
  const parent = new Map<string, string>();
  pools.forEach(p => parent.set(p, p));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (let i = 0; i < pools.length; i++) for (let j = i + 1; j < pools.length; j++) {
    const pe = pairs.get(pairKey(pools[i], pools[j]));
    if (pe && pe.total >= thresholdBits) parent.set(find(pools[i]), find(pools[j]));
  }
  const groups = new Map<string, string[]>();
  for (const p of pools) {
    const r = find(p);
    const g = groups.get(r) ?? [];
    g.push(p);
    groups.set(r, g);
  }
  const w = (p: string) => weights.get(p) ?? 0;
  return Array.from(groups.values()).map(ms => {
    const members = ms.slice().sort();
    const head = members.slice().sort((a, b) => w(b) - w(a) || a.localeCompare(b))[0];
    return {
      id: members.join(','),
      label: members.length > 1 ? `${head} +${members.length - 1}` : head,
      members,
      weight: members.reduce((a, m) => a + w(m), 0),
    };
  }).sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
}
